Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
let react = require("react");
react = __toESM(react, 1);
let react_dom_client = require("react-dom/client");
react_dom_client = __toESM(react_dom_client, 1);
// src/client/types.ts
/** 数据路由前缀，与 `src/routes/data.ts` 的 `DATA_PREFIX` 必须一致。 */
const DATA_PREFIX = "/plugins/dsh-model-hub";
// src/client/api.ts
/**
* 面板数据访问。
*
* 全部走插件自己的路由（`/plugins/dsh-model-hub/*`），而不是宿主的 RPC：
* 记录是我们自己的 SQLite，宿主不知道它的存在。宿主路由没有独立鉴权，
* 所以 host 侧自己加了回环校验（见 `src/routes/data.ts` / `write.ts`）。
*
* 读走 getJson；写走 postJson。两类响应的错误形状不同：
* - 只读门禁与写门禁：`{ error }`（data.ts / write.ts 的 writeGate）
* - 写分发失败：`{ ok: false, error }`（dispatchWrite）
* postJson 对两种形状都用 `doc?.error` 取文案，取不到再落到 HTTP 状态码。
*/
async function getJson(path) {
	const response = await fetch(path, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
	return await response.json();
}
function fetchSummary() {
	return getJson(`${DATA_PREFIX}/summary`);
}
/** 目录快照（模型 id -> 倍率与徽标）；条目形状见 types.ts 的 CatalogEntry。 */
function fetchCatalog() {
	return getJson(`${DATA_PREFIX}/catalog`);
}
function fetchDiag() {
	return getJson(`${DATA_PREFIX}/diag`);
}
function fetchChannels() {
	return getJson(`${DATA_PREFIX}/channels`);
}
function fetchRecords(query = {}) {
	const params = new URLSearchParams();
	if (query.limit !== void 0) params.set("limit", String(query.limit));
	if (query.channel !== void 0 && query.channel !== "") params.set("channel", query.channel);
	if (query.model !== void 0 && query.model !== "") params.set("model", query.model);
	if (query.hours !== void 0) params.set("hours", String(query.hours));
	const suffix = params.toString();
	return getJson(`${DATA_PREFIX}/records${suffix === "" ? "" : `?${suffix}`}`);
}
/**
* 写操作的公共出口。POST JSON + JSON accept（写门禁要求 content-type 含
* application/json）；非 2xx 一律抛 Error，文案优先取响应体里的 `error`
* （兜住 `{error}` 与 `{ok:false,error}` 两种形状），取不到再报 HTTP 状态码。
*/
async function postJson(path, body = {}) {
	const response = await fetch(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json"
		},
		body: JSON.stringify(body)
	});
	const doc = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(doc?.error ?? `${path} -> HTTP ${response.status}`);
	return doc;
}
/** 面板的全部改状态操作。id 会拼进路径，必须 encodeURIComponent（账号 id 含用户输入）。 */
const hubApi = {
	toggleChannel: (id, enabled) => postJson(`${DATA_PREFIX}/channel/${encodeURIComponent(id)}/toggle`, { enabled }),
	toggleAccount: (id, enabled) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/toggle`, { enabled }),
	testAccount: (id) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/test`),
	makeCurrent: (id) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/make-current`),
	deleteAccount: (id) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/delete`),
	addAccount: (body) => postJson(`${DATA_PREFIX}/accounts/add`, body),
	oneClickAuth: () => postJson(`${DATA_PREFIX}/auth/one-click`),
	pruneRecords: (days) => postJson(`${DATA_PREFIX}/records/prune`, days === void 0 ? {} : { days }),
	clearRecords: () => postJson(`${DATA_PREFIX}/records/clear`)
};
// src/client/format.ts
/**
* 展示格式化。
*
* 全部是纯函数，独立可测 —— 面板里最容易出错的不是布局，是
* 「null 显示成 0」这类静默错误（会把「没测到」说成「测到了 0」）。
*/
/** 数字缩写：1234 -> "1.2k"。null/undefined -> "—"。 */
function formatCount(value) {
	if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
	if (value < 1e3) return String(value);
	if (value < 1e6) return `${(value / 1e3).toFixed(1)}k`;
	return `${(value / 1e6).toFixed(1)}M`;
}
/** 毫秒。null -> "—"（不是 "0ms"）。 */
function formatMs(value) {
	if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
	if (value < 1e3) return `${Math.round(value)}ms`;
	return `${(value / 1e3).toFixed(2)}s`;
}
/** 速度。null -> "—"。 */
function formatTps(value) {
	if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
	return `${value.toFixed(1)} tok/s`;
}
/** 本地时间 HH:mm:ss。 */
function formatClock(ms) {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
function csvCell(value) {
	if (value === null || value === void 0) return "";
	let text = String(value);
	if (/^[=+\-@]/.test(text)) text = `'${text}`;
	if (/[",\r\n]/.test(text)) return `"${text.replaceAll("\"", "\"\"")}"`;
	return text;
}
/** 把明细行转成 CSV 文本。列顺序与面板表格一致。 */
function toCsv(rows, columns) {
	return [columns.map((c) => csvCell(c.label)).join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(","))].join("\r\n");
}
// src/client/RecordsTable.ts
/**
* 记录明细表 —— **按原型视图 ② 的表实现**。
*
* 原型列（顺序不能变）：时间 / 渠道 / 模型 / in / out / cache / TTFT / tok/s / 耗时 / 状态。
*
* 设计要求「弹层全部显示，靠表格自身滚动，不做分页折叠」：
* 所以这里不切片、不虚拟滚动 —— 2000 行的上限在 host 侧就卡住了
* （`queryRequests` 的 limit 夹在 1..2000）。分页会让「一眼看全」落空。
*/
const RECORD_COLUMNS = [
	{
		key: "created_at",
		label: "时间"
	},
	{
		key: "channel_id",
		label: "渠道"
	},
	{
		key: "account_id",
		label: "账号"
	},
	{
		key: "model",
		label: "模型"
	},
	{
		key: "input_tokens",
		label: "in"
	},
	{
		key: "output_tokens",
		label: "out"
	},
	{
		key: "cache_read",
		label: "cache"
	},
	{
		key: "first_token_ms",
		label: "TTFT"
	},
	{
		key: "decode_tps",
		label: "tok/s"
	},
	{
		key: "duration_ms",
		label: "耗时"
	},
	{
		key: "status_code",
		label: "状态"
	}
];
/** 右对齐的数值列。 */
const NUMERIC = /* @__PURE__ */ new Set([
	"input_tokens",
	"output_tokens",
	"cache_read",
	"first_token_ms",
	"decode_tps",
	"duration_ms"
]);
/** 状态码 -> 原型里的徽标类：2xx 用 `dmh-free`（绿），其余用 `dmh-err`（红）。 */
function statusBadge(code) {
	if (code === null) return react.default.createElement("span", { className: "dmh-badge" }, "—");
	const ok = code >= 200 && code < 300;
	return react.default.createElement("span", { className: `dmh-badge ${ok ? "dmh-free" : "dmh-err"}` }, String(code));
}
/** 渠道 id 缩短成原型那种 `WB-Global`。 */
function shortChannel(id) {
	const tail = id.replace(/^hub-/, "");
	if (tail.startsWith("workbuddy")) return `WB-${tail.includes("cn") ? "CN" : "Global"}`;
	if (tail.startsWith("qoder")) return "Qoder";
	if (tail.startsWith("trae")) return "Trae";
	return tail;
}
function RecordsTable(props) {
	const { rows } = props;
	const accounts = props.accounts ?? {};
	const h = react.default.createElement;
	if (rows.length === 0) return h("div", { className: "dmh-note" }, "还没有请求记录。用 hub- 渠道的模型发一条消息后，这里会出现明细。");
	return h("table", { className: "dmh-table" }, h("thead", null, h("tr", null, RECORD_COLUMNS.map((column) => h("th", {
		key: column.key,
		className: NUMERIC.has(column.key) ? "dmh-num" : void 0
	}, column.label)))), h("tbody", null, rows.map((row) => h("tr", { key: row.request_id }, h("td", { className: "dmh-mono" }, formatClock(row.created_at)), h("td", null, shortChannel(row.channel_id)), h("td", { className: "dmh-mono" }, row.account_id === null || row.account_id === "" ? "—" : accounts[row.account_id] ?? row.account_id.replace(/^hub-[a-z-]+:/, "")), h("td", null, row.estimated === 1 ? `${row.model} *` : row.model), h("td", { className: "dmh-num" }, formatCount(row.input_tokens)), h("td", { className: "dmh-num" }, formatCount(row.output_tokens)), h("td", { className: "dmh-num" }, formatCount(row.cache_read)), h("td", { className: "dmh-num" }, formatMs(row.first_token_ms)), h("td", { className: `dmh-num dmh-tps${row.decode_tps === null ? " dmh-na" : row.decode_tps < 25 ? " dmh-slow" : ""}` }, formatTps(row.decode_tps)), h("td", { className: "dmh-num" }, formatMs(row.duration_ms)), h("td", null, statusBadge(row.status_code))))));
}
// src/client/styles.ts
/**
* 面板样式 —— **黑金（深色）/ 香槟（浅色）双主题**。
*
* 为什么用注入而不是 CSS Module / 内联样式：
* 客户端插件是运行时加载的，宿主不处理我们的样式文件；一张 `<style>` + 语义
* class 最直接，也最好核对。
*
* 类名统一加 `dmh-` 前缀：宿主自己也在用 `.row` `.card` `.badge` `.stat`
* 这类通名，不加前缀会串到宿主的界面上。
*
* 主题策略（用户拍板 2026-10-29）：
*   · 深色 → 黑金：墨底 + 金线边框 + 金色主按钮/开关/选中态
*   · 浅色 → 香槟：米白底 + 深金棕文字 + 同一套金色边框
* 两套共用 `--dmh-gold-*` 刻度，只换语义令牌，所以品牌感一致而不互串。
* 深色由 `body[data-ds-dark-theme]`（宿主主题）或 `.dmh-scope[data-dmh-dark]`
* （强制）触发；不写死颜色，全部走变量。
*
* 排版：正文字体栈用 Segoe UI Variable Text → Noto Sans SC → 微软雅黑 UI
* （Win11 可变字体小字号 hinting 明显好于常规雅黑）；等宽用 Cascadia Mono。
* 字号分级 14 / 13.5 / 12.5 / 11.5 / 11 / 10.5，行高 1.6–1.85，
* 所有数字列 `tabular-nums` 对齐。
*/
const STYLE_ELEMENT_ID = "dsh-model-hub-styles";
const CSS = `
.dmh-scope{
  /* ── 金色刻度（两套主题共用）── */
  --dmh-gold-050:#FBF3DC; --dmh-gold-100:#F3E3B3; --dmh-gold-200:#E9D08A;
  --dmh-gold-300:#E3C46A; --dmh-gold-400:#D4AF37; --dmh-gold-500:#C9A227;
  --dmh-gold-600:#A8841C; --dmh-gold-700:#7A5F14;

  --dmh-font:"Segoe UI Variable Text","Segoe UI","Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  --dmh-font-mono:"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,monospace;

  /* ── 香槟（浅色，默认）── */
  --dmh-bg-base:#FDFBF6;
  --dmh-bg-layer-2:#FFFDF8;
  --dmh-bg-layer-3:#F7F1E4;
  --dmh-card-bg:linear-gradient(180deg,#FFFDF8 0%,#FAF5EA 100%);
  --dmh-card-inner:inset 0 1px 0 rgba(255,255,255,.85);
  --dmh-scrim:rgba(36,31,22,.38);

  --dmh-label-primary:#241F16;
  --dmh-label-secondary:#4A4237;
  --dmh-label-tertiary:#6E655A;
  --dmh-label-quaternary:#A39A8C;

  --dmh-border-l1:rgba(120,95,30,.10);
  --dmh-border-l2:rgba(120,95,30,.16);
  --dmh-border-l3:rgba(120,95,30,.24);
  --dmh-border-l4:rgba(120,95,30,.32);

  --dmh-gold-line:rgba(168,132,28,.28);
  --dmh-gold-line-strong:rgba(168,132,28,.50);
  --dmh-gold-wash:rgba(212,175,55,.12);
  --dmh-gold-wash-2:rgba(212,175,55,.22);
  --dmh-gold-text:#6B5310;
  --dmh-title-grad:linear-gradient(180deg,#8A6A16,#5E460D);

  --dmh-card-fill:#FFFDF8;
  --dmh-card-stroke:rgba(168,132,28,.30);
  --dmh-hover:rgba(212,175,55,.09);
  --dmh-selected:rgba(212,175,55,.22);
  --dmh-accent-text:#7A5F14;

  --dmh-success:#2E7D4F; --dmh-error:#B23A2A; --dmh-warn:#9A6B12;
  --dmh-danger-text:#B23A2A;
  --dmh-on-gold:#1A1508;

  color:var(--dmh-label-primary);
  font:13px/1.6 var(--dmh-font);
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}

body[data-ds-dark-theme] .dmh-scope,
.dmh-scope[data-dmh-dark]{
  /* ── 黑金（深色）── */
  --dmh-bg-base:#0E0E10;
  --dmh-bg-layer-2:#151517;
  --dmh-bg-layer-3:#1A1A1D;
  --dmh-card-bg:linear-gradient(180deg,#151517 0%,#101012 100%);
  --dmh-card-inner:inset 0 1px 0 rgba(251,243,220,.045);
  --dmh-scrim:rgba(4,4,5,.72);

  --dmh-label-primary:#EDE9E1;
  --dmh-label-secondary:#B6B0A5;
  --dmh-label-tertiary:#8A857C;
  --dmh-label-quaternary:#5E5A53;

  --dmh-border-l1:rgba(255,255,255,.055);
  --dmh-border-l2:rgba(255,255,255,.09);
  --dmh-border-l3:rgba(255,255,255,.14);
  --dmh-border-l4:rgba(255,255,255,.20);

  --dmh-gold-line:rgba(212,175,55,.20);
  --dmh-gold-line-strong:rgba(212,175,55,.38);
  --dmh-gold-wash:rgba(212,175,55,.08);
  --dmh-gold-wash-2:rgba(212,175,55,.14);
  --dmh-gold-text:#F3E3B3;
  --dmh-title-grad:linear-gradient(180deg,#F3E3B3,#D4AF37);

  --dmh-card-fill:#151517;
  --dmh-card-stroke:rgba(212,175,55,.20);
  --dmh-hover:rgba(212,175,55,.045);
  --dmh-selected:rgba(212,175,55,.14);
  --dmh-accent-text:#E9D08A;

  --dmh-success:#5CB47E; --dmh-error:#E06A5A; --dmh-warn:#D9A441;
  --dmh-danger-text:#F0938A;
  --dmh-on-gold:#1A1508;
}

.dmh-scope *{box-sizing:border-box;margin:0;padding:0}
.dmh-scope code{
  font-family:var(--dmh-font-mono);font-size:11px;padding:1.5px 6px;border-radius:5px;
  background:var(--dmh-gold-wash);border:1px solid var(--dmh-gold-line);
  color:var(--dmh-gold-text);white-space:nowrap;
}

/* ===== 卡片：金线外框 + 内高光 + 纵向渐变卡面 ===== */
.dmh-card{
  background:var(--dmh-card-bg);
  border:1px solid var(--dmh-card-stroke);
  border-radius:14px;overflow:hidden;
  box-shadow:var(--dmh-card-inner),0 24px 48px -32px rgba(0,0,0,.55);
}
.dmh-card-head{
  padding:15px 18px;border-bottom:1px solid var(--dmh-gold-line);
  display:flex;align-items:center;justify-content:space-between;gap:14px;
  background:linear-gradient(180deg,var(--dmh-gold-wash),transparent);
}
.dmh-card-title{
  font-size:14px;font-weight:600;letter-spacing:.01em;
  background:var(--dmh-title-grad);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  width:fit-content;
}
.dmh-card-desc{font-size:11.5px;color:var(--dmh-label-tertiary);margin-top:3px;line-height:1.55}

/* ===== tab：选中态金线 + 微光 ===== */
.dmh-tabs{
  display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--dmh-border-l1);
  background:var(--dmh-bg-layer-3);
}
.dmh-tabs button{
  font:inherit;font-size:12px;padding:10px 13px;border:0;background:none;cursor:pointer;
  color:var(--dmh-label-tertiary);border-bottom:2px solid transparent;margin-bottom:-1px;
  transition:color .14s,border-color .14s;
}
.dmh-tabs button:hover{color:var(--dmh-label-secondary)}
.dmh-tabs button.dmh-on{
  color:var(--dmh-gold-text);border-bottom-color:var(--dmh-gold-400);font-weight:600;
}
.dmh-panel{display:block;padding:4px 0}
.dmh-panel[hidden]{display:none}

/* ===== 行 ===== */
.dmh-row{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--dmh-border-l1)}
.dmh-row:last-child{border-bottom:0}
.dmh-row:hover{background:var(--dmh-hover)}
.dmh-row.dmh-group{
  background:var(--dmh-gold-wash);padding:8px 18px;
  border-bottom:1px solid var(--dmh-gold-line);
}
.dmh-row-main{flex:1;min-width:0}
.dmh-row-name{font-size:12.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;line-height:1.5}
.dmh-row-meta{
  font-size:11px;color:var(--dmh-label-tertiary);margin-top:3px;line-height:1.6;
  font-variant-numeric:tabular-nums;
}
.dmh-dot{width:6px;height:6px;border-radius:50%;flex:none}
.dmh-dot.dmh-ok{background:var(--dmh-success);box-shadow:0 0 8px -1px var(--dmh-success)}
.dmh-dot.dmh-err{background:var(--dmh-error);box-shadow:0 0 8px -1px var(--dmh-error)}
.dmh-dot.dmh-warn{background:var(--dmh-warn)}
.dmh-dot.dmh-off{background:var(--dmh-label-quaternary)}

/* ===== 按钮 ===== */
.dmh-btn{
  font:inherit;font-size:11.5px;padding:5px 11px;border-radius:7px;cursor:pointer;
  border:1px solid var(--dmh-border-l3);background:transparent;color:var(--dmh-label-secondary);
  white-space:nowrap;transition:border-color .14s,background .14s,color .14s;
}
.dmh-btn:hover{border-color:var(--dmh-gold-line-strong);color:var(--dmh-gold-text);background:var(--dmh-gold-wash)}
.dmh-btn:disabled{opacity:.45;cursor:not-allowed}
.dmh-btn.dmh-primary{
  background:linear-gradient(180deg,var(--dmh-gold-300),var(--dmh-gold-500));
  border-color:var(--dmh-gold-600);color:var(--dmh-on-gold);font-weight:600;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 4px 12px -6px rgba(212,175,55,.7);
}
.dmh-btn.dmh-primary:hover{filter:brightness(1.08);color:var(--dmh-on-gold)}
.dmh-btn.dmh-danger{color:var(--dmh-danger-text);border-color:color-mix(in srgb,var(--dmh-danger-text) 40%,transparent)}
.dmh-btn.dmh-danger:hover{
  background:color-mix(in srgb,var(--dmh-danger-text) 10%,transparent);
  border-color:color-mix(in srgb,var(--dmh-danger-text) 60%,transparent);
  color:var(--dmh-danger-text);
}
.dmh-btn.dmh-sm{padding:3px 8px;font-size:11px}
/* 「?」这类图标钮：正圆，比文字钮矮 */
.dmh-btn.dmh-icon{
  width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;
  border-radius:50%;font-size:12px;line-height:1;
}

/* ===== 徽标 ===== */
.dmh-badge{
  font-size:10.5px;padding:1.5px 7px;border-radius:5px;font-weight:500;
  background:var(--dmh-bg-layer-3);color:var(--dmh-label-secondary);
  border:1px solid var(--dmh-border-l1);line-height:1.5;
}
.dmh-badge.dmh-cur{
  background:var(--dmh-gold-wash-2);color:var(--dmh-gold-text);border-color:var(--dmh-gold-line-strong);
}
.dmh-badge.dmh-free{
  background:color-mix(in srgb,var(--dmh-success) 14%,transparent);
  color:var(--dmh-success);border-color:color-mix(in srgb,var(--dmh-success) 30%,transparent);
}
.dmh-badge.dmh-err{
  background:color-mix(in srgb,var(--dmh-error) 13%,transparent);
  color:var(--dmh-error);border-color:color-mix(in srgb,var(--dmh-error) 32%,transparent);
}

/* ===== 开关：开启 = 金色渐变 + 光晕，滑块转深墨 =====
 * 任务 10 起开关全部可点，类名 dmh-sw 改为 dmh-switch：hover 有反馈、checked
 * 是金色；不存在"永久禁用"态，:disabled 只在忙时出现（与 .dmh-btn:disabled
 * 同样的 opacity 反馈，忙时按钮变暗而开关全亮会显得不一致）。 */
.dmh-switch{
  width:32px;height:18px;border-radius:9px;background:var(--dmh-border-l4);
  position:relative;flex:none;cursor:pointer;border:1px solid var(--dmh-border-l1);
  padding:0;transition:background .16s,border-color .16s,box-shadow .16s;
}
.dmh-switch:hover{background:var(--dmh-gold-wash-2)}
.dmh-switch:focus-visible{outline:2px solid var(--dmh-accent-text);outline-offset:2px}
.dmh-switch.dmh-on{
  background:linear-gradient(180deg,var(--dmh-gold-400),var(--dmh-gold-600));
  border-color:var(--dmh-gold-600);
  box-shadow:0 0 12px -2px rgba(212,175,55,.55);
}
.dmh-switch.dmh-on:hover{filter:brightness(1.06)}
.dmh-switch::after{
  content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:#CFC9BF;transition:transform .16s,background .16s;
}
.dmh-switch.dmh-on::after{transform:translateX(14px);background:var(--dmh-on-gold)}
.dmh-switch:disabled{opacity:.45;cursor:wait}

/* ===== 表格 ===== */
.dmh-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.dmh-table th{
  text-align:left;font-size:10.5px;font-weight:500;color:var(--dmh-label-tertiary);
  letter-spacing:.04em;padding:9px 12px;border-bottom:1px solid var(--dmh-gold-line);
  white-space:nowrap;position:sticky;top:0;background:var(--dmh-bg-layer-2);
}
.dmh-table th.dmh-num,.dmh-table td.dmh-num{text-align:right}
.dmh-table td{
  padding:8px 12px;font-size:11.5px;border-bottom:1px solid var(--dmh-border-l1);
  white-space:nowrap;color:var(--dmh-label-secondary);
}
.dmh-table tbody tr:hover{background:var(--dmh-hover)}
.dmh-table td.dmh-mono{font-family:var(--dmh-font-mono);font-size:11px;color:var(--dmh-label-tertiary)}
.dmh-tps{color:var(--dmh-gold-text);font-weight:600}
.dmh-tps.dmh-slow{color:var(--dmh-warn)}
.dmh-tps.dmh-na{color:var(--dmh-label-tertiary);font-weight:400}

/* ===== 记录页 ===== */
.dmh-sheet{
  width:920px;max-width:100%;background:var(--dmh-card-bg);
  border:1px solid var(--dmh-card-stroke);border-radius:14px;overflow:hidden;
  box-shadow:var(--dmh-card-inner),0 32px 64px -24px rgba(0,0,0,.6);
}
.dmh-sheet-head{
  padding:16px 20px;border-bottom:1px solid var(--dmh-gold-line);
  display:flex;align-items:flex-start;justify-content:space-between;gap:14px;
  background:linear-gradient(180deg,var(--dmh-gold-wash),transparent);
}
.dmh-filters{
  display:flex;gap:6px;align-items:center;padding:11px 20px;
  border-bottom:1px solid var(--dmh-border-l1);flex-wrap:wrap;
}
.dmh-scope select{
  font:inherit;font-size:11.5px;padding:4px 8px;border-radius:6px;
  border:1px solid var(--dmh-border-l3);background:var(--dmh-card-fill);color:var(--dmh-label-primary);
}
.dmh-scope select:hover{border-color:var(--dmh-gold-line-strong)}
.dmh-scope select:focus-visible{outline:2px solid var(--dmh-accent-text);outline-offset:1px}
.dmh-stat-row{display:flex;border-bottom:1px solid var(--dmh-border-l1)}
.dmh-stat{flex:1;padding:13px 20px;border-right:1px solid var(--dmh-border-l1)}
.dmh-stat:last-child{border-right:0}
.dmh-stat-k{font-size:10.5px;color:var(--dmh-label-tertiary);margin-bottom:4px;letter-spacing:.02em}
.dmh-stat-v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.3px;line-height:1.3}
.dmh-stat-v small{font-size:11px;font-weight:400;color:var(--dmh-label-tertiary);margin-left:3px}
.dmh-table-wrap{max-height:340px;overflow:auto}

/* ===== 诊断 ===== */
.dmh-kv{display:grid;grid-template-columns:120px 1fr;font-size:11.5px}
.dmh-kv dt{
  padding:8px 18px;color:var(--dmh-label-tertiary);
  border-bottom:1px solid var(--dmh-border-l1);line-height:1.7;
}
.dmh-kv dd{
  padding:8px 18px;border-bottom:1px solid var(--dmh-border-l1);line-height:1.7;
  font-family:var(--dmh-font-mono);font-size:11px;word-break:break-all;color:var(--dmh-label-secondary);
}
.dmh-errbox{
  margin:11px 18px 15px;padding:10px 12px;border-radius:9px;font-size:11px;line-height:1.7;
  background:color-mix(in srgb,var(--dmh-error) 8%,transparent);
  border:1px solid color-mix(in srgb,var(--dmh-error) 26%,transparent);
  color:var(--dmh-label-secondary);font-family:var(--dmh-font-mono);
}
.dmh-note{font-size:11px;color:var(--dmh-label-tertiary);padding:11px 18px;line-height:1.7}
.dmh-strong{font-weight:600;color:var(--dmh-label-primary)}
.dmh-spacer{flex:1}

/* 弹层 */
.dmh-overlay{
  position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
  padding:24px;background:var(--dmh-scrim);backdrop-filter:blur(3px);
}
.dmh-overlay-body{max-height:84vh;overflow:auto;border-radius:14px}
/* 说明弹层自己管滚动（左目录 + 右正文），外层不能再滚一次 */
.dmh-overlay.dmh-overlay-help .dmh-overlay-body{overflow:hidden;display:flex}
.dmh-overlay.dmh-overlay-help .dmh-sheet{display:flex;flex-direction:column;max-height:84vh;width:860px}

/* ===== 渠道展开的模型列表 ===== */
.dmh-models{
  padding:7px 18px 11px 34px;             /* 相对行再缩进 16px，视觉上属于上一行渠道 */
  border-bottom:1px solid var(--dmh-border-l1);
  display:flex;flex-direction:column;gap:4px;background:var(--dmh-bg-layer-3);
}
.dmh-models-line{
  font-size:11px;color:var(--dmh-label-secondary);
  display:flex;align-items:center;gap:7px;flex-wrap:wrap;line-height:1.6;
}
.dmh-models-name{color:var(--dmh-label-primary)}
.dmh-models-mult{color:var(--dmh-label-tertiary);font-variant-numeric:tabular-nums}

/* ===== 添加账号弹窗的表单 ===== */
.dmh-sheet-sm{width:520px;max-width:100%}
.dmh-form{display:flex;flex-direction:column;gap:12px;padding:15px 20px 17px}
.dmh-form label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dmh-label-tertiary)}
.dmh-form textarea,.dmh-form input{
  font:inherit;font-size:11.5px;padding:8px 10px;border-radius:7px;
  border:1px solid var(--dmh-border-l3);background:var(--dmh-card-fill);color:var(--dmh-label-primary);
}
.dmh-form textarea{
  font-family:var(--dmh-font-mono);
  min-height:76px;                           /* 约 4 行等宽 */
  resize:vertical;word-break:break-all;
}
.dmh-form textarea:focus,.dmh-form input:focus{outline:2px solid var(--dmh-accent-text);outline-offset:-1px}
.dmh-form-hint{color:var(--dmh-danger-text)}
.dmh-form-actions{display:flex;justify-content:flex-end;gap:6px}

/* ===== 一键认证结果区（tabs 上方）===== */
.dmh-authbox{border-bottom:1px solid var(--dmh-gold-line);background:var(--dmh-gold-wash)}
.dmh-authline{display:flex;align-items:center;gap:8px;padding:8px 18px 0;font-size:11.5px;flex-wrap:wrap}
.dmh-authline-name{font-weight:600;color:var(--dmh-label-primary)}
.dmh-authline-detail{font-size:11px;color:var(--dmh-label-tertiary);word-break:break-all;line-height:1.6}
.dmh-authline-actions{display:flex;justify-content:flex-end;padding:7px 18px 9px}

/* ══════════ 「?」使用说明弹层：左目录 + 右正文 ══════════ */
.dmh-help{display:grid;grid-template-columns:176px 1fr;min-height:0;flex:1}
.dmh-help-nav{
  border-right:1px solid var(--dmh-border-l1);padding:14px 10px;
  background:var(--dmh-bg-layer-3);
  display:flex;flex-direction:column;gap:2px;overflow:auto;flex:none;
}
.dmh-help-nav button{
  font:inherit;font-size:11.5px;text-align:left;padding:7px 10px;border-radius:7px;border:0;
  background:none;color:var(--dmh-label-tertiary);cursor:pointer;line-height:1.45;
  transition:background .13s,color .13s;display:flex;gap:8px;align-items:baseline;
}
.dmh-help-nav button:hover{background:var(--dmh-hover);color:var(--dmh-label-secondary)}
.dmh-help-nav button.dmh-on{
  background:var(--dmh-gold-wash-2);color:var(--dmh-gold-text);font-weight:600;
}
.dmh-help-idx{
  font-family:var(--dmh-font-mono);font-size:10px;color:var(--dmh-gold-600);flex:none;
}
.dmh-help-nav button.dmh-on .dmh-help-idx{color:var(--dmh-gold-500)}

.dmh-help-body{padding:2px 26px 26px;overflow:auto;max-width:672px}
.dmh-help-sec{padding:20px 0 6px;border-top:1px solid var(--dmh-border-l1)}
.dmh-help-sec:first-child{border-top:0;padding-top:18px}
.dmh-help-sec-title{
  display:flex;align-items:center;gap:9px;font-size:13.5px;font-weight:600;
  color:var(--dmh-gold-text);letter-spacing:.01em;margin-bottom:11px;line-height:1.5;
}
.dmh-help-sec-title::before{
  content:"";width:3px;height:14px;border-radius:2px;flex:none;
  background:linear-gradient(180deg,var(--dmh-gold-300),var(--dmh-gold-600));
  box-shadow:0 0 10px -1px rgba(212,175,55,.6);
}
.dmh-help-lead{font-size:12.5px;line-height:1.85;color:var(--dmh-label-secondary);margin-bottom:12px}
.dmh-help-lead strong{color:var(--dmh-gold-text);font-weight:600}
.dmh-help-list{list-style:none;display:flex;flex-direction:column;gap:9px}
.dmh-help-list li{
  position:relative;padding-left:16px;font-size:12.5px;line-height:1.8;
  color:var(--dmh-label-secondary);
}
.dmh-help-list li::before{
  content:"";position:absolute;left:0;top:9px;width:5px;height:5px;border-radius:1.5px;
  background:var(--dmh-gold-500);transform:rotate(45deg);
}
.dmh-help-list li strong,.dmh-help-list li b{color:var(--dmh-label-primary);font-weight:600}
.dmh-help-kv{
  display:flex;flex-direction:column;gap:1px;border-radius:9px;overflow:hidden;
  border:1px solid var(--dmh-border-l1);margin-bottom:12px;
}
.dmh-help-kv div{
  display:grid;grid-template-columns:122px 1fr;gap:10px;padding:9px 12px;
  background:var(--dmh-gold-wash);font-size:11.5px;line-height:1.7;
}
.dmh-help-kv div:nth-child(even){background:transparent}
.dmh-help-kv dt{color:var(--dmh-label-tertiary)}
.dmh-help-kv dd{color:var(--dmh-label-secondary)}
.dmh-help-tip{
  display:flex;gap:9px;padding:10px 12px;border-radius:9px;margin-top:12px;
  font-size:11.5px;line-height:1.75;
  background:var(--dmh-gold-wash);border:1px solid var(--dmh-gold-line);
  color:var(--dmh-label-secondary);
}
.dmh-help-tip .dmh-help-mark{color:var(--dmh-gold-500);font-weight:700;flex:none}
.dmh-help-tip b{color:var(--dmh-label-primary);font-weight:600}
`;
/**
* 把样式表注入 `<head>`，返回「确保存在」的幂等函数。
*
* 幂等：弹层可能开多次、卡片可能同时挂在设置页，重复插入会产生多份
* 同 id 的 `<style>`。按 id 判重即可。
*/
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.getElementById("dsh-model-hub-styles") !== null) return;
	const style = document.createElement("style");
	style.id = STYLE_ELEMENT_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}
// src/client/RecordsModal.ts
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
const h$5 = react.default.createElement;
const RANGES = [
	{
		value: "",
		label: "全部时间"
	},
	{
		value: "24",
		label: "最近 24 小时"
	},
	{
		value: "168",
		label: "最近 7 天"
	},
	{
		value: "720",
		label: "最近 30 天"
	}
];
function RecordsModal(props) {
	ensureStyles();
	const [summary, setSummary] = react.default.useState(void 0);
	const [rows, setRows] = react.default.useState([]);
	const [models, setModels] = react.default.useState([]);
	const [channel, setChannel] = react.default.useState("");
	const [model, setModel] = react.default.useState("");
	const [range, setRange] = react.default.useState("");
	const [error, setError] = react.default.useState(void 0);
	const [loading, setLoading] = react.default.useState(true);
	/** 账号 id → 显示名（记录表的「账号」列）。取不到时按 id 尾段显示。 */
	const [accountNames, setAccountNames] = react.default.useState({});
	react.default.useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") props.onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [props.onClose]);
	const load = react.default.useCallback(async () => {
		setLoading(true);
		setError(void 0);
		try {
			const [nextSummary, records, channelData] = await Promise.all([
				fetchSummary(),
				fetchRecords({
					limit: 2e3,
					channel,
					model,
					...range === "" ? {} : { hours: Number(range) }
				}),
				fetchChannels().catch(() => void 0)
			]);
			setSummary(nextSummary);
			setRows(records.requests);
			setModels(records.models);
			if (channelData !== void 0) setAccountNames(Object.fromEntries(channelData.accounts.map((a) => [a.id, a.display_name])));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setLoading(false);
		}
	}, [
		channel,
		model,
		range
	]);
	react.default.useEffect(() => {
		load();
	}, [load]);
	const exportCsv = () => {
		const csv = toCsv(rows, RECORD_COLUMNS.map((c) => ({
			key: c.key,
			label: c.label
		})));
		const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `dsh-model-hub-records-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv`;
		link.click();
		URL.revokeObjectURL(url);
	};
	const select = (key, value, onChange, options) => h$5("select", {
		key,
		value,
		onChange: (event) => onChange(event.target.value)
	}, options.map((option) => h$5("option", {
		key: option.value,
		value: option.value
	}, option.label)));
	const statCell = (label, value, unit) => h$5("div", {
		className: "dmh-stat",
		key: label
	}, h$5("div", { className: "dmh-stat-k" }, label), h$5("div", { className: "dmh-stat-v" }, value, unit === void 0 ? null : h$5("small", null, unit)));
	const channelOptions = react.default.useMemo(() => {
		const seen = /* @__PURE__ */ new Set();
		for (const row of rows) seen.add(row.channel_id);
		return [{
			value: "",
			label: "全部渠道"
		}, ...[...seen].map((id) => ({
			value: id,
			label: id
		}))];
	}, [rows]);
	return h$5("div", {
		className: "dmh-overlay",
		onClick: (event) => {
			if (event.target === event.currentTarget) props.onClose();
		}
	}, h$5("div", { className: "dmh-scope dmh-overlay-body" }, h$5("div", {
		className: "dmh-sheet",
		role: "dialog",
		"aria-modal": true,
		"aria-label": "请求记录"
	}, h$5("div", { className: "dmh-sheet-head" }, h$5("div", null, h$5("div", { className: "dmh-card-title" }, "请求记录"), h$5("div", { className: "dmh-card-desc" }, "每一行是一次真实的模型调用")), h$5("div", { style: {
		display: "flex",
		gap: 6
	} }, h$5("button", {
		className: "dmh-btn",
		onClick: exportCsv,
		disabled: rows.length === 0
	}, "导出 CSV"), h$5("button", {
		className: "dmh-btn",
		onClick: () => void load()
	}, "刷新"), h$5("button", {
		className: "dmh-btn dmh-icon",
		onClick: props.onClose,
		"aria-label": "关闭"
	}, "×"))), h$5("div", { className: "dmh-filters" }, select("channel", channel, setChannel, channelOptions), select("model", model, setModel, [{
		value: "",
		label: "全部模型"
	}, ...models.map((id) => ({
		value: id,
		label: id
	}))]), select("range", range, (next) => setRange(next), RANGES.map((r) => ({
		value: r.value,
		label: r.label
	}))), h$5("span", { className: "dmh-spacer" }), h$5("span", { style: {
		fontSize: 11,
		color: "var(--dmh-label-tertiary)"
	} }, loading ? "读取中…" : `共 ${formatCount(rows.length)} 条`)), h$5("div", { className: "dmh-stat-row" }, statCell("请求数", summary === void 0 ? "—" : formatCount(summary.requests)), statCell("Tokens", summary === void 0 ? "—" : formatCount(summary.tokens)), statCell("平均 TTFT", summary === void 0 ? "—" : formatMs(summary.avgTtftMs)), statCell("平均速度", summary === void 0 ? "—" : formatTps(summary.avgTps)), statCell("积分消耗", summary === void 0 ? "—" : summary.costUnits.toFixed(2))), h$5("div", { className: "dmh-table-wrap" }, error !== void 0 ? h$5("div", { className: "dmh-errbox" }, `读取失败：${error}`) : h$5(RecordsTable, {
		rows,
		accounts: accountNames
	})), h$5("div", { className: "dmh-note" }, h$5("span", { className: "dmh-strong" }, "tok/s"), " = output tokens ÷ 解码时长（首 token 到达 → 流结束），不含 TTFT。", h$5("span", { className: "dmh-strong" }, "TTFT"), " 从请求到达 shim 算起，含建连。拿不到上游 usage 的行会在模型名后标 ", h$5("span", { className: "dmh-badge" }, "*"), " 并在 tok/s 列置灰。"))));
}
// src/client/HelpModal.ts
/**
* 面板内的「?」说明弹层 —— **左目录 + 右正文**双栏。
*
* 目的：不把使用说明锁在 README 里 —— 用户点面板上任何按钮前，都能在同一个
* 界面里查到「这是干什么的 / 凭据从哪来 / 多账号怎么加 / 出错看哪里」。
*
* 为什么双栏：六节单栏连排是一大段散文，找具体一节要滚到底。左目录常驻 +
* 右侧按节锚点跳转，长文也能一眼定位。目录项带 01–06 等宽序号，正文限制
* 672px 阅读宽度（超过这个宽度中文行会难跟读）。
*
* 结构沿用 RecordsModal 的 overlay/sheet 骨架（Esc / 遮罩 / × 关闭）。
* 三种正文块：lead 导语段、list 列表、kv 键值表 + tip 提示条（强调用）。
*/
const h$4 = react.default.createElement;
/**
* 说明正文。**与 README.md 同源**：改这里记得同步改 README，
* 反之亦然（两处都写给用户看，不能一处说一套）。
*/
const SECTIONS = [
	{
		title: "面板是什么",
		blocks: [{
			kind: "lead",
			text: "把本机 WorkBuddy（国际/国内）、Trae 与 Qoder CN 的模型接进 DSH 的模型选择器，模型 id 带 hub- 前缀。所有请求经插件自己的本机回环 shim 转发 —— 记录（token / TTFT / tok·s / 状态码）只在那一层埋点，所以只有走 hub- 模型的对话才会出现在这里。"
		}, {
			kind: "list",
			items: [
				"账号：增删启停、测试、切当前，并显示每个账号的今日消耗",
				"渠道：总开关 + 展开该渠道自己的模型清单（倍率、活动标记）",
				"记录：最近 4 条 + 「查看全部」弹层（筛选、统计、导出 CSV）",
				"诊断：凭据路径、token 有效期、上游错误原文、记录清理"
			]
		}]
	},
	{
		title: "凭据从哪来",
		blocks: [
			{
				kind: "lead",
				text: "全部只读复用，不向任何第三方服务器上传凭据。插件数据库只存凭据引用（文件路径），绝不存明文。"
			},
			{
				kind: "kv",
				rows: [
					["WorkBuddy 桌面端", "workbuddy-desktop-ai.info 的加密信封，用 App 自身 native binding 取密钥，在内存里解开"],
					["插件自有 token", "~/.dsh/model-hub/workbuddy-tokens/，每账号一文件，权限 0600"],
					["connect-workbuddy", "~/.dsh/workbuddy-vault/ 历史 vault，只读"],
					["Qoder PAT", "~/.dsh/qoder/pat、环境变量，或面板里贴的 PAT（存 model-hub/qoder-pats/，0600）"],
					["Trae 登录态", "本机 Trae 客户端的 storage.json（byteCrypto 信封，插件内置解密），或 ~/.dsh/connect-auth/trae.json 快照；解密后落 model-hub/trae-tokens/，0600"]
				]
			},
			{
				kind: "tip",
				text: "桌面端 auth 文件与 vault 永不回写；日志与报错统一隐去 token/PAT 全文（只留文件路径与前 6 位）。写接口要求本机回环 + Origin 规则 + JSON content-type + body ≤64KB。"
			}
		]
	},
	{
		title: "多账号怎么加",
		blocks: [{
			kind: "list",
			items: [
				"WorkBuddy：在桌面端换登另一个账号 → 点「一键认证」→ 解密验活后按账号 uid 自动新增一行；同一个账号重复认证只刷新那一行，不会重复出现",
				"Qoder：面板「+ 添加账号」贴 pt- 开头的 PAT，备注名留空就用 userinfo 真名做显示名",
				"Trae：在 Trae 桌面端登录好 → 面板「+ 添加账号」点「扫描本机 Trae 导入」（启动时也会自动接管一次）",
				"设为当前决定池头：请求优先用它；它失败（401/402/403/429）自动切池里下一个，连续 3 次失败熔断 10 分钟",
				"账号行 meta 里的「今日 N 次 · X tokens」是按账号统计的消耗，切换过账号也能分清是谁的"
			]
		}]
	},
	{
		title: "模型与档位",
		blocks: [{
			kind: "list",
			items: [
				"WorkBuddy 25 个模型统一声明支持思考档位（上游接受 reasoning_effort 参数，不支持的模型会忽略它）",
				"Qoder 按目录 is_reasoning 如实声明",
				"Trae 的 15 个模型统一声明思考档位：上游接受 reasoning_effort（low/medium/high/minimal/off/none 都回 200，不认的模型自己忽略），所以滑动变阻器在 Trae 模型上出滑块，选中的档位会原样透传给 Trae",
				"选中支持思考的模型后，输入框的模型选择器里出现「思考强度」（off/minimal/low/medium/high），且按模型记忆",
				"非 hub 模型（如 zai-coding-cn）是否有档位，取决于它自己的 provider 配置有没有声明 reasoningEfforts"
			]
		}]
	},
	{
		title: "记录与保留",
		blocks: [{
			kind: "list",
			items: [
				"每次上游尝试各记一行：故障切换时失败那次与成功那次都能看到，账号列各是各的",
				"tok/s = output tokens ÷ 解码时长（首 token 到达 → 流结束，不含 TTFT）；TTFT 从请求到达 shim 算起，含建连",
				"拿不到上游 usage 的行会标 * 并置灰，不当成 0 参与统计",
				"「立即清理」按保留天数删过期明细；「清空全部」连聚合一起清（两连确认）"
			]
		}, {
			kind: "tip",
			text: "明细保留天数来自插件设置 retentionDays（默认 90 天），聚合（每日统计）永久保留。明细上限 2000 行。"
		}]
	},
	{
		title: "出问题看哪里",
		blocks: [{
			kind: "kv",
			rows: [
				["诊断栏", "凭据路径、token 有效期、shim 地址、上游最近一次错误原文（不翻译不概括，方便整段贴给作者）"],
				["账号行", "熔断中（至 HH:mm）/ 上次失败原因 / 测试按钮的 ✓✗ 结论"],
				["状态文件", "%USERPROFILE%\\.dsh\\model-hub\\status.json（ok / modelCount / 失败原因）"],
				["写接口报错", "origin_not_allowed / host_not_allowed = 请求不是本机发起的；bad_request = 参数不对；payload_too_large = body 超 64KB"]
			]
		}]
	}
];
function HelpModal(props) {
	ensureStyles();
	/** 当前高亮的小节（点目录跳转时同步）。 */
	const [active, setActive] = react.default.useState(0);
	const bodyRef = react.default.useRef(null);
	/** 每节的 DOM 锚点，用于滚动定位。 */
	const secRefs = react.default.useRef([]);
	react.default.useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") props.onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [props.onClose]);
	/** 点目录：滚到该节（在正文容器内滚，不是整页滚）。 */
	const goto = (index) => {
		setActive(index);
		const target = secRefs.current[index];
		const body = bodyRef.current;
		if (target === void 0 || target === null || body === null) return;
		body.scrollTo({
			top: target.offsetTop - 8,
			behavior: "smooth"
		});
	};
	/** 手动滚动时反过来更新目录高亮：取「顶边已越过容器顶部」的最后一节。 */
	const onBodyScroll = () => {
		const body = bodyRef.current;
		if (body === null) return;
		let current = 0;
		secRefs.current.forEach((node, index) => {
			if (node !== void 0 && node !== null && node.offsetTop - body.scrollTop <= 24) current = index;
		});
		setActive(current);
	};
	const renderBlock = (block, key) => {
		switch (block.kind) {
			case "lead": return h$4("p", {
				className: "dmh-help-lead",
				key
			}, block.text);
			case "list": return h$4("ul", {
				className: "dmh-help-list",
				key
			}, block.items.map((item) => h$4("li", { key: item }, item)));
			case "kv": return h$4("div", {
				className: "dmh-help-kv",
				key
			}, block.rows.map(([k, v]) => h$4("div", { key: k }, h$4("dt", null, k), h$4("dd", null, v))));
			case "tip": return h$4("div", {
				className: "dmh-help-tip",
				key
			}, h$4("span", { className: "dmh-help-mark" }, "!"), h$4("span", null, block.text));
		}
	};
	return h$4("div", {
		className: "dmh-overlay dmh-overlay-help",
		onClick: (event) => {
			if (event.target === event.currentTarget) props.onClose();
		}
	}, h$4("div", { className: "dmh-scope dmh-overlay-body" }, h$4("div", {
		className: "dmh-sheet",
		role: "dialog",
		"aria-modal": true,
		"aria-label": "Model Hub 使用说明"
	}, h$4("div", { className: "dmh-sheet-head" }, h$4("div", null, h$4("div", { className: "dmh-card-title" }, "Model Hub 使用说明"), h$4("div", { className: "dmh-card-desc" }, "凭据只读复用 · 多账号池 · 请求记录")), h$4("button", {
		className: "dmh-btn dmh-icon",
		onClick: props.onClose,
		"aria-label": "关闭"
	}, "×")), h$4("div", { className: "dmh-help" }, h$4("div", {
		className: "dmh-help-nav",
		role: "tablist",
		"aria-label": "说明目录"
	}, SECTIONS.map((section, index) => h$4("button", {
		key: section.title,
		className: active === index ? "dmh-on" : void 0,
		onClick: () => goto(index),
		"aria-selected": active === index,
		role: "tab"
	}, h$4("span", { className: "dmh-help-idx" }, String(index + 1).padStart(2, "0")), h$4("span", null, section.title)))), h$4("div", {
		className: "dmh-help-body",
		ref: bodyRef,
		onScroll: onBodyScroll
	}, SECTIONS.map((section, index) => h$4("div", {
		className: "dmh-help-sec",
		key: section.title,
		ref: (node) => {
			secRefs.current[index] = node;
		}
	}, h$4("div", { className: "dmh-help-sec-title" }, section.title), section.blocks.map((block, i) => renderBlock(block, `${section.title}-${i}`)))))))));
}
// src/client/AddAccountModal.ts
/**
* 添加账号弹层。骨架与 `RecordsModal` 同构（overlay / sheet / Esc / 点遮罩关闭），
* 但只有一张小表单，所以 sheet 用窄档 `dmh-sheet-sm`。
*
* 两种形态（kind 由 HubCard 按渠道 kind 传入）：
* - workbuddy：无表单，一个「扫描 vault 导入」按钮 —— 凭据是只读复用，
*   导入动作只是把 vault 里已有的条目登记进账号表；成功后留在弹窗里展示
*   added 列表（扫出来什么一目了然），用户点「完成」才刷新并关闭。
* - qoder：贴 PAT + 可选备注名。PAT 先过前端格式门（pt- 前缀 + 至少 8 位），
*   不合规直接禁用提交 —— 免得把一眼就错的 token 打到上游验活。
*
* 错误一律显示在弹层内 errbox（不冒到卡片的全局 errbox，用户视线在弹层里）。
* 成功调 `onDone()`：父组件负责刷新数据并关闭本弹层。
*/
const h$3 = react.default.createElement;
const PAT_PATTERN = /^pt-[A-Za-z0-9_-]{8,}$/;
function AddAccountModal(props) {
	ensureStyles();
	const [pat, setPat] = react.default.useState("");
	const [displayName, setDisplayName] = react.default.useState("");
	const [busy, setBusy] = react.default.useState(false);
	const [error, setError] = react.default.useState(void 0);
	const [added, setAdded] = react.default.useState(void 0);
	react.default.useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") dismiss();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});
	const trimmedPat = pat.trim();
	const patValid = PAT_PATTERN.test(trimmedPat);
	/**
	* 关闭路径统一走这里：WB 扫描成功后，数据已经变了（账号表多了行），
	* 此时 Esc/×/点遮罩也必须让父组件刷新——否则新账号要到下次手动刷新才出现。
	* 没有发生过成功导入时，关闭就是纯取消，走 onClose。
	*/
	const dismiss = () => added !== void 0 ? props.onDone() : props.onClose();
	const submit = async () => {
		setBusy(true);
		setError(void 0);
		try {
			const doc = await hubApi.addAccount({
				channelId: props.channelId,
				...props.kind === "qoder" ? { pat: trimmedPat } : {},
				...props.kind === "qoder" && displayName.trim() !== "" ? { displayName: displayName.trim() } : {}
			});
			if ("added" in doc && Array.isArray(doc.added)) {
				if (props.kind !== "qoder") setAdded(doc.added);
				else {
					props.onDone();
					return;
				}
			} else setError("服务端没有返回新增账号列表");
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	};
	return h$3("div", {
		className: "dmh-overlay",
		onClick: (event) => {
			if (event.target === event.currentTarget) dismiss();
		}
	}, h$3("div", { className: "dmh-scope dmh-overlay-body" }, h$3("div", {
		className: "dmh-sheet dmh-sheet-sm",
		role: "dialog",
		"aria-modal": true,
		"aria-label": "添加账号"
	}, h$3("div", { className: "dmh-sheet-head" }, h$3("div", null, h$3("div", { className: "dmh-card-title" }, "添加账号"), h$3("div", { className: "dmh-card-desc" }, props.kind === "qoder" ? "粘贴 Qoder CN 的 Personal Access Token" : props.kind === "trae" ? "从本机 Trae 客户端导入登录态" : "从 WorkBuddy vault 只读导入已有凭据")), h$3("button", {
		className: "dmh-btn dmh-icon",
		onClick: dismiss,
		"aria-label": "关闭"
	}, "×")), props.kind !== "qoder" ? h$3("div", { className: "dmh-form" }, h$3("div", { className: "dmh-note" }, props.kind === "trae" ? "扫描本机 Trae 的登录态（解密它自己的本地存储），把当前账号导入到渠道 " : "扫描本机 WorkBuddy vault，把里面还没有登记的账号导入到渠道 ", h$3("span", { className: "dmh-strong" }, props.channelId), props.kind === "trae" ? "。Trae 自己的文件只读，不会被改写。" : "。凭据文件保持只读，不会被改写。"), added !== void 0 ? h$3("div", { className: "dmh-note" }, added.length === 0 ? "没有新账号：本机登录态里的账号都已登记过。" : [`已导入 ${added.length} 个账号：`, h$3("div", { key: "ids" }, added.join(" · "))]) : null, error !== void 0 ? h$3("div", { className: "dmh-errbox" }, error) : null, h$3("div", { className: "dmh-form-actions" }, added !== void 0 ? h$3("button", {
		className: "dmh-btn dmh-primary",
		onClick: props.onDone
	}, "完成") : h$3("button", {
		className: "dmh-btn dmh-primary",
		disabled: busy,
		onClick: () => void submit()
	}, busy ? "扫描中…" : props.kind === "trae" ? "扫描本机 Trae 导入" : "扫描 vault 导入"))) : h$3("div", { className: "dmh-form" }, h$3("label", null, "Personal Access Token", h$3("textarea", {
		rows: 4,
		value: pat,
		placeholder: "pt-…",
		spellCheck: false,
		onChange: (event) => setPat(event.target.value)
	}), pat === "" || trimmedPat === "" || patValid ? null : h$3("span", { className: "dmh-form-hint" }, "格式不对：pt- 开头，后接至少 8 位字母/数字/-/_")), h$3("label", null, "备注名（可选）", h$3("input", {
		value: displayName,
		placeholder: "留空则自动命名",
		onChange: (event) => setDisplayName(event.target.value)
	})), error !== void 0 ? h$3("div", { className: "dmh-errbox" }, error) : null, h$3("div", { className: "dmh-form-actions" }, h$3("button", {
		className: "dmh-btn dmh-primary",
		disabled: busy || !patValid,
		onClick: () => void submit()
	}, busy ? "验活中…" : "添加"))))));
}
// src/client/HubCard.ts
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
const h$2 = react.default.createElement;
const TABS = [
	{
		id: "accounts",
		label: "账号"
	},
	{
		id: "channels",
		label: "渠道"
	},
	{
		id: "records",
		label: "记录"
	},
	{
		id: "diag",
		label: "诊断"
	}
];
function dot(state) {
	return h$2("span", { className: `dmh-dot dmh-${state}` });
}
function formatBytes(bytes) {
	if (bytes === null || bytes === void 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatExpiry(ms) {
	if (ms === null || ms === void 0) return "—";
	const date = new Date(ms);
	const days = Math.floor((ms - Date.now()) / 864e5);
	const pad = (n) => String(n).padStart(2, "0");
	const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return days >= 0 ? `${stamp}（剩余 ${days} 天）` : `${stamp}（已过期）`;
}
/** 诊断栏的一行：dt + dd 成对。 */
function kvPair(label, value) {
	return [h$2("dt", { key: `k-${label}` }, label), h$2("dd", { key: `v-${label}` }, value)];
}
function HubCard() {
	ensureStyles();
	const [tab, setTab] = react.default.useState("accounts");
	const [summary, setSummary] = react.default.useState(void 0);
	const [catalog, setCatalog] = react.default.useState([]);
	const [channels, setChannels] = react.default.useState([]);
	const [accounts, setAccounts] = react.default.useState([]);
	const [recent, setRecent] = react.default.useState([]);
	const [diag, setDiag] = react.default.useState(void 0);
	const [modalOpen, setModalOpen] = react.default.useState(false);
	const [error, setError] = react.default.useState(void 0);
	const [loading, setLoading] = react.default.useState(true);
	const [busyId, setBusyId] = react.default.useState(void 0);
	const [expandedChannel, setExpandedChannel] = react.default.useState(void 0);
	const [authReport, setAuthReport] = react.default.useState(void 0);
	const [addModalFor, setAddModalFor] = react.default.useState(void 0);
	const [testResults, setTestResults] = react.default.useState(/* @__PURE__ */ new Map());
	const [modelsByChannel, setModelsByChannel] = react.default.useState({});
	/** 账号 → 今日消耗（daily_rollups 的 account_id 维度）；旧 host 不带键时为空对象。 */
	const [usageByAccount, setUsageByAccount] = react.default.useState({});
	/** 「?」说明弹层。 */
	const [helpOpen, setHelpOpen] = react.default.useState(false);
	const load = react.default.useCallback(async () => {
		try {
			const [nextSummary, channelData, records, catalogData, diagData] = await Promise.all([
				fetchSummary(),
				fetchChannels(),
				fetchRecords({ limit: 4 }),
				fetchCatalog(),
				fetchDiag().catch(() => void 0)
			]);
			setSummary(nextSummary);
			setChannels(channelData.channels);
			setAccounts(channelData.accounts);
			setRecent(records.requests);
			setCatalog(catalogData.models);
			setModelsByChannel(channelData.models_by_channel ?? {});
			setUsageByAccount(channelData.usage_by_account ?? {});
			setDiag(diagData);
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setLoading(false);
		}
	}, []);
	react.default.useEffect(() => {
		load();
	}, [load]);
	/**
	* 写操作包装：设 busyId → 执行 → 成功后 load() 刷新（开关/删除/认证都会改
	* 数据面）→ 失败进 errbox。finally 保证 busy 必被清掉，按钮不会卡死。
	* fn 返回值不关心（写路由多数只回 {ok:true}），所以收 `Promise<unknown>`。
	*/
	const run = (key, fn) => async () => {
		setBusyId(key);
		setError(void 0);
		try {
			await fn();
			await load();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusyId(void 0);
		}
	};
	const authBusy = busyId === "auth";
	const someBusy = busyId !== void 0;
	const accountsByChannel = /* @__PURE__ */ new Map();
	for (const account of accounts) {
		const list = accountsByChannel.get(account.channel_id) ?? [];
		list.push(account);
		accountsByChannel.set(account.channel_id, list);
	}
	const renderAccounts = () => {
		if (accounts.length === 0) return h$2("div", { className: "dmh-note" }, "还没有账号记录。当前凭据从 WorkBuddy vault 只读复用。");
		const blocks = [];
		for (const channel of channels) {
			const list = accountsByChannel.get(channel.id) ?? [];
			if (list.length === 0) continue;
			blocks.push(h$2("div", {
				className: "dmh-row dmh-group",
				key: `g-${channel.id}`
			}, h$2("div", { className: "dmh-row-main" }, h$2("span", { className: "dmh-row-meta" }, channel.display_name)), h$2("button", {
				className: "dmh-btn dmh-sm",
				disabled: someBusy,
				onClick: () => setAddModalFor(channel.id)
			}, "+ 添加账号")));
			for (const account of list) {
				const cooling = account.cooldown_until !== null && account.cooldown_until > Date.now();
				const state = cooling ? "err" : account.has_credential === 1 ? account.enabled === 1 ? "ok" : "warn" : "off";
				const tested = testResults.get(account.id);
				blocks.push(h$2("div", {
					className: "dmh-row",
					key: account.id
				}, dot(state), h$2("div", { className: "dmh-row-main" }, h$2("div", { className: "dmh-row-name" }, account.display_name, account.is_current === 1 ? h$2("span", { className: "dmh-badge dmh-cur" }, "当前") : null), h$2("div", { className: "dmh-row-meta" }, [
					diag?.region === void 0 || diag.region === null ? void 0 : diag.region === "cn" ? "国内版" : "国际版",
					account.has_credential === 1 ? "有凭据" : "缺凭据",
					usageByAccount[account.id] === void 0 ? "今日 0 次" : `今日 ${formatCount(usageByAccount[account.id].requests)} 次 · ${formatCount(usageByAccount[account.id].tokens)} tokens`,
					cooling ? `熔断中（至 ${formatClock(account.cooldown_until)}）` : void 0,
					account.last_error === null ? void 0 : `上次失败：${account.last_error.slice(0, 24)}`,
					account.last_ok_at === null ? void 0 : `上次成功 ${new Date(account.last_ok_at).toLocaleTimeString("zh-CN")}`,
					tested === void 0 ? void 0 : tested.ok ? `✓ ${formatMs(tested.ms)}` : `✗ ${tested.detail.slice(0, 24)}`
				].filter((x) => typeof x === "string").join(" · "))), h$2("button", {
					className: `dmh-switch${account.enabled === 1 ? " dmh-on" : ""}`,
					role: "switch",
					"aria-checked": account.enabled === 1,
					"aria-label": account.enabled === 1 ? "已启用" : "已禁用",
					disabled: someBusy,
					onClick: run(`sw:${account.id}`, () => hubApi.toggleAccount(account.id, account.enabled !== 1))
				}), h$2("button", {
					className: "dmh-btn dmh-sm",
					disabled: someBusy,
					onClick: run(`test:${account.id}`, async () => {
						const result = await hubApi.testAccount(account.id);
						setTestResults((prev) => new Map(prev).set(account.id, result));
					})
				}, "测试"), account.is_current === 1 ? null : h$2("button", {
					className: "dmh-btn dmh-sm",
					disabled: someBusy,
					onClick: run(`cur:${account.id}`, () => hubApi.makeCurrent(account.id))
				}, "设为当前"), h$2("button", {
					className: "dmh-btn dmh-sm dmh-danger",
					disabled: someBusy,
					onClick: () => {
						if (!window.confirm(`删除账号 ${account.display_name}？删除后无法从面板恢复（凭据文件不受影响）`)) return;
						run(`del:${account.id}`, async () => {
							await hubApi.deleteAccount(account.id);
							setTestResults((prev) => {
								if (!prev.has(account.id)) return prev;
								const next = new Map(prev);
								next.delete(account.id);
								return next;
							});
						})();
					}
				}, "删除")));
			}
		}
		return blocks;
	};
	const renderChannels = () => {
		if (channels.length === 0) return h$2("div", { className: "dmh-note" }, "还没有渠道。");
		const rows = [];
		for (const channel of channels) {
			const channelModelCount = modelsByChannel[channel.id]?.length ?? catalog.length;
			rows.push(h$2("div", {
				className: "dmh-row",
				key: channel.id
			}, h$2("div", { className: "dmh-row-main" }, h$2("div", { className: "dmh-row-name" }, channel.display_name), h$2("div", { className: "dmh-row-meta" }, `${channel.kind} · ${channelModelCount} 个模型 · 今日 ${formatCount(channel.today_requests)} 次 / ${formatCount(channel.today_tokens)} tokens`)), h$2("button", {
				className: "dmh-btn dmh-sm",
				onClick: () => setExpandedChannel(expandedChannel === channel.id ? void 0 : channel.id)
			}, expandedChannel === channel.id ? "收起 ▴" : "展开 ▾"), h$2("button", {
				className: `dmh-switch${channel.enabled === 1 ? " dmh-on" : ""}`,
				role: "switch",
				"aria-checked": channel.enabled === 1,
				"aria-label": channel.enabled === 1 ? "已启用" : "已禁用",
				disabled: someBusy,
				onClick: run(`channel:${channel.id}`, () => hubApi.toggleChannel(channel.id, channel.enabled !== 1))
			})));
			if (expandedChannel === channel.id) {
				const entries = modelsByChannel[channel.id] ?? [];
				rows.push(h$2("div", {
					className: "dmh-models",
					key: `models-${channel.id}`
				}, entries.length === 0 ? h$2("div", { className: "dmh-models-line" }, "该渠道目录为空（shim 还没拉到模型）") : entries.map((entry) => h$2("div", {
					className: "dmh-models-line",
					key: entry.id
				}, h$2("span", { className: "dmh-models-name" }, entry.name), entry.creditMultiplier === void 0 ? null : h$2("span", { className: "dmh-models-mult" }, `x${entry.creditMultiplier}`), entry.promotionBadge === void 0 ? null : h$2("span", { className: "dmh-badge" }, entry.promotionBadge), entry.tierBadge === void 0 ? null : h$2("span", { className: "dmh-badge" }, entry.tierBadge)))));
			}
		}
		rows.push(h$2("div", {
			className: "dmh-note",
			key: "note"
		}, "渠道开关关闭后，该渠道的模型从模型选择器里彻底消失（不是藏起来），凭据保留，随时可以重新打开。"));
		return rows;
	};
	const renderRecords = () => [
		h$2("div", {
			className: "dmh-row",
			key: "sum",
			style: { justifyContent: "space-between" }
		}, h$2("div", { className: "dmh-row-main" }, h$2("div", { className: "dmh-row-name" }, "今日"), h$2("div", { className: "dmh-row-meta" }, `${summary === void 0 ? "—" : formatCount(summary.requests)} 次请求 · ${summary === void 0 ? "—" : formatCount(summary.tokens)} tokens · 平均 ${summary === void 0 ? "—" : formatTps(summary.avgTps)}`)), h$2("button", {
			className: "dmh-btn dmh-sm",
			onClick: () => setModalOpen(true)
		}, "查看全部 →")),
		h$2("table", {
			className: "dmh-table",
			key: "table"
		}, h$2("thead", null, h$2("tr", null, h$2("th", null, "时间"), h$2("th", null, "模型"), h$2("th", { className: "dmh-num" }, "TTFT"), h$2("th", { className: "dmh-num" }, "tok/s"), h$2("th", { className: "dmh-num" }, "out"))), h$2("tbody", null, recent.length === 0 ? h$2("tr", null, h$2("td", { colSpan: 5 }, h$2("div", { className: "dmh-note" }, "还没有请求记录，用 hub- 渠道的模型发一条消息后出现明细。"))) : recent.map((record) => h$2("tr", { key: record.request_id }, h$2("td", { className: "dmh-mono" }, new Date(record.created_at).toLocaleTimeString("zh-CN")), h$2("td", null, record.model), h$2("td", { className: "dmh-num" }, formatMs(record.first_token_ms)), h$2("td", { className: `dmh-num dmh-tps${record.decode_tps === null ? " dmh-na" : record.decode_tps < 25 ? " dmh-slow" : ""}` }, record.decode_tps === null ? "—" : record.decode_tps.toFixed(1)), h$2("td", { className: "dmh-num" }, formatCount(record.output_tokens)))))),
		h$2("div", {
			className: "dmh-note",
			key: "note"
		}, "卡片里只放最近 4 条，完整记录点「查看全部」。")
	];
	const renderDiag = () => [
		h$2("dl", {
			className: "dmh-kv",
			key: "kv"
		}, [
			["插件版本", diag?.pluginVersion ?? "—"],
			["数据库", diag?.dbPath === void 0 ? "—" : `${diag.dbPath}（WAL · ${formatBytes(diag.dbSizeBytes)}）`],
			["记录数", diag === void 0 ? "—" : `${formatCount(diag.recordCount)} 条`],
			["当前渠道", diag?.currentChannelId ?? "—"],
			["当前账号", diag?.currentAccountName ?? diag?.currentAccountId ?? "—"],
			["凭据路径", diag?.credentialPath ?? "—"],
			["Token 有效期", formatExpiry(diag?.tokenExpiresAt)],
			["shim 地址", diag?.shimUrl ?? "—"],
			["上游最近错误", diag?.lastError === null || diag?.lastError === void 0 ? "（无）" : `${new Date(diag.lastError.at).toLocaleString("zh-CN")} · ${diag.lastError.model}`],
			["记录", diag?.recordEnabled === false ? "关（宿主插件设置里改）" : "开"]
		].flatMap(([k, v]) => kvPair(k, v))),
		h$2("div", {
			className: "dmh-row",
			key: "mgmt"
		}, h$2("div", { className: "dmh-row-main" }, h$2("div", { className: "dmh-row-name" }, "记录管理"), h$2("div", { className: "dmh-row-meta" }, `保留天数 ${diag?.retentionDays ?? "—"} · 明细 ${diag === void 0 ? "—" : `${formatCount(diag.recordCount)} 条`}`)), h$2("button", {
			className: "dmh-btn dmh-sm",
			disabled: someBusy,
			onClick: run("prune", () => hubApi.pruneRecords())
		}, "立即清理"), h$2("button", {
			className: "dmh-btn dmh-sm dmh-danger",
			disabled: someBusy,
			onClick: () => {
				if (!window.confirm("确定清空全部记录？此操作不可恢复")) return;
				if (!window.confirm("再次确认：删除所有明细与聚合")) return;
				run("clear", () => hubApi.clearRecords())();
			}
		}, "清空全部")),
		h$2("div", {
			className: "dmh-note",
			key: "note"
		}, "上游最近一次错误的", h$2("span", { className: "dmh-strong" }, "原文"), "，不翻译不概括 —— 这一栏存在的唯一理由就是能被整段贴进问题反馈。"),
		diag?.lastError === null || diag?.lastError === void 0 ? h$2("div", {
			className: "dmh-note",
			key: "noerr"
		}, "目前没有失败记录。") : h$2("div", {
			className: "dmh-errbox",
			key: "err"
		}, `HTTP ${diag.lastError.status ?? "—"} · ${diag.lastError.error}`)
	];
	/** 一键认证的结果区（tabs 上方）：每渠道一行，带关闭按钮。 */
	const renderAuthReport = () => {
		if (authReport === void 0) return null;
		return h$2("div", {
			className: "dmh-authbox",
			key: "authbox"
		}, authReport.channels.map((line) => {
			const displayName = channels.find((c) => c.id === line.id)?.display_name ?? line.id;
			const missed = line.sources.filter((s) => s.status !== "ok").map((s) => `${s.source}：${s.detail}`);
			return h$2("div", {
				className: "dmh-authline",
				key: line.id
			}, h$2("span", { className: "dmh-authline-name" }, displayName), h$2("span", { className: `dmh-badge${line.status === "ok" ? " dmh-free" : line.status === "missing" ? " dmh-err" : ""}` }, line.status), h$2("span", { className: "dmh-authline-detail" }, `接管 ${line.accountsAdded} 个账号`, missed.length === 0 ? null : ` · ${missed.join(" · ")}`));
		}), h$2("div", {
			className: "dmh-authline-actions",
			key: "actions"
		}, h$2("button", {
			className: "dmh-btn dmh-sm",
			onClick: () => setAuthReport(void 0),
			"aria-label": "关闭"
		}, "关闭")));
	};
	return h$2(react.default.Fragment, null, h$2("div", { className: "dmh-scope" }, h$2("div", { className: "dmh-card" }, h$2("div", { className: "dmh-card-head" }, h$2("div", null, h$2("div", { className: "dmh-card-title" }, "Model Hub"), h$2("div", { className: "dmh-card-desc" }, "WorkBuddy 模型接入 DSH · 凭据只读复用")), h$2("div", { style: {
		display: "flex",
		gap: 6
	} }, h$2("button", {
		className: "dmh-btn dmh-icon",
		title: "使用说明",
		"aria-label": "使用说明",
		onClick: () => setHelpOpen(true)
	}, "?"), h$2("button", {
		className: "dmh-btn",
		disabled: someBusy,
		onClick: () => {
			setLoading(true);
			load();
		}
	}, "刷新"), h$2("button", {
		className: "dmh-btn dmh-primary",
		disabled: someBusy,
		onClick: run("auth", async () => setAuthReport(await hubApi.oneClickAuth()))
	}, authBusy ? "认证中…" : "一键认证"))), renderAuthReport(), h$2("div", { className: "dmh-tabs" }, TABS.map((entry) => h$2("button", {
		key: entry.id,
		className: tab === entry.id ? "dmh-on" : void 0,
		onClick: () => setTab(entry.id),
		"aria-selected": tab === entry.id,
		role: "tab"
	}, entry.label))), error !== void 0 ? h$2("div", { className: "dmh-errbox" }, error) : loading ? h$2("div", { className: "dmh-note" }, "读取中…") : [
		h$2("div", {
			className: "dmh-panel",
			key: "p-acc",
			hidden: tab !== "accounts"
		}, renderAccounts()),
		h$2("div", {
			className: "dmh-panel",
			key: "p-ch",
			hidden: tab !== "channels"
		}, renderChannels()),
		h$2("div", {
			className: "dmh-panel",
			key: "p-rec",
			hidden: tab !== "records"
		}, renderRecords()),
		h$2("div", {
			className: "dmh-panel",
			key: "p-diag",
			hidden: tab !== "diag"
		}, renderDiag())
	])), modalOpen ? h$2(RecordsModal, { onClose: () => setModalOpen(false) }) : null, helpOpen ? h$2(HelpModal, { onClose: () => setHelpOpen(false) }) : null, addModalFor !== void 0 ? h$2(AddAccountModal, {
		channelId: addModalFor,
		kind: channels.find((c) => c.id === addModalFor)?.kind === "qoder" ? "qoder" : channels.find((c) => c.id === addModalFor)?.kind === "trae" ? "trae" : "workbuddy",
		onClose: () => setAddModalFor(void 0),
		onDone: () => {
			setAddModalFor(void 0);
			load();
		}
	}) : null);
}
// src/client/HubPanel.ts
/**
* Model Hub 主面板 —— 左下角按钮打开的弹层外壳。
*
* **只做遮罩与定位，不自带标题栏**：原型的标题（`Model Hub` + 描述 +
* 「一键认证」）在卡片自己的 `card-head` 里。之前这里也画了一个标题，
* 于是面板上出现两行一模一样的 "DSH Model Hub"（用户截图指出过）。
*
* 三个原型视图的落点：
* - ① 设置卡片 → `HubCard`（四栏：账号 / 渠道 / 记录 / 诊断）
* - ② 请求记录页 → 卡片「记录」栏的「查看全部」打开 `RecordsModal`
* - ③ 输入框胶囊 → **已移除**（该槽拿不到当前选中模型，会显示上一条记录，
*   看起来像别的模型正在生效；且该槽会重复挂载两处）
*
* 关闭：Esc、点遮罩。
*/
const h$1 = react.default.createElement;
function HubPanel(props) {
	ensureStyles();
	react.default.useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") props.onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [props.onClose]);
	return h$1("div", {
		className: "dmh-overlay",
		onClick: (event) => {
			if (event.target === event.currentTarget) props.onClose();
		}
	}, h$1("div", {
		className: "dmh-scope dmh-overlay-body",
		role: "dialog",
		"aria-modal": true,
		"aria-label": "Model Hub"
	}, h$1("div", { style: {
		width: 720,
		maxWidth: "100%"
	} }, h$1(HubCard))));
}
// src/client/ModelLabel.ts
const REFRESH_MS = 3e5;
let cache;
let fetchedAt = 0;
let inflight;
async function ensureCatalog() {
	if (cache !== void 0 && Date.now() - fetchedAt < REFRESH_MS) return;
	if (inflight !== void 0) return inflight;
	inflight = (async () => {
		try {
			const response = await fetch(`${DATA_PREFIX}/catalog`, { headers: { accept: "application/json" } });
			if (!response.ok) return;
			const body = await response.json();
			const next = /* @__PURE__ */ new Map();
			for (const entry of body.models ?? []) next.set(entry.id, entry);
			cache = next;
			fetchedAt = Date.now();
		} catch {} finally {
			inflight = void 0;
		}
	})();
	return inflight;
}
/** `#RRGGBB` → 14% 透明度的同色（pill 底色）。 */
function tint(color) {
	if (color === void 0) return void 0;
	const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color) ? color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : color : void 0;
	if (hex === void 0) return void 0;
	return `rgba(${Number.parseInt(hex.slice(1, 3), 16)}, ${Number.parseInt(hex.slice(3, 5), 16)}, ${Number.parseInt(hex.slice(5, 7), 16)}, 0.14)`;
}
/**
* 倍率的语义色 —— 「重要信息」里最该有颜色的一档：
* 免费 = 绿，偏贵（≥2） = 琥珀，其余中性灰。
*/
function rateColor(rate) {
	if (rate === 0) return "var(--dmh-success, #22c55e)";
	if (rate >= 2) return "var(--dmh-warn, #f59e0b)";
	return "var(--dmh-label-tertiary, #9ca3af)";
}
function ModelLabel(props) {
	const modelId = props?.model?.id ?? props?.modelId ?? props?.model?.modelId ?? "";
	const fallbackName = props?.model?.name ?? modelId;
	const [entry, setEntry] = react.default.useState(() => cache?.get(modelId));
	react.default.useEffect(() => {
		if (modelId === "") return;
		const hit = cache?.get(modelId);
		if (hit !== void 0) {
			setEntry(hit);
			return;
		}
		let live = true;
		ensureCatalog().then(() => {
			if (live) setEntry(cache?.get(modelId));
		});
		return () => {
			live = false;
		};
	}, [modelId]);
	if (entry === void 0) return react.default.createElement("span", null, fallbackName);
	const rate = entry.creditMultiplier;
	const badge = entry.promotionBadge ?? entry.tierBadge;
	const badgeColor = entry.promotionColor ?? entry.tierColor ?? (entry.promotionBadge === void 0 ? "#009273" : "#22c55e");
	const background = tint(badgeColor) ?? "rgba(127,127,127,0.15)";
	return react.default.createElement("span", { style: {
		display: "inline-flex",
		alignItems: "center",
		gap: 5
	} }, react.default.createElement("span", null, entry.name), rate === void 0 ? null : react.default.createElement("span", { style: {
		fontSize: "0.92em",
		fontWeight: 600,
		color: rateColor(rate),
		fontVariantNumeric: "tabular-nums"
	} }, `x${rate.toFixed(2)}`), badge === void 0 ? null : react.default.createElement("span", { style: {
		fontSize: "0.78em",
		lineHeight: 1.5,
		padding: "0 6px",
		borderRadius: 999,
		fontWeight: 600,
		whiteSpace: "nowrap",
		background,
		color: badgeColor,
		border: `1px solid ${badgeColor}`
	} }, badge));
}
// src/client/index.ts
/**
* 客户端入口。
*
* ## ABI
*
* 宿主的客户端插件不是普通 ESM 模块，而是走 `window.__ModuleLoader__.load`：
* ```js
* window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } })
* ```
* 导出 `name` / `inject` / `apply` 三项。`require` 由宿主注入（react、react-dom 等），
* 不能自己 import —— 否则会和宿主的 React 实例不是同一个，hooks 直接崩。
*
* ## 为什么每个 slot 都单独 try/catch
*
* 参考实现 `dsh-connect-workbuddy` 的做法：不同入口的挂载点不同，某个 slot
* 在当前宿主版本里可能不存在。**注册失败只该让那一个入口不显示，
* 绝不该影响 provider，更不该抛到加载期**（加载期抛错会让整个 host fatal，
* 进而把 profile 重置为默认 —— 本项目实测踩过两次）。
*/
const h = react.default.createElement;
const name = "dsh-model-hub-client";
/**
* 依赖的客户端服务。
*
* 与参考实现 `dsh-connect-workbuddy` 完全一致：`["slots", "locale"]`。
*
* 实测事故（2026-10-28）：「模型选择器打不开」报
* `cannot get property "remote.session" without inject`。
*
* 排查过程与结论（重要，避免以后重犯）：
* - 第一次猜是 inject 少声明，加了 `remote` → **更糟**：manifest 里我们的
*   inject 变成 5 项，而正常工作的插件是 4 项；声明 `@deepseek-ai/dsh-api-remotes`
*   反而让宿主经由它去解析 `remote.session`，继续抛。
* - 真正的修法是给 slot 传 `inject` 回调（见下面 `register`），
*   让组件走显式 props 而不是宿主的默认注入路径。
*
* 所以这里**不要**加 `remote`。宿主渲染路径要什么服务是它自己的事，
* 我们只声明自己真正用的。
*/
const inject = ["slots", "locale"];
function apply(ctx) {
	try {
		/**
		* 注册一个 slot。
		*
		* `inject` 回调是**必需**的，不是可选优化：它决定组件拿到哪些 props。
		* 不给它，宿主会走默认注入路径（会调 `directoryFor()`，需要
		* `remote.session`），于是模型选择器崩掉。给了它，注入就被短路成
		* 我们返回的普通对象，不再触碰那条路径。
		*/
		const register = (slotName, options, component, props) => {
			try {
				return ctx.slots.inject(slotName, () => ctx.slots.register({
					name: slotName,
					inject: props,
					...options
				}, component));
			} catch (error) {
				console.error(`[dsh-model-hub] slot "${slotName}" 注册失败（不影响 provider）:`, error);
				return;
			}
		};
		const CARD_KEYS = ["dsh-model-hub", "include:dsh-model-hub"];
		const cardProps = () => ({});
		for (const key of CARD_KEYS) {
			register("plugins.bundle.config", {
				key,
				priority: 30
			}, HubCard, cardProps);
			register("plugins.row.config", {
				key: `${key}#${key}`,
				priority: 30
			}, HubCard, cardProps);
		}
		const FooterEntry = (props) => h("button", {
			onClick: () => openHubPanel(),
			title: "DSH Model Hub 记录",
			"aria-label": "DSH Model Hub 记录",
			style: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				padding: "6px 10px",
				border: "none",
				background: "transparent",
				cursor: "pointer",
				color: "inherit",
				fontSize: 13,
				borderRadius: 6
			}
		}, h("svg", {
			width: 16,
			height: 16,
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": true
		}, h("path", {
			d: "M2 12V4m4 8V6m4 6V8m4 4V3",
			stroke: "currentColor",
			strokeWidth: 1.6,
			strokeLinecap: "round"
		})), props.wide === false ? null : h("span", null, "Model Hub"));
		register("sidebar.footer.action", {
			id: "dsh-model-hub",
			order: 100
		}, FooterEntry, () => ({}));
		try {
			ctx.slots.inject("conversation.input.model.label", () => ctx.slots.register({
				name: "conversation.input.model.label",
				priority: -.5
			}, ModelLabel));
		} catch (error) {
			console.error("[dsh-model-hub] 模型标签槽注册失败（不影响 provider）:", error);
		}
	} catch (error) {
		console.error("[dsh-model-hub] 客户端初始化失败（host provider 不受影响）:", error);
	}
}
/**
* 打开 Model Hub 主面板。
*
* **不用 `globalThis.__DSH_REACT_DOM_CLIENT__`** —— 实测宿主根本没暴露这个
* 全局对象，之前那条分支永远走 else，点按钮只会打一行警告然后立刻关掉。
*
* 改为自己挂一个独立 React root：`react-dom/client` 由宿主 `require` 提供
* （`__ModuleLoader__` 的 factory 参数里有），同一个 React 实例，
* 不会出现双实例 hooks 崩溃。
*
* 幂等：面板已存在时再点就关掉（当作开关用，符合左下角入口的直觉）。
*/
function openHubPanel() {
	const existing = document.getElementById("dsh-model-hub-panel");
	if (existing !== null) {
		existing.remove();
		return;
	}
	const host = document.createElement("div");
	host.id = "dsh-model-hub-panel";
	document.body.appendChild(host);
	const close = () => {
		try {
			root.unmount();
		} catch {}
		host.remove();
	};
	const { createRoot } = react_dom_client;
	const root = createRoot(host);
	root.render(h(HubPanel, { onClose: close }));
}
exports.apply = apply;
exports.inject = inject;
exports.name = name;
