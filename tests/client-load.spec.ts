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
            if (name === "react" || name === "react/jsx-runtime") return nodeRequire(name);
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
