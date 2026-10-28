import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { Config } from "./config.js";
import { HUB_DB_NAME, HUB_DIR_NAME, PROVIDER_PREFIX } from "./constants.js";
import { openHubDatabase } from "./store/db.js";
import { insertRequest } from "./store/requests.js";
import { seedChannelsAndAccounts } from "./store/seed.js";
import { startShim } from "./shim/server.js";
import { detectCredential } from "./channels/workbuddy/auth.js";
import { readWorkbuddyVault } from "./channels/workbuddy/vault.js";
import { fetchCatalog, upstreamBase, conversationIdentityHeaders } from "./channels/workbuddy/catalog.js";
import { createHubAdapter, createDirectAdapter } from "./provider.js";
import { registerDataRoutes } from "./routes/data.js";
import { readZcodeProviders, type ZcodeProvider } from "./channels/zcode/config.js";

export const name = "dsh-model-hub";
export { Config };
export const inject = ["llm"];

const PROVIDER_GLOBAL = `${PROVIDER_PREFIX}workbuddy-global`;

export function apply(ctx: any, config: any): void {
  // 最外层防线：apply() 内的任何同步异常都不得冒到 Cordis 加载期。
  //
  // 这不是防御性编程的洁癖 —— 实测代价是：加载期抛错 → host 以 exit 1 退出
  // → DSH 判定 fatal 并**把整个 profile 重置为默认**（bundles 清空、
  // cordis.patch.yml 被覆盖），用户原有的所有插件一次性停用。
  // 插件自己坏掉可以接受，拖垮整个宿主不可接受。
  try {
    applyInner(ctx, config);
  } catch (error) {
    try {
      ctx.logger?.error?.("dsh-model-hub: 插件初始化失败（不影响宿主与其它插件）", error);
    } catch {
      /* logger 也不可用时只能放弃记录 */
    }
  }
}

function applyInner(ctx: any, config: any): void {
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

    // 先把渠道与账号登记上 —— 面板的「渠道」「账号」两栏靠这两张表，
    // 而它们不随请求写入。少了这一步，没发过请求时面板看起来像坏了。
    // 写失败不影响 provider（诊断信息而已），所以只记日志。
    try {
      seedChannelsAndAccounts(
        db,
        [{ id: PROVIDER_GLOBAL, kind: "workbuddy", displayName: "WorkBuddy Global" }],
        [
          {
            id: `${PROVIDER_GLOBAL}:default`,
            channelId: PROVIDER_GLOBAL,
            displayName: "WorkBuddy 主账号",
            credentialRef: credential.source,
            isCurrent: true,
          },
        ],
      );
    } catch (error) {
      ctx.logger?.warn?.("dsh-model-hub: 渠道/账号登记失败（面板可能显示为空，provider 不受影响）", error);
    }

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

    const release = registerProvider(ctx, shim.baseUrl(), shim.token(), models, async (outcome) => {
      // 注册是异步的，而且「注册成功」不等于「能出模型」—— 所以结果由
      // registerProvider 自检完再回报，不是在这里假定。
      await writeStatus(ctx, {
        ...outcome,
        provider: PROVIDER_GLOBAL,
        shim: shim.baseUrl(),
        catalogCount: models.length,
      });
    });

    ctx.effect(() => () => {
      release();
      shim.close();
      db.close();
    }, "dsh-model-hub: teardown");

    // 面板数据路由。
    //
    // 教训：`ctx.webServer` 的属性访问由插件的**静态** `inject` 数组把关 ——
    // 但正确写法不是把它加进静态 inject，而是走 `ctx.inject(["webServer"], cb)`，
    // **回调收到的那个 ctx** 才带着 webServer。在外层 ctx 上直接摸仍会抛
    // `cannot get property "webServer" without inject`，那是加载期异常，
    // 会让整个 host `exit 1`，进而触发 DSH 把 profile 重置为默认
    // （bundles 清空、cordis.patch.yml 被覆盖）—— 实测踩过两次。
    // 两种写法的差异由 tests/webserver-access.spec.ts 用真实 Cordis 定死。
    registerDataRoutes(ctx, { db, catalog: () => models });

    // ── ZCode 渠道 ──
    //
    // 与 WorkBuddy 不同，ZCode 的每个 provider 自带 baseUrl + apiKey + 协议，
    // 不需要经过我们的 shim，直接注册成 provider 路由。
    //
    // 代价：直连请求**不进本插件的记录表**（没有经过 shim 埋点）。
    // 面板上不能假装有 ZCode 的 token 速度 —— 这条限制写在 provider.ts 里。
    const zcode = readZcodeProviders();
    const zcodeRegistered: string[] = [];
    try {
      for (const backend of zcode.providers) {
        const ok = await registerZcodeProvider(ctx, backend);
        if (ok) zcodeRegistered.push(`hub-zcode-${backend.slug}`);
      }
    } catch (error) {
      ctx.logger?.warn?.("dsh-model-hub: ZCode 渠道注册失败（不影响 WorkBuddy）", error);
    }
    if (zcode.skipped.length > 0) {
      ctx.logger?.warn?.(
        `dsh-model-hub: ZCode 跳过 ${zcode.skipped.length} 个 provider —— ${zcode.skipped
          .map((s) => `${s.name}: ${s.reason}`)
          .join("；")}`,
      );
    }

    ctx.logger?.info?.(
      `dsh-model-hub: 已注册 ${PROVIDER_GLOBAL}（${models.length} 个模型），shim=${shim.baseUrl()}` +
        (zcodeRegistered.length > 0 ? `；ZCode ${zcodeRegistered.length} 个 provider` : ""),
    );
  })().catch((caught: unknown) => {
    // 异步体里任何逃逸的异常都不得冒到宿主加载期 —— 那会 fatal。
    ctx.logger?.error?.("dsh-model-hub: 初始化失败（插件不生效，宿主不受影响）", caught);
  });
}

/**
 * 把「本次启动实际注册成什么样」写成一个可审计的文件。
 *
 * 起因：P0 曾出现「provider 在 `llm/listProviders` 里、但模型列表是空的」这种
 * **假成功**。当时没有任何外部可见的证据能区分「注册成功」与「注册了个空壳」，
 * 只能靠人去 UI 里点。这个文件让部署脚本和人都能一眼看到真实结果。
 *
 * 写入失败一律吞掉 —— 诊断文件写不出来不能影响插件本身。
 */
async function writeStatus(
  ctx: any,
  status: {
    ok: boolean;
    provider?: string;
    modelCount: number;
    modelIds?: string[];
    catalogCount?: number;
    shim?: string;
    error?: string;
  },
): Promise<void> {
  try {
    const dir = join(resolveDshHome(), HUB_DIR_NAME);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify({ ...status, at: new Date().toISOString(), pid: process.pid }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    ctx.logger?.warn?.("dsh-model-hub: 状态文件写入失败（不影响插件）", error);
  }
}

/**
 * 注册 provider。
 *
 * ## 为什么不是「把配置文档形状塞进 profiles()」
 *
 * `PiAiAdapter` 的 `profiles()` 收的**不是** `dsh-llm-pi-ai` 设置文档里的
 * provider 条目（`api` / `baseURL` / `models` 那套），而是那个模块
 * **已经解析完**的内部 profile 形状。它的 `current()` 只做一件事：
 *
 * ```js
 * for (const profile of profiles.values())
 *   if (profile.piProvider !== undefined) models.setProvider(profile.piProvider);
 * ```
 *
 * 也就是说模型全部来自 `profile.piProvider` —— 一个 pi-ai 的 provider 对象。
 * 少了它，`models` 集合是空的：`listModels()` 返回 `[]`，
 * `resolveModel()` 在 `profile.modelErrors.get(...)` 上踩空抛裸 TypeError。
 *
 * **这个坑的可怕之处在于它「看起来成功了」**：`registerAdapter` 不报错、
 * `llm/listProviders` 里能看到 `hub-workbuddy-global`，只有真的去选模型
 * 才会发现一个都没有。P0 就是这样验收漏掉的 —— 只查了 provider 在不在列表里。
 *
 * 形状转换本身在 `provider.ts`（独立可测），这里只负责装配与注册。
 */
function registerProvider(
  ctx: any,
  shimBaseUrl: string,
  shimToken: string,
  models: Awaited<ReturnType<typeof fetchCatalog>>,
  report: (outcome: { ok: boolean; modelCount: number; modelIds?: string[]; error?: string }) => Promise<void>,
): () => void {
  let released = false;
  let release: (() => void) | undefined;

  void (async () => {
    const [{ PiAiAdapter }, { createProvider }, { openAICompletionsApi }, { resolveRetryPolicy }] = await Promise.all([
      import("@deepseek-ai/dsh-llm-pi-ai"),
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-ai/api/openai-completions.lazy"),
      import("@deepseek-ai/dsh-llm"),
    ]);
    if (released) return;

    const adapter = createHubAdapter({
      provider: PROVIDER_GLOBAL,
      shimBaseUrl,
      shimToken,
      models,
      createProvider,
      openAICompletionsApi,
      resolveRetryPolicy,
      PiAiAdapter,
    });

    if (released) return;
    release = ctx.llm.registerAdapter([PROVIDER_GLOBAL], adapter);

    // 注册之后再自检一次：真的问 adapter 要一遍模型列表。
    // 「registerAdapter 没报错」不足以证明能用 —— P0 就是这么骗过验收的。
    try {
      const listed = await adapter.listModels(PROVIDER_GLOBAL);
      const ids = listed.map((m: { id: string }) => m.id);
      if (ids.length === 0) {
        ctx.logger?.warn?.("dsh-model-hub: provider 注册成功但模型列表为空 —— 检查 provider.ts 的 piProvider");
        await report({ ok: false, modelCount: 0, modelIds: [], error: "listModels returned no models" });
        return;
      }
      ctx.logger?.info?.(`dsh-model-hub: provider 注册完成（${ids.length} 个模型可被选中）`);
      await report({ ok: true, modelCount: ids.length, modelIds: ids });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.error?.("dsh-model-hub: provider 注册后自检失败", error);
      await report({ ok: false, modelCount: 0, error: message });
    }
  })().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.error?.("dsh-model-hub: provider 注册失败", error);
    await report({ ok: false, modelCount: 0, error: message }).catch(() => {});
  });

  return () => {
    released = true;
    release?.();
  };
}

/**
 * 注册一个 ZCode provider（直连型）。
 *
 * 每个 ZCode provider 有自己的 baseUrl / apiKey / 协议，所以是**一个 provider
 * 一个路由**，而不是像 WorkBuddy 那样所有模型挤在一条路由后面走 shim。
 *
 * 返回是否注册成功（失败只记日志，不影响其它 provider）。
 */
async function registerZcodeProvider(ctx: any, backend: ZcodeProvider): Promise<boolean> {
  const providerId = `hub-zcode-${backend.slug}`;
  try {
    const [{ PiAiAdapter }, { createProvider }, { openAICompletionsApi }, { anthropicMessagesApi }, { resolveRetryPolicy }] =
      await Promise.all([
        import("@deepseek-ai/dsh-llm-pi-ai"),
        import("@earendil-works/pi-ai"),
        import("@earendil-works/pi-ai/api/openai-completions.lazy"),
        import("@earendil-works/pi-ai/api/anthropic-messages.lazy"),
        import("@deepseek-ai/dsh-llm"),
      ]);

    const adapter = createDirectAdapter({
      provider: providerId,
      displayName: `ZCode · ${backend.name}`,
      baseUrl: backend.baseUrl,
      apiKey: backend.apiKey,
      api: backend.api,
      models: backend.models,
      createProvider,
      openAICompletionsApi,
      anthropicMessagesApi,
      resolveRetryPolicy,
      PiAiAdapter,
    });

    ctx.llm.registerAdapter([providerId], adapter);

    // 与 WorkBuddy 一样，注册后自检一次 —— 「注册没报错」不等于「能出模型」。
    const listed = await adapter.listModels(providerId);
    if (listed.length === 0) {
      ctx.logger?.warn?.(`dsh-model-hub: ${providerId} 注册成功但模型为空`);
      return false;
    }
    ctx.logger?.info?.(`dsh-model-hub: 已注册 ${providerId}（${listed.length} 个模型，直连）`);
    return true;
  } catch (error) {
    ctx.logger?.warn?.(`dsh-model-hub: ${providerId} 注册失败`, error);
    return false;
  }
}
