// 渲染异常兜底：以前任何一处渲染抛错都会让整个 WebView 变成一片白（生产构建没有错误覆盖层，
// 只剩黑窗 + 没有任何提示），用户唯一的操作就是强杀进程。这里按"越靠近出故障的地方恢复越好"分三层：
//   scope="app"    外壳级：连侧栏/播放条都没了，给一张整屏卡片 +「重新加载」
//   scope="view"   视图级：出错的只是 main-content 里那页，侧栏和播放条继续可用，「回到首页」即可脱身
//   scope="silent" 覆盖层（歌词页）：兜底画面上没有位置放卡片，交给 onError 关掉覆盖层再 toast
import { Component, type ErrorInfo, type ReactNode } from "react";
import { nav } from "../stores/navStore";
import { toast } from "../stores/uiStore";

type Scope = "app" | "view" | "silent";

interface Props {
  children: ReactNode;
  scope: Scope;
  /** 值变化时自动清掉错误态（切视图 / 关歌词页后不该继续停在兜底画面上） */
  resetKey?: string | number;
  onError?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 生产构建里没有 devtools，只能靠这条日志（Tauri 会把它带到控制台/日志文件）
    console.error("[crash]", error, info.componentStack);
    toast("界面出错了：" + (error.message || String(error)), "error");
    this.props.onError?.();
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.scope === "silent") return null;

    const msg = (error.message || String(error)).slice(0, 400);
    const app = this.props.scope === "app";
    return (
      <div className={app ? "crash-screen" : "crash-inline"}>
        <div className="crash-title">{app ? "界面出错了" : "这一页出错了"}</div>
        <div className="crash-msg">{msg}</div>
        <div className="crash-actions">
          <button className="btn" onClick={this.retry}>
            重试
          </button>
          {app ? (
            <button className="btn crash-primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => {
                this.setState({ error: null });
                nav.home();
              }}
            >
              回到首页
            </button>
          )}
        </div>
      </div>
    );
  }
}
