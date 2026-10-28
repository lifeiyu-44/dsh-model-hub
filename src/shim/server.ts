import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TurnTimer, type NormalizedUsage, type TurnMetrics } from "./recorder.js";
import { parseSseLine } from "./upstream.js";
import { ensureSystemHead } from "./prepare.js";

export interface ShimDeps {
  /** 上游地址与请求头，由渠道后端提供。 */
  prepare(): Promise<{ baseUrl: string; headers: Record<string, string> }>;
  /**
   * 可选：协议方言。
   *
   * WorkBuddy 是 OpenAI 兼容直通，不需要它；Qoder 需要两层改写
   * （请求体自定义编码 + 双层 SSE 解包），就通过这个钩子注入。
   * 不给时行为与以前完全一致 —— 现有渠道不受影响。
   */
  dialect?: ShimDialect;
  /** 记录一次完成的请求。抛错不得影响响应。 */
  record(input: {
    metrics: TurnMetrics;
    statusCode: number;
    error?: string;
    isStreaming: boolean;
    model: string;
  }): void;
}

export interface ShimDialect {
  /**
   * 构造最终请求。返回的 `body` 已经是可以直接发出去的字节。
   *
   * 默认实现是 `<baseUrl>/v2/chat/completions` + 原样 body。
   */
  request?(input: {
    raw: string;
    model: string;
    baseUrl: string;
    headers: Record<string, string>;
  }): Promise<{ url: string; headers: Record<string, string>; body: string | Buffer }>;
  /**
   * 把上游的一行 SSE 翻成标准 OpenAI SSE 行；返回 `null` 表示丢弃这一行。
   * 不给就原样透传（当前 WorkBuddy 的行为）。
   */
  decodeLine?(line: string): string | null;
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

      // 方言钩子存在时由它决定 URL / 头 / 请求体（Qoder 要编码请求体并重签名）；
      // 否则维持原行为。
      const built =
        deps.dialect?.request === undefined
          ? { url: `${baseUrl}/v2/chat/completions`, headers: { ...headers, "content-type": "application/json" }, body }
          : await deps.dialect.request({ raw: body, model, baseUrl, headers });

      const upstream = await fetch(built.url, {
        method: "POST",
        headers: built.headers,
        // Buffer 不是合法的 BodyInit（TS 的 DOM 类型不认 Node 的 Buffer），
        // 但运行时 undici 完全接受 Uint8Array —— 转一下即可，不改字节。
        body: typeof built.body === "string" ? built.body : new Uint8Array(built.body),
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
      const decodeLine = deps.dialect?.decodeLine;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        // 有方言解码时**不能**整块透传：上游是双层信封，必须逐行翻成标准 SSE。
        if (!streaming || decodeLine === undefined) res.write(chunk);
        if (!streaming) continue;

        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);

          if (decodeLine === undefined) {
            const parsed = parseSseLine(line);
            if (parsed.text !== undefined) timer.onDelta(parsed.text, Date.now());
            if (parsed.usage !== undefined) usage = parsed.usage;
            nl = buffer.indexOf("\n");
            continue;
          }

          // 方言模式：翻一行、写一行、再从**翻好的**那行里量指标，
          // 这样记录表里的 token/速度与用户看到的完全一致。
          const translated = decodeLine(line);
          if (translated !== null) {
            res.write(`${translated}\n\n`);
            const parsed = parseSseLine(translated);
            if (parsed.text !== undefined) timer.onDelta(parsed.text, Date.now());
            if (parsed.usage !== undefined) usage = parsed.usage;
          }
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
