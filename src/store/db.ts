import { mkdir, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_APP_ID, HUB_SCHEMA_VERSION } from "../constants.js";

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
export async function openHubDatabase(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await (await open(path, "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    const { application_id: applicationId } = db.prepare("PRAGMA application_id").get() as { application_id: number };
    if (applicationId !== 0 && applicationId !== HUB_APP_ID) {
      throw new Error(`the database at "${path}" belongs to another application (application_id=${applicationId})`);
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version < 1) db.exec(SCHEMA_V1);
    if (version !== HUB_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${HUB_SCHEMA_VERSION}`);
    if (version === 0) db.exec(`PRAGMA application_id = ${HUB_APP_ID}`);

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
