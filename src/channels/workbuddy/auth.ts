import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Region = "cn" | "global";

/** 凭据的三种状态：明文可用 / 加密需解 / 读不到。 */
export type AuthKind = "plain" | "encrypted" | "missing";

export interface ParsedAuth {
  kind: AuthKind;
  region?: Region;
  token?: string;
  refreshToken?: string;
  expiresAtMs?: number;
  /** 加密时带上信封原文，交给解密器；不在这里猜密钥。 */
  envelope?: string;
}

/**
 * 品牌域名 → 区域。
 *
 * 必须精确匹配或点号后缀匹配：`codebuddy.ai.evil.com` 不能被判成 global。
 */
export function regionOfDomain(domain: string): Region | undefined {
  const d = domain.trim().toLowerCase();
  if (d === "workbuddy.ai" || d.endsWith(".workbuddy.ai")) return "global";
  if (d === "codebuddy.ai" || d.endsWith(".codebuddy.ai")) return "global";
  if (d === "workbuddy.cn" || d.endsWith(".workbuddy.cn")) return "cn";
  if (d === "codebuddy.cn" || d.endsWith(".codebuddy.cn")) return "cn";
  if (d === "copilot.tencent.com" || d.endsWith(".copilot.tencent.com")) return "cn";
  return undefined;
}

/** 本机可能放 WorkBuddy 登录态的位置，按区域分。 */
export function authCandidates(): string[] {
  const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  const roaming = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  const explicit = process.env["WORKBUDDY_AUTH_FILE"];
  const list: string[] = [];
  if (explicit !== undefined && explicit !== "") list.push(explicit);
  for (const root of [local, roaming]) {
    list.push(join(root, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop-ai.info"));
    list.push(join(root, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"));
  }
  return [...new Set(list)];
}

/**
 * 解析一份 auth 文件。
 *
 * **真实结构是嵌套的**（实测 2026-10-27，`workbuddy-desktop-ai.info`）：
 *
 * ```jsonc
 * {
 *   "account": { "uid": "...", "nickname": { "$wbEncrypted": 1, "envelope": "..." }, ... },
 *   "auth": {
 *     "accessToken":  { "$wbEncrypted": 1, "envelope": "..." },
 *     "refreshToken": { "$wbEncrypted": 1, "envelope": "..." },
 *     "domain": "www.workbuddy.ai",
 *     "expiresIn": 31465393,          // 相对秒数，不是绝对时间戳
 *     "lastRefreshTime": 1793069057595
 *   }
 * }
 * ```
 *
 * 注意三点，都是踩过的：
 * 1. token 与 domain 在 `auth` 下，不在顶层
 * 2. `expiresIn` 是相对秒数 —— 绝对过期时间要 `lastRefreshTime + expiresIn * 1000`
 * 3. **加密 token 不等于「没有 token」**：新版桌面端把 accessToken 换成
 *    `{"$wbEncrypted":1,"envelope":"…"}` 的 AES-256-GCM 信封。这里如实报告
 *    `kind: "encrypted"` 并把信封交出去，让调用方决定怎么解 —— 绝不内置密钥副本。
 *
 * 同时兼容旧版平铺结构（顶层直接有 `accessToken` / `domain`）。
 */
export function parseAuthDocument(text: string): ParsedAuth {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: "missing" };
  }

  // 新版嵌套结构优先；取不到再退回旧版平铺结构。
  const auth = (typeof doc["auth"] === "object" && doc["auth"] !== null
    ? (doc["auth"] as Record<string, unknown>)
    : doc);

  const domain = typeof auth["domain"] === "string" ? auth["domain"] : "";
  const region = regionOfDomain(domain);
  const raw = auth["accessToken"];
  const expiresAtMs = absoluteExpiry(auth);
  const refreshRaw = auth["refreshToken"];

  if (typeof raw === "string" && raw !== "") {
    return {
      kind: "plain",
      ...(region === undefined ? {} : { region }),
      token: raw,
      ...(typeof refreshRaw === "string" ? { refreshToken: refreshRaw } : {}),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    };
  }
  if (isEncryptedField(raw)) {
    return {
      kind: "encrypted",
      ...(region === undefined ? {} : { region }),
      envelope: raw.envelope,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    };
  }
  return { kind: "missing", ...(region === undefined ? {} : { region }) };
}

/** `{"$wbEncrypted":1,"envelope":"…"}` 的形状判定。 */
function isEncryptedField(value: unknown): value is { envelope: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return rec["$wbEncrypted"] !== undefined && typeof rec["envelope"] === "string";
}

/**
 * 绝对过期时间。
 *
 * 新结构给的是 `expiresIn`（相对秒）+ `lastRefreshTime`（毫秒），必须相加；
 * 旧结构直接给 `expiresAt`。两者都拿不到就不返回 —— 不猜。
 */
function absoluteExpiry(auth: Record<string, unknown>): number | undefined {
  if (typeof auth["expiresAt"] === "number") return auth["expiresAt"];
  const last = auth["lastRefreshTime"];
  const ttl = auth["expiresIn"];
  if (typeof last === "number" && typeof ttl === "number") return last + ttl * 1000;
  return undefined;
}

/** 扫描候选路径，返回第一个能读到的凭据及其来源路径。 */
export function detectCredential(): { path: string; parsed: ParsedAuth } | undefined {
  for (const path of authCandidates()) {
    if (!existsSync(path)) continue;
    try {
      return { path, parsed: parseAuthDocument(readFileSync(path, "utf8")) };
    } catch {
      continue;
    }
  }
  return undefined;
}
