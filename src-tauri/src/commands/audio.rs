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
/// 落库之后立刻通知引擎重开输出：模式只影响「允不允许尝试独占」，
/// 真正走成哪条路由运行时协商决定，回退原因随后可从 audio_output_status 读到。
#[tauri::command]
pub async fn audio_set_output_mode(state: State<'_, Arc<AppState>>, mode: String) -> AppResult<()> {
    let mode = if matches!(mode.as_str(), "auto" | "exclusive" | "shared") {
        mode
    } else {
        "auto".to_string()
    };
    // 先解析成枚举（Copy）：mode 这个 String 接下来要被移进阻塞任务写库
    let parsed = crate::engine::backend::OutputMode::parse(&mode);
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::settings_set(c, KEY_OUTPUT_MODE, &mode)?)).await?;
    state.engine.send(EngineCommand::SetOutputMode { mode: parsed })?;
    Ok(())
}

/// 让引擎重新协商一次输出后端（重开输出并尽量回到原位置）。
/// 用途：用户在 Windows 里改完独占设置之后，不用重启 app 也能重新尝试独占，
/// 并让设置页里那条「回退原因」重新算一遍。
#[tauri::command]
pub async fn audio_retry_output(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.engine.send(EngineCommand::RetryOutput)?;
    Ok(())
}

/// 当前输出后端状态：谁在出声（共享 / 独占）、独占时的实际格式、以及回退原因。
/// 由引擎线程在每次打开输出时写入（见 engine/audio.rs 的 OutputStatus）。
#[tauri::command]
pub async fn audio_output_status(
    state: State<'_, Arc<AppState>>,
) -> AppResult<crate::engine::audio::OutputStatus> {
    Ok(state.engine.output_status())
}
