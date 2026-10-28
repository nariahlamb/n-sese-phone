// ===== 按聊天手机数据存储（usb_phone_<hash(storageId)>.json，无楼层锚定） =====
// 参照主项目立绘 portrait-persistent-store 的按聊天存储方式（docs/01 §5）。
// 身份与主项目共享：chat_metadata.unifiedStatusbar.storageId。
// 写入策略：整文件原子替换（replaceAll），变更走 mutatePhoneData 的去抖合并通道。

import {
  createAtomicEnvelopeStore,
  type AtomicEnvelopeStore,
} from '../../unified-statusbar/core/atomic-envelope-store';
import {
  chatStorageHash,
  resolveChatStorageIdentity,
  type ChatOwner,
} from '../../unified-statusbar/core/chat-storage-identity';
import { createServerFileStore, type ServerFileStore } from '../../unified-statusbar/core/server-file-store';
import { touchStorageIndex } from '../../unified-statusbar/core/storage-global-index';
import { createSillyChatMetadataHost } from '../../unified-statusbar/core/silly-chat-metadata-host';
import { hostWindow } from './host-env';
import { emptyPhoneChatData, normalizePhoneChatData, type PhoneChatData } from './chat-model';

export type PhoneStoreState = 'unbound' | 'uninitialized' | 'ready' | 'read-only' | 'no-context' | 'error';

export interface PhoneStoreStatus {
  state: PhoneStoreState;
  storageId: string;
  filename: string;
  error?: string;
}

export interface PhoneChatStoreDeps {
  files?: ServerFileStore;
  storageId: string;
  owner?: ChatOwner;
  now?: () => number;
}

export function phoneStoreFilename(storageId: string): string {
  return `usb_phone_${chatStorageHash(storageId)}.json`;
}

/** 工厂（测试可直接注入 files/now）。 */
export function createPhoneChatStore(deps: PhoneChatStoreDeps): AtomicEnvelopeStore<Record<string, unknown>> {
  return createAtomicEnvelopeStore<Record<string, unknown>>({
    files: deps.files ?? createServerFileStore(),
    filename: phoneStoreFilename(deps.storageId),
    kind: 'phone',
    scopeId: deps.storageId,
    ...(deps.owner ? { owner: deps.owner } : {}),
    domainCreated: true, // 小手机不使用主项目 domainsCreated 域标记体系（自有文件命名空间）
    emptyValue: { schema: 1, conversations: [] },
    now: deps.now ?? (() => Date.now()),
  });
}

// ===== 运行时单例（rebind 于 CHAT_CHANGED） =====

let _store: AtomicEnvelopeStore<Record<string, unknown>> | null = null;
let _binding: Promise<PhoneStoreStatus> | null = null;
let _status: PhoneStoreStatus = { state: 'unbound', storageId: '', filename: '' };
let _data: PhoneChatData = emptyPhoneChatData();
// U23(十一轮)：数据修订计数——每次真实写入/换绑推进；游戏域等「读取即全量规范化重建」
// 的路径按它记忆化（refreshIsland 通话期间每秒一次 readGames 不再全域重建）。
let _dataRevision = 0;
export function phoneDataRevision(): number { return _dataRevision; }
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _dirty = false;

export function phoneStoreStatus(): PhoneStoreStatus {
  return { ..._status };
}

export function currentPhoneStorageId(): string {
  return _status.storageId;
}

/** 当前角色名（索引 touch 的角色名快照用；群组/无上下文返回空）。 */
function characterNameFromHostContext(): string {
  try {
    const ctx = (hostWindow() as any).SillyTavern?.getContext?.();
    const cid = ctx?.characterId;
    if (cid === undefined || cid === null || cid === '') return '';
    const ch = Array.isArray(ctx?.characters) ? ctx.characters[Number(cid)] : null;
    return typeof ch?.name === 'string' ? ch.name.trim().slice(0, 120) : '';
  } catch (_e) {
    return '';
  }
}

/**
 * 解析聊天身份并重建 store（CHAT_CHANGED / 首启调用）。
 * 不传 inspectOwner：fork/改名语义交给主项目状态栏；storageId 跟随元数据即视为正确。
 */
export async function rebindPhoneStore(): Promise<PhoneStoreStatus> {
  if (_binding) return _binding;
  _binding = (async () => {
    await flushPhoneStore();
    const host = createSillyChatMetadataHost();
    const identity = await resolveChatStorageIdentity(host);
    if (identity.kind === 'no-context') {
      _store = null;
      _data = emptyPhoneChatData();
      _dataRevision += 1; // U23(十一轮)
      _status = { state: 'no-context', storageId: '', filename: '', error: '当前无有效聊天上下文' };
      return _status;
    }
    if (identity.kind !== 'ready') {
      _store = null;
      _data = emptyPhoneChatData();
      _dataRevision += 1; // U23(十一轮)
      const error = identity.kind === 'read-only' ? identity.error : `聊天身份不可用（${identity.kind}）`;
      _status = { state: 'error', storageId: '', filename: '', error };
      return _status;
    }
    const store = createPhoneChatStore({ storageId: identity.storageId, owner: identity.owner });
    const loadStatus = await store.load();
    _store = store;
    _data = normalizePhoneChatData(store.readAll());
    _dataRevision += 1; // U23(十一轮)
    _dirty = false;
    const state: PhoneStoreState = loadStatus.state === 'ready' ? 'ready'
      : loadStatus.state === 'uninitialized' ? 'uninitialized'
        : 'read-only';
    _status = { state, storageId: identity.storageId, filename: phoneStoreFilename(identity.storageId) };
    // 前瞻式全局外部存储索引（与主项目共用同一索引文件）：仅在小手机自己创建身份的一次性时刻
    // best-effort 记录一条（主项目先建时 ownerAction='same' 不重复 touch）。fire-and-forget，
    // 失败静默——「全局手机存储管理」靠它秒级列出所有聊天的手机存储。
    if (identity.ownerAction === 'created') {
      const charName = characterNameFromHostContext();
      void touchStorageIndex(createServerFileStore(), {
        storageId: identity.storageId,
        owner: identity.owner,
        ...(charName ? { characterName: charName } : {}),
        createdAt: Date.now(),
        domainsCreated: [],
      }).catch(() => { /* best-effort：索引不可达不影响存储初始化 */ });
    }
    return _status;
  })();
  try {
    return await _binding;
  } finally {
    _binding = null;
  }
}

/** 当前会话数据快照（深拷贝）。 */
export function readPhoneData(): PhoneChatData {
  return normalizePhoneChatData(_data);
}

/** 容错版全量读：异常时退回空数据形状（宿主存储异常不致渲染崩溃）。 */
export function readPhoneDataSafe(): PhoneChatData {
  try {
    return readPhoneData();
  } catch (_e) {
    return { schema: 1, conversations: [] };
  }
}

/**
 * 只读引用（零拷贝）：徽标计数等热路径专用，禁止改写任何字段（写一律走 mutatePhoneData）。
 * readPhoneData 的深拷贝禁进热路径（readPhoneAvatars 同款纪律）。
 */
export function readPhoneDataRef(): PhoneChatData {
  return _data;
}

/** 自定义头像表浅拷贝（渲染热路径专用，避免整份数据深拷贝）。 */
export function readPhoneAvatars(): Record<string, string> {
  return { ...(_data.avatars || {}) };
}

/** 数据变更监听（消息记录世界书投影等伴生订阅；回调自负责防抖/门控，未订阅零开销）。 */
const _mutateListeners: Array<() => void> = [];

export function onPhoneDataMutated(cb: () => void): void {
  if (!_mutateListeners.includes(cb)) _mutateListeners.push(cb);
}

/**
 * 就地变更数据并落盘（去抖 350ms 合并写）。
 * mutator 直接改写传入的 data（内存即真相）；返回 mutator 的返回值。
 */
export function mutatePhoneData<T>(mutator: (data: PhoneChatData) => T): T {
  const result = mutator(_data);
  _dataRevision += 1; // U23(十一轮)：读取侧记忆化的失效令牌
  _dirty = true;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    void persistPhoneData();
  }, 350);
  for (const listener of _mutateListeners) {
    try { listener(); } catch (_e) { /* 伴生故障不阻断写路径 */ }
  }
  return result;
}

/** 立即整文件落盘（pagehide / 切聊天 / 关视图时调用）。 */
export async function persistPhoneData(): Promise<boolean> {
  if (!_store || !_dirty) return true;
  const snapshot = normalizePhoneChatData(_data);
  const result = await _store.replaceAll(snapshot as unknown as Record<string, unknown>);
  if (result.ok && result.confirmed) {
    _dirty = false;
    return true;
  }
  // 写失败保持 _dirty，下次重试；read-only 时提示
  if (_store.status().state === 'read-only') {
    _status = { ..._status, state: 'read-only' };
  }
  return false;
}

export async function flushPhoneStore(): Promise<void> {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  if (_dirty) await persistPhoneData();
  await _store?.flush();
}

/** 清空当前聊天的全部手机数据（设置页「清空」出口；文件重建为空）。
 *  **先写盘、成功后才清内存**：写失败时内存一字不动、_dirty 不变 ⇒ 上层那句「数据已保持原样」才是真的
 *  （旧实现先清内存再落盘，失败时内存已空 + _dirty=true，之后任何一次写或关页 flush 都会把空数据落盘，F3）。 */
export async function resetPhoneData(): Promise<boolean> {
  if (!_store) return false;
  const empty = emptyPhoneChatData();
  const result = await _store.replaceAll(normalizePhoneChatData(empty) as unknown as Record<string, unknown>);
  if (!result.ok || !result.confirmed) return false; // 内存保持原样，不做任何乐观清空
  swapDataInPlace(_data, empty); // 保持 _data 对象引用不变（伴生监听/只读引用继续有效）
  _dirty = false;
  return true;
}

/** 就地换掉目标对象的全部键（保持对象引用不变）。 */
function swapDataInPlace(target: PhoneChatData, next: PhoneChatData): void {
  const t = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(t)) delete t[key];
  Object.assign(t, next as unknown as Record<string, unknown>);
}

/**
 * 整值替换当前聊天数据并立即落盘（备份恢复/全局存储管理恢复共用出口）。
 * 保持 _data 对象引用不变（伴生监听持有的引用继续有效）；调用方须传入独立副本。
 */
export async function replacePhoneData(data: PhoneChatData): Promise<boolean> {
  mutatePhoneData(d => swapDataInPlace(d, data));
  return persistPhoneData();
}
