# dsh-model-hub P1（账号生命周期 + 多账号池 + 全功能界面化）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 解禁面板 6 个灰色控件（一键认证/添加账号/账号启停/测试/设为当前/渠道开关），实现同平台多账号与「手动优先+故障切换+熔断」的账号池，全部热生效，并把记录保留清理做真、模型清单进面板——不留无 UI 的能力。

**架构：** HubState 状态中心（方案 A）。SQLite `channels/accounts` 是唯一事实源；shim 的 `prepare()` 每次请求向选择器要账号；写路由只调 HubState；一键认证/添加/测试走「探测 → upsert 账号 → 确保渠道 runtime」同一条路。渠道开关/可用账号翻转只 release/重注册 adapter，shim 不动（端口不变，在飞请求不受影响）。

**技术栈：** TypeScript + tsdown、React 18（`React.createElement`，无 JSX）、`node:sqlite`、vitest、宿主 `@deepseek-ai/*` 0.2.1-rc.3 + `@earendil-works/pi-ai`。

**规格：** `docs/superpowers/specs/2026-10-28-dsh-model-hub-p1-accounts-design.md`（用户已批准）。

**铁律（每一任务都适用）：**

1. `apply()` 顶层与路由注册整体 try/catch——任何插件异常不得冒到宿主加载期（会 fatal 并重置整个 profile，本项目踩过两次）。
2. 凭据只存引用；dsh-connect-workbuddy 的 vault 只读不回写；日志不落 token/`pt-`。
3. 每个 TDD 步骤的命令都要真跑；红→绿→commit。
4. 工作区已有未提交的 `src/provider.ts` + `tests/provider.spec.ts`（thinkingLevelMap WIP）——**任务 0 先把它单独 commit**，之后所有 commit 不得夹带无关文件。

---

## 文件结构

```
src/
  constants.ts                 [改] HUB_SCHEMA_VERSION 1→2
  store/
    db.ts                      [改] v1→v2 迁移（accounts 加 deleted / cooldown_until）
    seed.ts                    [改] upsert 守卫 deleted=1 不复活；导出单行 upsert
    mutations.ts               [新] 全部写侧 SQL（启停/设当前/软删/结果记账/清理）
    queries.ts                 [改] queryAccounts 过滤 deleted、返回 cooldown_until
    retention.ts               [新] pruneRequests / clearRecords
  state/
    selector.ts                [新] 选号纯逻辑（池序/熔断/兜底）
    hub-state.ts               [新] 状态中心：写操作编排 + 账号/凭据解析
    runtime.ts                 [新] 渠道 runtime：shim+adapter 注册/重注册/热注册
  probe/
    prober.ts                  [新] 一键认证扫描、单账号测试、添加账号探测
  routes/
    data.ts                    [改] /channels 带 models_by_channel；/diag 带 recordEnabled/retentionDays
    write.ts                   [新] 写路由（回环+Origin+JSON+64KB 门禁）与分发器
  channels/
    workbuddy/vault.ts         [改] listVaultEntries()（多账号）
    qoder/credentials.ts       [改] 导出 exchangePat()；createSessionManager 支持注入 readPat
    qoder/chat.ts              [改] createQoderDialect 的 session 回调按账号取
  shim/
    server.ts                  [改] prepare 返回 account；凭据类失败请求内换号重试；record 带 accountId
  index.ts                     [改] 瘦身装配：HubState + 写路由 + 保留清理循环
  client/
    types.ts                   [改] AccountRow.cooldown_until；DiagData 补字段
    api.ts                     [改] 写操作 fetch 封装
    HubCard.ts                 [改] 解禁 6 控件 + 设为当前 + 渠道展开模型 + 记录管理 + 徽标 + 认证结果区
    AddAccountModal.ts         [新] 添加账号弹窗
    styles.ts                  [改] 新增样式（展开区/表单/徽标）
tests/
  mutations.spec.ts            [新] 软删不复活、设当前唯一、结果记账
  selector.spec.ts             [新] 选号策略全表
  failover.spec.ts             [新] shim 请求内换号集成
  write-routes.spec.ts         [新] 门禁矩阵 + 分发器 happy path
  retention.spec.ts            [新] prune 按天界、clear 全清
  prober.spec.ts               [新] 三态报告、贴 PAT 校验
  hub-state.spec.ts            [新] 热注册与「可用账号 0↔>0」翻转
  client-load.spec.ts          [改] 新 UI 渲染断言
docs/superpowers/plans/        本文件
```

---

### 任务 0：收编工作区 WIP

**文件：** 已修改的 `src/provider.ts`、`tests/provider.spec.ts`

- [ ] **步骤 1：跑现有测试确认 WIP 是绿的**

运行：`pnpm test`
预期：全部 PASS（若红，先修 WIP 的测试再继续；红的原因不在本计划范围，停下来问用户）。

- [ ] **步骤 2：单独 commit WIP**

```bash
git add src/provider.ts tests/provider.spec.ts
git commit -m "feat(provider): 思考档位表 thinkingLevelMap + compat.supportsReasoningEffort"
```

---

### 任务 1：schema v2 + 写侧存储层（mutations / seed 守卫 / 查询补列）

**文件：**
- 修改：`src/constants.ts`、`src/store/db.ts`、`src/store/seed.ts`、`src/store/queries.ts`
- 创建：`src/store/mutations.ts`
- 测试：`tests/mutations.spec.ts`

- [ ] **步骤 1：写失败的测试**

`tests/mutations.spec.ts` 开头（建库复用现有 `tests/db.spec.ts` 的方式：`openHubDatabase` 指到临时目录）：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts } from "../src/store/seed.js";
import {
  setAccountEnabled, makeCurrent, softDeleteAccount, markAccountResult,
} from "../src/store/mutations.js";
import { queryAccounts } from "../src/store/queries.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "hub-"));
  return openHubDatabase(join(dir, "hub.db"));
}
function seedOne(db: any) {
  seedChannelsAndAccounts(db,
    [{ id: "hub-qoder-cn", kind: "qoder", displayName: "Qoder CN" }],
    [{ id: "hub-qoder-cn:default", channelId: "hub-qoder-cn", displayName: "Qoder CN 账号",
       credentialRef: "~/.dsh/qoder/pat", isCurrent: true }]);
}

it("软删后 queryAccounts 不再返回，且 seed 不复活它", async () => {
  const db = await tempDb();
  seedOne(db);
  softDeleteAccount(db, "hub-qoder-cn:default");
  expect(queryAccounts(db)).toHaveLength(0);
  seedChannelsAndAccounts(db, [],
    [{ id: "hub-qoder-cn:default", channelId: "hub-qoder-cn", displayName: "Qoder CN 账号",
       credentialRef: "~/.dsh/qoder/pat", isCurrent: true }]);
  expect(queryAccounts(db)).toHaveLength(0);        // 复活被守住
  const raw = db.prepare("SELECT deleted FROM accounts WHERE id=?").get("hub-qoder-cn:default");
  expect(raw.deleted).toBe(1);
});

it("makeCurrent 在渠道内唯一；软删当前账号自动晋升", async () => {
  const db = await tempDb();
  seedChannelsAndAccounts(db,
    [{ id: "c", kind: "qoder", displayName: "C" }],
    [{ id: "a1", channelId: "c", displayName: "A1", isCurrent: true },
     { id: "a2", channelId: "c", displayName: "A2" }]);
  makeCurrent(db, "c", "a2");
  const rows = queryAccounts(db);
  expect(rows.find((r: any) => r.id === "a1").is_current).toBe(0);
  expect(rows.find((r: any) => r.id === "a2").is_current).toBe(1);
  softDeleteAccount(db, "a2");
  expect(queryAccounts(db).find((r: any) => r.id === "a1").is_current).toBe(1);
});

it("markAccountResult：成功清零并记 last_ok_at；凭据类失败 3 次进冷却", async () => {
  const db = await tempDb();
  seedOne(db);
  const id = "hub-qoder-cn:default";
  markAccountResult(db, id, true, 200, undefined, 1_000);
  let row: any = queryAccounts(db)[0];
  expect(row.consecutive_failures).toBe(0);
  expect(row.last_ok_at).toBe(1_000);
  for (const at of [2_000, 3_000, 4_000]) markAccountResult(db, id, false, 429, "rate", at);
  row = queryAccounts(db)[0];
  expect(row.consecutive_failures).toBe(3);
  expect(row.cooldown_until).toBe(4_000 + 10 * 60_000);
  // 5xx 不计熔断
  markAccountResult(db, id, false, 502, "bad upstream", 5_000);
  expect(queryAccounts(db)[0].consecutive_failures).toBe(3);
});

it("迁移：v1 老库打开后补列且 user_version=2", async () => {
  // 先造一个 v1 库：手工执行 schema.sql 后把 user_version 写成 1
  const dir = mkdtempSync(join(tmpdir(), "hubv1-"));
  const path = join(dir, "hub.db");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path);
  raw.exec((await import("node:fs")).readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/store/schema.sql"), "utf8"));
  raw.exec("PRAGMA user_version = 1");
  raw.close();
  const db = await openHubDatabase(path);
  const cols = db.prepare("PRAGMA table_info(accounts)").all().map((c: any) => c.name);
  expect(cols).toContain("deleted");
  expect(cols).toContain("cooldown_until");
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(2);
});
```

- [ ] **步骤 2：运行确认失败**

运行：`pnpm vitest run tests/mutations.spec.ts`
预期：FAIL（`mutations.js` 不存在 / 列不存在）。

- [ ] **步骤 3：实现**

`src/constants.ts`：`HUB_SCHEMA_VERSION = 2`。

`src/store/db.ts` 迁移段在 `if (version < 1)` 之后加：

```ts
if (version < 2) {
  db.exec("ALTER TABLE accounts ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE accounts ADD COLUMN cooldown_until INTEGER");
}
```

`src/store/mutations.ts`（全部同步、自带事务，SQL 只写这一处）：

```ts
import type { DatabaseSync } from "node:sqlite";

export const CIRCUIT_THRESHOLD = 3;
export const COOLDOWN_MS = 10 * 60_000;
/** 计入熔断的凭据类状态码。400 不算（请求不合法），5xx 不算（不是凭据的错）。 */
export function isCredentialFailure(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

export function setAccountEnabled(db: DatabaseSync, id: string, enabled: boolean): void {
  db.prepare("UPDATE accounts SET enabled = ? WHERE id = ? AND deleted = 0").run(enabled ? 1 : 0, id);
}
export function setChannelEnabled(db: DatabaseSync, id: string, enabled: boolean): void {
  db.prepare("UPDATE channels SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}
export function makeCurrent(db: DatabaseSync, channelId: string, accountId: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE accounts SET is_current = 0 WHERE channel_id = ?").run(channelId);
    db.prepare("UPDATE accounts SET is_current = 1, enabled = 1 WHERE id = ? AND channel_id = ? AND deleted = 0")
      .run(accountId, channelId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
export function softDeleteAccount(db: DatabaseSync, id: string): void {
  const row = db.prepare("SELECT channel_id FROM accounts WHERE id = ?").get(id) as { channel_id: string } | undefined;
  if (row === undefined) return;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE accounts SET deleted = 1, enabled = 0, is_current = 0 WHERE id = ?").run(id);
    const next = db.prepare(
      "SELECT id FROM accounts WHERE channel_id = ? AND deleted = 0 AND enabled = 1 ORDER BY last_ok_at DESC, created_at ASC LIMIT 1",
    ).get(row.channel_id) as { id: string } | undefined;
    if (next !== undefined) {
      db.prepare("UPDATE accounts SET is_current = 1 WHERE id = ?").run(next.id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
export function markAccountResult(
  db: DatabaseSync, id: string, ok: boolean,
  status: number | undefined, error: string | undefined, now: number,
): void {
  const row = db.prepare(
    "SELECT consecutive_failures, deleted FROM accounts WHERE id = ?",
  ).get(id) as { consecutive_failures: number; deleted: number } | undefined;
  if (row === undefined || row.deleted === 1) return;
  if (ok) {
    db.prepare(
      "UPDATE accounts SET consecutive_failures = 0, cooldown_until = NULL, last_ok_at = ?, last_error = NULL WHERE id = ?",
    ).run(now, id);
    return;
  }
  if (!isCredentialFailure(status)) {
    db.prepare("UPDATE accounts SET last_error = ? WHERE id = ?").run(error ?? null, id);
    return;
  }
  const fails = row.consecutive_failures + 1;
  const cooldown = fails >= CIRCUIT_THRESHOLD ? now + COOLDOWN_MS : null;
  db.prepare(
    "UPDATE accounts SET consecutive_failures = ?, cooldown_until = ?, last_error = ? WHERE id = ?",
  ).run(fails, cooldown, error ?? `HTTP ${status ?? "—"}`, id);
}
```

`src/store/seed.ts`：`upsertAccount` 语句改为带 `WHERE excluded.id` 不动 deleted 行的形态，并抽 `export function upsertOneAccount(db, account)` 供 prober 复用：

```ts
const upsertAccount = db.prepare(`
  INSERT INTO accounts (id, channel_id, display_name, credential_ref, enabled, is_current, consecutive_failures, created_at)
  SELECT ?, ?, ?, ?, 1, ?, 0, ?
  WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND deleted = 1)
  ON CONFLICT(id) DO UPDATE SET
    display_name = excluded.display_name,
    credential_ref = excluded.credential_ref
`);
```

（同事务里保留原 upsertChannel 不变；`seedChannelsAndAccounts` 循环改调 `upsertOneAccount`。）

`src/store/queries.ts` `queryAccounts`：加 `WHERE deleted = 0`，SELECT 列表加 `cooldown_until`。

- [ ] **步骤 4：运行确认通过**

运行：`pnpm vitest run tests/mutations.spec.ts tests/db.spec.ts tests/queries.spec.ts tests/seed.spec.ts`
预期：全部 PASS（旧库相关 spec 若断言 user_version=1 需同步改成 2）。

- [ ] **步骤 5：Commit**

```bash
git add src/constants.ts src/store/db.ts src/store/mutations.ts src/store/seed.ts src/store/queries.ts tests/mutations.spec.ts
git commit -m "feat(store): schema v2（deleted/cooldown_until）+ 写侧 mutations；软删不复活"
```

---

### 任务 2：账号选择器（纯逻辑）

**文件：** 创建 `src/state/selector.ts`；测试 `tests/selector.spec.ts`

- [ ] **步骤 1：写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { poolOf, pickOf, onResultCompute, CIRCUIT_THRESHOLD } from "../src/state/selector.js";

const NOW = 1_000_000;
function acc(over: Partial<any> = {}) {
  return { id: "a", channel_id: "c", enabled: 1, deleted: 0, is_current: 0,
    last_ok_at: null, consecutive_failures: 0, cooldown_until: null,
    has_credential: 1, created_at: 1, ...over };
}

it("池：只收 deleted=0/enabled=1/有凭据；序=当前>last_ok_at 新>创建早", () => {
  const rows = [acc({ id: "b", created_at: 2 }), acc({ id: "a", created_at: 1 }),
    acc({ id: "off", enabled: 0 }), acc({ id: "del", deleted: 1 }), acc({ id: "nocred", has_credential: 0 })];
  expect(poolOf(rows as any, "c", NOW).map((r: any) => r.id)).toEqual(["a", "b"]);
  const withCurrent = [acc({ id: "z", last_ok_at: 999 }), acc({ id: "cur", is_current: 1, last_ok_at: 5 })];
  expect(poolOf(withCurrent as any, "c", NOW).map((r: any) => r.id)).toEqual(["cur", "z"]);
});

it("pick：跳过冷却中的；全冷却时兜底返回池头", () => {
  const rows = [acc({ id: "hot", cooldown_until: NOW + 1 }), acc({ id: "ok" })];
  expect(pickOf(rows as any, "c", NOW)?.id).toBe("ok");
  const allCool = [acc({ id: "x", cooldown_until: NOW + 1 }), acc({ id: "y", cooldown_until: NOW + 2 })];
  expect(pickOf(allCool as any, "c", NOW)?.id).toBe("x");
});

it("onResultCompute：3 次凭据失败进冷却；成功解冻清零；5xx 不累计", () => {
  let s = { consecutive_failures: 0, cooldown_until: null as number | null };
  for (let i = 0; i < CIRCUIT_THRESHOLD; i++) s = onResultCompute(s, false, 401, NOW);
  expect(s.cooldown_until).toBe(NOW + 10 * 60_000);
  s = onResultCompute(s, true, 200, NOW);
  expect(s).toEqual({ consecutive_failures: 0, cooldown_until: null });
  const s2 = onResultCompute({ consecutive_failures: 2, cooldown_until: null }, false, 502, NOW);
  expect(s2.consecutive_failures).toBe(2);       // 5xx 不计
});
```

- [ ] **步骤 2：运行确认失败**

运行：`pnpm vitest run tests/selector.spec.ts` → FAIL（模块不存在）。

- [ ] **步骤 3：实现 `src/state/selector.ts`**

```ts
/** 选号纯逻辑：不碰 IO，输入是 accounts 表的行快照。 */
export interface SelectorRow {
  id: string; channel_id: string; enabled: number; deleted: number;
  is_current: number; last_ok_at: number | null; consecutive_failures: number;
  cooldown_until: number | null; has_credential: number; created_at: number;
}
export interface CircuitState { consecutive_failures: number; cooldown_until: number | null }
export const CIRCUIT_THRESHOLD = 3;
export const COOLDOWN_MS = 10 * 60_000;

export function poolOf(rows: SelectorRow[], channelId: string, _now: number): SelectorRow[] {
  return rows
    .filter((r) => r.channel_id === channelId && r.deleted === 0 && r.enabled === 1 && r.has_credential === 1)
    .sort((x, y) =>
      (y.is_current - x.is_current)
      || ((y.last_ok_at ?? 0) - (x.last_ok_at ?? 0))
      || (x.created_at - y.created_at));
}
export function pickOf(rows: SelectorRow[], channelId: string, now: number): SelectorRow | undefined {
  const pool = poolOf(rows, channelId, now);
  return pool.find((r) => r.cooldown_until === null || r.cooldown_until <= now) ?? pool[0];
}
export function onResultCompute(state: CircuitState, ok: boolean, status: number | undefined, now: number): CircuitState {
  if (ok) return { consecutive_failures: 0, cooldown_until: null };
  const credential = status === 401 || status === 402 || status === 403 || status === 429;
  if (!credential) return state;
  const fails = state.consecutive_failures + 1;
  return { consecutive_failures: fails, cooldown_until: fails >= CIRCUIT_THRESHOLD ? now + COOLDOWN_MS : null };
}
```

- [ ] **步骤 4：运行确认通过** → `pnpm vitest run tests/selector.spec.ts` PASS

- [ ] **步骤 5：Commit** `git add src/state/selector.ts tests/selector.spec.ts && git commit -m "feat(state): 账号选择器纯逻辑（手动优先/熔断/兜底）"`

---

### 任务 3：shim 换号重试 + account 贯通

**文件：** 修改 `src/shim/server.ts`；测试 `tests/failover.spec.ts`

**契约变更（本任务定死，后面都按它写）：**

· `ShimDeps.prepare()` 返回值增加可选 `account?: { id: string }`
· `ShimDeps` 增加可选 `onAccountResult?(account: {id}, ok: boolean, status?: number, error?: string): void`
· 可选 `maxAttempts?(): number`（缺省 1 = 不换号，旧渠道零影响）
· `record()` 入参增加 `accountId?: string`；`dialect.request()` 入参增加 `account?: { id: string }`

- [ ] **步骤 1：写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { startShim } from "../src/shim/server.js";

function upstreamReturning(status: number, authSeen: string[]) {
  return createServer((req, res) => {
    authSeen.push(String(req.headers.authorization));
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? '{"ok":true}' : '{"error":"denied"}');
    });
  });
}

it("prepare 换账号重试：首账号 401 → 次账号 200，结果各记一次", async () => {
  const authSeen: string[] = [];
  const up = upstreamReturning(200, authSeen);
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const port = (up.address() as any).port;

  const accounts = ["a1", "a2"];
  let pick = 0;
  const results: any[] = [];
  const records: any[] = [];
  const shim = await startShim({
    prepare: async () => ({ baseUrl: `http://127.0.0.1:${port}`,
      headers: { authorization: `Bearer ${accounts[pick]}` }, account: { id: accounts[pick] } }),
    maxAttempts: () => 3,
    onAccountResult: (account, ok, status) => results.push({ id: account.id, ok, status }),
    record: (r) => records.push(r),
  });
  // prepare 里推进 pick：第一次 a1，onAccountResult 失败后 shim 会再调 prepare
  // —— 这里用 results 长度驱动：失败一次后 pick=1
  const origResults = results.push.bind(results);
  results.push = (...args: any[]) => { pick = 1; return origResults(...args); };

  const res = await fetch(`${shim.baseUrl()}/v1/x`, {
    method: "POST", headers: { authorization: `Bearer ${shim.token()}`,
      "content-type": "application/json" }, body: JSON.stringify({ model: "m" }),
  });
  expect(res.status).toBe(200);
  expect(authSeen).toEqual([`Bearer a1`, `Bearer a2`]);   // 换了一次号
  expect(results).toEqual([{ id: "a1", ok: false, status: 401 }]);
  await new Promise((r) => setTimeout(r, 100));
  expect(records).toHaveLength(1);                         // 最终成功只记一行
  expect(records[0].accountId).toBe("a2");
  shim.close(); up.close();
});

it("400 不换号；非凭据类失败直接透传", async () => { /* 同构：上游恒 400，断言 authSeen 只有 1 次、status 400 */ });
```

（第二个用例按注释补全：复制 `upstreamReturning(400, ...)`、`maxAttempts: () => 3`，断言 `authSeen.length === 1` 且响应 `res.status === 400`。）

- [ ] **步骤 2：运行确认失败** → `pnpm vitest run tests/failover.spec.ts` FAIL（无换号行为）

- [ ] **步骤 3：实现 `src/shim/server.ts`**

`handle()` 内，把「prepare → 构造 → fetch」包进循环：

```ts
const maxAttempts = Math.max(1, deps.maxAttempts?.() ?? 1);
let built!: { url: string; headers: Record<string, string>; body: string | Buffer };
let account: { id: string } | undefined;
let upstream!: Response;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const prepared = await deps.prepare();
  account = prepared.account;
  const nextBody = deps.dialect?.request === undefined
    ? { url: `${prepared.baseUrl}/v2/chat/completions`,
        headers: { ...prepared.headers, "content-type": "application/json" }, body }
    : await deps.dialect.request({ raw: body, model, baseUrl: prepared.baseUrl,
        headers: prepared.headers, account: prepared.account });
  let resp: Response;
  try {
    resp = await fetch(nextBody.url, { method: "POST", headers: nextBody.headers,
      body: typeof nextBody.body === "string" ? nextBody.body : new Uint8Array(nextBody.body) });
  } catch (networkError) {
    deps.onAccountResult?.(prepared.account ?? { id: "" }, false, undefined,
      networkError instanceof Error ? networkError.message : String(networkError));
    if (attempt < maxAttempts) continue;
    throw networkError;
  }
  const failover = resp.status === 401 || resp.status === 402 || resp.status === 403 || resp.status === 429;
  if (failover && attempt < maxAttempts) {
    deps.onAccountResult?.(prepared.account ?? { id: "" }, false, resp.status);
    void resp.body?.cancel();
    continue;                                   // 尚未向客户端发出任何字节，可以换号
  }
  upstream = resp; built = nextBody;
  break;
}
```

成功路径在 `statusCode = upstream.status` 后调 `deps.onAccountResult?.(account ?? { id: "" }, upstream.ok, upstream.status)`；方言流内错误（现有 `errorMessageOf` 命中处）调 `deps.onAccountResult?.(account ?? { id: "" }, false, undefined, message)`。`finally` 的 `deps.record({...})` 增加 `accountId: account?.id`。上游 !ok 分支沿用现状（换号已在其前置循环处理）。

`ShimDialect.request` 入参类型加 `account?: { id: string }`；`ShimDeps.record` 入参加 `accountId?: string`。

- [ ] **步骤 4：运行确认通过**

运行：`pnpm vitest run tests/failover.spec.ts tests/full-stack.spec.ts tests/shim-e2e.spec.ts tests/sse.spec.ts tests/shim-error-record.spec.ts`
预期：全 PASS（旧用例不传 maxAttempts，行为不变）。

- [ ] **步骤 5：Commit**

```bash
git add src/shim/server.ts tests/failover.spec.ts
git commit -m "feat(shim): 凭据类失败请求内换号重试；account 贯通 prepare/dialect/record"
```

---

### 任务 4：Qoder 多账号会话 + WorkBuddy vault 多账号扫描

**文件：** 修改 `src/channels/qoder/credentials.ts`、`src/channels/qoder/chat.ts`、`src/channels/workbuddy/vault.ts`；测试 `tests/qoder-multi.spec.ts`

- [ ] **步骤 1：写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPatFiles } from "../src/channels/qoder/credentials.js";
import { listVaultEntries } from "../src/channels/workbuddy/vault.js";

it("listPatFiles 列出目录下全部 pt- 文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pats-"));
  writeFileSync(join(dir, "main.pat"), "pt-aaa\n");
  writeFileSync(join(dir, "spare.pat"), "pt-bbb\n");
  writeFileSync(join(dir, "broken.pat"), "nope\n");
  const found = listPatFiles(dir);
  expect(found.map((f) => f.name).sort()).toEqual(["main.pat", "spare.pat"]);
  expect(found[0].pat.startsWith("pt-")).toBe(true);
});

it("listVaultEntries 返回 vault 下全部可用账号（不止第一个）", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const regionDir = join(root, "global");
  writeFileSync(join(regionDir, "acc1.json"),
    JSON.stringify({ auth: { accessToken: "tok1", expiresAt: 9999999999 } }));
  writeFileSync(join(regionDir, "acc2.json"),
    JSON.stringify({ auth: { accessToken: "tok2", expiresAt: 9999999999 } }));
  const entries = listVaultEntries(root);
  expect(entries.map((e) => e.accountId).sort()).toEqual(["acc1", "acc2"]);
  expect(entries[0].parsed.token).toBeDefined();
});
```

- [ ] **步骤 2：运行确认失败** → FAIL（两个函数不存在）

- [ ] **步骤 3：实现**

`src/channels/qoder/credentials.ts`：

```ts
/** 目录下全部 .pat 文件；内容必须 pt- 开头才算。 */
export function listPatFiles(dir: string): { name: string; pat: string; source: string }[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".pat")); } catch { return []; }
  const out: { name: string; pat: string; source: string }[] = [];
  for (const name of names) {
    const source = join(dir, name);
    try {
      const value = readFileSync(source, "utf8").trim();
      if (value.startsWith("pt-")) out.push({ name, pat: value, source });
    } catch { /* 跳过读不了的 */ }
  }
  return out;
}
```

并把 `fetchSession` 改名导出为 `export async function exchangePat(pat: string, source: string, openapiBase?: string): Promise<QoderSession>`（内部不变，`openapiBase` 缺省 `DEFAULT_OPENAPI`）。`createSessionManager` 的 options 增加可注入凭据源：

```ts
export function createSessionManager(options: {
  openapiBase?: string; now?: () => number;
  readCredential?: () => { pat: string; source: string } | undefined;   // 缺省 readPat()
} = {}) { /* current() 里 found = options.readCredential?.() ?? readPat() */ }
```

`src/channels/qoder/chat.ts` `createQoderDialect` 的 options：`session` 改为按账号取：

```ts
export function createQoderDialect(options: {
  sessionFor: (account: { id: string } | undefined) => Promise<QoderSession | undefined>;
  gatewayBase?: string;
}): ShimDialect
// request(input) 内：const session = await options.sessionFor(input.account);
```

`src/channels/workbuddy/vault.ts`：抽出 `listVaultEntries(root = join(resolveDshHome(), "workbuddy-vault"))`，按区域遍历全部 `.json`，返回 `{ accountId: 文件名去 .json, source: 路径, region, parsed }[]`（只收 `kind === "plain"` 且有 token 的）；`readWorkbuddyVault` 改为 `listVaultEntries(...)[0]` 的包装（行为不变）。

- [ ] **步骤 4：运行确认通过**

运行：`pnpm vitest run tests/qoder-multi.spec.ts tests/qoder.spec.ts tests/workbuddy-auth.spec.ts`
预期：PASS（qoder.spec 若直接引用了 `fetchSession` 名字，同步改为 `exchangePat`）。

- [ ] **步骤 5：Commit**

```bash
git add src/channels/qoder/credentials.ts src/channels/qoder/chat.ts src/channels/workbuddy/vault.ts tests/qoder-multi.spec.ts
git commit -m "feat(channels): Qoder 多 PAT 会话源 + WorkBuddy vault 多账号扫描"
```

---

### 任务 5：HubState 状态中心 + 渠道 runtime（热注册）

**文件：** 创建 `src/state/hub-state.ts`、`src/state/runtime.ts`；测试 `tests/hub-state.spec.ts`

**runtime.ts 职责**（从 `index.ts` 迁来并参数化）：

· `startChannelRuntime(deps)` —— deps：`{ ctx, db, channelId, kind, settings, state, registerAdapter: (ctx, providerId, models, report) => release }`。内部：`startShim({ prepare, dialect?, record, maxAttempts, onAccountResult })` → 拉目录 → `registerAdapter` → 返回 `{ shim, release, models, panelEntries, setEnabled(b) }`。
· prepare 按 kind 分派：
  - workbuddy：`state.pickWorkbuddyAccount()` → 读该账号 `credential_ref` 指向的 vault/auth 文件（每次现读，文件 KB 级）→ `{ baseUrl: upstreamBase(region), headers: { Authorization: Bearer <token>, UA, ...conversationIdentityHeaders() }, account: { id } }`
  - qoder：`state.pickQoderAccount()` → `{ baseUrl: "https://qoder.invalid", headers: {}, account: { id } }`（方言模式 URL/头由 dialect 决定）
· `maxAttempts: () => Math.min(3, state.poolSize(channelId))`
· `onAccountResult: (account, ok, status, error) => state.reportResult(channelId, account.id, ok, status, error)`
· `setEnabled(false)` → `release()`（adapter 下架，模型从选择器消失；shim 保留）
· `refresh()` → 用任一可用账号重拉目录并重注册 adapter

**hub-state.ts 职责：**

· `runtimes: Map<channelId, RuntimeHandle>`；`mutate(fn)` 单队列串行
· `pick(channelId)`：`queryAccounts(db)` 现读 → `pickOf(rows, channelId, now)` → 返回行
· `reportResult(channelId, accountId, ok, status, error)` → `markAccountResult`；若 `pickOf` 头部因此变化无需其它动作（prepare 下次自然换号）
· `syncChannelRuntime(channelId)`：可用账号数（池非空）× 渠道 enabled → 需要 runtime 且没有 → `ensureRuntime`；有 runtime 但不该有 → `release adapter`；「该有但模型空」→ refresh
· `ensureRuntime(channelId)`：无则 `startChannelRuntime`；拉目录用当前池头账号的凭据
· `setChannelEnabled / setAccountEnabled / makeCurrent / deleteAccount / addXxx`：写库 → `syncChannelRuntime(channelId)`

- [ ] **步骤 1：写失败的测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubDatabase } from "../src/store/db.js";
import { seedChannelsAndAccounts } from "../src/store/seed.js";
import { createHubState } from "../src/state/hub-state.js";
import type { DatabaseSync } from "node:sqlite";

function fakeRuntimeFactory() {
  const calls: any[] = [];
  return {
    calls,
    factory: async (input: any) => {
      calls.push(input);
      return {
        shim: { baseUrl: () => "http://127.0.0.1:1", token: () => "t", close: () => {} },
        release: () => { calls.push("release"); },
        models: [{ id: "m1" }], panelEntries: [{ id: "m1", name: "M1" }],
        refresh: async () => {}, setEnabled: (b: boolean) => calls.push(["enabled", b]),
      };
    },
  };
}

it("ensureRuntime：渠道注册过一次后，启停只走 setEnabled，不重建", async () => {
  const db: DatabaseSync = await openHubDatabase(join(mkdtempSync(join(tmpdir(), "hs-")), "hub.db"));
  seedChannelsAndAccounts(db,
    [{ id: "c", kind: "qoder", displayName: "C" }],
    [{ id: "a1", channelId: "c", displayName: "A1", credentialRef: "x", isCurrent: true }]);
  const f = fakeRuntimeFactory();
  const state = createHubState({ db, settings: {}, runtimeFactory: f.factory, logger: {} });
  await state.ensureRuntime("c");
  await state.setChannelEnabled("c", false);
  await state.setChannelEnabled("c", true);
  expect(f.calls.filter((c) => typeof c === "object")).toHaveLength(1);   // 只建一次
  expect(f.calls).toContainEqual(["enabled", false]);
  expect(f.calls).toContainEqual(["enabled", true]);
});

it("删光账号 → runtime 释放；再加账号 → 热注册回来", async () => {
  // seed 两个账号 → ensureRuntime → softDelete ×2 → 断言 calls 含 release
  // → state.addQoderPat("pt-test")（mock exchangePat）→ 断言 factory 被再次调用
});
```

（第二个用例补全：`vi.mock` 不用——直接给 hub-state 传 `proberDeps.exchangePat` 假实现，返回固定 session；见任务 6 的依赖注入形态。）

- [ ] **步骤 2：运行确认失败** → FAIL（模块不存在）

- [ ] **步骤 3：实现两个模块**（按上面职责说明；`createHubState(deps)` 返回对象而非 class，方法即第 5-7 节列出的操作；`deps.runtimeFactory` 必注入，生产路径传 `runtime.ts` 的 `startChannelRuntime` 绑定）。

- [ ] **步骤 4：运行确认通过** → `pnpm vitest run tests/hub-state.spec.ts tests/selector.spec.ts` PASS

- [ ] **步骤 5：Commit** `git commit -m "feat(state): HubState 状态中心 + 渠道 runtime 热注册/启停"`

---

### 任务 6：prober（一键认证 / 单账号测试 / 添加账号）

**文件：** 创建 `src/probe/prober.ts`；测试 `tests/prober.spec.ts`

**依赖注入形态**（测试不打真网络）：

```ts
export interface ProberDeps {
  fetchImpl?: typeof fetch;                       // 缺省 globalThis.fetch
  exchangePat?: typeof exchangePat;               // Qoder PAT 换 token
  dshHome?: string;                               // 缺省 resolveDshHome()
}
```

- `oneClickAuth(deps, db, state)` → `Promise<OneClickReport>`：

```ts
export interface OneClickSource { source: string; status: "ok" | "encrypted" | "missing" | "error"; detail: string }
export interface OneClickChannel { id: string; status: "ok" | "partial" | "missing"; sources: OneClickSource[]; accountsAdded: number }
export interface OneClickReport { channels: OneClickChannel[]; at: number }
```

WorkBuddy：`authCandidates()` 逐个 existsSync → parseAuthDocument 三态；`listVaultEntries()` 每条 ok；新账号 upsert（id `${PROVIDER_GLOBAL}:<accountId>`）；`state.ensureRuntime`。
Qoder：来源 = 旧 `~/.dsh/qoder/pat` + env + `<dshHome>/model-hub/qoder-pats/*.pat`（`listPatFiles`）逐个 `exchangePat` 验活；失败 detail 带「到 https://qoder.com.cn/account/integrations 新建 PAT」。

- `testAccount(deps, db, state, accountId)`：workbuddy → 读凭据文件 token → `fetchCatalog(region, token)`（HTTP ok 即成功）；qoder → 该账号 session manager `invalidate()+current()` 成功即成功。结果 `{ ok, detail, ms }`，内部已 `markAccountResult`。
- `addQoderPat(deps, db, state, pat, displayName?)`：`/^pt-[A-Za-z0-9_-]{8,}$/` 校验 → 写 `<dshHome>/model-hub/qoder-pats/<slug>.pat`（`mkdir 0o700` / `writeFile 0o600`，slug=备注名净化或 `pat-<前 6 位>`）→ `exchangePat` 验活 → upsert 账号（id `${PROVIDER_QODER}:<slug>`）→ ensureRuntime。失败即删刚写的文件（不留死 PAT）。

- [ ] **步骤 1：写失败的测试**（`fetchImpl` 假 `/v3/config` 返回 200/401 两分支；`exchangePat` 假实现抛错验证报告 `error` 态与 PAT 指引文案；`addQoderPat` 用 `pt-short` 断言抛「PAT 格式不对」；成功路径断言 PAT 文件落在 `dshHome` 注入的临时目录且权限路径正确）
- [ ] **步骤 2：运行确认失败** → FAIL
- [ ] **步骤 3：实现**（按上面契约；日志不落 PAT 原文——detail 里只出现文件路径与前 6 位）
- [ ] **步骤 4：运行确认通过** → `pnpm vitest run tests/prober.spec.ts` PASS
- [ ] **步骤 5：Commit** `git commit -m "feat(probe): 一键认证三态报告 / 单账号测试 / 贴 PAT 添加"`

---

### 任务 7：写路由（门禁 + 分发器）

**文件：** 创建 `src/routes/write.ts`；测试 `tests/write-routes.spec.ts`

**形态**：`registerWriteRoutes(ctx, { state, db, proberDeps })` 照 `data.ts` 的 `ctx.inject(["webServer"], ...)` 模式注册 exact 路由；分发逻辑抽成纯函数直接可测：

```ts
export interface WriteDeps { state: HubState; db: DatabaseSync; proberDeps: ProberDeps }
export async function dispatchWrite(deps: WriteDeps, path: string, body: Record<string, unknown>):
  Promise<{ status: number; json: unknown }>
// path 形如 "/channel/<id>/toggle"、"account/<id>/test"、"accounts/add"、"auth/one-click"、
// "records/prune"、"records/clear"
export function writeGate(req: { headers?: any }): { ok: true } | { ok: false; status: number; json: unknown }
// Host 回环 + Origin 存在且回环 + content-type 含 application/json
```

路由表（全部 exact，POST）：

```
/plugins/dsh-model-hub/channel/<id>/toggle     {enabled:boolean}
/plugins/dsh-model-hub/account/<id>/toggle     {enabled:boolean}
/plugins/dsh-model-hub/account/<id>/test
/plugins/dsh-model-hub/account/<id>/make-current
/plugins/dsh-model-hub/account/<id>/delete
/plugins/dsh-model-hub/accounts/add            WorkBuddy {channelId} | Qoder {channelId,pat,displayName?}
/plugins/dsh-model-hub/auth/one-click
/plugins/dsh-model-hub/records/prune           {days?:number}
/plugins/dsh-model-hub/records/clear
```

- [ ] **步骤 1：写失败的测试**

```ts
it("门禁：Origin 非回环 403；Origin 缺失 403；非 JSON 415；Host 非回环 403", () => {
  expect(writeGate({ headers: { host: "127.0.0.1:1", origin: "http://evil.com", "content-type": "application/json" } }))
    .toEqual({ ok: false, status: 403, json: { error: "origin_not_allowed" } });
  // …其余三态按同构断言
});
it("分发：account/<id>/make-current 后 is_current 唯一且翻转生效", async () => { /* 真库 + state 假 runtimeFactory */ });
it("分发：records/prune 返回 {removed}", async () => { /* 插 3 行旧 1 行新，days=90 断言 removed===3 */ });
it("分发：records/clear 清 requests 与 daily_rollups", async () => { /* 断言两表 COUNT=0 */ });
it("分发：未知路径 404；delete 后渠道池空时 state 收到 syncChannelRuntime", async () => { /* spy state */ });
```

- [ ] **步骤 2：运行确认失败** → FAIL
- [ ] **步骤 3：实现**（`writeGate` + `dispatchWrite` + `registerWriteRoutes`；注册整体 try/catch，失败只 logger.error）
- [ ] **步骤 4：运行确认通过** → `pnpm vitest run tests/write-routes.spec.ts tests/webserver-access.spec.ts` PASS
- [ ] **步骤 5：Commit** `git commit -m "feat(routes): 写路由——回环+Origin 双校验，九个操作分发器"`

---

### 任务 8：记录保留清理（retention）

**文件：** 创建 `src/store/retention.ts`；测试 `tests/retention.spec.ts`

- [ ] **步骤 1：写失败的测试**

```ts
import { pruneRequests, clearRecords } from "../src/store/retention.js";
it("prune 按天界删明细，daily_rollups 不动，返回删除行数", async () => {
  // 插 createdAt = now-100d 与 now-1d 两行 + 对应 rollup；prune(db, 90) → removed===1
  // 断言 rollups 行数不变
});
it("clear 清空两表", async () => { /* insertRequest ×2 → clear → 两表 COUNT 0 */ });
```

- [ ] **步骤 2：运行确认失败** → FAIL
- [ ] **步骤 3：实现**

```ts
export function pruneRequests(db: DatabaseSync, days: number, now = Date.now()): number {
  const cutoff = now - Math.max(1, Math.floor(days)) * 86_400_000;
  return db.prepare("DELETE FROM requests WHERE created_at < ?").run(cutoff).changes;
}
export function clearRecords(db: DatabaseSync): void {
  db.exec("BEGIN");
  try { db.exec("DELETE FROM requests"); db.exec("DELETE FROM daily_rollups"); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}
```

- [ ] **步骤 4：运行确认通过** → `pnpm vitest run tests/retention.spec.ts` PASS
- [ ] **步骤 5：Commit** `git commit -m "feat(store): 记录保留清理做真（prune/clear）"`

---

### 任务 9：index.ts 装配（瘦身）

**文件：** 修改 `src/index.ts`（及把 `registerProvider`/`writeStatus` 迁往 `src/state/runtime.ts` 复用）

装配顺序（全部包在现有 `applyInner` 的防御结构里）：

1. 开库（失败只关记录，return——现状保留）
2. `createHubState({ db, settings, runtimeFactory: startChannelRuntime-bound, logger: ctx.logger })`
3. **启动时若凭据可用不再直接建 runtime**——改为两渠道各自 `state.ensureRuntime(channelId)`（workbuddy 无凭据时 warn 并跳过，文案沿用现状；qoder 无 PAT 同理）。`makeRecorder` 的闭包迁进 runtime.ts。
4. `registerDataRoutes` 增加：`/channels` 响应带 `models_by_channel: state.panelModelsByChannel()`；`/diag` 增加 `recordEnabled: settings.recordEnabled !== false`、`retentionDays: settings.retentionDays ?? 90`
5. `registerWriteRoutes(ctx, { state, db, proberDeps: {} })`
6. 保留清理：启动跑一次 `pruneRequests(db, settings.retentionDays ?? 90)` + `setInterval(24h, unref)` 每次读最新 `settings.retentionDays`
7. `ctx.effect` teardown：各 runtime `shim.close()` + release + `db.close()`（从 state 拿清理清单）

- [ ] **步骤 1：改造**（无新纯逻辑，靠既有 spec 回归）
- [ ] **步骤 2：构建 + 类型检查**

运行：`pnpm build && pnpm typecheck`
预期：0 error（`lib/` 产物更新）。

- [ ] **步骤 3：全量测试**

运行：`pnpm test`
预期：全部 PASS（含 `webserver-access`、`full-stack`、`client-load`）。

- [ ] **步骤 4：Commit**

```bash
git add src/index.ts src/state/runtime.ts src/routes/data.ts
git commit -m "feat(index): 装配 HubState/写路由/保留清理；provider 注册迁入 runtime"
```

---

### 任务 10：客户端——解禁 6 控件 + 设为当前 + 渠道展开模型 + 记录管理

**文件：** 修改 `src/client/types.ts`、`src/client/api.ts`、`src/client/HubCard.ts`、`src/client/styles.ts`；创建 `src/client/AddAccountModal.ts`；测试扩展 `tests/client-load.spec.ts`

- [ ] **步骤 1：types + api**

`AccountRow` 加 `cooldown_until: number | null`；`ChannelsResponse` 加 `models_by_channel: Record<string, CatalogEntry[]>`；`DiagData` 加 `recordEnabled?: boolean`、`retentionDays?: number`。`api.ts` 追加：

```ts
async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const doc = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) throw new Error(doc?.error ?? `${path} -> HTTP ${response.status}`);
  return doc as T;
}
export const hubApi = {
  toggleChannel: (id: string, enabled: boolean) => postJson(`${DATA_PREFIX}/channel/${encodeURIComponent(id)}/toggle`, { enabled }),
  toggleAccount: (id: string, enabled: boolean) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/toggle`, { enabled }),
  testAccount: (id: string) => postJson<{ ok: boolean; detail: string; ms: number }>(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/test`),
  makeCurrent: (id: string) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/make-current`),
  deleteAccount: (id: string) => postJson(`${DATA_PREFIX}/account/${encodeURIComponent(id)}/delete`),
  addAccount: (body: { channelId: string; pat?: string; displayName?: string }) => postJson<{ added: string[] } | { error: string }>(`${DATA_PREFIX}/accounts/add`, body),
  oneClickAuth: () => postJson<OneClickReport>(`${DATA_PREFIX}/auth/one-click`),
  pruneRecords: (days?: number) => postJson<{ removed: number }>(`${DATA_PREFIX}/records/prune`, days === undefined ? {} : { days }),
  clearRecords: () => postJson(`${DATA_PREFIX}/records/clear`),
};
```

- [ ] **步骤 2：HubCard 状态与交互**

新增 state：`busyId: string | undefined`（行级按钮转圈/禁用）、`expandedChannel: string | undefined`、`authReport: OneClickReport | undefined`、`authBusy: boolean`、`addModalFor: string | undefined`。通用包装：

```ts
const run = (key: string, fn: () => Promise<void>) => async () => {
  setBusyId(key); setError(undefined);
  try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  finally { setBusyId(undefined); }
};
```

· 一键认证按钮：`onClick={run("auth", async () => setAuthReport(await hubApi.oneClickAuth()))}`，`authBusy` 期间文案「认证中…」；`authReport` 渲染在 tabs 上方结果区（每渠道一行：`display_name · ok/partial/missing · 接管 N 个账号 · 缺失原文`），带「关闭」小按钮
· 渠道行开关：`checked={channel.enabled === 1}` → `hubApi.toggleChannel`；行点击「展开 ▾」渲染 `models_by_channel[channel.id]` 列表（名称 · x倍率 · promotionBadge/tierBadge，样式复用 `dmh-badge`）
· 账号行：开关（`enabled`）、测试（结果进行内 meta：临时 `testResult` map 显示 `✓ 210ms` / `✗ 原文截断`）、「设为当前」（`is_current===1` 时不渲染，否则按钮）、删除（`confirm("删除账号 …？凭据文件不受影响")` 后 `hubApi.deleteAccount`）；`cooldown_until > now` 时状态点转 `err` 且 meta 加「熔断中（至 HH:mm）」
· 「+ 添加账号」：`setAddModalFor(channel.id)` 打开 `AddAccountModal`
· 诊断栏追加：`["记录", diag?.recordEnabled === false ? "关（宿主插件设置里改）" : "开"]` 一行；「记录管理」块：`保留天数 diag.retentionDays · 明细 diag.recordCount 条`，按钮「立即清理」→ `hubApi.pruneRecords()`，按钮「清空全部」→ `confirm` 两连问 → `hubApi.clearRecords()`

- [ ] **步骤 3：AddAccountModal.ts**

骨架抄 `RecordsModal`（overlay/sheet/Esc/遮罩关闭）。props：`{ channelId, kind, onClose, onDone }`。
· `kind === "workbuddy"`：说明文案 + 单按钮「扫描 vault 导入」→ `hubApi.addAccount({channelId})` → 显示 `added` 列表
· `kind === "qoder"`：`<textarea>` 贴 PAT（前端校验 `/^pt-[A-Za-z0-9_-]{8,}$/`，不合规禁用提交）+ 可选备注名输入 → `hubApi.addAccount({channelId, pat, displayName})`
· 错误显示在弹层内 errbox；成功调 `onDone()`（父组件 `load()` + 关闭）

- [ ] **步骤 4：styles.ts 追加**

`.dmh-models`（展开列表：缩进 16px、字号 11、每行 `·` 分隔）、`.dmh-switch`（可点开关的 hover/checked 态，去掉 disabled 专属灰）、`.dmh-form`（弹窗表单：label 上下排、textarea 4 行等宽字体）、`.dmh-authline`（认证结果行：渠道名 + 状态徽标 + 明细小字）。

- [ ] **步骤 5：扩展 client-load.spec.ts**

仿照现有渲染用例：以真 React 渲染 `HubCard`（`fetch` mock 成形如各路由的响应，含 `models_by_channel`、`cooldown_until` 非空的账号、`recordEnabled`），断言：

· 「一键认证」「+ 添加账号」「测试」「删除」按钮**不再是 disabled**
· 渠道行存在「展开」按钮，点击后出现 `models_by_channel` 里的模型名
· 诊断栏出现「记录：」与「保留天数」

- [ ] **步骤 6：构建 + 全量测试**

运行：`pnpm build && pnpm test`
预期：PASS（client.js 产物更新后 client-load 才会看新断言——先 build 后 test）。

- [ ] **步骤 7：Commit**

```bash
git add src/client tests/client-load.spec.ts
git commit -m "feat(ui): 解禁账号/渠道全部操作；添加账号弹窗；渠道展开模型；记录管理入面板"
```

---

### 任务 11：部署 + 真机验收

**文件：** 无代码（`scripts/deploy.ps1` 现有脚本）

- [ ] **步骤 1：构建产物齐全**

运行：`pnpm build && pnpm typecheck && pnpm test`
预期：全绿；`lib/index.js`、`lib/.client/client-impl.cjs`、`lib/schema.sql` 都已更新。

- [ ] **步骤 2：部署进 desktop profile**

运行：`pwsh scripts/deploy.ps1`
预期：脚本输出 bundles 里含 dsh-model-hub；无 `SessionAlreadyOwnedError`。

- [ ] **步骤 3：重启 DSH Desktop 并核对状态文件**

运行：`Get-Content "$env:USERPROFILE\.dsh\model-hub\status.json"`
预期：两个渠道 `ok:true`，modelCount 与启动日志一致。

- [ ] **步骤 4：真机验收清单（Web GUI 上逐项点）**

· 面板四栏数据正常；6 控件全部可点
· 测试：两渠道账号各点一次 → 状态点变绿、meta 出现「上次成功」
· 设为当前 + 账号启停：模型选择器即时增减
· 删除 Qoder 账号 → 重新贴 PAT → 模型不重启回来
· 一键认证：报告区列出两渠道接管/缺失原文
· Qoder 加第二个 PAT（可用假 PAT 验证报错文案含 qoder.com.cn 指引）
· 记录管理：立即清理返回删除行数；清空全部后统计归零
· 发一条真实消息：记录页新行带正确 account_id

- [ ] **步骤 5：收尾 commit（若验收中有修正）+ 汇报**

---

## 自检记录

**规格覆盖度**：§2 六控件→任务 6/7/10；多账号→任务 4/5/6；池策略→任务 2/3；热生效→任务 5；界面化三缺口→任务 7/8/10；门禁安全→任务 7；schema v2→任务 1；测试 §10 全 9 条→任务 1-8、10 各自步骤。无遗漏。
**占位符**：无「待定/TODO/类似任务 N」；两处「按注释补全/按契约实现」均有完整契约与代码在旁边步骤内给出。
**类型一致性**：`ShimDeps.prepare().account` / `dialect.request(input.account)` / `record.accountId`（任务 3 定）；`dispatchWrite(deps, path, body)`（任务 7 定义，任务 10 的 `hubApi` 路径与其一致）；`SelectorRow` 字段与 `queryAccounts` 投影一致；`models_by_channel` 在任务 7 之前由任务 5 的 `panelEntries` 支撑、任务 9 步骤 4 接线。
