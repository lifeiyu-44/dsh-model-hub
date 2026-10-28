/**
 * 上游 WorkBuddy 网关的请求体整形。
 *
 * ## 为什么插件必须自己干这件事
 *
 * 国际网关（`www.workbuddy.ai`）对**首条消息不是 system** 的请求直接返回
 * `400 / code 11128 / "first message is not system prompt"`（实测 2026-10-28）。
 * 而 DSH 的 `PiAiAdapter` 在模型不带 `reasoning` 元数据、且本轮没有系统提示时，
 * 发出去的 `messages[0]` 就是 `user` —— 于是每个请求都被拒。
 *
 * 国内网关（`copilot.tencent.com`）容忍这种请求，所以这个坑只在 global 出现。
 *
 * 参考实现 `dsh-connect-workbuddy` 在它的 adapter 层做同样的事
 * （`ensureSystemHead`，见其 `lib/host-heartbeat-*.js`）。我们不在 adapter 层，
 * 而是在 **shim** 这一层做 —— 因为 shim 是最后一个能看到并改写请求体的地方，
 * 而且它已经承担了「给上游补会话身份三件套」的同类职责，放一起更好维护。
 */

/**
 * 兜底系统提示词。
 *
 * 取最中性的一句，不扮演人格 —— 编一个更长的会悄悄改变每个受影响请求的
 * 模型行为，而用户并没有要求。
 */
export const FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";

/**
 * 确保请求体的 `messages` 以 system 开头。
 *
 * 三条约束，都来自实测：
 * 1. **幂等** —— 首条已经是 system 就原样返回（同一个对象引用），
 *    免得把上游本来接受的请求也改一遍。
 * 2. **不猜语义** —— 只补一句中性占位，不改用户的任何内容。
 * 3. **不认识的形状不动** —— 不是 JSON 对象、`messages` 不是数组时原样返回，
 *    让上游自己报错，而不是我们把它改坏。
 *
 * @param raw 原始请求体字符串
 * @returns 需要改写时返回新字符串；不需要时返回**原字符串**
 */
export function ensureSystemHead(raw: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return raw;

  const record = doc as Record<string, unknown>;
  const messages = record["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return raw;

  const head = messages[0];
  if (typeof head === "object" && head !== null) {
    const role = (head as Record<string, unknown>)["role"];
    // 大小写不敏感：上游自己的判断也是 `role.trim().toLowerCase() === "system"`。
    if (typeof role === "string" && role.trim().toLowerCase() === "system") return raw;
  }

  messages.unshift({ role: "system", content: FALLBACK_SYSTEM_PROMPT });
  return JSON.stringify(record);
}
