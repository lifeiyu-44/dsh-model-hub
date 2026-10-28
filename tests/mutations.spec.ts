import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts } from "../src/store/seed.js";
import {
  setAccountEnabled, makeCurrent, softDeleteAccount, markAccountResult,
} from "../src/store/mutations.js";
import { queryAccounts } from "../src/store/queries.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "hub-"));
  return openHubDatabase(join(dir, "hub.db"));
}
function seedOne(db: any) {
  seedChannelsAndAccounts(db,
    [{ id: "hub-qoder-cn", kind: "qoder", displayName: "Qoder CN" }],
    [{ id: "hub-qoder-cn:default", channelId: "hub-qoder-cn", displayName: "Qoder CN 账号",
       credentialRef: "~/.dsh/qoder/pat", isCurrent: true }]);
}

it("软删后 queryAccounts 不再返回，且 seed 不复活它", async () => {
  const db = await tempDb();
  seedOne(db);
  softDeleteAccount(db, "hub-qoder-cn:default");
  expect(queryAccounts(db)).toHaveLength(0);
  seedChannelsAndAccounts(db, [],
    [{ id: "hub-qoder-cn:default", channelId: "hub-qoder-cn", displayName: "Qoder CN 账号",
       credentialRef: "~/.dsh/qoder/pat", isCurrent: true }]);
  expect(queryAccounts(db)).toHaveLength(0);        // 复活被守住
  const raw = db.prepare("SELECT deleted FROM accounts WHERE id=?").get("hub-qoder-cn:default");
  expect(raw.deleted).toBe(1);
});

it("makeCurrent 在渠道内唯一；软删当前账号自动晋升（继任者有凭据）", async () => {
  const db = await tempDb();
  seedChannelsAndAccounts(db,
    [{ id: "c", kind: "qoder", displayName: "C" }],
    [{ id: "a1", channelId: "c", displayName: "A1", credentialRef: "~/.dsh/qoder/pat", isCurrent: true },
     { id: "a2", channelId: "c", displayName: "A2", credentialRef: "~/.dsh/qoder/pat2" }]);
  makeCurrent(db, "c", "a2");
  const rows = queryAccounts(db);
  expect(rows.find((r: any) => r.id === "a1").is_current).toBe(0);
  expect(rows.find((r: any) => r.id === "a2").is_current).toBe(1);
  softDeleteAccount(db, "a2");
  expect(queryAccounts(db).find((r: any) => r.id === "a1").is_current).toBe(1);
});

it("软删当前账号：无凭据的继任者不晋升（池口径要求 has_credential）", async () => {
  // 面板的「当前」徽标指向一个永远进不了池（缺凭据）的账号会误导用户，
  // 晋升条件必须与 poolOf 同口径：deleted=0 ∧ enabled=1 ∧ 有凭据。
  const db = await tempDb();
  seedChannelsAndAccounts(db,
    [{ id: "c", kind: "qoder", displayName: "C" }],
    [{ id: "a1", channelId: "c", displayName: "A1" }, // 没有 credential_ref
     { id: "a2", channelId: "c", displayName: "A2", credentialRef: "~/.dsh/qoder/pat", isCurrent: true }]);
  softDeleteAccount(db, "a2");
  const rows = queryAccounts(db);
  expect(rows.find((r: any) => r.id === "a1").is_current).toBe(0); // 不晋升
  expect(rows.find((r: any) => r.id === "a1").enabled).toBe(1); // 本身没被动过
  const raw = db.prepare("SELECT is_current FROM accounts WHERE id='a2'").get() as any;
  expect(raw.is_current).toBe(0); // 被删者自身也置 0
});

it("markAccountResult：成功清零并记 last_ok_at；凭据类失败 3 次进冷却", async () => {
  const db = await tempDb();
  seedOne(db);
  const id = "hub-qoder-cn:default";
  markAccountResult(db, id, true, 200, undefined, 1_000);
  let row: any = queryAccounts(db)[0];
  expect(row.consecutive_failures).toBe(0);
  expect(row.last_ok_at).toBe(1_000);
  for (const at of [2_000, 3_000, 4_000]) markAccountResult(db, id, false, 429, "rate", at);
  row = queryAccounts(db)[0];
  expect(row.consecutive_failures).toBe(3);
  expect(row.cooldown_until).toBe(4_000 + 10 * 60_000);
  // 5xx 不计熔断
  markAccountResult(db, id, false, 502, "bad upstream", 5_000);
  expect(queryAccounts(db)[0].consecutive_failures).toBe(3);
});

it("迁移：v1 老库打开后补列且 user_version=2", async () => {
  // 先造一个 v1 库：手工执行 schema.sql 后把 user_version 写成 1
  const dir = mkdtempSync(join(tmpdir(), "hubv1-"));
  const path = join(dir, "hub.db");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path);
  raw.exec((await import("node:fs")).readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/store/schema.sql"), "utf8"));
  raw.exec("PRAGMA user_version = 1");
  raw.close();
  const db = await openHubDatabase(path);
  const cols = db.prepare("PRAGMA table_info(accounts)").all().map((c: any) => c.name);
  expect(cols).toContain("deleted");
  expect(cols).toContain("cooldown_until");
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(2);
});
