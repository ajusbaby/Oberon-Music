//! 独占输出的「会话层」：采样率策略、音量策略、状态机、传输统计与诊断。
//!
//! 为什么把这些单独拆一层：它们全是**纯逻辑**，不该长在 COM 调用旁边。
//! 拆出来以后有两件事变得可验证：
//!   1. 没有声卡的机器上也能跑单测（策略、增益收敛、计数快照）；
//!   2. 「这次为什么没走成独占」「跑起来有没有欠载」有唯一的事实来源 ——
//!      设备层只负责搬字节，判断与记账都在这里。
//!
//! 三人分工：
//!   engine/audio.rs        决定策略、调用本模块、把结果 publish 给设置页
//!   engine/exclusive.rs    COM 与渲染线程，每写一块就往 TransferStats 记一笔
//!   本模块                 策略枚举 + 计数器 + 诊断快照（零 COM、零 IO）

use super::backend::Fallback;
use serde::Serialize;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// 采样率策略
// ---------------------------------------------------------------------------

/// 独占协商的采样率策略（设置项 exclusiveRate）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RatePolicy {
    /// 跟着曲目走（默认）：曲目率 → 设备共享默认率 → 48000 → 44100。
    ///
    /// 为什么要跟着曲目走：独占的意义就是绕开系统混音器的重采样，
    /// 所以第一候选永远是曲目自己的率；只有设备不认时才往下降。
    Adaptive,
    /// 锁死一个采样率：设备不认就**直接报不可用**，绝不偷偷换一个率。
    ///
    /// 为什么固定模式不许回退：用户选它是为了「我这台 DAC 的时钟只跑 48k」，
    /// 这时候悄悄开成 44.1k 等于把时钟策略做反了 —— 宁可回退共享并说明原因。
    Fixed(u32),
}

impl RatePolicy {
    /// 白名单解析：只有下面几个值被承认，其余一律回落到 Adaptive（默认）。
    /// 脏值不能变成 Fixed(0) —— 那样每次协商都会拿 0 Hz 去问驱动。
    pub fn parse(s: &str) -> Self {
        match s.trim() {
            "44100" => Self::Fixed(44_100),
            "48000" => Self::Fixed(48_000),
            "88200" => Self::Fixed(88_200),
            "96000" => Self::Fixed(96_000),
            _ => Self::Adaptive,
        }
    }

    pub fn as_str(&self) -> String {
        match self {
            Self::Adaptive => "adaptive".to_string(),
            Self::Fixed(r) => r.to_string(),
        }
    }

    /// 这次的采样率候选列表（保序、去重）。
    pub fn candidates(&self, track_rate: Option<u32>, device_default: Option<u32>) -> Vec<u32> {
        match *self {
            Self::Adaptive => adaptive_candidates(track_rate, device_default),
            Self::Fixed(r) => vec![r],
        }
    }

}

/// 自适应候选：曲目率 → 设备共享默认率 → 48000 → 44100。
///
/// 为什么需要「设备共享默认率」这一档：设备原生率往往正是它唯一能独占的率；
/// 而 48000/44100 是最后的兜底（宁可重采样，也不要一点声音都没有）。
pub fn adaptive_candidates(track_rate: Option<u32>, device_default: Option<u32>) -> Vec<u32> {
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

// ---------------------------------------------------------------------------
// 音量策略
// ---------------------------------------------------------------------------

/// 独占音量由谁负责（设置项 exclusiveVolume）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeMode {
    /// 软件音量（默认）：在渲染线程里逐样本乘，听感与共享模式一致。
    Software,
    /// 满幅直通：渲染线程不做任何衰减，音量交给 DAC / 功放 / 系统音量键。
    ///
    /// 为什么留这个选项：独占的意义之一是「数字域一点不碰」，
    /// 软件音量本质上还是一次乘法（虽然 24 位下听不出来）。
    /// 真正受益的场景是外接 DAC 由功放控音量、或者做电平测量。
    Direct,
}

impl VolumeMode {
    pub fn parse(s: &str) -> Self {
        match s.trim() {
            "direct" => Self::Direct,
            _ => Self::Software,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Software => "software",
            Self::Direct => "direct",
        }
    }

    /// 这个模式下真正该乘的增益。
    /// 注意音量 0 仍然要能静音 —— 直通模式下用户把滑块拉到 0 也得停声，
    /// 否则「静音」按钮在独占模式下就失效了。
    pub fn gain(&self, volume: f32) -> f32 {
        let v = volume.clamp(0.0, 1.0);
        match self {
            Self::Software => v,
            Self::Direct => {
                if v <= 0.0 {
                    0.0
                } else {
                    1.0
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 独占会话状态。
///
/// 比「是不是独占」这一个 bool 多出来的信息，正是排查时最缺的那几格：
/// 失败发生时到底在协商、还是在跑起来之后掉的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// 模式是共享 / 自动但还没试过独占
    Disabled,
    /// 试过独占，现在没在用（关闭、切歌、或已回退）
    Idle,
    /// 正在协商格式
    Negotiating,
    /// 正在出声
    Running,
    /// 协商或运行失败（原因见 Failure）
    Failed,
    /// 设备消失（拔出 / 被别的程序抢走）
    Detached,
}

impl SessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Idle => "idle",
            Self::Negotiating => "negotiating",
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Detached => "detached",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Disabled => "未启用独占",
            Self::Idle => "空闲",
            Self::Negotiating => "协商中",
            Self::Running => "运行中",
            Self::Failed => "失败",
            Self::Detached => "设备已断开",
        }
    }
}

/// 失败发生在哪一步 —— 决定给用户的建议（改格式没用 vs 换设备）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// 枚举设备 / 取 IAudioClient
    Open,
    /// 格式校验与 Initialize
    Inspect,
    /// start_stream / 取渲染客户端
    Start,
    /// 已经出声之后的写入失败
    Run,
}

impl Stage {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open => "打开设备",
            Self::Inspect => "格式协商",
            Self::Start => "启动音频流",
            Self::Run => "运行中",
        }
    }
}

/// 一次失败的完整记录：**第一个**原因，不是最后一个。
///
/// 为什么强调「第一个」：后面那些候选格式的失败往往是第一个引起的连锁
/// （对齐失败 → 换格式 → 设备被占），只报最后一个会把排查带偏。
#[derive(Debug, Clone)]
pub struct Failure {
    pub stage: Stage,
    pub kind: Fallback,
    pub detail: String,
}

impl Failure {
    pub fn new(stage: Stage, kind: Fallback, detail: impl Into<String>) -> Self {
        Self { stage, kind, detail: detail.into() }
    }

    /// 给设置页/日志用的一行话
    pub fn describe(&self) -> String {
        format!("{}失败：{}", self.stage.label(), self.kind.hint())
    }
}

// ---------------------------------------------------------------------------
// 传输统计
// ---------------------------------------------------------------------------

/// 渲染线程的记账本。全部是原子量：写的一方是实时线程，读的一方是命令线程。
pub struct TransferStats {
    /// 已写入设备的帧
    frames: AtomicU64,
    /// 「设备没有空位」的次数 —— 说明我们喂得比设备快，缓冲快满了
    zero_space: AtomicU64,
    /// 事件等待超时的次数
    timeouts: AtomicU64,
    /// 连续超时次数（成功后清零），用来判断「是不是真的掉线了」
    consec_timeouts: AtomicU32,
    /// 写设备的错误次数
    write_errors: AtomicU64,
    /// 观察到的最小剩余空间（越大说明越宽松；0 表示从没测到）
    min_free: AtomicU64,
    /// 设备缓冲大小（帧），0 = 未知
    buffer_frames: AtomicU32,
}

impl Default for TransferStats {
    fn default() -> Self {
        Self {
            frames: AtomicU64::new(0),
            zero_space: AtomicU64::new(0),
            timeouts: AtomicU64::new(0),
            consec_timeouts: AtomicU32::new(0),
            write_errors: AtomicU64::new(0),
            // fetch_min 的哨兵值必须是 u64::MAX：若从 0 起算，
            // min(0, 任何值) 恒为 0，「最小剩余空间」这条统计就永远废掉。
            min_free: AtomicU64::new(u64::MAX),
            buffer_frames: AtomicU32::new(0),
        }
    }
}

impl TransferStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn note_buffer(&self, frames: u32) {
        self.buffer_frames.store(frames, Ordering::Relaxed);
    }

    pub fn add_frames(&self, n: u64) {
        self.frames.fetch_add(n, Ordering::Relaxed);
    }

    pub fn note_zero_space(&self) {
        self.zero_space.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_write_error(&self) {
        self.write_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// 记一次事件等待成功（把连续超时归零）
    pub fn note_event(&self) {
        self.consec_timeouts.store(0, Ordering::Relaxed);
    }

    /// 记一次超时，返回连续超时次数
    pub fn note_timeout(&self) -> u32 {
        self.timeouts.fetch_add(1, Ordering::Relaxed);
        self.consec_timeouts.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// 记一次剩余空间（0 不计入最小值：那是「满了」，不代表宽松）
    pub fn note_free(&self, free: u64) {
        if free > 0 {
            self.min_free.fetch_min(free, Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            frames: self.frames.load(Ordering::Relaxed),
            zero_space: self.zero_space.load(Ordering::Relaxed),
            timeouts: self.timeouts.load(Ordering::Relaxed),
            write_errors: self.write_errors.load(Ordering::Relaxed),
            // 从没测到过（哨兵还在）时对外报 0 = 未知，别把 u64::MAX 漏给前端
            min_free_frames: match self.min_free.load(Ordering::Relaxed) {
                u64::MAX => 0,
                v => v,
            },
            buffer_frames: self.buffer_frames.load(Ordering::Relaxed),
        }
    }
}

/// 某一瞬间的计数快照（给诊断用，拷贝出来就不必再持有原子量）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatsSnapshot {
    pub frames: u64,
    pub zero_space: u64,
    pub timeouts: u64,
    pub write_errors: u64,
    pub min_free_frames: u64,
    pub buffer_frames: u32,
}

// ---------------------------------------------------------------------------
// 增益平滑
// ---------------------------------------------------------------------------

/// 独占链路的增益（渲染线程逐样本读，命令线程写）。
///
/// 为什么不直接把音量交给 Player：独占路径里 Player 的输出要经过
/// MixerSource → HallSource → 写设备，Player 的音量乘在混音那一层；
/// 而「满幅直通」要求数字域一点不碰。两套语义混在一起最容易出现
/// 音量被乘两次（0.5 × 0.5 = 0.25，用户听到的比滑块小一半）。
/// 所以独占时 Player 恒为 1.0，真正的增益只在这里。
///
/// 为什么需要平滑：音量滑块是连续的，直接改会听见「咔」的一声（阶跃）。
/// 时间常数 15ms 与 engine/hall.rs 的干湿过渡取同一个值，听感一致。
pub struct GainRamp {
    /// f32 的 bit 表示（原子量存不了 f32）
    target: AtomicU32,
}

impl GainRamp {
    pub fn new(v: f32) -> Arc<Self> {
        Arc::new(Self { target: AtomicU32::new(v.clamp(0.0, 1.0).to_bits()) })
    }

    pub fn set(&self, v: f32) {
        self.target.store(v.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn target(&self) -> f32 {
        f32::from_bits(self.target.load(Ordering::Relaxed))
    }

    /// 一阶平滑系数：每个样本向目标靠近多少。
    /// k = 1 - exp(-1/(tau * rate))；tau 越大越慢。
    pub fn coeff(rate: u32, tau_secs: f32) -> f32 {
        let n = (tau_secs * rate.max(1) as f32).max(1.0);
        1.0 - (-1.0 / n).exp()
    }

    /// 推进一步：cur 向 target 靠近 k。已经足够接近时直接吸附到目标，
    /// 避免浮点在目标附近无限逼近（会一直做乘法，也永远不等于目标）。
    pub fn step(&self, cur: f32, k: f32) -> f32 {
        let target = self.target();
        // 阈值不能取得太紧：f32 在 0.25 附近的 ulp 约 3e-8，而 15ms 时间常数下
        // 单步增量只有 (diff * 1.5e-3)。diff 掉到 1e-5 量级时增量就小于 ulp 了，
        // cur + delta 仍等于 cur —— 结果永远停在离目标 1e-5 的地方，既不吸附也不前进。
        // 1e-4 已经远低于 16bit 的一个量化级（3e-5）的可听意义。
        if (cur - target).abs() < 1e-4 {
            return target;
        }
        cur + (target - cur) * k
    }
}

/// 增益过渡的时间常数（秒）。15ms ≈ 听不出阶跃，又不会让拖动滑块像有延迟。
pub const GAIN_TAU_SECS: f32 = 0.015;

// ---------------------------------------------------------------------------
// 诊断快照
// ---------------------------------------------------------------------------

/// 设置页拿到的诊断（也用于「复制诊断信息」）。
/// 刻意只放**能解释问题**的字段：格式、缓冲、欠载、失败原因各一两条，
/// 不做成全量转储 —— 设置页不是调试面板。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiagnostics {
    /// 状态机当前值（running / degraded / failed …）
    pub state: String,
    /// 状态的中文说明（可直接显示）
    pub state_label: String,
    /// 实际格式，如 44100/24-32；未打开时为 None
    pub format: Option<String>,
    /// 实际采样率
    pub rate: Option<u32>,
    /// 设备缓冲大小（帧）
    pub buffer_frames: u32,
    /// 设备缓冲换算成毫秒（0 = 未知）
    pub buffer_ms: f64,
    /// 已写入帧数
    pub frames: u64,
    /// 「设备没有空位」次数
    pub zero_space: u64,
    /// 事件等待超时次数
    pub timeouts: u64,
    /// 写设备失败次数
    pub write_errors: u64,
    /// 一句话健康度（正常 / 偶发超时 / 有欠载 / 已断开）
    pub health: String,
    /// 失败原因（中文，可直接显示）；没失败时为 None
    pub failure: Option<String>,
}

impl SessionDiagnostics {
    /// 由「谁在跑 + 跑了多久 + 出没出错」拼一条可直接显示的健康度。
    ///
    /// 判断顺序刻意如此：设备都断了就别再说「正常」；
    /// 写错误比超时严重（写了没进去 vs 没等到事件）；超时又比「没有空位」严重
    /// （后者只是我们喂得快，属于正常背压）。
    pub fn health_of(
        state: SessionState,
        zero_space: u64,
        timeouts: u64,
        write_errors: u64,
    ) -> String {
        if state == SessionState::Detached {
            return "设备已断开".to_string();
        }
        if write_errors > 0 {
            return format!("写入失败 {write_errors} 次");
        }
        if timeouts > 0 {
            return format!("事件等待超时 {timeouts} 次");
        }
        if zero_space > 0 {
            return format!("缓冲偏紧（{zero_space} 次无空位）");
        }
        "正常".to_string()
    }

    /// 由状态 + 统计 + 失败记录装配。
    /// rate 参与缓冲毫秒换算，None 时 buffer_ms 记 0（宁可不显示，也不显示错的）。
    pub fn build(
        state: SessionState,
        format: Option<String>,
        rate: Option<u32>,
        snap: &StatsSnapshot,
        failure: Option<&Failure>,
    ) -> Self {
        let buffer_ms = match rate {
            Some(r) if r > 0 && snap.buffer_frames > 0 => {
                (snap.buffer_frames as f64 * 1000.0 / r as f64 * 10.0).round() / 10.0
            }
            _ => 0.0,
        };
        Self {
            state: state.as_str().to_string(),
            state_label: state.label().to_string(),
            format,
            rate,
            buffer_frames: snap.buffer_frames,
            buffer_ms,
            frames: snap.frames,
            zero_space: snap.zero_space,
            timeouts: snap.timeouts,
            write_errors: snap.write_errors,
            health: Self::health_of(state, snap.zero_space, snap.timeouts, snap.write_errors),
            failure: failure.map(|f| {
                if f.detail.is_empty() {
                    f.describe()
                } else {
                    format!("{}（{}）", f.describe(), f.detail)
                }
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adaptive_prefers_track_then_device_then_defaults() {
        // 曲目率第一，重复的不会被写两次
        assert_eq!(
            adaptive_candidates(Some(96_000), Some(48_000)),
            vec![96_000, 48_000, 44_100]
        );
        // 曲目 48k 且设备默认也是 48k：只剩 48k / 44.1k
        assert_eq!(adaptive_candidates(Some(48_000), Some(48_000)), vec![48_000, 44_100]);
        // 什么都不知道时：两档兜底
        assert_eq!(adaptive_candidates(None, None), vec![48_000, 44_100]);
        // 非法值被丢掉
        assert_eq!(adaptive_candidates(Some(0), Some(44_100)), vec![44_100, 48_000]);
    }

    #[test]
    fn fixed_policy_has_exactly_one_candidate() {
        let p = RatePolicy::parse("96000");
        assert_eq!(p, RatePolicy::Fixed(96_000));
        // 固定模式不许回退 —— 候选只有一个，设备不认就是不可用
        assert_eq!(p.candidates(Some(44_100), Some(48_000)), vec![96_000]);
        // 设备给的默认率也盖不过锁定值
        assert_eq!(p.candidates(None, Some(44_100)), vec![96_000]);
        // 脏值 → 自适应（不能变成 Fixed(0)）
        assert_eq!(RatePolicy::parse("nope"), RatePolicy::Adaptive);
        assert_eq!(RatePolicy::parse(""), RatePolicy::Adaptive);
        assert_eq!(RatePolicy::Adaptive.as_str(), "adaptive");
        assert_eq!(p.as_str(), "96000");
    }

    #[test]
    fn volume_mode_gain_keeps_mute_working() {
        assert!((VolumeMode::Software.gain(0.42) - 0.42).abs() < 1e-6);
        // 直通：任何非零音量都是满幅
        assert_eq!(VolumeMode::Direct.gain(0.42), 1.0);
        assert_eq!(VolumeMode::Direct.gain(0.01), 1.0);
        // 但 0 必须仍然静音，否则独占模式下静音键失效
        assert_eq!(VolumeMode::Direct.gain(0.0), 0.0);
        assert_eq!(VolumeMode::parse("direct"), VolumeMode::Direct);
        assert_eq!(VolumeMode::parse("whatever"), VolumeMode::Software);
    }

    #[test]
    fn gain_ramp_converges_and_snaps() {
        let g = GainRamp::new(1.0);
        let k = GainRamp::coeff(44_100, GAIN_TAU_SECS);
        assert!(k > 0.0 && k < 0.01, "15ms 在 44.1k 下的系数应该很小：{k}");

        g.set(0.25);
        let mut cur = 1.0f32;
        // 一个时间常数之后大约走完 63%
        for _ in 0..(GAIN_TAU_SECS * 44_100.0) as usize {
            cur = g.step(cur, k);
        }
        assert!(cur < 0.6 && cur > 0.3, "一个 tau 后应在 0.25~1.0 之间偏下：{cur}");

        // 足够多次之后必须精确等于目标（避免浮点永不到达）
        for _ in 0..200_000 {
            cur = g.step(cur, k);
        }
        assert_eq!(cur, 0.25);
        assert_eq!(g.target(), 0.25);
    }

    #[test]
    fn stats_snapshot_counts_everything() {
        let s = TransferStats::new();
        s.note_buffer(4_096);
        s.add_frames(4_096);
        s.add_frames(4_096);
        s.note_zero_space();
        s.note_free(3_000);
        s.note_free(1_234);
        s.note_free(0); // 满了不算最小值
        let snap = s.snapshot();
        assert_eq!(snap.frames, 8_192);
        assert_eq!(snap.zero_space, 1);
        assert_eq!(snap.min_free_frames, 1_234);
        assert_eq!(snap.buffer_frames, 4_096);
        assert_eq!(snap.timeouts, 0);
    }

    #[test]
    fn consecutive_timeouts_reset_after_a_good_event() {
        let s = TransferStats::new();
        assert_eq!(s.note_timeout(), 1);
        assert_eq!(s.note_timeout(), 2);
        s.note_event();
        assert_eq!(s.note_timeout(), 1);
        assert_eq!(s.snapshot().timeouts, 3);
    }

    #[test]
    fn diagnostics_health_prefers_the_more_serious_signal() {
        let ok = SessionDiagnostics::health_of(SessionState::Running, 0, 0, 0);
        assert_eq!(ok, "正常");
        // 无空位只是背压，文案不能说成故障
        let busy = SessionDiagnostics::health_of(SessionState::Running, 3, 0, 0);
        assert!(busy.contains("缓冲偏紧"), "{busy}");
        // 写错误压过超时
        let bad = SessionDiagnostics::health_of(SessionState::Running, 3, 2, 1);
        assert!(bad.contains("写入失败"), "{bad}");
        // 设备断开压过一切
        let gone = SessionDiagnostics::health_of(SessionState::Detached, 0, 0, 9);
        assert_eq!(gone, "设备已断开");
    }

    #[test]
    fn diagnostics_build_reports_buffer_ms_and_failure() {
        let snap = StatsSnapshot {
            frames: 480,
            buffer_frames: 480,
            zero_space: 0,
            timeouts: 0,
            write_errors: 0,
            min_free_frames: 100,
        };
        let d = SessionDiagnostics::build(
            SessionState::Running,
            Some("48000/24-32".into()),
            Some(48_000),
            &snap,
            None,
        );
        // 480 帧 @48k = 10ms
        assert_eq!(d.buffer_ms, 10.0);
        assert_eq!(d.state, "running");
        assert_eq!(d.state_label, "运行中");
        assert_eq!(d.health, "正常");
        assert!(d.failure.is_none());

        let f = Failure::new(Stage::Inspect, Fallback::UnsupportedFormat, "48k 只能近似支持");
        let d2 = SessionDiagnostics::build(
            SessionState::Failed,
            None,
            Some(48_000),
            &StatsSnapshot::default(),
            Some(&f),
        );
        assert_eq!(d2.state, "failed");
        assert_eq!(d2.buffer_ms, 0.0); // 没有缓冲大小就不编一个出来
        let msg = d2.failure.expect("失败原因必须带上");
        assert!(msg.starts_with("格式协商失败"), "{msg}");
    }
}
