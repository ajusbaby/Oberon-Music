// 艺术家详情：头像头 + 该艺术家全部曲目 + 专辑分组
import { useEffect, useMemo, useState } from "react";
import * as api from "../api/ipc";
import type { Track } from "../api/types";
import { TrackList } from "../components/TrackList";
import { Icon } from "../components/Icon";
import { useNavStore, nav } from "../stores/navStore";
import { usePlayerStore } from "../stores/playerStore";
import { useLibraryStore } from "../stores/libraryStore";
import { toast } from "../stores/uiStore";
import { formatTotalDuration } from "../lib/format";

export function ArtistView() {
  const artistName = useNavStore((s) => s.view.key) ?? "";
  const back = useNavStore((s) => s.back);
  const canGoBack = useNavStore((s) => s.stack.length > 0);
  const version = useLibraryStore((s) => s.version);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const setPlayMode = usePlayerStore((s) => s.setPlayMode);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!artistName) return;
    let alive = true;
    setLoading(true);
    void api
      .artistTracks(artistName)
      .then((list) => {
        if (!alive) return;
        setTracks(list);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setLoading(false);
        toast("读取艺术家失败：" + String(e), "error");
      });
    return () => {
      alive = false;
    };
  }, [artistName, version]);

  const albums = useMemo(() => {
    const map = new Map<string, number>();
    tracks.forEach((t) => {
      const key = t.album || "未知专辑";
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [tracks]);

  const totalSecs = tracks.reduce((sum, t) => sum + t.durationSecs, 0);
  const ids = tracks.map((t) => t.id);

  return (
    <div className="view-root">
      <div className="detail-header">
        <div
          className="detail-cover artist-cover"
          style={{ background: "linear-gradient(135deg, #2F4858, #5C8A9E)" }}
        >
          {(artistName || "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="detail-info">
          <div className="detail-kicker">Artist</div>
          <div className="detail-title" title={artistName}>
            {artistName || "未知艺术家"}
          </div>
          <div className="detail-meta">
            {tracks.length} 首 · {albums.length} 张专辑 · {formatTotalDuration(totalSecs)}
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
              onClick={() => tracks[0] && void playTrack(tracks[0].id, ids)}
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
                  if (tracks[0]) await playTrack(tracks[0].id, ids);
                })();
              }}
            >
              <Icon name="shuffle" />
              随机播放
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading-row">
          <span className="spinner" />
          正在读取…
        </div>
      ) : (
        <>
          {albums.length > 0 && (
            <>
              <div className="section-title">专辑</div>
              <div className="album-chip-row">
                {albums.map(([name, count]) => (
                  <button
                    key={name}
                    className="chip"
                    onClick={() => {
                      const track = tracks.find((t) => (t.album || "未知专辑") === name);
                      if (track) nav.album(track.id);
                    }}
                  >
                    {name} · {count}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="section-title">全部歌曲</div>
          <TrackList tracks={tracks} emptyText="没有找到歌曲" />
        </>
      )}
    </div>
  );
}
