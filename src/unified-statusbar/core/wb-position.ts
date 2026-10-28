import { getTavernHelper } from './env';
// core/wb-position.ts
// DS 缓存优化：把本插件注入角色世界书的持久条目统一改插入到 at_depth system 0，
// 让正文成为单调增长的缓存前缀，提升 DeepSeek 等前缀缓存模型的正文命中率。
//
// - dsCachePos(orig)：开→{type:'at_depth',role:'system',depth:0,order:orig.order}；关→orig。
// - registerManagedWbEntry：各自动同步模块 import 时自登记「我管的条目+原位置」。
// - repositionManagedWbEntries：翻转开关时遍历角色世界书，把受管条目 position 重写为 dsCachePos(orig)。
//
// 仅依赖 config-store，不 import 各业务模块（避免环：各模块 import 本文件的 dsCachePos/registerManagedWbEntry）。
import { getConfig } from './config-store';

export type WbPosType =
  | 'at_depth'
  | 'before_character_definition'
  | 'after_character_definition'
  | 'before_author_note'
  | 'after_author_note'
  | 'before_example_messages'
  | 'after_example_messages';

export interface WbPosSpec {
  type: WbPosType;
  role: 'system';
  depth: number;
  order: number;
}

/** DS 缓存优化开启 → 覆盖为 at_depth system 0（保留 order）；关闭 → 返回原位置。 */
export function dsCachePos(orig: WbPosSpec): WbPosSpec {
  if (getConfig().dsCacheOptimize) {
    return { type: 'at_depth', role: 'system', depth: 0, order: orig.order };
  }
  return orig;
}

interface ManagedSpec {
  match: (entry: any) => boolean;
  origPos: () => WbPosSpec;
}

const MANAGED: ManagedSpec[] = [];

/** 各自动同步模块 import 时登记其管理的世界书条目（条目匹配器 + 原始位置）。调查档案不登记（无自动同步）。 */
export function registerManagedWbEntry(spec: ManagedSpec): void {
  MANAGED.push(spec);
}


/**
 * 翻转 DS 缓存优化开关时调用：遍历当前角色绑定的所有世界书（primary+additional），
 * 把本插件受管条目的 position 重写为 dsCachePos(orig)。每本世界书只读-改-写一次，position 未变则不写。
 * 无角色世界书或 TavernHelper 不可用 → 静默返回。
 */
export async function repositionManagedWbEntries(): Promise<void> {
  const th = getTavernHelper();
  if (!th || typeof th.getCharWorldbookNames !== 'function') return;
  let charWbs: any = null;
  try {
    charWbs = th.getCharWorldbookNames('current');
  } catch (_e) {
    return;
  }
  const names: string[] = [];
  if (charWbs && charWbs.primary) names.push(charWbs.primary);
  if (charWbs && Array.isArray(charWbs.additional)) {
    for (const n of charWbs.additional) if (n) names.push(n);
  }
  for (const wbName of names) {
    let entries: any[];
    try {
      entries = await th.getWorldbook(wbName);
    } catch (_e) {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    let changed = false;
    for (const e of entries) {
      const spec = MANAGED.find((m) => m.match(e));
      if (!spec) continue;
      const target = dsCachePos(spec.origPos());
      const p = e.position;
      // 保留条目既有 order（多条目模块如地图节点注入各带不同 order；单条目模块 p.order===target.order 无变化）
      const finalOrder = (p && typeof p.order === 'number') ? p.order : target.order;
      const finalTarget = { ...target, order: finalOrder };
      if (!p || p.type !== finalTarget.type || p.role !== finalTarget.role || p.depth !== finalTarget.depth || p.order !== finalTarget.order) {
        e.position = finalTarget;
        changed = true;
      }
    }
    if (changed && typeof th.replaceWorldbook === 'function') {
      try {
        await th.replaceWorldbook(wbName, entries, { render: 'debounced' });
      } catch (_e) {
        /* ignore single book */
      }
    }
  }
}