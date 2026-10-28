import type { DatabaseSync } from "node:sqlite";
import { localDate } from "./requests.js";

/**
 * 面板要读的聚合视图。
 *
 * 全部是**只读**查询，且都从 SQLite 现算 —— 不维护内存镜像。
 * 理由：记录面板随时可能打开，内存镜像要多一套失效逻辑，而
 * SQLite 读几千行是微秒级，省那点开销不值得引入一致性风险。
 */

export interface Summary {
  /** 今天的日期（本地时区，与写入时同口径）。 */
  date: string;
  requests: number;
  ok: number;
  tokens: number;
  costUnits: number;
  /** 加权平均 TTFT（毫秒）。没有样本时为 null，不是 0。 */
  avgTtftMs: number | null;
  /** 加权平均解码速度（tok/s）。没有样本时为 null。 */
  avgTps: number | null;
}

/**
 * 今日汇总。
 *
 * 均值的口径：`daily_rollups` 存的是**加权均值 + 各自样本数**
 * （`ttft_n` / `tps_n`），所以跨模型合并时要按样本数加权，
 * 不能对各行的 avg 直接求平均 —— 那会让一个只跑过 1 次的模型
 * 和一个跑过 500 次的模型等权。
 */
export function querySummary(db: DatabaseSync, date = localDate(Date.now())): Summary {
  const rows = db
    .prepare(
      "SELECT req_count, ok_count, tokens, cost_units, avg_ttft_ms, ttft_n, avg_tps, tps_n FROM daily_rollups WHERE date = ?",
    )
    .all(date) as {
    req_count: number;
    ok_count: number;
    tokens: number;
    cost_units: number;
    avg_ttft_ms: number;
    ttft_n: number;
    avg_tps: number;
    tps_n: number;
  }[];

  let requests = 0;
  let ok = 0;
  let tokens = 0;
  let costUnits = 0;
  let ttftWeighted = 0;
  let ttftN = 0;
  let tpsWeighted = 0;
  let tpsN = 0;

  for (const row of rows) {
    requests += row.req_count;
    ok += row.ok_count;
    tokens += row.tokens;
    costUnits += row.cost_units;
    ttftWeighted += row.avg_ttft_ms * row.ttft_n;
    ttftN += row.ttft_n;
    tpsWeighted += row.avg_tps * row.tps_n;
    tpsN += row.tps_n;
  }

  return {
    date,
    requests,
    ok,
    tokens,
    costUnits,
    avgTtftMs: ttftN > 0 ? Math.round(ttftWeighted / ttftN) : null,
    avgTps: tpsN > 0 ? tpsWeighted / tpsN : null,
  };
}

/** 渠道列表（含今日计数）。面板的筛选下拉与「渠道」栏用它。 */
export function queryChannels(db: DatabaseSync, date = localDate(Date.now())) {
  return db
    .prepare(
      `SELECT c.id, c.kind, c.display_name, c.enabled,
              COALESCE(r.req_count, 0) AS today_requests,
              COALESCE(r.tokens, 0) AS today_tokens
       FROM channels c
       LEFT JOIN (
         SELECT channel_id, SUM(req_count) AS req_count, SUM(tokens) AS tokens
         FROM daily_rollups WHERE date = ? GROUP BY channel_id
       ) r ON r.channel_id = c.id
       ORDER BY c.id`,
    )
    .all(date);
}

/** 账号列表。凭据本身**不返回** —— 面板只需要知道有没有、能不能用。 */
export function queryAccounts(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT id, channel_id, display_name, enabled, is_current,
              consecutive_failures, last_error, last_ok_at, created_at,
              CASE WHEN credential_ref IS NULL OR credential_ref = '' THEN 0 ELSE 1 END AS has_credential
       FROM accounts
       ORDER BY channel_id, display_name`,
    )
    .all();
}

export interface RecordFilter {
  limit: number;
  /** 渠道 id，空表示全部。 */
  channelId?: string;
  /** 模型 id，空表示全部。 */
  model?: string;
  /** 只取这个时间点之后的记录（毫秒）。 */
  sinceMs?: number;
}

/**
 * 明细记录，按筛选条件。
 *
 * 上限硬编码 2000：面板是「全部显示 + 表格自身滚动」，但把 10 万行塞进
 * 浏览器会卡死。2000 行足够覆盖一个工作日的排查，再多请用 CSV 导出。
 */
export function queryRequests(db: DatabaseSync, filter: RecordFilter) {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.channelId !== undefined && filter.channelId !== "") {
    clauses.push("channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.model !== undefined && filter.model !== "") {
    clauses.push("model = ?");
    params.push(filter.model);
  }
  if (filter.sinceMs !== undefined) {
    clauses.push("created_at >= ?");
    params.push(filter.sinceMs);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(1, filter.limit), 2000);

  return db
    .prepare(
      `SELECT request_id, session_id, channel_id, account_id, provider, model,
              input_tokens, output_tokens, cache_read, cache_write,
              first_token_ms, upstream_head_ms, duration_ms, decode_tps,
              status_code, error, is_streaming, estimated, cost_units, created_at
       FROM requests ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params, limit);
}

/** 出现过的模型（供筛选下拉）。 */
export function queryModels(db: DatabaseSync) {
  return db.prepare("SELECT DISTINCT model FROM requests ORDER BY model").all() as { model: string }[];
}
