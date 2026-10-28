import { describe, expect, it } from "vitest";
import { poolOf, pickOf, onResultCompute, CIRCUIT_THRESHOLD } from "../src/state/selector.js";

const NOW = 1_000_000;
function acc(over: Partial<any> = {}) {
  return { id: "a", channel_id: "c", enabled: 1, deleted: 0, is_current: 0,
    last_ok_at: null, consecutive_failures: 0, cooldown_until: null,
    has_credential: 1, created_at: 1, ...over };
}

it("池：只收 deleted=0/enabled=1/有凭据；序=当前>last_ok_at 新>创建早", () => {
  const rows = [acc({ id: "b", created_at: 2 }), acc({ id: "a", created_at: 1 }),
    acc({ id: "off", enabled: 0 }), acc({ id: "del", deleted: 1 }), acc({ id: "nocred", has_credential: 0 })];
  expect(poolOf(rows as any, "c", NOW).map((r: any) => r.id)).toEqual(["a", "b"]);
  const withCurrent = [acc({ id: "z", last_ok_at: 999 }), acc({ id: "cur", is_current: 1, last_ok_at: 5 })];
  expect(poolOf(withCurrent as any, "c", NOW).map((r: any) => r.id)).toEqual(["cur", "z"]);
});

it("pick：跳过冷却中的；全冷却时兜底返回池头", () => {
  const rows = [acc({ id: "hot", cooldown_until: NOW + 1 }), acc({ id: "ok" })];
  expect(pickOf(rows as any, "c", NOW)?.id).toBe("ok");
  const allCool = [acc({ id: "x", cooldown_until: NOW + 1 }), acc({ id: "y", cooldown_until: NOW + 2 })];
  expect(pickOf(allCool as any, "c", NOW)?.id).toBe("x");
});

it("onResultCompute：3 次凭据失败进冷却；成功解冻清零；5xx 不累计", () => {
  let s = { consecutive_failures: 0, cooldown_until: null as number | null };
  for (let i = 0; i < CIRCUIT_THRESHOLD; i++) s = onResultCompute(s, false, 401, NOW);
  expect(s.cooldown_until).toBe(NOW + 10 * 60_000);
  s = onResultCompute(s, true, 200, NOW);
  expect(s).toEqual({ consecutive_failures: 0, cooldown_until: null });
  const s2 = onResultCompute({ consecutive_failures: 2, cooldown_until: null }, false, 502, NOW);
  expect(s2.consecutive_failures).toBe(2);       // 5xx 不计
});
