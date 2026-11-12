// 歌词行分组：「原词 + 翻译」的识别规则。
//
// 为什么单独一个文件：一首双语歌词里翻译行**不是一条歌词**——它没有自己的演唱时间，
// 只是挂在上一句下面的注解。播放器要把它和原词当成同一个显示块（LyricsPage 的 .sl-g），
// 整首语言判定也不能让它参与（lyricFont 的 detectSongProfile 会跳过翻译行）。
// 这两件事必须用同一套规则，所以规则放这里：React 调一次，Node 体检脚本（check:lyrics）也调一次。
//
// 两种双语歌词都要认：
//   ① 同一时间戳：[00:12.00]原文 / [00:12.00]翻译           → 时间戳相等就能成组（旧行为）
//   ② 时间戳不同：[00:02.01]原文 / [00:05.44]翻译           → 靠"原词 + 紧跟一行汉字"的结构认（本文件新增）
//
// ② 是用户报的那一类问题（《王的归来（I'm King）》）：翻译行各自带着 0.3~12 秒后的时间戳，
// 于是被当成 103 条独立歌词行——字数翻倍、翻译被算进整首语言判定（那首歌谚文占比一度只有 24%，
// 再长一点的翻译就会把整首判成简体中文，韩文行全靠逐行判定兜着，字体在两种语言间来回跳）。

/** 只取歌词行需要的两个字段：时间（毫秒）与文本 */
export interface TimedLyricLine {
  timeMs: number;
  text: string;
}

/** 一行的主要文字体系。优先级 = 专属文字优先（假名 > 谚文 > 汉字 > 拉丁）。 */
export type ScriptClass = "kana" | "hangul" | "han" | "latin" | "other";

// 与 lyricFont.ts 的同源正则保持一致（那边是 global 版，用于计数；这里只要"有没有"）
const RE_KANA = /[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/;
const RE_HANGUL = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;
const RE_HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const RE_LATIN = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

export function scriptClass(text: string): ScriptClass {
  if (RE_KANA.test(text)) return "kana";
  if (RE_HANGUL.test(text)) return "hangul";
  if (RE_HAN.test(text)) return "han";
  if (RE_LATIN.test(text)) return "latin";
  return "other";
}

/** 翻译行必须出现在原词行之后这个时间内（实测《王的归来》最大间隔 12.1 秒，取 15 秒） */
export const MAX_TRANSLATION_GAP_MS = 15000;
/**
 * 近似同刻聚类容差（毫秒，文档 N6）：起点相差不超过这个量的行算「同一时刻」。
 *
 * 为什么要聚：脏歌词里同一句会写成 [00:12.00] + [00:12.04]，或者一行的多个时间戳差
 * 几毫秒。不聚的话它们变成两组，高亮在两组之间闪一下（4ms 的「过门」），看起来就是
 * 「切句时抖了一下」。宁可早 1ms 不可晚 1ms：组起点取簇内**最早**的那个。
 *
 * 比较的是「本行与簇内第一行」的差，不是与上一行的差 —— 否则 0/70/140/210ms 会连成一片。
 */
export const CLUSTER_MS = 80;
/** 至少要认出这么多对，才相信"这首歌是原词 + 翻译" */
export const MIN_PAIRED_TRANSLATIONS = 3;
/** 而且配对要占绝对多数：配对行数 ≥ 这个比例的"原词候选行"与"汉字行" */
export const PAIRED_SHARE = 0.6;
/** 一句原词最多并进几行汉字译文：长句译文分两行很常见，再多就是数据乱了 */
export const MAX_FOLD_TRANSLATIONS = 3;

export interface LyricLayout {
  /** 显示分组：一组 = 同一个显示块（原词 + 它的翻译） */
  groups: number[][];
  /**
   * 每组的起始毫秒，**严格递增**（文档 N10）：indexAt(starts, t) 靠它二分。
   * 组内按时间稳定排序，所以「第一行」就是簇内最早的那个（N6：宁可早 1ms，不可晚 1ms）。
   */
  starts: number[];
  /** 这一行是翻译行（渲染小一号；不参与整首语言判定） */
  translation: boolean[];
  /** 靠 ② 认出来的翻译对数（同一时间戳成组的没算在这里） */
  paired: number;
}

/**
 * 把歌词行切成显示块。
 *
 * synced=false（纯文本歌词）时每行各自成组 —— 没有时间轴就没有"同时"这回事，
 * 分组会让整段文字挤进一个 div，除第一行外全部套上翻译样式。
 */
export function layoutLyricLines(lines: readonly TimedLyricLine[], synced = true): LyricLayout {
  const n = lines.length;
  const translation: boolean[] = new Array(n).fill(false);
  const singles: number[][] = [];
  for (let i = 0; i < n; i++) singles.push([i]);
  const startOf = (k: number) => lines[singles[k][0]].timeMs;
  if (!synced || n === 0) {
    return { groups: singles, starts: singles.map((_, k) => startOf(k)), translation, paired: 0 };
  }

  // ① 同一时刻的行归一组（同一时间戳 + CLUSTER_MS 内的近似同刻）
  //
  // 先按时间做**稳定排序**（文档 N9）：脏歌词里 [00:20] 后面跟着一条 [00:12] 很常见
  // （平台导出把译文/注解插错位置、手改过时间戳）。不排序的话倒序那行会自成一组，
  // starts 就不是递增的 —— 二分索引建立在「严格递增」上，这不是风格问题，是正确性前提。
  // 稳定（时间相同则保持文件顺序）保证原文/译文的主从关系不被排序打乱。
  const order: number[] = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => lines[a].timeMs - lines[b].timeMs || a - b);

  // 判据是「与本簇第一行相差 ≤ CLUSTER_MS」而不是与上一行比：与上一行比会让
  // 0/70/140/210ms 连成一片，把四句并成一句。排序之后簇内第一行天然是最早的那条，
  // 所以组起点就是簇内最小值（N6：宁可早 1ms，不可晚 1ms）。
  const base: number[][] = [];
  for (const i of order) {
    const last = base[base.length - 1];
    if (last && lines[i].timeMs - lines[last[0]].timeMs <= CLUSTER_MS) last.push(i);
    else base.push([i]);
  }

  // ② 时间戳不同：结构是「非汉字行（原词）→ 紧跟的纯汉字行（翻译）」
  //
  // 判据：
  //   · 只认"汉字行紧跟非汉字行"—— 日/韩/英原词 + 中文翻译是这个形状；
  //     两行都是汉字（中文歌里夹的中文注释）不配对，因为分不清谁是谁的翻译；
  //   · 原词与下一句原词之间**只能是汉字行**；一句原词带好几行汉字时全部并进同一个
  //     显示块（长句译文拆两行、译者多写一行都很常见）。早先的规则是"多于一行汉字就
  //     整段不配"，后果是这些译文各自成块、顶着翻译行自己的时间戳去抢高亮：
  //     《王的归来》1:42 处一句原词跟了两行汉字，屏幕上就多出两个纯中文孤行，
  //     高亮在它们身上各停两三秒，看起来正是"歌词有时候晚一句、有时候早一句"；
  //   · 全曲必须大部分都满足这个形状，否则整首不配对（散落几行巧合不算双语歌词）。
  const cls = base.map((g) => scriptClass(lines[g[0]].text));
  const usable = (k: number) => base[k].length === 1 && lines[base[k][0]].text.trim().length > 0;
  const spine: number[] = [];
  for (let k = 0; k < base.length; k++) if (usable(k) && cls[k] !== "han") spine.push(k);

  // 原词 base 下标 → 跟在它后面、要并进同一个显示块的汉字组数
  const pairedWith = new Map<number, number>();
  if (spine.length >= MIN_PAIRED_TRANSLATIONS + 1) {
    let hanGroups = 0;
    for (let k = 0; k < base.length; k++) if (usable(k) && cls[k] === "han") hanGroups++;
    for (let s = 0; s < spine.length; s++) {
      const from = spine[s] + 1;
      const to = s + 1 < spine.length ? spine[s + 1] : base.length;
      // spine 里已经含了全部"可用的非汉字行"，所以这一段里除了汉字行只剩不可用的行
      const spineMs = lines[base[spine[s]][0]].timeMs;
      let count = 0;
      let blocked = false;
      for (let k = from; k < to; k++) {
        if (!usable(k)) {
          blocked = true; // 中间夹了空行 / 同时间戳多行组，位置说不清
          break;
        }
        // 每一行都得落在原词之后 15 秒内：离太远的是别的段落（结尾的作词/作曲也一样）
        const gap = lines[base[k][0]].timeMs - spineMs;
        if (gap <= 0 || gap > MAX_TRANSLATION_GAP_MS) {
          blocked = true;
          break;
        }
        if (++count > MAX_FOLD_TRANSLATIONS) {
          blocked = true; // 汉字行太多，不像一句原词的译文
          break;
        }
      }
      if (blocked || count === 0) continue;
      pairedWith.set(spine[s], count);
    }
    // 全局把关：配对必须覆盖大部分原词行，也覆盖大部分汉字行
    const ok =
      pairedWith.size >= MIN_PAIRED_TRANSLATIONS &&
      pairedWith.size >= PAIRED_SHARE * spine.length &&
      pairedWith.size >= PAIRED_SHARE * Math.max(1, hanGroups);
    if (!ok) pairedWith.clear();
  }

  const groups: number[][] = [];
  for (let k = 0; k < base.length; k++) {
    const group = base[k].slice();
    const fold = pairedWith.get(k) ?? 0;
    for (let j = 1; j <= fold; j++) {
      const next = base[k + j];
      if (!next) break;
      group.push(...next); // 译文并进同一个显示块，别再各自成组抢高亮
    }
    k += fold;
    groups.push(group);
  }
  // 组里除第一行以外都是翻译行 —— 但只认"文字体系不同"的那些。
  // 同一时间戳的三行里可能有一条是说话人标签（"JENNIE："），把它也算成翻译会让
  // 真正的原词被缩成小字。文字体系不同才是翻译的硬证据。
  for (const group of groups) {
    const head = scriptClass(lines[group[0]].text);
    for (let j = 1; j < group.length; j++) {
      if (scriptClass(lines[group[j]].text) !== head) translation[group[j]] = true;
    }
  }
  return { groups, starts: groups.map((g) => lines[g[0]].timeMs), translation, paired: pairedWith.size };
}