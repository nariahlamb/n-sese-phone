// ===== 小手机文字 AI 请求活动注册表 =====
// 与主项目 core/ai-activity.ts 同构，独立单例（手机 bundle 不跨 iframe 共享状态）。
// 纯内存、事件驱动：无轮询、无定时器、无 DOM；为空时零开销。
import type { AiTextPhase } from '../../unified-statusbar/core/ai-text-features';

export type PhoneAiTone = 'wechat' | 'ai' | 'shop' | 'custom';

export interface PhoneAiActivityEntry {
  id: string;
  /** 稳定功能键（'微信回复' / '朋友圈刷新' / '通话' …），用于测试与去重展示。 */
  feature: string;
  label: string;
  phase: AiTextPhase;
  attempt?: number;
  maxAttempts?: number;
  startedAt: number;
  generationId?: string;
  appId?: string;
  tone?: PhoneAiTone;
  cancelable: boolean;
  suppressToast?: boolean;
  cancel?: () => void;
}

export type PhoneAiActivityPatch = Partial<Omit<PhoneAiActivityEntry, 'id' | 'startedAt'>>;

export interface PhoneAiActivityHandle {
  id: string;
  update(patch: PhoneAiActivityPatch): void;
  end(): void;
}

export type PhoneAiActivityListener = (list: PhoneAiActivityEntry[]) => void;

const MAX_ACTIVITIES = 32;
const _entries = new Map<string, PhoneAiActivityEntry>();
const _listeners = new Set<PhoneAiActivityListener>();

function _newId(): string {
  return 'ubp-ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function _snapshot(): PhoneAiActivityEntry[] {
  const list: PhoneAiActivityEntry[] = [];
  _entries.forEach(entry => { list.push({ ...entry }); });
  return list;
}

function _emit(): void {
  if (_listeners.size === 0) return;
  const list = _snapshot();
  _listeners.forEach((fn) => {
    try { fn(list); } catch (_e) { /* 单个订阅者异常不阻断其余 */ }
  });
}

function _evictOldest(): void {
  let oldest: PhoneAiActivityEntry | null = null;
  _entries.forEach(entry => {
    if (!oldest || entry.startedAt < oldest.startedAt) oldest = entry;
  });
  if (oldest) _entries.delete((oldest as PhoneAiActivityEntry).id);
}

export function beginPhoneAiActivity(input: Omit<PhoneAiActivityEntry, 'id' | 'startedAt'>): PhoneAiActivityHandle {
  if (_entries.size >= MAX_ACTIVITIES) _evictOldest();
  const id = _newId();
  _entries.set(id, { ...input, id, startedAt: Date.now() });
  _emit();
  let ended = false;
  return {
    id,
    update(patch: PhoneAiActivityPatch): void {
      if (ended) return;
      const cur = _entries.get(id);
      if (!cur) return;
      Object.assign(cur, patch);
      _emit();
    },
    end(): void {
      if (ended) return;
      ended = true;
      if (_entries.delete(id)) _emit();
    },
  };
}

export function updatePhoneAiActivity(id: string, patch: PhoneAiActivityPatch): void {
  const cur = _entries.get(id);
  if (!cur) return;
  Object.assign(cur, patch);
  _emit();
}

export function endPhoneAiActivity(id: string): void {
  if (_entries.delete(id)) _emit();
}

export function listPhoneAiActivities(): PhoneAiActivityEntry[] {
  return _snapshot();
}

export function subscribePhoneAiActivities(cb: PhoneAiActivityListener): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

export function cancelPhoneAiActivity(id: string): boolean {
  const entry = _entries.get(id);
  if (!entry) return false;
  if (entry.phase === 'terminating') return true; // 已在终止中：不重复触发 cancel
  entry.phase = 'terminating';
  _emit();
  try { entry.cancel?.(); } catch (_e) { /* cancel 失败仍保持 terminating，等 finally 收口 */ }
  return true;
}

export function cancelAllPhoneAiActivities(filter?: (entry: PhoneAiActivityEntry) => boolean): number {
  let count = 0;
  _entries.forEach((entry, id) => {
    if (filter && !filter({ ...entry })) return;
    if (cancelPhoneAiActivity(id)) count += 1;
  });
  return count;
}

/** 测试用：清空注册表（不触发 cancel）。 */
export function _resetPhoneAiActivitiesForTest(): void {
  _entries.clear();
  _listeners.clear();
}
