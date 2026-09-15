//! 设置读写命令（settings 表）

use super::db_run;
use crate::error::AppResult;
use crate::state::AppState;
use std::collections::BTreeMap;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn settings_get(state: State<'_, Arc<AppState>>, key: String) -> AppResult<Option<String>> {
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::settings_get(c, &key)?)).await
}

#[tauri::command]
pub async fn settings_set(state: State<'_, Arc<AppState>>, key: String, value: String) -> AppResult<()> {
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::settings_set(c, &key, &value)?)).await
}

#[tauri::command]
pub async fn settings_get_all(state: State<'_, Arc<AppState>>) -> AppResult<BTreeMap<String, String>> {
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::settings_get_all(c)?.into_iter().collect())).await
}

#[tauri::command]
pub async fn settings_delete(state: State<'_, Arc<AppState>>, key: String) -> AppResult<()> {
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::settings_delete(c, &key)?)).await
}
