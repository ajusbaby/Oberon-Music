// 曲目列表 —— 虚拟滚动 + 表头排序 + 行操作菜单
import { useEffect, useMemo, useRef, useState } from "react";
import type { Track, TrackSort, SortOrder } from "../api/types";
import { Icon } from "./Icon";
import { Cover } from "./Cover";
import { usePlayerStore } from "../stores/playerStore";
import { useUiStore } from "../stores/uiStore";
import { nav } from "../stores/navStore";
import { useFavorites } from "../lib/favorites";
import { formatTime } from "../lib/format";

const ROW_HEIGHT = 56;
const OVERSCAN = 6;
/** 滚到距已加载末尾这么多行时请求下一页 */
const LOAD_MORE_THRESHOLD = 20;

interface TrackListProps {
  tracks: Track[];
  /** 点击播放时提交的队列（默认使用当前列表顺序） */
  queueIds?: number[];
  showAlbum?: boolean;
  sort?: TrackSort;
  order?: SortOrder;
  onSortChange?: (by: TrackSort) => void;
  /** 播放列表内：移除 / 上移 / 下移 */
  onRemove?: (track: Track) => void;
  onMove?: (track: Track, delta: number) => void;
  emptyText?: string;
  /** 空态说明的第二行（默认引导去扫描音乐文件夹；收藏页要换成自己的说法） */
  emptyHint?: string;
  /** 数据源总行数；大于 tracks.length 时表示还有未加载的页，滚动高度按它算 */
  total?: number;
  /** 滚到已加载末尾附近时回调，用于追加下一页 */
  onLoadMore?: () => void;
  /** 给了它就在它变化时回到顶部（用于增量加载：追加数据不该回顶） */
  resetKey?: string;
}

interface MenuState {
  x: number;
  y: number;
  track: Track;
}

export function TrackList({
  tracks,
  queueIds,
  showAlbum = true,
  sort,
  order,
  onSortChange,
  onRemove,
  onMove,
  emptyText = "这里还没有歌曲",
  emptyHint = "扫描音乐文件夹后即可在这里看到歌曲",
  total,
  onLoadMore,
  resetKey,
}: TrackListProps) {
  const player = usePlayerStore((s) => s.state);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const openDialog = useUiStore((s) => s.openDialog);
  const { isFavorite, toggle } = useFavorites();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  // 切换列表内容时回到顶部。增量加载时 tracks 每次追加都会换引用，
  // 若还按 tracks 复位就会把用户拉回列表顶部 —— 所以给了 resetKey 的调用方按它复位。
  const resetDep = resetKey ?? tracks;
  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [resetDep]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const ids = queueIds ?? tracks.map((t) => t.id);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    tracks.length,
    Math.ceil((scrollTop + Math.max(viewportHeight, ROW_HEIGHT)) / ROW_HEIGHT) + OVERSCAN
  );
  const visible = useMemo(() => tracks.slice(start, end), [tracks, start, end]);

  // 还有未加载的页时，滚动高度按「总数」算，这样滚动条长度与可滚动范围才是对的，
  // 用户也才能一路滚到末尾把后续页拽进来。滚到已加载末尾附近就回调请求下一页。
  const rowCount = total === undefined ? tracks.length : Math.max(total, tracks.length);
  useEffect(() => {
    if (!onLoadMore || tracks.length === 0 || tracks.length >= rowCount) return;
    if (end >= tracks.length - LOAD_MORE_THRESHOLD) onLoadMore();
  }, [onLoadMore, tracks.length, rowCount, end]);

  const sortArrow = (by: TrackSort) => {
    if (sort !== by) return "";
    return order === "desc" ? " ↓" : " ↑";
  };

  return (
    <div className="detail-body">
      <div className="track-list-head">
        <span className="col-idx">#</span>
        <span
          className={"col-title" + (onSortChange ? " sortable" : "")}
          onClick={() => onSortChange?.("title")}
        >
          标题{sortArrow("title")}
        </span>
        {showAlbum && (
          <span
            className={"col-album" + (onSortChange ? " sortable" : "")}
            onClick={() => onSortChange?.("album")}
          >
            专辑{sortArrow("album")}
          </span>
        )}
        <span
          className={"col-dur" + (onSortChange ? " sortable" : "")}
          onClick={() => onSortChange?.("duration")}
        >
          时长{sortArrow("duration")}
        </span>
        <span style={{ width: 116, flexShrink: 0 }} />
      </div>

      <div className="list-viewport" ref={viewportRef}>
        {tracks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">♪</div>
            <div className="empty-state-title">{emptyText}</div>
            <div className="empty-state-sub">{emptyHint}</div>
          </div>
        ) : (
          <div className="list-inner" style={{ height: rowCount * ROW_HEIGHT }}>
            {visible.map((track, i) => {
              const index = start + i;
              const playing = player?.current?.trackId === track.id;
              return (
                <div
                  key={track.id}
                  className={"track-row" + (playing ? " playing" : "")}
                  style={{ top: index * ROW_HEIGHT }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest(".track-actions")) return;
                    void playTrack(track.id, ids);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, track });
                  }}
                >
                  <span className="track-index">{playing ? "▶" : index + 1}</span>
                  <Cover className="track-cover" trackId={track.id} seed={track.id} />
                  <div className="track-head">
                    <div className="track-title" title={track.title}>
                      {track.title || "未知标题"}
                    </div>
                    <div className="track-sub" title={track.artist}>
                      {track.artist || "未知艺术家"}
                      {!showAlbum && track.album ? " · " + track.album : ""}
                    </div>
                  </div>
                  {showAlbum && (
                    <div className="track-album" title={track.album}>
                      {track.album || "—"}
                    </div>
                  )}
                  <div className="track-dur">{formatTime(track.durationSecs)}</div>
                  <div className="track-actions">
                    <button
                      className={"icon-only-btn" + (isFavorite(track.id) ? " favorited" : "")}
                      title={isFavorite(track.id) ? "取消收藏" : "收藏"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(track.id);
                      }}
                    >
                      <Icon name="heart" />
                    </button>
                    {onMove && (
                      <>
                        <button
                          className="icon-only-btn"
                          title="上移"
                          onClick={(e) => {
                            e.stopPropagation();
                            onMove(track, -1);
                          }}
                        >
                          <span className="tiny-arrow">↑</span>
                        </button>
                        <button
                          className="icon-only-btn"
                          title="下移"
                          onClick={(e) => {
                            e.stopPropagation();
                            onMove(track, 1);
                          }}
                        >
                          <span className="tiny-arrow">↓</span>
                        </button>
                      </>
                    )}
                    {onRemove && (
                      <button
                        className="icon-only-btn"
                        title="从播放列表移除"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(track);
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    )}
                    <button
                      className="icon-only-btn"
                      title="更多"
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setMenu({ x: rect.left - 150, y: rect.bottom + 6, track });
                      }}
                    >
                      <Icon name="more" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu && (
        <div
          className="context-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 210)),
            top: Math.min(menu.y, window.innerHeight - 240),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-item"
            onClick={() => {
              void playTrack(menu.track.id, ids);
              setMenu(null);
            }}
          >
            <Icon name="play" />
            播放
          </div>
          {/* 「添加进歌单」：这里原本还有一项「收藏 / 取消收藏」，与歌曲行尾那枚心形按钮
              是同一个动作的第二个入口（重复），按需求去掉，只保留心形按钮做收藏；
              这一项取代它，并接上原有的添加到播放列表对话框。 */}
          <div
            className="context-item"
            onClick={() => {
              openDialog({ kind: "add-to-playlist", trackIds: [menu.track.id] });
              setMenu(null);
            }}
          >
            <Icon name="plus" />
            添加进歌单
          </div>
          {menu.track.album && (
            <div
              className="context-item"
              onClick={() => {
                nav.library("albums");
                setMenu(null);
              }}
            >
              <Icon name="disc" />
              浏览专辑
            </div>
          )}
          {menu.track.artist && (
            <div
              className="context-item"
              onClick={() => {
                nav.artist(menu.track.artist);
                setMenu(null);
              }}
            >
              <Icon name="person" />
              查看艺术家
            </div>
          )}
          {onRemove && (
            <div
              className="context-item danger"
              onClick={() => {
                onRemove(menu.track);
                setMenu(null);
              }}
            >
              <Icon name="trash" />
              从播放列表移除
            </div>
          )}
        </div>
      )}
    </div>
  );
}