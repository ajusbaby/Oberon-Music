// 设置：曲库统计 / 音乐文件夹 / 播放默认值 / 数据与关于
import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AudioDeviceInfo, ExclusiveDeviceCaps, OutputStatus, PlayMode } from "../api/types";
import {
  audioConcertHall,
  audioExclusiveOutput,
  audioExclusiveProbe,
  audioOutputDevices,
  audioOutputMode,
  audioOutputStatus,
  audioRetryOutput,
  audioSetConcertHall,
  audioSetExclusiveOutput,
  audioSetOutputDevice,
  audioSetOutputMode,
} from "../api/ipc";
import { Icon } from "../components/Icon";
import { useLibraryStore } from "../stores/libraryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { usePlayerStore } from "../stores/playerStore";
import { useUiStore, toast } from "../stores/uiStore";
import { pickAndAddMusicFolder } from "../lib/addMusic";
import {
  DEFAULT_SIZE,
  DEFAULT_WEIGHT,
  MATCH_POLICY_KEY,
  SIZE_RANGE,
  WEIGHT_OPTIONS,
  readMatchPolicy,
  readSize,
  readWeight,
} from "../lib/lyricFont";
import { LP_THEME_KEY, LP_THEME_OPTIONS, readLpTheme, useSystemDark } from "../lib/lowPower";


/** 歌词字号预设：值就是 --lyric-size 的倍数（1 = 设计稿的 24px） */
const SIZE_PRESETS: { label: string; value: number }[] = [
  { label: "小", value: 0.85 },
  { label: "标准", value: 1 },
  { label: "大", value: 1.2 },
  { label: "特大", value: 1.45 },
];

const MODES: { key: PlayMode; label: string }[] = [
  { key: "sequential", label: "顺序播放" },
  { key: "loop-all", label: "列表循环" },
  { key: "loop-one", label: "单曲循环" },
  { key: "shuffle", label: "随机播放" },
];

export function SettingsView() {
  const refreshStats = useLibraryStore((s) => s.refreshStats);
  const folders = useLibraryStore((s) => s.folders);
  const refreshFolders = useLibraryStore((s) => s.refreshFolders);
  const removeFolder = useLibraryStore((s) => s.removeFolder);
  const scan = useLibraryStore((s) => s.scan);
  const startScan = useLibraryStore((s) => s.startScan);
  const cancelScan = useLibraryStore((s) => s.cancelScan);
  const settings = useSettingsStore((s) => s.values);
  // 首页氛围背景开关（默认开启；关闭后组件完全卸载，0 开销）
  const ambientOn = settings["homeAmbient"] !== "off";
  const lowPower = settings["lowPower"] === "on";
  // 低功耗主题：只在低功耗模式下可调（用户要求"低功耗独占"），见 src/lib/lowPower.ts
  const lpTheme = readLpTheme(settings);
  const systemDark = useSystemDark();
  const setSetting = useSettingsStore((s) => s.set);
  const playerVolume = usePlayerStore((s) => s.state?.volume ?? 70);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setPlayMode = usePlayerStore((s) => s.setPlayMode);
  // 上一首行为开关（默认关闭）。⚠️ 白名单解码，与上面 homeAmbient 的黑名单刻意相反：
  // 本项默认关，缺键必须落到新默认「总是切上一首」，所以只能 === "on"。
  const prevRestart = settings["previousRestart"] === "on";
  const setPreviousRestart = usePlayerStore((s) => s.setPreviousRestart);
  const playerMode = usePlayerStore((s) => s.state?.playMode ?? "sequential");
  const openDialog = useUiStore((s) => s.openDialog);

  const [busy, setBusy] = useState(false);

  // 输出设备：空串 = 跟随系统默认设备。指定某台设备后，它在场时只用它；
  // 它不在场时不会改用系统默认（见引擎 try_recover_device 里的 allow_fallback）。
  // 版本号从运行时取（更新之后界面要显示新版本，不能写死）
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  // 应用内更新：检查 → 下载安装（带进度）→ 重启到新版本
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const checkUpdate = useCallback(async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateStatus("正在检查更新…");
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus("");
        toast("已是最新版本", "success");
        return;
      }
      setUpdateStatus("发现新版本 " + update.version + "，正在下载…");
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          got += event.data.chunkLength;
          if (total > 0) setUpdateStatus("正在下载 " + Math.round((got / total) * 100) + "%");
        } else if (event.event === "Finished") {
          setUpdateStatus("下载完成，正在安装…");
        }
      });
      setUpdateStatus("安装完成，正在重启…");
      await relaunch();
    } catch (e) {
      setUpdateStatus("");
      toast("检查更新失败：" + String(e), "error");
    } finally {
      setUpdateBusy(false);
    }
  }, [updateBusy]);

  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [outputId, setOutputId] = useState("");
  const refreshDevices = useCallback(async () => {
    try {
      const list = await audioOutputDevices();
      setDevices(list);
      setOutputId(list.find((d) => d.isSelected)?.id ?? "");
    } catch {
      /* 取不到设备列表就保持空下拉，不影响设置页其它功能 */
    }
  }, []);
  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);
  // 当前**实际生效**的输出后端：由引擎线程在每次打开输出时写入。
  // 走独占还是回退共享只有引擎知道，所以这里不做本地推断，只显示事实。
  const [outStatus, setOutStatus] = useState<OutputStatus | null>(null);
  const refreshOutStatus = useCallback(async () => {
    try {
      setOutStatus(await audioOutputStatus());
    } catch {
      /* 读不到就保持上一次的值（引擎尚未打开输出时 backend 默认就是 shared） */
    }
  }, []);
  useEffect(() => {
    void refreshOutStatus();
    // 输出是在播放时由引擎线程打开/回退的，轮询是唯一能反映它的方式；1.5s 足够且开销可忽略
    const timer = window.setInterval(() => void refreshOutStatus(), 1500);
    return () => window.clearInterval(timer);
  }, [refreshOutStatus]);
  // 重新协商：用户改完系统独占设置后不想重启 app 时的入口。
  // 引擎重开输出是异步的，所以等一小会儿再读状态，避免立刻读到旧结论。
  const [retryBusy, setRetryBusy] = useState(false);
  const retryOutput = useCallback(async () => {
    if (retryBusy) return;
    setRetryBusy(true);
    try {
      await audioRetryOutput();
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      await refreshOutStatus();
      toast("已重新协商输出后端", "success");
    } catch (e) {
      toast("重新协商失败：" + String(e), "error");
    } finally {
      setRetryBusy(false);
    }
  }, [retryBusy, refreshOutStatus]);
  // 输出后端状态要在 changeOutput 之前声明：它的依赖数组是渲染期求值的，
  // 写在后面会踩 TDZ（ReferenceError: Cannot access before initialization）。
  const changeOutput = useCallback(
    async (id: string) => {
      const prev = outputId;
      setOutputId(id); // 乐观更新：失败再回滚，避免下拉弹回
      try {
        await audioSetOutputDevice(id || null);
        await refreshDevices();
        // 换设备会触发引擎重开输出：独占能力是**每台设备各自**的，立刻读一次结果
        await refreshOutStatus();
        toast(id ? "已切换到所选输出设备" : "已改为跟随系统默认设备", "success");
      } catch (e) {
        setOutputId(prev);
        toast("切换输出设备失败：" + String(e), "error");
      }
    },
    [outputId, refreshDevices, refreshOutStatus]
  );

  // 独占输出：模式选择 + **现场探测**（不假设用户设备支持什么，问一遍驱动再说）
  // 默认输出模式 = 共享（与后端 state.rs / OutputMode::parse 的回落值一致）
  const [outMode, setOutMode] = useState("shared");
  const [caps, setCaps] = useState<ExclusiveDeviceCaps[]>([]);
  const [probeBusy, setProbeBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        setOutMode(await audioOutputMode());
      } catch {
        /* 读不到就保持 shared（默认） */
      }
    })();
  }, []);
  const changeMode = useCallback(
    async (mode: string) => {
      const prev = outMode;
      setOutMode(mode);
      try {
        await audioSetOutputMode(mode);
        // 切模式会触发引擎重开输出，立刻读一次真实结果（是否真的走成了独占）
        await refreshOutStatus();
        toast(
          mode === "exclusive"
            ? "已改为独占模式（设备不支持时自动回退共享）"
            : mode === "shared"
              ? "已改为共享模式"
              : "已改为自动模式",
          "success"
        );
      } catch (e) {
        setOutMode(prev);
        toast("切换输出模式失败：" + String(e), "error");
      }
    },
    [outMode, refreshOutStatus]
  );
  // 「空间音效」：挂在播放总线上的 Freeverb 混响（设置项 concertHall，默认关闭）。
  // 切换**不重开设备** —— 参数在音频线程里平滑过渡，正在播的歌不会被掐断。
  const [hall, setHall] = useState("off");
  useEffect(() => {
    void (async () => {
      try {
        setHall(await audioConcertHall());
      } catch {
        /* 读不到就保持 off（默认） */
      }
    })();
  }, []);
  const hallOn = hall === "on";
  const changeHall = useCallback(
    async (mode: string) => {
      const prev = hall;
      setHall(mode);
      try {
        await audioSetConcertHall(mode);
        toast(mode === "off" ? "已关闭空间音效" : "已开启空间音效", "success");
      } catch (e) {
        setHall(prev);
        toast("切换空间音效失败：" + String(e), "error");
      }
    },
    [hall]
  );
  const probeCaps = useCallback(async () => {
    setProbeBusy(true);
    try {
      setCaps(await audioExclusiveProbe());
    } catch (e) {
      toast("探测失败：" + String(e), "error");
    } finally {
      setProbeBusy(false);
    }
  }, []);

  // 独占的两个策略：音量落在哪、采样率听谁的。
  // 音量改了立刻生效（渲染线程里平滑过渡）；采样率改了要重开输出，所以顺带刷新一次状态。
  const [exVolume, setExVolume] = useState("software");
  const [exRate, setExRate] = useState("adaptive");
  useEffect(() => {
    void (async () => {
      try {
        const s = await audioExclusiveOutput();
        setExVolume(s.volume);
        setExRate(s.rate);
      } catch {
        /* 读不到就保持默认（软件音量 / 跟随曲目） */
      }
    })();
  }, []);
  const changeExclusive = useCallback(
    async (volume: string, rate: string) => {
      const prevVolume = exVolume;
      const prevRate = exRate;
      setExVolume(volume);
      setExRate(rate);
      try {
        await audioSetExclusiveOutput(volume, rate);
        await refreshOutStatus();
      } catch (e) {
        setExVolume(prevVolume);
        setExRate(prevRate);
        toast("设置独占参数失败：" + String(e), "error");
      }
    },
    [exVolume, exRate, refreshOutStatus]
  );

  // 歌词排版：字号 / 字重 / 纯汉字行的语言归属。
  // 字体本身不再可配置 —— 固定走系统字体（原因见 src/lib/lyricFont.ts 头部注释）。
  const lyricSize = readSize(settings);
  const lyricWeight = readWeight(settings);
  // 纯汉字行怎么归属：一致性优先（默认，一律按中文）/ 准确优先（跟随歌曲主语言）
  const matchPolicy = readMatchPolicy(settings);

  /** 写排版设置：立即落库（settingsStore.set → settings_set）。滑杆拖动时逐格写入，所以不弹提示 */
  const persistFont = async (key: string, value: string) => {
    try {
      await setSetting(key, value);
    } catch (e) {
      toast("保存失败：" + String(e), "error");
    }
  };

  useEffect(() => {
    void refreshFolders();
  }, [refreshStats, refreshFolders]);

  const scanning = scan != null && (scan.stage === "started" || scan.stage === "scanning");

  return (
    <div className="view-root">
      <div className="view-header">
        <div className="view-header-main">
          <div>
            <div className="view-title">设置</div>
            <div className="view-sub">曲库、播放与数据</div>
          </div>
        </div>
      </div>

      <div className="list-viewport">
        <div className="section-title">播放</div>
        <div className="settings-block">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">关闭窗口时继续播放</div>
              <div className="settings-hint">
                {settings["closeMinimize"] === "on"
                  ? "已开启：关闭窗口后收进系统托盘继续播放（托盘图标左键唤出窗口，右键菜单里有「退出 Oberon」）"
                  : "已关闭（默认）：关闭窗口即退出并停止播放"}
              </div>
            </div>
            <button
              type="button"
              className={"switch" + (settings["closeMinimize"] === "on" ? " on" : "")}
              aria-pressed={settings["closeMinimize"] === "on"}
              onClick={() => void setSetting("closeMinimize", settings["closeMinimize"] === "on" ? "off" : "on")}
            >
              <span className="switch-knob" />
            </button>
          </div>
        </div>
        <div className="section-title">输出设备</div>
        <div className="settings-block">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">播放输出设备</div>
              <div className="settings-hint">
                {outputId
                  ? "已指定设备：切换时立刻迁移播放并保持进度；该设备不在时不会改用系统默认设备"
                  : "跟随系统默认设备（推荐）：拔插耳机 / 切换蓝牙后自动跟着系统走"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "0 0 auto" }}>
              <select
                className="settings-select"
                value={outputId}
                onChange={(e) => void changeOutput(e.target.value)}
              >
                <option value="">跟随系统默认设备</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.isDefault ? "（系统默认）" : ""}
                  </option>
                ))}
              </select>
              <button className="pill-btn" onClick={() => void refreshDevices()}>
                刷新
              </button>
            </div>
          </div>
        </div>
        <div className="section-title">独占输出</div>
        <div className="settings-block">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">输出模式</div>
              <div className="settings-hint">
                默认共享（走系统混音器）；选「自动 / 独占」才会尝试绕过混音器做 bit-perfect，
                设备不支持时自动回退共享，并在下面说明原因
              </div>
            </div>
            <select
              className="settings-select"
              value={outMode}
              onChange={(e) => void changeMode(e.target.value)}
            >
              <option value="auto">自动（优先独占）</option>
              <option value="exclusive">独占（bit-perfect）</option>
              <option value="shared">共享（系统混音器）</option>
            </select>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">当前生效的后端</div>
              <div className="settings-hint">
                {!outStatus || !outStatus.opened
                  ? "尚未打开输出（播放一首之后显示）"
                  : outStatus.backend === "exclusive"
                    ? "独占模式" + (outStatus.format ? "：" + outStatus.format : "")
                    : "共享模式（系统混音器）"}
              </div>
              {outStatus?.fallback ? (
                <div className="settings-hint warn">回退原因：{outStatus.fallback}</div>
              ) : null}
              {outStatus?.session ? (
                // 只是会话建立时的快照：缓冲与健康度在故障时会被引擎刷新，
                // 「已送多少帧」这类计数不在这里显示（它会一直停在打开时的值，容易被当成卡住）
                <div className="settings-hint">
                  {"缓冲 " + outStatus.session.bufferMs.toFixed(1) + " ms · " + outStatus.session.health}
                </div>
              ) : null}
            </div>
            <button className="pill-btn" disabled={retryBusy} onClick={() => void retryOutput()}>
              {retryBusy ? "重试中…" : "重新尝试独占"}
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">采样率</div>
              <div className="settings-hint">
                {!outStatus || !outStatus.opened || !outStatus.outputRate
                  ? "尚未打开输出"
                  : !outStatus.sourceRate
                    ? "输出 " + outStatus.outputRate + " Hz（尚未装载曲目）"
                    : "解码 " +
                      outStatus.sourceRate +
                      " Hz → 输出 " +
                      outStatus.outputRate +
                      " Hz" +
                      (outStatus.resampling
                        ? "（多相 sinc 重采样）"
                        : "（直通，未重采样）")}
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">独占音量</div>
              <div className="settings-hint">
                {exVolume === "direct"
                  ? "满幅直通：数字域完全不衰减，音量交给功放旋钮（系统音量滑块和静音键仍有效）"
                  : "软件音量：在渲染线程里逐样本衰减，听感与共享模式一致"}
              </div>
            </div>
            <select
              className="settings-select"
              value={exVolume}
              onChange={(e) => void changeExclusive(e.target.value, exRate)}
            >
              <option value="software">软件音量</option>
              <option value="direct">满幅直通</option>
            </select>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">独占采样率</div>
              <div className="settings-hint">
                {exRate === "adaptive"
                  ? "跟随曲目：曲目是什么率就交给设备什么率，不重采样"
                  : "锁定 " + exRate + " Hz：设备不接受就直接回退共享，不会偷偷换成别的率"}
              </div>
            </div>
            <select
              className="settings-select"
              value={exRate}
              onChange={(e) => void changeExclusive(exVolume, e.target.value)}
            >
              <option value="adaptive">跟随曲目</option>
              <option value="44100">44.1 kHz</option>
              <option value="48000">48 kHz</option>
              <option value="88200">88.2 kHz</option>
              <option value="96000">96 kHz</option>
            </select>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">独占能力探测</div>
              <div className="settings-hint">
                现场问驱动：这台设备在独占模式下支持哪些采样率/位深，并真实初始化一次试试
              </div>
            </div>
            <button className="pill-btn" disabled={probeBusy} onClick={() => void probeCaps()}>
              {probeBusy ? "探测中…" : "探测我的设备"}
            </button>
          </div>
          {caps.map((c) => (
            <div className="settings-row" key={c.id}>
              <div className="settings-row-main">
                <div className="settings-label">
                  {c.name}
                  {c.isDefault ? "（系统默认）" : ""}
                </div>
                <div className="settings-hint">共享默认：{c.sharedFormat}</div>
                <div className="settings-hint">
                  独占支持 {c.exclusive.length} 项
                  {c.exclusive.length > 0 ? "：" + c.exclusive.join("、") : ""}
                </div>
                <div className="settings-hint">
                  {c.initOk
                    ? "实测可独占：" + c.initOk
                    : "实测没开起来" + (c.initHint ? "：" + c.initHint : "")}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="section-title">空间音效</div>
        <div className="settings-block">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">混响空间</div>
              <div className="settings-hint">
                {hallOn
                  ? "已开启：所有曲目共用一个声场，切歌不断尾巴"
                  : "已关闭（默认）：输出原始信号"}
              </div>
            </div>
            <button
              type="button"
              className={"switch" + (hallOn ? " on" : "")}
              aria-pressed={hallOn}
              onClick={() => void changeHall(hallOn ? "off" : "on")}
            >
              <span className="switch-knob" />
            </button>
          </div>
        </div>
        <div className="section-title">音乐文件夹</div>
        <div className="settings-block">
          {folders.length === 0 ? (
            <div className="settings-row">
              <div className="settings-row-main">
                <div className="settings-label">尚未添加文件夹</div>
                <div className="settings-hint">添加本地音乐目录后会自动扫描并建立索引</div>
              </div>
            </div>
          ) : (
            folders.map((folder) => (
              <div className="folder-strip" key={folder.id}>
                <span className="folder-strip-icon">
                  <Icon name="folder" size={17} />
                </span>
                <span className="folder-strip-path" title={folder.path}>
                  {folder.path.replace(/^\\\\\?\\/, "")}
                </span>
                <span className="folder-strip-meta">
                  {folder.lastScannedMs
                    ? "上次扫描 " + new Date(folder.lastScannedMs).toLocaleString()
                    : "尚未扫描"}
                </span>
                <button
                  className="pill-btn danger"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void (async () => {
                      await removeFolder(folder.path);
                      await refreshStats();
                      setBusy(false);
                    })();
                  }}
                >
                  移除
                </button>
              </div>
            ))
          )}
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">扫描</div>
              <div className="settings-hint">
                {scanning
                  ? "正在扫描：" +
                    (scan?.scannedFiles ?? 0) +
                    " 个文件" +
                    (scan?.totalFiles ? " / " + scan.totalFiles : "") +
                    (scan?.currentPath ? " · " + scan.currentPath : "")
                  : "扫描会读取音频标签、提取内嵌封面并更新索引"}
              </div>
            </div>
            <button className="pill-btn" onClick={() => void pickAndAddMusicFolder()}>
              <Icon name="plus" />
              添加文件夹
            </button>
            {scanning ? (
              <button className="pill-btn danger" onClick={() => void cancelScan()}>
                取消扫描
              </button>
            ) : (
              <button
                className="pill-btn primary"
                disabled={folders.length === 0}
                onClick={() => {
                  void (async () => {
                    await startScan();
                    toast("已开始扫描音乐库", "success");
                  })();
                }}
              >
                <Icon name="refresh" />
                立即扫描
              </button>
            )}
          </div>
        </div>

        <div className="section-title">播放</div>
        <div className="settings-block">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">默认音量</div>
              <div className="settings-hint">启动时应用的音量（当前 {playerVolume}）</div>
            </div>
            <input
              type="range"
              className="volume-slider"
              min={0}
              max={100}
              value={playerVolume}
              onChange={(e) => {
                const value = Number(e.target.value);
                void setVolume(value);
              }}
              onPointerUp={() => void setSetting("volume", String(playerVolume))}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">播放模式</div>
              <div className="settings-hint">当前：{MODES.find((m) => m.key === playerMode)?.label}</div>
            </div>
            <div className="chip-row" style={{ marginBottom: 0 }}>
              {MODES.map((mode) => (
                <button
                  key={mode.key}
                  className={"chip" + (playerMode === mode.key ? " active" : "")}
                  onClick={() => {
                    void setPlayMode(mode.key);
                    void setSetting("playMode", mode.key);
                  }}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">上一首回到本曲开头</div>
              <div className="settings-hint">
                {prevRestart
                  ? "已开启：播放超过 3 秒时回到本曲开头，不足 3 秒切上一首"
                  : "已关闭（默认）：总是切到上一首"}
              </div>
            </div>
            <button
              type="button"
              className={"switch" + (prevRestart ? " on" : "")}
              aria-pressed={prevRestart}
              onClick={() => {
                const next = !prevRestart;
                // 双写：前者让引擎立即生效并落库，后者同步前端设置缓存（同 playMode 范式）
                void setPreviousRestart(next);
                void setSetting("previousRestart", next ? "on" : "off");
              }}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">首页氛围背景</div>
              <div className="settings-hint">播放时首页的流动光雾（WebGL，暂停即停帧）</div>
            </div>
            <button
              type="button"
              className={"switch" + (ambientOn ? " on" : "")}
              aria-pressed={ambientOn}
              onClick={() => void setSetting("homeAmbient", ambientOn ? "off" : "on")}
            >
              <span className="switch-knob" />
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">低功耗模式</div>
              <div className="settings-hint">
                {lowPower
                  ? "已开启：关闭首页光雾，歌词页改用静态背景、去掉毛玻璃与逐行模糊，动画降到 30fps"
                  : "已关闭（默认）：完整视觉效果"}
              </div>
            </div>
            <button
              type="button"
              className={"switch" + (lowPower ? " on" : "")}
              aria-pressed={lowPower}
              onClick={() => void setSetting("lowPower", lowPower ? "off" : "on")}
            >
              <span className="switch-knob" />
            </button>
          </div>

          {/* 低功耗主题：**只有低功耗模式开着才能调**（关闭时按钮置灰并给出原因） */}
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">
                低功耗主题
                {!lowPower && <span className="settings-badge">需先开启低功耗</span>}
              </div>
              <div className="settings-hint">
                {!lowPower
                  ? "只在低功耗模式下可用：开启后可切换白天 / 夜间"
                  : lpTheme === "system"
                    ? "跟随系统（当前系统是" + (systemDark ? "深色" : "浅色") + "）"
                    : lpTheme === "dark"
                      ? "夜间：整个应用深色"
                      : "白天：整个应用浅色"}
              </div>
            </div>
            <div className="chip-row">
              {LP_THEME_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  disabled={!lowPower}
                  className={"chip" + (lpTheme === o.value ? " active" : "")}
                  onClick={() => void setSetting(LP_THEME_KEY, o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

        </div>


        <div className="section-title">歌词排版</div>
        <div className="settings-block">
          <div className="lf-row">
            <div className="lf-label">大小</div>
            <input
              type="range"
              className="lf-range"
              min={Math.round(SIZE_RANGE[0] * 100)}
              max={Math.round(SIZE_RANGE[1] * 100)}
              value={Math.round(lyricSize * 100)}
              onChange={(e) => void persistFont("lyricFontSize", String(Number(e.target.value) / 100))}
              aria-label="歌词字号"
            />
            <span className="lf-value">{Math.round(lyricSize * 100)}%</span>
            <button
              className="lf-icon-btn"
              aria-label="恢复默认字号"
              disabled={lyricSize === DEFAULT_SIZE}
              onClick={() => void persistFont("lyricFontSize", String(DEFAULT_SIZE))}
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div className="lf-row">
            <div className="lf-label">预设</div>
            <div className="lf-options">
              {SIZE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={"chip lf-chip" + (Math.abs(lyricSize - p.value) < 0.005 ? " active" : "")}
                  onClick={() => void persistFont("lyricFontSize", String(p.value))}
                >
                  {p.label}
                </button>
              ))}
              <span className="lf-hint">歌词页字号 = 24px × 这个倍数（{Math.round(lyricSize * 100)}%）</span>
            </div>
          </div>
          <div className="lf-row">
            <div className="lf-label">语言匹配</div>
            <div className="lf-options">
              {(["consistent", "accurate"] as const).map((p) => (
                <button
                  key={p}
                  className={"chip lf-chip" + (matchPolicy === p ? " active" : "")}
                  onClick={() => void persistFont(MATCH_POLICY_KEY, p)}
                >
                  {p === "consistent" ? "一致性优先" : "准确优先"}
                </button>
              ))}
              <span className="lf-hint">纯汉字歌词行（没有假名 / 谚文可判）按哪种语言挑字体</span>
            </div>
          </div>
          <div className="lf-row">
            <div className="lf-label">粗细</div>
            <div className="lf-options">
              {WEIGHT_OPTIONS.map((w) => (
                <button
                  key={w.value}
                  className={"chip lf-chip" + (lyricWeight === w.value ? " active" : "")}
                  onClick={() => void persistFont("lyricFontWeight", String(w.value))}
                >
                  <span style={{ fontWeight: w.value }}>{w.label}</span>
                </button>
              ))}
              <button
                className="lf-icon-btn"
                aria-label="恢复默认粗细"
                disabled={lyricWeight === DEFAULT_WEIGHT}
                onClick={() => void persistFont("lyricFontWeight", String(DEFAULT_WEIGHT))}
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>
        </div>

        <div className="section-title">数据与关于</div>
        <div className="settings-block">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">数据库</div>
              <div className="settings-hint">
                %APPDATA%\com.localmusicplayer.desktop\library.db3（SQLite · WAL）
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">封面缓存</div>
              <div className="settings-hint">
                %APPDATA%\com.localmusicplayer.desktop\cover_cache\
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">已保存的设置项</div>
              <div className="settings-hint">
                {Object.keys(settings).length === 0
                  ? "暂无"
                  : Object.entries(settings)
                      .map(([k, v]) => k + "=" + v)
                      .join(" · ")}
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-label">版本</div>
              <div className="settings-hint">
                {updateStatus ||
                  "Oberon " + (appVersion || "…") + " · Tauri 2 + React 18"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "0 0 auto" }}>
              <button
                className="pill-btn"
                disabled={updateBusy}
                onClick={() => void checkUpdate()}
              >
                {updateBusy ? "正在更新…" : "检查更新"}
              </button>
              <button
                className="pill-btn"
                onClick={() =>
                  openDialog({
                    kind: "confirm",
                    title: "关于",
                    message:
                      "Oberon " +
                      (appVersion || "") +
                      "：Rust 播放内核（rodio/symphonia）+ SQLite 曲库 + React 界面。",
                    confirmText: "好的",
                    onConfirm: () => undefined,
                  })
                }
              >
                关于
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}