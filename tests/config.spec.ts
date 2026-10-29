import { expect, it } from "vitest";
import { readSetting } from "../src/config.js";

/** 与宿主共享库同一个 well-known symbol（cosmokit volatile 协议的写句柄）。 */
const WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * 造一个宿主交付形态的 volatile 引用：`{ get, [write] }`。
 * 宿主每次改设置只调 [write] 换 get 里的快照，引用对象本身从头到尾不变 ——
 * set() 模拟的就是「宿主改设置」这个动作。
 */
function volatileRef<T>(initial: T): { ref: Record<PropertyKey, unknown>; set: (next: T) => void } {
  let snapshot = initial;
  const ref: Record<PropertyKey, unknown> = {
    get: () => snapshot,
    [WRITE]: () => {},
  };
  return { ref, set: (next: T) => void (snapshot = next) };
}

it("引用形状返回 get() 的当前值，而不是引用对象本身", () => {
  const { ref } = volatileRef(90);
  expect(readSetting(ref)).toBe(90);
});

it("同一引用在宿主换快照后读到新值（引用语义，不用重新拿 config）", () => {
  const { ref, set } = volatileRef(90);
  expect(readSetting(ref)).toBe(90);
  set(30);
  expect(readSetting(ref)).toBe(30);
});

it("整个 config 是根引用时同样解引用（根防御）", () => {
  const { ref } = volatileRef({ enabled: true, retentionDays: 90 });
  expect(readSetting(ref)).toEqual({ enabled: true, retentionDays: 90 });
});

it("裸数字原样透传", () => {
  expect(readSetting(90)).toBe(90);
});

it("undefined 原样透传", () => {
  expect(readSetting(undefined)).toBeUndefined();
});

it("false 原样透传", () => {
  expect(readSetting(false)).toBe(false);
});
