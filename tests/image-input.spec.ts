import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { startShim } from "../src/shim/server.js";
import { ensureSystemHead, applyDefaultReasoning } from "../src/shim/prepare.js";

/**
 * 图片输入的端到端测试 —— **上游确实吃图**这条结论的回归保护。
 *
 * ## 背景（2026-10-29 实测）
 *
 * 之前 `provider.ts` 一律声明 `input: ["text"]`，理由是「pi-ai 收到 image
 * block 会要求 durable attachment 服务，我们没有」。但实测证明**上游本身
 * 支持图片**：真发一张 64×64 纯红 PNG + "这是什么颜色"，上游 200 并回答
 * 「红色」；目录里 25 个模型有 23 个 `supportsImages: true`。
 * 所以缺的只是我们这一侧的附件钩子，不是上游能力。
 *
 * ## 这组测试守什么
 *
 * shim 是请求的必经之路，它会不会把图片内容块弄丢/改写，是「图片能不能真的
 * 到上游」的最后一环。这里用一个记录请求体的假上游，断言：
 *   1. `image_url` 内容块原样穿过 shim（字节级一致）
 *   2. shim 的 body 改写（补 system 头、注入 reasoning）**不动**内容数组
 *   3. 带图的请求同样被记录（埋点不因图片而漏）
 */

/** 1×1 之外的、像样的图片 base64（64×64 纯红 PNG 足够小又合法）。 */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAPUlEQVR42u3OMQEAAAgDoC251a3gLwSgOXLV" +
  "kiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJ0iN1A0RAAAG7YQ2iAAAAAElFTkSuQmCC";

/** 起一个假上游，把收到的请求体存下来。 */
async function capturingUpstream(): Promise<{ port: number; bodies: any[]; close: () => Promise<void> }> {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(raw));
      } catch {
        bodies.push(raw);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "红色" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("图片输入端到端", () => {
  it("image_url 内容块原样穿过 shim 到上游（字节级一致）", async () => {
    const upstream = await capturingUpstream();
    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: `http://127.0.0.1:${upstream.port}`, headers: {} }),
      record: (r) => records.push(r),
    });

    try {
      const messages = [
        { role: "system", content: "You are a helpful assistant." },
        {
          role: "user",
          content: [
            { type: "text", text: "这张图是什么颜色？只回答颜色。" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
          ],
        },
      ];
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: "deepseek-v4.1-flash", messages, stream: true }),
      });
      expect(response.status).toBe(200);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(upstream.bodies).toHaveLength(1);
      const sent = upstream.bodies[0];
      const userContent = sent.messages.find((m: any) => m.role === "user").content;
      expect(Array.isArray(userContent)).toBe(true);
      // 文本块仍在
      expect(userContent[0]).toEqual({ type: "text", text: "这张图是什么颜色？只回答颜色。" });
      // 图片块原样（base64 一个字节都不能变，否则上游会判 invalid image）
      expect(userContent[1].type).toBe("image_url");
      expect(userContent[1].image_url.url).toBe(`data:image/png;base64,${RED_PNG_B64}`);

      // 带图请求照样被记录（埋点不因图片而漏）
      expect(records).toHaveLength(1);
      expect(records[0].statusCode).toBe(200);
    } finally {
      await shim.close();
      await upstream.close();
    }
  });

  it("shim 的 body 改写（补 system / 注入 reasoning）不动内容数组", () => {
    // 这两个函数是 shim 对 body 的唯一改写点。图片在 content 数组里，
    // 任何一处「重建 messages」的写法都可能把它丢掉 —— 这里直接锁住。
    const raw = JSON.stringify({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
          ],
        },
      ],
    });

    const withSystem = JSON.parse(ensureSystemHead(raw));
    const userContent = withSystem.messages.find((m: any) => m.role === "user").content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent[1].image_url.url).toBe(`data:image/png;base64,${RED_PNG_B64}`);

    const withReasoning = JSON.parse(applyDefaultReasoning(ensureSystemHead(raw)));
    const content2 = withReasoning.messages.find((m: any) => m.role === "user").content;
    expect(content2[1].image_url.url).toBe(`data:image/png;base64,${RED_PNG_B64}`);
  });
});
