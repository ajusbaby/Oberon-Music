// 侧边栏：Logo / 主导航 / 播放列表 / 设置入口（结构与设计稿一致）
import { useEffect } from "react";
import { Icon } from "./Icon";
import { useNavStore, nav } from "../stores/navStore";
import { useUiStore } from "../stores/uiStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { toast } from "../stores/uiStore";
type PrimaryNav = "home" | "search" | "library" | "favorites";

const NAV_ITEMS: { name: PrimaryNav; label: string; icon: "home" | "search" | "library" | "heart-outline" }[] = [
  { name: "home", label: "Home", icon: "home" },
  { name: "search", label: "Search", icon: "search" },
  { name: "library", label: "Library", icon: "library" },
  // 收藏模块：与 Home / Search / Library 同属主导航，紧随 Library 之下。
  // 图标用 heart-outline（1.9 线框），与左边三枚同一套语言 —— 实心 heart 留给
  // 播放条与曲目行里那两枚「当前是否已收藏」的按钮。
  { name: "favorites", label: "Favorite", icon: "heart-outline" },
];

const GO: Record<PrimaryNav, () => void> = {
  home: nav.home,
  search: nav.search,
  library: () => nav.library("tracks"),
  favorites: nav.favorites,
};

export function Sidebar() {
  const view = useNavStore((s) => s.view);
  const openDialog = useUiStore((s) => s.openDialog);
  const playlists = usePlaylistStore((s) => s.playlists);
  const refresh = usePlaylistStore((s) => s.refresh);
  const removePlaylist = usePlaylistStore((s) => s.remove);
  const loading = usePlaylistStore((s) => s.loading);

  /** 删除播放列表：先确认，再从侧栏与本地库移除（不动音乐文件） */
  const confirmDelete = (id: number, name: string) => {
    openDialog({
      kind: "confirm",
      title: "删除播放列表",
      message: "确定要删除“" + name + "”吗？只删除这个列表，不会删除本地音乐文件。",
      confirmText: "删除",
      onConfirm: () => {
        void (async () => {
          await removePlaylist(id);
          if (view.name === "playlist" && view.id === id) nav.library("tracks");
          toast("已删除播放列表「" + name + "」", "success");
        })();
      },
    });
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <aside className="sidebar">
      {/* 纯文字标：按需求去掉了左侧的图标标记（logo/ 那批图现在只作为应用图标，
          即任务栏 / 快捷方式 / 可执行文件那几枚，见 scripts/gen-icons.mjs）。 */}
      <div className="sidebar-logo drag-region" data-tauri-drag-region>
        <span className="logo-text">Oberon music</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.name}
            className={"nav-item" + (view.name === item.name ? " active" : "")}
            onClick={() => GO[item.name]()}
          >
            <Icon name={item.icon} />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="playlist-section">
        <div className="playlist-header">
          <span className="playlist-label">Playlists</span>
          <button
            className="playlist-add-btn"
            title="创建播放列表"
            onClick={() => openDialog({ kind: "create-playlist" })}
          >
            <Icon name="plus" />
          </button>
        </div>

        {playlists.length === 0 && !loading ? (
          <div className="playlist-empty">
            <div className="playlist-empty-icon">♫</div>
            <div className="playlist-empty-title">还没有播放列表</div>
            <div className="playlist-empty-sub">创建第一个播放列表开始整理音乐</div>
          </div>
        ) : (
          <div className="playlist-scroll">
            {playlists.map((p) => (
              <div className="playlist-row" key={p.id}>
                <button
                  className={
                    "nav-item playlist-item" +
                    (view.name === "playlist" && view.id === p.id ? " active" : "")
                  }
                  title={p.name}
                  onClick={() => nav.playlist(p.id)}
                >
                  {/* 按需求去掉了名称前的 ♪ 音符（原来的 .playlist-glyph，CSS 已一并删除）：
                      播放列表靠缩进与计数区分即可，前面再挂一个音符反而和主导航图标抢视线。 */}
                  <span className="playlist-name">{p.name}</span>
                  <span className="playlist-count">{p.trackCount}</span>
                </button>
                <button
                  className="playlist-del-btn"
                  title={"删除播放列表「" + p.name + "」"}
                  aria-label={"删除播放列表 " + p.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmDelete(p.id, p.name);
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-bottom">
        <button
          className={"settings-btn" + (view.name === "settings" ? " active" : "")}
          onClick={() => nav.settings()}
        >
          <Icon name="settings" />
          Settings
        </button>
      </div>
    </aside>
  );
}