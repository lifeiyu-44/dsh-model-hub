import { describe, expect, it } from "vitest";
import { parseSseLine } from "../src/shim/upstream.js";

describe("parseSseLine", () => {
  it("reads an OpenAI content delta", () => {
    const r = parseSseLine(`data: {"choices":[{"delta":{"content":"Hi"}}]}`);
    expect(r.text).toBe("Hi");
  });

  it("reads an Anthropic text_delta", () => {
    const r = parseSseLine(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Yo"}}`);
    expect(r.text).toBe("Yo");
  });

  it("reads OpenAI usage", () => {
    const r = parseSseLine(`data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}`);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheWrite: 0 });
  });

  it("reads Anthropic usage with cache fields", () => {
    const r = parseSseLine(`data: {"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5}}`);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheRead: 5, cacheWrite: 0 });
  });

  it("recognizes [DONE] and ignores comments", () => {
    expect(parseSseLine("data: [DONE]").done).toBe(true);
    expect(parseSseLine(": keep-alive").done).toBe(false);
    expect(parseSseLine("").done).toBe(false);
  });

  it("ignores unparseable payloads instead of throwing", () => {
    expect(parseSseLine("data: {not json").done).toBe(false);
  });
});
