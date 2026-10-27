import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { Config } from "./config.js";
import { HUB_DB_NAME, HUB_DIR_NAME, PROVIDER_PREFIX } from "./constants.js";
import { openHubDatabase } from "./store/db.js";
import { insertRequest, queryRecords } from "./store/requests.js";
import { startShim } from "./shim/server.js";
import { registerRecordsRoute } from "./routes/records.js";
import { detectCredential } from "./channels/workbuddy/auth.js";
import { fetchCatalog, upstreamBase } from "./channels/workbuddy/catalog.js";

export const name = "dsh-model-hub";
export { Config };
export const inject = ["llm"];

const PROVIDER_GLOBAL = `${PROVIDER_PREFIX}workbuddy-global`;

export function apply(ctx: any, config: any): void {
  const settings = config ?? {};
  if (settings.enabled === false) return;

  const dbPath = join(resolveDshHome(), HUB_DIR_NAME, HUB_DB_NAME);

  void (async () => {
    let db: Awaited<ReturnType<typeof openHubDatabase>>;
    try {
      db = await openHubDatabase(dbPath);
    } catch (error) {
      ctx.logger?.error?.("dsh-model-hub: 数据库打开失败，记录功能关闭（provider 不受影响）", error);
      return;
    }

    const detected = detectCredential();
    if (detected === undefined || detected.parsed.kind !== "plain" || detected.parsed.token === undefined) {
      ctx.logger?.warn?.(
        `dsh-model-hub: 未找到可用的 WorkBuddy 明文凭据（探测结果：${detected?.parsed.kind ?? "missing"}，路径：${detected?.path ?? "无"}），渠道不注册`,
      );
      return;
    }
    const token = detected.parsed.token;
    const region = detected.parsed.region ?? "global";

    const models = await fetchCatalog(region, token).catch((error: unknown) => {
      ctx.logger?.warn?.("dsh-model-hub: 模型目录拉取失败，使用空目录", error);
      return [];
    });

    const shim = await startShim({
      prepare: async () => ({
        baseUrl: upstreamBase(region),
        headers: { Authorization: `Bearer ${token}` },
      }),
      record: ({ metrics, statusCode, error, isStreaming, model }) => {
        if (settings.recordEnabled === false) return;
        try {
          insertRequest(db, {
            requestId: randomUUID(),
            channelId: PROVIDER_GLOBAL,
            provider: PROVIDER_GLOBAL,
            model,
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
            cacheRead: metrics.cacheRead,
            cacheWrite: metrics.cacheWrite,
            ...(metrics.firstTokenMs === undefined ? {} : { firstTokenMs: metrics.firstTokenMs }),
            ...(metrics.upstreamHeadMs === undefined ? {} : { upstreamHeadMs: metrics.upstreamHeadMs }),
            ...(metrics.durationMs === undefined ? {} : { durationMs: metrics.durationMs }),
            ...(metrics.decodeTps === undefined ? {} : { decodeTps: metrics.decodeTps }),
            statusCode,
            ...(error === undefined ? {} : { error }),
            isStreaming,
            estimated: metrics.estimated,
            costUnits: 0,
            createdAt: Date.now(),
          });
        } catch (caught) {
          ctx.logger?.warn?.("dsh-model-hub: 记录写入失败（请求不受影响）", caught);
        }
      },
    });

    const release = registerProvider(ctx, shim.baseUrl(), models);

    ctx.effect(() => () => {
      release();
      shim.close();
      db.close();
    }, "dsh-model-hub: teardown");

    registerRecordsRoute(ctx, { query: (limit: number) => queryRecords(db, limit) });

    ctx.logger?.info?.(
      `dsh-model-hub: 已注册 ${PROVIDER_GLOBAL}（${models.length} 个模型），shim=${shim.baseUrl()}`,
    );
  })();
}

/**
 * 注册 provider。
 *
 * 用宿主自己的 `PiAiAdapter`（`dsh-llm-pi-ai` 导出），而不是手写一个 LlmAdapter：
 * 它已经把 OpenAI 兼容协议的流、工具调用、图片、重试都封好了，我们只需要
 * 把 baseUrl 指向自己的 shim。
 */
function registerProvider(
  ctx: any,
  shimBaseUrl: string,
  models: Awaited<ReturnType<typeof fetchCatalog>>,
): () => void {
  // 动态 import：只有真正注册时才加载 pi-ai，避免没凭据时白拉一次依赖。
  let released = false;
  let release: (() => void) | undefined;

  void (async () => {
    const { PiAiAdapter } = await import("@deepseek-ai/dsh-llm-pi-ai");
    if (released) return;
    const adapter = new PiAiAdapter({
      profiles: () =>
        new Map([
          [
            PROVIDER_GLOBAL,
            {
              provider: PROVIDER_GLOBAL,
              api: "openai-completions",
              baseUrl: shimBaseUrl,
              apiKey: "shim",
              models: models.map((m) => ({
                id: m.id,
                name: m.name,
                contextWindow: m.contextWindow,
                maxTokens: m.maxTokens,
                input: m.supportsImages ? ["text", "image"] : ["text"],
              })),
            },
          ],
        ]),
      auth: { kind: "api-key" },
      resolveApiKey: async () => "shim",
    } as any);
    release = ctx.llm.registerAdapter([PROVIDER_GLOBAL], adapter);
  })().catch((error: unknown) => {
    ctx.logger?.error?.("dsh-model-hub: provider 注册失败", error);
  });

  return () => {
    released = true;
    release?.();
  };
}
