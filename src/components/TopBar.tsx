// 顶栏：搜索框 + 窗口控制（最小化 / 最大化 / 关闭）
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./Icon";
import { useSearchStore } from "../stores/searchStore";
import { useNavStore, nav } from "../stores/navStore";

const appWindow = getCurrentWindow();

/** maximized 由 App 统一监听窗口事件后传下来（顶部栏自己再订阅一遍会和 App 抢同一个事件源） */
export function TopBar({ maximized }: { maximized: boolean }) {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const view = useNavStore((s) => s.view);
  const [placeholderIndex] = useState(0);

  // 进入搜索视图时聚焦输入框
  useEffect(() => {
    if (view.name !== "search") return;
    const el = document.getElementById("searchInput") as HTMLInputElement | null;
    el?.focus();
  }, [view.name]);

  const placeholders = [
    "搜索歌曲、艺术家或专辑…",
    "Search for songs, artists, albums...",
  ];

  return (
    <div className="main-top-bar drag-region" data-tauri-drag-region>
      <div className="search-bar" onClick={() => nav.search()}>
        <Icon name="search" />
        <input
          id="searchInput"
          type="text"
          placeholder={placeholders[placeholderIndex]}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim().length > 0) nav.search();
          }}
          onFocus={() => {
            if (query.trim().length > 0) nav.search();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {query.length > 0 && (
          <button
            className="icon-only-btn"
            title="清空"
            onClick={(e) => {
              e.stopPropagation();
              setQuery("");
            }}
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      <div className="window-controls">
        <button className="window-btn" title="最小化" onClick={() => void appWindow.minimize()}>
          <Icon name="minimize" />
        </button>
        <button
          className="window-btn"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => void appWindow.toggleMaximize()}
        >
          {/* 最大化时换成朝内的括号，否则按钮看起来「点了没反应」 */}
          <Icon name={maximized ? "fullscreen-exit" : "maximize"} />
        </button>
        <button className="window-btn close-btn" title="关闭" onClick={() => void appWindow.close()}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
