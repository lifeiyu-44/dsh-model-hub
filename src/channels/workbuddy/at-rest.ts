import { createDecipheriv, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseAuthDocument, regionOfDomain, type Region } from "./auth.js";

/**
 * WorkBuddy 桌面端「at-rest」加密凭据的**内置解密**（不依赖 dsh-connect-workbuddy）。
 *
 * ## 协议（WorkBuddy 5.6+，实测 2026-10-29 本机取密钥成功）
 *
 * 桌面端不再以明文保存 `auth.accessToken` / `auth.refreshToken`，而是写：
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64(JSON {suite,keyId,nonce,authTag,ciphertext})>" }
 *
 * AES-256-GCM（12 字节 nonce、16 字节 tag），AAD 是「scheme/suite/keyId/framing」
 * 的长度前缀转录 —— 同一段密文只能解开成它当初封印的字段形状。
 *
 * 字段密钥**不是用户秘密**：它是 App 构建期编进 native 模块
 * `electron_browser_workbuddy_storage` 的常量，App 自己通过 `loggerGet()` 取。
 * 这里用同样方式向**已安装的同一个 App 二进制**要这份 payload（以
 * `ELECTRON_RUN_AS_NODE=1` 跑成纯 Node 调 `process._linkedBinding`），
 * 对 payload 里 `atRestSecretKey` 的 **base64 字符串**（不是解码字节）取
 * SHA-256 得到 32 字节 key；`keyId` = key 的 SHA-256 前 16 个 hex。
 *
 * 每一层都 fail-loud：信封畸形 / keyId 不匹配 / GCM tag 校验失败都抛错，
 * 绝不降级成截断的 token。密钥只在内存缓存，永不落盘、不进日志。
 */

// ── 协议常量（与 App 的 at-rest 模块逐字一致） ──

/** AAD 转录的域分隔符。 */
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
/** 字段（field）framing 的标准格式标识。 */
const STANDARD_FORMAT_ID_FIELD = "WBEV1";
/** 对称信封的 scheme 名。 */
const SYMMETRIC_SCHEME = "sym-v1";
/** framing 名 → AAD 单字节码（field = 2）。 */
const FRAMING_CODE_FIELD = 2;
/** 向 App 要密钥 payload 的超时。 */
const KEY_FETCH_TIMEOUT_MS = 10_000;

/** App 的 native 模块取值脚本（与 dsh-connect-workbuddy 同款调用方式）。 */
const LOGGER_GET_SCRIPT =
  "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
  "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";

// ── 基础编码 ──

function encodeUint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function encodeLengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
}

/** field-framed 信封的 AAD 转录。 */
function fieldAad(keyId: string, suite: number): Buffer {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("workbuddy: envelope keyId is malformed");
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID_FIELD),
    encodeLengthPrefixed(SYMMETRIC_SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE_FIELD]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

// ── 信封打开 ──

/** `{ "$wbEncrypted": 1, "envelope": "…" }` 的形状判定。 */
export function isEncryptedField(value: unknown): value is { $wbEncrypted: 1; envelope: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const wrapper = value as Record<string, unknown>;
  const keys = Object.keys(wrapper).sort();
  return (
    keys.length === 2 &&
    keys[0] === "$wbEncrypted" &&
    keys[1] === "envelope" &&
    wrapper["$wbEncrypted"] === 1 &&
    typeof wrapper["envelope"] === "string"
  );
}

/** 由 App 的密钥 payload JSON 派生 32 字节 key 与 keyId。 */
export function deriveAtRestKey(payloadJson: string): { key: Buffer; keyId: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error("workbuddy: at-rest key payload is not valid JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("workbuddy: at-rest key payload is not an object");
  }
  const secret = (payload as Record<string, unknown>)["atRestSecretKey"];
  if (typeof secret !== "string" || secret === "") {
    throw new Error("workbuddy: at-rest key payload carries no atRestSecretKey");
  }
  // **对 base64 字符串原文取哈希**（不是解码后的字节）—— App 就是这么做的，
  // 换成解码字节会得到另一把 key，所有字段都开不开。
  const key = createHash("sha256").update(secret, "utf8").digest();
  return { key, keyId: createHash("sha256").update(key).digest("hex").slice(0, 16) };
}

/** 用派生 key 打开一个加密字段，返回明文字符串。 */
export function openEncryptedField(field: { envelope: string }, key: Buffer): string {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("workbuddy: encrypted field envelope is not valid JSON");
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("workbuddy: encrypted field envelope is not an object");
  }
  const suite = envelope["suite"];
  const keyId = envelope["keyId"];
  const nonce = envelope["nonce"];
  const authTag = envelope["authTag"];
  const ciphertext = envelope["ciphertext"];
  if (typeof suite !== "number" || typeof keyId !== "string") {
    throw new Error("workbuddy: encrypted field envelope is missing suite or keyId");
  }
  if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") {
    throw new Error("workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext");
  }
  const expectedKeyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

// ── 向 App 要密钥 ──

/** App 可执行文件候选（Windows）。`WORKBUDDY_APP_EXECUTABLE` 显式指定优先。 */
export function workbuddyAppCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const list: string[] = [];
  const explicit = env["WORKBUDDY_APP_EXECUTABLE"];
  if (explicit !== undefined && explicit !== "") list.push(explicit);
  const local = env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  const names = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
  const subdirs: string[][] = [["Programs", "WorkBuddy"], ["WorkBuddy"], ["Programs", "WorkBuddyAI"], ["WorkBuddyAI"]];
  for (const sub of subdirs) {
    for (const name of names) list.push(join(local, ...sub, name));
  }
  return [...new Set(list)];
}

/** 探测已安装的 App 可执行文件；都没有返回 undefined。 */
export function findWorkbuddyExecutable(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return workbuddyAppCandidates(env).find((path) => exists(path));
}

export interface AtRestDeps {
  /** 注入的 execFile（测试用）。 */
  execFileImpl?: typeof execFile;
  /** 注入的候选存在性判断（测试用）。 */
  existsImpl?: (path: string) => boolean;
  /** 注入的密钥 payload 获取（测试用；给了就不再 spawn App）。 */
  keyPayload?: () => Promise<string>;
  /** 显式指定 App 可执行文件。 */
  executable?: string;
  env?: Record<string, string | undefined>;
}

/** 进程级密钥缓存：同一个 exe 只问一次。 */
const keyCache = new Map<string, { key: Buffer; keyId: string }>();

/** 向 App 的 native binding 要密钥 payload（子进程 stdout 是唯一读取面）。 */
export function fetchAtRestKeyPayload(
  executable: string,
  execFileImpl: typeof execFile = execFile,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileImpl(
      executable,
      ["-e", LOGGER_GET_SCRIPT],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`));
          return;
        }
        const payload = stdout.trim();
        if (payload === "") {
          reject(new Error("workbuddy: the desktop app returned an empty at-rest key payload"));
          return;
        }
        resolve(payload);
      },
    );
  });
}

/** 取（并缓存）这把机器上的 at-rest key。 */
export async function loadAtRestKey(deps: AtRestDeps = {}): Promise<{ key: Buffer; keyId: string }> {
  if (deps.keyPayload !== undefined) return deriveAtRestKey(await deps.keyPayload());
  const executable =
    deps.executable ?? findWorkbuddyExecutable(deps.env, deps.existsImpl ?? existsSync);
  if (executable === undefined) {
    throw new Error("workbuddy: 没有找到已安装的 WorkBuddy 桌面端（用于取 at-rest 密钥）");
  }
  const cached = keyCache.get(executable);
  if (cached !== undefined) return cached;
  const derived = deriveAtRestKey(await fetchAtRestKeyPayload(executable, deps.execFileImpl ?? execFile));
  keyCache.set(executable, derived);
  return derived;
}

// ── 解密整份 auth 文档 ──

export interface DecryptedAuth {
  /** 明文 accessToken（来自明文或 App 解密）。 */
  accessToken: string;
  refreshToken?: string;
  /** vault json `account.nickname`（明文或 App 解密）。 */
  nickname?: string;
  /** vault json `account.uid`（明文即可）。 */
  accountUid?: string;
  /** 是否真的经过了解密（false = 文件本来就是明文）。 */
  decrypt: boolean;
}

/**
 * 解开一份 auth/vault 文档里的加密字段。
 *
 * - `accessToken` 是明文字符串 → 原样返回（不需要 App）。
 * - 是 `{$wbEncrypted}` 信封 → 向 App 要 key 后 AES-GCM 解开。
 * - `refreshToken`/`account.nickname` 同为信封时一并解；解不开就如实抛错。
 */
export async function decryptAuthDocument(
  doc: Record<string, unknown>,
  deps: AtRestDeps = {},
): Promise<DecryptedAuth> {
  const auth = (typeof doc["auth"] === "object" && doc["auth"] !== null
    ? (doc["auth"] as Record<string, unknown>)
    : doc);
  const account = (typeof doc["account"] === "object" && doc["account"] !== null
    ? (doc["account"] as Record<string, unknown>)
    : undefined);

  const uid = typeof account?.["uid"] === "string" && account["uid"] !== "" ? account["uid"] : undefined;
  const rawNickname = account?.["nickname"];

  const rawToken = auth["accessToken"];
  if (typeof rawToken === "string" && rawToken !== "") {
    return {
      accessToken: rawToken,
      ...(typeof auth["refreshToken"] === "string" ? { refreshToken: auth["refreshToken"] } : {}),
      ...(typeof rawNickname === "string" ? { nickname: rawNickname } : {}),
      ...(uid === undefined ? {} : { accountUid: uid }),
      decrypt: false,
    };
  }
  if (!isEncryptedField(rawToken)) {
    throw new Error("workbuddy: auth.accessToken 既不是明文也不是可解的信封");
  }

  const { key } = await loadAtRestKey(deps);
  const accessToken = openEncryptedField(rawToken, key);
  const out: DecryptedAuth = { accessToken, decrypt: true, ...(uid === undefined ? {} : { accountUid: uid }) };
  const refreshRaw = auth["refreshToken"];
  if (typeof refreshRaw === "string" && refreshRaw !== "") out.refreshToken = refreshRaw;
  else if (isEncryptedField(refreshRaw)) out.refreshToken = openEncryptedField(refreshRaw, key);
  if (typeof rawNickname === "string" && rawNickname !== "") out.nickname = rawNickname;
  else if (isEncryptedField(rawNickname)) out.nickname = openEncryptedField(rawNickname, key);
  return out;
}

// ── 生产入口 ──

/** auth 文档的 `auth.domain` → 区域（缺省 global）。 */
export function regionOfAuthDocument(doc: Record<string, unknown>): Region {
  const auth = (typeof doc["auth"] === "object" && doc["auth"] !== null
    ? (doc["auth"] as Record<string, unknown>)
    : doc);
  const domain = typeof auth["domain"] === "string" ? auth["domain"] : "";
  return regionOfDomain(domain) ?? "global";
}

/** 生产路径：读文件（去 BOM）→ 内置解密 → 附带区域与过期时间。 */
export async function realDecryptAuthFile(
  path: string,
  deps: AtRestDeps = {},
): Promise<DecryptedAuth & { region: Region; expiresAtMs?: number }> {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const doc = JSON.parse(text) as Record<string, unknown>;
  const decrypted = await decryptAuthDocument(doc, deps);
  const parsed = parseAuthDocument(text);
  return {
    ...decrypted,
    region: regionOfAuthDocument(doc),
    ...(parsed.expiresAtMs === undefined ? {} : { expiresAtMs: parsed.expiresAtMs }),
  };
}

