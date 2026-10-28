import React from "react";
import { fetchRecords, fetchSummary } from "./api.js";
import { formatCount, formatMs, formatTps, toCsv } from "./format.js";
import { RECORD_COLUMNS, RecordsTable } from "./RecordsTable.js";
import { ensureStyles } from "./styles.js";
import type { RequestRow, Summary } from "./types.js";

/**
 * 请求记录弹层 —— **按原型 `docs/prototype/ui-prototype.html` 视图 ② 实现**。
 *
 * 结构与原型逐节对齐：sheet-head（标题 + 导出/刷新）→ filters（三个下拉 + 条数）
 * → stat-row（五格统计）→ table-wrap（十列表）→ note（口径说明）。
 *
 * 设计要求（用户原话「弹层全部显示」）：
 * 不占常驻宽度、不裁剪、不分页 —— 靠表格自身滚动。
 * 关闭方式：右上角 ×、Esc、点遮罩。
 */

const h = React.createElement;

type RangeKey = "" | "24" | "168" | "720";

const RANGES: { value: RangeKey; label: string }[] = [
  { value: "", label: "全部时间" },
  { value: "24", label: "最近 24 小时" },
  { value: "168", label: "最近 7 天" },
  { value: "720", label: "最近 30 天" },
];

export function RecordsModal(props: { onClose: () => void }): React.ReactElement {
  ensureStyles();

  const [summary, setSummary] = React.useState<Summary | undefined>(undefined);
  const [rows, setRows] = React.useState<RequestRow[]>([]);
  const [models, setModels] = React.useState<string[]>([]);
  const [channel, setChannel] = React.useState("");
  const [model, setModel] = React.useState("");
  const [range, setRange] = React.useState<RangeKey>("");
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState(true);

  // Esc 关闭。绑在 document 上，因为焦点可能在弹层内任意位置。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextSummary, records] = await Promise.all([
        fetchSummary(),
        fetchRecords({
          limit: 2000,
          channel,
          model,
          ...(range === "" ? {} : { hours: Number(range) }),
        }),
      ]);
      setSummary(nextSummary);
      setRows(records.requests);
      setModels(records.models);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [channel, model, range]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = () => {
    const csv = toCsv(
      rows as unknown as Record<string, unknown>[],
      RECORD_COLUMNS.map((c) => ({ key: c.key, label: c.label })),
    );
    // 加 BOM，Excel 才认 UTF-8 中文
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `dsh-model-hub-records-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const select = (
    key: string,
    value: string,
    onChange: (next: string) => void,
    options: { value: string; label: string }[],
  ) =>
    h(
      "select",
      {
        key,
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
      },
      options.map((option) => h("option", { key: option.value, value: option.value }, option.label)),
    );

  const statCell = (label: string, value: string, unit?: string) =>
    h(
      "div",
      { className: "dmh-stat", key: label },
      h("div", { className: "dmh-stat-k" }, label),
      h("div", { className: "dmh-stat-v" }, value, unit === undefined ? null : h("small", null, unit)),
    );

  // 渠道下拉的选项从当前行里归纳（没有单独的渠道接口带全量列表）
  const channelOptions = React.useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) seen.add(row.channel_id);
    return [{ value: "", label: "全部渠道" }, ...[...seen].map((id) => ({ value: id, label: id }))];
  }, [rows]);

  return h(
    "div",
    {
      className: "dmh-overlay",
      onClick: (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) props.onClose();
      },
    },
    h(
      "div",
      { className: "dmh-scope dmh-overlay-body" },
      h(
        "div",
        { className: "dmh-sheet", role: "dialog", "aria-modal": true, "aria-label": "请求记录" },
        // ── 标题行 ──
        h(
          "div",
          { className: "dmh-sheet-head" },
          h(
            "div",
            null,
            h("div", { className: "dmh-card-title" }, "请求记录"),
            h("div", { className: "dmh-card-desc" }, "每一行是一次真实的模型调用"),
          ),
          h(
            "div",
            { style: { display: "flex", gap: 6 } },
            h("button", { className: "dmh-btn", onClick: exportCsv, disabled: rows.length === 0 }, "导出 CSV"),
            h("button", { className: "dmh-btn", onClick: () => void load() }, "刷新"),
            h("button", { className: "dmh-btn", onClick: props.onClose, "aria-label": "关闭" }, "×"),
          ),
        ),

        // ── 筛选 ──
        h(
          "div",
          { className: "dmh-filters" },
          select("channel", channel, setChannel, channelOptions),
          select("model", model, setModel, [
            { value: "", label: "全部模型" },
            ...models.map((id) => ({ value: id, label: id })),
          ]),
          select(
            "range",
            range,
            (next) => setRange(next as RangeKey),
            RANGES.map((r) => ({ value: r.value, label: r.label })),
          ),
          h("span", { className: "dmh-spacer" }),
          h(
            "span",
            { style: { fontSize: 11, color: "var(--dmh-label-tertiary)" } },
            loading ? "读取中…" : `共 ${formatCount(rows.length)} 条`,
          ),
        ),

        // ── 统计条 ──
        h(
          "div",
          { className: "dmh-stat-row" },
          statCell("请求数", summary === undefined ? "—" : formatCount(summary.requests)),
          statCell("Tokens", summary === undefined ? "—" : formatCount(summary.tokens)),
          statCell("平均 TTFT", summary === undefined ? "—" : formatMs(summary.avgTtftMs)),
          statCell("平均速度", summary === undefined ? "—" : formatTps(summary.avgTps)),
          statCell("积分消耗", summary === undefined ? "—" : summary.costUnits.toFixed(2)),
        ),

        // ── 明细 ──
        h(
          "div",
          { className: "dmh-table-wrap" },
          error !== undefined
            ? h("div", { className: "dmh-errbox" }, `读取失败：${error}`)
            : h(RecordsTable, { rows }),
        ),

        // ── 口径说明（原型原文，别改：用户就是靠这段理解数字怎么来的） ──
        h(
          "div",
          { className: "dmh-note" },
          h("span", { className: "dmh-strong" }, "tok/s"),
          " = output tokens ÷ 解码时长（首 token 到达 → 流结束），不含 TTFT。",
          h("span", { className: "dmh-strong" }, "TTFT"),
          " 从请求到达 shim 算起，含建连。拿不到上游 usage 的行会在模型名后标 ",
          h("span", { className: "dmh-badge" }, "*"),
          " 并在 tok/s 列置灰。",
        ),
      ),
    ),
  );
}
