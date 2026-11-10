// 收听日志：统计模块的唯一数据源。
// 后端 tracks 表只有累计 play_count、没有任何时间戳，所以「日 / 周 / 月 / 年」的时间序列
// 只能由前端自己记账：真正播放的秒数按进度事件的差值累加，每开播一首记一次。
// 记录全部留在本机 localStorage，不做任何网络请求。

import { useSyncExternalStore } from "react";

/** 统计区间：本周 / 本月 / 本年 / 总共 */
export type Scope = "week" | "month" | "year" | "all";

/** 单曲当天的一格账：[开播次数, 收听秒数]（用数组而不是对象，省一半 localStorage） */
export type TrackDay = [plays: number, secs: number];

/** 一天的账：秒数、开播次数、逐曲账 */
export interface DayCount {
  /** 真正听过的秒数（暂停、拖进度条、切歌都不计） */
  s: number;
  /** 开播次数 */
  p: number;
  /** trackId → [次数, 秒数]；超过 MAX_TRACKS_PER_DAY 时淘汰听得最少的 */
  t: Record<string, TrackDay>;
}

export interface ListenLog {
  /** 2：t 从「次数」升级成「[次数, 秒数]」，见 load() 的迁移 */
  v: 2;
  days: Record<string, DayCount>;
  updatedMs: number;
}

export interface Bucket {
  /** 桶的稳定标识：日=YYYY-MM-DD，周=该周周一，月=YYYY-MM，年=YYYY */
  key: string;
  /** 坐标轴上的短标签 */
  label: string;
  /** 悬停时的完整说明 */
  title: string;
  secs: number;
  plays: number;
  /** 桶内出现过的不同曲目数 */
  tracks: number;
}

export interface ScopeSummary {
  buckets: Bucket[];
  /** 区间内的总收听秒数 */
  totalSecs: number;
  /** 区间内的开播次数 */
  totalPlays: number;
  /** 有记录的自然日数（收听天数） */
  activeDays: number;
  /** 区间出现过的不同曲目数 */
  totalTracks: number;
  /** 区间文案，例如「2026年11月8日 – 14日」 */
  rangeLabel: string;
  fromKey: string;
  toKey: string;
}

/** 单曲在某个区间内的合计：听了多久、听过几次 */
export interface TrackTotal {
  trackId: number;
  secs: number;
  plays: number;
}

export const SCOPES: Scope[] = ["week", "month", "year", "all"];

export const SCOPE_LABEL: Record<Scope, string> = {
  week: "本周",
  month: "本月",
  year: "本年",
  all: "总共",
};

const STORAGE_KEY = "oberon.listenLog.v1";
/** 三年，够「最近 6 年」用一段时间又不会撑爆 localStorage */
const KEEP_DAYS = 1095;
const MAX_TRACKS_PER_DAY = 160;
const FLUSH_MS = 4000;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function dayKey(d: Date): string {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 周一为一周之始 */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function emptyLog(): ListenLog {
  return { v: 2, days: {}, updatedMs: Date.now() };
}

function posNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------- 持久化 ----------

function pruneBefore(log: ListenLog, cutoffKey: string): void {
  for (const key of Object.keys(log.days)) {
    if (key < cutoffKey) delete log.days[key];
  }
}

function prune(log: ListenLog, nowMs: number): void {
  pruneBefore(log, dayKey(addDays(startOfDay(new Date(nowMs)), -KEEP_DAYS)));
}

function load(): ListenLog {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyLog();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyLog();
    const src = parsed as { v?: unknown; days?: unknown; updatedMs?: unknown };
    if ((src.v !== 1 && src.v !== 2) || !src.days || typeof src.days !== "object") return emptyLog();
    const days: Record<string, DayCount> = {};
    for (const [key, value] of Object.entries(src.days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      if (!value || typeof value !== "object") continue;
      const day = value as { s?: unknown; p?: unknown; t?: unknown };
      const t: Record<string, TrackDay> = {};
      if (day.t && typeof day.t === "object") {
        for (const [id, cell] of Object.entries(day.t as Record<string, unknown>)) {
          if (!/^\d+$/.test(id)) continue;
          // v1 只记次数（数字）；v2 是 [次数, 秒数]，老数据没有秒数可补，按 0 起
          const plays = Array.isArray(cell) ? posNumber(cell[0]) : posNumber(cell);
          const secs = Array.isArray(cell) ? posNumber(cell[1]) : 0;
          if (plays > 0 || secs > 0) t[id] = [plays, secs];
        }
      }
      days[key] = { s: posNumber(day.s), p: posNumber(day.p), t };
    }
    const log: ListenLog = {
      v: 2,
      days,
      updatedMs: posNumber(src.updatedMs) || Date.now(),
    };
    prune(log, Date.now());
    return log;
  } catch {
    // 数据被外部改坏就当作空账，不能让整个界面白屏
    return emptyLog();
  }
}

const live: ListenLog = load();
/** 每次落盘换一个新对象，useMemo 才能感知到变化（days 内部仍是同一份引用） */
let snapshot: ListenLog = live;
const subscribers = new Set<() => void>();

function emit(): void {
  snapshot = { v: 2, days: live.days, updatedMs: live.updatedMs };
  for (const cb of subscribers) cb();
}

function getSnapshot(): ListenLog {
  return snapshot;
}

export function subscribeListenLog(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function useListenLog(): ListenLog {
  return useSyncExternalStore(subscribeListenLog, getSnapshot, getSnapshot);
}

let dirty = false;
let flushTimer = 0;
let lifecycleBound = false;

function flush(): void {
  if (flushTimer) {
    window.clearTimeout(flushTimer);
    flushTimer = 0;
  }
  if (!dirty) return;
  dirty = false;
  const now = Date.now();
  prune(live, now);
  live.updatedMs = now;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(live));
  } catch {
    // 配额满了就只留最近 400 天再试一次，仍失败就仅存内存，不打断播放
    pruneBefore(live, dayKey(addDays(startOfDay(new Date(now)), -400)));
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(live));
    } catch {
      /* 放弃落盘 */
    }
  }
  emit();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    flush();
  }, FLUSH_MS);
}

/** 关窗、切后台时立刻落盘，避免最后几秒丢失 */
function bindLifecycle(): void {
  if (lifecycleBound) return;
  lifecycleBound = true;
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flush();
  });
}

// ---------- 记账 ----------

function ensureDay(key: string): DayCount {
  const existing = live.days[key];
  if (existing) return existing;
  const created: DayCount = { s: 0, p: 0, t: {} };
  live.days[key] = created;
  return created;
}

function trimTracks(day: DayCount): void {
  const ids = Object.keys(day.t);
  if (ids.length <= MAX_TRACKS_PER_DAY) return;
  ids.sort((a, b) => {
    const x = day.t[a];
    const y = day.t[b];
    return (x[1] + x[0] * 60) - (y[1] + y[0] * 60);
  });
  for (const id of ids.slice(0, ids.length - MAX_TRACKS_PER_DAY)) delete day.t[id];
}

function trackCell(day: DayCount, id: string): TrackDay {
  const existing = day.t[id];
  if (existing) return existing;
  const created: TrackDay = [0, 0];
  day.t[id] = created;
  return created;
}

/** 一首刚开始播：次数 +1，逐曲次数 +1，立刻落盘 */
export function recordPlay(trackId: number): void {
  if (!Number.isFinite(trackId)) return;
  const day = ensureDay(dayKey(new Date()));
  const id = String(Math.trunc(trackId));
  day.p += 1;
  trackCell(day, id)[0] += 1;
  trimTracks(day);
  dirty = true;
  bindLifecycle();
  flush();
}

let lastTrackId: number | null = null;
let lastPos = 0;

/**
 * 进度事件（约 800ms 一次，仅播放中发送）：用相邻两次位置差累加真实收听秒数。
 * 只接受 0.05~3 秒的向前小步，拖进度条、切歌、设备恢复造成的大跳变一律丢弃。
 */
export function noteProgress(trackId: number, positionSecs: number): void {
  if (!Number.isFinite(positionSecs)) return;
  if (trackId !== lastTrackId) {
    lastTrackId = trackId;
    lastPos = positionSecs;
    return;
  }
  const delta = positionSecs - lastPos;
  lastPos = positionSecs;
  if (!(delta > 0.05) || delta > 3) return;
  const day = ensureDay(dayKey(new Date()));
  day.s += delta;
  // 逐曲也记秒数，详细数据里每首歌的时长才不是凭空摊出来的
  trackCell(day, String(Math.trunc(trackId)))[1] += delta;
  dirty = true;
  bindLifecycle();
  scheduleFlush();
}

// ---------- 聚合 ----------

function bucketKeyOf(dayKey_: string, scope: Scope): string {
  // 周 / 月是「一天一根柱子」，年是「一个月一根」，总共是「一年一根」
  if (scope === "week" || scope === "month") return dayKey_;
  if (scope === "year") return dayKey_.slice(0, 7);
  return dayKey_.slice(0, 4);
}

interface BucketFrame {
  buckets: Bucket[];
  fromKey: string;
  toKey: string;
  rangeLabel: string;
}

function dayBucket(d: Date): Bucket {
  return {
    key: dayKey(d),
    label: String(d.getDate()),
    title: d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + WEEKDAYS[d.getDay()],
    secs: 0,
    plays: 0,
    tracks: 0,
  };
}

function buildFrame(scope: Scope, log: ListenLog, now: Date): BucketFrame {
  const today = startOfDay(now);
  if (scope === "week") {
    const monday = startOfWeek(today);
    const buckets: Bucket[] = [];
    for (let i = 0; i < 7; i++) buckets.push(dayBucket(addDays(monday, i)));
    const sunday = addDays(monday, 6);
    const rangeLabel =
      monday.getMonth() === sunday.getMonth()
        ? monday.getFullYear() + "年" + (monday.getMonth() + 1) + "月" + monday.getDate() + "日 – " + sunday.getDate() + "日"
        : monday.getFullYear() + "年" + (monday.getMonth() + 1) + "月" + monday.getDate() + "日 – " + (sunday.getMonth() + 1) + "月" + sunday.getDate() + "日";
    return { buckets, fromKey: dayKey(monday), toKey: dayKey(sunday), rangeLabel };
  }
  if (scope === "month") {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const buckets: Bucket[] = [];
    for (let i = 0; i < days; i++) buckets.push(dayBucket(addDays(first, i)));
    return {
      buckets,
      fromKey: dayKey(first),
      toKey: dayKey(addDays(first, days - 1)),
      rangeLabel: today.getFullYear() + "年" + (today.getMonth() + 1) + "月",
    };
  }
  if (scope === "year") {
    const year = today.getFullYear();
    const buckets: Bucket[] = [];
    for (let m = 0; m < 12; m++) {
      buckets.push({
        key: year + "-" + pad2(m + 1),
        label: m + 1 + "月",
        title: year + "年" + (m + 1) + "月",
        secs: 0,
        plays: 0,
        tracks: 0,
      });
    }
    return { buckets, fromKey: year + "-01-01", toKey: year + "-12-31", rangeLabel: year + "年" };
  }
  // 总共：从最早一条记录的那年铺到今年，最多 8 根柱子
  const keys = Object.keys(log.days).sort();
  const firstYear = keys.length > 0 ? Number(keys[0].slice(0, 4)) : today.getFullYear();
  const lastYear = today.getFullYear();
  const startYear = Math.max(firstYear, lastYear - 7);
  const buckets: Bucket[] = [];
  for (let y = startYear; y <= lastYear; y++) {
    buckets.push({ key: String(y), label: String(y), title: y + " 年", secs: 0, plays: 0, tracks: 0 });
  }
  const rangeLabel =
    startYear === lastYear ? lastYear + "年" : "全部记录 · " + startYear + " – " + lastYear;
  return { buckets, fromKey: startYear + "-01-01", toKey: lastYear + "-12-31", rangeLabel };
}

export function summarizeScope(log: ListenLog, scope: Scope, now: Date = new Date()): ScopeSummary {
  const frame = buildFrame(scope, log, now);
  const { buckets } = frame;
  const indexOf = new Map<string, number>();
  buckets.forEach((b, i) => indexOf.set(b.key, i));
  const sets: Set<number>[] = buckets.map(() => new Set<number>());
  const rangeTracks = new Set<number>();
  let totalSecs = 0;
  let totalPlays = 0;
  let activeDays = 0;
  for (const [key, day] of Object.entries(log.days)) {
    if (key < frame.fromKey || key > frame.toKey) continue;
    if (day.s > 0) activeDays += 1;
    totalSecs += day.s;
    totalPlays += day.p;
    const idx = indexOf.get(bucketKeyOf(key, scope));
    for (const id of Object.keys(day.t)) {
      const trackId = Number(id);
      rangeTracks.add(trackId);
      if (idx !== undefined) sets[idx].add(trackId);
    }
    if (idx === undefined) continue;
    buckets[idx].secs += day.s;
    buckets[idx].plays += day.p;
  }
  buckets.forEach((b, i) => {
    b.tracks = sets[i].size;
  });
  return {
    buckets,
    totalSecs,
    totalPlays,
    activeDays,
    totalTracks: rangeTracks.size,
    rangeLabel: frame.rangeLabel,
    fromKey: frame.fromKey,
    toKey: frame.toKey,
  };
}

/**
 * 当前区间内每首歌的合计，按「听的总时长」从多到少排；
 * 时长相同再看次数，最后用 id 兜底保证顺序稳定。
 */
export function trackTotals(log: ListenLog, scope: Scope, now: Date = new Date()): TrackTotal[] {
  const frame = buildFrame(scope, log, now);
  const startKey = frame.fromKey;
  const endKey = frame.toKey;
  const totals = new Map<number, TrackTotal>();
  for (const [key, day] of Object.entries(log.days)) {
    if (key < startKey || key > endKey) continue;
    for (const [id, cell] of Object.entries(day.t)) {
      const trackId = Number(id);
      if (!Number.isFinite(trackId)) continue;
      const row = totals.get(trackId);
      if (row) {
        row.plays += cell[0];
        row.secs += cell[1];
      } else {
        totals.set(trackId, { trackId, secs: cell[1], plays: cell[0] });
      }
    }
  }
  return [...totals.values()].sort(
    (a, b) => b.secs - a.secs || b.plays - a.plays || a.trackId - b.trackId,
  );
}

/** 「3 小时 24 分」/「12 分钟」/「48 秒」 */
export function fmtDuration(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? h + " 小时 " + m + " 分" : h + " 小时";
  if (m > 0) return m + " 分钟";
  return total + " 秒";
}

/** 大字号读数：「25 小时 15 分钟」/「15 分钟」/「48 秒」 */
export function fmtDurationLong(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? h + " 小时 " + m + " 分钟" : h + " 小时";
  if (m > 0) return m + " 分钟";
  return total + " 秒";
}

