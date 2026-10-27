import type { NormalizedUsage } from "./recorder.js";

/** 从一条 SSE `data:` 行里取出 token 增量与 usage。 */
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

  const text = extractText(doc);
  const usage = extractUsage(doc);
  return {
    ...(text === undefined ? {} : { text }),
    ...(usage === undefined ? {} : { usage }),
    done: false,
  };
}

/** OpenAI chat.completions 与 Anthropic messages 两种 delta 形状都认。 */
function extractText(doc: Record<string, unknown>): string | undefined {
  const choices = doc["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const delta = first["delta"] as Record<string, unknown> | undefined;
    if (delta !== undefined && typeof delta["content"] === "string") return delta["content"];
  }
  const delta = doc["delta"] as Record<string, unknown> | undefined;
  if (delta !== undefined && typeof delta["text"] === "string") return delta["text"];
  const content = doc["content"];
  if (Array.isArray(content)) {
    const part = content.find((p) => (p as Record<string, unknown>)["type"] === "text_delta");
    if (part !== undefined) {
      const text = (part as Record<string, unknown>)["text"];
      if (typeof text === "string") return text;
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
