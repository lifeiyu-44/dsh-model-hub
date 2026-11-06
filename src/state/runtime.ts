import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { startShim, type ShimHandle } from "../shim/server.js";
import type { TurnMetrics } from "../shim/recorder.js";
import { insertRequest } from "../store/requests.js";
import { createHubAdapter } from "../provider.js";
import { parseAuthDocument } from "../channels/workbuddy/auth.js";
import { DESKTOP_UA, conversationIdentityHeaders, fetchCatalog, upstreamBase } from "../channels/workbuddy/catalog.js";
import { createSessionManager, type QoderSession } from "../channels/qoder/credentials.js";
import { fetchQoderCatalog } from "../channels/qoder/catalog.js";
import { createQoderDialect } from "../channels/qoder/chat.js";
import { readTraeCredentialFile, type TraeCredential } from "../channels/trae/credentials.js";
import { fetchTraeCatalog } from "../channels/trae/catalog.js";
import { createTraeDialect } from "../channels/trae/chat.js";
import type { ChannelModel } from "../channels/types.js";
import type { SelectorRow } from "./selector.js";

/**
 * 单渠道 runtime：shim + adapter 的装配与启停（从 index.ts 迁来并参数化）。
 *
 * index.ts 里每个渠道都是「起 shim → 拉目录 → registerProvider」三步连写，
 * 渠道一多（多账号计划后 WorkBuddy / Qoder 都要可启停）就得抽成参数化的
 * 一个函数：hub-state 只管「什么时候要 runtime」，这里管「runtime 长什么样」。
 *
 * 上架 adapter 的实现是注入点（RegisterAdapterFn，测试传 fake）；生产实现
 * {@link createRegisterAdapter}（原 index.ts 的 registerProvider）也在本模块
 * —— 它要绑定 shim 地址/密钥，只能在 shim 起好后的内部做缺省注入。
 */

/** 面板目录条目（index.ts panelCatalog 的形状，模型标签槽按 id 查倍率上色）。 */
export interface PanelEntry {
  id: string;
  name: string;
  creditMultiplier?: number;
  promotionBadge?: string;
  tierBadge?: string;
  promotionColor?: string;
  tierColor?: string;
}

/** runtime 句柄：release 只下架 adapter（shim 保留，端口不变），关 shim 走 shim.close。 */
export interface RuntimeHandle {
  shim: ShimHandle;
  /** adapter 下架（模型从选择器消失）；幂等。 */
  release(): void;
  /** 当前上架的模型目录（refresh 后指向新数组）。 */
  readonly models: ChannelModel[];
  readonly panelEntries: PanelEntry[];
  /** 用任一可用账号重拉目录并重注册 adapter；拉不到保留旧目录。 */
  refresh(): Promise<void>;
  /** adapter 上/下架；true 时用缓存的目录重注册（不重拉、不重建 shim）。 */
  setEnabled(enabled: boolean): void;
}

/** 日志：与 ctx.logger 的用法对齐，方法全部可选（测试传 `{}`）。 */
export interface Logger {
  info?(message: string, ...rest: unknown[]): void;
  warn?(message: string, ...rest: unknown[]): void;
  error?(message: string, ...rest: unknown[]): void;
}

/** runtime 眼中的状态中心：只挑号 / 看池 / 记结果，不暴露写库细节。 */
export interface HubStateView {
  pick(channelId: string): SelectorRow | undefined;
  poolSize(channelId: string): number;
  reportResult(channelId: string, accountId: string, ok: boolean, status?: number, error?: string): void;
}

/** hub-state 能装配的部分；ctx 与 registerAdapter 由任务 9 在装配处闭包补上。 */
export interface ChannelRuntimeInput {
  db: DatabaseSync;
  channelId: string;
  kind: string;
  settings: () => { recordEnabled?: boolean };
  state: HubStateView;
  logger: Logger;
}

export interface RegisterReport {
  ok: boolean;
  modelCount: number;
  modelIds?: string[];
  error?: string;
}

/**
 * 注册结果回报（{@link ChannelRuntimeDeps.onRegisterReport} 的入参）：
 * RegisterReport 加上调用方（index.ts 的 writeStatus/status.json）需要、
 * 但只有 runtime 内部知道的上下文。
 */
export type RegisterReportContext = RegisterReport & {
  /** 注册的 provider id（= channelId）。 */
  provider: string;
  /** 本次上架的 shim 地址（诊断要用；调用方拿不到 runtime 内部的 shim）。 */
  shim: string;
  /** 上架时的目录条数 —— 与 modelCount 的自检口径不同：目录 ≠ 真正可选中的模型。 */
  catalogCount: number;
};

/**
 * 把模型上架到宿主选择器，返回下架函数。
 *
 * 注册是异步完成的（内部动态 import），返回的 release 必须可同步调用且幂等，
 * 保证「渠道开关只 release/重注册 adapter，shim 不重建」（约束 8）。
 */
export type RegisterAdapterFn = (
  ctx: unknown,
  providerId: string,
  models: ChannelModel[],
  report: (outcome: RegisterReport) => Promise<void>,
) => () => void;

export interface ChannelRuntimeDeps extends ChannelRuntimeInput {
  /** 宿主 ctx（生产 registerAdapter 要用它注册 provider；测试 fake 可忽略）。 */
  ctx: unknown;
  /**
   * 上架 adapter 的实现。**不传用生产实现**（{@link createRegisterAdapter}）——
   * 它要把 shim 地址/密钥绑进 adapter，而 shim 在 startChannelRuntime 内部
   * 才建好，生产路径没法在外面预先构造；测试传 fake 从这里注入。
   */
  registerAdapter?: RegisterAdapterFn;
  /**
   * 每次上架后的结果回报（生产接 index.ts 的 writeStatus 写 status.json；
   * 测试可不传）。register → setEnabled(true) → refresh 的每次重注册都会触发，
   * status.json 始终反映最近一次注册的真实结果。
   */
  onRegisterReport?: (outcome: RegisterReportContext) => Promise<void>;
}

/**
 * 账号的 credential_ref（指向 vault/auth/PAT 文件的路径引用）。
 *
 * 存储层有意不给面板查询返回凭据列（queries.ts 只给 has_credential），
 * 而 runtime 是唯一需要「引用 → 现读文件」的通路，所以这里有一条只读
 * SELECT。凭据本身永远不进 DB/日志 —— 读到的 token 只进请求头。
 */
function credentialRefOf(db: DatabaseSync, accountId: string): string | null {
  const row = db
    .prepare("SELECT credential_ref FROM accounts WHERE id = ? AND deleted = 0")
    .get(accountId) as { credential_ref: string | null } | undefined;
  return row?.credential_ref ?? null;
}

/** 现读 PAT；不是 `pt-` 开头或读不了都算没有（fail-soft）。 */
function patOf(db: DatabaseSync, accountId: string): { pat: string; source: string } | undefined {
  const ref = credentialRefOf(db, accountId);
  if (ref === null) return undefined;
  // `env:` 前缀 = 环境变量来源（启动 seed 会把 session.source 原样登记进库）。
  // 解读与 prober.testQoderCredential 一致 —— 不处理它，env 来源的账号在
  // runtime 里永远「凭据不可用」，而单账号时期它们是能服务的（装配化的回归）。
  if (ref.startsWith("env:")) {
    const value = process.env[ref.slice("env:".length)]?.trim();
    return value !== undefined && value.startsWith("pt-") ? { pat: value, source: ref } : undefined;
  }
  try {
    const pat = readFileSync(ref, "utf8").trim();
    return pat.startsWith("pt-") ? { pat, source: ref } : undefined;
  } catch {
    return undefined;
  }
}

function toPanelEntries(models: ChannelModel[]): PanelEntry[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.creditMultiplier === undefined ? {} : { creditMultiplier: m.creditMultiplier }),
    ...(m.promotionBadge === undefined ? {} : { promotionBadge: m.promotionBadge }),
    ...(m.tierBadge === undefined ? {} : { tierBadge: m.tierBadge }),
    ...(m.promotionColor === undefined ? {} : { promotionColor: m.promotionColor }),
    ...(m.tierColor === undefined ? {} : { tierColor: m.tierColor }),
  }));
}

/**
 * 生产 registerAdapter：把模型上架到宿主 llm 选择器（原 index.ts 的
 * registerProvider 原样迁来，任务 9 裁定 3）。
 *
 * RegisterAdapterFn 接口不带 shim 地址/密钥（测试 fake 不该关心它们），
 * 而这两样只有持有 ShimHandle 的一方知道 —— 所以生产实现是「绑定 shim 的
 * 工厂」，startChannelRuntime 在 shim 起好后作为缺省注入使用。
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
export function createRegisterAdapter(shim: ShimHandle): RegisterAdapterFn {
  return (ctx, providerId, models, report) => {
    // RegisterAdapterFn 为测试把 ctx 定成 unknown；生产它就是宿主 ctx
    // （插件静态 inject 了 llm，所以 llm 必在）。
    const host = ctx as {
      llm: { registerAdapter(ids: string[], adapter: unknown): () => void };
      logger?: Logger;
    };
    let released = false;
    let release: (() => void) | undefined;

    void (async () => {
      const [{ PiAiAdapter }, { createProvider }, { openAICompletionsApi }, { resolveRetryPolicy, resolveImageAttachmentAccess }] = await Promise.all([
        import("@deepseek-ai/dsh-llm-pi-ai"),
        import("@earendil-works/pi-ai"),
        import("@earendil-works/pi-ai/api/openai-completions.lazy"),
        import("@deepseek-ai/dsh-llm"),
      ]);
      if (released) return;

      // 宿主的 durable attachment 服务与 fs 映射：图片输入的两个前提。
      //
      // 都是**每次请求现取**（惰性闭包），不是在这里取一次存起来：
      // 插件装配可能早于这两个服务就绪，缓存 undefined 会让图片能力
      // 永久失能，而用户看不出原因。
      //
      // 与宿主官方 `dsh-llm-pi-ai` 的写法一致（见其 registerPiAiFlows 里的
      // `resolveAttachments: () => ctx.get("attachments")`）——
      // 那是这条链路唯一的先例，照它做比自己发明可靠。
      const hostCtx = ctx as {
        get?: (name: string) => any;
        llm: { registerAdapter(ids: string[], adapter: unknown): () => void };
        logger?: Logger;
      };
      const resolveAttachments = () => hostCtx.get?.("attachments");

      const adapter = createHubAdapter({
        provider: providerId,
        shimBaseUrl: shim.baseUrl(),
        shimToken: shim.token(),
        models,
        createProvider,
        openAICompletionsApi,
        resolveRetryPolicy,
        PiAiAdapter,
        resolveAttachments,
        resolveImageAccess: (attachments: any, ref: any) =>
          resolveImageAttachmentAccess(
            attachments,
            (hostPath: string) => hostCtx.get?.("fs")?.processPathFromHostPath?.(hostPath),
            ref,
          ),
      });

      if (released) return;
      release = host.llm.registerAdapter([providerId], adapter);

      // 注册之后再自检一次：真的问 adapter 要一遍模型列表。
      // 「registerAdapter 没报错」不足以证明能用 —— P0 就是这么骗过验收的。
      try {
        const listed = await adapter.listModels(providerId);
        const ids = listed.map((m: { id: string }) => m.id);
        if (ids.length === 0) {
          host.logger?.warn?.("dsh-model-hub: provider 注册成功但模型列表为空 —— 检查 provider.ts 的 piProvider");
          await report({ ok: false, modelCount: 0, modelIds: [], error: "listModels returned no models" });
          return;
        }
        host.logger?.info?.(`dsh-model-hub: provider 注册完成（${ids.length} 个模型可被选中）`);
        await report({ ok: true, modelCount: ids.length, modelIds: ids });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        host.logger?.error?.("dsh-model-hub: provider 注册后自检失败", error);
        await report({ ok: false, modelCount: 0, error: message });
      }
    })().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      host.logger?.error?.("dsh-model-hub: provider 注册失败", error);
      await report({ ok: false, modelCount: 0, error: message }).catch(() => {});
    });

    return () => {
      released = true;
      release?.();
    };
  };
}

/**
 * 起一个渠道的 runtime：shim（按 kind 分派 prepare/方言）→ 拉目录 → 上架 adapter。
 *
 * 目录拉取失败直接抛错 —— 调用方（hub-state.ensureRuntime）记日志并保持
 * 「无 runtime」状态，下次 syncChannelRuntime 自然重试；带着空目录上架
 * adapter 就是 P0 那种「注册成功但模型列表是空的」假成功。
 */
export async function startChannelRuntime(deps: ChannelRuntimeDeps): Promise<RuntimeHandle> {
  const { db, channelId, kind, state, logger } = deps;

  let models: ChannelModel[] = [];
  let panelEntries: PanelEntry[] = [];
  let adapterRelease: (() => void) | undefined;

  // ── Qoder 会话源：一个账号一个 jobToken 管理器 ──
  // 按账号缓存的依据是 PAT 明文：文件里换了 PAT（用户重新生成）就换管理器，
  // 旧 jobToken 不该再被复用；没换则复用管理器内部的缓存与单飞。
  const qoderSessions = new Map<string, { pat: string; manager: ReturnType<typeof createSessionManager> }>();
  let defaultQoderSession: ReturnType<typeof createSessionManager> | undefined;

  async function qoderSessionFor(accountId: string | undefined): Promise<QoderSession | undefined> {
    if (accountId === undefined) {
      // 方言层兜底路径（请求没带账号）：缺省 PAT 源，与 index.ts 单账号时期一致。
      defaultQoderSession ??= createSessionManager();
      return defaultQoderSession.current();
    }
    const found = patOf(db, accountId);
    if (found === undefined) return undefined;
    const cached = qoderSessions.get(accountId);
    if (cached !== undefined && cached.pat === found.pat) return cached.manager.current();
    const manager = createSessionManager({ readCredential: () => found });
    qoderSessions.set(accountId, { pat: found.pat, manager });
    return manager.current();
  }

  /**
   * Trae：按 credential_ref 现读 token 文件（0600 明文，插件自己的目录）。
   *
   * 每次现读而不是缓存：用户在 Trae 里换号/重登后，面板「一键认证」会重写
   * 这个文件；缓存住凭据等于让新票在重启前一直不生效。
   * 读不到/格式坏一律返回 undefined —— 由调用方（prepare / 目录）决定报错文案，
   * 这里不抛，免得一条坏文件把整个 runtime 打成不可用。
   */
  async function traeCredentialFor(accountId: string | undefined): Promise<TraeCredential | undefined> {
    const target = accountId ?? state.pick(channelId)?.id;
    if (target === undefined) return undefined;
    const ref = credentialRefOf(db, target);
    if (ref === null) return undefined;
    try {
      return readTraeCredentialFile(ref);
    } catch {
      return undefined;
    }
  }

  /** WorkBuddy：按 credential_ref 现读 auth 文件（裁定：非 plain / 无 token 抛错，shim 外层 catch 转 502）。 */
  async function prepareWorkbuddy(accountId: string) {
    const ref = credentialRefOf(db, accountId);
    if (ref === null) throw new Error(`账号 ${accountId} 没有 credential_ref`);
    // 每次现读（文件 KB 级）：token 可能已被桌面端刷新，缓存明文等于拿旧票出门。
    const parsed = parseAuthDocument(readFileSync(ref, "utf8"));
    if (parsed.kind !== "plain" || parsed.token === undefined) {
      throw new Error(`账号 ${accountId} 的凭据不可用（${ref}，状态 ${parsed.kind}）`);
    }
    const region = parsed.region ?? "global";
    return {
      baseUrl: upstreamBase(region),
      headers: {
        Authorization: `Bearer ${parsed.token}`,
        "User-Agent": DESKTOP_UA,
        // 每次请求现生成 —— 渠道校验认这三个头，且不跨请求复用（见 catalog.ts）。
        ...conversationIdentityHeaders(),
      },
      account: { id: accountId },
    };
  }

  async function prepare(): Promise<{ baseUrl: string; headers: Record<string, string>; account?: { id: string } }> {
    const row = state.pick(channelId);
    if (row === undefined) throw new Error(`渠道 ${channelId} 没有可用账号`);
    if (kind === "qoder") {
      // 方言模式：URL/头/体全由 dialect.request 决定，这里只贯通选中的账号。
      return { baseUrl: "https://qoder.invalid", headers: {}, account: { id: row.id } };
    }
    if (kind === "trae") {
      // 同上：Trae 的 URL/头/体全在方言里（含 x-ide-* 三件套），这里不拼。
      if ((await traeCredentialFor(row.id)) === undefined) {
        throw new Error(`账号 ${row.id} 的 Trae 凭据不可用（token 文件缺失或已失效）`);
      }
      return { baseUrl: "https://trae.invalid", headers: {}, account: { id: row.id } };
    }
    return prepareWorkbuddy(row.id);
  }

  /** 用当前池头账号的凭据拉目录；拿不到凭据/目录就抛错（由调用方记日志）。 */
  async function fetchCatalogForHead(): Promise<ChannelModel[]> {
    const head = state.pick(channelId);
    if (head === undefined) throw new Error(`渠道 ${channelId} 没有可用账号，无法拉目录`);
    if (kind === "qoder") {
      const session = await qoderSessionFor(head.id);
      if (session === undefined) throw new Error(`账号 ${head.id} 的 Qoder 凭据不可用（PAT 缺失或交换失败）`);
      const result = await fetchQoderCatalog(session);
      if (result.error !== undefined) throw new Error(`Qoder 目录拉取失败：${result.error}`);
      return result.models;
    }
    if (kind === "trae") {
      const credential = await traeCredentialFor(head.id);
      if (credential === undefined) throw new Error(`账号 ${head.id} 的 Trae 凭据不可用（token 文件缺失或已失效）`);
      const result = fetchTraeCatalog(credential);
      if (result.error !== undefined) logger.warn?.(`dsh-model-hub: ${channelId} ${result.error}`);
      if (result.models.length === 0) throw new Error("Trae 目录为空（本机缓存与内置名单都没有可用模型）");
      return result.models;
    }
    const ref = credentialRefOf(db, head.id);
    if (ref === null) throw new Error(`账号 ${head.id} 没有 credential_ref`);
    const parsed = parseAuthDocument(readFileSync(ref, "utf8"));
    if (parsed.kind !== "plain" || parsed.token === undefined) {
      throw new Error(`账号 ${head.id} 的凭据不可用（${ref}，状态 ${parsed.kind}）`);
    }
    return fetchCatalog(parsed.region ?? "global", parsed.token);
  }

  function register(): void {
    if (adapterRelease !== undefined) return;
    // 空目录不上架 —— P0 的教训：「注册没报错」不等于「能出模型」。
    if (models.length === 0) {
      logger.warn?.(`dsh-model-hub: ${channelId} 目录为空，不上架 adapter`);
      return;
    }
    adapterRelease = registerAdapter(deps.ctx, channelId, models, async (outcome) => {
      logger.info?.(
        `dsh-model-hub: ${channelId} provider 注册结果 ok=${outcome.ok} models=${outcome.modelCount}` +
          (outcome.error === undefined ? "" : ` error=${outcome.error}`),
      );
      // 注册时的 shim 地址与目录条数只有这里知道，随回报带给调用方（status.json）
      await deps.onRegisterReport?.({
        ...outcome,
        provider: channelId,
        shim: shim.baseUrl(),
        catalogCount: models.length,
      });
    });
  }

  function releaseAdapter(): void {
    const release = adapterRelease;
    adapterRelease = undefined;
    try {
      release?.();
    } catch (error) {
      logger.warn?.(`dsh-model-hub: ${channelId} adapter 下架失败（忽略）`, error);
    }
  }

  const shim = await startShim({
    prepare,
    // 只有 Qoder / Trae 需要改写：Qoder 两层信封、Trae 事件名与数据分行。
    // 其余 kind 走 OpenAI 兼容直通，与 index.ts 现状一致。
    ...(kind === "qoder"
      ? { dialect: createQoderDialect({ sessionFor: (account) => qoderSessionFor(account?.id) }) }
      : {}),
    ...(kind === "trae"
      ? { dialect: createTraeDialect({ credentialFor: (account) => traeCredentialFor(account?.id) }) }
      : {}),
    maxAttempts: () => Math.min(3, state.poolSize(channelId)),
    onAccountResult: (account, ok, status, error) => {
      state.reportResult(channelId, account.id, ok, status, error);
    },
    record: makeRecorder(db, channelId, () => deps.settings().recordEnabled !== false),
  });

  // 上架实现的最终选定要等 shim 起好：生产缺省（createRegisterAdapter）要把
  // 地址/密钥绑进 adapter；测试在 deps.registerAdapter 传 fake。
  const registerAdapter = deps.registerAdapter ?? createRegisterAdapter(shim);

  try {
    models = await fetchCatalogForHead();
    panelEntries = toPanelEntries(models);
    register();
  } catch (error) {
    // 目录拉取/凭据现读抛错时，ensureRuntimeCore 会把它折成日志并保持
    // 「无 runtime」—— 但 shim 已经在监听。不就地关掉，这个端口就无人引用、
    // 永不释放，面板每次重试（重进 factory）再泄一个（审查发现 1）。
    try {
      shim.close();
    } catch (closeError) {
      logger.warn?.(`dsh-model-hub: ${channelId} shim 关闭失败（忽略）`, closeError);
    }
    throw error;
  }

  return {
    shim,
    release: releaseAdapter,
    get models() { return models; },
    get panelEntries() { return panelEntries; },
    async refresh() {
      // 两个起点都要照顾：已上架（换新目录重注册）与空目录起步从未上架
      // （这一步就是首次上架）。漏掉后者 = 面板看得到模型、选择器永远选不到
      // —— P0「看起来成功」的新形态。
      const wasOn = adapterRelease !== undefined;
      const wasEmpty = models.length === 0;
      let next: ChannelModel[];
      try {
        next = await fetchCatalogForHead();
      } catch (error) {
        // 拉不到就保留旧目录继续服务：一次目录抖动不该把在用的模型打散。
        logger.warn?.(`dsh-model-hub: ${channelId} 目录刷新失败，保留旧目录（${models.length} 个模型）`, error);
        return;
      }
      if (next.length === 0) {
        logger.warn?.(`dsh-model-hub: ${channelId} 目录刷新为空，保留旧目录（${models.length} 个模型）`);
        return;
      }
      models = next;
      panelEntries = toPanelEntries(next);
      releaseAdapter();
      if (wasOn || wasEmpty) register();
    },
    setEnabled(enabled: boolean) {
      if (enabled) register();
      else releaseAdapter();
    },
  };
}

/**
 * 造一个「把请求写进记录表」的回调（从 index.ts 的 makeRecorder 迁来并参数化）。
 *
 * 与 index.ts 版本的差别只有两处：enabled 从 settings 现读；account_id 贯通
 * 入库 —— 多账号之后「谁在服务」是记录表要回答的问题。
 */
function makeRecorder(
  db: DatabaseSync,
  channelId: string,
  enabled: () => boolean,
) {
  return (input: {
    metrics: TurnMetrics;
    /** 换号前被淘汰的网络错误尝试没有状态码：缺省（库里落 NULL）。 */
    statusCode?: number;
    error?: string;
    isStreaming: boolean;
    model: string;
    accountId?: string;
  }): void => {
    if (!enabled()) return;
    const { metrics, statusCode, error, isStreaming, model } = input;
    try {
      insertRequest(db, {
        requestId: randomUUID(),
        channelId,
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        provider: channelId,
        model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheRead: metrics.cacheRead,
        cacheWrite: metrics.cacheWrite,
        ...(metrics.firstTokenMs === undefined ? {} : { firstTokenMs: metrics.firstTokenMs }),
        ...(metrics.upstreamHeadMs === undefined ? {} : { upstreamHeadMs: metrics.upstreamHeadMs }),
        ...(metrics.durationMs === undefined ? {} : { durationMs: metrics.durationMs }),
        ...(metrics.decodeTps === undefined ? {} : { decodeTps: metrics.decodeTps }),
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(error === undefined ? {} : { error }),
        isStreaming,
        estimated: metrics.estimated,
        costUnits: 0,
        createdAt: Date.now(),
      });
    } catch {
      /* 观测失败不能影响请求 */
    }
  };
}
