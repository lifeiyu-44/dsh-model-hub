import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubDatabase } from "../src/store/db.js";
import { insertRequest, type RequestRecord } from "../src/store/requests.js";
import { pruneRequests, clearRecords } from "../src/store/retention.js";

/**
 * 临时库：沿用 mutations.spec.ts 的 tempDb 形态，但补上 rmSync 清理——
 * mkdtemp 出来的目录不能留在系统 tmpdir 里当垃圾（任务 1 审查记过账）。
 */
async function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "hub-retention-"));
  const db = await openHubDatabase(join(dir, "hub.db"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 造最小明细：token/cost 全 0、非流式、非估算——避免估算噪声，聚合行只数行数不看数值。 */
function record(requestId: string, createdAt: number): RequestRecord {
  return {
    requestId, channelId: "c", provider: "qoder", model: "glm-4.6",
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
    isStreaming: false, estimated: false, costUnits: 0, createdAt,
  };
}

const DAY = 86_400_000;

function countRows(db: Awaited<ReturnType<typeof openHubDatabase>>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

it("prune 按天界删明细，daily_rollups 不动，返回删除行数", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const now = Date.now();
    insertRequest(db, record("old", now - 100 * DAY));
    insertRequest(db, record("recent", now - 1 * DAY));
    expect(countRows(db, "requests")).toBe(2);
    // 相隔 100d 的两个 createdAt 必落两个本地日期 → 2 行聚合；先证明有东西可断言
    expect(countRows(db, "daily_rollups")).toBe(2);

    const removed = pruneRequests(db, 90, now);
    expect(removed).toBe(1); // 只删过期的那条
    expect(
      db.prepare("SELECT request_id FROM requests").all().map((r: any) => r.request_id),
    ).toEqual(["recent"]);
    // prune 只动明细，聚合行原样保留（双口径之一：行数不变）
    expect(countRows(db, "daily_rollups")).toBe(2);

    // days 下界保护：days<1 也按至少 1 天回退，刚写入的明细不被误删
    expect(pruneRequests(db, 0, now)).toBe(0);
    expect(countRows(db, "requests")).toBe(1);
  } finally {
    cleanup();
  }
});

it("clear 清空两表", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const now = Date.now();
    insertRequest(db, record("r1", now));
    insertRequest(db, record("r2", now));
    expect(countRows(db, "requests")).toBe(2);
    expect(countRows(db, "daily_rollups")).toBe(1); // 同日同渠道同模型同账号 → 聚成 1 行

    clearRecords(db);
    expect(countRows(db, "requests")).toBe(0);
    expect(countRows(db, "daily_rollups")).toBe(0);
  } finally {
    cleanup();
  }
});
