import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, publicEncrypt, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
// src/config.ts
/** cosmokit volatile 引用协议的写句柄符号（与宿主共享库同一 well-known symbol）。 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
/**
* 解引用 volatile 配置字段。
*
* 宿主把 `.volatile()` 字段交付成 { get, [write] } 引用对象（改设置即换快照，
* 插件侧 .get() 永远拿最新值）。直接读字段拿到的是引用而不是值——
* `=== false` / `?? 默认值` / JSON 序列化 / 数值运算全部失真（真机实测：
* retentionDays 进 /diag 变 {}，prune 拿 NaN 空转，总开关关不掉）。
* 非引用值原样返回——引用与裸值混用时两端都安全。
*/
function readSetting(value) {
	return typeof value === "object" && value !== null && VOLATILE_WRITE in value ? value.get() : value;
}
/** 全部字段 .volatile() —— 宿主把标了它的字段当引用对象，改完即生效、不用重载插件。 */
const Config = z.object({
	enabled: z.boolean().default(true).description("总开关").volatile(),
	recordEnabled: z.boolean().default(true).description("是否记录请求").volatile(),
	retentionDays: z.number().default(90).description("明细保留天数").volatile()
});
// src/constants.ts
/** 本插件的数据库文件放在 $DSH_HOME 下的这个子目录。 */
const HUB_DIR_NAME = "model-hub";
/** 主库文件名。 */
const HUB_DB_NAME = "hub.db";
/**
* SQLite `application_id`，用来认领这个库。
*
* 0x48554231 = "HUB1"。打开时若 application_id 既不是 0（全新文件）也不是本值，
* 说明这个路径上放的是别人的库 —— 拒绝打开，而不是往上写。
*/
const HUB_APP_ID = 1213547057;
/** provider id 前缀，与 dsh-connect-workbuddy 的 workbuddy/workbuddy-global 区分。 */
const PROVIDER_PREFIX = "hub-";
// src/store/db.ts
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_V1 = readFileSync(join(HERE, "schema.sql"), "utf8");
/**
* 打开（或创建）本插件的 SQLite 库。
*
* 三条加固，抄自 DSH 官方的 `dsh-session-query-sqlite`（本机在用的同一个后端）：
* 1. 建库即 0600、建目录即 0700 —— 不是建完再 chmod
* 2. `application_id` 认领 —— 这个路径上放的是别人的库就拒绝，而不是往上写
* 3. `user_version` 迁移 —— 按版本号逐级升级，不靠「表存在就跳过」
*/
async function openHubDatabase(path) {
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	try {
		await (await open(path, "wx", 384)).close();
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path);
	try {
		const { application_id: applicationId } = db.prepare("PRAGMA application_id").get();
		if (applicationId !== 0 && applicationId !== 1213547057) throw new Error(`the database at "${path}" belongs to another application (application_id=${applicationId})`);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA foreign_keys = ON");
		const { user_version: version } = db.prepare("PRAGMA user_version").get();
		if (version < 1) db.exec(SCHEMA_V1);
		if (version < 2) {
			db.exec("ALTER TABLE accounts ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
			db.exec("ALTER TABLE accounts ADD COLUMN cooldown_until INTEGER");
		}
		if (version !== 2) db.exec(`PRAGMA user_version = 2`);
		if (version === 0) db.exec(`PRAGMA application_id = ${HUB_APP_ID}`);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
// src/store/seed.ts
/**
* 登记单个账号（供 `seedChannelsAndAccounts` 与后续 prober 复用）。
*
* `WHERE NOT EXISTS` 是软删守卫：目标行 `deleted = 1` 时整个 INSERT SELECT
* 产出空集，什么都不写。注意 `?1` 同时绑在两处 —— INSERT 的 id 与守卫的
* 判存条件必须是同一个值，否则守卫形同虚设。
*
* `now` 由调用方传入（默认取当前时间）：批量登记共用一个 `created_at`，
* 软删晋升时 `ORDER BY created_at ASC` 的并列才稳定。
*/
function upsertOneAccount(db, account, now = Date.now()) {
	db.prepare(`
    INSERT INTO accounts (id, channel_id, display_name, credential_ref, enabled, is_current, consecutive_failures, created_at)
    SELECT ?, ?, ?, ?, 1, ?, 0, ?
    WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND deleted = 1)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      credential_ref = excluded.credential_ref
  `).run(account.id, account.channelId, account.displayName, account.credentialRef ?? null, account.isCurrent === true ? 1 : 0, now);
}
function seedChannelsAndAccounts(db, channels, accounts) {
	if (channels.length === 0 && accounts.length === 0) return;
	db.exec("BEGIN");
	try {
		const upsertChannel = db.prepare(`
      INSERT INTO channels (id, kind, display_name, enabled, config)
      VALUES (?, ?, ?, 1, '{}')
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        display_name = excluded.display_name
    `);
		for (const channel of channels) upsertChannel.run(channel.id, channel.kind, channel.displayName);
		const now = Date.now();
		for (const account of accounts) upsertOneAccount(db, account, now);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
const COOLDOWN_MS = 6e5;
/** 计入熔断的凭据类状态码。400 不算（请求不合法），5xx 不算（不是凭据的错）。 */
function isCredentialFailure(status) {
	return status === 401 || status === 402 || status === 403 || status === 429;
}
function setAccountEnabled(db, id, enabled) {
	db.prepare("UPDATE accounts SET enabled = ? WHERE id = ? AND deleted = 0").run(enabled ? 1 : 0, id);
}
function setChannelEnabled(db, id, enabled) {
	db.prepare("UPDATE channels SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}
function makeCurrent(db, channelId, accountId) {
	db.exec("BEGIN");
	try {
		db.prepare("UPDATE accounts SET is_current = 0 WHERE channel_id = ?").run(channelId);
		db.prepare("UPDATE accounts SET is_current = 1, enabled = 1 WHERE id = ? AND channel_id = ? AND deleted = 0").run(accountId, channelId);
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}
function softDeleteAccount(db, id) {
	const row = db.prepare("SELECT channel_id FROM accounts WHERE id = ?").get(id);
	if (row === void 0) return;
	db.exec("BEGIN");
	try {
		db.prepare("UPDATE accounts SET deleted = 1, enabled = 0, is_current = 0 WHERE id = ?").run(id);
		const next = db.prepare("SELECT id FROM accounts WHERE channel_id = ? AND deleted = 0 AND enabled = 1 AND credential_ref IS NOT NULL AND credential_ref <> '' ORDER BY last_ok_at DESC, created_at ASC LIMIT 1").get(row.channel_id);
		if (next !== void 0) db.prepare("UPDATE accounts SET is_current = 1 WHERE id = ?").run(next.id);
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}
function markAccountResult(db, id, ok, status, error, now) {
	const row = db.prepare("SELECT consecutive_failures, deleted FROM accounts WHERE id = ?").get(id);
	if (row === void 0 || row.deleted === 1) return;
	if (ok) {
		db.prepare("UPDATE accounts SET consecutive_failures = 0, cooldown_until = NULL, last_ok_at = ?, last_error = NULL WHERE id = ?").run(now, id);
		return;
	}
	if (!isCredentialFailure(status)) {
		db.prepare("UPDATE accounts SET last_error = ? WHERE id = ?").run(error ?? null, id);
		return;
	}
	const fails = row.consecutive_failures + 1;
	const cooldown = fails >= 3 ? now + COOLDOWN_MS : null;
	db.prepare("UPDATE accounts SET consecutive_failures = ?, cooldown_until = ?, last_error = ? WHERE id = ?").run(fails, cooldown, error ?? `HTTP ${status ?? "—"}`, id);
}
// src/store/requests.ts
/** 本地时区的 YYYY-MM-DD。聚合按用户看到的「今天」分组，不是 UTC。 */
function localDate(ms) {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/**
* 写一条请求记录，并增量累加当日聚合。
*
* 聚合口径必须与明细重算逐字段相等（回归锚点）：均值存加权均值，
* 各自带样本数 ttft_n / tps_n —— 不能拿 ok_count 凑，因为 TTFT 与 tok/s
* 都可能为 NULL，各自的样本数不同。
*/
function insertRequest(db, r) {
	db.exec("BEGIN");
	try {
		db.prepare(`
      INSERT INTO requests (
        request_id, session_id, channel_id, account_id, provider, model,
        input_tokens, output_tokens, cache_read, cache_write,
        first_token_ms, upstream_head_ms, duration_ms, decode_tps,
        status_code, error, is_streaming, estimated, cost_units, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(r.requestId, r.sessionId ?? null, r.channelId, r.accountId ?? null, r.provider, r.model, r.inputTokens, r.outputTokens, r.cacheRead, r.cacheWrite, r.firstTokenMs ?? null, r.upstreamHeadMs ?? null, r.durationMs ?? null, r.decodeTps ?? null, r.statusCode ?? null, r.error ?? null, r.isStreaming ? 1 : 0, r.estimated ? 1 : 0, r.costUnits, r.createdAt);
		const date = localDate(r.createdAt);
		const account = r.accountId ?? "";
		const ok = r.statusCode !== void 0 && r.statusCode >= 200 && r.statusCode < 300 ? 1 : 0;
		const tokens = r.inputTokens + r.outputTokens;
		const hasTtft = r.firstTokenMs !== void 0;
		const hasTps = r.decodeTps !== void 0;
		const prev = db.prepare("SELECT req_count, ok_count, tokens, cost_units, avg_ttft_ms, ttft_n, avg_tps, tps_n FROM daily_rollups WHERE date=? AND channel_id=? AND model=? AND account_id=?").get(date, r.channelId, r.model, account) ?? {
			req_count: 0,
			ok_count: 0,
			tokens: 0,
			cost_units: 0,
			avg_ttft_ms: 0,
			ttft_n: 0,
			avg_tps: 0,
			tps_n: 0
		};
		const ttftN = prev.ttft_n + (hasTtft ? 1 : 0);
		const tpsN = prev.tps_n + (hasTps ? 1 : 0);
		const avgTtft = hasTtft ? Math.round((prev.avg_ttft_ms * prev.ttft_n + r.firstTokenMs) / ttftN) : prev.avg_ttft_ms;
		const avgTps = hasTps ? (prev.avg_tps * prev.tps_n + r.decodeTps) / tpsN : prev.avg_tps;
		db.prepare(`
      INSERT INTO daily_rollups (date, channel_id, model, account_id, req_count, ok_count, tokens, cost_units, avg_ttft_ms, ttft_n, avg_tps, tps_n)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(date, channel_id, model, account_id) DO UPDATE SET
        req_count=excluded.req_count, ok_count=excluded.ok_count, tokens=excluded.tokens,
        cost_units=excluded.cost_units, avg_ttft_ms=excluded.avg_ttft_ms, ttft_n=excluded.ttft_n,
        avg_tps=excluded.avg_tps, tps_n=excluded.tps_n
    `).run(date, r.channelId, r.model, account, prev.req_count + 1, prev.ok_count + ok, prev.tokens + tokens, prev.cost_units + r.costUnits, avgTtft, ttftN, avgTps, tpsN);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
// src/store/queries.ts
/**
* 今日汇总。
*
* 均值的口径：`daily_rollups` 存的是**加权均值 + 各自样本数**
* （`ttft_n` / `tps_n`），所以跨模型合并时要按样本数加权，
* 不能对各行的 avg 直接求平均 —— 那会让一个只跑过 1 次的模型
* 和一个跑过 500 次的模型等权。
*/
function querySummary(db, date = localDate(Date.now())) {
	const rows = db.prepare("SELECT req_count, ok_count, tokens, cost_units, avg_ttft_ms, ttft_n, avg_tps, tps_n FROM daily_rollups WHERE date = ?").all(date);
	let requests = 0;
	let ok = 0;
	let tokens = 0;
	let costUnits = 0;
	let ttftWeighted = 0;
	let ttftN = 0;
	let tpsWeighted = 0;
	let tpsN = 0;
	for (const row of rows) {
		requests += row.req_count;
		ok += row.ok_count;
		tokens += row.tokens;
		costUnits += row.cost_units;
		ttftWeighted += row.avg_ttft_ms * row.ttft_n;
		ttftN += row.ttft_n;
		tpsWeighted += row.avg_tps * row.tps_n;
		tpsN += row.tps_n;
	}
	return {
		date,
		requests,
		ok,
		tokens,
		costUnits,
		avgTtftMs: ttftN > 0 ? Math.round(ttftWeighted / ttftN) : null,
		avgTps: tpsN > 0 ? tpsWeighted / tpsN : null
	};
}
/** 渠道列表（含今日计数）。面板的筛选下拉与「渠道」栏用它。 */
function queryChannels(db, date = localDate(Date.now())) {
	return db.prepare(`SELECT c.id, c.kind, c.display_name, c.enabled,
              COALESCE(r.req_count, 0) AS today_requests,
              COALESCE(r.tokens, 0) AS today_tokens
       FROM channels c
       LEFT JOIN (
         SELECT channel_id, SUM(req_count) AS req_count, SUM(tokens) AS tokens
         FROM daily_rollups WHERE date = ? GROUP BY channel_id
       ) r ON r.channel_id = c.id
       ORDER BY c.id`).all(date);
}
/**
* 按账号的今日消耗。
*
* `daily_rollups` 的主键本就带 account_id 维度，所以这是现成的口径 ——
* 面板要在账号行上直接看到「这个账号今天用了多少」，而不是只有渠道/模型级
* 汇总。空 account_id（历史行/未归属）原样返回，UI 显示 `—`。
*/
function queryAccountUsage(db, date = localDate(Date.now())) {
	return db.prepare(`SELECT account_id,
              SUM(req_count) AS today_requests,
              SUM(tokens) AS today_tokens
       FROM daily_rollups
       WHERE date = ?
       GROUP BY account_id`).all(date);
}
/** 账号列表。凭据本身**不返回** —— 面板只需要知道有没有、能不能用。 */
function queryAccounts(db) {
	return db.prepare(`SELECT id, channel_id, display_name, enabled, is_current,
              consecutive_failures, cooldown_until, last_error, last_ok_at, created_at,
              CASE WHEN credential_ref IS NULL OR credential_ref = '' THEN 0 ELSE 1 END AS has_credential
       FROM accounts
       WHERE deleted = 0
       ORDER BY channel_id, display_name`).all();
}
/**
* 明细记录，按筛选条件。
*
* 上限硬编码 2000：面板是「全部显示 + 表格自身滚动」，但把 10 万行塞进
* 浏览器会卡死。2000 行足够覆盖一个工作日的排查，再多请用 CSV 导出。
*/
function queryRequests(db, filter) {
	const clauses = [];
	const params = [];
	if (filter.channelId !== void 0 && filter.channelId !== "") {
		clauses.push("channel_id = ?");
		params.push(filter.channelId);
	}
	if (filter.model !== void 0 && filter.model !== "") {
		clauses.push("model = ?");
		params.push(filter.model);
	}
	if (filter.sinceMs !== void 0) {
		clauses.push("created_at >= ?");
		params.push(filter.sinceMs);
	}
	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	const limit = Math.min(Math.max(1, filter.limit), 2e3);
	return db.prepare(`SELECT request_id, session_id, channel_id, account_id, provider, model,
              input_tokens, output_tokens, cache_read, cache_write,
              first_token_ms, upstream_head_ms, duration_ms, decode_tps,
              status_code, error, is_streaming, estimated, cost_units, created_at
       FROM requests ${where}
       ORDER BY created_at DESC
       LIMIT ?`).all(...params, limit);
}
/** 出现过的模型（供筛选下拉）。 */
function queryModels(db) {
	return db.prepare("SELECT DISTINCT model FROM requests ORDER BY model").all();
}
function queryDiagFacts(db) {
	const count = db.prepare("SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM requests").get();
	const lastErrorRow = db.prepare(`SELECT created_at, model, status_code, error
         FROM requests
        WHERE error IS NOT NULL
           OR status_code IS NULL
           OR status_code < 200
           OR status_code >= 300
        ORDER BY created_at DESC
        LIMIT 1`).get();
	const channel = db.prepare("SELECT id FROM channels WHERE enabled = 1 ORDER BY id LIMIT 1").get();
	const account = db.prepare("SELECT id, display_name FROM accounts WHERE enabled = 1 ORDER BY is_current DESC, id LIMIT 1").get();
	return {
		recordCount: count?.c ?? 0,
		oldestRecordAt: count?.oldest ?? null,
		lastError: lastErrorRow === void 0 ? null : {
			at: lastErrorRow.created_at,
			model: lastErrorRow.model,
			status: lastErrorRow.status_code,
			error: lastErrorRow.error ?? "（上游未返回错误正文）"
		},
		currentChannelId: channel?.id ?? null,
		currentAccountId: account?.id ?? null,
		currentAccountName: account?.display_name ?? null
	};
}
// src/store/retention.ts
/**
* 按天界删过期明细，返回实际删除行数。
*
* days 下界保护：days 传 0 / 负数 / 小数时按「至少 1 天」回退——
* cutoff 永远严格早于 now，刚写入的当天明细不会被误删（DELETE 用 `<` 严格小于）。
* 只删 requests 不动 daily_rollups：聚合是趋势曲线，清了它历史图表会跳变；
* 明细与聚合本来就允许口径不一致（保留期不同），不在这里做对账。
*/
function pruneRequests(db, days, now = Date.now()) {
	const cutoff = now - Math.max(1, Math.floor(days)) * 864e5;
	return Number(db.prepare("DELETE FROM requests WHERE created_at < ?").run(cutoff).changes);
}
/**
* 清空请求记录：明细与聚合两表一起清。
*
* 包在同一个事务里——两张表要么都空要么都原样，删一半会让
* 「明细 COUNT=0 但聚合还有数」这种对不上账的中间态留在库里。
*/
function clearRecords(db) {
	db.exec("BEGIN");
	try {
		db.exec("DELETE FROM requests");
		db.exec("DELETE FROM daily_rollups");
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}
// src/channels/workbuddy/auth.ts
/**
* 品牌域名 → 区域。
*
* 必须精确匹配或点号后缀匹配：`codebuddy.ai.evil.com` 不能被判成 global。
*/
function regionOfDomain(domain) {
	const d = domain.trim().toLowerCase();
	if (d === "workbuddy.ai" || d.endsWith(".workbuddy.ai")) return "global";
	if (d === "codebuddy.ai" || d.endsWith(".codebuddy.ai")) return "global";
	if (d === "workbuddy.cn" || d.endsWith(".workbuddy.cn")) return "cn";
	if (d === "codebuddy.cn" || d.endsWith(".codebuddy.cn")) return "cn";
	if (d === "copilot.tencent.com" || d.endsWith(".copilot.tencent.com")) return "cn";
}
/** 本机可能放 WorkBuddy 登录态的位置，按区域分。 */
function authCandidates() {
	const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
	const roaming = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
	const explicit = process.env["WORKBUDDY_AUTH_FILE"];
	const list = [];
	if (explicit !== void 0 && explicit !== "") list.push(explicit);
	for (const root of [local, roaming]) {
		list.push(join(root, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop-ai.info"));
		list.push(join(root, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"));
	}
	return [...new Set(list)];
}
/**
* 解析一份 auth 文件。
*
* **真实结构是嵌套的**（实测 2026-10-27，`workbuddy-desktop-ai.info`）：
*
* ```jsonc
* {
*   "account": { "uid": "...", "nickname": { "$wbEncrypted": 1, "envelope": "..." }, ... },
*   "auth": {
*     "accessToken":  { "$wbEncrypted": 1, "envelope": "..." },
*     "refreshToken": { "$wbEncrypted": 1, "envelope": "..." },
*     "domain": "www.workbuddy.ai",
*     "expiresIn": 31465393,          // 相对秒数，不是绝对时间戳
*     "lastRefreshTime": 1793069057595
*   }
* }
* ```
*
* 注意三点，都是踩过的：
* 1. token 与 domain 在 `auth` 下，不在顶层
* 2. `expiresIn` 是相对秒数 —— 绝对过期时间要 `lastRefreshTime + expiresIn * 1000`
* 3. **加密 token 不等于「没有 token」**：新版桌面端把 accessToken 换成
*    `{"$wbEncrypted":1,"envelope":"…"}` 的 AES-256-GCM 信封。这里如实报告
*    `kind: "encrypted"` 并把信封交出去，让调用方决定怎么解 —— 绝不内置密钥副本。
*
* 同时兼容旧版平铺结构（顶层直接有 `accessToken` / `domain`）。
*/
function parseAuthDocument(text) {
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return { kind: "missing" };
	}
	const auth = typeof doc["auth"] === "object" && doc["auth"] !== null ? doc["auth"] : doc;
	const region = regionOfDomain(typeof auth["domain"] === "string" ? auth["domain"] : "");
	const raw = auth["accessToken"];
	const expiresAtMs = absoluteExpiry(auth);
	const refreshRaw = auth["refreshToken"];
	if (typeof raw === "string" && raw !== "") return {
		kind: "plain",
		...region === void 0 ? {} : { region },
		token: raw,
		...typeof refreshRaw === "string" ? { refreshToken: refreshRaw } : {},
		...expiresAtMs === void 0 ? {} : { expiresAtMs }
	};
	if (isEncryptedField$1(raw)) return {
		kind: "encrypted",
		...region === void 0 ? {} : { region },
		envelope: raw.envelope,
		...expiresAtMs === void 0 ? {} : { expiresAtMs }
	};
	return {
		kind: "missing",
		...region === void 0 ? {} : { region }
	};
}
/** `{"$wbEncrypted":1,"envelope":"…"}` 的形状判定。 */
function isEncryptedField$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const rec = value;
	return rec["$wbEncrypted"] !== void 0 && typeof rec["envelope"] === "string";
}
/**
* 绝对过期时间。
*
* 新结构给的是 `expiresIn`（相对秒）+ `lastRefreshTime`（毫秒），必须相加；
* 旧结构直接给 `expiresAt`。两者都拿不到就不返回 —— 不猜。
*/
function absoluteExpiry(auth) {
	if (typeof auth["expiresAt"] === "number") return auth["expiresAt"];
	const last = auth["lastRefreshTime"];
	const ttl = auth["expiresIn"];
	if (typeof last === "number" && typeof ttl === "number") return last + ttl * 1e3;
}
/** 扫描候选路径，返回第一个能读到的凭据及其来源路径。 */
function detectCredential() {
	for (const path of authCandidates()) {
		if (!existsSync(path)) continue;
		try {
			return {
				path,
				parsed: parseAuthDocument(readFileSync(path, "utf8"))
			};
		} catch {
			continue;
		}
	}
}
// src/channels/workbuddy/token-store.ts
/** 账号 uid → 存储文件名（sha256 前 12 hex，稳定且不可逆推 uid）。 */
function workbuddyTokenPath(dshHome, accountUid) {
	const slug = createHash("sha256").update(accountUid, "utf8").digest("hex").slice(0, 12);
	return join(dshHome, HUB_DIR_NAME, "workbuddy-tokens", `${slug}.json`);
}
/** 把解密后的 token 落成文件（0600），返回路径。 */
function writeWorkbuddyTokenFile(dshHome, token) {
	const dir = join(dshHome, HUB_DIR_NAME, "workbuddy-tokens");
	mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	const path = workbuddyTokenPath(dshHome, token.accountUid);
	const domain = token.region === "global" ? "www.workbuddy.ai" : "www.workbuddy.cn";
	const doc = {
		auth: {
			accessToken: token.accessToken,
			...token.refreshToken === void 0 ? {} : { refreshToken: token.refreshToken },
			domain,
			...token.expiresAtMs === void 0 ? {} : { expiresAt: token.expiresAtMs }
		},
		account: {
			uid: token.accountUid,
			...token.nickname === void 0 ? {} : { nickname: token.nickname }
		}
	};
	writeFileSync(path, JSON.stringify(doc), {
		encoding: "utf8",
		mode: 384
	});
	return path;
}
// src/channels/workbuddy/identity.ts
/**
* 读一份 token/vault 文件的身份。读不了返回 undefined（fail-soft）。
*
* uid 只认**明文**：`{$wbEncrypted}` 信封在这里不解密 —— 解密是
* `at-rest.ts` 的职责，读身份的路径不该有副作用。
*/
function identityOfTokenFile(path) {
	try {
		const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
		const account = typeof doc["account"] === "object" && doc["account"] !== null ? doc["account"] : void 0;
		const auth = typeof doc["auth"] === "object" && doc["auth"] !== null ? doc["auth"] : void 0;
		const uid = typeof account?.["uid"] === "string" && account["uid"] !== "" ? account["uid"] : void 0;
		const nickname = typeof account?.["nickname"] === "string" && account["nickname"] !== "" ? account["nickname"] : void 0;
		const region = (typeof auth?.["domain"] === "string" ? auth["domain"] : "").endsWith(".cn") ? "cn" : "global";
		const expiresAtRaw = auth?.["expiresAt"];
		const expiresAtMs = typeof expiresAtRaw === "number" ? expiresAtRaw : void 0;
		return {
			...uid === void 0 ? {} : { uid },
			...nickname === void 0 ? {} : { nickname },
			region,
			...expiresAtMs === void 0 ? {} : { expiresAtMs }
		};
	} catch {
		return;
	}
}
/**
* 列出 `<dshHome>/model-hub/workbuddy-tokens/` 下全部可用账号。
*
* **这是启动登记的唯一账号来源**：换号登录后一键认证会把新账号写进这个目录，
* 因此「目录里有几个可读账号」就等于「本机有几个已接管账号」。启动时按它
* 全量登记，而不是只登记「当前登录的那一个」—— 后者正是老账号被顶掉的原因。
*
* 坏文件跳过（fail-soft），目录不存在返回空数组。
*/
function listTokenStoreEntries(dshHome) {
	const dir = join(dshHome, HUB_DIR_NAME, "workbuddy-tokens");
	let names;
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		const source = join(dir, name);
		try {
			const parsed = parseAuthDocument(readFileSync(source, "utf8").replace(/^\uFEFF/, ""));
			if (parsed.kind !== "plain" || parsed.token === void 0) continue;
			const identity = identityOfTokenFile(source);
			if (identity === void 0) continue;
			out.push({
				source,
				slug: name.slice(0, -5),
				identity,
				accessToken: parsed.token,
				...parsed.refreshToken === void 0 ? {} : { refreshToken: parsed.refreshToken }
			});
		} catch {
			continue;
		}
	}
	return out;
}
/** uid → 稳定 id 后缀（与 token 文件名同源，便于人眼对上）。 */
function accountIdSuffixOf(uid) {
	return `wb-${createHash("sha256").update(uid, "utf8").digest("hex").slice(0, 12)}`;
}
/**
* 按「凭据文件 + uid」在库里找已有账号 id（**含软删**：软删的账号也要认出来，
* 否则会「新建」一个 id 不同、指向同一凭据文件的行 —— 用户删掉的账号重启后
* 就复活了，等于删除按钮失效）。
*
* 判定顺序（越靠前越可靠）：
*   1. **同一个凭据文件** → 复用该行 id。同一文件必然是同一账号，这是最强的
*      证据；而且它守住了软删语义（老版明文 auth 文件没有 uid，只能靠路径认）。
*   2. 已有行的凭据文件里 `account.uid` 与目标相同 → 复用该行 id
*      （覆盖 `:default`、历史文件名 id 等一切旧规则）。
*   3. 库里存在「按 uid 派生出来的那个 id」→ 复用它。
*   4. 都没有 → undefined（调用方新建）。
*/
function resolveAccountId(db, channelId, uid, source) {
	const derived = uid === void 0 ? void 0 : `${channelId}:${accountIdSuffixOf(uid)}`;
	const rows = db.prepare("SELECT id, credential_ref FROM accounts WHERE channel_id = ?").all(channelId);
	if (source !== void 0 && source !== "") {
		const needle = source.toLowerCase();
		const sameFile = rows.find((row) => row.credential_ref !== null && row.credential_ref.toLowerCase() === needle);
		if (sameFile !== void 0) return sameFile.id;
	}
	if (uid !== void 0) for (const row of rows) {
		if (row.credential_ref === null || row.credential_ref === "") continue;
		if (identityOfTokenFile(row.credential_ref)?.uid === uid) return row.id;
	}
	if (derived !== void 0 && rows.some((row) => row.id === derived)) return derived;
}
// src/store/dedupe.ts
/**
* 把重复账号收敛成一行。返回做了什么（供日志与测试断言）。
*
* 只在 WorkBuddy 渠道上做 —— Qoder 的 `credential_ref` 是一个 PAT 文件，
* 但同一 PAT 理论上可以被两个账号引用（用户手动贴两次），那是用户的显式
* 选择，不该被静默合并；WorkBuddy 的 token 文件按 uid 命名，同一文件
* 必然同一账号，合并是安全的。
*/
function dedupeAccountsByCredential(db, channelId) {
	const rows = db.prepare("SELECT id, channel_id, credential_ref, is_current, last_ok_at, created_at FROM accounts WHERE channel_id = ? AND deleted = 0").all(channelId);
	const groups = /* @__PURE__ */ new Map();
	for (const row of rows) {
		if (row.credential_ref === null || row.credential_ref === "") continue;
		const uid = identityOfTokenFile(row.credential_ref)?.uid;
		const key = uid === void 0 ? `file:${row.credential_ref.toLowerCase()}` : `uid:${uid}`;
		const bucket = groups.get(key);
		if (bucket === void 0) groups.set(key, [row]);
		else bucket.push(row);
	}
	const report = {
		removed: [],
		kept: []
	};
	for (const bucket of groups.values()) {
		if (bucket.length < 2) continue;
		const [keep, ...drop] = [...bucket].sort((a, b) => {
			if (a.is_current !== b.is_current) return b.is_current - a.is_current;
			const aOk = a.last_ok_at ?? -1;
			const bOk = b.last_ok_at ?? -1;
			if (aOk !== bOk) return bOk - aOk;
			return a.created_at - b.created_at;
		});
		if (keep === void 0) continue;
		db.exec("BEGIN");
		try {
			for (const gone of drop) {
				migrateAccountUsage(db, gone.id, keep.id);
				db.prepare("UPDATE accounts SET deleted = 1, enabled = 0, is_current = 0 WHERE id = ?").run(gone.id);
				report.removed.push(gone.id);
			}
			db.prepare("UPDATE accounts SET deleted = 0, enabled = 1 WHERE id = ?").run(keep.id);
			db.exec("COMMIT");
			report.kept.push(keep.id);
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	return report;
}
/**
* 把 `from` 账号名下的请求与聚合改挂到 `to` 账号上。
*
* 明细表 `requests` 直接 UPDATE（它没有 (account_id) 唯一约束）；
* 聚合表 `daily_rollups` 的主键含 account_id，先加后删。
*/
function migrateAccountUsage(db, from, to) {
	db.prepare("UPDATE requests SET account_id = ? WHERE account_id = ?").run(to, from);
	const dup = db.prepare("SELECT date, channel_id, model, req_count, ok_count, tokens, cost_units FROM daily_rollups WHERE account_id = ?").all(from);
	for (const row of dup) db.prepare(`INSERT INTO daily_rollups (date, channel_id, model, account_id, req_count, ok_count, tokens, cost_units)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date, channel_id, model, account_id) DO UPDATE SET
         req_count = req_count + excluded.req_count,
         ok_count = ok_count + excluded.ok_count,
         tokens = tokens + excluded.tokens,
         cost_units = cost_units + excluded.cost_units`).run(row.date, row.channel_id, row.model, to, row.req_count, row.ok_count, row.tokens, row.cost_units);
	db.prepare("DELETE FROM daily_rollups WHERE account_id = ?").run(from);
}
// src/channels/workbuddy/vault.ts
/**
* 从 vault json 提取账号身份。只有**明文字符串**才算数：
* 新版桌面端把 nickname 也换成 `{$wbEncrypted}` 信封，那种在这里视为未知，
* 调用方退回 uid 前缀或文件名 —— 绝不在这里尝试解密。
*/
function vaultIdentityOf(doc) {
	const account = doc["account"];
	if (typeof account !== "object" || account === null) return {};
	const rec = account;
	const uid = typeof rec["uid"] === "string" && rec["uid"] !== "" ? rec["uid"] : void 0;
	const nickname = typeof rec["nickname"] === "string" && rec["nickname"] !== "" ? rec["nickname"] : void 0;
	return {
		...uid === void 0 ? {} : { uid },
		...nickname === void 0 ? {} : { nickname }
	};
}
/** vault 的区域目录，扫描顺序与旧 readWorkbuddyVault 一致（global 优先）。 */
const VAULT_REGIONS = ["global", "cn"];
/**
* vault 下全部可用的账号条目（多账号）。
*
* 按区域遍历全部 `.json`，只收「明文（plain）且有 token」的条目；
* 坏文件 / 缺 auth / token 不是非空字符串的一律跳过（fail-soft，不抛）。
* 目录不存在返回空数组。
*/
function listVaultEntries(root = join(resolveDshHome(), "workbuddy-vault")) {
	const out = [];
	for (const region of VAULT_REGIONS) {
		const dir = join(root, region);
		let names;
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}
		for (const name of names) {
			const source = join(dir, name);
			try {
				const doc = JSON.parse(readFileSync(source, "utf8"));
				const auth = doc["auth"];
				const token = auth?.["accessToken"];
				if (typeof token !== "string" || token === "") continue;
				const refreshToken = auth?.["refreshToken"];
				const expiresAtRaw = auth?.["expiresAt"];
				const expiresAt = typeof expiresAtRaw === "number" ? expiresAtRaw * 1e3 : void 0;
				out.push({
					accountId: name.slice(0, -5),
					source,
					region,
					identity: vaultIdentityOf(doc),
					parsed: {
						kind: "plain",
						region,
						token,
						...typeof refreshToken === "string" ? { refreshToken } : {},
						...expiresAt === void 0 ? {} : { expiresAtMs: expiresAt }
					}
				});
			} catch {
				continue;
			}
		}
	}
	return out;
}
/**
* 取一个「当前可用」的 vault 条目 —— `listVaultEntries` 的首条包装，行为不变。
*
* 返回 `undefined` 表示没找到可用的 vault 条目 —— 调用方应当如实报告
* 「需要先装 WorkBuddy 桌面端登录一次」，而不是假装成功。
*/
function readWorkbuddyVault(preferredRegion) {
	const entries = listVaultEntries();
	const first = (preferredRegion === void 0 ? entries : entries.filter((e) => e.region === preferredRegion))[0];
	return first === void 0 ? void 0 : {
		source: first.source,
		parsed: first.parsed
	};
}
// src/channels/workbuddy/at-rest.ts
/**
* WorkBuddy 桌面端「at-rest」加密凭据的**内置解密**（不依赖 dsh-connect-workbuddy）。
*
* ## 协议（WorkBuddy 5.6+，实测 2026-10-29 本机取密钥成功）
*
* 桌面端不再以明文保存 `auth.accessToken` / `auth.refreshToken`，而是写：
*
*   { "$wbEncrypted": 1, "envelope": "<base64(JSON {suite,keyId,nonce,authTag,ciphertext})>" }
*
* AES-256-GCM（12 字节 nonce、16 字节 tag），AAD 是「scheme/suite/keyId/framing」
* 的长度前缀转录 —— 同一段密文只能解开成它当初封印的字段形状。
*
* 字段密钥**不是用户秘密**：它是 App 构建期编进 native 模块
* `electron_browser_workbuddy_storage` 的常量，App 自己通过 `loggerGet()` 取。
* 这里用同样方式向**已安装的同一个 App 二进制**要这份 payload（以
* `ELECTRON_RUN_AS_NODE=1` 跑成纯 Node 调 `process._linkedBinding`），
* 对 payload 里 `atRestSecretKey` 的 **base64 字符串**（不是解码字节）取
* SHA-256 得到 32 字节 key；`keyId` = key 的 SHA-256 前 16 个 hex。
*
* 每一层都 fail-loud：信封畸形 / keyId 不匹配 / GCM tag 校验失败都抛错，
* 绝不降级成截断的 token。密钥只在内存缓存，永不落盘、不进日志。
*/
/** AAD 转录的域分隔符。 */
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
/** 字段（field）framing 的标准格式标识。 */
const STANDARD_FORMAT_ID_FIELD = "WBEV1";
/** 对称信封的 scheme 名。 */
const SYMMETRIC_SCHEME = "sym-v1";
/** framing 名 → AAD 单字节码（field = 2）。 */
const FRAMING_CODE_FIELD = 2;
/** 向 App 要密钥 payload 的超时。 */
const KEY_FETCH_TIMEOUT_MS = 1e4;
/** App 的 native 模块取值脚本（与 dsh-connect-workbuddy 同款调用方式）。 */
const LOGGER_GET_SCRIPT = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";
function encodeUint32(value) {
	const bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32BE(value);
	return bytes;
}
function encodeLengthPrefixed(value) {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([encodeUint32(bytes.length), bytes]);
}
/** field-framed 信封的 AAD 转录。 */
function fieldAad(keyId, suite) {
	if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("workbuddy: envelope keyId is malformed");
	return Buffer.concat([
		AAD_DOMAIN,
		Buffer.from([1]),
		encodeLengthPrefixed(STANDARD_FORMAT_ID_FIELD),
		encodeLengthPrefixed(SYMMETRIC_SCHEME),
		encodeUint32(suite),
		encodeLengthPrefixed(keyId),
		Buffer.from([FRAMING_CODE_FIELD]),
		Buffer.from([0]),
		Buffer.from([0])
	]);
}
/** `{ "$wbEncrypted": 1, "envelope": "…" }` 的形状判定。 */
function isEncryptedField(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapper = value;
	const keys = Object.keys(wrapper).sort();
	return keys.length === 2 && keys[0] === "$wbEncrypted" && keys[1] === "envelope" && wrapper["$wbEncrypted"] === 1 && typeof wrapper["envelope"] === "string";
}
/** 由 App 的密钥 payload JSON 派生 32 字节 key 与 keyId。 */
function deriveAtRestKey(payloadJson) {
	let payload;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new Error("workbuddy: at-rest key payload is not valid JSON");
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("workbuddy: at-rest key payload is not an object");
	const secret = payload["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") throw new Error("workbuddy: at-rest key payload carries no atRestSecretKey");
	const key = createHash("sha256").update(secret, "utf8").digest();
	return {
		key,
		keyId: createHash("sha256").update(key).digest("hex").slice(0, 16)
	};
}
/** 用派生 key 打开一个加密字段，返回明文字符串。 */
function openEncryptedField(field, key) {
	let envelope;
	try {
		envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
	} catch {
		throw new Error("workbuddy: encrypted field envelope is not valid JSON");
	}
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) throw new Error("workbuddy: encrypted field envelope is not an object");
	const suite = envelope["suite"];
	const keyId = envelope["keyId"];
	const nonce = envelope["nonce"];
	const authTag = envelope["authTag"];
	const ciphertext = envelope["ciphertext"];
	if (typeof suite !== "number" || typeof keyId !== "string") throw new Error("workbuddy: encrypted field envelope is missing suite or keyId");
	if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") throw new Error("workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext");
	const expectedKeyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
	if (keyId !== expectedKeyId) throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`);
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
	decipher.setAAD(fieldAad(keyId, suite));
	decipher.setAuthTag(Buffer.from(authTag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
/** App 可执行文件候选（Windows）。`WORKBUDDY_APP_EXECUTABLE` 显式指定优先。 */
function workbuddyAppCandidates(env = process.env) {
	const list = [];
	const explicit = env["WORKBUDDY_APP_EXECUTABLE"];
	if (explicit !== void 0 && explicit !== "") list.push(explicit);
	const local = env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
	const names = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
	for (const sub of [
		["Programs", "WorkBuddy"],
		["WorkBuddy"],
		["Programs", "WorkBuddyAI"],
		["WorkBuddyAI"]
	]) for (const name of names) list.push(join(local, ...sub, name));
	return [...new Set(list)];
}
/** 探测已安装的 App 可执行文件；都没有返回 undefined。 */
function findWorkbuddyExecutable(env = process.env, exists = existsSync) {
	return workbuddyAppCandidates(env).find((path) => exists(path));
}
/** 进程级密钥缓存：同一个 exe 只问一次。 */
const keyCache = /* @__PURE__ */ new Map();
/** 向 App 的 native binding 要密钥 payload（子进程 stdout 是唯一读取面）。 */
function fetchAtRestKeyPayload(executable, execFileImpl = execFile) {
	return new Promise((resolve, reject) => {
		execFileImpl(executable, ["-e", LOGGER_GET_SCRIPT], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			},
			timeout: KEY_FETCH_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 1048576
		}, (error, stdout, stderr) => {
			if (error !== null) {
				reject(/* @__PURE__ */ new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`));
				return;
			}
			const payload = stdout.trim();
			if (payload === "") {
				reject(/* @__PURE__ */ new Error("workbuddy: the desktop app returned an empty at-rest key payload"));
				return;
			}
			resolve(payload);
		});
	});
}
/** 取（并缓存）这把机器上的 at-rest key。 */
async function loadAtRestKey(deps = {}) {
	if (deps.keyPayload !== void 0) return deriveAtRestKey(await deps.keyPayload());
	const executable = deps.executable ?? findWorkbuddyExecutable(deps.env, deps.existsImpl ?? existsSync);
	if (executable === void 0) throw new Error("workbuddy: 没有找到已安装的 WorkBuddy 桌面端（用于取 at-rest 密钥）");
	const cached = keyCache.get(executable);
	if (cached !== void 0) return cached;
	const derived = deriveAtRestKey(await fetchAtRestKeyPayload(executable, deps.execFileImpl ?? execFile));
	keyCache.set(executable, derived);
	return derived;
}
/**
* 解开一份 auth/vault 文档里的加密字段。
*
* - `accessToken` 是明文字符串 → 原样返回（不需要 App）。
* - 是 `{$wbEncrypted}` 信封 → 向 App 要 key 后 AES-GCM 解开。
* - `refreshToken`/`account.nickname` 同为信封时一并解；解不开就如实抛错。
*/
async function decryptAuthDocument(doc, deps = {}) {
	const auth = typeof doc["auth"] === "object" && doc["auth"] !== null ? doc["auth"] : doc;
	const account = typeof doc["account"] === "object" && doc["account"] !== null ? doc["account"] : void 0;
	const uid = typeof account?.["uid"] === "string" && account["uid"] !== "" ? account["uid"] : void 0;
	const rawNickname = account?.["nickname"];
	const rawToken = auth["accessToken"];
	if (typeof rawToken === "string" && rawToken !== "") return {
		accessToken: rawToken,
		...typeof auth["refreshToken"] === "string" ? { refreshToken: auth["refreshToken"] } : {},
		...typeof rawNickname === "string" ? { nickname: rawNickname } : {},
		...uid === void 0 ? {} : { accountUid: uid },
		decrypt: false
	};
	if (!isEncryptedField(rawToken)) throw new Error("workbuddy: auth.accessToken 既不是明文也不是可解的信封");
	const { key } = await loadAtRestKey(deps);
	const out = {
		accessToken: openEncryptedField(rawToken, key),
		decrypt: true,
		...uid === void 0 ? {} : { accountUid: uid }
	};
	const refreshRaw = auth["refreshToken"];
	if (typeof refreshRaw === "string" && refreshRaw !== "") out.refreshToken = refreshRaw;
	else if (isEncryptedField(refreshRaw)) out.refreshToken = openEncryptedField(refreshRaw, key);
	if (typeof rawNickname === "string" && rawNickname !== "") out.nickname = rawNickname;
	else if (isEncryptedField(rawNickname)) out.nickname = openEncryptedField(rawNickname, key);
	return out;
}
/** auth 文档的 `auth.domain` → 区域（缺省 global）。 */
function regionOfAuthDocument(doc) {
	const auth = typeof doc["auth"] === "object" && doc["auth"] !== null ? doc["auth"] : doc;
	return regionOfDomain(typeof auth["domain"] === "string" ? auth["domain"] : "") ?? "global";
}
/** 生产路径：读文件（去 BOM）→ 内置解密 → 附带区域与过期时间。 */
async function realDecryptAuthFile(path, deps = {}) {
	const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	const doc = JSON.parse(text);
	const decrypted = await decryptAuthDocument(doc, deps);
	const parsed = parseAuthDocument(text);
	return {
		...decrypted,
		region: regionOfAuthDocument(doc),
		...parsed.expiresAtMs === void 0 ? {} : { expiresAtMs: parsed.expiresAtMs }
	};
}
// src/channels/qoder/cosy.ts
/**
* Qoder 的 COSY 签名层。
*
* ## 协议（从 `dsh-connect` 的 Qoder 实现核对，并已实测打通）
*
* Qoder 的网关**不是** `Authorization: Bearer <token>`，而是自研的 COSY 签名：
*
* ```
* aesKey     = 随机 16 字符
* info       = AES-128-CBC(JSON({uid,security_oauth_token,name,aid,email}), key=iv=aesKey) → base64
* cosyKey    = RSA_PKCS1(aesKey, 内置公钥) → base64
* payloadB64 = base64(JSON({version:"v1", requestId, info, cosyVersion, ideVersion:""}))
* sig        = md5(payloadB64 \n cosyKey \n 秒级时间戳 \n bodyBytes \n sigPath)
* Authorization: Bearer COSY.<payloadB64>.<sig>
* ```
*
* 外加一整组 `Cosy-*` 头。**`sigPath` 是 pathname 去掉前导 `/algo`，且不含 query** ——
* 这一点写错会拿到 401 而不是 404，非常容易误判成 token 失效。
*
* ## 请求体编码（URL 上的 `Encode=1`）
*
* 先标准 base64，再按 Qoder 自定义字母表重映射（`=` → `$`），
* 最后三段块旋转 `[n-a,n) [a,n-a) [0,a)`，`a = floor(n/3)`。
* 签名覆盖的 `bodyBytes` 必须是**编码后**的那份。
*/
/** 自定义字母表：第 i 个字符替代标准 base64 的第 i 个字符。 */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** 只映射 base64 用得到的字符；其余保持恒等。 */
function buildTables() {
	const enc = /* @__PURE__ */ new Uint8Array(256);
	const dec = /* @__PURE__ */ new Uint8Array(256);
	for (let i = 0; i < 256; i += 1) {
		enc[i] = i;
		dec[i] = i;
	}
	for (let i = 0; i < 64; i += 1) {
		enc[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
		dec[CUSTOM_ALPHABET.charCodeAt(i)] = STD_ALPHABET.charCodeAt(i);
	}
	enc["=".charCodeAt(0)] = "$".charCodeAt(0);
	dec["$".charCodeAt(0)] = "=".charCodeAt(0);
	return {
		enc,
		dec
	};
}
const { enc: ENC_TABLE, dec: DEC_TABLE } = buildTables();
/** 请求体编码：标准 base64 → 字母表重映射 → 三段块旋转。 */
function qoderEncodeBody(plain) {
	const std = Buffer.isBuffer(plain) ? plain.toString("base64") : Buffer.from(plain, "utf8").toString("base64");
	const n = std.length;
	const a = Math.floor(n / 3);
	const out = Buffer.allocUnsafe(n);
	let dst = 0;
	for (let i = n - a; i < n; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
	for (let i = a; i < n - a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
	for (let i = 0; i < a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
	return out;
}
/** 签名只覆盖 pathname 去掉前导 `/algo`，不含 query。 */
function sigPathOf(url) {
	const path = new URL(url).pathname;
	return path.startsWith("/algo") ? path.slice(5) : path;
}
/** COSY 内置 RSA 公钥（用来加密临时的 aesKey）。与 Qoder CLI 同一份。 */
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
/**
* 客户端身份版本号。
*
* ⚠️ 硬编码契约：`Cosy-Version` 落后于 Qoder CLI 当前版本时，服务端会返回
* 被裁剪过的模型列表。随 CLI 升级要复核（实测 2026-10-28 用 1.1.38 正常）。
*/
const COSY_VERSION = "1.1.38";
/** OpenAPI 平面（PAT 交换 / userinfo）用的是另一条版本线。 */
const COSY_OPENAPI_VERSION = "1.0.1";
const COSY_DATA_POLICY = "disagree";
function machineOs() {
	if (process.platform === "win32") return process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
	if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
	return process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}
/**
* 生成 `Authorization: Bearer COSY.<payloadB64>.<sig>` 与配套 `Cosy-*` 头。
*
* `body` 必须是**最终要发出去的字节**（已经过 {@link qoderEncodeBody}），
* 因为签名与 `Cosy-Bodyhash` / `Cosy-Bodylength` 都覆盖它。
*/
function buildCosyHeaders(body, requestUrl, creds) {
	if (typeof creds.userID !== "string" || creds.userID.length === 0) throw new Error("cosy: userID 为空");
	if (typeof creds.authToken !== "string" || creds.authToken.length === 0) throw new Error("cosy: authToken 为空");
	const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
	const userInfo = {
		uid: creds.userID,
		security_oauth_token: creds.authToken,
		name: creds.name ?? "",
		aid: "",
		email: creds.email ?? ""
	};
	const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
	const infoB64 = cipher.update(JSON.stringify(userInfo), "utf8", "base64") + cipher.final("base64");
	const cosyKey = publicEncrypt({
		key: QODER_RSA_PUBLIC_KEY,
		padding: 1
	}, Buffer.from(aesKey)).toString("base64");
	const ts = String(Math.floor(Date.now() / 1e3));
	const payloadB64 = Buffer.from(JSON.stringify({
		version: "v1",
		requestId: randomUUID(),
		info: infoB64,
		cosyVersion: COSY_VERSION,
		ideVersion: ""
	})).toString("base64");
	const bodyBytes = body === null || body === void 0 ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
	const sigPath = sigPathOf(requestUrl);
	const sig = createHash("md5").update(payloadB64).update("\n").update(cosyKey).update("\n").update(ts).update("\n").update(bodyBytes).update("\n").update(sigPath).digest("hex");
	const machineId = creds.machineID ?? "dsh-model-hub-machine";
	return {
		Authorization: `Bearer COSY.${payloadB64}.${sig}`,
		"Cosy-Key": cosyKey,
		"Cosy-User": creds.userID,
		"Cosy-Date": ts,
		"Cosy-Version": COSY_VERSION,
		"Cosy-Machineid": machineId,
		"Cosy-Machinetoken": machineId,
		"Cosy-Machinetype": "5",
		"Cosy-Machineos": machineOs(),
		"Cosy-Clienttype": "5",
		"Cosy-Clientip": "127.0.0.1",
		"Cosy-Bodyhash": createHash("md5").update(bodyBytes).digest("hex"),
		"Cosy-Bodylength": String(bodyBytes.length),
		"Cosy-Sigpath": sigPath,
		"Cosy-Data-Policy": COSY_DATA_POLICY,
		"Cosy-Organization-Id": "",
		"Cosy-Organization-Tags": "",
		"Login-Version": "v2",
		"X-Request-Id": randomUUID()
	};
}
// src/channels/qoder/credentials.ts
/**
* Qoder 凭据：PAT → jobToken 的交换与缓存。
*
* ## 链路
*
* ```
* PAT(pt-…) ──POST /api/v1/jobToken/exchange──▶ jobToken(jt-…, 24 小时)
*                                            └─▶ userinfo（取 uid，COSY 签名要用）
* ```
*
* PAT 在 <https://qoder.com.cn/account/integrations> 自建，是官方支持的通道。
* **PAT 不会自动续**（Qoder 官方明确「The SDK does not refresh PATs」），
* 过期就在网页上重新生成一个；jobToken 那一层由这里自己刷。
*
* ## PAT 从哪读
*
* 1. `$DSH_HOME/qoder/pat`（本机实际位置）
* 2. 环境变量 `QODERCN_PAT` / `QODERCN_PERSONAL_ACCESS_TOKEN` / `QODERCN_API_KEY`
*
* 只读明文 PAT，不碰 Qoder App 的目录（那边是 Electron safeStorage 密文）。
*/
const DEFAULT_OPENAPI = "https://openapi.qoder.com.cn";
const PATH_EXCHANGE = "/api/v1/jobToken/exchange";
const PATH_USERINFO = "/api/v1/userinfo";
/** 换来的 jobToken 剩不到这个时长就提前重换。 */
const SKEW_MS = 12e4;
/** 拿不到有效期时的保守值。 */
const ASSUMED_TTL_MS = 18e5;
function resolveDshHome$1() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** 按优先级找 PAT；找不到返回 undefined（不抛）。 */
function readPat() {
	const fromEnv = [
		"QODERCN_PAT",
		"QODERCN_PERSONAL_ACCESS_TOKEN",
		"QODERCN_API_KEY"
	].map((name) => ({
		name,
		value: process.env[name]
	})).find((entry) => typeof entry.value === "string" && entry.value.trim().startsWith("pt-"));
	if (fromEnv?.value !== void 0) return {
		pat: fromEnv.value.trim(),
		source: `env:${fromEnv.name}`
	};
	const candidates = [join(resolveDshHome$1(), "qoder", "pat"), join(homedir(), ".qoder", "pat")];
	for (const path of candidates) try {
		const value = readFileSync(path, "utf8").trim();
		if (value.startsWith("pt-")) return {
			pat: value,
			source: path
		};
	} catch {}
}
/**
* 目录下全部 `.pat` 文件；内容必须 `pt-` 开头才算（坏文件/非 PAT 文件 fail-soft 跳过）。
*
* 多账号的形态：`<dshHome>/model-hub/qoder-pats/*.pat`，一个文件一个账号。
* 目录不存在或读不了返回空数组（不抛）。
*/
function listPatFiles(dir) {
	let names = [];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".pat"));
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		const source = join(dir, name);
		try {
			const value = readFileSync(source, "utf8").trim();
			if (value.startsWith("pt-")) out.push({
				name,
				pat: value,
				source
			});
		} catch {}
	}
	return out;
}
/**
* `expires_at` 可能是 ISO 串、秒级或毫秒级数字；`expires_in` 可能是秒或毫秒。
* 读不出来就返回 undefined（调用方按保守值处理）。
*/
function resolveExpiry(doc) {
	const at = doc["expires_at"];
	if (typeof at === "string") {
		const parsed = Date.parse(at);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof at === "number" && Number.isFinite(at)) return at < 0xe8d4a51000 ? at * 1e3 : at;
	const rel = doc["expires_in"];
	if (typeof rel === "number" && Number.isFinite(rel) && rel > 0) return Date.now() + (rel < 1e6 ? rel * 1e3 : rel);
}
/** 一次 PAT 交换 + userinfo。多账号场景按 PAT 逐个验活也走这里。 */
async function exchangePat(pat, source, openapiBase = DEFAULT_OPENAPI) {
	const response = await fetch(`${openapiBase}${PATH_EXCHANGE}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": "dsh-model-hub",
			"Cosy-Version": COSY_OPENAPI_VERSION,
			"Cosy-ClientType": "5"
		},
		body: JSON.stringify({ personal_token: pat }),
		signal: AbortSignal.timeout(2e4)
	});
	const text = await response.text();
	if (!response.ok) {
		const brief = text.replace(/\s+/g, " ").slice(0, 200);
		throw new Error(response.status === 401 || response.status === 403 ? `PAT 被拒绝（HTTP ${response.status}），可能已吊销或填错：${brief}` : `PAT 交换失败（HTTP ${response.status}）：${brief}`);
	}
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new Error(`PAT 交换返回的不是 JSON：${text.slice(0, 200)}`);
	}
	const jobToken = typeof doc["token"] === "string" ? doc["token"].trim() : "";
	if (jobToken === "") throw new Error(`PAT 交换没有返回 token：${text.slice(0, 200)}`);
	let userID = "";
	let name = "";
	let email = "";
	try {
		const infoResponse = await fetch(`${openapiBase}${PATH_USERINFO}`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${jobToken}`,
				"User-Agent": "dsh-model-hub",
				"Cosy-Version": COSY_OPENAPI_VERSION,
				"Cosy-ClientType": "5"
			},
			signal: AbortSignal.timeout(2e4)
		});
		if (infoResponse.ok) {
			const info = await infoResponse.json();
			userID = typeof info["id"] === "string" ? info["id"] : "";
			name = typeof info["name"] === "string" ? info["name"] : "";
			email = typeof info["email"] === "string" ? info["email"] : "";
		}
	} catch {}
	if (userID === "") throw new Error("userinfo 没拿到 uid —— COSY 签名需要它，检查 PAT 权限");
	return {
		jobToken,
		userID,
		name,
		email,
		expiresAt: resolveExpiry(doc) ?? Date.now() + ASSUMED_TTL_MS,
		source
	};
}
/**
* jobToken 管理器：单飞 + 提前重换。
*
* 并发调用只会打一次上游；快过期时自动重换，调用方永远拿到可用的 session。
*
* `readCredential` 可注入凭据源（多账号时每个账号一个管理器、各指一个 PAT）；
* 缺省 `readPat()`，行为与单账号时期完全一致。
*/
function createSessionManager(options = {}) {
	const openapiBase = (options.openapiBase ?? DEFAULT_OPENAPI).replace(/\/+$/, "");
	const now = options.now ?? (() => Date.now());
	let cached;
	let inflight;
	return {
		/** 当前可用的 session；没有凭据时返回 undefined（不抛）。 */
		async current() {
			if (cached !== void 0 && cached.expiresAt - now() > SKEW_MS) return cached;
			if (inflight !== void 0) return inflight.catch(() => void 0);
			const found = options.readCredential?.() ?? readPat();
			if (found === void 0) return void 0;
			inflight = exchangePat(found.pat, found.source, openapiBase).then((session) => {
				cached = session;
				return session;
			}).finally(() => {
				inflight = void 0;
			});
			return inflight.catch(() => void 0);
		},
		/** 强制重换（诊断/测试用）。 */
		invalidate() {
			cached = void 0;
		},
		/** 只读快照，给诊断栏用。 */
		peek() {
			return cached;
		}
	};
}
// src/channels/trae/crypto.ts
/**
* Trae（iCube）本地登录态的解密。
*
* ## 为什么需要自己解
*
* Trae 桌面端把用户信息（含 `token`）写进 `User/globalStorage/storage.json`，
* 值是 `byteCrypto` 的 AES 信封：Base64 文本，解出来是
* `[6 字节头][32 字节密钥料][AES-128-CBC 密文]`。没有明文可读，也没有系统
* 钥匙串可以问 —— 解密是**纯算法**，密钥料就在信封里，掩码常量在客户端
* 自己的 `out/main.js`（`byteCrypto.js` 模块）里。
*
* 换句话说：这不是破译，是把 App 自己的算法在插件里重放一遍。真正的
* 边界是「能读到那个 storage.json」—— 读不到就什么都做不了，我们也只能
* 退回让用户粘贴凭据。
*
* ## 算法（与 out/main.js 的 ARe / tre 逐行对应）
*
* ```
* version = 头(74 63 05 10 00 00) → AES
* keyMaterial = blob[6 : 38]            // 32 字节
* mask        = MASK_A[i] ^ MASK_B[i]   // 64 字节常量
* h           = SHA-512( SHA-512(keyMaterial) || mask )
* aesKey      = h[0 : 16]
* iv          = h[16 : 32]
* plain       = AES-128-CBC-decrypt(aesKey, iv, blob[38 : ])
* check       = SHA-512(plain[64 : ])
* 明文         = plain[64 : ]            // 前 64 字节是自校验摘要
* ```
*
* 头不匹配、密文不是 16 的整数倍、摘要对不上，一律抛错 —— **不返回半截
* 明文**：宁可让上层报「凭据解不开」，也不要把解析失败的垃圾当成 token
* 发到上游去。
*/
/** 信封头：`t` `c` `0x05` `0x10` `0x00` `0x00`（客户端 `qP/zP/GP/JP/KP/YP`）。 */
const AES_HEADER = Buffer.from([
	116,
	99,
	5,
	16,
	0,
	0
]);
/** 头之后是 32 字节密钥料。 */
const KEY_OFFSET = 6;
/** 明文头部是 64 字节自校验摘要。 */
const DIGEST_LENGTH = 64;
const MASK_LENGTH = 64;
/** `ure`（客户端常量）。 */
const MASK_A = Buffer.from([
	82,
	9,
	106,
	213,
	48,
	54,
	165,
	56,
	191,
	64,
	163,
	158,
	129,
	243,
	215,
	251,
	124,
	227,
	57,
	130,
	155,
	47,
	255,
	135,
	52,
	142,
	67,
	68,
	196,
	222,
	233,
	203,
	84,
	123,
	148,
	50,
	166,
	194,
	35,
	61,
	238,
	76,
	149,
	11,
	66,
	250,
	195,
	78,
	8,
	46,
	161,
	102,
	40,
	217,
	36,
	178,
	118,
	91,
	162,
	73,
	109,
	139,
	209,
	37
]);
/** `dre`（客户端常量）。 */
const MASK_B = Buffer.from([
	31,
	221,
	168,
	51,
	136,
	7,
	199,
	49,
	177,
	18,
	16,
	89,
	39,
	128,
	236,
	95,
	96,
	81,
	127,
	169,
	25,
	181,
	74,
	13,
	45,
	229,
	122,
	159,
	147,
	201,
	156,
	239,
	160,
	224,
	59,
	77,
	174,
	42,
	245,
	176,
	200,
	235,
	187,
	60,
	131,
	83,
	153,
	97,
	23,
	43,
	4,
	126,
	186,
	119,
	214,
	38,
	225,
	105,
	20,
	99,
	85,
	33,
	12,
	125
]);
/** 掩码 = 两个常量异或（客户端 `CRe(VP, AES)` 的等价物）。 */
const MASK = (() => {
	const out = Buffer.alloc(MASK_LENGTH);
	for (let i = 0; i < MASK_LENGTH; i += 1) out[i] = (MASK_A[i] ?? 0) ^ (MASK_B[i] ?? 0);
	return out;
})();
function sha512(input) {
	return createHash("sha512").update(input).digest();
}
/** 这个信封是不是 Trae 的 AES 格式（只看头，不做解密）。 */
function isTraeEnvelope(envelope) {
	if (envelope.length < AES_HEADER.length) return false;
	return AES_HEADER.equals(Buffer.from(envelope.subarray(0, AES_HEADER.length)));
}
/**
* 解一个 `byteCrypto` 信封。
*
* @throws 头不匹配 / 长度不对 / 摘要校验失败
*/
function decryptEnvelope(envelope) {
	const blob = Buffer.from(envelope);
	if (!isTraeEnvelope(blob)) throw new Error("不是 Trae 的 AES 信封（头部魔数不匹配）");
	if (blob.length <= 38) throw new Error("Trae 信封过短（缺密钥料或密文）");
	const keyMaterial = blob.subarray(KEY_OFFSET, 38);
	const digest = sha512(Buffer.concat([sha512(keyMaterial), MASK]));
	const decipher = createDecipheriv("aes-128-cbc", digest.subarray(0, 16), digest.subarray(16, 32));
	const cipherText = blob.subarray(38);
	if (cipherText.length === 0 || cipherText.length % 16 !== 0) throw new Error(`Trae 信封密文长度非法（${cipherText.length} 字节，必须是 16 的整数倍）`);
	let plain;
	try {
		plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
	} catch {
		throw new Error("Trae 信封解密失败（AES 填充校验不通过）");
	}
	if (plain.length < DIGEST_LENGTH) throw new Error("Trae 信封明文过短（缺自校验摘要）");
	const expected = plain.subarray(0, DIGEST_LENGTH);
	const actual = sha512(plain.subarray(DIGEST_LENGTH));
	if (!timingSafeEqual(expected, actual)) throw new Error("Trae 信封自校验失败（内容被改过或不是本机写入的）");
	return plain.subarray(DIGEST_LENGTH);
}
/** Base64 信封 → UTF-8 明文（storage.json 里的值就是这种形态）。 */
function decryptEnvelopeBase64(value) {
	return decryptEnvelope(Buffer.from(value, "base64")).toString("utf8");
}
/**
* 读 JWT 的 `exp`（秒 → 毫秒）。
*
* 只用来提前判断「这张票还能不能用」以及面板上显示有效期；**不验签** ——
* 验签是上游的事，我们只需要知道它什么时候过期。
*/
function jwtExpiryMs(token) {
	const parts = token.split(".");
	if (parts.length !== 3) return void 0;
	try {
		const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
		return typeof payload.exp === "number" ? payload.exp * 1e3 : void 0;
	} catch {
		return;
	}
}
/** 推理网关的区域表（与 product.json 的 bootConfig.agent 同形）。 */
const TRAE_DEFAULT_GATEWAYS = {
	normal: "https://core-normal.trae.ai",
	SG: "https://coresg-normal.trae.ai",
	US: "https://coreva-normal.trae.ai",
	USTTP: "https://core-normal.traeapi.us"
};
/** CN 版历史网关（dsh-connect 时代的默认值，继续兼容它的快照）。 */
const TRAE_CN_GATEWAY = "https://trae-api-cn.mchost.guru";
function readJsonFile(path) {
	try {
		if (!existsSync(path)) return void 0;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
function str(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function num(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
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
function traeUserDataRoots() {
	const override = process.env.TRAE_USER_DATA?.trim();
	if (override !== void 0 && override !== "") return [override];
	const roots = [];
	const appData = process.env.APPDATA;
	if (appData !== void 0 && appData !== "") for (const name of [
		"TRAE SOLO",
		"TRAE SOLO CN",
		"Trae",
		"Trae CN",
		"Trae Solo"
	]) roots.push(join(appData, name));
	const home = homedir();
	roots.push(join(home, "Library", "Application Support", "TRAE SOLO"));
	roots.push(join(home, "Library", "Application Support", "TRAE SOLO CN"));
	roots.push(join(home, ".config", "TRAE SOLO"));
	return roots;
}
/** Trae 安装目录的候选位置（读 product.json 用）。 */
function traeInstallRoots() {
	const roots = [];
	const env = process.env.TRAE_HOME?.trim();
	if (env !== void 0 && env !== "") roots.push(env);
	const localAppData = process.env.LOCALAPPDATA;
	if (localAppData !== void 0 && localAppData !== "") roots.push(join(localAppData, "Programs", "TRAE SOLO"));
	const programFiles = process.env.ProgramFiles;
	if (programFiles !== void 0 && programFiles !== "") roots.push(join(programFiles, "TRAE SOLO"));
	roots.push("C:\\TRAE SOLO", "D:\\TRAE SOLO");
	roots.push("/Applications/TRAE SOLO.app/Contents/Resources/app");
	return roots;
}
/** 读 product.json：appId / buildId / 区域网关表。读不到就都返回 undefined。 */
function readTraeProductInfo() {
	for (const root of traeInstallRoots()) for (const path of [join(root, "resources", "app", "product.json"), join(root, "product.json")]) {
		const doc = readJsonFile(path);
		if (doc === void 0) continue;
		const boot = doc["bootConfig"];
		const agent = typeof boot === "object" && boot !== null ? boot["agent"] : void 0;
		const info = {};
		if (typeof agent === "object" && agent !== null) {
			const record = agent;
			const appId = str(record["appId"]);
			if (appId !== void 0) info.appId = appId;
			const gateways = {};
			for (const key of [
				"normal",
				"SG",
				"US",
				"USTTP"
			]) {
				const entry = record[key];
				const url = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null ? str(entry["normal"]) : void 0;
				if (url !== void 0 && url.startsWith("http")) gateways[key] = url;
			}
			if (Object.keys(gateways).length > 0) info.gateways = gateways;
		}
		const buildId = num(doc["buildId"]);
		if (buildId !== void 0) info.appVersionCode = buildId;
		return info;
	}
	return {};
}
/** 按区域挑推理网关：区域缺失时用 normal。 */
function gatewayFor(region, product) {
	const table = {
		...TRAE_DEFAULT_GATEWAYS,
		...product.gateways ?? {}
	};
	if (region !== void 0 && region !== "") {
		const exact = table[region];
		if (exact !== void 0) return exact;
		const upper = region.toUpperCase();
		for (const key of Object.keys(table)) if (key.toUpperCase() === upper) return table[key];
	}
	return table["normal"] ?? TRAE_CN_GATEWAY;
}
/**
* 从 storage.json 里挑出登录态并解开。
*
* 优先 `icube.cloudide`（token 所在），其次遍历所有 `iCubeAuthInfo://` 项 ——
* 后者是为了兼容不同产品线换过 key 的情况：解出来带 `token` 字符串的就是它。
*/
function readTraeSessionFromStorage(storagePath) {
	const storage = readJsonFile(storagePath);
	if (storage === void 0) return { error: `读不到 ${storagePath}` };
	const preferred = "iCubeAuthInfo://icube.cloudide";
	const keys = [preferred, ...Object.keys(storage).filter((key) => key.startsWith("iCubeAuthInfo://") && key !== preferred)];
	const failures = [];
	for (const key of keys) {
		const value = storage[key];
		if (typeof value !== "string" || value === "") continue;
		let text;
		try {
			if (!isTraeEnvelope(Buffer.from(value, "base64"))) continue;
			text = decryptEnvelopeBase64(value);
		} catch (error) {
			failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		let doc;
		try {
			doc = JSON.parse(text);
		} catch {
			continue;
		}
		const token = str(doc["token"]);
		if (token === void 0) continue;
		const product = readTraeProductInfo();
		const account = typeof doc["account"] === "object" && doc["account"] !== null ? doc["account"] : {};
		const region = str((typeof doc["userRegion"] === "object" && doc["userRegion"] !== null ? doc["userRegion"] : {})["region"]) ?? str(account["storeRegion"]) ?? void 0;
		const expiresAtMs = jwtExpiryMs(token) ?? (typeof doc["expiredAt"] === "string" ? Date.parse(doc["expiredAt"]) : void 0);
		const userId = str(doc["userId"]) ?? "";
		return { credential: {
			token,
			...str(doc["refreshToken"]) === void 0 ? {} : { refreshToken: str(doc["refreshToken"]) },
			userId,
			name: str(account["username"]) ?? userId.slice(0, 8) ?? "Trae 账号",
			...str(account["email"]) === void 0 ? {} : { email: str(account["email"]) },
			gateway: gatewayFor(region, product),
			appId: product.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
			appVersionCode: product.appVersionCode ?? 1205510027010,
			...expiresAtMs === void 0 || Number.isNaN(expiresAtMs) ? {} : { expiresAtMs },
			...region === void 0 ? {} : { region }
		} };
	}
	return failures.length > 0 ? { error: `Trae 登录态解不开（${failures[0]}）` } : { error: "Trae 登录态里没有找到 token（可能没登录过）" };
}
/** 找本机的 Trae 登录态（storage.json + state.vscdb 必须同目录才算命中）。 */
function discoverTraeSession() {
	const failures = [];
	for (const root of traeUserDataRoots()) {
		const storagePath = join(root, "User", "globalStorage", "storage.json");
		const stateDbPath = join(root, "User", "globalStorage", "state.vscdb");
		if (!existsSync(storagePath)) continue;
		const { credential, error } = readTraeSessionFromStorage(storagePath);
		if (credential === void 0) {
			failures.push(error ?? "未知原因");
			continue;
		}
		return { session: {
			storagePath,
			stateDbPath,
			credential: {
				...credential,
				source: storagePath
			}
		} };
	}
	return { error: failures.length > 0 ? failures[0] : `没有找到 Trae 登录态（找过 ${traeUserDataRoots().length} 个候选目录；装 Trae 并登录一次，或设 TRAE_USER_DATA）` };
}
/** `$DSH_HOME/connect-auth/trae.json`（dsh-connect 的快照格式）。 */
function traeConnectAuthPath(dshHome) {
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
function parseTraeCredentialDocument(doc, source) {
	const token = str(doc["token"]);
	if (token === void 0) throw new Error(`凭据文件里没有 token（${source}）`);
	const account = typeof doc["account"] === "object" && doc["account"] !== null ? doc["account"] : {};
	const product = readTraeProductInfo();
	const expiresAtMs = num(doc["expiresAtMs"]) ?? (typeof doc["expiredAt"] === "string" ? Date.parse(doc["expiredAt"]) : void 0) ?? (typeof doc["expiresAt"] === "string" ? Date.parse(doc["expiresAt"]) : void 0) ?? jwtExpiryMs(token);
	return {
		token,
		...str(doc["refreshToken"]) === void 0 ? {} : { refreshToken: str(doc["refreshToken"]) },
		userId: str(doc["userId"]) ?? "",
		name: str(doc["name"]) ?? str(account["username"]) ?? "Trae 账号",
		...str(doc["email"]) === void 0 && str(account["email"]) === void 0 ? {} : { email: str(doc["email"]) ?? str(account["email"]) },
		gateway: str(doc["gateway"]) ?? gatewayFor(str(doc["region"]), product),
		appId: str(doc["appId"]) ?? product.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
		appVersionCode: num(doc["appVersionCode"]) ?? product.appVersionCode ?? 1205510027010,
		...expiresAtMs === void 0 || Number.isNaN(expiresAtMs) ? {} : { expiresAtMs },
		...str(doc["region"]) === void 0 ? {} : { region: str(doc["region"]) },
		source
	};
}
/** 现读凭据文件；读不了/格式坏都抛（调用方折成「凭据不可用」）。 */
function readTraeCredentialFile(path) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new Error(`读不到 Trae 凭据文件（${path}）`);
	}
	let doc;
	try {
		doc = JSON.parse(raw);
	} catch {
		throw new Error(`Trae 凭据文件不是 JSON（${path}）`);
	}
	if (typeof doc !== "object" || doc === null) throw new Error(`Trae 凭据文件格式不对（${path}）`);
	return parseTraeCredentialDocument(doc, path);
}
/** 账号 id 后缀：uid 的 sha256 前 12 位（与 WorkBuddy 同规则，换 id 规则会翻旧账）。 */
function traeAccountSuffixOf(uid) {
	return createHash("sha256").update(uid, "utf8").digest("hex").slice(0, 12);
}
/** 凭据文件的 token 目录。 */
function traeTokenDir(dshHome) {
	return join(dshHome, "model-hub", "trae-tokens");
}
/** 把登录态落到自有 token 文件（0600），返回文件路径。 */
function writeTraeTokenFile(dshHome, credential) {
	const dir = traeTokenDir(dshHome);
	mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	const slug = credential.userId !== "" ? traeAccountSuffixOf(credential.userId) : createHash("sha256").update(credential.token).digest("hex").slice(0, 12);
	const path = join(dir, `${slug}.json`);
	const body = {
		formatVersion: 2,
		kind: "trae",
		token: credential.token,
		...credential.refreshToken === void 0 ? {} : { refreshToken: credential.refreshToken },
		userId: credential.userId,
		name: credential.name,
		...credential.email === void 0 ? {} : { email: credential.email },
		gateway: credential.gateway,
		appId: credential.appId,
		appVersionCode: credential.appVersionCode,
		...credential.region === void 0 ? {} : { region: credential.region },
		...credential.expiresAtMs === void 0 ? {} : { expiresAt: new Date(credential.expiresAtMs).toISOString() },
		capturedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	return path;
}
/**
* token 过期的统一文案。
*
* 过期不是「网络抖动」：上游会 401，用户看到的应该是「去 Trae 重新登录」，
* 而不是一句看不懂的 HTTP 状态码。
*/
function assertTraeTokenFresh(credential) {
	if (credential.expiresAtMs === void 0) return;
	if (credential.expiresAtMs > Date.now()) return;
	throw new Error(`Trae token 已于 ${new Date(credential.expiresAtMs).toISOString()} 过期 —— 在 Trae 桌面端退出重登后，回面板点「一键认证」重新导入`);
}
// src/state/selector.ts
/** 手动优先（is_current）> 最近成功（last_ok_at 新在前）> 创建早者优先。 */
function poolOf(rows, channelId, _now) {
	return rows.filter((r) => r.channel_id === channelId && r.deleted === 0 && r.enabled === 1 && r.has_credential === 1).sort((x, y) => y.is_current - x.is_current || (y.last_ok_at ?? 0) - (x.last_ok_at ?? 0) || x.created_at - y.created_at);
}
/** 跳过冷却中的账号；全冷却时兜底返回池头（宁可撞冷却也不无号可用）。 */
function pickOf(rows, channelId, now) {
	const pool = poolOf(rows, channelId, now);
	return pool.find((r) => r.cooldown_until === null || r.cooldown_until <= now) ?? pool[0];
}
// src/state/hub-state.ts
function createHubState(deps) {
	const now = deps.now ?? (() => Date.now());
	const runtimes = /* @__PURE__ */ new Map();
	let queue = Promise.resolve();
	function mutate(fn) {
		const run = queue.then(fn);
		queue = run.then(() => void 0, () => void 0);
		return run;
	}
	function accounts() {
		return queryAccounts(deps.db).map((row) => ({
			...row,
			deleted: 0
		}));
	}
	function pick(channelId) {
		return pickOf(accounts(), channelId, now());
	}
	function poolSize(channelId) {
		return poolOf(accounts(), channelId, now()).length;
	}
	function reportResult(channelId, accountId, ok, status, error) {
		markAccountResult(deps.db, accountId, ok, status, error, now());
	}
	function channelRow(channelId) {
		return queryChannels(deps.db).find((c) => c.id === channelId);
	}
	async function ensureRuntimeCore(channelId) {
		if (runtimes.has(channelId)) return;
		const channel = channelRow(channelId);
		if (channel === void 0) {
			deps.logger.warn?.(`dsh-model-hub: 渠道 ${channelId} 不存在，跳过 runtime 创建`);
			return;
		}
		let handle;
		try {
			handle = await deps.runtimeFactory({
				db: deps.db,
				channelId,
				kind: channel.kind,
				settings: deps.settings,
				state: {
					pick,
					poolSize,
					reportResult
				},
				logger: deps.logger
			});
		} catch (error) {
			deps.logger.error?.(`dsh-model-hub: 渠道 ${channelId} runtime 启动失败（下次同步重试）`, error);
			return;
		}
		runtimes.set(channelId, {
			handle,
			adapterOn: true
		});
	}
	/** 整体拆除：adapter 下架 + shim 关闭 + 移出表。之后要服务得让 factory 重建。 */
	function teardownRuntime(channelId) {
		const entry = runtimes.get(channelId);
		if (entry === void 0) return;
		runtimes.delete(channelId);
		if (entry.adapterOn) try {
			entry.handle.release();
		} catch (error) {
			deps.logger.warn?.(`dsh-model-hub: ${channelId} adapter 下架失败（忽略）`, error);
		}
		try {
			entry.handle.shim.close();
		} catch (error) {
			deps.logger.warn?.(`dsh-model-hub: ${channelId} shim 关闭失败（忽略）`, error);
		}
	}
	async function syncCore(channelId) {
		const channel = channelRow(channelId);
		if (channel === void 0) return;
		const entry = runtimes.get(channelId);
		if (entry === void 0) {
			if (channel.enabled === 1 && poolSize(channelId) > 0) await ensureRuntimeCore(channelId);
			return;
		}
		if (channel.enabled !== 1) {
			if (entry.adapterOn) {
				entry.handle.setEnabled(false);
				entry.adapterOn = false;
			}
			return;
		}
		if (poolSize(channelId) === 0) {
			teardownRuntime(channelId);
			return;
		}
		if (!entry.adapterOn) {
			entry.handle.setEnabled(true);
			entry.adapterOn = true;
		}
		if (entry.handle.models.length === 0) {
			await entry.handle.refresh();
			entry.handle.setEnabled(true);
		}
	}
	return {
		ensureRuntime: (channelId) => mutate(() => ensureRuntimeCore(channelId)),
		syncChannelRuntime: (channelId) => mutate(() => syncCore(channelId)),
		setChannelEnabled: (channelId, enabled) => mutate(() => {
			setChannelEnabled(deps.db, channelId, enabled);
			return syncCore(channelId);
		}),
		setAccountEnabled: (accountId, enabled) => mutate(() => {
			const row = accounts().find((a) => a.id === accountId);
			if (row === void 0) return;
			setAccountEnabled(deps.db, accountId, enabled);
			return syncCore(row.channel_id);
		}),
		makeCurrent: (channelId, accountId) => mutate(() => {
			makeCurrent(deps.db, channelId, accountId);
			return syncCore(channelId);
		}),
		deleteAccount: (accountId) => mutate(() => {
			const row = accounts().find((a) => a.id === accountId);
			if (row === void 0) return;
			softDeleteAccount(deps.db, accountId);
			return syncCore(row.channel_id);
		}),
		reportResult,
		pick,
		poolSize,
		panelModelsByChannel: () => {
			const out = {};
			for (const [channelId, entry] of runtimes) out[channelId] = entry.handle.panelEntries;
			return out;
		},
		dispose: () => mutate(() => {
			for (const channelId of [...runtimes.keys()]) teardownRuntime(channelId);
			try {
				deps.db.close();
			} catch (error) {
				deps.logger.warn?.("dsh-model-hub: 数据库关闭失败（忽略）", error);
			}
		})
	};
}
// src/shim/recorder.ts
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
var TurnTimer = class {
	#t0;
	#t1;
	#t2;
	#chars = 0;
	constructor(startedAt) {
		this.#t0 = startedAt;
	}
	onUpstreamHead(at) {
		if (this.#t1 === void 0) this.#t1 = at;
	}
	onDelta(text, at) {
		this.#chars += text.length;
		if (this.#t2 === void 0 && text.length > 0) this.#t2 = at;
	}
	onEnd(at, usage) {
		const estimated = usage === void 0;
		const outputTokens = usage?.outputTokens ?? Math.floor(this.#chars / CHARS_PER_TOKEN);
		const decodeMs = this.#t2 === void 0 ? void 0 : at - this.#t2;
		return {
			...this.#t2 === void 0 ? {} : { firstTokenMs: this.#t2 - this.#t0 },
			...this.#t1 === void 0 ? {} : { upstreamHeadMs: this.#t1 - this.#t0 },
			durationMs: at - this.#t0,
			...decodeMs === void 0 || decodeMs <= 0 ? {} : { decodeTps: outputTokens / (decodeMs / 1e3) },
			inputTokens: usage?.inputTokens ?? 0,
			outputTokens,
			cacheRead: usage?.cacheRead ?? 0,
			cacheWrite: usage?.cacheWrite ?? 0,
			estimated
		};
	}
};
// src/shim/upstream.ts
/**
* 从一条 SSE `data:` 行里取出 token 增量与 usage。
*
* `text` 是**模型产出的任意 token 增量**，包含正文与思考（reasoning）。
* 这一点很关键，见 {@link extractTokenDelta}。
*/
function parseSseLine(line) {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith(":")) return { done: false };
	if (!trimmed.startsWith("data:")) return { done: false };
	const payload = trimmed.slice(5).trim();
	if (payload === "[DONE]") return { done: true };
	let doc;
	try {
		doc = JSON.parse(payload);
	} catch {
		return { done: false };
	}
	const text = extractTokenDelta(doc);
	const usage = extractUsage(doc);
	return {
		...text === void 0 ? {} : { text },
		...usage === void 0 ? {} : { usage },
		done: false
	};
}
/**
* 取出一个 chunk 里的 **token 增量**：正文、思考、或工具调用参数。
*
* ## 为什么必须包含 reasoning（2026-10-29 真机事故）
*
* 之前这里只取 `delta.content`（正文），思考模型（deepseek-v4.1-flash 等）
* 的 `delta.reasoning_content` 完全被忽略。后果是计时口径和 token 数对不上：
*
*   上游先花 24 秒吐 reasoning（不被计入"首 token"），
*   再花 0.8 秒吐正文（被当成 3664 个 token 的全部耗时），
*   于是 tok/s = 3664 / 0.8s = 4378 —— 面板上出现物理不可能的速度。
*
* 宿主的判定是权威口径（`dsh-llm` 的 `isTokenDelta`）：
*
*     case "text-delta":
*     case "reasoning-delta": return chunk.text !== "";
*
* 也就是**思考的第一个 token 就是首 token**。这里照抄，两边才对得上。
*
* 取到的增量只用于**计时与字符估算**，不参与内容改写 —— 透传给客户端的
* 字节始终是上游原文，reasoning 该不该显示由宿主自己决定。
*/
function extractTokenDelta(doc) {
	const choices = doc["choices"];
	if (Array.isArray(choices) && choices.length > 0) {
		const delta = choices[0]["delta"];
		if (delta !== void 0) {
			if (typeof delta["content"] === "string" && delta["content"] !== "") return delta["content"];
			if (typeof delta["reasoning_content"] === "string" && delta["reasoning_content"] !== "") return delta["reasoning_content"];
			if (typeof delta["tool_calls"] === "object" && delta["tool_calls"] !== null) {
				const calls = delta["tool_calls"];
				if (Array.isArray(calls) && calls.length > 0) {
					const call = calls[0];
					const args = call["function"];
					if (typeof call["name"] === "string" && call["name"] !== "") return call["name"];
					if (typeof args?.["name"] === "string" && args["name"] !== "") return args["name"];
					const fragment = args?.["arguments"];
					if (typeof fragment === "string" && fragment !== "") return fragment;
				}
			}
		}
	}
	const delta = doc["delta"];
	if (delta !== void 0) {
		if (typeof delta["text"] === "string" && delta["text"] !== "") return delta["text"];
		if (typeof delta["thinking"] === "string" && delta["thinking"] !== "") return delta["thinking"];
	}
	const content = doc["content"];
	if (Array.isArray(content)) for (const part of content) {
		const rec = part;
		const type = rec["type"];
		if (type !== "text_delta" && type !== "thinking_delta") continue;
		const text = rec["text"] ?? rec["thinking"];
		if (typeof text === "string" && text !== "") return text;
	}
}
/** 两种协议字段名不同，统一归一。 */
function extractUsage(doc) {
	const usage = doc["usage"];
	if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return void 0;
	const rec = usage;
	const input = rec["prompt_tokens"] ?? rec["input_tokens"];
	const output = rec["completion_tokens"] ?? rec["output_tokens"];
	if (typeof input !== "number" && typeof output !== "number") return void 0;
	const cacheRead = rec["cache_read_input_tokens"];
	const cacheWrite = rec["cache_creation_input_tokens"];
	return {
		inputTokens: typeof input === "number" ? input : 0,
		outputTokens: typeof output === "number" ? output : 0,
		cacheRead: typeof cacheRead === "number" ? cacheRead : 0,
		cacheWrite: typeof cacheWrite === "number" ? cacheWrite : 0
	};
}
// src/shim/prepare.ts
/**
* 上游网关的请求体整形。
*
* ## 为什么插件必须自己干这件事
*
* 踩过两个**独立的**坑，都是上游拒收 DSH 原样发出的请求体：
*
* 1. **首条不是 system** —— 国际网关（`www.workbuddy.ai`）返回
*    `400 / code 11128 / "first message is not system prompt"`（实测 2026-10-28）。
*    DSH 的 `PiAiAdapter` 在本轮没有系统提示时，`messages[0]` 会是 `user`。
*
* 2. **`role: "developer"`** —— DSH 用较新的 OpenAI 角色划分，会把全局指令
*    放进 `developer` 消息。WorkBuddy 与 Qoder 都**只认**
*    `system/assistant/user/tool/function`：
*    - WorkBuddy: `400 / 11128 / Illegal API invocation from an unapproved channel`
*    - Qoder:     `400 / developer is not one of [...]`
*    表面上是两个错，根因是同一个。
*
* 所以归一是**通用**的：放在 shim 这一层，所有渠道一起受益。
* 参考实现在自己的 adapter 层做同样的事；我们在 shim 做，因为这是最后一个
* 能看到并改写请求体的地方，而且它已经承担了「补会话身份三件套」的同类职责。
*/
/**
* 兜底系统提示词。
*
* 取最中性的一句，不扮演人格 —— 编一个更长的会悄悄改变每个受影响请求的
* 模型行为，而用户并没有要求。
*/
const FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";
/**
* 角色映射：DSH/新版 OpenAI → 上游普遍接受的四五种。
*
* - `developer` → `system`（语义就是系统级指令，不丢信息）
* - `function`  → `tool`（旧 OpenAI 形状）
*/
const ROLE_MAP = {
	developer: "system",
	function: "tool"
};
/**
* 确保请求体符合上游的最小要求：角色归一 + `messages` 以 system 开头。
*
* 三条约束，都来自实测：
* 1. **幂等** —— 已经合规就返回**原字符串**（同一个引用），
*    免得把上游本来接受的请求也改一遍。
* 2. **不猜语义** —— 只做角色改名与补一句中性占位，不改用户内容。
* 3. **不认识的形状不动** —— 不是 JSON 对象、`messages` 不是数组时原样返回，
*    让上游自己报错，而不是我们把它改坏。
*
* @param raw 原始请求体字符串
* @returns 需要改写时返回新字符串；不需要时返回**原字符串**
*/
function ensureSystemHead(raw) {
	let doc;
	try {
		doc = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return raw;
	const record = doc;
	const messages = record["messages"];
	if (!Array.isArray(messages) || messages.length === 0) return raw;
	let changed = false;
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const item = message;
		const role = item["role"];
		if (typeof role !== "string") continue;
		const mapped = ROLE_MAP[role.trim().toLowerCase()];
		if (mapped !== void 0) {
			item["role"] = mapped;
			changed = true;
		}
	}
	const head = messages[0];
	let headIsSystem = false;
	if (typeof head === "object" && head !== null) {
		const role = head["role"];
		headIsSystem = typeof role === "string" && role.trim().toLowerCase() === "system";
	}
	if (!headIsSystem) {
		messages.unshift({
			role: "system",
			content: FALLBACK_SYSTEM_PROMPT
		});
		changed = true;
	}
	return changed ? JSON.stringify(record) : raw;
}
/**
* 宿主没指定思考档位时，插件补一个默认档。
*
* ## 为什么在插件侧补
*
* 宿主的选择器显示 `Default` 表示「跟随模型默认」，而 pi-ai 的模型元数据里
* **没有**「默认档位」这个字段（只有 `thinkingLevelMap`，那只是把档位名映射成
* 上游 effort）。所以想让 hub 模型默认走最低档，只能落到请求体上。
*
* ## 只补不改
*
* 请求体里已经有 `reasoning_effort` / `enable_thinking` 时**原样放过** ——
* 用户在界面上显式选过的档位优先。只有完全没提的时候才补。
*
* `minimal` 对应 pi-ai 的 1024 token 思考预算，是官方档位里最低的一档；
* 想把默认调高就改这个常量（`medium` = 8192、`high` = 16384）。
*/
const DEFAULT_REASONING_EFFORT = "minimal";
function applyDefaultReasoning(raw, level = DEFAULT_REASONING_EFFORT) {
	let doc;
	try {
		doc = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return raw;
	const record = doc;
	if (record["reasoning_effort"] !== void 0) return raw;
	if (record["enable_thinking"] !== void 0) return raw;
	record["reasoning_effort"] = level;
	return JSON.stringify(record);
}
// src/shim/diagnostics.ts
const SENSITIVE = /authorization|api-key|cookie|token|secret|cosy-key|cosy-user/i;
function rejectedRequestPath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "model-hub", "last-rejected-request.json");
}
/** 记一次被拒请求。永不抛错。 */
async function recordRejected(input) {
	try {
		const safeHeaders = {};
		for (const [name, value] of Object.entries(input.headers)) {
			if (SENSITIVE.test(name)) {
				safeHeaders[name] = "<redacted>";
				continue;
			}
			safeHeaders[name] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
		}
		const BODY_LIMIT = 2e5;
		const truncated = input.requestBody.length > BODY_LIMIT;
		const payload = {
			...input,
			headers: safeHeaders,
			responseBody: input.responseBody.slice(0, 8e3),
			requestBody: truncated ? input.requestBody.slice(0, BODY_LIMIT) : input.requestBody,
			...truncated ? { requestBodyTruncated: true } : {}
		};
		const { writeFile, mkdir } = await import("node:fs/promises");
		const path = rejectedRequestPath();
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
	} catch {}
}
// src/shim/server.ts
const LOOPBACK$2 = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"[::1]"
]);
function hostIsLoopback$2(host) {
	if (host === void 0) return false;
	const name = host.replace(/:\d+$/, "").toLowerCase();
	if (LOOPBACK$2.has(name)) return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}
function originIsLoopback(origin) {
	if (origin === void 0 || origin === "") return true;
	try {
		return hostIsLoopback$2(new URL(origin).host);
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
async function startShim(deps) {
	const secret = randomBytes(32).toString("base64url");
	const server = createServer((req, res) => {
		handle(req, res);
	});
	async function handle(req, res) {
		if (!hostIsLoopback$2(req.headers.host)) {
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
		const timer = new TurnTimer(Date.now());
		let statusCode = 502;
		let error;
		let usage;
		let streaming = false;
		let model = "unknown";
		let built;
		let account;
		let upstream;
		/**
		* 本次请求专用的流解码器（方言 `request` 可选返回）。
		*
		* 与 `deps.dialect.decodeLine` 的区别是**生命周期**：后者是渠道级的，
		* 适合无状态翻译（Qoder 的双层信封每行自描述）；前者跟着请求走，
		* Trae 的 `event:` / `data:` 分行格式靠它才安全（并发请求不会串事件名）。
		*/
		let requestDecodeLine;
		const recordAttempt = (input) => {
			try {
				deps.record({
					metrics: timer.onEnd(Date.now()),
					...input.statusCode === void 0 ? {} : { statusCode: input.statusCode },
					...input.error === void 0 ? {} : { error: input.error },
					isStreaming: false,
					model,
					...input.accountId === void 0 ? {} : { accountId: input.accountId }
				});
			} catch {}
		};
		try {
			const raw = await readBody(req);
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed["model"] === "string") model = parsed["model"];
			} catch {}
			const body = applyDefaultReasoning(ensureSystemHead(raw));
			const maxAttempts = Math.max(1, deps.maxAttempts?.() ?? 1);
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				const prepared = await deps.prepare();
				account = prepared.account;
				const dialectRequest = deps.dialect?.request === void 0 ? void 0 : await deps.dialect.request({
					raw: body,
					model,
					baseUrl: prepared.baseUrl,
					headers: prepared.headers,
					account: prepared.account
				});
				const nextBody = dialectRequest === void 0 ? {
					url: `${prepared.baseUrl}/v2/chat/completions`,
					headers: {
						...prepared.headers,
						"content-type": "application/json"
					},
					body
				} : dialectRequest;
				requestDecodeLine = dialectRequest?.decodeLine;
				let resp;
				try {
					resp = await fetch(nextBody.url, {
						method: "POST",
						headers: nextBody.headers,
						body: typeof nextBody.body === "string" ? nextBody.body : new Uint8Array(nextBody.body)
					});
				} catch (networkError) {
					const brief = networkError instanceof Error ? networkError.message : String(networkError);
					deps.onAccountResult?.(prepared.account ?? { id: "" }, false, void 0, brief);
					if (attempt < maxAttempts) {
						recordAttempt({
							error: brief,
							accountId: prepared.account?.id
						});
						continue;
					}
					throw networkError;
				}
				if ((resp.status === 401 || resp.status === 402 || resp.status === 403 || resp.status === 429 || resp.status >= 500 && resp.status <= 599) && attempt < maxAttempts) {
					deps.onAccountResult?.(prepared.account ?? { id: "" }, false, resp.status);
					resp.body?.cancel();
					recordAttempt({
						statusCode: resp.status,
						error: `upstream HTTP ${resp.status}`,
						accountId: prepared.account?.id
					});
					continue;
				}
				upstream = resp;
				built = nextBody;
				break;
			}
			timer.onUpstreamHead(Date.now());
			statusCode = upstream.status;
			deps.onAccountResult?.(account ?? { id: "" }, upstream.ok, upstream.status);
			if (!upstream.ok) {
				error = `upstream HTTP ${upstream.status}`;
				const upstreamText = await upstream.text();
				recordRejected({
					at: Date.now(),
					url: built.url,
					status: upstream.status,
					responseBody: upstreamText,
					requestBody: typeof built.body === "string" ? built.body : Buffer.from(built.body).toString("utf8"),
					headers: built.headers,
					model
				});
				res.writeHead(upstream.status, { "content-type": "application/json" });
				res.end(upstreamText);
				return;
			}
			const contentType = upstream.headers.get("content-type") ?? "";
			streaming = contentType.includes("text/event-stream");
			res.writeHead(200, {
				"content-type": contentType || "application/json",
				...streaming ? {
					"cache-control": "no-cache",
					connection: "keep-alive"
				} : {}
			});
			if (!upstream.body) {
				res.end();
				return;
			}
			const reader = upstream.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			const decodeLine = requestDecodeLine ?? deps.dialect?.decodeLine;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value, { stream: true });
				if (!streaming || decodeLine === void 0) res.write(chunk);
				if (!streaming) continue;
				buffer += chunk;
				let nl = buffer.indexOf("\n");
				while (nl >= 0) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					if (decodeLine === void 0) {
						const parsed = parseSseLine(line);
						if (parsed.text !== void 0) timer.onDelta(parsed.text, Date.now());
						if (parsed.usage !== void 0) usage = parsed.usage;
						nl = buffer.indexOf("\n");
						continue;
					}
					const translated = decodeLine(line);
					if (translated !== null) {
						const message = errorMessageOf(translated);
						if (message !== void 0 && error === void 0) {
							error = message;
							statusCode = 502;
							deps.onAccountResult?.(account ?? { id: "" }, false, void 0, message);
						}
						res.write(`${translated}\n\n`);
						const parsed = parseSseLine(translated);
						if (parsed.text !== void 0) timer.onDelta(parsed.text, Date.now());
						if (parsed.usage !== void 0) usage = parsed.usage;
					}
					nl = buffer.indexOf("\n");
				}
			}
			if (buffer.trim() !== "") {
				if (decodeLine === void 0) {
					const parsed = parseSseLine(buffer);
					if (parsed.text !== void 0) timer.onDelta(parsed.text, Date.now());
					if (parsed.usage !== void 0) usage = parsed.usage;
				} else {
					const translated = decodeLine(buffer);
					if (translated !== null) {
						const message = errorMessageOf(translated);
						if (message !== void 0 && error === void 0) {
							error = message;
							statusCode = 502;
							deps.onAccountResult?.(account ?? { id: "" }, false, void 0, message);
						}
						res.write(`${translated}\n\n`);
						const parsed = parseSseLine(translated);
						if (parsed.text !== void 0) timer.onDelta(parsed.text, Date.now());
						if (parsed.usage !== void 0) usage = parsed.usage;
					}
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
					...error === void 0 ? {} : { error },
					isStreaming: streaming,
					model,
					accountId: account?.id
				});
			} catch {}
		}
	}
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("shim has no listening address");
	return {
		baseUrl: () => `http://127.0.0.1:${address.port}`,
		token: () => secret,
		close: () => server.close()
	};
}
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}
/**
* 从一行已翻好的 SSE 里取出业务错误文案。
*
* 上游把失败塞在 `data: {"error":{...}}` 里而不是 HTTP 状态码里，
* 所以必须逐行看内容，否则「失败的请求」会被记成「成功但没有用量」。
*/
function errorMessageOf(line) {
	if (!line.startsWith("data:")) return void 0;
	const payload = line.slice(5).trim();
	if (payload === "" || payload === "[DONE]") return void 0;
	try {
		const error = JSON.parse(payload)["error"];
		if (typeof error !== "object" || error === null) return void 0;
		const message = error["message"];
		return typeof message === "string" && message !== "" ? message.slice(0, 300) : "上游返回了错误";
	} catch {
		return;
	}
}
// src/provider.ts
/**
* 生成展示名：`Name · x0.00 · Free now`。
*
* 与参考实现 `dsh-connect-workbuddy` 的 `workBuddyDisplayName()` 同思路 ——
* 先例把倍率拼进名字（`GLM-5.3 · x0.79`），用户才能在选模型时看到价格档位。
* 我们额外带上活动的等级标记，否则「这个模型免费 / 要 Pro」只能去官网查。
*
* 只影响**显示**：所有 join（模型选择、请求记录、上游 `model` 字段）
* 都按 `id`，不按这个名字。
*/
function displayNameOf(model) {
	const parts = [model.name];
	if (model.creditMultiplier !== void 0) parts.push(`x${model.creditMultiplier.toFixed(2)}`);
	if (model.promotionBadge !== void 0) parts.push(model.promotionBadge);
	else if (model.tierBadge !== void 0) parts.push(model.tierBadge);
	return parts.join(" · ");
}
/**
* 惰性 auth 面。
*
* 本渠道只靠 shim 的进程内随机密钥认证，所以 pi-ai 自己的凭据生命周期与
* 环境探测必须一律回答「没有」—— 否则它可能从 `ANTHROPIC_API_KEY` 之类
* 环境变量里凭空造出一个凭据，绕开 shim 的密钥校验。
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-model-hub: the hub route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** 订阅制额度没有可计算的单价；成本由上游账单决定，这里报 0 而不是编一个数。 */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildProviderProfile(input) {
	const { provider, shimBaseUrl, models, createProvider, openAICompletionsApi, resolveRetryPolicy } = input;
	return {
		provider,
		displayName: provider,
		piProvider: createProvider({
			id: provider,
			name: provider,
			baseUrl: shimBaseUrl,
			auth: { apiKey: {
				name: "dsh-model-hub shim",
				resolve: ({ credential }) => Promise.resolve({
					auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
					source: "dsh-model-hub shim"
				})
			} },
			models: models.map((m) => ({
				id: m.id,
				name: displayNameOf(m),
				api: "openai-completions",
				provider,
				baseUrl: shimBaseUrl,
				input: input.resolveAttachments === void 0 ? ["text"] : m.supportsImages ? ["text", "image"] : ["text"],
				cost: NO_COST,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning === true,
				...m.reasoning === true ? {
					thinkingLevelMap: {
						off: null,
						minimal: "minimal",
						low: "low",
						medium: "medium",
						high: "high"
					},
					compat: { supportsReasoningEffort: true }
				} : {}
			})),
			api: openAICompletionsApi()
		}),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		streamIdleTimeoutMs: 3e5,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-model-hub retryPolicy"),
		...models.length > 0 && models.every((m) => m.reasoning === true) ? { reasoning: "high" } : {},
		maxRequestImageBytes: 20971520,
		requestImagePixelBudget: 4194304,
		requestImageMaxBytes: 1048576
	};
}
/**
* 造出真正能出模型的 adapter。
*
* `index.ts` 的生产路径与测试走的是**同一个函数** —— 这样「测过的」和
* 「装上去的」不可能不一致（本项目已经因为两处形状不一致栽过一次）。
*/
function createHubAdapter(input) {
	const profile = buildProviderProfile(input);
	return new input.PiAiAdapter({
		profiles: () => /* @__PURE__ */ new Map([[input.provider, profile]]),
		auth: INERT_AUTH,
		resolveApiKey: async () => input.shimToken,
		...input.resolveAttachments === void 0 ? {} : { resolveAttachments: input.resolveAttachments },
		...input.resolveImageAccess === void 0 ? {} : { resolveImageAccess: input.resolveImageAccess }
	});
}
// src/channels/workbuddy/catalog.ts
/**
* 桌面端 UA —— 上游按客户端通道裁剪配置，CLI UA 会少给模型和促销字段。
*
* 导出收口（任务 9 裁定 1）：shim 的 prepare（runtime.ts）与目录拉取（这里）
* 必须是同一个值，字面量各抄一份迟早漂 —— 全仓库只此一处定义。
*/
const DESKTOP_UA = "WorkBuddy/5.12.1 WorkBuddy/5.12.1 CLI/2.63.2";
function upstreamBase(region) {
	return region === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
}
/**
* 会话身份三件套。
*
* **渠道校验（11128）认的是这三个请求头，不是提示词。** 这是实测纠正 ——
* 设计规格里原写的「在句读处插 U+200B」是错的：带 system 头 + 零宽空格
* 两种写法都照样 400，只有补上这三个头才 200。
*
* 三个都要，少一个不行（实测：只给 X-Conversation-ID 仍然失败）。
* 网关不校验来源，只要格式是合法 UUID；但**每次请求现生成**，不跨请求复用 ——
* 复用等于伪造一段自己并不拥有的对话身份，上游对同一 id 的两次关联会立刻错乱。
*/
function conversationIdentityHeaders() {
	return {
		"X-Conversation-ID": randomUUID(),
		"X-Conversation-Request-ID": randomUUID(),
		"X-Conversation-Message-ID": randomUUID()
	};
}
/**
* 拉模型目录。
*
* 必须用桌面端身份读 `/v3/config`：CLI 通道的答复是 App 通道的严格子集，
* 既不发布 modelPromotions 也不发布 modelTiers（实测：CLI 5 键 35 模型，
* App 18 键 37 模型）。
*
* **真实字段名**（实测 2026-10-27，`data.models[28]`）：
* `id` / `name` / `maxInputTokens` / `maxOutputTokens` / `supportsImages` /
* `supportsToolCall` / `credits`（字符串，空串表示免费）/ `vendor`。
* 没有 `contextWindow`，也没有 `creditMultiplier` —— 别照别的插件的字段名写。
*/
async function fetchCatalog(region, token, signal) {
	const url = `${upstreamBase(region)}/v3/config`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": DESKTOP_UA,
			Accept: "application/json"
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${response.status}`);
	const doc = await response.json();
	const data = doc["data"] ?? doc;
	const models = Array.isArray(data["models"]) ? data["models"] : [];
	const promotionOf = badgeIndex(data["modelPromotions"]);
	const tierOf = badgeIndex(data["modelTiers"]);
	const promotionColorOf = badgeColorIndex(data["modelPromotions"]);
	const tierColorOf = badgeColorIndex(data["modelTiers"]);
	return models.flatMap((entry) => {
		const model = toChannelModel$1(entry, {
			promotionOf,
			tierOf,
			promotionColorOf,
			tierColorOf
		});
		return model === void 0 ? [] : [model];
	});
}
/**
* 上游条目 → 渠道模型。
*
* 抽成独立函数是为了能单测：这里踩过两个显示错误
* （上下文窗口取值、思考档位声明），都得靠测试钉住。
*
* `badges` 是可选的活动/等级标记查表；不传就只有基础字段。
*/
function toChannelModel$1(entry, badges = {}) {
	const id = typeof entry["id"] === "string" ? entry["id"] : "";
	if (id === "") return void 0;
	const maxInput = typeof entry["maxInputTokens"] === "number" ? entry["maxInputTokens"] : 2e5;
	const maxOutput = typeof entry["maxOutputTokens"] === "number" ? entry["maxOutputTokens"] : 32e3;
	const maxAllowed = typeof entry["maxAllowedSize"] === "number" ? entry["maxAllowedSize"] : 0;
	const contextWindow = Math.max(maxInput, maxAllowed);
	const promotion = badges.promotionOf?.(id);
	const tier = badges.tierOf?.(id);
	const promotionColor = badges.promotionColorOf?.(id);
	const tierColor = badges.tierColorOf?.(id);
	return {
		id,
		name: typeof entry["name"] === "string" ? entry["name"] : id,
		contextWindow,
		maxTokens: maxOutput,
		creditMultiplier: parseCredits(entry["credits"]),
		supportsImages: entry["supportsImages"] === true,
		reasoning: true,
		...promotion === void 0 ? {} : { promotionBadge: promotion },
		...tier === void 0 ? {} : { tierBadge: tier },
		...promotionColor === void 0 ? {} : { promotionColor },
		...tierColor === void 0 ? {} : { tierColor }
	};
}
/**
* 把「带 modelIds 的标记数组」转成 `模型 id -> 标记文案` 的查表。
*
* 上游形状（实测 2026-10-28）：
* ```json
* { "badge": { "label": "Free now", "color": "#FF0000" },
*   "modelIds": ["hy3"], "enabled": true, "priority": 200 }
* ```
* 只取 `enabled !== false` 的条目；同一模型多条时 `priority` 高的胜出。
* 文案按上游原样返回 —— 那是给用户看的字，不改写。
*/
function badgeIndex(value) {
	const table = /* @__PURE__ */ new Map();
	if (!Array.isArray(value)) return () => void 0;
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw;
		if (entry["enabled"] === false) continue;
		const badge = entry["badge"];
		if (typeof badge !== "object" || badge === null) continue;
		const label = badge["label"];
		if (typeof label !== "string" || label === "") continue;
		const priority = typeof entry["priority"] === "number" ? entry["priority"] : 0;
		const ids = entry["modelIds"];
		if (!Array.isArray(ids)) continue;
		for (const id of ids) {
			if (typeof id !== "string") continue;
			const previous = table.get(id);
			if (previous === void 0 || priority >= previous.priority) table.set(id, {
				label,
				priority
			});
		}
	}
	return (modelId) => table.get(modelId)?.label;
}
/**
* 标记的颜色，与 {@link badgeIndex} 同源但单独取。
*
* 颜色是给**浏览器侧**渲染彩色标签用的：宿主的模型标签槽
* （`conversation.input.model.label`）允许自定义渲染，参考实现就是在那里
* 用 `badge.color` 画彩色 pill 的。所以颜色要能从 host 传到 client。
*
* 只接受 `#rgb` / `#rrggbb` / `rgb(...)` 这类安全的 CSS 颜色字面量 ——
* 上游是外部数据，不该让任意字符串进 `style.background`。
*/
function badgeColorIndex(value) {
	const table = /* @__PURE__ */ new Map();
	if (!Array.isArray(value)) return () => void 0;
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw;
		if (entry["enabled"] === false) continue;
		const badge = entry["badge"];
		if (typeof badge !== "object" || badge === null) continue;
		const color = badge["color"];
		if (typeof color !== "string" || !isSafeCssColor(color)) continue;
		const priority = typeof entry["priority"] === "number" ? entry["priority"] : 0;
		const ids = entry["modelIds"];
		if (!Array.isArray(ids)) continue;
		for (const id of ids) {
			if (typeof id !== "string") continue;
			const previous = table.get(id);
			if (previous === void 0 || priority >= previous.priority) table.set(id, {
				color,
				priority
			});
		}
	}
	return (modelId) => table.get(modelId)?.color;
}
/** 只放行十六进制与 rgb()/rgba() 字面量。 */
function isSafeCssColor(value) {
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) || /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)$/.test(value);
}
/**
* 解析倍率。
*
* 上游格式是**带前缀和单位的字符串**，不是纯数字（实测 2026-10-27）：
*   `"x0.34 credits"` / `"x3.31 credits"` / `"x0.00"` / `""`
* 直接 `Number()` 会全部得到 NaN —— 那会让每个模型都显示成免费。
*/
function parseCredits(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (typeof value !== "string") return 0;
	const match = /x?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(value.trim());
	if (match === null) return 0;
	const n = Number(match[1]);
	return Number.isFinite(n) ? n : 0;
}
// src/channels/qoder/catalog.ts
/**
* Qoder 模型目录。
*
* ## 端点
*
* `GET https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1`
*
* `/algo` 前缀必须有：少了会被 ALB 挡成 **503**（不是 401），很容易误判成
* 「token 不对」。同网关的 chat 路径本来就带 `/algo`。
*
* ## 响应形状（实测 2026-10-28）
*
* ```json
* { "chat": [ { "key":"auto", "display_name":"Auto", "enable":true,
*               "is_reasoning":true, "is_vl":true, "price_factor":0.5,
*               "max_input_tokens":200000, "is_default":true }, … ],
*   "developer": [...], "assistant": [...], … }
* ```
*
* 只用 `chat` 那一组 —— 那是对话模型；其余是 inline / quest / 应用市场之类。
* 10 个模型里 `key` 才是请求要用的 model id，`display_name` 是给人看的。
*/
const DEFAULT_GATEWAY$1 = "https://gateway.qoder.com.cn";
const PATH_MODELS = "/algo/api/v2/model/list?Encode=1";
/** 拿不到上游声明的上下文窗口时的保守默认。 */
const FALLBACK_CONTEXT = 128e3;
/**
* 输出 token 上限。
*
* 上游目录**没给** max output，所以只能自己定。取 32000 而不是 8192 的原因：
* 模型声明了 `reasoning: true` 之后，宿主会从 `max_tokens` 里划走一块当思考预算
* （pi-ai 的 `adjustMaxTokensForThinking`，minimal 档也要 1024）。
* 8192 的预算被划掉一块后，正文很容易被截断。
*/
const FALLBACK_MAX_TOKENS = 32e3;
function asNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/**
* 取真实的上下文窗口。
*
* **`max_input_tokens` 不是窗口上限。** 实测 qfmodel：`max_input_tokens` 是
* 180000，但 `context_config` 里默认档是 200K，还支持 400K 与 1M。
* 之前拿 `max_input_tokens` 当 contextWindow，用户看到的是「336K / 180K = 100%」，
* 而同一账号 318K 的请求其实**成功了** —— 说明真实上限远大于 180K。
*
* 取所有档位里的**最大值**（该模型确实支持到那里），拿不到再用
* `max_input_tokens` 兜底。宁可让宿主晚一点压缩，也不要提前压缩把历史截掉。
*/
function contextWindowOf$1(raw) {
	const config = raw.context_config;
	if (typeof config === "object" && config !== null && !Array.isArray(config)) {
		let max = 0;
		for (const tier of Object.values(config)) {
			if (typeof tier !== "object" || tier === null) continue;
			const count = asNumber(tier["token_count"]);
			if (count !== void 0 && count > max) max = count;
		}
		if (max > 0) return max;
	}
	return asNumber(raw.max_input_tokens) ?? FALLBACK_CONTEXT;
}
/** 把上游条目翻成渠道模型；字段缺失时用保守默认，不猜能用的能力。 */
function toChannelModel(raw) {
	const id = typeof raw.key === "string" && raw.key !== "" ? raw.key : void 0;
	if (id === void 0) return void 0;
	const display = typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : id;
	const context = contextWindowOf$1(raw);
	return {
		id,
		name: display,
		contextWindow: context,
		maxTokens: Math.min(FALLBACK_MAX_TOKENS, context),
		creditMultiplier: asNumber(raw.price_factor) ?? 0,
		supportsImages: raw.is_vl === true,
		reasoning: raw.is_reasoning === true
	};
}
/**
* 拉一次目录。
*
* 不抛错：拿不到就返回空 + error，让调用方决定怎么记录。
* 插件不能因为一个平台连不上就整体失效。
*/
async function fetchQoderCatalog(session, options = {}) {
	const url = `${(options.gatewayBase ?? DEFAULT_GATEWAY$1).replace(/\/+$/, "")}${PATH_MODELS}`;
	try {
		const headers = buildCosyHeaders(null, url, {
			userID: session.userID,
			authToken: session.jobToken,
			name: session.name,
			email: session.email
		});
		const response = await fetch(url, {
			headers: {
				...headers,
				Accept: "application/json"
			},
			signal: AbortSignal.timeout(2e4)
		});
		const text = await response.text();
		if (!response.ok) return {
			models: [],
			rawCount: 0,
			error: `HTTP ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`
		};
		const doc = JSON.parse(text);
		const chat = Array.isArray(doc["chat"]) ? doc["chat"] : [];
		return {
			models: chat.filter((entry) => entry?.enable !== false).map(toChannelModel).filter((model) => model !== void 0),
			rawCount: chat.length
		};
	} catch (error) {
		return {
			models: [],
			rawCount: 0,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
// src/channels/qoder/chat.ts
/**
* Qoder 的对话方言：把 OpenAI 请求翻成 Qoder 的请求，把双层 SSE 翻回 OpenAI SSE。
*
* ## 为什么需要这一层
*
* 1. **请求体形状不同**：Qoder 要 `request_id / chat_task / chat_context /
*    model_config / business` 这一整套字段，模型 id 放在 `model_config.key`
*    而不是顶层的 `model`。
* 2. **请求体要编码**（`Encode=1`）：标准 base64 → 自定义字母表 → 三段块旋转。
* 3. **响应是双层信封**：`data:{"statusCodeValue":200,"body":"<JSON 字符串>"}`，
*    `body` 里面才是 OpenAI chunk；结束哨兵是 `[DONE]`。
*
* 实测（2026-10-28）发出 998 字节明文、1428 字节编码体，收到正确回答
* 「你好」，并带回 usage。
*/
const DEFAULT_GATEWAY = "https://gateway.qoder.com.cn";
const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
/** CN 客户端身份：SDK 里 `Ji ? "qoderclicn" : "qodercli"`。 */
const SESSION_TYPE = "qoderclicn";
/** 取最后一条 user 消息的纯文本（Qoder 用它填 `originalContent` / 会话名）。 */
function promptTextOf(messages) {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.["role"] !== "user") continue;
		const content = message["content"];
		if (typeof content === "string") return content;
		if (Array.isArray(content)) return content.filter((part) => typeof part === "object" && part !== null).filter((part) => part["type"] === "text" && typeof part["text"] === "string").map((part) => part["text"]).join("\n");
	}
	return "";
}
function toolCallIdsOf(message) {
	const calls = message["tool_calls"];
	if (!Array.isArray(calls)) return [];
	return calls.filter((call) => typeof call === "object" && call !== null).map((call) => call["id"]).filter((id) => typeof id === "string" && id !== "");
}
/**
* 规整对话历史，满足 Qoder 的两条强校验。
*
* ## 为什么需要
*
* 实测（2026-10-28）真实会话打到 Qoder 报 400：
*
* ```
* Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
* ```
*
* DSH 的历史里会出现两类「断链」，Qoder 一律拒收：
*
* 1. **孤立的 `tool` 消息** —— 它引用的 `tool_call_id` 前面没有对应的
*    assistant `tool_calls`（上下文被裁剪，或重放时只带了结果）。
* 2. **没人应答的 `tool_calls`** —— assistant 声明了调用，但后面没有对应的
*    `tool` 消息（中止的回合、或结果被裁掉）。这类同样会被上游拒。
*
* ## 策略
*
* - `tool` 消息：其 `tool_call_id` 必须被**前面最近的** assistant `tool_calls`
*   声明过，否则丢弃。
* - assistant 的 `tool_calls`：只保留**后面确实有**对应 tool 消息的那些；
*   **整条消息不删**（它的 `content` 可能仍有用），只裁字段。
* - `user` / `system` 出现时重置「已声明」状态 —— 跨轮的 id 不该被认。
*
* 这是**为了让请求能被接受**做的最小裁剪，不改变语义内容。
*/
function sanitizeMessages(messages) {
	if (!Array.isArray(messages)) return [];
	const list = messages.filter((item) => typeof item === "object" && item !== null);
	const answeredIds = /* @__PURE__ */ new Set();
	for (let i = 0; i < list.length; i += 1) {
		const message = list[i];
		if (message["role"] !== "assistant") continue;
		if (toolCallIdsOf(message).length === 0) continue;
		for (let j = i + 1; j < list.length; j += 1) {
			const next = list[j];
			if (next["role"] === "user" || next["role"] === "system") break;
			if (next["role"] === "tool" && typeof next["tool_call_id"] === "string") answeredIds.add(next["tool_call_id"]);
		}
	}
	const out = [];
	let declared = /* @__PURE__ */ new Set();
	for (const message of list) {
		const role = message["role"];
		if (role === "tool") {
			const id = message["tool_call_id"];
			if (typeof id !== "string" || !declared.has(id)) continue;
			out.push(message);
			continue;
		}
		if (role === "assistant") {
			if (toolCallIdsOf(message).length === 0) {
				declared = /* @__PURE__ */ new Set();
				out.push(message);
				continue;
			}
			const kept = message["tool_calls"].filter((call) => {
				const id = call?.["id"];
				return typeof id === "string" && answeredIds.has(id);
			});
			const next = { ...message };
			if (kept.length === 0) delete next["tool_calls"];
			else next["tool_calls"] = kept;
			declared = new Set(kept.map((call) => call["id"]));
			out.push(next);
			continue;
		}
		declared = /* @__PURE__ */ new Set();
		const normalizedRole = role === "developer" ? "system" : role === "function" ? "tool" : role;
		out.push(normalizedRole === role ? message : {
			...message,
			role: normalizedRole
		});
	}
	return out;
}
/**
* OpenAI 请求体 → Qoder 请求体。
* * `model` 来自网关配置而非请求体（pi-ai 发的 `model` 是我们的 id，
* 与 Qoder 的 model key 一致，但仍然以显式参数为准，避免被客户端改写）。
*/
function buildQoderChatBody(openaiBody, modelKey) {
	const requestId = randomUUID();
	const messages = sanitizeMessages(openaiBody["messages"]);
	const promptText = promptTextOf(messages);
	const effort = openaiBody["reasoning_effort"];
	const isReasoning = openaiBody["enable_thinking"] === true || typeof effort === "string" && effort !== "off" && effort !== "minimal";
	const parameters = { enable_thinking: isReasoning };
	const maxTokens = openaiBody["max_tokens"] ?? openaiBody["max_completion_tokens"];
	if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) parameters["max_tokens"] = Math.trunc(maxTokens);
	const temperature = openaiBody["temperature"];
	if (typeof temperature === "number" && Number.isFinite(temperature)) parameters["temperature"] = temperature;
	if (isReasoning) parameters["reasoning_effort"] = "high";
	return {
		request_id: requestId,
		request_set_id: requestId,
		chat_record_id: requestId,
		session_id: randomUUID(),
		stream: true,
		chat_task: "FREE_INPUT",
		is_reply: true,
		is_retry: false,
		source: 1,
		version: "3",
		agent_id: "agent_common",
		task_id: "common",
		session_type: SESSION_TYPE,
		code_language: "",
		chat_prompt: "",
		image_urls: null,
		aliyun_user_type: "",
		system: "",
		messages,
		tools: Array.isArray(openaiBody["tools"]) ? openaiBody["tools"] : [],
		...openaiBody["tool_choice"] === void 0 ? {} : { tool_choice: openaiBody["tool_choice"] },
		parameters,
		chat_context: {
			chatPrompt: "",
			imageUrls: null,
			extra: {
				context: [],
				modelConfig: {
					key: modelKey,
					is_reasoning: isReasoning
				},
				originalContent: promptText
			},
			features: [],
			text: promptText
		},
		model_config: {
			key: modelKey,
			source: "system"
		},
		business: {
			product: "cli",
			version: "1.0.0",
			type: "agent",
			stage: "start",
			id: requestId,
			name: promptText.slice(0, 30),
			begin_at: Date.now()
		}
	};
}
/** Qoder 的控制哨兵。 */
function isControlSentinel(text) {
	return text === "[DONE]" || text === "[NOT_EXCEED_QUOTA]" || text.startsWith("[EXCEED_QUOTA]") || text.startsWith("[NOTIFICATIONS]");
}
/**
* 解开一层 Qoder 信封。
*
* 返回 `{kind:"chunk"}` / `{kind:"done"}` / `{kind:"error"}` / `{kind:"ignore"}`。
* 对外导出便于单测 —— 这一层是全链路最容易出错的地方。
*/
function unwrapQoderEvent(raw) {
	const text = raw.trim();
	if (text === "") return { kind: "ignore" };
	if (text === "[DONE]") return { kind: "done" };
	if (text === "[NOT_EXCEED_QUOTA]") return { kind: "ignore" };
	if (text.startsWith("[EXCEED_QUOTA]")) return {
		kind: "error",
		message: "Qoder 额度已用尽（EXCEED_QUOTA）"
	};
	if (text.startsWith("[NOTIFICATIONS]")) return { kind: "ignore" };
	let envelope;
	try {
		envelope = JSON.parse(text);
	} catch {
		return { kind: "ignore" };
	}
	if (typeof envelope !== "object" || envelope === null) return { kind: "ignore" };
	const record = envelope;
	if (record["statusCodeValue"] !== void 0 && record["body"] !== void 0) {
		const code = record["statusCodeValue"];
		if (typeof code === "number" && code !== 200) return {
			kind: "error",
			message: `Qoder 上游 ${code}：${(typeof record["body"] === "string" ? record["body"] : JSON.stringify(record["body"])).slice(0, 400)}`
		};
		const body = record["body"];
		if (typeof body !== "string") return typeof body === "object" && body !== null ? {
			kind: "chunk",
			chunk: body
		} : { kind: "ignore" };
		const inner = body.trim();
		if (inner === "") return { kind: "ignore" };
		if (inner === "[DONE]") return { kind: "done" };
		if (isControlSentinel(inner)) return { kind: "ignore" };
		try {
			return {
				kind: "chunk",
				chunk: JSON.parse(inner)
			};
		} catch {
			return { kind: "ignore" };
		}
	}
	if (Array.isArray(record["choices"])) return {
		kind: "chunk",
		chunk: record
	};
	return { kind: "ignore" };
}
/**
* 把一行上游 SSE 翻成一行标准 OpenAI SSE。
*
* - `null` = 丢弃（空行、注释、控制哨兵、无法解析的行）
* - `"data: [DONE]"` = 结束
* - `"data: {...}"` = 正常 chunk
*
* Qoder 的 `event:` 行与空行都丢弃 —— 我们只输出 `data:` 行，
* 由 shim 负责补分隔空行。
*/
function decodeQoderLine(line) {
	const trimmed = line.replace(/\r$/, "");
	if (trimmed === "") return null;
	if (trimmed.startsWith("event:") || trimmed.startsWith(":")) return null;
	if (!trimmed.startsWith("data:")) return null;
	const unwrapped = unwrapQoderEvent(trimmed.slice(5).replace(/^ /, ""));
	if (unwrapped.kind === "done") return "data: [DONE]";
	if (unwrapped.kind === "error") return `data: ${JSON.stringify({ error: {
		message: unwrapped.message,
		type: "qoder_error"
	} })}`;
	if (unwrapped.kind === "ignore") return null;
	return `data: ${JSON.stringify(unwrapped.chunk)}`;
}
/**
* 造出 shim 用的方言对象。
*
* `request` 负责：拼 Qoder 请求体 → 编码 → COSY 重签名（签名覆盖编码后的字节）。
*
* `sessionFor` 按本次选中的账号取会话（shim 的 `input.account` 贯通进来）；
* `account` 为 undefined 时（调用方还没带账号）由调用方自行落到缺省账号。
*/
function createQoderDialect(options) {
	const gateway = (options.gatewayBase ?? DEFAULT_GATEWAY).replace(/\/+$/, "");
	return {
		async request(input) {
			const session = await options.sessionFor(input.account);
			if (session === void 0) throw new Error("Qoder 凭据不可用（PAT 缺失或交换失败）");
			let parsed = {};
			try {
				parsed = JSON.parse(input.raw);
			} catch {}
			const body = buildQoderChatBody(parsed, input.model);
			const encoded = qoderEncodeBody(JSON.stringify(body));
			const url = `${gateway}${CHAT_PATH}`;
			return {
				url,
				headers: {
					...buildCosyHeaders(encoded, url, {
						userID: session.userID,
						authToken: session.jobToken,
						name: session.name,
						email: session.email
					}),
					"content-type": "application/octet-stream",
					accept: "text/event-stream"
				},
				body: encoded
			};
		},
		decodeLine: decodeQoderLine
	};
}
// src/channels/trae/catalog.ts
/**
* Trae 的模型目录。
*
* ## 目录从哪来
*
* 上游**没有**「列模型」的 HTTP 接口（`/api/ide/v1/**` 在国际版直接 404），
* 模型清单是客户端从服务端配置拉下来后缓存在本地的：`state.vscdb` 里的
* `AI.agent.model.model_list_map`，按 **function** 分组（`solo_agent_lite` /
* `solo_coder` / …）。每条带 `config_name`（发请求时用的模型标识）、
* `display_name`、上下文窗口、`max_tokens`、是否多模态。
*
* 所以这里读**本机 Trae 的缓存**，而不是自己去猜模型名。读不到时退回一份
* 已实测可用的小名单 —— 目录是建议性的，真发请求时上游认不认还是它说了算。
*
* ## 为什么按 function 分组很关键
*
* 请求体里的 `function` 决定服务端用哪套 function 注册表，`config_name`
* 必须落在**该 function 的**名单里。实测（2026-11-05）：
*
* ```
* solo_agent_lite + config_name=kimi-k3   → 200，provider_model_name=aws-kimi-k3
* solo_work_lite  + config_name=deepseek… → 4023 model is unknown
* ```
*
* 也就是说「模型能选」与「function 选对」是两件事。默认统一用
* {@link TRAE_DEFAULT_FUNCTION}（`solo_agent_lite`，实测覆盖全部 15 个预置
* 模型），需要别的 agent 时用 `config_name@solo_coder` 这种 id 显式指定。
*/
/** 默认 function：SOLO 的通用 agent，实测接受全部预置模型。 */
const TRAE_DEFAULT_FUNCTION = "solo_agent_lite";
/**
* 服务端为该 appId 注册过的 function 名（实测 86 个候选里只有这些通过）。
*
* 前 7 个对应 Trae 的 agent 分组，后 2 个是工具型 function。
* 只有这里的名字才能出现在模型 id 的 `@` 后缀里 —— 写错会得到
* `no function config found for appId=…`。
*/
const TRAE_FUNCTIONS = [
	"solo_work_lite",
	"solo_agent_lite",
	"solo_coder",
	"solo_work_remote",
	"solo_agent_remote",
	"solo_design_lite",
	"solo_design_remote",
	"multimodal",
	"refactor"
];
/**
* 读不到本地目录时的兜底名单。
*
* 只放**实测 200** 的预置模型（2026-11-05，`config_name` + `solo_agent_lite`）；
* 名称与上下文取自同机的 `model_list_map`。上下文窗口宁小勿大：
* 报大了上游会拒，报小了只是少用一点。
*/
const TRAE_FALLBACK_MODELS = [
	{
		id: "gpt-6.1-sol",
		name: "GPT-6.1-Sol",
		contextWindow: 272e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "gpt-6.1-terra",
		name: "GPT-6.1-Terra",
		contextWindow: 272e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6-Astra",
		contextWindow: 272e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "gpt-6-sol",
		name: "GPT-6-Sol",
		contextWindow: 272e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "gpt-6-luna",
		name: "GPT-6-Luna",
		contextWindow: 272e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini-3.1-Pro-Preview",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "gemini-3-flash-solo",
		name: "Gemini-3-Flash-Preview",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax-M2.7",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: false,
		reasoning: true
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek-V4.1-Flash",
		contextWindow: 2e5,
		maxTokens: 64e3,
		supportsImages: false,
		reasoning: true
	},
	{
		id: "deepseek-v4-pro-0813",
		name: "DeepSeek-V4-Pro",
		contextWindow: 2e5,
		maxTokens: 64e3,
		supportsImages: false,
		reasoning: true
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		contextWindow: 2e5,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "kimi-k2.5",
		name: "Kimi-K2.5",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: false,
		reasoning: true
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		contextWindow: 272e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: true
	},
	{
		id: "claude-sonnet-4.5",
		name: "Claude-Sonnet-4.5",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: true
	}
];
/** 找本机 Trae 的 `state.vscdb`；多个产品线时取第一个存在的。 */
function findTraeStateDb() {
	for (const root of traeUserDataRoots()) {
		const path = join(root, "User", "globalStorage", "state.vscdb");
		if (existsSync(path)) return path;
	}
}
/** 从 ItemTable 里读 model_list_map（key 前缀是机器/用户 id，所以用 LIKE）。 */
function readModelListMap(stateDbPath) {
	let db;
	try {
		db = new DatabaseSync(stateDbPath, { readOnly: true });
		const row = db.prepare("SELECT value FROM ItemTable WHERE key LIKE '%AI.agent.model.model_list_map' LIMIT 1").get();
		if (row?.value === void 0) return void 0;
		const raw = typeof row.value === "string" ? row.value : row.value instanceof Uint8Array ? Buffer.from(row.value).toString("utf8") : String(row.value);
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const map = {};
		for (const [key, value] of Object.entries(parsed)) if (Array.isArray(value)) map[key] = value;
		return map;
	} catch {
		return;
	} finally {
		try {
			db?.close();
		} catch {}
	}
}
function positiveNumber(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
}
function recordOf$1(value) {
	return typeof value === "object" && value !== null ? value : {};
}
/** 上下文窗口：优先 `context_window_tokens.dev`，退回 `context_window_size.default` 或 `max[0]`。 */
function contextWindowOf(entry) {
	const tokens = recordOf$1(entry["context_window_tokens"]);
	const size = recordOf$1(entry["context_window_size"]);
	const maxList = Array.isArray(size["max"]) ? size["max"] : [];
	return positiveNumber(tokens["dev"]) ?? positiveNumber(tokens["max"]) ?? positiveNumber(size["default"]) ?? positiveNumber(maxList[0]) ?? 128e3;
}
/**
* 一个 function 分组的原始条目 → 渠道模型。
*
* 过滤规则：
* - `config_name` 缺失/空 → 跳过（没有它就发不出请求）；
* - `custom_*` / 带 `//` 的自定义模型 → 跳过：那是用户自配的
*   openai-compatible 端点，上游对我们的 appId 一律回 4001（实测）。
* - 同 id 只保留第一次出现的（跨分组重复时先到先得）。
*/
function modelsFromListMap(map, functionName = TRAE_DEFAULT_FUNCTION) {
	const list = Array.isArray(map[functionName]) ? map[functionName] : [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of list) {
		const entry = recordOf$1(item);
		const id = typeof entry["config_name"] === "string" ? entry["config_name"].trim() : "";
		if (id === "" || seen.has(id)) continue;
		if (id.startsWith("custom_") || id.includes("//")) continue;
		seen.add(id);
		const reasoning = entry["model_type"] === "reasoning_model" || recordOf$1(recordOf$1(entry["features"])["reasoning"])["enable"] === true;
		out.push({
			id,
			name: typeof entry["display_name"] === "string" && entry["display_name"] !== "" ? entry["display_name"] : id,
			contextWindow: contextWindowOf(entry),
			maxTokens: positiveNumber(entry["max_tokens"]) ?? 32e3,
			supportsImages: entry["multimodal"] === true,
			reasoning
		});
	}
	return out;
}
/** 模型 id 里可以写 `@<function>` 覆盖默认 function，例如 `gpt-5.4@solo_coder`。 */
function decodeTraeModelId(raw, fallbackFunction = TRAE_DEFAULT_FUNCTION) {
	const id = typeof raw === "string" ? raw : "";
	const at = id.lastIndexOf("@");
	if (at > 0) {
		const fn = id.slice(at + 1);
		if (TRAE_FUNCTIONS.includes(fn)) return {
			model: id.slice(0, at),
			functionName: fn
		};
	}
	return {
		model: id,
		functionName: fallbackFunction
	};
}
/**
* 拉一次目录：读本机缓存 → 失败/为空退回内置名单。**不抛错**。
*
* 目录不是鉴权接口，拉不到不代表凭据坏了 —— 让 runtime 因为「读不到
* 目录」而起不来，等于把「Trae 客户端没装在这个用户下」误报成「凭据失效」。
*/
function fetchTraeCatalog(credential) {
	const stateDbPath = findTraeStateDb();
	if (stateDbPath !== void 0) {
		const map = readModelListMap(stateDbPath);
		if (map !== void 0) {
			const preferred = modelsFromListMap(map, TRAE_DEFAULT_FUNCTION);
			if (preferred.length > 0) return {
				models: preferred,
				source: "client",
				functionName: TRAE_DEFAULT_FUNCTION
			};
			let bestKey = "";
			let bestCount = 0;
			for (const [key, list] of Object.entries(map)) {
				const models = modelsFromListMap(map, key);
				if (models.length > bestCount) {
					bestCount = models.length;
					bestKey = key;
				}
			}
			if (bestKey !== "") return {
				models: modelsFromListMap(map, bestKey),
				source: "client",
				functionName: bestKey
			};
		}
	}
	return {
		models: TRAE_FALLBACK_MODELS,
		source: "fallback",
		functionName: TRAE_DEFAULT_FUNCTION,
		...stateDbPath === void 0 ? { error: "没找到本机 Trae 的 state.vscdb，使用内置模型名单" } : {}
	};
}
// src/channels/trae/chat.ts
/**
* OpenAI 的 `tool_calls` → Trae 的历史形状。
*
* 实测（2026-11-05）Trae **不认** OpenAI 的 `{function:{name,arguments}}`：
* 带这种历史的请求上游回
* `2001 LLMUtilsChat ChatStream failed: failed to receive stream event`。
* 它认的是旧版 OpenAI 形状 `{id, type:"function", function_call:{name, arguments}}`，
* 且 `arguments` 必须是 **JSON 字符串** —— 换成对象会被 Go 结构体拒。
*/
function toTraeToolCalls(value) {
	if (!Array.isArray(value) || value.length === 0) return void 0;
	const out = [];
	for (const raw of value) {
		const call = recordOf(raw);
		const fn = recordOf(call["function"]);
		const name = typeof fn["name"] === "string" ? fn["name"] : "";
		if (name === "") continue;
		const args = typeof fn["arguments"] === "string" ? fn["arguments"] : JSON.stringify(fn["arguments"] ?? {});
		out.push({
			id: typeof call["id"] === "string" ? call["id"] : "",
			type: "function",
			function_call: {
				name,
				arguments: args
			}
		});
	}
	return out.length === 0 ? void 0 : out;
}
/**
* OpenAI 的 `tools` → Trae 的 `tools`。
*
* 唯一的硬约束：`function.parameters` 必须是**字符串**。给对象时上游回
* `4001 bad request: json: cannot unmarshal object into Go struct field
* FunctionDefinition.tools.function.parameters of type string`（实测）。
*/
function toTraeTools(value) {
	if (!Array.isArray(value) || value.length === 0) return void 0;
	const out = [];
	for (const raw of value) {
		const fn = recordOf(recordOf(raw)["function"]);
		const name = typeof fn["name"] === "string" ? fn["name"] : "";
		if (name === "") continue;
		const parameters = typeof fn["parameters"] === "string" ? fn["parameters"] : JSON.stringify(fn["parameters"] ?? {});
		out.push({
			type: "function",
			function: {
				name,
				...typeof fn["description"] === "string" ? { description: fn["description"] } : {},
				parameters
			}
		});
	}
	return out.length === 0 ? void 0 : out;
}
function recordOf(value) {
	return typeof value === "object" && value !== null ? value : {};
}
/**
* OpenAI `messages` → Trae `messages`。
*
* `inlineSystem`（默认开）：把 system 文本并入首条 user 消息。Trae 的
* function 自带一套系统提示，直接发 `role:"system"` 不保证被接受；
* 并进 user 是最稳的写法（dsh-connect 的实测结论，我们沿用）。
*/
function toTraeMessages(messages, inlineSystem = true) {
	const list = Array.isArray(messages) ? messages : [];
	const out = [];
	const systemTexts = [];
	for (const item of list) {
		const message = recordOf(item);
		const role = typeof message["role"] === "string" ? message["role"] : "user";
		const parts = [];
		const content = message["content"];
		if (typeof content === "string") {
			if (content !== "") parts.push({
				type: "text",
				text: content
			});
		} else if (Array.isArray(content)) for (const raw of content) {
			const part = recordOf(raw);
			if (part["type"] === "text" && typeof part["text"] === "string") {
				if (part["text"] !== "") parts.push({
					type: "text",
					text: part["text"]
				});
			} else if (part["type"] === "image_url") {
				const image = recordOf(part["image_url"]);
				if (typeof image["url"] === "string" && image["url"] !== "") parts.push({
					type: "image_url",
					image_url: { url: image["url"] }
				});
			}
		}
		if (role === "system" || role === "developer") {
			if (inlineSystem) {
				for (const part of parts) if (typeof part.text === "string") systemTexts.push(part.text);
				continue;
			}
			if (parts.length === 0) continue;
			out.push({
				role: "system",
				content: parts
			});
			continue;
		}
		if (parts.length === 0 && role !== "assistant") continue;
		const mappedRole = role === "tool" || role === "function" ? "tool" : role === "assistant" ? "assistant" : "user";
		const message_ = {
			role: mappedRole,
			content: parts
		};
		if (mappedRole === "assistant") {
			const toolCalls = toTraeToolCalls(message["tool_calls"]);
			if (toolCalls !== void 0) message_.tool_calls = toolCalls;
		}
		if (mappedRole === "tool" && typeof message["tool_call_id"] === "string") message_.tool_call_id = message["tool_call_id"];
		out.push(message_);
	}
	if (systemTexts.length > 0) {
		const prefix = {
			type: "text",
			text: systemTexts.join("\n\n")
		};
		const firstUser = out.find((message) => message.role === "user");
		if (firstUser === void 0) out.unshift({
			role: "user",
			content: [{ ...prefix }]
		});
		else firstUser.content = [{ ...prefix }, ...firstUser.content];
	}
	if (out.length === 0) out.push({
		role: "user",
		content: [{
			type: "text",
			text: ""
		}]
	});
	return out;
}
/** 请求体（导出便于单测逐字比对）。 */
function buildTraeChatBody(openaiBody, model, functionName, credential) {
	const body = {
		app_id: credential.appId,
		app_version_code: credential.appVersionCode,
		function: functionName,
		config_name: model,
		messages: toTraeMessages(openaiBody["messages"]),
		stream: true
	};
	const maxTokens = openaiBody["max_tokens"] ?? openaiBody["max_completion_tokens"];
	if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) body["max_tokens"] = Math.trunc(maxTokens);
	const tools = toTraeTools(openaiBody["tools"]);
	if (tools !== void 0) body["tools"] = tools;
	const effort = openaiBody["reasoning_effort"];
	if (typeof effort === "string" && effort !== "") body["reasoning_effort"] = effort;
	const effortLevel = openaiBody["reasoning_effort_level"];
	if (typeof effortLevel === "number" && Number.isFinite(effortLevel)) body["reasoning_effort_level"] = Math.trunc(effortLevel);
	return body;
}
/** 上游错误码 → 人话。原始 message 常为空或指不到成因，必须翻译。 */
function explainTraeError(code, message) {
	const text = typeof message === "string" && message !== "" ? message : "";
	const numeric = typeof code === "number" ? code : void 0;
	if (numeric === 2001) return `Trae 未为该 appId 注册这个 function（可用：solo_agent_lite / solo_coder / solo_work_lite …）；原始响应：${text || "（空）"}`;
	if (numeric === 4023 || /model is unknown/i.test(text)) return "Trae 不认识这个模型名（config_name 必须来自该 function 的模型清单；面板「展开」可看）";
	if (numeric === 4001) return "Trae 认为参数非法（自定义 openai-compatible 模型不能走这条通道）";
	if (numeric === 4120) return "Trae 拒收了这个请求（4120）：多半是客户端身份头缺失（x-ide-version-code / x-app-id）或登录态不完整";
	if (/token|expired|unauthor|login/i.test(text)) return "Trae 登录态失效，请在 Trae 里重新登录后到面板点「一键认证」";
	return text !== "" ? text : numeric === void 0 ? "Trae 上游返回了空错误" : `Trae 上游错误码 ${numeric}`;
}
/** 每个请求一份的解码器（事件名状态不能跨请求）。 */
function createTraeEventDecoder(model) {
	const id = `chatcmpl-trae-${randomBytes(8).toString("hex")}`;
	const created = Math.floor(Date.now() / 1e3);
	let event = "";
	let usage;
	let finished = false;
	/** 已经发过「头部」（id/name）的 tool_call index —— 后续分片只带参数。 */
	const toolCallHeaders = /* @__PURE__ */ new Set();
	/** 本轮是否出现过工具调用（决定 finish_reason；Trae 自己回的是 `stop`）。 */
	let sawToolCalls = false;
	const chunk = (delta, finishReason) => {
		const payload = {
			id,
			object: "chat.completion.chunk",
			created,
			model,
			choices: [{
				index: 0,
				delta,
				finish_reason: finishReason ?? null
			}]
		};
		if (finishReason !== void 0 && usage !== void 0) payload["usage"] = {
			prompt_tokens: usage.prompt_tokens ?? 0,
			completion_tokens: usage.completion_tokens ?? 0,
			total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
		};
		return `data: ${JSON.stringify(payload)}`;
	};
	return (line) => {
		const text = line.replace(/\r$/, "");
		if (text === "") {
			event = "";
			return null;
		}
		if (text.startsWith(":")) return null;
		if (text.startsWith("event:")) {
			event = text.slice(6).trim();
			return null;
		}
		if (!text.startsWith("data:")) return null;
		const payload = text.slice(5).trim();
		if (payload === "") return null;
		let data;
		try {
			const parsed = JSON.parse(payload);
			if (typeof parsed !== "object" || parsed === null) return null;
			data = parsed;
		} catch {
			return null;
		}
		if (event === "output") {
			const reasoning = typeof data["reasoning_content"] === "string" ? data["reasoning_content"] : "";
			const content = typeof data["response"] === "string" ? data["response"] : "";
			const phase = typeof data["phase"] === "string" ? data["phase"] : "";
			const isThinking = phase !== "" && phase !== "final_answer";
			const lines = [];
			if (reasoning !== "") lines.push(chunk({ reasoning_content: reasoning }));
			if (content !== "") lines.push(chunk(isThinking ? { reasoning_content: content } : { content }));
			if (Array.isArray(data["tool_calls"]) && data["tool_calls"].length > 0) {
				const mapped = [];
				for (const raw of data["tool_calls"]) {
					const call = recordOf(raw);
					const index = typeof call["index"] === "number" ? call["index"] : 0;
					const fn = recordOf(call["function_call"]);
					const callId = typeof call["id"] === "string" ? call["id"] : "";
					const name = typeof fn["name"] === "string" ? fn["name"] : "";
					const args = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
					if (callId === "" && name === "" && args === "") continue;
					const entry = {
						index,
						function: {}
					};
					const fnOut = entry["function"];
					if (!toolCallHeaders.has(index)) {
						if (callId !== "") entry["id"] = callId;
						entry["type"] = "function";
						if (name !== "") fnOut["name"] = name;
						if (callId !== "" || name !== "") toolCallHeaders.add(index);
					}
					if (args !== "") fnOut["arguments"] = args;
					if (name !== "") sawToolCalls = true;
					mapped.push(entry);
				}
				if (mapped.length > 0) lines.push(chunk({ tool_calls: mapped }));
			}
			return lines.length === 0 ? null : lines.join("\n\n");
		}
		if (event === "token_usage") {
			usage = {
				...typeof data["prompt_tokens"] === "number" ? { prompt_tokens: data["prompt_tokens"] } : {},
				...typeof data["completion_tokens"] === "number" ? { completion_tokens: data["completion_tokens"] } : {},
				...typeof data["total_tokens"] === "number" ? { total_tokens: data["total_tokens"] } : {}
			};
			return `data: ${JSON.stringify({
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [],
				usage: {
					prompt_tokens: usage.prompt_tokens ?? 0,
					completion_tokens: usage.completion_tokens ?? 0,
					total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
				}
			})}`;
		}
		if (event === "error") {
			const message = explainTraeError(data["code"], data["message"]);
			return `data: ${JSON.stringify({ error: {
				message,
				type: "trae_error",
				code: data["code"] ?? null
			} })}`;
		}
		if (event === "done") {
			if (finished) return null;
			finished = true;
			const upstreamReason = typeof data["finish_reason"] === "string" ? data["finish_reason"] : "stop";
			return `${chunk({}, sawToolCalls ? "tool_calls" : upstreamReason)}\n\ndata: [DONE]`;
		}
		return null;
	};
}
/** 造 shim 用的方言。 */
function createTraeDialect(options) {
	const fallbackFunction = options.functionName ?? "solo_agent_lite";
	return { async request(input) {
		const credential = await options.credentialFor(input.account);
		if (credential === void 0) throw new Error("Trae 凭据不可用（token 文件缺失或已失效）");
		assertTraeTokenFresh(credential);
		let parsed = {};
		try {
			parsed = JSON.parse(input.raw);
		} catch {}
		const decoded = decodeTraeModelId(input.model, fallbackFunction);
		const body = buildTraeChatBody(parsed, decoded.model, decoded.functionName, credential);
		return {
			url: `${credential.gateway.replace(/\/+$/, "")}/api/agent/v3/llm_utils_chat`,
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				authorization: `Cloud-IDE-JWT ${credential.token}`,
				"x-ide-token": credential.token,
				"x-ide-version-code": String(credential.appVersionCode),
				"x-app-id": credential.appId,
				"user-agent": "TraeClient/TTNet"
			},
			body: JSON.stringify(body),
			decodeLine: createTraeEventDecoder(decoded.model)
		};
	} };
}
// src/state/runtime.ts
/**
* 账号的 credential_ref（指向 vault/auth/PAT 文件的路径引用）。
*
* 存储层有意不给面板查询返回凭据列（queries.ts 只给 has_credential），
* 而 runtime 是唯一需要「引用 → 现读文件」的通路，所以这里有一条只读
* SELECT。凭据本身永远不进 DB/日志 —— 读到的 token 只进请求头。
*/
function credentialRefOf(db, accountId) {
	return db.prepare("SELECT credential_ref FROM accounts WHERE id = ? AND deleted = 0").get(accountId)?.credential_ref ?? null;
}
/** 现读 PAT；不是 `pt-` 开头或读不了都算没有（fail-soft）。 */
function patOf(db, accountId) {
	const ref = credentialRefOf(db, accountId);
	if (ref === null) return void 0;
	if (ref.startsWith("env:")) {
		const value = process.env[ref.slice(4)]?.trim();
		return value !== void 0 && value.startsWith("pt-") ? {
			pat: value,
			source: ref
		} : void 0;
	}
	try {
		const pat = readFileSync(ref, "utf8").trim();
		return pat.startsWith("pt-") ? {
			pat,
			source: ref
		} : void 0;
	} catch {
		return;
	}
}
function toPanelEntries(models) {
	return models.map((m) => ({
		id: m.id,
		name: m.name,
		...m.creditMultiplier === void 0 ? {} : { creditMultiplier: m.creditMultiplier },
		...m.promotionBadge === void 0 ? {} : { promotionBadge: m.promotionBadge },
		...m.tierBadge === void 0 ? {} : { tierBadge: m.tierBadge },
		...m.promotionColor === void 0 ? {} : { promotionColor: m.promotionColor },
		...m.tierColor === void 0 ? {} : { tierColor: m.tierColor }
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
function createRegisterAdapter(shim) {
	return (ctx, providerId, models, report) => {
		const host = ctx;
		let released = false;
		let release;
		(async () => {
			const [{ PiAiAdapter }, { createProvider }, { openAICompletionsApi }, { resolveRetryPolicy, resolveImageAttachmentAccess }] = await Promise.all([
				import("@deepseek-ai/dsh-llm-pi-ai"),
				import("@earendil-works/pi-ai"),
				import("@earendil-works/pi-ai/api/openai-completions.lazy"),
				import("@deepseek-ai/dsh-llm")
			]);
			if (released) return;
			const hostCtx = ctx;
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
				resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => hostCtx.get?.("fs")?.processPathFromHostPath?.(hostPath), ref)
			});
			if (released) return;
			release = host.llm.registerAdapter([providerId], adapter);
			try {
				const ids = (await adapter.listModels(providerId)).map((m) => m.id);
				if (ids.length === 0) {
					host.logger?.warn?.("dsh-model-hub: provider 注册成功但模型列表为空 —— 检查 provider.ts 的 piProvider");
					await report({
						ok: false,
						modelCount: 0,
						modelIds: [],
						error: "listModels returned no models"
					});
					return;
				}
				host.logger?.info?.(`dsh-model-hub: provider 注册完成（${ids.length} 个模型可被选中）`);
				await report({
					ok: true,
					modelCount: ids.length,
					modelIds: ids
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				host.logger?.error?.("dsh-model-hub: provider 注册后自检失败", error);
				await report({
					ok: false,
					modelCount: 0,
					error: message
				});
			}
		})().catch(async (error) => {
			const message = error instanceof Error ? error.message : String(error);
			host.logger?.error?.("dsh-model-hub: provider 注册失败", error);
			await report({
				ok: false,
				modelCount: 0,
				error: message
			}).catch(() => {});
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
async function startChannelRuntime(deps) {
	const { db, channelId, kind, state, logger } = deps;
	let models = [];
	let panelEntries = [];
	let adapterRelease;
	const qoderSessions = /* @__PURE__ */ new Map();
	let defaultQoderSession;
	async function qoderSessionFor(accountId) {
		if (accountId === void 0) {
			defaultQoderSession ??= createSessionManager();
			return defaultQoderSession.current();
		}
		const found = patOf(db, accountId);
		if (found === void 0) return void 0;
		const cached = qoderSessions.get(accountId);
		if (cached !== void 0 && cached.pat === found.pat) return cached.manager.current();
		const manager = createSessionManager({ readCredential: () => found });
		qoderSessions.set(accountId, {
			pat: found.pat,
			manager
		});
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
	async function traeCredentialFor(accountId) {
		const target = accountId ?? state.pick(channelId)?.id;
		if (target === void 0) return void 0;
		const ref = credentialRefOf(db, target);
		if (ref === null) return void 0;
		try {
			return readTraeCredentialFile(ref);
		} catch {
			return;
		}
	}
	/** WorkBuddy：按 credential_ref 现读 auth 文件（裁定：非 plain / 无 token 抛错，shim 外层 catch 转 502）。 */
	async function prepareWorkbuddy(accountId) {
		const ref = credentialRefOf(db, accountId);
		if (ref === null) throw new Error(`账号 ${accountId} 没有 credential_ref`);
		const parsed = parseAuthDocument(readFileSync(ref, "utf8"));
		if (parsed.kind !== "plain" || parsed.token === void 0) throw new Error(`账号 ${accountId} 的凭据不可用（${ref}，状态 ${parsed.kind}）`);
		return {
			baseUrl: upstreamBase(parsed.region ?? "global"),
			headers: {
				Authorization: `Bearer ${parsed.token}`,
				"User-Agent": DESKTOP_UA,
				...conversationIdentityHeaders()
			},
			account: { id: accountId }
		};
	}
	async function prepare() {
		const row = state.pick(channelId);
		if (row === void 0) throw new Error(`渠道 ${channelId} 没有可用账号`);
		if (kind === "qoder") return {
			baseUrl: "https://qoder.invalid",
			headers: {},
			account: { id: row.id }
		};
		if (kind === "trae") {
			if (await traeCredentialFor(row.id) === void 0) throw new Error(`账号 ${row.id} 的 Trae 凭据不可用（token 文件缺失或已失效）`);
			return {
				baseUrl: "https://trae.invalid",
				headers: {},
				account: { id: row.id }
			};
		}
		return prepareWorkbuddy(row.id);
	}
	/** 用当前池头账号的凭据拉目录；拿不到凭据/目录就抛错（由调用方记日志）。 */
	async function fetchCatalogForHead() {
		const head = state.pick(channelId);
		if (head === void 0) throw new Error(`渠道 ${channelId} 没有可用账号，无法拉目录`);
		if (kind === "qoder") {
			const session = await qoderSessionFor(head.id);
			if (session === void 0) throw new Error(`账号 ${head.id} 的 Qoder 凭据不可用（PAT 缺失或交换失败）`);
			const result = await fetchQoderCatalog(session);
			if (result.error !== void 0) throw new Error(`Qoder 目录拉取失败：${result.error}`);
			return result.models;
		}
		if (kind === "trae") {
			const credential = await traeCredentialFor(head.id);
			if (credential === void 0) throw new Error(`账号 ${head.id} 的 Trae 凭据不可用（token 文件缺失或已失效）`);
			const result = fetchTraeCatalog(credential);
			if (result.error !== void 0) logger.warn?.(`dsh-model-hub: ${channelId} ${result.error}`);
			if (result.models.length === 0) throw new Error("Trae 目录为空（本机缓存与内置名单都没有可用模型）");
			return result.models;
		}
		const ref = credentialRefOf(db, head.id);
		if (ref === null) throw new Error(`账号 ${head.id} 没有 credential_ref`);
		const parsed = parseAuthDocument(readFileSync(ref, "utf8"));
		if (parsed.kind !== "plain" || parsed.token === void 0) throw new Error(`账号 ${head.id} 的凭据不可用（${ref}，状态 ${parsed.kind}）`);
		return fetchCatalog(parsed.region ?? "global", parsed.token);
	}
	function register() {
		if (adapterRelease !== void 0) return;
		if (models.length === 0) {
			logger.warn?.(`dsh-model-hub: ${channelId} 目录为空，不上架 adapter`);
			return;
		}
		adapterRelease = registerAdapter(deps.ctx, channelId, models, async (outcome) => {
			logger.info?.(`dsh-model-hub: ${channelId} provider 注册结果 ok=${outcome.ok} models=${outcome.modelCount}` + (outcome.error === void 0 ? "" : ` error=${outcome.error}`));
			await deps.onRegisterReport?.({
				...outcome,
				provider: channelId,
				shim: shim.baseUrl(),
				catalogCount: models.length
			});
		});
	}
	function releaseAdapter() {
		const release = adapterRelease;
		adapterRelease = void 0;
		try {
			release?.();
		} catch (error) {
			logger.warn?.(`dsh-model-hub: ${channelId} adapter 下架失败（忽略）`, error);
		}
	}
	const shim = await startShim({
		prepare,
		...kind === "qoder" ? { dialect: createQoderDialect({ sessionFor: (account) => qoderSessionFor(account?.id) }) } : {},
		...kind === "trae" ? { dialect: createTraeDialect({ credentialFor: (account) => traeCredentialFor(account?.id) }) } : {},
		maxAttempts: () => Math.min(3, state.poolSize(channelId)),
		onAccountResult: (account, ok, status, error) => {
			state.reportResult(channelId, account.id, ok, status, error);
		},
		record: makeRecorder(db, channelId, () => deps.settings().recordEnabled !== false)
	});
	const registerAdapter = deps.registerAdapter ?? createRegisterAdapter(shim);
	try {
		models = await fetchCatalogForHead();
		panelEntries = toPanelEntries(models);
		register();
	} catch (error) {
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
		get models() {
			return models;
		},
		get panelEntries() {
			return panelEntries;
		},
		async refresh() {
			const wasOn = adapterRelease !== void 0;
			const wasEmpty = models.length === 0;
			let next;
			try {
				next = await fetchCatalogForHead();
			} catch (error) {
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
		setEnabled(enabled) {
			if (enabled) register();
			else releaseAdapter();
		}
	};
}
/**
* 造一个「把请求写进记录表」的回调（从 index.ts 的 makeRecorder 迁来并参数化）。
*
* 与 index.ts 版本的差别只有两处：enabled 从 settings 现读；account_id 贯通
* 入库 —— 多账号之后「谁在服务」是记录表要回答的问题。
*/
function makeRecorder(db, channelId, enabled) {
	return (input) => {
		if (!enabled()) return;
		const { metrics, statusCode, error, isStreaming, model } = input;
		try {
			insertRequest(db, {
				requestId: randomUUID(),
				channelId,
				...input.accountId === void 0 ? {} : { accountId: input.accountId },
				provider: channelId,
				model,
				inputTokens: metrics.inputTokens,
				outputTokens: metrics.outputTokens,
				cacheRead: metrics.cacheRead,
				cacheWrite: metrics.cacheWrite,
				...metrics.firstTokenMs === void 0 ? {} : { firstTokenMs: metrics.firstTokenMs },
				...metrics.upstreamHeadMs === void 0 ? {} : { upstreamHeadMs: metrics.upstreamHeadMs },
				...metrics.durationMs === void 0 ? {} : { durationMs: metrics.durationMs },
				...metrics.decodeTps === void 0 ? {} : { decodeTps: metrics.decodeTps },
				...statusCode === void 0 ? {} : { statusCode },
				...error === void 0 ? {} : { error },
				isStreaming,
				estimated: metrics.estimated,
				costUnits: 0,
				createdAt: Date.now()
			});
		} catch {}
	};
}
// src/routes/data.ts
/** 面板数据路由前缀。客户端与这里必须一致。 */
const DATA_PREFIX = "/plugins/dsh-model-hub";
const LOOPBACK$1 = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"[::1]"
]);
function hostIsLoopback$1(host) {
	if (host === void 0) return false;
	const name = host.replace(/:\d+$/, "").toLowerCase();
	if (LOOPBACK$1.has(name)) return true;
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
function registerDataRoutes(ctx, deps) {
	ctx.inject(["webServer"], (inner) => {
		try {
			inner.effect(() => {
				const disposers = [
					inner.webServer.register({
						kind: "exact",
						path: `${DATA_PREFIX}/summary`,
						handler: (req, res) => {
							if (!gate(req, res)) return;
							json$1(res, 200, querySummary(deps.db));
						}
					}),
					inner.webServer.register({
						kind: "exact",
						path: `${DATA_PREFIX}/catalog`,
						handler: (req, res) => {
							if (!gate(req, res)) return;
							json$1(res, 200, { models: deps.catalog?.() ?? [] });
						}
					}),
					inner.webServer.register({
						kind: "exact",
						path: `${DATA_PREFIX}/records`,
						handler: (req, res) => {
							if (!gate(req, res)) return;
							const url = new URL(req.url ?? "/", "http://localhost");
							const rawLimit = Number(url.searchParams.get("limit") ?? "200");
							const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200;
							const channelId = url.searchParams.get("channel") ?? void 0;
							const model = url.searchParams.get("model") ?? void 0;
							const hours = Number(url.searchParams.get("hours") ?? "");
							const sinceMs = Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 36e5 : void 0;
							json$1(res, 200, {
								requests: queryRequests(deps.db, {
									limit,
									channelId,
									model,
									sinceMs
								}),
								models: queryModels(deps.db).map((row) => row.model)
							});
						}
					}),
					inner.webServer.register({
						kind: "exact",
						path: `${DATA_PREFIX}/channels`,
						handler: (req, res) => {
							if (!gate(req, res)) return;
							json$1(res, 200, {
								channels: queryChannels(deps.db),
								accounts: queryAccounts(deps.db),
								models_by_channel: deps.modelsByChannel?.() ?? {},
								usage_by_account: Object.fromEntries(queryAccountUsage(deps.db).map((row) => [row.account_id, {
									requests: row.today_requests,
									tokens: row.today_tokens
								}]))
							});
						}
					}),
					inner.webServer.register({
						kind: "exact",
						path: `${DATA_PREFIX}/diag`,
						handler: (req, res) => {
							if (!gate(req, res)) return;
							const settings = deps.settings?.();
							json$1(res, 200, {
								...queryDiagFacts(deps.db),
								...deps.diag?.() ?? {},
								recordEnabled: settings?.recordEnabled !== false,
								retentionDays: settings?.retentionDays ?? 90
							});
						}
					})
				];
				return () => {
					for (const dispose of disposers) try {
						dispose();
					} catch {}
				};
			}, "dsh-model-hub: data routes");
		} catch (error) {
			inner.logger?.error?.("dsh-model-hub: 数据路由注册失败（面板不可用，provider 不受影响）", error);
		}
	});
}
/** 回环 + 方法校验。返回 true 表示可以继续处理。 */
function gate(req, res) {
	if (!hostIsLoopback$1(req.headers?.host)) {
		json$1(res, 403, { error: "host_not_allowed" });
		return false;
	}
	const method = String(req.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		json$1(res, 405, { error: "method_not_allowed" });
		return false;
	}
	return true;
}
function json$1(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
// src/probe/prober.ts
/** 渠道 id 派生（与 index.ts 同源不同处：那是只读参考，本任务不改它）。 */
const PROVIDER_GLOBAL$2 = `${PROVIDER_PREFIX}workbuddy-global`;
const PROVIDER_QODER$2 = `${PROVIDER_PREFIX}qoder-cn`;
/** Trae 渠道 id（与 index.ts 的 PROVIDER_TRAE 一致）。 */
const PROVIDER_TRAE$2 = `${PROVIDER_PREFIX}trae`;
/** 贴 PAT 的格式门：pt- 开头 + 至少 8 位（与简报逐字一致）。 */
const PAT_PATTERN = /^pt-[A-Za-z0-9_-]{8,}$/;
/** Qoder PAT 的环境变量来源，顺序即报告顺序（与 readPat 一致）。 */
const QODER_ENV_VARS = [
	"QODERCN_PAT",
	"QODERCN_PERSONAL_ACCESS_TOKEN",
	"QODERCN_API_KEY"
];
/** PAT 验活失败时的官方入口 —— 每一条失败 detail 都要带上。 */
const PAT_GUIDE = "到 https://qoder.com.cn/account/integrations 新建 PAT";
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/** PAT 全文一旦出现在错误文案里就隐去 —— 上游回显不该变成我们的泄漏面。 */
function redact(text, pats) {
	let out = text;
	for (const pat of pats) if (pat !== "" && out.includes(pat)) out = out.split(pat).join("（PAT 已隐去）");
	return out;
}
/** 错误消息里抓 HTTP 状态码：fetchCatalog 与 exchangePat 的错误文案都带「HTTP nnn」。 */
function statusFromError(message) {
	const match = /HTTP (\d{3})/.exec(message);
	return match === null ? void 0 : Number(match[1]);
}
/**
* 按 uid 在已有账号的凭据文件里找账号 id。
*
* 转发到 `channels/workbuddy/identity.ts` 的单一裁决点 —— 启动装配层与一键
* 认证必须用**同一个**判定，否则又会造出「同一账号两行」（2026-10-29 真机
* 事故）。这里保留薄封装只是为了让调用点读起来顺。
*/
function findAccountIdByUid(db, uid, source) {
	return resolveAccountId(db, PROVIDER_GLOBAL$2, uid, source);
}
/**
* 注入 fetch 的桥梁：fetchCatalog / exchangePat 的生产实现内部取 globalThis.fetch，
* 这里在调用期间临时换入注入实现，结束（含抛错）恢复。只影响本次调用窗口，
* 生产路径（fetchImpl 缺省）完全不动全局。
*/
async function withFetch(fetchImpl, run) {
	if (fetchImpl === void 0) return run();
	const globe = globalThis;
	const original = globe.fetch;
	globe.fetch = fetchImpl;
	try {
		return await run();
	} finally {
		globe.fetch = original;
	}
}
/** 渠道级聚合：全 ok=ok、部分=partial、全败（含零来源）=missing。 */
function channelStatusOf(sources) {
	const ok = sources.filter((s) => s.status === "ok").length;
	if (ok === 0) return "missing";
	return ok === sources.length ? "ok" : "partial";
}
/** 备注名 → slug：小写化后非 [a-z0-9-] 连段转 -、去首尾 -、截 32（§3.2 先例的净化口径）。 */
function slugify(name) {
	return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
}
/** 账号 inventory：id 全集（含软删，防 slug 撞上已删账号后被 upsert 守卫静默吞掉）。 */
function allAccountIds(db) {
	const rows = db.prepare("SELECT id FROM accounts").all();
	return new Set(rows.map((r) => r.id));
}
/**
* slug 取用：备注名净化优先，空则回落 `pat-<前 6 位>`（pt- 后 6 位）。
* 与已有 `.pat` 文件或已有账号 id 冲突时追加 -2、-3……（§3.2 的冲突先例）。
* 文件也计入冲突 —— 软删账号的 PAT 文件还留在盘上，重名不该覆盖它。
*/
function pickSlug(db, dir, pat, displayName) {
	const base = slugify(displayName ?? "") || `pat-${pat.slice(3, 9)}`;
	const takenIds = allAccountIds(db);
	let slug = base;
	for (let n = 2; n <= 100; n += 1) {
		if (!existsSync(join(dir, `${slug}.pat`)) && !takenIds.has(`${PROVIDER_QODER$2}:${slug}`)) return slug;
		slug = `${base}-${n}`;
	}
	throw new Error(`拿不到可用的账号标识（${base}-2 … -100 全被占用）`);
}
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
async function probeWorkbuddySources(deps, secrets) {
	const sources = [];
	const present = [];
	const decryptedOut = [];
	const candidates = authCandidates();
	const explicit = process.env["WORKBUDDY_AUTH_FILE"];
	for (const path of candidates) {
		if (!existsSync(path)) {
			if (explicit !== void 0 && explicit !== "" && path === explicit) sources.push({
				source: path,
				status: "missing",
				detail: `${path}（文件不存在 —— 检查 WORKBUDDY_AUTH_FILE）`
			});
			continue;
		}
		let kind = "missing";
		let token;
		try {
			const parsed = parseAuthDocument(readFileSync(path, "utf8"));
			kind = parsed.kind;
			if (parsed.kind === "plain" && parsed.token !== void 0) token = parsed.token;
		} catch (error) {
			const bad = {
				source: path,
				status: "error",
				detail: `${path}（读取失败：${messageOf$1(error)}）`
			};
			sources.push(bad);
			present.push(bad);
			continue;
		}
		if (token !== void 0) secrets.push(token);
		if (kind === "encrypted" && deps.decryptAuthFile !== void 0) try {
			const decrypted = await deps.decryptAuthFile(path);
			secrets.push(decrypted.accessToken);
			await withFetch(deps.fetchImpl, () => fetchCatalog(decrypted.region ?? "global", decrypted.accessToken));
			decryptedOut.push({
				path,
				decrypted
			});
			const ok = {
				source: path,
				status: "ok",
				detail: `${path}（App 内置解密成功，token 验活通过）`
			};
			sources.push(ok);
			present.push(ok);
			continue;
		} catch (error) {
			const failed = {
				source: path,
				status: "encrypted",
				detail: redact(`${path}（加密信封；内置解密失败：${messageOf$1(error)}）`, secrets)
			};
			sources.push(failed);
			present.push(failed);
			continue;
		}
		const entry = {
			source: path,
			status: kind === "plain" ? "ok" : kind,
			detail: kind === "plain" ? `${path}（明文 token 可用）` : kind === "encrypted" ? `${path}（token 是加密信封；一键认证需内置解密，或装 dsh-connect-workbuddy 写一次 vault）` : `${path}（文件里没有可用的 accessToken）`
		};
		sources.push(entry);
		present.push(entry);
	}
	const entries = listVaultEntries();
	for (const entry of entries) {
		const vault = {
			source: entry.source,
			status: "ok",
			detail: `${entry.source}（vault，${entry.region}）`
		};
		sources.push(vault);
		present.push(vault);
	}
	if (sources.length === 0) sources.push({
		source: "workbuddy-auth",
		status: "missing",
		detail: `未找到 WorkBuddy 登录文件；已搜索：${candidates.join("、")}`
	});
	return {
		sources,
		present,
		entries,
		decrypted: decryptedOut
	};
}
/**
* Qoder 侧来源枚举：旧 `<dshHome>/qoder/pat` + env（pt- 开头才收）+
* `<dshHome>/model-hub/qoder-pats/*.pat`，逐个 exchangePat 验活。
* 没有凭据的机器 sources 为空 —— 渠道级即 missing。
*
* `pats` 由调用方持有（与 {@link probeWorkbuddySources} 的 secrets 同一角色）：
* 内部逐条 redact 用它，意外异常冒出时外层 fail-soft catch 用同一份兜底。
*/
async function probeQoderSources(deps, pats) {
	const home = deps.dshHome ?? resolveDshHome$1();
	const exchange = deps.exchangePat ?? exchangePat;
	const sources = [];
	const validated = [];
	const candidates = [];
	const legacy = join(home, "qoder", "pat");
	if (existsSync(legacy)) try {
		const value = readFileSync(legacy, "utf8").trim();
		if (value.startsWith("pt-")) candidates.push({
			source: legacy,
			pat: value
		});
		else sources.push({
			source: legacy,
			status: "missing",
			detail: `${legacy}（内容不是 pt- 开头）`
		});
	} catch (error) {
		sources.push({
			source: legacy,
			status: "error",
			detail: `${legacy}（读取失败：${messageOf$1(error)}）`
		});
	}
	for (const name of QODER_ENV_VARS) {
		const value = process.env[name]?.trim();
		if (value !== void 0 && value.startsWith("pt-")) candidates.push({
			source: `env:${name}`,
			pat: value
		});
	}
	for (const file of listPatFiles(join(home, HUB_DIR_NAME, "qoder-pats"))) candidates.push({
		source: file.source,
		pat: file.pat
	});
	for (const candidate of candidates) {
		pats.push(candidate.pat);
		try {
			const session = await exchange(candidate.pat, candidate.source);
			validated.push({
				source: candidate.source,
				session
			});
			sources.push({
				source: candidate.source,
				status: "ok",
				detail: `${candidate.source}（PAT 验活通过）`
			});
		} catch (error) {
			sources.push({
				source: candidate.source,
				status: "error",
				detail: `${redact(messageOf$1(error), pats)}；${PAT_GUIDE}`
			});
		}
	}
	return {
		sources,
		validated
	};
}
/**
* 一键认证：扫描两渠道的全部凭据来源 → 三态报告 → 顺手把 WorkBuddy vault 的
* 账号登记进库（已存在的 id 幂等跳过，不计入 accountsAdded）→ 池非空时确保 runtime。
*
* fail-soft：单渠道探测抛错只把该渠道记为 missing + error 来源，不拖垮整体报告。
* Qoder 侧只验活不登记 —— 添加 Qoder 账号是 addQoderPat 的职责（写文件 + 入库 + 起 runtime）。
*/
async function oneClickAuth(deps, db, state) {
	const channels = [];
	const wbSecrets = [];
	const qoderSecrets = [];
	try {
		const { sources, present, entries, decrypted } = await probeWorkbuddySources(deps, wbSecrets);
		let accountsAdded = 0;
		const home = deps.dshHome ?? resolveDshHome$1();
		const channelHasLive = queryAccounts(db).some((a) => a.channel_id === PROVIDER_GLOBAL$2);
		const taken = new Set(db.prepare("SELECT id FROM accounts").all().map((row) => row.id));
		const channel = {
			id: PROVIDER_GLOBAL$2,
			kind: "workbuddy",
			displayName: "WorkBuddy Global"
		};
		const fresh = [];
		for (const entry of entries) {
			const id = (entry.identity.uid !== void 0 ? findAccountIdByUid(db, entry.identity.uid, entry.source) : resolveAccountId(db, PROVIDER_GLOBAL$2, void 0, entry.source)) ?? `${PROVIDER_GLOBAL$2}:${entry.accountId}`;
			if (taken.has(id)) continue;
			fresh.push({
				id,
				channelId: PROVIDER_GLOBAL$2,
				displayName: entry.identity.nickname ?? (entry.identity.uid !== void 0 ? `WB · ${entry.identity.uid.slice(0, 8)}` : entry.accountId),
				credentialRef: entry.source,
				isCurrent: fresh.length === 0 && !channelHasLive
			});
		}
		for (const { decrypted: dec } of decrypted) {
			const uid = dec.accountUid ?? `anon-${createHash("sha256").update(String(decrypted.length)).digest("hex").slice(0, 12)}`;
			const tokenPath = writeWorkbuddyTokenFile(home, {
				accountUid: uid,
				accessToken: dec.accessToken,
				...dec.refreshToken === void 0 ? {} : { refreshToken: dec.refreshToken },
				...dec.nickname === void 0 ? {} : { nickname: dec.nickname },
				region: dec.region ?? "global",
				...dec.expiresAtMs === void 0 ? {} : { expiresAtMs: dec.expiresAtMs }
			});
			const derivedId = `${PROVIDER_GLOBAL$2}:${accountIdSuffixOf(uid)}`;
			const existingId = findAccountIdByUid(db, uid, tokenPath) ?? (taken.has(derivedId) ? derivedId : void 0);
			const id = existingId ?? derivedId;
			const isNew = existingId === void 0;
			if (isNew && taken.has(id)) continue;
			fresh.push({
				id,
				channelId: PROVIDER_GLOBAL$2,
				displayName: dec.nickname ?? `WB · ${uid.slice(0, 8)}`,
				credentialRef: tokenPath,
				isCurrent: isNew && fresh.length === 0 && !channelHasLive
			});
		}
		if (fresh.length > 0) {
			seedChannelsAndAccounts(db, [channel], fresh);
			accountsAdded = fresh.filter((a) => !taken.has(a.id)).length;
		}
		if (state.poolSize(PROVIDER_GLOBAL$2) > 0) await state.ensureRuntime(PROVIDER_GLOBAL$2);
		channels.push({
			id: PROVIDER_GLOBAL$2,
			status: channelStatusOf(present),
			sources,
			accountsAdded
		});
	} catch (error) {
		channels.push({
			id: PROVIDER_GLOBAL$2,
			status: "missing",
			sources: [{
				source: "workbuddy",
				status: "error",
				detail: `扫描失败：${redact(messageOf$1(error), wbSecrets)}`
			}],
			accountsAdded: 0
		});
	}
	try {
		const { sources, validated } = await probeQoderSources(deps, qoderSecrets);
		for (const { source, session } of validated) {
			const identityName = session.name || session.email || "";
			if (identityName === "") continue;
			const row = db.prepare("SELECT id, display_name FROM accounts WHERE credential_ref = ? AND deleted = 0").get(source);
			if (row !== void 0 && row.display_name === "Qoder CN 账号") db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(identityName, row.id);
		}
		channels.push({
			id: PROVIDER_QODER$2,
			status: channelStatusOf(sources),
			sources,
			accountsAdded: 0
		});
	} catch (error) {
		channels.push({
			id: PROVIDER_QODER$2,
			status: "missing",
			sources: [{
				source: "qoder",
				status: "error",
				detail: `扫描失败：${redact(messageOf$1(error), qoderSecrets)}`
			}],
			accountsAdded: 0
		});
	}
	try {
		const result = await importTraeLocal(deps, db, state);
		channels.push({
			id: PROVIDER_TRAE$2,
			status: "ok",
			sources: [{
				source: result.path,
				status: "ok",
				detail: result.added ? `从本机 Trae 导入 ${result.displayName}（${result.path}）` : `已登记 ${result.displayName}，凭据引用已刷新（${result.path}）`
			}],
			accountsAdded: result.added ? 1 : 0
		});
	} catch (error) {
		channels.push({
			id: PROVIDER_TRAE$2,
			status: "missing",
			sources: [{
				source: "trae",
				status: "missing",
				detail: redact(messageOf$1(error), [])
			}],
			accountsAdded: 0
		});
	}
	return {
		channels,
		at: Date.now()
	};
}
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
async function testAccount(deps, db, state, accountId) {
	const row = db.prepare("SELECT channel_id, credential_ref FROM accounts WHERE id = ? AND deleted = 0").get(accountId);
	if (row === void 0) return {
		ok: false,
		detail: `账号 ${accountId} 不存在`,
		ms: 0
	};
	const started = Date.now();
	let ok = false;
	let detail;
	let status;
	try {
		if (row.channel_id === PROVIDER_QODER$2) detail = await testQoderCredential(deps, row.credential_ref);
		else if (row.channel_id === PROVIDER_TRAE$2) detail = await testTraeCredential(deps, row.credential_ref);
		else detail = await testWorkbuddyCredential(deps, row.credential_ref);
		ok = true;
	} catch (error) {
		detail = messageOf$1(error);
		status = statusFromError(detail);
		if (row.channel_id === PROVIDER_QODER$2) detail = `${detail}；${PAT_GUIDE}`;
	}
	const ms = Date.now() - started;
	markAccountResult(db, accountId, ok, ok ? void 0 : status, ok ? void 0 : detail, Date.now());
	return {
		ok,
		detail,
		ms
	};
}
/** WorkBuddy：读凭据文件 → plain token → 真拉一次目录。 */
async function testWorkbuddyCredential(deps, ref) {
	if (ref === null || ref === "") throw new Error("没有 credential_ref");
	const parsed = parseAuthDocument(readFileSync(ref, "utf8"));
	if (parsed.kind !== "plain" || parsed.token === void 0) throw new Error(`凭据不可用（${ref}，状态 ${parsed.kind}）`);
	let models;
	try {
		models = await withFetch(deps.fetchImpl, () => fetchCatalog(parsed.region ?? "global", parsed.token));
	} catch (error) {
		throw new Error(redact(messageOf$1(error), [parsed.token]));
	}
	return `目录拉取成功（${ref}，${models.length} 个模型）`;
}
/** Qoder：env:* 从环境变量取，否则当文件路径现读；exchangePat 抛错即失败。 */
async function testQoderCredential(deps, ref) {
	if (ref === null || ref === "") throw new Error("没有 credential_ref");
	let pat;
	if (ref.startsWith("env:")) {
		const value = process.env[ref.slice(4)]?.trim();
		if (value !== void 0 && value.startsWith("pt-")) pat = value;
	} else {
		const value = readFileSync(ref, "utf8").trim();
		if (value.startsWith("pt-")) pat = value;
	}
	if (pat === void 0) throw new Error(`凭据不可用（${ref}，缺 pt- 开头的 PAT）`);
	try {
		await (deps.exchangePat ?? exchangePat)(pat, ref);
	} catch (error) {
		throw new Error(redact(messageOf$1(error), [pat]));
	}
	return `PAT 验活通过（${ref}）`;
}
/**
* Trae 单账号测试：读 token 文件 → 过期预检 → **真发一次最小对话**。
*
* 为什么不只读文件/看目录：token 存在不等于能用（过期、被顶号、区域不对
* 都会 200 + `event:error`）。真打一次上游才能把「能聊天」这件事证出来。
*
* 模型从本机目录里取前三个依次试：目录是客户端缓存，可能包含当前账号
* 不可用的项（`4023 model is unknown`），试到有一个能出事件就算通过 ——
* 这是**验活**，不是验模型。
*/
async function testTraeCredential(deps, ref) {
	if (ref === null || ref === "") throw new Error("没有 credential_ref");
	let credential;
	try {
		credential = readTraeCredentialFile(ref);
	} catch (error) {
		throw new Error(messageOf$1(error));
	}
	assertTraeTokenFresh(credential);
	const candidates = fetchTraeCatalog(credential).models.slice(0, 3).map((model) => model.id);
	if (candidates.length === 0) throw new Error("Trae 目录为空，无法验活");
	const fetchImpl = deps.fetchImpl ?? fetch;
	let lastError = "";
	for (const model of candidates) try {
		const body = buildTraeChatBody({
			messages: [{
				role: "user",
				content: "ping"
			}],
			max_tokens: 8
		}, model, TRAE_DEFAULT_FUNCTION, credential);
		const response = await fetchImpl(`${credential.gateway.replace(/\/+$/, "")}/api/agent/v3/llm_utils_chat`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				authorization: `Cloud-IDE-JWT ${credential.token}`,
				"x-ide-token": credential.token,
				"x-ide-version-code": String(credential.appVersionCode),
				"x-app-id": credential.appId,
				"user-agent": "TraeClient/TTNet"
			},
			body: JSON.stringify(body)
		});
		if (!response.ok) {
			lastError = `上游 HTTP ${response.status}`;
			continue;
		}
		const text = await response.text();
		if (/event:error/.test(text)) {
			const payload = /event:error\s*\ndata:([^\n]*)/.exec(text)?.[1] ?? "";
			let code;
			let message;
			try {
				const parsed = JSON.parse(payload);
				code = parsed["code"];
				message = parsed["message"];
			} catch {}
			lastError = explainTraeError(code, message);
			continue;
		}
		if (/event:(done|output)/.test(text)) return `Trae 验活通过（${ref}，模型 ${model}）`;
		lastError = "上游没有返回任何事件";
	} catch (error) {
		lastError = messageOf$1(error);
	}
	throw new Error(redact(lastError === "" ? "Trae 验活失败" : lastError, [credential.token]));
}
/**
* 从**本机 Trae 客户端**导入账号：解密登录态 → 落自有 token 文件 → 登记 → 起 runtime。
*
* 与启动时的自动接管同一条路径（同一个 discover + write），差别只在于这里是
* 用户主动点「添加账号」触发的，所以失败要**如实抛给面板**（启动路径只记日志）。
* 同一账号重复导入是幂等的：按 uid 派生的 id 认领已有行，只刷新名字与凭据引用。
*/
async function importTraeLocal(deps, db, state) {
	const home = deps.dshHome ?? resolveDshHome$1();
	const discovered = discoverTraeSession();
	if (discovered.session === void 0) throw new Error(discovered.error ?? "没有找到 Trae 登录态");
	const credential = discovered.session.credential;
	assertTraeTokenFresh(credential);
	const path = writeTraeTokenFile(home, credential);
	const uid = credential.userId;
	const derivedId = `${PROVIDER_TRAE$2}:${uid !== "" ? traeAccountSuffixOf(uid) : "local"}`;
	const existing = db.prepare("SELECT id, deleted FROM accounts WHERE id = ? OR credential_ref = ? LIMIT 1").get(derivedId, path);
	if (existing !== void 0 && existing.deleted === 1) throw new Error("该 Trae 账号曾被删除（软删），面板里不再恢复；换号登录后再导入");
	const accountId = existing?.id ?? derivedId;
	const channelHasLive = queryAccounts(db).some((account) => account.channel_id === PROVIDER_TRAE$2);
	const displayName = credential.name !== "" ? credential.name : `Trae · ${uid.slice(0, 8)}`;
	seedChannelsAndAccounts(db, [{
		id: PROVIDER_TRAE$2,
		kind: "trae",
		displayName: "Trae"
	}], [{
		id: accountId,
		channelId: PROVIDER_TRAE$2,
		displayName,
		credentialRef: path,
		isCurrent: !channelHasLive
	}]);
	if (state.poolSize(PROVIDER_TRAE$2) > 0) await state.ensureRuntime(PROVIDER_TRAE$2);
	return {
		accountId,
		path,
		added: existing === void 0,
		displayName
	};
}
/**
* 贴 PAT 添加账号：校验格式 → 写 `<dshHome>/model-hub/qoder-pats/<slug>.pat`
* （目录 0700 / 文件 0600）→ exchangePat 验活 → 登记渠道与账号 → ensureRuntime。
*
* **失败即删刚写的文件**（不留死 PAT）：验活或登记任何一步失败，文件都删掉再抛。
*/
async function addQoderPat(deps, db, state, pat, displayName) {
	const value = pat.trim();
	if (!PAT_PATTERN.test(value)) throw new Error(`PAT 格式不对：需要 pt- 开头、后接至少 8 位字母/数字/_/-（${PAT_GUIDE}）`);
	const home = deps.dshHome ?? resolveDshHome$1();
	const dir = join(home, HUB_DIR_NAME, "qoder-pats");
	const slug = pickSlug(db, dir, value, displayName);
	const path = join(dir, `${slug}.pat`);
	mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	writeFileSync(path, value, {
		encoding: "utf8",
		mode: 384
	});
	try {
		const session = await (deps.exchangePat ?? exchangePat)(value, path);
		const accountId = `${PROVIDER_QODER$2}:${slug}`;
		const isFirst = !queryAccounts(db).some((a) => a.channel_id === PROVIDER_QODER$2);
		seedChannelsAndAccounts(db, [{
			id: PROVIDER_QODER$2,
			kind: "qoder",
			displayName: "Qoder CN"
		}], [{
			id: accountId,
			channelId: PROVIDER_QODER$2,
			displayName: displayName?.trim() ? displayName.trim() : session.name || session.email || slug,
			credentialRef: path,
			isCurrent: isFirst
		}]);
		await state.ensureRuntime(PROVIDER_QODER$2);
		return {
			accountId,
			path
		};
	} catch (error) {
		try {
			rmSync(path, { force: true });
		} catch {}
		throw new Error(redact(messageOf$1(error), [value]));
	}
}
// src/routes/write.ts
/** 账号 id 派生：与 prober.ts / index.ts 同源不同处（不为取常量改别人模块）。 */
const PROVIDER_GLOBAL$1 = `${PROVIDER_PREFIX}workbuddy-global`;
const PROVIDER_QODER$1 = `${PROVIDER_PREFIX}qoder-cn`;
const PROVIDER_TRAE$1 = `${PROVIDER_PREFIX}trae`;
/** 写 body 上限（约束 7）。超限立即 413 并 destroy，绝不能把内存读爆。 */
const WRITE_BODY_LIMIT = 65536;
/** 与 data.ts 的 LOOPBACK 判定一致（那边未导出且本任务不改它，此处镜像）。 */
const LOOPBACK = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"[::1]"
]);
function hostIsLoopback(host) {
	if (host === void 0) return false;
	const name = host.replace(/:\d+$/, "").toLowerCase();
	if (LOOPBACK.has(name)) return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}
/**
* 写门禁：Host 回环 → Origin 规则（缺失放行；http(s) 必须回环；非 http(s)
* 自定义协议放行；"null"/垃圾串拒）→ content-type 含 application/json
* （+ method 提供时必须是 POST）。返回 `{ok:false}` 时 status/json 由调用方
* 原样回给客户端；错误 json 统一 `{error}` 形状（与 data.ts 的只读门禁一致）。
*/
function writeGate(req) {
	const headers = req.headers ?? {};
	if (!hostIsLoopback(typeof headers["host"] === "string" ? headers["host"] : void 0)) return {
		ok: false,
		status: 403,
		json: { error: "host_not_allowed" }
	};
	const origin = headers["origin"];
	if (origin !== void 0 && origin !== "") {
		if (typeof origin !== "string") return {
			ok: false,
			status: 403,
			json: { error: "origin_not_allowed" }
		};
		if (origin === "null") return {
			ok: false,
			status: 403,
			json: {
				error: "origin_not_allowed",
				origin
			}
		};
		let parsed;
		try {
			parsed = new URL(origin);
		} catch {
			parsed = void 0;
		}
		if (parsed !== void 0 && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
			if (!hostIsLoopback(parsed.host)) return {
				ok: false,
				status: 403,
				json: {
					error: "origin_not_allowed",
					origin
				}
			};
		} else if (parsed === void 0) return {
			ok: false,
			status: 403,
			json: {
				error: "origin_not_allowed",
				origin
			}
		};
	}
	const contentType = headers["content-type"];
	if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) return {
		ok: false,
		status: 415,
		json: { error: "unsupported_media_type" }
	};
	if (req.method !== void 0 && String(req.method).toUpperCase() !== "POST") return {
		ok: false,
		status: 405,
		json: { error: "method_not_allowed" }
	};
	return { ok: true };
}
const OK = {
	status: 200,
	json: { ok: true }
};
const BAD_REQUEST = {
	status: 400,
	json: {
		ok: false,
		error: "bad_request"
	}
};
const NOT_FOUND = {
	status: 404,
	json: {
		ok: false,
		error: "not_found"
	}
};
const ACCOUNT_NOT_FOUND = {
	status: 404,
	json: {
		ok: false,
		error: "account_not_found"
	}
};
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** 路径切段并逐段解码：客户端对 id 做了 encodeURIComponent（`:` → `%3A`）。 */
function segmentsOf(path) {
	return path.replace(/^\/+/, "").split("/").filter((segment) => segment !== "").map((segment) => {
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	});
}
/** 未删账号的渠道 id；不存在（含软删）返回 undefined。queryAccounts 已滤 deleted。 */
function liveChannelOf(db, accountId) {
	return queryAccounts(db).find((row) => row.id === accountId)?.channel_id;
}
/**
* 写操作分发。path 形如 "/channel/<id>/toggle"、"account/<id>/test"、
* "accounts/add"、"auth/one-click"、"records/prune"、"records/clear"
* （首导线可有可无，段会解码）。错误响应统一 `{ok:false,error}` 形状；
* 操作自身的意外异常折成 500，绝不冒给宿主 webServer。
*/
async function dispatchWrite(deps, path, body) {
	try {
		return await route(deps, segmentsOf(path), body);
	} catch (error) {
		return {
			status: 500,
			json: {
				ok: false,
				error: messageOf(error)
			}
		};
	}
}
async function route(deps, segments, body) {
	const head = segments[0];
	const second = segments[1];
	const third = segments[2];
	if (head === "channel" && second !== void 0 && third === "toggle" && segments.length === 3) {
		if (typeof body.enabled !== "boolean") return BAD_REQUEST;
		await deps.state.setChannelEnabled(second, body.enabled);
		return OK;
	}
	if (head === "account" && second !== void 0 && segments.length === 3) return accountOp(deps, second, third, body);
	if (head === "accounts" && second === "add" && segments.length === 2) return addAccounts(deps, body);
	if (head === "auth" && second === "one-click" && segments.length === 2) return {
		status: 200,
		json: await oneClickAuth(deps.proberDeps, deps.db, deps.state)
	};
	if (head === "records" && segments.length === 2) {
		if (second === "prune") return pruneRecords(deps, body);
		if (second === "clear") {
			clearRecords(deps.db);
			return OK;
		}
	}
	return NOT_FOUND;
}
async function accountOp(deps, accountId, op, body) {
	if (op === "test") return {
		status: 200,
		json: await testAccount(deps.proberDeps, deps.db, deps.state, accountId)
	};
	if (op === "toggle") {
		if (typeof body.enabled !== "boolean") return BAD_REQUEST;
		if (liveChannelOf(deps.db, accountId) === void 0) return ACCOUNT_NOT_FOUND;
		await deps.state.setAccountEnabled(accountId, body.enabled);
		return OK;
	}
	if (op === "make-current") {
		const channelId = liveChannelOf(deps.db, accountId);
		if (channelId === void 0) return ACCOUNT_NOT_FOUND;
		await deps.state.makeCurrent(channelId, accountId);
		return OK;
	}
	if (op === "delete") {
		if (liveChannelOf(deps.db, accountId) === void 0) return ACCOUNT_NOT_FOUND;
		await deps.state.deleteAccount(accountId);
		return OK;
	}
	return NOT_FOUND;
}
/**
* accounts/add：WorkBuddy {channelId} 走 vault 幂等导入（裁定 2：在 write.ts
* 内实现，不新增 prober 导出）；Qoder {channelId,pat,displayName?} 走 addQoderPat。
* 成功统一返回 {ok:true, added}，失败 400 带文案（addQoderPat 的文案已过 redact）。
*/
async function addAccounts(deps, body) {
	const channelId = typeof body.channelId === "string" ? body.channelId : "";
	if (channelId === PROVIDER_GLOBAL$1) {
		const entries = listVaultEntries();
		const channelHasLive = queryAccounts(deps.db).some((row) => row.channel_id === PROVIDER_GLOBAL$1);
		const taken = new Set(deps.db.prepare("SELECT id FROM accounts").all().map((row) => row.id));
		const fresh = [];
		for (const entry of entries) {
			const id = `${PROVIDER_GLOBAL$1}:${entry.accountId}`;
			if (taken.has(id)) continue;
			fresh.push({
				id,
				channelId: PROVIDER_GLOBAL$1,
				displayName: entry.accountId,
				credentialRef: entry.source,
				isCurrent: fresh.length === 0 && !channelHasLive
			});
		}
		if (fresh.length > 0) seedChannelsAndAccounts(deps.db, [{
			id: PROVIDER_GLOBAL$1,
			kind: "workbuddy",
			displayName: "WorkBuddy Global"
		}], fresh);
		if (deps.state.poolSize(PROVIDER_GLOBAL$1) > 0) await deps.state.ensureRuntime(PROVIDER_GLOBAL$1);
		return {
			status: 200,
			json: {
				ok: true,
				added: fresh.map((account) => account.id)
			}
		};
	}
	if (channelId === PROVIDER_QODER$1) {
		const pat = body.pat;
		if (typeof pat !== "string") return BAD_REQUEST;
		const displayName = typeof body.displayName === "string" ? body.displayName : void 0;
		try {
			const { accountId } = await addQoderPat(deps.proberDeps, deps.db, deps.state, pat, displayName);
			return {
				status: 200,
				json: {
					ok: true,
					added: [accountId]
				}
			};
		} catch (error) {
			return {
				status: 400,
				json: {
					ok: false,
					error: messageOf(error)
				}
			};
		}
	}
	if (channelId === PROVIDER_TRAE$1) try {
		const result = await importTraeLocal(deps.proberDeps, deps.db, deps.state);
		return {
			status: 200,
			json: {
				ok: true,
				added: [result.accountId],
				detail: `${result.displayName}（${result.path}）`
			}
		};
	} catch (error) {
		return {
			status: 400,
			json: {
				ok: false,
				error: messageOf(error)
			}
		};
	}
	return {
		status: 400,
		json: {
			ok: false,
			error: "unknown_channel"
		}
	};
}
function pruneRecords(deps, body) {
	const rawDays = body.days;
	const days = rawDays === void 0 ? deps.retentionDays?.() ?? 90 : rawDays;
	if (typeof days !== "number" || !Number.isFinite(days)) return BAD_REQUEST;
	return {
		status: 200,
		json: { removed: pruneRequests(deps.db, days) }
	};
}
function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
/**
* 收 body：累计超 64KB 立即 413 并 destroy（简报具体化）。返回 null 表示
* 已经答过（413 / 连接错误），调用方直接收工。
*/
function collectBody(req, res) {
	return new Promise((resolve) => {
		let size = 0;
		let done = false;
		const chunks = [];
		const finish = (value) => {
			if (!done) {
				done = true;
				resolve(value);
			}
		};
		req.on("data", (chunk) => {
			if (done) return;
			size += chunk.length;
			if (size > WRITE_BODY_LIMIT) {
				json(res, 413, {
					ok: false,
					error: "payload_too_large"
				});
				req.destroy();
				finish(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => finish(null));
	});
}
async function handleWrite(req, res, deps, logger) {
	try {
		const verdict = writeGate(req);
		if (!verdict.ok) {
			if (verdict.status === 403 && verdict.json?.error === "origin_not_allowed") logger?.warn?.(`dsh-model-hub: 写请求被 Origin 门禁拒绝（origin=${verdict.json.origin ?? "(缺失)"}）`);
			json(res, verdict.status, verdict.json);
			return;
		}
		const raw = await collectBody(req, res);
		if (raw === null) return;
		let body;
		if (raw.trim() === "") body = {};
		else {
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				json(res, 400, {
					ok: false,
					error: "invalid_json"
				});
				return;
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				json(res, 400, {
					ok: false,
					error: "invalid_json"
				});
				return;
			}
			body = parsed;
		}
		const out = await dispatchWrite(deps, pathAfterPrefix(req.url), body);
		json(res, out.status, out.json);
	} catch (error) {
		logger?.error?.("dsh-model-hub: 写路由处理失败", error);
		if (!res.headersSent) json(res, 500, {
			ok: false,
			error: messageOf(error)
		});
	}
}
/** 剥掉路由前缀与 query，剩下的交给分发器（"/account/x%3Ay/toggle" 形态）。 */
function pathAfterPrefix(url) {
	const withoutQuery = (url ?? "/").split("?")[0] ?? "/";
	return withoutQuery.startsWith(`/plugins/dsh-model-hub/`) ? withoutQuery.slice(22) : withoutQuery;
}
/**
* 注册写路由（整体 try/catch：注册失败只记 error，面板写操作不可用，
* provider 与宿主不受影响 —— 本项目最痛的教训）。
*/
function registerWriteRoutes(ctx, deps) {
	ctx.inject(["webServer"], (inner) => {
		try {
			const dispose = inner.webServer.register({
				kind: "prefix",
				path: DATA_PREFIX,
				handler: (req, res) => {
					handleWrite(req, res, deps, inner.logger);
				}
			});
			inner.effect(() => dispose, "dsh-model-hub: write routes");
		} catch (error) {
			inner.logger?.error?.("dsh-model-hub: 写路由注册失败（面板写操作不可用，provider 不受影响）", error);
		}
	});
}
// src/index.ts
const name = "dsh-model-hub";
const inject = ["llm"];
/**
* 面板诊断栏显示的版本号。
*
* 与 `package.json` 的 `version` 必须一致 —— 单测 `tests/diag.spec.ts` 守着这条，
* 因为它是最容易忘记同步的一处（发布时改了 package.json 忘了改这里，
* 用户报障时看到的版本就是错的）。
*/
const PLUGIN_VERSION = "0.2.0";
/** 数据库文件字节数；文件还不存在（首次启动）时返回 null，不返回 0。 */
function fileSizeOrNull(path) {
	try {
		return statSync(path).size;
	} catch {
		return null;
	}
}
const PROVIDER_GLOBAL = `${PROVIDER_PREFIX}workbuddy-global`;
/** Qoder CN 渠道的 provider id。 */
const PROVIDER_QODER = `${PROVIDER_PREFIX}qoder-cn`;
/** Trae 渠道的 provider id。 */
const PROVIDER_TRAE = `${PROVIDER_PREFIX}trae`;
/** 保留清理周期（24h）；每次触发现读最新的 `settings.retentionDays`。 */
const RETENTION_INTERVAL_MS = 864e5;
function apply(ctx, config) {
	try {
		applyInner(ctx, config);
	} catch (error) {
		try {
			ctx.logger?.error?.("dsh-model-hub: 插件初始化失败（不影响宿主与其它插件）", error);
		} catch {}
	}
}
/**
* 装配层：本文件只负责「把零件按顺序拧起来」，不再有业务逻辑 ——
* 渠道 runtime 在 `state/runtime.ts`，状态机在 `state/hub-state.ts`，
* 读写路由在 `routes/`，探测在 `probe/prober.ts`。
*/
function applyInner(ctx, config) {
	const settings = readSetting(config) ?? {};
	if (readSetting(settings.enabled) === false) return;
	const dbPath = join(resolveDshHome(), HUB_DIR_NAME, HUB_DB_NAME);
	(async () => {
		let db;
		try {
			db = await openHubDatabase(dbPath);
		} catch (error) {
			ctx.logger?.error?.("dsh-model-hub: 数据库打开失败，记录功能关闭（provider 不受影响）", error);
			return;
		}
		try {
			const report = dedupeAccountsByCredential(db, PROVIDER_GLOBAL);
			if (report.removed.length > 0) ctx.logger?.info?.(`dsh-model-hub: 合并重复账号 ${report.removed.length} 行（保留 ${report.kept.join("、")}）`);
		} catch (error) {
			ctx.logger?.warn?.("dsh-model-hub: 重复账号收敛失败（面板可能仍显示重复行）", error);
		}
		let workbuddyShimUrl;
		const state = createHubState({
			db,
			settings: () => ({
				recordEnabled: readSetting(settings.recordEnabled) !== false,
				retentionDays: readSetting(settings.retentionDays)
			}),
			logger: ctx.logger,
			runtimeFactory: async (input) => {
				const handle = await startChannelRuntime({
					...input,
					ctx,
					...input.channelId === PROVIDER_GLOBAL ? { onRegisterReport: (outcome) => writeStatus(ctx, outcome) } : {}
				});
				if (input.channelId === PROVIDER_GLOBAL) workbuddyShimUrl = handle.shim.baseUrl();
				return handle;
			}
		});
		const fromFile = detectCredential();
		const plainFromFile = fromFile !== void 0 && fromFile.parsed.kind === "plain" && fromFile.parsed.token !== void 0 ? {
			source: fromFile.path,
			parsed: fromFile.parsed
		} : void 0;
		let decryptedFromFile;
		if (plainFromFile === void 0 && fromFile !== void 0 && fromFile.parsed.kind === "encrypted") try {
			const decrypted = await realDecryptAuthFile(fromFile.path);
			const tokenPath = writeWorkbuddyTokenFile(resolveDshHome(), {
				accountUid: decrypted.accountUid ?? "unknown-workbuddy-account",
				accessToken: decrypted.accessToken,
				...decrypted.refreshToken === void 0 ? {} : { refreshToken: decrypted.refreshToken },
				...decrypted.nickname === void 0 ? {} : { nickname: decrypted.nickname },
				region: decrypted.region,
				...decrypted.expiresAtMs === void 0 ? {} : { expiresAtMs: decrypted.expiresAtMs }
			});
			decryptedFromFile = {
				source: tokenPath,
				parsed: {
					kind: "plain",
					region: decrypted.region,
					token: decrypted.accessToken,
					...decrypted.refreshToken === void 0 ? {} : { refreshToken: decrypted.refreshToken },
					...decrypted.expiresAtMs === void 0 ? {} : { expiresAtMs: decrypted.expiresAtMs }
				}
			};
			ctx.logger?.info?.(`dsh-model-hub: 桌面端加密凭据已用内置解密接管（${fromFile.path}）→ ${tokenPath}`);
		} catch (error) {
			ctx.logger?.warn?.("dsh-model-hub: 桌面端加密凭据内置解密失败，回落到 vault", error);
		}
		const fromVault = plainFromFile === void 0 && decryptedFromFile === void 0 ? readWorkbuddyVault() : void 0;
		const credential = plainFromFile ?? decryptedFromFile ?? fromVault;
		if (credential === void 0) {
			const why = fromFile === void 0 ? "没有找到任何 WorkBuddy 登录文件" : fromFile.parsed.kind === "encrypted" ? `桌面端凭据是加密信封（${fromFile.path}），且没有可复用的 vault` : `凭据不可用（${fromFile.path}，状态 ${fromFile.parsed.kind}）`;
			ctx.logger?.warn?.(`dsh-model-hub: 未找到可用的 WorkBuddy token —— ${why}。请先装 WorkBuddy 桌面端登录一次，或装 dsh-connect-workbuddy 让它解一次。渠道不注册。`);
		} else ctx.logger?.info?.(`dsh-model-hub: 凭据来源 = ${credential.source}（${credential.parsed.region ?? "global"}）`);
		const dshHome = resolveDshHome();
		const tokenEntries = listTokenStoreEntries(dshHome);
		const wbSeeds = [];
		const seedCandidates = tokenEntries.map((entry) => ({
			source: entry.source,
			identity: entry.identity
		}));
		if (credential !== void 0 && !seedCandidates.some((c) => c.source === credential.source)) {
			const identity = identityOfTokenFile(credential.source) ?? { region: credential.parsed.region ?? "global" };
			seedCandidates.push({
				source: credential.source,
				identity
			});
		}
		const seenUids = /* @__PURE__ */ new Set();
		for (const candidate of seedCandidates) {
			const uid = candidate.identity.uid;
			if (uid !== void 0) {
				if (seenUids.has(uid)) continue;
				seenUids.add(uid);
			}
			const id = resolveAccountId(db, PROVIDER_GLOBAL, uid, candidate.source) ?? (uid !== void 0 ? `${PROVIDER_GLOBAL}:${accountIdSuffixOf(uid)}` : `${PROVIDER_GLOBAL}:${createHash("sha256").update(candidate.source, "utf8").digest("hex").slice(0, 12)}`);
			wbSeeds.push({
				id,
				channelId: PROVIDER_GLOBAL,
				displayName: candidate.identity.nickname ?? (uid !== void 0 ? `WB · ${uid.slice(0, 8)}` : "WorkBuddy 账号"),
				credentialRef: candidate.source,
				isCurrent: false
			});
		}
		if (wbSeeds.length > 0) try {
			seedChannelsAndAccounts(db, [{
				id: PROVIDER_GLOBAL,
				kind: "workbuddy",
				displayName: "WorkBuddy Global"
			}], wbSeeds);
			ctx.logger?.info?.(`dsh-model-hub: 登记 ${wbSeeds.length} 个 WorkBuddy 账号（按 uid 去重）`);
		} catch (error) {
			ctx.logger?.warn?.("dsh-model-hub: 渠道/账号登记失败（面板可能显示为空，provider 不受影响）", error);
		}
		if (credential !== void 0) {
			if (!queryAccounts(db).some((a) => a.channel_id === PROVIDER_GLOBAL && a.is_current === 1)) {
				const uid = identityOfTokenFile(credential.source)?.uid;
				const fallbackId = resolveAccountId(db, PROVIDER_GLOBAL, uid, credential.source);
				if (fallbackId !== void 0) try {
					makeCurrent(db, PROVIDER_GLOBAL, fallbackId);
				} catch (error) {
					ctx.logger?.warn?.("dsh-model-hub: 设置当前账号失败（不影响 provider）", error);
				}
			}
			try {
				const tokenByUid = /* @__PURE__ */ new Map();
				for (const entry of tokenEntries) if (entry.identity.uid !== void 0) tokenByUid.set(entry.identity.uid, entry.source);
				const rows = db.prepare("SELECT id, display_name, credential_ref FROM accounts WHERE channel_id = ? AND deleted = 0").all(PROVIDER_GLOBAL);
				for (const account of rows) {
					if (account.credential_ref === null || account.credential_ref === "") continue;
					const uid = identityOfTokenFile(account.credential_ref)?.uid;
					if (uid === void 0) continue;
					const preferred = tokenByUid.get(uid);
					if (preferred === void 0 || preferred === account.credential_ref) continue;
					db.prepare("UPDATE accounts SET credential_ref = ? WHERE id = ?").run(preferred, account.id);
					ctx.logger?.info?.(`dsh-model-hub: 账号 ${account.display_name} 的凭据引用改指自有 token 文件`);
				}
			} catch (error) {
				ctx.logger?.warn?.("dsh-model-hub: 凭据引用收敛失败（不影响已有凭据的读取）", error);
			}
			if (state.poolSize(PROVIDER_GLOBAL) > 0) {
				await state.ensureRuntime(PROVIDER_GLOBAL);
				if (workbuddyShimUrl === void 0) await writeStatus(ctx, {
					ok: false,
					provider: PROVIDER_GLOBAL,
					modelCount: 0,
					modelIds: [],
					catalogCount: 0,
					error: "WorkBuddy runtime 启动失败（目录拉取或凭据现读失败，详见插件日志）"
				});
			} else ctx.logger?.warn?.("dsh-model-hub: WorkBuddy 渠道没有可用账号（已被删除或停用），跳过 runtime —— 面板可重新添加");
		}
		try {
			const qoderSession = await createSessionManager().current();
			if (qoderSession === void 0) {
				if (state.poolSize(PROVIDER_QODER) > 0) await state.ensureRuntime(PROVIDER_QODER);
				else ctx.logger?.warn?.("dsh-model-hub: 未找到 Qoder PAT（~/.dsh/qoder/pat 或 QODERCN_PAT），Qoder 渠道不注册");
			} else {
				ctx.logger?.info?.(`dsh-model-hub: Qoder 凭据 ${qoderSession.source}（uid ${qoderSession.userID.slice(0, 8)}…）`);
				seedChannelsAndAccounts(db, [{
					id: PROVIDER_QODER,
					kind: "qoder",
					displayName: "Qoder CN"
				}], [{
					id: `${PROVIDER_QODER}:default`,
					channelId: PROVIDER_QODER,
					displayName: qoderSession.name || qoderSession.email || "Qoder CN 账号",
					credentialRef: qoderSession.source,
					isCurrent: true
				}]);
				await state.ensureRuntime(PROVIDER_QODER);
			}
		} catch (error) {
			ctx.logger?.warn?.("dsh-model-hub: Qoder 渠道初始化失败（WorkBuddy 不受影响）", error);
		}
		try {
			const discovered = discoverTraeSession();
			let credential;
			let tokenPath;
			if (discovered.session !== void 0) {
				tokenPath = writeTraeTokenFile(dshHome, discovered.session.credential);
				credential = {
					...discovered.session.credential,
					source: tokenPath
				};
				ctx.logger?.info?.(`dsh-model-hub: Trae 登录态来自本机客户端（${discovered.session.storagePath}）→ ${tokenPath}`);
			} else {
				const snapshot = traeConnectAuthPath(dshHome);
				if (existsSync(snapshot)) try {
					const parsed = readTraeCredentialFile(snapshot);
					tokenPath = writeTraeTokenFile(dshHome, parsed);
					credential = {
						...parsed,
						source: tokenPath
					};
					ctx.logger?.info?.(`dsh-model-hub: Trae 凭据来自 connect-auth 快照（${snapshot}）→ ${tokenPath}`);
				} catch (error) {
					ctx.logger?.warn?.(`dsh-model-hub: Trae 快照不可用（${snapshot}）`, error);
				}
			}
			if (credential === void 0 || tokenPath === void 0) {
				if (state.poolSize(PROVIDER_TRAE) > 0) await state.ensureRuntime(PROVIDER_TRAE);
				else ctx.logger?.warn?.(`dsh-model-hub: ${discovered.error ?? "没有 Trae 登录态"}；Trae 渠道不注册`);
			} else {
				const uid = credential.userId;
				const suffix = uid !== "" ? traeAccountSuffixOf(uid) : createHash("sha256").update(tokenPath, "utf8").digest("hex").slice(0, 12);
				const derivedId = `${PROVIDER_TRAE}:${suffix}`;
				const accountId = db.prepare("SELECT id FROM accounts WHERE deleted = 0 AND (credential_ref = ? OR id = ?) LIMIT 1").get(tokenPath, derivedId)?.id ?? derivedId;
				const channelHasLive = queryAccounts(db).some((account) => account.channel_id === PROVIDER_TRAE);
				seedChannelsAndAccounts(db, [{
					id: PROVIDER_TRAE,
					kind: "trae",
					displayName: "Trae"
				}], [{
					id: accountId,
					channelId: PROVIDER_TRAE,
					displayName: credential.name !== "" ? credential.name : `Trae · ${uid.slice(0, 8)}`,
					credentialRef: tokenPath,
					isCurrent: !channelHasLive
				}]);
				await state.ensureRuntime(PROVIDER_TRAE);
			}
		} catch (error) {
			ctx.logger?.warn?.("dsh-model-hub: Trae 渠道初始化失败（WorkBuddy / Qoder 不受影响）", error);
		}
		try {
			const removed = pruneRequests(db, readSetting(settings.retentionDays) ?? 90);
			if (removed > 0) ctx.logger?.info?.(`dsh-model-hub: 启动清理删除 ${removed} 条过期明细（保留 ${readSetting(settings.retentionDays) ?? 90} 天）`);
		} catch (error) {
			ctx.logger?.warn?.("dsh-model-hub: 启动保留清理失败（不影响插件）", error);
		}
		const retentionTimer = setInterval(() => {
			try {
				const removed = pruneRequests(db, readSetting(settings.retentionDays) ?? 90);
				if (removed > 0) ctx.logger?.info?.(`dsh-model-hub: 定时清理删除 ${removed} 条过期明细（保留 ${readSetting(settings.retentionDays) ?? 90} 天）`);
			} catch (error) {
				ctx.logger?.warn?.("dsh-model-hub: 定时保留清理失败（下个周期重试）", error);
			}
		}, RETENTION_INTERVAL_MS);
		retentionTimer.unref();
		ctx.effect(() => () => {
			clearInterval(retentionTimer);
			return state.dispose();
		}, "dsh-model-hub: teardown");
		registerDataRoutes(ctx, {
			db,
			catalog: () => Object.values(state.panelModelsByChannel()).flat(),
			modelsByChannel: () => state.panelModelsByChannel(),
			settings: () => ({
				recordEnabled: readSetting(settings.recordEnabled),
				retentionDays: readSetting(settings.retentionDays)
			}),
			diag: () => ({
				pluginVersion: PLUGIN_VERSION,
				dbPath,
				dbSizeBytes: fileSizeOrNull(dbPath),
				...credential === void 0 ? {} : {
					credentialPath: credential.source,
					tokenExpiresAt: credential.parsed.expiresAtMs ?? null,
					region: credential.parsed.region ?? null
				},
				...workbuddyShimUrl === void 0 ? {} : { shimUrl: workbuddyShimUrl },
				modelCount: Object.values(state.panelModelsByChannel()).reduce((n, entries) => n + entries.length, 0)
			})
		});
		registerWriteRoutes(ctx, {
			state,
			db,
			proberDeps: { decryptAuthFile: realDecryptAuthFile },
			retentionDays: () => readSetting(settings.retentionDays) ?? 90
		});
		ctx.logger?.info?.(`dsh-model-hub: 装配完成 —— runtime 渠道 [${Object.keys(state.panelModelsByChannel()).join("、") || "无"}]` + (workbuddyShimUrl === void 0 ? "" : `，workbuddy shim=${workbuddyShimUrl}`));
	})().catch((caught) => {
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
async function writeStatus(ctx, status) {
	try {
		const dir = join(resolveDshHome(), HUB_DIR_NAME);
		await mkdir(dir, {
			recursive: true,
			mode: 448
		});
		await writeFile(join(dir, "status.json"), JSON.stringify({
			...status,
			at: (/* @__PURE__ */ new Date()).toISOString(),
			pid: process.pid
		}, null, 2), {
			encoding: "utf8",
			mode: 384
		});
	} catch (error) {
		ctx.logger?.warn?.("dsh-model-hub: 状态文件写入失败（不影响插件）", error);
	}
}
export { Config, PLUGIN_VERSION, apply, inject, name };
