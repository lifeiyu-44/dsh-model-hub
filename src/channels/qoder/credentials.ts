import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { COSY_OPENAPI_CLIENT_TYPE, COSY_OPENAPI_VERSION } from "./cosy.js";

/**
 * Qoder 凭据：PAT → jobToken 的交换与缓存。
 *
 * ## 链路
 *
 * ```
 * PAT(pt-…) ──POST /api/v1/jobToken/exchange──▶ jobToken(jt-…, 24 小时)
 *                                            └─▶ userinfo（取 uid，COSY 签名要用）
 * ```
 *
 * PAT 在 <https://qoder.com.cn/account/integrations> 自建，是官方支持的通道。
 * **PAT 不会自动续**（Qoder 官方明确「The SDK does not refresh PATs」），
 * 过期就在网页上重新生成一个；jobToken 那一层由这里自己刷。
 *
 * ## PAT 从哪读
 *
 * 1. `$DSH_HOME/qoder/pat`（本机实际位置）
 * 2. 环境变量 `QODERCN_PAT` / `QODERCN_PERSONAL_ACCESS_TOKEN` / `QODERCN_API_KEY`
 *
 * 只读明文 PAT，不碰 Qoder App 的目录（那边是 Electron safeStorage 密文）。
 */

const DEFAULT_OPENAPI = "https://openapi.qoder.com.cn";
const PATH_EXCHANGE = "/api/v1/jobToken/exchange";
const PATH_USERINFO = "/api/v1/userinfo";

/** 换来的 jobToken 剩不到这个时长就提前重换。 */
const SKEW_MS = 120_000;
/** 拿不到有效期时的保守值。 */
const ASSUMED_TTL_MS = 1_800_000;

export interface QoderSession {
  jobToken: string;
  userID: string;
  name: string;
  email: string;
  expiresAt: number;
  /** PAT 来源，诊断栏要显示。 */
  source: string;
}

export function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** 按优先级找 PAT；找不到返回 undefined（不抛）。 */
export function readPat(): { pat: string; source: string } | undefined {
  const fromEnv = ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"]
    .map((name) => ({ name, value: process.env[name] }))
    .find((entry) => typeof entry.value === "string" && entry.value.trim().startsWith("pt-"));
  if (fromEnv?.value !== undefined) return { pat: fromEnv.value.trim(), source: `env:${fromEnv.name}` };

  const candidates = [join(resolveDshHome(), "qoder", "pat"), join(homedir(), ".qoder", "pat")];
  for (const path of candidates) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.startsWith("pt-")) return { pat: value, source: path };
    } catch {
      /* 继续找下一个 */
    }
  }
  return undefined;
}

/**
 * `expires_at` 可能是 ISO 串、秒级或毫秒级数字；`expires_in` 可能是秒或毫秒。
 * 读不出来就返回 undefined（调用方按保守值处理）。
 */
export function resolveExpiry(doc: Record<string, unknown>): number | undefined {
  const at = doc["expires_at"];
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof at === "number" && Number.isFinite(at)) return at < 1e12 ? at * 1000 : at;
  const rel = doc["expires_in"];
  if (typeof rel === "number" && Number.isFinite(rel) && rel > 0) {
    return Date.now() + (rel < 1e6 ? rel * 1000 : rel);
  }
  return undefined;
}

/** 一次 PAT 交换 + userinfo。 */
async function fetchSession(pat: string, source: string, openapiBase: string): Promise<QoderSession> {
  const response = await fetch(`${openapiBase}${PATH_EXCHANGE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "dsh-model-hub",
      "Cosy-Version": COSY_OPENAPI_VERSION,
      "Cosy-ClientType": COSY_OPENAPI_CLIENT_TYPE,
    },
    body: JSON.stringify({ personal_token: pat }),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  if (!response.ok) {
    const brief = text.replace(/\s+/g, " ").slice(0, 200);
    throw new Error(
      response.status === 401 || response.status === 403
        ? `PAT 被拒绝（HTTP ${response.status}），可能已吊销或填错：${brief}`
        : `PAT 交换失败（HTTP ${response.status}）：${brief}`,
    );
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`PAT 交换返回的不是 JSON：${text.slice(0, 200)}`);
  }

  const jobToken = typeof doc["token"] === "string" ? doc["token"].trim() : "";
  if (jobToken === "") throw new Error(`PAT 交换没有返回 token：${text.slice(0, 200)}`);

  // userinfo 走 OpenAPI 平面（普通 Bearer，不需要签名）。
  // 拿不到 uid 就没法做 COSY 签名，所以这一步失败要让调用方看到。
  let userID = "";
  let name = "";
  let email = "";
  try {
    const infoResponse = await fetch(`${openapiBase}${PATH_USERINFO}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${jobToken}`,
        "User-Agent": "dsh-model-hub",
        "Cosy-Version": COSY_OPENAPI_VERSION,
        "Cosy-ClientType": COSY_OPENAPI_CLIENT_TYPE,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (infoResponse.ok) {
      const info = (await infoResponse.json()) as Record<string, unknown>;
      userID = typeof info["id"] === "string" ? info["id"] : "";
      name = typeof info["name"] === "string" ? info["name"] : "";
      email = typeof info["email"] === "string" ? info["email"] : "";
    }
  } catch {
    /* 下面统一判空 */
  }
  if (userID === "") throw new Error("userinfo 没拿到 uid —— COSY 签名需要它，检查 PAT 权限");

  return {
    jobToken,
    userID,
    name,
    email,
    expiresAt: resolveExpiry(doc) ?? Date.now() + ASSUMED_TTL_MS,
    source,
  };
}

/**
 * jobToken 管理器：单飞 + 提前重换。
 *
 * 并发调用只会打一次上游；快过期时自动重换，调用方永远拿到可用的 session。
 */
export function createSessionManager(options: { openapiBase?: string; now?: () => number } = {}) {
  const openapiBase = (options.openapiBase ?? DEFAULT_OPENAPI).replace(/\/+$/, "");
  const now = options.now ?? (() => Date.now());
  let cached: QoderSession | undefined;
  let inflight: Promise<QoderSession> | undefined;

  return {
    /** 当前可用的 session；没有凭据时返回 undefined（不抛）。 */
    async current(): Promise<QoderSession | undefined> {
      if (cached !== undefined && cached.expiresAt - now() > SKEW_MS) return cached;
      if (inflight !== undefined) return inflight.catch(() => undefined);

      const found = readPat();
      if (found === undefined) return undefined;

      inflight = fetchSession(found.pat, found.source, openapiBase)
        .then((session) => {
          cached = session;
          return session;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight.catch(() => undefined);
    },
    /** 强制重换（诊断/测试用）。 */
    invalidate(): void {
      cached = undefined;
    },
    /** 只读快照，给诊断栏用。 */
    peek(): QoderSession | undefined {
      return cached;
    },
  };
}

/** 机器码：跨次稳定（否则服务端会当成新设备）。 */
export function resolveMachineId(): string {
  const candidates = [join(homedir(), ".qoder", ".auth", "machine_id"), join(resolveDshHome(), "qoder", "machine-id")];
  for (const path of candidates) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value !== "") return value;
    } catch {
      /* 继续 */
    }
  }
  return randomUUID();
}
