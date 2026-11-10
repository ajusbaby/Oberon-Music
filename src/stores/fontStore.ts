/**
 * 字体库的前端状态（文档 §4 / §12）
 *
 * 职责边界：
 *   · 这个仓库只存"字体资源"（有哪些字体、字节在哪）；
 *   · "哪个语言用哪个字体"是档案配置，存在 settings 里（见 src/lib/lyricFont.ts）；
 *   · 两者都用 id 关联，删资源时由调用方把档案里的引用清掉。
 *
 * 注册走 document.fonts（FontFace），不用 @font-face + asset 协议：
 * 字体文件在 app_data 下，运行期才知道路径，注入 CSS 规则反而更绕。
 */

import { create } from "zustand";
import { fontBytes, fontImport, fontList, fontRemove } from "../api/ipc";
import type { FontResource, ImportReport } from "../api/types";
import { fontFamilyName } from "../lib/lyricFont";

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface FontState {
  resources: FontResource[];
  status: LoadStatus;
  error: string | null;
  /** 正在导入（界面据此禁用按钮，避免重复点出并发写索引） */
  importing: boolean;
  load: () => Promise<void>;
  importFiles: (paths: string[]) => Promise<ImportReport | null>;
  remove: (id: string) => Promise<void>;
}

export const useFontStore = create<FontState>((set, get) => ({
  resources: [],
  status: "idle",
  error: null,
  importing: false,

  async load() {
    set({ status: "loading", error: null });
    try {
      const resources = await fontList();
      set({ resources, status: "ready" });
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  },

  async importFiles(paths) {
    if (!paths.length) return null;
    set({ importing: true });
    try {
      const report = await fontImport(paths);
      // 不管成功几个都刷新一次：重复导入也可能带出 missing 状态变化
      const resources = await fontList().catch(() => get().resources);
      set({ resources, status: "ready" });
      return report;
    } catch (e) {
      set({ error: String(e) });
      return null;
    } finally {
      set({ importing: false });
    }
  },

  async remove(id) {
    await fontRemove(id);
    set({ resources: get().resources.filter((r) => r.id !== id) });
  },
}));

/* ============================ FontFace 注册 ============================ */

/** id → 注册结果。同一个字体只读一次字节、只注册一次。 */
const registry = new Map<string, Promise<boolean>>();

function toBuffer(raw: ArrayBuffer | Uint8Array | number[]): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  if (raw instanceof Uint8Array) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const bytes = Uint8Array.from(raw);
  return bytes.buffer;
}

/**
 * 把字体注册进当前文档。返回是否可用（解析失败 / 浏览器不认 就是 false，
 * 该字体要从前面的链里跳过，否则用户会看到"字体没生效但也没报错"）。
 */
export function ensureFontRegistered(id: string): Promise<boolean> {
  const hit = registry.get(id);
  if (hit) return hit;
  const task = (async () => {
    try {
      const raw = await fontBytes(id);
      const face = new FontFace(fontFamilyName(id), toBuffer(raw));
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      return false;
    }
  })();
  registry.set(id, task);
  return task;
}

/** 一次性注册一批（档案里用到的主字体 + 备用字体） */
export async function ensureFontsRegistered(ids: string[]): Promise<void> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  await Promise.all(unique.map((id) => ensureFontRegistered(id)));
}

/** 删除字体后把注册缓存也清掉，重新导入同一个字体时会重新读字节；同时摘掉 document.fonts 里已加载的 face，避免删掉的字体还挂在文档里占内存 */
export function forgetRegistered(id: string): void {
  registry.delete(id);
  const family = fontFamilyName(id);
  try {
    for (const face of Array.from(document.fonts)) {
      if (face.family === family) document.fonts.delete(face);
    }
  } catch {
    /* document.fonts 不可用时忽略 */
  }
}
