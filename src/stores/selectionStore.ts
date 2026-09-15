// 首页封面流当前选中项（播放栏在停止状态时展示它，与设计稿行为一致）
import { create } from "zustand";
import type { Album } from "../api/types";

interface SelectionState {
  album: Album | null;
  setAlbum: (album: Album | null) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  album: null,
  setAlbum(album) {
    set({ album });
  },
}));
