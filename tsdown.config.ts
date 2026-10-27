import { defineConfig } from "tsdown";
import { copyFileSync, mkdirSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
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
});
