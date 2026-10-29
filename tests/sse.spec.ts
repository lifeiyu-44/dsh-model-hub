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

  /**
   * 思考模型的首 token 就是 reasoning 的第一个增量。
   *
   * 真机事故（2026-10-29）：之前只认 `delta.content`，思考模型的
   * `delta.reasoning_content` 被完全忽略 —— 上游先花 24 秒吐 reasoning
   * （不计入首 token），再花 0.8 秒吐正文（被当成 3664 token 的全部耗时），
   * 面板因此出现 4378 tok/s 这种物理不可能的速度。
   *
   * 宿主的权威口径是 `dsh-llm` 的 `isTokenDelta`：
   * `text-delta` 与 `reasoning-delta` 都算首 token。这里锁住同样的语义。
   */
  it("把 reasoning_content 也算作 token 增量（思考模型的首 token）", () => {
    const r = parseSseLine(`data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}`);
    expect(r.text).toBe("思考中");
  });

  it("正文与 reasoning 同时出现时优先正文", () => {
    const r = parseSseLine(
      `data: {"choices":[{"delta":{"reasoning_content":"想","content":"答"}}]}`,
    );
    expect(r.text).toBe("答");
  });

  it("Anthropic 的 thinking_delta 也算 token 增量", () => {
    const r = parseSseLine(
      `data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"嗯"}}`,
    );
    expect(r.text).toBe("嗯");
  });

  it("工具调用片段也算模型开始产出", () => {
    const r = parseSseLine(
      `data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"read","arguments":"{\\"p\\""}}]}}]}`,
    );
    expect(r.text).toBe("read");
  });

  it("空字符串增量不算（避免把空 delta 当首 token）", () => {
    expect(parseSseLine(`data: {"choices":[{"delta":{"content":""}}]}`).text).toBeUndefined();
    expect(parseSseLine(`data: {"choices":[{"delta":{"reasoning_content":""}}]}`).text).toBeUndefined();
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
