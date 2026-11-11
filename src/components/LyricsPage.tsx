// 沉浸式歌词页。
//
// 视觉规范取自 Salt Player 的播放页设计文档（《SaltPlayer-播放页前端设计文档.md》/
// 《SaltPlayer-播放页视觉逆向分析.md》），几条是这个页面必须守住的：
//
//   · 明暗只跟主题枚举走，不看封面亮度：
//       深色 → 纯黑底 + 纯白前景；浅色 → 纯白底 + **封面主色**做前景（取不到回退 #050F19）。
//   · 背景三层：底色（黑/白）→ 流光（FlowingLight）→ 内容。
//     流光自己带压暗蒙层，所以播放页**没有**额外的 scrim，也没有卡片、分割线、渐变按钮。
//   · 歌词：基准 24 × 倍率；当前句按设置放大（默认 1.5×，只放大字号 —— transform
//     会先栅格再放大、文字发虚），再靠"阶梯模糊 + alpha 差"区分远近；
//     相邻 1/2/3/≥4 行分别是 1.7 / 3.3 / 4.9 / 6.2 的模糊。
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
import { LangPicker } from "./LangPicker";
import { PlayerBar } from "./PlayerBar";
import { FlowingLight } from "./FlowingLight";
import { FALLBACK_LOOK, sampleCover } from "../lib/coverColor";
import type { CoverLook } from "../lib/coverColor";
import { useCover } from "../lib/cover";
import { frameBudget } from "../lib/frameBudget";
import { usePlayerStore } from "../stores/playerStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  buildStacks,
  detectLineProfiles,
  detectSongProfile,
  fontFamilyName,
  OVERRIDE_AUTO,
  OVERRIDES_KEY,
  PROFILES,
  PROFILE_LIST,
  profileLang,
  readActiveScale,
  readMatchPolicy,
  readOverrides,
  readProfiles,
  readShowSource,
  readSize,
  readWeight,
  resolveSongProfile,
  serializeOverrides,
  setOverride,
  splitLineRuns,
} from "../lib/lyricFont";
import type { FontProfileId, LineRun } from "../lib/lyricFont";
import { layoutLyricLines } from "../lib/lyricLines";
import { ensureFontsRegistered, useFontStore } from "../stores/fontStore";
import { useUiStore, toast } from "../stores/uiStore";

/** 诊断用：一段文字的 Unicode 码位列表（"U+4F60 U+597D"），超过 12 个就省略 */
function codepointsOf(text: string): string {
  const list: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (/s/.test(ch)) continue;
    list.push("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
    if (list.length >= 12) break;
  }
  return list.join(" ");
}

/** 鼠标静止多久后进入沉浸模式（3s） */
const IMMERSIVE_DELAY = 3200;

/* ===== 歌词滚动 =====
   滚动用的是过阻尼弹簧（ζ≈1.12、k≈190）。ζ>1 = 永远不会过冲回弹，
   换句时是一段"快起、慢收"的位移，而不是我们原来那条匀速直线。
   换算成这里的微分方程：m=1，c = 2ζ√k ≈ 30.9，a = -k·x - c·v。
   （逐行错峰延迟（50ms/1.05^k）没有做：那会给十几行同时挂 transform 动画，
    和本项目"歌词只动一层 transform、一次 reflow"的约束直接冲突，收益也看不出来。） */
const SPRING_K = 190;
const SPRING_ZETA = 1.12;
const SPRING_C = 2 * SPRING_ZETA * Math.sqrt(SPRING_K);
/** 单帧最大步进（毫秒）：窗口卡顿/后台恢复后不至于瞬移 */
const SPRING_DT_MAX = 48;
/** 速度上限（px/s）：从第一句直接跳到第 300 句时，别让整列文字糊成一条线 */
const SPRING_VMAX = 6800;
/** 最后一句没有下一句时，假定这一句唱 5.2s（扫过动画不会卡在中间） */
const LAST_LINE_MS = 5200;

/**
 * 阶梯模糊（px）：当前句 0，往外 1.7 / 3.3 / 4.9 / 6.2。
 *
 * 和原来"近 5px、每行 +2、上限 12"的区别：Salt 的模糊是**很轻**的一层雾，
 * 靠的是"只有当前句是实的"这个对比，而不是把远处糊成色块。糊到 12px 时，
 * 一屏之内所有非当前行都变成同样的灰条，行数信息就没了。
 */
const BLUR_STEPS = [1.7, 3.3, 4.9, 6.2];
/** 只有离当前句这么近的行才真的挂 filter（见 blurFor 的注释）。 */
const BLUR_LIMIT = 7;

/** 滚轮回位时长（毫秒） */
const WHEEL_RETURN_MS = 500;

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
  // 进度单独订阅（见 playerStore 的说明）：避免进度事件让整个应用重渲染
  const progressSecs = usePlayerStore((s) => s.positionSecs);
  const seek = usePlayerStore((s) => s.seek);
  const settingsValues = useSettingsStore((s) => s.values);
  const writeSetting = useSettingsStore((s) => s.set);
  // 字体库：资源列表一次性加载，注册成 FontFace 后浏览器才认这条链
  const fontResources = useFontStore((s) => s.resources);
  const fontStatus = useFontStore((s) => s.status);
  const loadFonts = useFontStore((s) => s.load);
  useEffect(() => {
    if (fontStatus === "idle") void loadFonts();
  }, [fontStatus, loadFonts]);

  // 歌词字体：字号 / 字重 / 当前句缩放来自设置；「用哪个字体」来自字体库 + 六份语言档案。
  // 具体规则全在 src/lib/lyricFont.ts，这里只负责把结果搬到 style 上。
  const lyricFontSize = readSize(settingsValues);
  const lyricFontWeight = readWeight(settingsValues);
  // 当前句放大倍率（1 = 不放大，默认 1.5）
  const lyricActiveScale = readActiveScale(settingsValues);

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
  /** 顶栏语言下拉是否展开：展开期间压住沉浸计时器，否则选到一半菜单先淡出了 */
  const [langMenuOpen, setLangMenuOpen] = useState(false);
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

  const position = progressSecs;

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
    setSwapping(true);
    const t = window.setTimeout(() => setSwapping(false), 480);
    return () => window.clearTimeout(t);
  }, [current?.trackId]);

  // 沉浸模式：鼠标/键盘静止 3s 后隐藏上下控件
  useEffect(() => {
    if (!open) return;
    const reset = () => {
      setImmersive(false);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      if (langMenuOpen) return; // 下拉展开中：顶栏连同菜单一起留住
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
    // langMenuOpen 进依赖：菜单一展开就立刻取消已经排好的隐藏任务
  }, [open, langMenuOpen]);

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
  }, [open, geo]);

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
  }, [mounted, open, geo]);

  // 一条歌词可能不止一行文字 —— 原文 + 翻译。两种写法都要认：
  //   ① 共用时间戳（英文歌常见）
  //   ② 翻译行时间戳更晚（《王的归来（I'm King）》那类：翻译追在原文后面 0.3~12 秒）
  // 判据在 lib/lyricLines，React 和体检脚本（npm run check:lyrics）用的是同一套。
  const layout = useMemo(
    () =>
      layoutLyricLines(
        (lyrics?.lines ?? []).map((l) => ({ timeMs: l.timeMs, text: l.text })),
        !!lyrics?.synced
      ),
    [lyrics]
  );
  const groups = layout.groups;
  // 翻译行：渲染小一号，且不参与整首语言判定（翻译的文字体系是译者选的，不是这首歌的语言）
  const translation = layout.translation;

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
      if (karaokeRef.current) {
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
          const swept = Math.max(950, Math.min(4300, t1 - t0));
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
  }, [open, lyrics, groups]);

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
    // 当前句字号是 280ms 过渡放大的，上面量到的是**放大前**的高度 → 目标位会稳定偏下半个高差。
    // 过渡结束后再对一次中心（改的是 baseY，弹簧自己滑过去，不会瞬移）。
    const settle = window.setTimeout(() => {
      const bx = lyricsBoxRef.current;
      const tr = trackRef.current;
      if (!bx || !tr) return;
      const cur = activeGroupRef.current;
      const idx = cur >= 0 ? cur : tr.children.length > 0 ? 0 : -1;
      const el = idx >= 0 ? (tr.children[idx] as HTMLElement | undefined) : undefined;
      if (!el) return;
      baseYRef.current = -(el.offsetTop + el.offsetHeight / 2 - bx.clientHeight / 2);
    }, 320);
    return () => window.clearTimeout(settle);
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
   * 「滚轮浏览 → 暂时取消模糊」的唯一出口必须是可靠的。
   *
   * 这个状态以前只有两个出口：2.6s 的定时器，以及重开歌词页。切歌时歌词数据变化会让上面的
   * 滚轮 effect 重新挂载 —— 清理函数把那个定时器 clear 掉，而 blurOff 还留在 true，
   * 于是「滚一下、在回位前切歌」会让**之后的每一首**都没有阶梯模糊。
   * 这里把切歌 / 重开都补成强制复位：定时器一起清，状态一起清。
   */
  useEffect(() => {
    if (wheelTimer.current !== null) {
      window.clearTimeout(wheelTimer.current);
      wheelTimer.current = null;
    }
    setBlurOff(false);
  }, [current?.trackId, open]);

  /**
   * 阶梯模糊：0 / 1.7 / 3.3 / 4.9 / 6.2。滚轮手动浏览时整体关掉。
   * focus 是"视觉焦点句"：正常就是当前句，但在**前奏期间**（activeGroup 还是 -1，
   * 第一句还没到）取第 0 句 —— 否则整首歌开头几十秒里所有行都不模糊、全部 alpha 1，
   * 看上去就像"模糊没加载出来"（Deep End 那种长前奏最明显）。
   */
  const blurFor = useCallback(
    (groupIndex: number, focus: number) => {
      if (blurOff || focus < 0) return 0;
      const d = Math.abs(groupIndex - focus);
      if (d === 0) return 0;
      // 每个带 filter 的行都是一个独立滤镜表面，长歌词动辄上百行。
      // 远离当前句的行（≥8 行，早就在渐隐层外面）不再挂滤镜，只留透明度差。
      if (d > BLUR_LIMIT) return 0;
      return BLUR_STEPS[Math.min(BLUR_STEPS.length - 1, d - 1)];
    },
    [blurOff]
  );

  /**
   * 透明度：每远离一句只退 8.8%，到 0.52 停住。
   * 台阶感来自这里 —— 四档跳变会让滚动时像一格一格掉亮度。
   */
  const alphaFor = useCallback(
    (groupIndex: number, focus: number) => {
      if (focus < 0) return 1;
      const d = Math.abs(groupIndex - focus);
      if (d === 0) return 1;
      const a = 1 - 0.088 * d;
      return a < 0.52 ? 0.52 : a;
    },
    []
  );

  // lines 的引用稳定下来，下面两个 memo 才不会被"每次 render 都新建的空数组"击穿
  const lines = useMemo(() => lyrics?.lines ?? [], [lyrics]);
  const hasLyrics = lines.length > 0;
  const synced = !!lyrics?.synced && hasLyrics;

  // 整首歌归属哪个档案：假名 / 谚文是硬证据，简体字与日式汉字是软证据（权重见 lyricFont）
  const detectedProfile = useMemo(
    () => detectSongProfile(lines.map((l) => l.text), translation),
    [lines, translation]
  );
  // 歌曲级语言覆盖（§5.4）：统计判错时用户只改这一首，settings 里按曲目 id 存一条
  const overrides = useMemo(() => readOverrides(settingsValues), [settingsValues]);
  const trackKey = current?.trackId ?? null;
  const overrideProfile = resolveSongProfile(null, overrides, trackKey);
  // 覆盖优先，其次统计判定（空歌词时 detectSongProfile 给 symbols）
  const songProfile: FontProfileId = overrideProfile ?? detectedProfile ?? "latin";
  // 六份档案的配置（主字体 / 备用字体 / 缺字策略），存在 settings 的 lyricFontProfiles 里
  const profiles = useMemo(() => readProfiles(settingsValues), [settingsValues]);
  // 每份档案一条链：主字体 → 备用字体 → 该语言系统链 → sans-serif
  const stacks = useMemo(() => buildStacks(profiles, fontResources), [profiles, fontResources]);
  // 纯汉字行怎么归属：整首一致（默认）或逐行按证据
  const matchPolicy = readMatchPolicy(settingsValues);
  // 每一行归属的档案（同组翻译行跟随原词，见 detectLineProfiles）
  const lineProfiles = useMemo(
    () => detectLineProfiles(lines.map((l) => l.text), songProfile, matchPolicy, groups, translation),
    [lines, songProfile, matchPolicy, groups, translation]
  );

  // 链里出现的导入字体必须真的注册过（document.fonts.add）才会生效。
  // 注册是异步的：注册完 +1 个 epoch 让下面几个 memo 重算一次，避免"首帧是系统字体"。
  const [fontEpoch, setFontEpoch] = useState(0);
  const userFontIds = useMemo(() => Array.from(new Set(Object.values(stacks).flatMap((s) => s.userFontIds))), [stacks]);
  const userFontKey = userFontIds.join("|");
  useEffect(() => {
    if (!userFontIds.length) return;
    let alive = true;
    void ensureFontsRegistered(userFontIds).then(() => {
      if (alive) setFontEpoch((n) => n + 1);
    });
    return () => {
      alive = false;
    };
    // 依赖用 join 出来的键：userFontIds 每次 memo 都是新数组，直接当依赖会无限重注册
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userFontKey]);

  // 每一行最终用的字体链（memo 保持字符串引用稳定，避免每次 render 触发子节点重排）
  const lineStacks = useMemo(
    () => lines.map((_, i) => stacks[lineProfiles[i] ?? "latin"].css),
    [lines, lineProfiles, stacks, fontEpoch]
  );

  // §11「显示实际字体来源」：把每行拆成"主字体出的字"和"回退来的字"，各挂各的链
  const showSource = readShowSource(settingsValues);
  const resourceById = useMemo(() => new Map(fontResources.map((r) => [r.id, r])), [fontResources]);
  const primaryOf = useCallback(
    (id: FontProfileId) => {
      const pid = profiles[id].primaryFontId;
      return pid ? resourceById.get(pid) ?? null : null;
    },
    [profiles, resourceById]
  );
  const lineRuns = useMemo(() => {
    if (!showSource) return null;
    return lines.map((line, i) => {
      const profile = lineProfiles[i] ?? "latin";
      // 这一行所属档案没导入字体 → 整行本来就是系统链，标不出更细的来源，不拆
      if (!primaryOf(profile)) return null;
      return splitLineRuns(line.text, profile, primaryOf, true);
    });
  }, [showSource, lines, lineProfiles, primaryOf]);

  /** 一段文字该挂哪条链：主字体覆盖的段只挂主字体，缺字段挂整条回退链 */
  const runCss = useCallback(
    (run: LineRun) => {
      const chain = stacks[run.profile];
      if (run.fallback) return chain.css;
      const first = chain.userFontIds[0];
      return first ? '"' + fontFamilyName(first) + '", sans-serif' : chain.css;
    },
    [stacks]
  );

  /**
   * 歌词页完全展开后，把被它**完全盖住**的主界面隐藏。
   *
   * 主界面并不是静止的（侧栏/播放条的毛玻璃、卡片……），每产一帧整窗都要重新合成一次。
   * 主界面既然看不见，就不该参与合成。
   * ⚠️ 时序是关键：必须"展开完成后才隐藏、退场一开始就恢复"，否则合成器会丢掉主界面的
   *    绘制结果，重新可见时要重画一帧 = 返回时闪一下。
   */
  useLayoutEffect(() => {
    const shell = document.querySelector(".app-shell");
    if (!shell) return;
    if (mounted && open && !phase) shell.classList.add("lyrics-covered");
    return () => shell.classList.remove("lyrics-covered");
  }, [mounted, open, phase]);

  if (!mounted) return null;

  return (
    <div
      className={
        "lyrics-page" +
        (staged ? " staged" : "") +
        (phase === "in" ? " entering" : phase === "out" ? " leaving" : "") +
        (cleared ? " cleared" : "") +
        " is-dark" +
        (swapping ? " swapping" : "")
      }
      ref={pageRef}
      style={
        {
          // 六份档案的链暴露成 CSS 变量：行上直接引用，诊断色的图例也能取用
          "--lf-zhHans": stacks.zhHans.css,
          "--lf-zhHant": stacks.zhHant.css,
          "--lf-ja": stacks.ja.css,
          "--lf-ko": stacks.ko.css,
          "--lf-latin": stacks.latin.css,
          "--lf-symbols": stacks.symbols.css,
          "--lf-main": stacks[songProfile].css,
          "--lyric-size": String(lyricFontSize),
          "--lyric-weight": String(lyricFontWeight),
          "--sl-active-scale": String(lyricActiveScale),
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
        {/* 背景三层里的第二层：流光 */}
        <FlowingLight texture={look.texture} base={look.avgCss} />

        <header className="sl-topbar">
          <div className="sl-back">
            <button className="sl-icon-btn" aria-label="返回" onClick={closeLyrics}>
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
            {/* 歌曲级语言覆盖（§5.4）：只影响这一首，不动六份档案的配置 */}
            {hasLyrics && (
              <LangPicker
                label="语言"
                title="这首歌按哪种语言排版。默认按歌词统计判定，判错时可以只改这一首。"
                ariaLabel={"这首歌的歌词语言：" + (overrideProfile ? PROFILES[overrideProfile].label : "自动")}
                value={overrideProfile ?? OVERRIDE_AUTO}
                options={[
                  { id: OVERRIDE_AUTO, label: "自动（" + PROFILES[songProfile].label + "）" },
                  ...PROFILE_LIST.map((p) => ({ id: p.id as string, label: p.label })),
                ]}
                onOpenChange={setLangMenuOpen}
                onChange={(value) => {
                  const id = (value || null) as FontProfileId | null;
                  void writeSetting(OVERRIDES_KEY, serializeOverrides(setOverride(overrides, trackKey, id)));
                  toast(
                    id
                      ? "这首歌的歌词改用「" + PROFILES[id].label + "」的字体"
                      : "这首歌的歌词语言改回自动判定",
                    "info",
                  );
                }}
              />
            )}
            <button
              className="sl-icon-btn"
              aria-label={cleared ? "退出沉浸" : "沉浸清屏"}
              onClick={() => setCleared((v) => !v)}
            >
              <Icon name={cleared ? "eye-off" : "eye"} />
            </button>
          </div>
        </header>

        {/* 沉浸清屏：只保留一个极简退出按钮（也可按 Esc） */}
        {cleared && (
          <button className="sl-clear-exit" aria-label="退出沉浸" onClick={() => setCleared(false)}>
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
                  // 点哪一行都跳到这一条的演唱时刻：翻译行的时间戳是它出现的时间，
                  // 不是唱到这一句的时间，拿它 seek 会跳过头。
                  const headMs = lines[group[0]].timeMs;
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
                        (focus >= 0 && Math.abs(gi - focus) <= 2 ? " is-near" : "")
                      }
                      style={{
                        // 不加 opacity 过渡：几十行同时起过渡会把每一行都提成独立合成层
                        opacity: alpha,
                        filter: blur > 0.05 ? "blur(" + blur.toFixed(2) + "px)" : undefined,
                      }}
                    >
                      {group.map((index, k) => {
                        const line = lines[index];
                        // 这一行的档案：字体链按它取，lang 属性同时修中日的汉字字形变体
                        const profile = lineProfiles[index] ?? "latin";
                        const runs = lineRuns?.[index] ?? null;
                        return (
                          <p
                            key={index}
                            // k>0 = 同组里的第二行以后，也就是翻译行（字号 ×0.8）
                            className={"sl-line" + (k > 0 ? " is-tr" : "") + (synced ? " is-clickable" : "")}
                            lang={profileLang(profile)}
                            style={{ fontFamily: lineStacks[index] }}
                            onClick={
                              synced
                                ? () => {
                                    wheelYRef.current = 0;
                                    setBlurOff(false); // 点句跳转 = 结束手动浏览，模糊立刻回来
                                    void seek(headMs / 1000);
                                  }
                                : undefined
                            }
                          >
                            {/* 文字包一层 inline 容器：逐句扫过的渐变按"文字宽度"铺，
                                而不是按整列宽 —— 居中布局下整列 820px 会让 1/4 的行宽打在空白上。
                                开了「显示实际字体来源」时，这一段会按"主字体 / 回退"再切成几段：
                                主字体段只挂主字体，缺字段挂整条链 —— 于是眼睛看到的字面来源就是真的。 */}
                            <span className="sl-in">
                              {runs
                                ? runs.map((run, ri) => (
                                    <span
                                      key={ri}
                                      className={"sl-run" + (run.fallback ? " is-fb" : "")}
                                      style={{ fontFamily: runCss(run) }}
                                      title={
                                        run.fallback
                                          ? "这几个字主字体没有，实际由该语言的系统字体渲染（点开看码位）"
                                          : "这一段的字来自主字体"
                                      }
                                      onClick={
                                        run.fallback
                                          ? (e) => {
                                              // 诊断模式（§7.3）：点回退段给出缺字列表 + 码位，同时别让点击顺带跳转播放
                                              e.stopPropagation();
                                              toast(
                                                "主字体缺这几个字，已回退到系统字体：" +
                                                  codepointsOf(run.text) +
                                                  (run.profile === songProfile ? "" : "（" + PROFILES[run.profile].label + "档案）"),
                                                "info",
                                              );
                                            }
                                          : undefined
                                      }
                                    >
                                      {run.text}
                                    </span>
                                  ))
                                : line.text}
                            </span>
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
