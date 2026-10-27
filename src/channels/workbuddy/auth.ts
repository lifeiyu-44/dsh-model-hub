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
 * **加密 token 不等于「没有 token」**：新版桌面端把 accessToken 换成
 * `{"$wbEncrypted":1,"envelope":"…"}` 的 AES-256-GCM 信封。这里如实报告
 * `kind: "encrypted"` 并把信封交出去，让调用方决定怎么解 —— 绝不内置密钥副本。
 */
export function parseAuthDocument(text: string): ParsedAuth {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: "missing" };
  }
  const domain = typeof doc["domain"] === "string" ? doc["domain"] : "";
  const region = regionOfDomain(domain);
  const raw = doc["accessToken"];
  const expiresAtMs = typeof doc["expiresAt"] === "number" ? doc["expiresAt"] : undefined;

  if (typeof raw === "string" && raw !== "") {
    return {
      kind: "plain",
      ...(region === undefined ? {} : { region }),
      token: raw,
      ...(typeof doc["refreshToken"] === "string" ? { refreshToken: doc["refreshToken"] } : {}),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    };
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (rec["$wbEncrypted"] !== undefined) {
      return {
        kind: "encrypted",
        ...(region === undefined ? {} : { region }),
        ...(typeof rec["envelope"] === "string" ? { envelope: rec["envelope"] } : {}),
        ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      };
    }
  }
  return { kind: "missing", ...(region === undefined ? {} : { region }) };
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
