const pad2 = (value: number): string => value.toString().padStart(2, "0");

/** "2026-10-21" in local time — the key used by date-range filtering. */
export function localDateKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Loose YYYY-MM-DD check for the date-range inputs. */
export function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) && !Number.isNaN(new Date(`${value.trim()}T00:00:00`).getTime());
}

/** "10-21 14:32" in local time — the log table column. */
export function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "2026-10-21 14:32:05" in local time. */
export function formatFullTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)} 天前`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / (7 * 86_400))} 周前`;
  if (seconds < 365 * 86_400) return `${Math.floor(seconds / (30 * 86_400))} 个月前`;
  return `${Math.floor(seconds / (365 * 86_400))} 年前`;
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : path;
}
