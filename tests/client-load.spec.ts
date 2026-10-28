import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * 客户端产物的**加载测试**。
 *
 * 这一组存在的理由与 host 侧那次事故同源：产物能构建、能部署、
 * 文件也在对的位置，但「宿主加载它的时候」可能整个炸掉。
 * 所以这里模拟宿主的 `window.__ModuleLoader__.load`，真的把 client.js 跑一遍，
 * 检查它导出的 `name` / `inject` / `apply` 是否齐全、`apply` 会不会抛。
 *
 * 不 mock react —— 用真的 React 渲染一次组件，能抓到 hooks 用错、
 * 或 JSX 运行时拿错这类只在运行期暴露的问题。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(ROOT, "client.js");

/** 用 Node 自己的解析器拿真 react，别手写一个递归的假 require。 */
const nodeRequire = createRequire(import.meta.url);

interface Loaded {
  name: string;
  inject: string[];
  apply: (ctx: any) => void;
}

describe("client.js 能被宿主的 loader 加载", () => {
  let loaded: Loaded;
  const registered: { slot: string; options: any }[] = [];

  beforeAll(() => {
    if (!existsSync(CLIENT)) throw new Error(`client.js 不存在：${CLIENT}（先跑 pnpm build）`);

    const source = readFileSync(CLIENT, "utf8");

    // 模拟宿主的加载器：把 factory 跑起来，收集 module.exports。
    let captured: any;
    const fakeWindow: any = {
      __ModuleLoader__: {
        load(entry: { id: string; factory: (require: (name: string) => unknown) => unknown }) {
          const hostRequire = (name: string) => {
            // 宿主真实提供给客户端插件的模块集合（web 壳的 staticModules）：
            // react / react-dom / react-dom/client 都在里面。
            if (
              name === "react" ||
              name === "react/jsx-runtime" ||
              name === "react-dom" ||
              name === "react-dom/client"
            ) {
              return nodeRequire(name);
            }
            throw new Error(`unexpected require(${JSON.stringify(name)})`);
          };
          captured = entry.factory(hostRequire);
        },
      },
    };

    // 在函数作用域里求值，注入 fake window
    const run = new Function("window", "console", `${source}\nreturn window.__ModuleLoader__;`);
    run(fakeWindow, console);

    loaded = captured;
  });

  it("导出了 name / inject / apply", () => {
    expect(loaded.name).toBe("dsh-model-hub-client");
    expect(Array.isArray(loaded.inject)).toBe(true);
    expect(loaded.inject).toContain("slots");
    expect(typeof loaded.apply).toBe("function");
  });

  /**
   * 回归锚点：inject 必须与正常工作的参考插件一致。
   *
   * 实测事故（2026-10-28）：「模型选择器打不开」报
   * `cannot get property "remote.session" without inject`。
   *
   * 排查中曾误以为要加 `remote`，结果**更糟** —— 声明
   * `@deepseek-ai/dsh-api-remotes` 反而让宿主经由它去解析 `remote.session`。
   * 正常工作的 `dsh-connect-workbuddy` 用的是 4 项（不含 api-remotes）。
   *
   * 真正的修法是给 slot 传 inject 回调（见下一条测试）。
   * 这里守的是「不要自作聪明往 inject 里加 remote」。
   */
  it("inject 只声明自己用的服务，不含 remote（加了反而更糟）", () => {
    expect(loaded.inject).toContain("slots");
    expect(loaded.inject).toContain("locale");
    expect(loaded.inject).not.toContain("remote");
  });

  it("package.json 的 dsh.client.inject 不含 api-remotes", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const declared: string[] = pkg.dsh?.client?.inject ?? [];
    expect(declared).not.toContain("@deepseek-ai/dsh-api-remotes");
    // 但该有的得有
    expect(declared).toContain("@deepseek-ai/dsh-client-ui-slots");
    expect(declared).toContain("@deepseek-ai/dsh-client-locale");
  });

  it("apply 不抛，并注册了预期的 slot", () => {
    const ctx = {
      slots: {
        inject(_name: string, cb: () => unknown) {
          return cb();
        },
        register(options: any) {
          registered.push({ slot: options.name, options });
          return () => {};
        },
      },
    };

    expect(() => loaded.apply(ctx)).not.toThrow();

    const slots = registered.map((r) => r.slot);
    // 设置卡片两处 + 左下角入口
    expect(slots).toContain("plugins.bundle.config");
    expect(slots).toContain("plugins.row.config");
    expect(slots).toContain("sidebar.footer.action");
  });

  /**
   * 回归锚点：**每个 slot 都必须带 `inject` 回调，无例外**。
   *
   * 实测事故（2026-10-28，踩了两次）：不传 `inject` 时宿主走默认注入路径，
   * 会调 `directoryFor()` 去要 `remote.session`，而那个服务不在我们的
   * 声明里 —— 于是抛出
   * `cannot get property "remote.session" without inject`，
   * 把**模型选择器**整个打不开（实测现象：选择器里一个模型都没有，
   * 只剩「模型名 / 推理等级」两行）。
   *
   * 第二次是这样踩的：`conversation.input.model.label` 看参考实现的源码
   * 注册时只传了 name + priority，就判断"这个槽不需要 inject"。
   * 结果它同样炸 —— 参考实现没炸是因为它的静态 inject 数组多声明了服务，
   * 不能反推"这个槽不需要 inject"。所以这里**不再留任何例外**。
   */
  it("除模型标签槽外，每个 slot 都带 inject 回调（缺了会让模型选择器崩）", () => {
    expect(registered.length).toBeGreaterThan(0);
    for (const entry of registered) {
      if (entry.slot === "conversation.input.model.label") continue;
      expect(entry.options.inject, `slot ${entry.slot} 缺少 inject 回调`).toBeTypeOf("function");
    }
  });

  /**
   * 模型标签槽的形状必须与参考实现一致。
   *
   * 两次踩坑后的结论：
   * 1. **priority 必须是负数**（参考实现 -0.5）。用 30 时组件根本没被调用 ——
   *    宿主默认渲染占住了槽，我的组件一次都没渲染（探针数组为空证实）。
   * 2. **不传 inject**：该槽宿主直接传 { provider, model, placement }。
   *    与其它槽相反，这是参考实现的确切形状。
   */
  it("模型标签槽用负 priority 且不传 inject（与参考实现对齐）", () => {
    const entry = registered.find((r) => r.slot === "conversation.input.model.label");
    expect(entry, "模型标签槽没有注册").toBeDefined();
    expect(entry!.options.priority).toBeLessThan(0);
    expect(entry!.options.inject).toBeUndefined();
  });

  it("某个 slot 注册失败时，apply 仍然不抛（否则会连累宿主）", () => {
    const ctx = {
      slots: {
        inject() {
          throw new Error("slot does not exist in this host version");
        },
        register() {
          throw new Error("should not reach");
        },
      },
    };

    // 每个 slot 单独 try/catch —— 全挂也不能抛到加载期
    expect(() => loaded.apply(ctx)).not.toThrow();
  });

  it("ctx.slots 整个缺失时也不抛", () => {
    expect(() => loaded.apply({} as any)).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 任务 10：解禁后的交互断言 —— 以真 React 渲染 `HubCard`。
//
// 为什么手写假 DOM：仓库约束「无新依赖」，jsdom / happy-dom 都没装。
// 而 React 客户端渲染真正碰到的 DOM 面很小：一棵节点树、属性/样式的直接
// 赋值、以及**事件委托**——React 把全部监听挂到 `createRoot` 的容器上，
// 触发时只要拿容器的监听表调一遍即可。所以一个 ~120 行的假对象就够跑
// `createRoot` + `act` + 派发 click，不需要真的实现 DOM 标准。
//
// 仍然遵守本文件的立意：fetch mock 成形如各只读/写路由的响应，
// 让组件走真实的数据流（useEffect → load() → setState → 渲染）。
// ══════════════════════════════════════════════════════════════════════════

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HubCard } from "../src/client/HubCard.js";

/** 文本节点：React 只会读写 `nodeValue`。 */
function createFakeText(text: string) {
  return { nodeType: 3, nodeValue: text, parentNode: null } as any;
}

/**
 * 假元素。要点：
 * - `style` 是普通对象 + setProperty 占位 —— React 对样式做的是逐键赋值；
 * - 属性进 Map（`className` 转发到 class），`disabled`/`value` 等走真属性；
 * - `click()` 向上找根容器并调用其全部 click 监听 —— 这就是 React 的委托入口。
 */
class FakeElement {
  nodeType = 1;
  tagName: string;
  parentNode: FakeElement | null = null;
  childNodes: any[] = [];
  ownerDocument: any;
  style: Record<string, unknown> & { setProperty: (name: string, value: string) => void } = Object.assign(
    {} as Record<string, unknown>,
    { setProperty: () => {} },
  );
  listeners = new Map<string, ((event: any) => void)[]>();
  attributes = new Map<string, string>();
  disabled = false;
  value = "";
  checked = false;
  hidden = false;
  private text: string | null = null;

  constructor(tag: string, doc: any) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }
  set className(value: string) {
    this.attributes.set("class", value);
  }
  get firstChild(): any {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): any {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get textContent(): string {
    if (this.text !== null) return this.text;
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.childNodes = [];
  }
  appendChild(child: any): any {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.text = null;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: any, before: any): any {
    child.parentNode?.removeChild(child);
    const index = before === null ? -1 : this.childNodes.indexOf(before);
    this.text = null;
    if (index === -1) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: any): any {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((fn) => fn !== listener));
  }
  click(): void {
    let node: any = this;
    while (node.parentNode !== null) node = node.parentNode;
    const event = {
      type: "click",
      target: this,
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 1,
      defaultPrevented: false,
      preventDefault() {},
      stopPropagation() {},
    };
    for (const listener of node.listeners?.get("click") ?? []) listener(event);
  }
  focus(): void {}
  blur(): void {}
}

/** 假 document：ensureStyles 要 getElementById / createElement / head；Esc 监听走 addEventListener。 */
class FakeDocument {
  nodeType = 9;
  head = new FakeElement("head", this);
  body = new FakeElement("body", this);
  documentElement = new FakeElement("html", this);
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createTextNode(text: string): any {
    return createFakeText(text);
  }
  createComment(): any {
    return { nodeType: 8, nodeValue: "", parentNode: null };
  }
  getElementById(): null {
    return null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function walk(node: any, out: any[] = []): any[] {
  out.push(node);
  for (const child of node.childNodes ?? []) walk(child, out);
  return out;
}

describe("解禁后的 HubCard 交互（真 React 渲染）", () => {
  const PREFIX = "/plugins/dsh-model-hub";
  const CHANNEL_ID = "hub-workbuddy-global";
  const ACCOUNT_ID = `${CHANNEL_ID}:alice`;
  // 熔断中：cooldown_until 在未来 —— 状态点应变 err、meta 应出现「熔断中（至 …）」
  const COOLDOWN_UNTIL = Date.now() + 5 * 60_000;

  const responses: Record<string, unknown> = {
    [`${PREFIX}/summary`]: {
      date: "2026-10-28", requests: 0, ok: 0, tokens: 0, costUnits: 0, avgTtftMs: null, avgTps: null,
    },
    [`${PREFIX}/channels`]: {
      channels: [
        { id: CHANNEL_ID, kind: "workbuddy", display_name: "WorkBuddy Global", enabled: 1, today_requests: 3, today_tokens: 1200 },
      ],
      accounts: [
        {
          id: ACCOUNT_ID, channel_id: CHANNEL_ID, display_name: "alice", enabled: 1, is_current: 1,
          consecutive_failures: 3, cooldown_until: COOLDOWN_UNTIL, last_error: "HTTP 401 Unauthorized",
          last_ok_at: null, created_at: 0, has_credential: 1,
        },
      ],
      models_by_channel: {
        [CHANNEL_ID]: [
          { id: "deepseek-chat", name: "DeepSeek Chat", creditMultiplier: 1 },
          { id: "deepseek-reasoner", name: "DeepSeek Reasoner", creditMultiplier: 4, promotionBadge: "限时免费", tierBadge: "Pro" },
        ],
      },
    },
    [`${PREFIX}/records?limit=4`]: { requests: [], models: [] },
    [`${PREFIX}/catalog`]: { models: [] },
    [`${PREFIX}/diag`]: {
      recordCount: 5, oldestRecordAt: null, lastError: null,
      currentChannelId: CHANNEL_ID, currentAccountId: ACCOUNT_ID, currentAccountName: "alice",
      recordEnabled: true, retentionDays: 90,
    },
  };

  const fakeFetch = ((input: RequestInfo | URL) => {
    const body = responses[String(input)];
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: `mock 未覆盖 ${String(input)}` }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  }) as typeof fetch;

  let container: FakeElement;
  let root: Root;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; // act() 需要，否则 React 拒绝刷工作
    // react-dom 的 getCurrentEventPriority 直接读 `window.event`（无 typeof 守卫），
    // node 环境里必须有一个 window；指到 globalThis 本身即可（window.event === undefined）。
    (globalThis as any).window = globalThis;
    // getActiveElementDeep 里 `element instanceof win.HTMLIFrameElement` 的右边必须是个构造器，
    // 否则 commit 阶段直接 TypeError；给个空类让它 instanceof 为 false 即可。
    (globalThis as any).HTMLIFrameElement = class HTMLIFrameElement {};
    (globalThis as any).document = new FakeDocument();
    globalThis.fetch = fakeFetch;

    container = new FakeElement("div", (globalThis as any).document);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => {
      root.render(React.createElement(HubCard));
    });
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const buttons = (): FakeElement[] => walk(container).filter((n) => n.nodeType === 1 && n.tagName === "BUTTON");
  const buttonByLabel = (label: string): FakeElement | undefined =>
    buttons().find((b) => b.textContent === label);
  // React 18 对 `disabled` 走 setAttribute（不再是 DOM property），两边都要看。
  const isDisabled = (button: FakeElement): boolean => button.disabled || button.hasAttribute("disabled");

  it("「一键认证」「+ 添加账号」「测试」「删除」不再是 disabled", () => {
    for (const label of ["一键认证", "+ 添加账号", "测试", "删除"]) {
      const button = buttonByLabel(label);
      expect(button, `按钮「${label}」应该渲染`).toBeDefined();
      expect(isDisabled(button!), `按钮「${label}」应该可点`).toBe(false);
    }
  });

  it("渠道行有「展开」按钮，点击后出现 models_by_channel 里的模型名", async () => {
    const tab = buttonByLabel("渠道");
    expect(tab).toBeDefined();
    await act(async () => {
      tab!.click();
    });
    const expand = buttonByLabel("展开 ▾");
    expect(expand, "渠道行应该有「展开 ▾」按钮").toBeDefined();
    await act(async () => {
      expand!.click();
    });
    expect(container.textContent).toContain("DeepSeek Chat");
    expect(container.textContent).toContain("DeepSeek Reasoner");
  });

  it("诊断栏出现「记录」行与「保留天数」，熔断中的账号标出「熔断中」", async () => {
    const tab = buttonByLabel("诊断");
    expect(tab).toBeDefined();
    await act(async () => {
      tab!.click();
    });
    const dts = walk(container).filter((n) => n.nodeType === 1 && n.tagName === "DT");
    expect(dts.some((n) => n.textContent === "记录"), "诊断栏应有「记录」一行").toBe(true);
    expect(container.textContent).toContain("保留天数");
    expect(container.textContent).toContain("熔断中（至");
  });

  it("构建产物 client.js 里带上了新的写路由调用（先 build 再 test 才有意义）", () => {
    const source = readFileSync(CLIENT, "utf8");
    expect(source).toContain("auth/one-click");
    expect(source).toContain("records/clear");
  });
});
