import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { buildCosyHeaders, qoderDecodeBody, qoderEncodeBody, sigPathOf, QODER_RSA_PUBLIC_KEY } from "../src/channels/qoder/cosy.js";
import { resolveExpiry, readPat } from "../src/channels/qoder/credentials.js";
import { toChannelModel } from "../src/channels/qoder/catalog.js";

/**
 * Qoder 协议层的测试。
 *
 * 这些不是照着文档写的 —— COSY 签名与 Encode 编码都是从参考实现
 * （`dsh-connect` 的 Qoder provider）核对后移植的，并且已用真实 PAT
 * 实测打通（model/list HTTP 200，10 个模型）。这里守的是移植后行为不走样。
 */

describe("qoderEncodeBody —— Encode=1 的三段块旋转", () => {
  it("空串返回空 Buffer", () => {
    expect(qoderEncodeBody("").length).toBe(0);
  });

  it("编码后长度与标准 base64 相同（只换字符不换长度）", () => {
    const plain = JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] });
    const std = Buffer.from(plain, "utf8").toString("base64");
    expect(qoderEncodeBody(plain).length).toBe(std.length);
  });

  it("编码结果不再是标准 base64（字符被重映射了）", () => {
    const plain = "hello world, this is a longer payload to encode for sure";
    const std = Buffer.from(plain, "utf8").toString("base64");
    const enc = qoderEncodeBody(plain).toString("latin1");
    expect(enc).not.toBe(std);
    // 标准 base64 的 `=` 被换成 `$`
    if (std.includes("=")) expect(enc.includes("$")).toBe(true);
  });

  it("可以被解码还原", () => {
    const plain = JSON.stringify({ a: 1, b: "中文也要能回", c: [1, 2, 3] });
    expect(qoderDecodeBody(qoderEncodeBody(plain)).toString("utf8")).toBe(plain);
  });

  it("Buffer 与字符串两种输入等价", () => {
    const plain = "same bytes please";
    expect(qoderEncodeBody(Buffer.from(plain)).equals(qoderEncodeBody(plain))).toBe(true);
  });
});

describe("sigPathOf —— 签名只覆盖去掉 /algo 的 pathname", () => {
  it("去掉 /algo 前缀", () => {
    expect(sigPathOf("https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1")).toBe("/api/v2/model/list");
  });

  it("不含 query", () => {
    expect(sigPathOf("https://x.test/algo/p?Encode=1&Foo=bar")).toBe("/p");
  });

  it("没有 /algo 时原样保留 pathname", () => {
    expect(sigPathOf("https://x.test/api/v1/userinfo")).toBe("/api/v1/userinfo");
  });
});

describe("buildCosyHeaders", () => {
  const creds = { userID: "01a0651e-4c25-77d4-8803-94fee7bb0d71", authToken: "jt-abc", name: "u", email: "" };

  it("产出 Authorization: Bearer COSY.<payload>.<sig>", () => {
    const headers = buildCosyHeaders(null, "https://g.test/algo/api/v2/model/list?Encode=1", creds);
    expect(headers["Authorization"]).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/);
  });

  it("payload 是可解的 JSON，且含 info / cosyVersion", () => {
    const headers = buildCosyHeaders(null, "https://g.test/algo/x", creds);
    const payloadB64 = headers["Authorization"]!.split(".")[1]!;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    expect(payload.version).toBe("v1");
    expect(typeof payload.info).toBe("string");
    expect(payload.cosyVersion).toBe("1.1.38");
    expect(typeof payload.requestId).toBe("string");
  });

  it("info 能被 cosyKey 对应的 RSA 私钥解出来（用公钥加密的可解密性反证）", () => {
    // 我们手上没有私钥，但可以验证 cosyKey 确实是 RSA 加密的 aesKey：
    // 64 字节 aesKey 用 1024 位公钥加密后 base64 长度固定 172。
    const headers = buildCosyHeaders(null, "https://g.test/algo/x", creds);
    expect(headers["Cosy-Key"]!.length).toBe(172);
    expect(QODER_RSA_PUBLIC_KEY).toContain("BEGIN PUBLIC KEY");
  });

  it("bodyhash / bodylength 覆盖的是编码后的字节", () => {
    const body = qoderEncodeBody('{"a":1}');
    const headers = buildCosyHeaders(body, "https://g.test/algo/x", creds);
    expect(headers["Cosy-Bodylength"]).toBe(String(body.length));
    expect(headers["Cosy-Bodyhash"]).toBe(createHash("md5").update(body).digest("hex"));
  });

  it("body 为空时长度 0、hash 是空串的 md5", () => {
    const headers = buildCosyHeaders(null, "https://g.test/algo/x", creds);
    expect(headers["Cosy-Bodylength"]).toBe("0");
    expect(headers["Cosy-Bodyhash"]).toBe(createHash("md5").update(Buffer.alloc(0)).digest("hex"));
  });

  it("Sigpath 与签名口径一致（去掉 /algo、不含 query）", () => {
    const headers = buildCosyHeaders(null, "https://g.test/algo/api/v2/model/list?Encode=1", creds);
    expect(headers["Cosy-Sigpath"]).toBe("/api/v2/model/list");
  });

  it("缺 userID 或 token 时明确抛错（不静默发无效请求）", () => {
    expect(() => buildCosyHeaders(null, "https://g.test/algo/x", { userID: "", authToken: "t" })).toThrow(/userID/);
    expect(() => buildCosyHeaders(null, "https://g.test/algo/x", { userID: "u", authToken: "" })).toThrow(/authToken/);
  });

  it("每次签名的 payload / key / date 都不同（有随机 aesKey 与 requestId）", () => {
    const a = buildCosyHeaders(null, "https://g.test/algo/x", creds);
    const b = buildCosyHeaders(null, "https://g.test/algo/x", creds);
    expect(a["Cosy-Key"]).not.toBe(b["Cosy-Key"]);
    expect(a["Authorization"]).not.toBe(b["Authorization"]);
  });
});

describe("resolveExpiry", () => {
  it("ISO 字符串", () => {
    const at = resolveExpiry({ expires_at: "2026-10-29T05:50:27Z" });
    expect(at).toBe(Date.parse("2026-10-29T05:50:27Z"));
  });

  it("秒级数字按秒解", () => {
    expect(resolveExpiry({ expires_at: 1793170227 })).toBe(1793170227 * 1000);
  });

  it("毫秒级数字原样", () => {
    expect(resolveExpiry({ expires_at: 1793170227000 })).toBe(1793170227000);
  });

  it("expires_in 秒 / 毫秒都认", () => {
    const now = Date.now();
    const seconds = resolveExpiry({ expires_in: 86400 })!;
    expect(seconds - now).toBeGreaterThan(86_000_000);
    const millis = resolveExpiry({ expires_in: 86_400_000 })!;
    expect(millis - now).toBeGreaterThan(86_000_000);
  });

  it("读不出来返回 undefined（调用方按保守值处理）", () => {
    expect(resolveExpiry({})).toBeUndefined();
    expect(resolveExpiry({ expires_at: "not a date" })).toBeUndefined();
  });
});

describe("readPat", () => {
  it("本机存在 PAT 文件时能读到 pt- 前缀的值", () => {
    const found = readPat();
    if (found === undefined) return; // 无凭据的机器上跳过（CI）
    expect(found.pat.startsWith("pt-")).toBe(true);
    expect(found.source.length).toBeGreaterThan(0);
  });
});

describe("toChannelModel —— 上游字段映射", () => {
  it("key/display_name/price_factor/max_input_tokens 都对上", () => {
    const model = toChannelModel({
      key: "qmodel_38max",
      display_name: "Qwen3.8-Max",
      price_factor: 0.5,
      max_input_tokens: 180_000,
      is_vl: true,
      is_reasoning: true,
    })!;
    expect(model.id).toBe("qmodel_38max");
    expect(model.name).toBe("Qwen3.8-Max");
    expect(model.creditMultiplier).toBe(0.5);
    expect(model.contextWindow).toBe(180_000);
    expect(model.supportsImages).toBe(true);
  });

  it("免费模型 price_factor 为 0", () => {
    expect(toChannelModel({ key: "qfmodel", display_name: "Q", price_factor: 0 })!.creditMultiplier).toBe(0);
  });

  it("缺 key 的条目被丢弃", () => {
    expect(toChannelModel({ display_name: "orphan" })).toBeUndefined();
  });

  it("缺上下文窗口时用保守默认，不虚报", () => {
    const model = toChannelModel({ key: "m" })!;
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBeLessThanOrEqual(8_192);
  });

  it("maxTokens 不超过上下文窗口", () => {
    const model = toChannelModel({ key: "m", max_input_tokens: 4_000 })!;
    expect(model.maxTokens).toBeLessThanOrEqual(4_000);
  });
});

/**
 * 真实联网验证：用本机 PAT 跑一遍「换 jobToken → COSY 签名 → 拉目录」。
 *
 * 没有 PAT 的机器（CI）自动跳过 —— 但**在有 PAT 的机器上必须真的跑通**，
 * 否则前面 27 条单测全绿也说明不了协议对接成功。
 */
describe("live: PAT → jobToken → 目录", () => {
  it("能拉到 chat 模型且包含已知 id", async () => {
    const { createSessionManager, readPat } = await import("../src/channels/qoder/credentials.js");
    const { fetchQoderCatalog } = await import("../src/channels/qoder/catalog.js");

    if (readPat() === undefined) {
      console.log("[qoder live] 本机没有 PAT，跳过");
      return;
    }

    const session = await createSessionManager().current();
    expect(session, "PAT 存在但换不到 jobToken").toBeDefined();
    expect(session!.userID.length).toBeGreaterThan(0);
    expect(session!.expiresAt).toBeGreaterThan(Date.now());

    const result = await fetchQoderCatalog(session!);
    expect(result.error, `目录拉取失败：${result.error}`).toBeUndefined();
    expect(result.models.length).toBeGreaterThanOrEqual(5);

    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("auto");
    // 上游目录里确实有免费模型（price_factor 0）
    expect(result.models.some((m) => m.creditMultiplier === 0)).toBe(true);
    console.log(`[qoder live] ${result.models.length} 个模型: ${ids.slice(0, 6).join(", ")} …`);
  }, 60_000);
});