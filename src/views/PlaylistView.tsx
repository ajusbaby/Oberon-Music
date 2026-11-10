// 播放列表详情：播放 / 重命名 / 删除 / 增删曲目 / 排序
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
  const openDialog = useUiStore((s) => s.openDialog);
  const refreshPlaylists = usePlaylistStore((s) => s.refresh);
  const listVersion = usePlaylistStore((s) => s.version);
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (playlistId == null) return;
    // 已经被删掉：删除会刷新列表并让本 effect 再跑一次，这里直接静默收摊，不去请求后端。
    const known = usePlaylistStore.getState().playlists;
    if (known.length > 0 && !known.some((p) => p.id === playlistId)) {
      setDetail(null);
      setLoading(false);
      return;
    }
    try {
      const data = await api.playlistGet(playlistId);
      setDetail(data);
    } catch (e) {
      // 列表里已经没有它了 = 刚被删掉。删除会刷新列表（version 自增）从而再读一次本页，
      // 这时后端当然报「找不到」，弹出来就是删除成功后紧跟一条失败提示的误报。
      if (!usePlaylistStore.getState().playlists.some((p) => p.id === playlistId)) {
        setDetail(null);
        setLoading(false);
        return;
      }
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
              <button className="back-btn" aria-label="返回" onClick={back}>
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
                        // 先离开本页再刷新列表：否则列表版本变化会让本页重新读取一个
                        // 已经不存在的 id，删除成功的提示后面紧跟一条「读取失败」误报。
                        nav.library("tracks");
                        await refreshPlaylists();
                        toast("已删除播放列表", "success");
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
