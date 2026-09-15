// UI 状态：队列弹层、对话框、吐司提示、扫描横幅
import { create } from "zustand";

/** 歌词页展开动画的起点：点击处（通常是播放条封面）在应用窗口内的位置（圆形扩散的圆心） */
export interface LyricsOrigin {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ToastItem {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}

export type DialogState =
  | { kind: "create-playlist" }
  | { kind: "add-to-playlist"; trackIds: number[] }
  | { kind: "rename-playlist"; playlistId: number; name: string }
  | { kind: "add-tracks"; playlistId: number }
  | { kind: "confirm"; title: string; message: string; confirmText: string; onConfirm: () => void };

interface UiState {
  queueOpen: boolean;
  /** 沉浸式歌词页是否展开 */
  lyricsOpen: boolean;
  /** 展开动画起点（圆形扩散的圆心 / 圆点飞行的起点） */
  lyricsOrigin: LyricsOrigin | null;
  dialog: DialogState | null;
  toasts: ToastItem[];
  toggleQueue: () => void;
  openLyrics: (origin?: LyricsOrigin | null) => void;
  closeLyrics: () => void;
  closeQueue: () => void;
  openDialog: (dialog: DialogState) => void;
  closeDialog: () => void;
  toast: (text: string, kind?: ToastItem["kind"]) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useUiStore = create<UiState>((set, get) => ({
  queueOpen: false,
  lyricsOpen: false,
  lyricsOrigin: null,
  dialog: null,
  toasts: [],
  toggleQueue() {
    set({ queueOpen: !get().queueOpen });
  },
  closeQueue() {
    set({ queueOpen: false });
  },
  openLyrics(origin) {
    set({ lyricsOpen: true, lyricsOrigin: origin ?? null, queueOpen: false, dialog: null });
  },
  closeLyrics() {
    set({ lyricsOpen: false });
  },
  openDialog(dialog) {
    set({ dialog, queueOpen: false });
  },
  closeDialog() {
    set({ dialog: null });
  },
  toast(text, kind = "info") {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    }, kind === "error" ? 5000 : 2800);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** 非 React 环境下的吐司（事件回调里使用） */
export function toast(text: string, kind: ToastItem["kind"] = "info"): void {
  useUiStore.getState().toast(text, kind);
}