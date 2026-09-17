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

/// 设置键：输出模式（auto / exclusive / shared；缺键 = auto）
pub const KEY_OUTPUT_MODE: &str = "outputMode";

/// 读取当前输出模式（缺键或脏值一律回落到 auto）
#[tauri::command]
pub async fn audio_output_mode(state: State<'_, Arc<AppState>>) -> AppResult<String> {
    Ok(state
        .db
        .lock()
        .ok()
        .and_then(|g| crate::db::settings_get(&g, KEY_OUTPUT_MODE).ok().flatten())
        .filter(|s| matches!(s.as_str(), "auto" | "exclusive" | "shared"))
        .unwrap_or_else(|| "auto".to_string()))
}

/// 设置输出模式。白名单校验，避免脏值写库。
/// 注意：独占后端（渲染线程）还没接上，这里先只落库；接上之后要在这里同时
/// 重开输出设备并按其结果回退（见 engine/backend.rs 的 Fallback）。
#[tauri::command]
pub async fn audio_set_output_mode(state: State<'_, Arc<AppState>>, mode: String) -> AppResult<()> {
    let mode = if matches!(mode.as_str(), "auto" | "exclusive" | "shared") {
        mode
    } else {
        "auto".to_string()
    };
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::settings_set(c, KEY_OUTPUT_MODE, &mode)?)).await?;
    Ok(())
}
