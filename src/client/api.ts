import { DATA_PREFIX, type CatalogEntry, type ChannelsResponse, type RecordsResponse, type Summary } from "./types.js";

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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function fetchSummary(): Promise<Summary> {
  return getJson<Summary>(`${DATA_PREFIX}/summary`);
}

/** 目录快照（模型 id -> 倍率与徽标）；条目形状见 types.ts 的 CatalogEntry。 */
export function fetchCatalog(): Promise<{ models: CatalogEntry[] }> {
  return getJson<{ models: CatalogEntry[] }>(`${DATA_PREFIX}/catalog`);
}

/** 诊断栏的数据：storage 层算出来的 + host 补的事实。 */
export interface DiagData {
  recordCount: number;
  oldestRecordAt: number | null;
  lastError: { at: number; model: string; status: number | null; error: string } | null;
  currentChannelId: string | null;
  currentAccountId: string | null;
  currentAccountName: string | null;
  pluginVersion?: string;
  dbPath?: string;
  dbSizeBytes?: number | null;
  credentialPath?: string;
  tokenExpiresAt?: number | null;
  region?: string | null;
  shimUrl?: string;
  modelCount?: number;
  /** 是否记录请求（volatile 设置）。false 时诊断栏「记录」行显示「关」。 */
  recordEnabled?: boolean;
  /** 明细保留天数（volatile 设置），「立即清理」不传 days 时服务端就用它。 */
  retentionDays?: number;
}

export function fetchDiag(): Promise<DiagData> {
  return getJson<DiagData>(`${DATA_PREFIX}/diag`);
}

export function fetchChannels(): Promise<ChannelsResponse> {
  return getJson<ChannelsResponse>(`${DATA_PREFIX}/channels`);
}

export interface RecordsQuery {
  limit?: number;
  channel?: string;
  model?: string;
  hours?: number;
}

export function fetchRecords(query: RecordsQuery = {}): Promise<RecordsResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.channel !== undefined && query.channel !== "") params.set("channel", query.channel);
  if (query.model !== undefined && query.model !== "") params.set("model", query.model);
  if (query.hours !== undefined) params.set("hours", String(query.hours));
  const suffix = params.toString();
  return getJson<RecordsResponse>(`${DATA_PREFIX}/records${suffix === "" ? "" : `?${suffix}`}`);
}

// ── 一键认证报告（与 src/probe/prober.ts 的 OneClick* 形状镜像）──
//
// 客户端不能 import host 模块（会把 node:sqlite 等拖进浏览器产物），
// 所以本地声明一份。形状由 write-routes.spec 与 prober.spec 共同钉住。

export interface OneClickSource {
  source: string;
  status: "ok" | "encrypted" | "missing" | "error";
  detail: string;
}

export interface OneClickChannel {
  id: string;
  status: "ok" | "partial" | "missing";
  sources: OneClickSource[];
  accountsAdded: number;
}

export interface OneClickReport {
  channels: OneClickChannel[];
  at: number;
}

/**
 * 写操作的公共出口。POST JSON + JSON accept（写门禁要求 content-type 含
 * application/json）；非 2xx 一律抛 Error，文案优先取响应体里的 `error`
 * （兜住 `{error}` 与 `{ok:false,error}` 两种形状），取不到再报 HTTP 状态码。
 */
async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const doc = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) throw new Error(doc?.error ?? `${path} -> HTTP ${response.status}`);
  return doc as T;
}

/** 面板的全部改状态操作。id 会拼进路径，必须 encodeURIComponent（账号 id 含用户输入）。 */
export const hubApi = {
  toggleChannel: (id: string, enabled: boolean) =>
    postJson(`${DATA_PREFIX}/channel/${encodeURIComponent(id)}/toggle`, { enabled }),
  toggleAccount: (id: string, enabled: boolean) =>
    postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/toggle`, { enabled }),
  testAccount: (id: string) =>
    postJson<{ ok: boolean; detail: string; ms: number }>(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/test`),
  makeCurrent: (id: string) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/make-current`),
  deleteAccount: (id: string) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/delete`),
  addAccount: (body: { channelId: string; pat?: string; displayName?: string }) =>
    postJson<{ added: string[] } | { error: string }>(`${DATA_PREFIX}/accounts/add`, body),
  oneClickAuth: () => postJson<OneClickReport>(`${DATA_PREFIX}/auth/one-click`),
  pruneRecords: (days?: number) =>
    postJson<{ removed: number }>(`${DATA_PREFIX}/records/prune`, days === undefined ? {} : { days }),
  clearRecords: () => postJson(`${DATA_PREFIX}/records/clear`),
};
