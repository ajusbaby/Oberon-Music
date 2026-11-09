// 专辑页：陈列全部专辑（点击封面进详情，悬停按钮整张播放）。
// 搜索不再是这个页面的一个"状态"了 —— 它是顶栏打开的独立浮层（components/SearchPanel.tsx），
// 所以这里只有专辑墙一件事，和搜索互不影响。
import { useEffect, useState } from "react";
import * as api from "../api/ipc";
import type { Album } from "../api/types";
import { AlbumGrid } from "../components/AlbumGrid";
import { usePlayerStore } from "../stores/playerStore";
import { useLibraryStore } from "../stores/libraryStore";
import { nav } from "../stores/navStore";
import { toast } from "../stores/uiStore";

export function AlbumsView() {
  const version = useLibraryStore((s) => s.version);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const page = await api.albumsList(1, 500);
        if (alive) setAlbums(page.items);
      } catch (e) {
        if (alive) toast("读取专辑失败：" + String(e), "error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [version]);

  return (
    <div className="view-root">
      <div className="view-header">
        <div className="view-header-main">
          <div>
            <div className="view-title">专辑</div>
            <div className="view-sub">
              {loading
                ? "正在读取…"
                : albums.length === 0
                  ? "还没有专辑，导入音乐后会按标签自动聚合"
                  : "共 " + albums.length + " 张 · 点击封面查看详情，悬停播放整张"}
            </div>
          </div>
        </div>
        {loading && <span className="spinner" />}
      </div>

      <div className="list-viewport">
        {loading ? (
          <div className="loading-row">
            <span className="spinner" />
            正在读取…
          </div>
        ) : (
          <AlbumGrid
            albums={albums}
            onOpen={(album) => nav.album(album.id)}
            onPlay={(album) => {
              void (async () => {
                const list = await albumTracks(album);
                if (list.length > 0) await playTrack(list[0].id, list.map((t) => t.id));
              })();
            }}
          />
        )}
      </div>
    </div>
  );
}

/** 整张播放：先取专辑曲目，再以第一首起播 */
async function albumTracks(album: Album) {
  return api.albumTracks(album.id);
}
