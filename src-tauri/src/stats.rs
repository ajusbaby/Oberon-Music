//! 听歌统计的持久化层：把「日 / 周 / 月 / 年」的时间序列存成**应用之外**的 JSON 文件。
//!
//! 为什么不让它躺在 localStorage 里：
//!   · WebView2 的 localStorage 在 %LOCALAPPDATA%\...\EBWebView 里，清理工具、重置系统、
//!     勾选「删除应用数据」的卸载器都会连着一起删掉，统计就全没了；
//!   · 更要命的是键用的是自增 trackId —— 重装后重新扫描曲库，id 会重新分配，
//!     历史明细会指向**别的歌**，即使字节还在也是错的。
//!
//! 所以这里做了两件事：
//!   1. 双写：主副本在 app_data/listening.json，镜像在「文档/Oberon/听歌统计/listening.json」。
//!      卸载不会动文档目录，主副本被清掉时还能从镜像读回来。
//!   2. 键换成 trackKey = FNV-1a(规范化路径)，并且顺手存下每首歌的路径 / 标题 / 艺术家，
//!      这样曲库重建、文件搬家、甚至整个库都不在了，统计仍然认得「这是哪首歌」。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// 当前文件格式版本：3 = trackKey + tracks 元数据
pub const STATS_VERSION: u32 = 3;

/// 路径规范化：统一分隔符 + 大小写折叠（Windows 路径大小写不敏感）
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// FNV-1a 64 位，输出 16 位小写十六进制。
/// ⚠️ 必须与前端 src/lib/listenLog.ts 的 trackKeyOf() 完全一致 —— 两边算出来的键不认识彼此，
///    迁移就会把同一首歌拆成两条记录。
pub fn track_key(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalize_path(path).as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 每个 trackKey 的元数据：曲库没了也要能显示歌名
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TrackMeta {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    /// 时长（秒）
    #[serde(default)]
    pub dur: f64,
}

impl TrackMeta {
    pub fn from_row(path: String, title: String, artist: String, album: String, dur: f64) -> Self {
        Self { path, title, artist, album, dur }
    }

    fn from_json(value: &Value) -> Option<Self> {
        let path = value.get("path").and_then(Value::as_str).unwrap_or_default();
        if path.is_empty() {
            return None;
        }
        Some(Self {
            path: path.to_string(),
            title: str_of(value, "title"),
            artist: str_of(value, "artist"),
            album: str_of(value, "album"),
            dur: num_of(value, "dur"),
        })
    }

    fn to_json(&self) -> Value {
        serde_json::json!({
            "path": self.path,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "dur": round3(self.dur),
        })
    }
}

/// 合并 / 迁移的结果统计，前端用它决定要不要提示用户
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    /// 合并后的 JSON 文本
    pub json: String,
    pub days: usize,
    pub tracks: usize,
    /// 旧版按 trackId 记账、但曲库里已经找不到那条记录的格子数
    pub unresolved: usize,
    pub updated_ms: f64,
}

#[derive(Debug, Default)]
struct DayAcc {
    secs: f64,
    plays: f64,
    tracks: BTreeMap<String, [f64; 2]>,
}

#[derive(Debug, Default)]
struct Acc {
    days: BTreeMap<String, DayAcc>,
    tracks: BTreeMap<String, TrackMeta>,
    unresolved: usize,
    updated_ms: f64,
}

fn str_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn num_of(value: &Value, key: &str) -> f64 {
    match value.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn is_day_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

fn is_track_key(key: &str) -> bool {
    key.len() == 16 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

impl Acc {
    /// 吃进一份 JSON：可能是 v3（trackKey 键），也可能是 v1 / v2（自增 trackId 键）
    fn absorb(&mut self, raw: &str, resolve: &HashMap<i64, TrackMeta>) {
        let parsed: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => return,
        };
        let Some(root) = parsed.as_object() else { return };

        let updated = num_of(&parsed, "updatedMs");
        if updated > self.updated_ms {
            self.updated_ms = updated;
        }

        if let Some(tracks) = root.get("tracks").and_then(Value::as_object) {
            for (key, meta) in tracks {
                if let Some(meta) = TrackMeta::from_json(meta) {
                    self.tracks.insert(key.to_ascii_lowercase(), meta);
                }
            }
        }

        let Some(days) = root.get("days").and_then(Value::as_object) else { return };
        for (day_key, day) in days {
            if !is_day_key(day_key) {
                continue;
            }
            let day_secs = num_of(day, "s");
            let day_plays = num_of(day, "p");
            // 先把这一天的格子全部解析成 trackKey（这一步会写 self.tracks），
            // 再借 self.days —— 否则 entry 的可变借用和 key_of 的可变借用打架。
            let mut resolved: Vec<(String, f64, f64)> = Vec::new();
            if let Some(cells) = day.get("t").and_then(Value::as_object) {
                for (raw_key, cell) in cells {
                    let (plays, secs) = match cell {
                        // v2：[次数, 秒数]
                        Value::Array(arr) => (
                            arr.first().map(num_any).unwrap_or(0.0),
                            arr.get(1).map(num_any).unwrap_or(0.0),
                        ),
                        // v1：只有次数
                        other => (num_any(other), 0.0),
                    };
                    if plays <= 0.0 && secs <= 0.0 {
                        continue;
                    }
                    let Some(key) = self.key_of(raw_key, resolve) else {
                        self.unresolved += 1;
                        continue;
                    };
                    resolved.push((key, plays, secs));
                }
            }
            let entry = self.days.entry(day_key.clone()).or_default();
            // 取最大值而不是相加：这几份数据几乎总是**同一本账的不同快照**
            // （缓存、文件、上次导出的备份），相加会让每次启动都把统计翻一倍。
            // 取最大值则天然幂等：同一份数据并多少次，结果都一样。
            entry.secs = entry.secs.max(day_secs);
            entry.plays = entry.plays.max(day_plays);
            for (key, plays, secs) in resolved {
                let slot = entry.tracks.entry(key).or_insert([0.0, 0.0]);
                slot[0] = slot[0].max(plays);
                slot[1] = slot[1].max(secs);
            }
        }
    }

    fn key_of(&mut self, raw_key: &str, resolve: &HashMap<i64, TrackMeta>) -> Option<String> {
        if is_track_key(raw_key) {
            let key = raw_key.to_ascii_lowercase();
            if self.tracks.contains_key(&key) {
                return Some(key);
            }
            // 元数据丢了但格子还在：留一个只有键的空壳，比丢掉这些秒数强
            self.tracks.insert(
                key.clone(),
                TrackMeta { path: String::new(), title: "已不在曲库".into(), ..Default::default() },
            );
            return Some(key);
        }
        // 之前迁移时就已经对不上曲库的格子：原样留着
        if raw_key.starts_with("id:") {
            let key = raw_key.to_string();
            self.tracks.entry(key.clone()).or_insert(TrackMeta {
                path: String::new(),
                title: format!("曲目 #{}", key.trim_start_matches("id:")),
                artist: "曲库中已找不到".into(),
                ..Default::default()
            });
            return Some(key);
        }
        // v1 / v2：自增 id，只能问曲库要路径
        if let Ok(id) = raw_key.parse::<i64>() {
            if let Some(meta) = resolve.get(&id) {
                let key = track_key(&meta.path);
                self.tracks.entry(key.clone()).or_insert_with(|| meta.clone());
                return Some(key);
            }
            // 曲库里已经没有这条记录了：保留数字，但要标明它不再对应任何文件
            let key = format!("id:{id}");
            self.tracks.entry(key.clone()).or_insert(TrackMeta {
                path: String::new(),
                title: format!("曲目 #{id}"),
                artist: "曲库中已找不到".into(),
                ..Default::default()
            });
            return Some(key);
        }
        None
    }

    fn to_json(&self) -> Value {
        let mut days = Map::new();
        for (day_key, day) in &self.days {
            let mut cells = Map::new();
            for (key, pair) in &day.tracks {
                cells.insert(
                    key.clone(),
                    Value::Array(vec![Value::from(round3(pair[0])), Value::from(round3(pair[1]))]),
                );
            }
            days.insert(
                day_key.clone(),
                serde_json::json!({
                    "s": round3(day.secs),
                    "p": round3(day.plays),
                    "t": Value::Object(cells),
                }),
            );
        }
        let mut tracks = Map::new();
        for (key, meta) in &self.tracks {
            tracks.insert(key.clone(), meta.to_json());
        }
        serde_json::json!({
            "v": STATS_VERSION,
            "days": Value::Object(days),
            "tracks": Value::Object(tracks),
            "updatedMs": self.updated_ms.round() as i64,
        })
    }
}

fn num_any(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// 把任意份 JSON（v1 / v2 / v3 混着来都行）合并成一份 v3。
/// resolve 是「旧 trackId → 曲目元数据」的映射，只有迁旧账时才需要。
///
/// 合并语义是**按格子取最大值**（幂等），不是相加：传进来的几份通常是同一本账的不同
/// 快照，相加会把统计越并越多。真需要两份账相加（两台机器各有记录）时，也宁可贵在
/// 「不重复」而不是「不遗漏」—— 重复是每天都会发生的，遗漏只在换机时发生一次。
pub fn merge(parts: &[String], resolve: &HashMap<i64, TrackMeta>) -> MergeReport {
    let mut acc = Acc::default();
    for raw in parts {
        acc.absorb(raw, resolve);
    }
    let tracks = acc.tracks.len();
    let days = acc.days.len();
    let unresolved = acc.unresolved;
    let updated_ms = acc.updated_ms;
    let json = serde_json::to_string(&acc.to_json()).unwrap_or_else(|_| "{}".into());
    MergeReport { json, days, tracks, unresolved, updated_ms }
}

/// 文件里的 updatedMs（用来判断主副本和镜像哪份更新）
pub fn updated_ms_of(raw: &str) -> f64 {
    serde_json::from_str::<Value>(raw)
        .ok()
        .map(|v| num_of(&v, "updatedMs"))
        .unwrap_or(0.0)
}

/// 只有结构像模像样才当作有效副本（防止把半个文件当成权威数据）
pub fn is_valid(raw: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(raw) else { return false };
    let Some(root) = v.as_object() else { return false };
    root.get("days").map(Value::is_object).unwrap_or(false)
        && root.get("v").and_then(Value::as_u64).map(|v| v >= 1 && v <= 9).unwrap_or(false)
}

/// 原子写：先写 .tmp、顺手把旧文件留成 .bak，再改名到位
pub fn write_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    if target.exists() {
        let bak = target.with_extension("json.bak");
        let _ = std::fs::copy(target, &bak);
        std::fs::remove_file(target)?;
    }
    std::fs::rename(&tmp, target)
        .map_err(|e| AppError::io(format!("写入 {} 失败: {e}", target.display())))?;
    Ok(())
}

/// 主副本在数据目录，镜像在文档目录 —— 卸载器删前者、不删后者
pub fn mirror_path(documents: Option<PathBuf>) -> Option<PathBuf> {
    documents.map(|dir| dir.join("Oberon").join("听歌统计").join("listening.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_across_separators_and_case() {
        let a = track_key("D:\\Music\\Aimer\\Brave Shine.flac");
        let b = track_key("d:/music/aimer/brave shine.FLAC");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn merges_v2_ids_into_path_keys() {
        let legacy = r#"{"v":2,"days":{"2026-11-01":{"s":120,"p":2,"t":{"7":[2,120]}}},"updatedMs":1000}"#;
        let mut resolve = HashMap::new();
        resolve.insert(
            7i64,
            TrackMeta::from_row("D:\\Music\\demo.mp3".into(), "Demo".into(), "Artist".into(), "Album".into(), 200.0),
        );
        let report = merge(&[legacy.to_string()], &resolve);
        let v: Value = serde_json::from_str(&report.json).unwrap();
        let key = track_key("D:\\Music\\demo.mp3");
        assert_eq!(v["days"]["2026-11-01"]["t"][&key][0], 2.0);
        assert_eq!(v["days"]["2026-11-01"]["t"][&key][1], 120.0);
        assert_eq!(v["tracks"][&key]["title"], "Demo");
        assert_eq!(report.unresolved, 0);
    }

    #[test]
    fn keeps_unresolvable_legacy_ids_instead_of_dropping() {
        let legacy = r#"{"v":2,"days":{"2026-11-01":{"s":30,"p":1,"t":{"99":[1,30]}}},"updatedMs":1}"#;
        let report = merge(&[legacy.to_string()], &HashMap::new());
        let v: Value = serde_json::from_str(&report.json).unwrap();
        assert_eq!(v["days"]["2026-11-01"]["t"]["id:99"][1], 30.0);
        assert_eq!(v["days"]["2026-11-01"]["s"], 30.0);
    }

    #[test]
    fn merge_is_idempotent_and_keeps_newest_timestamp() {
        let a = r#"{"v":3,"days":{"2026-11-01":{"s":60,"p":1,"t":{}}},"tracks":{},"updatedMs":500}"#;
        let b = r#"{"v":3,"days":{"2026-11-01":{"s":90,"p":2,"t":{}}},"tracks":{},"updatedMs":900}"#;
        let once = merge(&[a.to_string(), b.to_string()], &HashMap::new());
        let v: Value = serde_json::from_str(&once.json).unwrap();
        // 取最大值：同一天两个快照，60 与 90 取 90
        assert_eq!(v["days"]["2026-11-01"]["s"], 90.0);
        assert_eq!(v["days"]["2026-11-01"]["p"], 2.0);
        assert_eq!(v["updatedMs"], 900);
        // 同一份并两次结果不变 —— 每次启动都会并一遍，不幂等就会天天翻倍
        let twice = merge(&[once.json.clone(), once.json], &HashMap::new());
        let w: Value = serde_json::from_str(&twice.json).unwrap();
        assert_eq!(w["days"]["2026-11-01"]["s"], 90.0);
        assert_eq!(w["days"]["2026-11-01"]["p"], 2.0);
    }

    #[test]
    fn keeps_previous_unresolved_cells() {
        // 上次迁移留下的 id:<n> 格子，再并一遍不能丢
        let raw = r#"{"v":3,"days":{"2026-11-01":{"s":30,"p":1,"t":{"id:99":[1,30]}}},"tracks":{"id:99":{"path":"","title":"曲目 #99","artist":"曲库中已找不到","album":"","dur":0}},"updatedMs":1}"#;
        let report = merge(&[raw.to_string()], &HashMap::new());
        let v: Value = serde_json::from_str(&report.json).unwrap();
        assert_eq!(v["days"]["2026-11-01"]["t"]["id:99"][1], 30.0);
    }

    #[test]
    fn rejects_structurally_broken_payloads() {
        assert!(!is_valid("not json"));
        assert!(!is_valid(r#"{"v":3}"#));
        assert!(is_valid(r#"{"v":3,"days":{},"tracks":{}}"#));
    }
}
