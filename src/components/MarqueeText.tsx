// 单行文本：宽度放不下时循环滚动（跑马灯），放得下时保持省略号
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

interface MarqueeTextProps {
  text: string;
  className?: string;
  /** 渲染成什么标签（默认 h3，与设计稿卡片标题一致） */
  as?: "h3" | "p";
}

/** 滚动速度（像素/秒），用于按文本长度换算一轮时长 */
const SPEED = 26;

export function MarqueeText({ text, className, as = "h3" }: MarqueeTextProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [duration, setDuration] = useState(9);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // 只量「一份」文本的宽度，避免把滚动副本算进去导致抖动
      const single = el.querySelector<HTMLElement>("[data-marquee-item]");
      const width = single ? single.scrollWidth : el.scrollWidth;
      const need = width > el.clientWidth + 2;
      setOverflow(need);
      if (need) setDuration(Math.max(6, Math.min(24, Math.round(width / SPEED))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const props = {
    ref: ref as never,
    className: (className ? className + " " : "") + (overflow ? "marquee" : ""),
    title: text,
    style: overflow ? ({ "--marquee-duration": duration + "s" } as CSSProperties) : undefined,
  };

  if (!overflow) {
    return as === "p" ? <p {...props}>{text}</p> : <h3 {...props}>{text}</h3>;
  }
  const track = (
    <span className="marquee-track">
      <span data-marquee-item>{text}</span>
      <span data-marquee-item aria-hidden="true">
        {text}
      </span>
    </span>
  );
  return as === "p" ? <p {...props}>{track}</p> : <h3 {...props}>{track}</h3>;
}
