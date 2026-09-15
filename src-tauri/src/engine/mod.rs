//! 播放引擎：独立线程 + 命令通道 + 状态快照 + 事件推送
//!
//! 线程模型
//! - 引擎线程持有音频设备（MixerDeviceSink）与播放句柄（rodio::Player）
//! - 命令层经 mpsc 通道发送 EngineCommand
//! - 状态快照 Arc<Mutex<PlayerState>> 供 player_state 命令读取
//! - 事件：player-state（状态跳变）/ player-progress（节流）/ player-error

pub mod audio;
pub mod beat;

use crate::error::{AppError, AppResult};
use crate::models::*;
use audio::{open_decoder, seek_decoder, CoreAudio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
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

#[derive(Clone)]
pub struct EngineHandle {
    tx: Sender<EngineCommand>,
    shared: Arc<Mutex<PlayerState>>,
    /// 节拍检测（前端 ~30Hz 取值驱动背景律动）
    beat: Arc<beat::BeatMeter>,
    #[allow(dead_code)]
    alive: Arc<AtomicBool>,
}

impl EngineHandle {
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
    let shared2 = shared.clone();
    let alive2 = alive.clone();
    let meter2 = meter.clone();
    std::thread::Builder::new()
        .name("audio-engine".into())
        .spawn(move || run_engine(app, rx, shared2, alive2, meter2))
        .expect("引擎线程创建失败");

    EngineHandle { tx, shared, beat: meter, alive }
}

// ---------------------------------------------------------------------------
// 引擎线程
// ---------------------------------------------------------------------------

/// gapless 预排的在途状态
struct Pending {
    /// 下一首在队列里的下标
    idx: usize,
    /// 预排发生时的**本曲**位置（秒）。之后位置明显小于它 ⇒ 已经换源了。
    pos_at_prefetch: f64,
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
}

fn run_engine(
    app: tauri::AppHandle,
    rx: Receiver<EngineCommand>,
    shared: Arc<Mutex<PlayerState>>,
    alive: Arc<AtomicBool>,
    meter: Arc<beat::BeatMeter>,
) {
    let mut ctx = EngineCtx {
        core: CoreAudio::default(),
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
        if ctx.status == PlayerStatus::Playing {
            // 每 tick 检查一次"该不该预排下一首"（不满足条件会立刻返回，成本可忽略）
            prefetch_next(&mut ctx, &app);
            // gapless：位置回退 ⇒ 预排的那首已经接着播了（只切逻辑状态，绝不碰音频）
            let switched = match ctx.pending.as_ref() {
                Some(p) if position_secs(&ctx) + 0.5 < p.pos_at_prefetch => {
                    let idx = p.idx;
                    ctx.pending = None;
                    switch_to_prefetched(&mut ctx, idx, &app, &shared);
                    true
                }
                _ => false,
            };
            // 没有预排时的自然结束：仍用原来的 empty() 判定（最后一首 / 预排失败 / 顺序到末尾）
            let ended = !switched
                && ctx.pending.is_none()
                && !ctx.suppress_end
                && ctx.core.sink_is_some()
                && ctx.core.player_empty();
            if ended {
                on_natural_end(&mut ctx, &app, &shared);
            } else if !switched && tick % 16 == 0 {
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

    ctx.core.clear_player();
    alive.store(false, Ordering::Relaxed);
}

fn handle_command(ctx: &mut EngineCtx, cmd: EngineCommand, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
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

/// 加载并播放队列第 i 首；失败时进入 Paused 并发 player-error 事件
fn load_and_play(ctx: &mut EngineCtx, i: usize, app: &tauri::AppHandle) {
    if i >= ctx.queue.len() {
        ctx.status = PlayerStatus::Stopped;
        ctx.idx = None;
        ctx.loaded = None;
        ctx.core.clear_player();
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

    if ctx.core.new_player().is_err() {
        ctx.status = PlayerStatus::Paused;
        emit_error(app, "AUDIO_DEVICE", "无法打开音频输出设备（WASAPI）", Some(item.track_id));
        return;
    }
    let opened = open_decoder(&item.path);
    match opened {
        Ok(decoder) => {
            let duration = audio::decoder_duration(&decoder).map(|d| d.as_secs_f64());
            if let Some(d) = duration {
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
        }
        Err(e) => {
            ctx.status = PlayerStatus::Paused;
            ctx.loaded = None;
            ctx.suppress_end = false;
            emit_error(app, &e.code, &e.message, Some(item.track_id));
        }
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
    if ctx.core.new_player().is_err() {
        ctx.status = PlayerStatus::Paused;
        emit_error(app, "AUDIO_DEVICE", "无法打开音频输出设备（WASAPI）", Some(item.track_id));
        return;
    }
    match open_decoder(&item.path) {
        Ok(decoder) => {
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
        Err(err) => {
            ctx.status = PlayerStatus::Paused;
            ctx.loaded = None;
            emit_error(app, &err.code, &err.message, Some(item.track_id));
        }
    }
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
    ctx.pending = Some(Pending { idx: n, pos_at_prefetch: at });
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

/// 跳转：按设计文档 §4.3 “通过重解码实现”
fn seek_to(ctx: &mut EngineCtx, pos_secs: f64, app: &tauri::AppHandle) {
    // 预排的那首仍在队列里，只是"位置回退"的判定基准要跟着新的位置走
    if let Some(p) = ctx.pending.as_mut() {
        p.pos_at_prefetch = pos_secs.max(0.0);
    }
    let Some(item) = ctx.loaded.clone() else { return };
    let was_paused = ctx.status == PlayerStatus::Paused;

    let dur = ctx.queue.get(ctx.idx.unwrap_or(0)).map(|q| q.duration_secs).unwrap_or(0.0);
    let target = if dur > 0.0 { pos_secs.min(dur) } else { pos_secs };
    ctx.seek_offset = target;

    // 首选：原地 seek（symphonia 格式级定位，毫秒级、不打断播放）。
    // 之前是"清空播放器 + 重解码 + 逐样本排水"，拖到几十秒后要几秒才到位，
    // 前端进度条与歌词都要等它，表现为"歌词定位非常慢"。
    if ctx.core.player_seek(Duration::from_secs_f64(target)) {
        // 原地 seek 后播放器位置就是目标位置，seek_offset 必须归零，
        // 否则 current_item 会把位置算成「新位置 + 目标」= 两倍（实测跳到 29.3s 的句子显示 59.6s）
        ctx.seek_offset = 0.0;
        ctx.suppress_end = false;
        return;
    }

    // 回退：重解码（此时 seek_decoder 也会先尝试解码器原地定位）
    ctx.suppress_end = true;
    ctx.core.clear_player();
    match open_decoder(&item.path) {
        Ok(mut decoder) => {
            let actual = seek_decoder(&mut decoder, Duration::from_secs_f64(target));
            ctx.seek_offset = actual;
            if ctx.core.new_player().is_ok() {
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
            ctx.status = PlayerStatus::Paused;
            ctx.suppress_end = false;
            emit_error(app, &e.code, &e.message, Some(item.track_id));
        }
    }
}

/// 自然结束（单曲循环 / 自动下一首 / 队列末尾停止）
fn on_natural_end(ctx: &mut EngineCtx, app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerState>>) {
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
        current,
    };
    let _ = app.emit("player-state", payload);
}

fn emit_progress(ctx: &EngineCtx, app: &tauri::AppHandle) {
    let Some((_, np)) = current_item(ctx) else { return };
    let _ = app.emit(
        "player-progress",
        ProgressPayload { track_id: np.track_id, position_secs: np.position_secs, duration_secs: np.duration_secs },
    );
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
}