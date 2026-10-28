import React from "react";
import { HubCard } from "./HubCard.js";
import { RecordsModal } from "./RecordsModal.js";

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
 * **必须与 package.json 的 `dsh.client.inject` 语义一致。**
 *
 * 实测事故（2026-10-28）：这里只写了 `slots`，插件能加载、卡片能渲染，
 * 但**模型选择器打不开** —— 报
 * `cannot get property "remote.session" without inject`。
 *
 * 根因不在 inject 列表本身（参考插件 `dsh-connect-workbuddy` 只声明
 * `["slots","locale"]` 也正常），而在**注册 slot 时没给 `inject` 回调**：
 * 宿主的默认注入路径会调 `directoryFor()`，那条路要 `remote.session`。
 * 参考实现给每个 slot 都传了 `inject: () => ({ ...props })`，
 * 走的是显式 props 而不是默认注入路径 —— 所以它不需要声明 remote。
 *
 * 两处都补：inject 声明里加 `remote`（防御），注册时给 `inject` 回调（治本）。
 */
export const inject = ["slots", "locale", "remote"];

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
    // 不同入口的挂载点不同，哪个能显示就显示哪个。
    const cardProps = () => ({});
    register("plugins.bundle.config", { key: "dsh-model-hub", priority: 30 }, HubCard, cardProps);
    register("plugins.row.config", { key: "dsh-model-hub#dsh-model-hub", priority: 30 }, HubCard, cardProps);

    // ── 2. 左下角入口（侧边栏底部，Settings 旁边）──
    // 官方契约："Optional actions beside Settings at the sidebar foot."
    // 宽栏显示图标+文字，窄栏（56px rail）只显示图标 —— 宿主会传 wide 标志。
    const FooterEntry = (props: { wide?: boolean }) =>
      h(
        "button",
        {
          onClick: () => {
            // 打开记录弹层。用自建 portal 而不是依赖宿主的弹层服务，
            // 这样在宿主没有该服务时也能工作。
            const host = document.createElement("div");
            host.id = "dsh-model-hub-modal";
            document.body.appendChild(host);
            const close = () => {
              host.remove();
            };
            // 用 createRoot 渲染，避免和宿主 React 版本冲突
            const ReactDOM = (globalThis as any).__DSH_REACT_DOM_CLIENT__;
            if (ReactDOM?.createRoot) {
              ReactDOM.createRoot(host).render(h(RecordsModal, { onClose: close }));
            } else {
              console.warn("[dsh-model-hub] 无法打开弹层：宿主未暴露 react-dom/client");
              close();
            }
          },
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
  } catch (error) {
    // 最外层防线：客户端加载失败也不该影响 host 侧 provider。
    console.error("[dsh-model-hub] 客户端初始化失败（host provider 不受影响）:", error);
  }
}
