import type { DatabaseSync } from "node:sqlite";
import { DATA_PREFIX } from "./data.js";
import { PROVIDER_PREFIX } from "../constants.js";
import { listVaultEntries } from "../channels/workbuddy/vault.js";
import { addQoderPat, oneClickAuth, testAccount, type ProberDeps } from "../probe/prober.js";
import { queryAccounts } from "../store/queries.js";
import { pruneRequests, clearRecords } from "../store/retention.js";
import { seedChannelsAndAccounts, type AccountSeed } from "../store/seed.js";
import type { HubState } from "../state/hub-state.js";

/**
 * 写路由（门禁 + 分发器）：面板的全部改状态操作走这九条 POST。
 *
 * ## 分层
 *
 * `registerWriteRoutes` 只做宿主装配（照 `data.ts` 的
 * `ctx.inject(["webServer"], …)` 模式：回调收到的 ctx 才带 webServer，注册
 * 整体 try/catch——注册失败只影响面板，绝不能让宿主加载期 fatal）；真正的
 * 门禁（`writeGate`）与分发（`dispatchWrite`）是**纯函数**，vitest 直接打
 * 这一层，宿主 webServer 不进测试面。
 *
 * ## 门禁（约束 7，不得削弱）
 *
 * Host 回环（与 data.ts 同款判定）→ Origin **存在且回环** → content-type 含
 * application/json → 方法是 POST。状态码矩阵：403/403/415/405；body 超限
 * 413、JSON 坏 400、未知路径 404 在 handler/分发器里给出。
 *
 * ## 为什么是一条 prefix 路由而不是九条 exact
 *
 * 账号 id 含用户输入（`hub-qoder-cn:<slug>`），运行时还会增删——exact 逐条
 * 注册永远跟不上账号表。宿主匹配顺序是「先 exact 后最长前缀」，所以 data.ts
 * 的只读 exact 路由不受影响；命名空间内的未知路径由 dispatchWrite 统一 404，
 * 不会漏给 SPA fallback。路由表本身（九个操作的形态）在 dispatchWrite 里逐字
 * 对齐简报，未来加操作就是加一个分支。
 *
 * ## 并发纪律（裁定 3）
 *
 * dispatchWrite 是单请求单次的直调：每个操作最多发**一次**探测
 * （testAccount/addQoderPat 各只调一回，无 Promise.all、无重试）。
 * testAccount/addQoderPat 天然单请求串行，不做服务端锁。
 */

export interface WriteDeps {
  state: HubState;
  db: DatabaseSync;
  proberDeps: ProberDeps;
  /**
   * 记录保留天数（`records/prune` body 无 days 时用）。getter 每次现读：
   * 生产侧任务 9 传 settings getter，改设置即时生效；缺省 90。
   */
  retentionDays?: () => number;
}

type WriteVerdict = { ok: true } | { ok: false; status: number; json: unknown };

/** 账号 id 派生：与 prober.ts / index.ts 同源不同处（不为取常量改别人模块）。 */
const PROVIDER_GLOBAL = `${PROVIDER_PREFIX}workbuddy-global`;
const PROVIDER_QODER = `${PROVIDER_PREFIX}qoder-cn`;

/** 写 body 上限（约束 7）。超限立即 413 并 destroy，绝不能把内存读爆。 */
const WRITE_BODY_LIMIT = 64 * 1024;

// ── 门禁 ──

/** 与 data.ts 的 LOOPBACK 判定一致（那边未导出且本任务不改它，此处镜像）。 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (LOOPBACK.has(name)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * Origin 的宿主部分是回环才放行。解析不了（如字面量 "null"、任意垃圾串）
 * 一律不算回环 —— 门禁的默认答案是拒。
 */
function originIsLoopback(origin: string): boolean {
  try {
    return hostIsLoopback(new URL(origin).host);
  } catch {
    return false;
  }
}

/**
 * 写门禁：Host 回环 + Origin 存在且回环 + content-type 含 application/json
 * （+ method 提供时必须是 POST）。返回 `{ok:false}` 时 status/json 由调用方
 * 原样回给客户端；错误 json 统一 `{error}` 形状（与 data.ts 的只读门禁一致）。
 */
export function writeGate(req: { headers?: any; method?: string }): WriteVerdict {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  if (!hostIsLoopback(typeof headers["host"] === "string" ? headers["host"] : undefined)) {
    return { ok: false, status: 403, json: { error: "host_not_allowed" } };
  }
  const origin = headers["origin"];
  // curl 与跨源页面都不带 Origin 或带非回环 Origin：写操作比只读更严，必须存在且回环
  if (typeof origin !== "string" || !originIsLoopback(origin)) {
    return { ok: false, status: 403, json: { error: "origin_not_allowed" } };
  }
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
    return { ok: false, status: 415, json: { error: "unsupported_media_type" } };
  }
  if (req.method !== undefined && String(req.method).toUpperCase() !== "POST") {
    return { ok: false, status: 405, json: { error: "method_not_allowed" } };
  }
  return { ok: true };
}

// ── 分发器 ──

const OK = { status: 200, json: { ok: true } } as const;
const BAD_REQUEST = { status: 400, json: { ok: false, error: "bad_request" } } as const;
const NOT_FOUND = { status: 404, json: { ok: false, error: "not_found" } } as const;
const ACCOUNT_NOT_FOUND = { status: 404, json: { ok: false, error: "account_not_found" } } as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 路径切段并逐段解码：客户端对 id 做了 encodeURIComponent（`:` → `%3A`）。 */
function segmentsOf(path: string): string[] {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // 坏转义按字面量处理，让匹配自然落到 404
      }
    });
}

/** 未删账号的渠道 id；不存在（含软删）返回 undefined。queryAccounts 已滤 deleted。 */
function liveChannelOf(db: DatabaseSync, accountId: string): string | undefined {
  return (queryAccounts(db) as { id: string; channel_id: string }[]).find((row) => row.id === accountId)?.channel_id;
}

/**
 * 写操作分发。path 形如 "/channel/<id>/toggle"、"account/<id>/test"、
 * "accounts/add"、"auth/one-click"、"records/prune"、"records/clear"
 * （首导线可有可无，段会解码）。错误响应统一 `{ok:false,error}` 形状；
 * 操作自身的意外异常折成 500，绝不冒给宿主 webServer。
 */
export async function dispatchWrite(
  deps: WriteDeps,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  try {
    return await route(deps, segmentsOf(path), body);
  } catch (error) {
    // 上游探测/状态机的异常对客户端是 500 + 文案（prober 侧已 redact，无凭据明文）
    return { status: 500, json: { ok: false, error: messageOf(error) } };
  }
}

async function route(
  deps: WriteDeps,
  segments: string[],
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const head = segments[0];
  const second = segments[1];
  const third = segments[2];

  if (head === "channel" && second !== undefined && third === "toggle" && segments.length === 3) {
    if (typeof body.enabled !== "boolean") return BAD_REQUEST;
    await deps.state.setChannelEnabled(second, body.enabled);
    return OK;
  }

  if (head === "account" && second !== undefined && segments.length === 3) {
    return accountOp(deps, second, third, body);
  }

  if (head === "accounts" && second === "add" && segments.length === 2) {
    return addAccounts(deps, body);
  }

  if (head === "auth" && second === "one-click" && segments.length === 2) {
    return { status: 200, json: await oneClickAuth(deps.proberDeps, deps.db, deps.state) };
  }

  if (head === "records" && segments.length === 2) {
    if (second === "prune") return pruneRecords(deps, body);
    if (second === "clear") {
      clearRecords(deps.db);
      return OK;
    }
  }

  return NOT_FOUND;
}

async function accountOp(
  deps: WriteDeps,
  accountId: string,
  op: string | undefined,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  if (op === "test") {
    // 测试按钮的「成功/失败」是探测结论（HTTP 仍是 200）；不预检存在性 ——
    // prober 对缺失账号有自己的 {ok:false} 文案，留给面板展示。
    return { status: 200, json: await testAccount(deps.proberDeps, deps.db, deps.state, accountId) };
  }
  if (op === "toggle") {
    if (typeof body.enabled !== "boolean") return BAD_REQUEST;
    if (liveChannelOf(deps.db, accountId) === undefined) return ACCOUNT_NOT_FOUND;
    await deps.state.setAccountEnabled(accountId, body.enabled);
    return OK;
  }
  if (op === "make-current") {
    // hub-state.makeCurrent 需要 (channelId, accountId)：归属从库里现查，
    // 顺带拦下「对不存在/软删账号做操作」的假成功
    const channelId = liveChannelOf(deps.db, accountId);
    if (channelId === undefined) return ACCOUNT_NOT_FOUND;
    await deps.state.makeCurrent(channelId, accountId);
    return OK;
  }
  if (op === "delete") {
    if (liveChannelOf(deps.db, accountId) === undefined) return ACCOUNT_NOT_FOUND;
    // 池空的同步在 hub-state.deleteAccount 内部完成（syncCore teardown）
    await deps.state.deleteAccount(accountId);
    return OK;
  }
  return NOT_FOUND;
}

/**
 * accounts/add：WorkBuddy {channelId} 走 vault 幂等导入（裁定 2：在 write.ts
 * 内实现，不新增 prober 导出）；Qoder {channelId,pat,displayName?} 走 addQoderPat。
 * 成功统一返回 {ok:true, added}，失败 400 带文案（addQoderPat 的文案已过 redact）。
 */
async function addAccounts(
  deps: WriteDeps,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const channelId = typeof body.channelId === "string" ? body.channelId : "";

  if (channelId === PROVIDER_GLOBAL) {
    // 与 oneClickAuth 的 WB 分支同构：已存在（live）id 跳过不计入 added；
    // 渠道一个 live 账号都没有时，首个新账号顶 current（池序本就兜底）
    const entries = listVaultEntries();
    const live = queryAccounts(deps.db) as { id: string; channel_id: string }[];
    const liveIds = new Set(live.map((row) => row.id));
    const channelHasLive = live.some((row) => row.channel_id === PROVIDER_GLOBAL);
    const fresh: AccountSeed[] = [];
    for (const entry of entries) {
      const id = `${PROVIDER_GLOBAL}:${entry.accountId}`;
      if (liveIds.has(id)) continue;
      fresh.push({
        id,
        channelId: PROVIDER_GLOBAL,
        displayName: entry.accountId,
        credentialRef: entry.source, // 凭据只存引用（vault 文件路径），绝不落明文
        isCurrent: fresh.length === 0 && !channelHasLive,
      });
    }
    if (fresh.length > 0) {
      // seedChannelsAndAccounts 内部走 upsertOneAccount（软删守卫）并补渠道行 +
      // 事务：渠道行必须存在，否则 hub-state 的 syncCore 会因查不到渠道而空转
      seedChannelsAndAccounts(
        deps.db,
        [{ id: PROVIDER_GLOBAL, kind: "workbuddy", displayName: "WorkBuddy Global" }],
        fresh,
      );
    }
    // 池非空才 ensure：池空建 runtime 必因拉不到目录而空转（与 oneClickAuth 同口径）
    if (deps.state.poolSize(PROVIDER_GLOBAL) > 0) await deps.state.ensureRuntime(PROVIDER_GLOBAL);
    return { status: 200, json: { ok: true, added: fresh.map((account) => account.id) } };
  }

  if (channelId === PROVIDER_QODER) {
    const pat = body.pat;
    if (typeof pat !== "string") return BAD_REQUEST;
    const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
    try {
      const { accountId } = await addQoderPat(deps.proberDeps, deps.db, deps.state, pat, displayName);
      return { status: 200, json: { ok: true, added: [accountId] } };
    } catch (error) {
      // 格式不对 / 验活失败都是调用方输入问题：400 + 文案（已 redact，无 PAT 全文）
      return { status: 400, json: { ok: false, error: messageOf(error) } };
    }
  }

  return { status: 400, json: { ok: false, error: "unknown_channel" } };
}

function pruneRecords(deps: WriteDeps, body: Record<string, unknown>): { status: number; json: unknown } {
  const rawDays = body.days;
  // 缺省从注入 getter 现读（改设置即时生效），没注入再落到 90；显式 days 优先
  const days = rawDays === undefined ? (deps.retentionDays?.() ?? 90) : rawDays;
  if (typeof days !== "number" || !Number.isFinite(days)) return BAD_REQUEST;
  return { status: 200, json: { removed: pruneRequests(deps.db, days) } };
}

// ── 宿主装配 ──

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * 收 body：累计超 64KB 立即 413 并 destroy（简报具体化）。返回 null 表示
 * 已经答过（413 / 连接错误），调用方直接收工。
 */
function collectBody(req: any, res: any): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    const finish = (value: string | null) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return; // destroy 后还可能派发已排队的事件，不能再写响应
      size += chunk.length;
      if (size > WRITE_BODY_LIMIT) {
        json(res, 413, { ok: false, error: "payload_too_large" });
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

async function handleWrite(req: any, res: any, deps: WriteDeps, logger: any): Promise<void> {
  try {
    const verdict = writeGate(req);
    if (!verdict.ok) {
      json(res, verdict.status, verdict.json);
      return;
    }
    const raw = await collectBody(req, res);
    if (raw === null) return; // 413 / 连接中断，响应已了结

    let body: Record<string, unknown>;
    if (raw.trim() === "") {
      body = {}; // make-current/test 等不带 body 的 POST 按空对象处理
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        json(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      // 分发器契约是键值对象：数组/标量/null 一律 400，不假装能分发
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        json(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      body = parsed as Record<string, unknown>;
    }

    const rest = pathAfterPrefix(req.url);
    const out = await dispatchWrite(deps, rest, body);
    json(res, out.status, out.json);
  } catch (error) {
    // handler 级兜底：宿主对抛错的请求回 400，那不是我们的错误形状 —— 自己折成 500
    logger?.error?.("dsh-model-hub: 写路由处理失败", error);
    if (!res.headersSent) json(res, 500, { ok: false, error: messageOf(error) });
  }
}

/** 剥掉路由前缀与 query，剩下的交给分发器（"/account/x%3Ay/toggle" 形态）。 */
function pathAfterPrefix(url: string | undefined): string {
  const withoutQuery = (url ?? "/").split("?")[0] ?? "/";
  return withoutQuery.startsWith(`${DATA_PREFIX}/`) ? withoutQuery.slice(DATA_PREFIX.length) : withoutQuery;
}

/**
 * 注册写路由（整体 try/catch：注册失败只记 error，面板写操作不可用，
 * provider 与宿主不受影响 —— 本项目最痛的教训）。
 */
export function registerWriteRoutes(
  ctx: { inject: (deps: string[], cb: (inner: any) => void) => void; logger?: any },
  deps: WriteDeps,
): void {
  ctx.inject(["webServer"], (inner: any) => {
    try {
      const dispose = inner.webServer.register({
        kind: "prefix",
        path: `${DATA_PREFIX}/`,
        handler: (req: any, res: any) => {
          void handleWrite(req, res, deps, inner.logger);
        },
      });
      inner.effect(() => dispose, "dsh-model-hub: write routes");
    } catch (error) {
      inner.logger?.error?.("dsh-model-hub: 写路由注册失败（面板写操作不可用，provider 不受影响）", error);
    }
  });
}
