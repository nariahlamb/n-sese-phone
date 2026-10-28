// ===== 不夜城 App（成人向夜生活综合体；只读单向域） =====
// 五 Tab：街区（论坛）/ 舞台（直播·点单台）/ ＋（发布）/ 搭话（私信·约会）/ 我的（马甲·收藏·隐身）
// 专题页：他们怎么谈论你（N6）。全屏查看器：分层揭开 + 存相册 + 分享到搭话 + 求解锁。
// 纪律：单次 mount、事件委托在容器上、mount 返回 cleanup 成对移除、无常驻 setInterval、
//      徽标走 readPhoneDataRef、render 保 scrollTop、交互态优先原地更新。
// 数据域：PhoneChatData.night —— 只读正文/通讯录/手机已有内容，绝不回写世界书/时间线/正文（docs/18 §1）。

import {
  abortNightGeneration,
  adoptNightEntry,
  advanceNightDate,
  advanceNightLive,
  clearNightData,
  deleteNightConversation,
  deleteNightDmMessage,
  deleteNightLive,
  deleteNightPost,
  deleteNightPostComment,
  editNightDmMessage,
  endNightLive,
  enterNightPrivateRoom,
  exitNightPrivateRoom,
  expandNightPost,
  hasNightAlias,
  isNightBusy,
  markNightSeen,
  nightAlias,
  nightPersonaFallback,
  nightUnread,
  openNightDmFrom,
  proposeNightDate,
  pushNightDm,
  readNightPersona,
  refreshNight,
  refreshNightAboutMe,
  refreshNightLives,
  requestNightUnlock,
  runNightAlias,
  runNightPersona,
  sendNightBarrage,
  sendNightDmMessage,
  sendNightGift,
  setNightAlias,
  setNightDateStatus,
  setNightStealth,
  startMyNightLive,
  submitNightOrder,
  toggleNightAuthorFollow,
  toggleNightCollect,
  toggleNightLike,
} from '../core/night-engine';
import { isPhoneAbortError } from '../core/phone-error';
import {
  autoGenerateNightImages,
  generateNightImage,
  isNightAutoImageRunning,
  nightImageEffectiveReveal,
  nightImageReveal,
  nightImageToggleZone,
  readNightImageByKey,
} from '../core/night-images';
import {
  NIGHT_BOARDS,
  NIGHT_DEFAULT_SPICE,
  NIGHT_TAGS,
  NIGHT_TAGS_PER_POST,
  nt,
  nightBoardDef,
  nightBoardGlyph,
  nightBoardName,
  nightSpiceLabel,
  normalizeNightTags,
  type NightSpice,
} from '../core/night-config';
import {
  filterNightPosts,
  isNightDmMsgEditable,
  nightActiveDate,
  nightDateStatusLabel,
  nightPostTitle,
  nightTimeText,
  readNightOf,
  type NightAbout,
  type NightData,
  type NightDm,
  type NightImage,
  type NightLive,
  type NightPost,
} from '../core/night-model';
import { NIGHT_READONLY_NOTE, NIGHT_STANDING_LINE } from '../core/night-prompts';
import { currentStyle, S } from '../core/skins';
import { mutatePhoneData, readPhoneDataRef } from '../core/phone-store';
import { getPhoneSettings } from '../core/phone-settings';
import { getRoster } from '../core/roster';
import { buildShareMessage, composeImageDesc, type SharePostSnapshot } from '../core/forward-model';
import { emitPhoneEvent, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openImagePickerSheet } from './image-picker-sheet';
import { appendForwardedMessage, openForwardTargetSheet } from './forward-sheet';
import { ubpIcon } from './icons';
import { openPhoneLightbox } from './image-lightbox';
import { avatarHtml, bindLongPress, createViewScrollMemo, escapeAttr, escapeHtml, longPressJustFired, openActionSheet, openApp, pulseActIcon } from './phone-ui';
import { openActionSheet as openActionSheetCore, openConfirmSheet } from './action-sheet';
import { feedMoreHtml, renderSocialShell, socialDetailNav, type SocialTabDef } from './social-shell';
import {
  aboutImageKey,
  dmImageKey,
  imageKeyPostId,
  nzAboutCard,
  nzEmpty,
  nzPostCard,
  nzPostDetail,
  postImageKey,
  type NightUiCtx,
} from './night-views';
import { nzLiveCard, nzLiveRoom, nzStageEmpty } from './night-stage';
import { nightDmMsgPreview, nzDateProgress, nzDmList, nzDmRoom, nzPersonaCard, nzViewer } from './night-dm';
import { bindHintLongPress, openOneShotHintSheet } from './hint-sheet';
import { emitAch, emitActionOnDate } from '../core/phone-achievements';

type NightTab = 'street' | 'stage' | 'dm' | 'me';

export const NIGHT_TABS: Array<{ id: NightTab; icon: string }> = [
  { id: 'street', icon: ubpIcon('forum') },
  { id: 'stage', icon: ubpIcon('hot') },
  { id: 'dm', icon: ubpIcon('message') },
  { id: 'me', icon: ubpIcon('user') },
];

function tabLabel(id: NightTab, style: '' | 'xianxia' | 'wuxia' | 'fantasy'): string {
  if (id === 'street') return nt('street', style);
  if (id === 'stage') return nt('stage', style);
  if (id === 'dm') return nt('dm', style);
  return '我的';
}

// ─── 模块状态（单实例 App；mount 重置） ───

let _ctx: PhoneAppContext | null = null;
let _tab: NightTab = 'street';
let _error = '';
let _toast = '';
let _toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 街区筛选（纯前端，零 AI；只筛板块/标签/尺度档，不隐藏任何尺度内容）。 */
let _board = '';
let _tag = '';
let _spiceOnly: NightSpice | 0 = 0;
/** 已展开的楼中楼键（换帖清空）。 */
const _openThreads = new Set<string>();
/** 信息流分页（首屏 10 条，触底增量）。 */
const FEED_PAGE = 10;
let _feedVisible = FEED_PAGE;
let _feedHasMore = false;
// 跨视图滚动记忆：街区/舞台/搭话/我的 与各详情页（帖/直播/私信/约会/档案/关于我/查看器）各记各的
// （列表→详情→返回不会回顶，见 phone-ui createViewScrollMemo）
const _viewScroll = createViewScrollMemo();
let _pendingTop: number | null = null; // 扩页未达记忆位时的跨帧目标（递归渲染仍要落回原目标）

let _openPostId: string | null = null;
let _openAboutPostId: string | null = null;
let _aboutOpen = false;
let _openLiveId: string | null = null;
let _openDmId: string | null = null;
let _openDateId: string | null = null;
let _personaName: string | null = null;
/**
 * 档案卡来处快照（进卡前的次级视图：帖 / 传闻 / 直播间 / 搭话 / 约会）。
 * 退出档案卡按它回到来处——此前只 clearSecondaryViews() 不回填，
 * 「搭话会话 / 帖子详情 / 直播间 → 档案卡 → 返回」都会落到列表页而不是原页。
 */
let _personaBack: { postId?: string; aboutId?: string; liveId?: string; dmId?: string; dateId?: string } = {};
let _viewer: { keys: string[]; index: number; author: string; boardLabel: string } | null = null;
/** 我的 tab 的子视图（消息流也在这一 tab 下，保持底部 5 槽与项目社媒一致）。 */
type NightMeView = 'main' | 'msg' | 'posts' | 'favs' | 'follows';
let _meView: NightMeView = 'main';
/** 本次会话私密收藏夹已解锁（长按 2 秒；不落盘）。 */
let _favUnlocked = false;

/** 直播间：礼物面板 / 点单输入 展开态（ED-05 降密——礼物收进 🎁 面板、点单收进「更多」）。 */
let _giftOpen = false;
let _orderOpen = false;

/** 上次失败尝试（重试钮重放）。 */
let _lastAttempt: { kind: 'refresh' | 'board' | 'keyword' | 'more' | 'lives' | 'about'; board?: string; keyword?: string; hint: string; picked: string[] } | null = null;

/** 发布面板状态（null=未打开）。 */
let _composer: {
  board: string;
  kind: 'text' | 'gallery' | 'bounty';
  spice: NightSpice;
  title: string;
  text: string;
  tags: string[];
  imgPath: string;
  imgDesc: string;
  cameraMode: boolean;
  want: string;
  spiceWanted: NightSpice;
  reward: string;
} | null = null;

/** 评论浮层状态。 */
let _commentTarget: { postId: string; about?: boolean; replyTo?: string; text: string } | null = null;
/** 约见卡浮层状态。 */
let _dateDraft: { peer: string; place: string; note: string } | null = null;
/** 开台浮层状态。 */
let _liveDraft: { title: string; coverDesc: string; spice: NightSpice } | null = null;
/** 马甲改名浮层。 */
let _aliasDraft: string | null = null;
/** 私信单条编辑浮层（目标会话/消息 + 草稿）。 */
let _dmEdit: { dmId: string; msgId: string; text: string } | null = null;

/** 视图状态（街区筛选 / 分页 / 发布面板草稿；渲染函数一律显式入参——纯视图层，可被测试与渲染验收直接调用）。 */
export interface NightViewState {
  board: string;
  tag: string;
  spiceOnly: NightSpice | 0;
  feedVisible: number;
  composer: ComposerState | null;
  favUnlocked: boolean;
  meView: NightMeView;
}

export interface ComposerState {
  board: string;
  kind: 'text' | 'gallery' | 'bounty';
  spice: NightSpice;
  title: string;
  text: string;
  tags: string[];
  imgPath: string;
  imgDesc: string;
  cameraMode: boolean;
  want: string;
  spiceWanted: NightSpice;
  reward: string;
}

/** 当前状态快照（render 与导出视图共用）。 */
export function nightUiState(): NightViewState {
  return {
    board: _board, tag: _tag, spiceOnly: _spiceOnly,
    feedVisible: _feedVisible, composer: _composer, favUnlocked: _favUnlocked, meView: _meView,
  };
}

// ─── 工具 ───

/** 帧级渲染上下文（渲染验收台与测试复用同一入口）。 */
export function nightUiCtx(): NightUiCtx {
  return {
    style: currentStyle(),
    me: getRoster().protagonistName,
    alias: nightAlias(),
    now: getRoster().global.time,
    favUnlocked: _favUnlocked,
  };
}

/** P1：只读域引用（夜谈各视图只读，写一律走 mutate*）——原先每次渲染都整机深拷贝。 */
function nightData(): NightData {
  return readNightOf(readPhoneDataRef());
}

function toast(text: string): void {
  _toast = text;
  render();
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    _toastTimer = null;
    _toast = '';
    if (_ctx) render();
  }, 2400);
}

function fail(e: unknown): void {
  if (isPhoneAbortError(e)) { toast(S('已终止', '已终止')); return; }
  _error = e instanceof Error ? e.message : String(e);
}

/** 读侧过滤条件（板块/标签/只看某档；纯列表筛选，没有任何本机屏蔽）。 */
export function nightFilterOf(st: Pick<NightViewState, 'board' | 'tag' | 'spiceOnly'>): Parameters<typeof filterNightPosts>[1] {
  return { spiceOnly: st.spiceOnly, board: st.board, tag: st.tag };
}

function findPost(id: string, data = nightData()): NightPost | null {
  return data.posts.find(p => p.id === id) || data.about?.items.find(p => p.id === id) || null;
}

/**
 * 删除口径（用户定案）：街区里**任何帖子都可删**——AI/路人帖与自己的帖同一口径，
 * 详情顶栏垃圾桶与长按面板共用（不再按作者过滤）。
 * 破坏性删除统一入口：落库只发生在确认回调里（与直播间删除同一条链路）。
 */
function confirmNightDelete(opts: { title: string; message: string; onConfirm: () => void }): void {
  if (!_ctx) return;
  openConfirmSheet(_ctx.container, {
    title: opts.title,
    message: opts.message,
    confirmLabel: '删除',
    onConfirm: opts.onConfirm,
  });
}

/**
 * 次级视图互斥：帖子 / 传闻 / 直播间 / 搭话 / 约会 / 档案卡 六者只能同时开一个。
 * 渲染优先级是固定的（post → about → live → dm → date → persona），所以任何一条进入路径
 * 都必须先清空其它 id——此前 persona/talk 只清了一部分，导致「直播间/搭话房间 → 档案卡」
 * 与「传闻详情 → 搭话」被更高优先级的旧视图挡在原页，点了没反应。
 */
function clearSecondaryViews(): void {
  _openPostId = null; _openAboutPostId = null; _openLiveId = null;
  _openDmId = null; _openDateId = null; _personaName = null;
}

/**
 * 打开档案卡（唯一入口）：先给当前次级视图打快照，再清空其它 id（档案卡渲染优先级最低，
 * 不清就会被旧视图挡在原页），退出时按快照回填（`back-persona`）。
 * 不在这里 render——调用点各自接渲染（动作面板里的点选走面板自己的 render）。
 */
function openPersona(name: string): void {
  _personaBack = {
    ...(_openPostId ? { postId: _openPostId } : {}),
    ...(_openAboutPostId ? { aboutId: _openAboutPostId } : {}),
    ...(_openLiveId ? { liveId: _openLiveId } : {}),
    ...(_openDmId ? { dmId: _openDmId } : {}),
    ...(_openDateId ? { dateId: _openDateId } : {}),
  };
  clearSecondaryViews();
  _personaName = name;
}

/** 搭话会话删除确认（对话页垃圾桶与长按面板共用）。 */
function confirmDeleteDm(dm: NightDm): void {
  confirmNightDelete({
    title: `删除与 ${dm.peer} 的会话？`,
    message: '对话记录、进行中的约会进度与相关通知会一并删除，不可恢复。',
    onConfirm: () => {
      if (deleteNightConversation(dm.id)) {
        emitPhoneEvent('ubp-phone:data-changed');
        _openDmId = null;
        toast('已删除会话');
      }
      render();
    },
  });
}

/** 帖子/传闻共用的删除确认（标题按来源分档，动作同一套）。 */
function confirmDeletePost(post: NightPost): void {
  const about = post.kind === 'about';
  const where = about ? '传闻' : '街区';
  confirmNightDelete({
    title: about ? '删除这条传闻？' : '删除这条帖子？',
    message: `删除后不再出现在${where}，其评论与相关通知一并作废，不可恢复。`,
    onConfirm: () => {
      if (deleteNightPost(post.id)) {
        emitPhoneEvent('ubp-phone:data-changed');
        _openPostId = null; _openAboutPostId = null;
        toast('已删除');
      }
      render();
    },
  });
}

function findLive(id: string, data = nightData()): NightLive | null {
  return data.lives.find(l => l.id === id) || null;
}

function findDm(id: string, data = nightData()): NightDm | null {
  return data.dms.find(d => d.id === id) || null;
}

/** 帖子图片 key 列表（详情/查看器共用；about 帖用 a: 前缀）。 */
function imageKeysOf(post: NightPost, about = false): string[] {
  return post.images.map((_img, i) => (about ? aboutImageKey(post.id, i) : postImageKey(post.id, i)));
}

/** 一张图 key 所属的浏览序列（放大页序列）：帖子=该帖图组；搭话=该对话里的图片消息；作品图/封面=单张。 */
function viewerKeysOfKey(key: string): string[] {
  if (key.startsWith('p:') || key.startsWith('a:')) {
    const post = findPost(imageKeyPostId(key));
    return post ? imageKeysOf(post, key.startsWith('a:')) : [key];
  }
  if (key.startsWith('d:')) {
    const dmId = key.split(':')[1] || '';
    const dm = findDm(dmId);
    return (dm?.msgs || []).filter(m => m.type === 'image' && m.image).map(m => dmImageKey(dmId, m.id));
  }
  return [key];
}

// ─── 街区 ───

export function streetTop(ctx: NightUiCtx, st: NightViewState): string {
  const unread = nightUnread();
  return `<div class="ubp-nz-top">
    <div class="ubp-nz-toprow">
      <div class="ubp-nz-brand">
        <span class="ubp-nz-mark">${ubpIcon('nightBrand')}</span>
        <span class="ubp-nz-words">
          <span class="ubp-nz-wordrow">
            <b class="ubp-nz-word">${escapeHtml(nt('app', ctx.style))}</b>
            <i class="ubp-nz-beta">（beta）</i>
          </span>
          <i class="ubp-nz-slogan">${escapeHtml(nt('slogan', ctx.style))}</i>
        </span>
      </div>
      <div class="ubp-stop-acts">
        <button type="button" class="ubp-nz-aboutbtn" data-ubp-act="open-about-page" title="他们怎么谈论你">关于我</button>
        <button class="ubp-iconbtn ubp-sbell${unread ? ' has' : ''}" data-ubp-act="open-msg" title="消息（${unread} 条未读）">${ubpIcon('bell')}</button>
        <button class="ubp-iconbtn" data-ubp-act="refresh" title="刷新今夜（按最新剧情生成整版新内容）" ${isNightBusy() ? 'disabled' : ''}>
          <span class="${isNightBusy() ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span>
        </button>
      </div>
    </div>
    <div class="ubp-nz-boards wrap">
      <button type="button" class="ubp-nz-bchip${st.board === '' ? ' on' : ''}" data-ubp-act="board" data-id="">全部</button>
      ${NIGHT_BOARDS.map(def => {
        const live = readPhoneDataRef().night?.boards.some(b => b.id === def.id) !== false;
        if (!live) return '';
        return `<button type="button" class="ubp-nz-bchip${st.board === def.id ? ' on' : ''}" data-ubp-act="board" data-id="${escapeAttr(def.id)}" style="--nz-bc:${escapeAttr(def.tint)}" title="长按：只看这个板块的新内容">${escapeHtml(nightBoardGlyph(def.id))} ${escapeHtml(nightBoardName(def.id, ctx.style))}</button>`;
      }).join('')}
      ${(st.tag || st.spiceOnly) ? `<button type="button" class="ubp-nz-bchip clear" data-ubp-act="clear-filter">清除筛选 ✕</button>` : ''}
    </div>
    ${st.tag ? `<div class="ubp-nz-filterbar">标签：#${escapeHtml(st.tag)}<button type="button" data-ubp-act="clear-filter">清除</button></div>` : ''}
    ${st.spiceOnly ? `<div class="ubp-nz-filterbar">只看：${escapeHtml(nightSpiceLabel(st.spiceOnly, ctx.style))}<button type="button" data-ubp-act="clear-filter">清除</button></div>` : ''}
  </div>`;
}

/** body 构造函数统一收 data 形参（帧内复用同一份引用，不在函数里二次读取）；缺参时自取。 */
export function streetBody(ctx: NightUiCtx, st: NightViewState, data?: NightData): string {
  const night = data ?? nightData();
  const posts = filterNightPosts(night.posts, nightFilterOf(st));
  const { page, hasMore, remaining } = paginate(posts, st.feedVisible);
  _feedHasMore = hasMore;
  if (!night.posts.length) {
    return nzEmpty(`${nt('street', ctx.style)}还没有人说话`);
  }
  if (!posts.length) {
    return nzEmpty('当前筛选下没有内容');
  }
  return `<div class="ubp-nz-feed">${page.map(p => nzPostCard(p, ctx)).join('')}</div>${hasMore ? feedMoreHtml(remaining) : ''}`;
}

function paginate<T>(items: T[], visible: number): { page: T[]; hasMore: boolean; remaining: number } {
  const shown = Math.max(0, Math.floor(visible) || 0);
  const hasMore = items.length > shown;
  return { page: items.slice(0, shown), hasMore, remaining: hasMore ? items.length - shown : 0 };
}

/** 我的台（主角开台入口 + 自己的台）。 */
export function myLiveStrip(ctx: NightUiCtx, data: NightData): string {
  const mine = data.lives.filter(l => l.byMe);
  return `<div class="ubp-nz-mylive">
    <button type="button" class="ubp-nz-btn primary" data-ubp-act="start-live">我要开台（${escapeHtml(ctx.alias)}）</button>
    ${mine.length ? `<span class="ubp-nz-mylivemeta">自己的台 ${mine.length} 个</span>` : ''}
  </div>`;
}

/** 帖子 → 分享快照（转发进微信；正文 + 配图描述 + 评论；不含计数）。 */
function nightShareSnapshot(post: NightPost): SharePostSnapshot {
  return {
    app: 'night',
    author: post.author,
    ...(post.title ? { title: post.title } : {}),
    text: post.content,
    images: post.images.filter(img => img.desc).map(img => ({
      desc: img.desc,
      ...(img.path && img.status === 'ready' ? { imagePath: img.path } : {}),
    })),
    comments: post.comments.map(c => ({ name: c.name, text: c.text, ...(c.replyTo ? { replyTo: c.replyTo } : {}) })),
  };
}

/** 分享到聊天：整条帖转「聊天记录」消息 → 选目标 → 落库（上屏不触发 AI）。 */
function sharePostToChat(post: NightPost): void {
  if (!_ctx) return;
  const message = buildShareMessage(nightShareSnapshot(post), getRoster().global.time);
  if (!message) return;
  openForwardTargetSheet(_ctx, pick => {
    if (appendForwardedMessage(pick, message)) toast('已分享到聊天');
  });
}

// ─── 我的 ───

export function meBody(ctx: NightUiCtx, data: NightData): string {
  const me = data.me;
  const mine = data.posts.filter(p => p.byMe || p.author === ctx.alias);
  const favIds = new Set(me.favorites.map(f => f.id));
  const favPublic = [...data.posts, ...(data.about?.items || [])].filter(p => favIds.has(p.id) && !p.collectPrivate);
  const favPrivate = [...data.posts, ...(data.about?.items || [])].filter(p => favIds.has(p.id) && p.collectPrivate);
  const activeDate = nightActiveDate(me);
  const stealth = me.stealth !== false;
  return `<div class="ubp-nz-me">
    <div class="ubp-nz-mehead">
      ${avatarHtml(ctx.alias, 'ubp-bigava', true)}
      <div class="ubp-nz-memain">
        <div class="ubp-nz-mename">${escapeHtml(ctx.alias)}<i class="ubp-nz-mask">${escapeHtml(nt('alias', ctx.style))}</i></div>
        <div class="ubp-nz-mesub"><span class="nz-lv">Lv.<b>${me.level}</b></span><span class="nz-coin"><b>${me.coins}</b> ${escapeHtml(nt('coins', ctx.style))}</span>${nightUnread() ? `<span class="nz-unread">${nightUnread()} 条未读</span>` : ''}</div>
      </div>
      <button type="button" class="ubp-nz-follow ghost" data-ubp-act="alias-edit">改名</button>
      <button type="button" class="ubp-nz-follow ghost" data-ubp-act="alias-regen" title="让 AI 重新起一个马甲">↻</button>
    </div>
    <div class="ubp-nz-mestats">
      <button type="button" class="ubp-nz-mestat" data-ubp-act="my-posts"><b>${mine.length}</b><span>我的${escapeHtml(nt('post', ctx.style))}</span></button>
      <button type="button" class="ubp-nz-mestat${_meView === 'favs' ? ' on' : ''}" data-ubp-act="my-favs"><b>${favPublic.length}${favPrivate.length ? `<i>+${favPrivate.length}🔒</i>` : ''}</b><span>收藏夹</span></button>
      <button type="button" class="ubp-nz-mestat${_meView === 'follows' ? ' on' : ''}" data-ubp-act="my-follows"><b>${me.follows.length}</b><span>关注</span></button>
    </div>

    <div class="ubp-nz-mecard">
      <div class="ubp-nz-cmhd">隐身浏览</div>
      <div class="ubp-nz-merow">
        <span title="${escapeAttr(stealth ? '浏览不留痕、不收到「与我相关」的通知、不出现在对方「谁看过」里' : '你的浏览会留下痕迹，可能收到相关通知')}">隐身浏览 · ${stealth ? '开' : '关'}</span>
        <button type="button" class="ubp-nz-switch${stealth ? ' on' : ''}" data-ubp-act="stealth"><i></i></button>
      </div>
    </div>

    <div class="ubp-nz-mecard">
      <div class="ubp-nz-cmhd">我的${escapeHtml(nt('date', ctx.style))}</div>
      ${me.dates.length
        ? me.dates.slice().reverse().map(d => `<button type="button" class="ubp-nz-daterow" data-ubp-act="open-date" data-id="${escapeAttr(d.id)}">
            ${avatarHtml(d.peer, '', true)}
            <div class="ubp-nz-amain"><div class="ubp-nz-aname">${escapeHtml(d.peer)}</div><div class="ubp-nz-asub">${escapeHtml(d.place || '地点待定')} · ${escapeHtml(nightDateStatusLabel(d.status))} · ${d.step}/${d.maxStep} 段</div></div>
            <span class="ubp-nz-go">›</span>
          </button>`).join('')
        : '<div class="ubp-nz-empty">还没有约过人——去搭话里发一张约见卡</div>'}
      ${activeDate ? `<div class="ubp-nz-tip">同时只能有一个人在约：当前进行中的是 ${escapeHtml(activeDate.peer)}。</div>` : ''}
    </div>

    <div class="ubp-nz-mecard">
      <div class="ubp-nz-cmhd">打赏与被拒记录</div>
      ${me.rejections.length
        ? me.rejections.slice(-4).reverse().map(r => `<div class="ubp-nz-rej"><b>${escapeHtml(r.peer)}</b> 拒绝了你的点单：${escapeHtml(r.reason || '（未说明）')}</div>`).join('')
        : '<div class="ubp-nz-empty">还没有被拒过——点单前先看 TA 的档案卡底线</div>'}
    </div>

    <div class="ubp-nz-standing">${escapeHtml(NIGHT_STANDING_LINE)}</div>
    <div class="ubp-nz-mecard">
      <div class="ubp-nz-cmhd">数据</div>
      <div class="ubp-nz-merow"><span>保留内容数 ${getPhoneSettings().nightMaxPosts} · 板块 ${data.boards.length} 个</span><button type="button" class="ubp-nz-mini" data-ubp-act="settings">设置</button></div>
      <div class="ubp-nz-merow"><span>清空不夜城数据（含马甲/收藏/搭话，不可恢复）</span><button type="button" class="ubp-nz-mini danger" data-ubp-act="clear-data">清空</button></div>
    </div>
  </div>`;
}

/** 我的帖 / 收藏夹列表（复用卡片）。 */
export function meListBody(ctx: NightUiCtx, data: NightData, kind: 'posts' | 'favs' | 'follows'): string {
  const me = data.me;
  if (kind === 'posts') {
    const mine = data.posts.filter(p => p.byMe || p.author === ctx.alias);
    return `<div class="ubp-nz-feed">${mine.map(p => nzPostCard(p, ctx)).join('')}</div>`
      || nzEmpty(`还没有发过${nt('post', ctx.style)}`);
  }
  if (kind === 'follows') {
    if (!me.follows.length) return nzEmpty('还没有关注谁');
    return `<div class="ubp-nz-follows">${me.follows.map(name => `<div class="ubp-nz-followrow">
      ${avatarHtml(name, '', true)}
      <div class="ubp-nz-amain"><div class="ubp-nz-aname">${escapeHtml(name)}</div><div class="ubp-nz-asub">关注中</div></div>
      <button type="button" class="ubp-nz-mini" data-ubp-act="persona" data-id="${escapeAttr(name)}">档案</button>
      <button type="button" class="ubp-nz-mini" data-ubp-act="follow" data-id="${escapeAttr(name)}">取关</button>
    </div>`).join('')}</div>`;
  }
  const favIds = new Set(me.favorites.map(f => f.id));
  const locked = getPhoneSettings().nightFavLock !== false && !_favUnlocked;
  const pub = [...data.posts, ...(data.about?.items || [])].filter(p => favIds.has(p.id) && !p.collectPrivate);
  const prv = [...data.posts, ...(data.about?.items || [])].filter(p => favIds.has(p.id) && p.collectPrivate);
  return `<div class="ubp-nz-favsec">
    <div class="ubp-nz-cmhd">公开收藏 ${pub.length}</div>
    <div class="ubp-nz-feed">${pub.map(p => nzPostCard(p, ctx)).join('') || '<div class="ubp-nz-empty">公开收藏还是空的</div>'}</div>
  </div>
  <div class="ubp-nz-favsec">
    <div class="ubp-nz-cmhd">私密收藏 ${prv.length}${locked ? ' 🔒' : ''}</div>
    ${locked
      ? `<button type="button" class="ubp-nz-favlock" data-ubp-act="fav-unlock">长按 2 秒解锁私密收藏夹</button>`
      : `<div class="ubp-nz-feed">${prv.map(p => nzPostCard(p, ctx)).join('') || '<div class="ubp-nz-empty">私密收藏还是空的（长按帖子卡可存进这里）</div>'}</div>`}
  </div>`;
}

// ─── 消息（通知流） ───

const NOTIFY_ICON: Record<string, string> = {
  reply: '💬', post: '📌', live: '🔴', entry: '🎯', dm: '✉️', order: '🎤', spot: '⭐', reject: '🚫', unlock: '🔓',
};

export function messagesBody(ctx: NightUiCtx, data: NightData): string {
  const unread = data.notifications.filter(n => !n.read).length;
  const head = `<div class="ubp-nz-msghead">新消息 · ${unread ? `${unread} 条未读` : '没有未读'}${unread ? '<button type="button" class="ubp-nz-mini" data-ubp-act="mark-all-read">全部已读</button>' : ''}</div>`;
  const rows = data.notifications.map(n => `<button type="button" class="ubp-nz-msgrow${n.read ? '' : ' unread'}" data-ubp-act="open-notify" data-id="${escapeAttr(n.id)}">
    <span class="ubp-nz-msgicon">${NOTIFY_ICON[n.type] || '🔔'}</span>
    <div class="ubp-nz-amain">
      <div class="ubp-nz-aname">${escapeHtml(n.author)}<i class="ubp-nz-ntype">${escapeHtml(notifyLabel(n.type))}</i></div>
      <div class="ubp-nz-msgtext">${escapeHtml(n.content)}</div>
      <div class="ubp-nz-asub">${escapeHtml(nightTimeText({ timeLabel: n.time, storyStamp: n.storyStamp }, ctx.now))}</div>
    </div>
    ${n.read ? '' : '<i class="ubp-nz-dmdot">·</i>'}
  </button>`).join('');
  return `<div class="ubp-nz-msgs">${head}
    ${rows || nzEmpty('暂无新消息')}
    <div class="ubp-nz-standing">${escapeHtml(NIGHT_READONLY_NOTE)}</div>
  </div>`;
}

export function notifyLabel(type: string): string {
  const map: Record<string, string> = {
    reply: '回复了你', post: `发了新${nt('post', '')}`, live: '开台了', entry: '应征了你的委托',
    dm: '给你发了消息', order: '回应了你的点单', spot: '点了你的名', reject: '拒绝了你的点单', unlock: '同意了你的求解锁',
  };
  return map[type] || '有新动静';
}

// ─── 专题页：他们怎么谈论你（N6） ───

export function aboutPageBody(ctx: NightUiCtx, data: NightData, st: NightViewState): string {
  const about: NightAbout | null = data.about || null;
  const items = about?.items || [];
  const visible = filterNightPosts(items, { ...nightFilterOf(st), board: '', tag: '' });
  const hero = `<div class="ubp-nz-abouthero">
    <div class="ubp-nz-abouthd">他们怎么谈论你</div>
    <div class="ubp-nz-aboutsub">只读正文里已经发生、已经说过、被人看见的片段——这个世界关于你的传闻。</div>
    <div class="ubp-nz-aboutmeta">${items.length} 条${about?.refreshedAt ? ` · 上次刷新 ${escapeHtml(nightTimeText({ timeLabel: '', storyStamp: '' }, ctx.now) || '刚刚')}` : ''}</div>
  </div>`;
  return `${hero}
    ${items.length ? `<div class="ubp-nz-feed">${visible.map(p => nzAboutCard(p, ctx)).join('')}</div>` : nzEmpty('还没有人谈论你')}
    ${items.length && !visible.length ? '<div class="ubp-nz-empty">当前筛选下没有内容</div>' : ''}`;
}

// ─── 发布面板 ───

export function composeBody(ctx: NightUiCtx, st: NightViewState): string {
  const c = st.composer!;
  const def = nightBoardDef(c.board);
  const tagsHtml = NIGHT_TAGS.map(t => `<button type="button" class="ubp-nz-tag${c.tags.includes(t) ? ' on' : ''}" data-ubp-act="compose-tag" data-id="${escapeAttr(t)}">${escapeHtml(t)}</button>`).join('');
  return `<div class="ubp-nz-compose">
    ${socialDetailNav({ backAct: 'compose-cancel', title: `发布${nt('post', ctx.style)}`, sub: `署名 ${ctx.alias}` })}
    <div class="ubp-nz-cpbody">
      <div class="ubp-nz-cpsec">
        <div class="ubp-nz-cphd">板块</div>
        <div class="ubp-nz-boards wrap">
          ${NIGHT_BOARDS.map(b => `<button type="button" class="ubp-nz-bchip${c.board === b.id ? ' on' : ''}" data-ubp-act="compose-board" data-id="${escapeAttr(b.id)}" style="--nz-bc:${escapeAttr(b.tint)}">${escapeHtml(nightBoardGlyph(b.id))} ${escapeHtml(nightBoardName(b.id, ctx.style))}</button>`).join('')}
        </div>
        <div class="ubp-nz-cphint">${escapeHtml(def?.brief.slice(0, 54) || '')}…</div>
      </div>
      <div class="ubp-nz-cpsec">
        <div class="ubp-nz-cphd">类型</div>
        <div class="ubp-nz-chips">
          ${([['text', '纯文字'], ['gallery', '图集'], ['bounty', '委托']] as const).map(([id, label]) =>
            `<button type="button" class="ubp-nz-chip${c.kind === id ? ' on' : ''}" data-ubp-act="compose-kind" data-id="${id}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="ubp-nz-cpsec">
        <div class="ubp-nz-cphd">尺度</div>
        <div class="ubp-nz-chips">
          ${([1, 2, 3] as NightSpice[]).map(sp => `<button type="button" class="ubp-nz-chip spice s${sp}${c.spice === sp ? ' on' : ''}" data-ubp-act="compose-spice" data-idx="${sp}">${escapeHtml(nightSpiceLabel(sp, ctx.style))}</button>`).join('')}
        </div>
        <div class="ubp-nz-cphint">高于该板块上限（${escapeHtml(nightSpiceLabel(nightBoardDef(c.board)?.spiceMax ?? 3, ctx.style))}）会自动降到板块上限。</div>
      </div>
      <input class="ubp-nz-cptitle" data-ubp-input="compose-title" maxlength="30" placeholder="标题（≤30 字）" value="${escapeAttr(c.title)}">
      <textarea class="ubp-nz-cptext" data-ubp-input="compose-text" rows="5" placeholder="${escapeHtml(c.kind === 'bounty' ? '说清楚你想要什么、交给谁、什么时候要' : '正文：直白点，写清楚发生了什么')}">${escapeHtml(c.text)}</textarea>
      ${c.kind === 'bounty' ? `<div class="ubp-nz-cpsec">
        <div class="ubp-nz-cphd">委托要求</div>
        <textarea class="ubp-nz-cptext small" data-ubp-input="compose-want" rows="2" placeholder="想要什么（≤120 字）：求图 / 求文 / 求剧情">${escapeHtml(c.want)}</textarea>
        <input class="ubp-nz-cptitle small" data-ubp-input="compose-reward" maxlength="40" placeholder="悬赏（如：300 硬币 + 榜一署名）" value="${escapeAttr(c.reward)}">
      </div>` : ''}
      ${c.kind !== 'bounty' ? `<div class="ubp-nz-cpimg">
        ${c.imgPath
          ? `<button type="button" class="ubp-nz-cpcover" data-ubp-act="compose-cover"><img src="${escapeAttr(c.imgPath)}" alt=""></button>`
          : `<button type="button" class="ubp-nz-cpcover" data-ubp-act="compose-cover">${ubpIcon('plus')}<span>${c.cameraMode ? '描述生图' : '加一张图'}</span></button>`}
        ${!c.imgPath && !c.cameraMode ? `<button type="button" class="ubp-nz-mini" data-ubp-act="compose-camera">改成描述生图</button>` : ''}
        ${c.cameraMode && !c.imgPath ? `<textarea class="ubp-nz-cptext small" data-ubp-input="compose-imgdesc" rows="2" placeholder="画面描述（发布后按描述生图）">${escapeHtml(c.imgDesc)}</textarea>` : ''}
      </div>` : ''}
      <div class="ubp-nz-cpsec">
        <div class="ubp-nz-cphd">标签（${c.tags.length}/${NIGHT_TAGS_PER_POST}）</div>
        <div class="ubp-nz-tagpick">${tagsHtml}</div>
      </div>
      ${def?.imageMode === 'must' ? '<div class="ubp-nz-tip">这个板块每条都带图——发布后按描述生成。</div>' : ''}
    </div>
    <div class="ubp-nz-cpbar">
      <span class="ubp-nz-cphint">署名 ${escapeHtml(ctx.alias)}（${escapeHtml(nt('alias', ctx.style))}）</span>
      <button type="button" class="ubp-nz-cpsend" data-ubp-act="compose-send">发布</button>
    </div>
  </div>`;
}

// ─── 主渲染 ───

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const prevBody = container.querySelector('.ubp-appbody');
  const prevScrollTop = prevBody?.scrollTop ?? 0;
  const prevDmRoom = container.querySelector('.ubp-nz-dmroom') as HTMLElement | null;
  const prevDmId = prevDmRoom?.dataset.nzDm || '';
  const prevDmCount = prevDmRoom ? prevDmRoom.querySelectorAll('.ubp-nz-bubrow[data-nz-mid]').length : -1;
  const prevAtBottom = prevBody
    ? prevBody.scrollTop + prevBody.clientHeight >= prevBody.scrollHeight - 8
    : false;
  // 发布页自身的内滚区与直播间礼物条都是「整帧重建即换元素」：前者纵向（选标签/切板块后不回头顶），
  // 后者横向（打赏后刚横滑到的贵价礼物留在视野内）。两者都只在对应视图才有，取不到即 0 = 无副作用。
  const prevComposeTop = container.querySelector('.ubp-nz-cpbody')?.scrollTop ?? 0;
  const prevGiftLeft = container.querySelector('.ubp-nz-gifts')?.scrollLeft ?? 0;
  _feedHasMore = false;

  const ctx = nightUiCtx();
  const st = nightUiState();
  const data = nightData();
  const settings = getPhoneSettings();
  const busy = isNightBusy();
  const autoBusy = isNightAutoImageRunning();

  const openPost = _openPostId ? findPost(_openPostId, data) : null;
  const openAboutPost = _openAboutPostId ? (data.about?.items.find(p => p.id === _openAboutPostId) || null) : null;
  const openLive = _openLiveId ? findLive(_openLiveId, data) : null;
  const openDm = _openDmId ? findDm(_openDmId, data) : null;
  const openDate = _openDateId ? (data.me.dates.find(d => d.id === _openDateId) || null) : null;
  const persona = _personaName ? (readNightPersona(_personaName) || nightPersonaFallback(_personaName)) : null;
  const personaCached = _personaName ? Boolean(readNightPersona(_personaName)) : false;

  // 私聊房的生成反馈由底部 typing 气泡承载（终止钮也在气泡里），不再叠顶部加载条；错误提示照常保留。
  const busyHtml = `
    ${_error ? `<div class="ubp-nz-error">${escapeHtml(_error)}<button type="button" class="ubp-nz-mini" data-ubp-act="retry">重试</button></div>` : ''}
    ${data.lastError ? `<div class="ubp-nz-error">${escapeHtml(data.lastError.text)}<button type="button" class="ubp-nz-mini" data-ubp-act="dismiss-error">知道了</button></div>` : ''}
    ${busy && !openDm ? `<div class="ubp-nz-loading"><span class="ubp-spinner"></span>生成中…<button type="button" class="ubp-nz-mini" data-ubp-act="abort">终止</button></div>` : ''}
    ${autoBusy ? '<div class="ubp-nz-loading"><span class="ubp-spinner"></span>正在批量洗照片…</div>' : ''}`;

  // 滚动记忆视图键：每个二级页独立，Tab 页按 tab+子视图分记（键变=换视图，进详情从顶部开始）
  const viewKey = _viewer ? 'viewer'
    : openPost ? `post:${openPost.id}`
    : openAboutPost ? `aboutpost:${openAboutPost.id}`
    : openLive ? `live:${openLive.id}`
    : openDm ? `dm:${openDm.id}`
    : openDate ? `date:${openDate.id}`
    : persona ? `persona:${_personaName}`
    : _aboutOpen ? 'aboutme'
    : `${_tab}:${_meView}`;

  // 全屏视图优先级：发布面板 > 查看器 > 详情/次级页 > Tab
  if (_composer) {
    _viewScroll.settle('compose', prevScrollTop); // 发布页全屏（无 .ubp-appbody）：只把旧视图位置记进记忆
    container.innerHTML = `<div class="ubp-nz ubp-nz-full">${composeBody(ctx, st)}${toastHtml()}</div>`;
    const cpBody = container.querySelector('.ubp-nz-cpbody');
    if (cpBody && prevComposeTop) cpBody.scrollTop = prevComposeTop;
    return;
  }

  let topHtml = '';
  let bodyInner = '';
  let showTabbar = true;

  if (_viewer) {
    showTabbar = false;
    topHtml = '';
    bodyInner = '';
  } else if (openPost || openAboutPost) {
    const post = (openPost || openAboutPost)!;
    const isAbout = Boolean(openAboutPost);
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: isAbout ? 'back-about' : 'back-list',
      title: isAbout ? '传闻' : nightBoardName(post.board, ctx.style),
      sub: `${nightSpiceLabel(post.spice, ctx.style)} · ${post.comments.length} 回复`,
      actsHtml: `<button class="ubp-iconbtn" data-ubp-act="share" data-id="${escapeAttr(post.id)}" title="分享到聊天">${ubpIcon('share')}</button>
        <button class="ubp-iconbtn" data-ubp-act="expand-post" data-id="${escapeAttr(post.id)}" title="跟一层（续写新回复）" ${busy ? 'disabled' : ''}>
          <span class="${busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('comment')}</span></button>
        <button class="ubp-iconbtn" data-ubp-act="del-post" data-id="${escapeAttr(post.id)}" title="删除">${ubpIcon('trash')}</button>`,
    });
    bodyInner = busyHtml + nzPostDetail(post, ctx, { openThreads: _openThreads, busy });
  } else if (openLive) {
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'back-live',
      title: openLive.streamer,
      sub: openLive.privateEntered ? nt('privateRoom', ctx.style) : `${nt('stage', ctx.style)} · ${openLive.title}`,
      actsHtml: `<button class="ubp-iconbtn" data-ubp-act="advance" data-id="${escapeAttr(openLive.id)}" title="推进一次" ${busy || openLive.status === 'ended' ? 'disabled' : ''}>
          <span class="${busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span></button>`,
    });
    bodyInner = busyHtml + nzLiveRoom(openLive, ctx, {
      orderEnabled: settings.nightOrders !== false,
      busy,
      barrages: [],
      privateEntered: openLive.privateEntered === true,
      giftOpen: _giftOpen,
      orderOpen: _orderOpen,
    });
  } else if (openDm) {
    showTabbar = false;
    const activeDate = nightActiveDate(data.me);
    topHtml = socialDetailNav({
      backAct: 'back-dm',
      title: openDm.peer,
      sub: openDm.sourceLabel || (openDm.online ? '在线' : ''),
      actsHtml: `<button class="ubp-iconbtn" data-ubp-act="persona" data-id="${escapeAttr(openDm.peer)}" title="档案卡">${ubpIcon('user')}</button>`,
    });
    bodyInner = busyHtml + nzDmRoom(openDm, ctx, {
      busy,
      activeDate,
      datesEnabled: settings.nightDates !== false,
      dateLookup: id => data.me.dates.find(d => d.id === id) || null,
    });
  } else if (openDate) {
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'back-date',
      title: `${openDate.peer} · ${nt('date', ctx.style)}`,
      sub: `${nightDateStatusLabel(openDate.status)} · ${openDate.step}/${openDate.maxStep} 段`,
    });
    bodyInner = busyHtml + nzDateProgress(openDate, ctx, { busy });
  } else if (persona) {
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'back-persona',
      title: `${persona.name} · 档案`,
      sub: personaCached ? 'AI 生成（含偏好与底线）' : '本地资料',
      actsHtml: `<button class="ubp-iconbtn" data-ubp-act="regen-persona" data-id="${escapeAttr(persona.name)}" title="重新生成档案" ${busy ? 'disabled' : ''}>
          <span class="${busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span></button>`,
    });
    bodyInner = busyHtml + nzPersonaCard(persona, ctx, {
      busy,
      cached: personaCached,
      followed: data.me.follows.includes(persona.name),
      // 有进行中的约时不出「约 TA 出来」（引擎一次只允许一场；那场的入口留在搭话对话页）
      canProposeDate: settings.nightDates !== false && !nightActiveDate(data.me),
    });
  } else if (_aboutOpen) {
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'back-street',
      title: '关于我',
      sub: '他们怎么谈论你',
      actsHtml: `<button class="ubp-iconbtn" data-ubp-act="refresh-about" title="从最近正文里捡出关于你的传闻" ${busy ? 'disabled' : ''}>
          <span class="${busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span></button>`,
    });
    bodyInner = busyHtml + aboutPageBody(ctx, data, st);
  } else if (_tab === 'me') {
    if (st.meView === 'favs') {
      topHtml = socialDetailNav({ backAct: 'back-me', title: '收藏夹', sub: _favUnlocked ? '私密已解锁（本次会话）' : '' });
      bodyInner = busyHtml + meListBody(ctx, data, 'favs');
    } else if (st.meView === 'follows') {
      topHtml = socialDetailNav({ backAct: 'back-me', title: '我的关注', sub: `${data.me.follows.length} 人` });
      bodyInner = busyHtml + meListBody(ctx, data, 'follows');
    } else if (st.meView === 'posts') {
      topHtml = socialDetailNav({ backAct: 'back-me', title: `我的${nt('post', ctx.style)}`, sub: '署名是马甲' });
      bodyInner = busyHtml + meListBody(ctx, data, 'posts');
    } else if (st.meView === 'msg') {
      topHtml = socialDetailNav({ backAct: 'back-me', title: '消息', sub: '与我相关' });
      bodyInner = busyHtml + messagesBody(ctx, data);
    } else {
      topHtml = socialDetailNav({ backAct: 'exit', title: nt('app', ctx.style), sub: nt('slogan', ctx.style) });
      bodyInner = busyHtml + meBody(ctx, data);
    }
  } else if (_tab === 'stage') {
    topHtml = socialDetailNav({
      backAct: 'exit',
      title: nt('stage', ctx.style),
      sub: '成人向直播 · 点单台',
      actsHtml: `<button class="ubp-iconbtn" data-ubp-act="refresh-lives" title="刷新开台列表" ${busy ? 'disabled' : ''}>
          <span class="${busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span></button>`,
    });
    const lives = data.lives.slice().sort((a, b) => (a.status === 'ended' ? 1 : 0) - (b.status === 'ended' ? 1 : 0) || b.heat - a.heat);
    bodyInner = busyHtml + myLiveStrip(ctx, data)
      + (lives.length ? `<div class="ubp-nz-lives">${lives.map(l => nzLiveCard(l, ctx)).join('')}</div>` : nzStageEmpty());
  } else if (_tab === 'dm') {
    topHtml = socialDetailNav({ backAct: 'exit', title: nt('dm', ctx.style), sub: '私信与约会' });
    bodyInner = busyHtml + nzDmList(data.dms, ctx);
  } else {
    topHtml = streetTop(ctx, st);
    bodyInner = busyHtml + streetBody(ctx, st, data);
  }

  const tabs: SocialTabDef[] = NIGHT_TABS.map(t => ({ id: t.id, label: tabLabel(t.id, ctx.style), icon: t.icon, ...(t.id === 'me' ? { badge: nightUnread() } : {}) }));
  // 私信底栏 sticky 贴底且自带留白：再叠尾部占位会在底栏与屏幕底之间留出一条空档
  const tailPad = openDm ? 0 : (showTabbar ? 12 : 20);
  container.innerHTML = renderSocialShell({
    appClass: 'ubp-nz',
    topHtml,
    bodyInner: `${bodyInner}${tailPad ? `<div style="height:${tailPad}px;"></div>` : ''}`,
    tabs,
    activeTab: _tab,
    composeAct: 'compose-page',
    showTabbar,
    extraHtml: `${_viewer ? renderViewer(ctx) : ''}${toastHtml()}${_commentTarget ? commentSheet() : ''}${_dateDraft ? dateSheet(ctx) : ''}${_liveDraft ? liveSheet(ctx) : ''}${_aliasDraft !== null ? aliasSheet() : ''}${_dmEdit ? dmEditSheet() : ''}`,
  });
  const body = container.querySelector('.ubp-appbody');
  if (body) {
    let target: number;
    if (openDm) {
      // 微信口径：首次进入会话 / 来了新消息 / 本来贴底 → 贴底；同会话无新消息 → 原位。
      const sameDm = prevDmId === openDm.id;
      const grew = sameDm && prevDmCount >= 0 && openDm.msgs.length > prevDmCount;
      _viewScroll.settle(viewKey, prevScrollTop, prevAtBottom);
      target = (!sameDm || grew || prevAtBottom) ? -1 : prevScrollTop; // -1 = 贴底
    } else {
      // 跨视图保位：详情/次级页首次进入从顶部开始，返回列表回到离开时读到的位置（同视图重绘=原位）
      target = _pendingTop !== null ? _pendingTop : _viewScroll.settle(viewKey, prevScrollTop).top;
    }
    _pendingTop = null;
    body.scrollTop = target < 0 ? body.scrollHeight : target;
    // 视口未满或记忆位超出已渲染高度 → 自动扩页（分页被重置/内容变短时也要够得着；有界递归，页面耗尽即停）
    if (_feedHasMore && target >= 0 && body.scrollHeight <= target + body.clientHeight + 1) {
      _pendingTop = target;
      loadMore();
    }
  }
  // 礼物条是横向滚动，走不了 _viewScroll（只记纵向）：单独回填横滚位置
  const gifts = container.querySelector('.ubp-nz-gifts');
  if (gifts && prevGiftLeft) gifts.scrollLeft = prevGiftLeft;
}

export function toastHtml(): string {
  return _toast ? `<div class="ubp-toast on">${escapeHtml(_toast)}</div>` : '';
}

function loadMore(): void {
  if (!_ctx) return;
  _feedVisible += FEED_PAGE;
  render();
}

// ─── 查看器 ───

function renderViewer(ctx: NightUiCtx): string {
  const v = _viewer!;
  const images = v.keys.map((key, i) => {
    const img = readNightImageByKey(key) || { desc: '' };
    const gated = Boolean(img.unlock?.consent && !img.unlocked);
    return {
      key,
      desc: img.desc || '',
      reveal: nightImageEffectiveReveal(img),
      ...(img.zones ? { zones: [...img.zones] } : {}), // readNightImageByKey 返回 live 引用：数组拷出，防查看器长期持有内部数组
      ...(img.path ? { path: img.path } : {}),
      ...(gated ? { gated: true, unlockLabel: '求解锁（需作者同意）' } : {}),
      index: i,
    };
  });
  const current = images[v.index] || images[0];
  return `<div class="ubp-nz-viewerwrap">${nzViewer({
    key: current?.key || '',
    images: images.map(x => ({ key: x.key, desc: x.desc, reveal: x.reveal, ...(x.zones ? { zones: x.zones } : {}), ...(x.path ? { path: x.path } : {}), ...(x.gated ? { gated: true } : {}) })),
    index: v.index,
    author: v.author,
    boardLabel: v.boardLabel,
    ctx,
    ...(current && 'unlockLabel' in current && current.unlockLabel ? { unlockLabel: current.unlockLabel } : {}),
  })}</div>`;
}

// ─── 浮层 ───

function commentSheet(): string {
  const t = _commentTarget!;
  return `<div class="ubp-overlay ubp-nz-sheet">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">${t.replyTo ? `回复 ${escapeHtml(t.replyTo)}` : '回复'}</div>
      <textarea class="ubp-textarea" data-ubp-input="comment-text" rows="3" placeholder="${escapeAttr(t.replyTo ? `回复 ${t.replyTo}…` : '说点什么…')}">${escapeHtml(t.text)}</textarea>
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="comment-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="comment-send">发送</button>
      </div>
    </div>
  </div>`;
}

function dateSheet(ctx: NightUiCtx): string {
  const d = _dateDraft!;
  return `<div class="ubp-overlay ubp-nz-sheet">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">约 ${escapeHtml(d.peer)} 出来</div>
      <input class="ubp-fieldinput" data-ubp-input="date-place" maxlength="40" placeholder="去哪（如：江边 / 他住处 / 车里）" value="${escapeAttr(d.place)}">
      <input class="ubp-fieldinput" data-ubp-input="date-note" maxlength="120" placeholder="由头一句话（如：就聊聊天）" value="${escapeAttr(d.note)}">
      <div class="ubp-sheet-body">发出去后进「${escapeHtml(nt('date', ctx.style))}进程」，一段一段推进；随时可暂停退出，进度留在手机里。</div>
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="date-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="date-send" data-id="${escapeAttr(d.peer)}">发出邀约</button>
      </div>
    </div>
  </div>`;
}

function liveSheet(ctx: NightUiCtx): string {
  const l = _liveDraft!;
  return `<div class="ubp-overlay ubp-nz-sheet">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">开台（署名 ${escapeHtml(ctx.alias)}）</div>
      <input class="ubp-fieldinput" data-ubp-input="live-title" maxlength="30" placeholder="台名（如：今晚不睡）" value="${escapeAttr(l.title)}">
      <textarea class="ubp-textarea" data-ubp-input="live-cover" rows="2" placeholder="台面画面描述（开台后按描述生图）">${escapeHtml(l.coverDesc)}</textarea>
      <div class="ubp-chips">
        ${([1, 2, 3] as NightSpice[]).map(sp => `<button type="button" class="ubp-chip${l.spice === sp ? ' on' : ''}" data-ubp-act="live-spice" data-idx="${sp}">${escapeHtml(nightSpiceLabel(sp, ctx.style))}</button>`).join('')}
      </div>
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="live-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="live-send">开台</button>
      </div>
    </div>
  </div>`;
}

function aliasSheet(): string {
  return `<div class="ubp-overlay ubp-nz-sheet">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">改马甲（≤8 字）</div>
      <input class="ubp-fieldinput" data-ubp-input="alias" maxlength="8" placeholder="新马甲" value="${escapeAttr(_aliasDraft || '')}">
      <div class="ubp-sheet-body">马甲只在这个应用里用；不能和任何角色或主角重名。</div>
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="alias-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="alias-save">保存</button>
      </div>
    </div>
  </div>`;
}

function dmEditSheet(): string {
  return `<div class="ubp-overlay ubp-nz-sheet">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">编辑消息</div>
      <textarea class="ubp-textarea" data-ubp-input="dm-edit" rows="3" maxlength="300">${escapeHtml(_dmEdit?.text || '')}</textarea>
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="dm-edit-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="dm-edit-save">保存</button>
      </div>
    </div>
  </div>`;
}

// ─── 生成动作 ───

/**
 * 起动一次生成并立刻渲染（时序契约，勿改）：引擎 withScope 在调用的同步段内登记 busy，
 * 所以「先起请求再 render」才能让顶部加载条与按钮转圈/禁用本帧即现；
 * 先 render 再 await 会让整个生成期没有反馈（历史 bug，tests/phone-night-busy.test.ts 锁）。
 */
function startGen<T>(start: () => Promise<T>): Promise<T> {
  const pending = start();
  render();
  return pending;
}

/** 起动自动批量洗照片并立刻渲染（同款时序：_autoRunning 也在同步段置位，「正在批量洗照片…」本帧即现）。 */
function startAutoImages(): void {
  const running = autoGenerateNightImages();
  render();
  void running.then(() => { if (_ctx) render(); });
}

async function doRefresh(a: { board?: string; keyword?: string; more?: boolean; hint?: string; picked?: string[] } = {}): Promise<void> {
  if (isNightBusy()) return;
  _error = '';
  try {
    const res = await startGen(() => refreshNight({
      ...(a.board ? { board: a.board } : {}),
      ...(a.keyword ? { keyword: a.keyword } : {}),
      ...(a.more ? { more: true } : {}),
      ...(a.hint ? { extraHint: a.hint } : {}),
      ...(a.picked && a.picked.length ? { focusNames: a.picked } : {}),
    }));
    emitPhoneEvent('ubp-phone:data-changed');
    _feedVisible = FEED_PAGE;
    toast(`今夜新增 ${res.added} 条`);
  } catch (e) {
    fail(e);
  } finally {
    startAutoImages();
  }
}

// ─── 事件委托 ───

function handleClick(event: Event): void {
  if (longPressJustFired()) return;
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const id = el.dataset.id || '';
  const key = el.dataset.key || '';
  const idx = Number(el.dataset.idx ?? '-1');

  switch (act) {
    case 'exit': _ctx?.closeApp(); break;
    case 'nav': {
      const next = (NIGHT_TABS.find(t => t.id === id)?.id || 'street') as NightTab;
      _tab = next;
      _openPostId = null; _openAboutPostId = null; _openLiveId = null; _openDmId = null; _openDateId = null; _personaName = null; _aboutOpen = false; _meView = 'main';
      _viewer = null;
      _feedVisible = FEED_PAGE;
      if (next === 'dm') markNightSeen({ all: true });
      render();
      break;
    }
    case 'back-list': _openPostId = null; _openThreads.clear(); render(); break;
    case 'back-about': _openAboutPostId = null; render(); break;
    case 'back-street': _aboutOpen = false; render(); break;
    case 'back-live': _openLiveId = null; _giftOpen = false; _orderOpen = false; render(); break;
    case 'back-dm': _openDmId = null; render(); break;
    case 'back-date': _openDateId = null; render(); break;
    case 'back-persona': {
      // 回到进卡前的次级视图（同一层级，不落列表）；目标已不在（被删/过期）则留在当前 Tab
      const back = _personaBack;
      _personaBack = {};
      _personaName = null;
      if (back.dmId && findDm(back.dmId)) { _tab = 'dm'; _openDmId = back.dmId; }
      else if (back.liveId && findLive(back.liveId)) { _tab = 'stage'; _openLiveId = back.liveId; }
      else if (back.postId && findPost(back.postId)) { _openPostId = back.postId; }
      else if (back.aboutId && findPost(back.aboutId)) { _openAboutPostId = back.aboutId; }
      else if (back.dateId) { _openDateId = back.dateId; }
      render();
      break;
    }
    case 'back-me': _meView = 'main'; render(); break;

    // 街区筛选（零 AI）
    case 'board': _board = id; _feedVisible = FEED_PAGE; render(); break;
    case 'clear-filter': _board = ''; _tag = ''; _spiceOnly = 0; _feedVisible = FEED_PAGE; render(); break;
    case 'tag-filter': _tag = _tag === id ? '' : id; _feedVisible = FEED_PAGE; render(); break;
    case 'spice-filter': {
      const sp = idx as NightSpice;
      _spiceOnly = _spiceOnly === sp ? 0 : sp;
      _feedVisible = FEED_PAGE;
      render();
      break;
    }
    case 'my-posts': _tab = 'me'; _meView = 'posts'; render(); break;

    // 街区生成
    case 'refresh': _lastAttempt = { kind: 'refresh', hint: '', picked: [] }; void doRefresh(); break;
    case 'refresh-about': _lastAttempt = { kind: 'about', hint: '', picked: [] }; void doAboutRefresh(); break;
    case 'refresh-lives': _lastAttempt = { kind: 'lives', hint: '', picked: [] }; void doLivesRefresh(); break;
    case 'retry': {
      const a = _lastAttempt;
      if (!a) { _error = ''; render(); break; }
      if (a.kind === 'refresh') void doRefresh({ hint: a.hint, picked: a.picked });
      else if (a.kind === 'board') void doRefresh({ board: a.board, hint: a.hint, picked: a.picked });
      else if (a.kind === 'lives') void doLivesRefresh(a.hint, a.picked);
      else void doAboutRefresh(a.hint, a.picked);
      break;
    }
    case 'abort': abortNightGeneration(); _error = ''; toast('已终止'); break;
    case 'dismiss-error':
      mutatePhoneData(d => { if (d.night?.lastError) delete d.night.lastError; });
      render();
      break;

    // 帖子
    case 'open-post': clearSecondaryViews(); _openPostId = id; _openThreads.clear(); markNightSeen({ postId: id }); render(); break;
    case 'open-about': clearSecondaryViews(); _openAboutPostId = id; _openThreads.clear(); markNightSeen({ postId: id }); render(); break;
    case 'expand-post': void doExpandPost(id); break;
    case 'like': { const liked = toggleNightLike(id); emitPhoneEvent('ubp-phone:data-changed'); if (liked) toast('已赞'); else render(); pulseActIcon(_ctx?.container ?? null, 'like', id); break; }
    case 'collect': {
      const favPrivate = el.dataset.pv === '1';
      const collected = toggleNightCollect(id, favPrivate);
      emitPhoneEvent('ubp-phone:data-changed');
      toast(collected ? (favPrivate ? '已收藏（私密夹）' : '已收藏') : '已取消收藏'); // toast 内部已 render
      pulseActIcon(_ctx?.container ?? null, 'collect', id); // 点亮脉冲：必须在重绘之后挂（重绘会丢类）
      break;
    }
    case 'follow': {
      const followed = toggleNightAuthorFollow(id);
      emitPhoneEvent('ubp-phone:data-changed');
      toast(followed ? `已关注 ${id}` : `已取关 ${id}`); // toast 内部已 render
      break;
    }
    case 'talk': {
      clearSecondaryViews();
      openNightDmFrom(id, `来自${nt('app', currentStyle())}`);
      const dm = nightData().dms.find(d => d.peer === id);
      _tab = 'dm'; _openDmId = dm?.id || null;
      render();
      break;
    }
    case 'persona': openPersona(id); render(); break;
    case 'regen-persona': void doPersona(id, true); break;
    case 'comment': _commentTarget = { postId: id, about: Boolean(_openAboutPostId), text: '' }; render(); break;
    case 'reply-c': {
      const post = findPost(id);
      const target = post?.comments[idx];
      if (target) _commentTarget = { postId: id, about: Boolean(_openAboutPostId || findPost(id)?.kind === 'about'), replyTo: target.name, text: '' };
      render();
      break;
    }
    case 'sub-open': {
      if (_openThreads.has(id)) _openThreads.delete(id);
      else _openThreads.add(id);
      render();
      break;
    }
    case 'comment-cancel': _commentTarget = null; render(); break;
    case 'comment-send': void sendComment(); break;
    case 'del-post': {
      const post = findPost(id);
      if (post) confirmDeletePost(post);
      break;
    }
    case 'adopt-entry': {
      const eid = el.dataset.eid || '';
      if (adoptNightEntry(id, eid)) {
        emitPhoneEvent('ubp-phone:data-changed');
        toast('已采纳这条应征');
      }
      render();
      break;
    }

    // 图片（分层揭开 / 洗照片 / 查看器）
    case 'reveal': {
      const img = readNightImageByKey(key);
      if (!img) break;
      if (img.unlock?.consent && !img.unlocked) { void doUnlock(key); break; }
      nightImageReveal(key, idx === 2 ? 2 : 1);
      emitPhoneEvent('ubp-phone:data-changed');
      render();
      break;
    }
    case 'zone': nightImageToggleZone(key, idx); emitPhoneEvent('ubp-phone:data-changed'); render(); break;
    case 'reveal-cycle': {
      const img = readNightImageByKey(key);
      if (!img) break;
      const cur = nightImageEffectiveReveal(img);
      const next = cur === 2 ? 0 : ((cur + 1) as 1 | 2);
      nightImageReveal(key, next);
      render();
      break;
    }
    case 'gen-img':
      void startGen(() => generateNightImage(key))
        .then(() => { emitPhoneEvent('ubp-phone:data-changed'); })
        .catch(e => toast(e instanceof Error ? e.message : String(e)))
        .finally(() => { if (_ctx) render(); });
      break;
    case 'zoom-img': {
      // 揭开后（L2）＝全机统一放大页（含「换一张」）；序列只收「已揭开且已生成」的图，
      // 未揭开的绝不进序列（反全知护栏：放大页同样不许看见没揭开的）。
      const paths: string[] = [];
      let startIndex = 0;
      for (const k of viewerKeysOfKey(key)) {
        const img = readNightImageByKey(k);
        if (!img?.path || img.status !== 'ready') continue;
        if (nightImageEffectiveReveal(img) !== 2) continue;
        if (k === key) startIndex = paths.length;
        paths.push(img.path);
      }
      if (!paths.length) break;
      openPhoneLightbox(_ctx?.container, { paths, startIndex });
      break;
    }
    case 'viewer-open': {
      // 「⋯」：揭图查看器（再揭一层 / 重新打码 / 存到相册 / 分享到搭话 + 缩略图跳转）
      const post = findPost(imageKeyPostId(key));
      if (!post) break;
      const about = Boolean(_openAboutPostId);
      const keys = imageKeysOf(post, about);
      const postIdx = keys.indexOf(key);
      _viewer = { keys, index: postIdx < 0 ? 0 : postIdx, author: post.author, boardLabel: nightBoardName(post.board, currentStyle()) };
      render();
      break;
    }
    case 'viewer-jump': _viewer && (_viewer.index = idx); render(); break;
    case 'close-viewer': _viewer = null; render(); break;
    case 'save-album': void doSaveAlbum(key); break;
    case 'send-dm': {
      const img = readNightImageByKey(key);
      const peers = nightData().dms;
      if (!img?.desc) break;
      if (!peers.length) { toast('还没有搭话对象——先去街区点开一条帖子'); break; }
      openActionSheet(_ctx!.container, {
        title: '分享到搭话',
        body: '选一个对象，把这张图发过去',
        items: peers.slice(0, 6).map(d => ({ act: d.peer, label: d.peer })),
        onPick: peer => {
          try {
            sendNightDmMessage(peer, { imageDesc: img.desc, ...(img.path ? { imagePath: img.path } : {}) });
            emitPhoneEvent('ubp-phone:data-changed');
            toast(`已发给 ${peer}`);
          } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
          render();
        },
      });
      break;
    }
    case 'unlock': void doUnlock(key); break;

    // 舞台
    case 'open-live': {
      clearSecondaryViews();
      _openLiveId = id;
      _giftOpen = false; _orderOpen = false;
      _viewer = null;
      markNightSeen({ liveId: id });
      const live = findLive(id);
      if (live && live.status === 'idle') toast('预告中——点「推进一次」让台主开始');
      render();
      break;
    }
    case 'advance': void doAdvance(id); break;
    case 'end-live': endNightLive(id); emitPhoneEvent('ubp-phone:data-changed'); toast('本轮已结束'); break;
    case 'submit-order': {
      const input = _ctx?.container.querySelector('[data-ubp-input="order"]') as HTMLInputElement | null;
      void doOrder(id, (input?.value || '').trim());
      break;
    }
    case 'send-barrage': {
      const input = _ctx?.container.querySelector('[data-ubp-input="barrage"]') as HTMLInputElement | null;
      const text = (input?.value || '').trim();
      if (!text) break;
      if (input) input.value = '';
      // L9 成就：玩家亲手发弹幕成功（直播间须存在；AI 弹幕与打赏内嵌弹幕不经过此处）
      if (findLive(id) && sendNightBarrage(id, text)) emitAch('phone_night_barrage', {});
      render();
      break;
    }
    case 'toggle-gifts': _giftOpen = !_giftOpen; render(); break;
    case 'live-menu': openLiveMenu(id); break;
    case 'gift': {
      const gid = el.dataset.gid || '';
      const res = sendNightGift(id, gid);
      if (res.ok) {
        // L9 成就：玩家亲手打赏成功（礼物内嵌弹幕不算 phone_night_barrage）
        emitAch('phone_night_gift', {});
        emitPhoneEvent('ubp-phone:data-changed');
        toast(res.upgraded ? `打赏已加码 → ${res.tier}` : '打赏送达');
      }
      render();
      break;
    }
    case 'enter-private': {
      const res = enterNightPrivateRoom(id);
      if (res.ok) { emitPhoneEvent('ubp-phone:data-changed'); toast('已进私密房'); }
      else toast(res.reason || '门槛未达');
      render();
      break;
    }
    case 'exit-private': exitNightPrivateRoom(id); emitPhoneEvent('ubp-phone:data-changed'); render(); break;
    case 'del-live': {
      const removed = deleteNightLive(id);
      if (removed) {
        emitPhoneEvent('ubp-phone:data-changed');
        _openLiveId = null;
        toast('已删除该台');
      }
      render();
      break;
    }
    case 'start-live': _liveDraft = { title: '', coverDesc: '', spice: NIGHT_DEFAULT_SPICE }; render(); break;
    case 'live-spice': _liveDraft && (_liveDraft.spice = idx as NightSpice); render(); break;
    case 'live-cancel': _liveDraft = null; render(); break;
    case 'live-send': {
      if (!_liveDraft) break;
      const title = readInput('live-title') || _liveDraft.title;
      const cover = readInput('live-cover') || _liveDraft.coverDesc;
      const liveId = startMyNightLive(title, cover, _liveDraft.spice);
      _liveDraft = null;
      _openLiveId = liveId;
      _tab = 'stage';
      // L9 成就：玩家亲手开播成功
      emitAch('phone_night_live_started', {});
      emitPhoneEvent('ubp-phone:data-changed');
      toast('已开台');
      render();
      if (cover.trim()) {
        void startGen(() => generateNightImage(`l:${liveId}`)).catch(() => undefined).finally(() => { if (_ctx) render(); });
      }
      break;
    }

    // 搭话 / 约会
    case 'open-dm': {
      clearSecondaryViews();
      _openDmId = id;
      markNightSeen({ dmId: id });
      render();
      break;
    }
    case 'push-dm': {
      const input = _ctx?.container.querySelector('[data-ubp-input="dm"]') as HTMLInputElement | null;
      const text = (input?.value || '').trim();
      void doPushDm(id, text);
      break;
    }
    case 'dm-image': {
      if (!_ctx) break;
      openImagePickerSheet(_ctx.container, {
        mode: 'context',
        title: '发给对方的图',
        emptyText: '相册还是空的——先去拍一张',
        onPick: img => {
          try {
            sendNightDmMessage(id, {
              ...(img.desc ? { imageDesc: composeImageDesc(img.desc, img.origin) } : {}),
              imagePath: img.path,
            });
            emitPhoneEvent('ubp-phone:data-changed');
            render();
          } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
        },
      });
      break;
    }
    case 'propose-date': _dateDraft = { peer: id, place: '', note: '' }; render(); break;
    case 'date-cancel': _dateDraft = null; render(); break;
    case 'date-send': {
      if (!_dateDraft) break;
      const place = readInput('date-place') || '';
      const note = readInput('date-note') || '';
      try {
        const dateId = proposeNightDate(id, place, note);
        _dateDraft = null;
        _openDateId = dateId;
        _openDmId = null;
        // L9 成就：玩家亲手发起约会成功（AI 约会节点推进走 advanceNightDate，不经过此处）
        emitAch('phone_night_date_proposed', {});
        emitPhoneEvent('ubp-phone:data-changed');
        render();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case 'open-date': clearSecondaryViews(); _openDateId = id; render(); break;
    case 'advance-date': void doAdvanceDate(id); break;
    case 'pick-choice': {
      const picked = Number(el.dataset.idx ?? '0');
      void doAdvanceDate(id, picked);
      break;
    }
    case 'pause-date': setNightDateStatus(id, 'paused'); emitPhoneEvent('ubp-phone:data-changed'); render(); break;
    case 'resume-date': setNightDateStatus(id, 'ongoing'); emitPhoneEvent('ubp-phone:data-changed'); render(); break;
    case 'finish-date': setNightDateStatus(id, 'done'); emitPhoneEvent('ubp-phone:data-changed'); toast('约会已收尾'); break;

    // 我的
    case 'open-msg': _tab = 'me'; _meView = 'msg'; markNightSeen({ all: true }); emitPhoneEvent('ubp-phone:data-changed'); render(); break;
    case 'my-favs': _tab = 'me'; _meView = 'favs'; render(); break;
    case 'my-follows': _tab = 'me'; _meView = 'follows'; render(); break;
    case 'fav-unlock': _favUnlocked = true; toast('私密收藏夹已解锁（本次会话）'); break;
    case 'stealth': {
      const on = nightData().me.stealth === false;
      setNightStealth(on);
      emitPhoneEvent('ubp-phone:data-changed');
      toast(on ? '隐身浏览已开' : '隐身浏览已关'); // toast 内部已 render
      break;
    }
    case 'alias-edit': _aliasDraft = nightAlias(); render(); break;
    case 'alias-cancel': _aliasDraft = null; render(); break;
    case 'alias-save': {
      const name = readInput('alias');
      const res = setNightAlias(name);
      if (!res.ok) { toast(res.error || '改名失败'); break; }
      _aliasDraft = null;
      // L9 成就：玩家亲手保存马甲成功（「让 AI 重新起一个」走 runNightAlias，不经过此处）
      emitAch('phone_night_alias_edited', {});
      emitPhoneEvent('ubp-phone:data-changed');
      toast('马甲已改');
      render();
      break;
    }
    case 'alias-regen': void doAlias(true); break;
    case 'dm-edit-cancel': _dmEdit = null; render(); break;
    case 'dm-edit-save': {
      if (!_dmEdit) break;
      const target = _dmEdit;
      const text = readInput('dm-edit');
      if (!text) { toast('内容不能为空'); break; }
      _dmEdit = null;
      if (!editNightDmMessage(target.dmId, target.msgId, text)) { toast('这条消息不能编辑'); break; }
      emitPhoneEvent('ubp-phone:data-changed');
      toast('已保存');
      break;
    }
    case 'clear-data': {
      openActionSheet(_ctx!.container, {
        title: '清空不夜城数据？',
        body: '帖子、直播间、搭话、收藏、马甲全部清掉，不可恢复。',
        items: [{ act: 'yes', label: '确认清空', danger: true }],
        onPick: () => {
          clearNightData();
          emitPhoneEvent('ubp-phone:data-changed');
          _tab = 'street';
          _openPostId = null; _openAboutPostId = null; _openLiveId = null; _openDmId = null; _openDateId = null; _personaName = null; _aboutOpen = false;
          toast('已清空');
          render();
        },
      });
      break;
    }
    case 'settings': openApp('settings'); break;
    case 'share': {
      const post = findPost(id);
      if (post) sharePostToChat(post);
      break;
    }

    // 消息
    case 'mark-all-read': markNightSeen({ all: true }); emitPhoneEvent('ubp-phone:data-changed'); render(); break;
    case 'open-notify': {
      const n = nightData().notifications.find(x => x.id === id);
      if (!n) break;
      markNightSeen({ postId: n.postId, liveId: n.liveId, dmId: n.dmId });
      clearSecondaryViews();
      if (n.dmId && findDm(n.dmId)) { _tab = 'dm'; _openDmId = n.dmId; }
      else if (n.liveId && findLive(n.liveId)) { _tab = 'stage'; _openLiveId = n.liveId; }
      else if (n.postId && findPost(n.postId)) {
        const post = findPost(n.postId)!;
        if (post.kind === 'about') _openAboutPostId = n.postId;
        else _openPostId = n.postId;
        _tab = 'street';
      } else toast('内容已删除');
      render();
      break;
    }

    // 发布面板
    case 'compose-page': {
      _composer = {
        board: _board || 'nighttalk',
        kind: 'text',
        spice: NIGHT_DEFAULT_SPICE,
        title: '', text: '', tags: [], imgPath: '', imgDesc: '', cameraMode: false,
        want: '', spiceWanted: NIGHT_DEFAULT_SPICE, reward: '',
      };
      render();
      break;
    }
    case 'compose-cancel': _composer = null; render(); break;
    case 'compose-board': if (_composer) { _composer.board = id; render(); } break;
    case 'compose-kind': if (_composer) { _composer.kind = id as 'text' | 'gallery' | 'bounty'; render(); } break;
    case 'compose-spice': if (_composer) { _composer.spice = idx as NightSpice; render(); } break;
    case 'compose-tag': {
      if (!_composer) break;
      const tag = id;
      const list = _composer.tags.includes(tag)
        ? _composer.tags.filter(t => t !== tag)
        : (_composer.tags.length >= NIGHT_TAGS_PER_POST ? _composer.tags : [..._composer.tags, tag]);
      _composer.tags = list;
      render();
      break;
    }
    case 'compose-cover': {
      if (!_ctx || !_composer) break;
      openImagePickerSheet(_ctx.container, {
        mode: 'context',
        title: '选一张图',
        emptyText: '相册还是空的——用「描述生图」先拍一张',
        onPick: img => {
          if (!_composer) return;
          _composer.imgPath = img.path;
          _composer.imgDesc = composeImageDesc(img.desc, img.origin);
          _composer.cameraMode = false;
          render();
        },
      });
      break;
    }
    case 'compose-camera': if (_composer) { _composer.cameraMode = true; _composer.imgPath = ''; render(); } break;
    case 'compose-send': void sendCompose(); break;
    default: break;
  }
}

function readInput(field: string): string {
  const el = _ctx?.container.querySelector(`[data-ubp-input="${field}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  return (el?.value || '').trim();
}

function handleInput(event: Event): void {
  const el = event.target as HTMLElement;
  const field = el.dataset?.ubpInput;
  if (!field) return;
  const value = (el as HTMLInputElement | HTMLTextAreaElement).value;
  if (field === 'comment-text' || field === 'dm' || field === 'order' || field === 'barrage') return; // 发送时现读值
  if (_aliasDraft !== null && field === 'alias') { _aliasDraft = value; return; }
  if (_dateDraft) {
    if (field === 'date-place') _dateDraft.place = value;
    else if (field === 'date-note') _dateDraft.note = value;
    return;
  }
  if (_liveDraft) {
    if (field === 'live-title') _liveDraft.title = value;
    else if (field === 'live-cover') _liveDraft.coverDesc = value;
    return;
  }
  if (_dmEdit && field === 'dm-edit') { _dmEdit.text = value; return; }
  if (!_composer) return;
  if (field === 'compose-title') _composer.title = value;
  else if (field === 'compose-text') _composer.text = value;
  else if (field === 'compose-want') _composer.want = value;
  else if (field === 'compose-reward') _composer.reward = value;
  else if (field === 'compose-imgdesc') _composer.imgDesc = value;
}

// ─── 生成流程 ───

async function doLivesRefresh(hint?: string, picked: string[] = []): Promise<void> {
  if (isNightBusy()) return;
  _error = '';
  try {
    const n = await startGen(() => refreshNightLives({
      ...(hint ? { extraHint: hint } : {}),
      ...(picked.length ? { focusNames: picked } : {}),
    }));
    emitPhoneEvent('ubp-phone:data-changed');
    toast(`开台列表已更新（${n} 个房间）`);
  } catch (e) { fail(e); } finally {
    startAutoImages();
  }
}

async function doAboutRefresh(hint?: string, picked: string[] = []): Promise<void> {
  if (isNightBusy()) return;
  _error = '';
  try {
    const n = await startGen(() => refreshNightAboutMe({
      ...(hint ? { extraHint: hint } : {}),
      ...(picked.length ? { focusNames: picked } : {}),
    }));
    emitPhoneEvent('ubp-phone:data-changed');
    toast(`捡到 ${n} 条关于你的传闻`);
  } catch (e) { fail(e); } finally {
    startAutoImages();
  }
}

/** 长按生成钮 → 本次生成设置（ED-06：接入统一 hint-sheet，与其他 App 同能力同入口——
 *  额外提示 + 焦点人物；确认后按入口分派，并把本次 hint/picked 记进 _lastAttempt 供「重试」重放）。 */
function openGenHint(kind: 'refresh' | 'lives' | 'about'): void {
  if (!_ctx || isNightBusy()) return;
  const title = kind === 'lives' ? '本次开台提示' : kind === 'about' ? '本次传闻提示' : '本次刷新提示';
  openOneShotHintSheet(_ctx.container, {
    title,
    confirmLabel: '刷新',
    contacts: getRoster().contacts.map(c => c.name),
    onConfirm: (hint, picked) => {
      if (kind === 'lives') { _lastAttempt = { kind: 'lives', hint, picked }; void doLivesRefresh(hint, picked); }
      else if (kind === 'about') { _lastAttempt = { kind: 'about', hint, picked }; void doAboutRefresh(hint, picked); }
      else { _lastAttempt = { kind: 'refresh', hint, picked }; void doRefresh({ hint, picked }); }
    },
  });
}

/** 直播间动作面板（ED-05 降密：点单/私密房/结束/档案/删除 全部收进这一处；
 *  入口两条——「更多」按钮（可发现）+ 长按直播间（IA-06 统一长按=上下文动作面板））。 */
function openLiveMenu(id: string): void {
  const live = findLive(id, nightData());
  if (!live || !_ctx) return;
  const privateMode = live.privateEntered === true;
  const orderEnabled = getPhoneSettings().nightOrders !== false;
  const busy = isNightBusy();
  openActionSheetCore(_ctx.container, {
    title: live.streamer,
    actions: [
      ...(orderEnabled ? [{ label: '点单…', onPick: () => { _orderOpen = true; render(); } }] : []),
      ...(live.privateAvailable || privateMode
        ? [{
            label: privateMode ? '退出私密房' : `进${nt('privateRoom', currentStyle())}`,
            onPick: () => {
              if (privateMode) { exitNightPrivateRoom(id); emitPhoneEvent('ubp-phone:data-changed'); render(); return; }
              const res = enterNightPrivateRoom(id);
              if (res.ok) { emitPhoneEvent('ubp-phone:data-changed'); toast('已进私密房'); }
              else toast(res.reason || '门槛未达');
              // 两分支都走 toast（内部已 render）⇒ 不追加 render
            },
          }]
        : []),
      { label: '看档案', onPick: () => { openPersona(live.streamer); render(); } },
      ...(live.status === 'ended' ? [] : [{ label: '结束本轮', onPick: () => {
        endNightLive(id); emitPhoneEvent('ubp-phone:data-changed'); toast('本轮已结束');
      } }]),
      ...(busy ? [{ label: '终止生成', onPick: () => { abortNightGeneration(); _error = ''; toast('已终止'); } }] : []),
      { label: '删除直播间', tone: 'danger' as const, onPick: () => {
        openConfirmSheet(_ctx!.container, {
          title: '删除这个直播间？',
          message: '删除后不再出现在开台列表，不可恢复。',
          confirmLabel: '删除',
          onConfirm: () => {
            if (deleteNightLive(id)) { emitPhoneEvent('ubp-phone:data-changed'); _openLiveId = null; toast('已删除该台'); }
            render();
          },
        });
      } },
      { label: S('取消', '作罢'), onPick: () => { /* 取消 */ } },
    ],
  });
}

async function doExpandPost(postId: string): Promise<void> {
  _error = '';
  try {
    const n = await startGen(() => expandNightPost(postId));
    emitPhoneEvent('ubp-phone:data-changed');
    toast(n ? `新增 ${n} 条回复` : '这一层没有新回复');
  } catch (e) { fail(e); } finally { render(); }
}

async function doAdvance(liveId: string): Promise<void> {
  const live = findLive(liveId);
  if (!live) return;
  _error = '';
  try {
    const res = await startGen(() => advanceNightLive(liveId));
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：玩家亲手推进直播一轮（轮次取推进后的落库值；AI 弹幕/台词不算玩家动作）
    emitAch('phone_night_live_advanced', { round: findLive(liveId)?.round ?? 0 });
    toast(res.ended ? '台主下播了（可回看）' : `推进到第 ${(live.round + 1)} 轮`);
  } catch (e) { fail(e); } finally {
    startAutoImages();
  }
}

async function doOrder(liveId: string, text: string): Promise<void> {
  if (!text) { toast('先说点什么，再点单'); return; }
  _error = '';
  try {
    const res = await startGen(() => submitNightOrder(liveId, text));
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：玩家亲手点单提交成功（tier=下单前档位；AI 台主接受与否是内容层，不改变「点了单」这个动作）
    emitAch('phone_night_order', { tier: res.tier });
    if (res.accepted) toast(res.tier === '专场' ? '台主给你开了专场' : '台主照做了');
    else toast(`被拒了：${res.rejectReason || '不符合 TA 的底线'}（退了 2 硬币）`);
  } catch (e) { fail(e); } finally { render(); }
}

async function doPushDm(peer: string, text: string): Promise<void> {
  _error = '';
  if (text) {
    try {
      sendNightDmMessage(peer, { text });
      emitPhoneEvent('ubp-phone:data-changed');
    } catch (e) { toast(e instanceof Error ? e.message : String(e)); return; }
  }
  try {
    const n = await startGen(() => pushNightDm(peer, {
      // 每条送达即上屏：配合 render 的私聊跟底，回复会一条一条从底部出现。
      onDelivered: msg => {
        if (!_ctx) return;
        render();
        if (msg.type === 'image') startAutoImages(); // 图一到就转圈洗图
      },
    }));
    emitPhoneEvent('ubp-phone:data-changed');
    void n;
  } catch (e) { fail(e); } finally { startAutoImages(); }
}

async function doAdvanceDate(dateId: string, choicePicked?: number): Promise<void> {
  _error = '';
  try {
    const res = await startGen(() => advanceNightDate(dateId, choicePicked === undefined ? {} : { choicePicked }));
    emitPhoneEvent('ubp-phone:data-changed');
    toast(res.done ? '这一段收尾了' : `第 ${res.step} 段`);
  } catch (e) { fail(e); } finally {
    startAutoImages();
  }
}

async function doPersona(name: string, force = false): Promise<void> {
  _error = '';
  _personaName = name;
  try {
    await startGen(() => runNightPersona(name, force ? { force: true } : {}));
    emitPhoneEvent('ubp-phone:data-changed');
  } catch (e) {
    if (force) fail(e);
    else toast('AI 补全失败，先用本地资料');
  } finally { render(); }
}

async function doUnlock(key: string): Promise<void> {
  const img = readNightImageByKey(key);
  const postId = imageKeyPostId(key);
  if (!img) return;
  // image key 末段是索引；consent 门槛按帖+索引定位
  const parts = key.split(':');
  const index = Number(parts[2] || '0');
  _error = '';
  try {
    const res = await startGen(() => requestNightUnlock(postId, index));
    emitPhoneEvent('ubp-phone:data-changed');
    toast(res.grant ? '作者同意了——这张揭开了' : `作者没同意${res.reply ? `：${res.reply}` : ''}`);
  } catch (e) { fail(e); } finally { render(); }
}

async function doSaveAlbum(key: string): Promise<void> {
  const img = readNightImageByKey(key);
  if (!img?.path) { toast('先洗出这张图'); return; }
  const { addPhoneAlbumEntries, makeAlbumEntryId } = await import('../core/phone-album');
  addPhoneAlbumEntries([{
    id: makeAlbumEntryId(),
    path: img.path,
    source: 'night',
    characters: [],
    desc: img.desc,
    ...(img.prompt ? { imagePrompt: img.prompt } : {}),
    ...(img.negative ? { imageNegative: img.negative } : {}),
    createdAt: Date.now(),
  }]);
  emitPhoneEvent('ubp-phone:data-changed');
  toast('已存到相册');
  render();
}

async function doAlias(force: boolean): Promise<void> {
  const name = await startGen(() => runNightAlias(force ? { force: true } : {}));
  if (name) {
    emitPhoneEvent('ubp-phone:data-changed');
    toast(`马甲：${name}`);
  } else {
    toast(force ? '马甲生成失败（可在设置检查 API）' : '');
  }
  if (_ctx) render();
}

async function sendComment(): Promise<void> {
  if (!_commentTarget) return;
  const text = readInput('comment-text');
  if (!text) { _commentTarget = null; render(); return; }
  const target = _commentTarget;
  const { mutatePhoneData } = await import('../core/phone-store');
  const { appendNightComments, normalizeNightCommentInput } = await import('../core/night-model');
  const alias = nightAlias();
  const now = getRoster().global.time || '刚刚';
  mutatePhoneData(d => {
    const cur = d.night;
    if (!cur) return;
    const post = target.about ? cur.about?.items.find(p => p.id === target.postId) : cur.posts.find(p => p.id === target.postId);
    if (!post) return;
    const comment = normalizeNightCommentInput({ name: alias, text, time: now, ...(target.replyTo ? { replyTo: target.replyTo } : {}) });
    if (comment) appendNightComments(post, [comment], alias);
    // 我的帖子被回复 → 也给楼中楼里的原评论者生成一条「围观」通知？不生成（避免噪音）
  });
  _commentTarget = null;
  emitPhoneEvent('ubp-phone:data-changed');
  render();
}

async function sendCompose(): Promise<void> {
  if (!_composer) return;
  const c = _composer;
  const text = c.text.trim();
  const title = c.title.trim();
  if (!text && !title) { toast('至少写点正文'); return; }
  const alias = nightAlias();
  const now = getRoster().global.time || '刚刚';
  const { mutatePhoneData } = await import('../core/phone-store');
  const { makeNightPostId, mergeNightPosts, fillNightTags } = await import('../core/night-model');
  const { nightClampSpice } = await import('../core/night-engine');
  const { normalizeStoryTimeLabel } = await import('../core/social-time');
  const postId = makeNightPostId();
  const def = nightBoardDef(c.board);
  const spice = nightClampSpice(c.spice, c.board);
  const stamp = normalizeStoryTimeLabel(now, now) || undefined;
  const images: NightImage[] = c.imgPath
    ? [{ desc: c.imgDesc || '（我发的图）', path: c.imgPath, status: 'ready', reveal: 0 }]
    : c.cameraMode && c.imgDesc.trim()
      ? [{ desc: c.imgDesc.trim(), reveal: 0 }]
      : [];
  const fresh = fillNightTags({
    id: postId,
    board: c.board,
    kind: c.kind === 'bounty' ? 'bounty' : images.length ? 'gallery' : 'text',
    title: title.slice(0, 30),
    content: text.slice(0, 900),
    tags: normalizeNightTags(c.tags),
    spice,
    author: alias,
    byMe: true,
    maskedName: alias,
    images,
    ...(c.kind === 'bounty'
      ? { commission: { want: (c.want || text).slice(0, 120), spiceWanted: nightClampSpice(c.spiceWanted, c.board), tags: normalizeNightTags(c.tags), reward: c.reward.slice(0, 40) }, entries: [] }
      : {}),
    likes: 0,
    collects: 0,
    unlockRequests: 0,
    comments: [],
    timeLabel: now,
    storyTime: getRoster().global.time || undefined,
    ...(stamp ? { storyStamp: stamp } : {}),
    createdAt: Date.now(),
  });
  mutatePhoneData(d => {
    const cur = d.night;
    if (!cur) return;
    cur.posts = mergeNightPosts(cur.posts, [fresh], getPhoneSettings().nightMaxPosts);
  });
  _composer = null;
  _tab = 'street';
  _openPostId = postId;
  _feedVisible = FEED_PAGE;
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手发帖成功（board/kind/spice 用落库后的原值）+ 日窗口伴随
  emitAch('phone_night_posted', { board: fresh.board, kind: fresh.kind, spice: fresh.spice });
  emitActionOnDate('phone_night');
  toast('已发布（以马甲署名）');
  render();
  if (def?.imageMode === 'must' || (c.cameraMode && c.imgDesc.trim())) {
    const key = postImageKey(postId, 0);
    void startGen(() => generateNightImage(key)).catch(() => undefined).finally(() => { if (_ctx) render(); });
  }
}

// ─── mount ───

export const nightApp: PhoneApp = {
  id: 'night',
  name: '不夜城',
  icon: ubpIcon('night'),
  color: '#FF2E7E',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _error = '';
    _toast = '';
    _tab = 'street';
    _openPostId = null;
    _openAboutPostId = null;
    _aboutOpen = false;
    _openLiveId = null;
    _openDmId = null;
    _openDateId = null;
    _personaName = null;
    _personaBack = {};
    _viewer = null;
    _composer = null;
    _commentTarget = null;
    _dateDraft = null;
    _liveDraft = null;
    _aliasDraft = null;
    _dmEdit = null;
    _meView = 'main';
    _favUnlocked = false;
    _giftOpen = false;
    _orderOpen = false;
    _board = '';
    _tag = '';
    _spiceOnly = 0;
    _feedVisible = FEED_PAGE;
    _viewScroll.clear(); // 滚动记忆重置：重开 App 从顶开始，不继承上一次打开时的位置
    _pendingTop = null;
    _openThreads.clear();
    markNightSeen({ all: true });
    // 全局搜索 / 锁屏通知深链：`post:<id>` → 帖子详情；`dm:<id>` → 私信房；`live:<id>` → 直播间。
    // （各类详情共用同一个 target 槽，故在 targetId 里编码类型前缀；目标不存在时 render 回落列表）
    const deepNight = takePendingAppTarget('night');
    if (deepNight && deepNight.startsWith('live:')) {
      const liveId = deepNight.slice(5);
      if (findLive(liveId)) { _tab = 'stage'; _openLiveId = liveId; }
    } else if (deepNight && deepNight.startsWith('dm:')) {
      const dmId = deepNight.slice(3);
      if (findDm(dmId)) { _tab = 'dm'; _openDmId = dmId; }
    } else if (deepNight) {
      const postId = deepNight.startsWith('post:') ? deepNight.slice(5) : deepNight;
      if (findPost(postId)) _openPostId = postId;
    }

    ctx.container.addEventListener('click', handleClick);
    ctx.container.addEventListener('input', handleInput);
    // 长按：帖子卡=操作面板（搭话/收藏/私密收藏/删除）；评论/楼中楼=删除；收藏夹解锁键=长按解锁；
    // 直播间=动作面板（ED-05：点单/私密房/结束/档案/删除 收进一处，长按与「更多」同源）；
    // 搭话会话=动作面板（IA-06 全机统一：长按内容=上下文动作面板；列表行与对话页同源）
    const unbindLongPress = bindLongPress(
      ctx.container,
      t => {
        // 输入框内长按留给系统选字（搭话房间/直播间都含输入行，否则会和选字抢手势）
        if (t.closest('input, textarea')) return null;
        return t.closest('[data-nz-post], [data-nz-cidx], [data-ubp-act="fav-unlock"], [data-nz-live], [data-nz-mid], [data-nz-dm]');
      },
      el => {
        if (el.dataset.ubpAct === 'fav-unlock') { _favUnlocked = true; toast('私密收藏夹已解锁'); return; }
        if (el.dataset.nzLive) { openLiveMenu(el.dataset.nzLive); return; }
        // 私信气泡：长按这一条 → 编辑/删除；房间空白处/输入栏仍走会话级菜单
        if (el.dataset.nzMid) {
          const dmId = (el.closest('[data-nz-dm]') as HTMLElement | null)?.dataset.nzDm || _openDmId || '';
          if (dmId) openDmMsgMenu(dmId, el.dataset.nzMid);
          return;
        }
        if (el.dataset.nzDm) { openDmMenu(el.dataset.nzDm); return; }
        const cidx = el.dataset.nzCidx;
        if (cidx !== undefined) { openCommentDelete(Number(cidx)); return; }
        openCardSheet(el.dataset.nzPost || '');
      },
    );
    // 长按生成钮（街区/开台/传闻刷新）→ 本次生成设置（ED-06）；与上方长按选择器互斥、并存
    const unbindGenHint = bindHintLongPress(ctx.container, t => {
      const el = t.closest('[data-ubp-act="refresh"], [data-ubp-act="refresh-lives"], [data-ubp-act="refresh-about"]') as HTMLElement | null;
      if (!el) return null;
      const act = el.dataset.ubpAct || '';
      const kind: 'refresh' | 'lives' | 'about' = act === 'refresh-lives' ? 'lives' : act === 'refresh-about' ? 'about' : 'refresh';
      return { el, fire: () => openGenHint(kind) };
    });
    render();
    // 马甲首次生成（1 次轻量调用；API 不可用时静默回落兜底名）
    if (!hasNightAlias()) void doAlias(false);
    startAutoImages();

    return () => {
      ctx.container.removeEventListener('click', handleClick);
      ctx.container.removeEventListener('input', handleInput);
      unbindLongPress();
      unbindGenHint();
      _ctx = null;
    };
  },
};

/**
 * 搭话会话长按动作面板（IA-06：长按内容 = 上下文动作面板）。
 * 看档案 / 关注·取关 / 删除会话（危险项仍进确认弹层）。
 * **长按是删会话的唯一入口**：对话页操作行只留「约 TA／档案卡／关注」三枚直出按钮（原垃圾桶已去）。
 * 列表行与对话页共用——两处都带 `data-nz-dm`。
 */
function openDmMenu(dmId: string): void {
  if (!_ctx || !dmId) return;
  const dm = findDm(dmId);
  if (!dm) return;
  const following = nightData().me.follows.includes(dm.peer);
  openActionSheet(_ctx.container, {
    title: `${dm.peer}${dm.sourceLabel ? ` · ${dm.sourceLabel}` : ''}`,
    items: [
      { act: 'persona', label: '看 TA 的档案卡' },
      { act: 'follow', label: following ? `取关 ${dm.peer}` : `关注 ${dm.peer}` },
      { act: 'del', label: '删除这个会话', danger: true },
    ],
    onPick: act => {
      if (act === 'persona') { openPersona(dm.peer); render(); return; }
      if (act === 'follow') {
        const followed = toggleNightAuthorFollow(dm.peer);
        emitPhoneEvent('ubp-phone:data-changed');
        toast(followed ? `已关注 ${dm.peer}` : `已取关 ${dm.peer}`);
        render();
        return;
      }
      if (act === 'del') confirmDeleteDm(dm);
    },
  });
}

/**
 * 私信单条消息长按动作面板（对齐微信：长按气泡=这一条的操作，不再落到会话级菜单）。
 * 编辑只给文字消息（isNightDmMsgEditable）；删除任意类型，仍走统一确认弹层。
 */
function openDmMsgMenu(dmId: string, msgId: string): void {
  if (!_ctx || !dmId || !msgId) return;
  const dm = findDm(dmId);
  const msg = dm?.msgs.find(m => m.id === msgId);
  if (!dm || !msg) return;
  const items: Array<{ act: string; label: string; danger?: boolean }> = [];
  if (isNightDmMsgEditable(msg)) items.push({ act: 'edit', label: '编辑' });
  items.push({ act: 'del', label: '删除这条消息', danger: true });
  openActionSheet(_ctx.container, {
    title: dm.peer,
    body: nightDmMsgPreview(msg).slice(0, 80),
    items,
    onPick: act => {
      if (!_ctx) return;
      if (act === 'edit') {
        _dmEdit = { dmId, msgId, text: msg.text || '' };
        render();
        return;
      }
      if (act === 'del') {
        openConfirmSheet(_ctx.container, {
          title: '删除这条消息？',
          message: '删除后无法恢复。',
          confirmLabel: '删除',
          onConfirm: () => {
            if (!deleteNightDmMessage(dmId, msgId)) return;
            emitPhoneEvent('ubp-phone:data-changed');
            toast('已删除');
          },
        });
      }
    },
  });
}

/** 帖子卡长按操作面板。 */
function openCardSheet(postId: string): void {
  if (!_ctx || !postId) return;
  const post = findPost(postId);
  if (!post) return;
  const mine = post.byMe || post.author === nightAlias();
  const collected = post.collectedByMe === true;
  openActionSheet(_ctx.container, {
    title: nightPostTitle(post),
    items: [
      ...(mine ? [] : [{ act: 'talk', label: `搭话 ${post.author}` }]),
      ...(mine ? [] : [{ act: 'persona', label: '看 TA 的档案卡' }]),
      collected
        ? { act: 'uncollect', label: '取消收藏' }
        : { act: 'collect', label: '收藏（公开）' },
      ...(collected ? [] : [{ act: 'collect-private', label: '收藏到私密夹 🔒' }]),
      { act: 'share', label: '分享到聊天' },
      { act: 'del', label: '删除这条', danger: true },
    ],
    onPick: act => {
      if (act === 'talk') { clearSecondaryViews(); openNightDmFrom(post.author, `来自${nt('app', currentStyle())}`); _tab = 'dm'; _openDmId = nightData().dms.find(d => d.peer === post.author)?.id || null; }
      else if (act === 'persona') { openPersona(post.author); }
      else if (act === 'collect') toggleNightCollect(postId, false);
      else if (act === 'collect-private') toggleNightCollect(postId, true);
      else if (act === 'uncollect') toggleNightCollect(postId, false);
      else if (act === 'share') { sharePostToChat(post); return; }
      else if (act === 'del') { confirmDeletePost(post); return; } // 破坏性动作不降级为一步
      emitPhoneEvent('ubp-phone:data-changed');
      render();
    },
  });
}

function openCommentDelete(index: number): void {
  if (!_ctx) return;
  const postId = _openPostId || _openAboutPostId || '';
  const post = postId ? findPost(postId) : null;
  const target = post?.comments[index];
  if (!post || !target) return;
  confirmNightDelete({
    title: `删除 ${target.name} 的这条回复？`,
    message: '其楼中楼的子回复将一并删除，删除后不可恢复。',
    onConfirm: () => {
      const removed = deleteNightPostComment(post.id, index);
      if (removed) {
        emitPhoneEvent('ubp-phone:data-changed');
        toast('已删除');
      }
      render();
    },
  });
}

/** 供外部（设置页/相册）调用：让不夜城内容与设置同步（打码重设等）。 */
export async function nightSyncImageSettings(): Promise<void> {
  const { nightResetAllReveals } = await import('../core/night-images');
  nightResetAllReveals();
  emitPhoneEvent('ubp-phone:data-changed');
}
