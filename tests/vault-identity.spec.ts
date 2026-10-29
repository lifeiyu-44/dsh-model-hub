import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listVaultEntries, vaultIdentityOf } from "../src/channels/workbuddy/vault.js";

/**
 * 账号显示名=真实身份的地基：vault json `account` 段的身份提取。
 * 只有**明文字符串**算数 —— 新版桌面端的 `{$wbEncrypted}` 信封在这里
 * 视为未知（绝不解密），调用方退回 uid 前缀或文件名。
 */

describe("vaultIdentityOf", () => {
  it("明文 nickname + uid → 都提取", () => {
    expect(vaultIdentityOf({ account: { uid: "12345678-aaaa", nickname: "fuqinghe@x.com" } })).toEqual({
      uid: "12345678-aaaa",
      nickname: "fuqinghe@x.com",
    });
  });

  it("nickname 是加密信封 → 只认 uid；完全没 account → 空对象", () => {
    expect(vaultIdentityOf({ account: { uid: "12345678-aaaa", nickname: { $wbEncrypted: 1, envelope: "…" } } })).toEqual({
      uid: "12345678-aaaa",
    });
    expect(vaultIdentityOf({})).toEqual({});
    expect(vaultIdentityOf({ account: null })).toEqual({});
  });
});

describe("listVaultEntries 带出 identity", () => {
  it("身份随条目透传，坏 account 段不炸扫描", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-id-"));
    const dir = join(root, "global");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "withnick.json"),
      JSON.stringify({ account: { uid: "uid-abc", nickname: "nick@x.com" }, auth: { accessToken: "t1" } }),
    );
    writeFileSync(join(dir, "noaccount.json"), JSON.stringify({ auth: { accessToken: "t2" } }));
    const entries = listVaultEntries(root);
    // readdir 顺序不保证 —— 按 accountId 对齐断言，条目内容才是本用例的重点
    expect(entries.map((e) => ({ id: e.accountId, identity: e.identity })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "noaccount", identity: {} },
      { id: "withnick", identity: { uid: "uid-abc", nickname: "nick@x.com" } },
    ]);
  });
});
