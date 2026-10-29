/** 上游 usage 的归一化形状（OpenAI 与 Anthropic 都归到这里）。 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TurnMetrics {
  firstTokenMs?: number;
  upstreamHeadMs?: number;
  durationMs?: number;
  decodeTps?: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  estimated: boolean;
}

/** 估算用：约 4 字符 / token。只在拿不到上游 usage 时兜底。 */
const CHARS_PER_TOKEN = 4;

/**
 * 一次请求的计时器。
 *
 * 四个计时点（见设计规格 §5.1）：
 *   t0 请求到达 shim / t1 上游响应头 / t2 首个非空 delta / t3 流结束
 *   TTFT = t2 - t0；upstreamHead = t1 - t0；decodeTps = output / (t3 - t2)
 *
 * 拿不到 usage 时用字符数估算，并置 estimated —— 不猜，但也不留空。
 */
export class TurnTimer {
  #t0: number;
  #t1?: number;
  #t2?: number;
  #chars = 0;

  constructor(startedAt: number) {
    this.#t0 = startedAt;
  }

  onUpstreamHead(at: number): void {
    if (this.#t1 === undefined) this.#t1 = at;
  }

  onDelta(text: string, at: number): void {
    this.#chars += text.length;
    if (this.#t2 === undefined && text.length > 0) this.#t2 = at;
  }

  onEnd(at: number, usage?: NormalizedUsage): TurnMetrics {
    const estimated = usage === undefined;
    const outputTokens = usage?.outputTokens ?? Math.floor(this.#chars / CHARS_PER_TOKEN);
    // **没有首 token 就没有解码窗口**：那时不能说「解码用了整轮时长」——
    // 那会把 TTFT 也算进解码，得到一个看似合理、实则与口径不符的速度。
    // 宁可留空（面板显示 —），也不给一个错数（2026-10-29 修正：
    // 之前退化成 durationMs 当窗口，导致 out=87/3.6s 算成 24 tok/s）。
    const decodeMs = this.#t2 === undefined ? undefined : at - this.#t2;
    return {
      ...(this.#t2 === undefined ? {} : { firstTokenMs: this.#t2 - this.#t0 }),
      ...(this.#t1 === undefined ? {} : { upstreamHeadMs: this.#t1 - this.#t0 }),
      durationMs: at - this.#t0,
      ...(decodeMs === undefined || decodeMs <= 0 ? {} : { decodeTps: outputTokens / (decodeMs / 1000) }),
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      estimated,
    };
  }
}
