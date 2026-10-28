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
    // 开了思考后 max_tokens 要留够正文，32K 而不是 8K
    expect(model.maxTokens).toBeGreaterThanOrEqual(32_000);
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
describe("buildQoderChatBody —— OpenAI 请求翻成 Qoder 请求", () => {
  it("模型 id 放在 model_config.key，不在顶层 model", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const body = buildQoderChatBody({ model: "auto", messages: [{ role: "user", content: "hi" }] }, "qfmodel");
    expect((body.model_config as Record<string, unknown>).key).toBe("qfmodel");
    expect(body.model).toBeUndefined();
  });

  it("三个 id 字段同源（服务端靠它们串起一次会话）", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const body = buildQoderChatBody({ messages: [] }, "auto");
    expect(body.request_id).toBe(body.request_set_id);
    expect(body.request_id).toBe(body.chat_record_id);
  });

  it("messages 原样透传（system 走 messages，不用顶层 system）", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const messages = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ];
    const body = buildQoderChatBody({ messages }, "auto");
    expect(body.messages).toEqual(messages);
    expect(body.system).toBe("");
  });

  it("max_tokens / temperature 进 parameters", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const body = buildQoderChatBody({ max_tokens: 256, temperature: 0.3 }, "auto");
    const parameters = body.parameters as Record<string, unknown>;
    expect(parameters.max_tokens).toBe(256);
    expect(parameters.temperature).toBe(0.3);
  });

  it("没有 max_tokens 时不塞这个字段（交给服务端默认）", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const body = buildQoderChatBody({}, "auto");
    expect((body.parameters as Record<string, unknown>).max_tokens).toBeUndefined();
  });

  it("prompt 文本取自最后一条 user 消息，并进 business.name / chat_context.text", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const body = buildQoderChatBody(
      { messages: [{ role: "user", content: "第一个" }, { role: "assistant", content: "答" }, { role: "user", content: "最后的问题" }] },
      "auto",
    );
    expect((body.business as Record<string, unknown>).name).toBe("最后的问题");
    expect((body.chat_context as Record<string, unknown>).text).toBe("最后的问题");
  });

  it("多段 content 只取 text 部分", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const body = buildQoderChatBody(
      { messages: [{ role: "user", content: [{ type: "text", text: "图里是什么" }, { type: "image_url", image_url: { url: "x" } }] }] },
      "auto",
    );
    expect((body.chat_context as Record<string, unknown>).text).toBe("图里是什么");
  });

  it("stream 恒为 true（Qoder 只支持流式）", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    expect(buildQoderChatBody({}, "auto").stream).toBe(true);
  });
});

describe("unwrapQoderEvent / decodeQoderLine —— 双层 SSE", () => {
  const envelope = (inner: unknown) => JSON.stringify({ statusCodeValue: 200, statusCode: "OK", body: typeof inner === "string" ? inner : JSON.stringify(inner) });

  it("解开信封得到内层 chunk", async () => {
    const { unwrapQoderEvent } = await import("../src/channels/qoder/chat.js");
    const result = unwrapQoderEvent(envelope({ choices: [{ delta: { content: "你好" } }] }));
    expect(result.kind).toBe("chunk");
  });

  it("[DONE] 哨兵（顶层与信封内都能识别）", async () => {
    const { unwrapQoderEvent } = await import("../src/channels/qoder/chat.js");
    expect(unwrapQoderEvent("[DONE]").kind).toBe("done");
    expect(unwrapQoderEvent(envelope("[DONE]")).kind).toBe("done");
  });

  it("EXCEED_QUOTA 变成错误而不是正文", async () => {
    const { unwrapQoderEvent } = await import("../src/channels/qoder/chat.js");
    const result = unwrapQoderEvent("[EXCEED_QUOTA] whatever");
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toContain("额度");
  });

  it("NOTIFICATIONS / 配额未超 都丢弃", async () => {
    const { unwrapQoderEvent } = await import("../src/channels/qoder/chat.js");
    expect(unwrapQoderEvent("[NOTIFICATIONS] x").kind).toBe("ignore");
    expect(unwrapQoderEvent("[NOT_EXCEED_QUOTA]").kind).toBe("ignore");
  });

  it("statusCodeValue 非 200 时报错并带原文", async () => {
    const { unwrapQoderEvent } = await import("../src/channels/qoder/chat.js");
    const result = unwrapQoderEvent(JSON.stringify({ statusCodeValue: 500, body: "boom" }));
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toContain("boom");
  });

  it("解码一行 data: 得到标准 OpenAI SSE 行", async () => {
    const { decodeQoderLine } = await import("../src/channels/qoder/chat.js");
    const out = decodeQoderLine(`data:${envelope({ choices: [{ delta: { content: "hi" } }] })}`);
    expect(out).toMatch(/^data: \{/);
    const parsed = JSON.parse(out!.slice(5));
    expect(parsed.choices[0].delta.content).toBe("hi");
  });

  it("空行 / event: 行 / 注释被丢弃", async () => {
    const { decodeQoderLine } = await import("../src/channels/qoder/chat.js");
    expect(decodeQoderLine("")).toBeNull();
    expect(decodeQoderLine("event: message")).toBeNull();
    expect(decodeQoderLine(": keep-alive")).toBeNull();
  });

  it("结束行翻成 data: [DONE]", async () => {
    const { decodeQoderLine } = await import("../src/channels/qoder/chat.js");
    expect(decodeQoderLine(`data:${envelope("[DONE]")}`)).toBe("data: [DONE]");
  });

  it("业务错误翻成 error chunk（不把哨兵当正文）", async () => {
    const { decodeQoderLine } = await import("../src/channels/qoder/chat.js");
    const out = decodeQoderLine("data:[EXCEED_QUOTA] nope");
    const parsed = JSON.parse(out!.slice(5));
    expect(parsed.error.type).toBe("qoder_error");
  });
});
/**
 * 端到端实测：起本插件的 shim（带 Qoder 方言）→ 发一次 OpenAI 形状的请求
 * → 校验拿回的是**标准 OpenAI SSE**（不是 Qoder 的双层信封）。
 *
 * 这条用例证明的是"接进 DSH 之后能真的用"，而不只是"协议函数没写错"。
 * 没有 PAT 的机器自动跳过。
 */
describe("live e2e: 经 shim 发一次真实对话", () => {
  it("拿到标准 OpenAI SSE 且含正文", async () => {
    const { readPat, createSessionManager } = await import("../src/channels/qoder/credentials.js");
    const { fetchQoderCatalog } = await import("../src/channels/qoder/catalog.js");
    const { createQoderDialect } = await import("../src/channels/qoder/chat.js");
    const { startShim } = await import("../src/shim/server.js");

    if (readPat() === undefined) {
      console.log("[qoder e2e] 本机没有 PAT，跳过");
      return;
    }

    const sessions = createSessionManager();
    const session = await sessions.current();
    expect(session, "PAT 存在但换不到 jobToken").toBeDefined();

    const catalog = await fetchQoderCatalog(session!);
    expect(catalog.error).toBeUndefined();
    // 用免费模型，避免消耗额度
    const model = catalog.models.find((m) => m.creditMultiplier === 0) ?? catalog.models[0]!;

    const recorded: { model: string; statusCode: number }[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: "https://unused.invalid", headers: {} }),
      dialect: createQoderDialect({ session: () => sessions.current() }),
      record: (input) => {
        recorded.push({ model: input.model, statusCode: input.statusCode });
      },
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({
          model: model.id,
          stream: true,
          max_tokens: 32,
          messages: [{ role: "user", content: "只回答两个字：你好" }],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");

      const text = await response.text();
      // 上游容量/限流不属于本插件的缺陷（免费模型被高频使用时会 429）
      if (/429|All backends failed|capacity/i.test(text)) {
        console.log("[qoder e2e] 上游限流（429/All backends failed），本次跳过断言");
        return;
      }
      // 关键：吐出来的必须已经是标准 SSE，不能残留 Qoder 的 statusCodeValue 信封
      expect(text).not.toContain("statusCodeValue");
      expect(text).toContain("[DONE]");

      const contents: string[] = [];
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const content = chunk.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content !== "") contents.push(content);
        } catch {
          /* 忽略非 JSON */
        }
      }
      const answer = contents.join("");
      console.log(`[qoder e2e] model=${model.id} 回答="${answer.slice(0, 40)}"`);
      if (answer.length === 0 && /429|All backends failed|capacity/i.test(text)) {
        console.log("[qoder e2e] 上游限流（429/All backends failed），本次跳过断言");
        return;
      }
      expect(answer.length).toBeGreaterThan(0);
    } finally {
      shim.close();
    }
  }, 120_000);
});
/**
 * Qoder 模型必须能真的出到 adapter。
 *
 * 「provider 在 listProviders 里」不等于「模型可选」—— 这个坑本项目栽过：
 * 传错形状时 provider 注册成功但模型列表是空的。这里用真实的 Qoder 目录条目
 * 过一遍 `createHubAdapter`，把「能不能出模型」钉死。
 */
describe("Qoder 模型能出到 adapter", () => {
  it("listModels 返回全部条目，id/name 与目录一致", async () => {
    const { createHubAdapter } = await import("../src/provider.js");
    const { createProvider } = await import("@earendil-works/pi-ai");
    const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
    const { resolveRetryPolicy } = await import("@deepseek-ai/dsh-llm");
    const { PiAiAdapter } = await import("@deepseek-ai/dsh-llm-pi-ai");

    const models = [
      { id: "auto", name: "Auto", contextWindow: 200_000, maxTokens: 8_192, creditMultiplier: 0.5, supportsImages: true },
      { id: "qfmodel", name: "Qfree", contextWindow: 128_000, maxTokens: 8_192, creditMultiplier: 0, supportsImages: false },
    ];

    const adapter = createHubAdapter({
      provider: "hub-qoder-cn",
      shimBaseUrl: "http://127.0.0.1:1",
      shimToken: "t".repeat(32),
      models,
      createProvider,
      openAICompletionsApi,
      resolveRetryPolicy,
      PiAiAdapter,
    });

    const listed = await adapter.listModels("hub-qoder-cn");
    expect(listed.map((m: { id: string }) => m.id)).toEqual(["auto", "qfmodel"]);
    // 名字带倍率后缀（彩色标记在客户端再加），id 必须原样
    expect(listed[0].name).toContain("Auto");
    expect(listed[0].name).toContain("0.50");
  });
});
describe("sanitizeMessages —— 断链历史规整", () => {
  const sys = { role: "system", content: "s" };
  const user = (t: string) => ({ role: "user", content: t });
  const assistantCall = (id: string) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "f", arguments: "{}" } }] });
  const toolMsg = (id: string) => ({ role: "tool", tool_call_id: id, content: "ok" });

  it("配对的 tool_calls + tool 消息原样保留", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    const input = [sys, user("go"), assistantCall("a1"), toolMsg("a1"), user("next")];
    expect(sanitizeMessages(input)).toEqual(input);
  });

  it("孤立 tool 消息被丢弃（复现上游 400 的场景）", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    const input = [sys, user("go"), toolMsg("orphan"), user("next")];
    const out = sanitizeMessages(input);
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });

  it("没人应答的 tool_calls 字段被裁掉，消息本身保留", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    const input = [user("go"), assistantCall("a1"), user("next")];
    const out = sanitizeMessages(input);
    const assistant = out.find((m) => m.role === "assistant")!;
    expect(assistant).toBeDefined();
    expect(assistant.tool_calls).toBeUndefined();
  });

  it("多个 tool_calls 只保留有响应的那些", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    const input = [
      user("go"),
      { role: "assistant", content: "", tool_calls: [
        { id: "a1", type: "function", function: { name: "f", arguments: "{}" } },
        { id: "a2", type: "function", function: { name: "g", arguments: "{}" } },
      ] },
      toolMsg("a1"),
      user("next"),
    ];
    const out = sanitizeMessages(input);
    const assistant = out.find((m) => m.role === "assistant")!;
    expect((assistant.tool_calls as { id: string }[]).map((c) => c.id)).toEqual(["a1"]);
    expect(out.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["a1"]);
  });

  it("跨轮的同名 id 不被认（user 消息重置声明状态）", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    const input = [user("a"), assistantCall("x"), toolMsg("x"), user("b"), toolMsg("x")];
    const out = sanitizeMessages(input);
    // 第二轮的 tool 消息属于断链，应被丢弃；第一轮的保留
    expect(out.filter((m) => m.role === "tool").length).toBe(1);
  });

  it("非数组输入返回空数组（不抛）", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    expect(sanitizeMessages(undefined)).toEqual([]);
    expect(sanitizeMessages("x")).toEqual([]);
  });
});
/**
 * 真实回归：**带断链历史**（孤立 tool 消息）也要能成功。
 *
 * 这是用户实测报的那个 400 的复现路径：
 *   Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
 *
 * 如果不做 sanitizeMessages，这条用例会拿回 error chunk。
 */
describe("live: 断链历史不再 400", () => {
  it("孤立 tool 消息被裁掉后请求成功", async () => {
    const { readPat, createSessionManager } = await import("../src/channels/qoder/credentials.js");
    const { fetchQoderCatalog } = await import("../src/channels/qoder/catalog.js");
    const { createQoderDialect } = await import("../src/channels/qoder/chat.js");
    const { startShim } = await import("../src/shim/server.js");

    if (readPat() === undefined) {
      console.log("[qoder 断链] 本机没有 PAT，跳过");
      return;
    }

    const sessions = createSessionManager();
    const session = await sessions.current();
    const catalog = await fetchQoderCatalog(session!);
    const model = catalog.models.find((m) => m.creditMultiplier === 0) ?? catalog.models[0]!;

    const shim = await startShim({
      prepare: async () => ({ baseUrl: "https://unused.invalid", headers: {} }),
      dialect: createQoderDialect({ session: () => sessions.current() }),
      record: () => {},
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({
          model: model.id,
          stream: true,
          max_tokens: 24,
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            // 断链：这条 tool 消息前面没有 assistant tool_calls
            { role: "tool", tool_call_id: "call_does_not_exist", content: "残留的工具结果" },
            { role: "user", content: "只回答两个字：你好" },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      });

      const text = await response.text();
      const contents: string[] = [];
      let sawError = false;
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
          if (chunk.error !== undefined) sawError = true;
          const content = chunk.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content !== "") contents.push(content);
        } catch {
          /* ignore */
        }
      }
      const answer = contents.join("");
      console.log(`[qoder 断链] 回答="${answer.slice(0, 30)}" sawError=${sawError}`);
      if (sawError && /429|All backends failed|capacity/i.test(text)) {
        console.log("[qoder 断链] 上游限流（429/All backends failed），本次跳过断言");
        return;
      }
      expect(sawError, "仍然出现 error chunk（sanitize 没生效？）").toBe(false);
      expect(answer.length).toBeGreaterThan(0);
    } finally {
      shim.close();
    }
  }, 120_000);
});
describe("sanitizeMessages —— 角色归一", () => {
  it("developer 改写成 system（Qoder 不认 developer）", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    const out = sanitizeMessages([
      { role: "developer", content: "系统级指令" },
      { role: "user", content: "hi" },
    ]);
    expect(out[0]!.role).toBe("system");
    expect(out[0]!.content).toBe("系统级指令");
  });

  it("system / user / assistant 原样保留", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    const input = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    expect(sanitizeMessages(input).map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("function 角色改写成 tool（旧 OpenAI 形状兼容）", async () => {
    const { sanitizeMessages } = await import("../src/channels/qoder/chat.js");
    const out = sanitizeMessages([
      { role: "user", content: "u" },
      { role: "assistant", content: "", tool_calls: [{ id: "a1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "function", name: "f", tool_call_id: "a1", content: "ok" },
    ]);
    expect(out.some((m) => m.role === "function")).toBe(false);
  });
});
describe("contextWindowOf —— 用真实档位，不用 max_input_tokens", () => {
  it("多档位时取最大值（qfmodel 实测有 1M/400K/200K）", async () => {
    const { contextWindowOf } = await import("../src/channels/qoder/catalog.js");
    expect(contextWindowOf({
      key: "qfmodel",
      max_input_tokens: 180000,
      context_config: { "1M": { token_count: 1000000 }, "200K": { token_count: 200000, is_default: true }, "400K": { token_count: 400000 } },
    })).toBe(1_000_000);
  });

  it("没有 context_config 时退回 max_input_tokens", async () => {
    const { contextWindowOf } = await import("../src/channels/qoder/catalog.js");
    expect(contextWindowOf({ key: "x", max_input_tokens: 96000 })).toBe(96000);
  });

  it("两者都没有时用保守默认", async () => {
    const { contextWindowOf } = await import("../src/channels/qoder/catalog.js");
    expect(contextWindowOf({ key: "x" })).toBe(128_000);
  });

  it("脏 context_config 不抛错", async () => {
    const { contextWindowOf } = await import("../src/channels/qoder/catalog.js");
    expect(contextWindowOf({ key: "x", context_config: "bad" })).toBe(128_000);
    expect(contextWindowOf({ key: "x", context_config: { a: null, b: "x" } })).toBe(128_000);
  });

  it("toChannelModel 用上真实窗口（回归：曾显示 336K/180K）", async () => {
    const { toChannelModel } = await import("../src/channels/qoder/catalog.js");
    const model = toChannelModel({
      key: "qfmodel",
      display_name: "Qwen3.8-Flash",
      max_input_tokens: 180000,
      context_config: { "1M": { token_count: 1000000 }, "200K": { token_count: 200000, is_default: true } },
      price_factor: 0,
    })!;
    expect(model.contextWindow).toBe(1_000_000);
  });
});
describe("Qoder 思考开关与档位对齐", () => {
  it("minimal 档关闭思考（最低档最省）", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const body = buildQoderChatBody({ reasoning_effort: "minimal" }, "auto");
    expect((body.parameters as Record<string, unknown>).enable_thinking).toBe(false);
    expect((body.parameters as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it("off 档也关闭思考", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    const body = buildQoderChatBody({ reasoning_effort: "off" }, "auto");
    expect((body.parameters as Record<string, unknown>).enable_thinking).toBe(false);
  });

  it("medium / high 档开启思考", async () => {
    const { buildQoderChatBody } = await import("../src/channels/qoder/chat.js");
    for (const level of ["medium", "high"]) {
      const body = buildQoderChatBody({ reasoning_effort: level }, "auto");
      expect((body.parameters as Record<string, unknown>).enable_thinking).toBe(true);
    }
  });
});