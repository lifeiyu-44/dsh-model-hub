/**
 * 面板样式：**照抄原型 `docs/prototype/ui-prototype.html` 的 CSS**。
 *
 * 为什么用注入而不是 CSS Module / 内联样式：
 * 客户端插件是运行时加载的，宿主不处理我们的样式文件；原型本身就是一张
 * `<style>` + 语义 class 的设计稿，直接搬过来一致性最高、也最好核对。
 *
 * 类名统一加 `dmh-` 前缀：宿主自己也在用 `.row` `.card` `.badge` `.stat`
 * 这类通名，不加前缀会串到宿主的界面上。
 *
 * 令牌全部是原型里那套（源自 `dsh-client-ui-theme/lib/client.js`），
 * 深浅两套由 `body[data-ds-dark-theme]` 切换 —— 我们只消费变量，不定义主题。
 */

export const STYLE_ELEMENT_ID = "dsh-model-hub-styles";

export const CSS = `
.dmh-scope{
  --dmh-neutral-00:#fff; --dmh-neutral-50:#fafafa; --dmh-neutral-100:#f5f5f5; --dmh-neutral-150:#ededed;
  --dmh-neutral-300:#d4d4d4; --dmh-neutral-400:#a3a3a3; --dmh-neutral-600:#6b6b6b; --dmh-neutral-700:#525252;
  --dmh-neutral-850:#2c2c2e; --dmh-neutral-875:#232324; --dmh-neutral-900:#1b1b1c; --dmh-neutral-950:#151517;
  --dmh-green-500:#22c55e; --dmh-red-600:#ec1313; --dmh-red-400:#f25a5a; --dmh-amber-500:#f59e0b;
  --dmh-deepseek-500:#4176e6; --dmh-deepseek-300:#b7c8fe; --dmh-deepseek-50:#edf3fe;

  /* 浅色 */
  --dmh-bg-base:var(--dmh-neutral-00); --dmh-bg-layer-2:var(--dmh-neutral-00); --dmh-bg-layer-3:var(--dmh-neutral-100);
  --dmh-label-primary:var(--dmh-neutral-950); --dmh-label-secondary:var(--dmh-neutral-700);
  --dmh-label-tertiary:var(--dmh-neutral-600); --dmh-label-quaternary:var(--dmh-neutral-400);
  --dmh-border-l1:#0000000a; --dmh-border-l2:#00000014; --dmh-border-l3:#0000001f; --dmh-border-l4:#00000029;
  --dmh-brand-primary:var(--dmh-neutral-950);
  --dmh-success:var(--dmh-green-500); --dmh-error:var(--dmh-red-600); --dmh-warn:var(--dmh-amber-500);
  --dmh-card-fill:var(--dmh-neutral-00); --dmh-card-stroke:var(--dmh-border-l4);
  --dmh-hover:#0000000a; --dmh-selected:var(--dmh-deepseek-50); --dmh-accent-text:var(--dmh-deepseek-500);
  --dmh-danger-text:var(--dmh-red-600);

  color:var(--dmh-label-primary);
  font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
}
body[data-ds-dark-theme] .dmh-scope, .dmh-scope[data-dmh-dark]{
  --dmh-bg-base:var(--dmh-neutral-950); --dmh-bg-layer-2:var(--dmh-neutral-850); --dmh-bg-layer-3:var(--dmh-neutral-875);
  --dmh-label-primary:var(--dmh-neutral-50); --dmh-label-secondary:var(--dmh-neutral-300);
  --dmh-label-tertiary:var(--dmh-neutral-400); --dmh-label-quaternary:var(--dmh-neutral-600);
  --dmh-border-l1:#ffffff0f; --dmh-border-l2:#ffffff1a; --dmh-border-l3:#ffffff26; --dmh-border-l4:#ffffff33;
  --dmh-brand-primary:var(--dmh-neutral-50);
  --dmh-card-fill:var(--dmh-neutral-850); --dmh-card-stroke:var(--dmh-border-l4);
  --dmh-hover:#ffffff0d; --dmh-selected:#4176e61f; --dmh-accent-text:var(--dmh-deepseek-300);
  --dmh-danger-text:#ff8080; --dmh-error:var(--dmh-red-400);
}

.dmh-scope *{box-sizing:border-box;margin:0;padding:0}

/* ===== 卡片 ===== */
.dmh-card{
  background:var(--dmh-card-fill);border:1px solid var(--dmh-card-stroke);
  border-radius:10px;overflow:hidden;
}
.dmh-card-head{
  padding:14px 16px;border-bottom:1px solid var(--dmh-border-l1);
  display:flex;align-items:center;justify-content:space-between;gap:12px;
}
.dmh-card-title{font-size:13px;font-weight:600}
.dmh-card-desc{font-size:11px;color:var(--dmh-label-tertiary);margin-top:2px}

/* ===== tab ===== */
.dmh-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--dmh-border-l1);background:var(--dmh-bg-layer-3)}
.dmh-tabs button{
  font:inherit;font-size:12px;padding:9px 12px;border:0;background:none;cursor:pointer;
  color:var(--dmh-label-tertiary);border-bottom:2px solid transparent;margin-bottom:-1px;
}
.dmh-tabs button.dmh-on{color:var(--dmh-label-primary);border-bottom-color:var(--dmh-brand-primary);font-weight:500}
.dmh-panel{display:block;padding:4px 0}
.dmh-panel[hidden]{display:none}

/* ===== 行 ===== */
.dmh-row{display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--dmh-border-l1)}
.dmh-row:last-child{border-bottom:0}
.dmh-row:hover{background:var(--dmh-hover)}
.dmh-row.dmh-group{background:var(--dmh-bg-layer-3);padding:7px 16px}
.dmh-row-main{flex:1;min-width:0}
.dmh-row-name{font-size:12.5px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dmh-row-meta{font-size:11px;color:var(--dmh-label-tertiary);margin-top:2px;font-variant-numeric:tabular-nums}
.dmh-dot{width:6px;height:6px;border-radius:50%;flex:none}
.dmh-dot.dmh-ok{background:var(--dmh-success)}
.dmh-dot.dmh-err{background:var(--dmh-error)}
.dmh-dot.dmh-warn{background:var(--dmh-warn)}
.dmh-dot.dmh-off{background:var(--dmh-label-quaternary)}

/* ===== 按钮 ===== */
.dmh-btn{
  font:inherit;font-size:11.5px;padding:4px 10px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dmh-border-l3);background:transparent;color:var(--dmh-label-secondary);white-space:nowrap;
}
.dmh-btn:hover{background:var(--dmh-hover);color:var(--dmh-label-primary)}
.dmh-btn:disabled{opacity:.45;cursor:not-allowed}
.dmh-btn.dmh-primary{background:var(--dmh-brand-primary);color:var(--dmh-bg-base);border-color:transparent}
.dmh-btn.dmh-primary:hover{opacity:.88}
.dmh-btn.dmh-danger{color:var(--dmh-danger-text);border-color:color-mix(in srgb,var(--dmh-danger-text) 45%,transparent)}
.dmh-btn.dmh-sm{padding:2px 7px;font-size:11px}

/* ===== 徽标 ===== */
.dmh-badge{font-size:10.5px;padding:1px 6px;border-radius:4px;font-weight:500;background:var(--dmh-bg-layer-3);color:var(--dmh-label-secondary)}
.dmh-badge.dmh-cur{background:var(--dmh-selected);color:var(--dmh-accent-text)}
.dmh-badge.dmh-free{background:color-mix(in srgb,var(--dmh-green-500) 16%,transparent);color:var(--dmh-success)}
.dmh-badge.dmh-err{background:color-mix(in srgb,var(--dmh-error) 14%,transparent);color:var(--dmh-error)}

/* ===== 开关 =====
 * 任务 10 起开关全部可点，类名 dmh-sw 改为 dmh-switch：
 * hover 有反馈、checked 是绿色；不存在"永久禁用"态，:disabled 只在忙时出现
 * （与 .dmh-btn:disabled 同样的 opacity 反馈，见 r1 修复：没有它，忙时按钮
 * 全变暗而开关保持全亮，视觉禁用反馈不一致）。 */
.dmh-switch{width:30px;height:17px;border-radius:9px;background:var(--dmh-border-l4);position:relative;flex:none;cursor:pointer;border:0;padding:0;transition:background .15s}
.dmh-switch:hover{background:color-mix(in srgb,var(--dmh-label-quaternary) 70%,var(--dmh-border-l4))}
.dmh-switch:focus-visible{outline:2px solid var(--dmh-accent-text);outline-offset:1px}
.dmh-switch.dmh-on{background:var(--dmh-success)}
.dmh-switch.dmh-on:hover{background:color-mix(in srgb,var(--dmh-success) 82%,#000)}
.dmh-switch::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px #0003}
.dmh-switch.dmh-on::after{transform:translateX(13px)}
.dmh-switch:disabled{opacity:.45;cursor:wait}

/* ===== 表格 ===== */
.dmh-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.dmh-table th{
  text-align:left;font-size:10.5px;font-weight:500;color:var(--dmh-label-tertiary);
  padding:8px 10px;border-bottom:1px solid var(--dmh-border-l2);white-space:nowrap;
  position:sticky;top:0;background:var(--dmh-card-fill);
}
.dmh-table th.dmh-num,.dmh-table td.dmh-num{text-align:right}
.dmh-table td{padding:7px 10px;font-size:11.5px;border-bottom:1px solid var(--dmh-border-l1);white-space:nowrap}
.dmh-table tbody tr:hover{background:var(--dmh-hover)}
.dmh-table td.dmh-mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11px}
.dmh-tps{color:var(--dmh-success);font-weight:500}
.dmh-tps.dmh-slow{color:var(--dmh-warn)}
.dmh-tps.dmh-na{color:var(--dmh-label-tertiary);font-weight:400}

/* ===== 记录页 ===== */
.dmh-sheet{width:920px;max-width:100%;background:var(--dmh-bg-base);border:1px solid var(--dmh-card-stroke);border-radius:10px;overflow:hidden}
.dmh-sheet-head{padding:14px 18px;border-bottom:1px solid var(--dmh-border-l1);display:flex;align-items:center;justify-content:space-between;gap:12px}
.dmh-filters{display:flex;gap:6px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--dmh-border-l1);flex-wrap:wrap}
.dmh-scope select{
  font:inherit;font-size:11.5px;padding:4px 8px;border-radius:6px;
  border:1px solid var(--dmh-border-l3);background:var(--dmh-card-fill);color:var(--dmh-label-primary);
}
.dmh-stat-row{display:flex;border-bottom:1px solid var(--dmh-border-l1)}
.dmh-stat{flex:1;padding:12px 18px;border-right:1px solid var(--dmh-border-l1)}
.dmh-stat:last-child{border-right:0}
.dmh-stat-k{font-size:10.5px;color:var(--dmh-label-tertiary);margin-bottom:3px}
.dmh-stat-v{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.dmh-stat-v small{font-size:11px;font-weight:400;color:var(--dmh-label-tertiary);margin-left:2px}
.dmh-table-wrap{max-height:340px;overflow:auto}

/* ===== 诊断 ===== */
.dmh-kv{display:grid;grid-template-columns:120px 1fr;font-size:11.5px}
.dmh-kv dt{padding:8px 16px;color:var(--dmh-label-tertiary);border-bottom:1px solid var(--dmh-border-l1)}
.dmh-kv dd{
  padding:8px 16px;border-bottom:1px solid var(--dmh-border-l1);
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11px;word-break:break-all;
}
.dmh-errbox{
  margin:10px 16px 14px;padding:10px 12px;border-radius:8px;font-size:11px;
  background:color-mix(in srgb,var(--dmh-error) 8%,transparent);
  border:1px solid color-mix(in srgb,var(--dmh-error) 25%,transparent);
  color:var(--dmh-label-secondary);font-family:ui-monospace,Consolas,monospace;line-height:1.6;
}
.dmh-note{font-size:11px;color:var(--dmh-label-tertiary);padding:10px 16px;line-height:1.6}
.dmh-strong{font-weight:600;color:var(--dmh-label-secondary)}
.dmh-spacer{flex:1}

/* 弹层 */
.dmh-overlay{
  position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(0,0,0,.45);
}
.dmh-overlay-body{max-height:84vh;overflow:auto;border-radius:10px}

/* ===== 渠道展开的模型列表（任务 10）===== */
.dmh-models{
  padding:6px 16px 10px 32px;             /* 相对行再缩进 16px，视觉上属于上一行渠道 */
  border-bottom:1px solid var(--dmh-border-l1);
  display:flex;flex-direction:column;gap:3px;background:var(--dmh-bg-layer-3);
}
.dmh-models-line{font-size:11px;color:var(--dmh-label-secondary);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dmh-models-name{color:var(--dmh-label-primary)}
.dmh-models-mult{color:var(--dmh-label-tertiary);font-variant-numeric:tabular-nums}

/* ===== 添加账号弹窗的表单 ===== */
.dmh-sheet-sm{width:520px;max-width:100%}
.dmh-form{display:flex;flex-direction:column;gap:12px;padding:14px 18px 16px}
.dmh-form label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dmh-label-tertiary)}
.dmh-form textarea,.dmh-form input{
  font:inherit;font-size:11.5px;padding:7px 9px;border-radius:6px;
  border:1px solid var(--dmh-border-l3);background:var(--dmh-card-fill);color:var(--dmh-label-primary);
}
.dmh-form textarea{
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  min-height:76px;                           /* 约 4 行等宽 */
  resize:vertical;word-break:break-all;
}
.dmh-form textarea:focus,.dmh-form input:focus{outline:2px solid var(--dmh-accent-text);outline-offset:-1px}
.dmh-form-hint{color:var(--dmh-danger-text)}
.dmh-form-actions{display:flex;justify-content:flex-end;gap:6px}

/* ===== 一键认证结果区（tabs 上方）===== */
.dmh-authbox{border-bottom:1px solid var(--dmh-border-l1);background:var(--dmh-bg-layer-3)}
.dmh-authline{display:flex;align-items:center;gap:8px;padding:7px 16px 0;font-size:11.5px;flex-wrap:wrap}
.dmh-authline-name{font-weight:600;color:var(--dmh-label-primary)}
.dmh-authline-detail{font-size:11px;color:var(--dmh-label-tertiary);word-break:break-all}
.dmh-authline-actions{display:flex;justify-content:flex-end;padding:6px 16px 8px}
`;

/**
 * 把样式表注入 `<head>`，返回「确保存在」的幂等函数。
 *
 * 幂等：弹层可能开多次、卡片可能同时挂在设置页，重复插入会产生多份
 * 同 id 的 `<style>`。按 id 判重即可。
 */
export function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
