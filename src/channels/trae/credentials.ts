import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decryptEnvelopeBase64, isTraeEnvelope, jwtExpiryMs } from "./crypto.js";

/**
 * Trae（SOLO / SOLO CN）凭据的**发现**与**自有缓存**。
 *
 * 两条来源，优先级固定：
 *
 * 1. **本机 Trae 客户端**（首选）：`User/globalStorage/storage.json` 里
 *    `iCubeAuthInfo://icube.cloudide` 那一项，是 byteCrypto 信封，解出来就是
 *    当前登录态（token / refreshToken / userId / account / host / userRegion）。
 *    这是「装了 Trae 就能用」的那条路 —— 用户不用导任何东西。
 * 2. **`$DSH_HOME/connect-auth/trae.json`**（兼容）：dsh-connect 时代的明文快照，
 *    字段是 `{token, refreshToken, userId, gateway, appVersionCode, deviceId,
 *    account:{username}}`。已经贴过凭据的机器继续可用。
 *
 * 发现成功后把明文**落到我们自己的目录**：`$DSH_HOME/model-hub/trae-tokens/
 * <sha256(uid)[:12]>.json`（0600），和 WorkBuddy 的 token-store 同一口径 ——
 * credential_ref 只指向这个文件，运行时按它现读，既不吃别的插件的目录，
 * 也不把 token 写进数据库。
 *
 * 网关与产品常量：
 * - `gateway` 是**推理**网关（`/api/agent/v3/llm_utils_chat`）。国际版按账号
 *   的 `userRegion.region` 取 `bootConfig.agent` 里对应的那条；CN 版就是
 *   `trae-api-cn.mchost.guru`。
 * - `appId` / `appVersionCode` 是**产品级**常量（product.json 的
 *   `bootConfig.agent.appId` 与 `buildId`），不是账号级。appVersionCode 还兼作
 *   请求头 `x-ide-version-code` 的取值 —— 用小值会被上游**静默降级**。
 */

/** 产品级 appId（product.json 的 bootConfig.agent.appId）。 */
export const TRAE_DEFAULT_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
/**
 * 产品级 buildId（product.json）。
 *
 * 2026-11-05 实测在 TRAE SOLO 1.107.1 上取自 product.json；作为「读不到
 * 安装目录」时的兜底。写错不会报错，只会让 `x-ide-version-code` 被降级。
 */
export const TRAE_DEFAULT_APP_VERSION_CODE = 1205510027010;

/**
 * 版本号是从哪来的。
 *
 * 上游把 `x-ide-version-code` 当**配置注册表的筛选键**：取值不对不会报错，
 * 只会静默降级或回 4120。所以「用的是真实 buildId 还是兜底常量」必须能
 * 一路带到错误文案里 —— 否则用户只看到一句 4120，不知道该去改 TRAE_HOME。
 */
export type TraeVersionSource = "credential" | "product" | "fallback";

/** 读不到 product.json 时的统一提示（日志、错误文案、诊断都用它）。 */
export const TRAE_VERSION_FALLBACK_HINT =
  `当前用的是内置兜底 buildId ${TRAE_DEFAULT_APP_VERSION_CODE}（Trae 1.107.1 实测值）。` +
  "没找到本机 Trae 安装目录里的 resources/app/product.json —— 把环境变量 TRAE_HOME 指向 Trae 安装目录后重启 DSH，" +
  "或把 Trae 装到默认位置（%LOCALAPPDATA%\\Programs\\TRAE SOLO / Program Files\\TRAE SOLO）再点「一键认证」。";

/** 版本号与来源的展示文案（错误提示、账号测试、启动日志共用一处口径）。 */
export function describeTraeVersion(input: {
  appVersionCode: number;
  appVersionSource?: TraeVersionSource;
  productPath?: string;
}): { code: number; source: TraeVersionSource; text: string } {
  const source: TraeVersionSource = input.appVersionSource ?? "credential";
  const sourceText =
    source === "product"
      ? input.productPath !== undefined
        ? `来自 product.json（${input.productPath}）`
        : "来自 product.json"
      : source === "fallback"
        ? "内置兜底（没读到 product.json）"
        : "来自凭据文件";
  return {
    code: input.appVersionCode,
    source,
    text: `build ${input.appVersionCode}，${sourceText}`,
  };
}

/** 推理网关的区域表（与 product.json 的 bootConfig.agent 同形）。 */
export const TRAE_DEFAULT_GATEWAYS: Record<string, string> = {
  normal: "https://core-normal.trae.ai",
  SG: "https://coresg-normal.trae.ai",
  US: "https://coreva-normal.trae.ai",
  USTTP: "https://core-normal.traeapi.us",
};

/** CN 版历史网关（dsh-connect 时代的默认值，继续兼容它的快照）。 */
const TRAE_CN_GATEWAY = "https://trae-api-cn.mchost.guru";

export interface TraeCredential {
  token: string;
  refreshToken?: string;
  /** 账号唯一身份；账号行按它去重。 */
  userId: string;
  /** 展示名（Trae 的 `account.username`，形如 `付庆贺` / `用户7381384633`）。 */
  name: string;
  email?: string;
  /** 推理网关。 */
  gateway: string;
  appId: string;
  appVersionCode: number;
  /** 版本号来源：凭据文件 / product.json / 内置兜底。 */
  appVersionSource?: TraeVersionSource;
  /** 读到的 product.json 路径（来源为 product 时有值）。 */
  productPath?: string;
  /** token 过期时间（毫秒）；JWT 里读不到就不带。 */
  expiresAtMs?: number;
  /** 账号区域（US / SG / USTTP …），只用于诊断展示。 */
  region?: string;
  /** 凭据来源（文件路径；日志与面板只显示它，不显示 token）。 */
  source: string;
}

/** 本机 Trae 客户端的登录态（发现结果）。 */
export interface TraeLocalSession {
  /** `User/globalStorage/storage.json` 路径。 */
  storagePath: string;
  /** `User/globalStorage/state.vscdb` 路径（模型目录从这里读）。 */
  stateDbPath: string;
  credential: TraeCredential;
}

interface ProductInfo {
  appId?: string;
  appVersionCode?: number;
  gateways?: Record<string, string>;
  /** 命中的 product.json 路径（诊断与错误提示要指给用户看）。 */
  sourcePath?: string;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Trae 用户数据目录的候选位置。
 *
 * 顺序即优先级：同名的多个产品线（SOLO / SOLO CN）可能同时装着，取第一个
 * 真的有 `storage.json` 的。
 *
 * `TRAE_USER_DATA` 一旦设置就是**排他**的：只找它，不再扫默认位置。
 * 这条语义是给绿色版/测试用的 —— 否则「指定一个空目录」根本表达不出来。
 */
export function traeUserDataRoots(): string[] {
  const override = process.env.TRAE_USER_DATA?.trim();
  if (override !== undefined && override !== "") return [override];

  const roots: string[] = [];
  const appData = process.env.APPDATA;
  if (appData !== undefined && appData !== "") {
    for (const name of ["TRAE SOLO", "TRAE SOLO CN", "Trae", "Trae CN", "Trae Solo"]) {
      roots.push(join(appData, name));
    }
  }
  const home = homedir();
  roots.push(join(home, "Library", "Application Support", "TRAE SOLO"));
  roots.push(join(home, "Library", "Application Support", "TRAE SOLO CN"));
  roots.push(join(home, ".config", "TRAE SOLO"));
  return roots;
}

/** Trae 安装目录的候选位置（读 product.json 用）。 */
function traeInstallRoots(): string[] {
  const roots: string[] = [];
  const env = process.env.TRAE_HOME?.trim();
  // TRAE_HOME 一旦设置就是**排他**的：只读它。这样「指定一个没有 product.json
  // 的目录」才表达得出来（测试、绿色版、装在非常规位置时都用它），也避免
  // 用户在 A 盘的 Trae 被 D 盘残留的同名目录抢走版本号。
  if (env !== undefined && env !== "") return [env];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData !== "") roots.push(join(localAppData, "Programs", "TRAE SOLO"));
  const programFiles = process.env.ProgramFiles;
  if (programFiles !== undefined && programFiles !== "") roots.push(join(programFiles, "TRAE SOLO"));
  roots.push("C:\\TRAE SOLO", "D:\\TRAE SOLO");
  roots.push("/Applications/TRAE SOLO.app/Contents/Resources/app");
  return roots;
}

/** 读 product.json：appId / buildId / 区域网关表。读不到就都返回 undefined。 */
export function readTraeProductInfo(): ProductInfo {
  for (const root of traeInstallRoots()) {
    for (const path of [join(root, "resources", "app", "product.json"), join(root, "product.json")]) {
      const doc = readJsonFile(path);
      if (doc === undefined) continue;
      const boot = doc["bootConfig"];
      const agent = typeof boot === "object" && boot !== null ? (boot as Record<string, unknown>)["agent"] : undefined;
      const info: ProductInfo = { sourcePath: path };
      if (typeof agent === "object" && agent !== null) {
        const record = agent as Record<string, unknown>;
        const appId = str(record["appId"]);
        if (appId !== undefined) info.appId = appId;
        const gateways: Record<string, string> = {};
        for (const key of ["normal", "SG", "US", "USTTP"]) {
          const entry = record[key];
          const url = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null ? str((entry as Record<string, unknown>)["normal"]) : undefined;
          if (url !== undefined && url.startsWith("http")) gateways[key] = url;
        }
        if (Object.keys(gateways).length > 0) info.gateways = gateways;
      }
      const buildId = num(doc["buildId"]);
      if (buildId !== undefined) info.appVersionCode = buildId;
      return info;
    }
  }
  return {};
}

/** 按区域挑推理网关：区域缺失时用 normal。 */
function gatewayFor(region: string | undefined, product: ProductInfo): string {
  const table = { ...TRAE_DEFAULT_GATEWAYS, ...(product.gateways ?? {}) };
  if (region !== undefined && region !== "") {
    const exact = table[region];
    if (exact !== undefined) return exact;
    const upper = region.toUpperCase();
    for (const key of Object.keys(table)) {
      if (key.toUpperCase() === upper) return table[key]!;
    }
  }
  return table["normal"] ?? TRAE_CN_GATEWAY;
}

/**
 * 从 storage.json 里挑出登录态并解开。
 *
 * 优先 `icube.cloudide`（token 所在），其次遍历所有 `iCubeAuthInfo://` 项 ——
 * 后者是为了兼容不同产品线换过 key 的情况：解出来带 `token` 字符串的就是它。
 */
export function readTraeSessionFromStorage(storagePath: string): { credential?: Omit<TraeCredential, "source">; error?: string } {
  const storage = readJsonFile(storagePath);
  if (storage === undefined) return { error: `读不到 ${storagePath}` };
  const preferred = "iCubeAuthInfo://icube.cloudide";
  const keys = [
    preferred,
    ...Object.keys(storage).filter((key) => key.startsWith("iCubeAuthInfo://") && key !== preferred),
  ];
  const failures: string[] = [];
  for (const key of keys) {
    const value = storage[key];
    if (typeof value !== "string" || value === "") continue;
    let text: string;
    try {
      if (!isTraeEnvelope(Buffer.from(value, "base64"))) continue;
      text = decryptEnvelopeBase64(value);
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const token = str(doc["token"]);
    if (token === undefined) continue;

    const product = readTraeProductInfo();
    const account = typeof doc["account"] === "object" && doc["account"] !== null ? (doc["account"] as Record<string, unknown>) : {};
    const regionInfo = typeof doc["userRegion"] === "object" && doc["userRegion"] !== null ? (doc["userRegion"] as Record<string, unknown>) : {};
    const region = str(regionInfo["region"]) ?? str(account["storeRegion"]) ?? undefined;
    const expiresAtMs =
      jwtExpiryMs(token) ??
      (typeof doc["expiredAt"] === "string" ? Date.parse(doc["expiredAt"]) : undefined);
    const userId = str(doc["userId"]) ?? "";
    return {
      credential: {
        token,
        ...(str(doc["refreshToken"]) === undefined ? {} : { refreshToken: str(doc["refreshToken"]) }),
        userId,
        name: str(account["username"]) ?? userId.slice(0, 8) ?? "Trae 账号",
        ...(str(account["email"]) === undefined ? {} : { email: str(account["email"]) }),
        gateway: gatewayFor(region, product),
        appId: product.appId ?? TRAE_DEFAULT_APP_ID,
        appVersionCode: product.appVersionCode ?? TRAE_DEFAULT_APP_VERSION_CODE,
        appVersionSource: product.appVersionCode === undefined ? "fallback" : "product",
        ...(product.sourcePath === undefined ? {} : { productPath: product.sourcePath }),
        ...(expiresAtMs === undefined || Number.isNaN(expiresAtMs) ? {} : { expiresAtMs }),
        ...(region === undefined ? {} : { region }),
      },
    };
  }
  return failures.length > 0
    ? { error: `Trae 登录态解不开（${failures[0]}）` }
    : { error: "Trae 登录态里没有找到 token（可能没登录过）" };
}

/** 找本机的 Trae 登录态（storage.json + state.vscdb 必须同目录才算命中）。 */
export function discoverTraeSession(): { session?: TraeLocalSession; error?: string } {
  const failures: string[] = [];
  for (const root of traeUserDataRoots()) {
    const storagePath = join(root, "User", "globalStorage", "storage.json");
    const stateDbPath = join(root, "User", "globalStorage", "state.vscdb");
    if (!existsSync(storagePath)) continue;
    const { credential, error } = readTraeSessionFromStorage(storagePath);
    if (credential === undefined) {
      failures.push(error ?? "未知原因");
      continue;
    }
    return {
      session: {
        storagePath,
        stateDbPath,
        credential: { ...credential, source: storagePath },
      },
    };
  }
  return {
    error:
      failures.length > 0
        ? failures[0]
        : `没有找到 Trae 登录态（找过 ${traeUserDataRoots().length} 个候选目录；装 Trae 并登录一次，或设 TRAE_USER_DATA）`,
  };
}

/** `$DSH_HOME/connect-auth/trae.json`（dsh-connect 的快照格式）。 */
export function traeConnectAuthPath(dshHome: string): string {
  return join(dshHome, "connect-auth", "trae.json");
}

/**
 * 读一份明文凭据文件（我们自己的 token 文件或 connect-auth 的 trae.json）。
 *
 * 两种格式都收：
 * - 我们的：`{formatVersion, token, userId, gateway, appId, appVersionCode, name, expiresAt}`
 * - connect-auth：`{token, gateway, appVersionCode, userId, account:{username}}`
 *
 * 缺 `appId/appVersionCode/gateway` 时用产品级默认值补齐 —— 旧快照没有这些
 * 字段也能用，只是请求头取默认构建号。
 */
export function parseTraeCredentialDocument(doc: Record<string, unknown>, source: string): TraeCredential {
  const token = str(doc["token"]);
  if (token === undefined) throw new Error(`凭据文件里没有 token（${source}）`);
  const account = typeof doc["account"] === "object" && doc["account"] !== null ? (doc["account"] as Record<string, unknown>) : {};
  const product = readTraeProductInfo();
  const docVersion = num(doc["appVersionCode"]);
  const expiresAtMs =
    num(doc["expiresAtMs"]) ??
    (typeof doc["expiredAt"] === "string" ? Date.parse(doc["expiredAt"]) : undefined) ??
    (typeof doc["expiresAt"] === "string" ? Date.parse(doc["expiresAt"]) : undefined) ??
    jwtExpiryMs(token);
  return {
    token,
    ...(str(doc["refreshToken"]) === undefined ? {} : { refreshToken: str(doc["refreshToken"]) }),
    userId: str(doc["userId"]) ?? "",
    name: str(doc["name"]) ?? str(account["username"]) ?? "Trae 账号",
    ...(str(doc["email"]) === undefined && str(account["email"]) === undefined
      ? {}
      : { email: str(doc["email"]) ?? str(account["email"]) }),
    gateway: str(doc["gateway"]) ?? gatewayFor(str(doc["region"]), product),
    appId: str(doc["appId"]) ?? product.appId ?? TRAE_DEFAULT_APP_ID,
    appVersionCode: docVersion ?? product.appVersionCode ?? TRAE_DEFAULT_APP_VERSION_CODE,
    // 凭据文件自带版本号（快照/导入）优先；否则看 product.json；再不行才是兜底。
    appVersionSource: docVersion !== undefined ? "credential" : product.appVersionCode !== undefined ? "product" : "fallback",
    ...(docVersion === undefined && product.sourcePath !== undefined ? { productPath: product.sourcePath } : {}),
    ...(expiresAtMs === undefined || Number.isNaN(expiresAtMs) ? {} : { expiresAtMs }),
    ...(str(doc["region"]) === undefined ? {} : { region: str(doc["region"]) }),
    source,
  };
}

/** 现读凭据文件；读不了/格式坏都抛（调用方折成「凭据不可用」）。 */
export function readTraeCredentialFile(path: string): TraeCredential {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`读不到 Trae 凭据文件（${path}）`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error(`Trae 凭据文件不是 JSON（${path}）`);
  }
  if (typeof doc !== "object" || doc === null) throw new Error(`Trae 凭据文件格式不对（${path}）`);
  return parseTraeCredentialDocument(doc as Record<string, unknown>, path);
}

/** 账号 id 后缀：uid 的 sha256 前 12 位（与 WorkBuddy 同规则，换 id 规则会翻旧账）。 */
export function traeAccountSuffixOf(uid: string): string {
  return createHash("sha256").update(uid, "utf8").digest("hex").slice(0, 12);
}

/** 凭据文件的 token 目录。 */
export function traeTokenDir(dshHome: string): string {
  return join(dshHome, "model-hub", "trae-tokens");
}

/** 把登录态落到自有 token 文件（0600），返回文件路径。 */
export function writeTraeTokenFile(dshHome: string, credential: TraeCredential): string {
  const dir = traeTokenDir(dshHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const slug = credential.userId !== "" ? traeAccountSuffixOf(credential.userId) : createHash("sha256").update(credential.token).digest("hex").slice(0, 12);
  const path = join(dir, `${slug}.json`);
  const body = {
    formatVersion: 2,
    kind: "trae",
    token: credential.token,
    ...(credential.refreshToken === undefined ? {} : { refreshToken: credential.refreshToken }),
    userId: credential.userId,
    name: credential.name,
    ...(credential.email === undefined ? {} : { email: credential.email }),
    gateway: credential.gateway,
    appId: credential.appId,
    appVersionCode: credential.appVersionCode,
    ...(credential.region === undefined ? {} : { region: credential.region }),
    ...(credential.expiresAtMs === undefined ? {} : { expiresAt: new Date(credential.expiresAtMs).toISOString() }),
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

/** 从凭据文件里读身份（uid / 昵称）；读不了返回空对象，不抛。 */
export function traeIdentityOfFile(path: string): { uid?: string; name?: string } {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const uid = str(doc["userId"]);
    const account = typeof doc["account"] === "object" && doc["account"] !== null ? (doc["account"] as Record<string, unknown>) : {};
    const name = str(doc["name"]) ?? str(account["username"]);
    return { ...(uid === undefined ? {} : { uid }), ...(name === undefined ? {} : { name }) };
  } catch {
    return {};
  }
}

/** 列出 token 目录里的全部凭据文件（启动登记用）。 */
export function listTraeTokenEntries(dshHome: string): { source: string; identity: { uid?: string; name?: string } }[] {
  const dir = traeTokenDir(dshHome);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const source = join(dir, name);
      return { source, identity: traeIdentityOfFile(source) };
    });
}

/**
 * token 过期的统一文案。
 *
 * 过期不是「网络抖动」：上游会 401，用户看到的应该是「去 Trae 重新登录」，
 * 而不是一句看不懂的 HTTP 状态码。
 */
export function assertTraeTokenFresh(credential: TraeCredential): void {
  if (credential.expiresAtMs === undefined) return;
  if (credential.expiresAtMs > Date.now()) return;
  throw new Error(
    `Trae token 已于 ${new Date(credential.expiresAtMs).toISOString()} 过期 —— 在 Trae 桌面端退出重登后，回面板点「一键认证」重新导入`,
  );
}
