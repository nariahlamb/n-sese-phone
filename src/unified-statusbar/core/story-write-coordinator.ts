import { isRecord } from './type-guards';
import { type RecoveryStorage, defaultRecoveryStorage, parseRecoveryEnvelope, persistRecoveryEnvelope, recoveryEnvelopeJson } from './recovery-log';
import type { AtomicCommitResult } from './atomic-envelope-store';
import { cloneJson } from './external-storage-codec';
import { traceCycleDiagnostic } from './cycle-diagnostics';
import {
  splitStoryFeaturePatch,
  type StoryDomain,
  type StoryDomainAppendTarget,
} from './story-domain-router';

export const STORY_WRITE_RECOVERY_KEY = 'unified-statusbar:pending:v3';
const RECOVERY_SCHEMA = 3;
const MAX_RECOVERY_RECORDS = 100;
const MAX_RECOVERY_BYTES = 512 * 1024;

export interface StoryMutationIdentity {
  storageId: string;
  domain: StoryDomain;
  anchor: string;
}

export interface StoryMutation extends StoryMutationIdentity {
  id: string;
  updates: Record<string, unknown>;
  deletes: string[];
  createdAt: number;
}

// U36：RecoveryStorage 接口与信封读写收编 core/recovery-log（原三份逐字重复的接口定义随之退役）

interface PendingBatch extends StoryMutation {
  waiters: Array<(value: boolean) => void>;
}

export interface StoryWriteCoordinatorDeps {
  storageId: string;
  stores: Record<StoryDomain, StoryDomainAppendTarget & {
    replay(): Record<string, unknown>;
    flush(): Promise<void>;
    /** 可选：journal 内容代数（story-domain-store 提供）。两域都暴露时启用 replay 合并快照缓存。 */
    revision?(): number;
  }>;
  getCurrentAnchor: () => string | null | undefined;
  getActiveAnchors: () => ReadonlySet<string>;
  now: () => number;
  debounceMs?: number;
  recoveryStorage?: RecoveryStorage;
}

export interface StoryWriteCoordinator {
  write(updates: Record<string, unknown>, deletes?: string[]): Promise<boolean>;
  read<T>(key: string, fallback: T): T;
  /** 批量单键读：单次合并视图，逐存在键深拷贝返回（与逐键 read 值语义一致）。 */
  readMany(keys: string[]): Record<string, unknown>;
  readAll(): Record<string, unknown>;
  /** 合并视图（replay 合并 + 活跃 pending）：返回对象的嵌套值与内部缓存共享，调用方只读。 */
  peekAll(): Record<string, unknown>;
  flush(): Promise<void>;
  setDebounceMs(delayMs: number): void;
  setBarrier(active: boolean): void;
  cancelDeleted(survivingAnchors: ReadonlySet<string>): void;
  pendingCount(): number;
  /** 最近一次落盘失败的原因（供调用方把“写入被拒”转成可读诊断）。 */
  lastError(): string | null;
  /** O6 读值代际令牌：两域 revision + pending 变异序号。变化 ⇒ journal 读值可能变过；不变 ⇒ 必然没变。 */
  dataToken(): string;
}

function isDomain(value: unknown): value is StoryDomain {
  return value === 'story-core' || value === 'story-map';
}

function isMutation(value: unknown): value is StoryMutation {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.storageId === 'string'
    && isDomain(value.domain)
    && typeof value.anchor === 'string'
    && value.anchor.length > 0
    && isRecord(value.updates)
    && Array.isArray(value.deletes)
    && value.deletes.every(key => typeof key === 'string')
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt);
}

function parseRecovery(storage?: RecoveryStorage): StoryMutation[] {
  if (!storage) return [];
  // U36：信封解析收编（isMutation 校验/裁剪/克隆是本模块专属口径，保留在调用方）
  const records = parseRecoveryEnvelope<unknown>(storage.getItem(STORY_WRITE_RECOVERY_KEY), RECOVERY_SCHEMA);
  return records ? records.filter(isMutation).slice(0, MAX_RECOVERY_RECORDS).map(cloneJson) : [];
}

export function canMergeStoryMutations(
  left: StoryMutationIdentity,
  right: StoryMutationIdentity,
): boolean {
  return left.storageId === right.storageId
    && left.domain === right.domain
    && left.anchor === right.anchor;
}

function mergePatch(
  target: Pick<StoryMutation, 'updates' | 'deletes'>,
  updates: Record<string, unknown>,
  deletes: readonly string[],
): void {
  const deleted = new Set(target.deletes);
  for (const [key, value] of Object.entries(updates)) {
    target.updates[key] = cloneJson(value);
    deleted.delete(key);
  }
  for (const key of deletes) {
    delete target.updates[key];
    deleted.add(key);
  }
  target.deletes = [...deleted];
}

function applyPatch(
  value: Record<string, unknown>,
  mutation: Pick<StoryMutation, 'updates' | 'deletes'>,
): void {
  for (const [key, next] of Object.entries(mutation.updates)) value[key] = cloneJson(next);
  for (const key of mutation.deletes) delete value[key];
}


function confirmed(result: AtomicCommitResult): boolean {
  return result.ok && result.confirmed;
}

export function createStoryWriteCoordinator(deps: StoryWriteCoordinatorDeps): StoryWriteCoordinator {
  const recoveryStorage = deps.recoveryStorage || defaultRecoveryStorage();
  const recovered = parseRecovery(recoveryStorage);
  const foreignRecords = recovered.filter(record => record.storageId !== deps.storageId);
  const activeAtStart = deps.getActiveAnchors();
  const pending: PendingBatch[] = recovered
    .filter(record => record.storageId === deps.storageId && activeAtStart.has(record.anchor))
    .map(record => ({ ...cloneJson(record), waiters: [] }));
  let debounceMs = Math.max(0, Number(deps.debounceMs) || 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let barrier = false;
  let lastWriteError: string | null = null;
  let flushChain: Promise<void> = Promise.resolve();
  let idSequence = 0;
  // O6 读值代际：pending 的任何内容变异自增（push/merge/remove）。与两域 revision 一起
  // 构成 dataToken——签名闸门（技能/日历投影）据此零成本判断「journal 读值是否可能变过」。
  let pendingSeq = 0;

  function ownedRecords(source: PendingBatch[] = pending): StoryMutation[] {
    return source.map(({ waiters: _waiters, ...record }) => cloneJson(record));
  }

  function persistRecovery(source: PendingBatch[] = pending): boolean {
    if (!recoveryStorage) return true; // 无存储=降级成功（本模块原语义，与 recovery-log 缺省 false 不同）
    // U36：信封写入收编（空删/超限拒写/失败当假三步逐字等价）
    return persistRecoveryEnvelope(recoveryStorage, STORY_WRITE_RECOVERY_KEY, [...foreignRecords, ...ownedRecords(source)], {
      schema: RECOVERY_SCHEMA, maxBytes: MAX_RECOVERY_BYTES, maxRecords: MAX_RECOVERY_RECORDS,
    });
  }

  // Discard recovery entries from branches that no longer exist, without
  // disturbing records owned by another chat.
  persistRecovery();

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function scheduleFlush(): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, debounceMs);
    // 成员名勿用裸 unref：类型位置的字面也会被 unplugin-auto-import 误注入 import {unref} from 'vue'
    const nodeTimer = timer as ReturnType<typeof setTimeout> & { unrefTimer?: () => void };
    nodeTimer.unrefTimer?.();
  }

  function resolveWaiters(batch: PendingBatch, value: boolean): void {
    const waiters = batch.waiters.splice(0);
    for (const resolve of waiters) resolve(value);
  }

  function removeBatch(batch: PendingBatch): void {
    const index = pending.indexOf(batch);
    if (index >= 0) {
      pending.splice(index, 1);
      pendingSeq += 1;
    }
  }

  async function flushOnce(): Promise<void> {
    const snapshot = [...pending];
    for (const batch of snapshot) {
      if (!pending.includes(batch)) continue;
      let result: AtomicCommitResult;
      try {
        result = await deps.stores[batch.domain].append(
          batch.anchor,
          cloneJson(batch.updates),
          [...batch.deletes],
        );
      } catch (error) {
        result = {
          ok: false,
          confirmed: false,
          retryable: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (confirmed(result)) {
        removeBatch(batch);
        resolveWaiters(batch, true);
      } else if (result.retryable) {
        lastWriteError = result.error || '写入未确认（可稍后重试）';
        resolveWaiters(batch, false);
      } else {
        lastWriteError = result.error || '写入被存储拒绝';
        removeBatch(batch);
        resolveWaiters(batch, false);
      }
      persistRecovery();
    }
    await Promise.all([deps.stores['story-core'].flush(), deps.stores['story-map'].flush()]);
  }

  function flush(): Promise<void> {
    clearTimer();
    const run = flushChain.then(flushOnce, flushOnce);
    flushChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ===== 读取快照缓存（读取层加速提案 B，2026-09-15）=====
  // 缓存「双域 replay 合并结果」，以两域 revision 为失效信号——append/replace/restore/
  // 首次装载都会自增（story-domain-store 四个 journal 赋值点），任何绕过本协调器的
  // journal 变异都经 revision 可见。pending 补丁**不进缓存**：逐次应用，活跃锚点过滤
  // 语义与无缓存实现逐字节一致。缓存对象只在模块内部持有，出参一律经浅拷贝/深拷贝隔离。
  let snapshotCache: { coreRev: number; mapRev: number; merged: Record<string, unknown> } | null = null;

  function domainRevision(domain: StoryDomain): number | null {
    const store = deps.stores[domain] as { revision?: () => number };
    if (typeof store?.revision !== 'function') return null;
    try {
      const value = store.revision();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** 双域 replay 合并结果（带缓存）。返回对象由缓存持有，调用方必须克隆或只读。 */
  function mergedSnapshot(): Record<string, unknown> {
    const coreRev = domainRevision('story-core');
    const mapRev = domainRevision('story-map');
    if (coreRev !== null && mapRev !== null && snapshotCache
      && snapshotCache.coreRev === coreRev && snapshotCache.mapRev === mapRev) {
      return snapshotCache.merged;
    }
    const merged = {
      ...deps.stores['story-core'].replay(),
      ...deps.stores['story-map'].replay(),
    };
    if (coreRev !== null && mapRev !== null) snapshotCache = { coreRev, mapRev, merged };
    return merged;
  }

  /** 共享视图（只读约定）：merged 浅拷贝 + 逐 pending 应用。嵌套值与缓存共享。 */
  function currentValueShared(): Record<string, unknown> {
    const active = deps.getActiveAnchors();
    const value = { ...mergedSnapshot() };
    for (const batch of pending) {
      if (active.has(batch.anchor)) applyPatch(value, batch);
    }
    return value;
  }

  function currentValue(): Record<string, unknown> {
    const active = deps.getActiveAnchors();
    // readAll 契约：全量深拷贝（exportStoryFeatures 等调用方可安全修改）。
    // 一律 cloneJson(merged)：快照对象（无论新建还是缓存命中）都在缓存内持有，
    // 直接外泄本体会让调用方改写腐蚀缓存（测试锁定）。
    const value = cloneJson(mergedSnapshot());
    for (const batch of pending) {
      if (active.has(batch.anchor)) applyPatch(value, batch);
    }
    return value;
  }

  return {
    write(updates, deletes = []): Promise<boolean> {
      // 诊断（临时）：仅关注 story-core 里带 cycle 键的写入，记录被门禁丢弃的原因。
      const touchesCycle = isRecord(updates) && Object.prototype.hasOwnProperty.call(updates, 'cycle');
      if (barrier) {
        lastWriteError = '写入被屏障拦截（正在执行存储操作）';
        if (touchesCycle) traceCycleDiagnostic('coordinator-write-drop', { reason: 'barrier', anchor: String(deps.getCurrentAnchor() || '') || null });
        return Promise.resolve(false);
      }
      const anchor = String(deps.getCurrentAnchor() || '');
      if (!anchor || !deps.getActiveAnchors().has(anchor)) {
        lastWriteError = anchor ? '当前楼层锚点无效（可能正在切换聊天）' : '当前没有可用楼层锚点';
        if (touchesCycle) traceCycleDiagnostic('coordinator-write-drop', { reason: anchor ? 'anchor-inactive' : 'no-anchor', anchor: anchor || null });
        return Promise.resolve(false);
      }
      const split = splitStoryFeaturePatch(cloneJson(updates || {}), [...deletes]);
      const patches = (['story-core', 'story-map'] as const)
        .filter(domain => Object.keys(split[domain].updates).length || split[domain].deletes.length);
      if (!patches.length) return Promise.resolve(true);

      const prospective = pending.map(batch => ({ ...batch, updates: cloneJson(batch.updates), deletes: [...batch.deletes] }));
      for (const domain of patches) {
        const existing = prospective.find(batch => canMergeStoryMutations(batch, {
          storageId: deps.storageId,
          domain,
          anchor,
        }));
        if (existing) mergePatch(existing, split[domain].updates, split[domain].deletes);
        else prospective.push({
          id: `${deps.storageId}:${deps.now()}:${++idSequence}`,
          storageId: deps.storageId,
          domain,
          anchor,
          updates: cloneJson(split[domain].updates),
          deletes: [...split[domain].deletes],
          createdAt: deps.now(),
          waiters: [],
        });
      }
      if (foreignRecords.length + prospective.length > MAX_RECOVERY_RECORDS
        || recoveryEnvelopeJson(RECOVERY_SCHEMA, [...foreignRecords, ...ownedRecords(prospective)]).length > MAX_RECOVERY_BYTES) {
        lastWriteError = '写入批次过大，超出恢复日志上限';
        if (touchesCycle) traceCycleDiagnostic('coordinator-write-drop', { reason: 'recovery-limit', anchor, pendingCount: pending.length, foreignCount: foreignRecords.length });
        return Promise.resolve(false);
      }

      const waits: Promise<boolean>[] = [];
      for (const domain of patches) {
        let batch = pending.find(candidate => canMergeStoryMutations(candidate, {
          storageId: deps.storageId,
          domain,
          anchor,
        }));
        if (!batch) {
          batch = {
            id: `${deps.storageId}:${deps.now()}:${++idSequence}`,
            storageId: deps.storageId,
            domain,
            anchor,
            updates: {},
            deletes: [],
            createdAt: deps.now(),
            waiters: [],
          };
          pending.push(batch);
        }
        mergePatch(batch, split[domain].updates, split[domain].deletes);
        pendingSeq += 1;
        waits.push(new Promise(resolve => batch?.waiters.push(resolve)));
      }
      if (!persistRecovery()) {
        // The prospective bounds check passed, so this is an unavailable
        // recovery medium. Keep the in-memory mutation; durable confirmation
        // still determines the returned result.
      }
      if (touchesCycle) traceCycleDiagnostic('coordinator-write-accepted', { anchor, storageId: deps.storageId, pendingCount: pending.length });
      scheduleFlush();
      return Promise.all(waits).then(results => results.every(Boolean));
    },
    read<T>(key: string, fallback: T): T {
      // 单键读走共享视图：单键 cloneJson 后调用方拿深拷贝，整库克隆开销消失。
      const all = currentValueShared();
      return Object.prototype.hasOwnProperty.call(all, key)
        ? cloneJson(all[key] as T)
        : cloneJson(fallback);
    },
    readMany(keys: string[]): Record<string, unknown> {
      const all = currentValueShared();
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(all, key)) out[key] = cloneJson(all[key]);
      }
      return out;
    },
    readAll: currentValue,
    peekAll: currentValueShared,
    flush,
    setDebounceMs(delayMs): void {
      debounceMs = Math.max(0, Number(delayMs) || 0);
      if (pending.length) scheduleFlush();
    },
    setBarrier(active): void {
      barrier = active;
    },
    cancelDeleted(survivingAnchors): void {
      for (const batch of [...pending]) {
        if (survivingAnchors.has(batch.anchor)) continue;
        removeBatch(batch);
        resolveWaiters(batch, false);
      }
      persistRecovery();
    },
    pendingCount(): number {
      return pending.length;
    },
    lastError(): string | null {
      return lastWriteError;
    },
    dataToken(): string {
      const coreRev = domainRevision('story-core');
      const mapRev = domainRevision('story-map');
      return `${coreRev ?? 'x'}|${mapRev ?? 'x'}|${pendingSeq}`;
    },
  };
}
