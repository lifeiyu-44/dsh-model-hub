import React from "react";
import * as ReactDOMClient from "react-dom/client";
import { HubCard } from "./HubCard.js";
import { HubPanel } from "./HubPanel.js";
import { ModelLabel } from "./ModelLabel.js";

/**
 * 客户端入口。
 *
 * ## ABI
 *
 * 宿主的客户端插件不是普通 ESM 模块，而是走 `window.__ModuleLoader__.load`：
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } })
 * ```
 * 导出 `name` / `inject` / `apply` 三项。`require` 由宿主注入（react、react-dom 等），
 * 不能自己 import —— 否则会和宿主的 React 实例不是同一个，hooks 直接崩。
 *
 * ## 为什么每个 slot 都单独 try/catch
 *
 * 参考实现 `dsh-connect-workbuddy` 的做法：不同入口的挂载点不同，某个 slot
 * 在当前宿主版本里可能不存在。**注册失败只该让那一个入口不显示，
 * 绝不该影响 provider，更不该抛到加载期**（加载期抛错会让整个 host fatal，
 * 进而把 profile 重置为默认 —— 本项目实测踩过两次）。
 */

const h = React.createElement;

export const name = "dsh-model-hub-client";

/**
 * 依赖的客户端服务。
 *
 * 与参考实现 `dsh-connect-workbuddy` 完全一致：`["slots", "locale"]`。
 *
 * 实测事故（2026-10-28）：「模型选择器打不开」报
 * `cannot get property "remote.session" without inject`。
 *
 * 排查过程与结论（重要，避免以后重犯）：
 * - 第一次猜是 inject 少声明，加了 `remote` → **更糟**：manifest 里我们的
 *   inject 变成 5 项，而正常工作的插件是 4 项；声明 `@deepseek-ai/dsh-api-remotes`
 *   反而让宿主经由它去解析 `remote.session`，继续抛。
 * - 真正的修法是给 slot 传 `inject` 回调（见下面 `register`），
 *   让组件走显式 props 而不是宿主的默认注入路径。
 *
 * 所以这里**不要**加 `remote`。宿主渲染路径要什么服务是它自己的事，
 * 我们只声明自己真正用的。
 */
export const inject = ["slots", "locale"];

export function apply(ctx: any): void {
  try {
    /**
     * 注册一个 slot。
     *
     * `inject` 回调是**必需**的，不是可选优化：它决定组件拿到哪些 props。
     * 不给它，宿主会走默认注入路径（会调 `directoryFor()`，需要
     * `remote.session`），于是模型选择器崩掉。给了它，注入就被短路成
     * 我们返回的普通对象，不再触碰那条路径。
     */
    const register = (slotName: string, options: Record<string, unknown>, component: any, props: () => Record<string, unknown>) => {
      try {
        return ctx.slots.inject(slotName, () =>
          ctx.slots.register({ name: slotName, inject: props, ...options }, component),
        );
      } catch (error) {
        console.error(`[dsh-model-hub] slot "${slotName}" 注册失败（不影响 provider）:`, error);
        return undefined;
      }
    };

    // ── 1. 设置卡片：两处都注册 ──
    //
    // `key` 必须与宿主 inventory 里的插件名一致，否则卡片不渲染、也不报错
    // （参考实现 issue #55 记录的正是这个静默失败）。而 inventory 的名字
    // 可能是裸包名，也可能是 `include:<包名>` —— 取决于 profile 怎么挂载它。
    // 所以两种拼写都注册：不同 key 落在不同单元格，是安全的重复而非冲突。
    const CARD_KEYS = ["dsh-model-hub", "include:dsh-model-hub"];
    const cardProps = () => ({});
    for (const key of CARD_KEYS) {
      register("plugins.bundle.config", { key, priority: 30 }, HubCard, cardProps);
      register("plugins.row.config", { key: `${key}#${key}`, priority: 30 }, HubCard, cardProps);
    }

    // ── 2. 左下角入口（侧边栏底部，Settings 旁边）──
    // 官方契约："Optional actions beside Settings at the sidebar foot."
    // 宽栏显示图标+文字，窄栏（56px rail）只显示图标 —— 宿主会传 wide 标志。
    const FooterEntry = (props: { wide?: boolean }) =>
      h(
        "button",
        {
          onClick: () => openHubPanel(),
          title: "DSH Model Hub 记录",
          "aria-label": "DSH Model Hub 记录",
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "6px 10px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: "inherit",
            fontSize: 13,
            borderRadius: 6,
          },
        },
        // 图标用内联 SVG，不依赖图标库
        h(
          "svg",
          { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
          h("path", { d: "M2 12V4m4 8V6m4 6V8m4 4V3", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }),
        ),
        props.wide === false ? null : h("span", null, "Model Hub"),
      );

    // 侧边栏入口也需要 inject 回调（同一条规则：不给就走默认注入路径）。
    // 宿主通过 props 传 `wide`（宽栏 true / 窄栏 false），这里转发即可。
    register(
      "sidebar.footer.action",
      { id: "dsh-model-hub", order: 100 },
      FooterEntry,
      () => ({}),
    );

    // ── 3. 输入框行内的胶囊：**已移除** ──
    //
    // 曾经挂在 `conversation.input.left`（以及更早的 composer.dock），显示
    // 「最近一次请求」的 tok/s、out、TTFT。实测有两个问题，都不是能靠小改解决的：
    //
    // 1. **重复渲染**：composer.dock 与 input.left 在 0.2.1-rc.3 上都会挂载，
    //    同一个胶囊画了两遍。
    // 2. **与实际选择不符**：这个槽拿不到「当前选中的模型」，只能显示上一条记录，
    //    于是用户选了 DeepSeek 却看到 `hy3 · 120 tok/s`，看起来像 hy3 正在生效。
    //
    // 第二点是设计缺陷而不是 bug：要修就得从宿主读 modelSelection 投影，
    // 而那要额外声明 `remote.session` 一类服务。既然这些数字在「Model Hub」面板的
    // 记录栏里本来就有，就不在输入框制造误导了。
    // 参考实现把额度读数放在这里，是因为它按 provider 归属过滤（只在自己的
    // 模型被选中时渲染）—— 我们做不到那个过滤，就不放。

    // ── 4. 模型标签的彩色后缀 ──
    //
    // 宿主把模型名当纯文本渲染，`· x0.00 · Free now` 只能是灰字。
    // 彩色 pill 必须在这个插槽里自己画（参考实现同样如此）。
    // 这个槽不需要 inject 回调 —— 宿主直接传 { provider, model, placement }。
    try {
      ctx.slots.inject("conversation.input.model.label", () =>
        ctx.slots.register({ name: "conversation.input.model.label", priority: 30 }, ModelLabel),
      );
    } catch (error) {
      console.error("[dsh-model-hub] 模型标签槽注册失败（不影响 provider）:", error);
    }
  } catch (error) {
    // 最外层防线：客户端加载失败也不该影响 host 侧 provider。
    console.error("[dsh-model-hub] 客户端初始化失败（host provider 不受影响）:", error);
  }
}

/**
 * 打开 Model Hub 主面板。
 *
 * **不用 `globalThis.__DSH_REACT_DOM_CLIENT__`** —— 实测宿主根本没暴露这个
 * 全局对象，之前那条分支永远走 else，点按钮只会打一行警告然后立刻关掉。
 *
 * 改为自己挂一个独立 React root：`react-dom/client` 由宿主 `require` 提供
 * （`__ModuleLoader__` 的 factory 参数里有），同一个 React 实例，
 * 不会出现双实例 hooks 崩溃。
 *
 * 幂等：面板已存在时再点就关掉（当作开关用，符合左下角入口的直觉）。
 */
function openHubPanel(): void {
  const existing = document.getElementById("dsh-model-hub-panel");
  if (existing !== null) {
    existing.remove();
    return;
  }

  const host = document.createElement("div");
  host.id = "dsh-model-hub-panel";
  document.body.appendChild(host);

  const close = () => {
    try {
      root.unmount();
    } catch {
      /* 已经卸载过就忽略 */
    }
    host.remove();
  };

  const { createRoot } = ReactDOMClient;
  const root = createRoot(host);
  root.render(h(HubPanel, { onClose: close }));
}
