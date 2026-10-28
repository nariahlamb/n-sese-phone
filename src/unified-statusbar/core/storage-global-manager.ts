// ===== 统一状态栏 · 全局聊天外部存储管理 =====
//
// 设置 → 存储 → 「全局聊天外部存储管理」的核心逻辑：
//   - listExternalStorages：枚举所有现存外部存储（索引 ∪ 枚举聊天 ∪ forkSource），
//     读 envelope 元信息（角色卡/群组、保留层数、累计楼层、上次更新时间）。
//   - deleteExternalStorage：删指定 storageId 的全部域文件 + 备份 + 清引用聊天标记 + 清索引。
//   - restoreExternalStorageIntoCurrentChat：把目标存储的全量状态投影成 baseline 快照写入
//     当前聊天存储（绕过锚点不一致），前置头像优先+同名兜底的角色匹配。
//
// 性能：模块纯按需打开，枚举仅在打开时跑；不引入任何常态定时器或写入热路径开销。

import { isRecord } from './type-guards';
import {
  type ChatOwner,
  type ChatStorageDomain,
  normalizeChatStorageMeta,
} from './chat-storage-identity';
import { sha256Hex } from './external-storage-codec';
import { createPortraitPersistentStore } from './portrait-persistent-store';
import { verifyAndDeleteUserFiles,
  type ServerFileStore,
} from './server-file-store';
import { createStoryDomainStore, replayStoryDomainJournal, type StoryDomainJournal } from './story-domain-store';
import type { MigrationChatRecord } from './storage-v3-silly-host';
import {
  type StorageIndex,
  type StorageIndexEntry,
  loadStorageIndex,
  persistMergedIndex,
  removeStorageIndexEntry,
} from './storage-global-index';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CharacterRef {
  avatar: string;
  name: string;
}

export type MatchResult =
  | { ok: true; warn?: string }
  | { ok: false; reason: string };

/**
 * 纯函数：重关联前置角色匹配。
 *  - 目标为角色卡：avatar 相同 ⇒ 放行；avatar 不同但解析到的角色名相同 ⇒ 放行+警示；否则拒绝。
 *  - 目标为群组：当前须同为群组（群组无角色名，仅校验同类），放行+警示；否则拒绝。
 */
export function matchCharacterOwner(
  current: { kind: 'character' | 'group'; avatar?: string; name?: string } | null,
  targetOwner: ChatOwner,
  characters: CharacterRef[],
): MatchResult {
  if (targetOwner.kind === 'group') {
    if (current?.kind !== 'group') {
      return { ok: false, reason: '目标存储属于群组，当前聊天不是群组，无法重关联' };
    }
    return { ok: true, warn: '群组存储无角色名，仅校验同为群组即放行' };
  }
  if (current?.kind !== 'character' || !current.avatar || !current.name) {
    return { ok: false, reason: '当前聊天不是角色卡聊天，无法重关联角色卡存储' };
  }
  const targetName = characters.find(c => c.avatar === targetOwner.avatar)?.name || '';
  if (targetOwner.avatar === current.avatar) return { ok: true };
  if (targetName && targetName === current.name) {
    return { ok: true, warn: `头像不同但角色名相同（${current.name}），已放行；请确认确为同一张角色卡` };
  }
  return {
    ok: false,
    reason: targetName
      ? `角色不匹配：目标属于「${targetName}」，当前是「${current.name}」`
      : '角色不匹配，且无法解析目标存储的角色卡',
  };
}

/**
 * 纯函数：把 journal 投影成全量快照（baseline ∘ 全部 entries），即「最新层全量状态」。
 * 恢复时写入当前聊天的 baseline，绕开锚点不一致。
 */
export function projectSnapshot(journal: StoryDomainJournal): Record<string, unknown> {
  return replayStoryDomainJournal(journal);
}

interface BackupIndex {
  backups?: Array<{ file?: unknown }>;
}

/**
 * 纯函数：推导单个 storageId 的全部候选文件名（存在与否由 verify 阶段确认）。
 * backupIndex 为该 storageId 的 usb_bakidx_<h>.json 内容（可选），用于补全备份快照文件名。
 */
export function buildStorageCandidateFiles(storageId: string, backupIndex: BackupIndex | null = null): string[] {
  const hash = sha256Hex(storageId).slice(0, 24);
  const files = new Set<string>([
    `usb_story_core_${hash}.json`,
    `usb_story_map_${hash}.json`,
    `usb_portraits_${hash}.json`,
    `usb_portraits_${hash}.bak.json`,
    `usb_bakidx_${hash}.json`,
  ]);
  if (backupIndex && Array.isArray(backupIndex.backups)) {
    for (const backup of backupIndex.backups) {
      if (isRecord(backup) && typeof backup.file === 'string' && backup.file.startsWith('usb_')) {
        files.add(backup.file);
      }
    }
  }
  return [...files];
}

/** 从枚举聊天记录里收集所有引用的 storageId（含 forkSource）与引用 chatId 映射。 */
export function storageIdsFromRecords(records: MigrationChatRecord[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const record of records) {
    const raw = isRecord(record.metadata) ? (record.metadata as Record<string, unknown>).unifiedStatusbar : undefined;
    if (!isRecord(raw)) continue;
    const ids: string[] = [];
    if (typeof raw.storageId === 'string' && UUID_RE.test(raw.storageId)) ids.push(raw.storageId.toLowerCase());
    const fork = isRecord(raw.forkSource) ? raw.forkSource : undefined;
    if (fork && typeof fork.storageId === 'string' && UUID_RE.test(fork.storageId)) ids.push(fork.storageId.toLowerCase());
    for (const id of ids) {
      const list = map.get(id) || [];
      list.push(record.owner.chatId);
      map.set(id, list);
    }
  }
  return map;
}

interface EnvelopeMeta {
  owner: ChatOwner | null;
  updatedAt: number | null;
  revision: number;
  entriesLength: number;
}

async function readEnvelopeMeta(files: ServerFileStore, filename: string): Promise<EnvelopeMeta | null> {
  const result = await files.readJson<unknown>(filename);
  if (!result.found || !isRecord(result.value)) return null;
  const value = result.value;
  const ownerRaw = value.owner;
  const owner = isRecord(ownerRaw) && (ownerRaw.kind === 'character' || ownerRaw.kind === 'group')
    ? ownerRaw as unknown as ChatOwner
    : null;
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : null;
  const revision = typeof value.revision === 'number' && Number.isFinite(value.revision) ? value.revision : 0;
  const journalValue = isRecord(value.value) ? value.value : null;
  const entriesLength = journalValue && Array.isArray(journalValue.entries) ? journalValue.entries.length : 0;
  return { owner, updatedAt, revision, entriesLength };
}

export interface ExternalStorageInfo {
  storageId: string;
  owner: ChatOwner | null;
  characterName: string;
  isGroup: boolean;
  domainsCreated: ChatStorageDomain[];
  retainedLayers: number;
  cumulativeLayers: number;
  updatedAt: number | null;
  filesExist: boolean;
  referencedByChatId: string[];
  isCurrent: boolean;
}

export interface ListExternalStoragesDeps {
  files: ServerFileStore;
  /** 可省略：跳过聊天枚举的「快相」调用（候选=索引、引用计数全空）——弹窗两相渲染先用快相秒级上屏，再全量枚举对账。 */
  listChats?: () => Promise<MigrationChatRecord[]>;
  getCharacters: () => Promise<CharacterRef[]>;
  currentChat: () => { storageId: string | null; owner: ChatOwner | null; characterName: string | null } | null;
}

export interface ListExternalStoragesResult {
  storages: ExternalStorageInfo[];
  index: StorageIndex;
}

export async function listExternalStorages(deps: ListExternalStoragesDeps): Promise<ListExternalStoragesResult> {
  const [records, characters, index] = await Promise.all([
    deps.listChats ? deps.listChats() : Promise.resolve<MigrationChatRecord[]>([]),
    deps.getCharacters(),
    loadStorageIndex(deps.files),
  ]);
  const current = deps.currentChat();
  const currentStorageId = current?.storageId?.toLowerCase() || null;

  // 候选 storageId：枚举聊天引用（含 forkSource）∪ 索引条目。
  const referenced = storageIdsFromRecords(records);
  const candidateIds = new Set<string>([...referenced.keys(), ...Object.keys(index.entries)]);

  // 批量 verify 全部候选文件，确认哪些真实存在。
  const candidateFiles: string[] = [];
  const idToFileList = new Map<string, string[]>();
  for (const id of candidateIds) {
    const hash = sha256Hex(id).slice(0, 24);
    const files = [
      `usb_story_core_${hash}.json`,
      `usb_story_map_${hash}.json`,
      `usb_portraits_${hash}.json`,
    ];
    idToFileList.set(id, files);
    for (const f of files) candidateFiles.push(`/user/files/${f}`);
  }
  const existence = candidateFiles.length ? await deps.files.verify(candidateFiles) : {};
  const fileExists = (filename: string): boolean => existence[`/user/files/${filename}`] === true;

  const charNameByAvatar = new Map<string, string>();
  for (const c of characters) if (c.avatar) charNameByAvatar.set(c.avatar, c.name);

  // 并行读取所有存在域的 envelope 元信息。原实现逐存储串行 await 3 次 readEnvelopeMeta，
  // N 个存储 = 3N 次串行网络往返，是本模块加载慢的根因；此处改为一次并发批次
  // （verify 已批量确认存在性，这里只对存在的文件发起读取，结果按 id+domain 装回）。
  type DomainKey = 'core' | 'map' | 'portrait';
  const readPlan: Array<{ id: string; domain: DomainKey; file: string }> = [];
  for (const id of candidateIds) {
    const hash = sha256Hex(id).slice(0, 24);
    if (fileExists(`usb_story_core_${hash}.json`)) readPlan.push({ id, domain: 'core', file: `usb_story_core_${hash}.json` });
    if (fileExists(`usb_story_map_${hash}.json`)) readPlan.push({ id, domain: 'map', file: `usb_story_map_${hash}.json` });
    if (fileExists(`usb_portraits_${hash}.json`)) readPlan.push({ id, domain: 'portrait', file: `usb_portraits_${hash}.json` });
  }
  const metaByDomain = new Map<string, Partial<Record<DomainKey, EnvelopeMeta>>>();
  if (readPlan.length) {
    const results = await Promise.all(
      readPlan.map(async ({ id, domain, file }) => {
        const meta = await readEnvelopeMeta(deps.files, file);
        return { id, domain, meta };
      }),
    );
    for (const { id, domain, meta } of results) {
      let entry = metaByDomain.get(id);
      if (!entry) { entry = {}; metaByDomain.set(id, entry); }
      if (meta) entry[domain] = meta;
    }
  }

  const storages: ExternalStorageInfo[] = [];
  for (const id of candidateIds) {
    const hash = sha256Hex(id).slice(0, 24);
    const coreFile = `usb_story_core_${hash}.json`;
    const mapFile = `usb_story_map_${hash}.json`;
    const portraitFile = `usb_portraits_${hash}.json`;
    const coreExists = fileExists(coreFile);
    const mapExists = fileExists(mapFile);
    const portraitExists = fileExists(portraitFile);
    const filesExist = coreExists || mapExists || portraitExists;

    const domainsCreated: ChatStorageDomain[] = [];
    if (coreExists) domainsCreated.push('story-core');
    if (mapExists) domainsCreated.push('story-map');
    if (portraitExists) domainsCreated.push('portraits');

    const metas = metaByDomain.get(id) || {};
    const coreMeta = metas.core;
    const mapMeta = metas.map;
    const portraitMeta = metas.portrait;

    let owner: ChatOwner | null = null;
    let updatedAt: number | null = null;
    let retainedLayers = 0;
    let cumulativeLayers = 0;
    if (coreMeta) {
      owner = coreMeta.owner;
      updatedAt = coreMeta.updatedAt;
      retainedLayers = Math.max(retainedLayers, coreMeta.entriesLength);
      cumulativeLayers = Math.max(cumulativeLayers, coreMeta.revision);
    }
    if (mapMeta) {
      owner = owner || mapMeta.owner;
      updatedAt = (updatedAt == null) ? mapMeta.updatedAt : Math.max(updatedAt, mapMeta.updatedAt ?? updatedAt);
      retainedLayers = Math.max(retainedLayers, mapMeta.entriesLength);
      cumulativeLayers = Math.max(cumulativeLayers, mapMeta.revision);
    }
    if (!owner && portraitMeta) {
      owner = portraitMeta.owner;
      if (updatedAt == null) updatedAt = portraitMeta.updatedAt ?? null;
    }

    // 角色名：envelope owner.avatar → 角色列表；失败回退索引快照；再失败「未知」/「群组」。
    let characterName: string;
    const isGroup = owner?.kind === 'group';
    if (isGroup) {
      characterName = '群组';
    } else if (owner?.kind === 'character' && charNameByAvatar.has(owner.avatar)) {
      characterName = charNameByAvatar.get(owner.avatar)!;
    } else {
      const indexEntry = index.entries[id];
      characterName = indexEntry?.characterName || (owner?.kind === 'character' ? '未知角色' : '未知');
    }

    storages.push({
      storageId: id,
      owner,
      characterName,
      isGroup,
      domainsCreated,
      retainedLayers,
      cumulativeLayers,
      updatedAt,
      filesExist,
      referencedByChatId: referenced.get(id) || [],
      isCurrent: id === currentStorageId,
    });
  }

  // 排序：当前聊天置顶，之后按更新时间倒序，无更新时间的靠后。
  storages.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const ta = a.updatedAt ?? 0;
    const tb = b.updatedAt ?? 0;
    if (ta !== tb) return tb - ta;
    return a.characterName.localeCompare(b.characterName);
  });

  // 把枚举发现（仍被存活聊天引用的）并入索引并持久化，使未来被删聊天的存储仍可被列出。
  const discovered: StorageIndexEntry[] = [];
  for (const [id, chatIds] of referenced) {
    if (index.entries[id]) continue;
    const record = records.find(r => r.owner.chatId === chatIds[0]);
    if (!record) continue;
    const meta = normalizeChatStorageMeta(isRecord(record.metadata) ? record.metadata.unifiedStatusbar : undefined);
    if (!meta) continue;
    discovered.push({
      storageId: id,
      owner: record.owner,
      ...(record.characterName ? { characterName: record.characterName } : {}),
      createdAt: Date.now(),
      domainsCreated: meta.domainsCreated,
    });
  }
  const mergedIndex = await persistMergedIndex(deps.files, index, discovered);

  return { storages, index: mergedIndex };
}

export interface DeleteExternalStorageDeps {
  files: ServerFileStore;
  listChats: () => Promise<MigrationChatRecord[]>;
  saveChatWithoutMeta: (record: MigrationChatRecord) => Promise<boolean>;
  currentStorageId: string | null;
}

export interface DeleteExternalStorageReport {
  ok: boolean;
  filesDeleted: number;
  filesFailed: number;
  chatsStripped: number;
  chatsFailed: number;
  errors: string[];
}

export async function deleteExternalStorage(
  storageId: string,
  deps: DeleteExternalStorageDeps,
): Promise<DeleteExternalStorageReport> {
  const id = storageId.toLowerCase();
  const report: DeleteExternalStorageReport = {
    ok: true, filesDeleted: 0, filesFailed: 0, chatsStripped: 0, chatsFailed: 0, errors: [],
  };
  if (id === deps.currentStorageId) {
    return { ...report, ok: false, errors: ['不能删除当前聊天自己的存储，请用「重置聊天存储」'] };
  }

  const hash = sha256Hex(id).slice(0, 24);
  // 备份索引内容用于补全快照文件名。
  const bakidxResult = await deps.files.readJson<BackupIndex>(`usb_bakidx_${hash}.json`);
  const backupIndex = bakidxResult.found && isRecord(bakidxResult.value) ? bakidxResult.value as BackupIndex : null;
  const candidates = buildStorageCandidateFiles(id, backupIndex);

  // verify 哪些真实存在再删（delete 对 404 幂等，但避免无谓请求）。U50：三件套收编 server-file-store
  const deletion = await verifyAndDeleteUserFiles(deps.files, candidates);
  report.filesDeleted += deletion.deleted;
  report.filesFailed += deletion.failed;
  report.errors.push(...deletion.errors);

  // 清引用该 storageId 的存活聊天标记。
  const records = await deps.listChats();
  for (const record of records) {
    const raw = isRecord(record.metadata) ? record.metadata.unifiedStatusbar : undefined;
    if (!isRecord(raw)) continue;
    const sid = typeof raw.storageId === 'string' ? raw.storageId.toLowerCase() : '';
    const fork = isRecord(raw.forkSource) && typeof raw.forkSource.storageId === 'string'
      ? raw.forkSource.storageId.toLowerCase() : '';
    if (sid !== id && fork !== id) continue;
    const chat = record.chat;
    if (Array.isArray(chat) && isRecord(chat[0]) && isRecord(chat[0].chat_metadata)) {
      delete chat[0].chat_metadata.unifiedStatusbar;
      try {
        if (await deps.saveChatWithoutMeta(record)) report.chatsStripped += 1;
        else { report.chatsFailed += 1; report.errors.push(`聊天 ${record.owner.chatId} 标记写回未确认`); }
      } catch (error) {
        report.chatsFailed += 1;
        report.errors.push(`聊天 ${record.owner.chatId} 标记清除失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // 清索引条目（best-effort）。
  await removeStorageIndexEntry(deps.files, id);

  if (report.filesFailed || report.chatsFailed) report.ok = false;
  return report;
}

export interface ExternalStoreBundleLike {
  domains: {
    core: { restoreJournal(journal: StoryDomainJournal): Promise<{ ok: boolean; confirmed: boolean; error?: string }> };
    map: { restoreJournal(journal: StoryDomainJournal): Promise<{ ok: boolean; confirmed: boolean; error?: string }> };
  };
  portraits: { replaceAll(value: Record<string, unknown>): Promise<boolean> };
}

export interface RestoreExternalStorageDeps {
  files: ServerFileStore;
  getBundle: () => ExternalStoreBundleLike | null;
  now: () => number;
}

export interface RestoreExternalStorageResult {
  ok: boolean;
  error?: string;
  restoredDomains: ChatStorageDomain[];
}

function readOnlyStoryDomainStore(
  deps: RestoreExternalStorageDeps,
  storageId: string,
  owner: ChatOwner | null,
  domain: 'story-core' | 'story-map',
) {
  return createStoryDomainStore({
    files: deps.files,
    storageId,
    domain,
    owner: owner || { kind: 'group', chatId: 'unknown' },
    domainCreated: true,
    hasAnchoredHistory: false,
    getActiveAnchors: () => new Set(),
    now: deps.now,
    onDomainCreated: async () => true,
    onAnchoredHistory: async () => true,
  });
}

/**
 * 把目标外部存储的全量状态投影成 baseline 快照，写入当前聊天的存储（绕过锚点不一致）。
 *  - story-core/map：目标 readAll() = baseline ∘ 全部 entries → 当前 restoreJournal({baseline:快照, entries:[]})。
 *  - portraits：目标 readAll() → 当前 portraits.replaceAll(...)。
 *  - 仅恢复目标实际存在的域；缺失域保持当前聊天原值不动。
 * 调用前应已通过 matchCharacterOwner 校验、并 flushStatusbarStorage 排空当前 write-behind。
 */
export async function restoreExternalStorageIntoCurrentChat(
  storageId: string,
  deps: RestoreExternalStorageDeps,
): Promise<RestoreExternalStorageResult> {
  const id = storageId.toLowerCase();
  const bundle = deps.getBundle();
  if (!bundle?.domains?.core || !bundle?.domains?.map || !bundle?.portraits) {
    return { ok: false, error: '当前聊天存储未就绪，无法恢复', restoredDomains: [] };
  }

  const hash = sha256Hex(id).slice(0, 24);
  const coreFile = `usb_story_core_${hash}.json`;
  const mapFile = `usb_story_map_${hash}.json`;
  const portraitFile = `usb_portraits_${hash}.json`;

  // 读取目标 envelope owner（用于构造只读 store）。
  const coreMeta = await readEnvelopeMeta(deps.files, coreFile);
  const mapMeta = await readEnvelopeMeta(deps.files, mapFile);
  const portraitMeta = await readEnvelopeMeta(deps.files, portraitFile);
  const targetOwner = coreMeta?.owner || mapMeta?.owner || portraitMeta?.owner || null;

  const restoredDomains: ChatStorageDomain[] = [];

  if (coreMeta) {
    const store = readOnlyStoryDomainStore(deps, id, targetOwner, 'story-core');
    const status = await store.load();
    if (status.state !== 'ready') return { ok: false, error: `目标剧情存储不可读（${status.state}）`, restoredDomains };
    const snapshot = projectSnapshot(store.exportJournal());
    const result = await bundle.domains.core.restoreJournal({ baseline: snapshot, entries: [] });
    if (!result.ok || !result.confirmed) {
      return { ok: false, error: `恢复剧情存储失败：${result.error || '未确认'}`, restoredDomains };
    }
    restoredDomains.push('story-core');
  }

  if (mapMeta) {
    const store = readOnlyStoryDomainStore(deps, id, targetOwner, 'story-map');
    const status = await store.load();
    if (status.state === 'ready') {
      const snapshot = projectSnapshot(store.exportJournal());
      const result = await bundle.domains.map.restoreJournal({ baseline: snapshot, entries: [] });
      if (result.ok && result.confirmed) restoredDomains.push('story-map');
    }
  }

  if (portraitMeta) {
    const store = createPortraitPersistentStore({
      files: deps.files,
      storageId: id,
      owner: targetOwner || { kind: 'group', chatId: 'unknown' },
      domainCreated: true,
      now: deps.now,
      onDomainCreated: async () => true,
    });
    const status = await store.load();
    if (status.state === 'ready') {
      const ok = await bundle.portraits.replaceAll(store.readAll());
      if (ok) restoredDomains.push('portraits');
    }
  }

  if (!restoredDomains.length) {
    return { ok: false, error: '目标存储没有可恢复的域文件', restoredDomains };
  }
  return { ok: true, restoredDomains };
}