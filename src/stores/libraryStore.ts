// libraryStore —— 音乐库 / 扫描状态（Zustand）
import { create } from "zustand";
import * as api from "../api/ipc";
import { playerEvents } from "../api/events";
import type { FolderInfo, LibraryStats, ScanProgressEvent } from "../api/types";

interface LibraryStoreState {
  stats: LibraryStats | null;
  /** 曲库版本号：library-updated 事件后自增，视图据此重新加载 */
  version: number;
  folders: FolderInfo[];
  scan: ScanProgressEvent | null;
  refreshStats: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  addFolder: (path: string) => Promise<void>;
  removeFolder: (path: string) => Promise<void>;
  startScan: () => Promise<void>;
  cancelScan: () => Promise<void>;
}

export const useLibraryStore = create<LibraryStoreState>((set) => ({
  stats: null,
  version: 0,
  folders: [],
  scan: null,
  async refreshStats() {
    try { set({ stats: await api.libraryStats() }); } catch { /* 忽略 */ }
  },
  async refreshFolders() {
    try { set({ folders: await api.scanListFolders() }); } catch { /* 忽略 */ }
  },
  async addFolder(path) {
    await api.scanAddMusicFolder(path);
    await useLibraryStore.getState().refreshFolders();
  },
  async removeFolder(path) {
    await api.scanRemoveMusicFolder(path);
    await useLibraryStore.getState().refreshFolders();
  },
  async startScan() { await api.scanMusicLibrary(); },
  async cancelScan() { await api.scanCancel(); },
}));

/** 在应用入口调用一次：订阅扫描事件 */
export async function initLibraryEvents(refreshCallback?: () => void) {
  await playerEvents.onScan((payload) => useLibraryStore.setState({ scan: payload }));
  await playerEvents.onLibraryUpdated(() => {
    useLibraryStore.getState().refreshStats();
    useLibraryStore.setState((s) => ({ version: s.version + 1 }));
    refreshCallback?.();
  });
}