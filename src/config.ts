import z from "@deepseek-ai/schemastery";

/** 全部字段 .volatile() —— 宿主把标了它的字段当引用对象，改完即生效、不用重载插件。 */
export const Config = z.object({
  enabled: z.boolean().default(true).description("总开关").volatile(),
  recordEnabled: z.boolean().default(true).description("是否记录请求").volatile(),
  retentionDays: z.number().default(90).description("明细保留天数").volatile(),
});
