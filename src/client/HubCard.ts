import React from "react";
import {
  fetchCatalog,
  fetchChannels,
  fetchDiag,
  fetchRecords,
  fetchSummary,
  hubApi,
  type DiagData,
  type OneClickReport,
} from "./api.js";
import { formatClock, formatCount, formatMs, formatTps } from "./format.js";
import { RecordsModal } from "./RecordsModal.js";
import { ensureStyles } from "./styles.js";
import type { AccountRow, CatalogEntry, ChannelRow, RequestRow, Summary } from "./types.js";
import { AddAccountModal } from "./AddAccountModal.js";

/**
 * 设置卡片 —— **按原型 `docs/prototype/ui-prototype.html` 视图 ① 实现**。
 *
 * 结构与原型逐节对齐（card-head / tabs / 四个 panel），类名走 `dmh-` 前缀，
 * 样式由 `styles.ts` 从原型整段搬来。这样"做出来的"与"设计稿"能一眼比对。
 *
 * 任务 10 之后，原型里的全部控件都已接到写路由（`src/routes/write.ts` 九条
 * POST）：一键认证、渠道/账号开关、测试、设为当前、删除、添加账号、记录管理。
 * 行级 busy 用单个 `busyId` 键位标记：**同一时刻只放行一个写操作**——
 * 不是做并发排队，而是让「按钮 disabled」成为对用户可见的串行承诺，
 * 也顺便挡住「操作进行中又点刷新」这类 load() 与写并发交错。
 */

const h = React.createElement;

type Tab = "accounts" | "channels" | "records" | "diag";

const TABS: { id: Tab; label: string }[] = [
  { id: "accounts", label: "账号" },
  { id: "channels", label: "渠道" },
  { id: "records", label: "记录" },
  { id: "diag", label: "诊断" },
];

/** 单账号测试结果的行内展示（meta 末尾追加），失败原文截 24 字防刷屏。 */
interface TestResult {
  ok: boolean;
  detail: string;
  ms: number;
}

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
  // ── 任务 10 ──
  const [busyId, setBusyId] = React.useState<string | undefined>(undefined);
  const [expandedChannel, setExpandedChannel] = React.useState<string | undefined>(undefined);
  const [authReport, setAuthReport] = React.useState<OneClickReport | undefined>(undefined);
  const [addModalFor, setAddModalFor] = React.useState<string | undefined>(undefined);
  const [testResults, setTestResults] = React.useState<Map<string, TestResult>>(new Map());
  const [modelsByChannel, setModelsByChannel] = React.useState<Record<string, CatalogEntry[]>>({});

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
      // 旧 host 不带 models_by_channel 键：当 `{}` 消费，展开行显示「目录为空」而不是崩
      setModelsByChannel(channelData.models_by_channel ?? {});
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

  /**
   * 写操作包装：设 busyId → 执行 → 成功后 load() 刷新（开关/删除/认证都会改
   * 数据面）→ 失败进 errbox。finally 保证 busy 必被清掉，按钮不会卡死。
   * fn 返回值不关心（写路由多数只回 {ok:true}），所以收 `Promise<unknown>`。
   */
  const run = (key: string, fn: () => Promise<unknown>) => async () => {
    setBusyId(key);
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  // 一键认证期间按钮文案要变「认证中…」。busyId 里已经有这个信息，不再单开一个布尔
  // （两份状态必然漂移）；「authBusy」就是 busyId === "auth"。
  const authBusy = busyId === "auth";
  // 任一写操作进行中就禁用全部写按钮：单 busyId 的串行承诺（见组件注释）。
  const someBusy = busyId !== undefined;

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
          h("button", { className: "dmh-btn dmh-sm", disabled: someBusy, onClick: () => setAddModalFor(channel.id) }, "+ 添加账号"),
        ),
      );
      for (const account of list) {
        // 熔断优先：冷却窗口内的账号就算 enabled 也不可用，状态点直接转 err
        const cooling = account.cooldown_until !== null && account.cooldown_until > Date.now();
        const state = cooling ? "err" : account.has_credential === 1 ? (account.enabled === 1 ? "ok" : "warn") : "off";
        const tested = testResults.get(account.id);
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
                  cooling ? `熔断中（至 ${formatClock(account.cooldown_until!)}）` : undefined,
                  account.last_error === null ? undefined : `上次失败：${account.last_error.slice(0, 24)}`,
                  account.last_ok_at === null
                    ? undefined
                    : `上次成功 ${new Date(account.last_ok_at).toLocaleTimeString("zh-CN")}`,
                  tested === undefined
                    ? undefined
                    : tested.ok
                      ? `✓ ${formatMs(tested.ms)}`
                      : `✗ ${tested.detail.slice(0, 24)}`,
                ]
                  .filter((x): x is string => typeof x === "string")
                  .join(" · "),
              ),
            ),
            h("button", {
              className: `dmh-switch${account.enabled === 1 ? " dmh-on" : ""}`,
              role: "switch",
              "aria-checked": account.enabled === 1,
              "aria-label": account.enabled === 1 ? "已启用" : "已禁用",
              disabled: someBusy,
              onClick: run(`sw:${account.id}`, () => hubApi.toggleAccount(account.id, account.enabled !== 1)),
            }),
            h("button", {
              className: "dmh-btn dmh-sm",
              disabled: someBusy,
              onClick: run(`test:${account.id}`, async () => {
                const result = await hubApi.testAccount(account.id);
                // 换新 Map：React 以引用比对 state，原地 set 不会触发重渲染
                setTestResults((prev) => new Map(prev).set(account.id, result));
              }),
            }, "测试"),
            // 「设为当前」只给非当前账号渲染——当前账号没有可切换的目标状态
            account.is_current === 1
              ? null
              : h("button", {
                  className: "dmh-btn dmh-sm",
                  disabled: someBusy,
                  onClick: run(`cur:${account.id}`, () => hubApi.makeCurrent(account.id)),
                }, "设为当前"),
            h("button", {
              className: "dmh-btn dmh-sm dmh-danger",
              disabled: someBusy,
              onClick: () => {
                // 确认放在 run 外面：取消时连 load() 都不该发生
                if (!window.confirm(`删除账号 ${account.display_name}？凭据文件不受影响`)) return;
                void run(`del:${account.id}`, () => hubApi.deleteAccount(account.id))();
              },
            }, "删除"),
          ),
        );
      }
    }
    return blocks;
  };

  const renderChannels = (): React.ReactNode => {
    if (channels.length === 0) return h("div", { className: "dmh-note" }, "还没有渠道。");
    const rows: React.ReactNode[] = [];
    for (const channel of channels) {
      rows.push(
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
            className: "dmh-btn dmh-sm",
            onClick: () => setExpandedChannel(expandedChannel === channel.id ? undefined : channel.id),
          }, expandedChannel === channel.id ? "收起 ▴" : "展开 ▾"),
          h("button", {
            className: `dmh-switch${channel.enabled === 1 ? " dmh-on" : ""}`,
            role: "switch",
            "aria-checked": channel.enabled === 1,
            "aria-label": channel.enabled === 1 ? "已启用" : "已禁用",
            disabled: someBusy,
            onClick: run(`channel:${channel.id}`, () => hubApi.toggleChannel(channel.id, channel.enabled !== 1)),
          }),
        ),
      );
      if (expandedChannel === channel.id) {
        const entries = modelsByChannel[channel.id] ?? [];
        rows.push(
          h(
            "div",
            { className: "dmh-models", key: `models-${channel.id}` },
            entries.length === 0
              ? h("div", { className: "dmh-models-line" }, "该渠道目录为空（shim 还没拉到模型）")
              : entries.map((entry) =>
                  h(
                    "div",
                    { className: "dmh-models-line", key: entry.id },
                    h("span", { className: "dmh-models-name" }, entry.name),
                    entry.creditMultiplier === undefined
                      ? null
                      : h("span", { className: "dmh-models-mult" }, `x${entry.creditMultiplier}`),
                    entry.promotionBadge === undefined ? null : h("span", { className: "dmh-badge" }, entry.promotionBadge),
                    entry.tierBadge === undefined ? null : h("span", { className: "dmh-badge" }, entry.tierBadge),
                  ),
                ),
          ),
        );
      }
    }
    rows.push(
      h(
        "div",
        { className: "dmh-note", key: "note" },
        "渠道开关关闭后，该渠道的模型从模型选择器里彻底消失（不是藏起来），凭据保留，随时可以重新打开。",
      ),
    );
    return rows;
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
        // 记录开关在宿主插件设置里，这里只读展示——关了就写明去哪改
        ["记录", diag?.recordEnabled === false ? "关（宿主插件设置里改）" : "开"],
      ].flatMap(([k, v]) => kvPair(k as string, v as string)),
    ),
    h(
      "div",
      { className: "dmh-row", key: "mgmt" },
      h(
        "div",
        { className: "dmh-row-main" },
        h("div", { className: "dmh-row-name" }, "记录管理"),
        h(
          "div",
          { className: "dmh-row-meta" },
          `保留天数 ${diag?.retentionDays ?? "—"} · 明细 ${
            diag === undefined ? "—" : `${formatCount(diag.recordCount)} 条`
          }`,
        ),
      ),
      h("button", {
        className: "dmh-btn dmh-sm",
        disabled: someBusy,
        onClick: run("prune", () => hubApi.pruneRecords()),
      }, "立即清理"),
      h("button", {
        className: "dmh-btn dmh-sm dmh-danger",
        disabled: someBusy,
        onClick: () => {
          // 清空是全表删除且不可恢复：两连问——先确认意图，再换一句话确认
          if (!window.confirm("确定清空全部记录？此操作不可恢复")) return;
          if (!window.confirm("再次确认：删除所有明细与聚合")) return;
          void run("clear", () => hubApi.clearRecords())();
        },
      }, "清空全部"),
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

  /** 一键认证的结果区（tabs 上方）：每渠道一行，带关闭按钮。 */
  const renderAuthReport = (): React.ReactNode => {
    if (authReport === undefined) return null;
    return h(
      "div",
      { className: "dmh-authbox", key: "authbox" },
      authReport.channels.map((line) => {
        const displayName = channels.find((c) => c.id === line.id)?.display_name ?? line.id;
        const missed = line.sources.filter((s) => s.status !== "ok").map((s) => `${s.source}：${s.detail}`);
        return h(
          "div",
          { className: "dmh-authline", key: line.id },
          h("span", { className: "dmh-authline-name" }, displayName),
          h("span", { className: `dmh-badge${line.status === "ok" ? " dmh-free" : line.status === "missing" ? " dmh-err" : ""}` }, line.status),
          h(
            "span",
            { className: "dmh-authline-detail" },
            `接管 ${line.accountsAdded} 个账号`,
            missed.length === 0 ? null : ` · ${missed.join(" · ")}`,
          ),
        );
      }),
      h(
        "div",
        { className: "dmh-authline-actions", key: "actions" },
        h("button", { className: "dmh-btn dmh-sm", onClick: () => setAuthReport(undefined), "aria-label": "关闭" }, "关闭"),
      ),
    );
  };

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
                disabled: someBusy,
                onClick: () => {
                  setLoading(true);
                  void load();
                },
              },
              "刷新",
            ),
            h(
              "button",
              {
                className: "dmh-btn dmh-primary",
                disabled: someBusy,
                onClick: run("auth", async () => setAuthReport(await hubApi.oneClickAuth())),
              },
              authBusy ? "认证中…" : "一键认证",
            ),
          ),
        ),
        renderAuthReport(),
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
          ? h("div", { className: "dmh-errbox" }, error)
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
    addModalFor !== undefined
      ? h(AddAccountModal, {
          channelId: addModalFor,
          kind: channels.find((c) => c.id === addModalFor)?.kind === "qoder" ? "qoder" : "workbuddy",
          onClose: () => setAddModalFor(undefined),
          onDone: () => {
            // 简报口径：成功 = 父组件刷新数据 + 关弹窗
            setAddModalFor(undefined);
            void load();
          },
        })
      : null,
  );
}
