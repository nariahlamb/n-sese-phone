// ===== 文字 AI 请求活动注册表（主项目） =====
// 纯内存、事件驱动：无轮询、无定时器、无 DOM。为空时零开销。
// 每个 withTextAiRetry 在请求生命周期内登记一条；特殊路径（纪要合并/宅仙直连/正文插图提示词）手工登记。
// 纪律：
//   · cancel 只负责「停请求 + 标记 terminating」，不替业务做聊天归属判断；
//     captureChatScope / isCurrent() / epoch / serial 写回守卫全部保留。
//   · 条目结束后立即移除，不持久化（刷新即空）；条目数有界，超出时挤掉最旧的。
import { makeUniqueId } from './id';

export type AiTextPhase = 'preparing' | 'requesting' | 'retrying' | 'parsing' | 'writing' | 'terminating';

export interface AiActivityEntry {
  id: string;
  /** 面向用户的标签（大调查 / 采访 / 日历 …）。 */
  label: string;
  phase: AiTextPhase;
  attempt?: number;
  maxAttempts?: number;
  startedAt: number;
  /** 发起时的聊天键；UI 只显示当前聊天。空串＝守卫停用/存储未就绪，照常显示。 */
  chatKey: string;
  generationId?: string;
  cancelable: boolean;
  /** 有专属面板/专属进度 UI 时只上提示条与悬浮钮动效，不弹聚合 toast。 */
  suppressToast?: boolean;
  cancel?: () => void;
}

export type AiActivityPatch = Partial<Omit<AiActivityEntry, 'id' | 'startedAt'>>;

export interface AiActivityHandle {
  id: string;
  update(patch: AiActivityPatch): void;
  end(): void;
}

export type AiActivityListener = (list: AiActivityEntry[]) => void;

/** 注册表上限：结束后即移除，正常远达不到；仅防极端泄漏。 */
const MAX_ACTIVITIES = 32;

const _entries = new Map<string, AiActivityEntry>();
const _listeners = new Set<AiActivityListener>();

/** 当前聊天键读取口：index.ts 初始化时注入（core/story-floor-store.getCurrentStoryChatKey）。
 *  未注入时返回空串 ⇒ UI 层不过滤（测试/独立产物可用）。 */
let _chatKeyReader: (() => string) | null = null;

export function setAiActivityChatKeyReader(reader: (() => string) | null): void {
  _chatKeyReader = reader;
}

export function readAiActivityChatKey(): string {
  if (!_chatKeyReader) return '';
  try { return String(_chatKeyReader() || ''); } catch (_e) { return ''; }
}

function _snapshot(): AiActivityEntry[] {
  const list: AiActivityEntry[] = [];
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
  let oldest: AiActivityEntry | null = null;
  _entries.forEach(entry => {
    if (!oldest || entry.startedAt < oldest.startedAt) oldest = entry;
  });
  if (oldest) _entries.delete((oldest as AiActivityEntry).id);
}

export function beginAiActivity(input: Omit<AiActivityEntry, 'id' | 'startedAt'>): AiActivityHandle {
  if (_entries.size >= MAX_ACTIVITIES) _evictOldest();
  const id = makeUniqueId('ai-act');
  const entry: AiActivityEntry = { ...input, id, startedAt: Date.now() };
  _entries.set(id, entry);
  _emit();
  let ended = false;
  return {
    id,
    update(patch: AiActivityPatch): void {
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

export function updateAiActivity(id: string, patch: AiActivityPatch): void {
  const cur = _entries.get(id);
  if (!cur) return;
  Object.assign(cur, patch);
  _emit();
}

export function endAiActivity(id: string): void {
  if (_entries.delete(id)) _emit();
}

export function listAiActivities(): AiActivityEntry[] {
  return _snapshot();
}

export function getAiActivity(id: string): AiActivityEntry | null {
  const cur = _entries.get(id);
  return cur ? { ...cur } : null;
}

/** 订阅活动列表变化（begin/update/end/cancel 时回调）。返回退订函数。 */
export function subscribeAiActivities(cb: AiActivityListener): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

/** 取消一条活动：先标记 terminating，再调 cancel。已结束/不存在返回 false。 */
export function cancelAiActivity(id: string): boolean {
  const entry = _entries.get(id);
  if (!entry) return false;
  if (entry.phase === 'terminating') return true; // 已在终止中：不重复触发 cancel
  entry.phase = 'terminating';
  _emit();
  try { entry.cancel?.(); } catch (_e) { /* cancel 失败仍保持 terminating，等 finally 收口 */ }
  return true;
}

/** 取消满足条件的所有活动；返回取消条数。 */
export function cancelAllAiActivities(filter?: (entry: AiActivityEntry) => boolean): number {
  let count = 0;
  _entries.forEach((entry, id) => {
    if (filter && !filter({ ...entry })) return;
    if (cancelAiActivity(id)) count += 1;
  });
  return count;
}

/** 当前聊天的活动（chatKey 为空视为不过滤）。纯读，无副作用。 */
export function listCurrentChatAiActivities(): AiActivityEntry[] {
  const key = readAiActivityChatKey();
  return _snapshot().filter(entry => !key || !entry.chatKey || entry.chatKey === key);
}

/** 测试用：清空注册表（不触发 cancel）。 */
export function _resetAiActivitiesForTest(): void {
  _entries.clear();
  _listeners.clear();
  _chatKeyReader = null;
}
