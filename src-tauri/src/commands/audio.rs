//! 输出设备命令：枚举 / 选择（设置页「输出设备」下拉用）

use super::db_run;
use crate::engine::EngineCommand;
use crate::error::AppResult;
use crate::models::AudioDeviceInfo;
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

/// 设置键：选定的输出设备 id（空串 / 缺键 = 跟随系统默认设备）
pub const KEY_OUTPUT_DEVICE: &str = "outputDevice";

fn selected_device(state: &AppState) -> Option<String> {
    state
        .db
        .lock()
        .ok()
        .and_then(|g| crate::db::settings_get(&g, KEY_OUTPUT_DEVICE).ok().flatten())
        .filter(|s| !s.is_empty())
}

/// 列出可选输出设备（isSelected 依据设置项 outputDevice）
#[tauri::command]
pub async fn audio_output_devices(state: State<'_, Arc<AppState>>) -> AppResult<Vec<AudioDeviceInfo>> {
    let selected = selected_device(state.inner());
    Ok(crate::engine::audio::list_output_devices(selected.as_deref()))
}

/// 选择输出设备：None / 空串 = 跟随系统默认设备。
/// 落库之后立刻通知引擎切过去（重开设备并尽量回到原来的播放位置）。
#[tauri::command]
pub async fn audio_set_output_device(
    state: State<'_, Arc<AppState>>,
    id: Option<String>,
) -> AppResult<()> {
    let id = id.filter(|s| !s.is_empty());
    let value = id.clone().unwrap_or_default();
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::settings_set(c, KEY_OUTPUT_DEVICE, &value)?)).await?;
    state.engine.send(EngineCommand::SetOutputDevice { id })?;
    Ok(())
}
