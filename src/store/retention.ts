import type { DatabaseSync } from "node:sqlite";

/**
 * 按天界删过期明细，返回实际删除行数。
 *
 * days 下界保护：days 传 0 / 负数 / 小数时按「至少 1 天」回退——
 * cutoff 永远严格早于 now，刚写入的当天明细不会被误删（DELETE 用 `<` 严格小于）。
 * 只删 requests 不动 daily_rollups：聚合是趋势曲线，清了它历史图表会跳变；
 * 明细与聚合本来就允许口径不一致（保留期不同），不在这里做对账。
 */
export function pruneRequests(db: DatabaseSync, days: number, now = Date.now()): number {
  const cutoff = now - Math.max(1, Math.floor(days)) * 86_400_000;
  // node:sqlite 的 changes 类型是 number | bigint，行数取值范围内 Number() 转换无损
  return Number(db.prepare("DELETE FROM requests WHERE created_at < ?").run(cutoff).changes);
}

/**
 * 清空请求记录：明细与聚合两表一起清。
 *
 * 包在同一个事务里——两张表要么都空要么都原样，删一半会让
 * 「明细 COUNT=0 但聚合还有数」这种对不上账的中间态留在库里。
 */
export function clearRecords(db: DatabaseSync): void {
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
