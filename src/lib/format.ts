// 通用格式化工具

/** 时长：秒 → m:ss（超过 1 小时为 h:mm:ss），与设计稿 formatTime 一致 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
}

/** 总时长（统计用）：秒 → 「3 小时 24 分钟」 */
export function formatTotalDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return h + " 小时 " + m + " 分钟";
  if (m > 0) return m + " 分钟";
  return total + " 秒";
}

/** 文件体积 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return (i === 0 ? value.toFixed(0) : value.toFixed(1)) + " " + units[i];
}

/** 时间戳（毫秒）→ 2024/06/15 */
export function formatDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate());
}

/** 问候语（设计稿 updateGreeting 的同一规则） */
export function greeting(now: Date = new Date()): { title: string; sub: string } {
  const hour = now.getHours();
  let title = "Good Evening";
  if (hour >= 0 && hour < 6) title = "Good Night";
  else if (hour >= 6 && hour < 12) title = "Good Morning";
  else if (hour >= 12 && hour < 18) title = "Good Afternoon";
  return { title, sub: "Let\'s enjoy some music" };
}

/** 把任意 id 折叠为稳定的 0..n-1 下标（用于占位渐变配色） */
export function pickIndex(seed: number, count: number): number {
  if (count <= 0) return 0;
  const x = Math.abs(Math.trunc(seed)) % count;
  return x;
}

/** 数字安全化：null/NaN → 0 */
export function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}


/** 专辑名可能为空（标签缺失）：界面上统一显示为「未知专辑」 */
export function albumLabel(name: string | null | undefined): string {
  const v = (name ?? "").trim();
  return v.length > 0 ? v : "未知专辑";
}
