## 本次更新（0.2.8）

### 新支持的格式

- **DSD（.dsf / .dff）** —— DSD64 / DSD128 / DSD256… 直接可播。采用「软解成 PCM」方案
  （Blackman 窗 sinc 低通 + 整数抽取，DSD64 → 88.2 kHz），**任何 DAC 都能放**，不需要独占模式。
- **Opus（.opus）** —— symphonia 至今不支持 Opus（0.5 与 0.6 的编解码器列表里都没有），
  改用纯 Rust 的 opus-pure 自行接入解码。
- **裸 AAC / ADTS（.aac）** —— symphonia 没有 ADTS 解封装，自写帧解析后复用它的 AAC 解码器。

### 支持的格式一览

| 扩展名 | 编码 / 容器 | 解码器 |
| --- | --- | --- |
| .mp3 | MPEG 音频（MP3） | symphonia |
| .flac | FLAC | symphonia |
| .wav | PCM / ADPCM（RIFF） | symphonia |
| .aiff | PCM（AIFF） | symphonia |
| .caf | PCM（CAF） | symphonia |
| .ogg / .oga | Ogg 容器内的 Vorbis | symphonia |
| .m4a / .m4b | MP4 容器内的 AAC 或 ALAC | symphonia |
| .opus | Ogg Opus | opus-pure（自行接入） |
| .aac | 裸 AAC / ADTS 流 | 自写 ADTS 解封装 + symphonia 的 AAC 解码器 |
| .dsf / .dff | DSD | 自研：低通 + 整数抽取转 PCM |

**暂不支持**：APE、WavPack、TAK、Musepack(MPC)、WMA(ASF)、Speex、RealAudio，以及 CUE 整轨分轨。

**输出说明**：所有音源都会按输出设备的格式做采样率 / 声道转换（WASAPI **共享模式**），
**不做 bit-perfect**；DSD 的原生直出（DoP）也需要独占模式，属于后续版本。

### 本次修复

- **DSD 快进卡死** —— 之前 seek 会退回「重开解码器 + 逐样本排水」，186MB 的 .dsf 相当于
  上千亿次乘加，直接把引擎线程堵死；现在实现原地定位（重开容器 + 按整块跳过，不做解码）。
- **DSD 内嵌歌词不显示** —— lofty 完全不支持 .dsf/.dff，歌词此前只能走同名 .lrc；
  现在内嵌歌词改走 id3（读 USLT 帧）。
- **短曲预排后界面不再推进** —— 时长小于预排提前量（12 秒）的曲目，换源判定永远不成立，
  导致界面停在上一首、后续队列也停止推进。
- 裸 AAC 的总时长更准确（不再依赖码率估算，改为逐帧头累加）。
- **切歌后下一首变速/变调** —— Opus / 裸 AAC / DSD 这三个自接解码器没实现 current_span_len，
  混音器于是只在最开始算一次采样率转换比：DSD(88.2kHz) 之后接 44.1kHz 的曲子会以
  **2 倍速**播放（听起来就是「声音奇怪且加速」）。现在每个块边界都会重新计算转换比。


### 安装 / 更新

- **全新安装**：下载下方的 Oberon_0.2.8_x64-setup.exe
- **已装旧版**：应用内「设置 → 关于 → 检查更新」即可自动更新
