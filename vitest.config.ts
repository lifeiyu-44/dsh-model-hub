import { defineConfig } from "vitest/config";

/**
 * vitest 配置。
 *
 * `setupFiles` 只做一件事：把 Trae 的用户数据目录指到一个空临时目录，
 * 防止单测读到开发机上的真实登录态（理由见 tests/setup.ts）。
 */
export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
  },
});
