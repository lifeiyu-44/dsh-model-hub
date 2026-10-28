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

  // 活动标记（`Free now`）与等级标记（`Pro Only`）是**独立数组**，
  // 各自用 `modelIds` 指向模型 —— 不写在模型条目里（实测 2026-10-28）。
  const promotionOf = badgeIndex(data["modelPromotions"]);
  const tierOf = badgeIndex(data["modelTiers"]);
  // 颜色单独取，供浏览器侧画彩色 pill
  const promotionColorOf = badgeColorIndex(data["modelPromotions"]);
  const tierColorOf = badgeColorIndex(data["modelTiers"]);

  return models.flatMap((entry) => {
    const model = toChannelModel(entry, { promotionOf, tierOf, promotionColorOf, tierColorOf });
    return model === undefined ? [] : [model];
  });
}

/**
 * 上游条目 → 渠道模型。
 *
 * 抽成独立函数是为了能单测：这里踩过两个显示错误
 * （上下文窗口取值、思考档位声明），都得靠测试钉住。
 *
 * `badges` 是可选的活动/等级标记查表；不传就只有基础字段。
 */
export function toChannelModel(
  entry: Record<string, unknown>,
  badges: {
    promotionOf?: (id: string) => string | undefined;
    tierOf?: (id: string) => string | undefined;
    promotionColorOf?: (id: string) => string | undefined;
    tierColorOf?: (id: string) => string | undefined;
  } = {},
): ChannelModel | undefined {
  const id = typeof entry["id"] === "string" ? entry["id"] : "";
  if (id === "") return undefined;

  const maxInput = typeof entry["maxInputTokens"] === "number" ? entry["maxInputTokens"] : 200_000;
  const maxOutput = typeof entry["maxOutputTokens"] === "number" ? entry["maxOutputTokens"] : 32_000;
  // `maxAllowedSize` 是上游给的**窗口上限**（实测 default-model: 200000），
  // 而 `maxInputTokens`（176000）是「单次输入建议值」。
  // 拿后者当 contextWindow 会让宿主提前压缩，并把用量百分比显示得偏高
  // （用户实测报过「上下文已用 336K / 180K 100%」）。
  const maxAllowed = typeof entry["maxAllowedSize"] === "number" ? entry["maxAllowedSize"] : 0;
  const contextWindow = Math.max(maxInput, maxAllowed);

  const promotion = badges.promotionOf?.(id);
  const tier = badges.tierOf?.(id);
  const promotionColor = badges.promotionColorOf?.(id);
  const tierColor = badges.tierColorOf?.(id);

  return {
    id,
    name: typeof entry["name"] === "string" ? entry["name"] : id,
    contextWindow,
    maxTokens: maxOutput,
    // `credits` 是字符串倍率，空串 = 免费。数字解析失败按 0 处理（免费），
    // 因为拿不到价格时按「免费」展示比按「贵」展示更少误导 —— 实际花费
    // 仍由上游账单决定，这个字段只用于面板排序与提示。
    creditMultiplier: parseCredits(entry["credits"]),
    supportsImages: entry["supportsImages"] === true,
    // 思考档位：WorkBuddy 的 `/v3/config` **不提供**逐模型的 reasoning 标记
    // （实测目录里只有 credits/description/limits/supportsToolCall 等字段）。
    // 但上游**确实接受**这两个参数（实测 2026-10-28，hy3 带
    // `reasoning_effort: "high"` 与 `enable_thinking: true` 都返回 200），
    // 所以统一声明为支持 —— 否则宿主不给「思考强度」控件，用户没得选。
    // 对不支持的模型，上游会忽略这个参数，不会报错。
    reasoning: true,
    ...(promotion === undefined ? {} : { promotionBadge: promotion }),
    ...(tier === undefined ? {} : { tierBadge: tier }),
    ...(promotionColor === undefined ? {} : { promotionColor }),
    ...(tierColor === undefined ? {} : { tierColor }),
  };
}

/**
 * 把「带 modelIds 的标记数组」转成 `模型 id -> 标记文案` 的查表。
 *
 * 上游形状（实测 2026-10-28）：
 * ```json
 * { "badge": { "label": "Free now", "color": "#FF0000" },
 *   "modelIds": ["hy3"], "enabled": true, "priority": 200 }
 * ```
 * 只取 `enabled !== false` 的条目；同一模型多条时 `priority` 高的胜出。
 * 文案按上游原样返回 —— 那是给用户看的字，不改写。
 */
export function badgeIndex(value: unknown): (modelId: string) => string | undefined {
  const table = new Map<string, { label: string; priority: number }>();
  if (!Array.isArray(value)) return () => undefined;

  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry["enabled"] === false) continue;
    const badge = entry["badge"];
    if (typeof badge !== "object" || badge === null) continue;
    const label = (badge as Record<string, unknown>)["label"];
    if (typeof label !== "string" || label === "") continue;
    const priority = typeof entry["priority"] === "number" ? entry["priority"] : 0;
    const ids = entry["modelIds"];
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const previous = table.get(id);
      if (previous === undefined || priority >= previous.priority) table.set(id, { label, priority });
    }
  }

  return (modelId) => table.get(modelId)?.label;
}

/**
 * 标记的颜色，与 {@link badgeIndex} 同源但单独取。
 *
 * 颜色是给**浏览器侧**渲染彩色标签用的：宿主的模型标签槽
 * （`conversation.input.model.label`）允许自定义渲染，参考实现就是在那里
 * 用 `badge.color` 画彩色 pill 的。所以颜色要能从 host 传到 client。
 *
 * 只接受 `#rgb` / `#rrggbb` / `rgb(...)` 这类安全的 CSS 颜色字面量 ——
 * 上游是外部数据，不该让任意字符串进 `style.background`。
 */
export function badgeColorIndex(value: unknown): (modelId: string) => string | undefined {
  const table = new Map<string, { color: string; priority: number }>();
  if (!Array.isArray(value)) return () => undefined;

  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry["enabled"] === false) continue;
    const badge = entry["badge"];
    if (typeof badge !== "object" || badge === null) continue;
    const color = (badge as Record<string, unknown>)["color"];
    if (typeof color !== "string" || !isSafeCssColor(color)) continue;
    const priority = typeof entry["priority"] === "number" ? entry["priority"] : 0;
    const ids = entry["modelIds"];
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const previous = table.get(id);
      if (previous === undefined || priority >= previous.priority) table.set(id, { color, priority });
    }
  }

  return (modelId) => table.get(modelId)?.color;
}

/** 只放行十六进制与 rgb()/rgba() 字面量。 */
function isSafeCssColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) || /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)$/.test(value);
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
