// 收听分布柱状图：纯 CSS grid + transform: scaleY，动画只走合成层。
// 不设纵轴刻度：柱高按区间内最长的那根归一，只在右上角标出这个上限。
import { useState } from "react";
import type { CSSProperties } from "react";
import { fmtDuration, type Bucket } from "../lib/listenLog";

export interface StatsChartProps {
  buckets: Bucket[];
}

export function StatsChart({ buckets }: StatsChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const peak = buckets.reduce((a, b) => (b.secs > a ? b.secs : a), 0);
  const max = peak > 0 ? peak : 1;
  const columns = "repeat(" + buckets.length + ", minmax(0, 1fr))";
  const hovered = hover === null ? null : buckets[hover];
  // 31 根柱子时把刻度抽稀，只留大约 10 个
  const step = Math.max(1, Math.ceil(buckets.length / 10));

  return (
    <div className="stats-chart">
      <div className="stats-chart-top">
        <div className="stats-chart-readout" aria-live="polite">
          {hovered ? (
            hovered.secs <= 0 && hovered.plays <= 0 ? (
              <>
                <span className="stats-chart-readout-title">{hovered.title}</span>
                <span className="stats-chart-readout-item">没有记录</span>
              </>
            ) : (
              <>
                <span className="stats-chart-readout-title">{hovered.title}</span>
                <span className="stats-chart-readout-item">{fmtDuration(hovered.secs)}</span>
                <span className="stats-chart-readout-item">{hovered.plays} 次播放</span>
                <span className="stats-chart-readout-item">{hovered.tracks} 首曲目</span>
              </>
            )
          ) : (
            <span className="stats-chart-readout-hint">
              {peak > 0 ? "悬停或聚焦任意一根柱子查看明细" : "这段时间还没有记录"}
            </span>
          )}
        </div>
        <div className="stats-chart-peak">{peak > 0 ? "最高 " + fmtDuration(peak) : ""}</div>
      </div>

      <div className="stats-bars" role="group" aria-label="收听时长柱状图" style={{ gridTemplateColumns: columns }}>
        {buckets.map((b, i) => {
          const ratio = Math.min(1, b.secs / max);
          const on = hover === i;
          const empty = b.secs <= 0 && b.plays <= 0;
          const label = empty
            ? b.title + "：没有记录"
            : b.title + "：" + fmtDuration(b.secs) + "，播放 " + b.plays + " 次";
          return (
            <button
              key={b.key}
              type="button"
              className={
                "stats-bar" +
                (on ? " on" : "") +
                (empty ? " is-empty" : "") +
                (i === buckets.length - 1 ? " is-last" : "")
              }
              style={{ "--v": String(ratio), "--i": String(i) } as CSSProperties}
              aria-label={label}
              title={label}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onFocus={() => setHover(i)}
              onBlur={() => setHover((h) => (h === i ? null : h))}
            >
              <span className="stats-bar-fill" />
            </button>
          );
        })}
      </div>

      <div className="stats-xaxis" aria-hidden="true" style={{ gridTemplateColumns: columns }}>
        {buckets.map((b, i) => (
          <span key={b.key} className="stats-xaxis-tick">
            {i % step === 0 || i === buckets.length - 1 ? b.label : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
