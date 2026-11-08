// 曲库歌词体检的**计算**部分（npm run check:lyrics 的纯函数入口）。
//
// 为什么要有这个文件：语言判定 + 字体槽全是纯函数，但"这两首歌为什么一行里两种字体"
// 在界面上看不出来。把判定结果按**整个曲库**摊开，异常会自己跳出来。
//
// 分工：
//   · 本文件（vite 打包后跑在 Node）：只做判定与统计，不碰文件系统；
//   · scripts/check-lyrics.mjs：读库、找音频、抽标签、提取歌词文本，再把文本交进来。
//
// ⚠️ 下面这几个 RE_* 与 src/lib/lyricFont.ts 里的同源，但它们**只用于写问题判据**
//    （"这一行明明是纯汉字，为什么落到了日文槽"），行归属的结论一律来自 lyricFont。
import { detectLineSlots, detectSongSlot } from "../src/lib/lyricFont";
import type { FontSlot, MatchPolicy } from "../src/lib/lyricFont";

const RE_KANA = /[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/;
const RE_HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7FF]/;
const RE_HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;
const RE_LATIN = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
const RE_JP_KANJI = /[円駅沢畑辻込峠働畠榊]/;
const RE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\uFEFF]/;

export type IssueLevel = "error" | "warn" | "info";

export interface Issue {
  level: IssueLevel;
  code: string;
  detail: string;
}

export interface CharStat {
  han: number;
  kana: number;
  hangul: number;
  latin: number;
  other: number;
}

export interface LyricReport {
  songSlot: FontSlot | null;
  /** 每个槽分到多少行 */
  slots: Record<FontSlot, number>;
  /** 与输入 texts 一一对应的行槽 */
  lineSlots: FontSlot[];
  /** 唯一的主导槽（CJK 三槽里行数最多的那个） */
  dominant: FontSlot | null;
  chars: CharStat;
  issues: Issue[];
}

export const SLOT_ORDER: FontSlot[] = ["latin", "zh", "ja", "ko"];

/** 拆字统计：只用于展示与判据，不参与行归属 */
export function charStat(texts: string[]): CharStat {
  const s: CharStat = { han: 0, kana: 0, hangul: 0, latin: 0, other: 0 };
  for (const t of texts) {
    for (const ch of t) {
      if (RE_KANA.test(ch)) s.kana++;
      else if (RE_HANGUL.test(ch)) s.hangul++;
      else if (RE_HAN.test(ch)) s.han++;
      else if (RE_LATIN.test(ch)) s.latin++;
      else s.other++;
    }
  }
  return s;
}

/** 有没有"字库覆盖风险"的码位：扩展区 / 兼容区 / 私用区 / 替换字符 */
export function unusualCodepoints(texts: string[]): { cp: number; ch: string }[] {
  const out: { cp: number; ch: string }[] = [];
  const seen = new Set<number>();
  for (const t of texts) {
    for (const ch of t) {
      const cp = ch.codePointAt(0);
      if (cp == null || seen.has(cp)) continue;
      const odd =
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xe000 && cp <= 0xf8ff) ||
        cp >= 0x20000 ||
        cp === 0xfffd;
      if (odd) {
        seen.add(cp);
        out.push({ cp, ch });
      }
    }
  }
  return out;
}

/**
 * 一首歌的体检。texts 是**已去掉时间戳**的歌词行，groups 是同一时间戳的行号分组
 * （与播放器一致，用于识别"原词 + 翻译"）。
 */
export function analyzeLyrics(
  texts: string[],
  groups: number[][],
  policy: MatchPolicy = "consistent"
): LyricReport {
  const songSlot = detectSongSlot(texts);
  const lineSlots = detectLineSlots(texts, songSlot, groups, policy);
  const slots: Record<FontSlot, number> = { latin: 0, zh: 0, ja: 0, ko: 0 };
  for (const s of lineSlots) slots[s]++;
  const chars = charStat(texts);
  const issues: Issue[] = [];

  const cjk = slots.zh + slots.ja + slots.ko;
  let dominant: FontSlot | null = null;
  let best = -1;
  for (const s of ["zh", "ja", "ko"] as FontSlot[]) {
    if (slots[s] > best) {
      best = slots[s];
      dominant = s;
    }
  }
  if (best <= 0) dominant = null;

  // ---- 1) 一致性问题的定义式检查：纯汉字行**不该**落到日文 / 韩文槽 ----
  // 这是用户报的那一类问题的判据。策略为准确优先时它会成批出现，那是预期行为，降级为 info。
  const stray: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const slot = lineSlots[i];
    if (slot !== "ja" && slot !== "ko") continue;
    if (RE_KANA.test(t) || RE_HANGUL.test(t) || RE_JP_KANJI.test(t)) continue;
    stray.push((stray.length < 3 ? "" : "") + t.trim());
  }
  if (stray.length) {
    const list = stray.slice(0, 3).map((s) => "「" + s + "」").join(" ");
    issues.push({
      level: policy === "accurate" ? "info" : "error",
      code: "han-on-foreign-slot",
      detail:
        stray.length +
        " 行纯汉字歌词落到了日文/韩文槽" +
        (policy === "accurate"
          ? "（准确优先下这是预期：跟随整首主语言）"
          : "（一致性优先下不该出现，判定有 bug）") +
        " 例：" +
        list,
    });
  }

  // ---- 2) 跨行换字体：同一首歌的汉字槽不止一个 ----
  // 汉字是中日韩共用码位。一旦行归属跨了 zh / ja / ko，切行时字号与笔画粗细就会跳
  //（Windows 实测同句墨迹高：雅黑约 42-43px、Yu Gothic UI 约 41-43px 但笔画更细且缺简体字、
  //  Malgun Gothic 约 40px）。这是「一整首里有几行字明显不一样」的判据；行内混排由第 1 条负责。
  const cjkSlots = (["zh", "ja", "ko"] as FontSlot[]).filter((s) => slots[s] > 0);
  if (cjkSlots.length > 1) {
    const parts = cjkSlots
      .map((s) => s + " " + slots[s] + " 行(" + Math.round((slots[s] / Math.max(1, cjk)) * 100) + "%)")
      .join(" · ");
    const minor = cjkSlots.filter((s) => s !== (dominant ?? "zh"));
    const minorShare = Math.max(...minor.map((s) => slots[s])) / Math.max(1, cjk);
    // 原词 + 翻译的双语歌词会严格交替（ja zh ja zh …）。此时两种文字本来就该用两种字体，
    // 属于正常排版；真正要看的是「满篇同一种槽，零星几行突然换掉」。
    const seq = lineSlots.filter((s) => s === "zh" || s === "ja" || s === "ko");
    let flips = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) flips++;
    const flipRate = seq.length > 1 ? flips / (seq.length - 1) : 0;
    const alternating = cjkSlots.length === 2 && flipRate > 0.6;
    issues.push({
      level: alternating ? "info" : minorShare >= 0.2 ? "warn" : "info",
      code: alternating ? "bilingual-alternating" : "cross-font-switch",
      detail:
        "同一首歌跨了 " +
        cjkSlots.length +
        " 个汉字字体槽（" +
        parts +
        "，相邻行换槽率 " +
        Math.round(flipRate * 100) +
        "%）" +
        (alternating
          ? "：原词与翻译交替，属双语歌词正常排版"
          : "，切行时字号/笔画会跳") +
        (songSlot && dominant && dominant !== songSlot && !alternating
          ? "；主语言判定 " + songSlot + " 与主导槽 " + dominant + " 不一致"
          : ""),
    });
  }

  // ---- 4) 主语言判定偏弱：假名/谚文密度低但被判成 ja/ko ----
  {
    const cjkChars = chars.han + chars.kana + chars.hangul;
    if (songSlot === "ja" && cjkChars > 80 && chars.kana / cjkChars < 0.2) {
      issues.push({
        level: "info",
        code: "weak-ja",
        detail: "判成日文，但假名只占 " + Math.round((100 * chars.kana) / cjkChars) + "%（汉字 " + chars.han + " 个）",
      });
    }
    if (songSlot === "ko" && cjkChars > 80 && chars.hangul / cjkChars < 0.1) {
      issues.push({
        level: "info",
        code: "weak-ko",
        detail: "判成韩文，但谚文只占 " + Math.round((100 * chars.hangul) / cjkChars) + "%（汉字 " + chars.han + " 个）",
      });
    }
  }

  // ---- 5) 字库覆盖风险：扩展区 / 兼容区 / 私用区 ----
  {
    const odd = unusualCodepoints(texts);
    const pua = odd.filter((o) => o.cp >= 0xe000 && o.cp <= 0xf8ff);
    const repl = odd.filter((o) => o.cp === 0xfffd);
    if (repl.length) {
      issues.push({
        level: "error",
        code: "decode-loss",
        detail: "含 " + repl.length + " 个 U+FFFD 替换字符 —— 歌词文件编码有问题（原文件多半是 GBK），文字已经丢了",
      });
    }
    if (pua.length) {
      issues.push({
        level: "warn",
        code: "private-use",
        detail: "含私用区字符 " + pua.map((o) => "U+" + o.cp.toString(16).toUpperCase()).join(" ") + "：任何系统字体都不覆盖",
      });
    }
    const rare = odd.filter((o) => o.cp !== 0xfffd && !(o.cp >= 0xe000 && o.cp <= 0xf8ff));
    if (rare.length) {
      issues.push({
        level: "info",
        code: "rare-codepoint",
        detail:
          "含 " +
          rare.length +
          " 个扩展/兼容区字符（" +
          rare.slice(0, 6).map((o) => o.ch).join("") +
          "）：常见字库覆盖不到，会逐字回退",
      });
    }
  }

  // ---- 6) 控制字符 / 零宽字符：看不见但会撑大行宽、破坏逐字歌词对齐 ----
  {
    const bad = new Set<string>();
    for (const t of texts) for (const ch of t) if (RE_CONTROL.test(ch)) bad.add(ch);
    if (bad.size) {
      issues.push({
        level: "info",
        code: "invisible-chars",
        detail:
          "含 " +
          bad.size +
          " 种不可见字符（" +
          [...bad].map((c) => "U+" + (c.codePointAt(0) ?? 0).toString(16).toUpperCase()).join(" ") +
          "）",
      });
    }
  }

  // ---- 7) 歌词本身太空 ----
  {
    const solid = texts.filter((t) => t.trim().length > 0).length;
    if (solid === 0) {
      issues.push({ level: "warn", code: "empty", detail: "没有任何歌词文本" });
    } else if (solid === 1) {
      issues.push({ level: "info", code: "single-line", detail: "只有 1 行歌词" });
    } else if (solid / texts.length < 0.5) {
      issues.push({
        level: "info",
        code: "sparse",
        detail: "空行占 " + Math.round(100 - (100 * solid) / texts.length) + "%",
      });
    }
  }

  return { songSlot, slots, lineSlots, dominant, chars, issues };
}

export function run(): number {
  // 自检：不读库，只验"判定 → 报告"这条链本身是通的（runner 会再用真曲库跑一遍）
  const cases: { name: string; texts: string[]; want: FontSlot | null }[] = [
    { name: "中文歌", texts: ["山有木兮木有枝", "心悦君兮君不知"], want: "zh" },
    { name: "日文歌", texts: ["君の名は", "夜に駆ける"], want: "ja" },
    { name: "韩文歌", texts: ["사랑해요", "그대여"], want: "ko" },
    { name: "中文歌夹韩语", texts: ["사랑해 사랑해", "也看到天真的自己", "连我自己都很惊讶"], want: "zh" },
  ];
  let fail = 0;
  for (const c of cases) {
    const r = analyzeLyrics(c.texts, []);
    if (r.songSlot !== c.want) {
      console.log("FAIL " + c.name + " songSlot=" + r.songSlot + " want=" + c.want);
      fail++;
    }
    const hard = r.issues.filter((i) => i.level === "error");
    if (hard.length) {
      console.log("FAIL " + c.name + " 有 error 级问题：" + hard.map((i) => i.code).join(","));
      fail++;
    }
  }
  // 《红蔷薇白玫瑰》回归：夹一句韩语的中文歌，纯汉字行必须全部落在 zh
  const rose = analyzeLyrics(
    ["사람해 사랑해", "说不出说不出一句话", "也看到天真的自己", "月亮会一直带领"],
    [[0], [1], [2], [3]]
  );
  const strayHan = rose.lineSlots.filter((s, i) => s !== "zh" && i > 0);
  if (strayHan.length) {
    console.log("FAIL 红蔷薇白玫瑰：纯汉字行仍跑到别的槽 " + JSON.stringify(rose.lineSlots));
    fail++;
  }
  console.log("自检：" + (fail ? "失败 " + fail : "通过"));
  return fail;
}
