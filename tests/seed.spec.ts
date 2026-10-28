import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seedChannelsAndAccounts } from "../src/store/seed.js";
import { queryAccounts, queryChannels } from "../src/store/queries.js";

/**
 * 渠道/账号登记的测试。
 *
 * 背景（实测 2026-10-28）：面板做好后「渠道」栏是空的 —— 因为
 * `channels` 表从来没有被写入过。这不是查询错，是写入侧漏了。
 * 这一组守的就是「登记之后面板能看到东西」。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, "..", "src", "store", "schema.sql"), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  // schema.sql 是 v1 DDL；v2 的两列靠 openHubDatabase 的迁移 ALTER 补上。
  // 这里测纯存储层、绕过了 openHubDatabase，所以照搬 db.ts 里那两条 ALTER。
  db.exec("ALTER TABLE accounts ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE accounts ADD COLUMN cooldown_until INTEGER");
  return db;
}

const CHANNEL = { id: "hub-workbuddy-global", kind: "workbuddy", displayName: "WorkBuddy Global" };
const ACCOUNT = {
  id: "hub-workbuddy-global:default",
  channelId: "hub-workbuddy-global",
  displayName: "WorkBuddy 主账号",
  credentialRef: "vault:/global/x.json",
  isCurrent: true,
};

describe("seedChannelsAndAccounts", () => {
  let db: ReturnType<typeof freshDb>;

  beforeEach(() => {
    db = freshDb();
  });

  it("登记后 channels / accounts 能查出来（面板不再是空的）", () => {
    seedChannelsAndAccounts(db, [CHANNEL], [ACCOUNT]);

    const channels = queryChannels(db) as any[];
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("hub-workbuddy-global");
    expect(channels[0].display_name).toBe("WorkBuddy Global");

    const accounts = queryAccounts(db) as any[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0].channel_id).toBe("hub-workbuddy-global");
    expect(accounts[0].is_current).toBe(1);
    // 有凭据引用 -> has_credential = 1，但凭据内容本身不出现在结果里
    expect(accounts[0].has_credential).toBe(1);
    expect(JSON.stringify(accounts)).not.toContain("vault:/global");
  });

  it("幂等：重复登记不产生重复行", () => {
    seedChannelsAndAccounts(db, [CHANNEL], [ACCOUNT]);
    seedChannelsAndAccounts(db, [CHANNEL], [ACCOUNT]);
    expect((queryChannels(db) as any[])).toHaveLength(1);
    expect((queryAccounts(db) as any[])).toHaveLength(1);
  });

  it("重复登记不会把用户关掉的 enabled 重置回 1", () => {
    seedChannelsAndAccounts(db, [CHANNEL], [ACCOUNT]);
    // 用户关掉它
    db.prepare("UPDATE channels SET enabled = 0 WHERE id = ?").run(CHANNEL.id);

    seedChannelsAndAccounts(db, [CHANNEL], [ACCOUNT]);
    const channels = queryChannels(db) as any[];
    expect(channels[0].enabled).toBe(0);
  });

  it("空数组时不做事（不抛）", () => {
    expect(() => seedChannelsAndAccounts(db, [], [])).not.toThrow();
  });

  it("没有 credentialRef 时 has_credential 为 0", () => {
    seedChannelsAndAccounts(db, [CHANNEL], [{ ...ACCOUNT, credentialRef: undefined }]);
    const accounts = queryAccounts(db) as any[];
    expect(accounts[0].has_credential).toBe(0);
  });
});
