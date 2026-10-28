// ===== 录音机 App（第八轮 §1 · N3）：语音收藏与缓存的收听 / 管理面 =====
// 两页签：
//   ① 语音收藏 —— 独立 IndexedDB（ubp-voice-fav；与缓存物理分离：清缓存/清空队列都碰不到它，上限 500 丢最旧）；
//   ② 缓存     —— 合成缓存（ubp-voice；条目带可读元数据，旧条目回落哈希短键）。
// 交互：行内点按=播放/停止（复用唯一播放器 playVoiceBlob）；长按=动作面板（下载/删除；缓存行多一项「转收藏」）；
//   页头 ⋯ = 清空（收藏 / 缓存，均带确认）。管理动作原在设置页，第八轮 §1 起归位到这里（设置页只留缓存上限+清空）。
// 纪律：打开时才读列表（一次 getAll）；动作后重渲；无常驻监听/轮询；长按用 bindHintLongPress（与相册同款）。

import { S } from '../core/skins';
import { phoneNotify } from '../core/host-env';
import { getPhoneSettings } from '../core/phone-settings';
import { escapeAttr, escapeHtml } from '../core/ubp-utils';
import { voiceCacheClear, voiceCacheDelete, voiceCacheDisplay, voiceCacheGet, voiceCacheList, type VoiceCacheEntry } from '../core/voice-cache';
import { voiceFavoriteClear, voiceFavoriteDelete, voiceFavoriteList, voiceFavoritePut, type VoiceFavorite } from '../core/voice-favorites';
import { playVoiceBlob, stopVoice, estimateSeconds, type VoiceHandle } from '../core/voice-tts';
import { downloadBlob, extForMime, voiceFileName } from '../core/voice-export';
import type { PhoneApp, PhoneAppContext } from './app-registry';
import { openActionSheet, openConfirmSheet } from './action-sheet';
import { bindHintLongPress } from './hint-sheet';
import { avatarColor, avatarHtml } from './phone-ui';
import { ubpIcon } from './icons';
import { emotionChipHtml } from './voice-meta';
import { emitAch } from '../core/phone-achievements';

type RecTab = 'fav' | 'cache';

let _ctx: PhoneAppContext | null = null;
let _tab: RecTab = 'fav';
let _favs: VoiceFavorite[] = [];
let _cache: VoiceCacheEntry[] = [];
let _loaded = false;          // 打开时读一次；动作后重读
let _playingKey = '';         // 正在播的条目 key（行内播放/停止切换）
let _handle: VoiceHandle | null = null;
let _longPressFiredAt = 0;    // 长按触发时间戳：吞掉随后的 click（防长按后误触播放）
const _scrollTops: Record<RecTab, number> = { fav: 0, cache: 0 };

function appTitle(): string {
  return S('录音机', '留声匣', '传音匣', '回声匣');
}

/** 时间戳 → 「5月19日」（列表用的短日期）。 */
function shortDate(ms: number): string {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function sizeText(bytes: number): string {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  if (b >= 1024) return `${Math.round(b / 1024)}KB`;
  return `${b}B`;
}

async function reload(): Promise<void> {
  if (_tab === 'fav') {
    _favs = await voiceFavoriteList();
  } else {
    _cache = (await voiceCacheList()).sort((a, b) => (b.lastAccessAt || 0) - (a.lastAccessAt || 0));
  }
  _loaded = true;
}

/** 打开 / 动作后刷新（读一次 + 重渲；失败静默——两个库都永不抛）。 */
async function refresh(): Promise<void> {
  await reload();
  render();
}

function stopRecPlay(): void {
  const h = _handle;
  _handle = null;
  _playingKey = '';
  try {
    if (h) h.stop();
    else stopVoice();
  } catch (_e) { /* ignore */ }
}

/** 行内播放/停止（唯一播放器：playVoiceBlob 内部先停上一条）。 */
function togglePlay(key: string, blob: Blob): void {
  if (_playingKey === key) {
    stopRecPlay();
    render();
    return;
  }
  stopRecPlay();
  _playingKey = key;
  render();
  let speed = 1;
  try { speed = Number(getPhoneSettings().voiceSpeed) || 1; } catch (_e) { speed = 1; }
  let achEmitted = false; // L9：真正开播才计一次（loading/失败不计）
  _handle = playVoiceBlob(blob, {
    speed,
    onState: (st, detail) => {
      if (st === 'playing' && !achEmitted) { achEmitted = true; emitAch('phone_voice_played', { from: 'recorder' }); }
      if (st === 'ended' || st === 'error') {
        if (_playingKey !== key) return;
        _playingKey = '';
        _handle = null;
        render();
        if (st === 'error' && detail) phoneNotify(detail, '播放失败', 'error');
      }
    },
  });
}

const playBtnHtml = (key: string): string =>
  `<button type="button" class="ubp-rec-play${_playingKey === key ? ' playing' : ''}" title="${S('播放', '开声')}">`
  + (_playingKey === key ? ubpIcon('stop') : ubpIcon('playFill')) + '</button>';

/** 收藏行（角色 + 台词两行封顶 + 情绪彩标 + 时长/日期）。 */
function favRowHtml(f: VoiceFavorite): string {
  const text = String(f.translation || f.text || '').trim();
  const dur = Math.max(1, Math.round(estimateSeconds(text)));
  return `<div class="ubp-rec-row" data-ubp-act="toggle" data-key="${escapeAttr(f.key)}" data-kind="fav">
    ${avatarHtml(f.role)}
    <span class="ubp-rec-main">
      <b>${escapeHtml(f.role)}</b>
      ${text ? `<span class="tx">「${escapeHtml(text)}」</span>` : ''}
      <span class="m">${emotionChipHtml(f.emotion)}<span class="t">${dur}'' · ${shortDate(f.createdAt)}</span></span>
    </span>
    ${playBtnHtml(f.key)}
  </div>`;
}

/** 缓存行（元数据可读化；旧条目回落哈希短键）。 */
function cacheRowHtml(e: VoiceCacheEntry): string {
  const disp = voiceCacheDisplay(e);
  const meta = [e.role, sizeText(e.size), shortDate(e.lastAccessAt || e.createdAt)]
    .filter(Boolean).join(' · ');
  return `<div class="ubp-rec-row" data-ubp-act="toggle" data-key="${escapeAttr(e.key)}" data-kind="cache">
    ${e.role ? avatarHtml(e.role) : `<span class="ubp-avatar" style="background:${avatarColor('录音机')}">${ubpIcon('mic')}</span>`}
    <span class="ubp-rec-main">
      <b>${escapeHtml(e.role || S('未标注角色', '未记来处'))}</b>
      <span class="tx">${escapeHtml(disp.title)}</span>
      <span class="m">${emotionChipHtml(e.emotion)}<span class="t">${escapeHtml(meta)}</span></span>
    </span>
    ${playBtnHtml(e.key)}
  </div>`;
}

function emptyHtml(): string {
  return _tab === 'fav'
    ? `<div class="ubp-empty"><b>${S('还没有收藏的语音', '尚无珍藏之音')}</b><br>${S('长按聊天里的语音条选「收藏语音」，就会出现在这里', '长按符讯里的传音条选「珍藏传音」，便会现于此处')}</div>`
    : `<div class="ubp-empty"><b>${S('缓存还是空的', '缓存还是空的')}</b><br>${S('播放过或预合成过的语音会缓存在这里（清缓存不影响收藏）', '播放过或预合成过的传音会存于此处（清缓存不伤珍藏）')}</div>`;
}

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const scroll = container.querySelector('#ubp-rec-scroll') as HTMLElement | null;
  if (scroll) _scrollTops[_tab] = scroll.scrollTop; // 帧内先记位（整屏重绘前）
  const list = _tab === 'fav' ? _favs : _cache;
  const rows = !_loaded
    ? `<div class="ubp-picker-loading"><span class="ubp-spinner"></span><span>${S('读取中…', '读取中…')}</span></div>`
    : (list.length ? list.map(e => (_tab === 'fav' ? favRowHtml(e as VoiceFavorite) : cacheRowHtml(e as VoiceCacheEntry))).join('') : emptyHtml());
  const tabs: Array<[RecTab, string]> = [['fav', S('语音收藏', '珍藏传音')], ['cache', S('缓存', '缓存')]];
  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="back" title="${S('返回', '返回')}">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${appTitle()}<span class="ubp-appbar-sub">（${_loaded ? list.length : '…'}）</span></span>
      <button class="ubp-iconbtn" data-ubp-act="menu" title="${S('更多', '更多')}">${ubpIcon('more')}</button>
    </div>
    <div class="ubp-tabbar">${tabs.map(([id, label]) =>
      `<button class="ubp-tab${_tab === id ? ' active' : ''}" data-ubp-act="tab" data-id="${id}">${label}</button>`).join('')}</div>
    <div class="ubp-appbody" id="ubp-rec-scroll">${rows}</div>`;
  const next = container.querySelector('#ubp-rec-scroll') as HTMLElement | null;
  if (next) next.scrollTop = _scrollTops[_tab];
}

/** 单条动作面板（长按；收藏=播放/下载/删除；缓存=播放/转收藏/删除）。 */
function openRowMenu(key: string, kind: string): void {
  const container = _ctx?.container;
  if (!container) return;
  const actions: Array<{ label: string; tone?: 'danger'; onPick: () => void }> = [];
  if (kind === 'fav') {
    const f = _favs.find(x => x.key === key);
    if (!f) return;
    actions.push({ label: S('播放', '开声'), onPick: () => togglePlay(f.key, f.blob) });
    actions.push({ label: S('下载', '下载'), onPick: () => {
      try {
        downloadBlob(f.blob, `${voiceFileName(f.role, f.translation || f.text)}.${extForMime(f.mime)}`);
        phoneNotify(S('已下载', '已下载'));
      } catch (e) { phoneNotify(String((e as Error)?.message || e), S('下载失败', '下载失败'), 'error'); }
    } });
    actions.push({ label: S('删除收藏', '删去珍藏'), tone: 'danger', onPick: () => {
      openConfirmSheet(container, {
        title: S('删除这条收藏？', '删去这条珍藏？'),
        message: `${f.role}：${(f.translation || f.text || '').slice(0, 40)}`,
        confirmLabel: S('删除', '删去'),
        onConfirm: () => { void voiceFavoriteDelete(f.key).then(async () => { phoneNotify(S('已删除', '已删去')); await refresh(); }); },
      });
    } });
  } else {
    const e = _cache.find(x => x.key === key);
    if (!e) return;
    const disp = voiceCacheDisplay(e);
    actions.push({ label: S('播放', '开声'), onPick: () => togglePlay(e.key, e.blob) });
    actions.push({ label: S('加入收藏', '收入珍藏'), onPick: () => { void cacheToFavorite(e); } });
    actions.push({ label: S('删除缓存', '删去缓存'), tone: 'danger', onPick: () => {
      openConfirmSheet(container, {
        title: S('删除这条缓存？', '删去这条缓存？'),
        message: disp.title.slice(0, 60),
        confirmLabel: S('删除', '删去'),
        onConfirm: () => { void voiceCacheDelete(e.key).then(async () => { phoneNotify(S('已删除', '已删去')); await refresh(); }); },
      });
    } });
  }
  actions.push({ label: S('取消', '作罢'), onPick: () => { /* 关闭 */ } });
  openActionSheet(container, { title: appTitle(), actions });
}

/** 缓存 → 收藏（把音频本体与元数据搬进收藏库；同 key 覆盖）。 */
async function cacheToFavorite(e: VoiceCacheEntry): Promise<void> {
  await voiceFavoritePut({
    key: e.key,
    blob: e.blob,
    mime: e.mime,
    role: e.role || S('未标注角色', '未记来处'),
    text: e.text || '',
    createdAt: Date.now(),
  });
  // L9 成就：玩家亲手收藏语音成功
  emitAch('phone_voice_faved', {});
  phoneNotify(S('已加入收藏（清缓存不会删）', '已收入珍藏（清缓存不伤它）'));
  await refresh();
}

/** 页头 ⋯：清空当前页签（收藏 / 缓存；都带确认）。 */
function openMenu(): void {
  const container = _ctx?.container;
  if (!container) return;
  if (_tab === 'fav') {
    openActionSheet(container, {
      title: `${appTitle()} · ${S('语音收藏', '珍藏传音')}`,
      message: S(`共 ${_favs.length} 条；收藏与缓存分开保存，清缓存不会删收藏。`, `共 ${_favs.length} 条；珍藏与缓存分开存放，清缓存不伤珍藏。`),
      actions: [
        { label: S('清空全部收藏', '清空全部珍藏'), tone: 'danger', onPick: () => {
          openConfirmSheet(container, {
            title: S('清空全部收藏？', '清空全部珍藏？'),
            message: S('删除全部收藏的语音音频（不影响缓存与聊天记录）。', '删去全部珍藏的传音（不伤缓存与符讯）。'),
            confirmLabel: S('清空', '清空'),
            onConfirm: () => { void voiceFavoriteClear().then(async () => { phoneNotify(S('语音收藏已清空', '珍藏已清空')); await refresh(); }); },
          });
        } },
        { label: S('取消', '作罢'), onPick: () => { /* 关闭 */ } },
      ],
    });
    return;
  }
  let mb = 60;
  try { mb = Number(getPhoneSettings().voiceCacheMaxMB) || 60; } catch (_e) { mb = 60; }
  openActionSheet(container, {
    title: `${appTitle()} · ${S('缓存', '缓存')}`,
    message: S(`共 ${_cache.length} 条；超过 ${mb}MB 会按最久未用自动淘汰（设置 → 功能 → 语音可改上限）。`, `共 ${_cache.length} 条；超过 ${mb}MB 会按最久未用自动淘汰。`),
    actions: [
      { label: S('清空缓存', '清空缓存'), tone: 'danger', onPick: () => {
        openConfirmSheet(container, {
          title: S('清空语音缓存？', '清空语音缓存？'),
          message: S('删除全部已合成音频（收藏不受影响；下次播放会重新合成）。', '删去全部已合成音频（珍藏不受影响）。'),
          confirmLabel: S('清空', '清空'),
          onConfirm: () => { void voiceCacheClear().then(async () => { phoneNotify(S('语音缓存已清空', '语音缓存已清空')); await refresh(); }); },
        });
      } },
      { label: S('取消', '作罢'), onPick: () => { /* 关闭 */ } },
    ],
  });
}

function handleClick(event: Event): void {
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  if (act === 'back') { _ctx?.closeApp(); return; }
  if (act === 'menu') { openMenu(); return; }
  if (act === 'tab') {
    const next = el.dataset.id === 'cache' ? 'cache' : 'fav';
    if (next === _tab) return;
    stopRecPlay();
    _tab = next;
    _loaded = false;
    render();
    void refresh();
    return;
  }
  if (act === 'toggle') {
    if (Date.now() - _longPressFiredAt < 600) return; // 长按后的残留 click 不算点按
    const key = el.dataset.key || '';
    const kind = el.dataset.kind || '';
    if (kind === 'fav') {
      const f = _favs.find(x => x.key === key);
      if (f) togglePlay(f.key, f.blob);
      return;
    }
    void (async () => {
      const e = await voiceCacheGet(key);
      if (!e) { phoneNotify(S('这条缓存已经不在了', '这条缓存已经不在了'), '', 'warning'); await refresh(); return; }
      togglePlay(e.key, e.blob);
    })();
  }
}

export const recorderApp: PhoneApp = {
  id: 'recorder',
  name: appTitle(),
  icon: ubpIcon('recorder'),
  color: '#C2793A',
  available: true,
  closeTopOverlay(): boolean {
    return false; // 动作面板/确认弹窗自管（pushSheetCloser），与相册同款
  },
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _tab = 'fav';
    _loaded = false;
    _favs = [];
    _cache = [];
    _playingKey = '';
    _handle = null;
    ctx.container.addEventListener('click', handleClick);
    const unbindLongPress = bindHintLongPress(ctx.container, target => {
      if (ctx.container.querySelector('.ubp-overlay')) return null; // 动作面板/确认弹窗开着
      const row = target.closest('.ubp-rec-row') as HTMLElement | null;
      const key = row?.dataset.key || '';
      if (!row || !key) return null;
      return { el: row, fire: () => { _longPressFiredAt = Date.now(); openRowMenu(key, row.dataset.kind || ''); } };
    });
    render();
    void refresh();
    return () => {
      ctx.container.removeEventListener('click', handleClick);
      unbindLongPress();
      stopRecPlay();
      _ctx = null;
    };
  },
};
