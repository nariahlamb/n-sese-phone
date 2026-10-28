import { isRecord } from './type-guards';
import { type RecoveryStorage, defaultRecoveryStorage, parseRecoveryEnvelope, persistRecoveryEnvelope } from './recovery-log';
import type { AtomicCommitResult } from './atomic-envelope-store';
import { cloneJson, sha256Hex, stableStringify } from './external-storage-codec';
import type { StoryDomainJournal } from './story-domain-store';
import { collectReferencedMapImages } from './map-image-reference-gc';

export const STORY_DELETION_RECOVERY_KEY = 'unified-statusbar:deletion:v3';
const RECOVERY_SCHEMA = 3;
const MAX_RECOVERY_RECORDS = 100;
const MAX_RECOVERY_BYTES = 512 * 1024;

// U36：RecoveryStorage 与信封读写收编 core/recovery-log

interface DeletionRetryRecord {
  storageId: string;
  survivingAnchors: string[];
  coreChecksum: string;
  mapChecksum: string;
  createdAt: number;
}

interface DeletionCoordinator {
  setBarrier(active: boolean): void;
  cancelDeleted(survivingAnchors: ReadonlySet<string>): void;
  flush(): Promise<void>;
}

interface DeletionDomainStore {
  exportJournal(): StoryDomainJournal;
  replaceJournal(journal: StoryDomainJournal): Promise<AtomicCommitResult>;
}

export interface StoryDeletionTransactionDeps {
  storageId: string;
  coordinator: DeletionCoordinator;
  stores: { core: DeletionDomainStore; map: DeletionDomainStore };
  survivingAnchors: ReadonlySet<string>;
  invalidate: () => void | Promise<void>;
  mapGc: (candidates: string[]) => void | Promise<void>;
  recoveryStorage?: RecoveryStorage;
  now?: () => number;
}

export type StoryDeletionResult =
  | { ok: true; changed: boolean; warning?: string }
  | { ok: false; retryable: boolean; error: string };

function isRetryRecord(value: unknown): value is DeletionRetryRecord {
  return isRecord(value)
    && typeof value.storageId === 'string'
    && Array.isArray(value.survivingAnchors)
    && value.survivingAnchors.every(anchor => typeof anchor === 'string')
    && typeof value.coreChecksum === 'string'
    && typeof value.mapChecksum === 'string'
    && typeof value.createdAt === 'number';
}

function readRetryRecords(storage?: RecoveryStorage): DeletionRetryRecord[] {
  if (!storage) return [];
  // U36：信封解析收编（isRetryRecord 校验/裁剪/克隆保留在调用方）
  const records = parseRecoveryEnvelope<unknown>(storage.getItem(STORY_DELETION_RECOVERY_KEY), RECOVERY_SCHEMA);
  return records ? records.filter(isRetryRecord).slice(0, MAX_RECOVERY_RECORDS).map(cloneJson) : [];
}

function writeRetryRecords(storage: RecoveryStorage | undefined, records: DeletionRetryRecord[]): boolean {
  // U36：信封写入收编（空删/超限拒写/失败当假三步逐字等价）
  return persistRecoveryEnvelope(storage, STORY_DELETION_RECOVERY_KEY, records, {
    schema: RECOVERY_SCHEMA, maxBytes: MAX_RECOVERY_BYTES, maxRecords: MAX_RECOVERY_RECORDS,
  });
}

function candidateJournal(
  source: StoryDomainJournal,
  survivingAnchors: ReadonlySet<string>,
): StoryDomainJournal {
  return {
    baseline: cloneJson(source.baseline),
    entries: source.entries.filter(entry => survivingAnchors.has(entry.anchor)).map(cloneJson),
  };
}

function commitConfirmed(result: AtomicCommitResult): boolean {
  return result.ok && result.confirmed;
}

function rememberRetry(
  storage: RecoveryStorage | undefined,
  record: DeletionRetryRecord,
): void {
  const records = readRetryRecords(storage).filter(item => item.storageId !== record.storageId);
  records.push(record);
  writeRetryRecords(storage, records);
}

function clearRetry(storage: RecoveryStorage | undefined, storageId: string): void {
  const records = readRetryRecords(storage).filter(item => item.storageId !== storageId);
  writeRetryRecords(storage, records);
}

export function hasStoryDeletionRetry(
  storageId: string,
  recoveryStorage: RecoveryStorage = defaultRecoveryStorage() as RecoveryStorage,
): boolean {
  return readRetryRecords(recoveryStorage).some(record => record.storageId === storageId);
}

export async function runStoryDeletionTransaction(
  deps: StoryDeletionTransactionDeps,
): Promise<StoryDeletionResult> {
  const recoveryStorage = deps.recoveryStorage || defaultRecoveryStorage();
  deps.coordinator.setBarrier(true);
  try {
    deps.coordinator.cancelDeleted(deps.survivingAnchors);
    await deps.coordinator.flush();

    const currentCore = deps.stores.core.exportJournal();
    const currentMap = deps.stores.map.exportJournal();
    const nextCore = candidateJournal(currentCore, deps.survivingAnchors);
    const nextMap = candidateJournal(currentMap, deps.survivingAnchors);
    const coreChanged = stableStringify(currentCore) !== stableStringify(nextCore);
    const mapChanged = stableStringify(currentMap) !== stableStringify(nextMap);
    const previousMapImages = collectReferencedMapImages({ journal: currentMap });
    const survivingMapImages = collectReferencedMapImages({ journal: nextMap });
    const mapCleanupCandidates = [...previousMapImages].filter(path => !survivingMapImages.has(path));

    // 可见状态刷新由末尾 deps.invalidate() 完成（重放为全量、无锚点过滤，替换 journal 后
    // 重投影即删除后状态）；此处无内存缓存需要强制派生。

    let failedResult: AtomicCommitResult | undefined;
    if (coreChanged) {
      const result = await deps.stores.core.replaceJournal(nextCore);
      if (!commitConfirmed(result)) failedResult = result;
    }
    if (!failedResult && mapChanged) {
      const result = await deps.stores.map.replaceJournal(nextMap);
      if (!commitConfirmed(result)) failedResult = result;
    }

    await deps.invalidate();
    if (failedResult) {
      rememberRetry(recoveryStorage, {
        storageId: deps.storageId,
        survivingAnchors: [...deps.survivingAnchors],
        coreChecksum: sha256Hex(stableStringify(nextCore)),
        mapChecksum: sha256Hex(stableStringify(nextMap)),
        createdAt: (deps.now || Date.now)(),
      });
      return {
        ok: false,
        retryable: failedResult.retryable,
        error: failedResult.error || 'story-deletion-prune-unconfirmed',
      };
    }

    clearRetry(recoveryStorage, deps.storageId);
    try {
      await deps.mapGc(mapCleanupCandidates);
      return { ok: true, changed: coreChanged || mapChanged };
    } catch (error) {
      return {
        ok: true,
        changed: coreChanged || mapChanged,
        warning: `map-image-cleanup-failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deps.coordinator.setBarrier(false);
  }
}
