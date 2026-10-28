import React from "react";
import {
  fetchCatalog,
  fetchChannels,
  fetchDiag,
  fetchRecords,
  fetchSummary,
  type CatalogEntry,
  type DiagData,
} from "./api.js";
import { formatCount, formatMs, formatTps } from "./format.js";
import { RecordsModal } from "./RecordsModal.js";
import { ensureStyles } from "./styles.js";
import type { AccountRow, ChannelRow, RequestRow, Summary } from "./types.js";

/**
 * 设置卡片 —— **按原型 `docs/prototype/ui-prototype.html` 视图 ① 实现**。
 *
 * 结构与原型逐节对齐（card-head / tabs / 四个 panel），类名走 `dmh-` 前缀，
 * 样式由 `styles.ts` 从原型整段搬来。这样"做出来的"与"设计稿"能一眼比对。
 *
 * 一处刻意偏差：原型里的「一键认证」「+ 添加账号」「测试」「删除」**没有后端**，
 * 因为凭据是只读复用、账号增删要凭据生命周期管理（P1 还没做）。
 * 它们照原样渲染以保持视觉一致，但 `disabled` 且 `title` 写明原因 ——
 * 渲染一个点了没反应的按钮比不渲染更糟。
 */

const h = React.createElement;

type Tab = "accounts" | "channels" | "records" | "diag";

const TABS: { id: Tab; label: string }[] = [
  { id: "accounts", label: "账号" },
  { id: "channels", label: "渠道" },
  { id: "records", label: "记录" },
  { id: "diag", label: "诊断" },
];

const NOT_WIRED = "后端接口还没做，先占位";

function dot(state: "ok" | "err" | "warn" | "off"): React.ReactElement {
  return h("span", { className: `dmh-dot dmh-${state}` });
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatExpiry(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const date = new Date(ms);
  const days = Math.floor((ms - Date.now()) / 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
  return days >= 0 ? `${stamp}（剩余 ${days} 天）` : `${stamp}（已过期）`;
}

/** 诊断栏的一行：dt + dd 成对。 */
function kvPair(label: string, value: string): React.ReactNode[] {
  return [h("dt", { key: `k-${label}` }, label), h("dd", { key: `v-${label}` }, value)];
}

export function HubCard(): React.ReactElement {
  ensureStyles();

  const [tab, setTab] = React.useState<Tab>("accounts");
  const [summary, setSummary] = React.useState<Summary | undefined>(undefined);
  const [catalog, setCatalog] = React.useState<CatalogEntry[]>([]);
  const [channels, setChannels] = React.useState<ChannelRow[]>([]);
  const [accounts, setAccounts] = React.useState<AccountRow[]>([]);
  const [recent, setRecent] = React.useState<RequestRow[]>([]);
  const [diag, setDiag] = React.useState<DiagData | undefined>(undefined);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const [nextSummary, channelData, records, catalogData, diagData] = await Promise.all([
        fetchSummary(),
        fetchChannels(),
        fetchRecords({ limit: 4 }),
        fetchCatalog(),
        // `/diag` 是后加的接口。宿主还是旧版时它会 404，但**不能因此拖垮整个面板** ——
        // 账号/渠道/记录三栏的数据都在，只有诊断栏缺几行而已。
        // 所以单独兜住它：拿不到就当 undefined，诊断栏显示 `—`。
        fetchDiag().catch(() => undefined),
      ]);
      setSummary(nextSummary);
      setChannels(channelData.channels);
      setAccounts(channelData.accounts);
      setRecent(records.requests);
      setCatalog(catalogData.models);
      setDiag(diagData);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const accountsByChannel = new Map<string, AccountRow[]>();
  for (const account of accounts) {
    const list = accountsByChannel.get(account.channel_id) ?? [];
    list.push(account);
    accountsByChannel.set(account.channel_id, list);
  }

  const renderAccounts = (): React.ReactNode => {
    if (accounts.length === 0) {
      return h("div", { className: "dmh-note" }, "还没有账号记录。当前凭据从 WorkBuddy vault 只读复用。");
    }
    const blocks: React.ReactNode[] = [];
    for (const channel of channels) {
      const list = accountsByChannel.get(channel.id) ?? [];
      if (list.length === 0) continue;
      blocks.push(
        h(
          "div",
          { className: "dmh-row dmh-group", key: `g-${channel.id}` },
          h("div", { className: "dmh-row-main" }, h("span", { className: "dmh-row-meta" }, channel.display_name)),
          h("button", { className: "dmh-btn dmh-sm", disabled: true, title: NOT_WIRED }, "+ 添加账号"),
        ),
      );
      for (const account of list) {
        const state = account.has_credential === 1 ? (account.enabled === 1 ? "ok" : "warn") : "off";
        blocks.push(
          h(
            "div",
            { className: "dmh-row", key: account.id },
            dot(state),
            h(
              "div",
              { className: "dmh-row-main" },
              h(
                "div",
                { className: "dmh-row-name" },
                account.display_name,
                account.is_current === 1 ? h("span", { className: "dmh-badge dmh-cur" }, "当前") : null,
              ),
              h(
                "div",
                { className: "dmh-row-meta" },
                [
                  diag?.region === undefined || diag.region === null
                    ? undefined
                    : diag.region === "cn"
                      ? "国内版"
                      : "国际版",
                  account.has_credential === 1 ? "有凭据" : "缺凭据",
                  account.last_error === null ? undefined : `上次失败：${account.last_error.slice(0, 24)}`,
                  account.last_ok_at === null
                    ? undefined
                    : `上次成功 ${new Date(account.last_ok_at).toLocaleTimeString("zh-CN")}`,
                ]
                  .filter((x): x is string => typeof x === "string")
                  .join(" · "),
              ),
            ),
            h("button", {
              className: `dmh-sw${account.enabled === 1 ? " dmh-on" : ""}`,
              disabled: true,
              title: NOT_WIRED,
              "aria-label": account.enabled === 1 ? "已启用" : "已禁用",
            }),
            h("button", { className: "dmh-btn dmh-sm", disabled: true, title: NOT_WIRED }, "测试"),
            h("button", { className: "dmh-btn dmh-sm dmh-danger", disabled: true, title: NOT_WIRED }, "删除"),
          ),
        );
      }
    }
    return blocks;
  };

  const renderChannels = (): React.ReactNode => {
    if (channels.length === 0) return h("div", { className: "dmh-note" }, "还没有渠道。");
    return [
      ...channels.map((channel) =>
        h(
          "div",
          { className: "dmh-row", key: channel.id },
          h(
            "div",
            { className: "dmh-row-main" },
            h("div", { className: "dmh-row-name" }, channel.display_name),
            h(
              "div",
              { className: "dmh-row-meta" },
              `${channel.kind} · ${catalog.length} 个模型 · 今日 ${formatCount(
                channel.today_requests,
              )} 次 / ${formatCount(channel.today_tokens)} tokens`,
            ),
          ),
          h("button", {
            className: `dmh-sw${channel.enabled === 1 ? " dmh-on" : ""}`,
            disabled: true,
            title: NOT_WIRED,
            "aria-label": channel.enabled === 1 ? "已启用" : "已禁用",
          }),
        ),
      ),
      h(
        "div",
        { className: "dmh-note", key: "note" },
        "渠道开关关闭后，该渠道的模型从模型选择器里彻底消失（不是藏起来），凭据保留，随时可以重新打开。",
      ),
    ];
  };

  const renderRecords = (): React.ReactNode => [
    h(
      "div",
      { className: "dmh-row", key: "sum", style: { justifyContent: "space-between" } },
      h(
        "div",
        { className: "dmh-row-main" },
        h("div", { className: "dmh-row-name" }, "今日"),
        h(
          "div",
          { className: "dmh-row-meta" },
          `${summary === undefined ? "—" : formatCount(summary.requests)} 次请求 · ${
            summary === undefined ? "—" : formatCount(summary.tokens)
          } tokens · 平均 ${summary === undefined ? "—" : formatTps(summary.avgTps)}`,
        ),
      ),
      h("button", { className: "dmh-btn dmh-sm", onClick: () => setModalOpen(true) }, "查看全部 →"),
    ),
    h(
      "table",
      { className: "dmh-table", key: "table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "时间"),
          h("th", null, "模型"),
          h("th", { className: "dmh-num" }, "TTFT"),
          h("th", { className: "dmh-num" }, "tok/s"),
          h("th", { className: "dmh-num" }, "out"),
        ),
      ),
      h(
        "tbody",
        null,
        recent.length === 0
          ? h(
              "tr",
              null,
              h(
                "td",
                { colSpan: 5 },
                h("div", { className: "dmh-note" }, "还没有请求记录，用 hub- 渠道的模型发一条消息后出现明细。"),
              ),
            )
          : recent.map((record) =>
              h(
                "tr",
                { key: record.request_id },
                h("td", { className: "dmh-mono" }, new Date(record.created_at).toLocaleTimeString("zh-CN")),
                h("td", null, record.model),
                h("td", { className: "dmh-num" }, formatMs(record.first_token_ms)),
                h(
                  "td",
                  {
                    className: `dmh-num dmh-tps${
                      record.decode_tps === null ? " dmh-na" : record.decode_tps < 25 ? " dmh-slow" : ""
                    }`,
                  },
                  record.decode_tps === null ? "—" : record.decode_tps.toFixed(1),
                ),
                h("td", { className: "dmh-num" }, formatCount(record.output_tokens)),
              ),
            ),
      ),
    ),
    h("div", { className: "dmh-note", key: "note" }, "卡片里只放最近 4 条，完整记录点「查看全部」。"),
  ];

  const renderDiag = (): React.ReactNode => [
    h(
      "dl",
      { className: "dmh-kv", key: "kv" },
      [
        ["插件版本", diag?.pluginVersion ?? "—"],
        ["数据库", diag?.dbPath === undefined ? "—" : `${diag.dbPath}（WAL · ${formatBytes(diag.dbSizeBytes)}）`],
        ["记录数", diag === undefined ? "—" : `${formatCount(diag.recordCount)} 条`],
        ["当前渠道", diag?.currentChannelId ?? "—"],
        ["当前账号", diag?.currentAccountName ?? diag?.currentAccountId ?? "—"],
        ["凭据路径", diag?.credentialPath ?? "—"],
        ["Token 有效期", formatExpiry(diag?.tokenExpiresAt)],
        ["shim 地址", diag?.shimUrl ?? "—"],
        [
          "上游最近错误",
          diag?.lastError === null || diag?.lastError === undefined
            ? "（无）"
            : `${new Date(diag.lastError.at).toLocaleString("zh-CN")} · ${diag.lastError.model}`,
        ],
      ].flatMap(([k, v]) => kvPair(k as string, v as string)),
    ),
    h(
      "div",
      { className: "dmh-note", key: "note" },
      "上游最近一次错误的",
      h("span", { className: "dmh-strong" }, "原文"),
      "，不翻译不概括 —— 这一栏存在的唯一理由就是能被整段贴进问题反馈。",
    ),
    diag?.lastError === null || diag?.lastError === undefined
      ? h("div", { className: "dmh-note", key: "noerr" }, "目前没有失败记录。")
      : h("div", { className: "dmh-errbox", key: "err" }, `HTTP ${diag.lastError.status ?? "—"} · ${diag.lastError.error}`),
  ];

  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "dmh-scope" },
      h(
        "div",
        { className: "dmh-card" },
        h(
          "div",
          { className: "dmh-card-head" },
          h(
            "div",
            null,
            h("div", { className: "dmh-card-title" }, "Model Hub"),
            h("div", { className: "dmh-card-desc" }, "WorkBuddy 模型接入 DSH · 凭据只读复用"),
          ),
          h(
            "div",
            { style: { display: "flex", gap: 6 } },
            h(
              "button",
              {
                className: "dmh-btn",
                onClick: () => {
                  setLoading(true);
                  void load();
                },
              },
              "刷新",
            ),
            h("button", { className: "dmh-btn dmh-primary", disabled: true, title: NOT_WIRED }, "一键认证"),
          ),
        ),
        h(
          "div",
          { className: "dmh-tabs" },
          TABS.map((entry) =>
            h(
              "button",
              {
                key: entry.id,
                className: tab === entry.id ? "dmh-on" : undefined,
                onClick: () => setTab(entry.id),
                "aria-selected": tab === entry.id,
                role: "tab",
              },
              entry.label,
            ),
          ),
        ),
        error !== undefined
          ? h("div", { className: "dmh-errbox" }, `读取失败：${error}`)
          : loading
            ? h("div", { className: "dmh-note" }, "读取中…")
            : [
                h("div", { className: "dmh-panel", key: "p-acc", hidden: tab !== "accounts" }, renderAccounts()),
                h("div", { className: "dmh-panel", key: "p-ch", hidden: tab !== "channels" }, renderChannels()),
                h("div", { className: "dmh-panel", key: "p-rec", hidden: tab !== "records" }, renderRecords()),
                h("div", { className: "dmh-panel", key: "p-diag", hidden: tab !== "diag" }, renderDiag()),
              ],
      ),
    ),
    modalOpen ? h(RecordsModal, { onClose: () => setModalOpen(false) }) : null,
  );
}
