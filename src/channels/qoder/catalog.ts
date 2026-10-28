import type { ChannelModel } from "../types.js";
import { buildCosyHeaders } from "./cosy.js";
import type { QoderSession } from "./credentials.js";

/**
 * Qoder 模型目录。
 *
 * ## 端点
 *
 * `GET https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1`
 *
 * `/algo` 前缀必须有：少了会被 ALB 挡成 **503**（不是 401），很容易误判成
 * 「token 不对」。同网关的 chat 路径本来就带 `/algo`。
 *
 * ## 响应形状（实测 2026-10-28）
 *
 * ```json
 * { "chat": [ { "key":"auto", "display_name":"Auto", "enable":true,
 *               "is_reasoning":true, "is_vl":true, "price_factor":0.5,
 *               "max_input_tokens":200000, "is_default":true }, … ],
 *   "developer": [...], "assistant": [...], … }
 * ```
 *
 * 只用 `chat` 那一组 —— 那是对话模型；其余是 inline / quest / 应用市场之类。
 * 10 个模型里 `key` 才是请求要用的 model id，`display_name` 是给人看的。
 */

const DEFAULT_GATEWAY = "https://gateway.qoder.com.cn";
const PATH_MODELS = "/algo/api/v2/model/list?Encode=1";

/** 拿不到上游声明的上下文窗口时的保守默认。 */
const FALLBACK_CONTEXT = 128_000;

/**
 * 输出 token 上限。
 *
 * 上游目录**没给** max output，所以只能自己定。取 32000 而不是 8192 的原因：
 * 模型声明了 `reasoning: true` 之后，宿主会从 `max_tokens` 里划走一块当思考预算
 * （pi-ai 的 `adjustMaxTokensForThinking`，minimal 档也要 1024）。
 * 8192 的预算被划掉一块后，正文很容易被截断。
 */
const FALLBACK_MAX_TOKENS = 32_000;

interface RawModel {
  key?: unknown;
  display_name?: unknown;
  enable?: unknown;
  is_reasoning?: unknown;
  is_vl?: unknown;
  price_factor?: unknown;
  max_input_tokens?: unknown;
  /** 上游给的上下文档位表，如 { "1M": { token_count: 1000000 }, "200K": {...} }。 */
  context_config?: unknown;
  is_default?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 取真实的上下文窗口。
 *
 * **`max_input_tokens` 不是窗口上限。** 实测 qfmodel：`max_input_tokens` 是
 * 180000，但 `context_config` 里默认档是 200K，还支持 400K 与 1M。
 * 之前拿 `max_input_tokens` 当 contextWindow，用户看到的是「336K / 180K = 100%」，
 * 而同一账号 318K 的请求其实**成功了** —— 说明真实上限远大于 180K。
 *
 * 取所有档位里的**最大值**（该模型确实支持到那里），拿不到再用
 * `max_input_tokens` 兜底。宁可让宿主晚一点压缩，也不要提前压缩把历史截掉。
 */
export function contextWindowOf(raw: RawModel): number {
  const config = raw.context_config;
  if (typeof config === "object" && config !== null && !Array.isArray(config)) {
    let max = 0;
    for (const tier of Object.values(config as Record<string, unknown>)) {
      if (typeof tier !== "object" || tier === null) continue;
      const count = asNumber((tier as Record<string, unknown>)["token_count"]);
      if (count !== undefined && count > max) max = count;
    }
    if (max > 0) return max;
  }
  return asNumber(raw.max_input_tokens) ?? FALLBACK_CONTEXT;
}

/** 把上游条目翻成渠道模型；字段缺失时用保守默认，不猜能用的能力。 */
export function toChannelModel(raw: RawModel): ChannelModel | undefined {
  const id = typeof raw.key === "string" && raw.key !== "" ? raw.key : undefined;
  if (id === undefined) return undefined;

  const display = typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : id;
  const context = contextWindowOf(raw);

  return {
    id,
    name: display,
    contextWindow: context,
    maxTokens: Math.min(FALLBACK_MAX_TOKENS, context),
    // `price_factor` 就是倍率（0 = 免费，实测 qfmodel/dfmodel 是 0）
    creditMultiplier: asNumber(raw.price_factor) ?? 0,
    // 只认 `is_vl` 明确为 true 的；但本插件当前只声明纯文本（见 provider.ts）
    supportsImages: raw.is_vl === true,
    // 思考档位：目录里 `is_reasoning` 就是它。声明后宿主才显示「思考强度」。
    reasoning: raw.is_reasoning === true,
  };
}

export interface FetchCatalogResult {
  models: ChannelModel[];
  /** 上游原始条目数（诊断用：能看出是不是被裁剪了）。 */
  rawCount: number;
  error?: string;
}

/**
 * 拉一次目录。
 *
 * 不抛错：拿不到就返回空 + error，让调用方决定怎么记录。
 * 插件不能因为一个平台连不上就整体失效。
 */
export async function fetchQoderCatalog(
  session: QoderSession,
  options: { gatewayBase?: string } = {},
): Promise<FetchCatalogResult> {
  const gateway = (options.gatewayBase ?? DEFAULT_GATEWAY).replace(/\/+$/, "");
  const url = `${gateway}${PATH_MODELS}`;

  try {
    const headers = buildCosyHeaders(null, url, {
      userID: session.userID,
      authToken: session.jobToken,
      name: session.name,
      email: session.email,
    });
    const response = await fetch(url, {
      headers: { ...headers, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) {
      return { models: [], rawCount: 0, error: `HTTP ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}` };
    }

    const doc = JSON.parse(text) as Record<string, unknown>;
    const chat = Array.isArray(doc["chat"]) ? (doc["chat"] as RawModel[]) : [];
    const enabled = chat.filter((entry) => entry?.enable !== false);

    return {
      models: enabled.map(toChannelModel).filter((model): model is ChannelModel => model !== undefined),
      rawCount: chat.length,
    };
  } catch (error) {
    return { models: [], rawCount: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
