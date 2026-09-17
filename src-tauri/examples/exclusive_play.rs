//! 独占输出**实跑**：用 WASAPI 独占模式把一段正弦送到设备。
//!
//! 为什么先做成 example：这一步要把「事件驱动 + GetBuffer/ReleaseBuffer + 字节转换」
//! 整条渲染链路跑起来，而它最终会替换主程序的输出层。先在 example 里跑通、**能用耳朵验**，
//! 再搬进引擎 —— 这样即使写错也不会把主播放路径搞坏。
//!
//! 用法：
//!   cargo run --example exclusive_play                        # 16bit/48k 3 秒 1kHz
//!   cargo run --example exclusive_play -- --fmt 24            # 24-in-32（hifi 常见形态）
//!   cargo run --example exclusive_play -- --rate 44100        # 44.1k（会走对齐重试）
//!   cargo run --example exclusive_play -- --amp 0             # 静音跑一遍（只验链路）

use std::time::{Duration, Instant};
use wasapi::{
    initialize_mta, DeviceEnumerator, Direction, SampleType, ShareMode, StreamMode, WaveFormat,
};

#[derive(Clone, Copy, PartialEq, Debug)]
enum OutFmt {
    /// 16 位整数（字节序明确，先拿它验通路）
    I16,
    /// 32 位容器装 24 位有效：板载声卡/USB DAC 最常见的 hifi 形态
    I24in32,
}

fn bytes_per_frame(f: OutFmt, ch: usize) -> usize {
    match f {
        OutFmt::I16 => 2 * ch,
        OutFmt::I24in32 => 4 * ch,
    }
}

/// f32 → 设备格式的字节。⚠️ 24-in-32 用**左对齐**（有效位在高 24 位），
/// 这是 WASAPI 对 wValidBitsPerSample < wBitsPerSample 的要求。
fn push_sample(out: &mut Vec<u8>, v: f32, f: OutFmt) {
    let v = v.clamp(-1.0, 1.0);
    match f {
        OutFmt::I16 => out.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes()),
        OutFmt::I24in32 => {
            let s = (v * 8_388_607.0) as i32;
            out.extend_from_slice(&(s << 8).to_le_bytes())
        }
    }
}

fn arg(name: &str, default: f64) -> f64 {
    let a: Vec<String> = std::env::args().collect();
    a.iter()
        .position(|x| x == name)
        .and_then(|i| a.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn main() {
    let rate = arg("--rate", 48_000.0) as usize;
    let secs = arg("--secs", 3.0);
    let freq = arg("--freq", 1000.0) as f32;
    let amp = arg("--amp", 0.2) as f32;
    let fmt = if arg("--fmt", 16.0) as i32 == 24 {
        OutFmt::I24in32
    } else {
        OutFmt::I16
    };
    let ch = 2usize;

    // WASAPI 基于 COM，**每个线程都要自己初始化**
    if initialize_mta().is_err() {
        eprintln!("initialize_mta 失败");
        std::process::exit(1);
    }

    let enumr = DeviceEnumerator::new().expect("DeviceEnumerator");
    let dev = enumr.get_default_device(&Direction::Render).expect("默认输出设备");
    println!("设备: {}", dev.get_friendlyname().unwrap_or_default());
    let mut client = dev.get_iaudioclient().expect("IAudioClient");

    let wf = match fmt {
        OutFmt::I16 => WaveFormat::new(16, 16, &SampleType::Int, rate, ch, None),
        OutFmt::I24in32 => WaveFormat::new(32, 24, &SampleType::Int, rate, ch, None),
    };
    println!("请求格式: {rate}Hz {ch}ch {:?}", fmt);

    // 先预检：Ok(None) 才是逐位支持
    match client.is_supported(&wf, &ShareMode::Exclusive) {
        Ok(None) => println!("预检: 独占逐位支持 ✓"),
        Ok(Some(_)) => {
            println!("预检: 只能近似支持，换 --fmt / --rate 再试");
            return;
        }
        Err(e) => {
            println!("预检: 不支持（{e}）—— 换 --fmt / --rate 再试");
            return;
        }
    }

    let (def_period, _min) = client.get_device_period().expect("device period");
    let mut period = def_period;
    match client.initialize_client(&wf, &Direction::Render, &StreamMode::EventsExclusive { period_hns: def_period }) {
        Ok(()) => println!("Initialize: ok (period={period})"),
        Err(e) => {
            let msg = e.to_string();
            if !msg.contains("0x88890019") {
                eprintln!("Initialize 失败: {msg}");
                std::process::exit(1);
            }
            // 0x88890019 = BUFFER_SIZE_NOT_ALIGNED：按官方做法反算对齐后的时长重试
            let frames = client.get_buffer_size().expect("buffer size");
            period = (0.5 + 10_000_000.0 / rate as f64 * frames as f64) as i64;
            println!("命中 BUFFER_SIZE_NOT_ALIGNED → 对齐后 period={period} 重试");
            client
                .initialize_client(&wf, &Direction::Render, &StreamMode::EventsExclusive { period_hns: period })
                .expect("对齐后 Initialize");
            println!("Initialize: ok (对齐)");
        }
    }

    let event = client.set_get_eventhandle().expect("event handle");
    let render = client.get_audiorenderclient().expect("render client");
    let buf_frames = client.get_buffer_size().expect("buffer size") as usize;
    client.start_stream().expect("start_stream");
    println!("开始播放 {secs} 秒（buf={buf_frames} 帧）…");

    let bpf = bytes_per_frame(fmt, ch);
    let t0 = Instant::now();
    let mut frame_no: usize = 0;
    let mut bytes = Vec::with_capacity(buf_frames * bpf);
    let mut last_report = Instant::now();

    while t0.elapsed().as_secs_f64() < secs {
        // 事件驱动：等驱动发信号（超时给 200ms，便于检查退出条件）
        let _ = event.wait_for_event(200);
        let Ok(free) = client.get_available_space_in_frames() else {
            continue;
        };
        let n = free as usize;
        if n == 0 {
            continue;
        }
        bytes.clear();
        for _ in 0..n {
            let t = frame_no as f32 / rate as f32;
            let v = if amp == 0.0 {
                0.0
            } else {
                (2.0 * std::f32::consts::PI * freq * t).sin() * amp
            };
            for _ in 0..ch {
                push_sample(&mut bytes, v, fmt);
            }
            frame_no += 1;
        }
        if let Err(e) = render.write_to_device(n, &bytes, None) {
            eprintln!("write_to_device 失败: {e}");
            break;
        }
        if last_report.elapsed() > Duration::from_millis(500) {
            println!(
                "  已播 {:.2}s（{frame_no} 帧）",
                frame_no as f64 / rate as f64
            );
            last_report = Instant::now();
        }
    }

    let _ = client.stop_stream();
    println!(
        "完成：共 {} 帧 / {:.2}s，实际用时 {:.2}s{}",
        frame_no,
        frame_no as f64 / rate as f64,
        t0.elapsed().as_secs_f64(),
        if (frame_no as f64 / rate as f64 - t0.elapsed().as_secs_f64()).abs() < 0.3 {
            "  ← 实时性正常"
        } else {
            "  ← 注意：与实际用时偏差较大"
        }
    );
}
