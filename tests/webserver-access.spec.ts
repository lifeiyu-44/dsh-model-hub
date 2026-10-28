import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";

/**
 * 验证「怎样合法地拿到 webServer」。
 *
 * 背景（实测事故）：本插件 P0 曾因在 `apply()` 里直接访问 `ctx.webServer`
 * 而让整个 host fatal 退出 —— 错误是
 * `cannot get property "webServer" without inject`，
 * 而 DSH 判定 fatal 后会把 profile 重置为默认，用户所有插件一次性停用。
 *
 * 但参考实现 `dsh-connect-workbuddy` 的静态 `inject` 只有 `["llm","settings"]`，
 * 它却在 `ctx.inject(['webServer'], ...)` 的回调里用 `ctx.webServer.register(...)`
 * 并且工作正常。差别只可能在「用的是哪个 ctx」。
 *
 * 这一组把两种写法都跑一遍，用真实 Cordis 定死结论 —— 不靠猜。
 */

function fakeLlm() {
  return { registerAdapter: () => () => {} };
}

function fakeWebServer() {
  const registered: string[] = [];
  return {
    registered,
    register(entry: { kind: string; path: string }) {
      registered.push(entry.path);
      return () => {};
    },
  };
}

describe("webServer 的合法获取方式", () => {
  it("反例：在 apply 里直接摸外层 ctx.webServer 会抛（P0 事故复刻）", async () => {
    const bad = {
      name: "bad",
      inject: ["llm"],
      apply(ctx: any) {
        void ctx.webServer;
      },
    };
    const ctx = new Context();
    ctx.provide("llm", fakeLlm());
    await expect(ctx.plugin(bad as any, {})).rejects.toThrow(/without inject/);
  });

  it("正例：在 ctx.inject(['webServer'], cb) 的回调 ctx 上可以访问", async () => {
    const webServer = fakeWebServer();
    const seen: string[] = [];

    const good = {
      name: "good",
      inject: ["llm"],
      apply(ctx: any) {
        // 关键：回调收到的 ctx 才是带 webServer 的那个
        ctx.inject(["webServer"], (inner: any) => {
          inner.webServer.register({ kind: "exact", path: "/probe" });
          seen.push("registered");
        });
      },
    };

    const ctx = new Context();
    ctx.provide("llm", fakeLlm());
    ctx.provide("webServer", webServer);

    await expect(ctx.plugin(good as any, {})).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seen).toEqual(["registered"]);
    expect(webServer.registered).toEqual(["/probe"]);
  });

  it("正例：用 ctx.get('webServer') 也不需要静态 inject", async () => {
    const webServer = fakeWebServer();
    const got: unknown[] = [];

    const plugin = {
      name: "via-get",
      inject: ["llm"],
      apply(ctx: any) {
        got.push(ctx.get("webServer"));
      },
    };

    const ctx = new Context();
    ctx.provide("llm", fakeLlm());
    ctx.provide("webServer", webServer);

    await expect(ctx.plugin(plugin as any, {})).resolves.toBeDefined();
    expect(got[0]).toBe(webServer);
  });

  it("服务不存在时 ctx.inject 的回调不执行（不会抛，也不会崩）", async () => {
    let ran = false;
    const plugin = {
      name: "absent",
      inject: ["llm"],
      apply(ctx: any) {
        ctx.inject(["webServer"], () => {
          ran = true;
        });
      },
    };

    const ctx = new Context();
    ctx.provide("llm", fakeLlm());
    await expect(ctx.plugin(plugin as any, {})).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ran).toBe(false);
  });
});
