import { describe, expect, it } from "vitest";
import { createServer } from "node:http";

/**
 * **假上游断言「shim 真的把 system 头补上了」**。
 *
 * 上面 `live-upstream.spec.ts` 证明「补头之后真上游接受」，但它没证明
 * 「补头这件事是 shim 干的」—— 如果 DSH 自己碰巧带了 system，那条测试也会绿。
 *
 * 所以这里用一个假上游把**收到的请求体**记下来，直接断言
 * `messages[0].role === "system"`。两条测试合起来才闭合：
 *   这条证明 shim 补了头，那条证明补了头上游就认。
 */

async function captureUpstream() {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        seen.push(JSON.parse(body));
      } catch {
        seen.push(body);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port, seen };
}

describe("shim 转发时补 system 头", () => {
  it("客户端不带 system 时，上游收到的首条是 system", async () => {
    const { server, port, seen } = await captureUpstream();
    const { startShim } = await import("../src/shim/server.js");
    const shim = await startShim({
      prepare: async () => ({ baseUrl: `http://127.0.0.1:${port}`, headers: {} }),
      record: () => {},
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: "hy3", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      expect(response.status).toBe(200);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(seen).toHaveLength(1);
      const forwarded = seen[0];
      expect(Array.isArray(forwarded.messages)).toBe(true);
      expect(forwarded.messages).toHaveLength(2);
      expect(forwarded.messages[0].role).toBe("system");
      expect(forwarded.messages[1]).toEqual({ role: "user", content: "hi" });
      // 模型名不能被补头逻辑弄丢
      expect(forwarded.model).toBe("hy3");
    } finally {
      shim.close();
      server.close();
    }
  }, 20_000);

  it("客户端已带 system 时，上游收到的仍是原样一条（不重复添加）", async () => {
    const { server, port, seen } = await captureUpstream();
    const { startShim } = await import("../src/shim/server.js");
    const shim = await startShim({
      prepare: async () => ({ baseUrl: `http://127.0.0.1:${port}`, headers: {} }),
      record: () => {},
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({
          model: "hy3",
          messages: [
            { role: "system", content: "my own prompt" },
            { role: "user", content: "hi" },
          ],
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const forwarded = seen[0];
      expect(forwarded.messages).toHaveLength(2);
      expect(forwarded.messages[0]).toEqual({ role: "system", content: "my own prompt" });
    } finally {
      shim.close();
      server.close();
    }
  }, 20_000);
});
