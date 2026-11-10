// 歌曲明细：当前区间里每首歌听了多久、听过几次，按时长从多到少排。
// 元数据向后端要一次；没有 Tauri IPC 时降级成「曲目 #id」，不影响版面。
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import * as api from "../api/ipc";
import type { Track } from "../api/types";
import { Cover } from "./Cover";
import { fmtDuration, type TrackTotal } from "../lib/listenLog";

export interface StatsTrackListProps {
  rows: TrackTotal[];
}

/** 一屏先给这么多行，多的折起来 */
const PAGE = 6;

export function StatsTrackList({ rows }: StatsTrackListProps) {
  const [meta, setMeta] = useState<Record<number, Track>>({});
  const [expanded, setExpanded] = useState(false);
  const signature = rows.map((r) => r.trackId).join(",");

  useEffect(() => {
    if (rows.length === 0) {
      setMeta({});
      return;
    }
    let alive = true;
    void api
      .tracksByIds(rows.map((r) => r.trackId))
      .then((list) => {
        if (!alive) return;
        const next: Record<number, Track> = {};
        for (const t of list) next[t.id] = t;
        setMeta(next);
      })
      .catch(() => {
        if (alive) setMeta({});
      });
    return () => {
      alive = false;
    };
    // signature 就是这组 trackId 的稳定指纹
  }, [signature]);

  const shown = expanded ? rows : rows.slice(0, PAGE);
  const hidden = rows.length - shown.length;

  return (
    <div className="stats-list">
      {shown.map((row, i) => {
        const track = meta[row.trackId];
        return (
          <div className="stats-row" key={row.trackId} style={{ "--i": String(Math.min(i, PAGE)) } as CSSProperties}>
            <Cover
              trackId={row.trackId}
              seed={row.trackId}
              className="stats-row-cover"
              glyph="♪"
              title={track ? track.title : "未知曲目"}
            />
            <span className="stats-row-main">
              <span className="stats-row-title">{track ? track.title : "曲目 #" + row.trackId}</span>
              <span className="stats-row-sub">
                {track ? track.artist || "未知艺术家" : "曲库中已找不到这首"}
              </span>
            </span>
            <span className="stats-row-side">
              <span className="stats-row-duration">{row.secs > 0 ? fmtDuration(row.secs) : "—"}</span>
              <span className="stats-row-plays">{row.plays > 0 ? row.plays + " 次" : ""}</span>
            </span>
          </div>
        );
      })}
      {hidden > 0 || expanded ? (
        <button
          type="button"
          className="stats-more"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "展开全部 " + rows.length + " 首"}
        </button>
      ) : null}
    </div>
  );
}
