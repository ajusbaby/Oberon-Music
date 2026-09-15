// 播放模式：列表循环 → 单曲循环 → 随机 → 列表循环
// 按需求不再有「顺序播放」这一未选中态，默认就是列表循环（三态里总有一个是选中的）
import type { PlayMode } from "../api/types";

/** 默认播放模式 */
export const DEFAULT_PLAY_MODE: PlayMode = "loop-all";

export function nextMode(mode: PlayMode): PlayMode {
  if (mode === "loop-all") return "loop-one";
  if (mode === "loop-one") return "shuffle";
  return "loop-all"; // shuffle（以及历史遗留下来的 sequential）都回到列表循环
}

export function modeLabel(mode: PlayMode): string {
  if (mode === "loop-one") return "单曲循环";
  if (mode === "shuffle") return "随机播放";
  return "列表循环";
}

/** 按钮图标：随机模式显示随机图标，其余显示循环图标 */
export function modeIcon(mode: PlayMode): "shuffle" | "repeat" {
  return mode === "shuffle" ? "shuffle" : "repeat";
}
