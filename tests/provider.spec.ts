import { describe, expect, it } from "vitest";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createHubAdapter, type HubModel } from "../src/provider.js";

/**
 * 这一组是 `src/provider.ts` 的回归锚点。
 *
 * 它存在的唯一理由：P0 曾经「装好了」但一个模型都选不出来 ——
 * `registerAdapter` 不报错、`llm/listProviders` 里也能看到 provider，
 * 只有 `listModels()` 才是空的。所以断言必须打到 `listModels` /
 * `resolveModel`，不能只打到 `providerInfo`。
 *
 * 走的是 `createHubAdapter()` —— 生产路径同一个函数，不另写一份 mock 形状。
 */

const PROVIDER = "hub-workbuddy-global";
const SHIM = "http://127.0.0.1:12345";
/** 生产里由 `shim.token()` 给真值；这里给一个非占位字符串，防止有人写死 "shim"。 */
const SHIM_TOKEN = "test-token-not-the-literal-shim";

const MODELS: HubModel[] = [
  { id: "Hy3", name: "Hy3", contextWindow: 200_000, maxTokens: 32_000, supportsImages: false },
  {
    id: "deepseek-v4.1-flash-sg",
    name: "DeepSeek V4.1 Flash",
    contextWindow: 200_000,
    maxTokens: 32_000,
    supportsImages: false,
  },
];

function adapterFor(models: HubModel[]) {
  return createHubAdapter({
    provider: PROVIDER,
    shimBaseUrl: SHIM,
    shimToken: SHIM_TOKEN,
    models,
    createProvider,
    openAICompletionsApi,
    resolveRetryPolicy,
    PiAiAdapter,
  });
}

describe("createHubAdapter —— 产出的 provider 必须真的能出模型", () => {
  it("listModels 列出全部模型（不是空数组）", async () => {
    const listed = await adapterFor(MODELS).listModels(PROVIDER);
    expect(listed.map((m) => m.id)).toEqual(["Hy3", "deepseek-v4.1-flash-sg"]);
  });

  it("resolveModel 能解析出上下文窗口", async () => {
    const resolved = await adapterFor(MODELS).resolveModel(PROVIDER, "Hy3");
    expect(resolved.id).toBe("Hy3");
    expect(resolved.context?.contextWindow).toBe(200_000);
    // 注意：`defaultMaxTokens` 不在这里断言。它来自 profile 的
    // `configuredMaxTokens`，而那个 map 的语义是「用户在设置里**显式**改过的
    // 输出上限」—— 我们没让用户改，就该是空的，不该把目录里的 maxTokens
    // 冒充成用户配置。模型自身的 maxTokens 由 pi-ai 的模型描述符携带。
  });

  it("模型 id 原样保留（面板与上游都按 id 对齐）", async () => {
    const resolved = await adapterFor(MODELS).resolveModel(PROVIDER, "deepseek-v4.1-flash-sg");
    expect(resolved.id).toBe("deepseek-v4.1-flash-sg");
  });

  it("空模型表不抛错，只是没有模型", async () => {
    await expect(adapterFor([]).listModels(PROVIDER)).resolves.toEqual([]);
  });

  it("即使上游说 supportsImages，也只声明纯文本", async () => {
    // 实测（2026-10-28）：声明 image 后用户贴图会以
    // `pi-ai image input requires the durable attachment service` 让整轮失败，
    // 因为 adapter 没接 resolveAttachments。宣称做不到的能力比不宣称更糟。
    const withImage: HubModel[] = [{ ...MODELS[0]!, supportsImages: true }];
    const listed = await adapterFor(withImage).listModels(PROVIDER);
    expect(listed[0]?.inputModalities).toEqual(["text"]);
  });
});
