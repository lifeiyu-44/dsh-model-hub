import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChannelModel } from "../types.js";
import { traeUserDataRoots, type TraeCredential } from "./credentials.js";

/**
 * Trae 的模型目录。
 *
 * ## 目录从哪来
 *
 * 上游**没有**「列模型」的 HTTP 接口（`/api/ide/v1/**` 在国际版直接 404），
 * 模型清单是客户端从服务端配置拉下来后缓存在本地的：`state.vscdb` 里的
 * `AI.agent.model.model_list_map`，按 **function** 分组（`solo_agent_lite` /
 * `solo_coder` / …）。每条带 `config_name`（发请求时用的模型标识）、
 * `display_name`、上下文窗口、`max_tokens`、是否多模态。
 *
 * 所以这里读**本机 Trae 的缓存**，而不是自己去猜模型名。读不到时退回一份
 * 已实测可用的小名单 —— 目录是建议性的，真发请求时上游认不认还是它说了算。
 *
 * ## 为什么按 function 分组很关键
 *
 * 请求体里的 `function` 决定服务端用哪套 function 注册表，`config_name`
 * 必须落在**该 function 的**名单里。实测（2026-11-05）：
 *
 * ```
 * solo_agent_lite + config_name=kimi-k3   → 200，provider_model_name=aws-kimi-k3
 * solo_work_lite  + config_name=deepseek… → 4023 model is unknown
 * ```
 *
 * 也就是说「模型能选」与「function 选对」是两件事。默认统一用
 * {@link TRAE_DEFAULT_FUNCTION}（`solo_agent_lite`，实测覆盖全部 15 个预置
 * 模型），需要别的 agent 时用 `config_name@solo_coder` 这种 id 显式指定。
 */

/** 默认 function：SOLO 的通用 agent，实测接受全部预置模型。 */
export const TRAE_DEFAULT_FUNCTION = "solo_agent_lite";

/**
 * 服务端为该 appId 注册过的 function 名（实测 86 个候选里只有这些通过）。
 *
 * 前 7 个对应 Trae 的 agent 分组，后 2 个是工具型 function。
 * 只有这里的名字才能出现在模型 id 的 `@` 后缀里 —— 写错会得到
 * `no function config found for appId=…`。
 */
export const TRAE_FUNCTIONS = [
  "solo_work_lite",
  "solo_agent_lite",
  "solo_coder",
  "solo_work_remote",
  "solo_agent_remote",
  "solo_design_lite",
  "solo_design_remote",
  "multimodal",
  "refactor",
] as const;

/**
 * 读不到本地目录时的兜底名单。
 *
 * 只放**实测 200** 的预置模型（2026-11-05，`config_name` + `solo_agent_lite`）；
 * 名称与上下文取自同机的 `model_list_map`。上下文窗口宁小勿大：
 * 报大了上游会拒，报小了只是少用一点。
 */
export const TRAE_FALLBACK_MODELS: ChannelModel[] = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", contextWindow: 272_000, maxTokens: 64_000, supportsImages: true, reasoning: true },
  { id: "gpt-6.1-terra", name: "GPT-6.1-Terra", contextWindow: 272_000, maxTokens: 64_000, supportsImages: true, reasoning: true },
  { id: "gpt-6-astra", name: "GPT-6-Astra", contextWindow: 272_000, maxTokens: 64_000, supportsImages: true, reasoning: true },
  { id: "gpt-6-sol", name: "GPT-6-Sol", contextWindow: 272_000, maxTokens: 64_000, supportsImages: true, reasoning: true },
  { id: "gpt-6-luna", name: "GPT-6-Luna", contextWindow: 272_000, maxTokens: 64_000, supportsImages: true, reasoning: true },
  { id: "gemini-3.1-pro", name: "Gemini-3.1-Pro-Preview", contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: true },
  { id: "gemini-3-flash-solo", name: "Gemini-3-Flash-Preview", contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: true },
  { id: "minimax-m3", name: "MiniMax-M3", contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: true },
  { id: "minimax-m2.7", name: "MiniMax-M2.7", contextWindow: 200_000, maxTokens: 32_000, supportsImages: false, reasoning: true },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 200_000, maxTokens: 64_000, supportsImages: false, reasoning: true },
  { id: "deepseek-v4-pro-0813", name: "DeepSeek-V4-Pro", contextWindow: 200_000, maxTokens: 64_000, supportsImages: false, reasoning: true },
  { id: "kimi-k3", name: "Kimi-K3", contextWindow: 200_000, maxTokens: 64_000, supportsImages: true, reasoning: true },
  { id: "kimi-k2.5", name: "Kimi-K2.5", contextWindow: 200_000, maxTokens: 32_000, supportsImages: false, reasoning: true },
  { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272_000, maxTokens: 32_000, supportsImages: true, reasoning: true },
  { id: "gpt-5.2", name: "GPT-5.2", contextWindow: 272_000, maxTokens: 32_000, supportsImages: true, reasoning: true },
  { id: "claude-sonnet-4.5", name: "Claude-Sonnet-4.5", contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: true },
];

/** 模型目录读取结果。 */
export interface TraeCatalogResult {
  models: ChannelModel[];
  /** `client` = 读的本机 Trae 缓存；`fallback` = 内置名单。 */
  source: "client" | "fallback";
  /** 本次用的 function（模型来自它的分组）。 */
  functionName: string;
  /** 读本地缓存失败的原因（成功时不带）。 */
  error?: string;
}

/** 找本机 Trae 的 `state.vscdb`；多个产品线时取第一个存在的。 */
export function findTraeStateDb(): string | undefined {
  for (const root of traeUserDataRoots()) {
    const path = join(root, "User", "globalStorage", "state.vscdb");
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** 从 ItemTable 里读 model_list_map（key 前缀是机器/用户 id，所以用 LIKE）。 */
export function readModelListMap(stateDbPath: string): Record<string, unknown[]> | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key LIKE '%AI.agent.model.model_list_map' LIMIT 1")
      .get() as { value?: unknown } | undefined;
    if (row?.value === undefined) return undefined;
    const raw =
      typeof row.value === "string"
        ? row.value
        : row.value instanceof Uint8Array
          ? Buffer.from(row.value).toString("utf8")
          : String(row.value);
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const map: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) map[key] = value;
    }
    return map;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* 只读库关不掉不影响结果 */
    }
  }
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** 上下文窗口：优先 `context_window_tokens.dev`，退回 `context_window_size.default` 或 `max[0]`。 */
function contextWindowOf(entry: Record<string, unknown>): number {
  const tokens = recordOf(entry["context_window_tokens"]);
  const size = recordOf(entry["context_window_size"]);
  const maxList = Array.isArray(size["max"]) ? size["max"] : [];
  return (
    positiveNumber(tokens["dev"]) ??
    positiveNumber(tokens["max"]) ??
    positiveNumber(size["default"]) ??
    positiveNumber(maxList[0]) ??
    128_000
  );
}

/**
 * 一个 function 分组的原始条目 → 渠道模型。
 *
 * 过滤规则：
 * - `config_name` 缺失/空 → 跳过（没有它就发不出请求）；
 * - `custom_*` / 带 `//` 的自定义模型 → 跳过：那是用户自配的
 *   openai-compatible 端点，上游对我们的 appId 一律回 4001（实测）。
 * - 同 id 只保留第一次出现的（跨分组重复时先到先得）。
 */
export function modelsFromListMap(
  map: Record<string, unknown[]>,
  functionName: string = TRAE_DEFAULT_FUNCTION,
): ChannelModel[] {
  const list = Array.isArray(map[functionName]) ? map[functionName]! : [];
  const out: ChannelModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = recordOf(item);
    const id = typeof entry["config_name"] === "string" ? entry["config_name"].trim() : "";
    if (id === "" || seen.has(id)) continue;
    if (id.startsWith("custom_") || id.includes("//")) continue;
    seen.add(id);
    // 思考档位：目录里 `model_type=reasoning_model` 或 `features.reasoning.enable`
    // 的模型都能吃 `reasoning_effort`（实测该字段在 `solo_agent_lite` 下对
    // low/medium/high/minimal/off/none 全部返回 200，不支持的模型上游自己忽略）。
    // 这与 WorkBuddy 渠道同一口径：**上游接受就如实声明**，否则 DSH 的
    // 模型选择器不显示「思考强度」，滑动变阻器也不出滑块。
    const reasoning =
      entry["model_type"] === "reasoning_model" ||
      recordOf(recordOf(entry["features"])["reasoning"])["enable"] === true;
    out.push({
      id,
      name: typeof entry["display_name"] === "string" && entry["display_name"] !== "" ? entry["display_name"] : id,
      contextWindow: contextWindowOf(entry),
      maxTokens: positiveNumber(entry["max_tokens"]) ?? 32_000,
      supportsImages: entry["multimodal"] === true,
      reasoning,
    });
  }
  return out;
}

/** 模型 id 里可以写 `@<function>` 覆盖默认 function，例如 `gpt-5.4@solo_coder`。 */
export function decodeTraeModelId(
  raw: string,
  fallbackFunction: string = TRAE_DEFAULT_FUNCTION,
): { model: string; functionName: string } {
  const id = typeof raw === "string" ? raw : "";
  const at = id.lastIndexOf("@");
  if (at > 0) {
    const fn = id.slice(at + 1);
    if ((TRAE_FUNCTIONS as readonly string[]).includes(fn)) {
      return { model: id.slice(0, at), functionName: fn };
    }
  }
  return { model: id, functionName: fallbackFunction };
}

/**
 * 拉一次目录：读本机缓存 → 失败/为空退回内置名单。**不抛错**。
 *
 * 目录不是鉴权接口，拉不到不代表凭据坏了 —— 让 runtime 因为「读不到
 * 目录」而起不来，等于把「Trae 客户端没装在这个用户下」误报成「凭据失效」。
 */
export function fetchTraeCatalog(credential: TraeCredential): TraeCatalogResult {
  void credential;
  const stateDbPath = findTraeStateDb();
  if (stateDbPath !== undefined) {
    const map = readModelListMap(stateDbPath);
    if (map !== undefined) {
      const preferred = modelsFromListMap(map, TRAE_DEFAULT_FUNCTION);
      if (preferred.length > 0) {
        return { models: preferred, source: "client", functionName: TRAE_DEFAULT_FUNCTION };
      }
      // 默认分组为空（换版本/换产品线）：退到条目最多的分组，别让目录整个空着。
      let bestKey = "";
      let bestCount = 0;
      for (const [key, list] of Object.entries(map)) {
        const models = modelsFromListMap(map, key);
        if (models.length > bestCount) {
          bestCount = models.length;
          bestKey = key;
        }
      }
      if (bestKey !== "") {
        return { models: modelsFromListMap(map, bestKey), source: "client", functionName: bestKey };
      }
    }
  }
  return {
    models: TRAE_FALLBACK_MODELS,
    source: "fallback",
    functionName: TRAE_DEFAULT_FUNCTION,
    ...(stateDbPath === undefined ? { error: "没找到本机 Trae 的 state.vscdb，使用内置模型名单" } : {}),
  };
}
