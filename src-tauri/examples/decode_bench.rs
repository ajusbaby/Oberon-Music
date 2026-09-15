//! 解码吞吐微基准 —— 回答一个问题：**解码会不会超过音频回调周期（典型 10ms）**。
//!
//! 用法（在 src-tauri 下）：
//!   cargo run --release --example decode_bench -- "D:\path\file.flac" 20
//!
//! 口径：每 1024 个采样计一次耗时。1024 采样 = 512 帧，
//! 44.1kHz 立体声 ≈ 11.6ms 音频、48kHz 立体声 ≈ 10.7ms 音频 —— 与回调周期同量级，
//! 所以「单块耗时的 p99/max」可以直接和 10ms 预算比较。
use rodio::Source;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = match args.get(1) { Some(p) => p.clone(), None => { eprintln!("usage: decode_bench <file> [seconds]"); std::process::exit(2); } };
    let secs: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20.0);

    let t_open = Instant::now();
    let f = std::fs::File::open(&path).expect("open file");
    let size_mb = f.metadata().map(|m| m.len() as f64 / 1e6).unwrap_or(0.0);
    // 这一步就是 open_decoder()：建 BufReader + 读头 + 建立 Symphonia 上下文
    let decoder = rodio::Decoder::new(std::io::BufReader::new(f)).expect("decode init");
    let init_ms = t_open.elapsed().as_secs_f64() * 1000.0;
    let ch = decoder.channels().get() as f64;
    let rate = decoder.sample_rate().get() as f64;

    let mut it = decoder;
    let mut samples: u64 = 0;
    let mut blocks: Vec<f64> = Vec::new();
    const BLOCK: usize = 1024;
    let t0 = Instant::now();
    let guard = std::time::Duration::from_secs(300);
    while samples as f64 / (rate * ch) < secs && t0.elapsed() < guard {
        let tb = Instant::now();
        let mut got = 0usize;
        while got < BLOCK {
            match it.next() { Some(_) => { got += 1; } None => break }
        }
        if got == 0 { break }
        samples += got as u64;
        blocks.push(tb.elapsed().as_secs_f64() * 1000.0);
    }
    let wall = t0.elapsed().as_secs_f64();
    let audio = samples as f64 / (rate * ch);
    blocks.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pick = |p: f64| -> f64 {
        if blocks.is_empty() { return 0.0 }
        blocks[((blocks.len() as f64 - 1.0) * p).round() as usize]
    };
    let name = std::path::Path::new(&path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    println!("文件            {}", name);
    println!("大小            {:.1} MB", size_mb);
    println!("格式            {} Hz / {} 声道", rate as u32, ch as u32);
    println!("打开+建解码器   {:.2} ms   （= 切歌时 Decoder::new 的成本）", init_ms);
    println!("解码音频时长    {:.1} s（实际耗时 {:.3} s）", audio, wall);
    println!("实时倍率        {:.1} x   （>100x 表示解码只占 1% CPU）", if wall > 0.0 { audio / wall } else { 0.0 });
    println!("每块({} 采样 ≈ 10ms 音频)耗时：", BLOCK);
    println!("    p50 {:.3} ms   p90 {:.3} ms   p99 {:.3} ms   max {:.3} ms   （预算 10ms）", pick(0.50), pick(0.90), pick(0.99), pick(1.0));
    let over = blocks.iter().filter(|t| **t > 10.0).count();
    println!("    > 10ms 的块数占比 {:.3}%   （{} / {}）", if blocks.is_empty() {0.0} else {100.0 * over as f64 / blocks.len() as f64}, over, blocks.len());
}