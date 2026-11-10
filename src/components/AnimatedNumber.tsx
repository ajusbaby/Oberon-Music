// 数字滚动：用 requestAnimationFrame 直接写 textContent，
// 全程不触发 React 重渲染，几十个数字同时滚也不掉帧。
import { useEffect, useRef } from "react";

export interface AnimatedNumberProps {
  value: number;
  /** 必须是稳定引用（模块级函数），否则每次渲染都会重启动画 */
  format: (n: number) => string;
  className?: string;
}

const DURATION = 640;

function prefersReduced(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function AnimatedNumber({ value, format, className }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const fromRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 首次挂载从 0 滚上来；之后每次数值更新都从上一次的落点接着滚
    const from = fromRef.current ?? 0;
    fromRef.current = value;
    const calm = prefersReduced();
    const diff = Math.abs(value - from);
    if (calm || diff === 0 || diff < Math.max(0.04, Math.abs(value) * 0.005)) {
      el.textContent = format(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, format]);

  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}
