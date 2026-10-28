// ===== 小手机按聊天备份快照（usb_phonebak_<h>_<ts>.json + usb_phonebakidx_<h>.json） =====
// 机制对齐主项目 story-backup-store（docs/01 §5）：整值快照 + 索引轮换（保留最近 10 份）+
// 恢复前安全快照 + 失败补偿。差别仅在负载：主项目是 core/map 双 journal，小手机是单份
// PhoneChatData 整值；文件名独立命名空间，绝不与主项目 usb_bak_* 互踩。
// 自动触发：MESSAGE_RECEIVED（窥私引擎同款幂等绑定），每 N 层 AI 回复水位备份一次。

import {
  checksumValue,
  cloneJson,
  sha256Hex,
  stableStringify,
} from '../../unified-statusbar/core/external-storage-codec';
import { createServerFileStore, type ServerFileStore } from '../../unified-statusbar/core/server-file-store';
import { isHostRefillMode } from './host-config';
import { hostWindow } from './host-env';
import { getPhoneSettings } from './phone-settings';
import {
  currentPhoneStorageId,
  flushPhoneStore,
  readPhoneData,
  replacePhoneData,
  resetPhoneData,
} from './phone-store';
import type { PhoneChatData } from './chat-model';
import { isRecord } from './ubp-utils';

const PHONE_BACKUP_RETAIN = 10;

export interface PhoneBackupMeta {
  file: string;
  createdAt: number;
  reason: 'auto' | 'manual';
  turns: number;
  bytes: number;
}

interface PhoneBackupIndex {
  schema: 3;
  kind: 'phone-backup-index';
  scopeHash: string;
  revision: number;
  countBase: number;
  backups: PhoneBackupMeta[];
  checksum: string;
}

interface PhoneBackupSnapshot {
  schema: 3;
  kind: 'phone-backup-snapshot';
  scopeHash: string;
  createdAt: number;
  reason: 'auto' | 'manual' | 'safety';
  turns: number;
  data: PhoneChatData;
  checksum: string;
}

export interface PhoneBackupStoreDeps {
  files: ServerFileStore;
  storageId: string;
  now?: () => number;
  makeId?: (prefix: string) => string;
}

export interface PhoneBackupSnapshotInput {
  reason: 'auto' | 'manual';
  data: PhoneChatData;
  turns: number;
}

export interface PhoneBackupRestoreOperations {
  captureCurrent: () => { data: PhoneChatData; turns: number };
  applyData: (data: PhoneChatData) => Promise<boolean>;
}

export type PhoneBackupRestoreResult =
  | { ok: true; warning?: 'restored-with-index-warning' }
  | { ok: false; error: string; compensationFailed?: boolean };

export interface PhoneBackupStore {
  load(): Promise<{ state: 'ready' | 'read-only' | 'error'; lastError?: string }>;
  listBackups(): PhoneBackupMeta[];
  deleteBackup(file: string): Promise<boolean>;
  createSnapshot(input: PhoneBackupSnapshotInput): Promise<boolean>;
  shouldAutoBackup(curTurns: number, interval: number): boolean;
  rotate(maxRetain: number): Promise<void>;
  restoreSnapshot(file: string, operations: PhoneBackupRestoreOperations): Promise<PhoneBackupRestoreResult>;
}

function checksumOk(value: unknown): boolean {
  if (!isRecord(value) || typeof value.checksum !== 'string') return false;
  const { checksum, ...payload } = value;
  return checksum === checksumValue(payload);
}

function validSnapshot(value: unknown, scopeHash: string): value is PhoneBackupSnapshot {
  return checksumOk(value)
    && isRecord(value)
    && value.schema === 3
    && value.kind === 'phone-backup-snapshot'
    && value.scopeHash === scopeHash
    && typeof value.createdAt === 'number'
    && (value.reason === 'auto' || value.reason === 'manual' || value.reason === 'safety')
    && typeof value.turns === 'number'
    && isRecord(value.data)
    && Array.isArray(value.data.conversations);
}

function normalizeMeta(value: unknown): PhoneBackupMeta | null {
  if (!isRecord(value)
    || typeof value.file !== 'string'
    || typeof value.createdAt !== 'number'
    || (value.reason !== 'auto' && value.reason !== 'manual')
    || typeof value.turns !== 'number'
    || typeof value.bytes !== 'number') return null;
  return {
    file: value.file,
    createdAt: value.createdAt,
    reason: value.reason,
    turns: value.turns,
    bytes: value.bytes,
  };
}

function validIndex(value: unknown, scopeHash: string): value is PhoneBackupIndex {
  if (!checksumOk(value) || !isRecord(value)) return false;
  if (value.schema !== 3 || value.kind !== 'phone-backup-index' || value.scopeHash !== scopeHash) return false;
  if (!Number.isInteger(value.revision) || Number(value.revision) < 0) return false;
  if (typeof value.countBase !== 'number' || !Array.isArray(value.backups)) return false;
  return value.backups.every(item => normalizeMeta(item) !== null);
}

function withChecksum<T extends Record<string, unknown>>(payload: T): T & { checksum: string } {
  return { ...payload, checksum: checksumValue(payload) };
}

export function phoneBackupIndexFilename(storageId: string): string {
  return `usb_phonebakidx_${sha256Hex(storageId).slice(0, 24)}.json`;
}

export function createPhoneBackupStore(deps: PhoneBackupStoreDeps): PhoneBackupStore {
  const scopeHash = sha256Hex(deps.storageId).slice(0, 24);
  const bakidxFile = `usb_phonebakidx_${scopeHash}.json`;
  let index = withChecksum({
    schema: 3 as const,
    kind: 'phone-backup-index' as const,
    scopeHash,
    revision: 0,
    countBase: 0,
    backups: [] as PhoneBackupMeta[],
  }) as PhoneBackupIndex;

  function token(prefix: string): string {
    const makeId = deps.makeId || (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    return String(makeId(prefix)).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || prefix;
  }

  async function writeVerified(file: string, value: unknown): Promise<boolean> {
    const uploaded = await deps.files.uploadJson(file, value);
    const read = await deps.files.readJson<unknown>(file);
    return Boolean((uploaded.ok || read.found)
      && read.found
      && read.value
      && stableStringify(read.value) === stableStringify(value));
  }

  async function saveIndexCandidate(candidate: Omit<PhoneBackupIndex, 'checksum'>): Promise<boolean> {
    const next = withChecksum(candidate) as PhoneBackupIndex;
    if (!await writeVerified(bakidxFile, next)) return false;
    index = cloneJson(next);
    return true;
  }

  async function createSnapshotFile(input: {
    reason: 'auto' | 'manual' | 'safety';
    data: PhoneChatData;
    turns: number;
  }): Promise<{ file: string; snapshot: PhoneBackupSnapshot; bytes: number } | null> {
    const createdAt = deps.now?.() ?? Date.now();
    const prefix = input.reason === 'safety' ? 'restore-safety' : 'snapshot';
    const file = `usb_phonebak_${scopeHash}_${createdAt}_${token(prefix)}.json`;
    const snapshot = withChecksum({
      schema: 3 as const,
      kind: 'phone-backup-snapshot' as const,
      scopeHash,
      createdAt,
      reason: input.reason,
      turns: input.turns,
      data: cloneJson(input.data),
    }) as PhoneBackupSnapshot;
    if (!await writeVerified(file, snapshot)) return null;
    return { file, snapshot, bytes: JSON.stringify(snapshot).length };
  }

  return {
    async load() {
      const read = await deps.files.readJson<unknown>(bakidxFile);
      if (!read.found) return { state: 'ready' };
      if (validIndex(read.value, scopeHash)) {
        const loaded = cloneJson(read.value);
        loaded.backups = loaded.backups.map(item => normalizeMeta(item) as PhoneBackupMeta);
        index = loaded;
        return { state: 'ready' };
      }
      if (read.error) return { state: 'error', lastError: read.error };
      return { state: 'read-only', lastError: '备份索引校验失败' };
    },
    listBackups(): PhoneBackupMeta[] {
      return cloneJson(index.backups);
    },
    async deleteBackup(file) {
      if (!index.backups.some(item => item.file === file)) return false;
      const nextBackups = index.backups.filter(item => item.file !== file);
      if (!await saveIndexCandidate({
        schema: 3,
        kind: 'phone-backup-index',
        scopeHash,
        revision: index.revision + 1,
        countBase: index.countBase,
        backups: nextBackups,
      })) return false;
      try { await deps.files.delete(`/user/files/${file}`); } catch { /* harmless orphan */ }
      return true;
    },
    async createSnapshot(input) {
      const created = await createSnapshotFile(input);
      if (!created) return false;
      const meta: PhoneBackupMeta = {
        file: created.file,
        createdAt: created.snapshot.createdAt,
        reason: input.reason,
        turns: input.turns,
        bytes: created.bytes,
      };
      return saveIndexCandidate({
        schema: 3,
        kind: 'phone-backup-index',
        scopeHash,
        revision: index.revision + 1,
        countBase: input.turns,
        backups: [...index.backups, meta],
      });
    },
    shouldAutoBackup(curTurns, interval) {
      return curTurns - index.countBase >= interval;
    },
    async rotate(maxRetain) {
      const excess = index.backups.length - Math.max(0, maxRetain);
      if (excess <= 0) return;
      const removed = index.backups.slice(0, excess);
      const kept = index.backups.slice(excess);
      if (!await saveIndexCandidate({
        schema: 3,
        kind: 'phone-backup-index',
        scopeHash,
        revision: index.revision + 1,
        countBase: index.countBase,
        backups: kept,
      })) return;
      for (const item of removed) {
        try { await deps.files.delete(`/user/files/${item.file}`); } catch { /* harmless orphan */ }
      }
    },
    async restoreSnapshot(file, operations): Promise<PhoneBackupRestoreResult> {
      if (!index.backups.some(item => item.file === file)) {
        return { ok: false, error: 'backup-not-indexed' };
      }
      const read = await deps.files.readJson<unknown>(file);
      const target = read.found && validSnapshot(read.value, scopeHash) ? cloneJson(read.value) : null;
      if (!target) return { ok: false, error: 'backup-invalid' };
      const current = operations.captureCurrent();
      const safety = await createSnapshotFile({ reason: 'safety', ...current });
      if (!safety) return { ok: false, error: 'safety-snapshot-unconfirmed' };

      let applied = false;
      try {
        applied = await operations.applyData(cloneJson(target.data));
      } catch (error) {
        applied = false;
        void error;
      }
      if (!applied) {
        let compensated = false;
        try { compensated = await operations.applyData(cloneJson(safety.snapshot.data)); } catch { /* keep safety */ }
        if (compensated) {
          try { await deps.files.delete(`/user/files/${safety.file}`); } catch { /* orphan is safe */ }
        }
        return { ok: false, error: 'phone-restore-unconfirmed', ...(!compensated ? { compensationFailed: true } : {}) };
      }

      const indexSaved = await saveIndexCandidate({
        schema: 3,
        kind: 'phone-backup-index',
        scopeHash,
        revision: index.revision + 1,
        countBase: target.turns,
        backups: index.backups,
      });
      try { await deps.files.delete(`/user/files/${safety.file}`); } catch { /* harmless orphan */ }
      return indexSaved ? { ok: true } : { ok: true, warning: 'restored-with-index-warning' };
    },
  };
}

// ===== 运行时编排（对齐主项目 storage-bootstrap 备份编排层） =====

let _store: PhoneBackupStore | null = null;
let _storeStorageId = '';
let _queue: Promise<unknown> = Promise.resolve();

async function ensureStore(storageId: string): Promise<PhoneBackupStore | null> {
  if (_store && _storeStorageId === storageId) return _store;
  const store = createPhoneBackupStore({ files: createServerFileStore(), storageId });
  const loaded = await store.load();
  if (loaded.state !== 'ready') return null;
  if (currentPhoneStorageId() && currentPhoneStorageId() !== storageId) return null; // 期间切了聊天：弃用
  _store = store;
  _storeStorageId = storageId;
  return store;
}

/** 当前聊天的 AI 回复层数（与主项目备份「第N层」同口径：仅统计 AI 消息）。 */
export function phoneAiTurns(): number {
  try {
    const w = hostWindow() as any;
    const chat = w.SillyTavern?.getContext?.()?.chat ?? w.SillyTavern?.chat;
    if (Array.isArray(chat)) return chat.filter((m: any) => m && m.is_user !== true).length;
  } catch (_e) { /* ignore */ }
  return 0;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = _queue.then(operation, operation);
  _queue = result.then(() => undefined, () => undefined);
  return result;
}

async function runBackup(reason: 'auto' | 'manual'): Promise<boolean> {
  const storageId = currentPhoneStorageId();
  if (!storageId) return false;
  const store = await ensureStore(storageId);
  if (!store) return false;
  await flushPhoneStore(); // 快照与磁盘一致（排空 350ms 去抖写）
  const ok = await store.createSnapshot({ reason, data: readPhoneData(), turns: phoneAiTurns() });
  if (ok) await store.rotate(PHONE_BACKUP_RETAIN);
  return ok;
}

/** 自动备份水位检查（MESSAGE_RECEIVED 触发；不达水位零写请求）。 */
export async function maybeAutoPhoneBackup(): Promise<boolean> {
  if (isHostRefillMode()) return false; // F66：重填模式期间不做自动写入
  return enqueue(async () => {
    const storageId = currentPhoneStorageId();
    if (!storageId) return false;
    const store = await ensureStore(storageId);
    if (!store) return false;
    if (!store.shouldAutoBackup(phoneAiTurns(), getPhoneSettings().phoneBackupInterval)) return false;
    return runBackup('auto');
  });
}

export async function manualPhoneBackup(): Promise<boolean> {
  return enqueue(() => runBackup('manual'));
}

export async function listPhoneBackups(): Promise<{ list: PhoneBackupMeta[]; ready: boolean }> {
  const storageId = currentPhoneStorageId();
  const store = storageId ? await ensureStore(storageId) : null;
  return { list: store ? store.listBackups() : [], ready: !!store };
}

export async function deletePhoneBackup(file: string): Promise<boolean> {
  const storageId = currentPhoneStorageId();
  const store = storageId ? await ensureStore(storageId) : null;
  return store ? store.deleteBackup(file) : false;
}

/** 恢复当前聊天的备份快照：安全快照→整值替换→失败补偿，成功后统一派发刷新事件。 */
export async function restorePhoneBackup(file: string): Promise<PhoneBackupRestoreResult> {
  const storageId = currentPhoneStorageId();
  if (!storageId) return { ok: false, error: '当前聊天存储未就绪' };
  const store = await ensureStore(storageId);
  if (!store) return { ok: false, error: '备份存储不可用' };
  return enqueue(() => store.restoreSnapshot(file, {
    captureCurrent: () => ({ data: readPhoneData(), turns: phoneAiTurns() }),
    applyData: async data => {
      // 聊天归属守卫（F2）：读快照期间切了聊天 → 中止，别把这份快照覆盖到别人头上。
      if (currentPhoneStorageId() !== storageId) return false;
      await flushPhoneStore();
      if (currentPhoneStorageId() !== storageId) return false;
      return replacePhoneData(cloneJson(data));
    },
  }));
}

export interface ResetPhoneDataReport {
  /** 数据文件是否已清空并落盘确认（false=只读/网络异常，数据保持原样）。 */
  dataOk: boolean;
  /** 已删除的备份快照份数。 */
  backupsDeleted: number;
}

/**
 * 「重置当前数据」出口：整值清空数据文件，**成功后才**删光当前聊天的备份快照（索引逐条 verified 更新）。
 * 与「清空当前聊天的小手机数据」（只清数据、保留备份可回滚）语义不同——本操作不可恢复。
 * 顺序为何是「先清数据、后删备份」（F3）：旧实现反过来——备份已真删、数据可能没清成功，
 * 上层却提示「数据已保持原样」，用户因此不会去备份里找（备份也没了）。现在清数据失败=一份备份都不动，可回滚。
 * 备份删除失败不阻断（快照残留只是多占空间，用户可在存储页逐条删除）。
 */
export async function resetPhoneDataWithBackups(): Promise<ResetPhoneDataReport> {
  const storageId = currentPhoneStorageId();
  await flushPhoneStore();
  const dataOk = await resetPhoneData();
  if (!dataOk) return { dataOk: false, backupsDeleted: 0 }; // 数据没清成功 → 备份保持原样，用户仍可回滚
  let backupsDeleted = 0;
  if (storageId) {
    const store = await ensureStore(storageId);
    if (store) {
      for (const meta of store.listBackups()) {
        if (await store.deleteBackup(meta.file)) backupsDeleted += 1;
      }
    }
  }
  return { dataOk, backupsDeleted };
}

// ===== 自动触发绑定（窥私引擎同款幂等守卫；设置开关首行即返） =====

const QUIET_MESSAGE_TYPES = new Set(['quiet', 'impersonate', 'command', 'extension', 'first_message']);

export function bindPhoneAutoBackup(): void {
  const w = hostWindow() as unknown as Record<string, unknown> & { SillyTavern?: any; __ubp_phone_backup_bound?: boolean };
  if (w.__ubp_phone_backup_bound) return;
  w.__ubp_phone_backup_bound = true;
  try {
    const ctx = w.SillyTavern?.getContext?.();
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (!source || typeof source.on !== 'function' || !types?.MESSAGE_RECEIVED) return;
    source.on(types.MESSAGE_RECEIVED, (_id: unknown, type: unknown) => {
      if (typeof type === 'string' && QUIET_MESSAGE_TYPES.has(type)) return;
      void maybeAutoPhoneBackup().catch(() => { /* 备份失败静默：列表页可见，下次水位重试 */ });
    });
  } catch (_e) { /* 宿主事件不可用：仅失去自动触发，手动备份仍可用 */ }
}
