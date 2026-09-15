// 全应用共享的「帧预算」：把逐帧工作限到不超过 ~60fps。
//
// 为什么需要：显示器可能是 120/144/180Hz。浏览器把 rAF 对齐到刷新率，而本项目的动效
// 全部按 60fps 设计 —— 在 180Hz 上等于白算 2/3 的帧（GPU 占用 ≈ 帧率 × 每帧成本）。
//
// ⚠️ 必须是「全应用共享的单例」，不能每个循环各配一个闸：若各循环独立跳帧，它们的
//    工作帧会互相错开，整机仍在按刷新率产帧，白算照旧。共用同一个预算，所有循环才会
//    落在同一批帧上。
//
// ⚠️ 它**管不住 CSS 动画/过渡**（浏览器一律按刷新率跑）。无限 CSS 动画（歌词页 drift、
//    卡片光晕、marquee）在高刷屏上仍会持续产帧 —— 那部分只能改成受控 rAF 驱动，或去掉。
//
// 实现：
//   ① 观测刷新间隔：**首个间隔直接锁定**（EMA 预热期间会误判成"每帧放行"而虚高），
//      之后再用 EMA 平滑；
//   ② 放行间隔 = 不超过 60fps 的最大整数倍周期。⚠️ 这里必须用「带负偏置的四舍五入」
//      而不是 floor：EMA 会稳定在真实周期略微偏大的一侧，floor 会因为 3.0000 → 2.9998
//      少放行整整一档（实测把 180Hz 变成"每 2 帧"= 90fps）；
//   ③ 放行判断留 35% 余量，避免 60Hz 屏上因 16.6/16.7 抖动误判成"每 2 帧"（60 → 30fps）。

const TARGET_MS = 1000 / 60;

/** 同一次 rAF 回调里，多个循环拿到的 now 相差极小；小于这个值就认为是"同一帧" */
const SAME_FRAME_MS = 2;

let periodMs = TARGET_MS; // 观测到的刷新间隔
let locked = false;
let prevNow = -1;
let lastAccepted = -1e9;

/** 该帧是否允许「干活」。所有逐帧循环都应先问它一次。 */
export function frameBudget(now: number): boolean {
  // ① 观测刷新间隔
  if (prevNow > 0) {
    const d = now - prevNow;
    if (d > 0.5 && d < 100) {
      if (!locked) {
        periodMs = d; // 首个样本直接锁定，避免预热期虚高
        locked = true;
      } else {
        periodMs = periodMs * 0.9 + d * 0.1;
      }
    }
  }
  prevNow = now;

  // ② 放行间隔 = 不超过 60fps 的最大整数倍周期（带 -0.1 偏置，见文件头说明）
  const k = Math.max(1, Math.round(TARGET_MS / periodMs - 0.1));
  const step = k * periodMs;

  // ③ 留 35% 余量：宁可早放一点，也不要因为抖动丢帧
  if (now - lastAccepted < step - periodMs * 0.35) {
    // ⚠️ 关键：同一个"工作帧"里可能有多个循环先后调用（歌词、波形、漂移…）。
    // 它们拿到的是同一个 rAF 时间戳（相差不到 1ms），必须都放行 ——
    // 否则先调用的那个把名额用掉，后面的全被拒，循环之间变成"抢帧"
    // （曾经真的这样：漂移循环一次都没写成功，因为总被别的循环抢在前面）。
    if (now - lastAccepted < SAME_FRAME_MS) return true;
    return false;
  }
  lastAccepted = now;
  return true;
}

/** 仅供调试/测试：当前观测到的刷新率与放行帧率 */
export function frameBudgetInfo(): { refreshHz: number; gateHz: number } {
  const k = Math.max(1, Math.round(TARGET_MS / periodMs - 0.1));
  return { refreshHz: 1000 / periodMs, gateHz: 1000 / (k * periodMs) };
}
