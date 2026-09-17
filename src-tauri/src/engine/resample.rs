//! 采样率转换（重采样）：把解码器输出的采样率换成输出设备（mixer）的采样率。
//!
//! ## 为什么必须自己写一个
//! rodio 0.22 自带的 `SampleRateConverter` 在源码注释里写得很直白：
//! 设备通常固定在 48 kHz，于是库里所有 44.1 kHz 的曲目都被线性插值 —— 这是这个内核
//! 最大的一处音质短板（独占模式按曲目率协商时不会触发，所以只有共享模式/回退时才中招）。
//!
//! ## 算法：有理数多相 windowed-sinc
//! 设 src/dst 约分后为 M/L（互质）。输出第 n 个样本对应输入时间 `t = n·M/L`：
//!   （不加这个提前量的话核只有一半，等于丢掉了插值点右侧的样本，会引入相位失真）；
//! - `w_p[i] = h(i + p/L - D)`，`h(τ) = 2c·sinc(2cτ)·Blackman(τ)`，
//!   `c = pass/src`（相对输入率的归一化截止，pass ≈ 20 kHz 且不超过输出奈奎斯特）；
//! - **每个相位单独归一化到 Σw = 1**：直流增益精确为 1，不会有电平起伏。
//!
//! 抽头数按「过渡带 5.5/taps（Blackman）」反推：`taps = 5.5·src/(nyq - pass)`，
//! 夹在 24..512。44.1k↔48k 约 118 抽头，192k→48k 约 264 抽头。计算量 = dst·taps
//! ≈ 48000×118×2ch ≈ 11M MAC/s，可以忽略。
//!
//! ⚠️ 两条不变量（踩过坑，见 engine/dsd.rs 与 Opus/ADTS 的 current_span_len 修复）：
//! 1. `current_span_len()` 必须返回 Some（当前批次剩余样本数），否则 rodio 混音器的
//!    采样率转换比会沿用上一个音源；
//!    走 `from == to` 的直通分支，不会再叠一层线性插值。

use rodio::source::{SeekError, Source};
use rodio::{ChannelCount, SampleRate};
use std::collections::HashMap;
use std::num::NonZero;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// 每次 refill 产出多少输出帧（span 的粒度）。
/// ⚠️ 这个值决定了音频线程上一次 `produce()` 的**峰值**工作量：produce 是在拉样本的
/// 中间被调用的（独占渲染线程 / cpal 回调），所以峰值大了就是一次卡顿。512 帧 @48k
/// 约 10.7ms 音频，release 下重新采样只要几十微秒，debug 也不过 1ms 级，留足余量。
const BATCH_FRAMES: usize = 512;

/// 多相核：L 个相位，每个相位 taps 个抽头
struct Kernel {
    /// 上采样因子（dst/gcd）
    l: u64,
    /// 下采样因子（src/gcd）
    m: u64,
    taps: usize,
    /// 提前量（输入帧）
    lead: i64,
    /// l × taps，行主序（第 p 相位是 phases[p*taps .. p*taps+taps]）
    phases: Vec<f32>,
}

/// 相位数（= L）—— 只给测试打印用
#[cfg(test)]
fn kernel_phases(src_rate: u32, dst_rate: u32) -> u64 {
    dst_rate as u64 / gcd(src_rate as u64, dst_rate as u64)
}

fn gcd(a: u64, b: u64) -> u64 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a.max(1)
}

/// 设计多相核（见模块注释的公式）
fn build_kernel(src_rate: u32, dst_rate: u32) -> Kernel {
    let g = gcd(src_rate as u64, dst_rate as u64);
    let l = (dst_rate as u64 / g).max(1);
    let m = (src_rate as u64 / g).max(1);
    let src = src_rate as f64;
    // 两个奈奎斯特里更低的那个；再留一点过渡带余量
    let nyq = 0.5 * src_rate.min(dst_rate) as f64;
    let pass = 20_000.0_f64.min(nyq - 500.0).max(0.25 * nyq);
    let trans = (nyq - pass).max(0.02 * src);
    let taps = ((5.5 * src / trans).ceil() as usize).clamp(24, 512);
    let lead = (taps / 2) as i64;
    let half = lead.max(1) as f64;
    let c = pass / src; // 每输入样本的周期数（Nyquist = 0.5）
    let mut phases = vec![0.0f32; l as usize * taps];
    for p in 0..l as usize {
        let f = p as f64 / l as f64;
        let base = p * taps;
        let mut sum = 0.0f64;
        for i in 0..taps {
            let tau = i as f64 + f - lead as f64;
            let x = tau / half; // 窗参数 ∈ [-1, 1]
            if x.abs() >= 1.0 {
                continue;
            }
            // Blackman 窗（对称，中心在 tau = 0）
            let w = 0.42
                + 0.5 * (std::f64::consts::PI * x).cos()
                + 0.08 * (2.0 * std::f64::consts::PI * x).cos();
            // 理想带限插值核 2c·sinc(2c·tau)
            let z = 2.0 * c * tau;
            let s = if z.abs() < 1e-12 {
                1.0
            } else {
                (std::f64::consts::PI * z).sin() / (std::f64::consts::PI * z)
            };
            let v = 2.0 * c * s * w;
            phases[base + i] = v as f32;
            sum += v;
        }
        // 逐相位归一化：直流增益恒为 1（否则会有缓慢的电平起伏）
        if sum.abs() > 1e-12 {
            let inv = (1.0 / sum) as f32;
            for i in 0..taps {
                phases[base + i] *= inv;
            }
        }
    }
    Kernel { l, m, taps, lead, phases }
}

/// 按 (src, dst) 缓存设计好的多相核：同一对采样率只建一次表。
///
/// 为什么值得缓存：表最大 302KB（44.1k→192k，640 个相位），建表要算几万个 sinc 值，
/// release 下约 1ms、debug 下十几毫秒 —— 每首歌都重算一次没有意义。
/// 库里的曲目采样率种类是有限的，缓存项数自然很少。
fn cached_kernel(src: u32, dst: u32) -> Arc<Kernel> {
    static CACHE: OnceLock<Mutex<HashMap<(u32, u32), Arc<Kernel>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    // 中毒也不能崩：音频路径宁可继续算，也不要 panic
    let mut g = cache.lock().unwrap_or_else(|e| e.into_inner());
    g.entry((src, dst))
        .or_insert_with(|| Arc::new(build_kernel(src, dst)))
        .clone()
}

/// 把 `src` 的采样率换成 `dst_rate` 的交错 f32 音源。
///
/// ⚠️ `dst_rate` 必须与 mixer 的采样率一致，否则 rodio 还会再叠一层线性插值。
pub struct ResamplerSource<S> {
    inner: S,
    channels: usize,
    dst_rate: u32,
    kernel: Arc<Kernel>,
    /// 输入环形缓冲：cap 是 2 的幂，按帧交错存放
    ring: Vec<f32>,
    mask: usize,
    /// 已经读进 ring 的帧数（帧下标 0..have 有效）
    have: u64,
    ended: bool,
    /// 下一个要产出的输出下标
    n: u64,
    /// 当前批次的交错输出
    out: Vec<f32>,
    out_pos: usize,
}

impl<S: Source<Item = f32>> ResamplerSource<S> {
    pub fn new(inner: S, dst_rate: u32) -> Self {
        let src_rate = inner.sample_rate().get();
        let channels = inner.channels().get() as usize;
        let kernel = cached_kernel(src_rate, dst_rate);
        let cap = kernel.taps.max(2).next_power_of_two();
        Self {
            inner,
            channels: channels.max(1),
            dst_rate,
            ring: vec![0.0; cap * channels.max(1)],
            mask: cap - 1,
            kernel,
            have: 0,
            ended: false,
            n: 0,
            out: Vec::with_capacity(BATCH_FRAMES * channels.max(1)),
            out_pos: 0,
        }
    }

    /// 保证帧 0..=upto 都已读进 ring（读不到就置 ended）
    fn ensure(&mut self, upto: u64) {
        let ch = self.channels;
        while !self.ended && self.have <= upto {
            let slot = (self.have as usize & self.mask) * ch;
            let mut ok = true;
            for c in 0..ch {
                match self.inner.next() {
                    Some(s) => self.ring[slot + c] = s,
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                self.have += 1;
            } else {
                self.ended = true;
            }
        }
    }

    fn reset(&mut self) {
        self.have = 0;
        self.ended = false;
        self.n = 0;
        self.out.clear();
        self.out_pos = 0;
        self.ring.iter_mut().for_each(|v| *v = 0.0);
    }

    /// 产出下一批输出；返回 false = 真的结束了
    fn produce(&mut self) -> bool {
        self.out.clear();
        self.out_pos = 0;
        let ch = self.channels;
        let taps = self.kernel.taps;
        let lead = self.kernel.lead;
        let target = BATCH_FRAMES * ch;
        while self.out.len() < target {
            let t = self.n * self.kernel.m;
            let p = (t % self.kernel.l) as usize;
            let q = (t / self.kernel.l) as i64;
            let hi = q + lead; // 窗口最新用到的输入帧
            let lo = hi - taps as i64 + 1; // 最旧用到的输入帧
            if hi >= 0 {
                self.ensure(hi as u64);
            }
            // 窗口里没有任何可用输入：只有「已经结束」才会发生 ⇒ 收工。
            // ⚠️ 必须在这里判定（而不是只看 lo >= have）：空输入时 hi > have 且 lo < 0，
            //    光看 lo 会一直吐 0，永不结束。
            let start = lo.max(0);
            let end = hi.min(self.have as i64 - 1);
            if end < start {
                break;
            }
            let base = p * taps;
            for c in 0..ch {
                let (mut a0, mut a1, mut a2, mut a3) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
                let mut f = end;
                while f - 3 >= start {
                    let i0 = (hi - f) as usize;
                    a0 += self.kernel.phases[base + i0]
                        * self.ring[((f as usize) & self.mask) * ch + c];
                    a1 += self.kernel.phases[base + i0 + 1]
                        * self.ring[(((f - 1) as usize) & self.mask) * ch + c];
                    a2 += self.kernel.phases[base + i0 + 2]
                        * self.ring[(((f - 2) as usize) & self.mask) * ch + c];
                    a3 += self.kernel.phases[base + i0 + 3]
                        * self.ring[(((f - 3) as usize) & self.mask) * ch + c];
                    f -= 4;
                }
                while f >= start {
                    let i0 = (hi - f) as usize;
                    a0 += self.kernel.phases[base + i0]
                        * self.ring[((f as usize) & self.mask) * ch + c];
                    f -= 1;
                }
                self.out.push((a0 + a1) + (a2 + a3));
            }
            self.n += 1;
        }
        !self.out.is_empty()
    }
}

impl<S: Source<Item = f32>> Iterator for ResamplerSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        while self.out_pos >= self.out.len() {
            if !self.produce() {
                return None;
            }
        }
        let s = self.out[self.out_pos];
        self.out_pos += 1;
        Some(s)
    }
}

impl<S: Source<Item = f32>> Source for ResamplerSource<S> {
    /// ⚠️ 必须返回 Some：见 engine/dsd.rs 里 current_span_len 那段说明
    fn current_span_len(&self) -> Option<usize> {
        Some((self.out.len() - self.out_pos).max(1))
    }

    fn channels(&self) -> ChannelCount {
        NonZero::new(self.channels as u16).unwrap_or(NonZero::new(2).expect("2 非零"))
    }

    fn sample_rate(&self) -> SampleRate {
        NonZero::new(self.dst_rate).unwrap_or(NonZero::new(44_100).expect("44.1k 非零"))
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    /// 先让内层定位到目标，再把重采样状态整体重来（否则会把定位前的样本当历史）
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)?;
        self.reset();
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 内存里的测试音源
    struct TestSource {
        data: Vec<f32>,
        pos: usize,
        ch: u16,
        rate: u32,
    }

    impl TestSource {
        fn new(data: Vec<f32>, ch: u16, rate: u32) -> Self {
            Self { data, pos: 0, ch, rate }
        }
    }

    impl Iterator for TestSource {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            let s = self.data.get(self.pos).copied();
            self.pos += 1;
            s
        }
    }

    impl Source for TestSource {
        fn current_span_len(&self) -> Option<usize> {
            Some((self.data.len() - self.pos).max(1))
        }
        fn channels(&self) -> ChannelCount {
            NonZero::new(self.ch).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            NonZero::new(self.rate).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
        fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
            let frame = (pos.as_secs_f64() * self.rate as f64) as usize * self.ch as usize;
            self.pos = frame.min(self.data.len());
            Ok(())
        }
    }

    /// Goertzel：某个频率的幅度（正弦幅度 A 的输入应读出 ≈ A）
    fn amp(samples: &[f32], rate: f32, freq: f32) -> f32 {
        let n = samples.len();
        if n == 0 {
            return 0.0;
        }
        let w = 2.0 * std::f32::consts::PI * freq / rate;
        let coeff = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &v in samples {
            let s0 = v + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        ((s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0)).sqrt() * 2.0 / n as f32
    }

    fn sine(rate: u32, seconds: f32, freq: f32, a: f32) -> Vec<f32> {
        let n = (rate as f32 * seconds) as usize;
        (0..n)
            .map(|i| a * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    fn mid(v: &[f32]) -> &[f32] {
        &v[v.len() / 4..v.len() * 3 / 4]
    }

    /// 44.1k → 48k：频率、电平、时长都要对
    #[test]
    fn keeps_frequency_and_level() {
        let (sr, dr) = (44_100u32, 48_000u32);
        let out: Vec<f32> =
            ResamplerSource::new(TestSource::new(sine(sr, 1.0, 1_000.0, 0.5), 1, sr), dr).collect();
        let secs = out.len() as f64 / dr as f64;
        eprintln!("[test] 44.1k→48k 1s 正弦：{} 样本 = {secs:.5}s", out.len());
        assert!((secs - 1.0).abs() < 0.005, "时长漂了：{secs}");
        let m = mid(&out);
        let a1 = amp(m, dr as f32, 1_000.0);
        let a9 = amp(m, dr as f32, 900.0);
        let a11 = amp(m, dr as f32, 1_100.0);
        eprintln!("[test] 幅度 1k={a1:.4} 900={a9:.4} 1.1k={a11:.4}");
        assert!((a1 - 0.5).abs() < 0.02, "电平不对（期望 0.5）：{a1}");
        assert!(a1 > 50.0 * a9 && a1 > 50.0 * a11, "频率不对");
    }

    /// 下采样抗混叠：96k→48k 的 30kHz 会被折叠到 18kHz，必须压下去
    /// （对照组是 rodio 自带的转换器：它直接丢样本、不滤波，必然折叠）
    #[test]
    fn suppresses_alias_on_downsample() {
        let (sr, dr) = (96_000u32, 48_000u32);
        let data = sine(sr, 0.5, 30_000.0, 1.0);
        let out: Vec<f32> =
            ResamplerSource::new(TestSource::new(data.clone(), 1, sr), dr).collect();
        let new_alias = amp(mid(&out), dr as f32, 18_000.0);
        let old: Vec<f32> = rodio::conversions::SampleRateConverter::new(
            data.iter().copied(),
            NonZero::new(sr).unwrap(),
            NonZero::new(dr).unwrap(),
            NonZero::new(1).unwrap(),
        )
        .collect();
        let old_alias = amp(mid(&old), dr as f32, 18_000.0);
        eprintln!(
            "[test] 30kHz 下采样后的 18kHz 混叠：新的 {new_alias:.5}   rodio 旧的 {old_alias:.5}（满幅=1.0）"
        );
        assert!(new_alias < 0.001, "混叠没压住：{new_alias}");
        assert!(old_alias > 0.5, "对照组没测出混叠，这条测试就没意义了：{old_alias}");
        assert!(new_alias * 1000.0 < old_alias, "新旧差距不够大");
    }

    /// 上采样去镜像：44.1k→48k 的 15kHz 镜像在 29.1kHz，折回 18.9kHz
    #[test]
    fn suppresses_image_on_upsample() {
        let (sr, dr) = (44_100u32, 48_000u32);
        let out: Vec<f32> =
            ResamplerSource::new(TestSource::new(sine(sr, 0.5, 15_000.0, 1.0), 1, sr), dr).collect();
        let m = mid(&out);
        let sig = amp(m, dr as f32, 15_000.0);
        let img = amp(m, dr as f32, 48_000.0 - 29_100.0);
        eprintln!("[test] 15kHz 直通 {sig:.4}，镜像(18.9kHz) {img:.5}");
        assert!(sig > 0.95, "信号被削了：{sig}");
        assert!(img < 0.005, "镜像没压住：{img}");
    }

    /// 直流增益必须精确为 1（逐相位归一化的意义所在）
    #[test]
    fn preserves_dc_gain() {
        let (sr, dr) = (44_100u32, 48_000u32);
        let out: Vec<f32> = ResamplerSource::new(
            TestSource::new(vec![1.0f32; sr as usize], 1, sr),
            dr,
        )
        .collect();
        let m = mid(&out);
        let mean = m.iter().sum::<f32>() / m.len() as f32;
        eprintln!("[test] 直流增益 = {mean:.7}（期望 1.0）");
        assert!((mean - 1.0).abs() < 1e-3, "直流增益不对：{mean}");
    }

    /// 成本表：常见「曲目采样率 → 设备采样率」组合的**建表耗时**与**吞吐**。
    /// 两条都要看：建表发生在装载曲目的引擎线程上（每首一次），吞吐发生在音频线程上。
    #[test]
    fn cost_table_common_pairs() {
        let floor = if cfg!(debug_assertions) { 2.0 } else { 20.0 };
        for (sr, dr) in [
            (44_100u32, 44_100u32),
            (44_100, 48_000),
            (44_100, 96_000),
            (44_100, 192_000),
            (48_000, 192_000),
            (96_000, 192_000),
            (48_000, 44_100),
            (96_000, 48_000),
        ] {
            if sr == dr {
                continue;
            }
            // 直接量未缓存的建表成本（生产里同一对采样率只建一次，见 cached_kernel）
            let t_build = std::time::Instant::now();
            let _k = build_kernel(sr, dr);
            let build_ms = t_build.elapsed().as_secs_f64() * 1000.0;
            let mut r = ResamplerSource::new(TestSource::new(vec![0.0f32; sr as usize], 1, sr), dr);
            let t0 = std::time::Instant::now();
            let n = r.by_ref().count();
            let wall = t0.elapsed().as_secs_f64();
            let secs = n as f64 / dr as f64;
            let x = secs / wall.max(1e-9);
            eprintln!(
                "[test] {sr:>6} → {dr:>6} Hz：建表 {build_ms:6.2}ms，吞吐 {x:6.0}× 实时（1s 音频，单声道，L={} phases）",
                kernel_phases(sr, dr)
            );
            assert!(x > floor, "{sr}→{dr} 太慢了：{x:.1}× 实时（下限 {floor}）");
        }
    }

    /// 串到 rodio 混音器上：混音器在 48k，我们喂 48k —— rodio 必须走直通、不再叠一层线性插值
    #[test]
    fn works_through_rodio_mixer() {
        let (sr, dr) = (44_100u32, 48_000u32);
        let (mixer, mut out) =
            rodio::mixer::mixer(NonZero::new(1).unwrap(), NonZero::new(dr).unwrap());
        let player = rodio::Player::connect_new(&mixer);
        player.append(ResamplerSource::new(
            TestSource::new(sine(sr, 1.0, 1_000.0, 0.5), 1, sr),
            dr,
        ));
        let buf: Vec<f32> = out.by_ref().take(dr as usize).collect();
        let a1 = amp(&buf[dr as usize / 8..dr as usize * 7 / 8], dr as f32, 1_000.0);
        eprintln!("[test] 经 rodio 混音器（1ch/48k）后 1kHz 幅度 = {a1:.4}（期望 0.5）");
        assert!((a1 - 0.5).abs() < 0.03, "混音器链路电平不对：{a1}");
    }

    /// 十秒长流不能累积漂移；顺带记一下真实计算成本
    #[test]
    fn long_stream_does_not_drift() {
        let (sr, dr) = (44_100u32, 48_000u32);
        let t0 = std::time::Instant::now();
        let n = ResamplerSource::new(TestSource::new(vec![0.0f32; sr as usize * 10], 1, sr), dr)
            .count();
        let wall = t0.elapsed().as_secs_f64();
        let secs = n as f64 / dr as f64;
        eprintln!(
            "[test] 10s 空输入：{n} 样本 = {secs:.5}s；重采样耗时 {:.3}s（{:.0}× 实时）",
            wall,
            secs / wall.max(1e-9)
        );
        assert!((secs - 10.0).abs() < 0.01, "漂移太大：{secs}");
    }

    /// 空输入必须立刻结束（不能无限吐 0）
    #[test]
    fn empty_input_ends() {
        let n = ResamplerSource::new(TestSource::new(Vec::new(), 1, 44_100), 48_000).count();
        eprintln!("[test] 空输入产出 {n} 个样本");
        assert!(n < 1000, "空输入不该产出这么多：{n}");
    }

    /// seek：转发给内层并清掉重采样状态
    #[test]
    fn seek_resets_state() {
        let (sr, dr) = (44_100u32, 48_000u32);
        let mut r = ResamplerSource::new(TestSource::new(sine(sr, 1.0, 1_000.0, 0.5), 1, sr), dr);
        let _ = (&mut r).take(dr as usize / 4).count();
        r.try_seek(Duration::from_millis(500)).expect("seek");
        let rest: Vec<f32> = r.collect();
        let secs = rest.len() as f64 / dr as f64;
        eprintln!("[test] seek 到 0.5s 后剩余 {secs:.4}s");
        assert!((secs - 0.5).abs() < 0.01, "seek 之后时长不对：{secs}");
        assert!(amp(mid(&rest), dr as f32, 1_000.0) > 0.4, "seek 之后信号不对");
    }
}