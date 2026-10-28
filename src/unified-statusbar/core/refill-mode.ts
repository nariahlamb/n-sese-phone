// core/refill-mode.ts
// 重填模式：用户重填表格期间，暂停本插件的自动 AI 请求与自动数据写入，
// 避免状态栏的自动反应与重填互相干扰（重填产出的行被时间锚定/杂表回写覆盖、
// 分组填表逐组触发导致的地图/立绘过期生成、以及大量无意义的 AI 请求）。
//
// 两条纪律：
//   ① 只拦「后台自动」路径——用户点击触发的功能（面板按钮、穿戴、抽卡、手动演化、
//      手动生图、手动重生成插图、外部 API 等）不经过这些守卫，照常工作。
//   ② 被拦下的请求直接丢弃，不做补救、不做补跑：关掉开关后各自动链会在下一次
//      表格更新/消息事件时按当时的最新数据照常运行，无需任何恢复逻辑。
//      功能关时开销为零（一次配置缓存布尔读取，无监听器、无定时器）。
import { getConfig } from './config-store';

// 可注入的抑制判定：台账接管等「本开关不适用」的环境由入口（index.ts）注册，
// 本模块保持零依赖（只读 config-store），避免模块环。
let _suppress: (() => boolean) | null = null;

/** 注册抑制判定（返回 true 时 isRefillMode() 恒 false）；传 null 解除。 */
export function setRefillModeSuppressor(fn: (() => boolean) | null): void {
  _suppress = fn;
}

/** 是否处于重填模式。 */
export function isRefillMode(): boolean {
  // 常态（开关关）只读一次配置缓存，不触碰 window；仅开关打开时才问台账判据。
  if (getConfig().refillModeEnabled !== true) return false;
  if (_suppress && _suppress()) return false;
  return true;
}
