//! SQLite 数据层：表结构、迁移与全部查询
//!
//! 表：tracks / folders / playlists / playlist_tracks / settings
//! 特性：WAL 模式、外键级联、参数化查询（防注入）
//! 注：搜索采用 LIKE + ESCAPE 实现；FTS5 全文索引留作后续优化（见设计文档 §4.1 可选）

use crate::error::{AppError, AppResult};
use crate::models::*;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "wav", "ogg", "oga", "m4a", "m4b", "aac", "opus", "alac", "aiff", "caf",
];

/// 打开（或创建）数据库并执行迁移
pub fn open_db(db_path: &Path) -> AppResult<Connection> {
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError::io(format!("创建数据目录失败: {e}")))?;
    }
    let conn = Connection::open(db_path).map_err(|e| AppError::new(crate::error::E_DB, format!("打开数据库失败: {e}")))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| AppError::new(crate::error::E_DB, format!("启用 WAL 失败: {e}")))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| AppError::new(crate::error::E_DB, format!("设置同步模式失败: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| AppError::new(crate::error::E_DB, format!("启用外键失败: {e}")))?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| AppError::new(crate::error::E_DB, format!("设置忙等待失败: {e}")))?;
    migrate(&conn)?;
    Ok(conn)
}

/// 建表迁移（幂等）
fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS tracks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT    NOT NULL UNIQUE,           -- 规范化后的绝对路径（含 \\?\ 长路径前缀）
    title        TEXT    NOT NULL DEFAULT '',
    artist       TEXT    NOT NULL DEFAULT '',
    album        TEXT    NOT NULL DEFAULT '',
    album_artist TEXT    NOT NULL DEFAULT '',
    genre        TEXT    NOT NULL DEFAULT '',
    year         INTEGER,
    track_no     INTEGER,
    disc_no      INTEGER,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    sample_rate  INTEGER,
    bitrate      INTEGER,
    channels     INTEGER,
    format       TEXT    NOT NULL DEFAULT '',       -- 扩展名（小写）
    cover_key    TEXT,                              -- 封面缓存文件名（cover_cache/<key>）
    file_size    INTEGER NOT NULL DEFAULT 0,
    file_mtime   INTEGER NOT NULL DEFAULT 0,        -- 文件修改时间（秒），扫描去重用
    added_ms     INTEGER NOT NULL DEFAULT 0,
    modified_ms  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT    NOT NULL UNIQUE,
    last_scanned_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album);
CREATE INDEX IF NOT EXISTS idx_tracks_title  ON tracks(title);
CREATE INDEX IF NOT EXISTS idx_tracks_added  ON tracks(added_ms);
CREATE INDEX IF NOT EXISTS idx_pt_position   ON playlist_tracks(playlist_id, position);

-- 上面三个单列索引是默认 BINARY 排序规则，而 list_tracks 的排序表达式全是
-- `t.title COLLATE NOCASE` 这种形式 —— SQLite **无法用 BINARY 索引满足 NOCASE 排序**，
-- 于是每次分页（哪怕第一页）都要全表读 + 临时 B-tree 排序，索引等于白建。
-- 补上同列的 NOCASE 索引，排序才走索引。两套并存是有意的：等值比较仍可用 BINARY 索引。
CREATE INDEX IF NOT EXISTS idx_tracks_title_nocase  ON tracks(title  COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_artist_nocase ON tracks(artist COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_album_nocase  ON tracks(album  COLLATE NOCASE);
-- 外键子键索引：playlist_tracks 的 PK 是 (playlist_id, track_id)，track_id 在第二列，
-- 无法用于「按 track_id 查」。SQLite 执行 DELETE FROM tracks 的级联删除时只能全表扫这张表 ——
-- 删一首歌在有 1000 首歌单时就要扫 1000 行；批量删除时是乘法放大。
-- SQLite 官方文档明确要求给外键子键建索引。
CREATE INDEX IF NOT EXISTS idx_pt_track ON playlist_tracks(track_id);
"#,
    )
    .map_err(|e| AppError::new(crate::error::E_DB, format!("建表失败: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// tracks 行映射
// ---------------------------------------------------------------------------

const TRACK_COLS: &str = "t.id, t.path, t.title, t.artist, t.album, t.album_artist, t.genre,      t.year, t.track_no, t.disc_no, t.duration_ms, t.sample_rate, t.bitrate, t.channels,      t.format, t.cover_key, t.file_size, t.file_mtime, t.added_ms";

fn row_to_track(r: &Row) -> rusqlite::Result<Track> {
    let title: String = r.get(2)?;
    let artist: String = r.get(3)?;
    let album: String = r.get(4)?;
    let album_artist: String = r.get(5)?;
    let genre: String = r.get(6)?;
    let format: String = r.get(14)?;
    let path: String = r.get(1)?;
    let duration_ms: i64 = r.get(10)?;
    Ok(Track {
        id: r.get(0)?,
        path,
        title,
        artist,
        album,
        album_artist,
        genre,
        year: r.get(7)?,
        track_no: r.get(8)?,
        disc_no: r.get(9)?,
        duration_secs: duration_ms as f64 / 1000.0,
        sample_rate: r.get(11)?,
        bitrate: r.get(12)?,
        channels: r.get(13)?,
        format,
        cover_key: r.get(15)?,
        file_size: r.get(16)?,
        file_mtime: r.get(17)?,
        added_ms: r.get(18)?,
    })
}

// ---------------------------------------------------------------------------
// 歌曲
// ---------------------------------------------------------------------------

/// 扫描写入所需的元数据
#[derive(Debug, Clone, Default)]
pub struct TrackMeta {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<i64>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub duration_ms: i64,
    pub sample_rate: Option<i64>,
    pub bitrate: Option<i64>,
    pub channels: Option<i64>,
    pub format: String,
    pub cover_key: Option<String>,
    pub file_size: i64,
    pub file_mtime: i64,
}

/// 路径存在则返回 id；否则 None（供扫描判定 add/update）
pub fn track_id_by_path(conn: &Connection, path: &str) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row("SELECT id FROM tracks WHERE path = ?1", params![path], |r| r.get(0))
        .optional()?)
}

/// 插入或更新歌曲记录，返回 (id, 是否已有旧记录)
pub fn upsert_track(conn: &Connection, m: &TrackMeta) -> AppResult<(i64, bool)> {
    let existed = track_id_by_path(conn, &m.path)?.is_some();
    let now = unix_ms();
    let id = conn.query_row(
        r#"
INSERT INTO tracks (path, title, artist, album, album_artist, genre, year, track_no, disc_no,
                    duration_ms, sample_rate, bitrate, channels, format, cover_key,
                    file_size, file_mtime, added_ms, modified_ms)
VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?18)
ON CONFLICT(path) DO UPDATE SET
    title=excluded.title, artist=excluded.artist, album=excluded.album,
    album_artist=excluded.album_artist, genre=excluded.genre,
    year=excluded.year, track_no=excluded.track_no, disc_no=excluded.disc_no,
    duration_ms=excluded.duration_ms, sample_rate=excluded.sample_rate,
    bitrate=excluded.bitrate, channels=excluded.channels, format=excluded.format,
    cover_key=excluded.cover_key, file_size=excluded.file_size,
    file_mtime=excluded.file_mtime, modified_ms=excluded.modified_ms
RETURNING id
"#,
        params![
            m.path, m.title, m.artist, m.album, m.album_artist, m.genre, m.year, m.track_no,
            m.disc_no, m.duration_ms, m.sample_rate, m.bitrate, m.channels, m.format, m.cover_key,
            m.file_size, m.file_mtime, now
        ],
        |r| r.get::<_, i64>(0),
    )?;
    Ok((id, existed))
}

pub fn delete_track_by_id(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM tracks WHERE id = ?1", params![id])?;
    Ok(())
}

/// 返回全部歌曲 id（扫描时做差集删除）
pub fn all_track_ids(conn: &Connection) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM tracks")?;
    let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 曲目总数。只要一个长度时用这个 —— 别拿 all_track_ids().len() 把整表 id 拉进内存再丢掉。
pub fn track_count(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?)
}

/// 所有被引用的封面 key（供封面缓存 GC 使用）。查询失败返回 Err，调用方据此放弃回收。
pub fn all_cover_keys(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT cover_key FROM tracks WHERE cover_key IS NOT NULL AND cover_key <> ''")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        if let Ok(k) = r {
            out.push(k);
        }
    }
    Ok(out)
}
pub fn track_by_id(conn: &Connection, id: i64) -> AppResult<Option<Track>> {
    let sql = format!("SELECT {TRACK_COLS} FROM tracks t WHERE t.id = ?1");
    Ok(conn.query_row(&sql, params![id], row_to_track).optional()?)
}

/// 全部曲目的 (id, 路径, 修改时间秒, 文件字节数)。
/// 供扫描做「未变文件跳过」的差集比对：一次把整表读进内存，好过对每个文件各查一次库
/// （N 次查询往返 → 1 次）。file_mtime 为 0 表示当年 stat 失败，调用方不得据此跳过。
pub fn all_track_file_stamps(conn: &Connection) -> AppResult<Vec<(i64, String, i64, i64)>> {
    let mut stmt = conn.prepare("SELECT id, path, file_mtime, file_size FROM tracks")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 按 id 集合取歌曲（保持传入顺序），用于播放队列构建
pub fn tracks_by_ids(conn: &Connection, ids: &[i64]) -> AppResult<Vec<Track>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT {} FROM tracks t WHERE t.id IN ({})",
        TRACK_COLS,
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql)?;
    let values: Vec<Value> = ids.iter().map(|v| Value::Integer(*v)).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), row_to_track)?;
    let mut found: Vec<Track> = rows.collect::<Result<Vec<_>, _>>()?;
    let by_id: std::collections::HashMap<i64, Track> =
        found.drain(..).map(|t| (t.id, t)).collect();
    Ok(ids.iter().filter_map(|id| by_id.get(id).cloned()).collect())
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// 歌曲列表（过滤 + 排序 + 分页）
pub fn list_tracks(conn: &Connection, f: &TrackFilter) -> AppResult<Paginated<Track>> {
    let page = f.page.unwrap_or(1).max(1);
    let page_size = f.page_size.unwrap_or(200).clamp(1, 1000);
    let mut wheres: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if let Some(q) = f.q.as_deref().filter(|s| !s.trim().is_empty()) {
        let like = format!("%{}%", escape_like(q.trim()));
        wheres.push(
            "(t.title LIKE ?1 ESCAPE '\\' OR t.artist LIKE ?1 ESCAPE '\\'              OR t.album LIKE ?1 ESCAPE '\\' OR t.album_artist LIKE ?1 ESCAPE '\\')"
                .to_string(),
        );
        params.push(Value::Text(like));
    }
    if let Some(artist) = f.artist.as_deref().filter(|s| !s.is_empty()) {
        wheres.push("(t.artist = ? COLLATE NOCASE OR t.album_artist = ? COLLATE NOCASE)".into());
        params.push(Value::Text(artist.to_string()));
        params.push(Value::Text(artist.to_string()));
    }
    if let Some(album_id) = f.album_id {
        if let Some((album, key)) = album_key_of(conn, album_id)? {
            wheres.push("(t.album = ? AND COALESCE(NULLIF(t.album_artist,''), t.artist) = ?)".into());
            params.push(Value::Text(album));
            params.push(Value::Text(key));
        } else {
            return Ok(Paginated { items: vec![], total: 0, page, page_size });
        }
    }
    let where_sql = if wheres.is_empty() { String::new() } else { format!("WHERE {}", wheres.join(" AND ")) };

    let order = f.order.as_deref().unwrap_or(if matches!(f.sort.as_deref(), Some("date-added")) { "desc" } else { "asc" });
    let sort = match f.sort.as_deref() {
        Some("artist") => "t.artist COLLATE NOCASE",
        Some("album") => "t.album COLLATE NOCASE",
        Some("year") => "t.year",
        Some("duration") => "t.duration_ms",
        Some("date-added") => "t.added_ms",
        _ => "t.title COLLATE NOCASE",
    };
    let order_sql = match order {
        "desc" => "DESC",
        _ => "ASC",
    };

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM tracks t {where_sql}"),
        rusqlite::params_from_iter(params.iter()),
        |r| r.get(0),
    )?;

    params.push(Value::Integer(page_size as i64));
    params.push(Value::Integer(((page - 1) * page_size) as i64));
    let sql = format!(
        "SELECT {} FROM tracks t {where_sql} ORDER BY {sort} {order_sql}, t.id ASC LIMIT ? OFFSET ?",
        TRACK_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), row_to_track)?;
    let items = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(Paginated { items, total, page, page_size })
}

// ---------------------------------------------------------------------------
// 专辑 / 艺术家
// ---------------------------------------------------------------------------

/// 专辑组的规范化键（专辑艺术家为空时回退到歌曲艺术家）
fn album_key_of(conn: &Connection, track_id: i64) -> AppResult<Option<(String, String)>> {
    Ok(conn
        .query_row(
            "SELECT album, COALESCE(NULLIF(album_artist,''), artist) FROM tracks WHERE id = ?1",
            params![track_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?)
}

/// 专辑列表（含封面与歌曲数；id = 组内最小 track id）
pub fn list_albums(conn: &Connection, page: u64, page_size: u64, q: Option<&str>) -> AppResult<Paginated<Album>> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 1000);
    // 专辑名可能为空（内嵌标签缺失）：这类曲目按「艺术家」单独成组，
    // 否则它们在专辑列表里彻底消失，播放时首页封面流也无从跟随。
    let mut where_sql = String::from("WHERE COALESCE(NULLIF(t.album_artist,''), t.artist) <> ''");
    let mut params: Vec<Value> = Vec::new();
    if let Some(qq) = q.as_deref().filter(|s| !s.trim().is_empty()) {
        let like = format!("%{}%", escape_like(qq.trim()));
        where_sql.push_str(" AND (t.album LIKE ?1 ESCAPE '\\' OR COALESCE(NULLIF(t.album_artist,''), t.artist) LIKE ?1 ESCAPE '\\' OR t.title LIKE ?1 ESCAPE '\\')");
        params.push(Value::Text(like));
    }
    let total: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM (SELECT 1 FROM tracks t {where_sql} GROUP BY t.album, COALESCE(NULLIF(t.album_artist,''), t.artist))"
            ),
            rusqlite::params_from_iter(params.iter()),
            |r| r.get(0),
        )?;
    params.push(Value::Integer(page_size as i64));
    params.push(Value::Integer(((page - 1) * page_size) as i64));
    let sql = format!(
        r#"
SELECT MIN(t.id) AS id, t.album AS name,
       COALESCE(NULLIF(t.album_artist,''), t.artist) AS artist,
       MIN(t.year) AS year, COUNT(*) AS track_count,
       (SELECT x.cover_key FROM tracks x
         WHERE x.album = t.album
           AND COALESCE(NULLIF(x.album_artist,''), x.artist) = COALESCE(NULLIF(t.album_artist,''), t.artist)
         ORDER BY COALESCE(x.disc_no, 99), COALESCE(x.track_no, 99) LIMIT 1) AS cover_key,
       (SELECT y.title FROM tracks y
         WHERE y.album = t.album
           AND COALESCE(NULLIF(y.album_artist,''), y.artist) = COALESCE(NULLIF(t.album_artist,''), t.artist)
         ORDER BY COALESCE(y.disc_no, 99), COALESCE(y.track_no, 99), y.id LIMIT 1) AS first_title
FROM tracks t {where_sql}
GROUP BY t.album, COALESCE(NULLIF(t.album_artist,''), t.artist)
ORDER BY artist COLLATE NOCASE, name COLLATE NOCASE
LIMIT ? OFFSET ?
"#
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
        let raw_name: String = r.get(1)?;
        // 专辑标签为空的曲目按艺术家成组：用组内第一首曲目的标题当专辑名，
        // 界面上就不会出现一堆「未知专辑」。
        let first_title: Option<String> = r.get(6)?;
        let first_title_for_single = first_title.clone();
        let name = if raw_name.trim().is_empty() {
            first_title.unwrap_or_default()
        } else {
            raw_name
        };
        let track_count: i64 = r.get(4)?;
        // 只有一首曲目的专辑（单曲）：卡片显示曲目名，例如「芒种」而不是专辑名「二十四节气」
        let single_title = if track_count == 1 { first_title_for_single.clone() } else { None };
        Ok(Album {
            id: r.get(0)?,
            name,
            artist: r.get(2)?,
            year: r.get(3)?,
            track_count,
            cover_key: r.get(5)?,
            single_title,
        })
    })?;
    let items = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(Paginated { items, total, page, page_size })
}

/// 专辑内歌曲（专辑顺序：碟号 → 音轨号 → 标题）
pub fn album_tracks(conn: &Connection, album_id: i64) -> AppResult<Vec<Track>> {
    let Some((album, key)) = album_key_of(conn, album_id)? else {
        return Ok(vec![]);
    };
    let sql = format!(
        "SELECT {} FROM tracks t WHERE t.album = ?1 AND COALESCE(NULLIF(t.album_artist,''), t.artist) = ?2          ORDER BY COALESCE(t.disc_no, 99), COALESCE(t.track_no, 99), t.title COLLATE NOCASE",
        TRACK_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![album, key], row_to_track)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 取"某首歌所属专辑"的全部曲目 id（与 album_tracks 同一分组规则：album + album_artist/artist）。
/// 用于给"只点了单曲、没给播放上下文"的情况补一个可用的队列 ——
/// 否则上一首/下一首只能在单曲队列里打转（会表现为"一直重头播放同一首"）。
pub fn album_track_ids_for_track(conn: &Connection, track_id: i64) -> AppResult<Vec<i64>> {
    let sql = "SELECT id FROM tracks t
               WHERE t.album = (SELECT album FROM tracks WHERE id = ?1)
                 AND COALESCE(NULLIF(t.album_artist,''), t.artist) =
                     (SELECT COALESCE(NULLIF(album_artist,''), artist) FROM tracks WHERE id = ?1)
               ORDER BY COALESCE(t.disc_no, 99), COALESCE(t.track_no, 99), t.title COLLATE NOCASE";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![track_id], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 艺术家列表
pub fn list_artists(conn: &Connection) -> AppResult<Vec<Artist>> {
    let mut stmt = conn.prepare(
        r#"
SELECT name, COUNT(*) AS track_count, COUNT(DISTINCT album) AS album_count
FROM (
    SELECT COALESCE(NULLIF(t.album_artist,''), t.artist) AS name, t.album
    FROM tracks t
    WHERE COALESCE(NULLIF(t.album_artist,''), t.artist) <> ''
) GROUP BY name ORDER BY name COLLATE NOCASE
"#,
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Artist { name: r.get(0)?, track_count: r.get(1)?, album_count: r.get(2)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 某艺术家的全部歌曲
pub fn artist_tracks(conn: &Connection, artist: &str) -> AppResult<Vec<Track>> {
    let sql = format!(
        "SELECT {} FROM tracks t          WHERE t.artist = ?1 COLLATE NOCASE OR t.album_artist = ?1 COLLATE NOCASE          ORDER BY t.album COLLATE NOCASE, COALESCE(t.disc_no, 99), COALESCE(t.track_no, 99)",
        TRACK_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![artist], row_to_track)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 曲库排序键：专辑艺术家 → 专辑 → 碟号 → 音轨号 → 标题。
/// 音乐库页、「播放全部」与补全播放上下文共用同一份，避免队列顺序与界面所见不一致。
pub(crate) const LIBRARY_ORDER_BY: &str =
    "ORDER BY COALESCE(NULLIF(t.album_artist,''), t.artist) COLLATE NOCASE, t.album COLLATE NOCASE, COALESCE(t.disc_no, 99), COALESCE(t.track_no, 99), t.title COLLATE NOCASE";

/// 全库顺序（播放全部用）
pub fn all_tracks_ordered(conn: &Connection) -> AppResult<Vec<Track>> {
    let sql = format!("SELECT {} FROM tracks t {}", TRACK_COLS, LIBRARY_ORDER_BY);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_track)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 全库顺序的曲目 id（与 all_tracks_ordered 同序），用于补全播放上下文。
/// 注意不要拿 all_track_ids 当队列用：那是无 ORDER BY 的裸查，顺序为 rowid 插入序。
pub fn all_track_ids_ordered(conn: &Connection) -> AppResult<Vec<i64>> {
    let sql = format!("SELECT t.id FROM tracks t {}", LIBRARY_ORDER_BY);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// ---------------------------------------------------------------------------
// 播放列表
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    unix_ms()
}

fn unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn row_to_playlist(r: &Row) -> rusqlite::Result<Playlist> {
    Ok(Playlist {
        id: r.get(0)?,
        name: r.get(1)?,
        track_count: r.get(2)?,
        created_ms: r.get(3)?,
        updated_ms: r.get(4)?,
        cover_key: r.get(5)?,
    })
}

const PLAYLIST_SELECT: &str = r#"
SELECT p.id, p.name,
       (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
       p.created_ms, p.updated_ms,
       (SELECT t.cover_key FROM playlist_tracks pt2 JOIN tracks t ON t.id = pt2.track_id
         WHERE pt2.playlist_id = p.id ORDER BY pt2.position LIMIT 1) AS cover_key
FROM playlists p
"#;

pub fn list_playlists(conn: &Connection) -> AppResult<Vec<Playlist>> {
    let mut stmt = conn.prepare(&format!("{PLAYLIST_SELECT} ORDER BY p.updated_ms DESC"))?;
    let rows = stmt.query_map([], row_to_playlist)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn playlist_by_id(conn: &Connection, id: i64) -> AppResult<Option<Playlist>> {
    let sql = format!("{PLAYLIST_SELECT} WHERE p.id = ?1");
    Ok(conn.query_row(&sql, params![id], row_to_playlist).optional()?)
}

pub fn create_playlist(conn: &Connection, name: &str) -> AppResult<Playlist> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::param("播放列表名称不能为空"));
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO playlists (name, created_ms, updated_ms) VALUES (?1, ?2, ?2)",
        params![name, now],
    )?;
    let id = conn.last_insert_rowid();
    playlist_by_id(conn, id)?.ok_or_else(|| AppError::internal("创建播放列表失败"))
}

pub fn rename_playlist(conn: &Connection, id: i64, name: &str) -> AppResult<Playlist> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::param("播放列表名称不能为空"));
    }
    let now = now_ms();
    conn.execute(
        "UPDATE playlists SET name = ?1, updated_ms = ?2 WHERE id = ?3",
        params![name, now, id],
    )?;
    playlist_by_id(conn, id)?.ok_or_else(|| AppError::new(crate::error::E_PLAYLIST_NOT_FOUND, "播放列表不存在"))
}

pub fn delete_playlist(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn playlist_tracks(conn: &Connection, id: i64) -> AppResult<Vec<Track>> {
    let sql = format!(
        "SELECT {} FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id          WHERE pt.playlist_id = ?1 ORDER BY pt.position",
        TRACK_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![id], row_to_track)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn playlist_track_ids(conn: &Connection, id: i64) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map(params![id], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 批量追加歌曲（忽略已在列表中的）
pub fn playlist_add_tracks(conn: &Connection, id: i64, track_ids: &[i64]) -> AppResult<u64> {
    if !playlist_exists(conn, id)? {
        return Err(AppError::new(crate::error::E_PLAYLIST_NOT_FOUND, "播放列表不存在"));
    }
    let tx = conn.unchecked_transaction()?;
    let base: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) FROM playlist_tracks WHERE playlist_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let mut added = 0u64;
    for (i, tid) in track_ids.iter().enumerate() {
        let pos = base + i as i64;
        let changed = tx.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
            params![id, tid, pos],
        )?;
        if changed > 0 {
            added += 1;
        }
    }
    tx.execute("UPDATE playlists SET updated_ms = ?1 WHERE id = ?2", params![now_ms(), id])?;
    tx.commit()?;
    Ok(added)
}

/// 指定位置插入一首（after_track_id 为 None 时插到最前）
pub fn playlist_insert_track(
    conn: &Connection,
    id: i64,
    track_id: i64,
    after_track_id: Option<i64>,
) -> AppResult<()> {
    if !playlist_exists(conn, id)? {
        return Err(AppError::new(crate::error::E_PLAYLIST_NOT_FOUND, "播放列表不存在"));
    }
    let tx = conn.unchecked_transaction()?;
    let insert_at: i64 = match after_track_id {
        Some(after) => {
            let pos: Option<i64> = tx
                .query_row(
                    "SELECT position FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                    params![id, after],
                    |r| r.get(0),
                )
                .optional()?;
            pos.map(|p| p + 1).unwrap_or(0)
        }
        None => 0,
    };
    tx.execute(
        "UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ?1 AND position >= ?2",
        params![id, insert_at],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
        params![id, track_id, insert_at],
    )?;
    tx.execute("UPDATE playlists SET updated_ms = ?1 WHERE id = ?2", params![now_ms(), id])?;
    tx.commit()?;
    Ok(())
}

pub fn playlist_remove_track(conn: &Connection, id: i64, track_id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let removed: Option<i64> = tx
        .query_row(
            "SELECT position FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![id, track_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(pos) = removed {
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![id, track_id],
        )?;
        tx.execute(
            "UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ?1 AND position > ?2",
            params![id, pos],
        )?;
        tx.execute("UPDATE playlists SET updated_ms = ?1 WHERE id = ?2", params![now_ms(), id])?;
    }
    tx.commit()?;
    Ok(())
}

/// 整体重排（ordered_track_ids 给出新顺序）
pub fn playlist_reorder(conn: &Connection, id: i64, ordered_track_ids: &[i64]) -> AppResult<()> {
    if !playlist_exists(conn, id)? {
        return Err(AppError::new(crate::error::E_PLAYLIST_NOT_FOUND, "播放列表不存在"));
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", params![id])?;
    for (i, tid) in ordered_track_ids.iter().enumerate() {
        tx.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
            params![id, tid, i as i64],
        )?;
    }
    tx.execute("UPDATE playlists SET updated_ms = ?1 WHERE id = ?2", params![now_ms(), id])?;
    tx.commit()?;
    Ok(())
}

fn playlist_exists(conn: &Connection, id: i64) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM playlists WHERE id = ?1", params![id], |_| Ok(()))
        .optional()?
        .is_some())
}

// ---------------------------------------------------------------------------
// 目录 / 设置 / 统计 / 搜索
// ---------------------------------------------------------------------------

pub fn add_folder(conn: &Connection, path: &str) -> AppResult<FolderInfo> {
    conn.execute("INSERT OR IGNORE INTO folders (path) VALUES (?1)", params![path])?;
    let id: i64 = conn.query_row("SELECT id FROM folders WHERE path = ?1", params![path], |r| r.get(0))?;
    folder_by_id(conn, id)
}

fn folder_by_id(conn: &Connection, id: i64) -> AppResult<FolderInfo> {
    let row = conn.query_row(
        "SELECT id, path, last_scanned_ms FROM folders WHERE id = ?1",
        params![id],
        |r| {
            Ok(FolderInfo { id: r.get(0)?, path: r.get(1)?, last_scanned_ms: r.get(2)? })
        },
    )?;
    Ok(row)
}

pub fn remove_folder(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("DELETE FROM folders WHERE path = ?1", params![path])?;
    Ok(())
}

pub fn list_folders(conn: &Connection) -> AppResult<Vec<FolderInfo>> {
    let mut stmt = conn.prepare("SELECT id, path, last_scanned_ms FROM folders ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        Ok(FolderInfo { id: r.get(0)?, path: r.get(1)?, last_scanned_ms: r.get(2)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn touch_folder(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE folders SET last_scanned_ms = ?1 WHERE path = ?2",
        params![now_ms(), path],
    )?;
    Ok(())
}

pub fn settings_get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?)
}

pub fn settings_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)          ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn settings_get_all(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn settings_delete(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

/// 曲库统计
pub fn library_stats(conn: &Connection) -> AppResult<LibraryStats> {
    let row = conn.query_row(
        r#"
SELECT
  (SELECT COUNT(*) FROM tracks),
  (SELECT COUNT(*) FROM (SELECT 1 FROM tracks WHERE COALESCE(NULLIF(album_artist,''), artist) <> '' GROUP BY COALESCE(NULLIF(album_artist,''), artist))),
  (SELECT COUNT(*) FROM (SELECT 1 FROM tracks WHERE COALESCE(NULLIF(album_artist,''), artist) <> '' GROUP BY album, COALESCE(NULLIF(album_artist,''), artist))),
  (SELECT COUNT(*) FROM playlists),
  (SELECT COALESCE(SUM(duration_ms), 0) FROM tracks),
  (SELECT COALESCE(SUM(file_size), 0) FROM tracks)
"#,
        [],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        },
    )?;
    Ok(LibraryStats {
        track_count: row.0,
        artist_count: row.1,
        album_count: row.2,
        playlist_count: row.3,
        total_duration_secs: row.4 as f64 / 1000.0,
        total_size_bytes: row.5,
    })
}

/// 综合搜索（歌曲 / 专辑 / 艺术家 / 播放列表）
pub fn search(conn: &Connection, q: &str) -> AppResult<SearchResult> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(SearchResult { tracks: vec![], albums: vec![], artists: vec![], playlists: vec![] });
    }
    let like = format!("%{}%", escape_like(q));

    let mut f = TrackFilter { q: Some(q.to_string()), page: Some(1), page_size: Some(30), ..Default::default() };
    let tracks = list_tracks(conn, &f)?.items;
    f.page_size = Some(20);
    let albums = list_albums(conn, 1, 20, Some(q))?.items;

    let mut stmt = conn.prepare(
        "SELECT name, COUNT(*) AS track_count, COUNT(DISTINCT album) AS album_count          FROM (SELECT COALESCE(NULLIF(album_artist,''), artist) AS name, album FROM tracks)          WHERE name LIKE ?1 ESCAPE '\\' AND name <> ''          GROUP BY name ORDER BY name COLLATE NOCASE LIMIT 20",
    )?;
    let artists = stmt
        .query_map(params![like], |r| {
            Ok(Artist { name: r.get(0)?, track_count: r.get(1)?, album_count: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(&format!(
        "{PLAYLIST_SELECT} WHERE p.name LIKE ?1 ESCAPE '\\' ORDER BY p.updated_ms DESC LIMIT 10"
    ))?;
    let playlists = stmt
        .query_map(params![like], row_to_playlist)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(SearchResult { tracks, albums, artists, playlists })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn meta(path: &str) -> TrackMeta {
        TrackMeta {
            path: path.to_string(),
            title: path.to_string(),
            duration_ms: 120_000,
            format: "mp3".into(),
            file_size: 1234,
            file_mtime: 1,
            ..Default::default()
        }
    }

    #[test]
    fn upsert_and_query_track() {
        let conn = mem_conn();
        let (id, existed) = upsert_track(&conn, &meta("C:/Music/a.mp3")).unwrap();
        assert!(id > 0 && !existed);
        let (id2, existed2) = upsert_track(&conn, &meta("C:/Music/a.mp3")).unwrap();
        assert_eq!(id, id2);
        assert!(existed2);
        let t = track_by_id(&conn, id).unwrap().unwrap();
        assert_eq!(t.title, "C:/Music/a.mp3");
        assert_eq!(t.duration_secs, 120.0);
        assert_eq!(all_track_ids(&conn).unwrap().len(), 1);
    }

    #[test]
    fn playlist_flow() {
        let conn = mem_conn();
        let (id1, _) = upsert_track(&conn, &meta("C:/Music/a.mp3")).unwrap();
        let (id2, _) = upsert_track(&conn, &meta("C:/Music/b.mp3")).unwrap();
        let pl = create_playlist(&conn, " 测试 ").unwrap();
        assert_eq!(pl.name, "测试");
        let added = playlist_add_tracks(&conn, pl.id, &[id1, id2, id1]).unwrap();
        assert_eq!(added, 2);
        let ids = playlist_track_ids(&conn, pl.id).unwrap();
        assert_eq!(ids, vec![id1, id2]);
        // 插到指定位置
        playlist_remove_track(&conn, pl.id, id1).unwrap();
        assert_eq!(playlist_track_ids(&conn, pl.id).unwrap(), vec![id2]);
        // 重排
        playlist_reorder(&conn, pl.id, &[id2, id1]).unwrap();
        assert_eq!(playlist_track_ids(&conn, pl.id).unwrap(), vec![id2, id1]);
        delete_playlist(&conn, pl.id).unwrap();
        assert_eq!(list_playlists(&conn).unwrap().len(), 0);
    }

    #[test]
    fn search_and_folders() {
        let conn = mem_conn();
        add_folder(&conn, "C:/Music").unwrap();
        assert_eq!(list_folders(&conn).unwrap()[0].path, "C:/Music");
        touch_folder(&conn, "C:/Music").unwrap();
        upsert_track(&conn, &meta("C:/Music/xyz.mp3")).unwrap();
        let res = search(&conn, "xyz").unwrap();
        assert_eq!(res.tracks.len(), 1);
        settings_set(&conn, "volume", "80").unwrap();
        assert_eq!(settings_get(&conn, "volume").unwrap().as_deref(), Some("80"));
        assert_eq!(settings_get_all(&conn).unwrap().len(), 1);
    }
}