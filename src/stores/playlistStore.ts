// playlistStore —— 播放列表（Zustand）：侧边栏与详情页共用
import { create } from "zustand";
import * as api from "../api/ipc";
import type { Playlist } from "../api/types";
import { toast } from "./uiStore";

interface PlaylistState {
  playlists: Playlist[];
  loading: boolean;
  /** 变更版本号：创建/删除/重命名/加歌后自增，详情页据此重新加载 */
  version: number;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<Playlist | null>;
  remove: (id: number) => Promise<void>;
  rename: (id: number, name: string) => Promise<void>;
}

export const usePlaylistStore = create<PlaylistState>((set, get) => ({
  playlists: [],
  loading: false,
  version: 0,
  async refresh() {
    set({ loading: true });
    try {
      const list = await api.playlistsList();
      set({ playlists: list, loading: false, version: get().version + 1 });
    } catch (e) {
      set({ loading: false });
      toast("读取播放列表失败：" + String(e), "error");
    }
  },
  async create(name) {
    try {
      const created = await api.playlistCreate(name);
      await get().refresh();
      return created;
    } catch (e) {
      toast("创建播放列表失败：" + String(e), "error");
      return null;
    }
  },
  async remove(id) {
    try {
      await api.playlistDelete(id);
      await get().refresh();
      toast("已删除播放列表", "success");
    } catch (e) {
      toast("删除失败：" + String(e), "error");
    }
  },
  async rename(id, name) {
    try {
      await api.playlistRename(id, name);
      await get().refresh();
    } catch (e) {
      toast("重命名失败：" + String(e), "error");
    }
  },
}));
