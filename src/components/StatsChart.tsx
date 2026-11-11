// 收听分布柱状图：纯 CSS grid，高度用 height 过渡（不再用 scaleY）。
// 不设纵轴刻度：柱高按区间内最长的那根归一，只在右上角标出这个上限。
//
// 两个刻意的设计：
// 1) 高度走幂函数而不是线性。线性归一在「一小时 vs 十秒」这种量级差下会把短柱压成
//    零点几像素、看上去直接消失；开方级压缩（GAMMA）让小值也留得住可见高度，
//    又保持"越听越高"的单调关系。原本就没有纵轴，只看相对高矮，不谎报数值。
// 2) 不用 transform: scaleY 做生长。scaleY 会把圆角一起压扁 —— 柱子一矮，
//    16px 圆角被压成亚像素，看起来就是"顶部没有圆角"。改成过渡 height 后，
//    圆角永远是真圆角，短柱由浏览器按半高自动收成小圆头。
import { useState } from "react";
import type { CSSProperties } from "react";
import { fmtDuration, type Bucket } from "../lib/listenLog";

/** 高度压缩指数：0.5 是开方，0.55 略保守一点（大柱之间的差距还能读出来） */
const GAMMA = 0.55;
/** 有记录的最矮一根也至少这么高（轨道 190px 时约 4px），空桶另有 3px 基线 */
const MIN_RATIO = 0.022;

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
          const linear = Math.min(1, b.secs / max);
          // 0 秒就是 0（空桶由 CSS 画一条 3px 基线），其余按幂函数压缩
          const ratio = b.secs <= 0 ? 0 : Math.max(MIN_RATIO, Math.pow(linear, GAMMA));
          const on = hover === i;
          const empty = b.secs <= 0 && b.plays <= 0;
          // 不挂 title：卡片顶部已经有一条实时读数，再来一个 Windows 原生 tooltip
          // 等于同一句话说两遍，而且那个白底黑框跟整套玻璃面板完全不搭。
          // 无障碍信息留在 aria-label 里，读屏器和键盘焦点都还能拿到。
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
