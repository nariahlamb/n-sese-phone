// ===== 窥私 App（角色间私密互动演绎，围观为主 + 消息编辑/删除与会话删除） =====
// 视图：list（聊天|通话 双 tab）/ chat（会话详情）/ call（通话转写详情，只读）。
// 主角完全不参与：无输入栏、无触发键；顶栏「生成」按钮（三段式请求走 spy-engine）——
// 单击=无参随机（用户定案保持原习惯），长按=本次生成弹层（会话内预置本场成员+默认严格=「接着演」）。
// 消息多选（长按进入）：编辑/删除复用微信机制（状态、类名、CSS、isMessageEditable 判定），不做转发。
// 会话列表行长按=整组删除确认（action-sheet）；生成失败 → spy.lastError 持久错误横幅。
// 图片消息复用聊天生图管线（autoImageGen 开启时进详情自动补图，占位可点手动生成）；
// 群聊显示群主/成员信息条；@高亮/语音/转账红包/聊天记录卡片沿用微信渲染口径。
// 皮肤兼容：文案全走 S()/s()；会话列表/气泡复用 .ubp-wx-*/.ubp-msg-* 既有组件类。

import { voiceBarMinWidth } from '../core/ubp-utils';
import { isCurrencyLinkActive, payResolveCurrency, moneyAmountText, currencyIconSvg, withPaySnapshot } from '../core/currency-link';
import {
  conversationPreview,
  isMessageEditable,
  setGroupAvatar,
  storyTimeShort,
  voiceDurationSeconds,
  type Conversation,
  type PhoneAlbumEntry,
  type PhoneGenRecord,
  type PhoneMessage,
  type SpyData,
} from '../core/chat-model';
import { callRecordPreview, callStatusIcon, formatDuration, type CallRecord } from '../core/call-model';
import { generatePhoneImage, getImageError } from '../core/chat-images';
import { buildPhoneChatContext, collectChatSubjects } from '../core/chat-image-prompts';
import { addPhoneAlbumEntries, makeAlbumEntryId, syncAlbumEntryForMessageImage } from '../core/phone-album';
import { getPhoneSettings, isVoiceEnabled } from '../core/phone-settings';
import { voiceMetaHtml } from './voice-meta';
import { abortSpyGeneration, clearSpyError, generateSpyContent, hasSpyGeneration } from '../core/spy-engine';
import { isPhoneAbortError } from '../core/phone-error';
import {
  createSpyGroupConversation,
  deleteSpyCall,
  deleteSpyConversation,
  ensureSpyPrivateConversation,
  findSpyGroupByTitle,
  spyPrivateId,
  spySelbarState,
} from '../core/spy-model';
import { mutatePhoneData, persistPhoneData, readPhoneData, readPhoneDataSafe } from '../core/phone-store';
import { getRoster, mergeCustomContacts, mergedContactNames } from '../core/roster';
import type { ImageGenRecord } from '../../unified-statusbar/core/image-gen';
import { refreshPhoneAvatars } from '../core/phone-avatars';
import { currentStyle, displayAmount, S } from '../core/skins';
import { hostDocument } from '../core/host-env';
import { bindHintLongPress, openOneShotHintSheet } from './hint-sheet';
import { openConfirmSheet } from './action-sheet';
import { openImagePickerSheet } from './image-picker-sheet';
import { emitPhoneEvent, onPhoneEvent, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { avatarHtml, createViewScrollMemo, escapeAttr, escapeHtml, groupAvatarHtml, renderTextWithMentions, showScreenToast } from './phone-ui';
import { ubpIcon } from './icons';
import { openPhoneLightbox } from './image-lightbox';
import { playVoice, stopVoice } from '../core/voice-tts';
import { voicePlanFor } from '../core/chat-voice';
import { emitAch } from '../core/phone-achievements';

type View = 'list' | 'chat' | 'call';

let _ctx: PhoneAppContext | null = null;
let _view: View = 'list';
let _tab: 'chats' | 'calls' = 'chats';
let _chatId: string | null = null;
let _callId: string | null = null;
let _busy = false;
let _lastHint = ''; // 上次手动尝试（重试钮重放：人物选择+额外提示+严格开关+本场会话；自动失败重放同参）
let _lastFocus: string[] = [];
let _lastStrict = false;
let _lastConvId = '';
let _abortRequested = false;
let _mountToken = 0;
// 长按多选（编辑/删除；复用微信 .ubp-selbar/.ubp-msg-check 机制，不做转发）
let _selectMode = false;
let _selected = new Set<string>();
let _editMsgId: string | null = null; // 编辑消息弹层：目标消息 id（多选恰好单选且可编辑才可开）
let _editDraft = '';                  // 编辑消息弹层：内容草稿
let _longPressFiredAt = 0;            // 长按触发时间戳：吞掉随后的 click（防选中态被立即翻转，对齐微信做法）
const _imageJobs = new Set<string>();
let _playingVoiceId = '';
let _voiceTimer: ReturnType<typeof setTimeout> | null = null;
// 上一次渲染的会话 id（聊天内滚动保位用：同会话且条数未变=保位，切会话/来新消息=贴底）
let _renderedChatId: string | null = null;
// 跨视图滚动记忆：会话/通话列表 → 通话详情 → 返回不回顶（聊天跟底自管，不入记忆的落位一侧）
const _viewScroll = createViewScrollMemo();

/** 当前视图的滚动体（列表=嵌套内层 .ubp-appbody；通话详情=唯一 .ubp-appbody）。 */
function spyScrollBody(container: HTMLElement): HTMLElement | null {
  const all = container.querySelectorAll('.ubp-appbody');
  return (all[all.length - 1] as HTMLElement | undefined) || null;
}

function spyOf(data: ReturnType<typeof readPhoneData>): SpyData | null {
  return data.spy || null;
}

function findSpyConversation(convId: string): Conversation | null {
  return spyOf(readPhoneDataSafe())?.conversations.find(c => c.id === convId) || null;
}

/** 进入窥私会话的**状态部分**（不渲染）：清未读 + 置视图态。
 *  「点会话行」与「通知中心深链首帧」共用一份，避免两处口径漂移。 */
function enterSpyConversation(convId: string): void {
  mutatePhoneData(d => {
    const c = d.spy?.conversations.find(x => x.id === convId);
    if (c) c.unread = 0;
  });
  _chatId = convId;
  _view = 'chat';
}

function findSpyCall(recordId: string): CallRecord | null {
  return spyOf(readPhoneDataSafe())?.calls.find(c => c.id === recordId) || null;
}

function render(): void {
  if (!_ctx) return;
  // O34：一次渲染只读一遍货币账本（窥私列表逐条转账/红包气泡复用同一份快照）
  withPaySnapshot(dispatchRender);
}

function dispatchRender(): void {
  if (_view === 'chat') renderChat();
  else if (_view === 'call') renderCallDetail();
  else renderList();
}

// ─── 错误横幅（持久：点击清除；下次成功生成由引擎作废） ───

function errorBannerHtml(spy: SpyData | null): string {
  const err = spy?.lastError;
  if (!err) return '';
  return `<div class="ubp-spy-errorbar" data-ubp-act="dismiss-error" title="${S('点击不再显示', '点击不再显示')}">
    ${ubpIcon('callMissed')}<span class="ubp-spy-errorbar-text">${escapeHtml(err.text)}</span>
    <button class="ubp-spy-errorbar-retry" data-ubp-act="retry-gen" title="${S('按上次的人物选择与提示重试', '按上次的人物选择与提点重试')}">${S('重试', '重试')}</button>
    <span class="ubp-spy-errorbar-close">${S('知道了', '知道了')}</span>
  </div>`;
}

// ─── 列表（聊天|通话） ───

function renderList(): void {
  const container = _ctx!.container;
  const prevTop = spyScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是旧视图）
  const data = readPhoneDataSafe();
  const spy = spyOf(data);
  const enabled = getPhoneSettings().spyEnabled;
  const disabledHint = enabled ? '' : `<div class="ubp-empty"><b>${S('窥私功能未开启', '窥私之术未开启', '密探之术未开启', '窥视之术未开启')}</b><br>${S('到「设置 → 功能 → 窥私」打开总开关', '到「设置 → 功能 → 窥私」开启窥私之术', '到「设置 → 功能 → 窥私」开启密探之术', '到「设置 → 功能 → 窥私」开启窥视之术')}</div>`;

  let bodyInner: string;
  if (_tab === 'calls') {
    bodyInner = renderCallList(spy);
  } else {
    const convs = [...(spy?.conversations || [])].sort((a, b) => b.updatedAt - a.updatedAt);
    const rows = convs.map(conv => {
      const isGroup = conv.kind === 'group';
      const last = conv.messages[conv.messages.length - 1];
      const time = storyTimeShort(last?.storyTime || '');
      const avatar = isGroup
        ? groupAvatarHtml(conv, S('群', '盟', '会', '桌'))
        : avatarHtml(conv.members[0] || conv.title);
      return `<div class="ubp-wx-row" data-ubp-act="open-conv" data-id="${escapeAttr(conv.id)}">
        ${avatar}
        <span class="ubp-wx-main">
          <span class="ubp-wx-title">${escapeHtml(conv.title)}${isGroup ? ` <span class="ubp-inline-sub">(${conv.members.length})</span>` : ''}</span>
          <span class="ubp-wx-preview">${escapeHtml(conversationPreview(conv))}</span>
        </span>
        <span class="ubp-wx-side">
          <span class="ubp-wx-time">${escapeHtml(time)}</span>
          ${conv.unread > 0 ? `<span class="ubp-wx-badge">${conv.unread > 99 ? '99+' : conv.unread}</span>` : ''}
        </span>
      </div>`;
    }).join('');
    bodyInner = disabledHint || (rows
      ? `<div class="ubp-wx-list">${rows}</div>`
      : `<div class="ubp-empty"><b>${S('还没有窥私记录', '尚无窥私记录', '尚无密报记录', '尚无窥视记录')}</b><button class="ubp-empty-btn" data-ubp-act="generate">${S('生成', '推演')}</button></div>`);
  }

  container.innerHTML = `
    <div class="ubp-appbar">
      <span class="ubp-appbar-title">${S('窥私', '窃语符', '江湖密报', '预言之眼')}</span>
      ${_tab === 'chats' ? `<button class="ubp-iconbtn" data-ubp-act="new-conv" title="${S('新建会话（手动建场，不触发生成）', '另起符卷（手动立卷，不触发推演）', '另立密报（手动立卷，不触发探录）', '另启窥视（手动立卷，不触发窥探）')}" ${!enabled ? 'disabled' : ''}>${ubpIcon('plus')}</button>` : ''}
      <button class="ubp-iconbtn" data-ubp-act="generate" title="${S('生成角色间互动', '推演角色间符讯', '探录角色间书信', '窥探角色间晶讯')}" ${_busy || !enabled ? 'disabled' : ''}>
        <span class="${_busy ? 'ubp-spin' : ''}">${ubpIcon('refresh')}</span>
      </button>
    </div>
    <div class="ubp-appbody noscroll">
      ${errorBannerHtml(spy)}
      <div class="ubp-chat" style="flex:1;">
        <div class="ubp-appbody" style="flex:1;">
          ${bodyInner}
        </div>
        <div class="ubp-tabbar">
          <button class="ubp-tab${_tab === 'chats' ? ' active' : ''}" data-ubp-act="tab" data-id="chats">${S('聊天', '符讯', '书信', '晶讯')}</button>
          <button class="ubp-tab${_tab === 'calls' ? ' active' : ''}" data-ubp-act="tab" data-id="calls">${S('通话', '传音', '传声', '远语')}</button>
        </div>
      </div>
    </div>`;
  // 跨视图保位：通话详情返回列表回到离开处；同视图重绘（生成完成/清未读）原位保全
  const body = spyScrollBody(container);
  if (body) body.scrollTop = _viewScroll.settle(`list:${_tab}`, prevTop).top;
}

function renderCallList(spy: SpyData | null): string {
  const calls = [...(spy?.calls || [])].sort((a, b) => b.startedAt - a.startedAt);
  if (!calls.length) {
    return `<div class="ubp-empty"><b>${S('还没有通话记录', '尚无传音记录', '尚无传声记录', '尚无远语记录')}</b><button class="ubp-empty-btn" data-ubp-act="generate">${S('生成', '推演')}</button></div>`;
  }
  const rows = calls.map(record => {
    const caller = record.caller || S('我', '我');
    const parties = `${caller} ⇄ ${record.peerName}`;
    return `<div class="ubp-wx-row" data-ubp-act="open-call" data-id="${escapeAttr(record.id)}">
      ${avatarHtml(record.peerName || parties)}
      <span class="ubp-wx-main">
        <span class="ubp-wx-title">${escapeHtml(parties)}</span>
        <span class="ubp-wx-preview">${escapeHtml(callRecordPreview(record))}</span>
      </span>
      <span class="ubp-wx-side">
        <span class="ubp-wx-time">${escapeHtml(storyTimeShort(record.storyTime || ''))}</span>
        <span class="ubp-wx-callicon">${ubpIcon(callStatusIcon(record))}</span>
      </span>
    </div>`;
  }).join('');
  return `<div class="ubp-wx-list">${rows}</div>`;
}

// ─── 会话详情（只读） ───

function renderChat(): void {
  const container = _ctx!.container;
  const prevTop = spyScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是列表视图）
  // 会话内保位（对齐微信 app-wechat renderChat）：重绘前记下位置与非系统消息条数，同会话且条数没变
  // → 原位恢复（长按开/关多选、勾选、编辑、生图态刷新都不再被打回底部）；首次打开/切会话/来新消息 → 贴底
  const prevMsgs = container.querySelector('#ubp-chat-msgs') as HTMLElement | null;
  const prevMsgsTop = prevMsgs?.scrollTop ?? 0;
  const prevMsgCount = prevMsgs ? prevMsgs.querySelectorAll('.ubp-msg-row[data-mid]').length : -1;
  const sameConv = _renderedChatId === _chatId;
  const conv = _chatId ? findSpyConversation(_chatId) : null;
  if (!conv) {
    _renderedChatId = null;
    _view = 'list';
    renderList();
    return;
  }
  const isGroup = conv.kind === 'group';
  // 私聊左右分栏：第二位成员固定右侧（复用 .me 微信气泡口径）；群聊维持全员左侧围观
  const rightSideName = isGroup ? '' : (conv.members[1] || '');
  let lastStory = '';
  const rows: string[] = [];
  if (isGroup) {
    rows.push(`<div class="ubp-sys-msg">${S(`群主：${conv.owner || '未记录'} · ${conv.members.length}人`, `盟主：${conv.owner || '未录'} · ${conv.members.length}人`, `会首：${conv.owner || '未录'} · ${conv.members.length}人`, `圆桌主：${conv.owner || '未录'} · ${conv.members.length}人`)}</div>`);
  }
  for (const m of conv.messages) {
    if (m.storyTime && m.storyTime !== lastStory) {
      rows.push(`<div class="ubp-time-divider">${escapeHtml(m.storyTime)}</div>`);
      lastStory = m.storyTime;
    }
    rows.push(renderMessage(m, isGroup, isGroup ? conv.members : null, rightSideName));
  }
  // 空会话引导（手动新建/AI 建场的空会话都适用；docs/13）
  if (!conv.messages.length) {
    rows.push(`<div class="ubp-empty"><b>${S('这场会话还没有内容', '此卷尚无记载', '此封密报尚无内容', '此段窥视尚无内容')}</b><button class="ubp-empty-btn" data-ubp-act="generate">${S('生成', '推演')}</button></div>`);
  }
  const busy = _busy || hasSpyGeneration();
  if (busy) {
    rows.push(`<div class="ubp-typing"><span class="ubp-typing-dots"><i></i><i></i><i></i></span></div>`);
  }
  const selbar = spySelbarState(_selected, conv.messages);
  container.innerHTML = `
    <div class="ubp-appbar">
      ${_selectMode
        ? `<button class="ubp-iconbtn" data-ubp-act="sel-cancel" title="${S('取消', '作罢')}">${ubpIcon('back')}</button>
           <span class="ubp-appbar-title" id="ubp-sel-count">${S('已选', '已择')} ${_selected.size} ${S('项', '则')}</span>`
        : `<button class="ubp-iconbtn" data-ubp-act="back" title="返回">${ubpIcon('back')}</button>
           <span class="ubp-appbar-title">${escapeHtml(conv.title)}${isGroup ? `<span class="ubp-appbar-sub">（${conv.members.length}人）</span>` : ''}</span>
           ${isGroup ? `<button class="ubp-iconbtn" data-ubp-act="conv-avatar" title="${S('更换群头像', '更换盟头像', '更换会徽', '更换圆桌纹章')}">${ubpIcon('more')}</button>` : ''}
           <button class="ubp-iconbtn" data-ubp-act="generate" title="${S('生成更多（长按可指定人物接着本场演）', '再推演一幕（长按可指定人物续演本场）', '再录一段（长按可指定人物续演本场）', '再窥一幕（长按可指定人物续演本场）')}" ${_busy ? 'disabled' : ''}>
             <span class="${_busy ? 'ubp-spin' : ''}">${ubpIcon('refresh')}</span>
           </button>`}
    </div>
    <div class="ubp-chat">
      <div class="ubp-chat-msgs" id="ubp-chat-msgs">${rows.join('')}</div>
      ${busy ? `<div class="ubp-genbar">${S('角色们正在互动…', '符讯推演中…', '书信拟就中…', '晶讯窥探中…')}<button data-ubp-act="abort">${S('终止', '终止')}</button></div>` : ''}
      ${_selectMode ? `
      <div class="ubp-selbar">
        <button class="ubp-btn" data-ubp-act="sel-all" id="ubp-sel-all">${selbar.allSelected ? S('取消全选', '尽数取消') : S('全选', '全选')}</button>
        <button class="ubp-btn" data-ubp-act="sel-edit" id="ubp-sel-edit" ${selbar.canEdit ? '' : 'disabled'}>${S('编辑', '改写')}</button>
        <button class="ubp-btn danger" data-ubp-act="sel-delete" id="ubp-sel-delete" ${selbar.canDelete ? '' : 'disabled'}>${S('删除', '删除')}</button>
      </div>` : ''}
    </div>`;
  const msgs = container.querySelector('#ubp-chat-msgs') as HTMLElement | null;
  if (msgs) {
    const count = conv.messages.filter(m => m.from !== 'system').length;
    const keep = sameConv && prevMsgCount >= 0 && count === prevMsgCount;
    msgs.scrollTop = keep ? prevMsgsTop : msgs.scrollHeight;
  }
  _renderedChatId = _chatId;
  // 列表侧：进会话记下列表位置，返回时列表才回得到原处（聊天本身跟底自管，不落记忆位）
  _viewScroll.settle(`chat:${_chatId}`, prevTop);
  pumpImages(conv);
}

/** 单条消息气泡（复用微信渲染口径）。私聊时 rightSideName 侧的消息右对齐。
 *  多选态：行带 data-mid 锚点 + 勾选框 + sel/picked 类（复用 .ubp-msg-check/.ubp-msg-row.sel|.picked）。 */
function renderMessage(m: PhoneMessage, isGroup: boolean, groupMembers: string[] | null = null, rightSideName = ''): string {
  if (m.from === 'system') {
    return `<div class="ubp-sys-msg">${escapeHtml(m.content)}</div>`;
  }
  const senderName = m.from;
  const me = !!rightSideName && senderName === rightSideName;
  // 头像恒渲染（用户定案 2026-10-07：与微信同口径——无立绘也出生成头像＝占位图，同角色处处同色）。
  // 窥私本次只做「常显」，不做点击开资料卡（那一条用户未定；要做只需把这里换成 avatarActHtml）。
  const avatar = avatarHtml(senderName, 'small', true);
  const nameTag = isGroup ? `<span class="ubp-msg-name">${escapeHtml(senderName)}</span>` : '';
  let body: string;
  if (m.type === 'image') {
    if (m.imageStatus === 'ready' && m.imagePath) {
      // 点击放大（全机统一入口）；重新生图在放大页里（气泡不再单挂刷新按钮）
      body = `<div class="ubp-bubble-img"><img src="${escapeAttr(m.imagePath)}" alt="" data-ubp-act="lightbox" data-id="${escapeAttr(m.imagePath)}" loading="lazy"></div>`;
    } else if (m.imageStatus === 'failed') {
      const imgErr = getImageError(m.id);
      body = `<div class="ubp-img-pending ubp-img-failed" data-ubp-act="gen-image" data-id="${escapeAttr(m.id)}"><span class="ubp-mo-imgph-note">⚠ ${S('生成失败', '留影失败', '写真失败', '记影失败')}</span>${imgErr ? `<span class="ubp-img-reason">${escapeHtml(imgErr)}</span>` : ''}<span class="ubp-mo-imgph-desc">${escapeHtml(m.content.slice(0, 60))}</span><span class="ubp-mo-imgph-hint">点击重试</span></div>`;
    } else if (_imageJobs.has(m.id)) {
      body = `<div class="ubp-img-pending" data-ubp-act="gen-image" data-id="${escapeAttr(m.id)}"><span class="ubp-spinner"></span><span class="ubp-mo-imgph-desc">${escapeHtml(m.content.slice(0, 60) || S('生成中…', '推演中…', '描绘中…', '映照中…'))}</span><span class="ubp-mo-imgph-hint">${S('生成中…', '推演中…', '描绘中…', '映照中…')}</span></div>`;
    } else {
      body = `<div class="ubp-img-pending" data-ubp-act="gen-image" data-id="${escapeAttr(m.id)}">${ubpIcon('image')}<span class="ubp-mo-imgph-desc">${escapeHtml(m.content.slice(0, 60))}</span><span class="ubp-mo-imgph-hint">点击生成</span></div>`;
    }
  } else if (m.type === 'voice') {
    body = renderVoice(m);
  } else if (m.type === 'transfer' || m.type === 'redpacket') {
    body = renderMoneyCard(m, senderName);
  } else if (m.type === 'chatlog') {
    body = `<div class="ubp-chatlog-card">
      <span class="ubp-chatlog-icon">${ubpIcon(m.fwdSrc ? 'share' : 'chatlog')}</span>
      <span class="ubp-chatlog-main"><b>${escapeHtml(m.fwdSrc || S('聊天记录', '符讯辑录', '书信辑录', '晶讯辑录'))}</b><i>${escapeHtml(m.content)}</i></span>
    </div>`;
  } else {
    body = `<span class="ubp-bubble">${isGroup && groupMembers ? renderTextWithMentions(m.content, groupMembers) : escapeHtml(m.content)}</span>`;
  }
  const col = `<span class="ubp-msg-col">${nameTag}<span class="ubp-msg-meta">${body}</span></span>`;
  const check = _selectMode ? `<button type="button" class="ubp-msg-check${_selected.has(m.id) ? ' on' : ''}" tabindex="-1">${_selected.has(m.id) ? '✓' : ''}</button>` : '';
  const cls = `ubp-msg-row${me ? ' me' : ''}${_selectMode ? ' sel' : ''}${_selected.has(m.id) ? ' picked' : ''}`;
  return me
    ? `<div class="${cls}" data-mid="${escapeAttr(m.id)}">${check}${col}${avatar}</div>`
    : `<div class="${cls}" data-mid="${escapeAttr(m.id)}">${check}${avatar}${col}</div>`;
}

/** 群聊文本里的 @名字/@所有人 高亮（成员名精确匹配，其余按普通文字）。 */
function renderMoneyCard(m: PhoneMessage, senderName: string): string {
  const curMeta = isCurrencyLinkActive() ? payResolveCurrency(m.currency) : null;
  const amount = curMeta ? moneyAmountText(m.amount, curMeta) : displayAmount(m.amount, currentStyle());
  if (m.type === 'redpacket') {
    return `<div class="ubp-card redpacket">
      <span class="ubp-card-side"><i class="ubp-rp-icon">${ubpIcon('wechat')}</i></span>
      <span class="ubp-card-main"><b>${escapeHtml(m.content || S('恭喜发财 大吉大利', '福泽绵长 大道亨通', '彩头送君 好运自来', '财源广进 荣耀加身'))}</b><i>${escapeHtml(senderName)}${S('的红包', '的灵石福袋', '的赏钱', '的钱袋')}</i></span>
      <span class="ubp-card-amt">${escapeHtml(amount)}</span>
    </div>`;
  }
  return `<div class="ubp-card transfer">
    <span class="ubp-card-main"><b>${escapeHtml(amount)}</b><i>${escapeHtml(m.content || S('转账', '灵石转让', '银票汇兑', '金币转赠'))}</i></span>
    <span class="ubp-card-side"><i class="ubp-card-glyph">${curMeta ? currencyIconSvg(curMeta.icon, 16) : S('¥', '灵', '银', '金')}</i><i>${S('转账', '转让', '汇兑', '转赠')}</i></span>
  </div>`;
}

function renderVoice(m: PhoneMessage): string {
  const dur = voiceDurationSeconds(m.content);
  const enabled = isVoiceEnabled();
  const playing = enabled && _playingVoiceId === m.id;
  const offTag = enabled ? '' : `<span class="ubp-voice-offtag">${ubpIcon('micOff')}${S('语音已关闭', '传音已关闭')}</span>`;
  const bar = `<button type="button" class="ubp-voice-bar" data-ubp-act="voice-play" data-id="${escapeAttr(m.id)}" aria-label="${S('播放语音', '传音回响')}${dur}秒"${enabled ? '' : ' disabled'}>${ubpIcon('voiceWave')}<span class="ubp-voice-dur">${dur}''</span>${offTag}</button>`;
  const meta = enabled ? voiceMetaHtml(m.voiceEmotion, m.voiceDelivery) : '';
  const transcript = m.content ? `<span class="ubp-voice-text">${escapeHtml(m.content)}</span>` : '';
  return `<span class="ubp-voice${playing ? ' playing' : ''}${enabled ? '' : ' off'}" style="min-width:${voiceBarMinWidth(dur)}px;">${bar}${meta}${transcript}</span>`;
}

// ─── 通话转写详情（只读） ───

function renderCallDetail(): void {
  const container = _ctx!.container;
  const prevTop = spyScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是列表视图）
  const record = _callId ? findSpyCall(_callId) : null;
  if (!record) {
    _view = 'list';
    renderList();
    return;
  }
  const caller = record.caller || S('我', '我');
  const callee = record.peerName;
  // 一来一回：拨出方台词右侧（from='me' 口径同电话 App），接听方左侧
  const rows = record.lines.map(l => {
    const who = l.from === 'me' ? caller : callee;
    const me = l.from === 'me';
    const col = `<span class="ubp-msg-col"><span class="ubp-msg-name">${escapeHtml(who)} · ${formatDuration(l.relSec)}</span><span class="ubp-msg-meta"><span class="ubp-bubble">${escapeHtml(l.text)}</span></span></span>`;
    const avatar = avatarHtml(who, 'small', true); // 同消息行口径：恒出头像（占位图）
    return `<div class="ubp-msg-row${me ? ' me' : ''}">${me ? col + avatar : avatar + col}</div>`;
  }).join('');
  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="back" title="返回">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${escapeHtml(`${caller} ⇄ ${callee}`)}<span class="ubp-appbar-sub">${escapeHtml(callRecordPreview(record))}</span></span>
      <span style="width:32px;"></span>
    </div>
    <div class="ubp-appbody" style="overflow-y:auto;">
      ${record.storyTime ? `<div class="ubp-time-divider">${escapeHtml(record.storyTime)}</div>` : ''}
      ${rows}
      ${record.lines.length ? '' : `<div class="ubp-empty">${escapeHtml(callRecordPreview(record))}</div>`}
      <div style="height:20px;"></div>
    </div>`;
  // 通话详情按记录 id 分记（换一条记录不继承上一条的滚动位置；首次进入=0 从顶开始）
  const body = spyScrollBody(container);
  if (body) body.scrollTop = _viewScroll.settle(`call:${_callId}`, prevTop).top;
}

// ─── 图片生成泵（复用聊天生图管线；窥私发送者恒为角色） ───

function pumpImages(conv: Conversation): void {
  if (!getPhoneSettings().autoImageGen) return;
  for (const m of conv.messages) {
    if (m.type === 'image' && m.imageStatus === 'pending' && !_imageJobs.has(m.id)) {
      void startSpyImageJob(conv.id, m.id);
    }
  }
}

function retrySpyImage(messageId: string): void {
  const conv = _chatId ? findSpyConversation(_chatId) : null;
  if (!conv || _imageJobs.has(messageId)) return;
  mutatePhoneData(d => {
    const msg = d.spy?.conversations.find(c => c.id === conv.id)?.messages.find(m => m.id === messageId);
    if (msg && msg.type === 'image') msg.imageStatus = 'pending';
  });
  render();
  void startSpyImageJob(conv.id, messageId);
}

async function startSpyImageJob(convId: string, messageId: string): Promise<void> {
  const conv = findSpyConversation(convId);
  const msg = conv?.messages.find(m => m.id === messageId);
  if (!conv || !msg || msg.type !== 'image') return;
  const roster = getRoster();
  const senderName = msg.from;
  const oldImagePath = msg.imagePath || '';
  let genRecord: ImageGenRecord | undefined;
  _imageJobs.add(messageId);
  try {
    const path = await generatePhoneImage({
      messageId,
      description: msg.content,
      subjects: collectChatSubjects(senderName, false, msg.content, roster),
      roster,
      chatContext: buildPhoneChatContext(conv.messages, roster.protagonistName),
      stem: `phone_${messageId.replace(/^spy_/, 's')}`,
      fixed: msg.imagePrompt
        ? { promptText: msg.imagePrompt, negativePrompt: msg.imageNegative || '', multiJson: msg.imagePromptMulti }
        : undefined,
      onPromptReady: (promptText, negativePrompt, multiJson) => {
        mutatePhoneData(d => {
          const mm = d.spy?.conversations.find(c => c.id === convId)?.messages.find(x => x.id === messageId);
          if (mm && mm.type === 'image') {
            mm.imagePrompt = promptText;
            mm.imageNegative = negativePrompt;
            if (multiJson) mm.imagePromptMulti = multiJson;
            else delete mm.imagePromptMulti;
          }
        });
      },
      onRecord: record => { genRecord = record; },
    });
    mutatePhoneData(d => {
      const msg2 = d.spy?.conversations.find(c => c.id === convId)?.messages.find(m => m.id === messageId);
      if (msg2 && msg2.type === 'image') {
        msg2.imagePath = path;
        msg2.imageStatus = 'ready';
      }
    });
    if (oldImagePath) {
      syncAlbumEntryForMessageImage(oldImagePath, path, genRecord);
    } else {
      addPhoneAlbumEntries([{
        id: makeAlbumEntryId(),
        path,
        source: 'chat',
        characters: [senderName].slice(0, 6),
        desc: msg.content,
        ...(msg.imagePrompt ? { imagePrompt: msg.imagePrompt, imageNegative: msg.imageNegative || '' } : {}),
        ...(genRecord ? { gen: genRecord as unknown as PhoneGenRecord } : {}),
        createdAt: Date.now(),
      } satisfies PhoneAlbumEntry]);
    }
    emitPhoneEvent('ubp-phone:data-changed');
  } catch (_e) {
    mutatePhoneData(d => {
      const msg2 = d.spy?.conversations.find(c => c.id === convId)?.messages.find(m => m.id === messageId);
      if (msg2 && msg2.type === 'image') msg2.imageStatus = 'failed';
    });
  } finally {
    _imageJobs.delete(messageId);
    if (_ctx && _chatId === convId && _view === 'chat') render();
  }
}

// ─── 生成 ───

/**
 * 长按「生成」→ 本次生成提示弹层（一次性，不落盘）。候选=引擎同款焦点池：合并视图
 * （数据库+自定义联系人）−主角−在场。会话内增强（「接着演」）：候选池并入本场成员
 * （在场也保留）+ 预置勾选本场成员 + 默认勾「只用选中的人」（列表页保持「只写提示就随机」现状）。
 */
function openGenerateHint(): void {
  if (!_ctx || _busy || hasSpyGeneration()) return;
  const roster = getRoster();
  const me = roster.protagonistName;
  const basePool = mergedContactNames(roster, readPhoneDataSafe().customContacts || [])
    .filter(n => n && n !== me && !roster.present[n]);
  const conv = _view === 'chat' && _chatId ? findSpyConversation(_chatId) : null;
  const memberPool = conv ? conv.members.filter(n => n && n !== me) : [];
  const pool = Array.from(new Set([...basePool, ...memberPool]));
  openOneShotHintSheet(_ctx.container, {
    title: S('本次生成提示', '本次推演提点', '本次探录提点', '本次窥探提点'),
    confirmLabel: S('生成', '推演'),
    ...(pool.length ? { contacts: pool } : {}),
    ...(conv
      ? {
          initialPicked: [...memberPool],
          toggle: {
            label: S('只用选中的人（不随机补足）', '只用选中之人（不随机补足）', '只用选中之人（不随机补足）', '只用选中之人（不随机补足）'),
            initial: true,
          },
          canConfirm: (_hint, picked, toggleOn) => !toggleOn || picked.length >= 2,
        }
      : {}),
    onConfirm: (hint, picked, toggleOn) => { void doGenerate(hint, picked, toggleOn, conv?.id); },
  });
}

async function doGenerate(hint?: string, focusNames?: string[], strict?: boolean, focusConvId?: string): Promise<void> {
  if (_busy || hasSpyGeneration()) return;
  if (!getPhoneSettings().spyEnabled) {
    _ctx && showScreenToast(_ctx.container, S('窥私功能未开启', '窥私之术未开启', '密探之术未开启', '窥视之术未开启'));
    return;
  }
  _lastHint = hint || '';
  _lastFocus = focusNames && focusNames.length ? [...focusNames] : [];
  _lastStrict = !!strict;
  _lastConvId = focusConvId || '';
  _busy = true;
  render();
  try {
    const { outcomes, droppedFocus, discarded } = await generateSpyContent({
      reason: 'manual',
      ...(hint ? { extraHint: hint } : {}),
      ...(focusNames && focusNames.length ? { focusNames } : {}),
      ...(strict ? { strictFocus: true } : {}),
      ...(focusConvId ? { focusConversationId: focusConvId } : {}),
    });
    if (discarded) return; // 已切聊天：本轮产物整体丢弃，不提示、不派发（F1）
    const okCount = outcomes.filter(o => o.ok).length;
    // 反静默收口：越界被忽略的段数与池外被忽略的点名都明示（上游「静默换人」坑的对策）
    const ignoredCount = outcomes.filter(o => !o.ok && o.reason === 'invalid-parties').length;
    const droppedMsg = droppedFocus && droppedFocus.length
      ? S(`${droppedFocus.join('、')} 不在候选范围，已忽略`, `${droppedFocus.join('、')}不在候选之列，已略去`)
      : '';
    const okMsg = okCount > 0
      ? (ignoredCount > 0
        ? S(`已生成 ${okCount} 段互动（${ignoredCount} 段因人物越界被忽略）`, `已推演 ${okCount} 幕（${ignoredCount} 幕越界忽略）`, `已录得 ${okCount} 段（${ignoredCount} 段越界忽略）`, `已窥见 ${okCount} 幕（${ignoredCount} 幕越界忽略）`)
        : S(`已生成 ${okCount} 段互动`, `已推演 ${okCount} 幕`, `已录得 ${okCount} 段`, `已窥见 ${okCount} 幕`))
      : S('没有生成有效内容', '未推演出有效内容', '未录得有效内容', '未窥见有效内容');
    _ctx && showScreenToast(_ctx.container, droppedMsg || okMsg);
    emitPhoneEvent('ubp-phone:data-changed');
  } catch (error) {
    if (_abortRequested || isPhoneAbortError(error)) {
      _abortRequested = false;
      clearSpyError(); // 主动终止不算失败：清掉引擎写入的错误通知
      _ctx && showScreenToast(_ctx.container, S('已终止', '已终止'));
    } else {
      _ctx && showScreenToast(_ctx.container, String(error instanceof Error ? error.message : error));
    }
  } finally {
    _busy = false;
    render();
  }
}

// ─── 多选（编辑/删除；长按消息进入） ───

function enterSpySelectMode(messageId: string): void {
  if (!messageId) return;
  _selectMode = true;
  _selected = new Set([messageId]);
  render();
}

function exitSpySelectMode(): void {
  _selectMode = false;
  _selected.clear();
  _editMsgId = null;
}

/** 多选选中态就地同步（唯一出口：按钮禁用态+逐行勾+全选文案；不重绘——重绘会把消息区滚到底部）。
 *  按钮可用态与行渲染共用 spySelbarState 纯函数，消灭「模板写一次+同步再写一次」的双写面。 */
function syncSelUi(): void {
  const container = _ctx?.container;
  if (!container || !_selectMode) return;
  const conv = _chatId ? findSpyConversation(_chatId) : null;
  const st = spySelbarState(_selected, conv?.messages || []);
  const count = container.querySelector('#ubp-sel-count');
  if (count) count.textContent = `${S('已选', '已择')} ${_selected.size} ${S('项', '则')}`;
  const edit = container.querySelector('#ubp-sel-edit') as HTMLButtonElement | null;
  const del = container.querySelector('#ubp-sel-delete') as HTMLButtonElement | null;
  const all = container.querySelector('#ubp-sel-all') as HTMLButtonElement | null;
  if (edit) edit.disabled = !st.canEdit;
  if (del) del.disabled = !st.canDelete;
  if (all) all.textContent = st.allSelected ? S('取消全选', '尽数取消') : S('全选', '全选');
  container.querySelectorAll('.ubp-msg-row[data-mid]').forEach(row => {
    const mid = (row as HTMLElement).dataset.mid || '';
    const on = _selected.has(mid);
    row.classList.toggle('picked', on);
    const check = row.querySelector('.ubp-msg-check');
    if (check) {
      check.classList.toggle('on', on);
      check.textContent = on ? '✓' : '';
    }
  });
}

/** 多选模式点击路由：顶栏/操作条按钮放行，其余落在消息行上一律当勾选（与微信同口径）。 */
function handleSpySelectClick(target: HTMLElement): void {
  const el = target.closest('[data-ubp-act]') as HTMLElement | null;
  const act = el?.dataset.ubpAct || '';
  if (act === 'sel-cancel') {
    exitSpySelectMode();
    render();
    return;
  }
  if (act === 'sel-all') {
    const conv = _chatId ? findSpyConversation(_chatId) : null;
    if (conv) {
      const st = spySelbarState(_selected, conv.messages);
      _selected = st.allSelected
        ? new Set()
        : new Set(conv.messages.filter(m => m.from !== 'system').map(m => m.id));
      syncSelUi();
    }
    return;
  }
  if (act === 'sel-edit') {
    openSpyEditSheet();
    return;
  }
  if (act === 'sel-delete') {
    openSpyDeleteMessagesSheet();
    return;
  }
  if (act === 'abort') {
    _abortRequested = true;
    abortSpyGeneration();
    return;
  }
  const row = target.closest('.ubp-msg-row[data-mid]') as HTMLElement | null;
  if (row?.dataset.mid) {
    if (_selected.has(row.dataset.mid)) _selected.delete(row.dataset.mid);
    else _selected.add(row.dataset.mid);
    syncSelUi();
  }
}

/** 编辑弹层（自包含：窥私无 overlay 状态机，与 hint-sheet 同族；data-ubp-spyedit 命名空间不吃宿主分派）。 */
function openSpyEditSheet(): void {
  if (!_ctx || !_chatId) return;
  const conv = findSpyConversation(_chatId);
  const st = spySelbarState(_selected, conv?.messages || []);
  if (!conv || !st.canEdit) return;
  _editMsgId = [..._selected][0] || null;
  const msg = conv.messages.find(m => m.id === _editMsgId);
  if (!msg || !isMessageEditable(msg)) return;
  _editDraft = msg.content;
  const doc = hostDocument();
  _ctx.container.querySelector('.ubp-spy-editsheet')?.remove();
  const openedAt = Date.now();
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-spy-editsheet';
  overlay.innerHTML = `
    <div class="ubp-sheet" data-ubp-spyeditstop="1">
      <div class="ubp-sheet-title">${S('编辑消息', '改写窥录')}</div>
      <textarea class="ubp-textarea" id="ubp-spy-edit-text">${escapeHtml(_editDraft)}</textarea>
      <div class="ubp-sheet-actions">
        <button class="ubp-btn" data-ubp-spyedit="cancel">${S('取消', '作罢')}</button>
        <button class="ubp-btn primary" data-ubp-spyedit="save" ${_editDraft.trim() ? '' : 'disabled'}>${S('保存', '存定')}</button>
      </div>
    </div>`;
  _ctx.container.appendChild(overlay);
  const textarea = overlay.querySelector('#ubp-spy-edit-text') as HTMLTextAreaElement | null;
  const saveBtn = overlay.querySelector('[data-ubp-spyedit="save"]') as HTMLButtonElement | null;
  const close = (): void => {
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
  };
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
  overlay.addEventListener('input', () => {
    _editDraft = textarea?.value || '';
    if (saveBtn) saveBtn.disabled = !_editDraft.trim();
  });
  overlay.addEventListener('click', event => {
    if (Date.now() - openedAt < 450) return; // 残留 click 兜底（同 hint-sheet 口径）
    const act = (event.target as HTMLElement).closest('[data-ubp-spyedit]')?.getAttribute('data-ubp-spyedit') || '';
    if (act === 'cancel') close();
    else if (act === 'save' && saveBtn && !saveBtn.disabled) {
      close();
      submitSpyMessageEdit();
    }
  });
  doc.addEventListener('keydown', onKeydown, true);
  textarea?.focus();
}

/** 保存单条编辑：就地改写 content，不动 ts（改写≠新消息，排序/相对时间不变）。
 *  世界书重投影由通知签名的内容指纹自动触发（改动 E 后无需显式失效化）。 */
function submitSpyMessageEdit(): void {
  const msgId = _editMsgId;
  const text = _editDraft.trim();
  if (!msgId || !text || !_chatId) {
    render();
    return;
  }
  mutatePhoneData(d => {
    const msg = d.spy?.conversations.find(c => c.id === _chatId)?.messages.find(m => m.id === msgId);
    if (msg && isMessageEditable(msg)) msg.content = text;
  });
  exitSpySelectMode();
  render();
  _ctx && showScreenToast(_ctx.container, S('已保存', '已存定'));
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 删除选中消息（action-sheet 确认后执行）。 */
function openSpyDeleteMessagesSheet(): void {
  if (!_ctx || !_selected.size) return;
  const n = _selected.size;
  openConfirmSheet(_ctx.container, {
    title: S(`删除 ${n} 条消息？`, `删去 ${n} 则窥录？`, `删去 ${n} 条书信？`, `删去 ${n} 条晶讯？`),
    message: S('删除后不可恢复。', '删去后不可复原。', '删去后不可复原。', '删去后不可复原。'),
    confirmLabel: S('删除', '删去'),
    onConfirm: deleteSelectedSpyMessages,
  });
}

function deleteSelectedSpyMessages(): void {
  if (!_selected.size || !_chatId) return;
  const ids = new Set(_selected);
  mutatePhoneData(d => {
    const conv = d.spy?.conversations.find(c => c.id === _chatId);
    if (conv) conv.messages = conv.messages.filter(m => !ids.has(m.id));
  });
  exitSpySelectMode();
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

// ─── 会话删除（列表行长按；私聊/群聊同路径） ───

function openDeleteConversationSheet(convId: string): void {
  if (!_ctx) return;
  const conv = findSpyConversation(convId);
  if (!conv) return;
  const isGroup = conv.kind === 'group';
  openConfirmSheet(_ctx.container, {
    title: isGroup
      ? S('删除这组窥私会话？', '删去这组窃录？', '删去这卷密报？', '抹去这段窥视？')
      : S('删除这条窥私会话？', '删去这条窃录？', '删去这封密报？', '抹去这条窥视？'),
    message: isGroup
      ? S(`「${conv.title}」的全部消息将被删除，且不可恢复。`, `「${conv.title}」所录讯息将尽数散去，不可复原。`, `「${conv.title}」所载密报将尽数焚去，不可复原。`, `「${conv.title}」所映窥视将尽数抹去，不可复原。`)
      : S(`「${conv.title}」的全部消息将被删除，且不可恢复。之后这两人再生成互动会新建一个空会话。`, `「${conv.title}」所录讯息将尽数散去，不可复原。此后二人再起符讯往来，当另起一卷。`, `「${conv.title}」所载密报将尽数焚去，不可复原。此后二人再通书信，当另起一封。`, `「${conv.title}」所映窥视将尽数抹去，不可复原。此后二人再通晶讯，当另起一段。`),
    confirmLabel: S('删除', '删去'),
    onConfirm: () => deleteSpyConversationById(convId),
  });
}

function deleteSpyConversationById(convId: string): void {
  let removed = false;
  mutatePhoneData(d => { removed = deleteSpyConversation(d, convId); });
  if (!removed) return;
  if (_chatId === convId) {
    _view = 'list';
    _chatId = null;
  }
  exitSpySelectMode();
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

// ─── 手动新建会话（不走 AI；docs/13）───

/** 新建弹层内部状态（自挂载弹层，命名空间 data-ubp-spynew，循编辑弹层先例自管分派）。 */
interface SpyNewConvState {
  /** null = 第一步两选。 */
  kind: 'private' | 'group' | null;
  /** 已选成员（保序；私聊封顶 2 人）。 */
  picked: string[];
  /** 群名草稿（空 = 前 3 人 + 群聊，与构造器默认一致）。 */
  title: string;
  /** 群主（被取消勾选而失效时回落第一位）。 */
  owner: string;
  query: string;
}

function openSpyNewConvSheet(): void {
  if (!_ctx) return;
  const roster = getRoster();
  const me = roster.protagonistName;
  // 候选 = 通讯录（含自定义角色）− 主角；刻意不排除在场角色——生成侧排除「在场」服务的是 AI 选人，
  // 手动建会话时玩家想选的恰可能是正在跟主角聊天的那位（魔改档案3 §5.2 同款判断）
  const candidates = mergeCustomContacts(roster, readPhoneDataSafe().customContacts || [])
    .filter(c => c.name && c.name !== me);
  const st: SpyNewConvState = { kind: null, picked: [], title: '', owner: '', query: '' };

  const doc = hostDocument();
  _ctx.container.querySelector('.ubp-spy-newsheet')?.remove();
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-spy-newsheet';
  _ctx.container.appendChild(overlay);
  const openedAt = Date.now();
  const close = (): void => {
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
  };
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
  doc.addEventListener('keydown', onKeydown, true);

  const enough = (): boolean => (st.kind === 'private' ? st.picked.length === 2 : st.picked.length >= 3);
  const ownerSafe = (): string => (st.picked.includes(st.owner) ? st.owner : (st.picked[0] || ''));
  const defaultTitle = (): string => st.picked.slice(0, 3).join('、') + '群聊';

  const rowHtml = (name: string, brief: string, present: boolean): string => {
    const on = st.picked.includes(name);
    return `<div class="ubp-pickrow${on ? ' on' : ''}" data-ubp-spynew="row" data-id="${escapeAttr(name)}">
      <span class="ubp-check${on ? ' on' : ''}">${on ? '✓' : ''}</span>
      ${avatarHtml(name, 'small', true)}
      <span class="ubp-inline-name">${escapeHtml(name)}${present ? `<i>（${S('在场', '在场')}）</i>` : ''}${brief ? `<i>${escapeHtml(brief)}</i>` : ''}</span>
    </div>`;
  };

  const renderList = (): void => {
    const listEl = overlay.querySelector('.ubp-spynew-list') as HTMLElement | null;
    if (!listEl) return;
    const q = st.query.trim().toLowerCase();
    const rows = candidates
      .filter(c => !q || c.name.toLowerCase().includes(q) || (c.brief || '').toLowerCase().includes(q))
      .map(c => rowHtml(c.name, c.brief || c.identity || '', Boolean(roster.present[c.name])));
    listEl.innerHTML = rows.length ? rows.join('')
      : `<div class="ubp-empty" style="padding:18px;">${candidates.length ? S('没有匹配的联系人', '没有匹配之人') : S('通讯录为空', '名录为空')}</div>`;
  };

  /** 就地同步：群主胶囊 + 标题计数 + 确认钮禁用态（不重建列表，保滚动位）。 */
  const renderOwners = (): void => {
    const pills = overlay.querySelector('.ubp-spynew-owners') as HTMLElement | null;
    if (pills) {
      const owner = ownerSafe();
      pills.innerHTML = st.picked.length
        ? `${S('群主', '盟主')}：` + st.picked.map(n =>
          `<button type="button" class="ubp-chip${n === owner ? ' on' : ''}" data-ubp-spynew="owner" data-id="${escapeAttr(n)}">${escapeHtml(n)}</button>`).join('')
        : S('群主：选人后指定（默认第一位）', '盟主：选人后指定（默认第一位）');
    }
    const countEl = overlay.querySelector('.ubp-spynew-count') as HTMLElement | null;
    if (countEl) {
      const need = st.kind === 'private' ? 2 : 3;
      countEl.textContent = st.kind === 'private'
        ? `${S('已选', '已择')} ${st.picked.length}/${need}`
        : `${S('已选', '已择')} ${st.picked.length}（${S('至少', '至少')} ${need}）`;
    }
    const confirmBtn = overlay.querySelector('[data-ubp-spynew="confirm"]') as HTMLButtonElement | null;
    if (confirmBtn) confirmBtn.disabled = !enough();
  };

  const renderSheet = (): void => {
    if (!st.kind) {
      overlay.innerHTML = `
        <div class="ubp-sheet" data-ubp-spynewstop="1">
          <div class="ubp-sheet-title">${S('新建会话', '另起符卷', '另立密报', '另启窥视')}</div>
          <div class="ubp-sheet-actions" style="flex-direction:column;align-items:stretch;">
            <button class="ubp-btn" data-ubp-spynew="mode" data-id="private">${S('新建私聊（恰好选 2 人）', '新开一对一（恰好选 2 人）', '新开一线密报（恰好选 2 人）', '新开一段窥视（恰好选 2 人）')}</button>
            <button class="ubp-btn" data-ubp-spynew="mode" data-id="group">${S('新建群聊（选 3 人以上）', '新开共谈（选 3 人以上）', '新开群报（选 3 人以上）', '新开圆桌（选 3 人以上）')}</button>
            <button class="ubp-btn" data-ubp-spynew="cancel">${S('取消', '作罢')}</button>
          </div>
        </div>`;
      return;
    }
    const isPrivate = st.kind === 'private';
    overlay.innerHTML = `
      <div class="ubp-sheet" data-ubp-spynewstop="1">
        <div class="ubp-sheet-title">${isPrivate ? S('新建私聊', '新开一对一') : S('新建群聊', '新开共谈', '新开群报', '新开圆桌')}<span class="ubp-appbar-sub ubp-spynew-count" style="margin-left:8px;"></span></div>
        ${isPrivate ? '' : `
        <input class="ubp-fieldinput ubp-spynew-title" placeholder="${S('群名（留空自动）', '盟号（留空自动）')}" value="${escapeAttr(st.title)}" maxlength="40" style="margin-bottom:6px;">
        <div class="ubp-spynew-owners ubp-inline-row"></div>
        <div class="ubp-inline-note">${S('之后生成会优先把他们的群聊写进这个群', '之后推演会优先把他们的共谈写进此盟')}</div>`}
        <input class="ubp-fieldinput ubp-spynew-search" type="text" placeholder="${S('搜索', '搜索')}" autocomplete="off" style="margin-bottom:8px;">
        <div class="ubp-spynew-list" style="max-height:230px;overflow-y:auto;"></div>
        <div class="ubp-sheet-actions">
          <button class="ubp-btn" data-ubp-spynew="back">${S('返回', '返回')}</button>
          <button class="ubp-btn primary" data-ubp-spynew="confirm" ${enough() ? '' : 'disabled'}>${S('创建', '立卷')}（${st.picked.length}）</button>
        </div>
      </div>`;
    const searchEl = overlay.querySelector('.ubp-spynew-search') as HTMLInputElement | null;
    searchEl?.addEventListener('input', () => {
      st.query = searchEl.value;
      renderList();
    });
    const titleEl = overlay.querySelector('.ubp-spynew-title') as HTMLInputElement | null;
    titleEl?.addEventListener('input', () => { st.title = titleEl.value; });
    renderList();
    renderOwners();
  };

  overlay.addEventListener('click', (event: Event) => {
    if (Date.now() - openedAt < 450) return; // 残留 click 兜底（同编辑弹层口径）
    const target = event.target as HTMLElement;
    if (target === overlay) { close(); return; }
    const el = target.closest('[data-ubp-spynew]') as HTMLElement | null;
    if (!el) return;
    const act = el.dataset.ubpSpynew || '';
    if (act === 'cancel') { close(); return; }
    if (act === 'back') {
      st.kind = null; st.picked = []; st.title = ''; st.owner = ''; st.query = '';
      renderSheet();
      return;
    }
    if (act === 'mode') {
      st.kind = el.dataset.id === 'group' ? 'group' : 'private';
      renderSheet();
      return;
    }
    if (act === 'owner') {
      const id = el.dataset.id || '';
      if (st.picked.includes(id)) { st.owner = id; renderOwners(); }
      return;
    }
    if (act === 'row') {
      const id = el.dataset.id || '';
      if (st.picked.includes(id)) st.picked = st.picked.filter(n => n !== id);
      else {
        if (st.kind === 'private' && st.picked.length >= 2) return; // 私聊封顶 2：超选忽略（计数行可见）
        st.picked.push(id);
      }
      const on = st.picked.includes(id);
      el.classList.toggle('on', on);
      const check = el.querySelector('.ubp-check');
      if (check) {
        check.classList.toggle('on', on);
        check.textContent = on ? '✓' : '';
      }
      const confirmBtn = overlay.querySelector('[data-ubp-spynew="confirm"]') as HTMLButtonElement | null;
      if (confirmBtn) confirmBtn.textContent = `${S('创建', '立卷')}（${st.picked.length}）`;
      renderOwners();
      return;
    }
    if (act === 'confirm' && enough()) {
      const kind = st.kind;
      const members = [...st.picked];
      if (kind === 'private') {
        close();
        createSpyConversationAndEnter('private', members, '', '');
      } else {
        const title = st.title.trim().slice(0, 40) || defaultTitle();
        const owner = ownerSafe();
        close();
        createSpyConversationAndEnter('group', members, title, owner);
      }
    }
  });

  renderSheet();
}

/**
 * 落库并进入会话。必须调官方构造器（魔改档案3 §5.3 的关键语义）：私聊 get-or-create
 * （id=字典序两人 ⇒ 手动建的与 AI 建的永远是同一场）；群聊按标题查重——同名即复用并进入
 * （生成侧建群同样按标题查重，手动建的群 AI 之后会接着写）。
 */
function createSpyConversationAndEnter(kind: 'private' | 'group', members: string[], title: string, owner: string): void {
  if (!_ctx) return;
  const before = readPhoneDataSafe();
  const existed = kind === 'private'
    ? (spyOf(before)?.conversations.find(c => c.id === spyPrivateId(members[0] || '', members[1] || '')) || null)
    : findSpyGroupByTitle(before, title);
  let convId = '';
  mutatePhoneData(d => {
    const conv = kind === 'private'
      ? ensureSpyPrivateConversation(d, members[0] || '', members[1] || '')
      : (existed || createSpyGroupConversation(d, title, owner, members));
    convId = conv ? conv.id : '';
  });
  if (!convId) return;
  // L9 成就：真·新建窥私会话才计（复用已有会话不算）
  if (!existed) emitAch('phone_spy_conv_created', { kind });
  // 进入会话（复用 open-conv 三步语义；清未读恒 0 无需单独 mutate）
  _chatId = convId;
  _view = 'chat';
  exitSpySelectMode();
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  _ctx && showScreenToast(_ctx.container, existed
    ? (kind === 'private'
      ? S('这两位已有会话，已进入', '二人已有往来，已入此卷')
      : S(`同名群「${title}」已存在，已进入`, `同名盟「${title}」已存在，已入此盟`))
    : S('已创建会话', '已立此卷'));
}

// ─── 窥私群头像（docs/13；入口=会话顶栏「⋯」，与微信同位：进聊天右上角更换） ───

function openSpyConvAvatarPicker(): void {
  if (!_ctx || !_chatId) return;
  const conv = findSpyConversation(_chatId);
  if (!conv || conv.kind !== 'group') return;
  const apply = (path: string | null): void => {
    mutatePhoneData(d => { setGroupAvatar(d, conv.id, path); });
    render();
    emitPhoneEvent('ubp-phone:data-changed');
  };
  openImagePickerSheet(_ctx.container, {
    mode: 'setting',
    title: `${S('更换群头像', '更换盟头像', '更换会徽', '更换圆桌纹章')} · ${conv.title}`,
    crop: { ratio: 1, slot: `cv:${conv.id}`, kind: 'img', title: '群头像' },
    current: conv.avatar || '',
    currentText: S('当前群头像', '当前盟头像', '当前会徽', '当前纹章'),
    defaultText: S('默认用群名色块', '默认用盟名色块', '默认用会名色块', '默认用圆桌色块'),
    pickTip: S('设为群头像', '设为盟头像', '设为会徽', '设为纹章'),
    onPick: img => apply(img.path),
    onImport: apply,
    onCropAdjusted: () => render(),
    ...(conv.avatar ? { onReset: () => apply(null) } : {}),
  });
}

// ─── 通话记录删除（通话列表行长按；只删这条转写，不动会话） ───

function openDeleteCallSheet(recordId: string): void {
  if (!_ctx) return;
  const record = findSpyCall(recordId);
  if (!record) return;
  const parties = `${record.caller || S('我', '我')} ⇄ ${record.peerName}`;
  openConfirmSheet(_ctx.container, {
    title: S('删除这条通话记录？', '删去这段传音记录？', '删去这通传声记录？', '抹去这段远语记录？'),
    message: S(`「${parties}」这段通话的转写将被删除，不可恢复。`, `「${parties}」这段传音的记录将尽数散去，不可复原。`, `「${parties}」这通传声的记录将尽数散去，不可复原。`, `「${parties}」这段远语的记录将尽数抹去，不可复原。`),
    confirmLabel: S('删除', '删去', '删去', '抹去'),
    onConfirm: () => deleteSpyCallById(recordId),
  });
}

function deleteSpyCallById(recordId: string): void {
  let removed = false;
  mutatePhoneData(d => { removed = deleteSpyCall(d, recordId); });
  if (!removed) return;
  if (_callId === recordId) {
    _view = 'list';
    _callId = null;
  }
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

// ─── 事件路由 ───

function handleClick(event: Event): void {
  const target = event.target as HTMLElement;
  // 长按刚触发后的残留 click 吞掉（防多选首条被立即翻转/弹层刚开即被关）
  if (Date.now() - _longPressFiredAt < 600) return;
  // 多选模式必须先于 closest('[data-ubp-act]') 早退：消息行内本无 act 属性，顺序反了会被早退挡掉
  if (_selectMode && _view === 'chat') {
    handleSpySelectClick(target);
    return;
  }
  const el = target.closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  switch (act) {
    case 'tab': {
      const next = el.dataset.id === 'calls' ? 'calls' : 'chats';
      if (next !== _tab) {
        _tab = next;
        if (_tab === 'calls') markCallsSeen();
        render();
      }
      break;
    }
    case 'generate': void doGenerate(); break;
    case 'new-conv': openSpyNewConvSheet(); break;
    case 'conv-avatar': openSpyConvAvatarPicker(); break;
    case 'abort': {
      _abortRequested = true;
      abortSpyGeneration();
      break;
    }
    case 'open-conv': {
      const id = el.dataset.id || '';
      if (!findSpyConversation(id)) break;
      enterSpyConversation(id);
      render();
      // 清未读不走 openApp 统一补刷路径（那只兜打开即已读类 App），此处须自派发让悬浮球即时熄灭
      emitPhoneEvent('ubp-phone:data-changed');
      break;
    }
    case 'open-call': {
      _callId = el.dataset.id || '';
      _view = 'call';
      render();
      break;
    }
    case 'back': {
      _view = 'list';
      _chatId = null;
      _callId = null;
      exitSpySelectMode();
      render();
      break;
    }
    case 'lightbox': {
      openPhoneLightbox(_ctx?.container, { paths: [el.dataset.id || ''] });
      break;
    }
    case 'gen-image': {
      if (_chatId) retrySpyImage(el.dataset.id || '');
      break;
    }
    case 'voice-play': {
      const id = el.dataset.id || '';
      const conv = _chatId ? findSpyConversation(_chatId) : null;
      const msg = conv?.messages.find(m => m.id === id);
      if (!msg || msg.type !== 'voice') break;
      if (_playingVoiceId === id) {
        stopVoicePlayback();
        break;
      }
      stopVoicePlayback(false);
      const plan = voicePlanFor(msg.content, msg.from);
      // 总开关关闭 ⇒ 计划恒 null、按钮已置灰；不再回落假动画（与微信同口径）
      if (!plan) break;
      // 真实播放：窥私走「隔墙失真」（仅 api/comfy 有真实音频；系统 TTS 自然降级）
      _playingVoiceId = id;
      render();
      const muffle = getPhoneSettings().voiceSpyMuffle && plan.backend !== 'system';
      let achEmitted = false; // L9：真正开播才计一次（loading/失败不计）
      playVoice({
        backend: plan.backend, cacheKey: plan.cacheKey, text: plan.text,
        voiceId: plan.voiceId, providerId: plan.providerId, refAudio: plan.refAudio, speed: plan.speed, emotion: plan.emotion, delivery: plan.delivery, muffle, role: plan.role,
        onState: (st) => {
          if (st === 'playing' && !achEmitted) { achEmitted = true; emitAch('phone_voice_played', { from: 'spy' }); }
          if ((st === 'ended' || st === 'error') && _playingVoiceId === id) { _playingVoiceId = ''; render(); }
        },
      });
      break;
    }
    case 'dismiss-error': {
      clearSpyError();
      render();
      break;
    }
    case 'retry-gen': {
      void doGenerate(_lastHint || undefined, _lastFocus.length ? [..._lastFocus] : undefined, _lastStrict || undefined, _lastConvId || undefined);
      break;
    }
    default: break;
  }
}

function stopVoicePlayback(rerender = true): void {
  if (_voiceTimer) {
    clearTimeout(_voiceTimer);
    _voiceTimer = null;
  }
  try { stopVoice(); } catch (_e) { /* ignore */ }
  if (_playingVoiceId) {
    _playingVoiceId = '';
    if (rerender) render();
  }
}

/** 打开通话 tab：全部记录置 seen（角标归零口径对齐电话 App）。 */
function markCallsSeen(): void {
  mutatePhoneData(d => {
    if (!d.spy) return;
    for (const c of d.spy.calls) c.seen = true;
  });
}

// ─── App 定义 ───

export const spyApp: PhoneApp = {
  id: 'spy',
  name: S('窥私', '窃语符', '江湖密报', '预言之眼'),
  icon: ubpIcon('eye'),
  color: '#7A5C9E',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    const token = ++_mountToken;
    _view = 'list';
    _tab = 'chats';
    _chatId = null;
    _callId = null;
    _renderedChatId = null;
    _viewScroll.clear(); // 滚动记忆重置：重开 App 从顶开始，不继承上一次打开时的位置
    _busy = false;
    _abortRequested = false;
    exitSpySelectMode();
    _editDraft = '';
    _lastStrict = false;
    _lastConvId = '';
    // 通知中心「点未读会话」深链：openApp 恒为卸载再挂载 ⇒ 目标在首帧消费
    const deepLink = takePendingAppTarget('spy');
    // 第六轮 ②：窥私会话与通话共用一个深链槽，故通话用 call: 前缀区分——
    // 认出来就切到「通话」tab 并落到那条转写详情（目标不存在时按既有回落停在列表）。
    if (deepLink && deepLink.startsWith('call:')) {
      const callId = deepLink.slice(5);
      if (findSpyCall(callId)) { _tab = 'calls'; _view = 'call'; _callId = callId; }
    } else if (deepLink && findSpyConversation(deepLink)) enterSpyConversation(deepLink);
    ctx.container.addEventListener('click', handleClick);
    // 长按分派（一处扩展，四处受益）：生成按钮=本次生成弹层；会话行=会话删除确认；通话行=通话记录删除确认；消息行=进入多选。
    // fire 里自记 _longPressFiredAt——handleClick 顶部吞掉长按残留 click（对齐微信做法，不改 hint-sheet.ts）。
    const markFired = (fn: () => void) => () => {
      _longPressFiredAt = Date.now();
      fn();
    };
    const unbindHintLongPress = bindHintLongPress(ctx.container, target => {
      // 已有自挂载弹层开着（提示/动作/编辑/新建会话）不再触发新长按
      if (ctx.container.querySelector('.ubp-hintsheet, .ubp-actionsheet, .ubp-spy-editsheet, .ubp-spy-newsheet')) return null;
      const genBtn = target.closest('[data-ubp-act="generate"]') as HTMLElement | null;
      if (genBtn) return { el: genBtn, fire: markFired(openGenerateHint) };
      if (_view === 'list' && _tab === 'chats') {
        const row = target.closest('.ubp-wx-row[data-ubp-act="open-conv"]') as HTMLElement | null;
        if (row?.dataset.id) return { el: row, fire: markFired(() => openDeleteConversationSheet(row.dataset.id || '')) };
      }
      if (_view === 'list' && _tab === 'calls') {
        const row = target.closest('.ubp-wx-row[data-ubp-act="open-call"]') as HTMLElement | null;
        if (row?.dataset.id) return { el: row, fire: markFired(() => openDeleteCallSheet(row.dataset.id || '')) };
      }
      if (_view === 'chat' && !_selectMode) {
        const msgRow = target.closest('.ubp-msg-row[data-mid]') as HTMLElement | null;
        if (msgRow?.dataset.mid) return { el: msgRow, fire: markFired(() => enterSpySelectMode(msgRow.dataset.mid || '')) };
      }
      return null;
    });
    const offDataChanged = onPhoneEvent('ubp-phone:data-changed', () => {
      // 后台生成/其它 App 落库 → 列表与详情自动刷新（生成中标志由引擎管理）
      if (_ctx === ctx && token === _mountToken && !_busy) render();
    });
    render();
    // 惰性刷新立绘快照（头像/图库取最新），完成后补一次渲染
    void refreshPhoneAvatars().then(() => {
      if (_ctx === ctx && token === _mountToken) render();
    });
    return () => {
      _mountToken++;
      ctx.container.removeEventListener('click', handleClick);
      unbindHintLongPress();
      offDataChanged();
      if (_voiceTimer) {
        clearTimeout(_voiceTimer);
        _voiceTimer = null;
      }
      _playingVoiceId = '';
      exitSpySelectMode();
      void persistPhoneData();
      _ctx = null;
      _busy = false;
    };
  },
};