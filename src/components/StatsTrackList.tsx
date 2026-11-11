// 歌曲明细：当前区间里每首歌听了多久、听过几次，按时长从多到少排。
//
// 标题和艺术家优先用账本里存下来的元数据 —— 这样即使歌曲已经从曲库里删了、
// 或者重装后整个曲库都还没扫，明细照样认得每一首歌。
// 只有封面需要向后端要一次：账本存的是路径哈希，得反查回当前的 trackId。

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import * as api from "../api/ipc";
import { Cover } from "./Cover";
import { fmtDuration, type TrackTotal } from "../lib/listenLog";

export interface StatsTrackListProps {
  rows: TrackTotal[];
}

/** 一屏先给这么多行，多的折起来 */
const PAGE = 6;

/** 路径哈希前 8 位当封面的渐变种子：同一首歌每次打开颜色都一样 */
function seedOf(key: string): number {
  const value = Number.parseInt(key.slice(0, 8), 16);
  return Number.isFinite(value) ? value : 0;
}

export function StatsTrackList({ rows }: StatsTrackListProps) {
  /** trackKey → 当前曲库里的 id（查不到就没有，封面退回渐变） */
  const [ids, setIds] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState(false);
  const signature = rows.map((r) => r.key).join(",");

  useEffect(() => {
    if (rows.length === 0) {
      setIds({});
      return;
    }
    let alive = true;
    void api
      .statsResolve(rows.map((r) => r.key))
      .then((list) => {
        if (!alive) return;
        const next: Record<string, number> = {};
        for (const item of list) next[item.key] = item.trackId;
        setIds(next);
      })
      .catch(() => {
        if (alive) setIds({});
      });
    return () => {
      alive = false;
    };
    // signature 就是这组曲目键的稳定指纹
  }, [signature]);

  const shown = expanded ? rows : rows.slice(0, PAGE);
  const hidden = rows.length - shown.length;

  return (
    <div className="stats-list">
      {shown.map((row, i) => {
        const trackId = ids[row.key] ?? null;
        const title = row.meta?.title || "未知曲目";
        const artist = row.meta?.artist || "";
        return (
          <div className="stats-row" key={row.key} style={{ "--i": String(Math.min(i, PAGE)) } as CSSProperties}>
            <Cover
              trackId={trackId}
              seed={seedOf(row.key)}
              className="stats-row-cover"
              glyph="♪"
              title={title}
            />
            <span className="stats-row-main">
              <span className="stats-row-title">{title}</span>
              <span className="stats-row-sub">
                {artist || (row.meta ? "未知艺术家" : "曲库中已找不到这首")}
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
