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

    const upsertAccount = db.prepare(`
      INSERT INTO accounts (id, channel_id, display_name, credential_ref, enabled, is_current, consecutive_failures, created_at)
      VALUES (?, ?, ?, ?, 1, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        credential_ref = excluded.credential_ref
    `);
    const now = Date.now();
    for (const account of accounts) {
      upsertAccount.run(
        account.id,
        account.channelId,
        account.displayName,
        account.credentialRef ?? null,
        account.isCurrent === true ? 1 : 0,
        now,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
