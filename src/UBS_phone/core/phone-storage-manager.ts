// ===== 小手机 · 全局手机存储管理（设置 → 存储 → 「全局手机存储管理」） =====
//
// 机制对齐主项目 storage-global-manager，差别：
//   - 候选来源 = 主项目全局外部存储索引（usb_storage_index_v1.json，两项目共享同一 storageId
//     空间）∪ 枚举聊天引用（慢相）∪ 当前聊天。索引本身天然不全（只在 storage「创建」那一刻
//     登记一次）：索引功能上线前建的聊天、经 fork / 一键搬家新建的 storageId、索引写入竞争
//     丢项，都不会有条目——只看索引就会「显示不全」，父聊天数据明明还在磁盘上却列不出来。
//     故与主项目同款两相：先索引快相秒级上屏，再枚举聊天补全（快相结果始终可用）。
//   - 只管理 usb_phone_* 文件：删除不碰共享聊天元数据与索引条目（storageId 与主项目三域共享）。
//   - 恢复 = 目标手机数据整值替换当前聊天手机数据（前置 matchCharacterOwner 角色校验）。
//   - 纯孤儿（聊天已删 + 从未进索引）无目录列举 API 可发现，仍不可见（主项目同受限）。
//
// 性能：纯按需打开；快相一次批量 verify + 并行读信封；慢相枚举聊天（主项目 listChats 池化 6 并发）。
// 不引入任何常态开销。

import type { ChatOwner } from '../../unified-statusbar/core/chat-storage-identity';
import { normalizeChatStorageMeta } from '../../unified-statusbar/core/chat-storage-identity';
import {
  loadStorageIndex,
  persistMergedIndex,
  type StorageIndex,
  type StorageIndexEntry,
} from '../../unified-statusbar/core/storage-global-index';
import {
  matchCharacterOwner,
  storageIdsFromRecords,
  type CharacterRef,
  type MatchResult,
} from '../../unified-statusbar/core/storage-global-manager';
import type { ServerFileStore } from '../../unified-statusbar/core/server-file-store';
import type { MigrationChatRecord } from '../../unified-statusbar/core/storage-v3-silly-host';
import { normalizePhoneChatData, type PhoneChatData } from './chat-model';
import { phoneBackupIndexFilename } from './phone-backup';
import { phoneStoreFilename } from './phone-store';
import { isRecord } from './ubp-utils';

interface PhoneEnvelopeMeta {
  owner: ChatOwner | null;
  updatedAt: number | null;
  revision: number;
  conversations: number;
  messages: number;
}

function readEnvelopeMeta(value: unknown): PhoneEnvelopeMeta | null {
  if (!isRecord(value)) return null;
  const ownerRaw = value.owner;
  const owner = isRecord(ownerRaw) && (ownerRaw.kind === 'character' || ownerRaw.kind === 'group')
    ? ownerRaw as unknown as ChatOwner
    : null;
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : null;
  const revision = typeof value.revision === 'number' && Number.isFinite(value.revision) ? value.revision : 0;
  const raw = isRecord(value.value) ? value.value : {};
  const conversations = Array.isArray(raw.conversations) ? raw.conversations.length : 0;
  let messages = 0;
  if (Array.isArray(raw.conversations)) {
    for (const conv of raw.conversations) {
      if (isRecord(conv) && Array.isArray(conv.messages)) messages += conv.messages.length;
    }
  }
  return { owner, updatedAt, revision, conversations, messages };
}

export interface PhoneStorageInfo {
  storageId: string;
  owner: ChatOwner | null;
  characterName: string;
  isGroup: boolean;
  conversations: number;
  messages: number;
  updatedAt: number | null;
  isCurrent: boolean;
}

export interface ListPhoneStoragesDeps {
  files: ServerFileStore;
  /** 角色卡引用表（envelope owner.avatar → 角色名；缺省时回退索引快照名）。 */
  getCharacters?: () => Promise<CharacterRef[]>;
  currentStorageId: string | null;
  /** 可注入索引（测试用）；缺省从 usb_storage_index_v1.json 读取。 */
  loadIndex?: () => Promise<StorageIndex>;
  /**
   * 慢相兜底：枚举全部聊天记录（主项目 createStorageV3SillyHost().listChats()）。
   * 缺省=只按索引快相列出（秒级，但索引缺失项不可见）；提供时把「存活聊天引用的 storageId」
   * 并入候选，并把新发现条目持久化进索引（未来聊天被删仍可列出）。
   */
  listChats?: () => Promise<MigrationChatRecord[]>;
  /** 是否把枚举发现并入索引并落盘（缺省 true；仅 listChats 生效，测试可关）。 */
  persistIndex?: boolean;
}

export async function listPhoneStorages(deps: ListPhoneStoragesDeps): Promise<PhoneStorageInfo[]> {
  const [index, characters] = await Promise.all([
    deps.loadIndex ? deps.loadIndex() : loadStorageIndex(deps.files),
    deps.getCharacters ? deps.getCharacters() : Promise.resolve<CharacterRef[]>([]),
  ]);
  const currentStorageId = deps.currentStorageId?.toLowerCase() || null;

  // 慢相：枚举聊天记录（失败=空，快相结果照常可用），收集「存活聊天引用的 storageId」。
  const records = deps.listChats ? await deps.listChats().catch(() => [] as MigrationChatRecord[]) : [];
  const referenced = records.length ? storageIdsFromRecords(records) : new Map<string, string[]>();

  // 候选 = 索引条目 ∪ 存活聊天引用 ∪ 当前聊天；只列 usb_phone 文件真实存在的（从未用过手机的聊天不出现在列表）。
  const candidateIds = new Set<string>(Object.keys(index.entries).map(id => id.toLowerCase()));
  for (const id of referenced.keys()) candidateIds.add(id);
  if (currentStorageId) candidateIds.add(currentStorageId);

  const filenames = [...candidateIds].map(id => phoneStoreFilename(id));
  const existence = filenames.length
    ? await deps.files.verify(filenames.map(f => `/user/files/${f}`))
    : {};

  const charNameByAvatar = new Map<string, string>();
  for (const c of characters) if (c.avatar) charNameByAvatar.set(c.avatar, c.name);

  // 并行读所有存在文件的信封元信息（一次并发批次；串行 N 次往返是主项目初版加载慢的教训）。
  const existing = [...candidateIds].filter(id => existence[`/user/files/${phoneStoreFilename(id)}`] === true);
  const metaById = new Map<string, PhoneEnvelopeMeta | null>();
  if (existing.length) {
    const results = await Promise.all(existing.map(async id => {
      const read = await deps.files.readJson<unknown>(phoneStoreFilename(id));
      return { id, meta: read.found ? readEnvelopeMeta(read.value) : null };
    }));
    for (const { id, meta } of results) metaById.set(id, meta);
  }

  const infos: PhoneStorageInfo[] = [];
  for (const id of existing) {
    const meta = metaById.get(id) || null;
    const owner = meta?.owner || null;
    const indexEntry = index.entries[id];
    const isGroup = owner?.kind === 'group';
    let characterName: string;
    if (isGroup) {
      characterName = '群组';
    } else if (owner?.kind === 'character' && charNameByAvatar.has(owner.avatar)) {
      characterName = charNameByAvatar.get(owner.avatar)!;
    } else {
      characterName = indexEntry?.characterName || (owner?.kind === 'character' ? '未知角色' : '未知');
    }
    infos.push({
      storageId: id,
      owner,
      characterName,
      isGroup,
      conversations: meta?.conversations ?? 0,
      messages: meta?.messages ?? 0,
      updatedAt: meta?.updatedAt ?? null,
      isCurrent: id === currentStorageId,
    });
  }

  // 当前聊天置顶，之后按更新时间倒序。
  infos.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const ta = a.updatedAt ?? 0;
    const tb = b.updatedAt ?? 0;
    if (ta !== tb) return tb - ta;
    return a.characterName.localeCompare(b.characterName);
  });

  // 把枚举发现（仍被存活聊天引用的 storageId）并入索引并持久化：使索引在下一次打开时已含这些
  // 聊天，且它们未来被删后仍能被列出（对齐主项目 listExternalStorages 的 discovered 收敛）。
  if (referenced.size && deps.persistIndex !== false) {
    const discovered: StorageIndexEntry[] = [];
    for (const [id, chatIds] of referenced) {
      if (index.entries[id]) continue;
      const record = records.find(r => r.owner.chatId === chatIds[0]);
      if (!record) continue;
      const meta = normalizeChatStorageMeta(
        isRecord(record.metadata) ? record.metadata.unifiedStatusbar : undefined,
      );
      discovered.push({
        storageId: id,
        owner: record.owner,
        ...(record.characterName ? { characterName: record.characterName } : {}),
        createdAt: Date.now(),
        domainsCreated: meta?.domainsCreated ?? [],
      });
    }
    if (discovered.length) {
      // f-c：index 是慢相枚举**之前**读的，而枚举（listChats 列全部聊天）可能耗时数秒——期间状态栏
      // （或另一个标签页）可能已往**同一个共享索引文件** usb_storage_index_v1.json 写了新条目。
      // 用陈旧快照合并写回会把那些条目整条覆盖丢失（孤儿存储此后列不出、恢复不了），
      // 因为主项目 persistMergedIndex 只管合并、不重读磁盘。故合并前重读一次（注入的 loadIndex 同样走）。
      const fresh = deps.loadIndex ? await deps.loadIndex() : await loadStorageIndex(deps.files);
      await persistMergedIndex(deps.files, fresh, discovered);
    }
  }

  return infos;
}

export interface DeletePhoneStorageDeps {
  files: ServerFileStore;
  currentStorageId: string | null;
}

export interface DeletePhoneStorageReport {
  ok: boolean;
  filesDeleted: number;
  filesFailed: number;
  errors: string[];
}

/** 删除指定聊天的全部手机数据文件（数据文件 + 备份索引 + 备份快照）。不碰共享身份与索引。 */
export async function deletePhoneStorage(
  storageId: string,
  deps: DeletePhoneStorageDeps,
): Promise<DeletePhoneStorageReport> {
  const id = storageId.toLowerCase();
  const report: DeletePhoneStorageReport = { ok: true, filesDeleted: 0, filesFailed: 0, errors: [] };
  if (id === deps.currentStorageId?.toLowerCase()) {
    return { ...report, ok: false, errors: ['不能删除当前聊天自己的手机存储，请用「清空当前聊天的小手机数据」'] };
  }

  // 备份索引内容用于补全快照文件名（与主项目删除流程同款两步）。
  const bakidxResult = await deps.files.readJson<unknown>(phoneBackupIndexFilename(id));
  const candidates = new Set<string>([phoneStoreFilename(id), phoneBackupIndexFilename(id)]);
  if (bakidxResult.found && isRecord(bakidxResult.value) && Array.isArray(bakidxResult.value.backups)) {
    for (const backup of bakidxResult.value.backups) {
      if (isRecord(backup) && typeof backup.file === 'string' && backup.file.startsWith('usb_')) {
        candidates.add(backup.file);
      }
    }
  }

  const list = [...candidates];
  const existence = await deps.files.verify(list.map(f => `/user/files/${f}`));
  for (const filename of list) {
    if (existence[`/user/files/${filename}`] !== true) continue;
    const deleted = await deps.files.delete(`/user/files/${filename}`);
    if (deleted.ok) report.filesDeleted += 1;
    else {
      report.filesFailed += 1;
      report.errors.push(`删除 ${filename} 失败：${deleted.error || '未知'}`);
    }
  }
  if (report.filesFailed) report.ok = false;
  return report;
}

export interface RestorePhoneStorageDeps {
  files: ServerFileStore;
  /** 当前聊天归属（matchCharacterOwner 前置校验用）。 */
  current: { kind: 'character' | 'group'; avatar?: string; name?: string } | null;
  characters: CharacterRef[];
  /** 整值替换当前聊天手机数据（含 flush + 落盘确认；调用方负责成功后派发刷新事件）。 */
  apply: (data: PhoneChatData) => Promise<boolean>;
}

export type RestorePhoneStorageResult =
  | { ok: true; warn?: string }
  | { ok: false; error: string };

/** 把目标聊天的手机存储整值恢复到当前聊天（前置角色匹配；缺 owner 的旧文件拒绝恢复）。 */
export async function restorePhoneStorageIntoCurrentChat(
  storageId: string,
  deps: RestorePhoneStorageDeps,
): Promise<RestorePhoneStorageResult> {
  const id = storageId.toLowerCase();
  const read = await deps.files.readJson<unknown>(phoneStoreFilename(id));
  if (!read.found) return { ok: false, error: '目标手机存储文件不存在' };
  const meta = readEnvelopeMeta(read.value);
  const targetOwner = meta?.owner || null;
  if (!targetOwner) return { ok: false, error: '目标存储缺少归属信息，无法安全恢复' };

  const match: MatchResult = matchCharacterOwner(deps.current, targetOwner, deps.characters);
  if (!match.ok) return { ok: false, error: match.reason };

  const value = isRecord(read.value) && isRecord(read.value.value) ? read.value.value : null;
  if (!value) return { ok: false, error: '目标手机存储数据无效' };
  const data = normalizePhoneChatData(value);
  const applied = await deps.apply(data);
  if (!applied) return { ok: false, error: '恢复写入未确认，已保持当前数据不变' };
  return { ok: true, ...(match.warn ? { warn: match.warn } : {}) };
}
