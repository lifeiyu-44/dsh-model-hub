import { afterAll, describe, expect, it } from "vitest";
import { startShim } from "../src/shim/server.js";
import { discoverTraeSession } from "../src/channels/trae/credentials.js";
import { fetchTraeCatalog } from "../src/channels/trae/catalog.js";
import { createTraeDialect } from "../src/channels/trae/chat.js";

/**
 * 真机联调：用**本机 Trae 的登录态**打一次真实对话，走完整的
 * shim → 方言 → Trae 上游 → OpenAI SSE 链路。
 *
 * 与 `trae.spec.ts` 的区别：那边用假上游验协议翻译，这边验「真实上游认不认
 * 我们的请求形状」—— `config_name` 选模型、`x-ide-version-code` 头、
 * `event:`/`data:` 分行，三样任何一个不对都拿不到正文。
 *
 * 没有本机登录态时整组跳过（CI/别人的机器上不该红）。
 */

const SAVED = process.env.TRAE_USER_DATA;
delete process.env.TRAE_USER_DATA; // 回到「按默认位置扫描」
const discovered = discoverTraeSession();
if (SAVED !== undefined) process.env.TRAE_USER_DATA = SAVED;

const credential = discovered.session?.credential;

describe.skipIf(credential === undefined)("Trae live: 本机登录态打真实上游", () => {
  afterAll(async () => {
    // 不关 undici 的 keep-alive 连接，整套测试跑完进程会挂在那条到
    // coreva-normal.trae.ai 的长连接上，vitest 只能强杀 worker（表现为
    // 「全绿但退出码 1」）。这里显式关一次全局 dispatcher。
    const dispatcher = (globalThis as Record<symbol, { close?: () => Promise<void> } | undefined>)[
      Symbol.for("undici.globalDispatcher.1")
    ];
    await dispatcher?.close?.();
  });

  it("经 shim 发一次真实对话，拿到 OpenAI SSE 正文与 usage", async () => {
    const target = credential!;
    const catalog = fetchTraeCatalog(target);
    const model = catalog.models[0];
    expect(model).toBeDefined();

    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: "https://trae.invalid", headers: {}, account: { id: "trae-live" } }),
      dialect: createTraeDialect({ credentialFor: async () => target }),
      record: (entry) => records.push(entry),
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({
          model: model!.id,
          messages: [{ role: "user", content: "只回两个字：你好" }],
          stream: true,
          max_tokens: 32,
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("[DONE]");
      // 正文必须真的出现：只拿到 [DONE] 说明上游回了 event:error
      expect(text).not.toContain('"error"');
      expect(text).toMatch(/"content":"[^"]+"/);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(records).toHaveLength(1);
      expect(records[0].statusCode).toBe(200);
      expect(records[0].metrics.outputTokens).toBeGreaterThan(0);
      expect(records[0].model).toBe(model!.id);
    } finally {
      shim.close();
    }
  }, 90_000);

  it("真实工具轮：工具声明被上游接受，tool_calls 被翻出来且终止原因是 tool_calls", async () => {
    const target = credential!;
    const model = fetchTraeCatalog(target).models[0]!;
    const shim = await startShim({
      prepare: async () => ({ baseUrl: "https://trae.invalid", headers: {}, account: { id: "trae-live" } }),
      dialect: createTraeDialect({ credentialFor: async () => target }),
      record: () => {},
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: "查一下北京天气，请调用 get_weather" }],
          stream: true,
          max_tokens: 128,
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "查询城市天气",
                parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              },
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"tool_calls"');
      expect(text).toContain("get_weather");
      expect(text).toContain('"finish_reason":"tool_calls"');
      expect(text).toContain("[DONE]");
    } finally {
      shim.close();
    }
  }, 90_000);
});
