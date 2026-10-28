import type { DatabaseSync } from "node:sqlite";
import {
  queryAccounts,
  queryChannels,
  queryDiagFacts,
  queryModels,
  queryRequests,
  querySummary,
} from "../store/queries.js";
import type { HubSettings } from "../state/hub-state.js";
import type { PanelEntry } from "../state/runtime.js";

/** 面板数据路由前缀。客户端与这里必须一致。 */
export const DATA_PREFIX = "/plugins/dsh-model-hub";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (LOOPBACK.has(name)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * 只读数据路由。
 *
 * ## 为什么必须这么拿 webServer
 *
 * 在 `apply()` 里直接写 `ctx.webServer` 会抛
 * `cannot get property "webServer" without inject` —— 那是**加载期**异常，
 * 会让整个 host `exit 1`，进而触发 DSH 把 profile 重置为默认
 * （bundles 清空、cordis.patch.yml 被覆盖）。本项目实测踩过两次。
 *
 * 正确写法是 `ctx.inject(["webServer"], (inner) => ...)`：
 * **回调收到的那个 ctx** 才带着 webServer 服务，在外层 ctx 上访问仍然会抛。
 * 这一点由 `tests/webserver-access.spec.ts` 用真实 Cordis 定死。
 *
 * ## 为什么自己加回环校验
 *
 * DSH 的插件路由没有独立鉴权，本机任意进程都能打。记录里有模型名与用量，
 * 不该给非回环来源看。
 */
export function registerDataRoutes(
  ctx: { inject: (deps: string[], cb: (inner: any) => void) => void; effect: any; logger?: any },
  deps: {
    db: DatabaseSync;
    /**
     * 目录快照（模型 id -> 倍率与标记颜色）。
     *
     * 浏览器侧的模型标签槽要画彩色 pill，但客户端只拿到 `model.id`，
     * 并不知道倍率与颜色。所以由 host 把这份映射发过去。
     *
     * 用函数而不是快照值：目录是异步拉的，取的时候要拿最新的一份。
     */
    catalog?: () => {
      id: string;
      name: string;
      creditMultiplier?: number;
      promotionBadge?: string;
      tierBadge?: string;
      promotionColor?: string;
      tierColor?: string;
    }[];
    /**
     * 诊断栏里**只有 host 知道**的那些事实：版本、库文件大小、凭据路径、
     * token 有效期。存储层算不出来的都从这里补（见诊断栏的设计意图：
     * 这一栏存在的唯一理由就是能被整段贴进问题反馈）。
     */
    diag?: () => Record<string, unknown>;
    /**
     * 渠道 → 该渠道面板目录条目（runtime 化之后目录按渠道挂在 state 上）。
     * `/channels` 响应加 `models_by_channel` 键（任务 9 裁定 2）；不注入时
     * 恒为 `{}` —— 旧客户端读到的是空映射而不是 undefined，不用改判空。
     */
    modelsByChannel?: () => Record<string, PanelEntry[]>;
    /**
     * volatile 设置现读，供 `/diag` 补 `recordEnabled`（缺省开）与
     * `retentionDays`（缺省 90）—— 与 config.ts 的默认值一致。形状与
     * HubSettings 相同；getter 每请求现调，改设置即时生效。
     */
    settings?: () => HubSettings;
  },
): void {
  ctx.inject(["webServer"], (inner: any) => {
    try {
      inner.effect(() => {
        const disposers = [
          inner.webServer.register({
            kind: "exact",
            path: `${DATA_PREFIX}/summary`,
            handler: (req: any, res: any) => {
              if (!gate(req, res)) return;
              json(res, 200, querySummary(deps.db));
            },
          }),
          inner.webServer.register({
            kind: "exact",
            path: `${DATA_PREFIX}/catalog`,
            handler: (req: any, res: any) => {
              if (!gate(req, res)) return;
              json(res, 200, { models: deps.catalog?.() ?? [] });
            },
          }),
          inner.webServer.register({
            kind: "exact",
            path: `${DATA_PREFIX}/records`,
            handler: (req: any, res: any) => {
              if (!gate(req, res)) return;
              const url = new URL(req.url ?? "/", "http://localhost");
              const rawLimit = Number(url.searchParams.get("limit") ?? "200");
              const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200;
              const channelId = url.searchParams.get("channel") ?? undefined;
              const model = url.searchParams.get("model") ?? undefined;
              const hours = Number(url.searchParams.get("hours") ?? "");
              const sinceMs = Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3_600_000 : undefined;

              json(res, 200, {
                requests: queryRequests(deps.db, { limit, channelId, model, sinceMs }),
                models: queryModels(deps.db).map((row) => row.model),
              });
            },
          }),
          inner.webServer.register({
            kind: "exact",
            path: `${DATA_PREFIX}/channels`,
            handler: (req: any, res: any) => {
              if (!gate(req, res)) return;
              json(res, 200, {
                channels: queryChannels(deps.db),
                accounts: queryAccounts(deps.db),
                // 纯增量键（裁定 2）：现有 channels/accounts 键原样不动
                models_by_channel: deps.modelsByChannel?.() ?? {},
              });
            },
          }),
          inner.webServer.register({
            kind: "exact",
            path: `${DATA_PREFIX}/diag`,
            handler: (req: any, res: any) => {
              if (!gate(req, res)) return;
              const settings = deps.settings?.();
              json(res, 200, {
                ...queryDiagFacts(deps.db),
                ...(deps.diag?.() ?? {}),
                // 放在展开之后：这两个键以设置为准，不被 diag 覆盖写法影响
                recordEnabled: settings?.recordEnabled !== false,
                retentionDays: settings?.retentionDays ?? 90,
              });
            },
          }),
        ];
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* 卸载期的单个失败不该阻断其它清理 */
            }
          }
        };
      }, "dsh-model-hub: data routes");
    } catch (error) {
      // 路由注册失败只影响面板，绝不能让宿主崩 —— 这是本项目最痛的教训。
      inner.logger?.error?.("dsh-model-hub: 数据路由注册失败（面板不可用，provider 不受影响）", error);
    }
  });
}

/** 回环 + 方法校验。返回 true 表示可以继续处理。 */
function gate(req: any, res: any): boolean {
  if (!hostIsLoopback(req.headers?.host)) {
    json(res, 403, { error: "host_not_allowed" });
    return false;
  }
  const method = String(req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    json(res, 405, { error: "method_not_allowed" });
    return false;
  }
  return true;
}

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
