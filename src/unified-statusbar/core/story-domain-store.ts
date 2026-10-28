import { isRecord } from './type-guards';
import {
  createAtomicEnvelopeStore,
  type AtomicCommitResult,
  type AtomicEnvelopeStore,
} from './atomic-envelope-store';
import { chatStorageHash, type ChatOwner } from './chat-storage-identity';
import { cloneJson, stableStringify } from './external-storage-codec';
import { traceCycleDiagnostic } from './cycle-diagnostics';
import type { ExternalStoreStatus } from './external-storage-types';
import type { ServerFileStore } from './server-file-store';
import type { StoryDomain } from './story-domain-router';

export interface StoryDomainJournal extends Record<string, unknown> {
  baseline: Record<string, unknown>;
  entries: StoryDomainJournalEntry[];
}

export interface StoryDomainJournalEntry {
  anchor: string;
  revision: number;
  sets?: Record<string, unknown>;
  deletes?: string[];
}

export interface StoryDomainStoreDeps {
  files: ServerFileStore;
  storageId: string;
  domain: StoryDomain;
  owner: ChatOwner;
  domainCreated: boolean;
  hasAnchoredHistory: boolean;
  getActiveAnchors: () => ReadonlySet<string>;
  now: () => number;
  onDomainCreated: () => Promise<boolean>;
  onAnchoredHistory: () => Promise<boolean>;
}

export interface StoryDomainStore {
  load(): Promise<ExternalStoreStatus>;
  readAll(): Record<string, unknown>;
  append(
    anchor: string,
    updates: Record<string, unknown>,
    deletes: string[],
  ): Promise<AtomicCommitResult>;
  replaceJournal(journal: StoryDomainJournal): Promise<AtomicCommitResult>;
  /** Explicit transactional backup restore; bypasses normal baseline immutability. */
  restoreJournal(journal: StoryDomainJournal): Promise<AtomicCommitResult>;
  replay(): Record<string, unknown>;
  /**
   * journal 内容代数（读取层快照缓存失效信号）：journal 绑定每次变化（首次装载/
   * append 提交/replaceJournal/restoreJournal）自增。coordinator 以两域 revision 为
   * key 缓存 replay 合并结果，任何绕过 coordinator 的 journal 变异都经此可见。
   */
  revision(): number;
  exportJournal(): StoryDomainJournal;
  flush(): Promise<void>;
  status(): ExternalStoreStatus;
}

function validEntry(value: unknown): value is StoryDomainJournalEntry {
  if (!isRecord(value) || typeof value.anchor !== 'string' || !value.anchor) return false;
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) return false;
  if (value.sets !== undefined && !isRecord(value.sets)) return false;
  if (value.deletes !== undefined
    && (!Array.isArray(value.deletes) || !value.deletes.every(key => typeof key === 'string'))) return false;
  return true;
}

export function isStoryDomainJournal(value: unknown): value is StoryDomainJournal {
  return isRecord(value)
    && isRecord(value.baseline)
    && Array.isArray(value.entries)
    && value.entries.every(validEntry);
}

/**
 * 全量重放：baseline 之后按 revision 升序应用**全部** entry（后写覆盖先写），不做锚点过滤。
 *
 * 2026-08-30 语义变更（锚点漂移根治）：此前按「当前聊天活跃锚点集」过滤 entry，意在删除楼层后
 * 回退——但删除回退已由删除事务独占负责（story-deletion-transaction：survivingAnchors 物理裁剪
 * + localStorage 失败重试）。而锚点本身不稳定：SillyTavern 1.18 的 saveReply 会在 continue /
 * appendFinal / 生成新 swipe 时重写最后一条消息的 send_date（message.id/gen_id 缺失时锚点唯一
 * 身份就是 send_date），删除楼层也会让锚点消失——过滤会把刚写入的状态静默回退到 baseline
 * （实测症状：已确认的受孕形式弹窗整批重弹、孕情被重新掷骰改写）。
 * 与 readAll() 原有语义（全条目重放）一致；压缩仍按活跃锚点决定保留/丢弃（防御脚本离线时的
 * 删除回退），与本函数无关。
 */
export function replayStoryDomainJournal(
  journal: StoryDomainJournal,
): Record<string, unknown> {
  const value = cloneJson(journal.baseline || {});
  const ordered = [...(journal.entries || [])].sort((left, right) => left.revision - right.revision);
  for (const entry of ordered) {
    for (const [key, next] of Object.entries(entry.sets || {})) value[key] = cloneJson(next);
    for (const key of entry.deletes || []) delete value[key];
  }
  return value;
}

/**
 * 折叠压缩（每次 append 都跑）：保留最近 20 个活跃锚点的 entry，其余——包括锚点已失联的
 * entry（楼层身份被酒馆改写 send_date / 离线删层）——按 revision 升序折叠进 baseline（累积保留）。
 * 2026-08-30 起不再「已删锚点直接丢弃」：漂移失联 ≠ 楼层被删，丢弃会把刚写入的状态静默清掉
 * （实测弹窗重弹事故的帮凶）；删除回退由删除事务的物理裁剪独占负责，脚本离线时的外部删层
 * 属罕见边角，折叠进底账的代价（被删楼层状态固化）可接受。
 * 保证 journal 有界，同时删除/重生成最近 20 层内仍可精确回退。
 */
export const MAX_RETAINED_LAYERS = 20;

function compactStoryDomainJournal(
  journal: StoryDomainJournal,
  activeAnchors: ReadonlySet<string>,
): StoryDomainJournal | null {
  // 先纯分类（零拷贝）：无可折叠项直接 null，稳态（条目全在当前锚点窗口内）零额外开销。
  const retainedRefs: StoryDomainJournalEntry[] = [];
  const retainedAnchors = new Set<string>();
  const foldable: StoryDomainJournalEntry[] = [];
  // 从后往前保留最近 N 个活跃锚点的 entry；更早的活跃 entry 与失联锚点 entry 收集待折叠。
  for (let i = journal.entries.length - 1; i >= 0; i--) {
    const entry = journal.entries[i];
    if (activeAnchors.has(entry.anchor) && retainedAnchors.size < MAX_RETAINED_LAYERS) {
      retainedAnchors.add(entry.anchor);
      retainedRefs.push(entry);
    } else {
      // 失联锚点（漂移/离线删除）与超出保留窗口的活跃 entry → 折叠，不丢弃。
      foldable.push(entry);
    }
  }
  if (foldable.length === 0) return null;
  const baseline = cloneJson(journal.baseline || {});
  // 折叠必须按 revision 升序应用（与 replayStoryDomainJournal 一致：后写覆盖先写）。
  // 增量 append 每次只折一条时天然升序，但 restoreJournal / 删除事务注入大 journal 后
  // 单次折叠多条，直接按收集顺序（新→旧）写入会让旧值覆盖新值（数据倒退）。
  foldable.sort((left, right) => left.revision - right.revision);
  for (const entry of foldable) {
    if (entry.sets) for (const [key, value] of Object.entries(entry.sets)) baseline[key] = cloneJson(value);
    if (entry.deletes) for (const key of entry.deletes) delete baseline[key];
  }
  const ordered = retainedRefs.reverse().map(cloneJson);
  return {
    baseline,
    entries: ordered,
  };
}

function failed(error: string, retryable = false): AtomicCommitResult {
  return { ok: false, confirmed: false, retryable, error };
}

export function createStoryDomainStore(deps: StoryDomainStoreDeps): StoryDomainStore {
  const filenameDomain = deps.domain === 'story-core' ? 'core' : 'map';
  const filename = `usb_story_${filenameDomain}_${chatStorageHash(deps.storageId)}.json`;
  const emptyJournal: StoryDomainJournal = { baseline: {}, entries: [] };
  const atomic: AtomicEnvelopeStore<StoryDomainJournal> = createAtomicEnvelopeStore({
    files: deps.files,
    filename,
    kind: deps.domain,
    scopeId: deps.storageId,
    owner: deps.owner,
    domainCreated: deps.domainCreated,
    emptyValue: emptyJournal,
    now: deps.now,
    onFirstVerifiedCreate: deps.onDomainCreated,
    validateValue: isStoryDomainJournal,
  });

  let journal = cloneJson(emptyJournal);
  let loaded = false;
  // journal 内容代数：journal 绑定的四个赋值点（load/append/replace/restore）各自增，
  // 供 coordinator 读取快照缓存判失效。见接口注释。
  let revisionCounter = 0;
  let anchoredHistory = deps.hasAnchoredHistory;
  let anchorMarkerConfirmed = deps.hasAnchoredHistory;
  let lastWarning: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function repairAnchorMarker(): Promise<string | undefined> {
    if (anchorMarkerConfirmed) return undefined;
    try {
      if (await deps.onAnchoredHistory()) {
        anchorMarkerConfirmed = true;
        lastWarning = undefined;
        return undefined;
      }
    } catch {
      // The journal commit remains valid and readable.
    }
    lastWarning = 'anchored-history-marker-update-failed';
    return lastWarning;
  }

  async function loadInternal(): Promise<ExternalStoreStatus> {
    if (!loaded) {
      const status = await atomic.load();
      loaded = true;
      if (status.state === 'ready' || status.state === 'uninitialized') {
        journal = atomic.readAll();
        revisionCounter += 1;
      }
      if (status.state === 'ready' && journal.entries.length > 0) {
        anchoredHistory = true;
        await repairAnchorMarker();
      }
    }
    return currentStatus();
  }

  function currentStatus(): ExternalStoreStatus {
    const status = atomic.status();
    return lastWarning ? { ...status, lastWarning } : status;
  }

  function enqueue(task: () => Promise<AtomicCommitResult>): Promise<AtomicCommitResult> {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function markAnchoredAfterCommit(
    result: AtomicCommitResult,
    containsEntries: boolean,
  ): Promise<AtomicCommitResult> {
    if (!result.ok || !result.confirmed || !containsEntries) return result;
    anchoredHistory = true;
    const warning = await repairAnchorMarker();
    if (!warning) return result;
    const markerWarning = result.markerWarning
      ? `${result.markerWarning}; ${warning}`
      : warning;
    return { ...result, markerWarning };
  }

  return {
    load: loadInternal,
    readAll(): Record<string, unknown> {
      return replayStoryDomainJournal(journal);
    },
    append(anchor, updates, deletes): Promise<AtomicCommitResult> {
      const safeAnchor = String(anchor || '');
      const safeUpdates = cloneJson(updates || {});
      const safeDeletes = [...new Set(deletes || [])];
      return enqueue(async () => {
        await loadInternal();
        // The coordinator validates and captures the active anchor when the
        // mutation is created. It may legitimately disappear before this
        // delayed durable append runs (anchor drift / floor deletion);
        // replay no longer filters by anchor, so the entry still applies.
        if (!safeAnchor) return failed('missing-ai-anchor', true);
        journal = atomic.readAll();
        const nextRevision = journal.entries.reduce(
          (maximum, entry) => Math.max(maximum, entry.revision),
          0,
        ) + 1;
        const entry: StoryDomainJournalEntry = {
          anchor: safeAnchor,
          revision: nextRevision,
          ...(Object.keys(safeUpdates).length ? { sets: safeUpdates } : {}),
          ...(safeDeletes.length ? { deletes: safeDeletes } : {}),
        };
        const appended: StoryDomainJournal = {
          // O36-④(十一轮)：journal 来自 atomic.readAll() 的出仓克隆（已是本域私有引用），
          // 无外部别名，baseline 直接引用即可——省一次全量深拷贝（map 域 MB 级时可观）。
          baseline: journal.baseline,
          entries: [...journal.entries, entry],
        };
        // 折叠压缩（每次 append）：保留最近 20 个活跃锚点 entry，更早/失联锚点折叠进 baseline。
        // 用 activeStoryReplayAnchors（含多变体消息级锚点）判定活跃，避免把重生成前写的 entry 误当失联。
        const compacted = compactStoryDomainJournal(appended, deps.getActiveAnchors());
        const next = compacted ?? appended;
        const result = await atomic.replaceAll(next);
        // 诊断（临时）：story-core 的 cycle 写是 bug 嫌疑对象，记录 append 结果——
        // retryable=false 且 ok=false 会被 coordinator 连同 recovery 一起删除（永久丢失）。
        if (deps.domain === 'story-core' && Object.prototype.hasOwnProperty.call(safeUpdates, 'cycle')) {
          traceCycleDiagnostic('domain-append-result', {
            domain: deps.domain, anchor: safeAnchor, revision: nextRevision,
            ok: result.ok, confirmed: result.confirmed, retryable: result.retryable,
            error: result.error || undefined,
          });
        }
        // O36-④(十一轮)：next 是本函数新建对象（appended 或 compact 产物——compact 不改
        // 输入、返回全新 baseline/entries）；replaceAll 入口自有克隆且不改 next，成功后
        // journal 直接持有 next 即可，省一次全量深拷贝。
        if (result.ok) { journal = next; revisionCounter += 1; }
        return markAnchoredAfterCommit(result, result.ok);
      });
    },
    replaceJournal(input): Promise<AtomicCommitResult> {
      const replacement = cloneJson(input);
      return enqueue(async () => {
        await loadInternal();
        if (!isStoryDomainJournal(replacement)) return failed('invalid-story-domain-journal');
        journal = atomic.readAll();
        if (anchoredHistory && stableStringify(replacement.baseline) !== stableStringify(journal.baseline)) {
          return failed('anchored-history-baseline-is-immutable');
        }
        const result = await atomic.replaceAll(replacement);
        if (result.ok) { journal = cloneJson(replacement); revisionCounter += 1; }
        return markAnchoredAfterCommit(result, replacement.entries.length > 0);
      });
    },
    restoreJournal(input): Promise<AtomicCommitResult> {
      const replacement = cloneJson(input);
      return enqueue(async () => {
        await loadInternal();
        if (!isStoryDomainJournal(replacement)) return failed('invalid-story-domain-journal');
        const result = await atomic.replaceAll(replacement);
        if (result.ok) { journal = cloneJson(replacement); revisionCounter += 1; }
        return markAnchoredAfterCommit(result, replacement.entries.length > 0);
      });
    },
    replay(): Record<string, unknown> {
      return replayStoryDomainJournal(journal);
    },
    revision(): number {
      return revisionCounter;
    },
    exportJournal(): StoryDomainJournal {
      return cloneJson(journal);
    },
    async flush(): Promise<void> {
      await queue;
      await atomic.flush();
    },
    status: currentStatus,
  };
}
