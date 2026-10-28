import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { startShim } from "../src/shim/server.js";

/**
 * **真实上游**测试（需要本机有 WorkBuddy 凭据）。
 *
 * 这一组是唯一能证明「插件真的能打通上游」的测试 —— 其余测试都用假上游，
 * 只能证明协议形状对，不能证明上游认。
 *
 * 实测背景（2026-10-28）：不带 system 首条时上游返回
 * `400 / code 11128 / "first message is not system prompt"`。
 * 所以这里故意发**不带 system** 的请求，验证 shim 的 `ensureSystemHead` 兜住了。
 *
 * 没有凭据时整组跳过，不让 CI 红。
 */

const VAULT = "C:\\Users\\20260617\\.dsh\\workbuddy-vault\\global\\3c5280f93a71195d53a1e56a.json";

function readToken(): string | undefined {
  if (!existsSync(VAULT)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(VAULT, "utf8"));
    const token = doc?.auth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

const token = readToken();

describe.skipIf(token === undefined)("真实上游（WorkBuddy global）", () => {
  it("不带 system 的请求被 shim 补头后上游返回 200", async () => {
    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({
        baseUrl: "https://www.workbuddy.ai",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "WorkBuddy/5.12.1 WorkBuddy/5.12.1 CLI/2.63.2",
          "X-Conversation-ID": randomUUID(),
          "X-Conversation-Request-ID": randomUUID(),
          "X-Conversation-Message-ID": randomUUID(),
        },
      }),
      record: (r) => records.push(r),
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({
          model: "hy3",
          // 故意不带 system —— 复刻 DSH 的真实发法
          messages: [{ role: "user", content: "用一句话说明什么是幂等性" }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string") text += delta;
          } catch {
            /* 心跳帧等非 JSON 行 */
          }
        }
      }

      // 真的产出了中文内容
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/[\u4e00-\u9fa5]/);

      // shim 记录到了真实指标
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(records).toHaveLength(1);
      expect(records[0].statusCode).toBe(200);
      expect(records[0].metrics.inputTokens).toBeGreaterThan(0);
      expect(records[0].metrics.firstTokenMs).toBeGreaterThan(0);
    } finally {
      shim.close();
    }
  }, 120_000);
});
