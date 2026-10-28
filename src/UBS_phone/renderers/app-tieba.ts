// ===== 贴吧 App：吧为中心 + 楼层盖楼（蓝紫主题；风格对照 docs/social-three-apps-mockup.html） =====
// 骨架：品牌渐变顶栏（logo+搜索胶囊+铃铛）+ 关注/推荐/热议分段 + 底部五格 Tab（首页/进吧/＋/消息/我的）。
// 层级：首页（分段过滤）→ 吧详情（进吧列表点击进入：吧头部关注/签到 + 吧内定点刷新 + 该吧帖子）→ 帖子楼层详情（点吧名标题可进吧）。
// 刷新语义：首页刷新=整版快照；吧详情刷新=focus.bar 只出该吧新帖（不重写吧表）；顶栏「求回应」=互动反馈。
// 互动层：点赞/回帖（本地即时生效，记入待反馈清单）+ 发帖（选吧+标题+正文+附图）+ 我的页二次确认删帖。
// 趣味交互：吧签到（本地彩蛋，会话内记忆，不进 AI 管线）。

import {
  abortSocialGeneration,
  addSocialComment,
  addTiebaBar,
  createUserPost,
  deleteSocialComment,
  deleteTiebaBar,
  deleteUserPost,
  getPendingActions,
  getSocialNotificationUnread,
  isFeedbackGenerating,
  readSocialFollows,
  refreshSocialSnapshot,
  toggleFollow,
  toggleLike,
} from '../core/social-engine';
import { isPhoneAbortError } from '../core/phone-error';
import { buildCommentThreads, readSocialOf, socialExcerpt, paginateFeed, FEED_PAGE_SIZE, tiebaMatchesKeyword, type TiebaPost } from '../core/social-model';
import { buildShareMessage, composeImageDesc, type SharePostSnapshot } from '../core/forward-model';
import { commentTimeText, postTimeText } from '../core/social-time';
import { currentStyle, s, socialSkinProfile, tiebaSkinProfile, type TiebaSkinProfile } from '../core/skins';
import { composeShootDesc } from '../core/chat-image-prompts';
import { readPhoneDataRef } from '../core/phone-store';
import { hostDocument } from '../core/host-env';
import { getRoster } from '../core/roster';
import { autoGenerateSocialImages, generateSocialImage, isAutoImageRunning, isSocialImageActive } from '../core/social-images';
import { emitPhoneEvent, onPhoneEvent, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openImagePickerSheet } from './image-picker-sheet';
import { openPickerSheet } from './picker-sheet';
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

type TiebaTab = 'home' | 'bars' | 'messages' | 'me';
type HomeSeg = 'follow' | 'recommend' | 'hot';

const TABS = [
  { id: 'home', label: '首页', icon: ubpIcon('home') },
  { id: 'bars', label: '进吧', icon: ubpIcon('compass') },
  { id: 'messages', label: '消息', icon: ubpIcon('message') },
  { id: 'me', label: '我的', icon: ubpIcon('user') },
];

/** Tab 标签按风格取词（进坛/进堂/进会 + 知会/名帖；现代=注册表原文）。 */
function tabLabel(id: string): string {
  if (id === 'bars') return _P?.tabEnter || '进吧';
  if (id === 'messages') return socialSkinProfile(currentStyle())?.tabMessages || '消息';
  if (id === 'me') return socialSkinProfile(currentStyle())?.tabMe || '我的';
  return '首页';
}

let _ctx: PhoneAppContext | null = null;
let _tab: TiebaTab = 'home';
let _homeSeg: HomeSeg = 'recommend';
// 帧级皮肤档案（render 开头刷新；现代=null 走现代文案——docs/15：论道坛/英雄楼/行会大厅）
let _P: TiebaSkinProfile | null = null;
let _openPostId: string | null = null;
let _openBar: string | null = null;
let _openKeyword: string | null = null; // 搜索结果页（搜索框输入关键词进入；右上 ↻=该关键词定点生成）
let _postFrom: 'home' | 'bar' = 'home';
let _meFollowsOpen = false; // 我的页「关注的吧 N」展开态（内联关注列表，无弹层）
let _busy = false;
let _error = '';
// 上次失败尝试（重试钮重放：人物选择+额外提示+定点范围；成功后随横幅消失，下次生成覆盖）
let _lastAttempt: { action: 'refresh' | 'feedback'; focusBar?: string; focusKeyword?: string; hint: string; picked: string[] } | null = null;
let _onlyLz = false;
// 信息流公共件：实现单一事实源在 social-shell.createSocialFeedKit（同名解构 → 全 App 调用点零改动）
const feedKit = createSocialFeedKit({
  container: () => _ctx?.container ?? null,
  isBusy: () => _busy,
  isFeedbackBusy: isFeedbackGenerating,
  setError: msg => { _error = msg; },
  rememberFeedbackAttempt: (hint, picked) => { _lastAttempt = { action: 'feedback', hint, picked }; },
  render: () => render(),
  onLoadMore: () => { _feedVisible += FEED_PAGE_SIZE; },
  onRefreshConfirm: (hint, picked) => { void doRefresh(_openBar || undefined, hint, picked, _openKeyword || undefined); },
});
const { toast, openRefreshHint, openFeedbackHint, doFeedback, loadMoreFeed } = feedKit;
// 信息流分页状态：首页/吧详情首屏只渲染最近 FEED_PAGE_SIZE 帖，触底/扩页递增（mount/切tab/切分段/进吧重置）
let _feedVisible = FEED_PAGE_SIZE;
let _feedHasMore = false;   // 渲染帧回写：触底监听与自动扩页共用
// 跨视图滚动记忆：首页/进吧/吧详情/帖详情各记各的（列表→帖详情→返回不会回顶，见 phone-ui createViewScrollMemo）
const _viewScroll = createViewScrollMemo();
let _pendingTop: number | null = null; // 扩页未达记忆位时的跨帧目标（递归渲染仍要落回原目标）
let _composer: {
  mode: 'thread' | 'reply';
  postId?: string;
  replyTo?: string;
  title: string;
  text: string;
  bar: string;
  imgPath: string;
  imgDesc: string;
  cameraMode: boolean;
  /** 匿名发布（true=以匿名账号发出，名称取 anonName 或默认「匿名用户」）。 */
  anon: boolean;
  anonName: string;
} | null = null;
/** 吧签到（本地趣味态：会话内记忆，刷新不丢、重启重置）。 */
const _signedBars = new Set<string>();

function currentSocial() {
  return readSocialOf(readPhoneDataRef()); // O42：只读切片，零拷贝
}

/** 社媒域快照类型（帧内传参复用时的形参类型）。 */
type SocialSnapshot = ReturnType<typeof currentSocial>;

function findPost(id: string, social: SocialSnapshot = currentSocial()): TiebaPost | null {
  return social.tieba.find(p => p.id === id) || null;
}

/** 我的吧等级 flavor（按吧名确定性散列，同吧恒同值；皮肤=境界/辈分/会阶，现代=Lv.头衔）。 */
const BAR_TITLES = ['核心会员', '本地老哥', '资深吃货', '铲屎学徒', '备考新人', '淘物达人', '灌水王者', '萌新上路'];
function barLevelLabel(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const lv = 2 + (hash % 7);
  if (_P) return _P.selfLevels[(hash >>> 3) % _P.selfLevels.length] || `道行 ${lv}`;
  return `Lv.${lv} ${BAR_TITLES[hash % BAR_TITLES.length]}`;
}

// ─── 首页列表 ───

function homePosts(followsBars: string[], all: SocialSnapshot['tieba']): TiebaPost[] {
  if (_homeSeg === 'follow') {
    const followed = new Set(followsBars);
    return all.filter(p => followed.has(p.bar));
  }
  if (_homeSeg === 'hot') {
    return [...all].sort((a, b) => b.replies - a.replies).slice(0, 12);
  }
  return all;
}

function renderPostRow(post: TiebaPost): string {
  const flags = post.pinned ? '<span class="ubp-tb-flag top">置顶</span>' : '';
  const mine = post.author === getRoster().protagonistName || post.anon ? '<i class="ubp-mo-metag">（我）</i>' : '';
  const pic = post.imageDesc
    ? `<div class="ubp-tb-pics">${renderImagePlaceholder(post.id)}</div>`
    : '';
  // 行必须是 div：内层配图占位是 button，button 嵌套 button 会被浏览器解析器拆散 DOM（内容溢出卡片）
  return `<div class="ubp-tb-post" data-ubp-act="open-post" data-id="${escapeAttr(post.id)}">
    <div><span class="ubp-tb-chip">${escapeHtml(post.bar)}</span><span class="ubp-tb-flags">${flags}</span></div>
    <div class="ubp-tb-title">${escapeHtml(post.title)}</div>
    ${post.imageDesc ? '' : `<div class="ubp-tb-excerpt">${escapeHtml(socialExcerpt(post.content))}</div>`}
    ${pic}
    <div class="ubp-tb-pmeta"><b>${post.replies}回复</b><span>·</span><span>${escapeHtml(post.author)}${mine}</span><span>·</span><span>${escapeHtml(postTimeText(post, getRoster().global.time))}</span></div>
  </div>`;
}

// ─── 进吧（吧列表 + 吧详情） ───

function renderBars(followsSet: Set<string>, social: SocialSnapshot): string {
  const bars = social.bars;
  const unit = _P?.unitNoun || '吧';
  if (!bars.length) {
    return `<div class="ubp-empty"><b>还没有已入驻的${unit}</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`;
  }
  const followed = followsSet;
  const ordered = [...bars].sort((a, b) => Number(followed.has(b.name)) - Number(followed.has(a.name)));
  return ordered.map(b => {
    const signed = _signedBars.has(b.name);
    const sign = _P?.signLabel || '签到';
    return `<div class="ubp-tb-bar" data-ubp-act="open-bar" data-id="${escapeAttr(b.name)}" style="cursor:pointer;">
      ${avatarHtml(b.name, '', true)}
      <div class="ubp-tb-barinfo">
        <div class="ubp-tb-barname">${escapeHtml(b.name)}${followed.has(b.name) ? `<span class="ubp-tb-lv">${s(currentStyle(), '已关注', '已结交')}</span>` : ''}</div>
        <div class="ubp-tb-barstat">${escapeHtml(b.members)}${_P?.memberNoun || '关注'} · ${escapeHtml(b.posts)}${_P?.postNoun || '贴子'}</div>
      </div>
      <button type="button" class="ubp-tb-signin${signed ? ' done' : ''}" data-ubp-act="signin" data-id="${escapeAttr(b.name)}" ${signed ? 'disabled' : ''}>${signed ? `已${sign}` : sign}</button>
    </div>`;
  }).join('');
}

function renderBarDetail(barName: string, followsBars: string[], social: SocialSnapshot): string {
  const bar = social.bars.find(b => b.name === barName);
  const posts = social.tieba.filter(p => p.bar === barName);
  const followed = followsBars.includes(barName);
  const signed = _signedBars.has(barName);
  const unit = _P?.unitNoun || '吧';
  const sign = _P?.signLabel || '签到';
  const signReward = _P?.signToast || '+8经验';
  const head = `<div class="ubp-tb-barhead">
    <div class="ubp-tb-barhead-row">
      ${avatarHtml(barName, '', true)}
      <div class="ubp-tb-barhead-info">
        <div class="ubp-tb-barhead-name">${escapeHtml(barName)}<span class="ubp-tb-lv">${barLevelLabel(barName)}</span></div>
        <div class="ubp-tb-barhead-stat">${escapeHtml(bar ? bar.members : '1万')}${_P?.memberNoun || '关注'} · ${escapeHtml(bar ? bar.posts : '10万')}${_P?.postNoun || '贴子'} · 本${unit}现存 ${posts.length} ${_P ? '帖' : '帖'}</div>
      </div>
      ${socialFollowBtn(followed, 'bars', barName)}
    </div>
    <div class="ubp-tb-barhead-acts">
      <button type="button" class="ubp-tb-signin${signed ? ' done' : ''}" data-ubp-act="signin" data-id="${escapeAttr(barName)}" ${signed ? 'disabled' : ''}>${signed ? `今日已${sign}` : `${sign} · ${signReward}`}</button>
      <button type="button" class="ubp-btn ubp-btn-sm" data-ubp-act="compose-thread" style="margin-left:auto;">在本${unit}发帖</button>
    </div>
  </div>`;
  const { page, hasMore, remaining } = paginateFeed(posts, _feedVisible); // 吧内也只渲染最近10帖，余下触底加载
  _feedHasMore = hasMore;
  const list = page.length
    ? page.map(renderPostRow).join('') + (hasMore ? feedMoreHtml(remaining) : '')
    : `<div class="ubp-empty"><b>「${escapeHtml(barName)}」还没有${_P?.postNoun || '帖子'}</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`;
  return head + list;
}

// ─── 搜索结果页（搜索框输入关键词进入；结果=本地已有帖前端过滤，零 AI 调用） ───

function renderKeywordResults(keyword: string, social: SocialSnapshot): string {
  const related = social.tieba.filter(p => tiebaMatchesKeyword(p, keyword));
  const { page, hasMore, remaining } = paginateFeed(related, _feedVisible); // 结果页也只渲染最近10帖
  _feedHasMore = hasMore;
  const unit = _P?.unitNoun || '吧';
  const postNoun = _P?.postNoun || '帖子';
  const bars = new Set(related.map(p => p.bar));
  const hero = `<div class="ubp-ssearch">
    <div class="ubp-ssearch-word">搜索「${escapeHtml(keyword)}」</div>
    <div class="ubp-ssearch-stat">相关${escapeHtml(postNoun)} ${related.length} 帖 · 涉及 ${bars.size} 个${escapeHtml(unit)}</div>
  </div>
  <div class="ubp-ssearch-host"><span class="ubp-ssearch-chip">关键词</span><span>${_P ? `来自已有${_P.postNoun}` : '来自已有帖子'}</span></div>`;
  const list = page.length
    ? page.map(renderPostRow).join('') + (hasMore ? feedMoreHtml(remaining) : '')
    : `<div class="ubp-empty"><b>没有搜到相关${escapeHtml(postNoun)}</b><button class="ubp-empty-btn" data-ubp-act="refresh">围绕「${escapeHtml(keyword)}」生成</button></div>`;
  return hero + list;
}

// ─── 配图（镇楼图 / 楼层图；social-images 两步法批量管线） ───

function imageStateOf(key: string): { desc: string; imagePath?: string; imageStatus?: TiebaPost['imageStatus'] } {
  if (key.startsWith('c:')) {
    const [, postId, idxRaw] = key.split(':');
    const target = findPost(postId)?.comments[Number(idxRaw)];
    return { desc: target?.imageDesc || '', imagePath: target?.imagePath, imageStatus: target?.imageStatus };
  }
  const post = findPost(key);
  return { desc: post?.imageDesc || '', imagePath: post?.imagePath, imageStatus: post?.imageStatus };
}

/** 图 key 的帖子归属（镇楼图 key=帖子 id；楼层图 key=`c:帖子:楼层`）。 */
function tiebaPostIdOf(key: string): string {
  return key.startsWith('c:') ? (key.split(':')[1] || '') : key;
}

/** 整帖成品图序列（镇楼图 + 各楼层，按显示顺序）：统一放大页的浏览序列。 */
function postImagePaths(postId: string): string[] {
  const post = findPost(postId);
  if (!post) return [];
  const paths: string[] = [];
  if (post.imagePath && post.imageStatus === 'ready') paths.push(post.imagePath);
  for (const c of post.comments) if (c.imagePath && c.imageStatus === 'ready') paths.push(c.imagePath);
  return paths;
}

function renderImagePlaceholder(key: string): string {
  const { desc, imagePath, imageStatus } = imageStateOf(key);
  if (!desc) return '';
  if (imagePath && imageStatus === 'ready') {
    // data-id=图 key、data-img=路径：点击放大时按整帖图组开灯箱
    return `<button type="button" class="ubp-mo-img" data-ubp-act="zoom" data-id="${escapeAttr(key)}" data-img="${escapeAttr(imagePath)}" title="查看大图">
      <img src="${escapeAttr(imagePath)}" alt="" loading="lazy"></button>`;
  }
  // busy=pending 且引擎确实在跑：中断残留的假 pending 回落为「未开始」可点击
  const busy = imageStatus === 'pending' && isSocialImageActive(key);
  const failed = imageStatus === 'failed';
  return `<button type="button" class="ubp-mo-imgph${failed ? ' failed' : ''}" data-ubp-act="gen-img" data-id="${escapeAttr(key)}" ${busy ? 'disabled' : ''}>
    ${busy ? '<span class="ubp-spinner"></span>' : failed ? '<span class="ubp-mo-imgph-note">⚠ 生成失败</span>' : ubpIcon('image')}
    <span class="ubp-mo-imgph-desc">${escapeHtml(desc)}</span>
    <span class="ubp-mo-imgph-hint">${busy ? '生成中…' : failed ? '点击重试' : '点击生成配图'}</span>
  </button>`;
}

// ─── 帖子详情（楼层） ───

function renderFloor(post: TiebaPost, comment: { name: string; text: string; replyTo?: string; time?: string; anon?: true }, floorNo: number, me: string, idx: number, subs = ''): string {
  const isLz = comment.name === post.author;
  const mine = comment.name === me;
  const mineTag = mine || comment.anon === true;   // 匿名楼层也标淡色「（我）」
  const reply = comment.replyTo ? `<span class="ubp-tb-quote">回复 @${escapeHtml(comment.replyTo)}：</span>` : '';
  const time = comment.time ? `<span style="color:var(--ubp-text-3);font-weight:400;">${escapeHtml(commentTimeText(comment, post, getRoster().global.time))}</span>` : '';
  const replyBtn = mine ? '' : `<button type="button" class="ubp-mo-creply" data-ubp-act="reply-c" data-id="${escapeAttr(post.id)}" data-idx="${idx}">回复</button>`;
  return `<div class="ubp-tb-floor" data-ubp-cidx="${idx}">
    ${avatarHtml(comment.name, '', true)}
    <div class="ubp-tb-fmain">
      <div class="ubp-tb-fname">${escapeHtml(comment.name)}${mineTag ? '<i class="ubp-mo-metag">（我）</i>' : ''}${isLz ? '<span class="ubp-tb-lz">楼主</span>' : ''}${time}${replyBtn}<span class="ubp-tb-fno">${floorNo}楼</span></div>
      <div class="ubp-tb-fbody">${reply}${escapeHtml(comment.text)}</div>
      ${renderImagePlaceholder(`c:${post.id}:${idx}`)}
      ${subs}
    </div>
  </div>`;
}

function renderThread(post: TiebaPost): string {
  const me = getRoster().protagonistName;
  const mine = post.author === me;
  const threads = buildCommentThreads(post.comments);
  const idxOf = new Map(post.comments.map((c, i) => [c, i]));
  const floors = threads
    .filter(t => !_onlyLz || t.comment.name === post.author)
    .map(t => {
      const ci = idxOf.get(t.comment)!;
      // 只看楼主：楼层与楼中楼都只保留楼主发言（楼中楼扁平化后为全部子孙）
      const subs = _onlyLz ? t.replies.filter(r => r.name === post.author) : t.replies;
      return renderFloor(post, t.comment, ci + 2, me, ci, renderSubReplies({
        kind: 'tieba',
        threadKey: `tieba:${post.id}:${ci}`,
        postId: post.id,
        rootName: t.comment.name,
        subs: subs.map(r => ({ idx: idxOf.get(r)!, name: r.name, text: r.text, replyTo: r.replyTo, mine: r.anon === true || r.name === me })),
      }));
    }).join('');
  return `<div class="ubp-tb-thread-head">
    <div class="ubp-tb-thread-bar"><span>全楼 ${post.replies} 回复 · ${post.views} 浏览</span><button type="button" class="ubp-tb-onlylz${_onlyLz ? ' on' : ''}" data-ubp-act="onlylz">${_onlyLz ? '√ ' : ''}只看楼主</button></div>
    <div class="ubp-tb-thread-title">${escapeHtml(post.title)}</div>
  </div>
  <div class="ubp-tb-floor" data-ubp-lp-post="${escapeAttr(post.id)}">
    ${avatarHtml(post.author, '', true)}
    <div class="ubp-tb-fmain">
      <div class="ubp-tb-fname">${escapeHtml(post.author)}${mine ? '<i class="ubp-mo-metag">（我）</i>' : ''}<span class="ubp-tb-lz">楼主</span>${post.authorTitle ? `<span class="ubp-tb-lv">${escapeHtml(post.authorTitle)}</span>` : ''}<span class="ubp-tb-fno">1楼</span></div>
      <div class="ubp-tb-fbody">${escapeHtml(post.content)}</div>
      ${renderImagePlaceholder(post.id)}
    </div>
  </div>
  ${floors || (_onlyLz ? '<div class="ubp-empty">楼主还没有回复楼层</div>' : '<div class="ubp-empty">还没有人回帖，抢个沙发？</div>')}
  <div class="ubp-replybar">
    <button type="button" class="ubp-xhs-aact${post.likedByMe ? ' on' : ''}" data-ubp-act="like" data-id="${escapeAttr(post.id)}" title="点赞">${actIcon(post.likedByMe === true, 'like')}${post.likes}</button>
    <button type="button" class="ubp-xhs-aact" data-ubp-act="share" data-id="${escapeAttr(post.id)}" title="分享到聊天">${ubpIcon('share')}${s(currentStyle(), '分享', '转寄', '转寄', '转递')}</button>
    <button type="button" class="input" data-ubp-act="comment" data-id="${escapeAttr(post.id)}" style="border:none;cursor:pointer;text-align:left;font-family:var(--ubp-font);">${_P?.replyLead || '真诚发帖，礼貌回帖…'}</button>
    <button type="button" class="go" data-ubp-act="comment" data-id="${escapeAttr(post.id)}">${_P?.replyAct || '回帖'}</button>
  </div>`;
}

// ─── 分享到聊天（统一转发模块：forward-model 转换 + forward-sheet 目标弹层） ───

/** 帖子 → 分享快照（标题+主楼+镇楼图+楼层；成品图引用 imagePath；楼中楼压回复前缀）。 */
function tiebaShareSnapshot(post: TiebaPost): SharePostSnapshot {
  return {
    app: 'tieba',
    author: post.author,
    title: post.title,
    text: post.content,
    images: post.imageDesc
      ? [{ desc: post.imageDesc, ...(post.imagePath && post.imageStatus === 'ready' ? { imagePath: post.imagePath } : {}) }]
      : [],
    comments: post.comments.map(c => ({
      name: c.name,
      text: c.text,
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
      ...(c.imageDesc?.trim()
        ? { image: { desc: c.imageDesc, ...(c.imagePath && c.imageStatus === 'ready' ? { imagePath: c.imagePath } : {}) } }
        : {}),
    })),
  };
}

/** 分享到聊天：帖子转「聊天记录」消息 → 弹目标选择 → 落库（整条算一条消息，上屏不触发 AI）。 */
function sharePostToChat(post: TiebaPost): void {
  if (!_ctx) return;
  const message = buildShareMessage(tiebaShareSnapshot(post), getRoster().global.time);
  if (!message) return;
  openForwardTargetSheet(_ctx, pick => {
    if (appendForwardedMessage(pick, message)) {
      // L9 成就：玩家亲手把帖子分享到聊天成功
      emitAch('phone_share_to_chat', { platform: 'tieba' });
      toast('已分享到聊天');
    }
  });
}

// ─── 长按操作面板（帖子=分享/删除；评论/回复=删除，连带楼中楼子回复） ───

function deletePostAndRender(postId: string): void {
  try {
    deleteUserPost('tieba', postId);
    // L9 成就：玩家亲手删除帖子成功（失败分支不打点）
    emitAch('phone_post_deleted', { platform: 'tieba' });
    if (_openPostId === postId) _openPostId = null;
    emitPhoneEvent('ubp-phone:data-changed');
    toast('已删除');
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
  render();
}

function openPostActionSheet(postId: string): void {
  if (!_ctx) return;
  const post = findPost(postId);
  if (!post) return;
  openActionSheet(_ctx.container, {
    title: post.title,
    items: [
      { act: 'share', label: '分享到聊天' },
      { act: 'del', label: '删除帖子', danger: true },
    ],
    onPick: act => {
      if (act === 'share') {
        const cur = findPost(postId);
        if (cur) sharePostToChat(cur);
        return;
      }
      if (act === 'del') deletePostAndRender(postId);
    },
  });
}

function openCommentDeleteSheet(postId: string, idx: number): void {
  if (!_ctx) return;
  const target = findPost(postId)?.comments[idx];
  if (!target) return;
  openActionSheet(_ctx.container, {
    title: `删除 ${target.name} 的这条${target.replyTo ? '回复' : '评论'}？`,
    body: '其楼中楼的子回复将一并删除，删除后不可恢复。',
    items: [{ act: 'del', label: '删除', danger: true }],
    onPick: act => {
      if (act !== 'del') return;
      try {
        deleteSocialComment('tieba', postId, idx);
        emitPhoneEvent('ubp-phone:data-changed');
        toast('已删除');
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      render();
    },
  });
}

// ─── 手动添加贴吧（进吧页 + 号）与长按删吧 ───

function openAddBarSheet(): void {
  if (!_ctx) return;
  const doc = hostDocument();
  doc.querySelector('.ubp-tb-addbar')?.remove();
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-tb-addbar';
  overlay.innerHTML = `
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">${escapeHtml(_P?.addUnit || '添加贴吧')}</div>
      <input class="ubp-fieldinput" id="ubp-tb-addbar-name" maxlength="24" placeholder="输入${_P?.unitNoun || '吧'}名，如：临江大学吧" autocomplete="off">
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-addbar="cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-addbar="ok">添加并生成</button>
      </div>
    </div>`;
  _ctx.container.appendChild(overlay);
  const input = overlay.querySelector('#ubp-tb-addbar-name') as HTMLInputElement;
  const close = (): void => overlay.remove();
  overlay.addEventListener('click', (e: Event) => {
    const el = (e.target as HTMLElement).closest('[data-ubp-addbar]') as HTMLElement | null;
    if (!el) {
      if (!(e.target as HTMLElement).closest('.ubp-sheet')) close(); // 点背景关闭
      return;
    }
    if (el.dataset.ubpAddbar === 'cancel') { close(); return; }
    const name = input.value.trim();
    if (!name) { toast(`先输入${_P?.unitNoun || '吧'}名`); return; }
    if (!addTiebaBar(name)) { toast(`该${_P?.unitNoun || '吧'}已在列表里`); return; }
    close();
    emitPhoneEvent('ubp-phone:data-changed');
    _openBar = name; // 添加后直接进吧详情
    _openPostId = null;
    _feedVisible = FEED_PAGE_SIZE;
    render();
    void doRefresh(name); // 并直接进行一次该吧内容生成
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') (overlay.querySelector('[data-ubp-addbar="ok"]') as HTMLElement).click();
  });
}

function openBarActionSheet(barName: string): void {
  if (!_ctx || !barName) return;
  const followed = readSocialFollows().bars.includes(barName);
  const unit = _P?.unitNoun || '吧';
  openActionSheet(_ctx.container, {
    title: barName,
    body: `删除该${unit}将连带删除${unit}内全部${_P?.postNoun || '帖子'}${followed ? `，并取消${s(currentStyle(), '关注', '结交')}` : ''}，删除后不可恢复。`,
    items: [{ act: 'del', label: `删除${unit}`, danger: true }],
    onPick: act => {
      if (act !== 'del') return;
      deleteTiebaBar(barName);
      if (_openBar === barName) _openBar = null;
      _signedBars.delete(barName);
      emitPhoneEvent('ubp-phone:data-changed');
      toast('已删除');
      render();
    },
  });
}

// ─── 编辑面板（发帖 / 回帖，统一 composer 状态机） ───

function renderComposer(): string {
  if (!_composer) return '';
  const c = _composer;
  const unit = _P?.unitNoun || '吧';
  const title = c.mode === 'thread' ? '发帖' : c.replyTo ? `回复 ${c.replyTo}` : (_P?.replyAct || '回帖');
  const attach = c.mode !== 'thread' ? '' : c.imgPath
    ? `<div class="ubp-mo-attach"><span class="ubp-mo-attachchip">${ubpIcon('image')}${escapeHtml(c.imgDesc || '已选图片')}<button type="button" class="ubp-mo-attachx" data-ubp-act="compose-detach">×</button></span></div>`
    : c.cameraMode
      ? `<textarea class="ubp-textarea" data-ubp-input="compose-imgdesc" rows="2" placeholder="照片内容描述（发布后按描述生成图片）">${escapeHtml(c.imgDesc)}</textarea>
         <div class="ubp-mo-attachrow"><button type="button" class="ubp-btn" data-ubp-act="compose-attach-album">改从相册选择</button><button type="button" class="ubp-btn" data-ubp-act="compose-detach">取消附图</button></div>`
      : `<div class="ubp-mo-attachrow"><button type="button" class="ubp-btn" data-ubp-act="compose-attach-camera">${ubpIcon('camera')}拍照描述生图</button><button type="button" class="ubp-btn" data-ubp-act="compose-attach-album">${ubpIcon('album')}从相册选择</button></div>`;
  const sendable = c.text.trim() && (c.mode === 'reply' || (c.title.trim() && (!c.cameraMode || c.imgDesc.trim() || c.imgPath)));
  const barBtn = c.mode !== 'thread' ? '' : `<button type="button" class="ubp-btn" data-ubp-act="compose-bar" style="width:100%;justify-content:flex-start;margin-bottom:8px;">${ubpIcon('tieba')}发到：${escapeHtml(c.bar || `点选一个${unit}`)}</button>`;
  return `<div class="ubp-overlay ubp-mo-composer">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">${escapeHtml(title)}</div>
      ${c.mode === 'thread' ? `<input class="ubp-fieldinput" data-ubp-input="compose-title" maxlength="60" placeholder="标题（例：【求助】有人知道吗）" value="${escapeAttr(c.title)}">` : ''}
      <textarea class="ubp-textarea" data-ubp-input="compose-text" rows="4" placeholder="${c.mode === 'thread' ? '正文…' : c.replyTo ? `回复 ${escapeHtml(c.replyTo)}…` : (_P?.replyLead || '说点什么…')}">${escapeHtml(c.text)}</textarea>
      ${anonRowHtml(c.anon, c.anonName)}
      ${barBtn}
      ${attach}
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="compose-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="compose-send" ${sendable ? '' : 'disabled'}>${c.mode === 'thread' ? '发布' : '回复'}</button>
      </div>
    </div>
  </div>`;
}

function openThreadComposer(): void {
  const bars = currentSocial().bars;
  _composer = { mode: 'thread', title: '', text: '', bar: _openBar || bars[0]?.name || (_P?.unitNoun === '坛' ? '灌水坛' : _P?.unitNoun === '堂' ? '灌水堂' : '灌水吧'), imgPath: '', imgDesc: '', cameraMode: false, anon: false, anonName: '' };
  render();
}

function openReplyComposer(postId: string, replyTo?: string): void {
  _composer = { mode: 'reply', postId, replyTo, title: '', text: '', bar: '', imgPath: '', imgDesc: '', cameraMode: false, anon: false, anonName: '' };
  render();
}

function openBarPicker(): void {
  if (!_ctx || !_composer) return;
  const bars = currentSocial().bars;
  openPickerSheet(_ctx.container, {
    title: `选择${_P?.unitNoun || '吧'}`,
    groups: [{
      key: 'bars',
      label: `已生成的${_P?.unitNoun || '吧'}`,
      items: bars.map(b => ({ id: b.name, label: b.name, sub: `${b.members}${_P?.memberNoun || '关注'}` })),
    }],
    emptyText: `还没有${_P?.unitNoun || '吧'}——先刷新生成${_P?.unitNoun || '吧'}列表`,
    onPick: id => {
      if (!id || !_composer) return;
      _composer.bar = id;
      render();
    },
  });
}

function openAlbumPicker(): void {
  if (!_ctx || !_composer) return;
  openImagePickerSheet(_ctx.container, {
    mode: 'context',
    title: '从相册选择',
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

async function sendComposer(): Promise<void> {
  if (!_composer) return;
  const c = _composer;
  const text = c.text.trim();
  if (!text) return;
  if (c.mode === 'thread') {
    if (!c.title.trim()) return;
    const { postId } = createUserPost({
      kind: 'tieba',
      text,
      title: c.title.trim(),
      bar: c.bar,
      ...(c.anon ? { anon: true, anonName: c.anonName } : {}),
      ...(c.imgPath ? { imagePath: c.imgPath } : {}),
      imageDesc: c.imgPath ? c.imgDesc : c.cameraMode ? composeShootDesc(c.imgDesc, getRoster()) : '',
    });
    _composer = null;
    _openPostId = postId;
    render();
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：玩家亲手发帖成功（附图意图即算 hasImage；匿名按开关）
    emitAch('phone_post_published', {
      platform: 'tieba',
      hasImage: achFlag(!!c.imgPath || (c.cameraMode && c.imgDesc.trim())),
      anon: achFlag(c.anon),
      isRepost: 0,
    });
    emitActionOnDate('phone_post');
    toast(c.anon ? '已匿名发布' : '已发布');
    if (c.cameraMode && c.imgDesc.trim()) {
      try { await generateSocialImage('tieba', postId); } catch (_e) { /* 占位已落 failed */ }
      if (_ctx) render();
    }
    return;
  }
  if (!c.postId) return;
  addSocialComment({ kind: 'tieba', postId: c.postId, text, ...(c.replyTo ? { replyTo: c.replyTo } : {}), ...(c.anon ? { anon: true, anonName: c.anonName } : {}) });
  _composer = null;
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手回帖/楼中楼成功
  emitAch('phone_comment_posted', { platform: 'tieba', isReply: achFlag(!!c.replyTo) });
}

// ─── 刷新与求回应 ───

async function doRefresh(focusBar?: string, hint?: string, picked?: string[], focusKeyword?: string): Promise<void> {
  if (_busy) return;
  _busy = true;
  _lastAttempt = { action: 'refresh', focusBar, ...(focusKeyword ? { focusKeyword } : {}), hint: hint || '', picked: picked || [] };
  _error = '';
  render();
  try {
    const focus = focusBar ? { bar: focusBar } : focusKeyword ? { keyword: focusKeyword } : undefined;
    await refreshSocialSnapshot({ kind: 'tieba', ...(focus ? { focus } : {}), ...(hint ? { extraHint: hint } : {}) , ...(picked && picked.length ? { focusNames: picked } : {}) });
    emitPhoneEvent('ubp-phone:data-changed');
    if (_openPostId && !findPost(_openPostId)) _openPostId = null;
    toast(focusBar ? `「${focusBar}」已收录新帖` : focusKeyword ? `「${focusKeyword}」已收录相关帖` : (_P?.refreshToast || '贴吧已刷新'));
  } catch (e) {
    _error = isPhoneAbortError(e) ? '' : (e instanceof Error ? e.message : String(e));
  } finally {
    _busy = false;
    render();
    void autoGenerateSocialImages('tieba').then(() => { if (_ctx) render(); });
  }
}

// ─── 主渲染 ───

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const prevBody = container.querySelector<HTMLElement>('.ubp-appbody');
  const prevScrollTop = prevBody?.scrollTop ?? 0;
  _feedHasMore = false; // 详情/消息/我的/进吧列表不分页，只有首页与吧详情是信息流

  const social = currentSocial(); // 帧级一次（本帧各处共用，禁重复深拷贝；对齐 readSocialFollows 纪律）
  const follows = readSocialFollows(); // 帧级一次（禁渲染循环重复深拷贝）
  const followsBars = follows.bars;
  _P = tiebaSkinProfile(currentStyle()); // 帧级皮肤档案（论道坛/英雄楼/行会大厅；现代=null）
  const unit = _P?.unitNoun || '吧';
  const pendingActions = getPendingActions(social); // 用本帧 social 快照（帧级一次，免二次全量深拷贝）
  const pendingCount = pendingActions.length;
  const msgUnread = getSocialNotificationUnread('tieba'); // 零拷贝 ref 读（徽标热路径纪律）
  const fbBusy = isFeedbackGenerating();
  const autoBusy = isAutoImageRunning('tieba');
  const busyHtml = `
    ${_error ? `<div class="ubp-mo-error">${escapeHtml(_error)}<button class="ubp-mo-retry" data-ubp-act="retry-gen">重试</button></div>` : ''}
    ${_busy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>${escapeHtml(_P?.refreshingText || '正在刷新贴吧…')}<button class="ubp-btn" data-ubp-act="abort">终止</button></div>` : ''}
    ${fbBusy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>正在生成互动回应…<button class="ubp-btn" data-ubp-act="abort">终止</button></div>` : ''}
    ${autoBusy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>正在批量生成配图…</div>` : ''}`;

  const openPost = _openPostId ? findPost(_openPostId, social) : null;
  // 滚动记忆视图键：帖/吧/搜索页各自独立，列表按 tab+分段分记（键变=换视图，进详情从顶部开始）
  const viewKey = openPost ? `post:${openPost.id}`
    : _openBar ? `bar:${_openBar}`
    : _openKeyword ? `kw:${_openKeyword}`
    : `${_tab}:${_homeSeg}`;
  let appClass = 'ubp-tb';
  let topHtml = '';
  let bodyInner = '';
  let showTabbar = true;
  let activeTab = _tab;

  if (openPost) {
    // 帖子楼层详情：导航（返回来源页 + 点吧名进吧 + 求回应）+ 楼层 + 底部回帖栏
    showTabbar = false;
    appClass = 'ubp-tb ubp-tb-detail';
    topHtml = socialDetailNav({
      backAct: _postFrom === 'bar' && _openBar ? 'back-bar' : 'back-list',
      title: openPost.bar,
      titleAct: { act: 'open-bar', id: openPost.bar },
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }),
    });
    bodyInner = busyHtml + renderThread(openPost);
  } else if (_openBar) {
    // 吧详情：导航（返回进吧 + 吧名 + 求回应/吧内刷新）+ 吧头部 + 该吧帖子
    showTabbar = false;
    activeTab = 'bars';
    topHtml = socialDetailNav({
      backAct: 'back-bars',
      title: _openBar,
      sub: `${unit}内刷新只出新帖`,
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy, refreshTitle: `${unit}内刷新（只生成「${_openBar}」的新帖）` }),
    });
    bodyInner = busyHtml + renderBarDetail(_openBar, followsBars, social);
  } else if (_openKeyword) {
    // 搜索结果页：导航（返回 + 关键词 + 求回应/关键词定点生成）+ 搜索 hero + 跨吧相关帖
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'back-search',
      title: `搜索：${_openKeyword}`,
      sub: `刷新只出该关键词相关${_P?.postNoun || '帖子'}`,
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy, refreshTitle: `关键词刷新（围绕「${_openKeyword}」生成新${_P?.postNoun || '帖子'}）` }),
    });
    bodyInner = busyHtml + renderKeywordResults(_openKeyword, social);
  } else if (_tab === 'bars') {
    topHtml = socialDetailNav({
      backAct: 'exit',
      title: _P?.tabEnter || '进吧',
      sub: `已入驻 ${social.bars.length} 个${unit}`,
      // ＋=手动添加贴吧（添加后进吧详情并直接生成该吧新帖）
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }) + `<button class="ubp-iconbtn" data-ubp-act="add-bar" title="${escapeAttr(_P?.addUnit || '添加贴吧')}" ${_busy ? 'disabled' : ''}>${ubpIcon('plus')}</button>`,
    });
    bodyInner = busyHtml + renderBars(new Set(followsBars), social);
  } else if (_tab === 'messages') {
    topHtml = socialDetailNav({ backAct: 'exit', title: socialSkinProfile(currentStyle())?.tabMessages || '消息', actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }) });
    bodyInner = busyHtml + renderSocialMessages('tieba', pendingActions, social);
  } else if (_tab === 'me') {
    topHtml = socialDetailNav({ backAct: 'exit', title: `我的${_P?.appName || '贴吧'}`, actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }) });
    bodyInner = busyHtml + renderSocialMe('tieba', follows, _meFollowsOpen, social);
  } else {
    // 首页：品牌渐变顶栏 + 关注/推荐/热议分段（皮肤=结缘/荐阅/争鸣 + 坛印品牌行）
    const hint = social.tieba.find(p => !p.pinned)?.title || (_P ? '今日热议' : '搜你感兴趣的吧');
    topHtml = `<div class="ubp-stop">
      <div class="ubp-stop-row">
        <span class="ubp-stop-logo">${escapeHtml(_P?.appName || '贴吧')}</span>
        <button type="button" class="ubp-stop-search" data-ubp-act="search" title="搜索${unit}内帖子">${ubpIcon('search')}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(_P?.searchLead || '大家都在搜：')}${escapeHtml(hint)}</span></button>
        <div class="ubp-stop-acts">
          <button class="ubp-iconbtn ubp-sbell${pendingCount ? ' has' : ''}" data-ubp-act="nav" data-id="messages" title="消息（待回应互动）">${ubpIcon('bell')}</button>
          ${pendingCount ? `<button class="ubp-iconbtn ubp-fbbadge" data-ubp-act="feedback" title="求回应" ${fbBusy || _busy ? 'disabled' : ''}>${ubpIcon('comment')}<i>${pendingCount}</i></button>` : ''}
          <button class="ubp-iconbtn" data-ubp-act="refresh" title="刷新" ${_busy ? 'disabled' : ''}>
            <span class="${_busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span>
          </button>
        </div>
      </div>
      <div class="ubp-sseg">${socialSeg([
        { id: 'follow', label: _P?.segFollow || '关注' },
        { id: 'recommend', label: _P?.segRec || '推荐' },
        { id: 'hot', label: _P?.segHot || '热议' },
      ], _homeSeg)}</div>
    </div>`;
    const feed = homePosts(followsBars, social.tieba);
    const { page, hasMore, remaining } = paginateFeed(feed, _feedVisible); // 只渲染最近10帖，余下触底加载
    _feedHasMore = hasMore;
    bodyInner = busyHtml + (page.map(renderPostRow).join('')
      || `<div class="ubp-empty"><b>${_homeSeg === 'follow' ? `${s(currentStyle(), '关注的', '已结交的')}${unit}还没有${_P?.postNoun || '帖子'}` : `${_P?.appName || '贴吧'}还没有${_P?.postNoun || '帖子'}`}</b>${_homeSeg === 'follow' ? '' : '<button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button>'}</div>`)
      + (hasMore ? feedMoreHtml(remaining) : '');
  }

  container.innerHTML = renderSocialShell({
    appClass,
    topHtml,
    bodyInner: `${bodyInner}<div style="height:${showTabbar ? 12 : 20}px;"></div>`,
    tabs: TABS.map(t => ({ ...t, label: tabLabel(t.id), ...(t.id === 'messages' ? { badge: msgUnread } : {}) })),
    activeTab,
    composeAct: 'compose-thread',
    showTabbar,
    extraHtml: `
      ${renderComposer()}`,
  });
  const body = container.querySelector<HTMLElement>('.ubp-appbody');
  if (body) {
    // 跨视图保位：进帖/进吧/搜索页首次进入从顶部开始，返回列表回到离开时读到的位置（同视图重绘=原位）
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

function handleClick(event: Event): void {
  if (longPressJustFired()) return; // 长按分享刚触发：吞掉残留 click（防误开帖子）
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const id = el.dataset.id || '';
  switch (act) {
    case 'exit': _ctx?.closeApp(); break;
    case 'back-list': _openPostId = null; _onlyLz = false; render(); break;
    case 'back-search': _openKeyword = null; render(); break; // 搜索页返回（帖子详情返回走 back-list，保留搜索态）
    case 'back-bar': _openPostId = null; _onlyLz = false; render(); break;
    case 'back-bars': _openBar = null; render(); break;
    // 搜索：输入关键词 → 进搜索结果页（跨吧相关帖）并围绕该关键词定向生成一次
    case 'search': {
      if (!_ctx) break;
      const hint = currentSocial().tieba.find(p => !p.pinned)?.title || '';
      openSearchSheet(_ctx.container, {
        title: `搜索${_P?.unitNoun || '吧'}内帖子`,
        placeholder: `输入关键词，如：${hint || '临江暴雨'}`,
        onSubmit: kw => {
          // L9 成就：玩家亲手提交搜索（贴吧域；AI 刷新结果与成败无关）
          emitAch('phone_search_performed', { scope: 'tieba' });
          _openKeyword = kw;
          _openPostId = null;
          _openBar = null;
          _feedVisible = FEED_PAGE_SIZE;
          render();
          void doRefresh(undefined, undefined, undefined, kw);
        },
      });
      break;
    }
    case 'nav': {
      const next = (TABS.find(t => t.id === id)?.id || 'home') as TiebaTab;
      if (next !== _tab || _openBar || _openKeyword) {
        _tab = next;
        _openBar = null;
        _openKeyword = null;
        _openPostId = null;
        _feedVisible = FEED_PAGE_SIZE; // 换信息流：分页重置
        render();
      }
      break;
    }
    case 'seg': {
      const next = id === 'follow' || id === 'hot' ? id : 'recommend';
      if (next !== _homeSeg) {
        _homeSeg = next;
        _feedVisible = FEED_PAGE_SIZE; // 换分段：分页重置
        render();
      }
      break;
    }
    case 'refresh': void doRefresh(_openBar || undefined, undefined, undefined, _openKeyword || undefined); break;
    case 'abort': abortSocialGeneration(); break;
    case 'feedback': void doFeedback(); break;
    case 'retry-gen': {
      if (!_lastAttempt) break;
      if (_lastAttempt.action === 'refresh') void doRefresh(_lastAttempt.focusBar, _lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined, _lastAttempt.focusKeyword);
      else void doFeedback(_lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined);
      break;
    }
    case 'open-post': _openPostId = id; _postFrom = _openBar ? 'bar' : 'home'; _onlyLz = false; resetSubThreads(); readPost('tieba', id); render(); break;
    case 'open-bar': _openBar = id; _openKeyword = null; _openPostId = null; _feedVisible = FEED_PAGE_SIZE; render(); break;
    case 'add-bar': openAddBarSheet(); break;
    case 'open-follow': _openBar = id; _openKeyword = null; _openPostId = null; render(); break; // 关注列表行=进吧详情
    case 'my-follows': _meFollowsOpen = !_meFollowsOpen; render(); break;
    case 'sub-open': toggleSubThread(id); render(); break;
    case 'open-notify': {
      const postId = readNotification('tieba', id);
      if (postId) {
        if (findPost(postId)) { _openPostId = postId; _postFrom = 'home'; _onlyLz = false; }
        else toast('内容已删除');
      }
      render();
      break;
    }
    case 'mark-all-read': readAllNotifications('tieba'); render(); break;
    case 'signin': {
      if (_signedBars.has(id)) break;
      _signedBars.add(id);
      // L9 成就：玩家亲手签到成功（会话内同日重复点已被 _signedBars 挡住）
      emitAch('phone_signin', {});
      toast(`签到成功，${_P?.signToast || '经验 +8'} 🎉`);
      render(); // 会话内本地态（不落库）：必须自渲——壳层 toast 不再顺带整帧重渲（IA-05），也不派发 data-changed（无数据变更，免壳层白算角标/通知）
      break;
    }
    case 'follow': {
      const scope = el.dataset.scope as 'bars' | 'weibo' | 'xhs';
      const { followed } = toggleFollow(scope || 'bars', id);
      // L9 成就：关注/取关都发（成就侧只匹配 on:1）；platform 固定 tieba，不用 dataset.scope（其值是 bars）
      emitAch('phone_follow_changed', { platform: 'tieba', on: achFlag(followed) });
      emitPhoneEvent('ubp-phone:data-changed');
      toast(followed ? `${s(currentStyle(), '已关注', '已结交')}「${id}」` : `${s(currentStyle(), '已取消关注', '已解除结交')}「${id}」`);
      break;
    }
    case 'del-post': {
      if (_ctx) openConfirmSheet(_ctx.container, {
        title: '删除这条帖子？',
        message: '删除后无法恢复。',
        confirmLabel: '删除',
        onConfirm: () => {
          try {
            deleteUserPost('tieba', id);
            // L9 成就：长按菜单删除成功
            emitAch('phone_post_deleted', { platform: 'tieba' });
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
    case 'onlylz': _onlyLz = !_onlyLz; render(); break;
    case 'like': {
      // L9 成就：点赞（取消赞不计）
      if (toggleLike('tieba', id).liked) emitAch('phone_like_given', { platform: 'tieba' });
      emitPhoneEvent('ubp-phone:data-changed');
      render();
      pulseActIcon(_ctx?.container ?? null, 'like', id); // 点亮脉冲：必须在重绘之后挂（重绘会丢类）
      break;
    }
    case 'comment': openReplyComposer(id); break;
    case 'share': {
      const post = findPost(id);
      if (post) sharePostToChat(post);
      break;
    }
    case 'reply-c': {
      const idx = Number(el.dataset.idx || '-1');
      const post = findPost(id);
      const target = post?.comments[idx];
      if (target) openReplyComposer(id, target.name);
      break;
    }
    case 'compose-thread': openThreadComposer(); break;
    case 'compose-bar': openBarPicker(); break;
    case 'compose-cancel': _composer = null; render(); break;
    case 'compose-anon':
      if (_composer) { _composer.anon = !_composer.anon; render(); }
      break;
    case 'compose-attach-camera':
      if (_composer) { _composer.cameraMode = true; _composer.imgPath = ''; render(); }
      break;
    case 'compose-attach-album': openAlbumPicker(); break;
    case 'compose-detach':
      if (_composer) { _composer.imgPath = ''; _composer.imgDesc = ''; _composer.cameraMode = false; render(); }
      break;
    case 'compose-send': void sendComposer(); break;
    case 'gen-img':
      void generateSocialImage('tieba', id)
        .then(() => { emitPhoneEvent('ubp-phone:data-changed'); })
        .catch(e => toast(e instanceof Error ? e.message : String(e)))
        .finally(() => { if (_ctx) render(); });
      break;
    case 'zoom': {
      // 整帖图组（镇楼图 + 各楼层成品图，按显示顺序）进统一放大页：左右可滑，重绘于当前那张
      const path = el.dataset.img || '';
      const seq = postImagePaths(tiebaPostIdOf(id));
      const paths = seq.length ? seq : [path];
      openPhoneLightbox(_ctx?.container, { paths, startIndex: Math.max(0, paths.indexOf(path)) });
      break;
    }
    default: break;
  }
}

function handleInput(event: Event): void {
  const el = event.target as HTMLElement;
  const field = el.dataset?.ubpInput;
  if (!field || !_composer) return;
  const value = (el as HTMLTextAreaElement | HTMLInputElement).value;
  if (field === 'compose-text') _composer.text = value;
  else if (field === 'compose-title') _composer.title = value;
  else if (field === 'compose-imgdesc') _composer.imgDesc = value;
  else if (field === 'compose-anonname') _composer.anonName = value;
  // 交互态原地更新（渲染纪律）：发送按钮解禁不整帧重绘
  const c = _composer;
  const sendable = Boolean(c.text.trim()) && (c.mode === 'reply' || (Boolean(c.title.trim()) && (!c.cameraMode || Boolean(c.imgDesc.trim()) || Boolean(c.imgPath))));
  const btn = _ctx?.container.querySelector('[data-ubp-act="compose-send"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = !sendable;
}

export const tiebaApp: PhoneApp = {
  id: 'tieba',
  name: '贴吧',
  icon: ubpIcon('tieba'),
  color: '#4E6EF2',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _error = '';
    _openPostId = takePendingAppTarget('tieba'); // 全局搜索 / 锁屏通知深链：直接落在该帖详情（目标不存在时渲染回落列表）
    if (_openPostId) readPost('tieba', _openPostId); // 深链=看过该帖：只清这一帖的通知未读
    _openBar = null;
    _openKeyword = null;
    _meFollowsOpen = false;
    _composer = null;
    _onlyLz = false;
    _feedVisible = FEED_PAGE_SIZE; // 分页重置：首屏只渲染最近10帖
    _viewScroll.clear(); // 滚动记忆重置：重开 App 从顶开始，不继承上一次打开时的位置
    _pendingTop = null;
    // 未读逐条已读：打开 App 不清角标，消息页点开该条（或全部已读）才清——与其他 App 的未读口径一致
    ctx.container.addEventListener('click', handleClick);
    // 长按「刷新/求回应」=一次性提示
    const unbindHintLongPress = bindHintLongPress(ctx.container, target => {
      if (target.closest('[data-ubp-act="refresh"]')) return { el: target.closest('[data-ubp-act="refresh"]') as HTMLElement, fire: openRefreshHint };
      if (target.closest('[data-ubp-act="feedback"]')) return { el: target.closest('[data-ubp-act="feedback"]') as HTMLElement, fire: openFeedbackHint };
      return null;
    });
    ctx.container.addEventListener('input', handleInput);
    const unbindFeedScroll = bindFeedScroll(ctx.container, () => _feedHasMore, loadMoreFeed);
    // 长按委托：帖子行/主楼=操作面板（分享/删除），楼层评论=删除面板，进吧行=删吧面板
    const unbindLongPress = bindLongPress(
      ctx.container,
      t => {
        if (t.closest('[data-ubp-act="signin"]')) return null; // 签到钮不触发删吧面板
        return t.closest('[data-ubp-cidx]') || t.closest('.ubp-tb-post[data-ubp-act="open-post"], .ubp-tb-floor[data-ubp-lp-post]') || t.closest('.ubp-tb-bar[data-ubp-act="open-bar"]');
      },
      el => {
        const cidx = el.dataset.ubpCidx;
        if (cidx !== undefined && _openPostId) openCommentDeleteSheet(_openPostId, Number(cidx));
        else if (el.classList.contains('ubp-tb-bar')) openBarActionSheet(el.dataset.id || '');
        else openPostActionSheet(el.dataset.ubpLpPost || el.dataset.id || '');
      },
    );
    render();
    void autoGenerateSocialImages('tieba').then(() => { if (_ctx) render(); });
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
