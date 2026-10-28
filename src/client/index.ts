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

/** 依赖的客户端服务。缺任何一个，`apply` 都不会被调用（Cordis 会等）。 */
export const inject = ["slots"];

export function apply(ctx: any): void {
  try {
    const register = (slotName: string, options: Record<string, unknown>, component: any) => {
      try {
        return ctx.slots.inject(slotName, () =>
          ctx.slots.register({ name: slotName, ...options }, component),
        );
      } catch (error) {
        console.error(`[dsh-model-hub] slot "${slotName}" 注册失败（不影响 provider）:`, error);
        return undefined;
      }
    };

    // ── 1. 设置卡片：两处都注册 ──
    // 不同入口的挂载点不同，哪个能显示就显示哪个。
    register("plugins.bundle.config", { key: "dsh-model-hub", priority: 30 }, HubCard);
    register("plugins.row.config", { key: "dsh-model-hub#dsh-model-hub", priority: 30 }, HubCard);

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

    register("sidebar.footer.action", { id: "dsh-model-hub", order: 100 }, FooterEntry);
  } catch (error) {
    // 最外层防线：客户端加载失败也不该影响 host 侧 provider。
    console.error("[dsh-model-hub] 客户端初始化失败（host provider 不受影响）:", error);
  }
}
