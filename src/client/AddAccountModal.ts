import React from "react";
import { hubApi } from "./api.js";
import { ensureStyles } from "./styles.js";

/**
 * 添加账号弹层。骨架与 `RecordsModal` 同构（overlay / sheet / Esc / 点遮罩关闭），
 * 但只有一张小表单，所以 sheet 用窄档 `dmh-sheet-sm`。
 *
 * 两种形态（kind 由 HubCard 按渠道 kind 传入）：
 * - workbuddy：无表单，一个「扫描 vault 导入」按钮 —— 凭据是只读复用，
 *   导入动作只是把 vault 里已有的条目登记进账号表；成功后留在弹窗里展示
 *   added 列表（扫出来什么一目了然），用户点「完成」才刷新并关闭。
 * - qoder：贴 PAT + 可选备注名。PAT 先过前端格式门（pt- 前缀 + 至少 8 位），
 *   不合规直接禁用提交 —— 免得把一眼就错的 token 打到上游验活。
 *
 * 错误一律显示在弹层内 errbox（不冒到卡片的全局 errbox，用户视线在弹层里）。
 * 成功调 `onDone()`：父组件负责刷新数据并关闭本弹层。
 */

const h = React.createElement;

const PAT_PATTERN = /^pt-[A-Za-z0-9_-]{8,}$/;

export function AddAccountModal(props: {
  channelId: string;
  kind: "workbuddy" | "qoder" | "trae";
  onClose: () => void;
  onDone: () => void;
}): React.ReactElement {
  ensureStyles();

  const [pat, setPat] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [added, setAdded] = React.useState<string[] | undefined>(undefined);

  // Esc / 遮罩关闭与 RecordsModal 同款：绑 document，焦点在弹层任何位置都能关。
  // 关闭动作经 dismiss（见上）：导入成功后的关闭 = 刷新 + 关闭，不是取消。
  // effect 刻意不带依赖数组：每次渲染重绑一次监听，保证 dismiss 捕到最新的 added
  // （成本是一次 addEventListener，换来的是关闭语义永远正确）。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // 校验与提交都吃 trim 后的值（终审 M6）：textarea 粘贴常带首尾空白/换行，
  // 原样过格式门会把一眼合法的 PAT 挡在 disabled 后面；服务端 addQoderPat
  // 本就 trim，这里对齐口径，提交的也是干净值。
  const trimmedPat = pat.trim();
  const patValid = PAT_PATTERN.test(trimmedPat);

  /**
   * 关闭路径统一走这里：WB 扫描成功后，数据已经变了（账号表多了行），
   * 此时 Esc/×/点遮罩也必须让父组件刷新——否则新账号要到下次手动刷新才出现。
   * 没有发生过成功导入时，关闭就是纯取消，走 onClose。
   */
  const dismiss = () => (added !== undefined ? props.onDone() : props.onClose());

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const doc = await hubApi.addAccount({
        channelId: props.channelId,
        ...(props.kind === "qoder" ? { pat: trimmedPat } : {}),
        ...(props.kind === "qoder" && displayName.trim() !== "" ? { displayName: displayName.trim() } : {}),
      });
      if ("added" in doc && Array.isArray(doc.added)) {
        if (props.kind !== "qoder") {
          // 导入型渠道（WorkBuddy / Trae）：把导到的账号亮出来再让用户关——
          // 静默关闭会让「到底导入了几个」无从对账
          setAdded(doc.added);
        } else {
          props.onDone();
          return;
        }
      } else {
        // 理论到不了：postJson 对非 2xx 会抛。兜一条，别让弹窗无话可说。
        setError("服务端没有返回新增账号列表");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return h(
    "div",
    {
      className: "dmh-overlay",
      onClick: (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) dismiss();
      },
    },
    h(
      "div",
      { className: "dmh-scope dmh-overlay-body" },
      h(
        "div",
        { className: "dmh-sheet dmh-sheet-sm", role: "dialog", "aria-modal": true, "aria-label": "添加账号" },
        h(
          "div",
          { className: "dmh-sheet-head" },
          h(
            "div",
            null,
            h("div", { className: "dmh-card-title" }, "添加账号"),
            h(
              "div",
              { className: "dmh-card-desc" },
              props.kind === "qoder"
                ? "粘贴 Qoder CN 的 Personal Access Token"
                : props.kind === "trae"
                  ? "从本机 Trae 客户端导入登录态"
                  : "从 WorkBuddy vault 只读导入已有凭据",
            ),
          ),
          h("button", { className: "dmh-btn dmh-icon", onClick: dismiss, "aria-label": "关闭" }, "×"),
        ),
        props.kind !== "qoder"
          ? h(
              "div",
              { className: "dmh-form" },
              h(
                "div",
                { className: "dmh-note" },
                props.kind === "trae"
                  ? "扫描本机 Trae 的登录态（解密它自己的本地存储），把当前账号导入到渠道 "
                  : "扫描本机 WorkBuddy vault，把里面还没有登记的账号导入到渠道 ",
                h("span", { className: "dmh-strong" }, props.channelId),
                props.kind === "trae"
                  ? "。Trae 自己的文件只读，不会被改写。"
                  : "。凭据文件保持只读，不会被改写。",
              ),
              added !== undefined
                ? h(
                    "div",
                    { className: "dmh-note" },
                    added.length === 0
                      ? "没有新账号：本机登录态里的账号都已登记过。"
                      : [
                          `已导入 ${added.length} 个账号：`,
                          h("div", { key: "ids" }, added.join(" · ")),
                        ],
                  )
                : null,
              error !== undefined ? h("div", { className: "dmh-errbox" }, error) : null,
              h(
                "div",
                { className: "dmh-form-actions" },
                added !== undefined
                  ? h("button", { className: "dmh-btn dmh-primary", onClick: props.onDone }, "完成")
                  : h(
                      "button",
                      { className: "dmh-btn dmh-primary", disabled: busy, onClick: () => void submit() },
                      busy ? "扫描中…" : props.kind === "trae" ? "扫描本机 Trae 导入" : "扫描 vault 导入",
                    ),
              ),
            )
          : h(
              "div",
              { className: "dmh-form" },
              h(
                "label",
                null,
                "Personal Access Token",
                h("textarea", {
                  rows: 4,
                  value: pat,
                  placeholder: "pt-…",
                  // 等宽字体 + spellCheck 关闭：token 不是自然语言，红线毫无信息量
                  spellCheck: false,
                  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setPat(event.target.value),
                }),
                pat === "" || trimmedPat === "" || patValid
                  ? null
                  : h("span", { className: "dmh-form-hint" }, "格式不对：pt- 开头，后接至少 8 位字母/数字/-/_"),
              ),
              h(
                "label",
                null,
                "备注名（可选）",
                h("input", {
                  value: displayName,
                  placeholder: "留空则自动命名",
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDisplayName(event.target.value),
                }),
              ),
              error !== undefined ? h("div", { className: "dmh-errbox" }, error) : null,
              h(
                "div",
                { className: "dmh-form-actions" },
                h("button", {
                  className: "dmh-btn dmh-primary",
                  disabled: busy || !patValid,
                  onClick: () => void submit(),
                }, busy ? "验活中…" : "添加"),
              ),
            ),
      ),
    ),
  );
}
