import { describe, expect, it } from "vitest";
import { TurnTimer } from "../src/shim/recorder.js";

describe("TurnTimer", () => {
  it("computes TTFT from request start to first non-empty delta", () => {
    const t = new TurnTimer(0);
    t.onUpstreamHead(300);
    t.onDelta("x", 700);
    const r = t.onEnd(2000, { inputTokens: 100, outputTokens: 200, cacheRead: 0, cacheWrite: 0 });
    expect(r.upstreamHeadMs).toBe(300);
    expect(r.firstTokenMs).toBe(700);
    expect(r.durationMs).toBe(2000);
    expect(r.decodeTps).toBeCloseTo(200 / ((2000 - 700) / 1000), 5);
  });

  it("marks non-streaming turns with undefined decodeTps", () => {
    const t = new TurnTimer(0);
    const m = t.onEnd(500, { inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheWrite: 0 });
    expect(m.firstTokenMs).toBeUndefined();
    expect(m.decodeTps).toBeUndefined();
    expect(m.durationMs).toBe(500);
  });

  it("estimates tokens when upstream reports none", () => {
    const t = new TurnTimer(0);
    t.onDelta("abcdefgh", 100);
    const m = t.onEnd(1000);
    expect(m.estimated).toBe(true);
    expect(m.outputTokens).toBe(2);
  });

  it("ignores empty deltas for the first-token mark", () => {
    const t = new TurnTimer(0);
    t.onDelta("", 100);
    t.onDelta("", 200);
    t.onDelta("z", 300);
    const m = t.onEnd(1000);
    expect(m.firstTokenMs).toBe(300);
  });
});
