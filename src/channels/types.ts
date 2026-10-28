/** 一个渠道后端要提供的最小接口。新增平台只实现这两件事。 */
export interface ChannelBackend {
  /** 渠道 id，如 `hub-workbuddy-global`。 */
  readonly id: string;
  /** 该渠道当前可用的模型列表；无凭据时返回空数组，不抛错。 */
  listModels(): Promise<ChannelModel[]>;
  /** 组装一次上游请求所需的地址与头。 */
  prepare(): Promise<{ baseUrl: string; headers: Record<string, string> }>;
}

export interface ChannelModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  creditMultiplier: number;
  supportsImages: boolean;
  /** 上游给的活动标记文案，如 `Free now`。没有就不带。 */
  promotionBadge?: string;
  /** 上游给的等级标记文案，如 `Pro Only`。没有就不带。 */
  tierBadge?: string;
  /** 活动标记的颜色（CSS 颜色字面量），供浏览器侧画彩色 pill。 */
  promotionColor?: string;
  /** 等级标记的颜色。 */
  tierColor?: string;
}
