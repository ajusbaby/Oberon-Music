//! 「空间音效」：总线混响（Freeverb）
//!
//! 定位
//! - 挂在**输出总线**上的全局混响，不是逐曲效果：所有曲目、切歌、无缝衔接都共用一条
//!   混响尾巴，听起来才像「同一个厅里在放」，而不是每首歌各开一间房。
//! - 开关 = 这条总线在不在。与 Salt Player 的 MAX Audio 里那条总线混响同一套算法
//!   （BASS_FX_BFX_FREEVERB），参数做了收敛（见 HallMode 的注释）。
//!
//! 链路
//! ```text
//! Player ──► bus(Mixer) ──► HallSource(Freeverb) ──► 设备
//!                    ▲
//!        Zero 源（保活：MixerSource 无源时会直接结束迭代）
//! ```
//! 共享后端把 HallSource 塞进 MixerDeviceSink 自带的 mixer；独占后端把它交给
//! ExclusiveSink 的渲染线程。两条路径拿到的是**同一条** bus，所以听感一致。
//!
//! 为什么自己实现而不是引入 crate
//! - Freeverb 本体不到 200 行，且必须精确控制「一直以某个采样率跑、参数可平滑变化、
//!   关闭后彻底透传」这三件事；现成 crate 都以「一次性对齐的 buffer 处理」为前提。
//! - 延迟线长度必须随采样率缩放，否则 48k / 96k 下混响时间会明显变短。
//!
//! 实时安全
//! - 所有延迟线在构造时就分配好，处理过程中**没有内存分配**、没有锁、没有日志。
//! - 参数通过 HallControl（原子量）跨线程传入，在音频线程里做一阶平滑，避免拉链噪声。

use rodio::source::Source;
use rodio::{ChannelCount, SampleRate};
use std::num::NonZero;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

/// Freeverb 的输入衰减。定值，作用是让 8 路 comb 叠加后不溢出、也让人声不被埋掉。
const FIXED_GAIN: f32 = 0.015;
/// 全通滤波器的反馈系数，Freeverb 原值。
const ALLPASS_FEEDBACK: f32 = 0.5;
/// 右声道延迟线的额外偏移（样本），拉开左右去相关。
const STEREO_SPREAD: usize = 23;
/// Freeverb 的调音基准采样率：下面的延迟长度都是在这个采样率下标定的。
const TUNING_RATE: f32 = 44_100.0;
/// 8 路 comb 的基准长度（样本）。combs 的串联和给出梳状密度。
const COMB_TUNING: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
/// 4 级全通串联的基准长度（样本），负责把梳状扩散成平滑的尾巴。
const ALLPASS_TUNING: [usize; 4] = [556, 441, 341, 225];

/// 参数平滑的时间常数（秒）。约 3 倍常数即听不出过渡，同时快到让开关显得「立刻」。
const SMOOTH_SECS: f32 = 0.015;

/// 湿声电平校准。
///
/// 文档里那套 0.75 是 BASS_FX 自己的尺度，直接当线性 wet 增益用会整体过载：
/// 拿库里三首接近满刻度的素材实测，wet=0.66 时 RMS 比旁路高 2.3 dB、峰值高 6.6 dB
/// （也就是必然削波）。×0.45 之后 RMS 与旁路差在 0.1 dB 以内。
const WET_GAIN_TRIM: f32 = 0.45;

/// 混响发送端的高通拐点（Hz，两级一阶串联 = 12 dB/oct）。
///
/// Freeverb 的 comb 是宽带谐振器，几十赫兹的能量进去后会以梳状驻波的形式叠出来。
/// 低频重的母带（库里最重的那首 &lt;45 Hz 到 -11 dBFS，比第二名重 4 dB）听感就是
/// 持续的低频嗡鸣 —— 也就是常说的「这首歌有电音」。混响本来也不该负责次低频：
/// 现场录音里这个频段多半已经被话筒和房间吃掉了。
///
/// 只高通**送进混响**的那一路；干声（dry）不经过它，仍然逐位透传。
const SEND_HIGHPASS_HZ: f32 = 120.0;

/// 混音后的软限幅拐点。
///
/// 混响是能量叠加，即使 RMS 已经对齐，母带压缩过的流行歌峰值仍会冲出 0 dBFS
/// 两三个 dB。硬削波听感上就是「开混响有破音」，所以用一段 tanh 过渡把峰值兜住。
///
/// 拐点取 0.92 而不是更低：拐点每低一点，进入非线性区的采样就更多、互调更重。
/// 实测库内那首低频密集的歌在 0.85 时有 4.0% 的采样被压过，0.92 后降到 1% 出头；
/// 而 tanh 段的渐近上限是 1.0（实际峰值 ≤ 0.981），仍然兜得住，不会越 0 dBFS。
const LIMIT_KNEE: f32 = 0.92;

#[inline]
fn soft_limit(x: f32) -> f32 {
    let a = x.abs();
    if a <= LIMIT_KNEE {
        return x;
    }
    let span = 1.0 - LIMIT_KNEE;
    let y = LIMIT_KNEE + span * ((a - LIMIT_KNEE) / span).tanh();
    if x < 0.0 {
        -y
    } else {
        y
    }
}

/// 峰值 → 统一的线性增益（立体声联动）。
///
/// 左右各自过 soft_limit 时，两声道被压的程度不同，每次低频冲击都会让声像往一侧歪，
/// 听感比轻微过载更脏。所以先取两声道的最大峰值算出一个增益，再整帧乘回去。
#[inline]
fn limit_gain(peak: f32) -> f32 {
    if peak <= LIMIT_KNEE || peak <= 0.0 {
        return 1.0;
    }
    soft_limit(peak) / peak
}

/// 混响档位（设置项 concertHall 的取值）。
///
/// 只有开 / 关两态：这项功能的定位是「一键换个空间」，不是给人调五个互相牵制的参数。
/// 开启后统一使用一条约 4 秒的厅，全曲共用一个，切歌不断尾巴。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HallMode {
    /// 关闭（总线透传，零 DSP 开销）
    Off,
    /// 开启
    On,
}

impl HallMode {
    pub fn parse(s: &str) -> Self {
        // 只有显式的 "on" 才算开启 —— 默认必须是干声。
        // 早期版本存过 soft / standard / original 三个档位名，那是当时「默认打开」写进库的取值、
        // 不是用户主动选的；一并按关闭处理，避免升级后一进应用就自带混响。
        match s {
            "on" => Self::On,
            _ => Self::Off,
        }
    }

    /// 设置项里存的字符串（目前只给单测与日志用）
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
        }
    }

    /// 是否开启（混响真正参与处理）
    #[allow(dead_code)]
    pub fn enabled(self) -> bool {
        !matches!(self, Self::Off)
    }

    fn code(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::On => 1,
        }
    }

    fn from_code(v: u8) -> Self {
        match v {
            1 => Self::On,
            _ => Self::Off,
        }
    }

    /// 该档位的目标参数；关闭时返回 None（表示「往 OFF 平滑」）。
    pub fn params(self) -> Option<HallParams> {
        match self {
            Self::Off => None,
            Self::On => Some(HallParams::ON),
        }
    }
}

impl Default for HallMode {
    fn default() -> Self {
        Self::Off
    }
}

/// Freeverb 的五个控制量，取值范围都是 0..=1，语义与 BASS_FX 的同名字段一致。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HallParams {
    /// 房间大小 → comb 反馈量（0.90 ≈ 3.5 秒 RT60）
    pub room: f32,
    /// 高频阻尼 → comb 内的一阶低通
    pub damp: f32,
    /// 湿声（混响声）增益
    pub wet: f32,
    /// 干声（直达声）增益
    pub dry: f32,
    /// 立体声宽度：0 = 左右完全相同，1 = 最大去相关
    pub width: f32,
}

impl HallParams {
    /// 开启态：约 4 秒的厅。
    ///
    /// 五个量在参考实现（room 0.90 / damp 0.40 / wet 0.75 / dry 0.85 / width 0.75）附近
    /// 各偏了一点点 —— 听感仍是同一个空间，数值不再与原版逐位相同：
    /// - room 0.90 → 0.91：厅再长一线，尾巴更自然地落下去
    /// - damp 0.40 → 0.43：高频多衰减一点，room 变大后不至于浑成一片
    /// - wet 0.75 → 0.72：湿声略退，人声不容易发虚
    /// - dry 0.85 → 0.87：干声多留一点，结像靠前
    /// - width 0.75 → 0.78：左右展开再宽一点
    pub const ON: Self = Self { room: 0.91, damp: 0.43, wet: 0.72, dry: 0.87, width: 0.78 };

    /// 关闭态。dry 必须是 1.0 —— 关闭混响时用户听到的应当是逐位一致的原始信号。
    pub const OFF: Self = Self { room: 0.91, damp: 0.43, wet: 0.0, dry: 1.0, width: 0.78 };
}

/// 跨线程的档位开关：引擎线程写，音频线程读。
///
/// 为什么不用 Mutex：音频线程每帧都要读一次，任何可能阻塞的同步原语都不该出现在
/// 采样循环里。一个 Relaxed 的 u8 足够 —— 位置关系无所谓，读到旧值最多晚一帧生效。
pub struct HallControl {
    mode: AtomicU8,
}

impl HallControl {
    pub fn new(mode: HallMode) -> Self {
        Self { mode: AtomicU8::new(mode.code()) }
    }

    pub fn set(&self, mode: HallMode) {
        self.mode.store(mode.code(), Ordering::Relaxed);
    }

    pub fn mode(&self) -> HallMode {
        HallMode::from_code(self.mode.load(Ordering::Relaxed))
    }
}

impl Default for HallControl {
    fn default() -> Self {
        Self::new(HallMode::Off)
    }
}

/// 梳状滤波器：带阻尼反馈的延迟线。
struct Comb {
    buf: Vec<f32>,
    idx: usize,
    /// 阻尼低通的状态量（Freeverb 的 filterstore）
    store: f32,
    feedback: f32,
    damp1: f32,
    damp2: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], idx: 0, store: 0.0, feedback: 0.0, damp1: 0.0, damp2: 1.0 }
    }

    #[inline]
    fn tune(&mut self, feedback: f32, damp1: f32) {
        self.feedback = feedback;
        self.damp1 = damp1;
        self.damp2 = 1.0 - damp1;
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let out = self.buf[self.idx];
        // 一阶低通：越靠后的高频衰减越多，模拟空气与墙面吸收
        self.store = out * self.damp2 + self.store * self.damp1;
        self.buf[self.idx] = x + self.store * self.feedback;
        self.idx += 1;
        if self.idx == self.buf.len() {
            self.idx = 0;
        }
        out
    }

    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.store = 0.0;
        self.idx = 0;
    }
}

/// 全通滤波器：只改相位不改幅度，把离散的梳状峰抹平。
struct Allpass {
    buf: Vec<f32>,
    idx: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], idx: 0 }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let bufout = self.buf[self.idx];
        let out = -x + bufout;
        self.buf[self.idx] = x + bufout * ALLPASS_FEEDBACK;
        self.idx += 1;
        if self.idx == self.buf.len() {
            self.idx = 0;
        }
        out
    }

    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.idx = 0;
    }
}

/// 两级一阶高通（12 dB/oct），用作混响发送的次低频切除。
///
/// 用一阶节而不是 biquad：这里只要斜率不要相位精度，两个 one-pole 级联就够，
/// 而且每样本只有两乘两加，48 kHz 下完全可以忽略。
struct SendHighpass {
    a: f32,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

impl SendHighpass {
    fn new(rate: f32, hz: f32) -> Self {
        // 一阶高通 y = a·(y + x - x_prev)，a = 1 / (1 + 2πf·T)：拐点处约 -3 dB
        let w = std::f32::consts::TAU * hz / rate.max(1.0);
        Self { a: 1.0 / (1.0 + w), x1: 0.0, y1: 0.0, x2: 0.0, y2: 0.0 }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        self.y1 = self.a * (self.y1 + x - self.x1);
        self.x1 = x;
        self.y2 = self.a * (self.y2 + self.y1 - self.x2);
        self.x2 = self.y1;
        self.y2
    }

    fn clear(&mut self) {
        self.x1 = 0.0;
        self.y1 = 0.0;
        self.x2 = 0.0;
        self.y2 = 0.0;
    }
}

/// Freeverb 本体（立体声，左 8 comb + 4 allpass，右同样但延迟线整体后移 STEREO_SPREAD）。
struct Freeverb {
    combs_l: Vec<Comb>,
    combs_r: Vec<Comb>,
    aps_l: Vec<Allpass>,
    aps_r: Vec<Allpass>,
    wet1: f32,
    wet2: f32,
    dry: f32,
    /// 建延迟线时用的采样率。阻尼是一阶低通，系数按样本计，
    /// 必须按它做时间常数归一化（见 set_params）。
    rate: f32,
    /// 送进混响之前的次低频切除（见 SEND_HIGHPASS_HZ）。只作用于湿声路径。
    send_hp: SendHighpass,
}

impl Freeverb {
    /// 按采样率建延迟线。长度按 rate/44100 缩放，保证 44.1k / 48k / 96k 的混响时间一致。
    fn new(rate: u32) -> Self {
        let rate = if rate == 0 { 44_100 } else { rate };
        let combs_l = COMB_TUNING.iter().map(|&t| Comb::new(scaled_len(t, 0, rate))).collect();
        let combs_r = COMB_TUNING.iter().map(|&t| Comb::new(scaled_len(t, STEREO_SPREAD, rate))).collect();
        let aps_l = ALLPASS_TUNING.iter().map(|&t| Allpass::new(scaled_len(t, 0, rate))).collect();
        let aps_r = ALLPASS_TUNING.iter().map(|&t| Allpass::new(scaled_len(t, STEREO_SPREAD, rate))).collect();
        let send_hp = SendHighpass::new(rate as f32, SEND_HIGHPASS_HZ);
        Self { combs_l, combs_r, aps_l, aps_r, wet1: 0.0, wet2: 0.0, dry: 1.0, rate: rate as f32, send_hp }
    }

    fn set_params(&mut self, p: HallParams) {
        // BASS → Freeverb 的换算：反馈量 = room * 0.28 + 0.7（与 BASS_FX 的实现一致）
        let feedback = (p.room.clamp(0.0, 1.0) * 0.28 + 0.70).clamp(0.0, 0.98);
        // damp 的 0.4 系数同样来自 BASS_FX：它在 0..1 上只用到 0..0.4 这段
        let damp_ref = (p.damp.clamp(0.0, 1.0) * 0.4).clamp(0.0, 0.999);
        // ⚠️ 阻尼修正（原版 Freeverb 没有这一步）：低通系数是按**样本**计的时间常数，
        // 同一个 damp1 在 48k 下每圈要处理 9% 更多的样本、多衰减 9%，尾巴就会变短。
        // 这里按 44.1k 定标做幂次换算，让「每单位时间的高频损失」与采样率无关 ——
        // 否则同一首歌在 44.1k 声卡和 96k 声卡上会听到不同的混响长度。
        let damp1 = if damp_ref <= 0.0 { 0.0 } else { damp_ref.powf(TUNING_RATE / self.rate) };
        for c in self.combs_l.iter_mut().chain(self.combs_r.iter_mut()) {
            c.tune(feedback, damp1);
        }
        // 湿声再走一遍电平校准（见 WET_GAIN_TRIM）：预设里写的是 BASS 尺度的原始数值，
        // 便于和文档逐项对照，真正进滤波器的增益在这里统一拉回可听范围。
        let wet = p.wet.max(0.0) * WET_GAIN_TRIM;
        let width = p.width.clamp(0.0, 1.0);
        // width = 1 时 wet2 = 0（纯去相关）；width = 0 时左右同源
        self.wet1 = 0.5 * wet * (1.0 + width);
        self.wet2 = 0.5 * wet * (1.0 - width);
        self.dry = p.dry.max(0.0);
    }

    #[inline]
    fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        // 左右先求和再进混响：这是 Freeverb 的设计（单声道激励 + 立体声输出），
        // 也顺手保证了「Width = 0 时左右完全相同」这条验收标准。
        // 旁路态（关档：湿声 0、干声 1）不进限幅也不跑滤波：满刻度信号必须逐位原样出去
        if self.wet1 == 0.0 && self.wet2 == 0.0 && self.dry == 1.0 {
            return (l, r);
        }

        // 先切掉次低频再进 comb：低频重的母带否则会把 38–120 Hz 的驻波叠满整个尾巴。
        let input = self.send_hp.process(l + r) * FIXED_GAIN;

        let mut wet_l = 0.0;
        for c in self.combs_l.iter_mut() {
            wet_l += c.process(input);
        }
        let mut wet_r = 0.0;
        for c in self.combs_r.iter_mut() {
            wet_r += c.process(input);
        }
        for a in self.aps_l.iter_mut() {
            wet_l = a.process(wet_l);
        }
        for a in self.aps_r.iter_mut() {
            wet_r = a.process(wet_r);
        }

        // 先算未限幅的两声道，再用共同的峰值取同一个增益（见 limit_gain）：
        // 立体声联动，限幅时声像不抖。
        let pre_l = self.dry * l + self.wet1 * wet_l + self.wet2 * wet_r;
        let pre_r = self.dry * r + self.wet1 * wet_r + self.wet2 * wet_l;
        let g = limit_gain(pre_l.abs().max(pre_r.abs()));
        (pre_l * g, pre_r * g)
    }

    fn clear(&mut self) {
        for c in self.combs_l.iter_mut().chain(self.combs_r.iter_mut()) {
            c.clear();
        }
        for a in self.aps_l.iter_mut().chain(self.aps_r.iter_mut()) {
            a.clear();
        }
        self.send_hp.clear();
    }
}

/// 基准延迟长度 → 实际长度（按采样率缩放）。
fn scaled_len(tuning: usize, spread: usize, rate: u32) -> usize {
    let scale = rate as f32 / TUNING_RATE;
    let n = ((tuning + spread) as f32 * scale).round();
    // 极低采样率下也别退化成 0
    (n.max(1.0) as usize).max(2)
}

/// 总线混响源：把 bus 的样本逐帧过一遍 Freeverb。
///
/// 状态机
/// - 有档位：按目标参数平滑过渡，正常处理
/// - 无档位：wet 平滑到 0、dry 回到 1，收敛后清空延迟线并切到 bypass
///   （bypass 时逐帧 memcpy，连 8 路 comb 的乘法都不做 —— 默认关闭时开销可以忽略）
///
/// 与「原版立刻切断尾巴」的差别：这里是约 70 ms 的淡出后再切断。
/// 原版那种硬切断在拖杆切换档位时会产生可听爆音，而听感上「立刻」与「70 ms 内」没有区别。
pub struct HallSource<S> {
    inner: S,
    verb: Freeverb,
    channels: usize,
    ch_count: ChannelCount,
    sample_rate: SampleRate,
    control: Arc<HallControl>,
    /// 当前帧的输入（已从 inner 读完）
    frame: Vec<f32>,
    /// 当前帧的输出（待吐出）
    out: Vec<f32>,
    /// out 里已吐到第几个
    pos: usize,
    /// 平滑中的实际参数
    cur: HallParams,
    /// 每帧平滑系数
    smooth: f32,
    bypass: bool,
    cleared: bool,
}

impl<S> HallSource<S>
where
    S: Source<Item = f32>,
{
    pub fn new(inner: S, channels: usize, rate: u32, control: Arc<HallControl>) -> Self {
        let channels = channels.max(1);
        let rate = if rate == 0 { 44_100 } else { rate };
        let cur = control.mode().params().unwrap_or(HallParams::OFF);
        let mut verb = Freeverb::new(rate);
        verb.set_params(cur);
        // 帧率决定平滑步长：1 - exp(-1/(tau * frame_rate))
        let frame_rate = (rate as f32 / channels as f32).max(1.0);
        let smooth = 1.0 - (-1.0 / (SMOOTH_SECS * frame_rate)).exp();
        Self {
            inner,
            verb,
            channels,
            ch_count: NonZero::new(channels.min(u16::MAX as usize) as u16).unwrap_or_else(|| NonZero::new(1).unwrap()),
            sample_rate: NonZero::new(rate).unwrap_or_else(|| NonZero::new(44_100).unwrap()),
            control,
            frame: vec![0.0; channels],
            out: vec![0.0; channels],
            // 起始必须等于 out.len()（= 一帧已耗尽），否则头一帧会吐出一帧全零
            pos: channels,
            cur,
            smooth,
            bypass: !cur.wet.is_finite() || cur.wet <= 0.0,
            cleared: false,
        }
    }

    /// 推进一帧参数平滑，返回本帧是否可以直接透传。
    fn refresh(&mut self) -> bool {
        let target = self.control.mode();
        let goal = target.params().unwrap_or(HallParams::OFF);
        let k = self.smooth;
        self.cur.room += (goal.room - self.cur.room) * k;
        self.cur.damp += (goal.damp - self.cur.damp) * k;
        self.cur.wet += (goal.wet - self.cur.wet) * k;
        self.cur.dry += (goal.dry - self.cur.dry) * k;
        self.cur.width += (goal.width - self.cur.width) * k;

        // 关闭且已经收敛到「无湿声 + 单位干声」⇒ 透传，并把延迟线洗掉
        if goal.wet == 0.0 && self.cur.wet < 0.001 && (self.cur.dry - 1.0).abs() < 0.001 {
            self.cur.wet = 0.0;
            self.cur.dry = 1.0;
            if !self.cleared {
                self.verb.clear();
                self.cleared = true;
            }
            self.bypass = true;
        } else {
            self.cleared = false;
            self.bypass = false;
            self.verb.set_params(self.cur);
        }
        self.bypass
    }

    fn render(&mut self) {
        if self.channels == 1 {
            let (l, r) = self.verb.process(self.frame[0], self.frame[0]);
            // 单声道混响：取左右平均，避免只留一半能量（width 越大差得越多）
            self.out[0] = (l + r) * 0.5;
            return;
        }
        let (l, r) = self.verb.process(self.frame[0], self.frame[1]);
        self.out[0] = l;
        self.out[1] = r;
        // 多声道（4/6/8 声道的独占输出）：只处理前两路，其余原样透传。
        // 这类输出几乎都是环绕声源，给后置声道加混响反而会破坏声像。
        for i in 2..self.channels {
            self.out[i] = self.frame[i];
        }
    }
}

impl<S> Iterator for HallSource<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.pos < self.out.len() {
            let v = self.out[self.pos];
            self.pos += 1;
            return Some(v);
        }
        for i in 0..self.channels {
            match self.inner.next() {
                Some(s) => self.frame[i] = s,
                // 帧内缺样本：整帧丢弃（宁可少一帧，也不要错位把左右声道换过来）
                None => return None,
            }
        }
        if self.refresh() {
            self.out.copy_from_slice(&self.frame);
        } else {
            self.render();
        }
        self.pos = 1;
        Some(self.out[0])
    }
}

impl<S> Source for HallSource<S>
where
    S: Source<Item = f32>,
{
    fn current_span_len(&self) -> Option<usize> {
        // 透传内层的值：MixerSource 返回 None（无固定长度），
        // 绝不能凭空返回 Some(0) —— 上游会把它当成流结束。
        self.inner.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.ch_count
    }

    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<std::time::Duration> {
        self.inner.total_duration()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct TestSrc {
        samples: Vec<f32>,
        pos: usize,
        ch: usize,
        rate: u32,
    }

    impl TestSrc {
        fn mono(v: Vec<f32>) -> Self {
            Self { samples: v, pos: 0, ch: 1, rate: 44_100 }
        }
        fn stereo(v: Vec<f32>) -> Self {
            Self { samples: v, pos: 0, ch: 2, rate: 44_100 }
        }
    }

    impl Iterator for TestSrc {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            let v = self.samples.get(self.pos).copied();
            if v.is_some() {
                self.pos += 1;
            }
            v
        }
    }

    impl Source for TestSrc {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> ChannelCount {
            NonZero::new(self.ch as u16).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            NonZero::new(self.rate).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    #[test]
    fn delay_lines_scale_with_sample_rate() {
        let a = scaled_len(1116, 0, 44_100);
        let b = scaled_len(1116, 0, 48_000);
        let c = scaled_len(1116, 0, 96_000);
        assert_eq!(a, 1116);
        assert!((1214..=1216).contains(&b), "48k = {b}");
        assert!((2429..=2431).contains(&c), "96k = {c}");
        // 极低采样率也不该退化成 0 长度
        assert!(scaled_len(225, 23, 8_000) >= 2);
    }

    #[test]
    fn off_mode_is_bit_transparent() {
        let ctl = Arc::new(HallControl::new(HallMode::Off));
        let input: Vec<f32> = (0..4096).map(|i| ((i as f32) * 0.01).sin() * 0.5).collect();
        let src = TestSrc::stereo(input.iter().flat_map(|&v| [v, -v]).collect());
        let out: Vec<f32> = HallSource::new(src, 2, 44_100, ctl).collect();
        assert_eq!(out.len(), input.len() * 2);
        for (i, chunk) in out.chunks(2).enumerate() {
            assert_eq!(chunk[0], input[i]);
            assert_eq!(chunk[1], -input[i]);
        }
    }

    #[test]
    fn mono_input_stays_finite_and_bounded() {
        let ctl = Arc::new(HallControl::new(HallMode::On));
        let input: Vec<f32> = (0..48_000).map(|i| ((i as f32) * 0.05).sin() * 0.8).collect();
        let out: Vec<f32> = HallSource::new(TestSrc::mono(input), 1, 44_100, ctl).collect();
        assert_eq!(out.len(), 48_000);
        assert!(out.iter().all(|v| v.is_finite()));
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        // dry 0.87 + 校准后的 wet 在 0.8 幅度正弦上不会顶到满刻度
        assert!(peak < 1.6, "peak = {peak}");
    }

    #[test]
    fn width_zero_makes_channels_identical() {
        let mut p = HallMode::On.params().unwrap();
        p.width = 0.0;
        // 直接构造 Freeverb 验证宽度语义（绕过档位表）
        let mut verb = Freeverb::new(44_100);
        verb.set_params(p);
        let mut max_diff = 0.0f32;
        for i in 0..8_000 {
            let x = ((i as f32) * 0.03).sin() * 0.5;
            let (l, r) = verb.process(x, x);
            max_diff = max_diff.max((l - r).abs());
        }
        assert!(max_diff < 1e-6, "width=0 时左右应完全相同，max_diff = {max_diff}");
        // 对照：默认宽度下左右必须不同，否则混响就是单声道的
        let mut verb2 = Freeverb::new(44_100);
        verb2.set_params(HallMode::On.params().unwrap());
        let mut diff = 0.0f32;
        for i in 0..8_000 {
            let x = ((i as f32) * 0.03).sin() * 0.5;
            let (l, r) = verb2.process(x, x);
            diff = diff.max((l - r).abs());
        }
        assert!(diff > 0.01, "默认宽度下左右应有明显差异，diff = {diff}");
    }

    #[test]
    fn enabling_produces_a_tail_after_input_stops() {
        let ctl = Arc::new(HallControl::new(HallMode::On));
        let mut input = vec![0.0f32; 2_000];
        // 前 1000 帧给一段噪声式激励
        for i in 0..1000 {
            input[i] = if i % 2 == 0 { 0.5 } else { -0.5 };
        }
        let out: Vec<f32> = HallSource::new(TestSrc::mono(input), 1, 44_100, ctl).collect();
        // 激励结束后仍有能量 ⇒ 混响真的在响
        let tail: f32 = out[1_500..].iter().map(|v| v.abs()).sum::<f32>() / 500.0;
        assert!(tail > 0.0005, "尾巴能量过低：{tail}");
    }

    #[test]
    fn mode_roundtrip_and_parse() {
        for m in [HallMode::Off, HallMode::On] {
            assert_eq!(HallMode::parse(m.as_str()), m);
            assert_eq!(HallMode::from_code(m.code()), m);
        }
        assert_eq!(HallMode::parse(""), HallMode::Off);
        assert_eq!(HallMode::parse("bogus"), HallMode::Off);
        assert!(!HallMode::Off.enabled());
        assert!(HallMode::On.enabled());
        // 老版本自带的档位名不是用户选择，一律回落关闭（默认必须是干声）
        for old in ["soft", "standard", "original"] {
            assert_eq!(HallMode::parse(old), HallMode::Off, "旧值 {old} 应当回落 Off");
        }
    }

    fn ch(n: u16) -> ChannelCount {
        NonZero::new(n).unwrap()
    }
    fn rate(r: u32) -> SampleRate {
        NonZero::new(r).unwrap()
    }

    /// 总线保活：没有这个 Zero 源，MixerSource 在所有子源结束时直接返回 None，
    /// 下游会把「歌与歌之间」当成播放完毕。
    #[test]
    fn bus_with_keepalive_never_ends() {
        let (bus, source) = rodio::mixer::mixer(ch(2), rate(44_100));
        bus.add(rodio::source::Zero::new(ch(2), rate(44_100)));
        let ctl = Arc::new(HallControl::new(HallMode::Off));
        let mut hall = HallSource::new(source, 2, 44_100, ctl);
        for _ in 0..4000 {
            assert!(hall.next().is_some(), "保活源失效：总线提前结束");
        }
        assert_eq!(hall.next(), Some(0.0));
    }

    /// 端到端：Player 接到 bus，样本必须穿过 bus → HallSource 到达设备侧。
    #[test]
    fn player_through_bus_reaches_hall() {
        let (bus, source) = rodio::mixer::mixer(ch(2), rate(44_100));
        bus.add(rodio::source::Zero::new(ch(2), rate(44_100)));
        let ctl = Arc::new(HallControl::new(HallMode::Off));
        let mut hall = HallSource::new(source, 2, 44_100, ctl);
        let player = rodio::Player::connect_new(&bus);
        player.append(TestSrc::stereo(vec![0.25; 4000]));

        let mut loud = 0;
        for _ in 0..2000 {
            if hall.next().map(|v| v.abs() > 0.2).unwrap_or(false) {
                loud += 1;
            }
        }
        // 关混响（bypass）时应逐位透传 0.25；留出 mixer 起动的前几百个样本余量
        assert!(loud > 1000, "只听到 {loud} 个有效样本，总线没接上");
        player.stop();
    }

    /// 播放中切档必须立刻生效：这是设置页「切换即时生效」那句提示的实测依据。
    ///
    /// 关闭档是逐位透传（不经过滤波器），所以这条同时守住两件事：
    /// bypass 不能偷偷改动样本，而 refresh() 读到新档位后必须真的把湿声接进来。
    #[test]
    fn switching_mode_takes_effect_mid_stream() {
        let sr = 44_100u32;
        let frames = sr as usize * 2;
        let sine = |f: usize| ((f as f32 / sr as f32) * 440.0 * std::f32::consts::TAU).sin() * 0.5;
        let data: Vec<f32> = (0..frames).flat_map(|f| [sine(f), sine(f)]).collect();
        let ctl = Arc::new(HallControl::new(HallMode::Off));
        let mut hall = HallSource::new(TestSrc::stereo(data), 2, sr, ctl.clone());

        // 前 0.4 秒：关闭档，输出必须逐样本等于输入
        let head = sr as usize / 5 * 2;
        let mut off_diff = 0f32;
        for k in 0..head {
            let out = hall.next().expect("输入还没放完");
            off_diff = off_diff.max((out - sine(k / 2)).abs());
        }
        assert!(off_diff < 1e-6, "关闭档没逐位透传，偏差 {off_diff}");

        // 切到开启：15 ms 的平滑过渡之后，输出必须与干声不同
        ctl.set(HallMode::On);
        let skip = (sr as usize / 50) * 2; // 20 ms
        for _ in 0..skip {
            let _ = hall.next();
        }
        let mut on_diff = 0f32;
        for k in (head + skip)..(frames / 2) {
            let out = hall.next().expect("输入还没放完");
            on_diff = on_diff.max((out - sine(k / 2)).abs());
        }
        assert!(on_diff > 1e-3, "切到开启后输出没变化，偏差 {on_diff}");
    }

    /// 实测 RT60：喂一个脉冲，按 -60 dB 包络找尾巴结束的位置。
    ///
    /// 注意这里量到的是「衰减最慢的那路 comb」（约 5 秒），比上面用主 comb 算的
    /// 主观值大 —— 绝对值不重要，这条测试要的是**三个采样率必须一致**。
    fn measured_rt60(rate: u32, p: HallParams) -> f32 {
        let mut verb = Freeverb::new(rate);
        verb.set_params(p);
        let block = 64usize;
        let total = rate as usize * 8;
        let mut env: Vec<f32> = Vec::with_capacity(total / block + 1);
        // 前 50 ms 里混着干声（t=0 的直达声），算峰值会把阈值抬高一截，
        // 量出来的会是「湿声从峰值衰减 39 dB」而不是 60 dB。
        let skip_blocks = (rate as usize / 20) / block;
        let mut acc = 0.0f32;
        let mut cnt = 0usize;
        for i in 0..total {
            let x = if i == 0 { 1.0 } else { 0.0 };
            let (l, _) = verb.process(x, x);
            acc += l * l;
            cnt += 1;
            if cnt == block {
                env.push((acc / block as f32).sqrt());
                acc = 0.0;
                cnt = 0;
            }
        }
        let peak = env.iter().skip(skip_blocks).cloned().fold(0.0f32, f32::max);
        let thr = peak * 0.001;
        let end = env
            .iter()
            .rposition(|v| *v > thr)
            .filter(|i| *i >= skip_blocks)
            .unwrap_or(0);
        end as f32 * block as f32 / rate as f32
    }

    #[test]
    fn rt60_is_sample_rate_independent() {
        let p = HallMode::On.params().unwrap();
        let a = measured_rt60(44_100, p);
        let b = measured_rt60(48_000, p);
        let c = measured_rt60(96_000, p);
        // 延迟线按 sr/44100 缩放 + 阻尼按时间常数归一化，三个率的 RT60 应当基本重合
        eprintln!("实测 RT60：44.1k = {a:.2}s  48k = {b:.2}s  96k = {c:.2}s");
        let rel = |x: f32, y: f32| (x - y).abs() / y.max(1e-6);
        assert!(rel(a, b) < 0.08, "44.1k = {a}s vs 48k = {b}s");
        assert!(rel(c, a) < 0.08, "96k = {c}s vs 44.1k = {a}s");
        // 绝对长度的守卫：参数被改坏时这里会先炸，而不是只比出「三率一致」
        assert!((4.0..4.6).contains(&a), "实测 RT60 异常：{a}s");
        // 这 4 秒是「湿声从峰值衰减 60 dB」的口径，比按主 comb 公式估的偏长，
        // 差在阻尼低通那部分（额外吃掉高频能量）。
    }

    fn write_wav_stereo(path: &std::path::Path, rate: u32, pcm: &[i16]) {
        let mut w = Vec::with_capacity(pcm.len() * 2 + 44);
        let len = (pcm.len() * 2) as u32;
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + len).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes()); // PCM
        w.extend_from_slice(&2u16.to_le_bytes()); // 立体声
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * 4).to_le_bytes());
        w.extend_from_slice(&4u16.to_le_bytes()); // block align
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&len.to_le_bytes());
        for s in pcm {
            w.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, &w).unwrap();
    }

    /// 真素材 A/B：把库里几首歌过一遍各档混响，写成 wav 供试听，并打印响度。
    ///
    /// 需要 `.build/ab_track.txt`（每行一个绝对路径）；文件不在就安静跳过，
    /// 这样 CI / 别人 clone 下来跑全量测试也不会因为这个失败。
    #[test]
    #[ignore]
    fn render_ab_demo() {
        let Ok(txt) = std::fs::read_to_string(r"D:\LocalMusicPlayer\.build\ab_track.txt") else {
            return;
        };
        let out_dir = std::path::Path::new(r"D:\LocalMusicPlayer\.build\hall_ab");
        std::fs::create_dir_all(out_dir).unwrap();

        for line in txt.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let Ok(mut dec) = crate::engine::audio::open_decoder(line) else {
                eprintln!("[ab] 解码失败，跳过：{line}");
                continue;
            };
            let ch = dec.channels().get() as usize;
            let rate = dec.sample_rate().get();
            let want = rate as usize * ch * 24;
            let mut pcm: Vec<f32> = Vec::with_capacity(want);
            for s in dec.by_ref() {
                pcm.push(s);
                if pcm.len() >= want {
                    break;
                }
            }
            let frames = pcm.len() / ch;
            let raw_stem = std::path::Path::new(line)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "track".into());
            let stem: String = raw_stem
                .chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
                .collect();

            for mode in [HallMode::Off, HallMode::On] {
                let mut verb = Freeverb::new(rate);
                verb.set_params(mode.params().unwrap_or(HallParams::OFF));
                let mut out: Vec<i16> = Vec::with_capacity(frames * 2);
                let mut acc = 0f64;
                let mut peak = 0f32;
                for f in 0..frames {
                    let l = pcm[f * ch];
                    let r = if ch > 1 { pcm[f * ch + 1] } else { l };
                    let (ol, or) = verb.process(l, r);
                    acc += (ol * ol + or * or) as f64;
                    peak = peak.max(ol.abs()).max(or.abs());
                    out.push((ol.clamp(-1.0, 1.0) * 32767.0) as i16);
                    out.push((or.clamp(-1.0, 1.0) * 32767.0) as i16);
                }
                let rms = (acc / (frames * 2) as f64).sqrt();
                let db = 20.0 * rms.max(1e-9).log10();
                let peak_db = 20.0 * peak.max(1e-9).log10();
                let path = out_dir.join(format!("{stem}__{}.wav", mode.as_str()));
                write_wav_stereo(&path, rate, &out);
                eprintln!(
                    "[ab] {stem} · {:<9} RMS {db:6.2} dBFS  peak {peak_db:6.2} dBFS → {}",
                    mode.as_str(),
                    path.display()
                );
            }
        }
    }

    /// 低频重的母带不许把混响灌成低频驻波。
    ///
    /// 曾经的故障：库内一首 24bit/48k 的歌 &lt;45 Hz 到 -11 dBFS（比第二名重 4 dB），
    /// 次低频几乎原样进 comb，40–600 Hz 叠出 +24 dB 的梳状共鸣，用户听感是「有电音」。
    /// 这条守的是「送进混响的那一路必须过 SEND_HIGHPASS_HZ 高通」。
    #[test]
    fn send_highpass_removes_sub_bass() {
        let rate = 48_000.0f32;
        let mut hp = SendHighpass::new(rate, SEND_HIGHPASS_HZ);
        let mut acc = 0f64;
        let n = 48_000;
        for i in 0..n {
            let x = (std::f32::consts::TAU * 40.0 * i as f32 / rate).sin();
            let y = hp.process(x);
            acc += (y * y) as f64;
        }
        let bass = (acc / n as f64).sqrt();
        // 40 Hz 比拐点低 1.6 个八度，12 dB/oct → 约 -19 dB；给足余量只要求 -12 dB 以下
        assert!(bass < 0.25, "40 Hz 残留太大：{bass:.3}（应 < 0.25）");

        let mut hp2 = SendHighpass::new(rate, SEND_HIGHPASS_HZ);
        let mut acc2 = 0f64;
        for i in 0..n {
            let x = (std::f32::consts::TAU * 1_000.0 * i as f32 / rate).sin();
            let y = hp2.process(x);
            acc2 += (y * y) as f64;
        }
        let mid = (acc2 / n as f64).sqrt();
        // 1 kHz 在通带里，不能被削掉（否则混响会变闷）
        assert!(mid > 0.65, "1 kHz 被削得太多：{mid:.3}");
    }

    /// 限幅必须立体声联动，而且任何峰值都不能推出 0 dBFS。
    #[test]
    fn limit_gain_is_linked_and_keeps_headroom() {
        assert_eq!(limit_gain(0.0), 1.0);
        assert_eq!(limit_gain(0.5), 1.0);
        assert_eq!(limit_gain(LIMIT_KNEE), 1.0);
        for peak in [0.93f32, 1.0, 1.2, 1.6, 4.0] {
            let g = limit_gain(peak);
            assert!(g < 1.0, "peak {peak} 应该被压");
            assert!((peak * g) <= 1.0, "peak {peak} 压完仍越界：{}", peak * g);
            // 同一个峰值必须给出同一个增益（联动的前提）
            assert_eq!(limit_gain(peak), g);
        }
    }

    /// 满刻度低频是「最坏情况」素材：输出必须仍然有界。
    #[test]
    fn bass_heavy_full_scale_stays_bounded() {
        let p = HallMode::On.params().unwrap();
        let mut verb = Freeverb::new(48_000);
        verb.set_params(p);
        let mut peak = 0f32;
        for i in 0..48_000 * 2 {
            let x = (std::f32::consts::TAU * 40.0 * i as f32 / 48_000.0).sin();
            let (l, r) = verb.process(x, x);
            assert!(l.is_finite() && r.is_finite(), "输出出现非有限值");
            peak = peak.max(l.abs()).max(r.abs());
        }
        assert!(peak <= 1.0, "满刻度低频下峰值越界：{peak}");
    }

    /// 电平守卫：满刻度输入 + 各档混响，输出必须不越 0 dBFS，响度也不能跑偏。
    ///
    /// 这条守的是两件容易被「调参数」调坏的事：
    /// 1) 湿声增益忘了走 WET_GAIN_TRIM —— 会立刻多出 6 dB 峰值，实际播放就是破音；
    /// 2) 有人顺手把 soft_limit 换成 clamp —— 峰值虽然不越界，但波形被削平，
    ///    听感上就是「开混响的副歌变糊」，比响一点难受得多。
    #[test]
    fn full_scale_input_never_clips() {
        for mode in [HallMode::On] {
            let p = mode.params().unwrap();
            let mut verb = Freeverb::new(44_100);
            verb.set_params(p);
            let mut peak = 0f32;
            let mut acc = 0f64;
            let mut n = 0usize;
            // 0 dBFS 的伪随机噪声：比正弦更接近真实混音的峰值统计
            let mut seed: u32 = 0x1234_5678;
            for i in 0..44_100 * 4 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let x = (seed >> 8) as f32 / 8_388_608.0 - 1.0; // [-1, 1)
                let (l, r) = verb.process(x, if i % 2 == 0 { x } else { -x });
                peak = peak.max(l.abs()).max(r.abs());
                acc += (l * l + r * r) as f64;
                n += 2;
            }
            let rms = (acc / n as f64).sqrt();
            assert!(peak <= 1.0, "{:?} 档峰值越界：{peak}", mode);
            // 输入 RMS 约 -4.8 dBFS（均匀分布），湿声叠进来后不该明显更吵
            let db = 20.0 * rms.log10();
            assert!(db < -1.0, "{:?} 档整体响度偏高：{db:.2} dBFS", mode);
        }
    }

    #[test]
    fn control_is_shared_across_threads() {
        let ctl = Arc::new(HallControl::new(HallMode::Off));
        let c2 = ctl.clone();
        assert_eq!(c2.mode(), HallMode::Off);
        ctl.set(HallMode::On);
        assert_eq!(c2.mode(), HallMode::On);
    }
}
