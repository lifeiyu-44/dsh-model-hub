import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptAuthDocument,
  deriveAtRestKey,
  findWorkbuddyExecutable,
  isEncryptedField,
  openEncryptedField,
  workbuddyAppCandidates,
} from "../src/channels/workbuddy/at-rest.js";

/**
 * WorkBuddy 桌面端 at-rest 加密凭据的内置解密。
 *
 * 协议常量（AAD 转录、keyId、framing）在测试里**独立复刻一份**：
 * 与实现共享同一份构造会让「两边一起写错」也照样绿；这里按协议文档重写。
 */

// ── 测试侧独立复刻的协议常量 ──
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
}
function lp(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}
function aad(keyId: string, suite: number): Buffer {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    lp("WBEV1"),
    lp("sym-v1"),
    u32(suite),
    lp(keyId),
    Buffer.from([2]), // field framing
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 用给定 key 构造一个 field 信封（与 App 封印方式相同的 AES-256-GCM）。 */
function sealField(plaintext: string, key: Buffer, suite = 1): { $wbEncrypted: 1; envelope: string } {
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(keyId, suite));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(
      JSON.stringify({
        suite,
        keyId,
        nonce: nonce.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
      "utf8",
    ).toString("base64"),
  };
}

function keyFromPayload(payload: { atRestSecretKey: string }): Buffer {
  return createHash("sha256").update(payload.atRestSecretKey, "utf8").digest();
}

describe("at-rest 信封", () => {
  const payload = { version: 1, atRestSecretKey: "Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI=" };
  const key = keyFromPayload(payload);

  it("isEncryptedField 只认精确的两键形状", () => {
    expect(isEncryptedField({ $wbEncrypted: 1, envelope: "x" })).toBe(true);
    expect(isEncryptedField({ $wbEncrypted: 1 })).toBe(false);
    expect(isEncryptedField({ $wbEncrypted: 2, envelope: "x" })).toBe(false);
    expect(isEncryptedField({ $wbEncrypted: 1, envelope: "x", extra: 1 })).toBe(false);
    expect(isEncryptedField("plain")).toBe(false);
  });

  it("deriveAtRestKey：对 base64 字符串原文哈希；keyId 为 key 的 sha256 前 16 hex", () => {
    const derived = deriveAtRestKey(JSON.stringify(payload));
    expect(derived.key.equals(key)).toBe(true);
    expect(derived.keyId).toBe(createHash("sha256").update(key).digest("hex").slice(0, 16));
  });

  it("开信封 round-trip；错误 key 与畸形信封都抛错", () => {
    const field = sealField("token-value-123", key);
    expect(openEncryptedField(field, key)).toBe("token-value-123");
    const wrong = createHash("sha256").update("another-secret", "utf8").digest();
    expect(() => openEncryptedField(field, wrong)).toThrow(/belongs to key/);
    expect(() => openEncryptedField({ envelope: "not-base64-json" }, key)).toThrow(/envelope/);
  });

  it("decryptAuthDocument：明文原样返回；信封经注入的 keyPayload 解开（含加密昵称）", async () => {
    const plain = await decryptAuthDocument({ auth: { accessToken: "t-plain", domain: "www.workbuddy.ai" }, account: { uid: "u1", nickname: "nick" } });
    expect(plain).toMatchObject({ accessToken: "t-plain", nickname: "nick", accountUid: "u1", decrypt: false });

    const encrypted = await decryptAuthDocument(
      {
        auth: { accessToken: sealField("t-real", key), refreshToken: sealField("r-real", key), domain: "copilot.tencent.com" },
        account: { uid: "u2", nickname: sealField("nick-enc", key) },
      },
      { keyPayload: async () => JSON.stringify(payload) },
    );
    expect(encrypted).toMatchObject({
      accessToken: "t-real",
      refreshToken: "r-real",
      nickname: "nick-enc",
      accountUid: "u2",
      decrypt: true,
    });
  });

  it("App 候选：WORKBUDDY_APP_EXECUTABLE 优先；exists 注入决定命中的路径", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", WORKBUDDY_APP_EXECUTABLE: "D:\\wb\\WorkBuddyAI.exe" };
    const candidates = workbuddyAppCandidates(env);
    expect(candidates[0]).toBe("D:\\wb\\WorkBuddyAI.exe");
    for (const expected of ["Programs\\WorkBuddy", "Programs\\WorkBuddyAI", "\\WorkBuddyAI\\"]) {
      expect(candidates.some((c) => c.includes(expected))).toBe(true);
    }
    const found = findWorkbuddyExecutable(env, (path) => path.includes("Programs\\WorkBuddyAI\\WorkBuddyAI.exe"));
    expect(found).toBeDefined();
    expect(found!.endsWith("WorkBuddyAI.exe")).toBe(true);
    expect(findWorkbuddyExecutable({ LOCALAPPDATA: "C:\\nowhere" }, () => false)).toBeUndefined();
  });
});

describe("realDecryptAuthFile（文件入口）", () => {
  it("读文件（容忍 BOM）→ 解密 → 带区域与过期时间", async () => {
    const { realDecryptAuthFile } = await import("../src/channels/workbuddy/at-rest.js");
    const payload = { version: 1, atRestSecretKey: "Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI=" };
    const key = keyFromPayload(payload);
    const dir = mkdtempSync(join(tmpdir(), "atrest-"));
    const file = join(dir, "workbuddy-desktop-ai.info");
    const doc = {
      auth: {
        accessToken: sealField("t-file", key),
        domain: "www.workbuddy.ai",
        expiresIn: 3600,
        lastRefreshTime: 1_700_000_000_000,
      },
      account: { uid: "uid-file", nickname: "nick-file" },
    };
    writeFileSync(file, "\uFEFF" + JSON.stringify(doc));
    const result = await realDecryptAuthFile(file, { keyPayload: async () => JSON.stringify(payload) });
    expect(result).toMatchObject({
      accessToken: "t-file",
      nickname: "nick-file",
      accountUid: "uid-file",
      region: "global",
      decrypt: true,
    });
    expect(result.expiresAtMs).toBe(1_700_000_000_000 + 3600 * 1000);
  });
});
