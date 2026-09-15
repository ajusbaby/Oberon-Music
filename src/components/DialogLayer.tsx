// 对话框层：新建播放列表 / 添加到播放列表 / 重命名 / 添加歌曲 / 通用确认
import { useEffect, useMemo, useState } from "react";
import * as api from "../api/ipc";
import type { Track } from "../api/types";
import { useUiStore, toast } from "../stores/uiStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { nav } from "../stores/navStore";
import { Icon } from "./Icon";
import { Cover } from "./Cover";
import { formatTime } from "../lib/format";

export function DialogLayer() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);
  const playlists = usePlaylistStore((s) => s.playlists);
  const createPlaylist = usePlaylistStore((s) => s.create);
  const renamePlaylist = usePlaylistStore((s) => s.rename);
  const refreshPlaylists = usePlaylistStore((s) => s.refresh);

  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [pickerTracks, setPickerTracks] = useState<Track[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  // 打开对话框时重置表单
  useEffect(() => {
    setInvalid(false);
    setBusy(false);
    setPicked([]);
    setPickerQuery("");
    if (dialog?.kind === "create-playlist") setName("");
    if (dialog?.kind === "rename-playlist") setName(dialog.name);
    if (dialog?.kind === "add-tracks") {
      void api
        .tracksList({ sort: "title", order: "asc", page: 1, pageSize: 500 })
        .then((page) => setPickerTracks(page.items))
        .catch(() => setPickerTracks([]));
    }
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, close]);

  const filteredTracks = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return pickerTracks;
    return pickerTracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q)
    );
  }, [pickerTracks, pickerQuery]);

  if (!dialog) return null;

  const submitCreate = async () => {
    const value = name.trim();
    if (!value) {
      setInvalid(true);
      window.setTimeout(() => setInvalid(false), 800);
      return;
    }
    setBusy(true);
    const created = await createPlaylist(value);
    setBusy(false);
    close();
    if (created) {
      toast("已创建播放列表“" + created.name + "”", "success");
      nav.playlist(created.id);
    }
  };

  const submitRename = async () => {
    if (dialog.kind !== "rename-playlist") return;
    const value = name.trim();
    if (!value) {
      setInvalid(true);
      window.setTimeout(() => setInvalid(false), 800);
      return;
    }
    setBusy(true);
    await renamePlaylist(dialog.playlistId, value);
    setBusy(false);
    close();
    toast("已重命名", "success");
  };

  const addToPlaylist = async (playlistId: number) => {
    if (dialog.kind !== "add-to-playlist") return;
    setBusy(true);
    try {
      await api.playlistAddTracks(playlistId, dialog.trackIds);
      await refreshPlaylists();
      toast("已添加 " + dialog.trackIds.length + " 首到播放列表", "success");
    } catch (e) {
      toast("添加失败：" + String(e), "error");
    } finally {
      setBusy(false);
      close();
    }
  };

  const submitAddTracks = async () => {
    if (dialog.kind !== "add-tracks" || picked.length === 0) return;
    setBusy(true);
    try {
      await api.playlistAddTracks(dialog.playlistId, picked);
      await refreshPlaylists();
      toast("已添加 " + picked.length + " 首", "success");
    } catch (e) {
      toast("添加失败：" + String(e), "error");
    } finally {
      setBusy(false);
      close();
    }
  };

  return (
    <div
      className="dialog-overlay visible"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog" style={dialog.kind === "add-tracks" ? { width: 520 } : undefined}>
        {dialog.kind === "create-playlist" && (
          <>
            <div className="dialog-title">新建播放列表</div>
            <div className="dialog-label">播放列表名称</div>
            <input
              className="dialog-input"
              style={invalid ? { borderColor: "#E81123" } : undefined}
              placeholder="输入播放列表名称…"
              maxLength={60}
              autoComplete="off"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitCreate();
              }}
            />
            <div className="dialog-actions">
              <button className="dialog-btn cancel" onClick={close}>
                取消
              </button>
              <button className="dialog-btn confirm" disabled={busy} onClick={() => void submitCreate()}>
                创建
              </button>
            </div>
          </>
        )}

        {dialog.kind === "rename-playlist" && (
          <>
            <div className="dialog-title">重命名播放列表</div>
            <div className="dialog-label">新的名称</div>
            <input
              className="dialog-input"
              style={invalid ? { borderColor: "#E81123" } : undefined}
              maxLength={60}
              autoComplete="off"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
              }}
            />
            <div className="dialog-actions">
              <button className="dialog-btn cancel" onClick={close}>
                取消
              </button>
              <button className="dialog-btn confirm" disabled={busy} onClick={() => void submitRename()}>
                保存
              </button>
            </div>
          </>
        )}

        {dialog.kind === "add-to-playlist" && (
          <>
            <div className="dialog-title">添加到播放列表</div>
            <div className="dialog-label">{dialog.trackIds.length} 首歌曲</div>
            <div className="dialog-list">
              {playlists.length === 0 ? (
                <div className="dialog-empty">还没有播放列表，先创建一个吧</div>
              ) : (
                playlists.map((p) => (
                  <div
                    key={p.id}
                    className="dialog-list-item"
                    onClick={() => void addToPlaylist(p.id)}
                  >
                    <Icon name="queue" size={16} />
                    <span className="dialog-list-name">{p.name}</span>
                    <span className="dialog-list-count">{p.trackCount} 首</span>
                  </div>
                ))
              )}
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel" onClick={close}>
                取消
              </button>
              <button
                className="dialog-btn confirm"
                onClick={() => {
                  close();
                  useUiStore.getState().openDialog({ kind: "create-playlist" });
                }}
              >
                新建播放列表
              </button>
            </div>
          </>
        )}

        {dialog.kind === "add-tracks" && (
          <>
            <div className="dialog-title">添加歌曲</div>
            <div className="dialog-label">
              已选 {picked.length} 首 · 可多选（显示前 500 首，可用关键词过滤）
            </div>
            <input
              className="dialog-input"
              placeholder="过滤歌曲…"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
            <div className="dialog-track-list">
              {filteredTracks.length === 0 ? (
                <div className="dialog-empty">没有匹配的歌曲</div>
              ) : (
                filteredTracks.map((track) => {
                  const checked = picked.includes(track.id);
                  return (
                    <div
                      key={track.id}
                      className={"dialog-track" + (checked ? " checked" : "")}
                      onClick={() =>
                        setPicked((prev) =>
                          checked ? prev.filter((id) => id !== track.id) : [...prev, track.id]
                        )
                      }
                    >
                      <span className={"dialog-check" + (checked ? " on" : "")}>
                        {checked ? <Icon name="check" size={12} /> : null}
                      </span>
                      <Cover className="dialog-track-cover" trackId={track.id} seed={track.id} />
                      <span className="dialog-track-title" title={track.title}>
                        {track.title || "未知标题"}
                      </span>
                      <span className="dialog-track-artist" title={track.artist}>
                        {track.artist}
                      </span>
                      <span className="dialog-track-dur">{formatTime(track.durationSecs)}</span>
                    </div>
                  );
                })
              )}
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel" onClick={close}>
                取消
              </button>
              <button
                className="dialog-btn confirm"
                disabled={busy || picked.length === 0}
                onClick={() => void submitAddTracks()}
              >
                添加
              </button>
            </div>
          </>
        )}

        {dialog.kind === "confirm" && (
          <>
            <div className="dialog-title">{dialog.title}</div>
            <div className="dialog-message">{dialog.message}</div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel" onClick={close}>
                取消
              </button>
              <button
                className="dialog-btn confirm"
                onClick={() => {
                  dialog.onConfirm();
                  close();
                }}
              >
                {dialog.confirmText}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
