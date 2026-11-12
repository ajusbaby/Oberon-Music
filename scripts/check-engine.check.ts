// 歌词引擎断言（scripts/check-engine.mjs 的入口；被 vite 打成 ESM 后在 Node 里跑）。
// 只测三条不变式，因为"准不准"只取决于这三条：
//   ① 索引：左闭右开，任何时刻至多一组是当前组（G1/G6）
//   ② 游标版必须与二分完全等价（否则正常播放与拖动之后会不一致）
//   ③ 时钟：墙钟 1× 只向前，上报落后不跟随、真跳变才对齐（后半首漂移的根因）
import { advanceIndex, indexAt, LyricClock, CLOCK_BACK_JUMP_MS, CLOCK_SNAP_MS } from "../src/lib/lyricEngine";
import { CLUSTER_MS, layoutLyricLines } from "../src/lib/lyricLines";

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

function check(name: string, fn: () => string | null) {
  try {
    const detail = fn();
    results.push({ name, ok: detail == null, detail: detail ?? undefined });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e) });
  }
}

function eq(actual: unknown, expected: unknown, what: string): string | null {
  if (actual === expected) return null;
  return what + "：期望 " + String(expected) + "，实际 " + String(actual);
}

// ---------------------------------------------------------------- ① 索引
const STARTS = [1000, 2000, 3000];

check("indexAt：前奏返回 -1", () => {
  const bad = [eq(indexAt(STARTS, 0), -1, "t=0"), eq(indexAt(STARTS, 999), -1, "t=999")].filter(Boolean);
  return bad.length ? bad.join(" / ") : null;
});

check("indexAt：左闭右开（命中 start 即切换，next-1 仍属上一组）", () => {
  const bad = [
    eq(indexAt(STARTS, 1000), 0, "t=1000"),
    eq(indexAt(STARTS, 1999), 0, "t=1999"),
    eq(indexAt(STARTS, 2000), 1, "t=2000"),
    eq(indexAt(STARTS, 3000), 2, "t=3000"),
    eq(indexAt(STARTS, 1e9), 2, "t=1e9"),
    eq(indexAt([], 1000), -1, "空表"),
  ].filter(Boolean);
  return bad.length ? bad.join(" / ") : null;
});

check("advanceIndex：正走/倒走/跨大步都与二分等价", () => {
  const starts: number[] = [];
  let t = 0;
  for (let i = 0; i < 240; i++) {
    t += 300 + ((i * 137) % 900); // 不规则的句间隔，含重复小间隔
    starts.push(t);
  }
  let cursor = -1;
  for (let x = -500; x <= t + 800; x += 37) {
    const a = advanceIndex(starts, x, cursor);
    const b = indexAt(starts, x);
    if (a !== b) return "t=" + x + " 游标=" + cursor + " 得 " + a + "，二分 " + b;
    cursor = a;
  }
  // 倒着把游标拖回开头（模拟"拖动进度条往回"）
  for (let x = t + 800; x >= -500; x -= 211) {
    const a = advanceIndex(starts, x, cursor);
    const b = indexAt(starts, x);
    if (a !== b) return "倒走 t=" + x + " 得 " + a + "，二分 " + b;
    cursor = a;
  }
  return null;
});

check("advanceIndex：cursor 越界也能收敛", () => {
  const bad = [
    eq(advanceIndex(STARTS, 2500, 99), 1, "cursor 超出右端"),
    eq(advanceIndex(STARTS, 2500, -5), 1, "cursor 小于 -1"),
    eq(advanceIndex([], 2500, 3), -1, "空表"),
  ].filter(Boolean);
  return bad.length ? bad.join(" / ") : null;
});

// ---------------------------------------------------------------- ② 分组（N6 聚类）
check("分组：相距 " + CLUSTER_MS + "ms 的两行算同一组，再多 1ms 就是两句", () => {
  const same = layoutLyricLines([
    { timeMs: 1000, text: "hello" },
    { timeMs: 1000 + CLUSTER_MS, text: "world" },
  ]);
  if (same.groups.length !== 1) return "相距 " + CLUSTER_MS + "ms 应合成 1 组，实际 " + same.groups.length;
  const apart = layoutLyricLines([
    { timeMs: 1000, text: "hello" },
    { timeMs: 1000 + CLUSTER_MS + 1, text: "world" },
  ]);
  return apart.groups.length === 2 ? null : "相距 " + (CLUSTER_MS + 1) + "ms 应为 2 组，实际 " + apart.groups.length;
});

check("分组：簇起点取最早的（宁可早 1ms 不可晚 1ms）", () => {
  const layout = layoutLyricLines([
    { timeMs: 1004, text: "hello" },
    { timeMs: 1000, text: "world" },
  ]);
  if (layout.starts.length !== 1) return "应合成 1 组，实际 " + layout.starts.length;
  return layout.starts[0] === 1000 ? null : "组起点应取 1000，实际 " + layout.starts[0];
});

check("分组：脏数据（倒序 / 同刻）也给出严格递增的 starts", () => {
  const layout = layoutLyricLines([
    { timeMs: 5000, text: "a" },
    { timeMs: 4900, text: "b" },
    { timeMs: 3000, text: "c" },
    { timeMs: 3000, text: "c again" },
    { timeMs: 9000, text: "d" },
  ]);
  for (let i = 1; i < layout.starts.length; i++) {
    if (!(layout.starts[i] > layout.starts[i - 1])) {
      return "starts[" + i + "]=" + layout.starts[i] + " 不大于 " + layout.starts[i - 1];
    }
  }
  // 每个下标都必须能被 indexAt 正常命中（否则会出现"某句永远不亮"）
  const layout2 = layoutLyricLines([
    { timeMs: 5000, text: "a" },
    { timeMs: 4900, text: "b" },
    { timeMs: 3000, text: "c" },
    { timeMs: 9000, text: "d" },
  ]);
  for (let i = 0; i < layout2.starts.length; i++) {
    if (indexAt(layout2.starts, layout2.starts[i]) !== i) {
      return "第 " + i + " 组（start=" + layout2.starts[i] + "）无法被索引命中";
    }
  }
  return null;
});

// ---------------------------------------------------------------- ③ 时钟
check("时钟：墙钟按 1× 前进，不被落后上报拽回", () => {
  const c = new LyricClock();
  c.reset(0, 0);
  c.report(0, true, 0);
  const t1 = c.now(1000);
  if (Math.abs(t1 - 1) > 1e-6) return "1s 后应为 1.000s，实际 " + t1.toFixed(4);
  // 800ms 后上报只到 0.8（落后 200ms）：允许，但不许把墙钟拽回去
  const s = c.report(0.8, true, 1000);
  if (s.snapped) return "落后 200ms 不应判为跳变";
  const t2 = c.now(1000);
  return Math.abs(t2 - 1) < 1e-6 ? null : "上报落后时墙钟被改成了 " + t2.toFixed(4);
});

check("时钟：≤" + CLOCK_BACK_JUMP_MS + "ms 的回退当作抖动丢掉", () => {
  const c = new LyricClock();
  c.reset(10, 0);
  c.report(10, true, 0);
  const s = c.report(9.8, true, 200); // 往回 200ms
  if (s.snapped) return "200ms 回退被判成跳变";
  const t = c.now(200);
  return Math.abs(t - 10.2) < 1e-6 ? null : "回退抖动把锚点改成了 " + t.toFixed(4);
});

check("时钟：真回拖 / 真前拖 → 对齐且要求位移瞬移", () => {
  const c = new LyricClock();
  c.reset(10, 0);
  c.report(10, true, 0);
  const back = c.report(6, true, 200); // 往回 4s = 拖动进度条
  if (!back.snapped) return "回拖 4s 未判为跳变";
  if (Math.abs(c.now(200) - 6) > 1e-6) return "回拖后锚点不对：" + c.now(200);
  const fwd = c.report(90, true, 400); // 往前 84s
  if (!fwd.snapped) return "前拖未判为跳变";
  if (!(Math.abs(fwd.aheadMs) >= CLOCK_SNAP_MS)) return "aheadMs=" + fwd.aheadMs + " 应当触发瞬移";
  return Math.abs(c.now(400) - 90) > 1e-6 ? "前拖后锚点不对：" + c.now(400) : null;
});

check("时钟：暂停后冻结（now 不再走）", () => {
  const c = new LyricClock();
  c.reset(0, 0);
  c.report(12.5, true, 0);
  c.report(12.5, false, 100);
  const t = c.now(9999);
  return Math.abs(t - 12.5) < 1e-6 ? null : "暂停后时间仍在走：" + t.toFixed(4);
});

check("时钟：率偏差被识别（0.9×），此后 1.3s 的落后也不拽回墙钟", () => {
  const warned = console.warn;
  console.warn = () => {};
  try {
    const c = new LyricClock();
    c.reset(0, 0);
    for (let k = 1; k <= 8; k++) c.report(0.9 * k, true, k * 1000);
    if (Math.abs(c.rate - 0.9) > 0.02) return "名义率应≈0.900，实际 " + c.rate.toFixed(4);
    c.report(8.0, true, 8800); // 仍落后 0.7s，不构成回跳
    const s = c.report(8.2, true, 9600); // 落后 1.3s：率可信时这段属于"追赶"而不是跳变
    if (s.snapped) return "率偏差已识别，1.3s 的落后不应判为跳变（aheadMs=" + s.aheadMs.toFixed(0) + "）";
    const t = c.now(9600);
    return Math.abs(t - 9.5) < 1e-6 ? null : "墙钟应走到 9.500s（0.9 + 8.6），实际 " + t.toFixed(4);
  } finally {
    console.warn = warned;
  }
});

check("时钟：真回拖（2.9s）仍按 seek 处理，并重置率样本", () => {
  // 率样本跟着"这一条播放链"走：确认是 seek 就必须作废，否则下一次正常播放会被
  // 旧的率偏差带着跑。这里锁住这个行为 —— 回拖 0.5s 以上一律视为重新开始计时。
  const warned = console.warn;
  console.warn = () => {};
  try {
    const c = new LyricClock();
    c.reset(0, 0);
    for (let k = 1; k <= 8; k++) c.report(0.9 * k, true, k * 1000);
    const before = c.rate;
    const s = c.report(5, true, 8000);
    if (!s.snapped) return "回拖 2.9s 未判为跳变";
    if (Math.abs(c.rate - 1) > 1e-9) return "回拖后率样本未重置：" + c.rate.toFixed(4);
    return Math.abs(c.now(8000) - 5) < 1e-6 ? null : "回拖后锚点不对：" + c.now(8000);
  } finally {
    console.warn = warned;
  }
});

// ---------------------------------------------------------------- 输出
const bad = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? "  ok   " : "  FAIL ") + r.name + (r.ok || !r.detail ? "" : "\n         " + r.detail));
}
console.log("");
console.log(bad.length ? "歌词引擎断言失败 " + bad.length + " 项" : "歌词引擎断言全部通过 " + results.length + " 项");
process.exit(bad.length ? 1 : 0);