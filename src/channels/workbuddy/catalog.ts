import type { ChannelModel } from "../types.js";

/** 桌面端 UA —— 上游按客户端通道裁剪配置，CLI UA 会少给模型和促销字段。 */
const DESKTOP_UA = "WorkBuddy/5.12.1 WorkBuddy/5.12.1 CLI/2.63.2";

export function upstreamBase(region: "cn" | "global"): string {
  return region === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
}

/**
 * 拉模型目录。
 *
 * 必须用桌面端身份读 `/v3/config`：CLI 通道的答复是 App 通道的严格子集，
 * 既不发布 modelPromotions 也不发布 modelTiers（实测：CLI 5 键 35 模型，
 * App 18 键 37 模型）。
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
    return [{
      id,
      name: typeof entry["name"] === "string" ? entry["name"] : id,
      contextWindow: typeof entry["contextWindow"] === "number" ? entry["contextWindow"] : 200_000,
      maxTokens: typeof entry["maxTokens"] === "number" ? entry["maxTokens"] : 32_000,
      creditMultiplier: typeof entry["creditMultiplier"] === "number" ? entry["creditMultiplier"] : 0,
      supportsImages: entry["supportsImages"] === true,
    }];
  });
}
