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
use rodio::source::Source;
use rodio::{ChannelCount, SampleRate};
use std::fs::File;
use std::io::Read;
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

/// 低通抽头数
const TAPS: usize = 256;
/// 目标输出采样率（优先 88.2k，其次 96k）
const TARGET_RATES: [u32; 2] = [88_200, 96_000];

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

pub struct DsdSource {
    iter: dsd_reader::DsdIter,
    channels: u16,
    sample_rate: u32,
    decim: usize,
    taps: Vec<f32>,
    /// 每声道：上一块留下的尾部（最多 TAPS-1 个输入样本）
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
        let iter = reader
            .dsd_iter()
            .map_err(|e| AppError::new(E_DECODE, format!("无法读取 DSD 数据: {e}")))?;
        let cutoff = 0.9 * 0.5; // 相对输出采样率的归一化截止（0.45 → 输出奈奎斯特的 90%）
        let taps = design_lowpass(cutoff / decim as f32);
        Ok(Self {
            iter,
            channels: channels as u16,
            sample_rate: out_rate,
            decim: decim as usize,
            taps,
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
        if self.ended {
            return false;
        }
        let ch_n = self.channels as usize;
        loop {
            let Some((read_size, blocks)) = self.iter.next() else {
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
                // 相位对齐用全局下标（保证跨块一致）；但**窗口是否够长必须看块内下标** ——
                // 有 carry 时 global 很大而 local 可能还很小，用 global 判断会下标下溢
                if global % self.decim as u64 != 0 || local + 1 < TAPS {
                    continue;
                }
                for ch in 0..ch_n {
                    let src = &self.expanded[ch];
                    let mut acc = 0.0f32;
                    // 直接式 FIR：非零抽头都参与
                    for (j, &t) in self.taps.iter().enumerate() {
                        acc += src[local - j] * t;
                    }
                    self.out.push(acc);
                }
            }

            // 更新 carry（保留最后 TAPS-1 个样本）与已消费计数
            let keep = (TAPS - 1).min(n);
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
        None
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
    fn make_dsf(freq: f32, seconds: f32, channels: usize) -> std::path::PathBuf {
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

        let p = std::env::temp_dir().join("oberon_dsd_test.dsf");
        std::fs::write(&p, &f).unwrap();
        p
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
        let p = make_dsf(1000.0, 1.0, 2);
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

    /// 元数据支路（扫描层靠它把 DSD 收进库）
    #[test]
    fn probe_reports_container_facts() {
        let p = make_dsf(1000.0, 1.0, 2);
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
