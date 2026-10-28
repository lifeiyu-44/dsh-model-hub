import { describe, expect, it } from "vitest";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";

/**
 * 这一组测的是「注册上去的 provider 到底能不能用」。
 *
 * 起因（实测 2026-10-28）：插件装好、provider 也出现在
 * `llm/listProviders` 里了 —— 但那是**假通过**。`PiAiAdapter` 的 `profiles()`
 * 返回的不是「配置文档里的 provider 条目」，而是 `dsh-llm-pi-ai` **已经解析过**
 * 的内部 profile 形状：它要 `piProvider`（pi-ai 的 provider 对象）、
 * `configuredMaxTokens`、`modelErrors`、`streamIdleTimeoutMs`、`retryPolicy`。
 *
 * 我们 P0 写的是配置文档的形状（`api` / `baseUrl` / `models`），
 * 于是 `current()` 里 `models.setProvider()` 一个都没调用，
 * 模型集合是空的 —— `listModels()` 返回 `[]`，`resolveModel()` 抛
 * `UNKNOWN_MODEL`。provider 在列表里，但一个模型都选不出来。
 *
 * 所以断言必须打到 `listModels` / `resolveModel`，不能只打到
 * `providerInfo` 或 `registerAdapter` 的参数。
 */

const PROVIDER = "hub-workbuddy-global";

const MODELS = [
  { id: "Hy3", name: "Hy3", contextWindow: 200_000, maxTokens: 32_000, input: ["text"] as const },
  { id: "deepseek-v4.1-flash-sg", name: "DeepSeek V4.1 Flash", contextWindow: 200_000, maxTokens: 32_000, input: ["text"] as const },
];

function buildAdapter(profile: Record<string, unknown>) {
  return new PiAiAdapter({
    profiles: () => new Map([[PROVIDER, profile]]),
    auth: {
      credentials: {
        async read() {},
        async list() {
          return [];
        },
        async modify() {
          throw new Error("no credential lifecycle");
        },
        async delete() {},
      },
      authContext: {
        async env() {},
        async fileExists() {
          return false;
        },
      },
    },
    resolveApiKey: async () => "shim",
  } as any);
}

/**
 * 把我们的渠道模型表转成 pi-ai 真正认的 provider 对象。
 *
 * 这正是 P0 缺的那一步：`dsh-connect-workbuddy` 是手写 `toPiModel()` 造
 * 模型描述符再交给 `createProvider()`，我们抄漏了。
 */
async function buildPiProvider(baseUrl: string, models: typeof MODELS) {
  const { createProvider } = await import("@earendil-works/pi-ai");
  const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
  return createProvider({
    id: PROVIDER,
    name: PROVIDER,
    baseUrl,
    auth: {
      apiKey: {
        name: "dsh-model-hub shim",
        resolve: ({ credential }: any) =>
          Promise.resolve({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: "shim" }),
      },
    },
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      api: "openai-completions",
      provider: PROVIDER,
      baseUrl,
      input: [...m.input],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: false,
    })),
    api: openAICompletionsApi(),
  } as any);
}

describe("provider 真的能出模型（不是只出现在 listProviders 里）", () => {
  it("P0 的配置文档形状不够 —— 证明 listModels 是空的", async () => {
    // 复刻 P0 里 registerProvider() 传进去的形状。
    const adapter = buildAdapter({
      provider: PROVIDER,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "shim",
      models: MODELS.map((m) => ({ ...m })),
    });

    // providerInfo 有值 —— 这就是当初误判「装好了」的原因。
    expect(adapter.providerInfo(PROVIDER).id).toBe(PROVIDER);

    // 但模型是空的。
    await expect(adapter.listModels(PROVIDER)).resolves.toEqual([]);
    // 而且比「查不到模型」更糟：`modelOf()` 里 `profile.modelErrors.get(...)`
    // 直接踩空，抛的是裸 TypeError 而不是带 code 的 LlmError —— 说明这个形状
    // 连错误处理路径都没走到，属于「完全没接上」而不是「接上了但配错」。
    await expect(adapter.resolveModel(PROVIDER, "Hy3")).rejects.toThrow(/Cannot read properties of undefined/);
  });

  it("补上 piProvider 之后 listModels 才有内容", async () => {
    const piProvider = await buildPiProvider("http://127.0.0.1:1", MODELS);
    const adapter = buildAdapter({
      provider: PROVIDER,
      displayName: PROVIDER,
      piProvider,
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      streamIdleTimeoutMs: 300_000,
    });

    const models = await adapter.listModels(PROVIDER);
    expect(models.map((m) => m.id)).toEqual(["Hy3", "deepseek-v4.1-flash-sg"]);

    const resolved = await adapter.resolveModel(PROVIDER, "Hy3");
    expect(resolved.id).toBe("Hy3");
    expect(resolved.context?.contextWindow).toBe(200_000);
  });
});
