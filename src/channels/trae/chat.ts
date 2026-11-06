import { randomBytes } from "node:crypto";
import type { ShimDialect } from "../../shim/server.js";
import { TRAE_DEFAULT_FUNCTION, decodeTraeModelId } from "./catalog.js";
import { assertTraeTokenFresh, TRAE_VERSION_FALLBACK_HINT, type TraeCredential } from "./credentials.js";

/**
 * Trae 的对话方言：OpenAI 请求 → Trae 请求，Trae SSE → OpenAI SSE。
 *
 * ## 请求侧
 *
 * 端点 `POST {gateway}/api/agent/v3/llm_utils_chat`（Go 服务，内部名
 * `llm_raw_chat_v2`）。**不是** `/api/ide/v2/llm_raw_chat` —— 那条是 BYOK
 * 通道，外部调用只会拿到 `2001 failed to get app config`。
 *
 * 三样东西缺一不可（2026-11-05 实测）：
 *
 * 1. **`config_name`** 才是模型选择字段。只发 `model_name` 时上游一律按
 *    function 的默认模型回答（`provider_model_name` 恒为同一个值），看起来
 *    「成功」但选的模型根本没生效；同时发 `model_name` + `config_name` 反而
 *    回 `4023 model is unknown`。
 * 2. **`messages[].content` 必须是对象数组**（`[{type:"text",text:"…"}]`），
 *    给字符串会回 `cannot unmarshal string into Go struct field …`。
 * 3. **请求头**里除了 `Authorization: Cloud-IDE-JWT <token>`，还要
 *    `x-ide-token` + `x-ide-version-code` + `x-app-id`。少了 version-code /
 *    app-id 时上游回 **HTTP 200 + `event:error {"code":4120}`**（空 message），
 *    看起来像鉴权失败，实际是客户端身份不全。
 *
 * ## 响应侧
 *
 * Trae 永远回 `200 text/event-stream`，事件名在**独立的一行**（`event:output`）
 * 上，数据在下一行（`data:{…}`）。所以要按事件名解释 payload，而 shim 是按行
 * 喂进来的 —— 解码器必须**带状态**，且每个请求一份（并发请求的事件名不能
 * 串）。这就是 `ShimDialect.request` 允许返回 `decodeLine` 的原因。
 *
 * 事件类型：
 * - `metadata` / `timing_cost` / `progress_notice` → 丢弃
 * - `output` → `{response, reasoning_content, tool_calls}` → OpenAI delta
 * - `token_usage` → 暂存，收尾时挂到最后一条 chunk 上
 * - `error` → 翻成 `{"error":{…}}`，让 shim 记成一次失败
 * - `done` → finish_reason + `[DONE]`
 */

/** 默认 function（与目录层同一个常量；模型 id 的 `@` 后缀可覆盖）。 */
export { TRAE_DEFAULT_FUNCTION };

/** Trae 的消息形状。 */
interface TraeMessage {
  role: string;
  content: { type: string; text?: string; image_url?: { url: string } }[];
  tool_calls?: unknown;
  tool_call_id?: string;
}

/**
 * OpenAI 的 `tool_calls` → Trae 的历史形状。
 *
 * 实测（2026-11-05）Trae **不认** OpenAI 的 `{function:{name,arguments}}`：
 * 带这种历史的请求上游回
 * `2001 LLMUtilsChat ChatStream failed: failed to receive stream event`。
 * 它认的是旧版 OpenAI 形状 `{id, type:"function", function_call:{name, arguments}}`，
 * 且 `arguments` 必须是 **JSON 字符串** —— 换成对象会被 Go 结构体拒。
 */
function toTraeToolCalls(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: unknown[] = [];
  for (const raw of value) {
    const call = recordOf(raw);
    const fn = recordOf(call["function"]);
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (name === "") continue;
    const args =
      typeof fn["arguments"] === "string" ? fn["arguments"] : JSON.stringify(fn["arguments"] ?? {});
    out.push({
      id: typeof call["id"] === "string" ? call["id"] : "",
      type: "function",
      function_call: { name, arguments: args },
    });
  }
  return out.length === 0 ? undefined : out;
}

/**
 * OpenAI 的 `tools` → Trae 的 `tools`。
 *
 * 唯一的硬约束：`function.parameters` 必须是**字符串**。给对象时上游回
 * `4001 bad request: json: cannot unmarshal object into Go struct field
 * FunctionDefinition.tools.function.parameters of type string`（实测）。
 */
function toTraeTools(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: unknown[] = [];
  for (const raw of value) {
    const tool = recordOf(raw);
    const fn = recordOf(tool["function"]);
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (name === "") continue;
    const parameters =
      typeof fn["parameters"] === "string" ? fn["parameters"] : JSON.stringify(fn["parameters"] ?? {});
    out.push({
      type: "function",
      function: {
        name,
        ...(typeof fn["description"] === "string" ? { description: fn["description"] } : {}),
        parameters,
      },
    });
  }
  return out.length === 0 ? undefined : out;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * OpenAI `messages` → Trae `messages`。
 *
 * `inlineSystem`（默认开）：把 system 文本并入首条 user 消息。Trae 的
 * function 自带一套系统提示，直接发 `role:"system"` 不保证被接受；
 * 并进 user 是最稳的写法（dsh-connect 的实测结论，我们沿用）。
 */
export function toTraeMessages(messages: unknown, inlineSystem = true): TraeMessage[] {
  const list = Array.isArray(messages) ? messages : [];
  const out: TraeMessage[] = [];
  const systemTexts: string[] = [];

  for (const item of list) {
    const message = recordOf(item);
    const role = typeof message["role"] === "string" ? (message["role"] as string) : "user";
    const parts: TraeMessage["content"] = [];

    const content = message["content"];
    if (typeof content === "string") {
      if (content !== "") parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        const part = recordOf(raw);
        if (part["type"] === "text" && typeof part["text"] === "string") {
          if ((part["text"] as string) !== "") parts.push({ type: "text", text: part["text"] as string });
        } else if (part["type"] === "image_url") {
          const image = recordOf(part["image_url"]);
          if (typeof image["url"] === "string" && (image["url"] as string) !== "") {
            parts.push({ type: "image_url", image_url: { url: image["url"] as string } });
          }
        }
      }
    }

    if (role === "system" || role === "developer") {
      if (inlineSystem) {
        for (const part of parts) if (typeof part.text === "string") systemTexts.push(part.text);
        continue;
      }
      if (parts.length === 0) continue;
      out.push({ role: "system", content: parts });
      continue;
    }

    if (parts.length === 0 && role !== "assistant") continue;

    const mappedRole = role === "tool" || role === "function" ? "tool" : role === "assistant" ? "assistant" : "user";
    const message_: TraeMessage = { role: mappedRole, content: parts };
    // 工具轮的上下文：assistant 的 tool_calls 与 tool 的 tool_call_id 必须成对
    // 出现，否则上游回 `4027 No tool call found for function call output`。
    // 形状要转成 Trae 认的 `function_call`（理由见 toTraeToolCalls）。
    if (mappedRole === "assistant") {
      const toolCalls = toTraeToolCalls(message["tool_calls"]);
      if (toolCalls !== undefined) message_.tool_calls = toolCalls;
    }
    if (mappedRole === "tool" && typeof message["tool_call_id"] === "string") {
      message_.tool_call_id = message["tool_call_id"];
    }
    out.push(message_);
  }

  if (systemTexts.length > 0) {
    const prefix = { type: "text", text: systemTexts.join("\n\n") } as const;
    const firstUser = out.find((message) => message.role === "user");
    if (firstUser === undefined) out.unshift({ role: "user", content: [{ ...prefix }] });
    else firstUser.content = [{ ...prefix }, ...firstUser.content];
  }
  if (out.length === 0) out.push({ role: "user", content: [{ type: "text", text: "" }] });
  return out;
}

/** 请求体（导出便于单测逐字比对）。 */
export function buildTraeChatBody(
  openaiBody: Record<string, unknown>,
  model: string,
  functionName: string,
  credential: Pick<TraeCredential, "appId" | "appVersionCode">,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    app_id: credential.appId,
    app_version_code: credential.appVersionCode,
    function: functionName,
    // **只发 config_name**：同时发 model_name 会被判成未知模型（4023）。
    config_name: model,
    messages: toTraeMessages(openaiBody["messages"]),
    stream: true,
  };
  const maxTokens = openaiBody["max_tokens"] ?? openaiBody["max_completion_tokens"];
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    body["max_tokens"] = Math.trunc(maxTokens);
  }
  // 工具声明：Trae 认工具帧（实测能回原生 tool_calls），但 parameters 要字符串。
  const tools = toTraeTools(openaiBody["tools"]);
  if (tools !== undefined) body["tools"] = tools;
  // 思考档位：DSH 的「思考强度」/滑动变阻器提交的就是这个字段。
  // 上游对 low/medium/high/minimal/off/none 一律 200（不支持的模型自己忽略），
  // 所以照原样透传 —— 丢掉它就等于把用户选的档位吞了。
  const effort = openaiBody["reasoning_effort"];
  if (typeof effort === "string" && effort !== "") body["reasoning_effort"] = effort;
  const effortLevel = openaiBody["reasoning_effort_level"];
  if (typeof effortLevel === "number" && Number.isFinite(effortLevel)) {
    body["reasoning_effort_level"] = Math.trunc(effortLevel);
  }
  return body;
}

/** Trae 的控制事件里能拿到的版本上下文（用于把 4120 翻译成可执行的提示）。 */
export interface TraeVersionContext {
  appVersionCode?: number;
  appVersionSource?: string;
  productPath?: string;
}

/** 上游错误码 → 人话。原始 message 常为空或指不到成因，必须翻译。 */
export function explainTraeError(code: unknown, message: unknown, version?: TraeVersionContext): string {
  const text = typeof message === "string" && message !== "" ? message : "";
  const numeric = typeof code === "number" ? code : undefined;
  if (numeric === 2001) {
    return `Trae 未为该 appId 注册这个 function（可用：solo_agent_lite / solo_coder / solo_work_lite …）；原始响应：${text || "（空）"}`;
  }
  if (numeric === 4023 || /model is unknown/i.test(text)) {
    return "Trae 不认识这个模型名（config_name 必须来自该 function 的模型清单；面板「展开」可看）";
  }
  if (numeric === 4001) return "Trae 认为参数非法（自定义 openai-compatible 模型不能走这条通道）";
  if (numeric === 4120) {
    /*
     * 4120 是「客户端身份被拒」，但上游把 message 留空 —— 用户只能看到一句
     * 没有信息量的错误码。最常见的两个成因：
     *   1. `x-ide-version-code` 用的是内置兜底 buildId（没读到 product.json）；
     *   2. Trae 升级/降级后 buildId 与凭据里的版本对不上。
     * 所以这里必须把「实际用的版本 + 来源」写出来，并给出下一步动作。
     */
    if (version?.appVersionSource === "fallback") {
      return (
        `Trae 拒收（4120）：客户端版本号用的是内置兜底 build ${version.appVersionCode ?? "未知"}，` +
        "说明没读到你本机 Trae 的 resources/app/product.json。\n" +
        TRAE_VERSION_FALLBACK_HINT
      );
    }
    const versionText =
      version?.appVersionCode === undefined
        ? "x-ide-version-code 未知"
        : `x-ide-version-code=${version.appVersionCode}` +
          (version.appVersionSource === "product"
            ? `（来自 product.json${version.productPath === undefined ? "" : `：${version.productPath}`}）`
            : version.appVersionSource === "credential"
              ? "（来自凭据文件）"
              : "");
    return (
      `Trae 拒收（4120）：客户端身份头被拒，${versionText}。` +
      "升级/降级过 Trae 的话，在 Trae 里退出重登一次，再回面板点「一键认证」重新导入；仍失败请把这句原文带上反馈。"
    );
  }
  if (/token|expired|unauthor|login/i.test(text)) return "Trae 登录态失效，请在 Trae 里重新登录后到面板点「一键认证」";
  return text !== "" ? text : numeric === undefined ? "Trae 上游返回了空错误" : `Trae 上游错误码 ${numeric}`;
}

/** 每个请求一份的解码器（事件名状态不能跨请求）。 */
export function createTraeEventDecoder(model: string, version?: TraeVersionContext): (line: string) => string | null {
  const id = `chatcmpl-trae-${randomBytes(8).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let event = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  let finished = false;
  /** 已经发过「头部」（id/name）的 tool_call index —— 后续分片只带参数。 */
  const toolCallHeaders = new Set<number>();
  /** 本轮是否出现过工具调用（决定 finish_reason；Trae 自己回的是 `stop`）。 */
  let sawToolCalls = false;

  const chunk = (delta: Record<string, unknown>, finishReason?: string): string => {
    const payload: Record<string, unknown> = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (finishReason !== undefined && usage !== undefined) {
      payload["usage"] = {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      };
    }
    return `data: ${JSON.stringify(payload)}`;
  };

  return (line: string): string | null => {
    const text = line.replace(/\r$/, "");
    if (text === "") {
      // 事件边界：事件名不跨事件复用
      event = "";
      return null;
    }
    if (text.startsWith(":")) return null;
    if (text.startsWith("event:")) {
      event = text.slice(6).trim();
      return null;
    }
    if (!text.startsWith("data:")) return null;
    const payload = text.slice(5).trim();
    if (payload === "") return null;

    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      data = parsed as Record<string, unknown>;
    } catch {
      // progress_notice 这类事件是裸字符串，没有可翻译的内容
      return null;
    }

    if (event === "output") {
      const reasoning = typeof data["reasoning_content"] === "string" ? (data["reasoning_content"] as string) : "";
      const content = typeof data["response"] === "string" ? (data["response"] as string) : "";
      // 有的模型/function 把思考塞进 response，用 phase 区分；phase 缺失或
      // 为 final_answer 时一律当正文。
      const phase = typeof data["phase"] === "string" ? (data["phase"] as string) : "";
      const isThinking = phase !== "" && phase !== "final_answer";
      const lines: string[] = [];
      if (reasoning !== "") lines.push(chunk({ reasoning_content: reasoning }));
      if (content !== "") lines.push(chunk(isThinking ? { reasoning_content: content } : { content }));
      /*
       * Trae 的工具调用是**旧版 OpenAI 形状**且按分片流式下发：
       *
       * ```
       * {"index":0,"id":"call_x","type":"function",
       *  "function_call":{"name":"get_weather","arguments":""}}
       * {"index":0,"id":"","type":"",
       *  "function_call":{"name":"","arguments":"{\"city\""}}
       * ```
       *
       * 要翻成现在的 OpenAI `delta.tool_calls[].function.{name,arguments}`：
       * - 头部（id / type / name）只发**一次**，重复发会让 pi-ai 以为开了新调用；
       * - 参数分片逐条转发，`arguments` 不合法会被下游拼坏。
       */
      if (Array.isArray(data["tool_calls"]) && (data["tool_calls"] as unknown[]).length > 0) {
        const mapped: Record<string, unknown>[] = [];
        for (const raw of data["tool_calls"] as unknown[]) {
          const call = recordOf(raw);
          const index = typeof call["index"] === "number" ? (call["index"] as number) : 0;
          const fn = recordOf(call["function_call"]);
          const callId = typeof call["id"] === "string" ? (call["id"] as string) : "";
          const name = typeof fn["name"] === "string" ? (fn["name"] as string) : "";
          const args = typeof fn["arguments"] === "string" ? (fn["arguments"] as string) : "";
          if (callId === "" && name === "" && args === "") continue;
          const entry: Record<string, unknown> = { index, function: {} as Record<string, string> };
          const fnOut = entry["function"] as Record<string, string>;
          if (!toolCallHeaders.has(index)) {
            if (callId !== "") entry["id"] = callId;
            entry["type"] = "function";
            if (name !== "") fnOut["name"] = name;
            if (callId !== "" || name !== "") toolCallHeaders.add(index);
          }
          if (args !== "") fnOut["arguments"] = args;
          if (name !== "") sawToolCalls = true;
          mapped.push(entry);
        }
        if (mapped.length > 0) lines.push(chunk({ tool_calls: mapped }));
      }
      return lines.length === 0 ? null : lines.join("\n\n");
    }

    if (event === "token_usage") {
      usage = {
        ...(typeof data["prompt_tokens"] === "number" ? { prompt_tokens: data["prompt_tokens"] as number } : {}),
        ...(typeof data["completion_tokens"] === "number" ? { completion_tokens: data["completion_tokens"] as number } : {}),
        ...(typeof data["total_tokens"] === "number" ? { total_tokens: data["total_tokens"] as number } : {}),
      };
      // **单独发一条 usage-only chunk**：`choices: []` + 顶层 `usage` 是
      // OpenAI 流式计费的合法形状，pi-ai 与 shim 的埋点都读顶层 `usage`。
      // 不能把它和终止 chunk 拼在同一行里 —— shim 按行解析，拼了就会 JSON
      // 解析失败，记录里那条请求就变成「用了但没用量」。
      return `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        },
      })}`;
    }

    if (event === "error") {
      const message = explainTraeError(data["code"], data["message"], version);
      return `data: ${JSON.stringify({ error: { message, type: "trae_error", code: data["code"] ?? null } })}`;
    }

    if (event === "done") {
      if (finished) return null;
      finished = true;
      const upstreamReason = typeof data["finish_reason"] === "string" ? (data["finish_reason"] as string) : "stop";
      // **Trae 在工具轮也回 `finish_reason:"stop"`**（实测 2026-11-05）。
      // 原样透传会让宿主把这一轮当成「回答完了」，工具永远不会被执行 ——
      // 只要本轮出现过 tool_calls，就必须改写成 `tool_calls`。
      const finishReason = sawToolCalls ? "tool_calls" : upstreamReason;
      // 一行翻译里带上终止 chunk 与 [DONE]：shim 会给整段补 `\n\n`，
      // 输出就是两条合法的 SSE 事件。
      return `${chunk({}, finishReason)}\n\ndata: [DONE]`;
    }

    return null;
  };
}

/** 上游客户端的入参。 */
export interface TraeDialectOptions {
  /** 按账号取凭据（shim 把本次选中的 account 贯通进来）。 */
  credentialFor: (account: { id: string } | undefined) => Promise<TraeCredential | undefined>;
  /** 默认 function；模型 id 的 `@<function>` 后缀优先。 */
  functionName?: string;
}

/** 造 shim 用的方言。 */
export function createTraeDialect(options: TraeDialectOptions): ShimDialect {
  const fallbackFunction = options.functionName ?? TRAE_DEFAULT_FUNCTION;

  return {
    async request(input) {
      const credential = await options.credentialFor(input.account);
      if (credential === undefined) throw new Error("Trae 凭据不可用（token 文件缺失或已失效）");
      assertTraeTokenFresh(credential);

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(input.raw) as Record<string, unknown>;
      } catch {
        /* 不是 JSON 就按空对象处理，下面会重建 */
      }

      const decoded = decodeTraeModelId(input.model, fallbackFunction);
      const body = buildTraeChatBody(parsed, decoded.model, decoded.functionName, credential);
      const base = credential.gateway.replace(/\/+$/, "");

      return {
        url: `${base}/api/agent/v3/llm_utils_chat`,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Cloud-IDE-JWT ${credential.token}`,
          // 三件套里的后两件：缺 version-code / app-id 会得到 200 + 4120。
          "x-ide-token": credential.token,
          "x-ide-version-code": String(credential.appVersionCode),
          "x-app-id": credential.appId,
          "user-agent": "TraeClient/TTNet",
        },
        body: JSON.stringify(body),
        // 每个请求一份解码器：事件名状态不能跨请求串。
        // 版本上下文一并带进去 —— 4120 的文案要指出「用的是哪个 build、从哪来的」。
        decodeLine: createTraeEventDecoder(decoded.model, {
          appVersionCode: credential.appVersionCode,
          ...(credential.appVersionSource === undefined ? {} : { appVersionSource: credential.appVersionSource }),
          ...(credential.productPath === undefined ? {} : { productPath: credential.productPath }),
        }),
      };
    },
  };
}
