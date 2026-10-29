import type { DatabaseSync } from "node:sqlite";
import { identityOfTokenFile } from "../channels/workbuddy/identity.js";

/**
 * 启动期的账号表自愈（一次性、幂等）。
 *
 * ## 它修的是什么
 *
 * 真机事故（2026-10-29）：面板上同一个 WorkBuddy 账号出现两行 —— 显示名相同、
 * `credential_ref` 指向同一个 token 文件。成因是历史上有两套 id 规则
 * （硬编码 `:default` 与 uid 哈希）各登记过一次。规则已经统一
 * （见 `channels/workbuddy/identity.ts`），但**旧库里已经写进去的重复行不会
 * 自己消失**，所以需要在启动时收敛一次。
 *
 * ## 判定
 *
 * 同一渠道内，两个账号的 `credential_ref` 指向同一个文件 ⇒ 同一个真实账号
 * ⇒ 保留一行、把另一行软删。**保留哪一行**：
 *   1. `is_current = 1` 的优先（用户正在用的那个，不能让它的徽标丢）
 *   2. 其次 `last_ok_at` 最新的（有真实成功记录的更可信）
 *   3. 再其次 `created_at` 最早的（老行有历史消耗挂在它上面）
 *
 * ## 迁移的不只是行
 *
 * 被软删那行名下的 `requests.account_id` 与 `daily_rollups.account_id`
 * 要改到保留行上 —— 否则用户会看到「按账号的今日消耗」凭空少掉一块。
 * 聚合表是 (date, channel_id, model, account_id) 主键，直接 UPDATE 可能撞主键，
 * 所以走「先并后删」：把计数加到保留行，再删掉重复行。
 *
 * ## 幂等
 *
 * 收敛后同一渠道内不再有重复 `credential_ref`，再跑一次什么都不做。
 */

export interface DedupeReport {
  /** 被软删的账号 id。 */
  removed: string[];
  /** 保留的账号 id（与被删行成对）。 */
  kept: string[];
}

interface Row {
  id: string;
  channel_id: string;
  credential_ref: string | null;
  is_current: number;
  last_ok_at: number | null;
  created_at: number;
}

/**
 * 把重复账号收敛成一行。返回做了什么（供日志与测试断言）。
 *
 * 只在 WorkBuddy 渠道上做 —— Qoder 的 `credential_ref` 是一个 PAT 文件，
 * 但同一 PAT 理论上可以被两个账号引用（用户手动贴两次），那是用户的显式
 * 选择，不该被静默合并；WorkBuddy 的 token 文件按 uid 命名，同一文件
 * 必然同一账号，合并是安全的。
 */
export function dedupeAccountsByCredential(db: DatabaseSync, channelId: string): DedupeReport {
  const rows = db
    .prepare(
      "SELECT id, channel_id, credential_ref, is_current, last_ok_at, created_at FROM accounts WHERE channel_id = ? AND deleted = 0",
    )
    .all(channelId) as unknown as Row[];

  // 按「凭据文件 + uid」分组：同一文件必然同 uid；uid 也放进键里是为了
  // 万一两个不同文件写着同一个 uid（历史 vault 副本），也能收敛。
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.credential_ref === null || row.credential_ref === "") continue;
    const uid = identityOfTokenFile(row.credential_ref)?.uid;
    const key = uid === undefined ? `file:${row.credential_ref.toLowerCase()}` : `uid:${uid}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }

  const report: DedupeReport = { removed: [], kept: [] };
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const [keep, ...drop] = [...bucket].sort((a, b) => {
      if (a.is_current !== b.is_current) return b.is_current - a.is_current;
      const aOk = a.last_ok_at ?? -1;
      const bOk = b.last_ok_at ?? -1;
      if (aOk !== bOk) return bOk - aOk;
      return a.created_at - b.created_at;
    });
    if (keep === undefined) continue;
    db.exec("BEGIN");
    try {
      for (const gone of drop) {
        migrateAccountUsage(db, gone.id, keep.id);
        // 软删而非物理删：用户可能还有一条指向它的历史记录想保留可读性
        db.prepare("UPDATE accounts SET deleted = 1, enabled = 0, is_current = 0 WHERE id = ?").run(gone.id);
        report.removed.push(gone.id);
      }
      // 保留行必须是启用且有凭据的，否则合并后它反而不进池
      db.prepare("UPDATE accounts SET deleted = 0, enabled = 1 WHERE id = ?").run(keep.id);
      db.exec("COMMIT");
      report.kept.push(keep.id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return report;
}

/**
 * 把 `from` 账号名下的请求与聚合改挂到 `to` 账号上。
 *
 * 明细表 `requests` 直接 UPDATE（它没有 (account_id) 唯一约束）；
 * 聚合表 `daily_rollups` 的主键含 account_id，先加后删。
 */
function migrateAccountUsage(db: DatabaseSync, from: string, to: string): void {
  db.prepare("UPDATE requests SET account_id = ? WHERE account_id = ?").run(to, from);

  const dup = db
    .prepare("SELECT date, channel_id, model, req_count, ok_count, tokens, cost_units FROM daily_rollups WHERE account_id = ?")
    .all(from) as { date: string; channel_id: string; model: string; req_count: number; ok_count: number; tokens: number; cost_units: number }[];
  for (const row of dup) {
    db.prepare(
      `INSERT INTO daily_rollups (date, channel_id, model, account_id, req_count, ok_count, tokens, cost_units)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date, channel_id, model, account_id) DO UPDATE SET
         req_count = req_count + excluded.req_count,
         ok_count = ok_count + excluded.ok_count,
         tokens = tokens + excluded.tokens,
         cost_units = cost_units + excluded.cost_units`,
    ).run(row.date, row.channel_id, row.model, to, row.req_count, row.ok_count, row.tokens, row.cost_units);
  }
  db.prepare("DELETE FROM daily_rollups WHERE account_id = ?").run(from);
}
