import type { Context } from "@deepseek-ai/cordis";

export const RECORDS_PATH = "/plugins/dsh-model-hub/records";

/**
 * `webServer` 是宿主注入的服务，不在 cordis 的 `Context` 类型里 ——
 * 与 dsh-connect / dsh-connect-workbuddy 的做法一致，这里收窄成一个局部接口，
 * 而不是把整个 ctx 标成 any。
 */
interface WebServerContext extends Context {
  webServer: {
    register(entry: { kind: "exact"; path: string; handler: (req: any, res: any) => void }): () => void;
  };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (LOOPBACK.has(name)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * 只读路由：最近 N 条记录 + 最近 30 天聚合。
 *
 * DSH 的插件路由没有独立鉴权（本机任意进程都能打），所以这里自己加一道
 * 回环校验。只读路由也校验 —— 请求记录里含模型名与用量，不该给外网看。
 *
 * ⚠️ 调用方必须先用 `ctx.inject(["webServer"], ...)` 拿到可用的 ctx 再调这里。
 * 本插件的 `inject` 只声明了 `llm`；直接摸 `ctx.webServer` 会抛
 * 「cannot get property "webServer" without inject」，而加载期抛出会让整个
 * host fatal 退出（实测踩过，会把 profile 打回默认）。
 */
export function registerRecordsRoute(ctx: WebServerContext, deps: { query(limit: number): unknown }): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: RECORDS_PATH,
      handler: (req: any, res: any) => {
        if (!hostIsLoopback(req.headers.host)) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "host_not_allowed" }));
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const raw = Number(url.searchParams.get("limit") ?? "50");
        const limit = Math.min(Number.isFinite(raw) && raw > 0 ? raw : 50, 500);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(deps.query(limit)));
      },
    });
    return () => dispose();
  }, "dsh-model-hub: records route");
}
