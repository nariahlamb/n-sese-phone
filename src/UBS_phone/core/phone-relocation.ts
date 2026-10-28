// ===== 小手机 · 一键搬家存储复制（经主项目 __ubStorageRelocation 桥注册） =====
//
// 背景：一键搬家（主项目 core/chat-relocation）为父聊天生成全新 storageId，只复制主项目三域
// （story-core/story-map/portraits）。小手机自有域 usb_phone_<hash>.json 不在其列——新聊天重绑
// 后读不到文件，用户感知为「搬家后小手机数据全没了」。本模块把父聊天的手机数据文件改签到新
// storageId 落盘，并补一条全局存储索引，使搬家前后手机数据连续。
//
// 有意不做（避免放大风险 / 语义不符）：
//   - 不复制备份快照族：快照内容内嵌 scopeHash 且恢复时与 storageId 严格校验（phone-backup
//     validSnapshot），改签必须重算 scopeHash+checksum 才算合法快照；新聊天首次自动备份即建立
//     自己的备份链，父聊天备份原样保留（可在「全局手机存储管理」恢复到任意聊天）。
//   - 不读写父聊天任何文件（只读其数据文件做来源）。
//
// 契约：best-effort。任何失败返回 false/抛错由主项目桥吞掉，绝不阻断搬家主流程。

import type { ChatOwner } from '../../unified-statusbar/core/chat-storage-identity';
import type { StorageRelocationCopyContext } from '../../unified-statusbar/core/storage-relocation-bridge';
import { checksumValue, cloneJson, stableStringify } from '../../unified-statusbar/core/external-storage-codec';
import { createServerFileStore, type ServerFileStore } from '../../unified-statusbar/core/server-file-store';
import { touchStorageIndex } from '../../unified-statusbar/core/storage-global-index';
import { hostWindow } from './host-env';
import { currentPhoneStorageId, flushPhoneStore, phoneStoreFilename } from './phone-store';
import { isRecord } from './ubp-utils';

/** 与 chat-storage-identity 同款 UUID 判据（phoneStoreFilename 对非 UUID 会抛错，此处先拦成 false）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 当前角色名（索引 characterName 快照用；搬家必在同角色聊天内进行，取当前上下文即父角色）。 */
function currentCharacterName(): string {
  try {
    const ctx = (hostWindow() as any).SillyTavern?.getContext?.();
    const cid = ctx?.characterId;
    if (cid === undefined || cid === null || cid === '') return '';
    const ch = Array.isArray(ctx?.characters) ? ctx.characters[Number(cid)] : null;
    return typeof ch?.name === 'string' ? ch.name.trim().slice(0, 120) : '';
  } catch (_e) {
    return '';
  }
}

/**
 * 把父聊天的手机数据文件改签到新 storageId（同一份 value，信封 scopeId/owner/checksum 全部重签）。
 * 返回是否已复制并落盘确认（false = 父聊天本就没有手机数据 / 读写未确认，调用方按空态处理）。
 */
export async function copyPhoneStorageForRelocation(
  context: StorageRelocationCopyContext,
  files: ServerFileStore = createServerFileStore(),
): Promise<boolean> {
  const parentId = String(context.parentStorageId || '').toLowerCase();
  const newId = String(context.newStorageId || '').toLowerCase();
  if (!UUID_PATTERN.test(parentId) || !UUID_PATTERN.test(newId) || parentId === newId) return false;

  // 父聊天即当前聊天时先排空 350ms 去抖写：复制到的必须是内存最新态而非磁盘旧态。
  try {
    if (currentPhoneStorageId().toLowerCase() === parentId) await flushPhoneStore();
  } catch (_e) { /* 排空失败仍尝试读磁盘（可能略旧但可用） */ }

  const read = await files.readJson<unknown>(phoneStoreFilename(parentId));
  if (!read.found || !isRecord(read.value)) return false;
  const rawValue = isRecord(read.value.value) ? read.value.value : null;
  if (!rawValue) return false;

  const rawRevision = read.value.revision;
  const rawUpdatedAt = read.value.updatedAt;
  const payload = {
    schema: 3,
    kind: 'phone',
    scopeId: newId,
    owner: cloneJson(context.newOwner) as unknown as ChatOwner,
    revision: Number.isInteger(rawRevision) ? Number(rawRevision) : 0,
    updatedAt: typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : Date.now(),
    value: cloneJson(rawValue),
  };
  const envelope = { ...payload, checksum: checksumValue(payload) };

  const target = phoneStoreFilename(newId);
  // 上传结果不作判据：一律以读回逐值比对为准（上传响应 ok=false 但文件已落盘的情形同样算成功）。
  await files.uploadJson(target, envelope);
  const readback = await files.readJson<unknown>(target);
  if (!readback.found || stableStringify(readback.value) !== stableStringify(envelope)) return false;

  // 全局存储索引：搬家新建的 storageId 无人在「storage 创建」时 touch（新聊天元数据已带 storageId，
  // 重绑走 ownerAction='same'），不补登则该聊天一旦关闭，手机存储就再也不会出现在「全局手机存储管理」。
  // 索引写失败不回滚复制（数据已落盘确认；索引只是可发现性补充）；此处 await 使搬家成为一次性
  // 确定性动作（复制器本身已被桥 best-effort 包裹，抛错不会阻断搬家）。
  const charName = currentCharacterName();
  try {
    await touchStorageIndex(files, {
      storageId: newId,
      owner: cloneJson(context.newOwner) as unknown as ChatOwner,
      ...(charName ? { characterName: charName } : {}),
      createdAt: Date.now(),
      domainsCreated: [],
    });
  } catch (_e) { /* best-effort：索引不可达不影响已复制的数据 */ }

  return true;
}

// ─── 主项目搬家桥注册（跨 bundle：window.__ubStorageRelocation） ───

interface StorageRelocationBridge {
  register: (copier: unknown) => unknown;
}

function findRelocationBridge(): StorageRelocationBridge | null {
  try {
    const bridge = (hostWindow() as any)?.__ubStorageRelocation;
    return bridge && typeof bridge.register === 'function' ? bridge : null;
  } catch (_e) {
    return null;
  }
}

let _registered = false;

/** 复制器是否已注册进主项目搬家桥（诊断用）。 */
export function isPhoneRelocationRegistered(): boolean {
  return _registered;
}

/** 搬家桥是否可用（就绪探测用：只读不注册）。 */
export function isPhoneRelocationBridgeAvailable(): boolean {
  return findRelocationBridge() !== null;
}

/** 幂等注册（桥不存在=false；主项目晚装载时由就绪广播/重试路径补注册）。 */
export function syncPhoneRelocationRegistration(): boolean {
  const bridge = findRelocationBridge();
  if (!bridge) {
    _registered = false;
    return false;
  }
  try {
    bridge.register(copyPhoneStorageForRelocation);
    _registered = true;
  } catch (_e) {
    _registered = false;
  }
  return _registered;
}

/** boot 调用一次：注册搬家复制器（幂等；就绪广播补注册，防主项目晚于小手机装载）。 */
export function bindPhoneRelocationCopy(): void {
  try {
    const w = hostWindow() as any;
    if (w && typeof w.addEventListener === 'function' && !w.__ubp_relocation_bound) {
      w.__ubp_relocation_bound = true;
      w.addEventListener('ub-storage-relocation-ready', () => { syncPhoneRelocationRegistration(); });
    }
  } catch (_e) { /* 宿主事件不可用：仅失去晚装载补注册，先装载场景仍已注册 */ }
  syncPhoneRelocationRegistration();
}
