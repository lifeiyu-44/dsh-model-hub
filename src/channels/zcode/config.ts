import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ZCode 渠道：从它的 provider 配置里读出可用 provider 与模型。
 *
 * ## 数据来源
 *
 * `~/.zcode/v2/provider_config.json` 的
 * `config.providerConfigRules.providerRules` 数组（实测 2026-10-28，5 个 provider）：
 *
 * ```json
 * { "providerId": "904c0249-…", "providerName": "glemon", "enabled": true,
 *   "config": {
 *     "access": { "type": "api-key", "apiKey": "sk-…" },
 *     "api":    { "type": "anthropic-messages", "baseUrl": "http://…/v1" },
 *     "modelOrder": ["glm-5.3", …] } }
 * ```
 *
 * ## 三个必须处理的脏数据
 *
 * 1. **`api.type` / `baseUrl` 可能缺失** —— DeepSeek 那条只给了 apiKey，
 *    baseUrl 由它的 template 兜底。这里对 `templateId: "deepseek"` 补上官方地址。
 * 2. **`access` 可能为空** —— `account:bigmodel-…` 走的是账号授权而不是 api-key，
 *    没有可用的 key，**跳过**（不假装能接）。
 * 3. **模型列表在 `modelOrder`**，不是 `models`；`personalModelIds` 是用户额外挑的，
 *    两者都要收（`modelOrder` 在前，保持它的排序）。
 */

/** 一个可以直接注册成 provider 路由的 ZCode 后端。 */
export interface ZcodeProvider {
  /** 稳定的路由后缀，由 providerId 或名字派生。 */
  slug: string;
  /** 显示名。 */
  name: string;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
  apiKey: string;
  models: { id: string; name: string }[];
}

export interface ZcodeReadResult {
  providers: ZcodeProvider[];
  /** 被跳过的 provider 及原因（诊断栏要照实显示，不能静默丢）。 */
  skipped: { name: string; reason: string }[];
  /** 配置文件路径，找不到时为 undefined。 */
  source?: string;
}

/** ZCode 配置文件的默认位置。 */
export function zcodeConfigPath(): string {
  return join(homedir(), ".zcode", "v2", "provider_config.json");
}

/**
 * 已知 template 的兜底地址。
 *
 * 只收录**能确定**的：DeepSeek 官方 OpenAI 兼容端点是公开信息。
 * 其它 template 缺 baseUrl 时一律跳过，不猜。
 */
const TEMPLATE_DEFAULTS: Record<string, { baseUrl: string; api: ZcodeProvider["api"] }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions" },
};

/** 把任意名字变成稳定的路由片段。 */
function slugOf(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/^account:/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "provider" : cleaned;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 收模型 id：`modelOrder` 优先，再补 `personalModelIds` 里没出现过的。 */
function collectModelIds(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of ["modelOrder", "personalModelIds"]) {
    const list = config[key];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string" || raw === "" || seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/**
 * 读 ZCode 配置，返回可注册的 provider。
 *
 * 不抛错：文件缺失、JSON 坏了、字段缺失都只体现在 `skipped` 里。
 * 插件不能因为另一个应用没装就崩。
 */
export function readZcodeProviders(path = zcodeConfigPath()): ZcodeReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { providers: [], skipped: [], source: undefined };
  }

  let doc: Record<string, unknown> | undefined;
  try {
    doc = asRecord(JSON.parse(raw));
  } catch {
    return { providers: [], skipped: [{ name: "(整个配置)", reason: "JSON 解析失败" }], source: path };
  }

  const config = asRecord(doc?.["config"]);
  const rules = config?.["providerConfigRules"];
  const providerRules = asRecord(rules)?.["providerRules"];
  if (!Array.isArray(providerRules)) {
    return { providers: [], skipped: [{ name: "(整个配置)", reason: "缺少 providerConfigRules.providerRules" }], source: path };
  }

  const providers: ZcodeProvider[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const usedSlugs = new Set<string>();

  for (const rawRule of providerRules) {
    const rule = asRecord(rawRule);
    if (rule === undefined) continue;

    const name =
      asString(rule["providerName"]) ?? asString(rule["providerId"]) ?? "(未命名 provider)";
    // `enabled` 缺失按「启用」处理 —— 实测 DeepSeek / 阿里云 / Strata 都没写这个字段，
    // 但它们显然是可用的。
    if (rule["enabled"] === false) {
      skipped.push({ name, reason: "在 ZCode 里被禁用" });
      continue;
    }

    const config = asRecord(rule["config"]) ?? {};
    const access = asRecord(config["access"]);
    const api = asRecord(config["api"]);
    const templateId = asString(rule["templateId"]);

    const apiKey = asString(access?.["apiKey"]);
    if (apiKey === undefined) {
      skipped.push({ name, reason: "没有 api-key（走账号授权，本插件不支持）" });
      continue;
    }

    const fallback = templateId === undefined ? undefined : TEMPLATE_DEFAULTS[templateId];
    const baseUrl = asString(api?.["baseUrl"]) ?? fallback?.baseUrl;
    if (baseUrl === undefined) {
      skipped.push({ name, reason: "缺少 baseUrl 且没有已知的 template 兜底" });
      continue;
    }

    const declaredApi = asString(api?.["type"]);
    const resolvedApi: ZcodeProvider["api"] =
      declaredApi === "anthropic-messages" || declaredApi === "openai-completions"
        ? declaredApi
        : (fallback?.api ?? "openai-completions");

    const modelIds = collectModelIds(config);
    if (modelIds.length === 0) {
      skipped.push({ name, reason: "没有模型列表" });
      continue;
    }

    // slug 必须唯一，否则注册路由会撞车。
    //
    // 名字可能是纯中文（`阿里云百炼（中国）`），slugOf 会把它清成空串。
    // 这时退回 providerId（`qwen-alibaba-model-studio-cn`）—— 它是 ASCII，
    // 而且比 `provider` 这种兜底词有意义得多。
    const providerId = asString(rule["providerId"]);
    const baseSlug = slugOf(name) === "provider" && providerId !== undefined ? slugOf(providerId) : slugOf(name);
    let slug = baseSlug;
    let suffix = 2;
    while (usedSlugs.has(slug)) slug = `${baseSlug}-${suffix++}`;
    usedSlugs.add(slug);

    providers.push({
      slug,
      name,
      api: resolvedApi,
      baseUrl,
      apiKey,
      models: modelIds.map((id) => ({ id, name: id })),
    });
  }

  return { providers, skipped, source: path };
}
