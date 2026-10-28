import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubDatabase } from "../src/store/db.js";
import { insertRequest } from "../src/store/requests.js";

describe("openHubDatabase", () => {
  it("creates the file with 0600 and stamps the application id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
    const path = join(dir, "hub.db");
    const db = await openHubDatabase(path);
    const { application_id } = db.prepare("PRAGMA application_id").get() as { application_id: number };
    expect(application_id).toBe(0x48554231);
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(2);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["accounts", "channels", "daily_rollups", "requests"]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a database owned by another application", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
    const path = join(dir, "foreign.db");
    const { DatabaseSync } = await import("node:sqlite");
    const foreign = new DatabaseSync(path);
    foreign.exec("PRAGMA application_id = 12345");
    foreign.exec("CREATE TABLE t(a INTEGER)");
    foreign.close();
    await expect(openHubDatabase(path)).rejects.toThrow(/belongs to another application/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent — opening twice keeps data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
    const path = join(dir, "hub.db");
    const first = await openHubDatabase(path);
    first.prepare("INSERT INTO channels (id, kind, display_name) VALUES (?, ?, ?)").run("hub-test", "workbuddy", "T");
    first.close();
    const second = await openHubDatabase(path);
    const rows = second.prepare("SELECT id FROM channels").all() as { id: string }[];
    expect(rows).toEqual([{ id: "hub-test" }]);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("insertRequest", () => {
  const base = {
    channelId: "hub-wb",
    provider: "hub-workbuddy-global",
    model: "m1",
    inputTokens: 100,
    outputTokens: 50,
    cacheRead: 0,
    cacheWrite: 0,
    isStreaming: true,
    estimated: false,
    costUnits: 1.5,
  };

  it("rollups equal a recompute from the detail rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
    const db = await openHubDatabase(join(dir, "hub.db"));
    insertRequest(db, { ...base, requestId: "a", firstTokenMs: 400, decodeTps: 50, durationMs: 1400, statusCode: 200, createdAt: Date.UTC(2026, 9, 27, 4, 0) });
    insertRequest(db, { ...base, requestId: "b", firstTokenMs: 600, decodeTps: 30, durationMs: 2000, statusCode: 200, createdAt: Date.UTC(2026, 9, 27, 5, 0) });
    insertRequest(db, { ...base, requestId: "c", statusCode: 500, createdAt: Date.UTC(2026, 9, 27, 6, 0) });

    const row = db.prepare("SELECT * FROM daily_rollups").get() as Record<string, number>;
    expect(row["req_count"]).toBe(3);
    expect(row["ok_count"]).toBe(2);
    expect(row["tokens"]).toBe(450);
    expect(row["ttft_n"]).toBe(2);
    expect(row["avg_ttft_ms"]).toBe(500);
    expect(row["tps_n"]).toBe(2);
    expect(row["avg_tps"]).toBeCloseTo(40, 5);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps ttft_n and tps_n independent when one side is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
    const db = await openHubDatabase(join(dir, "hub.db"));
    insertRequest(db, { ...base, requestId: "x", firstTokenMs: 300, statusCode: 200, createdAt: Date.UTC(2026, 9, 27, 4, 0) });
    insertRequest(db, { ...base, requestId: "y", decodeTps: 20, statusCode: 200, createdAt: Date.UTC(2026, 9, 27, 5, 0) });

    const row = db.prepare("SELECT * FROM daily_rollups").get() as Record<string, number>;
    expect(row["ttft_n"]).toBe(1);
    expect(row["avg_ttft_ms"]).toBe(300);
    expect(row["tps_n"]).toBe(1);
    expect(row["avg_tps"]).toBeCloseTo(20, 5);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
