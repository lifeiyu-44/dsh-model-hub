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
  /** 熔断冷却的截止时刻（毫秒）；null = 未熔断。行 UI 据此把状态点转 err。 */
  cooldown_until: number | null;
  last_error: string | null;
  last_ok_at: number | null;
  created_at: number;
  has_credential: number;
}

/** 目录条目：模型 id、展示名、倍率与徽标。/catalog 与 /channels 的 models_by_channel 都用它。 */
export interface CatalogEntry {
  id: string;
  name: string;
  creditMultiplier?: number;
  promotionBadge?: string;
  tierBadge?: string;
  promotionColor?: string;
  tierColor?: string;
}

export interface RecordsResponse {
  requests: RequestRow[];
  models: string[];
}

export interface ChannelsResponse {
  channels: ChannelRow[];
  accounts: AccountRow[];
  /**
   * 渠道 → 该渠道的模型目录。渠道行「展开」用它（任务 9 裁定 2）；
   * 旧 host 不带这个键时按 `{}` 消费（展开行显示「目录不可用」）。
   */
  models_by_channel: Record<string, CatalogEntry[]>;
}

/** 数据路由前缀，与 `src/routes/data.ts` 的 `DATA_PREFIX` 必须一致。 */
export const DATA_PREFIX = "/plugins/dsh-model-hub";
