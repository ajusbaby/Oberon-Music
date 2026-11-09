// 顶栏：搜索入口 + 窗口控制（最小化 / 最大化 / 关闭）
// 搜索是独立模块（components/SearchPanel.tsx）—— 这里只是一个"打开它"的触发器。
// 以前点击搜索框会把路由切到专辑页，等于拿一个全局视图去换一次输入，很亏。
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./Icon";
import { SEARCH_TRIGGER_ID, useUiStore } from "../stores/uiStore";

const appWindow = getCurrentWindow();

/** maximized 由 App 统一监听窗口事件后传下来（顶部栏自己再订阅一遍会和 App 抢同一个事件源） */
export function TopBar({ maximized }: { maximized: boolean }) {
  const openSearch = useUiStore((s) => s.openSearch);
  const searchOpen = useUiStore((s) => s.searchOpen);

  return (
    <div className="main-top-bar drag-region" data-tauri-drag-region>
      <button
        id={SEARCH_TRIGGER_ID}
        type="button"
        className="search-bar search-trigger"
        aria-label="搜索歌曲、艺术家或专辑"
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
        onClick={openSearch}
      >
        <Icon name="search" />
        <span className="search-trigger-label">搜索歌曲、艺术家或专辑…</span>
        <kbd className="search-kbd">Ctrl K</kbd>
      </button>

      <div className="window-controls">
        <button className="window-btn" aria-label="最小化" onClick={() => void appWindow.minimize()}>
          <Icon name="minimize" />
        </button>
        <button
          className="window-btn"
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => void appWindow.toggleMaximize()}
        >
          {/* 最大化时换成朝内的括号，否则按钮看起来「点了没反应」 */}
          <Icon name={maximized ? "fullscreen-exit" : "maximize"} />
        </button>
        <button className="window-btn close-btn" aria-label="关闭" onClick={() => void appWindow.close()}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
