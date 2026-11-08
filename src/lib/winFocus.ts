// 全局的「窗口是否聚焦」标记。
//
// 为什么要单独一个模块级标记：CSS 侧靠 window 的 focus/blur 事件给外壳加 .win-blur 类
// （暂停装饰性无限动画），而 JS 侧的逐帧循环（歌词页背景漂移）也需要同一个信号。
// 如果 JS 自己去问 document.hasFocus()，两处判断可能不一致 —— 实测某些环境（无头浏览器）
// 下 hasFocus() 恒为 false，于是"CSS 照跑、JS 却停了"或者反之。统一到这一个来源最省心。
//
// 2026-11 追加「窗口是否在屏幕上」：CSS 可以用 .win-hidden 类停掉动画，但 canvas 逐帧循环
// （FlowingLight / WaveProgress）看不见类，只能走这里。Tauri 的 win-hidden 来自 Rust 侧
// 500ms 轮询 —— WebView2 最小化时不一定把 document.hidden 置真，只问页面会漏。

let focused = true;
let hidden = false;

/** win-hidden 的订阅者：变化时立刻叫醒/停掉那些循环 */
const hiddenListeners = new Set<() => void>();

export function setWinFocused(v: boolean): void {
  focused = v;
}

export function isWinFocused(): boolean {
  return focused;
}

/** 窗口是否真的不在屏幕上（最小化 / 收进托盘）。来源：Rust 侧 win-hidden 事件。 */
export function setWinHidden(v: boolean): void {
  if (hidden === v) return;
  hidden = v;
  for (const fn of hiddenListeners) fn();
}

/**
 * 「真的看不见」：页面隐藏 或 窗口最小化。
 * 两者任一成立都不该再排帧 —— 判断合并在这里，免得每个循环各写一套还漏一种。
 */
export function isWindowInvisible(): boolean {
  return hidden || (typeof document !== "undefined" && document.hidden === true);
}

/**
 * 订阅可见性变化（document.visibilitychange 与 win-hidden 合并成一个信号）。
 * 返回取消订阅函数。回调里请自己用 isWindowInvisible() 判断方向。
 */
export function onWindowVisibilityChange(fn: () => void): () => void {
  hiddenListeners.add(fn);
  // 守卫与 isWindowInvisible 对齐：没有 document 的环境（单测 / 预渲染）里
  // 只走 hiddenListeners 通道，别让「注册监听」这一步本身抛错。
  const hasDoc = typeof document !== "undefined";
  const onDoc = () => fn();
  if (hasDoc) document.addEventListener("visibilitychange", onDoc);
  return () => {
    hiddenListeners.delete(fn);
    if (hasDoc) document.removeEventListener("visibilitychange", onDoc);
  };
}
