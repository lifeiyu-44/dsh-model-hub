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

/**
 * 角色归一：`developer` → `system`。
 *
 * 实测事故（2026-10-28）：DSH 把全局指令放进 `role: "developer"` 的消息，
 * 两家上游都拒：
 *   WorkBuddy: 400 / 11128 / Illegal API invocation from an unapproved channel
 *   Qoder     : 400 / developer is not one of ['system','assistant','user','tool','function']
 * 从被拒请求快照里可以直接看到 `{"role":"developer",...}`。
 */
describe("ensureSystemHead —— 角色归一", () => {
  it("developer 被改成 system", async () => {
    const { ensureSystemHead } = await import("../src/shim/prepare.js");
    const raw = JSON.stringify({ messages: [{ role: "system", content: "s" }, { role: "developer", content: "全局指令" }] });
    const out = JSON.parse(ensureSystemHead(raw)) as { messages: { role: string; content: string }[] };
    expect(out.messages[1]!.role).toBe("system");
    expect(out.messages[1]!.content).toBe("全局指令");
  });

  it("developer 在首位时不再额外插 system（归一后已合规）", async () => {
    const { ensureSystemHead } = await import("../src/shim/prepare.js");
    const raw = JSON.stringify({ messages: [{ role: "developer", content: "全局指令" }, { role: "user", content: "hi" }] });
    const out = JSON.parse(ensureSystemHead(raw)) as { messages: { role: string }[] };
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]!.role).toBe("system");
  });

  it("function 被改成 tool", async () => {
    const { ensureSystemHead } = await import("../src/shim/prepare.js");
    const raw = JSON.stringify({
      messages: [
        { role: "system", content: "s" },
        { role: "assistant", content: "", tool_calls: [{ id: "a" }] },
        { role: "function", name: "f", content: "ok" },
      ],
    });
    const out = JSON.parse(ensureSystemHead(raw)) as { messages: { role: string }[] };
    expect(out.messages[2]!.role).toBe("tool");
  });

  it("已经合规的请求返回**原字符串**（幂等，不重排字段）", async () => {
    const { ensureSystemHead } = await import("../src/shim/prepare.js");
    const raw = JSON.stringify({ messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }], model: "m" });
    expect(ensureSystemHead(raw)).toBe(raw);
  });

  it("是 JSON 但 messages 为空 / 缺失时原样返回", async () => {
    const { ensureSystemHead } = await import("../src/shim/prepare.js");
    expect(ensureSystemHead('{"messages":[]}')).toBe('{"messages":[]}');
    expect(ensureSystemHead('{"model":"m"}')).toBe('{"model":"m"}');
  });
});
/**
 * 默认思考档位：宿主没指定时补最低档。
 *
 * 宿主选择器显示 `Default`（跟随模型默认），而 pi-ai 的模型元数据里没有
 * 「默认档位」字段 —— 所以只能落到请求体上，否则默认会走上游自己的档位。
 */
describe("applyDefaultReasoning", () => {
  it("没提档位时补 minimal", async () => {
    const { applyDefaultReasoning, DEFAULT_REASONING_EFFORT } = await import("../src/shim/prepare.js");
    expect(DEFAULT_REASONING_EFFORT).toBe("minimal");
    const out = JSON.parse(applyDefaultReasoning(JSON.stringify({ model: "m", messages: [] }))) as { reasoning_effort: string };
    expect(out.reasoning_effort).toBe("minimal");
  });

  it("显式选过就不动（用户选择优先）", async () => {
    const { applyDefaultReasoning } = await import("../src/shim/prepare.js");
    const raw = JSON.stringify({ reasoning_effort: "high" });
    expect(applyDefaultReasoning(raw)).toBe(raw);
  });

  it("显式 enable_thinking 时不动（包括显式关掉）", async () => {
    const { applyDefaultReasoning } = await import("../src/shim/prepare.js");
    const raw = JSON.stringify({ enable_thinking: false });
    expect(applyDefaultReasoning(raw)).toBe(raw);
  });

  it("可以传别的档位", async () => {
    const { applyDefaultReasoning } = await import("../src/shim/prepare.js");
    const out = JSON.parse(applyDefaultReasoning('{"a":1}', "medium")) as { reasoning_effort: string };
    expect(out.reasoning_effort).toBe("medium");
  });

  it("非 JSON 原样返回", async () => {
    const { applyDefaultReasoning } = await import("../src/shim/prepare.js");
    expect(applyDefaultReasoning("not json")).toBe("not json");
  });
});