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

  it("treats usage: null as absent instead of crashing", () => {
    // 实测 workbuddy 网关会在流式 chunk 里发 `"usage": null`。
    // typeof null === 'object'，不单独判空就会在读字段时抛 TypeError 打断整条流。
    expect(() => parseSseLine(`data: {"choices":[{"delta":{"content":"x"}}],"usage":null}`)).not.toThrow();
    const r = parseSseLine(`data: {"choices":[{"delta":{"content":"x"}}],"usage":null}`);
    expect(r.text).toBe("x");
    expect(r.usage).toBeUndefined();
  });

  it("treats usage: [] as absent", () => {
    const r = parseSseLine(`data: {"usage":[]}`);
    expect(r.usage).toBeUndefined();
  });
});
