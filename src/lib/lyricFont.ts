// 歌词字体：按**语言**分槽 —— 西文 / 中文 / 日文 / 韩文，一个语言一个字体。
//
// 三条硬规则（都由这一行的语言决定，与"哪个槽被设置过"无关）：
//
//   ① 有争议的码位只由**这一行的语言**决定。
//      汉字是中日共用的码位（U+4E00–9FFF…），所以中文槽**不把汉字借给别的语言的行**，
//      日文槽也只借假名。否则"日文歌里设了中文字体"会把日文的汉字全变成中文体。
//   ② 每个「字体 × 槽位」注册一份带 unicode-range 的**受限字面**（族名 Xxx__slot），
//      它只服务这个槽**独占**的码位 → 槽位之间的边界在渲染层是真实存在的。
//      本语言的行还会额外用同一字体的**不限范围**那份来补缺（一首歌一个声音）。
//   ③ 行上打 lang（zh-Hans / ja / ko / en）：中日汉字的字形差异（直 / 骨 / 今）码位相同，
//      unicode-range 与 font-family 都解决不了，只有 lang 能修。
//
// 另外两件与"覆盖"有关的事（见 src/lib/fontCoverage.ts）：
//   · 字体文件的覆盖范围常常小于语言码位范围（日文字体缺简体字）→ 逐字回退会混排；
//   · 于是提供「缺字时」策略：逐字替换（默认）/ 整行回退，并在设置页给出样字覆盖体检。
import { fontList, fontRead, fontSave } from "../api/ipc";
import { useSettingsStore } from "../stores/settingsStore";
import { covers, missingIn, parseCmap } from "./fontCoverage";
import type { Coverage } from "./fontCoverage";
// 内置字体文件：?url 拿到打包后的资源地址，FontFace 可直接当 src 用（不必 fetch）
import ephesisUrl from "../assets/fonts/Ephesis-Regular.ttf?url";
import mashanZhengUrl from "../assets/fonts/MaShanZheng-Regular.ttf?url";

export interface FontChoice {
  id: string;
  label: string;
  /** CSS font-family 片段（空串表示跟随应用字体） */
  family: string;
  desc: string;
}

export const SYSTEM_FONT = "system";
/** 字号倍率：1 = 设计稿原始大小 */
export const DEFAULT_SIZE = 1;
/** 字重：设计稿正文 420 */
export const DEFAULT_WEIGHT = 420;
export const SIZE_RANGE: [number, number] = [0.7, 1.8];

export const WEIGHT_OPTIONS: { value: number; label: string }[] = [
  { value: 300, label: "细" },
  { value: 400, label: "常规" },
  { value: 500, label: "中等" },
  { value: 700, label: "粗体" },
];

/** 内置字体的真实族名与资源地址（受限字面 / 不限范围字面都用它） */
const BUILTIN_FACE: Record<string, { cssName: string; url: string }> = {
  ephesis: { cssName: "LyricEphesis", url: ephesisUrl },
  mashanzheng: { cssName: "LyricMaShanZheng", url: mashanZhengUrl },
};

/** 内置字体（用户上传的字体与它们并列出现在**每一个**语言槽的候选里） */
export const BUILTIN_FONTS: FontChoice[] = [
  { id: SYSTEM_FONT, label: "系统默认", family: "", desc: "这个语言不用自定义字体，直接走系统字体" },
  { id: "ephesis", label: "Ephesis", family: '"LyricEphesis"', desc: "英文手写体（只有拉丁字形）" },
  { id: "mashanzheng", label: "马善政", family: '"LyricMaShanZheng"', desc: "中文书法体" },
];

/* ============================ 码位区间 ============================ */

type Range = readonly [number, number];

/** 拉丁 / 西里尔 / 希腊（西文槽独占，不与任何语言冲突） */
const LATIN: readonly Range[] = [
  [0x0000, 0x024f], [0x0370, 0x03ff], [0x0400, 0x052f], [0x1e00, 0x1eff],
  [0x1f00, 0x1fff], [0x2c60, 0x2c7f], [0x2de0, 0x2dff], [0xa640, 0xa69f],
  [0xa720, 0xa7ff], [0xab30, 0xab6f], [0xfb00, 0xfb06],
];
/** 假名（日文槽独占） */
const KANA: readonly Range[] = [
  [0x3040, 0x309f], [0x30a0, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9d],
];
/** 谚文（韩文槽独占） */
const HANGUL: readonly Range[] = [
  [0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xffa0, 0xffdc],
];
/** 汉字 + 中文标点 + 全角（**中日共用**，谁都不许"借"给别的语言的行） */
const HAN: readonly Range[] = [
  [0x2e80, 0x2eff], [0x3000, 0x303f], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xffef], [0x20000, 0x2fa1f],
];

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

function cssRanges(rs: readonly Range[]): string {
  return rs.map(([a, b]) => (a === b ? "U+" + hex4(a) : "U+" + hex4(a) + "-" + hex4(b))).join(",");
}

function inRanges(rs: readonly Range[], cp: number): boolean {
  for (const [a, b] of rs) if (cp >= a && cp <= b) return true;
  return false;
}

/* ============================ 语言槽 ============================ */

export type FontSlot = "latin" | "zh" | "ja" | "ko";

export interface SlotDef {
  id: FontSlot;
  /** 设置页里的语言名 */
  label: string;
  /** 该语言的字样；同时作为"覆盖体检"的样张（所以特意挑了区分度高的字） */
  sample: string;
  /** 行上的 lang 属性：中日汉字的字形变体靠它 */
  lang: string;
  /** 这个槽在自己的行里服务哪些码位 */
  ownRanges: readonly Range[];
  /** 这个槽**借给别的语言的行**的码位（独占脚本；汉字不外借） */
  crossRanges: readonly Range[];
  /** 一句话说明 */
  hint: string;
}

export const SLOTS: SlotDef[] = [
  {
    id: "latin",
    label: "西文",
    sample: "Hello — Привет",
    lang: "en",
    ownRanges: LATIN,
    crossRanges: LATIN,
    hint: "拉丁 / 西里尔 / 希腊字母，以及数字与标点",
  },
  {
    id: "zh",
    label: "中文",
    // 样张全是"简体专用字"（日文字体通常没有这些码位）→ 放错字体时当场看得出缺字
    sample: "说这们汉语听爱风",
    lang: "zh-Hans",
    ownRanges: HAN,
    crossRanges: [],
    hint: "汉字与中文标点（与日文共用码位，靠这一行的语言区分，不会外借给别的语言）",
  },
  {
    id: "ja",
    label: "日文",
    sample: "君の名は 円駅沢",
    lang: "ja",
    ownRanges: [...KANA, ...HAN],
    crossRanges: KANA,
    hint: "假名 + 汉字；假名可以借给别的语言的行，汉字不外借",
  },
  {
    id: "ko",
    label: "韩文",
    sample: "사랑해요 안녕",
    lang: "ko",
    ownRanges: HANGUL,
    crossRanges: HANGUL,
    hint: "谚文",
  },
];

export const SLOT_IDS: FontSlot[] = SLOTS.map((s) => s.id);
const SLOT_DEF = new Map(SLOTS.map((s) => [s.id, s] as const));

/** 设置键：lyricFontLatin / lyricFontZh / lyricFontJa / lyricFontKo */
export function slotKey(slot: FontSlot): string {
  return "lyricFont" + slot.charAt(0).toUpperCase() + slot.slice(1);
}

export function slotLang(slot: FontSlot): string {
  return SLOT_DEF.get(slot)?.lang ?? "en";
}

/** 系统兜底链：按语言显式排序 —— 用户槽位没覆盖到的文字落到该语言的本地正体，而非听凭隐式回退 */
const SYSTEM_CHAIN = [
  "Inter",
  '"Segoe UI"',
  '"Yu Gothic UI"',
  "Meiryo",
  '"Malgun Gothic"',
  '"Microsoft YaHei"',
  '"Noto Sans CJK JP"',
  '"Noto Sans CJK KR"',
  '"Noto Sans CJK SC"',
  "-apple-system",
  "BlinkMacSystemFont",
  "sans-serif",
];

/* ============================ 字体 id / 族名 ============================ */

/** 上传字体的 id 形式：file:<文件名> */
export function fileId(name: string): string {
  return "file:" + name;
}

export function fileOf(id: string | undefined): string | null {
  return id && id.startsWith("file:") ? id.slice(5) : null;
}

/** 由文件名派生稳定的 CSS 字族名（跨启动一致，只含安全字符） */
export function customFamily(name: string): string {
  let base = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]/g, "");
  if (!base) {
    let h = 7;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    base = "F" + h.toString(36);
  }
  return "LyricUser" + base;
}

/** 裸族名（不带引号）；"" = 跟随应用字体 */
function bareFamilyOf(id: string | undefined): string {
  if (!id || id === SYSTEM_FONT) return "";
  const builtin = BUILTIN_FACE[id];
  if (builtin) return builtin.cssName;
  const file = fileOf(id);
  return file ? customFamily(file) : "";
}

/** 不限范围的字族（补缺用，也是设置页样字的默认字体） */
export function familyOf(id: string | undefined): string {
  const bare = bareFamilyOf(id);
  return bare ? '"' + bare + '"' : "";
}

/** 某个槽独占范围的受限族名（本语言的行用它） */
function ownFamilyBare(id: string, slot: FontSlot): string {
  const bare = bareFamilyOf(id);
  return bare ? bare + "__" + slot : "";
}

/** 借给别的语言的行的受限族名（只有独占脚本，且与 own 不同时才需要单独一份） */
function crossFamilyBare(id: string, slot: FontSlot): string {
  const bare = bareFamilyOf(id);
  if (!bare) return "";
  const def = SLOT_DEF.get(slot);
  if (!def || def.crossRanges.length === 0) return "";
  if (cssRanges(def.crossRanges) === cssRanges(def.ownRanges)) return ownFamilyBare(id, slot);
  return bare + "__" + slot + "_x";
}

/* ============================ 缺字策略 ============================ */

/** 缺字策略：逐字替换（默认）/ 整行回退 */
export type GlyphPolicy = "fallback" | "line";
export const GLYPH_POLICY_KEY = "lyricFontGlyph";

export function readGlyphPolicy(values: Record<string, string | undefined>): GlyphPolicy {
  return values[GLYPH_POLICY_KEY] === "line" ? "line" : "fallback";
}

/* ============================ 读取设置（含旧键迁移）============================ */

/** 旧值可能是逗号分隔的多选列表（上一版「外文」槽）——迁移时只取第一个 */
function firstId(raw: string | undefined): string {
  return (
    String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0] ?? ""
  );
}

/** 读取某个语言槽的字体 id；"" = 跟随歌曲主语言 */
export function readSlotFont(values: Record<string, string | undefined>, slot: FontSlot): string {
  const own = (values[slotKey(slot)] ?? "").trim();
  if (own) return firstId(own);
  // ---- 旧设置迁移（lyricFontEn 曾是逗号多选；lyricFont / lyricFontCustom 是更早的单字体模型）----
  const legacyEn = firstId(values["lyricFontEn"]);
  const legacy = (values["lyricFont"] ?? "").trim();
  const legacyCustom = (values["lyricFontCustom"] ?? "").trim();
  if (slot === "latin") {
    if (legacyEn) return legacyEn;
    if (legacy === "custom") return legacyCustom ? fileId(legacyCustom) : SYSTEM_FONT;
    if (legacy && legacy !== "mashanzheng") return legacy;
    return "";
  }
  if (slot === "zh" && legacy === "mashanzheng") return "mashanzheng";
  return "";
}

/** 四个槽当前的字体 id */
export function readSlotFonts(
  values: Record<string, string | undefined>
): Record<FontSlot, string> {
  const out = {} as Record<FontSlot, string>;
  for (const s of SLOT_IDS) out[s] = readSlotFont(values, s);
  return out;
}

export function readSize(values: Record<string, string | undefined>): number {
  const n = Number(values["lyricFontSize"]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIZE;
  return Math.min(SIZE_RANGE[1], Math.max(SIZE_RANGE[0], n));
}

export function readWeight(values: Record<string, string | undefined>): number {
  const n = Number(values["lyricFontWeight"]);
  if (!Number.isFinite(n) || n < 100) return DEFAULT_WEIGHT;
  return Math.min(900, Math.max(100, n));
}

/* ============================ 语言判定 ============================ */

const RE_KANA = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/;
const RE_HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7FF]/;
const RE_HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;
const RE_LATIN = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
/** 简体专用字（日文字体通常没有这些码位）——用来分辨"纯汉字行"是不是中文 */
const RE_SIMPLIFIED =
  /[说这们汉语听爱见电书车马鸟长发习广义术农单复买卖亚产亲亿优传让认计论谢请谁过进远连选铁银错问阳队场极构权观规觉为]/;
/** 和制汉字 / 日文专用字——出现就说明这行是日文 */
const RE_JP_KANJI = /[円駅沢畑辻込峠働畠榊]/;
/**
 * 繁体专用字——出现就说明这行是中文。
 * 刻意只收「繁体独有、且日文不用」的字：長/見/電/書/語/愛/風/東/頭 这些日文同样在用，
 * 收进来会把"纯汉字的日文行"误判成中文，所以排除在外。
 */
const RE_TRADITIONAL = /[說這們聽兒與學廣醫單賣亞產傳讓鐵權觀覺點麼樣實對應]/;

/**
 * 纯汉字行归谁。三条证据，按可靠性排序：
 *   1. 和制汉字 → 日文；简/繁体专用字 → 中文（码位层面的硬证据）
 *   2. 同一时间戳的兄弟行是**别的文字**（假名 / 谚文 / 拉丁）→ 这一行是翻译 → 中文
 *   3. 都不成立才跟随整首歌的主语言
 *
 * ⚠️ 第 2 条原先只认假名（想着"日文歌的中文翻译"），于是**韩文歌**的纯汉字翻译行三条证据
 * 全不成立，一路落到 songSlot = ko → 拿韩文字体去渲染中文：韩文字体只覆盖常用汉字（Hanja），
 * 覆盖到的字生效、覆盖不到的掉系统正体 —— 正是用户看到的"有的字用了设置的字体、有的没有"。
 * 现在把谚文 / 拉丁也算进来（韩文歌、英文歌的翻译行同理）。
 */
function hanLineSlot(text: string, songSlot: FontSlot | null, groupHasOtherScript: boolean): FontSlot {
  if (RE_JP_KANJI.test(text)) return "ja";
  if (RE_SIMPLIFIED.test(text) || RE_TRADITIONAL.test(text)) return "zh";
  if (groupHasOtherScript) return "zh";
  return songSlot ?? "zh";
}

/**
 * 一行属于哪个语言槽。
 * @param siblings 同一时间戳的其它行（用于识别"原词 + 翻译"）
 */
export function detectLineSlot(
  text: string,
  songSlot: FontSlot | null,
  siblings: string[] = []
): FontSlot {
  if (RE_KANA.test(text)) return "ja";
  if (RE_HANGUL.test(text)) return "ko";
  if (RE_HAN.test(text)) {
    // 兄弟行只要不是汉字（假名 / 谚文 / 拉丁），这一行就大概率是"翻译"那一行
    const groupHasOtherScript = siblings.some(
      (t) => RE_KANA.test(t) || RE_HANGUL.test(t) || RE_LATIN.test(t)
    );
    return hanLineSlot(text, songSlot, groupHasOtherScript);
  }
  if (RE_LATIN.test(text)) return "latin";
  return songSlot ?? "latin";
}

/**
 * 整首歌的主语言（决定"没设置的槽"跟随谁）。用**强信号**而不是比例：
 * 假名只可能出现在日语、谚文只可能出现在韩语，出现即判定，比"假名够不够多"稳得多
 * ——比例阈值会被中文翻译行的汉字顶掉，把日文歌误判成中文歌。
 */
export function detectSongSlot(texts: string[]): FontSlot | null {
  let kana = false;
  let hangul = false;
  let han = false;
  let latin = false;
  for (const t of texts) {
    for (const ch of t) {
      if (RE_KANA.test(ch)) kana = true;
      else if (RE_HANGUL.test(ch)) hangul = true;
      else if (RE_HAN.test(ch)) han = true;
      else if (RE_LATIN.test(ch)) latin = true;
    }
  }
  if (hangul) return "ko";
  if (kana) return "ja";
  if (han) return "zh";
  if (latin) return "latin";
  return null;
}

/** 整首歌的每一行归哪个槽（groups 为"同一时间戳"的行号分组，用于翻译行判定） */
export function detectLineSlots(
  texts: string[],
  songSlot: FontSlot | null,
  groups?: number[][]
): FontSlot[] {
  const siblingOf = new Map<number, number[]>();
  if (groups) {
    for (const g of groups) for (const i of g) siblingOf.set(i, g);
  }
  return texts.map((text, i) => {
    const g = siblingOf.get(i);
    const siblings = g ? g.filter((j) => j !== i).map((j) => texts[j] ?? "") : [];
    return detectLineSlot(text, songSlot, siblings);
  });
}

/* ============================ 字体栈 ============================ */

/**
 * 某一行的字体栈。固定规则、与点击顺序无关：
 *   本语言槽（独占范围） → 其他已设槽（**只借独占脚本**） → 主语言槽字体（不限范围，补缺） → 系统兜底链
 * skipOwn：该行缺字且策略为"整行回退"时，把本语言槽的字体整体撤掉（连补缺层一起）。
 */
export function fontStackFor(
  chosen: Record<FontSlot, string>,
  lineSlot: FontSlot,
  songSlot: FontSlot | null,
  skipOwn = false
): string {
  const parts: string[] = [];
  const push = (css: string) => {
    if (css && !parts.includes(css)) parts.push(css);
  };
  const own = chosen[lineSlot];
  const ownUsable = !!own && own !== SYSTEM_FONT && !skipOwn;
  if (ownUsable) push('"' + ownFamilyBare(own, lineSlot) + '"');
  for (const s of SLOT_IDS) {
    const id = chosen[s];
    if (s === lineSlot || !id || id === SYSTEM_FONT) continue;
    const bare = crossFamilyBare(id, s);
    if (bare) push('"' + bare + '"');
  }
  // 补缺层。三种情况必须区分开：
  //   · 这一栏没做过选择（"跟随歌曲主语言"）→ 用主语言槽的字体补缺（"一首歌一个声音"）；
  //   · 显式选了"系统默认" → 用户就要这个语言走系统字体，不要再被主语言字体接管；
  //   · 整行回退（skipOwn）→ 本槽字体连补缺都不要用。
  const ownSet = own !== "";
  let filler = ownSet ? (own === SYSTEM_FONT ? "" : own) : songSlot ? chosen[songSlot] : "";
  if (skipOwn && filler === own) filler = "";
  if (filler && filler !== SYSTEM_FONT) push(familyOf(filler));
  for (const f of SYSTEM_CHAIN) push(f);
  return parts.join(", ");
}

export interface LyricFontStacks {
  /** 每个语言槽的完整字体栈 */
  bySlot: Record<FontSlot, string>;
  /** 主语言栈（兼容老设置里的 --lyric-font） */
  primary: string;
}

export function lyricFontStacks(
  values: Record<string, string | undefined>,
  songSlot: FontSlot | null
): LyricFontStacks {
  const chosen = readSlotFonts(values);
  const bySlot = {} as Record<FontSlot, string>;
  for (const s of SLOT_IDS) bySlot[s] = fontStackFor(chosen, s, songSlot);
  return { bySlot, primary: bySlot[songSlot ?? "latin"] };
}

/** 这一行的主字体是否缺字（cov 为 null = 未检测 → 一律返回 false，绝不因此改渲染行为） */
export function lineHasMissing(text: string, slot: FontSlot, cov: Coverage | null): boolean {
  if (!cov) return false;
  const rs = SLOT_DEF.get(slot)?.ownRanges ?? [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    if (inRanges(rs, cp) && !covers(cov, cp)) return true;
  }
  return false;
}

/* ============================ 覆盖检测 ============================ */

const covCache = new Map<string, Promise<Coverage | null>>();

async function fontBytes(id: string): Promise<ArrayBuffer | null> {
  const builtin = BUILTIN_FACE[id];
  if (builtin) {
    const res = await fetch(builtin.url);
    return res.ok ? await res.arrayBuffer() : null;
  }
  const file = fileOf(id);
  return file ? await fontRead(file) : null;
}

/** 某个字体的覆盖（同一字体只解析一次；woff/woff2 返回 null = 未检测） */
export function coverageOf(id: string): Promise<Coverage | null> {
  const cached = covCache.get(id);
  if (cached) return cached;
  const task = (async () => {
    try {
      const bytes = await fontBytes(id);
      return bytes ? parseCmap(bytes) : null;
    } catch {
      return null;
    }
  })();
  covCache.set(id, task);
  return task;
}

/** 当前设置里用到的所有字体的覆盖表 */
export async function loadCoverage(
  values: Record<string, string | undefined>
): Promise<Record<string, Coverage | null>> {
  const chosen = readSlotFonts(values);
  const ids = [...new Set(SLOT_IDS.map((s) => chosen[s]))].filter(
    (id): id is string => !!id && id !== SYSTEM_FONT
  );
  const out: Record<string, Coverage | null> = {};
  await Promise.all(
    ids.map(async (id) => {
      out[id] = await coverageOf(id);
    })
  );
  return out;
}

/** 设置页的样张体检：这个字体能不能完整渲染本槽的样字 */
export function sampleCoverage(
  slot: FontSlot,
  cov: Coverage | null
): { total: number; missing: string[] } | null {
  if (!cov) return null;
  const sample = SLOT_DEF.get(slot)?.sample ?? "";
  const codes = new Set([...sample].map((c) => c.codePointAt(0) ?? 0).filter((c) => c > 0x20));
  return { total: codes.size, missing: missingIn(cov, sample) };
}

/* ============================ 字面注册 ============================ */

/** 上传字体池（app_data/fonts 下的文件名） */
export async function listFontFiles(): Promise<string[]> {
  try {
    return await fontList();
  } catch {
    return [];
  }
}

const registered = new Map<string, Promise<boolean>>();

interface FaceSpec {
  key: string;
  family: string;
  ranges: string | null;
}

/** 一个「字体 × 范围」字面的完整描述；null = 不需要注册 */
function faceSpec(id: string, slot: FontSlot | null, cross: boolean): FaceSpec | null {
  const bare = bareFamilyOf(id);
  if (!bare) return null;
  if (!slot) return { key: id + "@all", family: bare, ranges: null };
  const def = SLOT_DEF.get(slot);
  if (!def) return null;
  const rs = cross ? def.crossRanges : def.ownRanges;
  if (rs.length === 0) return null;
  const fam = cross ? crossFamilyBare(id, slot) : ownFamilyBare(id, slot);
  if (!fam) return null;
  return { key: id + "@" + slot + (cross ? "_x" : ""), family: fam, ranges: cssRanges(rs) };
}

async function faceSource(id: string): Promise<string | ArrayBuffer | null> {
  const builtin = BUILTIN_FACE[id];
  if (builtin) return 'url("' + builtin.url + '")';
  const file = fileOf(id);
  if (!file) return null;
  return await fontRead(file);
}

function ensureFace(spec: FaceSpec, id: string): Promise<boolean> {
  const cached = registered.get(spec.key);
  if (cached) return cached;
  const task = (async () => {
    try {
      const source = await faceSource(id);
      if (source == null) return false;
      const desc: FontFaceDescriptors = spec.ranges ? { unicodeRange: spec.ranges } : {};
      const face = new FontFace(spec.family, source, desc);
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      registered.delete(spec.key);
      return false;
    }
  })();
  registered.set(spec.key, task);
  return task;
}

/** 注册一个上传字体（同名文件只注册一次）；成功后 CSS 里可用 customFamily(name) */
export function ensureFontFile(name: string): Promise<boolean> {
  const id = fileId(name);
  const spec = faceSpec(id, null, false);
  return spec ? ensureFace(spec, id) : Promise.resolve(false);
}

/** 上传字体文件：写入应用数据目录 → 注册 → 返回文件名 */
export async function uploadFont(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = await fontSave(file.name, bytes);
  // 同名覆盖上传：该字体的全部缓存都要失效（不限范围 / 本槽 / 借出 / 覆盖表），否则会继续用旧字节
  const id = fileId(name);
  for (const key of [...registered.keys()]) {
    if (key.startsWith(id + "@")) registered.delete(key);
  }
  covCache.delete(id);
  const ok = await ensureFontFile(name);
  if (!ok) throw new Error("字体已保存但加载失败，可能不是有效字体");
  return name;
}

/** 确保当前设置用到的所有字面都已注册（每个槽：不限范围 + 本槽独占范围 + 借出范围） */
export async function ensureFontFaces(values: Record<string, string | undefined>): Promise<void> {
  const chosen = readSlotFonts(values);
  const tasks: Promise<boolean>[] = [];
  for (const s of SLOT_IDS) {
    const id = chosen[s];
    if (!id || id === SYSTEM_FONT) continue;
    for (const spec of [faceSpec(id, null, false), faceSpec(id, s, false), faceSpec(id, s, true)]) {
      if (spec) tasks.push(ensureFace(spec, id));
    }
  }
  await Promise.all(tasks);
}

/** 写入设置并刷新本地 store（歌词页立即生效） */
export async function setFontSetting(key: string, value: string): Promise<void> {
  await useSettingsStore.getState().set(key, value);
}
