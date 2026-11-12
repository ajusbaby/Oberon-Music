/**
 * 歌词字体系统（实现《docs/歌词自定义字体系统方案.md》）
 *
 * 这个文件只做**纯逻辑**：档案配置、字体链、语言判定、行内分段。
 * 不碰 DOM、不碰 IPC —— 任何"当前有哪些字体"的事实都由调用方传进来，
 * 这样 scripts/font-logic.check.ts 才能在 node 里直接跑断言。
 *
 * 三层解耦（文档 §1）：字体资源（有哪些字体）→ 语言档案（哪个语言用哪个主字体）
 * → 文本归属（这一行算哪个语言）→ 渲染回退（缺字了往哪退）。
 *
 * 刻意不做的事（历史上踩过的坑）：
 *   · 不把多个字体拼进一条 font-family 就当成"用户的选择" —— 优先级会来自点击顺序；
 *   · 不按导入顺序定优先级 —— 同样的选择集合必须得到同样的结果；
 *   · 不按 Unicode 区间判中日 —— 汉字区里中日共用，必须看假名 / 简体字 / 日式汉字；
 *   · 不在导入时合并字体 —— 合并会产生许可证问题，也会让缺字判断失真。
 */

import type { FontResource } from "../api/types";

/* ============================ 语言档案（§3） ============================ */

export const PROFILE_IDS = ["zhHans", "zhHant", "ja", "ko", "latin", "symbols"] as const;
export type FontProfileId = (typeof PROFILE_IDS)[number];

export interface ProfileSpec {
  id: FontProfileId;
  /** 界面上的档案名 */
  label: string;
  /** 一句话说明这个档案管哪些字 */
  hint: string;
  /** §11 规定的预览文案（含该语言特有字形，能看出字体到底压不压得住） */
  sample: string;
  /** 渲染该档案时 <p lang> 用哪个值 */
  lang: string;
  /**
   * 该语言的原生系统字体链（§6.1）。顺序写死在这里，不由用户维护 ——
   * 用户可以换主字体，但不能把中文字体塞进日文链（这是"同语言回退"的底线）。
   */
  system: string[];
}

/** 通用的 UI 拉丁字体（所有语言的链尾都共用） */
const UI_LATIN = [
  "Inter",
  "Segoe UI",
  "-apple-system",
  "BlinkMacSystemFont",
  "Helvetica Neue",
  "Arial",
];

export const PROFILES: Record<FontProfileId, ProfileSpec> = {
  zhHans: {
    id: "zhHans",
    label: "简体中文",
    hint: "简体汉字。日文假名、谚文不归这里。",
    sample: "你好，音乐播放器。缺字示例：𠀀 𪚥",
    lang: "zh-Hans",
    system: [
      "Microsoft YaHei",
      "Noto Sans SC",
      "Source Han Sans SC",
      "Noto Sans CJK SC",
      "PingFang SC",
      "Hiragino Sans GB",
      "DengXian",
      "SimSun",
      ...UI_LATIN,
    ],
  },
  zhHant: {
    id: "zhHant",
    label: "繁体中文",
    hint: "繁体汉字（說、這、麼）。缺字时只往繁体字体退，不借简体字形。",
    sample: "繁體中文，音樂播放器。缺字示例：𠀀 𪚥",
    lang: "zh-Hant",
    system: [
      "Microsoft JhengHei",
      "PingFang TC",
      "Noto Sans CJK TC",
      "Noto Sans TC",
      "Source Han Sans TC",
      "MingLiU",
      "PMingLiU",
      "SimSun",
      ...UI_LATIN,
    ],
  },
  ja: {
    id: "ja",
    label: "日文",
    hint: "假名与日式汉字（直、駅、円）。中文简体字不该进这条链。",
    sample: "君の名前は、東京、直ぐに。缺字示例：𠀀",
    lang: "ja",
    system: [
      "Yu Gothic UI",
      "Yu Gothic",
      "Meiryo",
      "MS Gothic",
      "Hiragino Kaku Gothic ProN",
      "Hiragino Sans",
      "Noto Sans CJK JP",
      "Noto Sans JP",
      ...UI_LATIN,
    ],
  },
  ko: {
    id: "ko",
    label: "韩文",
    hint: "谚文（한글）。缺字时退到韩文字体，不借汉字字形。",
    sample: "너의 이름은, 음악. 缺字示例：𠀀",
    lang: "ko",
    system: [
      "Malgun Gothic",
      "Noto Sans CJK KR",
      "Noto Sans KR",
      "Apple SD Gothic Neo",
      "NanumGothic",
      ...UI_LATIN,
    ],
  },
  latin: {
    id: "latin",
    label: "拉丁字母",
    hint: "英文与西欧字母，也负责中文行里夹的英文单词。",
    sample: "Hello, Music Player — 0123456789",
    lang: "en",
    system: UI_LATIN,
  },
  symbols: {
    id: "symbols",
    label: "符号与 Emoji",
    hint: "♫ ★ → ① 这类符号，以及彩色 Emoji。",
    sample: "♫ → ★ ① 😀 🎵",
    lang: "und",
    system: [
      "Segoe UI Symbol",
      "Segoe UI Emoji",
      "Apple Color Emoji",
      "Noto Color Emoji",
      "Noto Sans Symbols 2",
      "Segoe UI",
    ],
  },
};

/** 按文档顺序的档案列表（界面按这个顺序排） */
export const PROFILE_LIST: ProfileSpec[] = PROFILE_IDS.map((id) => PROFILES[id]);

/** 某些行是"纯符号"，也可能是空白 —— 用 und 而不是随便挑个语言 */
export function profileLang(id: FontProfileId): string {
  return PROFILES[id]?.lang ?? "und";
}

/* ============================ 档案配置（§9 FontProfile） ============================ */

/** 缺字回退策略（§7.3 的三档，作用域是整个档案而不是单个字符） */
export type FallbackPolicy = "same-language" | "system-first" | "strict";

export const POLICY_OPTIONS: { value: FallbackPolicy; label: string; hint: string }[] = [
  {
    value: "same-language",
    label: "同语言回退",
    hint: "主字体缺字时，先用备用字体，再用该语言的系统字体",
  },
  {
    value: "system-first",
    label: "系统优先",
    hint: "主字体只在前，缺字立刻交给系统字体（看起来最稳，风格最不统一）",
  },
  {
    value: "strict",
    label: "严格",
    hint: "只用导入的字体，缺字就露方框 —— 用来检查字体到底完整不完整",
  },
];

export interface FontProfile {
  /** 主字体；null = 用系统字体 */
  primaryFontId: string | null;
  /** 同语言备用字体，按用户排的顺序逐个尝试 */
  fallbackFontIds: string[];
  fallbackPolicy: FallbackPolicy;
  enabled: boolean;
}

export type FontProfiles = Record<FontProfileId, FontProfile>;

export const PROFILES_KEY = "lyricFontProfiles";
/** §11「显示实际字体来源」开关 */
export const FONT_SOURCE_KEY = "lyricFontShowSource";
/** 语言判定策略：consistent = 整首一致；accurate = 逐行按证据 */
export const MATCH_POLICY_KEY = "lyricFontMatch";
export type MatchPolicy = "consistent" | "accurate";

function emptyProfile(): FontProfile {
  return { primaryFontId: null, fallbackFontIds: [], fallbackPolicy: "same-language", enabled: true };
}

export function defaultProfiles(): FontProfiles {
  const out = {} as FontProfiles;
  for (const id of PROFILE_IDS) out[id] = emptyProfile();
  return out;
}

/** 从 settings 的字符串里读档案配置：字段缺失 / 类型不对 / JSON 坏掉都退回默认值，不抛 */
export function readProfiles(values: Record<string, string> | null | undefined): FontProfiles {
  const out = defaultProfiles();
  const raw = values?.[PROFILES_KEY];
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const id of PROFILE_IDS) {
    const src = (parsed as Record<string, unknown>)[id];
    if (!src || typeof src !== "object") continue;
    const p = src as Record<string, unknown>;
    const policy =
      p.fallbackPolicy === "system-first" || p.fallbackPolicy === "strict" || p.fallbackPolicy === "same-language"
        ? (p.fallbackPolicy as FallbackPolicy)
        : "same-language";
    const primaryFontId =
      typeof p.primaryFontId === "string" && p.primaryFontId ? p.primaryFontId : null;
    // 主字体不能同时出现在备用链里（老数据、手工改过 JSON 都可能这样溢出），
    // 读的时候就地归一化，界面就永远不会出现"备用字体选了个等于主字体的项"
    const fallbackFontIds: string[] = [];
    if (Array.isArray(p.fallbackFontIds)) {
      for (const x of p.fallbackFontIds) {
        if (typeof x !== "string" || !x) continue;
        if (x === primaryFontId) continue;
        if (fallbackFontIds.includes(x)) continue;
        fallbackFontIds.push(x);
      }
    }
    out[id] = {
      primaryFontId,
      fallbackFontIds,
      fallbackPolicy: policy,
      enabled: p.enabled !== false,
    };
  }
  return out;
}

export function serializeProfiles(profiles: FontProfiles): string {
  return JSON.stringify(profiles);
}

/** 界面上"缺字策略"是一行改全部档案 —— 这里取它们的公共值，不一致时给默认档 */
export function sharedPolicy(profiles: FontProfiles): FallbackPolicy {
  const first = profiles[PROFILE_IDS[0]].fallbackPolicy;
  return PROFILE_IDS.every((id) => profiles[id].fallbackPolicy === first) ? first : "same-language";
}

export function applyPolicy(profiles: FontProfiles, policy: FallbackPolicy): FontProfiles {
  const out = {} as FontProfiles;
  for (const id of PROFILE_IDS) out[id] = { ...profiles[id], fallbackPolicy: policy };
  return out;
}

/** 删掉一个字体资源后，把所有引用它的档案清干净（§16：自动回落到系统字体） */
export function forgetFont(profiles: FontProfiles, fontId: string): { profiles: FontProfiles; touched: FontProfileId[] } {
  const out = {} as FontProfiles;
  const touched: FontProfileId[] = [];
  for (const id of PROFILE_IDS) {
    const p = profiles[id];
    const wasPrimary = p.primaryFontId === fontId;
    const fallbacks = p.fallbackFontIds.filter((x) => x !== fontId);
    if (wasPrimary || fallbacks.length !== p.fallbackFontIds.length) touched.push(id);
    out[id] = { ...p, primaryFontId: wasPrimary ? null : p.primaryFontId, fallbackFontIds: fallbacks };
  }
  return { profiles: out, touched };
}

export function readShowSource(values: Record<string, string> | null | undefined): boolean {
  const raw = values?.[FONT_SOURCE_KEY];
  if (raw === undefined) return true;
  return raw !== "0" && raw !== "false";
}

export function readMatchPolicy(values: Record<string, string> | null | undefined): MatchPolicy {
  return values?.[MATCH_POLICY_KEY] === "accurate" ? "accurate" : "consistent";
}

/* ==================== 歌曲级语言覆盖（§5.4 / §9.3） ==================== */

/**
 * 一首歌的语言归属由统计判定，但统计会错：整首 Rap、全英文采样、通篇和制汉字……
 * 这时用户需要能**只改这一首**，而不是去改档案把别的歌也带歪。
 *
 * 存法：settings 里一条 JSON（{[trackId]: FontProfileId}），不建表 ——
 * 覆盖是给人用的例外，规模很小，跟着设置一起读写反而最省事。
 * 键是曲目 id 的字符串形式；不写进配置的曲目 = 自动判定。
 */
export const OVERRIDES_KEY = "lyricLangOverrides";

export type LangOverrides = Partial<Record<string, FontProfileId>>;

/** select 里代表"自动"的空值 */
export const OVERRIDE_AUTO = "";

function isProfileId(v: unknown): v is FontProfileId {
  return typeof v === "string" && (PROFILE_IDS as readonly string[]).includes(v);
}

export function readOverrides(
  values: Record<string, string> | null | undefined,
): LangOverrides {
  const raw = values?.[OVERRIDES_KEY];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: LangOverrides = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key && isProfileId(value)) out[key] = value;
  }
  return out;
}

export function getOverride(
  overrides: LangOverrides,
  trackId: string | number | null | undefined,
): FontProfileId | null {
  if (trackId === null || trackId === undefined || trackId === "") return null;
  return overrides[String(trackId)] ?? null;
}

/** 写一条覆盖；id 为 null 表示删掉这一首的覆盖（回到自动判定）。返回新对象，不改入参 */
export function setOverride(
  overrides: LangOverrides,
  trackId: string | number | null | undefined,
  id: FontProfileId | null,
): LangOverrides {
  const next: LangOverrides = { ...overrides };
  const key = trackId === null || trackId === undefined ? "" : String(trackId);
  if (!key) return next;
  if (id) next[key] = id;
  else delete next[key];
  return next;
}

export function serializeOverrides(overrides: LangOverrides): string {
  // 键排序后序列化：同样的覆盖集合永远得到同样的字符串（便于比较与排错）
  const keys = Object.keys(overrides).sort();
  const out: Record<string, FontProfileId> = {};
  for (const k of keys) {
    const v = overrides[k];
    if (v) out[k] = v;
  }
  return JSON.stringify(out);
}

/** 覆盖后的歌曲档案：有覆盖就用覆盖，否则用统计判定（§10 渲染流程的第一步） */
export function resolveSongProfile(
  detected: FontProfileId | null,
  overrides: LangOverrides,
  trackId: string | number | null | undefined,
): FontProfileId | null {
  return getOverride(overrides, trackId) ?? detected;
}

/* ============================ 字体资源 → CSS 家族名 ============================ */

/**
 * 注册到 document.fonts 的家族名。加 "OB " 前缀是为了：
 *   1) 避免和系统字体 / 用户自己装的其他同名字体撞车（浏览器会挑系统那份）；
 *   2) 一眼能看出这个字形来自导入字体，调试时省事。
 */
export function fontFamilyName(id: string): string {
  return "OB " + id;
}

const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
  "emoji", "math", "fangsong",
]);

/** CSS 家族名加引号：通用族不加，含空格或特殊字符的必须加 */
function cssFamily(name: string): string {
  if (GENERIC_FAMILIES.has(name)) return name;
  if (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name) && !name.startsWith("-")) return name;
  return '"' + name.replace(/"/g, '\\"') + '"';
}

/* ============================ 字体链（§7.1） ============================ */

export interface ChainResult {
  /** 按顺序排列的家族名（含通用族 sans-serif 收尾） */
  families: string[];
  /** 直接写进 style.fontFamily 的字符串 */
  css: string;
  /** 这条链里用到的导入字体 id（按顺序，已剔除不存在的资源） */
  userFontIds: string[];
}

/**
 * 链的装配：谁能进链、按什么顺序，只由"档案配置 + 策略 + 该语言的系统链"决定。
 * 与资源的加载状态无关 —— 查不到的 id 由调用方先剔掉（被删的资源不该让整条链塌掉）。
 */
export function chainOf(userFontIds: string[], policy: FallbackPolicy, system: string[]): ChainResult {
  const user = userFontIds.map((id) => cssFamily(fontFamilyName(id)));
  const sys = system.map(cssFamily);
  let families: string[];
  if (policy === "strict") families = [...user];
  else if (policy === "system-first") families = [...sys, ...user];
  else families = [...user, ...sys];
  if (!families.includes("sans-serif")) families.push("sans-serif");
  return { families, css: families.join(", "), userFontIds };
}

/**
 * 给一个档案生成字体链。
 *
 * 顺序（same-language，默认）：
 *   主字体 → 该档案的备用字体 → 该语言的系统链 → sans-serif
 * system-first：系统链 → 主字体 → 备用字体 → sans-serif
 * strict：只留导入字体（没有就只剩 sans-serif，方框即反馈）
 *
 * 档案被 enabled=false 关掉时，等价于"只用系统字体"。
 */
export function buildChain(
  profileId: FontProfileId,
  profile: FontProfile,
  resources: FontResource[] | null | undefined,
): ChainResult {
  const byId = new Map<string, FontResource>();
  for (const r of resources ?? []) if (!r.missing) byId.set(r.id, r);
  const ids: string[] = [];
  // 档案被关掉时一个用户字体都不进链 —— 只留该语言的系统链，配置原样保留（改回来就生效）
  if (profile.enabled) {
    if (profile.primaryFontId && byId.has(profile.primaryFontId)) ids.push(profile.primaryFontId);
    for (const id of profile.fallbackFontIds) {
      if (id !== profile.primaryFontId && byId.has(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return chainOf(ids, profile.fallbackPolicy, PROFILES[profileId].system);
}

/** 六份档案各自的链。resources 为空（还没加载完）时就是纯系统链。 */
export function buildStacks(
  profiles: FontProfiles,
  resources: FontResource[] | null | undefined,
): Record<FontProfileId, ChainResult> {
  const out = {} as Record<FontProfileId, ChainResult>;
  for (const id of PROFILE_IDS) out[id] = buildChain(id, profiles[id], resources);
  return out;
}

/* ============================ 覆盖查询（§12） ============================ */

/**
 * 这个字体有没有这个码点的字形。coverageRanges 是升序闭区间，
 * 二分查找，播放时每帧都可能调用，所以不做对象分配。
 */
export function fontCovers(resource: FontResource | null | undefined, cp: number): boolean {
  if (!resource || !resource.parsed) return false;
  const ranges = resource.coverageRanges;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 预览文案里有哪些字主字体其实没有（§11 缺字提示） */
export function missingSampleChars(profileId: FontProfileId, primary: FontResource | null | undefined): string[] {
  if (!primary || !primary.parsed) return [];
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const ch of PROFILES[profileId].sample) {
    if (ch.trim() === "") continue;
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (fontCovers(primary, cp)) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    missing.push(ch);
  }
  return missing;
}

/* ============================ 语言判定（§5） ============================ */

// 假名：不含长音符 U+30FC、中点 U+30FB、重复记号 U+30A0，它们在中日韩都可能出现
const RE_KANA = /[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/g;
const RE_HANGUL = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g;
const RE_HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const RE_LATIN = /[A-Za-zÀ-ÖØ-öø-ÿ]/g;

// 只在简化字里出现、繁体不用（也不在日文常用汉字里）的字
const RE_SIMPLIFIED = /[这们说听儿与学广医单卖亚产传让铁权观觉点么样实对应电车门马鸟龙风飞见长东业乐习书买乱争于云亲亿仅从仓仪会伟伤价众优体余侧备传]/g;
// 只在繁体里出现的字
const RE_TRADITIONAL = /[這們說聽兒與學廣醫單賣亞產傳讓鐵權觀覺點麼樣實對應電車門馬鳥龍風飛見長東業樂習書買亂爭於雲親億僅從倉儀會偉傷價眾優體餘側備傳]/g;
// 日式汉字（新字体）：和中文写法不同，是判断"这行是日文"的有力证据
const RE_JP_KANJI = /[円駅沢畑辻込峠働畠榊広辺変気図団実発対続読売戯歳県様]/g;

function countOf(re: RegExp, text: string): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export interface LineEvidence {
  kana: number;
  hangul: number;
  han: number;
  latin: number;
  simplified: number;
  traditional: number;
  jpKanji: number;
  /** 非空白字符数 */
  total: number;
}

export function lineEvidence(text: string): LineEvidence {
  const compact = text.replace(/\s+/g, "");
  return {
    kana: countOf(RE_KANA, text),
    hangul: countOf(RE_HANGUL, text),
    han: countOf(RE_HAN, text),
    latin: countOf(RE_LATIN, text),
    simplified: countOf(RE_SIMPLIFIED, text),
    traditional: countOf(RE_TRADITIONAL, text),
    jpKanji: countOf(RE_JP_KANJI, text),
    total: compact.length,
  };
}

/** 汉字系档案（判定时会互相竞争的那四个） */
const HAN_PROFILES: FontProfileId[] = ["zhHans", "zhHant", "ja", "ko"];

function isHanProfile(id: FontProfileId): boolean {
  return HAN_PROFILES.includes(id);
}

/**
 * 整首歌归属哪个档案（§5.4 歌曲级判定）。
 *
 * 判断顺序是有意为之：谚文 / 假名这类**专属文字**优先，因为它们是硬证据；
 * 汉字区两国共用，只能靠简体字 vs 日式汉字这类软证据，放在后面。
 */
export function detectSongProfile(
  texts: string[],
  /** 不参与统计的行（翻译行）。见 lyricLines.layoutLyricLines —— 翻译不是唱出来的词，
   *  它的文字体系是译者选的：中韩双语歌词里汉字翻译行会让谚文占比跌破 30% 阈值，
   *  整首就被判成中文了。 */
  ignore?: readonly boolean[],
): FontProfileId {
  let kana = 0, hangul = 0, han = 0, latin = 0, simp = 0, trad = 0, jpKanji = 0;
  for (let i = 0; i < texts.length; i++) {
    if (ignore && ignore[i]) continue;
    const e = lineEvidence(texts[i]);
    kana += e.kana;
    hangul += e.hangul;
    han += e.han;
    latin += e.latin;
    simp += e.simplified;
    trad += e.traditional;
    jpKanji += e.jpKanji;
  }
  const cjk = kana + han + hangul;
  if (hangul >= 3 && (cjk === 0 || hangul / cjk >= 0.3)) return "ko";
  if (kana >= 3 && kana / (kana + han) >= 0.1) return "ja";
  // 全是汉字：日式汉字够多且没有假名 → 仍然可能是日文（汉文训读、标题党歌词）
  if (kana === 0 && jpKanji >= 2 && jpKanji * 4 >= Math.max(1, han)) return "ja";
  if (trad >= 3 && trad > simp) return "zhHant";
  if (han > 0) return "zhHans";
  if (latin > 0) return "latin";
  return "symbols";
}

/**
 * 单行归属。evidence 按文档权重折算：
 *   专属文字（假名 / 谚文）70/字 —— 出现即定音；
 *   日式汉字 30/字（上限 60）；
 *   简体 / 繁体专用字 25/字（上限 50）；
 *   整首统计 30 —— 纯汉字行跟着歌曲走（单个汉字本身权重 0）。
 * consistent 策略下，纯汉字行一律跟歌曲走，不看简体/繁体标记：
 * 一首歌里偶尔冒出一个繁体字不该让那一行换字体。
 */
export function detectLineProfile(
  text: string,
  songProfile: FontProfileId | null,
  policy: MatchPolicy = "consistent",
): FontProfileId {
  const e = lineEvidence(text);
  if (e.total === 0) return songProfile ?? "latin";

  // ① 专属文字：出现即定音，没有"权重大小"可争
  if (e.kana > 0 || e.hangul > 0) {
    if (e.hangul > e.kana) return "ko";
    if (e.kana > 0) return "ja";
    return "ko";
  }

  // ② 汉字行（可能还夹着拉丁单词）：绝不因为"整首是日文歌"就把中文翻译行丢进日文字体
  if (e.han > 0) {
    return hanLineProfile(e, songProfile, policy);
  }

  // ③ 没有汉字也没有假名/谚文
  if (e.latin > 0) return "latin";
  return "symbols";
}

/**
 * 纯汉字行（含汉字 + 拉丁混排）归哪份档案。
 *
 * 这是整套判定里最容易出错的一步。反例：一首日文歌里带中文翻译，
 * 翻译行全是汉字 —— 若按"跟随歌曲"处理就会挂日文字体，简体字再逐个回退到中文字体，
 * 一行里两种字体、两种字号、两种笔画（用户最初报的问题就是这么来的）。
 *
 * 所以：
 *   · 日式汉字（駅 / 円 / 働 / 変 …）是硬证据，两种策略下都判日文；
 *   · consistent（整首一致）：跟**整首**的中文简繁倾向走，不看单行证据 ——
 *     一首简体歌里偶尔冒出一个繁体字，不该让那一行换字体；
 *   · accurate（逐行判定）：单行的简体 / 繁体专用字先定音，没有证据才跟随歌曲。
 */
function hanLineProfile(
  e: LineEvidence,
  songProfile: FontProfileId | null,
  policy: MatchPolicy,
): FontProfileId {
  if (e.jpKanji > 0) return "ja";

  const song = songProfile ?? "zhHans";
  const songHan = isHanProfile(song);

  if (policy === "consistent") {
    // 整首一致：只有整首本身就是中文档案时才分简繁，否则一律简体
    return song === "zhHant" ? "zhHant" : "zhHans";
  }

  if (e.traditional > e.simplified) return "zhHant";
  if (e.simplified > e.traditional) return "zhHans";
  if (songHan) return song;
  // 歌曲是日文 / 韩文 / 拉丁，但这行一点假名谚文都没有：当汉字处理（简体）
  return "zhHans";
}

/**
 * 逐行归属；groups 用来做"整组一致"（同一句的原词行跟原词走）。
 *
 * translation 是翻译行位图（来自 layoutLyricLines）：翻译行既不投票也不被统一 ——
 * 它是另一种文字写的同一句话，用中文写的翻译就该用中文字体；
 * 跟着韩文行套韩文字体只会让汉字变成字面不匹配的 Hanja 字形。
 */
export function detectLineProfiles(
  texts: string[],
  songProfile: FontProfileId | null,
  policy: MatchPolicy = "consistent",
  groups?: number[][],
  translation?: readonly boolean[],
): FontProfileId[] {
  const out = texts.map((t) => detectLineProfile(t, songProfile, policy));
  if (policy !== "accurate" || !groups?.length) return out;
  // 逐行判定时，一组里只要有一行是日文 / 韩文，这组整体跟着走 ——
  // 同一句被拆成几行写的时候（原文折行），单看其中一行会误判成中文
  for (const group of groups) {
    let groupProfile: FontProfileId | null = null;
    for (const i of group) {
      if (translation && translation[i]) continue;
      const p = out[i];
      if (p === "ja" || p === "ko") {
        groupProfile = p;
        break;
      }
    }
    if (!groupProfile) continue;
    for (const i of group) {
      if (translation && translation[i]) continue;
      if (out[i] !== groupProfile) out[i] = groupProfile;
    }
  }
  return out;
}

/* ============================ 行内分段（§6.2 / §11） ============================ */

export interface LineRun {
  text: string;
  /** 这一段属于哪个档案 */
  profile: FontProfileId;
  /** 主字体没这个字形，这一段要靠回退链 */
  fallback: boolean;
}

// 必须是 global：下面用 exec 一路扫。少了 g 会让 exec 永远停在同一处 —— 死循环。
const RE_LATIN_WORD = /[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’._-]+/g;

/**
 * 把一行切成"拉丁段 / 其余段"。
 *
 * 为什么切：中文行里夹的英文单词，如果整行都挂中文字体，那段英文会变成
 * 中文字体自带的拉丁字形（通常很丑，甚至根本不是字母）。切出来单独挂拉丁档案。
 *
 * 为什么不按字符切：整行切碎会让 CSS 的 background-clip:text 逐句扫过失效，
 * 也会把"B站"这种夹单个字母的词劈开 —— 只有 ≥2 个连续拉丁字母才切。
 */
export function splitLineRuns(
  text: string,
  lineProfile: FontProfileId,
  primaryFor: (id: FontProfileId) => FontResource | null | undefined,
  byCoverage = false,
): LineRun[] {
  interface Piece { text: string; profile: FontProfileId }
  const pieces: Piece[] = [];
  let cursor = 0;
  RE_LATIN_WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_LATIN_WORD.exec(text))) {
    if (m.index > cursor) pieces.push({ text: text.slice(cursor, m.index), profile: lineProfile });
    pieces.push({ text: m[0], profile: lineProfile === "latin" || lineProfile === "symbols" ? lineProfile : "latin" });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), profile: lineProfile });

  // 按覆盖情况再切：诊断模式要把"主字体出的字"和"回退来的字"分开上色
  const runs: LineRun[] = [];
  for (const piece of pieces) {
    const primary = primaryFor(piece.profile);
    if (!byCoverage || !primary || !primary.parsed) {
      runs.push({ text: piece.text, profile: piece.profile, fallback: false });
      continue;
    }
    let buffer = "";
    let covered: boolean | null = null;
    const flush = () => {
      if (!buffer) return;
      runs.push({ text: buffer, profile: piece.profile, fallback: covered === false });
      buffer = "";
    };
    for (const ch of piece.text) {
      const cp = ch.codePointAt(0) ?? 0;
      const box = ch.trim() === "" ? true : fontCovers(primary, cp);
      if (covered === null) covered = box;
      else if (covered !== box) {
        flush();
        covered = box;
      }
      buffer += ch;
    }
    flush();
  }

  // 合并相邻同类段，减少 span 数量
  const merged: LineRun[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && last.profile === run.profile && last.fallback === run.fallback) last.text += run.text;
    else merged.push({ ...run });
  }
  return merged.length ? merged : [{ text, profile: lineProfile, fallback: false }];
}

/* ============================ 字号 / 粗细 / 当前句缩放（沿用旧配置键） ============================ */

export const DEFAULT_SIZE = 1;
export const SIZE_RANGE: [number, number] = [0.7, 1.8];
export const DEFAULT_WEIGHT = 700;
export const WEIGHT_OPTIONS = [300, 400, 500, 700];
export const DEFAULT_ACTIVE_SCALE = 1.5;
export const ACTIVE_SCALE_RANGE: [number, number] = [1, 2];
export const ACTIVE_SCALE_KEY = "lyricActiveScale";

function clamp(n: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, n));
}

export function readSize(values: Record<string, string> | null | undefined): number {
  const n = Number(values?.["lyricFontSize"]);
  return Number.isFinite(n) && n > 0 ? clamp(n, SIZE_RANGE) : DEFAULT_SIZE;
}

export function readWeight(values: Record<string, string> | null | undefined): number {
  const n = Number(values?.["lyricFontWeight"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEIGHT;
}

export function readActiveScale(values: Record<string, string> | null | undefined): number {
  const n = Number(values?.[ACTIVE_SCALE_KEY]);
  return Number.isFinite(n) && n > 0 ? clamp(n, ACTIVE_SCALE_RANGE) : DEFAULT_ACTIVE_SCALE;
}
