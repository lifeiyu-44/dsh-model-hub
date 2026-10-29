import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts } from "../src/store/seed.js";
import { softDeleteAccount, makeCurrent } from "../src/store/mutations.js";
import { dedupeAccountsByCredential } from "../src/store/dedupe.js";
import { resolveAccountId, accountIdSuffixOf, listTokenStoreEntries, identityOfTokenFile } from "../src/channels/workbuddy/identity.js";
import { writeWorkbuddyTokenFile } from "../src/channels/workbuddy/token-store.js";

/**
 * 账号身份与重复行收敛 —— **真机事故的回归测试**（2026-10-29）。
 *
 * 事故现象：面板上同一个 WorkBuddy 账号出现两行，显示名相同、
 * `credential_ref` 指向同一个 token 文件；另一个真实账号根本没显示。
 *
 * 成因：启动装配层硬编码 `<channel>:default` 登记「当前登录的账号」，
 * 一键认证按 uid 哈希登记同一个账号 —— 两套 id 规则互不知情。
 *
 * 本文件锁死三件事：
 *   1. uid 相同 ⇒ 一定复用同一行 id（无论旧 id 长什么样）
 *   2. 同一凭据文件 ⇒ 一定复用同一行（守住软删语义：删掉的账号不复活）
 *   3. 库里已有的重复行，启动收敛后只剩一行，且消耗数据跟着走
 */

const CHANNEL = "hub-workbuddy-global";
const UID_NEW = "00000000-0000-4000-8000-000000000001";
const UID_OLD = "00000000-0000-4000-8000-000000000002";

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "dmh-identity-"));
}

async function freshDb(home: string): Promise<DatabaseSync> {
  return (await openHubDatabase(join(home, "model-hub", "hub.db"))) as unknown as DatabaseSync;
}

/** 写一份 token 文件并返回路径。 */
function seedToken(home: string, uid: string, nickname: string): string {
  return writeWorkbuddyTokenFile(home, {
    accountUid: uid,
    accessToken: `tok-${uid.slice(0, 6)}`,
    nickname,
    region: "global",
    expiresAtMs: Date.now() + 3_600_000,
  });
}

describe("账号身份：uid 是唯一身份", () => {
  it("identityOfTokenFile 读出明文 uid / nickname / 区域", () => {
    const home = newHome();
    const path = seedToken(home, UID_NEW, "user-a@example.com");
    const identity = identityOfTokenFile(path);
    expect(identity?.uid).toBe(UID_NEW);
    expect(identity?.nickname).toBe("user-a@example.com");
    expect(identity?.region).toBe("global");
  });

  it("listTokenStoreEntries 列出目录里全部账号（换号后可并存多个）", () => {
    const home = newHome();
    seedToken(home, UID_NEW, "user-a@example.com");
    seedToken(home, UID_OLD, "user-b@example.com");
    const entries = listTokenStoreEntries(home);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.identity.nickname).sort()).toEqual([
      "user-a@example.com",
      "user-b@example.com",
    ]);
  });

  it("同 uid 但旧 id 是 `:default` → 复用 `:default`，不新建", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const path = seedToken(home, UID_NEW, "user-a@example.com");
    // 模拟旧版本：硬编码 `:default` 指向这个文件
    seedChannelsAndAccounts(db, [{ id: CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }], [
      { id: `${CHANNEL}:default`, channelId: CHANNEL, displayName: "旧名", credentialRef: path, isCurrent: true },
    ]);
    expect(resolveAccountId(db, CHANNEL, UID_NEW, path)).toBe(`${CHANNEL}:default`);
    db.close();
  });

  it("uid 相同但凭据文件不同（历史 vault 副本）→ 仍认作同一账号", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const tokenPath = seedToken(home, UID_NEW, "user-a@example.com");
    // 另一份文件，写着同一个 uid（模拟 vault 与 token-store 各一份）
    const vaultDir = join(home, "workbuddy-vault", "global");
    mkdirSync(vaultDir, { recursive: true });
    const vaultPath = join(vaultDir, "test-account-a.json");
    writeFileSync(vaultPath, JSON.stringify({ auth: { accessToken: "x", domain: "www.workbuddy.ai" }, account: { uid: UID_NEW } }), "utf8");
    seedChannelsAndAccounts(db, [{ id: CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }], [
      { id: `${CHANNEL}:default`, channelId: CHANNEL, displayName: "user-a@example.com", credentialRef: vaultPath, isCurrent: true },
    ]);
    expect(resolveAccountId(db, CHANNEL, UID_NEW, tokenPath)).toBe(`${CHANNEL}:default`);
    db.close();
  });

  it("凭据文件没有 uid（老版明文 auth）→ 按路径认出同一账号，软删不复活", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const authPath = join(home, "auth.info");
    writeFileSync(authPath, JSON.stringify({ auth: { accessToken: "plain", domain: "www.workbuddy.ai" } }), "utf8");
    seedChannelsAndAccounts(db, [{ id: CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }], [
      { id: `${CHANNEL}:default`, channelId: CHANNEL, displayName: "老账号", credentialRef: authPath, isCurrent: true },
    ]);
    softDeleteAccount(db, `${CHANNEL}:default`);
    // 同一文件 → 复用已软删的 id（seed 的软删守卫会拦下，账号不会复活）
    expect(resolveAccountId(db, CHANNEL, undefined, authPath)).toBe(`${CHANNEL}:default`);
    db.close();
  });

  it("全新 uid → 派生稳定 id（同一 uid 永远同一 id）", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const path = seedToken(home, UID_NEW, "user-a@example.com");
    expect(resolveAccountId(db, CHANNEL, UID_NEW, path)).toBeUndefined(); // 库里还没有
    expect(`${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`).toBe(`${CHANNEL}:wb-11e594f48195`);
    // 稳定：两次算出来一样
    expect(accountIdSuffixOf(UID_NEW)).toBe(accountIdSuffixOf(UID_NEW));
    db.close();
  });
});

describe("重复行收敛（真机事故：同一账号两行）", () => {
  it("同一凭据文件的两行 → 收敛成一行，保留 current 那行", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const path = seedToken(home, UID_NEW, "user-a@example.com");
    seedChannelsAndAccounts(db, [{ id: CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }], [
      // 事故现场：`:default` 与 `wb-0030…` 指向同一个文件
      { id: `${CHANNEL}:default`, channelId: CHANNEL, displayName: "user-a@example.com", credentialRef: path, isCurrent: false },
      { id: `${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`, channelId: CHANNEL, displayName: "user-a@example.com", credentialRef: path, isCurrent: true },
    ]);

    const report = dedupeAccountsByCredential(db, CHANNEL);
    expect(report.removed).toEqual([`${CHANNEL}:default`]); // 非 current 的被并掉
    expect(report.kept).toEqual([`${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`]);

    const live = db.prepare("SELECT id FROM accounts WHERE deleted = 0").all() as { id: string }[];
    expect(live).toHaveLength(1);
    db.close();
  });

  it("两行都没 current → 保留 last_ok_at 更新的那行", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const path = seedToken(home, UID_NEW, "user-a@example.com");
    seedChannelsAndAccounts(db, [{ id: CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }], [
      { id: `${CHANNEL}:default`, channelId: CHANNEL, displayName: "旧", credentialRef: path, isCurrent: false },
      { id: `${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`, channelId: CHANNEL, displayName: "新", credentialRef: path, isCurrent: false },
    ]);
    db.prepare("UPDATE accounts SET last_ok_at = ? WHERE id = ?").run(Date.now(), `${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`);

    const report = dedupeAccountsByCredential(db, CHANNEL);
    expect(report.kept).toEqual([`${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`]);
    db.close();
  });

  it("被并掉的行的请求记录与聚合改挂到保留行（消耗不凭空消失）", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const path = seedToken(home, UID_NEW, "user-a@example.com");
    const keepId = `${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`;
    seedChannelsAndAccounts(db, [{ id: CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }], [
      { id: `${CHANNEL}:default`, channelId: CHANNEL, displayName: "旧", credentialRef: path, isCurrent: false },
      { id: keepId, channelId: CHANNEL, displayName: "新", credentialRef: path, isCurrent: true },
    ]);
    // 两行各自有历史消耗
    const now = Date.now();
    for (const [rid, acc, out] of [["r1", `${CHANNEL}:default`, 100], ["r2", keepId, 200]] as const) {
      db.prepare(
        "INSERT INTO requests (request_id, channel_id, account_id, provider, model, output_tokens, created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(rid, CHANNEL, acc, "workbuddy", "m", out, now);
      db.prepare(
        "INSERT INTO daily_rollups (date, channel_id, model, account_id, req_count, ok_count, tokens, cost_units) VALUES (?,?,?,?,?,?,?,?)",
      ).run("2026-10-29", CHANNEL, "m", acc, 1, 1, out, 0);
    }

    dedupeAccountsByCredential(db, CHANNEL);

    // 明细：两行都挂到保留行
    const reqs = db.prepare("SELECT request_id, account_id FROM requests ORDER BY request_id").all() as { request_id: string; account_id: string }[];
    expect(reqs.map((r) => r.account_id)).toEqual([keepId, keepId]);
    // 聚合：合成一行，tokens 相加
    const rolls = db.prepare("SELECT account_id, req_count, tokens FROM daily_rollups").all() as { account_id: string; req_count: number; tokens: number }[];
    expect(rolls).toHaveLength(1);
    expect(rolls[0]!.account_id).toBe(keepId);
    expect(rolls[0]!.req_count).toBe(2);
    expect(rolls[0]!.tokens).toBe(300);
    db.close();
  });

  it("不同 uid 的两行不合并（两个真实账号都要在）", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const newPath = seedToken(home, UID_NEW, "user-a@example.com");
    const oldPath = seedToken(home, UID_OLD, "user-b@example.com");
    seedChannelsAndAccounts(db, [{ id: CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }], [
      { id: `${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`, channelId: CHANNEL, displayName: "user-a@example.com", credentialRef: newPath, isCurrent: true },
      { id: `${CHANNEL}:${accountIdSuffixOf(UID_OLD)}`, channelId: CHANNEL, displayName: "user-b@example.com", credentialRef: oldPath, isCurrent: false },
    ]);
    const report = dedupeAccountsByCredential(db, CHANNEL);
    expect(report.removed).toEqual([]);
    const live = db.prepare("SELECT id FROM accounts WHERE deleted = 0").all();
    expect(live).toHaveLength(2);
    db.close();
  });

  it("幂等：收敛后再跑一次什么都不做", async () => {
    const home = newHome();
    const db = await freshDb(home);
    const path = seedToken(home, UID_NEW, "user-a@example.com");
    seedChannelsAndAccounts(db, [{ id: CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }], [
      { id: `${CHANNEL}:default`, channelId: CHANNEL, displayName: "旧", credentialRef: path, isCurrent: false },
      { id: `${CHANNEL}:${accountIdSuffixOf(UID_NEW)}`, channelId: CHANNEL, displayName: "新", credentialRef: path, isCurrent: true },
    ]);
    dedupeAccountsByCredential(db, CHANNEL);
    const second = dedupeAccountsByCredential(db, CHANNEL);
    expect(second.removed).toEqual([]);
    db.close();
  });
});
