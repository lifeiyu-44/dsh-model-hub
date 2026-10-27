import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { ParsedAuth, Region } from "./auth.js";

/**
 * 读 dsh-connect-workbuddy 已经维护好的 vault。
 *
 * **为什么走这条路**：本机 WorkBuddy 的 `workbuddy-desktop-ai.info` 里
 * `accessToken` 是 `{"$wbEncrypted":1,"envelope":"…"}` 的 AES-256-GCM 信封，
 * 密钥由 App 构建期内置、只能通过 `ELECTRON_RUN_AS_NODE` 调 App 自己的 native
 * binding 取回。本机没装 WorkBuddy 桌面 App，解不了。
 *
 * 但 `dsh-connect-workbuddy` 已经解过一次并把明文存进了自己的 vault
 * （`$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`，`auth.accessToken`
 * 是明文字符串）。它是本机同一个用户、同一个账号、同一台机器上的既有产物，
 * 读它比自己造一套解密器更诚实，也不复制任何密钥。
 *
 * **只读**：这个函数绝不写回 vault。文件权限与所有权属于那个插件。
 *
 * 返回 `undefined` 表示没找到可用的 vault 条目 —— 调用方应当如实报告
 * 「需要先装 WorkBuddy 桌面端登录一次」，而不是假装成功。
 */
export function readWorkbuddyVault(preferredRegion?: Region): { source: string; parsed: ParsedAuth } | undefined {
  const root = join(resolveDshHome(), "workbuddy-vault");
  if (!existsSync(root)) return undefined;

  const regions: Region[] = preferredRegion === undefined ? ["global", "cn"] : [preferredRegion];
  for (const region of regions) {
    const dir = join(root, region);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const auth = doc["auth"] as Record<string, unknown> | undefined;
        if (auth === undefined) continue;
        const token = auth["accessToken"];
        if (typeof token !== "string" || token === "") continue;
        const expiresAt = typeof auth["expiresAt"] === "number" ? auth["expiresAt"] * 1000 : undefined;
        return {
          source: path,
          parsed: {
            kind: "plain",
            region,
            token,
            ...(typeof auth["refreshToken"] === "string" ? { refreshToken: auth["refreshToken"] } : {}),
            ...(expiresAt === undefined ? {} : { expiresAtMs: expiresAt }),
          },
        };
      } catch {
        continue;
      }
    }
  }
  return undefined;
}
