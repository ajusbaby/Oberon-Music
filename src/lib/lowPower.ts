// 低功耗模式的"白天 / 夜间"外观开关。
//
// 为什么单独一个模块：这个开关**只在低功耗模式下生效**（用户要求"低功耗独占"），
// 与默认（非低功耗）那套浅色主题互不影响 —— 默认主题不跟随它，也不跟随系统。
//
// 三种取值：
//   system（默认）—— 跟随系统：WebView2 的 prefers-color-scheme，即 Windows「应用模式」
//   light        —— 白天：整应用浅色（低功耗原本的样子）
//   dark         —— 夜间：整应用深色实底（见 views.css 的 .app-shell.low-power.theme-dark）
import { useEffect, useState } from "react";

export const LP_THEME_KEY = "lowPowerTheme";

export type LpTheme = "system" | "light" | "dark";

export const LP_THEME_OPTIONS: { value: LpTheme; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "白天" },
  { value: "dark", label: "夜间" },
];

export function parseLpTheme(raw: string | undefined): LpTheme {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function readLpTheme(values: Record<string, string | undefined>): LpTheme {
  return parseLpTheme(values[LP_THEME_KEY]);
}

/** 这套取值在当前系统下是否应该渲染成深色 */
export function lpIsDark(theme: LpTheme, systemDark: boolean): boolean {
  return theme === "dark" || (theme === "system" && systemDark);
}

/** 订阅系统的深浅色（Windows「应用模式」变化时实时更新） */
export function useSystemDark(): boolean {
  const query = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  const [dark, setDark] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = () => setDark(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}
