//! SMTC（Windows 系统媒体控制）：把 Oberon 接进系统的媒体会话。
//!
//! 接上之后，键盘媒体键、蓝牙耳机按键、锁屏界面、音量键 OSD、Windows 11「快速设置」
//! 里的媒体面板都能控制播放，并显示当前曲目的标题 / 艺术家 / 专辑 / 封面。
//!
//! 线程模型
//! - SMTC 对象必须在**有真实 HWND 的线程**上取（ISystemMediaTransportControlsInterop::GetForWindow），
//!   所以在主线程（setup 里，窗口已创建）构造；
//! - 构造完立刻移交给专属线程持有，之后所有 WinRT 调用都在该线程串行执行 ——
//!   windows crate 给这些类型都标了 agile（unsafe impl Send + Sync），跨线程移交是安全的。
//!   这一点很关键：拿封面的 StorageFile::GetFileFromPathAsync(...).get() 是**阻塞**调用，
//!   绝不能放在音频引擎线程上。
//! - ButtonPressed / PlaybackPositionChangeRequested 回调只做一件事：把 EngineCommand
//!   发进播放引擎的命令通道 —— 不阻塞、不碰音频、也不回调里调 WinRT。
//!
//! 失败一律静默降级：拿不到 SMTC（老系统 / 被组策略禁用）时 SmtcHandle 退化成空操作，
//! 播放器其余部分完全不受影响。本模块的公开 API 不含任何 Windows 类型，
//! 非 Windows 平台上 init_for_app 直接返回空句柄（保证 crate 仍能在别的平台编译）。
use crate::engine::{EngineCommand, EngineHandle};
use crate::models::PlayerStatus;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

/// 引擎 → SMTC 线程的命令
pub enum SmtcCommand {
    /// 当前曲目变了：更新标题 / 艺术家 / 专辑。
    /// 封面不在这里传：SMTC 线程自己按 track_id 查库拿 cover_key，避免把封面信息
    /// 一路塞进播放队列的数据结构。
    Track { track_id: i64, title: String, artist: String, album: String },
    Status(PlayerStatus),
    /// 进度（引擎侧已按 ~800ms 节流）
    Progress { position_secs: f64, duration_secs: f64 },
    /// 停止 / 没有当前曲目：清空系统面板上的元数据
    Clear,
}

/// SMTC 句柄。未接入时 tx 为 None，所有方法都是空操作 —— 调用方不必到处判空。
#[derive(Clone, Default)]
pub struct SmtcHandle {
    tx: Option<Sender<SmtcCommand>>,
}

impl SmtcHandle {
    fn send(&self, cmd: SmtcCommand) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(cmd);
        }
    }

    pub fn set_track(&self, track_id: i64, title: &str, artist: &str, album: &str) {
        self.send(SmtcCommand::Track {
            track_id,
            title: title.to_string(),
            artist: artist.to_string(),
            album: album.to_string(),
        });
    }

    pub fn set_status(&self, status: PlayerStatus) {
        self.send(SmtcCommand::Status(status));
    }

    pub fn set_progress(&self, position_secs: f64, duration_secs: f64) {
        self.send(SmtcCommand::Progress { position_secs, duration_secs });
    }

    pub fn clear(&self) {
        self.send(SmtcCommand::Clear);
    }
}

/// 接入系统媒体控制。在 setup 阶段调用一次（需要主窗口已创建 —— 窗口由配置在 setup 之前建好）。
/// 参数：播放引擎句柄（媒体键要往这里发命令）、数据库（查封面）、封面缓存目录。
#[cfg(windows)]
pub fn init_for_app(
    app: &tauri::AppHandle,
    engine: EngineHandle,
    db: Arc<Mutex<Connection>>,
    cover_dir: PathBuf,
) -> SmtcHandle {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[smtc] 找不到主窗口，系统媒体控制不可用");
        return SmtcHandle::default();
    };
    let hwnd = match window.hwnd() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[smtc] 取窗口句柄失败，系统媒体控制不可用: {e}");
            return SmtcHandle::default();
        }
    };
    init_windows(hwnd, engine, db, cover_dir)
}

#[cfg(not(windows))]
pub fn init_for_app(
    _app: &tauri::AppHandle,
    _engine: EngineHandle,
    _db: Arc<Mutex<Connection>>,
    _cover_dir: PathBuf,
) -> SmtcHandle {
    SmtcHandle::default()
}

// ---------------------------------------------------------------------------
// Windows 实现
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn init_windows(
    hwnd: windows::Win32::Foundation::HWND,
    engine: EngineHandle,
    db: Arc<Mutex<Connection>>,
    cover_dir: PathBuf,
) -> SmtcHandle {
    use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;

    let interop: ISystemMediaTransportControlsInterop = match interop_factory() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[smtc] 取 SMTC 互操作接口失败，系统媒体控制不可用: {e}");
            return SmtcHandle::default();
        }
    };
    // 安全：GetForWindow 只读窗口句柄，返回的接口由 interop 的引用计数持有
    let controls: windows::Media::SystemMediaTransportControls =
        match unsafe { interop.GetForWindow(hwnd) } {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[smtc] 为窗口取 SMTC 失败，系统媒体控制不可用: {e}");
                return SmtcHandle::default();
            }
        };

    // 不打开的话，系统媒体面板上对应按钮是灰的
    let _ = controls.SetIsEnabled(true);
    let _ = controls.SetIsPlayEnabled(true);
    let _ = controls.SetIsPauseEnabled(true);
    let _ = controls.SetIsStopEnabled(true);
    let _ = controls.SetIsNextEnabled(true);
    let _ = controls.SetIsPreviousEnabled(true);

    let (tx, rx) = channel::<SmtcCommand>();
    let spawned = std::thread::Builder::new()
        .name("smtc".into())
        .spawn(move || run(controls, engine, db, cover_dir, rx));
    match spawned {
        Ok(_) => {
            eprintln!("[smtc] 系统媒体控制已接入");
            SmtcHandle { tx: Some(tx) }
        }
        Err(e) => {
            eprintln!("[smtc] 创建 SMTC 线程失败: {e}");
            SmtcHandle::default()
        }
    }
}

/// 取互操作工厂。主线程公寓通常已由 tao / WebView2 初始化过；万一没有，
/// 补一次 RoInitialize 再试（重复初始化返回 RPC_E_CHANGED_MODE，那是「已经是别的模式」
/// 而不是失败，忽略即可 —— 没有初始化过的话 RoGetActivationFactory 必然失败）。
#[cfg(windows)]
fn interop_factory() -> windows::core::Result<windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop>
{
    use windows::Media::SystemMediaTransportControls;
    use windows::Win32::System::WinRT::{
        ISystemMediaTransportControlsInterop, RoInitialize, RO_INIT_MULTITHREADED,
    };
    // factory 的宿主类型 C 无法从返回类型推断，必须显式写出来
    let make = || windows::core::factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>();
    match make() {
        Ok(v) => Ok(v),
        Err(_) => {
            // 安全：RoInitialize 只影响当前线程的 COM 公寓
            let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
            make()
        }
    }
}

/// SMTC 专属线程：持有 SMTC 对象，串行处理引擎来的更新。
#[cfg(windows)]
fn run(
    controls: windows::Media::SystemMediaTransportControls,
    engine: EngineHandle,
    db: Arc<Mutex<Connection>>,
    cover_dir: PathBuf,
    rx: std::sync::mpsc::Receiver<SmtcCommand>,
) {
    use windows::Foundation::TypedEventHandler;
    use windows::Media::{
        MediaPlaybackStatus, SystemMediaTransportControls, SystemMediaTransportControlsButton,
        SystemMediaTransportControlsButtonPressedEventArgs,
    };

    // 本线程必须自己初始化一次 COM 公寓：跨公寓**使用** agile 对象（那个 SMTC 实例）不需要，
    // 但在这里**激活新对象**（TimelineProperties、StorageFile 异步操作）是需要的，
    // 否则会拿到 CO_E_NOTINITIALIZED，进度条和封面会静默失效。
    // 安全：RoInitialize 只影响当前线程的公寓。
    let _ = unsafe {
        windows::Win32::System::WinRT::RoInitialize(
            windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
        )
    };

    // 媒体键回调要按当前播放状态决定 Play 的含义，所以两个线程共享这份状态
    let last_status = Arc::new(Mutex::new(PlayerStatus::Stopped));

    let buttons = TypedEventHandler::<
        SystemMediaTransportControls,
        SystemMediaTransportControlsButtonPressedEventArgs,
    >::new({
        let engine = engine.clone();
        let last_status = last_status.clone();
        move |_sender, args| {
            let Ok(args) = args.ok() else { return Ok(()) };
            let Ok(button) = args.Button() else { return Ok(()) };
            eprintln!("[smtc] 收到媒体键: {button:?}");
            if button == SystemMediaTransportControlsButton::Play {
                // 系统在「正在播放」时本不该送 Play；万一送了，Toggle 会变成暂停
                let playing = last_status
                    .lock()
                    .map(|g| *g == PlayerStatus::Playing)
                    .unwrap_or(false);
                if !playing {
                    let _ = engine.send(EngineCommand::Toggle);
                }
            } else if button == SystemMediaTransportControlsButton::Pause {
                let _ = engine.send(EngineCommand::Pause);
            } else if button == SystemMediaTransportControlsButton::Stop {
                let _ = engine.send(EngineCommand::Stop);
            } else if button == SystemMediaTransportControlsButton::Next {
                let _ = engine.send(EngineCommand::Next);
            } else if button == SystemMediaTransportControlsButton::Previous {
                let _ = engine.send(EngineCommand::Previous);
            }
            Ok(())
        }
    });
    if let Err(e) = controls.ButtonPressed(&buttons) {
        eprintln!("[smtc] 注册媒体键回调失败: {e}");
    }

    // 系统面板上拖进度条 → 引擎 seek（不注册的话那个进度条是死的）
    use windows::Media::PlaybackPositionChangeRequestedEventArgs;
    let positions = TypedEventHandler::<
        SystemMediaTransportControls,
        PlaybackPositionChangeRequestedEventArgs,
    >::new({
        let engine = engine.clone();
        move |_sender, args| {
            let Ok(args) = args.ok() else { return Ok(()) };
            if let Ok(ts) = args.RequestedPlaybackPosition() {
                eprintln!("[smtc] 系统面板请求跳转到 {:.1}s", ticks_to_secs(ts.Duration));
                let _ = engine.send(EngineCommand::Seek { position_secs: ticks_to_secs(ts.Duration) });
            }
            Ok(())
        }
    });
    if let Err(e) = controls.PlaybackPositionChangeRequested(&positions) {
        eprintln!("[smtc] 注册进度跳转回调失败: {e}");
    }

    let mut last_track: Option<i64> = None;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            SmtcCommand::Track { track_id, title, artist, album } => {
                // 元数据只在真的换曲时重建：音量 / 暂停 / seek 每次都会带一条 player-state
                // 过来，每次都重建一遍 DisplayUpdater 纯属白刷系统面板（拖音量条时尤其明显）。
                if last_track == Some(track_id) {
                    continue;
                }
                let Ok(updater) = controls.DisplayUpdater() else { continue };
                last_track = Some(track_id);
                let _ = updater.SetType(windows::Media::MediaPlaybackType::Music);
                if let Ok(music) = updater.MusicProperties() {
                    let _ = music.SetTitle(&windows::core::HSTRING::from(title.as_str()));
                    let _ = music.SetArtist(&windows::core::HSTRING::from(artist.as_str()));
                    let _ = music.SetAlbumTitle(&windows::core::HSTRING::from(album.as_str()));
                }
                // 封面只在换曲时解析一次 —— 上面的 last_track 去重保证了这一点
                if let Some(path) = cover_thumb_path(&db, &cover_dir, track_id) {
                    if let Some(reference) = stream_reference(&path) {
                        let _ = updater.SetThumbnail(&reference);
                    }
                }
                let _ = updater.Update();
            }
            SmtcCommand::Status(status) => {
                if let Ok(mut g) = last_status.lock() {
                    *g = status;
                }
                let mapped = match status {
                    PlayerStatus::Playing => MediaPlaybackStatus::Playing,
                    PlayerStatus::Paused => MediaPlaybackStatus::Paused,
                    PlayerStatus::Stopped => MediaPlaybackStatus::Stopped,
                };
                let _ = controls.SetPlaybackStatus(mapped);
            }
            SmtcCommand::Progress { position_secs, duration_secs } => {
                let Ok(props) = windows::Media::SystemMediaTransportControlsTimelineProperties::new()
                else {
                    continue;
                };
                let duration = windows::Foundation::TimeSpan { Duration: secs_to_ticks(duration_secs) };
                let _ = props.SetStartTime(windows::Foundation::TimeSpan { Duration: 0 });
                let _ = props.SetMinSeekTime(windows::Foundation::TimeSpan { Duration: 0 });
                let _ = props.SetEndTime(duration);
                let _ = props.SetMaxSeekTime(duration);
                let _ = props.SetPosition(windows::Foundation::TimeSpan { Duration: secs_to_ticks(position_secs) });
                let _ = controls.UpdateTimelineProperties(&props);
            }
            SmtcCommand::Clear => {
                if let Ok(updater) = controls.DisplayUpdater() {
                    let _ = updater.ClearAll();
                    let _ = updater.Update();
                }
                let _ = controls.SetPlaybackStatus(MediaPlaybackStatus::Stopped);
                last_track = None;
            }
        }
    }
}

/// 曲目封面缩略图的绝对路径：cover_cache/thumb/<cover_key 去掉扩展名>.jpg。
/// 缩略图由扫描阶段生成（scanner::thumb_path_for），这里只按 cover_key 推路径。
/// 查库失败 / 没封面 / 文件不在 ⇒ None（系统面板显示默认图标，不影响其余信息）。
#[cfg(windows)]
fn cover_thumb_path(
    db: &Arc<Mutex<Connection>>,
    cover_dir: &std::path::Path,
    track_id: i64,
) -> Option<PathBuf> {
    let key = {
        let conn = db.lock().ok()?;
        crate::db::track_by_id(&conn, track_id).ok()??.cover_key?
    };
    let stem = key.rsplit_once('.').map(|(s, _)| s).unwrap_or(key.as_str());
    let path = cover_dir.join("thumb").join(format!("{stem}.jpg"));
    path.is_file().then_some(path)
}

/// 由本地 JPEG 构造 WinRT 流引用。失败返回 None：封面只是装饰，绝不因此影响播放。
#[cfg(windows)]
fn stream_reference(path: &std::path::Path) -> Option<windows::Storage::Streams::RandomAccessStreamReference> {
    use windows::Storage::StorageFile;
    let hpath = windows::core::HSTRING::from(path.to_string_lossy().as_ref());
    let file = StorageFile::GetFileFromPathAsync(&hpath).ok()?.get().ok()?;
    windows::Storage::Streams::RandomAccessStreamReference::CreateFromFile(&file).ok()
}

/// 秒 → WinRT TimeSpan（100ns 为单位）
#[cfg(windows)]
fn secs_to_ticks(secs: f64) -> i64 {
    (secs.max(0.0) * 10_000_000.0) as i64
}

#[cfg(windows)]
fn ticks_to_secs(ticks: i64) -> f64 {
    ticks.max(0) as f64 / 10_000_000.0
}
