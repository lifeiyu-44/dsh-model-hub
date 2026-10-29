# dsh-model-hub P0 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 dsh-model-hub 插件能在 DSH desktop profile 里加载，跑通一条真实的 WorkBuddy 请求，并在 SQLite 里落下带 TTFT / tok-s 的完整记录。

**架构：** 一个 `PiAiAdapter` + 一个回环 shim，埋点集中在 shim；渠道后端只负责给出 baseUrl / headers / 模型列表。P0 只做 host 侧，不含任何客户端 UI。

**技术栈：** TypeScript 5.9 · tsdown 0.22 · vitest 4.1 · `node:sqlite`（Node 24 内置）· `@deepseek-ai/dsh-llm-pi-ai` 0.2.1-rc.3

---

## 范围

P0 **只做 host 侧**，验证四件事：

1. 插件能被 profile 加载（`--dump-config` 里出现 `# == dsh-model-hub`）
2. SQLite 建库、写记录、查聚合都对
3. shim 能转发一条真实请求并算出 TTFT / tok-s
4. WorkBuddy 渠道能拿到凭据、拉到模型目录

**不做**：客户端 UI（P1）、ZCode / Qoder 渠道（P1）、一键认证（P1）、弹层 / 胶囊（P2）。

## 文件结构

```
dsh-model-hub/
├─ package.json                 dsh.bundle.patch 指向 cordis.patch.yml
├─ tsconfig.json
├─ tsdown.config.ts
├─ cordis.patch.yml             insert: [{id: dsh-model-hub}]
├─ src/
│  ├─ index.ts                  插件入口：inject ['llm','settings']，注册 adapter + 路由
│  ├─ config.ts                 Config schema（schemastery）
│  ├─ constants.ts              provider id、DB 路径、magic number
│  ├─ store/
│  │  ├─ db.ts                  打开 / 迁移 / application_id / 0600
│  │  ├─ requests.ts            写入 + 查询 + 聚合 UPSERT
│  │  └─ schema.sql             建表语句（版本 1）
│  ├─ shim/
│  │  ├─ server.ts              127.0.0.1 随机端口 + Bearer + Host/Origin 校验
│  │  ├─ recorder.ts            埋点：t0/t1/t2/t3、token 计数
│  │  └─ upstream.ts            转发 + SSE 解析
│  ├─ channels/
│  │  ├─ types.ts               ChannelBackend 接口
│  │  └─ workbuddy/
│  │     ├─ auth.ts             凭据探测（含加密信封）
│  │     ├─ catalog.ts          /v3/config 模型目录
│  │     └─ backend.ts          ChannelBackend 实现
│  └─ routes/
│     └─ records.ts             /plugins/dsh-model-hub/records
└─ tests/
   ├─ db.spec.ts
   ├─ recorder.spec.ts
   └─ sse.spec.ts
```

## 任务 1：项目骨架

**文件：**
- 创建：`package.json`、`tsconfig.json`、`tsdown.config.ts`、`cordis.patch.yml`、`.gitignore`

- [ ] **步骤 1：写 package.json**

```json
{
  "name": "dsh-model-hub",
  "displayName": "DSH Model Hub",
  "description": "把 WorkBuddy / ZCode / Qoder CN 的模型统一接入 DeepSeek Harness，带账号管理与请求记录",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "scripts": {
    "build": "tsdown",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "3.18.5"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.1-rc.1 <5.0.0",
    "@deepseek-ai/dsh-atomic-write": ">=0.1.7-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-home-paths": ">=0.1.7-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-host-webserver": ">=0.1.7-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-llm": ">=0.1.7-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-llm-pi-ai": ">=0.1.7-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-settings": ">=0.1.7-rc.1 <0.3.0-0",
    "@earendil-works/pi-ai": ">=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/dsh-home-paths": "0.2.1-rc.3",
    "@deepseek-ai/dsh-host-webserver": "0.2.1-rc.3",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.3",
    "@deepseek-ai/dsh-llm-pi-ai": "0.2.1-rc.3",
    "@deepseek-ai/dsh-settings": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "3.18.5",
    "@earendil-works/pi-ai": "1.1.0",
    "@types/node": "^22.20.0",
    "tsdown": "^0.22.2",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

注意：`dsh.client` 字段 P0 不写 —— 没有客户端 bundle，写了会让宿主找不到文件。

- [ ] **步骤 2：写 cordis.patch.yml**

```yaml
# dsh-model-hub：把三个平台的模型统一接入 DSH。
# P0 只注册 host 侧；客户端 UI 在 P1 追加 dsh.client 字段与 lib/client.js。
- insert:
    - id: dsh-model-hub
      name: dsh-model-hub
```

- [ ] **步骤 3：写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "declaration": true,
    "outDir": "lib",
    "rootDir": "src",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **步骤 4：写 tsdown.config.ts**

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  outDir: "lib",
  external: [
    /^@deepseek-ai\//,
    /^@earendil-works\//,
    "react",
    "react-dom",
  ],
});
```

`external` 是关键：宿主包由 DSH 提供，不能打进 bundle。

- [ ] **步骤 5：写 .gitignore**

```
node_modules/
lib/
*.log
.DS_Store
```

- [ ] **步骤 6：装依赖**

运行：
```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\ds\DeepSeek Harness.exe' 'D:\ds\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs' install
```
预期：`node_modules` 出现，无报错。

- [ ] **步骤 7：Commit**

```bash
git add -A && git commit -m "chore: 项目骨架（package.json / tsconfig / tsdown / patch）"
```

## 任务 2：SQLite 存储层

**文件：**
- 创建：`src/constants.ts`、`src/store/schema.sql`、`src/store/db.ts`、`src/store/requests.ts`
- 测试：`tests/db.spec.ts`

- [ ] **步骤 1：写 constants.ts**

```ts
/** 本插件的数据库文件放在 $DSH_HOME 下的这个子目录。 */
export const HUB_DIR_NAME = "model-hub";
/** 主库文件名。 */
export const HUB_DB_NAME = "hub.db";
/**
 * SQLite `application_id`，用来认领这个库。
 *
 * 0x48554231 = "HUB1"。打开时若 application_id 既不是 0（全新文件）也不是本值，
 * 说明这个路径上放的是别人的库 —— 拒绝打开，而不是往上写。
 */
export const HUB_APP_ID = 0x48554231;
/** 当前 schema 版本，写在 PRAGMA user_version。 */
export const HUB_SCHEMA_VERSION = 1;
/** provider id 前缀，与 dsh-connect-workbuddy 的 workbuddy/workbuddy-global 区分。 */
export const PROVIDER_PREFIX = "hub-";
```

- [ ] **步骤 2：写 schema.sql（版本 1）**

```sql
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  config        TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS accounts (
  id                   TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  credential_ref       TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  is_current           INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_ok_at           INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  request_id       TEXT PRIMARY KEY,
  session_id       TEXT,
  channel_id       TEXT NOT NULL,
  account_id       TEXT,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  cache_write      INTEGER NOT NULL DEFAULT 0,
  first_token_ms   INTEGER,
  upstream_head_ms INTEGER,
  duration_ms      INTEGER,
  decode_tps       REAL,
  status_code      INTEGER,
  error            TEXT,
  is_streaming     INTEGER NOT NULL DEFAULT 0,
  estimated        INTEGER NOT NULL DEFAULT 0,
  cost_units       REAL NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_channel ON requests(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_rollups (
  date          TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  account_id    TEXT NOT NULL DEFAULT '',
  req_count     INTEGER NOT NULL DEFAULT 0,
  ok_count      INTEGER NOT NULL DEFAULT 0,
  tokens        INTEGER NOT NULL DEFAULT 0,
  cost_units    REAL NOT NULL DEFAULT 0,
  avg_ttft_ms   INTEGER NOT NULL DEFAULT 0,
  ttft_n        INTEGER NOT NULL DEFAULT 0,
  avg_tps       REAL NOT NULL DEFAULT 0,
  tps_n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, channel_id, model, account_id)
);
```

- [ ] **步骤 3：写失败的测试 tests/db.spec.ts**

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubDatabase } from "../src/store/db.js";

describe("openHubDatabase", () => {
  it("creates the file with 0600 and stamps the application id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
    const path = join(dir, "hub.db");
    const db = await openHubDatabase(path);
    const { application_id } = db.prepare("PRAGMA application_id").get() as { application_id: number };
    expect(application_id).toBe(0x48554231);
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(1);
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
```

- [ ] **步骤 4：运行测试确认失败**

运行：`npx vitest run tests/db.spec.ts`
预期：FAIL，`Cannot find module '../src/store/db.js'`

- [ ] **步骤 5：写 db.ts**

```ts
import { mkdir, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_APP_ID, HUB_SCHEMA_VERSION } from "../constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_V1 = readFileSync(join(HERE, "schema.sql"), "utf8");

/**
 * 打开（或创建）本插件的 SQLite 库。
 *
 * 三条加固，抄自 DSH 官方的 `dsh-session-query-sqlite`：
 * 1. 建库即 0600、建目录即 0700 —— 不是建完再 chmod
 * 2. `application_id` 认领 —— 这个路径上放的是别人的库就拒绝，而不是往上写
 * 3. `user_version` 迁移 —— 按版本号逐级升级，不靠「表存在就跳过」
 */
export async function openHubDatabase(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await (await open(path, "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    const { application_id: applicationId } = db.prepare("PRAGMA application_id").get() as { application_id: number };
    if (applicationId !== 0 && applicationId !== HUB_APP_ID) {
      throw new Error(`the database at "${path}" belongs to another application (application_id=${applicationId})`);
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version < 1) db.exec(SCHEMA_V1);
    if (version !== HUB_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${HUB_SCHEMA_VERSION}`);
    if (version === 0) db.exec(`PRAGMA application_id = ${HUB_APP_ID}`);

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
```

- [ ] **步骤 6：运行测试确认通过**

运行：`npx vitest run tests/db.spec.ts`
预期：PASS，3 个用例全绿

- [ ] **步骤 7：写 requests.ts（写入 + 聚合）**

```ts
import type { DatabaseSync } from "node:sqlite";

export interface RequestRecord {
  requestId: string;
  sessionId?: string;
  channelId: string;
  accountId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  firstTokenMs?: number;
  upstreamHeadMs?: number;
  durationMs?: number;
  decodeTps?: number;
  statusCode?: number;
  error?: string;
  isStreaming: boolean;
  estimated: boolean;
  costUnits: number;
  createdAt: number;
}

/** 本地时区的 YYYY-MM-DD。聚合按用户看到的「今天」分组，不是 UTC。 */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 写一条请求记录，并增量累加当日聚合。
 *
 * 聚合口径必须与明细重算逐字段相等（回归锚点）：均值存加权均值，
 * 各自带样本数 ttft_n / tps_n —— 不能拿 ok_count 凑，因为 TTFT 与 tok/s
 * 都可能为 NULL，各自的样本数不同。
 */
export function insertRequest(db: DatabaseSync, r: RequestRecord): void {
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO requests (
        request_id, session_id, channel_id, account_id, provider, model,
        input_tokens, output_tokens, cache_read, cache_write,
        first_token_ms, upstream_head_ms, duration_ms, decode_tps,
        status_code, error, is_streaming, estimated, cost_units, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      r.requestId, r.sessionId ?? null, r.channelId, r.accountId ?? null, r.provider, r.model,
      r.inputTokens, r.outputTokens, r.cacheRead, r.cacheWrite,
      r.firstTokenMs ?? null, r.upstreamHeadMs ?? null, r.durationMs ?? null, r.decodeTps ?? null,
      r.statusCode ?? null, r.error ?? null, r.isStreaming ? 1 : 0, r.estimated ? 1 : 0,
      r.costUnits, r.createdAt,
    );

    const date = localDate(r.createdAt);
    const account = r.accountId ?? "";
    const ok = r.statusCode !== undefined && r.statusCode >= 200 && r.statusCode < 300 ? 1 : 0;
    const tokens = r.inputTokens + r.outputTokens;
    const hasTtft = r.firstTokenMs !== undefined;
    const hasTps = r.decodeTps !== undefined;

    const existing = db.prepare(
      "SELECT req_count, ok_count, tokens, cost_units, avg_ttft_ms, ttft_n, avg_tps, tps_n FROM daily_rollups WHERE date=? AND channel_id=? AND model=? AND account_id=?",
    ).get(date, r.channelId, r.model, account) as
      | { req_count: number; ok_count: number; tokens: number; cost_units: number; avg_ttft_ms: number; ttft_n: number; avg_tps: number; tps_n: number }
      | undefined;

    const prev = existing ?? { req_count: 0, ok_count: 0, tokens: 0, cost_units: 0, avg_ttft_ms: 0, ttft_n: 0, avg_tps: 0, tps_n: 0 };
    const ttftN = prev.ttft_n + (hasTtft ? 1 : 0);
    const tpsN = prev.tps_n + (hasTps ? 1 : 0);
    const avgTtft = hasTtft ? Math.round((prev.avg_ttft_ms * prev.ttft_n + r.firstTokenMs!) / ttftN) : prev.avg_ttft_ms;
    const avgTps = hasTps ? (prev.avg_tps * prev.tps_n + r.decodeTps!) / tpsN : prev.avg_tps;

    db.prepare(`
      INSERT INTO daily_rollups (date, channel_id, model, account_id, req_count, ok_count, tokens, cost_units, avg_ttft_ms, ttft_n, avg_tps, tps_n)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(date, channel_id, model, account_id) DO UPDATE SET
        req_count=excluded.req_count, ok_count=excluded.ok_count, tokens=excluded.tokens,
        cost_units=excluded.cost_units, avg_ttft_ms=excluded.avg_ttft_ms, ttft_n=excluded.ttft_n,
        avg_tps=excluded.avg_tps, tps_n=excluded.tps_n
    `).run(
      date, r.channelId, r.model, account,
      prev.req_count + 1, prev.ok_count + ok, prev.tokens + tokens, prev.cost_units + r.costUnits,
      avgTtft, ttftN, avgTps, tpsN,
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
```

- [ ] **步骤 8：给 requests.ts 加测试（聚合口径回归锚点）**

追加到 `tests/db.spec.ts`：

```ts
it("rollups equal a recompute from the detail rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
  const db = await openHubDatabase(join(dir, "hub.db"));
  const base = { channelId: "hub-wb", provider: "hub-workbuddy-global", model: "m1", inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0, isStreaming: true, estimated: false, costUnits: 1.5 };
  insertRequest(db, { ...base, requestId: "a", firstTokenMs: 400, decodeTps: 50, durationMs: 1400, statusCode: 200, createdAt: Date.UTC(2026, 9, 27, 4, 0) });
  insertRequest(db, { ...base, requestId: "b", firstTokenMs: 600, decodeTps: 30, durationMs: 2000, statusCode: 200, createdAt: Date.UTC(2026, 9, 27, 5, 0) });
  insertRequest(db, { ...base, requestId: "c", statusCode: 500, createdAt: Date.UTC(2026, 9, 27, 6, 0) });

  const row = db.prepare("SELECT * FROM daily_rollups").get() as any;
  expect(row.req_count).toBe(3);
  expect(row.ok_count).toBe(2);
  expect(row.tokens).toBe(450);
  expect(row.ttft_n).toBe(2);
  expect(row.avg_ttft_ms).toBe(500);
  expect(row.tps_n).toBe(2);
  expect(row.avg_tps).toBeCloseTo(40, 5);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **步骤 9：运行测试**

运行：`npx vitest run tests/db.spec.ts`
预期：PASS，4 个用例

- [ ] **步骤 10：Commit**

```bash
git add -A && git commit -m "feat(store): SQLite 存储层（application_id 认领 / user_version 迁移 / 加权聚合）"
```

## 任务 3：埋点记录器（纯逻辑，先测）

**文件：**
- 创建：`src/shim/recorder.ts`
- 测试：`tests/recorder.spec.ts`

- [ ] **步骤 1：写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { TurnTimer } from "../src/shim/recorder.js";

describe("TurnTimer", () => {
  it("computes TTFT from request start to first non-empty delta", () => {
    const t = new TurnTimer(1000);
    t.onUpstreamHead(1300);
    t.onDelta("", 1500);        // 空 delta 不算首 token
    t.onDelta("Hi", 1700);
    t.onEnd(3000, { inputTokens: 100, outputTokens: 200, cacheRead: 0, cacheWrite: 0 });
    const m = t.metrics();
    expect(m.upstreamHeadMs).toBe(300);
    expect(m.firstTokenMs).toBe(700);
    expect(m.durationMs).toBe(2000);
    expect(m.decodeTps).toBeCloseTo(200 / ((3000 - 1700) / 1000), 5);
  });

  it("marks non-streaming turns with null decodeTps", () => {
    const t = new TurnTimer(0);
    t.onEnd(500, { inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheWrite: 0 });
    const m = t.metrics();
    expect(m.firstTokenMs).toBeUndefined();
    expect(m.decodeTps).toBeUndefined();
    expect(m.durationMs).toBe(500);
  });

  it("estimates tokens when upstream reports none", () => {
    const t = new TurnTimer(0);
    t.onDelta("abcdefgh", 100);   // 8 字符
    t.onEnd(1000);
    const m = t.metrics();
    expect(m.estimated).toBe(true);
    expect(m.outputTokens).toBe(2);   // 8 / 4
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`npx vitest run tests/recorder.spec.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：写 recorder.ts**

```ts
/** 上游 usage 的归一化形状（OpenAI 与 Anthropic 都归到这里）。 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TurnMetrics {
  firstTokenMs?: number;
  upstreamHeadMs?: number;
  durationMs?: number;
  decodeTps?: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  estimated: boolean;
}

/** 估算用：约 4 字符 / token。只在拿不到上游 usage 时兜底。 */
const CHARS_PER_TOKEN = 4;

/**
 * 一次请求的计时器。
 *
 * 四个计时点（见设计规格 §5.1）：
 *   t0 请求到达 shim / t1 上游响应头 / t2 首个非空 delta / t3 流结束
 *   TTFT = t2 - t0；upstreamHead = t1 - t0；decodeTps = output / (t3 - t2)
 *
 * 拿不到 usage 时用字符数估算，并置 estimated —— 不猜，但也不留空。
 */
export class TurnTimer {
  #t0: number;
  #t1?: number;
  #t2?: number;
  #chars = 0;

  constructor(startedAt: number) {
    this.#t0 = startedAt;
  }

  onUpstreamHead(at: number): void {
    if (this.#t1 === undefined) this.#t1 = at;
  }

  onDelta(text: string, at: number): void {
    this.#chars += text.length;
    if (this.#t2 === undefined && text.length > 0) this.#t2 = at;
  }

  onEnd(at: number, usage?: NormalizedUsage): TurnMetrics {
    const estimated = usage === undefined;
    const outputTokens = usage?.outputTokens ?? Math.floor(this.#chars / CHARS_PER_TOKEN);
    const decodeMs = this.#t2 === undefined ? undefined : at - this.#t2;
    return {
      ...(this.#t2 === undefined ? {} : { firstTokenMs: this.#t2 - this.#t0 }),
      ...(this.#t1 === undefined ? {} : { upstreamHeadMs: this.#t1 - this.#t0 }),
      durationMs: at - this.#t0,
      ...(decodeMs === undefined || decodeMs <= 0 ? {} : { decodeTps: outputTokens / (decodeMs / 1000) }),
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      estimated,
    };
  }
}
```

- [ ] **步骤 4：运行确认通过**

运行：`npx vitest run tests/recorder.spec.ts`
预期：PASS，3 个用例

- [ ] **步骤 5：Commit**

```bash
git add -A && git commit -m "feat(shim): 计时器（TTFT / 解码速度 / token 估算）"
```

## 任务 4：WorkBuddy 渠道（凭据 + 目录）

**文件：**
- 创建：`src/channels/types.ts`、`src/channels/workbuddy/auth.ts`、`src/channels/workbuddy/catalog.ts`
- 测试：`tests/workbuddy-auth.spec.ts`

- [ ] **步骤 1：写 channels/types.ts**

```ts
/** 一个渠道后端要提供的最小接口。新增平台只实现这三件事。 */
export interface ChannelBackend {
  /** 渠道 id，如 `hub-workbuddy-global`。 */
  readonly id: string;
  /** 该渠道当前可用的模型列表；无凭据时返回空数组，不抛错。 */
  listModels(): Promise<ChannelModel[]>;
  /** 组装一次上游请求所需的地址与头。 */
  prepare(): Promise<{ baseUrl: string; headers: Record<string, string> }>;
}

export interface ChannelModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  creditMultiplier: number;
  supportsImages: boolean;
}
```

- [ ] **步骤 2：写失败的测试 tests/workbuddy-auth.spec.ts**

```ts
import { describe, expect, it } from "vitest";
import { parseAuthDocument, regionOfDomain } from "../src/channels/workbuddy/auth.js";

describe("regionOfDomain", () => {
  it("classifies brand domains", () => {
    expect(regionOfDomain("www.workbuddy.ai")).toBe("global");
    expect(regionOfDomain("codebuddy.ai")).toBe("global");
    expect(regionOfDomain("www.workbuddy.cn")).toBe("cn");
    expect(regionOfDomain("copilot.tencent.com")).toBe("cn");
  });
  it("does not let a lookalike domain qualify", () => {
    expect(regionOfDomain("codebuddy.ai.evil.com")).toBeUndefined();
  });
});

describe("parseAuthDocument", () => {
  it("reads a plain-text token", () => {
    const doc = JSON.stringify({ domain: "www.workbuddy.ai", accessToken: "tok-123", refreshToken: "ref-1", expiresAt: 1900000000000 });
    const parsed = parseAuthDocument(doc);
    expect(parsed.kind).toBe("plain");
    expect(parsed.token).toBe("tok-123");
    expect(parsed.region).toBe("global");
  });

  it("reports an encrypted token as such instead of pretending it is empty", () => {
    const doc = JSON.stringify({ domain: "www.workbuddy.ai", accessToken: { $wbEncrypted: 1, envelope: "abc" } });
    const parsed = parseAuthDocument(doc);
    expect(parsed.kind).toBe("encrypted");
    expect(parsed.token).toBeUndefined();
  });
});
```

- [ ] **步骤 3：运行确认失败**

运行：`npx vitest run tests/workbuddy-auth.spec.ts`
预期：FAIL

- [ ] **步骤 4：写 auth.ts**

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Region = "cn" | "global";

/** 凭据的三种状态：明文可用 / 加密需解 / 读不到。 */
export type AuthKind = "plain" | "encrypted" | "missing";

export interface ParsedAuth {
  kind: AuthKind;
  region?: Region;
  token?: string;
  refreshToken?: string;
  expiresAtMs?: number;
  /** 加密时带上信封原文，交给解密器；不在这里猜密钥。 */
  envelope?: string;
}

/**
 * 品牌域名 → 区域。
 *
 * 必须精确匹配或点号后缀匹配：`codebuddy.ai.evil.com` 不能被判成 global。
 */
export function regionOfDomain(domain: string): Region | undefined {
  const d = domain.trim().toLowerCase();
  if (d === "workbuddy.ai" || d.endsWith(".workbuddy.ai")) return "global";
  if (d === "codebuddy.ai" || d.endsWith(".codebuddy.ai")) return "global";
  if (d === "workbuddy.cn" || d.endsWith(".workbuddy.cn")) return "cn";
  if (d === "codebuddy.cn" || d.endsWith(".codebuddy.cn")) return "cn";
  if (d === "copilot.tencent.com" || d.endsWith(".copilot.tencent.com")) return "cn";
  return undefined;
}

/** 本机可能放 WorkBuddy 登录态的位置，按区域分。 */
export function authCandidates(): string[] {
  const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  const roaming = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  const explicit = process.env["WORKBUDDY_AUTH_FILE"];
  const list: string[] = [];
  if (explicit !== undefined && explicit !== "") list.push(explicit);
  for (const root of [local, roaming]) {
    list.push(join(root, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop-ai.info"));
    list.push(join(root, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"));
  }
  return [...new Set(list)];
}

/**
 * 解析一份 auth 文件。
 *
 * **加密 token 不等于「没有 token」**：新版桌面端把 accessToken 换成
 * `{"$wbEncrypted":1,"envelope":"…"}` 的 AES-256-GCM 信封。这里如实报告
 * `kind: "encrypted"` 并把信封交出去，让调用方决定怎么解 —— 绝不内置密钥副本。
 */
export function parseAuthDocument(text: string): ParsedAuth {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: "missing" };
  }
  const domain = typeof doc["domain"] === "string" ? doc["domain"] : "";
  const region = regionOfDomain(domain);
  const raw = doc["accessToken"];
  const expiresAtMs = typeof doc["expiresAt"] === "number" ? doc["expiresAt"] : undefined;

  if (typeof raw === "string" && raw !== "") {
    return {
      kind: "plain",
      ...(region === undefined ? {} : { region }),
      token: raw,
      ...(typeof doc["refreshToken"] === "string" ? { refreshToken: doc["refreshToken"] } : {}),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    };
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (rec["$wbEncrypted"] !== undefined) {
      return {
        kind: "encrypted",
        ...(region === undefined ? {} : { region }),
        ...(typeof rec["envelope"] === "string" ? { envelope: rec["envelope"] } : {}),
        ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      };
    }
  }
  return { kind: "missing", ...(region === undefined ? {} : { region }) };
}

/** 扫描候选路径，返回第一个能读到的凭据及其来源路径。 */
export function detectCredential(): { path: string; parsed: ParsedAuth } | undefined {
  for (const path of authCandidates()) {
    if (!existsSync(path)) continue;
    try {
      return { path, parsed: parseAuthDocument(readFileSync(path, "utf8")) };
    } catch {
      continue;
    }
  }
  return undefined;
}
```

- [ ] **步骤 5：运行确认通过**

运行：`npx vitest run tests/workbuddy-auth.spec.ts`
预期：PASS

- [ ] **步骤 6：写 catalog.ts（模型目录）**

```ts
import type { ChannelModel } from "../types.js";

/** 桌面端 UA —— 上游按客户端通道裁剪配置，CLI UA 会少给模型和促销字段。 */
const DESKTOP_UA = "WorkBuddy/5.12.1 WorkBuddy/5.12.1 CLI/2.63.2";

export function upstreamBase(region: "cn" | "global"): string {
  return region === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
}

/**
 * 拉模型目录。
 *
 * 必须用桌面端身份读 `/v3/config`：CLI 通道的答复是 App 通道的严格子集，
 * 既不发布 modelPromotions 也不发布 modelTiers（实测：CLI 5 键 35 模型，
 * App 18 键 37 模型）。
 */
export async function fetchCatalog(region: "cn" | "global", token: string, signal?: AbortSignal): Promise<ChannelModel[]> {
  const url = `${upstreamBase(region)}/v3/config`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": DESKTOP_UA,
      Accept: "application/json",
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${response.status}`);
  const doc = (await response.json()) as Record<string, unknown>;
  const data = (doc["data"] ?? doc) as Record<string, unknown>;
  const models = Array.isArray(data["models"]) ? (data["models"] as Record<string, unknown>[]) : [];
  return models.flatMap((entry) => {
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    if (id === "") return [];
    return [{
      id,
      name: typeof entry["name"] === "string" ? entry["name"] : id,
      contextWindow: typeof entry["contextWindow"] === "number" ? entry["contextWindow"] : 200_000,
      maxTokens: typeof entry["maxTokens"] === "number" ? entry["maxTokens"] : 32_000,
      creditMultiplier: typeof entry["creditMultiplier"] === "number" ? entry["creditMultiplier"] : 0,
      supportsImages: entry["supportsImages"] === true,
    }];
  });
}
```

- [ ] **步骤 7：Commit**

```bash
git add -A && git commit -m "feat(workbuddy): 凭据探测（区分加密/明文）+ 桌面端身份的模型目录"
```

## 任务 5：shim 服务器

**文件：**
- 创建：`src/shim/server.ts`、`src/shim/upstream.ts`

- [ ] **步骤 1：写 upstream.ts（SSE 解析）**

```ts
import type { NormalizedUsage } from "./recorder.js";

/** 从一条 SSE `data:` 行里取出 token 增量与 usage。 */
export function parseSseLine(line: string): { text?: string; usage?: NormalizedUsage; done: boolean } {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith(":")) return { done: false };
  if (!trimmed.startsWith("data:")) return { done: false };
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return { done: true };

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { done: false };
  }

  const text = extractText(doc);
  const usage = extractUsage(doc);
  return { ...(text === undefined ? {} : { text }), ...(usage === undefined ? {} : { usage }), done: false };
}

/** OpenAI chat.completions 与 Anthropic messages 两种 delta 形状都认。 */
function extractText(doc: Record<string, unknown>): string | undefined {
  const choices = doc["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const delta = first["delta"] as Record<string, unknown> | undefined;
    if (delta !== undefined && typeof delta["content"] === "string") return delta["content"];
  }
  const delta = doc["delta"] as Record<string, unknown> | undefined;
  if (delta !== undefined && typeof delta["text"] === "string") return delta["text"];
  const content = doc["content"];
  if (Array.isArray(content)) {
    const part = content.find((p) => (p as Record<string, unknown>)["type"] === "text_delta");
    if (part !== undefined && typeof (part as Record<string, unknown>)["text"] === "string") {
      return (part as Record<string, unknown>)["text"] as string;
    }
  }
  return undefined;
}

/** 两种协议字段名不同，统一归一。 */
export function extractUsage(doc: Record<string, unknown>): NormalizedUsage | undefined {
  const usage = doc["usage"] as Record<string, unknown> | undefined;
  if (usage === undefined) return undefined;
  const input = usage["prompt_tokens"] ?? usage["input_tokens"];
  const output = usage["completion_tokens"] ?? usage["output_tokens"];
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
    cacheRead: typeof usage["cache_read_input_tokens"] === "number" ? (usage["cache_read_input_tokens"] as number) : 0,
    cacheWrite: typeof usage["cache_creation_input_tokens"] === "number" ? (usage["cache_creation_input_tokens"] as number) : 0,
  };
}
```

- [ ] **步骤 2：写 server.ts**

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TurnTimer, type NormalizedUsage } from "./recorder.js";
import { parseSseLine } from "./upstream.js";

export interface ShimDeps {
  /** 上游地址与请求头，由渠道后端提供。 */
  prepare(): Promise<{ baseUrl: string; headers: Record<string, string> }>;
  /** 记录一次完成的请求。抛错不得影响响应。 */
  record(input: {
    metrics: ReturnType<TurnTimer["metrics"]>;
    statusCode: number;
    error?: string;
    isStreaming: boolean;
  }): void;
}

export interface ShimHandle {
  baseUrl(): string;
  close(): void;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (LOOPBACK.has(name)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    return hostIsLoopback(new URL(origin).host);
  } catch {
    return false;
  }
}

/**
 * 起一个只监听回环的 OpenAI 兼容 shim。
 *
 * 三重门：Host 必须回环、Origin 必须回环、Bearer 必须是本次进程内生成的随机值
 * 并用 timingSafeEqual 常数时间比对。真实上游 token 从不交给 pi-ai。
 */
export async function startShim(deps: ShimDeps): Promise<ShimHandle> {
  const secret = randomBytes(32).toString("base64url");
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostIsLoopback(req.headers.host)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "host_not_allowed" }));
      return;
    }
    if (!originIsLoopback(req.headers.origin)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }
    const header = req.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const t0 = Date.now();
    const timer = new TurnTimer(t0);
    let statusCode = 502;
    let error: string | undefined;
    let usage: NormalizedUsage | undefined;
    let streaming = false;

    try {
      const body = await readBody(req);
      const { baseUrl, headers } = await deps.prepare();
      const upstream = await fetch(`${baseUrl}/v2/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      });
      timer.onUpstreamHead(Date.now());
      statusCode = upstream.status;
      if (!upstream.ok) {
        error = `upstream HTTP ${upstream.status}`;
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(await upstream.text());
        return;
      }

      const contentType = upstream.headers.get("content-type") ?? "";
      streaming = contentType.includes("text/event-stream");
      res.writeHead(200, {
        "content-type": contentType || "application/json",
        ...(streaming ? { "cache-control": "no-cache", connection: "keep-alive" } : {}),
      });

      if (!upstream.body) {
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        if (!streaming) continue;
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const parsed = parseSseLine(line);
          if (parsed.text !== undefined) timer.onDelta(parsed.text, Date.now());
          if (parsed.usage !== undefined) usage = parsed.usage;
          nl = buffer.indexOf("\n");
        }
      }
      res.end();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "shim_failed" }));
      }
    } finally {
      try {
        deps.record({
          metrics: timer.onEnd(Date.now(), usage),
          statusCode,
          ...(error === undefined ? {} : { error }),
          isStreaming: streaming,
        });
      } catch {
        /* 观测失败不能拖垮请求 */
      }
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("shim has no listening address");

  return {
    baseUrl: () => `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **步骤 3：写 SSE 解析测试 tests/sse.spec.ts**

```ts
import { describe, expect, it } from "vitest";
import { parseSseLine } from "../src/shim/upstream.js";

describe("parseSseLine", () => {
  it("reads an OpenAI content delta", () => {
    const r = parseSseLine(`data: {"choices":[{"delta":{"content":"Hi"}}]}`);
    expect(r.text).toBe("Hi");
  });
  it("reads an Anthropic text_delta", () => {
    const r = parseSseLine(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Yo"}}`);
    expect(r.text).toBe("Yo");
  });
  it("reads OpenAI usage", () => {
    const r = parseSseLine(`data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}`);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheWrite: 0 });
  });
  it("reads Anthropic usage with cache fields", () => {
    const r = parseSseLine(`data: {"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5}}`);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheRead: 5, cacheWrite: 0 });
  });
  it("recognizes [DONE] and ignores comments", () => {
    expect(parseSseLine("data: [DONE]").done).toBe(true);
    expect(parseSseLine(": keep-alive").done).toBe(false);
    expect(parseSseLine("").done).toBe(false);
  });
});
```

- [ ] **步骤 4：运行全部测试**

运行：`npx vitest run`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add -A && git commit -m "feat(shim): 回环服务器 + SSE 解析 + 埋点接线"
```

## 任务 6：插件入口与路由

**文件：**
- 创建：`src/index.ts`、`src/config.ts`、`src/routes/records.ts`

- [ ] **步骤 1：写 config.ts**

```ts
import z from "@deepseek-ai/schemastery";

/** 全部字段 .volatile() —— 宿主把标了它的字段当引用对象，改完即生效、不用重载插件。 */
export const Config = z.object({
  enabled: z.boolean().default(true).description("总开关").volatile(),
  recordEnabled: z.boolean().default(true).description("是否记录请求").volatile(),
  retentionDays: z.number().default(90).description("明细保留天数").volatile(),
});
```

- [ ] **步骤 2：写 routes/records.ts**

```ts
import type { Context } from "@deepseek-ai/cordis";

export const RECORDS_PATH = "/plugins/dsh-model-hub/records";

/** 只读路由：最近 N 条记录 + 当日聚合。 */
export function registerRecordsRoute(ctx: Context, deps: { query(limit: number): unknown }): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: RECORDS_PATH,
      handler: (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 500);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(deps.query(limit)));
      },
    });
    return () => dispose();
  }, "dsh-model-hub: records route");
}
```

- [ ] **步骤 3：写 index.ts**

```ts
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Config } from "./config.js";
import { HUB_DB_NAME, HUB_DIR_NAME, PROVIDER_PREFIX } from "./constants.js";
import { openHubDatabase } from "./store/db.js";
import { insertRequest } from "./store/requests.js";
import { startShim } from "./shim/server.js";
import { registerRecordsRoute } from "./routes/records.js";
import { detectCredential } from "./channels/workbuddy/auth.js";
import { fetchCatalog, upstreamBase } from "./channels/workbuddy/catalog.js";

export const name = "dsh-model-hub";
export { Config };
export const inject = ["llm"];

const PROVIDER_GLOBAL = `${PROVIDER_PREFIX}workbuddy-global`;

export function apply(ctx: any, config: any): void {
  const settings = config ?? {};
  if (settings.enabled === false) return;

  const dbPath = join(resolveDshHome(), HUB_DIR_NAME, HUB_DB_NAME);
  let db: Awaited<ReturnType<typeof openHubDatabase>> | undefined;

  void (async () => {
    try {
      db = await openHubDatabase(dbPath);
    } catch (error) {
      ctx.logger?.error?.("dsh-model-hub: 数据库打开失败，记录功能关闭", error);
      return;
    }

    const detected = detectCredential();
    if (detected === undefined || detected.parsed.kind !== "plain" || detected.parsed.token === undefined) {
      ctx.logger?.warn?.(
        `dsh-model-hub: 未找到可用的 WorkBuddy 明文凭据（探测到：${detected?.parsed.kind ?? "missing"}），渠道不注册`,
      );
      return;
    }
    const token = detected.parsed.token;
    const region = detected.parsed.region ?? "global";

    const models = await fetchCatalog(region, token).catch((error: unknown) => {
      ctx.logger?.warn?.("dsh-model-hub: 模型目录拉取失败，使用空目录", error);
      return [];
    });

    const shim = await startShim({
      prepare: async () => ({
        baseUrl: upstreamBase(region),
        headers: { Authorization: `Bearer ${token}` },
      }),
      record: ({ metrics, statusCode, error, isStreaming }) => {
        if (db === undefined || settings.recordEnabled === false) return;
        try {
          insertRequest(db, {
            requestId: crypto.randomUUID(),
            channelId: PROVIDER_GLOBAL,
            provider: PROVIDER_GLOBAL,
            model: "unknown",
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
            cacheRead: metrics.cacheRead,
            cacheWrite: metrics.cacheWrite,
            ...(metrics.firstTokenMs === undefined ? {} : { firstTokenMs: metrics.firstTokenMs }),
            ...(metrics.upstreamHeadMs === undefined ? {} : { upstreamHeadMs: metrics.upstreamHeadMs }),
            ...(metrics.durationMs === undefined ? {} : { durationMs: metrics.durationMs }),
            ...(metrics.decodeTps === undefined ? {} : { decodeTps: metrics.decodeTps }),
            statusCode,
            ...(error === undefined ? {} : { error }),
            isStreaming,
            estimated: metrics.estimated,
            costUnits: 0,
            createdAt: Date.now(),
          });
        } catch (caught) {
          ctx.logger?.warn?.("dsh-model-hub: 记录写入失败（请求不受影响）", caught);
        }
      },
    });

    const adapter = new PiAiAdapter({
      profiles: () => new Map([[PROVIDER_GLOBAL, {
        provider: PROVIDER_GLOBAL,
        api: "openai-completions",
        baseUrl: shim.baseUrl(),
        apiKey: "shim",
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          input: m.supportsImages ? ["text", "image"] : ["text"],
        })),
      }]]),
      auth: { kind: "api-key" },
      resolveApiKey: async () => "shim",
    } as any);

    const release = ctx.llm.registerAdapter([PROVIDER_GLOBAL], adapter);
    ctx.effect(() => () => {
      release();
      shim.close();
      db?.close();
    }, "dsh-model-hub: teardown");

    registerRecordsRoute(ctx, {
      query: (limit: number) => ({
        requests: db?.prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT ?").all(limit) ?? [],
        rollups: db?.prepare("SELECT * FROM daily_rollups ORDER BY date DESC LIMIT 30").all() ?? [],
      }),
    });

    ctx.logger?.info?.(`dsh-model-hub: 已注册 ${PROVIDER_GLOBAL}，${models.length} 个模型，shim=${shim.baseUrl()}`);
  })();
}
```

- [ ] **步骤 4：构建**

运行：`npx tsdown`
预期：`lib/index.js` + `lib/index.d.ts` 生成，无报错

- [ ] **步骤 5：类型检查**

运行：`npx tsc -p tsconfig.json --noEmit`
预期：无错误

- [ ] **步骤 6：Commit**

```bash
git add -A && git commit -m "feat: 插件入口 + 记录路由 + WorkBuddy 渠道接线"
```

## 任务 7：装进 desktop profile 并验证

**文件：** 无（部署验证）

- [ ] **步骤 1：把包链进 profile**

运行：
```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\ds\DeepSeek Harness.exe' 'D:\ds\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs' add -w "file:D:\work_dir\dsh-model-hub"
```
工作目录：`%USERPROFILE%\.dsh\profiles\desktop`

- [ ] **步骤 2：确认 bundles 里有它**

读 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，确认 `dsh.profile.bundles` 含 `dsh-model-hub`。若没有，手工加进去。

- [ ] **步骤 3：dump config 验证**

运行：
```powershell
$env:ELECTRON_RUN_AS_NODE='1'; $env:DSH_DESKTOP_DEFAULT_PROFILE='desktop'
& 'D:\ds\DeepSeek Harness.exe' 'D:\ds\resources\app.asar\dsh\...' --dump-config
```
预期：输出里有 `# == dsh-model-hub` 段。

- [ ] **步骤 4：重启 DSH Desktop**

用 `_bin\dsh-restart-now.cmd` 或托盘重启。

- [ ] **步骤 5：验证记录真的落库**

1. 在模型选择器里选 `hub-workbuddy-global` 的任一模型
2. 发一句话
3. 查库：
```powershell
$env:ELECTRON_RUN_AS_NODE='1'
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.dsh/model-hub/hub.db');console.log(db.prepare('SELECT request_id,model,input_tokens,output_tokens,first_token_ms,duration_ms,decode_tps,status_code FROM requests ORDER BY created_at DESC LIMIT 3').all())"
```
预期：至少一行，`first_token_ms` / `decode_tps` 非空，`status_code=200`

- [ ] **步骤 6：Commit（若验证中有修正）**

```bash
git add -A && git commit -m "fix: 部署验证中发现的问题"
```

## 自检

**规格覆盖度：**

| 规格章节 | 对应任务 |
|---|---|
| §3 架构（单 shim + 多后端） | 任务 5、6 |
| §4 数据模型（4 张表） | 任务 2 |
| §5.1 计时点 | 任务 3 |
| §5.2 token 来源优先级 | 任务 3（usage → 估算） |
| §6.1 WorkBuddy | 任务 4 |
| §8 UI | **不在 P0**（P1/P2） |
| §9 错误处理 | 任务 5（埋点/DB 失败吞掉）、任务 6（目录失败用空目录） |
| §10 安全 | 任务 2（0600/0700）、任务 5（三重门） |

**已知缺口：** P0 不含客户端 UI，所以规格 §8 的槽位在 P0 无法验证；`model` 字段暂时记 `"unknown"`（shim 还没从请求体里解析模型名）—— 这是 P0 的已知简化，P1 补上。
