import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TurnTimer, type NormalizedUsage, type TurnMetrics } from "./recorder.js";
import { parseSseLine } from "./upstream.js";
import { ensureSystemHead } from "./prepare.js";

export interface ShimDeps {
  /** 上游地址与请求头，由渠道后端提供。 */
  prepare(): Promise<{ baseUrl: string; headers: Record<string, string> }>;
  /** 记录一次完成的请求。抛错不得影响响应。 */
  record(input: {
    metrics: TurnMetrics;
    statusCode: number;
    error?: string;
    isStreaming: boolean;
    model: string;
  }): void;
}

export interface ShimHandle {
  baseUrl(): string;
  /**
   * 本次进程内生成的 Bearer 密钥。
   *
   * **必须把真值交出去**：pi-ai 侧的 `resolveApiKey` 拿到的就是这个字符串，
   * 它会被塞进 `Authorization: Bearer <它>` 发回 shim 自己。
   * 早先这里没暴露，`resolveApiKey` 只好返回字面量 `"shim"` ——
   * 于是**每一个真实请求都会被自己的 shim 以 401 拒掉**，
   * 而单测全绿（因为测试直接拿这个密钥发请求，绕过了 pi-ai 那一侧）。
   */
  token(): string;
  close(): void;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (LOOPBACK.has(name)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    return hostIsLoopback(new URL(origin).host);
  } catch {
    return false;
  }
}

/**
 * 起一个只监听回环的 OpenAI 兼容 shim。
 *
 * 三重门：Host 必须回环、Origin 必须回环、Bearer 必须是本次进程内生成的随机值
 * 并用 timingSafeEqual 常数时间比对。真实上游 token 从不交给 pi-ai。
 */
export async function startShim(deps: ShimDeps): Promise<ShimHandle> {
  const secret = randomBytes(32).toString("base64url");
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostIsLoopback(req.headers.host)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "host_not_allowed" }));
      return;
    }
    if (!originIsLoopback(req.headers.origin)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }
    const header = req.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const t0 = Date.now();
    const timer = new TurnTimer(t0);
    let statusCode = 502;
    let error: string | undefined;
    let usage: NormalizedUsage | undefined;
    let streaming = false;
    let model = "unknown";

    try {
      const raw = await readBody(req);
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed["model"] === "string") model = parsed["model"];
      } catch {
        /* 请求体不是 JSON 就照原样转发，模型名留 unknown */
      }

      // 国际网关拒收首条不是 system 的请求（400 / 11128）。补头必须在
      // shim 这一层做 —— 这是最后一个能看到并改写请求体的地方。
      const body = ensureSystemHead(raw);

      const { baseUrl, headers } = await deps.prepare();
      const upstream = await fetch(`${baseUrl}/v2/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      });
      timer.onUpstreamHead(Date.now());
      statusCode = upstream.status;

      if (!upstream.ok) {
        error = `upstream HTTP ${upstream.status}`;
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(await upstream.text());
        return;
      }

      const contentType = upstream.headers.get("content-type") ?? "";
      streaming = contentType.includes("text/event-stream");
      res.writeHead(200, {
        "content-type": contentType || "application/json",
        ...(streaming ? { "cache-control": "no-cache", connection: "keep-alive" } : {}),
      });

      if (!upstream.body) {
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        if (!streaming) continue;
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const parsed = parseSseLine(line);
          if (parsed.text !== undefined) timer.onDelta(parsed.text, Date.now());
          if (parsed.usage !== undefined) usage = parsed.usage;
          nl = buffer.indexOf("\n");
        }
      }
      res.end();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "shim_failed" }));
      }
    } finally {
      try {
        deps.record({
          metrics: timer.onEnd(Date.now(), usage),
          statusCode,
          ...(error === undefined ? {} : { error }),
          isStreaming: streaming,
          model,
        });
      } catch {
        /* 观测失败不能拖垮请求 */
      }
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("shim has no listening address");

  return {
    baseUrl: () => `http://127.0.0.1:${address.port}`,
    token: () => secret,
    close: () => server.close(),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
