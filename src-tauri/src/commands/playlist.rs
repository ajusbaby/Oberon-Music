//! 播放列表命令

use super::db_run;
use crate::error::{AppError, AppResult};
use crate::models::{Playlist, PlaylistDetail};
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn playlists_list(state: State<'_, Arc<AppState>>) -> AppResult<Vec<Playlist>> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::list_playlists(c)).await
}

#[tauri::command]
pub async fn playlist_create(state: State<'_, Arc<AppState>>, name: String) -> AppResult<Playlist> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::create_playlist(c, &name)).await
}

#[tauri::command]
pub async fn playlist_rename(state: State<'_, Arc<AppState>>, id: i64, name: String) -> AppResult<Playlist> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::rename_playlist(c, id, &name)).await
}

#[tauri::command]
pub async fn playlist_delete(state: State<'_, Arc<AppState>>, id: i64) -> AppResult<()> {
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::delete_playlist(c, id)?)).await
}

#[tauri::command]
pub async fn playlist_get(state: State<'_, Arc<AppState>>, id: i64) -> AppResult<PlaylistDetail> {
    let db = state.db.clone();
    db_run(db, move |c| {
        let pl = crate::db::playlist_by_id(c, id)?
            .ok_or_else(|| AppError::new(crate::error::E_PLAYLIST_NOT_FOUND, "播放列表不存在"))?;
        let tracks = crate::db::playlist_tracks(c, id)?;
        Ok(PlaylistDetail {
            id: pl.id,
            name: pl.name,
            track_count: pl.track_count,
            created_ms: pl.created_ms,
            updated_ms: pl.updated_ms,
            cover_key: pl.cover_key,
            tracks,
        })
    })
    .await
}

#[tauri::command]
pub async fn playlist_add_tracks(
    state: State<'_, Arc<AppState>>,
    id: i64,
    track_ids: Vec<i64>,
) -> AppResult<u64> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::playlist_add_tracks(c, id, &track_ids)).await
}

#[tauri::command]
pub async fn playlist_add_track_location(
    state: State<'_, Arc<AppState>>,
    id: i64,
    track_id: i64,
    after_track_id: Option<i64>,
) -> AppResult<()> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::playlist_insert_track(c, id, track_id, after_track_id)).await
}

#[tauri::command]
pub async fn playlist_remove_track(state: State<'_, Arc<AppState>>, id: i64, track_id: i64) -> AppResult<()> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::playlist_remove_track(c, id, track_id)).await
}

#[tauri::command]
pub async fn playlist_reorder(
    state: State<'_, Arc<AppState>>,
    id: i64,
    ordered_track_ids: Vec<i64>,
) -> AppResult<()> {
    let db = state.db.clone();
    db_run(db, move |c| crate::db::playlist_reorder(c, id, &ordered_track_ids)).await
}
