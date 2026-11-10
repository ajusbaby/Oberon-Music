// 播放进度条：M3 风格的波浪滑块（canvas 绘制）
//
// 已播放部分是一条**波形**、未播放部分是平直轨道、右端一个圆形手柄。
// 波形振幅在靠近手柄处收敛到 0，所以线端精确落在手柄圆心（不收敛的话
// 线会在手柄边缘被截断一截，看着像断的）。
//
// 颜色全部走 CSS 变量（--wp-track / --wp-active），这样歌词页那边只需要改变量、
// 不必动尺寸 —— 冒烟里有一条断言要求两个播放条的进度条几何完全一致。
// 本组件只负责画和拖动，秒数换算留在 PlayerBar。

import { useCallback, useEffect, useRef } from "react";

interface WaveProgressProps {
  /** 播放进度 0..1 */
  value: number;
  /** 播放中：波浪缓慢流动 */
  playing: boolean;
  /** 未载入曲目：不响应指针 */
  disabled?: boolean;
  /** 拖动过程中回调（用于界面即时反馈） */
  onScrub?: (ratio: number) => void;
  /** 松手时回调（用于真正跳转） */
  onCommit: (ratio: number) => void;
}

/** 轨道高（悬停时加粗到 TRACK_H_HOVER，沿用原先 4→6px 的手感） */
const TRACK_H = 4;
const TRACK_H_HOVER = 6;
/** 手柄半径。M3 的 HandleWidth 是 20dp、轨道 4dp；这里按播放条的体量收小一档 */
const HANDLE_R = 7;
/** 波形：振幅 / 波长 / 线粗 */
const WAVE_AMP = 3.2;
const WAVE_LEN = 22;
const WAVE_W = 3;
/** 左右留白 = 手柄半径 + 1，保证手柄整圆可见 */
const PAD = HANDLE_R + 1;
const TAU = Math.PI * 2;

/** 比 smoothstep 更平缓：端点一阶二阶导都为 0，收敛处看不出折角 */
import { frameBudget } from "../lib/frameBudget";
import { isWindowInvisible, onWindowVisibilityChange } from "../lib/winFocus";

function smootherstep(t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function WaveProgress({ value, playing, disabled, onScrub, onCommit }: WaveProgressProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 用 ref 承载每帧要读的值：rAF 循环只建一次，不因为 props 变化重建
  const live = useRef({
    value,
    playing,
    dragging: false,
    hover: 0,
    hoverTarget: false,
    phase: 0,
    drawnValue: -1,
    drawnPhase: 0,
    dirty: true,
  });
  // 按需点火的入口：effect 内部把真正的 kick 挂在这里。
  // 事件与 props 变化都走它 —— 没有逐帧变化时循环是停着的，必须有人把它叫醒。
  const kickRef = useRef<() => void>(() => {});
  live.current.value = value;
  live.current.playing = playing;
  // 进度 / 播放态变化：重画一帧；播放中由循环自己接着跑
  useEffect(() => {
    kickRef.current();
  }, [value, playing]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const colors = { track: "rgba(0,0,0,0.12)", active: "#1D1D1F" };
    const readColors = () => {
      const cs = getComputedStyle(wrap);
      colors.track = cs.getPropertyValue("--wp-track").trim() || colors.track;
      colors.active = cs.getPropertyValue("--wp-active").trim() || colors.active;
    };
    readColors();

    let W = 0;
    let H = 0;
    let raf = 0;
    let last = performance.now();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const draw = () => {
      if (!W || !H) return;
      const s = live.current;
      const cy = H / 2;
      const trackH = TRACK_H + (TRACK_H_HOVER - TRACK_H) * s.hover;
      const x0 = PAD;
      const x1 = W - PAD;
      const px = x0 + (x1 - x0) * Math.min(1, Math.max(0, s.value));

      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // 未播放轨道：从手柄画到右端
      if (x1 - px > 0.5) {
        ctx.beginPath();
        ctx.lineWidth = trackH;
        ctx.strokeStyle = colors.track;
        ctx.moveTo(px, cy);
        ctx.lineTo(x1, cy);
        ctx.stroke();
      }

      // 已播放：波形。振幅在手柄附近收敛到 0，末端精确落回圆心
      const span = px - x0;
      if (span > 0.5) {
        // 衰减长度不超过已播放长度的一半，否则进度很短时整段被压平
        const fadeLen = Math.min(PAD + 8, span * 0.55);
        ctx.beginPath();
        ctx.lineWidth = WAVE_W;
        ctx.strokeStyle = colors.active;
        let started = false;
        for (let x = x0; x < px; x += 0.5) {
          const d = px - x;
          const env = d >= fadeLen ? 1 : smootherstep(d / fadeLen);
          const y = cy + WAVE_AMP * env * Math.sin(((x - x0) / WAVE_LEN) * TAU + s.phase);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.lineTo(px, cy);
        ctx.stroke();
      }

      // 手柄
      ctx.beginPath();
      ctx.arc(px, cy, HANDLE_R, 0, TAU);
      ctx.fillStyle = colors.active;
      ctx.fill();

      s.drawnValue = s.value;
      s.drawnPhase = s.phase;
    };

    /**
     * 还有没有"在动"的东西：波浪在流动 / 正在拖拽 / hover 过渡还没走完。
     * 三者都不成立时就没有任何逐帧变化的量 —— 此时不该再排 rAF。
     * 旧实现是无条件 requestAnimationFrame 常驻：暂停、鼠标不在条上、窗口在后台，
     * 回调照样按刷新率被叫起来（虽然只在值变化时才重画，但调度与合成活动一直在）。
     */
    const stillMoving = () => {
      const s = live.current;
      if (s.dragging) return true;
      if (!reduceMotion && s.playing) return true;
      return Math.abs(s.hover - (s.hoverTarget ? 1 : 0)) > 0.002;
    };

    function loop(now: number) {
      raf = 0;
      // 全局帧预算（高刷屏限到 ~60fps）
      if (!frameBudget(now)) {
        schedule();
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const s = live.current;

      const flowing = !reduceMotion && (s.playing || s.dragging);
      if (flowing) s.phase -= dt * 5.2;

      const target = s.hoverTarget ? 1 : 0;
      if (Math.abs(s.hover - target) > 0.005) {
        s.hover += (target - s.hover) * Math.min(1, dt * 14);
        s.dirty = true;
      } else if (s.hover !== target) {
        s.hover = target;
        s.dirty = true;
      }

      // 进度或相位变了才重画：暂停且不拖动时几乎零开销
      if (s.value !== s.drawnValue || s.phase !== s.drawnPhase) s.dirty = true;
      // 拖拽期间即使数值没变也要跟着重画（hover 过渡等）
      if (s.dragging || flowing) s.dirty = true;

      if (s.dirty) {
        s.dirty = false;
        draw();
      }
      // 只有确实还有东西在动才继续排帧；静止时彻底停掉（由事件重新点火）
      if (stillMoving()) schedule();
    }

    function schedule() {
      if (raf || isWindowInvisible()) return;
      raf = requestAnimationFrame(loop);
    }

    /** 外部事件（props 变化 / 指针 / 尺寸变化）→ 立刻画一帧，需要时继续跑 */
    const kick = () => {
      live.current.dirty = true;
      schedule();
    };
    kickRef.current = kick;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      if (!r.width) return;
      const dpr = window.devicePixelRatio || 1;
      W = r.width;
      H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();
      kick();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    // 后台/最小化真的不排帧，重新可见时补一帧（否则画布停在被隐藏前的样子）
    const offVisibility = onWindowVisibilityChange(() => {
      if (!isWindowInvisible()) kick();
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      kickRef.current = () => {};
      offVisibility();
      ro.disconnect();
    };
  }, []);

  /** 把客户端 x 换算成 0..1（按扣掉左右留白后的有效区间） */
  const ratioAt = useCallback((clientX: number) => {
    const el = wrapRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x0 = r.left + PAD;
    const x1 = r.right - PAD;
    return Math.min(1, Math.max(0, (clientX - x0) / Math.max(1, x1 - x0)));
  }, []);

  return (
    <div
      className={"progress-slider" + (disabled ? " idle" : "")}
      ref={wrapRef}
      onPointerEnter={() => {
        live.current.hoverTarget = true;
        kickRef.current();
      }}
      onPointerLeave={() => {
        live.current.hoverTarget = false;
        kickRef.current();
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        wrapRef.current?.setPointerCapture(e.pointerId);
        live.current.dragging = true;
        kickRef.current();
        onScrub?.(ratioAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (disabled || !live.current.dragging) return;
        onScrub?.(ratioAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!live.current.dragging) return;
        live.current.dragging = false;
        try {
          wrapRef.current?.releasePointerCapture(e.pointerId);
        } catch {
          /* 指针已释放 */
        }
        onCommit(ratioAt(e.clientX));
        // 松手后 hover 过渡还要收一下尾，交给循环跑完再自己停
        kickRef.current();
      }}
      onPointerCancel={() => {
        live.current.dragging = false;
        kickRef.current();
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
