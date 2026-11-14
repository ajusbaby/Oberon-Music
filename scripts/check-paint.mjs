// 歌词页「切句」作画成本体检（npm run check:paint）。
//
// 为什么要有它：2026-11 实测（CDP + CPU 节流 8×，每轮 40s / 约 28 次切句）——
//   过渡 color+font-size+padding → 切句最差帧 p50 38.9ms / max 55.6ms（掉 2~3 帧）
//   只过渡 color+padding（font-size 瞬间到位）→ p50 11.1ms / max 16.7ms（掉 1 帧）
//   只过渡 font-size → p50 44.5ms（比全开还差）
// 原因：font-size 每帧变一点 ⇒ 每帧重排 + 重新整形中日韩字形（每个字号一套新字形缓存）。
// padding 只动盒子、不动字形，便宜。
//
// 这条规则在界面上完全看不出来（肉眼看只是“这句慢慢变大”），一旦有人“顺手”把 font-size
// 加回过渡，卡顿会静悄悄回来 ⇒ 固化成静态断言。纯文本解析，不跑浏览器。
import fs from "node:fs";
import path from "node:path";

const CSS = path.join(process.cwd(), "src/styles/lyrics.css");
const raw = fs.readFileSync(CSS, "utf8");
// 先去掉注释：注释夹在两条声明之间会让“定位上一条声明的分号”失效（第一次写就栽在这）
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** 把 CSS 拆成 [{ selector, body }]（只处理花括号，够用且不引第三方解析器） */
function rules(text) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) out.push({ selector: m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: m[2] });
  return out;
}
const all = rules(src);
const bySelector = (sel) => all.filter((r) => r.selector.split(",").some((s) => s.trim() === sel));
const decl = (body, prop) => {
  const m = body.match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:([^;]*)"));
  return m ? m[1].trim() : "";
};

let pass = 0;
let fail = 0;
const ok = (label, cond, hint) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (hint ? "\n       -> " + hint : "")); }
};

// ---------- 1. .sl-line 的 transition 不许包含会触发字形整形的属性 ----------
// 这些属性每帧变一点都会让浏览器重新 reshape 文本；CJK 行上单次 reshape ≈ 1.5ms（1×）/ 11ms（8× 节流）。
const SHAPING = ["font-size", "font-weight", "font-stretch", "font-style", "font-family", "letter-spacing", "word-spacing", "line-height"];
const lineRules = bySelector(".sl-line");
ok(".sl-line 规则存在", lineRules.length > 0);
for (const r of lineRules) {
  const tr = decl(r.body, "transition") || decl(r.body, "transition-property");
  if (!tr) continue;
  const bad = SHAPING.filter((p) => new RegExp("(^|[,\\s])" + p + "([,\\s]|$)").test(tr));
  ok(
    ".sl-line 过渡不碰字形整形属性（当前：" + tr + "）",
    bad.length === 0,
    "把 " + bad.join("/") + " 移出 transition：它会逐帧重排+reshape，切句掉 2~3 帧；尺寸瞬间到位即可，配色/内边距照旧平滑"
  );
}

// ---------- 2. 放大本身必须还在（只是不做逐帧动画） ----------
const leadRules = all.filter((r) => r.selector.includes(".is-lead") && r.selector.includes(".sl-line"));
ok(".sl-g.is-lead .sl-line 仍设置 font-size（当前句放大不被删掉）", leadRules.some((r) => /font-size\s*:/.test(r.body)),
   "放大靠 font-size 而非 transform: scale —— scale 会先按原尺寸栅格化再放大，文字发虚（首页封面流踩过）");

// ---------- 3. 整列只有一个 transform 层，且是 will-change: transform ----------
const trackRules = bySelector(".sl-track");
ok(".sl-track 声明 will-change: transform（整列位移走合成层）",
   trackRules.some((r) => /will-change\s*:\s*[^;]*transform/.test(r.body)));
ok(".sl-track 声明 contain: layout style（切句不波及外部布局）",
   trackRules.some((r) => /contain\s*:\s*[^;]*layout/.test(r.body)));

// ---------- 4. 行组自身也必须 contain，否则 class 切换会往上冒泡重排 ----------
const gRules = bySelector(".sl-g");
ok(".sl-g 声明 contain: layout style", gRules.some((r) => /contain\s*:\s*[^;]*layout/.test(r.body)));

// ---------- 5. 淡出遮罩用渐变覆盖层，不许回退到 mask-image（逐帧重光栅化） ----------
const veilRules = all.filter((r) => /^\.sl-lyrics(-area)?(::?(before|after))?$/.test(r.selector.trim()));
ok("歌词区上下淡出没有用 mask-image（用 ::before/::after 渐变覆盖层）",
   veilRules.length > 0 && !veilRules.some((r) => /mask-image/.test(r.body)),
   "mask-image 会让整块歌词每帧重新光栅化；用渐变覆盖层代替");

console.log("\n  作画成本体检：通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
