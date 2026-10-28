import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts, upsertOneAccount } from "../src/store/seed.js";
import { createHubState } from "../src/state/hub-state.js";

/**
 * HubState 状态中心 + 渠道 runtime（热注册/启停）。
 *
 * runtimeFactory 全部用 fake：本任务测的是 hub-state 的状态机（何时建、何时
 * setEnabled、何时释放/重建），不是 runtime 内部的 shim/目录逻辑。
 */

function tempDb(): Promise<DatabaseSync> {
  return openHubDatabase(join(mkdtempSync(join(tmpdir(), "hs-")), "hub.db"));
}

function fakeRuntimeFactory() {
  const calls: unknown[] = [];
  return {
    calls,
    // 简报给的 fake 形状：setEnabled 只记账不触发 release —— 这样「渠道开关走
    // setEnabled、池空才 release」两条路径在调用序列上可区分。
    factory: async (input: unknown) => {
      calls.push(input);
      return {
        shim: { baseUrl: () => "http://127.0.0.1:1", token: () => "t", close: () => {} },
        release: () => { calls.push("release"); },
        models: [{ id: "m1" }], panelEntries: [{ id: "m1", name: "M1" }],
        refresh: async () => {}, setEnabled: (b: boolean) => { calls.push(["enabled", b]); },
      };
    },
  };
}

// typeof [] === "object"，简报草稿里的 object 过滤会把 enabled 记录也算进去；
// 这里只数 factory 的入参对象，才是「建了几次 runtime」。
function factoryInputsOf(calls: unknown[]): unknown[] {
  return calls.filter((c) => typeof c === "object" && !Array.isArray(c));
}

it("ensureRuntime：渠道注册过一次后，启停只走 setEnabled，不重建", async () => {
  const db = await tempDb();
  seedChannelsAndAccounts(db,
    [{ id: "c", kind: "qoder", displayName: "C" }],
    [{ id: "a1", channelId: "c", displayName: "A1", credentialRef: "x", isCurrent: true }]);
  const f = fakeRuntimeFactory();
  const state = createHubState({ db, settings: () => ({}), runtimeFactory: f.factory, logger: {} });

  await state.ensureRuntime("c");
  await state.setChannelEnabled("c", false);
  await state.setChannelEnabled("c", true);

  expect(factoryInputsOf(f.calls)).toHaveLength(1); // 只建一次，shim 不重建
  expect(f.calls).toContainEqual(["enabled", false]);
  expect(f.calls).toContainEqual(["enabled", true]);
});

it("删光账号 → runtime 释放；再加账号 → 热注册回来", async () => {
  const db = await tempDb();
  seedChannelsAndAccounts(db,
    [{ id: "c", kind: "qoder", displayName: "C" }],
    [
      { id: "a1", channelId: "c", displayName: "A1", credentialRef: "x", isCurrent: true },
      { id: "a2", channelId: "c", displayName: "A2", credentialRef: "y" },
    ]);
  const f = fakeRuntimeFactory();
  const state = createHubState({ db, settings: () => ({}), runtimeFactory: f.factory, logger: {} });
  await state.ensureRuntime("c");

  // 删第一个：池还剩 a2（软删自动晋升），runtime 不该动
  await state.deleteAccount("a1");
  expect(factoryInputsOf(f.calls)).toHaveLength(1);
  expect(f.calls).not.toContain("release");

  // 删第二个：可用账号数归零 → release（adapter 下架 + shim 关闭）
  await state.deleteAccount("a2");
  expect(f.calls).toContainEqual("release");

  // prober（任务 6）还没来：直接用 seed 的单条登记把账号加回去，再手动同步。
  // 被测行为（可用账号数 0↔>0 翻转）就在 syncChannelRuntime 里。
  upsertOneAccount(db, { id: "a3", channelId: "c", displayName: "A3", credentialRef: "z", isCurrent: true });
  await state.syncChannelRuntime("c");
  expect(factoryInputsOf(f.calls)).toHaveLength(2); // factory 被再次调用
});

it("reportResult 记账后 pick 自然换号：3 次凭据类失败进冷却", async () => {
  const NOW = 1_000_000;
  const db = await tempDb();
  seedChannelsAndAccounts(db,
    [{ id: "c", kind: "workbuddy", displayName: "C" }],
    [
      { id: "a1", channelId: "c", displayName: "A1", credentialRef: "x", isCurrent: true },
      { id: "a2", channelId: "c", displayName: "A2", credentialRef: "y" },
    ]);
  const state = createHubState({
    db, settings: () => ({}), logger: {}, now: () => NOW,
    runtimeFactory: async () => { throw new Error("本用例不起 runtime"); },
  });

  expect(state.pick("c")?.id).toBe("a1"); // is_current 优先
  state.reportResult("c", "a1", false, 401);
  state.reportResult("c", "a1", false, 401);
  expect(state.pick("c")?.id).toBe("a1"); // 未达熔断阈值不冷却
  state.reportResult("c", "a1", false, 401);
  expect(state.pick("c")?.id).toBe("a2"); // 冷却生效，prepare 下次自然换号
  expect(state.poolSize("c")).toBe(2); // 冷却不是删号：池还在，只被 pick 跳过
});
