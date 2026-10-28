import React from "react";
import { DATA_PREFIX } from "./types.js";

/**
 * 模型标签槽里的**彩色**后缀（`conversation.input.model.label`）。
 *
 * ## 为什么需要它
 *
 * 宿主把模型名当纯文本渲染，`Name · x0.00 · Free now` 只能是一串灰字。
 * 而参考实现 `dsh-connect-workbuddy` 的彩色 pill 是在这个**插槽里自己画**的：
 * 它拿到 `{ provider, model }`，用上游给的 `badge.color` 画背景色。
 *
 * 所以彩色后缀不是「改模型名」能实现的，必须注册插槽自定义渲染。
 *
 * ## 数据从哪来
 *
 * 客户端拿不到宿主 catalog，只有 `model.id`。host 侧开了
 * `/plugins/dsh-model-hub/catalog` 把 `id -> 倍率/标记/颜色` 发过来，
 * 这里取一次并缓存（目录变化不频繁，5 分钟刷新一次足够）。
 *
 * ## 只接管自己的 provider
 *
 * 不是本插件的模型（provider.id 不是 `hub-` 开头）原样返回宿主给的名字 ——
 * 否则会把别的插件的模型名也改掉。
 */

interface CatalogEntry {
  id: string;
  name: string;
  creditMultiplier?: number;
  promotionBadge?: string;
  tierBadge?: string;
  promotionColor?: string;
  tierColor?: string;
}

const REFRESH_MS = 5 * 60_000;

/** 全模块共享一份缓存，避免每个标签实例各拉一次。 */
let cache: Map<string, CatalogEntry> | undefined;
let fetchedAt = 0;
let inflight: Promise<void> | undefined;

async function ensureCatalog(): Promise<void> {
  const fresh = Date.now() - fetchedAt < REFRESH_MS;
  if (cache !== undefined && fresh) return;
  if (inflight !== undefined) return inflight;

  inflight = (async () => {
    try {
      const response = await fetch(`${DATA_PREFIX}/catalog`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const body = (await response.json()) as { models?: CatalogEntry[] };
      const next = new Map<string, CatalogEntry>();
      for (const entry of body.models ?? []) next.set(entry.id, entry);
      cache = next;
      fetchedAt = Date.now();
    } catch {
      // 拿不到就退化成「只显示名字」—— 标签不该因为一次网络失败而消失
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** 让 `#RRGGBB` 变成带透明度的背景色，pill 里更耐看。 */
function tint(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    const hex = color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : color;
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.14)`;
  }
  return undefined;
}

export function ModelLabel(props: { provider?: { id?: string }; model?: { id?: string; name?: string } }): React.ReactElement {
  const providerId = props.provider?.id ?? "";
  const modelId = props.model?.id ?? "";
  const fallback = props.model?.name ?? modelId;

  const [entry, setEntry] = React.useState<CatalogEntry | undefined>(() => cache?.get(modelId));

  React.useEffect(() => {
    // 不是本插件的模型：不接管，直接显示宿主给的名字
    if (!providerId.startsWith("hub-")) return;
    let live = true;
    void ensureCatalog().then(() => {
      if (live) setEntry(cache?.get(modelId));
    });
    return () => {
      live = false;
    };
  }, [providerId, modelId]);

  // 不是 hub 的模型，或目录里没有这个 id —— 原样返回
  if (!providerId.startsWith("hub-") || entry === undefined) {
    return React.createElement("span", null, fallback);
  }

  const rate = entry.creditMultiplier;
  const badge = entry.promotionBadge ?? entry.tierBadge;
  const badgeColor = entry.promotionColor ?? entry.tierColor;
  const background = tint(badgeColor);

  return React.createElement(
    "span",
    { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
    React.createElement("span", null, entry.name),
    rate === undefined
      ? null
      : React.createElement(
          "span",
          { style: { fontSize: "0.92em", opacity: 0.7, fontVariantNumeric: "tabular-nums" } },
          `· x${rate.toFixed(2)}`,
        ),
    badge === undefined
      ? null
      : React.createElement(
          "span",
          {
            style: {
              fontSize: "0.78em",
              lineHeight: 1.5,
              padding: "0 6px",
              borderRadius: 999,
              fontWeight: 600,
              whiteSpace: "nowrap",
              // 有颜色就用上游的色（淡底 + 原色字），没有就退回中性灰
              ...(badgeColor === undefined
                ? { background: "rgba(127,127,127,0.15)", color: "inherit" }
                : { background, color: badgeColor, border: `1px solid ${badgeColor}` }),
            },
          },
          badge,
        ),
  );
}
