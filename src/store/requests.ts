import type { DatabaseSync } from "node:sqlite";

export interface RequestRecord {
  requestId: string;
  sessionId?: string;
  channelId: string;
  accountId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  firstTokenMs?: number;
  upstreamHeadMs?: number;
  durationMs?: number;
  decodeTps?: number;
  statusCode?: number;
  error?: string;
  isStreaming: boolean;
  estimated: boolean;
  costUnits: number;
  createdAt: number;
}

/** 本地时区的 YYYY-MM-DD。聚合按用户看到的「今天」分组，不是 UTC。 */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface RollupRow {
  req_count: number;
  ok_count: number;
  tokens: number;
  cost_units: number;
  avg_ttft_ms: number;
  ttft_n: number;
  avg_tps: number;
  tps_n: number;
}

/**
 * 写一条请求记录，并增量累加当日聚合。
 *
 * 聚合口径必须与明细重算逐字段相等（回归锚点）：均值存加权均值，
 * 各自带样本数 ttft_n / tps_n —— 不能拿 ok_count 凑，因为 TTFT 与 tok/s
 * 都可能为 NULL，各自的样本数不同。
 */
export function insertRequest(db: DatabaseSync, r: RequestRecord): void {
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO requests (
        request_id, session_id, channel_id, account_id, provider, model,
        input_tokens, output_tokens, cache_read, cache_write,
        first_token_ms, upstream_head_ms, duration_ms, decode_tps,
        status_code, error, is_streaming, estimated, cost_units, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      r.requestId, r.sessionId ?? null, r.channelId, r.accountId ?? null, r.provider, r.model,
      r.inputTokens, r.outputTokens, r.cacheRead, r.cacheWrite,
      r.firstTokenMs ?? null, r.upstreamHeadMs ?? null, r.durationMs ?? null, r.decodeTps ?? null,
      r.statusCode ?? null, r.error ?? null, r.isStreaming ? 1 : 0, r.estimated ? 1 : 0,
      r.costUnits, r.createdAt,
    );

    const date = localDate(r.createdAt);
    const account = r.accountId ?? "";
    const ok = r.statusCode !== undefined && r.statusCode >= 200 && r.statusCode < 300 ? 1 : 0;
    const tokens = r.inputTokens + r.outputTokens;
    const hasTtft = r.firstTokenMs !== undefined;
    const hasTps = r.decodeTps !== undefined;

    const existing = db.prepare(
      "SELECT req_count, ok_count, tokens, cost_units, avg_ttft_ms, ttft_n, avg_tps, tps_n FROM daily_rollups WHERE date=? AND channel_id=? AND model=? AND account_id=?",
    ).get(date, r.channelId, r.model, account) as RollupRow | undefined;

    const prev: RollupRow = existing ?? {
      req_count: 0, ok_count: 0, tokens: 0, cost_units: 0,
      avg_ttft_ms: 0, ttft_n: 0, avg_tps: 0, tps_n: 0,
    };
    const ttftN = prev.ttft_n + (hasTtft ? 1 : 0);
    const tpsN = prev.tps_n + (hasTps ? 1 : 0);
    const avgTtft = hasTtft
      ? Math.round((prev.avg_ttft_ms * prev.ttft_n + (r.firstTokenMs as number)) / ttftN)
      : prev.avg_ttft_ms;
    const avgTps = hasTps
      ? (prev.avg_tps * prev.tps_n + (r.decodeTps as number)) / tpsN
      : prev.avg_tps;

    db.prepare(`
      INSERT INTO daily_rollups (date, channel_id, model, account_id, req_count, ok_count, tokens, cost_units, avg_ttft_ms, ttft_n, avg_tps, tps_n)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(date, channel_id, model, account_id) DO UPDATE SET
        req_count=excluded.req_count, ok_count=excluded.ok_count, tokens=excluded.tokens,
        cost_units=excluded.cost_units, avg_ttft_ms=excluded.avg_ttft_ms, ttft_n=excluded.ttft_n,
        avg_tps=excluded.avg_tps, tps_n=excluded.tps_n
    `).run(
      date, r.channelId, r.model, account,
      prev.req_count + 1, prev.ok_count + ok, prev.tokens + tokens, prev.cost_units + r.costUnits,
      avgTtft, ttftN, avgTps, tpsN,
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 最近 N 条明细 + 最近 30 天聚合，供只读路由使用。 */
export function queryRecords(db: DatabaseSync, limit: number): unknown {
  return {
    requests: db.prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT ?").all(limit),
    rollups: db.prepare("SELECT * FROM daily_rollups ORDER BY date DESC LIMIT 30").all(),
  };
}
