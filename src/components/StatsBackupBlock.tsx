// 设置页「听歌统计」：把账本的两个落点、最近保存时间摆出来，并提供备份 / 恢复 / 导出 / 打开文件夹。
//
// 这块存在的意义只有一个 —— 让用户相信「统计不会丢」：
// 账本每次记录都会写到应用数据目录，并按分钟把镜像写进「文档\Oberon\听歌统计」。
// 重装、换机器、清理工具把 AppData 抹了，只要文档目录那份还在（或者你导出过一份），
// 点一下恢复就能把全部历史并回来。
import { useCallback, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as api from "../api/ipc";
import type { StatsInfo } from "../api/types";
import { backupStatsNow, restoreStatsFrom, statsSnapshotJson } from "../lib/listenLog";
import { toast } from "../stores/uiStore";

const BACKUP_FILTERS = [{ name: "Oberon 听歌统计", extensions: ["json"] }];

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function fmtTime(ms: number): string {
  if (!ms || ms <= 0) return "还没有记录";
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes())
  );
}

export function StatsBackupBlock() {
  const [info, setInfo] = useState<StatsInfo | null>(null);
  const [busy, setBusy] = useState<"" | "backup" | "restore" | "export">("");

  const refresh = useCallback(() => {
    void api
      .statsInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  useEffect(refresh, [refresh]);

  const doBackup = useCallback(async () => {
    if (busy) return;
    setBusy("backup");
    try {
      await backupStatsNow();
      refresh();
      toast("已备份到今天的两份账本里");
    } catch (e) {
      toast("备份失败：" + String(e), "error");
    } finally {
      setBusy("");
    }
  }, [busy, refresh]);

  const doRestore = useCallback(async () => {
    if (busy) return;
    const picked = await open({ multiple: false, directory: false, filters: BACKUP_FILTERS });
    if (typeof picked !== "string") return;
    setBusy("restore");
    try {
      const text = await api.statsImportFile(picked);
      const result = await restoreStatsFrom(text);
      refresh();
      toast("已并入备份：" + result.days + " 天记录、" + result.tracks + " 首歌");
    } catch (e) {
      toast("恢复失败：" + String(e), "error");
    } finally {
      setBusy("");
    }
  }, [busy, refresh]);

  const doExport = useCallback(async () => {
    if (busy) return;
    const picked = await save({
      defaultPath: "listening.json",
      filters: BACKUP_FILTERS,
    });
    if (typeof picked !== "string") return;
    setBusy("export");
    try {
      const saved = await api.statsExportFile(picked, statsSnapshotJson());
      toast("已导出到 " + saved);
    } catch (e) {
      toast("导出失败：" + String(e), "error");
    } finally {
      setBusy("");
    }
  }, [busy]);

  const mirrorLine = info?.mirror ? info.mirror : "文档\\Oberon\\听歌统计\\listening.json";

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-label">听歌统计</div>
          <div className="settings-hint">
            每次记录同时写两份：应用数据目录的 listening.json，和文档目录的镜像
            <br />
            {mirrorLine}
          </div>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-label">备份状态</div>
          <div className="settings-hint">
            {info
              ? "应用数据 " +
                fmtBytes(info.primaryBytes) +
                " · " +
                fmtTime(info.savedMs) +
                "　|　文档镜像 " +
                fmtBytes(info.mirrorBytes) +
                " · " +
                fmtTime(info.mirrorSavedMs)
              : "读取中…"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "0 0 auto" }}>
          <button className="pill-btn" disabled={busy !== ""} onClick={() => void doBackup()}>
            {busy === "backup" ? "备份中…" : "立即备份"}
          </button>
          <button className="pill-btn" disabled={busy !== ""} onClick={() => void doRestore()}>
            {busy === "restore" ? "恢复中…" : "从备份恢复"}
          </button>
          <button className="pill-btn" disabled={busy !== ""} onClick={() => void doExport()}>
            {busy === "export" ? "导出中…" : "导出"}
          </button>
          <button className="pill-btn" onClick={() => void api.statsReveal().catch(() => undefined)}>
            打开文件夹
          </button>
        </div>
      </div>
    </>
  );
}
