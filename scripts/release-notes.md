## 本次更新（0.3.0）

### DSD 解码内核重写：1-bit 查表，快 11.5 倍

DSD 的输入只有 ±1，所以「乘一个抽头」其实只是「加或减」。这次把连续的 8 个 bit 当成一个字节索引，
预先算好该组对应抽头的贡献，一次查表顶 8 次乘加：

- **32 张相位表 × 256 项 = 32 KB**，正好压在现代 CPU 的 L1 缓存里；
- **直接在原始字节上计算**，不再把 1-bit 展开成 f32 再滤波 —— 窗口取 `[g-256, g-1]` 后正好落在字节边界上，
  一个 chunk 就是一个原始字节，**查表不需要任何位拼接**；
- 每个输出从 **256 次乘加**降到 **32 次查表 + 32 次加法**（配 4 路累加器打破加法延迟链）。

实测（真机、真文件：276 秒 / 186 MB 的 .dsf，单线程解码整条）：

| | 解码耗时 (CPU) | 相对实时 |
| --- | --- | --- |
| 旧（256 抽头标量 FIR） | 6.28 s | 44× |
| **新（1-bit 查表）** | **0.55 s** | **505×** |
| 参考：FFmpeg 9.0.1 | 1.52 s | — |

即 **11.5 倍**提速；相对 FFmpeg 从「多用 3.7 倍 CPU」变成「**少用约 3 倍 CPU**」。
摊到播放里：276 秒的 DSD 全程只花 0.5 秒 CPU（单核约 0.18%，原来约 2%）。

（顺带说明：FFmpeg 的 `dsd2pcm` 用的也是同一套 8-bit 查表；它先用 96 抽头滤波器出 352.8 kHz，
再重采样到 88.2 kHz。我们是 256 抽头一步到 88.2 kHz，滤波器更长、却少了一整级重采样，所以反超。）

正确性：新内核与保留的标量参照实现逐样本对比，合成文件与真文件的最大差都是 **4.8e-7**
（纯 f32 求和顺序的舍入），没有任何位序 / 相位 / ±1 映射错误。

### 新增：解码性能基准工具

可以拿自己的文件跟 FFmpeg 对拍，不再靠感觉：

    # 我们的内核（应用真正使用的那条链路）
    cargo run --release --example codec_bench -- "<文件>" 5
    # 一条命令对拍（需要系统里有 ffmpeg）
    powershell -File scripts/codec-bench.ps1 -Files "<文件1>","<文件2>" -Repeats 5

口径：整条文件解成 PCM、单线程、取最快一次；同时报墙钟与**进程 CPU 时间**（与 ffmpeg 的 `utime+stime` 同口径）。

本机实测（CPU 时间，越小越好）：

| 格式 | Oberon | FFmpeg | 谁更省 |
| --- | --- | --- | --- |
| DSD (.dsf) | 0.50 s | 1.48 s | **Oberon 省 3 倍** |
| Opus (.opus) | 0.77 s | 0.91 s | Oberon 略省 |
| AAC (.aac) | 0.39 s | 0.48 s | Oberon 略省 |
| MP3 | 0.31 s | 0.45 s | Oberon 省 1.5 倍 |
| FLAC | 0.37 s | 0.66 s | Oberon 省 1.8 倍 |

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
| .dsf / .dff | DSD | 自研：1-bit 查表低通 + 整数抽取转 PCM |

**暂不支持**：APE、WavPack、TAK、Musepack(MPC)、WMA(ASF)、Speex、RealAudio，以及 CUE 整轨分轨。

### 输出说明

- **共享模式**：所有音源按输出设备的格式做采样率 / 声道转换。
- **独占模式**：优先按曲目采样率协商，争取 bit-perfect；设备不支持时自动回退共享并在设置页说明原因。
- DSD 的原生直出（DoP）需要 DAC 支持 176.4kHz 独占，属于后续版本。

### 安装 / 更新

- **全新安装**：下载下方的 Oberon_0.3.0_x64-setup.exe
- **已装旧版**：应用内「设置 → 关于 → 检查更新」即可自动更新
