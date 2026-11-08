// 沉浸式歌词页。
//
// 视觉规范取自 Salt Player 的播放页设计文档（《SaltPlayer-播放页前端设计文档.md》/
// 《SaltPlayer-播放页视觉逆向分析.md》），几条是这个页面必须守住的：
//
//   · 明暗只跟主题枚举走，不看封面亮度：
//       深色 → 纯黑底 + 纯白前景；浅色 → 纯白底 + **封面主色**做前景（取不到回退 #050F19）。
//   · 背景三层：底色（黑/白）→ 流光（FlowingLight）→ 内容。
//     流光自己带压暗蒙层，所以播放页**没有**额外的 scrim，也没有卡片、分割线、渐变按钮。
//   · 歌词：基准 24 × 倍率，当前句**不放大**，靠"阶梯模糊 + 0.05 alpha 差 + 加粗"区分；
//     相邻 1/2/3/≥4 行分别是 1.6 / 3.2 / 4.8 / 6.0 的模糊。
//   · 滚动用弹簧（ζ=1.1，k=200）而不是匀速跟随：过阻尼意味着永远不过冲、不回弹。
//   · 页面留白 30dp，封面圆角 12dp / 描边 2dp，底部固定 120（= 项目里的 --player-height）。
//
// 类名统一 sl-* 前缀：views.css 里还挂着一批旧的 .lyrics-page .line ... 规则，
// 换前缀后它们自然不再命中，省去一场特异性战争（真正失效的块已经删掉了）。
import type { CSSProperties } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/ipc";
import type { LyricsResult } from "../api/types";
import { Icon } from "./Icon";
import { PlayerBar } from "./PlayerBar";
import { FlowingLight } from "./FlowingLight";
import { FALLBACK_LOOK, sampleCover } from "../lib/coverColor";
import type { CoverLook } from "../lib/coverColor";
import { useCover } from "../lib/cover";
import { frameBudget } from "../lib/frameBudget";
import { LP_THEME_KEY, lpIsDark, parseLpTheme, useSystemDark } from "../lib/lowPower";
import { usePlayerStore } from "../stores/playerStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  detectLineSlots,
  detectSongSlot,
  lyricFontStacks,
  readMatchPolicy,
  readSize,
  readWeight,
  slotLang,
} from "../lib/lyricFont";
import { useUiStore, toast } from "../stores/uiStore";

/** 鼠标静止多久后进入沉浸模式（3s） */
const IMMERSIVE_DELAY = 3000;

/* ===== 歌词滚动 =====
   Salt 用的是弹簧：dampingRatio 1.1、stiffness 200。ζ>1 = 过阻尼，永远不会过冲回弹，
   换句时是一段"快起、慢收"的位移，而不是我们原来那条匀速直线。
   换算成这里的微分方程：m=1，c = 2ζ√k ≈ 31.1，a = -k·x - c·v。
   （逐行错峰延迟（50ms/1.05^k）没有做：那会给十几行同时挂 transform 动画，
    和本项目"歌词只动一层 transform、一次 reflow"的约束直接冲突，收益也看不出来。） */
const SPRING_K = 200;
const SPRING_ZETA = 1.1;
const SPRING_C = 2 * SPRING_ZETA * Math.sqrt(SPRING_K);
/** 单帧最大步进（毫秒）：窗口卡顿/后台恢复后不至于瞬移 */
const SPRING_DT_MAX = 48;
/** 速度上限（px/s）：从第一句直接跳到第 300 句时，别让整列文字糊成一条线 */
const SPRING_VMAX = 7000;
/** 最后一句没有下一句时，假定这一句唱 5.5s（扫过动画不会卡在中间） */
const LAST_LINE_MS = 5500;

/**
 * 阶梯模糊（px）：当前句 0，往外 1.6 / 3.2 / 4.8 / 6.0。
 *
 * 和原来"近 5px、每行 +2、上限 12"的区别：Salt 的模糊是**很轻**的一层雾，
 * 靠的是"只有当前句是实的"这个对比，而不是把远处糊成色块。糊到 12px 时，
 * 一屏之内所有非当前行都变成同样的灰条，行数信息就没了。
 */
const BLUR_STEPS = [1.6, 3.2, 4.8, 6.0];
/** 只有离当前句这么近的行才真的挂 filter（见 blurFor 的注释）。 */
const BLUR_LIMIT = 8;

/** 滚轮回位时长（毫秒） */
const WHEEL_RETURN_MS = 520;

/* ===== 圆形扩散（进场） =====
   圆盘是预先画好的位图，动画只改 transform: scale()，内容不参与缩放 ——
   这样进场期间不会每帧按新圆重新光栅化整窗（clip-path 动画的老问题）。
   1.45× 是有意压住的：scale 越大，浏览器按最大比例栅格化出来的纹理越大（5× 时约 3300²）。 */
const DISC_BLOOM = 1.45;

export function LyricsPage() {
  const open = useUiStore((s) => s.lyricsOpen);
  const closeLyrics = useUiStore((s) => s.closeLyrics);
  const origin = useUiStore((s) => s.lyricsOrigin);
  const player = usePlayerStore((s) => s.state);
  const seek = usePlayerStore((s) => s.seek);
  const settingsValues = useSettingsStore((s) => s.values);
  const lowPower = settingsValues["lowPower"] === "on";
  // 主题：只有低功耗模式才可能变浅色；默认（非低功耗）永远是深色，与 Salt 的规则一致
  const systemDark = useSystemDark();
  const light = lowPower && !lpIsDark(parseLpTheme(settingsValues[LP_THEME_KEY]), systemDark);

  // 歌词字体：固定系统字体，按语言分栈（西文 / 中文 / 日文 / 韩文），每行按脚本引用。
  // 行上 var(--lf-<slot>) → 该语言的系统字体链（规则见 src/lib/lyricFont.ts）。
  const lyricFontSize = readSize(settingsValues);
  const lyricFontWeight = readWeight(settingsValues);

  const current = player?.current ?? null;
  const status = player?.status ?? "stopped";
  const cover = useCover(current?.trackId ?? null);

  // 背景取色：封面 → 纹理 + 页面基色 + 白纱强度（见 src/lib/coverColor.ts）。
  // 关键点：颜色不是"挑"出来的，而是封面本身 —— 所以色相永远不会串（橘黄不会变成绿）。
  // 白纱只负责"深色封面抬成浅色系"，浅色封面 wash = 0，原样取用。
  const [look, setLook] = useState<CoverLook>(FALLBACK_LOOK);
  useEffect(() => {
    let alive = true;
    void sampleCover(cover).then((l) => {
      if (alive) setLook(l);
    });
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
  const stageRef = useRef<HTMLDivElement | null>(null);

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

  const pageRef = useRef<HTMLDivElement | null>(null);
  /** 全窗底色（黑/白）：只做 opacity 淡入 —— 最便宜的合成层动画 */
  const veilRef = useRef<HTMLDivElement | null>(null);
  /** 进场圆盘：只动 transform: scale(--disc-scale) */
  const discRef = useRef<HTMLDivElement | null>(null);
  const lyricsBoxRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);

  const position = current?.positionSecs ?? 0;

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

  // 切歌过场：整列轻抬 10px 淡入（CSS 见 .lyrics-page.swapping）。
  // 动效挂在 .sl-lyrics 容器上，绝不碰 .sl-track —— 那一层的 transform 属于弹簧。
  const [swapping, setSwapping] = useState(false);
  const prevTrackRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const id = current?.trackId ?? null;
    if (prevTrackRef.current === undefined) {
      prevTrackRef.current = id;
      return;
    }
    if (prevTrackRef.current === id) return;
    prevTrackRef.current = id;
    if (lowPower) return;
    setSwapping(true);
    const t = window.setTimeout(() => setSwapping(false), 480);
    return () => window.clearTimeout(t);
  }, [current?.trackId, lowPower]);

  // 沉浸模式：鼠标/键盘静止 3s 后隐藏上下控件
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
      if (e.key !== "Escape") return;
      // 沉浸清屏时先退出沉浸，再按一次才关闭歌词页。
      // ⚠️ 不能在 setState 的 updater 里做副作用：StrictMode 下 updater 会跑两遍。
      if (cleared) {
        setCleared(false);
        return;
      }
      closeLyrics();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeLyrics, cleared]);

  // 每次重新打开都复位这几个「临时态」
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setCleared(false);
      setImmersive(false);
      setBlurOff(false);
    }
    wasOpen.current = open;
  }, [open]);

  // 展开/收起的状态与计时
  useEffect(() => {
    if (open) {
      everOpened.current = true;
      setMounted(true);
      setPhase("in");
      // ⚠️ 必须**立即**进入 staged：.staged 的入场动画带 both 填充，动画真正开始前会维持
      // 元素的自然状态（完全可见）；延迟加类会让歌词先亮一下再被拉回 from。
      // 分层错峰交给 CSS 自带的 animation-delay（topbar 120 / lyrics-area 240 / footer 340）。
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
    // 低功耗：收起同样不做圆形收缩，改成一次淡出
    if (lowPower) {
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
    // 退场：内容先快速淡出，底色与圆盘再收回（都是合成层操作，不重画内容）
    const stage = stageRef.current;
    const disc = discRef.current;
    const veil = veilRef.current;
    if (stage) {
      stage.style.transition = "opacity 130ms ease";
      stage.style.opacity = "0";
    }
    if (veil) {
      veil.style.transition = "opacity 220ms ease";
      veil.style.opacity = "0";
    }
    if (disc) {
      disc.style.transition = "transform 260ms ease";
      disc.style.setProperty("--disc-scale", "0");
    }
    const timer = window.setTimeout(() => {
      setPhase(null);
      setMounted(false); // 退场动画播完再卸载
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, geo, lowPower]);

  // 进场：底色淡入 + 圆盘从点击处绽开 + 内容分层入场（只动 opacity/transform）
  useLayoutEffect(() => {
    if (!mounted || !open) return;
    const root = pageRef.current;
    const veil = veilRef.current;
    const disc = discRef.current;
    const stage = stageRef.current;
    if (root) {
      root.style.transition = "";
      root.style.opacity = "";
      root.style.setProperty("--ox", geo.cx + "px");
      root.style.setProperty("--oy", geo.cy + "px");
    }
    // 低功耗：只淡根元素（底色 + 内容一起淡，不会先露出半块遮罩）
    if (lowPower) {
      if (disc) {
        disc.style.transition = "none";
        disc.style.setProperty("--disc-scale", "0");
      }
      if (veil) {
        veil.style.transition = "none";
        veil.style.opacity = "1";
      }
      if (stage) {
        stage.style.transition = "";
        stage.style.opacity = "";
      }
      if (root) {
        root.style.transition = "opacity 200ms ease";
        root.style.opacity = "0";
        void root.offsetWidth; // 强制重排，让下面的 opacity 走过渡
        root.style.opacity = "1";
      }
      return;
    }
    if (veil) {
      veil.style.transition = "none";
      veil.style.opacity = "0";
    }
    if (disc) {
      disc.style.transition = "none";
      disc.style.setProperty("--disc-scale", "0");
    }
    if (stage) {
      stage.style.transition = "opacity 420ms cubic-bezier(.4,0,.2,1)";
      stage.style.opacity = "0";
    }
    void disc?.offsetWidth; // 强制重排，让下面的过渡生效
    if (veil) {
      veil.style.transition = "opacity 560ms cubic-bezier(.4,0,.2,1)";
      veil.style.opacity = "1";
    }
    if (disc) {
      disc.style.transition = "transform 700ms cubic-bezier(.4,0,.2,1)";
      disc.style.setProperty("--disc-scale", String(DISC_BLOOM));
    }
    if (stage) {
      void stage.offsetWidth;
      stage.style.opacity = "1";
    }
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

  /** 歌词纵向位移：弹簧跟随基准位 + 滚轮偏移 */
  const baseYRef = useRef(0);
  const wheelYRef = useRef(0);
  const yRef = useRef(0);
  const vRef = useRef(0);
  const yReadyRef = useRef(false);
  const wheelTimer = useRef<number | null>(null);
  // 设备像素比（用于把位移对齐到整数设备像素，避免文字发虚）
  const dprRef = useRef(1);
  // 上一帧时间戳
  const lastFrameRef = useRef(0);
  // 上次真正写进 DOM 的值：没变就不写
  const lastPxRef = useRef<number | null>(null);
  // 滚轮松手后的回位补间（线性滑回 0，而不是瞬跳）
  const wheelReturnRef = useRef<{ from: number; start: number } | null>(null);
  const activeGroupRef = useRef(-1);
  // 逐句扫过：当前写着 --sl-k 的那个元素（切行时要把上一行的变量清掉）
  const karaokeRef = useRef<{ group: number; node: HTMLElement | null; k: number }>({
    group: -1,
    node: null,
    k: -1,
  });
  const [activeGroup, setActiveGroup] = useState(-1);

  // 每帧：算出当前组，并把位移积分到 DOM（不触发 React 重渲染），
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
      // 全局帧预算：显示器 120/144/180Hz 时把逐帧工作限到 ~60fps
      if (!frameBudget(ts)) {
        raf = requestAnimationFrame(loop);
        return;
      }
      const a = anchorRef.current;
      // 低功耗 + 静止：整段一个样式都不写 —— 没有样式变更就不会产生新帧
      if (
        lowPower &&
        !a.playing &&
        wheelReturnRef.current === null &&
        Math.abs(baseYRef.current - yRef.current) <= 0.5 &&
        Math.abs(vRef.current) < 6
      ) {
        lastFrameRef.current = 0;
        raf = requestAnimationFrame(loop);
        return;
      }
      const ms = (a.playing ? a.secs + (ts - a.at) / 1000 : a.secs) * 1000;
      let g = -1;
      for (let i = 0; i < groups.length; i++) {
        if (lines[groups[i][0]].timeMs <= ms) g = i;
        else break;
      }
      // 当前这一整句一次性全亮，不跟演唱进度渐变：每帧只判断"当前是第几组"
      if (activeGroupRef.current !== g) {
        activeGroupRef.current = g;
        setActiveGroup(g);
      }
      // 弹簧积分（半隐式欧拉 + 两次子步，ζ>1 时足够稳）
      const dt = lastFrameRef.current ? Math.min(SPRING_DT_MAX, ts - lastFrameRef.current) : 16.7;
      lastFrameRef.current = ts;
      {
        const half = dt / 2000;
        for (let s = 0; s < 2; s++) {
          const dx = yRef.current - baseYRef.current;
          const acc = -SPRING_K * dx - SPRING_C * vRef.current;
          let v = vRef.current + acc * half;
          if (v > SPRING_VMAX) v = SPRING_VMAX;
          else if (v < -SPRING_VMAX) v = -SPRING_VMAX;
          vRef.current = v;
          yRef.current += v * half;
          if (Math.abs(yRef.current - baseYRef.current) < 0.2 && Math.abs(vRef.current) < 8) {
            yRef.current = baseYRef.current;
            vRef.current = 0;
            break;
          }
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
      // 逐句扫过（规范 I.3 的 gradientPercentage）：只给当前这一组的原文行写一个
      // --sl-k 变量，CSS 用 background-clip:text 把它变成"已唱 / 未唱"的界线。
      // 不 setState、不重建 DOM —— 每帧只是一条 style.setProperty。
      if (!lowPower && karaokeRef.current) {
        const el = karaokeRef.current;
        if (el.group !== g) {
          if (el.node) el.node.style.removeProperty("--sl-k");
          // 注意：不能引用下面的 const track —— 那行在本块之后声明，同作用域里先读会 TDZ 报错，
          // rAF 循环会当场死掉（曾因此整列歌词不滚、--sl-k 也永远为空）。
          const gEl = trackRef.current?.children[g] as HTMLElement | undefined;
          el.node = (gEl?.querySelector(".sl-line:not(.is-tr)") as HTMLElement | null) ?? null;
          el.group = g;
          el.k = -1;
        }
        if (el.node) {
          const t0 = groups[g] ? lines[groups[g][0]].timeMs : 0;
          const t1 =
            groups[g + 1] && lines[groups[g + 1][0]]
              ? lines[groups[g + 1][0]].timeMs
              : t0 + LAST_LINE_MS;
          // 扫过的时长取「本句到下一句」的间隔，但夹在 0.9s–4.5s：
          // 前奏/间奏里一句歌词可能挂着十几秒，按真实间隔扫会慢得像没在动。
          const swept = Math.max(900, Math.min(4500, t1 - t0));
          const k = Math.max(0, Math.min(1, (ms - t0) / swept));
          if (Math.abs(k - el.k) > 0.004 || k === 1) {
            el.k = k;
            el.node.style.setProperty("--sl-k", k.toFixed(3));
          }
        }
      }
      const track = trackRef.current;
      if (track) {
        // 按设备像素对齐：小数位移会让整列文字落在亚像素位置，渲染发虚
        const px = Math.round((yRef.current + wheelYRef.current) * dprRef.current) / dprRef.current;
        if (px !== lastPxRef.current) {
          lastPxRef.current = px;
          track.style.transform = "translate3d(0," + px + "px,0)";
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open, lyrics, groups, lowPower]);

  // 居中基准：把「当前这一组」的中心对到歌词区的垂直中心。
  // 歌词区的下边界就是播放条上沿（见 lyrics.css 的 .sl-lyrics-area），所以这里不再补偿偏移量。
  useLayoutEffect(() => {
    const box = lyricsBoxRef.current;
    const track = trackRef.current;
    if (!box || !track) return;
    // 前奏期间（activeGroup 还是 -1）先按第一句居中，歌词才不会贴着顶端加载出来
    const gi = activeGroup >= 0 ? activeGroup : track.children.length > 0 ? 0 : -1;
    const active = gi >= 0 ? (track.children[gi] as HTMLElement | undefined) : undefined;
    const offset = active ? active.offsetTop + active.offsetHeight / 2 - box.clientHeight / 2 : 0;
    baseYRef.current = -offset;
    if (!yReadyRef.current) {
      // 首次进入直接落位，不滚动
      yRef.current = baseYRef.current;
      vRef.current = 0;
      lastFrameRef.current = 0;
      yReadyRef.current = true;
    }
  }, [activeGroup, lyrics, open]);

  // 尺寸变化（拖窗口 / 进出最大化 / 字号切换）后歌词区高度变了，基准要重量一次。
  // 不动 yRef，交给弹簧自己滑过去，避免瞬移。
  useEffect(() => {
    const box = lyricsBoxRef.current;
    if (!box || !open) return;
    const ro = new ResizeObserver(() => {
      const track = trackRef.current;
      const cur = activeGroupRef.current;
      const gi = track && cur < 0 && track.children.length > 0 ? 0 : cur;
      const active = track && gi >= 0 ? (track.children[gi] as HTMLElement | undefined) : undefined;
      if (!active) return;
      baseYRef.current = -(active.offsetTop + active.offsetHeight / 2 - box.clientHeight / 2);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [open]);

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

  /**
   * 阶梯模糊：0 / 1.6 / 3.2 / 4.8 / 6.0。滚轮手动浏览或低功耗时整体关掉。
   * focus 是"视觉焦点句"：正常就是当前句，但在**前奏期间**（activeGroup 还是 -1，
   * 第一句还没到）取第 0 句 —— 否则整首歌开头几十秒里所有行都不模糊、全部 alpha 1，
   * 看上去就像"模糊没加载出来"（Deep End 那种长前奏最明显）。
   */
  const blurFor = useCallback(
    (groupIndex: number, focus: number) => {
      // 低功耗：逐行 filter blur 会产生几十个滤镜表面，直接关掉
      if (blurOff || lowPower || focus < 0) return 0;
      const d = Math.abs(groupIndex - focus);
      if (d === 0) return 0;
      // 每个带 filter 的行都是一个独立滤镜表面，长歌词动辄上百行。
      // 远离当前句的行（≥8 行，早就在渐隐层外面）不再挂滤镜，只留透明度差。
      if (d > BLUR_LIMIT) return 0;
      return BLUR_STEPS[Math.min(BLUR_STEPS.length - 1, d - 1)];
    },
    [blurOff, lowPower]
  );

  /**
   * 透明度：每远离一句只退 9%，到 0.5 停住。
   * 台阶感来自这里 —— 四档跳变会让滚动时像一格一格掉亮度。
   */
  const alphaFor = useCallback(
    (groupIndex: number, focus: number) => {
      if (focus < 0) return 1;
      const d = Math.abs(groupIndex - focus);
      if (d === 0) return 1;
      const a = 1 - 0.09 * d;
      return a < 0.5 ? 0.5 : a;
    },
    []
  );

  // lines 的引用稳定下来，下面两个 memo 才不会被"每次 render 都新建的空数组"击穿
  const lines = useMemo(() => lyrics?.lines ?? [], [lyrics]);
  const hasLyrics = lines.length > 0;
  const synced = !!lyrics?.synced && hasLyrics;

  // 整首歌的主语言：决定"没设置的槽"跟随谁（一首歌一个声音）
  const songSlot = useMemo(() => detectSongSlot(lines.map((l) => l.text)), [lines]);
  // 每个语言槽的完整字体栈（系统正体链）；放进 memo 是为了每帧的进度更新不重算
  const fontStacks = useMemo(() => lyricFontStacks(songSlot), [songSlot]);
  // 纯汉字行怎么归属：一致性优先（默认，一律按中文）或准确优先（跟随歌典主语言）
  const matchPolicy = readMatchPolicy(settingsValues);
  // 每一行归属的语言槽：汉字行按"简体 / 和制汉字 + 同组有没有假名"判
  const lineSlots = useMemo(
    () => detectLineSlots(lines.map((l) => l.text), songSlot, groups, matchPolicy),
    [lines, songSlot, groups, matchPolicy]
  );

  // 每一行最终用的字体栈（memo 保持字符串引用稳定，避免每次 render 触发子节点重绘）
  const lineStacks = useMemo(
    () => lines.map((_, i) => fontStacks.bySlot[lineSlots[i] ?? "latin"]),
    [lines, lineSlots, fontStacks]
  );

  /**
   * 歌词页完全展开后，把被它**完全盖住**的主界面隐藏。
   *
   * 主界面并不是静止的（侧栏/播放条的毛玻璃、卡片……），每产一帧整窗都要重新合成一次。
   * 主界面既然看不见，就不该参与合成。
   * ⚠️ 时序是关键：必须"展开完成后才隐藏、退场一开始就恢复"，否则合成器会丢掉主界面的
   *    绘制结果，重新可见时要重画一帧 = 返回时闪一下。
   * 低功耗模式不做：那时主界面本来就静止，成本≈0，不值得冒重绘风险。
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
        (light ? " is-light" : " is-dark") +
        (lowPower ? " is-flat" : "") +
        (swapping ? " swapping" : "")
      }
      ref={pageRef}
      style={
        {
          // 歌词字体：每个语言槽一条完整字体栈（行上按语言引用）；--lyric-font 保留为主语言栈
          "--lyric-font": fontStacks.primary,
          "--lf-latin": fontStacks.bySlot.latin,
          "--lf-zh": fontStacks.bySlot.zh,
          "--lf-ja": fontStacks.bySlot.ja,
          "--lf-ko": fontStacks.bySlot.ko,
          "--lyric-size": String(lyricFontSize),
          "--lyric-weight": String(lyricFontWeight),
          // 页面基色 = 封面平均色按 --sl-wash 洗白后的结果；白纱强度同样来自封面亮度。
          "--sl-page-rgb": look.pageRgb,
          "--sl-wash": String(look.wash),
        } as CSSProperties
      }
    >
      {/* 全窗底色：稳定态盖满整窗，负责"圆角处不漏白线/黑线"。只做 opacity 淡入 */}
      <div className="sl-veil" ref={veilRef} aria-hidden="true" />
      {/* 进场圆盘：只做小范围绽开（--disc-scale ≈1.45），纹理由此控制在 900px 级 */}
      <div className="sl-disc" ref={discRef} aria-hidden="true" />

      <div className={"sl-stage" + (immersive ? " is-immersive" : "")} ref={stageRef}>
        {/* 背景三层里的第二层：流光。低功耗不做（那时整页是纯色底） */}
        {!lowPower && <FlowingLight texture={look.texture} base={look.avgCss} />}

        <header className="sl-topbar">
          <div className="sl-back">
            <button className="sl-icon-btn" title="返回" aria-label="返回" onClick={closeLyrics}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 5 8 12l7 7" />
              </svg>
            </button>
          </div>
          {/* 曲目信息常显：海报已经去掉了，这里是唯一的"正在放什么"提示 */}
          <div className="sl-head">
            <strong>{current?.title ?? "没有正在播放的歌曲"}</strong>
            <span>{current?.artist ?? "从音乐库选择一首歌"}</span>
          </div>
          <div className="sl-actions">
            <button
              className="sl-icon-btn"
              title={cleared ? "退出沉浸（Esc）" : "沉浸：清屏只留歌词"}
              aria-label={cleared ? "退出沉浸" : "沉浸清屏"}
              onClick={() => setCleared((v) => !v)}
            >
              <Icon name={cleared ? "eye-off" : "eye"} />
            </button>
          </div>
        </header>

        {/* 沉浸清屏：只保留一个极简退出按钮（也可按 Esc） */}
        {cleared && (
          <button className="sl-clear-exit" title="退出沉浸（Esc）" onClick={() => setCleared(false)}>
            <Icon name="minimize" />
          </button>
        )}

        <main className="sl-lyrics-area">
          <section className="sl-lyrics" ref={lyricsBoxRef}>
            {loading ? (
              <div className="sl-empty">
                <span className="sl-spinner" />
                <div className="sl-empty-title">正在读取歌词…</div>
              </div>
            ) : !hasLyrics ? (
              <div className="sl-empty">
                <div className="sl-empty-glyph">♫</div>
                <div className="sl-empty-title">
                  {current ? "这首歌还没有歌词" : "还没有正在播放的歌曲"}
                </div>
                <div className="sl-empty-sub">
                  把同名歌词文件（<code>{current ? current.title : "歌曲名"}.lrc</code>）放到歌曲旁边，
                  <br />
                  或把歌词写进音乐文件的内嵌标签，这里就会自动显示。
                </div>
              </div>
            ) : (
              <div className="sl-track" ref={trackRef}>
                {!synced && <p className="sl-note">纯文本歌词 · 无时间轴</p>}
                {groups.map((group, gi) => {
                  const focus = activeGroup >= 0 ? activeGroup : groups.length > 0 ? 0 : -1;
                  const blur = blurFor(gi, focus);
                  const alpha = alphaFor(gi, focus);
                  return (
                    // 同一时间戳的多行（原词 + 翻译）作为**一个整体**渲染：
                    // 模糊、行距、颜色都落在这一层，原词和翻译永远一起变化。
                    <div
                      key={"g" + gi}
                      className={
                        "sl-g" +
                        (gi === activeGroup ? " is-active" : "") +
                        (!lowPower && focus >= 0 && Math.abs(gi - focus) <= 2
                          ? " is-near"
                          : "")
                      }
                      style={{
                        // 不加 opacity 过渡：几十行同时起过渡会把每一行都提成独立合成层
                        opacity: alpha,
                        filter: blur > 0.05 ? "blur(" + blur.toFixed(2) + "px)" : undefined,
                      }}
                    >
                      {group.map((index, k) => {
                        const line = lines[index];
                        // 这一行的语言：字体栈按它取，lang 属性同时修中日的汉字字形变体
                        const slot = lineSlots[index] ?? "latin";
                        return (
                          <p
                            key={index}
                            // k>0 = 同组里的第二行以后，也就是翻译行（字号 ×0.8）
                            className={"sl-line" + (k > 0 ? " is-tr" : "") + (synced ? " is-clickable" : "")}
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
                            {/* 文字包一层 inline 容器：逐句扫过的渐变按"文字宽度"铺，
                                而不是按整列宽 —— 居中布局下整列 820px 会让 1/4 的行宽打在空白上 */}
                            <span className="sl-in">{line.text}</span>
                          </p>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </main>

        {/* 底栏直接复用主界面播放条（variant="lyrics"），只把外观改成 Salt 的无卡片样式 */}
        <footer className="lyrics-footer sl-footer">
          <PlayerBar variant="lyrics" />
        </footer>
      </div>
    </div>
  );
}
