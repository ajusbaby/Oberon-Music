//! Oberon —— Tauri 2 桌面内核入口
//! 接线：插件 → 状态 → 引擎/监听 → IPC 命令注册

mod commands;
mod db;
// 性能基准用的公开解码入口（见 src/bench.rs 的说明）
pub mod bench;
mod engine;
mod error;
mod lyrics;
mod models;
mod scanner;
mod smtc;
mod state;
mod watcher;

use state::AppState;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 应用内更新：检查/下载/安装走 updater，装完用 process 重启自己
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let (state, watch_rx) = AppState::init(&handle)?;
            let state = Arc::new(state);

            // 系统媒体控制（SMTC）：媒体键 / 蓝牙耳机 / 锁屏 / 系统媒体面板。
            // 此时窗口已按配置建好（见 tauri::app::setup 的顺序），能拿到真正的 HWND。
            // 任何失败都在内部静默降级成空句柄，绝不影响播放。
            let smtc = smtc::init_for_app(
                &handle,
                state.engine.clone(),
                state.db.clone(),
                state.cover_dir.clone(),
            );
            state.engine.attach_smtc(smtc);

            // 目录监听线程
            let watcher_state = state.clone();
            let watcher_app = handle.clone();
            std::thread::Builder::new()
                .name("folder-watcher".into())
                .spawn(move || {
                    watcher::run(watcher_state, watcher_app, watch_rx);
                })
                .expect("监听线程创建失败");

            app.manage(state);

            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Oberon", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("缺少窗口图标".into()))?;
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("Oberon")
                .menu(&menu)
                // 左键唤出窗口，右键弹菜单（Windows 习惯）
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => quit_app(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // 关窗行为 + 退出前记住播放位置（设置项 closeMinimize = on 时最小化并继续播放）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                if read_setting(&app, "closeMinimize").as_deref() == Some("on") {
                    api.prevent_close();
                    // 收进系统托盘（不是最小化）：任务栏不留按钮，托盘图标可唤出 / 退出
                    let _ = window.hide();
                    return;
                }
                save_last_position(&app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 扫描
            commands::scan::scan_add_music_folder,
            commands::scan::scan_remove_music_folder,
            commands::scan::scan_list_folders,
            commands::scan::scan_music_library,
            commands::scan::scan_cancel,
            // 曲库
            commands::library::library_stats,
            commands::library::tracks_list,
            commands::library::track_get,
            commands::library::tracks_by_ids,
            commands::library::albums_list,
            commands::library::album_tracks,
            commands::library::artists_list,
            commands::library::artist_tracks,
            commands::library::search,
            // 播放列表
            commands::playlist::playlists_list,
            commands::playlist::playlist_create,
            commands::playlist::playlist_rename,
            commands::playlist::playlist_delete,
            commands::playlist::playlist_get,
            commands::playlist::playlist_add_tracks,
            commands::playlist::playlist_add_track_location,
            commands::playlist::playlist_remove_track,
            commands::playlist::playlist_reorder,
            // 播放器
            commands::player::player_restore,
            commands::player::player_state,
            commands::player::player_beat,
            commands::player::player_play_track,
            commands::player::player_play_album,
            commands::player::player_play_playlist,
            commands::player::player_play_all,
            commands::player::player_toggle,
            commands::player::player_pause,
            commands::player::player_resume,
            commands::player::player_stop,
            commands::player::player_next,
            commands::player::player_previous,
            commands::player::player_seek,
            commands::player::player_set_volume,
            commands::player::player_set_play_mode,
            commands::player::player_set_previous_restart,
            commands::player::player_cover,
        commands::player::track_lyrics,
            // WASAPI 独占能力探测（设置页「独占输出」用）
            engine::backend::audio_exclusive_probe,
            // 输出设备
            commands::audio::audio_output_devices,
            commands::audio::audio_set_output_device,
            commands::audio::audio_output_mode,
            commands::audio::audio_set_output_mode,
            commands::audio::audio_output_status,
            commands::audio::audio_retry_output,
            // 歌词字体
            commands::fonts::font_save,
            commands::fonts::font_read,
            commands::fonts::font_list,
            commands::fonts::font_delete,
            // 设置
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_get_all,
            commands::settings::settings_delete,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

/// 读一个设置项：任何失败都当缺省（绝不因为读库失败而阻止关窗）
fn read_setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let state = app.try_state::<Arc<AppState>>()?;
    let db = state.db.lock().ok()?;
    crate::db::settings_get(&db, key).ok().flatten()
}

/// 记住完全退出时的曲目与位置（下次启动 player_restore 用）
fn save_last_position(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let snap = state.engine.snapshot();
    let Some(cur) = snap.current.as_ref() else {
        return;
    };
    // 5 秒门槛：太靠前的进度恢复起来反而像没记住，不如从头开始
    if cur.position_secs < 5.0 {
        return;
    }
    let db = match state.db.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let _ = crate::db::settings_set(&db, "lastTrackId", &cur.track_id.to_string());
    let _ = crate::db::settings_set(&db, "lastPosition", &format!("{:.3}", cur.position_secs));
}
/// 唤出主窗口（托盘左键 / 菜单「显示主窗口」）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 真正退出：先记住播放位置，再退出进程（托盘菜单「退出 Oberon」走这里）
fn quit_app(app: &tauri::AppHandle) {
    save_last_position(app);
    app.exit(0);
}