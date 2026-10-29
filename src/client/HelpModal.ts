import React from "react";
import { ensureStyles } from "./styles.js";

/**
 * 面板内的「?」说明弹层 —— **左目录 + 右正文**双栏。
 *
 * 目的：不把使用说明锁在 README 里 —— 用户点面板上任何按钮前，都能在同一个
 * 界面里查到「这是干什么的 / 凭据从哪来 / 多账号怎么加 / 出错看哪里」。
 *
 * 为什么双栏：六节单栏连排是一大段散文，找具体一节要滚到底。左目录常驻 +
 * 右侧按节锚点跳转，长文也能一眼定位。目录项带 01–06 等宽序号，正文限制
 * 672px 阅读宽度（超过这个宽度中文行会难跟读）。
 *
 * 结构沿用 RecordsModal 的 overlay/sheet 骨架（Esc / 遮罩 / × 关闭）。
 * 三种正文块：lead 导语段、list 列表、kv 键值表 + tip 提示条（强调用）。
 */

const h = React.createElement;

/** 正文块：导语 / 列表 / 键值表 / 提示条。 */
type Block =
  | { kind: "lead"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "kv"; rows: [string, string][] }
  | { kind: "tip"; text: string };

interface HelpSection {
  title: string;
  blocks: Block[];
}

/**
 * 说明正文。**与 README.md 同源**：改这里记得同步改 README，
 * 反之亦然（两处都写给用户看，不能一处说一套）。
 */
const SECTIONS: HelpSection[] = [
  {
    title: "面板是什么",
    blocks: [
      {
        kind: "lead",
        text: "把本机 WorkBuddy（国际/国内）与 Qoder CN 的模型接进 DSH 的模型选择器，模型 id 带 hub- 前缀。所有请求经插件自己的本机回环 shim 转发 —— 记录（token / TTFT / tok·s / 状态码）只在那一层埋点，所以只有走 hub- 模型的对话才会出现在这里。",
      },
      {
        kind: "list",
        items: [
          "账号：增删启停、测试、切当前，并显示每个账号的今日消耗",
          "渠道：总开关 + 展开该渠道自己的模型清单（倍率、活动标记）",
          "记录：最近 4 条 + 「查看全部」弹层（筛选、统计、导出 CSV）",
          "诊断：凭据路径、token 有效期、上游错误原文、记录清理",
        ],
      },
    ],
  },
  {
    title: "凭据从哪来",
    blocks: [
      {
        kind: "lead",
        text: "全部只读复用，不向任何第三方服务器上传凭据。插件数据库只存凭据引用（文件路径），绝不存明文。",
      },
      {
        kind: "kv",
        rows: [
          ["WorkBuddy 桌面端", "workbuddy-desktop-ai.info 的加密信封，用 App 自身 native binding 取密钥，在内存里解开"],
          ["插件自有 token", "~/.dsh/model-hub/workbuddy-tokens/，每账号一文件，权限 0600"],
          ["connect-workbuddy", "~/.dsh/workbuddy-vault/ 历史 vault，只读"],
          ["Qoder PAT", "~/.dsh/qoder/pat、环境变量，或面板里贴的 PAT（存 model-hub/qoder-pats/，0600）"],
        ],
      },
      {
        kind: "tip",
        text: "桌面端 auth 文件与 vault 永不回写；日志与报错统一隐去 token/PAT 全文（只留文件路径与前 6 位）。写接口要求本机回环 + Origin 规则 + JSON content-type + body ≤64KB。",
      },
    ],
  },
  {
    title: "多账号怎么加",
    blocks: [
      {
        kind: "list",
        items: [
          "WorkBuddy：在桌面端换登另一个账号 → 点「一键认证」→ 解密验活后按账号 uid 自动新增一行；同一个账号重复认证只刷新那一行，不会重复出现",
          "Qoder：面板「+ 添加账号」贴 pt- 开头的 PAT，备注名留空就用 userinfo 真名做显示名",
          "设为当前决定池头：请求优先用它；它失败（401/402/403/429）自动切池里下一个，连续 3 次失败熔断 10 分钟",
          "账号行 meta 里的「今日 N 次 · X tokens」是按账号统计的消耗，切换过账号也能分清是谁的",
        ],
      },
    ],
  },
  {
    title: "模型与档位",
    blocks: [
      {
        kind: "list",
        items: [
          "WorkBuddy 25 个模型统一声明支持思考档位（上游接受 reasoning_effort 参数，不支持的模型会忽略它）",
          "Qoder 按目录 is_reasoning 如实声明",
          "选中支持思考的模型后，输入框的模型选择器里出现「思考强度」（off/minimal/low/medium/high），且按模型记忆",
          "非 hub 模型（如 zai-coding-cn）是否有档位，取决于它自己的 provider 配置有没有声明 reasoningEfforts",
        ],
      },
    ],
  },
  {
    title: "记录与保留",
    blocks: [
      {
        kind: "list",
        items: [
          "每次上游尝试各记一行：故障切换时失败那次与成功那次都能看到，账号列各是各的",
          "tok/s = output tokens ÷ 解码时长（首 token 到达 → 流结束，不含 TTFT）；TTFT 从请求到达 shim 算起，含建连",
          "拿不到上游 usage 的行会标 * 并置灰，不当成 0 参与统计",
          "「立即清理」按保留天数删过期明细；「清空全部」连聚合一起清（两连确认）",
        ],
      },
      {
        kind: "tip",
        text: "明细保留天数来自插件设置 retentionDays（默认 90 天），聚合（每日统计）永久保留。明细上限 2000 行。",
      },
    ],
  },
  {
    title: "出问题看哪里",
    blocks: [
      {
        kind: "kv",
        rows: [
          ["诊断栏", "凭据路径、token 有效期、shim 地址、上游最近一次错误原文（不翻译不概括，方便整段贴给作者）"],
          ["账号行", "熔断中（至 HH:mm）/ 上次失败原因 / 测试按钮的 ✓✗ 结论"],
          ["状态文件", "%USERPROFILE%\\.dsh\\model-hub\\status.json（ok / modelCount / 失败原因）"],
          ["写接口报错", "origin_not_allowed / host_not_allowed = 请求不是本机发起的；bad_request = 参数不对；payload_too_large = body 超 64KB"],
        ],
      },
    ],
  },
];

export function HelpModal(props: { onClose: () => void }): React.ReactElement {
  ensureStyles();

  /** 当前高亮的小节（点目录跳转时同步）。 */
  const [active, setActive] = React.useState(0);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  /** 每节的 DOM 锚点，用于滚动定位。 */
  const secRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  /** 点目录：滚到该节（在正文容器内滚，不是整页滚）。 */
  const goto = (index: number) => {
    setActive(index);
    const target = secRefs.current[index];
    const body = bodyRef.current;
    if (target === undefined || target === null || body === null) return;
    body.scrollTo({ top: target.offsetTop - 8, behavior: "smooth" });
  };

  /** 手动滚动时反过来更新目录高亮：取「顶边已越过容器顶部」的最后一节。 */
  const onBodyScroll = () => {
    const body = bodyRef.current;
    if (body === null) return;
    let current = 0;
    secRefs.current.forEach((node, index) => {
      if (node !== undefined && node !== null && node.offsetTop - body.scrollTop <= 24) current = index;
    });
    setActive(current);
  };

  const renderBlock = (block: Block, key: string): React.ReactNode => {
    switch (block.kind) {
      case "lead":
        return h("p", { className: "dmh-help-lead", key }, block.text);
      case "list":
        return h(
          "ul",
          { className: "dmh-help-list", key },
          block.items.map((item) => h("li", { key: item }, item)),
        );
      case "kv":
        return h(
          "div",
          { className: "dmh-help-kv", key },
          block.rows.map(([k, v]) =>
            h("div", { key: k }, h("dt", null, k), h("dd", null, v)),
          ),
        );
      case "tip":
        return h(
          "div",
          { className: "dmh-help-tip", key },
          h("span", { className: "dmh-help-mark" }, "!"),
          h("span", null, block.text),
        );
    }
  };

  return h(
    "div",
    {
      className: "dmh-overlay dmh-overlay-help",
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
          h(
            "button",
            { className: "dmh-btn dmh-icon", onClick: props.onClose, "aria-label": "关闭" },
            "×",
          ),
        ),
        h(
          "div",
          { className: "dmh-help" },
          // 左：目录
          h(
            "div",
            { className: "dmh-help-nav", role: "tablist", "aria-label": "说明目录" },
            SECTIONS.map((section, index) =>
              h(
                "button",
                {
                  key: section.title,
                  className: active === index ? "dmh-on" : undefined,
                  onClick: () => goto(index),
                  "aria-selected": active === index,
                  role: "tab",
                },
                h("span", { className: "dmh-help-idx" }, String(index + 1).padStart(2, "0")),
                h("span", null, section.title),
              ),
            ),
          ),
          // 右：正文
          h(
            "div",
            { className: "dmh-help-body", ref: bodyRef, onScroll: onBodyScroll },
            SECTIONS.map((section, index) =>
              h(
                "div",
                {
                  className: "dmh-help-sec",
                  key: section.title,
                  ref: (node: HTMLDivElement | null): void => {
                    secRefs.current[index] = node;
                  },
                },
                h("div", { className: "dmh-help-sec-title" }, section.title),
                section.blocks.map((block, i) => renderBlock(block, `${section.title}-${i}`)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
