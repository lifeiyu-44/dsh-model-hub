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

/**
 * 造一个 adapter。
 *
 * `withAttachments` 决定是否注入附件服务的两个钩子 —— 它正是「能不能收图」
 * 的开关：pi-ai 在收到 image block 时会先要求 `resolveAttachments` 存在，
 * 而我们的 profile 也按「钩子在不在」决定要不要声明 image 能力。
 */
function adapterFor(models: HubModel[], options: { withAttachments?: boolean } = {}) {
  const withAttachments = options.withAttachments === true;
  return createHubAdapter({
    provider: PROVIDER,
    shimBaseUrl: SHIM,
    shimToken: SHIM_TOKEN,
    models,
    createProvider,
    openAICompletionsApi,
    resolveRetryPolicy,
    PiAiAdapter,
    ...(withAttachments
      ? {
          // 假附件服务：只需要存在，listModels 不读字节
          resolveAttachments: () => ({}) as any,
          resolveImageAccess: () => undefined,
        }
      : {}),
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

  it("接了附件服务后，按上游 supportsImages 如实声明图片能力", async () => {
    // 实测（2026-10-29）：上游目录 25 个模型里 23 个 supportsImages=true，
    // 真发一张 64×64 PNG → 200 回答「红色」。上游确实吃图，做不到的只是我们
    // 这一侧 —— 接上 resolveAttachments / resolveImageAccess 之后就没有借口了。
    const withImage: HubModel[] = [{ ...MODELS[0]!, supportsImages: true }];
    const listed = await adapterFor(withImage, { withAttachments: true }).listModels(PROVIDER);
    expect(listed[0]?.inputModalities).toEqual(["text", "image"]);
  });

  it("上游说 supportsImages=false 的模型仍只声明文本", async () => {
    const noImage: HubModel[] = [{ ...MODELS[0]!, supportsImages: false }];
    const listed = await adapterFor(noImage, { withAttachments: true }).listModels(PROVIDER);
    expect(listed[0]?.inputModalities).toEqual(["text"]);
  });

  it("没有附件服务时退回纯文本（不宣称做不到的能力）", async () => {
    // 钩子缺失时声明 image 只会在用户贴图时炸出 UNSUPPORTED_CONTENT，
    // 不如如实说不能 —— 宿主会在发送前就拦下并给出清楚的提示。
    const withImage: HubModel[] = [{ ...MODELS[0]!, supportsImages: true }];
    const listed = await adapterFor(withImage, { withAttachments: false }).listModels(PROVIDER);
    expect(listed[0]?.inputModalities).toEqual(["text"]);
  });

  /**
   * 真机事故回归（2026-10-29）：贴图后连报两次
   * `Image request width must be a positive integer.`
   *
   * 根因不是图片本身，而是手拼的 profile 缺了三个必填的图片预算字段 ——
   * `PiAiAdapter.imageRequestTarget()` 读 `profile.requestImagePixelBudget`
   * 与 `requestImageMaxBytes`，undefined 会让算出的目标宽高变成 NaN/0，
   * 宿主附件校验随即拒收。
   *
   * 这条测试直接调 `imageRequestTarget`（宿主就是从这里取宽高的），
   * 断言它给出**正整数**。字段再被删掉时会立刻红。
   */
  it("图片请求目标宽高是正整数（缺 requestImagePixelBudget 会变成 NaN）", () => {
    const withImage: HubModel[] = [{ ...MODELS[0]!, supportsImages: true }];
    const adapter = adapterFor(withImage, { withAttachments: true });
    const target = adapter.imageRequestTarget(PROVIDER, MODELS[0]!.id, {
      attachmentId: "att_test",
      mediaType: "image/png",
      bytes: 1024,
      width: 64,
      height: 64,
    });
    expect(Number.isInteger(target.width)).toBe(true);
    expect(Number.isInteger(target.height)).toBe(true);
    expect(target.width).toBeGreaterThan(0);
    expect(target.height).toBeGreaterThan(0);
    // 字节目标也要是正数，否则 pi-ai 编码时同样炸
    expect(target.maxBytes).toBeGreaterThan(0);
  });
});

describe("思考档位表", () => {
  /**
   * `resolveModel` 返回的是宿主投影（provider/id/name/context/reasoning），
   * 不携带 `thinkingLevelMap` / `compat` —— 这两个字段承载在发请求时真正
   * 用的 pi 模型对象上（openai-completions 直接读 `model.thinkingLevelMap`
   * 与 `model.compat.supportsReasoningEffort`）。所以断言必须打到生产组装
   * （`createHubAdapter` → pi-ai `createProvider`）产出的 piProvider 模型表，
   * 这里用同款注入把 piProvider 截下来，对真对象断言。
   */
  function hubWithCapturedPi(models: HubModel[]) {
    let piProvider: any;
    const adapter = createHubAdapter({
      provider: PROVIDER,
      shimBaseUrl: SHIM,
      shimToken: SHIM_TOKEN,
      models,
      createProvider: (input: any) => (piProvider = createProvider(input)),
      openAICompletionsApi,
      resolveRetryPolicy,
      PiAiAdapter,
    });
    const piModelOf = (id: string) => piProvider.getModels().find((m: any) => m.id === id);
    return { adapter, piModelOf };
  }

  it("reasoning 模型带 thinkingLevelMap 与 compat.supportsReasoningEffort", async () => {
    const models: HubModel[] = [
      { id: "qfmodel", name: "Q", contextWindow: 1_000_000, maxTokens: 32_000, creditMultiplier: 0, supportsImages: false, reasoning: true },
    ];
    const { adapter, piModelOf } = hubWithCapturedPi(models);
    const model = (await adapter.resolveModel(PROVIDER, "qfmodel")) as any;
    expect(model).toBeDefined();
    expect(model.reasoning).toBeTruthy();
    // 用例名里的两个核心交付必须有真断言，否则整段实现删掉测试也照样绿。
    const piModel = piModelOf("qfmodel");
    expect(piModel?.thinkingLevelMap?.high).toBe("high");
    expect(piModel?.compat?.supportsReasoningEffort).toBe(true);
  });

  it("非 reasoning 模型不带档位表", async () => {
    const models: HubModel[] = [
      { id: "m", name: "M", contextWindow: 100_000, maxTokens: 8_000, creditMultiplier: 1, supportsImages: false },
    ];
    const { adapter, piModelOf } = hubWithCapturedPi(models);
    const model = (await adapter.resolveModel(PROVIDER, "m")) as any;
    expect(model).toBeDefined();
    expect(model.reasoning ?? false).toBeFalsy();
    // 投影上本来就不带这两个字段（对 reasoning 模型也一样），
    // 「不带」的真断言同样要打在 pi 模型对象上。
    const piModel = piModelOf("m");
    expect(piModel?.thinkingLevelMap).toBeUndefined();
    expect(piModel?.compat).toBeUndefined();
  });
});