import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { HUB_DIR_NAME } from "../../constants.js";
import type { Region } from "./auth.js";
import { parseAuthDocument } from "./auth.js";
import { workbuddyTokenPath } from "./token-store.js";

/**
 * WorkBuddy 账号的**身份**与**登记 id** 的单一裁决点。
 *
 * ## 为什么必须集中在一处
 *
 * 真机事故（2026-10-29）：面板上同一个账号出现两行，`credential_ref` 指向
 * 同一个 token 文件，显示名一模一样。原因不是查询错，而是**同一个真实账号
 * 被两套 id 规则登记过**：
 *
 *   · 启动装配层用硬编码 id `<channel>:default` 登记「当前登录的那个账号」；
 *   · 一键认证用 uid 哈希 `<channel>:wb-<sha256(uid)[:12]>` 登记同一个账号。
 *
 * 两条规则互不知情，于是同一个 uid 落成两行。更糟的是 `<channel>:default`
 * 的身份会随桌面端换号**静默漂移** —— 它昨天指向老账号、今天指向新账号，
 * 而 `credential_ref` 被 seed 的 DO UPDATE 覆写，于是老账号那一行实际上
 * 变成了「挂着老名字的新账号」，真正被顶掉。
 *
 * ## 现在的规则（唯一一条）
 *
 * **uid 是账号身份**，id 由 uid 稳定派生：`<channel>:wb-<sha256(uid)[:12]>`。
 * 登记前先按 uid 在库里找已有行（无论它的 id 是 `:default`、历史文件名、
 * 还是旧哈希），找到就复用它的 id 并刷新字段；找不到才按规则新建。
 *
 * 因此本模块导出两件事：
 *   · {@link identityOfTokenFile} / {@link listTokenStoreEntries}：读身份
 *   · {@link resolveAccountId}：按 uid 决定该用哪个 id（复用 or 新建）
 */

/** 从任意 WorkBuddy 凭据文档里取身份（明文 uid/nickname；信封视为未知）。 */
export interface TokenIdentity {
  uid?: string;
  nickname?: string;
  region: Region;
  expiresAtMs?: number;
}

/**
 * 读一份 token/vault 文件的身份。读不了返回 undefined（fail-soft）。
 *
 * uid 只认**明文**：`{$wbEncrypted}` 信封在这里不解密 —— 解密是
 * `at-rest.ts` 的职责，读身份的路径不该有副作用。
 */
export function identityOfTokenFile(path: string): TokenIdentity | undefined {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const account = (typeof doc["account"] === "object" && doc["account"] !== null
      ? (doc["account"] as Record<string, unknown>)
      : undefined);
    const auth = (typeof doc["auth"] === "object" && doc["auth"] !== null
      ? (doc["auth"] as Record<string, unknown>)
      : undefined);
    const uid = typeof account?.["uid"] === "string" && account["uid"] !== "" ? account["uid"] : undefined;
    const nickname =
      typeof account?.["nickname"] === "string" && account["nickname"] !== "" ? account["nickname"] : undefined;
    const domain = typeof auth?.["domain"] === "string" ? auth["domain"] : "";
    const region: Region = domain.endsWith(".cn") ? "cn" : "global";
    const expiresAtRaw = auth?.["expiresAt"];
    const expiresAtMs = typeof expiresAtRaw === "number" ? expiresAtRaw : undefined;
    return {
      ...(uid === undefined ? {} : { uid }),
      ...(nickname === undefined ? {} : { nickname }),
      region,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    };
  } catch {
    return undefined;
  }
}

/** 我们自己维护的 token 目录里的一条账号。 */
export interface TokenStoreEntry {
  /** 文件路径（凭据引用）。 */
  source: string;
  /** 文件名里的 sha 前缀（不是身份，只用于日志）。 */
  slug: string;
  /** 身份；uid 缺失时条目仍可用，但无法参与 uid 去重。 */
  identity: TokenIdentity;
  /** 明文 token（验活/运行时要用）。 */
  accessToken: string;
  refreshToken?: string;
}

/**
 * 列出 `<dshHome>/model-hub/workbuddy-tokens/` 下全部可用账号。
 *
 * **这是启动登记的唯一账号来源**：换号登录后一键认证会把新账号写进这个目录，
 * 因此「目录里有几个可读账号」就等于「本机有几个已接管账号」。启动时按它
 * 全量登记，而不是只登记「当前登录的那一个」—— 后者正是老账号被顶掉的原因。
 *
 * 坏文件跳过（fail-soft），目录不存在返回空数组。
 */
export function listTokenStoreEntries(dshHome: string): TokenStoreEntry[] {
  const dir = join(dshHome, HUB_DIR_NAME, "workbuddy-tokens");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const out: TokenStoreEntry[] = [];
  for (const name of names) {
    const source = join(dir, name);
    try {
      const text = readFileSync(source, "utf8").replace(/^\uFEFF/, "");
      const parsed = parseAuthDocument(text);
      if (parsed.kind !== "plain" || parsed.token === undefined) continue;
      const identity = identityOfTokenFile(source);
      if (identity === undefined) continue;
      out.push({
        source,
        slug: name.slice(0, -".json".length),
        identity,
        accessToken: parsed.token,
        ...(parsed.refreshToken === undefined ? {} : { refreshToken: parsed.refreshToken }),
      });
    } catch {
      continue; // 坏文件跳过，不影响其它账号
    }
  }
  return out;
}

/** uid → 稳定 id 后缀（与 token 文件名同源，便于人眼对上）。 */
export function accountIdSuffixOf(uid: string): string {
  return `wb-${createHash("sha256").update(uid, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * 按「凭据文件 + uid」在库里找已有账号 id（**含软删**：软删的账号也要认出来，
 * 否则会「新建」一个 id 不同、指向同一凭据文件的行 —— 用户删掉的账号重启后
 * 就复活了，等于删除按钮失效）。
 *
 * 判定顺序（越靠前越可靠）：
 *   1. **同一个凭据文件** → 复用该行 id。同一文件必然是同一账号，这是最强的
 *      证据；而且它守住了软删语义（老版明文 auth 文件没有 uid，只能靠路径认）。
 *   2. 已有行的凭据文件里 `account.uid` 与目标相同 → 复用该行 id
 *      （覆盖 `:default`、历史文件名 id 等一切旧规则）。
 *   3. 库里存在「按 uid 派生出来的那个 id」→ 复用它。
 *   4. 都没有 → undefined（调用方新建）。
 */
export function resolveAccountId(
  db: DatabaseSync,
  channelId: string,
  uid: string | undefined,
  source?: string,
): string | undefined {
  const derived = uid === undefined ? undefined : `${channelId}:${accountIdSuffixOf(uid)}`;
  const rows = db
    .prepare("SELECT id, credential_ref FROM accounts WHERE channel_id = ?")
    .all(channelId) as { id: string; credential_ref: string | null }[];

  // 1) 同一凭据文件：Windows 路径大小写不敏感，统一小写比较
  if (source !== undefined && source !== "") {
    const needle = source.toLowerCase();
    const sameFile = rows.find(
      (row) => row.credential_ref !== null && row.credential_ref.toLowerCase() === needle,
    );
    if (sameFile !== undefined) return sameFile.id;
  }

  // 2) 同一 uid（读各行凭据文件里的明文 account.uid）
  if (uid !== undefined) {
    for (const row of rows) {
      if (row.credential_ref === null || row.credential_ref === "") continue;
      const identity = identityOfTokenFile(row.credential_ref);
      if (identity?.uid === uid) return row.id;
    }
  }

  // 3) 派生 id 已经存在
  if (derived !== undefined && rows.some((row) => row.id === derived)) return derived;
  return undefined;
}

/**
 * 这个 uid 对应的 token 文件路径（若该文件存在）。
 * 仅用于「一键认证后把已有账号的凭据引用指向最新文件」这类刷新。
 */
export function tokenFileFor(dshHome: string, uid: string): string {
  return workbuddyTokenPath(dshHome, uid);
}
