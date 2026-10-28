import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createHubAdapter, type HubModel } from "../src/provider.js";
import { startShim } from "../src/shim/server.js";

/**
 * **整机**测试：pi-ai adapter → shim → 上游。
 *
 * 这是本项目最有价值的一条测试，因为它覆盖了两次真实事故的交界处：
 *
 * 1. 第一次：provider 注册成空壳（profile 缺 `piProvider`）—— 模型列表为空。
 * 2. 第二次：`resolveApiKey` 返回字面量 `"shim"`，而 shim 生成的是随机密钥
 *    —— 每个真实请求 401。
 *
 * 两次都是「零件测试全绿、整机不通」。所以这里不做任何 mock 拼接：
 * 真的起 shim、真的用 adapter 发请求、真的断言上游收到了流量。
 */

const PROVIDER = "hub-workbuddy-global";

const MODELS: HubModel[] = [
  { id: "Hy3", name: "Hy3", contextWindow: 200_000, maxTokens: 32_000, supportsImages: false },
];

/**
 * 假上游：按 OpenAI 流式协议吐两帧 + usage + `[DONE]`。
 *
 * **必须带 `finish_reason`** —— 少了它 pi-ai 会判 `Stream ended without
 * finish_reason` 并给出 `TRANSPORT` 失败（实测）。那是上游的契约问题，
 * 不是我们插件的，但会让这条测试假红。
 */
function fakeUpstream(onRequest?: (auth: string | undefined) => void) {
  return createServer((req, res) => {
    onRequest?.(req.headers.authorization);
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

describe("整机：adapter → shim → 上游", () => {
  it("adapter 发出的请求能穿过 shim 的密钥校验并拿到流式回复", async () => {
    let seenAuth: string | undefined;
    const upstream = fakeUpstream((auth) => {
      seenAuth = auth;
    });
    const upstreamPort = await listen(upstream);

    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}`, headers: {} }),
      record: (r) => records.push(r),
    });

    const adapter = createHubAdapter({
      provider: PROVIDER,
      shimBaseUrl: shim.baseUrl(),
      // 关键：给的是 shim 的真密钥，不是占位字符串
      shimToken: shim.token(),
      models: MODELS,
      createProvider,
      openAICompletionsApi,
      resolveRetryPolicy,
      PiAiAdapter,
    });

    try {
      const stream = adapter.stream(
        { provider: PROVIDER, model: "Hy3", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as any,
        { signal: new AbortController().signal },
      );

      const chunks: any[] = [];
      for await (const chunk of stream) chunks.push(chunk);

      // 401 的话不会有任何 text-delta
      const text = chunks
        .filter((c) => c?.type === "text-delta")
        .map((c) => c.text)
        .join("");
      expect(text).toBe("你好");

      // 流必须正常收尾，不是 TRANSPORT 失败
      const finish = chunks.find((c) => c?.type === "finish");
      expect(finish?.reason?.kind).toBe("stop");

      // shim 的 prepare 没给上游设 Authorization —— 真实 token 不该泄漏给 shim 之外的层
      expect(seenAuth).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(records).toHaveLength(1);
      expect(records[0].statusCode).toBe(200);
      expect(records[0].metrics.inputTokens).toBe(5);
      expect(records[0].metrics.outputTokens).toBe(2);
    } finally {
      shim.close();
      upstream.close();
    }
  }, 30_000);
});
