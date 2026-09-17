// 图标集合 —— 路径与「样式设计.html」中的 SVG 完全一致（Material 风格 24×24）
import type { CSSProperties } from "react";

export type IconName =
  | "home"
  | "search"
  | "library"
  | "settings"
  | "plus"
  | "shuffle"
  | "prev"
  | "play"
  | "pause"
  | "stop"
  | "next"
  | "repeat"
  | "heart"
  | "heart-outline"
  | "queue"
  | "volume-muted"
  | "volume-low"
  | "volume-high"
  | "fullscreen"
  | "fullscreen-exit"
  | "eye"
  | "eye-off"
  | "minimize"
  | "maximize"
  | "close"
  | "chevron-left"
  | "more"
  | "trash"
  | "folder"
  | "disc"
  | "person"
  | "refresh"
  | "check"
  | "cast"
  | "layout-poster"
  | "layout-center"
  | "sort";

// 侧栏导航三枚（home / search / library）为**有意偏离设计稿**：设计稿沿用的是 2014 版
// Material 实心图标（大色块、直角、无细节留白），与本应用的细描边家族（repeat/shuffle/音量）
// 不是一套语言。这里按同一套 1.9 圆头线框重绘，几何取自 24 网格：图形外缘都留 2 单位安全边，
// 折角靠 strokeLinejoin: round 收圆。圆弧的 sweep 标志按各段实际转向取（屋身底角是 0、
// 圆拱门与书角是 1），写反的话角会朝外翻。
const PATHS: Record<IconName, string> = {
  // 屋檐 + 屋身 + 圆拱门：屋檐两端探出墙外（eave 式），墙上端探进檐线 0.2 单位保证接合
  home:
    "M3.6 10.5 11.1 4.3a1.4 1.4 0 0 1 1.8 0l7.5 6.2" +
    "M5.8 9.4V18.3A2.7 2.7 0 0 0 8.5 21h7a2.7 2.7 0 0 0 2.7-2.7V9.4" +
    "M9.9 21v-4.3a2.1 2.1 0 0 1 4.2 0V21",
  // 圆 + 斜柄：柄起点 (15.9,15.9) 落在圆周外沿（圆周 45° 处为 15.81），圆头端帽自然搭接
  search: "M4.2 11a6.8 6.8 0 1 0 13.6 0 6.8 6.8 0 1 0-13.6 0M15.9 15.9 20.4 20.4",
  // 立着的一本（带书脊）+ 一本向右斜靠的书。试过三种更「音乐」的方案（叠放封面、
  // 封面+书脊、一排唱片），21px 下要么与 copy（复制）图标分不开，要么是几根细线、
  // 与左边实心的 house / magnifier 重量对不上。书是唯一在小尺寸下还立得住、
  // 又正好是闭合剪影的方案。
  library:
    "M6.2 4h6A2.2 2.2 0 0 1 14.4 6.2v11.6a2.2 2.2 0 0 1-2.2 2.2h-6A2.2 2.2 0 0 1 4 17.8V6.2A2.2 2.2 0 0 1 6.2 4z" +
    "M7 4v16M16.6 6.6 20 19.4",
  settings:
    "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.61 3.61 0 0 1 8.4 12c0-1.98 1.62-3.6 3.6-3.6s3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  shuffle:
    "M2.6 18h1.3c1.2 0 2.4-.6 3.1-1.6l5.8-8.2c.7-1 1.9-1.6 3.1-1.6h5.5M18.6 2.4l3.8 3.8-3.8 3.8M2.6 6h1.8c1.4 0 2.8.8 3.4 2.1M21.4 18h-5.6c-1.2 0-2.5-.7-3.1-1.7l-.5-.7M18.6 14.2l3.8 3.8-3.8 3.8",
  prev: "M7 6.4v11.2M17.7 7.5v9l-7.2-4.5z",
  play: "M8.7 6.7v10.6l8.6-5.3z",
  pause: "M9.2 6.2v11.6M14.8 6.2v11.6",
  stop: "M7.6 7.6h8.8v8.8H7.6z",
  next: "M17 6.4v11.2M6.3 7.5v9l7.2-4.5z",
  repeat:
    "M17 3l3.4 3.4L17 9.8M3.6 12.2v-.7A4.1 4.1 0 0 1 7.7 7.4h12.7M7 21l-3.4-3.4L7 14.2M20.4 11.8v.7a4.1 4.1 0 0 1-4.1 4.1H3.6",
  heart: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
  // 与 heart 同一条路径，仅渲染方式不同（线框），供侧栏导航使用
  "heart-outline": "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
  queue:
    "M4 18h4v-2H4v2zM4 13h10v-2H4v2zm0-5h16V6H4v2zm13 14h2v-2h2v-2h-2v-2h-2v2h-2v2h2v2zM7 9h4V7H7v2z",
  "volume-muted":
    "M11 4.8 6.5 9H3.4A1.3 1.3 0 0 0 2.1 10.3v3.4A1.3 1.3 0 0 0 3.4 15h3.1L11 19.2a.9.9 0 0 0 1.4-.7V5.5a.9.9 0 0 0-1.4-.7zM16.4 9.6l5 5M21.4 9.6l-5 5",
  "volume-low":
    "M11 4.8 6.5 9H3.4A1.3 1.3 0 0 0 2.1 10.3v3.4A1.3 1.3 0 0 0 3.4 15h3.1L11 19.2a.9.9 0 0 0 1.4-.7V5.5a.9.9 0 0 0-1.4-.7zM16 9.2a4.9 4.9 0 0 1 0 5.6",
  "volume-high":
    "M11 4.8 6.5 9H3.4A1.3 1.3 0 0 0 2.1 10.3v3.4A1.3 1.3 0 0 0 3.4 15h3.1L11 19.2a.9.9 0 0 0 1.4-.7V5.5a.9.9 0 0 0-1.4-.7zM16 9.2a4.9 4.9 0 0 1 0 5.6M19.2 6.2a9 9 0 0 1 0 11.6",
  fullscreen:
    "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  // maximize 的镜像：四角括号朝内。与上面那枚是同一套几何（Material 的 fullscreen /
  // fullscreen_exit），所以两个状态并排看是一对；没有用 Windows 那种「两个叠方块」的
  // 还原图标，是因为会把图标家族混起来（最小化/关闭也都是这套括号语言）。
  "fullscreen-exit": "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  eye:
    "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
  "eye-off":
    "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z",
  minimize: "M19 13H5v-2h14v2z",
  maximize:
    "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  close:
    "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  "chevron-left": "M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  more:
    "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  trash:
    "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  folder:
    "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
  disc:
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z",
  person:
    "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  refresh:
    "M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  cast: "M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0M12 13v5M9 20h6",
  // 歌词页布局切换：左栏实框 = 「左封面 + 右歌词」；三条居中横线 = 「歌词居中」
  "layout-poster": "M4 4h16v16H4zM10 4v16",
  "layout-center": "M6 8h12M4 12h16M6 16h12",
  // 音乐库「排序方式」：三条递减横线（Material 的 sort），与 plus / more / trash 同属实心族
  sort: "M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z",
};

/** 播放类图标：填充 + 同色描边把直角变成圆角（与磨砂玻璃圆角播放条配套） */
const SOLID_STYLE: Partial<Record<IconName, CSSProperties>> = {
  play: { fill: "currentColor", stroke: "currentColor", strokeWidth: 3.3, strokeLinejoin: "round", strokeLinecap: "round" },
  pause: { fill: "currentColor", stroke: "currentColor", strokeWidth: 3.7, strokeLinecap: "round" },
  prev: { fill: "currentColor", stroke: "currentColor", strokeWidth: 3.2, strokeLinejoin: "round", strokeLinecap: "round" },
  next: { fill: "currentColor", stroke: "currentColor", strokeWidth: 3.2, strokeLinejoin: "round", strokeLinecap: "round" },
  stop: { fill: "currentColor", stroke: "currentColor", strokeWidth: 2.7, strokeLinejoin: "round" },
  heart: { fill: "currentColor", stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round" },
};

/** 功能类图标：统一 1.9 圆头线框 */
const STROKE_STYLE: Partial<Record<IconName, CSSProperties>> = {
  // 侧栏导航三枚：线框而不是设计稿的实心块（见 PATHS 顶部说明）。
  // 内联的 fill:none 会盖过 CSS 给 svg 设的 fill:currentColor（继承不敌内联），
  // 所以这三枚无论在侧栏还是顶栏搜索框里都是描边渲染，颜色由 stroke 单独给。
  home: { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" },
  search: { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" },
  library: { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" },
  "heart-outline": { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" },
  repeat: { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" },
  shuffle: { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" },
  "volume-high": { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
  "volume-low": { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
  "volume-muted": { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
  "layout-poster": { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
  "layout-center": { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size, className, style }: IconProps) {
  const merged: CSSProperties | undefined =
    size != null ? { width: size, height: size, ...style } : style;
  return (
    <svg viewBox="0 0 24 24" className={className} style={merged} aria-hidden="true">
      <path d={PATHS[name]} style={SOLID_STYLE[name] ?? STROKE_STYLE[name]} />
    </svg>
  );
}
