/**
 * 面板样式 —— **黑金（深色）/ 香槟（浅色）双主题**。
 *
 * 为什么用注入而不是 CSS Module / 内联样式：
 * 客户端插件是运行时加载的，宿主不处理我们的样式文件；一张 `<style>` + 语义
 * class 最直接，也最好核对。
 *
 * 类名统一加 `dmh-` 前缀：宿主自己也在用 `.row` `.card` `.badge` `.stat`
 * 这类通名，不加前缀会串到宿主的界面上。
 *
 * 主题策略（用户拍板 2026-10-29）：
 *   · 深色 → 黑金：墨底 + 金线边框 + 金色主按钮/开关/选中态
 *   · 浅色 → 香槟：米白底 + 深金棕文字 + 同一套金色边框
 * 两套共用 `--dmh-gold-*` 刻度，只换语义令牌，所以品牌感一致而不互串。
 * 深色由 `body[data-ds-dark-theme]`（宿主主题）或 `.dmh-scope[data-dmh-dark]`
 * （强制）触发；不写死颜色，全部走变量。
 *
 * 排版：正文字体栈用 Segoe UI Variable Text → Noto Sans SC → 微软雅黑 UI
 * （Win11 可变字体小字号 hinting 明显好于常规雅黑）；等宽用 Cascadia Mono。
 * 字号分级 14 / 13.5 / 12.5 / 11.5 / 11 / 10.5，行高 1.6–1.85，
 * 所有数字列 `tabular-nums` 对齐。
 */

export const STYLE_ELEMENT_ID = "dsh-model-hub-styles";

export const CSS = `
.dmh-scope{
  /* ── 金色刻度（两套主题共用）── */
  --dmh-gold-050:#FBF3DC; --dmh-gold-100:#F3E3B3; --dmh-gold-200:#E9D08A;
  --dmh-gold-300:#E3C46A; --dmh-gold-400:#D4AF37; --dmh-gold-500:#C9A227;
  --dmh-gold-600:#A8841C; --dmh-gold-700:#7A5F14;

  --dmh-font:"Segoe UI Variable Text","Segoe UI","Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  --dmh-font-mono:"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,monospace;

  /* ── 香槟（浅色，默认）── */
  --dmh-bg-base:#FDFBF6;
  --dmh-bg-layer-2:#FFFDF8;
  --dmh-bg-layer-3:#F7F1E4;
  --dmh-card-bg:linear-gradient(180deg,#FFFDF8 0%,#FAF5EA 100%);
  --dmh-card-inner:inset 0 1px 0 rgba(255,255,255,.85);
  --dmh-scrim:rgba(36,31,22,.38);

  --dmh-label-primary:#241F16;
  --dmh-label-secondary:#4A4237;
  --dmh-label-tertiary:#6E655A;
  --dmh-label-quaternary:#A39A8C;

  --dmh-border-l1:rgba(120,95,30,.10);
  --dmh-border-l2:rgba(120,95,30,.16);
  --dmh-border-l3:rgba(120,95,30,.24);
  --dmh-border-l4:rgba(120,95,30,.32);

  --dmh-gold-line:rgba(168,132,28,.28);
  --dmh-gold-line-strong:rgba(168,132,28,.50);
  --dmh-gold-wash:rgba(212,175,55,.12);
  --dmh-gold-wash-2:rgba(212,175,55,.22);
  --dmh-gold-text:#6B5310;
  --dmh-title-grad:linear-gradient(180deg,#8A6A16,#5E460D);

  --dmh-card-fill:#FFFDF8;
  --dmh-card-stroke:rgba(168,132,28,.30);
  --dmh-hover:rgba(212,175,55,.09);
  --dmh-selected:rgba(212,175,55,.22);
  --dmh-accent-text:#7A5F14;

  --dmh-success:#2E7D4F; --dmh-error:#B23A2A; --dmh-warn:#9A6B12;
  --dmh-danger-text:#B23A2A;
  --dmh-on-gold:#1A1508;

  color:var(--dmh-label-primary);
  font:13px/1.6 var(--dmh-font);
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}

body[data-ds-dark-theme] .dmh-scope,
.dmh-scope[data-dmh-dark]{
  /* ── 黑金（深色）── */
  --dmh-bg-base:#0E0E10;
  --dmh-bg-layer-2:#151517;
  --dmh-bg-layer-3:#1A1A1D;
  --dmh-card-bg:linear-gradient(180deg,#151517 0%,#101012 100%);
  --dmh-card-inner:inset 0 1px 0 rgba(251,243,220,.045);
  --dmh-scrim:rgba(4,4,5,.72);

  --dmh-label-primary:#EDE9E1;
  --dmh-label-secondary:#B6B0A5;
  --dmh-label-tertiary:#8A857C;
  --dmh-label-quaternary:#5E5A53;

  --dmh-border-l1:rgba(255,255,255,.055);
  --dmh-border-l2:rgba(255,255,255,.09);
  --dmh-border-l3:rgba(255,255,255,.14);
  --dmh-border-l4:rgba(255,255,255,.20);

  --dmh-gold-line:rgba(212,175,55,.20);
  --dmh-gold-line-strong:rgba(212,175,55,.38);
  --dmh-gold-wash:rgba(212,175,55,.08);
  --dmh-gold-wash-2:rgba(212,175,55,.14);
  --dmh-gold-text:#F3E3B3;
  --dmh-title-grad:linear-gradient(180deg,#F3E3B3,#D4AF37);

  --dmh-card-fill:#151517;
  --dmh-card-stroke:rgba(212,175,55,.20);
  --dmh-hover:rgba(212,175,55,.045);
  --dmh-selected:rgba(212,175,55,.14);
  --dmh-accent-text:#E9D08A;

  --dmh-success:#5CB47E; --dmh-error:#E06A5A; --dmh-warn:#D9A441;
  --dmh-danger-text:#F0938A;
  --dmh-on-gold:#1A1508;
}

.dmh-scope *{box-sizing:border-box;margin:0;padding:0}
.dmh-scope code{
  font-family:var(--dmh-font-mono);font-size:11px;padding:1.5px 6px;border-radius:5px;
  background:var(--dmh-gold-wash);border:1px solid var(--dmh-gold-line);
  color:var(--dmh-gold-text);white-space:nowrap;
}

/* ===== 卡片：金线外框 + 内高光 + 纵向渐变卡面 ===== */
.dmh-card{
  background:var(--dmh-card-bg);
  border:1px solid var(--dmh-card-stroke);
  border-radius:14px;overflow:hidden;
  box-shadow:var(--dmh-card-inner),0 24px 48px -32px rgba(0,0,0,.55);
}
.dmh-card-head{
  padding:15px 18px;border-bottom:1px solid var(--dmh-gold-line);
  display:flex;align-items:center;justify-content:space-between;gap:14px;
  background:linear-gradient(180deg,var(--dmh-gold-wash),transparent);
}
.dmh-card-title{
  font-size:14px;font-weight:600;letter-spacing:.01em;
  background:var(--dmh-title-grad);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  width:fit-content;
}
.dmh-card-desc{font-size:11.5px;color:var(--dmh-label-tertiary);margin-top:3px;line-height:1.55}

/* ===== tab：选中态金线 + 微光 ===== */
.dmh-tabs{
  display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--dmh-border-l1);
  background:var(--dmh-bg-layer-3);
}
.dmh-tabs button{
  font:inherit;font-size:12px;padding:10px 13px;border:0;background:none;cursor:pointer;
  color:var(--dmh-label-tertiary);border-bottom:2px solid transparent;margin-bottom:-1px;
  transition:color .14s,border-color .14s;
}
.dmh-tabs button:hover{color:var(--dmh-label-secondary)}
.dmh-tabs button.dmh-on{
  color:var(--dmh-gold-text);border-bottom-color:var(--dmh-gold-400);font-weight:600;
}
.dmh-panel{display:block;padding:4px 0}
.dmh-panel[hidden]{display:none}

/* ===== 行 ===== */
.dmh-row{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--dmh-border-l1)}
.dmh-row:last-child{border-bottom:0}
.dmh-row:hover{background:var(--dmh-hover)}
.dmh-row.dmh-group{
  background:var(--dmh-gold-wash);padding:8px 18px;
  border-bottom:1px solid var(--dmh-gold-line);
}
.dmh-row-main{flex:1;min-width:0}
.dmh-row-name{font-size:12.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;line-height:1.5}
.dmh-row-meta{
  font-size:11px;color:var(--dmh-label-tertiary);margin-top:3px;line-height:1.6;
  font-variant-numeric:tabular-nums;
}
.dmh-dot{width:6px;height:6px;border-radius:50%;flex:none}
.dmh-dot.dmh-ok{background:var(--dmh-success);box-shadow:0 0 8px -1px var(--dmh-success)}
.dmh-dot.dmh-err{background:var(--dmh-error);box-shadow:0 0 8px -1px var(--dmh-error)}
.dmh-dot.dmh-warn{background:var(--dmh-warn)}
.dmh-dot.dmh-off{background:var(--dmh-label-quaternary)}

/* ===== 按钮 ===== */
.dmh-btn{
  font:inherit;font-size:11.5px;padding:5px 11px;border-radius:7px;cursor:pointer;
  border:1px solid var(--dmh-border-l3);background:transparent;color:var(--dmh-label-secondary);
  white-space:nowrap;transition:border-color .14s,background .14s,color .14s;
}
.dmh-btn:hover{border-color:var(--dmh-gold-line-strong);color:var(--dmh-gold-text);background:var(--dmh-gold-wash)}
.dmh-btn:disabled{opacity:.45;cursor:not-allowed}
.dmh-btn.dmh-primary{
  background:linear-gradient(180deg,var(--dmh-gold-300),var(--dmh-gold-500));
  border-color:var(--dmh-gold-600);color:var(--dmh-on-gold);font-weight:600;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 4px 12px -6px rgba(212,175,55,.7);
}
.dmh-btn.dmh-primary:hover{filter:brightness(1.08);color:var(--dmh-on-gold)}
.dmh-btn.dmh-danger{color:var(--dmh-danger-text);border-color:color-mix(in srgb,var(--dmh-danger-text) 40%,transparent)}
.dmh-btn.dmh-danger:hover{
  background:color-mix(in srgb,var(--dmh-danger-text) 10%,transparent);
  border-color:color-mix(in srgb,var(--dmh-danger-text) 60%,transparent);
  color:var(--dmh-danger-text);
}
.dmh-btn.dmh-sm{padding:3px 8px;font-size:11px}
/* 「?」这类图标钮：正圆，比文字钮矮 */
.dmh-btn.dmh-icon{
  width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;
  border-radius:50%;font-size:12px;line-height:1;
}

/* ===== 徽标 ===== */
.dmh-badge{
  font-size:10.5px;padding:1.5px 7px;border-radius:5px;font-weight:500;
  background:var(--dmh-bg-layer-3);color:var(--dmh-label-secondary);
  border:1px solid var(--dmh-border-l1);line-height:1.5;
}
.dmh-badge.dmh-cur{
  background:var(--dmh-gold-wash-2);color:var(--dmh-gold-text);border-color:var(--dmh-gold-line-strong);
}
.dmh-badge.dmh-free{
  background:color-mix(in srgb,var(--dmh-success) 14%,transparent);
  color:var(--dmh-success);border-color:color-mix(in srgb,var(--dmh-success) 30%,transparent);
}
.dmh-badge.dmh-err{
  background:color-mix(in srgb,var(--dmh-error) 13%,transparent);
  color:var(--dmh-error);border-color:color-mix(in srgb,var(--dmh-error) 32%,transparent);
}

/* ===== 开关：开启 = 金色渐变 + 光晕，滑块转深墨 =====
 * 任务 10 起开关全部可点，类名 dmh-sw 改为 dmh-switch：hover 有反馈、checked
 * 是金色；不存在"永久禁用"态，:disabled 只在忙时出现（与 .dmh-btn:disabled
 * 同样的 opacity 反馈，忙时按钮变暗而开关全亮会显得不一致）。 */
.dmh-switch{
  width:32px;height:18px;border-radius:9px;background:var(--dmh-border-l4);
  position:relative;flex:none;cursor:pointer;border:1px solid var(--dmh-border-l1);
  padding:0;transition:background .16s,border-color .16s,box-shadow .16s;
}
.dmh-switch:hover{background:var(--dmh-gold-wash-2)}
.dmh-switch:focus-visible{outline:2px solid var(--dmh-accent-text);outline-offset:2px}
.dmh-switch.dmh-on{
  background:linear-gradient(180deg,var(--dmh-gold-400),var(--dmh-gold-600));
  border-color:var(--dmh-gold-600);
  box-shadow:0 0 12px -2px rgba(212,175,55,.55);
}
.dmh-switch.dmh-on:hover{filter:brightness(1.06)}
.dmh-switch::after{
  content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:#CFC9BF;transition:transform .16s,background .16s;
}
.dmh-switch.dmh-on::after{transform:translateX(14px);background:var(--dmh-on-gold)}
.dmh-switch:disabled{opacity:.45;cursor:wait}

/* ===== 表格 ===== */
.dmh-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.dmh-table th{
  text-align:left;font-size:10.5px;font-weight:500;color:var(--dmh-label-tertiary);
  letter-spacing:.04em;padding:9px 12px;border-bottom:1px solid var(--dmh-gold-line);
  white-space:nowrap;position:sticky;top:0;background:var(--dmh-bg-layer-2);
}
.dmh-table th.dmh-num,.dmh-table td.dmh-num{text-align:right}
.dmh-table td{
  padding:8px 12px;font-size:11.5px;border-bottom:1px solid var(--dmh-border-l1);
  white-space:nowrap;color:var(--dmh-label-secondary);
}
.dmh-table tbody tr:hover{background:var(--dmh-hover)}
.dmh-table td.dmh-mono{font-family:var(--dmh-font-mono);font-size:11px;color:var(--dmh-label-tertiary)}
.dmh-tps{color:var(--dmh-gold-text);font-weight:600}
.dmh-tps.dmh-slow{color:var(--dmh-warn)}
.dmh-tps.dmh-na{color:var(--dmh-label-tertiary);font-weight:400}

/* ===== 记录页 ===== */
.dmh-sheet{
  width:920px;max-width:100%;background:var(--dmh-card-bg);
  border:1px solid var(--dmh-card-stroke);border-radius:14px;overflow:hidden;
  box-shadow:var(--dmh-card-inner),0 32px 64px -24px rgba(0,0,0,.6);
}
.dmh-sheet-head{
  padding:16px 20px;border-bottom:1px solid var(--dmh-gold-line);
  display:flex;align-items:flex-start;justify-content:space-between;gap:14px;
  background:linear-gradient(180deg,var(--dmh-gold-wash),transparent);
}
.dmh-filters{
  display:flex;gap:6px;align-items:center;padding:11px 20px;
  border-bottom:1px solid var(--dmh-border-l1);flex-wrap:wrap;
}
.dmh-scope select{
  font:inherit;font-size:11.5px;padding:4px 8px;border-radius:6px;
  border:1px solid var(--dmh-border-l3);background:var(--dmh-card-fill);color:var(--dmh-label-primary);
}
.dmh-scope select:hover{border-color:var(--dmh-gold-line-strong)}
.dmh-scope select:focus-visible{outline:2px solid var(--dmh-accent-text);outline-offset:1px}
.dmh-stat-row{display:flex;border-bottom:1px solid var(--dmh-border-l1)}
.dmh-stat{flex:1;padding:13px 20px;border-right:1px solid var(--dmh-border-l1)}
.dmh-stat:last-child{border-right:0}
.dmh-stat-k{font-size:10.5px;color:var(--dmh-label-tertiary);margin-bottom:4px;letter-spacing:.02em}
.dmh-stat-v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.3px;line-height:1.3}
.dmh-stat-v small{font-size:11px;font-weight:400;color:var(--dmh-label-tertiary);margin-left:3px}
.dmh-table-wrap{max-height:340px;overflow:auto}

/* ===== 诊断 ===== */
.dmh-kv{display:grid;grid-template-columns:120px 1fr;font-size:11.5px}
.dmh-kv dt{
  padding:8px 18px;color:var(--dmh-label-tertiary);
  border-bottom:1px solid var(--dmh-border-l1);line-height:1.7;
}
.dmh-kv dd{
  padding:8px 18px;border-bottom:1px solid var(--dmh-border-l1);line-height:1.7;
  font-family:var(--dmh-font-mono);font-size:11px;word-break:break-all;color:var(--dmh-label-secondary);
}
.dmh-errbox{
  margin:11px 18px 15px;padding:10px 12px;border-radius:9px;font-size:11px;line-height:1.7;
  background:color-mix(in srgb,var(--dmh-error) 8%,transparent);
  border:1px solid color-mix(in srgb,var(--dmh-error) 26%,transparent);
  color:var(--dmh-label-secondary);font-family:var(--dmh-font-mono);
}
.dmh-note{font-size:11px;color:var(--dmh-label-tertiary);padding:11px 18px;line-height:1.7}
.dmh-strong{font-weight:600;color:var(--dmh-label-primary)}
.dmh-spacer{flex:1}

/* 弹层 */
.dmh-overlay{
  position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
  padding:24px;background:var(--dmh-scrim);backdrop-filter:blur(3px);
}
.dmh-overlay-body{max-height:84vh;overflow:auto;border-radius:14px}
/* 说明弹层自己管滚动（左目录 + 右正文），外层不能再滚一次 */
.dmh-overlay.dmh-overlay-help .dmh-overlay-body{overflow:hidden;display:flex}
.dmh-overlay.dmh-overlay-help .dmh-sheet{display:flex;flex-direction:column;max-height:84vh;width:860px}

/* ===== 渠道展开的模型列表 ===== */
.dmh-models{
  padding:7px 18px 11px 34px;             /* 相对行再缩进 16px，视觉上属于上一行渠道 */
  border-bottom:1px solid var(--dmh-border-l1);
  display:flex;flex-direction:column;gap:4px;background:var(--dmh-bg-layer-3);
}
.dmh-models-line{
  font-size:11px;color:var(--dmh-label-secondary);
  display:flex;align-items:center;gap:7px;flex-wrap:wrap;line-height:1.6;
}
.dmh-models-name{color:var(--dmh-label-primary)}
.dmh-models-mult{color:var(--dmh-label-tertiary);font-variant-numeric:tabular-nums}

/* ===== 添加账号弹窗的表单 ===== */
.dmh-sheet-sm{width:520px;max-width:100%}
.dmh-form{display:flex;flex-direction:column;gap:12px;padding:15px 20px 17px}
.dmh-form label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dmh-label-tertiary)}
.dmh-form textarea,.dmh-form input{
  font:inherit;font-size:11.5px;padding:8px 10px;border-radius:7px;
  border:1px solid var(--dmh-border-l3);background:var(--dmh-card-fill);color:var(--dmh-label-primary);
}
.dmh-form textarea{
  font-family:var(--dmh-font-mono);
  min-height:76px;                           /* 约 4 行等宽 */
  resize:vertical;word-break:break-all;
}
.dmh-form textarea:focus,.dmh-form input:focus{outline:2px solid var(--dmh-accent-text);outline-offset:-1px}
.dmh-form-hint{color:var(--dmh-danger-text)}
.dmh-form-actions{display:flex;justify-content:flex-end;gap:6px}

/* ===== 一键认证结果区（tabs 上方）===== */
.dmh-authbox{border-bottom:1px solid var(--dmh-gold-line);background:var(--dmh-gold-wash)}
.dmh-authline{display:flex;align-items:center;gap:8px;padding:8px 18px 0;font-size:11.5px;flex-wrap:wrap}
.dmh-authline-name{font-weight:600;color:var(--dmh-label-primary)}
.dmh-authline-detail{font-size:11px;color:var(--dmh-label-tertiary);word-break:break-all;line-height:1.6}
.dmh-authline-actions{display:flex;justify-content:flex-end;padding:7px 18px 9px}

/* ══════════ 「?」使用说明弹层：左目录 + 右正文 ══════════ */
.dmh-help{display:grid;grid-template-columns:176px 1fr;min-height:0;flex:1}
.dmh-help-nav{
  border-right:1px solid var(--dmh-border-l1);padding:14px 10px;
  background:var(--dmh-bg-layer-3);
  display:flex;flex-direction:column;gap:2px;overflow:auto;flex:none;
}
.dmh-help-nav button{
  font:inherit;font-size:11.5px;text-align:left;padding:7px 10px;border-radius:7px;border:0;
  background:none;color:var(--dmh-label-tertiary);cursor:pointer;line-height:1.45;
  transition:background .13s,color .13s;display:flex;gap:8px;align-items:baseline;
}
.dmh-help-nav button:hover{background:var(--dmh-hover);color:var(--dmh-label-secondary)}
.dmh-help-nav button.dmh-on{
  background:var(--dmh-gold-wash-2);color:var(--dmh-gold-text);font-weight:600;
}
.dmh-help-idx{
  font-family:var(--dmh-font-mono);font-size:10px;color:var(--dmh-gold-600);flex:none;
}
.dmh-help-nav button.dmh-on .dmh-help-idx{color:var(--dmh-gold-500)}

.dmh-help-body{padding:2px 26px 26px;overflow:auto;max-width:672px}
.dmh-help-sec{padding:20px 0 6px;border-top:1px solid var(--dmh-border-l1)}
.dmh-help-sec:first-child{border-top:0;padding-top:18px}
.dmh-help-sec-title{
  display:flex;align-items:center;gap:9px;font-size:13.5px;font-weight:600;
  color:var(--dmh-gold-text);letter-spacing:.01em;margin-bottom:11px;line-height:1.5;
}
.dmh-help-sec-title::before{
  content:"";width:3px;height:14px;border-radius:2px;flex:none;
  background:linear-gradient(180deg,var(--dmh-gold-300),var(--dmh-gold-600));
  box-shadow:0 0 10px -1px rgba(212,175,55,.6);
}
.dmh-help-lead{font-size:12.5px;line-height:1.85;color:var(--dmh-label-secondary);margin-bottom:12px}
.dmh-help-lead strong{color:var(--dmh-gold-text);font-weight:600}
.dmh-help-list{list-style:none;display:flex;flex-direction:column;gap:9px}
.dmh-help-list li{
  position:relative;padding-left:16px;font-size:12.5px;line-height:1.8;
  color:var(--dmh-label-secondary);
}
.dmh-help-list li::before{
  content:"";position:absolute;left:0;top:9px;width:5px;height:5px;border-radius:1.5px;
  background:var(--dmh-gold-500);transform:rotate(45deg);
}
.dmh-help-list li strong,.dmh-help-list li b{color:var(--dmh-label-primary);font-weight:600}
.dmh-help-kv{
  display:flex;flex-direction:column;gap:1px;border-radius:9px;overflow:hidden;
  border:1px solid var(--dmh-border-l1);margin-bottom:12px;
}
.dmh-help-kv div{
  display:grid;grid-template-columns:122px 1fr;gap:10px;padding:9px 12px;
  background:var(--dmh-gold-wash);font-size:11.5px;line-height:1.7;
}
.dmh-help-kv div:nth-child(even){background:transparent}
.dmh-help-kv dt{color:var(--dmh-label-tertiary)}
.dmh-help-kv dd{color:var(--dmh-label-secondary)}
.dmh-help-tip{
  display:flex;gap:9px;padding:10px 12px;border-radius:9px;margin-top:12px;
  font-size:11.5px;line-height:1.75;
  background:var(--dmh-gold-wash);border:1px solid var(--dmh-gold-line);
  color:var(--dmh-label-secondary);
}
.dmh-help-tip .dmh-help-mark{color:var(--dmh-gold-500);font-weight:700;flex:none}
.dmh-help-tip b{color:var(--dmh-label-primary);font-weight:600}
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
