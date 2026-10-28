import { isRefillMode } from './refill-mode';

export type WorldbookProjectionReason = 'data-change' | 'config-change' | 'phone-online';

type ProjectionDispatcher = (id: string, reason: WorldbookProjectionReason) => Promise<void> | void;

let dispatcher: ProjectionDispatcher | null = null;
/** dispatcher 安装前到达的请求：registry 初始化后自动补发（否则伴生插件早注册会静默丢投影）。 */
const pendingRequests = new Set<string>();

/** Installed by the projection registry after all feature reconcilers are available. */
export function setWorldbookProjectionDispatcher(next: ProjectionDispatcher | null): void {
  dispatcher = next;
  if (!next) return;
  const ids = [...pendingRequests];
  pendingRequests.clear();
  // 重填模式：请求本来就该丢弃；关闭重填后 refreshAll 会按当前数据整本重建。
  if (isRefillMode()) return;
  for (const id of ids) {
    try { void next(id, 'data-change'); } catch (_e) { /* 单个补发失败不影响其余 */ }
  }
}

export function hasWorldbookProjectionDispatcher(): boolean {
  return dispatcher !== null;
}

/**
 * Safe no-op before registry initialization and after teardown.
 *
 * 重填模式闸门：本函数是全插件唯一的「自动世界书写入」派发入口——日历/经期/孕期/玩法/
 * 物品使用/技能/地图节点/衣柜/世界/角色动向/人物关系以及外部注册投影（如小手机消息记录）
 * 全部经此派发。重填期间一律丢弃投影请求，不做任何世界书读写；关闭重填模式时由
 * index.ts 的恢复链调 refreshAllWorldbookProjections() 按当前数据整本重建，故丢弃无残留。
 * 注意：registry.setFeatureEnabled 走协调器直连（不经过本函数），用户开关功能时的条目
 * 清理不受本闸门影响。
 */
export function requestWorldbookProjection(id: string, reason: WorldbookProjectionReason): void {
  if (isRefillMode()) return;
  if (!dispatcher) {
    pendingRequests.add(id);
    return;
  }
  void dispatcher(id, reason);
}
