import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 被上游拒收的请求快照（诊断用）。
 *
 * ## 为什么需要
 *
 * 上游的 400 只给一句很笼统的话（WorkBuddy 的 `11128 Illegal API invocation
 * from an unapproved channel` 什么都不说明）。而"我们到底发了什么"只有
 * shim 这一层知道 —— 不落盘就只能靠猜。
 *
 * 踩过的具体教训：给模型声明 `reasoning: true` 之后，pi-ai 会用
 * `adjustMaxTokensForThinking` 改写 `max_tokens`，WorkBuddy 随即开始 400。
 * 到底改了哪个字段，只有把请求体拿出来看才知道。
 *
 * ## 纪律
 *
 * - 只保留**最近一次**被拒的请求（覆盖写），不做历史堆积。
 * - **必须脱敏**：`Authorization` / `x-api-key` / `Cookie` 一律不写。
 * - 写失败一律吞掉：诊断能力不能影响请求本身。
 */

export interface RejectedRequest {
  at: number;
  url: string;
  status: number;
  /** 上游返回的正文（截断）。 */
  responseBody: string;
  /** 我们发出去的请求体（截断）。 */
  requestBody: string;
  /** 只保留非敏感的请求头。 */
  headers: Record<string, string>;
  model: string;
  /**
   * 请求体是否被截断。
   *
   * 截断后 `requestBody` 就不是合法 JSON 了 —— 读的人必须知道这一点，
   * 否则会像第一次那样对着半截 JSON 解析失败（实测踩过）。
   */
  requestBodyTruncated?: boolean;
}

const SENSITIVE = /authorization|api-key|cookie|token|secret|cosy-key|cosy-user/i;

export function rejectedRequestPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "model-hub", "last-rejected-request.json");
}

/** 记一次被拒请求。永不抛错。 */
export async function recordRejected(input: RejectedRequest): Promise<void> {
  try {
    const safeHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers)) {
      // Authorization 之类的值整体丢弃；其余保留（Cosy-* 里的 Bodyhash 等不敏感）
      if (SENSITIVE.test(name)) {
        safeHeaders[name] = "<redacted>";
        continue;
      }
      safeHeaders[name] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }

    // 200KB 足够装下一整轮真实请求（实测带完整系统提示的请求约 30–60KB）。
    // 只有极端情况才会截断，那时把 `requestBodyTruncated` 标出来，
    // 免得读的人对着半截 JSON 解析（已经踩过一次）。
    const BODY_LIMIT = 200_000;
    const truncated = input.requestBody.length > BODY_LIMIT;

    const payload: RejectedRequest = {
      ...input,
      headers: safeHeaders,
      responseBody: input.responseBody.slice(0, 8000),
      requestBody: truncated ? input.requestBody.slice(0, BODY_LIMIT) : input.requestBody,
      ...(truncated ? { requestBodyTruncated: true } : {}),
    };

    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = rejectedRequestPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* 诊断写入失败不能影响请求 */
  }
}

/** 读最近一次被拒请求；没有就返回 undefined。 */
export function readRejected(): RejectedRequest | undefined {
  try {
    return JSON.parse(readFileSync(rejectedRequestPath(), "utf8")) as RejectedRequest;
  } catch {
    return undefined;
  }
}
