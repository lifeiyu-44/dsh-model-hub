import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelModel } from "../src/channels/types.js";
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

it("起步空目录 → sync 触发 refresh 拿到非空 → 重新上架", async () => {
  const db = await tempDb();
  seedChannelsAndAccounts(db,
    [{ id: "c", kind: "qoder", displayName: "C" }],
    [{ id: "a1", channelId: "c", displayName: "A1", credentialRef: "x", isCurrent: true }]);

  // 有状态 fake，忠实模拟生产 runtime 的上架规则：
  //   ① 空目录拒上架（register 拒上空目录，P0 教训）② setEnabled 幂等重入。
  // refresh 只换目录、不自带上架 —— 复现审查发现的缺口形态：目录拉成功但为
  // 空（Qoder 空目录是真实发生过的场景），面板有模型而选择器永远选不到。
  const calls: string[] = [];
  let catalog: ChannelModel[] = []; // 起步：目录拉成功但为空
  let adapterUp = false;
  const state = createHubState({
    db, settings: () => ({}), logger: {},
    runtimeFactory: async () => ({
      shim: { baseUrl: () => "http://127.0.0.1:1", token: () => "t", close: () => {} },
      release: () => { if (adapterUp) { adapterUp = false; calls.push("release"); } },
      get models() { return catalog; },
      get panelEntries() { return catalog.map((m) => ({ id: m.id, name: m.name })); },
      refresh: async () => { if (catalog.length === 0) catalog = [{ id: "m1", name: "M1", contextWindow: 128_000, maxTokens: 32_000, creditMultiplier: 0, supportsImages: false }]; },
      setEnabled: (b: boolean) => {
        const want = b && catalog.length > 0; // 空目录拒上架
        if (want === adapterUp) return; // 幂等
        adapterUp = want;
        calls.push(want ? "register" : "release");
      },
    }),
  });

  await state.ensureRuntime("c");
  expect(calls).toEqual([]); // 空目录：拒上架，选择器无模型

  await state.syncChannelRuntime("c"); // 「该有但模型空」分支
  expect(catalog.map((m) => m.id)).toEqual(["m1"]); // refresh 换到非空目录
  expect(calls).toEqual(["register"]); // 修复点：刷新后补上架，模型回到选择器
  expect(state.panelModelsByChannel()["c"]).toEqual([{ id: "m1", name: "M1" }]);
});
