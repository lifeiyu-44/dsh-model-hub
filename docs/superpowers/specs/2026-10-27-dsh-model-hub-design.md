# dsh-model-hub 设计规格

> 日期：2026-10-27 · 状态：待审查 · 作者：fuqinghe

## 1. 目标

把本机三个 AI 编程平台（WorkBuddy、ZCode、Qoder CN）的模型统一接进 DeepSeek Harness，提供：

1. **多平台接入** —— 三个平台的模型并列出现在 DSH 模型选择器里，选谁就是谁
2. **账号管理** —— 多账号增删改、启停、切换当前；凭据只读复用，不落明文
3. **请求记录** —— 每一次模型调用一行记录：token 数、首 token 时间（TTFT）、解码速度（tok/s）、状态码、积分消耗
4. **一键认证** —— 一次点击完成「探测本机凭据 → 接管 → 报缺」

**非目标**（明确不做）：通用 HTTP 代理模式、跨机器同步、自动签到、修改 DSH 自带 DeepSeek provider 的行为。

## 2. 术语

- **渠道（channel）** —— 一个上游服务的接入单元。WorkBuddy 分国内/国际两个渠道，ZCode 的每个 provider 是一个渠道，Qoder CN 是一个渠道。
- **账号（account）** —— 渠道下的一份凭据。WorkBuddy 可多账号，ZCode/Qoder 单账号。
- **shim** —— 插件自己起的本机回环 HTTP 服务，所有渠道流量都经它转发，埋点只在这里做。

## 3. 架构

```
DSH LlmService
  └─ 一个 PiAiAdapter（所有 provider 共用）
       └─ 一个 loopback shim（OpenAI 兼容，127.0.0.1:<随机端口> + 随机 Bearer）
            ├─ 记录中间件（唯一埋点处）
            └─ 渠道后端（给出 baseUrl + headers + 模型列表）
                 ├─ workbuddy-cn / workbuddy-global
                 ├─ zcode:<providerId>  ×5
                 └─ qoder-cn
```

### 3.1 为什么是「单 shim + 多后端」而不是「每渠道一个 adapter」

`dsh-connect` 0.2.0 的做法是每个渠道一个 `PiAiAdapter` 加一个 shim，三份重复。本设计反过来：埋点、鉴权、限流、重试集中在 shim 一处，新增渠道只需实现一个「后端解析器」（三个函数：`listModels()` / `buildRequest()` / `parseUsage()`）。ZCode 的 5 个 provider 几乎就是纯配置。

### 3.2 provider 命名

全部加 `hub-` 前缀，与现有 `dsh-connect-workbuddy`（占用 `workbuddy` / `workbuddy-global`）共存，避免 `DUPLICATE_ADAPTER`：

| provider id | 渠道 |
|---|---|
| `hub-workbuddy-global` | WorkBuddy 国际版 |
| `hub-workbuddy-cn` | WorkBuddy 国内版 |
| `hub-zcode-<slug>` | ZCode 的一个 provider（slug 由 providerId 派生，见下） |
| `hub-qoder-cn` | Qoder CN |

**为什么用连字符而不是冒号**：ZCode 的 `providerId` 本身就可能含冒号（实测有 `account:bigmodel-individual-coding-plan`），拼成 `hub:zcode:account:...` 会有四层冒号，可读性差且难以在 UI 里拆。统一用连字符，slug 规则：把 providerId 里的 `:` 和 `.` 替换成 `-`，去掉非 `[a-z0-9-]` 字符，截断到 32 字符；冲突时追加 `-2`、`-3`。

例：`904c0249-e62a-4386-a9cc-c658b28992e9` → `hub-zcode-904c0249-e62a-4386-a9cc-c65`；`account:bigmodel-individual-coding-plan` → `hub-zcode-account-bigmodel-individual`。

DSH 侧只校验 provider 名非空（`prepareRoutes` 里 `provider.length === 0` 才拒），不含字符白名单，所以连字符与冒号都能用。

## 4. 数据模型

SQLite（`node:sqlite`，Node 24 内置，已实测本机可用，无需原生编译）。库文件：`$DSH_HOME/model-hub/hub.db`，WAL 模式。

### 4.1 channels

```sql
CREATE TABLE channels (
  id            TEXT PRIMARY KEY,   -- hub-workbuddy-global
  kind          TEXT NOT NULL,      -- workbuddy | zcode | qoder
  display_name  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  config        TEXT NOT NULL DEFAULT '{}'  -- JSON: baseUrl / apiType / modelOrder
);
```

### 4.2 accounts

```sql
CREATE TABLE accounts (
  id                     TEXT PRIMARY KEY,
  channel_id             TEXT NOT NULL REFERENCES channels(id),
  display_name           TEXT NOT NULL,
  credential_ref         TEXT,      -- 只存引用（文件路径 + 键名），绝不存明文
  enabled                INTEGER NOT NULL DEFAULT 1,
  is_current             INTEGER NOT NULL DEFAULT 0,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  last_ok_at             INTEGER,
  created_at             INTEGER NOT NULL
);
```

### 4.3 requests

```sql
CREATE TABLE requests (
  request_id      TEXT PRIMARY KEY,
  session_id      TEXT,
  channel_id      TEXT NOT NULL,
  account_id      TEXT,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cache_write     INTEGER NOT NULL DEFAULT 0,
  first_token_ms  INTEGER,          -- TTFT = t2 - t0
  upstream_head_ms INTEGER,         -- t1 - t0：建连+上游首字节，区分「网络慢」还是「模型慢」
  duration_ms     INTEGER,
  decode_tps      REAL,             -- output_tokens / decode 秒数
  status_code     INTEGER,
  error           TEXT,
  is_streaming    INTEGER NOT NULL DEFAULT 0,
  estimated       INTEGER NOT NULL DEFAULT 0,  -- token 数为本地估算
  cost_units      REAL NOT NULL DEFAULT 0,     -- 积分 / Credits
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_requests_created ON requests(created_at DESC);
CREATE INDEX idx_requests_channel ON requests(channel_id, created_at DESC);
```

### 4.4 daily_rollups

```sql
CREATE TABLE daily_rollups (
  date          TEXT NOT NULL,      -- YYYY-MM-DD（本地时区）
  channel_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  account_id    TEXT NOT NULL DEFAULT '',
  req_count     INTEGER NOT NULL DEFAULT 0,
  ok_count      INTEGER NOT NULL DEFAULT 0,
  tokens        INTEGER NOT NULL DEFAULT 0,
  cost_units    REAL NOT NULL DEFAULT 0,
  avg_ttft_ms   INTEGER NOT NULL DEFAULT 0,
  ttft_n        INTEGER NOT NULL DEFAULT 0,   -- avg_ttft_ms 的样本数
  avg_tps       REAL NOT NULL DEFAULT 0,
  tps_n         INTEGER NOT NULL DEFAULT 0,   -- avg_tps 的样本数
  PRIMARY KEY (date, channel_id, model, account_id)
);
```

写入策略：每请求写 `requests` 一行；`daily_rollups` 用 UPSERT 增量累加，不重扫明细。明细保留 90 天，聚合永久保留。

聚合口径（UPSERT 时必须一次算对，不能事后补算）：

- `req_count += 1`
- `ok_count += (status_code BETWEEN 200 AND 299) ? 1 : 0`
- `tokens += input_tokens + output_tokens`
- `cost_units += cost_units`
- `avg_ttft_ms` / `avg_tps` 存**加权均值**：`(旧均值 × 旧 n + 新值) / (旧 n + 1)`，各自的 n 分别是 `ttft_n` / `tps_n`
- `first_token_ms` 为 NULL 的行：`ttft_n` 与 `avg_ttft_ms` 都不动，只加其余计数
- `decode_tps` 为 NULL 的行：`tps_n` 与 `avg_tps` 都不动，只加其余计数

## 5. 埋点

### 5.1 计时点

```
t0 = 请求到达 shim
t1 = 上游响应头到达
t2 = 上游首个非空 delta 到达     → TTFT   = t2 - t0
t3 = 上游流结束 + usage 汇总     → duration = t3 - t0
                                → decode_tps = output_tokens / ((t3 - t2) / 1000)
```

TTFT 用 `t2 - t0`（含建连与上游首字节），另记 `t1 - t0` 到 `requests.upstream_head_ms`，以便区分「网络慢」还是「模型慢」。非流式请求 `t2` 即 `t3`，`decode_tps` 置 NULL。

### 5.2 token 数来源（优先级）

1. 上游响应的 `usage` 字段（OpenAI 兼容的 `prompt_tokens` / `completion_tokens`，Anthropic 的 `input_tokens` / `output_tokens`）
2. 上游响应头（`x-ratelimit-*` 之类，若提供）
3. 本地估算：`字符数 / 4`，并置 `estimated = 1`

**不猜测**：拿不到就记 0 + `estimated = 1`，面板上明确标出来。

### 5.3 全局兜底埋点

除 shim 之外，另注册 `ctx.waterfall('llm/stream', ...)`，包住**所有** provider 的流（含 DSH 自带的 DeepSeek 官方）。这层：

- 只读不写：不改 `options`，透传返回的流对象
- 记录 `channel_id = 'external-' + provider`，用于统计「不属于本插件的调用」。这类行**不写入 `channels` 表**，只出现在 `requests` / `daily_rollups` 里；面板把它们归到「外部」分组，不参与账号切换与熔断。
- 异常隔离：埋点抛错不得影响主流程，全部 `try/catch` 吞掉并记 warn

## 6. 三平台接入

### 6.1 WorkBuddy

| 项 | 值 |
|---|---|
| 凭据 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info`（国际）/ `workbuddy-desktop.info`（国内） |
| 加密 | `accessToken` / `refreshToken` 为 `{"$wbEncrypted":1,"envelope":"…"}` AES-256-GCM 信封 |
| 解密 | 不内置密钥；用 `ELECTRON_RUN_AS_NODE` 调 App 自身 native binding（`loggerGet()`）就地派生，密钥只在内存 |
| 上游 | 国际 `https://www.workbuddy.ai/v2/chat/completions`；国内 `https://copilot.tencent.com/v2/chat/completions` |
| 模型目录 | `/v3/config`，**必须用桌面端 UA**（`WorkBuddy/<ver>`）；CLI UA 只给 35 个模型且缺促销字段 |
| 积分 | `https://www.codebuddy.cn/v2/billing/meter/get-user-resource`（只读） |

**渠道校验回落**：上游 11128（"不是官方客户端"）时按需在提示词句读处插入 U+200B 再重发；一旦被拒立即清标志回落到原样。不把绕过写成唯一路径。

### 6.2 ZCode

ZCode **不是登录态复用，是配置导入**。它不起任何监听端口（已核实 32 个进程无监听），所以拿不到它的流量。

| 项 | 值 |
|---|---|
| 配置源 | `~/.zcode/v2/provider_config.json` 的 `providerConfigRules.providerRules[]` |
| 每个 provider 带 | `providerId` / `providerName` / `config.access.apiKey` / `config.api.baseUrl` / `config.api.type` / `modelOrder` |
| 实测 5 个 | `904c0249-…`(glemon, anthropic) · `deepseek` · `qwen-alibaba-model-studio-cn` · `new-provider`(Strata) · `account:bigmodel-individual-coding-plan`(OAuth) |
| OAuth 路线 | `~/.zcode/v2/credentials.json` 的 `oauth:bigmodel:access_token` |

**导入策略**：只存引用（文件路径 + providerId），运行时现读。**绝不复制 apiKey 到本插件库里** —— 那是明文，复制一份等于多一处泄漏面。

### 6.3 Qoder CN

| 项 | 值 |
|---|---|
| 凭据 | `$DSH_HOME/connect-auth/qoder.pat`（PAT，`pt-` 开头）或 `qoder-session.json`，或环境变量 `QODERCN_PAT` |
| 签名 | COSY 签名，`Cosy-ClientType: 10`（用 5 会稳定返回空活动） |
| 模型目录 | `GET /api/v2/model/list?Encode=1` |
| 每日额度 | 100 Credits，每日 10:00 UTC+8 刷新，30 天有效 |
| 领取 | `POST /sash/api/v1/me/campaigns/<campaignId>/claim` |

## 7. 一键认证

点一下 → 依次探测 → 汇总结果：

| 渠道 | 探测顺序 | 成功条件 | 失败提示 |
|---|---|---|---|
| WorkBuddy | 4 个默认 auth 路径 → 环境变量 `WORKBUDDY_AUTH_FILE` | 解出有效 token 且未过期 | 明确说缺什么（文件不存在 / 字段加密但拿不到密钥 / 属于另一个地区） |
| ZCode | `provider_config.json` → `credentials.json` | 至少一个 provider 有 apiKey 或 OAuth token | 提示 ZCode 未安装或未配置 |
| Qoder | `qoder.pat` → `qoder-session.json` → 环境变量 | PAT 有效或 session 未过期 | 给 `https://qoder.com.cn/account/integrations` 建 PAT 的指引 |

**不静默成功**：每个渠道单独报告「接管了什么 / 缺什么」，失败不阻断其他渠道。

## 8. UI

### 8.1 设置卡片（四栏）

- **账号** —— 按渠道分组，每行显示名称、状态点、今日用量；操作：启用/禁用、设为当前、删除
- **渠道** —— 各渠道开关、baseUrl、模型勾选
- **记录** —— 最近 20 条，点「查看全部」开侧边栏
- **诊断** —— 只读事实表：当前渠道/账号、凭据路径、最近错误原文（不翻译不概括）

### 8.2 侧边栏「请求记录」

明细表（时间 / 渠道 / 模型 / in-out token / TTFT / tok/s / 状态）+ 按天聚合图 + 筛选（渠道、模型、时间范围）+ CSV 导出。

### 8.3 输入框下方实时胶囊

`WB-Global · 42 tok/s · 1.2k out`，本回合流式期间实时更新，回合结束冻结。挂 `conversation.composer.dock`，`scope: 'session'`。

## 9. 错误处理

| 场景 | 处理 |
|---|---|
| 凭据缺失/过期 | 该渠道标 `signed-out`，模型不出现在选择器里（避免点了就 401） |
| 上游 401/402/429 | 记 `requests` 一行；`consecutive_failures +1`；达到 3 次标该账号不可用 |
| 上游 400 | 不换号、不计入熔断（请求本身不合法） |
| 上游 5xx / 网络错误 | 记一行；可换号重试（P2） |
| 流中断 | 记 `duration_ms` 与已收 token，标 `error`；**不重试**（字节已发出） |
| 埋点自身抛错 | 吞掉 + warn，绝不影响主请求 |
| DB 写失败 | 吞掉 + warn，请求照常返回（观测不能拖垮主链路） |

## 10. 安全

- **凭据**：本插件库文件 0600；别人的凭据文件只读，永不回写；日志全量脱敏（token / Bearer / `sk-` / `pt-` 形态）
- **路由鉴权**：DSH 插件路由无独立鉴权，本机任意进程可访问。所有写接口（改凭据、删账号、改配置）强制 loopback + Origin 双校验
- **ZCode key**：不复制，只存引用
- **shim**：`listen(0, '127.0.0.1')`，进程内随机 Bearer，`timingSafeEqual` 常数时间比对，校验 Host/Origin 必须是回环
- **插件与 Agent 同权限**：这是本机现状，不是本插件引入的；但本插件处理的凭据种类多，代码里每个落点都要有注释说明

## 11. 测试

- **单元**（vitest）：token 估算、SSE 解析、usage 归一化（OpenAI / Anthropic 两种形状）、TTFT 计算、熔断状态机
- **集成**：起一个 mock 上游，跑完整 shim 链路，断言 `requests` 表内容正确
- **真实联调**：三个渠道各跑一次真实请求（用本机已有凭据），核对记录与官方客户端显示一致
- **回归锚点**：`daily_rollups` 累加必须与 `requests` 明细重算结果逐字段相等

## 12. 分期

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0** | 插件骨架 + SQLite + shim + 记录中间件 + **三个渠道全接**（WorkBuddy 2 个 provider、ZCode 5 个 provider、Qoder 1 个） | `--dump-config` 能看到全部 provider；三个渠道各跑一次真实请求，`requests` 各有一行且 token/速度字段非空 |
| **P1** | 账号管理 UI + 一键认证（三形态）+ 渠道/模型勾选 | 卡片里能增删改账号、切当前；一键认证能报出各渠道「接管了什么 / 缺什么」 |
| **P2** | 记录面板 + CSV 导出 + 实时胶囊 + 熔断换号 | 面板数据与 DB 一致；胶囊在流式期间实时更新 |

**为什么 P0 就接全三个渠道**：shim 与记录层一旦定型，后加渠道只是填后端解析器；反过来先只做 WorkBuddy、后面再改 shim 的抽象，返工成本更高。且三个渠道的凭据本机都已具备（WorkBuddy 已登录、ZCode 配置齐全、Qoder 有 PAT），可以一次性验证。

## 13. 已知风险

1. **WorkBuddy 渠道校验是军备竞赛**，上游随时可能收紧，插件可能失效（作者自己在 README 顶部就写了这条）
2. **ZCode 配置格式是逆向的**，升级可能改结构，导入逻辑要 fail-soft
3. **Qoder COSY 签名同理**
4. **DSH 0.2.1-rc.3 的 `llm/stream` waterfall 契约**目前是从代码读出来的，若宿主升级改签名，全局兜底层会失效（不影响主链路）
5. **本机 desktop profile 已有 `dsh-connect-workbuddy`**，两者共存时模型选择器里会有两套 WorkBuddy 模型，需要用户自行区分（前缀 `hub-` 可辨）
