//! IPC 数据模型（serde camelCase，与 src/api/types.ts 一一对应）

use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// 歌曲
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<i64>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub duration_secs: f64,
    pub sample_rate: Option<i64>,
    pub bitrate: Option<i64>,
    pub channels: Option<i64>,
    pub format: String,
    pub cover_key: Option<String>,
    pub file_size: i64,
    pub file_mtime: i64,
    pub added_ms: i64,
}

/// 专辑（按 专辑名+专辑艺术家 聚合；id 为组内最小 track id）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: i64,
    pub name: String,
    pub artist: String,
    pub year: Option<i64>,
    pub track_count: i64,
    pub cover_key: Option<String>,
    /// 该专辑只有一首歌时，额外给出这首曲目的名称（首页卡片显示歌曲名而不是专辑名）
    pub single_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub name: String,
    pub track_count: i64,
    pub album_count: i64,
}

/// 播放列表摘要
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub cover_key: Option<String>,
}

/// 播放列表详情（含歌曲）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub cover_key: Option<String>,
    pub tracks: Vec<Track>,
}

/// 播放队列条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub track_id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: f64,
}

/// 引擎内部队列条目（含文件路径）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueTrack {
    pub track_id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: f64,
}

/// 正在播放的歌曲
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub track_id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: f64,
    pub cover_key: Option<String>,
    pub position_secs: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlayerStatus {
    Stopped,
    Playing,
    Paused,
}

/// 播放模式（对应前端 顺序/循环全部/单曲循环/随机）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PlayMode {
    #[default]
    Sequential,
    LoopAll,
    LoopOne,
    Shuffle,
}

impl PlayMode {
    pub fn parse(s: &str) -> PlayMode {
        match s {
            "loop-all" => PlayMode::LoopAll,
            "loop-one" => PlayMode::LoopOne,
            "shuffle" => PlayMode::Shuffle,
            _ => PlayMode::Sequential,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            PlayMode::Sequential => "sequential",
            PlayMode::LoopAll => "loop-all",
            PlayMode::LoopOne => "loop-one",
            PlayMode::Shuffle => "shuffle",
        }
    }
}

/// 播放器完整状态快照
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub status: PlayerStatus,
    pub play_mode: PlayMode,
    pub volume: u8,
    /// ⚠️ 用 Arc 而不是 Vec：这份快照每次命令都会重建一次（`sync_shared`），
    /// 而 `snapshot()` 还会把它整个克隆一遍给 `player_state`。队列上万首时，
    /// 按值持有意味着每次「暂停/音量/seek」都要克隆 3 万个 String —— 换成 Arc 后
    /// 这两处都只是引用计数 +1，队列只在真正变化时才重建（见 `EngineCtx::items`）。
    /// serde 的序列化结果与 Vec 完全一致，前端契约不变。
    pub queue: Arc<Vec<QueueItem>>,
    pub queue_index: Option<usize>,
    pub current: Option<NowPlaying>,
    /// 实际播放顺序的曲目 id（列表循环 = 队列顺序；随机 = 洗牌序列）。
    /// 首页卡片据此排序，保证「卡片顺序 = 播放顺序」。同样用 Arc 缓存。
    pub order: Arc<Vec<i64>>,
}

/// player-state 事件负载（不携带完整队列）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStateEvent {
    pub status: PlayerStatus,
    pub play_mode: PlayMode,
    pub volume: u8,
    pub queue_index: Option<usize>,
    /// 队列长度（事件不携带完整队列，前端据此判断是否需要重新拉取 player_state）
    pub queue_len: usize,
    pub current: Option<NowPlaying>,
}

/// player-progress 事件负载
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub track_id: i64,
    pub position_secs: f64,
    pub duration_secs: f64,
}

/// player-error 事件负载
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerErrorPayload {
    pub code: String,
    pub message: String,
    pub track_id: Option<i64>,
}

/// 曲库统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub track_count: i64,
    pub artist_count: i64,
    pub album_count: i64,
    pub playlist_count: i64,
    pub total_duration_secs: f64,
    pub total_size_bytes: i64,
}

/// 音乐根目录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub id: i64,
    pub path: String,
    pub last_scanned_ms: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScanStage {
    Started,
    Scanning,
    Done,
    Cancelled,
    Error,
}

/// scan-progress 事件负载
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressPayload {
    pub stage: ScanStage,
    pub root: Option<String>,
    pub scanned_files: u64,
    pub total_files: Option<u64>,
    pub current_path: Option<String>,
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub error: Option<String>,
}

/// library-updated 事件负载
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUpdatedPayload {
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub total_tracks: i64,
}

/// 歌曲列表过滤条件
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackFilter {
    pub q: Option<String>,
    pub artist: Option<String>,
    pub album_id: Option<i64>,
    pub sort: Option<String>,
    pub order: Option<String>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

/// 分页结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paginated<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub page: u64,
    pub page_size: u64,
}

/// 搜索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub artists: Vec<Artist>,
    pub playlists: Vec<Playlist>,
}

/// 播放命令返回：入队位置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePosition {
    pub index: usize,
    pub count: usize,
}