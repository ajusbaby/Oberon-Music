//! 统一错误模型：所有 IPC 命令返回 Result<T, AppError>
//! 错误码为稳定字符串，前端据此做本地化提示（错误码清单见 docs/接口文档.md）

/// 内部错误（未分类）
pub const E_INTERNAL: &str = "INTERNAL";
/// 参数不合法
pub const E_INVALID_ARG: &str = "INVALID_ARG";
/// 文件系统错误
pub const E_IO: &str = "IO";
/// 歌曲不存在
pub const E_TRACK_NOT_FOUND: &str = "TRACK_NOT_FOUND";
/// 播放列表不存在
pub const E_PLAYLIST_NOT_FOUND: &str = "PLAYLIST_NOT_FOUND";
/// 音乐文件夹不存在 / 未登记（预留）
#[allow(dead_code)]
pub const E_FOLDER_NOT_FOUND: &str = "FOLDER_NOT_FOUND";
/// 音频解码失败（文件损坏 / 格式不支持）
pub const E_DECODE: &str = "DECODE";
/// 音频设备不可用（WASAPI 初始化失败）
pub const E_AUDIO_DEVICE: &str = "AUDIO_DEVICE";
/// 播放文件丢失或不可读
pub const E_FILE_UNAVAILABLE: &str = "FILE_UNAVAILABLE";
/// 扫描任务冲突（预留：当前实现为挂起合并而非报错）
#[allow(dead_code)]
pub const E_SCAN_RUNNING: &str = "SCAN_RUNNING";
/// 数据库错误
pub const E_DB: &str = "DB";

#[derive(Debug, Clone)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(E_INTERNAL, message)
    }
    pub fn param(message: impl Into<String>) -> Self {
        Self::new(E_INVALID_ARG, message)
    }
    #[allow(dead_code)]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(E_TRACK_NOT_FOUND, message)
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(E_IO, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code)?;
        s.serialize_field("message", &self.message)?;
        s.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new(E_DB, format!("数据库错误: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new(E_IO, format!("文件系统错误: {e}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;