import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { startShim } from "../src/shim/server.js";

/**
 * shim 的端到端测试。
 *
 * 前面的 `sse.spec.ts` 测的是「单行解析对不对」，`recorder.spec.ts` 测的是
 * 「计时算术对不对」—— 都是零件。这一组测**装起来能不能跑**：
 * 真起一个上游、真发一个流式请求、真检查记录里的 TTFT 与 tok/s。
 *
 * 理由是 P0 栽过一次「零件全绿、整机不通」（provider 注册成空壳）。
 * 所以关键路径上必须有一条打到「完整一次请求」的断言。
 */

/** 起一个假上游：分块吐三个字，最后带 usage。 */
async function fakeUpstream(chunkDelayMs = 60) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = ["你", "好", "世界"];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
        } else {
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(timer);
        }
      }, chunkDelayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port };
}

describe("shim 端到端", () => {
  it("转发流式请求并记录真实的 TTFT 与 tok/s", async () => {
    const { server, port } = await fakeUpstream(60);
    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: `http://127.0.0.1:${port}`, headers: {} }),
      record: (r) => records.push(r),
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: "Hy3", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const body = await response.text();
      expect(body).toContain("你");

      // record 在 finally 里同步调用，但给事件循环一拍确保已落地
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(records).toHaveLength(1);

      const record = records[0];
      expect(record.statusCode).toBe(200);
      expect(record.model).toBe("Hy3");
      expect(record.isStreaming).toBe(true);
      expect(record.metrics.inputTokens).toBe(11);
      expect(record.metrics.outputTokens).toBe(3);
      // 三个块之间有间隔，所以 TTFT 必须是真的测出来的正数
      expect(record.metrics.firstTokenMs).toBeGreaterThan(0);
      expect(record.metrics.decodeTps).toBeGreaterThan(0);
      expect(record.metrics.estimated).toBe(false);
    } finally {
      shim.close();
      server.close();
    }
  }, 20_000);

  /**
   * 这条是补真实事故的：`resolveApiKey` 曾返回字面量 `"shim"`，
   * 而 shim 自己生成的是随机密钥 —— 于是每个真实请求都被 401 拒掉。
   * 断言「错的密钥必须被拒」，防止再有人拿占位字符串糊过去。
   */
  it("用占位字符串 'shim' 当密钥必须被拒（真实密钥是随机的）", async () => {
    const shim = await startShim({
      prepare: async () => ({ baseUrl: "http://127.0.0.1:1", headers: {} }),
      record: () => {},
    });
    try {
      expect(shim.token()).not.toBe("shim");
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer shim" },
      });
      expect(response.status).toBe(401);
    } finally {
      shim.close();
    }
  });

  it("拒绝没有正确 Bearer 的请求", async () => {
    const shim = await startShim({
      prepare: async () => ({ baseUrl: "http://127.0.0.1:1", headers: {} }),
      record: () => {},
    });
    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: "POST" });
      expect(response.status).toBe(401);
    } finally {
      shim.close();
    }
  });

  it("上游失败时如实记录状态码，不伪造成功", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: `http://127.0.0.1:${port}`, headers: {} }),
      record: (r) => records.push(r),
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: "Hy3", messages: [], stream: true }),
      });
      expect(response.status).toBe(500);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(records[0].statusCode).toBe(500);
      expect(records[0].error).toContain("500");
    } finally {
      shim.close();
      server.close();
    }
  }, 20_000);
});
