//! 裸 AAC（ADTS）解码：自己解封装 + 复用 symphonia 的 AAC 解码器。
//!
//! 为什么需要：symphonia 0.5/0.6 的 all-formats 里**没有 ADTS reader**
//! （只有 caf / isomp4 / mkv / ogg / aiff / wav），所以 .aac 文件「收进库却播不了」。
//! 但 AAC **解码器** symphonia 是有的（symphonia-codec-aac，已在依赖树里）——
//! 缺的只是「把 ADTS 帧拆出来」+「从帧头推导出 AudioSpecificConfig」。
//!
//! ADTS 帧头（7 字节，protection_absent=0 时 9 字节）布局：
//!   syncword(12, 全 1) | ID(1) | layer(2, 恒 0) | protection_absent(1)
//!   | profile(2) | sampling_frequency_index(4) | private(1) | channel_configuration(3)
//!   | ... | frame_length(13) | buffer_fullness(11) | number_of_raw_data_blocks(2)
//!
//! seek 走默认实现（Err）→ 引擎的「重解码排水」兜底。

use crate::error::{AppError, E_DECODE, E_FILE_UNAVAILABLE};
use rodio::source::{SeekError, Source};
use rodio::{ChannelCount, SampleRate};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::num::NonZero;
use std::time::Duration;
use symphonia::core::audio::{AudioBuffer, Channels, Signal, SignalSpec};
use symphonia::core::codecs::{CodecParameters, Decoder, DecoderOptions, CODEC_TYPE_AAC};
use symphonia::core::formats::Packet;

/// ADTS 的 13 档采样率索引
const ADTS_RATES: [u32; 13] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
/// 每个 AAC 帧固定 1024 个样本（每声道）
const AAC_FRAME_SAMPLES: u64 = 1024;

struct AdtsHeader {
    /// true = 7 字节头（无 CRC），false = 9 字节头
    protection_absent: bool,
    freq_index: u8,
    sample_rate: u32,
    /// channel_configuration（1..=7）
    channel_config: u8,
    /// Audio Object Type = profile + 1（1=Main, 2=LC, 3=SSR, 4=LTP）
    aot: u8,
    frame_len: usize,
}

/// 解析一个 ADTS 帧头（至少 7 字节）
fn parse_header(b: &[u8]) -> Option<AdtsHeader> {
    if b.len() < 7 {
        return None;
    }
    // 同步字 12 位全 1，且 layer 必须为 00
    if b[0] != 0xFF || (b[1] & 0xF6) != 0xF0 {
        return None;
    }
    let protection_absent = (b[1] & 0x01) != 0;
    let profile = (b[2] >> 6) & 0x03;
    let freq_index = (b[2] >> 2) & 0x0F;
    let channel_config = ((b[2] & 0x01) << 2) | ((b[3] >> 6) & 0x03);
    let frame_len =
        (((b[3] as usize) & 0x03) << 11) | ((b[4] as usize) << 3) | ((b[5] as usize) >> 5);
    let sample_rate = *ADTS_RATES.get(freq_index as usize)?;
    if channel_config == 0 {
        return None; // 0 = 由 PCE 决定，裸流里基本见不到
    }
    Some(AdtsHeader {
        protection_absent,
        freq_index,
        sample_rate,
        channel_config,
        aot: profile + 1,
        frame_len,
    })
}

/// 由 ADTS 帧头推导 AudioSpecificConfig（AAC 的 2 字节配置）
fn audio_specific_config(h: &AdtsHeader) -> [u8; 2] {
    let aot = h.aot & 0x1F;
    let fi = h.freq_index & 0x0F;
    let cc = h.channel_config & 0x0F;
    // AOT(5) | 采样率索引(4) | 声道配置(4) | GASpecificConfig(3，全 0)
    [
        (aot << 3) | (fi >> 1),
        ((fi & 0x01) << 7) | (cc << 3),
    ]
}

/// channel_configuration → symphonia 的声道位标记
fn channels_of(n: u8) -> Channels {
    match n {
        1 => Channels::FRONT_LEFT,
        2 => Channels::FRONT_LEFT | Channels::FRONT_RIGHT,
        3 => Channels::FRONT_LEFT | Channels::FRONT_RIGHT | Channels::FRONT_CENTRE,
        4 => {
            Channels::FRONT_LEFT
                | Channels::FRONT_RIGHT
                | Channels::FRONT_CENTRE
                | Channels::REAR_CENTRE
        }
        5 => {
            Channels::FRONT_LEFT
                | Channels::FRONT_RIGHT
                | Channels::FRONT_CENTRE
                | Channels::REAR_LEFT
                | Channels::REAR_RIGHT
        }
        6 => {
            Channels::FRONT_LEFT
                | Channels::FRONT_RIGHT
                | Channels::FRONT_CENTRE
                | Channels::LFE1
                | Channels::REAR_LEFT
                | Channels::REAR_RIGHT
        }
        _ => {
            Channels::FRONT_LEFT
                | Channels::FRONT_RIGHT
                | Channels::FRONT_CENTRE
                | Channels::LFE1
                | Channels::REAR_LEFT
                | Channels::REAR_RIGHT
                | Channels::REAR_CENTRE
        }
    }
}

pub struct AdtsAacSource {
    file: BufReader<File>,
    decoder: Box<dyn Decoder>,
    channels: u16,
    sample_rate: u32,
    /// symphonia 解码输出的转换缓冲
    buf: AudioBuffer<f32>,
    /// 交错后的输出
    out: Vec<f32>,
    pos: usize,
    /// 时间戳（累计样本数，symphonia 需要）
    ts: u64,
    total: Option<Duration>,
    ended: bool,
}

impl AdtsAacSource {
    pub fn open(path: &str) -> Result<Self, AppError> {
        let file = File::open(path).map_err(|e| {
            AppError::new(E_FILE_UNAVAILABLE, format!("无法打开音频文件 {path}: {e}"))
        })?;
        let mut file = BufReader::new(file);

        let mut head = [0u8; 9];
        file.read_exact(&mut head[..7])
            .map_err(|e| AppError::new(E_DECODE, format!("读取 ADTS 帧头失败: {e}")))?;
        let h = parse_header(&head)
            .ok_or_else(|| AppError::new(E_DECODE, "不是有效的 ADTS(AAC) 流".to_string()))?;

        let params = {
            let mut p = CodecParameters::new();
            p.for_codec(CODEC_TYPE_AAC)
                .with_sample_rate(h.sample_rate)
                .with_channels(channels_of(h.channel_config))
                .with_extra_data(audio_specific_config(&h).to_vec().into_boxed_slice());
            p
        };
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| AppError::new(E_DECODE, format!("创建 AAC 解码器失败: {e}")))?;

        // 总时长：扫一遍帧头累加（只读 7 字节/帧，不解码）
        let frames = count_frames(&mut file).unwrap_or(0);
        let total = if frames > 0 {
            let secs = (frames * AAC_FRAME_SAMPLES) as f64 / h.sample_rate as f64;
            Some(Duration::from_secs_f64(secs))
        } else {
            None
        };

        // 回到开头准备解码
        file.seek(SeekFrom::Start(0))
            .map_err(|e| AppError::new(E_DECODE, format!("定位到文件头失败: {e}")))?;

        Ok(Self {
            file,
            decoder,
            channels: h.channel_config as u16,
            sample_rate: h.sample_rate,
            buf: AudioBuffer::new(AAC_FRAME_SAMPLES, SignalSpec::new(h.sample_rate, channels_of(h.channel_config))),
            out: Vec::new(),
            pos: 0,
            ts: 0,
            total,
            ended: false,
        })
    }

    /// 读并解下一个 ADTS 帧；返回 false = 流结束
    fn fill(&mut self) -> bool {
        if self.ended {
            return false;
        }
        loop {
            let mut hdr = [0u8; 9];
            if self.file.read_exact(&mut hdr[..7]).is_err() {
                self.ended = true;
                return false;
            }
            let Some(h) = parse_header(&hdr) else {
                self.ended = true;
                return false;
            };
            let header_len = if h.protection_absent { 7 } else { 9 };
            if header_len == 9 && self.file.read_exact(&mut hdr[7..9]).is_err() {
                self.ended = true;
                return false;
            }
            let payload_len = h.frame_len.saturating_sub(header_len);
            if payload_len == 0 {
                continue;
            }
            let mut payload = vec![0u8; payload_len];
            if self.file.read_exact(&mut payload).is_err() {
                self.ended = true;
                return false;
            }

            let packet = Packet::new_from_boxed_slice(
                0,
                self.ts,
                AAC_FRAME_SAMPLES,
                payload.into_boxed_slice(),
            );
            self.ts += AAC_FRAME_SAMPLES;

            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                // 首帧常因缺配置而失败，继续读下一帧即可
                Err(_) => continue,
            };
            let spec = *decoded.spec();
            let frames = decoded.frames();
            if frames == 0 {
                continue;
            }
            // 每帧重建转换缓冲：容量/规格必须与解码结果一致（convert 内部有断言）
            self.buf = AudioBuffer::new(decoded.capacity() as u64, spec);
            decoded.convert(&mut self.buf);

            let ch = spec.channels.count();
            self.out.clear();
            self.out.reserve(frames * ch);
            for f in 0..frames {
                for c in 0..ch {
                    self.out.push(self.buf.chan(c)[f]);
                }
            }
            self.pos = 0;
            return true;
        }
    }
}

impl Iterator for AdtsAacSource {
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

impl Source for AdtsAacSource {
    fn current_span_len(&self) -> Option<usize> {
        // ⚠️ 必须返回 Some：见 engine/opus.rs 里的说明 —— 返回 None 会让混音器的采样率
        // 转换比在换源后失效，下一首会按上一首的采样率播放（变速/变调）。
        Some((self.out.len() - self.pos).max(1))
    }
    fn channels(&self) -> ChannelCount {
        NonZero::new(self.channels).unwrap_or(NonZero::new(2).expect("2 非零"))
    }
    fn sample_rate(&self) -> SampleRate {
        NonZero::new(self.sample_rate).unwrap_or(NonZero::new(44_100).expect("44.1k 非零"))
    }
    fn total_duration(&self) -> Option<Duration> {
        self.total
    }

    /// 原地定位：逐个读 ADTS 帧头（每帧只读 7 字节）走到目标帧，再从那继续解码。
    /// ⚠️ 必须实现：否则 rodio 的原地 seek 失败 → 引擎退回「重开解码器 + 逐样本排水」，
    /// 大文件（几十 MB 的 .aac）会卡住引擎线程。
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let err = || SeekError::NotSupported {
            underlying_source: "adts",
        };
        let target_frames =
            (pos.as_secs_f64() * self.sample_rate as f64 / AAC_FRAME_SAMPLES as f64) as u64;
        self.file.seek(SeekFrom::Start(0)).map_err(|_| err())?;
        let mut off = 0u64;
        let mut n = 0u64;
        let mut hdr = [0u8; 7];
        while n < target_frames {
            if self.file.seek(SeekFrom::Start(off)).is_err() {
                break;
            }
            if self.file.read_exact(&mut hdr).is_err() {
                break;
            }
            let Some(h) = parse_header(&hdr) else { break };
            if (h.frame_len as u64) < 7 {
                break;
            }
            off += h.frame_len as u64;
            n += 1;
        }
        self.file.seek(SeekFrom::Start(off)).map_err(|_| err())?;
        self.ts = n * AAC_FRAME_SAMPLES;
        self.out.clear();
        self.pos = 0;
        self.ended = false;
        Ok(())
    }
}

/// 顺序走一遍 ADTS 帧头，数出一共多少帧（用于总时长）
fn count_frames(file: &mut BufReader<File>) -> Option<u64> {
    let len = file.get_ref().metadata().ok()?.len();
    let mut off = 0u64;
    let mut frames = 0u64;
    let mut hdr = [0u8; 7];
    while off + 7 <= len {
        file.seek(SeekFrom::Start(off)).ok()?;
        if file.read_exact(&mut hdr).is_err() {
            break;
        }
        let Some(h) = parse_header(&hdr) else { break };
        if h.frame_len < 7 {
            break;
        }
        off += h.frame_len as u64;
        frames += 1;
        if frames > 20_000_000 {
            break; // 保险丝：避免坏文件把扫描拖死
        }
    }
    Some(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用真实样本（samples.ffmpeg.org 的 ct_faac-adts.aac）的头 7 字节校验解析
    #[test]
    fn parses_real_adts_header() {
        // ff f9 50 80 37 1f fc = AAC-LC / 44100Hz / 立体声 / 帧长 440
        let h = parse_header(&[0xff, 0xf9, 0x50, 0x80, 0x37, 0x1f, 0xfc]).expect("应能解析");
        assert!(h.protection_absent, "0xf9 低位为 1 = 无 CRC，头长 7");
        assert_eq!(h.aot, 2, "profile=01 → AAC-LC(AOT=2)");
        assert_eq!(h.freq_index, 4);
        assert_eq!(h.sample_rate, 44_100);
        assert_eq!(h.channel_config, 2, "立体声");
        assert_eq!(h.frame_len, 440);
        assert_eq!(audio_specific_config(&h), [0x12, 0x10], "ASC 推导");
    }

    #[test]
    fn rejects_non_adts() {
        assert!(parse_header(&[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).is_none());
        assert!(parse_header(&[0xff, 0xf9, 0x50]).is_none(), "不足 7 字节");
        assert!(
            parse_header(&[0xff, 0xf1, 0x50, 0x00, 0x00, 0x00, 0x00]).is_none(),
            "channel_config=0 应拒绝"
        );
    }


    /// 全量解码一遍，确认「解出的样本数」与「帧头累加得到的时长」一致 ——
    /// 进度条/时长显示都依赖这个数字，不能有系统性偏差。
    #[test]
    fn decoded_length_matches_frame_count() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.build/samples/ct_faac-adts.aac");
        if !p.exists() {
            return;
        }
        let mut src = AdtsAacSource::open(p.to_str().unwrap()).expect("open");
        let declared = src.total_duration().expect("时长").as_secs_f64();
        let total: usize = src.by_ref().count();
        let actual = total as f64 / (44_100.0 * 2.0);
        eprintln!("[test] 帧头推算 {declared:.3}s / 实际解码 {actual:.3}s / 样本数 {total}");
        assert!(
            (declared - actual).abs() < 0.05,
            "帧头推算({declared:.3}s)与实际解码({actual:.3}s)不一致"
        );
    }


    /// 快进必须能原地定位（否则引擎退回排水，大 .aac 会卡住引擎线程）
    #[test]
    fn seek_then_decode_continues() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.build/samples/ct_faac-adts.aac");
        if !p.exists() {
            return;
        }
        let mut src = AdtsAacSource::open(p.to_str().unwrap()).expect("open");
        let t0 = std::time::Instant::now();
        src.try_seek(Duration::from_secs_f64(10.0))
            .expect("try_seek 必须成功");
        let samples: Vec<f32> = src.by_ref().take(44_100 * 2).collect();
        eprintln!("[test] ADTS seek 到 10s：耗时 {:?}，取到 {} 样本", t0.elapsed(), samples.len());
        assert!(samples.len() >= 44_100, "seek 后应能继续解码: {}", samples.len());
        let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.001, "seek 后解出来是静音（peak={peak}）");
    }

    /// 真样本端到端：解码 1 秒，检查采样率/声道/非静音
    #[test]
    fn decodes_real_adts_sample() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.build/samples/ct_faac-adts.aac");
        if !p.exists() {
            eprintln!("跳过（缺样本 {}）：可从 samples.ffmpeg.org 下载", p.display());
            return;
        }
        let mut src = AdtsAacSource::open(p.to_str().unwrap()).expect("打开 .aac");
        assert_eq!(src.sample_rate().get(), 44_100);
        assert_eq!(src.channels().get(), 2);
        let dur = src.total_duration().expect("应能给出总时长").as_secs_f64();
        eprintln!("[test] 样本总时长 = {dur:.2}s");
        assert!(dur > 5.0 && dur < 120.0, "总时长异常: {dur}");

        let samples: Vec<f32> = src.by_ref().take(44_100 * 2).collect();
        assert!(samples.len() >= 44_100, "解码样本太少: {}", samples.len());
        let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.001, "解出来全是静音（peak={peak}）");
    }
}
