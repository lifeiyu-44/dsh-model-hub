# dsh-model-hub

把本机 **WorkBuddy（国际/国内）** 与 **Qoder CN** 的模型统一接进 [DeepSeek Harness](https://github.com/deepseek-ai)，带多账号池、凭据自动接管、请求记录与诊断。

> 面板内的「?」按钮里有同样的使用说明——不用翻这个文件也能用。

## 它能做什么

| 能力 | 说明 |
|---|---|
| **多平台接入** | WorkBuddy 25 个模型 + Qoder CN 10 个模型并列出现在 DSH 模型选择器里，id 带 `hub-` 前缀（`hub-workbuddy-global/…`、`hub-qoder-cn/…`） |
| **账号管理** | 面板内增删账号、启用/禁用、设为当前、单账号测试；同一账号按 uid 去重，绝不重复出现 |
| **多账号池** | 手动优先 + 故障切换（401/402/403/429/5xx 自动换下一个账号，上限 `min(池大小,3)`）+ 熔断（连续 3 次凭据类失败冷却 10 分钟） |
| **凭据自动接管** | WorkBuddy 桌面端加密登录态由插件**内置解密**（向 App 的 native binding 取密钥，AES-256-GCM 解信封）；Qoder 用 PAT 换 jobToken |
| **请求记录** | 每次上游尝试一行：token 数、TTFT、tok/s、状态码、**归属账号**；故障切换时失败那次与成功那次都可见 |
| **全功能界面化** | 记录保留清理、渠道展开模型清单、按账号的今日消耗、认证结果区、使用说明，全部在面板里 |

## 安装

```powershell
# 1) 构建 + 同步进 desktop profile + 临时 profile 真机启动验证
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1

# 2) 验证通过后真装进 desktop
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Install

# 3) 重启 DSH Desktop 生效
#    出问题回滚：
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Rollback
```

部署脚本会做四件事：构建（tsdown）→ 同步 `lib/` + `client.js` + `package.json` 到 profile（并维护依赖 junction）→ 在临时 profile 里真机启动、核对 `status.json` 与 shim 端口 → 把插件加进 profile 的 `bundles`。

> **注意**：`deploy.ps1` 必须以 UTF-8 **带 BOM** 保存——PowerShell 5.1 读无 BOM 的中文注释会解析失败。

## 面板说明

设置 → 插件 → **DSH Model Hub**。四个栏：

### 账号
每行一个账号：状态点（绿=可用 / 黄=停用 / 红=熔断）、显示名（真实身份：WorkBuddy 解密出的昵称、Qoder userinfo 真名）、「当前」标记、meta（有凭据 · **今日 N 次 · X tokens** · 熔断中 · 上次失败/成功）。

按钮：
- **开关**：启用/禁用（禁用即退出池）
- **测试**：真拉一次上游验活，成功解除熔断
- **设为当前**：决定池头，请求优先用它
- **删除**：软删（面板不再显示，**重启不复活**；凭据文件不受影响，但面板里无法恢复）

分组行上的 **+ 添加账号**：
- WorkBuddy：扫描 vault 导入（幂等，软删账号不复活）
- Qoder：贴 PAT（`pt-` 开头），备注名留空则用 userinfo 真名

### 渠道
每行一个渠道：开关（关 = 该渠道模型从选择器**彻底消失**，凭据保留）、今日计数、「展开 ▾」查看该渠道自己的模型清单（名称 · 倍率 · 活动/等级标记）。

### 记录
今日摘要 + 最近 4 条明细 + 「查看全部 →」开弹层。

弹层：统计条（请求数/Tokens/平均 TTFT/平均速度/积分）+ 筛选（渠道、模型、时间范围）+ **完整明细表（时间/渠道/账号/模型/in/out/cache/TTFT/tok·s/耗时/状态）** + 导出 CSV。

> 口径：`tok/s = output tokens ÷ 解码时长`（首 token 到达 → 流结束，不含 TTFT）；`TTFT` 从请求到达 shim 算起，含建连。拿不到上游 usage 的行会标 `*` 并置灰。

### 诊断
凭据路径、token 有效期、shim 地址、上游最近一次错误**原文**（不翻译不概括，方便整段贴给作者）、记录开关状态、保留天数、记录管理（「立即清理」按保留天数删过期明细 / 「清空全部」两连确认）。

## 多账号怎么加

### WorkBuddy（推荐：换号 + 一键认证）

1. 在 WorkBuddy 桌面端换登另一个账号
2. 面板点 **一键认证** —— 插件读桌面端加密登录态、用 App 自身取密钥解密、验活、按 uid 去重后**新增一行账号**
3. 原来的账号仍保留（token 存在 `%USERPROFILE%\.dsh\model-hub\workbuddy-tokens/`，0600）

同一个账号重复认证只会刷新那一行，不会重复出现。

### Qoder（贴 PAT）

面板「+ 添加账号」→ 贴 `pt-…`（到 <https://qoder.com.cn/account/integrations> 新建）→ 插件写 `model-hub/qoder-pats/<slug>.pat`（0600）→ 换 token 验活 → 入库 → 起 runtime。

### 切当前 / 故障切换

「设为当前」= 池头优先；请求失败（凭据类 4xx 或 5xx）自动换池里下一个账号重试，失败那次也记一行（account_id 是失败账号）。连续 3 次凭据类失败 → 熔断 10 分钟，到期自动解冻；全池冷却时仍按序兜底。

## 凭据从哪来（只读复用）

| 来源 | 读取方式 | 说明 |
|---|---|---|
| WorkBuddy 桌面端登录态 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` | `$wbEncrypted` 信封；插件以 `ELECTRON_RUN_AS_NODE` 跑 WorkBuddy App 自身、调 `loggerGet()` 取密钥，内存里解密 |
| 插件自有 token | `%USERPROFILE%\.dsh\model-hub\workbuddy-tokens\<sha256(uid)[:12]>.json` | 解密后的明文，0600；每账号一个文件 |
| dsh-connect-workbuddy vault | `%USERPROFILE%\.dsh\workbuddy-vault\<region>\<accountId>.json` | **只读**，历史来源 |
| Qoder PAT | `~/.dsh/qoder/pat`、`QODERCN_PAT` 等环境变量、`model-hub/qoder-pats/*.pat` | 面板贴的 PAT 落在自有目录 |

**安全边界**：插件数据库只存**凭据引用**（文件路径），绝不存明文；日志与报错统一隐去 token/PAT 全文（只保留文件路径与前 6 位）；桌面端 auth 文件与 vault 永不回写。写接口要求本机回环 + Origin 规则（网页来源必须回环，桌面壳/本地客户端放行）+ JSON content-type + body ≤64KB。

## 模型与思考档位

- WorkBuddy 目录不提供逐模型 reasoning 标记，但实测上游接受 `reasoning_effort` 参数 → **25 个模型统一声明支持**（不支持的模型上游忽略参数）
- Qoder 按目录 `is_reasoning` 如实声明
- 选中支持思考的模型后，DSH 输入框的模型选择器出现「思考强度」（off/minimal/low/medium/high），**按模型记忆**
- 非 hub 模型（如 zai-coding-cn）是否有档位，取决于其 provider 配置里是否声明 `reasoningEfforts`

## 配置项

插件设置（`Config`，全部 volatile，改完即生效）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关（装配期判定，关掉需重载插件退出） |
| `recordEnabled` | true | 是否记录请求（现读，关掉即停止写入） |
| `retentionDays` | 90 | 明细保留天数（启动清理 + 每 24h 清理；聚合永久保留） |

## 出问题看哪里

1. **诊断栏**：凭据路径、token 有效期、上游错误原文
2. **`%USERPROFILE%\.dsh\model-hub\status.json`**：`ok` / `modelCount` / 失败原因（部署自检也读它）
3. **账号行**：熔断中（至 HH:mm）/ 上次失败原因 / 测试按钮的 ✓✗
4. 常见写接口错误：`origin_not_allowed` / `host_not_allowed` = 非本机请求；`bad_request` = 参数不对；`payload_too_large` = body 超 64KB

### 已知限制

- WorkBuddy 渠道校验是军备竞赛（上游随时可能收紧）
- 目录拉取失败时渠道保持「无 runtime」，由下一次写操作/重启重试
- 5xx 触发的请求内换号对非幂等上游有重复副作用的理论可能（上限 min(池,3)）
- 记录明细上限 2000 行（弹层全部显示靠表格滚动）

## 开发

```bash
pnpm build      # tsdown：lib/ + client.js（client-load 测试吃产物，改客户端必须先 build）
pnpm test       # vitest（36 文件 / 285 用例）
pnpm typecheck  # tsc --noEmit
```

结构：

```
src/
  index.ts                 # 装配层：开库 → HubState → 两渠道 ensureRuntime → 数据/写路由 → 保留清理
  state/hub-state.ts       # 状态中心：写操作编排、池与 runtime 同步
  state/runtime.ts         # 渠道 runtime：shim + provider 注册/重注册（热注册）
  state/selector.ts        # 选号纯逻辑（手动优先/熔断/兜底）
  probe/prober.ts          # 一键认证 / 单账号测试 / 贴 PAT
  routes/data.ts           # 只读路由（summary/catalog/records/channels/diag）
  routes/write.ts          # 写路由（九条操作 + 门禁 + 分发器）
  store/                   # SQLite：schema、mutations（写侧）、queries（读侧）、retention、seed
  shim/server.ts           # 本机回环 shim：唯一埋点处 + 请求内换号重试
  channels/workbuddy/      # 凭据发现、vault 多账号、at-rest 内置解密、token-store、目录
  channels/qoder/          # PAT→jobToken、COSY 签名、目录、对话方言（请求编码 + 双层 SSE）
  client/                  # 面板：HubCard（四栏）、RecordsModal、AddAccountModal、HelpModal、ModelLabel
docs/superpowers/          # 设计规格与实现计划
tests/                     # 285 用例（含真实上游 live 用例，网络不通时会红）
```

## 许可

MIT
