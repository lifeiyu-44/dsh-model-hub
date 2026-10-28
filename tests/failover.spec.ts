import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { startShim } from "../src/shim/server.js";

/**
 * shim 的凭据类失败换号重试（401/402/403/429）+ account 贯通。
 *
 * 关键前提：换号只允许发生在**尚未向客户端发出任何字节**之前 ——
 * 所以这里用假上游（本进程起的 http 服务）验证真实 HTTP 行为：
 * 第一枪 401 → shim 静默换单号再打 → 客户端只看到最终 200。
 * 400 属于非凭据类失败，直接透传，绝不换号（多打一次都是浪费配额）。
 */

/**
 * 假上游：记录每个请求的 Authorization，并按 `status` 回话。
 * `status` 也可以给函数按「第几次请求」取值（第一用例要 401 → 200）。
 */
function upstreamReturning(status: number | ((nth: number) => number), authSeen: string[]) {
  let nth = 0;
  return createServer((req, res) => {
    nth += 1;
    authSeen.push(String(req.headers.authorization));
    req.on("data", () => {});
    req.on("end", () => {
      const code = typeof status === "function" ? status(nth) : status;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(code === 200 ? '{"ok":true}' : '{"error":"denied"}');
    });
  });
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

describe("shim 换号重试", () => {
  it("prepare 换账号重试：首账号 401 → 次账号 200，结果各记一次", async () => {
    const authSeen: string[] = [];
    const up = upstreamReturning((n) => (n === 1 ? 401 : 200), authSeen);
    const port = await listen(up);

    const accounts = ["a1", "a2"];
    let pick = 0;
    const results: any[] = [];
    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: { authorization: `Bearer ${accounts[pick]}` },
        account: { id: accounts[pick] },
      }),
      maxAttempts: () => 3,
      onAccountResult: (account, ok, status) => {
        results.push({ id: account.id, ok, status });
        // 失败就换下一个账号（真实场景里这是渠道侧选择器的事，这里直接推进计数器）
        if (!ok) pick = Math.min(pick + 1, accounts.length - 1);
      },
      record: (r) => records.push(r),
    });

    try {
      const res = await fetch(`${shim.baseUrl()}/v1/x`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${shim.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "m" }),
      });
      expect(res.status).toBe(200);
      expect(authSeen).toEqual(["Bearer a1", "Bearer a2"]); // 换了一次号
      // 每次尝试的结局各上报一次：a1 失败（401）、a2 成功（200）
      expect(results).toEqual([
        { id: "a1", ok: false, status: 401 },
        { id: "a2", ok: true, status: 200 },
      ]);
      // record 每次**上游尝试**各一行（规格 §6）：401 那枪 + 200 那枪各一行，
      // account_id 各归各 —— 记录表才对得上「这次请求换过号」，
      // 否则面板只看到一枪 200，被换掉的账号像从没失败过。
      await new Promise((r) => setTimeout(r, 100));
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ statusCode: 401, accountId: "a1" });
      expect(String(records[0].error)).toContain("401");
      expect(records[0].metrics.outputTokens).toBe(0); // 被换掉的尝试没有产出
      expect(records[1]).toMatchObject({ statusCode: 200, accountId: "a2" });
      expect(records[1].error).toBeUndefined();
      await res.text();
    } finally {
      shim.close();
      up.close();
    }
  });

  it("400 不换号；非凭据类失败直接透传", async () => {
    const authSeen: string[] = [];
    const up = upstreamReturning(400, authSeen);
    const port = await listen(up);

    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer a1" },
        account: { id: "a1" },
      }),
      maxAttempts: () => 3,
      onAccountResult: () => {}, // 400 不换号：即便给了换号额度也不该再用一个账号
      record: (r) => records.push(r),
    });

    try {
      const res = await fetch(`${shim.baseUrl()}/v1/x`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${shim.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "m" }),
      });
      expect(res.status).toBe(400);
      expect(authSeen).toHaveLength(1); // 同一账号只打一次，不换号
      await new Promise((r) => setTimeout(r, 100));
      expect(records).toHaveLength(1);
      expect(records[0].accountId).toBe("a1"); // accountId 贯通到 record
      await res.text();
    } finally {
      shim.close();
      up.close();
    }
  });

  it("5xx 也换号：首账号 502 → 次账号 200（不计熔断口径）", async () => {
    const authSeen: string[] = [];
    const up = upstreamReturning((n) => (n === 1 ? 502 : 200), authSeen);
    const port = await listen(up);

    const accounts = ["a1", "a2"];
    let pick = 0;
    const results: any[] = [];
    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: { authorization: `Bearer ${accounts[pick]}` },
        account: { id: accounts[pick] },
      }),
      maxAttempts: () => 3,
      onAccountResult: (account, ok, status) => {
        results.push({ id: account.id, ok, status });
        if (!ok) pick = Math.min(pick + 1, accounts.length - 1);
      },
      record: (r) => records.push(r),
    });

    try {
      const res = await fetch(`${shim.baseUrl()}/v1/x`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${shim.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "m" }),
      });
      expect(res.status).toBe(200);
      expect(authSeen).toEqual(["Bearer a1", "Bearer a2"]); // 5xx 也换了一次号
      // shim 如实上报 502 为失败；「不计熔断」由 markAccountResult 的
      // isCredentialFailure(502)=false 保证（见 tests/mutations.spec.ts）。
      expect(results).toEqual([
        { id: "a1", ok: false, status: 502 },
        { id: "a2", ok: true, status: 200 },
      ]);
      // 同样每次尝试各记一行：502 那枪 + 200 那枪
      await new Promise((r) => setTimeout(r, 100));
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ statusCode: 502, accountId: "a1" });
      expect(records[1]).toMatchObject({ statusCode: 200, accountId: "a2" });
      await res.text();
    } finally {
      shim.close();
      up.close();
    }
  });
});
