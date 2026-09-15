// 专辑详情：大封面头 + 曲目列表
import { useEffect, useState } from "react";
import * as api from "../api/ipc";
import type { Track } from "../api/types";
import { TrackList } from "../components/TrackList";
import { Cover } from "../components/Cover";
import { Icon } from "../components/Icon";
import { useNavStore, nav } from "../stores/navStore";
import { usePlayerStore } from "../stores/playerStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useUiStore, toast } from "../stores/uiStore";
import { albumLabel, formatTotalDuration } from "../lib/format";

export function AlbumView() {
  const albumId = useNavStore((s) => s.view.id);
  const back = useNavStore((s) => s.back);
  const canGoBack = useNavStore((s) => s.stack.length > 0);
  const version = useLibraryStore((s) => s.version);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const setPlayMode = usePlayerStore((s) => s.setPlayMode);
  const openDialog = useUiStore((s) => s.openDialog);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (albumId == null) return;
    let alive = true;
    setLoading(true);
    void api
      .albumTracks(albumId)
      .then((list) => {
        if (!alive) return;
        setTracks(list);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setLoading(false);
        toast("读取专辑失败：" + String(e), "error");
      });
    return () => {
      alive = false;
    };
  }, [albumId, version]);

  const first = tracks[0];
  const totalSecs = tracks.reduce((sum, t) => sum + t.durationSecs, 0);
  const ids = tracks.map((t) => t.id);

  return (
    <div className="view-root">
      <div className="detail-header">
        <Cover className="detail-cover" trackId={albumId ?? null} seed={albumId ?? 0} />
        <div className="detail-info">
          <div className="detail-kicker">Album</div>
          <div className="detail-title" title={albumLabel(first?.album)}>
            {albumLabel(first?.album)}
          </div>
          <div className="detail-meta">
            <span
              className="meta-link"
              onClick={() => first?.albumArtist && nav.artist(first.albumArtist)}
            >
              {first?.albumArtist || first?.artist || "未知艺术家"}
            </span>
            {first?.year ? " · " + first.year : ""}
            {" · " + tracks.length + " 首 · " + formatTotalDuration(totalSecs)}
          </div>
          <div className="detail-actions">
            {canGoBack && (
              <button className="back-btn" title="返回" onClick={back}>
                <Icon name="chevron-left" />
              </button>
            )}
            <button
              className="pill-btn primary"
              disabled={tracks.length === 0}
              onClick={() => first && void playTrack(first.id, ids)}
            >
              <Icon name="play" />
              播放
            </button>
            <button
              className="pill-btn"
              disabled={tracks.length === 0}
              onClick={() => {
                void (async () => {
                  await setPlayMode("shuffle");
                  if (first) await playTrack(first.id, ids);
                })();
              }}
            >
              <Icon name="shuffle" />
              随机播放
            </button>
            <button
              className="pill-btn"
              disabled={tracks.length === 0}
              onClick={() => openDialog({ kind: "add-to-playlist", trackIds: ids })}
            >
              <Icon name="plus" />
              添加到播放列表
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading-row">
          <span className="spinner" />
          正在读取专辑…
        </div>
      ) : (
        <TrackList tracks={tracks} showAlbum={false} emptyText="这张专辑还没有歌曲" />
      )}
    </div>
  );
}
