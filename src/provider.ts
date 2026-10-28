/**
 * provider 组装：把「本插件的渠道模型表」翻译成 `dsh-llm-pi-ai` 真正认的 profile。
 *
 * ## 为什么要单独一个模块
 *
 * 这段形状转换是本项目**唯一**一处「错了也能装得上、但一个模型都选不出来」的
 * 地方，必须有独立测试。放在 `index.ts` 里就没法在 vitest 里直接调 —— 那文件
 * 一 import 就会拖进 `resolveDshHome()` 之类的宿主环境。
 *
 * ## 为什么不能直接用配置文档形状
 *
 * `PiAiAdapter.profiles()` 收的是 `dsh-llm-pi-ai` **解析后**的内部 profile，
 * 不是设置文档里的 provider 条目。它的 `current()` 只从 `profile.piProvider`
 * 取模型；缺了它就是空集合。而 `registerAdapter` 照样成功、
 * `llm/listProviders` 照样能看到路由 —— 失败被推迟到「用户去选模型」那一刻。
 */

/** 一个渠道模型在组装 provider 时需要的字段。 */
export interface HubModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  /** 上游给的倍率，用于显示名后缀。 */
  creditMultiplier?: number;
  /** 活动标记文案（如 `Free now`）。 */
  promotionBadge?: string;
  /** 等级标记文案（如 `Pro Only`）。 */
  tierBadge?: string;
}

/**
 * 生成展示名：`Name · x0.00 · Free now`。
 *
 * 与参考实现 `dsh-connect-workbuddy` 的 `workBuddyDisplayName()` 同思路 ——
 * 先例把倍率拼进名字（`GLM-5.3 · x0.79`），用户才能在选模型时看到价格档位。
 * 我们额外带上活动的等级标记，否则「这个模型免费 / 要 Pro」只能去官网查。
 *
 * 只影响**显示**：所有 join（模型选择、请求记录、上游 `model` 字段）
 * 都按 `id`，不按这个名字。
 */
export function displayNameOf(model: HubModel): string {
  const parts = [model.name];
  if (model.creditMultiplier !== undefined) parts.push(`x${model.creditMultiplier.toFixed(2)}`);
  if (model.promotionBadge !== undefined) parts.push(model.promotionBadge);
  else if (model.tierBadge !== undefined) parts.push(model.tierBadge);
  return parts.join(" · ");
}

/**
 * 组装所需的依赖，全部由调用方注入。
 *
 * 注入而不是在模块顶层 import，有两个原因：
 * 1. 测试里能拿到**真实现**（`createProvider` 等），测的就不是 mock；
 * 2. 没凭据时不必为了加载这几个包白拉一次依赖图。
 */
export interface ProviderDeps {
  createProvider: (input: any) => any;
  openAICompletionsApi: () => any;
  resolveRetryPolicy: (value: undefined, label: string) => any;
  PiAiAdapter: new (config: any) => any;
}

export interface BuildProviderInput extends ProviderDeps {
  provider: string;
  shimBaseUrl: string;
  /**
   * shim 本次进程内生成的 Bearer 密钥。
   *
   * **必须是真值，不能是占位字符串。** pi-ai 会把它原样放进
   * `Authorization: Bearer <它>` 发回 shim，而 shim 用 `timingSafeEqual`
   * 比对 —— 给错就是每个请求 401。
   */
  shimToken: string;
  models: HubModel[];
}

/**
 * 惰性 auth 面。
 *
 * 本渠道只靠 shim 的进程内随机密钥认证，所以 pi-ai 自己的凭据生命周期与
 * 环境探测必须一律回答「没有」—— 否则它可能从 `ANTHROPIC_API_KEY` 之类
 * 环境变量里凭空造出一个凭据，绕开 shim 的密钥校验。
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error("dsh-model-hub: the hub route has no pi-ai credential lifecycle");
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

/** 订阅制额度没有可计算的单价；成本由上游账单决定，这里报 0 而不是编一个数。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function buildProviderProfile(input: BuildProviderInput): Record<string, unknown> {
  const { provider, shimBaseUrl, models, createProvider, openAICompletionsApi, resolveRetryPolicy } = input;

  const piModels = models.map((m) => ({
    id: m.id,
    name: displayNameOf(m),
    api: "openai-completions" as const,
    provider,
    baseUrl: shimBaseUrl,
    // **只声明文本**，即使上游目录说 supportsImages。
    //
    // 实测（2026-10-28）：声明 image 后，用户贴图会以
    // `pi-ai image input requires the durable attachment service`
    // (UNSUPPORTED_CONTENT) 让整轮失败 —— 因为我们的 adapter 没有接
    // 宿主的 `resolveAttachments` / `resolveImageAccess`，默认的注入路径不给它。
    //
    // 与其宣称一个做不到的能力、在用户贴图时才炸，不如如实声明纯文本：
    // 宿主会在发送前就拦下并给出清楚的提示。要真支持图片，得先接上附件服务。
    input: ["text"] as const,
    cost: NO_COST,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    // 目录里没有思考档位信息，就不宣称任何档位 —— 宣称了反而会被上游拒。
    reasoning: false,
  }));

  const piProvider = createProvider({
    id: provider,
    name: provider,
    baseUrl: shimBaseUrl,
    auth: {
      // pi-ai 只在 provider 声明了 apiKey 方法时才采纳请求里的 apiKey 覆盖，
      // 所以这个方法必须存在，否则会在发请求前就以 "Provider is not configured" 拒绝。
      apiKey: {
        name: "dsh-model-hub shim",
        resolve: ({ credential }: any) =>
          Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: "dsh-model-hub shim",
          }),
      },
    },
    models: piModels,
    api: openAICompletionsApi(),
  } as any);

  return {
    provider,
    displayName: provider,
    piProvider,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-model-hub retryPolicy"),
  };
}

/**
 * 造出真正能出模型的 adapter。
 *
 * `index.ts` 的生产路径与测试走的是**同一个函数** —— 这样「测过的」和
 * 「装上去的」不可能不一致（本项目已经因为两处形状不一致栽过一次）。
 */
export function createHubAdapter(input: BuildProviderInput): any {
  const profile = buildProviderProfile(input);
  return new input.PiAiAdapter({
    profiles: () => new Map([[input.provider, profile]]),
    auth: INERT_AUTH,
    resolveApiKey: async () => input.shimToken,
  });
}

/**
 * 直连型 provider（ZCode 这类：自带 baseUrl 与 apiKey，不需要我们的 shim）。
 *
 * ## 与 shim 型的区别
 *
 * shim 型（WorkBuddy）把真实 token 握在 host 进程里，请求先回环到自己的
 * shim 再转发，好处是能统一埋点。直连型没有这一层：apiKey 直接交给 pi-ai，
 * 请求从 adapter 直发上游。
 *
 * **代价：直连的请求不会被本插件记录**（没有经过 shim 的埋点）。
 * 这是当前阶段的取舍 —— 先让 ZCode 能用，指标留给后续的协议感知 shim。
 * UI 上不能假装有 ZCode 的 token 速度。
 */
export interface DirectProviderInput extends ProviderDeps {
  provider: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions" | "anthropic-messages";
  models: { id: string; name: string }[];
  /** anthropic 协议需要它；openai 协议传 undefined 即可。 */
  anthropicMessagesApi?: () => any;
}

export function createDirectAdapter(input: DirectProviderInput): any {
  const piModels = input.models.map((m) => ({
    id: m.id,
    name: m.name,
    api: input.api,
    provider: input.provider,
    baseUrl: input.baseUrl,
    input: ["text"] as const,
    cost: NO_COST,
    // 直连型拿不到上游的上下文窗口声明，用一个保守但不算离谱的默认值；
    // 宁可比实际小，也不要虚报导致超长请求被上游拒。
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: false,
  }));

  // 只保留「用到的那个协议」的工厂：传进来的两个工厂都是惰性 import 的，
  // 这里只调用需要的一个，避免多加载一个协议实现。
  const apiImpl = input.api === "anthropic-messages" ? input.anthropicMessagesApi?.() : input.openAICompletionsApi();

  const piProvider = input.createProvider({
    id: input.provider,
    name: input.displayName,
    baseUrl: input.baseUrl,
    auth: {
      apiKey: {
        name: `${input.displayName} (dsh-model-hub)`,
        resolve: ({ credential }: any) =>
          Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: "dsh-model-hub",
          }),
      },
    },
    models: piModels,
    api: apiImpl,
  } as any);

  const profile = {
    provider: input.provider,
    displayName: input.displayName,
    piProvider,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    streamIdleTimeoutMs: 300_000,
    retryPolicy: input.resolveRetryPolicy(undefined, "dsh-model-hub direct retryPolicy"),
  };

  return new input.PiAiAdapter({
    profiles: () => new Map([[input.provider, profile]]),
    auth: INERT_AUTH,
    resolveApiKey: async () => input.apiKey,
  });
}

export { INERT_AUTH };
