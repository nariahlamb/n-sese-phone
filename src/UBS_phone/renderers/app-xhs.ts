// ===== 小红书 App：双列瀑布流 + 收藏码住（品牌红主题；风格对照 docs/social-three-apps-mockup.html） =====
// 骨架：顶栏（搜索胶囊 + 关注/发现分段）+ 底部 Tab（首页/＋/消息/我）。
// 层级：发现/关注瀑布流 → 笔记详情（大封面+作者行关注+emoji 正文+#标签+评论区+三连底栏）；
// 发布=全页面面板（封面+标题+正文+标签，对照 mockup x-compose）。
// 刷新语义：首页刷新=整版快照；顶栏「求回应」=互动反馈。
// 互动层：点赞/评论/回复（记入待反馈清单）+ 收藏码住（纯本地）+ 关注作者（纯本地）+ 我的页删笔记。

import {
  abortSocialGeneration,
  addSocialComment,
  createUserPost,
  deleteSocialComment,
  deleteUserPost,
  getPendingActions,
  getSocialNotificationUnread,
  isAuthorProfileGenerating,
  isFeedbackGenerating,
  readSocialAuthorProfile,
  readSocialFollows,
  refreshSocialSnapshot,
  runAuthorProfileGeneration,
  toggleCollect,
  toggleFollow,
  toggleLike,
} from '../core/social-engine';
import { isPhoneAbortError } from '../core/phone-error';
import { buildCommentThreads, readSocialOf, paginateFeed, FEED_PAGE_SIZE, xhsMatchesTopic, type SocialAuthorProfile, type XhsNote } from '../core/social-model';
import { buildShareMessage, composeImageDesc, type SharePostSnapshot } from '../core/forward-model';
import { commentTimeText, postTimeText } from '../core/social-time';
import { currentStyle, s, socialSkinProfile, xhsSkinProfile, type XhsSkinProfile } from '../core/skins';
import { composeShootDesc } from '../core/chat-image-prompts';
import { readPhoneDataRef } from '../core/phone-store';
import { getRoster } from '../core/roster';
import { autoGenerateSocialImages, generateSocialImage, isAutoImageRunning, isSocialImageActive } from '../core/social-images';
import { emitPhoneEvent, onPhoneEvent, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openImagePickerSheet } from './image-picker-sheet';
import { appendForwardedMessage, openForwardTargetSheet } from './forward-sheet';
import { avatarHtml, bindLongPress, createViewScrollMemo, escapeAttr, escapeHtml, longPressJustFired, openActionSheet, pulseActIcon } from './phone-ui';
import { actIcon, ubpIcon } from './icons';
import { openPhoneLightbox } from './image-lightbox';
import { openConfirmSheet } from './action-sheet';
import {
  bindFeedScroll,
  createSocialFeedKit,
  feedMoreHtml,
  renderSocialMe,
  renderSocialMessages,
  renderSocialShell,
  renderSubReplies,
  resetSubThreads,
  socialDetailActs,
  socialDetailNav,
  socialFollowBtn,
  socialSeg,
  toggleSubThread,
  anonRowHtml,
  readAllNotifications,
  readNotification,
  readPost,
  markFeedScrollRestore,
} from './social-shell';
import { bindHintLongPress } from './hint-sheet';
import { openSearchSheet } from './search-sheet';
import { achFlag, emitAch, emitActionOnDate } from '../core/phone-achievements';

type XhsTab = 'discover' | 'messages' | 'me';

const TABS = [
  { id: 'discover', label: '首页', icon: ubpIcon('home') },
  { id: 'messages', label: '消息', icon: ubpIcon('message') },
  { id: 'me', label: '我', icon: ubpIcon('user') },
];

/** Tab 标签按风格取词（云笈/图志/图鉴 + 知会/名帖；现代=注册表原文）。 */
function tabLabel(id: string): string {
  if (id === 'discover') return _P?.tabHome || '首页';
  if (id === 'messages') return socialSkinProfile(currentStyle())?.tabMessages || '消息';
  if (id === 'me') return socialSkinProfile(currentStyle())?.tabMe || '我';
  return '首页';
}

let _ctx: PhoneAppContext | null = null;
let _tab: XhsTab = 'discover';
let _homeSeg: 'follow' | 'discover' = 'discover';
// 帧级皮肤档案（render 开头刷新；现代=null 走现代文案——docs/15：云笈录/风物志/藏宝图鉴）
let _P: XhsSkinProfile | null = null;
let _openNoteId: string | null = null;
let _openAuthor: string | null = null; // 作者主页（点作者名进入；右上 ↻=该作者定点刷新）
let _openKeyword: string | null = null; // 搜索结果页（搜索框输入关键词进入；右上 ↻=该关键词定点生成）
let _meFollowsOpen = false; // 我的页「关注 N」展开态（内联关注列表，无弹层）
let _composePage = false;
let _busy = false;
let _error = '';
// 上次失败尝试（重试钮重放：人物选择+额外提示；成功后随横幅消失，下次生成覆盖）
let _lastAttempt: { action: 'refresh' | 'feedback' | 'author'; focusAuthor?: string; focusKeyword?: string; hint: string; picked: string[] } | null = null;
// 信息流公共件：实现单一事实源在 social-shell.createSocialFeedKit（同名解构 → 全 App 调用点零改动）
const feedKit = createSocialFeedKit({
  container: () => _ctx?.container ?? null,
  isBusy: () => _busy,
  isFeedbackBusy: isFeedbackGenerating,
  setError: msg => { _error = msg; },
  rememberFeedbackAttempt: (hint, picked) => { _lastAttempt = { action: 'feedback', hint, picked }; },
  render: () => render(),
  onLoadMore: () => { _feedVisible += FEED_PAGE_SIZE; },
  onRefreshConfirm: (hint, picked) => { void doRefresh(hint, picked, _openAuthor || undefined, _openKeyword || undefined); },
});
const { toast, countLabel, openRefreshHint, openFeedbackHint, doFeedback, loadMoreFeed } = feedKit;
// 瀑布流分页状态：首屏只渲染最近 FEED_PAGE_SIZE 篇，触底/扩页递增（mount/切tab/切分段重置）
let _feedVisible = FEED_PAGE_SIZE;
let _feedHasMore = false;   // 渲染帧回写：触底监听与自动扩页共用
// 跨视图滚动记忆：首页/笔记详情/作者/搜索页各记各的（列表→详情→返回不会回顶，见 phone-ui createViewScrollMemo）
const _viewScroll = createViewScrollMemo();
let _pendingTop: number | null = null; // 扩页未达记忆位时的跨帧目标（递归渲染仍要落回原目标）
let _composer: {
  title: string;
  text: string;
  tags: string;
  imgPath: string;
  imgDesc: string;
  cameraMode: boolean;
  /** 匿名发布（true=以匿名账号发出，名称取 anonName 或默认「匿名用户」）。 */
  anon: boolean;
  anonName: string;
} | null = null;

function currentSocial() {
  return readSocialOf(readPhoneDataRef()); // O42：只读切片，零拷贝
}

/** 社媒域快照类型（帧内传参复用时的形参类型）。 */
type SocialSnapshot = ReturnType<typeof currentSocial>;

function findNote(id: string, social: SocialSnapshot = currentSocial()): XhsNote | null {
  return social.xhs.find(n => n.id === id) || null;
}

// ─── 瀑布流 ───

function renderCover(note: XhsNote): string {
  if (note.imagePath && note.imageStatus === 'ready') {
    return `<span class="ubp-mo-img"><img src="${escapeAttr(note.imagePath)}" alt="" loading="lazy"></span>`;
  }
  // busy=pending 且引擎确实在跑：中断残留的假 pending 回落为「未开始」可点击
  const busy = note.imageStatus === 'pending' && isSocialImageActive(note.id);
  const failed = note.imageStatus === 'failed';
  return `<span class="ubp-mo-imgph${failed ? ' failed' : ''}">
    ${busy ? '<span class="ubp-spinner"></span>' : failed ? '<span class="ubp-mo-imgph-note">⚠ 生成失败</span>' : ubpIcon('image')}
    <span class="ubp-mo-imgph-desc">${escapeHtml(note.imageDesc)}</span>
    <span class="ubp-mo-imgph-hint">${busy ? '生成中…' : failed ? '点击重试' : '点击生成封面'}</span>
  </span>`;
}

function renderCards(notes: XhsNote[], me: string): string {
  if (!notes.length) {
    return `<div class="ubp-empty"><b>还没有${_P?.noteNoun || '笔记'}</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`;
  }
  return `<div class="ubp-xhs-masonry">${notes.map(n => `
    <button type="button" class="ubp-xhs-card" data-ubp-act="open-note" data-id="${escapeAttr(n.id)}">
      <span class="ubp-xhs-cover">${n.imageDesc ? renderCover(n) : ''}</span>
      <span class="ubp-xhs-ct">
        <span class="ubp-xhs-title">${escapeHtml(n.title)}</span>
        <span class="ubp-xhs-cmeta">
          ${avatarHtml(n.author, '', true)}
          <span class="ubp-xhs-cname">${escapeHtml(n.author)}${n.author === me || n.anon ? '（我）' : ''}</span>
          <span class="ubp-xhs-clike">${ubpIcon('like')}${countLabel(n.likes)}</span>
        </span>
      </span>
    </button>`).join('')}</div>`;
}

// ─── 搜索结果页（搜索框输入关键词进入；结果=本地已有笔记前端过滤，零 AI 调用） ───

function renderSearchResults(keyword: string, feed: SocialSnapshot['xhs'], me: string): string {
  const related = feed.filter(n => xhsMatchesTopic(n, keyword));
  const { page, hasMore, remaining } = paginateFeed(related, _feedVisible); // 结果页也只渲染最近10篇
  _feedHasMore = hasMore;
  const style = currentStyle();
  const noteNoun = _P?.noteNoun || '笔记';
  const hero = `<div class="ubp-ssearch">
    <div class="ubp-ssearch-word">${s(style, '搜索', '检索')}「${escapeHtml(keyword)}」</div>
    <div class="ubp-ssearch-stat">${s(style, '相关', '相合的')}${escapeHtml(noteNoun)} ${related.length} 篇</div>
  </div>
  <div class="ubp-ssearch-host"><span class="ubp-ssearch-chip">${s(style, '关键词', '词条')}</span><span>${s(style,
    `来自已有${noteNoun}`,
    '来自已有云笈',
    '来自已有图志',
    '来自已有图鉴')}</span></div>`;
  const list = page.length
    ? renderCards(page, me) + (hasMore ? feedMoreHtml(remaining) : '')
    : `<div class="ubp-empty"><b>${s(style, '没有搜到相关', '没有搜到相合的')}${escapeHtml(noteNoun)}</b><button class="ubp-empty-btn" data-ubp-act="refresh">${s(style, '围绕关键词生成', '围绕词条收录')}</button></div>`;
  return hero + list;
}

// ─── 作者主页（严格对照 docs/follow-mechanism-mockup.html xhs-author；资料=1B 型轻量生成一次后缓存） ───

/** 首次进入且无缓存 → 后台轻量生成资料；完成/失败后若仍在该主页则重渲染（失败=本地兜底头部）。 */
function ensureAuthorProfile(name: string): void {
  if (readSocialAuthorProfile('xhs', name) || isAuthorProfileGenerating()) return;
  void runAuthorProfileGeneration('xhs', name)
    .then(() => { if (_ctx && _openAuthor === name) render(); })
    .catch(() => { if (_ctx && _openAuthor === name) render(); });
}

function renderAuthorHome(name: string, followsXhs: string[], feed: SocialSnapshot['xhs']): string {
  const me = getRoster().protagonistName;
  const profile: SocialAuthorProfile | null = readSocialAuthorProfile('xhs', name);
  const notes = feed.filter(n => n.author === name);
  const followed = followsXhs.includes(name);
  const busy = isAuthorProfileGenerating();
  const headHtml = busy && !profile
    ? `<div class="ubp-xhs-ahead">
        <div class="ubp-xhs-ahead-top"><div class="ubp-xhs-bigava ubp-sk"></div><div class="ubp-xhs-astats"><span class="ubp-sk" style="width:52px;height:17px;"></span><span class="ubp-sk" style="width:52px;height:17px;"></span><span class="ubp-sk" style="width:52px;height:17px;"></span></div></div>
        <div class="ubp-sk" style="height:18px;width:110px;margin-top:11px;"></div>
        <div class="ubp-sk" style="height:13px;width:70%;margin-top:9px;"></div>
        <div class="ubp-xhs-abtns"><span class="ubp-sk" style="flex:1;height:33px;border-radius:9px;"></span></div>
        <div class="ubp-xhs-pagetab"><span class="on">${escapeHtml(_P?.noteNoun || '笔记')}</span></div>
      </div>`
    : `<div class="ubp-xhs-ahead">
        <div class="ubp-xhs-ahead-top">
          <div class="ubp-xhs-bigava">${avatarHtml(name, 'ubp-bigava', true)}</div>
          <div class="ubp-xhs-astats">
            <span class="ubp-xhs-astat"><b>${escapeHtml(profile?.following || '0')}</b><span>${s(currentStyle(), '关注', '结交')}</span></span>
            <span class="ubp-xhs-astat"><b>${escapeHtml(profile?.followers || '0')}</b><span>粉丝</span></span>
            <span class="ubp-xhs-astat"><b>${escapeHtml(profile?.likes || '0')}</b><span>${_P ? `${escapeHtml(_P.likeNoun)}与${escapeHtml(_P.collectNoun)}` : '获赞与收藏'}</span></span>
          </div>
        </div>
        <div class="ubp-xhs-nick">${escapeHtml(name)}${name === me ? '<i class="ubp-mo-metag">（我）</i>' : ''}</div>
        <div class="ubp-xhs-uid">${escapeHtml(_P?.authorIdNoun || '小红书号')}：${escapeHtml(name)}</div>
        ${profile?.signature ? `<div class="ubp-xhs-abio">${escapeHtml(profile.signature)}</div>` : ''}
        <div class="ubp-xhs-ip">${escapeHtml(_P?.authorLocNoun || 'IP 属地')}：临江</div>
        ${name !== me ? `<div class="ubp-xhs-abtns">
          <button type="button" class="ubp-xhs-abtn ${followed ? 'followed' : 'on'}" data-ubp-act="follow" data-scope="xhs" data-id="${escapeAttr(name)}">${followed ? s(currentStyle(), '已关注', '已结交') : s(currentStyle(), '关注', '结交')}</button>
        </div>` : ''}
        <div class="ubp-xhs-pagetab"><span class="on">${escapeHtml(_P?.noteNoun || '笔记')}</span></div>
      </div>`;
  const listHtml = notes.length
    ? `<div class="ubp-xhs-masonry">${notes.map(n => `
      <button type="button" class="ubp-xhs-card" data-ubp-act="open-note" data-id="${escapeAttr(n.id)}">
        <span class="ubp-xhs-cover">${n.imageDesc ? renderCover(n) : ''}</span>
        <span class="ubp-xhs-ct">
          <span class="ubp-xhs-title">${escapeHtml(n.title)}</span>
          <span class="ubp-xhs-cmeta">
            ${avatarHtml(n.author, '', true)}
            <span class="ubp-xhs-cname">${escapeHtml(n.author)}</span>
            <span class="ubp-xhs-clike">${ubpIcon('like')}${countLabel(n.likes)}</span>
          </span>
        </span>
      </button>`).join('')}</div>`
    : `<div class="ubp-empty"><b>TA 还没有发过${_P?.noteNoun || '笔记'}</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`;
  return `<div class="ubp-xhs-author">${headHtml}<div class="ubp-xhs-div"></div></div>${listHtml}${busy && !profile ? `<div class="ubp-sgen"><span class="ubp-spin"></span>正在生成 TA 的资料…</div>` : ''}`;
}

// ─── 笔记详情 ───

function renderNoteDetail(note: XhsNote, followsXhs: string[]): string {
  const me = getRoster().protagonistName;
  const follows = followsXhs;
  // 关注钮全程双态可逆（已关注=灰底可再点取关）；仅已关注作者的作者名可点进主页（未关注不提供入口——避免误触资料生成）
  const followBtn = note.author !== me
    ? socialFollowBtn(follows.includes(note.author), 'xhs', note.author)
    : `<span class="ubp-xhs-follow" style="background:var(--ubp-card-2);color:var(--ubp-text-3);cursor:default;">${follows.includes(note.author) ? '已关注' : ''}</span>`;
  const threads = buildCommentThreads(note.comments);
  const idxOf = new Map(note.comments.map((c, i) => [c, i]));
  const comments = threads.map(t => {
    const ci = idxOf.get(t.comment)!;
    const subs = renderSubReplies({
      kind: 'xhs',
      threadKey: `xhs:${note.id}:${ci}`,
      postId: note.id,
      rootName: t.comment.name,
      subs: t.replies.map(r => ({
        idx: idxOf.get(r)!,
        name: r.name,
        text: r.text,
        replyTo: r.replyTo,
        time: r.time ? commentTimeText(r, note, getRoster().global.time) : '',
        mine: r.name === me || r.anon === true,
        isAuthor: r.name === note.author,
      })),
    });
    return renderComment(note, t.comment, ci, me, subs);
  }).join('');
  return `<div data-ubp-lp-post="${escapeAttr(note.id)}"><div class="ubp-xhs-coverbig">
    ${note.imageDesc ? renderBigCover(note) : ''}
    ${note.imageDesc ? '<div class="ubp-xhs-dots"><i class="on"></i></div>' : ''}
  </div>
  <div class="ubp-xhs-authorrow">
    ${avatarHtml(note.author, '', true)}
    <span class="ubp-xhs-aname"${note.author !== me && !note.anon ? ` style="cursor:pointer;" data-ubp-act="open-author" data-id="${escapeAttr(note.author)}"` : ''}>${escapeHtml(note.author)}${note.author === me || note.anon ? '<i class="ubp-mo-metag">（我）</i>' : ''}</span>
    ${note.author !== me && !note.anon ? followBtn : ''}
  </div>
  <div style="padding:0 16px 4px;">
    <div class="ubp-xhs-ntitle">${escapeHtml(note.title)}</div>
    <div class="ubp-xhs-nbody">${escapeHtml(note.content)}</div>
    ${note.tags.length ? `<div class="ubp-xhs-ntags">${note.tags.map(t => `#${escapeHtml(t)}`).join(' ')}</div>` : ''}
    <div class="ubp-xhs-nmeta">${escapeHtml(postTimeText(note, getRoster().global.time))}</div>
  </div>
  <div class="ubp-xhs-div"></div>
  <div class="ubp-xhs-cmts">
    <div class="ubp-xhs-cmthd">共 ${note.comments.length} 条${_P?.commentNoun || '评论'}</div>
    ${comments || `<div class="ubp-empty">还没有${_P?.commentNoun || '评论'}，说点什么吧～</div>`}
  </div></div>
  <div class="ubp-xhs-actionbar">
    <button type="button" class="ubp-xhs-ainput" data-ubp-act="comment" data-id="${escapeAttr(note.id)}" style="border:none;cursor:pointer;text-align:left;font-family:var(--ubp-font);">说点什么…</button>
    <button type="button" class="ubp-xhs-aact${note.likedByMe ? ' on' : ''}" data-ubp-act="like" data-id="${escapeAttr(note.id)}">${actIcon(note.likedByMe === true, 'like')}${countLabel(note.likes)}</button>
    <button type="button" class="ubp-xhs-aact star${note.collectedByMe ? ' on' : ''}" data-ubp-act="collect" data-id="${escapeAttr(note.id)}" title="${escapeAttr(_P?.collectNoun || '收藏')}">${actIcon(note.collectedByMe === true, 'star')}${countLabel(note.collects)}</button>
    <button type="button" class="ubp-xhs-aact" data-ubp-act="comment" data-id="${escapeAttr(note.id)}">${ubpIcon('comment')}${note.comments.length}</button>
    <button type="button" class="ubp-xhs-aact" data-ubp-act="share" data-id="${escapeAttr(note.id)}" title="分享到聊天">${ubpIcon('share')}${s(currentStyle(), '分享', '转寄', '转寄', '转递')}</button>
  </div>`;
}

// ─── 分享到聊天（统一转发模块：forward-model 转换 + forward-sheet 目标弹层） ───

/** 笔记 → 分享快照（标题+正文+封面+评论；成品图引用 imagePath；楼中楼压回复前缀）。 */
function xhsShareSnapshot(note: XhsNote): SharePostSnapshot {
  return {
    app: 'xhs',
    author: note.author,
    title: note.title,
    text: note.content,
    images: note.imageDesc
      ? [{ desc: note.imageDesc, ...(note.imagePath && note.imageStatus === 'ready' ? { imagePath: note.imagePath } : {}) }]
      : [],
    comments: note.comments.map(c => ({
      name: c.name,
      text: c.text,
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
      ...(c.imageDesc?.trim()
        ? { image: { desc: c.imageDesc, ...(c.imagePath && c.imageStatus === 'ready' ? { imagePath: c.imagePath } : {}) } }
        : {}),
    })),
  };
}

/** 分享到聊天：笔记转「聊天记录」消息 → 弹目标选择 → 落库（整条算一条消息，上屏不触发 AI）。 */
function shareNoteToChat(note: XhsNote): void {
  if (!_ctx) return;
  const message = buildShareMessage(xhsShareSnapshot(note), getRoster().global.time);
  if (!message) return;
  openForwardTargetSheet(_ctx, pick => {
    if (appendForwardedMessage(pick, message)) {
      // L9 成就：玩家亲手把笔记分享到聊天成功
      emitAch('phone_share_to_chat', { platform: 'xhs' });
      toast('已分享到聊天');
    }
  });
}

// ─── 长按操作面板（笔记=分享/删除；评论/回复=删除，连带楼中楼子回复） ───

function deletePostAndRender(noteId: string): void {
  try {
    deleteUserPost('xhs', noteId);
    // L9 成就：玩家亲手删除笔记成功（失败分支不打点）
    emitAch('phone_post_deleted', { platform: 'xhs' });
    if (_openNoteId === noteId) _openNoteId = null;
    emitPhoneEvent('ubp-phone:data-changed');
    toast('已删除');
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
  render();
}

function openPostActionSheet(noteId: string): void {
  if (!_ctx) return;
  const note = findNote(noteId);
  if (!note) return;
  openActionSheet(_ctx.container, {
    title: note.title,
    items: [
      { act: 'share', label: '分享到聊天' },
      { act: 'del', label: '删除笔记', danger: true },
    ],
    onPick: act => {
      if (act === 'share') {
        const cur = findNote(noteId);
        if (cur) shareNoteToChat(cur);
        return;
      }
      if (act === 'del') deletePostAndRender(noteId);
    },
  });
}

function openCommentDeleteSheet(noteId: string, idx: number): void {
  if (!_ctx) return;
  const target = findNote(noteId)?.comments[idx];
  if (!target) return;
  openActionSheet(_ctx.container, {
    title: `删除 ${target.name} 的这条${target.replyTo ? '回复' : '评论'}？`,
    body: '其楼中楼的子回复将一并删除，删除后不可恢复。',
    items: [{ act: 'del', label: '删除', danger: true }],
    onPick: act => {
      if (act !== 'del') return;
      try {
        deleteSocialComment('xhs', noteId, idx);
        emitPhoneEvent('ubp-phone:data-changed');
        toast('已删除');
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      render();
    },
  });
}

function renderBigCover(note: XhsNote): string {
  if (note.imagePath && note.imageStatus === 'ready') {
    return `<button type="button" class="ubp-mo-img" data-ubp-act="zoom" data-id="${escapeAttr(note.imagePath)}" title="查看大图" style="display:block;width:100%;">
      <img src="${escapeAttr(note.imagePath)}" alt="" loading="lazy"></button>`;
  }
  const busy = note.imageStatus === 'pending' && isSocialImageActive(note.id);
  const failed = note.imageStatus === 'failed';
  return `<button type="button" class="ubp-mo-imgph${failed ? ' failed' : ''}" data-ubp-act="gen-img" data-id="${escapeAttr(note.id)}" ${busy ? 'disabled' : ''} style="width:100%;">
    ${busy ? '<span class="ubp-spinner"></span>' : failed ? '<span class="ubp-mo-imgph-note">⚠ 生成失败</span>' : ubpIcon('image')}
    <span class="ubp-mo-imgph-desc">${escapeHtml(note.imageDesc)}</span>
    <span class="ubp-mo-imgph-hint">${busy ? '封面生成中…' : failed ? '点击重试' : '点击生成封面'}</span>
  </button>`;
}

function renderComment(note: XhsNote, comment: { name: string; text: string; replyTo?: string; time?: string; anon?: true }, idx: number, me: string, subs = ''): string {
  const mine = comment.name === me;
  const mineTag = mine || comment.anon === true;   // 匿名评论也标淡色「（我）」
  const replyBtn = mine ? '' : `<button type="button" class="ubp-mo-creply" data-ubp-act="reply-c" data-id="${escapeAttr(note.id)}" data-idx="${idx}">回复</button>`;
  const auz = !mine && comment.name === note.author ? '<i class="ubp-xhs-auz">作者</i>' : '';
  const time = comment.time ? `<span>${escapeHtml(commentTimeText(comment, note, getRoster().global.time))}</span>` : '';
  return `<div class="ubp-xhs-cmt" data-ubp-cidx="${idx}">
    ${avatarHtml(comment.name, '', true)}
    <div class="ubp-xhs-cmtmain">
      <div class="ubp-xhs-cmtname">${escapeHtml(comment.name)}${auz}${mineTag ? '<i class="ubp-mo-metag">（我）</i>' : ''}</div>
      <div class="ubp-xhs-cmttext">${comment.replyTo ? `<b>回复 @${escapeHtml(comment.replyTo)}</b>：` : ''}${escapeHtml(comment.text)}</div>
      <div class="ubp-xhs-cmtmeta">${time}${replyBtn}</div>
      ${subs}
    </div>
  </div>`;
}

// ─── 评论浮层 ───

function renderCommentSheet(): string {
  if (!_commentTarget) return '';
  const placeholder = _commentTarget.replyTo ? `回复 ${_commentTarget.replyTo}…` : '说点什么…';
  return `<div class="ubp-overlay ubp-mo-composer">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">写${_P?.commentNoun || '评论'}</div>
      <textarea class="ubp-textarea" data-ubp-input="comment-text" rows="3" placeholder="${escapeHtml(placeholder)}">${escapeHtml(_commentTarget.text)}</textarea>
      ${anonRowHtml(_commentTarget.anon, _commentTarget.anonName)}
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="comment-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="comment-send">发送</button>
      </div>
    </div>
  </div>`;
}

// ─── 发布面板（全页面，对照 mockup x-compose） ───

function renderComposePage(): string {
  const c = _composer;
  if (!c) return '';
  const sendable = Boolean(c.title.trim()) && Boolean(c.text.trim()) && (!c.cameraMode || Boolean(c.imgDesc.trim()) || Boolean(c.imgPath));
  const cover = c.imgPath
    ? `<button type="button" class="ubp-xhs-cp-cover" data-ubp-act="compose-cover"><img src="${escapeAttr(c.imgPath)}" alt=""></button>`
    : `<button type="button" class="ubp-xhs-cp-cover" data-ubp-act="compose-cover">${ubpIcon(c.cameraMode ? 'image' : 'plus')}<span>${c.cameraMode ? '描述生图' : '添加封面'}</span></button>`;
  return `<div class="ubp-xhs-compose">
    ${socialDetailNav({ backAct: 'compose-cancel', title: `发布${_P?.noteNoun || '笔记'}` })}
    <div class="ubp-xhs-cp-body">
      ${cover}
      ${!c.imgPath && !c.cameraMode ? `<div class="ubp-mo-attachrow" style="margin-top:10px;"><button type="button" class="ubp-btn" data-ubp-act="compose-camera">${ubpIcon('camera')}拍照描述生图</button></div>` : ''}
      ${c.cameraMode && !c.imgPath ? `<textarea class="ubp-textarea" data-ubp-input="compose-imgdesc" rows="2" style="margin-top:10px;" placeholder="封面画面描述（发布后按描述生成封面）">${escapeHtml(c.imgDesc)}</textarea>` : ''}
      <input class="ubp-xhs-cp-title" data-ubp-input="compose-title" maxlength="40" placeholder="填写标题" value="${escapeAttr(c.title)}">
      <textarea class="ubp-xhs-cp-text" data-ubp-input="compose-text" placeholder="正文">${escapeHtml(c.text)}</textarea>
      <input class="ubp-xhs-cp-tags" data-ubp-input="compose-tags" maxlength="60" placeholder="# 添加话题标签（空格分隔，如：探店 周末去哪儿）" value="${escapeAttr(c.tags)}">
      ${anonRowHtml(c.anon, c.anonName)}
    </div>
    <div class="ubp-xhs-cp-bar">
      <span class="ubp-xhs-cp-hint">封面可选：相册选图 / 拍照描述生图</span>
      <button type="button" class="ubp-xhs-cp-pub" data-ubp-act="compose-send" ${sendable ? '' : 'disabled'}>发布</button>
    </div>
  </div>`;
}

function openComposePage(): void {
  _composePage = true;
  _composer = { title: '', text: '', tags: '', imgPath: '', imgDesc: '', cameraMode: false, anon: false, anonName: '' };
  render();
}

function openCoverPicker(): void {
  if (!_ctx || !_composer) return;
  openImagePickerSheet(_ctx.container, {
    mode: 'context',
    title: '选择封面',
    emptyText: '相册还是空的——用「拍照描述生图」先拍一张',
    onPick: img => {
      if (!_composer) return;
      _composer.imgPath = img.path;
      _composer.imgDesc = composeImageDesc(img.desc, img.origin); // 拼来源（「小明的小红书：…」）；描述要进 AI 上下文
      _composer.cameraMode = false;
      render();
    },
  });
}

async function sendComposePage(): Promise<void> {
  if (!_composer) return;
  const c = _composer;
  const text = c.text.trim();
  if (!text || !c.title.trim()) return;
  const tags = c.tags.split(/[\s#，,]+/).map(t => t.trim()).filter(Boolean).slice(0, 6);
  const { postId } = createUserPost({
    kind: 'xhs',
    text,
    title: c.title.trim(),
    tags,
    ...(c.anon ? { anon: true, anonName: c.anonName } : {}),
    ...(c.imgPath ? { imagePath: c.imgPath } : {}),
    imageDesc: c.imgPath ? c.imgDesc : c.cameraMode ? composeShootDesc(c.imgDesc, getRoster()) : '',
  });
  _composer = null;
  _composePage = false;
  _openNoteId = postId;
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手发布笔记成功（附图意图即算 hasImage；匿名按开关）
  emitAch('phone_post_published', {
    platform: 'xhs',
    hasImage: achFlag(!!c.imgPath || (c.cameraMode && c.imgDesc.trim())),
    anon: achFlag(c.anon),
    isRepost: 0,
  });
  emitActionOnDate('phone_post');
  toast(c.anon ? '已匿名发布' : '已发布');
  if (c.cameraMode && c.imgDesc.trim()) {
    try { await generateSocialImage('xhs', postId); } catch (_e) { /* 占位已落 failed */ }
    if (_ctx) render();
  }
}

// ─── 刷新与求回应 ───

async function doRefresh(hint?: string, picked?: string[], focusAuthor?: string, focusKeyword?: string): Promise<void> {
  if (_busy) return;
  _busy = true;
  _lastAttempt = { action: focusAuthor ? 'author' : 'refresh', ...(focusAuthor ? { focusAuthor } : {}), ...(focusKeyword ? { focusKeyword } : {}), hint: hint || '', picked: picked || [] };
  _error = '';
  render();
  try {
    await refreshSocialSnapshot({ kind: 'xhs', ...(focusAuthor ? { focus: { author: focusAuthor } } : focusKeyword ? { focus: { keyword: focusKeyword } } : {}), ...(hint ? { extraHint: hint } : {}) , ...(picked && picked.length ? { focusNames: picked } : {}) });
    emitPhoneEvent('ubp-phone:data-changed');
    if (_openNoteId && !findNote(_openNoteId)) _openNoteId = null;
    toast(focusAuthor ? `${focusAuthor} 主页已刷新` : focusKeyword ? `「${focusKeyword}」已收录相关${_P?.noteNoun || '笔记'}` : (_P?.appName ? `${_P.appName}已刷新` : '小红书已刷新'));
  } catch (e) {
    _error = isPhoneAbortError(e) ? '' : (e instanceof Error ? e.message : String(e));
  } finally {
    _busy = false;
    render();
    void autoGenerateSocialImages('xhs').then(() => { if (_ctx) render(); });
  }
}

// ─── 主渲染 ───

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const prevBody = container.querySelector<HTMLElement>('.ubp-appbody');
  const prevScrollTop = prevBody?.scrollTop ?? 0;
  _feedHasMore = false; // 详情/消息/我的/发布页不分页，只有首页瀑布流是信息流

  const me = getRoster().protagonistName;
  const social = currentSocial(); // 帧级一次（本帧各处共用，禁重复深拷贝；对齐 readSocialFollows 纪律）
  const follows = readSocialFollows(); // 帧级一次（禁渲染循环重复深拷贝）
  const followsXhs = follows.xhs;
  _P = xhsSkinProfile(currentStyle()); // 帧级皮肤档案（云笈录/风物志/藏宝图鉴；现代=null）
  const pendingActions = getPendingActions(social); // 用本帧 social 快照（帧级一次，免二次全量深拷贝）
  const pendingCount = pendingActions.length;
  const msgUnread = getSocialNotificationUnread('xhs'); // 零拷贝 ref 读（徽标热路径纪律）
  const fbBusy = isFeedbackGenerating();
  const autoBusy = isAutoImageRunning('xhs');
  const busyHtml = `
    ${_error ? `<div class="ubp-mo-error">${escapeHtml(_error)}<button class="ubp-mo-retry" data-ubp-act="retry-gen">重试</button></div>` : ''}
    ${_busy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>正在刷新${escapeHtml(_P?.appName || '小红书')}…<button class="ubp-btn" data-ubp-act="abort">终止</button></div>` : ''}
    ${fbBusy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>正在生成互动回应…<button class="ubp-btn" data-ubp-act="abort">终止</button></div>` : ''}
    ${autoBusy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>正在批量生成封面…</div>` : ''}`;

  const openNote = _openNoteId ? findNote(_openNoteId, social) : null;
  // 滚动记忆视图键：笔记/作者/搜索页各自独立，列表按 tab+分段分记（键变=换视图，进详情从顶部开始）
  const viewKey = _composePage ? 'compose'
    : openNote ? `note:${openNote.id}`
    : _openAuthor ? `author:${_openAuthor}`
    : _openKeyword ? `kw:${_openKeyword}`
    : `${_tab}:${_homeSeg}`;

  // 发布面板（全页面，覆盖一切视图）：无 .ubp-appbody，只需把旧视图位置记进记忆再走
  if (_composePage) {
    _viewScroll.settle(viewKey, prevScrollTop);
    // 发布页自身的内滚区在重建里被换新（.ubp-xhs-cp-body）：点「匿名发布」/选图后留在原处，不回顶
    const prevCpTop = container.querySelector('.ubp-xhs-cp-body')?.scrollTop ?? 0;
    container.innerHTML = `<div class="ubp-xhs">${renderComposePage()}</div>`;
    const cpBody = container.querySelector('.ubp-xhs-cp-body');
    if (cpBody && prevCpTop) cpBody.scrollTop = prevCpTop;
    return;
  }

  let topHtml = '';
  let bodyInner = '';
  let showTabbar = true;
  let activeTab = _tab;

  if (openNote) {
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'back-list',
      title: _P?.noteNoun || '笔记',
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }),
    });
    bodyInner = busyHtml + renderNoteDetail(openNote, followsXhs);
  } else if (_openAuthor) {
    // 作者主页：导航（返回 + 主页标题 + 求回应/作者定点刷新）
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'author-back',
      title: `${_openAuthor} · 主页`,
      sub: `刷新只出该作者${_P?.noteNoun || '笔记'}`,
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy, refreshTitle: `作者刷新（生成 ${_openAuthor} 的最新 2-4 篇${_P?.noteNoun || '笔记'}）` }),
    });
    bodyInner = busyHtml + renderAuthorHome(_openAuthor, followsXhs, social.xhs);
  } else if (_openKeyword) {
    // 搜索结果页：导航（返回 + 关键词 + 求回应/关键词定点生成）+ 搜索 hero + 相关笔记瀑布流
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'back-search',
      title: `${s(currentStyle(), '搜索', '检索')}：${_openKeyword}`,
      sub: s(currentStyle(), `刷新只出该关键词相关${_P?.noteNoun || '笔记'}`, `刷新只出该词相关${_P?.noteNoun || '云笈'}`),
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy, refreshTitle: `关键词刷新（围绕「${_openKeyword}」生成新${_P?.noteNoun || '笔记'}）` }),
    });
    bodyInner = busyHtml + renderSearchResults(_openKeyword, social.xhs, me);
  } else if (_tab === 'messages') {
    topHtml = socialDetailNav({ backAct: 'exit', title: socialSkinProfile(currentStyle())?.tabMessages || '消息', actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }) });
    bodyInner = busyHtml + renderSocialMessages('xhs', pendingActions, social);
  } else if (_tab === 'me') {
    topHtml = socialDetailNav({ backAct: 'exit', title: `我的${_P?.appName || '小红书'}`, actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }) });
    bodyInner = busyHtml + renderSocialMe('xhs', follows, _meFollowsOpen, social);
  } else {
    // 首页：搜索胶囊 + 关注/发现分段（皮肤=结缘/拾遗）
    const all = social.xhs;
    const notes = _homeSeg === 'follow' ? all.filter(n => followsXhs.includes(n.author) || n.author === me) : all;
    const hotTag = all[0]?.tags[0];
    topHtml = `<div class="ubp-stop">
      <div class="ubp-stop-row">
        <button type="button" class="ubp-stop-search" data-ubp-act="search" title="${s(currentStyle(), '搜索', '检索')}">${ubpIcon('search')}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(_P?.searchLead || '大家都在搜')} <b>${escapeHtml(hotTag || (_P ? '今日好物' : '临江探店'))}</b>｜${escapeHtml(all[1]?.tags[0] || (_P ? '周末游历' : '周末去哪儿'))}</span></button>
        <div class="ubp-stop-acts">
          <button class="ubp-iconbtn ubp-sbell${pendingCount ? ' has' : ''}" data-ubp-act="nav" data-id="messages" title="消息（待回应互动）">${ubpIcon('bell')}</button>
          ${pendingCount ? `<button class="ubp-iconbtn ubp-fbbadge" data-ubp-act="feedback" title="求回应" ${fbBusy || _busy ? 'disabled' : ''}>${ubpIcon('comment')}<i>${pendingCount}</i></button>` : ''}
          <button class="ubp-iconbtn" data-ubp-act="refresh" title="刷新" ${_busy ? 'disabled' : ''}>
            <span class="${_busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span>
          </button>
        </div>
      </div>
      <div class="ubp-sseg">${socialSeg([{ id: 'follow', label: _P?.segFollow || '关注' }, { id: 'discover', label: _P?.segDiscover || '发现' }], _homeSeg)}</div>
    </div>`;
    const { page, hasMore, remaining } = paginateFeed(notes, _feedVisible); // 瀑布流只渲染最近10篇，余下触底加载
    _feedHasMore = hasMore;
    bodyInner = busyHtml + renderCards(page, me) + (hasMore ? feedMoreHtml(remaining) : '')
      + (_homeSeg === 'follow' && !notes.length ? `<div class="ubp-empty"><b>${s(currentStyle(), '关注的', '已结交的')}作者还没有${_P?.noteNoun || '笔记'}</b><br>打开${_P?.noteNoun || '笔记'}点「${s(currentStyle(), '关注', '结交')}」，或切到「${_P?.segDiscover || '发现'}」逛逛</div>` : '');
  }

  container.innerHTML = renderSocialShell({
    appClass: 'ubp-xhs',
    topHtml,
    bodyInner: `${bodyInner}<div style="height:${showTabbar ? 12 : 20}px;"></div>`,
    tabs: TABS.map(t => ({ ...t, label: tabLabel(t.id), ...(t.id === 'messages' ? { badge: msgUnread } : {}) })),
    activeTab,
    composeAct: 'compose-page',
    showTabbar,
    extraHtml: `
      ${_commentTarget ? renderCommentSheet() : ''}`,
  });
  const body = container.querySelector<HTMLElement>('.ubp-appbody');
  if (body) {
    // 跨视图保位：详情/作者页首次进入从顶部开始，返回瀑布流回到离开时读到的位置（同视图重绘=原位）
    const target = _pendingTop !== null ? _pendingTop : _viewScroll.settle(viewKey, prevScrollTop).top;
    _pendingTop = null;
    body.scrollTop = target;
    markFeedScrollRestore(body); // 这条位置是保位填回的：补派的 scroll 不算用户滚动（免得白扩一页）
    // 视口未满或记忆位超出已渲染高度 → 自动扩页（分页被重置/内容变短时也要够得着；有界递归，页面耗尽即停）
    if (_feedHasMore && body.scrollHeight <= target + body.clientHeight + 1) {
      _pendingTop = target;
      loadMoreFeed();
    }
  }
}

// ─── 评论浮层状态（复用 composer 前先独立，避免与发布面板互踩） ───

let _commentTarget: { noteId: string; replyTo?: string; text: string; anon: boolean; anonName: string } | null = null;

function openCommentSheet(noteId: string, replyTo?: string): void {
  _commentTarget = { noteId, replyTo, text: '', anon: false, anonName: '' };
  render();
}

/** 评论草稿在输入时就写回状态（见 handleInput），任何重绘（含匿名开关）都不丢字——
 *  原先靠 stashCommentDraft 事后读 DOM 打补丁，异步重绘（生图完成等）仍会吞字，已退役。 */

async function sendCommentSheet(): Promise<void> {
  if (!_ctx || !_commentTarget) return;
  // 发送时仍以输入框现读值为准（用户最后一次敲的字符先于 input 事件结算也在 DOM 里）
  const input = _ctx.container.querySelector('[data-ubp-input="comment-text"]') as HTMLTextAreaElement | null;
  const anonInput = _ctx.container.querySelector('[data-ubp-input="compose-anonname"]') as HTMLInputElement | null;
  const text = (input?.value || '').trim();
  if (!text) return;
  const commentReplyTo = !!_commentTarget.replyTo; // L9：提交后 _commentTarget 清空，先取楼中楼标记
  addSocialComment({
    kind: 'xhs',
    postId: _commentTarget.noteId,
    text,
    ...(_commentTarget.replyTo ? { replyTo: _commentTarget.replyTo } : {}),
    ...(_commentTarget.anon ? { anon: true, anonName: anonInput?.value || _commentTarget.anonName } : {}),
  });
  _commentTarget = null;
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手评论/楼中楼成功（isReply 从提交前目标读取，提交后 _commentTarget 已清空）
  emitAch('phone_comment_posted', { platform: 'xhs', isReply: achFlag(!!commentReplyTo) });
}

function handleClick(event: Event): void {
  if (longPressJustFired()) return; // 长按分享刚触发：吞掉残留 click（防误开笔记）
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const id = el.dataset.id || '';
  switch (act) {
    case 'exit': _ctx?.closeApp(); break;
    case 'back-list': _openNoteId = null; render(); break;
    case 'back-search': _openKeyword = null; render(); break; // 搜索页返回（笔记详情返回走 back-list，保留搜索态）
    // 搜索：输入关键词 → 进搜索结果页（复用瀑布流卡片）并围绕该关键词定向生成一次
    case 'search': {
      if (!_ctx) break;
      const hint = currentSocial().xhs[0]?.tags[0] || '';
      openSearchSheet(_ctx.container, {
        title: s(currentStyle(), '搜索小红书', '搜索云笈录', '搜索风物志', '搜索藏宝图鉴'),
        placeholder: s(currentStyle(), `输入关键词，如：${hint || '临江探店'}`, `输入关键词，如：${hint || '灵膳'}`),
        onSubmit: kw => {
          // L9 成就：玩家亲手提交搜索（小红书域；AI 定向生成与成败无关）
          emitAch('phone_search_performed', { scope: 'xhs' });
          _openKeyword = kw;
          _openNoteId = null;
          _openAuthor = null;
          _feedVisible = FEED_PAGE_SIZE;
          render();
          void doRefresh(undefined, undefined, undefined, kw);
        },
      });
      break;
    }
    case 'nav': {
      const next = (TABS.find(t => t.id === id)?.id || 'discover') as XhsTab;
      if (next !== _tab || _openKeyword) {
        _tab = next;
        _openNoteId = null;
        _openKeyword = null;
        _feedVisible = FEED_PAGE_SIZE; // 换信息流：分页重置
        render();
      }
      break;
    }
    case 'seg': {
      const next = id === 'follow' ? 'follow' : 'discover';
      if (next !== _homeSeg) {
        _homeSeg = next;
        _feedVisible = FEED_PAGE_SIZE; // 换分段：分页重置
        render();
      }
      break;
    }
    case 'refresh': void doRefresh(undefined, undefined, _openAuthor || undefined, _openKeyword || undefined); break;
    case 'abort': abortSocialGeneration(); break;
    case 'feedback': void doFeedback(); break;
    case 'retry-gen': {
      if (!_lastAttempt) break;
      if (_lastAttempt.action === 'refresh') void doRefresh(_lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined, undefined, _lastAttempt.focusKeyword);
      else if (_lastAttempt.action === 'author') void doRefresh(_lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined, _lastAttempt.focusAuthor);
      else void doFeedback(_lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined);
      break;
    }
    case 'open-author':
      _openAuthor = id;
      _openNoteId = null;
      _openKeyword = null;
      ensureAuthorProfile(id);
      render();
      break;
    case 'author-back': _openAuthor = null; render(); break;
    case 'open-follow': {
      _openAuthor = id;
      _openNoteId = null;
      _openKeyword = null;
      ensureAuthorProfile(id);
      render();
      break;
    }
    case 'my-follows': _meFollowsOpen = !_meFollowsOpen; render(); break;
    case 'sub-open': toggleSubThread(id); render(); break;
    case 'open-note': _openNoteId = id; resetSubThreads(); readPost('xhs', id); render(); break;
    case 'open-notify': {
      const postId = readNotification('xhs', id);
      if (postId) {
        if (findNote(postId)) _openNoteId = postId;
        else toast('内容已删除');
      }
      render();
      break;
    }
    case 'mark-all-read': readAllNotifications('xhs'); render(); break;
    case 'like': {
      // L9 成就：点赞（取消赞不计）
      if (toggleLike('xhs', id).liked) emitAch('phone_like_given', { platform: 'xhs' });
      emitPhoneEvent('ubp-phone:data-changed');
      render();
      pulseActIcon(_ctx?.container ?? null, 'like', id); // 点亮脉冲：必须在重绘之后挂（重绘会丢类）
      break;
    }
    case 'collect': {
      const { collected } = toggleCollect(id);
      // L9 成就：收藏笔记（取消收藏不计）
      if (collected) emitAch('phone_collect_given', { platform: 'xhs' });
      emitPhoneEvent('ubp-phone:data-changed');
      if (collected) toast(_P ? `已${_P.collectNoun} ⭐` : '已收藏 ⭐');
      render();
      pulseActIcon(_ctx?.container ?? null, 'collect', id); // 点亮脉冲：必须在重绘之后挂（重绘会丢类）
      break;
    }
    case 'follow': {
      const scope = el.dataset.scope as 'bars' | 'weibo' | 'xhs';
      const { followed } = toggleFollow(scope || 'xhs', id);
      // L9 成就：关注/取关都发（成就侧只匹配 on:1）
      emitAch('phone_follow_changed', { platform: 'xhs', on: achFlag(followed) });
      emitPhoneEvent('ubp-phone:data-changed');
      toast(followed ? `${s(currentStyle(), '已关注', '已结交')} ${id}` : `${s(currentStyle(), '已取消关注', '已解除结交')} ${id}`);
      // 主页内重新关注：取关时资料已清，立即补生成
      if (followed && _openAuthor === id) ensureAuthorProfile(id);
      break;
    }
    case 'del-post': {
      if (_ctx) openConfirmSheet(_ctx.container, {
        title: '删除这篇笔记？',
        message: '删除后无法恢复。',
        confirmLabel: '删除',
        onConfirm: () => {
          try {
            deleteUserPost('xhs', id);
            // L9 成就：长按菜单删除成功
            emitAch('phone_post_deleted', { platform: 'xhs' });
            emitPhoneEvent('ubp-phone:data-changed');
            toast('已删除');
          } catch (e) {
            toast(e instanceof Error ? e.message : String(e));
          }
          render();
        },
      });
      break;
    }
    case 'comment': openCommentSheet(id); break;
    case 'share': {
      const note = findNote(id);
      if (note) shareNoteToChat(note);
      break;
    }
    case 'reply-c': {
      const idx = Number(el.dataset.idx || '-1');
      const note = findNote(id);
      const target = note?.comments[idx];
      if (target) openCommentSheet(id, target.name);
      break;
    }
    case 'comment-cancel': _commentTarget = null; render(); break;
    case 'comment-send': void sendCommentSheet(); break;
    case 'compose-anon':
      // 匿名开关：评论浮层（草稿现读值，先回写防丢字）与发布页共用同一动作名
      if (_commentTarget) { _commentTarget.anon = !_commentTarget.anon; render(); }
      else if (_composer) { _composer.anon = !_composer.anon; render(); }
      break;
    case 'compose-page': openComposePage(); break;
    case 'compose-cancel': _composePage = false; _composer = null; render(); break;
    case 'compose-cover': openCoverPicker(); break;
    case 'compose-camera':
      if (_composer) {
        _composer.cameraMode = true;
        _composer.imgPath = '';
        render();
      }
      break;
    case 'compose-send': void sendComposePage(); break;
    case 'gen-img':
      void generateSocialImage('xhs', id)
        .then(() => { emitPhoneEvent('ubp-phone:data-changed'); })
        .catch(e => toast(e instanceof Error ? e.message : String(e)))
        .finally(() => { if (_ctx) render(); });
      break;
    case 'zoom': {
      openPhoneLightbox(_ctx?.container, { paths: [id] });
      break;
    }
    default: break;
  }
}

function handleInput(event: Event): void {
  const el = event.target as HTMLElement;
  const field = el.dataset?.ubpInput;
  if (!field) return;
  const value = (el as HTMLTextAreaElement | HTMLInputElement).value;
  // 评论草稿随输入即时落状态（浮层任何重绘都不丢字；发送仍以 DOM 现读值为准）
  if (field === 'comment-text') { if (_commentTarget) _commentTarget.text = value; return; }
  if (field === 'compose-anonname' && _commentTarget) { _commentTarget.anonName = value; return; }
  if (!_composer) return;
  if (field === 'compose-text') _composer.text = value;
  else if (field === 'compose-title') _composer.title = value;
  else if (field === 'compose-tags') _composer.tags = value;
  else if (field === 'compose-imgdesc') _composer.imgDesc = value;
  else if (field === 'compose-anonname') _composer.anonName = value;
  // 交互态原地更新（渲染纪律）：发布按钮解禁不整帧重绘
  const c = _composer;
  const sendable = Boolean(c.title.trim()) && Boolean(c.text.trim()) && (!c.cameraMode || Boolean(c.imgDesc.trim()) || Boolean(c.imgPath));
  const btn = _ctx?.container.querySelector('[data-ubp-act="compose-send"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = !sendable;
}

export const xhsApp: PhoneApp = {
  id: 'xhs',
  name: '小红书',
  icon: ubpIcon('xhs'),
  color: '#FF2442',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _error = '';
    _openNoteId = takePendingAppTarget('xhs'); // 全局搜索 / 锁屏通知深链：直接落在该笔记详情（目标不存在时渲染回落双列）
    if (_openNoteId) readPost('xhs', _openNoteId); // 深链=看过该笔记：只清这一篇的通知未读
    _openAuthor = null;
    _openKeyword = null;
    _meFollowsOpen = false;
    _composePage = false;
    _commentTarget = null;
    _composer = null;
    _feedVisible = FEED_PAGE_SIZE; // 分页重置：首屏只渲染最近10篇笔记
    _viewScroll.clear(); // 滚动记忆重置：重开 App 从顶开始，不继承上一次打开时的位置
    _pendingTop = null;
    // 未读逐条已读：打开 App 不清角标，消息页点开该条（或全部已读）才清
    ctx.container.addEventListener('click', handleClick);
    // 长按「刷新/求回应」=一次性提示
    const unbindHintLongPress = bindHintLongPress(ctx.container, target => {
      if (target.closest('[data-ubp-act="refresh"]')) return { el: target.closest('[data-ubp-act="refresh"]') as HTMLElement, fire: openRefreshHint };
      if (target.closest('[data-ubp-act="feedback"]')) return { el: target.closest('[data-ubp-act="feedback"]') as HTMLElement, fire: openFeedbackHint };
      return null;
    });
    ctx.container.addEventListener('input', handleInput);
    const unbindFeedScroll = bindFeedScroll(ctx.container, () => _feedHasMore, loadMoreFeed);
    // 长按委托：笔记卡/详情正文=操作面板（分享/删除），评论/子回复=删除面板
    const unbindLongPress = bindLongPress(
      ctx.container,
      t => t.closest('[data-ubp-cidx]') || t.closest('.ubp-xhs-card[data-ubp-act="open-note"], [data-ubp-lp-post]'),
      el => {
        const cidx = el.dataset.ubpCidx;
        if (cidx !== undefined && _openNoteId) openCommentDeleteSheet(_openNoteId, Number(cidx));
        else openPostActionSheet(el.dataset.ubpLpPost || el.dataset.id || '');
      },
    );
    render();
    void autoGenerateSocialImages('xhs').then(() => { if (_ctx) render(); });
    // L18②(第十二轮)：外部投递（正文联动 / 世界演化）落库后，正打开的社媒 App 也能立即看到新帖。
    // 订阅在挂载期生效、卸载即退订（同 app-spy 范式）；重渲由 _ctx 守卫兜住已卸载场景。
    const offDataChanged = onPhoneEvent('ubp-phone:data-changed', () => { if (_ctx) render(); });

    return () => {
      ctx.container.removeEventListener('click', handleClick);
      unbindHintLongPress();
      ctx.container.removeEventListener('input', handleInput);
      unbindFeedScroll();
      unbindLongPress();
      offDataChanged();
      _ctx = null;
    };
  },
};
