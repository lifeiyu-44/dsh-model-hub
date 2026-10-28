import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_VERSION } from "../src/index.js";

/**
 * 诊断栏显示的版本号必须与 `package.json` 一致。
 *
 * 这是最容易忘的一处同步：发布时改了 package.json 的 version，
 * 忘了改 `PLUGIN_VERSION`，用户报障时看到的版本就是错的 ——
 * 而那正是诊断栏存在的意义。
 */
describe("PLUGIN_VERSION", () => {
  it("与 package.json 的 version 一致", () => {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    expect(pkg.version).toBeTypeOf("string");
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  it("是合法的 semver 形态", () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });
});
