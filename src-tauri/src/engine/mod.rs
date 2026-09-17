//! 播放引擎：独立线程 + 命令通道 + 状态快照 + 事件推送
//!
//! 线程模型
//! - 引擎线程持有音频设备（MixerDeviceSink）与播放句柄（rodio::Player）
//! - 命令层经 mpsc 通道发送 EngineCommand
//! - 状态快照 Arc<Mutex<PlayerState>> 供 player_state 命令读取
//! - 事件：player-state（状态跳变）/ player-progress（节流）/ player-error

pub mod adts;
pub mod audio;
pub mod backend;
pub mod beat;
pub mod dsd;
pub mod exclusive;
pub mod opus;
pub mod resample;

use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::smtc::SmtcHandle;
use audio::{
    endpoint_active, open_decoder, probe_default_output, seek_decoder, CoreAudio, DefaultOutput,
    OutputStatus,
};
use backend::OutputMode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

// ---------------------------------------------------------------------------
// 命令与句柄
// ---------------------------------------------------------------------------

pub enum EngineCommand {
    SetQueue { items: Vec<QueueTrack>, start: usize, autoplay: bool },
    Toggle,
    Pause,
    Resume,
    Stop,
    Next,
    Previous,
    Seek { position_secs: f64 },
    /// 装载队列第 index 首但保持暂停（恢复上次退出时的曲目与位置用）
    LoadPaused { index: usize },
    SetVolume { volume: u8 },
    SetPlayMode { mode: PlayMode },
    /// 「上一首」行为：true = 播放超过阈值时回到本曲开头（历史行为）；
    /// false = 总是切上一首（设置项 previousRestart 的默认值）
    SetPreviousRestart { enabled: bool },
    /// 切换输出设备（设置页「输出设备」）。None = 跟随系统默认。
    /// 立刻迁移：重开设备并尽量回到原来的播放位置。
    SetOutputDevice { id: Option<String> },
    /// 切换输出模式（设置页「独占输出」：auto / exclusive / shared）。
    /// 立刻生效：重开输出并尽量回到原来的播放位置（与 SetOutputDevice 同一套迁移流程）。
    SetOutputMode { mode: OutputMode },
    /// 重新协商一次输出后端（设置页「重新尝试独占」）。
    /// 为什么需要单独一条：用户在 Windows 里改完独占设置后，模式本身没变，
    /// SetOutputMode 不会触发重开；而引擎一旦回退过共享就会一直复用那个 sink。
    /// 这条命令强制丢掉旧结论、重开一次输出。
    RetryOutput,
    /// 停止引擎线程（预留：应用退出时显式收尾）
    #[allow(dead_code)]
    Shutdown,
}

/// gapless 预排提前量：距本曲结束还有这么多秒时，把下一首解码并 append 到**同一个 Player**。
/// rodio 的队列是顺序播放且自带采样率/声道转换，所以接着播就是无缝的。
const PREFETCH_LEAD_SECS: f64 = 12.0;

/// 「回到本曲开头」的播放位置阈值（秒）——仅在设置项 previousRestart 开启时生效。
/// 抽成常量是为了让开启该选项的用户拿到与历史逐位一致的行为，同时单测能对
/// 阈值两侧（2.9 / 3.0 / 3.1）分别断言。
const PREVIOUS_RESTART_THRESHOLD_SECS: f64 = 3.0;

/// 输出设备停滞判定的窗口：Playing 状态下位置连续这么多 tick（50ms × 60 = 3 秒）不前进，
/// 就认为音频流已经死了（设备被拔掉 / 被切走 / 被独占抢走 / 被系统静音重置）。
/// 播放位置由音频回调按真实时间推进，正常播放时每个 tick 都会前进 ⇒ 3 秒不动必然是异常。
const STALL_TICKS: u64 = 60;

/// 设备失效后「优先等原来那台设备回来」的时长（tick 数）：50ms × 160 = 8 秒。
/// 超时后改为跟随系统默认设备 —— 用户拔耳机也可能就是想换到别的设备上放。
const DEVICE_WAIT_GRACE_TICKS: u64 = 160;

/// 等待输出设备回来时的重试间隔（tick 数）：50ms × 20 = 1 秒。
/// ⚠️ 只做节流、不做次数上限 —— 拔掉耳机后设备可能很久都不在，而「插上耳机自动继续播放」
/// 才是用户要的行为，放弃恢复就等于把这个场景永久弄坏（上一版就是这么坏的）。
const DEVICE_RETRY_TICKS: u64 = 20;

#[derive(Clone)]
pub struct EngineHandle {
    tx: Sender<EngineCommand>,
    shared: Arc<Mutex<PlayerState>>,
    /// 节拍检测（前端 ~30Hz 取值驱动背景律动）
    beat: Arc<beat::BeatMeter>,
    #[allow(dead_code)]
    alive: Arc<AtomicBool>,
    /// 系统媒体控制句柄（setup 之后一次性填入，见 attach_smtc）
    smtc: Arc<OnceLock<SmtcHandle>>,
    /// 输出后端状态（谁在出声 / 什么格式 / 为什么没走成独占）。
    /// 由引擎线程在每次打开输出时写入，命令层只读 —— 见 audio::OutputStatus。
    out_status: Arc<Mutex<OutputStatus>>,
}

impl EngineHandle {
    /// 接入系统媒体控制（setup 之后一次性调用）。已填过时是空操作。
    pub fn attach_smtc(&self, handle: SmtcHandle) {
        let _ = self.smtc.set(handle);
    }

    pub fn send(&self, cmd: EngineCommand) -> AppResult<()> {
        self.tx.send(cmd).map_err(|_| AppError::internal("播放引擎线程已退出"))
    }

    /// 当前状态快照（供 player_state 命令）
    pub fn snapshot(&self) -> PlayerState {
        self.shared
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| PlayerState {
                status: PlayerStatus::Stopped,
                play_mode: PlayMode::LoopAll,
                volume: 80,
                queue: Arc::new(vec![]),
                queue_index: None,
                current: None,
                order: Arc::new(vec![]),
            })
    }

    /// 节拍强度 0..1（供 player_beat 命令）
    pub fn beat(&self) -> Arc<beat::BeatMeter> {
        self.beat.clone()
    }

    /// 当前输出后端状态（供 audio_output_status 命令）
    pub fn output_status(&self) -> OutputStatus {
        self.out_status.lock().map(|g| g.clone()).unwrap_or_default()
    }

    #[allow(dead_code)]
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

/// 启动引擎线程并返回句柄
pub fn spawn(app: tauri::AppHandle) -> EngineHandle {
    let (tx, rx) = channel::<EngineCommand>();
    let shared = Arc::new(Mutex::new(PlayerState {
        status: PlayerStatus::Stopped,
        play_mode: PlayMode::LoopAll,
        volume: 80,
        queue: Arc::new(vec![]),
        queue_index: None,
        current: None,
        order: Arc::new(vec![]),
    }));
    let alive = Arc::new(AtomicBool::new(true));
    let meter = beat::BeatMeter::new();
    // SMTC 句柄由主线程稍后填入（那时才拿得到窗口句柄），引擎线程读同一个槽
    let smtc = Arc::new(OnceLock::<SmtcHandle>::new());
    // 输出状态槽：引擎线程写、命令层读（音频设备全在引擎线程手里）
    let out_status = Arc::new(Mutex::new(OutputStatus::default()));
    let shared2 = shared.clone();
    let alive2 = alive.clone();
    let meter2 = meter.clone();
    let smtc2 = smtc.clone();
    let out_status2 = out_status.clone();
    std::thread::Builder::new()
        .name("audio-engine".into())
        .spawn(move || run_engine(app, rx, shared2, alive2, meter2, smtc2, out_status2))
        .expect("引擎线程创建失败");

    EngineHandle { tx, shared, beat: meter, alive, smtc, out_status }
}

// ---------------------------------------------------------------------------
// 引擎线程
// ---------------------------------------------------------------------------

/// gapless 预排的在途状态
struct Pending {
    /// 下一首在队列里的下标
    idx: usize,
    /// 预排发生时的**本曲**位置（秒）
    pos_at_prefetch: f64,
    /// 上一个 tick 的位置：用来检测「换源导致位置回退」。
    /// ⚠️ 只靠 pos_at_prefetch 是不够的 —— 时长小于预排提前量的短曲会在开头就预排，
    ///    那时 pos_at_prefetch ≈ 0，条件永远不成立（见 run_engine 里的说明）。
    last_pos: f64,
}

struct EngineCtx {
    core: CoreAudio,
    queue: Vec<QueueTrack>,
    /// 队列的 IPC 形态 —— `PlayerState.queue` 的 Arc 缓存。
    /// 只在队列真的变化时重建（SetQueue 整体建、load_and_play 补一条时长）。
    /// 这样 sync_shared 与 snapshot 都退化成 Arc::clone，开销与队列长度无关；
    /// 否则每次「暂停/音量/seek」都要把整条队列重新物化一遍（1 万首 = 3 万次 String 分配）。
    items: Arc<Vec<QueueItem>>,
    /// 播放顺序的 Arc 缓存，与 perm 同步刷新（见 rebuild_perm）
    order: Arc<Vec<i64>>,
    idx: Option<usize>,
    /// 随机顺序（Shuffle 模式；其他模式为 0..len 顺序）
    perm: Vec<usize>,
    perm_pos: usize,
    status: PlayerStatus,
    play_mode: PlayMode,
    volume: u8,
    /// 「上一首」是否在播放超过阈值时回到本曲开头（设置项 previousRestart，默认 false）
    restart_on_previous: bool,
    /// 重解码跳转后的时间偏移（秒）
    seek_offset: f64,
    loaded: Option<QueueTrack>,
    /// 一次性标记：抑制本帧的自然结束检测（stop/seek/加载期间）
    suppress_end: bool,
    /// 节拍检测
    beat: Arc<beat::BeatMeter>,
    /// 已预排的下一首（gapless）。判定"切过去了"**不能**用 Player::empty()：
    /// rodio 的 len() 统计的是"尚未播完的音源数"（正在播的那首也算）⇒ 预排后它至少是 2，
    /// 本曲播完只减到 1，empty() 永远不会在换曲瞬间变 true（上一版进度条卡住就是这个原因）。
    /// 现在改用**位置回退**：每个音源自带 track_position，换源时位置会回到 ≈0。
    pending: Option<Pending>,
    /// 当前曲目在 Player 时间轴上的起点（换源后位置可能重置、也可能累计，见 switch_to_prefetched）
    pos_base: f64,
    /// 系统媒体控制句柄槽（主线程在 setup 里填入）。空 ⇒ 所有 SMTC 通知退化为空操作。
    smtc: Arc<OnceLock<SmtcHandle>>,
    /// 看门狗：上一 tick 读到的播放位置（秒）
    last_pos: f64,
    /// 看门狗：位置连续未前进的 tick 数
    stalled_ticks: u64,
    /// 输出设备已失效，正在等它回来（拔掉耳机再插回、蓝牙断开重连等）
    device_lost: bool,
    /// 等待设备期间的重试节流计数
    device_retry: u64,
    /// 设备失效时记住的播放位置，恢复后从这里继续
    resume_at: f64,
    /// 本轮等待是否已经打过「设备还没就绪」的日志（避免每秒刷屏）
    recover_logged: bool,
    /// 本轮等待已经持续了多少 tick（用于给端点门禁加超时兜底）
    wait_ticks: u64,
}

fn run_engine(
    app: tauri::AppHandle,
    rx: Receiver<EngineCommand>,
    shared: Arc<Mutex<PlayerState>>,
    alive: Arc<AtomicBool>,
    meter: Arc<beat::BeatMeter>,
    smtc: Arc<OnceLock<SmtcHandle>>,
    out_status: Arc<Mutex<OutputStatus>>,
) {
    // 本线程要调 CoreAudio 查默认输出端点状态：先把 COM 公寓准备好
    audio::init_com_for_audio();

    let mut ctx = EngineCtx {
        core: CoreAudio::new(out_status),
        queue: vec![],
        items: Arc::new(vec![]),
        order: Arc::new(vec![]),
        idx: None,
        perm: vec![],
        perm_pos: 0,
        status: PlayerStatus::Stopped,
        play_mode: PlayMode::LoopAll,
        volume: 80,
        // 默认关闭：上一首总是切歌（用户可在设置里显式开启「回到本曲开头」）
        restart_on_previous: false,
        seek_offset: 0.0,
        loaded: None,
        beat: meter,
        suppress_end: false,
        pending: None,
        pos_base: 0.0,
        smtc,
        last_pos: 0.0,
        stalled_ticks: 0,
        device_lost: false,
        device_retry: 0,
        resume_at: 0.0,
        recover_logged: false,
        wait_ticks: 0,
    };
    let mut tick: u64 = 0;

    loop {
        // 唤醒周期 50ms（原 200ms）：曲末检测、控制响应的粒度都由它决定。
    // 200ms 时「点暂停/切歌」最坏要等 200ms 才生效，曲间空隙也会被它放大；
    // 50ms 下这些延迟降到 1/4，而每次唤醒只是一次 select（无锁、无 I/O），开销可忽略。
    let cmd = rx.recv_timeout(Duration::from_millis(50));
        match cmd {
            Ok(EngineCommand::Shutdown) => break,
            Ok(c) => handle_command(&mut ctx, c, &app, &shared),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }

        // 非播放态（暂停/停止）清零节拍：暂停后不再有采样喂进来，
        // 包络会冻结在最后一帧（实测卡在 0.19），必须显式归零。
        if ctx.status != PlayerStatus::Playing {
            ctx.beat.reset();
        }

        // 周期性事务：自然结束检测 + 进度事件。
        // 进度事件仍按 ~800ms 节流：50ms × 16 = 800ms（唤醒周期改了，这里的倍数必须跟着改，
        // 否则进度事件会变成 200ms 一次、IPC 与前端重渲染翻 4 倍）。
        tick += 1;

        // 输出流自己报错（设备被拔掉/被占用）—— 最可靠的设备失效信号，任何状态下都要收
        // ⚠️ 这个标志每个 tick 都要取走：等待设备期间若任它积压，恢复成功的那一刻
        // 会被这条陈旧错误立刻再打断一次（又是一次「从 0 重播」）。
        let stream_error = ctx.core.take_device_error();
        if stream_error && !ctx.device_lost {
            enter_device_lost(&mut ctx, &app, &shared);
        }
        // 处在「等待设备回来」状态：先尝试恢复（拔掉耳机再插回来就走这条）
        if ctx.device_lost {
            try_recover_device(&mut ctx, &app, &shared);
        }

        if ctx.status == PlayerStatus::Playing {
            // 每 tick 检查一次"该不该预排下一首"（不满足条件会立刻返回，成本可忽略）
            prefetch_next(&mut ctx, &app);
            // gapless：位置回退 ⇒ 预排的那首已经接着播了（只切逻辑状态，绝不碰音频）
            // 预排的那首是否已经开始播了？
            // ⚠️ 判据不能只有「位置回退到预排点之前」：时长小于 PREFETCH_LEAD_SECS 的短曲会在
            //    开头就预排，此时 pos_at_prefetch ≈ 0 ⇒ 那个条件永远不成立 ⇒ pending 永远挂着；
            //    而 pending.is_some() 会**禁用自然结束检测** ⇒ 界面永远停在上一首、之后再也不会推进
            //    （用户报的「播完 Opus 后界面停在 Opus 上」就是这个）。
            //    所以补一条通用判据：位置比上一 tick 明显回退（rodio 给每个追加的音源各自计时，
            //    换源时位置会归零）。
            let pos_now = position_secs(&ctx);
            let switched = match ctx.pending.as_mut() {
                Some(p) => {
                    let fell_back = pos_now + 0.5 < p.pos_at_prefetch;
                    let wrapped = pos_now + 0.5 < p.last_pos;
                    p.last_pos = pos_now;
                    if fell_back || wrapped {
                        let idx = p.idx;
                        ctx.pending = None;
                        switch_to_prefetched(&mut ctx, idx, &app, &shared);
                        true
                    } else {
                        false
                    }
                }
                None => false,
            };
            // 没有预排时的自然结束：仍用原来的 empty() 判定（最后一首 / 预排失败 / 顺序到末尾）
            let ended = !switched
                && ctx.pending.is_none()
                && !ctx.suppress_end
                && ctx.core.sink_is_some()
                && ctx.core.player_empty();
            if ended {
                on_natural_end(&mut ctx, &app, &shared);
            } else if !switched {
                // 看门狗必须每个 tick 都跑：设备失效后既不会有自然结束，也不会有任何
                // 错误回调，唯一能观测到的现象就是「位置不再前进」。
                watchdog_device(&mut ctx, &app, &shared);
                if ctx.status == PlayerStatus::Playing && tick % 16 == 0 {
                    emit_progress(&ctx, &app);
                    // 同步刷新快照中的播放位置，避免 player_state 返回陈旧进度
                    if let Some(pos) = current_item(&ctx).map(|(_, np)| np.position_secs) {
                        if let Ok(mut g) = shared.lock() {
                            if let Some(cur) = g.current.as_mut() {
                                cur.position_secs = pos;
                            }
                        }
                    }
                }
            }
        }
    }

    ctx.core.clear_player();
    alive.store(false, Ordering::Relaxed);
}

fn handle_command(ctx: &mut EngineCtx, cmd: EngineCommand, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
    // 等待设备期间，用户的任何操作都立刻催一次恢复尝试：
    // 否则「点播放没反应」看起来就像卡死了（设备已经回来时也能马上接上）。
    if ctx.device_lost {
        ctx.device_retry = DEVICE_RETRY_TICKS;
    }
    match cmd {
        EngineCommand::SetQueue { items, start, autoplay } => {
            ctx.queue = items;
            // 队列整体变化只发生在这里 —— 只有这一处需要重新物化 IPC 形态
            ctx.items = Arc::new(ctx.queue.iter().map(to_queue_item).collect());
            ctx.idx = if ctx.queue.is_empty() { None } else { Some(start.min(ctx.queue.len() - 1)) };
            ctx.perm_pos = 0;
            // 队列换了 ⇒ 预排与位置基准都作废
            ctx.pending = None;
            ctx.pos_base = 0.0;
            rebuild_perm(ctx);
            if autoplay {
                ctx.status = PlayerStatus::Paused;
                if let Some(i) = ctx.idx {
                    load_and_play(ctx, i, app);
                } else {
                    ctx.status = PlayerStatus::Stopped;
                    ctx.core.clear_player();
                }
            } else {
                ctx.status = PlayerStatus::Paused;
                ctx.core.clear_player();
                ctx.loaded = None;
            }
            sync_shared(ctx, app, shared);
        }
        EngineCommand::LoadPaused { index } => {
            load_paused(ctx, index, app);
            sync_shared(ctx, app, shared);
        }
        EngineCommand::Toggle => match ctx.status {
            PlayerStatus::Playing => {
                pause_inner(ctx);
                sync_shared(ctx, app, shared);
            }
            PlayerStatus::Paused => {
                if ctx.suppress_end && ctx.loaded.is_none() {
                    // 过渡态：忽略
                }
                if ctx.loaded.is_some() {
                    resume_inner(ctx);
                } else if let Some(i) = ctx.idx {
                    ctx.status = PlayerStatus::Paused;
                    load_and_play(ctx, i, app);
                }
                sync_shared(ctx, app, shared);
            }
            PlayerStatus::Stopped => {
                if let Some(i) = ctx.idx {
                    ctx.status = PlayerStatus::Paused;
                    load_and_play(ctx, i, app);
                    sync_shared(ctx, app, shared);
                }
            }
        },
        EngineCommand::Pause => {
            if ctx.status == PlayerStatus::Playing {
                pause_inner(ctx);
                sync_shared(ctx, app, shared);
            }
        }
        EngineCommand::Resume => {
            if ctx.status == PlayerStatus::Paused && ctx.loaded.is_some() {
                resume_inner(ctx);
                sync_shared(ctx, app, shared);
            }
        }
        EngineCommand::Stop => {
            let was_stopped = ctx.status == PlayerStatus::Stopped;
            // 用户明确停止：取消「等待设备」状态，别在他停止之后又自己放起来
            ctx.device_lost = false;
            ctx.status = PlayerStatus::Stopped;
            ctx.suppress_end = true;
            ctx.core.clear_player();
            ctx.loaded = None;
            ctx.pending = None;
            ctx.pos_base = 0.0;
            if !was_stopped {
                sync_shared(ctx, app, shared);
            }
        }
        EngineCommand::Next => {
            advance(ctx, true, app);
            sync_shared(ctx, app, shared);
        }
        EngineCommand::Previous => {
            go_previous(ctx, app);
            sync_shared(ctx, app, shared);
        }
        EngineCommand::Seek { position_secs } => {
            if ctx.loaded.is_some() {
                // 原地 seek 是毫秒级，不需要乐观预广播（预广播会让位置叠加出错）
                seek_to(ctx, position_secs.max(0.0), app);
                sync_shared(ctx, app, shared);
            }
        }
        EngineCommand::SetVolume { volume } => {
            ctx.volume = volume.min(100);
            ctx.core.set_volume(ctx.volume as f32 / 100.0);
            sync_shared(ctx, app, shared);
        }
        EngineCommand::SetPlayMode { mode } => {
            ctx.play_mode = mode;
            rebuild_perm(ctx);
            sync_shared(ctx, app, shared);
        }
        EngineCommand::SetOutputDevice { id } => {
            if ctx.core.set_preferred(id) {
                remigrate_output(ctx, app, shared);
            }
        }
        EngineCommand::SetOutputMode { mode } => {
            // 模式改了要重开输出才会生效：当前后端已经被固定下来了（见 CoreAudio::set_mode）。
            // 复用与换设备同一套迁移流程（重开并尽量回到原位置）。
            if ctx.core.set_mode(mode) {
                remigrate_output(ctx, app, shared);
            }
        }
        EngineCommand::RetryOutput => {
            // 先清掉上次的回退结论，再重开输出；没有在播的曲目时状态会回到「尚未打开」。
            ctx.core.forget_fallback();
            remigrate_output(ctx, app, shared);
        }
        EngineCommand::SetPreviousRestart { enabled } => {
            // 全文件唯一一个不调 sync_shared 的非空分支：该偏好不进 PlayerState 快照、
            // 不影响音频输出，sync 只会白发一次内容毫无变化的状态事件
            // （而 player-state 会驱动前端重拉队列，属于无谓抖动）。
            ctx.restart_on_previous = enabled;
        }
        EngineCommand::Shutdown => {}
    }
}

// ---------------------------------------------------------------------------
// 播放控制
// ---------------------------------------------------------------------------

/// 单次装载的结果。
/// 区分「设备问题」与「单曲问题」很重要：设备打不开时跳过这一首毫无意义（下一首同样打不开），
/// 而单个文件坏掉时正相反 —— 应该继续往下找能播的。
enum LoadAttempt {
    Loaded,
    DeviceError,
    TrackError { code: String, message: String, track_id: i64 },
}

/// 加载并播放队列第 i 首。单个文件读不了时**自动跳过**到下一首可播曲目：
/// 旧实现只把状态停在 Paused 并报一次错，用户必须一首首手动点过去 ——
/// 一张专辑里混进几个损坏/被移走的文件时体验极差。
fn load_and_play(ctx: &mut EngineCtx, i: usize, app: &tauri::AppHandle) {
    if i >= ctx.queue.len() {
        ctx.status = PlayerStatus::Stopped;
        ctx.idx = None;
        ctx.loaded = None;
        ctx.core.clear_player();
        return;
    }
    let mut next = i;
    // 预算 = 队列长度：循环模式（列表循环 / 单曲循环 / 随机）的「下一首」会绕回起点，
    // 没有预算约束就会在一条全是坏文件的队列里无限打转
    let mut budget = ctx.queue.len();
    let mut skipped: Vec<(String, String, i64)> = Vec::new();

    loop {
        match try_load(ctx, next) {
            LoadAttempt::Loaded => break,
            LoadAttempt::DeviceError => {
                let track_id = ctx.loaded.as_ref().map(|t| t.track_id);
                ctx.status = PlayerStatus::Paused;
                ctx.loaded = None;
                ctx.suppress_end = false;
                emit_skip_report(app, &skipped);
                // 打不开设备 ⇒ 进入「等待设备」而不是报一次错就结束：
                // 这样「启动时没插设备、之后才插上」也能自动开始播放
                // 只在「首次」进入等待时提示：等待期间用户按下一首之类会再走一次这里，
                // 每次都弹就成了刷屏
                let first = !ctx.device_lost;
                enter_device_wait(ctx, 0.0);
                if first {
                    eprintln!("[engine] 打不开输出设备，等待设备接入后自动开始播放");
                    emit_error(app, "AUDIO_DEVICE", "音频输出设备不可用，接入设备后会自动开始播放", track_id);
                }
                return;
            }
            LoadAttempt::TrackError { code, message, track_id } => {
                skipped.push((code, message, track_id));
                budget -= 1;
                if budget == 0 {
                    break;
                }
                // 用「自然结束」的推进语义找下一首：顺序模式到末尾就停，其余模式绕回。
                // try_load 已经把 ctx.idx 设成失败的这一首，所以这里算出的是它后面那首。
                match next_index(ctx, false) {
                    Some(n) if n != next => next = n,
                    _ => break,
                }
            }
        }
    }

    if ctx.loaded.is_none() {
        // 整轮下来一首都没能播：停住（调用方的 sync_shared 会把状态更新出去）
        ctx.status = PlayerStatus::Paused;
        ctx.suppress_end = false;
    }
    emit_skip_report(app, &skipped);
}

/// 装载队列第 i 首（不含跳歌逻辑）
fn try_load(ctx: &mut EngineCtx, i: usize) -> LoadAttempt {
    let item = ctx.queue[i].clone();
    ctx.idx = Some(i);
    ctx.loaded = Some(item.clone());
    ctx.seek_offset = 0.0;
    ctx.suppress_end = true;
    // 新建 Player ⇒ 时间轴重来：清掉 gapless 预排与位置基准
    ctx.pending = None;
    ctx.pos_base = 0.0;
    // 换了音源：停滞看门狗重新计时
    ctx.last_pos = 0.0;
    ctx.stalled_ticks = 0;

    // 先开解码器、再开输出：独占模式要用曲目采样率去协商设备格式，
    // 而设备一旦打开就固定了采样率（mixer 与设备率不一致 = 变速播放，见 3.2.8）。
    let decoder = match open_decoder(&item.path) {
        Ok(d) => d,
        Err(e) => {
            ctx.loaded = None;
            ctx.suppress_end = false;
            return LoadAttempt::TrackError {
                code: e.code.to_string(),
                message: e.message.clone(),
                track_id: item.track_id,
            };
        }
    };
    if ctx.core.new_player(Some(audio::decoder_sample_rate(&decoder))).is_err() {
        return LoadAttempt::DeviceError;
    }
    if let Some(d) = audio::decoder_duration(&decoder).map(|d| d.as_secs_f64()) {
        if let Some(q) = ctx.queue.get_mut(i) {
            q.duration_secs = d;
        }
        // 同步进 IPC 形态的缓存。Arc::make_mut 只在还有别的持有者时克隆一次队列
        // （sync_shared 刚发出去过一份），即每首歌开头付一次 O(n) ——
        // 相比原来「每条命令都重建整条队列」，这已经不是一个量级了。
        if let Some(it) = Arc::make_mut(&mut ctx.items).get_mut(i) {
            it.duration_secs = d;
        }
    }
    ctx.core.player_append(decoder, ctx.beat.clone());
    ctx.status = PlayerStatus::Playing;
    ctx.suppress_end = false;
    LoadAttempt::Loaded
}

/// 上报本次装载跳过/失败的曲目。
/// 只有一首时逐位保持旧行为（原样上报那一首的错误码与文案）；
/// 多首时合并成一条 —— 否则一张专辑里 10 个坏文件就是 10 条 toast 刷屏。
fn emit_skip_report(app: &tauri::AppHandle, skipped: &[(String, String, i64)]) {
    // 跳歌是「用户看不见决策」的行为，落一条日志便于核对
    if !skipped.is_empty() {
        eprintln!(
            "[engine] 跳过 {} 首无法播放的曲目（首个 track_id={}: {}）",
            skipped.len(),
            skipped[0].2,
            skipped[0].1
        );
    }
    match skipped {
        [] => {}
        [(code, message, track_id)] => emit_error(app, code, message, Some(*track_id)),
        many => emit_error(
            app,
            &many[0].0,
            &format!("已跳过 {} 首无法播放的歌曲（文件损坏、格式不支持或已被移动）", many.len()),
            Some(many[0].2),
        ),
    }
}

/// 装载一首但保持暂停。与 load_and_play 的唯一区别：先 pause 再 append，状态记为 Paused。
/// rodio 的 Player::append 只会恢复被 stop() 的播放、不会解除 pause ⇒ 一点声音都不会出。
fn load_paused(ctx: &mut EngineCtx, i: usize, app: &tauri::AppHandle) {
    if i >= ctx.queue.len() {
        return;
    }
    let item = ctx.queue[i].clone();
    ctx.idx = Some(i);
    ctx.loaded = Some(item.clone());
    ctx.seek_offset = 0.0;
    ctx.suppress_end = true;
    // 新建 Player ⇒ 时间轴重来：清掉 gapless 预排与位置基准
    ctx.pending = None;
    ctx.pos_base = 0.0;
    ctx.last_pos = 0.0;
    ctx.stalled_ticks = 0;
    // 与 try_load 同样：先解码拿采样率，再开输出（独占要按曲目率协商）
    let decoder = match open_decoder(&item.path) {
        Ok(d) => d,
        Err(err) => {
            ctx.status = PlayerStatus::Paused;
            ctx.loaded = None;
            emit_error(app, &err.code, &err.message, Some(item.track_id));
            return;
        }
    };
    if ctx.core.new_player(Some(audio::decoder_sample_rate(&decoder))).is_err() {
        ctx.status = PlayerStatus::Paused;
        emit_error(app, "AUDIO_DEVICE", "无法打开音频输出设备（WASAPI）", Some(item.track_id));
        return;
    }
    if let Some(d) = audio::decoder_duration(&decoder).map(|d| d.as_secs_f64()) {
        if let Some(q) = ctx.queue.get_mut(i) {
            q.duration_secs = d;
        }
        if let Some(it) = Arc::make_mut(&mut ctx.items).get_mut(i) {
            it.duration_secs = d;
        }
    }
    ctx.core.player_pause();
    ctx.core.player_append(decoder, ctx.beat.clone());
    ctx.status = PlayerStatus::Paused;
}

/// gapless 预排：把下一首解码后 append 到**同一个 Player**。
/// rodio 的队列是顺序播放、且 append 时自动做采样率/声道转换 ⇒ 接着播天然无缝，
/// 而且不需要重新初始化音频设备（设备只在 ensure() 里开一次）。
/// gapless 该预排哪一首：单曲循环 = 自己（无缝循环）；其余走播放模式的"自然下一首"。
/// ⚠️ next_index 的 LoopOne 是**手动语义**（下一首），自然结束时要的是"自己"，所以在这里绕开。
fn prefetch_target(ctx: &mut EngineCtx) -> Option<usize> {
    match ctx.play_mode {
        PlayMode::LoopOne => ctx.idx,
        _ => next_index(ctx, false),
    }
}

fn prefetch_next(ctx: &mut EngineCtx, app: &tauri::AppHandle) {
    if ctx.pending.is_some() || ctx.queue.is_empty() || ctx.status != PlayerStatus::Playing {
        return;
    }
    let Some(i) = ctx.idx else {
        return;
    };
    let Some(cur) = ctx.queue.get(i) else {
        return;
    };
    let dur = cur.duration_secs;
    if dur <= 0.0 || dur - position_secs(ctx) > PREFETCH_LEAD_SECS {
        return;
    }
    let Some(n) = prefetch_target(ctx) else {
        return;
    };
    let Some(item) = ctx.queue.get(n).cloned() else {
        return;
    };
    let Ok(decoder) = open_decoder(&item.path) else {
        // 预排失败不影响播放：到自然结束时仍会走 on_natural_end 的老路
        return;
    };
    if let Some(d) = audio::decoder_duration(&decoder).map(|d| d.as_secs_f64()) {
        if let Some(q) = ctx.queue.get_mut(n) {
            q.duration_secs = d;
        }
        if let Some(it) = Arc::make_mut(&mut ctx.items).get_mut(n) {
            it.duration_secs = d;
        }
    }
    // ⚠️ player_append 会按这个解码器的采样率设置节拍表；预排的若是另一种采样率，
    // 节拍表会在本曲最后 PREFETCH_LEAD_SECS 秒里用错 α —— 那是装饰性律动，忽略。
    let at = position_secs(ctx);
    ctx.core.player_append(decoder, ctx.beat.clone());
    eprintln!(
        "[engine] 预排下一首 track_id={}（本曲 {:.1}s 处、剩余 {:.1}s）",
        item.track_id,
        at,
        dur - at
    );
    ctx.pending = Some(Pending { idx: n, pos_at_prefetch: at, last_pos: at });
    let _ = app;
}

/// 预排的那首开始播放了：切换逻辑状态（下标/时长/事件），**不动音频**。
fn switch_to_prefetched(
    ctx: &mut EngineCtx,
    idx: usize,
    app: &tauri::AppHandle,
    shared: &Arc<Mutex<PlayerState>>,
) {
    // 位置基准探测：rodio 的 Player 在队列换源时是否重置位置没有明确文档，
    // 用事实判断 —— 刚切过去时位置要么≈0（重置），要么≈上一首时长（累计）。
    let prev_dur = ctx
        .idx
        .and_then(|i| ctx.queue.get(i))
        .map(|q| q.duration_secs)
        .unwrap_or(0.0);
    let p_now = ctx.core.player_pos_secs();
    ctx.pos_base = if prev_dur > 0.0 && p_now > prev_dur * 0.5 { prev_dur } else { 0.0 };
    ctx.seek_offset = 0.0;
    ctx.idx = Some(idx);
    ctx.loaded = Some(ctx.queue[idx].clone());
    ctx.suppress_end = false;
    eprintln!(
        "[engine] 预排曲目已开始播放：track_id={} 位置基准={:.1}s",
        ctx.queue[idx].track_id,
        ctx.pos_base
    );
    sync_shared(ctx, app, shared);
    emit_state_event(ctx, app);
    emit_progress(ctx, app);
}

fn pause_inner(ctx: &mut EngineCtx) {
    ctx.core.player_pause();
    ctx.status = PlayerStatus::Paused;
}

fn resume_inner(ctx: &mut EngineCtx) {
    if ctx.core.sink_is_some() {
        ctx.core.player_play();
        ctx.status = PlayerStatus::Playing;
    }
}

/// 立刻把播放迁到当前偏好的输出设备上（用户在设置里换了设备时用），尽量保持播放位置。
fn remigrate_output(ctx: &mut EngineCtx, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
    let Some(idx) = ctx.idx else {
        // 没有在装的曲目：把设备换掉就行，不需要迁移播放
        ctx.core.reset_device();
        return;
    };
    let was_playing = ctx.status == PlayerStatus::Playing;
    let at = position_secs(ctx);
    ctx.core.reset_device();
    ctx.status = PlayerStatus::Paused;
    load_and_play(ctx, idx, app);
    if ctx.status == PlayerStatus::Playing {
        if at > 1.0 {
            seek_to(ctx, at, app);
        }
        if !was_playing {
            pause_inner(ctx);
        }
    } else {
        // 新设备当前打不开：进入等待，等它可用时自动接上（位置留着）
        enter_device_wait(ctx, at);
        ctx.status = PlayerStatus::Paused;
    }
    sync_shared(ctx, app, shared);
}

/// 设备停滞看门狗 —— **兜底**路径。
/// 首选信号是 rodio 自己的输出流错误回调（见 audio.rs 的 take_device_error）：
/// 设备被拔掉时它会明确报错，比这里猜要可靠得多。
/// 这里保留位置探针，覆盖「流没报错但已经不推进」的失效形态：
/// 连续 STALL_TICKS 个 tick 位置不动，就按设备失效处理。
fn watchdog_device(ctx: &mut EngineCtx, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
    if ctx.status != PlayerStatus::Playing || !ctx.core.sink_is_some() || ctx.suppress_end {
        ctx.stalled_ticks = 0;
        ctx.last_pos = position_secs(ctx);
        return;
    }
    let pos = position_secs(ctx);
    // 位置只要动过就重新计时（gapless 换源后可能回退，seek 后可能前跳，都算「活着」）
    if (pos - ctx.last_pos).abs() > 0.02 {
        ctx.last_pos = pos;
        ctx.stalled_ticks = 0;
        return;
    }
    ctx.last_pos = pos;
    ctx.stalled_ticks += 1;
    if ctx.stalled_ticks < STALL_TICKS {
        return;
    }
    ctx.stalled_ticks = 0;
    eprintln!(
        "[engine] 播放位置停滞 {:.1}s，按输出设备失效处理",
        STALL_TICKS as f64 * 0.05
    );
    enter_device_lost(ctx, app, shared);
}

/// 进入「等待输出设备回来」状态。
/// ⚠️ 这里**刻意不重开设备**：拔掉耳机的那一刻往往根本没有设备可开，重开必然失败。
/// 重开交给 try_recover_device 的每秒重试循环。
fn enter_device_wait(ctx: &mut EngineCtx, resume_at: f64) {
    // ⚠️ 无条件写入：调用方给出的才是这次要恢复的位置
    // （设备失效时传当前进度；换歌 / 换队列时传 0.0）。
    // 「重试失败不能丢掉位置」由 try_recover_device 自己显式写回 —— 一旦把这条不变量
    // 藏进这里的条件分支，就会重演上一版的 bug：device_lost 永远清不掉。
    ctx.resume_at = resume_at;
    ctx.device_lost = true;
    ctx.device_retry = 0;
    ctx.recover_logged = false;
    ctx.wait_ticks = 0;
    ctx.pending = None;
    ctx.pos_base = 0.0;
    // 先丢掉失效的 sink：留着的话 new_player 里的 ensure() 会直接复用那个已经死掉的设备
    ctx.core.reset_device();
}

/// 设备失效（错误回调 / 位置停滞 / 装载时打不开设备）后的统一处理：
/// 记住位置、转暂停、提示一次，然后进入等待设备回来的循环
fn enter_device_lost(ctx: &mut EngineCtx, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
    if ctx.loaded.is_none() {
        // 没有在播/在装的曲目：丢掉设备就行，不需要恢复流程
        ctx.core.reset_device();
        return;
    }
    let at = position_secs(ctx);
    enter_device_wait(ctx, at);
    ctx.status = PlayerStatus::Paused;
    eprintln!("[engine] 输出设备失效（位置 {:.1}s），等待设备恢复…", at);
    sync_shared(ctx, app, shared);
    emit_error(
        app,
        "AUDIO_DEVICE",
        "音频输出设备已断开（或已被其它程序占用），设备回来后会自动继续播放",
        ctx.loaded.as_ref().map(|t| t.track_id),
    );
}

/// 恢复目标的选择结果
#[derive(Debug, PartialEq)]
enum RecoverTarget {
    /// 明确开这台设备（原设备回来了）
    Original(String),
    /// 跟随系统默认设备
    FollowDefault,
    /// 继续等待
    KeepWaiting,
}

/// 恢复目标的选择（纯函数，单测覆盖）：
/// - 原设备回到 ACTIVE ⇒ 开它。这是「插回耳机就该有声音」的关键 —— **绝不能退回默认设备**：
///   拔掉耳机后系统默认会切到显示器 HDMI 音频那类常驻 ACTIVE 的端点（实测这台机器上就是），
///   接到那台上不报错、位置照走、却永远没有声音。
/// - 原设备还没回来且仍在宽限期内 ⇒ 继续等
/// - 等够了 ⇒ 跟随系统默认设备（用户也可能就是想换到别的设备上放）
fn choose_recover_target(
    wanted: Option<(&str, Option<bool>)>,
    waited_ticks: u64,
    allow_fallback: bool,
) -> RecoverTarget {
    if let Some((id, active)) = wanted {
        if active == Some(true) {
            return RecoverTarget::Original(id.to_string());
        }
    }
    // allow_fallback=false 表示用户在设置里指定了设备：等多久都不改用系统默认
    if allow_fallback && waited_ticks >= DEVICE_WAIT_GRACE_TICKS {
        RecoverTarget::FollowDefault
    } else {
        RecoverTarget::KeepWaiting
    }
}

/// 等待设备期间的恢复循环：每 DEVICE_RETRY_TICKS（约 1 秒）尝试恢复一次，
/// 成功就回到失效时记住的位置继续播放。
///
/// 关键不是「打开系统默认设备」，而是**打开我们原来那台设备**：
/// 拔掉耳机后 Windows 会把默认输出切到另一台常驻可用的端点上（实测这台机器上是
/// 「G24H2Classics」= 显示器的 HDMI 音频，DEVICE_STATE 一直 ACTIVE）。那台设备能打开、
/// 不报错、位置照常推进，但当然推不出声音 —— 只盯着「默认设备」就会一路接到它上面，
/// 表现正是「还没插回来自动就播了、插回耳机也没声音」。
/// 所以这里优先按 id 等原设备回来；等够 DEVICE_WAIT_GRACE_TICKS 之后再跟随系统默认设备。
fn try_recover_device(ctx: &mut EngineCtx, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
    ctx.wait_ticks += 1;
    ctx.device_retry += 1;
    if ctx.device_retry < DEVICE_RETRY_TICKS {
        return;
    }
    ctx.device_retry = 0;

    let Some(idx) = ctx.idx else {
        ctx.device_lost = false;
        return;
    };
    let at = ctx.resume_at;

    // 该恢复到哪台设备：
    // - 用户在设置里指定了输出设备 ⇒ 就等它，**不回退**到系统默认（那是他的明确选择）
    // - 没指定 ⇒ 用「我们最后播放的那台」（endpoint_id 在 reset_device 之后依然保留）
    let preferred = ctx.core.preferred_device_id().map(|s| s.to_string());
    let (wanted, allow_fallback) = match preferred.as_deref() {
        Some(p) => (Some(p.to_string()), false),
        None => (ctx.core.endpoint_id().map(|s| s.to_string()), true),
    };
    let wanted_active = wanted.as_deref().and_then(endpoint_active);

    // Some(id) = 明确开这台；None = 开系统默认设备
    let target: Option<String> = match choose_recover_target(
        wanted.as_deref().map(|id| (id, wanted_active)),
        ctx.wait_ticks,
        allow_fallback,
    ) {
        RecoverTarget::Original(id) => Some(id),
        RecoverTarget::FollowDefault => {
            // 跟随系统默认设备之前，仍要确认默认端点真的 ACTIVE，
            // 否则会接到一个「能打开却推不出声音」的端点上（上一版剩下的坑）
            let blocked = match probe_default_output() {
                DefaultOutput::Found { active: true, .. } => None,
                DefaultOutput::Found { state, .. } => Some(format!("DEVICE_STATE={state}")),
                DefaultOutput::Missing => Some("没有可用的输出设备".to_string()),
                // 查不到（COM / 音频服务异常）就放行，别让诊断性查询把恢复卡死
                DefaultOutput::Unknown => None,
            };
            if let Some(why) = blocked {
                if !ctx.recover_logged {
                    ctx.recover_logged = true;
                    eprintln!("[engine] 系统默认输出端点不可用（{why}），继续等待");
                }
                return;
            }
            None
        }
        RecoverTarget::KeepWaiting => {
            if !ctx.recover_logged {
                ctx.recover_logged = true;
                eprintln!(
                    "[engine] 目标输出设备（{}）尚未就绪，继续等待{}",
                    ctx.core.endpoint_name().unwrap_or("未知设备"),
                    if allow_fallback {
                        format!("；{} 秒后改为跟随系统默认设备", DEVICE_WAIT_GRACE_TICKS / DEVICE_RETRY_TICKS)
                    } else {
                        "（已在设置里指定，不会改用系统默认设备）".to_string()
                    }
                );
            }
            return;
        }
    };

    // 先丢弃失效的 sink：sink 还在的话 ensure_with 会直接返回 Ok 复用那个死设备
    ctx.core.reset_device();
    if ctx.core.ensure_with(target.as_deref()).is_err() {
        if !ctx.recover_logged {
            ctx.recover_logged = true;
            eprintln!("[engine] 目标输出设备当前打不开，每秒重试中");
        }
        return;
    }

    // 先清掉等待标记再装载：load_and_play 在设备仍打不开时会自己把它重新置位（见它的
    // DeviceError 分支）。但成败判定**不看这个标记**，而看「有没有真的开始播放」——
    // 上一版的真凶正是回读这个标记：忘了先清它 ⇒ 每次都被判成失败，可它其实已经开播了，
    // 于是每秒重开一次设备并从 0 重播，听感就是「一直循环播放这首歌的前 1 秒」。
    ctx.device_lost = false;
    ctx.status = PlayerStatus::Paused;
    load_and_play(ctx, idx, app);

    if ctx.status != PlayerStatus::Playing {
        // 设备还没回来（load_and_play 已重新进入等待）或队列里没得播：位置留下，下一轮再试
        ctx.resume_at = at;
        return;
    }
    if at > 1.0 {
        seek_to(ctx, at, app);
    }
    if ctx.status == PlayerStatus::Playing {
        eprintln!(
            "[engine] 输出已恢复：{}，从 {:.1}s 继续播放",
            ctx.core.endpoint_name().unwrap_or("未知设备"),
            at
        );
        sync_shared(ctx, app, shared);
    } else {
        // seek 之后没能保持播放（罕见）：别把恢复位置丢了
        ctx.resume_at = at;
    }
}

/// 跳转：按设计文档 §4.3 “通过重解码实现”
fn seek_to(ctx: &mut EngineCtx, pos_secs: f64, app: &tauri::AppHandle) {
    // 预排的那首仍在队列里，只是"位置回退"的判定基准要跟着新的位置走
    if let Some(p) = ctx.pending.as_mut() {
        // 跳转会让位置骤降，别让「回退判定」把它误判成换源
        p.pos_at_prefetch = pos_secs.max(0.0);
        p.last_pos = pos_secs.max(0.0);
    }
    let Some(item) = ctx.loaded.clone() else { return };
    let was_paused = ctx.status == PlayerStatus::Paused;

    let dur = ctx.queue.get(ctx.idx.unwrap_or(0)).map(|q| q.duration_secs).unwrap_or(0.0);
    let target = if dur > 0.0 { pos_secs.min(dur) } else { pos_secs };
    ctx.seek_offset = target;

    // 原地 seek（symphonia 格式级定位，毫秒级、不打断播放）。
    // 之前是"清空播放器 + 重解码 + 逐样本排水"，拖到几十秒后要几秒才到位，
    // 前端进度条与歌词都要等它，表现为"歌词定位非常慢"。
    //
    // ⚠️ 只有**便宜的**定位才允许走这条：rodio 的原地 seek 实际是在音频线程上执行的，
    //    而 DSD/ADTS 的定位是 O(跳转距离) 的字节/帧遍历 —— 放音频线程上就是几百毫秒欠载，
    //    用户听到的正是「跳得越远、电音越长」。所以自定义源一律走下面那条引擎线程的路径。
    if audio::inline_seek_is_cheap(&item.path)
        && ctx.core.player_seek(Duration::from_secs_f64(target))
    {
        // 原地 seek 后播放器位置就是目标位置，seek_offset 必须归零，
        // 否则 current_item 会把位置算成「新位置 + 目标」= 两倍（实测跳到 29.3s 的句子显示 59.6s）
        ctx.seek_offset = 0.0;
        ctx.suppress_end = false;
        return;
    }

    // 引擎线程上的重新定位：重开解码器 → 按块/帧跳过（不做逐样本解码）→ 重挂到**同一个输出**。
    // 用 stop_player 而不是 clear_player：跳转这几百毫秒里独占设备保持打开，
    // 渲染线程只是拉不到样本（吐静音），不会欠载、也不会多一次设备重开。
    ctx.suppress_end = true;
    ctx.core.stop_player();
    match open_decoder(&item.path) {
        Ok(mut decoder) => {
            let actual = seek_decoder(&mut decoder, Duration::from_secs_f64(target));
            ctx.seek_offset = actual;
            if ctx.core.new_player(Some(audio::decoder_sample_rate(&decoder))).is_ok() {
                ctx.core.player_append(decoder, ctx.beat.clone());
                if was_paused {
                    pause_inner(ctx);
                } else {
                    ctx.status = PlayerStatus::Playing;
                }
            } else {
                ctx.status = PlayerStatus::Paused;
            }
            ctx.suppress_end = false;
        }
        Err(e) => {
            // 解码都失败了，没必要继续占着输出（独占模式会把设备一直占住）
            ctx.core.clear_player();
            ctx.status = PlayerStatus::Paused;
            ctx.suppress_end = false;
            emit_error(app, &e.code, &e.message, Some(item.track_id));
        }
    }
}

/// 自然结束（单曲循环 / 自动下一首 / 队列末尾停止）
fn on_natural_end(ctx: &mut EngineCtx, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
    eprintln!("[engine] 自然结束：mode={:?} idx={:?}", ctx.play_mode, ctx.idx);
    match ctx.play_mode {
        PlayMode::LoopOne => {
            if let Some(i) = ctx.idx {
                let was_playing = ctx.status == PlayerStatus::Playing;
                ctx.status = PlayerStatus::Paused;
                load_and_play(ctx, i, app);
                if !was_playing {
                    pause_inner(ctx);
                }
                sync_shared(ctx, app, shared);
            }
        }
        _ => {
            advance(ctx, false, app);
            sync_shared(ctx, app, shared);
        }
    }
}

/// 按当前播放模式算出「下一首」的队列下标（manual = 手动跳转：忽略单曲循环、末尾绕回）。
/// 抽成独立函数是为了让 gapless 预排与 advance 用**同一套**索引算法（含随机置换的推进）。
fn next_index(ctx: &mut EngineCtx, manual: bool) -> Option<usize> {
    let len = ctx.queue.len();
    if len == 0 {
        return None;
    }
    let cur = ctx.idx.unwrap_or(0);
    match ctx.play_mode {
        PlayMode::Shuffle => {
            if ctx.perm.is_empty() {
                rebuild_perm(ctx);
            }
            let p = ctx.perm_pos + 1;
            if p >= ctx.perm.len() {
                ctx.perm_pos = 0;
                ctx.perm[0].into()
            } else {
                ctx.perm_pos = p;
                ctx.perm[p].into()
            }
        }
        PlayMode::LoopAll => Some((cur + 1) % len),
        // 手动 Next 忽略单曲循环；自然结束的"下一首"由 prefetch_next 特殊处理成"还是自己"
        PlayMode::LoopOne => Some((cur + 1) % len),
        PlayMode::Sequential => {
            if cur + 1 >= len {
                if manual {
                    Some(0)
                } else {
                    None
                }
            } else {
                Some(cur + 1)
            }
        }
    }
}

/// 推进到下一首（manual=false 为自然结束自动推进）
fn advance(ctx: &mut EngineCtx, manual: bool, app: &tauri::AppHandle) {
    let len = ctx.queue.len();
    if len == 0 {
        return;
    }
    let next_idx = next_index(ctx, manual);
    match next_idx {
        Some(n) => {
            let was_playing = ctx.status == PlayerStatus::Playing;
            ctx.status = PlayerStatus::Paused;
            load_and_play(ctx, n, app);
            if !was_playing {
                pause_inner(ctx);
            }
        }
        None => {
            ctx.status = PlayerStatus::Stopped;
            ctx.suppress_end = true;
            ctx.core.clear_player();
            ctx.loaded = None;
        }
    }
}

/// 「上一首」决策的输入（纯数据，单测可直接构造）
#[derive(Clone, Copy)]
struct PreviousInput<'a> {
    len: usize,
    current: usize,
    /// 当前播放位置（秒）= core.player_pos_secs() + seek_offset
    pos_secs: f64,
    /// 设置项 previousRestart：true = 超过阈值时回到本曲开头
    restart_on_previous: bool,
    play_mode: PlayMode,
    /// 随机模式的洗牌序列（其他模式忽略）；空表示序列未就绪，退化为顺序回退
    perm: &'a [usize],
    perm_pos: usize,
}

/// 「上一首」决策结果
struct PreviousStep {
    /// 目标队列下标（== current 即「回到本曲开头」）
    index: usize,
    /// 随机模式下要写回的 perm_pos（其他模式原样返回）
    perm_pos: usize,
}

/// 算出「上一首」的目标下标（纯函数：不碰 AppHandle / 音频设备 / 文件系统）
fn previous_step(inp: PreviousInput<'_>) -> PreviousStep {
    debug_assert!(inp.len > 0, "调用方保证队列非空");
    if inp.restart_on_previous && inp.pos_secs > PREVIOUS_RESTART_THRESHOLD_SECS {
        // 回到本曲开头：不动洗牌位置，否则「重播本曲后再按下一首」会跳歌
        return PreviousStep { index: inp.current, perm_pos: inp.perm_pos };
    }
    match inp.play_mode {
        PlayMode::Shuffle if !inp.perm.is_empty() => {
            let p = if inp.perm_pos == 0 { inp.perm.len() - 1 } else { inp.perm_pos - 1 };
            PreviousStep { index: inp.perm[p], perm_pos: p }
        }
        _ => PreviousStep {
            index: if inp.current == 0 { inp.len - 1 } else { inp.current - 1 },
            perm_pos: inp.perm_pos,
        },
    }
}

/// 上一首：默认总是切上一首（首位时折返末尾）；
/// 开启设置项 previousRestart 后，播放超过 3 秒则回到本曲开头
fn go_previous(ctx: &mut EngineCtx, app: &tauri::AppHandle) {
    let len = ctx.queue.len();
    if len == 0 {
        return;
    }
    // 随机模式要先有洗牌序列才能回退。SetQueue / SetPlayMode 都会重建 perm，
    // 所以这里实际不可达；提前到决策之前只是为了保持 previous_step 是纯函数
    // （代价：极端的「序列为空 + 开启重播」组合会多做一次重新洗牌，无副作用）。
    if ctx.play_mode == PlayMode::Shuffle && ctx.perm.is_empty() {
        rebuild_perm(ctx);
    }
    let step = previous_step(PreviousInput {
        len,
        current: ctx.idx.unwrap_or(0),
        pos_secs: ctx.core.player_pos_secs() + ctx.seek_offset,
        restart_on_previous: ctx.restart_on_previous,
        play_mode: ctx.play_mode,
        perm: &ctx.perm,
        perm_pos: ctx.perm_pos,
    });
    ctx.perm_pos = step.perm_pos;

    let was_playing = ctx.status == PlayerStatus::Playing;
    ctx.status = PlayerStatus::Paused;
    load_and_play(ctx, step.index, app);
    if !was_playing {
        pause_inner(ctx);
    }
}

// ---------------------------------------------------------------------------
// 快照与事件
// ---------------------------------------------------------------------------

/// 当前曲目的播放位置（秒）：Player 时间轴 − 本曲基准 + 重解码偏移。
/// 抽出来是为了让每 tick 都要跑一次的地方（gapless 预排判断）**不产生任何克隆**。
fn position_secs(ctx: &EngineCtx) -> f64 {
    (ctx.core.player_pos_secs() - ctx.pos_base + ctx.seek_offset).max(0.0)
}

fn current_item(ctx: &EngineCtx) -> Option<(QueueItem, NowPlaying)> {
    let i = ctx.idx?;
    let item = ctx.queue.get(i).cloned()?;
    let pos = {
        let p = position_secs(ctx);
        if item.duration_secs > 0.0 && p > item.duration_secs {
            item.duration_secs
        } else {
            p
        }
    };
    let qitem = QueueItem {
        track_id: item.track_id,
        title: item.title.clone(),
        artist: item.artist.clone(),
        album: item.album.clone(),
        duration_secs: item.duration_secs,
    };
    let np = NowPlaying {
        track_id: item.track_id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        duration_secs: item.duration_secs,
        cover_key: None,
        position_secs: pos,
    };
    Some((qitem, np))
}

fn sync_shared(ctx: &EngineCtx, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
    let np: Option<NowPlaying> = if ctx.status == PlayerStatus::Stopped {
        None
    } else {
        current_item(ctx).map(|(_, n)| n)
    };
    let queue_index = if ctx.status == PlayerStatus::Stopped { None } else { ctx.idx };
    let state = PlayerState {
        status: ctx.status,
        play_mode: ctx.play_mode,
        volume: ctx.volume,
        // 两处都是 Arc::clone（引用计数 +1），与队列长度无关 —— 见 EngineCtx::items 的注释
        queue: ctx.items.clone(),
        queue_index,
        current: np,
        order: ctx.order.clone(),
    };
    if let Ok(mut g) = shared.lock() {
        *g = state;
    }
    emit_state_event(ctx, app);
}

/// 实际播放顺序的曲目 id：随机模式用洗牌序列，其余用队列顺序
fn playback_order(ctx: &EngineCtx) -> Vec<i64> {
    if ctx.play_mode == PlayMode::Shuffle && ctx.perm.len() == ctx.queue.len() && !ctx.perm.is_empty() {
        ctx.perm
            .iter()
            .filter_map(|&i| ctx.queue.get(i).map(|q| q.track_id))
            .collect()
    } else {
        ctx.queue.iter().map(|q| q.track_id).collect()
    }
}

fn to_queue_item(q: &QueueTrack) -> QueueItem {
    QueueItem {
        track_id: q.track_id,
        title: q.title.clone(),
        artist: q.artist.clone(),
        album: q.album.clone(),
        duration_secs: q.duration_secs,
    }
}

fn emit_state_event(ctx: &EngineCtx, app: &tauri::AppHandle) {
    // 事件里的位置必须取真实播放位置：之前写死 0.0，导致每次状态事件
    // （暂停/继续/跳转/音量等）都把界面进度打回开头，歌词也会闪回第一行。
    let current = if ctx.status == PlayerStatus::Stopped {
        None
    } else {
        current_item(ctx).map(|(_, n)| n)
    };
    let payload = PlayerStateEvent {
        status: ctx.status,
        play_mode: ctx.play_mode,
        volume: ctx.volume,
        queue_index: if ctx.status == PlayerStatus::Stopped { None } else { ctx.idx },
        queue_len: ctx.queue.len(),
        current: current.clone(),
    };
    let _ = app.emit("player-state", payload);

    // 系统媒体控制：播放状态与元数据跟着走。
    // 曲目没变时也会发一次 set_track，但 SMTC 线程按 track_id 去重，不会重复解析封面。
    if let Some(handle) = ctx.smtc.get() {
        handle.set_status(ctx.status);
        match current {
            Some(np) => handle.set_track(np.track_id, &np.title, &np.artist, &np.album),
            None => handle.clear(),
        }
    }
}

fn emit_progress(ctx: &EngineCtx, app: &tauri::AppHandle) {
    let Some((_, np)) = current_item(ctx) else { return };
    let (position_secs, duration_secs) = (np.position_secs, np.duration_secs);
    let _ = app.emit(
        "player-progress",
        ProgressPayload { track_id: np.track_id, position_secs, duration_secs },
    );
    // 系统媒体面板上的进度条（Windows 自行插值，800ms 一次足够）
    if let Some(handle) = ctx.smtc.get() {
        handle.set_progress(position_secs, duration_secs);
    }
}

fn emit_error(app: &tauri::AppHandle, code: &str, message: &str, track_id: Option<i64>) {
    let _ = app.emit(
        "player-error",
        PlayerErrorPayload { code: code.to_string(), message: message.to_string(), track_id },
    );
}

/// 洗牌序列（xorshift，种子取自系统时间；当前曲目固定为首位）
fn rebuild_perm(ctx: &mut EngineCtx) {
    let len = ctx.queue.len();
    if ctx.play_mode != PlayMode::Shuffle || len == 0 {
        ctx.perm = (0..len).collect();
        ctx.perm_pos = ctx.idx.unwrap_or(0).min(len.saturating_sub(1));
    } else {
        let mut seed: u64 = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15);
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut shuffled: Vec<usize> = (0..len).collect();
        for i in (1..len).rev() {
            let j = (rnd() % (i as u64 + 1)) as usize;
            shuffled.swap(i, j);
        }
        if let Some(cur) = ctx.idx {
            if let Some(p) = shuffled.iter().position(|&x| x == cur) {
                shuffled.swap(0, p);
            }
        }
        ctx.perm = shuffled;
        ctx.perm_pos = 0;
    }
    // perm 变了，播放顺序的 Arc 缓存跟着刷新（PlayerState.order）。
    // 这里是唯一的刷新点：perm 只会被本函数改写。
    ctx.order = Arc::new(playback_order(ctx));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用最小上下文。CoreAudio::default() 是惰性的（不打开音频设备）。
    /// EngineCtx 的字面量收口在这里 —— 以后加字段只改这一处
    /// （之前就是因为字面量散在测试里，漏了 beat 字段导致整个模块编译不过）。
    fn test_ctx(len: usize, idx: Option<usize>, mode: PlayMode) -> EngineCtx {
        EngineCtx {
            core: CoreAudio::default(),
            queue: (0..len)
                .map(|i| QueueTrack {
                    track_id: i as i64,
                    path: String::new(),
                    title: String::new(),
                    artist: String::new(),
                    album: String::new(),
                    duration_secs: 0.0,
                })
                .collect(),
            items: Arc::new(vec![]),
            order: Arc::new(vec![]),
            idx,
            perm: vec![],
            perm_pos: 0,
            status: PlayerStatus::Stopped,
            play_mode: mode,
            volume: 80,
            restart_on_previous: false,
            seek_offset: 0.0,
            loaded: None,
            suppress_end: false,
            pending: None,
            pos_base: 0.0,
            smtc: Arc::new(OnceLock::new()),
            last_pos: 0.0,
            stalled_ticks: 0,
            device_lost: false,
            device_retry: 0,
            resume_at: 0.0,
            recover_logged: false,
            wait_ticks: 0,
            beat: beat::BeatMeter::new(),
        }
    }

    /// 「上一首」决策输入（perm 留空 = 非随机模式或序列未就绪）
    fn prev_in(len: usize, current: usize, pos: f64, restart: bool, mode: PlayMode) -> PreviousInput<'static> {
        PreviousInput {
            len,
            current,
            pos_secs: pos,
            restart_on_previous: restart,
            play_mode: mode,
            perm: &[],
            perm_pos: 0,
        }
    }

    #[test]
    fn perm_contains_all_and_keeps_current_first() {
        let mut ctx = test_ctx(10, Some(4), PlayMode::Shuffle);
        rebuild_perm(&mut ctx);
        assert_eq!(ctx.perm.len(), 10);
        assert_eq!(ctx.perm[0], 4);
        let mut sorted = ctx.perm.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..10).collect::<Vec<_>>());
    }

    /// `PlayerState.order` 现在取自 `ctx.order` 这个 Arc 缓存，而它只在 `rebuild_perm`
    /// 里刷新 —— 这条测试守住「缓存与 perm 同步」这个不变量，否则首页卡片排序会静默出错。
    #[test]
    fn rebuild_perm_refreshes_order_cache() {
        // 顺序模式：order = 队列顺序
        let mut seq = test_ctx(5, Some(2), PlayMode::LoopAll);
        rebuild_perm(&mut seq);
        assert_eq!(*seq.order, vec![0, 1, 2, 3, 4]);

        // 随机模式：order 是洗牌序列（含全部曲目）、当前曲目固定排首位
        let mut sh = test_ctx(5, Some(2), PlayMode::Shuffle);
        rebuild_perm(&mut sh);
        assert_eq!(sh.order.len(), 5);
        assert_eq!(sh.order[0], 2, "当前曲目应固定为洗牌序列首位");
        let mut sorted = sh.order.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4]);
        // 与按需计算的结果逐位一致
        assert_eq!(*sh.order, playback_order(&sh));
    }

    /// 新默认（设置项关闭）：位置无关，一律切上一首；首位折返末尾
    #[test]
    fn previous_default_always_switches_track() {
        for &pos in &[0.0, 2.9, 3.1, 120.0] {
            for mode in [PlayMode::LoopAll, PlayMode::LoopOne, PlayMode::Sequential] {
                assert_eq!(previous_step(prev_in(5, 3, pos, false, mode)).index, 2);
                assert_eq!(previous_step(prev_in(5, 0, pos, false, mode)).index, 4, "首位应折返到末尾");
            }
        }
    }

    /// 开启设置后逐位还原历史行为：严格大于 3.0 才回到本曲（恰好 3.0 不触发）
    #[test]
    fn previous_restart_rule_only_when_enabled() {
        for mode in [PlayMode::LoopAll, PlayMode::LoopOne, PlayMode::Sequential] {
            assert_eq!(previous_step(prev_in(5, 3, 2.9, true, mode)).index, 2, "{}", mode.as_str());
            assert_eq!(previous_step(prev_in(5, 3, 3.0, true, mode)).index, 2, "{} 恰好 3.0 不触发", mode.as_str());
            assert_eq!(previous_step(prev_in(5, 3, 3.1, true, mode)).index, 3, "{}", mode.as_str());
        }
    }

    /// 随机模式：回退洗牌位置并在 0 处环形折返；回到本曲时不写 perm_pos
    #[test]
    fn previous_shuffle_rewinds_perm_and_wraps() {
        let perm: &[usize] = &[4, 1, 0, 3, 2];
        let base = PreviousInput {
            len: 5,
            current: 0,
            pos_secs: 99.0,
            restart_on_previous: false,
            play_mode: PlayMode::Shuffle,
            perm,
            perm_pos: 2,
        };
        let s = previous_step(base);
        assert_eq!((s.index, s.perm_pos), (1, 1), "位置再大也不重播（默认关）；perm_pos 回退一格");
        let w = previous_step(PreviousInput { perm_pos: 0, ..base });
        assert_eq!((w.index, w.perm_pos), (2, 4), "perm_pos 0 应环形折返到序列末尾");
        let r = previous_step(PreviousInput { restart_on_previous: true, pos_secs: 3.1, ..base });
        assert_eq!((r.index, r.perm_pos), (0, 2), "回到本曲且不改 perm_pos");
    }

    #[test]
    fn prefetch_target_follows_mode() {
        // 顺序模式：到末尾就不再预排（自然结束后停止）
        let mut ctx = test_ctx(3, Some(2), PlayMode::Sequential);
        assert_eq!(prefetch_target(&mut ctx), None);
        // 列表循环：末尾接回第一首
        let mut ctx = test_ctx(3, Some(2), PlayMode::LoopAll);
        assert_eq!(prefetch_target(&mut ctx), Some(0));
        // 单曲循环：预排"自己"，实现无缝循环
        let mut ctx = test_ctx(3, Some(1), PlayMode::LoopOne);
        assert_eq!(prefetch_target(&mut ctx), Some(1));
        // 随机：预排置换表里的下一项（用调用前的状态算期望值，因为调用会推进 perm_pos）
        let mut ctx = test_ctx(4, Some(0), PlayMode::Shuffle);
        rebuild_perm(&mut ctx);
        let perm = ctx.perm.clone();
        let pp = ctx.perm_pos;
        let expect = if pp + 1 >= perm.len() { perm[0] } else { perm[pp + 1] };
        assert_eq!(prefetch_target(&mut ctx), Some(expect));
    }

    #[test]
    fn engine_advance_math() {
        let len = 3usize;
        let manual_next = |cur: usize, natural_end: bool| -> Option<usize> {
            if cur + 1 >= len {
                if natural_end { None } else { Some(0) }
            } else {
                Some(cur + 1)
            }
        };
        assert_eq!(manual_next(2, false), Some(0)); // 手动 Next 折返
        assert_eq!(manual_next(2, true), None);     // 自然结束停止
        assert_eq!(manual_next(0, true), Some(1));
        assert_eq!((2 + 1) % len, 0);
    }

    /// 恢复目标的选择直接决定「插回耳机有没有声音」，所以单独守住：
    /// 关键不变量是**原设备回来了就必须开原设备**，而不是退回系统默认设备 ——
    /// 拔掉耳机后默认会被切到显示器 HDMI 音频那类常驻 ACTIVE 的端点，
    /// 一旦退回默认就是「在播放、进度在走、耳机没声」。
    #[test]
    fn recovery_prefers_the_original_endpoint() {
        // 目标设备回到 ACTIVE：无论等了多久，都必须开它
        assert_eq!(
            choose_recover_target(Some(("hp", Some(true))), 10_000, true),
            RecoverTarget::Original("hp".to_string())
        );
        // 还没回来（UNPLUGGED/NOTPRESENT）且仍在宽限期内：继续等
        assert_eq!(
            choose_recover_target(Some(("hp", Some(false))), 5, true),
            RecoverTarget::KeepWaiting
        );
        assert_eq!(choose_recover_target(Some(("hp", None)), 5, true), RecoverTarget::KeepWaiting);
        // 刚好到宽限期：改为跟随系统默认
        assert_eq!(
            choose_recover_target(Some(("hp", Some(false))), DEVICE_WAIT_GRACE_TICKS, true),
            RecoverTarget::FollowDefault
        );
        assert_eq!(
            choose_recover_target(Some(("hp", None)), DEVICE_WAIT_GRACE_TICKS, true),
            RecoverTarget::FollowDefault
        );
        // 没有记录到目标设备（例如首次打开就失败）：跟随默认
        assert_eq!(
            choose_recover_target(None, DEVICE_WAIT_GRACE_TICKS, true),
            RecoverTarget::FollowDefault
        );
        assert_eq!(choose_recover_target(None, 0, true), RecoverTarget::KeepWaiting);
        // ★ 用户在设置里指定了输出设备（allow_fallback=false）：等多久都不改用系统默认设备
        assert_eq!(
            choose_recover_target(Some(("hp", Some(false))), 1_000_000, false),
            RecoverTarget::KeepWaiting
        );
        assert_eq!(choose_recover_target(None, 1_000_000, false), RecoverTarget::KeepWaiting);
    }

    /// enter_device_wait 把「等待设备」所需的即时状态一次性摆正。
    /// ⚠️ 恢复位置是**无条件**写入的：调用方给什么就是什么（换歌 / 换队列时传 0.0）。
    /// 「重试失败不能丢掉位置」这条不变量由 try_recover_device 显式写回 —— 上一版把它藏在
    /// 这里的条件分支里，直接导致 device_lost 永远清不掉、恢复循环变成每秒重播。
    #[test]
    fn device_wait_records_position_and_clears_transient_state() {
        let mut ctx = test_ctx(3, Some(1), PlayMode::LoopAll);
        ctx.loaded = Some(ctx.queue[1].clone());
        ctx.pending = Some(Pending { idx: 2, pos_at_prefetch: 99.0, last_pos: 99.0 });
        ctx.pos_base = 5.0;

        enter_device_wait(&mut ctx, 42.5);
        assert!(ctx.device_lost, "应进入等待设备状态");
        assert_eq!(ctx.resume_at, 42.5, "应记住恢复位置");
        assert_eq!(ctx.device_retry, 0);
        assert!(ctx.pending.is_none(), "预排要作废");
        assert_eq!(ctx.pos_base, 0.0, "位置基准要归零");

        // 换歌 / 换队列时用得上：无条件覆盖
        enter_device_wait(&mut ctx, 0.0);
        assert_eq!(ctx.resume_at, 0.0);
    }
}