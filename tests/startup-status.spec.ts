import { expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/index.js";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts } from "../src/store/seed.js";
import { softDeleteAccount } from "../src/store/mutations.js";

/**
 * 「有凭据但 runtime 没起来」必须写 status.json ok:false（任务 9 审查发现 2）。
 *
 * deploy.ps1 对「status.json 缺失」按『可能没有凭据』放行；旧代码同场景
 * （目录拉取失败）会写 ok:false 让部署自检当场抛错。装配化后 ensureRuntime
 * 失败只记日志 —— 不补写的话，P0 建立的自检恰在其针对的场景静默假通过。
 *
 * 手段（全离线）：DSH_HOME 指临时目录（dsh-home-paths 每次现读该 env）→
 * 库/状态文件都落在隔离目录；WORKBUDDY_AUTH_FILE 指明文 token 文件
 * （authCandidates 首位 → 凭据必被采信）；fetch 桩一律拒绝 → 目录拉取必败
 * （Qoder 侧 exchangePat 同败 → current() 返回 undefined，渠道安静跳过）。
 */

function fakeCtx() {
  const effects: (() => unknown)[] = [];
  const logs: { level: string; text: string }[] = [];
  return {
    effects,
    logs,
    ctx: {
      logger: {
        info(...rest: unknown[]) { logs.push({ level: "info", text: rest.map(String).join(" ") }); },
        warn(...rest: unknown[]) { logs.push({ level: "warn", text: rest.map(String).join(" ") }); },
        error(...rest: unknown[]) { logs.push({ level: "error", text: rest.map(String).join(" ") }); },
      },
      effect(fn: () => unknown) { effects.push(fn); },
      // 不提供 webServer：路由回调不触发，注册面安静跳过（与无 webServer 宿主一致）
      inject(_deps: string[], _cb: (inner: any) => void) {},
    },
  };
}

it("WB 有凭据但 runtime 启动失败 → 写 status.json ok:false（部署自检不再静默假通过）", async () => {
  const home = mkdtempSync(join(tmpdir(), "startup-"));
  const authPath = join(home, "auth.info");
  writeFileSync(
    authPath,
    JSON.stringify({ auth: { accessToken: "test-token", domain: "www.workbuddy.ai" } }),
    "utf8",
  );

  const prevHome = process.env["DSH_HOME"];
  const prevAuth = process.env["WORKBUDDY_AUTH_FILE"];
  const prevQoder = ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"]
    .map((name) => [name, process.env[name]] as const);
  const fetchOriginal = globalThis.fetch;
  process.env["DSH_HOME"] = home;
  process.env["WORKBUDDY_AUTH_FILE"] = authPath;
  for (const [name] of prevQoder) delete process.env[name]; // Qoder 渠道确定性走「无 PAT」跳过
  globalThis.fetch = (async () => {
    throw new Error("catalog down");
  }) as unknown as typeof fetch;

  const { ctx, effects } = fakeCtx();
  try {
    apply(ctx as any, {});

    // 写入时机断言：apply 是 fire-and-forget 异步体，status.json 应在启动
    // 流程内（不是遥遥无期地）落盘
    const statusPath = join(home, "model-hub", "status.json");
    let doc: any;
    for (let i = 0; i < 100 && doc === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (existsSync(statusPath)) doc = JSON.parse(readFileSync(statusPath, "utf8")) as any;
    }

    // 内容断言：deploy.ps1 的门槛读的是 ok / modelCount / error 三个字段
    expect(doc, "有凭据但没起来时必须写 status.json").toBeDefined();
    expect(doc.ok).toBe(false);
    expect(doc.provider).toBe("hub-workbuddy-global");
    expect(doc.modelCount).toBe(0);
    expect(String(doc.error)).toContain("runtime 启动失败");
  } finally {
    globalThis.fetch = fetchOriginal;
    if (prevHome === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = prevHome;
    if (prevAuth === undefined) delete process.env["WORKBUDDY_AUTH_FILE"];
    else process.env["WORKBUDDY_AUTH_FILE"] = prevAuth;
    for (const [name, value] of prevQoder) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // fake ctx 不会自动跑 cordis teardown：手动执行，清掉定时器与 db 句柄
    for (const dispose of effects) await dispose();
  }
}, 20_000);

it("WB 池空（账号被删光）→ 只 warn，不写 status.json ok:false（用户选择不算事故）", async () => {
  const home = mkdtempSync(join(tmpdir(), "startup-empty-"));
  const authPath = join(home, "auth.info");
  writeFileSync(
    authPath,
    JSON.stringify({ auth: { accessToken: "test-token", domain: "www.workbuddy.ai" } }),
    "utf8",
  );

  // 预置一个已软删的 WB 账号：seed 的软删守卫不复活它 → 启动时池空
  const db = await openHubDatabase(join(home, "model-hub", "hub.db"));
  seedChannelsAndAccounts(
    db,
    [{ id: "hub-workbuddy-global", kind: "workbuddy", displayName: "WorkBuddy Global" }],
    [{
      id: "hub-workbuddy-global:default",
      channelId: "hub-workbuddy-global",
      displayName: "WorkBuddy 主账号",
      credentialRef: authPath,
      isCurrent: true,
    }],
  );
  softDeleteAccount(db, "hub-workbuddy-global:default");
  db.close();

  const prevHome = process.env["DSH_HOME"];
  const prevAuth = process.env["WORKBUDDY_AUTH_FILE"];
  const prevQoder = ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"]
    .map((name) => [name, process.env[name]] as const);
  const fetchOriginal = globalThis.fetch;
  process.env["DSH_HOME"] = home;
  process.env["WORKBUDDY_AUTH_FILE"] = authPath; // 凭据仍在（文件层面「有凭据」）
  for (const [name] of prevQoder) delete process.env[name];
  globalThis.fetch = (async () => {
    throw new Error("catalog down");
  }) as unknown as typeof fetch;

  const { ctx, effects, logs } = fakeCtx();
  try {
    apply(ctx as any, {});

    // 轮询到 WB 分支的「池空」warn 出现 —— 它出现即启动流程已走到判定点
    const statusPath = join(home, "model-hub", "status.json");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !logs.some((l) => l.text.includes("没有可用账号"))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const warns = logs.filter((l) => l.level === "warn").map((l) => l.text).join("\n");
    expect(warns, "池空必须有一条明确的 warn（告诉用户为什么渠道没起）").toContain("没有可用账号");

    // 再给启动流程足够的收敛时间：池空是用户删光/停光的自选状态，
    // 不是部署事故 —— status.json 必须保持缺失（写了 ok:false 反而让
    // deploy.ps1 的自检误报）
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(statusPath), "池空不得写 status.json ok:false").toBe(false);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (prevHome === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = prevHome;
    if (prevAuth === undefined) delete process.env["WORKBUDDY_AUTH_FILE"];
    else process.env["WORKBUDDY_AUTH_FILE"] = prevAuth;
    for (const [name, value] of prevQoder) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dispose of effects) await dispose();
  }
}, 20_000);
