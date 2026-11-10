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

/**
 * 封面容器**永远**带占位渐变，图片以覆盖层淡入（.cover-img → .is-ready）。
 *
 * 为什么不是「有图就渲染 img、没图就渲染渐变」：
 * 封面是异步拿到的（player_cover 走 IPC），第一次进专辑页时缓存是冷的，
 * 于是先画渐变、几十毫秒后整墙封面同时换成照片 —— 而且 <img> 挂上到解码完成之间
 * 还有一两帧是空的（卡片底色透出来就是白闪）。现在渐变垫在下面、图片淡入，
 * 冷缓存下看到的是"渐变换成封面"，不是"闪一下"。
 *
 * 命中缓存时图片在挂载时就已经 complete，直接标 is-ready，不会每次换页重放淡入。
 */
export function Cover({ trackId, seed, className, glyph = "♪", title, children }: CoverProps) {
  const url = useCover(trackId);
  const gradient = fallbackGradient(seed ?? trackId ?? 0);

  /** 已经解码完的（缓存命中）跳过淡入；新解码的由 onLoad 打标 */
  const markReady = (el: HTMLImageElement | null) => {
    if (!el) return;
    if (el.complete && el.naturalWidth > 0) el.classList.add("is-ready");
  };

  return (
    <div className={className} style={{ background: gradient }} title={title}>
      {url ? (
        <img
          ref={markReady}
          className="cover-img"
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => e.currentTarget.classList.add("is-ready")}
        />
      ) : (
        glyph
      )}
      {children}
    </div>
  );
}
