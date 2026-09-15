// playerStore —— 播放器状态（Zustand）
// 订阅后端 player-state / player-progress 事件，并透传播放控制命令
import { create } from "zustand";
import * as api from "../api/ipc";
import { playerEvents } from "../api/events";
import { useSelectionStore } from "./selectionStore";
import { toast } from "./uiStore";
import type { PlayMode, PlayerState } from "../api/types";

interface PlayerStoreState {
  state: PlayerState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  playTrack: (trackId: number, queueTrackIds?: number[]) => Promise<void>;
  /** 播放整张专辑，返回是否已开始播放 */
  playAlbum: (albumId: number, albumName?: string) => Promise<boolean>;
  toggle: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (secs: number) => Promise<void>;
  setVolume: (v: number) => Promise<void>;
  setPlayMode: (mode: PlayMode) => Promise<void>;
  /** 上一首行为：true = 播放超过 3 秒回到本曲开头；false = 总是切上一首（默认） */
  setPreviousRestart: (enabled: boolean) => Promise<void>;
  stop: () => Promise<void>;
  resume: () => Promise<void>;
}

/** 命令执行 + 失败提示：命令失败不再静默 */
async function guard(action: () => Promise<unknown>, what: string): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (e) {
    toast(what + "失败：" + String(e), "error");
    return false;
  }
}

/** 未载入任何曲目时，用「当前上下文」开始播放：封面流选中的专辑 → 整个曲库 */
export async function startDefaultPlayback(): Promise<boolean> {
  const album = useSelectionStore.getState().album;
  if (album && (await usePlayerStore.getState().playAlbum(album.id, album.name))) return true;
  const page = await api.tracksList({ page: 1, pageSize: 1 }).catch(() => null);
  if (page && page.items.length > 0) {
    if (!(await guard(() => api.playerPlayAll(page.items[0].id), "播放"))) return false;
    await usePlayerStore.getState().refresh();
    toast("开始播放音乐库", "success");
    return true;
  }
  toast("音乐库还是空的，先添加音乐文件夹", "error");
  return false;
}

export const usePlayerStore = create<PlayerStoreState>((set) => ({
  state: null,
  loading: false,
  error: null,
  async refresh() {
    set({ loading: true });
    try {
      const state = await api.playerState();
      set({ state, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },
  async playTrack(trackId, queueTrackIds) {
    if (await guard(() => api.playerPlayTrack(trackId, queueTrackIds), "播放")) {
      await usePlayerStore.getState().refresh();
    }
  },
  async playAlbum(albumId, albumName) {
    try {
      const tracks = await api.albumTracks(albumId);
      if (tracks.length === 0) {
        toast("这张专辑里没有歌曲", "error");
        return false;
      }
      await api.playerPlayAlbum(albumId, tracks[0].id);
      await usePlayerStore.getState().refresh();
      toast("正在播放《" + (albumName || tracks[0].album || "专辑") + "》", "success");
      return true;
    } catch (e) {
      toast("播放专辑失败：" + String(e), "error");
      return false;
    }
  },
  async toggle() {
    const s = usePlayerStore.getState().state;
    // 队列为空时引擎无可播放曲目：按当前上下文开始播放，而不是毫无响应
    if (!s || s.queue.length === 0) {
      await startDefaultPlayback();
      return;
    }
    if (await guard(() => api.playerToggle(), "播放控制")) {
      await usePlayerStore.getState().refresh();
    }
  },
  async next() {
    if (await guard(() => api.playerNext(), "切歌")) await usePlayerStore.getState().refresh();
  },
  async previous() {
    if (await guard(() => api.playerPrevious(), "切歌")) await usePlayerStore.getState().refresh();
  },
  async seek(secs) {
    // 立即把进度反映到界面，避免跳转后进度条/时间短暂停留在旧值
    const s = usePlayerStore.getState().state;
    if (s?.current) {
      usePlayerStore.setState({ state: { ...s, current: { ...s.current, positionSecs: secs } } });
    }
    await guard(() => api.playerSeek(secs), "跳转");
  },
  async setVolume(v) {
    const s = usePlayerStore.getState().state;
    if (s) usePlayerStore.setState({ state: { ...s, volume: v } });
    await guard(() => api.playerSetVolume(v), "调节音量");
  },
  async setPlayMode(mode) {
    const s = usePlayerStore.getState().state;
    if (s) usePlayerStore.setState({ state: { ...s, playMode: mode } });
    if (await guard(() => api.playerSetPlayMode(mode), "切换播放模式")) {
      // 随机模式的洗牌序列由内核生成，切模式后重新拉取，首页卡片顺序随之更新
      await usePlayerStore.getState().refresh();
    }
  },
  async setPreviousRestart(enabled) {
    // 值不进 PlayerState 快照（只有设置页一个消费者），因此成功后无需 refresh
    await guard(() => api.playerSetPreviousRestart(enabled), "设置上一首行为");
  },
  async stop() {
    if (await guard(() => api.playerStop(), "停止")) await usePlayerStore.getState().refresh();
  },
  async resume() {
    if (await guard(() => api.playerResume(), "继续播放")) await usePlayerStore.getState().refresh();
  },
}));

/** 在应用入口调用一次：订阅播放器事件并同步到 store */
export async function initPlayerEvents() {
  const { onState, onProgress } = playerEvents;
  await onState((payload) => {
    const { queueLen, ...rest } = payload;
    const s = usePlayerStore.getState().state;
    // 事件不含完整队列：队列长度一致时保留本地队列，其余字段实时覆盖
    usePlayerStore.setState({ state: s ? { ...s, ...rest, queue: s.queue } : null });
    // 队列发生变化（例如由外部命令或自动切换引起）时重新拉取完整状态
    if (!s || s.queue.length !== queueLen) {
      void usePlayerStore.getState().refresh();
    }
  });
  await onProgress((payload) => {
    const s = usePlayerStore.getState().state;
    if (s?.current && s.current.trackId === payload.trackId) {
      usePlayerStore.setState({
        state: { ...s, current: { ...s.current, positionSecs: payload.positionSecs } },
      });
    }
  });
}
