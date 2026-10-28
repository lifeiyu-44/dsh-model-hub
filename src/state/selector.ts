/**
 * 选号纯逻辑：不碰 IO，输入是 accounts 表的行快照。
 *
 * 与 `store/mutations.ts` 是"镜像"关系——那边持有同一组常量与凭据失败判定，
 * 这边保持纯函数可独立单测，两边数值一致由 `tests/selector.spec.ts` 锁住。
 * （selector 不 import store 层，避免把 node:sqlite 拖进 UI/纯逻辑路径。）
 */

export interface SelectorRow {
  id: string; channel_id: string; enabled: number; deleted: number;
  is_current: number; last_ok_at: number | null; consecutive_failures: number;
  cooldown_until: number | null; has_credential: number; created_at: number;
}
export interface CircuitState { consecutive_failures: number; cooldown_until: number | null }
export const CIRCUIT_THRESHOLD = 3;
export const COOLDOWN_MS = 10 * 60_000;

/** 手动优先（is_current）> 最近成功（last_ok_at 新在前）> 创建早者优先。 */
export function poolOf(rows: SelectorRow[], channelId: string, _now: number): SelectorRow[] {
  return rows
    .filter((r) => r.channel_id === channelId && r.deleted === 0 && r.enabled === 1 && r.has_credential === 1)
    .sort((x, y) =>
      (y.is_current - x.is_current)
      || ((y.last_ok_at ?? 0) - (x.last_ok_at ?? 0))
      || (x.created_at - y.created_at));
}
/** 跳过冷却中的账号；全冷却时兜底返回池头（宁可撞冷却也不无号可用）。 */
export function pickOf(rows: SelectorRow[], channelId: string, now: number): SelectorRow | undefined {
  const pool = poolOf(rows, channelId, now);
  return pool.find((r) => r.cooldown_until === null || r.cooldown_until <= now) ?? pool[0];
}
/** 熔断计算：凭据类失败（401/402/403/429）累计，达阈值进冷却；成功解冻清零；其余不累计。 */
export function onResultCompute(state: CircuitState, ok: boolean, status: number | undefined, now: number): CircuitState {
  if (ok) return { consecutive_failures: 0, cooldown_until: null };
  const credential = status === 401 || status === 402 || status === 403 || status === 429;
  if (!credential) return state;
  const fails = state.consecutive_failures + 1;
  return { consecutive_failures: fails, cooldown_until: fails >= CIRCUIT_THRESHOLD ? now + COOLDOWN_MS : null };
}
