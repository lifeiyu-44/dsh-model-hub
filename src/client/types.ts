/**
 * 与宿主面板约定的数据形状。
 *
 * 这些类型同时被 client 与 host 使用 —— 放一处，两边不会漂。
 */

/** 今日汇总。均值在无样本时是 null，不是 0。 */
export interface Summary {
  date: string;
  requests: number;
  ok: number;
  tokens: number;
  costUnits: number;
  avgTtftMs: number | null;
  avgTps: number | null;
}

/** 一条请求明细。字段名与 SQLite 列名一致（snake_case），避免两边各翻一次。 */
export interface RequestRow {
  request_id: string;
  session_id: string | null;
  channel_id: string;
  account_id: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  first_token_ms: number | null;
  upstream_head_ms: number | null;
  duration_ms: number | null;
  decode_tps: number | null;
  status_code: number | null;
  error: string | null;
  is_streaming: number;
  estimated: number;
  cost_units: number;
  created_at: number;
}

export interface ChannelRow {
  id: string;
  kind: string;
  display_name: string;
  enabled: number;
  today_requests: number;
  today_tokens: number;
}

export interface AccountRow {
  id: string;
  channel_id: string;
  display_name: string;
  enabled: number;
  is_current: number;
  consecutive_failures: number;
  last_error: string | null;
  last_ok_at: number | null;
  created_at: number;
  has_credential: number;
}

export interface RecordsResponse {
  requests: RequestRow[];
  models: string[];
}

export interface ChannelsResponse {
  channels: ChannelRow[];
  accounts: AccountRow[];
}

/** 数据路由前缀，与 `src/routes/data.ts` 的 `DATA_PREFIX` 必须一致。 */
export const DATA_PREFIX = "/plugins/dsh-model-hub";
