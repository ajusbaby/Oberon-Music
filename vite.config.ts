import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 应用版本号：构建时注入成字面量 __APP_VERSION__，供开屏的「每个版本只放一次」判断。
// （不在运行时读 package.json —— 那会把整个 package.json 打进产物。）
const pkgVersion: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version;

// Oberon — 前端构建配置（Tauri 2 + React + TS）
export default defineConfig(async () => ({
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    hmr: process.env.TAURI_DEV_HOST ? { protocol: "ws", host: process.env.TAURI_DEV_HOST, port: 1421 } : undefined,
    // .build 是本地临时目录（截图、无头浏览器配置等）。不忽略的话，里面被占用的文件
    // （例如 Edge profile 的 Cookies）会让 watcher 抛 EBUSY 并**直接终止 dev**。
    watch: { ignored: ["**/src-tauri/**", "**/.build/**"] },
  },
  build: { target: ["es2021", "chrome105", "safari13"], minify: "esbuild", sourcemap: false },
  envPrefix: ["VITE_", "TAURI_"],
}));
