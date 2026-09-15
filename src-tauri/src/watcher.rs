//! 音乐目录监听（notify）：目录增删改后自动增量扫描（防抖 1.5s，节流 3s）

use crate::state::AppState;
use notify::{RecursiveMode, Watcher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub enum WatchMsg {
    Add(String),
    Remove(String),
    /// 重新读取根目录列表（预留：多窗口/设置变更时使用）
    #[allow(dead_code)]
    RescanRoots,
    /// 停止监听线程（预留：应用退出时显式收尾）
    #[allow(dead_code)]
    Shutdown,
}

#[derive(Clone)]
pub struct WatcherHandle {
    pub tx: std::sync::mpsc::Sender<WatchMsg>,
}

impl WatcherHandle {
    pub fn send(&self, msg: WatchMsg) {
        let _ = self.tx.send(msg);
    }
}

/// 启动监听线程（setup 阶段调用一次；持有 AppState 的 Arc 用于读取根目录与触发扫描）
pub fn run(state: Arc<AppState>, app: tauri::AppHandle, rx: std::sync::mpsc::Receiver<WatchMsg>) {
    let event_ts = Arc::new(Mutex::new(None::<Instant>));
    let dirty = Arc::new(AtomicBool::new(false));

    let mut watcher = notify::recommended_watcher({
        let event_ts = event_ts.clone();
        let dirty = dirty.clone();
        move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let relevant = matches!(
                    ev.kind,
                    notify::EventKind::Create(_) | notify::EventKind::Modify(_) | notify::EventKind::Remove(_)
                );
                if relevant {
                    if let Ok(mut g) = event_ts.lock() {
                        *g = Some(Instant::now());
                    }
                    dirty.store(true, Ordering::SeqCst);
                }
            }
        }
    })
    .expect("创建文件监听失败");

    let mut roots: Vec<String> = Vec::new();
    let mut last_scan: Option<Instant> = None;

    loop {
        match rx.recv_timeout(Duration::from_millis(400)) {
            Ok(WatchMsg::Add(path)) => {
                if !roots.contains(&path) {
                    if watcher.watch(std::path::Path::new(&path), RecursiveMode::Recursive).is_ok() {
                        roots.push(path);
                    }
                }
            }
            Ok(WatchMsg::Remove(path)) => {
                roots.retain(|r| r != &path);
                let _ = watcher.unwatch(std::path::Path::new(&path));
            }
            Ok(WatchMsg::RescanRoots) => {
                let fresh: Vec<String> = state
                    .db
                    .lock()
                    .ok()
                    .and_then(|g| crate::db::list_folders(&g).ok())
                    .map(|v| v.into_iter().map(|f| f.path).collect())
                    .unwrap_or_default();
                for r in &fresh {
                    if !roots.contains(r) {
                        let _ = watcher.watch(std::path::Path::new(r), RecursiveMode::Recursive);
                        roots.push(r.clone());
                    }
                }
                for r in roots.clone() {
                    if !fresh.contains(&r) {
                        let _ = watcher.unwatch(std::path::Path::new(&r));
                        roots.retain(|x| x != &r);
                    }
                }
            }
            Ok(WatchMsg::Shutdown) => break,
            Err(_) => {}
        }

        // 防抖 + 节流触发增量扫描
        let should = dirty.load(Ordering::SeqCst)
            && event_ts
                .lock()
                .ok()
                .and_then(|g| *g)
                .map(|t| t.elapsed() > Duration::from_millis(1500))
                .unwrap_or(false);
        if should {
            dirty.store(false, Ordering::SeqCst);
            if last_scan.map(|t| t.elapsed() > Duration::from_secs(3)).unwrap_or(true) {
                last_scan = Some(Instant::now());
                let db = state.db.clone();
                let db_path = state.db_path.clone();
                let covers = state.cover_dir.clone();
                state.scan.request(app.clone(), db, db_path, covers);
            }
        }
    }
}