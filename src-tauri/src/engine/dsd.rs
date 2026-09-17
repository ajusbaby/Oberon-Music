//! DSD（DSF / DFF）解码：1-bit 流 → PCM。
//!
//! ## 为什么是"软解成 PCM"这一档
//! DSD 有三条技术路径：
//!   A. **DSD → PCM 软解**（本模块）：任何 DAC 都能放，不需要独占模式。
//!   B. DoP（DSD over PCM）：把 DSD 伪装成 176.4k/24bit 的 PCM 帧交给 DAC 还原 ——
//!      必须 WASAPI **独占 + bit-perfect**；共享模式会被系统混音器当普通 PCM 重采样，直接毁掉。
//!   C. 原生 DSD 直出：同样要独占模式（还依赖 DAC 驱动支持）。
//! 所以先做 A；B/C 等独占输出那个里程碑。
//!
//! ## 滤波为什么不能"随便平均一下"
//! DSD 是 1-bit 超高采样率（DSD64 = 2.8224 MHz）流，并带**很强的噪声整形**：
//! 量化噪声被推到超声频段，能量远高于可听频段。抽取之前若不把它压下去，这些噪声会
//! **折叠（alias）进可听频段变成嘶声**。所以这里用正经的 **Blackman 窗 sinc 低通**：
//!
//! - 抽取比取「让输出落到 88.2k / 96k」的整数（DSD64 → ÷32 → 88.2 kHz，DSD128 → ÷64 …），
//!   于是混叠源最近在 out_rate − 20k = 68.2 kHz，而音频带上界 20 kHz ——
//!   过渡带有 48 kHz 宽，256 抽头 Blackman 足够给出 >70 dB 抑制。
//! - 直接式 FIR（每输出点 256 次乘加）。每声道每秒 88200×256 ≈ 22.6M 次乘加，可忽略。

use crate::error::{AppError, E_DECODE};
use dsd_reader::DsdReader;
// id3 的 title()/artist()/... 来自 TagLike trait，不是 Tag 的固有方法
use id3::TagLike;
use rodio::source::{SeekError, Source};
use rodio::{ChannelCount, SampleRate};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::num::NonZero;
use std::path::PathBuf;
use std::time::Duration;

/// dsd-reader 的 `dsd_rate()` 返回的是**倍率**（DSD64=1、DSD128=2…），
/// 不是 Hz —— 真实采样率要乘 DSD_64_RATE。
const DSD64_HZ: u32 = 2_822_400;

/// 自己先验一遍容器头。
/// ⚠️ 必须自己把关：dsd-reader 在容器解析失败时会**静默退化成「按裸 DSD 处理」**
///    （dsd_file.rs 里 open_dsf/open_dff 失败就调 open_raw），于是随便一个文件
///    都能被「成功打开」（倍率 0、声道默认 2），播放时出来的是一堆噪声。
fn is_dsd_container(path: &str) -> bool {
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    let mut h = [0u8; 92];
    let Ok(n) = f.read(&mut h) else {
        return false;
    };
    // DSF："DSD " 开头，28 字节处是 "fmt " 头，完整头 92 字节
    if n >= 92 && &h[0..4] == b"DSD " && &h[28..32] == b"fmt " {
        return true;
    }
    // DFF(DSDIFF)："FRM8" 开头，12 字节处是 form type "DSD "
    if n >= 16 && &h[0..4] == b"FRM8" && &h[12..16] == b"DSD " {
        return true;
    }
    false
}

/// DSF 的音频数据起始偏移（相对文件头）；DFF（或结构不认识）返回 None。
///
/// 走一遍 chunk 链，不假设固定 92 字节（标准文件的结果就是 92）。
/// 有了它 DSF 才能用 `File::seek` 直接定位到第 k 块。
fn dsf_data_offset(path: &str) -> Option<u64> {
    let mut f = File::open(path).ok()?;
    let mut h = [0u8; 92];
    let n = f.read(&mut h).ok()? as u64;
    if n < 92 || &h[0..4] != b"DSD " || &h[28..32] != b"fmt " {
        return None;
    }
    let mut pos: u64 = 28;
    loop {
        if pos + 12 > n {
            return None;
        }
        let at = pos as usize;
        let id = &h[at..at + 4];
        let size = u64::from_le_bytes(h[at + 4..at + 12].try_into().ok()?);
        if id == b"data" {
            return Some(pos + 12);
        }
        if size < 12 {
            return None;
        }
        pos += size;
    }
}

/// 低通抽头数
const TAPS: usize = 256;

/// 1-bit 查表的分组宽度：8 个输入样本 = 1 个原始字节
const CHUNK_BITS: usize = 8;
/// 一次 FIR 窗口要查多少个 chunk（= TAPS / 8）
const NCHUNK: usize = TAPS / CHUNK_BITS;

/// 1-bit 查表：把「8 个 ±1 输入样本 × 对应抽头」的内积预先算成 256 项的表。
///
/// 窗口约定（LUT 与标量两条路径完全一致）：输出点 g 用的是样本 [g-TAPS, g-1]，
/// chunk c 覆盖样本 g-TAPS+8c .. g-TAPS+8c+7，其中第 t 个样本对应的抽头是
/// taps[TAPS-1-(8c+t)]（因为 j = g-1-m，m = g-TAPS+8c+t）。
///
/// ⚠️ 这个「窗口比标量老一版」的约定不是随意选的：TAPS 是 8 的倍数、且 decim 也是 8 的
/// 倍数时，窗口正好落在**字节边界**上，于是一个 chunk 就是一个原始字节，查表不需要做位拼接
/// （见 DsdSource::fill_lut 的注释）。代价是输出整体晚一个输入样本（0.354 µs @ DSD64），
/// 听不出来。
fn build_tables(taps: &[f32]) -> Vec<[f32; 256]> {
    let nchunk = taps.len() / CHUNK_BITS;
    let mut tables = vec![[0.0f32; 256]; nchunk];
    for (c, table) in tables.iter_mut().enumerate() {
        for (b, slot) in table.iter_mut().enumerate() {
            let mut acc = 0.0f32;
            for t in 0..CHUNK_BITS {
                let s = if (b >> t) & 1 == 1 { 1.0f32 } else { -1.0f32 };
                acc += taps[taps.len() - 1 - (c * CHUNK_BITS + t)] * s;
            }
            *slot = acc;
        }
    }
    tables
}
/// 目标输出采样率（优先 88.2k，其次 96k）
const TARGET_RATES: [u32; 2] = [88_200, 96_000];

/// rodio 0.22 的 SeekError::NotSupported 是带字段的变体
fn seek_unsupported() -> SeekError {
    SeekError::NotSupported {
        underlying_source: "dsd",
    }
}


/// 读 .dsf/.dff 的**内嵌歌词**。
///
/// ⚠️ 为什么必须单独开这个口子：歌词链路的「内嵌标签」分支用的是 lofty 的
/// `Probe::open()`（见 src/lyrics.rs），而 **lofty 完全不支持 .dsf/.dff** —— 对 DSD 直接失败，
/// 于是「刷进标签里的歌词」永远读不出来（用户报的正是这个）。
/// 这里用 id3 读 USLT（未同步歌词）帧，也就是绝大多数刷歌词工具写进去的那个帧。
pub fn embedded_lyrics(path: &str) -> Option<String> {
    if !is_dsd_container(path) {
        return None;
    }
    let Ok(reader) = DsdReader::from_container(PathBuf::from(path)) else {
        return None;
    };
    let Some(tag) = reader.tag().as_ref() else {
        eprintln!("[lyrics] {}：DSD 文件里没有内嵌 ID3 标签", path);
        return None;
    };
    for l in tag.lyrics() {
        let t = l.text.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    let ids: Vec<String> = tag.frames().map(|x| x.id().to_string()).collect();
    eprintln!("[lyrics] {}：DSD 标签里没有 USLT 歌词帧；现有帧 = {:?}", path, ids);
    None
}

/// DSF / DFF 的元数据（lofty 不支持 DSD，扫描层只能从这里拿）
pub struct DsdMeta {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub year: Option<i64>,
    pub track_no: Option<i64>,
    pub duration_ms: i64,
    pub sample_rate: i64,
    pub channels: i64,
    /// 内嵌封面（字节 + 扩展名）
    pub picture: Option<(Vec<u8>, &'static str)>,
}

/// Blackman 窗 sinc 低通，截止在输出奈奎斯特的 0.9 倍
fn design_lowpass(cutoff_norm: f32) -> Vec<f32> {
    let mut h = vec![0.0f32; TAPS];
    let mid = (TAPS - 1) as f32 / 2.0;
    let mut sum = 0.0f32;
    for (n, tap) in h.iter_mut().enumerate() {
        let x = n as f32 - mid;
        // sinc
        let s = if x.abs() < 1e-6 {
            2.0 * cutoff_norm
        } else {
            (2.0 * std::f32::consts::PI * cutoff_norm * x).sin() / (std::f32::consts::PI * x)
        };
        // Blackman 窗
        let w = 0.42 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / (TAPS - 1) as f32).cos()
            + 0.08 * (4.0 * std::f32::consts::PI * n as f32 / (TAPS - 1) as f32).cos();
        *tap = s * w;
        sum += *tap;
    }
    // 归一化到直流增益 1，避免整体音量偏差
    if sum.abs() > 1e-9 {
        for tap in h.iter_mut() {
            *tap /= sum;
        }
    }
    h
}

/// 选抽取比：优先让输出正好落在 88.2k / 96k（DSD 的 44.1k/48k 两个家族都能整除）
fn pick_decimation(rate: u32) -> u32 {
    for target in TARGET_RATES {
        if target > 0 && rate > target && rate % target == 0 {
            return rate / target;
        }
    }
    // 兜底：取 2 的幂，保证输出仍 >= 60 kHz
    let mut d = 2u32;
    while d * 2 <= 512 && rate / (d * 2) >= 60_000 {
        d *= 2;
    }
    d
}

/// 由容器字节长度推时长。DSF 的 data chunk 长度是**所有声道合计**的字节数，
/// 每个字节 8 个 1-bit 采样 ⇒ 每声道采样数 = bytes*8/channels。
fn duration_of(bytes: u64, rate: u32, channels: u32) -> Duration {
    let per_channel = bytes.saturating_mul(8) / channels.max(1) as u64;
    Duration::from_secs_f64(per_channel as f64 / rate.max(1) as f64)
}

/// 字节帧来源。两种实现产出的字节帧**逐字节一致**（有单测守着），
/// 区别只在「能不能 O(1) 定位」。
enum BlockSource {
    /// dsd-reader 的迭代器：DFF 走这条（没有块结构，定位只能顺序跳过）
    Iter(dsd_reader::DsdIter),
    /// DSF 直读：有固定块结构 ⇒ `File::seek` 就能定位，跳转是 O(1)
    Dsf(DsfBlocks),
}

impl BlockSource {
    fn next_frame(&mut self) -> Option<(usize, Vec<Box<[u8]>>)> {
        match self {
            BlockSource::Iter(i) => i.next(),
            BlockSource::Dsf(d) => d.next_frame(),
        }
    }
}

/// DSF 的字节帧读取器 —— 相对 `DsdIter` 只多一件事：**支持 O(1) 定位**。
///
/// 为什么需要：`DsdIter` 没有定位接口，只能从 0 顺序读到目标块。用户那个
/// 195MB / 276s 的 .dsf 跳到 85% 要顺序过 166MB，实测 1.2 秒。虽然已经改到引擎线程上
/// 执行（不再阻塞音频线程 ⇒ 不再有电音），但那 1.2 秒是**静音空档**，体验仍然是坏的。
/// DSF 是分块的结构化容器（每声道固定 block_size 字节、按块交错），可以直接 seek 到第 k 块。
///
/// 输出的字节帧与 `DsdIter` 逐字节一致：每声道一块、LSB-first 原字节，
/// 所以 `fill()` 的 FIR 逻辑完全不用改。
struct DsfBlocks {
    file: BufReader<File>,
    data_offset: u64,
    block_size: usize,
    channels: usize,
    /// 音频数据总字节数（所有声道合计）—— 与 DsdIter 的 bytes_remaining 同源
    audio_length: u64,
    /// 已经消费掉的**有效**音频字节数
    consumed: u64,
}

impl DsfBlocks {
    fn open(
        path: &str,
        data_offset: u64,
        block_size: usize,
        channels: usize,
        audio_length: u64,
    ) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let cap = (block_size * channels * 8).max(64 * 1024);
        let mut file = BufReader::with_capacity(cap, file);
        file.seek(SeekFrom::Start(data_offset))?;
        Ok(Self {
            file,
            data_offset,
            block_size: block_size.max(1),
            channels: channels.max(1),
            audio_length,
            consumed: 0,
        })
    }

    fn frame_size(&self) -> usize {
        self.block_size * self.channels
    }

    /// O(1) 定位到第 index 帧（每帧 = 每个声道各一块）
    fn seek_to_frame(&mut self, index: u64) -> std::io::Result<()> {
        let off = index.saturating_mul(self.frame_size() as u64).min(self.audio_length);
        self.file.seek(SeekFrom::Start(self.data_offset + off))?;
        self.consumed = off;
        Ok(())
    }

    /// 读下一帧；语义与 `DsdIter::next` 完全一致：
    /// 文件尾仍然是**补齐过的整帧**，但按 audio_length 算出来的有效字节可能更少。
    fn next_frame(&mut self) -> Option<(usize, Vec<Box<[u8]>>)> {
        let remaining = self.audio_length.saturating_sub(self.consumed);
        if remaining == 0 {
            return None;
        }
        let frame = self.frame_size();
        let valid_per_ch = if remaining >= frame as u64 {
            self.block_size
        } else {
            (remaining / self.channels as u64) as usize
        };
        if valid_per_ch == 0 {
            return None;
        }
        // 与 DsdIter 一样按整帧读（尾帧在盘上是补齐的）；读不满就当作结束
        let mut buf = vec![0u8; frame];
        if self.file.read_exact(&mut buf).is_err() {
            return None;
        }
        let mut out: Vec<Box<[u8]>> = Vec::with_capacity(self.channels);
        for ch in 0..self.channels {
            let s = ch * self.block_size;
            out.push(buf[s..s + valid_per_ch].to_vec().into_boxed_slice());
        }
        self.consumed += (valid_per_ch * self.channels) as u64;
        Some((valid_per_ch * self.channels, out))
    }
}

pub struct DsdSource {
    blocks: BlockSource,
    /// 重新打开容器要用（DFF 定位只能重开 + 顺序跳过）
    path: String,
    /// 原始 DSD 采样率（Hz）
    dsd_rate_hz: u32,
    /// 容器块大小（字节/声道）：seek 必须按整块对齐，否则 DSF 的声道交错会错位
    block_size: u32,
    channels: u16,
    sample_rate: u32,
    decim: usize,
    taps: Vec<f32>,
    /// 是否走 1-bit 查表路径。要求 decim 是 8 的倍数（输出点落在字节边界上）；
    /// 不满足时退回标量路径（真实 DSD 文件的 decim 一定是 32/64/128/256，恒满足）。
    use_lut: bool,
    /// 1-bit 查表：tables[chunk][byte]，见 build_tables()
    tables: Vec<[f32; 256]>,
    /// 每声道：上一帧留下的尾部**原始字节**（LUT 窗口需要 NCHUNK 字节的历史）
    carry_bytes: Vec<Vec<u8>>,
    /// 每声道已消费的**原始字节**数（全局字节下标基准；输出点 q 满足 q % (decim/8) == 0）
    bytes_in: u64,
    /// 每声道的工作缓冲：carry_bytes ++ 本帧字节（复用容量，不在热路径分配）
    work: Vec<Vec<u8>>,
    /// 每声道：上一块留下的尾部（最多 TAPS-1 个输入样本）—— 标量路径用
    carry: Vec<Vec<f32>>,
    /// 每声道：展开后的连续输入样本（carry ++ 本块新样本）
    expanded: Vec<Vec<f32>>,
    /// 已经消费掉的输入样本数（全局下标基准）
    n_in: u64,
    /// 交错输出
    out: Vec<f32>,
    pos: usize,
    total: Option<Duration>,
    ended: bool,
}

impl DsdSource {
    pub fn open(path: &str) -> Result<Self, AppError> {
        if !is_dsd_container(path) {
            return Err(AppError::new(E_DECODE, "不是 DSF/DFF 容器（或文件头不完整）"));
        }
        let reader = DsdReader::from_container(PathBuf::from(path))
            .map_err(|e| AppError::new(E_DECODE, format!("不是有效的 DSD(DSF/DFF) 文件: {e}")))?;
        let channels = reader.channels_num();
        // dsd_rate() 是倍率，换算成 Hz
        let rate_hz = (reader.dsd_rate().max(0) as u32).saturating_mul(DSD64_HZ);
        if channels == 0 || rate_hz == 0 {
            return Err(AppError::new(E_DECODE, "DSD 文件缺少声道/采样率信息"));
        }
        let decim = pick_decimation(rate_hz);
        let out_rate = rate_hz / decim;
        let total = Some(duration_of(reader.audio_length(), rate_hz, channels as u32));
        let block_size = reader.block_size();
        // DSF 有块结构 ⇒ 用可 O(1) 定位的自读器；DFF（以及任何解析不出 data 偏移的）
        // 继续用 dsd-reader 的迭代器。两者产出的字节帧逐字节一致。
        let blocks = match dsf_data_offset(path).and_then(|off| {
            DsfBlocks::open(path, off, block_size as usize, channels, reader.audio_length()).ok()
        }) {
            Some(d) => BlockSource::Dsf(d),
            None => BlockSource::Iter(
                reader
                    .dsd_iter()
                    .map_err(|e| AppError::new(E_DECODE, format!("无法读取 DSD 数据: {e}")))?,
            ),
        };
        let cutoff = 0.9 * 0.5; // 相对输出采样率的归一化截止（0.45 → 输出奈奎斯特的 90%）
        let taps = design_lowpass(cutoff / decim as f32);
        // 1-bit 查表路径的条件：输出点必须落在字节边界上（decim 是 8 的倍数）。
        // 真实 DSD 的 rate = 2822400×{1,2,4,8}，88200 一定能整除 ⇒ decim ∈ {32,64,128,256}，恒满足。
        // OBERON_DSD_SCALAR 是给 A/B 基准用的逃生口（生产不设置）。
        let use_lut = decim % 8 == 0
            && TAPS % CHUNK_BITS == 0
            && NCHUNK % 4 == 0 // fill_lut 的 4 路累加要求
            && std::env::var_os("OBERON_DSD_SCALAR").is_none();
        let tables = if use_lut { build_tables(&taps) } else { Vec::new() };
        Ok(Self {
            blocks,
            path: path.to_string(),
            dsd_rate_hz: rate_hz,
            block_size,
            channels: channels as u16,
            sample_rate: out_rate,
            decim: decim as usize,
            taps,
            use_lut,
            tables,
            // 起始就填满 NCHUNK 个 0：work 恒等于「NCHUNK 字节前缀 ++ 本帧」，
            // 于是 work 下标与全局字节的换算始终是 i ↔ bytes_in - NCHUNK + i。
            // 这 NCHUNK 个 0 只可能被 q < NCHUNK 的输出看到，而那种输出本来就被跳过。
            carry_bytes: vec![vec![0u8; NCHUNK]; channels],
            bytes_in: 0,
            work: vec![Vec::new(); channels],
            carry: vec![Vec::new(); channels],
            expanded: vec![Vec::new(); channels],
            n_in: 0,
            out: Vec::new(),
            pos: 0,
            total,
            ended: false,
        })
    }

    /// 取并处理下一块；返回 false = 结束
    fn fill(&mut self) -> bool {
        if self.use_lut {
            self.fill_lut()
        } else {
            self.fill_scalar()
        }
    }

    /// 1-bit 查表路径（真实 DSD 文件走这条）。
    ///
    /// 窗口 [g-TAPS, g-1] 在 decim 是 8 的倍数时正好落在**字节边界**上，于是一个 chunk
    /// 就是一个原始字节，查表不需要任何位拼接：
    ///   输出 g 对应字节下标 q = g/8，窗口 = 字节 [q-NCHUNK, q-1]，
    ///   y[g] = Σ_{c=0}^{NCHUNK-1} tables[c][ byte(q-NCHUNK+c) ]。
    /// 输出每隔 decim 个样本一次 ⇒ 每隔 d = decim/8 个字节一次。
    fn fill_lut(&mut self) -> bool {
        let ch_n = self.channels as usize;
        let nchunk = self.tables.len();
        let d = (self.decim / CHUNK_BITS) as u64;
        loop {
            let Some((read_size, blocks)) = self.blocks.next_frame() else {
                self.ended = true;
                return false;
            };
            if read_size == 0 || blocks.is_empty() {
                continue;
            }
            if blocks.len() < ch_n {
                self.ended = true;
                return false;
            }
            let len = blocks[0].len();
            // work[ch] = carry_bytes[ch] ++ 本帧字节；work 下标 i 对应全局字节 bytes_in-nchunk+i
            for ch in 0..ch_n {
                let w = &mut self.work[ch];
                w.clear();
                w.extend_from_slice(&self.carry_bytes[ch]);
                w.extend_from_slice(&blocks[ch]);
            }
            let base = self.bytes_in;
            self.out.clear();

            // 本帧负责的全局字节 q ∈ [base, base+len-1]，且 q % d == 0、q >= nchunk（窗口要有历史）
            let mut q = base.max(nchunk as u64);
            if q % d != 0 {
                q += d - (q % d);
            }
            let end = base + len as u64 - 1;
            while q <= end {
                // work 中全局字节 q 的下标；窗口是 [j-nchunk, j-1]
                let j = (q - base) as usize + nchunk;
                for ch in 0..ch_n {
                    let win = &self.work[ch][j - nchunk..j];
                    // 4 路累加：单个累加器的 32 次串行加法会被延迟卡住（~4 cycle/次）
                    let mut a0 = 0.0f32;
                    let mut a1 = 0.0f32;
                    let mut a2 = 0.0f32;
                    let mut a3 = 0.0f32;
                    let mut c = 0usize;
                    while c < nchunk {
                        a0 += self.tables[c][win[c] as usize];
                        a1 += self.tables[c + 1][win[c + 1] as usize];
                        a2 += self.tables[c + 2][win[c + 2] as usize];
                        a3 += self.tables[c + 3][win[c + 3] as usize];
                        c += 4;
                    }
                    self.out.push((a0 + a1) + (a2 + a3));
                }
                q += d;
            }

            // 更新 carry_bytes（保留最后 nchunk 个字节）与已消费字节数
            for ch in 0..ch_n {
                let w = &self.work[ch];
                let keep = nchunk.min(w.len());
                let start = w.len() - keep;
                self.carry_bytes[ch].clear();
                self.carry_bytes[ch].extend_from_slice(&w[start..]);
            }
            self.bytes_in = base + len as u64;

            if !self.out.is_empty() {
                self.pos = 0;
                return true;
            }
        }
    }

    /// 标量路径（兜底 / 基准参照）：把字节展开成 ±1 的 f32 再做直接式 FIR。
    /// ⚠️ 窗口约定必须与 fill_lut 完全一致（[g-TAPS, g-1]），否则两条路径的相位会差 1 个输入样本。
    fn fill_scalar(&mut self) -> bool {
        if self.ended {
            return false;
        }
        let ch_n = self.channels as usize;
        loop {
            let Some((read_size, blocks)) = self.blocks.next_frame() else {
                self.ended = true;
                return false;
            };
            if read_size == 0 || blocks.is_empty() {
                continue;
            }
            if blocks.len() < ch_n {
                self.ended = true;
                return false;
            }
            // 展开成连续 f32：carry ++ 本块（每字节 8 个样本，DSF/DFF 都是 LSB-first）
            for ch in 0..ch_n {
                let dst = &mut self.expanded[ch];
                dst.clear();
                dst.extend_from_slice(&self.carry[ch]);
                let blk = &blocks[ch];
                dst.reserve(blk.len() * 8);
                for &b in blk.iter() {
                    for k in 0..8 {
                        dst.push(if (b >> k) & 1 == 1 { 1.0 } else { -1.0 });
                    }
                }
            }
            let n = self.expanded[0].len();
            let carry_len = self.carry[0].len();
            // expanded[0] 的第 0 个样本的全局下标
            let base = self.n_in.saturating_sub(carry_len as u64);

            self.out.clear();
            for local in 0..n {
                let global = base + local as u64;
                // 相位对齐用全局下标；窗口长度看块内下标（有 carry 时 global 很大而 local 可能还很小）。
                // 窗口是 [g-TAPS, g-1] ⇒ 需要 local-1-j >= 0（j 最大 TAPS-1）⇒ local >= TAPS
                if global % self.decim as u64 != 0 || local < TAPS {
                    continue;
                }
                for ch in 0..ch_n {
                    let src = &self.expanded[ch];
                    let mut acc = 0.0f32;
                    // 直接式 FIR：非零抽头都参与
                    for (j, &t) in self.taps.iter().enumerate() {
                        acc += src[local - 1 - j] * t;
                    }
                    self.out.push(acc);
                }
            }

            // 更新 carry（保留最后 TAPS 个样本，与 fill_lut 的 nchunk 字节历史对齐）与已消费计数
            let keep = TAPS.min(n);
            for ch in 0..ch_n {
                let src = &self.expanded[ch];
                let start = src.len() - keep;
                self.carry[ch].clear();
                self.carry[ch].extend_from_slice(&src[start..]);
            }
            self.n_in = base + n as u64;

            if !self.out.is_empty() {
                self.pos = 0;
                return true;
            }
        }
    }

    /// 定位之后把滤波状态整体重来：窗口只有 256 个输入样本（0.09ms），听不出来
    fn reset_after_seek(&mut self) {
        for c in self.carry.iter_mut() {
            c.clear();
        }
        self.n_in = 0;
        // LUT 路径的字节级历史也要一起清（否则会拿定位前的字节当窗口）。
        // 必须补回 NCHUNK 个 0（而不是清空）：fill_lut 假设 work 恒有 NCHUNK 字节前缀。
        for c in self.carry_bytes.iter_mut() {
            c.clear();
            c.resize(NCHUNK, 0);
        }
        self.bytes_in = 0;
        self.out.clear();
        self.pos = 0;
        self.ended = false;
    }
}

impl Iterator for DsdSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        while self.pos >= self.out.len() {
            if !self.fill() {
                return None;
            }
        }
        let s = self.out[self.pos];
        self.pos += 1;
        Some(s)
    }
}

impl Source for DsdSource {
    fn current_span_len(&self) -> Option<usize> {
        // ⚠️ 必须返回 Some：见 engine/opus.rs 里的说明 —— 返回 None 会让混音器的采样率
        // 转换比在换源后失效，下一首会按上一首的采样率播放（变速/变调）。
        Some((self.out.len() - self.pos).max(1))
    }
    fn channels(&self) -> ChannelCount {
        NonZero::new(self.channels).unwrap_or(NonZero::new(2).expect("2 非零"))
    }
    fn sample_rate(&self) -> SampleRate {
        NonZero::new(self.sample_rate).unwrap_or(NonZero::new(88_200).expect("88.2k 非零"))
    }
    fn total_duration(&self) -> Option<Duration> {
        self.total
    }

    /// 原地定位。
    ///
    /// ⚠️ 这个实现是**必须的**（不是为了精确）：没有它，引擎会退回「逐样本排水到目标」
    /// 那条路 —— 186MB 的 DSD 等于几十亿次乘加，表现就是**快进卡死**。
    ///
    /// ⚠️ 调用位置同样关键：它现在**只在引擎线程上被调用**（见 engine::seek_to 的 routing）。
    /// rodio 的 Player::try_seek 是在**音频线程**上执行源自己的 try_seek 的，
    /// 而这里的定位是 O(跳转距离) 的工作量，跑在音频线程上就会欠载 ⇒ 电音。
    ///
    /// 两条路径：
    /// - DSF：块结构已知 ⇒ `File::seek` 到第 k 块，**O(1)**（见 DsfBlocks）
    /// - DFF：没有块结构 ⇒ 重开容器 + 逐帧跳过（O(距离)，只在引擎线程上跑，用户听到的是静音）
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        // 目标：按声道要跳过多少字节，再向下对齐到整块
        let bits = (pos.as_secs_f64() * self.dsd_rate_hz as f64) as u64;
        let block_bytes = self.block_size.max(1) as u64;
        let target_block = (bits / 8) / block_bytes;

        if let BlockSource::Dsf(d) = &mut self.blocks {
            d.seek_to_frame(target_block).map_err(|_| seek_unsupported())?;
            self.reset_after_seek();
            return Ok(());
        }

        let reader = DsdReader::from_container(PathBuf::from(&self.path))
            .map_err(|_| seek_unsupported())?;
        let mut iter = reader.dsd_iter().map_err(|_| seek_unsupported())?;
        let mut left = target_block;
        while left > 0 {
            match iter.next() {
                Some(_) => left -= 1,
                None => break,
            }
        }
        self.blocks = BlockSource::Iter(iter);
        self.reset_after_seek();
        Ok(())
    }
}

/// 读 DSD 的元数据（容器头 + 内嵌 ID3）。给扫描层用 —— lofty 不认识 .dsf/.dff。
pub fn probe(path: &str) -> Option<DsdMeta> {
    if !is_dsd_container(path) {
        return None;
    }
    let reader = DsdReader::from_container(PathBuf::from(path)).ok()?;
    // dsd_rate() 是倍率（DSD64=1），换算成 Hz
    let rate_hz = (reader.dsd_rate().max(0) as u32).saturating_mul(DSD64_HZ);
    let channels = reader.channels_num();
    if rate_hz == 0 || channels == 0 {
        return None;
    }
    let duration_ms = duration_of(reader.audio_length(), rate_hz, channels as u32)
        .as_millis() as i64;
    let mut meta = DsdMeta {
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        genre: String::new(),
        year: None,
        track_no: None,
        duration_ms,
        sample_rate: rate_hz as i64,
        channels: channels as i64,
        picture: None,
    };
    if let Some(tag) = reader.tag() {
        if let Some(v) = tag.title() {
            meta.title = v.to_string();
        }
        if let Some(v) = tag.artist() {
            meta.artist = v.to_string();
        }
        if let Some(v) = tag.album() {
            meta.album = v.to_string();
        }
        if let Some(v) = tag.genre() {
            meta.genre = v.to_string();
        }
        meta.year = tag.year().map(|y| y as i64);
        meta.track_no = tag.track().map(|t| t as i64);
        if let Some(pic) = tag.pictures().next() {
            // Picture 的字段是 public 的（mime_type / data）
            let ext = if pic.mime_type.contains("png") {
                "png"
            } else if pic.mime_type.contains("gif") {
                "gif"
            } else if pic.mime_type.contains("webp") {
                "webp"
            } else {
                "jpg"
            };
            meta.picture = Some((pic.data.clone(), ext));
        }
    }
    Some(meta)
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 合成一个合法的 DSF：单/双声道、指定时长的 1 kHz 正弦。
    /// 1-bit 流用**二阶 sigma-delta** 编码（比一阶的信噪比好很多，否则测试测的是编码噪声）。
    /// 数据按 DSF 规范以 block_size 为单位**逐声道分块交错**存放。
    /// 每个测试用**独立文件名** —— 它们在同一个进程里并行跑，共用路径会互相踩
    fn make_dsf_at(name: &str, freq: f32, seconds: f32, channels: usize) -> std::path::PathBuf {
        const RATE: u32 = 2_822_400; // DSD64
        const BLOCK: usize = 4096;
        // 取整数个块，避免尾部补齐导致「data 长度」与「sample count」不一致
        let blocks = ((seconds * RATE as f32) as usize / (BLOCK * 8)).max(1);
        let bits_per_ch = blocks * BLOCK * 8;

        let mut planars: Vec<Vec<u8>> = Vec::new();
        for _ch in 0..channels {
            let mut bytes = vec![0u8; blocks * BLOCK];
            let (mut i1, mut i2, mut y) = (0.0f32, 0.0f32, 1.0f32);
            for n in 0..bits_per_ch {
                let x = 0.5 * (2.0 * std::f32::consts::PI * freq * n as f32 / RATE as f32).sin();
                i1 += x - y;
                i2 += i1 - y;
                y = if i2 >= 0.0 { 1.0 } else { -1.0 };
                if y > 0.0 {
                    // DSF 的位序是 LSB-first
                    bytes[n / 8] |= 1 << (n % 8);
                }
            }
            planars.push(bytes);
        }

        // data 区：每块按声道交替
        let mut data = Vec::with_capacity(blocks * BLOCK * channels);
        for b in 0..blocks {
            for ch in 0..channels {
                data.extend_from_slice(&planars[ch][b * BLOCK..(b + 1) * BLOCK]);
            }
        }

        let mut f = Vec::new();
        let total_size = 28u64 + 52 + 12 + data.len() as u64;
        f.extend_from_slice(b"DSD ");
        f.extend_from_slice(&28u64.to_le_bytes());
        f.extend_from_slice(&total_size.to_le_bytes());
        f.extend_from_slice(&0u64.to_le_bytes()); // 无 ID3
        f.extend_from_slice(b"fmt ");
        f.extend_from_slice(&52u64.to_le_bytes());
        f.extend_from_slice(&1u32.to_le_bytes()); // version
        f.extend_from_slice(&0u32.to_le_bytes()); // format id = DSD raw
        f.extend_from_slice(&(if channels == 2 { 2u32 } else { 1u32 }).to_le_bytes());
        f.extend_from_slice(&(channels as u32).to_le_bytes());
        f.extend_from_slice(&RATE.to_le_bytes());
        f.extend_from_slice(&1u32.to_le_bytes()); // bits per sample
        f.extend_from_slice(&(bits_per_ch as u64).to_le_bytes());
        f.extend_from_slice(&(BLOCK as u32).to_le_bytes());
        f.extend_from_slice(&0u32.to_le_bytes());
        f.extend_from_slice(b"data");
        f.extend_from_slice(&(12 + data.len() as u64).to_le_bytes());
        f.extend_from_slice(&data);

        let p = std::env::temp_dir().join(name);
        std::fs::write(&p, &f).unwrap();
        p
    }

/// 44.1k 单声道 16bit WAV —— 和 DSD 的 88.2k/立体声不同，正好检验换源后的转换比
    fn make_wav_44k(name: &str, freq: f32, seconds: f32) -> std::path::PathBuf {
        let rate: u32 = 44_100;
        let n = (rate as f32 * seconds) as u32;
        let mut pcm = Vec::with_capacity(n as usize * 2);
        for i in 0..n {
            let v = (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5;
            pcm.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
        }
        let mut w = Vec::new();
        let len = pcm.len() as u32;
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + len).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * 2).to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&len.to_le_bytes());
        w.extend_from_slice(&pcm);
        let p = std::env::temp_dir().join(name);
        std::fs::write(&p, &w).unwrap();
        p
    }

    /// DsfBlocks 与 dsd-reader 的 DsdIter 必须**逐字节一致**：
    /// DSF 播放现在走的是 DsfBlocks（为了 O(1) 定位），一旦分块方式/位序/尾帧处理和
    /// dsd-reader 不同，解码出来的就不是原来的声音（甚至变成噪声）。
    #[test]
    fn dsf_blocks_match_dsd_reader_byte_for_byte() {
        let p = make_dsf_at("oberon_dsf_equiv.dsf", 1000.0, 0.5, 2);
        let reader = DsdReader::from_container(p.clone()).unwrap();
        let mut iter = reader.dsd_iter().unwrap();
        let off = dsf_data_offset(p.to_str().unwrap()).expect("应能解析出 data 偏移");
        let mut mine = DsfBlocks::open(
            p.to_str().unwrap(),
            off,
            reader.block_size() as usize,
            reader.channels_num(),
            reader.audio_length(),
        )
        .unwrap();
        let mut frames = 0;
        loop {
            match (iter.next(), mine.next_frame()) {
                (None, None) => break,
                (Some((na, ba)), Some((nb, bb))) => {
                    assert_eq!(na, nb, "第 {frames} 帧有效字节数不一致");
                    assert_eq!(ba.len(), bb.len(), "第 {frames} 帧声道数不一致");
                    for ch in 0..ba.len() {
                        assert_eq!(&ba[ch][..], &bb[ch][..], "第 {frames} 帧第 {ch} 声道字节不一致");
                    }
                    frames += 1;
                }
                (x, y) => panic!("结束位置不一致：iter={} mine={}", x.is_some(), y.is_some()),
            }
        }
        assert!(frames > 10, "帧数太少: {frames}");
        eprintln!("[test] DsfBlocks 与 DsdIter 逐字节一致，共 {frames} 帧");
    }

    /// 回归：DSF 的 O(1) 定位（File::seek）必须与「顺序跳过到同一块」落到同一位置、
    /// 解出完全相同的样本 —— 否则定位会错位，听起来就是跑到别的地方去了。
    #[test]
    fn dsf_o1_seek_matches_sequential_skip() {
        let p = make_dsf_at("oberon_dsf_seek_equiv.dsf", 1000.0, 1.0, 2);
        let secs = 0.625;
        // A：O(1) 路径（现网走这条）
        let mut a = DsdSource::open(p.to_str().unwrap()).unwrap();
        a.try_seek(Duration::from_secs_f64(secs)).unwrap();
        let sa: Vec<f32> = a.by_ref().take(40_000).collect();
        // B：顺序跳过路径（修复前的落点），改成 Iter 并跳到同一块
        let mut b = DsdSource::open(p.to_str().unwrap()).unwrap();
        {
            let reader = DsdReader::from_container(p.clone()).unwrap();
            let mut iter = reader.dsd_iter().unwrap();
            let bits = (secs * b.dsd_rate_hz as f64) as u64;
            let mut left = (bits / 8) / b.block_size.max(1) as u64;
            while left > 0 {
                match iter.next() {
                    Some(_) => left -= 1,
                    None => break,
                }
            }
            b.blocks = BlockSource::Iter(iter);
            b.reset_after_seek();
        }
        let sb: Vec<f32> = b.by_ref().take(40_000).collect();
        assert_eq!(sa.len(), sb.len(), "两边解出的样本数不一致");
        assert_eq!(sa, sb, "O(1) 定位与顺序跳过的解码结果必须完全一致");
        eprintln!("[test] DSF O(1) 定位与顺序跳过一致（{} 个样本）", sa.len());
    }

    /// 1-bit 查表路径与标量路径必须解出**同一条 PCM**（只有浮点求和顺序不同，留一点容差）。
    /// 这是这次优化的安全网：查表的位序 / 相位 / ±1 映射只要错一格，这里立刻炸。
    #[test]
    fn lut_matches_scalar_reference() {
        let p = make_dsf_at("oberon_dsd_lut_equiv.dsf", 1000.0, 0.5, 2);
        let mut lut = DsdSource::open(p.to_str().unwrap()).unwrap();
        assert!(lut.use_lut, "decim 是 8 的倍数时应走查表路径");
        lut.use_lut = true;
        let a: Vec<f32> = lut.by_ref().collect();
        let mut sc = DsdSource::open(p.to_str().unwrap()).unwrap();
        sc.use_lut = false;
        let b: Vec<f32> = sc.by_ref().collect();
        assert_eq!(a.len(), b.len(), "两条路径的输出样本数必须一致（否则输出网格/相位错了）");
        let mut max_diff = 0.0f32;
        for (x, y) in a.iter().zip(b.iter()) {
            max_diff = max_diff.max((x - y).abs());
        }
        let rms = (a.iter().map(|v| v * v).sum::<f32>() / a.len() as f32).sqrt();
        eprintln!("[test] LUT vs 标量：{} 样本，RMS {rms:.3}，最大差 {max_diff:.3e}", a.len());
        assert!(max_diff < 1e-4, "LUT 与标量解出的 PCM 不一致，最大差 {max_diff}（查表错位？）");
    }
    /// 真文件诊断（默认 --ignored）：跳到 85% 处的**定位延迟**与**音频线程停顿**。
    ///
    /// 修复前（顺序跳过 166MB，且由音频线程执行）：定位 1192ms、音频线程停顿 1250ms
    /// ⇒ WASAPI 缓冲排空，用户听到「跳得越远电音越长」。
    /// 修复后：DSF 有块结构 ⇒ `File::seek` 直接定位（O(1)）；并且自定义源的定位只在引擎线程执行。
    ///
    /// 手动跑（不设环境变量时用默认路径；文件不在就跳过）：
    ///   $env:OBERON_DSD_TEST="D:\本地完整下载\交换余生.dsf"
    ///   cargo test --lib -- --ignored --nocapture dsd_far_seek_is_fast
    #[test]
    #[ignore]
    fn dsd_far_seek_is_fast() {
        use std::sync::atomic::{AtomicBool, Ordering as O};
        use std::sync::Arc;
        use std::time::Instant;
        let default_path = r"D:\本地完整下载\交换余生.dsf".to_string();
        let path = std::env::var("OBERON_DSD_TEST").unwrap_or(default_path);
        if !std::path::Path::new(&path).exists() {
            eprintln!("[test] 跳过：找不到 DSD 测试文件（设 OBERON_DSD_TEST 指定）: {path}");
            return;
        }
        let mut src = DsdSource::open(&path).expect("打开 DSD");
        let dur = src.total_duration().map(|d| d.as_secs_f64()).unwrap_or(0.0);
        let target = Duration::from_secs_f64(dur * 0.85);
        eprintln!("[test] 文件 {path}：{dur:.1}s，跳到 {:.1}s", target.as_secs_f64());

        // 1) 定位延迟本身（引擎线程上跑的就是它）
        let t0 = Instant::now();
        src.try_seek(target).expect("try_seek");
        let seek_ms = t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!("[test] try_seek 延迟 {seek_ms:.1}ms（修复前 1192ms）");
        assert!(seek_ms < 300.0, "定位还是慢：{seek_ms}ms（DSF 应走 File::seek 的 O(1) 路径）");
        // 定位之后仍能解码出内容
        let got = src.by_ref().take(88_200 * 2).count();
        assert_eq!(got, 88_200 * 2, "定位之后应能继续解码");

        // 1b) 真文件上 LUT 与标量必须解出同一条 PCM（合成文件之外再钉一遍）
        let sample_n = 2_000_000usize;
        let mut a = DsdSource::open(&path).unwrap();
        a.use_lut = true;
        let va: Vec<f32> = a.by_ref().take(sample_n).collect();
        let mut b = DsdSource::open(&path).unwrap();
        b.use_lut = false;
        let vb: Vec<f32> = b.by_ref().take(sample_n).collect();
        assert_eq!(va.len(), vb.len(), "真文件上两条路径样本数不一致");
        let md = va.iter().zip(vb.iter()).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        eprintln!("[test] 真文件 LUT vs 标量：{} 样本，最大差 {md:.3e}", va.len());
        assert!(md < 1e-4, "真文件上 LUT 与标量不一致：{md}");
        // 2) 音频线程停顿：让 Player::try_seek 在拉取线程上执行（rodio 的真实行为）
        let (mixer, mut out) = rodio::mixer::mixer(
            NonZero::new(2).unwrap(),
            NonZero::new(88_200).unwrap(),
        );
        let player = rodio::Player::connect_new(&mixer);
        player.append(DsdSource::open(&path).unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let pull = std::thread::spawn(move || {
            let mut last = Instant::now();
            let mut worst = 0.0f64;
            while !stop2.load(O::Relaxed) {
                let _ = out.next();
                let now = Instant::now();
                let g = now.duration_since(last).as_secs_f64();
                if g > worst {
                    worst = g;
                }
                last = now;
            }
            worst
        });
        std::thread::sleep(Duration::from_millis(300));
        player.try_seek(target).expect("Player::try_seek");
        stop.store(true, O::Relaxed);
        let gap = pull.join().unwrap();
        eprintln!("[test] 音频线程最长停顿 {:.1}ms（修复前 1250ms）", gap * 1000.0);
        assert!(gap < 0.05, "音频线程仍被阻塞 {gap}s —— 电音会回来");
    }

    /// 端到端回归：DSD(88.2k) 播完接一首 44.1k 的曲子，**不能沿用上一首的采样率**转换。
    /// 症状是下一首以 2 倍速播放（用户报的「切歌后声音奇怪且加速」）。
    /// 不用音频设备：建一个混音器，把两个音源追加到同一个 Player，数混音输出多少帧。
    #[test]
    fn handoff_after_dsd_does_not_reuse_previous_rate() {
        use std::num::NonZero;
        let dsd = make_dsf_at("oberon_dsd_handoff.dsf", 1000.0, 0.2, 2);
        let wav = make_wav_44k("oberon_handoff.wav", 2000.0, 0.4);
        let (mixer, out) = rodio::mixer::mixer(
            NonZero::new(2).unwrap(),
            NonZero::new(48_000).unwrap(),
        );
        let player = rodio::Player::connect_new(&mixer);
        player.append(DsdSource::open(dsd.to_str().unwrap()).expect("dsd"));
        player.append(crate::engine::audio::open_decoder(wav.to_str().unwrap()).expect("wav"));
        // 混音器对空输入会一直吐静音、不会结束，所以数总帧数没有意义 ——
        // 改测「音频内容持续到第几秒」：DSD 0.2s + WAV 0.4s = 0.6s；
        // 若下一首被按 88.2k 转换，WAV 会被 2 倍速吞掉，内容只到约 0.4s。
        let buf: Vec<f32> = out.take(48_000 * 2 * 3).collect();
        let last_loud = buf
            .chunks(2)
            .rposition(|c| c.iter().any(|s| s.abs() > 0.01))
            .unwrap_or(0);
        let content_secs = (last_loud + 1) as f64 / 48_000.0;
        eprintln!("[test] 音频内容持续到 {content_secs:.3}s（期望约 0.600s）");
        assert!(
            content_secs > 0.55,
            "内容只到 {content_secs:.3}s（应约 0.600s）—— 下一首被按上一首的采样率转换了（会变速）"
        );
    }


    fn goertzel(samples: &[f32], stride: usize, rate: f32, freq: f32) -> f32 {
        let n = samples.len() / stride;
        if n == 0 {
            return 0.0;
        }
        let w = 2.0 * std::f32::consts::PI * freq / rate;
        let coeff = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for i in 0..n {
            let s0 = samples[i * stride] + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        ((s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0)).sqrt() / n as f32
    }

    /// 端到端：合成 1 kHz 的 DSF → 解码 → 输出应当是 88.2k/立体声、且主频确为 1 kHz
    #[test]
    fn decodes_dsf_to_expected_tone() {
        let p = make_dsf_at("oberon_dsd_tone.dsf", 1000.0, 1.0, 2);
        let mut src = DsdSource::open(p.to_str().unwrap()).expect("打开 .dsf");
        assert_eq!(src.channels().get(), 2, "声道数");
        assert_eq!(src.sample_rate().get(), 88_200, "抽取比应让输出落到 88.2k");
        let dur = src.total_duration().expect("应有时长").as_secs_f64();
        assert!((dur - 1.0).abs() < 0.05, "时长异常: {dur}");

        let samples: Vec<f32> = src.by_ref().collect();
        let frames = samples.len() / 2;
        assert!(frames > 80_000, "解出的样本太少: {frames}");
        let secs = frames as f64 / 88_200.0;
        assert!((secs - 1.0).abs() < 0.05, "解出时长异常: {secs}");

        let m1k = goertzel(&samples, 2, 88_200.0, 1000.0);
        let m500 = goertzel(&samples, 2, 88_200.0, 500.0);
        let m5k = goertzel(&samples, 2, 88_200.0, 5000.0);
        eprintln!("[test] DSF 解码：1k={m1k:.4} 500={m500:.4} 5k={m5k:.4} 时长={secs:.3}s");
        assert!(m1k > 0.05, "1kHz 幅度太小（滤波把信号也滤掉了？）: {m1k}");
        assert!(m1k > m500 * 3.0, "1k({m1k}) 未显著高于 500({m500})");
        assert!(m1k > m5k * 3.0, "1k({m1k}) 未显著高于 5k({m5k})");
    }


    /// 快进必须走「原地定位」，不能退回「排水」——
    /// 后者会把整段 DSD 重新过一遍 FIR，186MB 的文件就是几十亿次乘加（用户报的卡死）。
    #[test]
    fn seek_is_cheap_and_correct() {
        let p = make_dsf_at("oberon_dsd_seek.dsf", 1000.0, 1.0, 2);
        let mut src = DsdSource::open(p.to_str().unwrap()).expect("open");
        let t0 = std::time::Instant::now();
        src.try_seek(Duration::from_secs_f64(0.75))
            .expect("try_seek 必须成功：返回 Err 引擎就会退回排水 → 卡死");
        let rest: Vec<f32> = src.by_ref().collect();
        let elapsed = t0.elapsed();
        // 1.0 - 0.75 = 0.25s；seek 会向下对齐到 4096 字节的整块，所以略少一点
        let secs = rest.len() as f64 / (88_200.0 * 2.0);
        assert!((secs - 0.257).abs() < 0.02, "seek 后剩余时长异常: {secs}");
        let m1k = goertzel(&rest, 2, 88_200.0, 1000.0);
        assert!(m1k > 0.05, "seek 之后信号不对（窗口/相位没接上？）: {m1k}");
        eprintln!("[test] DSD seek 到 0.75s：剩余 {secs:.3}s，seek+解码耗时 {elapsed:?}");
    }


    /// 内嵌歌词：lofty 读不了 .dsf，必须走 id3 —— 用户报的「刷了歌词但不显示」
    #[test]
    fn reads_embedded_lyrics_from_dsf() {
        let p = make_dsf_at("oberon_dsd_lyrics.dsf", 1000.0, 0.3, 2);
        let mut tag = id3::Tag::new();
        tag.set_title("交换余生");
        tag.add_frame(id3::frame::Lyrics {
            lang: "eng".to_string(),
            description: String::new(),
            text: "[00:01.00]第一行\n[00:02.00]第二行".to_string(),
        });
        // 自己控制落盘位置：DSF 规范要求 ID3v2 放在**文件末尾**，并把头部偏移 20 的
        // metadata pointer 指过去（id3 的 write_to_path 对 DSF 会猜错格式，所以只借它编码）
        let mut tag_bytes = Vec::new();
        tag.write_to(&mut tag_bytes, id3::Version::Id3v24).expect("编码 ID3");
        let mut bytes = std::fs::read(&p).unwrap();
        let offset = bytes.len() as u64;
        bytes.extend_from_slice(&tag_bytes);
        let total = bytes.len() as u64;
        bytes[12..20].copy_from_slice(&total.to_le_bytes()); // 总文件大小
        bytes[20..28].copy_from_slice(&offset.to_le_bytes()); // 标签位置
        std::fs::write(&p, &bytes).unwrap();
        assert!(is_dsd_container(p.to_str().unwrap()), "写标签后容器仍应完好");
        let text = embedded_lyrics(p.to_str().unwrap()).expect("应能读出内嵌歌词");
        assert!(text.contains("第一行"), "歌词内容不对: {text}");
        // 完整链路：识别为内嵌歌词 + 带时间轴 + 两行
        let l = crate::lyrics::load(p.to_str().unwrap());
        assert_eq!(l.source, "embedded", "来源应为内嵌标签");
        assert!(l.synced, "应解析出时间轴");
        assert_eq!(l.lines.len(), 2, "行数不对");
    }

    /// 元数据支路（扫描层靠它把 DSD 收进库）
    #[test]
    fn probe_reports_container_facts() {
        let p = make_dsf_at("oberon_dsd_probe.dsf", 1000.0, 1.0, 2);
        let m = probe(p.to_str().unwrap()).expect("probe 应成功");
        assert_eq!(m.sample_rate, 2_822_400, "DSD64 采样率");
        assert_eq!(m.channels, 2);
        assert!((m.duration_ms - 1000).abs() < 50, "时长异常: {}", m.duration_ms);
        eprintln!("[test] DSD probe: rate={} ch={} dur={}ms", m.sample_rate, m.channels, m.duration_ms);
    }

    /// 坏文件不能 panic、也不能装成能播
    #[test]
    fn rejects_junk() {
        let p = std::env::temp_dir().join("oberon_dsd_junk.dsf");
        std::fs::write(&p, b"DSD not really").unwrap();
        let opened = DsdSource::open(p.to_str().unwrap());
        assert!(opened.is_err(), "坏文件应报错");
        assert!(probe(p.to_str().unwrap()).is_none());
    }
}