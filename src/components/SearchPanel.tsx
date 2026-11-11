// 搜索：独立模块（浮层）。
// 顶栏只负责"打开"，输入、防抖查询、分区结果、键盘导航全在这里。
// 关掉浮层 = 什么都没发生：不复用路由，所以专辑页 / 音乐库 / 歌词页都不会被顶掉。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as api from "../api/ipc";
import type { SearchResult } from "../api/types";
import { ArtistAvatar } from "./ArtistAvatar";
import { Cover } from "./Cover";
import { Icon } from "./Icon";
import { useSearchStore } from "../stores/searchStore";
import { useUiStore, toast } from "../stores/uiStore";
import { usePlayerStore } from "../stores/playerStore";
import { useLibraryStore } from "../stores/libraryStore";
import { nav } from "../stores/navStore";

const EMPTY: SearchResult = { tracks: [], albums: [], artists: [], playlists: [] };

/** 每个分区最多展示几条：浮层是"快速跳转"，不是第二个结果页，翻长列表请去对应的详情页 */
const MAX_TRACKS = 24;
const MAX_ALBUMS = 12;
const MAX_ARTISTS = 8;
const MAX_PLAYLISTS = 8;

type HitKind = "track" | "album" | "artist" | "playlist";

const KIND_LABEL: Record<HitKind, string> = {
  track: "歌曲",
  album: "专辑",
  artist: "艺术家",
  playlist: "播放列表",
};

interface Hit {
  key: string;
  kind: HitKind;
  title: string;
  sub: string;
  /** 有封面就传曲目 id，没有就用字符头像 */
  coverId: number | null;
  glyph: string;
  /** 艺术家结果用统一占位头像（不再现取名字首字母） */
  photo?: boolean;
  run: () => void;
}

export function SearchPanel() {
  const open = useUiStore((s) => s.searchOpen);
  const closeSearch = useUiStore((s) => s.closeSearch);
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const version = useLibraryStore((s) => s.version);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const [result, setResult] = useState<SearchResult>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState("");
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 打开即聚焦：用户点搜索框的下一秒就该能打字
  useEffect(() => {
    if (!open) return;
    setActive(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 查询（防抖 250ms）。alive 必须挂在 effect 作用域上：写在 setTimeout 里的话
  // 清理函数会被回调丢弃，打字快时旧结果会盖掉新结果。
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length === 0) {
      setResult(EMPTY);
      setSearched("");
      setLoading(false);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api
        .search(q)
        .then((r) => {
          if (!alive) return;
          setResult(r);
          setSearched(q);
          setLoading(false);
          setActive(0);
        })
        .catch((e) => {
          if (!alive) return;
          setLoading(false);
          toast("搜索失败：" + String(e), "error");
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, version, open]);

  const close = () => closeSearch();

  const hits = useMemo<Hit[]>(() => {
    const list: Hit[] = [];
    const queueIds = result.tracks.map((t) => t.id);
    for (const t of result.tracks.slice(0, MAX_TRACKS)) {
      list.push({
        key: "t" + t.id,
        kind: "track",
        title: t.title || "未知曲目",
        sub: [t.artist || "未知艺术家", t.album].filter(Boolean).join(" · "),
        coverId: t.id,
        glyph: "♪",
        run: () => {
          close();
          void playTrack(t.id, queueIds);
        },
      });
    }
    for (const a of result.albums.slice(0, MAX_ALBUMS)) {
      list.push({
        key: "a" + a.id,
        kind: "album",
        title: a.name || "未知专辑",
        sub: [a.artist || "未知艺术家", a.trackCount + " 首"].join(" · "),
        coverId: a.id,
        glyph: "◎",
        run: () => {
          close();
          nav.album(a.id);
        },
      });
    }
    for (const ar of result.artists.slice(0, MAX_ARTISTS)) {
      list.push({
        key: "r" + ar.name,
        kind: "artist",
        title: ar.name || "未知艺术家",
        sub: ar.trackCount + " 首 · " + ar.albumCount + " 张专辑",
        coverId: null,
        glyph: "",
        photo: true,
        run: () => {
          close();
          nav.artist(ar.name);
        },
      });
    }
    for (const p of result.playlists.slice(0, MAX_PLAYLISTS)) {
      list.push({
        key: "p" + p.id,
        kind: "playlist",
        title: p.name,
        sub: p.trackCount + " 首",
        coverId: null,
        glyph: "≡",
        run: () => {
          close();
          nav.playlist(p.id);
        },
      });
    }
    return list;
  }, [result, playTrack]);

  // 键盘选中项滚进视野（浮层有固定高度，第 8 条之后会被裁掉）
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById("searchHit" + active);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  const nothing =
    searched.length > 0 &&
    result.tracks.length === 0 &&
    result.albums.length === 0 &&
    result.artists.length === 0 &&
    result.playlists.length === 0;

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hits.length > 0) setActive((i) => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length > 0) setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      const hit = hits[active];
      if (hit) {
        e.preventDefault();
        hit.run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      // 焦点留在浮层里：aria-modal 说"这是模态"，就别让 Tab 把焦点送到背后的页面上
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])");
      if (!nodes || nodes.length === 0) return;
      const list = Array.from(nodes);
      const i = list.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i === list.length - 1 ? 0 : i + 1;
      list[next]?.focus();
    }
  };

  // 分组渲染：顺序固定，空分区不占位
  const groups = (["track", "album", "artist", "playlist"] as HitKind[])
    .map((kind) => ({ kind, items: hits.map((h, i) => ({ hit: h, index: i })).filter((x) => x.hit.kind === kind) }))
    .filter((g) => g.items.length > 0);

  return (
    <div
      className="search-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="搜索"
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="search-panel-field">
          <Icon name="search" size={18} />
          <input
            id="searchInput"
            ref={inputRef}
            className="search-panel-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="搜索歌曲、艺术家、专辑或播放列表…"
            value={query}
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="searchResultList"
            aria-autocomplete="list"
            aria-activedescendant={hits.length > 0 ? "searchHit" + active : undefined}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <span className="spinner" />}
          {/* 只留这一枚 ✕ ＝ 清空输入。退出浮层点面板外面即可（遮罩的 onMouseDown 已经接管）。 */}
          {query.length > 0 && (
            <button
              type="button"
              className="icon-only-btn"
              aria-label="清空"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>

        <div className="search-panel-body" id="searchResultList" role="listbox" aria-label="搜索结果">
          {searched.length === 0 ? (
            <div className="search-panel-empty">
              <div className="empty-state-icon">⌕</div>
              <div className="empty-state-title">{query.trim() ? "正在搜索…" : "输入关键词开始搜索"}</div>
              <div className="empty-state-sub">支持歌曲标题、艺术家、专辑名与播放列表名</div>
            </div>
          ) : nothing ? (
            <div className="search-panel-empty">
              <div className="empty-state-icon">∅</div>
              <div className="empty-state-title">没有找到「{searched}」</div>
              <div className="empty-state-sub">换个关键词，或检查曲库是否已导入</div>
            </div>
          ) : (
            groups.map((group) => (
              <div className="search-hit-group" key={group.kind}>
                <div className="search-hit-group-title">
                  {KIND_LABEL[group.kind]} · {group.items.length}
                </div>
                {group.items.map(({ hit, index }) => (
                  <div
                    key={hit.key}
                    id={"searchHit" + index}
                    role="option"
                    aria-selected={index === active}
                    className={"search-hit" + (index === active ? " is-active" : "")}
                    onMouseEnter={() => setActive(index)}
                    onClick={hit.run}
                  >
                    {hit.coverId != null ? (
                      <Cover className="search-hit-cover" trackId={hit.coverId} seed={hit.coverId} glyph={hit.glyph} />
                    ) : hit.photo ? (
                      <ArtistAvatar size="sm" />
                    ) : (
                      <div className="search-hit-glyph" aria-hidden="true">
                        {hit.glyph}
                      </div>
                    )}
                    <div className="search-hit-info">
                      <div className="search-hit-title">{hit.title}</div>
                      <div className="search-hit-sub">{hit.sub}</div>
                    </div>
                    <span className="search-hit-kind">{KIND_LABEL[hit.kind]}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

      </div>
    </div>
  );
}
