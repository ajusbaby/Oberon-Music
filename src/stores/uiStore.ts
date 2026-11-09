// UI 状态：队列弹层、对话框、吐司提示、扫描横幅、搜索浮层
import { create } from "zustand";
import { useSearchStore } from "./searchStore";

/** 顶栏搜索触发器的 id：浮层关闭后把焦点还给它（否则键盘用户会掉到 <body> 上） */
export const SEARCH_TRIGGER_ID = "searchTrigger";

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
  /** 搜索浮层：独立模块，不占用路由，关掉后当前页面原样还在 */
  searchOpen: boolean;
  /** 沉浸式歌词页是否展开 */
  lyricsOpen: boolean;
  /** 展开动画起点（圆形扩散的圆心 / 圆点飞行的起点） */
  lyricsOrigin: LyricsOrigin | null;
  dialog: DialogState | null;
  toasts: ToastItem[];
  toggleQueue: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  openLyrics: (origin?: LyricsOrigin | null) => void;
  closeLyrics: () => void;
  closeQueue: () => void;
  openDialog: (dialog: DialogState) => void;
  closeDialog: () => void;
  toast: (text: string, kind?: ToastItem["kind"]) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

/**
 * 吐司定时器表：以前 setTimeout 是个裸调用，用户点掉吐司后定时器照样跑到点，
 * 再对 toasts 数组 setState 一次（渲染一次、且顺序一旦错乱就会误删新吐司）。
 * 现在每个 id 的定时器都在这里登记，手动关 / 被挤掉都会先撤表。
 */
const toastTimers = new Map<number, number>();

function clearToastTimer(id: number) {
  const timer = toastTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    toastTimers.delete(id);
  }
}

function dropToast(id: number) {
  clearToastTimer(id);
  useUiStore.setState({ toasts: useUiStore.getState().toasts.filter((t) => t.id !== id) });
}

function scheduleToast(id: number, ms: number) {
  clearToastTimer(id);
  toastTimers.set(
    id,
    window.setTimeout(() => dropToast(id), ms),
  );
}

export const useUiStore = create<UiState>((set, get) => ({
  queueOpen: false,
  searchOpen: false,
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
  /** 打开搜索：顺手收起队列面板 —— 两个浮层叠在一起时，Esc 到底关谁没有答案 */
  openSearch() {
    set({ searchOpen: true, queueOpen: false });
  },
  closeSearch() {
    // 关掉就清词：下次打开是一张白纸，而不是上次那堆已经过期的结果
    useSearchStore.getState().clear();
    set({ searchOpen: false });
    // 焦点还给触发器：Esc 之后键盘用户仍停在"搜索"上，而不是掉回 <body>
    window.requestAnimationFrame(() => {
      document.getElementById(SEARCH_TRIGGER_ID)?.focus();
    });
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
    const ttl = kind === "error" ? 5000 : 2800;
    // 同一句话连发（一次扫描里每条失败都报一遍）不该叠成一列：复用现有的那条，只续时。
    const dup = get().toasts.find((t) => t.text === text);
    if (dup) {
      scheduleToast(dup.id, ttl);
      return;
    }
    const id = toastSeq++;
    const next = [...get().toasts, { id, text, kind }];
    // 最多同时 4 条：最老的被挤掉，连带撤掉它的定时器
    for (const gone of next.slice(0, Math.max(0, next.length - 4))) clearToastTimer(gone.id);
    set({ toasts: next.slice(-4) });
    scheduleToast(id, ttl);
  },
  dismissToast(id) {
    dropToast(id);
  },
}));

/** 非 React 环境下的吐司（事件回调里使用） */
export function toast(text: string, kind: ToastItem["kind"] = "info"): void {
  useUiStore.getState().toast(text, kind);
}