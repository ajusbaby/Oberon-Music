//! 音频输出探针（诊断用）：判定当前环境能否真正推进播放进度
//! 运行：cargo run --example audio_probe -- <某个音频文件路径>
use rodio::source::Source;
use rodio::{Decoder, DeviceSinkBuilder, Player};
use std::fs::File;
use std::io::BufReader;
use std::time::{Duration, Instant};

fn main() {
    let path = std::env::args().nth(1).expect("用法: audio_probe <音频文件>");
    println!("[probe] 打开默认输出设备…");
    let sink = match DeviceSinkBuilder::open_default_sink() {
        Ok(s) => {
            println!("[probe] 设备已打开");
            s
        }
        Err(e) => {
            println!("[probe] 设备打开失败: {e}");
            return;
        }
    };

    let file = File::open(&path).expect("无法打开音频文件");
    let decoder = Decoder::new(BufReader::new(file)).expect("解码器初始化失败");
    let total = decoder.total_duration();
    println!("[probe] 解码器就绪，总时长: {total:?}");

    let player = Player::connect_new(sink.mixer());
    player.append(decoder);
    println!("[probe] is_paused={} empty={}", player.is_paused(), player.empty());

    let start = Instant::now();
    for i in 0..6 {
        std::thread::sleep(Duration::from_millis(1000));
        println!(
            "[probe] t={:.1}s pos={:.2}s empty={} paused={}",
            start.elapsed().as_secs_f32(),
            player.get_pos().as_secs_f64(),
            player.empty(),
            player.is_paused()
        );
        if i == 1 {
            player.play();
        }
    }
    player.stop();
    println!("[probe] 结束");
}
