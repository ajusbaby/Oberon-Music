// 搜索：输入即时查询（防抖 250ms），分区展示歌曲 / 专辑 / 艺术家 / 播放列表
import { useEffect, useState } from "react";
import * as api from "../api/ipc";
import type { SearchResult } from "../api/types";
import { TrackList } from "../components/TrackList";
import { AlbumGrid } from "../components/AlbumGrid";
import { Icon } from "../components/Icon";
import { useSearchStore } from "../stores/searchStore";
import { usePlayerStore } from "../stores/playerStore";
import { useLibraryStore } from "../stores/libraryStore";
import { nav } from "../stores/navStore";
import { toast } from "../stores/uiStore";

const EMPTY: SearchResult = { tracks: [], albums: [], artists: [], playlists: [] };

export function SearchView() {
  const query = useSearchStore((s) => s.query);
  const version = useLibraryStore((s) => s.version);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const [result, setResult] = useState<SearchResult>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState("");

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResult(EMPTY);
      setSearched("");
      return;
    }
    const timer = window.setTimeout(() => {
      let alive = true;
      setLoading(true);
      void api
        .search(q)
        .then((r) => {
          if (!alive) return;
          setResult(r);
          setSearched(q);
          setLoading(false);
        })
        .catch((e) => {
          if (!alive) return;
          setLoading(false);
          toast("搜索失败：" + String(e), "error");
        });
      return () => {
        alive = false;
      };
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, version]);

  const nothing =
    searched.length > 0 &&
    result.tracks.length === 0 &&
    result.albums.length === 0 &&
    result.artists.length === 0 &&
    result.playlists.length === 0;

  return (
    <div className="view-root">
      <div className="view-header">
        <div className="view-header-main">
          <div>
            <div className="view-title">搜索</div>
            <div className="view-sub">
              {searched.length === 0
                ? "输入关键词，搜索歌曲、专辑、艺术家与播放列表"
                : "“" + searched + "” 的结果"}
            </div>
          </div>
        </div>
        {loading && <span className="spinner" />}
      </div>

      <div className="list-viewport">
        {searched.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⌕</div>
            <div className="empty-state-title">开始输入以搜索</div>
            <div className="empty-state-sub">支持标题、艺术家、专辑名与播放列表名</div>
          </div>
        ) : nothing ? (
          <div className="empty-state">
            <div className="empty-state-icon">∅</div>
            <div className="empty-state-title">没有找到匹配内容</div>
            <div className="empty-state-sub">换个关键词试试</div>
          </div>
        ) : (
          <>
            {result.tracks.length > 0 && (
              <>
                <div className="section-title">歌曲 · {result.tracks.length}</div>
                <div className="search-track-block">
                  <TrackList
                    tracks={result.tracks.slice(0, 100)}
                    queueIds={result.tracks.map((t) => t.id)}
                    emptyText="没有匹配的歌曲"
                  />
                </div>
              </>
            )}

            {result.albums.length > 0 && (
              <>
                <div className="section-title">专辑 · {result.albums.length}</div>
                <AlbumGrid
                  albums={result.albums}
                  onOpen={(album) => nav.album(album.id)}
                  onPlay={(album) => {
                    void (async () => {
                      const list = await api.albumTracks(album.id);
                      if (list.length > 0) await playTrack(list[0].id, list.map((t) => t.id));
                    })();
                  }}
                />
              </>
            )}

            {result.artists.length > 0 && (
              <>
                <div className="section-title">艺术家 · {result.artists.length}</div>
                {result.artists.map((artist) => (
                  <div
                    key={artist.name}
                    className="artist-row"
                    onClick={() => nav.artist(artist.name)}
                  >
                    <div
                      className="artist-avatar"
                      style={{ background: "linear-gradient(135deg, #8A5A44, #C89F7B)" }}
                    >
                      {(artist.name || "?").slice(0, 1).toUpperCase()}
                    </div>
                    <div className="artist-name">{artist.name}</div>
                    <div className="artist-count">
                      {artist.trackCount} 首 · {artist.albumCount} 张专辑
                    </div>
                  </div>
                ))}
              </>
            )}

            {result.playlists.length > 0 && (
              <>
                <div className="section-title">播放列表 · {result.playlists.length}</div>
                {result.playlists.map((p) => (
                  <div key={p.id} className="artist-row" onClick={() => nav.playlist(p.id)}>
                    <div className="artist-avatar" style={{ borderRadius: 10 }}>
                      <Icon name="queue" size={18} />
                    </div>
                    <div className="artist-name">{p.name}</div>
                    <div className="artist-count">{p.trackCount} 首</div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
