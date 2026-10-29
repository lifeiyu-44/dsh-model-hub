import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_DIR_NAME } from "../../constants.js";
import type { Region } from "./auth.js";
import { parseAuthDocument, type ParsedAuth } from "./auth.js";

/**
 * 经 App 解密后**我们自己维护**的 WorkBuddy token 文件。
 *
 * 为什么需要它：桌面端 auth 文件是加密信封（每账号一个「当前登录」位置），
 * 插件解密后必须把明文 token 存到自己的目录，运行时（shim 的 prepare）才能
 * 按 credential_ref 现读。目录 0700 / 文件 0600，与 qoder-pats 同一纪律；
 * 每账号一个文件（按 uid 哈希命名），换号登录后可并存多个账号。
 *
 * 文件形状与桌面端 auth 文档同构（`{auth:{accessToken,refreshToken?,domain,expiresAt?},
 * account:{uid,nickname?}}`），因此 `parseAuthDocument` 与 `vaultIdentityOf`
 * 无需改动即可读取 —— 也是「一份凭据、两条读取路径」的收敛点。
 */

/** 一个已解密落盘的账号 token（内部形状）。 */
export interface StoredWorkbuddyToken {
  accountUid: string;
  accessToken: string;
  refreshToken?: string;
  nickname?: string;
  region: Region;
  /** 绝对过期时间（毫秒）。 */
  expiresAtMs?: number;
}

/** 账号 uid → 存储文件名（sha256 前 12 hex，稳定且不可逆推 uid）。 */
export function workbuddyTokenPath(dshHome: string, accountUid: string): string {
  const slug = createHash("sha256").update(accountUid, "utf8").digest("hex").slice(0, 12);
  return join(dshHome, HUB_DIR_NAME, "workbuddy-tokens", `${slug}.json`);
}

/** 把解密后的 token 落成文件（0600），返回路径。 */
export function writeWorkbuddyTokenFile(dshHome: string, token: StoredWorkbuddyToken): string {
  const dir = join(dshHome, HUB_DIR_NAME, "workbuddy-tokens");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = workbuddyTokenPath(dshHome, token.accountUid);
  const domain = token.region === "global" ? "www.workbuddy.ai" : "www.workbuddy.cn";
  const doc = {
    auth: {
      accessToken: token.accessToken,
      ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
      domain,
      ...(token.expiresAtMs === undefined ? {} : { expiresAt: token.expiresAtMs }),
    },
    account: {
      uid: token.accountUid,
      ...(token.nickname === undefined ? {} : { nickname: token.nickname }),
    },
  };
  writeFileSync(path, JSON.stringify(doc), { encoding: "utf8", mode: 0o600 });
  return path;
}

/** 读一份我们自己写的 token 文件（读取失败返回 undefined，不抛）。 */
export function readWorkbuddyTokenFile(path: string): { parsed: ParsedAuth; uid?: string; nickname?: string } | undefined {
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const doc = JSON.parse(text) as Record<string, unknown>;
    const parsed = parseAuthDocument(text);
    if (parsed.kind !== "plain" || parsed.token === undefined) return undefined;
    const account = (typeof doc["account"] === "object" && doc["account"] !== null
      ? (doc["account"] as Record<string, unknown>)
      : undefined);
    return {
      parsed,
      ...(typeof account?.["uid"] === "string" ? { uid: account["uid"] } : {}),
      ...(typeof account?.["nickname"] === "string" ? { nickname: account["nickname"] } : {}),
    };
  } catch {
    return undefined;
  }
}
