//! 字体库命令：导入 / 列表 / 删除 / 取字节（文档《歌词自定义字体系统方案》§4）
//!
//! 存储：字体文件整体拷进 app_data/fonts/，文件名 = 内容哈希前 16 位 + face 序号 + 扩展名；
//! 元数据索引是同目录的 index.json（读取时整份反序列化，写入时原子替换）。
//!
//! 几个刻意的选择：
//!   · **不合并字体、不改轮廓**：导入只做"拷贝 + 解析 + 记索引"，缺字交给渲染时的字体链；
//!   · 去重按内容哈希，不按文件名 —— 同一个字体换个名字再导入也是同一个资源；
//!   · 解析失败仍然导入（parsed=false）：浏览器也许能渲染我们解析不了的表结构，
//!     但界面上必须说清楚"这个字体没有覆盖统计"，不能假装它什么都覆盖了。

use crate::error::{AppError, AppResult};
use crate::fonts::{
    self, FontResource, ImportFailure, ImportReport, MIN_FONT_BYTES, MAX_FONT_BYTES,
    SUPPORTED_EXTENSIONS,
};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Response;
use tauri::State;

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

fn load_index(dir: &Path) -> AppResult<Vec<FontResource>> {
    let path = index_path(dir);
    match std::fs::read(&path) {
        Ok(bytes) => {
            if bytes.is_empty() {
                return Ok(Vec::new());
            }
            serde_json::from_slice(&bytes)
                .map_err(|e| AppError::internal(format!("字体索引损坏（{}）: {e}", path.display())))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(AppError::io(format!("读取字体索引失败: {e}"))),
    }
}

fn save_index(dir: &Path, list: &[FontResource]) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let target = index_path(dir);
    let tmp = dir.join("index.json.tmp");
    let body = serde_json::to_vec_pretty(list)
        .map_err(|e| AppError::internal(format!("字体索引序列化失败: {e}")))?;
    std::fs::write(&tmp, body)?;
    // 原子替换：中途崩掉也不会留下半个索引（Windows 上 rename 目标已存在会失败，先删）
    if target.exists() {
        std::fs::remove_file(&target)?;
    }
    std::fs::rename(&tmp, &target)?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名字体".into())
}

/// 导入一个文件。返回 Ok(资源) 或 Err(给人看的原因)。
fn import_one(dir: &Path, existing: &mut Vec<FontResource>, path: &Path) -> Result<FontResource, (String, String)> {
    let fail = |msg: &str| (path.display().to_string(), msg.to_string());

    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(fail("只支持 ttf / otf / ttc / woff / woff2"));
    }
    let meta = std::fs::metadata(path).map_err(|e| fail(&format!("读不到这个文件: {e}")))?;
    if !meta.is_file() {
        return Err(fail("不是普通文件"));
    }
    if meta.len() < MIN_FONT_BYTES {
        return Err(fail("文件太小，不像字体"));
    }
    if meta.len() > MAX_FONT_BYTES {
        return Err(fail("文件超过 64MB 上限"));
    }
    let bytes = std::fs::read(path).map_err(|e| fail(&format!("读取失败: {e}")))?;
    let hash = fonts::sha256_hex(&bytes);

    if let Some(found) = existing.iter().find(|r| r.content_hash == hash) {
        return Ok(found.clone());
    }

    let parsed = fonts::parse(&bytes, 0);
    let (family, subfamily, postscript, weight, width, italic, embedding, axes, format, faces, face_index, codepoints, warning, parsed_ok) =
        match parsed {
            Ok(p) => {
                let warn = if p.faces > 1 {
                    Some(format!(
                        "这是字体集合（含 {} 个 face），浏览器无法指定 face，只使用第一个",
                        p.faces
                    ))
                } else {
                    None
                };
                (
                    if p.family.is_empty() { stem_of(path) } else { p.family },
                    p.subfamily,
                    p.postscript,
                    p.weight,
                    p.width,
                    p.italic,
                    p.embedding,
                    p.axes,
                    p.format,
                    p.faces,
                    p.face_index,
                    p.codepoints,
                    warn,
                    true,
                )
            }
            Err(e) => (
                stem_of(path),
                String::new(),
                None,
                400u16,
                5u16,
                false,
                0u16,
                Vec::new(),
                "unknown".to_string(),
                1u32,
                0u32,
                std::collections::BTreeSet::new(),
                Some(format!("无法解析字体表（{}），没有覆盖统计；仍会交给浏览器注册", e.message)),
                false,
            ),
        };

    let coverage = fonts::coverage_of(&codepoints);
    let scripts = fonts::scripts_of(&coverage);
    let ranges = fonts::ranges_of(&codepoints);
    let file_name = format!("{}-{}.{}", &hash[..16], face_index, ext);

    std::fs::create_dir_all(dir).map_err(|e| fail(&format!("创建字体目录失败: {e}")))?;
    let dest = dir.join(&file_name);
    let need_write = std::fs::metadata(&dest)
        .map(|m| m.len() != bytes.len() as u64)
        .unwrap_or(true);
    if need_write {
        let tmp = dir.join(format!("{file_name}.part"));
        std::fs::write(&tmp, &bytes).map_err(|e| fail(&format!("写入字体失败: {e}")))?;
        if dest.exists() {
            let _ = std::fs::remove_file(&dest);
        }
        std::fs::rename(&tmp, &dest).map_err(|e| fail(&format!("落盘字体失败: {e}")))?;
    }

    let id = format!("{}-{}", &hash[..12], face_index);
    let resource = FontResource {
        id,
        content_hash: hash,
        file_name,
        original_name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        byte_size: bytes.len() as u64,
        face_index,
        faces,
        family,
        subfamily,
        postscript,
        weight,
        width,
        italic,
        embedding,
        variable: !axes.is_empty(),
        axes,
        format,
        scripts,
        coverage,
        codepoints: codepoints.len() as u32,
        coverage_ranges: ranges,
        added_at: now_ms(),
        parsed: parsed_ok,
        warning,
        missing: false,
    };
    existing.push(resource.clone());
    Ok(resource)
}

/// 收养目录里"有文件但不在索引里"的字体。
///
/// 为什么要有这一步：早先的实现（已删除的 fonts.rs）直接把用户选的文件按原名拷进
/// app_data/fonts/，没有索引。升级后那些文件会变成看不见的孤儿 —— 用户明明导入过，
/// 列表里却空着。这里把孤儿按新规则（哈希命名 + 解析 + 写索引）登记一遍，幂等。
fn adopt_orphans(dir: &Path, list: &mut Vec<FontResource>) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let known: std::collections::HashSet<String> =
        list.iter().map(|r| r.file_name.clone()).collect();
    let mut changed = false;
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            SUPPORTED_EXTENSIONS.contains(&ext.as_str())
        })
        .filter(|p| {
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            !known.contains(&name)
        })
        .collect();
    paths.sort();
    for path in paths {
        let before = list.len();
        // 失败就跳过：孤儿文件可能是用户手动放进去的坏文件，不该让整个列表失败
        if let Ok(res) = import_one(dir, list, &path) {
            if list.len() != before {
                changed = true;
            }
            // 原件已经被登记成哈希命名的副本：删掉原名文件，否则每轮列表都会再"发现"它一次
            let target = dir.join(&res.file_name);
            if target != path {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    changed
}

/// 字体库列表。顺手把"文件已经不在了"的记录标出来（用户手动删了 app_data 里的文件）。
#[tauri::command]
pub async fn font_list(state: State<'_, Arc<AppState>>) -> AppResult<Vec<FontResource>> {
    let dir = state.font_dir.clone();
    let lock = state.fonts_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| AppError::internal("字体索引锁中毒"))?;
        let mut list = load_index(&dir)?;
        if adopt_orphans(&dir, &mut list) {
            save_index(&dir, &list)?;
        }
        for r in list.iter_mut() {
            r.missing = !dir.join(&r.file_name).exists();
        }
        Ok(list)
    })
    .await
    .map_err(|e| AppError::internal(format!("字体列表任务异常: {e}")))?
}

#[tauri::command]
pub async fn font_import(
    state: State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> AppResult<ImportReport> {
    let dir = state.font_dir.clone();
    let lock = state.fonts_lock.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<ImportReport> {
        if paths.is_empty() {
            return Ok(ImportReport::default());
        }
        let _guard = lock.lock().map_err(|_| AppError::internal("字体索引锁中毒"))?;
        let mut existing = load_index(&dir)?;
        let mut before: Vec<FontResource> = existing.clone();
        let mut report = ImportReport::default();
        for p in paths {
            let path = PathBuf::from(&p);
            match import_one(&dir, &mut existing, &path) {
                Ok(res) => {
                    // 哈希命中已有记录 = 重复导入；本次新入库 = 导入成功
                    if before.iter().any(|r| r.content_hash == res.content_hash) {
                        report.duplicates.push(res);
                    } else {
                        report.imported.push(res.clone());
                        before.push(res);
                    }
                }
                Err((path, message)) => report.failed.push(ImportFailure { path, message }),
            }
        }
        save_index(&dir, &existing)?;
        Ok(report)
    })
    .await
    .map_err(|e| AppError::internal(format!("字体导入任务异常: {e}")))?
}

#[tauri::command]
pub async fn font_remove(state: State<'_, Arc<AppState>>, id: String) -> AppResult<()> {
    let dir = state.font_dir.clone();
    let lock = state.fonts_lock.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let _guard = lock.lock().map_err(|_| AppError::internal("字体索引锁中毒"))?;
        let mut list = load_index(&dir)?;
        let Some(pos) = list.iter().position(|r| r.id == id) else {
            return Err(AppError::param("字体不存在（可能已被删除）"));
        };
        let gone = list.remove(pos);
        // 文件删不掉（被占用 / 已不存在）不影响索引清理：记录没了就等于删了
        let path = dir.join(&gone.file_name);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        save_index(&dir, &list)
    })
    .await
    .map_err(|e| AppError::internal(format!("字体删除任务异常: {e}")))?
}

/// 取字体原始字节（前端 new FontFace 用）。
/// 走 ipc::Response 而不是 base64 字符串：5–40MB 的 CJK 字体转 base64 要多花 33% 内存和一次拷贝。
#[tauri::command]
pub async fn font_bytes(state: State<'_, Arc<AppState>>, id: String) -> AppResult<Response> {
    let dir = state.font_dir.clone();
    let lock = state.fonts_lock.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Response> {
        let list = {
            let _guard = lock.lock().map_err(|_| AppError::internal("字体索引锁中毒"))?;
            load_index(&dir)?
        };
        let res = list
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| AppError::param("字体不存在（可能已被删除）"))?;
        let path = dir.join(&res.file_name);
        let bytes = std::fs::read(&path)
            .map_err(|e| AppError::io(format!("读取字体文件失败（{}）: {e}", path.display())))?;
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| AppError::internal(format!("字体读取任务异常: {e}")))?
}

/* ============================ 测试 ============================ */

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例用独立临时目录：cargo test 默认多线程，共用一个目录会互相删文件。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "oberon-fonts-test-{}-{}-{tag}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("字体")
            .join(rel)
    }

    #[test]
    fn imports_copies_and_indexes_font() {
        let dir = temp_dir("import");
        let mut existing = Vec::new();
        let src = sample("Ephesis/Ephesis-Regular.ttf");
        let res = import_one(&dir, &mut existing, &src).expect("样本字体应当能导入");

        assert_eq!(res.family, "Ephesis");
        assert!(res.parsed);
        assert_eq!(existing.len(), 1);
        // 文件名 = 哈希前 16 位 + face + 扩展名，且真的落在字体目录里
        assert_eq!(res.file_name, format!("{}-0.ttf", &res.content_hash[..16]));
        let on_disk = dir.join(&res.file_name);
        assert!(on_disk.is_file());
        assert_eq!(
            std::fs::read(&on_disk).unwrap().len() as u64,
            std::fs::metadata(&src).unwrap().len()
        );
        // 索引能原样读写
        save_index(&dir, &existing).unwrap();
        let back = load_index(&dir).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, res.id);
        assert_eq!(back[0].content_hash, res.content_hash);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reimport_same_bytes_is_ignored() {
        let dir = temp_dir("dup");
        let mut existing = Vec::new();
        let src = sample("Ephesis/Ephesis-Regular.ttf");
        let first = import_one(&dir, &mut existing, &src).unwrap();
        // 换一个显示名，内容哈希不变 → 命中原记录，不重复落盘
        let renamed = dir.join("换个名字.ttf");
        std::fs::copy(&src, &renamed).unwrap();
        let second = import_one(&dir, &mut existing, &renamed).unwrap();
        assert_eq!(existing.len(), 1);
        assert_eq!(second.id, first.id);
        assert_eq!(second.original_name, "Ephesis-Regular.ttf");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unsupported_and_tiny_files() {
        let dir = temp_dir("reject");
        let mut existing = Vec::new();

        let txt = dir.join("歌词.txt");
        std::fs::write(&txt, "不是字体".repeat(200)).unwrap();
        let err = import_one(&dir, &mut existing, &txt).unwrap_err();
        assert!(err.1.contains("ttf"), "错误信息要点名支持的格式: {}", err.1);

        let tiny = dir.join("tiny.ttf");
        std::fs::write(&tiny, vec![0u8; 64]).unwrap();
        let err = import_one(&dir, &mut existing, &tiny).unwrap_err();
        assert!(err.1.contains("太小"), "{}", err.1);

        assert!(existing.is_empty());
        assert!(!index_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adopts_orphan_files_in_font_dir() {
        let dir = temp_dir("orphan");
        // 模拟"旧版本留下的、没进索引的文件"：原文件名直接放在 fonts 目录里
        let src = sample("Ephesis/Ephesis-Regular.ttf");
        std::fs::copy(&src, dir.join("Ephesis-Regular.ttf")).unwrap();
        let mut list = Vec::new();
        assert!(adopt_orphans(&dir, &mut list));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].family, "Ephesis");
        // 再跑一次不该重复入库（哈希已在索引里）
        assert!(!adopt_orphans(&dir, &mut list));
        assert_eq!(list.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unparsable_font_still_imports_with_warning() {
        let dir = temp_dir("broken");
        let mut existing = Vec::new();
        let broken = dir.join("broken.ttf");
        // 够大、扩展名对，但表结构是垃圾：解析失败仍要入库，只是没有覆盖统计
        std::fs::write(&broken, vec![0x41u8; 4096]).unwrap();
        let res = import_one(&dir, &mut existing, &broken).unwrap();
        assert!(!res.parsed);
        assert!(res.warning.is_some());
        assert_eq!(res.family, "broken");
        assert_eq!(res.coverage.latin, 0.0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

