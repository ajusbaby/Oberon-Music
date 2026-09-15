//! 播放器命令：状态查询、播放入口（队列构建）、传输控制、封面

use super::db_run;
use crate::engine::EngineCommand;
use crate::error::{AppError, AppResult};
use crate::models::{PlayMode, PlayerState, QueuePosition, QueueTrack};
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

/// 队列只有 1 首时，「上一首/下一首」只会在原地打转（advance 算得 (0+1)%1 == 0），
/// 表现为「点了切歌却把同一首从头重播」。这里按「所属专辑 → 整个曲库」补出真实
/// 播放上下文；查询失败或仍然只有 1 首时保留原队列（绝不把队列弄空）。
/// ⚠️ 必须对**所有**播放入口生效：曲库里大量「单曲下载」的专辑只有 1 首歌，
/// 从首页封面流直接点封面播放时同样会踩到。
async fn expand_context(state: &Arc<AppState>, ids: Vec<i64>, seed_track_id: i64) -> Vec<i64> {
    if ids.len() > 1 {
        return ids;
    }
    let db = state.db.clone();
    let ctx_ids = db_run(db, move |c| {
        let album_ids = crate::db::album_track_ids_for_track(c, seed_track_id)?;
        if album_ids.len() > 1 {
            Ok(album_ids)
        } else {
            // 用与「播放全部」相同的曲库顺序（专辑艺术家→专辑→碟号→音轨）。
            // 不要用裸查的 all_track_ids：那个没有 ORDER BY，顺序是 rowid 插入序，
            // 补出来的队列会与界面所见毫无关系，「下一首」跳到哪一首完全不可预期。
            crate::db::all_track_ids_ordered(c)
        }
    })
    .await
    .unwrap_or_default();
    if ctx_ids.len() > ids.len() { ctx_ids } else { ids }
}

/// 构建播放队列并交由引擎播放，返回队列位置
async fn play_queue(state: &Arc<AppState>, track_ids: Vec<i64>, start_track_id: Option<i64>) -> AppResult<QueuePosition> {
    // 单首队列的统一兜底点：单曲、专辑、歌单、整库四条入口都会经过这里
    let seed = start_track_id.or_else(|| track_ids.first().copied());
    let track_ids = match seed {
        Some(s) => expand_context(state, track_ids, s).await,
        None => track_ids,
    };
    let db = state.db.clone();
    let total = track_ids.len();
    let tracks = db_run(db, move |c| crate::db::tracks_by_ids(c, &track_ids)).await?;
    if tracks.is_empty() {
        return Err(AppError::new(crate::error::E_TRACK_NOT_FOUND, "队列中没有可播放的歌曲（文件可能已被移除）"));
    }
    let items: Vec<QueueTrack> = tracks
        .into_iter()
        .map(|t| QueueTrack {
            track_id: t.id,
            path: t.path,
            title: t.title,
            artist: t.artist,
            album: t.album,
            duration_secs: t.duration_secs,
        })
        .collect();
    let start = match start_track_id {
        Some(st) => items.iter().position(|q| q.track_id == st).unwrap_or(0),
        None => 0,
    };
    state.engine.send(EngineCommand::SetQueue { items, start, autoplay: true })?;
    Ok(QueuePosition { index: start, count: total })
}

/// 恢复上次完全退出时的曲目与位置：装载队列但不自动播放（前端随后 seek 并确认暂停）
#[tauri::command]
pub async fn player_restore(
    state: State<'_, Arc<AppState>>,
    track_id: i64,
    position_secs: f64,
    queue_track_ids: Option<Vec<i64>>,
) -> AppResult<QueuePosition> {
    let ids = match queue_track_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => vec![track_id],
    };
    let ids = expand_context(state.inner(), ids, track_id).await;
    let db = state.db.clone();
    let total = ids.len();
    let tracks = db_run(db, move |c| crate::db::tracks_by_ids(c, &ids)).await?;
    if tracks.is_empty() {
        return Err(AppError::new(crate::error::E_TRACK_NOT_FOUND, "无法恢复上次的曲目"));
    }
    let items: Vec<QueueTrack> = tracks
        .into_iter()
        .map(|t| QueueTrack { track_id: t.id, path: t.path, title: t.title, artist: t.artist, album: t.album, duration_secs: t.duration_secs })
        .collect();
    let start = items.iter().position(|q| q.track_id == track_id).unwrap_or(0);
    state.engine.send(EngineCommand::SetQueue { items, start, autoplay: false })?;
    state.engine.send(EngineCommand::LoadPaused { index: start })?;
    if position_secs > 0.0 {
        state.engine.send(EngineCommand::Seek { position_secs })?;
    }
    Ok(QueuePosition { index: start, count: total })
}

#[tauri::command]
pub async fn player_state(state: State<'_, Arc<AppState>>) -> AppResult<PlayerState> {
    Ok(state.engine.snapshot())
}

/// 播放单曲；queue_track_ids 可选，给出播放上下文（如当前列表顺序）
#[tauri::command]
pub async fn player_play_track(
    state: State<'_, Arc<AppState>>,
    track_id: i64,
    queue_track_ids: Option<Vec<i64>>,
) -> AppResult<QueuePosition> {
    // 播放上下文：前端各入口都会传入所在列表（专辑/歌单/搜索结果/音乐库），直接用。
    // 没给、或给了空列表时就地退化成单曲队列，再由 play_queue 统一补全真实上下文。
    let ids = match queue_track_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => vec![track_id],
    };
    if !ids.contains(&track_id) {
        return Err(AppError::param("起始歌曲不在队列中"));
    }
    play_queue(state.inner(), ids, Some(track_id)).await
}

#[tauri::command]
pub async fn player_play_album(
    state: State<'_, Arc<AppState>>,
    album_id: i64,
    start_track_id: i64,
) -> AppResult<QueuePosition> {
    let db = state.db.clone();
    let tracks = db_run(db, move |c| crate::db::album_tracks(c, album_id)).await?;
    let ids: Vec<i64> = tracks.into_iter().map(|t| t.id).collect();
    if ids.is_empty() {
        return Err(AppError::new(crate::error::E_TRACK_NOT_FOUND, "专辑为空或无此专辑"));
    }
    play_queue(state.inner(), ids, Some(start_track_id)).await
}

#[tauri::command]
pub async fn player_play_playlist(
    state: State<'_, Arc<AppState>>,
    playlist_id: i64,
    start_track_id: i64,
) -> AppResult<QueuePosition> {
    let db = state.db.clone();
    let ids = db_run(db, move |c| crate::db::playlist_track_ids(c, playlist_id)).await?;
    if ids.is_empty() {
        return Err(AppError::new(crate::error::E_PLAYLIST_NOT_FOUND, "播放列表为空或无此列表"));
    }
    play_queue(state.inner(), ids, Some(start_track_id)).await
}

/// 播放全库（库内顺序，见 db::all_tracks_ordered）
#[tauri::command]
pub async fn player_play_all(
    state: State<'_, Arc<AppState>>,
    start_track_id: i64,
) -> AppResult<QueuePosition> {
    let db = state.db.clone();
    let tracks = db_run(db, move |c| crate::db::all_tracks_ordered(c)).await?;
    let ids: Vec<i64> = tracks.into_iter().map(|t| t.id).collect();
    if ids.is_empty() {
        return Err(AppError::new(crate::error::E_TRACK_NOT_FOUND, "曲库为空"));
    }
    play_queue(state.inner(), ids, Some(start_track_id)).await
}

#[tauri::command]
pub async fn player_toggle(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.engine.send(EngineCommand::Toggle)
}
#[tauri::command]
pub async fn player_pause(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.engine.send(EngineCommand::Pause)
}
#[tauri::command]
pub async fn player_resume(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.engine.send(EngineCommand::Resume)
}
#[tauri::command]
pub async fn player_stop(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.engine.send(EngineCommand::Stop)
}
#[tauri::command]
pub async fn player_next(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.engine.send(EngineCommand::Next)
}
#[tauri::command]
pub async fn player_previous(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.engine.send(EngineCommand::Previous)
}
#[tauri::command]
pub async fn player_seek(state: State<'_, Arc<AppState>>, position_secs: f64) -> AppResult<()> {
    state.engine.send(EngineCommand::Seek { position_secs })
}
/// 当前节拍强度 0..1（前端 ~30Hz 轮询，驱动首页背景律动）。
/// 同步命令、只读一个原子量，开销可忽略。
#[tauri::command]
pub fn player_beat(state: State<'_, Arc<AppState>>) -> f32 {
    state.engine.beat().level()
}

#[tauri::command]
pub async fn player_set_volume(state: State<'_, Arc<AppState>>, volume: u8) -> AppResult<()> {
    state.engine.send(EngineCommand::SetVolume { volume })?;
    let db = state.db.clone();
    db_run(db, move |c| Ok(crate::db::settings_set(c, "volume", &volume.to_string())?)).await
}
#[tauri::command]
pub async fn player_set_play_mode(state: State<'_, Arc<AppState>>, mode: PlayMode) -> AppResult<()> {
    state.engine.send(EngineCommand::SetPlayMode { mode })?;
    let db = state.db.clone();
    let s = mode.as_str().to_string();
    db_run(db, move |c| Ok(crate::db::settings_set(c, "playMode", &s)?)).await
}

/// 「上一首」行为：`true` = 播放超过 3 秒回到本曲开头；`false`（默认）= 总是切上一首。
/// 与 volume / playMode 同构：先推引擎（立即生效），再落库（下次启动由 state.rs 灌回）。
#[tauri::command]
pub async fn player_set_previous_restart(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> AppResult<()> {
    state.engine.send(EngineCommand::SetPreviousRestart { enabled })?;
    let db = state.db.clone();
    let v = if enabled { "on" } else { "off" };
    db_run(db, move |c| Ok(crate::db::settings_set(c, "previousRestart", v)?)).await
}

/// 取歌曲封面（data URL；无封面返回 null）
#[tauri::command]
pub async fn player_cover(state: State<'_, Arc<AppState>>, track_id: i64) -> AppResult<Option<String>> {
    let db = state.db.clone();
    let cover_dir = state.cover_dir.clone();
    db_run(db, move |c| {
        let Some(t) = crate::db::track_by_id(c, track_id)? else {
            return Ok(None);
        };
        let Some(key) = t.cover_key else { return Ok(None) };
        // 优先读缩略图（约 30-45KB）。没有就退回原图 —— 老库还没重扫过时走这条；
        // 实测原图平均 439KB，base64 后约 585KB，是缩略图的近 20 倍。
        let thumb = crate::scanner::thumb_path_for(&cover_dir, &key);
        let (path, mime) = if thumb.is_file() {
            (thumb, "image/jpeg")
        } else {
            let ext = key.rsplit('.').next().unwrap_or("jpg").to_string();
            (
                crate::scanner::cover_path_for(&cover_dir, &key),
                crate::scanner::mime_of_ext(&ext),
            )
        };
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        Ok(Some(format!(
            "data:{};base64,{}",
            mime,
            crate::scanner::base64_encode(&bytes)
        )))
    })
    .await
}
/// 取歌曲歌词：同名 .lrc 文件优先，其次内嵌标签；返回逐行歌词（可能带时间轴）
#[tauri::command]
pub async fn track_lyrics(
    state: State<'_, Arc<AppState>>,
    track_id: i64,
) -> AppResult<crate::lyrics::Lyrics> {
    let db = state.db.clone();
    db_run(db, move |c| {
        let Some(t) = crate::db::track_by_id(c, track_id)? else {
            return Ok(crate::lyrics::Lyrics::none());
        };
        Ok(crate::lyrics::load(&t.path))
    })
    .await
}
