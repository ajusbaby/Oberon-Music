import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import "./styles/design.css";
import "./styles/views.css";
import "./styles/stats.css";
import "./styles/lyrics.css";
import "./styles/splash.css";

// WebView2 的默认上下文菜单（刷新 / 另存为 / 检查 …）是浏览器的东西，桌面播放器里
// 没有意义：右键歌词或空白处会弹出一整块浏览器菜单。这里统一拦掉。
// 输入类元素保留原生菜单，否则输入框里连复制粘贴都没有了；
// 需要自定义菜单的地方（曲目列表）照常用 React 的 onContextMenu，不受影响。
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && t.closest("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
});

// 最外层兜底：React 渲染期抛错时不会把整个 #root 清空成白屏
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary scope="app">
    <App />
  </ErrorBoundary>,
);
