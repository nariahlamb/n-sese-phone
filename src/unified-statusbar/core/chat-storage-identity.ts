import { isRecord } from './type-guards';
import { sha256Hex, stableStringify } from './external-storage-codec';

export type ChatStorageDomain = 'story-core' | 'story-map' | 'portraits';

export interface CharacterChatOwner {
  kind: 'character';
  avatar: string;
  chatId: string;
}

export interface GroupChatOwner {
  kind: 'group';
  chatId: string;
}

export type ChatOwner = CharacterChatOwner | GroupChatOwner;

export interface ChatStorageMeta {
  storageId: string;
  schema: 3;
  domainsCreated: ChatStorageDomain[];
  hasAnchoredHistory: boolean;
  forkSource?: {
    storageId: string;
    owner: ChatOwner;
    domainsCreated: ChatStorageDomain[];
    hasAnchoredHistory: boolean;
  };
}

export type ChatDescriptor = ChatOwner & { metadata: Record<string, unknown> };

export type OwnerExistence = 'exists' | 'missing' | 'unknown';

export type SaveAndReadMetaResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface ChatStorageIdentityHost {
  getCurrent(): ChatDescriptor | null;
  saveAndReadMeta(meta: ChatStorageMeta): Promise<SaveAndReadMetaResult>;
  ownerExists(owner: ChatOwner): Promise<OwnerExistence>;
}

export type ChatStorageIdentityResult =
  | { kind: 'no-context' }
  | {
      kind: 'ready';
      storageId: string;
      meta: ChatStorageMeta;
      owner: ChatOwner;
      ownerAction: 'same' | 'created' | 'renamed';
    }
  | {
      kind: 'fork-required';
      parentStorageId: string;
      parentOwner: ChatOwner;
      currentOwner: ChatOwner;
      meta: ChatStorageMeta;
    }
  | {
      kind: 'read-only';
      error: string;
      /** 仅「校验本聊天自身域文件失败」（inspect-owner 路径）时携带：该 storageId 属于本聊天，允许用户主动重置。 */
      storageId?: string;
    };

export interface ResolveChatStorageIdentityOptions {
  makeUuid?: () => string;
  envelopeOwner?: ChatOwner | null;
  inspectOwner?: (storageId: string) => Promise<ChatOwner | null>;
}

const CHAT_STORAGE_DOMAINS: readonly ChatStorageDomain[] = [
  'story-core',
  'story-map',
  'portraits',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

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

export function normalizeChatStorageMeta(value: unknown): ChatStorageMeta | null {
  if (!isRecord(value)) return null;
  const storageId = normalizeUuid(value.storageId);
  if (!storageId || value.schema !== 3 || typeof value.hasAnchoredHistory !== 'boolean') return null;
  if (!Array.isArray(value.domainsCreated)) return null;

  const domainsCreated: ChatStorageDomain[] = [];
  for (const domain of value.domainsCreated) {
    if (typeof domain !== 'string' || !CHAT_STORAGE_DOMAINS.includes(domain as ChatStorageDomain)) return null;
    if (!domainsCreated.includes(domain as ChatStorageDomain)) domainsCreated.push(domain as ChatStorageDomain);
  }

  const meta: ChatStorageMeta = {
    storageId,
    schema: 3,
    domainsCreated,
    hasAnchoredHistory: value.hasAnchoredHistory,
  };
  if (value.forkSource !== undefined) {
    if (!isRecord(value.forkSource)) return null;
    const forkStorageId = normalizeUuid(value.forkSource.storageId);
    const forkOwner = normalizeOwner(value.forkSource.owner);
    const forkDomains = value.forkSource.domainsCreated;
    if (!forkStorageId || !forkOwner || !Array.isArray(forkDomains)
      || typeof value.forkSource.hasAnchoredHistory !== 'boolean') return null;
    const domainsCreated: ChatStorageDomain[] = [];
    for (const domain of forkDomains) {
      if (typeof domain !== 'string' || !CHAT_STORAGE_DOMAINS.includes(domain as ChatStorageDomain)) return null;
      if (!domainsCreated.includes(domain as ChatStorageDomain)) domainsCreated.push(domain as ChatStorageDomain);
    }
    meta.forkSource = {
      storageId: forkStorageId,
      owner: forkOwner,
      domainsCreated,
      hasAnchoredHistory: value.forkSource.hasAnchoredHistory,
    };
  }
  return meta;
}

function currentOwner(descriptor: ChatDescriptor): ChatOwner | null {
  return normalizeOwner(descriptor);
}

function ownersEqual(left: ChatOwner, right: ChatOwner): boolean {
  if (left.kind !== right.kind || left.chatId !== right.chatId) return false;
  if (left.kind === 'character' && right.kind === 'character') return left.avatar === right.avatar;
  return true;
}

function metasEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeChatStorageMeta(left);
  const normalizedRight = normalizeChatStorageMeta(right);
  return Boolean(normalizedLeft && normalizedRight)
    && stableStringify(normalizedLeft) === stableStringify(normalizedRight);
}

function readNamespacedMeta(descriptor: ChatDescriptor): unknown {
  if (!isRecord(descriptor.metadata)) return undefined;
  return descriptor.metadata.unifiedStatusbar;
}

export function createChatStorageUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function chatStorageHash(storageId: string): string {
  const normalized = normalizeUuid(storageId);
  if (!normalized) throw new Error('Invalid chat storage UUID');
  return sha256Hex(normalized).slice(0, 24);
}

export async function resolveChatStorageIdentity(
  host: ChatStorageIdentityHost,
  options: ResolveChatStorageIdentityOptions = {},
): Promise<ChatStorageIdentityResult> {
  const descriptor = host.getCurrent();
  if (!descriptor) return { kind: 'no-context' };
  const owner = currentOwner(descriptor);
  if (!owner) return { kind: 'no-context' };

  const rawMeta = readNamespacedMeta(descriptor);
  let meta: ChatStorageMeta;
  let ownerAction: 'same' | 'created' = 'same';
  if (rawMeta === undefined) {
    const storageId = normalizeUuid((options.makeUuid ?? createChatStorageUuid)());
    if (!storageId) return { kind: 'read-only', error: 'Generated storage ID is not a valid UUID' };
    meta = {
      storageId,
      schema: 3,
      domainsCreated: [],
      hasAnchoredHistory: false,
    };
    const saved = await host.saveAndReadMeta(meta);
    if (!saved.ok || !metasEqual(saved.value, meta)) {
      return { kind: 'read-only', error: saved.ok ? 'Chat metadata readback mismatch' : saved.error };
    }
    const afterSave = host.getCurrent();
    const afterOwner = afterSave ? currentOwner(afterSave) : null;
    if (!afterSave || !afterOwner || !ownersEqual(afterOwner, owner) || !metasEqual(readNamespacedMeta(afterSave), meta)) {
      return { kind: 'read-only', error: 'Chat changed while saving storage identity' };
    }
    ownerAction = 'created';
  } else {
    const normalized = normalizeChatStorageMeta(rawMeta);
    if (!normalized) return { kind: 'read-only', error: 'Invalid unifiedStatusbar chat metadata' };
    meta = normalized;
  }

  let envelopeOwner = options.envelopeOwner ?? null;
  if (options.inspectOwner) {
    try {
      envelopeOwner = await options.inspectOwner(meta.storageId);
    } catch (error) {
      // 本聊天自身的域文件无法校验（损坏/读失败）：文件归属不明，但 storageId 来自
      // 本聊天元数据、确实属于本聊天——携带它以便 UI 提供「重置聊天存储」自救出口。
      return {
        kind: 'read-only',
        error: `Unable to inspect stored owner: ${String(error)}`,
        storageId: meta.storageId,
      };
    }
  }
  if (!envelopeOwner || ownersEqual(envelopeOwner, owner)) {
    return { kind: 'ready', storageId: meta.storageId, meta, owner, ownerAction };
  }

  const existence = await host.ownerExists(envelopeOwner);
  if (existence === 'missing') {
    return { kind: 'ready', storageId: meta.storageId, meta, owner, ownerAction: 'renamed' };
  }
  if (existence === 'exists') {
    return {
      kind: 'fork-required',
      parentStorageId: meta.storageId,
      parentOwner: envelopeOwner,
      currentOwner: owner,
      meta,
    };
  }
  return { kind: 'read-only', error: 'Unable to determine whether the previous chat owner still exists' };
}

async function updateMarker(
  host: ChatStorageIdentityHost,
  expectedStorageId: string,
  update: (meta: ChatStorageMeta) => ChatStorageMeta | null,
): Promise<boolean> {
  const expectedId = normalizeUuid(expectedStorageId);
  const before = host.getCurrent();
  const owner = before ? currentOwner(before) : null;
  const meta = before ? normalizeChatStorageMeta(readNamespacedMeta(before)) : null;
  if (!expectedId || !before || !owner || !meta || meta.storageId !== expectedId) return false;

  const next = update(meta);
  if (!next) return true;
  const saved = await host.saveAndReadMeta(next);
  if (!saved.ok || !metasEqual(saved.value, next)) return false;

  const after = host.getCurrent();
  const afterOwner = after ? currentOwner(after) : null;
  return Boolean(
    after
      && afterOwner
      && ownersEqual(owner, afterOwner)
      && metasEqual(readNamespacedMeta(after), next),
  );
}

export function saveChatStorageMeta(
  host: ChatStorageIdentityHost,
  expectedStorageId: string,
  next: ChatStorageMeta,
): Promise<boolean> {
  const normalizedNext = normalizeChatStorageMeta(next);
  if (!normalizedNext) return Promise.resolve(false);
  return updateMarker(host, expectedStorageId, current => (
    metasEqual(current, normalizedNext) ? null : normalizedNext
  ));
}

export function markChatDomainCreated(
  host: ChatStorageIdentityHost,
  expectedStorageId: string,
  domain: ChatStorageDomain,
): Promise<boolean> {
  if (!CHAT_STORAGE_DOMAINS.includes(domain)) return Promise.resolve(false);
  return updateMarker(host, expectedStorageId, meta => {
    if (meta.domainsCreated.includes(domain)) return null;
    return { ...meta, domainsCreated: [...meta.domainsCreated, domain] };
  });
}

export function markAnchoredHistory(
  host: ChatStorageIdentityHost,
  expectedStorageId: string,
): Promise<boolean> {
  return updateMarker(host, expectedStorageId, meta => (
    meta.hasAnchoredHistory ? null : { ...meta, hasAnchoredHistory: true }
  ));
}
