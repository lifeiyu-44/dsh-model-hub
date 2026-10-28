import { describe, expect, it } from "vitest";
import { badgeIndex } from "../src/channels/workbuddy/catalog.js";
import { displayNameOf } from "../src/provider.js";

/**
 * 展示名与标记的测试。
 *
 * 背景（用户实测反馈 2026-10-28）：WorkBuddy 原插件的模型列表带
 * `· x0.34` 与 `Free now` / `Pro Only` 标记，而 hub 的模型名是干净的 ——
 * 因为我们在映射时把倍率与标记丢了。这一组守的就是别再把它们丢掉。
 *
 * 上游真实形状（实测）：标记在**独立数组**里用 modelIds 指模型，
 * 不写在模型条目内。
 */

const PROMOTIONS = [
  {
    badge: { color: "#FF0000", display: "activeOnly", label: "Free now" },
    enabled: true,
    id: "hy3-free-trial",
    modelIds: ["hy3"],
    priority: 200,
  },
  {
    badge: { label: "Disabled one" },
    enabled: false,
    modelIds: ["hy3"],
    priority: 999,
  },
];

const TIERS = [
  {
    badge: { color: "#009273", label: "Pro Only", labelEn: "Pro Only" },
    enabled: true,
    id: "gpt-pro-only",
    modelIds: ["gpt-6-astra", "grok-4.7"],
    priority: 200,
  },
];

describe("badgeIndex", () => {
  it("按 modelIds 建出查表", () => {
    const of = badgeIndex(PROMOTIONS);
    expect(of("hy3")).toBe("Free now");
    expect(of("unknown")).toBeUndefined();
  });

  it("disabled 的条目被忽略（哪怕 priority 更高）", () => {
    expect(badgeIndex(PROMOTIONS)("hy3")).toBe("Free now");
  });

  it("一个标记可以覆盖多个模型", () => {
    const of = badgeIndex(TIERS);
    expect(of("gpt-6-astra")).toBe("Pro Only");
    expect(of("grok-4.7")).toBe("Pro Only");
  });

  it("非数组 / 脏数据不抛，返回查不到", () => {
    for (const bad of [undefined, null, 42, "x", {}]) {
      expect(() => badgeIndex(bad)).not.toThrow();
      expect(badgeIndex(bad)("hy3")).toBeUndefined();
    }
    const dirty = [{ badge: null }, { modelIds: "not-array" }, null, 7];
    expect(() => badgeIndex(dirty)).not.toThrow();
  });

  it("同模型多条时 priority 高的胜出", () => {
    const of = badgeIndex([
      { badge: { label: "low" }, modelIds: ["m"], priority: 10 },
      { badge: { label: "high" }, modelIds: ["m"], priority: 99 },
    ]);
    expect(of("m")).toBe("high");
  });
});

describe("displayNameOf", () => {
  const base = { id: "hy3", name: "Hy3", contextWindow: 200_000, maxTokens: 32_000, supportsImages: false };

  it("带倍率与活动标记", () => {
    expect(displayNameOf({ ...base, creditMultiplier: 0, promotionBadge: "Free now" })).toBe("Hy3 · x0.00 · Free now");
  });

  it("带倍率与等级标记", () => {
    expect(
      displayNameOf({ ...base, name: "GPT-6-Astra", creditMultiplier: 6.67, tierBadge: "Pro Only" }),
    ).toBe("GPT-6-Astra · x6.67 · Pro Only");
  });

  it("活动标记优先于等级标记（同一个模型不会同时挂两个）", () => {
    expect(
      displayNameOf({ ...base, creditMultiplier: 0, promotionBadge: "Free now", tierBadge: "Pro Only" }),
    ).toBe("Hy3 · x0.00 · Free now");
  });

  it("没有倍率时只有名字（不硬编 x0.00）", () => {
    expect(displayNameOf(base)).toBe("Hy3");
  });

  it("只有标记没有倍率", () => {
    expect(displayNameOf({ ...base, tierBadge: "Pro Only" })).toBe("Hy3 · Pro Only");
  });
});
