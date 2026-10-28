import { describe, expect, it } from "vitest";
import { ensureSystemHead, FALLBACK_SYSTEM_PROMPT } from "../src/shim/prepare.js";

/**
 * 这一组守的是实测的上游硬约束：
 * 国际网关对首条消息不是 system 的请求返回 400 / 11128
 * （"first message is not system prompt"）。
 *
 * 没有这条兜底时，DSH 发来的 `messages[0]` 是 user，每个请求都被拒。
 */

const body = (messages: unknown[]) => JSON.stringify({ model: "hy3", messages, stream: true });

describe("ensureSystemHead", () => {
  it("首条是 user 时补一条 system 到最前面", () => {
    const out = ensureSystemHead(body([{ role: "user", content: "hi" }]));
    const doc = JSON.parse(out);
    expect(doc.messages).toHaveLength(2);
    expect(doc.messages[0]).toEqual({ role: "system", content: FALLBACK_SYSTEM_PROMPT });
    expect(doc.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("首条已经是 system 时原样返回（同一个字符串引用，不做无谓改写）", () => {
    const input = body([{ role: "system", content: "custom" }, { role: "user", content: "hi" }]);
    expect(ensureSystemHead(input)).toBe(input);
  });

  it("system 角色大小写不敏感（上游自己也是 toLowerCase 判断）", () => {
    const input = body([{ role: "SYSTEM", content: "x" }, { role: "user", content: "hi" }]);
    expect(ensureSystemHead(input)).toBe(input);
  });

  it("不改动其它字段（model / stream / temperature 都保留）", () => {
    const input = JSON.stringify({
      model: "deepseek-v4.1-flash-sg",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.3,
    });
    const doc = JSON.parse(ensureSystemHead(input));
    expect(doc.model).toBe("deepseek-v4.1-flash-sg");
    expect(doc.stream).toBe(true);
    expect(doc.temperature).toBe(0.3);
  });

  it("不是 JSON 时原样返回（让上游报它自己的错，而不是我们改坏）", () => {
    expect(ensureSystemHead("not json at all")).toBe("not json at all");
  });

  it("messages 不是数组或为空时原样返回", () => {
    const noMessages = JSON.stringify({ model: "hy3" });
    expect(ensureSystemHead(noMessages)).toBe(noMessages);
    const empty = body([]);
    expect(ensureSystemHead(empty)).toBe(empty);
  });

  it("JSON 顶层不是对象时原样返回", () => {
    expect(ensureSystemHead("[1,2,3]")).toBe("[1,2,3]");
    expect(ensureSystemHead("null")).toBe("null");
    expect(ensureSystemHead('"str"')).toBe('"str"');
  });

  it("多次调用幂等（第二次不再加）", () => {
    const once = ensureSystemHead(body([{ role: "user", content: "hi" }]));
    expect(ensureSystemHead(once)).toBe(once);
  });
});
