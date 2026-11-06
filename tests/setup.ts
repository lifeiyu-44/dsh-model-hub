import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 单测与真机隔离。
 *
 * Trae 渠道会在启动/一键认证时去扫本机的 Trae 用户目录
 * （`%APPDATA%\TRAE SOLO`）。开发机上如果真装了 Trae 并登录过，单测就会
 * 读到**真实登录态**：一边把凭据写进临时目录，一边让「裸机 → 三个渠道都
 * missing」这类断言变成看运气。
 *
 * 所以整轮测试统一指向一个空目录。要测「能发现登录态」的用例自己会覆盖
 * `TRAE_USER_DATA`（见 tests/trae.spec.ts 的凭据发现用例）。
 */
process.env.TRAE_USER_DATA ??= mkdtempSync(join(tmpdir(), "dsh-trae-test-userdata-"));
