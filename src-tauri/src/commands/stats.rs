//! 听歌统计命令：读 / 写 / 合并 / 元数据解析
//!
//! 前端（src/lib/listenLog.ts）仍然自己聚合「日 / 周 / 月 / 年」，这里只负责**把账本落到文件里**，
//! 并且保证落点不在 WebView2 的 profile 里 —— 卸载、清理工具、重置系统都不会顺手带走它。

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::stats::{self, MergeReport, TrackMeta};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// 镜像副本最多每分钟写一次：主副本已经足够及时，文档目录那份只需要"别落后太多"
const MIRROR_INTERVAL_MS: i64 = 60_000;
static LAST_MIRROR_MS: AtomicI64 = AtomicI64::new(0);

const MIRROR_README: &str = "这是 Oberon 的听歌统计备份（listening.json）。\n\
Oberon 每次记录都会同时写这里一份；重装、换机器之后把整个文件夹带走，\n\
在「设置 → 数据与关于 → 听歌统计」里选择恢复即可读回全部历史。\n";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn primary_path(state: &AppState) -> PathBuf {
    state.data_dir.join("listening.json")
}

fn mirror_path(app: &AppHandle) -> Option<PathBuf> {
    stats::mirror_path(app.path().document_dir().ok())
}

fn read_opt(path: &PathBuf) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsRead {
    /// 有效副本的 JSON 文本；两份都不存在时为 null
    pub json: Option<String>,
    /// primary | mirror | none
    pub source: String,
    pub primary: String,
    pub mirror: Option<String>,
    pub updated_ms: f64,
}

/// 读：主副本优先，主副本缺失 / 损坏 / 比镜像旧时用镜像
#[tauri::command]
pub fn stats_read(app: AppHandle, state: State<'_, Arc<AppState>>) -> AppResult<StatsRead> {
    let primary = primary_path(state.inner());
    let mirror = mirror_path(&app);
    let primary_text = read_opt(&primary).filter(|t| stats::is_valid(t));
    let mirror_text = mirror.as_ref().and_then(read_opt).filter(|t| stats::is_valid(t));

    let primary_ms = primary_text.as_deref().map(stats::updated_ms_of).unwrap_or(0.0);
    let mirror_ms = mirror_text.as_deref().map(stats::updated_ms_of).unwrap_or(0.0);

    let (json, source, updated_ms) = match (primary_text, mirror_text) {
        (Some(_), Some(m)) if mirror_ms > primary_ms + 1000.0 => (Some(m), "mirror", mirror_ms),
        (Some(p), _) => (Some(p), "primary", primary_ms),
        (None, Some(m)) => (Some(m), "mirror", mirror_ms),
        (None, None) => (None, "none", 0.0),
    };

    Ok(StatsRead {
        json,
        source: source.to_string(),
        primary: primary.display().to_string(),
        mirror: mirror.map(|p| p.display().to_string()),
        updated_ms,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsWriteReport {
    pub primary: String,
    pub mirror: Option<String>,
    pub bytes: usize,
    pub mirror_bytes: usize,
    pub saved_ms: i64,
    /// 镜像没写成功时的原因（主副本成功即可）
    pub warning: Option<String>,
    pub mirror_written: bool,
}

/// 写：主副本每次都写，镜像是节流的
#[tauri::command]
pub fn stats_write(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    json: String,
    force_mirror: Option<bool>,
) -> AppResult<StatsWriteReport> {
    if !stats::is_valid(&json) {
        return Err(AppError::param("统计数据结构不合法（缺 days 或 v）"));
    }
    let primary = primary_path(state.inner());
    let bytes = json.as_bytes();
    stats::write_atomic(&primary, bytes)?;

    let mut mirror_written = false;
    let mut mirror_bytes = 0usize;
    let mut warning = None;
    let now = now_ms();
    let mirror = mirror_path(&app);
    let due = force_mirror.unwrap_or(false)
        || now - LAST_MIRROR_MS.load(Ordering::Relaxed) >= MIRROR_INTERVAL_MS;
    if let (true, Some(path)) = (due, mirror.as_ref()) {
        match stats::write_atomic(path, bytes) {
            Ok(()) => {
                mirror_written = true;
                mirror_bytes = bytes.len();
                LAST_MIRROR_MS.store(now, Ordering::Relaxed);
                if let Some(dir) = path.parent() {
                    let readme = dir.join("请先看这里.txt");
                    if !readme.exists() {
                        let _ = std::fs::write(&readme, MIRROR_README);
                    }
                }
            }
            Err(e) => warning = Some(format!("镜像备份没写成：{}", e.message)),
        }
    }

    Ok(StatsWriteReport {
        primary: primary.display().to_string(),
        mirror: mirror.map(|p| p.display().to_string()),
        bytes: bytes.len(),
        mirror_bytes,
        saved_ms: now,
        warning,
        mirror_written,
    })
}

/// 合并：把任意几份 JSON（含旧版按 trackId 记账的）并成一份 v3
#[tauri::command]
pub fn stats_merge(state: State<'_, Arc<AppState>>, parts: Vec<String>) -> AppResult<MergeReport> {
    let resolve = resolve_table(state.inner())?;
    Ok(stats::merge(&parts, &resolve))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsInfo {
    pub primary: String,
    pub mirror: Option<String>,
    pub primary_bytes: i64,
    pub mirror_bytes: i64,
    pub saved_ms: f64,
    pub mirror_saved_ms: f64,
}

#[tauri::command]
pub fn stats_info(app: AppHandle, state: State<'_, Arc<AppState>>) -> AppResult<StatsInfo> {
    let primary = primary_path(state.inner());
    let mirror = mirror_path(&app);

    let (primary_bytes, saved_ms) = file_facts(&primary);
    let (mirror_bytes, mirror_saved_ms) = mirror.as_ref().map(file_facts).unwrap_or((0, 0.0));

    Ok(StatsInfo {
        primary: primary.display().to_string(),
        mirror: mirror.map(|p| p.display().to_string()),
        primary_bytes,
        mirror_bytes,
        saved_ms,
        mirror_saved_ms,
    })
}

fn file_facts(path: &PathBuf) -> (i64, f64) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (0, 0.0),
    };
    let saved = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    (meta.len() as i64, saved)
}

/// 从任意 JSON 文件导入（用户在文件选择器里挑的备份）
#[tauri::command]
pub fn stats_import_file(path: String) -> AppResult<String> {
    let target = PathBuf::from(&path);
    let text = std::fs::read_to_string(&target)
        .map_err(|e| AppError::io(format!("读取备份失败: {e}")))?;
    if !stats::is_valid(&text) {
        return Err(AppError::param("这个文件不是 Oberon 的听歌统计备份"));
    }
    Ok(text)
}

/// 导出到用户选定的文件（换机器、发给别人、丢进网盘都靠它）
#[tauri::command]
pub fn stats_export_file(path: String, json: String) -> AppResult<String> {
    if !stats::is_valid(&json) {
        return Err(AppError::param("统计数据结构不合法（缺 days 或 v）"));
    }
    let target = PathBuf::from(&path);
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError::io(format!("创建目录失败: {e}")))?;
    }
    std::fs::write(&target, json.as_bytes())
        .map_err(|e| AppError::io(format!("写备份失败: {e}")))?;
    Ok(target.to_string_lossy().to_string())
}

/// 把统计窗口用到的 trackKey 解析成当前曲库里的曲目（拿标题和封面用）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTrack {
    pub key: String,
    pub track_id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
}

#[tauri::command]
pub fn stats_resolve(state: State<'_, Arc<AppState>>, keys: Vec<String>) -> AppResult<Vec<ResolvedTrack>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let wanted: std::collections::HashSet<String> =
        keys.iter().map(|k| k.to_ascii_lowercase()).collect();
    let conn = state.db.lock().map_err(|_| AppError::internal("数据库忙"))?;
    let mut stmt = conn.prepare("SELECT id, path, title, artist, album FROM tracks")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, path, title, artist, album) = row?;
        let key = stats::track_key(&path);
        if wanted.contains(&key) {
            out.push(ResolvedTrack { key, track_id: id, path, title, artist, album });
        }
    }
    Ok(out)
}

/// 旧 id → 曲目元数据（迁移用）：一次全表扫，个人曲库几万行也就几十毫秒
fn resolve_table(state: &AppState) -> AppResult<HashMap<i64, TrackMeta>> {
    let conn = state.db.lock().map_err(|_| AppError::internal("数据库忙"))?;
    let mut stmt = conn.prepare("SELECT id, path, title, artist, album, duration_ms FROM tracks")?;
    let rows = stmt.query_map([], |r| {
        let dur_ms: i64 = r.get(5)?;
        Ok((
            r.get::<_, i64>(0)?,
            TrackMeta::from_row(
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                dur_ms as f64 / 1000.0,
            ),
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, meta) = row?;
        map.insert(id, meta);
    }
    Ok(map)
}

/// 在资源管理器里打开备份所在文件夹
#[tauri::command]
pub fn stats_reveal(app: AppHandle, state: State<'_, Arc<AppState>>) -> AppResult<()> {
    let target = mirror_path(&app)
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| state.data_dir.clone());
    let mut dir = target.clone();
    while !dir.exists() {
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => break,
        }
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| AppError::io(format!("打开文件夹失败: {e}")))?;
    }
    Ok(())
}
