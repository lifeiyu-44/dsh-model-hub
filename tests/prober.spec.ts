import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts, type AccountSeed, type ChannelSeed } from "../src/store/seed.js";
import { markAccountResult } from "../src/store/mutations.js";
import { queryAccounts } from "../src/store/queries.js";
import type { HubState } from "../src/state/hub-state.js";
import type { QoderSession } from "../src/channels/qoder/credentials.js";
import {
  addQoderPat, oneClickAuth, testAccount,
  type OneClickChannel, type ProberDeps,
} from "../src/probe/prober.js";

/**
 * prober（一键认证 / 单账号测试 / 贴 PAT 添加）。
 *
 * 全部网络面用假实现（fetchImpl / exchangePat 注入），全部文件面用真实临时
 * 目录（DSH_HOME / LOCALAPPDATA / APPDATA 钉进 mkdtemp）—— 要测的就是
 * 「文件落在注入的 home 下」这件事，mock 掉文件系统反而测不到。
 */

const GLOBAL_CHANNEL = "hub-workbuddy-global";
const QODER_CHANNEL = "hub-qoder-cn";

// ── 夹具 ──

let home: string;
let db: DatabaseSync | undefined;
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
  db?.close();
  db = undefined;
});

async function freshDb(): Promise<DatabaseSync> {
  db = await openHubDatabase(join(mkdtempSync(join(tmpdir(), "prober-db-")), "hub.db"));
  return db;
}

function newHome(): string {
  home = mkdtempSync(join(tmpdir(), "prober-home-"));
  // 钉环境：vault 扫描走 DSH_HOME（dsh-home-paths 现读），auth 候选走
  // LOCALAPPDATA/APPDATA/WORKBUDDY_AUTH_FILE（authCandidates 现读）——
  // 全指向临时目录，本机真实凭据绝不进测试。
  pinEnv("DSH_HOME", home);
  pinEnv("LOCALAPPDATA", join(home, "no-local"));
  pinEnv("APPDATA", join(home, "no-roaming"));
  pinEnv("WORKBUDDY_AUTH_FILE", undefined);
  for (const name of ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"]) {
    pinEnv(name, undefined);
  }
  return home;
}

/** 只实现 prober 会用的三个方法的假 HubState；poolSize 从真库现算。 */
function fakeState(database: DatabaseSync): { calls: string[]; state: HubState } {
  const calls: string[] = [];
  const state = {
    ensureRuntime: async (channelId: string) => { calls.push(`ensureRuntime:${channelId}`); },
    syncChannelRuntime: async (channelId: string) => { calls.push(`syncChannelRuntime:${channelId}`); },
    poolSize: (channelId: string) =>
      (queryAccounts(database) as { channel_id: string }[]).filter((r) => r.channel_id === channelId).length,
  };
  return { calls, state: state as unknown as HubState };
}

interface ExchangeCall { pat: string; source: string }

function fakeExchange(rec: ExchangeCall[], behavior?: (pat: string, source: string) => void):
  (pat: string, source: string) => Promise<QoderSession> {
  return async (pat: string, source: string) => {
    rec.push({ pat, source });
    behavior?.(pat, source);
    return { jobToken: "jt-fake", userID: "uid-fake-1", name: "fake", email: "", expiresAt: Date.now() + 60_000, source };
  };
}

/** 假 /v3/config：状态码可指定，记录收到的 URL 与请求头。 */
function fakeCatalogFetch(status: number) {
  const seen: { url: string; authorization: string }[] = [];
  const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: String(input), authorization: String(init?.headers?.["Authorization"] ?? "") });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data: { models: [{ id: "hy3", name: "Hy3", maxInputTokens: 200_000, maxOutputTokens: 32_000, credits: "", supportsImages: false, supportsToolCall: true }] } }),
      text: async () => "unauthorized",
    };
  }) as unknown as typeof fetch;
  return { seen, fetchImpl: impl };
}

function writeWorkbuddyAuth(path: string, doc: unknown): string {
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

function plainAuthDoc(token: string, domain = "www.workbuddy.ai"): unknown {
  return { auth: { accessToken: token, domain, expiresIn: 3_000, lastRefreshTime: 1_700_000_000_000 } };
}

function seedVault(accountId: string, token: string): string {
  const dir = join(home, "workbuddy-vault", "global");
  mkdirSync(dir, { recursive: true });
  const source = join(dir, `${accountId}.json`);
  writeFileSync(source, JSON.stringify({ auth: { accessToken: token, expiresAt: 999_999_999_999 } }));
  return source;
}

function writePatFile(name: string, pat: string): string {
  const dir = join(home, "model-hub", "qoder-pats");
  mkdirSync(dir, { recursive: true });
  const source = join(dir, name);
  writeFileSync(source, pat);
  return source;
}

function seedAccount(database: DatabaseSync, id: string, credentialRef: string): void {
  const channel: ChannelSeed = { id: QODER_CHANNEL, kind: "qoder", displayName: "Qoder CN" };
  const account: AccountSeed = { id, channelId: QODER_CHANNEL, displayName: "A", credentialRef, isCurrent: true };
  seedChannelsAndAccounts(database, [channel], [account]);
}

function channelOf(report: { channels: OneClickChannel[] }, id: string): OneClickChannel {
  const found = report.channels.find((c) => c.id === id);
  expect(found, `报告里应有渠道 ${id}`).toBeDefined();
  return found!;
}

// ── oneClickAuth ──

describe("oneClickAuth · WorkBuddy", () => {
  it("裸机：两渠道都在报告里且 status=missing，WB 合成来源列出搜索路径，不建 runtime", async () => {
    newHome();
    const database = await freshDb();
    const { calls, state } = fakeState(database);

    const report = await oneClickAuth({}, database, state);

    expect(typeof report.at).toBe("number");
    expect(report.channels.map((c) => c.id)).toEqual([GLOBAL_CHANNEL, QODER_CHANNEL]);
    const wb = channelOf(report, GLOBAL_CHANNEL);
    expect(wb.status).toBe("missing");
    expect(wb.accountsAdded).toBe(0);
    // 规格 §7：失败提示要说缺什么 —— 零来源时合成一条，把搜索过的候选路径亮出来
    expect(wb.sources).toHaveLength(1);
    expect(wb.sources[0]).toMatchObject({ status: "missing" });
    expect(wb.sources[0].detail).toContain("已搜索");
    expect(wb.sources[0].detail).toContain("CodeBuddyExtension");
    expect(channelOf(report, QODER_CHANNEL)).toMatchObject({ status: "missing", sources: [], accountsAdded: 0 });
    expect(calls).toEqual([]); // 没有账号就不该碰 runtime
  });

  it("明文 auth 文件 → ok；加密信封 → encrypted；渠道级 partial", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const plainPath = writeWorkbuddyAuth(join(home, "plain.info"), plainAuthDoc("wb-plain-token"));
    pinEnv("WORKBUDDY_AUTH_FILE", plainPath);
    // 第二个候选放加密信封（authCandidates 的 LOCALAPPDATA 固定路径，钉进临时目录）
    pinEnv("LOCALAPPDATA", home);
    mkdirSync(join(home, "CodeBuddyExtension", "Data", "Public", "auth"), { recursive: true });
    writeWorkbuddyAuth(
      join(home, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop-ai.info"),
      { auth: { accessToken: { $wbEncrypted: 1, envelope: "ZmFrZQ==" }, domain: "www.workbuddy.ai" } },
    );

    const report = await oneClickAuth({}, database, state);
    const wb = channelOf(report, GLOBAL_CHANNEL);

    const plain = wb.sources.find((s) => s.source === plainPath);
    expect(plain?.status).toBe("ok");
    const encrypted = wb.sources.find((s) => s.source.endsWith("workbuddy-desktop-ai.info"));
    expect(encrypted?.status).toBe("encrypted");
    expect(wb.status).toBe("partial"); // 部分 ok、部分 encrypted
    // detail 只出现路径，不出现 token 明文
    expect(plain?.detail).toContain(plainPath);
    expect(JSON.stringify(report)).not.toContain("wb-plain-token");
  });

  it("vault 条目 → ok + upsert 账号（accountsAdded=1）+ ensureRuntime；再跑幂等 accountsAdded=0", async () => {
    newHome();
    const database = await freshDb();
    const { calls, state } = fakeState(database);
    const vaultSource = seedVault("acc-main", "vault-token-1");

    const first = await oneClickAuth({}, database, state);
    const wb = channelOf(first, GLOBAL_CHANNEL);
    expect(wb.status).toBe("ok"); // 唯一来源 ok
    expect(wb.accountsAdded).toBe(1);
    expect(wb.sources).toEqual([{ source: vaultSource, status: "ok", detail: expect.stringContaining(vaultSource) }]);

    // queryAccounts 有意不投影 credential_ref（凭据不出存储层），断言引用直读库
    const rows = database.prepare("SELECT id, channel_id, credential_ref FROM accounts").all() as
      { id: string; channel_id: string; credential_ref: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `${GLOBAL_CHANNEL}:acc-main`, channel_id: GLOBAL_CHANNEL, credential_ref: vaultSource });
    expect(calls).toContain(`ensureRuntime:${GLOBAL_CHANNEL}`);

    const second = await oneClickAuth({}, database, state);
    expect(channelOf(second, GLOBAL_CHANNEL).accountsAdded).toBe(0); // 已存在：幂等跳过不计数
    expect(queryAccounts(database)).toHaveLength(1);
  });

  it("显式 WORKBUDDY_AUTH_FILE 指向不存在文件 → sources 报 missing（文件不存在）；聚合只看存在的来源", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const ghost = join(home, "ghost.info");
    pinEnv("WORKBUDDY_AUTH_FILE", ghost); // 不创建文件 —— 用户显式指定的路径缺失必须被告知
    const vaultSource = seedVault("acc-live", "vault-tok-9");

    const report = await oneClickAuth({}, database, state);
    const wb = channelOf(report, GLOBAL_CHANNEL);

    const missing = wb.sources.find((s) => s.source === ghost);
    expect(missing, "显式指定的缺失路径要出现在 sources 里").toBeDefined();
    expect(missing!.status).toBe("missing");
    expect(missing!.detail).toContain("文件不存在");
    expect(wb.sources.some((s) => s.source === vaultSource && s.status === "ok")).toBe(true);
    expect(wb.status).toBe("ok"); // 渠道级聚合只统计存在的来源：vault 可用即 ok，缺失提示只进展示
  });
});

describe("oneClickAuth · Qoder", () => {
  it("PAT 文件验活成功 → ok，exchangePat 收到文件路径来源，detail 不含 PAT 全文", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const pat = "pt-goodpat01";
    const source = writePatFile("main.pat", pat);
    const calls: ExchangeCall[] = [];

    const report = await oneClickAuth({ exchangePat: fakeExchange(calls) }, database, state);
    const qoder = channelOf(report, QODER_CHANNEL);

    expect(qoder.status).toBe("ok");
    expect(qoder.accountsAdded).toBe(0); // one-click 只验活，添加账号走 addQoderPat
    expect(calls).toEqual([{ pat, source }]);
    expect(qoder.sources[0]).toMatchObject({ source, status: "ok" });
    expect(JSON.stringify(report)).not.toContain(pat);
  });

  it("旧 ~/.dsh/qoder/pat 与 env 都是来源；非 pt- 开头的 env 不收", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const legacy = join(home, "qoder", "pat");
    mkdirSync(join(home, "qoder"), { recursive: true });
    writeFileSync(legacy, "pt-legacy9x\n");
    pinEnv("QODERCN_PAT", "pt-envpat99x");
    pinEnv("QODERCN_API_KEY", "not-a-pat"); // 非 pt- 开头：不收
    const calls: ExchangeCall[] = [];

    const report = await oneClickAuth({ exchangePat: fakeExchange(calls) }, database, state);
    const qoder = channelOf(report, QODER_CHANNEL);

    expect(qoder.status).toBe("ok");
    expect(qoder.sources.map((s) => s.source)).toEqual([legacy, "env:QODERCN_PAT"]);
    expect(qoder.sources.every((s) => s.status === "ok")).toBe(true);
    expect(calls.map((c) => c.source)).toEqual([legacy, "env:QODERCN_PAT"]);
    expect(JSON.stringify(report)).not.toContain("not-a-pat");
  });

  it("exchangePat 抛错 → error 态 + PAT 指引文案 + 渠道 missing；一好一坏 → partial", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    writePatFile("bad.pat", "pt-deadbeef01");

    const failing = async () => { throw new Error("PAT 被拒绝（HTTP 401），可能已吊销或填错"); };
    const alone = await oneClickAuth({ exchangePat: failing }, database, state);
    const bad = channelOf(alone, QODER_CHANNEL);
    expect(bad.status).toBe("missing");
    expect(bad.sources[0]).toMatchObject({ status: "error" });
    expect(bad.sources[0].detail).toContain("https://qoder.com.cn/account/integrations");
    expect(bad.sources[0].detail).toContain("HTTP 401");

    writePatFile("good.pat", "pt-finebeef02");
    const calls: ExchangeCall[] = [];
    const mixed = await oneClickAuth(
      { exchangePat: fakeExchange(calls, (pat) => { if (pat === "pt-deadbeef01") throw new Error("PAT 被拒绝（HTTP 401）"); }) },
      database, state,
    );
    const both = channelOf(mixed, QODER_CHANNEL);
    expect(both.status).toBe("partial");
    expect(both.sources.map((s) => s.status).sort()).toEqual(["error", "ok"]);
    expect(JSON.stringify(mixed)).not.toContain("pt-deadbeef01");
  });
});

// ── testAccount ──

describe("testAccount · WorkBuddy", () => {
  it("200：ok=true、计时为数值、记成功并解除冷却，detail 不含 token", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const authPath = writeWorkbuddyAuth(join(home, "acc.info"), plainAuthDoc("wb-live-token"));
    seedChannelsAndAccounts(database,
      [{ id: GLOBAL_CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }],
      [{ id: `${GLOBAL_CHANNEL}:a1`, channelId: GLOBAL_CHANNEL, displayName: "A1", credentialRef: authPath, isCurrent: true }]);
    // 先推进冷却：3 次凭据类失败 → cooldown
    for (const at of [1, 2, 3]) markAccountResult(database, `${GLOBAL_CHANNEL}:a1`, false, 401, "x", at);
    expect((queryAccounts(database)[0] as { cooldown_until: number | null }).cooldown_until).not.toBeNull();

    const fake = fakeCatalogFetch(200);
    const result = await testAccount({ fetchImpl: fake.fetchImpl }, database, state, `${GLOBAL_CHANNEL}:a1`);

    expect(result.ok).toBe(true);
    expect(typeof result.ms).toBe("number");
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(fake.seen[0]?.url).toContain("www.workbuddy.ai/v3/config");
    expect(fake.seen[0]?.authorization).toBe("Bearer wb-live-token");
    expect(result.detail).not.toContain("wb-live-token");
    const row = queryAccounts(database)[0] as { cooldown_until: number | null; consecutive_failures: number; last_ok_at: number | null };
    expect(row.cooldown_until).toBeNull(); // 成功即解除冷却
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_ok_at).not.toBeNull();
  });

  it("401：ok=false、detail 含 HTTP 401、凭据类失败计入熔断计数", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    // 国内域名的凭据 → 应打国内上游（区域跟随 auth 文件，不写死）
    const authPath = writeWorkbuddyAuth(join(home, "cn.info"), plainAuthDoc("wb-cn-token", "www.workbuddy.cn"));
    seedChannelsAndAccounts(database,
      [{ id: GLOBAL_CHANNEL, kind: "workbuddy", displayName: "WorkBuddy Global" }],
      [{ id: `${GLOBAL_CHANNEL}:cn`, channelId: GLOBAL_CHANNEL, displayName: "CN", credentialRef: authPath, isCurrent: true }]);

    const fake = fakeCatalogFetch(401);
    const result = await testAccount({ fetchImpl: fake.fetchImpl }, database, state, `${GLOBAL_CHANNEL}:cn`);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
    expect(fake.seen[0]?.url).toContain("copilot.tencent.com/v3/config");
    const row = queryAccounts(database)[0] as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(1); // 401 是凭据类失败，计熔断
  });
});

describe("testAccount · Qoder", () => {
  it("credential_ref 是 env:* 时从环境变量取 PAT 交给 exchangePat", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    pinEnv("QODERCN_PROBER_TEST", "pt-fromenv01");
    seedAccount(database, `${QODER_CHANNEL}:envacc`, "env:QODERCN_PROBER_TEST");
    const calls: ExchangeCall[] = [];

    const result = await testAccount({ exchangePat: fakeExchange(calls) }, database, state, `${QODER_CHANNEL}:envacc`);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ pat: "pt-fromenv01", source: "env:QODERCN_PROBER_TEST" }]);
    expect(result.detail).not.toContain("pt-fromenv01");
  });

  it("文件凭据 + exchangePat 抛错 → ok=false，HTTP 401 计入熔断计数", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const patPath = writePatFile("acc.pat", "pt-filepat01");
    seedAccount(database, `${QODER_CHANNEL}:fileacc`, patPath);

    const result = await testAccount(
      { exchangePat: async () => { throw new Error("PAT 被拒绝（HTTP 401），可能已吊销或填错"); } },
      database, state, `${QODER_CHANNEL}:fileacc`,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTTP 401");
    expect(result.detail).toContain("https://qoder.com.cn/account/integrations");
    const row = queryAccounts(database)[0] as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(1);
  });

  it("账号不存在 → ok=false，不抛", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const result = await testAccount({}, database, state, "hub-qoder-cn:ghost");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ghost");
  });

  it("redact：exchangePat 错误文案嵌入 PAT 全文 → detail 与 DB last_error 都被隐去，状态码提取不受影响", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const patPath = writePatFile("leak.pat", "pt-leakpat0001");
    seedAccount(database, `${QODER_CHANNEL}:leakacc`, patPath);

    const result = await testAccount(
      // 模拟上游回显请求里的 personal_token（review 指出的威胁模型）
      { exchangePat: async () => { throw new Error("PAT 被拒绝（HTTP 401）：personal_token=pt-leakpat0001 原样返回"); } },
      database, state, `${QODER_CHANNEL}:leakacc`,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain("pt-leakpat0001"); // 纪律：PAT 全文绝不进 detail
    expect(result.detail).toContain("（PAT 已隐去）");
    expect(result.detail).toContain("HTTP 401");
    // detail 会经 markAccountResult 落进 DB last_error —— 库里同样必须干净
    const row = database.prepare("SELECT last_error, consecutive_failures FROM accounts WHERE id = ?")
      .get(`${QODER_CHANNEL}:leakacc`) as { last_error: string; consecutive_failures: number };
    expect(row.last_error).not.toContain("pt-leakpat0001");
    expect(row.consecutive_failures).toBe(1); // redact 不得破坏「HTTP 401 → 凭据类失败」提取
  });
});

// ── addQoderPat ──

describe("addQoderPat", () => {
  it("pt-short 抛「PAT 格式不对」，不写任何文件", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);

    await expect(addQoderPat({}, database, state, "pt-short")).rejects.toThrow("PAT 格式不对");
    expect(existsSync(join(home, "model-hub", "qoder-pats"))).toBe(false);
  });

  it("成功：文件落在注入 dshHome 的 model-hub/qoder-pats/，账号入库，ensureRuntime 被调", async () => {
    newHome();
    const database = await freshDb();
    const { calls, state } = fakeState(database);
    const calls2: ExchangeCall[] = [];

    const out = await addQoderPat({ exchangePat: fakeExchange(calls2) }, database, state, "pt-abcdef123456", "Work Main");

    const expectedPath = join(home, "model-hub", "qoder-pats", "work-main.pat");
    expect(out).toEqual({ accountId: `${QODER_CHANNEL}:work-main`, path: expectedPath });
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf8")).toBe("pt-abcdef123456"); // 原样落盘，没加换行
    expect(calls2).toEqual([{ pat: "pt-abcdef123456", source: expectedPath }]); // 验活用的是刚写的文件路径
    const rows = database.prepare("SELECT id, credential_ref FROM accounts").all() as { id: string; credential_ref: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `${QODER_CHANNEL}:work-main`, credential_ref: expectedPath });
    expect(calls).toContain(`ensureRuntime:${QODER_CHANNEL}`);
    expect(JSON.stringify(out)).not.toContain("pt-abcdef123456"); // 返回值只含路径与 slug（前 6 位），不含全文
  });

  it("无备注名 → slug 用 pat-<前 6 位>；同名再贴 → 追加 -2", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);
    const okExchange = fakeExchange([]);

    const first = await addQoderPat({ exchangePat: okExchange }, database, state, "pt-abcdef123456");
    expect(first.accountId).toBe(`${QODER_CHANNEL}:pat-abcdef`);
    const second = await addQoderPat({ exchangePat: okExchange }, database, state, "pt-uvwxyz987654", "Work Main");
    expect(second.accountId).toBe(`${QODER_CHANNEL}:work-main`);
    const third = await addQoderPat({ exchangePat: okExchange }, database, state, "pt-ghijkl654321", "Work Main");
    expect(third.accountId).toBe(`${QODER_CHANNEL}:work-main-2`);
    expect(existsSync(join(home, "model-hub", "qoder-pats", "work-main-2.pat"))).toBe(true);
    expect(queryAccounts(database)).toHaveLength(3);
  });

  it("纯中文备注名净化为空 → 回落 pat-<前 6 位>", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);

    const out = await addQoderPat({ exchangePat: fakeExchange([]) }, database, state, "pt-zh0000123456", "主账号");
    expect(out.accountId).toBe(`${QODER_CHANNEL}:pat-zh0000`);
  });

  it("验活失败 → 刚写的文件被删、账号不入库、原异常冒出", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);

    await expect(
      addQoderPat({ exchangePat: async () => { throw new Error("PAT 被拒绝（HTTP 403）"); } }, database, state, "pt-doomed00123", "Doomed"),
    ).rejects.toThrow("HTTP 403");

    expect(existsSync(join(home, "model-hub", "qoder-pats", "doomed.pat"))).toBe(false); // 不留死 PAT
    expect(queryAccounts(database)).toHaveLength(0);
  });

  it("redact：验活异常含 PAT 全文 → rethrow 给路由层前被隐去", async () => {
    newHome();
    const database = await freshDb();
    const { state } = fakeState(database);

    const error = await addQoderPat(
      { exchangePat: async () => { throw new Error("交换失败：personal_token=pt-doomed00002 原样返回"); } },
      database, state, "pt-doomed00002", "Doomed2",
    ).then(() => null, (caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain("pt-doomed00002"); // 抛给任务 7 路由层的文案同样过 redact
    expect(error!.message).toContain("（PAT 已隐去）");
    expect(existsSync(join(home, "model-hub", "qoder-pats", "doomed2.pat"))).toBe(false);
  });
});
