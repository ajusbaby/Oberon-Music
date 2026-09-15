// 音乐库 —— 歌曲 / 专辑 / 艺术家 三个页签
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/ipc";
import type { Album, Artist, SortOrder, Track, TrackSort } from "../api/types";
import { AlbumGrid } from "../components/AlbumGrid";
import { TrackList } from "../components/TrackList";
import { Icon } from "../components/Icon";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useNavStore, nav } from "../stores/navStore";
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
  const [sort, setSort] = useState<TrackSort>("title");
  const [order, setOrder] = useState<SortOrder>("asc");
  // 增量加载的并发闸门 + 代次（排序/页签切换后，旧请求的结果必须丢弃）
  const loadingMore = useRef(false);
  const genRef = useRef(0);

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

  const changeSort = (by: TrackSort) => {
    if (by === sort) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSort(by);
      setOrder("asc");
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
    </div>
  );
}
