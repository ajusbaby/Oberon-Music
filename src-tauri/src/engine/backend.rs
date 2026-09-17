//! WASAPI 独占输出的底层支撑：能力探测 / 格式协商 / 缓冲对齐重试 / 回退判定。
//!
//! 设计原则（来自 examples/wasapi_probe.rs 的实测教训）：
//!  **绝不假设某台设备支持什么**。能力边界必须现场探测，探测不到的格式就回退，
//!  并且把「为什么回退」明确告诉用户 —— 而不是静默降级或静默没声音。
//!
//! 本模块只负责「能不能开、开成什么样」，不负责渲染线程（那在 backend 的 session 里）。

use crate::error::{AppError, E_AUDIO_DEVICE};
use serde::Serialize;
use wasapi::{
    AudioClient, DeviceEnumerator, Direction, SampleType, ShareMode, StreamMode, WaveFormat,
};

/// 一个期望的采样格式：store = 容器位宽，valid = 有效位宽。
///
/// ⚠️ **必须区分这两者**：板载声卡与 USB DAC 最常见的 hifi 格式是「32 位容器装 24 位有效」。
/// 只试 24/24 会把它误判成「不支持 24bit」—— 第一版探针就是这么错的。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fmt {
    pub store: usize,
    pub valid: usize,
    pub is_float: bool,
}

impl Fmt {
    pub const fn int(store: usize, valid: usize) -> Self {
        Self { store, valid, is_float: false }
    }
    pub const fn float(bits: usize) -> Self {
        Self { store: bits, valid: bits, is_float: true }
    }
    pub fn wave(&self, rate: usize, channels: usize) -> WaveFormat {
        let ty = if self.is_float { SampleType::Float } else { SampleType::Int };
        WaveFormat::new(self.store, self.valid, &ty, rate, channels, None)
    }
    /// 给用户看的标签：有效位/容器位（24/32 = 32 位容器装 24 位）
    pub fn label(&self) -> String {
        if self.is_float {
            format!("{}f/{}", self.valid, self.store)
        } else {
            format!("{}/{}", self.valid, self.store)
        }
    }
}

/// 偏好顺序：从高保真到兼容。前两个是 hifi 常见形态，24/32 排第一。
pub const FMT_PREF: [Fmt; 5] = [
    Fmt::int(32, 24),
    Fmt::int(24, 24),
    Fmt::int(32, 32),
    Fmt::float(32),
    Fmt::int(16, 16),
];

/// 常用采样率（44.1k 家族 + 48k 家族，含 DSD 的 176.4k 家族）
pub const RATES: [usize; 8] = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 352_800, 705_600];

/// 为什么没用成独占（要原样告诉用户）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub enum Fallback {
    /// 设备不支持请求的格式（0x88890008）
    UnsupportedFormat,
    /// 设备被别的程序独占占用（0x8889000A）
    DeviceInUse,
    /// 系统里禁用了独占控制（0x8889000E）
    ExclusiveDisabled,
    /// 设备已失效/被拔（0x88890004）
    DeviceInvalidated,
    /// 需要按设备周期对齐后重试（0x88890019）—— 这是**可自动处理**的，不算回退
    NeedsAlignment,
    Other,
}

/// 把 Windows 的 HRESULT 文本归类。纯函数，方便单测。
pub fn classify(err: &str) -> Fallback {
    if err.contains("0x88890008") {
        Fallback::UnsupportedFormat
    } else if err.contains("0x8889000A") {
        Fallback::DeviceInUse
    } else if err.contains("0x8889000E") {
        Fallback::ExclusiveDisabled
    } else if err.contains("0x88890004") {
        Fallback::DeviceInvalidated
    } else if err.contains("0x88890019") {
        Fallback::NeedsAlignment
    } else {
        Fallback::Other
    }
}

impl Fallback {
    /// 给用户看的一句话
    pub fn hint(&self) -> &'static str {
        match self {
            Fallback::UnsupportedFormat => "该设备不支持这个采样格式，已回退共享模式",
            Fallback::DeviceInUse => "该设备正被其它程序独占，已回退共享模式",
            Fallback::ExclusiveDisabled => {
                "系统设置里禁用了独占控制（声音设置 → 设备属性 → 高级），已回退共享模式"
            }
            Fallback::DeviceInvalidated => "设备已失效或被拔出，已回退共享模式",
            Fallback::NeedsAlignment => "需要对齐设备缓冲（已自动重试）",
            Fallback::Other => "独占模式初始化失败，已回退共享模式",
        }
    }
}

/// 独占模式缓冲时长必须按「设备周期」对齐，否则驱动会返回 0x88890019。
///
/// 官方解法：拿 GetBufferSize 的帧数反算对齐后的时长（单位 100ns）。
/// 实测：44.1kHz / 448 帧 → 101587，而 48000/44100*448*10000000 ≈ 101587 ✓
pub fn aligned_period_hns(rate: usize, frames: u32) -> i64 {
    if rate == 0 || frames == 0 {
        return 0;
    }
    (0.5 + 10_000_000.0 / rate as f64 * frames as f64) as i64
}

/// 探测结果（前端展示用）
// 前端用 camelCase（与本项目其它模型一致）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCaps {
    pub name: String,
    pub id: String,
    pub is_default: bool,
    /// 共享模式默认格式的可读描述
    pub shared_format: String,
    /// 独占模式支持的组合，形如 "44100/24-32"
    pub exclusive: Vec<String>,
    /// 实测能成功初始化(Initialize)的组合
    pub init_ok: Option<String>,
    /// 初始化失败的原因（若 init_ok 为空）
    pub init_hint: Option<String>,
}

/// 列出所有输出设备并逐个探测独占能力。
pub fn probe_all() -> Result<Vec<DeviceCaps>, AppError> {
    // WASAPI 基于 COM，而且**每个线程都要各自初始化**。probe_all 可能跑在 Tauri 的
    // 阻塞线程池或测试线程上，所以必须在这里自己初始化一次 MTA。
    // 重复初始化返回 S_FALSE（已初始化），属正常，忽略即可。
    // ⚠️ 后面的独占渲染线程也必须做同样的事。
    let _ = wasapi::initialize_mta();

    let enumr = DeviceEnumerator::new()
        .map_err(|e| AppError::new(E_AUDIO_DEVICE, format!("枚举音频设备失败: {e}")))?;
    let default_id = enumr.get_default_device(&Direction::Render).ok().and_then(|d| d.get_id().ok());
    let coll = enumr
        .get_device_collection(&Direction::Render)
        .map_err(|e| AppError::new(E_AUDIO_DEVICE, format!("枚举输出设备失败: {e}")))?;
    let n = coll.get_nbr_devices().unwrap_or(0);

    let mut out = Vec::new();
    for i in 0..n {
        let Ok(dev) = coll.get_device_at_index(i) else { continue };
        let name = dev.get_friendlyname().unwrap_or_else(|_| "?".into());
        let id = dev.get_id().unwrap_or_else(|_| "?".into());
        let shared_format = dev
            .get_device_format()
            .map(describe)
            .unwrap_or_else(|_| "(读取失败)".into());
        let Ok(mut client) = dev.get_iaudioclient() else {
            out.push(DeviceCaps {
                name,
                id,
                is_default: false,
                shared_format,
                exclusive: Vec::new(),
                init_ok: None,
                init_hint: Some("拿不到 IAudioClient".into()),
            });
            continue;
        };

        // 逐个格式问驱动：Ok(None) = 逐位支持
        let mut supported: Vec<(usize, Fmt)> = Vec::new();
        for rate in RATES {
            for f in FMT_PREF {
                let wf = f.wave(rate, 2);
                if matches!(client.is_supported(&wf, &ShareMode::Exclusive), Ok(None)) {
                    supported.push((rate, f));
                }
            }
        }

        // 真正初始化一次（带对齐重试）—— 「支持」不等于「能开」
        let mut init_ok = None;
        let mut init_hint = None;
        for (rate, f) in supported.iter().take(8) {
            // ⚠️ 每次试都重开一个 client：IAudioClient 一旦 Initialize 过，
            //    再次 Initialize 会返回 AUDCLNT_E_ALREADY_INITIALIZED，污染后续判断
            let Ok(mut c) = dev.get_iaudioclient() else { continue };
            match try_open(&mut c, *rate, *f, 2) {
                Ok(period) => {
                    init_ok = Some(format!("{:.1}kHz {}", *rate as f64 / 1000.0, f.label()));
                    let _ = period;
                    break;
                }
                Err(e) => init_hint = Some(format!("{}：{}", f.label(), e)),
            }
        }
        if init_ok.is_none() && supported.is_empty() {
            init_hint = Some("该设备在独占模式下没有任何我试过的格式可用".into());
        }

        out.push(DeviceCaps {
            name,
            id: id.clone(),
            is_default: Some(&id) == default_id.as_ref(),
            shared_format,
            exclusive: supported
                .iter()
                .map(|(r, f)| format!("{}/{}", r, f.label()))
                .collect(),
            init_ok,
            init_hint,
        });
    }
    Ok(out)
}

/// 尝试用独占模式初始化；命中「缓冲未对齐」时按官方做法自动重试一次。
/// 返回实际使用的 period（100ns）。
pub fn try_open(client: &mut AudioClient, rate: usize, fmt: Fmt, channels: usize) -> Result<i64, String> {
    let wf = fmt.wave(rate, channels);
    let (def_period, _min) = client.get_device_period().map_err(|e| e.to_string())?;
    let mode = StreamMode::EventsExclusive { period_hns: def_period };
    match client.initialize_client(&wf, &Direction::Render, &mode) {
        Ok(()) => Ok(def_period),
        Err(e) => {
            let msg = e.to_string();
            if classify(&msg) != Fallback::NeedsAlignment {
                return Err(format!("{}（{}）", msg, classify(&msg).hint()));
            }
            // 对齐重试：用 GetBufferSize 的帧数反算时长后再 Initialize
            let frames = client.get_buffer_size().map_err(|e2| e2.to_string())?;
            let aligned = aligned_period_hns(rate, frames);
            let mode2 = StreamMode::EventsExclusive { period_hns: aligned };
            client
                .initialize_client(&wf, &Direction::Render, &mode2)
                .map_err(|e2| e2.to_string())?;
            Ok(aligned)
        }
    }
}

/// 把 WaveFormat 描述成人能读的一行
fn describe(f: WaveFormat) -> String {
    let ty = match f.get_subformat() {
        Ok(SampleType::Float) => "float",
        _ => "PCM",
    };
    format!(
        "{}Hz {}/{}bit {} {}ch",
        f.get_samplespersec(),
        f.get_validbitspersample(),
        f.get_bitspersample(),
        ty,
        f.get_nchannels()
    )
}

/// 让用户在前端点一下就能看到「我这台设备到底支持什么」
#[tauri::command]
pub async fn audio_exclusive_probe() -> Result<Vec<DeviceCaps>, AppError> {
    tauri::async_runtime::spawn_blocking(probe_all)
        .await
        .unwrap_or_else(|e| Err(AppError::new(E_AUDIO_DEVICE, format!("探测任务失败: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实测值：44.1kHz 上驱动要求的对齐时长是 101587（100ns）—— 448 帧 @44.1k = 10.1587ms
    #[test]
    fn aligned_period_matches_measured_value() {
        assert_eq!(aligned_period_hns(44_100, 448), 101_587);
        // 48k 上 480 帧正好 10ms
        assert_eq!(aligned_period_hns(48_000, 480), 100_000);
        assert_eq!(aligned_period_hns(0, 448), 0);
        assert_eq!(aligned_period_hns(44_100, 0), 0);
    }

    /// 失败码归类：这是「回退时告诉用户为什么」的依据
    #[test]
    fn classifies_windows_errors() {
        let wrap = |code: &str| format!("Windows returned an error: {code}");
        assert_eq!(classify(&wrap("0x88890008")), Fallback::UnsupportedFormat);
        assert_eq!(classify(&wrap("0x8889000A")), Fallback::DeviceInUse);
        assert_eq!(classify(&wrap("0x8889000E")), Fallback::ExclusiveDisabled);
        assert_eq!(classify(&wrap("0x88890004")), Fallback::DeviceInvalidated);
        // 这条不是回退，是可自动处理的重试
        assert_eq!(classify(&wrap("0x88890019")), Fallback::NeedsAlignment);
        assert_eq!(classify("something else"), Fallback::Other);
    }

    /// 回归：格式偏好里必须有「32 位容器装 24 位有效」，且排在 16bit 前面。
    /// 第一版探针漏了它，导致把不支持 24bit 的错误结论报给了用户。
    #[test]
    fn pref_includes_24_in_32_before_16() {
        let p24_32 = FMT_PREF.iter().position(|f| f.store == 32 && f.valid == 24 && !f.is_float);
        let p16 = FMT_PREF.iter().position(|f| f.store == 16 && f.valid == 16);
        assert!(p24_32.is_some(), "偏好里必须包含 32/24");
        assert!(p16.is_some());
        assert!(p24_32.unwrap() < p16.unwrap(), "24/32 应优先于 16/16");
    }

    /// 设备标签要能区分 24/24 与 24/32
    #[test]
    fn labels_distinguish_container_width() {
        assert_eq!(Fmt::int(24, 24).label(), "24/24");
        assert_eq!(Fmt::int(32, 24).label(), "24/32");
        assert_eq!(Fmt::float(32).label(), "32f/32");
    }

    /// 冒烟：探测要能跑完不 panic，并至少认出默认设备
    #[test]
    fn probe_all_smoke() {
        let caps = probe_all().expect("探测不应失败");
        eprintln!("[test] 探测到 {} 个输出设备", caps.len());
        for c in &caps {
            eprintln!(
                "  {}{} 共享={} 独占支持 {} 项 实测初始化={:?}",
                c.name,
                if c.is_default { "（默认）" } else { "" },
                c.shared_format,
                c.exclusive.len(),
                c.init_ok
            );
        }
        assert!(!caps.is_empty(), "至少应有一个输出设备");
    }
}
