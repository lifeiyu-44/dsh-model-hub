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
