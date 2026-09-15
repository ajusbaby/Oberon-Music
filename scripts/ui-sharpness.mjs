// 界面清晰度测量：对多个区域截图裁区，计算边缘锐度（拉普拉斯能量 / 梯度）
// 用法：node scripts/ui-sharpness.mjs <输出前缀>   [INJECT_CSS=...] [SELECTORS='name=sel|name=sel']
import fs from "node:fs";
import zlib from "node:zlib";
import WebSocket from "ws";

const PORT = process.env.CDP_PORT || "9333";
const OUT = process.argv[2] || ".build/sharp";
const DPR = Number(process.env.CAPTURE_DPR || "1.25");
const REGIONS = (process.env.SELECTORS ||
  "卡片标题=.cf-card.cf-active .cf-meta h3|播放条时间=.time-label|播放条按钮图标=.player-controls .ctrl-btn|侧栏导航=.nav-item|曲库行标题=.track-title"
).split("|").map((s) => { const i = s.indexOf("="); return { name: s.slice(0, i), selector: s.slice(i + 1) }; });

async function connect() {
  const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
  const page = (await res.json()).find((t) => t.type === "page");
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg.result); }
  });
  const send = (method, params = {}) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params })); return new Promise((resolve) => pending.set(mid, { resolve })); };
  await send("Runtime.enable");
  return { ws, send };
}

function decodePng(buf) {
  let off = 8, width = 0, height = 0, colorType = 6;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("ascii");
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride); pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function crop(img, x, y, w, h) {
  const out = Buffer.alloc(w * h * img.channels);
  for (let row = 0; row < h; row++) img.data.copy(out, row * w * img.channels, ((y + row) * img.width + x) * img.channels, ((y + row) * img.width + x + w) * img.channels);
  return { width: w, height: h, channels: img.channels, data: out };
}

function sharpness(img) {
  const { width: w, height: h, channels: c, data } = img;
  const lum = (x, y) => { const i = (y * w + x) * c; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  const grads = []; let lapSum = 0, count = 0, dark = 0, total = 0, chroma = 0, chromaMax = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const center = lum(x, y);
    lapSum += Math.abs(4 * center - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1)); count++;
    grads.push(Math.abs(lum(x + 1, y) - lum(x - 1, y)) + Math.abs(lum(x, y + 1) - lum(x, y - 1)));
    if (center < 160) dark++; total++;
    const i0 = (y * w + x) * c;
    const mx = Math.max(data[i0], data[i0 + 1], data[i0 + 2]);
    const mn = Math.min(data[i0], data[i0 + 1], data[i0 + 2]);
    chroma += mx - mn; if (mx - mn > chromaMax) chromaMax = mx - mn;
  }
  grads.sort((a, b) => a - b);
  const pct = (p) => +grads[Math.floor(grads.length * p)].toFixed(2);
  return { lap: +(lapSum / count).toFixed(2), grad: +(grads.reduce((a, b) => a + b, 0) / grads.length).toFixed(2), p95: pct(0.95), ink: +(dark / total * 100).toFixed(1), chroma: +(chroma / total).toFixed(2), chromaMax };
}

const { ws, send } = await connect();
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
};

if (process.env.CAPTURE_NATIVE === "1") {
  await send("Emulation.clearDeviceMetricsOverride");
} else {
  await send("Emulation.setDeviceMetricsOverride", { width: 1056, height: 752, deviceScaleFactor: DPR, mobile: false });
}
if (process.env.GOTO_HOME !== "0") {
  await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('.nav-item')).find(function(x){return x.textContent.indexOf('Home')>=0});if(b)b.click();return true;})()");
  await new Promise((r) => setTimeout(r, 1500));
}
if (process.env.INJECT_CSS) {
  await evaluate("(function(){var s=document.getElementById('inject-ab')||document.createElement('style');s.id='inject-ab';s.textContent=" + JSON.stringify(process.env.INJECT_CSS) + ";document.head.appendChild(s);return true;})()");
  await new Promise((r) => setTimeout(r, 1000));
} else {
  await evaluate("(function(){var s=document.getElementById('inject-ab');if(s)s.remove();return true;})()");
  await new Promise((r) => setTimeout(r, 800));
}
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 });
await new Promise((r) => setTimeout(r, 400));

const rects = await evaluate("(function(){var R=" + JSON.stringify(REGIONS) + ";R.forEach(function(r){var el=document.querySelector(r.selector);if(!el){r.missing=true;return;}var b=el.getBoundingClientRect();r.x=b.left;r.y=b.top;r.w=b.width;r.h=b.height;});return R;})()");
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
const full = decodePng(Buffer.from(shot.data, "base64"));
const out = [];
for (const r of rects) {
  if (r.missing || r.w < 2 || r.h < 2) { out.push({ name: r.name, selector: r.selector, missing: true }); continue; }
  const pad = 2;
  const x = Math.max(0, Math.round((r.x - pad) * DPR));
  const y = Math.max(0, Math.round((r.y - pad) * DPR));
  const w = Math.min(full.width - x, Math.round((r.w + pad * 2) * DPR));
  const h = Math.min(full.height - y, Math.round((r.h + pad * 2) * DPR));
  out.push({ name: r.name, selector: r.selector, box: Math.round(r.w) + "x" + Math.round(r.h), ...sharpness(crop(full, x, y, w, h)) });
}
const sum = [...full.data].reduce((a, b) => (a + b) % 999983, 0);
console.log(JSON.stringify({ checksum: sum, capture: full.width + "x" + full.height, regions: out }));
ws.close();
