import type { DatabaseSync } from "node:sqlite";

/**
 * 渠道与账号的登记（启动时调用一次）。
 *
 * ## 为什么需要这一步
 *
 * `requests` / `daily_rollups` 是**按请求**写入的，但 `channels` / `accounts`
 * 是**配置实体** —— 没有请求时它们也该存在，否则面板的「渠道」「账号」两栏
 * 永远是空的，用户会以为插件没工作。
 *
 * 实测（2026-10-28）：面板做出来后「渠道」栏空白，因为从来没人往
 * `channels` 写过一行。这不是查询错，是写入侧漏了。
 *
 * ## 幂等
 *
 * 用 `ON CONFLICT DO UPDATE` 只更新展示字段（`kind` / `display_name`），
 * **不动 `enabled`** —— 那是用户开关，重启不该把它重置回 1。
 *
 * ## 软删守卫（schema v2）
 *
 * 账号可能已被用户软删（`deleted = 1`）。登记是「把配置同步进库」，
 * 不是「把账号找回来」—— 软删行遇到重复登记必须原样不动，
 * 否则每次重启被删的账号都会复活。见 `upsertOneAccount` 的 `WHERE NOT EXISTS`。
 */

export interface ChannelSeed {
  id: string;
  kind: string;
  displayName: string;
}

export interface AccountSeed {
  id: string;
  channelId: string;
  displayName: string;
  /** 凭据引用。只存引用，**不存凭据本身** —— 面板只显示「有没有」。 */
  credentialRef?: string;
  isCurrent?: boolean;
}

/**
 * 登记单个账号（供 `seedChannelsAndAccounts` 与后续 prober 复用）。
 *
 * `WHERE NOT EXISTS` 是软删守卫：目标行 `deleted = 1` 时整个 INSERT SELECT
 * 产出空集，什么都不写。注意 `?1` 同时绑在两处 —— INSERT 的 id 与守卫的
 * 判存条件必须是同一个值，否则守卫形同虚设。
 *
 * `now` 由调用方传入（默认取当前时间）：批量登记共用一个 `created_at`，
 * 软删晋升时 `ORDER BY created_at ASC` 的并列才稳定。
 */
export function upsertOneAccount(db: DatabaseSync, account: AccountSeed, now: number = Date.now()): void {
  const upsertAccount = db.prepare(`
    INSERT INTO accounts (id, channel_id, display_name, credential_ref, enabled, is_current, consecutive_failures, created_at)
    SELECT ?, ?, ?, ?, 1, ?, 0, ?
    WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND deleted = 1)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      credential_ref = excluded.credential_ref
  `);
  upsertAccount.run(
    account.id,
    account.channelId,
    account.displayName,
    account.credentialRef ?? null,
    account.isCurrent === true ? 1 : 0,
    now,
  );
}

export function seedChannelsAndAccounts(
  db: DatabaseSync,
  channels: ChannelSeed[],
  accounts: AccountSeed[],
): void {
  if (channels.length === 0 && accounts.length === 0) return;

  db.exec("BEGIN");
  try {
    const upsertChannel = db.prepare(`
      INSERT INTO channels (id, kind, display_name, enabled, config)
      VALUES (?, ?, ?, 1, '{}')
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        display_name = excluded.display_name
    `);
    for (const channel of channels) {
      upsertChannel.run(channel.id, channel.kind, channel.displayName);
    }

    const now = Date.now();
    for (const account of accounts) {
      upsertOneAccount(db, account, now);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
