// 全局的「窗口是否聚焦」标记。
//
// 为什么要单独一个模块级标记：CSS 侧靠 window 的 focus/blur 事件给外壳加 .win-blur 类
// （暂停装饰性无限动画），而 JS 侧的逐帧循环（歌词页背景漂移）也需要同一个信号。
// 如果 JS 自己去问 document.hasFocus()，两处判断可能不一致 —— 实测某些环境（无头浏览器）
// 下 hasFocus() 恒为 false，于是"CSS 照跑、JS 却停了"或者反之。统一到这一个来源最省心。

let focused = true;

export function setWinFocused(v: boolean): void {
  focused = v;
}

export function isWinFocused(): boolean {
  return focused;
}
