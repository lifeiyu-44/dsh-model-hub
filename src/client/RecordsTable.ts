import React from "react";
import { formatCount, formatMs, formatTps, formatClock } from "./format.js";
import type { RequestRow } from "./types.js";

/**
 * 记录明细表。
 *
 * 设计要求：「弹层全部显示，靠表格自身滚动，不做分页折叠」。
 * 所以这里不切片、不虚拟滚动 —— 2000 行的上限在 host 侧就卡住了
 * （`queryRequests` 的 limit 夹在 1..2000），渲染 2000 个 <tr> 在现代浏览器里
 * 是可以接受的，而分页会让「一眼看全」这个需求落空。
 */

export const RECORD_COLUMNS = [
  { key: "created_at", label: "时间" },
  { key: "channel_id", label: "渠道" },
  { key: "model", label: "模型" },
  { key: "input_tokens", label: "in" },
  { key: "output_tokens", label: "out" },
  { key: "cache_read", label: "cache" },
  { key: "first_token_ms", label: "TTFT" },
  { key: "decode_tps", label: "tok/s" },
  { key: "duration_ms", label: "耗时" },
  { key: "status_code", label: "状态" },
] as const;

/** 状态码 -> 语义色。2xx 绿、4xx 黄、5xx 红、缺失灰。 */
export function statusTone(code: number | null): "ok" | "warn" | "bad" | "none" {
  if (code === null) return "none";
  if (code >= 200 && code < 300) return "ok";
  if (code >= 400 && code < 500) return "warn";
  if (code >= 500) return "bad";
  return "none";
}

const TONE_COLOR: Record<string, string> = {
  ok: "var(--dsh-color-success, #22c55e)",
  warn: "var(--dsh-color-warning, #f59e0b)",
  bad: "var(--dsh-color-danger, #ef4444)",
  none: "var(--dsh-color-text-tertiary, #9ca3af)",
};

export function RecordsTable(props: { rows: RequestRow[] }): React.ReactElement {
  const { rows } = props;

  if (rows.length === 0) {
    return React.createElement(
      "div",
      { style: { padding: "32px 0", textAlign: "center", color: "var(--dsh-color-text-tertiary, #9ca3af)" } },
      "还没有请求记录。用 hub- 渠道的模型发一条消息后，这里会出现明细。",
    );
  }

  const th = (label: string, align: "left" | "right" = "left") =>
    React.createElement(
      "th",
      {
        key: label,
        style: {
          position: "sticky" as const,
          top: 0,
          zIndex: 1,
          background: "var(--dsh-color-bg-elevated, #fff)",
          textAlign: align,
          padding: "8px 10px",
          fontWeight: 600,
          fontSize: 12,
          whiteSpace: "nowrap" as const,
          borderBottom: "1px solid var(--dsh-color-border, #e5e7eb)",
        },
      },
      label,
    );

  const td = (content: React.ReactNode, key: string, align: "left" | "right" = "left", extra?: React.CSSProperties) =>
    React.createElement(
      "td",
      {
        key,
        style: {
          padding: "6px 10px",
          textAlign: align,
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap" as const,
          borderBottom: "1px solid var(--dsh-color-border-subtle, #f3f4f6)",
          ...extra,
        },
      },
      content,
    );

  return React.createElement(
    "div",
    { style: { overflow: "auto", maxHeight: "52vh", border: "1px solid var(--dsh-color-border, #e5e7eb)", borderRadius: 8 } },
    React.createElement(
      "table",
      { style: { borderCollapse: "collapse" as const, width: "100%", fontSize: 12 } },
      React.createElement(
        "thead",
        null,
        React.createElement(
          "tr",
          null,
          RECORD_COLUMNS.map((column) =>
            th(column.label, ["input_tokens", "output_tokens", "cache_read", "first_token_ms", "decode_tps", "duration_ms"].includes(column.key) ? "right" : "left"),
          ),
        ),
      ),
      React.createElement(
        "tbody",
        null,
        rows.map((row) =>
          React.createElement(
            "tr",
            { key: row.request_id },
            td(formatClock(row.created_at), "t"),
            td(row.channel_id, "c", "left", { color: "var(--dsh-color-text-secondary, #6b7280)" }),
            td(
              // estimated 的记录要标出来 —— 那是字符数估算，不是上游真实计数
              row.estimated === 1 ? `${row.model} *` : row.model,
              "m",
              "left",
              row.estimated === 1 ? { fontStyle: "italic" } : undefined,
            ),
            td(formatCount(row.input_tokens), "in", "right"),
            td(formatCount(row.output_tokens), "out", "right"),
            td(formatCount(row.cache_read), "ca", "right"),
            td(formatMs(row.first_token_ms), "ttft", "right"),
            td(formatTps(row.decode_tps), "tps", "right"),
            td(formatMs(row.duration_ms), "dur", "right"),
            td(row.status_code === null ? "—" : String(row.status_code), "st", "left", {
              color: TONE_COLOR[statusTone(row.status_code)],
              fontWeight: 600,
            }),
          ),
        ),
      ),
    ),
  );
}
