# Oberon

Oberon —— 基于 Tauri 2 的 Windows 本地音乐播放器：React + TypeScript 前端（严格按《样式设计.html》实现磨砂玻璃 UI），
Rust 播放内核（symphonia 解码 / rodio + cpal 输出 / SQLite 曲库 / 目录监听增量扫描）。

## 目录结构

```
D:\LocalMusicPlayer
├─ src/                      # 前端（React + TS）
│  ├─ api/                   #   类型化 IPC 客户端
│  │  ├─ types.ts            #     数据类型契约（与 models.rs 对齐）
│  │  ├─ ipc.ts              #     全部命令封装（invoke）
│  │  └─ events.ts           #     事件订阅封装
│  ├─ stores/                #   Zustand：player / library / playlist / nav / ui / search / selection / settings
│  ├─ components/            #   Sidebar TopBar PlayerBar Coverflow TrackList AlbumGrid DialogLayer Icon Cover Toasts
│  ├─ views/                 #   Home Library Album Artist Playlist Search Settings
│  ├─ lib/                   #   格式化 / 封面缓存 / 收藏 / 选目录加歌
│  ├─ styles/                #   design.css（设计稿 CSS 原样抽取）+ views.css（视图补充样式）
│  └─ App.tsx                #   应用外壳（布局、初始化、快捷键、扫描横幅、弹层）
├─ src-tauri/                # Rust 后端
│  ├─ src/
│  │  ├─ main.rs / lib.rs    #   入口与命令注册
│  │  ├─ engine/             #   播放引擎（线程/队列/状态机/事件）
│  │  │  └─ audio.rs         #   解码与输出辅助（重解码 seek）
│  │  ├─ db.rs               #   SQLite 数据层（WAL + 迁移 + 查询）
│  │  ├─ scanner.rs          #   扫描器（walkdir + rayon + lofty + 封面）
│  │  ├─ watcher.rs          #   目录监听（notify，防抖增量扫描）
│  │  ├─ smtc.rs             #   系统媒体控制（媒体键 / 蓝牙耳机 / 锁屏 / 媒体面板）
│  │  ├─ commands/           #   IPC 命令：scan/library/playlist/player/settings
│  │  ├─ models.rs           #   IPC 数据类型
│  │  ├─ error.rs            #   统一错误码
│  │  └─ state.rs            #   全局状态
│  ├─ examples/audio_probe.rs#   音频输出探针（诊断：设备能否真实推进播放）
│  ├─ examples/audio_endpoints.rs # 端点拓扑诊断（端点 id / DEVICE_STATE / cpal 视角，支持 --watch）
│  ├─ tauri.conf.json        #   窗口 1267×902 无边框透明、NSIS 打包等
│  └─ capabilities/          #   最小权限（core/dialog）
├─ docs/接口文档.md          # ★ IPC 接口文档（命令/事件/类型/错误码 + 前端接入与验证）
├─ Oberon技术文档.md # 技术设计文档（需求来源）
├─ 样式设计.html             # UI 设计稿（磨砂玻璃风，界面以此为准）
├─ scripts/
│  ├─ gen-icons.mjs          #   图标生成器：由 logo/ 下的逐尺寸 ico 合成全套应用图标
│  ├─ ui-shot.mjs            #   界面截图/驱动（WebView2 CDP）
│  ├─ ui-smoke.mjs           #   界面端到端冒烟断言
│  └─ ui-verify.mjs          #   设计稿一致性比对（计算样式 + 类名骨架）
│  └─ release.ps1            #   带更新签名的打包：出安装包 + .nsis.zip + .sig + latest.json
└─ 磨砂玻璃风音乐播放器界面.png
```

## 环境要求

- Windows 10/11 + WebView2（系统一般自带）；
- Rust 工具链（MSVC target）`rustup default stable-x86_64-pc-windows-msvc`；
- VS 2022 Build Tools（C++ 桌面开发工作负载，供 rusqlite bundled 编译 SQLite）；
- Node.js 18+（建议 20/22/24）。

## 开发

```bash
npm install
npm run tauri:dev              # 启动 Vite (1420) + Rust 应用
npm run build                  # tsc --noEmit + vite build（前端产物）
cd src-tauri && cargo check    # Rust 静态检查
cargo test --lib               # 数据层与引擎单测
cargo build --features custom-protocol   # 构建内嵌 dist 的可执行文件
```

界面验证（需要 WebView2 远程调试端口）：

```bash
# 1) 临时在 src-tauri/tauri.conf.json 的窗口配置中加入：
#    "additionalBrowserArgs": "--remote-debugging-port=9333"
#    然后 cargo build --features custom-protocol 并运行 exe
node scripts/ui-smoke.mjs            # 界面端到端冒烟（89 项断言）
node scripts/ui-verify.mjs --states  # 设计稿一致性比对（样式 + 结构）
node scripts/ui-shot.mjs --file steps.json   # 自定义步骤截图
```

## 数据位置

- 数据库：`%APPDATA%/com.localmusicplayer.desktop/library.db3`（WAL 模式）；
- 封面缓存：同目录 `cover_cache/`；
- 设置键：`volume`（0-100）、`playMode`（sequential/loop-all/loop-one/shuffle）、`favorites`（收藏 id 数组）。

## 内核能力

**播放（Rust + rodio / Symphonia + cpal / WASAPI）**

- [x] 独立引擎线程 + 命令队列：播放 / 暂停 / 停止 / 上一首 / 下一首 / 跳转 / 音量 / 四种播放模式；
- [x] **无缝连播（gapless）**：曲末前预解码下一首并追加到**同一个**播放队列 ⇒ 曲间无空隙、不重新初始化音频设备；
- [x] 输出采样率统一：每个音源在追加时按设备采样率做转换，切歌不重开硬件、无系统层 SRC；
- [x] 跳转走**原地定位**（毫秒级，不重解码排水）；容器不支持时才回退到重解码；
- [x] 自然结束自动推进：顺序停止 / 单曲循环 / 列表循环 / 随机（随机为稳定洗牌序列）；
- [x] 音量、播放模式、「上一首回到本曲开头」（3 秒阈值）等设置项落库，重启保留；
- [x] 退出时记住曲目与播放位置，下次启动恢复为**暂停态**（不出声）；
- [x] **坏文件自动跳过**：单曲解码失败不再停在暂停，自动继续找下一首能播的（连续多首合并成一条提示）；
- [x] **输出设备看门狗（含端点跟随）**：输出流失效（rodio 错误回调，兜底用「位置停滞 3 秒」）时立刻记住位置并暂停，然后**按端点 id 等原来那台设备回来**再继续播放。之所以不能只开「系统默认设备」：拔掉耳机后系统会把默认切到另一台常驻 ACTIVE 的端点（本机实测是显示器的 HDMI 音频），接到它上面能打开、不报错、进度照走，却永远没有声音。原设备 8 秒内没回来才改为跟随系统默认设备。

**曲库**

- [x] 多根目录扫描、并行元数据提取（rayon）、封面提取与 400px 缩略图缓存、差集删除、可取消；
- [x] **真·增量扫描**：按（路径, 修改时间, 字节数）跳过未变文件 —— 目录监听触发的重扫不再重读整库标签；
- [x] 封面缓存按**内容哈希**寻址（同一份封面只存一份）+ 扫描收尾自动回收孤儿文件；
- [x] 目录监听（notify）+ 防抖 1.5s / 节流 3s 的增量扫描；
- [x] SQLite：tracks / folders / playlists / playlist_tracks / settings（WAL、外键、参数化）。

**接口与系统集成**

- [x] IPC 命令 + 事件（播放状态 / 进度 / 错误 / 扫描 / 曲库变更），进度事件按 ~800ms 节流；
- [x] 系统托盘：关窗可选「收进托盘继续播放」，托盘菜单可唤出窗口与**真正退出**；
- [x] **SMTC 系统媒体控制**：键盘媒体键、蓝牙耳机按键、锁屏界面、Windows 11 媒体面板均可控制播放，并显示标题 / 艺术家 / 专辑 / 封面 / 进度条（支持从系统面板拖动进度）；
- [x] **输出设备选择**：设置页可选「跟随系统默认设备」或锁定某一台设备（切换时迁移播放、保持进度；锁定的设备不在场时不会改用系统默认）；
- [x] **应用内更新**：设置页「版本」一行有「检查更新」，检查 → 下载（带进度）→ 安装 → 自动重启（tauri-plugin-updater，NSIS passive 安装）。

**可复现的性能数据**（实测：Ryzen 7 9700X / NVMe SSD / 125% 缩放）

- [x] 导入 270 个真实文件（8.3 GB 无损）**1.36 s**（200 文件/秒，并行 15×）⇒ 外推 10000 首约 **2 分钟**；
- [x] 解码吞吐 **1228~1337× 实时**；每 10ms 音频块的 p99 ≤0.073ms、max ≤0.29ms（0 块超 10ms）；
- [x] seek 三级回退：**270/270** 个文件走格式级定位，单次 p50 **6.06ms**、max **23.95ms**；
- [x] 基准工具随仓库提供：`src-tauri/examples/{decode_bench,scan_bench,seek_bench}.rs`。

## 发布与更新

应用内更新用 Tauri 官方 updater：客户端拉取 `releases/latest/download/latest.json`，
比对版本后下载签名过的 `.nsis.zip` 并安装（NSIS passive），最后重启到新版本。

```bash
npm run release                    # = tauri build + 签名 + 生成 latest.json
# 产物在 src-tauri/target/release/bundle/nsis/
```

**⚠️ 两条硬要求**

1. **签名私钥**：`bundle.createUpdaterArtifacts = true` 之后，Tauri 强制要求更新签名私钥，
   直接 `npm run tauri:build` 会因为缺密钥而失败 —— 请用 `npm run release`。
   私钥默认在 `.build/oberon-updater.key`（已 gitignore）；**丢了就再也无法给老版本发更新**，
   泄漏则任何人都能签出你的客户端会安装的包。请离线备份、不要提交。
2. **发 Release 时要传 3 个文件**：`*-setup.exe`（既供手动安装，也是应用内更新的载荷）、
   `*-setup.exe.sig`（签名）、`latest.json`（清单，endpoint 就指向它）。
   tag 用 `v<version>`（与脚本生成的下载 URL 一致）。
   Tauri v2 签的就是 NSIS 安装包本身（没有 v1 时代的 `.nsis.zip`），更新器下载它并带 `/UPDATER` 执行。

换版本号要同时改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 三处。

## 路线图

- WASAPI 独占模式输出（bit-perfect，自动采样率匹配）；
- 任务栏缩略图工具栏、跳转列表；
- FTS5 全文搜索、按新增时间流；
- 移除根目录时级联清理该目录下的曲目（当前 `scan_remove_music_folder` 只注销目录，不删除已索引记录）。

