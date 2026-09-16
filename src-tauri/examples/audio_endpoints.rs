//! 诊断工具：打印机器上所有**渲染端点**的拓扑 —— 有哪些端点、默认是哪个、各自的
//! DEVICE_STATE、以及 cpal/rodio 认为的默认设备是哪一个。
//!
//! 为什么需要它：拔掉耳机后 app 依然能成功打开设备、播放位置照常推进、却完全没声音。
//! 要判断它到底接到了哪个端点上（是不是被切到了某个常驻 ACTIVE 的"数字输出"之类），
//! 唯一的办法就是把端点拓扑直接打出来看。
//!
//! 用法：
//!   cargo run --example audio_endpoints            打一次完整拓扑
//!   cargo run --example audio_endpoints -- --watch  每 500ms 打一次默认端点（拔插时观察变化）

use windows::Win32::Media::Audio::{
    eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE,
    DEVICE_STATE_ACTIVE, DEVICE_STATE_DISABLED, DEVICE_STATE_NOTPRESENT, DEVICE_STATE_UNPLUGGED,
    DEVICE_STATEMASK_ALL,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

fn state_name(s: DEVICE_STATE) -> &'static str {
    if s == DEVICE_STATE_ACTIVE {
        "ACTIVE(可用)"
    } else if s == DEVICE_STATE_DISABLED {
        "DISABLED(已禁用)"
    } else if s == DEVICE_STATE_NOTPRESENT {
        "NOTPRESENT(不存在)"
    } else if s == DEVICE_STATE_UNPLUGGED {
        "UNPLUGGED(已拔出)"
    } else {
        "未知"
    }
}

fn endpoint_id(dev: &IMMDevice) -> String {
    match unsafe { dev.GetId() } {
        Ok(p) => {
            let s = unsafe { p.to_string() }.unwrap_or_default();
            // GetId 用的是 CoTaskMemAlloc，必须还回去
            unsafe { CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)) };
            s
        }
        Err(_) => "(GetId 失败)".to_string(),
    }
}

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

/// 默认渲染端点： (id, state)
fn default_render() -> Option<(String, DEVICE_STATE)> {
    let e = enumerator().ok()?;
    let dev = unsafe { e.GetDefaultAudioEndpoint(eRender, eConsole) }.ok()?;
    let st = unsafe { dev.GetState() }.ok()?;
    Some((endpoint_id(&dev), st))
}

fn cpal_line(d: &rodio::cpal::Device) -> String {
    use rodio::cpal::traits::DeviceTrait;
    let name = match d.description() {
        Ok(x) => format!("{} ({:?})", x.name(), x.device_type()),
        Err(e) => format!("(description 失败: {e})"),
    };
    // DeviceId.1 就是平台侧的稳定设备 id —— WASAPI 下即端点 id，可与 CoreAudio 的 GetId 对照
    let id = match d.id() {
        Ok(x) => x.1,
        Err(e) => format!("(id 失败: {e})"),
    };
    format!("{name}\n        id={id}")
}

fn dump_cpal() {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let host = rodio::cpal::default_host();
    match host.default_output_device() {
        Some(d) => {
            let cfg = match d.default_output_config() {
                Ok(c) => format!("{}Hz x{} {:?}", c.sample_rate(), c.channels(), c.sample_format()),
                Err(e) => format!("(取配置失败: {e})"),
            };
            println!("    cpal 默认输出设备:");
            println!("        {}\n        [{}]", cpal_line(&d), cfg);
        }
        None => println!("    cpal 默认输出设备 = (无)"),
    }
    match host.output_devices() {
        Ok(devs) => {
            println!("    cpal 全部输出设备:");
            for (i, d) in devs.enumerate() {
                println!("      cpal[{i}] {}", cpal_line(&d));
            }
        }
        Err(e) => println!("    cpal output_devices() 失败: {e}"),
    }
}


/// 按 id 查端点状态（验证 CoreAudio 的 GetDevice 能接受 cpal 给出的 id 字符串）
fn state_by_id(id: &str) -> Option<DEVICE_STATE> {
    let e = enumerator().ok()?;
    let dev = unsafe { e.GetDevice(&windows::core::HSTRING::from(id)) }.ok()?;
    unsafe { dev.GetState() }.ok()
}

/// 关键交叉验证：cpal 的 DeviceId 与 CoreAudio 的 GetId 必须是同一个字符串，
/// 否则「按 id 重新打开原设备」这条恢复路径会静默失效。
fn cross_check() {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    println!("=== 交叉验证：cpal id ↔ CoreAudio id ===");
    let ca = enumerator()
        .ok()
        .and_then(|e| unsafe { e.GetDefaultAudioEndpoint(eRender, eConsole) }.ok());
    let host = rodio::cpal::default_host();
    let cp = host.default_output_device();
    let ca_id = ca.as_ref().map(endpoint_id);
    let cp_id = cp.as_ref().and_then(|d| d.id().ok()).map(|x| x.1);
    println!("  CoreAudio 默认端点 id = {}", ca_id.as_deref().unwrap_or("(无)"));
    println!("  cpal     默认设备 id = {}", cp_id.as_deref().unwrap_or("(无)"));
    println!("  两个字符串相同? {}", if ca_id == cp_id { "是 ✓" } else { "否 ✗（恢复路径会失效）" });
    if let Some(id) = &cp_id {
        match state_by_id(id) {
            Some(st) => println!("  用 cpal 的 id 调 CoreAudio GetDevice -> state={} ✓", state_name(st)),
            None => println!("  用 cpal 的 id 调 CoreAudio GetDevice -> 失败 ✗"),
        }
    }
    // 顺便验证：能查到「已拔出」和「不存在」的端点状态（恢复流程靠它判断原设备回没回来）
    for (i, d) in host.output_devices().map(|x| x.collect::<Vec<_>>()).unwrap_or_default().iter().enumerate() {
        if let Ok(id) = d.id() {
            let st = state_by_id(&id.1);
            println!("  cpal[{i}] id 查询 -> {:?}", st.map(state_name));
        }
    }
}

fn dump_all() {
    println!("=== CoreAudio 渲染端点 ===");
    match enumerator() {
        Ok(e) => {
            match unsafe { e.GetDefaultAudioEndpoint(eRender, eConsole) } {
                Ok(d) => {
                    let st = unsafe { d.GetState() }.unwrap_or(DEVICE_STATE(0));
                    println!("  默认端点: {}  state={}", endpoint_id(&d), state_name(st));
                }
                Err(err) => println!("  默认端点: (取不到) {err}"),
            }
            match unsafe { e.EnumAudioEndpoints(eRender, DEVICE_STATE(DEVICE_STATEMASK_ALL)) } {
                Ok(col) => {
                    let n = unsafe { col.GetCount() }.unwrap_or(0);
                    println!("  共 {n} 个渲染端点:");
                    for i in 0..n {
                        if let Ok(d) = unsafe { col.Item(i) } {
                            let st = unsafe { d.GetState() }.unwrap_or(DEVICE_STATE(0));
                            println!("    [{i}] {}  state={}", endpoint_id(&d), state_name(st));
                        }
                    }
                }
                Err(err) => println!("  EnumAudioEndpoints 失败: {err}"),
            }
        }
        Err(err) => println!("  CoCreateInstance(MMDeviceEnumerator) 失败: {err}"),
    }
    println!("=== cpal / rodio 视角 ===");
    dump_cpal();
    cross_check();
}

fn main() {
    // 安全：只影响本线程的 COM 公寓
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let watch = std::env::args().any(|a| a == "--watch");
    if !watch {
        dump_all();
        return;
    }
    println!("(watch 模式：每 500ms 采样一次；只打印 ACTIVE/DISABLED/UNPLUGGED 的端点及其变化。");
    println!(" 现在拔掉耳机、再插回去，观察哪个端点状态怎么翻、默认端点变成谁。Ctrl+C 退出)");
    // (id, state, 是否默认) —— 过滤掉一堆 NOTPRESENT 噪音
    let mut last: Vec<(String, u32, bool)> = Vec::new();
    loop {
        let mut snap: Vec<(String, u32, bool)> = Vec::new();
        if let Ok(e) = enumerator() {
            let default_id = unsafe { e.GetDefaultAudioEndpoint(eRender, eConsole) }
                .ok()
                .map(|d| endpoint_id(&d));
            if let Ok(col) = unsafe { e.EnumAudioEndpoints(eRender, DEVICE_STATE(DEVICE_STATEMASK_ALL)) } {
                let n = unsafe { col.GetCount() }.unwrap_or(0);
                for i in 0..n {
                    if let Ok(d) = unsafe { col.Item(i) } {
                        let st = unsafe { d.GetState() }.map(|s| s.0).unwrap_or(0);
                        if st == DEVICE_STATE_NOTPRESENT.0 {
                            continue;
                        }
                        let id = endpoint_id(&d);
                        let is_default = default_id.as_deref() == Some(id.as_str());
                        snap.push((id, st, is_default));
                    }
                }
            }
        }
        if snap != last {
            println!("--- 变化 ---");
            for (id, st, is_default) in &snap {
                println!(
                    "  {}{}  {}",
                    if *is_default { "[默认] " } else { "        " },
                    id,
                    state_name(DEVICE_STATE(*st))
                );
            }
            last = snap;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}
