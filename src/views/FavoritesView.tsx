// 收藏模块 —— 版式与播放列表详情一致（详情头 + 曲目列表）
//
// 收藏本身只存了一个 id 数组（settings 的 favorites 键，见 lib/favorites.ts），
// 曲目明细在这里用 tracks_by_ids 补齐：一次 IPC 取回全部，且返回顺序 = 收藏顺序。
// 任何位置的收藏按钮（播放条、曲目行右侧的心形）都写的是同一个键，
// 所以这个列表会自动跟着变 —— 不需要各处再通知它。
import { useEffect, useMemo, useState } from "react";
import * as api from "../api/ipc";
import type { Track } from "../api/types";
import { TrackList } from "../components/TrackList";
import { Cover } from "../components/Cover";
import { Icon } from "../components/Icon";
import { useFavorites } from "../lib/favorites";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { toast } from "../stores/uiStore";
import { formatTotalDuration } from "../lib/format";

export function FavoritesView() {
  const { favorites } = useFavorites();
  const version = useLibraryStore((s) => s.version);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const setPlayMode = usePlayerStore((s) => s.setPlayMode);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  // favorites 的引用只在设置真的变了才换（useFavorites 里过了 useMemo），可以直接当依赖；
  // version 是曲库版本，重扫后曲目明细（时长/专辑/封面）要跟着更新。
  useEffect(() => {
    let alive = true;
    if (favorites.length === 0) {
      setTracks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const list = await api.tracksByIds(favorites);
        if (alive) setTracks(list);
      } catch (e) {
        if (alive) toast("读取收藏失败：" + String(e), "error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [favorites, version]);

  // 在本页取消收藏要立刻从列表里消失，不等下一次 IPC：直接按当前收藏集合过滤。
  // （新增收藏不会走这条路 —— 那一侧得等 tracks 重新取回来才有明细。）
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const rows = useMemo(() => tracks.filter((t) => favoriteSet.has(t.id)), [tracks, favoriteSet]);
  const ids = rows.map((t) => t.id);
  const totalSecs = rows.reduce((sum, t) => sum + t.durationSecs, 0);
  /** 收藏里已经不在曲库中的条数（文件被删/移走），只提示不清理 */
  const missing = favorites.length - rows.length;

  return (
    <div className="view-root">
      <div className="detail-header">
        <Cover className="detail-cover" trackId={rows[0]?.id ?? null} seed={0} glyph="♥" />
        <div className="detail-info">
          <div className="detail-kicker">Favorite</div>
          <div className="detail-title">我的收藏</div>
          <div className="detail-meta">
            {rows.length} 首{totalSecs > 0 ? " · " + formatTotalDuration(totalSecs) : ""}
            {missing > 0 ? " · " + missing + " 首已不在曲库" : ""}
          </div>
          <div className="detail-actions">
            <button
              className="pill-btn primary"
              disabled={rows.length === 0}
              onClick={() => rows[0] && void playTrack(rows[0].id, ids)}
            >
              <Icon name="play" />
              播放全部
            </button>
            <button
              className="pill-btn"
              disabled={rows.length === 0}
              onClick={() => {
                void (async () => {
                  await setPlayMode("shuffle");
                  if (rows[0]) await playTrack(rows[0].id, ids);
                })();
              }}
            >
              <Icon name="shuffle" />
              随机播放
            </button>
          </div>
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className="loading-row">
          <span className="spinner" />
          正在读取收藏…
        </div>
      ) : (
        <TrackList
          tracks={rows}
          emptyText="还没有收藏的歌曲"
          emptyHint="在任意位置点歌曲右侧的心形按钮，就会收进这里"
        />
      )}
    </div>
  );
}
