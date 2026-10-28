import React from "react";
import { fetchRecords, fetchSummary } from "./api.js";
import { formatCount, formatMs, formatTps, toCsv } from "./format.js";
import { RECORD_COLUMNS, RecordsTable } from "./RecordsTable.js";
import type { RequestRow, Summary } from "./types.js";

/**
 * 请求记录弹层。
 *
 * 规格（设计文档 §8.3）：
 * - **不占常驻宽度，不裁剪，全部显示** —— 靠表格自身滚动，不做分页折叠
 * - 遮罩 + 居中卡片（max-width 960 / max-height 80vh）
 * - 统计条 + 筛选 + 完整明细 + 导出 CSV
 * - 关闭：右上角 ×、Esc、点遮罩
 */

const h = React.createElement;

export function RecordsModal(props: { onClose: () => void }): React.ReactElement {
  const [summary, setSummary] = React.useState<Summary | undefined>(undefined);
  const [rows, setRows] = React.useState<RequestRow[]>([]);
  const [models, setModels] = React.useState<string[]>([]);
  const [channel, setChannel] = React.useState("");
  const [model, setModel] = React.useState("");
  const [hours, setHours] = React.useState("");
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
          ...(hours === "" ? {} : { hours: Number(hours) }),
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
  }, [channel, model, hours]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = () => {
    const csv = toCsv(rows as unknown as Record<string, unknown>[], RECORD_COLUMNS.map((c) => ({ key: c.key, label: c.label })));
    // 加 BOM，Excel 才认 UTF-8 中文
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `dsh-model-hub-records-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const stat = (label: string, value: string) =>
    h(
      "div",
      { style: { display: "flex", flexDirection: "column" as const, gap: 2, minWidth: 76 } },
      h("span", { style: { fontSize: 11, color: "var(--dsh-color-text-tertiary, #9ca3af)" } }, label),
      h("span", { style: { fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, value),
    );

  const select = (value: string, onChange: (v: string) => void, options: { value: string; label: string }[]) =>
    h(
      "select",
      {
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
        style: {
          fontSize: 12,
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid var(--dsh-color-border, #e5e7eb)",
          background: "var(--dsh-color-bg-elevated, #fff)",
          color: "inherit",
        },
      },
      options.map((option) => h("option", { key: option.value, value: option.value }, option.label)),
    );

  return h(
    "div",
    {
      // 遮罩。点它关闭 —— 但要点在遮罩本身，不能是冒泡上来的卡片点击。
      onClick: (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) props.onClose();
      },
      style: {
        position: "fixed" as const,
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      },
    },
    h(
      "div",
      {
        role: "dialog",
        "aria-modal": true,
        "aria-label": "请求记录",
        style: {
          width: "100%",
          maxWidth: 960,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column" as const,
          gap: 14,
          padding: 20,
          borderRadius: 12,
          background: "var(--dsh-color-bg-elevated, #fff)",
          color: "var(--dsh-color-text, #111827)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
          overflow: "hidden",
        },
      },

      // 标题行
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
        h("strong", { style: { fontSize: 15 } }, "请求记录"),
        h(
          "button",
          {
            onClick: props.onClose,
            "aria-label": "关闭",
            style: {
              border: "none",
              background: "transparent",
              fontSize: 20,
              lineHeight: 1,
              cursor: "pointer",
              color: "var(--dsh-color-text-secondary, #6b7280)",
              padding: "2px 6px",
            },
          },
          "×",
        ),
      ),

      // 统计条
      h(
        "div",
        { style: { display: "flex", gap: 22, flexWrap: "wrap" as const } },
        stat("请求数", summary === undefined ? "—" : formatCount(summary.requests)),
        stat("成功", summary === undefined ? "—" : formatCount(summary.ok)),
        stat("tokens", summary === undefined ? "—" : formatCount(summary.tokens)),
        stat("平均 TTFT", summary === undefined ? "—" : formatMs(summary.avgTtftMs)),
        stat("平均速度", summary === undefined ? "—" : formatTps(summary.avgTps)),
        stat("积分", summary === undefined ? "—" : summary.costUnits.toFixed(2)),
      ),

      // 筛选 + 导出
      h(
        "div",
        { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" as const } },
        select(channel, setChannel, [
          { value: "", label: "全部渠道" },
          { value: "hub-workbuddy-global", label: "WorkBuddy Global" },
        ]),
        select(model, setModel, [{ value: "", label: "全部模型" }, ...models.map((m) => ({ value: m, label: m }))]),
        select(hours, setHours, [
          { value: "", label: "全部时间" },
          { value: "1", label: "最近 1 小时" },
          { value: "24", label: "最近 24 小时" },
          { value: "168", label: "最近 7 天" },
        ]),
        h(
          "button",
          {
            onClick: () => void load(),
            style: {
              fontSize: 12,
              padding: "4px 12px",
              borderRadius: 6,
              border: "1px solid var(--dsh-color-border, #e5e7eb)",
              background: "transparent",
              cursor: "pointer",
              color: "inherit",
            },
          },
          "刷新",
        ),
        h("div", { style: { flex: 1 } }),
        h(
          "button",
          {
            onClick: exportCsv,
            disabled: rows.length === 0,
            style: {
              fontSize: 12,
              padding: "4px 12px",
              borderRadius: 6,
              border: "1px solid var(--dsh-color-border, #e5e7eb)",
              background: "transparent",
              cursor: rows.length === 0 ? "not-allowed" : "pointer",
              opacity: rows.length === 0 ? 0.5 : 1,
              color: "inherit",
            },
          },
          "导出 CSV",
        ),
      ),

      // 错误
      error === undefined
        ? null
        : h(
            "div",
            {
              style: {
                fontSize: 12,
                padding: "8px 10px",
                borderRadius: 6,
                background: "var(--dsh-color-danger-bg, #fef2f2)",
                color: "var(--dsh-color-danger, #b91c1c)",
              },
            },
            `读取记录失败：${error}`,
          ),

      // 表格（自身滚动）
      loading && rows.length === 0
        ? h("div", { style: { padding: 24, textAlign: "center" as const, color: "var(--dsh-color-text-tertiary, #9ca3af)" } }, "读取中…")
        : h(RecordsTable, { rows }),

      // 脚注
      h(
        "div",
        { style: { fontSize: 11, color: "var(--dsh-color-text-tertiary, #9ca3af)" } },
        `共 ${rows.length} 条` + (rows.some((r) => r.estimated === 1) ? " · 带 * 的是字符估算，非上游真实计数" : ""),
      ),
    ),
  );
}
