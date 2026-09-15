//! 音乐库扫描：目录遍历（walkdir）+ 并行元数据提取（rayon）+ 批量入库（rusqlite）
//! 事件：scan-progress（started/scanning/done/cancelled/error）、library-updated
//! 封面：metadata 阶段提取内嵌封面写 <cover_dir>/<path_hash>.<ext>，cover_key 入库

use crate::db::{self, TrackMeta};
use crate::error::{AppError, AppResult};
use crate::models::{LibraryUpdatedPayload, ScanProgressPayload, ScanStage};
use rayon::prelude::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// 解析阶段进度事件的时间节流间隔（毫秒）。太小会放大 IPC 与前端重渲染，
/// 太大则进度条一顿一顿。
const PROGRESS_EMIT_MS: i64 = 100;

/// 当前时间（毫秒）；只用于进度节流
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 扫描控制器：同一时刻最多一个扫描任务；运行中收到新请求则标记 pending
pub struct ScanControl {
    pub running: AtomicBool,
    pub pending: AtomicBool,
    pub cancel: AtomicBool,
}

impl Default for ScanControl {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            pending: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }
}

impl ScanControl {
    /// 请求一次扫描；已在运行则记 pending（本扫描结束后由下一次命令请求补跑）
    pub fn request(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        db: Arc<Mutex<rusqlite::Connection>>,
        db_path: PathBuf,
        cover_dir: PathBuf,
    ) {
        if self.running.swap(true, Ordering::SeqCst) {
            self.pending.store(true, Ordering::SeqCst);
            return;
        }
        let control = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            run_scan(app, db, db_path, cover_dir, control);
        });
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

fn mark_done(control: &Arc<ScanControl>) {
    control.running.store(false, Ordering::SeqCst);
    // 扫描期间有新的请求被合并时（pending），不在此递归启动，
    // 由命令层（scan_music_library）在 UI 动作后再次 request 即可。
    control.pending.store(false, Ordering::SeqCst);
}

/// 主扫描流程（阻塞线程中执行；可随时取消）
fn run_scan(
    app: tauri::AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    db_path: PathBuf,
    cover_dir: PathBuf,
    control: Arc<ScanControl>,
) {
    control.cancel.store(false, Ordering::SeqCst);
    let mut payload = ScanProgressPayload {
        stage: ScanStage::Started,
        root: None,
        scanned_files: 0,
        total_files: None,
        current_path: None,
        added: 0,
        updated: 0,
        removed: 0,
        error: None,
    };
    let _ = app.emit("scan-progress", &payload);

    let roots = match db.lock() {
        Ok(g) => db::list_folders(&g).map(|v| v.into_iter().map(|f| f.path).collect::<Vec<String>>()),
        Err(e) => Err(AppError::internal(format!("数据库锁异常: {e}"))),
    };
    let roots = match roots {
        Ok(r) if !r.is_empty() => r,
        Ok(_) => {
            payload.stage = ScanStage::Done;
            let _ = app.emit("scan-progress", &payload);
            mark_done(&control);
            return;
        }
        Err(e) => {
            payload.stage = ScanStage::Error;
            payload.error = Some(format!("{e}"));
            let _ = app.emit("scan-progress", &payload);
            mark_done(&control);
            return;
        }
    };

    // ---- 阶段 1：收集音频文件路径（可取消） ----
    let mut files: Vec<PathBuf> = Vec::new();
    'outer: for root in &roots {
        payload.root = Some(root.clone());
        for entry in walkdir::WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if control.cancel.load(Ordering::SeqCst) {
                break 'outer;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                let ext = ext.to_ascii_lowercase();
                if db::SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
                    files.push(entry.path().to_path_buf());
                }
            }
        }
    }

    if control.cancel.load(Ordering::SeqCst) {
        payload.stage = ScanStage::Cancelled;
        let _ = app.emit("scan-progress", &payload);
        mark_done(&control);
        return;
    }

    payload.stage = ScanStage::Scanning;
    payload.total_files = Some(files.len() as u64);
    let _ = app.emit("scan-progress", &payload);

    // ---- 阶段 2：并行提取元数据（rayon） ----
    // ⚠️ 进度分子必须在这一步涨：读标签 + 生成封面缩略图才是整次扫描耗时的大头，
    //    旧实现只在上面的入库循环里涨分子，于是整段解析期间进度恒为 0（"进度条不动"）。
    //    计数用原子量（解析失败的文件也算，保证能走到 100%），并按 PROGRESS_EMIT_MS
    //    时间节流发事件 —— 不节流的话 1 万首 = 1 万次 IPC + 1 万次前端重渲染。
    let parsed = AtomicU64::new(0);
    let last_emit_ms = AtomicI64::new(0);
    let total_files = files.len() as u64;
    let root_label = roots.first().cloned();
    let metas: Vec<(String, TrackMeta)> = files
        .par_iter()
        .filter_map(|p| {
            if control.cancel.load(Ordering::SeqCst) {
                return None;
            }
            let path = p.to_string_lossy().into_owned();
            let out = match read_metadata(p, &cover_dir) {
                Ok(mut meta) => {
                    meta.path = path.clone();
                    meta.file_mtime = mtime_secs(p);
                    meta.file_size = std::fs::metadata(p).map(|m| m.len() as i64).unwrap_or(0);
                    if meta.title.is_empty() {
                        meta.title = p
                            .file_stem()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_else(|| path.clone());
                    }
                    Some((path.clone(), meta))
                }
                Err(_) => None,
            };
            // —— 进度上报：每个文件都计数；100ms 节流，且同一时刻只允许一个线程发事件 ——
            let done = parsed.fetch_add(1, Ordering::Relaxed) + 1;
            let now = now_ms();
            let last = last_emit_ms.load(Ordering::Relaxed);
            if now - last >= PROGRESS_EMIT_MS
                && last_emit_ms
                    .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
            {
                let _ = app.emit(
                    "scan-progress",
                    &ScanProgressPayload {
                        stage: ScanStage::Scanning,
                        root: root_label.clone(),
                        scanned_files: done,
                        total_files: Some(total_files),
                        current_path: Some(path),
                        added: 0,
                        updated: 0,
                        removed: 0,
                        error: None,
                    },
                );
            }
            out
        })
        .collect();

    if control.cancel.load(Ordering::SeqCst) {
        payload.stage = ScanStage::Cancelled;
        let _ = app.emit("scan-progress", &payload);
        mark_done(&control);
        return;
    }

    // ---- 阶段 3：入库（逐条 upsert，WAL 下读线程不受影响） ----
    let conn = match db::open_db(&db_path) {
        Ok(c) => c,
        Err(e) => {
            payload.stage = ScanStage::Error;
            payload.error = Some(format!("{e}"));
            let _ = app.emit("scan-progress", &payload);
            mark_done(&control);
            return;
        }
    };

    // 整段一个事务。upsert_track 内部是 2 条语句（按 path 查 id + INSERT ... ON CONFLICT
    // RETURNING），不开事务时 1 万首 = 2 万条隐式事务，每条都要取写锁 + 写 WAL 帧，
    // 实测比开事务慢 5-10 倍。
    // ⚠️ 提交放在循环之后、**被取消时也提交** —— 旧实现是逐条提交，取消能保住已扫到的进度，
    // 若这里整段回滚就把那个行为改掉了。
    let tx = match conn.unchecked_transaction() {
        Ok(t) => t,
        Err(e) => {
            payload.stage = ScanStage::Error;
            payload.error = Some(format!("开启写入事务失败: {e}"));
            let _ = app.emit("scan-progress", &payload);
            mark_done(&control);
            return;
        }
    };

    let mut seen: HashSet<String> = HashSet::with_capacity(metas.len());
    let mut cancelled = false;
    for (i, (path, meta)) in metas.iter().enumerate() {
        if control.cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        seen.insert(path.clone());
        match db::upsert_track(&tx, meta) {
            Ok((_, existed)) => {
                if existed {
                    payload.updated += 1;
                } else {
                    payload.added += 1;
                }
            }
            Err(e) => {
                payload.error = Some(format!("写入失败 {path}: {e}"));
            }
        }
        // 分子在解析阶段就已经涨到 total；入库阶段只做单调保护，避免进度回退
        payload.scanned_files = parsed.load(Ordering::Relaxed).max(i as u64 + 1);
        if payload.scanned_files % 25 == 0 {
            let _ = app.emit("scan-progress", &payload);
        }
    }
    if let Err(e) = tx.commit() {
        payload.error = Some(format!("提交写入失败: {e}"));
    }
    if cancelled {
        payload.stage = ScanStage::Cancelled;
        let _ = app.emit("scan-progress", &payload);
        mark_done(&control);
        return;
    }

    // ---- 阶段 4：删除已移除的文件（仅限受管根目录内） ----
    if let Ok(all) = db::all_track_ids(&conn) {
        for id in all {
            if let Ok(Some(t)) = db::track_by_id(&conn, id) {
                let under_root = roots.iter().any(|r| t.path.starts_with(r));
                if under_root && !seen.contains(&t.path) {
                    if db::delete_track_by_id(&conn, id).is_ok() {
                        payload.removed += 1;
                    }
                }
            }
        }
    }

    for root in &roots {
        let _ = db::touch_folder(&conn, root);
    }

    // 封面缓存 GC：清掉不再被引用的缓存文件（内容寻址改造后的旧文件 + 已删曲目的封面）
    gc_cover_cache(&conn, &cover_dir);

    // ---- 阶段 5：收尾事件 ----
    let total_tracks = db::track_count(&conn).unwrap_or(0);
    let updated_event = LibraryUpdatedPayload {
        added: payload.added,
        updated: payload.updated,
        removed: payload.removed,
        total_tracks,
    };
    payload.stage = ScanStage::Done;
    let _ = app.emit("scan-progress", &payload);
    let _ = app.emit("library-updated", updated_event);

    if let Ok(g) = db.lock() {
        for root in &roots {
            let _ = db::touch_folder(&g, root);
        }
    }
    mark_done(&control);
}

// ---------------------------------------------------------------------------
// 元数据读取（lofty）
// ---------------------------------------------------------------------------

/// 读取标签元数据；内嵌封面直接写入封面缓存目录
pub fn read_metadata(path: &Path, cover_dir: &Path) -> AppResult<TrackMeta> {
    let tagged = lofty::probe::Probe::open(path)
        .map_err(|e| AppError::new(crate::error::E_DECODE, format!("Probe 失败: {e}")))?
        .read()
        .map_err(|e| AppError::new(crate::error::E_DECODE, format!("读取标签失败: {e}")))?;

    // TaggedFileExt: properties / tags（lofty 0.25）
    {
        use lofty::file::{AudioFile, TaggedFileExt};
        let props = tagged.properties();
        let mut meta = TrackMeta {
            duration_ms: props.duration().as_millis() as i64,
            sample_rate: props.sample_rate().map(|v| v as i64),
            bitrate: props.audio_bitrate().map(|v| v as i64),
            channels: props.channels().map(|v| v as i64),
            format: path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase(),
            ..Default::default()
        };

        if let Some(tag) = tagged.tags().first() {
            use lofty::tag::{Accessor, ItemKey};
            meta.title = tag.title().map(|s| s.into_owned()).unwrap_or_default();
            meta.artist = tag.artist().map(|s| s.into_owned()).unwrap_or_default();
            meta.album = tag.album().map(|s| s.into_owned()).unwrap_or_default();
            meta.genre = tag.genre().map(|s| s.into_owned()).unwrap_or_default();
            meta.album_artist = tag
                .get_string(ItemKey::AlbumArtist)
                .map(|s| s.to_string())
                .unwrap_or_default();
            meta.year = tag.date().map(|d| i64::from(d.year));
            meta.track_no = tag.track().map(|t| i64::from(t));
            meta.disc_no = tag.disk().map(|d| i64::from(d));

            if let Some(picture) = tag.pictures().first() {
                let bytes = picture.data();
                if let Some(ext) = sniff_image_ext(bytes) {
                    // 内容寻址：同一张封面被多首歌内嵌时（字节完全相同）只存一份。
                        // 原来是 path_hash(path) —— 按文件路径，导致同专辑每首歌各存一份原图+缩略图
                        // （实测 10000 首会累积约 4.5GB）。
                        let key = content_key(bytes, ext);
                    if std::fs::create_dir_all(cover_dir).is_ok() {
                        let src = cover_path_for(cover_dir, &key);
                        // 原图已存在且字节数一致 → 认定封面没变：原图与缩略图都不重写。
                        // 没有这个跳过，每次重扫都要把上万张封面重新写盘 + 解码缩放，白烧几分钟。
                        let unchanged = std::fs::metadata(&src)
                            .map(|m| m.len() == bytes.len() as u64)
                            .unwrap_or(false);
                        let src_ok = unchanged || std::fs::write(&src, bytes).is_ok();
                        if src_ok {
                            let thumb = thumb_path_for(cover_dir, &key);
                            if !unchanged || !thumb.is_file() {
                                write_cover_thumb(bytes, &thumb);
                            }
                            meta.cover_key = Some(key);
                        }
                    }
                }
            }
        }
        return Ok(meta);
    }
}
/// 封面内容哈希（FNV-1a 64）+ 字节长度：用作持久化缓存文件名。
/// 为什么不用 std 的 DefaultHasher：它不保证跨 Rust 版本稳定，而这是要长期留在磁盘上的名字。
/// 带上长度是为了让哈希碰撞也无害（长度不同就不会互相覆盖）。
fn content_key(bytes: &[u8], ext: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}-{:x}.{}", h, bytes.len(), ext)
}

/// 回收封面缓存中不再被任何曲目引用的文件（含 .tmp 残留）。
/// 场景：① 改成内容寻址后，旧的「按路径命名」文件变成孤儿；② 删曲目时不会删封面文件。
/// ⚠️ 查询失败时直接返回 —— 宁可留垃圾，也绝不能因为一次读库失败就删掉整个缓存。
fn gc_cover_cache(conn: &rusqlite::Connection, cover_dir: &Path) {
    let Ok(keys) = db::all_cover_keys(conn) else { return };
    let mut keep: std::collections::HashSet<String> = std::collections::HashSet::with_capacity(keys.len() * 2);
    for k in keys {
        if let Some((stem, _)) = k.rsplit_once(".") {
            keep.insert(format!("thumb/{stem}.jpg"));
        }
        keep.insert(k);
    }
    let mut stack: Vec<std::path::PathBuf> = vec![cover_dir.to_path_buf()];
    let mut removed = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { stack.push(p); continue; }
            let Ok(rel) = p.strip_prefix(cover_dir) else { continue };
            let rel = rel.to_string_lossy().replace(char::from(92), "/");
            if !keep.contains(&rel) && std::fs::remove_file(&p).is_ok() { removed += 1; }
        }
    }
    if removed > 0 {
        eprintln!("[scan] 封面缓存回收 {} 个孤儿文件", removed);
    }
}
pub fn cover_path_for(cover_dir: &Path, key: &str) -> PathBuf {
    cover_dir.join(key)
}

/// 缩略图长边像素。前端用到封面的地方最大是封面流的 260px 卡片，400px 足以覆盖 HiDPI，
/// 而 JPEG 质量 84 下约 30-45KB —— 相比原图平均 439KB（实测本机）降了一个数量级。
const THUMB_MAX: u32 = 400;

/// 缩略图路径：`cover_cache/thumb/<key 去掉扩展名>.jpg`（统一输出 JPEG）
pub fn thumb_path_for(cover_dir: &Path, key: &str) -> PathBuf {
    let stem = key.rsplit_once('.').map(|(s, _)| s).unwrap_or(key);
    cover_dir.join("thumb").join(format!("{stem}.jpg"))
}

/// 从内嵌封面原始字节生成缩略图并落盘。
/// 失败一律返回 false 并静默放弃：宁可退回原图，也不能让一张坏图打断整个扫描。
fn write_cover_thumb(bytes: &[u8], thumb_path: &Path) -> bool {
    use image::imageops::FilterType;
    let Ok(img) = image::load_from_memory(bytes) else { return false };
    let thumb = img.resize(THUMB_MAX, THUMB_MAX, FilterType::CatmullRom);
    // 带 alpha 的先合成到白底：专辑封面偶尔是透明 PNG，直接转 RGB 会把透明区压成黑块
    let rgb = if thumb.color().has_alpha() {
        let rgba = thumb.to_rgba8();
        let mut out = image::RgbImage::new(rgba.width(), rgba.height());
        for (dst, src) in out.pixels_mut().zip(rgba.pixels()) {
            let a = u32::from(src[3]);
            *dst = image::Rgb([
                ((u32::from(src[0]) * a + 255 * (255 - a)) / 255) as u8,
                ((u32::from(src[1]) * a + 255 * (255 - a)) / 255) as u8,
                ((u32::from(src[2]) * a + 255 * (255 - a)) / 255) as u8,
            ]);
        }
        out
    } else {
        thumb.to_rgb8()
    };
    let Some(parent) = thumb_path.parent() else { return false };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    // 先写临时文件再改名：避免 player_cover 读到写了一半的图
    let tmp = thumb_path.with_extension("tmp");
    let Ok(mut f) = std::fs::File::create(&tmp) else { return false };
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 84);
    if enc.encode_image(&rgb).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    drop(f);
    std::fs::rename(&tmp, thumb_path).is_ok()
}


/// 图片魔数嗅探 → 扩展名
pub fn sniff_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("png")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

pub fn mime_of_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

pub fn mtime_secs(p: &Path) -> i64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 通用 base64（用于封面 data-url）
pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}