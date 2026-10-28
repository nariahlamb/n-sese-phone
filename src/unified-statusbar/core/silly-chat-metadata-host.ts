import { isRecord } from './type-guards';
import {
  type ChatDescriptor,
  type ChatOwner,
  type ChatStorageIdentityHost,
  type ChatStorageMeta,
  normalizeChatStorageMeta,
  type OwnerExistence,
  type SaveAndReadMetaResult,
} from './chat-storage-identity';
import { cloneJson, stableStringify } from './external-storage-codec';
import { sillyTavernContext } from './env';

interface CharacterLike {
  avatar?: unknown;
}

interface SillyChatContextLike {
  characterId?: unknown;
  groupId?: unknown;
  chatId?: unknown;
  characters?: unknown;
  groups?: unknown;
  chatMetadata?: unknown;
  saveChat?: unknown;
  getRequestHeaders?: unknown;
}

interface FetchResponseLike {
  ok: boolean;
  json(): Promise<unknown>;
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  cache?: string;
}) => Promise<FetchResponseLike>;

export interface SillyChatMetadataHostDeps {
  getContext?: () => SillyChatContextLike | null | undefined;
  fetchFn?: FetchLike;
}

function getDefaultContext(): SillyChatContextLike | null {
  // U32：双窗根探测 + null 解包改走规范口
  return sillyTavernContext() as SillyChatContextLike | null;
}

function getDefaultFetch(): FetchLike {
  return ((url: string, init: Parameters<FetchLike>[1]) => fetch(url, init as RequestInit)) as FetchLike;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function descriptorFromContext(context: SillyChatContextLike | null | undefined): ChatDescriptor | null {
  if (!context) return null;
  const chatId = nonEmptyString(context.chatId);
  if (!chatId) return null;

  const metadata = isRecord(context.chatMetadata) ? cloneJson(context.chatMetadata) : {};
  const groupId = nonEmptyString(context.groupId);
  if (groupId) return { kind: 'group', chatId, metadata };

  const characterId = context.characterId;
  if (characterId === undefined || characterId === null || characterId === '') return null;
  const characters = Array.isArray(context.characters) ? context.characters : [];
  const character = characters[Number(characterId)] as CharacterLike | undefined;
  const avatar = nonEmptyString(character?.avatar);
  if (!avatar) return null;
  return { kind: 'character', avatar, chatId, metadata };
}

function ownersEqual(left: ChatOwner | null, right: ChatOwner | null): boolean {
  if (!left || !right || left.kind !== right.kind || left.chatId !== right.chatId) return false;
  if (left.kind === 'character' && right.kind === 'character') return left.avatar === right.avatar;
  return true;
}

function ownerFromDescriptor(descriptor: ChatDescriptor | null): ChatOwner | null {
  if (!descriptor) return null;
  return descriptor.kind === 'character'
    ? { kind: 'character', avatar: descriptor.avatar, chatId: descriptor.chatId }
    : { kind: 'group', chatId: descriptor.chatId };
}

function requestHeaders(context: SillyChatContextLike | null | undefined): Record<string, string> {
  if (typeof context?.getRequestHeaders !== 'function') return { 'Content-Type': 'application/json' };
  const headers = context.getRequestHeaders();
  return isRecord(headers) ? headers as Record<string, string> : { 'Content-Type': 'application/json' };
}

function normalizedMetasEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeChatStorageMeta(left);
  const normalizedRight = normalizeChatStorageMeta(right);
  return Boolean(normalizedLeft && normalizedRight)
    && stableStringify(normalizedLeft) === stableStringify(normalizedRight);
}

function readHeaderMetadata(payload: unknown): unknown {
  if (!Array.isArray(payload) || !isRecord(payload[0])) return undefined;
  const headerMetadata = payload[0].chat_metadata;
  return isRecord(headerMetadata) ? headerMetadata.unifiedStatusbar : undefined;
}

function chatFileId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = nonEmptyString(value.file_id);
  if (direct) return direct;
  const fileName = nonEmptyString(value.file_name);
  return fileName ? fileName.replace(/\.jsonl$/i, '') : null;
}

export function createSillyChatMetadataHost(
  deps: SillyChatMetadataHostDeps = {},
): ChatStorageIdentityHost {
  const getContext = deps.getContext ?? getDefaultContext;
  const fetchFn = deps.fetchFn ?? getDefaultFetch();

  function getCurrent(): ChatDescriptor | null {
    return descriptorFromContext(getContext());
  }

  async function saveAndReadMeta(meta: ChatStorageMeta): Promise<SaveAndReadMetaResult> {
    const context = getContext();
    const before = descriptorFromContext(context);
    const owner = ownerFromDescriptor(before);
    if (!context || !before || !owner || !isRecord(context.chatMetadata) || typeof context.saveChat !== 'function') {
      return { ok: false, error: 'Current chat metadata is not writable' };
    }

    const chatMetadata = context.chatMetadata;
    const hadPrevious = Object.hasOwn(chatMetadata, 'unifiedStatusbar');
    const previous = hadPrevious ? cloneJson(chatMetadata.unifiedStatusbar) : undefined;
    const restore = () => {
      if (hadPrevious) chatMetadata.unifiedStatusbar = cloneJson(previous);
      else delete chatMetadata.unifiedStatusbar;
    };

    try {
      chatMetadata.unifiedStatusbar = cloneJson(meta);
      await context.saveChat();

      const currentBeforeReadback = ownerFromDescriptor(getCurrent());
      if (!ownersEqual(currentBeforeReadback, owner)) {
        restore();
        return { ok: false, error: 'Chat changed while saving metadata' };
      }

      const url = owner.kind === 'character' ? '/api/chats/get' : '/api/chats/group/get';
      const body = owner.kind === 'character'
        ? { avatar_url: owner.avatar, file_name: owner.chatId }
        : { id: owner.chatId };
      const response = await fetchFn(url, {
        method: 'POST',
        headers: requestHeaders(context),
        body: JSON.stringify(body),
        cache: 'no-cache',
      });
      if (!response.ok) {
        restore();
        return { ok: false, error: `Chat metadata readback failed (${url})` };
      }

      const payload = await response.json();
      const readback = readHeaderMetadata(payload);
      const currentAfterReadback = ownerFromDescriptor(getCurrent());
      if (!ownersEqual(currentAfterReadback, owner) || !normalizedMetasEqual(readback, meta)) {
        restore();
        return { ok: false, error: 'Chat metadata readback mismatch' };
      }
      return { ok: true, value: cloneJson(readback) };
    } catch (error) {
      restore();
      return { ok: false, error: `Unable to persist chat metadata: ${String(error)}` };
    }
  }

  async function ownerExists(owner: ChatOwner): Promise<OwnerExistence> {
    const context = getContext();
    try {
      if (owner.kind === 'character') {
        const response = await fetchFn('/api/characters/chats', {
          method: 'POST',
          headers: requestHeaders(context),
          body: JSON.stringify({ avatar_url: owner.avatar, simple: true }),
        });
        if (!response.ok) return 'unknown';
        const payload = await response.json();
        if (!Array.isArray(payload)) return 'unknown';
        return payload.some(item => chatFileId(item) === owner.chatId) ? 'exists' : 'missing';
      }

      const response = await fetchFn('/api/groups/all', {
        method: 'POST',
        headers: requestHeaders(context),
      });
      if (!response.ok) return 'unknown';
      const payload = await response.json();
      if (!Array.isArray(payload)) return 'unknown';
      const exists = payload.some(group => {
        if (!isRecord(group)) return false;
        if (nonEmptyString(group.chat_id) === owner.chatId) return true;
        return Array.isArray(group.chats) && group.chats.some(chatId => nonEmptyString(chatId) === owner.chatId);
      });
      return exists ? 'exists' : 'missing';
    } catch {
      return 'unknown';
    }
  }

  return { getCurrent, saveAndReadMeta, ownerExists };
}
