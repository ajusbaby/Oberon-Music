// 歌词与声音的同步账：三笔偏移，全部用加号记（t 越大歌词越早）。
//
//   t = position() + fileOffset + userOffset + latency
//     · fileOffset：歌词文件自己写的修正（LRC 的 [offset:]），后端解析时已经并进 timeMs；
//     · userOffset：本文件的全部内容 —— 全局一个、每首歌一个，用户手调的；
//     · latency   ：设备出声延迟（有线 20–60ms、蓝牙 120–300ms），后端目前还没上报，
//                   先留 0 占位；接上之后只改 DEVICE_LATENCY_MS 这一处。
//
// 为什么要两个 userOffset：
//   · 全局那份修"整套系统性的偏移"（比如蓝牙耳机整体 +150ms）；
//   · 每首歌那份修"这首歌的歌词本身写歪了"（不同来源的 LRC 差几百毫秒很常见），
//     换歌必须各自记住 —— 文档反模式 A12 就是"offset 换歌不重置，把误差带过去"。

/** 全局同步偏移（毫秒，正 = 歌词提前） */
export const SYNC_OFFSET_KEY = "lyricSyncOffsetMs";
/** 每首歌的同步偏移：JSON 对象 {"<trackId>": 毫秒} */
export const PER_TRACK_KEY = "lyricSyncOffsets";
/** 手调范围（毫秒）：超过 3 秒基本就是歌词文件本身对不上，不是"同步"能修的 */
export const SYNC_LIMIT_MS = 3000;
/** 设备延迟占位（毫秒）。后端将来上报输出延迟时改这里，别散落在组件里 */
export const DEVICE_LATENCY_MS = 0;

function toMs(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function clampSyncOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(-SYNC_LIMIT_MS, Math.min(SYNC_LIMIT_MS, Math.round(ms)));
}

/** 全局偏移 */
export function readGlobalOffset(values: Record<string, string> | null | undefined): number {
  return clampSyncOffset(toMs(values?.[SYNC_OFFSET_KEY]));
}

function parseMap(values: Record<string, string> | null | undefined): Record<string, number> {
  const raw = values?.[PER_TRACK_KEY];
  if (!raw) return {};
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n !== 0) out[k] = clampSyncOffset(n);
    }
    return out;
  } catch {
    return {};
  }
}

/** 这首歌自己的偏移（没有就是 0） */
export function readTrackOffset(
  values: Record<string, string> | null | undefined,
  trackId: number | null | undefined
): number {
  if (trackId == null) return 0;
  return parseMap(values)[String(trackId)] ?? 0;
}

/** 合成后的歌词时间偏移（毫秒）：全局 + 本曲 + 设备 */
export function readSyncOffset(
  values: Record<string, string> | null | undefined,
  trackId: number | null | undefined
): number {
  return readGlobalOffset(values) + readTrackOffset(values, trackId) + DEVICE_LATENCY_MS;
}

/** 把某个 trackId 的偏移写成 settings 里的 JSON 字符串（0 = 删掉这条记录） */
export function withTrackOffset(
  values: Record<string, string> | null | undefined,
  trackId: number,
  ms: number
): string {
  const map = parseMap(values);
  const v = clampSyncOffset(ms);
  if (v === 0) delete map[String(trackId)];
  else map[String(trackId)] = v;
  return JSON.stringify(map);
}

/** 界面上显示用：+150ms / -80ms / 0ms */
export function formatOffset(ms: number): string {
  if (!ms) return "0ms";
  return (ms > 0 ? "+" : "") + ms + "ms";
}
