import type { DatabaseSync } from "node:sqlite";

/**
 * 写侧状态变更（mutations）。
 *
 * 与 `seed.ts`（登记）/ `queries.ts`（只读）的分工：所有**改账号状态**的写入
 * 只走这里 —— SQL 集中一处，后面选择器 / 状态中心 / 写路由都建立在这层之上。
 * 全部同步、自带事务，调用方不需要再包 BEGIN。
 */

export const CIRCUIT_THRESHOLD = 3;
export const COOLDOWN_MS = 10 * 60_000;
/** 计入熔断的凭据类状态码。400 不算（请求不合法），5xx 不算（不是凭据的错）。 */
export function isCredentialFailure(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

export function setAccountEnabled(db: DatabaseSync, id: string, enabled: boolean): void {
  db.prepare("UPDATE accounts SET enabled = ? WHERE id = ? AND deleted = 0").run(enabled ? 1 : 0, id);
}
export function setChannelEnabled(db: DatabaseSync, id: string, enabled: boolean): void {
  db.prepare("UPDATE channels SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}
export function makeCurrent(db: DatabaseSync, channelId: string, accountId: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE accounts SET is_current = 0 WHERE channel_id = ?").run(channelId);
    db.prepare("UPDATE accounts SET is_current = 1, enabled = 1 WHERE id = ? AND channel_id = ? AND deleted = 0")
      .run(accountId, channelId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
export function softDeleteAccount(db: DatabaseSync, id: string): void {
  const row = db.prepare("SELECT channel_id FROM accounts WHERE id = ?").get(id) as { channel_id: string } | undefined;
  if (row === undefined) return;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE accounts SET deleted = 1, enabled = 0, is_current = 0 WHERE id = ?").run(id);
    const next = db.prepare(
      "SELECT id FROM accounts WHERE channel_id = ? AND deleted = 0 AND enabled = 1 ORDER BY last_ok_at DESC, created_at ASC LIMIT 1",
    ).get(row.channel_id) as { id: string } | undefined;
    if (next !== undefined) {
      db.prepare("UPDATE accounts SET is_current = 1 WHERE id = ?").run(next.id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
export function markAccountResult(
  db: DatabaseSync, id: string, ok: boolean,
  status: number | undefined, error: string | undefined, now: number,
): void {
  const row = db.prepare(
    "SELECT consecutive_failures, deleted FROM accounts WHERE id = ?",
  ).get(id) as { consecutive_failures: number; deleted: number } | undefined;
  if (row === undefined || row.deleted === 1) return;
  if (ok) {
    db.prepare(
      "UPDATE accounts SET consecutive_failures = 0, cooldown_until = NULL, last_ok_at = ?, last_error = NULL WHERE id = ?",
    ).run(now, id);
    return;
  }
  if (!isCredentialFailure(status)) {
    db.prepare("UPDATE accounts SET last_error = ? WHERE id = ?").run(error ?? null, id);
    return;
  }
  const fails = row.consecutive_failures + 1;
  const cooldown = fails >= CIRCUIT_THRESHOLD ? now + COOLDOWN_MS : null;
  db.prepare(
    "UPDATE accounts SET consecutive_failures = ?, cooldown_until = ?, last_error = ? WHERE id = ?",
  ).run(fails, cooldown, error ?? `HTTP ${status ?? "—"}`, id);
}
