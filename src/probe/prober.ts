import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { HUB_DIR_NAME, PROVIDER_PREFIX } from "../constants.js";
import { authCandidates, parseAuthDocument, type AuthKind } from "../channels/workbuddy/auth.js";
import { listVaultEntries } from "../channels/workbuddy/vault.js";
import { fetchCatalog } from "../channels/workbuddy/catalog.js";
import {
  exchangePat as exchangePatLive, listPatFiles, resolveDshHome,
  type QoderSession,
} from "../channels/qoder/credentials.js";
import { seedChannelsAndAccounts, type AccountSeed, type ChannelSeed } from "../store/seed.js";
import { markAccountResult } from "../store/mutations.js";
import { queryAccounts } from "../store/queries.js";
import type { HubState } from "../state/hub-state.js";

/**
 * prober：一键认证（oneClickAuth）/ 单账号测试（testAccount）/ 贴 PAT 添加（addQoderPat）。
 *
 * ## 依赖注入
 *
 * 网络面（fetch / exchangePat）与文件面（dshHome）全部可注入 —— 测试不打真网、
 * 不碰真 home。fetchImpl 的传递方式见 {@link withFetch}：catalog / exchangePat
 * 的生产实现内部用 globalThis.fetch，注入靠「调用期间临时换全局」，这样
 * 不必为了注入改别人模块的签名。
 *
 * ## 凭据纪律（本模块最重的一条）
 *
 * 报告 detail 与日志里只允许出现**文件路径**与 **PAT 前 6 位**（`pt-abc123…`），
 * 绝不出现完整 token。redact 覆盖全部三个入口的错误路径：oneClickAuth（探测；
 * 两个渠道的外层 fail-soft catch 也用**各自扫描已收集的 secrets** 过同一口径
 * —— 意外异常的原文可能回显敏感值）、testAccount（detail 会经
 * markAccountResult 落进 DB last_error）、addQoderPat（异常原文会 rethrow 给
 * 路由层进 API 响应）—— live exchangePat 的文案内嵌上游响应体前 200 字符，
 * 上游若回显 personal_token 就是泄漏面。
 * addQoderPat 验活/登记失败时删掉刚写的文件 —— 不留死 PAT。
 */

export interface ProberDeps {
  /** 缺省 globalThis.fetch（经 withFetch 临时换入，供 fetchCatalog 用）。 */
  fetchImpl?: typeof fetch;
  /** Qoder PAT 换 token；缺省 credentials.ts 的 exchangePat。 */
  exchangePat?: typeof exchangePatLive;
  /** 缺省 resolveDshHome()。 */
  dshHome?: string;
}

export interface OneClickSource {
  source: string;
  status: "ok" | "encrypted" | "missing" | "error";
  detail: string;
}
export interface OneClickChannel {
  id: string;
  status: "ok" | "partial" | "missing";
  sources: OneClickSource[];
  accountsAdded: number;
}
export interface OneClickReport {
  channels: OneClickChannel[];
  at: number;
}

export interface TestAccountResult {
  ok: boolean;
  detail: string;
  ms: number;
}

/** 渠道 id 派生（与 index.ts 同源不同处：那是只读参考，本任务不改它）。 */
const PROVIDER_GLOBAL = `${PROVIDER_PREFIX}workbuddy-global`;
const PROVIDER_QODER = `${PROVIDER_PREFIX}qoder-cn`;

/** 贴 PAT 的格式门：pt- 开头 + 至少 8 位（与简报逐字一致）。 */
const PAT_PATTERN = /^pt-[A-Za-z0-9_-]{8,}$/;
/** Qoder PAT 的环境变量来源，顺序即报告顺序（与 readPat 一致）。 */
const QODER_ENV_VARS = ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"] as const;
/** PAT 验活失败时的官方入口 —— 每一条失败 detail 都要带上。 */
const PAT_GUIDE = "到 https://qoder.com.cn/account/integrations 新建 PAT";

// ── 小工具 ──

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** PAT 全文一旦出现在错误文案里就隐去 —— 上游回显不该变成我们的泄漏面。 */
function redact(text: string, pats: string[]): string {
  let out = text;
  for (const pat of pats) {
    if (pat !== "" && out.includes(pat)) out = out.split(pat).join("（PAT 已隐去）");
  }
  return out;
}

/** 错误消息里抓 HTTP 状态码：fetchCatalog 与 exchangePat 的错误文案都带「HTTP nnn」。 */
function statusFromError(message: string): number | undefined {
  const match = /HTTP (\d{3})/.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/**
 * 注入 fetch 的桥梁：fetchCatalog / exchangePat 的生产实现内部取 globalThis.fetch，
 * 这里在调用期间临时换入注入实现，结束（含抛错）恢复。只影响本次调用窗口，
 * 生产路径（fetchImpl 缺省）完全不动全局。
 */
async function withFetch<T>(fetchImpl: typeof fetch | undefined, run: () => Promise<T>): Promise<T> {
  if (fetchImpl === undefined) return run();
  const globe = globalThis as { fetch: typeof fetch };
  const original = globe.fetch;
  globe.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globe.fetch = original;
  }
}

/** 渠道级聚合：全 ok=ok、部分=partial、全败（含零来源）=missing。 */
function channelStatusOf(sources: OneClickSource[]): OneClickChannel["status"] {
  const ok = sources.filter((s) => s.status === "ok").length;
  if (ok === 0) return "missing";
  return ok === sources.length ? "ok" : "partial";
}

/** 备注名 → slug：小写化后非 [a-z0-9-] 连段转 -、去首尾 -、截 32（§3.2 先例的净化口径）。 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/** 账号 inventory：id 全集（含软删，防 slug 撞上已删账号后被 upsert 守卫静默吞掉）。 */
function allAccountIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT id FROM accounts").all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * slug 取用：备注名净化优先，空则回落 `pat-<前 6 位>`（pt- 后 6 位）。
 * 与已有 `.pat` 文件或已有账号 id 冲突时追加 -2、-3……（§3.2 的冲突先例）。
 * 文件也计入冲突 —— 软删账号的 PAT 文件还留在盘上，重名不该覆盖它。
 */
function pickSlug(db: DatabaseSync, dir: string, pat: string, displayName: string | undefined): string {
  const base = slugify(displayName ?? "") || `pat-${pat.slice(3, 9)}`;
  const takenIds = allAccountIds(db);
  let slug = base;
  for (let n = 2; n <= 100; n += 1) {
    if (!existsSync(join(dir, `${slug}.pat`)) && !takenIds.has(`${PROVIDER_QODER}:${slug}`)) return slug;
    slug = `${base}-${n}`;
  }
  throw new Error(`拿不到可用的账号标识（${base}-2 … -100 全被占用）`);
}

// ── oneClickAuth ──

/**
 * WorkBuddy 侧三态报告。
 *
 * 展示与聚合分离：`sources` 给人看（含缺失提示，规格 §7「明确说缺什么」），
 * `present` 给渠道级聚合用（只统计实际存在的来源 —— 5 个候选天然缺 4 个，
 * 全计入聚合会让渠道级「ok」永不可达）。
 *
 * 哪些缺失进 sources：用户**显式指定**的 WORKBUDDY_AUTH_FILE 缺失必须报
 * （那正是要被告知的错配）；LOCALAPPDATA/APPDATA 下的固定候选缺失不逐条报，
 * 但零来源时会合成一条把搜索过的路径全部亮出来，让用户能照着行动。
 *
 * `secrets` 由调用方持有并就地填充（扫到的明文 token）：本函数正常返回时它
 * 只用于兜底；抛出意外异常时外层 fail-soft catch 拿**已收集的部分**过 redact
 * —— 收集必须边扫边做，事后补不回来。
 */
function probeWorkbuddySources(secrets: string[]): { sources: OneClickSource[]; present: OneClickSource[]; entries: ReturnType<typeof listVaultEntries> } {
  const sources: OneClickSource[] = [];
  const present: OneClickSource[] = [];
  const candidates = authCandidates();
  const explicit = process.env["WORKBUDDY_AUTH_FILE"];
  for (const path of candidates) {
    if (!existsSync(path)) {
      if (explicit !== undefined && explicit !== "" && path === explicit) {
        sources.push({ source: path, status: "missing", detail: `${path}（文件不存在 —— 检查 WORKBUDDY_AUTH_FILE）` });
      }
      continue;
    }
    let kind: AuthKind = "missing";
    let token: string | undefined;
    try {
      const parsed = parseAuthDocument(readFileSync(path, "utf8"));
      kind = parsed.kind;
      if (parsed.kind === "plain" && parsed.token !== undefined) token = parsed.token;
    } catch (error) {
      const bad: OneClickSource = { source: path, status: "error", detail: `${path}（读取失败：${messageOf(error)}）` };
      sources.push(bad);
      present.push(bad);
      continue;
    }
    if (token !== undefined) secrets.push(token);
    const entry: OneClickSource = {
      source: path,
      status: kind === "plain" ? "ok" : kind,
      detail: kind === "plain"
        ? `${path}（明文 token 可用）`
        : kind === "encrypted"
          ? `${path}（token 是加密信封，装 dsh-connect-workbuddy 解一次即可用）`
          : `${path}（文件里没有可用的 accessToken）`,
    };
    sources.push(entry);
    present.push(entry);
  }
  const entries = listVaultEntries();
  for (const entry of entries) {
    const vault: OneClickSource = { source: entry.source, status: "ok", detail: `${entry.source}（vault，${entry.region}）` };
    sources.push(vault);
    present.push(vault);
  }
  if (sources.length === 0) {
    sources.push({
      source: "workbuddy-auth",
      status: "missing",
      detail: `未找到 WorkBuddy 登录文件；已搜索：${candidates.join("、")}`,
    });
  }
  return { sources, present, entries };
}

/**
 * Qoder 侧来源枚举：旧 `<dshHome>/qoder/pat` + env（pt- 开头才收）+
 * `<dshHome>/model-hub/qoder-pats/*.pat`，逐个 exchangePat 验活。
 * 没有凭据的机器 sources 为空 —— 渠道级即 missing。
 *
 * `pats` 由调用方持有（与 {@link probeWorkbuddySources} 的 secrets 同一角色）：
 * 内部逐条 redact 用它，意外异常冒出时外层 fail-soft catch 用同一份兜底。
 */
async function probeQoderSources(
  deps: ProberDeps,
  pats: string[],
): Promise<{ sources: OneClickSource[]; validated: { source: string; session: QoderSession }[] }> {
  const home = deps.dshHome ?? resolveDshHome();
  const exchange = deps.exchangePat ?? exchangePatLive;
  const sources: OneClickSource[] = [];
  const validated: { source: string; session: QoderSession }[] = [];
  const candidates: { source: string; pat: string }[] = [];

  const legacy = join(home, "qoder", "pat");
  if (existsSync(legacy)) {
    try {
      const value = readFileSync(legacy, "utf8").trim();
      if (value.startsWith("pt-")) candidates.push({ source: legacy, pat: value });
      else sources.push({ source: legacy, status: "missing", detail: `${legacy}（内容不是 pt- 开头）` });
    } catch (error) {
      sources.push({ source: legacy, status: "error", detail: `${legacy}（读取失败：${messageOf(error)}）` });
    }
  }

  for (const name of QODER_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value.startsWith("pt-")) candidates.push({ source: `env:${name}`, pat: value });
  }
  for (const file of listPatFiles(join(home, HUB_DIR_NAME, "qoder-pats"))) {
    candidates.push({ source: file.source, pat: file.pat });
  }

  for (const candidate of candidates) {
    pats.push(candidate.pat);
    try {
      // 会话留下：userinfo 的 name/email 是账号真实身份，oneClickAuth 拿它
      // 把通用占位名（「Qoder CN 账号」）刷成真名 —— 换号/多账号才看得出来。
      const session = await exchange(candidate.pat, candidate.source);
      validated.push({ source: candidate.source, session });
      sources.push({ source: candidate.source, status: "ok", detail: `${candidate.source}（PAT 验活通过）` });
    } catch (error) {
      sources.push({
        source: candidate.source,
        status: "error",
        detail: `${redact(messageOf(error), pats)}；${PAT_GUIDE}`,
      });
    }
  }
  return { sources, validated };
}

/**
 * 一键认证：扫描两渠道的全部凭据来源 → 三态报告 → 顺手把 WorkBuddy vault 的
 * 账号登记进库（已存在的 id 幂等跳过，不计入 accountsAdded）→ 池非空时确保 runtime。
 *
 * fail-soft：单渠道探测抛错只把该渠道记为 missing + error 来源，不拖垮整体报告。
 * Qoder 侧只验活不登记 —— 添加 Qoder 账号是 addQoderPat 的职责（写文件 + 入库 + 起 runtime）。
 */
export async function oneClickAuth(deps: ProberDeps, db: DatabaseSync, state: HubState): Promise<OneClickReport> {
  const channels: OneClickChannel[] = [];
  // 每个渠道一份「本次扫描已见过的 secrets」：正常时兜底用不上，
  // 外层 fail-soft catch 的文案要拿它过 redact（M7：异常原文可能回显敏感值）。
  const wbSecrets: string[] = [];
  const qoderSecrets: string[] = [];

  try {
    const { sources, present, entries } = probeWorkbuddySources(wbSecrets);
    let accountsAdded = 0;
    if (entries.length > 0) {
      const live = queryAccounts(db) as { id: string; channel_id: string }[];
      const channelHasLive = live.some((a) => a.channel_id === PROVIDER_GLOBAL);
      // 去重必须对**全集 id（含软删）**：upsertOneAccount 的软删守卫（seed.ts）会
      // 拦下重导入，若只对 live 去重，软删 id 会漏进 fresh、accountsAdded 虚报
      // —— 用户删号后再扫会看到「接管 1 个账号」的假成功、账号却永不出现。
      // 与 routes/write.ts 的 accounts/add 同款（I2）。
      const taken = new Set(
        (db.prepare("SELECT id FROM accounts").all() as { id: string }[]).map((row) => row.id),
      );
      const channel: ChannelSeed = { id: PROVIDER_GLOBAL, kind: "workbuddy", displayName: "WorkBuddy Global" };
      const fresh: AccountSeed[] = [];
      for (const entry of entries) {
        const id = `${PROVIDER_GLOBAL}:${entry.accountId}`;
        if (taken.has(id)) continue; // 幂等：已存在（含软删）跳过，不计入 accountsAdded
        fresh.push({
          id,
          channelId: PROVIDER_GLOBAL,
          // 显示名用真实身份：vault 里的明文 nickname，退回 uid 前缀，再退回文件名 ——
          // 用户要在面板上看出「这是谁」，而不是一排「WorkBuddy 主账号」。
          displayName:
            entry.identity.nickname ??
            (entry.identity.uid !== undefined ? `WB · ${entry.identity.uid.slice(0, 8)}` : entry.accountId),
          credentialRef: entry.source,
          // 渠道一个当前账号都没有时，首个新账号顶上 current（选择器本就有池序兜底）
          isCurrent: fresh.length === 0 && !channelHasLive,
        });
      }
      if (fresh.length > 0) {
        seedChannelsAndAccounts(db, [channel], fresh);
        accountsAdded = fresh.length;
      }
    }
    // 池非空才 ensure：池空时 hub-state 建了 runtime 也会因拉不到目录而空转
    if (state.poolSize(PROVIDER_GLOBAL) > 0) await state.ensureRuntime(PROVIDER_GLOBAL);
    // 聚合只看存在的来源（present）；sources 含缺失提示，只进展示（review r1）
    channels.push({ id: PROVIDER_GLOBAL, status: channelStatusOf(present), sources, accountsAdded });
  } catch (error) {
    channels.push({
      id: PROVIDER_GLOBAL,
      status: "missing",
      sources: [{ source: "workbuddy", status: "error", detail: `扫描失败：${redact(messageOf(error), wbSecrets)}` }],
      accountsAdded: 0,
    });
  }

  try {
    const { sources, validated } = await probeQoderSources(deps, qoderSecrets);
    // 验活成功的来源顺手把**通用占位名**刷成真实身份（userinfo 的 name/email）。
    // 只动「Qoder CN 账号」这个启动默认名 —— 用户自己起过的备注名绝不覆盖；
    // 身份也拿不到时（fake session 没带 name/email）保持原名。
    for (const { source, session } of validated) {
      const identityName = session.name || session.email || "";
      if (identityName === "") continue;
      const row = db
        .prepare("SELECT id, display_name FROM accounts WHERE credential_ref = ? AND deleted = 0")
        .get(source) as { id: string; display_name: string } | undefined;
      if (row !== undefined && row.display_name === "Qoder CN 账号") {
        db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(identityName, row.id);
      }
    }
    channels.push({ id: PROVIDER_QODER, status: channelStatusOf(sources), sources, accountsAdded: 0 });
  } catch (error) {
    channels.push({
      id: PROVIDER_QODER,
      status: "missing",
      sources: [{ source: "qoder", status: "error", detail: `扫描失败：${redact(messageOf(error), qoderSecrets)}` }],
      accountsAdded: 0,
    });
  }

  return { channels, at: Date.now() };
}

// ── testAccount ──

/**
 * 单账号测试：按 credential_ref 现场取凭据并真实验活。
 *
 * WorkBuddy = 读文件 → parseAuthDocument → plain 的 token → fetchCatalog（HTTP ok 即成功）；
 * Qoder = credential_ref 是 `env:*` 从环境变量取、否则读文件 → exchangePat。
 * 成功/失败都 markAccountResult（成功即解除冷却）；失败文案里的 HTTP 状态码
 * 会被翻给熔断计数用（401/402/403/429 才累计，见 mutations.isCredentialFailure）。
 *
 * `state` 保留在签名里与另两个入口对齐；测试路径不需要动 runtime —— 成功后的
 * 可用性由 markAccountResult 落库，prepare 下次 pick 自然拿到。
 */
export async function testAccount(
  deps: ProberDeps, db: DatabaseSync, state: HubState, accountId: string,
): Promise<TestAccountResult> {
  void state;
  // 凭据引用不出存储层（queries 有意不投影 credential_ref），runtime.ts 里同款
  // 只读 SELECT 是唯一通路 —— 这里镜像它，不为此改别人模块。
  const row = db
    .prepare("SELECT channel_id, credential_ref FROM accounts WHERE id = ? AND deleted = 0")
    .get(accountId) as { channel_id: string; credential_ref: string | null } | undefined;
  if (row === undefined) return { ok: false, detail: `账号 ${accountId} 不存在`, ms: 0 };

  const started = Date.now();
  let ok = false;
  let detail: string;
  let status: number | undefined;
  try {
    if (row.channel_id === PROVIDER_QODER) {
      detail = await testQoderCredential(deps, row.credential_ref);
    } else {
      detail = await testWorkbuddyCredential(deps, row.credential_ref);
    }
    ok = true;
  } catch (error) {
    detail = messageOf(error);
    status = statusFromError(detail);
    if (row.channel_id === PROVIDER_QODER) detail = `${detail}；${PAT_GUIDE}`;
  }
  const ms = Date.now() - started;
  markAccountResult(db, accountId, ok, ok ? undefined : status, ok ? undefined : detail, Date.now());
  return { ok, detail, ms };
}

/** WorkBuddy：读凭据文件 → plain token → 真拉一次目录。 */
async function testWorkbuddyCredential(deps: ProberDeps, ref: string | null): Promise<string> {
  if (ref === null || ref === "") throw new Error("没有 credential_ref");
  const parsed = parseAuthDocument(readFileSync(ref, "utf8"));
  if (parsed.kind !== "plain" || parsed.token === undefined) {
    throw new Error(`凭据不可用（${ref}，状态 ${parsed.kind}）`);
  }
  let models: Awaited<ReturnType<typeof fetchCatalog>>;
  try {
    models = await withFetch(deps.fetchImpl, () => fetchCatalog(parsed.region ?? "global", parsed.token as string));
  } catch (error) {
    // token 在手：错误文案万一回显就当场隐去，detail/DB 都不留明文
    throw new Error(redact(messageOf(error), [parsed.token]));
  }
  return `目录拉取成功（${ref}，${models.length} 个模型）`;
}

/** Qoder：env:* 从环境变量取，否则当文件路径现读；exchangePat 抛错即失败。 */
async function testQoderCredential(deps: ProberDeps, ref: string | null): Promise<string> {
  if (ref === null || ref === "") throw new Error("没有 credential_ref");
  let pat: string | undefined;
  if (ref.startsWith("env:")) {
    const value = process.env[ref.slice("env:".length)]?.trim();
    if (value !== undefined && value.startsWith("pt-")) pat = value;
  } else {
    const value = readFileSync(ref, "utf8").trim();
    if (value.startsWith("pt-")) pat = value;
  }
  if (pat === undefined) throw new Error(`凭据不可用（${ref}，缺 pt- 开头的 PAT）`);
  try {
    await (deps.exchangePat ?? exchangePatLive)(pat, ref);
  } catch (error) {
    // live exchangePat 的文案内嵌上游响应体前 200 字符 —— 上游若回显
    // personal_token，不 redact 就会把 PAT 全文送进 detail 与 DB last_error。
    throw new Error(redact(messageOf(error), [pat]));
  }
  return `PAT 验活通过（${ref}）`;
}

// ── addQoderPat ──

/**
 * 贴 PAT 添加账号：校验格式 → 写 `<dshHome>/model-hub/qoder-pats/<slug>.pat`
 * （目录 0700 / 文件 0600）→ exchangePat 验活 → 登记渠道与账号 → ensureRuntime。
 *
 * **失败即删刚写的文件**（不留死 PAT）：验活或登记任何一步失败，文件都删掉再抛。
 */
export async function addQoderPat(
  deps: ProberDeps, db: DatabaseSync, state: HubState, pat: string, displayName?: string,
): Promise<{ accountId: string; path: string }> {
  const value = pat.trim();
  if (!PAT_PATTERN.test(value)) {
    throw new Error(`PAT 格式不对：需要 pt- 开头、后接至少 8 位字母/数字/_/-（${PAT_GUIDE}）`);
  }

  const home = deps.dshHome ?? resolveDshHome();
  const dir = join(home, HUB_DIR_NAME, "qoder-pats");
  const slug = pickSlug(db, dir, value, displayName);
  const path = join(dir, `${slug}.pat`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });

  try {
    const session = await (deps.exchangePat ?? exchangePatLive)(value, path);
    const accountId = `${PROVIDER_QODER}:${slug}`;
    const live = queryAccounts(db) as { channel_id: string }[];
    const isFirst = !live.some((a) => a.channel_id === PROVIDER_QODER);
    seedChannelsAndAccounts(
      db,
      [{ id: PROVIDER_QODER, kind: "qoder", displayName: "Qoder CN" }],
      [{
        id: accountId,
        channelId: PROVIDER_QODER,
        // 显示名优先级：用户备注 > userinfo 真名 > 邮箱 > slug —— 一眼看出这是谁
        displayName: displayName?.trim() ? displayName.trim() : session.name || session.email || slug,
        credentialRef: path,
        isCurrent: isFirst, // 渠道首个账号顶 current；后续账号不抢（makeCurrent 可手动切）
      }],
    );
    await state.ensureRuntime(PROVIDER_QODER);
    return { accountId, path };
  } catch (error) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* 删不掉也别掩盖原错误 —— 文件残留会在诊断里可见 */
    }
    // PAT 在手：异常原文（内嵌上游响应体）rethrow 给路由层前先隐去回显的 token
    throw new Error(redact(messageOf(error), [value]));
  }
}
