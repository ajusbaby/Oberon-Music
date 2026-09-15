// 底部播放栏 —— 结构、尺寸与设计稿一致；行为全部对接 Rust 播放内核
import { useCallback, useEffect, useRef, useState } from "react";
import { Cover } from "./Cover";
import { Icon } from "./Icon";
import { WaveProgress } from "./WaveProgress";
import { usePlayerStore } from "../stores/playerStore";
import { toast, useUiStore } from "../stores/uiStore";
import { useSelectionStore } from "../stores/selectionStore";
import { useCover } from "../lib/cover";
import { useFavorites } from "../lib/favorites";
import { formatTime } from "../lib/format";
import { DEFAULT_PLAY_MODE, modeIcon, modeLabel, nextMode } from "../lib/playMode";
import type { PlayMode, QueueItem } from "../api/types";

/**
 * 底部播放栏。
 * variant="shell"（默认）：应用主界面底部；
 * variant="lyrics"：歌词页底部复用同一套结构/样式，保证按钮、进度条位置完全一致
 *   —— 差别只有：曲目信息不可点（已在歌词页）、多一个「输出设备」按钮。
 */
export function PlayerBar({ variant = "shell" }: { variant?: "shell" | "lyrics" } = {}) {
  const inLyrics = variant === "lyrics";
  const player = usePlayerStore((s) => s.state);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const seek = usePlayerStore((s) => s.seek);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const selected = useSelectionStore((s) => s.album);
  const queueOpen = useUiStore((s) => s.queueOpen);
  const closeQueue = useUiStore((s) => s.closeQueue);
  const openLyrics = useUiStore((s) => s.openLyrics);

  const [mutedVolume, setMutedVolume] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<number | null>(null);
  // 队列可能上千首：只给可视区域附近的条目加载封面，避免一次性拉取全部封面
  const [queueScroll, setQueueScroll] = useState(0);

  const QUEUE_ROW_HEIGHT = 52;
  const queueWindowStart = Math.max(0, Math.floor(queueScroll / QUEUE_ROW_HEIGHT) - 3);
  const queueWindowEnd = queueWindowStart + 14;

  const status = player?.status ?? "stopped";
  const current = player?.current ?? null;
  const playMode: PlayMode = player?.playMode ?? DEFAULT_PLAY_MODE;
  // 显示真实音量（mutedVolume 仅用于恢复，不参与显示，否则静音后界面仍显示旧值、无法再点开）
  const volume = player?.volume ?? 70;
  const duration = current?.durationSecs ?? 0;
  // 只有真正载入了曲目（有时长）才允许拖动进度，避免看起来能拖却没有响应
  const hasTrack = !!current && duration > 0;

  // 停止状态下展示封面流选中的专辑（与设计稿 updatePlayerTrack 的行为一致）
  const displayTrackId = current?.trackId ?? selected?.id ?? null;
  const displayTitle = current?.title ?? selected?.name ?? "未播放";
  const displayArtist = current?.artist ?? selected?.artist ?? "选择一张专辑开始播放";
  const displayCover = useCover(displayTrackId);

  // 收藏统一走 lib/favorites：和歌曲行尾那枚心形按钮、收藏模块读的是同一个 settings
  // 键（favorites），所以这里点一下，Favorite 列表里立刻就有这首（反之亦然）。
  const { isFavorite, toggle: toggleFavorite } = useFavorites();
  const favorited = current ? isFavorite(current.trackId) : false;
  const onToggleFavorite = useCallback(() => {
    if (current) toggleFavorite(current.trackId);
  }, [current, toggleFavorite]);

  // 进度：播放中显示真实位置；拖动时显示拖动位置
  const position = dragPos ?? current?.positionSecs ?? 0;
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  // 进度条的指针处理搬进了 WaveProgress：它自己算 0..1 的比例，
  // 这里只负责把比例换算成秒数（拖动中即时反馈、松手才真正跳转）。

  // 音量滑杆：输入时本地即时反馈，停顿后写回内核
  const volumeTimer = useRef<number | null>(null);
  const onVolumeInput = useCallback(
    (value: number) => {
      setMutedVolume(null);
      usePlayerStore.setState((s) => ({
        state: s.state ? { ...s.state, volume: value } : s.state,
      }));
      if (volumeTimer.current !== null) window.clearTimeout(volumeTimer.current);
      volumeTimer.current = window.setTimeout(() => {
        void setVolume(value);
      }, 120);
    },
    [setVolume]
  );

  // 队列弹层：点击外部关闭（与设计稿一致）
  useEffect(() => {
    if (!queueOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".queue-popover")) return;
      closeQueue();
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [queueOpen, closeQueue]);

  const queue: QueueItem[] = player?.queue ?? [];

  const volumeIcon = volume === 0 ? "volume-muted" : volume < 50 ? "volume-low" : "volume-high";

  return (
    <div className={"bottom-player" + (inLyrics ? " in-lyrics" : "")}>
      <div className="player-controls">
        <button className="ctrl-btn" title="上一首" onClick={() => void previous()}>
          <Icon name="prev" />
        </button>
        <button
          className="ctrl-btn play-btn"
          title={status === "playing" ? "暂停" : hasTrack ? "播放" : "播放（当前专辑 / 音乐库）"}
          onClick={() => void toggle()}
        >
          <Icon name={status === "playing" ? "pause" : "play"} />
        </button>
        <button className="ctrl-btn" title="下一首" onClick={() => void next()}>
          <Icon name="next" />
        </button>
        <button
          className="ctrl-btn mode-btn active"
          title={"播放模式：" + modeLabel(playMode) + "（点击切换）"}
          onClick={() => void usePlayerStore.getState().setPlayMode(nextMode(playMode))}
        >
          <Icon name={modeIcon(playMode)} />
          {playMode === "loop-one" && <span className="repeat-one-badge">1</span>}
        </button>
      </div>

      <div
        className="player-track"
        title={inLyrics ? undefined : "展开歌词页"}
        style={inLyrics ? undefined : { cursor: "pointer" }}
        onClick={
          inLyrics
            ? undefined
            : (e) => {
                // 圆形扩散的圆心取封面中心：把封面在窗口内的位置换算成应用内坐标
                const shell = document.querySelector(".app-shell");
                const base = shell?.getBoundingClientRect();
                const coverEl = e.currentTarget.querySelector(".player-track-cover");
                const r = (coverEl ?? e.currentTarget).getBoundingClientRect();
                openLyrics({
                  x: r.left - (base?.left ?? 0),
                  y: r.top - (base?.top ?? 0),
                  w: r.width,
                  h: r.height,
                });
              }
        }
      >
        <div className="player-track-cover">
          {displayCover ? (
            <img src={displayCover} alt="" draggable={false} />
          ) : (
            <span className="player-track-glyph">♪</span>
          )}
        </div>
        <div className="player-track-info">
          <div className="player-track-name" title={displayTitle}>
            {displayTitle}
          </div>
          <div className="player-track-artist" title={displayArtist}>
            {displayArtist}
          </div>
        </div>
      </div>

      <button
        className={"favorite-btn" + (favorited ? " favorited" : "")}
        title={favorited ? "取消收藏" : "收藏"}
        onClick={onToggleFavorite}
      >
        <Icon name="heart" />
      </button>

      <div className={"progress-area" + (hasTrack ? "" : " idle")}>
        <span className="time-label">{formatTime(position)}</span>
        <WaveProgress
          value={percent / 100}
          playing={status === "playing"}
          disabled={!hasTrack}
          onScrub={(ratio) => setDragPos(ratio * duration)}
          onCommit={(ratio) => {
            setDragPos(null);
            void seek(ratio * duration);
          }}
        />
        <span className="time-label">{formatTime(duration)}</span>
      </div>

      <div className="player-right-controls">
        {inLyrics && (
          <button
            className="right-icon-btn"
            title="输出设备"
            onClick={() => toast("当前使用系统默认输出设备", "info")}
          >
            <Icon name="cast" />
          </button>
        )}
        <div className="volume-control">
          <button
            className="right-icon-btn"
            title={volume === 0 ? "取消静音" : "静音"}
            onClick={() => {
              const now = player?.volume ?? 70;
              if (now === 0) {
                const restore = mutedVolume && mutedVolume > 0 ? mutedVolume : 70;
                setMutedVolume(null);
                void setVolume(restore);
              } else {
                setMutedVolume(now);
                void setVolume(0);
              }
            }}
          >
            <Icon name={volumeIcon} />
          </button>
          <input
            type="range"
            className="volume-slider"
            min={0}
            max={100}
            value={volume}
            title="音量"
            onChange={(e) => onVolumeInput(Number(e.target.value))}
          />
        </div>

      </div>

      {/* 队列弹层：只在真的打开时才渲染。
          之前无论开不开都会把整条队列 map 成 DOM（只有封面做了窗口化，行没有），
          1 万首队列 = 约 10 万个节点，启动即付、全程驻留，而容器 max-height 只有
          300px、一屏只看得到 6 行 —— 全是白烧的。何况目前根本没有入口能打开它
          （uiStore.toggleQueue 全仓零调用），所以正常情况下这段完全不执行。
          代价：没有淡出过渡（原来是靠 CSS 类切换保留的）；真要把它做成可用 UI 时，
          得按 TrackList 那样做行虚拟化，光靠"打开才渲染"顶不住 1 万行。 */}
      {queueOpen && !inLyrics && (
        <div
          className="queue-popover visible"
          onScroll={(e) => setQueueScroll((e.target as HTMLDivElement).scrollTop)}
        >
          <div className="queue-header">Now Playing Queue</div>
          {queue.length === 0 ? (
            <div className="queue-empty">队列为空</div>
          ) : (
            queue.map((item, index) => {
              const active = player?.queueIndex === index;
              return (
                <div
                  key={item.trackId + "-" + index}
                  className={"queue-item" + (active ? " queue-item-active" : "")}
                  onClick={() => {
                    void usePlayerStore
                      .getState()
                      .playTrack(item.trackId, queue.map((q) => q.trackId));
                  }}
                >
                  {index >= queueWindowStart && index <= queueWindowEnd ? (
                    <Cover className="queue-item-cover" trackId={item.trackId} seed={item.trackId} />
                  ) : (
                    <div className="queue-item-cover">♪</div>
                  )}
                  <div className="queue-item-info">
                    <div className="queue-item-name" title={item.title}>
                      {item.title}
                    </div>
                    <div className="queue-item-artist" title={item.artist}>
                      {item.artist}
                    </div>
                  </div>
                  <div className="queue-item-dur">{formatTime(item.durationSecs)}</div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}