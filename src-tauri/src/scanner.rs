//! 音乐库扫描：目录遍历（walkdir）+ 并行元数据提取（rayon）+ 批量入库（rusqlite）
//! 事件：scan-progress（started/scanning/done/cancelled/error）、library-updated
//! 封面：metadata 阶段提取内嵌封面写 <cover_dir>/<path_hash>.<ext>，cover_key 入库

use crate::db::{self, TrackMeta};
use crate::error::{AppError, AppResult};
use crate::models::{LibraryUpdatedPayload, ScanProgressPayload, ScanStage};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Emitter;

/// 一次 `Instant` 起点的耗时（毫秒）
fn ms(t0: Instant) -> f64 {
    t0.elapsed().as_secs_f64() * 1000.0
}

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
            // 生产路径：事件发到前端。分阶段耗时在这里没有消费者，直接丢弃。
            let _ = run_scan(&app, db, db_path, cover_dir, control);
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

/// 扫描事件的接收端。
///
/// 生产实现就是 Tauri 的 `AppHandle`（emit 到前端）；无头基准可以换成只计数、
/// 或什么都不发的实现。这样 `run_scan` 不再和 Tauri 绑死 ——
/// 外部基准跑到的就是**应用真正在跑的那条扫描路径**，而不是另抄一份的复刻品。
pub trait ScanSink: Sync {
    fn progress(&self, payload: &ScanProgressPayload);
    fn library_updated(&self, payload: &LibraryUpdatedPayload);
}

impl ScanSink for tauri::AppHandle {
    fn progress(&self, payload: &ScanProgressPayload) {
        let _ = self.emit("scan-progress", payload);
    }
    fn library_updated(&self, payload: &LibraryUpdatedPayload) {
        let _ = self.emit("library-updated", payload);
    }
}

/// 一次扫描的分阶段耗时（毫秒）与计数。
///
/// 存在的理由：以前想回答「导入一首歌慢在哪」只能靠掐秒表和猜。
/// 阶段边界就是 `run_scan` 里那几段，测量点贴着真实代码，没有额外开销。
#[derive(Debug, Clone, Default)]
pub struct ScanTimings {
    /// 读「已登记的音乐根目录」
    pub list_roots_ms: f64,
    /// 阶段 1：walkdir 收集音频文件
    pub walk_ms: f64,
    /// 阶段 1.5a：打开扫描专用数据库连接（含建表/迁移）
    pub open_db_ms: f64,
    /// 阶段 1.5b：一次读全表的 (path, mtime, size)
    pub read_stamps_ms: f64,
    /// 阶段 1.5c：逐文件 stat + 与库里比对，决定是否重新解析
    pub diff_ms: f64,
    /// 阶段 2：rayon 并行读标签 + 解码内嵌封面 + 生成缩略图
    pub parse_ms: f64,
    /// 阶段 3：单事务 upsert 全部曲目
    pub insert_ms: f64,
    /// 阶段 4：差集删除已移除文件
    pub delete_ms: f64,
    /// 阶段 4 尾：封面缓存 GC
    pub gc_ms: f64,
    /// 收尾：回到主库连接 touch_folder
    pub finish_ms: f64,
    /// 整次扫描（含发事件）
    pub total_ms: f64,
    /// 磁盘上扫到的音频文件数
    pub files_on_disk: usize,
    /// 其中因为 (mtime, size) 未变而被跳过的
    pub skipped: usize,
    /// 实际进入解析阶段的
    pub to_parse: usize,
    /// 解析失败（Probe/读取标签出错，文件不会入库）
    pub failed_parse: usize,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    /// 走到正常收尾（差集删除 + 封面 GC 都跑完）。生产路径据此决定要不要打收尾日志
    pub completed: bool,
}

/// 这个文件是否需要重新解析标签？
/// 路径、修改时间（秒）与字节数三者全同才算「没变」—— 跳过它可以省掉一次标签读取
/// 加一次内嵌封面解码，这正是把 1 万首库的重扫从几分钟压到几秒的关键。
/// ⚠️ mtime <= 0 表示 stat 失败/时间不可用，必须当成「需要解析」：否则这个文件永远不再被重试。
/// ⚠️ 库里没有这个路径 ⇒ 新文件，当然要解析。
fn needs_reparse(known: &HashMap<String, (i64, i64)>, path: &str, mtime: i64, size: i64) -> bool {
    if mtime <= 0 {
        return true;
    }
    match known.get(path) {
        Some(&(known_mtime, known_size)) => known_mtime != mtime || known_size != size,
        None => true,
    }
}

/// 主扫描流程（阻塞线程中执行；可随时取消）。
///
/// 泛型 `S` 是事件接收端：生产传 `tauri::AppHandle`，无头基准传自己的实现 ——
/// 于是基准跑到的就是应用真正在跑的那条扫描路径，而不是另抄一份的复刻品。
/// 返回值是分阶段耗时，生产路径可以忽略。
pub fn run_scan<S: ScanSink>(
    sink: &S,
    db: Arc<Mutex<rusqlite::Connection>>,
    db_path: PathBuf,
    cover_dir: PathBuf,
    control: Arc<ScanControl>,
) -> ScanTimings {
    let t0 = Instant::now();
    let mut t = run_scan_inner(sink, db, db_path, cover_dir, control);
    t.total_ms = ms(t0);
    // 只有走到正常收尾才打日志 —— 与旧行为一致（无根目录 / 出错 / 取消都不打）
    if t.completed {
        eprintln!(
            "[scan] 完成：新增 {} / 更新 {} / 删除 {}；未变跳过 {} / 重新解析 {}（磁盘上共 {} 个音频文件）",
            t.added, t.updated, t.removed, t.skipped, t.to_parse, t.files_on_disk
        );
        eprintln!(
            "[scan] 阶段(ms)：收集 {:.1} / 开库 {:.1} / 读戳 {:.1} / 比对 {:.1} / 解析 {:.1} / 入库 {:.1} / 差集删除 {:.1} / GC {:.1} / 收尾 {:.1}；合计 {:.1}",
            t.walk_ms, t.open_db_ms, t.read_stamps_ms, t.diff_ms, t.parse_ms, t.insert_ms, t.delete_ms, t.gc_ms, t.finish_ms, t.total_ms
        );
    }
    t
}

fn run_scan_inner<S: ScanSink>(
    sink: &S,
    db: Arc<Mutex<rusqlite::Connection>>,
    db_path: PathBuf,
    cover_dir: PathBuf,
    control: Arc<ScanControl>,
) -> ScanTimings {
    let mut t = ScanTimings::default();
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
    sink.progress(&payload);

    let t_roots = Instant::now();
    let roots = match db.lock() {
        Ok(g) => db::list_folders(&g).map(|v| v.into_iter().map(|f| f.path).collect::<Vec<String>>()),
        Err(e) => Err(AppError::internal(format!("数据库锁异常: {e}"))),
    };
    t.list_roots_ms = ms(t_roots);
    let roots = match roots {
        Ok(r) if !r.is_empty() => r,
        Ok(_) => {
            payload.stage = ScanStage::Done;
            sink.progress(&payload);
            mark_done(&control);
            return t;
        }
        Err(e) => {
            payload.stage = ScanStage::Error;
            payload.error = Some(format!("{e}"));
            sink.progress(&payload);
            mark_done(&control);
            return t;
        }
    };

    // ---- 阶段 1：收集音频文件路径（可取消） ----
    let t_walk = Instant::now();
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
    t.walk_ms = ms(t_walk);
    t.files_on_disk = files.len();

    if control.cancel.load(Ordering::SeqCst) {
        payload.stage = ScanStage::Cancelled;
        sink.progress(&payload);
        mark_done(&control);
        return t;
    }

    payload.stage = ScanStage::Scanning;
    payload.total_files = Some(files.len() as u64);
    sink.progress(&payload);

    let total_files = files.len() as u64;

    // ---- 阶段 1.5：未变文件跳过（增量扫描的核心） ----
    // 旧实现对每个文件无条件 read_metadata（读标签 + 解码内嵌封面），而 file_mtime / file_size
    // 虽然入了库却从没有任何地方读过它 —— 于是目录监听每次防抖触发的那次「增量扫描」，
    // 实际是把整个曲库重新解析一遍（1 万首 = 每次几分钟）。
    // 这里先 stat（极便宜）再与库里的 (mtime, size) 比对，只有新增/改动的文件才进解析。
    // ⚠️ mtime 精度是秒（库里的 file_mtime 就是秒）：同一秒内改动两次且字节数不变会漏检。
    //    这是拿「偶发漏检」换「每次全库重读标签」，与主流播放器的做法一致。
    // ⚠️ seen 现在收集的是**磁盘上实际存在的全部文件**（含标签解析失败的），不再是「解析成功的」。
    //    旧实现里某次标签解析失败的文件会被当成「已删除」而丢掉整行记录 —— 顺带修掉了。
    // ⚠️ 数据库连接要在这里就打开（增量比对需要读现有记录），阶段 3 不再重开。
    let t_open = Instant::now();
    let conn = match db::open_db(&db_path) {
        Ok(c) => c,
        Err(e) => {
            payload.stage = ScanStage::Error;
            payload.error = Some(format!("{e}"));
            sink.progress(&payload);
            mark_done(&control);
            return t;
        }
    };
    t.open_db_ms = ms(t_open);

    // 读不到现有记录时 known 为空 ⇒ 退化成全量解析
    // （绝不能因为一次读库失败就认为「文件都没了」，那会让后面的差集删除清空曲库）
    let t_stamps = Instant::now();
    let known: HashMap<String, (i64, i64)> = db::all_track_file_stamps(&conn)
        .map(|list| list.into_iter().map(|(_, path, mtime, size)| (path, (mtime, size))).collect())
        .unwrap_or_default();
    t.read_stamps_ms = ms(t_stamps);

    let t_diff = Instant::now();
    let mut to_parse: Vec<PathBuf> = Vec::with_capacity(files.len());
    let mut seen: HashSet<String> = HashSet::with_capacity(files.len());
    let mut done_base: u64 = 0;
    for p in files {
        let path = p.to_string_lossy().into_owned();
        let mtime = mtime_secs(&p);
        let size = std::fs::metadata(&p).map(|m| m.len() as i64).unwrap_or(0);
        seen.insert(path.clone());
        if needs_reparse(&known, &path, mtime, size) {
            to_parse.push(p);
        } else {
            done_base += 1;
        }
    }
    t.diff_ms = ms(t_diff);
    t.skipped = done_base as usize;
    t.to_parse = to_parse.len();
    // 先把「已跳过」的部分报出去，进度条才不会在解析开始前一直停在 0
    payload.scanned_files = done_base;
    sink.progress(&payload);

    // ---- 阶段 2：并行提取元数据（rayon） ----
    // ⚠️ 进度分子必须在这一步涨：读标签 + 生成封面缩略图才是整次扫描耗时的大头，
    //    旧实现只在上面的入库循环里涨分子，于是整段解析期间进度恒为 0（"进度条不动"）。
    //    计数用原子量（解析失败的文件也算，保证能走到 100%），并按 PROGRESS_EMIT_MS
    //    时间节流发事件 —— 不节流的话 1 万首 = 1 万次 IPC + 1 万次前端重渲染。
    let t_parse = Instant::now();
    let parsed = AtomicU64::new(0);
    let last_emit_ms = AtomicI64::new(0);
    let root_label = roots.first().cloned();
    let metas: Vec<(String, TrackMeta)> = to_parse
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
            let done = done_base + parsed.fetch_add(1, Ordering::Relaxed) + 1;
            let now = now_ms();
            let last = last_emit_ms.load(Ordering::Relaxed);
            if now - last >= PROGRESS_EMIT_MS
                && last_emit_ms
                    .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
            {
                sink.progress(&ScanProgressPayload {
                    stage: ScanStage::Scanning,
                    root: root_label.clone(),
                    scanned_files: done,
                    total_files: Some(total_files),
                    current_path: Some(path),
                    added: 0,
                    updated: 0,
                    removed: 0,
                    error: None,
                });
            }
            out
        })
        .collect();
    t.parse_ms = ms(t_parse);
    t.failed_parse = to_parse.len().saturating_sub(metas.len());

    if control.cancel.load(Ordering::SeqCst) {
        payload.stage = ScanStage::Cancelled;
        sink.progress(&payload);
        mark_done(&control);
        return t;
    }

    // ---- 阶段 3：入库（逐条 upsert，WAL 下读线程不受影响） ----
    // 连接已在阶段 1.5 打开（增量比对需要读现有记录），这里不再重开。

    // 整段一个事务。upsert_track 内部是 2 条语句（按 path 查 id + INSERT ... ON CONFLICT
    // RETURNING），不开事务时 1 万首 = 2 万条隐式事务，每条都要取写锁 + 写 WAL 帧，
    // 实测比开事务慢 5-10 倍。
    // ⚠️ 提交放在循环之后、**被取消时也提交** —— 旧实现是逐条提交，取消能保住已扫到的进度，
    // 若这里整段回滚就把那个行为改掉了。
    let t_insert = Instant::now();
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(e) => {
            payload.stage = ScanStage::Error;
            payload.error = Some(format!("开启写入事务失败: {e}"));
            sink.progress(&payload);
            mark_done(&control);
            return t;
        }
    };

    let mut cancelled = false;
    for (i, (path, meta)) in metas.iter().enumerate() {
        if control.cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
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
        // 分子在解析阶段就已经涨到 total（含阶段 1.5 跳过的 done_base）；
        // 入库阶段只做单调保护，避免进度回退
        payload.scanned_files = (done_base + i as u64 + 1).max(payload.scanned_files);
        if payload.scanned_files % 25 == 0 {
            sink.progress(&payload);
        }
    }
    if let Err(e) = tx.commit() {
        payload.error = Some(format!("提交写入失败: {e}"));
    }
    t.insert_ms = ms(t_insert);
    if cancelled {
        payload.stage = ScanStage::Cancelled;
        sink.progress(&payload);
        mark_done(&control);
        return t;
    }

    // ---- 阶段 4：删除已移除的文件（仅限受管根目录内） ----
    let t_delete = Instant::now();
    if let Ok(all) = db::all_track_ids(&conn) {
        for id in all {
            if let Ok(Some(tr)) = db::track_by_id(&conn, id) {
                let under_root = roots.iter().any(|r| tr.path.starts_with(r));
                if under_root && !seen.contains(&tr.path) {
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
    t.delete_ms = ms(t_delete);

    // 封面缓存 GC：清掉不再被引用的缓存文件（内容寻址改造后的旧文件 + 已删曲目的封面）
    let t_gc = Instant::now();
    gc_cover_cache(&conn, &cover_dir);
    t.gc_ms = ms(t_gc);

    // ---- 阶段 5：收尾事件 ----
    let total_tracks = db::track_count(&conn).unwrap_or(0);
    let updated_event = LibraryUpdatedPayload {
        added: payload.added,
        updated: payload.updated,
        removed: payload.removed,
        total_tracks,
    };
    payload.stage = ScanStage::Done;
    sink.progress(&payload);
    sink.library_updated(&updated_event);

    t.added = payload.added as usize;
    t.updated = payload.updated as usize;
    t.removed = payload.removed as usize;

    let t_finish = Instant::now();
    if let Ok(g) = db.lock() {
        for root in &roots {
            let _ = db::touch_folder(&g, root);
        }
    }
    t.finish_ms = ms(t_finish);
    mark_done(&control);
    t.completed = true;
    t
}

// ---------------------------------------------------------------------------
// 元数据读取（lofty）
// ---------------------------------------------------------------------------

/// 读取标签元数据；内嵌封面直接写入封面缓存目录
pub fn read_metadata(path: &Path, cover_dir: &Path) -> AppResult<TrackMeta> {
    // DSD（.dsf/.dff）：lofty 不认识这两种容器，走 dsd-reader 的支路。
    // ⚠️ 不加这一段的话这两个扩展名虽然能解码，却会在这里 Probe 失败 → 文件被扫描器丢掉，
    //    变成「能播但收不进库」。
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "dsf" || ext == "dff" {
        return read_dsd_metadata(path, &ext, cover_dir);
    }

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

/// DSD 的元数据：容器头（dsd-reader 解析）+ 内嵌 ID3（DSF/DFF 用的是 ID3v2，不是 lofty 那套）。
fn read_dsd_metadata(path: &Path, ext: &str, cover_dir: &Path) -> AppResult<TrackMeta> {
    let Some(d) = crate::engine::dsd::probe(path.to_string_lossy().as_ref()) else {
        return Err(AppError::new(
            crate::error::E_DECODE,
            format!("无法解析 DSD 文件: {}", path.display()),
        ));
    };
    let mut meta = TrackMeta {
        title: d.title,
        artist: d.artist,
        album: d.album,
        genre: d.genre,
        year: d.year,
        track_no: d.track_no,
        duration_ms: d.duration_ms,
        sample_rate: Some(d.sample_rate),
        channels: Some(d.channels),
        // DSD 是 1-bit 流，没有传统意义的"码率"；留空比填个误导性的数字好
        bitrate: None,
        format: ext.to_string(),
        ..Default::default()
    };
    // 封面：与 lofty 那条路一样走内容寻址缓存
    if let Some((bytes, ext_hint)) = d.picture {
        let sniffed = sniff_image_ext(&bytes).unwrap_or(ext_hint);
        let key = content_key(&bytes, sniffed);
        if std::fs::create_dir_all(cover_dir).is_ok() {
            let src = cover_path_for(cover_dir, &key);
            let unchanged = std::fs::metadata(&src)
                .map(|m| m.len() == bytes.len() as u64)
                .unwrap_or(false);
            if unchanged || std::fs::write(&src, &bytes).is_ok() {
                let thumb = thumb_path_for(cover_dir, &key);
                if !unchanged || !thumb.is_file() {
                    write_cover_thumb(&bytes, &thumb);
                }
                meta.cover_key = Some(key);
            }
        }
    }
    Ok(meta)
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
    use std::io::Write;
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
    let Ok(f) = std::fs::File::create(&tmp) else { return false };
    // ⚠️ 这里必须套 BufWriter：image 的 JPEG 编码器是**逐字节**写出熵编码数据的，
    //    直接把 File 交给它就是「每字节一次 WriteFile」—— 实测一张 400px 缩略图 52ms，
    //    是「编码到内存再落盘」（3ms）的 17 倍，也是整次导入里最大的一笔开销。
    //    这个是导入基准（examples/import_bench.rs 场景 E）测出来的，别改回去。
    let mut w = std::io::BufWriter::new(f);
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, 84);
    if enc.encode_image(&rgb).is_err() {
        drop(enc);
        drop(w);
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    drop(enc);
    if w.flush().is_err() {
        drop(w);
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    drop(w);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn known_one(path: &str, mtime: i64, size: i64) -> HashMap<String, (i64, i64)> {
        let mut m = HashMap::new();
        m.insert(path.to_string(), (mtime, size));
        m
    }


    /// 裸 AAC(.aac) 能不能被 lofty 读出元数据？
    /// 这决定了它能否入库 —— 「能播但扫不到」和「扫得到但播不了」都是坏的。
    #[test]
    fn reads_metadata_for_adts_aac_sample() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.build/samples/ct_faac-adts.aac");
        if !p.exists() {
            eprintln!("跳过（缺 .aac 样本）");
            return;
        }
        let covers = std::env::temp_dir().join("oberon_cover_probe");
        match read_metadata(&p, &covers) {
            Ok(m) => eprintln!(
                "[test] .aac 元数据：title={:?} duration={}ms rate={:?} ch={:?}",
                m.title, m.duration_ms, m.sample_rate, m.channels
            ),
            Err(e) => panic!("lofty 读不了 .aac（→ 该文件无法入库）: {e}"),
        }
    }

    /// Ogg Opus 的元数据（lofty 支持 Opus，这里确认一下）
    #[test]
    fn reads_metadata_for_opus_sample() {
        let p = std::env::temp_dir().join("oberon_opus_test.opus");
        if !p.exists() {
            eprintln!("跳过（先把 opus.rs 的往返测试跑一遍生成样本）");
            return;
        }
        let covers = std::env::temp_dir().join("oberon_cover_probe");
        match read_metadata(&p, &covers) {
            Ok(m) => eprintln!(
                "[test] .opus 元数据：title={:?} duration={}ms rate={:?} ch={:?}",
                m.title, m.duration_ms, m.sample_rate, m.channels
            ),
            Err(e) => panic!("lofty 读不了 .opus（→ 该文件无法入库）: {e}"),
        }
    }

    /// 路径 + mtime + size 三者全同 ⇒ 跳过（增量扫描的核心收益）
    #[test]
    fn unchanged_file_is_skipped() {
        let known = known_one("C:/Music/a.flac", 1_700_000_000, 40_000_000);
        assert!(!needs_reparse(&known, "C:/Music/a.flac", 1_700_000_000, 40_000_000));
    }

    /// 修改时间变了 ⇒ 必须重新解析（否则改过的标签/封面永远不刷新）
    #[test]
    fn changed_mtime_triggers_reparse() {
        let known = known_one("C:/Music/a.flac", 1_700_000_000, 40_000_000);
        assert!(needs_reparse(&known, "C:/Music/a.flac", 1_700_000_001, 40_000_000));
    }

    /// mtime 精度是秒：同一秒内改过、时间戳没变但字节数变了 ⇒ 也必须重新解析
    #[test]
    fn changed_size_triggers_reparse() {
        let known = known_one("C:/Music/a.flac", 1_700_000_000, 40_000_000);
        assert!(needs_reparse(&known, "C:/Music/a.flac", 1_700_000_000, 40_000_001));
    }

    /// 库里没有这个路径 ⇒ 新文件，要解析
    #[test]
    fn unknown_path_triggers_reparse() {
        let known = known_one("C:/Music/a.flac", 1_700_000_000, 40_000_000);
        assert!(needs_reparse(&known, "C:/Music/b.flac", 1_700_000_000, 40_000_000));
    }

    /// mtime 取不到（stat 失败）⇒ 绝不能当成「没变」，否则这个文件永远不再被重试
    #[test]
    fn zero_mtime_always_reparses() {
        let known = known_one("C:/Music/a.flac", 0, 40_000_000);
        assert!(needs_reparse(&known, "C:/Music/a.flac", 0, 40_000_000));
        let known_ok = known_one("C:/Music/a.flac", 1_700_000_000, 40_000_000);
        assert!(needs_reparse(&known_ok, "C:/Music/a.flac", 0, 40_000_000));
    }

    /// 空表（比如读 stamps 失败后的退化值）⇒ 一律解析，等于退回全量扫描
    #[test]
    fn empty_known_reparses_everything() {
        let known: HashMap<String, (i64, i64)> = HashMap::new();
        assert!(needs_reparse(&known, "C:/Music/a.flac", 1, 1));
    }
}
