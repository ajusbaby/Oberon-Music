//! 全局应用状态（Tauri managed state）：数据库、引擎、扫描控制、监听通道

use crate::engine::EngineHandle;
use crate::error::{AppError, AppResult};
use crate::models::PlayMode;
use crate::scanner::ScanControl;
use crate::watcher::{WatcherHandle, WatchMsg};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    /// 主数据库连接（WAL；扫描时另开连接读写）
    pub db: Arc<Mutex<Connection>>,
    pub db_path: PathBuf,
    /// 封面缓存目录（app_data/cover_cache）
    pub cover_dir: PathBuf,
    /// 用户导入的字体目录（app_data/fonts，内含 index.json 索引）
    pub font_dir: PathBuf,
    /// 字体索引的读写锁：导入 / 删除 / 列表都串行化，避免并发写坏 index.json
    pub fonts_lock: Arc<Mutex<()>>,
    /// 播放引擎句柄
    pub engine: EngineHandle,
    /// 扫描控制器
    pub scan: Arc<ScanControl>,
    /// 目录监听消息通道（Add/Remove/RescanRoots）
    pub watcher: WatcherHandle,
}

impl AppState {
    /// 初始化数据目录、数据库、引擎线程；返回监听接收端供 watcher 线程使用
    pub fn init(app: &tauri::AppHandle) -> AppResult<(Self, std::sync::mpsc::Receiver<WatchMsg>)> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::internal(format!("获取数据目录失败: {e}")))?;
        let db_path = data_dir.join("library.db3");
        let cover_dir = data_dir.join("cover_cache");
        let font_dir = data_dir.join("fonts");
        let conn = crate::db::open_db(&db_path)?;
        let db = Arc::new(Mutex::new(conn));

        let engine = crate::engine::spawn(app.clone());

        // 初始音量与播放模式（来自 settings 表）
        let volume: u8 = db
            .lock()
            .ok()
            .and_then(|g| crate::db::settings_get(&g, "volume").ok().flatten())
            .and_then(|v| v.parse().ok())
            .unwrap_or(80);
        engine.send(crate::engine::EngineCommand::SetVolume { volume }).ok();
        // 播放模式只有三态（列表循环 / 单曲循环 / 随机），历史存下的「顺序播放」一律归一到列表循环
        let stored = db
            .lock()
            .ok()
            .and_then(|g| crate::db::settings_get(&g, "playMode").ok().flatten())
            .map(|s| PlayMode::parse(&s))
            .unwrap_or(PlayMode::LoopAll);
        let mode = if stored == PlayMode::Sequential { PlayMode::LoopAll } else { stored };
        engine.send(crate::engine::EngineCommand::SetPlayMode { mode }).ok();

        // 「上一首」行为：只有显式存了 "on" 才启用「回到本曲开头」，其余（缺键 / 空串 /
        // 脏值 / 读库失败）一律回落到默认的「总是切上一首」。
        // ⚠️ 这里是白名单，与 App.tsx 的 homeAmbient（默认开、用 != "off" 的黑名单）刻意相反 ——
        // 本项默认关闭，缺键必须落到新默认而不是旧行为，所以只能 == "on"。
        let restart_on_previous = db
            .lock()
            .ok()
            .and_then(|g| crate::db::settings_get(&g, "previousRestart").ok().flatten())
            .map(|v| v == "on")
            .unwrap_or(false);
        engine.send(crate::engine::EngineCommand::SetPreviousRestart { enabled: restart_on_previous }).ok();

        // 输出设备偏好（设置项 outputDevice；缺键 / 空串 = 跟随系统默认设备）。
        // 必须在引擎开始装载之前送到，否则第一首歌会先开到默认设备上。
        let output_device = db
            .lock()
            .ok()
            .and_then(|g| crate::db::settings_get(&g, "outputDevice").ok().flatten())
            .filter(|s| !s.is_empty());
        engine.send(crate::engine::EngineCommand::SetOutputDevice { id: output_device }).ok();

        // 输出模式（设置项 outputMode；缺键 / 脏值 = shared —— 默认共享）。
        // 同样要在第一首歌装载之前送到 —— 它决定第一首歌走共享还是先协商独占。
        let output_mode = db
            .lock()
            .ok()
            .and_then(|g| crate::db::settings_get(&g, "outputMode").ok().flatten())
            .map(|s| crate::engine::backend::OutputMode::parse(&s))
            .unwrap_or(crate::engine::backend::OutputMode::Shared);
        engine.send(crate::engine::EngineCommand::SetOutputMode { mode: output_mode }).ok();

        // 「空间音效」开关（设置项 concertHall；缺键 / 脏值 = off —— 默认不加任何加工）。
        // 和上面两项一样必须在装载第一首之前送到：bus 是在打开输出时按当时的档位建立的，
        // 晚到一步的话第一首歌会先以 dry 声出声、再被平滑拉进混响。
        let concert_hall = db
            .lock()
            .ok()
            .and_then(|g| crate::db::settings_get(&g, "concertHall").ok().flatten())
            .map(|s| crate::engine::hall::HallMode::parse(&s))
            .unwrap_or(crate::engine::hall::HallMode::Off);
        engine.send(crate::engine::EngineCommand::SetConcertHall { mode: concert_hall }).ok();

        // 独占输出的两个策略（设置项 exclusiveVolume / exclusiveRate）。
        // 采样率策略必须在**第一次打开输出之前**到位 —— 它是建 mixer 之前就定死的参数，
        // 晚一步就等于第一首歌按自适应协商、下一首才切到用户锁定的率。
        let exclusive_volume = db
            .lock()
            .ok()
            .and_then(|g| crate::db::settings_get(&g, "exclusiveVolume").ok().flatten())
            .map(|s| crate::engine::exclusive_session::VolumeMode::parse(&s))
            .unwrap_or(crate::engine::exclusive_session::VolumeMode::Software);
        let exclusive_rate = db
            .lock()
            .ok()
            .and_then(|g| crate::db::settings_get(&g, "exclusiveRate").ok().flatten())
            .map(|s| crate::engine::exclusive_session::RatePolicy::parse(&s))
            .unwrap_or(crate::engine::exclusive_session::RatePolicy::Adaptive);
        engine
            .send(crate::engine::EngineCommand::SetExclusiveOutput {
                volume: exclusive_volume,
                rate: exclusive_rate,
            })
            .ok();

        let (tx, rx) = std::sync::mpsc::channel::<WatchMsg>();
        Ok((
            AppState {
                db,
                db_path,
                cover_dir,
                font_dir,
                fonts_lock: Arc::new(Mutex::new(())),
                engine,
                scan: Arc::new(ScanControl::default()),
                watcher: WatcherHandle { tx },
            },
            rx,
        ))
    }
}
