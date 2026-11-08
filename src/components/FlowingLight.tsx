import { useCallback, useEffect, useRef } from "react";
import { isWindowInvisible, onWindowVisibilityChange } from "../lib/winFocus";

// 流光背景：封面位图本身当颜料。
// 下采样 → 提饱和 → 一次性大模糊 → 三层不同字号/相位反向旋转叠色 → 25% 拖影 → 放大铺满。
const DOWN = 14;
const PAINT_SCALE = 1.8;
const BLUR_RATIO = 0.135;
const FPS = 24;
const FADE_MS = 500;
const TRAIL_ALPHA = 0.25;

interface Layer {
  /** 每秒转过的角度。 */
  spin: number;
  /** 相对短边的放大倍数。 */
  scale: number;
  /** 叠加透明度：第一层负责封面原本的色块结构，后两层只渗色。 */
  alpha: number;
  /** 中心偏移（相对画布宽高）。 */
  ox: number;
  oy: number;
  /** 圆心羽化：带偏移的层会露出画布边缘，必须是软边圆形而不是方块。 */
  round: boolean;
}

// 第一层铺满全屏（缩放 1.35 时方角永远在视口外），后两层偏移很大，
// 必须裁成柔边圆形，否则旋转时能看到一块方形色斑的边缘。
const LAYERS: Layer[] = [
  { spin: 360 / 100, scale: 1.35, alpha: 1, ox: 0, oy: 0, round: false },
  { spin: -360 / 70, scale: 1.55, alpha: 0.3, ox: -0.95, oy: -0.7, round: true },
  { spin: -360 / 40, scale: 1.75, alpha: 0.2, ox: -0.5, oy: 0.7, round: true },
];

export interface FlowingLightProps {
  texture: HTMLCanvasElement | null;
  base: string;
}

export function FlowingLight({ texture, base }: FlowingLightProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const smallRef = useRef<HTMLCanvasElement | null>(null);
  const prevRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef<HTMLCanvasElement | null>(null);
  const roundRef = useRef<HTMLCanvasElement | null>(null);
  const trailRef = useRef<HTMLCanvasElement | null>(null);
  const dimsRef = useRef({ cols: 0, rows: 0 });
  const textureRef = useRef(texture);
  const baseRef = useRef(base);
  const fadeAtRef = useRef(0);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const lastRef = useRef(0);
  const trailOnRef = useRef(false);
  const hiddenAtRef = useRef(0);

  textureRef.current = texture;
  baseRef.current = base;

  const paint = useCallback((timeSec: number) => {
    const main = canvasRef.current;
    const small = smallRef.current;
    const paintCanvas = paintRef.current;
    if (!main || !small || !paintCanvas) return;
    const roundCanvas = roundRef.current;
    const { cols, rows } = dimsRef.current;
    if (!cols || !rows) return;
    const ctx = small.getContext("2d");
    const mainCtx = main.getContext("2d");
    if (!ctx || !mainCtx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgb(" + baseRef.current + ")";
    ctx.fillRect(0, 0, cols, rows);

    const maxDim = Math.max(cols, rows);
    const centerX = cols / 2;
    const centerY = rows / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    for (let i = 0; i < LAYERS.length; i++) {
      const layer = LAYERS[i];
      const side = maxDim * layer.scale;
      const rad = ((timeSec * layer.spin) % 360) * (Math.PI / 180);
      ctx.save();
      ctx.globalAlpha = layer.alpha;
      ctx.translate(centerX + layer.ox * cols, centerY + layer.oy * rows);
      ctx.rotate(rad);
      const src = layer.round && roundCanvas ? roundCanvas : paintCanvas;
      ctx.drawImage(src, -side / 2, -side / 2, side, side);
      ctx.restore();
    }

    const trail = trailRef.current;
    if (trail) {
      if (trailOnRef.current) {
        ctx.globalAlpha = TRAIL_ALPHA;
        ctx.drawImage(trail, 0, 0, cols, rows);
        ctx.globalAlpha = 1;
      }
      const trailCtx = trail.getContext("2d");
      if (trailCtx) {
        trailCtx.setTransform(1, 0, 0, 1, 0, 0);
        trailCtx.globalAlpha = 1;
        trailCtx.clearRect(0, 0, cols, rows);
        trailCtx.drawImage(small, 0, 0);
        trailOnRef.current = true;
      }
    }

    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    mainCtx.globalCompositeOperation = "source-over";
    mainCtx.globalAlpha = 1;
    mainCtx.clearRect(0, 0, main.width, main.height);
    mainCtx.imageSmoothingEnabled = true;
    mainCtx.imageSmoothingQuality = "high";
    const now = performance.now();
    const fade = fadeAtRef.current ? Math.min(1, (now - fadeAtRef.current) / FADE_MS) : 1;
    const previous = prevRef.current;
    if (previous && fade < 1) {
      mainCtx.drawImage(previous, 0, 0, cols, rows, 0, 0, main.width, main.height);
      mainCtx.globalAlpha = fade;
      mainCtx.drawImage(small, 0, 0, cols, rows, 0, 0, main.width, main.height);
      mainCtx.globalAlpha = 1;
    } else {
      mainCtx.drawImage(small, 0, 0, cols, rows, 0, 0, main.width, main.height);
      if (fadeAtRef.current) fadeAtRef.current = 0;
    }
  }, []);

  // 模糊只做一次：把 72×72 纹理放大到中等画布后整体虚化，逐帧旋转这张已经糊掉的图。
  const buildPaint = useCallback((cols: number, rows: number) => {
    const texture = textureRef.current;
    if (!texture) {
      paintRef.current = null;
      roundRef.current = null;
      return;
    }
    const size = Math.max(16, Math.round(Math.max(cols, rows) * PAINT_SCALE));
    const cv = document.createElement("canvas");
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "rgb(" + baseRef.current + ")";
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const scale = Math.max(size / texture.width, size / texture.height) * 1.12;
    const drawW = texture.width * scale;
    const drawH = texture.height * scale;
    ctx.filter = "blur(" + (size * BLUR_RATIO).toFixed(2) + "px)";
    ctx.drawImage(texture, (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);
    ctx.filter = "none";
    paintRef.current = cv;

    // 圆形副本：径向 alpha 遮罩把方画布裁成柔边圆，旋转时就只剩光的形状。
    const round = document.createElement("canvas");
    round.width = size;
    round.height = size;
    const rctx = round.getContext("2d");
    if (!rctx) {
      roundRef.current = null;
      return;
    }
    rctx.drawImage(cv, 0, 0);
    const mask = rctx.createRadialGradient(size / 2, size / 2, size * 0.16, size / 2, size / 2, size * 0.5);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.58, "rgba(0,0,0,0.94)");
    mask.addColorStop(0.82, "rgba(0,0,0,0.55)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    rctx.globalCompositeOperation = "destination-in";
    rctx.fillStyle = mask;
    rctx.fillRect(0, 0, size, size);
    rctx.globalCompositeOperation = "source-over";
    roundRef.current = round;
  }, []);

  const rebuild = useCallback(() => {
    const main = canvasRef.current;
    if (!main) return;
    const width = Math.max(1, Math.round(main.clientWidth));
    const height = Math.max(1, Math.round(main.clientHeight));
    const cols = Math.max(4, Math.round(width / DOWN));
    const rows = Math.max(4, Math.round(height / DOWN));
    dimsRef.current = { cols, rows };
    main.width = width;
    main.height = height;
    const make = (w: number, h: number) => {
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      return cv;
    };
    smallRef.current = make(cols, rows);
    prevRef.current = make(cols, rows);
    trailRef.current = make(cols, rows);
    trailOnRef.current = false;
    buildPaint(cols, rows);
    paint(startRef.current ? (performance.now() - startRef.current) / 1000 : 0);
  }, [buildPaint, paint]);

  useEffect(() => {
    const main = canvasRef.current;
    if (!main) return;
    rebuild();
    let oldW = main.clientWidth;
    let oldH = main.clientHeight;
    const observer = new ResizeObserver(() => {
      if (main.clientWidth === oldW && main.clientHeight === oldH) return;
      oldW = main.clientWidth;
      oldH = main.clientHeight;
      rebuild();
    });
    observer.observe(main);
    return () => observer.disconnect();
  }, [rebuild]);

  useEffect(() => {
    const small = smallRef.current;
    const previous = prevRef.current;
    const { cols, rows } = dimsRef.current;
    if (small && previous && cols && rows) {
      const pctx = previous.getContext("2d");
      pctx?.clearRect(0, 0, cols, rows);
      pctx?.drawImage(small, 0, 0);
      fadeAtRef.current = performance.now();
      trailOnRef.current = false;
      buildPaint(cols, rows);
      paint(startRef.current ? (performance.now() - startRef.current) / 1000 : 0);
    }
  }, [texture, base, buildPaint, paint]);

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    startRef.current = performance.now();
    lastRef.current = 0;
    const frame = (now: number) => {
      rafRef.current = 0;
      const elapsed = now - startRef.current;
      // 还没到 24fps 的下一个节拍：继续等，但任何时刻只挂一帧
      if (!reduced && elapsed - lastRef.current < 1000 / FPS - 1) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }
      lastRef.current = elapsed;
      paint(elapsed / 1000);
      if (!reduced) rafRef.current = requestAnimationFrame(frame);
    };
    // 真正停掉调度，而不是在回调里早退：旧实现在 document.hidden 时只是 return，
    // 回调仍被 rAF 一帧一帧叫起来 —— 后台看不见时既白算一次调度，
    // 也让整机维持在"持续产帧"的状态（合成器不会因为画布没变就完全静止）。
    const stop = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
    const start = () => {
      if (reduced || rafRef.current || isWindowInvisible()) return;
      rafRef.current = requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      if (isWindowInvisible()) {
        stop();
        hiddenAtRef.current = performance.now();
        return;
      }
      // 补回隐藏期间的时间：否则恢复时按真实时钟算相位，流光会突然跳一大截
      if (hiddenAtRef.current) {
        startRef.current += performance.now() - hiddenAtRef.current;
        hiddenAtRef.current = 0;
        lastRef.current = 0;
        // 先补一帧，避免恢复后看到的第一帧还是隐藏前的旧画面
        paint((performance.now() - startRef.current) / 1000);
      }
      start();
    };
    // 合并信号：document.visibilitychange 与 Tauri 的 win-hidden（最小化/托盘）
    const offVisibility = onWindowVisibilityChange(onVisibility);
    if (isWindowInvisible()) hiddenAtRef.current = performance.now();
    else start();
    return () => {
      offVisibility();
      stop();
    };
  }, [paint]);

  return <canvas ref={canvasRef} className="sl-light" aria-hidden="true" />;
}
