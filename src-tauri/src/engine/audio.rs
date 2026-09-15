//! 音频解码与底层播放辅助（rodio 0.22：symphonia 解码 + cpal 输出）
//!
//! - 解码：rodio 内置 symphonia 后端（mp3/flac/wav/ogg/m4a(aac/alac)/aiff/caf 等）
//! - 输出：DeviceSinkBuilder 默认设备（WASAPI 共享）；独占模式输出留待后续里程碑
//! - 跳转：按设计文档 §4.3 “通过重解码实现”——重新打开文件并跳过样本到目标位置

use crate::engine::beat::{BeatMeter, BeatTap};
use crate::error::{AppError, E_AUDIO_DEVICE, E_DECODE};
use rodio::source::Source;
use rodio::{Decoder, MixerDeviceSink, Player};
use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;
use std::time::Duration;

/// 输出设备 + 播放句柄的持有者（Player/Drop 语义：句柄释放即停止）
pub struct CoreAudio {
    /// 设备句柄必须存活于整个播放过程
    sink: Option<MixerDeviceSink>,
    /// 当前单曲的播放控制句柄
    pub player: Option<Player>,
    /// 当前生效音量 0.0..=1.0
    volume: f32,
}

impl Default for CoreAudio {
    fn default() -> Self {
        Self { sink: None, player: None, volume: 1.0 }
    }
}

impl CoreAudio {
    /// 惰性初始化音频输出（WASAPI 共享模式；失败返回 AUDIO_DEVICE 错误）
    pub fn ensure(&mut self) -> Result<(), AppError> {
        if self.sink.is_some() {
            return Ok(());
        }
        match rodio::DeviceSinkBuilder::open_default_sink() {
            Ok(sink) => {
                self.sink = Some(sink);
                Ok(())
            }
            Err(e) => Err(AppError::new(E_AUDIO_DEVICE, format!("无法打开音频输出设备（WASAPI）：{e}"))),
        }
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
        if let Some(p) = &self.player {
            p.set_volume(self.volume);
        }
    }

    /// 停止并摘除当前播放句柄
    pub fn clear_player(&mut self) {
        if let Some(p) = self.player.take() {
            p.stop();
        }
    }

    /// 建立新的播放句柄（音量自动跟随）
    pub fn new_player(&mut self) -> Result<(), AppError> {
        self.clear_player();
        self.ensure()?;
        let sink = self.sink.as_ref().expect("sink 由 ensure 保证");
        let player = Player::connect_new(sink.mixer());
        player.set_volume(self.volume);
        self.player = Some(player);
        Ok(())
    }

    pub fn sink_is_some(&self) -> bool {
        self.player.is_some()
    }

    pub fn player_empty(&self) -> bool {
        self.player.as_ref().map(|p| p.empty()).unwrap_or(true)
    }

    pub fn player_pos_secs(&self) -> f64 {
        self.player.as_ref().map(|p| p.get_pos().as_secs_f64()).unwrap_or(0.0)
    }

    #[allow(dead_code)]
    pub fn player_paused(&self) -> bool {
        self.player.as_ref().map(|p| p.is_paused()).unwrap_or(true)
    }

    pub fn player_pause(&self) {
        if let Some(p) = &self.player {
            p.pause();
        }
    }

    pub fn player_play(&self) {
        if let Some(p) = &self.player {
            p.play();
        }
    }

    /// 原地 seek（symphonia 走格式级定位，毫秒级、不打断播放）。
    /// 返回 false 表示该格式/当前状态不支持，需要调用方回退到重解码。
    pub fn player_seek(&self, target: Duration) -> bool {
        match &self.player {
            Some(p) => p.try_seek(target).is_ok(),
            None => false,
        }
    }

    /// 追加解码器；顺带用 BeatTap 包裹，把采样喂给节拍检测
    pub fn player_append(&self, decoder: TrackDecoder, meter: Arc<BeatMeter>) {
        if let Some(p) = &self.player {
            meter.set_sample_rate(decoder.sample_rate().get());
            p.append(BeatTap::new(decoder, meter));
        }
    }
}

/// 类型别名：单曲解码器（文件 + BufReader）
pub type TrackDecoder = Decoder<BufReader<File>>;

/// 打开音频文件并创建解码器
pub fn open_decoder(path: &str) -> Result<TrackDecoder, AppError> {
    let file = File::open(path).map_err(|e| {
        AppError::new(crate::error::E_FILE_UNAVAILABLE, format!("无法打开音频文件 {path}: {e}"))
    })?;
    let decoder = Decoder::new(BufReader::new(file))
        .map_err(|e| AppError::new(E_DECODE, format!("解码器初始化失败（格式不支持或文件损坏）: {e}")))?;
    Ok(decoder)
}

/// 解码器总时长（部分格式可能未知，返回 None）
pub fn decoder_duration(decoder: &TrackDecoder) -> Option<Duration> {
    decoder.total_duration()
}

/// 解码器原地 seek（优先，毫秒级）；不支持时回退到排水
pub fn seek_decoder(decoder: &mut TrackDecoder, target: Duration) -> f64 {
    if let Ok(()) = decoder.try_seek(target) {
        return target.as_secs_f64();
    }
    skip_decoder(decoder, target)
}

/// 通过“重解码跳过”实现跳转：把解码器排水到目标时间点，返回实际到达位置（秒）
pub fn skip_decoder(decoder: &mut TrackDecoder, target: Duration) -> f64 {
    let rate = decoder.sample_rate().get().max(1) as u64;
    let channels = decoder.channels().get().max(1) as u64;
    let target_samples = (target.as_secs_f64() * rate as f64 * channels as f64).ceil() as u64;
    let mut seen: u64 = 0;
    for _sample in decoder.by_ref() {
        seen += 1;
        if seen >= target_samples {
            break;
        }
    }
    seen as f64 / (rate as f64 * channels as f64)
}