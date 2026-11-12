// 歌词引擎断言运行器（npm run check:engine）。
//
// 为什么不在浏览器里测：准不准取决于几百毫秒的边界与 800ms 一次的位置上报，
// 用真实音频测等于撞运气；这里把引擎的纯逻辑抽出来逐条断言（见 check-engine.check.ts）。
// 做法与 check-lyrics.mjs 一致：vite 以 SSR 模式把入口打成一个 ESM 文件，再在 Node 里 import。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const root = process.cwd();
const outDir = ".build/check-engine";

await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: "scripts/check-engine.check.ts",
      output: { entryFileNames: "check.mjs", format: "esm" },
    },
  },
});

await import(pathToFileURL(path.join(root, outDir, "check.mjs")).href);
