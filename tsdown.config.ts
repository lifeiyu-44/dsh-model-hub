import { defineConfig } from "tsdown";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * 双入口构建。
 *
 * - `src/index.ts`  -> `lib/index.js`   宿主侧（provider / shim / 路由）
 * - `src/client/index.ts` -> `lib/client.js`  浏览器侧（面板 UI）
 *
 * 两者格式不同：
 * - host 是普通 ESM，宿主用 `import()` 加载；
 * - client 必须包成 `window.__ModuleLoader__.load({ id, factory })`，
 *   因为宿主给客户端插件注入 `require`（react / react-dom 由它提供），
 *   自己 import 会拿到另一个 React 实例，hooks 直接崩。
 *
 * 所以 client 走一个独立的构建配置，产物再套一层 loader 外壳。
 */

const HOST_CONFIG = {
  entry: ["src/index.ts"],
  format: ["esm"] as const,
  platform: "node" as const,
  target: "node22",
  dts: true,
  outDir: "lib",
  // 产物名固定成 index.js / index.d.ts，与 package.json 的 main/exports 对齐。
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^@earendil-works\//, "react", "react-dom"],
  },
  hooks: {
    // schema.sql 不是 JS 模块，rollup 不会带过去；构建后手工复制。
    //
    // 目标必须是 lib/schema.sql（不是 lib/store/）：打包后 db.ts 被内联进
    // lib/index.js，`import.meta.url` 指向 lib/，所以 `join(HERE, "schema.sql")`
    // 找的是 lib/schema.sql。
    "build:done": () => {
      mkdirSync("lib", { recursive: true });
      copyFileSync("src/store/schema.sql", "lib/schema.sql");
    },
  },
};

const CLIENT_CONFIG = {
  entry: { "client-impl": "src/client/index.ts" },
  format: ["cjs"] as const,
  platform: "browser" as const,
  target: "es2022",
  dts: false,
  outDir: "lib/.client",
  outExtensions: () => ({ js: ".cjs" }),
  // react / react-dom 由宿主的 require 注入，绝不能打进产物 ——
  // 自己 import 会拿到另一个 React 实例，hooks 直接崩。
  deps: { neverBundle: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"] },
  hooks: {
    "build:done": () => {
      // 套上宿主的模块加载器外壳，并写到**包根目录**。
      //
      // 位置很关键：宿主的 manifest 把每个客户端插件拼成
      // `<包名>/client.js`（实测见 index.html 的 __DSH_BOOT__.entries：
      // `plugins/??dsh-connect-workbuddy/client.js&rev=...`），
      // 所以文件必须是 `<包根>/client.js`，不是 lib/client.js。
      //
      // 外壳必须是 `module.exports = factory(require)`：宿主拿到的就是这个
      // 返回值，再从中取 name / inject / apply。
      const inner = readFileSync("lib/.client/client-impl.cjs", "utf8");
      const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-model-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${inner
  .split("\n")
  .map((line) => (line === "" ? "" : `\t\t${line}`))
  .join("\n")}
		return module.exports;
	}
});
`;
      writeFileSync("client.js", wrapped, "utf8");
    },
  },
};

export default defineConfig([HOST_CONFIG, CLIENT_CONFIG]);
