// 歌词引擎（整句全亮）：时间轴索引 + 播放时钟。
//
// 设计依据：《整句全亮歌词引擎_设计文档.md》（netease_lyric_re）。
// 这一层刻意做成**纯逻辑**，不碰 DOM、不碰 React —— 因为它是"准不准"的唯一来源，
// 必须能在 Node 里被断言（scripts/check-engine.mjs）。
//
// 只有三个量需要维护：
//   · starts[]      每组的起始毫秒，**严格递增**；左闭右开 [start, nextStart)
//   · 当前组下标     唯一整数状态（-1 = 前奏，还没有第一句）
//   · tick          rAF（≈16.7ms，采样误差 ≈ tick/2 = 8ms）
//
// 为什么不要 end/duration：闭区间 [start, end] 在切句瞬间会两行同时"亮"，
// 而 end 是脏数据时（重叠、缺失、倒序）整个高亮就崩了。左闭右开只有一个边界，
// 任何时刻至多一组是当前组 —— 文档不变式 G1/G2/G6。

/** 上报超前多少才算"卡顿后追帧 / 往前拖"（毫秒）。正常 IPC 抖动只有几十毫秒 */
export const CLOCK_LEAD_TOL_MS = 300;
/** 上报落后多少才算"真的往回跳"（切歌重播 / 大跨度回拖） */
export const CLOCK_LAG_JUMP_MS = 1200;
/** 上报比锚点往回不足这个量的抖动直接丢掉（文档 §7.2 回退抑制） */
export const CLOCK_BACK_JUMP_MS = 250;
/** 判定为跳变、且偏差超过这个量时，位移直接落位（不播位移补间） */
export const CLOCK_SNAP_MS = 400;
/** 位置上报的名义率容差：超过它就不是抖动，而是位置链的率误差 */
export const RATE_TOL = 0.0015;
/** 率观测窗口（毫秒）：太短的窗口噪声大，6s 刚好把 800ms 一次的台阶抹平 */
export const RATE_WINDOW_MS = 6000;

/**
 * 左闭右开二分：返回最后一个 `start <= t` 的下标，-1 表示还没到第一句。
 *
 * 不用线性扫描：rAF 每帧要算两次（高亮一次、滚动目标一次），二分是 8 次比较，
 * 恒定开销；线性扫描在"播到 3 分钟处"反而更慢。
 */
export function indexAt(starts: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 带游标的索引推进：正常播放时一帧最多跨一组，前后走一两步就够。
 * 结果与 indexAt 完全一致，只是把 8 次比较压成 2 次。
 * 注意：换歌 / 拖动进度这种大步跳变仍然是线性的，所以 cursor 必须来自上一帧
 * （我们已经维护的 activeGroupRef / scrollGroupRef 正好就是）。
 */
export function advanceIndex(starts: readonly number[], t: number, cursor: number): number {
  const n = starts.length;
  if (n === 0) return -1;
  let i = cursor;
  if (i < -1) i = -1;
  if (i > n - 1) i = n - 1;
  while (i + 1 < n && starts[i + 1] <= t) i++;
  while (i >= 0 && starts[i] > t) i--;
  return i;
}

/** 一次位置上报的判定结果 */
export interface ClockSample {
  /** 是否判定为跳变（拖动 / 切歌 / 暂停恢复 / 追帧） */
  snapped: boolean;
  /** 上报比墙钟超前多少毫秒（负 = 落后） */
  aheadMs: number;
  /** 位置链的名义率（≈1.000；偏离说明上报不可信） */
  rate: number;
}

/**
 * 播放时钟：锚点插值 + 只向前对齐 + 回退抑制。
 *
 * 老实现每次位置下发都重锚（secs=position, at=now），有两个代价：
 * ① 进度事件约 800ms 一次，位置是台阶，全靠 1× 外推抹平。只要上报值本身比实际出声
 *    慢一点点（后端任何一处采样率/声道声明误差都会变成率误差），重锚就把误差原样
 *    吃进来，并且随播放时间越攒越多 —— 前半首还准、后半首慢半秒，正是这个形态。
 *    但声音是设备按 1× 消费采样播出来的：**墙钟才是它的时间轴，率只能取 1.0**。
 * ② 上报抖动（几十毫秒）每 800ms 把整列文字拽一下。
 *
 * 所以：墙钟恒以 1× 前进，上报只在「明显超前」（卡顿后追帧）、「明显落后/回拖」
 * （拖动进度、切歌、设备重建）时硬对齐；单纯落后于墙钟时**不回拉**。
 */
export class LyricClock {
  /** 锚点：secs 是 nowMs 时刻的歌词时间；playing 时按 1× 外推 */
  private anchor = { secs: 0, at: 0, playing: false };
  /** 上报率观测样本：窗口内 Δ位置 / Δ墙钟 */
  private sample = { at: 0, pos: -1, rate: 1, warnedAt: 0 };

  /** 位置链的名义率（≈1） */
  get rate(): number {
    return this.sample.rate;
  }

  get playing(): boolean {
    return this.anchor.playing;
  }

  /** 当前歌词时间（秒）。每帧调用，不做任何分配。 */
  now(nowMs: number): number {
    const a = this.anchor;
    return a.playing ? a.secs + (nowMs - a.at) / 1000 : a.secs;
  }

  /** 换歌 / 从头开始：清掉锚点与率样本（率样本跟"这一条播放链"走，换歌必须作废） */
  reset(secs: number, nowMs: number): void {
    this.anchor = { secs, at: nowMs, playing: false };
    this.sample = { at: nowMs, pos: -1, rate: 1, warnedAt: 0 };
  }

  /** 收一次播放位置上报（秒）。内部决定是否重锚，调用方只管要不要瞬移位移。 */
  report(secs: number, playing: boolean, nowMs: number): ClockSample {
    const prev = this.anchor;
    const tick = this.now(nowMs);
    const s = this.sample;

    // —— 上报率观测：≥6s 窗口。偏差超过 0.15% 不是抖动，是位置链的率误差。
    const jumpedBack = s.pos >= 0 && secs < s.pos - 0.5;
    if (!playing || !prev.playing || s.pos < 0 || jumpedBack) {
      if (s.pos < 0 || jumpedBack) s.rate = 1;
      s.pos = secs;
      s.at = nowMs;
    } else if (secs > s.pos && nowMs - s.at >= RATE_WINDOW_MS) {
      const span = (nowMs - s.at) / 1000;
      s.rate = (secs - s.pos) / span;
      s.pos = secs;
      s.at = nowMs;
      if (Math.abs(s.rate - 1) > RATE_TOL && nowMs - s.warnedAt > 10000) {
        s.warnedAt = nowMs;
        console.warn(
          "[lyrics] 播放位置上报名义率 " +
            s.rate.toFixed(4) +
            "×（应≈1.000）：位置链存在率误差，歌词已改按墙钟对齐，不再跟随上报漂移"
        );
      }
    }
    // 率不可信时禁止按上报往回跳，否则整首歌会被钉在"慢半秒"上
    const lagJump = Math.abs(s.rate - 1) > RATE_TOL ? Infinity : CLOCK_LAG_JUMP_MS;

    const aheadMs = (secs - tick) * 1000;
    let resync =
      !playing ||
      !prev.playing || // 暂停 → 播放：以上报为准
      aheadMs > CLOCK_LEAD_TOL_MS || // 卡顿后追帧 / 往前拖
      aheadMs < -lagJump; // 往后拖 / 切歌重播（确认过的跳变）

    // 回退抑制（文档 §7.2）：上报比锚点往回一点是抖动，丢掉；回退超过 250ms 才是真跳变。
    // 少了这一条，往回拖 400ms 的进度会落进 lagJump 的死区，歌词从此一直比声音早。
    const backMs = (prev.secs - secs) * 1000;
    if (!resync && playing && prev.playing && backMs > CLOCK_BACK_JUMP_MS) resync = true;

    this.anchor = resync
      ? { secs, at: nowMs, playing }
      : // 只更新播放标记，锚点原样保留：墙钟继续按 1× 走，不被落后的上报拽回去
        { secs: prev.secs, at: prev.at, playing };

    return { snapped: resync && Math.abs(aheadMs) >= CLOCK_SNAP_MS, aheadMs, rate: s.rate };
  }
}
