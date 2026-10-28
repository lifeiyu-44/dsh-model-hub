import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openHubDatabase } from "../src/store/db.js";
import { insertRequest, type RequestRecord } from "../src/store/requests.js";
import { seedChannelsAndAccounts } from "../src/store/seed.js";
import { createHubState } from "../src/state/hub-state.js";
import type { QoderSession } from "../src/channels/qoder/credentials.js";
import { dispatchWrite, writeGate, type WriteDeps } from "../src/routes/write.js";

/**
 * 写路由（任务 7）：writeGate 门禁矩阵 + dispatchWrite 分发器，纯函数层直测。
 *
 * 注册路由本身依赖宿主 webServer（ctx.inject(["webServer"])），不在 vitest 面内
 * ——「怎样合法拿到 webServer」由 tests/webserver-access.spec.ts 用真实 Cordis
 * 定死，registerWriteRoutes 的真实装配在任务 9 接线时验证。
 *
 * state 一律用与 hub-state.spec.ts 同款 fake runtimeFactory 造**真** hub-state：
 * 分发器对 state 的调用契约（toggle→setEnabled、delete→池空 teardown）在工厂
 * 调用序列上可观察，比 spy 假 state 更接近生产行为。
 *
 * 涉及凭据目录的用例（accounts/add、auth/one-click、account test）照
 * prober.spec 的夹具把 DSH_HOME/LOCALAPPDATA/APPDATA 钉进临时目录 ——
 * 本机真实 vault / auth / PAT 绝不进测试。
 */

const GLOBAL_CHANNEL = "hub-workbuddy-global";
const QODER_CHANNEL = "hub-qoder-cn";
const DAY = 86_400_000;

// ── 环境夹具 ──

let home = "";
const savedEnv = new Map<string, string | undefined>();

function pinEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

function newHome(): string {
  home = mkdtempSync(join(tmpdir(), "dmh-write-home-"));
  pinEnv("DSH_HOME", home);
  pinEnv("LOCALAPPDATA", join(home, "no-local"));
  pinEnv("APPDATA", join(home, "no-roaming"));
  pinEnv("WORKBUDDY_AUTH_FILE", undefined);
  for (const name of ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"]) {
    pinEnv(name, undefined);
  }
  return home;
}

// ── 库 + 真 hub-state（fake runtimeFactory）夹具 ──

interface Rig {
  db: DatabaseSync;
  state: ReturnType<typeof createHubState>;
  calls: unknown[];
  deps(options?: { proberDeps?: WriteDeps["proberDeps"]; retentionDays?: () => number }): WriteDeps;
  cleanup(): void;
}

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "dmh-write-db-"));
  const db = await openHubDatabase(join(dir, "hub.db"));
  const calls: unknown[] = [];
  const state = createHubState({
    db,
    settings: () => ({}),
    logger: {},
    runtimeFactory: async (input: unknown) => {
      calls.push(input);
      return {
        shim: { baseUrl: () => "http://127.0.0.1:1", token: () => "t", close: () => {} },
        release: () => { calls.push("release"); },
        models: [{ id: "m1" }],
        panelEntries: [{ id: "m1", name: "M1" }],
        refresh: async () => {},
        setEnabled: (b: boolean) => { calls.push(["enabled", b]); },
      };
    },
  });
  return {
    db,
    state,
    calls,
    deps: (options = {}) => ({
      state,
      db,
      proberDeps: options.proberDeps ?? {},
      ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
    }),
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// typeof [] === "object"：只数工厂入参对象，才是「建了几次 runtime」（同 hub-state.spec）。
function factoryInputsOf(calls: unknown[]): unknown[] {
  return calls.filter((c) => typeof c === "object" && !Array.isArray(c));
}

function channelEnabled(db: DatabaseSync, id: string): number {
  return (db.prepare("SELECT enabled FROM channels WHERE id = ?").get(id) as { enabled: number }).enabled;
}

function accountRow(db: DatabaseSync, id: string): { enabled: number; is_current: number; credential_ref: string | null } {
  return db.prepare("SELECT enabled, is_current, credential_ref FROM accounts WHERE id = ?").get(id) as never;
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** 造最小明细（同 retention.spec：全 0 值，只数行数）。 */
function record(requestId: string, createdAt: number): RequestRecord {
  return {
    requestId, channelId: "c", provider: "qoder", model: "glm-4.6",
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
    isStreaming: false, estimated: false, costUnits: 0, createdAt,
  };
}

interface ExchangeCall { pat: string; source: string }

function fakeExchange(rec: ExchangeCall[], behavior?: (pat: string) => void): (pat: string, source: string) => Promise<QoderSession> {
  return async (pat: string, source: string) => {
    rec.push({ pat, source });
    behavior?.(pat);
    return { jobToken: "jt-fake", userID: "uid-fake", name: "fake", email: "", expiresAt: Date.now() + 60_000, source };
  };
}

/** 在注入的 DSH_HOME 下放一个 vault 条目（同 prober.spec）。 */
function seedVault(accountId: string, token: string): string {
  const dir = join(home, "workbuddy-vault", "global");
  mkdirSync(dir, { recursive: true });
  const source = join(dir, `${accountId}.json`);
  writeFileSync(source, JSON.stringify({ auth: { accessToken: token, expiresAt: 999_999_999_999 } }));
  return source;
}

// ── writeGate：门禁矩阵 ──

describe("writeGate", () => {
  it("门禁：Origin 非回环 403；Origin 缺失 403；非 JSON 415；Host 非回环 403", () => {
    expect(writeGate({ headers: { host: "127.0.0.1:1", origin: "http://evil.com", "content-type": "application/json" } }))
      .toEqual({ ok: false, status: 403, json: { error: "origin_not_allowed" } });
    expect(writeGate({ headers: { host: "127.0.0.1:1", "content-type": "application/json" } }))
      .toEqual({ ok: false, status: 403, json: { error: "origin_not_allowed" } });
    expect(writeGate({ headers: { host: "127.0.0.1:1", origin: "http://127.0.0.1:1", "content-type": "text/html" } }))
      .toEqual({ ok: false, status: 415, json: { error: "unsupported_media_type" } });
    expect(writeGate({ headers: { host: "192.168.1.5:3000", origin: "http://127.0.0.1:1", "content-type": "application/json" } }))
      .toEqual({ ok: false, status: 403, json: { error: "host_not_allowed" } });
  });

  it("门禁：干净请求放行；回环 Origin 各形式与 charset 后缀都过；方法非 POST 405；content-type 缺失 415", () => {
    const clean = { host: "127.0.0.1:50551", origin: "http://127.0.0.1:50551", "content-type": "application/json" };
    expect(writeGate({ headers: clean, method: "POST" })).toEqual({ ok: true });
    // method 省略视为不检查（路由 handler 总是传；纯函数调用方自由裁量）
    expect(writeGate({ headers: clean })).toEqual({ ok: true });

    for (const origin of ["http://localhost:3000", "http://[::1]:9222", "http://127.0.0.1", "http://127.120.0.3:1"]) {
      expect(writeGate({ headers: { ...clean, origin }, method: "POST" })).toEqual({ ok: true });
    }
    expect(writeGate({ headers: { ...clean, "content-type": "application/json; charset=utf-8" }, method: "POST" })).toEqual({ ok: true });
    expect(writeGate({ headers: clean, method: "get" })).toEqual({ ok: false, status: 405, json: { error: "method_not_allowed" } });
    expect(writeGate({ headers: { host: "localhost", origin: "http://localhost:1" } }))
      .toEqual({ ok: false, status: 415, json: { error: "unsupported_media_type" } });
    // Origin 形如 "null"（部分浏览器场景）或任意垃圾串：解析不了就不是回环
    expect(writeGate({ headers: { host: "127.0.0.1:1", origin: "null", "content-type": "application/json" } }))
      .toEqual({ ok: false, status: 403, json: { error: "origin_not_allowed" } });
  });
});

// ── dispatchWrite：分发器 ──

describe("dispatchWrite · 渠道与账号状态", () => {
  it("分发：channel/<id>/toggle 真开真关——db 翻转，runtime 走 setEnabled 不重建（约束 8）", async () => {
    const r = await rig();
    try {
      seedChannelsAndAccounts(r.db,
        [{ id: GLOBAL_CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }],
        [{ id: `${GLOBAL_CHANNEL}:a1`, channelId: GLOBAL_CHANNEL, displayName: "A1", credentialRef: "x", isCurrent: true }]);
      await r.state.ensureRuntime(GLOBAL_CHANNEL);

      const off = await dispatchWrite(r.deps(), `/channel/${GLOBAL_CHANNEL}/toggle`, { enabled: false });
      expect(off).toEqual({ status: 200, json: { ok: true } });
      expect(channelEnabled(r.db, GLOBAL_CHANNEL)).toBe(0);
      expect(r.calls).toContainEqual(["enabled", false]);

      await dispatchWrite(r.deps(), `/channel/${GLOBAL_CHANNEL}/toggle`, { enabled: true });
      expect(channelEnabled(r.db, GLOBAL_CHANNEL)).toBe(1);
      expect(r.calls).toContainEqual(["enabled", true]);
      expect(factoryInputsOf(r.calls)).toHaveLength(1); // 开关只 setEnabled，shim 不重建
    } finally {
      r.cleanup();
    }
  });

  it("分发：account/<id>/toggle 翻转生效进池减员；enabled 缺失 → 400 bad_request", async () => {
    const r = await rig();
    try {
      seedChannelsAndAccounts(r.db,
        [{ id: QODER_CHANNEL, kind: "qoder", displayName: "Qoder CN" }],
        [
          { id: `${QODER_CHANNEL}:a1`, channelId: QODER_CHANNEL, displayName: "A1", credentialRef: "x", isCurrent: true },
          { id: `${QODER_CHANNEL}:a2`, channelId: QODER_CHANNEL, displayName: "A2", credentialRef: "y" },
        ]);

      const bad = await dispatchWrite(r.deps(), `/account/${QODER_CHANNEL}:a1/toggle`, {});
      expect(bad).toEqual({ status: 400, json: { ok: false, error: "bad_request" } });

      const off = await dispatchWrite(r.deps(), `/account/${QODER_CHANNEL}:a1/toggle`, { enabled: false });
      expect(off).toEqual({ status: 200, json: { ok: true } });
      expect(accountRow(r.db, `${QODER_CHANNEL}:a1`).enabled).toBe(0);
      expect(r.state.poolSize(QODER_CHANNEL)).toBe(1); // a1 出池，a2 还在
    } finally {
      r.cleanup();
    }
  });

  it("分发：account/<id>/make-current 后 is_current 唯一且翻转生效", async () => {
    const r = await rig();
    try {
      seedChannelsAndAccounts(r.db,
        [{ id: GLOBAL_CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }],
        [
          { id: `${GLOBAL_CHANNEL}:a1`, channelId: GLOBAL_CHANNEL, displayName: "A1", credentialRef: "x", isCurrent: true },
          { id: `${GLOBAL_CHANNEL}:a2`, channelId: GLOBAL_CHANNEL, displayName: "A2", credentialRef: "y" },
        ]);

      const out = await dispatchWrite(r.deps(), `/account/${GLOBAL_CHANNEL}:a2/make-current`, {});
      expect(out).toEqual({ status: 200, json: { ok: true } });

      const currents = r.db.prepare("SELECT id FROM accounts WHERE is_current = 1").all() as { id: string }[];
      expect(currents.map((row) => row.id)).toEqual([`${GLOBAL_CHANNEL}:a2`]); // 唯一且是 a2
      expect(accountRow(r.db, `${GLOBAL_CHANNEL}:a1`).is_current).toBe(0);
    } finally {
      r.cleanup();
    }
  });

  it("分发：账号不存在的 toggle/make-current/delete → 404 account_not_found（不做假成功）", async () => {
    const r = await rig();
    try {
      for (const op of ["toggle", "make-current", "delete"]) {
        const out = await dispatchWrite(
          r.deps(),
          `/account/${QODER_CHANNEL}:ghost/${op}`,
          op === "toggle" ? { enabled: false } : {},
        );
        expect(out).toEqual({ status: 404, json: { ok: false, error: "account_not_found" } });
      }
    } finally {
      r.cleanup();
    }
  });

  it("分发：account/<id>/test 走真 prober（注入 exchangePat），返回 {ok,detail,ms}", async () => {
    newHome();
    const r = await rig();
    try {
      pinEnv("DMH_WRITE_TEST_PAT", "pt-envpat99x");
      seedChannelsAndAccounts(r.db,
        [{ id: QODER_CHANNEL, kind: "qoder", displayName: "Qoder CN" }],
        [{ id: `${QODER_CHANNEL}:e1`, channelId: QODER_CHANNEL, displayName: "E1", credentialRef: "env:DMH_WRITE_TEST_PAT", isCurrent: true }]);
      const calls: ExchangeCall[] = [];

      const out = await dispatchWrite(
        r.deps({ proberDeps: { exchangePat: fakeExchange(calls) } }),
        `/account/${QODER_CHANNEL}:e1/test`,
        {},
      );

      expect(out.status).toBe(200);
      const doc = out.json as { ok: boolean; detail: string; ms: number };
      expect(doc.ok).toBe(true);
      expect(typeof doc.ms).toBe("number");
      expect(calls).toEqual([{ pat: "pt-envpat99x", source: "env:DMH_WRITE_TEST_PAT" }]);
    } finally {
      r.cleanup();
    }
  });

  it("分发：路径 id 经 encodeURIComponent（冒号→%3A）也能命中", async () => {
    const r = await rig();
    try {
      seedChannelsAndAccounts(r.db,
        [{ id: QODER_CHANNEL, kind: "qoder", displayName: "Qoder CN" }],
        [{ id: `${QODER_CHANNEL}:a1`, channelId: QODER_CHANNEL, displayName: "A1", credentialRef: "x", isCurrent: true }]);

      const encoded = encodeURIComponent(`${QODER_CHANNEL}:a1`);
      expect(encoded).toBe("hub-qoder-cn%3Aa1");
      const out = await dispatchWrite(r.deps(), `/account/${encoded}/toggle`, { enabled: false });
      expect(out).toEqual({ status: 200, json: { ok: true } });
      expect(accountRow(r.db, `${QODER_CHANNEL}:a1`).enabled).toBe(0);
    } finally {
      r.cleanup();
    }
  });
});

describe("dispatchWrite · 记录管理", () => {
  it("分发：records/prune 返回 {removed}", async () => {
    const r = await rig(); // deps 不带 retentionDays → 用缺省 90
    try {
      const now = Date.now();
      insertRequest(r.db, record("old1", now - 100 * DAY));
      insertRequest(r.db, record("old2", now - 95 * DAY));
      insertRequest(r.db, record("old3", now - 91 * DAY));
      insertRequest(r.db, record("recent", now - 1 * DAY));

      const out = await dispatchWrite(r.deps(), "/records/prune", { days: 90 });
      expect(out).toEqual({ status: 200, json: { removed: 3 } });
      expect(countRows(r.db, "requests")).toBe(1); // 只剩 recent
    } finally {
      r.cleanup();
    }
  });

  it("分发：records/prune 无 days 时用 WriteDeps.retentionDays；body days 显式传入时优先", async () => {
    const r = await rig();
    try {
      const now = Date.now();
      insertRequest(r.db, record("a", now - 30 * DAY));
      insertRequest(r.db, record("b", now - 20 * DAY));
      insertRequest(r.db, record("c", now - 3 * DAY));

      const byGetter = await dispatchWrite(r.deps({ retentionDays: () => 7 }), "/records/prune", {});
      expect(byGetter).toEqual({ status: 200, json: { removed: 2 } }); // 30d/20d 都超 7 天，3d 留下
      expect(countRows(r.db, "requests")).toBe(1);

      const byBody = await dispatchWrite(r.deps({ retentionDays: () => 7 }), "/records/prune", { days: 2 });
      expect(byBody).toEqual({ status: 200, json: { removed: 1 } }); // body days=2（getter 是 7）：显式优先，3d 被删
      expect(countRows(r.db, "requests")).toBe(0);

      const bad = await dispatchWrite(r.deps(), "/records/prune", { days: "30" });
      expect(bad).toEqual({ status: 400, json: { ok: false, error: "bad_request" } });
    } finally {
      r.cleanup();
    }
  });

  it("分发：records/clear 清 requests 与 daily_rollups", async () => {
    const r = await rig();
    try {
      const now = Date.now();
      insertRequest(r.db, record("r1", now - 2 * DAY));
      insertRequest(r.db, record("r2", now));
      expect(countRows(r.db, "requests")).toBe(2);
      expect(countRows(r.db, "daily_rollups")).toBe(2); // 相隔两天 → 两行聚合

      const out = await dispatchWrite(r.deps(), "/records/clear", {});
      expect(out).toEqual({ status: 200, json: { ok: true } });
      expect(countRows(r.db, "requests")).toBe(0);
      expect(countRows(r.db, "daily_rollups")).toBe(0);
    } finally {
      r.cleanup();
    }
  });
});

describe("dispatchWrite · 分发边界与账号增删", () => {
  it("分发：未知路径 404；delete 后渠道池空时 state 收到 syncChannelRuntime", async () => {
    const r = await rig();
    try {
      seedChannelsAndAccounts(r.db,
        [{ id: QODER_CHANNEL, kind: "qoder", displayName: "Qoder CN" }],
        [
          { id: `${QODER_CHANNEL}:a1`, channelId: QODER_CHANNEL, displayName: "A1", credentialRef: "x", isCurrent: true },
          { id: `${QODER_CHANNEL}:a2`, channelId: QODER_CHANNEL, displayName: "A2", credentialRef: "y" },
        ]);
      await r.state.ensureRuntime(QODER_CHANNEL);

      expect(await dispatchWrite(r.deps(), "/nonsense", {}))
        .toEqual({ status: 404, json: { ok: false, error: "not_found" } });
      expect(await dispatchWrite(r.deps(), `/account/${QODER_CHANNEL}:a1/frobnicate`, {}))
        .toEqual({ status: 404, json: { ok: false, error: "not_found" } });
      expect(await dispatchWrite(r.deps(), "/records/frobnicate", {}))
        .toEqual({ status: 404, json: { ok: false, error: "not_found" } });

      // 删第一个：池还剩 a2（软删自动晋升），runtime 不动
      expect(await dispatchWrite(r.deps(), `/account/${QODER_CHANNEL}:a1/delete`, {}))
        .toEqual({ status: 200, json: { ok: true } });
      expect(r.calls).not.toContain("release");

      // 删第二个：可用账号数归零 → 状态机同步（syncChannelRuntime 落点）整体拆除
      expect(await dispatchWrite(r.deps(), `/account/${QODER_CHANNEL}:a2/delete`, {}))
        .toEqual({ status: 200, json: { ok: true } });
      expect(r.calls).toContain("release");
      expect(r.state.poolSize(QODER_CHANNEL)).toBe(0);
    } finally {
      r.cleanup();
    }
  });

  it("分发：accounts/add WorkBuddy——vault 幂等导入，credential_ref 存引用，池非空 ensureRuntime", async () => {
    newHome();
    const r = await rig();
    try {
      const vaultSource = seedVault("acc-main", "vault-tok-1");

      const first = await dispatchWrite(r.deps(), "/accounts/add", { channelId: GLOBAL_CHANNEL });
      expect(first).toEqual({ status: 200, json: { ok: true, added: [`${GLOBAL_CHANNEL}:acc-main`] } });
      // 凭据只存引用（文件路径），绝不落明文
      expect(r.db.prepare("SELECT id, channel_id, credential_ref FROM accounts").all()).toEqual([
        { id: `${GLOBAL_CHANNEL}:acc-main`, channel_id: GLOBAL_CHANNEL, credential_ref: vaultSource },
      ]);
      expect(r.db.prepare("SELECT kind FROM channels WHERE id = ?").get(GLOBAL_CHANNEL)).toEqual({ kind: "workbuddy" });
      expect(factoryInputsOf(r.calls)).toHaveLength(1); // 池非空 → ensureRuntime 真建了 runtime

      const second = await dispatchWrite(r.deps(), "/accounts/add", { channelId: GLOBAL_CHANNEL });
      expect(second).toEqual({ status: 200, json: { ok: true, added: [] } }); // 已存在：幂等跳过
      expect(factoryInputsOf(r.calls)).toHaveLength(1); // 已有 runtime 不重建
    } finally {
      r.cleanup();
    }
  });

  it("分发：accounts/add Qoder——贴 PAT 入库；格式不对 → 400 且不落盘不入库", async () => {
    newHome();
    const r = await rig();
    try {
      const calls: ExchangeCall[] = [];
      const deps = () => r.deps({ proberDeps: { exchangePat: fakeExchange(calls) } });

      const ok = await dispatchWrite(deps(), "/accounts/add", { channelId: QODER_CHANNEL, pat: "pt-abcdef123456", displayName: "Work Main" });
      expect(ok).toEqual({ status: 200, json: { ok: true, added: [`${QODER_CHANNEL}:work-main`] } });
      const patPath = join(home, "model-hub", "qoder-pats", "work-main.pat");
      expect(existsSync(patPath)).toBe(true);
      expect(accountRow(r.db, `${QODER_CHANNEL}:work-main`).credential_ref).toBe(patPath);

      const bad = await dispatchWrite(deps(), "/accounts/add", { channelId: QODER_CHANNEL, pat: "pt-short" });
      expect(bad.status).toBe(400);
      expect((bad.json as { error: string }).error).toContain("PAT 格式不对");
      expect(countRows(r.db, "accounts")).toBe(1); // 没多出行
    } finally {
      r.cleanup();
    }
  });

  it("分发：accounts/add Qoder——验活失败 → 400 带原文，刚写的文件被删、不入库", async () => {
    newHome();
    const r = await rig();
    try {
      const failing = async () => { throw new Error("PAT 被拒绝（HTTP 401），可能已吊销或填错"); };
      const out = await dispatchWrite(
        r.deps({ proberDeps: { exchangePat: failing } }),
        "/accounts/add",
        { channelId: QODER_CHANNEL, pat: "pt-doomed00123", displayName: "Doomed" },
      );

      expect(out.status).toBe(400);
      expect((out.json as { error: string }).error).toContain("HTTP 401");
      expect(existsSync(join(home, "model-hub", "qoder-pats", "doomed.pat"))).toBe(false); // 不留死 PAT
      expect(countRows(r.db, "accounts")).toBe(0);
    } finally {
      r.cleanup();
    }
  });

  it("分发：accounts/add 未知渠道 / 缺 channelId → 400 unknown_channel", async () => {
    const r = await rig();
    try {
      expect(await dispatchWrite(r.deps(), "/accounts/add", { channelId: "hub-other" }))
        .toEqual({ status: 400, json: { ok: false, error: "unknown_channel" } });
      expect(await dispatchWrite(r.deps(), "/accounts/add", {}))
        .toEqual({ status: 400, json: { ok: false, error: "unknown_channel" } });
    } finally {
      r.cleanup();
    }
  });

  it("分发：auth/one-click 返回两渠道三态报告（裸机 → 双 missing）", async () => {
    newHome();
    const r = await rig();
    try {
      const out = await dispatchWrite(r.deps(), "/auth/one-click", {});

      expect(out.status).toBe(200);
      const doc = out.json as { channels: { id: string; status: string; accountsAdded: number }[]; at: number };
      expect(doc.channels.map((c) => c.id)).toEqual([GLOBAL_CHANNEL, QODER_CHANNEL]);
      expect(doc.channels.every((c) => c.status === "missing")).toBe(true);
      expect(doc.channels.every((c) => c.accountsAdded === 0)).toBe(true);
      expect(typeof doc.at).toBe("number");
      expect(factoryInputsOf(r.calls)).toHaveLength(0); // 没有账号就不该碰 runtime
    } finally {
      r.cleanup();
    }
  });
});
