import { createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";

/**
 * Qoder 的 COSY 签名层。
 *
 * ## 协议（从 `dsh-connect` 的 Qoder 实现核对，并已实测打通）
 *
 * Qoder 的网关**不是** `Authorization: Bearer <token>`，而是自研的 COSY 签名：
 *
 * ```
 * aesKey     = 随机 16 字符
 * info       = AES-128-CBC(JSON({uid,security_oauth_token,name,aid,email}), key=iv=aesKey) → base64
 * cosyKey    = RSA_PKCS1(aesKey, 内置公钥) → base64
 * payloadB64 = base64(JSON({version:"v1", requestId, info, cosyVersion, ideVersion:""}))
 * sig        = md5(payloadB64 \n cosyKey \n 秒级时间戳 \n bodyBytes \n sigPath)
 * Authorization: Bearer COSY.<payloadB64>.<sig>
 * ```
 *
 * 外加一整组 `Cosy-*` 头。**`sigPath` 是 pathname 去掉前导 `/algo`，且不含 query** ——
 * 这一点写错会拿到 401 而不是 404，非常容易误判成 token 失效。
 *
 * ## 请求体编码（URL 上的 `Encode=1`）
 *
 * 先标准 base64，再按 Qoder 自定义字母表重映射（`=` → `$`），
 * 最后三段块旋转 `[n-a,n) [a,n-a) [0,a)`，`a = floor(n/3)`。
 * 签名覆盖的 `bodyBytes` 必须是**编码后**的那份。
 */

/** 自定义字母表：第 i 个字符替代标准 base64 的第 i 个字符。 */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 只映射 base64 用得到的字符；其余保持恒等。 */
function buildTables(): { enc: Uint8Array; dec: Uint8Array } {
  const enc = new Uint8Array(256);
  const dec = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    enc[i] = i;
    dec[i] = i;
  }
  for (let i = 0; i < 64; i += 1) {
    enc[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
    dec[CUSTOM_ALPHABET.charCodeAt(i)] = STD_ALPHABET.charCodeAt(i);
  }
  // Qoder 用 `$` 代替标准 base64 的 `=`
  enc["=".charCodeAt(0)] = "$".charCodeAt(0);
  dec["$".charCodeAt(0)] = "=".charCodeAt(0);
  return { enc, dec };
}

const { enc: ENC_TABLE, dec: DEC_TABLE } = buildTables();

/** 请求体编码：标准 base64 → 字母表重映射 → 三段块旋转。 */
export function qoderEncodeBody(plain: string | Buffer): Buffer {
  const std = Buffer.isBuffer(plain) ? plain.toString("base64") : Buffer.from(plain, "utf8").toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let dst = 0;
  for (let i = n - a; i < n; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)]!;
  for (let i = a; i < n - a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)]!;
  for (let i = 0; i < a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)]!;
  return out;
}

/** {@link qoderEncodeBody} 的逆。线上响应不需要解，只给自测用。 */
export function qoderDecodeBody(encoded: string | Buffer): Buffer {
  const e = Buffer.isBuffer(encoded) ? encoded.toString("latin1") : String(encoded);
  const n = e.length;
  const a = Math.floor(n / 3);
  const m = n - 2 * a;
  const std = Buffer.allocUnsafe(n);
  const put = (chars: string, at: number) => {
    for (let i = 0; i < chars.length; i += 1) std[at + i] = DEC_TABLE[chars.charCodeAt(i)]!;
  };
  put(e.slice(0, a), n - a);
  put(e.slice(a, a + m), a);
  put(e.slice(a + m, n), 0);
  return Buffer.from(std.toString("latin1"), "base64");
}

/** 签名只覆盖 pathname 去掉前导 `/algo`，不含 query。 */
export function sigPathOf(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}

/** COSY 内置 RSA 公钥（用来加密临时的 aesKey）。与 Qoder CLI 同一份。 */
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * 客户端身份版本号。
 *
 * ⚠️ 硬编码契约：`Cosy-Version` 落后于 Qoder CLI 当前版本时，服务端会返回
 * 被裁剪过的模型列表。随 CLI 升级要复核（实测 2026-10-28 用 1.1.38 正常）。
 */
export const COSY_VERSION = "1.1.38";
/** OpenAPI 平面（PAT 交换 / userinfo）用的是另一条版本线。 */
export const COSY_OPENAPI_VERSION = "1.0.1";
/** 网关平面的 `Cosy-Clienttype`；与 OpenAPI 平面的值不是同一个，别共用。 */
export const COSY_CLIENT_TYPE = "5";
/** OpenAPI 平面的 `Cosy-ClientType`。 */
export const COSY_OPENAPI_CLIENT_TYPE = "5";
const COSY_DATA_POLICY = "disagree";

export function machineOs(): string {
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
  return process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}

export interface CosyCreds {
  userID: string;
  /** jobToken */
  authToken: string;
  name?: string;
  email?: string;
  machineID?: string;
}

/**
 * 生成 `Authorization: Bearer COSY.<payloadB64>.<sig>` 与配套 `Cosy-*` 头。
 *
 * `body` 必须是**最终要发出去的字节**（已经过 {@link qoderEncodeBody}），
 * 因为签名与 `Cosy-Bodyhash` / `Cosy-Bodylength` 都覆盖它。
 */
export function buildCosyHeaders(
  body: string | Buffer | null | undefined,
  requestUrl: string,
  creds: CosyCreds,
): Record<string, string> {
  if (typeof creds.userID !== "string" || creds.userID.length === 0) throw new Error("cosy: userID 为空");
  if (typeof creds.authToken !== "string" || creds.authToken.length === 0) throw new Error("cosy: authToken 为空");

  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name ?? "",
    aid: "",
    email: creds.email ?? "",
  };
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = cipher.update(JSON.stringify(userInfo), "utf8", "base64") + cipher.final("base64");
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: 1 }, Buffer.from(aesKey)).toString("base64");

  const ts = String(Math.floor(Date.now() / 1000));
  const payloadB64 = Buffer.from(
    JSON.stringify({ version: "v1", requestId: randomUUID(), info: infoB64, cosyVersion: COSY_VERSION, ideVersion: "" }),
  ).toString("base64");

  const bodyBytes = body === null || body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const sigPath = sigPathOf(requestUrl);
  const sig = createHash("md5")
    .update(payloadB64)
    .update("\n")
    .update(cosyKey)
    .update("\n")
    .update(ts)
    .update("\n")
    .update(bodyBytes)
    .update("\n")
    .update(sigPath)
    .digest("hex");

  const machineId = creds.machineID ?? "dsh-model-hub-machine";

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": ts,
    "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": "5",
    "Cosy-Machineos": machineOs(),
    "Cosy-Clienttype": COSY_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": createHash("md5").update(bodyBytes).digest("hex"),
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": COSY_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": "v2",
    "X-Request-Id": randomUUID(),
  };
}
