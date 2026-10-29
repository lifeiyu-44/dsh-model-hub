import React from "react";
import { ensureStyles } from "./styles.js";

/**
 * 面板内的「?」说明弹层。
 *
 * 目的：不把使用说明锁在 README 里 —— 用户点面板上任何按钮前，都能在同一个
 * 界面里查到「这是干什么的 / 凭据从哪来 / 多账号怎么加 / 出错看哪里」。
 * 结构沿用 RecordsModal 的 overlay/sheet 骨架（Esc / 遮罩 / × 关闭）。
 */

const h = React.createElement;

interface HelpSection {
  title: string;
  items: string[];
}

const SECTIONS: HelpSection[] = [
  {
    title: "面板是什么",
    items: [
      "把本机 WorkBuddy（国际/国内）与 Qoder CN 的模型接进 DSH 的模型选择器，模型 id 带 hub- 前缀。",
      "所有请求经插件自己的本机回环 shim 转发 —— 记录（token 数 / TTFT / tok·s / 状态码）只在那一层埋点，所以只有走 hub- 模型的对话才会出现在这里。",
      "四个栏：账号（增删启停/测试/切当前）、渠道（开关/展开模型清单）、记录（最近 4 条 + 查看全部）、诊断（凭据路径、错误原文、记录清理）。",
    ],
  },
  {
    title: "凭据从哪来（只读复用）",
    items: [
      "WorkBuddy：优先读取桌面端加密登录态（workbuddy-desktop-ai.info）——用 App 自身的 native binding 取密钥在内存里解开，明文 token 落到插件自有目录 workbuddy-tokens/（0600），不碰桌面端文件。",
      "WorkBuddy 次选：dsh-connect-workbuddy 维护的 vault（只读）。",
      "Qoder：~/.dsh/qoder/pat、环境变量，或面板「+ 添加账号」贴的 PAT（写到 model-hub/qoder-pats/，0600）。",
      "插件数据库只存凭据引用（文件路径），绝不存明文；日志与报错都会隐去 token/PAT 全文。",
    ],
  },
  {
    title: "多账号怎么加",
    items: [
      "WorkBuddy：在桌面端换登另一个账号 → 点「一键认证」→ 解密验活后按账号 uid 自动新增一行（同一个账号不会重复出现）。",
      "Qoder：面板「+ 添加账号」贴新 PAT（pt- 开头），不填备注名就用 userinfo 真名做显示名。",
      "「设为当前」决定池头：请求优先用它；它失败（401/402/403/429）会自动切池里下一个，连续 3 次失败熔断 10 分钟。",
      "账号行 meta 里的「今日 N 次 · X tokens」是按账号统计的消耗（daily_rollups 的 account_id 维度）。",
    ],
  },
  {
    title: "模型与思考档位",
    items: [
      "WorkBuddy 25 个模型统一声明支持思考档位；Qoder 按目录 is_reasoning 声明。",
      "选中支持思考的模型后，输入框的模型选择器里会出现「思考强度」（off/minimal/low/medium/high），且按模型记忆。",
      "非 hub 模型（如 zai-coding-cn）是否有档位取决于它自己的 provider 配置是否声明 reasoningEfforts。",
    ],
  },
  {
    title: "记录与保留",
    items: [
      "每次上游尝试各记一行（故障切换时能看到失败那次与成功那次，account_id 各不相同）。",
      "「立即清理」按保留天数删过期明细；「清空全部」连聚合一起清（两连确认）。",
      "明细保留天数来自插件设置 retentionDays（默认 90 天），聚合（每日统计）永久保留。",
    ],
  },
  {
    title: "出问题看哪里",
    items: [
      "诊断栏：凭据路径、token 有效期、shim 地址、上游最近一次错误原文（不翻译不概括，方便整段贴给作者）。",
      "账号行：熔断中（至 HH:mm）/ 上次失败原因 / 测试按钮的 ✓✗ 结论。",
      "插件状态文件：%USERPROFILE%\\.dsh\\model-hub\\status.json（ok / modelCount / 失败原因）。",
      "写操作报 origin_not_allowed / host_not_allowed = 请求不是本机发起的；bad_request = 参数不对。",
    ],
  },
];

export function HelpModal(props: { onClose: () => void }): React.ReactElement {
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
      { className: "dmh-scope dmh-overlay-body" },
      h(
        "div",
        { className: "dmh-sheet", role: "dialog", "aria-modal": true, "aria-label": "Model Hub 使用说明" },
        h(
          "div",
          { className: "dmh-sheet-head" },
          h(
            "div",
            null,
            h("div", { className: "dmh-card-title" }, "Model Hub 使用说明"),
            h("div", { className: "dmh-card-desc" }, "凭据只读复用 · 多账号池 · 请求记录"),
          ),
          h("button", { className: "dmh-btn", onClick: props.onClose, "aria-label": "关闭" }, "×"),
        ),
        h(
          "div",
          { className: "dmh-help-body" },
          SECTIONS.map((section) =>
            h(
              "div",
              { className: "dmh-help-section", key: section.title },
              h("div", { className: "dmh-help-title" }, section.title),
              h(
                "ul",
                { className: "dmh-help-list" },
                section.items.map((item) => h("li", { key: item }, item)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
