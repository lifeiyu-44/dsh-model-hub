import z from "@deepseek-ai/schemastery";
/** 全部字段 .volatile() —— 宿主把标了它的字段当引用对象，改完即生效、不用重载插件。 */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  recordEnabled: z<boolean, boolean, "volatile-defined">;
  retentionDays: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  recordEnabled: z<boolean, boolean, "volatile-defined">;
  retentionDays: z<number, number, "volatile-defined">;
}>>, "plain">;
declare const name = "dsh-model-hub";
declare const inject: string[];
/**
 * 面板诊断栏显示的版本号。
 *
 * 与 `package.json` 的 `version` 必须一致 —— 单测 `tests/diag.spec.ts` 守着这条，
 * 因为它是最容易忘记同步的一处（发布时改了 package.json 忘了改这里，
 * 用户报障时看到的版本就是错的）。
 */
declare const PLUGIN_VERSION = "0.1.0";
declare function apply(ctx: any, config: any): void;
export { Config, PLUGIN_VERSION, apply, inject, name };