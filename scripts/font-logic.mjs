// 歌词字体逻辑校验：先在内存里用 Vite 打包校验入口，再用真字体文件跑断言。
//
//   npm run check:font
//
// 覆盖三件事：① cmap 解析（拿仓库里的两个内置字体当真样本）
//             ② 语言判定（假名/谚文/简体特征字/和制汉字/同组翻译行）
//             ③ 字体栈（汉字不外借、本语言槽优先、整行回退、系统兜底链）
// 之所以要有它：这些规则在界面上很难一眼看出对错（"日文行被中文字体接管"就是这么漏过去的），
// 而它们全是纯函数，用真字体跑一遍最省事。
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

globalThis.__FONTS__ = {
  ephesis: fs.readFileSync(path.join(root, "src/assets/fonts/Ephesis-Regular.ttf")).buffer,
  mashan: fs.readFileSync(path.join(root, "src/assets/fonts/MaShanZheng-Regular.ttf")).buffer,
};

const mod = await import(pathToFileURL(path.join(root, outDir, "check.mjs")).href);
const fails = mod.run();
process.exit(fails ? 1 : 0);
