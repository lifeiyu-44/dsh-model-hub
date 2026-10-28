import React from "react";
import { HubCard } from "./HubCard.js";

/**
 * Model Hub 主面板 —— 三个原型视图的统一入口。
 *
 * 设计原型有三块，分别落在：
 * - **设置卡片** → 本面板。`HubCard` 内含四栏：账号 / 渠道 / 记录 / 诊断。
 *   其中「记录」栏有「查看全部」按钮，会在内部打开全量记录弹层
 *   （`RecordsModal`，含筛选 + CSV 导出）。
 * - **记录弹层** → 由上面的「查看全部」打开。
 * - **输入框胶囊** → 挂 `conversation.composer.dock` 独立渲染（见 `ComposerPill`）。
 *
 * 为什么需要这个面板而不是只靠「插件」设置页：
 * 设置页里的卡片要展开插件行才看得到，用户找不到入口
 * （实测反馈「设置里面也没找到」）。左下角这个按钮是直达入口。
 */

const h = React.createElement;

export function HubPanel(props: { onClose: () => void }): React.ReactElement {
  // Esc 关闭整个面板。
  //
  // 记录弹层渲染在卡片内部（同一棵 React 树），它的 Esc 监听与这里会同时触发，
  // 结果是「一次 Esc 把两层都关掉」—— 可接受，且比「按了没反应」好。
  // 不做「先关内层」的判定，因为那要靠 DOM 探测两棵树的叠放顺序，脆弱。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return h(
    "div",
    {
      onClick: (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) props.onClose();
      },
      style: {
        position: "fixed" as const,
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      },
    },
    h(
      "div",
      {
        role: "dialog",
        "aria-modal": true,
        "aria-label": "DSH Model Hub",
        style: {
          width: "100%",
          maxWidth: 720,
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column" as const,
          padding: 20,
          borderRadius: 12,
          background: "var(--dsh-color-bg-elevated, #fff)",
          color: "var(--dsh-color-text, #111827)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
          overflow: "auto",
        },
      },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
        h("strong", { style: { fontSize: 15 } }, "DSH Model Hub"),
        h(
          "button",
          {
            onClick: props.onClose,
            "aria-label": "关闭",
            style: {
              border: "none",
              background: "transparent",
              fontSize: 20,
              lineHeight: 1,
              cursor: "pointer",
              color: "var(--dsh-color-text-secondary, #6b7280)",
              padding: "2px 6px",
            },
          },
          "×",
        ),
      ),
      h(HubCard),
    ),
  );
}
