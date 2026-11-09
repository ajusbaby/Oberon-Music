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
// 实现（2026-09 修「高刷屏节流档位跑偏」，见 docs/测试报告-0.4.4-未覆盖项补充测试.md §8）：
//   ① 观测刷新间隔：冷启动取前 WARMUP_SAMPLES 个有效间隔的**中位数**当初始周期，之后用 EMA
//      平滑。旧实现是「首个间隔直接锁定」—— 一次异常间隔（首个 rAF 被系统拖慢/被合成器合并）
//      就会把整段会话的档位带偏，而中位数两三个样本内就能自己纠回来；
//   ② 放行档位 k = 「跨过几个刷新周期才放行一帧」= 满足 刷新率/k ≤ 60fps 的**最小**整数
//      （即 ceil(60Hz 周期 / 实测周期)）。旧实现用的是「四舍五入到最近档」，于是
//      75/90/144/200Hz 上会放行 75~90fps（超出 60fps 目标 25%~50%），100/165Hz 上又只有
//      50~55fps：两头都跑偏，正是 DEF-02 的根因；
//   ③ 放行判定留一点余量吸收 vsync 抖动，但余量**必须小于一个刷新周期**，否则会跨档放行
//      （节流形同虚设）；
//   ④ 兜底：面板周期 ≥ UNCAPPED_PERIOD_MS（≈63Hz 及以下）时一律每帧放行 —— 这类屏本来就
//      ≤60fps，没有可省的帧，而"砍半"（60→30fps）才是真正的观感事故（歌词滚动试过 30fps，
//      实测明显变顿，已否掉）。
//
// 代价（有意为之，写在这里免得后人再踩）：k 取 ceil 是**硬上限**，所以在刷新率不是 60
//   整数倍的屏上，实际放行率必然低于 60：75Hz→37.5、90Hz→45、144Hz→48、200Hz→50fps。
//   这是「整周期跳帧」的数学结果（rAF 只在刷新边界回调，帧落不到两个边界中间）。
//   若将来更看重这些屏上的平滑度、而不是省下的那点产帧工作，把 releaseDivisor 里的 ceil
//   换成「就近取整」即可 —— 但必须同步更新 scripts/frame-budget.check.ts 里那张期望表。

/** 目标帧率（动效按 60fps 设计） */
const TARGET_MS = 1000 / 60;

/** 同一次 rAF 回调里，多个循环拿到的 now 相差极小；小于这个值就认为是"同一帧" */
const SAME_FRAME_MS = 2;

/**
 * 「面板本身就 ≤60fps」的阈值（ms）：周期 ≥ 这个值就不再节流。
 * 给 60Hz 面板的实测周期留 5% 余量 ⇒ 63Hz 以下都按"每帧放行"，
 * 避免 59.94Hz 或抖动把 60Hz 屏误判成"每 2 帧"（60 → 30fps）。
 */
const UNCAPPED_PERIOD_MS = TARGET_MS / 1.05;

/** 周期观测容差：抵消 EMA 落在真实周期一侧的误差（3.0000 → 2.9998 不该少一档） */
const PERIOD_TOLERANCE = 0.05;

/** 冷启动取样个数：取这几帧间隔的中位数当初始周期 */
const WARMUP_SAMPLES = 6;

/** 放行余量上限（ms）：吸收抖动，同时远小于一个刷新周期 */
const RELEASE_SLACK_MS = 2;

let periodMs = TARGET_MS; // 观测到的刷新间隔
const warmup: number[] = []; // 冷启动用的样本（最多 WARMUP_SAMPLES 个）
let prevNow = -1;
let lastAccepted = -1e9;

/** 中位数（小数组，样本数 ≤ 6） */
function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 由观测周期算出「每几个刷新周期放行一帧」。
 * 纯函数（导出是为了让 scripts/frame-budget.check.ts 能直接钉住这张表）。
 */
export function releaseDivisor(observedPeriodMs: number): number {
  if (!(observedPeriodMs > 0)) return 1;
  // ④ 面板本来就 ≤60fps：没有可省的帧，砍半反而毁观感
  if (observedPeriodMs >= UNCAPPED_PERIOD_MS) return 1;
  // ② 最小的 k 使 刷新率/k ≤ 60fps
  const k = Math.ceil(TARGET_MS / observedPeriodMs - PERIOD_TOLERANCE);
  return k > 1 ? k : 1;
}

/** 该帧是否允许「干活」。所有逐帧循环都应先问它一次。 */
export function frameBudget(now: number): boolean {
  // ① 观测刷新间隔
  if (prevNow > 0) {
    const d = now - prevNow;
    if (d > 0.5 && d < 100) {
      if (warmup.length < WARMUP_SAMPLES) {
        warmup.push(d);
        periodMs = median(warmup); // 冷启动：中位数，单次抖动带不偏档位
      } else {
        periodMs = periodMs * 0.9 + d * 0.1;
      }
    }
  }
  prevNow = now;

  // ② 放行间隔 = k 个刷新周期（k 保证放行率 ≤ 60fps）
  const k = releaseDivisor(periodMs);
  const step = k * periodMs;

  // ③ 余量 ≤ 2ms 且小于一个周期：只吸抖动，不跨档
  const slack = Math.min(RELEASE_SLACK_MS, periodMs * 0.35);
  if (now - lastAccepted < step - slack) {
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

