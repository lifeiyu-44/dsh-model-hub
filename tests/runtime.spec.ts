import { expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts } from "../src/store/seed.js";
import { startChannelRuntime, type RegisterAdapterFn, type RuntimeHandle } from "../src/state/runtime.js";
import type { SelectorRow } from "../src/state/selector.js";

/**
 * startChannelRuntime 直测（任务 5 记账项，任务 9 顺手补上）。
 *
 * `tests/hub-state.spec.ts` 用 fake factory 测的是 hub-state 的**状态机**；
 * 这里用**真的** startChannelRuntime 测 runtime 本体：真起 shim、真走目录
 * 拉取（globalThis.fetch 打桩，不打真网）、真走「空目录起步 → refresh 拉到
 * 非空 → 自动上架」的 wasEmpty 恢复链 —— 8dbd167 修的正是这条链，此前只有
 * fake 层面的间接覆盖。
 */

const ROW: SelectorRow = {
  id: "a1", channel_id: "c", enabled: 1, deleted: 0, is_current: 1,
  last_ok_at: null, consecutive_failures: 0, cooldown_until: null,
  has_credential: 1, created_at: 0,
};

/** 第一次返回空目录、之后返回非空目录的 fetch 桩（workbuddy /v3/config 形状）。 */
function emptyThenFullCatalog(): typeof fetch {
  let calls = 0;
  return (async () => {
    calls += 1;
    const models = calls === 1 ? [] : [{ id: "m1", name: "M1", credits: "x1.00" }];
    return { ok: true, json: async () => ({ data: { models } }) };
  }) as unknown as typeof fetch;
}

it("空目录起步拒上架；refresh 拉到非空后自动上架（wasEmpty 恢复链）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-"));
  const authPath = join(dir, "auth.info");
  writeFileSync(
    authPath,
    JSON.stringify({ auth: { accessToken: "test-token", domain: "www.workbuddy.ai" } }),
    "utf8",
  );

  const db = await openHubDatabase(join(dir, "hub.db"));
  seedChannelsAndAccounts(
    db,
    [{ id: "c", kind: "workbuddy", displayName: "C" }],
    [{ id: "a1", channelId: "c", displayName: "A1", credentialRef: authPath, isCurrent: true }],
  );

  const registered: string[] = [];
  const registerAdapter: RegisterAdapterFn = (_ctx, providerId) => {
    registered.push(providerId);
    return () => registered.push(`release:${providerId}`);
  };

  vi.stubGlobal("fetch", emptyThenFullCatalog());
  let handle: RuntimeHandle | undefined;
  try {
    handle = await startChannelRuntime({
      db,
      channelId: "c",
      kind: "workbuddy",
      settings: () => ({}),
      state: { pick: () => ROW, poolSize: () => 1, reportResult: () => {} },
      logger: {},
      ctx: {},
      registerAdapter,
    });

    // 起步：目录拉成功但为空 → register() 拒上架（P0「看起来成功」的教训）
    expect(handle.models).toEqual([]);
    expect(registered).toEqual([]);
    expect(handle.shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // refresh：拉到非空目录 → wasEmpty 起点也自动上架（空目录修复链的真覆盖）
    await handle.refresh();
    expect(handle.models.map((m) => m.id)).toEqual(["m1"]);
    expect(registered).toEqual(["c"]);
    expect(handle.panelEntries.map((e) => e.id)).toEqual(["m1"]);
  } finally {
    handle?.shim.close();
    vi.unstubAllGlobals();
  }
});
