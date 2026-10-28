import { isRecord } from './type-guards';
import type { ChatOwner } from './chat-storage-identity';
import { checksumValue, checksumOk, cloneJson, sha256Hex } from './external-storage-codec';
import type { ExternalStoreStatus } from './external-storage-types';
import type { ServerFileStore, ServerFileWriteResult } from './server-file-store';

export interface AtomicEnvelope<T extends Record<string, unknown>> {
  schema: 3;
  kind: string;
  scopeId: string;
  owner?: ChatOwner;
  revision: number;
  updatedAt: number;
  value: T;
  checksum: string;
}

export interface AtomicCommitResult {
  ok: boolean;
  confirmed: boolean;
  retryable: boolean;
  markerWarning?: string;
  error?: string;
}

export interface AtomicEnvelopeStore<T extends Record<string, unknown>> {
  load(): Promise<ExternalStoreStatus>;
  readAll(): T;
  /** 工作信封 revision：value 可能变化的每个转写点（load/commit/ambiguous 确认）随信封更新。 */
  revision(): number;
  patch(updates: Partial<T>, deletes?: Array<keyof T & string>): Promise<AtomicCommitResult>;
  replaceAll(value: T): Promise<AtomicCommitResult>;
  flush(): Promise<void>;
  status(): ExternalStoreStatus;
  exportEnvelope(): AtomicEnvelope<T>;
}

export interface AtomicEnvelopeStoreDeps<T extends Record<string, unknown>> {
  files: ServerFileStore;
  filename: string;
  kind: string;
  scopeId: string;
  owner?: ChatOwner;
  domainCreated: boolean;
  emptyValue: T;
  now: () => number;
  onFirstVerifiedCreate?: () => Promise<boolean>;
  validateValue?: (value: unknown) => boolean;
}

function isOwner(value: unknown): value is ChatOwner {
  if (!isRecord(value) || typeof value.chatId !== 'string' || !value.chatId) return false;
  if (value.kind === 'group') return true;
  return value.kind === 'character' && typeof value.avatar === 'string' && Boolean(value.avatar);
}

function signEnvelope<T extends Record<string, unknown>>(
  payload: Omit<AtomicEnvelope<T>, 'checksum'>,
): AtomicEnvelope<T> {
  return { ...payload, checksum: checksumValue(payload) };
}

/**
 * 构建 next 值。契约：`updates` 必须是调用方**已私有化的副本**（patch 入口已 cloneJson），
 * 故此处不再逐值克隆；返回值是全新对象，可安全作为信封 value 直接持有。
 */
function applyPatch<T extends Record<string, unknown>>(
  current: T,
  updates: Partial<T>,
  deletes: ReadonlyArray<keyof T & string>,
): T {
  const next = cloneJson(current);
  for (const [key, value] of Object.entries(updates)) {
    (next as Record<string, unknown>)[key] = value;
  }
  for (const key of deletes) delete (next as Record<string, unknown>)[key];
  return next;
}

function boundedMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : String(value || fallback);
  return (message || fallback).slice(0, 220);
}

/** 损坏只读的面向用户错误：机器码打头（测试/日志锚点），附文件名与自救指引。 */
function corruptFileMessage(code: string, filename: string): string {
  return `${code}：数据文件已损坏（${filename}）；可在 设置→存储 重置当前聊天，或删除该文件后重进`;
}

export function createAtomicEnvelopeStore<T extends Record<string, unknown>>(
  deps: AtomicEnvelopeStoreDeps<T>,
): AtomicEnvelopeStore<T> {
  const scopeHash = sha256Hex(deps.scopeId).slice(0, 24);
  const expectedFilenameSuffix = `_${scopeHash}.json`;
  const initialEnvelope = (): AtomicEnvelope<T> => signEnvelope({
    schema: 3,
    kind: deps.kind,
    scopeId: deps.scopeId,
    ...(deps.owner ? { owner: cloneJson(deps.owner) } : {}),
    revision: 0,
    updatedAt: deps.now(),
    value: cloneJson(deps.emptyValue),
  });

  let confirmedEnvelope = initialEnvelope();
  // O36-④(十一轮)：initialEnvelope() 返回全新对象（零外部引用），无需再克隆。
  let workingEnvelope = confirmedEnvelope;
  let loaded = false;
  let diskExists = false;
  let domainMarked = deps.domainCreated;
  let state: ExternalStoreStatus = {
    state: 'uninitialized',
    revision: 0,
    generation: deps.scopeId,
    pendingWrites: 0,
  };
  let queue: Promise<unknown> = Promise.resolve();

  const validEnvelope = (raw: unknown): raw is AtomicEnvelope<T> => {
    if (!checksumOk(raw)) return false;
    if (raw.schema !== 3 || raw.kind !== deps.kind || raw.scopeId !== deps.scopeId) return false;
    if (!Number.isInteger(raw.revision) || Number(raw.revision) < 0) return false;
    if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return false;
    if (!isRecord(raw.value) || (deps.validateValue && !deps.validateValue(raw.value))) return false;
    if (raw.owner !== undefined && !isOwner(raw.owner)) return false;
    return true;
  };

  const setReadOnly = (message: string): void => {
    state = {
      ...state,
      state: 'read-only',
      revision: confirmedEnvelope.revision,
      lastError: boundedMessage(message, 'atomic-envelope-read-only'),
    };
  };

  const setRetryableError = (message: string): void => {
    state = {
      ...state,
      revision: confirmedEnvelope.revision,
      lastError: boundedMessage(message, 'atomic-envelope-write-failed'),
    };
  };

  const setReady = (): void => {
    state = {
      state: 'ready',
      revision: confirmedEnvelope.revision,
      generation: deps.scopeId,
      pendingWrites: state.pendingWrites,
      ...(state.lastWarning ? { lastWarning: state.lastWarning } : {}),
    };
  };

  async function repairMarker(): Promise<string | undefined> {
    if (domainMarked) return undefined;
    if (!deps.onFirstVerifiedCreate) {
      domainMarked = true;
      return undefined;
    }
    try {
      if (await deps.onFirstVerifiedCreate()) {
        domainMarked = true;
        state = { ...state };
        delete state.lastWarning;
        return undefined;
      }
    } catch {
      // The data file is already verified. Marker failure is a warning, not data failure.
    }
    const warning = 'domain-marker-update-failed';
    state = { ...state, lastWarning: warning };
    return warning;
  }

  async function loadInternal(): Promise<ExternalStoreStatus> {
    if (loaded) return cloneJson(state);
    loaded = true;

    if (!deps.filename.endsWith(expectedFilenameSuffix)) {
      setReadOnly('filename-scope-mismatch');
      return cloneJson(state);
    }

    const read = await deps.files.readJson<unknown>(deps.filename);
    if (read.error) {
      setReadOnly(read.error);
      return cloneJson(state);
    }
    if (!read.found) {
      // 域标记已创建（domainsCreated 含本域）但文件干净缺失（404，无读取错误）：
      // 磁盘数据已不存在（用户删除外部文件/清理工具/换机未同步），此时永久只读
      // （missing-created-domain）会让聊天锁死在「存档同步中」——isStoryStorageReady
      // 永不就绪且无任何恢复路径，删除文件后重进也解不开。改为保持 uninitialized
      // 空底账，下次写入（firstCreate）重建文件。仅限 404 干净缺失；
      // 读错误（离线/网络失败）与文件损坏仍保持只读，不把瞬时可读性误判为删除。
      return cloneJson(state);
    }
    if (!validEnvelope(read.value)) {
      setReadOnly(corruptFileMessage('invalid-atomic-envelope', deps.filename));
      return cloneJson(state);
    }

    // O36-④(十一轮)：read.value 是本次 response.json() 的全新解析结果（无其它引用持有），
    // 校验通过后直接入仓，省一次全量深拷贝（story-map 域 MB 级时每次加载一份）。
    confirmedEnvelope = read.value;
    workingEnvelope = confirmedEnvelope;
    diskExists = true;
    setReady();
    await repairMarker();
    return cloneJson(state);
  }

  async function confirmAmbiguousWrite(
    candidate: AtomicEnvelope<T>,
    firstCreate: boolean,
    writeError: string,
  ): Promise<AtomicCommitResult> {
    const readback = await deps.files.readJson<unknown>(deps.filename);
    if (readback.error) {
      setRetryableError(`${writeError}: ${readback.error}`);
      return { ok: false, confirmed: false, retryable: true, error: state.lastError };
    }
    if (!readback.found) {
      if (!diskExists && firstCreate) {
        setRetryableError(writeError);
        return { ok: false, confirmed: false, retryable: true, error: state.lastError };
      }
      setReadOnly('missing-created-domain');
      return { ok: false, confirmed: false, retryable: false, error: state.lastError };
    }
    if (!validEnvelope(readback.value)) {
      setReadOnly(corruptFileMessage('invalid-atomic-envelope-after-write', deps.filename));
      return { ok: false, confirmed: false, retryable: false, error: state.lastError };
    }
    if (readback.value.checksum === candidate.checksum) {
      confirmedEnvelope = candidate;
      workingEnvelope = candidate;
      diskExists = true;
      setReady();
      const markerWarning = await repairMarker();
      return markerWarning
        ? { ok: true, confirmed: true, retryable: false, markerWarning }
        : { ok: true, confirmed: true, retryable: false };
    }
    // 队列串行保证本函数执行期间（含上方 await 回读）confirmedEnvelope 不会被其它写入改写，
    // 故此处直接读其 checksum 即可（原为进入 commit 前的快照克隆）。
    if (readback.value.checksum === confirmedEnvelope.checksum) {
      setRetryableError(writeError);
      return { ok: false, confirmed: false, retryable: true, error: state.lastError };
    }

    setReadOnly('unexpected-valid-version');
    return { ok: false, confirmed: false, retryable: false, error: state.lastError };
  }

  async function commit(candidate: AtomicEnvelope<T>): Promise<AtomicCommitResult> {
    const firstCreate = !diskExists;
    workingEnvelope = candidate;

    let write: ServerFileWriteResult;
    try {
      write = await deps.files.uploadJson(deps.filename, candidate);
    } catch (error) {
      write = { ok: false, error: boundedMessage(error, 'atomic-envelope-upload-threw') };
    }
    if (!write.ok) {
      return confirmAmbiguousWrite(candidate, firstCreate, write.error || 'atomic-envelope-upload-failed');
    }

    if (firstCreate) {
      return confirmAmbiguousWrite(candidate, true, 'first-create-readback-mismatch');
    }

    confirmedEnvelope = candidate;
    diskExists = true;
    setReady();
    return { ok: true, confirmed: true, retryable: false };
  }

  async function mutate(buildNextValue: () => T): Promise<AtomicCommitResult> {
    await loadInternal();
    if (state.state === 'read-only' || state.state === 'conflict' || state.state === 'error') {
      return {
        ok: false,
        confirmed: false,
        retryable: false,
        error: state.lastError || `atomic-envelope-${state.state}`,
      };
    }
    const nextValue = buildNextValue();
    // buildNextValue 契约=返回私有新对象（patch 走 applyPatch 的 cloneJson 基底、replaceAll 走入口克隆），
    // 故 value 不再二次克隆；读取出口（readAll/exportEnvelope/status）依旧全部克隆，别名不外泄。
    const candidate = signEnvelope({
      schema: 3,
      kind: deps.kind,
      scopeId: deps.scopeId,
      ...(deps.owner ? { owner: cloneJson(deps.owner) } : {}),
      revision: confirmedEnvelope.revision + 1,
      updatedAt: deps.now(),
      value: nextValue,
    });
    return commit(candidate);
  }

  function enqueueWrite(task: () => Promise<AtomicCommitResult>): Promise<AtomicCommitResult> {
    state.pendingWrites += 1;
    const run = async (): Promise<AtomicCommitResult> => {
      try {
        return await task();
      } finally {
        state.pendingWrites = Math.max(0, state.pendingWrites - 1);
      }
    };
    const result = queue.then(run, run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    load(): Promise<ExternalStoreStatus> {
      const result = queue.then(loadInternal, loadInternal);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    readAll(): T {
      return cloneJson(workingEnvelope.value);
    },
    revision(): number {
      return workingEnvelope.revision;
    },
    patch(updates: Partial<T>, deletes: Array<keyof T & string> = []): Promise<AtomicCommitResult> {
      const safeUpdates = cloneJson(updates);
      const safeDeletes = [...deletes];
      return enqueueWrite(async () => mutate(() => applyPatch(workingEnvelope.value, safeUpdates, safeDeletes)));
    },
    replaceAll(value: T): Promise<AtomicCommitResult> {
      // 入口克隆必须保留：调用方可能在入队后改写自己传入的对象（异步队列执行时已非当刻状态）。
      const replacement = cloneJson(value);
      return enqueueWrite(async () => mutate(() => replacement));
    },
    async flush(): Promise<void> {
      await queue;
    },
    status(): ExternalStoreStatus {
      return cloneJson(state);
    },
    exportEnvelope(): AtomicEnvelope<T> {
      return cloneJson(workingEnvelope);
    },
  };
}
