import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import "./styles/design.css";
import "./styles/views.css";
import "./styles/lyrics.css";
import "./styles/splash.css";

// 最外层兜底：React 渲染期抛错时不会把整个 #root 清空成白屏
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary scope="app">
    <App />
  </ErrorBoundary>,
);
