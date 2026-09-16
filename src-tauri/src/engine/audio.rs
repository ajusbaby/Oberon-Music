//! 音频解码与底层播放辅助（rodio 0.22：symphonia 解码 + cpal 输出）
//!
//! - 解码：rodio 内置 symphonia 后端（mp3/flac/wav/ogg/m4a(aac/alac)/aiff/caf 等）
//! - 输出：DeviceSinkBuilder 默认设备（WASAPI 共享）；独占模式输出留待后续里程碑
//! - 跳转：按设计文档 §4.3 “通过重解码实现”——重新打开文件并跳过样本到目标位置

use crate::engine::beat::{BeatMeter, BeatTap};
use crate::error::{AppError, E_AUDIO_DEVICE, E_DECODE};
use rodio::source::Source;
use rodio::{Decoder, MixerDeviceSink, Player};
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 输出设备 + 播放句柄的持有者（Player/Drop 语义：句柄释放即停止）
pub struct CoreAudio {
    /// 设备句柄必须存活于整个播放过程
    sink: Option<MixerDeviceSink>,
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
}

impl Default for CoreAudio {
    fn default() -> Self {
        Self {
            sink: None,
            player: None,
            volume: 1.0,
            device_error: Arc::new(AtomicBool::new(false)),
            endpoint_id: None,
            endpoint_name: None,
            preferred: None,
        }
    }
}

impl CoreAudio {
    /// 惰性初始化音频输出（WASAPI 共享模式；失败返回 AUDIO_DEVICE 错误）
    ///
    /// ⚠️ 这里刻意**不用** rodio 的 open_default_sink()：它装的是默认错误回调，设备被拔掉时
    /// 只往 stderr 打一行「audio stream error: ... unplugged」就完了，引擎侧完全感知不到
    /// 设备已经没了 —— 这正是「拔掉耳机后无声但界面仍显示在播放」的根因。
    /// 现在换成自己的错误回调，把「输出流死了」变成引擎能轮询的标志位（见 take_device_error）。
    pub fn ensure(&mut self) -> Result<(), AppError> {
        // 用户指定了输出设备就开它（开不了就报错，由引擎进入「等待设备」而不是偷偷换一台）
        let prefer = self.preferred.clone();
        self.ensure_with(prefer.as_deref())
    }

    /// 设置偏好的输出设备（None = 跟随系统默认）。返回是否真的发生了变化。
    pub fn set_preferred(&mut self, id: Option<String>) -> bool {
        if self.preferred == id {
            return false;
        }
        self.preferred = id;
        true
    }

    /// 当前偏好的输出设备 id（None = 跟随系统默认）
    pub fn preferred_device_id(&self) -> Option<&str> {
        self.preferred.as_deref()
    }

    /// 打开输出流。`prefer_id` 给出时**必须**开那台设备（找不到就直接失败，绝不悄悄退回默认
    /// 设备）—— 这正是「拔掉耳机后声音跑到显示器 HDMI 音频上」那个 bug 的关键：
    /// 恢复时若放它去开「系统默认」，系统早就把默认切到那类常驻 ACTIVE 的端点上了。
    pub fn ensure_with(&mut self, prefer_id: Option<&str>) -> Result<(), AppError> {
        if self.sink.is_some() {
            return Ok(());
        }
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
                eprintln!("[engine] 已打开输出设备：{name}");
                Ok(())
            }
            Err(e) => Err(AppError::new(E_AUDIO_DEVICE, format!("无法打开音频输出设备（WASAPI）：{e}"))),
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
    pub fn take_device_error(&self) -> bool {
        self.device_error.swap(false, Ordering::SeqCst)
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
        if let Some(p) = &self.player {
            p.set_volume(self.volume);
        }
    }

    /// 停止并摘除当前播放句柄
    pub fn clear_player(&mut self) {
        if let Some(p) = self.player.take() {
            p.stop();
        }
    }

    /// 丢弃输出设备与播放句柄，强制下一次 new_player 重新打开默认设备。
    /// 场景：设备被拔掉/切走（蓝牙断开、DAC 休眠、HDMI 热插拔）后，rodio 的流会静默失效，
    /// 而 sink 仍是 Some ⇒ ensure() 会直接返回 Ok、复用那个已经死掉的设备，
    /// 表现为「状态还是 playing，但一点声音都没有」。引擎的停滞看门狗据此重开（见 mod.rs）。
    pub fn reset_device(&mut self) {
        self.clear_player();
        self.sink = None;
    }

    /// 建立新的播放句柄（音量自动跟随）
    pub fn new_player(&mut self) -> Result<(), AppError> {
        self.clear_player();
        self.ensure()?;
        let sink = self.sink.as_ref().expect("sink 由 ensure 保证");
        let player = Player::connect_new(sink.mixer());
        player.set_volume(self.volume);
        self.player = Some(player);
        Ok(())
    }

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

    /// 追加解码器；顺带用 BeatTap 包裹，把采样喂给节拍检测
    pub fn player_append(&self, decoder: TrackDecoder, meter: Arc<BeatMeter>) {
        if let Some(p) = &self.player {
            meter.set_sample_rate(decoder.sample_rate().get());
            p.append(BeatTap::new(decoder, meter));
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

/// 类型别名：单曲解码器（文件 + BufReader）
pub type TrackDecoder = Decoder<BufReader<File>>;

/// 打开音频文件并创建解码器
pub fn open_decoder(path: &str) -> Result<TrackDecoder, AppError> {
    let file = File::open(path).map_err(|e| {
        AppError::new(crate::error::E_FILE_UNAVAILABLE, format!("无法打开音频文件 {path}: {e}"))
    })?;
    let decoder = Decoder::new(BufReader::new(file))
        .map_err(|e| AppError::new(E_DECODE, format!("解码器初始化失败（格式不支持或文件损坏）: {e}")))?;
    Ok(decoder)
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
}

/// 解码器总时长（部分格式可能未知，返回 None）
pub fn decoder_duration(decoder: &TrackDecoder) -> Option<Duration> {
    decoder.total_duration()
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