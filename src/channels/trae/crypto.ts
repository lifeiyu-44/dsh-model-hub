import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Trae（iCube）本地登录态的解密。
 *
 * ## 为什么需要自己解
 *
 * Trae 桌面端把用户信息（含 `token`）写进 `User/globalStorage/storage.json`，
 * 值是 `byteCrypto` 的 AES 信封：Base64 文本，解出来是
 * `[6 字节头][32 字节密钥料][AES-128-CBC 密文]`。没有明文可读，也没有系统
 * 钥匙串可以问 —— 解密是**纯算法**，密钥料就在信封里，掩码常量在客户端
 * 自己的 `out/main.js`（`byteCrypto.js` 模块）里。
 *
 * 换句话说：这不是破译，是把 App 自己的算法在插件里重放一遍。真正的
 * 边界是「能读到那个 storage.json」—— 读不到就什么都做不了，我们也只能
 * 退回让用户粘贴凭据。
 *
 * ## 算法（与 out/main.js 的 ARe / tre 逐行对应）
 *
 * ```
 * version = 头(74 63 05 10 00 00) → AES
 * keyMaterial = blob[6 : 38]            // 32 字节
 * mask        = MASK_A[i] ^ MASK_B[i]   // 64 字节常量
 * h           = SHA-512( SHA-512(keyMaterial) || mask )
 * aesKey      = h[0 : 16]
 * iv          = h[16 : 32]
 * plain       = AES-128-CBC-decrypt(aesKey, iv, blob[38 : ])
 * check       = SHA-512(plain[64 : ])
 * 明文         = plain[64 : ]            // 前 64 字节是自校验摘要
 * ```
 *
 * 头不匹配、密文不是 16 的整数倍、摘要对不上，一律抛错 —— **不返回半截
 * 明文**：宁可让上层报「凭据解不开」，也不要把解析失败的垃圾当成 token
 * 发到上游去。
 */

/** 信封头：`t` `c` `0x05` `0x10` `0x00` `0x00`（客户端 `qP/zP/GP/JP/KP/YP`）。 */
const AES_HEADER = Buffer.from([116, 99, 5, 16, 0, 0]);
/** 头之后是 32 字节密钥料。 */
const KEY_OFFSET = 6;
const KEY_LENGTH = 32;
/** 明文头部是 64 字节自校验摘要。 */
const DIGEST_LENGTH = 64;
const MASK_LENGTH = 64;

/** `ure`（客户端常量）。 */
const MASK_A = Buffer.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
/** `dre`（客户端常量）。 */
const MASK_B = Buffer.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);

/** 掩码 = 两个常量异或（客户端 `CRe(VP, AES)` 的等价物）。 */
const MASK = (() => {
  const out = Buffer.alloc(MASK_LENGTH);
  for (let i = 0; i < MASK_LENGTH; i += 1) out[i] = (MASK_A[i] ?? 0) ^ (MASK_B[i] ?? 0);
  return out;
})();

function sha512(input: Uint8Array): Buffer {
  return createHash("sha512").update(input).digest();
}

/** 这个信封是不是 Trae 的 AES 格式（只看头，不做解密）。 */
export function isTraeEnvelope(envelope: Uint8Array): boolean {
  if (envelope.length < AES_HEADER.length) return false;
  return AES_HEADER.equals(Buffer.from(envelope.subarray(0, AES_HEADER.length)));
}

/**
 * 解一个 `byteCrypto` 信封。
 *
 * @throws 头不匹配 / 长度不对 / 摘要校验失败
 */
export function decryptEnvelope(envelope: Uint8Array): Buffer {
  const blob = Buffer.from(envelope);
  if (!isTraeEnvelope(blob)) {
    throw new Error("不是 Trae 的 AES 信封（头部魔数不匹配）");
  }
  if (blob.length <= KEY_OFFSET + KEY_LENGTH) {
    throw new Error("Trae 信封过短（缺密钥料或密文）");
  }
  const keyMaterial = blob.subarray(KEY_OFFSET, KEY_OFFSET + KEY_LENGTH);
  const digest = sha512(Buffer.concat([sha512(keyMaterial), MASK]));
  const decipher = createDecipheriv("aes-128-cbc", digest.subarray(0, 16), digest.subarray(16, 32));
  const cipherText = blob.subarray(KEY_OFFSET + KEY_LENGTH);
  if (cipherText.length === 0 || cipherText.length % 16 !== 0) {
    throw new Error(`Trae 信封密文长度非法（${cipherText.length} 字节，必须是 16 的整数倍）`);
  }
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } catch {
    throw new Error("Trae 信封解密失败（AES 填充校验不通过）");
  }
  if (plain.length < DIGEST_LENGTH) throw new Error("Trae 信封明文过短（缺自校验摘要）");
  const expected = plain.subarray(0, DIGEST_LENGTH);
  const actual = sha512(plain.subarray(DIGEST_LENGTH));
  if (!timingSafeEqual(expected, actual)) {
    throw new Error("Trae 信封自校验失败（内容被改过或不是本机写入的）");
  }
  return plain.subarray(DIGEST_LENGTH);
}

/** Base64 信封 → UTF-8 明文（storage.json 里的值就是这种形态）。 */
export function decryptEnvelopeBase64(value: string): string {
  return decryptEnvelope(Buffer.from(value, "base64")).toString("utf8");
}

/**
 * 造一个信封（测试与「导入到别的机器」用）。
 *
 * 与客户端的 `PRe` 同构：随机 32 字节密钥料 + 同样的掩码派生 + 同样的
 * 自校验摘要。**生产路径不用它** —— 只在单测里自造夹具，避免把真实
 * 账号的 token 写进仓库。
 */
export function encryptEnvelope(plain: Uint8Array): string {
  const keyMaterial = randomBytes(KEY_LENGTH);
  const digest = sha512(Buffer.concat([sha512(keyMaterial), MASK]));
  const body = Buffer.from(plain);
  const header = Buffer.alloc(DIGEST_LENGTH);
  sha512(body).copy(header, 0);
  const cipher = createCipheriv("aes-128-cbc", digest.subarray(0, 16), digest.subarray(16, 32));
  const cipherText = Buffer.concat([cipher.update(Buffer.concat([header, body])), cipher.final()]);
  return Buffer.concat([AES_HEADER, keyMaterial, cipherText]).toString("base64");
}

/**
 * 读 JWT 的 `exp`（秒 → 毫秒）。
 *
 * 只用来提前判断「这张票还能不能用」以及面板上显示有效期；**不验签** ——
 * 验签是上游的事，我们只需要知道它什么时候过期。
 */
export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
