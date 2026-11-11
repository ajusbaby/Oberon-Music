// 曲库歌词体检的**计算**部分（npm run check:lyrics 的纯函数入口）。
//
// 为什么要有这个文件：语言判定 + 字体档案全是纯函数，但"这两首歌为什么一行里两种字体"
// 在界面上看不出来。把判定结果按**整个曲库**摊开，异常会自己跳出来。
//
// 分工：
//   · 本文件（vite 打包后跑在 Node）：只做判定与统计，不碰文件系统；
//   · scripts/check-lyrics.mjs：读库、找音频、抽标签、提取歌词文本，再把文本交进来。
//
// ⚠️ 下面这几个 RE_* 与 src/lib/lyricFont.ts 里的同源，但它们**只用于写问题判据**
//    （"这一行明明是纯汉字，为什么落到了日文档案"），行归属的结论一律来自 lyricFont。
import { PROFILE_IDS, detectLineProfiles, detectSongProfile } from "../src/lib/lyricFont";
import type { FontProfileId, MatchPolicy } from "../src/lib/lyricFont";
import { layoutLyricLines, scriptClass } from "../src/lib/lyricLines";

// runner（scripts/check-lyrics.mjs）也要用同一套分组与文字体系判定 —— 单一实现，两边共调
export { layoutLyricLines, scriptClass };

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
  /** 整首歌被判到的档案 */
  songProfile: FontProfileId | null;
  /** 每个档案分到多少行 */
  profiles: Record<FontProfileId, number>;
  /** 与输入 texts 一一对应的行档案 */
  lineProfiles: FontProfileId[];
  /** 汉字系档案里行数最多的那个（zhHans / zhHant / ja / ko） */
  dominant: FontProfileId | null;
  /** 识别出的翻译行数（原词 + 翻译的双语歌词） */
  translationLines: number;
  chars: CharStat;
  issues: Issue[];
}

export const PROFILE_ORDER: FontProfileId[] = [...PROFILE_IDS];
/** 汉字系档案：它们之间互相竞争，也是"切行换字体"的唯一来源 */
export const CJK_PROFILES: FontProfileId[] = ["zhHans", "zhHant", "ja", "ko"];

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
 * 一首歌的体检。texts 是**已去掉时间戳**的歌词行，groups 是显示分组
 * （与播放器一致，来自 lib/lyricLines.layoutLyricLines），translation 是翻译行位图。
 *
 * 翻译行必须剔除在整首语言判定之外：翻译用什么文字是译者选的，不是这首歌的语言。
 * 不剔除的话《王的归来（I'm King）》这类中韩双语歌词会被翻译行拉成中文。
 */
export function analyzeLyrics(
  texts: string[],
  groups: number[][],
  policy: MatchPolicy = "consistent",
  translation?: readonly boolean[]
): LyricReport {
  const songProfile = detectSongProfile(texts, translation);
  const trCount = translation ? translation.filter(Boolean).length : 0;
  const lineProfiles = detectLineProfiles(texts, songProfile, policy, groups, translation);
  const profiles = {} as Record<FontProfileId, number>;
  for (const id of PROFILE_IDS) profiles[id] = 0;
  for (const p of lineProfiles) profiles[p]++;
  const chars = charStat(texts);
  const issues: Issue[] = [];

  const cjk = CJK_PROFILES.reduce((n, id) => n + profiles[id], 0);
  let dominant: FontProfileId | null = null;
  let best = -1;
  for (const id of CJK_PROFILES) {
    if (profiles[id] > best) {
      best = profiles[id];
      dominant = id;
    }
  }
  if (best <= 0) dominant = null;

  // ---- 0) 双语歌词：翻译行已识别并剔除 ----
  // 一条歌词 = 原词 + 它的翻译。翻译行的时间戳通常比原词晚几秒（不是同一时间戳），
  // 旧逻辑会把它们当成独立歌词行：显示上字数翻倍，判定上把整首语言带偏。
  if (trCount) {
    const naive = detectSongProfile(texts);
    issues.push({
      level: "info",
      code: "translation-paired",
      detail:
        trCount +
        " 行是翻译行（原词 + 翻译），已从整首语言判定中剔除；整首判成 " +
        songProfile,
    });
    if (naive !== songProfile) {
      issues.push({
        level: "info",
        code: "translation-shifted-profile",
        detail: "若不剔除翻译行，整首会被判成 " + naive + " —— 这类歌词最容易踩的坑",
      });
    }
  }

  // ---- 1) 一致性问题的定义式检查：纯汉字行**不该**落到日文 / 韩文档案 ----
  // 这是用户报的那一类问题的判据。策略为准确优先时它会成批出现，那是预期行为，降级为 info。
  const stray: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const profile = lineProfiles[i];
    if (profile !== "ja" && profile !== "ko") continue;
    if (RE_KANA.test(t) || RE_HANGUL.test(t) || RE_JP_KANJI.test(t)) continue;
    stray.push(t.trim());
  }
  if (stray.length) {
    const list = stray.slice(0, 3).map((s) => "「" + s + "」").join(" ");
    issues.push({
      level: policy === "accurate" ? "info" : "error",
      code: "han-on-foreign-profile",
      detail:
        stray.length +
        " 行纯汉字歌词落到了日文/韩文档案" +
        (policy === "accurate"
          ? "（逐行判定下这是预期：跟随整首主语言）"
          : "（整首一致策略下不该出现，判定有 bug）") +
        " 例：" +
        list,
    });
  }

  // ---- 2) 跨行换字体：同一首歌的汉字系档案不止一个 ----
  // 汉字是中日韩共用码位。一旦行归属跨了 zhHans / zhHant / ja / ko，切行时字号与笔画粗细就会跳
  //（Windows 实测同句墨迹高：雅黑约 42-43px、Yu Gothic UI 约 41-43px 但笔画更细且缺简体字、
  //  Malgun Gothic 约 40px）。这是「一整首里有几行字明显不一样」的判据；行内混排由第 1 条负责。
  // 只统计"确实在排汉字行"的档案：一首中文歌里夹的韩语段落（谚文行）本来就该用韩文字体，
  // 那不是换字体问题，是两种文字各用各的字体。
  const hanLineCount = {} as Record<FontProfileId, number>;
  for (const id of PROFILE_IDS) hanLineCount[id] = 0;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (translation && translation[i]) continue; // 翻译行不是唱出来的词，不计入换字体统计
    if (!RE_HAN.test(t) || RE_KANA.test(t) || RE_HANGUL.test(t)) continue;
    hanLineCount[lineProfiles[i]]++;
  }
  const cjkProfiles = CJK_PROFILES.filter(
    (id) => profiles[id] > 0 && (hanLineCount[id] > 0 || id === "zhHans" || id === "zhHant"),
  );
  if (cjkProfiles.length > 1) {
    const parts = cjkProfiles
      .map((id) => id + " " + profiles[id] + " 行(" + Math.round((profiles[id] / Math.max(1, cjk)) * 100) + "%)")
      .join(" · ");
    const minor = cjkProfiles.filter((id) => id !== (dominant ?? "zhHans"));
    const minorShare = Math.max(...minor.map((id) => profiles[id])) / Math.max(1, cjk);
    // 原词 + 翻译的双语歌词会严格交替（ja zh ja zh …）。此时两种文字本来就该用两种字体，
    // 属于正常排版；真正要看的是「满篇同一种档案，零星几行突然换掉」。
    const seq = lineProfiles.filter(
      (p, i) => CJK_PROFILES.includes(p) && !(translation && translation[i]),
    );
    let flips = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) flips++;
    const flipRate = seq.length > 1 ? flips / (seq.length - 1) : 0;
    const alternating = cjkProfiles.length === 2 && flipRate > 0.6;
    // 逐行判定下跨档案是预期结果（双语歌词、日文歌里的中文翻译），永远只算提示
    const level: IssueLevel =
      policy === "accurate" ? "info" : alternating ? "info" : minorShare >= 0.2 ? "warn" : "info";
    issues.push({
      level,
      code: alternating ? "bilingual-alternating" : "cross-font-switch",
      detail:
        "同一首歌跨了 " +
        cjkProfiles.length +
        " 个汉字档案（" +
        parts +
        "，相邻行换档案率 " +
        Math.round(flipRate * 100) +
        "%）" +
        (alternating
          ? "：原词与翻译交替，属双语歌词正常排版"
          : "，切行时字号/笔画会跳") +
        (dominant && dominant !== songProfile && !alternating
          ? "；主语言判定 " + songProfile + " 与主导档案 " + dominant + " 不一致"
          : ""),
    });
  }

  // ---- 4) 主语言判定偏弱：假名/谚文密度低但被判成 ja/ko ----
  {
    const cjkChars = chars.han + chars.kana + chars.hangul;
    if (songProfile === "ja" && cjkChars > 80 && chars.kana / cjkChars < 0.2) {
      issues.push({
        level: "info",
        code: "weak-ja",
        detail: "判成日文，但假名只占 " + Math.round((100 * chars.kana) / cjkChars) + "%（汉字 " + chars.han + " 个）",
      });
    }
    if (songProfile === "ko" && cjkChars > 80 && chars.hangul / cjkChars < 0.1) {
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

  return { songProfile, profiles, lineProfiles, dominant, translationLines: trCount, chars, issues };
}

export function run(): number {
  // 自检：不读库，只验"判定 → 报告"这条链本身是通的（runner 会再用真曲库跑一遍）
  const cases: { name: string; texts: string[]; want: FontProfileId }[] = [
    { name: "中文歌", texts: ["山有木兮木有枝", "心悦君兮君不知"], want: "zhHans" },
    { name: "日文歌", texts: ["君の名は", "夜に駆ける"], want: "ja" },
    { name: "韩文歌", texts: ["사랑해요", "그대여"], want: "ko" },
    { name: "繁体歌", texts: ["我們這樣的人", "這就是答案"], want: "zhHant" },
    { name: "中文歌夹韩语", texts: ["사랑해 사랑해", "也看到天真的自己", "连我自己都很惊讶"], want: "zhHans" },
  ];
  let fail = 0;
  for (const c of cases) {
    const r = analyzeLyrics(c.texts, []);
    if (r.songProfile !== c.want) {
      console.log("FAIL " + c.name + " songProfile=" + r.songProfile + " want=" + c.want);
      fail++;
    }
    const hard = r.issues.filter((i) => i.level === "error");
    if (hard.length) {
      console.log("FAIL " + c.name + " 有 error 级问题：" + hard.map((i) => i.code).join(","));
      fail++;
    }
  }
  // 《红蔷薇白玫瑰》回归：夹一句韩语的中文歌，纯汉字行必须全部落在简体中文
  const rose = analyzeLyrics(
    ["사람해 사랑해", "说不出说不出一句话", "也看到天真的自己", "月亮会一直带领"],
    [[0], [1], [2], [3]]
  );
  const strayHan = rose.lineProfiles.filter((p, i) => p !== "zhHans" && i > 0);
  if (strayHan.length) {
    console.log("FAIL 红蔷薇白玫瑰：纯汉字行仍跑到别的档案 " + JSON.stringify(rose.lineProfiles));
    fail++;
  }
  // ---- 《王的归来（I'm King）》回归：翻译行时间戳比原词晚几秒 ----
  // 真实数据：103 行中韩逐行交错，翻译行时间戳晚 0.33～12.07 秒。旧逻辑按"时间戳相等"分组，
  // 一行都没配上 → 显示密度翻倍、谚文占比被汉字翻译压到 38%（差点把整首判成中文）。
  {
    const king = [
      { timeMs: 2010, text: "어둠 속에 남아 있는 my story" },
      { timeMs: 5440, text: "黑暗中残存的 我的故事" },
      { timeMs: 10960, text: "짓눌린 왕관의 무게는 so heavy" },
      { timeMs: 12330, text: "被压垮的王冠 如此沉重" },
      { timeMs: 15830, text: "그 이름 King, 지워진 진실" },
      { timeMs: 16350, text: "那名字 King，被抹去的真相" },
      { timeMs: 17700, text: "I'm King, do you remember me?" },
      { timeMs: 22150, text: "我是 King，你还记得我吗？" },
    ];
    const lay = layoutLyricLines(king);
    const texts = king.map((l) => l.text);
    if (lay.groups.length !== 4) {
      console.log("FAIL 王的归来：应分成 4 个显示块，实际 " + lay.groups.length + " " + JSON.stringify(lay.groups));
      fail++;
    }
    const trCount = lay.translation.filter(Boolean).length;
    if (trCount !== 4) {
      console.log("FAIL 王的归来：应认出 4 行翻译，实际 " + trCount);
      fail++;
    }
    const r = analyzeLyrics(texts, lay.groups, "consistent", lay.translation);
    if (r.songProfile !== "ko") {
      console.log("FAIL 王的归来：整首应判 ko，实际 " + r.songProfile);
      fail++;
    }
    if (r.translationLines !== 4) {
      console.log("FAIL 王的归来：报告里 translationLines=" + r.translationLines);
      fail++;
    }
    // 剔除前确实会判错 —— 这正是这条规则存在的理由
    const naive = detectSongProfile(texts);
    if (naive !== "ko") {
      console.log("FAIL 王的归来：这条样本本来应该能复现误判（naive=" + naive + "），样本不再有效");
      fail++;
    }
  }

  // ---- 反例 1：没有翻译的韩文歌，不能凭空配对 ----
  {
    const ko = [
      { timeMs: 1000, text: "사랑해요 그대여" },
      { timeMs: 4000, text: "오늘도 나는 여기" },
      { timeMs: 7000, text: "기다리고 있어" },
      { timeMs: 10000, text: "다시 만날 그날까지" },
    ];
    const lay = layoutLyricLines(ko);
    if (lay.paired !== 0 || lay.groups.length !== 4) {
      console.log("FAIL 反例1：纯韩文歌被误配对 paired=" + lay.paired + " groups=" + lay.groups.length);
      fail++;
    }
  }

  // ---- 反例 2：韩英交替的真双语歌（英文行不是中文翻译）→ 不配对 ----
  {
    const mixed = [
      { timeMs: 1000, text: "사랑해요 그대여" },
      { timeMs: 2000, text: "I love you baby" },
      { timeMs: 3000, text: "오늘도 나는 여기" },
      { timeMs: 4000, text: "I'm waiting here" },
      { timeMs: 5000, text: "다시 만날 그날까지" },
      { timeMs: 6000, text: "Until we meet again" },
    ];
    const lay = layoutLyricLines(mixed);
    if (lay.paired !== 0) {
      console.log("FAIL 反例2：韩英交替被当成翻译 paired=" + lay.paired);
      fail++;
    }
  }

  // ---- 反例 3：中文歌里连续两行汉字（原文 + 中文注释）→ 分不清谁是谁的翻译，不猜 ----
  {
    const zh = [
      { timeMs: 1000, text: "山有木兮木有枝" },
      { timeMs: 2000, text: "心悦君兮君不知" },
      { timeMs: 3000, text: "今夕何夕兮" },
      { timeMs: 4000, text: "得与王子同舟" },
    ];
    const lay = layoutLyricLines(zh);
    if (lay.paired !== 0) {
      console.log("FAIL 反例3：中文歌被误配对 paired=" + lay.paired);
      fail++;
    }
  }

  // ---- 同一时间戳的双语歌词（英文歌常见）仍然照旧成组，且翻译行不参与判定 ----
  {
    const en = [
      { timeMs: 1000, text: "Hello from the other side" },
      { timeMs: 1000, text: "来自彼岸的问候" },
      { timeMs: 5000, text: "I must have called a thousand times" },
      { timeMs: 5000, text: "我大概呼唤了上千次" },
    ];
    const lay = layoutLyricLines(en);
    if (lay.groups.length !== 2 || lay.translation.filter(Boolean).length !== 2) {
      console.log("FAIL 同时间戳双语：groups=" + lay.groups.length + " tr=" + lay.translation.filter(Boolean).length);
      fail++;
    }
    const r = analyzeLyrics(en.map((l) => l.text), lay.groups, "consistent", lay.translation);
    if (r.songProfile !== "latin") {
      console.log("FAIL 同时间戳双语：整首应判 latin，实际 " + r.songProfile);
      fail++;
    }
  }

  // ---- 纯文本歌词（无时间轴）：每行各自成组，不能把整段塞进一个块 ----
  {
    const plain = [
      { timeMs: 0, text: "第一行" },
      { timeMs: 0, text: "第二行" },
      { timeMs: 0, text: "第三行" },
    ];
    const lay = layoutLyricLines(plain, false);
    if (lay.groups.length !== 3 || lay.translation.some(Boolean)) {
      console.log("FAIL 纯文本歌词分组：" + JSON.stringify(lay.groups));
      fail++;
    }
  }

  console.log("自检：" + (fail ? "失败 " + fail : "通过"));
  return fail;
}
