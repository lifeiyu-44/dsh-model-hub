import { expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/index.js";

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
  return {
    effects,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
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
