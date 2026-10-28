import { describe, expect, it } from "vitest";
import { startShim } from "../src/shim/server.js";

/**
 * 回归：**业务错误藏在 HTTP 200 的流里**时，记录必须是失败。
 *
 * 实测事故（2026-10-28）：Qoder 上游永远回 HTTP 200，真正的失败是流里的
 * error chunk（429 / All backends failed）。shim 当时只看 HTTP 状态码，
 * 于是把每次失败重试记成「200 + 0 token + 无错误」——
 * 面板上表现为「成功但没有任何用量」，用户因此看不到 token 与上下文占用。
 *
 * 这组用假上游（本进程起的 http 服务）复现这条路径，不依赖外网。
 */

function startFakeUpstream(sseLines: string[]): Promise<{ url: string; close: () => void }> {
  // 用 node:http 起一个只回 SSE 的本地上游
  return new Promise((resolve) => {
    import("node:http").then(({ createServer }) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const line of sseLines) res.write(`${line}\n`);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
      });
    });
  });
}

describe("shim 记录业务错误", () => {
  it("流里出现 error chunk 时记成失败，而不是 200 + 0 token", async () => {
    const upstream = await startFakeUpstream([
      `data: ${JSON.stringify({ error: { message: "Qoder 上游 429：All backends failed", type: "qoder_error" } })}`,
      "data: [DONE]",
      "",
    ]);

    const recorded: { statusCode: number; error?: string; model: string }[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: upstream.url.replace(/^http:\/\//, "http://"), headers: {} }),
      // 这个渠道的上游是「标准 OpenAI 形状但把错误塞在流里」，用方言钩子透传
      dialect: {
        request: async (input) => ({
          url: `${upstream.url}/v1/chat/completions`,
          headers: { "content-type": "application/json" },
          body: input.raw,
        }),
        decodeLine: (line) => (line.startsWith("data:") ? line : null),
      },
      record: (input) => {
        recorded.push({ statusCode: input.statusCode, error: input.error, model: input.model });
      },
    });

    try {
      await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: "qfmodel", messages: [{ role: "user", content: "hi" }] }),
      });
    } finally {
      shim.close();
      upstream.close();
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.statusCode, "业务错误不能记成 2xx").toBe(502);
    expect(recorded[0]!.error, "必须带上上游原文").toContain("All backends failed");
  });

  it("正常流仍然记成 200 并带上 usage", async () => {
    const upstream = await startFakeUpstream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 8 } })}`,
      "data: [DONE]",
      "",
    ]);

    const recorded: { statusCode: number; tokens: number }[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: upstream.url, headers: {} }),
      dialect: {
        request: async (input) => ({
          url: `${upstream.url}/v1/chat/completions`,
          headers: { "content-type": "application/json" },
          body: input.raw,
        }),
        decodeLine: (line) => (line.startsWith("data:") ? line : null),
      },
      record: (input) => {
        recorded.push({ statusCode: input.statusCode, tokens: input.metrics.inputTokens + input.metrics.outputTokens });
      },
    });

    try {
      await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: "qfmodel", messages: [{ role: "user", content: "hi" }] }),
      });
    } finally {
      shim.close();
      upstream.close();
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.statusCode).toBe(200);
    expect(recorded[0]!.tokens, "usage 要能被解析出来").toBe(128);
  });
});
