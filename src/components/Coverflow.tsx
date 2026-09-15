// 循环封面流 —— 算法逐行移植自「样式设计.html」：
//   索引按 N 取模折叠到 [-2, 2]，中心卡片放大并前移，两侧按距离缩小、内旋、后退
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Album } from "../api/types";
import { Cover } from "./Cover";
import { albumLabel } from "../lib/format";
import { MarqueeText } from "./MarqueeText";
import { frameBudget } from "../lib/frameBudget";
import { isWinFocused } from "../lib/winFocus";

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (typing) return;
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

  // 播放中的光晕脉冲：原来是一条 3.4s 的 CSS 无限动画（合成器按刷新率跑，绕过帧预算）。
  // 现在由受控 rAF 写 CSS 变量 --cf-glow —— 只有 opacity 变化（走合成层），60fps 上限，
  // 失焦/隐藏/暂停时不写值（= 不产帧）。观感与原动画一致（0.62 到 1 的呼吸）。
  useEffect(() => {
    const PERIOD = 3400;
    let raf = 0;
    let curEl: HTMLElement | null = null;
    let curV = -1;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!frameBudget(now)) return;
      const el = sectionRef.current?.querySelector<HTMLElement>('.cf-card.cf-active') ?? null;
      if (!el) return;
      if (el !== curEl) { curEl = el; curV = -1; }
      let v = 0;
      const visible = !document.hidden && isWinFocused();
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
        tracks?.forEach((tr) => {
          const d = parseFloat(getComputedStyle(tr).getPropertyValue('--marquee-duration')) || 9;
          const p = ((now / 1000) % d) / d;
          tr.style.transform = 'translateX(' + (-50 * p).toFixed(3) + '%)';
        });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

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
        <div className="cf-perspective" style={{ zoom: stageScale }}>
          {entries.map(({ album, index, offset }) => {
            const distance = Math.abs(offset);
            const direction = offset < 0 ? -1 : 1;
            // CSS 变量由设计稿的 transform 规则消费（--x/--z/--s/--r/--o）
            const cssVars = {
              "--x": offset === 0 ? "0px" : direction * (distance === 1 ? X1 : X2) + "px",
              "--z": offset === 0 ? Z0 + "px" : (distance === 1 ? Z1 : Z2) + "px",
              "--s": String(offset === 0 ? CENTER_SCALE : distance === 1 ? S1 : S2),
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
