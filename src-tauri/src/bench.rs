//! 本地性能基准专用的公开薄封装。
//!
//! 为什么需要它：`engine` 是私有模块，而 examples / 外部基准属于**另一个 crate**，
//! 拿不到应用真正使用的解码器（symphonia / opus-pure / ADTS / DSD）。
//! 基准如果自己另抄一份解码逻辑，测的就不是应用本身了 ——
//! 所以这里只做一次 `pub use`，把真正的解码入口原样暴露出去，没有任何额外开销。

pub use crate::engine::audio::{decoder_duration, decoder_sample_rate, open_decoder, TrackDecoder};