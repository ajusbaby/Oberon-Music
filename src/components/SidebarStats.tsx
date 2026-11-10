// 侧栏底部的统计入口：与 Settings 完全同款的行按钮，只是图标和文案不同。
import { Icon } from "./Icon";
import { nav, useNavStore } from "../stores/navStore";

export function SidebarStats() {
  const view = useNavStore((s) => s.view);
  const active = view.name === "stats";

  return (
    <button
      type="button"
      className={"settings-btn side-stats" + (active ? " active" : "")}
      onClick={() => nav.stats()}
      aria-current={active ? "page" : undefined}
    >
      <Icon name="chart" />
      统计
    </button>
  );
}
