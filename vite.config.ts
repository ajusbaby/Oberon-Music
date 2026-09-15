import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Oberon — 前端构建配置（Tauri 2 + React + TS）
export default defineConfig(async () => ({
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
