//! 多声道 → 立体声下混（ITU-R BS.775）。
//!
//! ## 为什么必须自己写一个
//! rodio 0.22 的混音器会给每个源套一层 `UniformSourceIterator` 做「统一声道数 + 统一采样率」，
//! 而它的声道转换器（`conversions/channels.rs`）是**丢声道**而不是下混：
//!
//! ```text
//! if self.from > self.to {
//!     for _ in self.to.get()..self.from.get() { self.input.next(); } // discarding extra input
//! }
//! ```
//!
//! 它自己的单测 `remove_channels` 写得很清楚：3ch → 2ch 的 `[1,2,3, 4,5,6]` 出来是 `[1,2, 4,5]`。
//! 后果：**5.1 FLAC（声道序 FL,FR,FC,LFE,BL,BR）在立体声输出上只剩 FL/FR —— 中置（人声、
//! 主奏通常在那儿）、低频、两个环绕被静默丢弃**，不报错、不提示。
//!
//! 所以我们在进 mixer **之前**把 N→2 做掉；rodio 那层于是变成 2→2 的恒等变换（`from == to`
//! 直接 `return self.input.next()`，见 conversions/sample_rate.rs），一分钱不多花。
//!
//! ## 布局假设
//! 严谨做法是从容器读 channel mask，但 rodio 的 `Decoder` 只暴露**声道数**、不给 mask。
//! 所以按 `WAVE_FORMAT_EXTENSIBLE` 的惯例按声道数推断；6ch(5.1) 与 8ch(7.1) 是无歧义的，
//! 3/4/5 有约定但也存在少数异类（例如 4ch 的 3.1 混音）。推断不出来时返回 None，
//! 调用方会把源原样交给 rodio 并打一条警告 —— 宁可退化成旧行为，也不要乱算。

use rodio::source::{SeekError, Source};
use rodio::{ChannelCount, SampleRate};
use std::num::NonZero;
use std::time::Duration;

/// 中置 / 环绕的 -3dB 系数（ITU-R BS.775）
const D3: f32 = std::f32::consts::FRAC_1_SQRT_2; // 0.70710678
/// LFE 的系数。BS.775 允许丢弃 LFE；这里取 -6dB 加进去，
/// 因为影视取向的 5.1 混音会把低频只放在 LFE 里，丢掉会明显变薄。
/// 这是**可调的选择**：想让输出更保守（更不容易削顶）就把 LFE 系数调成 0。
const LFE: f32 = 0.5;

/// 每个源声道的 (左, 右) 系数
type Coeffs = [(f32, f32)];

const FL: (f32, f32) = (1.0, 0.0);
const FR: (f32, f32) = (0.0, 1.0);
const FC: (f32, f32) = (D3, D3);
const LF: (f32, f32) = (LFE, LFE);
const BL: (f32, f32) = (D3, 0.0);
const BR: (f32, f32) = (0.0, D3);

static C3: [(f32, f32); 3] = [FL, FR, FC]; // 3.0：FL FR FC
static C4: [(f32, f32); 4] = [FL, FR, BL, BR]; // quad：FL FR BL BR
static C5: [(f32, f32); 5] = [FL, FR, FC, BL, BR]; // 5.0：FL FR FC BL BR
static C6: [(f32, f32); 6] = [FL, FR, FC, LF, BL, BR]; // 5.1：FL FR FC LFE BL BR
static C7: [(f32, f32); 7] = [FL, FR, FC, LF, FC, BL, BR]; // 6.1：后中置按中置处理
static C8: [(f32, f32); 8] = [FL, FR, FC, LF, BL, BR, BL, BR]; // 7.1：FL FR FC LFE BL BR SL SR

/// 声道数 → 各声道的下混系数。未知布局返回 None（调用方保持旧行为）。
pub fn coeffs_for(src_channels: usize) -> Option<&'static Coeffs> {
    match src_channels {
        3 => Some(&C3[..]),
        4 => Some(&C4[..]),
        5 => Some(&C5[..]),
        6 => Some(&C6[..]),
        7 => Some(&C7[..]),
        8 => Some(&C8[..]),
        _ => None,
    }
}

/// 把 N 声道（N>2）的 f32 音源下混成 2 声道交错输出。
pub struct DownmixSource<S> {
    inner: S,
    src_channels: usize,
    coeffs: &'static Coeffs,
    /// 复用的一帧输入样本（容量恒为 src_channels，不产生分配）
    frame: Vec<f32>,
    /// 已经算好、等下一次 next() 吐出的右声道样本
    stashed_right: Option<f32>,
}

impl<S: Source<Item = f32>> DownmixSource<S> {
    /// `src_channels` 必须等于 `inner.channels()`（调用方已按它查过 `coeffs_for`）。
    pub fn new(inner: S, src_channels: usize) -> Self {
        let coeffs = coeffs_for(src_channels).expect("DownmixSource 只接受已知布局");
        Self {
            inner,
            src_channels,
            coeffs,
            frame: vec![0.0; src_channels],
            stashed_right: None,
        }
    }
}

fn stereo() -> ChannelCount {
    NonZero::new(2u16).unwrap()
}

impl<S: Source<Item = f32>> Iterator for DownmixSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        // 上一帧的右声道还没吐出去
        if let Some(r) = self.stashed_right.take() {
            return Some(r);
        }
        // 读一整帧；不足一帧（文件尾截断）就直接结束，不要吐出半帧去污染声道交替
        for i in 0..self.src_channels {
            match self.inner.next() {
                Some(s) => self.frame[i] = s,
                None => return None,
            }
        }
        let mut l = 0.0f32;
        let mut r = 0.0f32;
        for (i, &s) in self.frame.iter().enumerate() {
            let (cl, cr) = self.coeffs[i];
            l += s * cl;
            r += s * cr;
        }
        // 系数和最大 1 + 0.707 + 0.707 + 0.5 ≈ 2.9，满幅内容理论上会超 1。
        // 这里只做兜底削顶、不做整体衰减：常见音乐内容够不到，而整体衰减会让
        // 多声道文件听起来比立体声文件小一截（AB 对比就失真了）。
        self.stashed_right = Some(r.clamp(-1.0, 1.0));
        Some(l.clamp(-1.0, 1.0))
    }
}

impl<S: Source<Item = f32>> Source for DownmixSource<S> {
    /// ⚠️ 必须返回 Some：返回 None 会让混音器的采样率转换比在换源后失效（见 engine 的不变量）。
    /// 一帧 N 个输入样本变成一帧 2 个输出样本，所以按帧数换算。
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len().map(|n| {
            // 输入的 span 是**交错样本数**（总是整帧），除以声道数得帧数、乘 2 得输出样本数。
            // ⚠️ 兜底 max(2)：返回 Some(0) 会让 rodio 的 UniformSourceIterator 直接当成
            //    流已结束（Take{n:0} 立刻 None）。宁可多读一帧（读不满会正常返回 None）。
            ((n / self.src_channels.max(1)) * 2).max(2)
        })
    }

    fn channels(&self) -> ChannelCount {
        stereo()
    }

    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        // 丢掉半帧状态，否则 seek 后的第一个输出会错位
        self.stashed_right = None;
        self.inner.try_seek(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个「每个声道一个常数」的测试源：第 i 帧所有声道都等于 i+1 的某个倍数，
    /// 便于按系数手算期望值。
    struct Cst {
        ch: usize,
        left: u64,
        rate: SampleRate,
        frame: usize,
        total: usize,
    }

    impl Iterator for Cst {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.frame >= self.total {
                return None;
            }
            // 每帧：声道 c 的值 = (c+1) / 16，简单可手算
            let c = self.left as usize;
            self.left += 1;
            if self.left as usize == self.ch {
                self.left = 0;
                self.frame += 1;
            }
            Some((c + 1) as f32 / 16.0)
        }
    }

    impl Source for Cst {
        fn current_span_len(&self) -> Option<usize> {
            Some(4)
        }
        fn channels(&self) -> ChannelCount {
            NonZero::new(self.ch as u16).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            self.rate
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    fn rate() -> SampleRate {
        NonZero::new(48_000u32).unwrap()
    }

    /// 5.1：中置与环绕必须进到输出里，而不是被丢掉（rodio 的默认行为就是丢）
    #[test]
    fn five_one_downmixes_instead_of_dropping_channels() {
        let s = Cst { ch: 6, left: 0, rate: rate(), frame: 0, total: 1 };
        let out: Vec<f32> = DownmixSource::new(s, 6).collect();
        assert_eq!(out.len(), 2, "6ch 一帧应产出立体声一帧");
        // 帧内声道值 = [1,2,3,4,5,6]/16
        let (fl, fr, fc, lfe, bl, br) = (1.0 / 16.0, 2.0 / 16.0, 3.0 / 16.0, 4.0 / 16.0, 5.0 / 16.0, 6.0 / 16.0);
        let want_l = fl + D3 * fc + LFE * lfe + D3 * bl;
        let want_r = fr + D3 * fc + LFE * lfe + D3 * br;
        assert!((out[0] - want_l).abs() < 1e-6, "左 {} != {}", out[0], want_l);
        assert!((out[1] - want_r).abs() < 1e-6, "右 {} != {}", out[1], want_r);
        // 关键回归：中置必须出现在输出里（旧行为是全丢）
        assert!(out[0] > fl, "中置没有混进左声道");
    }

    /// 声道顺序不能错位：连续两帧要按 L,R,L,R 交替
    #[test]
    fn interleaving_is_stable_across_frames() {
        let s = Cst { ch: 6, left: 0, rate: rate(), frame: 0, total: 2 };
        let out: Vec<f32> = DownmixSource::new(s, 6).collect();
        assert_eq!(out.len(), 4);
        // 两帧内容相同 ⇒ L,R 各重复一次
        assert!((out[0] - out[2]).abs() < 1e-9, "左右声道错位");
        assert!((out[1] - out[3]).abs() < 1e-9, "左右声道错位");
    }

    /// 未知布局必须返回 None，让调用方退回旧行为而不是乱算
    #[test]
    fn unknown_layout_is_rejected() {
        assert!(coeffs_for(1).is_none());
        assert!(coeffs_for(2).is_none());
        assert!(coeffs_for(9).is_none());
        assert!(coeffs_for(6).is_some());
    }

    /// 声道数与系数表必须一一对应（写错索引会静默串声道）
    #[test]
    fn coeff_table_lengths_match() {
        for n in 3..=8usize {
            assert_eq!(coeffs_for(n).unwrap().len(), n, "{n}ch 的系数表长度不对");
        }
    }

    /// 端到端：一个**只有中置声道有信号**的 5.1 FLAC。
    /// ① 直接丢给 rodio 的 2ch mixer ⇒ 输出应当基本是静音（它的声道转换是丢声道，中置被扔掉）
    /// ② 先过我们的 `DownmixSource` ⇒ 左右都必须听得到
    ///
    /// 样本由 ffmpeg 生成（`.build/bench/5.1-center-only.flac`，gitignore 不进仓库），
    /// 缺样本时跳过 —— 与 scanner 里那几条「有样本才跑」的测试同一套做法。生成命令：
    ///   ffmpeg -y -f lavfi -i "aevalsrc=0|0|sin(1000*2*PI*t)|0|0|0:s=48000:d=1:c=5.1" -c:a flac .build/bench/5.1-center-only.flac
    #[test]
    fn center_only_five_one_is_audible_after_downmix() {
        use crate::engine::audio::open_decoder;
        use rodio::mixer::mixer;

        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.build/bench/5.1-center-only.flac");
        if !p.exists() {
            eprintln!("跳过（缺 5.1 样本）");
            return;
        }
        let path = p.to_string_lossy().into_owned();

        fn peak(it: &mut dyn Iterator<Item = f32>) -> f32 {
            it.take(48_000 * 2).fold(0.0f32, |m, s| m.max(s.abs()))
        }

        // ① 现状：6ch 源直接进 2ch mixer（= 修复前用户听到的东西）
        let (m1, mut s1) = mixer(stereo(), rate());
        m1.add(open_decoder(&path).expect("打开 5.1 样本"));
        let dropped = peak(&mut s1);

        // ② 我们先下混再进 mixer
        let (m2, mut s2) = mixer(stereo(), rate());
        let dec = open_decoder(&path).expect("打开 5.1 样本");
        m2.add(DownmixSource::new(dec, 6));
        let kept = peak(&mut s2);

        eprintln!("[test] 直连 rodio 峰值={dropped:.4}  先下混峰值={kept:.4}");
        assert!(dropped < 0.01, "rodio 居然保住了中置？这个测试的前提要重写（peak={dropped}）");
        assert!(kept > 0.2, "下混之后中置仍然听不到（peak={kept}）");
    }
}
