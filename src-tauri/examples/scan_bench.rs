//! 扫描（导入）吞吐基准：忠实复刻 scanner.rs::read_metadata，用同一套依赖与参数。
//! 用法: cargo run --release --example scan_bench -- "<目录>" [上限] [--write <临时目录>]
//!
//! 复刻要点（与 scanner.rs 对齐）：
//!   Probe::open(path).read()  → 标签与属性
//!   内嵌封面：写原图（std::fs::write） + 生成 400px/JPEG q84/CatmullRom 缩略图
//!   rayon par_iter 并行（与 files.par_iter() 一致）
use rayon::prelude::*;
use std::path::PathBuf;
use std::time::Instant;

fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() { walk(&p, out); }
        else if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
            let e = ext.to_ascii_lowercase();
            if matches!(e.as_str(), "flac" | "mp3" | "m4a" | "wav" | "ogg" | "aac" | "wma" | "aiff") { out.push(p); }
        }
    }
}

fn content_key(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes { h ^= u64::from(*b); h = h.wrapping_mul(0x0000_0100_0000_01b3); }
    format!("{:016x}-{:x}", h, bytes.len())
}

struct Row { meta_ms: f64, cover_ms: f64, write_ms: f64, orig_kb: f64, thumb_kb: f64, size_mb: f64, failed: bool, key: Option<String> }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.get(1).cloned().unwrap_or_else(|| ".".to_string());
    let limit: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
    let out_dir = PathBuf::from(std::env::temp_dir()).join("oberon_scan_bench");
    let _ = std::fs::create_dir_all(&out_dir);
    let mut files: Vec<PathBuf> = Vec::new();
    walk(std::path::Path::new(&dir), &mut files);
    files.sort();
    let total_found = files.len();
    files.truncate(limit);
    println!("目录            {}", dir);
    println!("音频文件        {} 个（本次处理 {} 个）", total_found, files.len());
    println!("并行线程        {}", rayon::current_num_threads());

    let t_all = Instant::now();
    let rows: Vec<Row> = files
        .par_iter()
        .enumerate()
        .map(|(i, p)| {
            let size_mb = std::fs::metadata(p).map(|m| m.len() as f64 / 1e6).unwrap_or(0.0);
            let t0 = Instant::now();
            let probed = lofty::probe::Probe::open(p).and_then(|pr| pr.read());
            let meta_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let (mut cover_ms, mut write_ms, mut orig_kb, mut thumb_kb) = (0.0, 0.0, 0.0, 0.0);
            let mut key: Option<String> = None;
            let mut failed = probed.is_err();
            if let Ok(tagged) = &probed {
                use lofty::file::TaggedFileExt;
                if let Some(tag) = tagged.tags().first() {
                    if let Some(pic) = tag.pictures().first() {
                        let bytes = pic.data();
                        key = Some(content_key(bytes));
                        orig_kb = bytes.len() as f64 / 1024.0;
                        let t1 = Instant::now();
                        match image::load_from_memory(bytes) {
                            Ok(img) => {
                                let thumb = img.resize(400, 400, image::imageops::FilterType::CatmullRom);
                                let rgb = thumb.to_rgb8();
                                let mut buf: Vec<u8> = Vec::new();
                                let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 84);
                                if enc.encode_image(&rgb).is_err() { failed = true; }
                                thumb_kb = buf.len() as f64 / 1024.0;
                                // 与 scanner 一致：原图与缩略图都落盘
                                let t2 = Instant::now();
                                let a = out_dir.join(format!("{i}.orig"));
                                let b = out_dir.join(format!("{i}.jpg"));
                                let _ = std::fs::write(&a, bytes);
                                let _ = std::fs::write(&b, &buf);
                                write_ms = t2.elapsed().as_secs_f64() * 1000.0;
                            }
                            Err(_) => { failed = true; }
                        }
                        cover_ms = t1.elapsed().as_secs_f64() * 1000.0;
                    }
                }
            }
            Row { meta_ms, cover_ms, write_ms, orig_kb, thumb_kb, size_mb, failed, key }
        })
        .collect();
    let wall = t_all.elapsed().as_secs_f64();

    let pctl = |mut v: Vec<f64>, p: f64| -> f64 {
        if v.is_empty() { return 0.0 }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[((v.len() as f64 - 1.0) * p).round() as usize]
    };
    let has = |r: &Row| r.thumb_kb > 0.0;
    let n_cover = rows.iter().filter(|r| has(r)).count();
    let total_ms: f64 = rows.iter().map(|r| r.meta_ms + r.cover_ms).sum();
    let total_mb: f64 = rows.iter().map(|r| r.size_mb).sum();
    let avg_orig: f64 = if n_cover > 0 { rows.iter().filter(|r| has(r)).map(|r| r.orig_kb).sum::<f64>() / n_cover as f64 } else { 0.0 };
    let avg_thumb: f64 = if n_cover > 0 { rows.iter().filter(|r| has(r)).map(|r| r.thumb_kb).sum::<f64>() / n_cover as f64 } else { 0.0 };
    println!();
    println!("壁钟总耗时      {:.2} s（rayon 并行）", wall);
    println!("CPU 累计        {:.2} s（元数据+封面，{:.1}x 加速）", total_ms / 1000.0, if wall > 0.0 { total_ms / 1000.0 / wall } else { 0.0 });
    println!("吞吐            {:.1} 文件/秒   {:.1} MB/秒（源文件）", files.len() as f64 / wall, total_mb / wall);
    println!();
    println!("元数据          p50 {:.2}  p90 {:.2}  max {:.2} ms", pctl(rows.iter().map(|r| r.meta_ms).collect(), 0.5), pctl(rows.iter().map(|r| r.meta_ms).collect(), 0.9), pctl(rows.iter().map(|r| r.meta_ms).collect(), 1.0));
    println!("封面处理        p50 {:.2}  p90 {:.2}  max {:.2} ms（{} / {} 带内嵌封面）", pctl(rows.iter().filter(|r| has(r)).map(|r| r.cover_ms).collect(), 0.5), pctl(rows.iter().filter(|r| has(r)).map(|r| r.cover_ms).collect(), 0.9), pctl(rows.iter().filter(|r| has(r)).map(|r| r.cover_ms).collect(), 1.0), n_cover, rows.len());
    println!("封面写盘        p50 {:.2} ms（原图 {:.0} KB + 缩略图 {:.0} KB）", pctl(rows.iter().filter(|r| has(r)).map(|r| r.write_ms).collect(), 0.5), avg_orig, avg_thumb);
    println!("解析失败        {} 个", rows.iter().filter(|r| r.failed).count());
    println!();
    let per = total_ms / rows.len() as f64;
    println!("每文件 CPU 均值 {:.1} ms", per);
    println!("⇒ 10000 首（本机 16 逻辑核，8 物理核）估算：{:.0} s ≈ {:.1} 分钟", per * 10000.0 / 1000.0 / 8.0, per * 10000.0 / 1000.0 / 8.0 / 60.0);
    let mut ks: Vec<String> = rows.iter().filter_map(|r| r.key.clone()).collect();
    let with_key = ks.len();
    ks.sort(); ks.dedup();
    let uniq = ks.len();
    let ratio = if uniq > 0 { with_key as f64 / uniq as f64 } else { 1.0 };
    println!();
    println!("封面去重：{} 个文件带封面 ⇒ {} 个不同内容（去重 {:.2}x）", with_key, uniq, ratio);
    println!("⇒ 缓存体积（内容寻址后）：{:.2} GB / 10000 首", (avg_orig + avg_thumb) * 10000.0 / ratio / 1024.0 / 1024.0);
    println!("   （改造前按文件路径命名则是 {:.2} GB / 10000 首）", (avg_orig + avg_thumb) * 10000.0 / 1024.0 / 1024.0);
}