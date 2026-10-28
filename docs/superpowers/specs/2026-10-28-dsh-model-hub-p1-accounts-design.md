# dsh-model-hub P1 设计规格：账号生命周期 + 多账号池

> 日期：2026-10-28 · 状态：已批准（用户逐项拍板） · 前置：`2026-10-27-dsh-model-hub-design.md`（总规格）
>
> 本文把总规格里留给 P1 的「账号管理 + 一键认证」具体化，并新增用户追加的
> 「同平台多账号管理 + 多账号池自动切换/共享」需求。

## 0. 背景与现状（2026-10-28 核实）

P0 已交付：WorkBuddy Global / Qoder CN 两渠道经 shim 真实可对话，面板四栏
（账号/渠道/记录/诊断）与记录弹层可用，git 至 `18ea1fe`。

面板 `HubCard.ts` 里六个控件是 `disabled + title="后端接口还没做"` 的占位：

- 一键认证、+ 添加账号、账号启停开关、测试、删除、渠道开关

后端只有只读路由（`GET ${DATA_PREFIX}/*`，回环校验）。账号表由启动时 seed 写入
（每渠道一条 `:default`），`requests.account_id` 当前恒为空。

另两处与「界面化」相关的现状（2026-10-28 核实）：`retentionDays` 只有 config 声明、
**无任何执行代码**；`recordEnabled` 已在写入侧生效且可经宿主插件设置修改，但面板不显示状态。

## 1. 目标

1. **解禁六个控件** —— 每个都有真实后端语义与可见反馈
2. **同平台多账号** —— WorkBuddy 扫 vault 多账号导入；Qoder 多 PAT 并存
3. **多账号池自动切换** —— 手动优先 + 故障切换 + 熔断，池内账号共享请求负载
4. **热生效** —— 认证/添加/启停全程不重启 DSH；新渠道不重启即可出现
5. **全功能界面化**（2026-10-28 追加拍板）—— 不留任何要改文件/敲命令才能用的能力：
   记录保留清理做真并给按钮、渠道行展开模型清单、诊断栏显示记录开关状态

**非目标**：按剩余额度选号（需要余额查询，后置）；跨渠道故障转移；跨机器同步；
自动签到；修改 dsh-connect-workbuddy 自己的任何文件。

## 2. 已拍板的决策（2026-10-28 用户点选）

| 拍板点 | 结论 |
|---|---|
| 实现范围 | 全部 6 个控件 + 多账号池 |
| 「添加账号」语义 | 真多账号：WorkBuddy 扫 vault 导入；Qoder 弹窗贴 PAT 写到我们自己的目录 |
| 选号策略 | 手动优先 + 故障切换（当前账号优先，失败才轮到下一个） |
| 生效方式 | 热注册，不重启 |
| 实现路线 | 方案 A：状态中心（HubState 统一驱动，拒绝重建式与补丁式） |

## 3. 架构：HubState 状态中心

```
写路由（HTTP POST）──▶ HubState ──▶ SQLite（channels/accounts 持久态）
                        │  └────▶ runtime 注册表（内存：shim / adapter release / sessions）
shim prepare() ────────▶ selector.pick(channelId)   ← 每次请求选账号
shim 上游回包 ─────────▶ selector.report(ok|fail)    ← 喂熔断状态
一键认证 / 测试 ───────▶ prober ──▶ upsert 账号 ──▶ ensureChannelRuntime
```

- `src/state/hub-state.ts` —— 唯一事实源；写操作经单一 Promise 队列串行；
  selector 读走内存快照，无锁（单线程事件循环内一致性足够）
- `src/state/selector.ts` —— 选号纯逻辑，不碰 IO，可独立单测
- `src/state/runtime.ts` —— 每渠道 runtime 句柄与热注册/释放
- `src/routes/write.ts` —— 写路由（门禁 + 分发到 HubState）
- `src/probe/prober.ts` —— 一键认证与单账号测试的探测实现
- `index.ts` 瘦身为装配层

## 4. 数据模型（schema v1 → v2）

`user_version` 迁移追加两列（老库无损）：

```sql
ALTER TABLE accounts ADD COLUMN deleted        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN cooldown_until INTEGER;
```

配套规则：

- **软删防复活**：seed 与 vault/PAT 扫描器对 `deleted=1` 的同 id 行一律跳过；
  删除账号不级联删 `requests`（历史保留）
- `is_current` 渠道内唯一：写操作事务内
  `UPDATE accounts SET is_current = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE channel_id = ?`
- `queryAccounts` 加 `WHERE deleted = 0`，投影补 `cooldown_until`（UI 显示「熔断中」）
- 凭据仍只存引用：WorkBuddy = vault 文件路径；Qoder = PAT 文件路径或 `env:*`

## 5. 写路由与安全

全部 `kind:"exact"`（不依赖宿主未验证的参数路由能力）：

| 方法+路径 | body | 语义 |
|---|---|---|
| `POST .../channel/:id/toggle` | `{enabled}` | 渠道开关 |
| `POST .../account/:id/toggle` | `{enabled}` | 账号启停 |
| `POST .../account/:id/test` | — | 单账号探活 |
| `POST .../account/:id/make-current` | — | 设为当前 |
| `POST .../account/:id/delete` | — | 软删 |
| `POST .../accounts/add` | WorkBuddy：`{channelId}`；Qoder：`{channelId, pat, displayName?}` | 添加账号 |
| `POST .../auth/one-click` | — | 一键认证，返回逐渠道报告 |
| `POST .../records/prune` | `{days?}`（缺省用 config.retentionDays） | 按保留天数删过期明细，返回删除行数 |
| `POST .../records/clear` | — | 清空全部明细与聚合（前端二次确认后调用） |

（前缀同只读路由 `/plugins/dsh-model-hub`；表格里 `...` 即该前缀。）

写接口门禁：Host 回环 + **Origin 回环**（浏览器 POST 必带 Origin，缺失/非回环即 403）
+ `content-type: application/json` + body ≤ 64KB。PAT 等敏感值不写日志（沿用现有脱敏）。
路由注册整体 try/catch：只废面板，绝不拖垮宿主（本项目最痛教训）。

## 6. 账号选择器与故障切换

**池** = 渠道下 `deleted=0 && enabled=1 && 有凭据` 的账号，序：
`is_current DESC, last_ok_at DESC NULLS LAST, created_at ASC`。

- **手动优先**：取池头；用户「设为当前」改变池序，不自动晋升（成功不换头）
- **请求内故障切换**：shim 拿到上游**非 2xx 且尚未向客户端发出任何字节**时，
  换池中下一账号重试；尝试上限 `min(池大小, 3)`
  - 换号条件：401/402/403/429（凭据/额度类）；5xx 与网络错误也换号但**不计熔断**
  - 400 不换号不熔断（请求本身不合法，换谁都被拒）
- **熔断**：凭据类失败连续 3 次 → `cooldown_until = now + 10min`，池内跳过；
  到期自动解冻；**全池冷却时仍按序兜底尝试**（渠道不能整体装死）
- **流中失败**（Qoder 错误藏在 200 流内）：响应头已发出，不重试；
  只记失败（`statusCode=502` 口径与现状一致），下个请求自然换号
- **记账**：每次上游尝试各写一行 `requests`，补真实 `account_id`
- shim 接口扩展：`prepare()` 返回值增加可选 `account`（内部句柄），
  透传给 `dialect.request()` 与 `record()`——Qoder 方言签名与记录归账号都靠它；
  字段可选，旧渠道零改动

`make-current` / `toggle` / `delete` 若使渠道「可用账号数 0 ↔ >0」翻转，
runtime 层同步 release / 重注册 adapter（模型从选择器消失或恢复；shim 不动）。

已接受风险：5xx 触发的请求内换号对非幂等上游有重复副作用的理论可能（上限
`min(池,3)`、客户端只收一次响应），终审裁定接受。

## 7. 热注册与一键认证

**ensureChannelRuntime(channelId)**（幂等）：建 shim（prepare 绑 selector）→
用任一可用账号拉目录 → registerProvider → 更新诊断。启动时缺凭据未注册的渠道，
后续添加凭据走同一条路，**不重启即出模型**。

渠道开关 = 仅 release / 重注册 adapter（端口不变、在飞请求不受影响）。

**一键认证**（总规格 §7，ZCode 已移除，剩两渠道）：

- WorkBuddy：4 个 auth 路径 + vault 全部条目逐个探测，
  每来源报告「明文已接管 / 加密缺密钥 / 文件缺失」；可用条目 upsert 成账号
- Qoder：旧 pat 文件、env、`$DSH_HOME/model-hub/qoder-pats/` 逐个换 jobToken 验活；
  失败附 <https://qoder.com.cn/account/integrations> 建 PAT 指引
- 返回 `{channels:[{id, status, sources[], accountsAdded}]}`，不静默成功

**添加账号**：

- WorkBuddy `{channelId}`：扫 vault，把未登记的可用条目全部导入，返回导入清单
- Qoder `{channelId, pat, displayName?}`：校验 `^pt-`，写
  `$DSH_HOME/model-hub/qoder-pats/<slug>.pat`（0600，我们自己的地盘，不碰 Qoder App
  与别人的 vault），换 token 验活，upsert 账号，确保 runtime

**测试（单账号）**：WorkBuddy 用该账号 token 拉 `/v3/config`；Qoder 用该账号 PAT
换 jobToken + userinfo。成功则 `last_ok_at=now, consecutive_failures=0` 并解除冷却；
失败写 `last_error`。结果 `{ok, detail, ms}` 返回给面板。

## 8. UI 变更

- 账号行：开关 / 测试 / **设为当前**（新增）/ 删除全部激活；
  meta 行显示「熔断中（至 HH:mm）/ 上次失败原文截断」
- 渠道行：开关激活；关 = 该渠道模型从选择器消失（凭据保留），文案已在面板注明；
  行尾新增「展开」—— 列出该渠道全部模型（名称 · 倍率 · 活动/等级标记），
  数据来自现有 `/catalog`，不再只有一个「N 个模型」数字
- 「+ 添加账号」→ 弹窗（复用 RecordsModal 骨架）：WorkBuddy 一键扫描导入；
  Qoder 贴 PAT（`pt-` 前缀前端校验 + 可选备注名）
- 「一键认证」→ 请求期间转圈，结果区逐渠道列出接管/缺失原文
- **记录管理**（诊断栏新增一块）：保留天数（来自 config）、明细行数、
  「立即清理」（按保留天数删过期明细）与「清空全部」（删全部明细+聚合，
  前端 `confirm` 二次确认）两个按钮；操作后行数即时刷新
- **记录开关状态徽标**（诊断栏只读一行）：「记录：开/关」；
  修改入口保留在宿主插件设置（那里本来就是界面），面板不做写不进的假开关
- 每个写操作完成后局部 `load()` 刷新；失败进现有 errbox

## 8.1 记录保留清理（把 `retentionDays` 从摆设做真）

现状核实：`retentionDays` 只在 config 里声明，**没有任何代码执行它**，明细无限涨。
本期实现：

- `src/store/retention.ts`：`pruneRequests(db, days)` ——
  `DELETE FROM requests WHERE created_at < ?`（按天界），返回删除行数；
  `daily_rollups` 保留不动（总规格口径：明细有限期，聚合永久）
- 自动执行：启动时一次 + 每 24h 一次（读当次 `settings.retentionDays`，
  volatile 改完即生效）；清理失败只 warn，不影响主链路
- 手动执行：`records/prune` / `records/clear` 两个路由（见第 5 节）

## 9. 错误处理与并发

- HubState 写操作单一队列串行，避免 selector 快照撕裂
- 凭据纪律：dsh-connect-workbuddy 的 vault 只读不回写；PAT 只写自己的目录；
  日志全脱敏
- 探针超时 20s（与现有 fetch 一致）；写路由异常返回 `{ok:false, error}` JSON
- 删除当前账号：自动晋升池内下一个可用账号为当前；池空则渠道模型随第 6 节规则消失

## 10. 测试（vitest）

1. selector 单测：手动优先 / 连续 3 次熔断 / 10min 解冻 / 全池冷却兜底 /
   400 不熔断 / 5xx 换号不计熔断
2. 软删不复活：seed 与扫描器对 deleted 行的跳过（重启模拟）
3. 写路由门禁矩阵：Origin 非回环 403、非 JSON 415、body 超限 413、各 op happy path
4. shim 故障切换集成：mock 上游首账号 401 → 次账号 200，断言一次重试、
   `requests` 两行且 `account_id` 正确
5. Qoder 流内错误：不重试、记 502、下个请求换号
6. 热注册端到端：无渠道 → 贴 PAT → 模型可选（mock 上游）
7. 一键认证报告：明文/加密/缺失三态各有断言
8. 记录保留：prune 按天界删明细且 `daily_rollups` 不动；clear 全清；
   路由返回删除行数
9. 客户端渲染：渠道展开模型清单、记录管理块、记录状态徽标出现在卡片里
   （沿用 `tests/client-load.spec.ts` 的渲染断言方式）

## 11. 已知风险

1. 请求内重试放大上游压力——已用 `min(池大小,3)` 封顶，且只对凭据类状态码触发
2. WorkBuddy vault 属于 dsh-connect-workbuddy，其格式变化会使扫描 fail-soft（只报缺，不崩）
3. Qoder PAT 是用户手建物，吊销/过期只能如实报错并给指引
4. DSH 宿主 webServer 只提供 exact 路由——若未来要参数化路由需再评估，本期不赌
