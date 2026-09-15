// 封面解析：player_cover(trackId) → data URL，带内存缓存与占位渐变
import { useEffect, useState } from "react";
import * as api from "../api/ipc";
import { pickIndex } from "./format";

/**
 * 封面缓存的内存预算。必须按**字节**设上限而不是按条数 —— 条数与内存是线性关系。
 * 之前这个 Map 无上限、无淘汰，浏览过的封面永不释放，1 万首滚动一遍就是数 GB 的
 * JS 字符串，必然 OOM。现在按预算淘汰最久未用的。
 * 后端已改为返回缩略图（长边 400px JPEG，实测平均 37.6KB，见 scanner::THUMB_MAX），
 * 所以 96MB 预算约能装下 2500 张 —— 覆盖整个曲库绰绰有余，正常浏览不会触发淘汰。
 * （历史：改缩略图之前这里是返回原图的，平均 439KB → 同样预算只够约 165 张。）
 */
const MAX_CACHE_CHARS = 96 * 1024 * 1024; // ≈ 96MB（base64 串在 V8 里约 1 字节/字符）
const MAX_CACHE_ENTRIES = 600;

const cache = new Map<number, string | null>();
const pending = new Map<number, Promise<string | null>>();
let cacheChars = 0;

/** 写入并标记为最近使用；超出预算就淘汰最久未用的 */
function remember(trackId: number, url: string | null) {
  const prev = cache.get(trackId);
  if (prev !== undefined) {
    cache.delete(trackId);
    if (prev) cacheChars -= prev.length;
  }
  cache.set(trackId, url);
  if (url) cacheChars += url.length;
  while ((cacheChars > MAX_CACHE_CHARS || cache.size > MAX_CACHE_ENTRIES) && cache.size > 0) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const v = cache.get(oldest);
    cache.delete(oldest);
    if (v) cacheChars -= v.length;
  }
}

/** 标记为最近使用（LRU 提升）。组件重新挂载时走这条，避免刚看过的封面被淘汰 */
export function touchCover(trackId: number): void {
  const v = cache.get(trackId);
  if (v !== undefined) remember(trackId, v);
}

/** 设计稿风格的占位渐变（无内嵌封面时使用） */
const GRADIENTS = [
  "linear-gradient(135deg, #7A604C, #C2936A)",
  "linear-gradient(135deg, #57334C, #99657C)",
  "linear-gradient(135deg, #38336C, #6257AD 55%, #302A65)",
  "linear-gradient(135deg, #303030, #626269)",
  "linear-gradient(135deg, #8EBABE, #C0D9DB)",
  "linear-gradient(135deg, #6B4E71, #A98BB0)",
  "linear-gradient(135deg, #2F4858, #5C8A9E)",
  "linear-gradient(135deg, #8A5A44, #C89F7B)",
];

/** 占位渐变（用稳定的 id 选择） */
export function fallbackGradient(seed: number): string {
  return GRADIENTS[pickIndex(seed, GRADIENTS.length)];
}

export function peekCover(trackId: number): string | null | undefined {
  return cache.get(trackId);
}

export function loadCover(trackId: number): Promise<string | null> {
  const cached = cache.get(trackId);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = pending.get(trackId);
  if (inflight) return inflight;
  const task = api
    .playerCover(trackId)
    .then((url) => {
      remember(trackId, url);
      pending.delete(trackId);
      return url;
    })
    .catch(() => {
      remember(trackId, null);
      pending.delete(trackId);
      return null;
    });
  pending.set(trackId, task);
  return task;
}

/** 预取一批封面（进入视图时调用，避免列表逐行闪烁） */
export function prefetchCovers(trackIds: number[]): void {
  trackIds.slice(0, 60).forEach((id) => {
    if (!cache.has(id)) void loadCover(id);
  });
}

/** React Hook：解析封面 data URL；无封面返回 null（由调用方决定占位） */
export function useCover(trackId: number | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    trackId != null ? peekCover(trackId) ?? null : null
  );
  useEffect(() => {
    if (trackId == null) {
      setUrl(null);
      return;
    }
    const cached = peekCover(trackId);
    if (cached !== undefined) {
      touchCover(trackId); // 命中即提升，正在显示的封面不会被淘汰
      setUrl(cached);
      return;
    }
    let alive = true;
    void loadCover(trackId).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [trackId]);
  return url;
}
