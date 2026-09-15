// 首页氛围背景 —— 由**当前专辑封面**取色的 WebGL2 流动光雾
//
// 设计
// 1. 取色：player_cover 返回的是 data:image/...;base64（同源，不会污染 canvas），
//    所以在前端把封面缩到 32×32 读像素，按「饱和度 × 出现次数」加权量化出主色，
//    最多取 3 个作为调色板；饱和度统一抬一档，保证偏灰的封面也有氛围感。
//    取不到封面时退回"专辑名哈希 → 色相"的兜底调色板。
// 2. 画面：三团缓慢漂移的大色雾 + 两道斜向光束 + 封面后方的中心背光 + 细颗粒。
//    整体是"明亮流动光"，由上层半透明毛玻璃（侧栏/卡片/播放条）霜化。
// 3. 层次：挂在 .app-shell 内、z-index:-1。外壳带 backdrop-filter，按规范自身形成层叠上下文，
//    因此 -1 恰好落在「外壳底色之上、所有内容之下」。
// 4. 性能：半分辨率渲染、30fps 上限、暂停即停帧（保留画面，0 开销）；页面隐藏也停；
//    另外过一道**全应用共享的 60fps 帧预算**（见 lib/frameBudget.ts），确保高刷屏（120/144/180Hz）
//    上不会白算多余的帧，也不会和别的循环错开产帧。
// 5. 兜底：不支持 WebGL2 时退回同色系 CSS 渐变（由调色板注入 CSS 变量）。
import { useEffect, useRef, useState } from "react";
import { useCover } from "../lib/cover";
import { frameBudget } from "../lib/frameBudget";
import * as api from "../api/ipc";

type RGB = [number, number, number];

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uFlow;      // 播放状态（暂停时循环停帧，这里只用于极轻微的呼吸）
uniform float uBeat;      // 节拍 0..1（无外部节拍时用正弦伪节拍）
uniform vec3 uPal[5];     // [0] 最暗 … [4] 最亮（按亮度排序，与封面取色一致）
out vec4 outColor;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) { v += amp * noise(p); p = rot * p * 2.02; amp *= 0.5; }
  return v;
}

// 连续波形半高度：x ∈ 0..1 → 0..1。没有离散跳变，相邻像素自然过渡（横向无边界）
float waveHalf(float x, float t) {
  float n1 = fbm(vec2(x * 2.2 + t * 0.28, 0.0));          // 低频：大团块
  float n2 = noise(vec2(x * 8.0 - t * 0.45, 3.0));        // 中频：局部波动
  float n3 = noise(vec2(x * 18.0 + t * 0.75, 7.0));       // 高频：细节
  float h = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
  float env = sin(x * 3.14159265);                         // 两端收窄（纺锤形包络）
  env = pow(env, 0.55);
  return h * env;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes.xy;

  vec3 c0 = uPal[0];
  vec3 c1 = uPal[1];
  vec3 c2 = uPal[2];
  vec3 c3 = uPal[3];
  vec3 c4 = uPal[4];

  float t = uTime;
  float beat = uBeat;

  // 底色不再纯白：掺一点封面取色的中间色，让整页带上当前专辑的色调。
  // 只掺 15% —— 深色调封面混出来仍是浅灰紫。原来的纯白底实测正文对比度 11.85:1，
  // 而 AA 只要 4.5:1，留了太多余量，结果就是背景几乎看不见。
  vec3 col = mix(vec3(1.0), c2, 0.10);

  // ===== 波形：连续曲线，无横向边界 =====
  float h = waveHalf(uv.x, t);

  // 低频"宽度调制"：光带本身有宽有窄，形成团块感
  float widthMod = 0.55 + 0.45 * fbm(vec2(uv.x * 1.3 + t * 0.12, 10.0));

  // 半高度：基础 + 宽度调制 + 节拍
  float halfH = 0.012 + h * widthMod * (0.30 + beat * 0.16);   // 节拍驱动厚度

  float dY = abs(uv.y - 0.5);                             // 到中心线的距离
  float dy = dY - halfH;                                  // >0 在外部，<0 在内部

  // ===== 内部主体（宽过渡，无锐边）=====
  float inside = 1.0 - smoothstep(-0.015, 0.050, dy);
  float vertPos = clamp(dY / max(halfH, 0.001), 0.0, 1.0);
  float vertFade = 1.0 - pow(vertPos, 1.3) * 0.35;
  float core = inside * vertFade;

  // ===== 外部光晕 + 整体氛围光 =====
  float overshoot = max(0.0, dy);
  float glow = exp(-overshoot * overshoot * (34.0 - beat * 8.0)) * (0.58 + beat * 0.22);   // 光晕：轻微随拍涨缩
  float ambient = exp(-dY * dY * 16.0) * (0.16 + beat * 0.05);
  ambient *= (0.4 + h * 0.9);

  // ===== 高度 → 颜色（矮处用亮色，高处压到暗色）=====
  vec3 barColor = mix(c3, c2, smoothstep(0.0, 0.55, h));
  barColor = mix(barColor, c1, smoothstep(0.45, 0.85, h));
  barColor = mix(barColor, c0, smoothstep(0.75, 1.0, h));
  barColor = mix(barColor, vec3(1.0), 0.10);               // 略降饱和（原先 0.22 太保守，颜色被洗白）
  barColor = mix(barColor, c4, 0.18);                      // 掺一点最亮色，呼应封面高光

  // ===== 合成 =====
  // 核心亮度随节拍起伏（0.80 → 1.15 的小幅摆幅）：比原来的 0.45→1.35 柔和很多，不刺眼
  float coreGain = 0.84 + beat * 0.24;
  float alpha = core * 0.70 * coreGain + glow + ambient;
  alpha = clamp(alpha * 0.92, 0.0, 0.92);
  col = mix(col, barColor, alpha);

  // 全屏节拍脉动：幅度收敛（0.20 → 0.07），只做轻微起伏，不闪眼
  col = mix(col, barColor, beat * 0.05);
  col += barColor * beat * 0.015 * (1.0 - dY * 1.2);

  // 极轻暗角
  vec2 vc = uv - 0.5;
  float vig = 1.0 - dot(vc, vc) * 0.14;
  col *= clamp(vig, 0.0, 1.0);

  // 颗粒
  float grain = hash(gl_FragCoord.xy + floor(uTime * 20.0)) - 0.5;
  col += grain * 0.005;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/**
 * 从封面 data URL 提取 5 个主色（**按亮度从暗到亮排序**，与 shader 里的角色一一对应）。
 * 算法完全是"取色要准"的路子，不做任何饱和度强拉 —— 强拉会让背景色和封面"对不上"：
 *   1. 每通道压到 5bit（32 级）分桶统计
 *   2. 按出现频次排序
 *   3. 颜色距离 < 55 视为重复（保证 5 个色有辨识度）
 *   4. 按亮度从暗到亮排序（shader 里 c0 底色 / c1 大光丝 / c2 光晕 / c3 主光丝 / c4 细光丝）
 *   5. 不足 5 个时用最亮色补齐
 */
async function paletteFromCover(url: string): Promise<RGB[] | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const N = 96;
    const c = document.createElement("canvas");
    c.width = N;
    c.height = N;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;

    // 1) 5bit 分桶
    const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bk = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      bk.r += r; bk.g += g; bk.b += b; bk.n++;
      buckets.set(key, bk);
    }
    // 2) 频次排序
    const list = [...buckets.values()]
      .map((b) => ({ r: b.r / b.n, g: b.g / b.n, b: b.b / b.n, n: b.n }))
      .sort((a, b) => b.n - a.n);
    // 3) 去重（距离 < 55）
    const picked: { r: number; g: number; b: number }[] = [];
    for (const col of list) {
      if (picked.length >= 5) break;
      const dup = picked.some((q) =>
        Math.hypot(q.r - col.r, q.g - col.g, q.b - col.b) < 55
      );
      if (!dup) picked.push(col);
    }
    if (picked.length === 0) return null;
    // 5) 补齐
    while (picked.length < 5) picked.push({ ...picked[picked.length - 1] });
    // 4) 按亮度排序（暗 → 亮）
    picked.sort((a, b) => (a.r + a.g + a.b) - (b.r + b.g + b.b));
    return picked.map((col) => [
      Math.min(1, Math.max(0, col.r / 255)),
      Math.min(1, Math.max(0, col.g / 255)),
      Math.min(1, Math.max(0, col.b / 255)),
    ] as RGB);
  } catch {
    return null;
  }
}

/** 取不到封面时的兜底：用专辑名散出一组**低饱和**的"暗→亮"雾（色相只做轻微区分）
 *
 * ⚠️ 旧实现是 0.28~0.70 的高饱和单色：兜底种子串 "oberon" 恰好哈希到 254°~287°，
 *    于是"还没播放过任何曲目"时整个首页背景是一大片紫罗兰（实测：色相 312°~315°、饱和度 0.22）。
 *    现在把饱和度压到 0.07~0.16 —— 没有封面/还没播放时只是一层很淡的中性雾，
 *    而不是一块与内容无关的彩色底。有封面时走 paletteFromCover()，不受这里影响。 */
function seedPalette(seed: string): RGB[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const base = ((h >>> 0) % 360) / 360;
  const hsv = (hh: number, s: number, v: number): RGB => {
    const f = (n: number) => {
      const k = (n + hh * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  };
  const hue = ((h >>> 8) % 100) / 100;
  return [
    hsv(base, 0.14, 0.10),
    hsv(base, 0.16, 0.34),
    hsv((base + hue * 0.25) % 1, 0.14, 0.62),
    hsv((base + 0.06) % 1, 0.12, 0.85),
    hsv((base + 0.09) % 1, 0.07, 1.0),
  ];
}

/** 立刻释放 WebGL 上下文。Chromium 对同时存活的上下文有数量上限，
 *  只靠 GC 回收会拖很久，明确 loseContext 才能马上把名额还回去。 */
function releaseGl(gl: WebGL2RenderingContext): void {
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}

interface Props {
  active: boolean;
  playing: boolean;
  /** 冻结：保留最后一帧画面但停止产帧（进场/被盖住时用，替代"卸载"） */
  paused: boolean;
  seed: string;
  trackId: number | null;
}

export function HomeAmbient({ active, playing, paused, seed, trackId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [fallback, setFallback] = useState(false);
  // 画布一旦创建就**常驻**，切页只隐藏不卸载：否则每次回到首页都要重新创建 WebGL 上下文、
  // 重新编译着色器、重新从封面取色 —— 那正是「切换页面瞬时功耗偏高」的一部分。
  // 隐藏用 visibility（不是 display:none）：后者会让 ResizeObserver 量到 0x0，画布会被缩成 2x2。
  const [everActive, setEverActive] = useState(false);
  const activeRef = useRef(active);
  useEffect(() => {
    if (active) setEverActive(true);
    activeRef.current = active;
  }, [active]);
  const cover = useCover(trackId);
  const [palette, setPalette] = useState<RGB[]>(() => seedPalette(seed));
  // colors 是当前实际用于渲染的五色（每帧朝 targets 缓动），targets 是封面取到的目标色板
  const stateRef = useRef({ playing, colors: seedPalette(seed), targets: seedPalette(seed) });
  const ctrlRef = useRef<{ start: () => void; stop: () => void; renderOnce: () => void } | null>(null);
  /** WebGL 上下文创建失败的重试计数（最多 3 次，成功或离开首页即清零） */
  const retryRef = useRef(0);
  // 真实节拍：Rust 侧音频旁路把低频起音强度写到原子量，这里 ~30Hz 轮询取值
  const beatRef = useRef({ real: 0, smooth: 0, received: false });

  // 封面 → 调色板（取不到就用专辑名哈希兜底）
  useEffect(() => {
    let alive = true;
    const fallbackPalette = seedPalette(seed);
    if (!cover) {
      setPalette(fallbackPalette);
      stateRef.current.targets = fallbackPalette;
      return;
    }
    void paletteFromCover(cover).then((p) => {
      if (!alive) return;
      const next = p ?? fallbackPalette;
      setPalette(next);
      stateRef.current.targets = next;
    });
    return () => { alive = false; };
  }, [cover, seed]);

  useEffect(() => { stateRef.current.playing = playing; }, [playing]);

  // 播放时 ~30Hz 取真实节拍（同步命令，只读一个原子量，开销可忽略）
  useEffect(() => {
    if (!active) return;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void api
        .playerBeat()
        .then((v) => {
          beatRef.current.real = typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
          beatRef.current.received = true;
        })
        .catch(() => { /* 引擎未就绪时忽略 */ })
        .finally(() => { inFlight = false; });
    }, 33);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!everActive) { // 画布常驻：只在尚未激活过时不建
      // 离开首页：把重试计数清零，下次回来重新给它机会
      retryRef.current = 0;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!gl) {
      // 上下文创建失败（GPU 进程重启、长会话里被系统回收等）→ 降级成 CSS 兜底画面。
      // ⚠️ 但**不能永久锁定**：canvas 的渲染条件是 `!fallback && active`，一旦 setFallback(true)
      // 它就不再挂载，而本 effect 的依赖原本只有 [active] —— 于是 canvasRef.current 永远是 null，
      // 连重试的机会都没有，整个会话都不会恢复（实测：只有刷新页面才回来）。
      // 重试安排在下面那个独立 effect 里（放这里会被自身的 cleanup 当场清掉，见那里的注释）。
      setFallback(true);
      return;
    }
    retryRef.current = 0;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn("ambient shader:", gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fsh = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fsh) { releaseGl(gl); setFallback(true); return; }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fsh);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { releaseGl(gl); setFallback(true); return; }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uFlow = gl.getUniformLocation(prog, "uFlow");
    const uBeat = gl.getUniformLocation(prog, "uBeat");
    const uPal = gl.getUniformLocation(prog, "uPal[0]");
    const flat = new Float32Array(15);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, last = 0, first = true;

    let flow = stateRef.current.playing ? 1 : 0.35;
    // 最近一次绘制用的参数：重建绘制缓冲后要用同一帧原样补画，避免画面跳变
    let lastTime = 9, lastBeat = 0.2;
    // 写入 5 色 + 节拍并绘制（与原版一致：每帧把 current 传到 shader）
    const paint = (time: number, beat: number) => {
      lastTime = time;
      lastBeat = beat;
      for (let i = 0; i < 5; i++) {
        const c = stateRef.current.colors[i] ?? [0.5, 0.5, 0.5];
        flat[i * 3] = c[0];
        flat[i * 3 + 1] = c[1];
        flat[i * 3 + 2] = c[2];
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uFlow, flow);
      gl.uniform1f(uBeat, beat);
      gl.uniform3fv(uPal, flat);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // 尺寸适配。⚠️ 给 canvas.width/height 赋值会**重置绘制缓冲**，而上下文是
    // alpha:false —— 重置后的缓冲是不透明黑，不补画就是一块黑底。
    // 旧写法只改尺寸不补画，于是拖拽窗口边框时：播放中由 rAF 循环下一帧救回来
    // （表现为背景一闪一闪变黑），暂停时循环已停 → 一直黑下去。这就是反馈的
    // 「拖拽边框时背景在正常和黑屏之间闪」。
    // 现在两手都做：① 重建后立刻用上一帧参数原样补画；② 拖拽途中先不重建
    // （canvas 由 CSS 拉伸，柔光背景看不出差别），等尺寸稳定 120ms 再重建。
    const applySize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(2, Math.min(1100, Math.round(rect.width * 0.5)));
      const h = Math.max(2, Math.min(700, Math.round(rect.height * 0.5)));
      // ⚠️ 不能因为「尺寸没变」就 return：全屏 / 最大化切换会让 WebView 重建 surface，而画布是
      // preserveDrawingBuffer: false —— 下次绘制前它是空的。而背衬尺寸有上限
      // （min(1100, w*0.5) × min(700, h*0.5)），从最大化切到全屏算出来常常完全一样，
      // 于是这里一 return 就再也没人补画 —— 表现就是「默认模式全屏后首页没有 WebGL 背景」。
      // 现在无条件重建 + 补画一帧（重建本身就会清空画布，正好一起解决）。
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      paint(lastTime, lastBeat);
    };
    let sizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(applySize, 120);
    };
    applySize();
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);
    // 元素尺寸可能毫厘不差（见 applySize 的注释），窗口事件更保险：
    // 全屏 / 最大化 / 拖边框都会触发 window.resize
    window.addEventListener("resize", onResize);

    // 动画时间用**累加**而不是绝对时间戳：冻结一段时间（或暂停播放）后恢复时，
    // 用 ts/1000 会让光雾图案一下子跳到一个更晚的时刻（观感是"闪一下/跳一下"）。
    let animTime = 0;
    const draw = (ts: number) => {
      // 全局帧预算（高刷屏限到 ~60fps）+ 它自己的 30fps 闸
      if (!frameBudget(ts)) { raf = requestAnimationFrame(draw); return; }
      if (!first && ts - last < 33) { raf = requestAnimationFrame(draw); return; }
      const dt = first ? 0 : Math.min(120, ts - last);
      last = ts;
      first = false;
      animTime += dt / 1000;
      const st = stateRef.current;
      // 播放状态 → 流速缓动（播放时快、暂停时慢下来但不突兀）
      flow += ((st.playing ? 1 : 0.35) - flow) * Math.min(1, dt / 700);
      // 颜色平滑过渡（原版的帧率无关缓动）：切歌时像"染色"过渡，不突跳
      const lerpSpeed = 1 - Math.pow(0.02, dt / 1000);
      st.colors = st.colors.map((c, i) => {
        const tg = st.targets[i] ?? c;
        return [
          c[0] + (tg[0] - c[0]) * lerpSpeed,
          c[1] + (tg[1] - c[1]) * lerpSpeed,
          c[2] + (tg[2] - c[2]) * lerpSpeed,
        ] as RGB;
      });
      const el = animTime;
      // 真实节拍优先（Rust 侧低频起音检测）；拿不到时退回三段正弦伪节拍，
      // 保证"没接上也有呼吸"。留 0.12 的底，音乐安静时光带也不会完全消失。
      const br = beatRef.current;
      const pseudo = Math.max(0, Math.min(1,
        0.30 + 0.18 * Math.sin(el * 1.7) + 0.10 * Math.sin(el * 3.9 + 1.1) + 0.06 * Math.sin(el * 8.3 + 2.4)));
      // 二次平滑：把 30Hz 采样的节拍再低通一次（约 300ms 时间常数），
      // 避免"闪一下"的硬跳；同时把动态范围压缩（0.25 底 + 0.75 摆幅）让强弱过渡更柔
      const target = br.received ? br.real : pseudo * 0.6;
      const k = 1 - Math.exp(-dt / 380);
      br.smooth += (target - br.smooth) * k;
      const beat = 0.28 + br.smooth * 0.68;
      paint(el, beat);
      raf = requestAnimationFrame(draw);
    };

    const renderOnce = () => {
      const st = stateRef.current;
      st.colors = st.targets.map((c) => [...c] as RGB);   // 静态帧直接用目标色板（5 色）
      paint(9, 0.2);
    };
    const start = () => { if (reduceMotion || raf || document.hidden) return; first = true; raf = requestAnimationFrame(draw); };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    ctrlRef.current = { start, stop, renderOnce };
    // 关键：先画一帧。canvas 以 alpha:false 创建，不画就是"未绘制的黑底"，
    // 之前只有播放中才启动循环，导致"没播放音乐时首页背景是黑的"。
    renderOnce();
    if (!reduceMotion && stateRef.current.playing) start();

    return () => {
      stop();
      ctrlRef.current = null;
      window.clearTimeout(sizeTimer);
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fsh);
      gl.deleteBuffer(buf);
      window.removeEventListener("resize", onResize);
      releaseGl(gl);
    };
  }, [everActive, fallback]);

  // 降级后安排重试：把 fallback 清掉让 canvas 重新挂载，上面那个 effect 就会再跑一次。
  // ⚠️ 必须独立成一个 effect。主 effect 的依赖里带着 fallback，setFallback(true) 会立刻让它
  // 重跑，如果定时器写在那里，它的 cleanup 会在同一帧内把刚排好的重试清掉 —— 重试永不发生
  // （第一版就是这么写的，实测注入一次上下文创建失败后 8 秒都没恢复）。
  // 最多重试 3 次、间隔递增；成功创建（主 effect 里 retryRef 清零）或离开首页都会重置。
  useEffect(() => {
    if (!active || !fallback || retryRef.current >= 3) return;
    retryRef.current += 1;
    const t = window.setTimeout(() => setFallback(false), 2000 * retryRef.current);
    return () => window.clearTimeout(t);
  }, [active, fallback]);

  useEffect(() => {
    if (!ctrlRef.current) return;
    if (active && playing) ctrlRef.current.start();
    else ctrlRef.current.stop();
  }, [playing, active]);

  // 冻结 / 解冻。用它替代"卸载"：卸载会让首页那层流动光雾**直接消失** ——
  // 从首页进歌词页时，暗底还没盖住它，观感就是"光雾先没、动画才出来，像卡了一下"。
  // 冻结则保留最后一帧（画面还在），但不再产帧 —— 于是它上方侧栏/播放条的毛玻璃
  // 也不必再逐帧重算，省下的就是那 3 个点。
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c) return;
    if (!active) { c.stop(); return; } // 隐藏时不产帧
    if (paused) {
      c.stop();
    } else if (stateRef.current.playing) {
      c.start();
    } else {
      c.renderOnce(); // 非播放态：补画一帧静态画面即可
    }
  }, [paused, active]);

  // 暂停状态下色板变化（封面取色回填）时，补画一帧静态画面，否则画面会停在旧色上
  useEffect(() => {
    if (!ctrlRef.current) return;
    if (!stateRef.current.playing) ctrlRef.current.renderOnce();
  }, [palette]);

  useEffect(() => {
    const onVis = () => {
      if (!ctrlRef.current) return;
      if (document.hidden || !stateRef.current.playing) ctrlRef.current.stop();
      else ctrlRef.current.start();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const css = palette.map((c) => "rgb(" + c.map((v) => Math.round(v * 255)).join(",") + ")").join(",");
  return (
    <div
      className={"home-ambient" + (active ? " on" : " hidden") + (fallback ? " fallback" : "")}
      aria-hidden="true"
      style={{ ["--ambient-1" as string]: css } as React.CSSProperties}
    >
      {!fallback && everActive && <canvas ref={canvasRef} />}
    </div>
  );
}
