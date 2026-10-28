import { describe, expect, it } from "vitest";
import { parseCredits } from "../src/channels/workbuddy/catalog.js";

describe("parseCredits", () => {
  it("parses the real upstream format (with x prefix and unit)", () => {
    expect(parseCredits("x0.34 credits")).toBeCloseTo(0.34, 5);
    expect(parseCredits("x3.31 credits")).toBeCloseTo(3.31, 5);
    expect(parseCredits("x0.00")).toBe(0);
    expect(parseCredits("x6.67")).toBeCloseTo(6.67, 5);
  });

  it("returns 0 for an empty string (the free default model)", () => {
    expect(parseCredits("")).toBe(0);
    expect(parseCredits("   ")).toBe(0);
  });

  it("does not turn a real price into 0 by accident", () => {
    expect(parseCredits("x1.00")).toBe(1);
    expect(parseCredits("x0.03")).toBeCloseTo(0.03, 5);
  });

  it("accepts a plain number too", () => {
    expect(parseCredits(2.5)).toBe(2.5);
    expect(parseCredits(Number.NaN)).toBe(0);
  });

  it("returns 0 for unparseable input", () => {
    expect(parseCredits("free")).toBe(0);
    expect(parseCredits(null)).toBe(0);
  });
});

/**
 * 上下文窗口与思考档位的映射。
 *
 * 两处都是用户实测报上来的显示错误：
 * - 「上下文已用 336K / 180K 100%」：拿 max_input_tokens 当窗口上限，而上游
 *   另有 maxAllowedSize（更大）。
 * - 「没有思考强度可选」：一律声明 reasoning: false，而上游其实接受参数。
 */
describe("toChannelModel 的窗口与思考档位", () => {
  const base = { id: "m", name: "M", credits: "", supportsImages: false };

  it("contextWindow 取 maxInputTokens 与 maxAllowedSize 的较大者", async () => {
    const { toChannelModel } = await import("../src/channels/workbuddy/catalog.js");
    const model = toChannelModel({ ...base, maxInputTokens: 176000, maxAllowedSize: 200000, maxOutputTokens: 24000 });
    expect(model!.contextWindow).toBe(200000);
  });

  it("只有 maxInputTokens 时用它", async () => {
    const { toChannelModel } = await import("../src/channels/workbuddy/catalog.js");
    const model = toChannelModel({ ...base, maxInputTokens: 128000, maxOutputTokens: 8000 });
    expect(model!.contextWindow).toBe(128000);
  });

  it("声明 reasoning: true（上游接受 reasoning_effort / enable_thinking，实测 200）", async () => {
    const { toChannelModel } = await import("../src/channels/workbuddy/catalog.js");
    const model = toChannelModel({ ...base, maxInputTokens: 100000 });
    expect(model!.reasoning).toBe(true);
  });
});