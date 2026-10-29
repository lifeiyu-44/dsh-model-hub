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
  /**
   * 上游是否支持思考档位。如实声明才会出现「思考强度」控件；
   * 声明 true 但上游不认则会被 400 拒。
   */
  reasoning?: boolean;
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
  /**
   * 宿主的 durable attachment 服务（`ctx.get("attachments")`）。
   *
   * **这是图片输入的唯一前提**：pi-ai 收到带 image block 的请求时会先要求
   * 这个服务存在，否则直接抛
   * `pi-ai image input requires the durable attachment service`。
   * 装配层把它做成惰性函数 —— 插件可能先于 attachments 服务就绪，
   * 每次请求现取才不会拿到 undefined 就永久失能。
   */
  resolveAttachments?: () => any;
  /**
   * 把一个附件引用映射成「当前工具执行世界」里的只读路径。
   * 宿主的 `fs` 服务提供 `processPathFromHostPath`；拿不到就返回 undefined
   * （图片仍能进请求，只是模型工具读不到本地副本）。
   */
  resolveImageAccess?: (attachments: any, ref: any) => any;
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
    // **图片输入如实按上游目录声明。**
    //
    // 实测（2026-10-29）：
    //   · 上游目录 25 个模型里 23 个 `supportsImages: true`；
    //   · 真发一张 64×64 PNG + "这是什么颜色" → 200，回答「红色」。
    // 也就是说上游确实吃图，之前做不到的只有我们这一侧。
    //
    // 之前的障碍（2026-10-28 实测）：pi-ai 收到 image block 时会先要求
    // 宿主的 durable attachment 服务存在，否则抛
    // `pi-ai image input requires the durable attachment service`
    // (UNSUPPORTED_CONTENT)。现在 `createHubAdapter` 把
    // `resolveAttachments` / `resolveImageAccess` 两个钩子接上了，
    // 那个前提已经满足，所以可以如实声明能力。
    //
    // 仍然保留「没有附件服务就退回纯文本」的降级：钩子缺失时声明 image
    // 只会在用户贴图时炸，不如如实说不能。
    input: (input.resolveAttachments === undefined ? ["text"] : m.supportsImages ? ["text", "image"] : ["text"]) as
      | readonly ["text"]
      | readonly ["text", "image"],
    cost: NO_COST,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    // 思考档位如实按渠道目录声明：Qoder 目录里有 is_reasoning，
    // 之前一律写 false，导致选了 Qoder 模型也没有「思考强度」可选。
    reasoning: m.reasoning === true,
    // **档位表 + compat 必须一起给**，缺一不可（参考实现 toPiModel 同款）：
    //
    // - `thinkingLevelMap`：把宿主的档位名映射成上游 effort。没有它时
    //   pi-ai 虽然认为「所有档位都支持」，但宿主的选择器只显示 `Default`，
    //   而且**不会按模型记住**用户选的档位 —— 用户实测报的两个问题
    //   （切换模型档位丢失 / 切回来不记忆）都源于此。
    // - `compat.supportsReasoningEffort`：pi-ai 只在这个开关打开时才把
    //   `reasoning_effort` 放进请求体（openai-completions.js 里有明确的
    //   `compat.supportsReasoningEffort` 判断）。不给它，思考档位就是个摆设。
    //
    // 映射成同名：两个上游（WorkBuddy / Qoder）都接受标准的
    // minimal/low/medium/high effort 字符串（均已实测 200）。
    ...(m.reasoning === true
      ? {
          thinkingLevelMap: {
            off: null,
            minimal: "minimal",
            low: "low",
            medium: "medium",
            high: "high",
          },
          compat: { supportsReasoningEffort: true },
        }
      : {}),
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

    // ── 图片预算三件套（**缺一个就整轮报错**）──
    //
    // 真机事故（2026-10-29）：贴图发送后连报两次
    // `Image request width must be a positive integer.`
    //
    // 根因：`PiAiAdapter.imageRequestTarget()` 是
    //
    //     requestImageTarget(image, {
    //       maxPixels: profile.requestImagePixelBudget,   // ← undefined
    //       maxBytes:  profile.requestImageMaxBytes,      // ← undefined
    //     })
    //
    // 再经 `requestImageDimensions(ref.width, ref.height, undefined)`，
    // 算出的目标宽高成了 NaN/0，宿主的附件存储校验直接拒：
    // 「宽度必须是正整数」。
    //
    // 我们的 profile 是**手拼**的（不是走宿主配置解析那条路），所以宿主在
    // `resolvePiAiProviderProfile` 里补的默认值不会自动出现在这里。三个字段
    // 在 `ResolvedPiAiProviderProfile` 上是 required number，必须显式给。
    //
    // 取值抄宿主自己的默认（`lib/index.js` 的 `?? 20971520 / 4194304 / 1048576`），
    // 不自创：多模态上游能吃的图不会比这更大，而比宿主更宽松只会让请求
    // 在别处被拒得更晚、更难查。
    maxRequestImageBytes: 20 * 1024 * 1024, // 单请求 base64 图片总量上限
    requestImagePixelBudget: 4 * 1024 * 1024, // 单张请求版本的像素预算（4MP）
    requestImageMaxBytes: 1024 * 1024, // 单张请求版本的编码字节目标（1MB）
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
    // ── 图片输入的两个钩子 ──
    //
    // pi-ai 的图片链路是：宿主把用户贴的图存成 durable attachment（不可变、
    // 内容寻址），请求里只放 `ImageAttachmentRef`；stream 时才由 pi-ai 自己
    // 读字节、按模型路由的 target 尺寸重新编码，最终变成上游要的
    // `image_url` 内容块。所以这里要提供的只是「服务在哪」与「怎么映射路径」，
    // 不需要我们自己拼 base64 —— 那正是 2026-10-28 误判的地方。
    //
    // 两个都做成惰性：插件装配可能早于 attachments / fs 服务就绪，
    // 每次请求现取才不会永久失能。缺服务时 pi-ai 会明确报
    // `image input requires the durable attachment service`，不静默降级。
    ...(input.resolveAttachments === undefined ? {} : { resolveAttachments: input.resolveAttachments }),
    ...(input.resolveImageAccess === undefined ? {} : { resolveImageAccess: input.resolveImageAccess }),
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
