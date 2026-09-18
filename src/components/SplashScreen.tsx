// 开屏动画 —— 设计稿见仓库根目录的「开屏动画.html」。
//
// 画面：磨砂白底 + 四团彩色光斑漂移 + 品牌手写体「Oberon music」从左往右刷出；
// 点「开始使用」/ 回车 / 空格 → 整屏放大 + 模糊淡出。样式在 styles/splash.css。
//
// 两种进入方式：
// - waitForUser = true（首次运行）：停在开屏页等用户点。
// - waitForUser = false（回访）：书写结束后自动进主界面，**不渲染按钮** ——
//   按钮要到 3.5s 才浮出、4.0s 就自动离开了，显示它只会闪一下。
import { useCallback, useEffect, useRef, useState } from "react";

/// localStorage 键：开屏已经出现过（回访时不再等用户点）
export const SPLASH_SEEN_KEY = "oberon.splash.seen";
/// 重放开屏的事件名（设置页「重放」按钮用）
export const SPLASH_REPLAY_EVENT = "oberon:replay-splash";

/// 已经看过开屏吗？读不到（隐私模式等）当成「看过」，免得每次启动都卡在开屏页。
export function hasSeenSplash(): boolean {
  try {
    return localStorage.getItem(SPLASH_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/// 请求重放开屏。走事件而不是把状态提到全局 store：一个动画不值得牵动全局状态。
export function replaySplash(): void {
  window.dispatchEvent(new Event(SPLASH_REPLAY_EVENT));
}

/// 与 css 里 splash-out 的时长对齐
const LEAVE_MS = 650;
/// 回访时的自动进入时刻：书写 0.35s 延迟 + 3.0s 时长 = 3.35s 结束，再留一拍让人看清
const AUTO_ENTER_MS = 4000;

interface Props {
  /// true = 停在开屏页等用户点「开始使用」；false = 到点自动进入
  waitForUser: boolean;
  /// 低功耗模式：停掉光斑漂移与大面积 backdrop-filter（见 styles/splash.css 末尾）
  lowPower: boolean;
  onDone: () => void;
}

export function SplashScreen({ waitForUser, lowPower, onDone }: Props) {
  const [leaving, setLeaving] = useState(false);
  // 用 ref 而不是 state 做幂等闸门：按钮点击、回车、空格、自动进入都可能同时到达
  const leavingRef = useRef(false);

  const enter = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    try {
      localStorage.setItem(SPLASH_SEEN_KEY, "1");
    } catch {
      /* 隐私模式等写不进去：忽略，只影响下次是否自动进入 */
    }
    setLeaving(true);
    window.setTimeout(onDone, LEAVE_MS);
  }, [onDone]);

  // 回访：书写结束 + 一拍后自动进入（首次运行等用户点）
  useEffect(() => {
    if (waitForUser) return;
    const t = window.setTimeout(enter, AUTO_ENTER_MS);
    return () => window.clearTimeout(t);
  }, [waitForUser, enter]);

  // 开屏期间独占键盘。
  // ⚠️ App 有一个全局 keydown：空格 = 播放/暂停、←/→ = 切歌。不挡住的话，
  //    用户在开屏页按个空格就会在后台开始放歌。这里在 window 的**捕获阶段**注册，
  //    并且必须用 stopImmediatePropagation —— stopPropagation 挡不住同一节点（window）
  //    冒泡阶段上的那个监听。
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
      <div className="splash__bg" aria-hidden="true">
        <span className="blob blob--1" />
        <span className="blob blob--2" />
        <span className="blob blob--3" />
        <span className="blob blob--4" />
      </div>
      <div className="splash__frost" aria-hidden="true" />
      <div className="splash__noise" aria-hidden="true" />

      <div className="splash__content">
        <div className="writer">
          {/* 与侧栏 logo 同一个品牌串（Sidebar.tsx 的 .logo-text），大小写不要各写一套 */}
          <span className="writer__text">Oberon music</span>
        </div>
      </div>

      {waitForUser && (
        <div className="splash__actions">
          <button type="button" className="splash-btn splash-btn--primary" onClick={enter}>
            开始使用
          </button>
        </div>
      )}
    </div>
  );
}
