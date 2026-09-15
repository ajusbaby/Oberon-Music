// 沉浸式歌词页 —— 结构、尺寸与《歌词页设计.html》一致；歌词来自内核（同名 .lrc 优先，其次内嵌标签）
import type { CSSProperties } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/ipc";
import type { LyricsResult } from "../api/types";
import { Icon } from "./Icon";
import { PlayerBar } from "./PlayerBar";
import { useCover } from "../lib/cover";
import { frameBudget } from "../lib/frameBudget";
import { isWinFocused } from "../lib/winFocus";
import { usePlayerStore } from "../stores/playerStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  SYSTEM_FONT,
  detectLineSlots,
  detectSongSlot,
  ensureFontFaces,
  fontStackFor,
  lineHasMissing,
  loadCoverage,
  lyricFontStacks,
  readGlyphPolicy,
  readSize,
  readSlotFont,
  readSlotFonts,
  readWeight,
  slotLang,
} from "../lib/lyricFont";
import type { Coverage } from "../lib/fontCoverage";
import { useUiStore, toast } from "../stores/uiStore";


/** 鼠标静止多久后进入沉浸模式（与设计稿一致：3s） */
const IMMERSIVE_DELAY = 3000;

/**
 * 歌词流转速度（像素/秒）——**限速匀速跟随**：
 * 每帧朝目标匀速推进（速度恒定 = 线性），接近目标时按比例减速软着陆。
 * 相比"每句重新计时的补间"：不会因为快歌频繁换行而反复重启（那会导致一冲一顿），
 * 也不会像指数缓动那样前段猛冲、后段拖尾。
 */
const LYRIC_FLOW_SPEED = 150;
/** 软着陆距离（像素）：进入该范围后按比例降速，避免硬停 */
const LYRIC_FLOW_EASE = 14;
/** 大幅跳转（拖进度条/点击跳句）的追赶时长（秒）：起步时按此锁定速度，保证限时走完 */
const LYRIC_CATCHUP_SECS = 0.36;
/** 超过该距离视为"大幅度跳转"（普通换行只有一行高，约 50~90px） */
const LYRIC_CATCHUP_FROM = 400;
/** 单帧最大步进时间（毫秒）：窗口卡顿/后台恢复后不至于瞬移 */
const FLOW_DT_MAX = 48;
/** 滚轮回位时长（毫秒） */
const WHEEL_RETURN_MS = 520;

/* ===== 圆形扩散 =====
   ⚠️ 试过"用 rAF 按 30fps 步进写 clip-path 来省重画"：写值次数从 ~49 降到 29、
   进场尖峰 22% → 19%，但**肉眼能看出卡顿**（步进间隔 22~50ms），性价比不划算，已回退。
   现在：过渡交给 CSS（60fps，手感与最早一致），收益靠"只在一个元素上裁剪"来拿。 */
/* ---------- 进场：深色圆盘绽开（低占用做法） ----------
   原来的做法是在全窗元素上动画 clip-path: circle()：裁剪形状每变一次，浏览器就要按新圆把
   里面的内容**重新光栅化一遍** —— 一次采样一次整窗重画，这就是进场尖峰的来源。
   现在改成"预先画好的实心大圆 + transform: scale()"：
     · 圆盘是一张位图（布局只有 640px，见 DISC_BASE），放大只是合成器换个矩阵贴上去；
     · 内容不参与缩放（只做 opacity / translateY），所以文字全程清晰；
     · 圆盘的边缘与暖光光环在放大过程里留在画面内，观感是"从点击点绽开"。
   历史上的两个 bug 也一并消失：暗底与面板天然同步（圆盘就在它们下面），
   不会再有"先黑一下"或"圆角处露一线白"。 */
/** 开场圆盘只绽开到这么大（不负责盖满 —— 盖满交给整窗 opacity 淡入的 .lyrics-veil）。
    关键在于**别让缩放倍数太大**：scale 越大，浏览器"按最大动画比例栅格化"出来的纹理越大
    （实测 5.2× 会得到约 3300² 的巨纹理，反而比不做动画更贵）。1.45× 时纹理约 930px 级。 */
const DISC_BLOOM = 1.45;

export function LyricsPage() {
  const open = useUiStore((s) => s.lyricsOpen);
  const closeLyrics = useUiStore((s) => s.closeLyrics);
  const origin = useUiStore((s) => s.lyricsOrigin);
  const player = usePlayerStore((s) => s.state);
  const seek = usePlayerStore((s) => s.seek);
  const settingsValues = useSettingsStore((s) => s.values);
  const lowPower = settingsValues["lowPower"] === "on";
  // 歌词字体：按语言分槽（西文 / 中文 / 日文 / 韩文），每行按脚本引用对应的字体栈。
  // 槽位里选了什么 → 行上 var(--lf-<slot>) → 该槽的完整字体栈（规则见 src/lib/lyricFont.ts）。
  const lyricFontSlots = {
    latin: readSlotFont(settingsValues, "latin"),
    zh: readSlotFont(settingsValues, "zh"),
    ja: readSlotFont(settingsValues, "ja"),
    ko: readSlotFont(settingsValues, "ko"),
  };
  const lyricFontSize = readSize(settingsValues);
  const lyricFontWeight = readWeight(settingsValues);

  const current = player?.current ?? null;
  const status = player?.status ?? "stopped";
  const cover = useCover(current?.trackId ?? null);
  /**
   * 歌词页背景只需要"一团颜色"，不需要细节。
   * 原来 .bg 是「400px 缩略图 + filter: blur(37.8px)」—— 全窗大半径模糊 + 一张
   * 1.13×窗口（约 2.3MP）的大纹理。现在把封面降到 40px 再用 cover 拉伸铺满：
   * 放大本身就是模糊，视觉几乎一致，但没有大半径模糊、源纹理只有 40px。
   * （saturate/brightness 仍交给 CSS，避免两处各算一遍导致观感漂移。）
   */
  const [tinyCover, setTinyCover] = useState<string | null>(null);
  useEffect(() => {
    if (!cover) {
      setTinyCover(null);
      return;
    }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      try {
        // 长边 120px（保持宽高比），并**在画布上做等比预模糊**：
        // 小图会被 background-size:cover 拉伸到 .bg 的宽度，所以 .bg 上的 37.8px
        // 等价于小图坐标里的 37.8 × 120 / .bg宽度。这样得到的模糊核与原来完全一致，
        // 实测与旧实现（整张 400px 图 + blur(37.8px)）的像素差 mean≈1.9~2.6/255、max≈15。
        const N = 120;
        const ar = img.naturalWidth / Math.max(1, img.naturalHeight);
        const w = ar >= 1 ? N : Math.max(2, Math.round(N * ar));
        const h = ar >= 1 ? Math.max(2, Math.round(N / ar)) : N;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        if (!g) return;
        // .bg 是 inset:-8%，比面板宽 16%
        const bgW = Math.max(200, (panelRef.current?.clientWidth ?? 1300) * 1.16);
        g.filter = "blur(" + (37.8 * N / bgW).toFixed(2) + "px)";
        g.drawImage(img, 0, 0, w, h);
        setTinyCover(c.toDataURL("image/jpeg", 0.82));
      } catch {
        /* 取不到就继续用原图（退化为原来的行为，只慢一点点） */
      }
    };
    img.src = cover;
    return () => {
      alive = false;
    };
  }, [cover]);

  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [immersive, setImmersive] = useState(false);
  // 进出场动画：只动 opacity / transform（合成层属性），保证 60fps
  const [phase, setPhase] = useState<"in" | "out" | null>(null);
  const [mounted, setMounted] = useState(false);
  const [staged, setStaged] = useState(false);
  const everOpened = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 圆形扩散的几何：圆心取点击处（播放条封面）中心，半径从封面半径扩到盖住整窗
  const geo = useMemo(() => {
    const w = typeof window === "undefined" ? 1267 : window.innerWidth;
    const h = typeof window === "undefined" ? 902 : window.innerHeight;
    const cx = origin ? origin.x + origin.w / 2 : w / 2;
    const cy = origin ? origin.y + origin.h / 2 : h / 2;
    const r0 = origin ? Math.max(origin.w, origin.h) / 2 : 36;
    const dx = Math.max(cx, w - cx);
    const dy = Math.max(cy, h - cy);
    return { cx, cy, r0, rMax: Math.sqrt(dx * dx + dy * dy) + 30, w, h };
  }, [origin]);
  // 滚轮浏览时取消渐进模糊（用户手动翻看时全部清晰）
  const [blurOff, setBlurOff] = useState(false);
  // 沉浸清屏：只留歌词（再点右上角或按 Esc 退出）
  const [cleared, setCleared] = useState(false);
  // 歌词页布局：默认「左封面 + 右歌词」；右上角按钮切到「无封面 + 歌词居中」。
  // 只做本地状态（不进设置库）：符合"默认沿用现在的样式"，重启后回到默认。
  const [layout, setLayout] = useState<"poster" | "center">("poster");
  // 默认模式下切换要有一段过场；低功耗下直接换（用户要求"低功耗不要动效"）
  const [layoutSwitching, setLayoutSwitching] = useState(false);
  const switchTimer = useRef<number | null>(null);

  const pageRef = useRef<HTMLDivElement | null>(null);
  /** 面板背后的暗底：它的 clip-path 始终跟面板一致（见下面的展开/退场动画） */
  const scrimRef = useRef<HTMLDivElement | null>(null);
  /** 全窗深色底（只做 opacity 淡入 —— 最便宜的合成层动画，与低功耗同一类） */
  const veilRef = useRef<HTMLDivElement | null>(null);
  const lyricsBoxRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);

  const duration = current?.durationSecs ?? 0;
  const position = current?.positionSecs ?? 0;
  const percent = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
  const volume = player?.volume ?? 70;


  // 歌词加载：曲目变化时重新读取
  useEffect(() => {
    if (!open) return;
    const trackId = current?.trackId;
    if (trackId == null) {
      setLyrics(null);
      return;
    }
    let alive = true;
    setLoading(true);
    void api
      .trackLyrics(trackId)
      .then((res) => {
        if (alive) setLyrics(res);
      })
      .catch((e) => {
        if (alive) {
          setLyrics(null);
          toast("读取歌词失败：" + String(e), "error");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, current?.trackId]);

  // 沉浸模式：鼠标/键盘静止 3s 后隐藏上下控件（与设计稿一致）
  useEffect(() => {
    if (!open) return;
    const reset = () => {
      setImmersive(false);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setImmersive(true), IMMERSIVE_DELAY);
    };
    reset();
    window.addEventListener("mousemove", reset);
    window.addEventListener("mousedown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      window.removeEventListener("mousemove", reset);
      window.removeEventListener("mousedown", reset);
      window.removeEventListener("keydown", reset);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [open]);

  // Esc 返回
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
      // 沉浸清屏时先退出沉浸，再按一次才关闭歌词页
      setCleared((v) => {
        if (v) return false;
        closeLyrics();
        return v;
      });
    }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeLyrics]);

  // 展开/收起的状态与计时
  useEffect(() => {
    if (open) {
      everOpened.current = true;
      setMounted(true);
      setPhase("in");
      // ⚠️ 必须**立即**进入 staged。.staged 的入场动画带 `both` 填充，动画真正开始前会维持
      // 元素的自然状态（也就是完全可见）；原先延迟 130ms 才加这个类，于是前 130ms 歌词是
      // 亮着的，一加类就被动画拉到 `from`（opacity:0 + 下移 20px）再淡回来 —— 用户看到的
      // "打开歌词页歌词闪一下"（低功耗白底黑字下对比最强）。分层错峰交给 CSS 自带的
      // animation-delay（topbar 120ms / lyrics-area 240ms / footer 340ms），JS 不需要再延后。
      setStaged(true);
      const unstageTimer = window.setTimeout(() => setStaged(false), 1400);
      const phaseTimer = window.setTimeout(() => setPhase(null), 900);
      return () => {
        window.clearTimeout(unstageTimer);
        window.clearTimeout(phaseTimer);
      };
    }
    if (!everOpened.current) return;
    setPhase("out");
    setStaged(false);
    // 低功耗：收起同样不做圆形收缩（与进场同因：clip-path 动画每帧重画整窗），改成一次淡出
    if (lowPower) {
      // 同进场：淡根元素（含遮罩），否则面板淡出时会露出整块遮罩 = 闪一下
      const root = pageRef.current;
      if (root) {
        root.style.transition = "opacity 150ms ease";
        root.style.opacity = "0";
      }
      const t = window.setTimeout(() => {
        setPhase(null);
        setMounted(false);
      }, 170);
      return () => window.clearTimeout(t);
    }
    // 退场：内容先快速淡出，暗底与圆盘再收回（都是合成层操作，不重画内容）
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    const veil = veilRef.current;
    if (panel) {
      panel.style.transition = "opacity 130ms ease";
      panel.style.opacity = "0";
    }
    if (veil) {
      veil.style.transition = "opacity 220ms ease";
      veil.style.opacity = "0";
    }
    if (scrim) {
      scrim.style.transition = "transform 260ms ease";
      scrim.style.setProperty("--disc-scale", "0");
    }
    const timer = window.setTimeout(() => {
      setPhase(null);
      setMounted(false); // 退场动画播完再卸载
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, geo, lowPower]);

  // 展开动画：面板从点击处圆形扩散 + 封面小圆飞到中央溶解。
  // 用 useLayoutEffect：在浏览器首次绘制之前就设好初始裁剪并启动过渡，
  // 这样「挂载 + 布局 + 首绘」的耗时不会让动画晚起步（否则会先卡住再动）。
  useLayoutEffect(() => {
    if (!mounted || !open) return;
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    // 低功耗：**不做圆形裁剪扩散**。clip-path 动画是"每帧按新圆裁剪整窗并重画"，
    // 进场那 820ms 会把 GPU 从 5% 顶到 16%（实测）；这里换成纯 opacity 淡入 ——
    // 透明度动画是合成层操作，内容只栅格化一次，之后每帧只是整体混合，代价接近 0。
    if (lowPower) {
      // ⚠️ 必须淡**根元素**（.lyrics-page）而不是面板：面板下面是 .lyrics-scrim 那块
      // 全窗不透明遮罩，只淡面板的话它会先整块露出来 —— 就是"返回时闪一下"。
      // 淡根元素 = 遮罩+面板一起淡，中间过程是真正的交叉淡出，不会闪。
      if (scrim) {
        // 低功耗：圆盘不参与，暗底由 .lyrics-veil 直接铺满（views.css 会给它 #FFFFFF / #131316）
        scrim.style.transition = "none";
        scrim.style.clipPath = "";
        scrim.style.opacity = "";
        scrim.style.setProperty("--disc-scale", "0");
      }
      const veil0 = veilRef.current;
      if (veil0) {
        veil0.style.transition = "none";
        veil0.style.opacity = "1";
      }
      if (panel) {
        panel.style.clipPath = "";
        panel.style.transition = "";
        panel.style.opacity = "";
      }
      const root = pageRef.current;
      if (root) {
        root.style.clipPath = ""; // 清掉默认模式残留的圆形裁剪
        root.style.transition = "opacity 200ms ease";
        root.style.opacity = "0";
        void root.offsetWidth; // 强制重排，让下面的 opacity 走过渡
        root.style.opacity = "1";
      }
      return;
    }
    // 默认模式：复位低功耗可能留下的内联样式，并把"点击点"与"盖满倍数"交给 CSS
    const root = pageRef.current;
    if (root) {
      root.style.transition = "";
      root.style.opacity = "";
      root.style.clipPath = "";
      root.style.setProperty("--ox", geo.cx + "px");
      root.style.setProperty("--oy", geo.cy + "px");
    }
    const veil = veilRef.current;
    if (panel) {
      // 面板内容只淡入（合成层操作；不做 scale，文字才不会在动画期间发虚）
      panel.style.transition = "opacity 420ms cubic-bezier(.4,0,.2,1)";
      panel.style.clipPath = "";
      panel.style.opacity = "0";
    }
    if (veil) {
      veil.style.transition = "none";
      veil.style.opacity = "0";
    }
    if (scrim) {
      scrim.style.transition = "none";
      scrim.style.clipPath = "";
      scrim.style.opacity = "";
      scrim.style.setProperty("--disc-scale", "0");
    }
    void scrim?.offsetWidth; // 强制重排，让下面的过渡生效
    if (veil) {
      veil.style.transition = "opacity 560ms cubic-bezier(.4,0,.2,1)";
      veil.style.opacity = "1";
    }
    if (scrim) {
      scrim.style.transition = "transform 700ms cubic-bezier(.4,0,.2,1)";
      scrim.style.setProperty("--disc-scale", String(DISC_BLOOM));
    }
    if (panel) {
      void panel.offsetWidth;
      panel.style.opacity = "1";
    }
    // 按需求：入场时页面中间不再出现歌曲封面（飞行圆点已移除），
    // 只保留「从点击处圆形扩散 + 内容分层入场」。
  }, [mounted, open, geo, lowPower]);

  // 同一时间戳的行归为一组（英文歌常见：原文一行 + 翻译一行共用时间戳）
  const groups = useMemo(() => {
    const out: number[][] = [];
    const lines = lyrics?.lines ?? [];
    for (let i = 0; i < lines.length; i++) {
      const last = out[out.length - 1];
      if (last && lines[last[0]].timeMs === lines[i].timeMs) last.push(i);
      else out.push([i]);
    }
    return out;
  }, [lyrics]);

  // 背景漂移：原来是一条 30s 的 CSS 无限动画，现在改成受控 rAF。
  // 为什么必须改：CSS 无限动画由**合成器按刷新率**驱动（120/144/180Hz 屏上就是那么多次/秒），
  // 完全绕过 lib/frameBudget.ts 的帧预算 —— 这是"加了帧预算但降幅很小"的直接原因。
  // 改完之后它和其他逐帧循环共用同一个预算（稳 60fps），失焦/隐藏时干脆不写值（= 不产帧）。
  useEffect(() => {
    if (!mounted || !open || lowPower) return; // 低功耗不漂移（那一层在低功耗本来就是 display:none）
    const el = bgRef.current;
    if (!el) return;
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!frameBudget(now)) return;
      if (document.hidden || !isWinFocused()) return; // 没人看：不写值 → 不产帧
      const p = ((now - start) / 30000) % 2; // 30s 走一趟，往返（对应原来的 alternate）
      const tri = p < 1 ? p : 2 - p;
      const e = tri * tri * (3 - 2 * tri); // smoothstep ≈ ease-in-out
      const s = 1.13 + 0.03 * e;
      const tx = (-1.2 + 2.4 * e).toFixed(3);
      const ty = (-0.5 + 1.3 * e).toFixed(3);
      el.style.transform = "scale(" + s.toFixed(4) + ") translate3d(" + tx + "%, " + ty + "%, 0)";
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mounted, open, lowPower]);

  // 位置锚点：store 每次下发位置时记一笔，rAF 里按流逝时间外推。
  // 进度事件约 800ms 一次，直接用它驱动会出现「上一句还没亮完就换行」。
  const anchorRef = useRef({ secs: 0, at: 0, playing: false });
  useEffect(() => {
    anchorRef.current = {
      secs: position,
      at: performance.now(),
      playing: status === "playing",
    };
  }, [position, status]);

  const fillRef = useRef<HTMLSpanElement | null>(null);
  // 背景漂移（原 CSS drift 动画）改由受控 rAF 驱动，见下面那个 effect
  const bgRef = useRef<HTMLDivElement | null>(null);
  // 歌词纵向位移：基准（跟随当前句）+ 滚轮偏移，用 JS 缓动驱动（比 CSS 过渡更跟手）
  const baseYRef = useRef(0);
  const wheelYRef = useRef(0);
  const yRef = useRef(0);
  const yReadyRef = useRef(false);
  const wheelTimer = useRef<number | null>(null);
  // 设备像素比（用于把位移对齐到整数设备像素，避免文字发虚）
  const dprRef = useRef(1);
  // 上一帧时间戳（用于限速匀速跟随）
  const lastFrameRef = useRef(0);
  // 上次真正写进 DOM 的值：没变就不写。写同样的 transform / clip-path 不会产生新帧，
  // 但会白跑一遍样式解析；低功耗下这类"无效写"占的比例不小。
  const lastPxRef = useRef<number | null>(null);
  const lastFillRef = useRef<string | null>(null);
  // 大幅跳转时锁定的追赶速度（px/s）；为 0 表示当前是普通换行
  const catchupSpeedRef = useRef(0);
  // 滚轮松手后的回位补间（线性滑回 0，而不是瞬跳）
  const wheelReturnRef = useRef<{ from: number; start: number } | null>(null);
  const activeGroupRef = useRef(-1);
  const [activeGroup, setActiveGroup] = useState(-1);

  // 每帧：算出当前组、把「已唱到」的进度直接写到 DOM（不触发 React 重渲染），
  // 只有换行时才 setState，避免 60fps 重渲染整列歌词。
  useEffect(() => {
    if (!open || !lyrics?.synced || groups.length === 0) {
      activeGroupRef.current = -1;
      setActiveGroup(-1);
      return;
    }
    wheelYRef.current = 0;
    const lines = lyrics.lines;
    let raf = 0;
    const loop = () => {
      const ts = performance.now();
      // 全局帧预算：显示器 120/144/180Hz 时把逐帧工作限到 ~60fps（动效本就按 60fps 设计）
      if (!frameBudget(ts)) {
        raf = requestAnimationFrame(loop);
        return;
      }
      // ⚠️ 试过把低功耗的歌词滚动限到 30fps（32ms 帧闸）来省电：实测**滚动明显变顿，已否掉**。
      //    结论：歌词滚动保持 60fps（默认模式与低功耗一致）；省电改从别处拿
      //    （静止不写样式、卡片材质降级、光雾冻结）。所以这里不再有帧闸。
      const a = anchorRef.current;
      // ② 低功耗 + 静止：整段一个样式都不写 —— 没有样式变更就不会产生新帧。
      //    覆盖三种「其实没在动」的情况：暂停播放、没有滚轮回位补间、已经贴住目标位置。
      //    （循环本身保持注册，恢复播放 / 用户滚动时下一帧自动继续，不需要额外的重启机制。）
      if (
        lowPower &&
        !a.playing &&
        wheelReturnRef.current === null &&
        catchupSpeedRef.current === 0 &&
        Math.abs(baseYRef.current - yRef.current) <= 0.5
      ) {
        lastFrameRef.current = 0; // 恢复时按新一段重新计时，避免第一步跨度过大
        raf = requestAnimationFrame(loop);
        return;
      }
      const ms = (a.playing ? a.secs + (ts - a.at) / 1000 : a.secs) * 1000;
      let g = -1;
      for (let i = 0; i < groups.length; i++) {
        if (lines[groups[i][0]].timeMs <= ms) g = i;
        else break;
      }
      if (g >= 0) {
        const start = lines[groups[g][0]].timeMs;
        const next = groups[g + 1];
        const end = next ? lines[next[0]].timeMs : start + 4000;
        const p = Math.max(0, Math.min(1, (ms - start) / Math.max(400, end - start)));
        const el = fillRef.current;
        if (el) {
          const v = ((1 - p) * 100).toFixed(2);
          if (v !== lastFillRef.current) {
            lastFillRef.current = v;
            el.style.clipPath = "inset(0 " + v + "% 0 0)";
          }
        }
      }
      if (activeGroupRef.current !== g) {
        activeGroupRef.current = g;
        setActiveGroup(g);
      }
      // 位移 = 基准（限速匀速跟随）+ 滚轮偏移（手动时即时、松手后线性回位）
      const track = trackRef.current;
      const dt = lastFrameRef.current ? Math.min(FLOW_DT_MAX, ts - lastFrameRef.current) : 16.7;
      lastFrameRef.current = ts;
      {
        const diff = baseYRef.current - yRef.current;
        const dist = Math.abs(diff);
        // 大幅跳转（拖进度条/点句）：**起步时锁定速度**，保证在 LYRIC_CATCHUP_SECS 内匀速走完；
        // 若每帧按"剩余距离/时长"重算，尾段会指数衰减，几百行要好几秒才追平。
        // 低功耗：手动点远处歌词（或拖进度条）时**直接出现**，不做匀速追赶 ——
        // 追赶会连续几十帧重写 transform/clip-path，是最费合成的一段动画。
        if (lowPower && dist > LYRIC_CATCHUP_FROM) {
          yRef.current = baseYRef.current;
          catchupSpeedRef.current = 0;
        } else if (dist > LYRIC_CATCHUP_FROM && catchupSpeedRef.current === 0) {
          catchupSpeedRef.current = dist / LYRIC_CATCHUP_SECS;
        }
        if (dist <= 0.5) {
          catchupSpeedRef.current = 0;
        }
        const catchingUp = catchupSpeedRef.current > 0;
        const speed = catchingUp ? catchupSpeedRef.current : LYRIC_FLOW_SPEED;
        const step = (speed * dt) / 1000;
        if (dist <= step) {
          yRef.current = baseYRef.current; // 到点
        } else if (catchingUp) {
          yRef.current += Math.sign(diff) * step; // 追赶：全程匀速，不做软着陆
        } else {
          // 普通换行：接近目标时按比例降速（软着陆），中间段保持匀速
          const k = Math.min(1, dist / LYRIC_FLOW_EASE);
          yRef.current += Math.sign(diff) * step * k;
        }
      }
      const ret = wheelReturnRef.current;
      if (ret) {
        const p = (ts - ret.start) / WHEEL_RETURN_MS;
        if (p >= 1) {
          wheelYRef.current = 0;
          wheelReturnRef.current = null;
        } else {
          wheelYRef.current = ret.from * (1 - p);
        }
      }
      if (track) {
        // 按设备像素对齐：小数位移会让整列文字落在亚像素位置，渲染发虚
        const px = Math.round((yRef.current + wheelYRef.current) * dprRef.current) / dprRef.current;
        if (px !== lastPxRef.current) {
          lastPxRef.current = px;
          track.style.transform = "translateY(" + px + "px)";
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open, lyrics, groups, lowPower]);

  const activeIndex = activeGroup >= 0 && groups[activeGroup] ? groups[activeGroup][0] : -1;

  // 居中基准（与设计稿 renderLyrics 的算法一致）：只算基准位移，实际 transform 由 rAF 缓动写入
  useLayoutEffect(() => {
    const box = lyricsBoxRef.current;
    const track = trackRef.current;
    if (!box || !track) return;
    // 居中对象是「活动组」（原词 + 翻译作为整体居中）
    const active =
      (track.querySelector(".lyric-group.active") as HTMLElement | null) ??
      (activeIndex >= 0 ? (track.children[activeIndex] as HTMLElement | undefined) : undefined);
    const offset = active
      ? active.offsetTop + active.offsetHeight / 2 - box.clientHeight / 2 + 74
      : 74;
    baseYRef.current = -offset;
    if (!yReadyRef.current) {
      // 首次进入直接落位，不滚动
      yRef.current = baseYRef.current;
      lastFrameRef.current = 0;
      yReadyRef.current = true;
    }
  }, [activeIndex, lyrics, open]);

  // 滚轮：手动浏览歌词（松手 2.6s 后自动回到当前句）
  useEffect(() => {
    const box = lyricsBoxRef.current;
    if (!box || !open) return;
    dprRef.current = window.devicePixelRatio || 1;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setBlurOff(true); // 滑动滚轮时取消渐进模糊
      const track = trackRef.current;
      const span = track ? Math.max(240, track.scrollHeight * 0.6) : 600;
      const step = e.deltaMode === 1 ? e.deltaY * 28 : e.deltaY; // 行模式换算成像素
      wheelYRef.current = Math.max(-span, Math.min(span, wheelYRef.current - step));
      if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
      wheelReturnRef.current = null; // 有新滚动输入则取消回位
      wheelTimer.current = window.setTimeout(() => {
        // 线性滑回当前句（而不是瞬跳）
        wheelReturnRef.current = { from: wheelYRef.current, start: performance.now() };
        setBlurOff(false); // 回到当前句后恢复模糊
      }, 2600);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      box.removeEventListener("wheel", onWheel);
      if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
    };
  }, [open, lyrics]);

  const groupOfLine = useMemo(() => {
    const map = new Map<number, number>();
    groups.forEach((g, gi) => g.forEach((li) => map.set(li, gi)));
    return map;
  }, [groups]);

  /**
   * 以当前句为中心的渐进模糊：活动组（原词 + 翻译）完全清晰，
   * 向上/向下按「组距」递增模糊，越远越糊；滚动滚轮时整体取消。
   */
  const blurFor = useCallback(
    (groupIndex: number) => {
      // 低功耗：逐行 filter blur 会产生几十个滤镜表面，直接关掉
      if (blurOff || lowPower || activeGroup < 0) return 0;
      const d = Math.abs(groupIndex - activeGroup);
      // 当前句 ±2 组保持清晰（视口里约一半的行是清晰的），从第 3 组开始虚化，
      // 越远越糊、上限 2.6px。注意保持"清晰带"：早前把模糊起点提前到第 1 组时整页会发虚。
      if (d <= 2) return 0;
      return Math.min(2.6, 1 + (d - 3) * 0.8);
    },
    [blurOff, lowPower, activeGroup]
  );

  const classOf = useCallback(
    (index: number) => {
      if (!lyrics?.synced) return "line plain";
      if (index === activeIndex) return "line active";
      // 有翻译（同时间戳多行）时按「组」算邻接，否则按行算，保持设计稿 2 行邻接的观感
      const hasDup = groups.some((g) => g.length > 1);
      const gi = groupOfLine.get(index) ?? 0;
      const distance = hasDup ? Math.abs(gi - activeGroup) : Math.abs(index - activeIndex);
      return distance <= (hasDup ? 1 : 2) ? "line near" : "line far";
    },
    [lyrics, activeIndex, activeGroup, groupOfLine, groups]
  );


  // 字体注册：每个「字体 × 语言槽」一份字面（受限的那份带 unicode-range），详见 lyricFont.ts
  useEffect(() => {
    void ensureFontFaces(settingsValues);
  }, [lyricFontSlots.latin, lyricFontSlots.zh, lyricFontSlots.ja, lyricFontSlots.ko]);




  // lines 的引用稳定下来，下面两个 memo 才不会被"每次 render 都新建的空数组"击穿
  const lines = useMemo(() => lyrics?.lines ?? [], [lyrics]);
  const hasLyrics = lines.length > 0;
  const synced = !!lyrics?.synced && hasLyrics;

  // 整首歌的主语言：决定"没设置的槽"跟随谁（一首歌一个声音）
  const songSlot = useMemo(() => detectSongSlot(lines.map((l) => l.text)), [lines]);
  // 每个语言槽的完整字体栈（含系统兜底链）；放进 memo 是为了每帧的进度更新不重算
  const fontStacks = useMemo(
    () => lyricFontStacks(settingsValues, songSlot),
    [settingsValues, songSlot]
  );
  // 每一行归属的语言槽：汉字行按"简体 / 和制汉字 + 同组有没有假名"判，不再一概跟随整首歌
  const lineSlots = useMemo(
    () => detectLineSlots(lines.map((l) => l.text), songSlot, groups),
    [lines, songSlot, groups]
  );

  // 缺字策略为「整行回退」时才需要覆盖表；默认的「逐字替换」完全不读字体文件，零开销
  const glyphPolicy = readGlyphPolicy(settingsValues);
  const [coverage, setCoverage] = useState<Record<string, Coverage | null>>({});
  useEffect(() => {
    if (glyphPolicy !== "line") return;
    let alive = true;
    void loadCoverage(settingsValues).then((m) => {
      if (alive) setCoverage(m);
    });
    return () => {
      alive = false;
    };
  }, [glyphPolicy, settingsValues]);

  // 每一行最终用的字体栈。整行回退 = 这一行的主字体缺字 → 整行撤掉它（其余槽的借出照旧）
  const lineStacks = useMemo(() => {
    const chosen = readSlotFonts(settingsValues);
    return lines.map((l, i) => {
      const slot = lineSlots[i] ?? "latin";
      if (glyphPolicy === "line") {
        const id = chosen[slot];
        if (id && id !== SYSTEM_FONT) {
          const cov = coverage[id] ?? null;
          if (lineHasMissing(l.text, slot, cov)) return fontStackFor(chosen, slot, songSlot, true);
        }
      }
      return fontStacks.bySlot[slot];
    });
  }, [lines, lineSlots, glyphPolicy, coverage, settingsValues, songSlot, fontStacks]);

  useEffect(
    () => () => {
      if (switchTimer.current !== null) window.clearTimeout(switchTimer.current);
    },
    []
  );

  /** 切换歌词排版。默认模式：先淡出 → 换布局 → 再淡回（只动 opacity/transform，
      不碰 left/right —— 否则整列文字会逐帧重新换行，几十行同排代价很高）。
      低功耗：直接换，不做任何动效。 */
  const toggleLayout = useCallback(() => {
    const next = layout === "poster" ? "center" : "poster";
    if (lowPower) {
      setLayout(next);
      return;
    }
    if (layoutSwitching) return;
    setLayoutSwitching(true);
    if (switchTimer.current !== null) window.clearTimeout(switchTimer.current);
    switchTimer.current = window.setTimeout(() => {
      setLayout(next);
      requestAnimationFrame(() => setLayoutSwitching(false));
    }, 150);
  }, [layout, layoutSwitching, lowPower]);

  /**
   * 歌词页完全展开后，把被它**完全盖住**的主界面隐藏。
   *
   * 为什么值得做：默认模式下主界面并不是静止的（侧栏/播放条的毛玻璃、卡片……），而歌词页的
   * .bg 有个 30 秒的 drift 动画一直在产帧 —— 每产一帧，整窗所有能看见的图层都要重新合成一次。
   * 实测佐证：暂停播放时首页是 0%（Chromium 没事就不画），而歌词页仍是 20%，这 20% 就是
   * "一直产帧 + 每帧合成整窗"的代价。主界面既然看不见，就不该参与合成。
   *
   * ⚠️ 时序是关键。当年这里是 `.low-power:has(.lyrics-page) .app-body{visibility:hidden}`，
   * 它只随"歌词页是否存在"切换 → 退场动画**播完**才恢复可见 → 合成器早就丢掉了主界面的
   * 绘制结果，重新可见时要重画一帧 = 返回时闪一下纯白，于是整条规则被删掉。
   * 现在改成：**展开完成后才隐藏，退场一开始就恢复**（useLayoutEffect 在绘制前同步改类，
   * 且改类发生在设置收缩 clip 的那个 effect 之前），恢复动作永远发生在面板还盖满屏幕的时候。
   * 低功耗模式不做：那时主界面本来就静止（光雾已关、光晕/波形已停），成本≈0，不值得冒重绘风险。
   */
  useLayoutEffect(() => {
    if (lowPower) return;
    const shell = document.querySelector(".app-shell");
    if (!shell) return;
    if (mounted && open && !phase) shell.classList.add("lyrics-covered");
    return () => shell.classList.remove("lyrics-covered");
  }, [mounted, open, phase, lowPower]);

  if (!mounted) return null;

  return (
    <div
      className={
        "lyrics-page" +
        (staged ? " staged" : "") +
        (phase === "in" ? " entering" : phase === "out" ? " leaving" : "") +
        (cleared ? " cleared" : "") +
        (layout === "center" ? " layout-center" : "") +
        (layoutSwitching ? " switching" : "")
      }
      ref={pageRef}
      style={
        {
          // 歌词字体：每个语言槽一条完整字体栈（行上按语言引用）；--lyric-font 保留为主语言栈，
          // 兼容 views.css / lyrics.css 里沿用它的那几条规则
          "--lyric-font": fontStacks.primary,
          "--lf-latin": fontStacks.bySlot.latin,
          "--lf-zh": fontStacks.bySlot.zh,
          "--lf-ja": fontStacks.bySlot.ja,
          "--lf-ko": fontStacks.bySlot.ko,
          "--lyric-size": String(lyricFontSize),
          "--lyric-weight": String(lyricFontWeight),
        } as CSSProperties
      }
    >
      {/* 进度/音量的伪元素几何由这里按实际数值注入，设计稿的声明值保持不动 */}
      <style>{".lyrics-page .rail::before{width:" + percent + "%}.lyrics-page .rail::after{left:" + percent + "%}.lyrics-page .volume-rail::before{width:" + volume + "%}"}</style>

      {/* 面板背后的暗底。面板圆角弧线上的反锯齿像素约 18% 会露出它背后那一层，
          而背后是外壳的近白底 + 侧栏等浅色内容 → 深色歌词页上沿弧线出现一条亮线。
          它必须**始终**与面板的 clip-path 同步（下面两处动画），否则入场那 900ms
          里面板没铺满、暗底却已经铺满，就会"先黑一下再扩散"；反之若入场不加暗底，
          白线就会在入场期间露出来（这正是"刚打开有白线、随后变淡"的原因）。 */}
      {/* 全窗深色底：稳定态盖满整窗，负责"最终一定有暗底"（面板圆角处不漏白线）。
          它只做 opacity 淡入，不参与任何形状动画 —— 形状动画（裁剪/大圆缩放）才是贵的。
          压在圆盘**上面**：圆盘绽开到一半时它渐渐变实，观感是"暗色一层层铺开"。 */}
      <div className="lyrics-veil" ref={veilRef} aria-hidden="true" />
      {/* 开场用的深色圆盘：只做小范围绽开（--disc-scale 约 1.45），纹理也就 900px 级，
          不会像"盖满整窗"那样被按最大缩放比例栅格化成一张巨型纹理。 */}
      <div className="lyrics-scrim" ref={scrimRef} aria-hidden="true" />

      <div className={"player" + (immersive ? " immersive" : "")} ref={panelRef}>
        {/* .bg 的图层顺序（上→下）：原来的 .bg-tint 三层暖光 → 压暗渐变 → 封面。
            把 tint 并进来是为了让 mix-blend-mode: screen 变成 background-blend-mode：
            前者要"读回背板再混合"，而背板 .bg 有 30s 无限 drift 动画 → **每帧都要重算**；
            后者只在画自己背景时完成，不碰背板。 */}
        <div
          ref={bgRef}
          className={"bg" + (tinyCover ? " bg-tiny" : "")}
          style={{
            backgroundImage:
              "radial-gradient(circle at 12% 76%,rgba(255,92,30,.12),transparent 28%), " +
              "radial-gradient(circle at 45% 42%,rgba(255,173,77,.18),transparent 34%), " +
              "linear-gradient(180deg,rgba(255,190,110,.08),transparent 30%,rgba(35,8,3,.30) 100%), " +
              "linear-gradient(125deg,rgba(18,8,3,.15),rgba(0,0,0,.08)), " +
              (tinyCover
                ? "url(" + JSON.stringify(tinyCover) + ")"
                : cover
                  ? "url(" + JSON.stringify(cover) + ")"
                  : "linear-gradient(135deg,#3B4048,#191B1F 70%,#101215)"),
            backgroundBlendMode: "screen, screen, screen, normal, normal",
            // ⚠️ 必须显式写全：CSS 简写 background 只给了 2 个 repeat/size 槽位
            // （[repeat, no-repeat] / [auto, cover]），图层数超过 2 之后会**循环套用**，
            // 结果最后一层（封面）拿到 repeat + auto → 封面被平铺成小方块。
            backgroundRepeat: "no-repeat",
            backgroundSize: "auto, auto, auto, auto, cover",
            backgroundPosition: "center",
          }}
        />
        <div className="ambient" />
        <div className="vignette" />
        <div className="grain" />

        <header className="topbar">
          <div className="track-pill glass">
            <div className="back" title="返回" onClick={closeLyrics}>
              <svg viewBox="0 0 24 24">
                <path d="M15 5 8 12l7 7" />
              </svg>
            </div>
            {cover ? (
              <img className="cover-mini" src={cover} alt="" width={46} height={46} style={{ borderRadius: 12, width: 46, height: 46 }} />
            ) : (
              <span className="cover-mini cover-fallback" aria-hidden="true">♪</span>
            )}
            <div className="track-meta">
              <strong>{current?.title ?? "没有正在播放的歌曲"}</strong>
              <span>{current?.artist ?? "从音乐库选择一首歌"}</span>
            </div>
          </div>

          <div className="top-right">
            <div className="top-actions glass">
              <button
                className="icon-btn"
                title={cleared ? "退出沉浸（Esc）" : "沉浸：清屏只留歌词"}
                onClick={() => setCleared((v) => !v)}
              >
                {/* 界面可见 = 睁眼；沉浸清屏 = 闭眼。原先这里用的是全屏图标，
                    但这个按钮早已不是全屏开关（全屏已移除），语义对不上。 */}
                <Icon name={cleared ? "eye-off" : "eye"} />
              </button>
            </div>
            {/* 布局切换：默认「左封面 + 右歌词」⇄「无封面 + 歌词居中」。
                低功耗下只隐藏 .top-actions（沉浸按钮），这一颗要留着。
                图标画的是"点下去会变成什么样"。 */}
            <button
              className="layout-btn glass"
              title={layout === "poster" ? "歌词居中（隐藏封面）" : "封面 + 歌词"}
              aria-label="切换歌词布局"
              aria-pressed={layout === "center"}
              onClick={toggleLayout}
            >
              <Icon name={layout === "poster" ? "layout-center" : "layout-poster"} />
            </button>
          </div>
        </header>

        {/* 沉浸清屏：只保留一个极简退出按钮（也可按 Esc） */}
        {cleared && (
          <button className="clear-exit" title="退出沉浸（Esc）" onClick={() => setCleared(false)}>
            <Icon name="minimize" />
          </button>
        )}

        {/* 左侧歌曲海报（35px 圆角）+ 右侧歌词：**两种模式共用这套排布**，
            低功耗只是把视觉换成白底黑字（见 views.css 的 .low-power 段）。 */}
        <aside className="lp-poster">
          {/* is-empty 只用于占位底色：有封面时容器必须是透明的，否则圆角边缘会漏出一条白边 */}
          <div className={"lp-poster-cover" + (cover ? "" : " is-empty")}>
            {cover ? <img src={cover} alt="" /> : <span className="lp-poster-glyph">♪</span>}
          </div>
          <div className="lp-poster-title">{current?.title ?? "没有正在播放的歌曲"}</div>
          <div className="lp-poster-artist">{current?.artist ?? "从音乐库选择一首歌"}</div>
        </aside>

        <main className="lyrics-area">
          <section className="lyrics" ref={lyricsBoxRef}>
            {loading ? (
              <div className="lyrics-empty">
                <span className="spinner" />
                <div className="title">正在读取歌词…</div>
              </div>
            ) : !hasLyrics ? (
              <div className="lyrics-empty">
                <div className="glyph">♫</div>
                <div className="title">{current ? "这首歌还没有歌词" : "还没有正在播放的歌曲"}</div>
                <div className="sub">
                  把同名歌词文件（<code>{current ? current.title : "歌曲名"}.lrc</code>）放到歌曲旁边，
                  <br />
                  或把歌词写进音乐文件的内嵌标签，这里就会自动显示。
                </div>
              </div>
            ) : (
              <div className="lyrics-track" ref={trackRef}>
                {!synced && <p className="lyrics-note">纯文本歌词 · 无时间轴</p>}
                {groups.map((group, gi) => (
                  // 同一时间戳的多行（原词 + 翻译）作为**一个整体**渲染：
                  // 放大与行距都在这一层，保证原词和翻译一起放大、贴合在一起
                  <div
                    key={"g" + gi}
                    className={"lyric-group" + (gi === activeGroup ? " active" : "")}
                    style={{
                      filter: blurFor(gi) > 0.05 ? "blur(" + blurFor(gi).toFixed(2) + "px)" : undefined,
                    }}
                  >
                    {group.map((index) => {
                      const line = lines[index];
                      const cls = classOf(index);
                      // 这一行的语言：字体栈按它取，lang 属性同时修中日的汉字字形变体
                      const slot = lineSlots[index] ?? "latin";
                      if (cls === "line active") {
                        // 双层：底层是未唱到的暗色，上层是已唱到的亮色，用 clip-path 从左到右点亮
                        return (
                          <p
                            key={index}
                            className={cls + " clickable"}
                            lang={slotLang(slot)}
                            style={{ fontFamily: lineStacks[index] }}
                            title="点击跳到这句"
                            onClick={() => {
                              wheelYRef.current = 0;
                              void seek(line.timeMs / 1000);
                            }}
                          >
                            <span className="karaoke-base">{line.text}</span>
                            <span
                              ref={fillRef}
                              className="karaoke-fill"
                              style={{ clipPath: "inset(0 100% 0 0)" }}
                              aria-hidden="true"
                            >
                              {line.text}
                            </span>
                          </p>
                        );
                      }
                      return (
                        <p
                          key={index}
                          className={cls + (synced ? " clickable" : "")}
                          lang={slotLang(slot)}
                          style={{ fontFamily: lineStacks[index] }}
                          title={synced ? "点击跳到这句" : undefined}
                          onClick={
                            synced
                              ? () => {
                                  wheelYRef.current = 0;
                                  void seek(line.timeMs / 1000);
                                }
                              : undefined
                          }
                        >
                          {line.text}
                        </p>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>

        {/* 底栏直接复用主界面播放条（variant="lyrics"），按钮/进度条位置与样式完全一致 */}
        <footer className="lyrics-footer">
          <PlayerBar variant="lyrics" />
        </footer>
      </div>
    </div>
  );
}
