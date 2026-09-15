// 首页 —— 问候语 + 循环封面流（设计稿主界面）
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../api/ipc";
import type { Album } from "../api/types";
import { Coverflow } from "../components/Coverflow";
import { Icon } from "../components/Icon";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { DEFAULT_PLAY_MODE } from "../lib/playMode";
import { useSelectionStore } from "../stores/selectionStore";
import { toast } from "../stores/uiStore";
import { pickAndAddMusicFolder } from "../lib/addMusic";
import { greeting } from "../lib/format";


export function HomeView() {
  const version = useLibraryStore((s) => s.version);
  const stats = useLibraryStore((s) => s.stats);
  const setSelected = useSelectionStore((s) => s.setAlbum);
  const current = usePlayerStore((s) => s.state?.current ?? null);
  const playMode = usePlayerStore((s) => s.state?.playMode ?? DEFAULT_PLAY_MODE);
  // 随机模式的卡片顺序：进入随机时取一次种子，用稳定洗牌（同种子结果一致），
  // 这样既满足「随机模式卡片乱序」，又不会因为播放变化/点卡片而重排。
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const status = usePlayerStore((s) => s.state?.status ?? "stopped");
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [greet, setGreet] = useState(() => greeting());

  useEffect(() => {
    const timer = window.setInterval(() => setGreet(greeting()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api
      .albumsList(1, 1000)
      .then((page) => {
        if (!alive) return;
        setAlbums(page.items);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setLoading(false);
        toast("读取专辑失败：" + String(e), "error");
      });
    return () => {
      alive = false;
    };
  }, [version]);

  /**
   * 首页卡片列表：**按实际播放顺序**排列队列里的专辑。
   * 列表循环 → 顺序（与队列一致）；随机 → 内核洗牌序列的顺序。
   * 没有正在播放的队列时，退回库里的专辑列表。
   */
  const cards = useMemo(() => {
    // 顺序播放 / 列表循环 / 单曲循环：卡片就是库顺序（与队列顺序一致），
    // **不跟随实时队列**——否则点一张卡片就会让队列变成那张专辑，整圈卡片被重排、
    // 跟随逻辑再把中心拉回去，看起来就是「乱跳封面又切回来」。
    if (playMode !== "shuffle" || shuffleSeed === 0) return albums;
    // 随机：用种子做一次稳定洗牌（xorshift），同一种子结果不变 → 点卡片不会重排
    const arr = albums.slice();
    let s = shuffleSeed >>> 0 || 1;
    const rnd = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    for (let k = arr.length - 1; k > 0; k--) {
      const n = Math.floor(rnd() * (k + 1));
      const tmp = arr[k];
      arr[k] = arr[n];
      arr[n] = tmp;
    }
    return arr;
  }, [albums, playMode, shuffleSeed]);

  useEffect(() => {
    setShuffleSeed(playMode === "shuffle" ? (Date.now() >>> 0) || 1 : 0);
  }, [playMode]);

  /** 正在播放曲目所属的专辑（用于让封面流跟随播放） */
  const playingAlbumId = useMemo(() => {
    if (!current) return null;
    // 1) 曲目本身就是某张专辑的代表曲目（专辑 id = 组内最小曲目 id）时直接命中：
    //    专辑名为空的单曲组就靠这一条（它们的专辑名是曲目名，无法按名字匹配）
    const byId = cards.find((a) => a.id === current.trackId);
    if (byId) return byId.id;
    const norm = (v: string) => v.trim().toLowerCase();
    const hit =
      cards.find((a) => norm(a.name) === norm(current.album) && norm(a.artist) === norm(current.artist)) ??
      cards.find((a) => norm(a.name) === norm(current.album));
    return hit ? hit.id : null;
  }, [current, cards]);

  const handleSelect = useCallback(
    (album: Album) => {
      setSelected(album);
    },
    [setSelected]
  );

  const isEmpty = !loading && (stats?.trackCount ?? albums.length) === 0;

  return (
    <div className="view-root">
      <div className="greeting-section drag-region" data-tauri-drag-region>
        <h1 className="greeting-title">{greet.title}</h1>
        <p className="greeting-sub">{greet.sub}</p>
      </div>

      {loading ? (
        <div className="loading-row">
          <span className="spinner" />
          正在读取音乐库…
        </div>
      ) : isEmpty ? (
        <div className="empty-library">
          <div className="empty-library-icon">♫</div>
          <div className="empty-library-title">还没有音乐</div>
          <div className="empty-library-sub">导入你的音乐文件夹即可开始</div>
          <button className="empty-library-btn" onClick={() => void pickAndAddMusicFolder()}>
            + 添加音乐
          </button>
        </div>
      ) : (
        <Coverflow
          albums={cards}
          onSelect={handleSelect}
          onPlay={(album) => void usePlayerStore.getState().playAlbum(album.id, album.name)}
          activeAlbumId={playingAlbumId}
          playbackActive={!!current && status !== "stopped"}
        />
      )}

      {!loading && !isEmpty && (
        <div className="home-hint">
          <Icon name="chevron-left" size={13} />
          <span>点击中间封面播放 · 拖动/滚轮切换专辑（播放中会直接切歌）</span>
        </div>
      )}
    </div>
  );
}