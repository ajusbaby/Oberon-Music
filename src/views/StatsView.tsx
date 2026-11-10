// 统计页：本周 / 本月 / 本年 / 总共 四档，区间大字号总时长 + 柱状图 + 两项指标 + 歌曲明细。
// 数据全部来自 src/lib/listenLog.ts 的本机日志，前端聚合，不碰后端。
import { useMemo, useState } from "react";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { StatsChart } from "../components/StatsChart";
import { StatsTrackList } from "../components/StatsTrackList";
import {
  SCOPE_LABEL,
  SCOPES,
  fmtDurationLong,
  summarizeScope,
  trackTotals,
  useListenLog,
  type Scope,
} from "../lib/listenLog";

const fmtSecs = (n: number) => fmtDurationLong(n);
const fmtCount = (n: number) => String(Math.round(n));

export function StatsView() {
  const [scope, setScope] = useState<Scope>("week");
  const log = useListenLog();

  const summary = useMemo(() => summarizeScope(log, scope), [log, scope]);
  const trackRows = useMemo(() => trackTotals(log, scope), [log, scope]);

  const hasData = summary.totalSecs > 0 || summary.totalPlays > 0;

  return (
    <div className="view-root stats-view">
      <div className="view-header">
        <div className="view-header-main">
          <div>
            <div className="view-title">统计</div>
            <div className="view-sub">只记在这台机器上</div>
          </div>
        </div>
        <div className="view-actions">
          <div className="stats-seg" role="group" aria-label="统计区间">
            {SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                className={"stats-seg-btn" + (s === scope ? " active" : "")}
                aria-pressed={s === scope}
                onClick={() => setScope(s)}
              >
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="list-viewport">
        <section className="stats-card">
          <div className="stats-range">{summary.rangeLabel}</div>
          <div className="stats-hero">
            <AnimatedNumber key={scope} className="stats-hero-num" value={summary.totalSecs} format={fmtSecs} />
          </div>

          <StatsChart key={scope} buckets={summary.buckets} />

          <div className="stats-metrics">
            <div className="stats-metric">
              <div className="stats-metric-label">听歌数</div>
              <div className="stats-metric-value">
                <AnimatedNumber key={scope + "-plays"} value={summary.totalPlays} format={fmtCount} />
              </div>
            </div>
            <div className="stats-metric">
              <div className="stats-metric-label">收听天数</div>
              <div className="stats-metric-value">
                <AnimatedNumber key={scope + "-days"} value={summary.activeDays} format={fmtCount} />
              </div>
            </div>
          </div>

          {hasData ? (
            <>
              <div className="stats-songs-head">
                <span className="stats-songs-title">歌曲</span>
                <span className="stats-songs-count">{summary.totalTracks} 首</span>
              </div>
              <StatsTrackList rows={trackRows} />
            </>
          ) : (
            <div className="stats-empty">
              <div className="stats-empty-title">这段时间还没有记录</div>
              <div className="stats-empty-desc">开始播放之后，这里的时长、次数和歌曲明细会自动出现。</div>
            </div>
          )}
        </section>

        <div className="stats-footnote">
          记录保存在本机，不上传、不联网；清空应用数据会重新开始记账。
        </div>
      </div>
    </div>
  );
}
