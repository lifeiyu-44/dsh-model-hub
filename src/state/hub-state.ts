import type { DatabaseSync } from "node:sqlite";
import { queryAccounts, queryChannels } from "../store/queries.js";
import * as mutations from "../store/mutations.js";
import { pickOf, poolOf, type SelectorRow } from "./selector.js";
import type { ChannelRuntimeInput, Logger, PanelEntry, RuntimeHandle } from "./runtime.js";

/**
 * HubState 状态中心：库里的渠道/账号状态 → runtime（shim + adapter）的启停。
 *
 * 分工：写侧 SQL 全在 `store/mutations.ts`（这里只调，不再写 SQL）；选号纯逻辑
 * 在 `state/selector.ts`；本模块只做**状态机** —— 每次写操作后按
 * 「渠道 enabled × 可用账号数」把 runtime 调到该在的样子（syncChannelRuntime）。
 */

export interface HubSettings {
  recordEnabled?: boolean;
  retentionDays?: number;
}

export interface HubStateDeps {
  db: DatabaseSync;
  /**
   * volatile 配置用 getter 每次现读：recordEnabled / retentionDays 都是
   * 「改了就该生效」的开关，不该为它们引入一套失效通知。
   */
  settings: () => HubSettings;
  logger: Logger;
  /** runtime 装配器（生产路径传 runtime.ts 的 startChannelRuntime 绑定，任务 9 接线）。 */
  runtimeFactory: (input: ChannelRuntimeInput) => Promise<RuntimeHandle>;
  now?: () => number;
}

interface RuntimeEntry {
  handle: RuntimeHandle;
  /** adapter 是否在架上（setEnabled(false) 之后为 false，shim 仍保留）。 */
  adapterOn: boolean;
}

export interface HubState {
  /** 没有就建（拉目录用当前池头账号的凭据）；已有则不动。 */
  ensureRuntime(channelId: string): Promise<void>;
  /** 把 runtime 调到该在的样子：建 / 下架 adapter / 整体释放 / 刷目录。 */
  syncChannelRuntime(channelId: string): Promise<void>;
  setChannelEnabled(channelId: string, enabled: boolean): Promise<void>;
  setAccountEnabled(accountId: string, enabled: boolean): Promise<void>;
  makeCurrent(channelId: string, accountId: string): Promise<void>;
  /** 软删（deleted=1），数据不物理消失。 */
  deleteAccount(accountId: string): Promise<void>;
  /** 记一次账号结局（驱动熔断/最近成功）；换号无需其它动作，prepare 下次自然换。 */
  reportResult(channelId: string, accountId: string, ok: boolean, status?: number, error?: string): void;
  /** 当前该渠道应选用的账号（跳过冷却；全冷却兜底池头）。 */
  pick(channelId: string): SelectorRow | undefined;
  poolSize(channelId: string): number;
  /** 渠道 → 面板目录条目（来自各渠道 runtime 当前上架的目录）。 */
  panelModelsByChannel(): Record<string, PanelEntry[]>;
  /** 统管 teardown：release adapter、关 shim、关 db（任务 9 接到 ctx.effect）。 */
  dispose(): Promise<void>;
}

export function createHubState(deps: HubStateDeps): HubState {
  const now = deps.now ?? (() => Date.now());
  const runtimes = new Map<string, RuntimeEntry>();

  // ── 写操作单队列 ──
  //
  // db 语句本身是 node:sqlite 同步 API，天然原子；队列真正要串行化的是
  // **异步段**（起 shim、拉目录）：两个并发 syncChannelRuntime 都看到「无
  // runtime」就会把 shim 建重。链式 Promise 保证同一时刻只有一个异步段在跑。
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = queue.then(fn);
    // 失败不毒化队列：排队者只要求顺序，不继承前人的异常。
    queue = run.then(() => undefined, () => undefined);
    return run;
  }
  // pick（读）与 reportResult（单行写）不入队：同步语句在 JS 线程上原子执行，
  // 上面队列里的异步段不可能插进两条语句之间，读不到「半截」状态。

  function accounts(): SelectorRow[] {
    // queryAccounts 有意不返回 deleted（WHERE 已滤）与 credential_ref（凭据
    // 不出存储层）；这里补 deleted: 0 是如实标注 —— 能被返回的行必然未删。
    // node:sqlite 的 .all() 类型是列名无关的 Record<string, SQLOutputValue>，
    // 列形状由 schema 保证，先断言成「缺 deleted 的 SelectorRow」再补字段。
    const rows = queryAccounts(deps.db) as unknown as Omit<SelectorRow, "deleted">[];
    return rows.map((row) => ({ ...row, deleted: 0 }));
  }

  function pick(channelId: string): SelectorRow | undefined {
    return pickOf(accounts(), channelId, now());
  }

  function poolSize(channelId: string): number {
    return poolOf(accounts(), channelId, now()).length;
  }

  function reportResult(channelId: string, accountId: string, ok: boolean, status?: number, error?: string): void {
    // 熔断阈值/冷却时长都在 mutations（与 selector 的常量互为镜像，spec 锁住）。
    // 头部变化无需其它动作：prepare 下次 pickOf 自然拿到新池头。
    mutations.markAccountResult(deps.db, accountId, ok, status, error, now());
  }

  function channelRow(channelId: string): { id: string; kind: string; enabled: number } | undefined {
    // 复用现有渠道查询（避免新 SQL）：带上今日聚合 JOIN，渠道个位数，可忽略。
    // 列形状由 schema 保证，断言出本函数关心的三列（同 accounts() 的口径）。
    const rows = queryChannels(deps.db) as unknown as { id: string; kind: string; enabled: number }[];
    return rows.find((c) => c.id === channelId);
  }

  async function ensureRuntimeCore(channelId: string): Promise<void> {
    if (runtimes.has(channelId)) return;
    const channel = channelRow(channelId);
    if (channel === undefined) {
      deps.logger.warn?.(`dsh-model-hub: 渠道 ${channelId} 不存在，跳过 runtime 创建`);
      return;
    }
    let handle: RuntimeHandle;
    try {
      handle = await deps.runtimeFactory({
        db: deps.db,
        channelId,
        kind: channel.kind,
        settings: deps.settings,
        state: { pick, poolSize, reportResult },
        logger: deps.logger,
      });
    } catch (error) {
      // 起不来就保持「无 runtime」：渠道暗着，下次 syncChannelRuntime 重试。
      // 不能让一个渠道的目录/凭据问题炸掉调用方（写路由/teardown）。
      deps.logger.error?.(`dsh-model-hub: 渠道 ${channelId} runtime 启动失败（下次同步重试）`, error);
      return;
    }
    runtimes.set(channelId, { handle, adapterOn: true });
  }

  /** 整体拆除：adapter 下架 + shim 关闭 + 移出表。之后要服务得让 factory 重建。 */
  function teardownRuntime(channelId: string): void {
    const entry = runtimes.get(channelId);
    if (entry === undefined) return;
    runtimes.delete(channelId);
    if (entry.adapterOn) {
      try {
        entry.handle.release();
      } catch (error) {
        deps.logger.warn?.(`dsh-model-hub: ${channelId} adapter 下架失败（忽略）`, error);
      }
    }
    try {
      entry.handle.shim.close();
    } catch (error) {
      deps.logger.warn?.(`dsh-model-hub: ${channelId} shim 关闭失败（忽略）`, error);
    }
  }

  async function syncCore(channelId: string): Promise<void> {
    const channel = channelRow(channelId);
    if (channel === undefined) return;
    const entry = runtimes.get(channelId);

    if (entry === undefined) {
      if (channel.enabled === 1 && poolSize(channelId) > 0) await ensureRuntimeCore(channelId);
      return;
    }
    // 渠道关：只下架 adapter（模型从选择器消失），shim 保留 —— 端口不变，
    // 再开时 setEnabled(true) 用缓存目录原样上架（约束 8）。
    if (channel.enabled !== 1) {
      if (entry.adapterOn) {
        entry.handle.setEnabled(false);
        entry.adapterOn = false;
      }
      return;
    }
    // 池空：shim 没有可服务的账号，整体拆掉；账号热注册回来时 factory 重建
    // （可用账号数 0↔>0 翻转的落点就在这）。
    if (poolSize(channelId) === 0) {
      teardownRuntime(channelId);
      return;
    }
    if (!entry.adapterOn) {
      entry.handle.setEnabled(true);
      entry.adapterOn = true;
    } else if (entry.handle.models.length === 0) {
      // 该有但模型空（比如起 runtime 时目录拉失败后凭据恢复了）：刷目录重上架。
      await entry.handle.refresh();
    }
  }

  return {
    ensureRuntime: (channelId) => mutate(() => ensureRuntimeCore(channelId)),
    syncChannelRuntime: (channelId) => mutate(() => syncCore(channelId)),

    setChannelEnabled: (channelId, enabled) =>
      mutate(() => {
        mutations.setChannelEnabled(deps.db, channelId, enabled);
        return syncCore(channelId);
      }),

    setAccountEnabled: (accountId, enabled) =>
      mutate(() => {
        const row = accounts().find((a) => a.id === accountId);
        if (row === undefined) return; // 不存在/已删：无原状可改
        mutations.setAccountEnabled(deps.db, accountId, enabled);
        return syncCore(row.channel_id);
      }),

    makeCurrent: (channelId, accountId) =>
      mutate(() => {
        mutations.makeCurrent(deps.db, channelId, accountId);
        return syncCore(channelId);
      }),

    deleteAccount: (accountId) =>
      mutate(() => {
        const row = accounts().find((a) => a.id === accountId);
        if (row === undefined) return;
        mutations.softDeleteAccount(deps.db, accountId);
        return syncCore(row.channel_id);
      }),

    reportResult,

    pick,
    poolSize,

    panelModelsByChannel: () => {
      const out: Record<string, PanelEntry[]> = {};
      for (const [channelId, entry] of runtimes) out[channelId] = entry.handle.panelEntries;
      return out;
    },

    dispose: () =>
      mutate(() => {
        for (const channelId of [...runtimes.keys()]) teardownRuntime(channelId);
        try {
          deps.db.close();
        } catch (error) {
          deps.logger.warn?.("dsh-model-hub: 数据库关闭失败（忽略）", error);
        }
      }),
  };
}
