import { randomUUID } from "node:crypto";
import type { ChannelModel } from "../types.js";

/** 桌面端 UA —— 上游按客户端通道裁剪配置，CLI UA 会少给模型和促销字段。 */
const DESKTOP_UA = "WorkBuddy/5.12.1 WorkBuddy/5.12.1 CLI/2.63.2";

export function upstreamBase(region: "cn" | "global"): string {
  return region === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
}

/**
 * 会话身份三件套。
 *
 * **渠道校验（11128）认的是这三个请求头，不是提示词。** 这是实测纠正 ——
 * 设计规格里原写的「在句读处插 U+200B」是错的：带 system 头 + 零宽空格
 * 两种写法都照样 400，只有补上这三个头才 200。
 *
 * 三个都要，少一个不行（实测：只给 X-Conversation-ID 仍然失败）。
 * 网关不校验来源，只要格式是合法 UUID；但**每次请求现生成**，不跨请求复用 ——
 * 复用等于伪造一段自己并不拥有的对话身份，上游对同一 id 的两次关联会立刻错乱。
 */
export function conversationIdentityHeaders(): Record<string, string> {
  return {
    "X-Conversation-ID": randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "X-Conversation-Message-ID": randomUUID(),
  };
}

/**
 * 拉模型目录。
 *
 * 必须用桌面端身份读 `/v3/config`：CLI 通道的答复是 App 通道的严格子集，
 * 既不发布 modelPromotions 也不发布 modelTiers（实测：CLI 5 键 35 模型，
 * App 18 键 37 模型）。
 *
 * **真实字段名**（实测 2026-10-27，`data.models[28]`）：
 * `id` / `name` / `maxInputTokens` / `maxOutputTokens` / `supportsImages` /
 * `supportsToolCall` / `credits`（字符串，空串表示免费）/ `vendor`。
 * 没有 `contextWindow`，也没有 `creditMultiplier` —— 别照别的插件的字段名写。
 */
export async function fetchCatalog(
  region: "cn" | "global",
  token: string,
  signal?: AbortSignal,
): Promise<ChannelModel[]> {
  const url = `${upstreamBase(region)}/v3/config`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": DESKTOP_UA,
      Accept: "application/json",
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${response.status}`);

  const doc = (await response.json()) as Record<string, unknown>;
  const data = (doc["data"] ?? doc) as Record<string, unknown>;
  const models = Array.isArray(data["models"]) ? (data["models"] as Record<string, unknown>[]) : [];

  return models.flatMap((entry) => {
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    if (id === "") return [];
    const maxInput = typeof entry["maxInputTokens"] === "number" ? entry["maxInputTokens"] : 200_000;
    const maxOutput = typeof entry["maxOutputTokens"] === "number" ? entry["maxOutputTokens"] : 32_000;
    return [{
      id,
      name: typeof entry["name"] === "string" ? entry["name"] : id,
      // 上游只给 maxInputTokens；把它当作上下文窗口的上限向 DSH 宣称。
      contextWindow: maxInput,
      maxTokens: maxOutput,
      // `credits` 是字符串倍率，空串 = 免费。数字解析失败按 0 处理（免费），
      // 因为拿不到价格时按「免费」展示比按「贵」展示更少误导 —— 实际花费
      // 仍由上游账单决定，这个字段只用于面板排序与提示。
      creditMultiplier: parseCredits(entry["credits"]),
      supportsImages: entry["supportsImages"] === true,
    }];
  });
}

/**
 * 解析倍率。
 *
 * 上游格式是**带前缀和单位的字符串**，不是纯数字（实测 2026-10-27）：
 *   `"x0.34 credits"` / `"x3.31 credits"` / `"x0.00"` / `""`
 * 直接 `Number()` 会全部得到 NaN —— 那会让每个模型都显示成免费。
 */
export function parseCredits(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const match = /x?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(value.trim());
  if (match === null) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : 0;
}
