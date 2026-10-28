// ===== 统一状态栏 · 全局聊天外部存储索引 =====
//
// 酒馆无「列出 user/files 目录」的 API（见 storage-hard-reset.ts 注释），纯孤儿外部存储
// （没有任何存活聊天引用其 storageId）无法经枚举发现。本索引是前瞻式兜底：每次 storage
// 创建/fork 成功时 upsert 一条记录，使得「聊天元数据后来完全丢失」的纯孤儿仍可被
// 「全局聊天外部存储管理」模块列出与恢复。
//
// 性能纪律（硬要求）：索引 touch 只发生在 storage 创建/fork 的一次性时刻（每个聊天会话
// 至多一次），绝不挂在每次写入或 onDomainCreated 热路径上；且 best-effort、fire-and-forget，
// 失败/不可达时静默跳过，不阻塞存储初始化，不影响游玩性能。

import { isRecord } from './type-guards';
import type { ChatOwner, ChatStorageDomain } from './chat-storage-identity';
import { cloneJson } from './external-storage-codec';
import type { ServerFileStore } from './server-file-store';

export const STORAGE_INDEX_FILENAME = 'usb_storage_index_v1.json';

export interface StorageIndexEntry {
  storageId: string;
  owner: ChatOwner;
  /** 创建时角色名快照；角色卡被删后仍可展示。 */
  characterName?: string;
  createdAt: number;
  domainsCreated: ChatStorageDomain[];
}

export interface StorageIndex {
  schema: 1;
  entries: Record<string, StorageIndexEntry>;
}

const EMPTY_INDEX: StorageIndex = { schema: 1, entries: {} };

function normalizeOwner(value: unknown): ChatOwner | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'character' && value.kind !== 'group') return null;
  if (typeof value.chatId !== 'string' || !value.chatId.trim()) return null;
  if (value.kind === 'character') {
    if (typeof value.avatar !== 'string' || !value.avatar.trim()) return null;
    return { kind: 'character', avatar: value.avatar, chatId: value.chatId };
  }
  return { kind: 'group', chatId: value.chatId };
}

const DOMAIN_SET: readonly ChatStorageDomain[] = ['story-core', 'story-map', 'portraits'];

function normalizeDomains(value: unknown): ChatStorageDomain[] {
  if (!Array.isArray(value)) return [];
  const out: ChatStorageDomain[] = [];
  for (const domain of value) {
    if (typeof domain === 'string' && DOMAIN_SET.includes(domain as ChatStorageDomain)
      && !out.includes(domain as ChatStorageDomain)) {
      out.push(domain as ChatStorageDomain);
    }
  }
  return out;
}

/** 纯函数：把磁盘上的任意值归一为 StorageIndex（非法则空索引）。 */
export function normalizeStorageIndex(value: unknown): StorageIndex {
  if (!isRecord(value) || value.schema !== 1 || !isRecord(value.entries)) {
    return cloneJson(EMPTY_INDEX);
  }
  const entries: Record<string, StorageIndexEntry> = {};
  for (const [storageId, raw] of Object.entries(value.entries)) {
    if (!isRecord(raw)) continue;
    const id = typeof storageId === 'string' ? storageId.toLowerCase() : '';
    if (!id) continue;
    const owner = normalizeOwner(raw.owner);
    if (!owner) continue;
    if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) continue;
    entries[id] = {
      storageId: id,
      owner,
      ...(typeof raw.characterName === 'string' && raw.characterName.trim() ? { characterName: raw.characterName } : {}),
      createdAt: raw.createdAt,
      domainsCreated: normalizeDomains(raw.domainsCreated),
    };
  }
  return { schema: 1, entries };
}

/** 纯函数：upsert 一条索引记录（返回新索引，不改原对象）。 */
export function upsertIndexEntry(index: StorageIndex, entry: StorageIndexEntry): StorageIndex {
  const next: StorageIndex = { schema: 1, entries: { ...index.entries } };
  const prev = next.entries[entry.storageId];
  // 保留更全的 domainsCreated 与更早的 createdAt；owner/characterName 以新值为准（刷新）。
  next.entries[entry.storageId] = {
    ...entry,
    createdAt: prev ? Math.min(prev.createdAt, entry.createdAt) : entry.createdAt,
    domainsCreated: prev
      ? [...new Set([...prev.domainsCreated, ...entry.domainsCreated])]
      : [...entry.domainsCreated],
  };
  return next;
}

/** 纯函数：移除一条索引记录。 */
export function removeIndexEntry(index: StorageIndex, storageId: string): StorageIndex {
  const id = storageId.toLowerCase();
  if (!index.entries[id]) return index;
  const entries = { ...index.entries };
  delete entries[id];
  return { schema: 1, entries };
}

/** 纯函数：把「枚举发现的」条目并入索引（仅新增缺失项，不覆盖已有 owner/createdAt）。 */
export function mergeDiscoveredIntoIndex(index: StorageIndex, discovered: StorageIndexEntry[]): StorageIndex {
  let next = index;
  for (const entry of discovered) {
    if (!next.entries[entry.storageId]) next = upsertIndexEntry(next, entry);
  }
  return next;
}

async function readStorageIndex(files: ServerFileStore): Promise<StorageIndex> {
  const result = await files.readJson<unknown>(STORAGE_INDEX_FILENAME);
  if (!result.found) return cloneJson(EMPTY_INDEX);
  return normalizeStorageIndex(result.value);
}

async function writeStorageIndex(files: ServerFileStore, index: StorageIndex): Promise<boolean> {
  const result = await files.uploadJson(STORAGE_INDEX_FILENAME, index);
  return result.ok;
}

/**
 * best-effort upsert 并持久化。调用方应 fire-and-forget（`void touchStorageIndex(...).catch(()=>{})`）：
 * 仅在 storage 创建/fork 一次性时刻调用，绝不挂在写入热路径。任何错误都被吞掉，
 * 索引不可达不影响存储初始化与游玩。
 */
export async function touchStorageIndex(
  files: ServerFileStore,
  entry: StorageIndexEntry,
): Promise<boolean> {
  try {
    const current = await readStorageIndex(files);
    const next = upsertIndexEntry(current, entry);
    return await writeStorageIndex(files, next);
  } catch (_e) {
    return false;
  }
}

/** best-effort 移除并持久化。 */
export async function removeStorageIndexEntry(
  files: ServerFileStore,
  storageId: string,
): Promise<boolean> {
  try {
    const current = await readStorageIndex(files);
    const next = removeIndexEntry(current, storageId);
    return await writeStorageIndex(files, next);
  } catch (_e) {
    return false;
  }
}

/** 读全量索引（管理模块用）。失败返回空索引。 */
export async function loadStorageIndex(files: ServerFileStore): Promise<StorageIndex> {
  try {
    return await readStorageIndex(files);
  } catch (_e) {
    return cloneJson(EMPTY_INDEX);
  }
}

/** 把发现的条目并入并持久化（管理模块打开时刷新索引，使未来被删聊天的存储仍可被列出）。 */
export async function persistMergedIndex(
  files: ServerFileStore,
  index: StorageIndex,
  discovered: StorageIndexEntry[],
): Promise<StorageIndex> {
  try {
    const merged = mergeDiscoveredIntoIndex(index, discovered);
    if (merged !== index) await writeStorageIndex(files, merged);
    return merged;
  } catch (_e) {
    return index;
  }
}