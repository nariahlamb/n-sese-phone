// ===== 微信 App（P0 核心交付，规格 docs/02） =====
// 视图：sessions（会话列表）/ contacts（通讯录）/ chat（聊天详情，私聊+群聊共用）。
// 上屏≠触发：我方消息（文字/➕面板富媒体/相册转发）先攒批，点「触发」按钮才生成
// （批次=尾部连续我方消息，引擎内部推导）；例外=好友申请会话（发送即触发 AI 裁决）。
// 好友系统：通讯录分 好友/非好友 两栏；非好友私聊=好友申请分支（通过/拒绝 AI 裁决，
// 拉黑后回退申请分支重新来过）。通讯录右上角「＋」可添加自定义联系人（数据库外角色，
// 走同一申请流程；数据库收录同名后自动让位为正常角色，资料卡可删除）。群管理（改名/加减成员）
// 落微信式系统消息进聊天流。
// 长按消息=多选（批量删除/合并转发 chatlog）；长按会话=上下文动作面板（置顶/标未读/删除）。
// 群聊输入 @ 弹成员选择、@计入绿灯注入名额；图片消息自动生图（可关）；事件委托渲染。

import { debounceTrailing, revealDelay, sleep, voiceBarMinWidth } from '../core/ubp-utils';
import {
  isCurrencyLinkActive, payCommon, payCurrencyList, payBalance, payAdjust, payResolveCurrency,
  moneyAmountText, currencyIconSvg, fmtQty, withPaySnapshot,
  type CurrencyMeta,
} from '../core/currency-link';
import {
  addCustomContact,
  addFriend,
  addAtmospherePlaceholders,
  appendMessage,
  buildChatlogMessage,
  buildForwardedImageMessage,
  composeShotDesc,
  conversationListPreview,
  conversationMatches,
  createGroupConversation,
  ensurePrivateConversation,
  findConversation,
  groupPeopleCount,
  groupSpeakerNames,
  isCustomContact,
  isFriend,
  isMessageEditable,
  logEntryBody,
  makeMessageId,
  normalizePhoneMessage,
  pendingAtmosphere,
  privateConversationId,
  readyAtmosphereMembers,
  readyAtmosphereNames,
  removeAtmosphereMember,
  removeCustomContact,
  removeFriend,
  setGroupAvatar,
  sortedConversations,
  storyTimeShort,
  trailingUserBatch,
  voiceDurationSeconds,
  messagePreviewText,
  searchPhoneMessages,
  MAX_ATMOSPHERE_PER_GROUP,
  MAX_ATMOSPHERE_REQUIREMENT_LEN,
  MAX_DRAFT_LENGTH,
  MAX_CHARACTER_NOTE_LEN,
  pendingAtmosphereBatches,
  type PhoneMessageHit,
  type PhoneChatData,
  type Conversation,
  type PhoneGenRecord,
  type PhoneLogEntry,
  type PhoneMessage,
} from '../core/chat-model';
import { abortPhoneGeneration, generateConversationReply, PhoneChatError, readAiChatHistory } from '../core/chat-engine';
import { generatePhoneImage, getImageError, MAX_AUTO_IMAGES_PER_BATCH } from '../core/chat-images';
import { buildPhoneChatContext, collectChatSubjects } from '../core/chat-image-prompts';
import { readPhoneMapLocations, type PhoneMapLocation } from '../core/map-locations';
import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { buildMemoDraft, deletePhoneMemoByTitle, insertPhoneMemo, memoTitleFromBubbleText } from '../core/phone-memo';
import { invalidatePhoneScheduleCache } from '../core/phone-schedule';
import { addPhoneAlbumEntries, makeAlbumEntryId, syncAlbumEntryForMessageImage } from '../core/phone-album';
import { composeImageDesc } from '../core/forward-model';
import { clearChatBg, readChatBg, setChatBg } from '../core/phone-backgrounds';
import type { ImageGenRecord } from '../../unified-statusbar/core/image-gen';
import { refreshPhoneAvatars, PROTAGONIST_AVATAR_KEY } from '../core/phone-avatars';
import { playVoice, stopVoice, type VoiceHandle, type VoicePlayState } from '../core/voice-tts';
import { resolveVoiceBackend, voicePoolFor, listProviderVoicesPage } from '../core/voice-tts';
import {
  voicePlanFor, resolveSenderVoicePlan, contactSourceFor, warmRecentVoices, prewarmNeighbors, type VoiceWarmSlot,
} from '../core/chat-voice';
import { autoVoiceOf, bucketGenderOf, roleProviderFor } from '../core/voice-mapping';
import { resolveProvider, hasVoiceFetcher, parseManualVoices, serializeVoicePool, VOICE_PROVIDERS, VOICE_CATALOG_MAX } from '../core/voice-providers';
import type { VoiceOption } from '../core/voice-mapping';
import {
  canFavoriteMessage, favoriteFromMessage, favoriteJumpTarget, favoriteSummary, filterWechatFavs,
  trimWechatFavs, type WeChatFavorite, type WeChatFavoriteType,
} from '../core/wechat-favorites';
import { voiceMetaHtml } from './voice-meta';
import { voiceCacheGet } from '../core/voice-cache';
import { voiceFavoritePut, voiceFavoriteHas, voiceFavoriteDelete } from '../core/voice-favorites';
import { downloadVoice } from '../core/voice-export';
import { savePhoneSettings } from '../core/phone-settings';
import { getPhoneSettings, isVoiceEnabled } from '../core/phone-settings';
import { feedback } from '../core/device-feedback';
import { achFlag, emitAch } from '../core/phone-achievements';
import {
  currentPhoneStorageId,
  mutatePhoneData,
  persistPhoneData,
  phoneStoreStatus,
  readPhoneData,
  readPhoneDataRef,
  readPhoneDataSafe,
} from '../core/phone-store';
import { bindRosterInvalidation, findContact, getRoster, mergeCustomContacts } from '../core/roster';
import { S, currentStyle, displayAmount } from '../core/skins';
import { formatStampChat, normalizeStoryTimeLabel } from '../core/social-time';
import { hostDocument, phoneNotify } from '../core/host-env';
import { parseAmountNote, type ParseChatResult, type ParsedChatAction, type ParsedChatMemo } from '../core/chat-parser';
import { emitPhoneEvent, emitPhoneNotify, onPhoneEvent, setPendingAppPage, takePendingAppTargetFull, type PhoneApp, type PhoneAppContext } from './app-registry';
import { avatarActHtml, avatarHtml, createViewScrollMemo, escapeAttr, escapeHtml, groupAvatarHtml, isPhoneOpen, openActionSheetCore, renderTextWithMentions, showScreenToast } from './phone-ui';
import { openConfirmSheet } from './action-sheet';
import { cropMediaStyle } from '../core/phone-crops';
import { openAvatarPickerSheet, openImagePickerSheet, type PickedImage } from './image-picker-sheet';
import { openShotCharPicker, openShotLocationPicker, shotFormHtml, shotSubjects } from './camera-shot';
import { openPickerSheet, type PickerGroup } from './picker-sheet';
import { tintInk } from '../core/browser-model';
import { appendForwardedMessage, openForwardTargetSheet } from './forward-sheet';
import { openOneShotHintSheet } from './hint-sheet';
import { ubpIcon, type PhoneIconName } from './icons';
import { openPhoneLightbox } from './image-lightbox';

type View = 'sessions' | 'contacts' | 'chat' | 'favs';

interface OverlayState {
  kind: 'group-create' | 'profile' | 'menu' | 'img-send' | 'confirm-clear'
    | 'atmo-add' | 'atmo-profile'
    | 'voice-send' | 'transfer-send' | 'redpacket-send'
    | 'chatlog-view' | 'delete-conv'
    | 'add-contact' | 'delete-contact'
    | 'msg-edit' | 'add-friend' | 'memo-delete';
  name?: string;
  path?: string;
  /** chatlog-view/msg-edit/memo-delete=消息 id；delete-conv=会话 id；delete-contact=自定义联系人名；
   *  atmo-profile=气氛组条目 id；memo-delete 的 name=备忘标题。 */
  id?: string;
}

let _ctx: PhoneAppContext | null = null;
let _view: View = 'sessions';
let _tab: 'sessions' | 'contacts' = 'sessions';
let _chatId: string | null = null;
const _drafts = new Map<string, string>();   // 输入框草稿热路径缓存（落盘见 scheduleDraftPersist）

/** 草稿当前值：内存缓存优先，否则用落盘值（刷新/重挂载后草稿仍在）。 */
function currentDraft(conv: { id: string; draft?: string }): string {
  return _drafts.has(conv.id) ? (_drafts.get(conv.id) as string) : (conv.draft || '');
}

// 草稿落盘：600ms 去抖合并到一次 mutatePhoneData（打字热路径只碰内存）。
// 单槽会丢并发会话的写入（A 打完切 B 再打字），故用 pending Map 按会话暂存，一次刷盘全写完。
const _draftPending = new Map<string, string>();
let _draftTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDraftPersist(convId: string, text: string): void {
  _draftPending.set(convId, text);
  if (_draftTimer) clearTimeout(_draftTimer);
  _draftTimer = setTimeout(flushDraftPersist, 600);
}

/** 立即落盘（卸载/切会话/离开聊天时调；无待写项时是 no-op）。 */
function flushDraftPersist(): void {
  if (_draftTimer) {
    clearTimeout(_draftTimer);
    _draftTimer = null;
  }
  if (!_draftPending.size) return;
  const items = Array.from(_draftPending.entries());
  _draftPending.clear();
  mutatePhoneData(d => {
    let changed = false;
    for (const [id, raw] of items) {
      const conv = d.conversations.find(c => c.id === id);
      if (!conv) continue;
      const next = raw.trim() ? raw.slice(0, MAX_DRAFT_LENGTH) : '';
      if (next ? conv.draft === next : !conv.draft) continue; // 值没变 → 不动，免惊动写路径与投影通知
      if (next) conv.draft = next;
      else delete conv.draft;
      changed = true;
    }
    return changed;
  });
}

/** 输入框草稿写入（内存即时 + 落盘去抖）。 */
function setDraft(convId: string, text: string): void {
  _drafts.set(convId, text);
  scheduleDraftPersist(convId, text);
}

/** 草稿作废（发送成功 / 删除会话 / 清空记录）。 */
function clearDraft(convId: string): void {
  _drafts.set(convId, '');
  scheduleDraftPersist(convId, '');
  // F40(十一轮)：壳常驻后 textarea 不再随整帧重建回填——显式清空当前会话的输入框
  if (_ctx && _chatId === convId) {
    const ta = _ctx.container.querySelector('#ubp-chat-input') as HTMLTextAreaElement | null;
    if (ta) ta.value = '';
  }
}
const _generatingConvs = new Set<string>();  // AI 生成中的会话（按会话独立，可并行聊天）
let _overlay: OverlayState | null = null;
let _groupSel = new Set<string>();
let _groupTitle = '';
let _searchQuery = '';       // 会话列表搜索词（只作用于会话页；进聊天/切页签即清空）
// 聊天内搜索（真机微信：会话 ⋯ → 查找聊天记录）：独立页，命中结果点击=跳回该条消息。
// 与 _searchQuery 分开存：两者作用域不同（一个是会话列表、一个是本会话消息流），互不干扰。
let _contactQuery = '';    // 通讯录搜索词（同电话 App 口径；切页签即清空）
let _contactFriendSet = new Set<string>(); // 通讯录好友名单快照（逐键就地过滤时复用，免重复读库）
let _chatSearchOpen = false;
let _chatSearchQuery = '';
// 搜索结果页往返保位：进搜索页时记下消息流位置与条数（搜索页没有消息列表，取不到），
// 从搜索页回来那一帧用它们走原本的「同会话且条数没变→原位」口径（否则会被当成首次打开贴底）。
let _preSearchTop = 0;
let _preSearchCount = -1;
let _searchReturn = false;
let _scrollToMid: string | null = null; // 一次性跳转目标（渲染完即清；不做高亮，真机同款）
let _favFilter: '' | WeChatFavoriteType = ''; // 收藏页筛选（''=全部）
let _favPlayingId = '';                        // 收藏页正在播的条目 id（语音行内播放）
let _favHandle: VoiceHandle | null = null;     // 收藏页播放句柄（复用唯一播放器）
/** 会话页搜索「聊天记录」段的结果上限（真机微信给有限条；防超长会话把结果页撑爆）。 */
const SEARCH_HIT_LIMIT = 30;
let _imgSendDesc = '';
// 拍照弹层（相机同款控件 camera-shot）：所选角色/地点/正文开关与地点回显缓存
let _imgSendSelected: string[] = [];
let _imgSendLocId = '';
let _imgSendUseCtx = false;
let _imgSendLocs: PhoneMapLocation[] = [];
let _imgSendLocLoaded = false;
let _plusOpen = false;      // ➕面板开合
let _voiceText = '';        // 语音弹层草稿（转写文字）
let _moneyAmount = '';      // 转账/红包弹层：金额
let _moneyNote = '';        // 转账/红包弹层：留言/祝福语
let _moneyCurrency = '';    // 转账/红包弹层：所选支付币种名（空 = 常用货币）
// 当前会话轻量快照（renderChat 时刷新；@ 检测等输入热路径用，避免逐键深拷贝读存储）
let _chatIsGroup = false;
let _chatMembers: string[] = [];
/** 当前会话已生成气氛组名字/副行资料（@ 面板与头像资料卡分流用）。 */
let _chatAtmoNames: string[] = [];
let _chatAtmoMeta: Record<string, string> = {};
/** 批量添加气氛组弹层的当前数量与额外要求草稿。 */
let _atmoAddCount = 10;
let _atmoAddRequirement = '';
// 当前私聊会话好友态快照（renderChat 刷新；false=好友申请会话：发送即触发、藏➕/触发钮）
let _chatIsFriend = true;
// 长按多选（批量删除/合并转发）
let _selectMode = false;
let _selected = new Set<string>();
// 长按消息菜单（WeChat 式气泡菜单）：目标消息 id + 相对 .ubp-chat 的定位百分比 + 是否落在消息下方
let _msgMenu: { id: string; topPct: number; below: boolean } | null = null;
// 上一次渲染的会话 id（滚动保位用：同会话重绘=保位，切会话=滚到底）
let _renderedChatId: string | null = null;
// 长按计时（pointerdown 起 480ms；移动>10px/抬起取消；桌面 contextmenu 立即触发）
let _longPressTimer: ReturnType<typeof setTimeout> | null = null;
let _pressStart: { x: number; y: number } | null = null;
let _longPressFiredAt = 0; // 长按触发时间戳：吞掉随后的 click（防选中态被立即翻转）
let _renameDraft = '';     // 群管理：群名编辑草稿
let _addName = '';         // 添加好友弹层：角色姓名草稿
let _addReason = '';       // 添加好友弹层：申请内容草稿
let _editMsgId: string | null = null; // 编辑消息弹层：目标消息 id（多选恰好单选且可编辑才可开）
let _editDraft = '';       // 编辑消息弹层：内容草稿
// 引用回复：待发送的引用目标（消息快照；发送时消费掉，只作用于紧随其后的一条消息；切会话/返回即失效）
let _pendingQuote: { convId: string; entry: PhoneLogEntry } | null = null;
// 资料卡备注：正在编辑备注的角色名（null＝都处在常态显示）。只在「资料卡」这一层有意义——
// 开卡/关卡拉链都会清空（否则关掉再打开会停在编辑态）。
let _noteEditing: string | null = null;
// 资料卡是从「群管理」进来的吗：是则关闭后回群管理（与效果稿的层叠行为一致——看完成员资料接着管群）。
let _profileBack: 'menu' | null = null;
// 音色面板「▷ 试听」正在播的那枚钮（同一时刻只挂一枚 busy；播完/换钮即摘）
let _voicePreviewBtn: HTMLElement | null = null;
const _imageJobs = new Set<string>();
// 逐条送达状态（模块级：App 重挂载后仍延续；按会话独立——并行聊天互不可见；
// _revealAbortConvs 命中=该会话终止，丢弃未送达消息）
const _revealingConvs = new Set<string>();
const _revealAbortConvs = new Set<string>();
let _mountToken = 0;

/** 当前会话（同一渲染帧内已有 data 时传入复用，免二次全量深拷贝；pumpImages 先例）。 */
function currentConversation(data: ReturnType<typeof readPhoneData> = readPhoneDataRef()): Conversation | null {
  if (!_chatId) return null;
  return findConversation(data, _chatId);
}

/** 灵动岛「正在输入」实时活动（第五轮 ①）：模块级广播，壳层只维护一份 convId→标题 表。
 *  只报「变了」——add/delete 各调一次；标题从当前数据读（切走后那条 delete 仍会报 inactive）。 */
function emitGenActivity(convId: string, active: boolean): void {
  const title = findConversation(readPhoneDataRef(), convId)?.title || '';
  emitPhoneEvent('ubp-phone:gen-activity', { convId, title, active });
}

/** 该会话是否有生成/送达在进行（typing 指示与触发锁按会话隔离，可并行）。 */
function isConvBusy(convId: string | null): boolean {
  return !!convId && (_generatingConvs.has(convId) || _revealingConvs.has(convId));
}

/** 后台会话进度渲染：影响的不是当前正看的会话、且焦点在输入框时不整体重渲染
 *  （textarea 重建会打断光标，同 notifyExternalMessage 纪律），其余照常 render。 */
function renderConvTick(convId: string): void {
  if ((_view !== 'chat' || _chatId !== convId)
    && (_ctx?.shadow.activeElement as HTMLElement | null)?.id === 'ubp-chat-input') return;
  render();
}

let _dirtyWhenHidden = false; // U22(十一轮)：收起期间被闸掉的渲染请求（展开时一次性补渲）

function render(): void {
  if (!_ctx) return;
  // U22(十一轮)：手机收起（display:none 未卸载）时闸住隐藏渲染——逐条送达/后台消息在
  // 隐藏容器里的全量字符串构建+DOM 重建纯烧 CPU；置脏后在壳层 shell-opened 事件补渲一次，
  // 展开所见与常开完全一致。
  if (!isPhoneOpen()) { _dirtyWhenHidden = true; return; }
  // O34：一次渲染只读一遍货币账本（内部逐条气泡/逐个 chip 复用同一份快照）
  withPaySnapshot(dispatchRender);
}

function dispatchRender(): void {
  if (_view === 'chat') renderChat();
  else if (_view === 'favs') renderFavs();
  else if (_tab === 'contacts') renderContacts();
  else renderSessions();
}

// 跨视图滚动记忆：会话/通讯录列表 → 聊天 → 返回不回顶（聊天跟底自管，不入记忆的落位一侧）
const _viewScroll = createViewScrollMemo();

/** 当前视图的滚动体（会话/通讯录=嵌套内层 .ubp-appbody；聊天用 #ubp-chat-msgs，自管贴底）。 */
function wxScrollBody(container: HTMLElement): HTMLElement | null {
  const all = container.querySelectorAll('.ubp-appbody');
  return (all[all.length - 1] as HTMLElement | undefined) || null;
}

// ─── 会话列表 ───

/** 会话行 markup（首帧与搜索就地过滤共用一份，避免两处漂移）。
 *  时间=真机微信口径的相对时间（今天 HH:mm / 昨天 / 星期X / 更早 M-D），不可解析回退原文；
 *  群聊预览带发送者署名；置顶行加 .pinned；未读=计数角标、手动未读=红点。 */
function sessionRowHtml(conv: Conversation, meLabel: string, now: string): string {
  const last = conv.messages[conv.messages.length - 1];
  const rawTime = last?.storyTime || '';
  const stamp = rawTime ? normalizeStoryTimeLabel(rawTime, now) : '';
  const time = (stamp && formatStampChat(stamp, now)) || storyTimeShort(rawTime);
  const isGroup = conv.kind === 'group';
  // 草稿优先于末条消息预览（真机微信：未发出的输入在列表里以红字 [草稿] 开头）
  const draft = currentDraft(conv).replace(/\s+/g, ' ').trim();
  const preview = draft
    ? `<span class="ubp-wx-draft">${S('[草稿]', '[草稿]')}</span> ${escapeHtml(draft.slice(0, 40))}`
    : escapeHtml(conversationListPreview(conv, meLabel));
  const avatar = isGroup
    ? groupAvatarHtml(conv, S('群', '盟'))
    : avatarHtml(conv.members[0] || conv.title);
  const badge = conv.unread > 0
    ? `<span class="ubp-wx-badge">${conv.unread > 99 ? '99+' : conv.unread}</span>`
    : conv.manualUnread ? '<span class="ubp-wx-dot"></span>' : '';
  // menu-on：该行正被长按菜单指代（真机同款：菜单开着时被按下的行保持高亮，直接消歧「说哪个会话」）
  return `<div class="ubp-wx-row${conv.pinned ? ' pinned' : ''}${_convMenu?.id === conv.id ? ' menu-on' : ''}" data-ubp-act="open-conv" data-id="${escapeAttr(conv.id)}">
      ${avatar}
      <span class="ubp-wx-main">
        <span class="ubp-wx-title">${escapeHtml(conv.title)}${isGroup ? ` <span class="ubp-inline-sub">(${groupPeopleCount(conv)})</span>` : ''}</span>
        <span class="ubp-wx-preview">${preview}</span>
      </span>
      <span class="ubp-wx-side">
        <span class="ubp-wx-time">${escapeHtml(time)}</span>
        ${badge}
      </span>
    </div>`;
}

/** 一条「聊天记录」命中行（跨会话）：会话名 + 摘要 + 日期；点它直达该会话的该条消息。
 *  群聊行按会话列表的群预览口径补发送者署名。 */
function searchHitRowHtml(hit: PhoneMessageHit, meLabel: string, now: string): string {
  const m = hit.message;
  const senderName = m.from === 'me' ? meLabel : m.from;
  const preview = messagePreviewText(m);
  const text = hit.isGroup ? `${senderName}：${preview}` : preview;
  const who = hit.isGroup ? hit.convTitle : hit.convTitle;
  const rawTime = m.storyTime || '';
  const stamp = rawTime ? normalizeStoryTimeLabel(rawTime, now) : '';
  const time = (stamp && formatStampChat(stamp, now)) || storyTimeShort(rawTime);
  return `<div class="ubp-cs-row" data-ubp-act="search-jump" data-id="${escapeAttr(hit.convId)}" data-mid="${escapeAttr(m.id)}">
      ${avatarHtml(who, 'small')}
      <span class="ubp-cs-main">
        <span class="ubp-cs-name">${escapeHtml(hit.convTitle)}</span>
        <span class="ubp-cs-text">${escapeHtml(text)}</span>
      </span>
      <span class="ubp-cs-time">${escapeHtml(time)}</span>
    </div>`;
}

/** 会话页列表（首帧与逐键就地过滤共用一份，避免两处漂移）。
 *  无搜索词=纯会话列表；有搜索词=「会话」段（按会话名/成员名命中）+「聊天记录」段（按消息正文命中）。
 *  两段都在同一 #ubp-wx-list 容器内 ⇒ 过滤只换该容器 innerHTML，不动输入框（保焦点与光标）。 */
function sessionsListHtml(data: PhoneChatData, q: string, meLabel: string, now: string): string {
  const convs = sortedConversations(data);
  if (!q) {
    return convs.length
      ? `<div class="ubp-wx-list">${convs.map(c => sessionRowHtml(c, meLabel, now)).join('')}</div>`
      : `<div class="ubp-empty"><b>${S('还没有聊天', '尚无符讯往来', '尚无书信往来', '尚无晶讯往来')}</b><br>${S('去「通讯录」找角色开启第一段对话', '去「道友录」觅一位道友，递上名帖开启传讯', '去「名录」觅一位人物，递上拜帖开启书信', '去「名录」觅一位人物，递上荐书开启晶讯')}</div>`;
  }
  const convHits = convs.filter(c => conversationMatches(c, q));
  const msgHits = searchPhoneMessages(data, q, SEARCH_HIT_LIMIT);
  if (!convHits.length && !msgHits.length) {
    return `<div class="ubp-empty">${S(`没有找到与「${escapeHtml(q)}」相关的内容`, `未寻得与「${escapeHtml(q)}」相关的内容`)}</div>`;
  }
  const convSection = convHits.length
    ? `<div class="ubp-wx-grouphead">${S('会话', '符讯')}（${convHits.length}）</div>
       <div class="ubp-wx-list">${convHits.map(c => sessionRowHtml(c, meLabel, now)).join('')}</div>`
    : '';
  const msgSection = msgHits.length
    ? `<div class="ubp-wx-grouphead">${S('聊天记录', '往来记录')}（${msgHits.length}${msgHits.length >= SEARCH_HIT_LIMIT ? '+' : ''}）</div>
       <div class="ubp-wx-list">${msgHits.map(h => searchHitRowHtml(h, meLabel, now)).join('')}</div>`
    : '';
  return convSection + msgSection;
}

/** 会话页搜索框输入：只就地重写列表容器（不整帧重绘——保输入焦点与光标，同 @ 面板纪律）。 */
// O41(第十二轮)：会话搜索去抖（140ms）——过滤要逐会话扫消息，长局下每键一次全表扫描可感。
const scheduleSessionFilter = debounceTrailing(140, () => { if (_ctx) applySessionFilter(); });

function applySessionFilter(): void {
  const list = _ctx?.container.querySelector('#ubp-wx-list') as HTMLElement | null;
  if (!list) return;
  // P1：只读过滤/渲染走零拷贝引用（原先每敲一键都 readPhoneDataSafe() = 整机 normalize + 深拷贝）。
  // 纪律：引用禁改写，要改一律走 mutatePhoneData（列表构造链已核实为纯读）。
  const data = readPhoneDataRef();
  list.innerHTML = sessionsListHtml(data, _searchQuery.trim(), getRoster().protagonistName || '我', getRoster().global.time);
}

// ─── 会话页「＋」统一菜单 + 长按会话动作面板（真机微信：会话页/通讯录页同一个 ＋） ───

/** 会话页与通讯录页共用的「＋」菜单（真机微信两页 ＋ 都是同一张菜单）。 */
function openWxPlusMenu(): void {
  if (!_ctx) return;
  openActionSheetCore(_ctx.container, {
    title: S('微信', '传讯'),
    actions: [
      { label: S('发起群聊', '结盟共谈'), onPick: openGroupCreateSheet },
      { label: S('添加朋友', '结交道友', '结识人物', '结识同伴'), onPick: openAddContactSheet },
      { label: S('我的收藏', '我的珍藏'), onPick: openFavs },
      { label: S('取消', '作罢'), onPick: () => { /* 取消 */ } },
    ],
  });
}

function openGroupCreateSheet(): void {
  _groupSel = new Set();
  _groupTitle = '';
  _overlay = { kind: 'group-create' };
  render();
}

function openAddContactSheet(): void {
  _addName = '';
  _addReason = '';
  _overlay = { kind: 'add-contact' };
  render();
}

// ─── 会话长按菜单（真机微信式贴行弹框；非底部动作面板） ───
// 与消息气泡菜单（.ubp-wx-menu 深色 + 小三角）同族但不同形态：真机微信长按会话行弹的是
// **贴住该行的浅色面板**——左对齐竖向条目 + 细分隔线、不压暗背景、点外部/滚动即收。

/** 菜单估计高度（决定落在行的上方还是下方；真机同款翻转）。 */
const CONV_MENU_EST_H = 210;

/** 菜单锚点：touchRatio=按下点的横向比例（0~1，与 CSS 缩放无关）；leftPct=渲染首值，
 *  渲染完成后由 placeConvMenu 按面板**实测宽度**收紧，尽量让左沿贴住手指落点。 */
let _convMenu: { id: string; topPct: number; below: boolean; touchRatio: number; leftPct: number } | null = null;

/** 打开菜单那一刻列表**已恢复到**的滚动位置（＝菜单锚点所依据的位置；-1=菜单未开）。
 *  只用来把 render() 保位补派的那条 scroll 与用户滚动区分开（见 handleScroll）。 */
let _convMenuScrollTop = -1;

/** 按 id 从**当前 DOM** 取会话行。长按的 480ms 里可能来过整帧重绘（后台会话送达、立绘快照刷新），
 *  按下那一刻抓在手里的节点已脱离文档——对它量几何全是 0，菜单会被锚到手机顶部（实测 top=6）。
 *  取不到＝该行已不在列表里（会话被删/被搜走），返回 null 由调用方放弃。 */
function findLiveConvRow(app: HTMLElement, convId: string): HTMLElement | null {
  for (const el of Array.from(app.querySelectorAll<HTMLElement>('.ubp-wx-row[data-ubp-act="open-conv"]'))) {
    if (el.dataset.id === convId) return el;
  }
  return null;
}

/** 同上：按消息 id 取活的气泡行（长按气泡菜单的锚点，同一个重绘竞态）。 */
function findLiveMsgRow(app: HTMLElement, mid: string): HTMLElement | null {
  for (const el of Array.from(app.querySelectorAll<HTMLElement>('.ubp-msg-row[data-mid]'))) {
    if (el.dataset.mid === mid) return el;
  }
  return null;
}

/** 打开会话菜单：锚在按下点（横向）与行的上/下沿（纵向）。
 *  浮层挂在 App 容器（.ubp-app，position:relative）下——遮罩盖满整个 App（含顶栏，点哪都收），
 *  且随 App 容器一并销毁（openApp 重建 .ubp-app），不会跨 App 残留。 */
function openConvMenu(row: HTMLElement, touchX: number): void {
  const app = _ctx?.container;
  const convId = row.dataset.id || '';
  if (!app || !convId) return;
  const live = findLiveConvRow(app, convId); // 锚点一律取活节点（手里那个可能已被重绘换掉）
  if (!live) return;
  const cr = app.getBoundingClientRect();
  const rr = live.getBoundingClientRect();
  let topPct = 50;
  let touchRatio = 0.05;
  let below = false;
  if (cr.height > 0) {
    const above = rr.top - cr.top;
    below = above < CONV_MENU_EST_H; // 上方放不下 → 落到行下方（真机同款翻转）
    topPct = ((below ? rr.bottom - cr.top : above) / cr.height) * 100;
    // 按下点的横向比例（client 坐标取比值 → CSS 缩放无关）
    touchRatio = Math.max(0, Math.min(1, (touchX - cr.left) / cr.width));
  }
  // 渲染首值按最宽档（max-width 64%）保守夹取：即使 placeConvMenu 因未布局跳过也不会越界
  _convMenu = { id: convId, topPct, below, touchRatio, leftPct: Math.max(3, Math.min(33, touchRatio * 100)) };
  render();
  placeConvMenu(); // 同步收紧：浏览器不会先画出偏移位置那一帧
  const body = wxScrollBody(app); // 上面这次 render 已保位填回列表位置 → 记作锚点依据的位置
  _convMenuScrollTop = body ? body.scrollTop : -1;
}

/** 按面板**实测宽度**把左沿贴到按下点（面板越窄贴得越紧）。面板宽度固定时右侧越界不可避免，
 *  此时只左移到刚好贴边——手指始终落在面板横向范围内，叠加「被按下的行保持高亮」即可消歧。 */
function placeConvMenu(): void {
  const app = _ctx?.container;
  const panel = app?.querySelector('.ubp-wx-cmenu') as HTMLElement | null;
  const menu = _convMenu;
  if (!app || !panel || !menu) return;
  const appW = app.offsetWidth;
  // 上限兜底：CSS max-width 就是 64%，量到更大的值只可能是「样式未落地时量宽」（此时夹取会退化成最左）
  const menuW = Math.min(panel.offsetWidth, appW * 0.64);
  if (!appW || !menuW) return; // 未完成布局（如 App 未挂载）→ 保留首值
  const maxPct = Math.max(3, ((appW - menuW) / appW) * 100 - 3);
  panel.style.left = `${Math.max(3, Math.min(menu.touchRatio * 100, maxPct)).toFixed(2)}%`;
}

/** 收起菜单：只摘 DOM（不整帧重绘——滚动中调用也不跳位），并清掉按下行的高亮。 */
function closeConvMenu(): void {
  _convMenuScrollTop = -1;
  if (!_convMenu) return;
  _convMenu = null;
  const c = _ctx?.container;
  c?.querySelector('.ubp-wx-cmenu-veil')?.remove();
  c?.querySelector('.ubp-wx-cmenu')?.remove();
  c?.querySelectorAll('.ubp-wx-row.menu-on').forEach(n => n.classList.remove('menu-on'));
}

/** 会话菜单 markup（浅色面板；危险项红字；末项「取消」与真机一致留在同一面板内）。 */
function convMenuHtml(): string {
  const menu = _convMenu;
  if (!menu) return '';
  const conv = readPhoneDataRef().conversations.find(c => c.id === menu.id); // U22(十一轮)：零拷贝
  if (!conv) return '';
  const items: Array<{ act: string; label: string; danger?: boolean }> = [
    { act: 'conv-pin', label: conv.pinned ? S('取消置顶', '取消置顶') : S('置顶该聊天', '置顶该传讯') },
    { act: 'conv-unread', label: S('标为未读', '标为未读') },
    { act: 'conv-del', label: S('删除该聊天', '删去该传讯'), danger: true },
    { act: 'conv-menu-close', label: S('取消', '作罢') },
  ];
  return `<div class="ubp-wx-cmenu${menu.below ? ' below' : ''}" style="top:${menu.topPct.toFixed(2)}%;left:${menu.leftPct.toFixed(2)}%">
    ${items.map(it => `<button type="button" class="ubp-wx-cmenu-item${it.danger ? ' danger' : ''}" data-ubp-act="${it.act}" data-id="${escapeAttr(conv.id)}">${escapeHtml(it.label)}</button>`).join('')}
  </div>`;
}

function setConvPinned(convId: string, pinned: boolean): void {
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === convId);
    if (!conv) return;
    if (pinned) conv.pinned = true;
    else delete conv.pinned;
  });
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

function markConvUnread(convId: string): void {
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === convId);
    if (conv) conv.manualUnread = true; // 真机=红点，不伪造未读条数
  });
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 角色备注读取（**随本聊天存档**，与自定义头像同层；没写过/空串一律返回 ''）。 */
function characterNoteOf(data: PhoneChatData, name: string): string {
  return (data.characterNotes && data.characterNotes[name]) || '';
}

/** 角色备注写入（空串＝删键：数据上「没写过」与「写了空」等价，不留垃圾键）。 */
function setCharacterNote(name: string, text: string): void {
  if (!name) return;
  const note = text.trim().slice(0, MAX_CHARACTER_NOTE_LEN);
  mutatePhoneData(d => {
    if (!d.characterNotes) d.characterNotes = {};
    if (note) d.characterNotes[name] = note;
    else delete d.characterNotes[name];
  });
  emitPhoneEvent('ubp-phone:data-changed');
}

function renderSessions(): void {
  const container = _ctx!.container;
  const prevTop = wxScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是旧视图）
  // U22(十一轮)：零拷贝引用（P1 范式补漏——停在会话列表时每条后台消息不再整机深拷贝）
  const data = readPhoneDataRef();
  const storeState = phoneStoreStatus();
  const storeBanner = storeState.state === 'read-only'
    ? `<div class="ubp-sys-msg error" style="margin:8px auto;">存储只读（${escapeHtml(storeState.error || '文件损坏')}）：可浏览，暂不能保存新消息</div>`
    : storeState.state === 'no-context' || storeState.state === 'error'
      ? `<div class="ubp-sys-msg error" style="margin:8px auto;">存储不可用（${escapeHtml(storeState.error || storeState.state)}）</div>`
      : '';
  const meLabel = getRoster().protagonistName || '我';
  const now = getRoster().global.time;
  const q = _searchQuery.trim();
  const listHtml = `<div id="ubp-wx-list">${sessionsListHtml(data, q, meLabel, now)}</div>`;
  container.innerHTML = `
    <div class="ubp-appbar">
      <span class="ubp-appbar-title">${S('微信', '传讯')}</span>
      <button class="ubp-iconbtn" data-ubp-act="wx-plus" title="${S('更多', '更多')}">${ubpIcon('plus')}</button>
    </div>
    <div class="ubp-appbody noscroll">
      ${storeBanner}
      <div class="ubp-chat" style="flex:1;">
        <div class="ubp-appbody" style="flex:1;">
          <div class="ubp-wx-searchbar">
            <span class="ubp-wx-searchicon">${ubpIcon('search')}</span>
            <input id="ubp-wx-search" class="ubp-wx-searchinput" type="text" autocomplete="off"
              value="${escapeAttr(_searchQuery)}" placeholder="${S('搜索', '寻访')}">
          </div>
          ${listHtml}
        </div>
        <div class="ubp-tabbar">
          <button class="ubp-tab active" data-ubp-act="tab" data-id="sessions">${S('聊天', '符讯')}</button>
          <button class="ubp-tab" data-ubp-act="tab" data-id="contacts">${S('通讯录', '道友录')}</button>
        </div>
      </div>
    </div>
    ${_convMenu ? `<div class="ubp-wx-cmenu-veil" data-ubp-act="conv-menu-close"></div>${convMenuHtml()}` : ''}
    ${renderOverlayHtml(data)}`;
  // 跨视图保位：从聊天返回会话列表回到离开处；同视图重绘（搜索/未读变化）原位保全
  const body = wxScrollBody(container);
  if (body) body.scrollTop = _viewScroll.settle('sessions', prevTop).top;
}

// ─── 通讯录 ───

type ContactRow = ReturnType<typeof mergeCustomContacts>[number];

/** 通讯录名单 HTML（首帧与逐键就地过滤共用一份，避免两处漂移）。
 *  搜索命中=角色名包含关键词（与电话 App 的 _contactQuery 同口径：同一份 roster，同一套匹配）。 */
function contactsListHtml(all: ContactRow[]): string {
  if (!all.length) {
    return `<div class="ubp-empty"><b>还没有角色</b><button class="ubp-empty-btn" data-ubp-act="add-contact">${S('添加好友', '结交道友')}</button></div>`;
  }
  const q = _contactQuery.trim().toLowerCase();
  const hit = (c: ContactRow): boolean => !q || c.name.toLowerCase().includes(q);
  const friends = all.filter(c => _contactFriendSet.has(c.name) && hit(c));
  const others = all.filter(c => !_contactFriendSet.has(c.name) && hit(c));
  if (!friends.length && !others.length) {
    return `<div class="ubp-empty">${S(`没有找到与「${q}」相关的角色`, `未寻得与「${q}」相关的人物`)}</div>`;
  }
  const section = (title: string, list: ContactRow[], emptyHint = '') => {
    if (!list.length && (!emptyHint || q)) return '';
    return `<div class="ubp-wx-grouphead">${title}（${list.length}）</div>` + (list.length
      ? list.map(c => `
      <div class="ubp-wx-row" data-ubp-act="show-profile" data-id="${escapeAttr(c.name)}">
        ${avatarHtml(c.name)}
        <span class="ubp-wx-main">
          <span class="ubp-wx-title">${escapeHtml(c.name)}</span>
          <span class="ubp-wx-preview">${escapeHtml(c.brief || c.identity || (c.gender ? `${c.gender}${c.age ? ' · ' + c.age : ''}` : '') || (c.custom ? S('自定义角色 · 档案待补', '自识道友 · 档案待补') : ''))}</span>
        </span>
      </div>`).join('')
      : `<div class="ubp-empty" style="padding:16px;">${emptyHint}</div>`);
  };
  return section(S('好友', '道友'), friends, S('还没有好友，点「非好友」里的角色发送申请', '尚无道友，点「未结交」里的角色递上名帖', '尚无故人，点「未相识」里的人物递上拜帖', '尚无同伴，点「未相识」里的人物递上荐书'))
    + section(S('非好友', '未结交'), others);
}

/** 通讯录逐键就地过滤（只换名单节点，不整帧重绘——保输入焦点与光标）。 */
function applyContactFilter(): void {
  const list = _ctx?.container.querySelector('#ubp-contact-list') as HTMLElement | null;
  if (!list) return;
  const roster = getRoster();
  list.innerHTML = contactsListHtml(mergeCustomContacts(roster, readPhoneDataRef().customContacts || []));
}

function renderContacts(): void {
  const container = _ctx!.container;
  const prevTop = wxScrollBody(container)?.scrollTop ?? 0; // 重绘前取（此时 DOM 还是旧视图）
  bindRosterInvalidation(); // 数据库晚就绪时补绑（幂等，guard 秒回）
  const roster = getRoster();
  // U22(十一轮)：零拷贝引用（P1 范式补漏）
  const data = readPhoneDataRef();
  const all = mergeCustomContacts(roster, data.customContacts || []);
  _contactFriendSet = new Set(data.friends || []);
  container.innerHTML = `
    <div class="ubp-appbar">
      <span class="ubp-appbar-title">${S('通讯录', '道友录')}</span>
      <button class="ubp-iconbtn" data-ubp-act="wx-plus" title="${S('更多', '更多')}">${ubpIcon('plus')}</button>
    </div>
    <div class="ubp-appbody noscroll">
      <div class="ubp-chat" style="flex:1;">
        <div class="ubp-appbody" style="flex:1;">
          ${all.length ? `<div class="ubp-wx-searchbar" style="margin:8px 10px 2px;">
            <span class="ubp-wx-searchicon">${ubpIcon('search')}</span>
            <input class="ubp-wx-searchinput" id="ubp-contact-search" value="${escapeAttr(_contactQuery)}" placeholder="${S('搜索', '寻访')}" autocomplete="off">
          </div>` : ''}
          <div id="ubp-contact-list">${contactsListHtml(all)}</div>
        </div>
        <div class="ubp-tabbar">
          <button class="ubp-tab" data-ubp-act="tab" data-id="sessions">${S('聊天', '符讯')}</button>
          <button class="ubp-tab active" data-ubp-act="tab" data-id="contacts">${S('通讯录', '道友录')}</button>
        </div>
      </div>
    </div>
    ${renderOverlayHtml(data)}`;
  // 跨视图保位：会话/通讯录互切、从聊天返回各自回到离开处
  const body = wxScrollBody(container);
  if (body) body.scrollTop = _viewScroll.settle('contacts', prevTop).top;
}

// ─── 聊天页 ───

/** 消息是否命中搜索词（真机微信只搜正文；系统消息不进结果）。 */
function messageMatches(m: PhoneMessage, query: string): boolean {
  if (m.from === 'system') return false;
  return m.content.toLowerCase().includes(query.toLowerCase());
}

/** 一条搜索结果行（头像 + 谁说的 + 内容摘要 + 日期）。 */
function chatSearchRowHtml(m: PhoneMessage, conv: Conversation, meName: string, now: string): string {
  const who = m.from === 'me' ? meName : m.from;
  const rawTime = m.storyTime || '';
  const stamp = rawTime ? normalizeStoryTimeLabel(rawTime, now) : '';
  const time = (stamp && formatStampChat(stamp, now)) || rawTime;
  return `<div class="ubp-cs-row" data-ubp-act="chat-search-jump" data-mid="${escapeAttr(m.id)}">
      ${avatarHtml(who || conv.title, 'small')}
      <span class="ubp-cs-main">
        <span class="ubp-cs-name">${escapeHtml(who || conv.title)}</span>
        <span class="ubp-cs-text">${escapeHtml(messagePreviewText(m))}</span>
      </span>
      <span class="ubp-cs-time">${escapeHtml(time)}</span>
    </div>`;
}

/** 结果列表 HTML（首帧与逐键就地过滤共用一份，避免两处漂移）。 */
function chatSearchListHtml(conv: Conversation, now: string): string {
  const q = _chatSearchQuery.trim();
  if (!q) return `<div class="ubp-empty">${S('输入关键词，查找本会话的聊天记录', '落笔寻词，翻检这段符讯', '落笔寻词，翻检往来书信', '落笔寻词，翻检晶讯记录')}</div>`;
  const hits = conv.messages.filter(m => messageMatches(m, q));
  if (!hits.length) return `<div class="ubp-empty">${S('没有找到相关聊天记录', '未寻得相关符讯', '未寻得相关书信', '未寻得相关晶讯')}</div>`;
  const meName = getRoster().protagonistName || getRoster().userName || '我';
  // 新→旧（真机微信同款：最近的在最上面）；上限与消息表一致，无需额外截断
  const rows = hits.slice().reverse().map(m => chatSearchRowHtml(m, conv, meName, now)).join('');
  return rows;
}

/** 聊天内搜索页（真机微信「查找聊天记录」）：顶栏变搜索框 + 结果列表；点结果跳回该条消息。 */
function renderChatSearch(container: HTMLElement, conv: Conversation): void {
  const now = getRoster().global.time;
  container.innerHTML = `
    <div class="ubp-appbar ubp-cs-appbar">
      <span class="ubp-cs-field">${ubpIcon('search')}<input class="ubp-cs-input" id="ubp-cs-input" value="${escapeAttr(_chatSearchQuery)}" placeholder="${S('搜索', '寻访')}" autocomplete="off"></span>
      <button type="button" class="ubp-cs-cancel" data-ubp-act="chat-search-close">${S('取消', '作罢')}</button>
    </div>
    <div class="ubp-cs-scroll">
      <div class="ubp-cs-list" id="ubp-cs-list">${chatSearchListHtml(conv, now)}</div>
    </div>`;
  const input = container.querySelector('#ubp-cs-input') as HTMLInputElement | null;
  if (input) {
    input.focus();
    const n = input.value.length;
    try { input.setSelectionRange(n, n); } catch (_e) { /* ignore */ }
  }
}

/** 逐键就地过滤（只换结果列表节点，不整页重绘——保输入焦点与光标，同会话页搜索纪律）。 */
function applyChatSearchFilter(): void {
  const container = _ctx?.container;
  if (!container || !_chatId) return;
  const list = container.querySelector('#ubp-cs-list') as HTMLElement | null;
  if (!list) return;
  const conv = findConversation(readPhoneDataRef(), _chatId);
  if (!conv) return;
  list.innerHTML = chatSearchListHtml(conv, getRoster().global.time);
}

// ─── F40(第十一轮)：聊天视图「稳定壳 + 可更新分区」───
// 病灶：renderChat 整帧 container.innerHTML（含 #ubp-chat-input）；当前会话逐条送达
// （renderConvTick）每条都换掉 textarea——IME 组词被取消、光标复位。同文件对「后台会话
// +正在打字」有保护（notifyExternalMessage 纪律），偏偏最高频的「当前会话送达」没保护。
// 新形态：壳（appbar/输入栏骨架/textarea）只在「换会话 / selbar↔inputbar 结构切换 / 壳丢失」
// 时整建；其余渲染只更新四个分区（消息列表 / 输入附属区 / 右侧槽 / 菜单+覆盖层）。
// 事件绑定全在 container 委托（mount 一次性），textarea 保节点即保焦点与组词态。
let _chatShellKey: string | null = null;
const _zoneHtmlCache = new Map<string, string>();
function setZoneHtml(container: HTMLElement, selector: string, html: string): void {
  if (_zoneHtmlCache.get(selector) === html) return;
  _zoneHtmlCache.set(selector, html);
  const el = container.querySelector(selector) as HTMLElement | null;
  if (el) el.innerHTML = html;
}

function renderChat(): void {
  const container = _ctx!.container;
  const prevViewTop = wxScrollBody(container)?.scrollTop ?? 0; // 重绘前取旧视图位置（列表→聊天的入边也要记）
  // P1：整帧渲染读零拷贝引用（原先每条消息上屏都 renderChat → 整机深拷贝 + 全表重建）。
  const data = readPhoneDataRef();
  const conv = _chatId ? findConversation(data, _chatId) : null;
  if (!conv) {
    _chatIsGroup = false;
    _chatMembers = [];
    _chatIsFriend = true;
    _renderedChatId = null;
    _view = 'sessions';
    renderSessions();
    return;
  }
  // 滚动保位（记忆 rerender-scroll-preservation，屡犯项）：全量 innerHTML 会换掉滚动容器
  // 使 scrollTop 归零。重绘前记下位置与「已渲染的非系统消息条数」；重绘后——同会话且没来
  // 新消息 → 原样恢复（长按开/关菜单、进多选、勾选、图片生成态刷新全保位）；首次打开 /
  // 切会话 / 来新消息 → 照旧滚到底。
  const prevMsgs = container.querySelector('#ubp-chat-msgs') as HTMLElement | null;
  const prevTop = prevMsgs?.scrollTop ?? 0;
  const prevCount = prevMsgs ? prevMsgs.querySelectorAll('.ubp-msg-row[data-mid]').length : -1;
  const sameConv = _renderedChatId === conv.id;
  const isGroup = conv.kind === 'group';
  _chatIsGroup = isGroup;
  _chatMembers = groupSpeakerNames(conv);
  _chatAtmoNames = isGroup ? readyAtmosphereNames(conv) : [];
  _chatAtmoMeta = {};
  if (isGroup) {
    for (const a of readyAtmosphereMembers(conv)) {
      _chatAtmoMeta[a.name] = [a.gender, a.identity, a.personality].filter(Boolean).join(' · ');
    }
  }
  // 私聊非好友 = 好友申请会话（发送即触发；藏 ➕/触发钮）；群聊恒为正常聊天
  _chatIsFriend = isGroup || isFriend(data, conv.members[0]);
  // 聊天内搜索页（真机微信：⋯ → 查找聊天记录）整页接管聊天视图，取消即回聊天原状
  if (_chatSearchOpen) {
    // 进入搜索页的那一帧记下消息流位置（搜索页自身的重绘读不到 #ubp-chat-msgs，不能覆盖已记的值）
    if (prevCount >= 0) { _preSearchTop = prevTop; _preSearchCount = prevCount; }
    renderChatSearch(container, conv);
    return;
  }
  let lastStory = '';
  const rows: string[] = [];
  for (const m of conv.messages) {
    // 时间分割线：只显示故事时间快照，相邻消息故事时间变化时才出现
    if (m.storyTime && m.storyTime !== lastStory) {
      rows.push(`<div class="ubp-time-divider">${escapeHtml(m.storyTime)}</div>`);
      lastStory = m.storyTime;
    }
    rows.push(renderMessage(m, isGroup, isGroup ? conv.members : null));
  }
  // 预合成最近语音（仅 api/comfy 后端；同会话只触发一次）
  if (_warmedChatId !== conv.id) {
    _warmedChatId = conv.id;
    const voiceItems = conv.messages.filter(m => m.type === 'voice').slice(-6)
      .map(m => ({ text: m.content, sender: m.from === 'me' ? '我' : m.from, emotion: m.voiceEmotion || '', delivery: m.voiceDelivery || '' }))
      .filter(x => Boolean(x.sender) && Boolean(x.text));
    if (voiceItems.length) warmRecentVoices(voiceItems, 3);
  }
  const busy = isConvBusy(conv.id);
  const generating = _generatingConvs.has(conv.id);
  if (busy) {
    rows.push(`<div class="ubp-typing"><span class="ubp-typing-dots"><i></i><i></i><i></i></span>${generating ? `<button type="button" class="ubp-typing-abort" data-ubp-act="abort-gen">${S('终止', '终止')}</button>` : ''}</div>`);
  }
  const batchCount = busy ? 0 : trailingUserBatch(conv.messages).length;
  const selectableCount = conv.messages.filter(m => m.from !== 'system').length;
  // 聊天背景（⋯菜单更换；按会话 id 存，固定不随消息滚动）
  const chatBg = readChatBg(conv.id, data);
  // 背景层是壳里的**独立节点**（四个分区都不管它）⇒ 它的 markup 必须进壳键：否则换背景/调取景
  // 只走分区更新、背景节点永不重写（用户报障：要退出会话重进才见新背景）。键里放「路径 + 取景」
  // 共同生成的 markup，两者任一变化都当场生效；恢复默认 ⇒ 空串 ⇒ 键变 ⇒ 节点随之摘除。
  const bgHtml = chatBg
    ? `<div class="ubp-chat-bg"><div class="ubp-crop-media bg" style="background-image:url('${escapeAttr(chatBg)}');${cropMediaStyle(`bg:${conv.id}`)}"></div></div>`
    : '';
  // 待发引用（仅当属本会话时呈现；切会话由 openConversation/back 清空）
  const pendingQuote = _pendingQuote && _pendingQuote.convId === conv.id ? _pendingQuote.entry : null;
  // 输入栏右侧槽：有字=发送（上屏攒批），无字=＋（功能面板）——还原微信「＋ ⇄ 发送」双态
  const hasDraft = currentDraft(conv).trim().length > 0;
  // F40(十一轮)：分区串先行构建——壳整建与分区更新共用同一份字符串，杜绝两处漂移
  const extrasHtml = `
      ${_plusOpen ? plusPanelHtml() : ''}
      <div class="ubp-mention-panel" id="ubp-mention-panel" hidden></div>
      ${pendingQuote ? quoteBarHtml(pendingQuote) : ''}
      ${_chatIsFriend && !busy ? wxPendBarHtml(batchCount) : ''}`;
  const rightSlotHtml = inputRightSlotHtml(hasDraft, _chatIsFriend);
  const menuZoneHtml = _msgMenu ? `<div class="ubp-wx-menu-veil" data-ubp-act="msg-menu-close"></div>
      <div class="ubp-wx-menu${_msgMenu.below ? ' below' : ''}" style="top:${_msgMenu.topPct.toFixed(2)}%">${msgMenuHtml()}</div>` : '';
  const overlayZoneHtml = renderOverlayHtml(data);
  const shellHtml = `
    <div class="ubp-appbar">
      ${_selectMode
        ? `<button class="ubp-iconbtn" data-ubp-act="sel-cancel" title="${S('取消', '作罢')}">${ubpIcon('back')}</button>
           <span class="ubp-appbar-title" id="ubp-sel-count">${S('已选', '已择')} ${_selected.size} ${S('项', '则')}</span>`
        : `<button class="ubp-iconbtn" data-ubp-act="back" title="返回">${ubpIcon('back')}</button>
           <span class="ubp-appbar-title">${escapeHtml(conv.title)}${isGroup ? `<span class="ubp-appbar-sub">（${groupPeopleCount(conv)}人）</span>` : ''}</span>
           <button class="ubp-iconbtn" data-ubp-act="chat-menu" title="菜单">${ubpIcon('more')}</button>`}
    </div>
    <!-- ubp-chat-shell=聊天壳的**身份标记**：守卫按它判「容器里这份 DOM 是不是我建的那个壳」。
         会话列表页/通讯录页也用 .ubp-chat 当布局容器，按同名 class 判会把「重进上次那个会话」误判成
         壳还在（键恰好相同）⇒ 只走分区更新，而列表页里根本没有分区节点 ⇒ 整次点击静默落空。 -->
    <div class="ubp-chat ubp-chat-shell">
      ${bgHtml}
      <div class="ubp-chat-msgs" id="ubp-chat-msgs">${rows.join('')}</div>
      ${_selectMode ? `
      <div class="ubp-selbar">
        <button class="ubp-btn" data-ubp-act="sel-all" id="ubp-sel-all">${S('全选', '全选')}</button>
        <button class="ubp-btn primary" data-ubp-act="sel-forward" id="ubp-sel-forward" ${_selected.size ? '' : 'disabled'}>${S('转发', '转呈')}</button>
        <button class="ubp-btn danger" data-ubp-act="sel-delete" id="ubp-sel-delete" ${_selected.size ? '' : 'disabled'}>${S('删除', '删除')}</button>
      </div>` : `
      <div id="ubp-input-extras" style="display:contents">${extrasHtml}</div>
      <div class="ubp-inputbar">
        ${_chatIsFriend ? `<button class="ubp-toolbtn" data-ubp-act="send-voice" title="${S('语音（输入转写）', '传音（输入转写）')}">${ubpIcon('voiceWave')}</button>` : ''}
        <textarea class="ubp-chat-input" id="ubp-chat-input" rows="1" placeholder="${isGroup ? S('发送消息…（@提醒成员）', '刻录符讯…（@提醒盟友）', '落笔写信…（@提醒同道）', '落笔书写晶讯…（@提醒同仁）') : _chatIsFriend ? S('发送消息…', '刻录符讯…', '落笔写信…', '落笔书写晶讯…') : S('发送好友申请（附上理由）…', '递上名帖（附结交缘由）…')}">${escapeHtml(currentDraft(conv))}</textarea>
        <span id="ubp-input-right" style="display:contents">${rightSlotHtml}</span>
      </div>`}
      <div id="ubp-menu-zone" style="display:contents">${menuZoneHtml}</div>
    </div>
    <div id="ubp-overlay-zone" style="display:contents">${overlayZoneHtml}</div>`;
  // F40(十一轮)：壳键 = 会话 + 模式（selbar↔inputbar 结构切换才整建）；壳不在（列表/搜索页
  // 占用过容器）也整建——「壳在不在」的判据是 **ubp-chat-shell 身份标记**，不是同名布局类
  // .ubp-chat（列表页也用它；按 class 判会让「重进上次那个会话」永远命中「壳还在」，见 F80）。
  // 分区容器用 display:contents——不产生布局盒，视觉与原结构逐像素一致。
  // F59(第十二轮)：壳键补「标题 + 群人数 + 好友态」——这三者决定壳内标题栏与输入栏的内容，
  // 原键只有 会话id|模式 ⇒ 群改名/加减成员/好友通过后标题栏与输入栏永不更新（数据层是对的，只是 DOM 陈旧）。
  // 它们都是低频事件（改名/入群/通过申请），重建壳不会打断输入；仍保留 F40 的「消息列表分区」不动。
  // 报障修复：壳键再补「背景层 markup」——同理，背景层不在分区里，只有进键才会随换背景/调取景重写。
  const shellKey = conv.id + '|' + (_selectMode ? 'sel' : 'norm')
    + '|' + conv.title + '|' + (isGroup ? groupPeopleCount(conv) : 0) + '|' + (_chatIsFriend ? 'f' : 'n')
    + '|' + bgHtml;
  if (_chatShellKey !== shellKey || !container.querySelector('.ubp-chat-shell')) {
    _chatShellKey = shellKey;
    container.innerHTML = shellHtml;
    _zoneHtmlCache.set('#ubp-input-extras', extrasHtml);
    _zoneHtmlCache.set('#ubp-input-right', rightSlotHtml);
    _zoneHtmlCache.set('#ubp-menu-zone', menuZoneHtml);
    _zoneHtmlCache.set('#ubp-overlay-zone', overlayZoneHtml);
  } else {
    const msgsEl = container.querySelector('#ubp-chat-msgs') as HTMLElement | null;
    if (msgsEl) msgsEl.innerHTML = rows.join('');
    // F59：输入框占位符随好友态/群聊变化（壳键变化会整建，这里是兜底同步——写属性不重建节点）
    const ta = container.querySelector('#ubp-chat-input') as HTMLTextAreaElement | null;
    if (ta) {
      const ph = isGroup
        ? S('发送消息…（@提醒成员）', '刻录符讯…（@提醒盟友）', '落笔写信…（@提醒同道）', '落笔书写晶讯…（@提醒同仁）')
        : _chatIsFriend ? S('发送消息…', '刻录符讯…', '落笔写信…', '落笔书写晶讯…') : S('发送好友申请（附上理由）…', '递上名帖（附结交缘由）…');
      if (ta.placeholder !== ph) ta.placeholder = ph;
    }
    setZoneHtml(container, '#ubp-input-extras', extrasHtml);
    setZoneHtml(container, '#ubp-input-right', rightSlotHtml);
    setZoneHtml(container, '#ubp-menu-zone', menuZoneHtml);
    setZoneHtml(container, '#ubp-overlay-zone', overlayZoneHtml);
  }
  const msgs = container.querySelector('#ubp-chat-msgs') as HTMLElement | null;
  if (msgs) {
    const count = conv.messages.filter(m => m.from !== 'system').length;
    // 从「查找聊天记录」页回来时，搜索页没有 #ubp-chat-msgs ⇒ prevMsgs 取不到（prevCount=-1），
    // 会被当成「首次打开」贴底。此时改用进搜索前记下的位置/条数走同一套 keep 口径。
    const fromSearch = !prevMsgs && _searchReturn;
    _searchReturn = false;
    const baseTop = fromSearch ? _preSearchTop : prevTop;
    const baseCount = fromSearch ? _preSearchCount : prevCount;
    const keep = sameConv && baseCount >= 0 && count === baseCount;
    msgs.scrollTop = keep ? baseTop : msgs.scrollHeight;
    // 搜索结果跳转（一次性）：把目标消息滚到视口中央。刻意不做命中高亮/上下条导航——
    // 真机微信点搜索结果就是「滚到那条」，没有第二套指示器（用户定案）。
    if (_scrollToMid) {
      const target = Array.from(msgs.querySelectorAll<HTMLElement>('.ubp-msg-row[data-mid]'))
        .find(r => r.dataset.mid === _scrollToMid);
      if (target) {
        const top = target.getBoundingClientRect().top - msgs.getBoundingClientRect().top;
        msgs.scrollTop += top - msgs.clientHeight / 2 + target.getBoundingClientRect().height / 2;
      }
      _scrollToMid = null;
    }
  }
  _renderedChatId = conv.id;
  // 聊天跟底自管（上方贴底/保位），但要过记忆：进会话记下列表位置，返回时列表才回得到原处
  _viewScroll.settle(`chat:${conv.id}`, prevViewTop);
  updateSelAllLabel(selectableCount);
  pumpImages(conv);
}

/** 多选模式：全选按钮文案随选中态切换（全选→取消全选）。 */
function updateSelAllLabel(selectableCount: number): void {
  const btn = _ctx?.container.querySelector('#ubp-sel-all') as HTMLButtonElement | null;
  if (btn) btn.textContent = _selectMode && _selected.size >= selectableCount && selectableCount > 0 ? S('取消全选', '尽数取消') : S('全选', '全选');
}

/** 多选选中态就地更新（不整体重渲染——保滚动位置，对齐选人纪律）。 */
function refreshSelectUi(): void {
  const container = _ctx?.container;
  if (!container || !_selectMode) return;
  const count = container.querySelector('#ubp-sel-count');
  if (count) count.textContent = `${S('已选', '已择')} ${_selected.size} ${S('项', '则')}`;
  const fwd = container.querySelector('#ubp-sel-forward') as HTMLButtonElement | null;
  const del = container.querySelector('#ubp-sel-delete') as HTMLButtonElement | null;
  if (fwd) fwd.disabled = !_selected.size;
  if (del) del.disabled = !_selected.size;
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
  updateSelAllLabel(container.querySelectorAll('.ubp-msg-row[data-mid]').length);
}

function enterSelectMode(messageId: string): void {
  if (!messageId) return;
  _selectMode = true;
  _selected = new Set([messageId]);
  _msgMenu = null;
  _plusOpen = false;
  updateMentionPanel(null);
  render();
}

function exitSelectMode(): void {
  _selectMode = false;
  _selected.clear();
  _msgMenu = null;
}

function toggleSelect(messageId: string): void {
  if (_selected.has(messageId)) _selected.delete(messageId);
  else _selected.add(messageId);
  refreshSelectUi();
}

// ─── 长按消息菜单（WeChat 式气泡菜单：复制/转发/引用/编辑/删除/多选） ───

/** 长按消息 → 打开气泡菜单（锚在消息上/下方；点外部或 Esc 关闭；不改多选态）。
 *  锚点同样取**当前 DOM**里的行：按下这一 480ms 里来过整帧重绘（后台会话送达等）时，
 *  手里那个节点已脱离文档、量出来全 0——菜单会跑到聊天区顶部而不是消息旁边。 */
function openMsgMenu(_row: HTMLElement, id: string): void {
  if (!id) return;
  const app = _ctx?.container;
  const live = app ? findLiveMsgRow(app, id) : null;
  if (!live) return; // 消息已被删除/重绘后不在列表里：没有可锚的行，不弹（菜单本体也依赖该条存在）
  const chat = app?.querySelector('.ubp-chat') as HTMLElement | null;
  let topPct = 50;
  let below = false;
  if (chat) {
    const cr = chat.getBoundingClientRect();
    const rr = live.getBoundingClientRect();
    if (cr.height > 0) {
      const above = rr.top - cr.top;
      below = above < 108; // 上方放不下 → 菜单落到消息下方（真机同款翻转）
      topPct = ((below ? rr.bottom - cr.top : above) / cr.height) * 100;
    }
  }
  _selectMode = false;
  _selected.clear();
  _plusOpen = false;
  updateMentionPanel(null);
  _msgMenu = { id, topPct, below };
  render();
}

function closeMsgMenu(): void {
  if (!_msgMenu) return;
  _msgMenu = null;
  render();
}

/** 气泡菜单条目（对齐真实微信：文字消息可复制；编辑仅自己的可编辑消息）。 */
function msgMenuHtml(): string {
  const menu = _msgMenu;
  if (!menu) return '';
  const msg = currentConversation()?.messages.find(m => m.id === menu.id);
  if (!msg) return '';
  const items: Array<{ act: string; label: string; danger?: boolean }> = [];
  if (msg.type === 'text') items.push({ act: 'msg-copy', label: S('复制', '誊录') });
  items.push({ act: 'msg-forward', label: S('转发', '转呈') });
  items.push({ act: 'msg-quote', label: S('引用', '引述') });
  // 微信「我的收藏」（第八轮 §4）：文本/图片/语音/转发卡可收；已收=取消（同 messageId 去重）
  if (canFavoriteMessage(msg)) {
    items.push({ act: 'msg-fav', label: isMessageFavorited(msg.id) ? S('取消收藏', '取消珍藏') : S('收藏', '珍藏') });
  }
  // 编辑不限「自己的消息」：单条编辑的唯一有意义入口就是长按本菜单（多选里的编辑已删——
  // 「恰好选中 1 条」与批量的本职矛盾）。改他人消息是叙事自由，保存链路本就通。
  if (isMessageEditable(msg)) items.push({ act: 'msg-edit', label: S('编辑', '改写') });
  // 语音倍速（微信式：长按语音可 2 倍速）
  if (msg.type === 'voice') {
    items.push({ act: 'msg-vfav', label: S('收藏语音', '存下此音') });
    items.push({ act: 'msg-vdown', label: S('下载语音', '导出此音') });
    items.push({ act: 'msg-vrate-1', label: S('倍速 1.0×', '倍速 1.0×') });
    items.push({ act: 'msg-vrate-15', label: S('倍速 1.5×', '倍速 1.5×') });
    items.push({ act: 'msg-vrate-2', label: S('倍速 2.0×', '倍速 2.0×') });
  }
  items.push({ act: 'msg-del', label: S('删除', '删除'), danger: true });
  items.push({ act: 'msg-multi', label: S('多选', '多择') });
  return items.map(it => `<button type="button" class="ubp-wx-menu-item${it.danger ? ' danger' : ''}" data-ubp-act="${it.act}" data-id="${escapeAttr(menu.id)}">${escapeHtml(it.label)}</button>`).join('');
}

/** 剪贴板写入（宿主可能拒绝；失败返回 false，不抛）。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const win = hostDocument().defaultView as Window | null;
    if (win?.navigator?.clipboard?.writeText) {
      await win.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落 textarea 兜底 */ }
  try {
    const doc = hostDocument();
    if (!doc.body) return false;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** 菜单 → 复制。 */
function copyMessage(id: string): void {
  const msg = currentConversation()?.messages.find(m => m.id === id);
  closeMsgMenu();
  if (!msg || !_ctx) return;
  const container = _ctx.container;
  void copyTextToClipboard(msg.content).then(ok => showScreenToast(container, ok ? S('已复制', '已誊录') : S('复制失败', '誊录失败')));
}

/** 菜单 → 单条转发（复用多选转发链路）。 */
function forwardSingle(id: string): void {
  if (!id) { closeMsgMenu(); return; }
  _msgMenu = null;
  _selectMode = false;
  _selected = new Set([id]);
  void openForwardPicker();
}

/** 菜单 → 单条引用。 */
function quoteSingle(id: string): void {
  if (!id) { closeMsgMenu(); return; }
  _msgMenu = null;
  _selectMode = false;
  _selected = new Set([id]);
  startQuote();
}

/** 菜单 → 单条编辑（自己的文字/语音消息）。 */
function editSingle(id: string): void {
  const msg = currentConversation()?.messages.find(m => m.id === id);
  if (!msg || !isMessageEditable(msg)) { closeMsgMenu(); return; }
  _msgMenu = null;
  _editMsgId = id;
  _editDraft = msg.content;
  _overlay = { kind: 'msg-edit', id };
  render();
}

/** 菜单 → 单条删除（统一确认弹窗，IA-02）。 */
function confirmDeleteSingle(id: string): void {
  if (!id || !_ctx) { closeMsgMenu(); return; }
  const container = _ctx.container;
  closeMsgMenu();
  openConfirmSheet(container, {
    title: S('删除这条消息？', '焚去这则符讯？'),
    message: S('删除后无法恢复。', '湮灭后无可追回。'),
    confirmLabel: S('删除', '删除'),
    onConfirm: () => {
      _selected = new Set([id]);
      deleteSelectedMessages();
    },
  });
}

/** 菜单 → 进入多选并勾选本条（批量操作入口）。 */
function multiSelectSingle(id: string): void {
  if (!id) { closeMsgMenu(); return; }
  enterSelectMode(id);
}

/** 语音消息的播放计划（我方走主角默认音色；对方按角色分配；情绪/演绎随消息）。 */
function voicePlanOf(message: PhoneMessage): ReturnType<typeof voicePlanFor> {
  return voicePlanFor(
    message.content,
    message.from === 'me' ? '我' : message.from,
    message.voiceEmotion || '',
    message.voiceDelivery || '',
  );
}

/** 会话消息 → 相邻预取槽位（与 messages 同下标；非语音/无文本填 null）。 */
function voiceWarmSlots(conv: Conversation): VoiceWarmSlot[] {
  return conv.messages.map(m => (m.type === 'voice' && m.content
    ? { text: m.content, sender: m.from === 'me' ? '我' : m.from, emotion: m.voiceEmotion || '', delivery: m.voiceDelivery || '' }
    : null));
}

/** 当前会话里某条语音的发送方显示名（收藏/下载文件名用）。 */
function voiceSenderLabel(message: PhoneMessage): string {
  return message.from === 'me' ? senderDisplayName('me') : message.from;
}

/** 菜单 → 收藏/取消收藏语音（系统 TTS 无音频字节，不能收藏）。 */
async function toggleVoiceFavorite(id: string): Promise<void> {
  const msg = currentConversation()?.messages.find(m => m.id === id);
  if (!msg || !_ctx) { closeMsgMenu(); return; }
  const container = _ctx.container;
  closeMsgMenu();
  const plan = voicePlanOf(msg);
  if (!plan) { showScreenToast(container, S('语音未开启或没有可朗读文本', '语音未启或无文可读')); return; }
  if (plan.backend === 'system') { showScreenToast(container, S('系统 TTS 没有音频文件，无法收藏', '系统传音无存档，不可收藏')); return; }
  if (await voiceFavoriteHas(plan.cacheKey)) {
    await voiceFavoriteDelete(plan.cacheKey);
    showScreenToast(container, S('已取消收藏', '已取消收藏'));
    return;
  }
  const entry = await voiceCacheGet(plan.cacheKey);
  if (!entry?.blob?.size) { showScreenToast(container, S('先播放一次，生成后才能收藏', '先播放一次，生成后方可收藏')); return; }
  await voiceFavoritePut({
    key: plan.cacheKey,
    blob: entry.blob,
    mime: entry.mime || entry.blob.type || 'audio/mpeg',
    role: voiceSenderLabel(msg),
    text: msg.content,
    ...(msg.voiceEmotion ? { emotion: msg.voiceEmotion } : {}),
    engine: plan.backend,
    voice: plan.voiceId || plan.refAudio,
    createdAt: Date.now(),
  });
  // L9 成就：玩家亲手收藏语音成功（取消收藏分支不打点）
  emitAch('phone_voice_faved', {});
  showScreenToast(container, S('已收藏', '已收藏'));
}

// ─── 微信「我的收藏」（第八轮 §4 · A2）───
// 数据域 wechatFavs 随存档走（usb_phone_<h>.json）；语音只存转写+时长（回跳播放原消息，不复制音频——
// 音频本体收藏在「录音机」）。上限 500 丢最旧、同 messageId 全类型去重；不进编年史、不生成通知。

/** 当前存档的收藏列表（引用；只读）。 */
function wechatFavList(): WeChatFavorite[] {
  return readPhoneDataRef().wechatFavs || [];
}

/** 该消息是否已收藏（同 messageId 去重口径）。 */
function isMessageFavorited(mid: string): boolean {
  return wechatFavList().some(f => f.messageId === mid);
}

/** 真实时钟 → 「5月19日」（收藏页时间列；故事时间快照优先）。 */
function favShortDate(ms: number): string {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 收藏 / 取消收藏（长按菜单；同一条来回切换——重复收藏天然去重）。 */
function toggleWechatFavorite(id: string): void {
  const container = _ctx?.container;
  const conv = currentConversation();
  const msg = conv?.messages.find(m => m.id === id);
  if (!container || !conv || !msg) return;
  const existing = wechatFavList().find(f => f.messageId === id);
  if (existing) {
    mutatePhoneData(d => { d.wechatFavs = (d.wechatFavs || []).filter(f => f.messageId !== id); });
    showScreenToast(container, S('已取消收藏', '已取消珍藏'));
    emitPhoneEvent('ubp-phone:data-changed');
    return;
  }
  const fromName = msg.from === 'me' ? (senderDisplayName('me') || '我') : msg.from;
  const fav = favoriteFromMessage(msg, conv, fromName);
  if (!fav) { showScreenToast(container, S('这条消息不能收藏', '这条符讯不可珍藏')); return; }
  mutatePhoneData(d => { d.wechatFavs = trimWechatFavs([fav, ...(d.wechatFavs || [])]).kept; });
  // L9 成就：微信收藏写入成功（取消收藏分支不打点）
  emitAch('phone_wx_fav', { type: fav.type });
  showScreenToast(container, S('已收藏', '已珍藏'));
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 进收藏页（列表页 ＋ 菜单入口）。 */
function openFavs(): void {
  _view = 'favs';
  _favFilter = '';
  _overlay = null;
  _plusOpen = false;
  render();
}

/** 收藏条目对应的原消息（原消息已删返回 null——语音行诚实降级为「仅存快照」）。 */
function favLiveMessage(f: WeChatFavorite): PhoneMessage | null {
  const conv = readPhoneDataRef().conversations.find(c => c.id === f.conversationId);
  return conv?.messages.find(m => m.id === f.messageId) || null;
}

const FAV_TYPE_META: Record<WeChatFavoriteType, { cls: string; icon: PhoneIconName; label: string }> = {
  text: { cls: 'txt', icon: 'chatlog', label: '文本' },
  image: { cls: 'img', icon: 'image', label: '图片' },
  voice: { cls: 'voc', icon: 'voiceWave', label: '语音' },
  card: { cls: 'crd', icon: 'share', label: '卡片' },
};

/** 收藏行：类型彩标 + 来源「会话名 · 发送人」+ 摘要两行封顶 + 类型·时间·动作提示。 */
function favRowHtml(f: WeChatFavorite): string {
  const meta = FAV_TYPE_META[f.type];
  const dead = f.type === 'voice' && !favLiveMessage(f);
  const dur = f.type === 'voice' && f.durationSec ? ` ${f.durationSec}''` : '';
  const when = f.storyTime || favShortDate(f.createdAt);
  const hint = dead
    ? S('原消息已删除，仅存快照', '原讯已删，仅存快照')
    : f.type === 'image' ? S('点击看大图', '点看大图') : S('点击回原消息', '点回原讯');
  const thumb = f.type === 'image' && f.imagePath
    ? `<img class="ubp-fav-thumb" src="${escapeAttr(f.imagePath)}" alt="" loading="lazy">` : '';
  const play = f.type === 'voice' && !dead
    ? `<button type="button" class="ubp-fav-play${_favPlayingId === f.id ? ' playing' : ''}" data-ubp-act="fav-play" data-id="${escapeAttr(f.id)}" title="${S('播放', '开声')}">${_favPlayingId === f.id ? ubpIcon('stop') : ubpIcon('playFill')}</button>` : '';
  return `<div class="ubp-fav-row" data-ubp-act="fav-jump" data-id="${escapeAttr(f.id)}">
    <span class="ubp-fav-ic ${meta.cls}">${ubpIcon(meta.icon)}</span>
    <span class="ubp-fav-main">
      <b>${escapeHtml(f.conversationTitle)} · ${escapeHtml(f.fromName)}</b>
      <span class="tx">${escapeHtml(favoriteSummary(f))}${dur}</span>
      <span class="tm">${escapeHtml(meta.label)} · ${escapeHtml(when)} · ${hint}</span>
    </span>
    ${thumb}${play}
  </div>`;
}

function renderFavs(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  // 跨视图保位（同会话/通讯录口径）：整页 innerHTML 会换掉 .ubp-appbody ⇒ 行内播放/筛选/删收藏
  // 这类同视图重绘原位保全，从聊天进收藏再返回也各记各的位置
  const prevTop = wxScrollBody(container)?.scrollTop ?? 0;
  const all = wechatFavList();
  const list = filterWechatFavs(all, _favFilter);
  const countOf = (t: '' | WeChatFavoriteType): number => (t ? all.filter(f => f.type === t).length : all.length);
  const chips = ([['', S('全部', '全部')], ['text', S('文本', '文字')], ['image', S('图片', '影像')], ['voice', S('语音', '传音')], ['card', S('卡片', '书简')]] as Array<['' | WeChatFavoriteType, string]>)
    .map(([id, label]) => `<button type="button" class="ubp-chip${_favFilter === id ? ' on' : ''}" data-ubp-act="fav-filter" data-id="${id}">${escapeHtml(label)} · ${countOf(id)}</button>`).join('');
  const rows = list.length
    ? `<div class="ubp-wx-list">${list.map(favRowHtml).join('')}</div>`
    : `<div class="ubp-empty"><b>${S('还没有收藏', '尚无珍藏')}</b><br>${S('长按消息选「收藏」，就会出现在这里', '长按符讯选「珍藏」，便会现于此处')}</div>`;
  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="back" title="${S('返回', '返回')}">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${S('我的收藏', '我的珍藏')}<span class="ubp-appbar-sub">（${all.length}）</span></span>
      <button class="ubp-iconbtn" data-ubp-act="fav-menu" title="${S('菜单', '菜单')}">${ubpIcon('more')}</button>
    </div>
    <div class="ubp-appbody">
      <div class="ubp-fav-chips">${chips}</div>
      ${rows}
    </div>`;
  const body = wxScrollBody(container);
  if (body) body.scrollTop = _viewScroll.settle('favs', prevTop).top;
}

/** 点收藏行：text/voice/card 回原消息（滚到该条）；image 开大图；原消息已删如实提示。 */
function favJump(favId: string): void {
  const f = wechatFavList().find(x => x.id === favId);
  const container = _ctx?.container;
  if (!f || !container) return;
  if (f.type === 'image') {
    if (f.imagePath) openPhoneLightbox(container, { paths: [f.imagePath] });
    return;
  }
  const target = favoriteJumpTarget(f);
  if (!target) return;
  const conv = readPhoneDataRef().conversations.find(c => c.id === target.convId);
  if (!conv || !conv.messages.some(m => m.id === target.mid)) {
    showScreenToast(container, S('原消息已删除，仅存快照', '原讯已删，仅存快照'));
    return;
  }
  stopFavPlay();
  enterConversation(target.convId);
  _scrollToMid = target.mid;
  render();
  emitPhoneEvent('ubp-phone:data-changed'); // 进入会话=已读，悬浮球即时熄灭
}

/** 收藏页语音行内播放（复用唯一播放器；原消息在才有按钮）。 */
function stopFavPlay(): void {
  const h = _favHandle;
  _favHandle = null;
  _favPlayingId = '';
  try { if (h) h.stop(); else stopVoice(); } catch (_e) { /* ignore */ }
}

function toggleFavPlay(favId: string): void {
  const f = wechatFavList().find(x => x.id === favId);
  if (!f) return;
  if (_favPlayingId === favId) { stopFavPlay(); render(); return; }
  const msg = favLiveMessage(f);
  if (!msg) { if (_ctx) showScreenToast(_ctx.container, S('原消息已删除，仅存快照', '原讯已删，仅存快照')); return; }
  const plan = voicePlanOf(msg);
  if (!plan) return;
  stopFavPlay();
  _favPlayingId = favId;
  render();
  let achEmitted = false; // L9：收藏页播放同属微信语音域，真正开播才计一次
  _favHandle = playVoice({
    backend: plan.backend, cacheKey: plan.cacheKey, text: plan.text,
    voiceId: plan.voiceId, providerId: plan.providerId, refAudio: plan.refAudio,
    speed: plan.speed, emotion: plan.emotion, delivery: plan.delivery, role: plan.role,
    onState: (st) => {
      if (st === 'playing' && !achEmitted) { achEmitted = true; emitAch('phone_voice_played', { from: 'wechat' }); }
      if (st === 'ended' || st === 'error') {
        if (_favPlayingId !== favId) return;
        stopFavPlay();
        render();
      }
    },
  });
}

/** 页头 ⋯：清空收藏（确认）。 */
function openFavsMenu(): void {
  const container = _ctx?.container;
  if (!container) return;
  const total = wechatFavList().length;
  openActionSheetCore(container, {
    title: `${S('我的收藏', '我的珍藏')}（${total}）`,
    message: S('收藏随聊天存档保存；清空只删收藏，不动聊天记录与图片文件。', '珍藏随存档保存；清空只删珍藏，不动符讯与影像。'),
    actions: [
      { label: S('清空收藏', '清空珍藏'), tone: 'danger' as const, onPick: () => {
        openConfirmSheet(container, {
          title: S('清空全部收藏？', '清空全部珍藏？'),
          message: S(`将删除全部 ${total} 条收藏（不影响聊天记录与相册）。`, `将删去全部 ${total} 条珍藏（不伤符讯与影集）。`),
          confirmLabel: S('清空', '清空'),
          onConfirm: () => {
            mutatePhoneData(d => { d.wechatFavs = []; });
            showScreenToast(container, S('收藏已清空', '珍藏已清空'));
            emitPhoneEvent('ubp-phone:data-changed');
            render();
          },
        });
      } },
      { label: S('取消', '作罢'), onPick: () => { /* 关闭 */ } },
    ],
  });
}

/** 长按收藏行：删除单条（确认）。 */
function confirmDeleteFav(favId: string): void {
  const container = _ctx?.container;
  const f = wechatFavList().find(x => x.id === favId);
  if (!container || !f) return;
  openConfirmSheet(container, {
    title: S('删除这条收藏？', '删去这条珍藏？'),
    message: `${f.conversationTitle} · ${f.fromName}：${favoriteSummary(f).slice(0, 40)}`,
    confirmLabel: S('删除', '删去'),
    onConfirm: () => {
      mutatePhoneData(d => { d.wechatFavs = (d.wechatFavs || []).filter(x => x.id !== favId); });
      showScreenToast(container, S('已删除', '已删去'));
      emitPhoneEvent('ubp-phone:data-changed');
      render();
    },
  });
}

/** 菜单 → 下载语音（收藏优先，其次缓存；文件名「角色 - 台词」）。 */
async function downloadMessageVoice(id: string): Promise<void> {
  const msg = currentConversation()?.messages.find(m => m.id === id);
  if (!msg || !_ctx) { closeMsgMenu(); return; }
  const container = _ctx.container;
  closeMsgMenu();
  const plan = voicePlanOf(msg);
  if (!plan) { showScreenToast(container, S('语音未开启或没有可朗读文本', '语音未启或无文可读')); return; }
  try {
    const name = await downloadVoice(plan.cacheKey, voiceSenderLabel(msg), msg.content);
    showScreenToast(container, S(`已下载 ${name}`, `已下载 ${name}`));
  } catch (e) {
    showScreenToast(container, (e as Error)?.message || S('下载失败', '下载失败'));
  }
}

// ─── 引用回复（我方消息；角色不产出引用） ───

/** 发言人显示名（'me' → 主角显示名；引用卡与消息昵称同口径）。 */
function senderDisplayName(from: string): string {
  const roster = getRoster();
  return from === 'me' ? (roster.protagonistName || roster.userName || '我') : from;
}

/** 消息 → 引用快照（复用转发条目结构 PhoneLogEntry，渲染/提示词共用 logEntryBody；原文不截断，
 *  长度上限与嵌套 chatlog 展平由写入时的 normalizeLogEntry 统一兜底）。 */
function quoteSnapshotOf(message: PhoneMessage): PhoneLogEntry {
  return {
    from: message.from,
    type: message.type,
    content: message.content,
    ...(message.amount ? { amount: message.amount } : {}),
  };
}

/** 气泡上方引用卡（与气泡同底色 + 同圆角上半，视觉连成一体；文案口径=发言人：原文，同提示词）。 */
function quoteCardHtml(quote: PhoneLogEntry): string {
  return `<span class="ubp-quote-card"><b>${escapeHtml(senderDisplayName(quote.from))}</b><i>：${escapeHtml(logEntryBody(quote))}</i></span>`;
}

/** 输入框上方引用条（待发引用；单行预览省略 + ✕ 取消）。 */
function quoteBarHtml(quote: PhoneLogEntry): string {
  return `<div class="ubp-quote-bar">
      <span class="ubp-quote-bar-main"><b>${escapeHtml(senderDisplayName(quote.from))}</b><i>：${escapeHtml(logEntryBody(quote))}</i></span>
      <button type="button" class="ubp-quote-cancel" data-ubp-act="quote-cancel" title="${S('取消引用', '撤去引述')}">✕</button>
    </div>`;
}

/** 长按菜单「引用」：该条存为待发引用 → 退出多选 → 焦点回输入框（可直接打字）。 */
function startQuote(): void {
  if (!_chatId || _selected.size !== 1) return;
  const msg = currentConversation()?.messages.find(m => m.id === [..._selected][0]);
  if (!msg || msg.from === 'system') return;
  _pendingQuote = { convId: _chatId, entry: quoteSnapshotOf(msg) };
  exitSelectMode();
  render();
  (_ctx?.container.querySelector('#ubp-chat-input') as HTMLTextAreaElement | null)?.focus();
}

/** 取走待发引用（读+清；会话不匹配=丢弃）：发送函数各调一次，保证引用只作用于紧随其后的一条消息。 */
function takePendingQuote(): PhoneLogEntry | null {
  const entry = _pendingQuote && _pendingQuote.convId === _chatId ? _pendingQuote.entry : null;
  _pendingQuote = null;
  return entry;
}

/** ➕面板（微信式功能格：相册=转发现有图，拍照=描述生图，语音/转账/红包=我方富媒体）。 */
/** 输入栏上方的生成条：还原微信输入栏后不再有独立触发钮，触发生成只剩这一个可见入口。
 *  有攒批=「待发送 N 条 › 生成回复」；无攒批=「让对方先说 ›」（保住「批次为空=让对方开口」语义）；
 *  右侧 ⋯ = 本批额外提示（原长按触发钮的入口，改常显按钮后无需长按）。 */
function wxPendBarHtml(batchCount: number): string {
  const main = batchCount > 0
    ? `${S(`待发送 ${batchCount} 条`, `待发出 ${batchCount} 则`)} <span class="ubp-wx-pend-arrow">›</span> ${S('生成回复', '生成回讯')}`
    : S('让对方先说', '让对方先言');
  return `<div class="ubp-wx-pendbar">
    <button class="ubp-wx-pend-main" data-ubp-act="trigger">${main}</button>
    <button class="ubp-wx-pend-more" data-ubp-act="batch-hint" title="${S('本批额外提示', '本批额外提点')}">${ubpIcon('more')}</button>
  </div>`;
}

/** 右槽该是哪个钮：好友会话且无草稿=＋（功能面板），其余（有草稿 / 申请会话）=发送。
 *  **唯一真值源**——首帧 markup 与输入时就地换钮都问它，两处不可能再各判一次（F80 病灶即两处漂移）。
 *  导出供契约测试钉真值表。 */
export function inputRightSlotAct(hasDraft: boolean, isFriend: boolean): 'send' | 'plus' {
  return isFriend && !hasDraft ? 'plus' : 'send';
}

/** 输入栏右侧槽 markup：好友会话「＋ ⇄ 发送」双态（有字=发送上屏，无字=＋功能面板），还原微信右槽；
 *  申请会话恒为发送（图标；空草稿禁用）——申请即发即触，无攒批概念，故不给 ＋。
 *  同一份 markup 供首帧渲染与输入时就地换钮（syncInputRightSlot）共用，避免两处漂移。
 *  导出供契约测试断言三种形态的 data-ubp-act / disabled / 文案。 */
export function inputRightSlotHtml(hasDraft: boolean, isFriend: boolean): string {
  if (inputRightSlotAct(hasDraft, isFriend) === 'plus') {
    return `<button class="ubp-toolbtn" data-ubp-act="plus" title="${S('相册/拍照/转账/红包', '影阁/留影/灵石/福袋')}">${ubpIcon('plus')}</button>`;
  }
  if (!isFriend) {
    return `<button class="ubp-sendbtn" data-ubp-act="send" ${hasDraft ? '' : 'disabled'}>${ubpIcon('send')}</button>`;
  }
  return `<button class="ubp-sendbtn" data-ubp-act="send">${S('发送', '发出')}</button>`;
}

function plusPanelHtml(): string {
  // 语音已移到输入栏左侧独立钮（还原微信左槽），此处不再重复；剩 4 格=一整行
  const cells: Array<{ icon: PhoneIconName; label: string; act: string }> = [
    { icon: 'album', label: S('相册', '影阁'), act: 'pick-album' },
    { icon: 'camera', label: S('拍照', '留影'), act: 'send-image' },
    { icon: 'money', label: S('转账', '灵石'), act: 'send-transfer' },
    { icon: 'redpacket', label: S('红包', '福袋'), act: 'send-redpacket' },
  ];
  return `<div class="ubp-plus-panel">${cells.map(c => `
    <button type="button" class="ubp-plus-cell" data-ubp-act="${c.act}"><span class="ubp-plus-icon">${ubpIcon(c.icon)}</span><span>${c.label}</span></button>`).join('')}
  </div>`;
}

// ─── @ 选择列表（群聊；输入框上方非模态，继续打字实时过滤） ───

/** @ 候选：所有人置顶 + 名字含输入片段的成员。 */
function mentionCandidates(members: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  const hits = members.filter(n => !q || n.toLowerCase().includes(q));
  return q && !'所有人'.includes(q) ? hits : ['所有人', ...hits];
}

/** 就地更新 @ 列表（不整体重渲染，保输入焦点与光标）；query=null 收起。 */
function updateMentionPanel(query: string | null): void {
  const panel = _ctx?.container.querySelector('#ubp-mention-panel') as HTMLElement | null;
  if (!panel) return;
  if (query === null || !_chatIsGroup) {
    panel.hidden = true;
    return;
  }
  const rows = mentionCandidates(_chatMembers, query).map(name => {
    const atmo = _chatAtmoNames.includes(name);
    const sub = name === '所有人'
      ? S('提醒全部成员', '提醒全部盟友', '提醒全部同道', '提醒全部同仁')
      : atmo
        ? (_chatAtmoMeta[name] || S('普通群友', '闲谈道友', '捧场朋友', '闲聊同伴'))
        : '';
    return `<button type="button" class="ubp-mention-row" data-ubp-act="mention-pick" data-id="${escapeAttr(name)}">
      <span class="ubp-mention-name">${escapeHtml(name)}${atmo ? ` <span class="ubp-atmo-tag">${S('群友', '旁听', '捧场', '同伴')}</span>` : ''}</span>${sub ? `<span class="ubp-mention-sub">${escapeHtml(sub)}</span>` : ''}
    </button>`;
  }).join('');
  if (!rows) {
    panel.hidden = true;
    return;
  }
  panel.innerHTML = rows;
  panel.hidden = false;
}

/** 选中 @：把光标前未闭合的「@片段」替换为「@名字␣」，保持焦点与光标位置。 */
function insertMention(name: string): void {
  const input = _ctx?.container.querySelector('#ubp-chat-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const caret = input.selectionStart ?? input.value.length;
  const insert = `@${name} `;
  const frag = input.value.slice(0, caret).match(/@([^@\s]*)$/);
  if (frag) {
    const start = caret - frag[0].length;
    input.value = input.value.slice(0, start) + insert + input.value.slice(caret);
    input.setSelectionRange(start + insert.length, start + insert.length);
  } else {
    input.value += insert;
    input.setSelectionRange(input.value.length, input.value.length);
  }
  if (_chatId) setDraft(_chatId, input.value);
  updateMentionPanel(null);
  input.focus();
  const sendBtn = _ctx?.container.querySelector('.ubp-sendbtn') as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = !input.value.trim();
}

// ─── 语音消息（微信式：播放条 + 下方转写；TTS 真实播放；后端关闭时回落原假动画） ───

// 假动画回落态（后端 off / 无播放计划时）
let _playingVoiceId: string | null = null;
let _voiceTimer: ReturnType<typeof setTimeout> | null = null;
// 真实播放态（本地就地更新，不整屏重绘，保 scrollTop 与输入焦点）
let _voiceHandle: VoiceHandle | null = null;
interface VoiceUiState { id: string; state: VoicePlayState; ratio: number; remainSec: number; durSec: number; }
let _voiceUi: VoiceUiState | null = null;
/** 已触发预合成的会话 id（同会话重绘不重复预合成）。 */
let _warmedChatId: string | null = null;

/** 语音块最小宽度随时长递增（微信式：语音越长条越宽），上限兜底防超屏。 */
function voiceBlockMinWidth(dur: number): number {
  return voiceBarMinWidth(dur); // 视觉公式统一在 core/ubp-utils（窥私同款）
}

/** 语音条显示时长（秒）：有真实时长用真实时长，否则按转写字数估算。 */
function voiceDisplaySeconds(m: PhoneMessage): number {
  if (typeof m.voiceDurationMs === 'number' && m.voiceDurationMs > 0) return Math.max(1, Math.round(m.voiceDurationMs / 1000));
  return voiceDurationSeconds(m.content);
}

function renderVoice(m: PhoneMessage, me: boolean): string {
  const total = voiceDisplaySeconds(m);
  const enabled = isVoiceEnabled();
  const ui = _voiceUi && _voiceUi.id === m.id ? _voiceUi : null;
  const real = ui && (ui.state === 'playing' || ui.state === 'paused');
  const fake = _playingVoiceId === m.id;
  const playing = !!real || fake;
  const loading = ui?.state === 'loading';
  const durText = loading ? S('生成中…', '合成中…')
    : real ? `${Math.max(0, Math.ceil(ui!.remainSec))}''`
      : `${total}''`;
  const wave = loading ? `<span class="ubp-spinner"></span>` : ubpIcon('voiceWave');
  const progress = real ? `<span class="ubp-voice-progress" style="width:${Math.round((ui!.ratio || 0) * 100)}%"></span>` : '';
  // 总开关关闭：播放条置灰失效（点了没反应），情绪/演绎整行不渲染——只留文字转写
  const offTag = enabled ? '' : `<span class="ubp-voice-offtag">${ubpIcon('micOff')}${S('语音已关闭', '传音已关闭', '口信已关闭', '回声已关闭')}</span>`;
  const bar = `<button type="button" class="ubp-voice-bar${me ? ' rev' : ''}" data-ubp-act="voice-play" data-id="${escapeAttr(m.id)}" aria-label="播放语音${total}秒"${enabled ? '' : ' disabled'}>${wave}<span class="ubp-voice-dur">${durText}</span>${offTag}${progress}</button>`;
  const meta = enabled ? voiceMetaHtml(m.voiceEmotion, m.voiceDelivery) : '';
  const transcript = m.content ? `<span class="ubp-voice-text">${escapeHtml(m.content)}</span>` : '';
  return `<span class="ubp-voice${playing ? ' playing' : ''}${loading ? ' loading' : ''}${enabled ? '' : ' off'}" data-voice-id="${escapeAttr(m.id)}" style="min-width:${voiceBlockMinWidth(total)}px;">${bar}${meta}${transcript}</span>`;
}

/** 就地替换某条语音条 DOM（不整屏重绘）。 */
function patchVoiceNode(messageId: string): void {
  const conv = currentConversation();
  const msg = conv?.messages.find(mm => mm.id === messageId);
  const host = _ctx?.container;
  if (!conv || !msg || !host) return;
  const el = host.querySelector(`.ubp-voice[data-voice-id="${String(messageId).replace(/"/g, '\\"')}"]`);
  if (el) el.outerHTML = renderVoice(msg, msg.from === 'me');
}

function stopVoicePlayback(rerender = true): void {
  if (_voiceTimer) { clearTimeout(_voiceTimer); _voiceTimer = null; }
  const ids = new Set<string>();
  if (_playingVoiceId) ids.add(_playingVoiceId);
  if (_voiceUi) ids.add(_voiceUi.id);
  _playingVoiceId = null;
  _voiceUi = null;
  if (_voiceHandle) { try { _voiceHandle.stop(); } catch (_e) { /* ignore */ } _voiceHandle = null; }
  try { stopVoice(); } catch (_e) { /* ignore */ }
  if (!rerender) return;
  if (ids.size) ids.forEach(id => patchVoiceNode(id));
}

/** 点击语音条：优先真实 TTS 播放；后端关闭/无计划 → 回落原「按字数闪动」假动画。 */
function toggleVoicePlayback(message: PhoneMessage): void {
  // 正在播这条 → 停
  if ((_voiceUi && _voiceUi.id === message.id) || _playingVoiceId === message.id) {
    stopVoicePlayback();
    return;
  }
  stopVoicePlayback(false);
  const plan = voicePlanOf(message);
  // 总开关关闭 ⇒ 播放计划恒为 null（resolveVoiceBackend 短路成 off），按钮也已置灰不可点；
  // 这里直接返回，**不再回落旧的「按字数闪动」假动画**（用户定案：关闭时相关播放按钮自动失效）。
  if (!plan) return;
  const total = voiceDisplaySeconds(message);
  _voiceUi = { id: message.id, state: 'loading', ratio: 0, remainSec: total, durSec: total };
  patchVoiceNode(message.id);
  let achEmitted = false; // L9：真正开播才计一次（loading/失败不计）
  _voiceHandle = playVoice({
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
      if (st === 'playing' && !achEmitted) { achEmitted = true; emitAch('phone_voice_played', { from: 'wechat' }); }
      if (st === 'ended' || st === 'error') {
        if (_voiceUi && _voiceUi.id === message.id) { _voiceUi = null; _voiceHandle = null; patchVoiceNode(message.id); }
        return;
      }
      if (_voiceUi && _voiceUi.id === message.id) {
        _voiceUi = { ..._voiceUi, state: st };
        patchVoiceNode(message.id);
      }
    },
    onProgress: (ratio, remain, dur) => {
      if (!_voiceUi || _voiceUi.id !== message.id) return;
      _voiceUi = { ..._voiceUi, state: 'playing', ratio, remainSec: remain, durSec: dur };
      patchVoiceNode(message.id);
    },
  });
  // 相邻预取（第八轮 §2）：播这条时顺手把下一条优先/上一条的语音预合成进缓存（静默、不阻塞播放）
  const warmConv = currentConversation();
  if (warmConv) prewarmNeighbors(voiceWarmSlots(warmConv), warmConv.messages.indexOf(message));
}

/** 转账/红包弹层所选币种（联动未激活 → null）。 */
function moneyChosenCurrency(): CurrencyMeta | null {
  if (!isCurrencyLinkActive()) return null;
  return payCurrencyList().find(c => c.name === _moneyCurrency) || payCommon();
}

/** L15 超发判定：有币种、金额可解析且大于余额 → 返回超出额；否则 null（不拦）。 */
function moneyOverflow(meta: CurrencyMeta | null, parsed: { amount: string } | null): number | null {
  if (!meta || !parsed) return null;
  const amt = Number(parsed.amount);
  if (!Number.isFinite(amt)) return null;
  const bal = payBalance(meta);
  return amt > bal ? amt - bal : null;
}

/** 超发说明的三段（文案走既有分风格措辞包），HTML 与纯文本两条出口共用。 */
function moneyOverParts(meta: CurrencyMeta, shortage: number): { pre: string; amt: string; post: string } {
  return {
    pre: S('余额不足：还差 ', '灵石不足：尚缺 ', '银钱不足：尚缺 ', '钱袋不足：尚缺 '),
    amt: fmtQty(meta.precision, shortage) + ' ' + meta.name,
    post: S('，无法发送', '，无法送出', '，无法送出', '，无法送出'),
  };
}

/** 超发说明（余额卡里那一行）：只取 pre + 差额——卡是 danger 变体、发送键已禁用，尾句「无法发送」是废话。
 *  宿主 toast 的纯文本出口 moneyOverText 仍保留完整三段（单独弹出来的提示需要说全）。 */
function moneyOverHtml(meta: CurrencyMeta, shortage: number): string {
  const p = moneyOverParts(meta, shortage);
  return p.pre + '<b>' + escapeHtml(p.amt) + '</b>';
}

/** 超发说明（宿主 toast 用的纯文本）。 */
function moneyOverText(meta: CurrencyMeta, shortage: number): string {
  const p = moneyOverParts(meta, shortage);
  return p.pre + p.amt + p.post;
}

/** L15：按当前金额同步「发送」可用态与「余额不足」提示。
 *  就地切类 + 增删卡内那一行；不重绘整层、不读账本（余额与联动判定取自快照）。
 *  锚点从「金额框后插一行」改成「余额卡切 .over + 卡尾挂 .ubp-money-warn」：提示与它要解释的那笔钱同框。 */
function syncMoneyConfirmState(): void {
  const root = _ctx?.container;
  const btn = root?.querySelector('[data-ubp-act="money-confirm"]') as HTMLButtonElement | null;
  const parsed = parseAmountNote(`${_moneyAmount}|`);
  const chosen = moneyChosenCurrency();
  const over = moneyOverflow(chosen, parsed);
  if (btn) btn.disabled = !parsed || over !== null;
  const card = root?.querySelector('.ubp-money-head') as HTMLElement | null;
  const field = root?.querySelector('#ubp-money-amount') as HTMLElement | null;
  if (!card || !field) return; // 联动未激活（无余额卡）：没有可挂提示的位置
  const bad = over !== null && !!chosen;
  card.classList.toggle('over', bad);
  field.classList.toggle('ubp-money-amt-over', bad);
  const existing = card.querySelector('#ubp-money-over') as HTMLElement | null;
  if (!bad || !chosen || over === null) { existing?.remove(); return; }
  const doc = field.ownerDocument || document;
  const hint = existing || doc.createElement('div');
  if (!existing) {
    hint.className = 'ubp-money-warn';
    hint.id = 'ubp-money-over';
    card.appendChild(hint); // 卡尾：flex:0 0 100% 自动换到第二行
  }
  hint.innerHTML = moneyOverHtml(chosen, over);
}

/** 转账/红包弹层的余额卡（改版：旧行式 11.5px 灰字 → 圆底图标 + 「可用余额」+ 22px 大数）。
 *  多币种时它是唯一显示余额的地方（币种条只留币名）；超发时切 danger 变体并在卡尾给一行差额。 */
function moneyBalCardHtml(meta: CurrencyMeta, shortage: number | null): string {
  const over = shortage !== null;
  return `<div class="ubp-money-head${over ? ' over' : ''}">
        <span class="ubp-money-badge">${currencyIconSvg(meta.icon, 17)}</span>
        <span class="ubp-money-info">
          <span class="ubp-money-lab">${S('可用余额', '可用余钱', '可用银钱', '可用金币')}</span>
          <span class="ubp-money-val"><b class="ubp-money-num">${fmtQty(meta.precision, payBalance(meta))}</b><span class="ubp-money-unit">${escapeHtml(meta.name)}</span></span>
        </span>
        ${over ? `<div class="ubp-money-warn" id="ubp-money-over">${moneyOverHtml(meta, shortage)}</div>` : ''}
      </div>`;
}

/** 转账/红包卡片（微信式）。货币联动：金额按消息币种显示、glyph 换币种图标；
 *  收到的未拆红包显示「開」（点击拆开入账+金币动效），已拆/我方发出显示金额（已领取角标）。 */
function renderMoneyCard(m: PhoneMessage, me: boolean, senderName: string): string {
  const curMeta = isCurrencyLinkActive() ? payResolveCurrency(m.currency) : null;
  const amount = curMeta ? moneyAmountText(m.amount, curMeta) : displayAmount(m.amount, currentStyle());
  if (m.type === 'redpacket') {
    const claimable = !me && m.claimed === false;
    const corner = !me && m.claimed !== false;
    // claimable：右缘挂绝对定位的「開」钮（.ubp-rp-open），正文右侧要留位——见 .ubp-card.redpacket.claimable 规则
    return `<div class="ubp-card redpacket${corner ? ' claimed' : ''}${claimable ? ' claimable' : ''}">
      <span class="ubp-card-side"><i class="ubp-rp-icon">${ubpIcon('wechat')}</i></span>
      <span class="ubp-card-main"><b>${escapeHtml(m.content || S('恭喜发财 大吉大利', '福泽绵长 大道亨通', '彩头送君 好运自来', '财源广进 荣耀加身'))}</b><i>${escapeHtml(senderName)}${S('的红包', '的灵石福袋', '的赏钱', '的钱袋')}</i></span>
      ${claimable
        ? `<button type="button" class="ubp-rp-open" data-ubp-act="rp-claim" data-id="${escapeAttr(m.id)}">${S('開', '开')}</button>`
        : `<span class="ubp-card-amt">${escapeHtml(amount)}</span>`}
    </div>`;
  }
  return `<div class="ubp-card transfer">
    <span class="ubp-card-main"><b>${escapeHtml(amount)}</b><i>${escapeHtml(m.content || (me ? S('微信转账', '灵石转让', '银票汇兑', '金币转赠') : S('转账给你', '转让予你', '汇银予你', '金币赠你')))}</i></span>
    <span class="ubp-card-side"><i class="ubp-card-glyph">${curMeta ? currencyIconSvg(curMeta.icon, 16) : S('¥', '灵')}</i><i>${S('转账', '转让')}</i></span>
  </div>`;
}

/** 群聊文本里的 @名字/@所有人 微信式高亮（成员名精确匹配，其余按普通文字）。 */
function renderMessage(m: PhoneMessage, isGroup: boolean, groupMembers: string[] | null = null): string {
  if (m.from === 'system') {
    // 备忘气泡=可长按删除（仅此条，不进多选）；旧存档气泡无 memoTitle，从文案回填（历史兼容）
    const memoTitle = m.memoTitle || memoTitleFromBubbleText(m.content);
    if (memoTitle) {
      return `<div class="ubp-sys-msg" data-mid="${escapeAttr(m.id)}" data-memo-title="${escapeAttr(memoTitle)}" title="${S('长按删除该备忘', '长按焚去该手札')}">${escapeHtml(m.content)}</div>`;
    }
    const isError = m.content.startsWith('[错误]');
    return `<div class="ubp-sys-msg${isError ? ' error' : ''}" ${isError ? 'data-ubp-act="retry-last"' : ''}>${escapeHtml(m.content)}</div>`;
  }
  const me = m.from === 'me';
  const senderName = senderDisplayName(m.from);
  // 头像恒渲染（用户定案 2026-10-07，推翻旧「无图不渲染」拍板）：无立绘＝生成头像（渐变+首字+图案）。
  // 对方头像＝资料卡入口（show-profile）；**我方不接点击**——没有「自己」的资料卡，与真机一致（点自己头像无反应）。
  // 我方用 fallbackText='我'：否则占位字会取哨兵 key 的首字符 `_`。
  const avatar = me
    ? avatarHtml(PROTAGONIST_AVATAR_KEY, 'small', true, '我')
    : avatarActHtml(m.from, m.fromAtmosphere || _chatAtmoNames.includes(m.from) ? 'show-atmo-profile' : 'show-profile');
  const nameTag = isGroup ? `<span class="ubp-msg-name">${escapeHtml(senderName)}</span>` : '';
  let body: string;
  if (m.type === 'image') {
    if (m.imageStatus === 'ready' && m.imagePath) {
      // 重新生图在放大页里（image-lightbox 统一入口）；气泡不再单挂刷新按钮
      body = `<div class="ubp-bubble-img"><img src="${escapeAttr(m.imagePath)}" alt="" data-ubp-act="lightbox" data-id="${escapeAttr(m.imagePath)}" loading="lazy"></div>`;
    } else if (m.imageStatus === 'failed') {
      // 失败：顶部红色失败提示（+原因小字，仅会话内）+ 描述保留，点击重试
      const imgErr = getImageError(m.id);
      body = `<div class="ubp-img-pending ubp-img-failed" data-ubp-act="gen-image" data-id="${escapeAttr(m.id)}"><span class="ubp-mo-imgph-note">⚠ 生成失败</span>${imgErr ? `<span class="ubp-img-reason">${escapeHtml(imgErr)}</span>` : ''}<span class="ubp-mo-imgph-desc">${escapeHtml(m.content.slice(0, 60))}</span><span class="ubp-mo-imgph-hint">点击重试</span></div>`;
    } else if (_imageJobs.has(m.id)) {
      // 生成中（含串行队列等待）：转圈 + 描述；点击被 retryImage 的 _imageJobs 守卫吞掉
      body = `<div class="ubp-img-pending" data-ubp-act="gen-image" data-id="${escapeAttr(m.id)}"><span class="ubp-spinner"></span><span class="ubp-mo-imgph-desc">${escapeHtml(m.content.slice(0, 60) || '生成中…')}</span><span class="ubp-mo-imgph-hint">生成中…</span></div>`;
    } else {
      // 未开始：自动生图关闭、尚未轮到，或单批自动名额已满（imageManual）——点击手动生成
      const manualNote = m.imageManual
        ? `<span class="ubp-mo-imgph-note-quiet">单批自动生图上限 ${MAX_AUTO_IMAGES_PER_BATCH} 张</span>`
        : '';
      body = `<div class="ubp-img-pending" data-ubp-act="gen-image" data-id="${escapeAttr(m.id)}">${ubpIcon('image')}<span class="ubp-mo-imgph-desc">${escapeHtml(m.content.slice(0, 60))}</span>${manualNote}<span class="ubp-mo-imgph-hint">点击生成</span></div>`;
    }
  } else if (m.type === 'voice') {
    body = renderVoice(m, me);
  } else if (m.type === 'transfer' || m.type === 'redpacket') {
    body = renderMoneyCard(m, me, senderName);
  } else if (m.type === 'link') {
    // 链接卡（第八轮 §5：浏览器分享到微信；伪地址只展示，不发起任何请求）
    // 第十一轮照真机分享卡重排：标题(2行) + 摘要(3行) + 缩略块(徽/色) + 来源行(链条符 + 站名, 链接蓝)；
    // 卡里的等宽伪地址删掉（伪地址在上方地址栏里可见，不丢信息）。整卡可点 ⇒ 回跳浏览器那一页。
    // 摘要位优先显示页面描述（desc）——它就是分享后对方/AI 读得到的那段；旧档无 desc 回落搜索预览。
    const lk = m.link;
    const blurb = lk?.desc || lk?.preview || '';
    const thumb = lk?.mark
      ? `<span class="ubp-link-thumb"${lk.tint ? ` style="background:${escapeAttr(lk.tint)};color:${escapeAttr(tintInk(lk.tint))}"` : ''}>${escapeHtml(lk.mark)}</span>`
      : '';
    body = `<button type="button" class="ubp-link-card" data-ubp-act="open-link" data-id="${escapeAttr(m.id)}">
      <span class="ubp-link-main">
        <span class="ubp-link-title">${escapeHtml(lk?.title || m.content)}</span>
        ${blurb ? `<span class="ubp-link-preview${lk?.desc ? ' ubp-link-desc' : ''}">${escapeHtml(blurb)}</span>` : ''}
      </span>
      ${thumb}
      <span class="ubp-link-src">${ubpIcon('link')}<b>${escapeHtml(lk?.site || S('网页', '卷宗'))}</b></span>
    </button>`;
  } else if (m.type === 'chatlog') {
    // 合并转发/帖子分享卡片：点击展开查看层（静态只读）；分享卡标题=来源标签
    body = `<button type="button" class="ubp-chatlog-card" data-ubp-act="chatlog-view" data-id="${escapeAttr(m.id)}">
      <span class="ubp-chatlog-icon">${ubpIcon(m.fwdSrc ? 'share' : 'chatlog')}</span>
      <span class="ubp-chatlog-main"><b>${escapeHtml(m.fwdSrc || S('聊天记录', '符讯辑录'))}</b><i>${escapeHtml(m.content)}</i></span>
    </button>`;
  } else {
    body = `<span class="ubp-bubble">${isGroup && groupMembers ? renderTextWithMentions(m.content, groupMembers) : escapeHtml(m.content)}</span>`;
  }
  // 引用卡（我方消息；在昵称与气泡之间，与气泡连成一体）
  const quoteCard = m.quote ? quoteCardHtml(m.quote) : '';
  const col = `<span class="ubp-msg-col">${nameTag}<span class="ubp-msg-meta${quoteCard ? ' has-quote' : ''}">${quoteCard}${body}</span></span>`;
  const check = _selectMode ? `<button type="button" class="ubp-msg-check${_selected.has(m.id) ? ' on' : ''}" tabindex="-1">${_selected.has(m.id) ? '✓' : ''}</button>` : '';
  const cls = `ubp-msg-row${me ? ' me' : ''}${_selectMode ? ' sel' : ''}${_selected.has(m.id) ? ' picked' : ''}`;
  return me
    ? `<div class="${cls}" data-mid="${escapeAttr(m.id)}">${check}${col}${avatar}</div>`
    : `<div class="${cls}" data-mid="${escapeAttr(m.id)}">${check}${avatar}${col}</div>`;
}

/** 聊天记录查看层条目（静态只读：文字/图片引用/语音转写/转账红包卡片）。 */
function renderLogEntry(entry: PhoneLogEntry, meName: string): string {
  const me = entry.from === 'me';
  const who = me ? meName : entry.from;
  let body: string;
  if (entry.type === 'image' && entry.imagePath) {
    body = `<img class="ubp-chatlog-img" src="${escapeAttr(entry.imagePath)}" alt="" loading="lazy">`;
  } else if (entry.type === 'voice') {
    body = `<span class="ubp-chatlog-voice">${ubpIcon('voiceWave')}<span>${escapeHtml(entry.content)}</span></span>`;
  } else if (entry.type === 'transfer' || entry.type === 'redpacket') {
    body = renderMoneyCard({ id: 'log', from: entry.from, type: entry.type, content: entry.content, amount: entry.amount, ts: 0 } as PhoneMessage, me, who);
  } else {
    body = escapeHtml(entry.content);
  }
  return `<div class="ubp-chatlog-row${me ? ' me' : ''}">
    <span class="ubp-chatlog-name">${escapeHtml(who)}</span>
    <div class="ubp-chatlog-bubble">${body}</div>
  </div>`;
}

// ─── 资料卡「音色」行 + 快速换音色面板（docs/59）───
// 与设置页「语音 → 角色音色」**同源**：取值同一支 resolveSenderVoicePlan()、池子同一支 voicePoolFor()、
// 「跟随自动」同一支 autoVoiceOf()、落库同一份 phone-settings（voiceMap / voiceRoleProvider / voiceAutoPick）；
// 试听也与设置页同一支（voicePlanFor + playVoice，连试听词都用同一句 ⇒ 同一把声音跨角色共用一个缓存 key）。
// 纪律：TTS 关 ⇒ 一个节点都不输出；零新增监听/定时器/请求（拉取钮只在某家池子还空着时才出现）。

/** 这一行要显示什么（纯读；不写盘、不发请求）。 */
interface ProfileVoiceInfo {
  /** 当前生效的音色名（池里查不到就显示原始 id；空 = 未指定）。 */
  label: string;
  /** 来源小灰字：`服务商 · 手动/自动/未指定`。 */
  src: string;
  /** 值走灰（未指定态）。 */
  plain: boolean;
  scope: 'system' | 'api';
  providerId: string;
  voiceId: string;
  /** 存着的手动覆盖（可能已失效）。 */
  manualRaw: string;
  /** 这个覆盖**当前真的在生效**（池非空时必须在池内；与设置页「当前生效（手动指定/自动分配）」同一判据）。 */
  manualActive: boolean;
  /** 角色指定的渠道（'' = 跟随全局）。 */
  roleProvider: string;
  pool: VoiceOption[];
}

function profileVoiceInfo(name: string): ProfileVoiceInfo | null {
  const backend = resolveVoiceBackend();
  if (backend === 'off') return null;
  const s = getPhoneSettings() as any;
  const isSystem = backend === 'system';
  const scope: 'system' | 'api' = isSystem ? 'system' : 'api';
  const pick = resolveSenderVoicePlan(name);
  const providerId = isSystem ? 'system' : (pick?.providerId || resolveProvider(s.voiceProvider).id);
  const pool = voicePoolFor(backend, providerId);
  const voiceId = pick?.voiceId || '';
  const manualRaw = String((s.voiceMap?.[scope] || {})[name] || '');
  const manualActive = Boolean(manualRaw) && (!pool.length || pool.some(o => o.id === manualRaw));
  const label = pool.find(o => o.id === voiceId)?.label || voiceId;
  return {
    label: label || S('默认音色（未指定）', '未定音色'),
    src: `${isSystem ? '系统 TTS' : resolveProvider(providerId).name} · ${voiceId ? (manualActive ? S('手动', '亲定') : S('自动', '自定')) : S('未指定', '未定')}`,
    plain: !label,
    scope,
    providerId,
    voiceId,
    manualRaw,
    manualActive,
    roleProvider: isSystem ? '' : roleProviderFor(name, s.voiceRoleProvider || {}),
    pool,
  };
}

/** 「音色」行 markup（与档案行同款：粗体标签 + 值 + 来源小灰字 + 淡箭头；ro = comfy 只读信息行，不接点击）。 */
function voiceRowHtml(name: string, label: string, src: string, opts: { plain?: boolean; ro?: boolean } = {}): string {
  const chev = opts.ro ? '' : `<span class="ubp-voice-chev">${ubpIcon('chevron')}</span>`;
  const act = opts.ro ? '' : ` data-ubp-act="voice-edit" data-id="${escapeAttr(name)}" title="${S('点击更换音色', '点击另择嗓音')}"`;
  return `<div class="ubp-profile-line ubp-voice-row${opts.plain ? ' none' : ''}${opts.ro ? ' ro' : ''}"${act}>`
    + `<b>${S('音色', '嗓音')}</b>　<span class="ubp-voice-val">${escapeHtml(label)}<span class="ubp-voice-src">${escapeHtml(src)}</span></span>${chev}</div>`;
}

/** 资料卡里的音色行：TTS 关 ⇒ ''（一个节点都不输出）；comfy ⇒ 只读参考音频行（音色＝参考音频，换它要传文件）。 */
function profileVoiceRowHtml(name: string): string {
  if (!isVoiceEnabled() || !name) return '';
  const backend = resolveVoiceBackend();
  if (backend === 'comfy') {
    const ref = String((getPhoneSettings() as any).voiceRefAudio?.[name] || '');
    return voiceRowHtml(name, ref ? `参考音频 ${ref}` : '参考音频（工作流内置默认）', S('本地克隆', '本地摹音'), { ro: true });
  }
  const info = profileVoiceInfo(name);
  return info ? voiceRowHtml(name, info.label, info.src, { plain: info.plain }) : '';
}

/** 把拉回来的一页并进这家的音色目录（voiceCatalog，与设置页「音色池」同一份文本格式）：按 id 去重、超上限截尾。
 *  设置页那条是「拉取 → 勾选 → 加入音色池」；这里省掉中间勾选步（面板本来就是挑音色的地方），但**必须落库**——
 *  池子里没有的音色 id 在播放侧会被当成换渠道的遗留值忽略掉（resolveRoleVoice 的校验），不落库就是白选。 */
function mergeFetchedVoices(providerId: string, options: readonly VoiceOption[]): VoiceOption[] {
  const s = getPhoneSettings() as any;
  const cur = parseManualVoices(String((s.voiceCatalog || {})[providerId] || ''));
  const have = new Set(cur.map(o => o.id));
  const fresh = options.filter(o => o.id && !have.has(o.id));
  if (!fresh.length) return [];
  const text = serializeVoicePool([...cur, ...fresh]).slice(0, VOICE_CATALOG_MAX);
  void savePhoneSettings({ voiceCatalog: { ...(s.voiceCatalog || {}), [providerId]: text } });
  return fresh;
}

/** 面板里的「▷ 试听」：试听**面板里翻的那一家**的那个音色（哪怕还没落库），不改任何设置、不关面板。
 *  与设置页「▷ 试听该角色」同一支，试听词也沿用同一句（跨角色共用缓存 key，试听不重复烧 TTS 额度）。 */
function previewVoiceFor(name: string, providerId: string, voiceId: string, el: HTMLElement): void {
  const plan = voicePlanFor('这是一段语音试听，用来确认音色。', name, '', '', {
    ...(providerId && providerId !== 'system' ? { providerId } : {}),
    voiceId,
  });
  if (!plan) { phoneNotify(S('请先把「语音」打开并选好后端', '请先把「口信」打开并选好后端'), S('试听', '听音'), 'warning'); return; }
  if (_voicePreviewBtn && _voicePreviewBtn !== el) _voicePreviewBtn.classList.remove('busy');
  _voicePreviewBtn = el;
  el.classList.add('busy');
  stopVoice(); // 同一时刻只播一条（与设置页试听同一纪律）；系统 TTS 也被它打断
  playVoice({
    backend: plan.backend, cacheKey: plan.cacheKey, text: plan.text,
    voiceId: plan.voiceId, providerId: plan.providerId, refAudio: plan.refAudio, speed: plan.speed,
    emotion: plan.emotion, delivery: plan.delivery, role: plan.role,
    onState: (st, detail) => {
      if (st === 'error' && detail) phoneNotify(detail, S('试听失败', '听音不成'), 'error');
      if (st === 'ended' || st === 'error') {
        el.classList.remove('busy');
        if (_voicePreviewBtn === el) _voicePreviewBtn = null;
      }
    },
  });
}

/** 落库：选中音色（`voiceId=''` = 清掉手动覆盖回到自动）＋（面板里的渠道与当前生效那家不同时）一并写渠道。
 *  换渠道要**连带清掉该角色的自动分配钉住值**——音色 id 按渠道命名，留着会把别家的 id 发过去（设置页
 *  saveVoiceRoleProvider 同一条规矩）；与音色覆盖合并成一次写。 */
function applyVoicePick(name: string, pick: { scope: 'system' | 'api'; browsed: string; committed: string; voiceId: string; label: string }): void {
  const s = getPhoneSettings() as any;
  const nextMap = { system: { ...s.voiceMap.system }, api: { ...s.voiceMap.api } };
  if (pick.voiceId) nextMap[pick.scope][name] = pick.voiceId;
  else delete nextMap[pick.scope][name];
  const patch: Parameters<typeof savePhoneSettings>[0] = { voiceMap: nextMap };
  // 「换渠道」只在**真的换了那一家的池子**时才写：面板里「跟随全局（X）」与「X」这两项解析到同一家，
  // 来回翻一趟再选中不该把角色从「跟随全局」钉成指定厂商（反过来点「跟随全局」要写＝解除指定）。
  const globalId = resolveProvider(s.voiceProvider).id;
  const switched = pick.scope === 'api' && pick.browsed !== pick.committed
    && (pick.browsed === '' || (pick.browsed || globalId) !== (pick.committed || globalId));
  if (switched) {
    const nextP = { ...(s.voiceRoleProvider || {}) };
    if (pick.browsed) nextP[name] = pick.browsed;
    else delete nextP[name]; // '' = 跟随全局
    const nextPin = { ...(s.voiceAutoPick || {}) };
    delete nextPin[name];
    patch.voiceRoleProvider = nextP;
    patch.voiceAutoPick = nextPin;
  }
  void savePhoneSettings(patch).then(() => { render(); });
  if (!_ctx) return;
  const who = switched ? `（${S('渠道', '来路')} → ${resolveProvider(pick.browsed || s.voiceProvider).name}）` : '';
  showScreenToast(_ctx.container, (pick.voiceId ? S(`已固定为「${pick.label}」`, `已定为「${pick.label}」`) : S('已恢复自动分配', '已复随缘')) + who);
}

/** 「渠道」下拉（面板顶部工具条）：跟随全局 + 设置页同一份 VOICE_PROVIDERS 七家。 */
function voiceProviderBarHtml(browsed: string, globalId: string): string {
  const options = [`<option value=""${browsed === '' ? ' selected' : ''}>${S('跟随全局', '随主家')}（${escapeHtml(resolveProvider(globalId).name)}）</option>`]
    .concat(VOICE_PROVIDERS.map(p => `<option value="${escapeAttr(p.id)}"${browsed === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`));
  return `<span class="ubp-tblabel">${S('渠道', '来路')}</span>`
    + `<select class="ubp-select" data-ubp-pk="tb" data-ubp-pk-tb="prov" style="max-width:100%;flex:1;min-width:0;">${options.join('')}</select>`;
}

/** 快速换音色面板：换渠道＝只换下面列哪一家（面板里暂存，取消即丢）；点行＝选中并落库；行尾 ▷＝只试听。 */
function openVoicePickerSheet(name: string): void {
  if (!_ctx || !name) return;
  const backend = resolveVoiceBackend();
  if (backend === 'off' || backend === 'comfy') return; // 没音色可挑（comfy 走参考音频）
  const isSystem = backend === 'system';
  const scope: 'system' | 'api' = isSystem ? 'system' : 'api';
  const globalId = resolveProvider((getPhoneSettings() as any).voiceProvider).id;
  const committed = isSystem ? '' : roleProviderFor(name, (getPhoneSettings() as any).voiceRoleProvider || {});
  let browsed = committed;   // 面板里现在翻的那一家（'' = 跟随全局）
  let fetchedOnce = false;   // 拉过至少一页：按钮语义从「从账号拉取音色列表」变「再拉一页」
  let cursor: string | undefined;
  const gender = bucketGenderOf(contactSourceFor(getRoster(), name));
  const pidOf = (): string => (isSystem ? 'system' : (browsed || globalId));
  const poolOf = (): VoiceOption[] => voicePoolFor(backend, pidOf());
  const providerNameOf = (): string => (isSystem ? '系统 TTS' : resolveProvider(pidOf()).name);
  const manualRawOf = (): string => String(((getPhoneSettings() as any).voiceMap?.[scope] || {})[name] || '');
  const autoIdOf = (pool: readonly VoiceOption[]): string => {
    const s = getPhoneSettings() as any;
    return autoVoiceOf(name, pidOf(), pool, s.voiceAutoPick, gender, s.voiceAutoAssign !== false);
  };
  const playItem = (label: string): { actionHtml: string; actionTitle: string } => ({ actionHtml: ubpIcon('playFill'), actionTitle: `${S('试听', '听音')} ${label}` });

  openPickerSheet(_ctx.container, {
    title: `${S('音色', '嗓音')} · ${name}`,
    searchPlaceholder: S('搜索音色', '寻访嗓音'),
    emptyText: S('这家没有可选的音色', '这家没有可选的嗓音'),
    selected: [manualRawOf()], // ✓ 打在当前取值上（'' = 跟随自动那行）
    /* 渠道只在 api 后端出现（system 后端没有渠道概念：池子就是系统语音） */
    toolbar: isSystem ? undefined : {
      html: () => voiceProviderBarHtml(browsed, globalId) + (browsed === committed ? '' : (() => {
        // 翻的是别家：列表**刻意不打 ✓**（这一家里还没有「当前选项」），改写一句说明
        const info = profileVoiceInfo(name);
        const now = `${resolveProvider(info?.providerId || globalId).name} · ${info?.voiceId ? info.label : S('未指定', '未定')}`;
        return `<div class="ubp-picker-note">${S(`下面列的是「${providerNameOf()}」的池子——点任一音色＝把这个角色改到这家（现在是 ${now}）`,
          `下面列的是「${providerNameOf()}」的嗓音——点任一音色＝把这位改到这家（眼下是 ${now}）`)}</div>`;
      })()),
      onToolbarAct: (_act, el) => {
        const v = String((el as HTMLSelectElement).value ?? '');
        if (v === browsed) return false;
        browsed = v;
        return true; // 换了一家 ⇒ 让面板重取选项（列表整块换掉）
      },
    },
    groups: (): PickerGroup[] => {
      const pool = poolOf();
      const manualRaw = manualRawOf();
      const sameChannel = browsed === committed; // 翻的就是当前生效那家：这时 ✓ 才有意义
      const autoId = autoIdOf(pool);
      const autoLabel = pool.find(o => o.id === autoId)?.label || autoId;
      const groups: PickerGroup[] = [{
        key: 'auto',
        label: '',
        items: [{
          id: '',
          label: autoLabel
            ? S(`跟随自动（自动分配：${autoLabel}）`, `随缘（缘分：${autoLabel}）`)
            : S('跟随自动', '随缘'),
          ...(pool.length ? {} : { sub: S('这家还没有可选音色——先去拉取音色列表 / 粘音色池，或选别家', '这家还没有可选嗓音——先去取回音色名册 / 粘音色池，或另择一家') }),
          ...playItem(S('跟随自动', '随缘')),
        }],
      }];
      // 手填 / 已失效的当前值也补一行：它会真的参与解析，不显示就成了看不见的隐形值
      if (sameChannel && manualRaw && !pool.some(o => o.id === manualRaw)) {
        groups.push({
          key: 'cur',
          label: S('当前', '眼下'),
          items: [{ id: manualRaw, label: manualRaw, sub: S('手动填写（不在音色列表内）', '亲填（不在名册内）'), ...playItem(manualRaw) }],
        });
      }
      // 空池也先建好这一组：拉取回来的结果由 picker 追加进「最后一个分组」（标签里的条数是首次渲染时的）；
      // 池空时这一组顶一格说明（与效果稿同款：有列表接口的家给「从账号拉取」，没有的给指路）
      const pidNow = pidOf();
      groups.push({
        key: 'pool',
        label: pool.length ? `${providerNameOf()}（${pool.length}）` : providerNameOf(),
        items: pool.map(o => ({
          id: o.id,
          label: o.label,
          ...(o.desc ? { sub: o.desc } : {}),
          checked: sameChannel && manualRaw === o.id,
          ...playItem(o.label),
        })),
        ...(pool.length ? {} : {
          emptyHint: hasVoiceFetcher(pidNow)
            ? S('这家的音色池还是空的\n点下面按钮从账号带出音色（拉完就能在这里直接选）', '这家的音色名册还是空的\n点下面按钮从账号取回音色（取回就能在这里直接选）')
            : S(`「${providerNameOf()}」没有公开的音色列表接口\n手填的音色 id 在「设置 → 语音 → 角色音色」里改；\n也可以先填进「后端与接口 → 音色池」，之后就会出现在这里`,
              `「${providerNameOf()}」没有公开的音色名册接口\n手填的音色 id 在「设置 → 语音 → 嗓音」里改；\n也可以先填进「后端与接口 → 音色池」，之后就会出现在这里`),
        }),
      });
      return groups;
    },
    /* 拉取只在这家池子还空着（且这家有列表接口）时出现；拉过之后按游标给「再拉一页」，拉尽收「已到底」 */
    extraAction: {
      label: () => (fetchedOnce ? S('再拉一页', '再取一页') : S('从账号拉取音色列表', '从账号取回音色名册')),
      visible: () => (fetchedOnce ? Boolean(cursor) : (!poolOf().length && hasVoiceFetcher(pidOf()))),
      onAction: async () => {
        const pid = pidOf();
        try {
          const page = await listProviderVoicesPage(pid, undefined, cursor);
          fetchedOnce = true;
          cursor = page.next;
          const fresh = mergeFetchedVoices(pid, page.options);
          return fresh.map(o => ({ id: o.id, label: o.label, ...(o.desc ? { sub: o.desc } : {}), ...playItem(o.label) }));
        } catch (e) {
          phoneNotify(e instanceof Error ? e.message : S('拉取音色失败', '取回音色失败'), S('音色列表', '音色名册'), 'error');
          return [];
        }
      },
    },
    onPick: (id) => {
      const pool = poolOf();
      applyVoicePick(name, {
        scope,
        browsed,
        committed,
        voiceId: id,
        label: pool.find(o => o.id === id)?.label || id,
      });
    },
    onItemAction: (id, el) => previewVoiceFor(name, pidOf(), id || autoIdOf(poolOf()), el),
  });
}

// ─── 覆盖层 ───

/** 覆盖层 HTML（同一渲染帧内已有 data 时传入复用，免二次全量深拷贝）。 */
function renderOverlayHtml(data: ReturnType<typeof readPhoneData> = readPhoneDataRef()): string {
  if (!_overlay) return '';
  switch (_overlay.kind) {
    case 'group-create': {
      const roster = getRoster();
      const friendSet = new Set(data.friends || []);
      // 群聊仅限好友（用户拍板）；自定义联系人成为好友后同样可入群
      const candidates = mergeCustomContacts(roster, data.customContacts || []).filter(c => friendSet.has(c.name));
      const rowsHtml = candidates.map(c => `
        <div class="ubp-pickrow" data-ubp-act="toggle-member" data-id="${escapeAttr(c.name)}">
          <span class="ubp-check${_groupSel.has(c.name) ? ' on' : ''}">${_groupSel.has(c.name) ? '✓' : ''}</span>
          ${avatarHtml(c.name, 'small')}
          <span class="ubp-inline-name">${escapeHtml(c.name)}</span>
        </div>`).join('');
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('发起群聊', '结盟共谈')}</div>
          <input class="ubp-fieldinput" id="ubp-group-title" placeholder="${S('群名（留空自动）', '盟号（留空自动）')}" value="${escapeAttr(_groupTitle)}" style="margin-bottom:8px;">
          <div style="max-height:230px;overflow-y:auto;">${rowsHtml || `<div class="ubp-empty" style="padding:18px;">${S('好友列表为空——先去「通讯录」添加好友', '道友名录为空——先去「道友录」结交道友')}</div>`}</div>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn primary" data-ubp-act="create-group" ${_groupSel.size < 2 ? 'disabled' : ''}>${S('创建', '结盟')}（${_groupSel.size}）</button>
          </div>
        </div>
      </div>`;
    }
    case 'atmo-add': {
      const conv = _chatId ? findConversation(data, _chatId) : null;
      if (!conv || conv.kind !== 'group') return '';
      const remaining = Math.max(0, MAX_ATMOSPHERE_PER_GROUP - (conv.atmosphere || []).length);
      const count = remaining > 0 ? Math.min(Math.max(1, _atmoAddCount), remaining) : 0;
      const stepBtn = (delta: number, disabled: boolean): string =>
        `<button class="ubp-atmo-step" data-ubp-act="atmo-step" data-id="${delta}" ${disabled ? 'disabled' : ''}>${delta < 0 ? '−' : '＋'}</button>`;
      const quick = [5, 10, 20].map(n =>
        `<button class="ubp-atmo-quick-btn${count === n ? ' on' : ''}" data-ubp-act="atmo-quick" data-id="${n}" ${n > remaining ? 'disabled' : ''}>${n}</button>`).join('');
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('添加气氛组', '增补闲谈道友', '增邀捧场朋友', '增邀闲聊同伴')}</div>
          <div class="ubp-sheet-body">
            <div class="ubp-atmo-intro">${S(
              '他们会成为群里的普通群友：计入群人数、可被 @、和普通成员一样发言；不会进入通讯录，也不会单独建会话。',
              '他们会成为盟中的普通道友：计入盟人数、可被 @、和正式盟友一样发言；不会进入名录，也不会单独传讯。',
            )}</div>
            ${remaining > 0 ? `
            <div class="ubp-atmo-stepper">
              ${stepBtn(-1, count <= 1)}
              <input id="ubp-atmo-count" value="${count}" readonly>
              ${stepBtn(1, count >= remaining)}
            </div>
            <div class="ubp-atmo-quick">${quick}</div>
            <div class="ubp-atmo-req">
              <div class="ubp-atmo-req-head">
                <span class="ubp-atmo-req-label">${S('额外要求', '额外要求')} <em>${S('可选', '可选')}</em></span>
                <span class="ubp-atmo-req-count">${_atmoAddRequirement.length}/${MAX_ATMOSPHERE_REQUIREMENT_LEN}</span>
              </div>
              <textarea class="ubp-atmo-req-input" id="ubp-atmo-requirement" maxlength="${MAX_ATMOSPHERE_REQUIREMENT_LEN}" rows="2"
                placeholder="${escapeAttr(S('例如：都是女生，身份要有区分度，性格活泼一点', '例如：都是女修，身份要有区分度，性格活泼一点'))}">${escapeHtml(_atmoAddRequirement)}</textarea>
              <div class="ubp-atmo-req-hint">${S('只用于生成姓名、性别、身份和一句性格，不会出现在聊天里。', '只用于生成姓名、性别、身份和一句性格，不会出现在符讯里。')}</div>
            </div>
            <div class="ubp-atmo-tip" id="ubp-atmo-tip">${_atmoAddRequirement.trim()
              ? S('下一轮聊天时，会按你的额外要求生成姓名、性别、身份和性格。', '下一轮共谈时，会按你的额外要求生成姓名、性别、身份和性格。')
              : S('下一轮聊天时，会顺手生成姓名和一句性格，再让他们参与对话。', '下一轮共谈时，会顺手生成姓名和一句性格，再让他们参与对话。')}</div>` : `<div class="ubp-atmo-tip">${S(`气氛组已达上限 ${MAX_ATMOSPHERE_PER_GROUP} 人。`, `闲谈道友已达上限 ${MAX_ATMOSPHERE_PER_GROUP} 人。`)}</div>`}
          </div>
          <div class="ubp-sheet-actions cols2">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn primary" data-ubp-act="atmo-add-confirm" ${remaining > 0 ? '' : 'disabled'}>${S(`添加 ${count} 位`, `增补 ${count} 位`)}</button>
          </div>
        </div>
      </div>`;
    }
    case 'atmo-profile': {
      const name = _overlay.id || '';
      if (!name) return '';
      const conv = _chatId ? findConversation(data, _chatId) : null;
      const member = conv ? (conv.atmosphere || []).find(a => a.status === 'ready' && a.name === name) : null;
      const personality = member
        ? (member.personality || S('性格未设定', '性格未设', '性格未设', '性格未设'))
        : S('已不在群里', '已不在盟中', '已不在会中', '已不在桌旁');
      const meta = member
        ? ([member.gender, member.identity].filter(Boolean).join(' · ') || S('资料未补全', '资料未补全', '资料未补全', '资料未补全'))
        : '';
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-atmo-profile">
            ${avatarHtml(name)}
            <div class="ubp-atmo-profile-name">${escapeHtml(name)} <em class="ubp-atmo-tag">${S('群友', '旁听', '捧场', '同伴')}</em></div>
            ${meta ? `<div class="ubp-atmo-profile-meta">${escapeHtml(meta)}</div>` : ''}
            <div class="ubp-atmo-profile-desc">${escapeHtml(personality)}</div>
          </div>
          <div class="ubp-sheet-actions"><button class="ubp-btn" data-ubp-act="overlay-close">${S('关闭', '关闭')}</button></div>
        </div>
      </div>`;
    }
    case 'profile': {
      const name = _overlay.name || '';
      const roster = getRoster();
      const contact = findContact(roster, name);
      const present = roster.present[name];
      const isFri = isFriend(data, name);
      // 自定义联系人=数据库无记录且在自定义名单中（数据库收录同名后自动让位，删除入口随之消失）
      const isCustom = !contact && isCustomContact(data, name);
      const lines: string[] = [];
      if (contact?.brief || contact?.identity) lines.push(`<div class="ubp-profile-line"><b>身份</b>　${escapeHtml(contact.identity || contact.brief)}</div>`);
      if (contact?.gender || contact?.age) lines.push(`<div class="ubp-profile-line"><b>资料</b>　${escapeHtml([contact.gender, contact.age].filter(Boolean).join(' · '))}</div>`);
      if (contact?.languageStyle) lines.push(`<div class="ubp-profile-line"><b>语言风格</b>　${escapeHtml(contact.languageStyle)}</div>`);
      if (contact?.attitude) lines.push(`<div class="ubp-profile-line"><b>对主角态度</b>　${escapeHtml(contact.attitude)}</div>`);
      if (present?.status || present?.emotion) lines.push(`<div class="ubp-profile-line"><b>当前</b>　${escapeHtml([present.status, present.emotion && `情绪：${present.emotion}`].filter(Boolean).join(' · '))}</div>`);
      // 备注行（本轮新增）：与上面几行同款——常态一行字（没写过＝「无」），点它才整行换输入框，
      // 行内右侧小对勾＝保存并退出编辑。数据随本聊天存档（data.characterNotes）。
      const noteLabel = S('备注', '手记');
      const note = characterNoteOf(data, name);
      // 音色行（docs/59）：TTS 关 ⇒ ''（一个节点都不输出）；接在档案行之后、备注之前
      const voiceRow = profileVoiceRowHtml(name);
      const noteRow = _noteEditing === name
        ? `<div class="ubp-profile-line ubp-note-edit"><b>${noteLabel}</b><input class="ubp-note-inline" id="ubp-note-input" maxlength="${MAX_CHARACTER_NOTE_LEN}" value="${escapeAttr(note)}" placeholder="${S('记一点怕忘的事…', '记一点怕忘的事…')}"><button type="button" class="ubp-note-ok" data-ubp-act="note-save" data-id="${escapeAttr(name)}" title="${S('保存备注', '存下手记')}">${ubpIcon('check')}</button></div>`
        : `<div class="ubp-profile-line ubp-note-row" data-ubp-act="note-edit" data-id="${escapeAttr(name)}" title="${S('点击编辑备注', '点击写下手记')}"><b>${noteLabel}</b>　${note ? escapeHtml(note) : '无'}</div>`;
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-profile">
            <div class="ubp-profile-head">
              ${avatarHtml(name)}
              <span><span class="ubp-profile-name">${escapeHtml(name)}</span><span class="ubp-profile-tag">${contact?.category === 'romance' ? '恋爱对象' : contact ? '重要角色' : S('自定义角色', '自识道友', '自识人物', '自识同伴')}</span>${isFri ? '' : `<span class="ubp-profile-tag" style="color:var(--ubp-text-3);background:var(--ubp-card-2);">${S('非好友', '未结交')}</span>`}</span>
            </div>
            ${lines.join('') || `<div class="ubp-profile-line">${isCustom ? S('数据库暂无档案——表现以世界书与角色卡为准', '数据库暂无档案——表现以群书与心法为准') : '数据库暂无详细档案'}</div>`}
            ${voiceRow}
            ${noteRow}
          </div>
          <div class="ubp-sheet-actions cols2">
            <button class="ubp-btn" data-ubp-act="edit-avatar" data-id="${escapeAttr(name)}">${S('更换头像', '更换头像')}</button>
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('关闭', '关闭')}</button>
          </div>
          <div class="ubp-sheet-actions stack">
            ${isFri
              ? `<button class="ubp-btn primary" data-ubp-act="start-chat" data-id="${escapeAttr(name)}">${S('发消息', '传符讯')}</button>`
              : `<button class="ubp-btn" data-ubp-act="add-friend" data-id="${escapeAttr(name)}">${S('加为好友', '直接结交', '直接结拜', '直接同行')}</button>
                 <button class="ubp-btn primary" data-ubp-act="start-chat" data-id="${escapeAttr(name)}">${S('发送申请', '递名帖')}</button>`}
          </div>
          ${isCustom ? `<div class="ubp-sheet-actions"><button class="ubp-btn danger" data-ubp-act="del-contact" data-id="${escapeAttr(name)}">${S('删除联系人', '删去此人')}</button></div>` : ''}
        </div>
      </div>`;
    }
    case 'menu': {
      const conv = _chatId ? findConversation(data, _chatId) : null;
      if (!conv) return '';
      if (conv.kind === 'group') {
        // 群管理：改名 + 成员增删（变动落微信式系统消息进聊天流，AI 可见）
        // 成员行＝资料卡入口（本轮新增）：整行可点（名字后一枚淡箭头作提示）；「移出」钮自带动作，
        // 点它时 closest 命中的是按钮本身，不会连带开卡。
        const memberRows = conv.members.map(name => `
          <div class="ubp-gm-member" data-ubp-act="show-profile" data-id="${escapeAttr(name)}" title="${S('查看资料', '查看档案')}">
            ${avatarHtml(name, 'small')}
            <span class="ubp-gm-mname">${escapeHtml(name)}</span>
            <span class="ubp-gm-chev">${ubpIcon('chevron')}</span>
            <button class="ubp-gm-remove" data-ubp-act="remove-member" data-id="${escapeAttr(name)}" ${conv.members.length <= 1 ? 'disabled' : ''} title="${S('移出群聊', '请出道盟')}">${S('移出', '请出')}</button>
          </div>`).join('');
        const atmoReady = readyAtmosphereMembers(conv);
        const atmoPending = pendingAtmosphere(conv);
        const atmoTotal = atmoReady.length + atmoPending.length;
        const atmoRows = atmoReady.map(a => {
          const meta = [a.gender, a.identity].filter(Boolean).join(' · ')
            || S('资料未补全', '资料未补全', '资料未补全', '资料未补全');
          return `
          <div class="ubp-gm-member" data-ubp-act="show-atmo-profile" data-id="${escapeAttr(a.name)}" title="${S('查看资料', '查看档案')}">
            ${avatarHtml(a.name, 'small')}
            <span class="ubp-gm-main">
              <span class="ubp-gm-mname">${escapeHtml(a.name)} <em class="ubp-atmo-tag">${S('群友', '旁听', '捧场', '同伴')}</em></span>
              <span class="ubp-gm-meta">${escapeHtml(meta)}</span>
              <span class="ubp-gm-sub">${escapeHtml(a.personality || S('性格未设定', '性格未设', '性格未设', '性格未设'))}</span>
            </span>
            <span class="ubp-gm-chev">${ubpIcon('chevron')}</span>
            <button class="ubp-gm-remove" data-ubp-act="atmo-remove" data-id="${escapeAttr(a.id)}" title="${S('移出气氛组', '请出闲谈道友')}">${S('移出', '请出')}</button>
          </div>`;
        }).join('');
        const reqBatches = pendingAtmosphereBatches(conv).filter(b => b.requirement);
        const reqSummary = reqBatches.length
          ? `要求：${reqBatches.length === 1
            ? reqBatches[0].requirement
            : reqBatches.map(b => `${b.count} 位「${b.requirement}」`).join('；')}`
          : S('下一轮聊天时顺手生成姓名、性别、身份与性格', '下一轮共谈时顺手生成姓名、性别、身份与性格');
        const pendingHtml = atmoPending.length ? `
          <div class="ubp-atmo-pending">
            <span class="ubp-atmo-stack">${atmoPending.slice(0, 4).map(() => '<i>?</i>').join('')}</span>
            <span class="ubp-atmo-pending-main">
              <b>${atmoPending.length} ${S('位群友待生成', '位道友待生成', '位朋友待生成', '位同伴待生成')}</b>
              <em title="${escapeAttr(reqSummary)}">${escapeHtml(reqSummary)}</em>
            </span>
            <button class="ubp-atmo-clear" data-ubp-act="atmo-clear-pending">${S('清空', '清去')}</button>
          </div>` : '';
        return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
          <div class="ubp-sheet" data-ubp-stop="1">
            <div class="ubp-sheet-title">${escapeHtml(conv.title)}</div>
            <div class="ubp-sheet-body">
              <div class="ubp-gm-sec">${S('群名', '盟号')}</div>
              <div class="ubp-gm-rename">
                <input class="ubp-fieldinput" id="ubp-group-name" maxlength="40" value="${escapeAttr(_renameDraft || conv.title)}">
                <button class="ubp-btn" data-ubp-act="rename-group" id="ubp-rename-btn">${S('保存', '存录')}</button>
              </div>
              <div class="ubp-gm-count">
                <span><b>${S('群人数', '盟人数', '会人数', '桌人数')}</b>　${groupPeopleCount(conv)} ${S('人（含你）', '人（含你）')}</span>
                <span class="ubp-gm-count-break">${conv.members.length} ${S('正式', '盟友', '同道', '同仁')} + ${atmoTotal} ${S('气氛', '闲谈', '捧场', '闲聊')} + ${S('你', '你')}</span>
              </div>
              <div class="ubp-gm-sec">${S('群成员', '盟友')}（${conv.members.length}）<button class="ubp-gm-add" data-ubp-act="add-member">＋ ${S('添加', '增补')}</button></div>
              <div style="max-height:180px;overflow-y:auto;">${memberRows}</div>
              <div class="ubp-gm-sec">${S('气氛组', '闲谈道友', '捧场朋友', '闲聊同伴')}（${atmoTotal}）<button class="ubp-gm-add" data-ubp-act="atmo-add">＋ ${S('批量添加', '批量增补')}</button></div>
              <div class="ubp-atmo-note">${S('只在群里陪聊 · 不进通讯录 · 不单独建会话', '只在盟中闲谈 · 不进名录 · 不单独传讯', '只在会中捧场 · 不进名帖 · 不单独修书', '只在桌旁闲聊 · 不进名录 · 不单独通讯')}</div>
              ${pendingHtml}${atmoRows}
              <div class="ubp-profile-line" style="margin-top:10px;"><b>${S('消息数', '符讯数')}</b>　${conv.messages.length} ${S('条', '道')}</div>
            </div>
            <div class="ubp-sheet-actions cols2">
              <button class="ubp-btn" data-ubp-act="group-avatar" data-id="${escapeAttr(conv.id)}">${S('群头像', '盟头像')}</button>
              <button class="ubp-btn" data-ubp-act="chat-bg" data-id="${escapeAttr(conv.id)}">${S('更换聊天背景', '更换符纸底纹', '更换信笺底纹', '更换晶讯信笺')}</button>
            </div>
            <div class="ubp-sheet-actions stack">
              <button class="ubp-btn" data-ubp-act="chat-search">${S('查找聊天记录', '翻检符讯', '翻检书信', '翻检晶讯')}</button>
              <button class="ubp-btn danger" data-ubp-act="confirm-clear">${S('清空记录', '焚毁记录')}</button>
              <button class="ubp-btn" data-ubp-act="overlay-close">${S('关闭', '关闭')}</button>
            </div>
          </div>
        </div>`;
      }
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${escapeHtml(conv.title)}</div>
          <div class="ubp-sheet-body">
            <div class="ubp-profile-line"><b>${S('消息数', '符讯数')}</b>　${conv.messages.length} ${S('条', '道')}</div>
            ${_chatIsFriend ? '' : `<div class="ubp-profile-line" style="margin-top:6px;"><b>${S('状态', '状态')}</b>　${S('还不是好友——发送申请等对方通过', '尚未结交——递上名帖静候对方应允', '还不是故人——递上拜帖静候对方应下', '还未同行——递上荐书静候对方应允')}</div>`}
          </div>
          <div class="ubp-sheet-actions stack">
            <button class="ubp-btn" data-ubp-act="chat-search">${S('查找聊天记录', '翻检符讯', '翻检书信', '翻检晶讯')}</button>
            <button class="ubp-btn" data-ubp-act="chat-bg" data-id="${escapeAttr(conv.id)}">${S('更换聊天背景', '更换符纸底纹', '更换信笺底纹', '更换晶讯信笺')}</button>
            <button class="ubp-btn danger" data-ubp-act="confirm-clear">${S('清空记录', '焚毁记录')}</button>
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('关闭', '关闭')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'chatlog-view': {
      const conv = _chatId ? findConversation(data, _chatId) : null;
      const msg = conv?.messages.find(mm => mm.id === (_overlay?.id || ''));
      const entries = msg?.log || [];
      const roster = getRoster();
      const meName = roster.protagonistName || roster.userName || '我';
      const rowsHtml = entries.map(e => renderLogEntry(e, meName)).join('');
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${escapeHtml(msg?.fwdSrc || S('聊天记录', '符讯辑录'))}</div>
          <div class="ubp-chatlog-view" style="max-height:52vh;overflow-y:auto;">${rowsHtml || `<div class="ubp-hint" style="padding:14px 0;">${S('记录为空', '辑录为空')}</div>`}</div>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('关闭', '关闭')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'delete-conv': {
      const conv = data.conversations.find(c => c.id === (_overlay?.id || ''));
      if (!conv) return '';
      const isGroup = conv.kind === 'group';
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${isGroup ? S('解散并删除群聊？', '散盟并删去共谈？') : S('删除聊天？', '删去符讯往来？', '删去书信往来？', '删除晶讯往来？')}</div>
          <div class="ubp-sheet-body">将删除「${escapeHtml(conv.title)}」的${S('全部聊天记录', '全部往来符讯')}，不可恢复。${isGroup ? '' : S('好友关系会保留，之后可以重新发起聊天。', '道友情谊仍续，之后可再启传讯。', '故人情谊仍续，之后可再修书往来。', '同伴情谊仍续，之后可再通讯息。')}</div>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn danger" data-ubp-act="del-conv-confirm">${S('删除', '删去')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'img-send': {
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('发送照片', '送出留影', '送出写真', '送出记影')}</div>
          ${shotFormHtml({ selected: _imgSendSelected, locationId: _imgSendLocId, locations: _imgSendLocs, locationsLoaded: _imgSendLocLoaded, desc: _imgSendDesc, useRefStoryContext: _imgSendUseCtx })}
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn primary" data-ubp-act="img-send-confirm" ${_imgSendDesc.trim().length >= 5 ? '' : 'disabled'}>${S('发送', '送出')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'voice-send': {
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('发送语音', '送出传音', '送出口信', '送出回声')}</div>
          <textarea class="ubp-textarea" id="ubp-voice-text" placeholder="${S('语音内容', '传音内容', '口信内容', '回声内容')}">${escapeHtml(_voiceText)}</textarea>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn primary" data-ubp-act="voice-confirm" ${_voiceText.trim() ? '' : 'disabled'}>${S('发送', '送出')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'transfer-send':
    case 'redpacket-send': {
      const isRedpacket = _overlay.kind === 'redpacket-send';
      // 货币联动：余额卡 + 币种 chips（选择随消息记账）。
      // L15（用户定稿）：**超出所选币种余额直接阻止**——发送键禁用 + 余额卡切 danger 变体（卡内一行差额）；
      // 只拦玩家手操付款；正文/剧情/AI 侧欠款照旧（世界书约束不变）。
      const link = isCurrencyLinkActive();
      const payList = payCurrencyList();
      const chosen = link ? (payList.find(c => c.name === _moneyCurrency) || payCommon()) : null;
      const moneyParsed = parseAmountNote(`${_moneyAmount}|`);
      const moneyOver = moneyOverflow(chosen, moneyParsed);
      // 余额卡：唯一显示余额的地方（多币种时 chips 只留币名，不再两处各念一遍）
      const balRow = chosen ? moneyBalCardHtml(chosen, moneyOver) : '';
      const curChips = chosen && payList.length > 1
        ? `<div class="ubp-money-curchips">${payList.map(c => `<button type="button" class="ubp-money-chip${c.name === chosen.name ? ' on' : ''}" data-ubp-act="money-cur" data-id="${escapeAttr(c.name)}">${currencyIconSvg(c.icon, 13)}${escapeHtml(c.name)}</button>`).join('')}</div>`
        : '';
      const amountPlaceholder = chosen ? `${S('金额', '数目')}（${chosen.name}）` : S('金额（元）', '灵石数目', '银两数目', '金币数目');
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${isRedpacket ? S('发红包', '赠福袋') : S('转账', '转让灵石')}</div>
          ${balRow}${curChips}
          <input class="ubp-fieldinput${moneyOver !== null && chosen ? ' ubp-money-amt-over' : ''}" id="ubp-money-amount" type="text" inputmode="decimal" placeholder="${amountPlaceholder}" value="${escapeAttr(_moneyAmount)}" style="margin-bottom:8px;">
          <input class="ubp-fieldinput" id="ubp-money-note" type="text" maxlength="50" placeholder="${isRedpacket ? S('祝福语（如：生日快乐）', '祝词（如：生辰之喜）', '祝词（如：生辰之喜）', '祝福语（如：诞辰之喜）') : S('转账留言（可空）', '转让附言（可空）', '汇兑附言（可空）', '赠言（可空）')}" value="${escapeAttr(_moneyNote)}">
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn primary" data-ubp-act="money-confirm" data-id="${isRedpacket ? 'redpacket' : 'transfer'}" ${moneyParsed && moneyOver === null ? '' : 'disabled'}>${S('发送', '送出')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'confirm-clear': {
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('清空聊天记录？', '焚毁全部符讯？')}</div>
          <div class="ubp-sheet-body">${S('将删除本会话的全部消息，不可恢复。', '将焚去本会话的全部符讯，不可挽回。', '将焚去本会话的全部书信，不可挽回。', '将烧去本会话的全部晶讯，无法挽回。')}</div>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn danger" data-ubp-act="clear-confirm">${S('清空', '焚毁')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'add-contact': {
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('添加好友', '结交道友', '结识人物', '结识同伴')}</div>
          <input class="ubp-fieldinput" id="ubp-add-name" maxlength="60" placeholder="${S('角色姓名（数据库外的新朋友）', '角色名讳（名录外的新识）')}" value="${escapeAttr(_addName)}" style="margin-bottom:8px;">
          <textarea class="ubp-textarea" id="ubp-add-reason" placeholder="${S('好友申请内容（附上理由，对方将决定通过或拒绝）', '名帖缘由（附结交缘由，对方将定应允或婉拒）')}">${escapeHtml(_addReason)}</textarea>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn primary" data-ubp-act="add-contact-confirm" ${_addName.trim() ? '' : 'disabled'}>${S('发送申请', '递上名帖')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'delete-contact': {
      const name = _overlay?.name || '';
      if (!name) return '';
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('删除联系人？', '删去此人？')}</div>
          <div class="ubp-sheet-body">${S(`将删除「${escapeHtml(name)}」并清除与TA的全部聊天记录与好友关系，不可恢复。`, `将删去「${escapeHtml(name)}」并清除与其全部往来符讯与道友情谊，不可挽回。`)}</div>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn danger" data-ubp-act="del-contact-confirm">${S('删除', '删去')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'msg-edit': {
      const conv = currentConversation();
      const msg = conv?.messages.find(mm => mm.id === _overlay?.id);
      if (!msg) return '';
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('编辑消息', '改写符讯', '改写书信', '改写晶讯')}</div>
          <textarea class="ubp-textarea" id="ubp-msg-edit-text">${escapeHtml(_editDraft)}</textarea>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn primary" data-ubp-act="msg-edit-save" ${_editDraft.trim() ? '' : 'disabled'}>${S('保存', '存定')}</button>
          </div>
        </div>
      </div>`;
    }
    case 'memo-delete': {
      const title = _overlay?.name || '';
      if (!title) return '';
      return `<div class="ubp-overlay" data-ubp-act="overlay-bg">
        <div class="ubp-sheet" data-ubp-stop="1">
          <div class="ubp-sheet-title">${S('删除备忘记录？', '焚去手札记录？')}</div>
          <div class="ubp-sheet-body">${S(`将删除这条备忘记录，并从主项目备忘录表删去同名条目「${escapeHtml(title)}」。不可恢复。`, `将焚去这条手札记录，并从主项目手札一表删去同名条目「${escapeHtml(title)}」。不可挽回。`)}</div>
          <div class="ubp-sheet-actions">
            <button class="ubp-btn" data-ubp-act="overlay-close">${S('取消', '作罢')}</button>
            <button class="ubp-btn danger" data-ubp-act="memo-del-confirm">${S('删除', '焚去')}</button>
          </div>
        </div>
      </div>`;
    }
    default:
      return '';
  }
}

// ─── 行为 ───

function handleClick(event: Event): void {
  const target = event.target as HTMLElement;
  // 长按刚触发后的残留 click 吞掉（防多选首条被立即翻转/会话被立即打开）；
  // 长按菜单自身不受此限（用户可能长按后立刻点菜单项 / 点遮罩关闭）
  if (!target.closest('.ubp-wx-menu, .ubp-wx-menu-veil, .ubp-wx-cmenu, .ubp-wx-cmenu-veil') && Date.now() - _longPressFiredAt < 600) return;
  // 多选模式：一切消息内交互（点图/播语音/重生成）都改走勾选；仅顶栏/操作条动作放行
  // （弹层打开时放行：编辑弹窗等模态层的保存/取消走正常分派，否则被多选路由吞掉；
  //  统一动作面板 .ubp-actionsheet 同样放行——破坏性确认弹在该层上，不能被多选路由吃掉）
  if (_selectMode && _view === 'chat' && !_overlay && !target.closest('.ubp-actionsheet')) {
    handleSelectClick(target);
    return;
  }
  const stop = target.closest('[data-ubp-stop]');
  const el = target.closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  if (stop && act === 'overlay-bg') return; // 点在弹层内容内不关闭
  const id = el.dataset.id || '';
  // 资料卡备注编辑态：点「备注行」以外的任何地方＝先退出编辑（不保存，回到原值），再照常执行被点的动作。
  // 与效果稿同款：不点小对勾就走人＝放弃这次输入；关卡片/切会话另有清空点（见 overlay-close / enterConversation）。
  if (_noteEditing && _overlay?.kind === 'profile' && !target.closest('.ubp-note-edit')) {
    _noteEditing = null;
    render();
  }
  switch (act) {
    case 'tab': _tab = id === 'contacts' ? 'contacts' : 'sessions'; _view = _tab; _searchQuery = ''; _contactQuery = ''; render(); break;
    case 'open-conv': openConversation(id); break;
    // 会话长按菜单（真机微信式贴行弹框）
    case 'conv-menu-close': closeConvMenu(); break;
    case 'conv-pin': {
      const conv = readPhoneDataSafe().conversations.find(c => c.id === id);
      if (conv) { closeConvMenu(); setConvPinned(id, !conv.pinned); }
      break;
    }
    case 'conv-unread': closeConvMenu(); markConvUnread(id); break;
    case 'conv-del': closeConvMenu(); _overlay = { kind: 'delete-conv', id }; render(); break;
    case 'show-profile': {
      // 从群管理点成员行进资料卡：记下「来路」，关闭时回群管理（其它来路关闭＝回聊天）
      _noteEditing = null;
      _profileBack = _overlay?.kind === 'menu' ? 'menu' : null;
      _overlay = { kind: 'profile', name: id };
      render();
      break;
    }
    // 资料卡备注：点行＝进编辑态（焦点/光标落到输入框末尾）；点小对勾＝保存并退出编辑
    case 'note-edit': {
      _noteEditing = id;
      render();
      const noteBox = _ctx?.container.querySelector('#ubp-note-input') as HTMLInputElement | null;
      if (noteBox) {
        noteBox.focus();
        try { noteBox.setSelectionRange(noteBox.value.length, noteBox.value.length); } catch (_e) { /* ignore */ }
      }
      break;
    }
    // 资料卡「音色」行：点开快速换音色面板（资料卡留在下面不关，面板是后放的兄弟节点）
    case 'voice-edit': openVoicePickerSheet(id); break;
    case 'note-save': {
      const noteBox = _ctx?.container.querySelector('#ubp-note-input') as HTMLInputElement | null;
      const text = noteBox ? noteBox.value : '';
      _noteEditing = null;
      setCharacterNote(id, text);
      render();
      if (_ctx) showScreenToast(_ctx.container, text.trim() ? S('备注已保存', '手记已存下') : S('备注已清空', '手记已抹去'));
      break;
    }
    case 'start-chat': _overlay = null; startPrivateChat(id); break;
    case 'add-friend': applyAddFriendDirect(id); break;
    case 'wx-plus': openWxPlusMenu(); break;
    case 'new-group': openGroupCreateSheet(); break;
    case 'toggle-member': {
      // 原地更新勾选态，不整体重渲染——否则弹层滚动条每次都被重置回顶部
      if (_groupSel.has(id)) _groupSel.delete(id);
      else _groupSel.add(id); // 无人数上限（绿灯侧靠随机5人限流兜 token）
      const check = el.querySelector('.ubp-check');
      if (check) {
        const on = _groupSel.has(id);
        check.classList.toggle('on', on);
        check.textContent = on ? '✓' : '';
      }
      const createBtn = _ctx?.container.querySelector('[data-ubp-act="create-group"]') as HTMLButtonElement | null;
      if (createBtn) {
        createBtn.disabled = _groupSel.size < 2;
        createBtn.textContent = `${S('创建', '结盟')}（${_groupSel.size}）`;
      }
      break;
    }
    case 'create-group': createGroup(); break;
    case 'open-link': {
      // 链接卡 → 浏览器那一页（第十一轮）：登记一次性页面深链再 openApp（browser 在 mount 首帧消费）。
      // 页面在不在由浏览器侧裁决（历史可被清空/顶掉）——这里只把定位信息（qid/idx + url/标题）交出去。
      const msg = currentConversation()?.messages.find(x => x.id === id);
      const lk = msg?.link;
      if (!lk) break;
      setPendingAppPage('browser', {
        qid: lk.qid || '',
        idx: typeof lk.idx === 'number' ? lk.idx : -1,
        url: lk.url || '',
        title: lk.title || msg?.content || '',
      });
      _ctx?.openApp('browser');
      break;
    }
    case 'back': _view = 'sessions'; _chatId = null; _pendingQuote = null; _chatSearchOpen = false; _chatSearchQuery = ''; exitSelectMode(); render(); break;
    case 'chat-menu': _renameDraft = currentConversation()?.title || ''; _overlay = { kind: 'menu' }; render(); break;
    case 'chat-search': _overlay = null; _chatSearchOpen = true; _chatSearchQuery = ''; render(); break;
    case 'chat-search-close': _chatSearchOpen = false; _chatSearchQuery = ''; _searchReturn = true; render(); break;
    case 'search-jump': {
      // 会话列表搜索的「聊天记录」命中：进该会话并把该条滚到视口中央（与聊天内搜索同一跳转口径）
      const convId = el.dataset.id || '';
      const mid = el.dataset.mid || '';
      if (!convId || !mid) break;
      // L9 成就：微信搜索是实时过滤（无提交动作）——以「点中结果」作为一次检索完成的代理口径
      emitAch('phone_search_performed', { scope: 'wechat' });
      enterConversation(convId);
      _scrollToMid = mid;
      render();
      emitPhoneEvent('ubp-phone:data-changed'); // 进入会话=已读，悬浮球即时熄灭
      break;
    }
    case 'chat-search-jump': {
      // 点搜索结果=回聊天并把该条滚到视口中央（不做高亮/上下条导航，真机微信同款）
      const mid = el.dataset.mid || '';
      if (!mid) break;
      // L9 成就：会话内搜索同理，以「点中结果」为一次检索完成的代理口径
      emitAch('phone_search_performed', { scope: 'wechat' });
      _chatSearchOpen = false;
      _chatSearchQuery = '';
      _scrollToMid = mid;
      _searchReturn = true;
      render();
      break;
    }
    // 长按消息菜单（WeChat 式气泡菜单）
    case 'msg-menu-close': closeMsgMenu(); break;
    case 'msg-copy': copyMessage(id); break;
    case 'msg-forward': forwardSingle(id); break;
    case 'msg-quote': quoteSingle(id); break;
    case 'msg-edit': editSingle(id); break;
    case 'msg-del': confirmDeleteSingle(id); break;
    case 'msg-multi': multiSelectSingle(id); break;
    case 'msg-vfav': void toggleVoiceFavorite(id); break;
    case 'msg-fav': toggleWechatFavorite(id); break;
    case 'fav-filter': _favFilter = (['text', 'image', 'voice', 'card'].includes(id) ? id : '') as '' | WeChatFavoriteType; render(); break;
    case 'fav-jump': favJump(id); break;
    case 'fav-play': toggleFavPlay(id); break;
    case 'fav-menu': openFavsMenu(); break;
    case 'fav-del': confirmDeleteFav(id); break;
    case 'msg-vdown': void downloadMessageVoice(id); break;
    case 'msg-vrate-1':
    case 'msg-vrate-15':
    case 'msg-vrate-2': {
      const rate = act === 'msg-vrate-15' ? 1.5 : act === 'msg-vrate-2' ? 2 : 1;
      void savePhoneSettings({ voiceSpeed: rate });
      closeMsgMenu();
      break;
    }
    case 'confirm-clear': _overlay = { kind: 'confirm-clear' }; render(); break;
    case 'clear-confirm': clearConversation(); break;
    case 'rename-group': renameGroup(); break;
    case 'remove-member': confirmRemoveMember(id); break;
    case 'add-member': openAddMemberPicker(); break;
    case 'atmo-add': openAtmosphereAddSheet(); break;
    case 'atmo-step': {
      const conv = currentConversation();
      if (!conv || conv.kind !== 'group') return;
      const remaining = Math.max(0, MAX_ATMOSPHERE_PER_GROUP - (conv.atmosphere || []).length);
      const delta = Number(id) || 0;
      _atmoAddCount = Math.max(1, Math.min(Math.max(1, remaining), _atmoAddCount + delta));
      render();
      break;
    }
    case 'atmo-quick': {
      const conv = currentConversation();
      if (!conv || conv.kind !== 'group') return;
      const remaining = Math.max(0, MAX_ATMOSPHERE_PER_GROUP - (conv.atmosphere || []).length);
      _atmoAddCount = Math.max(1, Math.min(Math.max(1, remaining), Number(id) || 10));
      render();
      break;
    }
    case 'atmo-add-confirm': addAtmosphereBatch(); break;
    case 'atmo-remove': removeAtmosphereEntry(id); break;
    case 'atmo-clear-pending': clearPendingAtmosphere(); break;
    case 'show-atmo-profile':
      _profileBack = _overlay?.kind === 'menu' ? 'menu' : null;
      _overlay = { kind: 'atmo-profile', id };
      render();
      break;
    case 'del-conv-confirm': deleteConversation(); break;
    case 'memo-del-confirm': void confirmMemoDelete(); break;
    case 'add-contact': openAddContactSheet(); break;
    case 'add-contact-confirm': submitAddContact(); break;
    case 'msg-edit-save': submitMessageEdit(); break;
    case 'del-contact': _overlay = { kind: 'delete-contact', name: id }; render(); break;
    case 'del-contact-confirm': deleteCustomContact(); break;
    case 'chatlog-view': _overlay = { kind: 'chatlog-view', id }; render(); break;
    case 'overlay-bg':
    case 'overlay-close': {
      _noteEditing = null;
      const back = _profileBack; // 从群管理进的资料卡：关掉回群管理（一次性，随即清空）
      _profileBack = null;
      _overlay = back === 'menu' ? { kind: 'menu' } : null;
      render();
      break;
    }
    case 'lightbox': {
      openPhoneLightbox(_ctx?.container, { paths: [id] });
      break;
    }
    case 'send': handleSend(); break;
    case 'quote-cancel': _pendingQuote = null; render(); break;
    case 'trigger': void handleTrigger(); break;
    case 'batch-hint': openBatchHint(); break;
    case 'plus': _plusOpen = !_plusOpen; render(); break;
    case 'pick-album': _plusOpen = false; openWechatAlbumPicker(); break;
    case 'send-image':
      _plusOpen = false;
      _imgSendDesc = ''; _imgSendSelected = []; _imgSendLocId = ''; _imgSendUseCtx = false; _imgSendLocs = []; _imgSendLocLoaded = false;
      _overlay = { kind: 'img-send' };
      render();
      break;
    case 'send-voice': _plusOpen = false; _voiceText = ''; _overlay = { kind: 'voice-send' }; render(); break;
    case 'send-transfer': _plusOpen = false; _moneyAmount = ''; _moneyNote = ''; _moneyCurrency = ''; _overlay = { kind: 'transfer-send' }; render(); break;
    case 'send-redpacket': _plusOpen = false; _moneyAmount = ''; _moneyNote = ''; _moneyCurrency = ''; _overlay = { kind: 'redpacket-send' }; render(); break;
    case 'voice-confirm': handleSendVoice(); break;
    case 'money-confirm': handleSendMoney(id === 'redpacket' ? 'redpacket' : 'transfer'); break;
    case 'money-cur': _moneyCurrency = id; render(); break;
    case 'rp-claim': void claimRedpacket(id); break;
    case 'mention-pick': insertMention(id); break;
    case 'abort-gen':
      if (_chatId) {
        _revealAbortConvs.add(_chatId);
        abortPhoneGeneration(_chatId); // 只终止本会话，别的会话生成不受影响
      }
      break;
    case 'edit-avatar':
      if (_ctx && id) openAvatarPickerSheet(_ctx.container, id, { onChanged: () => render() });
      break;
    case 'chat-bg': {
      const conv = currentConversation();
      if (_ctx && conv) {
        const container = _ctx.container;
        const key = conv.id;
        const current = readChatBg(key);
        _overlay = null;
        render(); // 先收掉 ⋯ 菜单弹层，再叠自挂载选图弹层
        openImagePickerSheet(container, {
          mode: 'setting',
          title: `更换聊天背景 · ${conv.title}`,
          portraitName: conv.kind === 'private' ? conv.members[0] : undefined,
          crop: { ratio: 0.52, slot: `bg:${key}`, kind: 'bg', title: '聊天背景' },
          current,
          currentText: '当前背景',
          defaultText: '默认微信底纹',
          pickTip: '设为背景',
          onPick: img => { setChatBg(key, img.path); render(); },
          onImport: path => { setChatBg(key, path); render(); },
          onCropAdjusted: () => render(),
          ...(current ? { onReset: () => { clearChatBg(key); render(); } } : {}),
        });
      }
      break;
    }
    case 'group-avatar': {
      // 群头像（docs/13）：存 conv.avatar（不塞 avatars 名字键表）；取景挂 cv:<会话id> 槽位
      const conv = currentConversation();
      if (_ctx && conv && conv.kind === 'group') {
        const container = _ctx.container;
        _overlay = null;
        render();
        openImagePickerSheet(container, {
          mode: 'setting',
          title: `更换群头像 · ${conv.title}`,
          crop: { ratio: 1, slot: `cv:${conv.id}`, kind: 'img', title: '群头像' },
          current: conv.avatar || '',
          currentText: '当前群头像',
          defaultText: '默认用群名色块',
          pickTip: '设为群头像',
          onPick: img => { mutatePhoneData(d => { setGroupAvatar(d, conv.id, img.path); }); render(); emitPhoneEvent('ubp-phone:data-changed'); emitAch('phone_avatar_changed', { target: 'group' }); },
          onImport: path => { mutatePhoneData(d => { setGroupAvatar(d, conv.id, path); }); render(); emitPhoneEvent('ubp-phone:data-changed'); emitAch('phone_avatar_changed', { target: 'group' }); },
          onCropAdjusted: () => render(),
          ...(conv.avatar ? { onReset: () => { mutatePhoneData(d => { setGroupAvatar(d, conv.id, null); }); render(); emitPhoneEvent('ubp-phone:data-changed'); } } : {}),
        });
      }
      break;
    }
    case 'img-send-confirm': handleSendImage(); break;
    case 'pick-chars':
      if (_ctx) openShotCharPicker(_ctx.container, { selected: _imgSendSelected, onConfirm: ids => { _imgSendSelected = ids; render(); } });
      break;
    case 'pick-loc':
      if (_ctx) openShotLocationPicker(_ctx.container, { onPick: (locId, locations) => { _imgSendLocId = locId; _imgSendLocs = locations; _imgSendLocLoaded = true; render(); } });
      break;
    case 'toggle-ctx': _imgSendUseCtx = (el as HTMLInputElement).checked; break; // 原生已切，仅记状态，不重绘以免丢描述焦点
    case 'gen-image': retryImage(id); break;
    case 'voice-play': {
      const msg = currentConversation()?.messages.find(mm => mm.id === id);
      if (msg && msg.type === 'voice') toggleVoicePlayback(msg);
      break;
    }
    case 'retry-last': void handleTrigger(); break;
    default: break;
  }
}

/** 多选模式点击路由：顶栏/操作条按钮放行，其余落在消息行上一律当勾选。 */
function handleSelectClick(target: HTMLElement): void {
  const el = target.closest('[data-ubp-act]') as HTMLElement | null;
  const act = el?.dataset.ubpAct || '';
  if (act === 'sel-cancel') {
    exitSelectMode();
    render();
    return;
  }
  if (act === 'sel-all') {
    const conv = currentConversation();
    if (conv) {
      const allIds = conv.messages.filter(m => m.from !== 'system').map(m => m.id);
      const all = _selected.size >= allIds.length && allIds.length > 0;
      _selected = all ? new Set() : new Set(allIds);
      refreshSelectUi();
    }
    return;
  }
  if (act === 'sel-forward') {
    void openForwardPicker();
    return;
  }
  if (act === 'sel-delete') {
    deleteSelectedMessages();
    return;
  }
  if (act === 'abort-gen') {
    if (_chatId) {
      _revealAbortConvs.add(_chatId);
      abortPhoneGeneration(_chatId);
    }
    return;
  }
  const row = target.closest('.ubp-msg-row[data-mid]') as HTMLElement | null;
  if (row?.dataset.mid) toggleSelect(row.dataset.mid);
}

/** 输入时就地切换输入栏右槽（好友「＋ ⇄ 发送」双态 / 申请会话发送钮可用态）——只换这一个节点，
 *  不整体重绘（保输入焦点与光标；重绘纪律：input 不 render）。打字时顺手收起 ＋ 功能面板（微信行为）。 */
function syncInputRightSlot(hasDraft: boolean): void {
  if (hasDraft && _plusOpen) {
    _plusOpen = false;
    _ctx?.container.querySelector('.ubp-plus-panel')?.remove();
  }
  // 右槽从 F40 起自成一个分区（#ubp-input-right）：**按分区取节点**——
  // 按 .ubp-inputbar 的直接子代取会取不到（按钮在分区里，是孙代），整段就静默早退（F80）。
  const zone = _ctx?.container.querySelector('#ubp-input-right');
  if (!zone) return;
  const html = inputRightSlotHtml(hasDraft, _chatIsFriend);
  // ★就地写入必须同步分区缓存：renderChat 的 setZoneHtml 是**字符串 diff**，缓存不跟着改的话
  //   下一次重绘算出同一串就跳过更新，留下旧钮（例：打字换成发送 → 发出清空草稿 → 重绘算出的
  //   plus 与缓存同串 ⇒ 空输入框上挂着「发送」）。
  _zoneHtmlCache.set('#ubp-input-right', html);
  const wantAct = inputRightSlotAct(hasDraft, _chatIsFriend);
  const cur = zone.querySelector(':scope > [data-ubp-act="send"], :scope > [data-ubp-act="plus"]') as HTMLElement | null;
  if (!cur || (cur.dataset.ubpAct || '') !== wantAct) {
    zone.innerHTML = html;
    return;
  }
  if (wantAct === 'send' && !_chatIsFriend) cur.toggleAttribute('disabled', !hasDraft);
}

function handleInput(event: Event): void {
  const target = event.target as HTMLElement;
  if (target.id === 'ubp-wx-search') {
    // 会话搜索：只就地过滤列表，不整帧重绘（保输入焦点与光标）；
    // O41：过滤含逐会话消息全扫，去抖 140ms（每次输入只扫一轮）。
    _searchQuery = (target as HTMLInputElement).value;
    scheduleSessionFilter();
    return;
  }
  if (target.id === 'ubp-contact-search') {
    _contactQuery = (target as HTMLInputElement).value;
    applyContactFilter();
    return;
  }
  if (target.id === 'ubp-cs-input') {
    // 聊天内搜索：同样就地只换结果列表（整页重绘会丢焦点与光标）
    _chatSearchQuery = (target as HTMLInputElement).value;
    applyChatSearchFilter();
    return;
  }
  if (target.id === 'ubp-chat-input') {
    const value = (target as HTMLTextAreaElement).value;
    if (_chatId) setDraft(_chatId, value);
    syncInputRightSlot(!!value.trim());
    // 群聊 @ 选择列表：光标前有未闭合的「@片段」才弹出，继续打字实时过滤
    if (_chatIsGroup) {
      const caret = (target as HTMLTextAreaElement).selectionStart ?? value.length;
      const frag = value.slice(0, caret).match(/@([^@\s]*)$/);
      updateMentionPanel(frag ? frag[1] : null);
    } else {
      updateMentionPanel(null);
    }
  } else if (target.id === 'ubp-group-title') {
    _groupTitle = (target as HTMLInputElement).value;
  } else if (target.id === 'ubp-group-name') {
    _renameDraft = (target as HTMLInputElement).value;
    const btn = _ctx?.container.querySelector('#ubp-rename-btn') as HTMLButtonElement | null;
    if (btn) btn.disabled = !_renameDraft.trim();
  } else if (target.id === 'ubp-atmo-requirement') {
    // 就地更新字数与提示，不重绘弹层（保输入焦点与光标）
    _atmoAddRequirement = (target as HTMLTextAreaElement).value.slice(0, MAX_ATMOSPHERE_REQUIREMENT_LEN);
    const root = (target as HTMLTextAreaElement).closest('.ubp-atmo-req');
    const counter = root?.querySelector('.ubp-atmo-req-count');
    if (counter) counter.textContent = `${_atmoAddRequirement.length}/${MAX_ATMOSPHERE_REQUIREMENT_LEN}`;
    const tip = _ctx?.container.querySelector('#ubp-atmo-tip');
    if (tip) {
      tip.textContent = _atmoAddRequirement.trim()
        ? S('下一轮聊天时，会按你的额外要求生成姓名、性别、身份和性格。', '下一轮共谈时，会按你的额外要求生成姓名、性别、身份和性格。')
        : S('下一轮聊天时，会顺手生成姓名和一句性格，再让他们参与对话。', '下一轮共谈时，会顺手生成姓名和一句性格，再让他们参与对话。');
    }
  } else if (target.id === 'ubp-cam-desc') {
    _imgSendDesc = (target as HTMLTextAreaElement).value;
    const btn = _ctx?.container.querySelector('[data-ubp-act="img-send-confirm"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = _imgSendDesc.trim().length < 5; // 同相机：至少 5 字
  } else if (target.id === 'ubp-voice-text') {
    _voiceText = (target as HTMLTextAreaElement).value;
    const btn = _ctx?.container.querySelector('[data-ubp-act="voice-confirm"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = !_voiceText.trim();
  } else if (target.id === 'ubp-money-amount' || target.id === 'ubp-money-note') {
    if (target.id === 'ubp-money-amount') _moneyAmount = (target as HTMLInputElement).value;
    else _moneyNote = (target as HTMLInputElement).value;
    syncMoneyConfirmState(); // L15：实时切「发送」可用态 + 余额不足提示（就地增删，不重绘整层）
  } else if (target.id === 'ubp-add-name') {
    _addName = (target as HTMLInputElement).value;
    const btn = _ctx?.container.querySelector('[data-ubp-act="add-contact-confirm"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = !_addName.trim();
  } else if (target.id === 'ubp-add-reason') {
    _addReason = (target as HTMLTextAreaElement).value;
  } else if (target.id === 'ubp-msg-edit-text') {
    _editDraft = (target as HTMLTextAreaElement).value;
    const btn = _ctx?.container.querySelector('[data-ubp-act="msg-edit-save"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = !_editDraft.trim();
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && _convMenu) {
    event.stopPropagation();
    closeConvMenu();
    return;
  }
  if (event.key === 'Escape' && _msgMenu) {
    event.stopPropagation();
    closeMsgMenu();
    return;
  }
  const target = event.target as HTMLElement;
  // 键盘轻点音（I-3；开关默认关，判定在 feedback 内——输入法组合期间不响）
  if (target.id === 'ubp-chat-input' && !event.isComposing && event.key.length === 1) feedback('key');
  if (target.id === 'ubp-chat-input' && event.key === 'Enter' && !event.shiftKey) {
    if (event.isComposing || event.keyCode === 229) return; // IME 组合中的回车=选词，不上屏
    event.preventDefault();
    handleSend(); // 回车=只上屏（攒批），触发靠输入栏上方的「生成回复」条
  }
}

/** 进入会话的**状态部分**（不渲染）：清未读 + 置视图态。
 *  拆出来是为了让「mount 首帧的深链直达」（通知中心点某条未读 → 直接落在该会话）只渲染一次。 */
function enterConversation(convId: string): void {
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === convId);
    if (conv) {
      conv.unread = 0;
      delete conv.manualUnread; // 打开会话=已读（真机手动未读红点随之消失）
    }
  });
  _chatId = convId;
  _view = 'chat';
  _overlay = null;
  _profileBack = null;
  _plusOpen = false;
  _searchQuery = ''; // 搜索词不出会话页（真机微信搜索是独立页，返回即复位）
  _chatSearchOpen = false; // 聊天内搜索同样不出会话
  _chatSearchQuery = '';
  _pendingQuote = null; // 待发引用不出会话（与微信一致）
  _noteEditing = null; // 资料卡备注编辑态不出会话（换会话即作废，不保存）
  exitSelectMode();
}

function openConversation(convId: string): void {
  enterConversation(convId);
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

function startPrivateChat(name: string): void {
  const existed = !!readPhoneDataSafe().conversations.find(c => c.id === privateConversationId(name));
  const convId = mutatePhoneData(d => ensurePrivateConversation(d, name).id);
  // L9 成就：真·新建私聊才计（已存在会话的再次进入不算）
  if (!existed) emitAch('phone_conv_created', { kind: 'private' });
  openConversation(convId);
}

/** 添加好友（通讯录「＋」）：记录自定义联系人（数据库已有该名则跳过记录、提示后直接走正常申请）
 *  → 开启私聊申请会话；申请内容非空则作为第一条消息上屏并立即触发 AI 裁决（同给既有角色发申请）。 */
function submitAddContact(): void {
  const name = _addName.trim().slice(0, 60);
  const reason = _addReason.trim().slice(0, 500);
  if (!name || !_ctx) return;
  const roster = getRoster();
  let notice = '';
  if (roster.protagonistName && name === roster.protagonistName) {
    showScreenToast(_ctx.container, S('这是主角自己，无需申请', '这是本尊道身，无需递帖'));
    return;
  }
  if (roster.contacts.some(c => c.name === name)) {
    notice = S('数据库中已有该角色，直接发送申请', '数据库已录此人，径直递帖');
  } else if (isCustomContact(readPhoneDataSafe(), name)) {
    notice = S('该角色已在通讯录中，直接发送申请', '此人已在名录，径直递帖');
  } else {
    mutatePhoneData(d => addCustomContact(d, name));
    // L9 成就：真正新增联系人才计（数据库已有/已在通讯录都不算）
    emitAch('phone_contact_added', {});
  }
  const convId = mutatePhoneData(d => ensurePrivateConversation(d, name).id);
  if (reason) {
    appendMyMessage(convId, normalizePhoneMessage({
      id: makeMessageId(), from: 'me', type: 'text', content: reason, ts: Date.now(), storyTime: roster.global.time,
    })!);
  }
  openConversation(convId); // 内含 render + data-changed
  if (reason) void runGeneration(convId); // 申请会话发送即触发（与非好友会话直接发送一致）
  // 提示在全部渲染之后追加（innerHTML 重建会吞掉先前的 toast，forwardSelectedTo 同款时序）
  if (notice && _ctx) showScreenToast(_ctx.container, notice);
}

/** 删除自定义联系人（资料卡红色按钮，二次确认后执行）：移除记录 + 好友关系 + 全部聊天。
 *  数据库角色无此入口——自定义记录在数据库收录同名后自动让位，无需删除。 */
function deleteCustomContact(): void {
  const name = _overlay?.name || '';
  _overlay = null;
  if (!name || !isCustomContact(readPhoneDataSafe(), name)) return;
  const convId = privateConversationId(name);
  mutatePhoneData(d => {
    removeCustomContact(d, name);
    removeFriend(d, name);
    d.conversations = d.conversations.filter(c => c.id !== convId);
  });
  _drafts.delete(convId);
  _draftPending.delete(convId);
  if (_chatId === convId) {
    _chatId = null;
    _view = 'contacts';
  }
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 外部消息到达（世界演化联动）：正在看该会话=清未读+上屏；否则刷新列表（角标走 data-changed）。
 *  用户正在该会话输入框打字时不重渲染（保光标），下次交互自然显示。
 *  「正在看」必须走 `isChatInView`（含手机是否展开）——只比 _chatId/_view 会把「收起手机」误判为
 *  正在看，外部送达的 unread 当场被清零丢失（本 App 内送达早已用同口径，此处补齐）。 */
export function notifyExternalMessage(convId: string): void {
  if (!_ctx) return; // App 未挂载：角标由 data-changed 刷新即可
  const visible = isChatInView(convId);
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === convId);
    if (conv && visible) {
      conv.unread = 0;
      delete conv.manualUnread;
    }
  });
  if (isConvBusy(convId) || _selectMode) return; // 该会话生成/送达（或多选）中不重渲染，走各自的渲染循环
  if (_view === 'chat' && _chatId === convId
    && (_ctx.shadow.activeElement as HTMLElement | null)?.id === 'ubp-chat-input') {
    return; // 正在输入：跳过（textarea 重建会打断光标）
  }
  render();
}

function createGroup(): void {
  if (_groupSel.size < 2) return;
  const memberCount = _groupSel.size;
  const convId = mutatePhoneData(d => createGroupConversation(d, Array.from(_groupSel), _groupTitle, currentPhoneStorageId() || 'na').id);
  _overlay = null;
  // L9 成就：玩家亲手建群成功
  emitAch('phone_conv_created', { kind: 'group', memberCount });
  openConversation(convId);
}

function clearConversation(): void {
  if (!_chatId) return;
  const count = currentConversation()?.messages.length ?? 0;
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === _chatId);
    if (conv) {
      conv.messages = [];
      conv.unread = 0;
    }
  });
  _pendingQuote = null; // 被引用消息已随会话清空，待发引用一并作废
  _overlay = null;
  render();
  // L9 成就：清空会话记录（空会话不产生 0 条记录）
  if (count > 0) emitAch('phone_msg_deleted', { count });
}

// ─── 群管理（⋯ 菜单：改名/加人/移人，变动落微信式系统消息） ───

function renameGroup(): void {
  const title = _renameDraft.trim().slice(0, 40);
  if (!title || !_chatId) return;
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === _chatId);
    if (conv && conv.kind === 'group' && conv.title !== title) {
      conv.title = title;
      appendMessage(conv, normalizePhoneMessage({
        id: makeMessageId(), from: 'system', type: 'text',
        content: S(`你修改群名为「${title}」`, `你将道盟改号为「${title}」`), ts: Date.now(), storyTime: getRoster().global.time,
      })!);
    }
  });
  _renameDraft = '';
  _overlay = null;
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 移出成员=破坏性且直接改动群结构（IA-02：先确认再落库；取消不改任何数据）。 */
function confirmRemoveMember(name: string): void {
  if (!name || !_ctx) return;
  const conv = currentConversation();
  if (!conv || conv.kind !== 'group' || !conv.members.includes(name)) return;
  openConfirmSheet(_ctx.container, {
    title: S(`将「${name}」移出群聊？`, `将「${name}」请出道盟？`),
    message: S('移出后 TA 将不再收到本群消息，历史记录保留；之后可以重新添加。', '请出后对方不再收到本盟消息，旧讯仍在；之后可再增补。'),
    confirmLabel: S('移出', '请出'),
    onConfirm: () => removeGroupMember(name),
  });
}

function removeGroupMember(name: string): void {
  if (!name || !_chatId) return;
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === _chatId);
    // 最后一名成员不可移出（防死群）
    if (conv && conv.kind === 'group' && conv.members.length > 1 && conv.members.includes(name)) {
      conv.members = conv.members.filter(mn => mn !== name);
      appendMessage(conv, normalizePhoneMessage({
        id: makeMessageId(), from: 'system', type: 'text',
        content: S(`你将${name}移出了群聊`, `你将${name}请出了道盟`), ts: Date.now(), storyTime: getRoster().global.time,
      })!);
    }
  });
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 添加群成员：底部弹层多选好友（群聊仅限好友，与建群口径一致）。 */
function openAddMemberPicker(): void {
  const conv = currentConversation();
  if (!conv || conv.kind !== 'group' || !_ctx) return;
  const data = readPhoneDataSafe();
  const friendSet = new Set(data.friends || []);
  const candidates = mergeCustomContacts(getRoster(), data.customContacts || []).filter(c => friendSet.has(c.name) && !conv.members.includes(c.name));
  _overlay = null;
  render();
  openPickerSheet(_ctx.container, {
    title: S('添加群成员', '增补盟友', '增邀同道', '增邀同仁'),
    multi: true,
    confirmLabel: S('添加', '增补'),
    searchPlaceholder: S('搜索好友', '寻访道友'),
    emptyText: candidates.length ? '' : S('没有可添加的好友（已在群里的不算）', '无可增补的道友（已在盟中的不算）', '无可增邀的故人（已在会中的不算）', '无可增邀的同伴（已在桌旁的不算）'),
    groups: [{ key: 'friends', label: `${S('好友', '道友')}（${candidates.length}）`, items: candidates.map(c => ({ id: c.name, label: c.name, sub: c.brief || c.identity })) }],
    onConfirm: names => addGroupMembers(names),
  });
}

function addGroupMembers(names: string[]): void {
  const conv = currentConversation();
  if (!conv || conv.kind !== 'group' || !names.length) return;
  const added: string[] = [];
  mutatePhoneData(d => {
    const target = d.conversations.find(c => c.id === conv.id);
    if (!target || target.kind !== 'group') return;
    for (const n of names) {
      if (n && !target.members.includes(n)) {
        // 正式成员优先：同名气氛组回落待生成，避免 allowedSenders/@ 歧义。
        const clash = (target.atmosphere || []).find(a => a.status === 'ready' && a.name === n);
        if (clash) {
          clash.name = '';
          clash.personality = '';
          clash.status = 'pending';
        }
        target.members.push(n);
        added.push(n);
      }
    }
    if (added.length) {
      appendMessage(target, normalizePhoneMessage({
        id: makeMessageId(), from: 'system', type: 'text',
        content: S(`你邀请${added.join('、')}加入了群聊`, `你邀${added.join('、')}入盟共谈`), ts: Date.now(), storyTime: getRoster().global.time,
      })!);
    }
  });
  if (added.length) {
    render();
    emitPhoneEvent('ubp-phone:data-changed');
  }
}

/** 打开批量添加气氛组（居中卡片；不单独发 AI 请求）。 */
function openAtmosphereAddSheet(): void {
  const conv = currentConversation();
  if (!conv || conv.kind !== 'group' || !_ctx) return;
  const remaining = Math.max(0, MAX_ATMOSPHERE_PER_GROUP - (conv.atmosphere || []).length);
  if (remaining <= 0) {
    showScreenToast(_ctx.container, S(`气氛组已达上限 ${MAX_ATMOSPHERE_PER_GROUP} 人`, `闲谈道友已达上限 ${MAX_ATMOSPHERE_PER_GROUP} 人`));
    return;
  }
  _atmoAddCount = Math.min(10, remaining);
  _atmoAddRequirement = '';
  _profileBack = _overlay?.kind === 'menu' ? 'menu' : null;
  _overlay = { kind: 'atmo-add' };
  render();
}

/** 批量落待生成占位 + 一条系统消息；姓名/性别/身份/性格在下一轮同一条 AI 请求里生成。 */
function addAtmosphereBatch(): void {
  const conv = currentConversation();
  if (!conv || conv.kind !== 'group') return;
  let added = 0;
  const requirement = _atmoAddRequirement;
  mutatePhoneData(d => {
    const target = d.conversations.find(c => c.id === conv.id);
    if (!target || target.kind !== 'group') return;
    const remaining = Math.max(0, MAX_ATMOSPHERE_PER_GROUP - (target.atmosphere || []).length);
    const count = Math.min(Math.max(1, _atmoAddCount), remaining);
    const entries = addAtmospherePlaceholders(target, count, requirement);
    added = entries.length;
    if (added) {
      appendMessage(target, normalizePhoneMessage({
        id: makeMessageId(), from: 'system', type: 'text',
        content: S(
          `你邀请了 ${added} 位群友加入群聊`,
          `你邀了 ${added} 位道友入盟闲谈`,
          `你请了 ${added} 位朋友入群捧场`,
          `你邀了 ${added} 位同伴加入圆桌`,
        ),
        ts: Date.now(), storyTime: getRoster().global.time,
      })!);
    }
  });
  _profileBack = null;
  _atmoAddRequirement = '';
  _overlay = { kind: 'menu' };
  render();
  if (added) emitPhoneEvent('ubp-phone:data-changed');
}

/** 移出单个气氛组：已生成的落一条系统消息；待生成的不留痕。 */
function removeAtmosphereEntry(id: string): void {
  if (!id || !_chatId) return;
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === _chatId);
    if (!conv || conv.kind !== 'group') return;
    const removed = removeAtmosphereMember(conv, id);
    if (removed && removed.status === 'ready' && removed.name) {
      appendMessage(conv, normalizePhoneMessage({
        id: makeMessageId(), from: 'system', type: 'text',
        content: S(
          `群友「${removed.name}」退出了群聊`,
          `闲谈道友「${removed.name}」退出了道盟`,
          `捧场朋友「${removed.name}」退出了群英会`,
          `闲聊同伴「${removed.name}」退出了圆桌`,
        ),
        ts: Date.now(), storyTime: getRoster().global.time,
      })!);
    }
  });
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 清空待生成气氛组（还没在聊天里出现过，不留系统消息）。 */
function clearPendingAtmosphere(): void {
  if (!_chatId) return;
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === _chatId);
    if (!conv || conv.kind !== 'group' || !conv.atmosphere) return;
    conv.atmosphere = conv.atmosphere.filter(a => a.status !== 'pending');
    if (!conv.atmosphere.length) delete conv.atmosphere;
  });
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

// ─── 多选：批量删除 / 合并转发 ───

/** 选中消息 → 转发条目（保持原顺序；图片仅引用 ready 文件，嵌套记录展平为文字）。
 *  链接卡：条目结构不带 link 载荷，把「标题：页面描述」并进 content（转发后 AI 仍读得到那条链接讲的是什么）。 */
function collectSelectedLogEntries(conv: Conversation): PhoneLogEntry[] {
  const out: PhoneLogEntry[] = [];
  for (const m of conv.messages) {
    if (m.from === 'system' || !_selected.has(m.id)) continue;
    const linkText = m.type === 'link'
      ? [m.link?.title || m.content, m.link?.desc || m.link?.preview || ''].filter(Boolean).join('：')
      : '';
    out.push({
      from: m.from,
      type: m.type === 'chatlog' ? 'text' : m.type,
      content: m.type === 'chatlog' ? `[聊天记录]${m.content}` : (linkText || m.content),
      ...(m.amount ? { amount: m.amount } : {}),
      ...(m.type === 'image' && m.imagePath && m.imageStatus === 'ready' ? { imagePath: m.imagePath } : {}),
      ...(m.storyTime ? { storyTime: m.storyTime } : {}),
    });
  }
  return out;
}

/** 批量删除=破坏性（IA-02：先确认再落库；取消保留多选态，方便用户改选）。 */
function deleteSelectedMessages(): void {
  if (!_selected.size || !_chatId || !_ctx) return;
  const count = _selected.size;
  openConfirmSheet(_ctx.container, {
    title: S(`删除选中的 ${count} 条消息？`, `焚去选中的 ${count} 道符讯？`),
    message: S('删除后不可恢复。', '焚去后不可挽回。'),
    confirmLabel: S('删除', '焚去'),
    onConfirm: doDeleteSelectedMessages,
  });
}

function doDeleteSelectedMessages(): void {
  if (!_selected.size || !_chatId) return;
  const count = _selected.size;
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === _chatId);
    if (conv) conv.messages = conv.messages.filter(m => !_selected.has(m.id));
  });
  exitSelectMode();
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：删除条数按本次选中数（exitSelectMode 已清空多选，故先取值）
  emitAch('phone_msg_deleted', { count });
}

/** 保存单条编辑（多选→编辑）：就地改写 content，不动 ts（改写≠新消息，排序/相对时间不变）；
 *  世界书重投影由通知签名的内容指纹自动触发（D 修复后无需显式失效化）。 */
function submitMessageEdit(): void {
  const msgId = _overlay?.id || _editMsgId;
  const text = _editDraft.trim();
  _overlay = null;
  if (!msgId || !text || !_chatId) {
    render();
    return;
  }
  mutatePhoneData(d => {
    const msg = d.conversations.find(c => c.id === _chatId)?.messages.find(m => m.id === msgId);
    if (msg && isMessageEditable(msg)) msg.content = text;
  });
  exitSelectMode();
  render();
  if (_ctx) showScreenToast(_ctx.container, S('已保存', '已存定'));
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 转发来源标签（用户定案口径）：私聊=和XX的聊天；群聊=XX群聊（群名已带后缀不重复）。 */
function forwardSourceLabel(conv: Conversation): string {
  if (conv.kind === 'group') {
    const suffix = S('群聊', '道盟');
    return conv.title.endsWith(suffix) ? conv.title : `${conv.title}${suffix}`;
  }
  const name = conv.members[0] || conv.title;
  return S(`和${name}的聊天`, `和${name}的符讯`);
}

/** 合并转发：先收条目再弹目标选择（目标=现有会话（申请会话除外）+ 无会话好友，弹层在 forward-sheet 统一管理）。 */
async function openForwardPicker(): Promise<void> {
  const conv = currentConversation();
  if (!conv || !_selected.size || !_ctx) return;
  const entries = collectSelectedLogEntries(conv); // 先收条目再清选中态（exitSelectMode 会清空多选）
  const srcLabel = forwardSourceLabel(conv); // 来源标签随消息落库（卡片标题+AI 开头「转发消息：来自于…」）
  exitSelectMode();
  render();
  openForwardTargetSheet(_ctx, pick => forwardSelectedTo(pick, entries, srcLabel));
}

function forwardSelectedTo(pick: string, entries: PhoneLogEntry[], fwdSrc: string): void {
  if (!entries.length) return;
  const message = buildChatlogMessage(entries, getRoster().global.time, fwdSrc);
  if (!message) return;
  if (!appendForwardedMessage(pick, message)) return;
  // L9 成就：合并转发成功（转发卡本身也是一条我方消息；群聊判定按目标会话，不是当前会话）
  const targetConv = readPhoneDataSafe().conversations.find(c => c.id === pick);
  emitAch('phone_forward_sent', {});
  emitAch('phone_msg_sent', {
    type: message.type,
    isGroup: achFlag(targetConv?.kind === 'group'),
    len: message.content.length,
    quote: 0,
  });
  if (_ctx) showScreenToast(_ctx.container, S('已转发', '已转呈'));
  render();
}

// ─── 会话删除（会话列表长按；私聊保留好友关系，群聊解散） ───

function deleteConversation(): void {
  const convId = _overlay?.id || '';
  _overlay = null;
  if (!convId) return;
  mutatePhoneData(d => {
    d.conversations = d.conversations.filter(c => c.id !== convId);
  });
  _drafts.delete(convId);
  _draftPending.delete(convId);
  if (_chatId === convId) {
    _chatId = null;
    _view = 'sessions';
    _pendingQuote = null;
  }
  exitSelectMode();
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

// ─── 备忘气泡删除（长按；删本条系统气泡 + 级联删主项目备忘录表同名条目） ───

/** 长按备忘系统气泡 → 记下本条 id 与备忘标题，开确认层。 */
function openMemoDelete(messageId: string, memoTitle: string): void {
  if (!messageId || !memoTitle) return;
  _overlay = { kind: 'memo-delete', id: messageId, name: memoTitle };
  render();
}

/** 确认删除：先收弹层→删气泡→再落库删主项目同名条目（先关层再落库，同 action-sheet 纪律）。
 *  库删除失败不回滚气泡（手机侧记录已按用户意愿移除），仅以浮层提示区分。 */
async function confirmMemoDelete(): Promise<void> {
  const msgId = _overlay?.id || '';
  const title = _overlay?.name || '';
  _overlay = null;
  if (!_chatId || !msgId) { render(); return; }
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === _chatId);
    if (conv) conv.messages = conv.messages.filter(m => m.id !== msgId);
  });
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  const res = await deletePhoneMemoByTitle(title);
  if (res.ok) invalidatePhoneScheduleCache(); // 备忘录表可能少了一行 → 日程提醒缓存失效（M7）
  if (!_ctx) return;
  const text = res.ok
    ? (res.deleted > 0
      ? S('已删除备忘记录，并已从主项目备忘录移除同名条目', '已焚去手札记录，主项目手札一表同名条目一并删去')
      : S('已删除备忘记录（主项目中已无同名条目）', '已焚去手札记录（主项目中已无同名条目）'))
    : S(`已删除备忘记录（主项目删除失败：${res.error}）`, `已焚去手札记录（主项目删去失败：${res.error}）`);
  showScreenToast(_ctx.container, text);
}

// ─── 长按（多选进入 / 会话删除；桌面右键同效） ───

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10;

/** 键盘避让里「原本贴底」的容差（px）：壳被软键盘压矮后只把**本来就在底部**的会话重新贴底
 *  （用户正翻旧消息时不抢他的位置）。容差要盖住 iOS 键盘弹起时 safe-area-inset-bottom 归零带来的
 *  ≈34px 高度抖动，故取 60。 */
const KB_PIN_BOTTOM_SLOP = 60;

function cancelLongPress(): void {
  if (_longPressTimer) {
    clearTimeout(_longPressTimer);
    _longPressTimer = null;
  }
  _pressStart = null;
}

function fireLongPress(action: () => void): void {
  cancelLongPress();
  _longPressFiredAt = Date.now();
  action();
}

function armLongPress(event: PointerEvent, action: () => void): void {
  cancelLongPress();
  _pressStart = { x: event.clientX, y: event.clientY };
  _longPressTimer = setTimeout(() => {
    _longPressTimer = null;
    fireLongPress(action);
  }, LONG_PRESS_MS);
}

function handlePointerDown(event: PointerEvent): void {
  if (_overlay || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const target = event.target as HTMLElement;
  if (_view === 'chat' && !_selectMode && _ctx?.container.contains(target)) {
    const row = target.closest('.ubp-msg-row[data-mid]') as HTMLElement | null;
    if (row?.dataset.mid) {
      armLongPress(event, () => openMsgMenu(row, row.dataset.mid || ''));
      return;
    }
    // 备忘系统气泡：长按删除本条 + 级联删主项目备忘录表同名条目（不进多选）
    const memoBubble = target.closest('.ubp-sys-msg[data-memo-title]') as HTMLElement | null;
    if (memoBubble) {
      armLongPress(event, () => openMemoDelete(memoBubble.dataset.mid || '', memoBubble.dataset.memoTitle || ''));
      return;
    }
    // 长按输入栏「发送」（申请会话）=申请提示（一次性，不落盘）；本批额外提示已改生成条 ⋯ 常显按钮
    if (!_chatIsFriend && target.closest('[data-ubp-act="send"]')) {
      armLongPress(event, openSendHint);
      return;
    }
  }
  if (_view === 'favs') {
    const row = target.closest('.ubp-fav-row[data-id]') as HTMLElement | null;
    if (row?.dataset.id) { armLongPress(event, () => confirmDeleteFav(row.dataset.id || '')); return; }
  }
  if (_view === 'sessions') {
    const row = target.closest('.ubp-wx-row[data-ubp-act="open-conv"]') as HTMLElement | null;
    if (row?.dataset.id) {
      // 长按会话=贴行弹框（置顶/标未读/删除），不再直接进删除确认
      const touchX = event.clientX;
      armLongPress(event, () => openConvMenu(row, touchX));
    }
  }
}

/** 列表滚动即收菜单（真机微信同款；菜单贴的是行的旧位置，滚动后必须消失）。
 *  只摘 DOM 不整帧重绘——滚动中重绘会跳位。
 *  **保位回声的免疫**：render() 会换掉滚动容器并把 scrollTop 填回旧值（保位语义见
 *  claude_memory/rerender-scroll-preservation），浏览器为这次程序性滚动在渲染帧补派一条 scroll——
 *  位置其实没动、锚点依旧有效，却会把刚弹出的菜单立刻摘掉（**滚动过列表后长按不出菜单**的病灶：
 *  菜单建好 0.4ms 后被同一帧内补派的这条事件收走，用户一帧都没看见）。故判据从「收到 scroll 事件」
 *  改为「**位置**有没有真的动」。 */
function handleScroll(ev: Event): void {
  if (!_convMenu) return;
  const el = ev.target as HTMLElement | null;
  if (el && Math.abs(el.scrollTop - _convMenuScrollTop) <= 1) return; // 保位回声，非用户滚动
  closeConvMenu();
}

function handlePointerMove(event: PointerEvent): void {
  if (!_longPressTimer || !_pressStart) return;
  if (Math.abs(event.clientX - _pressStart.x) > LONG_PRESS_SLOP || Math.abs(event.clientY - _pressStart.y) > LONG_PRESS_SLOP) {
    cancelLongPress();
  }
}

function handleContextMenu(event: Event): void {
  if (_overlay) return;
  const target = event.target as HTMLElement;
  const msgRow = _view === 'chat' && !_selectMode ? target.closest('.ubp-msg-row[data-mid]') as HTMLElement | null : null;
  const memoBubble = _view === 'chat' && !_selectMode ? target.closest('.ubp-sys-msg[data-memo-title]') as HTMLElement | null : null;
  const favRow = _view === 'favs' ? target.closest('.ubp-fav-row[data-id]') as HTMLElement | null : null;
  const convRow = _view === 'sessions' ? target.closest('.ubp-wx-row[data-ubp-act="open-conv"]') as HTMLElement | null : null;
  const sendBtn = _view === 'chat' && !_selectMode && !_chatIsFriend ? target.closest('[data-ubp-act="send"]') as HTMLElement | null : null;
  if (!msgRow && !memoBubble && !convRow && !sendBtn && !favRow) return;
  event.preventDefault();
  if (favRow?.dataset.id) fireLongPress(() => confirmDeleteFav(favRow.dataset.id || ''));
  else if (msgRow?.dataset.mid) fireLongPress(() => openMsgMenu(msgRow, msgRow.dataset.mid || ''));
  else if (memoBubble) fireLongPress(() => openMemoDelete(memoBubble.dataset.mid || '', memoBubble.dataset.memoTitle || ''));
  else if (sendBtn) fireLongPress(openSendHint);
  else if (convRow?.dataset.id) fireLongPress(() => openConvMenu(convRow, (event as PointerEvent).clientX || 0));
}

/** 好友通过系统消息（四风格；AI 裁决 friend-accept 与资料卡「加为好友」直加共用同一文案）。 */
function friendAcceptedMessage(name: string): string {
  return S(`你已添加了${name}，现在可以开始聊天了`, `${name}应允了名帖，你们已结为道友`, `与${name}互换了拜帖，自此书信往来`, `${name}收下了你的荐书，自此互通讯息`);
}

/** 资料卡「加为好友」直加（跳过申请，docs/02 §12.2）：与 AI 裁决通过同一数据改动（addFriend+300 上限）。
 *  留痕仅在会话已存在时（复用通过系统消息）；无会话不写。好友态为渲染时计算 →
 *  主按钮/灰标/申请会话形态/通讯录分组即时切换（无需额外代码）。 */
function applyAddFriendDirect(name: string): void {
  if (!name) return;
  if (isFriend(readPhoneDataSafe(), name)) {
    _overlay = null;
    render();
    return;
  }
  const convId = privateConversationId(name);
  const hasConv = !!findConversation(readPhoneDataSafe(), convId);
  mutatePhoneData(d => addFriend(d, name));
  _overlay = null;
  if (hasConv) appendSystemMessage(convId, friendAcceptedMessage(name));
  render();
  emitPhoneEvent('ubp-phone:data-changed');
}

function appendSystemMessage(convId: string, text: string, memoTitle?: string): void {
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === convId);
    if (conv) appendMessage(conv, normalizePhoneMessage({
      id: makeMessageId(), from: 'system', type: 'text', content: text, ts: Date.now(), storyTime: getRoster().global.time,
      ...(memoTitle ? { memoTitle } : {}),
    })!);
  });
}

/** 重试成功 → 移除本会话全部 [错误] 系统气泡（成功即失效，不残留；不发事件：系统气泡不涉未读）。 */
function clearErrorMessages(convId: string): void {
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === convId);
    if (conv) conv.messages = conv.messages.filter(m => !(m.from === 'system' && m.content.startsWith('[错误]')));
  });
}

/** 我方消息上屏（落库即入批次；上屏≠触发，攒批等输入栏上方「生成回复」条）。 */
function appendMyMessage(convId: string, message: PhoneMessage): void {
  mutatePhoneData(d => {
    const conv = d.conversations.find(c => c.id === convId);
    if (conv) appendMessage(conv, message);
  });
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手发送成功（AI 投递走 revealParsedMessages/appendMessage，不经过本函数）；
  // 群聊判定按目标会话本身（_chatIsGroup 是「当前渲染会话」快照，申请会话等场景会滞后）
  const convForAch = readPhoneDataSafe().conversations.find(c => c.id === convId);
  emitAch('phone_msg_sent', {
    type: message.type,
    isGroup: achFlag(convForAch?.kind === 'group'),
    len: message.content.length,
    quote: achFlag(message.quote),
    ...(message.amount ? { amount: message.amount } : {}),
  });
}

/** 发送=只上屏当前草稿（回车同；不触发 AI，攒批继续）。
 *  例外：好友申请会话（非好友私聊）发送即触发——申请是一次性事件，不攒批（用户拍板）。
 *  hint=长按发送带入的一次性提示（只作用于本次生成）。 */
function handleSend(hint?: string): void {
  if (!_chatId) return;
  const text = currentDraft({ id: _chatId, draft: currentConversation()?.draft }).trim();
  if (!text) return;
  const quote = takePendingQuote();
  appendMyMessage(_chatId, normalizePhoneMessage({
    id: makeMessageId(), from: 'me', type: 'text', content: text, ts: Date.now(), storyTime: getRoster().global.time,
    ...(quote ? { quote } : {}),
  })!);
  feedback('send'); // 发送「嗖」（I-3）
  clearDraft(_chatId);
  render();
  if (!_chatIsFriend) void runGeneration(_chatId, hint);
}

/** 拍照（相机同款控件）：所选角色/地点/描述按相机口径拼成消息上屏 pending 图片。
 *  消息带所选参数（imageSubjects/imageLocationId/imageStoryCtx），生图泵按相机口径接线；
 *  时机与聊天图片一致：自动生图开→泵立即接手，关→占位点击手动生图；不触发 AI。 */
function handleSendImage(): void {
  const desc = _imgSendDesc.trim();
  if (!desc || desc.length < 5 || !_chatId) return;
  const subjects = shotSubjects(_imgSendSelected);
  const location = _imgSendLocs.find(l => l.nodeId === _imgSendLocId) || null;
  const quote = takePendingQuote();
  _overlay = null;
  appendMyMessage(_chatId, normalizePhoneMessage({
    id: makeMessageId(), from: 'me', type: 'image',
    content: composeShotDesc(subjects.map(s => s.name), location ? location.fullPath : '', desc),
    ts: Date.now(),
    storyTime: getRoster().global.time,
    imageStatus: 'pending',
    imageSubjects: subjects.map(s => s.name),
    ...(location ? { imageLocationId: location.nodeId } : {}),
    ...(_imgSendUseCtx ? { imageStoryCtx: true } : {}),
    ...(quote ? { quote } : {}),
  })!);
  render();
}

/** 语音：转写文字上屏为语音条（时长按字数直算）；不触发 AI。 */
function handleSendVoice(): void {
  const text = _voiceText.trim();
  if (!text || !_chatId) return;
  const quote = takePendingQuote();
  _overlay = null;
  appendMyMessage(_chatId, normalizePhoneMessage({
    id: makeMessageId(), from: 'me', type: 'voice', content: text, ts: Date.now(), storyTime: getRoster().global.time,
    ...(quote ? { quote } : {}),
  })!);
  render();
}

/** 转账/红包：金额清洗与 AI 输出同一口径（parseAmountNote），无效金额按钮已拦。
 *  货币联动激活时：消息带所选币种名 + 发送即扣款。
 *  L15（用户定稿）：**超出所选币种余额直接阻止**——按钮已禁用，这里兜底中止并保留弹层
 *  （防键盘回车等旁路）；只拦玩家手操付款，正文/剧情侧欠款不受影响。 */
function handleSendMoney(kind: 'transfer' | 'redpacket'): void {
  const parsed = parseAmountNote(`${_moneyAmount}|${_moneyNote.trim()}`);
  if (!parsed || !_chatId) return;
  const curMeta = isCurrencyLinkActive() ? (payCurrencyList().find(c => c.name === _moneyCurrency) || payCommon()) : null;
  const over = moneyOverflow(curMeta, parsed);
  if (over !== null && curMeta) {
    phoneNotify(moneyOverText(curMeta, over), undefined, 'warning');
    return;
  }
  const quote = takePendingQuote();
  _overlay = null;
  const convTitle = readPhoneDataRef().conversations.find(c => c.id === _chatId)?.title || '';
  appendMyMessage(_chatId, normalizePhoneMessage({
    id: makeMessageId(), from: 'me', type: kind, content: parsed.note, amount: parsed.amount,
    ...(curMeta ? { currency: curMeta.name } : {}),
    ts: Date.now(), storyTime: getRoster().global.time,
    ...(kind === 'redpacket' ? { claimed: true } : {}),
    ...(quote ? { quote } : {}),
  })!);
  if (curMeta) payAdjust(curMeta, -Number(parsed.amount), 'phone-out', `${kind === 'redpacket' ? '红包' : '转账'} · ${convTitle}`);
  render();
}

/** 拆红包（收到的未拆红包）：标记已拆 + 入账（货币联动）+ 金币迸出动效。 */
function claimRedpacket(mid: string): void {
  const conv = readPhoneDataRef().conversations.find(c => c.id === _chatId);
  const msg = conv?.messages.find(x => x.id === mid);
  if (!msg || msg.type !== 'redpacket' || msg.claimed !== false) return;
  mutatePhoneData(d => {
    const c2 = d.conversations.find(c => c.id === _chatId);
    const m2 = c2?.messages.find(x => x.id === mid);
    if (m2 && m2.type === 'redpacket') m2.claimed = true;
  });
  const sender = senderDisplayName(msg.from);
  const meta = isCurrencyLinkActive() ? payResolveCurrency(msg.currency) : null;
  if (meta) payAdjust(meta, Number(msg.amount) || 0, 'rp-open', `红包 · ${sender}`);
  // L13b 成就：拆红包成功（玩家亲手；重复点击已由上面的 claimed 守卫挡住）
  emitAch('phone_redpacket_claimed', {});
  burstCoins(mid);
  render();
}

/** 拆红包金币迸出（对齐 mockup 场景 5 的动效）。 */
function burstCoins(mid: string): void {
  const el = _ctx?.container.querySelector(`.ubp-msg-row[data-mid="${mid}"] .ubp-card.redpacket`);
  if (!el) return;
  for (let i = 0; i < 9; i++) {
    const coin = document.createElement('span');
    coin.className = 'ubp-coin-fx';
    el.appendChild(coin);
    const ang = (Math.PI * 2 / 9) * i + Math.random() * 0.5;
    const dist = 46 + Math.random() * 34;
    coin.animate([
      { transform: 'translate(-50%,-50%) scale(.4)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist - 22}px)) scale(1) rotate(${Math.random() * 260 - 130}deg)`, opacity: 0 },
    ], { duration: 720 + Math.random() * 260, easing: 'cubic-bezier(.2,.7,.4,1)' });
    setTimeout(() => coin.remove(), 1000);
  }
}

/** 相册选图（统一选图弹层 context 档）：复用既有图片文件上屏（ready，不重新生图，等同转发）；不触发 AI。
 *  图片描述随消息进上下文，故无描述的图片不会出现在候选里（见 image-picker-sheet 档位注释）；
 *  社媒来源的图把出处拼进描述（「小明的小红书：…」），让 AI 侧的角色指代不依赖相册界面（用户定案）。 */
function handleAlbumPick(img: PickedImage): void {
  const message = buildForwardedImageMessage(composeImageDesc(img.desc, img.origin), img.path, getRoster().global.time);
  if (!message || !_chatId) return;
  const quote = takePendingQuote();
  if (quote) message.quote = quote;
  appendMyMessage(_chatId, message);
  render();
}

/** ➕面板→相册：统一选图弹层（文生图图库/手机相册双源 + 缩略图网格 + 来源筛选）。 */
function openWechatAlbumPicker(): void {
  if (!_ctx) return;
  openImagePickerSheet(_ctx.container, {
    mode: 'context',
    title: S('从相册选择', '从影阁选取'),
    emptyText: S('相册还是空的——用「拍照」生成图片，或等聊天里出现图片后再选', '影阁还是空的——用「留影」摄取画面，或等符讯里出现留影后再选', '画匣还是空的——用「写真」摄取画面，或等书信里出现写真后再选', '画廊还是空的——用「记影」摄取画面，或等晶讯里出现记影后再选'),
    onPick: img => {
      if (!_chatId) return;
      handleAlbumPick(img);
    },
  });
}

/** 触发=生成本轮回复：批次=尾部连续我方消息（引擎内部推导）；草稿有字则顺手先上屏。
 *  申请会话的触发入口只有错误气泡重试（发送按钮已即发即触）。
 *  hint=本批额外提示条 ⋯ 带入的一次性提示（只作用于本次生成）。 */
async function handleTrigger(hint?: string): Promise<void> {
  if (!_chatId || isConvBusy(_chatId)) return; // 只锁本会话：别的会话生成中照常可触发（并行聊天）
  if (currentDraft({ id: _chatId, draft: currentConversation()?.draft }).trim()) {
    handleSend(hint);
    if (!_chatIsFriend) return; // handleSend 已自带触发
  }
  await runGeneration(_chatId, hint);
}

/** 生成条 ⋯ → 本批额外提示弹层（一次性；确认后等价触发生成条但带提示）。 */
function openBatchHint(): void {
  if (!_ctx || !_chatId || isConvBusy(_chatId)) return;
  openOneShotHintSheet(_ctx.container, {
    title: S('本批额外提示', '本批额外提点'),
onConfirm: hint => { void handleTrigger(hint); },
  });
}

/** 长按「发送」（好友申请会话）→ 申请生成提示弹层。 */
function openSendHint(): void {
  if (!_ctx || !_chatId) return;
  openOneShotHintSheet(_ctx.container, {
    title: S('申请提示', '名帖提点'),
    onConfirm: hint => { handleSend(hint); },
  });
}

/** 消息到达时「用户是否正看着这个会话」的纯判定（未读判定的唯一依据；纯函数便于单测真值表）。
 *  只比 chatId/view 是不够的：**收手机、切到别的 App 都不重置这两个模块态**，
 *  会把「后台送达」误判成「正在看」，于是后台消息一条未读都不涨。
 *  三条件缺一不可：手机壳展开 + 本 App 还挂着 + 就停在该会话的聊天页。 */
export function isChatVisible(
  convId: string,
  state: { chatId: string | null; view: string; mounted: boolean; phoneOpen: boolean },
): boolean {
  return state.phoneOpen && state.mounted && state.view === 'chat' && state.chatId === convId;
}

/** 当前模块态代入纯判定。 */
function isChatInView(convId: string): boolean {
  return isChatVisible(convId, { chatId: _chatId, view: _view, mounted: Boolean(_ctx), phoneOpen: isPhoneOpen() });
}

/** 供壳层/入口判断「主角此刻是不是正看着这个会话」（I-2：正在看就不弹通知横幅）。
 *  `_chatId/_view` 是 App 私有态，壳层拿不到，故由 App 出这个只读口，判定本身仍走上面的纯函数。 */
export function isConversationBeingViewed(convId: string): boolean {
  return isChatInView(convId);
}

/** 生成完成后逐条入库+渲染（真实感：一条一条到）。终止/关闭界面语义：
 *  点「终止」丢弃未送达消息；中途关闭手机则继续在后台送达（下次打开都在）。
 *  动作（通过/拒绝/拉黑/退群）按解析序号插叙落系统消息——如 [通过] 在两条消息之间，
 *  系统气泡就插在那两条之间。 */
async function revealParsedMessages(convId: string, parsed: ParseChatResult, owner: string): Promise<void> {
  const storyTime = getRoster().global.time;
  _revealingConvs.add(convId);
  _revealAbortConvs.delete(convId);
  renderConvTick(convId);
  const actions = parsed.actions || [];
  let actionIdx = 0;
  // 聊天归属守卫（F1）：AI 请求期间切了聊天/角色卡 → 这批产物属于旧聊天，一律不写。
  // 只比会话 id 不够——私聊 id 是 `p:<角色名>`，同名角色跨聊天复用同一 id，会串台。
  // 照抄主项目正文插图引擎 readChatIdentity 守卫的先例（unified-statusbar/core/story-image-engine.ts:501）。
  const stillMine = (): boolean => currentPhoneStorageId() === owner;
  // 存在性守卫走零拷贝只读引用（此前每条消息 readPhoneDataSafe() 两次 = 2n 次全量深拷贝；
  // 守卫只问「会话还在不在」，不需要归一化快照 —— 正是 readPhoneDataRef 的设计用途）
  const convExists = (): boolean => readPhoneDataRef().conversations.some(c => c.id === convId);
  const pumpActions = async (uptoMessageCount: number): Promise<void> => {
    while (actionIdx < actions.length && actions[actionIdx]!.index <= uptoMessageCount) {
      if (_revealAbortConvs.has(convId) || !convExists() || !stillMine()) return;
      await applyChatAction(convId, actions[actionIdx]!);
      actionIdx++;
    }
  };
  // 单批自动生图名额（用户拍板 2026-10-05）：本批前 8 张图片照常自动生成，超额的标 imageManual
  // 落「点击生成」占位（自动泵不接手），并在第一张超额图到达时屏内轻提示让用户手动生成。
  const batchImageCount = parsed.messages.reduce((n, p) => n + (p.type === 'image' ? 1 : 0), 0);
  const manualImageCount = Math.max(0, batchImageCount - MAX_AUTO_IMAGES_PER_BATCH);
  let autoImageLeft = MAX_AUTO_IMAGES_PER_BATCH;
  let manualNotified = false;
  try {
    for (let i = 0; i < parsed.messages.length; i++) {
      await pumpActions(i);
      if (_revealAbortConvs.has(convId) || !stillMine()) return;
      const p = parsed.messages[i]!;
      const manualImage = p.type === 'image' && autoImageLeft <= 0;
      if (p.type === 'image' && !manualImage) autoImageLeft -= 1;
      await sleep(revealDelay(p.content));
      if (_revealAbortConvs.has(convId) || !convExists() || !stillMine()) return;
      let appendedId = '';
      mutatePhoneData(d => {
        const conv = d.conversations.find(c => c.id === convId);
        if (!conv) return;
        const atmoSender = p.sender !== 'me' && p.sender !== 'system'
          && readyAtmosphereNames(conv).includes(p.sender);
        const msg = normalizePhoneMessage({
          id: makeMessageId(), from: p.sender, type: p.type, content: p.content,
          ts: Date.now(), storyTime,
          ...(atmoSender ? { fromAtmosphere: true } : {}),
          ...(p.amount ? { amount: p.amount } : {}),
          ...((p as any).currency ? { currency: (p as any).currency } : {}),
          ...(p.type === 'redpacket' ? { claimed: false } : {}),
          ...(p.type === 'image' ? { imageStatus: 'pending' as const } : {}),
          ...(manualImage ? { imageManual: true } : {}),
          ...(p.type === 'voice' && p.emotion ? { voiceEmotion: p.emotion } : {}),
          ...(p.type === 'voice' && p.delivery ? { voiceDelivery: p.delivery } : {}),
        })!;
        appendMessage(conv, msg);
        appendedId = msg.id;
        if (!isChatInView(convId)) conv.unread += 1; // 不在这个会话里看着 = 红点+1（后台送达）
      });
      // 货币联动：AI 转账到达即入账（红包拆开才入账，见 claimRedpacket）
      if (p.type === 'transfer' && isCurrencyLinkActive()) {
        const meta = payResolveCurrency((p as any).currency);
        if (meta) payAdjust(meta, Number(p.amount) || 0, 'phone-in', `转账 · ${p.sender}`);
      }
      // 通知横幅 + 提示音（I-2/I-3）：**正在看这个会话时不打扰**（发射侧判定，见 app-registry 的分工注释）
      if (appendedId && !isChatInView(convId)) {
        const title = readPhoneDataRef().conversations.find(c => c.id === convId)?.title || p.sender;
        emitPhoneNotify({ appId: 'wechat', title, text: p.content, convId, mid: appendedId });
      }
      // 超额图片轻提示（只报一次）：本批自动生图名额已满，其余要用户自己点占位生成
      if (manualImage && !manualNotified) {
        manualNotified = true;
        const container = _ctx?.container;
        if (container) {
          showScreenToast(container, S(
            `本批图片 ${batchImageCount} 张，自动生图上限 ${MAX_AUTO_IMAGES_PER_BATCH} 张，其余 ${manualImageCount} 张请点击生成`,
            `本批图影 ${batchImageCount} 张，自动成像上限 ${MAX_AUTO_IMAGES_PER_BATCH} 张，其余 ${manualImageCount} 张请点击自行生成`,
          ));
        }
      }
      emitPhoneEvent('ubp-phone:data-changed');
      renderConvTick(convId);
    }
    await pumpActions(Number.MAX_SAFE_INTEGER);
  } finally {
    _revealingConvs.delete(convId);
    _revealAbortConvs.delete(convId);
    renderConvTick(convId);
  }
}

/** 会话级动作落库：好友裁决/拉黑/退群 → 改 friends/群成员 + 微信式系统消息（AI 可见留痕）。 */
async function applyChatAction(convId: string, action: ParsedChatAction): Promise<void> {
  const name = action.sender;
  const reason = (action.reason || '').trim();
  if (action.action === 'friend-accept') {
    mutatePhoneData(d => addFriend(d, name));
    appendSystemMessage(convId, friendAcceptedMessage(name));
  } else if (action.action === 'friend-reject') {
    appendSystemMessage(convId, S(
      `${name} 拒绝了你的好友申请${reason ? `：${reason}` : ''}，可附上新的理由再次发送申请`,
      `${name}婉拒了名帖${reason ? `：${reason}` : ''}，可附上新的缘由再度递帖`));
  } else if (action.action === 'block') {
    mutatePhoneData(d => removeFriend(d, name)); // 拉黑=移出好友 → 会话自动回退申请分支（重新申请才能恢复）
    appendSystemMessage(convId, S(
      `${name} 已将你拉黑${reason ? `：${reason}` : ''}，需重新发送好友申请`,
      `${name}与你道途两清${reason ? `：${reason}` : ''}，需重新递上名帖`));
  } else if (action.action === 'leave-group') {
    mutatePhoneData(d => {
      const conv = d.conversations.find(c => c.id === convId);
      // 最后一名成员不允许退（防死群）；不在群里的动作忽略
      if (conv && conv.kind === 'group' && conv.members.length > 1 && conv.members.includes(name)) {
        conv.members = conv.members.filter(mn => mn !== name);
        appendMessage(conv, normalizePhoneMessage({
          id: makeMessageId(), from: 'system', type: 'text',
          content: S(`${name} 退出了群聊${reason ? `：${reason}` : ''}`, `${name}退出了道盟${reason ? `：${reason}` : ''}`),
          ts: Date.now(), storyTime: getRoster().global.time,
        })!);
      }
    });
  }
  emitPhoneEvent('ubp-phone:data-changed');
  renderConvTick(convId);
}

/** AI 输出中的备忘 → 注入主项目备忘录表 + 系统气泡反馈（docs/02 §5.5）。 */
async function commitParsedMemos(convId: string, memos: ParsedChatMemo[], owner: string): Promise<void> {
  if (!memos.length) return;
  // 聊天归属守卫（F1）：主项目「备忘录」表按聊天分，切走后写入会落到别人的表里。
  if (currentPhoneStorageId() !== owner) return;
  const conv = findConversation(readPhoneDataSafe(), convId);
  if (!conv) return;
  const roster = getRoster();
  for (const memo of memos) {
    if (currentPhoneStorageId() !== owner) return;
    const draft = buildMemoDraft(memo, conv, roster);
    const result = await insertPhoneMemo(draft);
    // 日程提醒（M7）的数据源是**主项目备忘录表**：自己写库不触发主项目表格更新回调，故写入后显式失效缓存
    if (result.ok) invalidatePhoneScheduleCache();
    appendSystemMessage(
      convId,
      result.ok
        ? S(
          `已记录备忘「${result.title}」${draft.appointedDate ? `（约定时间 ${draft.appointedDate}）` : ''}，可在主项目备忘录查看`,
          `道简已录「${result.title}」${draft.appointedDate ? `（约定之期 ${draft.appointedDate}）` : ''}，可在主项目备忘录查看`)
        : `[备忘] ${result.error}：「${draft.title}」未能记录`,
      result.ok ? result.title : undefined,
    );
    renderConvTick(convId);
  }
}

async function runGeneration(convId: string, hint?: string): Promise<void> {
  const storeState = phoneStoreStatus();
  if (storeState.state === 'read-only' || storeState.state === 'no-context' || storeState.state === 'error') {
    appendSystemMessage(convId, `[错误] 存储不可用（${storeState.error || storeState.state}），点击重试`);
    render();
    return;
  }
  _generatingConvs.add(convId);
  emitGenActivity(convId, true);
  renderConvTick(convId);
  // 聊天归属快照（F1）：请求期间用户可能切聊天/切卡；产物与错误气泡都只属于发起时那个聊天。
  const owner = currentPhoneStorageId();
  try {
    const { parsed } = await generateConversationReply({ conversationId: convId, ...(hint ? { extraHint: hint } : {}) });
    _generatingConvs.delete(convId);
    if (currentPhoneStorageId() !== owner) return; // 已切聊天：静默丢弃（不写库、不落新聊天）
    clearErrorMessages(convId); // 本次成功 → 旧报错气泡失效，随上屏渲染一并消失
    await revealParsedMessages(convId, parsed, owner);
    await commitParsedMemos(convId, parsed.memos, owner);
  } catch (error) {
    if (currentPhoneStorageId() !== owner) return; // 切走后错误气泡也不该落到新聊天
    // 统一 AI 活动「终止」= 用户主动取消：静默收口，不落错误气泡
    if (error instanceof PhoneChatError && error.kind === 'aborted') return;
    const message = error instanceof PhoneChatError ? error.message
      : `AI 请求失败：${(error as Error)?.message || String(error)}`;
    appendSystemMessage(convId, `[错误] ${message}，点击重试`);
    renderConvTick(convId);
  } finally {
    _generatingConvs.delete(convId);
    emitGenActivity(convId, false);
    renderConvTick(convId);
  }
}

// ─── 图片生成泵 ───

function pumpImages(conv: Conversation): void {
  if (!getPhoneSettings().autoImageGen) return;
  for (const m of conv.messages) {
    // imageManual＝单批自动名额之外（或曾超额）的图：自动泵恒不接手，只能点击手动生成
    if (m.type === 'image' && m.imageStatus === 'pending' && !m.imageManual && !_imageJobs.has(m.id)) {
      void startImageJob(conv.id, m.id);
    }
  }
}

function retryImage(messageId: string): void {
  if (!_chatId || _imageJobs.has(messageId)) return;
  mutatePhoneData(d => {
    const msg = d.conversations.find(c => c.id === _chatId)?.messages.find(m => m.id === messageId);
    if (msg && msg.type === 'image') {
      msg.imageStatus = 'pending';
      // 点击＝用户的显式指令：摘掉「超额」标记，否则自动模式下 render 尾部的 pump 会跳过它、点击落空
      delete msg.imageManual;
    }
  });
  render(); // 自动模式下 renderChat 尾部的 pump 会接手
  if (!getPhoneSettings().autoImageGen) void startImageJob(_chatId, messageId);
}

async function startImageJob(convId: string, messageId: string): Promise<void> {
  const conv = findConversation(readPhoneDataRef(), convId);
  const msg = conv?.messages.find(m => m.id === messageId);
  if (!conv || !msg || msg.type !== 'image') return;
  // 聊天归属快照（F1）：生图可能几十秒，期间切聊天 → 图与失败态都不写新聊天。
  const owner = currentPhoneStorageId();
  const roster = getRoster();
  const protagonistName = roster.protagonistName || roster.userName || '我';
  const senderIsProtagonist = msg.from === 'me';
  const senderName = senderIsProtagonist ? protagonistName : msg.from;
  const oldImagePath = msg.imagePath || '';
  const pickedSubjects = Array.isArray(msg.imageSubjects)
    ? msg.imageSubjects.map(name => ({ name, isProtagonist: name === protagonistName }))
    : null;
  let genRecord: ImageGenRecord | undefined;
  let fixedPrompt = '';
  let fixedNegative = '';
  // 入队标记必须落在本函数的**同步段最前**（用户定案 2026-10-06「统一小手机口径」：整批一次性入队标记——
  // 泵一次就把本批待生成图标齐，排队中的图同样显示「生成中」）。拍照消息要读地图地点（await），
  // 那次挂起不能把标记推后一拍，故地点读取挪进 try；异常路径由 finally 兜住（不留点不动的转圈）。
  _imageJobs.add(messageId);
  try {
    // 拍照消息（相机同款控件）带所选参数 → 相机口径：所选 subjects + 结构化【拍摄地点】，
    // 不带聊天记录（勾了「引用最新正文」则带主项目正文）；字段存在与否是口径判据（空数组=纯景物）。
    // 其余（旧拍照消息/对方发图/AI 生图）走原聊天口径：自动推导 subjects + 最近聊天记录。
    const pickedLocation = msg.imageLocationId
      ? (await readPhoneMapLocations()).find(l => l.nodeId === msg.imageLocationId) || null
      : null;
    const storyContext = pickedSubjects && msg.imageStoryCtx ? stripWithContextConfig(readAiChatHistory(1)) : '';
    const path = await generatePhoneImage({
      messageId,
      description: msg.content,
      subjects: pickedSubjects || collectChatSubjects(senderName, senderIsProtagonist, msg.content, roster),
      roster,
      ...(pickedSubjects
        ? {
            ...(pickedLocation ? { location: pickedLocation } : {}),
            ...(storyContext ? { chatContext: storyContext, contextLabel: '最近正文进展' } : {}),
          }
        : { chatContext: buildPhoneChatContext(conv.messages, protagonistName) }),
      stem: `phone_${messageId.replace(/^m_/, '')}`,
      fixed: msg.imagePrompt
        ? { promptText: msg.imagePrompt, negativePrompt: msg.imageNegative || '', multiJson: msg.imagePromptMulti }
        : undefined,
      // 固化时机=生图前：第二步失败也不丢第一步成果（重试/重新生图不再烧文字 AI）
      onPromptReady: (promptText, negativePrompt, multiJson) => {
        fixedPrompt = promptText;
        fixedNegative = negativePrompt;
        mutatePhoneData(d => {
          if (currentPhoneStorageId() !== owner) return; // 已切聊天：第一步提示词也不写新聊天
          const mm = d.conversations.find(c => c.id === convId)?.messages.find(x => x.id === messageId);
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
    const finalPrompt = msg.imagePrompt || fixedPrompt;
    if (currentPhoneStorageId() !== owner) return; // 已切聊天：图与相册条目都不写新聊天
    mutatePhoneData(d => {
      const msg2 = d.conversations.find(c => c.id === convId)?.messages.find(m => m.id === messageId);
      if (msg2 && msg2.type === 'image') {
        msg2.imagePath = path;
        msg2.imageStatus = 'ready';
      }
    });
    // 相册：首次生成=新增条目；换一张=按旧路径原位同步（并清理旧文件）
    if (oldImagePath) {
      syncAlbumEntryForMessageImage(oldImagePath, path, genRecord);
    } else {
      addPhoneAlbumEntries([{
        id: makeAlbumEntryId(),
        path,
        source: 'chat',
        characters: pickedSubjects ? pickedSubjects.map(s => s.name) : [senderName],
        desc: msg.content,
        ...(finalPrompt ? { imagePrompt: finalPrompt, imageNegative: msg.imageNegative || fixedNegative } : {}),
        ...(genRecord ? { gen: genRecord as unknown as PhoneGenRecord } : {}),
        createdAt: Date.now(),
      }]);
    }
    emitPhoneEvent('ubp-phone:data-changed');
  } catch (_e) {
    if (currentPhoneStorageId() === owner) {
      mutatePhoneData(d => {
        const msg2 = d.conversations.find(c => c.id === convId)?.messages.find(m => m.id === messageId);
        if (msg2 && msg2.type === 'image') msg2.imageStatus = 'failed';
      });
    }
  } finally {
    _imageJobs.delete(messageId);
    if (_ctx && _chatId === convId && _view === 'chat') render();
  }
}

// ─── App 定义 ───

export const wechatApp: PhoneApp = {
  id: 'wechat',
  name: '微信',
  icon: ubpIcon('wechat'),
  color: '#2DC100',
  available: true,
  /** 返回键：弹层 → 会话贴行菜单 → 长按菜单 → 多选态 → 聊天页回列表（与屏幕返回箭头同语义，IA-03）。 */
  closeTopOverlay(): boolean {
    if (_chatSearchOpen) { _chatSearchOpen = false; _chatSearchQuery = ''; render(); return true; }
    if (_overlay) { _noteEditing = null; _profileBack = null; _overlay = null; render(); return true; }
    if (_convMenu) { closeConvMenu(); return true; }
    if (_msgMenu) { _msgMenu = null; render(); return true; }
    if (_selectMode) { exitSelectMode(); render(); return true; }
    if (_view === 'chat' || _view === 'favs') { _view = 'sessions'; _chatId = null; _pendingQuote = null; _chatSearchOpen = false; _chatSearchQuery = ''; exitSelectMode(); render(); return true; }
    return false;
  },
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    const token = ++_mountToken;
    _view = 'sessions';
    _tab = 'sessions';
    _chatId = null;
    _viewScroll.clear(); // 滚动记忆重置：重开 App 从顶开始，不继承上一次打开时的位置
    _chatIsGroup = false;
    _chatMembers = [];
    _chatIsFriend = true;
    _convMenu = null;
    _noteEditing = null; // 备注编辑态不跨次打开残留（同 _scrollToMid 口径）
    _profileBack = null;
    _scrollToMid = null; // 一次性跳转目标：上次未消费的残留不得跨次打开生效
    exitSelectMode();
    // 通知中心/编年史「点未读会话（或某条消息）」深链：openApp 恒为卸载再挂载 ⇒ 目标在首帧消费，只需一次 render
    const deepLink = takePendingAppTargetFull('wechat');
    if (deepLink && readPhoneDataRef().conversations.some(c => c.id === deepLink.convId)) {
      enterConversation(deepLink.convId);
      if (deepLink.mid) _scrollToMid = deepLink.mid;
    }
    ctx.container.addEventListener('click', handleClick);
    ctx.container.addEventListener('input', handleInput);
    ctx.container.addEventListener('keydown', handleKeydown);
    ctx.container.addEventListener('pointerdown', handlePointerDown);
    ctx.container.addEventListener('pointermove', handlePointerMove);
    ctx.container.addEventListener('pointerup', cancelLongPress);
    ctx.container.addEventListener('pointercancel', cancelLongPress);
    ctx.container.addEventListener('contextmenu', handleContextMenu);
    ctx.container.addEventListener('scroll', handleScroll, true);
    // U22(十一轮)：壳层展开 → 收起期间积累的变更一次性补渲
    const offShellOpened = onPhoneEvent('ubp-phone:shell-opened', () => {
      if (_ctx === ctx && _dirtyWhenHidden) { _dirtyWhenHidden = false; render(); }
    });
    // 软键盘避让（窄屏全屏态）：壳被键盘压矮，最后几条消息会被挤出视野——原本贴底的会话要重新贴底。
    // 判据不用常驻 scroll 监听：「让位前离底距离 = 当前离底距离 − 本次让位量」，一次减法即得。
    const offViewportChanged = onPhoneEvent('ubp-phone:viewport-changed', payload => {
      const p = payload as { inset?: number; prevInset?: number } | undefined;
      if (_ctx !== ctx || _view !== 'chat') return;
      const msgs = ctx.container.querySelector('#ubp-chat-msgs') as HTMLElement | null;
      if (!msgs) return;
      const delta = Number(p?.inset || 0) - Number(p?.prevInset || 0);
      if (!delta) return;
      const gap = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
      if (gap - delta > KB_PIN_BOTTOM_SLOP) return; // 用户正翻旧消息：位置是他自己选的，不抢
      msgs.scrollTop = msgs.scrollHeight;
    });
    render();
    // 惰性刷新立绘快照（头像/图库取最新），完成后补一次渲染
    void refreshPhoneAvatars().then(() => {
      if (_ctx === ctx && token === _mountToken) render();
    });
    return () => {
      _mountToken++;
      ctx.container.removeEventListener('click', handleClick);
      ctx.container.removeEventListener('input', handleInput);
      ctx.container.removeEventListener('keydown', handleKeydown);
      ctx.container.removeEventListener('pointerdown', handlePointerDown);
      ctx.container.removeEventListener('pointermove', handlePointerMove);
      ctx.container.removeEventListener('pointerup', cancelLongPress);
      ctx.container.removeEventListener('pointercancel', cancelLongPress);
      ctx.container.removeEventListener('contextmenu', handleContextMenu);
      ctx.container.removeEventListener('scroll', handleScroll, true);
      offShellOpened();
      offViewportChanged();
      cancelLongPress();
      exitSelectMode();
      stopVoicePlayback(false);
      flushDraftPersist(); // 待写草稿立刻落盘（关手机/切 App 不等 600ms 去抖）
      void persistPhoneData();
      _ctx = null;
    };
  },
};
