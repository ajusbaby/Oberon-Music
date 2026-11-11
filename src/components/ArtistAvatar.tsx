// 艺术家头像：全库统一用同一张占位图（见 src\assets\artist-placeholder.jpg）。
// 为什么抽成组件：音乐库列表、艺术家详情页、搜索浮层三处都要它，
// 尺寸不同但裁切 / 圆角 / 兜底完全一致，改图只改这一个地方。
// 样式在 views.css 的 .artist-photo（图片本身走 CSS 变量 --artist-photo）。

export interface ArtistAvatarProps {
  /** sm=搜索浮层 36px，md=音乐库列表 44px，lg=艺术家详情页 156px */
  size?: "sm" | "md" | "lg";
  className?: string;
}

// 纯装饰：同一张占位图不携带任何信息，名字就在旁边，
// 对读屏器重复念 246 次 aria-label 只是噪音，所以整个元素 aria-hidden。
export function ArtistAvatar({ size = "md", className = "" }: ArtistAvatarProps) {
  return (
    <span
      className={"artist-photo artist-photo-" + size + (className ? " " + className : "")}
      aria-hidden="true"
    />
  );
}
