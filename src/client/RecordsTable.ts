import React from "react";
import { formatCount, formatClock, formatMs, formatTps } from "./format.js";
import type { RequestRow } from "./types.js";

/**
 * 记录明细表 —— **按原型视图 ② 的表实现**。
 *
 * 原型列（顺序不能变）：时间 / 渠道 / 模型 / in / out / cache / TTFT / tok/s / 耗时 / 状态。
 *
 * 设计要求「弹层全部显示，靠表格自身滚动，不做分页折叠」：
 * 所以这里不切片、不虚拟滚动 —— 2000 行的上限在 host 侧就卡住了
 * （`queryRequests` 的 limit 夹在 1..2000）。分页会让「一眼看全」落空。
 */

export const RECORD_COLUMNS = [
  { key: "created_at", label: "时间" },
  { key: "channel_id", label: "渠道" },
  { key: "account_id", label: "账号" },
  { key: "model", label: "模型" },
  { key: "input_tokens", label: "in" },
  { key: "output_tokens", label: "out" },
  { key: "cache_read", label: "cache" },
  { key: "first_token_ms", label: "TTFT" },
  { key: "decode_tps", label: "tok/s" },
  { key: "duration_ms", label: "耗时" },
  { key: "status_code", label: "状态" },
] as const;

/** 右对齐的数值列。 */
const NUMERIC = new Set(["input_tokens", "output_tokens", "cache_read", "first_token_ms", "decode_tps", "duration_ms"]);

/** 状态码 -> 原型里的徽标类：2xx 用 `dmh-free`（绿），其余用 `dmh-err`（红）。 */
function statusBadge(code: number | null): React.ReactElement {
  if (code === null) return React.createElement("span", { className: "dmh-badge" }, "—");
  const ok = code >= 200 && code < 300;
  return React.createElement("span", { className: `dmh-badge ${ok ? "dmh-free" : "dmh-err"}` }, String(code));
}

/** 渠道 id 缩短成原型那种 `WB-Global`。 */
function shortChannel(id: string): string {
  const tail = id.replace(/^hub-/, "");
  if (tail.startsWith("workbuddy")) return `WB-${tail.includes("cn") ? "CN" : "Global"}`;
  if (tail.startsWith("qoder")) return "Qoder";
  if (tail.startsWith("trae")) return "Trae";
  return tail;
}

export function RecordsTable(props: {
  rows: RequestRow[];
  /** 账号 id → 显示名（/channels 的 accounts）。缺省时回退 id 尾段。 */
  accounts?: Record<string, string>;
}): React.ReactElement {
  const { rows } = props;
  const accounts = props.accounts ?? {};
  const h = React.createElement;

  if (rows.length === 0) {
    return h("div", { className: "dmh-note" }, "还没有请求记录。用 hub- 渠道的模型发一条消息后，这里会出现明细。");
  }

  return h(
    "table",
    { className: "dmh-table" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        RECORD_COLUMNS.map((column) =>
          h("th", { key: column.key, className: NUMERIC.has(column.key) ? "dmh-num" : undefined }, column.label),
        ),
      ),
    ),
    h(
      "tbody",
      null,
      rows.map((row) =>
        h(
          "tr",
          { key: row.request_id },
          h("td", { className: "dmh-mono" }, formatClock(row.created_at)),
          h("td", null, shortChannel(row.channel_id)),
          // 账号列：显示名优先（多账号时一眼看出「谁用的」）；历史行无归属显示 —
          h(
            "td",
            { className: "dmh-mono" },
            row.account_id === null || row.account_id === ""
              ? "—"
              : accounts[row.account_id] ?? row.account_id.replace(/^hub-[a-z-]+:/, ""),
          ),
          // estimated 的记录要标出来 —— 那是字符数估算，不是上游真实计数
          h("td", null, row.estimated === 1 ? `${row.model} *` : row.model),
          h("td", { className: "dmh-num" }, formatCount(row.input_tokens)),
          h("td", { className: "dmh-num" }, formatCount(row.output_tokens)),
          h("td", { className: "dmh-num" }, formatCount(row.cache_read)),
          h("td", { className: "dmh-num" }, formatMs(row.first_token_ms)),
          h(
            "td",
            {
              className: `dmh-num dmh-tps${
                row.decode_tps === null ? " dmh-na" : row.decode_tps < 25 ? " dmh-slow" : ""
              }`,
            },
            formatTps(row.decode_tps),
          ),
          h("td", { className: "dmh-num" }, formatMs(row.duration_ms)),
          h("td", null, statusBadge(row.status_code)),
        ),
      ),
    ),
  );
}
