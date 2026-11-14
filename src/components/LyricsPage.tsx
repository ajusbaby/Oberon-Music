// 沉浸式歌词页。
//
// 视觉规范取自 Salt Player 的播放页设计文档（《SaltPlayer-播放页前端设计文档.md》/
// 《SaltPlayer-播放页视觉逆向分析.md》），几条是这个页面必须守住的：
//
//   · 明暗只跟主题枚举走，不看封面亮度：
//       深色 → 纯黑底 + 纯白前景；浅色 → 纯白底 + **封面主色**做前景（取不到回退 #050F19）。
//   · 背景三层：底色（黑/白）→ 流光（FlowingLight）→ 内容。
//     流光自己带压暗蒙层，所以播放页**没有**额外的 scrim，也没有卡片、分割线、渐变按钮。
//   · 歌词：基准 24 × 倍率；当前句按设置放大（默认 1.5×，只放大字号 —— transform
//     会先栅格再放大、文字发虚），再靠"阶梯模糊 + alpha 差"区分远近；
//     相邻 1/2/3/≥4 行分别是 1.7 / 3.3 / 4.9 / 6.2 的模糊。
//   · 滚动用固定时长补间（150~300ms，easeOutCubic，到点硬停）而不是弹簧：弹簧的渐近尾巴会
//     拖到高亮之后 90ms、每步只有一两个设备像素，看着像"切完还在蹭"；补间没有尾巴，落位即静止。
//   · 尺寸强调（.is-lead）跟滚动一起提前 260ms，颜色强调（.is-active）按时间戳准点 ——
//     两者解耦，才能做到位移先到位、到点只变色：切句准时不延迟，落位后不再回弹。
//   · 页面留白 30dp，封面圆角 12dp / 描边 2dp，底部固定 120（= 项目里的 --player-height）。
//
// 类名统一 sl-* 前缀：views.css 里还挂着一批旧的 .lyrics-page .line ... 规则，
// 换前缀后它们自然不再命中，省去一场特异性战争（真正失效的块已经删掉了）。
import type { CSSProperties } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/ipc";
import type { LyricsResult } from "../api/types";
import { Icon } from "./Icon";
import { LangPicker } from "./LangPicker";
import { PlayerBar } from "./PlayerBar";
import { FlowingLight } from "./FlowingLight";
import { FALLBACK_LOOK, sampleCover } from "../lib/coverColor";
import type { CoverLook } from "../lib/coverColor";
import { useCover } from "../lib/cover";
import { isWindowInvisible, isWinFocused, onWindowVisibilityChange } from "../lib/winFocus";
import { usePlayerStore } from "../stores/playerStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  buildStacks,
  detectLineProfiles,
  detectSongProfile,
  fontFamilyName,
  OVERRIDE_AUTO,
  OVERRIDES_KEY,
  PROFILES,
  PROFILE_LIST,
  profileLang,
  readActiveScale,
  readMatchPolicy,
  readOverrides,
  readProfiles,
  readShowSource,
  readSize,
  readWeight,
  resolveSongProfile,
  serializeOverrides,
  setOverride,
  splitLineRuns,
} from "../lib/lyricFont";
import type { FontProfileId, LineRun } from "../lib/lyricFont";
import { advanceIndex, LyricClock } from "../lib/lyricEngine";
import { layoutLyricLines } from "../lib/lyricLines";
import {
  clampSyncOffset,
  formatOffset,
  PER_TRACK_KEY,
  readSyncOffset,
  readTrackOffset,
  withTrackOffset,
} from "../lib/lyricSync";
import { ensureFontsRegistered, useFontStore } from "../stores/fontStore";
import { useUiStore, toast } from "../stores/uiStore";

/** 诊断用：一段文字的 Unicode 码位列表（"U+4F60 U+597D"），超过 12 个就省略 */
function codepointsOf(text: string): string {
  const list: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (/s/.test(ch)) continue;
    list.push("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
    if (list.length >= 12) break;
  }
  return list.join(" ");
}

/** 鼠标静止多久后进入沉浸模式（3s） */
const IMMERSIVE_DELAY = 3200;

/* ===== 歌词滚动 =====
   位移是**固定时长的补间**（不是弹簧）：每次换句给定一个明确的时长，到点硬停在目标值。

   为什么不用弹簧（2026-11 CDP 实测推翻）：临界阻尼弹簧是渐近线，(1+ωt)e^{-ωt} 的尾巴永远
   走不完。采样 .sl-track 的 transform 序列，每次切句前 14 帧都是干净的 16.6~16.8ms，但末段
   变成 33 → 50/66/83ms 一步、每步只 0.8px（dpr=1.25 ⇒ 一个设备像素），**最后一次位移发生在
   高亮之后 94ms** —— 肉眼就是"切完了还在蹭一下"，体感像掉到 20 帧。主线程其实一直是满帧
   （rAF 间隔 p95=5.6ms，180Hz 屏），所谓掉帧全是这条像素阶梯尾巴。
   补间到点即停，尾巴长度恒为 0；easeOutCubic 让起步快、落地稳，手感与原来的弹簧接近
   （逐行错峰延迟没做：那会给十几行同时挂 transform，和"歌词只动一层 transform"的约束冲突）。 */
/** 定频节拍：60 帧 / 秒。切换动画严格按这个节拍推进，与屏幕刷新率无关。 */
const TICK_MS = 1000 / 60;
/** 节拍余量：小于 (TICK_MS - TICK_SLACK) 的回调直接跳过，避免漏帧 */
const TICK_SLACK = 1.5;
/**
 * 窗口失焦（键盘焦点在别的窗口 —— 比如用户开着任务管理器看占用）时的空闲节拍：30fps。
 *
 * 2026-11 修：这里原来是 90ms（~11fps），理由"失焦就少烧点 CPU"。但整列位移是 150–300ms 的
 * 补间，11fps 一条补间只采样到 **2 帧**（CDP 实测：切句窗口内只有 2 次写 DOM，写入间隔 p50
 * 94.6ms），肉眼就是"歌词一次跳两下"，用户报的"打开任务管理器歌词就卡"正是它 —— 任务管理器
 * 一抢焦点，这里立刻掉到 11fps，关掉就恢复 60fps。
 * 现在：**有东西在动**（补间 / 滚轮回位）就按 TICK_MS 全速跑，静止时才降到 30fps；
 * 一条 220ms 的补间在 30fps 下有 6~7 帧，位移仍然平滑，而失焦时每帧的开销本来只是
 * 一次二分 + 一次比较。暂停 + 静止仍然整段停帧（见循环末尾的 ② 判据）。
 */
const UNFOCUSED_IDLE_MS = 1000 / 30;
/** 换句位移的最短 / 最长时间：太短会一窜，太长会让下一句的提前量吃紧 */
const SCROLL_MIN_MS = 150;
const SCROLL_MAX_MS = 300;
/** 每像素额外加多少时长：句距远的换句多给一点，速度不至于失控 */
const SCROLL_MS_PER_PX = 0.55;

/** 一段位移补间：start 那一帧起 dur 毫秒从 from 走到 to，到点硬停 */
type Tween = { from: number; to: number; start: number; dur: number };

function startTween(from: number, to: number, now: number): Tween {
  const dist = Math.abs(to - from);
  const dur = Math.min(SCROLL_MAX_MS, Math.max(SCROLL_MIN_MS, SCROLL_MIN_MS + dist * SCROLL_MS_PER_PX));
  return { from, to, start: now, dur };
}

/**
 * 当前句放大后允许溢出自己那一组盒子的缓冲（上下各一份，px）。
 *
 * 盒子高度锁死在"1× 尺寸"，而 .is-lead 会把它放大到 --sl-lead-scale（最多 1.5×）：
 * 单行组只长十几像素，靠行内 padding 就吃下去了；**两行以上的组会溢出三四十像素，
 * 直接压到上下相邻组的字上**（用户截图里的现象）。所以每组两边各留 8px，再按"还剩多少
 * 空隙"把这一组的放大倍率截顶（见 measureStableTops 里的 scales）。
 */
const LEAD_RESERVE_PX = 8;
/** 截顶之后仍要保留的最小字间净空（px）：别让两行字贴到刚好相切 */
const LEAD_BREATH_PX = 4;

/**
 * 阶梯模糊（px）：当前句 0，往外 1.7 / 3.3 / 4.9 / 6.2。
 *
 * 和原来"近 5px、每行 +2、上限 12"的区别：Salt 的模糊是**很轻**的一层雾，
 * 靠的是"只有当前句是实的"这个对比，而不是把远处糊成色块。糊到 12px 时，
 * 一屏之内所有非当前行都变成同样的灰条，行数信息就没了。
 */
const BLUR_STEPS = [1.7, 3.3, 4.9, 6.2];
/** 只有离当前句这么近的行才真的挂 filter（见 blurFor 的注释）。 */
const BLUR_LIMIT = 7;

/**
 * 整列「稳定态」的组顶坐标（一次量好，换句时直接查表）。
 *
 * 活的 DOM 量不得：上一句正在缩回原尺寸，它上方还占着旧的大高度，直接读
 * el.offsetTop 拿到的是「上一句还没缩完」的坐标 —— 等比它缩完，整列会自己上移
 * 十几像素，正是用户说的「切完又往后回弹一下」。
 *
 * 这里把整列克隆到屏幕外、把 is-active 去掉后量一遍：所有组都处于"未点亮"的
 * 稳定尺寸，得到的 offsetTop 就是任何一句高亮时它上方占位的真实总和。
 * 全曲只量一次（歌词 / 字体 / 宽度变化时失效），换句不再有整列克隆的开销。
 */
type TrackGeometry = {
  epoch: unknown;
  width: number;
  /** 每一组的「谁都没放大」时的流式顶点与高度（相对 .sl-track） */
  tops: number[];
  heights: number[];
  /** 组中心 = tops + heights/2；绝对定位后它就是这组恒定不变的位置 */
  centers: number[];
  /**
   * 每一组的放大倍率上限（≤ --sl-active-scale）：行数多的组放不下就截顶，
   * 保证放大后不压到相邻组的字（见 measureStableTops）。
   */
  scales: number[];
  /** 整列总高（给 .sl-track 撑高度用） */
  total: number;
};

/**
 * 整列「稳定态」几何：一次量好，换句时只查表。
 *
 * 为什么要克隆到屏幕外量：上一句正在缩回原尺寸时它上面还占着旧的大高度，直接读活 DOM 的
 * offsetTop 拿到的是「上一句还没缩完」的坐标 —— 等它缩完整列会自己上移十几像素，正是用户
 * 说的「切完又往后回弹一下」。克隆里清掉 is-* 后，所有组都在"谁都没放大"的稳定尺寸上。
 *
 * 顺带算出每一组的**放大预算**（scales）：盒子高度锁死在 1×，而 .is-lead 要把字号乘到
 * --sl-active-scale —— 两行以上的组会溢出三四十像素压到相邻组的字上。所以这里再量一遍
 * 放大态，用「放大态超出盒子多少」反推每一组能用的最大倍率（行数越多截得越狠）。
 */
function measureStableTops(
  track: HTMLElement,
  host: HTMLElement,
  width: number
): { tops: number[]; heights: number[]; total: number; scales: number[] } {
  const clone = track.cloneNode(true) as HTMLElement;
  clone.setAttribute("aria-hidden", "true");
  // is-measuring：把"绝对定位 + 固定高度"抵消掉，让它回到普通流里量真实占位
  clone.className = "sl-track is-measuring";
  clone.style.cssText +=
    ";position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;width:" + width + "px;height:auto;";
  host.appendChild(clone);
  const groups = Array.from(clone.querySelectorAll<HTMLElement>(".sl-g"));
  // is-lead（正在放大的那一句）也必须去掉：这里先量的是"谁都没放大"的占位。
  // 更要紧的是清掉上一轮写在行内的 --sl-lead-scale：克隆会把它一起带过来，而
  // .is-lead 的字号正是读这个变量 —— 不清就是拿旧结果量新结果（量出来永远收敛到同一个数）。
  for (const g of groups) {
    g.classList.remove("is-active", "is-near", "is-lead");
    g.style.removeProperty("--sl-lead-scale");
  }
  const kids = Array.from(clone.children) as HTMLElement[];
  // ① 先一次读完所有 1× 高度（读完再写类，避免 O(n) 次强制布局）
  const baseHeights = kids.map((k) => k.offsetHeight);
  // 行内 padding 的 1× 值（7 + fs*0.11）：放大后 padding 同比变，这里只用它的量级。
  // 半行距也一起取：译文行 padding-top 是 0，它跟上方大字之间真正能让出来的净空只有半行距，
  // 计算倍率上限时按"较小的那一侧"算，才不会把译文顶到大字上。
  const lineEl = kids.length ? kids[0].firstElementChild as HTMLElement | null : null;
  const lineStyle = lineEl ? getComputedStyle(lineEl) : null;
  const pad = lineStyle ? parseFloat(lineStyle.paddingTop) || 0 : 0;
  const halfLeading = lineStyle
    ? Math.max(0, ((parseFloat(lineStyle.lineHeight) || 0) - (parseFloat(lineStyle.fontSize) || 0)) / 2)
    : 0;
  const capRaw = kids.length ? parseFloat(getComputedStyle(kids[0]).getPropertyValue("--sl-active-scale")) : NaN;
  const scaleCap = capRaw > 1 ? capRaw : 1.5;
  // ② 整体按"最大倍率"放大再读一遍（is-measuring 下字号/padding 过渡被 CSS 关掉，读到的是终值）。
  //    倍率显式写成 scaleCap：不依赖任何遗留的 --sl-lead-scale，量出来的 growth 才是干净的。
  for (const k of kids) {
    k.style.setProperty("--sl-lead-scale", String(scaleCap));
    k.classList.add("is-lead");
  }
  const leadHeights = kids.map((k) => k.offsetHeight);
  for (const k of kids) {
    k.classList.remove("is-lead");
    k.style.removeProperty("--sl-lead-scale");
  }
  clone.remove();

  /* ③ 每一组的倍率上限（精确解，不是估一个"可溢出量"）：

     放大 s 倍时这一组的内容高出盒子 growth = (s-1)·g（g = 倍率每 +1.0 长多少像素），
     上下各溢出 growth/2；而邻组的字离盒边至少半行距、放大那一侧自己的行内 padding 是 s·pad。
     于是相邻两组的字之间净空 = s·pad + halfLeading − growth/2，要求它 ≥ LEAD_BREATH_PX：

         s·pad + halfLeading + g/2 + LEAD_RESERVE_PX − (s−1)·g/2 ≥ LEAD_BREATH_PX
      ⇒  s ≤ (g/2 + halfLeading + LEAD_RESERVE_PX − LEAD_BREATH_PX) / (g/2 − pad)

     g/2 ≤ pad 时永远放得下，直接用设置值。单行组因此照常拿满倍率，两行以上的组按行数收敛。 */
  const tops: number[] = [];
  const heights: number[] = [];
  const scales: number[] = [];
  let acc = 0;
  for (let i = 0; i < kids.length; i++) {
    const box = baseHeights[i] + LEAD_RESERVE_PX * 2;
    const grow = scaleCap > 1 ? Math.max(0, leadHeights[i] - baseHeights[i]) / (scaleCap - 1) : 0;
    const halfGrow = grow / 2;
    let scale = scaleCap;
    if (halfGrow > pad) {
      const fit = (halfGrow + halfLeading + LEAD_RESERVE_PX - LEAD_BREATH_PX) / (halfGrow - pad);
      scale = Math.min(scaleCap, Math.max(1, fit));
    }
    tops.push(acc);
    heights.push(box);
    scales.push(scale);
    acc += box;
  }
  return { tops, heights, total: acc, scales };
}

/**
 * 把几何落到 DOM：每组绝对定位在「自己的流式顶点」，并**锁死这一组的高度**。
 *
 * 这一步是"切句不掉帧"的关键（用户反馈：切换动画偶尔掉到 20 帧）。原来的做法是
 * 整列保持普通流 —— 当前句一放大，它下方所有组的位置全部改变，于是**整列文字每帧
 * 都要重新布局、重新光栅化**（几十组文字 + 模糊层），一帧几十毫秒，体感就是卡成 20 帧。
 *
 * 现在：组与组互不相关，一组放大时别的组既不重排也不重绘；放大绕自身中心长出来
 * （高度锁死 + flex 居中，内容溢出得上下对称），所以「这一组的中心」恒定不变 ——
 * 居中目标不用再量"放大后的高度"，切句时没有任何测量、没有任何重排。
 */
function layoutTrack(track: HTMLElement, geo: TrackGeometry): void {
  const kids = track.children;
  const n = Math.min(kids.length, geo.centers.length);
  for (let i = 0; i < n; i++) {
    const el = kids[i] as HTMLElement;
    el.style.top = geo.tops[i].toFixed(1) + "px";
    el.style.height = geo.heights[i].toFixed(1) + "px";
    // 放大倍率上限：行数多的组会被截顶（否则放大后压住相邻组的字），CSS 侧读 --sl-lead-scale
    el.style.setProperty("--sl-lead-scale", geo.scales[i].toFixed(3));
  }
  track.style.height = geo.total.toFixed(1) + "px";
}

/**
 * 算出「把第 index 组居中」需要的位移。
 *
 * 几何全部走缓存（见 measureStableTops / layoutTrack），所以这里**没有任何 DOM 测量**：
 * 切句只是查一次表，主线程不会被强制布局打断（那一下正是掉帧的来源之一）。
 * 由于每组高度被锁死、放大绕中心对称溢出，组的中心与"当前是否放大"无关 ——
 * 落位之后不会有第二次修正，也就不会有回弹。
 */
function centerTargetFor(
  track: HTMLElement,
  box: HTMLElement,
  index: number,
  cache: { current: TrackGeometry | null },
  epoch: unknown
): number {
  const host = box.parentElement ?? box;
  const width = track.clientWidth || box.clientWidth;
  let entry = cache.current;
  if (
    !entry ||
    entry.epoch !== epoch ||
    entry.width !== width ||
    entry.centers.length !== track.children.length
  ) {
    const stable = measureStableTops(track, host, width);
    const centers: number[] = [];
    for (let i = 0; i < stable.tops.length; i++) centers.push(stable.tops[i] + stable.heights[i] / 2);
    entry = {
      epoch,
      width,
      tops: stable.tops,
      heights: stable.heights,
      centers,
      total: stable.total,
      scales: stable.scales,
    };
    cache.current = entry;
    layoutTrack(track, entry);
  }
  const c = entry.centers[index];
  if (c === undefined) return 0;
  return box.clientHeight / 2 - c;
}

/** 滚轮回位时长（毫秒） */
const WHEEL_RETURN_MS = 500;

/**
 * 滚动提前量（毫秒）：位移比"这一句开口"早这么多开始。
 *
 * 换句位移（补间）最长 300ms（SCROLL_MAX_MS），如果等时间戳到了才起步，人眼看到的是
 * "该唱了 → 歌词才开始动 → 还要再等两三百毫秒才停稳"，主观就是歌词慢半拍。
 * 提前 260ms 起步，这一句开口的瞬间它刚好落到正中。
 * 高亮（is-active）仍按时间戳准点切换，两者解耦：先滚动、后点亮。
 */
const SCROLL_LEAD_MS = 260;

/* ===== 圆形扩散（进场） =====
   圆盘是预先画好的位图，动画只改 transform: scale()，内容不参与缩放 ——
   这样进场期间不会每帧按新圆重新光栅化整窗（clip-path 动画的老问题）。
   1.45× 是有意压住的：scale 越大，浏览器按最大比例栅格化出来的纹理越大（5× 时约 3300²）。 */
const DISC_BLOOM = 1.45;

type LyricGroupProps = {
  indices: number[];
  lines: LyricsResult["lines"];
  lineRuns: (LineRun[] | null)[] | null;
  lineProfiles: FontProfileId[];
  lineStacks: string[];
  songProfile: FontProfileId;
  synced: boolean;
  /** 这一组就是当前唱的句子（.sl-g.is-active，整句全亮；按时间戳准点切换） */
  active: boolean;
  /**
   * 这一组是「滚动目标」（.sl-g.is-lead，放大字号 + 行内 padding 放大）。
   * 比 active 早 SCROLL_LEAD_MS 一步：位移先过去、尺寸先长好，等时间戳到了只剩颜色变化，
   * 所以落位之后整列不会再被"字体长出来"顶一次（那一下就是回弹）。
   */
  lead: boolean;
  /** 焦点上下 2 行（.sl-g.is-near，opacity 才有过渡） */
  near: boolean;
  blur: number;
  alpha: number;
  runCss: (run: LineRun) => string;
  onSeekMs: (ms: number) => void;
};

/**
 * 一组歌词（同一时间戳的原文 + 翻译）。
 *
 * 为什么单独抽出来并 memo：一次 setActiveGroup 会让整个歌词页重渲染，而列里通常有
 * 60~120 组、每组 1~3 行、每行再按字体来源切 1~4 个 span。焦点每前进一步，只有焦点附近
 * ±5 组（blur 阶梯 + alpha 渐变区）真的变了，远处那些组的 props（alpha 恒 0.52、blur 恒 0、
 * 数组引用稳定）完全一致 —— memo 让它们整块跳过，切句时的渲染量降到 1/10 以下。
 * 这里的 props 全部是原始值或引用稳定的数组，浅比较就够，不要往里传新对象/新箭头函数。
 */
const LyricGroup = memo(function LyricGroup(props: LyricGroupProps) {
  const {
    indices,
    lines,
    lineRuns,
    lineProfiles,
    lineStacks,
    songProfile,
    synced,
    active,
    lead,
    near,
    blur,
    alpha,
    runCss,
    onSeekMs,
  } = props;
  // 点哪一行都跳到这一条的演唱时刻：翻译行的时间戳是它出现的时间，不是唱到这一句的时间
  const headMs = lines[indices[0]]?.timeMs ?? 0;
  return (
    // 同一时间戳的多行（原词 + 翻译）作为**一个整体**渲染：
    // 模糊、行距、颜色都落在这一层，原词和翻译永远一起变化。
    <div
      className={
        "sl-g" + (lead ? " is-lead" : "") + (active ? " is-active" : "") + (near ? " is-near" : "")
      }
      style={{
        // 不加 opacity 过渡：几十行同时起过渡会把每一行都提成独立合成层
        opacity: alpha,
        filter: blur > 0.05 ? "blur(" + blur.toFixed(2) + "px)" : undefined,
      }}
    >
      {indices.map((index, k) => {
        const line = lines[index];
        if (!line) return null;
        // 这一行的档案：字体链按它取，lang 属性同时修中日的汉字字形变体
        const profile = lineProfiles[index] ?? "latin";
        const runs = lineRuns?.[index] ?? null;
        return (
          <p
            key={index}
            // k>0 = 同组里的第二行以后，也就是翻译行（字号 ×0.8）
            className={"sl-line" + (k > 0 ? " is-tr" : "") + (synced ? " is-clickable" : "")}
            lang={profileLang(profile)}
            style={{ fontFamily: lineStacks[index] }}
            onClick={synced ? () => onSeekMs(headMs) : undefined}
          >
            {/* 文字包一层 inline 容器：开了「显示实际字体来源」时，这一段会按
                "主字体 / 回退"再切成几段，于是眼睛看到的字面来源就是真的。 */}
            <span className="sl-in">
              {runs
                ? runs.map((run, ri) => (
                    <span
                      key={ri}
                      className={"sl-run" + (run.fallback ? " is-fb" : "")}
                      style={{ fontFamily: runCss(run) }}
                      title={
                        run.fallback
                          ? "这几个字主字体没有，实际由该语言的系统字体渲染（点开看码位）"
                          : "这一段的字来自主字体"
                      }
                      onClick={
                        run.fallback
                          ? (e) => {
                              // 诊断模式（§7.3）：点回退段给出缺字列表 + 码位，同时别让点击顺带跳转播放
                              e.stopPropagation();
                              toast(
                                "主字体缺这几个字，已回退到系统字体：" +
                                  codepointsOf(run.text) +
                                  (run.profile === songProfile ? "" : "（" + PROFILES[run.profile].label + "档案）"),
                                "info",
                              );
                            }
                          : undefined
                      }
                    >
                      {run.text}
                    </span>
                  ))
                : line.text}
            </span>
          </p>
        );
      })}
    </div>
  );
});

export function LyricsPage() {
  const open = useUiStore((s) => s.lyricsOpen);
  const closeLyrics = useUiStore((s) => s.closeLyrics);
  const origin = useUiStore((s) => s.lyricsOrigin);
  const player = usePlayerStore((s) => s.state);
  // 进度单独订阅（见 playerStore 的说明）：避免进度事件让整个应用重渲染
  const progressSecs = usePlayerStore((s) => s.positionSecs);
  const seek = usePlayerStore((s) => s.seek);
  const settingsValues = useSettingsStore((s) => s.values);
  const writeSetting = useSettingsStore((s) => s.set);
  // 字体库：资源列表一次性加载，注册成 FontFace 后浏览器才认这条链
  const fontResources = useFontStore((s) => s.resources);
  const fontStatus = useFontStore((s) => s.status);
  const loadFonts = useFontStore((s) => s.load);
  useEffect(() => {
    if (fontStatus === "idle") void loadFonts();
  }, [fontStatus, loadFonts]);

  // 歌词字体：字号 / 字重 / 当前句缩放来自设置；「用哪个字体」来自字体库 + 六份语言档案。
  // 具体规则全在 src/lib/lyricFont.ts，这里只负责把结果搬到 style 上。
  const lyricFontSize = readSize(settingsValues);
  const lyricFontWeight = readWeight(settingsValues);
  // 当前句放大倍率（1 = 不放大，默认 1.5）
  const lyricActiveScale = readActiveScale(settingsValues);

  const current = player?.current ?? null;
  const status = player?.status ?? "stopped";
  const cover = useCover(current?.trackId ?? null);

  // 背景取色：封面 → 纹理 + 页面基色 + 白纱强度（见 src/lib/coverColor.ts）。
  // 关键点：颜色不是"挑"出来的，而是封面本身 —— 所以色相永远不会串（橘黄不会变成绿）。
  // 白纱只负责"深色封面抬成浅色系"，浅色封面 wash = 0，原样取用。
  const [look, setLook] = useState<CoverLook>(FALLBACK_LOOK);
  useEffect(() => {
    let alive = true;
    void sampleCover(cover).then((l) => {
      if (alive) setLook(l);
    });
    return () => {
      alive = false;
    };
  }, [cover]);

  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [immersive, setImmersive] = useState(false);
  /** 顶栏语言下拉是否展开：展开期间压住沉浸计时器，否则选到一半菜单先淡出了 */
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  // 进出场动画：只动 opacity / transform（合成层属性），保证 60fps
  const [phase, setPhase] = useState<"in" | "out" | null>(null);
  const [mounted, setMounted] = useState(false);
  const [staged, setStaged] = useState(false);
  const everOpened = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // 圆形扩散的几何：圆心取点击处（播放条封面）中心，半径从封面半径扩到盖住整窗
  const geo = useMemo(() => {
    const w = typeof window === "undefined" ? 1267 : window.innerWidth;
    const h = typeof window === "undefined" ? 902 : window.innerHeight;
    const cx = origin ? origin.x + origin.w / 2 : w / 2;
    const cy = origin ? origin.y + origin.h / 2 : h / 2;
    const r0 = origin ? Math.max(origin.w, origin.h) / 2 : 36;
    const dx = Math.max(cx, w - cx);
    const dy = Math.max(cy, h - cy);
    return { cx, cy, r0, rMax: Math.sqrt(dx * dx + dy * dy) + 30, w, h };
  }, [origin]);
  // 滚轮浏览时取消渐进模糊（用户手动翻看时全部清晰）
  const [blurOff, setBlurOff] = useState(false);
  // 沉浸清屏：只留歌词（再点右上角或按 Esc 退出）
  const [cleared, setCleared] = useState(false);

  const pageRef = useRef<HTMLDivElement | null>(null);
  /** 全窗底色（黑/白）：只做 opacity 淡入 —— 最便宜的合成层动画 */
  const veilRef = useRef<HTMLDivElement | null>(null);
  /** 进场圆盘：只动 transform: scale(--disc-scale) */
  const discRef = useRef<HTMLDivElement | null>(null);
  const lyricsBoxRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);

  const position = progressSecs;

  // 歌词加载：曲目变化时重新读取
  useEffect(() => {
    if (!open) return;
    const trackId = current?.trackId;
    if (trackId == null) {
      setLyrics(null);
      return;
    }
    let alive = true;
    setLoading(true);
    void api
      .trackLyrics(trackId)
      .then((res) => {
        if (alive) setLyrics(res);
      })
      .catch((e) => {
        if (alive) {
          setLyrics(null);
          toast("读取歌词失败：" + String(e), "error");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, current?.trackId]);

  // 切歌过场：整列轻抬 10px 淡入（CSS 见 .lyrics-page.swapping）。
  // 动效挂在 .sl-lyrics 容器上，绝不碰 .sl-track —— 那一层的 transform 属于滚动补间。
  const [swapping, setSwapping] = useState(false);
  const prevTrackRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const id = current?.trackId ?? null;
    if (prevTrackRef.current === undefined) {
      prevTrackRef.current = id;
      return;
    }
    if (prevTrackRef.current === id) return;
    prevTrackRef.current = id;
    setSwapping(true);
    const t = window.setTimeout(() => setSwapping(false), 480);
    return () => window.clearTimeout(t);
  }, [current?.trackId]);

  // 沉浸模式：鼠标/键盘静止 3s 后隐藏上下控件
  useEffect(() => {
    if (!open) return;
    const reset = () => {
      setImmersive(false);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      if (langMenuOpen) return; // 下拉展开中：顶栏连同菜单一起留住
      hideTimer.current = window.setTimeout(() => setImmersive(true), IMMERSIVE_DELAY);
    };
    reset();
    window.addEventListener("mousemove", reset);
    window.addEventListener("mousedown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      window.removeEventListener("mousemove", reset);
      window.removeEventListener("mousedown", reset);
      window.removeEventListener("keydown", reset);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
    // langMenuOpen 进依赖：菜单一展开就立刻取消已经排好的隐藏任务
  }, [open, langMenuOpen]);

  // Esc 返回
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 沉浸清屏时先退出沉浸，再按一次才关闭歌词页。
      // ⚠️ 不能在 setState 的 updater 里做副作用：StrictMode 下 updater 会跑两遍。
      if (cleared) {
        setCleared(false);
        return;
      }
      closeLyrics();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeLyrics, cleared]);

  // 每次重新打开都复位这几个「临时态」
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setCleared(false);
      setImmersive(false);
      setBlurOff(false);
    }
    wasOpen.current = open;
  }, [open]);

  // 展开/收起的状态与计时
  useEffect(() => {
    if (open) {
      everOpened.current = true;
      setMounted(true);
      setPhase("in");
      // ⚠️ 必须**立即**进入 staged：.staged 的入场动画带 both 填充，动画真正开始前会维持
      // 元素的自然状态（完全可见）；延迟加类会让歌词先亮一下再被拉回 from。
      // 分层错峰交给 CSS 自带的 animation-delay（topbar 120 / lyrics-area 240 / footer 340）。
      setStaged(true);
      const unstageTimer = window.setTimeout(() => setStaged(false), 1400);
      const phaseTimer = window.setTimeout(() => setPhase(null), 900);
      return () => {
        window.clearTimeout(unstageTimer);
        window.clearTimeout(phaseTimer);
      };
    }
    if (!everOpened.current) return;
    setPhase("out");
    setStaged(false);
    // 退场：内容先快速淡出，底色与圆盘再收回（都是合成层操作，不重画内容）
    const stage = stageRef.current;
    const disc = discRef.current;
    const veil = veilRef.current;
    if (stage) {
      stage.style.transition = "opacity 130ms ease";
      stage.style.opacity = "0";
    }
    if (veil) {
      veil.style.transition = "opacity 220ms ease";
      veil.style.opacity = "0";
    }
    if (disc) {
      disc.style.transition = "transform 260ms ease";
      disc.style.setProperty("--disc-scale", "0");
    }
    const timer = window.setTimeout(() => {
      setPhase(null);
      setMounted(false); // 退场动画播完再卸载
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, geo]);

  // 进场：底色淡入 + 圆盘从点击处绽开 + 内容分层入场（只动 opacity/transform）
  useLayoutEffect(() => {
    if (!mounted || !open) return;
    const root = pageRef.current;
    const veil = veilRef.current;
    const disc = discRef.current;
    const stage = stageRef.current;
    if (root) {
      root.style.transition = "";
      root.style.opacity = "";
      root.style.setProperty("--ox", geo.cx + "px");
      root.style.setProperty("--oy", geo.cy + "px");
    }
    if (veil) {
      veil.style.transition = "none";
      veil.style.opacity = "0";
    }
    if (disc) {
      disc.style.transition = "none";
      disc.style.setProperty("--disc-scale", "0");
    }
    if (stage) {
      stage.style.transition = "opacity 420ms cubic-bezier(.4,0,.2,1)";
      stage.style.opacity = "0";
    }
    void disc?.offsetWidth; // 强制重排，让下面的过渡生效
    if (veil) {
      veil.style.transition = "opacity 560ms cubic-bezier(.4,0,.2,1)";
      veil.style.opacity = "1";
    }
    if (disc) {
      disc.style.transition = "transform 700ms cubic-bezier(.4,0,.2,1)";
      disc.style.setProperty("--disc-scale", String(DISC_BLOOM));
    }
    if (stage) {
      void stage.offsetWidth;
      stage.style.opacity = "1";
    }
  }, [mounted, open, geo]);

  // 一条歌词可能不止一行文字 —— 原文 + 翻译。两种写法都要认：
  //   ① 共用时间戳（英文歌常见）
  //   ② 翻译行时间戳更晚（《王的归来（I'm King）》那类：翻译追在原文后面 0.3~12 秒）
  // 判据在 lib/lyricLines，React 和体检脚本（npm run check:lyrics）用的是同一套。
  const layout = useMemo(
    () =>
      layoutLyricLines(
        (lyrics?.lines ?? []).map((l) => ({ timeMs: l.timeMs, text: l.text })),
        !!lyrics?.synced
      ),
    [lyrics]
  );
  const groups = layout.groups;
  /** 每组起始毫秒（严格递增）：帧循环靠它二分定位当前组 */
  const starts = layout.starts;
  // 翻译行：渲染小一号，且不参与整首语言判定（翻译的文字体系是译者选的，不是这首歌的语言）
  const translation = layout.translation;

  /**
   * 帧循环的重新点火开关（P0-a）。
   * 循环一旦判定"画面不会再变"就真的停掉调度，下面任何一个唤醒源都要叫它回来：
   * 位置/状态变化、滚轮、歌词基准位重算、窗口重新可见。
   */
  const kickRef = useRef<(() => void) | null>(null);
  /** 上一帧真正做了工作的时刻（毫秒）：失焦节流用，避免每帧都去读焦点状态 */
  const lastWorkRef = useRef(0);

  /* ===== 播放时钟：锚点插值 + 只向前对齐 =====
     实现全在 src/lib/lyricEngine.ts 的 LyricClock（纯逻辑，能在 Node 里断言）。这里只接线：
       · 位置/状态变化 → report()，由它决定要不要重锚（只有拖动 / 切歌 / 追帧才重锚）；
       · 每帧 → now()，按 1× 墙钟外推，绝不把位置事件当成帧时间（文档反模式 A1）；
       · report() 判定跳变时置 snapPending，位移那一帧直接落位，不播补间（§10.2.3）。
     为什么不把上报值直接当时间：进度事件约 800ms 一次，位置是台阶，全靠 1× 外推抹平；
     只要上报本身比实际出声慢一点点（后端任何一处采样率/声道声明误差都会变成率误差），
     重锚就把误差原样吃进来并随播放时间累积 —— 前半首还准、后半首慢半秒正是这个形态。 */
  const clockRef = useRef<LyricClock | null>(null);
  if (!clockRef.current) clockRef.current = new LyricClock();
  /** 时钟判定跳变（拖动 / 切歌 / 追帧）后置位：位移直接落位，不做补间动画 */
  const snapPendingRef = useRef(false);

  useEffect(() => {
    const sample = clockRef.current!.report(position, status === "playing", performance.now());
    if (sample.snapped) snapPendingRef.current = true;
    // 暂停/恢复/拖动进度：循环若已停帧，这一下把它叫起来补画一帧
    kickRef.current?.();
  }, [position, status]);

  // 换歌：时钟归零并重新起锚（率样本跟着"这一条播放链"走，必须作废），
  // 第一句直接落位 —— 新歌不该从上一位歌的位置滑进来。
  useEffect(() => {
    clockRef.current!.reset(0, performance.now());
    snapPendingRef.current = true;
    yReadyRef.current = false;
  }, [current?.trackId]);

  /* ===== 歌词与声音的偏移账 =====
     t = position + fileOffset + userOffset + latency（规则见 src/lib/lyricSync.ts）。
     fileOffset 是歌词文件自己写的修正，后端已经并进 timeMs；这里加的是 userOffset
     （全局一个 + 本曲一个），所以"这首歌的歌词整体偏晚"可以就地修，不影响别的歌。 */
  const syncOffsetMs = readSyncOffset(settingsValues, current?.trackId ?? null);
  const offsetRef = useRef(syncOffsetMs);
  // 渲染期直接赋值：偏移只在设置变化或换歌时改，比放进 effect 早一帧生效，也不会闪。
  offsetRef.current = syncOffsetMs;

  // Alt+←/→ 微调「本曲」同步偏移（Alt+Shift 步进 250ms）。只在歌词页开着时生效，
  // 用捕获阶段抢在全局 ←/→（切歌）之前把它消费掉。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      const trackId = current?.trackId;
      if (!dir || trackId == null) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 250 : 50;
      const next = clampSyncOffset(readTrackOffset(settingsValues, trackId) + dir * step);
      void writeSetting(PER_TRACK_KEY, withTrackOffset(settingsValues, trackId, next));
      toast("本曲歌词同步 " + formatOffset(next) + "（Alt+←/→ 微调，加 Shift 步进 250ms）");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, current?.trackId, settingsValues, writeSetting]);

  /** 歌词纵向位移：补间跟随基准位 + 滚轮偏移 */
  const baseYRef = useRef(0);
  const wheelYRef = useRef(0);
  const yRef = useRef(0);
  /** 正在跑的位移补间（null = 已在目标位上）；到点即清，不留渐近尾巴 */
  const tweenRef = useRef<Tween | null>(null);
  const yReadyRef = useRef(false);
  const wheelTimer = useRef<number | null>(null);
  // 设备像素比（用于把位移对齐到整数设备像素，避免文字发虚）
  const dprRef = useRef(1);
  // 上一帧时间戳
  const lastFrameRef = useRef(0);
  // 上次真正写进 DOM 的值：没变就不写
  const lastPxRef = useRef<number | null>(null);
  // 滚轮松手后的回位补间（线性滑回 0，而不是瞬跳）
  const wheelReturnRef = useRef<{ from: number; start: number } | null>(null);
  const activeGroupRef = useRef(-1);
  const [activeGroup, setActiveGroup] = useState(-1);
  // 滚动目标比高亮早 SCROLL_LEAD_MS 一步：先滚到位，再准点点亮
  const scrollGroupRef = useRef(-1);
  const [scrollGroup, setScrollGroup] = useState(-1);
  /** 整列「稳定态」组顶坐标的缓存：换句时直接查表，不再克隆整列 */
  const topsRef = useRef<TrackGeometry | null>(null);

  // 每帧：算出当前组，并把位移积分到 DOM（不触发 React 重渲染），
  // 只有换行时才 setState，避免 60fps 重渲染整列歌词。
  useEffect(() => {
    if (!open || !lyrics?.synced || starts.length === 0) {
      activeGroupRef.current = -1;
      setActiveGroup(-1);
      scrollGroupRef.current = -1;
      setScrollGroup(-1);
      return;
    }
    wheelYRef.current = 0;
    let raf = 0;
    let alive = true;
    function stop() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }
    function wake() {
      if (!alive || raf || isWindowInvisible()) return;
      // 停帧期间可能过去了几十秒：补间用绝对时刻算进度，下一帧会直接判 p>=1 落位，不会补播
      lastFrameRef.current = 0;
      raf = requestAnimationFrame(loop);
    }
    function loop() {
      raf = 0;
      const ts = performance.now();
      // 失焦（窗口还在屏幕上，只是键盘焦点在别处，例如用户开着任务管理器看占用）：
      // 有位移在跑就照常全速（否则 150–300ms 的补间只剩 2 帧采样，看起来是"跳两下"），
      // 画面静止时才降到 30fps。不能直接停 —— 那样歌词会当场冻住。
      if (!isWinFocused()) {
        const moving =
          tweenRef.current !== null ||
          wheelReturnRef.current !== null ||
          wheelYRef.current !== 0;
        if (ts - lastWorkRef.current < (moving ? TICK_MS - TICK_SLACK : UNFOCUSED_IDLE_MS)) {
          raf = requestAnimationFrame(loop);
          return;
        }
      }
      // ===== 定频 60 帧 =====
      // 用户要求「歌词切换固定 60 帧」。这里自己数节拍（不走全局帧预算 frameBudget.ts）：
      // 帧预算是全应用共享的，同一 rAF 里 WaveProgress（页脚那条波形，无条件自转）可能先一步
      // 占掉名额，放行时刻忽早忽晚 —— 那种不齐比单纯的 60fps 更难看。数自己的节拍则每 16.67ms
      // 稳定推进一格。
      // 节拍取**真实流逝时间**（不是写死 dt）：任何刷新率下滑动速度都一致；而 144/180Hz 面板
      // 上多出来的那两次回调只会把同一段位移重复光栅化，不增加可见信息。
      // 1.5ms 余量：60.00Hz 显示器相邻回调的差值常在 16.66~16.68 之间抖，卡在 16.667 上会把
      // 整整一帧（16.7ms）漏掉，看起来就是"每两拍走一格"的顿挫。
      const prevTs = lastFrameRef.current;
      if (prevTs !== 0 && ts - prevTs < TICK_MS - TICK_SLACK) {
        raf = requestAnimationFrame(loop);
        return;
      }
      lastWorkRef.current = ts;
      const clock = clockRef.current!;
      // 歌词时间 = 墙钟外推 × 1 + 偏移（正 = 歌词提前）。这是每帧唯一的"时间来源"。
      const ms = clock.now(ts) * 1000 + offsetRef.current;
      // 左闭右开二分 + 游标：正常播放每帧只挪一步，换歌/拖动时才走线性那几段。
      // starts 由 layoutLyricLines 保证严格递增（N10），所以二分一定落在正确的一组上。
      const g = advanceIndex(starts, ms, activeGroupRef.current);
      const sg = advanceIndex(starts, ms + SCROLL_LEAD_MS, scrollGroupRef.current);
      // 当前这一整句一次性全亮，不跟演唱进度渐变：每帧只判断"当前是第几组"
      if (activeGroupRef.current !== g) {
        activeGroupRef.current = g;
        setActiveGroup(g);
      }
      // 滚动目标提前一步换（见 SCROLL_LEAD_MS）：两个 setState 在同一帧提交，只多一次渲染
      if (scrollGroupRef.current !== sg) {
        scrollGroupRef.current = sg;
        setScrollGroup(sg);
      }
      lastFrameRef.current = ts;
      // ===== 位移：固定时长补间（到点硬停，没有弹簧那条像素阶梯尾巴）=====
      // 目标一改（换句 / 尺寸变化 / 拖动后重算基准）就从头起一段，起点取**当前视觉位置**，
      // 所以补间途中改目标也不会跳；到点把 y 直接写成目标值并清掉 tween ⇒ 之后一帧都不再动。
      if (snapPendingRef.current) {
        // 跳变帧（拖动进度 / 换歌 / 卡顿追帧）：直接落位，不滚。
        // 让"我刚点了这一句"立刻成立，而不是看着整列追过去（文档 §10.2.3）。
        snapPendingRef.current = false;
        tweenRef.current = null;
        yRef.current = baseYRef.current;
      } else {
        const base = baseYRef.current;
        let tw = tweenRef.current;
        if (Math.abs(base - yRef.current) > 0.01 && (!tw || Math.abs(tw.to - base) > 0.01)) {
          tw = tweenRef.current = startTween(yRef.current, base, ts);
        }
        if (tw) {
          const p = (ts - tw.start) / tw.dur;
          if (p >= 1) {
            yRef.current = tw.to;
            tweenRef.current = null;
          } else {
            const inv = 1 - p;
            yRef.current = tw.from + (tw.to - tw.from) * (1 - inv * inv * inv);
          }
        }
      }

      const ret = wheelReturnRef.current;
      if (ret) {
        const p = (ts - ret.start) / WHEEL_RETURN_MS;
        if (p >= 1) {
          wheelYRef.current = 0;
          wheelReturnRef.current = null;
        } else {
          wheelYRef.current = ret.from * (1 - p);
        }
      }
      // 逐字扫过已去掉（2026-11）：原来每帧给当前句写一个 --sl-k，让"已唱 / 未唱"的
      // 界线从左往右推。问题是这句用来扫的时长只能按"本句到下一句"的间隔去猜（见
      // 旧实现的 950–4300ms 夹取），前奏/间奏一长就完全对不上：歌还没唱，界线已经在
      // 句子里走了 —— 看起来就是"前奏期间歌词自己在走"。
      // 现在只认时间戳：唱到哪一句，那一整句一次性全亮（.sl-g.is-active），
      // 句子内部不再有渐变，也就不需要每帧写 DOM 了。
      const track = trackRef.current;
      if (track) {
        // 按设备像素对齐：小数位移会让整列文字落在亚像素位置，渲染发虚
        const px = Math.round((yRef.current + wheelYRef.current) * dprRef.current) / dprRef.current;
        if (px !== lastPxRef.current) {
          lastPxRef.current = px;
          track.style.transform = "translate3d(0," + px + "px,0)";
        }
      }
      // ===== 停帧判据（P0-a 的核心）=====
      // ① 窗口不可见（最小化 / 收进托盘 / document.hidden）：整窗不在屏幕上，
      //    继续算只是在让合成器持续被唤醒。真正的 cancelAnimationFrame，不是回调里早退。
      if (isWindowInvisible()) {
        stop();
        return;
      }
      // ② 暂停 + 补间已走完 + 没有滚轮回位在跑：画面已经不会再变了。
      //    位置/状态变化、滚轮、基准位重算、重新可见都会走 wake() 回来。
      if (
        !clock.playing &&
        !tweenRef.current &&
        wheelYRef.current === 0 &&
        !wheelReturnRef.current &&
        Math.abs(yRef.current - baseYRef.current) < 0.01
      ) {
        stop();
        return;
      }
      raf = requestAnimationFrame(loop);
    }
    // 合并信号：document.visibilitychange 与 Tauri 的 win-hidden（最小化/托盘）。
    // 恢复可见时 wake() 立刻补一帧 —— 隐藏期间位置事件照常进来，
    // 这一帧会把当前句和位移一次性对齐，不会停在旧画面上。
    const offVisibility = onWindowVisibilityChange(() => {
      if (isWindowInvisible()) stop();
      else wake();
    });
    raf = requestAnimationFrame(loop);
    kickRef.current = wake;
    return () => {
      alive = false;
      kickRef.current = null;
      offVisibility();
      stop();
    };
  }, [open, lyrics, starts]);

  // 滚轮：手动浏览歌词（松手 2.6s 后自动回到当前句）
  useEffect(() => {
    const box = lyricsBoxRef.current;
    if (!box || !open) return;
    dprRef.current = window.devicePixelRatio || 1;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setBlurOff(true); // 滑动滚轮时取消渐进模糊
      const track = trackRef.current;
      const span = track ? Math.max(240, track.scrollHeight * 0.6) : 600;
      const step = e.deltaMode === 1 ? e.deltaY * 28 : e.deltaY; // 行模式换算成像素
      wheelYRef.current = Math.max(-span, Math.min(span, wheelYRef.current - step));
      if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
      wheelReturnRef.current = null; // 有新滚动输入则取消回位
      kickRef.current?.(); // 暂停且已停帧时，滚轮是唯一的唤醒源
      wheelTimer.current = window.setTimeout(() => {
        wheelReturnRef.current = { from: wheelYRef.current, start: performance.now() };
        setBlurOff(false); // 回到当前句后恢复模糊
        kickRef.current?.(); // 回位补间需要一个在跑的循环
      }, 2600);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      box.removeEventListener("wheel", onWheel);
      if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
    };
  }, [open, lyrics]);

  /**
   * 「滚轮浏览 → 暂时取消模糊」的唯一出口必须是可靠的。
   *
   * 这个状态以前只有两个出口：2.6s 的定时器，以及重开歌词页。切歌时歌词数据变化会让上面的
   * 滚轮 effect 重新挂载 —— 清理函数把那个定时器 clear 掉，而 blurOff 还留在 true，
   * 于是「滚一下、在回位前切歌」会让**之后的每一首**都没有阶梯模糊。
   * 这里把切歌 / 重开都补成强制复位：定时器一起清，状态一起清。
   */
  useEffect(() => {
    if (wheelTimer.current !== null) {
      window.clearTimeout(wheelTimer.current);
      wheelTimer.current = null;
    }
    setBlurOff(false);
  }, [current?.trackId, open]);

  /**
   * 阶梯模糊：0 / 1.7 / 3.3 / 4.9 / 6.2。滚轮手动浏览时整体关掉。
   * focus 是"视觉焦点句"：正常就是当前句，但在**前奏期间**（activeGroup 还是 -1，
   * 第一句还没到）取第 0 句 —— 否则整首歌开头几十秒里所有行都不模糊、全部 alpha 1，
   * 看上去就像"模糊没加载出来"（Deep End 那种长前奏最明显）。
   */
  const blurFor = useCallback(
    (groupIndex: number, focus: number) => {
      if (blurOff || focus < 0) return 0;
      const d = Math.abs(groupIndex - focus);
      if (d === 0) return 0;
      // 每个带 filter 的行都是一个独立滤镜表面，长歌词动辄上百行。
      // 远离当前句的行（≥8 行，早就在渐隐层外面）不再挂滤镜，只留透明度差。
      if (d > BLUR_LIMIT) return 0;
      return BLUR_STEPS[Math.min(BLUR_STEPS.length - 1, d - 1)];
    },
    [blurOff]
  );

  /**
   * 透明度：每远离一句只退 8.8%，到 0.52 停住。
   * 台阶感来自这里 —— 四档跳变会让滚动时像一格一格掉亮度。
   */
  const alphaFor = useCallback(
    (groupIndex: number, focus: number) => {
      if (focus < 0) return 1;
      const d = Math.abs(groupIndex - focus);
      if (d === 0) return 1;
      const a = 1 - 0.088 * d;
      return a < 0.52 ? 0.52 : a;
    },
    []
  );

  // lines 的引用稳定下来，下面两个 memo 才不会被"每次 render 都新建的空数组"击穿
  const lines = useMemo(() => lyrics?.lines ?? [], [lyrics]);
  const hasLyrics = lines.length > 0;
  const synced = !!lyrics?.synced && hasLyrics;

  // 整首歌归属哪个档案：假名 / 谚文是硬证据，简体字与日式汉字是软证据（权重见 lyricFont）
  const detectedProfile = useMemo(
    () => detectSongProfile(lines.map((l) => l.text), translation),
    [lines, translation]
  );
  // 歌曲级语言覆盖（§5.4）：统计判错时用户只改这一首，settings 里按曲目 id 存一条
  const overrides = useMemo(() => readOverrides(settingsValues), [settingsValues]);
  const trackKey = current?.trackId ?? null;
  const overrideProfile = resolveSongProfile(null, overrides, trackKey);
  // 覆盖优先，其次统计判定（空歌词时 detectSongProfile 给 symbols）
  const songProfile: FontProfileId = overrideProfile ?? detectedProfile ?? "latin";
  // 六份档案的配置（主字体 / 备用字体 / 缺字策略），存在 settings 的 lyricFontProfiles 里
  const profiles = useMemo(() => readProfiles(settingsValues), [settingsValues]);
  // 每份档案一条链：主字体 → 备用字体 → 该语言系统链 → sans-serif
  const stacks = useMemo(() => buildStacks(profiles, fontResources), [profiles, fontResources]);
  // 纯汉字行怎么归属：整首一致（默认）或逐行按证据
  const matchPolicy = readMatchPolicy(settingsValues);
  // 每一行归属的档案（同组翻译行跟随原词，见 detectLineProfiles）
  const lineProfiles = useMemo(
    () => detectLineProfiles(lines.map((l) => l.text), songProfile, matchPolicy, groups, translation),
    [lines, songProfile, matchPolicy, groups, translation]
  );

  // 链里出现的导入字体必须真的注册过（document.fonts.add）才会生效。
  // 注册是异步的：注册完 +1 个 epoch 让下面几个 memo 重算一次，避免"首帧是系统字体"。
  const [fontEpoch, setFontEpoch] = useState(0);
  const userFontIds = useMemo(() => Array.from(new Set(Object.values(stacks).flatMap((s) => s.userFontIds))), [stacks]);
  const userFontKey = userFontIds.join("|");
  useEffect(() => {
    if (!userFontIds.length) return;
    let alive = true;
    void ensureFontsRegistered(userFontIds).then(() => {
      if (alive) setFontEpoch((n) => n + 1);
    });
    return () => {
      alive = false;
    };
    // 依赖用 join 出来的键：userFontIds 每次 memo 都是新数组，直接当依赖会无限重注册
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userFontKey]);

  // 每一行最终用的字体链（memo 保持字符串引用稳定，避免每次 render 触发子节点重排）
  const lineStacks = useMemo(
    () => lines.map((_, i) => stacks[lineProfiles[i] ?? "latin"].css),
    [lines, lineProfiles, stacks, fontEpoch]
  );

  /** 影响行高的输入（字体链 / 逐行档案 / 字号设置）变了，缓存的组顶坐标就要作废 */
  const geoEpoch = useMemo(() => ({}), [lineStacks, lineProfiles, songProfile, settingsValues]);

  // 居中基准：把「当前这一组」的中心对到歌词区的垂直中心。
  // 歌词区的下边界就是播放条上沿（见 lyrics.css 的 .sl-lyrics-area），所以这里不再补偿偏移量。
  useLayoutEffect(() => {
    const box = lyricsBoxRef.current;
    const track = trackRef.current;
    if (!box || !track) return;
    // 前奏期间（还没有当前句）先按第一句居中，歌词才不会贴着顶端加载出来。
    // 组中心与"是否放大"无关（高度锁死、放大绕中心溢出，见 layoutTrack），
    // 所以这里不需要区分 lead：切句的目标位置是恒定的，落位后不会被顶第二次。
    const gi = scrollGroup >= 0 ? scrollGroup : track.children.length > 0 ? 0 : -1;
    if (gi < 0) return;
    baseYRef.current = centerTargetFor(track, box, gi, topsRef, geoEpoch);
    kickRef.current?.();
    if (!yReadyRef.current || snapPendingRef.current) {
      // 首次进入 / 换歌 / 进度跳变：直接落位，不滚动（文档 §10.2.3）
      snapPendingRef.current = false;
      yRef.current = baseYRef.current;
      tweenRef.current = null;
      lastFrameRef.current = 0;
      lastPxRef.current = null; // 强制重写 transform：值没变的话下面会跳过这一帧
      yReadyRef.current = true;
    }
  }, [scrollGroup, lyrics, open, geoEpoch]);

  // 尺寸变化（拖窗口 / 进出最大化 / 字号切换）后歌词区高度变了，基准要重量一次。
  // 不动 yRef，交给补间自己滑过去，避免瞬移。
  useEffect(() => {
    const box = lyricsBoxRef.current;
    if (!box || !open) return;
    const ro = new ResizeObserver(() => {
      const track = trackRef.current;
      const cur = scrollGroupRef.current;
      const gi = track && cur < 0 && track.children.length > 0 ? 0 : cur;
      if (!track || gi < 0) return;
      baseYRef.current = centerTargetFor(track, box, gi, topsRef, geoEpoch);
      kickRef.current?.(); // 停帧时基准位变了，得叫循环回来滑过去
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [open]);


  // §11「显示实际字体来源」：把每行拆成"主字体出的字"和"回退来的字"，各挂各的链
  const showSource = readShowSource(settingsValues);
  const resourceById = useMemo(() => new Map(fontResources.map((r) => [r.id, r])), [fontResources]);
  const primaryOf = useCallback(
    (id: FontProfileId) => {
      const pid = profiles[id].primaryFontId;
      return pid ? resourceById.get(pid) ?? null : null;
    },
    [profiles, resourceById]
  );
  const lineRuns = useMemo(() => {
    if (!showSource) return null;
    return lines.map((line, i) => {
      const profile = lineProfiles[i] ?? "latin";
      // 这一行所属档案没导入字体 → 整行本来就是系统链，标不出更细的来源，不拆
      if (!primaryOf(profile)) return null;
      return splitLineRuns(line.text, profile, primaryOf, true);
    });
  }, [showSource, lines, lineProfiles, primaryOf]);

  /** 一段文字该挂哪条链：主字体覆盖的段只挂主字体，缺字段挂整条回退链 */
  const runCss = useCallback(
    (run: LineRun) => {
      const chain = stacks[run.profile];
      if (run.fallback) return chain.css;
      const first = chain.userFontIds[0];
      return first ? '"' + fontFamilyName(first) + '", sans-serif' : chain.css;
    },
    [stacks]
  );

  /**
   * 点句跳转的唯一出口。抽成稳定引用是为了让 LyricGroup 能 memo：
   * 每个 <p onClick> 都由子组件自己用 onSeekMs(headMs) 组装，父级不再每次 render 新造箭头函数。
   */
  const onSeekMs = useCallback(
    (ms: number) => {
      wheelYRef.current = 0;
      snapPendingRef.current = true; // 点哪句就立刻停在哪句，不给补间滑过去的余地
      setBlurOff(false); // 点句跳转 = 结束手动浏览，模糊立刻回来
      void seek(ms / 1000);
    },
    [seek]
  );

  /**
   * 歌词页完全展开后，把被它**完全盖住**的主界面隐藏。
   *
   * 主界面并不是静止的（侧栏/播放条的毛玻璃、卡片……），每产一帧整窗都要重新合成一次。
   * 主界面既然看不见，就不该参与合成。
   * ⚠️ 时序是关键：必须"展开完成后才隐藏、退场一开始就恢复"，否则合成器会丢掉主界面的
   *    绘制结果，重新可见时要重画一帧 = 返回时闪一下。
   */
  useLayoutEffect(() => {
    const shell = document.querySelector(".app-shell");
    if (!shell) return;
    if (mounted && open && !phase) shell.classList.add("lyrics-covered");
    return () => shell.classList.remove("lyrics-covered");
  }, [mounted, open, phase]);

  if (!mounted) return null;

  return (
    <div
      className={
        "lyrics-page" +
        (staged ? " staged" : "") +
        (phase === "in" ? " entering" : phase === "out" ? " leaving" : "") +
        (cleared ? " cleared" : "") +
        " is-dark" +
        (swapping ? " swapping" : "")
      }
      ref={pageRef}
      style={
        {
          // 六份档案的链暴露成 CSS 变量：行上直接引用，诊断色的图例也能取用
          "--lf-zhHans": stacks.zhHans.css,
          "--lf-zhHant": stacks.zhHant.css,
          "--lf-ja": stacks.ja.css,
          "--lf-ko": stacks.ko.css,
          "--lf-latin": stacks.latin.css,
          "--lf-symbols": stacks.symbols.css,
          "--lf-main": stacks[songProfile].css,
          "--lyric-size": String(lyricFontSize),
          "--lyric-weight": String(lyricFontWeight),
          "--sl-active-scale": String(lyricActiveScale),
          // 页面基色 = 封面平均色按 --sl-wash 洗白后的结果；白纱强度同样来自封面亮度。
          "--sl-page-rgb": look.pageRgb,
          "--sl-wash": String(look.wash),
        } as CSSProperties
      }
    >
      {/* 全窗底色：稳定态盖满整窗，负责"圆角处不漏白线/黑线"。只做 opacity 淡入 */}
      <div className="sl-veil" ref={veilRef} aria-hidden="true" />
      {/* 进场圆盘：只做小范围绽开（--disc-scale ≈1.45），纹理由此控制在 900px 级 */}
      <div className="sl-disc" ref={discRef} aria-hidden="true" />

      <div className={"sl-stage" + (immersive ? " is-immersive" : "")} ref={stageRef}>
        {/* 背景三层里的第二层：流光 */}
        <FlowingLight texture={look.texture} base={look.avgCss} />

        <header className="sl-topbar">
          <div className="sl-back">
            <button className="sl-icon-btn" aria-label="返回" onClick={closeLyrics}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 5 8 12l7 7" />
              </svg>
            </button>
          </div>
          {/* 曲目信息常显：海报已经去掉了，这里是唯一的"正在放什么"提示 */}
          <div className="sl-head">
            <strong>{current?.title ?? "没有正在播放的歌曲"}</strong>
            <span>{current?.artist ?? "从音乐库选择一首歌"}</span>
          </div>
          <div className="sl-actions">
            {/* 歌曲级语言覆盖（§5.4）：只影响这一首，不动六份档案的配置 */}
            {hasLyrics && (
              <LangPicker
                label="语言"
                title="这首歌按哪种语言排版。默认按歌词统计判定，判错时可以只改这一首。"
                ariaLabel={"这首歌的歌词语言：" + (overrideProfile ? PROFILES[overrideProfile].label : "自动")}
                value={overrideProfile ?? OVERRIDE_AUTO}
                options={[
                  { id: OVERRIDE_AUTO, label: "自动（" + PROFILES[songProfile].label + "）" },
                  ...PROFILE_LIST.map((p) => ({ id: p.id as string, label: p.label })),
                ]}
                onOpenChange={setLangMenuOpen}
                onChange={(value) => {
                  const id = (value || null) as FontProfileId | null;
                  void writeSetting(OVERRIDES_KEY, serializeOverrides(setOverride(overrides, trackKey, id)));
                  toast(
                    id
                      ? "这首歌的歌词改用「" + PROFILES[id].label + "」的字体"
                      : "这首歌的歌词语言改回自动判定",
                    "info",
                  );
                }}
              />
            )}
            <button
              className="sl-icon-btn"
              aria-label={cleared ? "退出沉浸" : "沉浸清屏"}
              onClick={() => setCleared((v) => !v)}
            >
              <Icon name={cleared ? "eye-off" : "eye"} />
            </button>
          </div>
        </header>

        {/* 沉浸清屏：只保留一个极简退出按钮（也可按 Esc） */}
        {cleared && (
          <button className="sl-clear-exit" aria-label="退出沉浸" onClick={() => setCleared(false)}>
            <Icon name="minimize" />
          </button>
        )}

        <main className="sl-lyrics-area">
          <section className="sl-lyrics" ref={lyricsBoxRef}>
            {loading ? (
              <div className="sl-empty">
                <span className="sl-spinner" />
                <div className="sl-empty-title">正在读取歌词…</div>
              </div>
            ) : !hasLyrics ? (
              <div className="sl-empty">
                <div className="sl-empty-glyph">♫</div>
                <div className="sl-empty-title">
                  {current ? "这首歌还没有歌词" : "还没有正在播放的歌曲"}
                </div>
                <div className="sl-empty-sub">
                  把同名歌词文件（<code>{current ? current.title : "歌曲名"}.lrc</code>）放到歌曲旁边，
                  <br />
                  或把歌词写进音乐文件的内嵌标签，这里就会自动显示。
                </div>
              </div>
            ) : (
              <div className="sl-track" ref={trackRef}>
                {!synced && <p className="sl-note">纯文本歌词 · 无时间轴</p>}
                {groups.map((group, gi) => {
                  // 焦点句：正常就是当前句；前奏期间（activeGroup 还是 -1）取第 0 句，
                  // 否则开头几十秒所有行都不模糊、alpha 全 1，看着像"模糊没加载出来"
                  const focus = activeGroup >= 0 ? activeGroup : groups.length > 0 ? 0 : -1;
                  // 每组的 props 都是原始值或引用稳定的数组（lines / lineRuns / lineProfiles /
                  // lineStacks / runCss 全部 memo 过）—— 焦点移动时远处那些组浅比较相等，
                  // LyricGroup 直接跳过渲染，切句只剩焦点附近 ±5 组要重算。
                  return (
                    <LyricGroup
                      key={"g" + gi}
                      indices={group}
                      lines={lines}
                      lineRuns={lineRuns}
                      lineProfiles={lineProfiles}
                      lineStacks={lineStacks}
                      songProfile={songProfile}
                      synced={synced}
                      active={gi === activeGroup}
                      // 尺寸强调跟滚动目标，颜色强调跟时间戳（见 SCROLL_LEAD_MS 的注释）
                      lead={gi === scrollGroup}
                      near={focus >= 0 && Math.abs(gi - focus) <= 2}
                      blur={blurFor(gi, focus)}
                      alpha={alphaFor(gi, focus)}
                      runCss={runCss}
                      onSeekMs={onSeekMs}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </main>

        {/* 底栏直接复用主界面播放条（variant="lyrics"），只把外观改成 Salt 的无卡片样式 */}
        <footer className="lyrics-footer sl-footer">
          <PlayerBar variant="lyrics" />
        </footer>
      </div>
    </div>
  );
}