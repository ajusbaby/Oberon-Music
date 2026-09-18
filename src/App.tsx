// 应用外壳 —— 与「样式设计.html」的 .app-shell 结构一一对应
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { PlayerBar } from "./components/PlayerBar";
import { DialogLayer } from "./components/DialogLayer";
import { LyricsPage } from "./components/LyricsPage";
import { HomeAmbient } from "./components/HomeAmbient";
import { SplashScreen, hasSeenSplash, SPLASH_REPLAY_EVENT } from "./components/SplashScreen";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { FavoritesView } from "./views/FavoritesView";
import { AlbumView } from "./views/AlbumView";
import { ArtistView } from "./views/ArtistView";
import { PlaylistView } from "./views/PlaylistView";
import { SearchView } from "./views/SearchView";
import { SettingsView } from "./views/SettingsView";
import { useNavStore } from "./stores/navStore";
import { useUiStore, toast } from "./stores/uiStore";
import { useLibraryStore, initLibraryEvents } from "./stores/libraryStore";
import { usePlayerStore, initPlayerEvents } from "./stores/playerStore";
import { useSettingsStore } from "./stores/settingsStore";
import { playerEvents } from "./api/events";
import { LP_THEME_KEY, lpIsDark, parseLpTheme, useSystemDark } from "./lib/lowPower";
import { setWinFocused } from "./lib/winFocus";
import { playerPause, playerRestore } from "./api/ipc";
import { loadCoverage } from "./lib/lyricFont";

const appWindow = getCurrentWindow();

function ScanBanner() {
  const scan = useLibraryStore((s) => s.scan);
  // 扫描结束后再留 1.5s 的「完成帧」：done 事件一到就卸载横幅的话，用户连 100% 都看不到
  //（旧实现就是这样，配合"分子只在入库阶段涨"= 全程 0%）。
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    if (scan?.stage !== "done") {
      setShowDone(false);
      return;
    }
    setShowDone(true);
    const timer = window.setTimeout(() => setShowDone(false), 1500);
    return () => window.clearTimeout(timer);
  }, [scan]);
  const scanning = scan?.stage === "started" || scan?.stage === "scanning";
  if (!scan || (!scanning && !(scan.stage === "done" && showDone))) return null;
  const done = scan.stage === "done";
  const percent = done
    ? 100
    : scan.totalFiles && scan.totalFiles > 0
      ? Math.min(100, Math.round((scan.scannedFiles / scan.totalFiles) * 100))
      : null;
  return (
    <div className="scan-banner">
      {!done && <span className="spinner" />}
      <span className="scan-text">
        {done ? "扫描完成：" : scan.stage === "started" ? "正在准备扫描…" : "正在扫描："}
        {scan.scannedFiles > 0 ? " 已处理 " + scan.scannedFiles + " 个文件" : ""}
        {scan.totalFiles ? " / " + scan.totalFiles : ""}
        {scan.currentPath ? " · " + scan.currentPath : ""}
      </span>
      {percent != null && (
        <div className="scan-track">
          <div className="scan-fill" style={{ width: percent + "%" }} />
        </div>
      )}
    </div>
  );
}

function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={"toast" + (t.kind === "error" ? " error" : "")}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

function CurrentView() {
  const view = useNavStore((s) => s.view);
  switch (view.name) {
    case "home":
      return <HomeView />;
    case "search":
      return <SearchView />;
    case "library":
      return <LibraryView />;
    case "favorites":
      return <FavoritesView />;
    case "album":
      return <AlbumView />;
    case "artist":
      return <ArtistView />;
    case "playlist":
      return <PlaylistView />;
    case "settings":
      return <SettingsView />;
    default:
      return <HomeView />;
  }
}

export default function App() {
  const [maximized, setMaximized] = useState(false);
  const lyricsOpen = useUiStore((s) => s.lyricsOpen);

  // 开屏：首次运行停在开屏页等用户点「开始使用」，之后启动由 SplashScreen 自己进入。
  // 开屏期间 App 照常初始化（设置 / 曲库 / 播放器事件），那几秒正好用来盖住加载。
  const [splashOpen, setSplashOpen] = useState(true);
  const [splashWaitForUser, setSplashWaitForUser] = useState(() => !hasSeenSplash());

  /**
   * 窗口是否聚焦。失焦时把所有「装饰性无限动画」暂停（见 views.css 的 win-blur 规则）
   * —— 没人看的时候，没必要继续按刷新率产帧（CSS 无限动画由合成器按刷新率驱动，
   * 完全绕过 lib/frameBudget.ts 的帧预算）。
   */
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const apply = (v: boolean) => {
      setFocused(v);
      setWinFocused(v); // 同步给 JS 逐帧循环（见 lib/winFocus.ts 的说明）
    };
    apply(document.hasFocus());
    const onFocus = () => apply(true);
    const onBlur = () => apply(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // 初始化：设置 / 曲库 / 播放状态 + 事件订阅
  useEffect(() => {
    // 恢复上次完全退出时的曲目与位置：后端装载为暂停态（不会开屏出声），再确认一次暂停
    void useSettingsStore
      .getState()
      .refresh()
      .then(() => {
        const v = useSettingsStore.getState().values;
        const id = Number(v["lastTrackId"] ?? "");
        const pos = Number(v["lastPosition"] ?? "");
        if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(pos) || pos < 5) return;
        void playerRestore(id, pos)
          .then(() => playerPause())
          .catch(() => {});
      });
    void useLibraryStore.getState().refreshStats();
    void useLibraryStore.getState().refreshFolders();
    void usePlayerStore.getState().refresh();

    // 预热「字体覆盖检查」（读字体文件 + 解析 cmap）：这是首次进设置页最重的一次性开销，
    // 挪到启动后的空闲时间做 —— 用户点进设置页时就不用等这一下。
    // 应用是常驻根组件、不会卸载，所以不额外做取消。
    const warmCoverage = () => {
      void loadCoverage(useSettingsStore.getState().values);
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(warmCoverage, { timeout: 4000 });
    } else {
      window.setTimeout(warmCoverage, 2500);
    }

    void initPlayerEvents();
    void initLibraryEvents();
    void playerEvents.onError((payload) => {
      toast(payload.message || payload.code, "error");
    });
  }, []);

  // 设置页「重放」：重新挂载开屏，并且这一次按「首次运行」对待（露出按钮）
  useEffect(() => {
    const onReplay = () => {
      setSplashWaitForUser(true);
      setSplashOpen(true);
    };
    window.addEventListener(SPLASH_REPLAY_EVENT, onReplay);
    return () => window.removeEventListener(SPLASH_REPLAY_EVENT, onReplay);
  }, []);

  // 窗口最大化状态 → 外壳取消圆角；顺带在拖拽期间给 <html> 挂 .resizing
  // （让 CSS 暂时收起重合成，见 design.css「拖拽窗口边框期间的合成降级」）。
  // 旧写法每个 resize 事件都打两次 IPC 查最大化状态 —— 拖拽时每帧都在和渲染抢
  // 主线程，是背景闪烁的放大器。现在改成尺寸稳定后再查一次。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let settle = 0;
    let resizeIdle = 0;
    void (async () => {
      try {
        setMaximized((await appWindow.isMaximized()) || (await appWindow.isFullscreen()));
        unlisten = await appWindow.onResized(() => {
          const root = document.documentElement;
          root.classList.add("resizing");
          window.clearTimeout(resizeIdle);
          resizeIdle = window.setTimeout(() => root.classList.remove("resizing"), 180);

          window.clearTimeout(settle);
          settle = window.setTimeout(() => {
            void Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]).then(([m, f]) => setMaximized(m || f));
          }, 140);
        });
      } catch {
        /* 非 Tauri 环境下忽略 */
      }
    })();
    return () => {
      unlisten?.();
      window.clearTimeout(settle);
      window.clearTimeout(resizeIdle);
      document.documentElement.classList.remove("resizing");
    };
  }, []);

  // 全局快捷键（输入框内不响应）：空格 播放/暂停，←/→ 上一首/下一首，Esc 关弹层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
      if (typing) return;
      if (e.code === "Space") {
        e.preventDefault();
        void usePlayerStore.getState().toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        void usePlayerStore.getState().previous();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        void usePlayerStore.getState().next();
      } else if (e.key === "Escape") {
        useUiStore.getState().closeDialog();
        useUiStore.getState().closeQueue();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 氛围背景所需状态：仅在首页显示；开关默认开启；种子取当前专辑（没有则用固定串）
  const view = useNavStore((s) => s.view);
  const playing = usePlayerStore((s) => s.state?.status === "playing");
  const ambientOn = useSettingsStore((s) => s.values["homeAmbient"] !== "off");
  const libStats = useLibraryStore((s) => s.stats);
  // 低功耗模式：关掉首页光雾 + 歌词页大面积模糊/混合 + 常驻提升层（见 views.css 的 .low-power 段）
  const lowPower = useSettingsStore((s) => s.values["lowPower"] === "on");
  // 低功耗主题（跟随系统 / 白天 / 夜间）：**低功耗独占** —— 只有 lowPower 开着才可能挂 .theme-dark，
  // 于是默认那套浅色主题完全不受影响（见 views.css 的「低功耗 × 夜间主题」段）
  const lpTheme = useSettingsStore((s) => s.values[LP_THEME_KEY]);
  const systemDark = useSystemDark();
  const darkShell = lowPower && lpIsDark(parseLpTheme(lpTheme), systemDark);
  const ambientSeed = usePlayerStore((s) => s.state?.current?.album || s.state?.current?.title || "oberon");
  const ambientTrackId = usePlayerStore((s) => s.state?.current?.trackId ?? null);

  return (
    <div
      className={
        "app-shell" +
        (maximized ? " maximized" : "") +
        (playing ? " playing" : "") +
        (lowPower ? " low-power" : "") +
        (darkShell ? " theme-dark" : "") +
        (focused ? "" : " win-blur")
      }
    >
      {/* 首页氛围背景：z-index:-1 落在外壳底色之上、所有内容之下，由半透明毛玻璃"霜化" */}
      {/* 空库不渲染光雾：没有音乐时它只是一层与内容无关的彩色雾（旧实现按 "oberon" 哈希出紫色）。
            有音乐但还没播放时，光雾会用低饱和兜底色板（见 HomeAmbient.seedPalette）。 */}
      <HomeAmbient
        active={view.name === "home" && ambientOn && !lowPower && (libStats?.trackCount ?? 0) > 0}
        /* 歌词页打开即**冻结**（而不是卸载）：最后一帧画面留着，所以不会出现
           "光雾先消失、进场动画才出来"的观感；同时不再产帧 —— 它上方侧栏/播放条的
           毛玻璃也就不必逐帧重算，省下的正是进场峰值里那 3 个点。 */
        paused={lyricsOpen}
        playing={playing}
        seed={ambientSeed}
        trackId={ambientTrackId}
      />
      <div className="app-body">
        <Sidebar />
        <main className="main-content">
          <TopBar maximized={maximized} />
          <ScanBanner />
          <CurrentView />
        </main>
      </div>
      <PlayerBar />
      <LyricsPage />
      <DialogLayer />
      <Toasts />
      {/* 开屏挂在外壳内部：这样自动被外壳的圆角 + overflow:hidden 裁成窗口形状 */}
      {splashOpen && (
        <SplashScreen
          waitForUser={splashWaitForUser}
          lowPower={lowPower}
          onDone={() => setSplashOpen(false)}
        />
      )}
    </div>
  );
}
