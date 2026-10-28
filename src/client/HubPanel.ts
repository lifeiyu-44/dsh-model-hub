import React from "react";
import { HubCard } from "./HubCard.js";
import { ensureStyles } from "./styles.js";

/**
 * Model Hub 主面板 —— 左下角按钮打开的弹层外壳。
 *
 * **只做遮罩与定位，不自带标题栏**：原型的标题（`Model Hub` + 描述 +
 * 「一键认证」）在卡片自己的 `card-head` 里。之前这里也画了一个标题，
 * 于是面板上出现两行一模一样的 "DSH Model Hub"（用户截图指出过）。
 *
 * 三个原型视图的落点：
 * - ① 设置卡片 → `HubCard`（四栏：账号 / 渠道 / 记录 / 诊断）
 * - ② 请求记录页 → 卡片「记录」栏的「查看全部」打开 `RecordsModal`
 * - ③ 输入框胶囊 → **已移除**（该槽拿不到当前选中模型，会显示上一条记录，
 *   看起来像别的模型正在生效；且该槽会重复挂载两处）
 *
 * 关闭：Esc、点遮罩。
 */

const h = React.createElement;

export function HubPanel(props: { onClose: () => void }): React.ReactElement {
  ensureStyles();

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
      className: "dmh-overlay",
      onClick: (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) props.onClose();
      },
    },
    h(
      "div",
      { className: "dmh-scope dmh-overlay-body", role: "dialog", "aria-modal": true, "aria-label": "Model Hub" },
      h("div", { style: { width: 720, maxWidth: "100%" } }, h(HubCard)),
    ),
  );
}
