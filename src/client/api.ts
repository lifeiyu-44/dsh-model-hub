import { DATA_PREFIX, type ChannelsResponse, type RecordsResponse, type Summary } from "./types.js";

/**
 * 面板数据访问。
 *
 * 全部走插件自己的只读路由（`/plugins/dsh-model-hub/*`），而不是宿主的 RPC：
 * 记录是我们自己的 SQLite，宿主不知道它的存在。宿主路由没有独立鉴权，
 * 所以 host 侧自己加了回环校验（见 `src/routes/data.ts`）。
 */

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function fetchSummary(): Promise<Summary> {
  return getJson<Summary>(`${DATA_PREFIX}/summary`);
}

/** 目录快照：模型 id -> 倍率与标记。面板用它算模型总数与免费模型数。 */
export interface CatalogEntry {
  id: string;
  name: string;
  creditMultiplier?: number;
  promotionBadge?: string;
  tierBadge?: string;
  promotionColor?: string;
  tierColor?: string;
}

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
