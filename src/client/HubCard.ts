import React from "react";
import { fetchChannels, fetchRecords, fetchSummary } from "./api.js";
import { formatCount, formatMs, formatTps } from "./format.js";
import { RecordsModal } from "./RecordsModal.js";
import type { AccountRow, ChannelRow, RequestRow, Summary } from "./types.js";

/**
 * 设置卡片：账号 / 渠道 / 记录 / 诊断 四栏。
 *
 * 设计要求（§8.2）：两处入口都注册（`plugins.bundle.config` 与
 * `plugins.row.config`），哪个能显示就显示哪个 —— 不同入口的挂载点不同。
 * 注册失败必须 catch 住，不能影响 provider。
 */

const h = React.createElement;

type Tab = "accounts" | "channels" | "records" | "diag";

const TABS: { id: Tab; label: string }[] = [
  { id: "accounts", label: "账号" },
  { id: "channels", label: "渠道" },
  { id: "records", label: "记录" },
  { id: "diag", label: "诊断" },
];

function dot(ok: boolean): React.ReactElement {
  return h("span", {
    style: {
      display: "inline-block",
      width: 7,
      height: 7,
      borderRadius: "50%",
      marginRight: 6,
      background: ok ? "var(--dsh-color-success, #22c55e)" : "var(--dsh-color-text-tertiary, #9ca3af)",
    },
  });
}

function row(label: string, value: React.ReactNode): React.ReactElement {
  return h(
    "div",
    {
      key: label,
      style: {
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "5px 0",
        fontSize: 12,
        borderBottom: "1px solid var(--dsh-color-border-subtle, #f3f4f6)",
      },
    },
    h("span", { style: { color: "var(--dsh-color-text-secondary, #6b7280)" } }, label),
    h("span", { style: { fontVariantNumeric: "tabular-nums", textAlign: "right" as const } }, value),
  );
}

export function HubCard(): React.ReactElement {
  const [tab, setTab] = React.useState<Tab>("accounts");
  const [summary, setSummary] = React.useState<Summary | undefined>(undefined);
  const [channels, setChannels] = React.useState<ChannelRow[]>([]);
  const [accounts, setAccounts] = React.useState<AccountRow[]>([]);
  const [recent, setRecent] = React.useState<RequestRow[]>([]);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  const load = React.useCallback(async () => {
    try {
      const [nextSummary, channelData, records] = await Promise.all([
        fetchSummary(),
        fetchChannels(),
        fetchRecords({ limit: 4 }),
      ]);
      setSummary(nextSummary);
      setChannels(channelData.channels);
      setAccounts(channelData.accounts);
      setRecent(records.requests);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const body = () => {
    if (error !== undefined) {
      return h(
        "div",
        { style: { fontSize: 12, padding: "8px 10px", borderRadius: 6, background: "var(--dsh-color-danger-bg, #fef2f2)", color: "var(--dsh-color-danger, #b91c1c)" } },
        `读取失败：${error}`,
      );
    }

    if (tab === "accounts") {
      if (accounts.length === 0) {
        return h(
          "div",
          { style: { fontSize: 12, color: "var(--dsh-color-text-tertiary, #9ca3af)", padding: "12px 0" } },
          "还没有账号记录。当前凭据直接从 WorkBuddy vault 复用（只读），账号管理在 P1 实现。",
        );
      }
      return accounts.map((account) =>
        h(
          "div",
          { key: account.id, style: { padding: "6px 0", borderBottom: "1px solid var(--dsh-color-border-subtle, #f3f4f6)" } },
          h("div", { style: { fontSize: 12, fontWeight: 600 } }, dot(account.enabled === 1), account.display_name),
          h(
            "div",
            { style: { fontSize: 11, color: "var(--dsh-color-text-tertiary, #9ca3af)", paddingLeft: 13 } },
            `${account.channel_id} · ${account.has_credential === 1 ? "有凭据" : "缺凭据"}`,
          ),
        ),
      );
    }

    if (tab === "channels") {
      if (channels.length === 0) {
        return h(
          "div",
          { style: { fontSize: 12, color: "var(--dsh-color-text-tertiary, #9ca3af)", padding: "12px 0" } },
          "还没有渠道。",
        );
      }
      return channels.map((channel) =>
        h(
          "div",
          { key: channel.id, style: { padding: "6px 0", borderBottom: "1px solid var(--dsh-color-border-subtle, #f3f4f6)" } },
          h("div", { style: { fontSize: 12, fontWeight: 600 } }, dot(channel.enabled === 1), channel.display_name),
          h(
            "div",
            { style: { fontSize: 11, color: "var(--dsh-color-text-tertiary, #9ca3af)", paddingLeft: 13 } },
            `今日 ${formatCount(channel.today_requests)} 次 · ${formatCount(channel.today_tokens)} tokens`,
          ),
        ),
      );
    }

    if (tab === "records") {
      return [
        h(
          "div",
          { key: "summary", style: { display: "flex", gap: 18, flexWrap: "wrap" as const, paddingBottom: 8 } },
          h("span", { style: { fontSize: 12 } }, `今日 ${summary === undefined ? "—" : formatCount(summary.requests)} 次`),
          h("span", { style: { fontSize: 12 } }, `TTFT ${summary === undefined ? "—" : formatMs(summary.avgTtftMs)}`),
          h("span", { style: { fontSize: 12 } }, `速度 ${summary === undefined ? "—" : formatTps(summary.avgTps)}`),
        ),
        ...recent.map((record) =>
          h(
            "div",
            {
              key: record.request_id,
              style: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, padding: "3px 0", color: "var(--dsh-color-text-secondary, #6b7280)" },
            },
            h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const } }, record.model),
            h("span", { style: { fontVariantNumeric: "tabular-nums" } }, `${formatMs(record.first_token_ms)} · ${formatTps(record.decode_tps)}`),
          ),
        ),
        h(
          "button",
          {
            key: "all",
            onClick: () => setModalOpen(true),
            style: {
              marginTop: 8,
              fontSize: 12,
              padding: "5px 12px",
              borderRadius: 6,
              border: "1px solid var(--dsh-color-border, #e5e7eb)",
              background: "transparent",
              cursor: "pointer",
              color: "inherit",
              alignSelf: "flex-start",
            },
          },
          "查看全部",
        ),
      ];
    }

    // 诊断：只读事实，不翻译不概括（错误原文照登）
    return [
      row("provider", "hub-workbuddy-global"),
      row("数据目录", "~/.dsh/model-hub/"),
      row("凭据来源", "WorkBuddy vault（只读复用）"),
      row("渠道数", String(channels.length)),
      row("账号数", String(accounts.length)),
      row("今日请求", summary === undefined ? "—" : formatCount(summary.requests)),
      ...(summary === undefined
        ? []
        : [row("今日 tokens", formatCount(summary.tokens)), row("今日积分", summary.costUnits.toFixed(2))]),
    ];
  };

  return h(
    React.Fragment,
    null,
    h(
      "div",
      { style: { display: "flex", flexDirection: "column" as const, gap: 10, padding: "4px 0", minWidth: 320 } },

      // 标题
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
        h("strong", { style: { fontSize: 13 } }, "DSH Model Hub"),
        h(
          "button",
          {
            onClick: () => void load(),
            style: { fontSize: 11, padding: "2px 8px", borderRadius: 5, border: "1px solid var(--dsh-color-border, #e5e7eb)", background: "transparent", cursor: "pointer", color: "var(--dsh-color-text-secondary, #6b7280)" },
          },
          "刷新",
        ),
      ),

      // Tab 栏
      h(
        "div",
        { style: { display: "flex", gap: 2, borderBottom: "1px solid var(--dsh-color-border, #e5e7eb)" } },
        TABS.map((entry) =>
          h(
            "button",
            {
              key: entry.id,
              onClick: () => setTab(entry.id),
              "aria-selected": tab === entry.id,
              style: {
                fontSize: 12,
                padding: "6px 12px",
                border: "none",
                borderBottom: tab === entry.id ? "2px solid var(--dsh-color-accent, #3b82f6)" : "2px solid transparent",
                background: "transparent",
                cursor: "pointer",
                color: tab === entry.id ? "inherit" : "var(--dsh-color-text-tertiary, #9ca3af)",
                fontWeight: tab === entry.id ? 600 : 400,
              },
            },
            entry.label,
          ),
        ),
      ),

      // 内容
      h("div", { style: { display: "flex", flexDirection: "column" as const, gap: 2, minHeight: 96 } }, body()),
    ),

    modalOpen ? h(RecordsModal, { onClose: () => setModalOpen(false) }) : null,
  );
}
