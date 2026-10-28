/** 本插件的数据库文件放在 $DSH_HOME 下的这个子目录。 */
export const HUB_DIR_NAME = "model-hub";
/** 主库文件名。 */
export const HUB_DB_NAME = "hub.db";
/**
 * SQLite `application_id`，用来认领这个库。
 *
 * 0x48554231 = "HUB1"。打开时若 application_id 既不是 0（全新文件）也不是本值，
 * 说明这个路径上放的是别人的库 —— 拒绝打开，而不是往上写。
 */
export const HUB_APP_ID = 0x48554231;
/**
 * 当前 schema 版本，写在 PRAGMA user_version。
 *
 * v2（2026-10-28）：accounts 补 `deleted`（软删）与 `cooldown_until`（熔断冷却）。
 * 老库由 db.ts 的迁移补列，schema.sql 保持 v1 DDL 不动 —— 它同时是迁移测试的 v1 夹具。
 */
export const HUB_SCHEMA_VERSION = 2;
/** provider id 前缀，与 dsh-connect-workbuddy 的 workbuddy/workbuddy-global 区分。 */
export const PROVIDER_PREFIX = "hub-";
