//! Ogg Opus 解码（symphonia 不支持 Opus，这里用纯 Rust 的 opus-pure 自己接）。
//!
//! 为什么要自己接：symphonia 0.5/0.6 的 all-codecs 里都**没有 Opus**，而 rodio 最新版
//! 仍然是 symphonia 0.5 —— 所以「.opus 收进库却播不了」只能靠自己解码解决。
//! 选 opus-pure 而不是 libopus 绑定：纯 Rust、不需要 C/cmake 工具链，和项目的解码栈定位一致。
//!
//! 输出 PCM 固定 48 kHz（RFC 7845：Opus 解码总是 48k；OpusHead 里的 input_sample_rate
//! 只是编码前的原始采样率），后续采样率转换交给 rodio。
//! seek 一律走默认实现（返回 Err）：由引擎既有的「重解码排水」兜底 —— 能跳，只是远跳慢。

use crate::error::{AppError, E_DECODE, E_FILE_UNAVAILABLE};
use opus_pure::{OggOpusReader, OpusDecoder};
use rodio::source::Source;
use rodio::{ChannelCount, SampleRate};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::num::NonZero;
use std::time::Duration;

/// Opus 解码固定采样率（RFC 7845）
const OPUS_RATE: u32 = 48_000;
/// 从文件尾部读这么多字节来找最后一个 Ogg 页
const TAIL_SCAN: u64 = 64 * 1024;

pub struct OpusSource {
    reader: OggOpusReader<BufReader<File>>,
    decoder: OpusDecoder,
    channels: u16,
    /// 解码缓冲（交错 f32，长度是容量）
    buf: Vec<f32>,
    /// buf 前 valid 个样本有效
    valid: usize,
    /// 下一个待输出样本下标
    pos: usize,
    /// 还要丢弃多少「帧」（pre-skip，按每声道 48k 样本计）
    pre_skip_left: usize,
    ended: bool,
    total: Option<Duration>,
}

impl OpusSource {
    pub fn open(path: &str) -> Result<Self, AppError> {
        let file = File::open(path).map_err(|e| {
            AppError::new(E_FILE_UNAVAILABLE, format!("无法打开音频文件 {path}: {e}"))
        })?;
        let reader = OggOpusReader::new(BufReader::new(file))
            .map_err(|e| AppError::new(E_DECODE, format!("不是有效的 Ogg Opus 文件: {e}")))?;
        // head() 借用了 reader，先把要用的两个字段拷出来
        let (channels, pre_skip) = {
            let h = reader.head();
            (h.channel_count as u16, h.pre_skip as usize)
        };
        if channels == 0 {
            return Err(AppError::new(E_DECODE, "Opus 声道数为 0"));
        }
        let decoder = OpusDecoder::new(OPUS_RATE as i32, channels as usize)
            .map_err(|e| AppError::new(E_DECODE, format!("创建 Opus 解码器失败: {e}")))?;
        // 总时长：Ogg 末页的 granule position 就是「总样本数@48k」（已含 pre-skip）
        let total = last_granule(path).map(|g| {
            let playable = g.saturating_sub(pre_skip as u64);
            Duration::from_secs_f64(playable as f64 / OPUS_RATE as f64)
        });
        Ok(Self {
            reader,
            decoder,
            channels,
            buf: Vec::new(),
            valid: 0,
            pos: 0,
            pre_skip_left: pre_skip,
            ended: false,
            total,
        })
    }

    /// 解下一包；返回 false = 流结束（含坏包，交给上层当自然结束/跳歌处理）
    fn fill(&mut self) -> bool {
        if self.ended {
            return false;
        }
        loop {
            let pkt = match self.reader.read_packet() {
                Ok(Some(p)) => p,
                Ok(None) | Err(_) => {
                    self.ended = true;
                    return false;
                }
            };
            if pkt.data.is_empty() {
                continue;
            }
            // 这一包在每个声道上有多少个样本（48k 计）
            let per_channel = match opus_pure::packet::samples_48k(&pkt.data) {
                Ok(n) if n > 0 => n,
                _ => continue,
            };
            let need = per_channel * self.channels as usize;
            if self.buf.len() < need {
                self.buf.resize(need, 0.0);
            }
            let n = match self.decoder.decode(&pkt.data, per_channel, &mut self.buf) {
                Ok(n) => n,
                Err(_) => continue,
            };
            let mut valid = n * self.channels as usize;
            // pre-skip：丢掉开头这些「帧」，否则开头会有一小段编码器延迟
            if self.pre_skip_left > 0 {
                let drop = n.min(self.pre_skip_left);
                self.pre_skip_left -= drop;
                if drop == n {
                    continue;
                }
                let drop_samples = drop * self.channels as usize;
                self.buf.copy_within(drop_samples..valid, 0);
                valid -= drop_samples;
            }
            self.valid = valid;
            self.pos = 0;
            return true;
        }
    }
}

impl Iterator for OpusSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        while self.pos >= self.valid {
            if !self.fill() {
                return None;
            }
        }
        let s = self.buf[self.pos];
        self.pos += 1;
        Some(s)
    }
}

impl Source for OpusSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        NonZero::new(self.channels).unwrap_or(NonZero::new(2).expect("2 非零"))
    }
    fn sample_rate(&self) -> SampleRate {
        NonZero::new(OPUS_RATE).expect("48k 非零")
    }
    fn total_duration(&self) -> Option<Duration> {
        self.total
    }
}

/// 读文件尾部、找最后一个完整的 Ogg 页，返回它的 granule position。
/// Ogg 页头布局：OggS(4) | version(1) | header_type(1) | granule(8, LE) | ...
/// header_type 的 0x04 位是「流结束」，优先认它；找不到就退回最后一个 granule 合法的页。
fn last_granule(path: &str) -> Option<u64> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_SCAN);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0u8; (len - start) as usize];
    f.read_exact(&mut buf).ok()?;

    let mut fallback = None;
    for i in (0..buf.len().saturating_sub(14)).rev() {
        if &buf[i..i + 4] != b"OggS" {
            continue;
        }
        let header_type = buf[i + 5];
        let mut g = [0u8; 8];
        g.copy_from_slice(&buf[i + 6..i + 14]);
        let granule = u64::from_le_bytes(g);
        if granule == u64::MAX {
            continue; // -1：这页没有完整包
        }
        if header_type & 0x04 != 0 {
            return Some(granule);
        }
        if fallback.is_none() {
            fallback = Some(granule);
        }
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;
    use opus_pure::{Application, OggOpusWriter, OpusEncoder, OpusHead, MAX_PACKET_BYTES};

    /// 用 opus-pure 自带的编码器生成一个「已知 1 kHz 正弦」的 .opus 文件，返回路径。
    /// 这样测试完全不依赖外部样本：编码与解码都用同一个库做往返验证。
    fn make_opus(seconds: f32, freq: f32, channels: u16, frame: usize) -> std::path::PathBuf {
        let rate = OPUS_RATE;
        let total = (rate as f32 * seconds) as usize;
        let mut pcm = Vec::with_capacity(total * channels as usize);
        for i in 0..total {
            let v = (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5;
            for _ in 0..channels {
                pcm.push(v);
            }
        }
        let mut enc =
            OpusEncoder::new(rate as i32, channels as usize, Application::Audio).expect("编码器");
        enc.bitrate_bps = 128_000;
        let head = OpusHead::for_encoder(&enc, rate);
        let mut w = OggOpusWriter::new(Vec::new(), head).expect("Ogg 写入器");
        let mut packet = vec![0u8; MAX_PACKET_BYTES];
        for block in pcm.chunks_exact(frame * channels as usize) {
            let n = enc.encode(block, frame, &mut packet).expect("编码");
            w.write_packet(&packet[..n]).expect("写包");
        }
        let bytes = w.finish().expect("收尾");
        let path = std::env::temp_dir().join("oberon_opus_test.opus");
        std::fs::write(&path, &bytes).expect("写文件");
        path
    }

    /// 取左声道、按给定频率做 Goertzel，返回幅度
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

    #[test]
    fn decodes_opus_round_trip_to_expected_tone() {
        let path = make_opus(0.5, 1000.0, 2, 960);
        let mut src = OpusSource::open(path.to_str().unwrap()).expect("打开 .opus");
        assert_eq!(src.channels().get(), 2, "声道数");
        assert_eq!(src.sample_rate().get(), OPUS_RATE, "采样率固定 48k");
        let dur = src.total_duration().expect("应能给出总时长").as_secs_f64();
        assert!((dur - 0.5).abs() < 0.08, "总时长异常: {dur}");

        let samples: Vec<f32> = src.by_ref().collect();
        assert!(!samples.is_empty(), "没解出任何样本");
        let secs = samples.len() as f64 / (OPUS_RATE as f64 * 2.0);
        assert!((secs - 0.5).abs() < 0.08, "解出的时长异常: {secs}");

        let m1k = goertzel(&samples, 2, OPUS_RATE as f32, 1000.0);
        let m500 = goertzel(&samples, 2, OPUS_RATE as f32, 500.0);
        let m2k = goertzel(&samples, 2, OPUS_RATE as f32, 2000.0);
        assert!(m1k > 0.05, "1kHz 幅度太小（全是静音？）: {m1k}");
        assert!(m1k > m500 * 3.0, "1k({m1k}) 未显著高于 500({m500})");
        assert!(m1k > m2k * 3.0, "1k({m1k}) 未显著高于 2k({m2k})");
    }

    /// 坏文件不能 panic，也不能装成能播
    #[test]
    fn rejects_junk_file() {
        let p = std::env::temp_dir().join("oberon_opus_junk.opus");
        std::fs::write(&p, b"not an ogg file at all").unwrap();
        assert!(last_granule(p.to_str().unwrap()).is_none());
        assert!(OpusSource::open(p.to_str().unwrap()).is_err(), "坏文件应报错");
    }
}
