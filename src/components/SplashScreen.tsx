// 开屏动画 —— 设计稿见仓库根目录的「开屏动画.html」。
//
// 画面：磨砂白底 + 四团彩色光斑（现在是静态渐变，见 styles/splash.css）+ 品牌手写体
// 「Oberon music」从左往右刷出；点「开始使用」/ 回车 / 空格 → 整屏放大 + 模糊淡出。
//
// 出现时机：**只在「安装后第一次启动」和「版本更新后第一次启动」** ——
// 用 localStorage 里记的版本号判断（见 shouldShowSplash）。用户点过之后记下当前版本，
// 之后每次启动都直接进主界面，不再出现开屏（卸载重装或版本更新后才会再出现一次）。
import { useCallback, useEffect, useRef, useState } from "react";

/// 当前版本号（构建时由 vite.config.ts 的 define 注入，取自 package.json）
const APP_VERSION: string = __APP_VERSION__;
/// localStorage 键：已经为哪个版本放过开屏
export const SPLASH_SEEN_VERSION_KEY = "oberon.splash.seenVersion";

/// 需要放一次开屏吗？（安装后第一次 / 版本更新后第一次）
/// 读不到 storage（隐私模式等）时返回 false —— 宁可不放，也不要每次启动都弹。
export function shouldShowSplash(): boolean {
  try {
    return localStorage.getItem(SPLASH_SEEN_VERSION_KEY) !== APP_VERSION;
  } catch {
    return false;
  }
}

/// 记下「这个版本的开屏已经放过了」
function markSplashSeen(): void {
  try {
    localStorage.setItem(SPLASH_SEEN_VERSION_KEY, APP_VERSION);
  } catch {
    /* 隐私模式等写不进去：忽略，只影响下次是否再放一次 */
  }
}

/// 与 css 里 splash-out 的时长对齐
const LEAVE_MS = 650;

interface Props {
  /// 低功耗模式：霜层更实、光斑更淡（见 styles/splash.css 末尾）
  lowPower: boolean;
  onDone: () => void;
}

export function SplashScreen({ lowPower, onDone }: Props) {
  const [leaving, setLeaving] = useState(false);
  // 用 ref 而不是 state 做幂等闸门：按钮点击、回车、空格都可能同时到达
  const leavingRef = useRef(false);

  // onDone 走 ref：App 传进来的是内联箭头函数（每次重渲染都是新引用）。
  // 这样 enter 才能保持稳定引用，键盘监听的订阅也不会每次重渲染都重挂。
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // 唯一的进入路径：用户点「开始使用」（或回车 / 空格）。
  // ⚠️ 依赖数组必须留空 —— enter 要保持稳定引用。
  const enter = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    markSplashSeen();
    setLeaving(true);
    window.setTimeout(() => onDoneRef.current(), LEAVE_MS);
  }, []);

  // 开屏期间独占键盘。
  // ⚠️ App 有一个全局 keydown：空格 = 播放/暂停、←/→ = 切歌。不挡住的话，
  //    用户在开屏页按个空格就会在后台开始放歌。这里在 window 的**捕获阶段**注册，
  //    并且必须用 stopImmediatePropagation —— stopPropagation 挡不住同一节点（window）
  //    冒泡阶段上的那个监听。
  //    回车 / 空格在这里同时作为「开始使用」的键盘等价操作。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === "Enter" || e.code === "Space") {
        e.preventDefault();
        enter();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enter]);

  return (
    <div
      className={"splash" + (leaving ? " is-leaving" : "") + (lowPower ? " splash--lp" : "")}
      role="dialog"
      aria-label="Oberon 开屏"
    >
      {/* 背景：4 团光斑现在是 CSS 静态渐变（见 splash.css 的 .splash__bg），不再需要子元素 */}
      <div className="splash__bg" aria-hidden="true" />
      <div className="splash__frost" aria-hidden="true" />
      <div className="splash__noise" aria-hidden="true" />

      <div className="splash__content">
        <div className="writer">
          {/* 与侧栏 logo 同一个品牌串（Sidebar.tsx 的 .logo-text），大小写不要各写一套 */}
          <span className="writer__text">Oberon music</span>
        </div>
      </div>

      {/* 按钮是唯一的进入方式：书写 3.35s 结束，按钮 3.5s 淡入 */}
      <div className="splash__actions">
        <button type="button" className="splash-btn splash-btn--primary" onClick={enter}>
          开始使用
        </button>
      </div>
    </div>
  );
}
