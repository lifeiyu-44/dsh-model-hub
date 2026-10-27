import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../src/index.js";

/**
 * 真实 Cordis 加载测试。
 *
 * 这一组存在的理由：插件在**加载期**抛错会让整个 host 以 exit 1 退出，
 * 进而触发 DSH 把 profile 重置为默认（bundles 清空、cordis.patch.yml 被覆盖），
 * 用户所有插件一次性停用。实测踩过两次，都是因为访问了没在 `inject` 里声明的服务。
 *
 * **关键机制**：`ctx.plugin()` 本身不抛，错误藏在它返回的 thenable 里 ——
 * 必须 `await` 才会暴露。所以断言一律写成 `await expect(ctx.plugin(...))`。
 * 当初没测出来，就是因为只写了同步的 `expect(() => ctx.plugin(...)).not.toThrow()`。
 */

/** 一个最小的假 llm 服务：只记录被注册了哪些 provider。 */
function fakeLlm() {
  const registered: string[] = [];
  return {
    registered,
    registerAdapter(providers: string[]) {
      registered.push(...providers);
      return () => {};
    },
  };
}

describe("plugin loads inside a real Cordis Context", () => {
  it("loads without rejecting when only llm is provided (no webServer anywhere)", async () => {
    const ctx = new Context();
    ctx.provide("llm", fakeLlm());

    // 加载必须 resolve。apply 内部可能异步失败（比如没有凭据），
    // 但那必须是「记日志后放弃」，不能是「reject 到加载期」。
    await expect(ctx.plugin(plugin, {})).resolves.toBeDefined();

    // 给异步初始化一点时间，确认没有未处理的 rejection。
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }, 20_000);

  it("declares only llm in inject", () => {
    // 回归锚点：一旦有人往 apply 里塞 ctx.webServer / ctx.settings 之类
    // 没声明的服务，这条会失败，提醒他先改 inject —— 或者干脆别用那个服务。
    expect(plugin.inject).toEqual(["llm"]);
  });

  it("exports the shape Cordis expects from a plugin module", () => {
    expect(plugin.name).toBe("dsh-model-hub");
    expect(typeof plugin.apply).toBe("function");
    expect(plugin.Config).toBeDefined();
  });
});

describe("negative control — 证明上面的测试真的有牙", () => {
  it("a plugin touching an undeclared service rejects at load time", async () => {
    // 复刻把宿主搞崩两次的那个写法：inject 只有 llm，却访问 ctx.webServer。
    const badPlugin = {
      name: "bad-plugin",
      inject: ["llm"],
      apply(ctx: any) {
        void ctx.webServer;
      },
    };
    const ctx = new Context();
    ctx.provide("llm", fakeLlm());
    await expect(ctx.plugin(badPlugin as any, {})).rejects.toThrow(/without inject/);
  });
});
