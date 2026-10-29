import type { NormalizedUsage } from "./recorder.js";

/**
 * 从一条 SSE `data:` 行里取出 token 增量与 usage。
 *
 * `text` 是**模型产出的任意 token 增量**，包含正文与思考（reasoning）。
 * 这一点很关键，见 {@link extractTokenDelta}。
 */
export function parseSseLine(line: string): { text?: string; usage?: NormalizedUsage; done: boolean } {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith(":")) return { done: false };
  if (!trimmed.startsWith("data:")) return { done: false };
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return { done: true };

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { done: false };
  }

  const text = extractTokenDelta(doc);
  const usage = extractUsage(doc);
  return {
    ...(text === undefined ? {} : { text }),
    ...(usage === undefined ? {} : { usage }),
    done: false,
  };
}

/**
 * 取出一个 chunk 里的 **token 增量**：正文、思考、或工具调用参数。
 *
 * ## 为什么必须包含 reasoning（2026-10-29 真机事故）
 *
 * 之前这里只取 `delta.content`（正文），思考模型（deepseek-v4.1-flash 等）
 * 的 `delta.reasoning_content` 完全被忽略。后果是计时口径和 token 数对不上：
 *
 *   上游先花 24 秒吐 reasoning（不被计入"首 token"），
 *   再花 0.8 秒吐正文（被当成 3664 个 token 的全部耗时），
 *   于是 tok/s = 3664 / 0.8s = 4378 —— 面板上出现物理不可能的速度。
 *
 * 宿主的判定是权威口径（`dsh-llm` 的 `isTokenDelta`）：
 *
 *     case "text-delta":
 *     case "reasoning-delta": return chunk.text !== "";
 *
 * 也就是**思考的第一个 token 就是首 token**。这里照抄，两边才对得上。
 *
 * 取到的增量只用于**计时与字符估算**，不参与内容改写 —— 透传给客户端的
 * 字节始终是上游原文，reasoning 该不该显示由宿主自己决定。
 */
function extractTokenDelta(doc: Record<string, unknown>): string | undefined {
  const choices = doc["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const delta = first["delta"] as Record<string, unknown> | undefined;
    if (delta !== undefined) {
      // 正文优先；没有正文时退回思考内容。两者都是模型真的在出 token。
      if (typeof delta["content"] === "string" && delta["content"] !== "") return delta["content"];
      if (typeof delta["reasoning_content"] === "string" && delta["reasoning_content"] !== "") {
        return delta["reasoning_content"];
      }
      // 工具调用：名字或参数片段同样是"模型开始产出"。
      // 名字优先：它先于参数到达，作为首 token 更准确。
      if (typeof delta["tool_calls"] === "object" && delta["tool_calls"] !== null) {
        const calls = delta["tool_calls"];
        if (Array.isArray(calls) && calls.length > 0) {
          const call = calls[0] as Record<string, unknown>;
          const args = call["function"] as Record<string, unknown> | undefined;
          if (typeof call["name"] === "string" && call["name"] !== "") return call["name"];
          if (typeof args?.["name"] === "string" && args["name"] !== "") return args["name"];
          const fragment = args?.["arguments"];
          if (typeof fragment === "string" && fragment !== "") return fragment;
        }
      }
    }
  }
  // Anthropic 风格：顶层 delta.text / delta.thinking
  const delta = doc["delta"] as Record<string, unknown> | undefined;
  if (delta !== undefined) {
    if (typeof delta["text"] === "string" && delta["text"] !== "") return delta["text"];
    if (typeof delta["thinking"] === "string" && delta["thinking"] !== "") return delta["thinking"];
  }
  // Anthropic content_block_delta：text_delta / thinking_delta
  const content = doc["content"];
  if (Array.isArray(content)) {
    for (const part of content) {
      const rec = part as Record<string, unknown>;
      const type = rec["type"];
      if (type !== "text_delta" && type !== "thinking_delta") continue;
      const text = rec["text"] ?? rec["thinking"];
      if (typeof text === "string" && text !== "") return text;
    }
  }
  return undefined;
}

/** 两种协议字段名不同，统一归一。 */
export function extractUsage(doc: Record<string, unknown>): NormalizedUsage | undefined {
  const usage = doc["usage"];
  // 上游会在流式 chunk 里发 `"usage": null`（实测 workbuddy 网关就这样），
  // 不是「没有 usage 字段」而是「显式 null」—— typeof null === 'object'，
  // 所以必须单独判空，否则下面读字段会直接抛 TypeError 打断整条流。
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
  const rec = usage as Record<string, unknown>;
  const input = rec["prompt_tokens"] ?? rec["input_tokens"];
  const output = rec["completion_tokens"] ?? rec["output_tokens"];
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const cacheRead = rec["cache_read_input_tokens"];
  const cacheWrite = rec["cache_creation_input_tokens"];
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
    cacheRead: typeof cacheRead === "number" ? cacheRead : 0,
    cacheWrite: typeof cacheWrite === "number" ? cacheWrite : 0,
  };
}
