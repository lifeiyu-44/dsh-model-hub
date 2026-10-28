/**
 * 上游网关的请求体整形。
 *
 * ## 为什么插件必须自己干这件事
 *
 * 踩过两个**独立的**坑，都是上游拒收 DSH 原样发出的请求体：
 *
 * 1. **首条不是 system** —— 国际网关（`www.workbuddy.ai`）返回
 *    `400 / code 11128 / "first message is not system prompt"`（实测 2026-10-28）。
 *    DSH 的 `PiAiAdapter` 在本轮没有系统提示时，`messages[0]` 会是 `user`。
 *
 * 2. **`role: "developer"`** —— DSH 用较新的 OpenAI 角色划分，会把全局指令
 *    放进 `developer` 消息。WorkBuddy 与 Qoder 都**只认**
 *    `system/assistant/user/tool/function`：
 *    - WorkBuddy: `400 / 11128 / Illegal API invocation from an unapproved channel`
 *    - Qoder:     `400 / developer is not one of [...]`
 *    表面上是两个错，根因是同一个。
 *
 * 所以归一是**通用**的：放在 shim 这一层，所有渠道一起受益。
 * 参考实现在自己的 adapter 层做同样的事；我们在 shim 做，因为这是最后一个
 * 能看到并改写请求体的地方，而且它已经承担了「补会话身份三件套」的同类职责。
 */

/**
 * 兜底系统提示词。
 *
 * 取最中性的一句，不扮演人格 —— 编一个更长的会悄悄改变每个受影响请求的
 * 模型行为，而用户并没有要求。
 */
export const FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";

/**
 * 角色映射：DSH/新版 OpenAI → 上游普遍接受的四五种。
 *
 * - `developer` → `system`（语义就是系统级指令，不丢信息）
 * - `function`  → `tool`（旧 OpenAI 形状）
 */
const ROLE_MAP: Record<string, string> = {
  developer: "system",
  function: "tool",
};

/**
 * 确保请求体符合上游的最小要求：角色归一 + `messages` 以 system 开头。
 *
 * 三条约束，都来自实测：
 * 1. **幂等** —— 已经合规就返回**原字符串**（同一个引用），
 *    免得把上游本来接受的请求也改一遍。
 * 2. **不猜语义** —— 只做角色改名与补一句中性占位，不改用户内容。
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

  let changed = false;

  // ① 角色归一
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const item = message as Record<string, unknown>;
    const role = item["role"];
    if (typeof role !== "string") continue;
    const mapped = ROLE_MAP[role.trim().toLowerCase()];
    if (mapped !== undefined) {
      item["role"] = mapped;
      changed = true;
    }
  }

  // ② 首条必须是 system（归一之后再判断，`developer` 此时已变成 system）
  const head = messages[0];
  let headIsSystem = false;
  if (typeof head === "object" && head !== null) {
    const role = (head as Record<string, unknown>)["role"];
    // 大小写不敏感：上游自己的判断也是 `role.trim().toLowerCase() === "system"`。
    headIsSystem = typeof role === "string" && role.trim().toLowerCase() === "system";
  }
  if (!headIsSystem) {
    messages.unshift({ role: "system", content: FALLBACK_SYSTEM_PROMPT });
    changed = true;
  }

  return changed ? JSON.stringify(record) : raw;
}

/**
 * 宿主没指定思考档位时，插件补一个默认档。
 *
 * ## 为什么在插件侧补
 *
 * 宿主的选择器显示 `Default` 表示「跟随模型默认」，而 pi-ai 的模型元数据里
 * **没有**「默认档位」这个字段（只有 `thinkingLevelMap`，那只是把档位名映射成
 * 上游 effort）。所以想让 hub 模型默认走最低档，只能落到请求体上。
 *
 * ## 只补不改
 *
 * 请求体里已经有 `reasoning_effort` / `enable_thinking` 时**原样放过** ——
 * 用户在界面上显式选过的档位优先。只有完全没提的时候才补。
 *
 * `minimal` 对应 pi-ai 的 1024 token 思考预算，是官方档位里最低的一档；
 * 想把默认调高就改这个常量（`medium` = 8192、`high` = 16384）。
 */
export const DEFAULT_REASONING_EFFORT = "minimal";

export function applyDefaultReasoning(raw: string, level: string = DEFAULT_REASONING_EFFORT): string {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return raw;

  const record = doc as Record<string, unknown>;
  // 显式选过就不动（包括显式关掉思考）
  if (record["reasoning_effort"] !== undefined) return raw;
  if (record["enable_thinking"] !== undefined) return raw;

  record["reasoning_effort"] = level;
  return JSON.stringify(record);
}