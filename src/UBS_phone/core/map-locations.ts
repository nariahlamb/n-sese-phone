// ===== 主项目地图功能·只读地点读取（相机 App 拍照地点来源，docs/03 §2） =====
// 读主项目 usb_story_map_<hash(storageId)>.json（kind 'story-map'，同一文件=共享真相），
// 只读不写（绝不调用 append/replaceAll）。V3 journal 存储：信封 value 是 {baseline,entries}
// 底账而非扁平 KV，必须经 replayStoryDomainJournal 重放出 map.index + map.node:<id> 再取数。
// 来源是地图功能自己的存储，不是神数据库「世界地点表」；只收录已生成（status=generated）
// 且带探索描述（explorationDesc.summary 非空）的节点——无描述的节点对生图提示词没有增量。
// 不 import 主项目 map-tree-store（其依赖 story-floor-store 单例写链）；story-domain-store
// 只用其纯函数（重放/校验），同属 A 级只读复用。首次读取后按 storageId 缓存；
// 主项目落盘事件（ub-story-state-invalidated）与存储就绪事件到达即失效，TTL 仅兜底。

import {
  createAtomicEnvelopeStore,
  type AtomicEnvelopeStore,
} from '../../unified-statusbar/core/atomic-envelope-store';
import { chatStorageHash } from '../../unified-statusbar/core/chat-storage-identity';
import { createServerFileStore, type ServerFileStore } from '../../unified-statusbar/core/server-file-store';
import {
  isStoryDomainJournal,
  replayStoryDomainJournal,
} from '../../unified-statusbar/core/story-domain-store';
import { hostWindow } from './host-env';
import { currentPhoneStorageId } from './phone-store';
import { isRecord } from './ubp-utils';

export interface PhoneMapLocation {
  nodeId: string;
  name: string;
  /** 层级全路径（如 「星城-中央区-图书馆」）。 */
  fullPath: string;
  /** 探索描述摘要（explorationDesc.summary）。 */
  summary: string;
  /** 探索物品（explorationDesc.items）。 */
  items: string;
  /** 内部房间名（structure.rooms）。 */
  rooms: string;
}

export interface PhoneMapLocationsDeps {
  /** 测试注入；缺省用当前聊天身份。 */
  storageId?: string;
  files?: ServerFileStore;
  now?: () => number;
}

interface IndexNodeLike {
  nodeId?: unknown;
  name?: unknown;
  parentId?: unknown;
  status?: unknown;
}

function str(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 从 index 拓扑派生 fullPath（对齐主项目 map-tree-store.deriveFullPathFromIndex）。 */
function deriveFullPath(index: Record<string, IndexNodeLike>, nodeId: string): string {
  const parts: string[] = [];
  const guard = new Set<string>();
  let cur: unknown = index[nodeId];
  while (isRecord(cur) && !guard.has(String(cur.nodeId))) {
    guard.add(String(cur.nodeId));
    parts.unshift(str(cur.name, 60));
    const parent = cur.parentId;
    cur = typeof parent === 'string' && parent ? index[parent] : undefined;
  }
  return parts.filter(Boolean).join('-');
}

interface CacheEntry {
  storageId: string;
  locations: PhoneMapLocation[];
  at: number;
}

let _cache: CacheEntry | null = null;
/** 事件失效的兜底 TTL（无轮询定时器，仅读取时判断）：事件不可达时保证最终一致。 */
const CACHE_TTL_MS = 60_000;

/** 缓存失效（切聊天重绑 / 主项目落盘事件回调 / 测试用）。 */
export function clearPhoneMapLocationsCache(): void {
  _cache = null;
}

/**
 * 绑定主项目事件驱动的缓存失效（守卫防重，幂等）。功能未触发（从未读过地点）前不绑定。
 * - ub-story-state-invalidated：主项目 journal flush 落盘完成后派发——磁盘此时才有新地图节点；
 * - ub-statusbar-storage-ready：存储重绑/重置（同 storageId 文件可能被重建）。
 */
export function bindPhoneMapInvalidation(): boolean {
  const w = hostWindow() as unknown as { __ubp_maploc_bound?: boolean; addEventListener?: unknown };
  if (w.__ubp_maploc_bound) return false;
  if (typeof w.addEventListener !== 'function') return false;
  w.__ubp_maploc_bound = true;
  try {
    w.addEventListener('ub-story-state-invalidated', () => { _cache = null; });
    w.addEventListener('ub-statusbar-storage-ready', () => { _cache = null; });
  } catch (_e) {
    w.__ubp_maploc_bound = false;
    return false;
  }
  return true;
}

/** 读取地图地点列表（已生成且有探索描述；按全路径排序）。无地图数据/读取失败返回空数组。 */
export async function readPhoneMapLocations(deps: PhoneMapLocationsDeps = {}): Promise<PhoneMapLocation[]> {
  bindPhoneMapInvalidation();
  const storageId = deps.storageId ?? currentPhoneStorageId();
  if (!storageId) return [];
  const now = deps.now ?? (() => Date.now());
  if (_cache && _cache.storageId === storageId && now() - _cache.at < CACHE_TTL_MS) return _cache.locations;
  const store: AtomicEnvelopeStore<Record<string, unknown>> = createAtomicEnvelopeStore({
    files: deps.files ?? createServerFileStore(),
    filename: `usb_story_map_${chatStorageHash(storageId)}.json`,
    kind: 'story-map',
    scopeId: storageId,
    domainCreated: true, // 只读挂载：不参与主项目 domainsCreated 域标记
    emptyValue: {},
    now,
  });
  const status = await store.load();
  if (status.state !== 'ready' && status.state !== 'uninitialized') return [];
  // 信封 value 是 journal 底账（V3）→ 重放为扁平 KV；旧扁平快照（如有）原样兼容。
  const raw = store.readAll();
  const all = isStoryDomainJournal(raw) ? replayStoryDomainJournal(raw) : raw;
  const indexRaw = all['map.index'];
  if (!isRecord(indexRaw) || !isRecord(indexRaw.nodes)) return [];
  const nodes = indexRaw.nodes as Record<string, IndexNodeLike>;
  const locations: PhoneMapLocation[] = [];
  for (const node of Object.values(nodes)) {
    if (!isRecord(node)) continue;
    const nodeId = str(node.nodeId, 80);
    const name = str(node.name, 60);
    if (!nodeId || !name) continue;
    if (node.status !== 'generated') continue;
    const detail = all[`map.node:${nodeId}`];
    let summary = '';
    let items = '';
    let rooms = '';
    if (isRecord(detail)) {
      const exploration = detail.explorationDesc;
      if (isRecord(exploration)) {
        summary = str(exploration.summary, 300);
        if (Array.isArray(exploration.items)) {
          items = exploration.items.filter(i => typeof i === 'string' && i.trim()).join('、').slice(0, 300);
        }
      }
      const structure = detail.structure;
      if (isRecord(structure) && Array.isArray(structure.rooms)) {
        rooms = (structure.rooms as unknown[])
          .map(r => (isRecord(r) ? str(r.name, 40) : ''))
          .filter(Boolean)
          .join('、')
          .slice(0, 200);
      }
    }
    if (!summary) continue; // 只显示存在探索描述的节点
    locations.push({ nodeId, name, fullPath: deriveFullPath(nodes, nodeId), summary, items, rooms });
  }
  locations.sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'zh-Hans-CN'));
  _cache = { storageId, locations, at: now() };
  return locations;
}
