//! 歌词：优先读与音频同名的 .lrc 文件，其次读内嵌标签；统一解析成带时间轴的歌词行。
use std::path::{Path, PathBuf};

/// 一行歌词。`time_ms` 为毫秒；无时间轴歌词全部为 0（界面按顺序平铺显示）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub time_ms: i64,
    pub text: String,
}

/// 一首歌的歌词结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// 来源：`lrc-file` / `embedded` / `none`
    pub source: String,
    /// 是否带时间轴（可逐行高亮）
    pub synced: bool,
    /// 界面提示用的来源说明（文件名或标签名）
    pub origin: Option<String>,
    pub lines: Vec<LyricLine>,
}

impl Lyrics {
    pub fn none() -> Self {
        Self { source: "none".into(), synced: false, origin: None, lines: Vec::new() }
    }
}

/// 读取某首歌的歌词
pub fn load(audio_path: &str) -> Lyrics {
    let path = Path::new(audio_path);

    // 1) 同名歌词文件（最常见的做法：歌曲.lrc / 歌曲.txt）
    if let Some((file, text)) = read_sidecar(path) {
        let (synced, lines) = parse_lrc(&text);
        if !lines.is_empty() {
            let origin = file.file_name().and_then(|n| n.to_str()).map(|s| s.to_string());
            return Lyrics { source: "lrc-file".into(), synced, origin, lines };
        }
    }

    // 2) 内嵌标签（LYRICS / UNSYNCEDLYRICS / USLT）
    if let Some(text) = embedded(path) {
        let (synced, lines) = parse_lrc(&text);
        if !lines.is_empty() {
            return Lyrics {
                source: "embedded".into(),
                synced,
                origin: Some("内嵌歌词标签".into()),
                lines,
            };
        }
    }

    Lyrics::none()
}

/// 查找同名歌词文件（.lrc 优先，其次 .txt）
fn read_sidecar(audio: &Path) -> Option<(PathBuf, String)> {
    let stem = audio.file_stem()?.to_str()?;
    let dir = audio.parent()?;
    for ext in ["lrc", "LRC", "Lrc", "txt", "TXT"] {
        let candidate = dir.join(format!("{stem}.{ext}"));
        if let Ok(text) = std::fs::read(&candidate) {
            let text = decode_text(&text);
            if !text.trim().is_empty() {
                return Some((candidate, text));
            }
        }
    }
    None
}

/// 文本编码：UTF-8 优先，失败则按 GBK 近似处理（LRC 常见编码）
fn decode_text(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.trim_start_matches('\u{feff}').to_string();
    }
    // 无 UTF-8 BOM 的 GBK：逐字节映射不可行，这里退化为有损 UTF-8，
    // 至少保证不会因为编码问题整首歌词读不出来。
    String::from_utf8_lossy(bytes).to_string()
}

/// 读取内嵌歌词标签
fn embedded(path: &Path) -> Option<String> {
    use lofty::file::TaggedFileExt;
    use lofty::tag::ItemKey;

    // DSD（.dsf/.dff）：lofty 完全不支持这两种容器，下面的 Probe::open 必然失败，
    // 所以内嵌歌词必须改走 id3（USLT）。同目录 .lrc 那条路与格式无关，不受影响。
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "dsf" || ext == "dff" {
        return crate::engine::dsd::embedded_lyrics(path.to_string_lossy().as_ref());
    }

    let tagged = lofty::probe::Probe::open(path).ok()?.read().ok()?;
    for tag in tagged.tags() {
        for key in [ItemKey::Lyrics, ItemKey::UnsyncLyrics] {
            if let Some(text) = tag.get_string(key) {
                let text = text.trim();
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

/// 解析歌词文本：识别 `[mm:ss.xx]` 时间轴（可一行多个），无时间轴则按行平铺。
pub fn parse_lrc(text: &str) -> (bool, Vec<LyricLine>) {
    let mut timed: Vec<LyricLine> = Vec::new();
    let mut plain: Vec<LyricLine> = Vec::new();
    let mut offset_ms: i64 = 0;

    for raw in text.lines() {
        let line = raw.trim_end_matches(['\r', '\n']).trim();
        if line.is_empty() {
            continue;
        }
        let mut rest = line;
        let mut stamps: Vec<i64> = Vec::new();

        // 依次取出行首的 [..] 标记
        while rest.starts_with('[') {
            let Some(end) = rest.find(']') else { break };
            let inner = &rest[1..end];
            if let Some(ms) = parse_stamp(inner) {
                stamps.push(ms);
                rest = rest[end + 1..].trim_start();
            } else if let Some(v) = inner.strip_prefix("offset:") {
                if let Ok(n) = v.trim().parse::<i64>() {
                    offset_ms = n;
                }
                rest = rest[end + 1..].trim_start();
            } else {
                // [ar:xxx] / [ti:xxx] / [by:xxx] 等元信息，直接跳过
                rest = rest[end + 1..].trim_start();
            }
        }

        let content = rest.trim();
        if stamps.is_empty() {
            if !content.is_empty() {
                plain.push(LyricLine { time_ms: 0, text: content.to_string() });
            }
            continue;
        }
        if content.is_empty() {
            continue; // 纯时间戳行（间奏）暂不显示
        }
        for ms in stamps {
            timed.push(LyricLine { time_ms: ms + offset_ms, text: content.to_string() });
        }
    }

    if timed.is_empty() {
        return (false, plain);
    }
    timed.sort_by_key(|l| l.time_ms);
    (true, timed)
}

/// `mm:ss` / `mm:ss.xx` / `mm:ss.xxx` → 毫秒
fn parse_stamp(inner: &str) -> Option<i64> {
    let (mm, rest) = inner.split_once(':')?;
    let minutes: i64 = mm.trim().parse().ok()?;
    let (ss, frac) = match rest.split_once(['.', ':']) {
        Some((s, f)) => (s, Some(f)),
        None => (rest, None),
    };
    let seconds: i64 = ss.trim().parse().ok()?;
    let mut ms = (minutes * 60 + seconds) * 1000;
    if let Some(f) = frac {
        let digits: String = f.chars().filter(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            let mut v: i64 = digits.parse().ok()?;
            // 两位表示厘秒，三位表示毫秒
            if digits.len() == 1 {
                v *= 100;
            } else if digits.len() == 2 {
                v *= 10;
            } else if digits.len() > 3 {
                v /= 10i64.pow((digits.len() - 3) as u32);
            }
            ms += v;
        }
    }
    Some(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_synced_lrc() {
        let text = "[ar:Someone]\n[00:01.50]first\n[00:12.345]second\n[01:02]third";
        let (synced, lines) = parse_lrc(text);
        assert!(synced);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].time_ms, 1500);
        assert_eq!(lines[0].text, "first");
        assert_eq!(lines[1].time_ms, 12345);
        assert_eq!(lines[2].time_ms, 62000);
    }

    #[test]
    fn parses_plain_lyrics() {
        let (synced, lines) = parse_lrc("line one\n\nline two\n");
        assert!(!synced);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].text, "line two");
    }

    #[test]
    fn applies_offset_and_multiple_stamps() {
        let (_, lines) = parse_lrc("[offset:-500]\n[00:02.00][00:05.00]repeat");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].time_ms, 1500);
        assert_eq!(lines[1].time_ms, 4500);
    }
}
