// 收听日志：统计模块的唯一数据源。
// 后端 tracks 表只有累计 play_count、没有任何时间戳，所以「日 / 周 / 月 / 年」的时间序列
// 只能由前端自己记账：真正播放的秒数按进度事件的差值累加，每开播一首记一次。
//
// 账本落在哪：**Rust 侧的 listening.json**（app_data 一份、文档目录镜像一份），
// localStorage 只当作「进程猝死前的快速缓存」。这么分是因为 localStorage 住在 WebView2 的
// profile 里，清理工具 / 重置系统 / 「删除应用数据」的卸载器都会顺手带走它，
// 而且它的键用的是自增 trackId —— 重装后重扫曲库 id 会重新分配，历史明细就指到别的歌上了。
//
// 现在的键是 trackKey = FNV-1a 64(规范化路径)，另外顺手存下每首歌的路径 / 标题 / 艺术家：
// 曲库重建、文件搬家、甚至整个曲库都不在了，统计仍然认得「这是哪首歌」。

import { useSyncExternalStore } from "react";
import * as api from "../api/ipc";

/** 统计区间：本周 / 本月 / 本年 / 总共 */
export type Scope = "week" | "month" | "year" | "all";

/** 单曲当天的一格账：[开播次数, 收听秒数]（用数组而不是对象，省一半体积） */
export type TrackDay = [plays: number, secs: number];

/** 曲目的稳定身份：路径规范化后的 FNV-1a 64，16 位小写十六进制 */
export type TrackKey = string;

/** 每首歌记下的元数据：曲库没了也要能显示歌名 */
export interface TrackMeta {
  path: string;
  title: string;
  artist: string;
  album: string;
  /** 时长（秒） */
  dur: number;
}

/** 一天的账：秒数、开播次数、逐曲账 */
export interface DayCount {
  /** 真正听过的秒数（暂停、拖进度条、切歌都不计） */
  s: number;
  /** 开播次数 */
  p: number;
  /** trackKey → [次数, 秒数]；超过 MAX_TRACKS_PER_DAY 时淘汰听得最少的 */
  t: Record<string, TrackDay>;
}

export interface ListenLog {
  /** 3：键从自增 trackId 换成路径哈希，并带上 tracks 元数据 */
  v: 3;
  days: Record<string, DayCount>;
  tracks: Record<TrackKey, TrackMeta>;
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
  key: TrackKey;
  secs: number;
  plays: number;
  /** 记账时留下的元数据（曲库已删也还在） */
  meta: TrackMeta | null;
}

/** 记账要的那几个字段：播放器状态里的 current 就能直接给 */
export interface TrackIdentity {
  trackId: number;
  path: string;
  title?: string;
  artist?: string;
  album?: string;
  durationSecs?: number;
}

export const SCOPES: Scope[] = ["week", "month", "year", "all"];

export const SCOPE_LABEL: Record<Scope, string> = {
  week: "本周",
  month: "本月",
  year: "本年",
  all: "总共",
};

/** v3 快速缓存（localStorage）；v1 那个键里躺着旧版按 id 记的账，迁移完才删 */
const CACHE_KEY = "oberon.listenLog.v3";
const LEGACY_KEY = "oberon.listenLog.v1";
const LEGACY_BACKUP_KEY = "oberon.listenLog.v2.backup";
const LEGACY_DONE_KEY = "oberon.listenLog.migrated";

/** 三年，够「最近 6 年」用一段时间又不会把文件撑太大 */
const KEEP_DAYS = 1095;
const MAX_TRACKS_PER_DAY = 160;
const FLUSH_MS = 4000;
/** 写文件的节流：真正落盘不用跟播放进度一样勤 */
const FILE_DEBOUNCE_MS = 1500;
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
  return { v: 3, days: {}, tracks: {}, updatedMs: Date.now() };
}

function posNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ---------- 曲目身份 ----------

/** 路径规范化：统一分隔符 + 大小写折叠（Windows 路径大小写不敏感） */
export function normalizeTrackPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * FNV-1a 64 位 → 16 位小写十六进制。
 * ⚠️ 必须与 Rust src/stats.rs 的 track_key() 逐字节一致（迁移旧账时两边要算出同一个键）。
 */
export function trackKeyOf(path: string): string {
  const bytes = new TextEncoder().encode(normalizeTrackPath(path));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

// ---------- 持久化 ----------

function pruneBefore(log: ListenLog, cutoffKey: string): void {
  for (const key of Object.keys(log.days)) {
    if (key < cutoffKey) delete log.days[key];
  }
  // 元数据只留还被引用的那几首，不然文件会越滚越大
  const used = new Set<string>();
  for (const day of Object.values(log.days)) for (const key of Object.keys(day.t)) used.add(key);
  for (const key of Object.keys(log.tracks)) if (!used.has(key)) delete log.tracks[key];
}

function prune(log: ListenLog, nowMs: number): void {
  pruneBefore(log, dayKey(addDays(startOfDay(new Date(nowMs)), -KEEP_DAYS)));
}

function parseDayCell(cell: unknown): TrackDay | null {
  const plays = Array.isArray(cell) ? posNumber(cell[0]) : posNumber(cell);
  const secs = Array.isArray(cell) ? posNumber(cell[1]) : 0;
  return plays > 0 || secs > 0 ? [plays, secs] : null;
}

function parseTrackMeta(value: unknown): TrackMeta | null {
  if (!value || typeof value !== "object") return null;
  const src = value as Record<string, unknown>;
  const path = str(src.path);
  if (!path) return null;
  return {
    path,
    title: str(src.title),
    artist: str(src.artist),
    album: str(src.album),
    dur: posNumber(src.dur),
  };
}

/** 只认 v3 结构（键已是 trackKey）；旧结构交给 Rust 的 stats_merge 去迁 */
function parseLog(raw: string): ListenLog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const src = parsed as { v?: unknown; days?: unknown; tracks?: unknown; updatedMs?: unknown };
  if (src.v !== 3 || !src.days || typeof src.days !== "object") return null;

  const days: Record<string, DayCount> = {};
  for (const [key, value] of Object.entries(src.days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!value || typeof value !== "object") continue;
    const day = value as { s?: unknown; p?: unknown; t?: unknown };
    const t: Record<string, TrackDay> = {};
    if (day.t && typeof day.t === "object") {
      for (const [trackKey, cell] of Object.entries(day.t as Record<string, unknown>)) {
        const parsedCell = parseDayCell(cell);
        if (parsedCell) t[trackKey] = parsedCell;
      }
    }
    days[key] = { s: posNumber(day.s), p: posNumber(day.p), t };
  }

  const tracks: Record<TrackKey, TrackMeta> = {};
  if (src.tracks && typeof src.tracks === "object") {
    for (const [key, value] of Object.entries(src.tracks as Record<string, unknown>)) {
      const meta = parseTrackMeta(value);
      if (meta) tracks[key] = meta;
    }
  }

  const log: ListenLog = { v: 3, days, tracks, updatedMs: posNumber(src.updatedMs) || Date.now() };
  prune(log, Date.now());
  return log;
}

function readCache(): ListenLog {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return (raw && parseLog(raw)) || emptyLog();
  } catch {
    return emptyLog();
  }
}

function writeCache(): void {
  try {
    window.localStorage.setItem(CACHE_KEY, serialize(live));
  } catch {
    // 缓存写不进去不算事：文件才是权威副本
  }
}

function serialize(log: ListenLog): string {
  return JSON.stringify(log);
}

/** 旧版（v1 / v2，键是自增 trackId）的原始文本；迁移完就删 */
function readLegacy(): string | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown } | null;
    if (!parsed || (parsed.v !== 1 && parsed.v !== 2)) return null;
    return raw;
  } catch {
    return null;
  }
}

const live: ListenLog = readCache();
/** 每次落盘换一个新对象，useMemo 才能感知到变化（days 内部仍是同一份引用） */
let snapshot: ListenLog = { v: 3, days: live.days, tracks: live.tracks, updatedMs: live.updatedMs };
const subscribers = new Set<() => void>();

function emit(): void {
  snapshot = { v: 3, days: live.days, tracks: live.tracks, updatedMs: live.updatedMs };
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

/** 启动合并期间又记了几笔账：合并结果落地前要再并一次，不能把它盖掉 */
let localWrites = 0;

let dirty = false;
let flushTimer = 0;
let fileTimer = 0;
let fileInFlight = false;
let filePending = false;
let lifecycleBound = false;

function pruneNow(): void {
  prune(live, Date.now());
}

function flush(): void {
  if (flushTimer) {
    window.clearTimeout(flushTimer);
    flushTimer = 0;
  }
  if (!dirty) return;
  dirty = false;
  pruneNow();
  live.updatedMs = Date.now();
  writeCache();
  emit();
  scheduleFileWrite();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    flush();
  }, FLUSH_MS);
}

function scheduleFileWrite(): void {
  if (fileTimer) return;
  fileTimer = window.setTimeout(() => {
    fileTimer = 0;
    void pushToFile(false);
  }, FILE_DEBOUNCE_MS);
}

/** 把当前账本推给 Rust（主副本 + 节流的镜像副本）。失败不打断播放，只是下次再试。 */
async function pushToFile(forceMirror: boolean): Promise<void> {
  if (fileInFlight) {
    filePending = true;
    return;
  }
  fileInFlight = true;
  try {
    await api.statsWrite(serialize(live), forceMirror);
  } catch {
    // 没有 Tauri（浏览器里预览）或写盘失败：缓存里那份还在
  } finally {
    fileInFlight = false;
    if (filePending) {
      filePending = false;
      void pushToFile(forceMirror);
    }
  }
}

/** 关窗、切后台时立刻落盘，避免最后几秒丢失 */
function bindLifecycle(): void {
  if (lifecycleBound) return;
  lifecycleBound = true;
  const save = () => {
    flush();
    void pushToFile(true);
  };
  window.addEventListener("pagehide", save);
  window.addEventListener("beforeunload", save);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) save();
    });
  }
}

/**
 * 启动时把三份数据并成一份：本地缓存 + 旧版 id 账 + 文件（主 / 镜像）。
 * 合并交给 Rust：只有它知道旧 trackId 现在对应哪个路径。
 */
export async function initListenLog(): Promise<void> {
  bindLifecycle();
  const legacy = readLegacy();
  const parts: string[] = [serialize(live)];
  if (legacy) {
    // 万一合并失败，原始数据还留一份，用户不会因为一次迁移丢掉整本账
    try {
      window.localStorage.setItem(LEGACY_BACKUP_KEY, legacy);
    } catch {
      /* 备份写不进去也继续，合并本身不依赖它 */
    }
    parts.push(legacy);
  }

  let fileJson: string | null = null;
  try {
    const read = await api.statsRead();
    fileJson = read.json;
  } catch {
    fileJson = null;
  }
  if (fileJson) parts.push(fileJson);

  const marks = localWrites;
  try {
    const merged = await api.statsMerge(parts);
    // 合并是异步的；这期间播放器可能已经记了新账（用户上一秒就在听歌），再并一次
    const json = localWrites !== marks ? (await api.statsMerge([merged.json, serialize(live)])).json : merged.json;
    const next = parseLog(json);
    if (next) {
      live.days = next.days;
      live.tracks = next.tracks;
      live.updatedMs = Math.max(next.updatedMs, Date.now());
      emit();
    }
    // 先把文件写出去（权威副本），再动 localStorage —— 两个存储互不依赖，
    // 任何一边出问题都不该连带另一边（例如另一个实例正占着 WebView2 的 profile）
    await pushToFile(true);
  } catch {
    // 合并失败（例如旧账损坏）：保持现状，至少缓存那份还在
  }
  if (legacy) {
    try {
      window.localStorage.removeItem(LEGACY_KEY);
      window.localStorage.setItem(LEGACY_DONE_KEY, String(Date.now()));
    } catch {
      /* 清不掉旧键也无害：下次启动会再并一遍，合并是幂等的 */
    }
  }
  writeCache();
}

/** 手动备份：立刻把当前账本写到两个位置（设置页「立即备份」用） */
export async function backupStatsNow(): Promise<void> {
  flush();
  pruneNow();
  live.updatedMs = Date.now();
  writeCache();
  emit();
  await pushToFile(true);
}

/** 用一份外部备份替换 / 合并当前账本；返回合并后的天数与曲目数 */
export async function restoreStatsFrom(json: string): Promise<{ days: number; tracks: number }> {
  const merged = await api.statsMerge([serialize(live), json]);
  const next = parseLog(merged.json);
  if (!next) throw new Error("这份备份读不出来");
  live.days = next.days;
  live.tracks = next.tracks;
  live.updatedMs = Date.now();
  writeCache();
  emit();
  await pushToFile(true);
  return { days: merged.days, tracks: merged.tracks };
}

/** 当前账本的 JSON 文本（导出 / 排错用） */
export function statsSnapshotJson(): string {
  return serialize(live);
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
  const keys = Object.keys(day.t);
  if (keys.length <= MAX_TRACKS_PER_DAY) return;
  keys.sort((a, b) => {
    const x = day.t[a];
    const y = day.t[b];
    return x[1] + x[0] * 60 - (y[1] + y[0] * 60);
  });
  for (const key of keys.slice(0, keys.length - MAX_TRACKS_PER_DAY)) delete day.t[key];
}

function trackCell(day: DayCount, key: string): TrackDay {
  const existing = day.t[key];
  if (existing) return existing;
  const created: TrackDay = [0, 0];
  day.t[key] = created;
  return created;
}

/** 记下 / 更新一首歌的身份信息（歌名、艺术家变了也不怕） */
function rememberMeta(key: string, identity: TrackIdentity): void {
  const prev = live.tracks[key];
  const next: TrackMeta = {
    path: identity.path,
    title: identity.title || prev?.title || "未知曲目",
    artist: identity.artist || prev?.artist || "",
    album: identity.album || prev?.album || "",
    dur: identity.durationSecs && identity.durationSecs > 0 ? identity.durationSecs : prev?.dur ?? 0,
  };
  live.tracks[key] = next;
}

function keyFor(identity: TrackIdentity): string | null {
  if (!identity.path) return null;
  return trackKeyOf(identity.path);
}

/** 一首刚开始播：次数 +1，逐曲次数 +1，立刻落盘 */
export function recordPlay(identity: TrackIdentity): void {
  const key = keyFor(identity);
  if (!key) return;
  rememberMeta(key, identity);
  const day = ensureDay(dayKey(new Date()));
  day.p += 1;
  trackCell(day, key)[0] += 1;
  trimTracks(day);
  localWrites += 1;
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
export function noteProgress(identity: TrackIdentity, positionSecs: number): void {
  if (!Number.isFinite(positionSecs)) return;
  if (identity.trackId !== lastTrackId) {
    lastTrackId = identity.trackId;
    lastPos = positionSecs;
    return;
  }
  const delta = positionSecs - lastPos;
  lastPos = positionSecs;
  if (!(delta > 0.05) || delta > 3) return;
  const key = keyFor(identity);
  if (!key) return;
  if (!live.tracks[key]) rememberMeta(key, identity);
  const day = ensureDay(dayKey(new Date()));
  day.s += delta;
  // 逐曲也记秒数，详细数据里每首歌的时长才不是凭空摊出来的
  trackCell(day, key)[1] += delta;
  localWrites += 1;
  dirty = true;
  bindLifecycle();
  scheduleFlush();
}

// ---------- 聚合 ----------

/** 区间窗口：从哪天到哪天、按什么粒度画柱子 */
interface WindowSpec {
  fromKey: string;
  toKey: string;
  mode: "day" | "month" | "year";
  rangeLabel: string;
}

function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => Number.parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

function earliestDayKey(log: ListenLog): string {
  const keys = Object.keys(log.days).sort();
  return keys.length > 0 ? keys[0] : dayKey(new Date());
}

function windowOf(scope: Scope, log: ListenLog): WindowSpec {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;

  if (scope === "week") {
    const from = startOfWeek(today);
    const to = addDays(from, 6);
    const sameMonth = from.getMonth() === to.getMonth();
    const sameYear = from.getFullYear() === to.getFullYear();
    const label = sameMonth
      ? y + "年" + m + "月" + from.getDate() + "日 – " + to.getDate() + "日"
      : sameYear
        ? y + "年" + (from.getMonth() + 1) + "月" + from.getDate() + "日 – " + (to.getMonth() + 1) + "月" + to.getDate() + "日"
        : from.getFullYear() + "年" + (from.getMonth() + 1) + "月" + from.getDate() + "日 – " + to.getFullYear() + "年" + (to.getMonth() + 1) + "月" + to.getDate() + "日";
    return { fromKey: dayKey(from), toKey: dayKey(to), mode: "day", rangeLabel: label };
  }

  if (scope === "month") {
    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 0);
    return { fromKey: dayKey(from), toKey: dayKey(to), mode: "day", rangeLabel: y + "年" + m + "月" };
  }

  if (scope === "year") {
    const from = new Date(y, 0, 1);
    const to = new Date(y, 11, 31);
    return { fromKey: dayKey(from), toKey: dayKey(to), mode: "month", rangeLabel: y + "年" };
  }

  // 总共：从账本里最早的那天算起，按年画柱子
  const first = parseDayKey(earliestDayKey(log));
  const y0 = Math.min(first.getFullYear(), y);
  const label = y0 === y ? y + "年" : y0 + "年 – " + y + "年";
  return { fromKey: dayKey(new Date(y0, 0, 1)), toKey: dayKey(today), mode: "year", rangeLabel: label };
}

function bucketKeyOf(dayKey_: string, mode: WindowSpec["mode"]): string {
  // 周 / 月是「一天一根柱子」，年是「一个月一根」，总共是「一年一根」
  if (mode === "day") return dayKey_;
  if (mode === "month") return dayKey_.slice(0, 7);
  return dayKey_.slice(0, 4);
}

/** 先按窗口把空柱子排好（没记录的那天也要有一根 0 高的柱），再把账填进去 */
function buildBuckets(spec: WindowSpec): Map<string, Bucket & { keys: Set<string> }> {
  const out = new Map<string, Bucket & { keys: Set<string> }>();
  const push = (key: string, label: string, title: string) => {
    out.set(key, { key, label, title, secs: 0, plays: 0, tracks: 0, keys: new Set<string>() });
  };

  if (spec.mode === "day") {
    for (let d = parseDayKey(spec.fromKey); dayKey(d) <= spec.toKey; d = addDays(d, 1)) {
      const key = dayKey(d);
      push(
        key,
        String(d.getDate()),
        d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + WEEKDAYS[d.getDay()],
      );
    }
    return out;
  }

  if (spec.mode === "month") {
    const year = Number.parseInt(spec.fromKey.slice(0, 4), 10);
    for (let mo = 1; mo <= 12; mo += 1) {
      const key = year + "-" + pad2(mo);
      push(key, String(mo), year + "年" + mo + "月");
    }
    return out;
  }

  const first = Number.parseInt(spec.fromKey.slice(0, 4), 10);
  const last = Number.parseInt(spec.toKey.slice(0, 4), 10);
  for (let yr = first; yr <= last; yr += 1) push(String(yr), String(yr), yr + "年");
  return out;
}

/** 区间汇总：柱子 + 四项指标（时长、次数、收听天数、曲目数） */
export function summarizeScope(log: ListenLog, scope: Scope): ScopeSummary {
  const spec = windowOf(scope, log);
  const buckets = buildBuckets(spec);
  const allKeys = new Set<string>();
  let totalSecs = 0;
  let totalPlays = 0;
  let activeDays = 0;

  for (const [dk, day] of Object.entries(log.days)) {
    if (dk < spec.fromKey || dk > spec.toKey) continue;
    const bucket = buckets.get(bucketKeyOf(dk, spec.mode));
    if (!bucket) continue;
    bucket.secs += day.s;
    bucket.plays += day.p;
    for (const key of Object.keys(day.t)) {
      bucket.keys.add(key);
      allKeys.add(key);
    }
    if (day.s > 0 || day.p > 0) activeDays += 1;
  }

  const list: Bucket[] = [];
  for (const bucket of buckets.values()) {
    bucket.tracks = bucket.keys.size;
    bucket.secs = Math.round(bucket.secs * 10) / 10;
    totalSecs += bucket.secs;
    totalPlays += bucket.plays;
    list.push({ key: bucket.key, label: bucket.label, title: bucket.title, secs: bucket.secs, plays: bucket.plays, tracks: bucket.tracks });
  }

  return {
    buckets: list,
    totalSecs: Math.round(totalSecs * 10) / 10,
    totalPlays,
    activeDays,
    totalTracks: allKeys.size,
    rangeLabel: spec.rangeLabel,
    fromKey: spec.fromKey,
    toKey: spec.toKey,
  };
}

/** 区间内的每首歌：听了多久、听过几次，按时长从多到少 */
export function trackTotals(log: ListenLog, scope: Scope): TrackTotal[] {
  const spec = windowOf(scope, log);
  const acc = new Map<string, { secs: number; plays: number }>();
  for (const [dk, day] of Object.entries(log.days)) {
    if (dk < spec.fromKey || dk > spec.toKey) continue;
    for (const [key, cell] of Object.entries(day.t)) {
      const prev = acc.get(key) ?? { secs: 0, plays: 0 };
      prev.secs += cell[1];
      prev.plays += cell[0];
      acc.set(key, prev);
    }
  }

  const rows: TrackTotal[] = [];
  for (const [key, value] of acc) {
    rows.push({
      key,
      secs: Math.round(value.secs * 10) / 10,
      plays: value.plays,
      meta: log.tracks[key] ?? null,
    });
  }
  rows.sort((a, b) => b.secs - a.secs || b.plays - a.plays);
  return rows;
}

/** 「1 小时 23 分」——列表、悬停提示用的紧凑写法；不足一分钟给秒 */
export function fmtDuration(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  if (total < 60) return total + " 秒";
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return m > 0 ? h + " 小时 " + m + " 分" : h + " 小时";
  return m + " 分";
}

/** 大字号总时长：把秒也露出来，读起来更具体 */
export function fmtDurationLong(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return h + " 小时 " + m + " 分";
  if (m > 0) return s > 0 ? m + " 分 " + s + " 秒" : m + " 分";
  return s + " 秒";
}
