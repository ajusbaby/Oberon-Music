// 曲库歌词体检（npm run check:lyrics）：把整个曲库的"这一行会走哪个字体槽"摊开，
// 提前抓出"一行里两种字体"那类问题，而不是等用户听歌时发现。
//
//   node scripts/check-lyrics.mjs                  读播放器数据库里的曲目
//   node scripts/check-lyrics.mjs --dir "D:\音乐"   扫指定目录（递归）
//   node scripts/check-lyrics.mjs --all            列出每一首（默认只列有问题的）
//   node scripts/check-lyrics.mjs --json           机器可读
//   node scripts/check-lyrics.mjs --policy accurate 按"准确优先"策略体检
//
// 歌词来源与播放器保持一致（src-tauri/src/lyrics.rs 的 load）：
//   同名 sidecar（ttml/TTML/xml/lrc/LRC/Lrc/txt/TXT，ttml 要求内容真是 TTML）→ 内嵌标签。
// 内嵌标签在 Node 里自己解析（FLAC VORBIS_COMMENT / ID3v2 / MP4 ilst / Ogg comment），
// 不用 Rust —— 这个脚本要能在没装 Rust 的机器上跑。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const root = process.cwd();
const outDir = ".build/check-lyrics";

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const policy = opt("policy") === "accurate" ? "accurate" : "consistent";
const showAll = flag("all");
const asJson = flag("json");
const dirArg = opt("dir");
const trace = opt("trace");
const allLines = flag("lines");

// ---------------------------------------------------------------- 歌词文本提取
const AUDIO_EXT = new Set([
  ".flac", ".mp3", ".m4a", ".mp4", ".aac", ".wav", ".ogg", ".opus",
  ".ape", ".wv", ".aiff", ".aif", ".dsf", ".dff", ".wma", ".tak",
]);
const LYRIC_KEYS = new Set(["LYRICS", "UNSYNCEDLYRICS", "LYRICSUNSYNCED", "SYNCEDLYRICS", "SYNCLYRICS"]);
/** 键名归一：去空格、大写。排除 LYRICIST（作词人）这类同前缀的字段 */
function isLyricKey(key) {
  const k = key.replace(/[\s_-]/g, "").toUpperCase();
  if (k.startsWith("LYRICIST")) return false;
  if (LYRIC_KEYS.has(k)) return true;
  // 常见变体：LYRICS_ZH / LYRICS-XXX（多语言歌词）
  return /^LYRICS[A-Z]{0,4}$/.test(k) || (k.startsWith("UNSYNCEDLYRICS") && k.length <= 20);
}

function parseVorbis(buf, off, len) {
  const end = Math.min(buf.length, off + len);
  let o = off;
  const out = [];
  if (o + 4 > end) return out;
  const vlen = buf.readUInt32LE(o);
  o += 4 + vlen;
  if (o + 4 > end) return out;
  const count = buf.readUInt32LE(o);
  o += 4;
  for (let i = 0; i < count && o + 4 <= end; i++) {
    const l = buf.readUInt32LE(o);
    o += 4;
    if (o + l > end) break;
    const s = buf.slice(o, o + l).toString("utf8");
    o += l;
    const eq = s.indexOf("=");
    if (eq > 0) out.push({ key: s.slice(0, eq), value: s.slice(eq + 1) });
  }
  return out;
}

function flacTags(buf) {
  let o = 4;
  for (let guard = 0; guard < 64 && o + 4 <= buf.length; guard++) {
    const flag = buf[o];
    const type = flag & 0x7f;
    const last = (flag & 0x80) !== 0;
    const len = (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
    o += 4;
    if (type === 4) return parseVorbis(buf, o, len);
    o += len;
    if (last) break;
  }
  return [];
}

function decode16(bytes, s, e, enc) {
  let be = enc === 2;
  const start = s;
  let from = start;
  if (enc === 1 && e - s >= 2) {
    if (bytes[s] === 0xff && bytes[s + 1] === 0xfe) from = s + 2;
    else if (bytes[s] === 0xfe && bytes[s + 1] === 0xff) {
      be = true;
      from = s + 2;
    }
  }
  let slice = Buffer.from(bytes.subarray(from, e));
  if (slice.length % 2) slice = slice.subarray(0, slice.length - 1);
  if (be) slice.swap16();
  return slice.toString("utf16le").replace(/\u0000+$/, "");
}

function decodeBody(body, enc) {
  if (enc === 1 || enc === 2) return decode16(body, 0, body.length, enc);
  if (enc === 3) return body.toString("utf8");
  return body.toString("latin1");
}

/** 拆 "<描述>\0<正文>"，返回 [描述, 正文] */
function splitDesc(body, p, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = p; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) {
        return [decode16(body, p, i, enc), decode16(body, i + 2, body.length, enc)];
      }
    }
    return ["", decode16(body, p, body.length, enc)];
  }
  let i = p;
  while (i < body.length && body[i] !== 0) i++;
  return [body.subarray(p, i).toString(enc === 3 ? "utf8" : "latin1"), decodeBody(body.subarray(i + 1), enc)];
}

function id3Tags(buf, base = 0) {
  const out = [];
  if (buf.length < base + 10) return out;
  if (buf.toString("latin1", base, base + 3) !== "ID3") return out;
  const ver = buf[base + 3];
  const flags = buf[base + 5];
  const size =
    ((buf[base + 6] & 0x7f) << 21) |
    ((buf[base + 7] & 0x7f) << 14) |
    ((buf[base + 8] & 0x7f) << 7) |
    (buf[base + 9] & 0x7f);
  let o = base + 10;
  if (flags & 0x40) {
    const esz =
      ver >= 4
        ? ((buf[o] & 0x7f) << 21) | ((buf[o + 1] & 0x7f) << 14) | ((buf[o + 2] & 0x7f) << 7) | (buf[o + 3] & 0x7f)
        : buf.readUInt32BE(o);
    o += ver >= 4 ? esz : esz + 4;
  }
  const end = Math.min(buf.length, base + 10 + size);
  for (let guard = 0; guard < 4096 && o < end; guard++) {
    let id;
    let fsz;
    let hdr;
    if (ver === 2) {
      id = buf.toString("latin1", o, o + 3);
      fsz = (buf[o + 3] << 16) | (buf[o + 4] << 8) | buf[o + 5];
      hdr = 6;
    } else {
      id = buf.toString("latin1", o, o + 4);
      fsz =
        ver >= 4
          ? ((buf[o + 4] & 0x7f) << 21) | ((buf[o + 5] & 0x7f) << 14) | ((buf[o + 6] & 0x7f) << 7) | (buf[o + 7] & 0x7f)
          : buf.readUInt32BE(o + 4);
      hdr = 10;
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || fsz <= 0) break;
    if (o + hdr + fsz > end) break;
    const body = buf.subarray(o + hdr, o + hdr + fsz);
    o += hdr + fsz;
    if (id === "TXXX" || id === "TXX") {
      const [desc, value] = splitDesc(body, 1, body[0]);
      if (isLyricKey(desc) && value.trim()) out.push({ key: desc, value });
    } else if (id === "USLT" || id === "ULT") {
      const [, value] = splitDesc(body, 4, body[0]);
      if (value.trim()) out.push({ key: "LYRICS", value });
    }
  }
  return out;
}

function mp4Tags(buf) {
  const out = [];
  const seen = new Set();
  const CTRL = Buffer.from([0xa9, 0x6c, 0x79, 0x72]).toString("latin1"); // "©lyr"
  const walk = (start, end, depth) => {
    if (depth > 8) return;
    let o = start;
    while (o + 8 <= end) {
      let size = buf.readUInt32BE(o);
      if (size === 1) {
        if (o + 16 > end) return;
        size = Number(buf.readBigUInt64BE(o + 8));
        if (!Number.isFinite(size) || size < 16) return;
      } else if (size === 0) size = end - o;
      if (size < 8) return;
      const type = buf.toString("latin1", o + 4, o + 8);
      const stop = Math.min(end, o + size);
      const hdr = buf.readUInt32BE(o) === 1 ? 16 : 8;
      if (type === "moov" || type === "udta" || type === "ilst" || type === "trak" || type === "mdia") {
        walk(o + hdr, stop, depth + 1);
      } else if (type === "meta") {
        walk(o + hdr + 4, stop, depth + 1);
      } else if (type === CTRL) {
        walk(o + hdr, stop, depth + 1);
      } else if (type === "data" && !seen.has(o)) {
        seen.add(o);
        const p = o + hdr + 8;
        if (p < stop) out.push({ key: "LYRICS", value: buf.toString("utf8", p, stop) });
      }
      o = stop;
    }
  };
  walk(0, buf.length, 0);
  return out;
}

function oggTags(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 262144));
  const s = head.toString("latin1");
  const i = s.indexOf("OpusTags");
  if (i >= 0) return parseVorbis(head, i + 8, head.length - i - 8);
  const v = s.indexOf("\u0003vorbis");
  if (v >= 0) return parseVorbis(head, v + 7, head.length - v - 7);
  return [];
}

function embeddedTags(buf) {
  const magic4 = buf.toString("latin1", 0, 4);
  if (magic4 === "fLaC") return flacTags(buf);
  if (buf.toString("latin1", 0, 3) === "ID3") return id3Tags(buf);
  if (buf.toString("latin1", 4, 8) === "ftyp") return mp4Tags(buf);
  if (magic4 === "OggS") return oggTags(buf);
  if (magic4 === "RIFF" || magic4 === "FORM") {
    const i = buf.toString("latin1").indexOf("ID3");
    if (i > 0) return id3Tags(buf, i);
  }
  // DSD 的 ID3 在文件尾
  if (magic4 === "DSD " || magic4 === "FRM8") {
    const i = buf.toString("latin1").lastIndexOf("ID3");
    if (i > 0) return id3Tags(buf, i);
  }
  return [];
}

function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  const utf8 = bytes.toString("utf8");
  // 与 Rust 侧一致：UTF-8 优先，失败退化为有损解码
  return utf8;
}

const SIDECAR = [
  ["ttml", true], ["TTML", true], ["xml", true],
  ["lrc", false], ["LRC", false], ["Lrc", false],
  ["txt", false], ["TXT", false],
];

function isTtmlText(text) {
  const t = text.trimStart();
  if (t.startsWith("<?xml")) return t.includes("<tt") || t.includes(":tt");
  return t.startsWith("<tt") || t.includes("<tt ") || t.includes(":tt ");
}

/** 与 lyrics.rs 的 load 同序：sidecar → 内嵌 */
function readLyrics(file) {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  for (const [ext, wantsTtml] of SIDECAR) {
    const p = path.join(dir, stem + "." + ext);
    let bytes;
    try {
      bytes = fs.readFileSync(p);
    } catch {
      continue;
    }
    const text = decodeText(bytes);
    if (!text.trim()) continue;
    if (wantsTtml && !isTtmlText(text)) continue;
    return { text, source: path.basename(p) };
  }
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  for (const t of embeddedTags(buf)) {
    if (!isLyricKey(t.key)) continue;
    const v = t.value.trim();
    if (v) return { text: v, source: "内嵌标签 " + t.key };
  }
  return null;
}

// ---------------------------------------------------------------- 文本 → 行 + 组
function parseClock(s) {
  // "12.5s" / "00:00:12.500" / "1:02.50"
  const t = s.trim();
  let m = /^(\d+(?:\.\d+)?)s$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 1000);
  m = /^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(t);
  if (m) {
    const h = Number(m[1] ?? 0);
    const mi = Number(m[2]);
    const sec = Number(String(m[3]).replace(",", "."));
    return Math.round((h * 3600 + mi * 60 + sec) * 1000);
  }
  m = /^(\d+):(\d+(?:[.,]\d+)?)$/.exec(t);
  if (m) return Math.round((Number(m[1]) * 60 + Number(m[2].replace(",", "."))) * 1000);
  return null;
}

function parseLrc(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    let s = raw.trim();
    if (!s) continue;
    const head = /^(?:\[[^\]]*\])+/.exec(s);
    const times = [];
    if (head) {
      for (const mm of head[0].matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)) {
        const frac = mm[3] ? Number((mm[3] + "00").slice(0, 3)) : 0;
        times.push(Number(mm[1]) * 60000 + Number(mm[2]) * 1000 + frac);
      }
      s = s.slice(head[0].length).trim();
    }
    if (!s) continue;
    if (!times.length) rows.push({ t: null, text: s });
    else for (const t of times) rows.push({ t, text: s });
  }
  return rows;
}

function parseTtml(text) {
  const rows = [];
  for (const m of text.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const bm = /\bbegin\s*=\s*"([^"]+)"/i.exec(m[1]);
    const body = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (body) rows.push({ t: bm ? parseClock(bm[1]) : null, text: body });
  }
  return rows;
}

function toLines(text) {
  const rows = isTtmlText(text) ? parseTtml(text) : parseLrc(text);
  const texts = rows.map((r) => r.text);
  const groups = [];
  const byTime = new Map();
  rows.forEach((r, i) => {
    if (r.t == null) {
      groups.push([i]);
      return;
    }
    const key = Math.round(r.t / 10); // 10ms 容差，等价于播放器的"同一时间戳"
    let g = byTime.get(key);
    if (!g) {
      g = [];
      byTime.set(key, g);
      groups.push(g);
    }
    g.push(i);
  });
  return { texts, groups };
}

// ---------------------------------------------------------------- 曲目来源
function tracksFromDb() {
  const db3 = path.join(os.homedir(), "AppData", "Roaming", "com.localmusicplayer.desktop", "library.db3");
  if (!fs.existsSync(db3)) return null;
  // 库是 WAL 模式（主库可能只有 4KB，数据都在 -wal）：复制一份再读，不动原库
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oberon-check-lyrics-"));
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(db3 + suffix)) fs.copyFileSync(db3 + suffix, path.join(tmp, "library.db3" + suffix));
  }
  try {
    const { DatabaseSync } = require_db();
    const db = new DatabaseSync(path.join(tmp, "library.db3"));
    const rows = db.prepare("SELECT path, artist, title FROM tracks").all();
    db.close();
    return rows.map((r) => ({
      file: String(r.path).replace(/^\\\\\?\\/, ""),
      label: [r.artist, r.title].filter(Boolean).join(" - ") || path.basename(String(r.path)),
    }));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

function require_db() {
  // node:sqlite 在 Node 22.5+ 有；低版本直接放弃读库，走 --dir
  // eslint-disable-next-line no-undef
  const mod = process.getBuiltinModule ? process.getBuiltinModule("node:sqlite") : null;
  if (!mod || !mod.DatabaseSync) throw new Error("node:sqlite 不可用（需要 Node 22.5+）");
  return mod;
}

function walkDir(dir, out, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, out, depth + 1);
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push({ file: p, label: e.name });
  }
}

// ---------------------------------------------------------------- 报告
const COLOR = process.stdout.isTTY
  ? { red: "\u001b[31m", yellow: "\u001b[33m", dim: "\u001b[2m", bold: "\u001b[1m", reset: "\u001b[0m" }
  : { red: "", yellow: "", dim: "", bold: "", reset: "" };
const C = (k, s) => COLOR[k] + s + COLOR.reset;
const LV = { error: C("red", "错误"), warn: C("yellow", "警告"), info: C("dim", "提示") };

function report(results) {
  const withLyrics = results.filter((r) => r.report);
  const noLyrics = results.filter((r) => !r.report);
  const dist = { zh: 0, ja: 0, ko: 0, latin: 0, none: 0 };
  for (const r of withLyrics) dist[r.report.songSlot ?? "none"]++;
  const byLevel = { error: [], warn: [], info: [] };
  for (const r of withLyrics) for (const i of r.report.issues) byLevel[i.level].push({ r, i });

  console.log("");
  console.log(C("bold", "曲库歌词体检") + C("dim", "  policy=" + policy + "（" + (policy === "accurate" ? "准确优先" : "一致性优先") + "）"));
  console.log(C("dim", "─".repeat(64)));
  console.log(
    " 曲目 " + results.length + " 首 · 读到歌词 " + withLyrics.length + " 首 · 没有歌词 " + noLyrics.length + " 首"
  );
  console.log(
    " 主语言：中文 " + dist.zh + " · 日文 " + dist.ja + " · 韩文 " + dist.ko + " · 西文 " + dist.latin + " · 无 " + dist.none
  );

  const emit = (level, limit) => {
    const list = byLevel[level];
    if (!list.length) return;
    console.log("");
    console.log(C(level === "error" ? "red" : level === "warn" ? "yellow" : "dim", "【" + LV[level] + " " + list.length + "】"));
    for (const { r, i } of list.slice(0, limit)) {
      console.log("  " + r.label);
      console.log("    " + C("dim", r.file));
      console.log("    [" + i.code + "] " + i.detail);
    }
    if (list.length > limit) console.log(C("dim", "  …还有 " + (list.length - limit) + " 条"));
  };
  emit("error", 50);
  emit("warn", 30);
  if (showAll) emit("info", 200);

  const clean = withLyrics.filter((r) => !r.report.issues.some((i) => i.level === "error" || i.level === "warn"));
  const bilingual = withLyrics.filter((r) => r.report.issues.some((i) => i.code === "bilingual-alternating")).length;
  console.log("");
  console.log(" 干净 " + clean.length + " 首 · 有错误 " + new Set(byLevel.error.map((x) => x.r.file)).size + " 首 · 有警告 " + new Set(byLevel.warn.map((x) => x.r.file)).size + " 首");
  if (bilingual) {
    console.log(C("dim", " 另有 " + bilingual + " 首原词+翻译的双语歌词（两种文字本来就该用两种字体，未计入问题）"));
  }

  if (showAll) {
    console.log("");
    console.log(C("dim", "── 全部曲目 ──"));
    for (const r of withLyrics) {
      const rep = r.report;
      const bar = ["zh", "ja", "ko", "latin"].map((s) => s + ":" + rep.slots[s]).join(" ");
      console.log("  " + (rep.songSlot ?? "-").padEnd(5) + " " + bar.padEnd(34) + " " + r.label);
    }
  }

  if (byLevel.error.length) {
    console.log("");
    console.log(C("red", " 有错误级问题：这些歌的歌词会出现\"一行里字体大小粗细不一致\"，或者文字已经损坏。"));
  }
  console.log("");
}

// ---------------------------------------------------------------- 主流程
await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: "scripts/check-lyrics.check.ts",
      output: { entryFileNames: "check.mjs", format: "esm" },
    },
  },
});
const mod = await import(pathToFileURL(path.join(root, outDir, "check.mjs")).href);

if (flag("self")) {
  process.exit(mod.run() ? 1 : 0);
}

let tracks = null;
if (dirArg) {
  tracks = [];
  walkDir(dirArg, tracks);
} else {
  try {
    tracks = tracksFromDb();
  } catch (e) {
    console.log(C("yellow", "读播放器数据库失败：" + e.message));
    console.log("改用 --dir \"<音乐目录>\" 指定目录。");
    process.exit(2);
  }
}
if (!tracks || !tracks.length) {
  console.log(C("yellow", "没有找到曲目。用 --dir \"<音乐目录>\" 指定目录。"));
  process.exit(2);
}

const results = [];
for (const t of tracks) {
  const ly = readLyrics(t.file);
  if (!ly) {
    results.push({ ...t, report: null });
    continue;
  }
  const { texts, groups } = toLines(ly.text);
  const rep = mod.analyzeLyrics(texts, groups, policy);
  results.push({ ...t, source: ly.source, report: rep, lines: texts.length });
  if (trace && (t.label + " " + t.file).toLowerCase().includes(trace.toLowerCase())) {
    console.log("");
    console.log(C("bold", "=== " + t.label));
    console.log(C("dim", "    " + t.file + "  来源 " + ly.source));
    for (let i = 0; i < texts.length; i++) console.log("  " + rep.lineSlots[i].padEnd(6) + texts[i]);
  }
}

const scope = trace
  ? results.filter((r) => (r.label + " " + r.file).toLowerCase().includes(trace.toLowerCase()))
  : results;
if (asJson) {
  console.log(JSON.stringify({ policy, results: scope }, null, 2));
} else {
  report(scope);
}
const failed = results.some((r) => r.report && r.report.issues.some((i) => i.level === "error"));
process.exit(failed ? 1 : 0);
