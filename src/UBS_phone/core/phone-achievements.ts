// ===== 瑟瑟小手机 · 成就打点（第八轮 L9） =====
// 统一状态栏的成就系统通过宿主 window 暴露派发器 __ubEmitAchievement（状态栏未加载 / 成就总开关
// 关闭时它不存在或退化为空函数）。小手机侧全部打点统一走本模块：可选链 + try/catch ⇒ 桥不在时
// 零成本，打点永不打断手机功能。
//
// 口径（L9）：只有「玩家点了、并且成功了」的那一下才 emit；AI/系统自动发生的行为（AI 回复与投递、
// 世界演化来电/消息、自动窥私、自动已读、自动备份、留言生成、通知聚合、missed 振铃超时）一律不打点。
// 事件名与 payload 契约见统一状态栏 achievements/available-materials.md §A1b
// （状态栏侧 100 条成就与 76 条计数器已就绪；payloadMatch 数值键要求字段必须存在，布尔一律 1/0）。
import { hostWindow } from './host-env';

export type PhoneAchPayload = Record<string, number | string>;

/** 玩家亲手成功打点。event 名与状态栏成就目录（achievements.json）一一对应。 */
export function emitAch(event: string, payload: PhoneAchPayload = {}): void {
  try {
    (hostWindow() as any)?.__ubEmitAchievement?.(event, payload);
  } catch (_e) { /* 打点永不打断手机功能 */ }
}

/** 布尔 → 1/0（成就 payloadMatch 数值键只认数字）。 */
export function achFlag(v: unknown): number {
  return v ? 1 : 0;
}

/** 日/季窗口伴随打点（daily-action / window-action 计数源）：与主事件在同一成功点并排调用。 */
export function emitActionOnDate(action: string): void {
  emitAch('action-on-date', { action });
}
