//! seek 远跳基准（不依赖声卡）：测三级回退里的 tier-2 与最坏情况 tier-3。
//! 用法: cargo run --release --example seek_bench -- "<目录>" [最多文件数]
//!
//! app 的真实顺序（engine/audio.rs + engine/mod.rs::seek_to）：
//!   1) Player::try_seek  —— 有活声卡时才有效（基准里没有设备，调它会阻塞，故不测）
//!   2) Decoder::try_seek —— 本基准测这个（seek_decoder 的实现）
//!   3) 逐样本前向排水      —— 本基准测排水速率，再外推最坏情况
use rodio::Source;
use std::path::PathBuf;
use std::time::{Duration, Instant};

type Dec = rodio::Decoder<std::io::BufReader<std::fs::File>>;

fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() { walk(&p, out); }
        else if let Some(x) = p.extension().and_then(|s| s.to_str()) {
            let x = x.to_ascii_lowercase();
            if matches!(x.as_str(), "flac" | "mp3" | "m4a" | "wav" | "ogg") { out.push(p); }
        }
    }
}

fn open(p: &std::path::Path) -> Option<Dec> {
    let f = std::fs::File::open(p).ok()?;
    rodio::Decoder::new(std::io::BufReader::new(f)).ok()
}

fn skip_forward(dec: &mut Dec, target: Duration) -> (f64, f64) {
    let rate = dec.sample_rate().get() as f64;
    let ch = dec.channels().get() as f64;
    let need = (target.as_secs_f64() * rate * ch).ceil() as u64;
    let t = Instant::now();
    let mut seen: u64 = 0;
    while seen < need {
        if dec.next().is_none() { break }
        seen += 1;
    }
    (seen as f64 / (rate * ch), t.elapsed().as_secs_f64())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.get(1).cloned().unwrap_or_else(|| ".".to_string());
    let limit: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut files: Vec<PathBuf> = Vec::new();
    walk(std::path::Path::new(&dir), &mut files);
    files.sort();
    if limit > 0 { files.truncate(limit); }
    println!("目录 {}（{} 个文件）", dir, files.len());
    let mut ok2 = 0usize;
    let mut times: Vec<f64> = Vec::new();
    let mut fails: Vec<String> = Vec::new();
    let mut longest: (f64, String, String) = (0.0, String::new(), String::new());
    for (i, p) in files.iter().enumerate() {
        let Some(mut dec) = open(p) else {
            fails.push(p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
            continue;
        };
        let dur = dec.total_duration().map(|d| d.as_secs_f64()).unwrap_or(0.0);
        let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut this: Vec<f64> = Vec::new();
        let mut all_ok = true;
        for frac in [0.25f64, 0.5, 0.75, 0.9] {
            let t = Instant::now();
            if dec.try_seek(Duration::from_secs_f64(dur * frac)).is_err() { all_ok = false; }
            this.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        if all_ok { ok2 += 1; } else { fails.push(name.clone()); }
        times.extend(this.iter().copied());
        if dur > longest.0 { longest = (dur, name.clone(), p.to_string_lossy().to_string()); }
        if i < 8 {
            println!("  {:<30} {:>6.1}m  25%={:.2}ms 50%={:.2}ms 75%={:.2}ms 90%={:.2}ms  {}", name.chars().take(28).collect::<String>(), dur / 60.0, this[0], this[1], this[2], this[3], if all_ok { "OK" } else { "FAIL" });
        }
        if i % 50 == 0 { print!(""); }
    }
    let pctl = |mut v: Vec<f64>, p: f64| -> f64 {
        if v.is_empty() { return 0.0 }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[((v.len() as f64 - 1.0) * p).round() as usize]
    };
    println!();
    println!("tier2（Decoder::try_seek，即 seek_decoder）成功 {}/{}", ok2, files.len());
    if !fails.is_empty() { println!("  失败: {:?}", &fails[..fails.len().min(5)]); }
    println!("  单次耗时 p50 {:.3} ms   p90 {:.3} ms   p99 {:.3} ms   max {:.3} ms",
        pctl(times.clone(), 0.5), pctl(times.clone(), 0.9), pctl(times.clone(), 0.99), pctl(times.clone(), 1.0));
    println!();
    if !longest.1.is_empty() {
        if let Some(mut d) = open(std::path::Path::new(&longest.2)) {
            let probe = 30.0f64;
            let (got, secs) = skip_forward(&mut d, Duration::from_secs_f64(probe));
            let rate = if secs > 0.0 { got / secs } else { 0.0 };
            println!("tier3（逐样本排水）实测：{} 秒音频耗时 {:.3} s ⇒ {:.1}x 实时", got, secs, rate);
            println!("  最长文件 {} 时长 {:.1} 分钟：若真走到 tier3，远跳到 90% 需 ~{:.1} s", longest.1, longest.0 / 60.0, (longest.0 * 0.9) / rate.max(0.001));
        }
    }
}