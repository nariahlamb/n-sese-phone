// ===== 电话 App（P2 交付，规格 docs/05） =====
// 视图：log（通话记录，默认）/ contacts（通讯录）/ dialer（拨号盘）+ detail（记录详情）
// + 通话全屏层（振铃/来电/接通/拒接/失败/结束六态，覆盖在 App 上方）。
// 交互：拨出=触发（一步式振铃判定）；「说话」=续话触发；双向挂断（玩家红钮 / AI <挂断>）。
// 来电（世界演化联动）：incoming 态=接听/拒接，接听后开场白打字机投递，续话走 continueCall。
// 通话会话为模块级状态：关闭手机/切走 App 后台继续（打字机投递与生成不中断，重开恢复）。
// 记录只落 PhoneChatData.calls，不写微信会话。角标=未看的 rejected/cancelled/missed（打开 App 清零）。

import {
  addCallRecord,
  callRecordPreview,
  callStatusIcon,
  deleteCallRecord,
  formatDuration,
  makeCallRecordId,
  matchByDigits,
  matchByName,
  replayableLineIndexes,
  t9PseudoNumber,
  voicemailDurationSec,
  voicemailUnheard,
  MAX_CALL_LINES,
  MAX_TRANSCRIPT_LINES,
  type CallLine,
  type CallRecord,
} from '../core/call-model';
import type { CallPrevContext } from '../core/call-prompts';
import { abortCallGeneration, continueCall, initiateCall } from '../core/call-engine';
import { scheduleVoicemail, type VoicemailOutcome } from '../core/call-voicemail';
import { PhoneChatError } from '../core/chat-engine';
import { phoneAudioContext } from '../core/device-feedback';
import { bindHintLongPress, openOneShotHintSheet } from './hint-sheet';
import { clearCallBg, readCallBg, setCallBg } from '../core/phone-backgrounds';
import { cropMediaStyle } from '../core/phone-crops';
import { revealDelay, sleep } from '../core/ubp-utils';
import { resolveAvatarPath } from '../core/phone-avatars';
import {
  mutatePhoneData,
  persistPhoneData,
  phoneStoreStatus,
  readPhoneDataRef,
} from '../core/phone-store';
import { bindRosterInvalidation, getRoster, mergeCustomContacts, type RosterContact } from '../core/roster';
import { hostWindow } from '../core/host-env';
import { emitAch, emitActionOnDate } from '../core/phone-achievements';
import { S } from '../core/skins';
import { emitPhoneEvent, emitPhoneNotify, onPhoneEvent, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openImagePickerSheet } from './image-picker-sheet';
import { avatarColor, createViewScrollMemo, escapeAttr, escapeHtml, avatarHtml, showScreenToast } from './phone-ui';
import { ubpIcon } from './icons';
import { playVoice, stopVoice, estimateSeconds } from '../core/voice-tts';
import { voicePlanFor, prewarmNeighbors, type VoiceWarmSlot } from '../core/chat-voice';
import { exportVoiceTrack } from '../core/voice-export';
import { getPhoneSettings, isVoiceEnabled, savePhoneSettings } from '../core/phone-settings';
import { voiceMetaHtml } from './voice-meta';

type Tab = 'log' | 'contacts' | 'dialer';

/** 通话全屏层状态机：ringing(拨出 AI 生成中) → active / rejected / failed；incoming(来电) → active / rejected；active → ended。 */
interface CallSession {
  recordId: string;
  peerName: string;
  phase: 'ringing' | 'incoming' | 'active' | 'rejected' | 'failed' | 'ended';
  answeredAt?: number;
  rejectReason?: string;
  errorText?: string;
  endText?: string;
  /** 最新一轮对方内心想法（资料块首轮 thought 落记录，此处存展示值）。 */
  thought?: string;
  /** 转写区内的一次性提示行（对方沉默/信号不佳等）。 */
  hint?: string;
  /** 来电开场白（世界演化输出；接听后投递，不落库）。 */
  opening?: string[];
  /** 回拨衔接：与本角色最近一次有内容的通话（只进发起指令的回拨判定与时间锚；历史内容由混合记录块携带）。 */
  prev?: CallPrevContext;
  generating: boolean;
  revealing: boolean;
  hangupPending: boolean;
}

let _ctx: PhoneAppContext | null = null;
let _tab: Tab = 'log';
let _detailId: string | null = null;
let _contactName: string | null = null; // 通讯录人物详情页（点行进入；点电话图标=直接拨打）
let _dialQuery = '';
let _contactQuery = '';
let _mute = false;
/** 通话顶栏展开态（方案 C，持久化在全局设置 `callBarExpanded`）：mount 读入、点按钮写回。
 *  默认收起＝紧凑信息带，把纵向空间让给对白；振铃/来电态恒为大版式（那时还没有对白）。 */
let _barExpanded = false;
let _speakOpen = false;
let _speakDraft = '';
let _overlay: { kind: 'confirm-delete'; id: string } | { kind: 'num-edit' } | null = null;
let _numEditDraft = '';
/** 长按触发时间戳：吞掉随后的残留 click（防长按弹出的删除确认层被背景层当场关掉，对齐微信/窥私做法）。 */
let _longPressFiredAt = 0;
// 通话会话（模块级：App 卸载后后台延续；重挂载时恢复通话态）
let _session: CallSession | null = null;
let _timerInt: ReturnType<typeof setInterval> | null = null;
// 跨视图滚动记忆：通话记录/通讯录/录详情/联系人详情各记各的（列表→详情→返回不回顶，见 phone-ui createViewScrollMemo）
const _viewScroll = createViewScrollMemo();

/** 当前视图的滚动体（记录/通讯录=嵌套内层 .ubp-appbody；详情/联系人页=唯一一层）。 */
function callScrollBody(container: HTMLElement): HTMLElement | null {
  const all = container.querySelectorAll('.ubp-appbody');
  return (all[all.length - 1] as HTMLElement | undefined) || null;
}

/** 渲染后落位（各 renderX 末尾统一调用；跨视图取记忆位，同视图重绘=原位）。 */
function settleScroll(container: HTMLElement, key: string, prevTop: number): void {
  const body = callScrollBody(container);
  if (body) body.scrollTop = _viewScroll.settle(key, prevTop).top;
}

/**
 * 只读数据口（通话记录/自定义号码/自定义联系人）。走 readPhoneDataRef 零拷贝——
 * 本 App 的读取全是「找一条记录 / 取一个字符串 / 列表筛选」，原全量深拷贝在渲染帧与
 * 逐键搜索（通讯录/拨号盘输入）里被反复付账；逐行打字机通话更是 2N 次整份 normalize。
 * ref 不会抛（只是取内存引用），容错返回形状保留供调用方沿用 `|| []`。
 */
function readPhoneDataSafe(): ReturnType<typeof readPhoneDataRef> {
  try {
    return readPhoneDataRef();
  } catch (_e) {
    return { schema: 1, conversations: [], calls: [] };
  }
}

function findRecord(id: string): CallRecord | null {
  return (readPhoneDataSafe().calls || []).find(c => c.id === id) || null;
}

// ─── 自定义手机号（存储=PhoneChatData.phoneNumbers，跟聊天走；未设置/清空=回落 T9 伪号码） ───

function readCustomNumber(name: string): string {
  return (readPhoneDataSafe().phoneNumbers || {})[name] || '';
}

/** 展示号码：自定义优先，否则角色名生成的 T9 伪号码。 */
function displayNumber(name: string): string {
  return readCustomNumber(name) || t9PseudoNumber(name);
}

/** 保存自定义号码：滤除非数字字符（1~20 位）；清空=删除回落伪号码。 */
function setCustomNumber(name: string, value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 20);
  mutatePhoneData(d => {
    if (digits) d.phoneNumbers = { ...(d.phoneNumbers || {}), [name]: digits };
    else if (d.phoneNumbers) delete d.phoneNumbers[name];
  });
  emitPhoneEvent('ubp-phone:data-changed');
  return digits;
}

function render(): void {
  if (!_ctx) return;
  if (_session) {
    const prevTop = callScrollBody(_ctx.container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是旧视图）
    _ctx.container.innerHTML = renderCallScreenHtml() + renderOverlayHtml();
    const lines = _ctx.container.querySelector('#ubp-call-lines');
    if (lines) lines.scrollTop = lines.scrollHeight;
    _viewScroll.settle('call-screen', prevTop); // 通话全屏层：只记旧视图位置（本层无 .ubp-appbody，贴底自管）
    return;
  }
  if (_contactName) renderContactDetail();
  else if (_detailId) renderDetail();
  else if (_tab === 'contacts') renderContacts();
  else if (_tab === 'dialer') renderDialer();
  else renderLog();
}

// ─── 通话记录 Tab ───

function renderLog(): void {
  const container = _ctx!.container;
  const prevTop = callScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是旧视图）
  const data = readPhoneDataSafe();
  const storeState = phoneStoreStatus();
  const storeBanner = storeState.state === 'read-only'
    ? `<div class="ubp-sys-msg error" style="margin:8px auto;">存储只读（${escapeHtml(storeState.error || '文件损坏')}）：可浏览，暂不能保存新记录</div>`
    : storeState.state === 'no-context' || storeState.state === 'error'
      ? `<div class="ubp-sys-msg error" style="margin:8px auto;">存储不可用（${escapeHtml(storeState.error || storeState.state)}）</div>`
      : '';
  const rows = (data.calls || []).map(rec => {
    // 语音留言（T1）：预览行尾胶囊（已听变灰）+ 未听红点（未播放过；播放即消）
    const vmDur = rec.voicemail?.length ? voicemailDurationSec(rec.voicemail) : 0;
    const vmChip = vmDur > 0
      ? `<span class="ubp-cl-vmchip${rec.voicemailSeen === true ? ' read' : ''}">${ubpIcon('mic')}${S('留言', '留音', '留话', '留音')} ${formatDuration(vmDur)}</span>`
      : '';
    const vmDot = voicemailUnheard(rec) ? '<span class="ubp-cl-newdot"></span>' : '';
    return `
    <div class="ubp-cl-row${rec.status === 'rejected' || rec.status === 'missed' ? ' missed' : ''}" data-ubp-act="open-detail" data-id="${escapeAttr(rec.id)}">
      <span class="ubp-cl-avatar" style="${rec.peerAvatar || resolveAvatarPath(rec.peerName) ? '' : `background:${avatarColor(rec.peerName)}`}">${callAvatarInner(rec.peerName, rec.peerAvatar)}</span>
      <span class="ubp-wx-main">
        <span class="ubp-wx-title">${escapeHtml(rec.peerName)}</span>
        <span class="ubp-wx-preview">${escapeHtml(callRecordPreview(rec))}${vmChip}</span>
      </span>
      <span class="ubp-wx-side">
        ${vmDot}
        <span class="ubp-cl-st st-${rec.status}">${ubpIcon(callStatusIcon(rec))}</span>
        <span class="ubp-wx-time">${escapeHtml(rec.storyTime || '')}</span>
      </span>
    </div>`;
  }).join('');
  container.innerHTML = `
    <div class="ubp-appbar"><span class="ubp-appbar-title">${S('电话', '神识传音')}</span></div>
    <div class="ubp-appbody noscroll">
      ${storeBanner}
      <div class="ubp-appbody" style="flex:1;">
        ${rows ? `<div class="ubp-wx-list">${rows}</div>` : `<div class="ubp-empty"><b>${S('还没有通话记录', '神念录还是空的')}</b><br>${S('去「通讯录」或「拨号盘」给角色打个电话', '去「道友录」或「引讯」向道友传一次神识', '去「名录」或「唤话」向人物传一声', '去「名录」或「唤语」向人物发一段远语')}</div>`}
      </div>
      ${tabbarHtml()}
    </div>
    ${renderOverlayHtml()}`;
  settleScroll(container, 'log', prevTop); // 跨视图保位：记录详情返回记录列表回到离开处
}

function tabbarHtml(): string {
  const tabs: Array<[Tab, string]> = [['log', S('通话记录', '神念录')], ['contacts', S('通讯录', '道友录')], ['dialer', S('拨号盘', '引讯')]];
  return `<div class="ubp-tabbar">${tabs.map(([id, label]) =>
    `<button class="ubp-tab${_tab === id ? ' active' : ''}" data-ubp-act="tab" data-id="${id}">${label}</button>`).join('')}</div>`;
}

// ─── 通讯录 Tab ───

function contactRowsHtml(): string {
  bindRosterInvalidation();
  const roster = getRoster();
  const customNames = readPhoneDataSafe().customContacts || [];
  if (!roster.hasDb && !customNames.length) {
    return `<div class="ubp-empty"><b>还没有联系人</b><br>主项目还没有可用角色</div>`;
  }
  const all = mergeCustomContacts(roster, customNames);
  const q = _contactQuery.trim();
  const section = (title: string, category: 'romance' | 'important' | 'custom') => {
    const list = all.filter(c => (c.custom ? category === 'custom' : c.category === category)
      && (!q || c.name.toLowerCase().includes(q.toLowerCase()) || q.includes(c.name.toLowerCase())));
    if (!list.length) return '';
    return `<div class="ubp-wx-grouphead">${title}<span class="wx-gcount">${list.length}</span></div>` + list.map(contactRowHtml).join('');
  };
  const html = section('恋爱对象', 'romance') + section('重要角色', 'important') + section('自定义', 'custom');
  return html || `<div class="ubp-empty">${q ? `没有叫「${escapeHtml(q)}」的联系人` : '还没有联系人'}</div>`;
}

/** 通讯录行：点主体区=人物详情（号码/资料/换背景）；点右侧电话图标=直接拨打。 */
function contactRowHtml(c: RosterContact): string {
  const brief = c.brief || c.identity || (c.gender ? `${c.gender}${c.age ? ' · ' + c.age : ''}` : '') || (c.custom ? S('自定义角色 · 数据库暂无档案', '自识道友 · 数据库暂无档案') : '');
  return `<div class="ubp-wx-row" data-ubp-act="contact-detail" data-id="${escapeAttr(c.name)}">
    ${avatarHtml(c.name)}
    <span class="ubp-wx-main">
      <span class="ubp-wx-title">${escapeHtml(c.name)}</span>
      <span class="ubp-wx-preview">${escapeHtml(brief)}</span>
    </span>
    <button class="ubp-cl-dial" data-ubp-act="contact-call" data-id="${escapeAttr(c.name)}" title="${S('直接拨打（长按可加提示）', '径直传音（长按可加提点）')}">${ubpIcon('handset')}</button>
  </div>`;
}

function renderContacts(): void {
  const container = _ctx!.container;
  const prevTop = callScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是旧视图）
  container.innerHTML = `
    <div class="ubp-appbar"><span class="ubp-appbar-title">${S('通讯录', '道友录')}</span></div>
    <div class="ubp-appbody noscroll">
      <div class="ubp-cl-searchbar">${ubpIcon('search')}<input id="ubp-ct-query" placeholder="${S('搜索联系人', '寻访道友')}" value="${escapeAttr(_contactQuery)}"></div>
      <div class="ubp-appbody" id="ubp-ct-list" style="flex:1;">${contactRowsHtml()}</div>
      ${tabbarHtml()}
    </div>
    ${renderOverlayHtml()}`;
  settleScroll(container, 'contacts', prevTop); // 跨视图保位：联系人详情返回通讯录回到离开处
}

// ─── 拨号盘 Tab ───

const DIAL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;
const DIAL_LETTERS: Record<string, string> = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '+' };

/** 拨号匹配：纯数字与井号星号键输入=号码前缀匹配（自定义号码优先，回落 T9 伪号码）；含其他字符=姓名模糊匹配。 */
function dialerMatches(): Array<{ name: string }> {
  const q = _dialQuery.trim();
  if (!q) return [];
  const contacts = mergeCustomContacts(getRoster(), readPhoneDataSafe().customContacts || []);
  return /^[\d*#]+$/.test(q) ? matchByDigits(q, contacts, c => displayNumber(c.name)) : matchByName(q, contacts);
}

function renderDialer(): void {
  const container = _ctx!.container;
  const prevTop = callScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是旧视图）
  const keys = DIAL_KEYS.map(k => `
    <button type="button" class="ubp-dial-key" data-ubp-act="dial-key" data-id="${k}">
      <b>${k}</b>${DIAL_LETTERS[k] ? `<i>${DIAL_LETTERS[k]}</i>` : '<i></i>'}
    </button>`).join('');
  container.innerHTML = `
    <div class="ubp-appbar"><span class="ubp-appbar-title">${S('拨号盘', '引讯')}</span></div>
    <div class="ubp-appbody noscroll">
      <div class="ubp-dialer">
        <div class="ubp-dialer-display">
          <input class="ubp-dialer-input" id="ubp-dial-input" placeholder="${S('输入号码或姓名', '录入道号或姓名', '录入名号或姓名', '念出名号或姓名')}" autocomplete="off">
          <div class="ubp-dialer-match" id="ubp-dial-match"></div>
        </div>
        <div class="ubp-dialer-pad">${keys}</div>
        <div class="ubp-dialer-actions">
          <span></span>
          <button type="button" class="ubp-dialer-call" data-ubp-act="dial-call" title="${S('拨打（长按可加提示）', '传音（长按可加提点）')}" disabled>${ubpIcon('handset')}</button>
          <button type="button" class="ubp-dialer-del" data-ubp-act="dial-del" title="${S('退格', '退格')}">${ubpIcon('backspace')}</button>
        </div>
      </div>
      ${tabbarHtml()}
    </div>
    ${renderOverlayHtml()}`;
  settleScroll(container, 'dialer', prevTop);
  updateDialerMatch();
}

/** 就地更新拨号匹配区与呼出钮（不整体重渲染——保输入焦点）。 */
function updateDialerMatch(): void {
  const container = _ctx?.container;
  if (!container) return;
  const input = container.querySelector('#ubp-dial-input') as HTMLInputElement | null;
  if (input && input.value !== _dialQuery) input.value = _dialQuery;
  const matchEl = container.querySelector('#ubp-dial-match');
  const callBtn = container.querySelector('[data-ubp-act="dial-call"]') as HTMLButtonElement | null;
  const delBtn = container.querySelector('[data-ubp-act="dial-del"]') as HTMLButtonElement | null;
  const hits = dialerMatches();
  if (matchEl) {
    matchEl.innerHTML = hits.length
      ? hits.map(c => `<button type="button" class="ubp-dialer-hit" data-ubp-act="dial-hit" data-id="${escapeAttr(c.name)}"><b>${escapeHtml(c.name)}</b><i>${escapeHtml(displayNumber(c.name))}</i></button>`).join('')
      : _dialQuery.trim()
        ? '<span class="ubp-dialer-nomatch">没有匹配的联系人</span>'
        : '';
  }
  if (callBtn) callBtn.disabled = hits.length === 0;
  if (delBtn) delBtn.style.visibility = _dialQuery ? 'visible' : 'hidden';
}

// ─── 记录详情 ───

/** 逐句重听的功能闸门（第六轮 ④，用户裁定「只在打开了对应功能时才显现」）：
 *  **语音总开关**（voiceEnabled）关着时手机根本没有语音能力；通话逐句朗读（voiceReadCalls）关着时，
 *  这一通电话从未被朗读 ⇒ 档案里没有音频指纹。两个条件都满足才渲染重听入口——**闸门关时一个节点都不渲染**。
 *  默认值 voiceEnabled=false + voiceReadCalls=false ⇒ 默认与改造前的详情页逐字节相同。
 *  （注意：情绪彩标不受本闸门控制——它只看总开关，见 renderDetail 的 showMeta。） */
function callReplayEnabled(): boolean {
  const s = getPhoneSettings();
  return isVoiceEnabled() && s.voiceReadCalls === true;
}

/** 正在重听的那一句（-1=没有）。单实例：点第二句会先停第一句。 */
let _replayIdx = -1;
let _replayState: 'loading' | 'playing' | null = null;
let _replayHandle: { stop(): void } | null = null;

/** 留言播放（T1）：非 null=正在逐行播放留言（串行，播完自动停）。 */
let _vmPlay: { idx: number; state: 'loading' | 'playing'; handle: { stop(): void } | null } | null = null;
/** 整段连播（T2）：非 null=连播进行中（seq=可播行下标序列，at=当前序号）。 */
let _replayAll: { seq: number[]; at: number; state: 'loading' | 'playing'; handle: { stop(): void } | null } | null = null;

/** 停掉重听并复位（rerender=false 用于卸载/切走路径：DOM 马上要没，不必重绘）。 */
function stopCallReplay(rerender = true): void {
  const had = _replayIdx >= 0;
  _replayIdx = -1;
  _replayState = null;
  const handle = _replayHandle;
  _replayHandle = null;
  try {
    // 有句柄就精确停这一条；没有句柄（状态已丢）时兜底停全局——播放器是全机单实例
    if (handle) handle.stop(); else stopVoice();
  } catch (_e) { /* ignore */ }
  if (had && rerender && _ctx) render();
}

/** 重听某一句：用**对方角色的音色**念出来（复用已落地的 TTS 播放器与缓存，不新建 AudioContext）。
 *  情绪/演绎取该行落库的标注，与首播同参 ⇒ 命中同一缓存 key，不重复合成。
 *  进度只就地改按钮上的 --ubp-rp（不整页重绘）——照「交互态局部变化优先原地更新」的既有纪律。 */
function replayCallLine(lineIdx: number, line: CallLine, rec: CallRecord): void {
  const peerName = rec.peerName;
  if (_vmPlay) stopVoicemailPlay(false); // 留言播放中：先停（三个播放会话互斥）
  if (_replayAll) stopReplayAll(false);  // 连播中：先停
  if (_replayIdx === lineIdx) { stopCallReplay(); return; }
  stopCallReplay(false);
  const plan = voicePlanFor(line.text, peerName, line.voiceEmotion || '', line.voiceDelivery || '');
  if (!plan) return; // 闸门已挡住「后端关闭」，这里是双保险：拿不到播放计划就什么都不做
  _replayIdx = lineIdx;
  _replayState = 'loading';
  render();
  _replayHandle = playVoice({
    backend: plan.backend,
    cacheKey: plan.cacheKey,
    text: plan.text,
    voiceId: plan.voiceId,
    providerId: plan.providerId,
    refAudio: plan.refAudio,
    role: plan.role,
    speed: plan.speed,
    emotion: plan.emotion,
    delivery: plan.delivery,
    onState: (st) => {
      if (_replayIdx !== lineIdx) return;
      if (st === 'ended' || st === 'error') { stopCallReplay(); return; }
      if (st === 'playing' && _replayState !== 'playing') {
        _replayState = 'playing';
        // L9 成就：重听对方台词真正开播才计（通话域）
        emitAch('phone_voice_played', { from: 'call' });
        render();
      }
    },
    onProgress: (ratio) => {
      if (_replayIdx !== lineIdx || !_ctx) return;
      const btn = _ctx.container.querySelector('.ubp-call-replay.playing') as HTMLElement | null;
      if (btn) btn.style.setProperty('--ubp-rp', `${Math.round(ratio * 100)}%`);
    },
  });
  prewarmNeighbors(callWarmSlots(rec), lineIdx); // 相邻预取：下一条优先（静默、不阻塞）
}

// ─── 语音留言播放（T1）与整段连播（T2） ───
// 三个播放会话（单句重听 / 留言播放 / 整段连播）互斥：任一开始前先停其余两个（见各入口首行）。
// 音频一律走 playVoice 唯一出口（缓存命中不重合成）；停止时句柄缺失兜底 stopVoice（播放器全机单实例）。

/** 通话行 → 相邻预取槽位（与 rec.lines 同下标；只有「对方 + 已固化音频」的行可播/可预取）。 */
function callWarmSlots(rec: CallRecord): VoiceWarmSlot[] {
  return rec.lines.map(l => (l.from !== 'me' && l.audio && l.text)
    ? { text: l.text, sender: rec.peerName, emotion: l.voiceEmotion || '', delivery: l.voiceDelivery || '' }
    : null);
}

/** 留言行 → 相邻预取槽位（留言按行序播放，下一条优先预取）。 */
function vmWarmSlots(rec: CallRecord): VoiceWarmSlot[] {
  return (rec.voicemail || []).map(l => (l.text
    ? { text: l.text, sender: rec.peerName, emotion: l.voiceEmotion || '', delivery: l.voiceDelivery || '' }
    : null));
}

/** 停掉留言播放并复位（rerender=false 用于卸载/切走路径：DOM 马上要没，不必重绘）。 */
function stopVoicemailPlay(rerender = true): void {
  const had = _vmPlay !== null;
  const handle = _vmPlay?.handle ?? null;
  _vmPlay = null;
  try {
    if (handle) handle.stop(); else if (had) stopVoice();
  } catch (_e) { /* ignore */ }
  if (had && rerender && _ctx) render();
}

/** 播放/停止留言（留言卡按钮）：整条留言逐行串行朗读；开始播放即视为「已听」（记录行红点消）。 */
function playVoicemail(recordId: string): void {
  const rec = findRecord(recordId);
  if (!rec?.voicemail?.length) return;
  if (_vmPlay) { stopVoicemailPlay(); return; } // 再点=停
  stopCallReplay(false);
  stopReplayAll(false);
  if (rec.voicemailSeen !== true) {
    mutatePhoneData(d => {
      const t = (d.calls || []).find(c => c.id === recordId);
      if (t?.voicemail?.length) t.voicemailSeen = true;
    });
  }
  vmPlayLine(rec, 0);
}

/** 播留言第 idx 行（播完自动接下一行；全部播完/出错即停）。 */
function vmPlayLine(rec: CallRecord, idx: number): void {
  const lines = rec.voicemail || [];
  if (idx >= lines.length) { stopVoicemailPlay(); return; }
  const line = lines[idx];
  const plan = voicePlanFor(line.text, rec.peerName, line.voiceEmotion || '', line.voiceDelivery || '');
  if (!plan) { stopVoicemailPlay(); return; }
  const session: { idx: number; state: 'loading' | 'playing'; handle: { stop(): void } | null } = { idx, state: 'loading', handle: null };
  _vmPlay = session;
  render();
  const handle = playVoice({
    backend: plan.backend,
    cacheKey: plan.cacheKey,
    text: plan.text,
    voiceId: plan.voiceId,
    providerId: plan.providerId,
    refAudio: plan.refAudio,
    role: plan.role,
    speed: plan.speed,
    emotion: plan.emotion,
    delivery: plan.delivery,
    onState: (st) => {
      if (_vmPlay !== session) return; // 已被停止/替换（含播完推进后的旧会话回调）
      if (st === 'ended') { vmPlayLine(rec, idx + 1); return; }
      if (st === 'error') { stopVoicemailPlay(); return; }
      if (st === 'playing') {
        session.state = 'playing';
        if (idx === 0) {
          // L9 成就：留言真正开播才计（「再点=停」与合成失败路径不打点）
          emitAch('phone_voicemail_played', {});
          emitAch('phone_voice_played', { from: 'voicemail' });
        }
        pinVoicemailAudio(rec.id, idx, plan.cacheKey); // 固化缓存指纹（幂等；重听/导出复用同一份音频）
        render();
      }
    },
  });
  if (_vmPlay === session) session.handle = handle;
  else { try { handle.stop(); } catch (_e) { /* 回调已提前推进（同步回调）：停掉这个迟到句柄 */ } }
  prewarmNeighbors(vmWarmSlots(rec), idx); // 相邻预取：留言下一句提前进缓存
}

/** 留言行音频指纹固化（幂等：只补空，不覆盖——同参播放 key 恒定）。 */
function pinVoicemailAudio(recordId: string, idx: number, cacheKey: string): void {
  mutatePhoneData(d => {
    const t = (d.calls || []).find(c => c.id === recordId);
    const line = t?.voicemail?.[idx];
    if (line && !line.audio) line.audio = cacheKey;
  });
}

/** 离开详情页（屏幕返回箭头 / 返回键 / 切 Tab / 换记录共用）：
 *  连播与留言播放即停（T1/T2「切走即停」口径——屏幕箭头走 handleClick，不经过 closeTopOverlay，别只改一处）。 */
function leaveDetail(): void {
  stopReplayAll(false);
  stopVoicemailPlay(false);
  _detailId = null;
}

/** 停掉整段连播（含行高亮复位；rerender=false 用于卸载/切换路径）。 */
function stopReplayAll(rerender = true): void {
  const had = _replayAll !== null;
  const handle = _replayAll?.handle ?? null;
  _replayAll = null;
  if (had) { _replayIdx = -1; _replayState = null; _replayHandle = null; } // 连播占用的行高亮同步清
  try {
    if (handle) handle.stop(); else if (had) stopVoice();
  } catch (_e) { /* ignore */ }
  if (had && rerender && _ctx) render();
}

/** 从头连播（T2）：按行序逐句播「已固化音频」的对方台词（与导出同序、同 voicePlanFor 参数——缓存命中不重合成）。 */
function replayAllStart(rec: CallRecord): void {
  const seq = replayableLineIndexes(rec);
  if (!seq.length) {
    if (_ctx) showScreenToast(_ctx.container, S('这条记录还没有可连播的录音', '此录尚无可用留音'));
    return;
  }
  if (_vmPlay) stopVoicemailPlay(false);
  stopCallReplay(false);
  _replayAll = { seq, at: 0, state: 'loading', handle: null };
  replayAllPlayCurrent(rec);
}

/** 播连播序列的当前句（播完自动推进；全部播完/出错即停）。 */
function replayAllPlayCurrent(rec: CallRecord): void {
  const session = _replayAll;
  if (!session) return;
  const lineIdx = session.seq[session.at];
  const line = rec.lines[lineIdx];
  if (!line) { stopReplayAll(); return; }
  const plan = voicePlanFor(line.text, rec.peerName, line.voiceEmotion || '', line.voiceDelivery || '');
  if (!plan) { stopReplayAll(); return; }
  session.state = 'loading';
  _replayIdx = lineIdx; // 复用单句重听的行高亮与进度环（.ubp-call-replay.playing / --ubp-rp）
  _replayState = 'loading';
  render();
  const handle = playVoice({
    backend: plan.backend,
    cacheKey: plan.cacheKey,
    text: plan.text,
    voiceId: plan.voiceId,
    providerId: plan.providerId,
    refAudio: plan.refAudio,
    role: plan.role,
    speed: plan.speed,
    emotion: plan.emotion,
    delivery: plan.delivery,
    onState: (st) => {
      if (_replayAll !== session) return;
      if (st === 'ended') {
        session.at += 1;
        if (session.at >= session.seq.length) { stopReplayAll(); return; }
        replayAllPlayCurrent(rec);
        return;
      }
      if (st === 'error') { stopReplayAll(); return; }
      if (st === 'playing') {
        session.state = 'playing';
        _replayState = 'playing';
        // L9 成就：整段连播只按一次（首句真正开播；中途切句不重复计）
        if (session.at === 0) emitAch('phone_voice_played', { from: 'call' });
        render();
      }
    },
    onProgress: (ratio) => {
      if (_replayAll !== session || !_ctx) return;
      const btn = _ctx.container.querySelector('.ubp-call-replay.playing') as HTMLElement | null;
      if (btn) btn.style.setProperty('--ubp-rp', `${Math.round(ratio * 100)}%`);
    },
  });
  if (_replayAll === session) session.handle = handle;
  else { try { handle.stop(); } catch (_e) { /* ignore */ } }
  prewarmNeighbors(callWarmSlots(rec), lineIdx); // 相邻预取：连播下一句提前进缓存（命中不重合成）
}

function renderDetail(): void {
  const container = _ctx!.container;
  const prevTop = callScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是旧视图）
  const rec = _detailId ? findRecord(_detailId) : null;
  if (!rec) {
    _detailId = null;
    renderLog();
    return;
  }
  const meName = getRoster().protagonistName || '我';
  const replay = callReplayEnabled();
  // 情绪彩标只受**总开关**控制（与重听闸门解耦）：开着朗读没开也照样能看到标注。
  const showMeta = isVoiceEnabled();
  const rows = rec.lines.map((l, i) => {
    const who = l.from === 'me' ? meName : rec.peerName;
    const me = l.from === 'me';
    // 情绪/演绎放在气泡**上方**：塞进气泡会把「喂？是我。」这种短句撑成又窄又高的竖条
    const meta = showMeta ? voiceMetaHtml(l.voiceEmotion, l.voiceDelivery) : '';
    // 闸门关（语音总开关关闭 or 未开逐句朗读）时 markup 与改造前一致——语音关闭时 meta 必为空串
    if (!replay) {
      return `<div class="ubp-chatlog-row${me ? ' me' : ''}">
      <span class="ubp-chatlog-name">${escapeHtml(who)} · ${formatDuration(l.relSec)}</span>
      <span class="ubp-call-col">${meta}<span class="ubp-chatlog-bubble">${escapeHtml(l.text)}</span></span>
    </div>`;
    }
    const canReplay = !me && Boolean(l.audio); // 我方台词不朗读；无音频指纹的旧档诚实置灰
    const playing = _replayIdx === i;
    const why = me ? '我方台词不朗读' : '这一句没有录音';
    return `<div class="ubp-chatlog-row${me ? ' me' : ''}${playing ? ' spk' : ''}">
      <span class="ubp-chatlog-name">${escapeHtml(who)} · ${formatDuration(l.relSec)}${playing ? ' · 正在播放' : ''}</span>
      <div class="ubp-call-line-row${me ? ' me' : ''}">
        <button type="button" class="ubp-call-replay${canReplay ? '' : ' off'}${playing && _replayState ? ' playing' : ''}"
          data-ubp-act="replay" data-idx="${i}" data-id="${escapeAttr(rec.id)}"${canReplay ? '' : ' disabled'}
          title="${canReplay ? '重听这一句' : why}" style="--ubp-rp:0%">${ubpIcon('playFill')}</button>
        <span class="ubp-call-col">${meta}<span class="ubp-chatlog-bubble">${escapeHtml(l.text)}${playing && _replayState === 'playing' ? '<span class="ubp-call-wave"><i></i><i></i><i></i></span>' : ''}</span></span>
      </div>
    </div>`;
  }).join('');
  // 详情回看同样套用通话背景（通话背景 > 头像），主题色蒙层保证明暗主题可读；取景只在展示的
  // 确为自定义通话背景时生效（cb:<名> 槽位参数属于那张图，回落头像时不套）
  const cbPath = readCallBg(rec.peerName);
  const bgPath = cbPath || rec.peerAvatar || resolveAvatarPath(rec.peerName);
  const cbTf = cbPath ? cropMediaStyle(`cb:${rec.peerName}`) : '';
  // 语音留言（T1）：留言卡（有留言才渲染；播放钮的可用态只看总开关——同「情绪彩标只受总开关控制」口径）
  const vmLines = rec.voicemail || [];
  const vmCard = vmLines.length ? voicemailCardHtml(rec, showMeta) : '';
  // 整段连播（T2）：与逐句重听同闸门；无可播行时不渲染（一个节点都不给）
  const replaySeq = replay ? replayableLineIndexes(rec) : [];
  const replayAllBar = replaySeq.length ? replayAllBarHtml(rec, replaySeq) : '';
  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="detail-back" title="返回">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${escapeHtml(rec.peerName)}</span>
      <button class="ubp-iconbtn" data-ubp-act="redial" data-id="${escapeAttr(rec.id)}" title="回拨">${ubpIcon('handset')}</button>
    </div>
    <div class="ubp-cl-detail">
      ${bgPath ? `<div class="ubp-cl-detail-bg"><div class="ubp-crop-media"${cbTf ? ` style="${cbTf}"` : ''}><img src="${escapeAttr(bgPath)}" alt=""></div><i></i></div>` : ''}
      <div class="ubp-appbody">
        <div class="ubp-cl-sum st-${rec.status}">
          <span class="ubp-cl-sum-icon">${ubpIcon(callStatusIcon(rec))}</span>
          <span class="ubp-cl-sum-main">
            <b>${escapeHtml(callRecordPreview(rec))}</b>
            <i>${escapeHtml(rec.storyTime || '')}</i>
          </span>
        </div>
        ${replayAllBar}
        ${rec.thought ? `<div class="ubp-cl-thought">${S('TA 当时在想：', 'TA 当时心念：')}${escapeHtml(rec.thought)}</div>` : ''}
        ${vmCard}
        <div class="ubp-chatlog-view" style="padding:10px 14px;">${rows || (vmCard ? '' : `<div class="ubp-hint" style="padding:14px 0;">${rec.status === 'rejected' ? S('对方没有接听', '对方神识未应') : S('通话内容为空', '传音内容为空')}</div>`)}</div>
      </div>
    </div>
    <div class="ubp-cl-actions">
      <button class="ubp-btn danger" data-ubp-act="del-call" data-id="${escapeAttr(rec.id)}">${S('删除记录', '删去此录')}</button>
      ${rec.lines.some(l => l.from !== 'me') || vmLines.length ? `<button class="ubp-btn" data-ubp-act="export-call" data-id="${escapeAttr(rec.id)}">${S('导出录音', '导出此录')}</button>` : ''}
      <button class="ubp-btn primary" data-ubp-act="redial" data-id="${escapeAttr(rec.id)}">${S('回拨', '再传一次')}</button>
    </div>
    ${renderOverlayHtml()}`;
  settleScroll(container, `detail:${rec.id}`, prevTop); // 按记录 id 分记（换一条不继承上一条的位置）
}

/** 留言卡 HTML（T1；稿 `.mockup/r8-voicemail.html`）：头行（图标+「语音留言」+时长·时间+播放钮）+ 逐行（彩标+演绎+文本）。 */
function voicemailCardHtml(rec: CallRecord, showMeta: boolean): string {
  const lines = rec.voicemail || [];
  const dur = voicemailDurationSec(lines);
  const playing = _vmPlay !== null;
  const enabled = isVoiceEnabled();
  const timeTag = rec.storyTime ? ` · ${escapeHtml(rec.storyTime)}` : '';
  const body = lines.map(l => `
    <div class="ubp-cl-vm-line">${showMeta ? voiceMetaHtml(l.voiceEmotion, l.voiceDelivery) : ''}<span class="ubp-cl-vm-txt">${escapeHtml(l.text)}</span></div>`).join('');
  return `<div class="ubp-cl-vm${playing ? ' playing' : ''}">
    <div class="ubp-cl-vm-hd">${ubpIcon('mic')}${S('语音留言', '神识留音', '传声留话', '远语留音')}<span class="t">${formatDuration(dur)}${timeTag}</span>
      <button type="button" class="ubp-cl-vm-play" data-ubp-act="play-voicemail" data-id="${escapeAttr(rec.id)}"${enabled ? '' : ' disabled'}
        title="${enabled ? '' : S('语音已关闭', '传音已关闭', '口信已关闭', '回声已关闭')}">${ubpIcon(playing ? 'stop' : 'playFill')}${playing ? S('停止', '停下', '收声', '止住') : S('播放留言', '听留音', '听留话', '听留音')}</button>
    </div>
    <div class="ubp-cl-vm-bd">${body}</div>
  </div>`;
}

/** 连播条 HTML（T2；稿 `.mockup/r8-voicemail.html` B 面）：按钮（状态随连播切换）+ 全序列时长估算。 */
function replayAllBarHtml(rec: CallRecord, seq: readonly number[]): string {
  const active = _replayAll !== null;
  const label = active
    ? S(`停止连播 · 第 ${Math.min(_replayAll!.at + 1, _replayAll!.seq.length)}/${_replayAll!.seq.length} 句`,
      `停下重听 · 第 ${Math.min(_replayAll!.at + 1, _replayAll!.seq.length)}/${_replayAll!.seq.length} 句`,
      `收声重听 · 第 ${Math.min(_replayAll!.at + 1, _replayAll!.seq.length)}/${_replayAll!.seq.length} 句`,
      `停下重听 · 第 ${Math.min(_replayAll!.at + 1, _replayAll!.seq.length)}/${_replayAll!.seq.length} 句`)
    : S('从头连播', '整段重听', '整段重听', '整段重听');
  const est = voicemailDurationSec(seq.map(i => rec.lines[i]));
  return `<div class="ubp-cl-replayall">
    <button type="button" class="ubp-btn" data-ubp-act="replay-all" data-id="${escapeAttr(rec.id)}">${ubpIcon(active ? 'stop' : 'playFill')}${label}</button>
    <span class="cnt">≈${formatDuration(est)}</span>
  </div>`;
}

// ─── 联系人详情（通讯录点行进入：号码/资料/拨打/更换通话背景） ───

function renderContactDetail(): void {
  const container = _ctx!.container;
  const prevTop = callScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是通讯录）
  const name = _contactName || '';
  // 合并自定义联系人：数据库收录同名前，自定义角色同样有详情页（空档案+伪号码，可拨打）
  const contact = mergeCustomContacts(getRoster(), readPhoneDataSafe().customContacts || []).find(c => c.name === name);
  if (!name || !contact) {
    _contactName = null;
    renderContacts();
    return;
  }
  const bgSet = Boolean(readCallBg(name));
  const identity = contact.identity || contact.brief || '';
  const profile = [contact.gender, contact.age].filter(Boolean).join(' · ');
  const rows = [
    `<div class="ubp-cd-row"><i>${S('电话', '道号')}</i><b>${escapeHtml(displayNumber(name))}</b><button class="ubp-cd-numedit" data-ubp-act="num-edit" title="${S('编辑手机号', '编辑道号')}">${ubpIcon('pencil')}</button></div>`,
    identity ? `<div class="ubp-cd-row"><i>${S('身份', '身份')}</i><span>${escapeHtml(identity)}</span></div>` : '',
    profile ? `<div class="ubp-cd-row"><i>${S('资料', '资料')}</i><span>${escapeHtml(profile)}</span></div>` : '',
    contact.languageStyle ? `<div class="ubp-cd-row"><i>${S('语言风格', '言谈风格')}</i><span>${escapeHtml(contact.languageStyle)}</span></div>` : '',
  ].join('');
  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="contact-back" title="${S('返回', '返回')}">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${S('联系人', '道友')}</span>
      <button class="ubp-iconbtn" data-ubp-act="contact-call" data-id="${escapeAttr(name)}" title="${S('直接拨打（长按可加提示）', '径直传音（长按可加提点）')}">${ubpIcon('handset')}</button>
    </div>
    <div class="ubp-appbody">
      <div class="ubp-cd-head">
        <span class="ubp-cd-avatar" style="${resolveAvatarPath(name) ? '' : `background:${avatarColor(name)}`}">${callAvatarInner(name)}</span>
        <span class="ubp-cd-name">${escapeHtml(name)}</span>
        <span class="ubp-cd-tag">${contact.custom ? S('自定义角色', '自识道友', '自识人物', '自识同伴') : contact.category === 'romance' ? '恋爱对象' : '重要角色'}</span>
      </div>
      <div class="ubp-cd-card">${rows}</div>
      <div class="ubp-cd-actions">
        <button class="ubp-btn primary" data-ubp-act="contact-call" data-id="${escapeAttr(name)}">${ubpIcon('handset')}　${S('拨打电话', '传出神识')}</button>
        <button class="ubp-btn" data-ubp-act="call-bg" data-id="${escapeAttr(name)}">${S('更换通话背景', '更换传音心境底图', '更换传声心境图', '更换远语星图')}${bgSet ? ` · ${S('已设置', '已设')}` : ''}</button>
      </div>
    </div>
    ${renderOverlayHtml()}`;
  settleScroll(container, `contact:${name}`, prevTop); // 按人名分记（换一位联系人不继承上一位的位置）
}

// ─── 通话全屏层 ───

function callAvatarInner(peerName: string, snapshot?: string): string {
  const path = snapshot || resolveAvatarPath(peerName);
  if (path) return `<img src="${escapeAttr(path)}" alt="">`;
  return escapeHtml(peerName.slice(0, 1));
}

function elapsedSec(): number {
  const s = _session;
  if (!s?.answeredAt) return 0;
  return Math.max(0, Math.floor((Date.now() - s.answeredAt) / 1000));
}

function renderCallLines(rec: CallRecord | null): string {
  const s = _session!;
  // 通话全屏界面同样显示情绪彩标（只看总开关）；朗读未开或关闭时 voiceMetaHtml 返回空串
  const showMeta = isVoiceEnabled();
  const rows = (rec?.lines || []).map(l =>
    `<div class="ubp-call-line${l.from === 'me' ? ' me' : ''}">${showMeta ? voiceMetaHtml(l.voiceEmotion, l.voiceDelivery) : ''}${escapeHtml(l.text)}</div>`).join('');
  const thinking = s.generating
    ? `<div class="ubp-call-hint"><span class="ubp-call-dots on"><i></i><i></i><i></i></span>${S('对方正在思考…', '对方正在凝神…', '对方正在沉吟…', '对方正在沉思…')}</div>`
    : '';
  const hint = !s.generating && s.hint ? `<div class="ubp-call-hint">${escapeHtml(s.hint)}</div>` : '';
  return rows + thinking + hint;
}

function renderCallScreenHtml(): string {
  const s = _session!;
  const rec = findRecord(s.recordId);
  // 背景图：通话背景 > 头像（默认铺底）；都没有=纯深色。取景只在确为自定义通话背景时套（同详情页口径）。
  // 图必须包在 .ubp-crop-media 里：铺满/cover 的尺寸规则只在该层（.ubp-call-bg img 只有 filter），
  // 取景 style 也是按媒体层口径生成——直接挂 <img> 上会按原图像素渲染，只露出左上角。
  const cbPath = readCallBg(s.peerName);
  const bgPath = cbPath || rec?.peerAvatar || resolveAvatarPath(s.peerName);
  const cbTf = cbPath ? cropMediaStyle(`cb:${s.peerName}`) : '';
  const bgHtml = bgPath
    ? `<div class="ubp-call-bg"><div class="ubp-crop-media"${cbTf ? ` style="${cbTf}"` : ''}><img src="${escapeAttr(bgPath)}" alt=""></div><i></i></div>`
    : '';
  let statusHtml = '';
  switch (s.phase) {
    case 'ringing':
      statusHtml = `<span class="ubp-call-status">${S('正在呼叫…', '神识连接中…', '铜管接通中…', '水晶共鸣中…')}<span class="ubp-call-dots"><i></i><i></i><i></i></span></span>`;
      break;
    case 'incoming':
      statusHtml = `<span class="ubp-call-status">${S('来电…', '神识来讯…')}<span class="ubp-call-dots"><i></i><i></i><i></i></span></span>`;
      break;
    case 'active':
      statusHtml = `<span class="ubp-call-status timer" id="ubp-call-timer">${formatDuration(elapsedSec())}</span>${_mute ? `<span class="ubp-call-mutebadge">${S('已静音', '已封音')}</span>` : ''}`;
      break;
    case 'rejected':
      statusHtml = `<span class="ubp-call-status warn">${S('对方拒接了来电', '对方神识未应', '对方不肯接话', '对方拒了这通远语')}</span>${s.rejectReason ? `<span class="ubp-call-sub">${escapeHtml(s.rejectReason)}</span>` : ''}`;
      break;
    case 'failed':
      statusHtml = `<span class="ubp-call-status warn">${escapeHtml(s.errorText || S('对方没有应答', '神识杳无回音'))}</span>`;
      break;
    case 'ended':
      statusHtml = `<span class="ubp-call-status">${escapeHtml(s.endText || S('通话结束', '神识归位'))}</span>`;
      break;
  }
  // 控制栏：振铃=取消；来电=接听/拒接；接通=说话/静音/挂断；其余=返回
  const ctl = (icon: Parameters<typeof ubpIcon>[0], label: string, act: string, cls = '') =>
    `<div class="ubp-call-ctl"><button type="button" class="ubp-call-btn${cls ? ' ' + cls : ''}" data-ubp-act="${act}">${ubpIcon(icon)}</button><span>${label}</span></div>`;
  const endCtl = (label: string, act = 'call-end') =>
    `<div class="ubp-call-ctl"><button type="button" class="ubp-call-btn end" data-ubp-act="${act}">${ubpIcon('handset')}</button><span>${label}</span></div>`;
  let controls: string;
  if (s.phase === 'ringing') controls = endCtl(S('取消', '收回'));
  else if (s.phase === 'incoming') {
    controls = [
      endCtl(S('拒接', '不接'), 'call-reject'),
      ctl('handset', S('接听', '相接'), 'call-accept', 'accept'),
    ].join('');
  }
  else if (s.phase === 'active') {
    controls = [
      ctl(_mute ? 'micOff' : 'mic', _mute ? S('取消静音', '解封声音', '解封声音', '解除静默') : S('静音', '封音'), 'call-mute', _mute ? 'on' : ''),
      ctl('mic', S('说话', '传念'), 'call-speak', 'speak'),
      endCtl(S('挂断', '断开')),
    ].join('');
  } else controls = endCtl(S('返回', '返回'));
  const thought = (s.thought || rec?.thought || '').trim();
  // 心理话全文显示（不截断）：形态是「左侧引线 + 斜体」的一小段，不再是与对白同形的实底气泡
  const thoughtHtml = (s.phase === 'active' || s.phase === 'ended') && thought
    ? `<div class="ubp-call-thought">${escapeHtml(thought)}</div>`
    : '';
  const linesHtml = s.phase === 'active' || s.phase === 'ended'
    ? `<div class="ubp-call-lines" id="ubp-call-lines">${renderCallLines(rec)}</div>`
    : '';
  // ── 顶栏（方案 C）──
  // 振铃/来电/拒接/失败恒为大版式（此时没有对白，大头像居中才是该有的样子）；
  // 接通/结束后由 callBarExpanded 决定：收起=紧凑信息带，展开=大版式。
  const canToggle = s.phase === 'active' || s.phase === 'ended';
  const useTop = !canToggle || _barExpanded;
  const avatarStyle = rec?.peerAvatar || resolveAvatarPath(s.peerName) ? '' : `background:${avatarColor(s.peerName)}`;
  const ringingCls = s.phase === 'ringing' || s.phase === 'incoming' ? ' ringing' : '';
  const avInner = callAvatarInner(s.peerName, rec?.peerAvatar);
  const toggleHtml = canToggle
    ? `<button type="button" class="ubp-call-toggle" data-ubp-act="call-bar-toggle" title="${useTop ? S('收起顶栏', '收起顶栏') : S('展开顶栏', '展开顶栏')}">${ubpIcon('chevron')}</button>`
    : '';
  const headHtml = useTop
    ? `<div class="ubp-call-top">
      <span class="ubp-call-avatar${ringingCls}" style="${avatarStyle}">${avInner}</span>
      <span class="ubp-call-name">${escapeHtml(s.peerName)}</span>
      ${statusHtml}
      ${toggleHtml}
    </div>`
    : `<div class="ubp-call-bar">
      <span class="ubp-call-bar-av" style="${avatarStyle}">${avInner}</span>
      <span class="ubp-call-bar-main">
        <span class="ubp-call-bar-name">${escapeHtml(s.peerName)}</span>
        <span class="ubp-call-bar-sub">${statusHtml}</span>
      </span>
      ${toggleHtml}
    </div>`;
  return `<div class="ubp-call-screen${canToggle && useTop ? ' bar-open' : ''}">
    ${bgHtml}
    ${headHtml}
    ${thoughtHtml}
    ${linesHtml}
    <div class="ubp-call-controls">${controls}</div>
  </div>`;
}

// ─── 覆盖层（「请讲话」+ 删除确认） ───

function renderOverlayHtml(): string {
  if (_overlay?.kind === 'confirm-delete') {
    const rec = findRecord(_overlay.id);
    if (!rec) { _overlay = null; return ''; }
    return `<div class="ubp-overlay" data-ubp-act="overlay-close">
      <div class="ubp-sheet" data-ubp-stop="1">
        <div class="ubp-sheet-title">${S('删除通话记录？', '删去此段传音记录？')}</div>
        <div class="ubp-sheet-body">${S(`将删除与「${escapeHtml(rec.peerName)}」的这条通话记录，不可恢复。`, `将删去与「${escapeHtml(rec.peerName)}」的这一段传音记录，不可挽回。`)}</div>
        <div class="ubp-sheet-actions">
          <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
          <button class="ubp-btn danger" data-ubp-act="del-call-confirm" data-id="${escapeAttr(rec.id)}">${S('删除', '删去')}</button>
        </div>
      </div>
    </div>`;
  }
  if (_overlay?.kind === 'num-edit') {
    const name = _contactName || '';
    return `<div class="ubp-overlay" data-ubp-act="num-close">
      <div class="ubp-sheet" data-ubp-stop="1">
        <div class="ubp-sheet-title">${S('编辑手机号', '编辑道号')}</div>
        <input class="ubp-fieldinput" style="margin-bottom:8px;" id="ubp-num-input" inputmode="numeric" maxlength="20"
          autocomplete="off" placeholder="${escapeAttr(t9PseudoNumber(name))}" value="${escapeAttr(_numEditDraft)}">
        <div class="ubp-sheet-body">${S('仅数字（1~20 位）；留空保存 = 恢复默认号码', '仅数字（1~20 位）；留空落定 = 复归本命道号')}</div>
        <div class="ubp-sheet-actions">
          <button class="ubp-btn" data-ubp-act="num-close">${S('取消', '作罢')}</button>
          <button class="ubp-btn primary" data-ubp-act="num-save">${S('保存', '记下')}</button>
        </div>
      </div>
    </div>`;
  }
  if (_speakOpen && _session?.phase === 'active') {
    return `<div class="ubp-overlay ubp-call-ovl" data-ubp-act="speak-close">
      <div class="ubp-sheet" data-ubp-stop="1">
        <div class="ubp-sheet-title">${S('请讲话', '请传念')}</div>
        <textarea class="ubp-textarea" id="ubp-speak-text" placeholder="${S(`对${escapeHtml(_session.peerName)}说…`, `向${escapeHtml(_session.peerName)}传念…`)}">${escapeHtml(_speakDraft)}</textarea>
        <div class="ubp-sheet-actions">
          <button class="ubp-btn" data-ubp-act="speak-close">${S('取消', '作罢')}</button>
          <button class="ubp-btn primary" data-ubp-act="speak-confirm" ${_speakDraft.trim() ? '' : 'disabled'}>${S('说出', '传念')}</button>
        </div>
      </div>
    </div>`;
  }
  return '';
}

// ─── 行为 ───

/** 长按通话记录行 → 删除确认（复用详情页「删除记录」同一 overlay 状态机，确认/取消按钮同源）。 */
function openDeleteCallSheet(recordId: string): void {
  if (!findRecord(recordId)) return;
  _overlay = { kind: 'confirm-delete', id: recordId };
  render();
}

function handleClick(event: Event): void {
  const target = event.target as HTMLElement;
  // 长按刚触发后的残留 click 吞掉（弹层 backdrop 铺满容器，不吞会被 overlay-close 当场关掉）
  if (Date.now() - _longPressFiredAt < 600) return;
  const stop = target.closest('[data-ubp-stop]');
  const el = target.closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  // 点在弹层内容内的非控件区域（冒泡到背景层）不关闭；弹层内真实按钮（stop 包含 el）放行
  if (stop && !stop.contains(el)) return;
  const id = el.dataset.id || '';
  switch (act) {
    case 'tab': stopReplayAll(false); stopVoicemailPlay(false); _tab = id === 'contacts' ? 'contacts' : id === 'dialer' ? 'dialer' : 'log'; _detailId = null; _contactName = null; render(); break;
    case 'replay': {
      // 逐句重听（第六轮 ④）：闸门关时不会渲染这个按钮，这里再挡一次（防旧 DOM 残留触发）
      if (!callReplayEnabled()) break;
      const rec = _detailId ? findRecord(_detailId) : null;
      const line = rec?.lines[Number(el.dataset.idx)];
      if (_replayAll) stopReplayAll(false); // 连播中点任意行：先停连播（_replayIdx 复位后走单播分支）
      if (rec && line && line.from !== 'me' && line.audio) replayCallLine(Number(el.dataset.idx), line, rec);
      break;
    }
    case 'play-voicemail': {
      // 留言播放（T1）：闸门=总开关（禁用按钮不派发）；再挡一次防旧 DOM 残留
      if (!isVoiceEnabled()) break;
      playVoicemail(id);
      break;
    }
    case 'replay-all': {
      // 整段连播（T2）：与逐句重听同闸门；进行中再点=停
      if (!callReplayEnabled()) break;
      if (_replayAll) { stopReplayAll(); break; }
      const rec = _detailId ? findRecord(_detailId) : null;
      if (rec) replayAllStart(rec);
      break;
    }
    case 'open-detail': stopReplayAll(false); stopVoicemailPlay(false); _detailId = id; render(); break;
    case 'detail-back': leaveDetail(); render(); break;
    case 'contact-detail': _contactName = id; render(); break;
    case 'contact-back': _contactName = null; render(); break;
    case 'num-edit': {
      const name = _contactName;
      if (!name) break;
      _overlay = { kind: 'num-edit' };
      _numEditDraft = readCustomNumber(name);
      render();
      const input = _ctx?.container.querySelector('#ubp-num-input') as HTMLInputElement | null;
      if (input) input.focus();
      break;
    }
    case 'num-close': _overlay = null; _numEditDraft = ''; render(); break;
    case 'num-save': handleNumSave(); break;
    case 'contact-call': startCall(id, undefined, 'contact'); break;
    case 'call-bg': {
      const container = _ctx?.container;
      if (container && id) {
        const current = readCallBg(id);
        openImagePickerSheet(container, {
          mode: 'setting',
          title: `更换通话背景 · ${id}`,
          portraitName: id,
          crop: { ratio: 0.52, slot: `cb:${id}`, kind: 'img', title: '通话背景' },
          current,
          currentText: '当前背景',
          defaultText: '默认用对方头像铺底',
          pickTip: '设为背景',
          onPick: img => { setCallBg(id, img.path); render(); },
          onImport: path => { setCallBg(id, path); render(); },
          onCropAdjusted: () => render(),
          ...(current ? { onReset: () => { clearCallBg(id); render(); } } : {}),
        });
      }
      break;
    }
    case 'redial': {
      const rec = findRecord(id);
      if (rec) startCall(rec.peerName, undefined, 'log');
      break;
    }
    case 'del-call': _overlay = { kind: 'confirm-delete', id }; render(); break;
    case 'del-call-confirm': {
      mutatePhoneData(d => { d.calls = deleteCallRecord(d.calls || [], id); });
      _overlay = null;
      stopReplayAll(false); // 记录已被删：连播/留言播放即停（避免对着不存在的记录继续播）
      stopVoicemailPlay(false);
      _detailId = null;
      render();
      emitPhoneEvent('ubp-phone:data-changed');
      break;
    }
    case 'overlay-close': _overlay = null; render(); break;
    case 'dial-key':
      if (_dialQuery.length < 16) _dialQuery += id;
      playDtmf(id);
      updateDialerMatch();
      break;
    case 'dial-del': _dialQuery = _dialQuery.slice(0, -1); updateDialerMatch(); break;
    case 'dial-hit': startCall(id, undefined, 'dialer'); break;
    case 'export-call': void exportCallTrack(id); break;
    case 'dial-call': {
      const hit = dialerMatches()[0];
      if (hit) startCall(hit.name, undefined, 'dialer');
      break;
    }
    case 'call-mute': _mute = !_mute; render(); break;
    case 'call-bar-toggle': {
      // 顶栏展收（方案 C）：写全局设置持久化；下次打开手机/下一通电话沿用同一选择
      _barExpanded = !_barExpanded;
      void savePhoneSettings({ callBarExpanded: _barExpanded });
      render();
      break;
    }
    case 'call-speak': {
      const s = _session;
      if (!s || s.phase !== 'active') break;
      if (s.generating || s.revealing) { toast(S('对方正在回应，稍等一下…', '对方正在回应，稍候片刻…')); break; }
      _speakOpen = true;
      _speakDraft = '';
      render();
      const input = _ctx?.container.querySelector('#ubp-speak-text') as HTMLTextAreaElement | null;
      if (input) input.focus();
      break;
    }
    case 'speak-close': _speakOpen = false; _speakDraft = ''; render(); break;
    case 'speak-confirm': handleSpeakConfirm(); break;
    case 'call-accept': acceptIncoming(); break;
    case 'call-reject': rejectIncoming(); break;
    case 'call-end': {
      const s = _session;
      if (!s) break;
      if (s.phase === 'ringing') cancelRinging();
      else if (s.phase === 'incoming') rejectIncoming();
      else if (s.phase === 'active') endCall();
      else dismissCallScreen();
      break;
    }
    default: break;
  }
}

function handleInput(event: Event): void {
  const target = event.target as HTMLElement;
  if (target.id === 'ubp-dial-input') {
    _dialQuery = (target as HTMLInputElement).value;
    updateDialerMatch();
  } else if (target.id === 'ubp-ct-query') {
    _contactQuery = (target as HTMLInputElement).value;
    const list = _ctx?.container.querySelector('#ubp-ct-list');
    if (list) list.innerHTML = contactRowsHtml();
  } else if (target.id === 'ubp-speak-text') {
    _speakDraft = (target as HTMLTextAreaElement).value;
    const btn = _ctx?.container.querySelector('[data-ubp-act="speak-confirm"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = !_speakDraft.trim();
  } else if (target.id === 'ubp-num-input') {
    _numEditDraft = (target as HTMLInputElement).value;
  }
}

function handleKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (target.id === 'ubp-speak-text' && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSpeakConfirm();
  }
  if (target.id === 'ubp-num-input' && event.key === 'Enter') {
    event.preventDefault();
    handleNumSave();
  }
}

function handleSpeakConfirm(): void {
  const text = _speakDraft.trim();
  if (!text || !_speakOpen) return;
  _speakOpen = false;
  _speakDraft = '';
  speak(text);
}

/** 保存手机号编辑：非数字滤除；空=恢复默认伪号码。 */
function handleNumSave(): void {
  const name = _contactName;
  if (!name || _overlay?.kind !== 'num-edit') return;
  const digits = setCustomNumber(name, _numEditDraft);
  _overlay = null;
  _numEditDraft = '';
  render();
  toast(digits ? S(`已更新手机号 ${digits}`, `已记下道号 ${digits}`) : S('已恢复默认号码', '已复归本命道号'));
}

function toast(text: string): void {
  if (_ctx) showScreenToast(_ctx.container, text);
}

// ─── DTMF 按键音（WebAudio 双音，无依赖；无音频环境静默）
//   音频上下文走 core/device-feedback 的唯一出口（全项目恒一个 AudioContext；浏览器有数量上限）

const DTMF_FREQS: Record<string, [number, number]> = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};

function playDtmf(key: string): void {
  try {
    const pair = DTMF_FREQS[key];
    if (!pair) return;
    const ctx = phoneAudioContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (const freq of pair) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.05, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.13);
    }
  } catch (_e) { /* 无音频环境静默 */ }
}

// ─── 通话生命周期 ───

function markCallsSeen(): void {
  const data = readPhoneDataSafe();
  if (!(data.calls || []).some(c => !c.seen)) return;
  mutatePhoneData(d => { (d.calls || []).forEach(c => { c.seen = true; }); });
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 拨出：先落 cancelled 记录（异常中断即保持 cancelled），进入振铃态并发起判定。
 *  回拨/重复拨打自动衔接：取与该角色最近一次有内容的通话作回拨判定与时间锚（历史内容由引擎混合记录块携带）。 */
/** 长按拨打入口 → 本次通话提示弹层（一次性；确认后按原路径拨打，提示只进首轮生成指令）。 */
function openCallHint(peerName: string, via: 'contact' | 'dialer'): void {
  if (!_ctx) return;
  if (_session) {
    toast(S('通话进行中，先结束当前通话', '传音正连，先断开当前神识', '传声正连，先收了当前这线', '远语正连，先断开当前共鸣'));
    return;
  }
  openOneShotHintSheet(_ctx.container, {
    title: S('本次通话提示', '本次传音提点', '本次传声提点', '本次远语提点'),
    confirmLabel: S('拨打', '传音'),
    onConfirm: hint => startCall(peerName, hint, via),
  });
}

function startCall(peerName: string, hint?: string, via: 'contact' | 'dialer' | 'log' = 'contact'): void {
  const name = peerName.trim();
  if (!name) return;
  if (_session) { toast(S('通话进行中，先结束当前通话', '传音正连，先断开当前神识', '传声正连，先收了当前这线', '远语正连，先断开当前共鸣')); return; }
  stopReplayAll(false); // 拨出=离开当前视图：连播/留言播放即停（通话屏即将接管）
  stopVoicemailPlay(false);
  const storeState = phoneStoreStatus();
  if (storeState.state === 'read-only' || storeState.state === 'no-context' || storeState.state === 'error') {
    toast(S(`存储不可用（${storeState.error || storeState.state}），无法拨打电话`, `存储不可用（${storeState.error || storeState.state}），无法传出神识`));
    return;
  }
  const roster = getRoster();
  const prevRecord = (readPhoneDataSafe().calls || []).find(c => c.peerName === name && c.lines.length > 0);
  const record: CallRecord = {
    id: makeCallRecordId(),
    peerName: name,
    peerAvatar: resolveAvatarPath(name) || undefined,
    direction: 'outgoing',
    status: 'cancelled',
    durationSec: 0,
    startedAt: Date.now(),
    ...(roster.global.time ? { storyTime: roster.global.time } : {}),
    lines: [],
    seen: true,
  };
  mutatePhoneData(d => { d.calls = addCallRecord(d.calls || [], record); });
  _detailId = null;
  _overlay = null;
  _speakOpen = false;
  _mute = false;
  _session = {
    recordId: record.id,
    peerName: name,
    phase: 'ringing',
    ...(prevRecord ? {
      prev: {
        ...(prevRecord.storyTime ? { storyTime: prevRecord.storyTime } : {}),
        lines: prevRecord.lines.slice(-MAX_TRANSCRIPT_LINES),
      },
    } : {}),
    generating: true,
    revealing: false,
    hangupPending: false,
  };
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手拨出成功（三种入口分线）+ 日窗口伴随（今天打过电话）
  emitAch('phone_call_dialed', { via });
  emitActionOnDate('phone_call');
  void runInitiate(record.id, hint);
}

async function runInitiate(recordId: string, hint?: string): Promise<void> {
  const s0 = _session;
  const peerName = s0?.peerName || '';
  const prevCall = s0?.prev;
  try {
    const { result } = await initiateCall({ peerName, prevCall, excludeCallId: recordId, ...(hint ? { extraHint: hint } : {}) });
    const s = _session;
    if (!s || s.recordId !== recordId) return; // 已取消/已换通话
    s.generating = false;
    if (result.status === 'rejected') {
      s.phase = 'rejected';
      s.rejectReason = result.rejectReason;
      if (result.thought) s.thought = result.thought;
      mutatePhoneData(d => {
        const rec = (d.calls || []).find(c => c.id === recordId);
        if (rec) {
          rec.status = 'rejected';
          if (result.rejectReason) rec.rejectReason = result.rejectReason;
          if (result.thought) rec.thought = result.thought;
        }
      });
      render();
      emitPhoneEvent('ubp-phone:data-changed');
      // 3 秒后自动返回记录页
      setTimeout(() => {
        if (_session === s && s.phase === 'rejected') dismissCallScreen();
      }, 3000);
      return;
    }
    s.phase = 'active';
    s.answeredAt = Date.now();
    if (result.thought) s.thought = result.thought;
    mutatePhoneData(d => {
      const rec = (d.calls || []).find(c => c.id === recordId);
      if (rec) {
        rec.status = 'answered';
        if (result.thought) rec.thought = result.thought;
      }
    });
    startTimer();
    emitCallActivity(); // 灵动岛上岛：通话接通（第五轮 ①）
    render();
    emitPhoneEvent('ubp-phone:data-changed');
    if (result.lines.length) {
      await revealLines(recordId, result.lines, result.hangup, result.lineTags);
    } else if (result.hangup) {
      endCall(S(`${peerName || '对方'}已挂断电话`, `${peerName || '对方'}已断开神识`), { stay: true }); // 接通后一句话没说就挂断
    } else {
      s.hint = S('（对方接听了，但沉默着）', '（神识相连，对方却沉默着）', '（铜管相连，对方却默不作声）', '（水晶相连，对方却沉默着）');
      render();
    }
  } catch (error) {
    const s = _session;
    if (!s || s.recordId !== recordId) return;
    s.generating = false;
    if (error instanceof PhoneChatError && error.kind === 'aborted') { s.phase = 'active'; s.errorText = ''; render(); return; }
    s.phase = 'failed';
    s.errorText = error instanceof PhoneChatError && error.kind === 'parse'
      ? S('对方没有应答…', '神识杳无回音…')
      : `${S('呼叫失败', '传音失败')}：${(error as Error)?.message || String(error)}`;
    render();
  }
}

/** 续话：我方输入上屏 → 生成 → 打字机投递对方行。 */
function speak(text: string): void {
  const s = _session;
  if (!s || s.phase !== 'active' || s.generating || s.revealing) return;
  appendLine(s.recordId, { from: 'me', text, relSec: elapsedSec() });
  s.generating = true;
  s.hint = undefined;
  render();
  void runContinue(s.recordId, text);
}

async function runContinue(recordId: string, utterance: string): Promise<void> {
  const s0 = _session;
  const peerName = s0?.peerName || '';
  const prevCall = s0?.prev;
  const callLines = (findRecord(recordId)?.lines || []).slice();
  try {
    const { result } = await continueCall({ peerName, userUtterance: utterance, callLines, prevCall, excludeCallId: recordId });
    const s = _session;
    if (!s || s.recordId !== recordId || s.phase !== 'active') return;
    s.generating = false;
    if (result.thought) s.thought = result.thought;
    if (result.lines.length) {
      await revealLines(recordId, result.lines, result.hangup, result.lineTags);
    } else if (result.hangup) {
      endCall(S(`${peerName || '对方'}已挂断电话`, `${peerName || '对方'}已断开神识`), { stay: true }); // 对方以挂断代替回应
    } else {
      s.hint = S('对方沉默了…', '对方静默不言…');
      render();
    }
  } catch (error) {
    const s = _session;
    if (!s || s.recordId !== recordId || s.phase !== 'active') return;
    s.generating = false;
    if (error instanceof PhoneChatError && error.kind === 'aborted') { render(); return; }
    s.hint = S(
      `（${(error as Error)?.message || '信号不佳'}——可以再说一次）`,
      `（${(error as Error)?.message || '神识波动'}——可再传一念）`);
    render();
  }
}

/** 通话逐句朗读：设置开启时按对方角色的音色念出该句（返回播放计划，同时固化进 CallLine.audio 供回看重播）。
 *  情绪/演绎来自该行的 AI 标注（call-parser.splitLineTag），一并进播放计划与缓存键——
 *  所以重听会用行上存的同一对情绪/演绎重算，命中同一份音频。 */
function callVoicePlan(text: string, peerName: string, emotion = '', delivery = ''): ReturnType<typeof voicePlanFor> {
  if (!getPhoneSettings().voiceReadCalls) return null;
  return voicePlanFor(text, peerName, emotion, delivery);
}

/** 播放一句并**等到本句念完**再返回（通话串行朗读：下一句必须等上一句播完，避免下一句一出现就打断上一句）。
 *  兜底上限＝预估时长（按语速折算）+ 余量，覆盖首次合成耗时；合成/播放失败（onState error）也立即放行，
 *  避免后端故障时整通电话卡死。会话被挂断/切走时由 250ms 轮询就地收尾（blob 后端停播不发 ended）。 */
function playCallVoiceAndWait(recordId: string, plan: ReturnType<typeof voicePlanFor>, text: string): Promise<void> {
  if (!plan) return Promise.resolve(); // 未开启逐句朗读：无语音，交给原打字机节奏
  return new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve();
    };
    // 兜底上限：预估时长/语速 + 6s 余量（合成慢或后端不回调时防卡死）
    const estMs = Math.round(estimateSeconds(text) / Math.max(0.5, plan.speed || 1) * 1000);
    timer = setTimeout(finish, Math.max(8000, estMs + 6000));
    poll = setInterval(() => {
      const cur = _session;
      if (!cur || cur.recordId !== recordId || cur.phase !== 'active') finish(); // 挂断/切走：就地收尾
    }, 250);
    playVoice({
      backend: plan.backend, cacheKey: plan.cacheKey, text: plan.text,
      voiceId: plan.voiceId, providerId: plan.providerId, refAudio: plan.refAudio, speed: plan.speed, emotion: plan.emotion, delivery: plan.delivery, role: plan.role,
      onState: (st) => { if (st === 'ended' || st === 'error') finish(); },
    });
  });
}

/** 导出这条通话记录里对方的台词为一个 WAV（只用已生成的音频；不重新合成、不花额度）。
 *  T1 起：语音留言行并入导出（同序追加在通话行之后）。 */
async function exportCallTrack(recordId: string): Promise<void> {
  const rec = findRecord(recordId);
  if (!rec || !_ctx) return;
  const peer = rec.peerName;
  const items = rec.lines
    .filter(l => l.from !== 'me')
    .map(l => ({
      cacheKey: l.audio || voicePlanFor(l.text, peer, l.voiceEmotion || '', l.voiceDelivery || '')?.cacheKey,
      text: l.text,
      role: peer,
    }));
  const vmItems = (rec.voicemail || []).map(l => ({
    cacheKey: l.audio || voicePlanFor(l.text, peer, l.voiceEmotion || '', l.voiceDelivery || '')?.cacheKey,
    text: l.text,
    role: peer,
  }));
  const all = [...items, ...vmItems];
  if (!all.length) { showScreenToast(_ctx.container, S('这条记录没有对方的台词', '此录无对方言语')); return; }
  try {
    const res = await exportVoiceTrack(all, `通话 ${peer}`);
    // L9 成就：导出成功（catch 分支不打点）
    emitAch('phone_call_exported', {});
    showScreenToast(_ctx.container, res.missing
      ? S(`已导出 ${res.saved} 句；还有 ${res.missing} 句没生成过语音`, `已导出 ${res.saved} 句；尚有 ${res.missing} 句未生成`)
      : S(`已导出 ${res.saved} 句 · ${res.name}`, `已导出 ${res.saved} 句 · ${res.name}`));
  } catch (e) {
    showScreenToast(_ctx.container, (e as Error)?.message || S('导出失败', '导出失败'));
  }
}

/** 逐行投递（同微信 revealDelay 节奏）；开启逐句朗读时本句念完才出下一句（串行不打断），未开启则纯打字机。
 *  投递完若 AI 已 <挂断> 自动结束。tags 与 lines 等长对齐（来源＝parseCallReply.lineTags）：
 *  情绪/演绎随行落库（voiceEmotion/voiceDelivery），重听与导出据此复现同一份音频。 */
async function revealLines(
  recordId: string,
  lines: string[],
  hangup: boolean,
  tags: ReadonlyArray<{ emotion?: string; delivery?: string }> = [],
): Promise<void> {
  const s = _session;
  if (!s || s.recordId !== recordId) return;
  s.revealing = true;
  s.hint = undefined;
  if (hangup) s.hangupPending = true;
  render();
  try {
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      await sleep(revealDelay(text));
      const cur = _session;
      if (!cur || cur.recordId !== recordId || cur.phase !== 'active') return;
      const emotion = tags[i]?.emotion || '';
      const delivery = tags[i]?.delivery || '';
      const plan = callVoicePlan(text, cur.peerName, emotion, delivery);
      appendLine(recordId, {
        from: 'peer', text, relSec: elapsedSec(),
        ...(plan ? { audio: plan.cacheKey } : {}),
        ...(emotion ? { voiceEmotion: emotion } : {}),
        ...(delivery ? { voiceDelivery: delivery } : {}),
      });
      render();
      await playCallVoiceAndWait(recordId, plan, text); // 串行朗读：本句念完才出下一句（文本像字幕贴着语音）
      const after = _session;
      if (!after || after.recordId !== recordId || after.phase !== 'active') return;
    }
  } finally {
    const cur = _session;
    if (cur && cur.recordId === recordId) {
      cur.revealing = false;
      if (cur.phase === 'active' && cur.hangupPending) {
        endCall(S(`${cur.peerName}已挂断电话`, `${cur.peerName}已断开神识`), { stay: true });
      } else render();
    }
  }
}

function appendLine(recordId: string, line: CallLine): void {
  mutatePhoneData(d => {
    const rec = (d.calls || []).find(c => c.id === recordId);
    if (!rec) return;
    rec.lines.push(line);
    if (rec.lines.length > MAX_CALL_LINES) rec.lines.splice(0, rec.lines.length - MAX_CALL_LINES);
  });
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 振铃中途取消：中止生成，记录保持 cancelled。 */
function cancelRinging(): void {
  const s = _session;
  if (!s || s.phase !== 'ringing') return;
  abortCallGeneration();
  // L9 成就：玩家亲手取消振铃（非接听成功 ⇒ 时长恒 0，状态栏只计接听成功时长）
  emitAch('phone_call_ended', { status: 'cancelled', durationSec: 0, direction: findRecord(s.recordId)?.direction ?? '' });
  _session = null;
  stopTimer();
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

// ─── 来电（世界演化联动） ───

/** 通话会话占线判定（来电到达时：占线则保持 missed 记录不弹来电界面=占线未接）。 */
export function isCallSessionBusy(): boolean {
  const phase = _session?.phase;
  return phase === 'ringing' || phase === 'incoming' || phase === 'active';
}

/** 来电开场（世界演化事件到达）：接管通话层进入 incoming 态（开场白存会话内存，接听才投递）。 */
export function beginIncomingCall(info: { recordId: string; peerName: string; opening: string[]; thought?: string }): void {
  const name = info.peerName.trim();
  if (!name || isCallSessionBusy()) return;
  stopReplayAll(false); // 来电全屏接管：连播/留言播放即停（通话屏即将覆盖）
  stopVoicemailPlay(false);
  // 回拨衔接口径与拨出一致：取与本角色最近一次有内容的通话作回拨判定与时间锚
  const prevRecord = (readPhoneDataSafe().calls || []).find(c => c.peerName === name && c.lines.length > 0);
  _detailId = null;
  _overlay = null;
  _speakOpen = false;
  _mute = false;
  _session = {
    recordId: info.recordId,
    peerName: name,
    phase: 'incoming',
    opening: info.opening.filter(Boolean).slice(0, 6),
    ...(info.thought ? { thought: info.thought } : {}),
    ...(prevRecord ? {
      prev: {
        ...(prevRecord.storyTime ? { storyTime: prevRecord.storyTime } : {}),
        lines: prevRecord.lines.slice(-MAX_TRANSCRIPT_LINES),
      },
    } : {}),
    generating: false,
    revealing: false,
    hangupPending: false,
  };
  startRingTone();
  emitPhoneEvent('ubp-phone:call-ring', true);
  render();
}

/** 接听来电：记录转 answered，开场白打字机投递，此后走正常通话流（说话/挂断）。 */
function acceptIncoming(): void {
  const s = _session;
  if (!s || s.phase !== 'incoming') return;
  s.phase = 'active';
  s.answeredAt = Date.now();
  stopRingTone();
  emitPhoneEvent('ubp-phone:call-ring', false);
  mutatePhoneData(d => {
    const rec = (d.calls || []).find(c => c.id === s.recordId);
    if (rec) {
      rec.status = 'answered';
      rec.seen = true;
      if (s.thought) rec.thought = s.thought;
    }
  });
  startTimer();
  emitCallActivity(); // 灵动岛上岛：接听来电（第五轮 ①）
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手接听成功（接听瞬间时长为 0；真实时长在挂断事件里累加）
  emitAch('phone_call_answered', { durationSec: 0 });
  const opening = s.opening || [];
  if (opening.length) {
    void revealLines(s.recordId, opening, false);
  } else {
    s.hint = S('（对方接听了，但沉默着）', '（神识相连，对方却沉默着）', '（铜管相连，对方却默不作声）', '（水晶相连，对方却沉默着）');
    render();
  }
}

/** 拒接来电：记录定格 rejected（incoming 语义=已拒接），返回记录页。 */
function rejectIncoming(): void {
  const s = _session;
  if (!s || s.phase !== 'incoming') return;
  stopRingTone();
  emitPhoneEvent('ubp-phone:call-ring', false);
  mutatePhoneData(d => {
    const rec = (d.calls || []).find(c => c.id === s.recordId);
    if (rec) {
      rec.status = 'rejected';
      rec.seen = true;
    }
  });
  const { recordId, peerName } = s;
  _session = null;
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手拒接（紧随其后的补留言是系统生成，不打点）
  emitAch('phone_call_rejected', {});
  // T1 语音留言：拒接=对方被挂断——后台补一条留言（闸门关时零请求，见 core/call-voicemail）
  void scheduleVoicemail({ recordId, peerName, scene: 'rejected' }).then(r => {
    if (r.ok) announceVoicemailReady(r);
  });
}

/** 留言生成完成后的统一播报（T1）：拒接路径在本 App 内调用；占线未接路径由 index.ts 同款调用
 *  （单一实现——core 落下库，通知/事件由调用方发射）。 */
export function announceVoicemailReady(r: VoicemailOutcome): void {
  emitPhoneEvent('ubp-phone:data-changed'); // 桌面角标/悬浮球
  emitPhoneNotify({
    appId: 'phone-call',
    title: r.peerName,
    text: S('留下了一条语音留言', '留下一段神识留音', '留下一段传声留话', '留下一段远语留音'),
    convId: r.recordId, // 横幅点按 → openApp('phone-call') 深链直达该条记录详情（mount 首帧消费）
  });
  emitPhoneEvent('ubp-phone:voicemail-ready', { recordId: r.recordId }); // 电话 App 开着时就地重绘
}

// ─── 来电铃声（WebAudio 双音循环；共用 device-feedback 的音频上下文，无音频环境静默） ───

let _ringTimer: ReturnType<typeof setInterval> | null = null;

function playRingBurst(): void {
  try {
    const ctx = phoneAudioContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (const freq of [440, 480]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.03, t0);
      gain.gain.setValueAtTime(0.03, t0 + 0.7);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.85);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.9);
    }
  } catch (_e) { /* 无音频环境静默 */ }
}

function startRingTone(): void {
  stopRingTone();
  playRingBurst();
  _ringTimer = setInterval(playRingBurst, 3000);
}

function stopRingTone(): void {
  if (_ringTimer) {
    clearInterval(_ringTimer);
    _ringTimer = null;
  }
}

/** 挂断（玩家红钮 / AI <挂断>）：定格时长。AI 挂断 stay=true：停留展示「XX已挂断电话」，
 *  等用户点红色按钮（返回）才退出；我方主动挂断维持短暂展示后自动返回。 */
function endCall(endNote?: string, opts?: { stay?: boolean }): void {
  const s = _session;
  if (!s || s.phase !== 'active') return;
  if (s.generating) abortCallGeneration(); // 生成中挂断：中止在途请求（续话结果不再消费）
  stopTimer();
  stopVoice(); // 挂断即停朗读
  const dur = elapsedSec();
  mutatePhoneData(d => {
    const rec = (d.calls || []).find(c => c.id === s.recordId);
    if (rec) rec.durationSec = dur;
  });
  s.phase = 'ended';
  s.endText = endNote
    ? `${endNote} · ${S('通话时长', '传音时长')} ${formatDuration(dur)}`
    : `${S('通话结束', '神识归位')} ${formatDuration(dur)}`;
  emitCallActivity(); // 灵动岛实时活动：通话结束（岛随之下线）
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：仅玩家亲手挂断计入（AI 挂断 opts.stay=true，非玩家动作不打点）
  if (!opts?.stay) emitAch('phone_call_ended', { status: 'answered', durationSec: dur, direction: findRecord(s.recordId)?.direction ?? '' });
  if (opts?.stay) return;
  setTimeout(() => {
    if (_session === s && s.phase === 'ended') dismissCallScreen();
  }, 1600);
}

function dismissCallScreen(): void {
  _session = null;
  _speakOpen = false;
  stopTimer();
  emitCallActivity(); // 会话彻底结束：再广播一次（幂等，岛侧只比对状态）
  render();
}

// ─── 计时器（DOM 就地更新，不重渲染） ───

function startTimer(): void {
  stopTimer();
  _timerInt = setInterval(() => {
    const s = _session;
    if (!s || s.phase !== 'active') {
      stopTimer();
      return;
    }
    const label = formatDuration(elapsedSec());
    const el = _ctx?.container.querySelector('#ubp-call-timer');
    if (el) el.textContent = label;
    // 灵动岛实时活动（第五轮 ①）：计时**不新增定时器**——就让这个随会话生灭的 1s interval
    // 兼做广播口。离开通话界面后该 interval 原本没有 DOM 目标可写（等于空转），正好由岛接手。
    emitPhoneEvent('ubp-phone:call-tick', label);
  }, 1000);
}

/** 通话会话状态 → 灵动岛（第五轮 ①）：只在「已接通」时算实时活动（振铃/失败/已结束都不上岛）。
 *  模块级调用点覆盖全部相位迁移（接通/挂断/彻底结束/拒绝/失败/重挂载），壳层只比对状态。 */
function emitCallActivity(): void {
  const s = _session;
  const active = Boolean(s && s.phase === 'active');
  emitPhoneEvent('ubp-phone:call-session', {
    active,
    peerName: active && s ? s.peerName : '',
    timer: active ? formatDuration(elapsedSec()) : '',
  });
}

/** 灵动岛展开卡的「挂断」（第五轮 ①②）：壳层不能 import 本 App（会成环）⇒ 只能走事件。
 *  **模块级绑定、不是 mount 内**——通话会话本身是模块级的，玩家退回桌面（App 卸载）后仍须能挂断；
 *  幂等守卫挂宿主 window（同 bindRosterInvalidation 的做法，重跑脚本不叠加）。 */
function bindIslandHangupBridge(): void {
  const w = hostWindow() as unknown as { __ubp_call_hangup_bound?: boolean };
  if (w.__ubp_call_hangup_bound) return;
  w.__ubp_call_hangup_bound = true;
  onPhoneEvent('ubp-phone:call-hangup', () => {
    const s = _session;
    if (!s || s.phase !== 'active') return;
    endCall(S('已挂断', '已断开神识', '已收线', '已断共鸣'));
  });
}

/** 留言到达桥（T1）：core 落库后由调用方派发 `ubp-phone:voicemail-ready`。
 *  电话 App 只在「正看着相关视图」时就地重绘（记录列表 / 该条记录详情）——
 *  正在通话全屏、开着弹层、或在别的 Tab 一律不抢渲染（模块级幂等绑定，同挂断桥先例）。 */
function bindVoicemailReadyBridge(): void {
  const w = hostWindow() as unknown as { __ubp_call_vm_bound?: boolean };
  if (w.__ubp_call_vm_bound) return;
  w.__ubp_call_vm_bound = true;
  onPhoneEvent('ubp-phone:voicemail-ready', payload => {
    const p = payload as { recordId?: string } | undefined;
    if (!p?.recordId || !_ctx) return;
    const s = _session;
    if (s && (s.phase === 'ringing' || s.phase === 'incoming' || s.phase === 'active')) return;
    if (_overlay) return; // 弹层开着（删除确认/号码编辑）：不在这时重绘列表
    if (_detailId === p.recordId || (!_detailId && !_contactName && _tab === 'log')) render();
  });
}

function stopTimer(): void {
  if (_timerInt) {
    clearInterval(_timerInt);
    _timerInt = null;
  }
}

// ─── App 定义 ───

// 模块级接线：灵动岛展开卡的挂断桥（幂等；通话会话是模块级的，App 卸载后仍须能挂断）
bindIslandHangupBridge();
// 模块级接线：留言到达桥（T1；幂等——无论 App 是否挂载，事件订阅只此一份）
bindVoicemailReadyBridge();

export const phoneCallApp: PhoneApp = {
  id: 'phone-call',
  name: '电话',
  icon: ubpIcon('handset'),
  color: '#34C759',
  available: true,
  /** 返回键：弹层 → 讲话面板 → 通话详情（与屏幕上的返回箭头同语义，IA-03）。 */
  closeTopOverlay(): boolean {
    if (_overlay) { _overlay = null; render(); return true; }
    if (_speakOpen) { _speakOpen = false; render(); return true; }
    if (_detailId) {
      // 离开详情 = 切走：连播/留言播放即停（T1/T2 口径「再点一次或切走即停」；与屏幕箭头共用 leaveDetail）
      leaveDetail();
      _contactName = null;
      render();
      return true;
    }
    return false;
  },
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _tab = 'log';
    _detailId = null;
    _contactName = null;
    _viewScroll.clear(); // 滚动记忆重置：重开 App 从顶开始，不继承上一次打开时的位置
    _dialQuery = '';
    _contactQuery = '';
    _overlay = null;
    _speakOpen = false;
    _barExpanded = getPhoneSettings().callBarExpanded === true; // 顶栏展收偏好（跨会话持久）
    ctx.container.addEventListener('click', handleClick);
    ctx.container.addEventListener('input', handleInput);
    ctx.container.addEventListener('keydown', handleKeydown);
    // 长按分派：通讯录电话图标/人物详情/拨号盘=本次通话提示；通话记录行=删除确认
    const unbindHintLongPress = bindHintLongPress(ctx.container, target => {
      const contactBtn = target.closest('[data-ubp-act="contact-call"]') as HTMLElement | null;
      const dialerBtn = target.closest('[data-ubp-act="dial-call"]') as HTMLElement | null;
      if (contactBtn || dialerBtn) {
        const name = contactBtn?.dataset.id || dialerMatches()[0]?.name || '';
        if (!name) return null;
        const via = contactBtn ? 'contact' as const : 'dialer' as const;
        return { el: (contactBtn || dialerBtn)!, fire: () => openCallHint(name, via) };
      }
      const logRow = target.closest('.ubp-cl-row[data-ubp-act="open-detail"]') as HTMLElement | null;
      if (logRow?.dataset.id) {
        return {
          el: logRow,
          fire: () => {
            _longPressFiredAt = Date.now();
            openDeleteCallSheet(logRow.dataset.id || '');
          },
        };
      }
      return null;
    });
    markCallsSeen(); // 打开即视为看过通话记录 → 未接角标清零
    // 全局搜索深链：目标=通话记录 id（openApp 恒为卸载再挂载 ⇒ 首帧消费即可，无需常驻监听）
    const deepLink = takePendingAppTarget('phone-call');
    if (deepLink && findRecord(deepLink)) _detailId = deepLink;
    if (_session?.phase === 'active') { startTimer(); emitCallActivity(); } // 后台通话恢复计时 + 重新上岛
    if (_session?.phase === 'incoming') startRingTone(); // 后台来电恢复铃声
    render();
    return () => {
      ctx.container.removeEventListener('click', handleClick);
      ctx.container.removeEventListener('input', handleInput);
      ctx.container.removeEventListener('keydown', handleKeydown);
      unbindHintLongPress();
      stopTimer();
      stopRingTone(); // 关手机/切走 App = 停铃声；来电会话保留，重开恢复
      stopVoice(); // 切走 App 也停朗读
      _speakOpen = false;
      _replayIdx = -1; // 逐句重听的状态随 App 一起复位（播放器已由上面 stopVoice 停掉）
      _replayState = null;
      _replayHandle = null;
      _replayAll = null; // 连播（T2）状态随 App 复位（音频已由 stopVoice 停掉）
      _vmPlay = null;    // 留言播放（T1）状态随 App 复位
      void persistPhoneData();
      _ctx = null;
      // 通话会话保留：生成/打字机在后台继续，下次打开恢复
    };
  },
};
