# dsh-model-hub

把 WorkBuddy、ZCode、Qoder CN 三个平台的模型统一接进 DeepSeek Harness，带账号管理、请求记录与一键认证。

## 当前进度

- [x] 设计规格 → `docs/superpowers/specs/2026-10-27-dsh-model-hub-design.md`
- [x] 界面原型 → `docs/prototype/ui-prototype.html`
- [ ] 实现计划
- [ ] 代码

## 界面原型

直接用浏览器打开 `docs/prototype/ui-prototype.html`。三个视图可切换：

| 视图 | 内容 |
|---|---|
| ① 设置卡片 | 账号 / 渠道 / 记录 / 诊断 四栏 |
| ② 请求记录页 | 明细表 + 统计条 + 筛选 |
| ③ 输入框胶囊 | 实时 tok/s，三种状态 |

设计令牌取自 DSH 自身的 `dsh-client-ui-theme`，深色主题（`body[data-ds-dark-theme]`）。
已验证：6 个视图组合零布局溢出、零文字裁切、零对比度不达标（WCAG AA 4.5:1）。

截图见 `docs/prototype/shot-*.jpg`。
