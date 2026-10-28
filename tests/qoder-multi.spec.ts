import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPatFiles } from "../src/channels/qoder/credentials.js";
import { listVaultEntries } from "../src/channels/workbuddy/vault.js";

/**
 * Qoder 多 PAT 会话源 + WorkBuddy vault 多账号扫描。
 *
 * 夹具用真实临时目录（不是 mock fs）：这两个函数的全部行为都长在
 * 「目录里有什么文件、内容长什么样」上，mock 掉文件系统就什么也测不到。
 */

it("listPatFiles 列出目录下全部 pt- 文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pats-"));
  writeFileSync(join(dir, "main.pat"), "pt-aaa\n");
  writeFileSync(join(dir, "spare.pat"), "pt-bbb\n");
  writeFileSync(join(dir, "broken.pat"), "nope\n");
  const found = listPatFiles(dir);
  expect(found.map((f) => f.name).sort()).toEqual(["main.pat", "spare.pat"]);
  expect(found[0]!.pat.startsWith("pt-")).toBe(true);
});

it("listVaultEntries 返回 vault 下全部可用账号（不止第一个）", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const regionDir = join(root, "global");
  mkdirSync(regionDir, { recursive: true }); // vault 的条目按区域分目录，夹具要先建出来
  writeFileSync(join(regionDir, "acc1.json"),
    JSON.stringify({ auth: { accessToken: "tok1", expiresAt: 9999999999 } }));
  writeFileSync(join(regionDir, "acc2.json"),
    JSON.stringify({ auth: { accessToken: "tok2", expiresAt: 9999999999 } }));
  const entries = listVaultEntries(root);
  expect(entries.map((e) => e.accountId).sort()).toEqual(["acc1", "acc2"]);
  expect(entries[0]!.parsed.token).toBeDefined();
});
