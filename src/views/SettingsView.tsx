// 设置：曲库统计 / 音乐文件夹 / 播放默认值 / 数据与关于
import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AudioDeviceInfo, ExclusiveDeviceCaps, OutputStatus, PlayMode } from "../api/types";
import {
  audioExclusiveProbe,
  audioOutputDevices,
  audioOutputMode,
  audioOutputStatus,
  audioRetryOutput,
  audioSetOutputDevice,
  audioSetOutputMode,
  fontDelete,
} from "../api/ipc";
import { Icon } from "../components/Icon";
import { useLibraryStore } from "../stores/libraryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { usePlayerStore } from "../stores/playerStore";
import { useUiStore, toast } from "../stores/uiStore";
import { pickAndAddMusicFolder } from "../lib/addMusic";
import {
  BUILTIN_FONTS,
  DEFAULT_SIZE,
  DEFAULT_WEIGHT,
  GLYPH_POLICY_KEY,
  SIZE_RANGE,
  SLOTS,
  SYSTEM_FONT,
  WEIGHT_OPTIONS,
  customFamily,
  fileId,
  listFontFiles,
  loadCoverage,
  lyricFontStacks,
  readGlyphPolicy,
  readSize,
  readSlotFonts,
  readWeight,
  sampleCoverage,
  setFontSetting,
  slotKey,
  uploadFont,
} from "../lib/lyricFont";
import type { Coverage } from "../lib/fontCoverage";
import type { FontChoice, FontSlot } from "../lib/lyricFont";
import { LP_THEME_KEY, LP_THEME_OPTIONS, readLpTheme, useSystemDark } from "../lib/lowPower";
import type { CSSProperties } from "react";

/** 样张体检小标：这个字体能不能渲染本槽的样字 */
function CoverHint({
  slot,
  id,
  coverage,
}: {
  slot: FontSlot;
  id: string;
  coverage: Record<string, Coverage | null>;
}) {
  if (!id || id === SYSTEM_FONT) return null;
  const cov = coverage[id];
  if (cov === undefined) return null;
  const s = sampleCoverage(slot, cov);
  if (!s) return <span className="lf-cover">覆盖未检测</span>;
  if (s.missing.length === 0) return <span className="lf-cover ok">样字全覆盖</span>;
  return (
    <span className="lf-cover bad" title={"缺字：" + s.missing.join(" ")}>
      缺 {s.missing.length}/{s.total}：{s.missing.slice(0, 6).join("")}
    </span>
  );
}

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
  const [fontBusy, setFontBusy] = useState(false);

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
  const [outMode, setOutMode] = useState("auto");
  const [caps, setCaps] = useState<ExclusiveDeviceCaps[]>([]);
  const [probeBusy, setProbeBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        setOutMode(await audioOutputMode());
      } catch {
        /* 读不到就保持 auto */
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

  // 歌词字体：按语言分槽（西文 / 中文 / 日文 / 韩文），一个语言一个字体。
  // 上传的字体**不做语言检测** —— 它在每一个槽的候选里都出现，由用户决定给哪个语言用。
  const lyricFonts = readSlotFonts(settings);
  const lyricSize = readSize(settings);
  const lyricWeight = readWeight(settings);
  // 预览用的字体栈（设置页没有"整首歌"的概念，主语言传 null：每行只按自己的槽取）
  const fontStacks = lyricFontStacks(settings, null);
  // 缺字策略 + 各槽字体的覆盖表（样张体检：这个字体到底认不认得这些字）
  const glyphPolicy = readGlyphPolicy(settings);
  const [coverage, setCoverage] = useState<Record<string, Coverage | null>>({});
  useEffect(() => {
    let alive = true;
    void loadCoverage(settings).then((m) => {
      if (alive) setCoverage(m);
    });
    return () => {
      alive = false;
    };
  }, [settings]);
  const [fontFiles, setFontFiles] = useState<string[]>([]);
  // 自动保存状态：每次改动立即写库（settingsStore.set → settings_set），并给出可见反馈
  const [fontSave, setFontSave] = useState<"idle" | "saving" | "saved">("idle");
  const fontInputRef = useRef<HTMLInputElement | null>(null);
  const fontSlotRef = useRef<FontSlot>("latin");

  useEffect(() => {
    void listFontFiles().then(setFontFiles);
  }, [fontBusy]);

  /** 该槽当前选中的字体若是上传的，返回其文件名；内置字体 / 跟随主语言都返回 null（不可删） */
  const delTarget = (slot: FontSlot): string | null => {
    const id = lyricFonts[slot] ?? "";
    return fontFiles.find((f) => fileId(f) === id) ?? null;
  };

  /** 删除某个槽正在使用的自定义字体（同一语言上传多个时只删这一个，槽位回到「跟随歌曲主语言」） */
  const deleteSlotFont = async (slot: FontSlot) => {
    const file = delTarget(slot);
    if (file) await deleteFontFile(file);
  };
  /** 删除一个上传字体：先清掉引用它的槽位（否则槽位会指向不存在的字体），再删文件并刷新列表 */
  const deleteFontFile = async (file: string) => {
    setFontBusy(true);
    try {
      const id = fileId(file);
      for (const sl of SLOTS) {
        if ((lyricFonts[sl.id] ?? "") === id) await setFontSetting(slotKey(sl.id), "");
      }
      await fontDelete(file);
      setFontFiles(await listFontFiles());
    } finally {
      setFontBusy(false);
    }
  };
  /** 每个语言槽共用的候选：内置字体 + 全部上传字体（不做语言检测过滤，由用户决定给谁用） */
  const fontChoices: FontChoice[] = [
    ...BUILTIN_FONTS,
    ...fontFiles.map((f) => ({
      id: fileId(f),
      label: f.replace(/\.[^.]+$/, ""),
      family: '"' + customFamily(f) + '"',
      desc: "上传的字体 · " + f,
    })),
  ];

  /** 写字体设置：立即落库（重启后仍在）并显示保存状态 */
  const persistFont = async (key: string, value: string) => {
    setFontSave("saving");
    try {
      await setFontSetting(key, value);
      setFontSave("saved");
    } catch (e) {
      setFontSave("idle");
      toast("保存失败：" + String(e), "error");
    }
  };

  /** 手动保存：把当前设置再写一遍（自动保存已生效，这里给一个明确的落库动作） */
  const saveAllFonts = async () => {
    setFontSave("saving");
    try {
      for (const s of SLOTS) await setFontSetting(slotKey(s.id), lyricFonts[s.id]);
      await setFontSetting("lyricFontSize", String(lyricSize));
      await setFontSetting("lyricFontWeight", String(lyricWeight));
      setFontSave("saved");
      toast("字体设置已保存，重启后仍然生效", "success");
    } catch (e) {
      setFontSave("idle");
      toast("保存失败：" + String(e), "error");
    }
  };

  const pickFontFile = (slot: FontSlot) => {
    fontSlotRef.current = slot;
    fontInputRef.current?.click();
  };

  const onPickFontFile = async (file: File | undefined) => {
    if (!file) return;
    const slot = fontSlotRef.current;
    setFontBusy(true);
    try {
      const name = await uploadFont(file);
      await persistFont(slotKey(slot), fileId(name));
      setFontFiles(await listFontFiles());
      toast("已应用字体：" + name, "success");
    } catch (e) {
      toast("字体导入失败：" + String(e), "error");
    } finally {
      setFontBusy(false);
      if (fontInputRef.current) fontInputRef.current.value = "";
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
                独占模式绕过系统混音器（bit-perfect）；设备不支持时自动回退共享，并在下面说明原因
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
            </div>
            <button className="pill-btn" disabled={retryBusy} onClick={() => void retryOutput()}>
              {retryBusy ? "重试中…" : "重新尝试独占"}
            </button>
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
                  title={lowPower ? undefined : "先在上一行开启低功耗模式"}
                  onClick={() => void setSetting(LP_THEME_KEY, o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

        </div>

        <input
          ref={fontInputRef}
          type="file"
          accept=".ttf,.otf,.ttc,.woff,.woff2"
          style={{ display: "none" }}
          onChange={(e) => void onPickFontFile(e.target.files?.[0])}
        />

        <div className="section-title">歌词字体</div>
        {/* 每个语言槽的字体栈变量设在这一层：下面的行内样字与预览块都直接引用 var(--lf-<slot>) */}
        <div
          className="settings-block"
          style={
            {
              "--lyric-font": fontStacks.primary,
              "--lf-latin": fontStacks.bySlot.latin,
              "--lf-zh": fontStacks.bySlot.zh,
              "--lf-ja": fontStacks.bySlot.ja,
              "--lf-ko": fontStacks.bySlot.ko,
              "--lyric-size": String(lyricSize),
              "--lyric-weight": String(lyricWeight),
            } as CSSProperties
          }
        >
          {SLOTS.map((s) => (
            <div className="lf-row" key={s.id}>
              <div className="lf-label">{s.label}</div>
              <select
                className="lf-select"
                title={s.hint}
                value={lyricFonts[s.id]}
                onChange={(e) => void persistFont(slotKey(s.id), e.target.value)}
              >
                <option value="">跟随歌曲主语言</option>
                {fontChoices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              {/* 就地样字直接用**这个槽真实的字体栈**：选了一个没有该语言字形的字体，
                  这里会当场落到系统正体，而不是等你打开歌词页才发现（"选了却看不见结果"） */}
              <span
                className="lf-sample lf-slot-sample"
                lang={s.lang}
                style={{ fontFamily: "var(--lf-" + s.id + ")" }}
              >
                {s.sample}
              </span>
              {/* 样张体检：拿着字体文件的 cmap 数一遍——放错字体（比如日文字体放进中文栏）
                  在这里就能看到"缺了几个字"，而不是等去歌词页发现一行里两种字体 */}
              <CoverHint slot={s.id} id={lyricFonts[s.id]} coverage={coverage} />
              <button
                className="lf-icon-btn"
                title={"上传" + s.label + "字体"}
                onClick={() => pickFontFile(s.id)}
              >
                <Icon name="plus" />
              </button>
                {/* 删除**这个槽正在使用**的自定义字体：同一语言上传了多个时，只删这一个 */}
                <button
                  type="button"
                  className="lf-icon-btn lf-del"
                  title={delTarget(s.id) ? "删除该槽正在使用的字体：" + delTarget(s.id) : "该槽未使用自定义字体"}
                  disabled={!delTarget(s.id)}
                  onClick={() => void deleteSlotFont(s.id)}
                >
                  <Icon name="trash" />
                </button>
            </div>
          ))}

          <div className="lf-row">
            <div className="lf-label">缺字时</div>
            <div className="lf-options">
              {(["fallback", "line"] as const).map((p) => (
                <button
                  key={p}
                  className={"chip lf-chip" + (glyphPolicy === p ? " active" : "")}
                  title={
                    p === "fallback"
                      ? "缺的字用系统正体补上：尽量每个字都用你选的字体，代价是一行里可能出现两种字体"
                      : "只要这一行有缺字，整行都改用系统正体：一行只有一个声音，代价是这一行用不上你选的字体"
                  }
                  onClick={() => void persistFont(GLYPH_POLICY_KEY, p)}
                >
                  {p === "fallback" ? "逐字替换" : "整行回退"}
                </button>
              ))}
              <span className="lf-hint">字体缺字时怎么处理（覆盖未检测的字体不受影响）</span>
            </div>
          </div>

          <div className="lf-row">
            <div className="lf-label">字号</div>
            <input
              type="range"
              className="lf-range"
              min={Math.round(SIZE_RANGE[0] * 100)}
              max={Math.round(SIZE_RANGE[1] * 100)}
              value={Math.round(lyricSize * 100)}
              onChange={(e) => void persistFont("lyricFontSize", String(Number(e.target.value) / 100))}
            />
            <span className="lf-value">{Math.round(lyricSize * 100)}%</span>
            <button
              className="lf-icon-btn"
              title="恢复默认字号"
              disabled={lyricSize === DEFAULT_SIZE}
              onClick={() => void persistFont("lyricFontSize", String(DEFAULT_SIZE))}
            >
              <Icon name="refresh" />
            </button>
          </div>

          <div className="lf-row">
            <div className="lf-label">粗细</div>
            <div className="lf-options">
              {WEIGHT_OPTIONS.map((w) => (
                <button
                  key={w.value}
                  className={"chip lf-chip" + (lyricWeight === w.value ? " active" : "")}
                  title={"font-weight: " + w.value}
                  onClick={() => void persistFont("lyricFontWeight", String(w.value))}
                >
                  <span className="lf-sample" style={{ fontWeight: w.value }}>
                    {w.label}
                  </span>
                </button>
              ))}
              <button
                className="lf-icon-btn"
                title="恢复默认粗细"
                disabled={lyricWeight === DEFAULT_WEIGHT}
                onClick={() => void persistFont("lyricFontWeight", String(DEFAULT_WEIGHT))}
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>

          <div className="lf-preview-block">
            <div className="lf-row lf-row-head">
              <div className="lf-label">预览</div>
              <div className="lf-hint">
                每种语言各用自己那一栏的字体；汉字归哪一栏由"这一行的语言"决定（中文栏不会去渲染日文歌词里的汉字）；
                留空的栏目跟随歌曲主语言，缺字按上面的「缺字时」处理
              </div>
            </div>
            <div className="lf-preview">
              {SLOTS.map((s) => (
                <p
                  key={s.id}
                  className="lp-line"
                  lang={s.lang}
                  style={{ fontFamily: "var(--lf-" + s.id + ")" }}
                >
                  {s.sample}
                </p>
              ))}
            </div>
          </div>

          {/* 块尾操作行：状态靠左、动作靠右。
              位置从「粗细」和「预览」中间挪到这里 —— 那里是设置项网格，多出一行空标签的
              操作行看着像是漏填了一项设置。
              另注：每一项改动本来就会立即落库（见 persistFont），这个按钮只是给一个
              明确的「再存一次」动作，用于确认落库或补救某次写入失败。 */}
          <div className="lf-footer">
            <div className="lf-hint">
              {fontSave === "saving"
                ? "正在保存…"
                : fontSave === "saved"
                  ? "改动已保存，完全退出后下次打开仍然生效"
                  : "改动会立即写入设置"}
            </div>
            <button
              className="pill-btn lf-save"
              onClick={() => void saveAllFonts()}
              disabled={fontSave === "saving"}
            >
              <Icon name="check" />
              保存字体设置
            </button>
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