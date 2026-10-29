import { readFileSync, readdirSync } from "node:fs";
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
 * **只读**：这两个函数绝不写回 vault。文件权限与所有权属于那个插件。
 */

/** vault 里一条可用的账号条目（一个 `.json` 文件一个账号）。 */
export interface VaultEntry {
  /** 文件名去掉 `.json`。 */
  accountId: string;
  /** 文件路径 —— 凭据只存引用，绝不落明文进 DB/日志。 */
  source: string;
  region: Region;
  parsed: ParsedAuth;
  /**
   * 账号身份（面板显示名用）。两个字段都可能缺：
   * nickname 是 `{$wbEncrypted}` 信封时视为未知（这里绝不解密）。
   */
  identity: VaultIdentity;
}

/** vault json `account` 段里能直接读到的身份（明文才有；信封不算）。 */
export interface VaultIdentity {
  uid?: string;
  nickname?: string;
}

/**
 * 从 vault json 提取账号身份。只有**明文字符串**才算数：
 * 新版桌面端把 nickname 也换成 `{$wbEncrypted}` 信封，那种在这里视为未知，
 * 调用方退回 uid 前缀或文件名 —— 绝不在这里尝试解密。
 */
export function vaultIdentityOf(doc: Record<string, unknown>): VaultIdentity {
  const account = doc["account"];
  if (typeof account !== "object" || account === null) return {};
  const rec = account as Record<string, unknown>;
  const uid = typeof rec["uid"] === "string" && rec["uid"] !== "" ? rec["uid"] : undefined;
  const nickname = typeof rec["nickname"] === "string" && rec["nickname"] !== "" ? rec["nickname"] : undefined;
  return { ...(uid === undefined ? {} : { uid }), ...(nickname === undefined ? {} : { nickname }) };
}

/** vault 的区域目录，扫描顺序与旧 readWorkbuddyVault 一致（global 优先）。 */
const VAULT_REGIONS: Region[] = ["global", "cn"];

/**
 * vault 下全部可用的账号条目（多账号）。
 *
 * 按区域遍历全部 `.json`，只收「明文（plain）且有 token」的条目；
 * 坏文件 / 缺 auth / token 不是非空字符串的一律跳过（fail-soft，不抛）。
 * 目录不存在返回空数组。
 */
export function listVaultEntries(root: string = join(resolveDshHome(), "workbuddy-vault")): VaultEntry[] {
  const out: VaultEntry[] = [];
  for (const region of VAULT_REGIONS) {
    const dir = join(root, region);
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      continue; // 区域目录不存在或读不了
    }
    for (const name of names) {
      const source = join(dir, name);
      try {
        const doc = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
        const auth = doc["auth"] as Record<string, unknown> | undefined;
        const token = auth?.["accessToken"];
        if (typeof token !== "string" || token === "") continue;
        const refreshToken = auth?.["refreshToken"];
        const expiresAtRaw = auth?.["expiresAt"];
        const expiresAt = typeof expiresAtRaw === "number" ? expiresAtRaw * 1000 : undefined;
        out.push({
          accountId: name.slice(0, -".json".length),
          source,
          region,
          identity: vaultIdentityOf(doc),
          parsed: {
            kind: "plain",
            region,
            token,
            ...(typeof refreshToken === "string" ? { refreshToken } : {}),
            ...(expiresAt === undefined ? {} : { expiresAtMs: expiresAt }),
          },
        });
      } catch {
        continue; // 坏文件跳过
      }
    }
  }
  return out;
}

/**
 * 取一个「当前可用」的 vault 条目 —— `listVaultEntries` 的首条包装，行为不变。
 *
 * 返回 `undefined` 表示没找到可用的 vault 条目 —— 调用方应当如实报告
 * 「需要先装 WorkBuddy 桌面端登录一次」，而不是假装成功。
 */
export function readWorkbuddyVault(preferredRegion?: Region): { source: string; parsed: ParsedAuth } | undefined {
  const entries = listVaultEntries();
  const candidates = preferredRegion === undefined ? entries : entries.filter((e) => e.region === preferredRegion);
  const first = candidates[0];
  return first === undefined ? undefined : { source: first.source, parsed: first.parsed };
}
