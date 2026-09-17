//! 曲库查询命令：列表 / 专辑 / 艺术家 / 搜索 / 统计

use super::db_run;
use crate::error::AppResult;
use crate::models::{Album, Artist, LibraryStats, Paginated, SearchResult, Track, TrackFilter};
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn library_stats(state: State<'_, Arc<AppState>>) -> AppResult<LibraryStats> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::library_stats(c)).await
}

#[tauri::command]
pub async fn tracks_list(state: State<'_, Arc<AppState>>, filter: TrackFilter) -> AppResult<Paginated<Track>> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::list_tracks(c, &filter)).await
}

/// 播放次数 +1。前端在曲目**真正开始播放**时调用一次（见 playerStore 的播放计数）。
#[tauri::command]
pub async fn track_played(state: State<'_, Arc<AppState>>, id: i64) -> AppResult<()> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::bump_play_count(c, id)).await
}

#[tauri::command]
pub async fn track_get(state: State<'_, Arc<AppState>>, id: i64) -> AppResult<Option<Track>> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::track_by_id(c, id)).await
}

/// 按 id 集合取歌曲：保持传入顺序，已不在曲库里的 id 直接跳过。
/// 收藏只存 id 数组（settings 的 favorites 键），列表要的明细在这里补齐。
#[tauri::command]
pub async fn tracks_by_ids(state: State<'_, Arc<AppState>>, ids: Vec<i64>) -> AppResult<Vec<Track>> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::tracks_by_ids(c, &ids)).await
}

#[tauri::command]
pub async fn albums_list(
    state: State<'_, Arc<AppState>>,
    page: u64,
    page_size: u64,
    q: Option<String>,
) -> AppResult<Paginated<Album>> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::list_albums(c, page, page_size, q.as_deref())).await
}

#[tauri::command]
pub async fn album_tracks(state: State<'_, Arc<AppState>>, album_id: i64) -> AppResult<Vec<Track>> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::album_tracks(c, album_id)).await
}

#[tauri::command]
pub async fn artists_list(state: State<'_, Arc<AppState>>) -> AppResult<Vec<Artist>> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::list_artists(c)).await
}

#[tauri::command]
pub async fn artist_tracks(state: State<'_, Arc<AppState>>, artist: String) -> AppResult<Vec<Track>> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::artist_tracks(c, &artist)).await
}

#[tauri::command]
pub async fn search(state: State<'_, Arc<AppState>>, q: String) -> AppResult<SearchResult> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::search(c, &q)).await
}
