//! 歌词字体：用户上传的字体文件存到 app_data/fonts/，前端用 FontFace API 注册使用
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::sync::Arc;
use tauri::ipc::Response;
use tauri::State;

/// 允许的字体扩展名（前端 FontFace 支持的类型）
const ALLOWED: [&str; 5] = [".ttf", ".otf", ".ttc", ".woff", ".woff2"];
/// 单文件上限（字节）
const MAX_BYTES: usize = 64 * 1024 * 1024;

/// 校验并规整文件名：去掉路径、只留安全字符、检查扩展名
fn sanitize(name: &str) -> AppResult<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let lower = base.to_lowercase();
    if !ALLOWED.iter().any(|e| lower.ends_with(e)) {
        return Err(AppError::param("只支持 ttf / otf / ttc / woff / woff2 字体文件"));
    }
    let safe: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || !c.is_ascii() {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.trim_matches('.').is_empty() {
        return Err(AppError::param("字体文件名无效"));
    }
    Ok(safe)
}

/// 保存用户上传的字体，返回实际保存的文件名（写入 app_data/fonts/）
#[tauri::command]
pub async fn font_save(
    state: State<'_, Arc<AppState>>,
    name: String,
    data: Vec<u8>,
) -> AppResult<String> {
    let safe = sanitize(&name)?;
    if data.len() < 1024 {
        return Err(AppError::param("字体文件过小，可能不是有效字体"));
    }
    if data.len() > MAX_BYTES {
        return Err(AppError::param("字体文件过大（上限 64MB）"));
    }
    let dir = state.font_dir.clone();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::io(format!("创建字体目录失败: {e}")))?;
    let path = dir.join(&safe);
    std::fs::write(&path, &data).map_err(|e| AppError::io(format!("保存字体失败: {e}")))?;
    Ok(safe)
}

/// 读取已保存的字体字节（前端 new FontFace 用）；原始二进制返回，避免 base64 膨胀
#[tauri::command]
pub async fn font_read(state: State<'_, Arc<AppState>>, name: String) -> AppResult<Response> {
    let safe = sanitize(&name)?;
    let path = state.font_dir.join(safe);
    let bytes = std::fs::read(&path).map_err(|_| AppError::not_found("自定义字体文件不存在"))?;
    Ok(Response::new(bytes))
}

/// 删除用户上传的字体文件（幂等：文件不存在也算成功）
/// 槽位里对该字体的引用由前端清理（只有前端知道 id ↔ 文件名的映射）
#[tauri::command]
pub async fn font_delete(state: State<'_, Arc<AppState>>, name: String) -> AppResult<()> {
    let safe = sanitize(&name)?;
    let path = state.font_dir.join(&safe);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| AppError::io(format!("删除字体失败: {e}")))?;
    }
    Ok(())
}

/// 列出已上传的字体文件名
#[tauri::command]
pub async fn font_list(state: State<'_, Arc<AppState>>) -> AppResult<Vec<String>> {
    let dir = state.font_dir.clone();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| AppError::io(format!("读取字体目录失败: {e}")))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    out.sort();
    Ok(out)
}
