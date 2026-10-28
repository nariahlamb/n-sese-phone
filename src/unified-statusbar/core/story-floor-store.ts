// ===== 统一故事状态 · V3 外部存储路由 =====
import { createPortraitPersistentStore } from './portrait-persistent-store';
import { cloneJson } from './external-storage-codec';
import type { StoryJournalFacadeV3 } from './story-bundle-v3';
import { MAX_RETAINED_LAYERS, type StoryDomainStore } from './story-domain-store';
import { computeStoryFloorDiagnostics, type StoryFloorDiagnostics } from './story-floor-diagnostics';
import {
  createStoryWriteCoordinator,
  type StoryWriteCoordinator,
} from './story-write-coordinator';
import { activeStoryAnchors, activeStoryReplayAnchors, allRetainedAnchors } from './external-story-store';
import { traceCycleDiagnostic } from './cycle-diagnostics';
import { UB_EVENT, emitUbEvent } from './events';
import {
  hasStoryDeletionRetry,
  runStoryDeletionTransaction,
} from './story-deletion-transaction';
import { createChatScope, type ChatScope } from './chat-scope';

/** 路由用常量：key === PORTRAIT_FEATURE_KEY 的特性走持久域立绘 store，其余走 journal。 */
export const PORTRAIT_FEATURE_KEY = 'portrait';

/** V3 外部存储组合：journal facade（core+map 域回放）+ portraits（持久域）。 */
type StoryJournalStoreLike = StoryJournalFacadeV3;

export interface ExternalStoreBundle {
  journal: StoryJournalStoreLike;
  portraits: ReturnType<typeof createPortraitPersistentStore>;
  domains: {
    core: StoryDomainStore;
    map: StoryDomainStore;
  };
}

let _bundle: ExternalStoreBundle | null = null;
let _coordinator: StoryWriteCoordinator | null = null;
let _configuredChatKey = '';
let _storyStorageTransitioning = true;
let _storyDeletionBlocked = false;
let _mapDeletionGc: (candidates: string[]) => void | Promise<void> = () => undefined;

// ===== Write-behind 缓存层（portrait 域）=====
// journal 域写入已由 story-write-coordinator 承担（乐观 overlay + 防抖 + 失败重试）；
// 此层仅服务 portrait 持久域：写时同步改 portrait overlay → 读取/渲染即时反映；
// 防抖合并多次写为一次 portraits.replaceAll；flush 后清除 overlay（读回落 portraits 真值，
// V3 原子库可重试失败保留乐观值）+ 派发 invalidate 重渲染。
const STORY_WRITE_BEHIND_DEBOUNCE_MS = 300;
const STORY_WRITE_BEHIND_MAX_RETRIES = 3;
let _wbDelayMs = STORY_WRITE_BEHIND_DEBOUNCE_MS;

// 乐观读 overlay（portrait 域，单一 replaceAll 值）：null=无待写，读回落 portraits.readAll()。
let _wbPortraitOverlay: Record<string, unknown> | null = null;
let _wbPortraitDirty = false; // portrait 有待写（下次 flush 要 replaceAll）
let _wbTimer: ReturnType<typeof setTimeout> | null = null;
let _wbResolvers: Array<(ok: boolean) => void> = [];
let _wbFlushChain: Promise<void> = Promise.resolve();
// portrait 读数据代际（读取层加速提案 D）：overlay 每次被替换自增。与 store revision
// 一起构成 getPortraitDataRevision 令牌，portrait-system 据此缓存反序列化结果。
let _wbPortraitOverlayCounter = 0;

/**
 * portrait 读数据失效令牌（读取层加速提案 D）：任何改变「portrait 读值来源」的转移
 * 都会改变令牌——写入（overlay 计数）/落盘清 overlay（ov→st 段变化）/绕过 write-behind
 * 的 store 直写（storage-global-manager 导入；revision 恒参与）/切卡（chatKey 参与）。
 * portrait-system 以此为 key 缓存 readAllPortraits 反序列化结果。
 */
export function getPortraitDataRevision(): string {
  const storeRev = _bundle ? String(_bundle.portraits.revision?.() ?? 'n/a') : 'none';
  return `${_storyStorageTransitioning ? 'tr' : _configuredChatKey || 'none'}|${_wbPortraitOverlay !== null ? 'ov' + _wbPortraitOverlayCounter : 'st'}|${storeRev}`;
}

/**
 * O6 journal 读值代际令牌：聊天键 + 协调器 dataToken（两域 revision + pending 变异序号）。
 * 供投影签名闸门（技能/日历）零成本判断「story 特性读值是否可能变过」——
 * 令牌不变 ⇒ readStoryFeature 结果必然不变，可安全跳过派发。未就绪返回 'none'。
 */
export function getStoryJournalDataToken(): string {
  if (!_coordinator) return 'none';
  return `${_storyStorageTransitioning ? 'tr' : _configuredChatKey || 'none'}|${_coordinator.dataToken()}`;
}

/** 测试钩子：设置防抖延时（ms），返回旧值。生产默认 300ms。 */
export function _setStoryWriteBehindDebounceMs(ms: number): number {
  const prev = _wbDelayMs;
  _wbDelayMs = Math.max(0, Math.floor(ms));
  _coordinator?.setDebounceMs(_wbDelayMs);
  return prev;
}

/** 重置全部 write-behind 状态（聊天切换 / 重配置时）。未落盘的乐观写放弃（接受的短窗口增量丢失）。 */
function _resetWriteBehind(): void {
  if (_wbTimer) { clearTimeout(_wbTimer); _wbTimer = null; }
  _wbPortraitOverlay = null;
  _wbPortraitDirty = false;
  _coordinator = null;
  const stale = _wbResolvers; _wbResolvers = [];
  for (const r of stale) r(false);
}

function _wbReadJournalAll(): Record<string, unknown> {
  return _coordinator ? _coordinator.readAll() : {};
}
function _wbReadJournalKey<T>(key: string, fallback: T): T {
  return _coordinator ? _coordinator.read<T>(key, fallback) : cloneJson(fallback);
}
function _wbHasJournalKey(key: string): boolean {
  return _coordinator ? Object.prototype.hasOwnProperty.call(_coordinator.readAll(), key) : false;
}
function _wbReadPortraitAll(): Record<string, unknown> {
  if (_wbPortraitOverlay !== null) return cloneJson(_wbPortraitOverlay);
  return _bundle ? _bundle.portraits.readAll() : {};
}

/** 应用一次 portrait 域写：同步改 overlay（即时读）+ 防抖，返回在 flush 落盘后 settle 的 Promise。 */
function _wbApply(updates: Record<string, unknown>, deletes: string[]): Promise<boolean> {
  const portraitValue = updates[PORTRAIT_FEATURE_KEY];
  if (portraitValue !== undefined) {
    _wbPortraitOverlay = cloneJson(portraitValue as Record<string, unknown>);
    _wbPortraitOverlayCounter += 1;
    _wbPortraitDirty = true;
  } else if (deletes && deletes.includes(PORTRAIT_FEATURE_KEY)) {
    _wbPortraitOverlay = {};
    _wbPortraitOverlayCounter += 1;
    _wbPortraitDirty = true;
  }

  const p = new Promise<boolean>(resolve => _wbResolvers.push(resolve));
  if (_wbTimer) clearTimeout(_wbTimer);
  _wbTimer = setTimeout(() => { _wbTimer = null; void _wbRunFlush(); }, _wbDelayMs);
  // 渲染跟着缓存走（用户体感仅取决于内存速度）：缓存已变立即通知状态栏重渲染，不等后端落盘。
  // 与 ub-story-state-invalidated 解耦：后者仍只在 flush 后跑（驱动 cycle/日历/衣柜派生投影）。
  // render() 自带 _renderPending + rAF 合并，连点 N 次只渲染一次。
  emitUbEvent(UB_EVENT.storyCacheChanged);
  return p;
}

async function _wbWritePortraitWithRetry(portraits: ReturnType<typeof createPortraitPersistentStore> | null, value: Record<string, unknown>): Promise<boolean> {
  if (!portraits) return false;
  for (let attempt = 1; attempt <= STORY_WRITE_BEHIND_MAX_RETRIES; attempt++) {
    if (await portraits.replaceAll(value)) return true;
    try { await portraits.sync(); } catch (_e) { /* ignore */ }
    if (attempt < STORY_WRITE_BEHIND_MAX_RETRIES) await new Promise<void>(r => setTimeout(r, 50 * attempt));
  }
  return false;
}

/**
 * 防抖到点触发：快照待写 → 清空 pending（供下次 batch）→ 串行落盘 → 清理 overlay → 通知 + resolve。
 * 快照必须在任何 await 之前同步完成（含 store 引用捕获）：
 * 切卡路径（beginStoryStorageTransition）在 _resetWriteBehind 清空 pending / 置空 _bundle 之前
 * 同步触发本函数，若像旧版在 `await prev` 之后才快照，就会读到已被清空的批次与空 _bundle，
 * 整段游玩期的乐观写在此被丢弃（外部存储 READ 现仅在切卡发生、无重读兜底 → 数据永久丢失）。
 */
async function _wbRunFlush(): Promise<void> {
  const portraits = _bundle?.portraits ?? null;
  const portraitOverlay = _wbPortraitDirty ? _wbPortraitOverlay : null;
  if (_wbPortraitDirty) _wbPortraitDirty = false;
  const resolvers = _wbResolvers; _wbResolvers = [];

  // 串行化：多个 flush（如 _wbFlushNow 与到点 timer 并发）排队执行。
  const prev = _wbFlushChain;
  let release!: () => void;
  _wbFlushChain = new Promise<void>(r => { release = r; });
  await prev;
  try {
    let ok = true;
    if (portraitOverlay !== null) {
      ok = await _wbWritePortraitWithRetry(portraits, portraitOverlay) && ok;
    }

    // overlay 清理：成功且未被（flush 期间）再次改写 → 清除（读回落 portraits 真值）。
    if (portraitOverlay !== null && (!ok || !_wbPortraitDirty)) _wbPortraitOverlay = null;

    // 通知状态栏重渲染：成功=读缓存已更新的值；失败=读 V3 乐观保留值。
    emitUbEvent(UB_EVENT.storyStateInvalidated);
    for (const r of resolvers) r(ok);
  } finally {
    release();
  }
}

/** 立即排空防抖（卸载 / 迁移 / 导出前调用）：清掉到点 timer 立即 flush，并等待整条 flush 链。 */
async function _wbFlushNow(): Promise<void> {
  if (_wbTimer) { clearTimeout(_wbTimer); _wbTimer = null; void _wbRunFlush(); }
  await _wbFlushChain;
}

/** 读取当前配置的 V2 bundle（供 restore / 备份等多模块使用），未配置返回 null。 */
export function getStoryBundle(): ExternalStoreBundle | null {
  return _bundle;
}

/**
 * 由存储启动器显式切换。数据载体必须是 bundle（journal facade + portraits + domains）。
 */
export function configureStoryStorage(
  externalStore: ExternalStoreBundle | null,
  chatKey = getCurrentStoryChatKey(),
): void {
  _resetWriteBehind();
  _bundle = externalStore ?? null;
  _configuredChatKey = chatKey;
  _storyStorageTransitioning = false;
  _storyDeletionBlocked = false;
  if (_bundle && chatKey) {
    // 写入绑定用「当前稳定锚点」（activeStoryAnchors 最后元素）；重放/保留用扩展集
    // activeStoryReplayAnchors（多变体消息额外含消息级锚点）——保证消息单变体→多变体
    // （重生成加 swipe）后，单变体时期写入的历史 entry 仍可重放，回退不跳过头。
    const getWriteAnchors = (): string[] => activeStoryAnchors(getSillyContext()?.chat || []);
    const getReplayAnchors = (): ReadonlySet<string> => new Set(activeStoryReplayAnchors(getSillyContext()?.chat || []));
    _coordinator = createStoryWriteCoordinator({
      storageId: chatKey,
      stores: {
        'story-core': _bundle.domains.core,
        'story-map': _bundle.domains.map,
      },
      getCurrentAnchor: () => {
        const anchors = getWriteAnchors();
        return anchors[anchors.length - 1] || null;
      },
      getActiveAnchors: getReplayAnchors,
      now: Date.now,
      debounceMs: _wbDelayMs,
    });
    if (hasStoryDeletionRetry(chatKey)) {
      _storyDeletionBlocked = true;
      const coordinator = _coordinator;
      const domains = _bundle.domains;
      void runStoryDeletionTransaction({
        storageId: chatKey,
        coordinator,
        stores: domains,
        survivingAnchors: getCurrentActiveStoryAnchors(),
        invalidate: dispatchStoryInvalidated,
        mapGc: _mapDeletionGc,
      }).then(result => {
        _storyDeletionBlocked = !result.ok;
      });
    }
  }
}

/** Task 4 installs reference-aware map image GC here; default is intentionally no-op. */
export function configureStoryMapDeletionGc(callback: (candidates: string[]) => void | Promise<void>): void {
  _mapDeletionGc = callback;
}

/** 聊天切换开始时立即隔离上一聊天的 store，防止异步加载窗口内串读/串写。 */
export async function beginStoryStorageTransition(_storageId: string): Promise<void> {
  // 切换前排空防抖待写批次：必须先于 _resetWriteBehind / _bundle=null 同步快照
  // （_wbFlushNow → _wbRunFlush 在首个 await 前同步快照批次与 store 引用），否则批次被清空、
  // _bundle 置 null 后 flush 读到空批次 + 空 store = 整段游玩数据丢弃。单设备前提
  // （2026-08-10 起外部存储 READ 只在切卡发生、无 focus/visibilitychange 重读兜底）下内存
  // overlay 是唯一未落盘来源，丢弃批次 = 经期/日历/商店等重新冷启动。
  // 仅在有待写批次时才触发（_wbTimer 与批次同生共死）：避免每次切卡都空跑一次 flush、
  // 派发多余的 ub-story-state-invalidated 触发重复投影。
  _storyStorageTransitioning = true;
  _storyDeletionBlocked = true;
  _configuredChatKey = '';
  await _coordinator?.flush();
  if (_wbTimer || _wbPortraitDirty) {
    await _wbFlushNow();
  } else {
    await _wbFlushChain;
  }
  _bundle = null;
  _resetWriteBehind();
}

/** 只有已配置的存储与当前（或指定）聊天完全匹配时，剧情业务才可读写。 */
export function isStoryStorageReady(chatKey = getCurrentStoryChatKey()): boolean {
  if (_storyStorageTransitioning || !chatKey || _configuredChatKey !== chatKey) {
    return false;
  }
  return !!_bundle;
}

export type StoryWriteBlockReason = 'ready' | 'not-ready' | 'deletion-blocked' | 'no-coordinator';

/** 剧情写入当前为什么会被拒（供地图合并/整理等需要明确失败原因的功能做诊断）。 */
export function getStoryWriteBlockReason(): StoryWriteBlockReason {
  if (_storyDeletionBlocked) return 'deletion-blocked';
  if (!isStoryStorageReady()) return 'not-ready';
  if (!_coordinator) return 'no-coordinator';
  return 'ready';
}

/** 最近一次剧情写入落盘失败的原因；没有失败返回空串。 */
export function getStoryWriteLastError(): string {
  return _coordinator?.lastError() || '';
}

/** 存储楼层诊断（设置面板存储页显示用）：当前楼层/压缩阈值/删除当前楼层后的回退点。未就绪返回 null 楼层。 */
export function getStoryFloorDiagnostics(): StoryFloorDiagnostics {
  if (!isStoryStorageReady() || !_bundle) {
    return { currentFloor: null, retainedLayers: MAX_RETAINED_LAYERS, lastSavedFloor: null, hasFoldedBaseline: false };
  }
  const chat = getSillyContext()?.chat;
  if (!Array.isArray(chat)) {
    return { currentFloor: null, retainedLayers: MAX_RETAINED_LAYERS, lastSavedFloor: null, hasFoldedBaseline: false };
  }
  return computeStoryFloorDiagnostics(
    chat,
    _bundle.domains.core.exportJournal(),
    _bundle.domains.map.exportJournal(),
  );
}

export async function flushStoryStorage(): Promise<void> {
  if (!isStoryStorageReady() || !_bundle) return;
  await Promise.all([_coordinator?.flush(), _wbFlushNow()]);
  await _bundle.portraits.flush();
}

/** Blocks turn mutations while an explicit multi-domain operation is running. */
export async function runStoryStorageBarrier<T>(operation: () => Promise<T>): Promise<T> {
  if (!isStoryStorageReady() || !_bundle) return operation();
  _storyDeletionBlocked = true;
  _coordinator?.setBarrier(true);
  try {
    await Promise.all([_coordinator?.flush(), _wbFlushNow()]);
    return await operation();
  } finally {
    _coordinator?.setBarrier(false);
    _storyDeletionBlocked = false;
  }
}

/** 同步读取当前聊天的某项故事状态。返回深拷贝，调用方可安全修改。 */
export function readStoryFeature<T>(key: string, fallback: T): T {
  if (!isStoryStorageReady()) return cloneJson(fallback);
  if (key === PORTRAIT_FEATURE_KEY) return cloneJson(_wbReadPortraitAll()) as T;
  return _wbReadJournalKey<T>(key, fallback);
}

/**
 * 批量同步读取多个 story 特性（读取层加速提案 C）：单次合并视图 + 逐存在键深拷贝，
 * 消灭「逐键 readStoryFeature = 逐次全量重放」的读放大（N 键 1 次重放）。
 * 语义对齐逐键读：仅存在的键出现在返回对象（缺席键调用方按 fallback 语义处理）；
 * portrait 键恒返回整库对象（与单读一致）；未就绪返回 {}。
 */
export function readStoryFeaturesBatch(keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const wanted = (keys || []).filter(key => typeof key === 'string' && key);
  if (!wanted.length || !isStoryStorageReady()) return out;
  const journalKeys = wanted.filter(key => key !== PORTRAIT_FEATURE_KEY);
  if (journalKeys.length && _coordinator) {
    Object.assign(out, _coordinator.readMany(journalKeys));
  }
  if (wanted.includes(PORTRAIT_FEATURE_KEY)) {
    out[PORTRAIT_FEATURE_KEY] = cloneJson(_wbReadPortraitAll());
  }
  return out;
}

export function hasStoryFeature(key: string): boolean {
  if (!isStoryStorageReady()) return false;
  if (key === PORTRAIT_FEATURE_KEY) return Object.keys(_wbReadPortraitAll()).length > 0;
  return _wbHasJournalKey(key);
}

/** 写入完整特性值。 */
export async function writeStoryFeature(key: string, value: unknown): Promise<boolean> {
  if (!isStoryStorageReady()) return false;
  return await writeStoryFeatures({ [key]: value }, []);
}

/** 多特性原子写入（write-behind：同步改乐观 overlay + 防抖合并落盘）。 */
export async function writeStoryFeatures(
  updates: Record<string, unknown>,
  deletes: string[] = [],
): Promise<boolean> {
  const touchesCycle = Object.prototype.hasOwnProperty.call(updates || {}, 'cycle');
  if (!isStoryStorageReady() || _storyDeletionBlocked) {
    // 诊断（临时）：顶层门禁会静默吞掉 cycle 清空写入（本 bug 直接嫌疑）。
    if (touchesCycle) traceCycleDiagnostic('story-write-blocked', { reason: _storyDeletionBlocked ? 'deletion-blocked' : 'storage-not-ready', ready: isStoryStorageReady() });
    return false;
  }
  const coordinator = _coordinator;
  if (!coordinator) return false; // 构造不变式：ready ⇒ coordinator 已随 bundle 一起配置
  const restUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (key !== PORTRAIT_FEATURE_KEY) restUpdates[key] = value;
  }
  const restDeletes = deletes.filter(key => key !== PORTRAIT_FEATURE_KEY);
  const touchesPortrait = Object.prototype.hasOwnProperty.call(updates, PORTRAIT_FEATURE_KEY)
    || deletes.includes(PORTRAIT_FEATURE_KEY);
  const writes: Promise<boolean>[] = [];
  if (Object.keys(restUpdates).length || restDeletes.length) {
    writes.push(coordinator.write(restUpdates, restDeletes));
  }
  if (touchesPortrait) {
    const portraitUpdates = Object.prototype.hasOwnProperty.call(updates, PORTRAIT_FEATURE_KEY)
      ? { [PORTRAIT_FEATURE_KEY]: updates[PORTRAIT_FEATURE_KEY] }
      : {};
    const portraitDeletes = deletes.includes(PORTRAIT_FEATURE_KEY) ? [PORTRAIT_FEATURE_KEY] : [];
    writes.push(_wbApply(portraitUpdates, portraitDeletes));
  } else if (writes.length) {
    emitUbEvent(UB_EVENT.storyCacheChanged);
  }
  if (!writes.length) return true;
  return (await Promise.all(writes)).every(Boolean);
}

/** 删除某项故事状态。 */
export async function deleteStoryFeature(key: string): Promise<boolean> {
  if (!isStoryStorageReady()) return false;
  return await writeStoryFeatures({}, [key]);
}

/** 返回当前聊天全部特性的深拷贝（journal 重放态 + portrait 键）。 */
export function exportStoryFeatures(): Record<string, unknown> {
  if (!isStoryStorageReady()) return {};
  return { ..._wbReadJournalAll(), [PORTRAIT_FEATURE_KEY]: _wbReadPortraitAll() };
}

// ===== 稳定身份链 =====
function getSillyContext(): any {
  const candidates: any[] = [];
  try { candidates.push((window as any).SillyTavern); } catch (_e) { /* ignore */ }
  try { candidates.push((window.parent as any).SillyTavern); } catch (_e) { /* cross-origin */ }
  try { candidates.push((window as any).TavernHelper?.SillyTavern); } catch (_e) { /* ignore */ }
  try { candidates.push((window.parent as any).TavernHelper?.SillyTavern); } catch (_e) { /* cross-origin */ }
  for (const st of candidates) {
    if (!st) continue;
    try {
      const ctx = typeof st.getContext === 'function' ? st.getContext() : st;
      if (ctx && Array.isArray(ctx.chat)) return ctx;
    } catch (_e) { /* try next */ }
  }
  return null;
}

/**
 * 聊天稳定身份：`avatar→name→characterId` 兜底链。
 * avatar（头像文件名）是 SillyTavern 官方的角色唯一标识，角色改名/重排/增删不变，
 * 避免 characterId（动态角色索引）漂移导致 chatKey 变、外部存储文件关联丢失。
 * 关键：取不到 avatar/name 时必须回退到 rawId（characterId）而非 chatId——
 * 否则真实酒馆（characterId 是数字索引）会派生出 `chatId::chatId`，与旧键
 * `characterId::chatId` 完全不匹配，旧数据全读不到。群聊用 groupId。
 */
function deriveStableChatIdentity(ctx: any): string | null {
  const chatId = String(ctx.chatId ?? '');
  if (!chatId || chatId.startsWith('unknown-')) return null;

  const characterId = ctx.characterId;
  const isGroup = characterId === null || characterId === undefined || characterId === '' || Number.isNaN(characterId);
  if (isGroup) {
    const groupId = String(ctx.groupId ?? '');
    if (!groupId || groupId.startsWith('unknown-')) return null;
    return `group:${groupId}`;
  }

  const rawId = String(characterId);
  if (rawId.startsWith('unknown-')) return null;

  let char: any = null;
  const idx = Number(characterId);
  if (Array.isArray(ctx.characters) && Number.isInteger(idx) && idx >= 0 && idx < ctx.characters.length) {
    char = ctx.characters[idx];
  }
  // 取到稳定身份用稳定身份；取不到回退 rawId（characterId）——保持 `characterId::chatId` 旧键兼容。
  return char?.avatar || char?.name || rawId;
}

/** 当前角色卡（群聊=群组）作用域键：avatar → name → characterId（群聊 `group:<id>`）。
 *  与聊天稳定身份同源——同一张卡换聊天/换存档不换键；欢迎页/异常上下文返回 ''。 */
export function getCurrentCardScopeKey(): string {
  const ctx = getSillyContext();
  if (!ctx) return '';
  return deriveStableChatIdentity(ctx) ?? '';
}

/** 当前是否真的载入了角色卡（而非欢迎页/异常上下文）。
 *  以 deriveStableChatIdentity 是否得到稳定身份为准——欢迎页/异常上下文取不到稳定身份。 */
export function hasRealCharacterContext(): boolean {
  return getCurrentCardScopeKey() !== '';
}

/** 当前已确认的 UUID 存储标识；身份未确认或切换中时为空。 */
export function getCurrentStoryStorageId(): string {
  return _storyStorageTransitioning ? '' : _configuredChatKey;
}

/** 兼容旧调用名；V3 起返回 storageId，不再派生 avatar/chatId 键。 */
export function getCurrentStoryChatKey(): string {
  return getCurrentStoryStorageId();
}

/** 聊天归属守卫（统一入口）：发起时捕获，写聊天级存储前核对。
 *  语义与零开销纪律见 core/chat-scope.ts；此处只注入主项目的聊天身份来源。 */
export function captureChatScope(label = ''): ChatScope {
  return createChatScope(getCurrentStoryChatKey, label);
}

/**
 * 决策弹窗 contextKey 存活校验（供 system decision isValid 使用）。
 * 直读 `getCurrentStoryChatKey() === contextKey` 有一个致命窗口：CHAT_CHANGED 不只发生在
 * 真实切卡——正则重放/楼层全量重载等也会触发，存储启动器随之 beginStoryStorageTransition
 * → key 暂时为空。此窗口内每 300ms 的 flushSystemDecisionQueue 会把「世界动态·入镜」这类
 * 一次性决策弹窗永久丢弃（演化已完成、幕后进度已消耗，不再有再入队路径）。
 * 语义：转发期（key 暂空）视为仍存活，等新 key 落定后按是否同一聊天判定——
 * 同聊天重初始化 → 存活；真实切卡/欢迎页 → 落定后 key 不一致 → 照常失效。
 */
export function isStoryContextKeyValid(contextKey: string): boolean {
  if (!contextKey) return false;
  if (_storyStorageTransitioning) return true;
  return getCurrentStoryStorageId() === contextKey;
}

function getCurrentActiveStoryAnchors(): ReadonlySet<string> {
  // 删除事务按存活锚点裁剪 entry：存活集必须覆盖「读取重放能识别的全部锚点」。
  // allRetainedAnchors 枚举每条存活消息所有变体的 stable+fallback 锚点——
  // 绑定在 fallback 锚点（消息身份补全前写入）或非选中变体上的 entry 仍属于
  // 幸存消息，若用窄集（activeStoryReplayAnchors）裁剪会被误判为孤儿物理删除，
  // 回退越过幸存楼层（已生成记录丢失 → 冷启动/重弹事后窗）。
  return new Set(allRetainedAnchors(getSillyContext()?.chat || []));
}

function dispatchStoryInvalidated(): void {
  emitUbEvent(UB_EVENT.storyStateInvalidated);
}

async function handleStoryMessageDeleted(): Promise<void> {
  if (!_bundle) {
    dispatchStoryInvalidated();
    return;
  }
  if (!_coordinator || !_configuredChatKey) {
    dispatchStoryInvalidated();
    return;
  }

  _storyDeletionBlocked = true;
  const result = await runStoryDeletionTransaction({
    storageId: _configuredChatKey,
    coordinator: _coordinator,
    stores: _bundle.domains,
    survivingAnchors: getCurrentActiveStoryAnchors(),
    invalidate: dispatchStoryInvalidated,
    mapGc: _mapDeletionGc,
  });
  _storyDeletionBlocked = !result.ok;
}

/** 删除与聊天切换的存储事件；swipe 明确不参与外部存储回滚。 */
export function initStoryFloorStore(): void {
  // F4：window 令牌——模块重求值后旧闭包仍挂在宿主 eventSource 上，模块布尔挡不住第二份注册
  const w = window as any;
  if (w.__ub_story_floor_events_bound) return;
  const ctx = getSillyContext();
  const source = ctx?.eventSource;
  if (!source || typeof source.on !== 'function') return;
  w.__ub_story_floor_events_bound = true;
  const types = ctx?.eventTypes || {};
  // SillyTavern's EventEmitter awaits each listener Promise, and its core
  // MESSAGE_DELETED call sites await emit(). This returned Promise is the
  // deletion/regeneration barrier.
  source.on(types.MESSAGE_DELETED || 'message_deleted', handleStoryMessageDeleted);
  // CHAT_CHANGED：不在这里处理。故事存储的 transition + 重新初始化由
  // storage-bootstrap 的 CHAT_CHANGED 处理器统一负责（它会 beginStoryStorageTransition
  // 后紧跟 initializeStatusbarStorage 重新配置）。bootstrap 先于本模块注册监听器，
  // emit 按注册顺序 await：若此处再置 _storyDeletionBlocked=true，会在 bootstrap
  // 复位之后执行，把复位值改回 true → 所有 story 写入被永久短路（外部存储面板仍显示
  // 正常，因为该标志不属于 store status）。切卡挡写入已由 beginStoryStorageTransition
  // 覆盖，此处不再置位。
}
