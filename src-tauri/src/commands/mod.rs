//! 命令层公共设施：异步化数据库访问
pub mod library;
pub mod fonts;
pub mod player;
pub mod playlist;
pub mod scan;
pub mod settings;

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

/// 在 tokio 阻塞池中执行数据库操作（避免阻塞 UI 线程）
pub async fn db_run<T, F>(db: Arc<Mutex<Connection>>, f: F) -> AppResult<T>
where
    F: FnOnce(&Connection) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let g = db.lock().map_err(|_| AppError::internal("数据库锁中毒"))?;
        f(&g)
    });
    handle.await.map_err(|e| AppError::internal(format!("数据库任务异常: {e}")))?
}
