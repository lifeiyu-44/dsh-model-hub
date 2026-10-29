import z from "@deepseek-ai/schemastery";

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
export function readSetting<T>(value: T): T {
  return typeof value === "object" && value !== null && VOLATILE_WRITE in (value as object)
    ? ((value as unknown as { get: () => T }).get() as T)
    : value;
}

/** 全部字段 .volatile() —— 宿主把标了它的字段当引用对象，改完即生效、不用重载插件。 */
export const Config = z.object({
  enabled: z.boolean().default(true).description("总开关").volatile(),
  recordEnabled: z.boolean().default(true).description("是否记录请求").volatile(),
  retentionDays: z.number().default(90).description("明细保留天数").volatile(),
});
