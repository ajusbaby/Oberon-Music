// 与后端 Rust 序列化结构一一对应的 IPC 数据类型（serde camelCase）
// 事件与命令负载均以此为契约，修改需与 src-tauri/src/models.rs 同步。

export type PlayerStatus = "stopped" | "playing" | "paused";
export type PlayMode = "sequential" | "loop-all" | "loop-one" | "shuffle";
export type ScanStage = "started" | "scanning" | "done" | "cancelled" | "error";
export type TrackSort = "title" | "artist" | "album" | "date-added" | "year" | "duration";
export type SortOrder = "asc" | "desc";

/** 歌曲（tracks 表行） */
export interface Track {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  year: number | null;
  trackNo: number | null;
  discNo: number | null;
  durationSecs: number;
  sampleRate: number | null;
  bitrate: number | null;
  channels: number | null;
  format: string;
  coverKey: string | null;
  fileSize: number;
  fileMtime: number;
  addedMs: number;
}

/** 专辑（按 专辑名+专辑艺术家 聚合） */
export interface Album {
  id: number; // 聚合键：该专辑内最小 track id（用于按 id 取专辑歌曲）
  name: string;
  artist: string;
  year: number | null;
  trackCount: number;
  coverKey: string | null;
  /** 单曲专辑：该专辑唯一曲目的名称（首页卡片优先显示它） */
  singleTitle: string | null;
}

export interface Artist {
  name: string;
  trackCount: number;
  albumCount: number;
}

/** 播放列表摘要 */
export interface Playlist {
  id: number;
  name: string;
  trackCount: number;
  createdMs: number;
  updatedMs: number;
  coverKey: string | null;
}

export interface PlaylistDetail extends Playlist {
  tracks: Track[];
}

/** 播放队列条目 */
export interface QueueItem {
  trackId: number;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
}

export interface NowPlaying {
  trackId: number;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverKey: string | null;
  positionSecs: number;
}

/** 播放器完整状态（player_state 命令返回值） */
export interface PlayerState {
  status: PlayerStatus;
  playMode: PlayMode;
  volume: number; // 0..100
  queue: QueueItem[];
  queueIndex: number | null;
  current: NowPlaying | null;
  /** 实际播放顺序的曲目 id（列表循环 = 队列顺序；随机 = 洗牌序列） */
  order: number[];
}

/** player-state 事件负载（不含完整队列，完整队列用 player_state() 获取） */
export interface PlayerStateEvent {
  status: PlayerStatus;
  playMode: PlayMode;
  volume: number;
  queueIndex: number | null;
  /** 队列长度：与本地队列长度不一致时前端会自动重新拉取 player_state */
  queueLen: number;
  current: NowPlaying | null;
}

export interface PlayerProgressEvent {
  trackId: number;
  positionSecs: number;
  durationSecs: number;
}

export interface PlayerErrorEvent {
  code: string;
  message: string;
  trackId: number | null;
}

/** 可选输出设备（设置页「输出设备」下拉用） */
export interface AudioDeviceInfo {
  /** 稳定设备 id（WASAPI 端点 id） */
  id: string;
  name: string;
  /** 是否是系统当前的默认输出设备 */
  isDefault: boolean;
  /** 是否是用户当前选中的设备 */
  isSelected: boolean;
}

export interface LibraryStats {
  trackCount: number;
  artistCount: number;
  albumCount: number;
  playlistCount: number;
  totalDurationSecs: number;
  totalSizeBytes: number;
}

export interface FolderInfo {
  id: number;
  path: string;
  lastScannedMs: number;
}

export interface ScanProgressEvent {
  stage: ScanStage;
  root: string | null;
  scannedFiles: number;
  totalFiles: number | null;
  currentPath: string | null;
  added: number;
  updated: number;
  removed: number;
  error: string | null;
}

export interface LibraryUpdatedEvent {
  added: number;
  updated: number;
  removed: number;
  totalTracks: number;
}

export interface TrackFilter {
  q?: string;
  artist?: string;
  albumId?: number;
  sort?: TrackSort;
  order?: SortOrder;
  page?: number;
  pageSize?: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SearchResult {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
}

export interface QueuePosition {
  index: number;   // 目标队列下标（0 起）
  count: number;   // 队列长度
}

/** 歌词行：timeMs 为 0 表示无时间轴（纯文本歌词） */
export interface LyricLine {
  timeMs: number;
  text: string;
}

/** 歌词查询结果 */
export interface LyricsResult {
  /** lrc-file | embedded | none */
  source: string;
  /** 是否带时间轴 */
  synced: boolean;
  /** 来源说明（文件名或标签名） */
  origin: string | null;
  lines: LyricLine[];
}
