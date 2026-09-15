// 封面组件：优先使用内嵌封面（player_cover → data URL），否则回退到设计稿风格渐变
import type { ReactNode } from "react";
import { fallbackGradient, useCover } from "../lib/cover";

interface CoverProps {
  /** 取封面的曲目 id（专辑用其聚合 id，即专辑内最小 track id） */
  trackId: number | null | undefined;
  /** 无封面时的渐变种子（通常与 trackId 相同） */
  seed?: number;
  className?: string;
  /** 无封面时显示的字符（设计稿使用 ♪） */
  glyph?: string;
  title?: string;
  /** 叠加在封面之上的内容（例如年份角标） */
  children?: ReactNode;
}

export function Cover({ trackId, seed, className, glyph = "♪", title, children }: CoverProps) {
  const url = useCover(trackId);
  const gradient = fallbackGradient(seed ?? trackId ?? 0);
  if (url) {
    return (
      <div className={className} title={title}>
        <img src={url} alt="" draggable={false} />
        {children}
      </div>
    );
  }
  return (
    <div className={className} style={{ background: gradient }} title={title}>
      {glyph}
      {children}
    </div>
  );
}