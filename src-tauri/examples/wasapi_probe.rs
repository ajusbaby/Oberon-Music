//! WASAPI 独占能力探针（开发工具，不参与主程序）。
//!
//! 目的：在正式实现「独占输出」之前，先把**这台机器的能力边界**测出来，避免按错误假设开发。
//! 具体做四件事：
//!   1) 列出所有输出设备与它们在共享模式下的默认格式；
//!   2) 对每个设备打印**独占模式**下各采样率/位深的支持矩阵（IsFormatSupported）；
//!   3) 真正 Initialize(EventsExclusive) 一次，打印 period / buffer 大小并启停一次；
//!   4) 打开独占客户端后，再试一次同设备的独占初始化，观察「设备被占用」的返回码。
//!
//! 用法：
//!   cargo run --example wasapi_probe            # 只探测
//!   cargo run --example wasapi_probe -- --tone  # 顺便用独占模式播 0.5 秒 1kHz 正弦

use wasapi::{
    initialize_mta, DeviceEnumerator, Direction, SampleType, ShareMode, StreamMode, WaveFormat,
};

/// 探针要覆盖的采样率（44.1k 家族与 48k 家族，含 DSD 常用的 176.4k/352.8k/705.6k）
const RATES: [usize; 8] = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 352_800, 705_600];

/// 探针要覆盖的格式：(store_bits, valid_bits, 类型)
// ⚠️ 必须包含「32 位容器装 24 位有效」—— 这是板载声卡与 USB DAC 最常见的 hifi 格式；
//    只试 24/24 会把它误判成「不支持 24bit」（第一版探针就踩了这个坑）。
const FORMATS: [(usize, usize, SampleType); 5] = [
    (16, 16, SampleType::Int),
    (24, 24, SampleType::Int),
    (32, 24, SampleType::Int),
    (32, 32, SampleType::Int),
    (32, 32, SampleType::Float),
];

fn main() {
    let want_tone = std::env::args().any(|a| a == "--tone");

    // 独占模式下必须初始化 COM（MTA）
    let hr = initialize_mta();
    if hr.is_err() {
        eprintln!("initialize_mta 失败: {hr:?}");
        std::process::exit(1);
    }

    let enumerator = match DeviceEnumerator::new() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("DeviceEnumerator 创建失败: {e}");
            std::process::exit(1);
        }
    };

    // ---------- 1) 设备列表 + 共享模式默认格式 ----------
    println!("================ 输出设备 ================");
    let default_id = enumerator
        .get_default_device(&Direction::Render)
        .ok()
        .and_then(|d| d.get_id().ok());

    let collection = match enumerator.get_device_collection(&Direction::Render) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("枚举设备失败: {e}");
            std::process::exit(1);
        }
    };
    let n = collection.get_nbr_devices().unwrap_or(0);
    println!("共 {n} 个输出设备\n");

    for i in 0..n {
        let Ok(device) = collection.get_device_at_index(i) else {
            continue;
        };
        let name = device.get_friendlyname().unwrap_or_else(|_| "?".into());
        let id = device.get_id().unwrap_or_else(|_| "?".into());
        let is_default = Some(&id) == default_id.as_ref();
        println!(
            "[{i}] {}{}",
            name,
            if is_default { "   <== 默认设备" } else { "" }
        );
        println!("    id    : {id}");
        println!("    状态  : {:?}", device.get_state());
        // 共享模式下的默认格式（独占模式要与它协商）
        match device.get_device_format() {
            Ok(f) => println!("    默认格式(共享): {f:?}"),
            Err(e) => println!("    默认格式(共享): 读取失败 {e}"),
        }
    }

    // ---------- 2) 独占支持矩阵 ----------
    println!("\n================ 独占模式支持矩阵（立体声） ================");
    println!("说明：EXACT = 该格式被逐位支持（真 bit-perfect 可用）");
    println!("      NEAR  = 只能近似支持，括号里是驱动给的最近格式");
    println!("      NO    = 不支持\n");

    for i in 0..n {
        let Ok(device) = collection.get_device_at_index(i) else {
            continue;
        };
        let name = device.get_friendlyname().unwrap_or_else(|_| "?".into());
        let Ok(client) = device.get_iaudioclient() else {
            println!("[{i}] {name}: 拿不到 IAudioClient，跳过\n");
            continue;
        };
        println!("[{i}] {name}");
        for rate in RATES {
            let mut line = format!("    {rate:>6} Hz : ");
            for (store, valid, ty) in FORMATS {
                let fmt = WaveFormat::new(store, valid, &ty, rate, 2, None);
                // 标签是「有效位/容器位」：24/32 表示 32 位容器里装 24 位有效
                let tag = format!("{valid}/{store}");
                match client.is_supported(&fmt, &ShareMode::Exclusive) {
                    Ok(None) => line.push_str(&format!("{tag}=EXACT  ")),
                    Ok(Some(closest)) => {
                        line.push_str(&format!("{tag}=NEAR{closest:?}  "))
                    }
                    Err(_) => line.push_str(&format!("{tag}=NO     ")),
                }
            }
            println!("{line}");
        }
        // 有些驱动对上面那套判断不老实，wasapi 提供了带 quirks 的版本
        let quirks = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
        match client.is_supported_exclusive_with_quirks(&quirks) {
            Ok(v) => println!("    48k/32f 带 quirk 检查: {v:?}"),
            Err(e) => println!("    48k/32f 带 quirk 检查: 失败 {e}"),
        }
        println!();
    }

    // ---------- 3) 真正独占初始化一次 ----------
    println!("================ 独占初始化实测（默认设备） ================");
    let Ok(device) = enumerator.get_default_device(&Direction::Render) else {
        eprintln!("拿不到默认设备");
        return;
    };
    let Ok(mut client) = device.get_iaudioclient() else {
        eprintln!("拿不到 IAudioClient");
        return;
    };
    // 用设备共享模式的默认采样率去试独占（大多数设备能在这个率上独占）
    let shared = device.get_device_format().ok();
    println!("设备共享默认格式: {shared:?}");

    // 先**预检**出这家设备真正支持的独占格式，再拿它去初始化。
    // 第一版探针直接硬试 32f/48k，拿到 0x88890008（格式不支持）还误以为是「系统禁用了独占」。
    let mut candidates: Vec<(usize, usize, SampleType, usize)> = Vec::new();
    for rate in RATES {
        for (store, valid, ty) in [
            (32usize, 24usize, SampleType::Int),
            (24, 24, SampleType::Int),
            (32, 32, SampleType::Float),
            (32, 32, SampleType::Int),
            (16, 16, SampleType::Int),
        ] {
            let f = WaveFormat::new(store, valid, &ty, rate, 2, None);
            if matches!(client.is_supported(&f, &ShareMode::Exclusive), Ok(None)) {
                candidates.push((store, valid, ty, rate));
            }
        }
    }
    if candidates.is_empty() {
        println!("\n这家设备在独占模式下没有任何候选格式可用。");
        return;
    }
    println!("\n独占可用的候选格式（按偏好排序，前 6 个）：");
    for c in candidates.iter().take(6) {
        println!("    {}/{} {:?} @ {} Hz", c.1, c.0, c.2, c.3);
    }

    for (store, valid, ty, rate) in candidates.into_iter().take(4) {
        let fmt = WaveFormat::new(store, valid, &ty, rate, 2, None);
        let (def_period, min_period) = match client.get_device_period() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("get_device_period 失败: {e}");
                return;
            }
        };
        println!("\n尝试独占 {rate} Hz / {valid}/{store} {:?} / 2ch", ty);
        println!("  device period: default={def_period} min={min_period} (100ns)");
        let mode = StreamMode::EventsExclusive {
            period_hns: def_period,
        };
        match client.initialize_client(&fmt, &Direction::Render, &mode) {
            Ok(()) => {
                println!("  initialize_client(EventsExclusive) 成功");
                match client.set_get_eventhandle() {
                    Ok(_) => println!("  set_get_eventhandle 成功"),
                    Err(e) => println!("  set_get_eventhandle 失败: {e}"),
                }
                println!("  buffer_size = {:?} frames", client.get_buffer_size());
                println!("  padding     = {:?} frames", client.get_current_padding());
                println!("  可用空间    = {:?} frames", client.get_available_space_in_frames());

                match client.start_stream() {
                    Ok(()) => println!("  start_stream 成功（独占通路可用）"),
                    Err(e) => {
                        println!("  start_stream 失败: {e}");
                        continue;
                    }
                }
                // ---------- 4) 再开一个独占客户端，看「设备被占用」的返回码 ----------
                match enumerator.get_default_device(&Direction::Render) {
                    Ok(d2) => match d2.get_iaudioclient() {
                        Ok(mut c2) => {
                            let m2 = StreamMode::EventsExclusive {
                                period_hns: def_period,
                            };
                            match c2.initialize_client(&fmt, &Direction::Render, &m2) {
                                Ok(()) => println!("  第二个独占客户端: 竟然也成功了（设备允许多路独占）"),
                                Err(e) => println!("  第二个独占客户端失败（预期）: {e}"),
                            }
                        }
                        Err(e) => println!("  第二个客户端取 IAudioClient 失败: {e}"),
                    },
                    Err(e) => println!("  第二个客户端取设备失败: {e}"),
                }

                if want_tone {
                    play_tone(&client, rate);
                }
                let _ = client.stop_stream();
                println!("  已 stop_stream");
                return;
            }
            Err(e) => {
                let msg = format!("{e}");
                println!("  initialize_client 失败: {msg}");
                // 独占模式经典坑：0x88890019 = AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED。
                // 官方解法：取 GetBufferSize 的帧数 → 反算「对齐后」的时长(100ns 单位) → 重新 Initialize。
                // 44.1kHz 在这台设备上就踩到了，48kHz 没有 —— P0 必须实现这个重试。
                if msg.contains("0x88890019") {
                    if let Ok(frames) = client.get_buffer_size() {
                        let aligned = (0.5 + 10_000_000.0 / rate as f64 * frames as f64) as i64;
                        println!("  命中 BUFFER_SIZE_NOT_ALIGNED：用对齐后的 period {aligned} (100ns) 重试");
                        let mode2 = StreamMode::EventsExclusive {
                            period_hns: aligned,
                        };
                        match client.initialize_client(&fmt, &Direction::Render, &mode2) {
                            Ok(()) => println!("  对齐后 initialize_client 成功 OK"),
                            Err(e2) => println!("  对齐后仍失败: {e2}"),
                        }
                    }
                }
            }
        }
    }
    println!("\n结论：以上候选都没能独占初始化成功。");
    println!("常见失败码：0x88890008=格式不支持  0x8889000A=设备被别的程序占用");
    println!("            0x8889000E=系统里禁用了独占控制  0x88890004=设备已失效");
}

/// 往独占客户端写 0.5 秒的 1 kHz 正弦（32bit float 立体声）
fn play_tone(client: &wasapi::AudioClient, rate: usize) {
    use std::f32::consts::PI;
    let Ok(render) = client.get_audiorenderclient() else {
        println!("  取 AudioRenderClient 失败，跳过放音");
        return;
    };
    let Ok(buf_frames) = client.get_buffer_size() else {
        return;
    };
    let seconds = 0.5f32;
    let total_frames = (rate as f32 * seconds) as usize;
    let mut done = 0usize;
    println!("  开始放 1kHz 正弦 0.5 秒（独占）…");
    while done < total_frames {
        let Ok(free) = client.get_available_space_in_frames() else {
            break;
        };
        let n = (free as usize).min(total_frames - done).min(buf_frames as usize);
        if n == 0 {
            std::thread::sleep(std::time::Duration::from_millis(2));
            continue;
        }
        let mut bytes = Vec::with_capacity(n * 8);
        for k in 0..n {
            let t = (done + k) as f32 / rate as f32;
            let v = (2.0 * PI * 1000.0 * t).sin() * 0.2;
            // 立体声：左右相同
            bytes.extend_from_slice(&v.to_le_bytes());
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        match render.write_to_device(n, &bytes, None) {
            Ok(()) => done += n,
            Err(e) => {
                println!("  write_to_device 失败: {e}");
                break;
            }
        }
    }
    println!("  写入完成：{done} 帧");
}
