// 导航状态：视图路由（首页 / 搜索 / 音乐库 / 专辑 / 艺术家 / 播放列表 / 设置）
import { create } from "zustand";

export type ViewName =
  | "home"
  | "search"
  | "library"
  | "favorites"
  | "album"
  | "artist"
  | "playlist"
  | "settings";

export interface NavTarget {
  name: ViewName;
  /** 专辑 id / 播放列表 id */
  id?: number;
  /** 艺术家名 / 音乐库分页签 */
  key?: string;
}

interface NavState {
  view: NavTarget;
  stack: NavTarget[];
  go: (target: NavTarget) => void;
  back: () => void;
  canGoBack: () => boolean;
}

export const useNavStore = create<NavState>((set, get) => ({
  view: { name: "home" },
  stack: [],
  go(target) {
    const current = get().view;
    if (current.name === target.name && current.id === target.id && current.key === target.key) return;
    set({ view: target, stack: [...get().stack, current].slice(-20) });
  },
  back() {
    const stack = get().stack;
    if (stack.length === 0) return;
    set({ view: stack[stack.length - 1], stack: stack.slice(0, -1) });
  },
  canGoBack() {
    return get().stack.length > 0;
  },
}));

/** 便捷跳转器 */
export const nav = {
  home: () => useNavStore.getState().go({ name: "home" }),
  search: () => useNavStore.getState().go({ name: "search" }),
  library: (tab: string = "tracks") => useNavStore.getState().go({ name: "library", key: tab }),
  favorites: () => useNavStore.getState().go({ name: "favorites" }),
  album: (id: number) => useNavStore.getState().go({ name: "album", id }),
  artist: (name: string) => useNavStore.getState().go({ name: "artist", key: name }),
  playlist: (id: number) => useNavStore.getState().go({ name: "playlist", id }),
  settings: () => useNavStore.getState().go({ name: "settings" }),
};
