// 循环封面流 —— 算法逐行移植自「样式设计.html」：
//   索引按 N 取模折叠到 [-2, 2]，中心卡片放大并前移，两侧按距离缩小、内旋、后退
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Album } from "../api/types";
import { Cover } from "./Cover";
import { albumLabel } from "../lib/format";
import { MarqueeText } from "./MarqueeText";
import { frameBudget } from "../lib/frameBudget";
import { isWinFocused, isWindowInvisible, onWindowVisibilityChange } from "../lib/winFocus";
import { useUiStore } from "../stores/uiStore";

// —— 设计稿常量（勿改） ——
const W = 224;
const CENTER_SCALE = 1.095;
const INWARD_ANGLE = 30;
const S1 = 0.86;
const S2 = 0.75;
const Z0 = 80;
const Z1 = 10;
const Z2 = -35;
const CW = W * CENTER_SCALE;
const X1 = Math.round(CW / 2 + (W * S1) / 6);
const X2 = Math.round(X1 + (W * S1) / 2 + (W * S2) / 6);

/** 与 design.css 里 .cf-perspective 的 perspective 保持一致 */
const PERSPECTIVE = 1400;
/** 中心卡的景深放大率：translateZ(Z0) 带来的透视缩放 */
const ZOOM_Z0 = PERSPECTIVE / (PERSPECTIVE - Z0);
/**
 * 中心卡的**视觉**实际倍率 = 设计稿 scale × 透视放大。
 * 中心卡是唯一会被放大到 >1 的卡（两侧都是缩小，缩小永远清晰），
 * 而「scale + translateZ」这条 3D 路径是「先按 1× 栅格化、再由合成器把位图放大」，
 * 于是歌名/艺术家被整体放大 1.16 倍后发虚。
 * 改成与之一模一样的 2D 缩放（--z 归零、--s 直接取视觉倍率）后，
 * 位图按放大后的尺寸栅格化，视觉大小完全不变、笔画锐利。
 */
const CENTER_VIEW_SCALE = +(CENTER_SCALE * ZOOM_Z0).toFixed(5); // 1.16136

/** 循环偏移：把任意索引映射到 [-2, 2]（第一张与最后一张无缝衔接） */
function cyclicOffset(index: number, center: number, n: number): number {
  let offset = index - center;
  while (offset > 2) offset -= n;
  while (offset < -2) offset += n;
  return offset;
}

interface CoverflowProps {
  albums: Album[];
  onSelect: (album: Album) => void;
  /** 查看专辑详情（双击中心封面） */
  /** 双击进专辑已按需求移除；保留可选回调，传了才会响应 */
  onOpen?: (album: Album) => void;
  /** 播放整张专辑（单击中心封面） */
  onPlay: (album: Album) => void;
  /** 正在播放曲目所属专辑：变化时把该专辑移到中间 */
  activeAlbumId?: number | null;
  /** 当前是否处于播放会话（播放/暂停中）：拖动卡片会直接切歌 */
  playbackActive?: boolean;
}

export function Coverflow({ albums, onSelect, onOpen, onPlay, activeAlbumId, playbackActive }: CoverflowProps) {
  const total = albums.length;
  const [centerIndex, setCenterIndex] = useState(0);
  const sectionRef = useRef<HTMLDivElement | null>(null);

  const dragRef = useRef<{ dragging: boolean; startX: number; suppressUntil: number }>({
    dragging: false,
    startX: 0,
    suppressUntil: 0,
  });
  const wheelLockRef = useRef(false);

  // ⚠️ 曾经有一个「切卡时挂 900ms 的 .cf-animating，用 will-change 临时提升合成层」的窗口。
  // 那个窗口在**结束的那一刻**会销毁合成层、把整张卡连同封面重新栅格化一遍：
  // 实测切换后 ~900ms 卡片区域有 1 万多个像素一次性变化（海报肉眼可见地"跳"一下）。
  // 现在改成 .cf-card 常驻 will-change（见 styles/views.css 的 .cf-card），
  // 图层从挂载到卸载只有一次栅格化，切卡全程零重栅格，也就不存在"切完闪一下"。

  // 专辑数量变化时收敛索引，并把选中项同步给上层
  useEffect(() => {
    if (total === 0) return;
    if (centerIndex >= total) setCenterIndex(total - 1);
  }, [total, centerIndex]);

  useEffect(() => {
    if (total === 0) return;
    const album = albums[Math.min(centerIndex, total - 1)];
    if (album) onSelect(album);
    // 仅在中心索引或专辑集合变化时同步
  }, [albums, centerIndex, total, onSelect]);

  // 专辑集合用 ref 读取：避免数组引用变化导致「跟随」把用户的拖动拉回去
  const albumsRef = useRef(albums);
  albumsRef.current = albums;
  const playbackRef = useRef(false);
  playbackRef.current = !!playbackActive;
  const lastFollowRef = useRef<{ id: number; list: Album[] } | null>(null);
  // 用户手动切卡片的「让路窗口」：拖动切歌期间不要被跟随逻辑拉回原位
  const userNavRef = useRef(0);
  const [followNonce, setFollowNonce] = useState(0);

  // 跟随正在播放的曲目：该专辑切换时把它移到中间（同一专辑只跟随一次）
  useEffect(() => {
    if (activeAlbumId == null) {
      lastFollowRef.current = null;
      return;
    }
    const list = albumsRef.current;
    const i = list.findIndex((a) => a.id === activeAlbumId);
    if (i < 0) return;
    const prev = lastFollowRef.current;
    // 正在播放的专辑没变、卡片列表也没重排时不动；否则重新居中
    // （切播放模式会让卡片按播放顺序重排，此时必须跟着走）
    if (prev && prev.id === activeAlbumId && prev.list === list) return;
    const wait = userNavRef.current - Date.now();
    if (wait > 0) {
      // 用户刚拖动过卡片（紧接着会切歌）：等切歌落地后再跟随，别把卡片拉回去
      const timer = window.setTimeout(() => setFollowNonce((n) => n + 1), wait + 60);
      return () => window.clearTimeout(timer);
    }
    lastFollowRef.current = { id: activeAlbumId, list };
    setCenterIndex(i);
  }, [activeAlbumId, albums, total, followNonce]);

  const maxVisible = total >= 5 ? 2 : total >= 3 ? 1 : 0;

  const entries = useMemo(() => {
    if (total === 0) return [];
    const list: { album: Album; index: number; offset: number }[] = [];
    albums.forEach((album, index) => {
      const offset = cyclicOffset(index, centerIndex, total);
      if (Math.abs(offset) <= maxVisible) list.push({ album, index, offset });
    });
    return list;
  }, [albums, centerIndex, total, maxVisible]);

  const playTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (playTimer.current !== null) window.clearTimeout(playTimer.current);
  }, []);

  /** 播放会话中，用户切到的卡片会在停顿后开始播放（防抖，连续拖动只切最后一张） */
  const schedulePlay = useCallback(
    (next: number) => {
      if (playTimer.current !== null) window.clearTimeout(playTimer.current);
      if (!playbackRef.current) return;
      playTimer.current = window.setTimeout(() => {
        const list = albumsRef.current;
        if (list.length === 0) return;
        const album = list[((next % list.length) + list.length) % list.length];
        if (album) onPlay(album);
      }, 420);
    },
    [onPlay]
  );

  const select = useCallback(
    (index: number, byUser = false) => {
      if (total === 0) return;
      let next = index % total;
      if (next < 0) next += total;
      setCenterIndex(next);
      if (byUser) {
        userNavRef.current = Date.now() + 2500;
        schedulePlay(next);
      }
    },
    [total, schedulePlay]
  );

  const move = useCallback(
    (step: number) => {
      select(centerIndex + step, true);
    },
    [centerIndex, select]
  );

  // 全屏 / 窗口变大时按可用空间整体放大（设计稿尺寸为 920×330 的基准）
  const [stageScale, setStageScale] = useState(1);
  useEffect(() => {
    const compute = () => {
      const el = sectionRef.current;
      if (!el) return;
      const width = el.clientWidth || 920;
      const top = el.getBoundingClientRect().top;
      const height = Math.max(0, window.innerHeight - top - 96);
      const k = Math.min(width / 920, height / 330);
      setStageScale(Math.max(1, Math.min(2.2, Number.isFinite(k) ? k : 1)));
    };
    compute();
    window.addEventListener("resize", compute);
    const ro = new ResizeObserver(compute);
    if (sectionRef.current) ro.observe(sectionRef.current);
    return () => {
      window.removeEventListener("resize", compute);
      ro.disconnect();
    };
  }, [total]);

  // 键盘左右切换（输入框聚焦时不响应，与设计稿一致）
  // ⚠️ 与 App.tsx 的全局 ←/→ 是同一按键的两处监听：App 在首页会让路（见那边的注释），
  // 但被歌词页/对话框盖住时首页仍是"当前视图"，此时方向键归 App（切歌）——这里必须让开，
  // 否则会去移动看不见的卡片，还会在 0.42s 后把整个队列换成那张专辑。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
      if (typing) return;
      const ui = useUiStore.getState();
      if (ui.lyricsOpen || ui.dialog) return;
      if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  // 圆点：专辑较多时只显示以当前项为中心的窗口
  const dotIndices = useMemo(() => {
    if (total <= 12) return albums.map((_, i) => i);
    const span = 7;
    const start = Math.max(0, Math.min(total - span, centerIndex - 3));
    return Array.from({ length: span }, (_, k) => start + k);
  }, [albums, centerIndex, total]);

  // 被歌词页/对话框盖住时整个循环不启动：首页仍挂在下面，但没人看得见这些卡片。
  // （歌词页是"全屏毛玻璃 + 逐帧滚动"的最重场景，不该再叠一条看不见的循环。）
  const covered = useUiStore((s) => s.lyricsOpen || !!s.dialog);

  // 播放中的光晕脉冲：原来是一条 3.4s 的 CSS 无限动画（合成器按刷新率跑，绕过帧预算）。
  // 现在由受控 rAF 写 CSS 变量 --cf-glow —— 只有 opacity 变化（走合成层），60fps 上限，
  // 失焦/隐藏/暂停时不写值（= 不产帧）。观感与原动画一致（0.62 到 1 的呼吸）。
  useEffect(() => {
    if (covered) return; // 被盖住：不注册 rAF
    const PERIOD = 3400;
    let raf = 0;
    let curEl: HTMLElement | null = null;
    let curV = -1;
    // 跑马灯的测量缓存：宽度、上一帧位移、真实合成倍率（按元素缓存）
    let trackWidth = new WeakMap<HTMLElement, number>();
    let trackOffset = new WeakMap<HTMLElement, number>();
    let trackScale = new WeakMap<HTMLElement, number>();
    /**
     * 读跑马灯时长（秒）。
     * ⚠️ 不能用 getComputedStyle：它要求样式是最新的，而上一帧刚写过 tr.style.transform，
     * 样式一脏就会在这里触发一次**全文档样式重算**（每帧一次，与视口无关）。
     * MarqueeText 把时长写成行内变量（--marquee-duration）挂在 .marquee 上，
     * 读 element.style 是纯行内声明读取，不参与样式解析 —— 既准确又零开销。
     */
    const durationOf = (tr: HTMLElement): number => {
      const host = tr.parentElement;
      const raw = host ? host.style.getPropertyValue("--marquee-duration") : "";
      const d = raw ? parseFloat(raw) : NaN;
      return Number.isFinite(d) && d > 0 ? d : 9;
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!frameBudget(now)) return;
      const el = sectionRef.current?.querySelector<HTMLElement>('.cf-card.cf-active') ?? null;
      if (!el) return;
      if (el !== curEl) {
        curEl = el;
        curV = -1;
        trackWidth = new WeakMap();
        trackOffset = new WeakMap();
        trackScale = new WeakMap();
      }
      let v = 0;
      const visible = !isWindowInvisible() && isWinFocused();
      if (playbackRef.current && visible) {
        const t = (now % PERIOD) / PERIOD;
        const o = 0.62 + 0.38 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
        v = Math.round(o * 1000) / 1000;
      }
      if (v !== curV) { curV = v; el.style.setProperty('--cf-glow', String(v)); }
      // 顺带驱动「活动卡」的跑马灯：原来也是无限 CSS 动画（按刷新率跑，绕过帧预算）。
      // 现在由同一条 rAF 写 transform —— 它本来就是极慢的匀速滚动，60fps 下观感完全一样。
      if (visible) {
        const tracks = sectionRef.current?.querySelectorAll<HTMLElement>(
          '.cf-card.cf-active .cf-meta .marquee .marquee-track'
        );
        const dpr = window.devicePixelRatio || 1;
        tracks?.forEach((tr) => {
          const d = durationOf(tr);
          const p = ((now / 1000) % d) / d;
          let width = trackWidth.get(tr);
          if (width === undefined) {
            const first = tr.firstElementChild as HTMLElement | null;
            width = first ? first.scrollWidth : tr.scrollWidth / 2;
            trackWidth.set(tr, width);
          }
          // ⚠️ 位移必须落在整设备像素上。原来写的是 -50% * p（小数）：文字层每帧都
          // 被合成在非整数偏移上，字形边缘一律糊一层灰 —— 长标题滚动时最明显。
          // 但「设备像素」不等于 1/dpr：这个 track 还在 .cf-card 的 scale+透视里，
          // 一个 CSS px 实际落到 1.17 * dpr 个物理像素上，所以按 rect/offsetWidth
          // 量出这张卡的真实倍率再取整，否则等于没对齐。
          // 26px/s 下每帧只走半个物理像素，取整后的步进肉眼看不出来。
          let eff = trackScale.get(tr);
          if (eff === undefined) {
            const box = tr.getBoundingClientRect();
            const layout = tr.offsetWidth || box.width;
            eff = (layout > 0 ? box.width / layout : 1) * dpr;
            if (!(eff > 0.1)) eff = dpr;
            trackScale.set(tr, eff);
          }
          const snapped = Math.round(-width * p * eff) / eff;
          if (trackOffset.get(tr) === snapped) return;
          trackOffset.set(tr, snapped);
          tr.style.transform = 'translateX(' + snapped.toFixed(3) + 'px)';
        });
      }
    };
    // 失焦/隐藏时直接停掉 rAF（而不是在回调里早退）：没人看的时候连一次调度都不付。
    const start = () => {
      if (raf === 0) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf !== 0) { cancelAnimationFrame(raf); raf = 0; }
      // 复位缓存：重新可见时按当时的元素重新取一次
      curEl = null;
      curV = -1;
    };
    const sync = () => {
      if (!isWindowInvisible() && isWinFocused()) start();
      else stop();
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    // 合并信号：document.visibilitychange + Tauri 的 win-hidden（最小化/托盘）。
    // WebView2 最小化时不一定置 document.hidden，只监听页面会漏掉这种「根本没在屏幕上」。
    const offVisibility = onWindowVisibilityChange(sync);
    return () => {
      stop();
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      offVisibility();
    };
  }, [covered]);

  if (total === 0) return null;

  return (
    <div
      className="coverflow-section"
      ref={sectionRef}
      onPointerDown={(e) => {
        dragRef.current.dragging = true;
        dragRef.current.startX = e.clientX;
      }}
      onPointerUp={(e) => {
        if (!dragRef.current.dragging) return;
        dragRef.current.dragging = false;
        const distance = e.clientX - dragRef.current.startX;
        if (Math.abs(distance) < 50) return;
        move(distance < 0 ? 1 : -1);
        dragRef.current.suppressUntil = Date.now() + 400;
      }}
      onPointerCancel={() => {
        dragRef.current.dragging = false;
      }}
      onWheel={(e) => {
        if (wheelLockRef.current) return;
        wheelLockRef.current = true;
        move(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
        setTimeout(() => {
          wheelLockRef.current = false;
        }, 350);
      }}
    >
      {/* 全屏/大窗口下按可用空间整体放大，内部几何仍沿用设计稿常量。
          ⚠️ 用 `zoom`（布局级缩放）而不是 `transform: scale()`：transform 是"先按原始尺寸渲染、
          再把位图拉伸"，卡片上的专辑名/艺术家会被整体放大 ~1.29 倍后发虚（项目里 125% 显示缩放
          下尤其明显）；zoom 会让文字**按放大后的尺寸排版与栅格化**，视觉大小完全相同但清楚得多。
          实测（125% 缩放、同一视觉字号）：transform 版笔画发糊，zoom 版锐利。
          .cf-perspective 是 flex 居中的，所以 zoom 不需要额外补偿 margin。 */}
      <div className="cf-stage" style={{ height: 330 * stageScale }}>
        <div
          className="cf-perspective"
          style={{ zoom: stageScale, ["--cf-k" as string]: String(CENTER_VIEW_SCALE) } as CSSProperties}
        >
          {entries.map(({ album, index, offset }) => {
            const distance = Math.abs(offset);
            const direction = offset < 0 ? -1 : 1;
            // CSS 变量由设计稿的 transform 规则消费（--x/--z/--s/--r/--o）
            // 中心卡：z 归零 + s 取视觉倍率（等价 2D 缩放）；
            // 切卡时这些值仍在 transform 内连续插值，所以动画不会跳变。
            const cssVars = {
              "--x": offset === 0 ? "0px" : direction * (distance === 1 ? X1 : X2) + "px",
              "--z": offset === 0 ? "0px" : (distance === 1 ? Z1 : Z2) + "px",
              "--s": String(offset === 0 ? CENTER_VIEW_SCALE : distance === 1 ? S1 : S2),
              "--r": offset === 0 ? "0deg" : direction * -INWARD_ANGLE + "deg",
              "--o": String(offset === 0 ? 1 : distance === 1 ? 0.96 : 0.84),
            } as CSSProperties;
            const zIndex = offset === 0 ? 50 : distance === 1 ? 40 : 30;
            return (
              <div
                key={album.id}
                className={"cf-card" + (offset === 0 ? " cf-active" : "")}
                style={{ ...cssVars, zIndex }}
                role="button"
                aria-label={albumLabel(album.singleTitle ?? album.name) + " - " + album.artist}
                onClick={() => {
                  if (Date.now() < dragRef.current.suppressUntil) return;
                  // 中心封面：点击直接播放这张专辑；两侧：先切到中间
                  if (offset === 0) onPlay(album);
                  else select(index, true);
                }}
                onDoubleClick={() => {
                  if (Date.now() < dragRef.current.suppressUntil) return;
                  if (offset === 0) onOpen?.(album);
                }}
              >
                <Cover className="cf-cover" trackId={album.id} seed={album.id} />
                <div className="cf-meta">
                  <MarqueeText text={albumLabel(album.singleTitle ?? album.name)} />
                  <MarqueeText as="p" text={album.artist} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="cf-dots">
        {dotIndices.map((i) => (
          <button
            key={i}
            type="button"
            className={"cf-dot" + (i === centerIndex ? " active" : "")}
            aria-label={"切换到第 " + (i + 1) + " 张专辑"}
            onClick={() => select(i, true)}
          />
        ))}
      </div>
    </div>
  );
}
