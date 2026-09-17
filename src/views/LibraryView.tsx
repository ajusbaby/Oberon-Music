// 音乐库 —— 歌曲 / 专辑 / 艺术家 三个页签
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/ipc";
import type { Album, Artist, SortOrder, Track, TrackSort } from "../api/types";
import { AlbumGrid } from "../components/AlbumGrid";
import { TrackList } from "../components/TrackList";
import { Icon } from "../components/Icon";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useNavStore, nav } from "../stores/navStore";
import { useSettingsStore } from "../stores/settingsStore";
import { toast } from "../stores/uiStore";
import { pickAndAddMusicFolder } from "../lib/addMusic";
import { formatTotalDuration } from "../lib/format";

// 每页条数。后端 list_tracks 的 page_size 上限是 1000，这里取等于上限的值：
// 第一页就填满一屏多，滚动到底再追加下一页（见 loadMoreTracks）。
const PAGE_SIZE = 1000;

type Tab = "tracks" | "albums" | "artists";

const TABS: { key: Tab; label: string }[] = [
  { key: "tracks", label: "歌曲" },
  { key: "albums", label: "专辑" },
  { key: "artists", label: "艺术家" },
];

/// 「排序方式」按钮的选项。
/// 注意 sort + order 是**一对**：修改时间/添加时间的升降序各占一条（其余几项按直觉定方向）。
const SORT_OPTIONS: { key: string; label: string; sort: TrackSort; order: SortOrder }[] = [
  { key: "title", label: "标题", sort: "title", order: "asc" },
  { key: "size", label: "文件大小", sort: "size", order: "desc" },
  { key: "mtime", label: "修改时间", sort: "mtime", order: "asc" },
  { key: "added", label: "添加时间", sort: "date-added", order: "asc" },
  { key: "mtime-desc", label: "修改时间降序", sort: "mtime", order: "desc" },
  { key: "added-desc", label: "添加时间降序", sort: "date-added", order: "desc" },
  { key: "play-count", label: "播放次数", sort: "play-count", order: "desc" },
];

/** 表头点击能排出来的全部键（比菜单多：菜单只是常用预设） */
const KNOWN_SORTS: TrackSort[] = [
  "title",
  "artist",
  "album",
  "date-added",
  "year",
  "duration",
  "size",
  "mtime",
  "play-count",
];

const SORT_LABELS: Record<TrackSort, string> = {
  title: "标题",
  artist: "艺术家",
  album: "专辑",
  "date-added": "添加时间",
  year: "年份",
  duration: "时长",
  size: "文件大小",
  mtime: "修改时间",
  "play-count": "播放次数",
};

/**
 * 排序方式的持久化键：值形如 "play-count:desc"。
 *
 * 为什么必须落库：LibraryView 会随页签切换卸载重建（音乐库 → 最爱 → 返回），
 * 只放在 useState 里的话用户刚设好的排序一离开就丢了。
 */
const SORT_SETTING_KEY = "librarySort";
const DEFAULT_SORT: [TrackSort, SortOrder] = ["title", "asc"];

/// 只接受「已知排序键 + asc/desc」，其余（缺键、脏值、半截字符串）一律回默认。
function parseLibrarySort(raw: string | undefined): [TrackSort, SortOrder] {
  if (!raw) return DEFAULT_SORT;
  const [s, o] = raw.split(":");
  if (KNOWN_SORTS.includes(s as TrackSort) && (o === "asc" || o === "desc")) {
    return [s as TrackSort, o as SortOrder];
  }
  return DEFAULT_SORT;
}

export function LibraryView() {
  const view = useNavStore((s) => s.view);
  const version = useLibraryStore((s) => s.version);
  const stats = useLibraryStore((s) => s.stats);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const tab = (view.key as Tab) ?? "tracks";
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingAll, setLoadingAll] = useState(false);
  // 排序方式存在设置里（见 SORT_SETTING_KEY 的说明）：直接由设置派生，不另存一份本地状态，
  // 这样「设置晚于组件挂载才加载完」也能自动跟上，不需要额外的同步逻辑。
  const sortRaw = useSettingsStore((s) => s.values[SORT_SETTING_KEY]);
  const saveSetting = useSettingsStore((s) => s.set);
  const [sort, order] = useMemo(() => parseLibrarySort(sortRaw), [sortRaw]);
  const setSortOrder = useCallback(
    (s: TrackSort, o: SortOrder) => {
      void saveSetting(SORT_SETTING_KEY, s + ":" + o);
    },
    [saveSetting]
  );
  // 增量加载的并发闸门 + 代次（排序/页签切换后，旧请求的结果必须丢弃）
  const loadingMore = useRef(false);
  const genRef = useRef(0);
  // 「排序方式」下拉（.context-menu 是 position:fixed，位置按按钮实时算）
  const sortBtnRef = useRef<HTMLButtonElement | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!sortMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // 点按钮自身由 onClick 负责开关，这里不要抢
      if (sortMenuRef.current?.contains(t) || sortBtnRef.current?.contains(t)) return;
      setSortMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSortMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [sortMenu]);

  useEffect(() => {
    let alive = true;
    const gen = ++genRef.current;
    loadingMore.current = false;
    setLoading(true);
    const job = async () => {
      try {
        if (tab === "tracks") {
          const page = await api.tracksList({ sort, order, page: 1, pageSize: PAGE_SIZE });
          if (!alive || gen !== genRef.current) return;
          setTracks(page.items);
          setTotal(page.total);
        } else if (tab === "albums") {
          const page = await api.albumsList(1, 500);
          if (!alive) return;
          setAlbums(page.items);
          setTotal(page.total);
        } else {
          const list = await api.artistsList();
          if (!alive) return;
          setArtists(list);
          setTotal(list.length);
        }
        if (alive) setLoading(false);
      } catch (e) {
        if (!alive) return;
        setLoading(false);
        toast("读取音乐库失败：" + String(e), "error");
      }
    };
    void job();
    return () => {
      alive = false;
    };
  }, [tab, version, sort, order]);

  // 当前选中的排序项（按钮 title 用；也用来判断菜单里哪一条打勾）。
  // 表头点出来的组合（如 标题 降序）不在菜单里，所以再兜一个「键名 + 方向」的说法。
  const currentSortOption = SORT_OPTIONS.find((o) => o.sort === sort && o.order === order);
  const sortLabel =
    currentSortOption?.label ?? SORT_LABELS[sort] + (order === "desc" ? "（降序）" : "（升序）");

  const changeSort = (by: TrackSort) => {
    if (by === sort) {
      setSortOrder(by, order === "asc" ? "desc" : "asc");
    } else {
      setSortOrder(by, "asc");
    }
  };

  // 追加下一页：TrackList 滚到已加载末尾附近时回调
  const loadMoreTracks = useCallback(() => {
    if (tab !== "tracks" || loadingMore.current) return;
    const loaded = tracks.length;
    if (loaded === 0 || loaded >= total) return;
    loadingMore.current = true;
    const gen = genRef.current;
    const nextPage = Math.floor(loaded / PAGE_SIZE) + 1;
    void (async () => {
      try {
        const page = await api.tracksList({ sort, order, page: nextPage, pageSize: PAGE_SIZE });
        if (gen !== genRef.current) return; // 期间换了排序/页签，丢弃
        // 只有在期间没有别的写入时才追加，避免与刷新打架
        setTracks((cur) => (cur.length === loaded ? cur.concat(page.items) : cur));
        setTotal(page.total);
      } catch (e) {
        toast("加载更多失败：" + String(e), "error");
      } finally {
        loadingMore.current = false;
      }
    })();
  }, [tab, sort, order, tracks.length, total]);

  // 播放全部：还没加载完就先把剩余页拉齐，否则「播放全部」只播了已加载的那一截
  const playAllTracks = useCallback(async () => {
    if (loadingAll || tracks.length === 0) return;
    if (tracks.length >= total) {
      await playTrack(tracks[0].id, tracks.map((t) => t.id));
      return;
    }
    setLoadingAll(true);
    const gen = genRef.current;
    try {
      const all = tracks.slice();
      let seen = total;
      let page = Math.floor(all.length / PAGE_SIZE) + 1;
      while (all.length < seen) {
        const p = await api.tracksList({ sort, order, page, pageSize: PAGE_SIZE });
        if (gen !== genRef.current) return;
        if (p.items.length === 0) break;
        all.push(...p.items);
        seen = p.total;
        page += 1;
      }
      setTracks(all);
      setTotal(seen);
      await playTrack(all[0].id, all.map((t) => t.id));
    } catch (e) {
      toast("播放全部失败：" + String(e), "error");
    } finally {
      setLoadingAll(false);
    }
  }, [tracks, total, sort, order, playTrack, loadingAll]);

  return (
    <div className="view-root">
      <div className="view-header">
        <div className="view-header-main">
          <div>
            <div className="view-title">音乐库</div>
            <div className="view-sub">
              {stats
                ? stats.trackCount +
                  " 首歌曲 · " +
                  stats.albumCount +
                  " 张专辑 · " +
                  stats.artistCount +
                  " 位艺术家 · " +
                  formatTotalDuration(stats.totalDurationSecs)
                : "正在统计…"}
            </div>
          </div>
        </div>
        <div className="view-actions">
          <button className="pill-btn" onClick={() => void pickAndAddMusicFolder()}>
            <Icon name="plus" />
            添加音乐
          </button>
        </div>
      </div>

      <div className="chip-row">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={"chip" + (tab === t.key ? " active" : "")}
            onClick={() => nav.library(t.key)}
          >
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {tab === "tracks" && total > 0 && (
          <button
            ref={sortBtnRef}
            className="pill-btn"
            title={"排序方式：" + sortLabel}
            onClick={(e) => {
              if (sortMenu) {
                setSortMenu(null);
                return;
              }
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setSortMenu({ x: Math.max(8, r.right - 190), y: r.bottom + 6 });
            }}
          >
            <Icon name="sort" />
            排序方式
          </button>
        )}
        {tab === "tracks" && tracks.length > 0 && (
          <button className="pill-btn" disabled={loadingAll} onClick={() => void playAllTracks()}>
            <Icon name="play" />
            {loadingAll ? "正在载入…" : "播放全部"}
          </button>
        )}
      </div>

      {loading ? (
        <div className="loading-row">
          <span className="spinner" />
          正在读取…
        </div>
      ) : tab === "tracks" ? (
        <>
          {total > tracks.length && (
            <div className="list-note">
              已加载 {tracks.length} / 共 {total} 首 · 继续向下滚动自动加载
            </div>
          )}
          <TrackList
            tracks={tracks}
            total={total}
            onLoadMore={loadMoreTracks}
            resetKey={tab + ":" + sort + ":" + order + ":" + version}
            sort={sort}
            order={order}
            onSortChange={changeSort}
            emptyText="音乐库还是空的"
          />
        </>
      ) : tab === "albums" ? (
        <div className="list-viewport">
          <AlbumGrid
            albums={albums}
            onOpen={(album) => nav.album(album.id)}
            onPlay={(album) => {
              void (async () => {
                const list = await api.albumTracks(album.id);
                if (list.length > 0) await playTrack(list[0].id, list.map((t) => t.id));
              })();
            }}
          />
        </div>
      ) : (
        <div className="list-viewport">
          {artists.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">☺</div>
              <div className="empty-state-title">还没有艺术家</div>
              <div className="empty-state-sub">导入音乐后自动识别</div>
            </div>
          ) : (
            artists.map((artist) => (
              <div key={artist.name} className="artist-row" onClick={() => nav.artist(artist.name)}>
                <div
                  className="artist-avatar"
                  style={{ background: "linear-gradient(135deg, #6B4E71, #A98BB0)" }}
                >
                  {(artist.name || "?").slice(0, 1).toUpperCase()}
                </div>
                <div className="artist-name">{artist.name}</div>
                <div className="artist-count">
                  {artist.trackCount} 首 · {artist.albumCount} 张专辑
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {sortMenu && (
        <div
          ref={sortMenuRef}
          className="context-menu"
          style={{ left: sortMenu.x, top: Math.min(sortMenu.y, window.innerHeight - 320) }}
        >
          {SORT_OPTIONS.map((o) => {
            const active = o.sort === sort && o.order === order;
            return (
              <div
                key={o.key}
                className="context-item"
                onClick={() => {
                  setSortOrder(o.sort, o.order);
                  setSortMenu(null);
                }}
              >
                <span style={{ width: 16, display: "inline-flex", flexShrink: 0 }}>
                  {active ? <Icon name="check" /> : null}
                </span>
                {o.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
