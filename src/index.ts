import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { Config, readSetting } from "./config.js";
import { HUB_DB_NAME, HUB_DIR_NAME, PROVIDER_PREFIX } from "./constants.js";
import { openHubDatabase } from "./store/db.js";
import { seedChannelsAndAccounts } from "./store/seed.js";
import { pruneRequests } from "./store/retention.js";
import { detectCredential, parseAuthDocument } from "./channels/workbuddy/auth.js";
import { readWorkbuddyVault, vaultIdentityOf } from "./channels/workbuddy/vault.js";
import { realDecryptAuthFile } from "./channels/workbuddy/at-rest.js";
import { writeWorkbuddyTokenFile } from "./channels/workbuddy/token-store.js";
import { createSessionManager } from "./channels/qoder/credentials.js";
import { createHubState } from "./state/hub-state.js";
import {
  startChannelRuntime,
  type ChannelRuntimeInput,
  type RegisterReportContext,
  type RuntimeHandle,
} from "./state/runtime.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerWriteRoutes } from "./routes/write.js";

export const name = "dsh-model-hub";
export { Config };
export const inject = ["llm"];

/**
 * 面板诊断栏显示的版本号。
 *
 * 与 `package.json` 的 `version` 必须一致 —— 单测 `tests/diag.spec.ts` 守着这条，
 * 因为它是最容易忘记同步的一处（发布时改了 package.json 忘了改这里，
 * 用户报障时看到的版本就是错的）。
 */
export const PLUGIN_VERSION = "0.1.0";

/** 数据库文件字节数；文件还不存在（首次启动）时返回 null，不返回 0。 */
function fileSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

const PROVIDER_GLOBAL = `${PROVIDER_PREFIX}workbuddy-global`;
/** Qoder CN 渠道的 provider id。 */
const PROVIDER_QODER = `${PROVIDER_PREFIX}qoder-cn`;

/** 保留清理周期（24h）；每次触发现读最新的 `settings.retentionDays`。 */
const RETENTION_INTERVAL_MS = 24 * 3_600_000;

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

/**
 * 装配层：本文件只负责「把零件按顺序拧起来」，不再有业务逻辑 ——
 * 渠道 runtime 在 `state/runtime.ts`，状态机在 `state/hub-state.ts`，
 * 读写路由在 `routes/`，探测在 `probe/prober.ts`。
 */
function applyInner(ctx: any, config: any): void {
  // config 本身也可能是根引用（volatileEntries 支持 root ref），一并解引用；
  // 解出来再 ?? {} 兜底「没传 config」的情况。
  const settings = readSetting(config) ?? {};
  if (readSetting(settings.enabled) === false) return;

  const dbPath = join(resolveDshHome(), HUB_DIR_NAME, HUB_DB_NAME);

  void (async () => {
    // ── 1. 开库（失败只关记录，provider 不受影响）──
    let db: Awaited<ReturnType<typeof openHubDatabase>>;
    try {
      db = await openHubDatabase(dbPath);
    } catch (error) {
      ctx.logger?.error?.("dsh-model-hub: 数据库打开失败，记录功能关闭（provider 不受影响）", error);
      return;
    }

    // ── 2. HubState 状态中心 ──
    //
    // runtimeFactory 闭包补上 ChannelRuntimeInput 没有的两样：宿主 ctx 与
    // 注册结果回报。registerAdapter 不在这里传 —— 生产实现（原 registerProvider，
    // 迁往 runtime.ts 的 createRegisterAdapter）要把 shim 地址/密钥绑进 adapter，
    // 而 shim 在 startChannelRuntime 内部才建好，只能由它做缺省注入。
    let workbuddyShimUrl: string | undefined; // 诊断栏「shim 地址」键的现状来源
    const state = createHubState({
      db,
      settings: () => ({ recordEnabled: readSetting(settings.recordEnabled) !== false, retentionDays: readSetting(settings.retentionDays) }),
      logger: ctx.logger,
      runtimeFactory: async (input: ChannelRuntimeInput): Promise<RuntimeHandle> => {
        const handle = await startChannelRuntime({
          ...input,
          ctx,
          ...(input.channelId === PROVIDER_GLOBAL
            ? {
                // status.json 语义保留：仍只记 WorkBuddy 全局渠道的注册结局
                // （deploy.ps1 的自检读这份文件，Qoder 的注册不改写它）。
                onRegisterReport: (outcome: RegisterReportContext) => writeStatus(ctx, outcome),
              }
            : {}),
        });
        if (input.channelId === PROVIDER_GLOBAL) workbuddyShimUrl = handle.shim.baseUrl();
        return handle;
      },
    });

    // ── 3a. WorkBuddy：凭据发现（文案保留）→ seed → ensureRuntime ──
    //
    // 凭据来源按顺序试：
    //   1. 桌面端 auth 文件里的**明文** token（旧版桌面端才这样）
    //   2. 桌面端 auth 文件里的**加密信封** → 内置解密（向已安装的 WorkBuddy
    //      App 要密钥，MODEL HUB 自己解，不再依赖 dsh-connect-workbuddy）；
    //      解出的明文 token 落到我们自己的 workbuddy-tokens/<uid>.json（0600）
    //   3. dsh-connect-workbuddy 已解好的 vault（历史来源，只读复用）
    // 三条都拿不到就如实报缺，不假装成功。
    const fromFile = detectCredential();
    const plainFromFile =
      fromFile !== undefined && fromFile.parsed.kind === "plain" && fromFile.parsed.token !== undefined
        ? { source: fromFile.path, parsed: fromFile.parsed }
        : undefined;
    let decryptedFromFile: { source: string; parsed: ReturnType<typeof parseAuthDocument> & { token: string } } | undefined;
    if (plainFromFile === undefined && fromFile !== undefined && fromFile.parsed.kind === "encrypted") {
      try {
        const decrypted = await realDecryptAuthFile(fromFile.path);
        const tokenPath = writeWorkbuddyTokenFile(resolveDshHome(), {
          accountUid: decrypted.accountUid ?? "unknown-workbuddy-account",
          accessToken: decrypted.accessToken,
          ...(decrypted.refreshToken === undefined ? {} : { refreshToken: decrypted.refreshToken }),
          ...(decrypted.nickname === undefined ? {} : { nickname: decrypted.nickname }),
          region: decrypted.region,
          ...(decrypted.expiresAtMs === undefined ? {} : { expiresAtMs: decrypted.expiresAtMs }),
        });
        decryptedFromFile = {
          source: tokenPath,
          parsed: {
            kind: "plain",
            region: decrypted.region,
            token: decrypted.accessToken,
            ...(decrypted.refreshToken === undefined ? {} : { refreshToken: decrypted.refreshToken }),
            ...(decrypted.expiresAtMs === undefined ? {} : { expiresAtMs: decrypted.expiresAtMs }),
          },
        };
        ctx.logger?.info?.(
          `dsh-model-hub: 桌面端加密凭据已用内置解密接管（${fromFile.path}）→ ${tokenPath}`,
        );
      } catch (error) {
        ctx.logger?.warn?.("dsh-model-hub: 桌面端加密凭据内置解密失败，回落到 vault", error);
      }
    }
    const fromVault =
      plainFromFile === undefined && decryptedFromFile === undefined ? readWorkbuddyVault() : undefined;
    const credential = plainFromFile ?? decryptedFromFile ?? fromVault;

    if (credential === undefined) {
      const why = fromFile === undefined
        ? "没有找到任何 WorkBuddy 登录文件"
        : fromFile.parsed.kind === "encrypted"
          ? `桌面端凭据是加密信封（${fromFile.path}），且没有可复用的 vault`
          : `凭据不可用（${fromFile.path}，状态 ${fromFile.parsed.kind}）`;
      ctx.logger?.warn?.(
        `dsh-model-hub: 未找到可用的 WorkBuddy token —— ${why}。请先装 WorkBuddy 桌面端登录一次，或装 dsh-connect-workbuddy 让它解一次。渠道不注册。`,
      );
      // 与旧版「直接 return」的差别：缺凭据只跳过这一个渠道。面板与写路由
      // 照常起，账号可以稍后经面板「一键认证」补上 —— 那正是账号管理的入口。
    } else {
      ctx.logger?.info?.(`dsh-model-hub: 凭据来源 = ${credential.source}（${credential.parsed.region ?? "global"}）`);
    }

    if (credential !== undefined) {
      // 显示名用真实身份：vault json 的 account.nickname（明文才有）→ uid 前缀 →
      // 通用默认名。换号/多账号时面板一眼可辨，不再是一排「WorkBuddy 主账号」。
      // 读不到就退回默认名，不影响凭据本身。
      let wbDisplayName = "WorkBuddy 主账号";
      try {
        const identity = vaultIdentityOf(JSON.parse(readFileSync(credential.source, "utf8")) as Record<string, unknown>);
        wbDisplayName =
          identity.nickname ?? (identity.uid !== undefined ? `WB · ${identity.uid.slice(0, 8)}` : wbDisplayName);
      } catch {
        /* 身份读不到就退回默认名 */
      }
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
              displayName: wbDisplayName,
              credentialRef: credential.source, // 凭据只存引用，绝不落明文
              isCurrent: true,
            },
          ],
        );
      } catch (error) {
        ctx.logger?.warn?.("dsh-model-hub: 渠道/账号登记失败（面板可能显示为空，provider 不受影响）", error);
      }
      // runtime（shim + 拉目录 + 上架 adapter）由 state 统一建：目录/凭据问题
      // 在 hub-state 里折成 error 日志并保持「无 runtime」，不会炸这里。
      // 池空（用户删光/停光所有账号）是用户自己的选择，不算部署事故：
      // 跳过 ensureRuntime，也**不写** status.json ok:false —— 写了反而让
      // deploy.ps1 的自检把一次正常的使用状态误报成部署失败（终审 M2）。
      if (state.poolSize(PROVIDER_GLOBAL) > 0) {
        await state.ensureRuntime(PROVIDER_GLOBAL);
        if (workbuddyShimUrl === undefined) {
          // 有凭据但 runtime 没起来：必须留一份 ok:false 的 status.json。
          // deploy.ps1 对「文件缺失」按『可能没有凭据』放行，而旧代码同场景
          // 会写 ok:false 让部署自检当场抛错 —— P0 建立的自检不能在它针对的
          // 场景里静默假通过（审查发现 2）。workbuddyShimUrl 由 runtimeFactory
          // 闭包在 factory 成功返回时设置：seed 刚成功（渠道在、池非空），
          // 它是 undefined 就只能是 factory 失败，信号可靠。
          await writeStatus(ctx, {
            ok: false,
            provider: PROVIDER_GLOBAL,
            modelCount: 0,
            modelIds: [],
            catalogCount: 0,
            error: "WorkBuddy runtime 启动失败（目录拉取或凭据现读失败，详见插件日志）",
          });
        }
      } else {
        ctx.logger?.warn?.(
          "dsh-model-hub: WorkBuddy 渠道没有可用账号（已被删除或停用），跳过 runtime —— 面板可重新添加",
        );
      }
    }

    // ── 3b. Qoder CN 渠道（同构；缺 PAT 照旧 warn + 跳过）──
    //
    // 也是过一层 shim（请求同样进记录表），差别只在 shim 带了 Qoder 方言：
    // 请求体自定义编码 + 双层 SSE 解包。协议细节在 runtime.ts / channels/qoder。
    // Qoder 的任何问题都不得拖垮 WorkBuddy。
    try {
      const sessions = createSessionManager();
      const qoderSession = await sessions.current();
      if (qoderSession === undefined) {
        // 没有 legacy 可见的 PAT ≠ 渠道必死：用户可能只经面板贴过 PAT
        // （credential_ref 指向 qoder-pats/*.pat，legacy 扫描看不见它们）。
        // 池非空就照常 ensureRuntime —— runtime 的 patOf 按各账号的
        // credential_ref 现读文件，不依赖这里的会话探针（终审 C1：旧代码
        // 此时直接跳过，渠道重启即失联，而一键认证对 Qoder 只验活不登记，
        // 用户没有任何入口能救回）。只有池也空（真没有账号）才发原 warn。
        if (state.poolSize(PROVIDER_QODER) > 0) {
          await state.ensureRuntime(PROVIDER_QODER);
        } else {
          ctx.logger?.warn?.(
            "dsh-model-hub: 未找到 Qoder PAT（~/.dsh/qoder/pat 或 QODERCN_PAT），Qoder 渠道不注册",
          );
        }
      } else {
        ctx.logger?.info?.(`dsh-model-hub: Qoder 凭据 ${qoderSession.source}（uid ${qoderSession.userID.slice(0, 8)}…）`);
        // 与 WorkBuddy 相同的两步：登记（只存引用）→ ensureRuntime。
        // 目录拉取失败时 hub-state 保持「无 runtime」，账号留在面板里可测试/重试。
        seedChannelsAndAccounts(
          db,
          [{ id: PROVIDER_QODER, kind: "qoder", displayName: "Qoder CN" }],
          [
            {
              id: `${PROVIDER_QODER}:default`,
              channelId: PROVIDER_QODER,
              // 显示名用 userinfo 的真名/邮箱：换号重启后一眼可辨（seed 的
              // DO UPDATE 会把旧占位名刷新成当前身份）。
              displayName: qoderSession.name || qoderSession.email || "Qoder CN 账号",
              credentialRef: qoderSession.source,
              isCurrent: true,
            },
          ],
        );
        await state.ensureRuntime(PROVIDER_QODER);
      }
    } catch (error) {
      ctx.logger?.warn?.("dsh-model-hub: Qoder 渠道初始化失败（WorkBuddy 不受影响）", error);
    }

    // ── 4. 保留清理：启动跑一次 + 每 24h（每次现读最新设置）──
    try {
      const removed = pruneRequests(db, readSetting(settings.retentionDays) ?? 90);
      if (removed > 0) {
        ctx.logger?.info?.(`dsh-model-hub: 启动清理删除 ${removed} 条过期明细（保留 ${readSetting(settings.retentionDays) ?? 90} 天）`);
      }
    } catch (error) {
      ctx.logger?.warn?.("dsh-model-hub: 启动保留清理失败（不影响插件）", error);
    }
    const retentionTimer = setInterval(() => {
      try {
        const removed = pruneRequests(db, readSetting(settings.retentionDays) ?? 90);
        if (removed > 0) {
          ctx.logger?.info?.(`dsh-model-hub: 定时清理删除 ${removed} 条过期明细（保留 ${readSetting(settings.retentionDays) ?? 90} 天）`);
        }
      } catch (error) {
        // 定时器回调里的异常是 uncaughtException，会炸宿主 —— 必须就地吞掉
        ctx.logger?.warn?.("dsh-model-hub: 定时保留清理失败（下个周期重试）", error);
      }
    }, RETENTION_INTERVAL_MS);
    retentionTimer.unref(); // 纯周期任务，不该阻止宿主进程退出

    // ── 5. teardown：资源已存在就先挂清理（早于路由注册，注册失败也不泄漏）──
    //
    // 清理清单统一由 state.dispose 给出（release adapter → shim.close → db.close，
    // 逐项吞错）；这里只补保留清理的定时器。
    ctx.effect(() => () => {
      clearInterval(retentionTimer);
      return state.dispose();
    }, "dsh-model-hub: teardown");

    // ── 6. 面板数据路由 ──
    //
    // 教训：`ctx.webServer` 的属性访问由插件的**静态** `inject` 数组把关 ——
    // 但正确写法不是把它加进静态 inject，而是走 `ctx.inject(["webServer"], cb)`，
    // **回调收到的那个 ctx** 才带着 webServer。在外层 ctx 上直接摸仍会抛
    // `cannot get property "webServer" without inject`，那是加载期异常，
    // 会让整个 host `exit 1`，进而触发 DSH 把 profile 重置为默认
    // （bundles 清空、cordis.patch.yml 被覆盖）—— 实测踩过两次。
    // 两种写法的差异由 tests/webserver-access.spec.ts 用真实 Cordis 定死。
    registerDataRoutes(ctx, {
      db,
      // /catalog 的合并目录（键与顺序不变）：目录 runtime 化后按渠道挂在
      // state 上，这里拍平 —— panelCatalog 的手工拼接就此退役。
      catalog: () => Object.values(state.panelModelsByChannel()).flat(),
      // /channels 新增 models_by_channel（任务 10 的渠道展开要用）
      modelsByChannel: () => state.panelModelsByChannel(),
      // /diag 新增 recordEnabled/retentionDays，与写路由的保留天数同源
      settings: () => ({ recordEnabled: readSetting(settings.recordEnabled), retentionDays: readSetting(settings.retentionDays) }),
      // 诊断栏里只有 host 知道的事实。全部来自本次启动的实测值，
      // 不是写死的字符串 —— 面板上写假值比不写更糟。
      diag: () => ({
        pluginVersion: PLUGIN_VERSION,
        dbPath,
        dbSizeBytes: fileSizeOrNull(dbPath),
        ...(credential === undefined
          ? {}
          : {
              credentialPath: credential.source,
              tokenExpiresAt: credential.parsed.expiresAtMs ?? null,
              region: credential.parsed.region ?? null,
            }),
        ...(workbuddyShimUrl === undefined ? {} : { shimUrl: workbuddyShimUrl }),
        modelCount: Object.values(state.panelModelsByChannel()).reduce((n, entries) => n + entries.length, 0),
      }),
    });

    // ── 7. 写路由（门禁与九个操作在 routes/write.ts）──
    registerWriteRoutes(ctx, {
      state,
      db,
      proberDeps: { decryptAuthFile: realDecryptAuthFile }, // 生产：内置解密启用；fetch/exchangePat/dshHome 用缺省实现
      retentionDays: () => readSetting(settings.retentionDays) ?? 90,
    });

    ctx.logger?.info?.(
      `dsh-model-hub: 装配完成 —— runtime 渠道 [${Object.keys(state.panelModelsByChannel()).join("、") || "无"}]` +
        (workbuddyShimUrl === undefined ? "" : `，workbuddy shim=${workbuddyShimUrl}`),
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
