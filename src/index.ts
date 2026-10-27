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
import { readWorkbuddyVault } from "./channels/workbuddy/vault.js";
import { fetchCatalog, upstreamBase, conversationIdentityHeaders } from "./channels/workbuddy/catalog.js";

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

    // 凭据来源按顺序试：
    //   1. 桌面端 auth 文件里的**明文** token（旧版桌面端才这样）
    //   2. dsh-connect-workbuddy 已解好的 vault（本机的实际情况 —— 桌面端
    //      auth 是 AES 信封，而本机没装 WorkBuddy App，解不了）
    // 两条都拿不到就如实报缺，不假装成功。
    const fromFile = detectCredential();
    const plainFromFile =
      fromFile !== undefined && fromFile.parsed.kind === "plain" && fromFile.parsed.token !== undefined
        ? { source: fromFile.path, parsed: fromFile.parsed }
        : undefined;
    const fromVault = plainFromFile === undefined ? readWorkbuddyVault() : undefined;
    const credential = plainFromFile ?? fromVault;

    if (credential === undefined) {
      const why = fromFile === undefined
        ? "没有找到任何 WorkBuddy 登录文件"
        : fromFile.parsed.kind === "encrypted"
          ? `桌面端凭据是加密信封（${fromFile.path}），且没有可复用的 vault`
          : `凭据不可用（${fromFile.path}，状态 ${fromFile.parsed.kind}）`;
      ctx.logger?.warn?.(
        `dsh-model-hub: 未找到可用的 WorkBuddy token —— ${why}。请先装 WorkBuddy 桌面端登录一次，或装 dsh-connect-workbuddy 让它解一次。渠道不注册。`,
      );
      return;
    }

    const token = credential.parsed.token as string;
    const region = credential.parsed.region ?? "global";
    ctx.logger?.info?.(`dsh-model-hub: 凭据来源 = ${credential.source}（${region}）`);

    const models = await fetchCatalog(region, token).catch((error: unknown) => {
      ctx.logger?.warn?.("dsh-model-hub: 模型目录拉取失败，使用空目录", error);
      return [];
    });

    const shim = await startShim({
      prepare: async () => ({
        baseUrl: upstreamBase(region),
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "WorkBuddy/5.12.1 WorkBuddy/5.12.1 CLI/2.63.2",
          // 每次请求现生成 —— 渠道校验认这三个头（实测，见 catalog.ts 的注释）。
          ...conversationIdentityHeaders(),
        },
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

    // 路由必须用 ctx.inject 延迟注册 —— 本插件的 `inject` 只声明了 `llm`，
    // 直接摸 `ctx.webServer` 会抛「cannot get property "webServer" without inject」，
    // 而加载期抛错会让整个 host fatal 退出（实测踩过，会把 profile 打回默认）。
    // 用 ctx.inject 的另一个好处：宿主没有 webServer 时只是不注册路由，插件照常工作。
    try {
      ctx.inject(["webServer"], (webCtx: any) => {
        try {
          registerRecordsRoute(webCtx, { query: (limit: number) => queryRecords(db, limit) });
        } catch (caught) {
          ctx.logger?.warn?.("dsh-model-hub: 记录路由注册失败（provider 不受影响）", caught);
        }
      });
    } catch (caught) {
      ctx.logger?.warn?.("dsh-model-hub: ctx.inject 不可用，记录路由跳过（provider 不受影响）", caught);
    }

    ctx.logger?.info?.(
      `dsh-model-hub: 已注册 ${PROVIDER_GLOBAL}（${models.length} 个模型），shim=${shim.baseUrl()}`,
    );
  })().catch((caught: unknown) => {
    // 异步体里任何逃逸的异常都不得冒到宿主加载期 —— 那会 fatal。
    ctx.logger?.error?.("dsh-model-hub: 初始化失败（插件不生效，宿主不受影响）", caught);
  });
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
