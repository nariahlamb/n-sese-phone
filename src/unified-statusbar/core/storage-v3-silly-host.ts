import { isRecord } from './type-guards';
import { type ChatOwner, normalizeChatStorageMeta, type ChatStorageMeta } from './chat-storage-identity';
import { cloneJson, stableStringify } from './external-storage-codec';
import { sillyTavernRoot } from './env';

/**
 * 一条聊天的只读快照（owner + chat 数组 + metadata + 角色名）。
 * 由 listChats 枚举产出，供存储彻底重置 / 全局外部存储管理消费。
 */
export interface MigrationChatRecord {
  owner: ChatOwner;
  chat: unknown[];
  metadata: Record<string, unknown>;
  characterName?: string;
}

/**
 * 酒馆后端聊天读写适配器：枚举所有聊天 + 把更新后的 metadata 写回并确认。
 * 实现见 createStorageV3SillyHost。
 */
export interface MigrationChatWriter {
  listChats(): Promise<MigrationChatRecord[]>;
  saveAndReadMeta(chat: MigrationChatRecord, meta: ChatStorageMeta): Promise<boolean>;
}

interface FetchResponseLike { ok: boolean; json(): Promise<unknown> }
type FetchLike = (url: string, init: RequestInit) => Promise<FetchResponseLike>;

/** 聊天枚举并发度（对酒馆本机 API 足够温和，又能把 N+M 次串行往返压缩 ~6 倍）。 */
const LIST_CONCURRENCY = 6;

/** 保序并发池：items 逐个经 worker 处理，最多 limit 个在途，结果按下标回填。 */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function chatIdFromListItem(value: unknown): string {
  if (!isRecord(value)) return '';
  const direct = stringValue(value.file_id);
  return direct || stringValue(value.file_name).replace(/\.jsonl$/i, '');
}

function metadataFromChat(chat: unknown): Record<string, unknown> {
  if (!Array.isArray(chat) || !isRecord(chat[0]) || !isRecord(chat[0].chat_metadata)) return {};
  return cloneJson(chat[0].chat_metadata);
}

function defaultHeaders(): Record<string, string> {
  try {
    // U32：双窗根探测收编（解包保留本地——下方还有 st?.getRequestHeaders 二次兜底）
    const st = sillyTavernRoot();
    const context = typeof st?.getContext === 'function' ? st.getContext() : st;
    if (typeof context?.getRequestHeaders === 'function') return context.getRequestHeaders();
    if (typeof st?.getRequestHeaders === 'function') return st.getRequestHeaders();
  } catch (_e) { /* handled below */ }
  return { 'Content-Type': 'application/json' };
}

export function createStorageV3SillyHost(
  fetchFn: FetchLike = ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>),
  headers: () => Record<string, string> = defaultHeaders,
): MigrationChatWriter {
  const post = async (url: string, body?: unknown): Promise<unknown> => {
    const response = await fetchFn(url, {
      method: 'POST', headers: headers(), cache: 'no-cache',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${url} 请求失败`);
    return response.json();
  };

  const readChat = async (owner: MigrationChatRecord['owner']): Promise<unknown[]> => {
    const payload = owner.kind === 'character'
      ? await post('/api/chats/get', { avatar_url: owner.avatar, file_name: owner.chatId })
      : await post('/api/chats/group/get', { id: owner.chatId });
    if (!Array.isArray(payload)) throw new Error(`聊天 ${owner.chatId} 格式无效`);
    return payload;
  };

  return {
    async listChats(): Promise<MigrationChatRecord[]> {
      const output: MigrationChatRecord[] = [];
      const characters = await post('/api/characters/all');
      if (!Array.isArray(characters)) throw new Error('角色列表格式无效');
      // 并发枚举：原实现逐角色列聊天 + 逐聊天读记录全串行（N 角色 M 聊天 = N+M 次串行往返，
      // 每次还整份下载聊天记录），是「全局聊天外部存储管理」加载慢的根因。
      // 池化 6 并发 + 保序回收；单聊天读失败跳过（原实现一个坏聊天会废掉整个枚举）。
      const validCharacters = characters.filter(isRecord);
      const perCharacter = await mapPool(validCharacters, LIST_CONCURRENCY, async rawCharacter => {
        const avatar = stringValue(rawCharacter.avatar);
        if (!avatar) return [];
        const listed = await post('/api/characters/chats', { avatar_url: avatar, simple: true });
        if (!Array.isArray(listed)) return [];
        const records: MigrationChatRecord[] = [];
        for (const rawChat of listed) {
          const chatId = chatIdFromListItem(rawChat);
          if (!chatId) continue;
          const owner = { kind: 'character' as const, avatar, chatId };
          try {
            const chat = await readChat(owner);
            records.push({ owner, chat, metadata: metadataFromChat(chat), characterName: stringValue(rawCharacter.name) });
          } catch (_e) { /* 单聊天读失败：跳过，枚举尽力而为 */ }
        }
        return records;
      });
      for (const records of perCharacter) output.push(...records);
      const groups = await post('/api/groups/all');
      if (!Array.isArray(groups)) throw new Error('群组列表格式无效');
      const groupChatIds = new Set<string>();
      for (const group of groups) {
        if (!isRecord(group)) continue;
        const direct = stringValue(group.chat_id);
        if (direct) groupChatIds.add(direct);
        if (Array.isArray(group.chats)) for (const value of group.chats) {
          const chatId = stringValue(value).replace(/\.jsonl$/i, '');
          if (chatId) groupChatIds.add(chatId);
        }
      }
      const groupRecords = await mapPool([...groupChatIds], LIST_CONCURRENCY, async chatId => {
        const owner = { kind: 'group' as const, chatId };
        try {
          const chat = await readChat(owner);
          return { owner, chat, metadata: metadataFromChat(chat) } as MigrationChatRecord;
        } catch (_e) { /* 单群组读失败：跳过 */ }
        return null;
      });
      for (const record of groupRecords) if (record) output.push(record);
      return output;
    },

    async saveAndReadMeta(record: MigrationChatRecord, meta: ChatStorageMeta): Promise<boolean> {
      const chat = cloneJson(record.chat) as unknown[];
      if (!Array.isArray(chat) || !isRecord(chat[0])) return false;
      const currentMetadata = isRecord(chat[0].chat_metadata) ? chat[0].chat_metadata : {};
      chat[0] = {
        ...chat[0],
        chat_metadata: { ...currentMetadata, unifiedStatusbar: cloneJson(meta) },
      };
      const url = record.owner.kind === 'character' ? '/api/chats/save' : '/api/chats/group/save';
      const body = record.owner.kind === 'character'
        ? {
            ch_name: record.characterName || record.owner.avatar,
            file_name: record.owner.chatId,
            avatar_url: record.owner.avatar,
            chat,
            force: false,
          }
        : { id: record.owner.chatId, chat, force: false };
      await post(url, body);
      const readback = await readChat(record.owner);
      const actual = normalizeChatStorageMeta(metadataFromChat(readback).unifiedStatusbar);
      const expected = normalizeChatStorageMeta(meta);
      if (!actual || !expected || stableStringify(actual) !== stableStringify(expected)) return false;
      record.chat = readback;
      record.metadata = metadataFromChat(readback);
      return true;
    },
  };
}
