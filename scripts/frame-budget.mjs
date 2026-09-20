// 帧预算逻辑校验 runner：先用 Vite 把校验入口打成 ESM，再跑断言。
//
//   npm run check:frame
//
// 覆盖：① releaseDivisor 的档位表（16 种刷新率）
//       ② 硬性质：不超过 60fps、不塌到 30fps 以下
//       ③ 冷启动首个间隔异常时能自行纠正
//       ④ 合成时间戳实测放行节奏（含刷新率切换后的 EMA 自适应）
//       ⑤ 同一帧内多个循环都被放行
// 这些规则在界面上完全看不出来（"高刷屏上到底放行了多少帧"只能靠时间戳算），
// 而它们全是纯函数，用合成时间戳跑一遍最省事。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const root = process.cwd();
const outDir = ".build/frame-budget";

await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: "scripts/frame-budget.check.ts",
      output: { entryFileNames: "check.mjs", format: "esm" },
    },
  },
});

const mod = await import(pathToFileURL(path.join(root, outDir, "check.mjs")).href);
process.exit(mod.run() ? 1 : 0);
