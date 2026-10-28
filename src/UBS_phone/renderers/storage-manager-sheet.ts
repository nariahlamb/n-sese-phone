// ===== 全局手机存储管理弹层（设置 → 存储 → 「全局手机存储管理」，自挂载 overlay） =====
// 照 image-picker-sheet 模式：不依赖宿主 App 的 overlay 状态机，点背景关闭。
// 两相加载（主项目 storage-global-manager-popup 同款）：索引快相秒级上屏 → 枚举聊天引用补全
// （索引只在 storage 创建时登记一次，缺失项靠枚举兜底；见 core/phone-storage-manager 头注）。
// 列表 = 角色名 · 会话/消息数 · 更新时间 · 当前聊天标记；
// 操作 = 恢复到此聊天（matchCharacterOwner 前置校验 + 整值替换）/ 删除（两步确认，只删 usb_phone_* 文件）。

import type { CharacterRef } from '../../unified-statusbar/core/storage-global-manager';
import { createServerFileStore } from '../../unified-statusbar/core/server-file-store';
import { createStorageV3SillyHost } from '../../unified-statusbar/core/storage-v3-silly-host';
import type { MigrationChatRecord } from '../../unified-statusbar/core/storage-v3-silly-host';
import { hostWindow, phoneNotify } from '../core/host-env';
import { notifyPhoneMessagesChanged } from '../core/message-worldbook';
import { notifySpyRecordsChanged } from '../core/spy-worldbook';
import {
  currentPhoneStorageId,
  flushPhoneStore,
  replacePhoneData,
} from '../core/phone-store';
import {
  deletePhoneStorage,
  listPhoneStorages,
  restorePhoneStorageIntoCurrentChat,
  type PhoneStorageInfo,
} from '../core/phone-storage-manager';
import { escapeAttr, escapeHtml, pushSheetCloser, refreshPhone } from './phone-ui';
import { emitPhoneEvent } from './app-registry';

function nonEmpty(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s || null;
}

/** 当前聊天归属（恢复前置校验用；主项目 storage-global-manager-popup 同款读法）。 */
function currentChatOwner(): { kind: 'character' | 'group'; avatar?: string; name?: string } | null {
  try {
    const ctx = (hostWindow() as any).SillyTavern?.getContext?.();
    if (!ctx) return null;
    if (nonEmpty(ctx.groupId)) return { kind: 'group' };
    const cid = ctx.characterId;
    if (cid === undefined || cid === null || cid === '') return null;
    const ch = Array.isArray(ctx.characters) ? ctx.characters[Number(cid)] : null;
    return { kind: 'character', avatar: nonEmpty(ch?.avatar) || undefined, name: nonEmpty(ch?.name) || undefined };
  } catch (_e) {
    return null;
  }
}

async function fetchCharacters(): Promise<CharacterRef[]> {
  try {
    const ctx = (hostWindow() as any).SillyTavern?.getContext?.();
    const headers: Record<string, string> = typeof ctx?.getRequestHeaders === 'function'
      ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
    const response = await fetch('/api/characters/all', { method: 'POST', headers, credentials: 'same-origin' });
    if (!response.ok) return [];
    const list = await response.json();
    if (!Array.isArray(list)) return [];
    const out: CharacterRef[] = [];
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const avatar = nonEmpty((c as any).avatar);
      const name = nonEmpty((c as any).name);
      if (avatar && name) out.push({ avatar, name });
    }
    return out;
  } catch (_e) {
    return [];
  }
}

/** 慢相：枚举全部聊天（池化 6 并发，主项目同款实现）；失败返回空数组，快相结果照常可用。 */
async function fetchChatRecords(): Promise<MigrationChatRecord[]> {
  try {
    return await createStorageV3SillyHost().listChats();
  } catch (_e) {
    return [];
  }
}

function fmtTime(updatedAt: number | null): string {
  if (updatedAt == null || !Number.isFinite(updatedAt)) return '—';
  return new Date(updatedAt).toLocaleString();
}

/** 打开全局手机存储管理弹层（幂等：先移除同容器旧弹层）。onChanged = 数据被恢复/删除后通知设置页重绘。 */
export function openStorageManagerSheet(container: HTMLElement, onChanged: () => void): void {
  closeStorageManagerSheet(container);
  const doc = container.ownerDocument || document;
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-stormgr-sheet';

  let infos: PhoneStorageInfo[] = [];
  let charactersCache: CharacterRef[] = [];
  /** 两步删除确认：当前待确认的 storageId（点其它行/操作即取消）。 */
  let confirmDeleteSid = '';
  let busy = false;
  /** 加载相：fast=索引快相（秒级）；full=已并入聊天枚举兜底结果。 */
  let phase: 'fast' | 'full' = 'fast';

  overlay.innerHTML = `
    <div class="ubp-sheet" data-ubp-stormgrstop="1">
      <div class="ubp-sheet-title">全局手机存储管理</div>
      <div class="ubp-stormgr-intro">管理各聊天的手机数据文件：「恢复」把这份数据覆盖到当前聊天；「删除」清掉目标聊天的手机数据与备份。</div>
      <div class="ubp-stormgr-phase"></div>
      <div class="ubp-stormgr-list" id="ubp-stormgr-list"><div class="ubp-stormgr-empty">正在读取存储索引…</div></div>
      <div class="ubp-sheet-err" hidden></div>
      <div class="ubp-sheet-actions">
        <button class="ubp-btn primary" data-ubp-stormgr="close">完成</button>
      </div>
    </div>`;
  container.appendChild(overlay);
  pushSheetCloser(() => overlay.remove(), () => overlay.isConnected);

  const listEl = overlay.querySelector('#ubp-stormgr-list') as HTMLElement | null;
  const phaseEl = overlay.querySelector('.ubp-stormgr-phase') as HTMLElement | null;
  const errEl = overlay.querySelector('.ubp-sheet-err') as HTMLElement | null;
  const showErr = (text: string) => {
    if (!errEl) return;
    errEl.textContent = text;
    errEl.hidden = !text;
  };
  const setPhase = (text: string) => {
    if (phaseEl) phaseEl.textContent = text;
  };

  function renderList(): void {
    if (!listEl) return;
    if (!infos.length) {
      listEl.innerHTML = phase === 'fast'
        ? '<div class="ubp-stormgr-empty">索引中暂无小手机存储，正在核对全部聊天引用…</div>'
        : '<div class="ubp-stormgr-empty">未发现任何小手机存储（用过小手机的聊天才会生成数据文件）。</div>';
      return;
    }
    listEl.innerHTML = infos.map(s => {
      const currentBadge = s.isCurrent ? '<span class="ubp-stormgr-badge">当前</span>' : '';
      const restoreDisabled = s.isCurrent || busy ? ' disabled' : '';
      const deleteDisabled = s.isCurrent || busy ? ' disabled' : '';
      const deleteLabel = confirmDeleteSid === s.storageId ? '确认删除？' : '删除';
      return `<div class="ubp-stormgr-row${s.isCurrent ? ' current' : ''}" data-sid="${escapeAttr(s.storageId)}">
        <div class="ubp-stormgr-main">
          <span class="ubp-stormgr-name">${escapeHtml(s.characterName)}${currentBadge}</span>
          <span class="ubp-stormgr-meta">会话 ${s.conversations} · 消息 ${s.messages} · 更新 ${escapeHtml(fmtTime(s.updatedAt))}</span>
        </div>
        <div class="ubp-stormgr-acts">
          <button class="ubp-btn" data-ubp-stormgr="restore"${restoreDisabled}>恢复</button>
          <button class="ubp-btn${confirmDeleteSid === s.storageId ? ' danger' : ''}" data-ubp-stormgr="delete"${deleteDisabled}>${deleteLabel}</button>
        </div>
      </div>`;
    }).join('');
  }

  async function refresh(): Promise<void> {
    try {
      // 角色列表只拉一次（/api/characters/all 载荷较大），枚举与后续恢复校验共用
      const characters = await fetchCharacters();
      charactersCache = characters;
      // 快相：索引 + 当前聊天（秒级上屏，可看可操作）
      infos = await listPhoneStorages({
        files: createServerFileStore(),
        getCharacters: async () => characters,
        currentStorageId: currentPhoneStorageId() || null,
      });
      confirmDeleteSid = '';
      phase = 'fast';
      setPhase('索引快相已就绪，正在核对全部聊天引用…');
      renderList();
    } catch (error) {
      if (listEl) listEl.innerHTML = `<div class="ubp-stormgr-empty">读取失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
      return;
    }
    // 慢相：枚举全部聊天补全（索引只在 storage 创建时登记一次，索引外/漏登的 storageId 靠此发现）；
    // 枚举失败/为空保留快相结果，仅少一份完整性（phase 仍推进到 full，避免列表停在「正在核对…」）。
    try {
      const records = await fetchChatRecords();
      if (!records.length) {
        phase = 'full';
        setPhase('');
        renderList();
        return;
      }
      infos = await listPhoneStorages({
        files: createServerFileStore(),
        getCharacters: async () => charactersCache,
        currentStorageId: currentPhoneStorageId() || null,
        listChats: async () => records,
      });
      phase = 'full';
      setPhase(`已核对 ${records.length} 份聊天记录`);
      renderList();
    } catch (_e) {
      phase = 'full';
      setPhase('');
      renderList();
    }
  }
  void refresh();

  function applyRestored(): void {
    emitPhoneEvent('ubp-phone:data-changed'); // 悬浮球/桌面角标
    notifyPhoneMessagesChanged(); // 世界书投影按新数据收敛
    notifySpyRecordsChanged(); // 窥私投影按新数据收敛（整值替换含窥私记录）
    refreshPhone();
    onChanged();
  }

  overlay.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-ubp-stormgrstop]')) return;
    if (target.closest('[data-ubp-stormgr]')) return; // 行内按钮不视为点背景
    overlay.remove(); // 点背景关闭
    onChanged();
  });

  overlay.addEventListener('click', (event: Event) => {
    const btn = (event.target as HTMLElement).closest('[data-ubp-stormgr]') as HTMLElement | null;
    if (!btn || busy) return;
    const act = btn.dataset.ubpStormgr || '';
    if (act === 'close') {
      overlay.remove();
      onChanged();
      return;
    }
    const row = btn.closest<HTMLElement>('.ubp-stormgr-row');
    const sid = row?.dataset.sid || '';
    const info = infos.find(s => s.storageId === sid);
    if (!info) return;
    if (act === 'delete') {
      // 两步确认（设置页「清空」同款）：首次点=进入确认态，再点=执行；切目标/成功后复位
      if (confirmDeleteSid !== sid) {
        confirmDeleteSid = sid;
        renderList();
        return;
      }
      confirmDeleteSid = '';
      busy = true;
      renderList();
      void deletePhoneStorage(sid, {
        files: createServerFileStore(),
        currentStorageId: currentPhoneStorageId() || null,
      }).then(report => {
        busy = false;
        if (report.ok) {
          infos = infos.filter(s => s.storageId !== sid); // 乐观移除，避免重新枚举等待
          renderList();
          phoneNotify(`已删除 ${report.filesDeleted} 个文件`);
        } else {
          renderList();
          showErr(`删除部分失败：${report.errors[0] || '未知错误'}`);
        }
      }).catch((e: unknown) => {
        busy = false;
        renderList();
        showErr(`删除失败：${String((e as Error)?.message || e)}`);
      });
    } else if (act === 'restore') {
      if (info.isCurrent) return;
      busy = true;
      renderList();
      // 聊天归属快照（F2）：读目标文件 + 校验归属可能要数秒，期间切聊天必须中止——
      // 否则 replacePhoneData 会把**另一个角色**的整份手机数据清空替换成目标角色的，不可逆。
      const sidAtClick = currentPhoneStorageId();
      void restorePhoneStorageIntoCurrentChat(sid, {
        files: createServerFileStore(),
        current: currentChatOwner(),
        characters: charactersCache,
        apply: async data => {
          if (currentPhoneStorageId() !== sidAtClick) throw new Error('你已切换聊天，恢复已取消（当前数据未改动）');
          await flushPhoneStore();
          return replacePhoneData(data);
        },
      }).then(result => {
        busy = false;
        if (result.ok) {
          applyRestored();
          phoneNotify(result.warn ? `已恢复到当前聊天（${result.warn}）` : '已恢复到当前聊天');
        } else {
          renderList();
          showErr(result.error);
        }
      }).catch((e: unknown) => {
        busy = false;
        renderList();
        showErr(`恢复失败：${String((e as Error)?.message || e)}`);
      });
    }
  });
}

/** 移除容器内已存在的存储管理弹层。 */
export function closeStorageManagerSheet(container: HTMLElement): void {
  container.querySelector('.ubp-stormgr-sheet')?.remove();
}
