// 与后端 Rust 序列化结构一一对应的 IPC 数据类型（serde camelCase）
// 事件与命令负载均以此为契约，修改需与 src-tauri/src/models.rs 同步。

export type PlayerStatus = "stopped" | "playing" | "paused";
export type PlayMode = "sequential" | "loop-all" | "loop-one" | "shuffle";
export type ScanStage = "started" | "scanning" | "done" | "cancelled" | "error";
/** 曲目排序键。size / mtime / play-count 由音乐库的「排序方式」按钮使用（见 LibraryView） */
export type TrackSort =
  | "title"
  | "artist"
  | "album"
  | "date-added"
  | "year"
  | "duration"
  | "size"
  | "mtime"
  | "play-count";
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
  /** 文件绝对路径：听歌统计用它算稳定键（重装后 id 会变，路径不会） */
  path: string;
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

/** WASAPI 独占能力探测结果（每个输出设备一条，来自后端**现场探测**而非猜测） */
export interface ExclusiveDeviceCaps {
  name: string;
  id: string;
  isDefault: boolean;
  /** 共享模式下的默认格式，如 "48000Hz 24/32bit PCM 2ch" */
  sharedFormat: string;
  /** 独占模式支持的组合，如 ["44100/24-32", "48000/16-16"] */
  exclusive: string[];
  /** 实测能成功 Initialize 的组合；null = 没开起来 */
  initOk: string | null;
  /** 失败原因（已归因，可直接给用户看） */
  initHint: string | null;
}

/** 当前实际生效的输出后端状态（由引擎线程写入，设置页轮询） */
export interface OutputStatus {
  /** 引擎是否已经打开过输出（false = 还没播过，后端未定） */
  opened: boolean;
  /** 实际在用的后端 */
  backend: "shared" | "exclusive";
  /** 独占时实际生效的格式，如 "44100/24-32"；共享时为 null */
  format: string | null;
  /** 回退共享的原因（中文，可直接显示）；没回退时为 null */
  fallback: string | null;
  /** 输出（mixer / 设备）的采样率 Hz；未打开时为 null */
  outputRate: number | null;
  /** 最近一次交给输出的音源的解码采样率 Hz；还没装载曲目时为 null */
  sourceRate: number | null;
  /** sourceRate 与 outputRate 不一致 = 走了多相 sinc 重采样 */
  resampling: boolean;
  /** 独占会话的诊断（缓冲 / 欠载 / 超时 / 健康度）；没走过独占时为 null */
  session: SessionDiagnostics | null;
}

/** 独占会话的诊断快照（后端 SessionDiagnostics 的镜像） */
export interface SessionDiagnostics {
  /** 状态机取值：disabled / idle / negotiating / running / failed / detached */
  state: string;
  /** 上面那个状态的中文 */
  stateLabel: string;
  /** 实际格式，如 "48000/24/32" */
  format: string | null;
  rate: number | null;
  /** 设备缓冲帧数与折算毫秒（越小越跟手，太小时容易欠载） */
  bufferFrames: number;
  bufferMs: number;
  /** 本次会话累计写入的帧数 */
  frames: number;
  /** 缓冲满、这一轮没空位的次数（正常背压也会计数） */
  zeroSpace: number;
  /** 等待设备事件超时的次数（连续 5 次才会判掉线） */
  timeouts: number;
  writeErrors: number;
  /** 一句话健康度，可直接显示 */
  health: string;
  /** 第一个失败原因（已归因） */
  failure: string | null;
}

/** 独占输出的两个策略（设置页两个下拉） */
export interface ExclusiveOutputSettings {
  /** software = 渲染线程里调音量（默认）；direct = 满幅直通 */
  volume: string;
  /** adaptive = 跟随曲目；数字 = 锁死那个采样率 */
  rate: string;
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

/** 逐字歌词里的一个词（来自增强 LRC 的 <mm:ss.xx> 或 TTML 的 <span>） */
export interface LyricWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** 歌词行：timeMs 为 0 表示无时间轴（纯文本歌词） */
export interface LyricLine {
  timeMs: number;
  text: string;
  /**
   * 逐字时间轴。有它时卡拉OK 按"词"推进（真实词级时间）；
   * 没有它（普通 LRC / 纯文本）则退回按行内线性插值。
   */
  words?: LyricWord[];
}

/** 歌词查询结果 */
export interface LyricsResult {
  /** lrc-file | ttml-file | embedded | none */
  source: string;
  /** 是否带时间轴 */
  synced: boolean;
  /** 来源说明（文件名或标签名） */
  origin: string | null;
  lines: LyricLine[];
}

// ───────────────────────────── 自定义字体（文档《歌词自定义字体系统方案》） ─────────────────────────────

/** 字体覆盖统计：每个维度是该维度参考字符集里的命中数 */
export interface FontCoverage {
  latin: number;
  hanCommon: number;
  hanExt: number;
  kana: number;
  hangul: number;
  symbols: number;
  emoji: number;
}

/** 可变字体的一条轴（wght / wdth / 自定义） */
export interface FontAxis {
  tag: string;
  min: number;
  default: number;
  max: number;
}

/** 一个已导入的字体资源（Rust: src/fonts.rs FontResource） */
export interface FontResource {
  id: string;
  contentHash: string;
  fileName: string;
  originalName: string;
  byteSize: number;
  faceIndex: number;
  /** 字体集合（.ttc / woff2 合集）里的 face 总数 */
  faces: number;
  family: string;
  subfamily: string;
  postscript: string | null;
  weight: number;
  width: number;
  italic: boolean;
  /** OS/2 fsType 位域；0 表示可自由嵌入 */
  embedding: number;
  variable: boolean;
  axes: FontAxis[];
  /** sfnt / woff / woff2 / unknown */
  format: string;
  /** 覆盖较充分的文字系统：latin / han / kana / hangul / symbols / emoji */
  scripts: string[];
  coverage: FontCoverage;
  /** cmap 里的码位数（不是覆盖统计的参考集命中数） */
  codepoints: number;
  /** 覆盖码点按升序合并成的 [起, 止] 闭区间，前端二分查找判"这个字由主字体出" */
  coverageRanges: [number, number][];
  addedAt: number;
  /** 解析成功才有覆盖统计；false 表示只能交给浏览器试试 */
  parsed: boolean;
  warning: string | null;
  /** 索引里有记录但文件已不在磁盘上 */
  missing: boolean;
}

export interface ImportFailure {
  path: string;
  message: string;
}

/** 一次导入的结果；导入队列里可能混合成功、重复、失败 */
export interface ImportReport {
  imported: FontResource[];
  duplicates: FontResource[];
  failed: ImportFailure[];
}

// ───────────────────────────── 听歌统计（持久化账本） ─────────────────────────────

/**
 * stats_read 的返回：json 是当前该用的那份账本原文。
 * source = "primary" 取应用数据目录；"mirror" 说明主副本丢了或比镜像旧、改用文档目录的镜像。
 */
export interface StatsRead {
  json: string | null;
  source: "primary" | "mirror" | "none";
  primary: string;
  mirror: string | null;
  updatedMs: number;
}

/** stats_write 的返回：两个落点、字节数、是否顺手更新了镜像、以及非致命的告警 */
export interface StatsWriteReport {
  primary: string;
  mirror: string | null;
  bytes: number;
  mirrorBytes: number;
  savedMs: number;
  mirrorWritten: boolean;
  warning: string | null;
}

/** 两个副本各自的时间与体积（设置页显示「最近保存」用） */
export interface StatsInfo {
  primary: string;
  mirror: string | null;
  primaryBytes: number;
  mirrorBytes: number;
  savedMs: number;
  mirrorSavedMs: number;
}

/** stats_merge 的结果：把多份账（含旧版按自增 id 记的）并成一份 */
export interface StatsMergeReport {
  json: string;
  days: number;
  tracks: number;
  /** 旧账里那些已经对不上任何曲目的 id 条数（保留成「曲目 #<id>」） */
  unresolved: number;
  updatedMs: number;
}

/** 账本里的曲目键反查回当前曲库（拿封面、拿到最新标题） */
export interface ResolvedTrack {
  key: string;
  trackId: number;
  path: string;
  title: string;
  artist: string;
  album: string;
}
