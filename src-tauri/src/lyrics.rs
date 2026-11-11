//! 歌词：优先读与音频同名的 .lrc / .ttml 文件，其次读内嵌标签；统一解析成带时间轴的歌词行。
//!
//! 支持的歌词格式（三选一，按内容自动识别）：
//!   1. 标准 LRC：行首 [mm:ss.xx]，只有行级时间轴；
//!   2. 增强 LRC（逐字）：行内用 <mm:ss.xx> 标记每个词的起始时间（A2 扩展，
//!      Lyrico 与多数安卓播放器导出的逐字歌词都是这个形状）；
//!   3. TTML（W3C Timed Text）：<p begin end> 为行、<span begin end> 为词。
//!
//! 统一模型：一行 = time_ms + text + words[]。
//! words 为空表示只有行级时间，前端按"行内线性插值"点亮；非空则是真实词级时间轴，
//! 前端按词推进进度 —— 这才是逐字卡拉OK 与"看着像逐字"的区别。
use std::path::{Path, PathBuf};

/// 一个词（逐字歌词的最小单位）
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// 一行歌词。time_ms 为毫秒；无时间轴歌词全部为 0（界面按顺序平铺显示）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub time_ms: i64,
    pub text: String,
    /// 逐字时间轴；空数组表示只有行级时间（序列化时省略）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<LyricWord>,
}

/// 一首歌的歌词结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// 来源：lrc-file / ttml-file / embedded / none
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

    // 1) 同名歌词文件（最常见：歌曲.lrc / 歌曲.ttml / 歌曲.txt）
    if let Some((file, text, is_ttml)) = read_sidecar(path) {
        let (synced, lines) = parse_any(&text, is_ttml);
        if !lines.is_empty() {
            let origin = file.file_name().and_then(|n| n.to_str()).map(|s| s.to_string());
            return Lyrics {
                source: if is_ttml { "ttml-file".into() } else { "lrc-file".into() },
                synced,
                origin,
                lines,
            };
        }
    }

    // 2) 内嵌标签（LYRICS / UNSYNCEDLYRICS / USLT）
    if let Some(text) = embedded(path) {
        let (synced, lines) = parse_any(&text, is_ttml_text(&text));
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

/// 查找同名歌词文件。逐字歌词常见的 ttml 优先，其次普通 lrc，最后 txt 兜底。
fn read_sidecar(audio: &Path) -> Option<(PathBuf, String, bool)> {
    let stem = audio.file_stem()?.to_str()?;
    let dir = audio.parent()?;
    const EXTS: [(&str, bool); 8] = [
        ("ttml", true),
        ("TTML", true),
        ("xml", true),
        ("lrc", false),
        ("LRC", false),
        ("Lrc", false),
        ("txt", false),
        ("TXT", false),
    ];
    for (ext, wants_ttml) in EXTS {
        let candidate = dir.join(format!("{stem}.{ext}"));
        let Ok(bytes) = std::fs::read(&candidate) else { continue };
        let text = decode_text(&bytes);
        if text.trim().is_empty() {
            continue;
        }
        // .xml 不一定是 TTML：真正看内容，避免把普通 xml 当歌词
        let ttml = wants_ttml && is_ttml_text(&text);
        if wants_ttml && !ttml {
            continue;
        }
        return Some((candidate, text, ttml));
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

/// 读内嵌歌词标签
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

/// 内容嗅探：是不是 TTML
fn is_ttml_text(text: &str) -> bool {
    let t = text.trim_start();
    if t.starts_with("<?xml") {
        return t.contains("<tt") || t.contains(":tt");
    }
    t.starts_with("<tt") || t.contains("<tt ") || t.contains(":tt ")
}

/// 按内容选择解析器（外部调用 / 内嵌标签走这里）
pub fn parse_any(text: &str, prefer_ttml: bool) -> (bool, Vec<LyricLine>) {
    if prefer_ttml || is_ttml_text(text) {
        let (synced, lines) = parse_ttml(text);
        if !lines.is_empty() {
            return (synced, lines);
        }
    }
    parse_lrc(text)
}

// ---------------------------------------------------------------------------
// LRC（含增强逐字）
// ---------------------------------------------------------------------------

/// 解析 LRC 文本：识别 [mm:ss.xx] 时间轴（可一行多个），无时间轴则按行平铺。
/// 行内若出现 <mm:ss.xx> 词级标记，会一并解析成 words。
/// 一行的主要文字体系。只用于"这一行像不像上一句的翻译"这一个判断，
/// 与 src/lib/lyricLines.ts 的 scriptClass 保持同一优先级（假名 > 谚文 > 汉字 > 拉丁）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum ScriptClass {
    Kana,
    Hangul,
    Han,
    Latin,
    Other,
}

fn script_class(text: &str) -> ScriptClass {
    let (mut kana, mut hangul, mut han, mut latin) = (false, false, false, false);
    for ch in text.chars() {
        let c = ch as u32;
        if (0x3041..=0x3096).contains(&c)
            || (0x309D..=0x309F).contains(&c)
            || (0x30A1..=0x30FA).contains(&c)
            || (0x30FD..=0x30FF).contains(&c)
            || (0x31F0..=0x31FF).contains(&c)
            || (0xFF66..=0xFF9D).contains(&c)
        {
            kana = true;
        } else if (0xAC00..=0xD7A3).contains(&c)
            || (0x1100..=0x11FF).contains(&c)
            || (0x3130..=0x318F).contains(&c)
        {
            hangul = true;
        } else if (0x3400..=0x4DBF).contains(&c)
            || (0x4E00..=0x9FFF).contains(&c)
            || (0xF900..=0xFAFF).contains(&c)
        {
            han = true;
        } else if ch.is_ascii_alphabetic() || (0x00C0..=0x024F).contains(&c) {
            latin = true;
        }
    }
    if kana {
        ScriptClass::Kana
    } else if hangul {
        ScriptClass::Hangul
    } else if han {
        ScriptClass::Han
    } else if latin {
        ScriptClass::Latin
    } else {
        ScriptClass::Other
    }
}

/// 去掉"出品公司 / 混音师 / 录音棚 / 母带工程师"这类后缀，只留条目本身。
fn credit_key(part: &str) -> &str {
    let mut s = part.trim();
    loop {
        let next = s
            .trim_end_matches("公司")
            .trim_end_matches("工程")
            .trim_end_matches(['人', '师', '棚', '室', '员']);
        if next == s {
            return s;
        }
        s = next;
    }
}

/// "作词 : xxx" / "作曲：xxx" / "编曲: xxx" 这类制作信息行。
/// 判据只看冒号左边那一小块，而且整块必须是已知的制作条目（"作词/作曲" 这种复合写法拆开逐段判断）。
fn is_credit_line(text: &str) -> bool {
    let Some(pos) = text.find([':', '：']) else { return false };
    let head = text[..pos].trim();
    if head.is_empty() || head.chars().count() > 12 {
        return false;
    }
    head.split(['/', '、', '&'])
        .map(credit_key)
        .filter(|part| !part.is_empty())
        .all(|part| {
            matches!(
                part.to_ascii_uppercase().as_str(),
                "作词" | "作曲" | "编曲" | "词" | "曲" | "词曲" | "制作" | "监制" | "混音" | "母带"
                    | "录音" | "和声" | "出品" | "发行" | "统筹" | "企划" | "策划" | "演唱" | "原唱"
                    | "吉他" | "贝斯" | "鼓" | "键盘" | "弦乐" | "钢琴" | "OP" | "SP" | "LRC" | "歌词"
                    | "翻译" | "校对" | "上传"
            )
        })
}

pub fn parse_lrc(text: &str) -> (bool, Vec<LyricLine>) {
    let mut timed: Vec<LyricLine> = Vec::new();
    let mut plain: Vec<LyricLine> = Vec::new();
    let mut offset_ms: i64 = 0;
    // 上一条歌词在 timed 里的下标（多时间戳的重复副歌会有多个）。
    // 没有时间戳的行如果能认成它的翻译，就继承这些时间点。
    let mut pending: Vec<usize> = Vec::new();

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
        if content.is_empty() {
            continue; // 纯时间戳行（间奏）暂不显示
        }
        // 制作信息（作词 / 作曲 / 编曲 / 混音 / 出品公司 …）不是歌词：
        // 它们会被当成歌词显示出来，还会把整首的语言判定算偏（英文歌被 20 个汉字判成中文）。
        // 有的文件把它们放在开头，有的放在末尾，所以不按位置判断，只看冒号左边是不是制作条目。
        if is_credit_line(content) {
            continue;
        }
        if stamps.is_empty() {
            // 混合型双语歌词：原词带时间戳、翻译整行不带时间戳。
            // 以前这类翻译无条件进 plain，而有时间轴时 plain 会被整个丢掉 —— 翻译行直接消失。
            // 现在：紧跟上一句歌词、文字体系又不同 → 当作它的翻译，共用它的时间点。
            if let Some(&at) = pending.first() {
                if timed[at].words.is_empty() && script_class(&timed[at].text) != script_class(content) {
                    let times: Vec<i64> = pending.iter().map(|&k| timed[k].time_ms).collect();
                    for time_ms in times {
                        timed.push(LyricLine { time_ms, text: content.to_string(), words: Vec::new() });
                    }
                    pending.clear(); // 一句歌词最多挂一条翻译
                    continue;
                }
            }
            plain.push(LyricLine { time_ms: 0, text: content.to_string(), words: Vec::new() });
            continue;
        }
        let inline = split_inline_words(content);
        let first_new = timed.len();
        for (i, ms) in stamps.iter().enumerate() {
            let start = ms + offset_ms;
            let mut text = content.to_string();
            let mut words: Vec<LyricWord> = Vec::new();
            if let Some((plain_text, raw_words)) = &inline {
                text = plain_text.clone();
                // 多时间戳是重复副歌：行内词时间属于第一次出现的位置，其余整体平移
                let shift = if i == 0 { 0 } else { stamps[i] - stamps[0] };
                words = build_words(raw_words, start, shift);
            }
            timed.push(LyricLine { time_ms: start, text, words });
        }
        pending = (first_new..timed.len()).collect();
    }

    if timed.is_empty() {
        return (false, plain);
    }
    timed.sort_by_key(|l| l.time_ms);
    fill_word_ends(&mut timed);
    (true, timed)
}

/// 拆分行内的 <mm:ss.xx> 标记。
/// 返回 (去掉标记后的纯文本, [(词起始毫秒, 该词之后的文本)])；不足两个标记时返回 None。
fn split_inline_words(content: &str) -> Option<(String, Vec<(i64, String)>)> {
    let chars: Vec<char> = content.chars().collect();
    let mut plain = String::new();
    let mut words: Vec<(i64, String)> = Vec::new();
    let mut markers = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '<' {
            if let Some(close) = chars[i + 1..].iter().position(|c| *c == '>') {
                let inner: String = chars[i + 1..i + 1 + close].iter().collect();
                if let Some(ms) = parse_stamp(&inner) {
                    markers += 1;
                    words.push((ms, String::new()));
                    i = i + close + 2;
                    continue;
                }
            }
        }
        plain.push(chars[i]);
        if let Some(last) = words.last_mut() {
            last.1.push(chars[i]);
        }
        i += 1;
    }
    if markers < 2 {
        return None;
    }
    let words: Vec<(i64, String)> = words.into_iter().filter(|(_, t)| !t.trim().is_empty()).collect();
    if words.len() < 2 {
        return None;
    }
    Some((plain.trim().to_string(), words))
}

/// 把 (起始毫秒, 词文本) 转成 LyricWord（end 先留 0，由 fill_word_ends 补）
fn build_words(raw: &[(i64, String)], line_start: i64, shift: i64) -> Vec<LyricWord> {
    raw.iter()
        .map(|(t, text)| LyricWord {
            text: text.clone(),
            start_ms: (*t + shift).max(line_start),
            end_ms: 0,
        })
        .collect()
}

/// 补每个词的结束时间：下一个词的开始；最后一个词取下一行的开始（或 +4s）
fn fill_word_ends(lines: &mut [LyricLine]) {
    let n = lines.len();
    for i in 0..n {
        if lines[i].words.is_empty() {
            continue;
        }
        let next_line = if i + 1 < n { lines[i + 1].time_ms } else { lines[i].time_ms + 4000 };
        let wlen = lines[i].words.len();
        for j in 0..wlen {
            let start = lines[i].words[j].start_ms;
            let end = if j + 1 < wlen {
                lines[i].words[j + 1].start_ms
            } else {
                next_line
            };
            lines[i].words[j].end_ms = end.max(start + 1);
        }
    }
}

/// mm:ss / mm:ss.xx / mm:ss.xxx / mm:ss:xx → 毫秒
fn parse_stamp(inner: &str) -> Option<i64> {
    let inner = inner.trim();
    if inner.is_empty() {
        return None;
    }
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

// ---------------------------------------------------------------------------
// TTML
// ---------------------------------------------------------------------------

/// 解析 TTML：<p begin end> 是行、<span begin end> 是词。
/// 用 quick-xml 做流式读取，不建整棵树；未知标签（styling/metadata 等）一律忽略。
pub fn parse_ttml(text: &str) -> (bool, Vec<LyricLine>) {
    use quick_xml::events::Event;

    let mut reader = quick_xml::Reader::from_str(text);
    reader.config_mut().trim_text(false);

    let mut lines: Vec<LyricLine> = Vec::new();
    let mut cur: Option<LyricLine> = None;
    let mut cur_end: Option<i64> = None;
    let mut word_start: Option<i64> = None;
    let mut word_end: Option<i64> = None;
    let mut word_text = String::new();
    let mut plain_text = String::new();
    let mut in_p = false;

    fn flush_word(
        cur: &mut Option<LyricLine>,
        start: Option<i64>,
        end: Option<i64>,
        text: &mut String,
    ) {
        let t = std::mem::take(text);
        if t.trim().is_empty() {
            return;
        }
        let Some(line) = cur.as_mut() else { return };
        let s = start.unwrap_or(line.time_ms);
        let e = end.unwrap_or(0);
        line.words.push(LyricWord { text: t, start_ms: s, end_ms: e });
    }

    fn flush_line(
        lines: &mut Vec<LyricLine>,
        cur: &mut Option<LyricLine>,
        plain: &mut String,
        line_end: Option<i64>,
    ) {
        let Some(mut line) = cur.take() else { return };
        let leftover = std::mem::take(plain);
        if line.words.is_empty() {
            line.text = leftover.trim().to_string();
        } else {
            if !leftover.trim().is_empty() {
                // span 之外的散字（少见）：拼成行尾最后一个词
                let s = line.words.last().map(|w| w.start_ms).unwrap_or(line.time_ms);
                line.words.push(LyricWord {
                    text: leftover.clone(),
                    start_ms: s,
                    end_ms: line_end.unwrap_or(s + 300),
                });
            }
            let joined: String = line.words.iter().map(|w| w.text.as_str()).collect();
            line.text = if joined.trim().is_empty() {
                leftover.trim().to_string()
            } else {
                joined.trim().to_string()
            };
        }
        if !line.text.trim().is_empty() {
            lines.push(line);
        }
    }

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = String::from_utf8_lossy(e.name().local_name().as_ref()).to_ascii_lowercase();
                match local.as_str() {
                    "p" => {
                        if let Some(b) = attr_time(&e, "begin") {
                            cur = Some(LyricLine { time_ms: b, text: String::new(), words: Vec::new() });
                            cur_end = attr_time(&e, "end");
                            plain_text.clear();
                            word_text.clear();
                            word_start = None;
                            word_end = None;
                            in_p = true;
                        } else {
                            in_p = false;
                        }
                    }
                    "span" if in_p => {
                        flush_word(&mut cur, word_start, word_end, &mut word_text);
                        word_start = attr_time(&e, "begin");
                        word_end = attr_time(&e, "end");
                    }
                    "br" if in_p => {
                        plain_text.push(' ');
                        word_text.push(' ');
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                // 自闭合标签：只有 <br/> 对我们有意义
                let local = String::from_utf8_lossy(e.name().local_name().as_ref()).to_ascii_lowercase();
                if local == "br" && in_p {
                    plain_text.push(' ');
                    word_text.push(' ');
                }
            }
            Ok(Event::End(e)) => {
                let local = String::from_utf8_lossy(e.name().local_name().as_ref()).to_ascii_lowercase();
                match local.as_str() {
                    "span" if in_p => {
                        flush_word(&mut cur, word_start, word_end, &mut word_text);
                        word_start = None;
                        word_end = None;
                    }
                    "p" if in_p => {
                        flush_word(&mut cur, word_start, word_end, &mut word_text);
                        word_start = None;
                        word_end = None;
                        flush_line(&mut lines, &mut cur, &mut plain_text, cur_end);
                        in_p = false;
                        cur_end = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if in_p {
                    if let Ok(t) = e.unescape() {
                        if word_start.is_some() {
                            word_text.push_str(&t);
                        } else {
                            plain_text.push_str(&t);
                        }
                    }
                }
            }
            Ok(Event::CData(e)) => {
                if in_p {
                    let t = String::from_utf8_lossy(e.as_ref()).to_string();
                    if word_start.is_some() {
                        word_text.push_str(&t);
                    } else {
                        plain_text.push_str(&t);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    if cur.is_some() {
        flush_word(&mut cur, word_start, word_end, &mut word_text);
        flush_line(&mut lines, &mut cur, &mut plain_text, cur_end);
    }

    lines.retain(|l| !l.text.trim().is_empty());
    if lines.is_empty() {
        return (false, Vec::new());
    }
    // 词尾兜底：span 没写 end 时用下一个词 / 行尾
    for line in lines.iter_mut() {
        let wlen = line.words.len();
        for j in 0..wlen {
            if line.words[j].end_ms <= line.words[j].start_ms {
                let end = if j + 1 < wlen { line.words[j + 1].start_ms } else { 0 };
                if end > 0 {
                    line.words[j].end_ms = end;
                } else if let Some(e) = cur_end {
                    line.words[j].end_ms = e;
                }
            }
        }
    }
    fill_word_ends(&mut lines);
    lines.sort_by_key(|l| l.time_ms);
    (true, lines)
}

/// 读标签属性里的时间表达式：00:00:12.340 / 12.34s / 1234ms / 12.5
fn attr_time(e: &quick_xml::events::BytesStart<'_>, key: &str) -> Option<i64> {
    for a in e.attributes().flatten() {
        let k = String::from_utf8_lossy(a.key.local_name().as_ref()).to_ascii_lowercase();
        if k == key {
            let v = String::from_utf8_lossy(a.value.as_ref()).to_string();
            return parse_time_expr(&v);
        }
    }
    None
}

/// TTML 时间表达式 → 毫秒。支持 hh:mm:ss.mmm / mm:ss.mmm / 12.5s / 340ms / 纯秒数。
pub fn parse_time_expr(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    if let Some(v) = lower.strip_suffix("ms") {
        return v.trim().parse::<f64>().ok().map(|f| f.round() as i64);
    }
    if let Some(v) = lower.strip_suffix('s') {
        return v.trim().parse::<f64>().ok().map(|f| (f * 1000.0).round() as i64);
    }
    if let Some(v) = lower.strip_suffix('h') {
        return v.trim().parse::<f64>().ok().map(|f| (f * 3_600_000.0).round() as i64);
    }
    if let Some(v) = lower.strip_suffix('m') {
        return v.trim().parse::<f64>().ok().map(|f| (f * 60_000.0).round() as i64);
    }
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        3 => {
            let h: f64 = parts[0].trim().parse().ok()?;
            let m: f64 = parts[1].trim().parse().ok()?;
            let sec: f64 = parts[2].trim().replace(',', ".").parse().ok()?;
            Some((h * 3_600_000.0 + m * 60_000.0 + sec * 1000.0).round() as i64)
        }
        2 => {
            let m: f64 = parts[0].trim().parse().ok()?;
            let sec: f64 = parts[1].trim().replace(',', ".").parse().ok()?;
            Some((m * 60_000.0 + sec * 1000.0).round() as i64)
        }
        1 => {
            let sec: f64 = parts[0].trim().replace(',', ".").parse().ok()?;
            Some((sec * 1000.0).round() as i64)
        }
        _ => None,
    }
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
        assert!(lines[0].words.is_empty());
        assert_eq!(lines[1].time_ms, 12345);
        assert_eq!(lines[2].time_ms, 62000);
    }

    /// 混合型双语歌词：原词带时间戳、翻译整行不带时间戳。
    /// 以前翻译行会被整行丢掉（有 timed 时 plain 不返回）。
    #[test]
    fn attaches_untimed_translation_to_previous_line() {
        let text = r#"[00:02.01]어둠 속에 남아 있는 my story
黑暗里残存的 我的故事
[00:10.96]짓눌린 왕관의 무게는 so heavy
被压垮的王冠 如此沉重
[00:15.83]그 이름 King
注：这一行是注释
再一行注释"#;
        let (synced, lines) = parse_lrc(text);
        assert!(synced);
        assert_eq!(lines.len(), 6);
        // 原词在前、翻译紧随其后，共用同一时间戳（前端按时间戳相等成组）
        assert_eq!(lines[0].text, "어둠 속에 남아 있는 my story");
        assert_eq!(lines[0].time_ms, 2010);
        assert_eq!(lines[1].text, "黑暗里残存的 我的故事");
        assert_eq!(lines[1].time_ms, 2010);
        assert_eq!(lines[2].time_ms, 10960);
        assert_eq!(lines[3].time_ms, 10960);
        // 一句歌词最多挂一条翻译：第三条无时间戳行没人可挂，保持旧行为（丢掉）
        assert_eq!(lines[4].text, "그 이름 King");
        assert_eq!(lines[5].text, "注：这一行是注释");
        assert_eq!(lines[5].time_ms, 15830);
    }

    /// 反例：文字体系相同、或上一行是行内逐字歌词时不要硬配。
    #[test]
    fn does_not_glue_same_script_or_enhanced_lines() {
        // 上一行已经是汉字 → 再来一行汉字，分不清谁是翻译
        let (_, same) = parse_lrc(r#"[00:02.00]第一句歌词
第二句也是汉字"#);
        assert_eq!(same.len(), 1);
        // 行内逐字时间的那一行不挂翻译（词级时间对不上整行时间戳）
        let (_, worded) = parse_lrc(r#"[00:10.00]<00:10.00>Hello <00:10.80>world
你好 世界"#);
        assert_eq!(worded.len(), 1);
    }

    /// 制作信息不是歌词：有的文件放开头，有的放末尾，都会被剔掉。
    #[test]
    fn skips_credit_lines() {
        let text = r#"[00:00.00]作词 : 张三/李四
[00:00.40]作曲：王五
[00:02.00]第一句歌词
[00:05.00]第二句歌词
[00:08.00]和声 : 张三
[00:09.00]混音师 : 时俊峰
[00:10.00]出品公司 : 某文化有限公司
[00:11.00]母带工程师 : 某工程师"#;
        let (synced, lines) = parse_lrc(text);
        assert!(synced);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "第一句歌词");
        assert_eq!(lines[1].text, "第二句歌词");

        // 正文里带冒号但不是制作条目的行照常保留
        let (_, keep) = parse_lrc("[00:02.00]爱：无法言说
[00:06.00]他说：别回头");
        assert_eq!(keep.len(), 2);
        assert_eq!(keep[0].text, "爱：无法言说");
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

    #[test]
    fn parses_enhanced_lrc_words() {
        let text = "[00:10.00]<00:10.00>Hello <00:10.80>world <00:11.60>again\n[00:13.00]next line";
        let (synced, lines) = parse_lrc(text);
        assert!(synced);
        assert_eq!(lines.len(), 2);
        let l = &lines[0];
        assert_eq!(l.time_ms, 10000);
        assert_eq!(l.text, "Hello world again");
        assert_eq!(l.words.len(), 3);
        assert_eq!(l.words[0].start_ms, 10000);
        assert_eq!(l.words[0].text.trim(), "Hello");
        assert_eq!(l.words[0].end_ms, 10800);
        assert_eq!(l.words[1].start_ms, 10800);
        assert_eq!(l.words[1].end_ms, 11600);
        assert_eq!(l.words[2].end_ms, 13000);
        assert!(lines[1].words.is_empty());
    }

    #[test]
    fn parses_ttml_lines_and_words() {
        let ttml = r#"<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body><div>
    <p begin="00:00:10.000" end="00:00:13.200">
      <span begin="00:00:10.000" end="00:00:10.900">Hello </span>
      <span begin="00:00:10.900" end="00:00:11.700">world</span>
      <span begin="00:00:11.700" end="00:00:13.200"> again</span>
    </p>
    <p begin="00:00:14.000" end="00:00:16.000">plain line</p>
  </div></body>
</tt>"#;
        let (synced, lines) = parse_ttml(ttml);
        assert!(synced, "ttml should be synced");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].time_ms, 10000);
        assert_eq!(lines[0].words.len(), 3);
        assert_eq!(lines[0].words[0].start_ms, 10000);
        assert_eq!(lines[0].words[0].end_ms, 10900);
        assert_eq!(lines[0].text, "Hello world again");
        assert_eq!(lines[1].time_ms, 14000);
        assert_eq!(lines[1].text, "plain line");
        assert!(lines[1].words.is_empty());
    }

    #[test]
    fn loads_ttml_sidecar_end_to_end() {
        // 端到端：同名 .ttml 文件 → load() 只凭歌曲路径就能找到并解析出词级时间
        let dir = std::env::temp_dir().join(format!("oberon-lyrics-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("song.flac");
        std::fs::write(&audio, b"").unwrap();
        let ttml = dir.join("song.ttml");
        std::fs::write(
            &ttml,
            r#"<tt><body><div><p begin="1s" end="3s"><span begin="1s" end="2s">Hi</span><span begin="2s" end="3s">there</span></p></div></body></tt>"#,
        )
        .unwrap();
        let l = load(audio.to_str().unwrap());
        assert_eq!(l.source, "ttml-file");
        assert!(l.synced);
        assert_eq!(l.lines.len(), 1);
        assert_eq!(l.lines[0].text, "Hithere");
        assert_eq!(l.lines[0].words.len(), 2);
        assert_eq!(l.lines[0].words[0].start_ms, 1000);
        assert_eq!(l.lines[0].words[0].end_ms, 2000);
        assert_eq!(l.lines[0].words[1].start_ms, 2000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_ttml_by_content() {
        assert!(is_ttml_text("<tt xmlns=\"http://www.w3.org/ns/ttml\"></tt>"));
        assert!(is_ttml_text("<?xml version=\"1.0\"?><tt:tt xmlns:tt=\"x\"></tt:tt>"));
        assert!(!is_ttml_text("[00:01.00]plain lrc"));
    }

    #[test]
    fn time_expressions() {
        assert_eq!(parse_time_expr("00:00:12.340"), Some(12340));
        assert_eq!(parse_time_expr("01:02.5"), Some(62500));
        assert_eq!(parse_time_expr("12.34s"), Some(12340));
        assert_eq!(parse_time_expr("340ms"), Some(340));
        assert_eq!(parse_time_expr("12,5"), Some(12500));
    }
}
