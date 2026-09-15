// 事件订阅 —— 后端推送事件的类型化监听（结构见 docs/接口文档.md）
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  LibraryUpdatedEvent, PlayerErrorEvent, PlayerProgressEvent, PlayerStateEvent, ScanProgressEvent,
} from "./types";

export const EVENT_NAMES = {
  progress: "player-progress",
  state: "player-state",
  error: "player-error",
  scan: "scan-progress",
  library: "library-updated",
} as const;

export const playerEvents = {
  onState(cb: (e: PlayerStateEvent) => void): Promise<UnlistenFn> {
    return listen<PlayerStateEvent>(EVENT_NAMES.state, (e) => cb(e.payload));
  },
  onProgress(cb: (e: PlayerProgressEvent) => void): Promise<UnlistenFn> {
    return listen<PlayerProgressEvent>(EVENT_NAMES.progress, (e) => cb(e.payload));
  },
  onError(cb: (e: PlayerErrorEvent) => void): Promise<UnlistenFn> {
    return listen<PlayerErrorEvent>(EVENT_NAMES.error, (e) => cb(e.payload));
  },
  onScan(cb: (e: ScanProgressEvent) => void): Promise<UnlistenFn> {
    return listen<ScanProgressEvent>(EVENT_NAMES.scan, (e) => cb(e.payload));
  },
  onLibraryUpdated(cb: (e: LibraryUpdatedEvent) => void): Promise<UnlistenFn> {
    return listen<LibraryUpdatedEvent>(EVENT_NAMES.library, (e) => cb(e.payload));
  },
};

export { EVENT_NAMES as EV };
