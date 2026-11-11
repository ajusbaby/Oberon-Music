// 统计页：本周 / 本月 / 本年 / 总共 四档，区间大字号总时长 + 柱状图 + 两项指标 + 歌曲明细。
// 数据全部来自 src/lib/listenLog.ts 的本机日志，前端聚合，不碰后端。
import { useCallback, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "../api/ipc";
import { toast } from "../stores/uiStore";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { StatsChart } from "../components/StatsChart";
import { StatsTrackList } from "../components/StatsTrackList";
import {
  SCOPE_LABEL,
  SCOPES,
  fmtDurationLong,
  restoreStatsFrom,
  summarizeScope,
  trackTotals,
  useListenLog,
  type Scope,
} from "../lib/listenLog";

const BACKUP_FILTERS = [{ name: "Oberon 听歌统计", extensions: ["json"] }];

const fmtSecs = (n: number) => fmtDurationLong(n);
const fmtCount = (n: number) => String(Math.round(n));

export function StatsView() {
  const [scope, setScope] = useState<Scope>("week");
  const log = useListenLog();

  const summary = useMemo(() => summarizeScope(log, scope), [log, scope]);
  const trackRows = useMemo(() => trackTotals(log, scope), [log, scope]);

  const hasData = summary.totalSecs > 0 || summary.totalPlays > 0;
  const [restoring, setRestoring] = useState(false);

  // 换机器 / 重装之后：把导出的那份并回来（后端按路径哈希合并，不会重复记时）
  const restore = useCallback(async () => {
    if (restoring) return;
    const picked = await open({ multiple: false, directory: false, filters: BACKUP_FILTERS });
    if (typeof picked !== "string") return;
    setRestoring(true);
    try {
      const text = await api.statsImportFile(picked);
      const result = await restoreStatsFrom(text);
      toast("已并入备份：" + result.days + " 天记录、" + result.tracks + " 首歌");
    } catch (e) {
      toast("恢复失败：" + String(e), "error");
    } finally {
      setRestoring(false);
    }
  }, [restoring]);

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
          记录只在本机，不上传、不联网。每次记录都会同时写进应用数据目录和
          「文档\Oberon\听歌统计」，卸载重装、换机器之后都能并回来。
          <span className="stats-footnote-actions">
            <button type="button" className="stats-footnote-btn" disabled={restoring} onClick={() => void restore()}>
              {restoring ? "恢复中…" : "从备份恢复"}
            </button>
            <button
              type="button"
              className="stats-footnote-btn"
              onClick={() => void api.statsReveal().catch(() => undefined)}
            >
              打开备份文件夹
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
