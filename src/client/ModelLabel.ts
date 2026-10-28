import React from "react";
import { DATA_PREFIX } from "./types.js";

/**
 * 模型标签槽里的**彩色**后缀（`conversation.input.model.label`）。
 *
 * ## 为什么要占这个槽
 *
 * 宿主把模型名当纯文本渲染，`· x0.00 · Free now` 只能是灰字。
 * 彩色标记必须在这个插槽里自己画（参考实现同样如此）。
 *
 * ## 归属判断：按目录命中，不按 provider 前缀
 *
 * 实测（2026-10-28）宿主传进来的 props 里取 `provider.id` 不可靠 ——
 * 曾经因为它取不到就走兜底，结果模型列表全是纯文本、一个彩色标记都没有
 * （DOM 里能看到槽挂上了，内容却只是名字）。
 * 现在改成：**拿 `model.id` 去查我们自己的目录**，命中即归我们。
 * 目录里只有本插件的模型，这个判断既准确又不依赖宿主传参的形状。
 *
 * ## 数据从哪来
 *
 * 客户端不知道倍率与颜色，由 host 的 `/plugins/dsh-model-hub/catalog`
 * 下发 `id -> 倍率/标记/颜色`。5 分钟刷新一次，全模块共享一份缓存。
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

let cache: Map<string, CatalogEntry> | undefined;
let fetchedAt = 0;
let inflight: Promise<void> | undefined;

async function ensureCatalog(): Promise<void> {
  if (cache !== undefined && Date.now() - fetchedAt < REFRESH_MS) return;
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
      // 拿不到就退化成纯名字 —— 标签不该因为一次网络失败而消失
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** `#RRGGBB` → 14% 透明度的同色（pill 底色）。 */
function tint(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)
    ? color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color
    : undefined;
  if (hex === undefined) return undefined;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

/**
 * 倍率的语义色 —— 「重要信息」里最该有颜色的一档：
 * 免费 = 绿，偏贵（≥2） = 琥珀，其余中性灰。
 */
function rateColor(rate: number): string {
  if (rate === 0) return "var(--dmh-success, #22c55e)";
  if (rate >= 2) return "var(--dmh-warn, #f59e0b)";
  return "var(--dmh-label-tertiary, #9ca3af)";
}

export function ModelLabel(props: Record<string, any>): React.ReactElement {

  // 宿主的传参形状实测有几种，全部兼容
  const modelId: string = props?.model?.id ?? props?.modelId ?? props?.model?.modelId ?? "";
  const fallbackName: string = props?.model?.name ?? modelId;

  const [entry, setEntry] = React.useState<CatalogEntry | undefined>(() => cache?.get(modelId));

  React.useEffect(() => {
    if (modelId === "") return;
    // 已经缓存过就同步取，避免闪一下纯文本
    const hit = cache?.get(modelId);
    if (hit !== undefined) {
      setEntry(hit);
      return;
    }
    let live = true;
    void ensureCatalog().then(() => {
      if (live) setEntry(cache?.get(modelId));
    });
    return () => {
      live = false;
    };
  }, [modelId]);

  // 目录里没有 → 不是本插件的模型，原样显示宿主给的名字
  if (entry === undefined) {
    return React.createElement("span", null, fallbackName);
  }

  const rate = entry.creditMultiplier;
  const badge = entry.promotionBadge ?? entry.tierBadge;
  // 上游给了颜色就用它；没给的话，活动标记按绿、等级标记按青
  const badgeColor =
    entry.promotionColor ?? entry.tierColor ?? (entry.promotionBadge === undefined ? "#009273" : "#22c55e");
  const background = tint(badgeColor) ?? "rgba(127,127,127,0.15)";

  return React.createElement(
    "span",
    { style: { display: "inline-flex", alignItems: "center", gap: 5 } },
    React.createElement("span", null, entry.name),
    rate === undefined
      ? null
      : React.createElement(
          "span",
          {
            style: {
              fontSize: "0.92em",
              fontWeight: 600,
              color: rateColor(rate),
              fontVariantNumeric: "tabular-nums",
            },
          },
          `x${rate.toFixed(2)}`,
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
              background,
              color: badgeColor,
              border: `1px solid ${badgeColor}`,
            },
          },
          badge,
        ),
  );
}
