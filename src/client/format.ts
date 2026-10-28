/**
 * 展示格式化。
 *
 * 全部是纯函数，独立可测 —— 面板里最容易出错的不是布局，是
 * 「null 显示成 0」这类静默错误（会把「没测到」说成「测到了 0」）。
 */

/** 数字缩写：1234 -> "1.2k"。null/undefined -> "—"。 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 毫秒。null -> "—"（不是 "0ms"）。 */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

/** 速度。null -> "—"。 */
export function formatTps(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} tok/s`;
}

/** 本地时间 HH:mm:ss。 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 本地日期 + 时间，CSV 与明细用。 */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * CSV 单元格转义。
 *
 * 三个必须处理的点：
 * 1. 含逗号/引号/换行 -> 整体加引号，内部引号翻倍（RFC 4180）
 * 2. 前导 `=` `+` `-` `@` -> 加一个 `'` 前缀，防 Excel 把内容当公式执行
 *    （记录里有 `error` 字段，是上游原文，完全可能以 `=` 开头）
 * 3. null -> 空字符串，而不是字面量 "null"
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** 把明细行转成 CSV 文本。列顺序与面板表格一致。 */
export function toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const header = columns.map((c) => csvCell(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(","));
  return [header, ...lines].join("\r\n");
}
