// 类型化 IPC 客户端 —— 封装 @tauri-apps/api 的 invoke
// 命令名与 Rust 端 #[tauri::command] 函数名一一对应，见 docs/接口文档.md
import { invoke } from "@tauri-apps/api/core";
import type {
  LyricsResult,
  Album, Artist, AudioDeviceInfo, ExclusiveDeviceCaps, FolderInfo, LibraryStats, Paginated, Playlist,
  PlaylistDetail, PlayerState, PlayMode, QueuePosition, SearchResult, Track, TrackFilter,
  OutputStatus,
} from "./types";

export async function scanAddMusicFolder(path: string): Promise<FolderInfo> {
  return invoke("scan_add_music_folder", { path });
}
export async function scanRemoveMusicFolder(path: string): Promise<void> {
  return invoke("scan_remove_music_folder", { path });
}
export async function scanListFolders(): Promise<FolderInfo[]> {
  return invoke("scan_list_folders");
}
export async function scanMusicLibrary(): Promise<void> {
  return invoke("scan_music_library");
}
export async function scanCancel(): Promise<void> {
  return invoke("scan_cancel");
}

/** 列出可选输出设备（设置页「输出设备」） */
export async function audioOutputDevices(): Promise<AudioDeviceInfo[]> {
  return invoke("audio_output_devices");
}
/** 选择输出设备；传 null / "" 表示跟随系统默认设备。落库并立刻迁移播放（保持进度）。 */
export async function audioSetOutputDevice(id: string | null): Promise<void> {
  return invoke("audio_set_output_device", { id });
}
/** 现场探测每个输出设备的 WASAPI 独占能力（设置页「独占输出」用） */
export async function audioExclusiveProbe(): Promise<ExclusiveDeviceCaps[]> {
  return invoke("audio_exclusive_probe");
}
/** 读取输出模式（auto / exclusive / shared） */
export async function audioOutputMode(): Promise<string> {
  return invoke("audio_output_mode");
}
/** 设置输出模式；后端按白名单校验 */
export async function audioSetOutputMode(mode: string): Promise<void> {
  return invoke("audio_set_output_mode", { mode });
}
/** 让引擎重新协商输出后端（系统里改完独占设置后，不重启也能重新尝试独占） */
export async function audioRetryOutput(): Promise<void> {
  return invoke("audio_retry_output");
}
/** 当前输出后端状态：实际在用的后端 / 独占格式 / 回退原因（设置页「独占输出」显示） */
export async function audioOutputStatus(): Promise<OutputStatus> {
  return invoke("audio_output_status");
}

export async function libraryStats(): Promise<LibraryStats> {
  return invoke("library_stats");
}
export async function tracksList(filter: TrackFilter = {}): Promise<Paginated<Track>> {
  return invoke("tracks_list", { filter });
}
/** 播放次数 +1。曲目**真正开始播放**时由 playerStore 调一次（见那里的播放计数）。 */
export async function trackPlayed(id: number): Promise<void> {
  return invoke("track_played", { id });
}
export async function trackGet(id: number): Promise<Track> {
  return invoke("track_get", { id });
}
/** 按 id 集合取歌曲（保持传入顺序，已不在曲库的 id 被跳过）—— 收藏模块用 */
export async function tracksByIds(ids: number[]): Promise<Track[]> {
  return invoke("tracks_by_ids", { ids });
}
export async function albumsList(page = 1, pageSize = 100, q?: string): Promise<Paginated<Album>> {
  return invoke("albums_list", { page, pageSize, q });
}
export async function albumTracks(albumId: number): Promise<Track[]> {
  return invoke("album_tracks", { albumId });
}
export async function artistsList(): Promise<Artist[]> {
  return invoke("artists_list");
}
export async function artistTracks(artist: string): Promise<Track[]> {
  return invoke("artist_tracks", { artist });
}
export async function search(q: string): Promise<SearchResult> {
  return invoke("search", { q });
}

export async function playlistsList(): Promise<Playlist[]> {
  return invoke("playlists_list");
}
export async function playlistCreate(name: string): Promise<Playlist> {
  return invoke("playlist_create", { name });
}
export async function playlistRename(id: number, name: string): Promise<Playlist> {
  return invoke("playlist_rename", { id, name });
}
export async function playlistDelete(id: number): Promise<void> {
  return invoke("playlist_delete", { id });
}
export async function playlistGet(id: number): Promise<PlaylistDetail> {
  return invoke("playlist_get", { id });
}
export async function playlistAddTracks(id: number, trackIds: number[]): Promise<void> {
  return invoke("playlist_add_tracks", { id, trackIds });
}
export async function playlistAddTrackLocation(id: number, trackId: number, afterTrackId?: number): Promise<void> {
  return invoke("playlist_add_track_location", { id, trackId, afterTrackId });
}
export async function playlistRemoveTrack(id: number, trackId: number): Promise<void> {
  return invoke("playlist_remove_track", { id, trackId });
}
export async function playlistReorder(id: number, orderedTrackIds: number[]): Promise<void> {
  return invoke("playlist_reorder", { id, orderedTrackIds });
}

export async function playerState(): Promise<PlayerState> {
  return invoke("player_state");
}
export async function playerPlayTrack(trackId: number, queueTrackIds?: number[]): Promise<QueuePosition> {
  return invoke("player_play_track", { trackId, queueTrackIds });
}
export async function playerPlayAlbum(albumId: number, startTrackId: number): Promise<QueuePosition> {
  return invoke("player_play_album", { albumId, startTrackId });
}
export async function playerPlayPlaylist(playlistId: number, startTrackId: number): Promise<QueuePosition> {
  return invoke("player_play_playlist", { playlistId, startTrackId });
}
export async function playerPlayAll(startTrackId: number): Promise<QueuePosition> {
  return invoke("player_play_all", { startTrackId });
}
export async function playerToggle(): Promise<void> {
  return invoke("player_toggle");
}
export async function playerPause(): Promise<void> {
  return invoke("player_pause");
}
export async function playerResume(): Promise<void> {
  return invoke("player_resume");
}
export async function playerStop(): Promise<void> {
  return invoke("player_stop");
}
export async function playerNext(): Promise<void> {
  return invoke("player_next");
}
export async function playerPrevious(): Promise<void> {
  return invoke("player_previous");
}
export async function playerSeek(positionSecs: number): Promise<void> {
  return invoke("player_seek", { positionSecs });
}
export async function playerSetVolume(volume: number): Promise<void> {
  return invoke("player_set_volume", { volume });
}
export async function playerSetPlayMode(mode: PlayMode): Promise<void> {
  return invoke("player_set_play_mode", { mode });
}
/** 上一首行为：true = 播放超过 3 秒回到本曲开头；false = 总是切上一首（默认） */
export async function playerSetPreviousRestart(enabled: boolean): Promise<void> {
  return invoke("player_set_previous_restart", { enabled });
}
export async function playerCover(trackId: number): Promise<string | null> {
  return invoke("player_cover", { trackId }); // data:image/...;base64
}

export async function settingsGet(key: string): Promise<string | null> {
  return invoke("settings_get", { key });
}
export async function settingsSet(key: string, value: string): Promise<void> {
  return invoke("settings_set", { key, value });
}
export async function settingsGetAll(): Promise<Record<string, string>> {
  return invoke("settings_get_all");
}
/** 保存用户上传的歌词字体（bytes 走 ArrayBuffer 二进制 IPC），返回实际文件名 */
export async function fontSave(name: string, data: Uint8Array): Promise<string> {
  return invoke("font_save", { name, data });
}
/** 读取已保存的字体字节（原始二进制，前端 new FontFace 用） */
export async function fontRead(name: string): Promise<ArrayBuffer> {
  return invoke("font_read", { name });
}
/** 已上传的字体文件名列表 */
export async function fontDelete(name: string): Promise<void> {
  return invoke("font_delete", { name });
}

/// 恢复上次退出时的曲目与位置（后端装载为暂停态，不出声）
export async function playerRestore(trackId: number, positionSecs: number, queueTrackIds?: number[]): Promise<QueuePosition> {
  return invoke("player_restore", { trackId, positionSecs, queueTrackIds });
}

export async function fontList(): Promise<string[]> {
  return invoke("font_list");
}

export async function settingsDelete(key: string): Promise<void> {
  return invoke("settings_delete", { key });
}

/** 取歌曲歌词（同名 .lrc 优先，其次内嵌标签） */
export async function trackLyrics(trackId: number): Promise<LyricsResult> {
  return invoke("track_lyrics", { trackId });
}

/** 当前节拍强度 0..1（音频旁路检测，~30Hz 轮询） */
export async function playerBeat(): Promise<number> {
  return invoke("player_beat");
}
