import { randomUUID } from "node:crypto";
import { buildCosyHeaders, qoderEncodeBody } from "./cosy.js";
import type { QoderSession } from "./credentials.js";
import type { ShimDialect } from "../../shim/server.js";

/**
 * Qoder 的对话方言：把 OpenAI 请求翻成 Qoder 的请求，把双层 SSE 翻回 OpenAI SSE。
 *
 * ## 为什么需要这一层
 *
 * 1. **请求体形状不同**：Qoder 要 `request_id / chat_task / chat_context /
 *    model_config / business` 这一整套字段，模型 id 放在 `model_config.key`
 *    而不是顶层的 `model`。
 * 2. **请求体要编码**（`Encode=1`）：标准 base64 → 自定义字母表 → 三段块旋转。
 * 3. **响应是双层信封**：`data:{"statusCodeValue":200,"body":"<JSON 字符串>"}`，
 *    `body` 里面才是 OpenAI chunk；结束哨兵是 `[DONE]`。
 *
 * 实测（2026-10-28）发出 998 字节明文、1428 字节编码体，收到正确回答
 * 「你好」，并带回 usage。
 */

const DEFAULT_GATEWAY = "https://gateway.qoder.com.cn";
const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
/** CN 客户端身份：SDK 里 `Ji ? "qoderclicn" : "qodercli"`。 */
const SESSION_TYPE = "qoderclicn";

/** 取最后一条 user 消息的纯文本（Qoder 用它填 `originalContent` / 会话名）。 */
function promptTextOf(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown> | undefined;
    if (message?.["role"] !== "user") continue;
    const content = message["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
        .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
        .map((part) => part["text"] as string)
        .join("\n");
    }
  }
  return "";
}

function toolCallIdsOf(message: Record<string, unknown>): string[] {
  const calls = message["tool_calls"];
  if (!Array.isArray(calls)) return [];
  return calls
    .filter((call): call is Record<string, unknown> => typeof call === "object" && call !== null)
    .map((call) => call["id"])
    .filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * 规整对话历史，满足 Qoder 的两条强校验。
 *
 * ## 为什么需要
 *
 * 实测（2026-10-28）真实会话打到 Qoder 报 400：
 *
 * ```
 * Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
 * ```
 *
 * DSH 的历史里会出现两类「断链」，Qoder 一律拒收：
 *
 * 1. **孤立的 `tool` 消息** —— 它引用的 `tool_call_id` 前面没有对应的
 *    assistant `tool_calls`（上下文被裁剪，或重放时只带了结果）。
 * 2. **没人应答的 `tool_calls`** —— assistant 声明了调用，但后面没有对应的
 *    `tool` 消息（中止的回合、或结果被裁掉）。这类同样会被上游拒。
 *
 * ## 策略
 *
 * - `tool` 消息：其 `tool_call_id` 必须被**前面最近的** assistant `tool_calls`
 *   声明过，否则丢弃。
 * - assistant 的 `tool_calls`：只保留**后面确实有**对应 tool 消息的那些；
 *   **整条消息不删**（它的 `content` 可能仍有用），只裁字段。
 * - `user` / `system` 出现时重置「已声明」状态 —— 跨轮的 id 不该被认。
 *
 * 这是**为了让请求能被接受**做的最小裁剪，不改变语义内容。
 */
export function sanitizeMessages(messages: unknown): Record<string, unknown>[] {
  if (!Array.isArray(messages)) return [];
  const list = messages.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );

  // 先算出「后面确实有响应」的 tool_call id，供裁剪 assistant 用
  const answeredIds = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const message = list[i]!;
    if (message["role"] !== "assistant") continue;
    const ids = toolCallIdsOf(message);
    if (ids.length === 0) continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const next = list[j]!;
      if (next["role"] === "user" || next["role"] === "system") break;
      if (next["role"] === "tool" && typeof next["tool_call_id"] === "string") {
        answeredIds.add(next["tool_call_id"]);
      }
    }
  }

  const out: Record<string, unknown>[] = [];
  let declared = new Set<string>();

  for (const message of list) {
    const role = message["role"];

    if (role === "tool") {
      const id = message["tool_call_id"];
      if (typeof id !== "string" || !declared.has(id)) continue; // 孤立 tool 消息 → 丢弃
      out.push(message);
      continue;
    }

    if (role === "assistant") {
      const ids = toolCallIdsOf(message);
      if (ids.length === 0) {
        declared = new Set();
        out.push(message);
        continue;
      }
      const kept = (message["tool_calls"] as unknown[]).filter((call) => {
        const id = (call as Record<string, unknown> | null)?.["id"];
        return typeof id === "string" && answeredIds.has(id);
      });
      const next: Record<string, unknown> = { ...message };
      if (kept.length === 0) delete next["tool_calls"];
      else next["tool_calls"] = kept;
      declared = new Set(kept.map((call) => (call as Record<string, unknown>)["id"] as string));
      out.push(next);
      continue;
    }

    // 其余的 role 一律重置声明状态（跨轮了）。
    //
    // `developer` 必须改写成 `system`：DSH 用的是较新的 OpenAI 角色划分，
    // 而 Qoder 只接受 system/assistant/user/tool/function ——
    // 实测报错 `developer is not one of ['system','assistant','user','tool','function']`。
    // 语义上 developer 就是系统级指令，改写成 system 不会丢信息。
    declared = new Set();
    const normalizedRole =
      role === "developer" ? "system" : role === "function" ? "tool" : role;
    out.push(normalizedRole === role ? message : { ...message, role: normalizedRole });
  }

  return out;
}

/**
 * OpenAI 请求体 → Qoder 请求体。
 * * `model` 来自网关配置而非请求体（pi-ai 发的 `model` 是我们的 id，
 * 与 Qoder 的 model key 一致，但仍然以显式参数为准，避免被客户端改写）。
 */
export function buildQoderChatBody(openaiBody: Record<string, unknown>, modelKey: string): Record<string, unknown> {
  const requestId = randomUUID();
  // 规整历史：剔掉孤立的 tool 消息与没人应答的 tool_calls，否则 Qoder 直接 400
  // （实测报错：Messages with role 'tool' must be a response to a preceding
  //   message with 'tool_calls'）
  const messages = sanitizeMessages(openaiBody["messages"]);
  const promptText = promptTextOf(messages);
  // 思考开关的口径要和宿主的档位对齐：
  //   minimal / off  → 关思考（最低档就该是最省）
  //   其它档位       → 开思考
  // shim 会补一个默认 `reasoning_effort: "minimal"`，所以「没提档位」实际
  // 也会走到这里 —— 用户要的默认最低档就落在这个判断上。
  const effort = openaiBody["reasoning_effort"];
  const isReasoning =
    openaiBody["enable_thinking"] === true ||
    (typeof effort === "string" && effort !== "off" && effort !== "minimal");

  const parameters: Record<string, unknown> = { enable_thinking: isReasoning };
  const maxTokens = openaiBody["max_tokens"] ?? openaiBody["max_completion_tokens"];
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    parameters["max_tokens"] = Math.trunc(maxTokens);
  }
  const temperature = openaiBody["temperature"];
  if (typeof temperature === "number" && Number.isFinite(temperature)) parameters["temperature"] = temperature;
  if (isReasoning) parameters["reasoning_effort"] = "high";

  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: SESSION_TYPE,
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    // 顶层 system 服务端会忽略；系统提示走 messages 里的 {role:"system"}。
    system: "",
    messages,
    tools: Array.isArray(openaiBody["tools"]) ? openaiBody["tools"] : [],
    ...(openaiBody["tool_choice"] === undefined ? {} : { tool_choice: openaiBody["tool_choice"] }),
    parameters,
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning },
        originalContent: promptText,
      },
      features: [],
      text: promptText,
    },
    model_config: { key: modelKey, source: "system" },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: requestId,
      name: promptText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
}

/** Qoder 的控制哨兵。 */
function isControlSentinel(text: string): boolean {
  return (
    text === "[DONE]" ||
    text === "[NOT_EXCEED_QUOTA]" ||
    text.startsWith("[EXCEED_QUOTA]") ||
    text.startsWith("[NOTIFICATIONS]")
  );
}

/**
 * 解开一层 Qoder 信封。
 *
 * 返回 `{kind:"chunk"}` / `{kind:"done"}` / `{kind:"error"}` / `{kind:"ignore"}`。
 * 对外导出便于单测 —— 这一层是全链路最容易出错的地方。
 */
export function unwrapQoderEvent(
  raw: string,
): { kind: "chunk"; chunk: Record<string, unknown> } | { kind: "done" } | { kind: "error"; message: string } | { kind: "ignore" } {
  const text = raw.trim();
  if (text === "") return { kind: "ignore" };
  if (text === "[DONE]") return { kind: "done" };
  if (text === "[NOT_EXCEED_QUOTA]") return { kind: "ignore" };
  if (text.startsWith("[EXCEED_QUOTA]")) return { kind: "error", message: "Qoder 额度已用尽（EXCEED_QUOTA）" };
  if (text.startsWith("[NOTIFICATIONS]")) return { kind: "ignore" };

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { kind: "ignore" };
  }
  if (typeof envelope !== "object" || envelope === null) return { kind: "ignore" };
  const record = envelope as Record<string, unknown>;

  // 带信封的形状
  if (record["statusCodeValue"] !== undefined && record["body"] !== undefined) {
    const code = record["statusCodeValue"];
    if (typeof code === "number" && code !== 200) {
      const detail = typeof record["body"] === "string" ? record["body"] : JSON.stringify(record["body"]);
      return { kind: "error", message: `Qoder 上游 ${code}：${detail.slice(0, 400)}` };
    }
    const body = record["body"];
    if (typeof body !== "string") {
      return typeof body === "object" && body !== null ? { kind: "chunk", chunk: body as Record<string, unknown> } : { kind: "ignore" };
    }
    const inner = body.trim();
    if (inner === "") return { kind: "ignore" };
    if (inner === "[DONE]") return { kind: "done" };
    if (isControlSentinel(inner)) return { kind: "ignore" };
    try {
      const parsed = JSON.parse(inner) as Record<string, unknown>;
      return { kind: "chunk", chunk: parsed };
    } catch {
      return { kind: "ignore" };
    }
  }

  // 裸 OpenAI chunk（防御性）
  if (Array.isArray(record["choices"])) return { kind: "chunk", chunk: record };
  return { kind: "ignore" };
}

/**
 * 把一行上游 SSE 翻成一行标准 OpenAI SSE。
 *
 * - `null` = 丢弃（空行、注释、控制哨兵、无法解析的行）
 * - `"data: [DONE]"` = 结束
 * - `"data: {...}"` = 正常 chunk
 *
 * Qoder 的 `event:` 行与空行都丢弃 —— 我们只输出 `data:` 行，
 * 由 shim 负责补分隔空行。
 */
export function decodeQoderLine(line: string): string | null {
  const trimmed = line.replace(/\r$/, "");
  if (trimmed === "") return null;
  if (trimmed.startsWith("event:") || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;

  const payload = trimmed.slice(5).replace(/^ /, "");
  const unwrapped = unwrapQoderEvent(payload);

  if (unwrapped.kind === "done") return "data: [DONE]";
  if (unwrapped.kind === "error") {
    // 业务错误也翻成 OpenAI 的 error chunk —— 让上层把它当一次失败，
    // 而不是把上游的哨兵字符串当正文吐给用户。
    return `data: ${JSON.stringify({ error: { message: unwrapped.message, type: "qoder_error" } })}`;
  }
  if (unwrapped.kind === "ignore") return null;
  return `data: ${JSON.stringify(unwrapped.chunk)}`;
}

/**
 * 造出 shim 用的方言对象。
 *
 * `request` 负责：拼 Qoder 请求体 → 编码 → COSY 重签名（签名覆盖编码后的字节）。
 *
 * `sessionFor` 按本次选中的账号取会话（shim 的 `input.account` 贯通进来）；
 * `account` 为 undefined 时（调用方还没带账号）由调用方自行落到缺省账号。
 */
export function createQoderDialect(options: {
  sessionFor: (account: { id: string } | undefined) => Promise<QoderSession | undefined>;
  gatewayBase?: string;
}): ShimDialect {
  const gateway = (options.gatewayBase ?? DEFAULT_GATEWAY).replace(/\/+$/, "");

  return {
    async request(input) {
      const session = await options.sessionFor(input.account);
      if (session === undefined) throw new Error("Qoder 凭据不可用（PAT 缺失或交换失败）");

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(input.raw) as Record<string, unknown>;
      } catch {
        /* 不是 JSON 就按空对象处理，反正下面会重建 */
      }

      const body = buildQoderChatBody(parsed, input.model);
      const encoded = qoderEncodeBody(JSON.stringify(body));
      const url = `${gateway}${CHAT_PATH}`;
      const headers = buildCosyHeaders(encoded, url, {
        userID: session.userID,
        authToken: session.jobToken,
        name: session.name,
        email: session.email,
      });

      return {
        url,
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          accept: "text/event-stream",
        },
        body: encoded,
      };
    },
    decodeLine: decodeQoderLine,
  };
}
