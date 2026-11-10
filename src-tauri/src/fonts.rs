//! 字体资源解析：导入阶段一次性完成，渲染阶段只读索引。
//!
//! 这一层只回答"这个字体文件有什么"（文档《歌词自定义字体系统方案》§2 字体资源层）：
//!   · 容器：sfnt（ttf/otf）、ttc 字体集合、woff（zlib）、woff2（brotli）；
//!   · name 表 → family / subfamily / postscript name；
//!   · OS/2 → 字重 / 字宽 / 斜体 / 嵌入限制；fvar → 可变字体轴；
//!   · cmap → **真实覆盖的码位集合**。
//!
//! 为什么自己解析、而不是等浏览器 new FontFace() 之后去量：
//!   浏览器不告诉你一个字体覆盖了哪些字；量宽度会被"缺字自动落到回退字体"骗过去
//!   （量出来像是有字）。而"有没有这个字形"正是缺字回退、档案建议、预览诊断的全部依据。
//!   覆盖统计只认 cmap：字体文件里声明的 unicode-range 只是提示（文档 §4.1 明说）。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};
use std::io::Read;

/// 单文件上限：64MB（超大 CJK 全集字体也就 30–40MB，再大基本是打包错的文件）
pub const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;
/// 单文件下限：1KB（低于这个不可能是字体）
pub const MIN_FONT_BYTES: u64 = 1024;
/// 支持的扩展名（白名单，小写）
pub const SUPPORTED_EXTENSIONS: [&str; 5] = ["ttf", "otf", "ttc", "woff", "woff2"];

/* ============================ 数据模型（文档 §9.1） ============================ */

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VariableAxis {
    pub tag: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
}

/// 覆盖统计：每一项是"参考集合里覆盖了多少"的百分比（0–100，一位小数）。
///
/// 参考集合是固定的，因此同一个字体算多少次都是同一个数 —— 用户看到的
/// "常用汉字 98.7%" 不会因为哪次统计的样本不同而变。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    /// 可打印 ASCII + Latin-1 字母
    pub latin: f32,
    /// 基本区汉字 U+4E00–U+9FFF
    pub han_common: f32,
    /// 扩展 A / 扩展 B：U+3400–U+4DBF、U+20000–U+2A6DF
    pub han_ext: f32,
    /// 平假名 + 片假名
    pub kana: f32,
    /// 谚文音节 U+AC00–U+D7A3
    pub hangul: f32,
    /// 常用符号（箭头、音符、序号、括号…）
    pub symbols: f32,
    /// 常用 Emoji
    pub emoji: f32,
}

/// 一个字体资源 = 一个字体文件里的**一个 face**。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FontResource {
    pub id: String,
    pub content_hash: String,
    /// 字体目录里的文件名（内容哈希 + face 序号）
    pub file_name: String,
    /// 用户导入时的原始文件名（只用于展示）
    pub original_name: String,
    pub byte_size: u64,
    pub face_index: u32,
    pub faces: u32,
    pub family: String,
    pub subfamily: String,
    pub postscript: Option<String>,
    pub weight: u16,
    pub width: u16,
    pub italic: bool,
    /// fsType：0 = 可自由嵌入；2/4 位为"禁止嵌入"
    pub embedding: u16,
    pub variable: bool,
    pub axes: Vec<VariableAxis>,
    /// truetype / cff / collection / woff / woff2 / unknown
    pub format: String,
    /// latin / han / kana / hangul / symbols / emoji（有实际覆盖的脚本）
    pub scripts: Vec<String>,
    pub coverage: Coverage,
    /// cmap 实际覆盖的码位数
    pub codepoints: u32,
    /// 覆盖码位压缩成区间，前端据此逐字判断"这个字主字体有没有"
    pub coverage_ranges: Vec<[u32; 2]>,
    /// 导入时间（毫秒时间戳）
    pub added_at: i64,
    /// 是否成功解析出元数据（false = 仍然可以用，但没有覆盖统计）
    pub parsed: bool,
    /// 解析告警（集合只取第一个 face、woff2 解压失败、非 sfnt 容器…）
    pub warning: Option<String>,
    /// 索引里的文件在磁盘上已经不在了（只有 font_list 会置位）
    #[serde(default)]
    pub missing: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub path: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: Vec<FontResource>,
    /// 内容哈希相同、已存在 —— 不重复入库（文档 §16「同一字体多次导入只保留一个资源记录」）
    pub duplicates: Vec<FontResource>,
    pub failed: Vec<ImportFailure>,
}

/* ============================ 解析结果（内部） ============================ */

pub struct ParsedFont {
    pub family: String,
    pub subfamily: String,
    pub postscript: Option<String>,
    pub weight: u16,
    pub width: u16,
    pub italic: bool,
    pub embedding: u16,
    pub axes: Vec<VariableAxis>,
    pub format: String,
    pub faces: u32,
    pub face_index: u32,
    pub codepoints: BTreeSet<u32>,
}

/* ============================ 字节读取小工具 ============================ */

fn be_u16(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(o)?, *b.get(o + 1)?]))
}

fn be_u32(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes([*b.get(o)?, *b.get(o + 1)?, *b.get(o + 2)?, *b.get(o + 3)?]))
}

fn be_i16(b: &[u8], o: usize) -> Option<i16> {
    be_u16(b, o).map(|v| v as i16)
}

fn take(b: &[u8], o: usize, n: usize) -> Option<&[u8]> {
    if o.checked_add(n)? > b.len() {
        None
    } else {
        Some(&b[o..o + n])
    }
}

fn tag_at(b: &[u8], o: usize) -> Option<[u8; 4]> {
    let s = take(b, o, 4)?;
    Some([s[0], s[1], s[2], s[3]])
}

/* ============================ 容器：表目录 ============================ */

struct FaceTables<'a> {
    tables: HashMap<[u8; 4], Cow<'a, [u8]>>,
    faces: u32,
    face_index: u32,
    format: String,
}

fn read_face<'a>(bytes: &'a [u8], face_index: u32) -> AppResult<FaceTables<'a>> {
    let sig = tag_at(bytes, 0).ok_or_else(|| AppError::param("文件太小，不像字体"))?;
    if &sig == b"ttcf" {
        let n = be_u32(bytes, 8).unwrap_or(0);
        if n == 0 || n > 256 {
            return Err(AppError::param("字体集合头损坏"));
        }
        let idx = face_index.min(n - 1);
        let off = be_u32(bytes, 12 + 4 * idx as usize)
            .ok_or_else(|| AppError::param("字体集合目录被截断"))? as usize;
        let mut f = read_sfnt(bytes, off)?;
        f.faces = n;
        f.face_index = idx;
        f.format = "collection".into();
        return Ok(f);
    }
    if &sig == b"wOFF" {
        return read_woff(bytes);
    }
    if &sig == b"wOF2" {
        return read_woff2(bytes);
    }
    read_sfnt(bytes, 0)
}

fn read_sfnt<'a>(bytes: &'a [u8], base: usize) -> AppResult<FaceTables<'a>> {
    let version = tag_at(bytes, base).ok_or_else(|| AppError::param("字体头被截断"))?;
    let is_sfnt = &version == b"OTTO"
        || &version == b"true"
        || &version == b"typ1"
        || version == [0, 1, 0, 0];
    if !is_sfnt {
        return Err(AppError::param("不是可识别的 sfnt 字体"));
    }
    let num = be_u16(bytes, base + 4).ok_or_else(|| AppError::param("字体头被截断"))? as usize;
    if num == 0 || num > 512 {
        return Err(AppError::param("字体表数量异常"));
    }
    let mut tables = HashMap::with_capacity(num);
    for i in 0..num {
        let rec = base + 12 + i * 16;
        let tag = match tag_at(bytes, rec) {
            Some(t) => t,
            None => break,
        };
        let (off, len) = match (be_u32(bytes, rec + 8), be_u32(bytes, rec + 12)) {
            (Some(o), Some(l)) => (o as usize, l as usize),
            _ => break,
        };
        if off == 0 || len == 0 {
            continue;
        }
        if let Some(data) = take(bytes, off, len) {
            tables.insert(tag, Cow::Borrowed(data));
        }
    }
    let format = if &version == b"OTTO" { "cff" } else { "truetype" }.to_string();
    Ok(FaceTables { tables, faces: 1, face_index: 0, format })
}

/// WOFF 1.0：每张表独立 zlib 压缩，解压后就是原始表数据。
fn read_woff(bytes: &[u8]) -> AppResult<FaceTables<'static>> {
    let num = be_u16(bytes, 12).ok_or_else(|| AppError::param("WOFF 头被截断"))? as usize;
    if num == 0 || num > 512 {
        return Err(AppError::param("WOFF 表数量异常"));
    }
    let mut tables = HashMap::with_capacity(num);
    for i in 0..num {
        let rec = 44 + i * 20;
        let tag = tag_at(bytes, rec).ok_or_else(|| AppError::param("WOFF 表目录被截断"))?;
        let off = be_u32(bytes, rec + 4).ok_or_else(|| AppError::param("WOFF 表目录被截断"))? as usize;
        let comp = be_u32(bytes, rec + 8).ok_or_else(|| AppError::param("WOFF 表目录被截断"))? as usize;
        let orig = be_u32(bytes, rec + 12).ok_or_else(|| AppError::param("WOFF 表目录被截断"))? as usize;
        let raw = take(bytes, off, comp).ok_or_else(|| AppError::param("WOFF 表数据越界"))?;
        let data = if comp < orig {
            let mut out = Vec::with_capacity(orig);
            flate2::read::ZlibDecoder::new(raw)
                .read_to_end(&mut out)
                .map_err(|e| AppError::param(format!("WOFF 表解压失败: {e}")))?;
            if out.len() < orig {
                return Err(AppError::param("WOFF 表解压长度不足"));
            }
            out.truncate(orig);
            out
        } else {
            raw.to_vec()
        };
        tables.insert(tag, Cow::Owned(data));
    }
    Ok(FaceTables { tables, faces: 1, face_index: 0, format: "woff".into() })
}

/// WOFF2 的 63 个预定义表标签（顺序是规范的一部分，不能改）
const WOFF2_TAGS: [&[u8; 4]; 63] = [
    b"cmap", b"head", b"hhea", b"hmtx", b"maxp", b"name", b"OS/2", b"post", b"cvt ", b"fpgm",
    b"glyf", b"loca", b"prep", b"CFF ", b"VORG", b"EBDT", b"EBLC", b"gasp", b"hdmx", b"kern",
    b"LTSH", b"PCLT", b"VDMX", b"vhea", b"vmtx", b"BASE", b"GDEF", b"GPOS", b"GSUB", b"EBSC",
    b"JSTF", b"MATH", b"CBDT", b"CBLC", b"COLR", b"CPAL", b"SVG ", b"sbix", b"acnt", b"avar",
    b"bdat", b"bloc", b"bsln", b"cvar", b"fdsc", b"feat", b"fmtx", b"fvar", b"gvar", b"hsty",
    b"just", b"lcar", b"mort", b"morx", b"opbd", b"prop", b"trak", b"Zapf", b"Silf", b"Glat",
    b"Gloc", b"Feat", b"Sill",
];

fn read_base128(b: &[u8], pos: &mut usize) -> AppResult<usize> {
    let mut value: usize = 0;
    for i in 0..5 {
        let byte = *b.get(*pos).ok_or_else(|| AppError::param("WOFF2 目录被截断"))?;
        *pos += 1;
        if i == 0 && byte == 0x80 {
            return Err(AppError::param("WOFF2 变长整数有前导零"));
        }
        if value & 0xFE00_0000 != 0 {
            return Err(AppError::param("WOFF2 变长整数溢出"));
        }
        value = (value << 7) | (byte & 0x7F) as usize;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(AppError::param("WOFF2 变长整数过长"))
}

/// WOFF2：整段 brotli 压缩，目录里给每张表的原始/变换后长度。
/// 我们只需要 name / OS/2 / head / fvar / cmap —— 这几张都不参与 glyph 变换，
/// 因此在解压后的拼接流里按目录顺序切片即可（glyf/loca 被变换过，跳过就好）。
fn read_woff2(bytes: &[u8]) -> AppResult<FaceTables<'static>> {
    let num = be_u16(bytes, 12).ok_or_else(|| AppError::param("WOFF2 头被截断"))? as usize;
    if num == 0 || num > 512 {
        return Err(AppError::param("WOFF2 表数量异常"));
    }
    let total_comp = be_u32(bytes, 20).ok_or_else(|| AppError::param("WOFF2 头被截断"))? as usize;
    struct Entry {
        tag: [u8; 4],
        stored: usize,
        keep: bool,
    }
    let mut entries = Vec::with_capacity(num);
    let mut pos = 48usize;
    for _ in 0..num {
        let flags = *bytes.get(pos).ok_or_else(|| AppError::param("WOFF2 目录被截断"))?;
        pos += 1;
        let index = (flags & 0x3F) as usize;
        let version = flags >> 6;
        let tag: [u8; 4] = if index == 63 {
            let t = tag_at(bytes, pos).ok_or_else(|| AppError::param("WOFF2 目录被截断"))?;
            pos += 4;
            t
        } else {
            *WOFF2_TAGS
                .get(index)
                .copied()
                .ok_or_else(|| AppError::param("WOFF2 表标签编号越界"))?
        };
        let orig = read_base128(bytes, &mut pos)?;
        let is_glyph_table = &tag == b"glyf" || &tag == b"loca";
        // glyf/loca：transformVersion 3 才是"没变换"；其余表：只有 0 是"没变换"
        let transformed = if is_glyph_table { version != 3 } else { version != 0 };
        let stored = if transformed { read_base128(bytes, &mut pos)? } else { orig };
        entries.push(Entry { tag, stored, keep: !transformed });
    }
    let compressed = take(bytes, pos, total_comp).ok_or_else(|| AppError::param("WOFF2 压缩数据越界"))?;
    let mut plain = Vec::new();
    brotli::Decompressor::new(compressed, 8192)
        .read_to_end(&mut plain)
        .map_err(|e| AppError::param(format!("WOFF2 解压失败: {e}")))?;
    let mut cursor = 0usize;
    let mut tables: HashMap<[u8; 4], Cow<'static, [u8]>> = HashMap::with_capacity(num);
    for e in entries {
        let end = cursor.checked_add(e.stored).ok_or_else(|| AppError::param("WOFF2 表长度溢出"))?;
        if end > plain.len() {
            return Err(AppError::param("WOFF2 表数据越界"));
        }
        if e.keep {
            tables.insert(e.tag, Cow::Owned(plain[cursor..end].to_vec()));
        }
        cursor = end;
    }
    Ok(FaceTables { tables, faces: 1, face_index: 0, format: "woff2".into() })
}

/* ============================ name 表 ============================ */

#[derive(Default)]
struct NameInfo {
    family: String,
    subfamily: String,
    postscript: Option<String>,
}

fn decode_utf16be(raw: &[u8]) -> String {
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// 一条 name 记录的"可信度"：Windows 英文 > Windows 其它语言 > Unicode 平台 > Mac 平台。
/// Mac 平台的字符串是 MacRoman，这里只按 Latin-1 近似解码（字体家族名基本都是 ASCII，
/// 会有偏差的只有极少数老字体，误差可以接受）。
fn name_score(platform: u16, encoding: u16, language: u16) -> u32 {
    match platform {
        3 if encoding == 1 || encoding == 10 => {
            if language == 0x409 {
                100
            } else {
                80
            }
        }
        3 => 70,
        0 => 60,
        1 if encoding == 0 => 40,
        _ => 10,
    }
}

fn read_name(table: &[u8]) -> NameInfo {
    let mut out = NameInfo::default();
    let count = match be_u16(table, 2) {
        Some(c) => c as usize,
        None => return out,
    };
    let pool_off = match be_u16(table, 4) {
        Some(v) => v as usize,
        None => return out,
    };
    let pool = match table.get(pool_off..) {
        Some(p) => p,
        None => return out,
    };
    // nameID → (得分, 文本)
    let mut best: HashMap<u16, (u32, String)> = HashMap::new();
    for i in 0..count.min(4096) {
        let rec = 6 + i * 12;
        let (platform, encoding, language, name_id, len, off) = match (
            be_u16(table, rec),
            be_u16(table, rec + 2),
            be_u16(table, rec + 4),
            be_u16(table, rec + 6),
            be_u16(table, rec + 8),
            be_u16(table, rec + 10),
        ) {
            (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f)) => (a, b, c, d, e as usize, f as usize),
            _ => break,
        };
        let raw = match pool.get(off..off + len) {
            Some(r) => r,
            None => continue,
        };
        let text = match platform {
            0 | 3 => decode_utf16be(raw),
            1 => raw.iter().map(|&b| b as char).collect::<String>(),
            _ => continue,
        };
        let text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        let score = name_score(platform, encoding, language);
        match best.get(&name_id) {
            Some((s, _)) if *s >= score => {}
            _ => {
                best.insert(name_id, (score, text));
            }
        }
    }
    // 16/17 是"排版家族名"，优先于 1/2（多语言家族的推荐做法）
    let pick = |ids: &[u16]| -> Option<String> {
        ids.iter().find_map(|id| best.get(id).map(|(_, t)| t.clone()))
    };
    out.family = pick(&[16, 1, 21, 4]).unwrap_or_default();
    out.subfamily = pick(&[17, 2, 22]).unwrap_or_default();
    out.postscript = pick(&[6]);
    out
}

/* ============================ OS/2 + head + fvar ============================ */

struct StyleInfo {
    weight: u16,
    width: u16,
    italic: bool,
    embedding: u16,
}

fn read_style(tables: &HashMap<[u8; 4], Cow<'_, [u8]>>) -> StyleInfo {
    let mut info = StyleInfo { weight: 400, width: 5, italic: false, embedding: 0 };
    if let Some(os2) = tables.get(b"OS/2".as_slice()) {
        if let Some(w) = be_u16(os2, 4) {
            if w >= 1 && w <= 1000 {
                info.weight = w;
            }
        }
        if let Some(w) = be_u16(os2, 6) {
            if w >= 1 && w <= 9 {
                info.width = w;
            }
        }
        info.embedding = be_u16(os2, 8).unwrap_or(0);
        if let Some(sel) = be_u16(os2, 62) {
            info.italic = sel & 0x01 != 0;
        }
    }
    // OS/2 缺失（老的 TrueType）时退回 head.macStyle
    if let Some(head) = tables.get(b"head".as_slice()) {
        if let Some(mac) = be_u16(head, 44) {
            if mac & 0x02 != 0 {
                info.italic = true;
            }
            if mac & 0x01 != 0 && info.weight == 400 {
                info.weight = 700;
            }
        }
    }
    info
}

fn read_axes(tables: &HashMap<[u8; 4], Cow<'_, [u8]>>) -> Vec<VariableAxis> {
    let table = match tables.get(b"fvar".as_slice()) {
        Some(t) => t,
        None => return Vec::new(),
    };
    let offset = match be_u16(table, 4) {
        Some(v) => v as usize,
        None => return Vec::new(),
    };
    let count = match be_u16(table, 8) {
        Some(v) => v as usize,
        None => return Vec::new(),
    };
    let size = be_u16(table, 10).unwrap_or(20) as usize;
    if count == 0 || count > 64 || size < 20 {
        return Vec::new();
    }
    let fixed = |o: usize| -> f32 {
        be_u32(table, o).map(|v| v as i32 as f32 / 65536.0).unwrap_or(0.0)
    };
    let mut axes = Vec::with_capacity(count);
    for i in 0..count {
        let base = offset + i * size;
        let tag = match tag_at(table, base) {
            Some(t) => t,
            None => break,
        };
        axes.push(VariableAxis {
            tag: String::from_utf8_lossy(&tag).trim().to_string(),
            min: fixed(base + 4),
            default: fixed(base + 8),
            max: fixed(base + 12),
        });
    }
    axes
}

/* ============================ cmap 表 ============================ */

/// cmap 子表挑选：优先 (3,10) 全码位 > (3,1) BMP > Unicode 平台 > (3,0) 符号 > (1,0)。
fn cmap_score(platform: u16, encoding: u16) -> u32 {
    match (platform, encoding) {
        (3, 10) => 100,
        (3, 1) => 90,
        (0, 6) | (0, 4) => 80,
        (0, 3) => 75,
        (3, 0) => 60,
        (1, 0) => 40,
        (0, _) => 50,
        _ => 0,
    }
}

fn read_cmap(table: &[u8]) -> BTreeSet<u32> {
    let mut set = BTreeSet::new();
    let count = match be_u16(table, 2) {
        Some(c) => c as usize,
        None => return set,
    };
    // 同一张 cmap 里可能有多个子表；按得分从高到低尝试，抢到内容最多的那个就用它
    let mut candidates: Vec<(u32, usize)> = Vec::new();
    for i in 0..count.min(64) {
        let rec = 4 + i * 8;
        let (platform, encoding, offset) = match (
            be_u16(table, rec),
            be_u16(table, rec + 2),
            be_u32(table, rec + 4),
        ) {
            (Some(a), Some(b), Some(c)) => (a, b, c as usize),
            _ => break,
        };
        let score = cmap_score(platform, encoding);
        if score > 0 {
            candidates.push((score, offset));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, offset) in candidates {
        let sub = match table.get(offset..) {
            Some(s) => s,
            None => continue,
        };
        let format = be_u16(sub, 0).unwrap_or(0xFFFF);
        let got = match format {
            0 => read_cmap0(sub),
            4 => read_cmap4(sub),
            6 => read_cmap6(sub),
            12 => read_cmap12(sub),
            _ => BTreeSet::new(),
        };
        if got.len() > set.len() {
            set = got;
        }
        if !set.is_empty() && format == 12 {
            break;
        }
    }
    set
}

fn read_cmap0(sub: &[u8]) -> BTreeSet<u32> {
    let mut set = BTreeSet::new();
    for cp in 0u32..256 {
        let g = sub.get(6 + cp as usize).copied().unwrap_or(0);
        if g != 0 {
            set.insert(cp);
        }
    }
    set
}

fn read_cmap6(sub: &[u8]) -> BTreeSet<u32> {
    let mut set = BTreeSet::new();
    let first = be_u16(sub, 6).unwrap_or(0) as u32;
    let count = be_u16(sub, 8).unwrap_or(0) as usize;
    for i in 0..count.min(65536) {
        let g = be_u16(sub, 10 + i * 2).unwrap_or(0);
        if g != 0 {
            set.insert(first + i as u32);
        }
    }
    set
}

fn read_cmap4(sub: &[u8]) -> BTreeSet<u32> {
    let mut set = BTreeSet::new();
    let seg_x2 = be_u16(sub, 6).unwrap_or(0) as usize;
    let seg = seg_x2 / 2;
    if seg == 0 || seg > 8000 {
        return set;
    }
    let end_base = 14;
    let start_base = end_base + seg_x2 + 2;
    let delta_base = start_base + seg_x2;
    let range_base = delta_base + seg_x2;
    for i in 0..seg {
        let end = be_u16(sub, end_base + i * 2).unwrap_or(0xFFFF) as u32;
        let start = be_u16(sub, start_base + i * 2).unwrap_or(0xFFFF) as u32;
        let delta = be_i16(sub, delta_base + i * 2).unwrap_or(0);
        let ro = be_u16(sub, range_base + i * 2).unwrap_or(0) as usize;
        if start > end || end > 0xFFFF {
            continue;
        }
        for cp in start..=end {
            let glyph = if ro == 0 {
                (cp as i32 + delta as i32) as u16
            } else {
                let addr = range_base + i * 2 + ro + (cp - start) as usize * 2;
                match be_u16(sub, addr) {
                    Some(g) if g != 0 => (g as i32 + delta as i32) as u16,
                    _ => 0,
                }
            };
            if glyph != 0 {
                set.insert(cp);
            }
        }
    }
    set
}

fn read_cmap12(sub: &[u8]) -> BTreeSet<u32> {
    let mut set = BTreeSet::new();
    let groups = be_u32(sub, 12).unwrap_or(0) as usize;
    if groups > 200_000 {
        return set;
    }
    for i in 0..groups {
        let rec = 16 + i * 12;
        let (start, end, glyph) = match (
            be_u32(sub, rec),
            be_u32(sub, rec + 4),
            be_u32(sub, rec + 8),
        ) {
            (Some(a), Some(b), Some(c)) => (a, b, c),
            _ => break,
        };
        if start > end || end > 0x10FFFF {
            continue;
        }
        for cp in start..=end {
            if glyph != 0 || cp == start {
                // startGlyphID 为 0 表示整个组没字形
                if glyph == 0 {
                    break;
                }
                set.insert(cp);
            } else {
                set.insert(cp);
            }
        }
    }
    set
}

/* ============================ 覆盖统计 ============================ */

/// 覆盖统计的参考集合 —— 固定不变，保证同一字体每次算出来的数字都一样。
const LATIN_REF: &[u32] = &[0x21, 0x7E];
const HAN_COMMON_REF: (u32, u32) = (0x4E00, 0x9FFF);
const HAN_EXT_REF: &[(u32, u32)] = &[(0x3400, 0x4DBF), (0x20000, 0x2A6DF)];
const KANA_REF: &[(u32, u32)] = &[(0x3041, 0x3096), (0x30A1, 0x30FA)];
const HANGUL_REF: (u32, u32) = (0xAC00, 0xD7A3);
/// 常用符号：箭头、音符、序号、数学、标点、货币、勾叉、几何
const SYMBOL_REF: &[char] = &[
    '♪', '♫', '♩', '♬', '♭', '♯', '→', '←', '↑', '↓', '↔', '⇄', '★', '☆', '♥', '♦', '♣', '♠',
    '①', '②', '③', '④', '⑤', '—', '–', '…', '·', '「', '」', '『', '』', '【', '】', '《', '》',
    '€', '£', '¥', '©', '®', '™', '°', '±', '×', '÷', '≈', '≠', '≤', '≥', '∞', '√', '∑', '∏',
    '✓', '✔', '✕', '✖', '▲', '▼', '◆', '●', '○', '■', '□', '∴', '∵', '§', '¶', '†', '‡', '•',
];
/// 常用 Emoji（只要有一个就算"含 Emoji"）
const EMOJI_REF: &[char] = &[
    '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '😭', '😡', '👍', '👎', '👏', '🙏', '💔', '❤',
    '💖', '🔥', '⭐', '✨', '🎉', '🎧', '🎤', '🎵', '🎶',
];

fn count_in(set: &BTreeSet<u32>, ranges: &[(u32, u32)]) -> u32 {
    let mut n = 0u32;
    for &(a, b) in ranges {
        if b < a {
            continue;
        }
        // 用区间迭代而不是逐个码位查 BTreeSet：扩展区四万多个码位，逐个查太慢
        let mut cp = a;
        while cp <= b {
            if set.contains(&cp) {
                n += 1;
            }
            cp += 1;
        }
    }
    n
}

fn pct(covered: u32, total: u32) -> f32 {
    if total == 0 {
        return 0.0;
    }
    let v = covered as f32 * 100.0 / total as f32;
    (v * 10.0).round() / 10.0
}

pub fn coverage_of(set: &BTreeSet<u32>) -> Coverage {
    if set.is_empty() {
        return Coverage::default();
    }
    let latin_total = (LATIN_REF[1] - LATIN_REF[0] + 1)
        + (0xFF - 0xC0 + 1 - 2); // Latin-1 字母，去掉 × ÷
    let han_common_total = HAN_COMMON_REF.1 - HAN_COMMON_REF.0 + 1;
    let han_ext_total: u32 = HAN_EXT_REF.iter().map(|(a, b)| b - a + 1).sum();
    let kana_total: u32 = KANA_REF.iter().map(|(a, b)| b - a + 1).sum();
    let hangul_total = HANGUL_REF.1 - HANGUL_REF.0 + 1;
    Coverage {
        latin: pct(
            count_in(set, &[(LATIN_REF[0], LATIN_REF[1]), (0xC0, 0xFF)]),
            latin_total,
        ),
        han_common: pct(count_in(set, &[HAN_COMMON_REF]), han_common_total),
        han_ext: pct(count_in(set, HAN_EXT_REF), han_ext_total),
        kana: pct(count_in(set, KANA_REF), kana_total),
        hangul: pct(count_in(set, &[HANGUL_REF]), hangul_total),
        symbols: pct(
            SYMBOL_REF.iter().filter(|c| set.contains(&(**c as u32))).count() as u32,
            SYMBOL_REF.len() as u32,
        ),
        emoji: pct(
            EMOJI_REF.iter().filter(|c| set.contains(&(**c as u32))).count() as u32,
            EMOJI_REF.len() as u32,
        ),
    }
}

/// 有实际覆盖的脚本。阈值有意偏保守：覆盖 30% 假名的字体不足以"接管日文行"，
/// 但足以让用户在卡片上看到"这个字体有假名"。
pub fn scripts_of(cov: &Coverage) -> Vec<String> {
    let mut out = Vec::new();
    if cov.latin >= 60.0 {
        out.push("latin".to_string());
    }
    if cov.han_common >= 20.0 || cov.han_ext >= 5.0 {
        out.push("han".to_string());
    }
    if cov.kana >= 50.0 {
        out.push("kana".to_string());
    }
    if cov.hangul >= 30.0 {
        out.push("hangul".to_string());
    }
    if cov.symbols >= 50.0 {
        out.push("symbols".to_string());
    }
    if cov.emoji >= 4.0 {
        out.push("emoji".to_string());
    }
    out
}

/// 码位集合 → 连续区间。前端逐字判断"主字体有没有这个字"就查这张表。
pub fn ranges_of(set: &BTreeSet<u32>) -> Vec<[u32; 2]> {
    let mut out: Vec<[u32; 2]> = Vec::new();
    for &cp in set {
        match out.last_mut() {
            Some(last) if last[1] + 1 == cp => last[1] = cp,
            _ => out.push([cp, cp]),
        }
    }
    out
}

/* ============================ 对外：解析整个文件 ============================ */

pub fn parse(bytes: &[u8], face_index: u32) -> AppResult<ParsedFont> {
    let face = read_face(bytes, face_index)?;
    let name = face
        .tables
        .get(b"name".as_slice())
        .map(|t| read_name(t))
        .unwrap_or_default();
    let style = read_style(&face.tables);
    let axes = read_axes(&face.tables);
    let codepoints = face
        .tables
        .get(b"cmap".as_slice())
        .map(|t| read_cmap(t))
        .unwrap_or_default();
    Ok(ParsedFont {
        family: name.family,
        subfamily: name.subfamily,
        postscript: name.postscript,
        weight: style.weight,
        width: style.width,
        italic: style.italic,
        embedding: style.embedding,
        axes,
        format: face.format,
        faces: face.faces,
        face_index: face.face_index,
        codepoints,
    })
}

/* ============================ 内容哈希 ============================ */

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(rel: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("读不到样张字体 {path:?}: {e}"))
    }

    #[test]
    fn parses_latin_font() {
        let bytes = sample("../字体/Ephesis/Ephesis-Regular.ttf");
        let f = parse(&bytes, 0).expect("Ephesis 应当能解析");
        assert_eq!(f.family, "Ephesis");
        let cov = coverage_of(&f.codepoints);
        assert!(cov.latin > 80.0, "拉丁字体应覆盖大部分拉丁参考集: {cov:?}");
        assert!(cov.han_common < 5.0, "拉丁字体不该有汉字: {cov:?}");
        assert!(scripts_of(&cov).contains(&"latin".to_string()));
    }

    #[test]
    fn parses_cjk_font() {
        let bytes = sample("../字体/Ma_Shan_Zheng/MaShanZheng-Regular.ttf");
        let f = parse(&bytes, 0).expect("马善政毛笔体应当能解析");
        assert_eq!(f.family, "Ma Shan Zheng");
        let cov = coverage_of(&f.codepoints);
        // 覆盖值是百分比（命中数 / 参考集大小）：马善政约 6700 字 / 基本区 20992 字 ≈ 32%
        assert!(cov.han_common > 25.0, "CJK 字体应覆盖相当一部分基本区汉字: {cov:?}");
        assert!(cov.latin > 55.0, "书写体通常也带拉丁字母: {cov:?}");
        assert!(cov.kana < 1.0, "马善政不含假名: {cov:?}");
        let scripts = scripts_of(&cov);
        assert!(scripts.contains(&"han".to_string()), "{scripts:?}");
        assert!(!scripts.contains(&"kana".to_string()), "{scripts:?}");
        let ranges = ranges_of(&f.codepoints);
        assert!(!ranges.is_empty());
        // 区间必须严格递增、不重叠，前端二分查找依赖这一点
        for w in ranges.windows(2) {
            assert!(w[0][1] < w[1][0]);
        }
    }

    #[test]
    fn rejects_garbage() {
        let junk = vec![7u8; 4096];
        assert!(parse(&junk, 0).is_err());
    }
}
