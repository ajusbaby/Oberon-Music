// 设计稿一致性验证：把「样式设计.html」里声明的样式值，与运行中界面的实际计算值逐项比对
// 用法：node scripts/ui-verify.mjs  （应用需以 --remote-debugging-port=9333 运行）
import fs from "node:fs";
import WebSocket from "ws";

const PORT = process.env.CDP_PORT || "9333";
const DESIGN = "样式设计.html";
const LYRICS_DESIGN = "歌词页设计.html";

// ---------- 1. 解析设计稿 CSS ----------
const html = fs.readFileSync(DESIGN, "utf8");
const rawCss = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
// 去掉 CSS 注释，避免注释文本被当成选择器
const styleBlock = rawCss
  .split("/*")
  .map((part, i) => (i === 0 ? part : part.slice(part.indexOf("*/") + 2)))
  .join("");

// :root 变量
const cssVars = {};
const rootMatch = styleBlock.match(/:root\s*\{([\s\S]*?)\}/);
if (rootMatch) {
  rootMatch[1].split(";").forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) cssVars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
}

function resolveVars(value) {
  let out = value;
  for (let i = 0; i < 5 && out.includes("var("); i++) {
    out = out.replace(/var\((--[a-z0-9-]+)\)/gi, (m, name) => cssVars[name] ?? m);
  }
  return out.trim();
}

// 选择器 → 声明
const rules = new Map();
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = ruleRe.exec(styleBlock)) !== null) {
  const selector = m[1].trim().replace(/\s+/g, " ");
  if (selector.startsWith("@") || selector.includes("%")) continue;
  const body = m[2];
  const decls = {};
  body.split(";").forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) decls[line.slice(0, i).trim()] = resolveVars(line.slice(i + 1).trim());
  });
  // 同名选择器合并（后者优先）
  rules.set(selector, { ...(rules.get(selector) || {}), ...decls });
}

// ---------- 2. 需要比对的 (选择器, CSS 属性, 可选期望值覆盖) ----------
const CHECKS = [
  [".app-shell", "border-radius"],
  [".sidebar", "width"],
  [".logo-text", "font-size"],
  [".nav-item", "height"],
  [".nav-item", "font-size"],
  [".nav-item", "border-radius"],
  [".settings-btn", "height"],
  [".main-content", "padding-top"],
  [".main-content", "padding-left"],
  [".main-content", "padding-bottom"],
  [".main-top-bar", "margin-bottom"],
  [".search-bar", "height"],
  [".search-bar", "border-radius"],
  [".window-btn", "width"],
  [".window-btn", "height"],
  [".greeting-title", "font-size"],
  [".greeting-title", "font-weight"],
  [".greeting-section", "margin-bottom"],
  [".cf-perspective", "height"],
  [".cf-perspective", "perspective"],
  [".cf-card", "width"],
  [".cf-card", "height"],
  [".cf-card", "margin-left"],
  [".cf-meta h3", "font-size"],
  [".cf-meta h3", "font-weight"],
  [".cf-dots", "gap"],
  [".cf-dot:not(.active)", "width"],
  [".cf-dot.active", "width"],
  [".bottom-player", "height"],
  [".ctrl-btn", "width"],
  [".ctrl-btn", "height"],
  [".ctrl-btn.play-btn", "width"],
  [".ctrl-btn.play-btn", "height"],
  [".player-track-cover", "width"],
  [".player-track-cover", "height"],
  [".player-track-name", "font-size"],
  [".player-track-artist", "font-size"],
  [".favorite-btn", "width"],
  [".time-label", "font-size"],
  [".progress-slider", "height"],
  [".right-icon-btn", "width"],
  [".right-icon-btn", "height"],
  [".volume-slider", "width"],
  [".queue-popover", "width"],
  [".queue-popover", "max-height"],
  [".queue-item-cover", "width"],
  [".queue-item-name", "font-size"],
  [".dialog", "width"],
  [".dialog", "padding-top"],
  [".dialog-title", "font-size"],
  [".dialog-input", "height"],
  [".empty-library-title", "font-size"],
  [".empty-library-btn", "padding-left"],
  [".empty-library-btn", "padding-top"],
];

// 特殊状态的期望值（选择器|属性）
const EXPECT = {
  ".cf-dot:not(.active)|width": "7px",
  ".cf-dot.active|width": "20px",
  ".empty-library-btn|padding-left": "22px",
  ".empty-library-btn|padding-top": "10px",
  // 品牌字已按需求换成内置的 Ephesis 手写体（见 design.css 的 .logo-text）。
  // 手写体的字面比设计稿用的 Inter 小一大截，沿用 17px 会明显偏小，所以单独放大到 30px；
  // 字体族/字重这两项设计稿没声明，也就没有对应的比对项。
  ".logo-text|font-size": "30px",
  // 进度条已按需求换成 M3 波浪滑块（canvas 绘制，见 components/WaveProgress.tsx）。
  // 设计稿里它是一个 4px 高的轨道 div；现在 .progress-slider 只是画布容器，
  // 高度按手柄（14px）+ 上下留白取 24px，轨道/波浪/手柄都画在 canvas 里，
  // 所以 .progress-fill / .progress-thumb 两个子元素已不复存在。
  ".progress-slider|height": "24px",
};

// 设计稿的类名骨架（父 → 子）
const STRUCTURE = [
  [".app-shell", ".app-body"],
  [".app-body", ".sidebar"],
  [".app-body", ".main-content"],
  [".sidebar", ".sidebar-logo"],
  [".sidebar", ".sidebar-nav"],
  [".sidebar", ".playlist-section"],
  [".sidebar", ".sidebar-bottom"],
  [".main-content", ".main-top-bar"],
  [".main-top-bar", ".search-bar"],
  [".main-top-bar", ".window-controls"],
  [".app-shell", ".bottom-player"],
  [".bottom-player", ".player-controls"],
  [".bottom-player", ".player-track"],
  [".bottom-player", ".progress-area"],
  [".bottom-player", ".player-right-controls"],
  // 队列弹层不再无条件渲染（1 万首会 map 出约 10 万节点，而它当时根本没有入口能打开），
  // 现在包在 `{queueOpen && …}` 里，且 uiStore.toggleQueue 全仓零调用 —— 所以它
  // 永远不会出现在 DOM 里，这两条骨架检查已无意义。真要做成可用 UI 时再加回来，
  // 并同步做行虚拟化（见 PlayerBar 里那段注释）。
  [".player-track", ".player-track-cover"],
  [".player-track", ".player-track-info"],
  [".player-track-info", ".player-track-name"],
  [".player-track-info", ".player-track-artist"],
  [".progress-area", ".progress-slider"],
  [".progress-area", ".time-label"],
  [".player-right-controls", ".volume-control"],
  [".volume-control", ".volume-slider"],
  [".coverflow-section", ".cf-perspective"],
  [".coverflow-section", ".cf-dots"],
  [".cf-perspective", ".cf-card"],
  [".cf-card", ".cf-cover"],
  [".cf-card", ".cf-meta"],
  [".sidebar-nav", ".nav-item"],
];

// ---------- 3. 页面侧测量 ----------
async function findTarget() {
  const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("未找到页面目标");
  return page;
}

const target = await findTarget();
const ws = await new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.on("open", () => resolve(socket));
  socket.on("error", reject);
});
let id = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  }
});
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve) => pending.set(mid, { resolve }));
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression: expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

if (process.argv.includes("--states")) {
  await evaluate("(async()=>{const inv=window.__TAURI_INTERNALS__.invoke;const page=await inv('tracks_list',{filter:{page:1,pageSize:3}});if(page.items.length>0){try{await inv('player_play_all',{startTrackId:page.items[0].id});}catch(e){}}return 'playing';})()");
  await new Promise(function (r) { setTimeout(r, 2500); });
  // 队列弹层已无入口按钮：直接加上 visible 类，仅用于核对设计稿声明的样式值
  await evaluate("(function(){var el=document.querySelector('.queue-popover');if(el)el.classList.add('visible');return true;})()");
  await new Promise(function (r) { setTimeout(r, 700); });
}

// 测量前先把指针移开，避免 :hover 规则干扰（例如进度条 hover 会变高）
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 });

// 测量前回到首页，确保封面流等组件已渲染
await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('.nav-item')).find(function(x){return x.textContent.indexOf('Home')>=0});if(b){b.click();}return true;})()");
for (let i = 0; i < 20; i++) {
  const ready = await evaluate("document.querySelectorAll('.cf-card').length > 0");
  if (ready) break;
  await new Promise(function (r) { setTimeout(r, 400); });
}
await new Promise(function (r) { setTimeout(r, 800); });

const payload = CHECKS.map(([selector, prop]) => [selector, prop]);
const expr =
  "(function(){" +
  "var checks=" + JSON.stringify(payload) + ";" +
  "var structure=" + JSON.stringify(STRUCTURE) + ";" +
  "function find(sel){var list=document.querySelectorAll(sel);if(list.length===0)return null;" +
  "for(var i=0;i<list.length;i++){var r=list[i].getBoundingClientRect();if(r.width>0&&r.height>0)return list[i];}return list[0];}" +
  "var probes=[];" +
  "var styles=checks.map(function(c){var el=find(c[0]);var probed=false;" +
  "if(!el&&c[0].indexOf(' ')<0&&c[0].indexOf(':')<0){el=document.createElement('div');el.className=c[0].slice(1);document.body.appendChild(el);probes.push(el);probed=true;}" +
  "if(!el)return{selector:c[0],prop:c[1],value:null};" +
  "var v=getComputedStyle(el).getPropertyValue(c[1]).trim();" +
  "return{selector:c[0],prop:c[1],value:v,probed:probed};});" +
  "var st=structure.map(function(pair){var parents=document.querySelectorAll(pair[0]);" +
  "if(parents.length===0)return{parent:pair[0],child:pair[1],ok:null};" +
  "for(var j=0;j<parents.length;j++){if(parents[j].querySelector(pair[1]))return{parent:pair[0],child:pair[1],ok:true};}" +
  "return{parent:pair[0],child:pair[1],ok:false};});" +
  "probes.forEach(function(x){x.remove();});" +
  "return{styles:styles,structure:st};})()";

const evalRes = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
const results = evalRes.result.value;

await send("Runtime.enable");


// ---------- 4. 比对 ----------
const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, " ");
const isRelative = (v) => v.indexOf("%") >= 0 || v === "auto" || v.indexOf("calc(") >= 0 || v.indexOf("fr") >= 0;

let pass = 0;
let skipped = 0;
const fails = [];
for (const r of results.styles) {
  const key = r.selector + "|" + r.prop;
  const rule = rules.get(r.selector) || {};
  const declared = EXPECT[key] !== undefined ? EXPECT[key] : rule[r.prop];
  if (declared === undefined || isRelative(String(declared))) { skipped++; continue; }
  if (r.value === null || r.value === "") { fails.push(Object.assign({}, r, { declared: declared })); continue; }
  const a = norm(r.value).replace(/px$/, "");
  const b = norm(declared).replace(/px$/, "");
  if (a === b) pass++; else fails.push(Object.assign({}, r, { declared: declared }));
}

console.log("=== 一、计算样式一致性（设计稿声明值 vs 运行实测值）===");
console.log("通过 " + pass + " 项 · 跳过 " + skipped + " 项 · 不一致 " + fails.length + " 项");
fails.forEach(function (f) {
  console.log("  x " + f.selector + " [" + f.prop + "] 设计稿=" + f.declared + " 实测=" + f.value);
});

console.log("");
// ---------- 3.5 歌词页（《歌词页设计.html》）一致性 ----------
const lyricsHtml = fs.readFileSync(LYRICS_DESIGN, "utf8");
const lyricsStyle = lyricsHtml.slice(lyricsHtml.indexOf("<style>") + 7, lyricsHtml.indexOf("</style>"))
  .split("/*").map((part, i) => (i === 0 ? part : part.slice(part.indexOf("*/") + 2))).join("");
const lyricsRules = new Map();
{
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let mm;
  while ((mm = re.exec(lyricsStyle)) !== null) {
    const sel = mm[1].trim().replace(/\s+/g, " ");
    if (sel.startsWith("@") || sel.includes("%")) continue;
    const decls = {};
    mm[2].split(";").forEach((line) => { const i = line.indexOf(":"); if (i > 0) decls[line.slice(0, i).trim()] = line.slice(i + 1).trim(); });
    lyricsRules.set(sel, { ...(lyricsRules.get(sel) || {}), ...decls });
  }
}
// 歌词页内需要比对的 (设计稿选择器, 属性)；应用内的适配值写在 EXPECT_LYRICS 里
// 注：底栏（.bottom/.control-btn/.play/.cover-small/.times/.rail/.volume-rail）按需求改为
//     直接复用主界面播放条组件（variant="lyrics"），故不再比对歌词设计稿里的这些声明值，
//     改由 ui-smoke 的「歌词页底栏与主界面播放条一致」断言保证两边几何完全一致。
const LYRICS_CHECKS = [
  [".player", "border-radius"], [".player", "overflow"],
  [".topbar", "left"], [".topbar", "right"], [".topbar", "top"],
  [".track-pill", "border-radius"], [".track-pill", "min-width"],
  [".back", "width"], [".back", "height"],
  [".icon-btn", "width"], [".icon-btn", "height"],
  [".lyrics", "margin-top"],
  [".line", "color"], [".line.near", "color"], [".line.active", "color"], [".line.active", "font-weight"],
  [".grain", "opacity"],
  [".bg", "filter"],
];
// 应用内适配（窗口铺满、圆角沿用应用外壳），其余一律以设计稿声明值为准
const EXPECT_LYRICS = {
  ".player|border-radius": "35px",
  // 按需求把背景虚化降低 10%：设计稿 blur(42px) → 实测 37.8px
  ".bg|filter": "blur(37.8px) saturate(1.08) brightness(.78)",
  ".player|overflow": "hidden",
};
/** 歌词页数值比对：忽略空白/简写，并容忍浏览器量化（alpha 1/255）与可变字体字重插值 */
const lyrEqual = (a, b) => {
  const na = String(a).replace(/\s+/g, "");
  const nb = String(b).replace(/\s+/g, "");
  if (na === nb) return true;
  const ta = na.match(/-?\d*\.?\d+/g) || [];
  const tb = nb.match(/-?\d*\.?\d+/g) || [];
  if (ta.length !== tb.length) return false;
  if (na.replace(/-?\d*\.?\d+/g, "#") !== nb.replace(/-?\d*\.?\d+/g, "#")) return false;
  return ta.every(function (x, i) {
    const va = parseFloat(x);
    const vb = parseFloat(tb[i]);
    if (va === vb) return true;
    return Math.abs(va - vb) <= Math.max(0.01, Math.abs(vb) * 0.01);
  });
};
const lyrPayload = LYRICS_CHECKS.map(([s, p]) => [s, p]);
await evaluate("(async function(){var inv=window.__TAURI_INTERNALS__.invoke;var list=await inv('tracks_list',{filter:{page:1,pageSize:60}});var pick=null;for(var i=0;i<list.items.length;i++){var r=await inv('track_lyrics',{trackId:list.items[i].id});if(r.lines.length>3){pick=list.items[i];break;}}if(!pick&&list.items.length)pick=list.items[0];if(pick){await inv('player_play_track',{trackId:pick.id,queue:[pick.id]});}await new Promise(function(r){setTimeout(r,1200);});var t=document.querySelector('.player-track');if(t)t.click();await new Promise(function(r){setTimeout(r,2000);});return !!document.querySelector('.lyrics-page');})()");
// 设计稿里 .line 有 0.55s 过渡：测量前临时关闭过渡，否则取到的是动画中间值
await evaluate("(function(){var s=document.getElementById('no-transition')||document.createElement('style');s.id='no-transition';s.textContent='.lyrics-page *{transition:none!important;animation:none!important}';document.head.appendChild(s);return true;})()");
await new Promise(function (r) { setTimeout(r, 400); });

const lyrExpr =
  "(function(){var checks=" + JSON.stringify(lyrPayload) + ";" +
  "function find(sel){var list=document.querySelectorAll(sel);if(list.length===0)return null;" +
  "for(var i=0;i<list.length;i++){var r=list[i].getBoundingClientRect();if(r.width>0&&r.height>0)return list[i];}return list[0];}" +
  "return checks.map(function(c){var el=find('.lyrics-page '+c[0]);if(!el)return{selector:c[0],prop:c[1],value:null};" +
  "return{selector:c[0],prop:c[1],value:getComputedStyle(el).getPropertyValue(c[1]).trim()};});})()";
const lyrRes = await send("Runtime.evaluate", { expression: lyrExpr, returnByValue: true });
const lyrResults = lyrRes.result.value || [];
let lyrPass = 0, lyrSkip = 0;
const lyrFails = [];
for (const r of lyrResults) {
  const rule = lyricsRules.get(r.selector) || {};
  const key = r.selector + "|" + r.prop;
  const declared = EXPECT_LYRICS[key] !== undefined ? EXPECT_LYRICS[key] : rule[r.prop];
  if (declared === undefined || isRelative(String(declared))) { lyrSkip++; continue; }
  if (r.value === null || r.value === "") { lyrFails.push(Object.assign({}, r, { declared: declared })); continue; }
  if (lyrEqual(r.value, declared)) lyrPass++; else lyrFails.push(Object.assign({}, r, { declared: declared }));
}
console.log("");
console.log("=== 三、歌词页一致性（《歌词页设计.html》声明值 vs 实测）===");
console.log("通过 " + lyrPass + " 项 · 跳过 " + lyrSkip + " 项 · 不一致 " + lyrFails.length + " 项");
lyrFails.forEach(function (f) { console.log("  x " + f.selector + " [" + f.prop + "] 设计稿=" + f.declared + " 实测=" + f.value); });
await evaluate("(function(){var s=document.getElementById('no-transition');if(s)s.remove();var b=document.querySelector('.lyrics-page .back');if(b)b.click();return true;})()");
await new Promise(function (r) { setTimeout(r, 500); });

console.log("=== 二、DOM 结构一致性（设计稿类名骨架）===");
const okList = results.structure.filter(function (s) { return s.ok === true; });
const bad = results.structure.filter(function (s) { return s.ok === false; });
const na = results.structure.filter(function (s) { return s.ok === null; });
console.log("通过 " + okList.length + " 项 · 缺失 " + bad.length + " 项 · 未渲染 " + na.length + " 项");
bad.forEach(function (s) { console.log("  x 缺少 " + s.parent + " > " + s.child); });
na.forEach(function (s) { console.log("  - 未渲染：" + s.parent + " > " + s.child); });

ws.close();
process.exit(fails.length + bad.length > 0 ? 1 : 0);
