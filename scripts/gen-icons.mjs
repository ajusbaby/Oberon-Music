// 生成 src-tauri/icons 下的全套应用图标（纯 Node，无第三方依赖）
//
// 源：logo/ 目录下的一批「每个尺寸一个文件」的 ico（logo_16x16.ico … logo_256x256.ico）。
//     逐尺寸取原生图合成，不走「一张大图往下缩」—— 理由见下。
//
// ★ 关键约定：**逐尺寸取原生图，绝不拿一张大图往下缩**。
//   设计稿在每个尺寸上单独调过：圆角在 48px 以上固定 18px，32/24/16 因尺寸放不下而
//   按比例收敛（分别约 16 / 12 / 7.5px）。如果改成把 256 缩到 32，圆角会变成 18×32/256
//   ≈ 2.25px —— 形状完全走样，笔画也会糊。Windows 的任务栏/资源管理器本来就是按当前
//   DPI 从 ico 里挑最接近的那一帧显示，所以「一帧一尺寸都对」才是清晰的前提。
//   只有 logo/ 里缺某个尺寸时，才退化成从最近的更大原生尺寸缩放补一张。
//
// 产出：icon.png / 128x128@2x.png / 128x128.png / 32x32.png / icon.ico（多尺寸）
// 注：应用内的左上角已按需求改成纯文字标，所以这里不再产出给前端用的 brand 图。
//
// ★ icon.ico 的帧顺序有讲究（第一帧 = 任务栏图标），见文件末尾「多尺寸 ICO」一节。
//
// 之所以自己做 PNG 解码而不是引第三方库：这个脚本原本就是纯 Node 手写 PNG/ICO 编码的，
// 依赖只为一处新增的解码不值得；源图固定是 8bit 非隔行，解码路径很短。
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

// ============ 1. PNG 编码（与旧版一致） ============
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8bit RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ============ 2. PNG 解码（8bit 非隔行，支持灰度/RGB/调色板/RGBA） ============
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let off = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("ascii");
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error("缺少 IHDR");
  if (ihdr.depth !== 8) throw new Error("只支持 8bit 源图，实际 " + ihdr.depth + "bit");
  if (ihdr.interlace !== 0) throw new Error("不支持隔行 PNG");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error("不支持的颜色类型 " + ihdr.color);

  const raw = inflateSync(Buffer.concat(idat));
  const { w, h } = ihdr;
  const bpp = channels;
  const stride = w * bpp;
  const px = Buffer.alloc(stride * h);

  // 逐行反滤波
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y > 0 ? px[up + i] : 0;
      const c = y > 0 && i >= bpp ? px[up + i - bpp] : 0;
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) v = x + paeth(a, b, c);
      else throw new Error("未知滤波类型 " + ft);
      px[dst + i] = v & 0xff;
    }
  }

  // 统一转成 RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * bpp;
    const o = i * 4;
    if (ihdr.color === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[s];
      rgba[o + 3] = 255;
    } else if (ihdr.color === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[s];
      rgba[o + 3] = px[s + 1];
    } else if (ihdr.color === 2) {
      rgba[o] = px[s];
      rgba[o + 1] = px[s + 1];
      rgba[o + 2] = px[s + 2];
      rgba[o + 3] = 255;
    } else if (ihdr.color === 6) {
      px.copy(rgba, o, s, s + 4);
    } else {
      const p = px[s] * 3;
      rgba[o] = palette[p];
      rgba[o + 1] = palette[p + 1];
      rgba[o + 2] = palette[p + 2];
      rgba[o + 3] = trns && px[s] < trns.length ? trns[px[s]] : 255;
    }
  }
  return { w, h, rgba };
}

// ============ 3. 缩放：按覆盖面积加权平均（缩小时即盒式低通，边缘自动抗锯齿） ============
function resize(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Buffer.from(src);
  const out = Buffer.alloc(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = (dy * sh) / dh;
    const sy1 = ((dy + 1) * sh) / dh;
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = (dx * sw) / dw;
      const sx1 = ((dx + 1) * sw) / dw;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        if (wy <= 0) continue;
        for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (y * sw + x) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al * w;
          g += src[i + 1] * al * w;
          b += src[i + 2] * al * w;
          a += src[i + 3] * w;
          wsum += w;
        }
      }
      const o = (dy * dw + dx) * 4;
      const aw = a / 255;
      // 预乘后再还原，半透明边缘才不会被当成黑色一起平均（否则 16px 的四角会发灰）
      if (aw > 0) {
        out[o] = Math.round(r / aw);
        out[o + 1] = Math.round(g / aw);
        out[o + 2] = Math.round(b / aw);
      }
      out[o + 3] = Math.round(a / wsum);
    }
  }
  return out;
}

// ============ 4. 取源图：logo/ 下每个尺寸一个 ico，逐尺寸读原生像素 ============
function readIcoLargestPng(file) {
  const b = readFileSync(file);
  if (b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) throw new Error("不是 ICO 文件: " + file);
  const count = b.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const size = b.readUInt32LE(o + 8);
    const off = b.readUInt32LE(o + 12);
    const isPng = b.slice(off, off + 8).toString("hex") === "89504e470d0a1a0a";
    const area = (b[o] || 256) * (b[o + 1] || 256);
    if (isPng && (!best || area > best.area)) best = { area, png: b.slice(off, off + size) };
  }
  if (!best) throw new Error("ICO 里没有 PNG 帧（只有 BMP 帧时需要先转存为 PNG）: " + file);
  return best.png;
}

// ============ 4.5 两处必要的修正 ============
//
// ① 水印：右下角有一行很淡的灰色 AI 生成标记，会被烘进任务栏/桌面图标。设计稿那里
//    是纯白底（已逐像素确认旋涡没有伸进该区域），所以直接填底色即可。
//    只改 RGB、不动 alpha —— 这样 48px 以上的圆角边缘一个像素都不会变。
// ② 小尺寸圆角：导出工具把 16/24/32 的圆角夹成了「尺寸÷2」，也就是圆形。按需求
//    改成与 48px 以上一致的观感（圆角方形），半径取 边长×0.22，避免任务栏里是圆、
//    桌面大图标是圆角方形。做法是先补回方形的底（圆形被切掉的那四角原本就是纯白底），
//    再按新圆角重新裁剪。

const WATERMARK = { x0: 0.76, y0: 0.9 }; // 右下角，占边长的比例
const SMALL_BELOW = 48; // 小于这个尺寸的源图圆角不可信，需要重做
const SMALL_RATIO = 0.22; // 小尺寸圆角 = 边长 × 该比例

/** 底色：取不透明像素里出现最多的颜色（就是白色底），比按区域采样稳得多 */
function bodyColor(rgba, size) {
  const hist = new Map();
  for (let i = 0; i < size * size; i++) {
    if (rgba[i * 4 + 3] < 250) continue;
    const k = (rgba[i * 4] >> 2) << 12 | (rgba[i * 4 + 1] >> 2) << 6 | (rgba[i * 4 + 2] >> 2);
    const e = hist.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += rgba[i * 4];
    e.g += rgba[i * 4 + 1];
    e.b += rgba[i * 4 + 2];
    hist.set(k, e);
  }
  let best = null;
  for (const e of hist.values()) if (!best || e.n > best.n) best = e;
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

function eraseWatermark(rgba, size, body) {
  const x0 = Math.floor(size * WATERMARK.x0);
  const y0 = Math.floor(size * WATERMARK.y0);
  for (let y = y0; y < size; y++) {
    for (let x = x0; x < size; x++) {
      const i = (y * size + x) * 4;
      rgba[i] = body[0];
      rgba[i + 1] = body[1];
      rgba[i + 2] = body[2];
      // alpha 保持原样：圆角外的透明像素依然透明，圆角 AA 边也不受影响
    }
  }
}

const inRoundRect = (px, py, size, r) => {
  const dx = px - Math.min(Math.max(px, r), size - r);
  const dy = py - Math.min(Math.max(py, r), size - r);
  return dx * dx + dy * dy <= r * r;
};

/** 补回方形底 + 按新圆角裁剪（4×4 超采样抗锯齿） */
function reRound(src, size, body, r) {
  const out = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 原位有内容就用原位颜色（旋涡、以及圆形边缘的 AA 像素），被圆切掉的地方补底色
      const has = src[i + 3] > 0;
      out[i] = has ? src[i] : body[0];
      out[i + 1] = has ? src[i + 1] : body[1];
      out[i + 2] = has ? src[i + 2] : body[2];
      let hit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (inRoundRect(x + (sx + 0.5) / S, y + (sy + 0.5) / S, size, r)) hit++;
        }
      }
      out[i + 3] = Math.round((hit / (S * S)) * 255);
    }
  }
  return out;
}

// ============ 5. 生成 ============
const SRC_DIR = join(root, "logo");
let files;
try {
  files = readdirSync(SRC_DIR).filter((f) => /^logo_(\d+)x\1\.ico$/i.test(f));
} catch {
  throw new Error("找不到源目录 " + SRC_DIR + "（应包含 logo_16x16.ico … logo_256x256.ico 等）");
}
if (files.length === 0) throw new Error(SRC_DIR + " 里没有 logo_<N>x<N>.ico 形式的文件");

/** 原生尺寸 → RGBA。key 是边长（源图都是正方形）。 */
const native = new Map();
for (const f of files) {
  const img = decodePNG(readIcoLargestPng(join(SRC_DIR, f)));
  if (img.w !== img.h) throw new Error(f + " 不是正方形（" + img.w + "×" + img.h + "）");
  native.set(img.w, img.rgba);
}
const nativeSizes = [...native.keys()].sort((a, b) => a - b);
const largest = nativeSizes[nativeSizes.length - 1];
console.log("原生尺寸: " + nativeSizes.map((s) => s + "px").join(", "));

/** 逐尺寸取图：有原生就用原生，缺了才从最近的更大原生尺寸缩放补；再做水印/圆角两处修正 */
const usedFallback = [];
const fixed = [];
function artwork(size) {
  let src;
  if (native.has(size)) src = Buffer.from(native.get(size));
  else {
    const donor = nativeSizes.find((s) => s > size) ?? largest;
    usedFallback.push(size + "←" + donor);
    src = resize(native.get(donor), donor, donor, size, size);
  }
  const body = bodyColor(src, size);
  eraseWatermark(src, size, body);
  if (size < SMALL_BELOW) {
    const r = size * SMALL_RATIO;
    if (!fixed.includes(size)) fixed.push(size);
    src = reRound(src, size, body, r);
  }
  return src;
}
const render = (size) => encodePNG(size, artwork(size));

// Tauri 需要的四个 PNG，全部取原生尺寸
writeFileSync(join(outDir, "icon.png"), render(largest));
writeFileSync(join(outDir, "128x128@2x.png"), render(256));
writeFileSync(join(outDir, "128x128.png"), render(128));
writeFileSync(join(outDir, "32x32.png"), render(32));

// ============ 6. 多尺寸 ICO ============
//
// ★★ 第一帧 = 任务栏图标，顺序不能随便改 ★★
//
// 链路（Tauri 2 / tauri-codegen 2.6.3，src/image.rs 的 CachedIcon::new_ico）：
//     icon.ico 的 entries()[0] → 解成一张 RGBA → tauri::image::Image
//     → tao CreateIcon(size of that frame) → WM_SETICON(hwnd, ICON_SMALL)
//   也就是说 ICO 里「排第一的那一帧」会被当成窗口图标，一帧定生死。
//
// 而 Win11 任务栏画的正是 ICON_SMALL（本机 24H2 实测：只把 ICON_BIG 换成 256px，
// 任务栏一点没变；只把 ICON_SMALL 换掉，任务栏立刻变清晰）。
// 所以以前第一帧是 16px 时，任务栏就是把 16px 硬拉到 ~26px 显示 —— 满屏马赛克。
//
// 实测（125% DPI，任务栏按钮 55×60、图标实际约 26 物理像素）：
//   首帧 32 / 40 / 48 / 64 → 笔画干净；128 开始发糊；256 最糊
//   （shell 把大图缩到 26px 用的是很糙的滤波，越大反而越糊）
// 这里取 64：实测里已经足够锐利，同时给 150%~200% DPI（任务栏 32~48px）留了余量。
//
// 其余帧从大到小排。资源管理器 / exe 里的图标资源是按「请求尺寸」选帧的
// （LoadImage / PrivateExtractIcons 实测 16~256 都能取到对应原生帧），与本顺序无关。
const WINDOW_FRAME = 64;
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frameBySize = new Map(sizes.map((s) => [s, render(s)]));
const order = [WINDOW_FRAME, ...sizes.filter((s) => s !== WINDOW_FRAME).sort((a, b) => b - a)];

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(order.length, 4);
let offset = 6 + 16 * order.length;
const dirs = [];
const frames = [];
for (const s of order) {
  const png = frameBySize.get(s);
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s;
  e[1] = s >= 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  dirs.push(e);
  frames.push(png);
}
writeFileSync(join(outDir, "icon.ico"), Buffer.concat([header, ...dirs, ...frames]));

console.log("icons generated:", order.join(",") + `（首帧 ${WINDOW_FRAME}px → 任务栏窗口图标）`);
console.log(
  usedFallback.length === 0
    ? "全部 7 帧都用了原生图（无缩放）"
    : "⚠ 以下尺寸在 logo/ 里没有原生图，已从更大尺寸缩放补齐: " + usedFallback.join(", ")
);
console.log("已抹除右下角水印（7 帧）");
console.log(
  fixed.length
    ? "已重做小尺寸圆角（原为圆形）: " + fixed.map((s) => s + "px→" + (s * SMALL_RATIO).toFixed(1)).join(" · ")
    : "无小尺寸圆角需要重做"
);
