import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { insertRequest } from "../src/store/requests.js";
import { queryAccounts, queryChannels, queryModels, queryRequests, querySummary } from "../src/store/queries.js";

/**
 * 面板数据层的测试。
 *
 * 重点是**聚合口径**：`daily_rollups` 存的是加权均值 + 各自样本数，
 * 跨模型合并必须按样本数加权。直接对各行 avg 求平均是错的 ——
 * 一个只跑过 1 次的模型会和一个跑过 500 次的模型等权。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, "..", "src", "store", "schema.sql"), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function record(over: Partial<Parameters<typeof insertRequest>[1]> = {}) {
  return {
    requestId: `r-${Math.random().toString(36).slice(2)}`,
    channelId: "hub-workbuddy-global",
    provider: "hub-workbuddy-global",
    model: "hy3",
    inputTokens: 10,
    outputTokens: 20,
    cacheRead: 0,
    cacheWrite: 0,
    isStreaming: true,
    estimated: false,
    costUnits: 0,
    createdAt: Date.now(),
    // 默认给 200：`ok_count` 的口径是「状态码是 2xx」，不给状态码等于「不知道
    // 成没成」，应计为失败 —— 这是写入层的正确语义，不是 bug。
    statusCode: 200,
    ...over,
  };
}

describe("面板数据层", () => {
  let db: ReturnType<typeof freshDb>;

  beforeEach(() => {
    db = freshDb();
  });

  it("空库时均值为 null 而不是 0（0 会假装「测到了 0 毫秒」）", () => {
    const summary = querySummary(db);
    expect(summary.requests).toBe(0);
    expect(summary.avgTtftMs).toBeNull();
    expect(summary.avgTps).toBeNull();
  });

  it("单条记录后汇总正确", () => {
    insertRequest(db, record({ inputTokens: 100, outputTokens: 50, firstTokenMs: 400, decodeTps: 50 }));
    const summary = querySummary(db);
    expect(summary.requests).toBe(1);
    expect(summary.ok).toBe(1);
    expect(summary.tokens).toBe(150);
    expect(summary.avgTtftMs).toBe(400);
    expect(summary.avgTps).toBe(50);
  });

  it("跨模型合并按样本数加权，不是对各 avg 直接求平均", () => {
    // 模型 A：3 条，TTFT 都是 100
    for (let i = 0; i < 3; i += 1) {
      insertRequest(db, record({ model: "model-a", firstTokenMs: 100, decodeTps: 10 }));
    }
    // 模型 B：1 条，TTFT 900
    insertRequest(db, record({ model: "model-b", firstTokenMs: 900, decodeTps: 90 }));

    const summary = querySummary(db);
    // 加权：(100*3 + 900*1) / 4 = 300，不是 (100+900)/2 = 500
    expect(summary.avgTtftMs).toBe(300);
    // 加权：(10*3 + 90*1) / 4 = 30，不是 (10+90)/2 = 50
    expect(summary.avgTps).toBe(30);
  });

  it("TTFT 与 tok/s 各自独立计样本数（一个缺失不拖累另一个）", () => {
    // 一条只有 TTFT，一条只有 tok/s
    insertRequest(db, record({ firstTokenMs: 200 }));
    insertRequest(db, record({ decodeTps: 40 }));

    const summary = querySummary(db);
    expect(summary.avgTtftMs).toBe(200);
    expect(summary.avgTps).toBe(40);
    expect(summary.requests).toBe(2);
  });

  it("失败的请求计入 requests 但不计入 ok", () => {
    insertRequest(db, record({ statusCode: 500, error: "boom" }));
    const summary = querySummary(db);
    expect(summary.requests).toBe(1);
    expect(summary.ok).toBe(0);
  });

  it("明细按时间倒序，且支持渠道 / 模型筛选", () => {
    const now = Date.now();
    insertRequest(db, record({ requestId: "old", model: "hy3", createdAt: now - 10_000 }));
    insertRequest(db, record({ requestId: "new", model: "glm-5.3", createdAt: now }));
    insertRequest(db, record({ requestId: "other", channelId: "other", model: "hy3", createdAt: now - 5_000 }));

    const all = queryRequests(db, { limit: 10 }) as any[];
    expect(all.map((r) => r.request_id)).toEqual(["new", "other", "old"]);

    const onlyHy3 = queryRequests(db, { limit: 10, model: "hy3" }) as any[];
    expect(onlyHy3.map((r) => r.request_id)).toEqual(["other", "old"]);

    const onlyChannel = queryRequests(db, { limit: 10, channelId: "hub-workbuddy-global" }) as any[];
    expect(onlyChannel.map((r) => r.request_id)).toEqual(["new", "old"]);
  });

  it("limit 被夹在 1..2000（防止面板把十万行塞进浏览器）", () => {
    expect((queryRequests(db, { limit: 0 }) as any[]).length).toBe(0);
    // 超上限不抛错，只是按 2000 算
    expect(() => queryRequests(db, { limit: 999_999 })).not.toThrow();
  });

  it("models 列表去重且有序", () => {
    insertRequest(db, record({ model: "hy3" }));
    insertRequest(db, record({ model: "hy3" }));
    insertRequest(db, record({ model: "glm-5.3" }));
    expect(queryModels(db).map((r) => r.model)).toEqual(["glm-5.3", "hy3"]);
  });

  it("渠道与账号查询不泄漏凭据", () => {
    db.prepare("INSERT INTO channels (id, kind, display_name, enabled) VALUES (?,?,?,?)").run(
      "hub-workbuddy-global",
      "workbuddy",
      "WorkBuddy Global",
      1,
    );
    db.prepare(
      "INSERT INTO accounts (id, channel_id, display_name, credential_ref, created_at) VALUES (?,?,?,?,?)",
    ).run("acc-1", "hub-workbuddy-global", "主账号", "vault://secret-token", Date.now());

    const channels = queryChannels(db) as any[];
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("hub-workbuddy-global");

    const accounts = queryAccounts(db) as any[];
    expect(accounts).toHaveLength(1);
    // 只暴露「有没有凭据」，不暴露凭据本身
    expect(accounts[0].has_credential).toBe(1);
    expect(JSON.stringify(accounts)).not.toContain("secret-token");
  });
});
