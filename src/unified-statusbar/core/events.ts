// ===== 跨模块事件名与派发的单一入口（U4）=====
//
// 病根：状态栏各模块靠 `window.dispatchEvent(new CustomEvent('ub-xxx'))` 通信，事件名以裸字符串
// 字面量散落在生产方与消费方两侧（12 个事件、约 30 处）。两处风险：
//   1) 改名/拼错不报错——生产方写 ub-map-navigted、消费方监听 ub-map-navigated，TypeScript 一声不吭，
//      功能静默失效（这类"监听没接上"最难排查）。
//   2) 派发守卫不一致——同类事件的派发，有的包了 try/catch（非浏览器/测试环境下安全），有的裸奔
//      （window 缺失即抛错）。
//
// 本模块是既有先例的推广：core/config-store.ts 早已导出 STATUSBAR_CONFIG_CHANGED_EVENT 常量，
// 但只有那一个事件享受了待遇。此处把其余事件收进 UB_EVENT 常量表，并统一经 emitUbEvent 派发。
//
// 纪律（对齐 unified-statusbar-perf-resource-discipline）：
// - 零依赖：不 import 任何项目模块（无循环依赖，任何模块都可安全引入）。
// - 行为零变化：字符串值与原先逐字节一致；无 detail 时派发 Event、有 detail 时派发 CustomEvent
//   （与原先各点形态一致），监听方无感。

/** 跨模块 window/document 事件名登记处。新增事件在此登记，禁止再写裸字符串。 */
export const UB_EVENT = {
  /** story journal 缓存已变（乐观 overlay 已更新，未落盘）。 */
  storyCacheChanged: 'ub-story-cache-changed',
  /** story 落盘完成、派生投影需重算。 */
  storyStateInvalidated: 'ub-story-state-invalidated',
  /** 数据库写成功（各写助手/直接 SQL）。 */
  dbWriteCommitted: 'ub-db-write-committed',
  /** 纪要数据更新（剧情阅读器据此刷新）。 */
  chronicleDataUpdated: 'ub-chronicle-data-updated',
  /** 地图跳转完成（面包屑/历史栈同步）。 */
  mapNavigated: 'ub-map-navigated',
  /** 地图合并完成。 */
  mapMerged: 'ub-map-merged',
  /** 地图场景状态变化。 */
  mapSceneState: 'ub-map-scene-state',
  /** 衣柜动作（穿戴/卸下等）。 */
  wardrobeAction: 'ub-wardrobe-action',
  /** 世界书投影就绪。 */
  worldbookProjectionReady: 'ub-worldbook-projection-ready',
  /** 存储迁移就绪。 */
  storageRelocationReady: 'ub-storage-relocation-ready',
  /** 立绘生成完成（document 级）。 */
  portraitGenerated: 'portrait:generated',
  /** 瑟瑟台账：「在场角色表」所在分组本轮落账完成（detail={token,aiFloor,tableNames}）。
   *  台账接管时这是立绘每轮更新的**唯一**触发源——其它表格更新/重注入/配置变更都不再触发。 */
  ledgerPresenceFilled: 'ub-ledger-presence-filled',
  /** 地图角色标记点击（document 级，带 detail）。 */
  mapMarkerClick: 'map:marker-click',
} as const;

/**
 * 统一派发：默认派发到 window；document 级事件用 target 指定。
 * - 无 detail → `new Event(name)`；有 detail → `new CustomEvent(name, { detail })`（与各原点形态一致）。
 * - 整体 try/catch：非浏览器/测试环境或已脱离文档树的 target 都不抛错（原先 3 处裸奔点由此收编）。
 */
export function emitUbEvent(name: string, detail?: unknown, target?: EventTarget | null): void {
  try {
    const t: EventTarget | null = target !== undefined
      ? target
      : (typeof window !== 'undefined' ? window : null);
    if (!t || typeof (t as any).dispatchEvent !== 'function') return;
    t.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }));
  } catch (_e) { /* non-browser / detached target：静默 */ }
}
