//! 音频解码与底层播放辅助（rodio 0.22：symphonia 解码 + cpal 输出）
//!
//! - 解码：rodio 内置 symphonia 后端（mp3/flac/wav/ogg/m4a(aac/alac)/aiff/caf 等）
//! - 输出：两种后端 —— 共享（DeviceSinkBuilder/cpal）与 **WASAPI 独占**（engine/exclusive.rs）。
//!   走哪条由 OutputMode（设置项 outputMode）决定：Auto/Exclusive 先协商独占，
//!   协商不到就回退共享并把原因交给 UI（见 engine/backend.rs 的 Fallback）。
//! - 跳转：按设计文档 §4.3 “通过重解码实现”——重新打开文件并跳过样本到目标位置

use crate::engine::backend::{self, Fallback, OutputMode};
use crate::engine::beat::{BeatMeter, BeatTap};
use crate::engine::downmix;
use crate::engine::exclusive::ExclusiveSink;
use crate::engine::resample::ResamplerSource;
use crate::error::{AppError, E_AUDIO_DEVICE, E_DECODE};
use rodio::mixer::Mixer;
use rodio::source::{SeekError, Source};
use rodio::{ChannelCount, Decoder, MixerDeviceSink, Player, SampleRate};
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};
use std::num::NonZero;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 实际生效的输出后端（设置页显示用）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Shared,
    Exclusive,
}

impl Default for Backend {
    fn default() -> Self {
        Backend::Shared
    }
}

/// 输出状态快照（audio_output_status 命令返回给设置页）。
///
/// 为什么需要它：后端选谁、用什么格式、为什么回退，全部发生在**引擎线程**里，
/// 命令层拿不到 CoreAudio。所以引擎把结论写进这个共享槽，命令层只读。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputStatus {
    /// 引擎是否已经真正打开过一次输出。
    /// 用来区分「当前就是共享」与「还没播过、后端未定」—— 后者显示共享会误导用户。
    pub opened: bool,
    pub backend: Backend,
    /// 独占时实际生效的「采样率/有效位/容器位」，如 "44100/24/32"；共享时为 None
    pub format: Option<String>,
    /// 回退共享的原因（中文，来自 Fallback::hint）；非回退时为 None
    pub fallback: Option<String>,
    /// 输出（mixer / 设备）的采样率，Hz；未打开时为 None
    pub output_rate: Option<u32>,
    /// 最近一次交给输出的音源的解码采样率，Hz；什么都没装时为 None
    pub source_rate: Option<u32>,
    /// 上面两者不一致时说明走了多相 sinc 重采样（设置页据此显示，不用翻控制台）
    pub resampling: bool,
}

/// 输出设备 + 播放句柄的持有者（Player/Drop 语义：句柄释放即停止）
pub struct CoreAudio {
    /// 共享模式的设备句柄必须存活于整个播放过程（独占模式为 None）
    sink: Option<MixerDeviceSink>,
    /// 独占输出的渲染线程句柄（None = 当前没走独占）
    exclusive: Option<ExclusiveSink>,
    /// 独占路径下**自建**的 mixer：Player 接到它，渲染线程从它的 MixerSource 拉样本。
    /// 与 ExclusiveSink 内部持有的 MixerSource 共享同一个 channel。
    exclusive_mixer: Option<Mixer>,
    /// 建立上面这条独占链路时用的**曲目采样率**。
    /// 用来判断「换曲之后要不要重开设备」：采样率不同就得重开（P0 不做逐曲切率的无缝）。
    exclusive_track_rate: Option<u32>,
    /// 这台设备这次已经试过独占且失败了 —— 在 reset_device / 换模式 / 换设备之前不再重试。
    /// 不这样记的话，每首歌都要先失败一次再回退，白白多花几十毫秒、还可能产生爆音。
    exclusive_denied: bool,
    /// 当前单曲的播放控制句柄
    pub player: Option<Player>,
    /// 当前生效音量 0.0..=1.0
    volume: f32,
    /// 输出流出错（设备被拔掉/被占用）时由 rodio 的错误回调置位，引擎每 tick 取用一次。
    /// 回调可能来自音频线程，所以用原子量传递。
    device_error: Arc<AtomicBool>,
    /// 我们**最后一次打开**的那个输出端点的稳定 id（WASAPI 端点 id）。
    /// reset_device() 不会清掉它 —— 恢复流程要靠它认出「原来那台设备回来了没有」。
    endpoint_id: Option<String>,
    /// 同一个端点的显示名（仅日志用）
    endpoint_name: Option<String>,
    /// 用户选定的输出设备（设置项 outputDevice）。None = 跟随系统默认设备。
    preferred: Option<String>,
    /// 输出模式（设置项 outputMode）
    mode: OutputMode,
    /// 回退共享的中文原因（给设置页显示）
    last_fallback: Option<String>,
    /// 本次要播的曲目采样率。恢复流程（try_recover_device 先 ensure_with 再 load_and_play）
    /// 也要用它协商独占，否则会按设备默认率开一次、紧接着又因采样率不同重开。
    current_track_rate: Option<u32>,
    /// 共享给命令层的输出状态（engine 线程写、命令层读）
    status: Arc<Mutex<OutputStatus>>,
}

impl Default for CoreAudio {
    fn default() -> Self {
        Self::new(Arc::new(Mutex::new(OutputStatus::default())))
    }
}

impl CoreAudio {
    /// 用外部的状态槽构造（引擎线程用这个，命令层才能读到输出状态）
    pub fn new(status: Arc<Mutex<OutputStatus>>) -> Self {
        Self {
            sink: None,
            exclusive: None,
            exclusive_mixer: None,
            exclusive_track_rate: None,
            exclusive_denied: false,
            player: None,
            volume: 1.0,
            device_error: Arc::new(AtomicBool::new(false)),
            endpoint_id: None,
            endpoint_name: None,
            preferred: None,
            // 默认输出模式 = 共享（设置项 outputMode 缺键时也是它，见 state.rs）
            mode: OutputMode::Shared,
            last_fallback: None,
            current_track_rate: None,
            status,
        }
    }
}

impl CoreAudio {
    /// 设置输出模式（设置项 outputMode）。返回是否真的变了。
    /// ⚠️ 模式改了要重开输出（调用方 remigrate），因为当前后端已经被固定下来了。
    pub fn set_mode(&mut self, mode: OutputMode) -> bool {
        if self.mode == mode {
            return false;
        }
        self.mode = mode;
        // 换了模式就该重新给独占一次机会（用户改回 Exclusive 时尤其如此）
        self.exclusive_denied = false;
        true
    }

    /// 丢掉「上次回退共享」的结论，并把状态打回「尚未打开」。
    /// 用户点「重新尝试独占」时调用；下一次打开输出会写真实结果。
    pub fn forget_fallback(&mut self) {
        self.last_fallback = None;
        self.exclusive_denied = false;
        if let Ok(mut g) = self.status.lock() {
            g.opened = false;
            g.format = None;
            g.fallback = None;
            g.output_rate = None;
            g.source_rate = None;
            g.resampling = false;
        }
    }

    /// 输出状态快照（设置页显示当前后端 / 格式 / 回退原因）。
    /// 命令层走 EngineHandle::output_status（同一个槽）；这里留给测试与引擎内部排查用。
    #[allow(dead_code)]
    pub fn output_status(&self) -> OutputStatus {
        self.status.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// 设置偏好的输出设备（None = 跟随系统默认）。返回是否真的发生了变化。
    pub fn set_preferred(&mut self, id: Option<String>) -> bool {
        if self.preferred == id {
            return false;
        }
        self.preferred = id;
        // 换了设备：独占要重新协商
        self.exclusive_denied = false;
        true
    }

    /// 当前偏好的输出设备 id（None = 跟随系统默认）
    pub fn preferred_device_id(&self) -> Option<&str> {
        self.preferred.as_deref()
    }

    /// 确保输出已打开。`prefer_id` 给出时**必须**开那台设备（找不到就直接失败，绝不悄悄退回默认
    /// 设备）—— 这正是「拔掉耳机后声音跑到显示器 HDMI 音频上」那个 bug 的关键：
    /// 恢复时若放它去开「系统默认」，系统早就把默认切到那类常驻 ACTIVE 的端点上了。
    ///
    /// ⚠️ 这里刻意**不用** rodio 的 open_default_sink()：它装的是默认错误回调，设备被拔掉时
    /// 只往 stderr 打一行就完了，引擎侧完全感知不到设备已经没了。
    /// 共享路径用我们自己的错误回调，把「输出流死了」变成引擎能轮询的标志位。
    ///
    /// 独占模式由 open_output 决策；采样率取 current_track_rate（恢复流程与 new_player 保持一致）。
    pub fn ensure_with(&mut self, prefer_id: Option<&str>) -> Result<(), AppError> {
        let rate = self.current_track_rate;
        self.open_output(prefer_id, rate)
    }

    /// 打开输出的唯一入口：共享 / 独占的决策、协商、回退都在这里。
    fn open_output(&mut self, prefer_id: Option<&str>, track_rate: Option<u32>) -> Result<(), AppError> {
        // 共享输出已经开着：直接复用（对应历史行为：设备只开一次）
        if self.sink.is_some() {
            return Ok(());
        }
        if self.mode.allows_exclusive() && !self.exclusive_denied {
            // 独占链路还活着、且这次曲目的采样率与建立它时相同 ⇒ 复用它。
            // 同采样率的连续曲目复用，曲间就没有重开设备的停顿（gapless 的关键）。
            let reusable = self
                .exclusive
                .as_ref()
                .map(|s| s.is_alive() && self.exclusive_track_rate == track_rate)
                .unwrap_or(false);
            if reusable {
                return Ok(());
            }
            self.drop_exclusive();
            match self.try_open_exclusive(prefer_id, track_rate) {
                Ok(()) => return Ok(()),
                Err((fb, msg)) => {
                    // 记下原因并**回退共享**：独占失败不能让用户没声音
                    self.exclusive_denied = true;
                    self.last_fallback = Some(fb.hint().to_string());
                    eprintln!("[engine] 独占输出不可用（{fb:?}）：{msg}；回退共享模式");
                }
            }
        }
        self.open_shared(prefer_id)
    }

    /// 共享模式（cpal/WASAPI shared）—— 与历史版本逐位一致的路径
    fn open_shared(&mut self, prefer_id: Option<&str>) -> Result<(), AppError> {
        let flag = self.device_error.clone();
        let (builder, id, name) = match prefer_id {
            Some(want) => {
                let Some(dev) = find_output_device_by_id(want) else {
                    return Err(AppError::new(
                        E_AUDIO_DEVICE,
                        format!("指定的输出设备当前不可用（id={want}）"),
                    ));
                };
                let name = device_name(&dev);
                let b = rodio::DeviceSinkBuilder::from_device(dev)
                    .map_err(|e| AppError::new(E_AUDIO_DEVICE, format!("打开指定输出设备失败：{e}")))?;
                (b, Some(want.to_string()), name)
            }
            None => {
                let info = default_output_info();
                let b = rodio::DeviceSinkBuilder::from_default_device()
                    .map_err(|e| AppError::new(E_AUDIO_DEVICE, format!("找不到音频输出设备：{e}")))?;
                let (id, name) = match info {
                    Some((i, n)) => (Some(i), n),
                    None => (None, "(默认设备)".to_string()),
                };
                (b, id, name)
            }
        };
        let builder = builder.with_error_callback(move |err| {
            eprintln!("[engine] 输出流错误（设备可能已被拔出/占用）：{err}");
            flag.store(true, Ordering::SeqCst);
        });
        // open_sink_or_fallback：默认配置打不开时再试该设备支持的其他配置
        match builder.open_sink_or_fallback() {
            Ok(mut sink) => {
                // 设备失效时我们会主动丢弃 sink，这行噪音日志就不必了
                sink.log_on_drop(false);
                self.sink = Some(sink);
                self.endpoint_id = id;
                self.endpoint_name = Some(name.clone());
                self.publish(Backend::Shared, None);
                eprintln!("[engine] 已打开输出设备（共享模式）：{name}");
                Ok(())
            }
            Err(e) => Err(AppError::new(E_AUDIO_DEVICE, format!("无法打开音频输出设备（WASAPI）：{e}"))),
        }
    }

    /// 协商并打开 WASAPI 独占输出。
    ///
    /// 候选顺序：曲目采样率 → 设备共享默认率 → 48000 → 44100；
    /// 每个采样率下再按 FMT_PREF 偏好（24/32 → 24/24 → 32/32 → 32f → 16/16）逐个试。
    /// 采样率必须先定下来再去建 mixer —— mixer 的率与设备率不一致就是**变速播放**
    /// （见 3.2.8 与 current_span_len 那个 bug）。
    fn try_open_exclusive(
        &mut self,
        prefer_id: Option<&str>,
        track_rate: Option<u32>,
    ) -> Result<(), (Fallback, String)> {
        // 设备：与共享路径同一套 id 语义（cpal 的 id 在 Windows 上就是 WASAPI 端点 id）
        let (device_id, name) = match prefer_id {
            Some(want) => {
                let Some(dev) = find_output_device_by_id(want) else {
                    return Err((
                        Fallback::DeviceInvalidated,
                        format!("指定的输出设备当前不可用（id={want}）"),
                    ));
                };
                (Some(want.to_string()), device_name(&dev))
            }
            None => match default_output_info() {
                Some((i, n)) => (Some(i), n),
                None => (None, "(默认设备)".to_string()),
            },
        };
        // 声道数跟随设备共享默认格式：独占不做声道转换（这是 bit-perfect 的前提）
        let channels = shared_default_channels(device_id.as_deref()).unwrap_or(2).max(1) as usize;
        let rates = exclusive_rate_candidates(
            track_rate,
            shared_default_rate(device_id.as_deref()),
        );

        let mut errors: Vec<(Fallback, String)> = Vec::new();
        for rate in rates {
            // 便宜预检：驱动声明逐位支持的格式（按偏好序）。每次都是新的 IAudioClient。
            let mut fmts = backend::supported_formats(device_id.as_deref(), rate as usize, channels);
            if fmts.is_empty() {
                // 一个都不声明时仍试一次首选格式：is_supported 有假阴性，
                // 而 Initialize 才是真正的判据（探针阶段就遇到过这种设备）
                fmts.push(backend::FMT_PREF[0]);
            }
            for fmt in fmts {
                let (mixer, source) = rodio::mixer::mixer(nz_channels(channels), nz_rate(rate));
                match ExclusiveSink::start_at(device_id.clone(), source, rate, fmt, channels) {
                    Ok(sink) => {
                        let label = sink.format_label().to_string();
                        // 用 sink 自己报的 rate/channels 打日志：与真正开出来的设备状态一致
                        let got_rate = sink.sample_rate();
                        let got_ch = sink.channels();
                        eprintln!(
                            "[engine] 已打开独占输出：{got_rate}Hz {} {got_ch}ch（设备 {name}）",
                            fmt.label()
                        );
                        self.endpoint_id = device_id;
                        self.endpoint_name = Some(name);
                        self.exclusive = Some(sink);
                        self.exclusive_mixer = Some(mixer);
                        self.exclusive_track_rate = track_rate;
                        self.last_fallback = None;
                        self.publish(Backend::Exclusive, Some(label));
                        return Ok(());
                    }
                    Err(e) => {
                        // 设备级错误（被占用 / 系统禁用独占 / 设备已失效）换采样率或位深都没用，
                        // 直接把这些候选试完只会白白多等几百毫秒（每次都是一次 Initialize）。
                        if matches!(
                            e.0,
                            Fallback::DeviceInUse
                                | Fallback::ExclusiveDisabled
                                | Fallback::DeviceInvalidated
                        ) {
                            return Err(e);
                        }
                        errors.push(e);
                    }
                }
            }
        }
        Err(backend::pick_fallback(&errors)
            .unwrap_or((Fallback::Other, "没有可用的独占格式".to_string())))
    }

    /// 停掉独占渲染线程并释放设备（会阻塞到线程真正退出，见 ExclusiveSink::stop）
    fn drop_exclusive(&mut self) {
        if let Some(mut s) = self.exclusive.take() {
            s.stop();
        }
        self.exclusive_mixer = None;
        self.exclusive_track_rate = None;
    }

    /// 当前输出链路对应的 mixer（共享 sink 的，或独占自建的那个）
    fn active_mixer(&self) -> Option<&Mixer> {
        if let Some(m) = &self.exclusive_mixer {
            return Some(m);
        }
        self.sink.as_ref().map(|s| s.mixer())
    }

    /// 把当前后端/格式/回退原因写进共享状态槽
    fn publish(&self, backend: Backend, format: Option<String>) {
        if let Ok(mut g) = self.status.lock() {
            g.opened = true;
            g.backend = backend;
            g.format = format;
            g.fallback = self.last_fallback.clone();
            g.output_rate = self.output_rate();
        }
    }

    /// 记录「最近一次交给输出的音源」的采样率，并算出有没有发生重采样。
    /// 供设置页显示 —— 用户不该为了确认这件事去翻控制台。
    fn note_source(&self, src_rate: u32) {
        let out = self.output_rate();
        if let Ok(mut g) = self.status.lock() {
            g.source_rate = Some(src_rate);
            g.output_rate = out;
            g.resampling = out.map(|o| o != src_rate).unwrap_or(false);
        }
    }

    /// 最后一次打开的端点 id（reset_device 之后依然保留）
    pub fn endpoint_id(&self) -> Option<&str> {
        self.endpoint_id.as_deref()
    }

    pub fn endpoint_name(&self) -> Option<&str> {
        self.endpoint_name.as_deref()
    }

    /// 取出并清空「输出流报错」标志（引擎每 tick 轮询一次）
    ///
    /// 独占渲染线程没有 cpal 那种错误回调：设备被拔/被抢时它只是**退出**，
    /// 所以这里把「独占线程死了」也当成设备失效报给引擎（引擎会走 reset_device 重开）。
    pub fn take_device_error(&self) -> bool {
        let by_stream = self.device_error.swap(false, Ordering::SeqCst);
        let by_exclusive = self
            .exclusive
            .as_ref()
            .map(|s| !s.is_alive())
            .unwrap_or(false);
        by_stream || by_exclusive
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
        if let Some(p) = &self.player {
            p.set_volume(self.volume);
        }
    }

    /// 只停掉当前播放句柄，**保留输出**。
    /// 保留输出的意义：共享 sink / 独占渲染线程会继续跑，只是没有源可拉 ⇒ 持续吐静音。
    /// 用于「在引擎线程上重新定位」的跳转（见 engine::seek_to）：那几百毫秒里
    /// 绝对不能把独占设备关掉 —— 关了就要重开，还会多出一次可听空档。
    pub fn stop_player(&mut self) {
        if let Some(p) = self.player.take() {
            p.stop();
        }
    }

    /// 停止并摘除当前播放句柄。
    /// ⚠️ 独占路径要**同时停掉渲染线程**：它会一直占着设备的独占通道（共享模式没有这个负担）。
    pub fn clear_player(&mut self) {
        self.stop_player();
        self.drop_exclusive();
    }

    /// 丢弃输出设备与播放句柄，强制下一次 new_player 重新打开设备。
    /// 场景：设备被拔掉/切走（蓝牙断开、DAC 休眠、HDMI 热插拔）后，流会静默失效，
    /// 而 sink 仍是 Some ⇒ 会直接返回 Ok、复用那个已经死掉的设备，
    /// 表现为「状态还是 playing，但一点声音都没有」。引擎的停滞看门狗据此重开（见 mod.rs）。
    /// 顺带清掉「独占已被否决」的标记：设备换了一台，应该重新协商一次。
    pub fn reset_device(&mut self) {
        self.clear_player();
        self.sink = None;
        self.exclusive_denied = false;
        self.last_fallback = None;
    }

    /// 建立新的播放句柄（音量自动跟随）。
    ///
    /// `track_rate` = 本次要播的曲目采样率（独占协商的第一候选）。
    /// ⚠️ 这里**只停播放句柄、不拆输出**：独占链路在采样率相同的连续曲目之间要复用，
    /// 否则每首歌都重开一次 WASAPI 客户端，曲间会多出一次几百毫秒的停顿。
    /// 需要释放设备时（Stop / 换设备 / 恢复）走 clear_player / reset_device。
    pub fn new_player(&mut self, track_rate: Option<u32>) -> Result<(), AppError> {
        if let Some(p) = self.player.take() {
            p.stop();
        }
        self.current_track_rate = track_rate;
        let prefer = self.preferred.clone();
        self.open_output(prefer.as_deref(), track_rate)?;
        let mixer = self.active_mixer().expect("open_output 成功后必然有输出");
        let player = Player::connect_new(mixer);
        player.set_volume(self.volume);
        self.player = Some(player);
        Ok(())
    }

    /// 播放句柄是否存在（共享与独占都算）。
    /// ⚠️ 语义是「有没有 Player」，不是「有没有 sink」—— 引擎的自然结束判定靠它 + player_empty()。
    pub fn sink_is_some(&self) -> bool {
        self.player.is_some()
    }

    pub fn player_empty(&self) -> bool {
        self.player.as_ref().map(|p| p.empty()).unwrap_or(true)
    }

    pub fn player_pos_secs(&self) -> f64 {
        self.player.as_ref().map(|p| p.get_pos().as_secs_f64()).unwrap_or(0.0)
    }

    #[allow(dead_code)]
    pub fn player_paused(&self) -> bool {
        self.player.as_ref().map(|p| p.is_paused()).unwrap_or(true)
    }

    pub fn player_pause(&self) {
        if let Some(p) = &self.player {
            p.pause();
        }
    }

    pub fn player_play(&self) {
        if let Some(p) = &self.player {
            p.play();
        }
    }

    /// 原地 seek（symphonia 走格式级定位，毫秒级、不打断播放）。
    /// 返回 false 表示该格式/当前状态不支持，需要调用方回退到重解码。
    pub fn player_seek(&self, target: Duration) -> bool {
        match &self.player {
            Some(p) => p.try_seek(target).is_ok(),
            None => false,
        }
    }

    /// 当前输出链路的采样率：共享 sink 的配置率，或独占协商出来的率。
    /// 也是「解码器必须转换到」的目标采样率。
    ///
    /// ⚠️ **刻意不把共享流强行固定成某个采样率**（比如 48k）。这是权衡后的决定：
    /// - 共享模式下这个值 = 用户在 Windows 里给该设备设的「默认格式」
    ///   （`DeviceSinkBuilder::from_device` → `default_output_config()`），我们原样跟进；
    /// - 于是每首歌都是「曲目率 → 设备率」**一次**多相 sinc 算过去，链路里没有第二级转换；
    /// - 如果强行开 48k，用户设成 96k/192k 时就会多出一级 Windows 音频引擎的重采样，
    ///   而且质量不再由我们掌控；
    /// - 代价是成本随设备率上升：release 实测立体声约 44.1k→48k 0.45% 单核、
    ///   →96k 0.9%、→192k 1.8%（见 engine/resample.rs 的 cost_table_common_pairs）。
    /// 独占模式不受这条影响：它按曲目率协商，协商成功时这里等于曲目率、完全不重采样。
    fn output_rate(&self) -> Option<u32> {
        if let Some(s) = &self.exclusive {
            return Some(s.sample_rate());
        }
        self.sink.as_ref().map(|s| s.config().sample_rate().get())
    }

    /// 当前输出链路的声道数：共享 sink 的配置，或独占协商用的声道数。
    /// 与 `output_rate` 一样从**活的** sink 读，不另存一份状态。
    ///
    /// 用途只有一个：判断「源比输出多声道 ⇒ 需要我们自己下混」。
    /// （独占路径按设备声道数建 mixer，所以这里就是设备声道数。）
    fn output_channels(&self) -> Option<usize> {
        if let Some(s) = &self.exclusive {
            return Some(s.channels() as usize);
        }
        self.sink.as_ref().map(|s| s.config().channel_count().get() as usize)
    }

    /// 追加解码器；顺带用 BeatTap 包裹，把采样喂给节拍检测。
    ///
    /// ⚠️ 采样率必须在这里就换成**输出设备的采样率**：rodio 自带的转换器是
    /// 「线性插值上采样 / 直接丢样本下采样」（见 engine/resample.rs 的说明），
    /// 共享模式下 44.1k 的曲目会被它毁掉。所以只要两者不一致就套一层多相 sinc；
    /// 一致时（独占模式按曲目率协商成功）直通，一格开销都不多花。
    pub fn player_append(&self, decoder: TrackDecoder, meter: Arc<BeatMeter>) {
        let Some(p) = &self.player else { return };
        let src_rate = decoder.sample_rate().get();
        let dst_rate = self.output_rate().unwrap_or(src_rate);
        // 给设置页留一份「本音源有没有被重采样」的事实
        self.note_source(src_rate);
        // 节拍检测看到的是重采样之后的样本，所以要按输出采样率配表
        meter.set_sample_rate(dst_rate);
        // ---- 多声道 → 立体声：必须在进 mixer 之前做 ----
        // rodio 的声道转换是「丢掉多余的声道」而不是下混（见 engine/downmix.rs 的说明），
        // 于是 5.1 在立体声设备上只剩 FL/FR —— 中置（人声/主奏）与环绕被静默丢弃。
        // 我们先算成 2ch，rodio 那层就退化成 2→2 的恒等变换。
        let mut src = decoder;
        let src_ch = src.channels().get() as usize;
        let dst_ch = self.output_channels().unwrap_or(2);
        if dst_ch == 2 && src_ch > 2 {
            if downmix::coeffs_for(src_ch).is_some() {
                eprintln!("[engine] 多声道 {src_ch}ch → 下混为 2ch（ITU-R BS.775）");
                src = TrackDecoder::Custom(Box::new(downmix::DownmixSource::new(src, src_ch)));
            } else {
                eprintln!(
                    "[engine] 多声道 {src_ch}ch 没有已知布局，交给 rodio 处理（可能只保留前 2 个声道）"
                );
            }
        }

        if src_rate != dst_rate && src_rate > 0 && dst_rate > 0 {
            eprintln!("[engine] 重采样：{src_rate} Hz → {dst_rate} Hz（多相 sinc）");
            p.append(BeatTap::new(ResamplerSource::new(src, dst_rate), meter));
        } else {
            p.append(BeatTap::new(src, meter));
        }
    }
}

// ---------------------------------------------------------------------------
// 默认输出端点的状态探测（CoreAudio）
// ---------------------------------------------------------------------------

/// 当前默认输出设备的 (稳定 id, 显示名)。名字只用于日志。
pub fn default_output_info() -> Option<(String, String)> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let host = rodio::cpal::default_host();
    let dev = host.default_output_device()?;
    let id = dev.id().ok().map(|d| d.1).unwrap_or_default();
    let name = dev.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "?".into());
    Some((id, name))
}

/// 按稳定 id 找 cpal 输出设备（找不到返回 None）
fn find_output_device_by_id(id: &str) -> Option<rodio::cpal::Device> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let host = rodio::cpal::default_host();
    let devices = host.output_devices().ok()?;
    devices.into_iter().find(|d| d.id().map(|x| x.1 == id).unwrap_or(false))
}

fn device_name(d: &rodio::cpal::Device) -> String {
    use rodio::cpal::traits::DeviceTrait;
    d.description().map(|x| x.name().to_string()).unwrap_or_else(|_| "?".into())
}

/// 取某台设备共享模式的默认采样率（独占协商的候选之一）。
/// 共享默认率几乎一定是这台设备「原生」支持的那个率，所以它排在曲目率之后、48000 之前。
fn shared_default_rate(id: Option<&str>) -> Option<u32> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let dev = match id {
        Some(i) => find_output_device_by_id(i)?,
        None => rodio::cpal::default_host().default_output_device()?,
    };
    dev.default_output_config().ok().map(|c| c.sample_rate())
}

/// 取某台设备共享模式的默认声道数。独占路径按它建 mixer，不做声道上下变换。
fn shared_default_channels(id: Option<&str>) -> Option<u16> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let dev = match id {
        Some(i) => find_output_device_by_id(i)?,
        None => rodio::cpal::default_host().default_output_device()?,
    };
    dev.default_output_config().ok().map(|c| c.channels())
}

/// usize 声道数 → rodio 的 ChannelCount（NonZero）。0 / 越界一律夹到合法值。
fn nz_channels(channels: usize) -> ChannelCount {
    NonZero::new(channels.clamp(1, u16::MAX as usize) as u16).unwrap_or_else(|| NonZero::new(1).unwrap())
}

/// u32 采样率 → rodio 的 SampleRate（NonZero）。0 视为 44100（调用方保证不会走到）。
fn nz_rate(rate: u32) -> SampleRate {
    NonZero::new(rate).unwrap_or_else(|| NonZero::new(44_100).unwrap())
}

/// 独占协商的采样率候选，按优先级：曲目采样率 → 设备共享默认率 → 48000 → 44100。
/// 去重、保序，并丢掉明显非法的值（< 8kHz）。
///
/// 为什么需要「设备共享默认率」这一档：设备原生率往往正是它唯一能独占的率；
/// 而 48000/44100 是最后的兜底（宁可重采样，也不要一点声音都没有）。
fn exclusive_rate_candidates(track_rate: Option<u32>, device_default: Option<u32>) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    for r in [track_rate, device_default, Some(48_000), Some(44_100)] {
        if let Some(r) = r {
            if r >= 8_000 && !out.contains(&r) {
                out.push(r);
            }
        }
    }
    out
}

/// 列出全部输出设备（设置页下拉用）。selected 是用户当前选中的 id。
/// 只列 cpal 能看到的那几台 —— 正是「能真正开流」的那几台，不会把一堆
/// NOTPRESENT 的历史端点塞进下拉里。
pub fn list_output_devices(selected: Option<&str>) -> Vec<crate::models::AudioDeviceInfo> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let host = rodio::cpal::default_host();
    let default_id = host
        .default_output_device()
        .and_then(|d| d.id().ok())
        .map(|x| x.1);
    let mut out = Vec::new();
    if let Ok(devices) = host.output_devices() {
        for d in devices {
            let Ok(id) = d.id() else { continue };
            out.push(crate::models::AudioDeviceInfo {
                is_default: default_id.as_deref() == Some(id.1.as_str()),
                is_selected: selected == Some(id.1.as_str()),
                name: device_name(&d),
                id: id.1,
            });
        }
    }
    out
}

/// 按稳定 id 查某个输出端点是否处于 ACTIVE（已插入且可用）状态。
/// None = 查不到这个端点（已彻底移除）或查询失败。
/// 用途：拔掉耳机后系统默认会切到别的端点（显示器 HDMI 音频是典型，它常驻 ACTIVE），
/// 只问「默认设备」会被骗；问「我们原来那台设备回来了没有」才靠谱。
#[cfg(windows)]
pub fn endpoint_active(id: &str) -> Option<bool> {
    use windows::core::HSTRING;
    use windows::Win32::Media::Audio::{
        IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    // 安全：只查询设备状态
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDevice(&HSTRING::from(id)).ok()?;
        let state = device.GetState().ok()?;
        Some(state == DEVICE_STATE_ACTIVE)
    }
}

#[cfg(not(windows))]
pub fn endpoint_active(_id: &str) -> Option<bool> {
    None
}

/// 默认输出端点的探测结果
pub enum DefaultOutput {
    /// 有默认端点；active=false 表示它已被拔出/禁用 —— 此时**开流也推不出声音**
    Found { active: bool, state: u32 },
    /// 一台输出端点都没有
    Missing,
    /// 查询失败（COM / 音频服务异常）：调用方应放行，别让一个诊断性查询把恢复流程卡死
    Unknown,
}

/// 引擎线程启动时调用一次：本线程要调 CoreAudio，得先有 COM 公寓。
/// 重复初始化返回 RPC_E_CHANGED_MODE（已是别的公寓模式），那不是失败。
#[cfg(windows)]
pub fn init_com_for_audio() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

#[cfg(not(windows))]
pub fn init_com_for_audio() {}

/// 探默认输出渲染端点：它是「已插入并且可用」（DEVICE_STATE_ACTIVE）还是别的状态。
///
/// 为什么非要这一步：**拔掉 3.5mm 耳机后，那个端点在 WASAPI 里依然可以被枚举、
/// 也能被成功打开**（驱动把它标成 DEVICE_STATE_UNPLUGGED）。于是
/// DeviceSinkBuilder 这边报成功、播放位置照常推进、错误回调一次都不响，而耳机里
/// 一点声音都没有 —— 这正是「进度条位置正确但没有声音」的成因。
/// 所以恢复流程必须先确认端点真的是 ACTIVE，再去开流。
#[cfg(windows)]
pub fn probe_default_output() -> DefaultOutput {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    // 安全：只查询设备状态，不持有任何跨线程对象
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(_) => return DefaultOutput::Unknown,
            };
        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(d) => d,
            // 一台输出端点都没有（全被拔掉 / 全被禁用）
            Err(_) => return DefaultOutput::Missing,
        };
        match device.GetState() {
            Ok(state) => DefaultOutput::Found { active: state == DEVICE_STATE_ACTIVE, state: state.0 },
            Err(_) => DefaultOutput::Unknown,
        }
    }
}

#[cfg(not(windows))]
pub fn probe_default_output() -> DefaultOutput {
    DefaultOutput::Unknown
}

/// 曲目解码器。
/// 默认走 rodio/symphonia；symphonia 不支持的格式（Opus、裸 AAC/ADTS）走自定义 Source。
/// 两者都实现 rodio 的 `Source`，所以引擎其余部分（BeatTap / 时长 / seek / 排水）完全不用改。
pub enum TrackDecoder {
    Symphonia(Decoder<BufReader<File>>),
    Custom(Box<dyn Source<Item = f32> + Send>),
}

impl Iterator for TrackDecoder {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        match self {
            TrackDecoder::Symphonia(d) => d.next(),
            TrackDecoder::Custom(d) => d.next(),
        }
    }
}

impl Source for TrackDecoder {
    fn current_span_len(&self) -> Option<usize> {
        match self {
            TrackDecoder::Symphonia(d) => d.current_span_len(),
            TrackDecoder::Custom(d) => d.current_span_len(),
        }
    }
    fn channels(&self) -> ChannelCount {
        match self {
            TrackDecoder::Symphonia(d) => d.channels(),
            TrackDecoder::Custom(d) => d.channels(),
        }
    }
    fn sample_rate(&self) -> SampleRate {
        match self {
            TrackDecoder::Symphonia(d) => d.sample_rate(),
            TrackDecoder::Custom(d) => d.sample_rate(),
        }
    }
    fn total_duration(&self) -> Option<Duration> {
        match self {
            TrackDecoder::Symphonia(d) => d.total_duration(),
            TrackDecoder::Custom(d) => d.total_duration(),
        }
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        match self {
            TrackDecoder::Symphonia(d) => d.try_seek(pos),
            TrackDecoder::Custom(d) => d.try_seek(pos),
        }
    }
}

/// 需要自己解码的格式（按文件内容嗅探，不看扩展名）
enum Kind {
    Opus,
    AdtsAac,
    Dsd,
}

/// 嗅探文件头，判断是不是 symphonia 处理不了的那两类。
/// ⚠️ Ogg 里也可能是 Vorbis / FLAC（symphonia 支持），所以必须确认首包里是 "OpusHead"
///    才能走 Opus 路径，否则会把能播的 Vorbis 交给错的解码器。
fn sniff(path: &str) -> Option<Kind> {
    let mut f = File::open(path).ok()?;
    let mut head = [0u8; 512];
    let n = f.read(&mut head).ok()?;
    let b = &head[..n];
    if b.len() >= 4 && &b[..4] == b"OggS" {
        return if b.windows(8).any(|w| w == &b"OpusHead"[..]) {
            Some(Kind::Opus)
        } else {
            None
        };
    }
    // ADTS：syncword 12 位全 1 且 layer == 00
    if b.len() >= 2 && b[0] == 0xFF && (b[1] & 0xF6) == 0xF0 {
        return Some(Kind::AdtsAac);
    }
    // DSD：DSF 以 "DSD " 开头；DFF(DSDIFF) 以 "FRM8" 开头
    if b.len() >= 4 && (&b[..4] == b"DSD " || &b[..4] == b"FRM8") {
        return Some(Kind::Dsd);
    }
    None
}

/// 打开音频文件并创建解码器
pub fn open_decoder(path: &str) -> Result<TrackDecoder, AppError> {
    match sniff(path) {
        Some(Kind::Opus) => {
            return Ok(TrackDecoder::Custom(Box::new(crate::engine::opus::OpusSource::open(path)?)))
        }
        Some(Kind::AdtsAac) => {
            return Ok(TrackDecoder::Custom(Box::new(crate::engine::adts::AdtsAacSource::open(path)?)))
        }
        Some(Kind::Dsd) => {
            return Ok(TrackDecoder::Custom(Box::new(crate::engine::dsd::DsdSource::open(path)?)))
        }
        None => {}
    }
    let file = File::open(path).map_err(|e| {
        AppError::new(crate::error::E_FILE_UNAVAILABLE, format!("无法打开音频文件 {path}: {e}"))
    })?;
    let decoder = Decoder::new(BufReader::new(file))
        .map_err(|e| AppError::new(E_DECODE, format!("解码器初始化失败（格式不支持或文件损坏）: {e}")))?;
    Ok(TrackDecoder::Symphonia(decoder))
}

/// 原地 seek 是否足够便宜 —— 决定它能不能在**音频线程**上执行。
///
/// root cause（用户报的「DSD 快进时出现电音，跳得越远电音越长」）：
/// rodio 的 `Player::try_seek` 并不是在调用者线程里执行的 —— 它把 seek 请求塞进 controls，
/// 由音频线程（独占渲染线程 / cpal 回调）在 periodic_access 里执行源自己的 try_seek。
/// symphonia 是格式级定位（seek 文件 + 重置解码器，毫秒级），没问题；
/// 而我们自己的三个 Source（DSD / ADTS / Opus）定位是 **O(跳转距离)** 的字节/帧遍历，
/// 放在音频线程上就是几百毫秒的欠载：WASAPI 缓冲排空，驱动把旧数据反复吐出来。
/// 所以只有 symphonia 允许走原地 seek，其余一律交给**引擎线程**上的重新定位（见 engine::seek_to）。
pub fn inline_seek_is_cheap(path: &str) -> bool {
    sniff(path).is_none()
}


#[cfg(test)]
mod decoder_tests {
    use super::*;
    use std::io::Write;

    /// 造一个极小的合法 WAV（44.1k / 单声道 / 16bit / 0.1 秒 440Hz），
    /// 用来回归「枚举化之后 symphonia 路径照旧可用」。
    fn make_wav() -> std::path::PathBuf {
        let rate = 44_100u32;
        let n = (rate as f32 * 0.1) as u32;
        let mut pcm = Vec::with_capacity(n as usize * 2);
        for i in 0..n {
            let v = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / rate as f32).sin() * 0.5;
            pcm.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
        }
        let mut w = Vec::new();
        let data_len = pcm.len() as u32;
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data_len).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes()); // PCM
        w.extend_from_slice(&1u16.to_le_bytes()); // 单声道
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
        w.extend_from_slice(&2u16.to_le_bytes()); // block align
        w.extend_from_slice(&16u16.to_le_bytes()); // bits
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_len.to_le_bytes());
        w.extend_from_slice(&pcm);
        let path = std::env::temp_dir().join("oberon_decoder_probe.wav");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(&w).unwrap();
        path
    }

    /// 回归：TrackDecoder 从具体类型改成枚举之后，symphonia 那条路必须照旧能开、有时长、有样本
    #[test]
    fn symphonia_path_still_works() {
        let p = make_wav();
        let mut d = open_decoder(p.to_str().unwrap()).expect("打开 WAV");
        assert!(matches!(d, TrackDecoder::Symphonia(_)), "WAV 应走 symphonia 路径");
        assert_eq!(d.sample_rate().get(), 44_100);
        assert_eq!(d.channels().get(), 1);
        let dur = d.total_duration().expect("应能给出时长").as_secs_f64();
        assert!((dur - 0.1).abs() < 0.02, "时长异常: {dur}");
        assert_eq!(d.by_ref().take(4410).count(), 4410, "应能取到样本");
    }

    /// 回归（用户报的「DSD 快进时出现电音，跳得越远电音越长」）：
    /// rodio 的原地 seek 是在**音频线程**上执行的，只有 symphonia 的格式级定位够便宜；
    /// 自定义源（DSD/ADTS/Opus）是 O(跳转距离) 的字节/帧遍历，必须交给引擎线程。
    /// 这条守住这个分类 —— 分类错了电音就会回来。
    #[test]
    fn only_symphonia_formats_use_inline_seek() {
        let wav = make_wav();
        assert!(inline_seek_is_cheap(wav.to_str().unwrap()), "WAV 应允许原地 seek");
        // DSD 容器头：sniff 只看前 4 字节
        let dsf = std::env::temp_dir().join("oberon_inline_dsd.dsf");
        let mut head = b"DSD ".to_vec();
        head.extend_from_slice(&[0u8; 40]);
        head[28..32].copy_from_slice(b"fmt ");
        std::fs::write(&dsf, &head).unwrap();
        assert!(!inline_seek_is_cheap(dsf.to_str().unwrap()), "DSD 绝不能走原地 seek");
        // ADTS：syncword 12 位全 1 + layer 00
        let aac = std::env::temp_dir().join("oberon_inline_adts.aac");
        std::fs::write(&aac, [0xFFu8, 0xF1, 0x50, 0x80, 0x00, 0x1F, 0xFC]).unwrap();
        assert!(!inline_seek_is_cheap(aac.to_str().unwrap()), "ADTS 绝不能走原地 seek");
    }

    /// 嗅探：Ogg Vorbis 不能被误判成 Opus（两者都以 OggS 开头）
    #[test]
    fn sniff_does_not_misroute_vorbis() {
        let p = std::env::temp_dir().join("oberon_sniff_vorbis.ogg");
        let mut fake = b"OggS".to_vec();
        fake.extend_from_slice(&[0u8; 40]);
        fake.extend_from_slice(b"\x01vorbis");
        std::fs::write(&p, &fake).unwrap();
        assert!(sniff(p.to_str().unwrap()).is_none(), "Vorbis 必须交给 symphonia");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 端点门禁依赖 CoreAudio 查询真的可用：如果它返回 Unknown（COM 没初始化），
    /// 恢复流程的门禁会被**静默跳过**，于是「拔出但仍可枚举的端点」又会开出没声音的流。
    /// 这里守住 COM 初始化那一环。
    #[test]
    fn coreaudio_probe_is_usable_after_com_init() {
        init_com_for_audio();
        match probe_default_output() {
            // 有默认端点（开发机必然如此）或一台都没有，都算查询链路正常
            DefaultOutput::Found { .. } | DefaultOutput::Missing => {}
            DefaultOutput::Unknown => panic!(
                "CoreAudio 查询返回 Unknown：COM 未初始化或音频服务异常，恢复门禁会被静默跳过"
            ),
        }
    }

    /// 设备错误标志必须是「取一次就清」的边沿信号：
    /// 不清的话恢复/告警流程每个 tick 都会重入一次；清了才可能在下一轮重新触发。
    #[test]
    fn device_error_flag_is_edge_triggered() {
        let core = CoreAudio::default();
        assert!(!core.take_device_error(), "初始应为未置位");
        core.device_error.store(true, Ordering::SeqCst);
        assert!(core.take_device_error(), "置位后第一次取应为 true");
        assert!(!core.take_device_error(), "取过之后必须被清掉");
    }

    /// 独占采样率候选：曲目率优先、设备默认率次之、48k/44.1k 兜底；去重保序、丢掉非法值
    #[test]
    fn exclusive_rate_candidates_order() {
        assert_eq!(exclusive_rate_candidates(Some(44_100), Some(48_000)), vec![44_100, 48_000]);
        // 曲目率就是设备率时去重
        assert_eq!(exclusive_rate_candidates(Some(48_000), Some(48_000)), vec![48_000, 44_100]);
        // 曲目率本机不支持也有兜底：调用方按顺序往下试（宁可重采样也不要没声音）
        assert_eq!(
            exclusive_rate_candidates(Some(88_200), Some(96_000)),
            vec![88_200, 96_000, 48_000, 44_100]
        );
        // 读不到曲目率（例如恢复流程早期）：设备默认率打头
        assert_eq!(exclusive_rate_candidates(None, Some(96_000)), vec![96_000, 48_000, 44_100]);
        // 设备默认率也读不到：仍是 48k / 44.1k
        assert_eq!(exclusive_rate_candidates(None, None), vec![48_000, 44_100]);
        // 非法值被丢掉
        assert_eq!(exclusive_rate_candidates(Some(0), Some(1)), vec![48_000, 44_100]);
    }

    /// 换模式 / 换设备必须重新给独占一次机会，否则一次回退就永久钉死在共享上
    #[test]
    fn mode_and_device_change_reset_exclusive_denial() {
        let mut core = CoreAudio::default();
        core.exclusive_denied = true;
        // 同一个模式：不算变化，不该动标记（否则每次设置页读一次都会重开设备）。
        // 默认模式是 Shared，所以拿 Shared 来测「无变化」
        assert!(!core.set_mode(OutputMode::Shared));
        assert!(core.exclusive_denied);
        assert!(core.set_mode(OutputMode::Exclusive));
        assert!(!core.exclusive_denied);
        core.exclusive_denied = true;
        assert!(core.set_preferred(Some("dev".into())));
        assert!(!core.exclusive_denied);
        // 同一台设备重复设置：无变化
        assert!(!core.set_preferred(Some("dev".into())));
    }

    /// 独占协商失败必须「记下原因 + 不再反复重试」：
    /// 用一台不存在的设备走完整条 open_output 路径（不会碰真声卡），
    /// 断言 denied 与回退原因都被写入。
    #[test]
    fn exclusive_failure_records_fallback_reason() {
        let status = Arc::new(Mutex::new(OutputStatus::default()));
        let mut core = CoreAudio::new(status.clone());
        assert!(core.set_mode(OutputMode::Exclusive));
        assert!(core.set_preferred(Some("不存在的端点 id".into())));
        // 指定的设备找不到 ⇒ 独占立刻失败；共享也开不了同一台设备 ⇒ 整体失败
        assert!(core.new_player(Some(44_100)).is_err());
        assert!(core.exclusive_denied, "独占失败后必须记下，避免每首歌都重试一次");
        assert!(core.last_fallback.is_some(), "回退原因要留给设置页显示");
        let st = core.output_status();
        assert!(!st.opened, "共享也没开成功时不能把状态标成已打开");
    }

    /// 「重新尝试独占」要把上一次的回退结论清干净，否则设置页会一直挂着旧警告
    #[test]
    fn forget_fallback_clears_status_and_denial() {
        let status = Arc::new(Mutex::new(OutputStatus {
            opened: true,
            backend: Backend::Shared,
            format: None,
            fallback: Some("该设备正被其它程序独占".into()),
            output_rate: Some(48_000),
            source_rate: Some(44_100),
            resampling: true,
        }));
        let mut core = CoreAudio::new(status.clone());
        core.exclusive_denied = true;
        core.last_fallback = Some("旧原因".into());
        core.forget_fallback();
        let st = core.output_status();
        assert!(!st.opened, "状态应回到「尚未打开」");
        assert!(st.fallback.is_none(), "回退原因要清掉");
        assert!(st.output_rate.is_none() && st.source_rate.is_none() && !st.resampling, "采样率信息也要清掉");
        assert!(!core.exclusive_denied, "要重新给独占一次机会");
        assert!(core.last_fallback.is_none());
    }

    /// 真机实跑（默认 --ignored）：把 CoreAudio 切到独占，跑一段正弦，
    /// 打印实际后端 / 格式 / 回退原因与播放位置 —— 这是「独占接进 CoreAudio」的硬证据。
    ///
    /// 为什么默认忽略：它会真的抢占声卡（跑测试时用户可能正在放歌），
    /// 也会和 probe_all_smoke 抢同一台设备。手动跑：
    ///   cargo test --lib -- --ignored --nocapture exclusive_coreaudio_plays
    #[test]
    #[ignore]
    fn exclusive_coreaudio_plays() {
        use rodio::Source;
        init_com_for_audio();
        let status = Arc::new(Mutex::new(OutputStatus::default()));
        let mut core = CoreAudio::new(status.clone());
        assert!(core.set_mode(OutputMode::Exclusive), "默认是 Shared，应能切到 Exclusive");
        core.new_player(Some(44_100)).expect("打开输出（独占或回退共享）");
        let st = core.output_status();
        eprintln!("[test] 后端={:?} 格式={:?} 回退={:?}", st.backend, st.format, st.fallback);
        // 频段选 440Hz / -20dB：能验证链路，又不至于把用户吓一跳
        let src = rodio::source::SineWave::new(440.0)
            .take_duration(Duration::from_millis(500))
            .amplify(0.1);
        core.player_append(TrackDecoder::Custom(Box::new(src)), BeatMeter::new());
        std::thread::sleep(Duration::from_millis(800));
        let pos = core.player_pos_secs();
        let empty = core.player_empty();
        eprintln!(
            "[test] 播放位置={pos:.3}s 队列空={empty} 设备错误={}",
            core.take_device_error()
        );
        assert!(pos > 0.2, "播放位置没有推进：独占/共享链路没在出样本（pos={pos}）");
        core.clear_player();
    }
}

/// 解码器总时长（部分格式可能未知，返回 None）
pub fn decoder_duration(decoder: &TrackDecoder) -> Option<Duration> {
    decoder.total_duration()
}

/// 解码器采样率（Hz）。独占输出要用它决定 mixer / 设备采样率。
pub fn decoder_sample_rate(decoder: &TrackDecoder) -> u32 {
    decoder.sample_rate().get()
}

/// 解码器原地 seek（优先，毫秒级）；不支持时回退到排水
pub fn seek_decoder(decoder: &mut TrackDecoder, target: Duration) -> f64 {
    if let Ok(()) = decoder.try_seek(target) {
        return target.as_secs_f64();
    }
    skip_decoder(decoder, target)
}

/// 通过“重解码跳过”实现跳转：把解码器排水到目标时间点，返回实际到达位置（秒）
pub fn skip_decoder(decoder: &mut TrackDecoder, target: Duration) -> f64 {
    let rate = decoder.sample_rate().get().max(1) as u64;
    let channels = decoder.channels().get().max(1) as u64;
    let target_samples = (target.as_secs_f64() * rate as f64 * channels as f64).ceil() as u64;
    let mut seen: u64 = 0;
    for _sample in decoder.by_ref() {
        seen += 1;
        if seen >= target_samples {
            break;
        }
    }
    seen as f64 / (rate as f64 * channels as f64)
}