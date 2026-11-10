/**
 * 歌词字体：一律走系统字体栈，不提供任何自定义字体。
 *
 * 这里曾经是一套完整的字体选择系统：设置页可以给「西文 / 中文 / 日文 / 韩文」四个槽分别指定
 * 字体（内置 Ephesis / 马善政 + 用户上传 ttf），并带缺字覆盖检测与整行回退策略。
 * 实际用下来，这套能力本身就是"歌词字体大小粗细不统一"的主要来源：
 *   · 汉字是中日韩共用码位 —— 一行里只要混了别语言的字，就会跨两款字体逐字回退；
 *   · 上传字体往往只覆盖部分汉字，缺的字落回系统正体，一行里两种字面；
 *   · 日文歌里一句谚文能让整首（含四十多行纯汉字）走韩文字体栈；
 *   · 反过来说，用户为了止血把四个槽都设成同一款字体，功能等于不存在。
 * 现在只剩一条路径：按行判定语言 → 取该语言的系统字体链。一行里只有一个声音。
 *
 * 仍然可调：字号（--lyric-size）、字重（--lyric-weight），
 * 以及纯汉字行归哪个语言链（MatchPolicy，见下）。
 */

export type FontSlot = "latin" | "zh" | "ja" | "ko";

export interface SlotDef {
  id: FontSlot;
  /** 语言名（调试与体检脚本用） */
  label: string;
  /** 行上的 lang 属性：中日汉字的字形变体靠它 */
  lang: string;
}

export const SLOTS: SlotDef[] = [
  { id: "latin", label: "西文", lang: "en" },
  { id: "zh", label: "中文", lang: "zh-Hans" },
  { id: "ja", label: "日文", lang: "ja" },
  { id: "ko", label: "韩文", lang: "ko" },
];

export const SLOT_IDS: FontSlot[] = SLOTS.map((s) => s.id);

const SLOT_LANG: Record<FontSlot, string> = { latin: "en", zh: "zh-Hans", ja: "ja", ko: "ko" };

export function slotLang(slot: FontSlot): string {
  return SLOT_LANG[slot] ?? "en";
}

/** 字号倍率：1 = 设计稿原始大小 */
export const DEFAULT_SIZE = 1;
/** 字重：歌词正文默认粗体（中文只有 400/700 两档，取 700 才能和西文粗体对上） */
export const DEFAULT_WEIGHT = 700;
export const SIZE_RANGE: [number, number] = [0.7, 1.8];

/** 当前句相对其他句的放大倍率：1 = 不放大；默认 1.5（"正在唱的那句"要一眼看得出）。
 *  刻意用**字号**放大，而不是 transform: scale —— 后者先按原尺寸栅格化再放大，文字立刻发虚。 */
export const DEFAULT_ACTIVE_SCALE = 1.5;
export const ACTIVE_SCALE_RANGE: [number, number] = [1, 2];
export const ACTIVE_SCALE_KEY = "lyricActiveScale";

export const WEIGHT_OPTIONS: { value: number; label: string }[] = [
  { value: 300, label: "细" },
  { value: 400, label: "常规" },
  { value: 500, label: "中等" },
  { value: 700, label: "粗体" },
];

const UI_LATIN = [
  "Inter",
  '"Segoe UI"',
  "-apple-system",
  "BlinkMacSystemFont",
  '"Helvetica Neue"',
  "Arial",
];

/**
 * 各语言槽的系统 CJK 正体链（**本语言在前，别语言只当缺字兜底**）。
 *
 * ⚠️ 这里必须是四条链，不能像 0.4.5 那样四种语言共用一条。原因是 CSS 的 font-family 是
 * **逐字回退**：查到一个字该用哪款字体，是"从前往后第一个含该字形的字体"，与整行的语言无关。
 * 而汉字是中日韩共用码位，各款系统字体对"常用汉字"的覆盖并不相同：
 *   · Yu Gothic UI（日文正体）覆盖日文常用汉字，但**不含简体专用字**（说/过/话/这/们/时/间/爱/难…）；
 *   · Microsoft YaHei（中文正体）覆盖全部常用简繁汉字。
 * 共用一条链（旧链把 Yu Gothic UI 排在 Microsoft YaHei 之前）时，一行中文会被劈成两三种字体：
 * 日文正体覆盖得到的字用它、简体专用字落到后面的雅黑、再少见的落到 Malgun Gothic（韩文正体）。
 * 实测（Chromium + DirectWrite，本机真实链）：
 *   旧链 "说过的话都算数"  → Yu Gothic UI[4] + Microsoft YaHei[3]
 *   旧链 "这是我们的青春 时间都去哪儿了" → Segoe UI[1] + Yu Gothic UI[10] + Microsoft YaHei[4]
 *   新链（中文链）"说过的话都算数" → Microsoft YaHei[7]（单一字体）
 * 这正是用户报的"一行里两个字完全不是一款字体"。
 *
 * 排序原则：本语言正体（含同语族备份） → 邻近语言的 CJK 正体（只用来兜住本语言字体缺的字）。
 * 最后交给通用族 sans-serif：它按 lang 走系统 locale 映射，是最后的保险。
 */
const SYSTEM_CJK: Record<FontSlot, string[]> = {
  zh: [
    '"Microsoft YaHei"',
    '"Noto Sans SC"',
    '"Source Han Sans SC"',
    '"Noto Sans CJK SC"',
    '"PingFang SC"',
    '"Hiragino Sans GB"',
    "DengXian",
    '"Microsoft JhengHei"',
    "SimSun",
    '"Noto Sans CJK TC"',
    // 连中文系的字体都缺的字（生僻字/和制汉字…）才轮到日韩正体，顺序仍排在中文之后
    '"Yu Gothic UI"',
    "Meiryo",
    '"Malgun Gothic"',
  ],
  ja: [
    '"Yu Gothic UI"',
    '"Yu Gothic"',
    "Meiryo",
    '"MS Gothic"',
    '"Hiragino Kaku Gothic ProN"',
    '"Noto Sans CJK JP"',
    '"Microsoft YaHei"',
    '"Malgun Gothic"',
  ],
  ko: [
    '"Malgun Gothic"',
    '"Noto Sans CJK KR"',
    '"Apple SD Gothic Neo"',
    '"Microsoft YaHei"',
    '"Yu Gothic UI"',
  ],
  // 西文行不该出现汉字，但真出现时按中文处理（界面语言是中文），不要落进日文正体
  latin: ['"Microsoft YaHei"', '"Noto Sans SC"', '"Yu Gothic UI"'],
};

/** 某一行的系统兜底链：界面西文正体 → 该语言的语言正体 → 通用族 */
export function systemChainFor(slot: FontSlot): string[] {
  return [...UI_LATIN, ...(SYSTEM_CJK[slot] ?? SYSTEM_CJK.zh), "sans-serif"];
}

/* ============================ 语言匹配策略 ============================ */

/**
 * 语言匹配策略 —— 只影响**纯汉字行**（整行只有中日韩共用的汉字、没有任何语种证据）。
 *
 * consistent（默认，一致性优先）：纯汉字行一律按中文处理，不跟随整首歌的主语言。
 *    理由：汉字是中日韩共用码位，码位层面看不出语种。跟随 songSlot 意味着"一首中文歌里只要
 *    出现一句韩语/日语，全篇汉字都会换字体"—— 日文字体（Yu Gothic UI）与韩文字体
 *    （Malgun Gothic）的汉字字面比雅黑小 4–10%，缺简体字时再逐字回退，
 *    正是用户报的"一行里字体大小粗细不统一"。
 *    代价：日文歌的纯汉字行用中文正体，「直 / 骨 / 角」这类中日字形有差异的字略偏中文。
 *
 * accurate（准确优先，旧行为）：纯汉字行跟随 songSlot，日文字形更准；
 *    代价是夹了外语句的中文歌会整首换字体。
 */
export type MatchPolicy = "consistent" | "accurate";
export const MATCH_POLICY_KEY = "lyricFontMatch";

export function readMatchPolicy(values: Record<string, string | undefined>): MatchPolicy {
  return values[MATCH_POLICY_KEY] === "accurate" ? "accurate" : "consistent";
}

/* ============================ 读取设置 ============================ */

export function readSize(values: Record<string, string | undefined>): number {
  const n = Number(values["lyricFontSize"]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIZE;
  return Math.min(SIZE_RANGE[1], Math.max(SIZE_RANGE[0], n));
}

export function readActiveScale(values: Record<string, string | undefined>): number {
  const n = Number(values[ACTIVE_SCALE_KEY]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ACTIVE_SCALE;
  return Math.min(ACTIVE_SCALE_RANGE[1], Math.max(ACTIVE_SCALE_RANGE[0], n));
}

export function readWeight(values: Record<string, string | undefined>): number {
  const n = Number(values["lyricFontWeight"]);
  if (!Number.isFinite(n) || n < 100) return DEFAULT_WEIGHT;
  return Math.min(900, Math.max(100, n));
}

/* ============================ 语言判定 ============================ */

/**
 * 假名。刻意**排除**几个不承载语言信息的符号：
 *   U+30A0 ゠ 双连字符、U+30FB ・ 中点、U+30FC ー 长音，
 *   以及 U+3099/U+309A 两个组合浊点（它们只跟着假名出现，基字符已经命中）。
 * 中文行里也会出现「・」和「ー」（"A・B"、拖长的"好ーー"、装饰性长划）；
 * 旧范围 \u3040-\u30FF 把它们算作假名 → "出现即判定"会把整首歌判成日文，
 * 于是每一行纯汉字歌词都走日文字体栈（见 detectSongSlot / SYSTEM_CJK）。
 */
const RE_KANA =
  /[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/;
const RE_HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7FF]/;
const RE_HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;
const RE_LATIN = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
/**
 * 简体专用字（日文字体通常没有这些码位）——用来分辨"纯汉字行"是不是中文。
 * 只收「繁体正字在日文里也照用、而简体形日文不用」的字：会/学/国/体/医/万/与 这类
 * 日文新字体与中文简体同形的字**不能**收进来，否则日文行会被误判成中文。
 */
const RE_SIMPLIFIED = new RegExp(
  "[" +
    "说这们汉语听爱见电书车马鸟长发习广义术农单复买卖亚产亲亿优传让认计" +
    "论谢请谁过进远连选铁银错问阳队场极构权观规觉为带领张开关头门风飞龙" +
    "岁归变边双叶号台声举乡仅从们价众" +
    "]"
);
/** 和制汉字 / 日文专用字——出现就说明这行是日文 */
const RE_JP_KANJI = /[円駅沢畑辻込峠働畠榊]/;
/**
 * 繁体专用字——出现就说明这行是中文。
 * 刻意只收「繁体独有、且日文不用」的字：長/見/電/書/語/愛/風/東/頭 这些日文同样在用，
 * 收进来会把"纯汉字的日文行"误判成中文，所以排除在外。
 */
const RE_TRADITIONAL = /[說這們聽兒與學廣醫單賣亞產傳讓鐵權觀覺點麼樣實對應]/;

/**
 * 纯汉字行归谁。证据按可靠性排序：
 *   1. 和制汉字 → 日文；简/繁体专用字 → 中文（码位层面的硬证据）
 *   2. 同一时间戳的兄弟行是**别的文字**（假名 / 谚文 / 拉丁）→ 这一行是翻译 → 中文
 *   3. 都没有 → 按 policy 决定（见 MatchPolicy）：默认中文，准确优先才跟随整首歌的主语言
 *
 * ⚠️ 第 2 条原先只认假名（想着"日文歌的中文翻译"），于是**韩文歌**的纯汉字翻译行三条证据
 * 全不成立，一路落到 songSlot = ko → 拿韩文字体去渲染中文：韩文字体只覆盖常用汉字（Hanja），
 * 覆盖到的字生效、覆盖不到的掉系统正体 —— 正是用户看到的"有的字用了设置的字体、有的没有"。
 * 现在把谚文 / 拉丁也算进来（韩文歌、英文歌的翻译行同理）。
 *
 * ⚠️ 第 3 条原先无条件跟随 songSlot。问题是**纯汉字行在码位层面根本没有语种信息**：
 * 《红蔷薇白玫瑰》里一句「사랑해」让整首歌的主语言变成 ko，于是 44 行纯汉字歌词全部
 * 走韩文字体栈（Malgun Gothic 汉字墨迹高 40px vs 雅黑 44px），用户看到的就是"大小粗细不一"。
 * 现在默认按中文处理（一致性优先）：这类歌即使夹了外语，汉字行也不会换字体。
 */
function hanLineSlot(
  text: string,
  songSlot: FontSlot | null,
  groupHasOtherScript: boolean,
  policy: MatchPolicy
): FontSlot {
  if (RE_JP_KANJI.test(text)) return "ja";
  if (RE_SIMPLIFIED.test(text) || RE_TRADITIONAL.test(text)) return "zh";
  if (groupHasOtherScript) return "zh";
  // 走到这里 = 整行只有中日韩共用的汉字，没有任何语种证据。
  if (policy === "accurate") return songSlot ?? "zh";
  return "zh";
}

/**
 * 一行属于哪个语言槽。
 * @param siblings 同一时间戳的其它行（用于识别"原词 + 翻译"）
 * @param policy 纯汉字行的归属策略（见 MatchPolicy），默认一致性优先
 */
export function detectLineSlot(
  text: string,
  songSlot: FontSlot | null,
  siblings: string[] = [],
  policy: MatchPolicy = "consistent"
): FontSlot {
  if (RE_KANA.test(text)) return "ja";
  if (RE_HANGUL.test(text)) return "ko";
  if (RE_HAN.test(text)) {
    // 兄弟行只要不是汉字（假名 / 谚文 / 拉丁），这一行就大概率是"翻译"那一行
    const groupHasOtherScript = siblings.some(
      (t) => RE_KANA.test(t) || RE_HANGUL.test(t) || RE_LATIN.test(t)
    );
    return hanLineSlot(text, songSlot, groupHasOtherScript, policy);
  }
  if (RE_LATIN.test(text)) return "latin";
  return songSlot ?? "latin";
}

/**
 * 整首歌的主语言（决定"没设置的槽"跟随谁）。两类信号分开处理：
 *   谚文 / 假名 —— 都按密度判定（见函数内注释）：出现即判定会把"夹了一句日文或韩语
 *           的中文歌"整首判成日文/韩文，中文行随之全部走日文/韩文字体。
 */
export function detectSongSlot(texts: string[]): FontSlot | null {
  let kana = 0;
  let hangul = 0;
  let han = 0;
  let latin = 0;
  for (const t of texts) {
    for (const ch of t) {
      if (RE_KANA.test(ch)) kana++;
      else if (RE_HANGUL.test(ch)) hangul++;
      else if (RE_HAN.test(ch)) han++;
      else if (RE_LATIN.test(ch)) latin++;
    }
  }
  // 谚文同假名，按密度判定，不是"出现即判定"。
  // 反例：《红蔷薇白玫瑰》结尾有一句「사랑해 사랑해」，出现即判定会让整首判成韩文，
  // 每一行纯汉字歌词都落到韩文字体栈 —— Malgun Gothic 的汉字字面比雅黑小一成
  // （实测 44px 下墨迹高 40 vs 44，「己」「口」「至」还要更矮），正是"大小粗细不统一"。
  // 韩文歌谚文密度通常 50% 以上；夹一句的中文歌会被大量汉字稀释到 2% 以下。
  // 阈值取 30%：两头都留足余量，短样本（三四行）也不至于被一句韩语带偏。
  if (hangul >= 3 && hangul / (hangul + han + latin) >= 0.3) return "ko";
  // 假名按**密度**判定，不是"出现即判定"：中文歌里偶尔夹一句日文（或翻译里带假名）时，
  // 整首歌不该被判成日文 —— 那样每一行纯汉字歌词都会走日文字体栈，简体字再逐字回退到
  // 雅黑，一行里两种字体、两种字号、两种笔画（用户报的"粗细大小不统一"）。
  // 日文歌的假名密度通常 20% 以上；中文歌夹一两句时会被大量汉字稀释到 1% 以下。
  if (kana >= 3 && kana / (kana + han + latin) >= 0.1) return "ja";
  if (han) return "zh";
  if (latin) return "latin";
  return null;
}

/** 整首歌的每一行归哪个槽（groups 为"同一时间戳"的行号分组，用于翻译行判定） */
/** 整首歌的每一行归哪个槽（groups 为"同一时间戳"的行号分组，用于翻译行判定） */
export function detectLineSlots(
  texts: string[],
  songSlot: FontSlot | null,
  groups?: number[][],
  policy: MatchPolicy = "consistent"
): FontSlot[] {
  const siblingOf = new Map<number, number[]>();
  if (groups) {
    for (const g of groups) for (const i of g) siblingOf.set(i, g);
  }
  return texts.map((text, i) => {
    const g = siblingOf.get(i);
    const siblings = g ? g.filter((j) => j !== i).map((j) => texts[j] ?? "") : [];
    return detectLineSlot(text, songSlot, siblings, policy);
  });
}

/* ============================ 字体栈 ============================ */

/** 某一行的字体栈：该语言的系统正体链（规则见 systemChainFor 上面的实测注释） */
export function fontStackFor(slot: FontSlot): string {
  return systemChainFor(slot).join(", ");
}

export interface LyricFontStacks {
  /** 每个语言槽的完整字体栈 */
  bySlot: Record<FontSlot, string>;
  /** 主语言栈（兼容老设置里的 --lyric-font） */
  primary: string;
}

export function lyricFontStacks(songSlot: FontSlot | null): LyricFontStacks {
  const bySlot = {} as Record<FontSlot, string>;
  for (const s of SLOT_IDS) bySlot[s] = fontStackFor(s);
  return { bySlot, primary: bySlot[songSlot ?? "latin"] };
}
