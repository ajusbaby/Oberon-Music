// 歌词字体逻辑校验：先在内存里用 Vite 打包校验入口，再跑断言。
//
//   npm run check:font
//
// 覆盖：① 槽定义与设置读取 ② 语言判定（假名/谚文/简体特征字/和制汉字/同组翻译行）
//       ③ 字体栈（每种语言只拿自己的系统链）④ 系统兜底链顺序
// 之所以要有它：这些规则在界面上很难一眼看出对错（"日文行被中文字体接管"就是这么漏过去的），
// 而它们全是纯函数，跑一遍最省事。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const root = process.cwd();
const outDir = ".build/font-logic";

await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: "scripts/font-logic.check.ts",
      output: { entryFileNames: "check.mjs", format: "esm" },
    },
  },
});

const mod = await import(pathToFileURL(path.join(root, outDir, "check.mjs")).href);
const fails = mod.run();
process.exit(fails ? 1 : 0);
