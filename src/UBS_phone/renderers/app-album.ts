// ===== 相册 App：小手机全部生成图片的统一图库（docs/02 §7） =====
// 条目来自聊天图片与相机拍照（PhoneChatData.album，完整参数档案）；支持按来源/角色/收藏
// 筛选、查看大图与生图信息、编辑生图标签（重绘依据）、按档案重新生图（换一张）、
// 转发给通讯录角色、收藏（豁免循环清理）、删除（被聊天引用时拒绝）。
// 长按图片进批量删除/批量收藏：勾选若干张→删除所选或收藏所选；被聊天引用的条目跳过并提示
// （复用微信/窥私多选机制）。

import type { PhoneAlbumEntry } from '../core/chat-model';
import { albumFavbarState, albumSelbarState, albumSourceLabel, albumSourceOptions, deletePhoneAlbumEntries, deletePhoneAlbumEntry, forwardAlbumImageToContact, readPhoneAlbumRef, regenAlbumImage, setAlbumFavorite, setAlbumFavorites, updatePhoneAlbumEntry } from '../core/phone-album';
import { getRoster } from '../core/roster';
import { SOCIAL_ALBUM_SOURCES } from '../core/forward-model';
import { S, currentStyle } from '../core/skins';
import { isRecordReplayable, sanitizeImageGenRecord } from '../../unified-statusbar/core/image-gen';
import { emitPhoneEvent, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openConfirmSheet } from './action-sheet';
import { bindHintLongPress } from './hint-sheet';
import { openPickerSheet } from './picker-sheet';
import { escapeAttr, escapeHtml } from './phone-ui';
import { ubpIcon } from './icons';
import { openPhoneLightbox } from './image-lightbox';
import { hydrateGridThumbs } from './grid-thumbs';
import { emitAch } from '../core/phone-achievements';

let _ctx: PhoneAppContext | null = null;
let _sourceFilter = '';      // '' = 全部
let _charFilter = '';        // '' = 全部
let _favOnly = false;        // 只看收藏（与来源/角色筛选正交叠加）
let _openId: string | null = null;  // 详情弹层条目 id
let _editId: string | null = null;  // 标签编辑弹层条目 id（叠在详情弹层之上）
let _busyId: string | null = null;  // 重新生图进行中的条目
let _forwardId: string | null = null; // 转发弹层条目 id
let _deleteId: string | null = null; // 删除确认弹层条目 id
let _selectMode = false;            // 批量删除模式（长按图片进入）
let _selected = new Set<string>();  // 批量选中的相册条目 id
let _longPressFiredAt = 0;          // 长按触发时间戳：吞掉随后的 click（防首格选中态被立即翻转）
let _toast = '';
let _toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(text: string): void {
  _toast = text;
  render();
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    _toast = '';
    _toastTimer = null;
    if (_ctx) render();
  }, 2400);
}

function filteredEntries(all: PhoneAlbumEntry[] = readPhoneAlbumRef()): PhoneAlbumEntry[] {
  let list = all;
  if (_favOnly) list = list.filter(e => e.fav === true);
  if (_sourceFilter) list = list.filter(e => e.source === _sourceFilter);
  if (_charFilter) list = list.filter(e => e.characters.includes(_charFilter));
  return list;
}

function chipRow(act: string, current: string, options: Array<{ id: string; label: string }>): string {
  return options.map(o =>
    `<button type="button" class="ubp-chip${current === o.id ? ' on' : ''}" data-ubp-act="${act}" data-id="${escapeAttr(o.id)}">${escapeHtml(o.label)}</button>`,
  ).join('');
}

/** 角色筛选弹层（复用相机出镜角色同款选择器：搜索+单选即点即走；「全部角色」行清除筛选）。 */
function openCharFilter(): void {
  if (!_ctx) return;
  const names = Array.from(new Set(readPhoneAlbumRef().flatMap(e => e.characters)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  openPickerSheet(_ctx.container, {
    title: '按角色筛选',
    groups: names.length ? [{ key: 'chars', label: '角色', items: names.map(n => ({ id: n, label: n })) }] : [],
    selected: _charFilter ? [_charFilter] : [],
    clearLabel: '全部角色',
    searchPlaceholder: '搜索角色',
    emptyText: '相册暂无带角色标记的图片',
    onPick: id => {
      if (_charFilter === id) return;
      _charFilter = id;
      render();
    },
  });
}

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const all = readPhoneAlbumRef();
  const list = filteredEntries(all); // 帧内复用 all（同一同步流程不二次深拷贝；pumpImages 先例）
  const style = currentStyle();

  const sourceOptions = albumSourceOptions(style);
  const selbar = albumSelbarState(_selected, list);
  const favbar = albumFavbarState(_selected, list);

  const cells = list.map(e => {
    const on = _selectMode && _selected.has(e.id);
    // 网格显示缩略图（docs/70）：格子不带原图 src，hydrateGridThumbs 回填（命中缓存同步回填、
    // 滚入视口才生成、失败回落原图）；详情/编辑/放大页仍用原图，观感不变。
    return `
    <button type="button" class="ubp-album-cell${on ? ' picked' : ''}" data-ubp-act="open-entry" data-id="${escapeAttr(e.id)}" data-fav="${e.fav ? '1' : '0'}" title="${escapeAttr(e.desc || '')}">
      <img data-ubp-thumb="${escapeAttr(e.path)}" alt="" loading="lazy" decoding="async">
      <span class="ubp-album-src">${escapeHtml(albumSourceLabel(e.source, style))}</span>
      ${e.fav && !_selectMode ? `<span class="ubp-album-fav" title="${S('已收藏', '已珍藏')}">${ubpIcon('star')}</span>` : ''}
      ${e.characters.length ? `<span class="ubp-album-chars">${escapeHtml(e.characters.slice(0, 2).join('、'))}${e.characters.length > 2 ? '…' : ''}</span>` : ''}
      ${_selectMode ? `<span class="ubp-msg-check${on ? ' on' : ''}">${on ? '✓' : ''}</span>` : ''}
    </button>`;
  }).join('');

  const openEntry = _openId ? all.find(e => e.id === _openId) || null : null;
  const editEntry = _editId ? all.find(e => e.id === _editId) || null : null;
  // 全量重绘保滚动位置（铁律：任何 innerHTML 重建要么原地更新、要么重绘前后存/恢复 scrollTop；
  // 这里是「长按进批量模式」的必要重绘，滚动容器＝网格所在的 .ubp-appbody）
  const scrollTop = (container.querySelector('#ubp-album-scroll') as HTMLElement | null)?.scrollTop ?? 0;

  container.innerHTML = `
    <div class="ubp-appbar">
      ${_selectMode
        ? `<button class="ubp-iconbtn" data-ubp-act="sel-cancel" title="${S('取消', '作罢')}">${ubpIcon('back')}</button>
           <span class="ubp-appbar-title" id="ubp-sel-count">${S('已选', '已择')} ${_selected.size} ${S('项', '则')}</span>
           <span style="width:30px;"></span>`
        : `<button class="ubp-iconbtn" data-ubp-act="back" title="${S('返回', '返回')}">${ubpIcon('back')}</button>
           <span class="ubp-appbar-title">${S('相册', '影阁')}<span class="al-count">${all.length}</span></span>
           <span style="width:30px;"></span>`}
    </div>
    <div class="ubp-appbody noscroll">
      <div class="ubp-chat" style="flex:1;">
        <div class="ubp-appbody" id="ubp-album-scroll">
          ${_selectMode ? '' : `<div class="ubp-album-filters">
            <div class="ubp-chips">
              <button type="button" class="ubp-chip${_favOnly ? ' on' : ''}" data-ubp-act="filter-fav" title="${S('只看收藏（收藏图片不受循环清理）', '只看珍藏（珍藏之影不入轮回）')}">★ ${S('收藏', '珍藏')}</button>
              ${chipRow('filter-source', _sourceFilter, sourceOptions)}
              <button type="button" class="ubp-chip${_charFilter ? ' on' : ''}" data-ubp-act="char-filter" title="${S('按角色筛选（搜索+下拉选择）', '按人物筛选（寻访+下拉择取）')}">${S('角色', '人物')}：${escapeHtml(_charFilter || S('全部', '全部'))} ▾</button>
            </div>
          </div>`}
          ${list.length
            ? `<div class="ubp-album-grid">${cells}</div>`
            : _favOnly
              ? `<div class="ubp-empty"><b>${S('还没有收藏的图片', '还没有珍藏的影像')}</b><br>${S('打开图片后点「收藏」，或在批量模式里勾选多张一起收藏', '点开影像后点「珍藏」，或在批量模式里勾选择取')}</div>`
              : `<div class="ubp-empty"><b>${S('相册还是空的', '影阁还是空的')}</b><br>${S('聊天中发送/接收图片、或用相机拍照，都会存进这里', '符讯中往来留影、或以留影之法摄取，皆收存于此', '书信往来写真、或以写真匣摄取，皆收存于此', '晶讯往来记影、或以魔镜摄取，皆收存于此')}</div>`}
        </div>
        ${_selectMode ? `<div class="ubp-selbar">
          <button class="ubp-btn" data-ubp-act="sel-all" id="ubp-sel-all">${selbar.allSelected ? S('取消全选', '尽数取消') : S('全选', '全选')}</button>
          <button class="ubp-btn" data-ubp-act="sel-fav" id="ubp-sel-fav" ${favbar.canFav ? '' : 'disabled'}>${favbar.allFav ? S('取消收藏', '撤珍藏') : S('收藏', '珍藏')}</button>
          <button class="ubp-btn danger" data-ubp-act="sel-delete" id="ubp-sel-delete" ${selbar.canDelete ? '' : 'disabled'}>${S('删除', '删去')}</button>
        </div>` : ''}
      </div>
    </div>
    ${_toast ? `<div class="ubp-toast on">${escapeHtml(_toast)}</div>` : ''}
    ${renderDetail(openEntry)}
    ${renderEditSheet(editEntry)}
    ${_forwardId ? renderForwardPicker() : ''}
    ${_deleteId ? renderDeleteConfirm() : ''}`;
  const scroll = container.querySelector('#ubp-album-scroll') as HTMLElement | null;
  if (scroll) scroll.scrollTop = scrollTop;
  // 缩略图回填与渲染同一任务内完成（缓存命中无闪烁；未命中滚入视口才生成）
  hydrateGridThumbs(container);
}

/** 删除确认弹层（对齐微信清空确认的二次确认样式，防误触永久删除） */
function renderDeleteConfirm(): string {
  return `<div class="ubp-overlay" data-ubp-act="close-del">
    <div class="ubp-sheet" data-ubp-stop="1">
      <div class="ubp-sheet-title">删除这张图片？</div>
      <div class="ubp-sheet-body">删除后不可恢复；仍被消息、帖子或背景引用的图片会被拒绝删除。</div>
      <div class="ubp-sheet-actions">
        <button class="ubp-btn" data-ubp-act="close-del">取消</button>
        <button class="ubp-btn danger" data-ubp-act="confirm-del">删除</button>
      </div>
    </div>
  </div>`;
}

/** 转发给通讯录角色：实际发送条目中文描述（AI 侧「[图片]描述」），前端复用图片渲染。 */
function renderForwardPicker(): string {
  const contacts = getRoster().contacts;
  const rows = contacts.map(c =>
    `<button type="button" class="ubp-btn" data-ubp-act="pick-fwd" data-id="${escapeAttr(c.name)}">${escapeHtml(c.name)}</button>`,
  ).join('');
  return `<div class="ubp-overlay" data-ubp-act="close-forward">
    <div class="ubp-sheet" data-ubp-stop="1">
      <div class="ubp-sheet-title">转发给…</div>
      <div class="ubp-album-pick">${rows || '<div class="ubp-hint">通讯录暂无角色</div>'}</div>
      <div class="ubp-sheet-actions"><button class="ubp-btn" data-ubp-act="close-forward">取消</button></div>
    </div>
  </div>`;
}

/** 标签编辑弹层（叠在详情弹层之上，对齐主项目图库「编辑标签」：提示词=重绘唯一依据，可改）。
 *  初值取条目固化提示词；无记录（旧条目）留空。草稿读 DOM 取（编辑期间不重绘，与发帖面板同口径）。 */
function renderEditSheet(entry: PhoneAlbumEntry | null): string {
  if (!entry) return '';
  return `<div class="ubp-overlay" data-ubp-act="close-edit">
    <div class="ubp-sheet ubp-album-edit-sheet" data-ubp-stop="1">
      <div class="ubp-sheet-title">${S('编辑提示词', '编辑咒诀')}</div>
      <div class="ubp-sheet-body">
        <img class="ubp-album-edit-thumb" src="${escapeAttr(entry.path)}" alt="">
        <div class="ubp-album-edit-label">${S('正向提示词（标签）', '正向咒诀（标签）')}</div>
        <textarea class="ubp-textarea ubp-album-edit-ta" id="ubp-album-edit-prompt" placeholder="${escapeAttr(S('空=未记录，重绘回落到档案内原提示词', '空=未录，重绘回落档案原咒诀'))}">${escapeHtml(entry.imagePrompt || '')}</textarea>
        <div class="ubp-album-edit-label">${S('负向提示词', '负向咒诀')}</div>
        <textarea class="ubp-textarea ubp-album-edit-ta ubp-album-edit-ta-sm" id="ubp-album-edit-negative" placeholder="${escapeAttr(S('空=未记录', '空=未录'))}">${escapeHtml(entry.imageNegative || '')}</textarea>
        <div class="ubp-album-edit-hint">${S('改后点「换一张」按新标签重绘；清空＝回落原标签。', '改后点「再显一影」按新咒诀重绘；焚去＝回落原咒诀。')}</div>
      </div>
      <div class="ubp-sheet-actions">
        <button class="ubp-btn" data-ubp-act="close-edit">${S('取消', '作罢')}</button>
        <button class="ubp-btn primary" data-ubp-act="save-edit">${S('保存', '存录')}</button>
      </div>
    </div>
  </div>`;
}

function renderDetail(entry: PhoneAlbumEntry | null): string {
  if (!entry) return '';
  const replayable = isRecordReplayable(sanitizeImageGenRecord(entry.gen));
  const gen = entry.gen;
  const params = gen && gen.params ? gen.params : {};
  // F92：参数行拆 chips（provider/model/分辨率普通档；seed/steps/cfg 纯数字参数 dim 档，数字 tabular）
  const paramChips = [
    gen ? `<span class="al-chip">${escapeHtml(String(gen.provider))}</span>` : '',
    gen?.model ? `<span class="al-chip">${escapeHtml(String(gen.model))}</span>` : '',
    params.width && params.height ? `<span class="al-chip num">${escapeHtml(`${params.width}×${params.height}`)}</span>` : '',
    params.seed != null ? `<span class="al-chip num dim">seed ${escapeHtml(String(params.seed))}</span>` : '',
    params.steps != null ? `<span class="al-chip num dim">steps ${escapeHtml(String(params.steps))}</span>` : '',
    params.cfg != null ? `<span class="al-chip num dim">cfg ${escapeHtml(String(params.cfg))}</span>` : '',
  ].filter(Boolean).join('');
  // F92：拍摄时间行（storyStamp 入档当刻盖；旧条目无此字段=不显示该行，不猜）
  const stampParts = (entry.storyStamp || '').trim().split(/\s+/);
  const shotDate = stampParts.shift() || '';
  const shotTime = stampParts.join(' ');
  const shotRow = shotDate
    ? `<div class="ubp-profile-line"><b>${S('拍摄', '摄于')}</b>　<span class="al-chip num dim">${escapeHtml(shotDate)}${shotTime ? ` ${escapeHtml(shotTime)}` : ''}</span></div>`
    : '';
  return `<div class="ubp-overlay" data-ubp-act="close-detail">
    <div class="ubp-sheet" data-ubp-stop="1">
      <div class="ubp-sheet-head">
        <span class="ubp-sheet-headtitle"></span>
        <button type="button" class="ubp-sheet-x" data-ubp-act="close-detail" title="${S('关闭', '关闭')}">✕</button>
      </div>
      <img class="ubp-album-detail-img" src="${escapeAttr(entry.path)}" alt="" data-ubp-act="zoom" data-id="${escapeAttr(entry.path)}">
      <div class="ubp-album-meta">
        <div class="ubp-profile-line"><b>${S('来源App', '出处')}</b>　<span class="al-chip">${escapeHtml(albumSourceLabel(entry.source, currentStyle()))}</span></div>
        ${entry.characters.length ? `<div class="ubp-profile-line"><b>${SOCIAL_ALBUM_SOURCES.includes(entry.source) ? S('来源角色', '来源角色') : S('出镜', '入影')}</b>　${escapeHtml(entry.characters.join('、'))}</div>` : ''}
        ${entry.desc ? `<div class="ubp-profile-line"><b>${S('描述', '描述')}</b>　${escapeHtml(entry.desc)}</div>` : ''}
        ${shotRow}
        ${paramChips ? `<div class="ubp-profile-line"><b>${S('参数', '参数')}</b>　${paramChips}</div>` : `<div class="ubp-profile-line"><b>${S('参数', '参数')}</b>　${S('未记录完整生图档案', '未录完整生图档案')}</div>`}
        ${entry.imagePrompt ? `<details class="ubp-album-prompt"><summary>${S('提示词', '生图咒诀')}</summary><div>${escapeHtml(entry.imagePrompt)}</div></details>` : ''}
      </div>
      <div class="ubp-album-editrow">
        <button class="ubp-btn ubp-album-editbtn" data-ubp-act="edit-entry" data-id="${escapeAttr(entry.id)}">${S('编辑提示词', '编辑咒诀')}</button>
        <button class="ubp-btn ubp-album-favbtn${entry.fav ? ' on' : ''}" data-ubp-act="fav-entry" data-id="${escapeAttr(entry.id)}" title="${S('收藏后不受相册循环清理', '珍藏之后不入轮回')}">${entry.fav ? `★ ${S('已收藏', '已珍藏')}` : `☆ ${S('收藏', '珍藏')}`}</button>
      </div>
      <div class="ubp-sheet-actions">
        <button class="ubp-btn" data-ubp-act="forward-entry" data-id="${escapeAttr(entry.id)}">${S('转发', '转呈')}</button>
        <button class="ubp-btn danger" data-ubp-act="del-entry" data-id="${escapeAttr(entry.id)}">${S('删除', '删去')}</button>
        <button class="ubp-btn primary" data-ubp-act="regen-entry" data-id="${escapeAttr(entry.id)}" ${replayable && _busyId !== entry.id ? '' : 'disabled'}>${_busyId === entry.id ? S('生成中…', '显影中…') : S('换一张', '再显一影')}</button>
      </div>
    </div>
  </div>`;
}

function handleClick(event: Event): void {
  const target = event.target as HTMLElement;
  // 长按刚触发后的残留 click 吞掉（防进入批量模式后首格选中态被立即翻转，对齐微信/窥私做法）
  if (Date.now() - _longPressFiredAt < 600) return;
  // 批量模式必须先于 closest('[data-ubp-act]') 分派：格子里本无 sel-* 动作，靠此路由统一当勾选
  if (_selectMode) { handleSelectClick(target); return; }
  const stop = target.closest('[data-ubp-stop]');
  const el = target.closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const id = el.dataset.id || '';
  if (stop && !stop.contains(el)) return; // 点在弹层内容上冒泡到背景不关闭；弹层内的关闭/取消按钮正常生效
  switch (act) {
    case 'back': _ctx?.closeApp(); break;
    case 'filter-source': _sourceFilter = id; render(); break;
    case 'filter-fav': _favOnly = !_favOnly; render(); break;
    case 'char-filter': openCharFilter(); break;
    case 'open-entry': _openId = id; render(); break;
    case 'close-detail': _openId = null; _editId = null; render(); break;
    case 'edit-entry': _editId = id; render(); break;
    case 'close-edit': _editId = null; render(); break;
    case 'save-edit': saveEdit(); break;
    case 'fav-entry': toggleFavEntry(id); break;
    case 'forward-entry': _forwardId = id; render(); break;
    case 'close-forward': _forwardId = null; render(); break;
    case 'pick-fwd': pickForward(id); break;
    case 'zoom': {
      // 放大页＝当前筛选结果的完整序列（可左右滑）；重绘入口与相册自身「换一张」同一条链路
      const list = filteredEntries();
      const idx = list.findIndex(e => e.id === _openId);
      openPhoneLightbox(_ctx?.container, { paths: list.map(e => e.path), startIndex: Math.max(0, idx) });
      break;
    }
    case 'regen-entry': void regenEntry(id); break;
    case 'del-entry': _deleteId = id; render(); break;
    case 'close-del': _deleteId = null; render(); break;
    case 'confirm-del': {
      const delId = _deleteId;
      _deleteId = null;
      if (delId) void deleteEntry(delId);
      break;
    }
    default: break;
  }
}

// ─── 批量删除（长按图片进入）：勾选若干张 → 删除所选 ───

/** 进入批量模式（长按触发；带首张选中，与微信/窥私长按多选同口径）。 */
function enterSelectMode(entryId: string): void {
  if (!entryId) return;
  _selectMode = true;
  _selected = new Set([entryId]);
  _openId = null;
  render();
}

function exitSelectMode(): void {
  _selectMode = false;
  _selected.clear();
}

function toggleSelect(entryId: string): void {
  if (_selected.has(entryId)) _selected.delete(entryId);
  else _selected.add(entryId);
  syncSelUi();
}

/** 批量选中态就地同步（不整体重渲染——保网格滚动位置）。
 *  可见列表直接取已渲染的格子（DOM 即当前可见项真相，免每次点击深拷贝读盘），
 *  按钮态与渲染共用 albumSelbarState 纯函数，消灭双写面。 */
function syncSelUi(): void {
  const container = _ctx?.container;
  if (!container || !_selectMode) return;
  const cells = Array.from(container.querySelectorAll('.ubp-album-cell[data-id]')) as HTMLElement[];
  const project = cells.map(c => ({ id: c.dataset.id || '', fav: c.dataset.fav === '1' }));
  const st = albumSelbarState(_selected, cells.map(c => ({ id: c.dataset.id || '' })));
  const fav = albumFavbarState(_selected, project);
  const count = container.querySelector('#ubp-sel-count');
  if (count) count.textContent = `${S('已选', '已择')} ${_selected.size} ${S('项', '则')}`;
  const del = container.querySelector('#ubp-sel-delete') as HTMLButtonElement | null;
  const all = container.querySelector('#ubp-sel-all') as HTMLButtonElement | null;
  const favBtn = container.querySelector('#ubp-sel-fav') as HTMLButtonElement | null;
  if (del) del.disabled = !st.canDelete;
  if (all) all.textContent = st.allSelected ? S('取消全选', '尽数取消') : S('全选', '全选');
  if (favBtn) {
    favBtn.disabled = !fav.canFav;
    favBtn.textContent = fav.allFav ? S('取消收藏', '撤珍藏') : S('收藏', '珍藏');
  }
  for (const cell of cells) {
    const on = _selected.has(cell.dataset.id || '');
    cell.classList.toggle('picked', on);
    const check = cell.querySelector('.ubp-msg-check');
    if (check) {
      check.classList.toggle('on', on);
      check.textContent = on ? '✓' : '';
    }
  }
}

/** 批量模式点击路由：顶栏/操作条按钮放行，其余落在格子上一律当勾选（全选仅当前可见项）。 */
function handleSelectClick(target: HTMLElement): void {
  const act = (target.closest('[data-ubp-act]') as HTMLElement | null)?.dataset.ubpAct || '';
  if (act === 'sel-cancel') { exitSelectMode(); render(); return; }
  if (act === 'sel-all') {
    const cells = Array.from(_ctx?.container.querySelectorAll('.ubp-album-cell[data-id]') || []) as HTMLElement[];
    const visible = cells.map(c => ({ id: c.dataset.id || '' }));
    _selected = albumSelbarState(_selected, visible).allSelected ? new Set() : new Set(visible.map(e => e.id));
    syncSelUi();
    return;
  }
  if (act === 'sel-delete') { openBatchDeleteConfirm(); return; }
  if (act === 'sel-fav') { toggleFavSelected(); return; }
  const id = (target.closest('.ubp-album-cell') as HTMLElement | null)?.dataset.id || '';
  if (id) toggleSelect(id);
}

/** 批量删除确认（复用通用确认弹层；弹层确认回调内先关弹层、再落库、再 render——遵守 action-sheet 纪律）。 */
function openBatchDeleteConfirm(): void {
  if (!_ctx || !_selected.size) return;
  const n = _selected.size;
  openConfirmSheet(_ctx.container, {
    title: S(`删除选中的 ${n} 张图片？`, `删去所选 ${n} 张影像？`),
    message: S('删除后不可恢复；仍被消息、帖子或背景引用的图片会被自动跳过。', '删去后不可复原；仍为他处所引之影，将略过不删。'),
    confirmLabel: S('删除', '删去'),
    onConfirm: deleteSelectedEntries,
  });
}

function deleteSelectedEntries(): void {
  if (!_selected.size) return;
  const ids = new Set(_selected);
  exitSelectMode();
  const { deleted, skipped } = deletePhoneAlbumEntries(ids);
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：批量删除成功（被引用跳过的不计入）
  if (deleted > 0) emitAch('phone_album_deleted', { count: deleted });
  // toast() 自带一次重绘（含操作条/网格复位），不在此另调 render（免双重全量重绘）
  toast(!deleted && skipped
    ? S(`所选 ${skipped} 张均被消息、帖子或背景引用，未删除`, `所选 ${skipped} 张皆为他处所引，未删去`)
    : skipped
      ? S(`已删除 ${deleted} 张，${skipped} 张被消息、帖子或背景引用，已跳过`, `已删去 ${deleted} 张，${skipped} 张为他处所引已略过`)
      : S(`已删除 ${deleted} 张图片`, `已删去 ${deleted} 张影像`));
}

/** 批量收藏/取消收藏：按「已选是否已全部收藏」决定方向，一次落盘。
 *  收藏条目豁免循环清理，取消收藏即回到淘汰队列——不涉及删除，无需二次确认。
 *  toast 自带一次重绘（选中态/操作条随之刷新），不另调 render。 */
function toggleFavSelected(): void {
  const container = _ctx?.container;
  if (!container || !_selected.size) return;
  const picked = (Array.from(container.querySelectorAll('.ubp-album-cell[data-id]')) as HTMLElement[])
    .filter(c => _selected.has(c.dataset.id || ''));
  const project = picked.map(c => ({ id: c.dataset.id || '', fav: c.dataset.fav === '1' }));
  const next = !albumFavbarState(_selected, project).allFav;
  const changed = setAlbumFavorites(_selected, next);
  if (!changed) return;
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：批量收藏成功（取消收藏不计）
  if (next) emitAch('phone_album_faved', { count: changed });
  toast(next
    ? S(`已收藏 ${changed} 张（不受循环清理）`, `已珍藏 ${changed} 张（不入轮回）`)
    : S(`已取消收藏 ${changed} 张`, `已撤珍藏 ${changed} 张`));
}

/** 单条收藏开关（详情弹层星标钮）。 */
function toggleFavEntry(id: string): void {
  const all = readPhoneAlbumRef(); // 一次读盘：条目查找与存在性检查共用（O6）
  const entry = all.find(e => e.id === id);
  if (!entry) return;
  const next = !entry.fav;
  const result = setAlbumFavorite(id, next, all);
  if (!result.ok) {
    toast(result.error);
    return;
  }
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：单张收藏成功（取消收藏不计）
  if (next) emitAch('phone_album_faved', { count: 1 });
  toast(next
    ? S('已收藏（不受相册循环清理）', '已珍藏（不入轮回）')
    : S('已取消收藏', '已撤珍藏'));
}

/** 选定联系人：图片以我方 ready 消息落库（复用文件）。上屏≠触发——进微信点输入栏上方「生成回复」条再催回复。 */
function pickForward(name: string): void {
  if (!_forwardId) return;
  const entry = readPhoneAlbumRef().find(e => e.id === _forwardId);
  _forwardId = null;
  if (!entry) {
    render();
    return;
  }
  const result = forwardAlbumImageToContact(entry.id, name, getRoster().global.time);
  if (result.ok) {
    _openId = null;
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：相册转发给角色成功
    emitAch('phone_album_forwarded', {});
    toast(S(`已转发给${name}`, `已转呈予${name}`));
  } else {
    toast(result.error);
  }
  // 两个分支都走 toast（内部已 render）⇒ 此处不再追加 render（原写法=同一次操作整页重绘两遍）
}

/** 保存标签编辑：落库（条目 + 同图消息固化提示词同步）→ 关弹层 → 提示。
 *  草稿直接读 DOM（编辑期间不重绘，DOM 即草稿真相；与发帖/改名弹层同口径）。 */
function saveEdit(): void {
  const id = _editId;
  if (!id) return;
  const read = (sel: string): string => {
    const el = _ctx?.container.querySelector(sel) as HTMLTextAreaElement | null;
    return el ? el.value : '';
  };
  const result = updatePhoneAlbumEntry(id, {
    imagePrompt: read('#ubp-album-edit-prompt'),
    imageNegative: read('#ubp-album-edit-negative'),
  });
  _editId = null;
  if (result.ok) {
    emitPhoneEvent('ubp-phone:data-changed');
    toast(S('提示词已保存', '咒诀已存录'));
  } else {
    toast(result.error);
  }
}

async function regenEntry(id: string): Promise<void> {
  if (_busyId) return;
  _busyId = id;
  render();
  const result = await regenAlbumImage(id);
  _busyId = null;
  if (result.ok) {
    toast(S('已重新生成（旧图已替换）', '已重新显影（旧影已替）'));
    emitPhoneEvent('ubp-phone:data-changed');
  } else {
    toast(result.error);
  }
  // 两分支都走 toast（内部已 render）⇒ 不再追加整页重绘（原写法=同一次操作重绘两遍）
}

async function deleteEntry(id: string): Promise<void> {
  const result = await deletePhoneAlbumEntry(id);
  if (result.ok) {
    _openId = null;
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：单张删除成功
    emitAch('phone_album_deleted', { count: 1 });
  } else {
    toast(result.error);
  }
  render();
}

export const albumApp: PhoneApp = {
  id: 'album',
  name: '相册',
  icon: ubpIcon('album'),
  color: '#C0629E',
  available: true,
  /** 返回键：删除确认 → 转发 → 编辑 → 详情（与屏幕上的关闭/返回钮同语义，IA-03）。 */
  closeTopOverlay(): boolean {
    if (_deleteId) { _deleteId = null; render(); return true; }
    if (_forwardId) { _forwardId = null; render(); return true; }
    if (_editId) { _editId = null; render(); return true; }
    if (_openId) { _openId = null; _editId = null; render(); return true; }
    return false;
  },
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _openId = takePendingAppTarget('album'); // 全局搜索深链：直接打开该条目详情（目标不存在时渲染回落网格）
    _editId = null;
    _busyId = null;
    _forwardId = null;
    _toast = '';
    _favOnly = false;
    exitSelectMode();
    ctx.container.addEventListener('click', handleClick);
    // 长按图片进批量删除；fire 里自记 _longPressFiredAt——handleClick 顶部吞掉残留 click（不改 hint-sheet.ts）。
    const markFired = (fn: () => void) => () => {
      _longPressFiredAt = Date.now();
      fn();
    };
    const unbindLongPress = bindHintLongPress(ctx.container, target => {
      if (_selectMode) return null;                              // 已在批量模式：不再触发
      if (ctx.container.querySelector('.ubp-overlay')) return null; // 详情/转发/删除确认/选人弹层开着
      const cell = target.closest('.ubp-album-cell') as HTMLElement | null;
      const id = cell?.dataset.id || '';
      return cell && id ? { el: cell, fire: markFired(() => enterSelectMode(id)) } : null;
    });
    render();
    return () => {
      ctx.container.removeEventListener('click', handleClick);
      unbindLongPress();
      exitSelectMode();
      _ctx = null;
    };
  },
};
