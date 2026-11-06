import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptEnvelopeBase64, encryptEnvelope, isTraeEnvelope, jwtExpiryMs } from "../src/channels/trae/crypto.js";
import {
  discoverTraeSession,
  parseTraeCredentialDocument,
  traeTokenDir,
  writeTraeTokenFile,
  TRAE_DEFAULT_APP_VERSION_CODE,
  type TraeCredential,
} from "../src/channels/trae/credentials.js";
import {
  TRAE_FALLBACK_MODELS,
  decodeTraeModelId,
  fetchTraeCatalog,
  modelsFromListMap,
} from "../src/channels/trae/catalog.js";
import {
  buildTraeChatBody,
  createTraeDialect,
  createTraeEventDecoder,
  explainTraeError,
  toTraeMessages,
} from "../src/channels/trae/chat.js";
import { startShim } from "../src/shim/server.js";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createHubAdapter } from "../src/provider.js";

/**
 * Trae 渠道的零件与整机测试。
 *
 * 这套覆盖四层，每层都有过真实踩坑对应的断言：
 * 1. **信封解密**（crypto）：纯算法，改一个字节必须解不开；
 * 2. **凭据发现**（credentials）：从 storage.json 解出 token + 按区域选网关；
 * 3. **目录与方言**（catalog/chat）：`config_name` 选模型、`event:`/`data:` 分行；
 * 4. **整机**（shim e2e）：Trae SSE 经回环 shim 变成 OpenAI SSE，且 usage 进记录。
 */

const OLD_USER_DATA = process.env.TRAE_USER_DATA;
const OLD_HOME = process.env.TRAE_HOME;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-trae-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** 造一张形如 Trae 的 JWT（只为了让 `jwtExpiryMs` 有 exp 可读）。 */
function fakeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, data: { id: "uid-1" } })).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

beforeEach(() => {
  delete process.env.TRAE_USER_DATA;
  delete process.env.TRAE_HOME;
});

afterEach(() => {
  if (OLD_USER_DATA === undefined) delete process.env.TRAE_USER_DATA;
  else process.env.TRAE_USER_DATA = OLD_USER_DATA;
  if (OLD_HOME === undefined) delete process.env.TRAE_HOME;
  else process.env.TRAE_HOME = OLD_HOME;
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响断言 */
    }
  }
});

describe("Trae byteCrypto 信封", () => {
  it("自造信封能解回原文（与客户端的 PRe/ARe 同构）", () => {
    const plain = JSON.stringify({ token: "abc", userId: "u1" });
    const envelope = encryptEnvelope(Buffer.from(plain, "utf8"));
    const bytes = Buffer.from(envelope, "base64");
    expect(isTraeEnvelope(bytes)).toBe(true);
    // 头 74 63 05 10 00 00 = 客户端 AES 信封
    expect(bytes.subarray(0, 6).toString("hex")).toBe("746305100000");
    expect(decryptEnvelopeBase64(envelope)).toBe(plain);
  });

  it("改一个字节就必须解不开（自校验不能被绕过）", () => {
    const envelope = Buffer.from(encryptEnvelope(Buffer.from("hello", "utf8")), "base64");
    envelope[envelope.length - 1] = (envelope[envelope.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptEnvelopeBase64(envelope.toString("base64"))).toThrow();
  });

  it("不是 AES 信封（头不对）时明确报错，不当成空 token 用", () => {
    expect(() => decryptEnvelopeBase64(Buffer.from("not-an-envelope").toString("base64"))).toThrow(/不是 Trae 的 AES 信封/);
  });

  it("jwtExpiryMs 从 JWT payload 里读 exp", () => {
    expect(jwtExpiryMs(fakeJwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(jwtExpiryMs("not-a-jwt")).toBeUndefined();
  });
});

describe("Trae 凭据发现", () => {
  it("从本机 storage.json 解出 token，并按区域选推理网关", () => {
    const root = tempDir("userdata");
    const appHome = tempDir("app");
    const globalStorage = join(root, "User", "globalStorage");
    mkdirSync(globalStorage, { recursive: true });
    // 安装目录里的 product.json：产品级 appId 与 buildId、区域网关表
    mkdirSync(join(appHome, "resources", "app"), { recursive: true });
    writeFileSync(
      join(appHome, "resources", "app", "product.json"),
      JSON.stringify({
        buildId: "1205510027010",
        bootConfig: {
          agent: {
            appId: "test-app-id",
            normal: "https://core-test.example",
            US: "https://coreva-test.example",
          },
        },
      }),
    );
    const token = fakeJwt(1_900_000_000);
    const doc = {
      token,
      refreshToken: "refresh-1",
      userId: "7587963662935409681",
      expiredAt: new Date(1_900_000_000_000).toISOString(),
      userRegion: { region: "US" },
      account: { username: "付庆贺", email: "op@example.com" },
    };
    writeFileSync(
      join(globalStorage, "storage.json"),
      JSON.stringify({ "iCubeAuthInfo://icube.cloudide": encryptEnvelope(Buffer.from(JSON.stringify(doc), "utf8")) }),
    );
    writeFileSync(join(globalStorage, "state.vscdb"), "");

    process.env.TRAE_USER_DATA = root;
    process.env.TRAE_HOME = appHome;

    const { session, error } = discoverTraeSession();
    expect(error).toBeUndefined();
    expect(session?.credential.token).toBe(token);
    expect(session?.credential.userId).toBe("7587963662935409681");
    expect(session?.credential.name).toBe("付庆贺");
    expect(session?.credential.gateway).toBe("https://coreva-test.example");
    expect(session?.credential.appId).toBe("test-app-id");
    expect(session?.credential.appVersionCode).toBe(1205510027010);
    // 版本号来源要能一路带到错误提示里：读到 product.json 就是 product
    expect(session?.credential.appVersionSource).toBe("product");
    expect(session?.credential.productPath).toContain("product.json");
  });

  it("找不到 product.json 时标记为兜底版本（4120 的提示靠这个分支）", () => {
    const root = tempDir("userdata-fallback");
    const emptyApp = tempDir("app-empty");
    const globalStorage = join(root, "User", "globalStorage");
    mkdirSync(globalStorage, { recursive: true });
    const doc = {
      token: fakeJwt(1_900_000_000),
      userId: "u-fallback",
      account: { username: "nobody" },
    };
    writeFileSync(
      join(globalStorage, "storage.json"),
      JSON.stringify({ "iCubeAuthInfo://icube.cloudide": encryptEnvelope(Buffer.from(JSON.stringify(doc), "utf8")) }),
    );
    writeFileSync(join(globalStorage, "state.vscdb"), "");
    process.env.TRAE_USER_DATA = root;
    process.env.TRAE_HOME = emptyApp;

    const { session } = discoverTraeSession();
    expect(session?.credential.appVersionSource).toBe("fallback");
    expect(session?.credential.appVersionCode).toBe(TRAE_DEFAULT_APP_VERSION_CODE);
  });

  it("没有登录态时给出可操作的错误文案", () => {
    process.env.TRAE_USER_DATA = tempDir("empty");
    const { session, error } = discoverTraeSession();
    expect(session).toBeUndefined();
    expect(error).toContain("没有找到 Trae 登录态");
  });

  it("compatible：dsh-connect 的 trae.json 快照也能读（缺的字段用默认值补）", () => {
    const doc = {
      formatVersion: 1,
      token: fakeJwt(1_900_000_000),
      refreshToken: "r",
      userId: "u-9",
      gateway: "https://trae-api-cn.mchost.guru",
      appVersionCode: 1227681842690,
      account: { username: "用户7381384633", scope: "marscode" },
    };
    const credential = parseTraeCredentialDocument(doc, "C:/x/trae.json");
    expect(credential.name).toBe("用户7381384633");
    expect(credential.gateway).toBe("https://trae-api-cn.mchost.guru");
    expect(credential.appVersionCode).toBe(1227681842690);
    expect(credential.expiresAtMs).toBe(1_900_000_000_000);
  });

  it("token 落到自有目录（每账号一个文件）", () => {
    const home = tempDir("home");
    const credential: TraeCredential = {
      token: fakeJwt(1_900_000_000),
      userId: "u-42",
      name: "某人",
      gateway: "https://coreva-test.example",
      appId: "app",
      appVersionCode: 1,
      source: "memory",
    };
    const path = writeTraeTokenFile(home, credential);
    expect(path.startsWith(traeTokenDir(home))).toBe(true);
    expect(path.endsWith(".json")).toBe(true);
  });
});

describe("Trae 模型目录", () => {
  it("按 function 取模型，并过滤自定义端点/去重", () => {
    const models = modelsFromListMap(
      {
        solo_agent_lite: [
          {
            config_name: "kimi-k3",
            display_name: "Kimi-K3",
            multimodal: true,
            max_tokens: 64000,
            model_type: "reasoning_model",
            context_window_tokens: { dev: 200000, max: 1000000 },
          },
          { config_name: "kimi-k3", display_name: "重复项" },
          { config_name: "custom_openai_compatible//hy3-preview", display_name: "hy3" },
          { display_name: "没有 config_name" },
          {
            config_name: "gpt-5.4",
            display_name: "GPT-5.4",
            multimodal: false,
            max_tokens: 32000,
            model_type: "reasoning_model",
            context_window_tokens: { dev: 272000 },
          },
          { config_name: "plain-chat", display_name: "Plain Chat", model_type: "chat_model" },
        ],
      },
      "solo_agent_lite",
    );
    expect(models.map((m) => m.id)).toEqual(["kimi-k3", "gpt-5.4", "plain-chat"]);
    expect(models[0]!.contextWindow).toBe(200_000);
    expect(models[0]!.maxTokens).toBe(64_000);
    expect(models[0]!.supportsImages).toBe(true);
    expect(models[1]!.supportsImages).toBe(false);
    // 思考档位：reasoning_model / features.reasoning.enable 的都算支持，
    // 纯 chat_model 且没有 reasoning 标记的不声明（否则滑动变阻器会多出一个空滑块）
    expect(models[0]!.reasoning).toBe(true);
    expect(models[1]!.reasoning).toBe(true);
    expect(models[2]!.reasoning).toBe(false);
  });

  it("模型 id 支持 @function 覆盖默认 function", () => {
    expect(decodeTraeModelId("gpt-5.4@solo_coder")).toEqual({ model: "gpt-5.4", functionName: "solo_coder" });
    expect(decodeTraeModelId("gpt-5.4@not_a_function")).toEqual({ model: "gpt-5.4@not_a_function", functionName: "solo_agent_lite" });
    expect(decodeTraeModelId("kimi-k3")).toEqual({ model: "kimi-k3", functionName: "solo_agent_lite" });
  });

  it("没有本机缓存时退回内置名单（不抛错）", () => {
    process.env.TRAE_USER_DATA = tempDir("nodir");
    const credential = {
      token: "t",
      userId: "u",
      name: "n",
      gateway: "https://coreva-test.example",
      appId: "a",
      appVersionCode: 1,
      source: "memory",
    } satisfies TraeCredential;
    const result = fetchTraeCatalog(credential);
    expect(result.source).toBe("fallback");
    expect(result.models).toEqual(TRAE_FALLBACK_MODELS);
    expect(result.error).toBeTruthy();
  });
});

describe("Trae 请求构造", () => {
  it("system 并进首条 user；图片按 image_url 透传", () => {
    const messages = toTraeMessages([
      { role: "system", content: "你是助手" },
      {
        role: "user",
        content: [
          { type: "text", text: "看这张图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content[0]).toEqual({ type: "text", text: "你是助手" });
    expect(messages[0]!.content[1]).toEqual({ type: "text", text: "看这张图" });
    expect(messages[0]!.content[2]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
  });

  it("请求体只发 config_name（再发 model_name 会被判未知模型）", () => {
    const body = buildTraeChatBody(
      { model: "kimi-k3", messages: [{ role: "user", content: "hi" }], max_tokens: 128 },
      "kimi-k3",
      "solo_agent_lite",
      { appId: "app-1", appVersionCode: 42 },
    );
    expect(body["config_name"]).toBe("kimi-k3");
    expect(body["model_name"]).toBeUndefined();
    expect(body["function"]).toBe("solo_agent_lite");
    expect(body["app_id"]).toBe("app-1");
    expect(body["app_version_code"]).toBe(42);
    expect(body["stream"]).toBe(true);
    expect(body["max_tokens"]).toBe(128);
    expect((body["messages"] as any[])[0].content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("工具声明透传，且 parameters 必须字符串化（给对象上游回 4001）", () => {    const body = buildTraeChatBody(
      {
        messages: [{ role: "user", content: "北京天气" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "查天气",
              parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            },
          },
        ],
      },
      "gpt-6.1-sol",
      "solo_agent_lite",
      { appId: "a", appVersionCode: 1 },
    );
    const tools = body["tools"] as any[];
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("get_weather");
    expect(tools[0].function.description).toBe("查天气");
    expect(typeof tools[0].function.parameters).toBe("string");
    expect(JSON.parse(tools[0].function.parameters).required).toEqual(["city"]);
  });

  it("思考档位透传：DSH / 滑动变阻器提交的 reasoning_effort 不能被吞", () => {
    const body = buildTraeChatBody(
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      "gpt-6.1-sol",
      "solo_agent_lite",
      { appId: "a", appVersionCode: 1 },
    );
    expect(body["reasoning_effort"]).toBe("high");

    const off = buildTraeChatBody(
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "off" },
      "gpt-6.1-sol",
      "solo_agent_lite",
      { appId: "a", appVersionCode: 1 },
    );
    expect(off["reasoning_effort"]).toBe("off");

    const none = buildTraeChatBody(
      { messages: [{ role: "user", content: "hi" }] },
      "gpt-6.1-sol",
      "solo_agent_lite",
      { appId: "a", appVersionCode: 1 },
    );
    expect(none["reasoning_effort"]).toBeUndefined();
  });

  it("历史里的 tool_calls 要转成 Trae 认的 function_call 形状（OpenAI 形状会被上游拒）", () => {
    const messages = toTraeMessages([
      { role: "user", content: "北京天气" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "晴，25℃" },
    ]);
    const assistant = messages[1] as any;
    expect(assistant.tool_calls[0]).toEqual({
      id: "call_1",
      type: "function",
      function_call: { name: "get_weather", arguments: '{"city":"北京"}' },
    });
    expect(assistant.tool_calls[0].function).toBeUndefined();
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });
});

describe("Trae SSE 解码", () => {
  it("output → delta.content，token_usage → usage chunk，done → 终止 + [DONE]", () => {
    const decode = createTraeEventDecoder("kimi-k3");
    expect(decode("event:metadata")).toBeNull();
    expect(decode('data:{"session_id":"s"}')).toBeNull();
    expect(decode("")).toBeNull();

    expect(decode("event:output")).toBeNull();
    const chunk = decode('data:{"response":"你好","reasoning_content":null}');
    expect(chunk).toContain('"content":"你好"');
    expect(decode("")).toBeNull();

    expect(decode("event:token_usage")).toBeNull();
    const usageChunk = decode('data:{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}');
    expect(usageChunk).toContain('"choices":[]');
    expect(usageChunk).toContain('"prompt_tokens":7');
    expect(decode("")).toBeNull();

    expect(decode("event:done")).toBeNull();
    const done = decode('data:{"finish_reason":"stop"}');
    expect(done).toContain('"finish_reason":"stop"');
    expect(done).toContain("data: [DONE]");
  });

  it("事件名不跨事件复用：空白行之后再来 data 不该当成 output", () => {
    const decode = createTraeEventDecoder("m");
    decode("event:output");
    decode("");
    expect(decode('data:{"response":"x"}')).toBeNull();
  });

  it("thinking 阶段的内容进 reasoning_content，不混进正文", () => {
    const decode = createTraeEventDecoder("m");
    decode("event:output");
    const line = decode('data:{"response":"想一下","phase":"thinking"}');
    expect(line).toContain('"reasoning_content":"想一下"');
    expect(line).not.toContain('"content"');
  });

  it("error 事件翻成 error chunk（shim 会记成失败）", () => {
    const decode = createTraeEventDecoder("m");
    decode("event:error");
    const line = decode('data:{"code":4023,"message":"We are sorry, the model is unknown."}');
    expect(line).toContain('"error"');
    expect(line).toContain("Trae 不认识这个模型名");
  });

  it("工具调用分片 → OpenAI delta.tool_calls，头部只发一次，终止原因改写为 tool_calls", () => {
    const decode = createTraeEventDecoder("gpt-6.1-sol");
    decode("event:output");
    const head = decode(
      'data:{"tool_calls":[{"index":0,"id":"call_x","type":"function","function_call":{"name":"get_weather","arguments":""}}]}',
    );
    expect(head).toContain('"tool_calls"');
    expect(head).toContain('"id":"call_x"');
    expect(head).toContain('"name":"get_weather"');

    decode("event:output");
    const fragment = decode(
      'data:{"tool_calls":[{"index":0,"id":"","type":"","function_call":{"name":"","arguments":"{\\"city\\":\\"北京\\"}"}}]}',
    );
    // 分片只带参数：重复发 id/name 会被 pi-ai 当成第二个调用
    expect(fragment).toContain('"tool_calls":[{"index":0,"function":{"arguments"');
    expect(fragment).not.toContain('"id":"call_');
    expect(fragment).not.toContain('"name"');

    decode("event:done");
    const done = decode('data:{"finish_reason":"stop"}');
    // Trae 工具轮也回 stop —— 必须改写，否则宿主不会去执行工具
    expect(done).toContain('"finish_reason":"tool_calls"');
    expect(done).toContain("[DONE]");
  });

  it("错误码翻译：4120 指向客户端版本与 TRAE_HOME，2001 指向 function", () => {
    // 没带上下文：至少要把字段名与下一步动作说清楚
    expect(explainTraeError(4120, "")).toContain("x-ide-version-code");
    // 兜底版本：必须给出「改 TRAE_HOME」的可执行提示，而不是干巴巴一个 4120
    const fallback = explainTraeError(4120, "", {
      appVersionCode: TRAE_DEFAULT_APP_VERSION_CODE,
      appVersionSource: "fallback",
    });
    expect(fallback).toContain(String(TRAE_DEFAULT_APP_VERSION_CODE));
    expect(fallback).toContain("TRAE_HOME");
    expect(fallback).toContain("product.json");
    // 来自 product.json：说明版本号来源，不再提 TRAE_HOME
    const fromProduct = explainTraeError(4120, "", {
      appVersionCode: 1205510027010,
      appVersionSource: "product",
      productPath: "D:\\TRAE SOLO\\resources\\app\\product.json",
    });
    expect(fromProduct).toContain("1205510027010");
    expect(fromProduct).toContain("product.json");
    expect(fromProduct).not.toContain("TRAE_HOME");
    expect(explainTraeError(2001, "")).toContain("function");
    expect(explainTraeError(undefined, "token expired")).toContain("重新登录");
  });
});

describe("Trae 整机（shim + 方言）", () => {
  it("Trae SSE 经 shim 译成 OpenAI SSE，usage 进记录", async () => {
    const seen: { body: any; headers: Record<string, unknown> }[] = [];
    const upstream = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        seen.push({ body: JSON.parse(raw), headers: req.headers });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event:metadata\ndata:{"session_id":"s"}\n\n');
        res.write('event:output\ndata:{"response":"你","reasoning_content":null}\n\n');
        res.write('event:output\ndata:{"response":"好"}\n\n');
        res.write('event:token_usage\ndata:{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}\n\n');
        res.write('event:done\ndata:{"finish_reason":"stop"}\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const credential: TraeCredential = {
      token: "trae-token",
      userId: "uid-1",
      name: "测试账号",
      gateway: `http://127.0.0.1:${port}`,
      appId: "app-id",
      appVersionCode: 1205510027010,
      source: "memory",
    };

    const records: any[] = [];
    const shim = await startShim({
      prepare: async () => ({ baseUrl: "https://trae.invalid", headers: {}, account: { id: "acct-1" } }),
      dialect: createTraeDialect({ credentialFor: async () => credential }),
      record: (entry) => records.push(entry),
    });

    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({
          model: "kimi-k3@solo_agent_lite",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          // 模拟滑动变阻器提交的档位：必须一路透传到 Trae 请求体
          reasoning_effort: "high",
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"content":"你"');
      expect(text).toContain('"content":"好"');
      expect(text).toContain("[DONE]");
      expect(text).toContain('"prompt_tokens":7');

      // 上游拿到的是 Trae 形状：config_name + 三件套头
      expect(seen[0]!.body.config_name).toBe("kimi-k3");
      expect(seen[0]!.body.function).toBe("solo_agent_lite");
      expect(seen[0]!.body.stream).toBe(true);
      expect(seen[0]!.body.reasoning_effort).toBe("high");
      expect(seen[0]!.headers["x-ide-version-code"]).toBe("1205510027010");
      expect(seen[0]!.headers["x-app-id"]).toBe("app-id");
      expect(String(seen[0]!.headers.authorization)).toContain("Cloud-IDE-JWT trae-token");

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(records).toHaveLength(1);
      expect(records[0].statusCode).toBe(200);
      expect(records[0].model).toBe("kimi-k3@solo_agent_lite");
      expect(records[0].metrics.inputTokens).toBe(7);
      expect(records[0].metrics.outputTokens).toBe(2);
      expect(records[0].accountId).toBe("acct-1");
    } finally {
      shim.close();
      upstream.close();
    }
  }, 20_000);
});

/**
 * 与「滑动变阻器」（dsh-client-liang-intensity-skin）的接口面：
 * 它直接读当前模型的 `reasoning.efforts` 决定滑块档位，并把选中的档位 ID
 * 通过 ModelDirectory 提交。所以「Trae 能不能用滑块」等价于
 * 「hub-trae 的模型在 ModelDirectory 里有没有 efforts」—— 这一组把它钉死。
 */
describe("Trae × 滑动变阻器（思考档位对 ModelDirectory 可见）", () => {
  function adapterForTrae() {
    return createHubAdapter({
      provider: "hub-trae",
      shimBaseUrl: "http://127.0.0.1:1",
      shimToken: "test-token-not-the-literal-shim",
      models: TRAE_FALLBACK_MODELS,
      createProvider,
      openAICompletionsApi,
      resolveRetryPolicy,
      PiAiAdapter,
    });
  }

  it("Trae 模型在模型目录里带 4 档 effort，默认档 high", async () => {
    const model = (await adapterForTrae().resolveModel("hub-trae", "gpt-6.1-sol")) as any;
    expect(model.reasoning?.defaultEffort).toBe("high");
    // pi-ai 的 describable levels 不含 `off`（off = 关思考，不是一档 effort）
    const efforts = (model.reasoning?.efforts ?? []).map((entry: any) => entry.id);
    expect(efforts).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("整套 Trae 模型都能选到（滑块不会因为某个模型缺档位而消失）", async () => {
    const adapter = adapterForTrae();
    const listed = await adapter.listModels("hub-trae");
    expect(listed).toHaveLength(TRAE_FALLBACK_MODELS.length);
    // listModels 是投影（不带 efforts），逐档位要看 resolveModel ——
    // 这正是 ModelDirectory 给滑块取数的那条路。
    for (const id of ["gpt-6.1-sol", "kimi-k3", "deepseek-v4-pro-0813"]) {
      const model = (await adapter.resolveModel("hub-trae", id)) as any;
      expect(model.reasoning?.efforts?.length).toBeGreaterThan(1);
    }
  });
});
