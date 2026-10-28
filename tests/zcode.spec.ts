import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inferApi, normalizeBaseUrl, readZcodeProviders } from "../src/channels/zcode/config.js";

/**
 * ZCode 配置解析的测试。
 *
 * 用真实形状的夹具（实测 2026-10-28 的 `provider_config.json`）。
 *
 * 这块的坑全在「字段可能缺失」与「地址该不该带 /v1」上：
 * - DeepSeek 没有 api.type / baseUrl（靠 template 兜底）
 * - 阿里云百炼的 baseUrl 已经带 `/apps/anthropic`
 * - 自建 provider 没有 templateId（用户要求不接）
 * - 模型列表在 modelOrder，不是 models
 */

function writeConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-"));
  const file = join(dir, "provider_config.json");
  writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

function rules(list: unknown[]): string {
  return writeConfig({ config: { providerConfigRules: { providerRules: list } } });
}

describe("normalizeBaseUrl —— 对齐 pi-ai 的 SDK 语义", () => {
  it("anthropic：去掉尾部 /v1（SDK 自己加 /v1/messages）", () => {
    expect(normalizeBaseUrl("http://ai.internal.jiayouexp.com/v1", "anthropic-messages")).toBe(
      "http://ai.internal.jiayouexp.com",
    );
    expect(normalizeBaseUrl("https://x.test/v1/", "anthropic-messages")).toBe("https://x.test");
  });

  it("anthropic：不带 /v1 的地址原样保留", () => {
    expect(normalizeBaseUrl("https://token-plan.maas.qianwenaiapi.com/apps/anthropic", "anthropic-messages")).toBe(
      "https://token-plan.maas.qianwenaiapi.com/apps/anthropic",
    );
  });

  it("openai：缺版本段时补 /v1", () => {
    expect(normalizeBaseUrl("https://api.deepseek.com", "openai-completions")).toBe("https://api.deepseek.com/v1");
  });

  it("openai：已有版本段就不动", () => {
    expect(normalizeBaseUrl("https://api.deepseek.com/v1", "openai-completions")).toBe("https://api.deepseek.com/v1");
    expect(normalizeBaseUrl("https://x.test/v2/", "openai-completions")).toBe("https://x.test/v2");
  });
});

describe("inferApi —— 缺 api.type 时靠地址推断", () => {
  it("显式声明的优先", () => {
    expect(inferApi("anthropic-messages", "https://x.test/v1")).toBe("anthropic-messages");
    expect(inferApi("openai-completions", "https://x.test/anthropic")).toBe("openai-completions");
  });

  it("地址里带 anthropic 的按 anthropic 处理", () => {
    expect(inferApi(undefined, "https://token-plan.maas.qianwenaiapi.com/apps/anthropic")).toBe("anthropic-messages");
  });

  it("其余默认 OpenAI 兼容", () => {
    expect(inferApi(undefined, "https://api.deepseek.com/v1")).toBe("openai-completions");
  });
});

describe("readZcodeProviders —— 只接官方模板", () => {
  const OFFICIAL_DEEPSEEK = {
    providerId: "deepseek",
    templateId: "deepseek",
    providerName: "DeepSeek",
    config: {
      access: { type: "api-key", apiKey: "sk-deepseek" },
      modelOrder: ["deepseek-flash", "deepseek-v4-pro"],
    },
  };

  const OFFICIAL_QWEN = {
    providerId: "qwen-alibaba-model-studio-cn",
    templateId: "qwen-alibaba-model-studio-cn",
    providerName: "阿里云百炼（中国）",
    config: {
      access: { type: "api-key", apiKey: "sk-qwen" },
      api: { baseUrl: "https://token-plan.maas.qianwenaiapi.com/apps/anthropic" },
      modelOrder: ["qwen3.8-max", "qwen3.8-flash"],
    },
  };

  const CUSTOM_GLEMON = {
    providerId: "904c0249-e62a-4386-a9cc-c658b28992e9",
    providerName: "glemon",
    enabled: true,
    config: {
      access: { type: "api-key", apiKey: "sk-glemon" },
      api: { type: "anthropic-messages", baseUrl: "http://ai.internal.jiayouexp.com/v1" },
      modelOrder: ["glm-5.3"],
    },
  };

  const CUSTOM_STRATA = {
    providerId: "new-provider",
    providerName: "Strata",
    config: {
      access: { type: "api-key", apiKey: "sk-strata" },
      api: { type: "anthropic-messages", baseUrl: "https://123.57.163.149/strata/v1" },
      modelOrder: ["qwen3.8-flash-next-iq2_xs"],
    },
  };

  const NO_KEY = {
    providerId: "account:bigmodel-individual-coding-plan",
    templateId: "bigmodel",
    providerName: "bigmodel",
    config: { modelOrder: ["GLM-5.5"] },
  };

  it("只保留有 templateId 的官方 provider", () => {
    const { providers } = readZcodeProviders(
      rules([OFFICIAL_DEEPSEEK, OFFICIAL_QWEN, CUSTOM_GLEMON, CUSTOM_STRATA, NO_KEY]),
    );
    expect(providers.map((p) => p.name)).toEqual(["DeepSeek", "阿里云百炼（中国）"]);
  });

  it("自建 provider 被跳过并说明原因（不静默丢）", () => {
    const { providers, skipped } = readZcodeProviders(rules([CUSTOM_GLEMON, CUSTOM_STRATA]));
    expect(providers).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s) => s.reason.includes("官方模板"))).toBe(true);
  });

  it("官方但缺 key 的，跳过原因是缺 key", () => {
    const { providers, skipped } = readZcodeProviders(rules([NO_KEY]));
    expect(providers).toEqual([]);
    expect(skipped[0]?.reason).toContain("api-key");
  });

  it("DeepSeek 走 OpenAI 协议，baseUrl 补齐 /v1", () => {
    const { providers } = readZcodeProviders(rules([OFFICIAL_DEEPSEEK]));
    const deepseek = providers[0]!;
    expect(deepseek.api).toBe("openai-completions");
    expect(deepseek.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(deepseek.models.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("阿里云百炼按地址推断成 anthropic，且不重复加 /v1", () => {
    const { providers } = readZcodeProviders(rules([OFFICIAL_QWEN]));
    const qwen = providers[0]!;
    expect(qwen.api).toBe("anthropic-messages");
    expect(qwen.baseUrl).toBe("https://token-plan.maas.qianwenaiapi.com/apps/anthropic");
  });

  it("纯中文名退回 providerId 做 slug", () => {
    const { providers } = readZcodeProviders(rules([OFFICIAL_QWEN]));
    expect(providers[0]?.slug).toBe("qwen-alibaba-model-studio-cn");
  });

  it("enabled:false 的官方 provider 也跳过", () => {
    const { providers, skipped } = readZcodeProviders(rules([{ ...OFFICIAL_DEEPSEEK, enabled: false }]));
    expect(providers).toEqual([]);
    expect(skipped[0]?.reason).toContain("禁用");
  });

  it("文件不存在时安静返回空（不抛）", () => {
    const result = readZcodeProviders(join(tmpdir(), "definitely-missing-zcode-config.json"));
    expect(result.providers).toEqual([]);
    expect(result.source).toBeUndefined();
  });

  it("JSON 坏掉时报出来而不是崩", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-bad-"));
    const file = join(dir, "provider_config.json");
    writeFileSync(file, "{ not json", "utf8");
    const result = readZcodeProviders(file);
    expect(result.providers).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("JSON");
  });
});
