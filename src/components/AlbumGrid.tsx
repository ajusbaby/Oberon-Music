// 专辑网格（点击进入详情，悬停显示播放按钮）
import type { Album } from "../api/types";
import { Cover } from "./Cover";
import { albumLabel } from "../lib/format";
import { Icon } from "./Icon";

interface AlbumGridProps {
  albums: Album[];
  onOpen: (album: Album) => void;
  onPlay: (album: Album) => void;
  emptyText?: string;
}

export function AlbumGrid({ albums, onOpen, onPlay, emptyText = "还没有专辑" }: AlbumGridProps) {
  if (albums.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">◎</div>
        <div className="empty-state-title">{emptyText}</div>
        <div className="empty-state-sub">导入音乐后，专辑会自动按标签聚合</div>
      </div>
    );
  }
  return (
    <div className="album-grid">
      {albums.map((album) => (
        <div key={album.id} className="album-card" onClick={() => onOpen(album)}>
          <Cover className="album-cover" trackId={album.id} seed={album.id}>
            <button
              className="album-cover-play"
              title="播放专辑"
              onClick={(e) => {
                e.stopPropagation();
                onPlay(album);
              }}
            >
              <Icon name="play" />
            </button>
          </Cover>
          <div className="album-name" title={albumLabel(album.name)}>
            {albumLabel(album.name)}
          </div>
          <div className="album-artist" title={album.artist}>
            {album.artist || "未知艺术家"}
            {album.trackCount > 1 ? " · " + album.trackCount + " 首" : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
