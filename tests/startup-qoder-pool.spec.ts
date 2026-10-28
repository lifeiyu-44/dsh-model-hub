import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/index.js";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts } from "../src/store/seed.js";

/**
 * 终审 C1 的回归：**仅经面板添加的 Qoder 账号，重启后渠道失联**。
 *
 * 场景：用户在面板贴 PAT 添加了 Qoder 账号（credential_ref 指向
 * `model-hub/qoder-pats/*.pat`），重启 DSH —— 启动期的 legacy 扫描
 * （`~/.dsh/qoder/pat`、env）看不见这类账号，`sessions.current()` 为
 * undefined。旧代码此时直接 warn+跳过，渠道永远暗着；而 oneClickAuth 对
 * Qoder 只验活不登记，用户没有任何入口能把它救回来。
 *
 * 修后语义：池非空（账号还在库里、启用、有 credential_ref）就照常
 * `ensureRuntime` —— runtime 的 patOf 按各账号 credential_ref 现读文件，
 * 根本不依赖启动期的会话探针；只有池也空才发原 warn。
 *
 * 可观察面（选最稳的一对，全程离线）：
 * 1. warn「未找到 Qoder PAT」**不出现** —— 说明没走跳过分支；
 * 2. error「hub-qoder-cn runtime 启动失败」**出现** —— 说明 ensureRuntime
 *    真的被调了（fetch 桩全拒 → exchangePat/目录拉取必败 → hub-state 把
 *    起不来的 runtime 折成 error 并保持「无 runtime」）。旧代码两条都不满足。
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

it("只有面板加的 Qoder 账号（credential_ref 指向 qoder-pats 文件）→ 重启仍 ensureRuntime，不发「未找到 Qoder PAT」", async () => {
  const home = mkdtempSync(join(tmpdir(), "startup-qoder-"));
  // 面板 addQoderPat 会落下的形态：qoder-pats/<slug>.pat + 账号行存引用
  const patDir = join(home, "model-hub", "qoder-pats");
  mkdirSync(patDir, { recursive: true });
  const patPath = join(patDir, "panel.pat");
  writeFileSync(patPath, "pt-panelpat01", "utf8");

  const dbPath = join(home, "model-hub", "hub.db");
  const db = await openHubDatabase(dbPath);
  seedChannelsAndAccounts(
    db,
    [{ id: "hub-qoder-cn", kind: "qoder", displayName: "Qoder CN" }],
    [{
      id: "hub-qoder-cn:panel",
      channelId: "hub-qoder-cn",
      displayName: "面板贴的 PAT",
      credentialRef: patPath,
      isCurrent: true,
    }],
  );
  db.close();

  const prevHome = process.env["DSH_HOME"];
  const prevAuth = process.env["WORKBUDDY_AUTH_FILE"];
  const prevLocal = process.env["LOCALAPPDATA"];
  const prevRoaming = process.env["APPDATA"];
  const prevQoder = ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"]
    .map((name) => [name, process.env[name]] as const);
  const fetchOriginal = globalThis.fetch;
  process.env["DSH_HOME"] = home;
  delete process.env["WORKBUDDY_AUTH_FILE"]; // WB 侧无凭据 → 只走 Qoder 分支
  process.env["LOCALAPPDATA"] = join(home, "no-local");
  process.env["APPDATA"] = join(home, "no-roaming");
  for (const [name] of prevQoder) delete process.env[name]; // 无 legacy/env PAT
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;

  const { ctx, effects, logs } = fakeCtx();
  try {
    apply(ctx as any, {});

    // apply 是 fire-and-forget 异步体：轮询到 Qoder runtime 的启动结局出现为止
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !logs.some((l) => l.text.includes("runtime 启动失败"))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const allWarns = logs.filter((l) => l.level === "warn").map((l) => l.text).join("\n");
    expect(allWarns, "池非空时不得发「未找到 Qoder PAT」").not.toContain("未找到 Qoder PAT");
    const errors = logs.filter((l) => l.level === "error").map((l) => l.text).join("\n");
    expect(errors, "池非空必须真的尝试建 runtime（目录拉取失败被 hub-state 折成 error）")
      .toContain("hub-qoder-cn runtime 启动失败");
  } finally {
    globalThis.fetch = fetchOriginal;
    if (prevHome === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = prevHome;
    if (prevAuth === undefined) delete process.env["WORKBUDDY_AUTH_FILE"];
    else process.env["WORKBUDDY_AUTH_FILE"] = prevAuth;
    if (prevLocal === undefined) delete process.env["LOCALAPPDATA"];
    else process.env["LOCALAPPDATA"] = prevLocal;
    if (prevRoaming === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = prevRoaming;
    for (const [name, value] of prevQoder) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // fake ctx 不会自动跑 cordis teardown：手动执行，清掉定时器与 db 句柄
    for (const dispose of effects) await dispose();
  }
}, 20_000);
