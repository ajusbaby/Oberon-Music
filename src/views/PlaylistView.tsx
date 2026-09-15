// 播放列表详情：播放 / 随机 / 重命名 / 删除 / 增删曲目 / 排序
import { useCallback, useEffect, useState } from "react";
import * as api from "../api/ipc";
import type { PlaylistDetail, Track } from "../api/types";
import { TrackList } from "../components/TrackList";
import { Cover } from "../components/Cover";
import { Icon } from "../components/Icon";
import { useNavStore, nav } from "../stores/navStore";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useUiStore, toast } from "../stores/uiStore";
import { formatDate, formatTotalDuration } from "../lib/format";

export function PlaylistView() {
  const playlistId = useNavStore((s) => s.view.id);
  const back = useNavStore((s) => s.back);
  const canGoBack = useNavStore((s) => s.stack.length > 0);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const setPlayMode = usePlayerStore((s) => s.setPlayMode);
  const openDialog = useUiStore((s) => s.openDialog);
  const refreshPlaylists = usePlaylistStore((s) => s.refresh);
  const listVersion = usePlaylistStore((s) => s.version);
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (playlistId == null) return;
    try {
      const data = await api.playlistGet(playlistId);
      setDetail(data);
    } catch (e) {
      toast("读取播放列表失败：" + String(e), "error");
    } finally {
      setLoading(false);
    }
  }, [playlistId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload, listVersion]);

  const tracks: Track[] = detail?.tracks ?? [];
  const ids = tracks.map((t) => t.id);
  const totalSecs = tracks.reduce((sum, t) => sum + t.durationSecs, 0);

  const removeTrack = async (track: Track) => {
    if (playlistId == null) return;
    try {
      await api.playlistRemoveTrack(playlistId, track.id);
      await reload();
      await refreshPlaylists();
      toast("已从播放列表移除", "success");
    } catch (e) {
      toast("移除失败：" + String(e), "error");
    }
  };

  const moveTrack = async (track: Track, delta: number) => {
    if (playlistId == null) return;
    const index = ids.indexOf(track.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    next.splice(index, 1);
    next.splice(target, 0, track.id);
    try {
      await api.playlistReorder(playlistId, next);
      await reload();
    } catch (e) {
      toast("排序失败：" + String(e), "error");
    }
  };

  return (
    <div className="view-root">
      <div className="detail-header">
        <Cover
          className="detail-cover"
          trackId={tracks[0]?.id ?? null}
          seed={playlistId ?? 0}
          glyph="♫"
        />
        <div className="detail-info">
          <div className="detail-kicker">Playlist</div>
          <div className="detail-title" title={detail?.name ?? ""}>
            {detail?.name ?? "播放列表"}
          </div>
          <div className="detail-meta">
            {tracks.length} 首 · {formatTotalDuration(totalSecs)}
            {detail?.createdMs ? " · 创建于 " + formatDate(detail.createdMs) : ""}
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
            <button
              className="pill-btn"
              onClick={() => openDialog({ kind: "add-tracks", playlistId: playlistId ?? 0 })}
            >
              <Icon name="plus" />
              添加歌曲
            </button>
            <button
              className="pill-btn"
              onClick={() =>
                openDialog({
                  kind: "rename-playlist",
                  playlistId: playlistId ?? 0,
                  name: detail?.name ?? "",
                })
              }
            >
              重命名
            </button>
            <button
              className="pill-btn danger"
              onClick={() =>
                openDialog({
                  kind: "confirm",
                  title: "删除播放列表",
                  message: "确定要删除“" + (detail?.name ?? "") + "”吗？此操作不会删除本地音乐文件。",
                  confirmText: "删除",
                  onConfirm: () => {
                    void (async () => {
                      if (playlistId == null) return;
                      try {
                        await api.playlistDelete(playlistId);
                        await refreshPlaylists();
                        toast("已删除播放列表", "success");
                        nav.library("tracks");
                      } catch (e) {
                        toast("删除失败：" + String(e), "error");
                      }
                    })();
                  },
                })
              }
            >
              <Icon name="trash" />
              删除
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading-row">
          <span className="spinner" />
          正在读取播放列表…
        </div>
      ) : (
        <TrackList
          tracks={tracks}
          onRemove={(track) => void removeTrack(track)}
          onMove={(track, delta) => void moveTrack(track, delta)}
          emptyText="这个播放列表还是空的"
        />
      )}
    </div>
  );
}
