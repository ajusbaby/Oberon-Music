//! 扫描命令：添加/移除音乐根目录、手动扫描、取消

use super::db_run;
use crate::error::{AppError, AppResult};
use crate::models::FolderInfo;
use crate::state::AppState;
use crate::watcher::WatchMsg;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn scan_add_music_folder(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> AppResult<FolderInfo> {
    let p = std::path::Path::new(&path);
    if !p.is_dir() {
        return Err(AppError::param("路径不是有效目录"));
    }
    let canonical = std::fs::canonicalize(p).map_err(|e| AppError::io(format!("解析路径失败: {e}")))?;
    let norm = canonical.to_string_lossy().into_owned();
    let db = state.db.clone();
    let watch_path = norm.clone();
    let folder = db_run(db, move |c| crate::db::add_folder(c, &norm)).await?;
    state.watcher.send(WatchMsg::Add(watch_path));
    Ok(folder)
}

#[tauri::command]
pub async fn scan_remove_music_folder(state: State<'_, Arc<AppState>>, path: String) -> AppResult<()> {
    let db = state.db.clone();
    let norm = path.clone();
    // 规范化后移除（兼容传入非规范化路径）
    let canonical = std::fs::canonicalize(&path).ok();
    let target = canonical.as_deref().map(|p| p.to_string_lossy().into_owned()).unwrap_or(path);
    db_run(db, move |c| Ok(crate::db::remove_folder(c, &target)?)).await?;
    state.watcher.send(WatchMsg::Remove(norm));
    Ok(())
}

#[tauri::command]
pub async fn scan_list_folders(state: State<'_, Arc<AppState>>) -> AppResult<Vec<FolderInfo>> {
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::list_folders(c)?)).await
}

#[tauri::command]
pub async fn scan_music_library(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<()> {
    let db = state.db.clone();
    let db_path = state.db_path.clone();
    let covers = state.cover_dir.clone();
    state.scan.request(app, db, db_path, covers);
    Ok(())
}

#[tauri::command]
pub async fn scan_cancel(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.scan.cancel();
    Ok(())
}
