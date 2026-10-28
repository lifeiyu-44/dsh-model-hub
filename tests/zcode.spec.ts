import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readZcodeProviders } from "../src/channels/zcode/config.js";

/**
 * ZCode 配置解析的测试。
 *
 * 用真实形状的夹具（实测 2026-10-28 的 `provider_config.json`），
 * 因为这块的坑全在「字段可能缺失」上：
 * - DeepSeek 没有 api.type / baseUrl（靠 template 兜底）
 * - bigmodel 没有 access（走账号授权，接不了）
 * - 模型列表在 modelOrder，不是 models
 */

function writeConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-"));
  const file = join(dir, "provider_config.json");
  writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

const RULES = {
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "904c0249-e62a-4386-a9cc-c658b28992e9",
          providerName: "glemon",
          enabled: true,
          config: {
            access: { type: "api-key", apiKey: "sk-glemon" },
            api: { type: "anthropic-messages", baseUrl: "http://ai.internal.jiayouexp.com/v1" },
            modelOrder: ["glm-5.3", "glm-5.3-flash"],
            personalModelIds: ["glm-5.3", "deepseek-v4-flash"],
          },
        },
        {
          providerId: "deepseek",
          templateId: "deepseek",
          providerName: "DeepSeek",
          config: {
            access: { type: "api-key", apiKey: "sk-deepseek" },
            modelOrder: ["deepseek-flash", "deepseek-v4-pro"],
          },
        },
        {
          providerId: "account:bigmodel-individual-coding-plan",
          providerName: "bigmodel",
          config: { modelOrder: ["GLM-5.5"] },
        },
        {
          providerId: "new-provider",
          providerName: "Strata",
          config: {
            access: { type: "api-key", apiKey: "sk-strata" },
            api: { type: "anthropic-messages", baseUrl: "https://123.57.163.149/strata/v1" },
            modelOrder: ["qwen3.8-flash-next-iq2_xs"],
          },
        },
      ],
    },
  },
};

describe("readZcodeProviders", () => {
  it("读出有 apiKey 与 baseUrl 的 provider", () => {
    const { providers } = readZcodeProviders(writeConfig(RULES));
    expect(providers.map((p) => p.name)).toEqual(["glemon", "DeepSeek", "Strata"]);
  });

  it("glemon 的协议与地址来自配置本身", () => {
    const { providers } = readZcodeProviders(writeConfig(RULES));
    const glemon = providers.find((p) => p.name === "glemon")!;
    expect(glemon.api).toBe("anthropic-messages");
    expect(glemon.baseUrl).toBe("http://ai.internal.jiayouexp.com/v1");
    expect(glemon.apiKey).toBe("sk-glemon");
  });

  it("modelOrder 与 personalModelIds 都收，且去重保序", () => {
    const { providers } = readZcodeProviders(writeConfig(RULES));
    const glemon = providers.find((p) => p.name === "glemon")!;
    expect(glemon.models.map((m) => m.id)).toEqual(["glm-5.3", "glm-5.3-flash", "deepseek-v4-flash"]);
  });

  it("DeepSeek 缺 baseUrl 时用 template 兜底，协议默认 openai", () => {
    const { providers } = readZcodeProviders(writeConfig(RULES));
    const deepseek = providers.find((p) => p.name === "DeepSeek")!;
    expect(deepseek.baseUrl).toBe("https://api.deepseek.com");
    expect(deepseek.api).toBe("openai-completions");
  });

  it("没有 apiKey 的 provider 被跳过并给出原因（不静默丢）", () => {
    const { providers, skipped } = readZcodeProviders(writeConfig(RULES));
    expect(providers.some((p) => p.name === "bigmodel")).toBe(false);
    const reason = skipped.find((s) => s.name === "bigmodel");
    expect(reason?.reason).toContain("api-key");
  });

  it("enabled:false 的被跳过", () => {
    const doc = {
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerName: "off",
              enabled: false,
              config: {
                access: { apiKey: "k" },
                api: { baseUrl: "https://x" },
                modelOrder: ["m"],
              },
            },
          ],
        },
      },
    };
    const { providers, skipped } = readZcodeProviders(writeConfig(doc));
    expect(providers).toEqual([]);
    expect(skipped[0]?.reason).toContain("禁用");
  });

  it("slug 唯一（同名 provider 不会撞路由）", () => {
    const doc = {
      config: {
        providerConfigRules: {
          providerRules: [
            { providerName: "same", config: { access: { apiKey: "a" }, api: { baseUrl: "https://a" }, modelOrder: ["m1"] } },
            { providerName: "same", config: { access: { apiKey: "b" }, api: { baseUrl: "https://b" }, modelOrder: ["m2"] } },
          ],
        },
      },
    };
    const { providers } = readZcodeProviders(writeConfig(doc));
    expect(providers.map((p) => p.slug)).toEqual(["same", "same-2"]);
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

  it("纯中文 provider 名退回 providerId 做 slug（不要变成 provider）", () => {
    const doc = {
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "qwen-alibaba-model-studio-cn",
              providerName: "阿里云百炼（中国）",
              config: {
                access: { apiKey: "sk-qwen" },
                api: { baseUrl: "https://example.invalid/apps/anthropic" },
                modelOrder: ["qwen3.8-max"],
              },
            },
          ],
        },
      },
    };
    const { providers } = readZcodeProviders(writeConfig(doc));
    expect(providers[0]?.slug).toBe("qwen-alibaba-model-studio-cn");
  });
});
