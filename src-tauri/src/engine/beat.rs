//! 节拍检测：在音频采样流上挂一个极轻量的旁路，输出 0..1 的"节拍强度"。
//!
//! 做法（不引入 FFT 依赖，每个采样只有几次乘加）：
//!   1. 一阶低通提取低频（约 140Hz）——鼓点主要能量在这里
//!   2. 每 1024 个采样算一次窗口 RMS
//!   3. 与"慢速平均能量"比较，超出量即起音强度（onset）
//!   4. 快起慢落包络：视觉上像"跳动"，不会抖动
//!
//! 通过 `BeatTap` 包裹解码器接入：它逐样本转发给 rodio，同时喂给 `BeatMeter`。
//! ⚠️ 必须转发 `try_seek`，否则播放器的原地 seek 会失效（引擎依赖它做秒级跳转）。

use rodio::source::{SeekError, Source};
use rodio::{ChannelCount, SampleRate};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 统计窗口（采样数）。@44.1kHz 约 23ms
const WINDOW: usize = 1024;
/// 低通截止频率（Hz）
const LP_CUTOFF: f32 = 140.0;
/// 慢速平均的跟随速度（越小越慢）
const AVG_RATE: f32 = 0.08;
/// 每窗口的释放系数（越小衰减越快）。0.94 约 400ms 落回，比原来的 0.86 柔和得多
const RELEASE: f32 = 0.94;
/// 起音平滑：不完全瞬发，避免"闪一下"的硬跳
const ATTACK: f32 = 0.26;

pub struct BeatMeter {
    lp: AtomicU32,
    acc: AtomicU32,
    n: AtomicUsize,
    avg: AtomicU32,
    level: AtomicU32,
    alpha: AtomicU32,
}

impl BeatMeter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            lp: AtomicU32::new(0f32.to_bits()),
            acc: AtomicU32::new(0f32.to_bits()),
            n: AtomicUsize::new(0),
            avg: AtomicU32::new(0f32.to_bits()),
            level: AtomicU32::new(0f32.to_bits()),
            alpha: AtomicU32::new(0.02f32.to_bits()),
        })
    }

    /// 按采样率设置低通系数（打开新解码器时调用）
    pub fn set_sample_rate(&self, rate: u32) {
        let a = 1.0 - (-2.0 * std::f32::consts::PI * LP_CUTOFF / rate.max(1) as f32).exp();
        self.alpha.store(a.clamp(0.0005, 1.0).to_bits(), Ordering::Relaxed);
    }

    /// 清零（停止播放时调用，避免残留亮度）
    pub fn reset(&self) {
        self.acc.store(0f32.to_bits(), Ordering::Relaxed);
        self.n.store(0, Ordering::Relaxed);
        self.avg.store(0f32.to_bits(), Ordering::Relaxed);
        self.level.store(0f32.to_bits(), Ordering::Relaxed);
    }

    /// 每个采样调用一次（音频线程）
    pub fn push(&self, s: f32) {
        let alpha = f32::from_bits(self.alpha.load(Ordering::Relaxed));
        let lp_prev = f32::from_bits(self.lp.load(Ordering::Relaxed));
        let lp = lp_prev + (s - lp_prev) * alpha;
        self.lp.store(lp.to_bits(), Ordering::Relaxed);

        let acc = f32::from_bits(self.acc.load(Ordering::Relaxed)) + lp * lp;
        let n = self.n.load(Ordering::Relaxed) + 1;
        if n < WINDOW {
            self.acc.store(acc.to_bits(), Ordering::Relaxed);
            self.n.store(n, Ordering::Relaxed);
            return;
        }

        let rms = (acc / n as f32).sqrt();
        let avg_prev = f32::from_bits(self.avg.load(Ordering::Relaxed));
        let avg = if avg_prev <= 1e-7 { rms } else { avg_prev + (rms - avg_prev) * AVG_RATE };
        self.avg.store(avg.to_bits(), Ordering::Relaxed);

        // 起音强度：当前低频能量相对慢速平均的超出量（音乐安静时自然接近 0）
        let raw = if avg > 1e-6 { ((rms / avg - 1.0) * 1.5).clamp(0.0, 1.0) } else { 0.0 };
        let prev = self.level();
        // 上升也做一次平滑（不完全瞬发），下降用更慢的释放 → 整体"软"下来
        let next = if raw > prev { prev + (raw - prev) * ATTACK } else { prev * RELEASE };
        self.level.store(next.to_bits(), Ordering::Relaxed);

        self.acc.store(0f32.to_bits(), Ordering::Relaxed);
        self.n.store(0, Ordering::Relaxed);
    }

    /// 当前节拍强度 0..1（前端 ~30Hz 取值）
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed)).clamp(0.0, 1.0)
    }
}

/// 把解码器包一层：逐样本转发，同时喂节拍检测
pub struct BeatTap<S> {
    inner: S,
    meter: Arc<BeatMeter>,
}

impl<S> BeatTap<S> {
    pub fn new(inner: S, meter: Arc<BeatMeter>) -> Self {
        Self { inner, meter }
    }
}

impl<S: Source> Iterator for BeatTap<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let s = self.inner.next()?;
        self.meter.push(s);
        Some(s)
    }
}

impl<S: Source> Source for BeatTap<S> {
    #[inline]
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }

    #[inline]
    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }

    #[inline]
    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    /// 必须转发：播放器的原地 seek 会穿透到这里
    #[inline]
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)
    }
}
