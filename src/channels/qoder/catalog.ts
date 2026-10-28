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
const FALLBACK_MAX_TOKENS = 8_192;

interface RawModel {
  key?: unknown;
  display_name?: unknown;
  enable?: unknown;
  is_reasoning?: unknown;
  is_vl?: unknown;
  price_factor?: unknown;
  max_input_tokens?: unknown;
  is_default?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 把上游条目翻成渠道模型；字段缺失时用保守默认，不猜能用的能力。 */
export function toChannelModel(raw: RawModel): ChannelModel | undefined {
  const id = typeof raw.key === "string" && raw.key !== "" ? raw.key : undefined;
  if (id === undefined) return undefined;

  const display = typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : id;
  const context = asNumber(raw.max_input_tokens) ?? FALLBACK_CONTEXT;

  return {
    id,
    name: display,
    contextWindow: context,
    maxTokens: Math.min(FALLBACK_MAX_TOKENS, context),
    // `price_factor` 就是倍率（0 = 免费，实测 qfmodel/dfmodel 是 0）
    creditMultiplier: asNumber(raw.price_factor) ?? 0,
    // 只认 `is_vl` 明确为 true 的；但本插件当前只声明纯文本（见 provider.ts）
    supportsImages: raw.is_vl === true,
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
