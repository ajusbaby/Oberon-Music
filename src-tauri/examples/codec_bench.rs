//! 解码内核吞吐基准 —— 用**应用真正使用的解码器**把文件整条解成 PCM，给出 ×实时。
//!
//! 用法（在 src-tauri 下）：
//!   cargo run --release --example codec_bench -- "<文件>" [重复次数]
//!
//! 口径（与 ffmpeg -benchmark 对齐，配套脚本 scripts/codec-bench.ps1 会合成一张表）：
//! - 耗时取「把整条音频解成 PCM」的**墙钟时间**与**进程 CPU 时间**，重复 N 次取最快一次；
//! - 实时倍率 = 音频时长 / 耗时（>1 表示能实时播放；>100 表示解码只占不到 1% CPU）；
//! - CPU 时间用 GetProcessTimes 取（内核 + 用户），和 ffmpeg 的 utime+stime 同口径。
//!   墙钟会被磁盘与调度影响，CPU 时间才是解码内核的真实成本。
//! - ⚠️ 我们这条链路的输出是 rodio 要的**交错 f32**；ffmpeg 的 `-f null -` 默认落到 s16。
//!   两者都含「解码 + 转成 PCM」的工作量，但位深转换不完全等价（f32 反而更贵一点）。

use oberon_lib::bench::{open_decoder, TrackDecoder};
use rodio::Source;
use std::time::Instant;

#[cfg(windows)]
mod cpu {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        lo: u32,
        hi: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetProcessTimes(
            h: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }

    fn ticks(t: FileTime) -> u64 {
        ((t.hi as u64) << 32) | t.lo as u64
    }

    /// 当前进程累计的（内核 + 用户）CPU 秒数
    pub fn cpu_secs() -> f64 {
        // 安全：只读当前进程的时间统计，不涉及任何跨线程对象
        unsafe {
            let mut c = FileTime::default();
            let mut e = FileTime::default();
            let mut k = FileTime::default();
            let mut u = FileTime::default();
            if GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) == 0 {
                return 0.0;
            }
            (ticks(k) + ticks(u)) as f64 / 1e7
        }
    }
}

#[cfg(not(windows))]
mod cpu {
    pub fn cpu_secs() -> f64 {
        0.0
    }
}

fn kind_of(d: &TrackDecoder) -> &'static str {
    match d {
        TrackDecoder::Symphonia(_) => "symphonia",
        TrackDecoder::Custom(_) => "oberon-custom",
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1).cloned() else {
        eprintln!("usage: codec_bench <file> [repeats]");
        std::process::exit(2);
    };
    let repeats: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3).max(1);
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // (wall, cpu, audio, rate, ch, kind)
    let mut best: Option<(f64, f64, f64, u32, u32, &'static str)> = None;
    let mut last_err = String::new();
    for _ in 0..repeats {
        let mut dec = match open_decoder(&path) {
            Ok(d) => d,
            Err(e) => {
                last_err = format!("{}", e.message);
                break;
            }
        };
        let rate = dec.sample_rate().get();
        let ch = dec.channels().get() as u32;
        let kind = kind_of(&dec);
        let c0 = cpu::cpu_secs();
        let t0 = Instant::now();
        let mut samples: u64 = 0;
        while dec.next().is_some() {
            samples += 1;
        }
        let wall = t0.elapsed().as_secs_f64();
        let cpu = (cpu::cpu_secs() - c0).max(0.0);
        let audio = samples as f64 / (rate as f64 * ch as f64);
        if best.as_ref().map(|b| wall < b.0).unwrap_or(true) {
            best = Some((wall, cpu, audio, rate, ch, kind));
        }
    }
    let Some((wall, cpu, audio, rate, ch, kind)) = best else {
        eprintln!("[codec_bench] 打开/解码失败：{last_err}");
        std::process::exit(1);
    };
    println!("文件        {name}");
    println!("大小        {:.1} MB", size as f64 / 1e6);
    println!("解码器      {kind}");
    println!("格式        {rate} Hz / {ch} ch");
    println!("音频时长    {audio:.2} s");
    println!("解码耗时    wall {wall:.3} s   cpu {cpu:.3} s（{repeats} 次取最快）");
    println!(
        "实时倍率    {:.1}x（wall）   {:.1}x（cpu）",
        audio / wall.max(1e-9),
        audio / cpu.max(1e-9)
    );
    // 机器可读行：scripts/codec-bench.ps1 解析它
    println!(
        "RESULT oberon kind={kind} rate={rate} ch={ch} audio={audio:.3} wall={wall:.3} cpu={cpu:.3}"
    );
}