import { describe, expect, it, beforeAll } from "vitest";
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
  it("每个 slot 都带 inject 回调（缺了会让模型选择器崩）", () => {
    expect(registered.length).toBeGreaterThan(0);
    for (const entry of registered) {
      expect(entry.options.inject, `slot ${entry.slot} 缺少 inject 回调`).toBeTypeOf("function");
    }
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
