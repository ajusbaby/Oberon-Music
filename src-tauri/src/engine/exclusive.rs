//! 独占输出的渲染层：一个独立线程，把混音器的样本写进 WASAPI 独占缓冲。
//!
//! 为什么这样接：rodio 的 Mixer / mixer() 是公开 API，所以可以
//!   自建 Mixer → Player::connect_new(&mixer) → 本模块从 MixerSource 拉样本
//! 因此**解码器、播放队列、gapless 预排、seek、BPM、SMTC 全部不用改**，
//! 只是把「最后一公里」从 cpal 换成 WASAPI 独占。
//!
//! 线程模型：设备枚举、格式协商、Initialize 全部在渲染线程里做（避免 COM 接口跨线程传递），
//! 结果通过 channel 同步回报，所以调用方能拿到明确的成功/失败与原因。
//! ⚠️ WASAPI 基于 COM，**每个线程都要自己 initialize_mta()** —— 这里在渲染线程开头做了。

use super::backend::{classify, try_open, Fallback, Fmt};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use wasapi::{initialize_mta, DeviceEnumerator, Direction, ShareMode};

/// f32 → 设备格式的字节。
/// ⚠️ 24-in-32 用**左对齐**（有效位在高 24 位）—— WASAPI 对
/// wValidBitsPerSample < wBitsPerSample 的要求。这条有单测守着。
pub fn push_sample(out: &mut Vec<u8>, v: f32, fmt: Fmt) {
    let v = v.clamp(-1.0, 1.0);
    if fmt.is_float {
        out.extend_from_slice(&v.to_le_bytes());
    } else if fmt.store == 16 {
        out.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
    } else {
        let s = (v * 8_388_607.0) as i32;
        out.extend_from_slice(&(s << 8).to_le_bytes());
    }
}

pub struct ExclusiveSink {
    stop: Arc<AtomicBool>,
    played: Arc<AtomicU64>,
    dead: Arc<AtomicBool>,
    format_label: String,
    rate: u32,
    channels: usize,
}

impl ExclusiveSink {
    /// 打开独占输出并启动渲染线程。
    ///
    /// - device_id：None = 系统默认设备；找不到指定设备时回退默认。
    /// - source：通常是 rodio 的 MixerSource（也就是整个播放队列的输出）。
    /// - prefer_rate：优先尝试的采样率（一般传当前曲目的采样率）。
    ///
    /// 失败返回 (Fallback, 原始错误)，调用方据此回退共享模式并告诉用户原因。
    /// ⚠️ 采样率必须与调用方创建 Mixer 时用的采样率**完全一致**。
    /// 不一致的后果不是音质差一点，而是**变速播放** —— 我们已经在 current_span_len 那个
    /// bug 上吃过一次（DSD 88.2k 之后接 44.1k 的曲子变成 2 倍速）。
    /// 所以这里**不做自动协商**：由调用方「先定率 → 用同一个率建 Mixer → 再开这个」。
    pub fn start_at<S>(
        device_id: Option<String>,
        source: S,
        rate: u32,
        fmt: Fmt,
        channels: usize,
    ) -> Result<Self, (Fallback, String)>
    where
        S: Iterator<Item = f32> + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let played = Arc::new(AtomicU64::new(0));
        let dead = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<Result<(String, u32), (Fallback, String)>>();

        let stop_t = stop.clone();
        let played_t = played.clone();
        let dead_t = dead.clone();
        std::thread::Builder::new()
            .name("oberon-wasapi-exclusive".into())
            .spawn(move || {
                // ⚠️ WASAPI 基于 COM，且**每个线程都要自己初始化**。
                //    少了这一行，整条独占路径都会失败（这条被编译警告抓到过一次）。
                let _ = initialize_mta();
                let r = render_loop(
                    device_id,
                    source,
                    rate,
                    fmt,
                    channels,
                    &stop_t,
                    &played_t,
                    |res| {
                        let _ = tx.send(res);
                    },
                );
                if let Err((f, e)) = r {
                    eprintln!("[exclusive] 渲染线程退出: {f:?} {e}");
                }
                dead_t.store(true, Ordering::SeqCst);
            })
            .map_err(|e| (Fallback::Other, format!("创建独占渲染线程失败: {e}")))?;

        match rx.recv() {
            Ok(Ok((label, rate))) => Ok(Self {
                stop,
                played,
                dead,
                format_label: label,
                rate,
                channels,
            }),
            Ok(Err((f, e))) => {
                stop.store(true, Ordering::SeqCst);
                Err((f, e))
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err((Fallback::Other, "独占渲染线程提前退出".into()))
            }
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
    pub fn played_frames(&self) -> u64 {
        self.played.load(Ordering::Relaxed)
    }
    pub fn format_label(&self) -> &str {
        &self.format_label
    }
    pub fn sample_rate(&self) -> u32 {
        self.rate
    }
    pub fn channels(&self) -> usize {
        self.channels
    }
    /// 渲染线程是否还活着（设备被拔/被抢时它会退出）
    pub fn is_alive(&self) -> bool {
        !self.dead.load(Ordering::SeqCst)
    }
}

impl Drop for ExclusiveSink {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// 线程主体：枚举 → 协商 → Initialize（带对齐重试）→ 事件驱动渲染
fn render_loop<S>(
    device_id: Option<String>,
    mut source: S,
    rate: u32,
    fmt: Fmt,
    channels: usize,
    stop: &AtomicBool,
    played: &AtomicU64,
    report: impl FnOnce(Result<(String, u32), (Fallback, String)>),
) -> Result<(), (Fallback, String)>
where
    S: Iterator<Item = f32>,
{
    let enumr =
        DeviceEnumerator::new().map_err(|e| (Fallback::Other, format!("枚举设备失败: {e}")))?;
    let dev = match device_id {
        Some(id) => enumr
            .get_device(&id)
            .or_else(|_| enumr.get_default_device(&Direction::Render))
            .map_err(|e| (Fallback::Other, format!("打开设备失败: {e}")))?,
        None => enumr
            .get_default_device(&Direction::Render)
            .map_err(|e| (Fallback::Other, format!("打开默认设备失败: {e}")))?,
    };
    let mut client = dev
        .get_iaudioclient()
        .map_err(|e| (Fallback::Other, format!("取 IAudioClient 失败: {e}")))?;

    // 校验调用方指定的 (rate, fmt)：必须被**逐位**支持。不自动协商（见 start_at 的说明）
    let rate_us = rate as usize;
    let wf = fmt.wave(rate_us, channels);
    match client.is_supported(&wf, &ShareMode::Exclusive) {
        Ok(None) => {}
        Ok(Some(_)) => {
            return Err((
                Fallback::UnsupportedFormat,
                format!("{rate}/{} 只能近似支持，不能 bit-perfect", fmt.label()),
            ))
        }
        Err(e) => return Err((Fallback::UnsupportedFormat, e.to_string())),
    }

    let _period = try_open(&mut client, rate_us, fmt, channels).map_err(|e| (classify(&e), e))?;
    let event = client
        .set_get_eventhandle()
        .map_err(|e| (classify(&e.to_string()), e.to_string()))?;
    let render = client
        .get_audiorenderclient()
        .map_err(|e| (classify(&e.to_string()), e.to_string()))?;
    let buf_frames = client
        .get_buffer_size()
        .map_err(|e| (classify(&e.to_string()), e.to_string()))? as usize;
    client
        .start_stream()
        .map_err(|e| (classify(&e.to_string()), e.to_string()))?;

    report(Ok((format!("{rate}/{}", fmt.label()), rate as u32)));

    let bpf = fmt.bytes_per_frame(channels);
    let mut bytes: Vec<u8> = Vec::with_capacity(buf_frames * bpf);
    let mut frames: u64 = 0;
    while !stop.load(Ordering::SeqCst) {
        if event.wait_for_event(200).is_err() {
            break;
        }
        let Ok(free) = client.get_available_space_in_frames() else {
            break;
        };
        if free == 0 {
            continue;
        }
        bytes.clear();
        for _ in 0..free {
            for _ in 0..channels {
                // 源结束（或混音器 keep-alive）时补静音：写静音而不停流，
                // 这样引擎照旧用 player_empty() 判断自然结束，行为与共享模式一致
                let v = source.next().unwrap_or(0.0);
                push_sample(&mut bytes, v, fmt);
            }
        }
        if render.write_to_device(free as usize, &bytes, None).is_err() {
            break;
        }
        frames += free as u64;
        played.store(frames, Ordering::Relaxed);
    }
    let _ = client.stop_stream();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 字节转换必须逐位对：错一位就是音量错 256 倍或满量程削波
    #[test]
    fn sample_bytes_are_exact() {
        let mut v = Vec::new();
        push_sample(&mut v, 1.0, Fmt::int(16, 16));
        assert_eq!(v, vec![0xFF, 0x7F]);
        v.clear();
        push_sample(&mut v, -1.0, Fmt::int(16, 16));
        assert_eq!(v, vec![0x01, 0x80]);
        v.clear();
        push_sample(&mut v, 1.0, Fmt::int(32, 24));
        assert_eq!(v.len(), 4);
        let s = i32::from_le_bytes([v[0], v[1], v[2], v[3]]);
        assert_eq!(s, 0x7FFF_FF00, "24 位必须左对齐放进 32 位容器");
        v.clear();
        push_sample(&mut v, 0.0, Fmt::int(32, 24));
        assert_eq!(i32::from_le_bytes([v[0], v[1], v[2], v[3]]), 0);
        v.clear();
        push_sample(&mut v, 99.0, Fmt::int(16, 16));
        assert_eq!(v, vec![0xFF, 0x7F]);
    }

    #[test]
    fn frame_size_matches_format() {
        assert_eq!(Fmt::int(16, 16).bytes_per_frame(2), 4);
        assert_eq!(Fmt::int(32, 24).bytes_per_frame(2), 8);
        assert_eq!(Fmt::float(32).bytes_per_frame(1), 4);
    }
}
