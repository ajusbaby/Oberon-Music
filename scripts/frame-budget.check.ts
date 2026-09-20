// 帧预算逻辑校验（npm run check:frame）：钉住「高刷屏节流档位」这张表，并验证冷启动抗抖动。
//
// 为什么要有它：DEF-02 —— 旧实现用「四舍五入到最近档」选放行间隔，于是在
// 75/90/144/200Hz 上放行 75~90fps（超出 60fps 目标 25%~50%），在 100/165Hz 上又只有 50~55fps。
// 屏幕刷新率千差万别，肉眼又看不出"这一档到底对不对"，所以必须把它变成一张可断言的表。
//
// 与 scripts/font-logic.check.ts 同类：纯逻辑、不碰 DOM/node API，由 runner（scripts/frame-budget.mjs）
// 用 Vite 打包后执行。
//
// ⚠️ 全流程共用**一个单调递增的时钟**。真实 rAF 时间戳只增不减；如果每段用例把时钟重置回 0，
//    就会命中 frameBudget 里"同一帧内多次调用都放行"那条分支（now - lastAccepted 变成负数），
//    结果所有帧都被放行、测出来永远是满帧率 —— 第一次写这个校验就栽在这里。
import { frameBudget, frameBudgetInfo, releaseDivisor } from "../src/lib/frameBudget";

/** [面板刷新率, 期望放行帧率]。⚠️ 改节流策略（ceil ↔ 就近取整）必须同步这张表。 */
const TABLE: [number, number][] = [
  [30, 30],
  [50, 50],
  [59.94, 59.94],
  [60, 60],
  [61, 61],
  [62, 62],
  [75, 37.5],
  [90, 45],
  [100, 50],
  [120, 60],
  [144, 48],
  [165, 55],
  [180, 60],
  [200, 50],
  [240, 60],
  [360, 60],
];

/** 面板本身就 ≤60fps 的上界：这些刷新率必须"每帧放行"（否则 60Hz 会被砍成 30fps） */
const UNCAPPED_HZ = 63;

let clock = 1000; // 全流程共用的单调时钟（ms）

export function run(): number {
  let pass = 0;
  let fail = 0;
  const ok = (label: string, cond: boolean) => {
    if (cond) pass++;
    else { fail++; console.log("FAIL " + label); }
  };
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

  // ---------- 1. 纯函数：releaseDivisor 的档位表 ----------
  console.log("  —— releaseDivisor 档位表（纯函数）——");
  for (const [hz, wantFps] of TABLE) {
    const k = releaseDivisor(1000 / hz);
    const fps = hz / k;
    ok(hz + "Hz → k=" + k + " / " + fps.toFixed(2) + "fps（期望 " + wantFps + "）", near(fps, wantFps, 0.01));
  }

  // ---------- 2. 硬性质 ①：放行率不得超过 60fps（≤63Hz 的面板不受节流） ----------
  for (const [hz] of TABLE) {
    const fps = hz / releaseDivisor(1000 / hz);
    ok(hz + "Hz 放行率不超上限（" + fps.toFixed(2) + "fps）", hz <= UNCAPPED_HZ ? near(fps, hz, 0.01) : fps <= 60 + 0.01);
  }
  // ---------- 3. 硬性质 ②：绝不塌到半速以下（整周期跳帧的数学下限是 R/ceil(R/60)） ----------
  for (const [hz] of TABLE) {
    const fps = hz / releaseDivisor(1000 / hz);
    ok(hz + "Hz 放行率不低于 30fps（" + fps.toFixed(2) + "）", fps >= 30);
  }

  // ---------- 4. 冷启动抗抖动（必须最先跑：它依赖 warmup 取样路径还是空的） ----------
  // 场景：60Hz 面板，但第一个 rAF 间隔只有 6ms（被系统拖慢 / 合成器合并帧）。
  // 旧实现把这个 6ms 直接"锁定"成周期 ⇒ k=3（≈20fps），再靠 EMA 慢慢爬回 60fps；
  // 现在取前 6 个样本的中位数 ⇒ 三个样本内就回到 k=1。
  {
    const step = 1000 / 60;
    frameBudget(clock);            // 第 1 帧
    clock += 6;                    // ← 异常间隔：只有 6ms
    frameBudget(clock);
    let accepted = 0;
    let frames = 0;
    for (let i = 0; i < 400; i++) {
      clock += step;
      const took = frameBudget(clock);
      if (i >= 10) { frames++; if (took) accepted++; }
    }
    const fps = accepted / ((frames * step) / 1000);
    console.log("  冷启动首帧 6ms 抖动 → 稳定后 " + fps.toFixed(1) + " fps");
    ok("冷启动首帧抖动后仍回到 60fps（实测 " + fps.toFixed(1) + "fps）", fps >= 57);
  }

  // ---------- 5. 时间戳驱动：实际放行节奏与表一致（含 EMA 收敛 / 刷新率切换自适应） ----------
  console.log("  —— 合成时间戳实测（每档先 240 帧让 EMA 收敛，再统计 2400 帧）——");
  const simulate = (hz: number, warm: number, measure: number) => {
    const step = 1000 / hz;
    for (let i = 0; i < warm; i++) { frameBudget(clock); clock += step; }
    let accepted = 0;
    for (let i = 0; i < measure; i++) { if (frameBudget(clock)) accepted++; clock += step; }
    return accepted / ((measure * step) / 1000);
  };
  for (const [hz, wantFps] of TABLE) {
    const fps = simulate(hz, 240, 2400);
    console.log("    " + String(hz).padStart(6) + " Hz → " + fps.toFixed(1).padStart(5) + " fps（期望 " + wantFps + "）");
    ok(hz + "Hz 实测放行率符合表（" + fps.toFixed(1) + " vs " + wantFps + "）", near(fps, wantFps, 1.5));
  }

  // ---------- 6. 59.94Hz（NTSC 系）不得被砍成 30fps ----------
  {
    const fps = simulate(59.94, 240, 2400);
    ok("59.94Hz 保持满帧（实测 " + fps.toFixed(1) + "fps）", fps >= 58);
  }

  // ---------- 7. 同一帧内的多次调用必须都放行（多个循环共用同一个闸） ----------
  {
    clock += 100; // 空闲一段，保证下一帧一定被放行
    const first = frameBudget(clock);
    const second = frameBudget(clock + 0.5); // 同一个 rAF 里的下一个循环
    ok("同一帧内第二个循环也被放行", first === true && second === true);
  }

  // ---------- 8. frameBudgetInfo 与档位表一致 ----------
  {
    const info = frameBudgetInfo();
    const hz = info.refreshHz;
    ok(
      "frameBudgetInfo 报的放行帧率与 releaseDivisor 一致（" + hz.toFixed(1) + "Hz → " + info.gateHz.toFixed(1) + "fps）",
      near(info.gateHz, hz / releaseDivisor(1000 / hz), 0.5)
    );
  }

  console.log("  帧预算校验：通过 " + pass + " / 失败 " + fail);
  return fail;
}
