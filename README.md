# dsh-model-hub

把本机 **WorkBuddy（国际/国内）**、**Trae（SOLO / SOLO CN）** 与 **Qoder CN** 的模型统一接进 [DeepSeek Harness](https://github.com/deepseek-ai)，带多账号池、凭据自动接管、请求记录与诊断。

> 面板内的「?」按钮里有同样的使用说明——不用翻这个文件也能用。

## 它能做什么

| 能力 | 说明 |
|---|---|
| **多平台接入** | WorkBuddy 25 个模型 + Trae 15 个模型 + Qoder CN 10 个模型并列出现在 DSH 模型选择器里，id 带 `hub-` 前缀（`hub-workbuddy-global/…`、`hub-trae/…`、`hub-qoder-cn/…`） |
| **账号管理** | 面板内增删账号、启用/禁用、设为当前、单账号测试；同一账号按 uid 去重，绝不重复出现 |
| **多账号池** | 手动优先 + 故障切换（401/402/403/429/5xx 自动换下一个账号，上限 `min(池大小,3)`）+ 熔断（连续 3 次凭据类失败冷却 10 分钟） |
| **凭据自动接管** | WorkBuddy 桌面端加密登录态由插件**内置解密**（向 App 的 native binding 取密钥，AES-256-GCM 解信封）；Trae 登录态同样是**内置解密**（byteCrypto 信封，纯算法）；Qoder 用 PAT 换 jobToken |
| **请求记录** | 每次上游尝试一行：token 数、TTFT、tok/s、状态码、**归属账号**；故障切换时失败那次与成功那次都可见 |
| **全功能界面化** | 记录保留清理、渠道展开模型清单、按账号的今日消耗、认证结果区、使用说明，全部在面板里 |

## 安装

### 从 GitHub 装（普通用户）

构建产物（`lib/`、`client.js`）已随仓库提交，装完即可用，不需要本地构建：

```powershell
dsh plugin add github:lifeiyu-44/dsh-model-hub
```

也可以在 GUI 里：侧边栏 **插件** → 添加插件 → 粘贴 `github:lifeiyu-44/dsh-model-hub`。

指定版本（tag）安装：

```powershell
dsh plugin add github:lifeiyu-44/dsh-model-hub#v0.2.0
```

装完重启 DSH，到 **设置 → 插件 → DSH Model Hub** 配置账号。

> 前置条件：Node.js `^22.19.0 || >=24`，以及 DSH 本体（插件通过 `peerDependencies` 使用宿主的 `@deepseek-ai/dsh-*` 包，不会重复安装）。

### 从源码开发（贡献者）

```powershell
git clone https://github.com/lifeiyu-44/dsh-model-hub
cd dsh-model-hub
pnpm install
pnpm build     # tsdown：产出 lib/ 与 client.js
pnpm test
```

然后按下面「本地部署」把它挂进 profile。

### 本地部署（改完源码后生效）

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

### Trae（装好客户端就行）

1. 在 **Trae SOLO / SOLO CN** 里登录（国际版、国内版都认）
2. 回面板「+ 添加账号」点 **扫描本机 Trae 导入**（DSH 启动时也会自动接管一次）
3. 插件解密 `storage.json` 里的登录态 → 写 `model-hub/trae-tokens/<uid>.json`（0600）→ 按 uid 去重登记

换号：在 Trae 里退出重登，再点一次导入 —— 新账号会多一行，老账号保留。
token 过期（约 14 天）：Trae 里重登一次，再点导入即可；过期时上游会拒，面板的「测试」会直接把这句话打出来。

> 模型 id 支持 `模型@function` 语法（如 `gpt-5.4@solo_coder`）。默认 function 是 `solo_agent_lite`——
> 实测它接受全部 15 个预置模型；`solo_work_lite` 的模型表与服务端注册表不一致，不要用它选模型。

工具调用也是通的：请求里的 `tools` 会透传（`parameters` 自动字符串化成 Trae 要的形状），上游回的
`function_call` 分片翻成 OpenAI `tool_calls`，并把 Trae 的 `finish_reason:"stop"` 改写成 `tool_calls`
（不改写宿主就不会执行工具）。历史里的 tool_calls 同样转成 Trae 认的 `function_call` 形状。

思考档位：15 个模型都声明支持，档位（minimal/low/medium/high）原样进 `reasoning_effort`；
「滑动变阻器」皮肤在 Trae 模型上会出滑块，拖到 Low/High 都会即时提交并随下一条请求发出去。

### 切当前 / 故障切换

「设为当前」= 池头优先；请求失败（凭据类 4xx 或 5xx）自动换池里下一个账号重试，失败那次也记一行（account_id 是失败账号）。连续 3 次凭据类失败 → 熔断 10 分钟，到期自动解冻；全池冷却时仍按序兜底。

## 凭据从哪来（只读复用）

| 来源 | 读取方式 | 说明 |
|---|---|---|
| WorkBuddy 桌面端登录态 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` | `$wbEncrypted` 信封；插件以 `ELECTRON_RUN_AS_NODE` 跑 WorkBuddy App 自身、调 `loggerGet()` 取密钥，内存里解密 |
| 插件自有 token | `%USERPROFILE%\.dsh\model-hub\workbuddy-tokens\<sha256(uid)[:12]>.json` | 解密后的明文，0600；每账号一个文件 |
| dsh-connect-workbuddy vault | `%USERPROFILE%\.dsh\workbuddy-vault\<region>\<accountId>.json` | **只读**，历史来源 |
| Trae 登录态 | `%APPDATA%\TRAE SOLO\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide` | byteCrypto AES 信封，插件内置解密；只读，永不回写 |
| Trae 自有 token | `~/.dsh/model-hub/trae-tokens/<sha256(uid)[:12]>.json` | 解密后的明文快照，0600；每账号一个文件 |
| Qoder PAT | `~/.dsh/qoder/pat`、`QODERCN_PAT` 等环境变量、`model-hub/qoder-pats/*.pat` | 面板贴的 PAT 落在自有目录 |

**安全边界**：插件数据库只存**凭据引用**（文件路径），绝不存明文；日志与报错统一隐去 token/PAT 全文（只保留文件路径与前 6 位）；桌面端 auth 文件与 vault 永不回写。写接口要求本机回环 + Origin 规则（网页来源必须回环，桌面壳/本地客户端放行）+ JSON content-type + body ≤64KB。

## 模型与思考档位

- WorkBuddy 目录不提供逐模型 reasoning 标记，但实测上游接受 `reasoning_effort` 参数 → **25 个模型统一声明支持**（不支持的模型上游忽略参数）
- Qoder 按目录 `is_reasoning` 如实声明
- Trae 的 15 个预置模型都是 `reasoning_model`（或目录标了 `features.reasoning.enable`）→ **统一声明支持**；`reasoning_effort` 原样进请求体（实测 low/medium/high/minimal/off/none 全 200）。配合「滑动变阻器」皮肤（`dsh-client-liang-intensity-skin`）时，模型目录里每个 Trae 模型带 4 档 effort（minimal/low/medium/high），默认档 high，滑块可直接调
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
5. Trae 报 `4120`：看诊断栏的 build 版本号 —— 显示「内置兜底」说明没读到 `resources/app/product.json`，把 `TRAE_HOME` 指向 Trae 安装目录后重启

### 已知限制

- WorkBuddy 渠道校验是军备竞赛（上游随时可能收紧）
- 目录拉取失败时渠道保持「无 runtime」，由下一次写操作/重启重试
- 5xx 触发的请求内换号对非幂等上游有重复副作用的理论可能（上限 min(池,3)）
- 记录明细上限 2000 行（弹层全部显示靠表格滚动）
- Trae 没有可读的倍率接口（国际版 `/api/ide/v1/batch_get_detail_param` 是 404），模型名后不带 `x…` 倍率
- Trae 的模型清单来自本机 `state.vscdb` 缓存：客户端没登录过时只能退回内置名单（15 个预置模型）

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
  channels/trae/           # byteCrypto 解密、本机登录态发现、目录（state.vscdb）、对话方言（event/data 分行 → OpenAI SSE）
  client/                  # 面板：HubCard（四栏）、RecordsModal、AddAccountModal、HelpModal、ModelLabel
docs/superpowers/          # 设计规格与实现计划
tests/                     # 336 用例（含真实上游 live 用例，网络不通时会红）
```

## 反馈

- **邮箱：2738769924@qq.com** —— 附上诊断栏里的错误原文、DSH 版本、插件版本；不要贴 token / PAT 全文
- Issue：<https://github.com/lifeiyu-44/dsh-model-hub/issues>

Trae 报 `4120` 时请一并说明：Trae 客户端版本（设置里能看到）、是否设置过 `TRAE_HOME`、以及诊断栏显示的「build 版本号」——
这三项能直接区分「版本号用了内置兜底」还是「升级后版本对不上」。

## 许可

MIT
