// ===== 微博 App：时间线 + 热搜广场（红橙主题；风格对照 docs/social-three-apps-mockup.html） =====
// 骨架：品牌顶栏（logo+搜索胶囊+铃铛）+ 关注/推荐/热搜分段 + 底部 Tab（首页/＋/消息/我）。
// 层级：首页（关注=已关注博主 / 推荐=全部 / 热搜=榜单）→ 话题页（hero+置顶卡+相关博文，支持话题定点刷新）
// → 博文详情（评论楼中楼+底部评论栏）。
// 刷新语义：首页刷新=整版快照（信息流+热搜）；话题页刷新=focus.topic 只出该话题相关博文（不重写热搜榜）；
// 顶栏「求回应」=互动反馈。
// 互动层：点赞/评论/回复/转发（本地即时生效，记入待反馈清单）+ 发微博 + 关注博主（本地，零 AI）+ 我的页删博文。

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
  setSocialAuthorCover,
  toggleFollow,
  toggleLike,
} from '../core/social-engine';
import { isPhoneAbortError } from '../core/phone-error';
import { buildCommentThreads, readSocialOf, socialExcerpt, weiboMatchesTopic, paginateFeed, FEED_PAGE_SIZE, type SocialAuthorProfile, type WeiboPost } from '../core/social-model';
import { buildShareMessage, composeImageDesc, type SharePostSnapshot } from '../core/forward-model';
import { commentTimeText, postTimeText } from '../core/social-time';
import { composeShootDesc } from '../core/chat-image-prompts';
import { readPhoneDataRef } from '../core/phone-store';
import { S, currentStyle, socialSkinProfile } from '../core/skins';
import { bindHintLongPress } from './hint-sheet';
import { getRoster } from '../core/roster';
import { autoGenerateSocialImages, generateSocialImage, isAutoImageRunning, isSocialImageActive } from '../core/social-images';
import { emitPhoneEvent, onPhoneEvent, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openImagePickerSheet } from './image-picker-sheet';
import { openSearchSheet } from './search-sheet';
import { appendForwardedMessage, openForwardTargetSheet } from './forward-sheet';
import { avatarHtml, bindLongPress, createViewScrollMemo, escapeAttr, escapeHtml, longPressJustFired, openActionSheet, pulseActIcon } from './phone-ui';
import { cropMediaStyle } from '../core/phone-crops';
import { actIcon, ubpIcon } from './icons';
import { openPhoneLightbox } from './image-lightbox';
import { achFlag, emitAch, emitActionOnDate } from '../core/phone-achievements';
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

type WeiboTab = 'home' | 'messages' | 'me';
type HomeSeg = 'follow' | 'recommend' | 'hot';

const TABS = [
  { id: 'home', label: '首页', icon: ubpIcon('home') },
  { id: 'messages', label: '消息', icon: ubpIcon('message') },
  { id: 'me', label: '我', icon: ubpIcon('user') },
];

let _ctx: PhoneAppContext | null = null;
let _tab: WeiboTab = 'home';
let _homeSeg: HomeSeg = 'recommend';
let _openPostId: string | null = null;
let _openTopic: string | null = null;
let _openAuthor: string | null = null; // 作者主页（点作者名进入；右上 ↻=该作者定点刷新）
let _meFollowsOpen = false; // 我的页「关注 N」展开态（内联关注列表，无弹层）
let _busy = false;
let _error = '';
// 上次失败尝试（重试钮重放：人物选择+额外提示+定点范围；成功后随横幅消失，下次生成覆盖）
let _lastAttempt: { action: 'refresh' | 'feedback' | 'author'; focusTopic?: string; focusAuthor?: string; hint: string; picked: string[] } | null = null;
// 信息流公共件：实现单一事实源在 social-shell.createSocialFeedKit（同名解构 → 全 App 调用点零改动）
const feedKit = createSocialFeedKit({
  container: () => _ctx?.container ?? null,
  isBusy: () => _busy,
  isFeedbackBusy: isFeedbackGenerating,
  setError: msg => { _error = msg; },
  rememberFeedbackAttempt: (hint, picked) => { _lastAttempt = { action: 'feedback', hint, picked }; },
  render: () => render(),
  onLoadMore: () => { _feedVisible += FEED_PAGE_SIZE; },
  onRefreshConfirm: (hint, picked) => { void doRefresh(_openTopic || undefined, hint, picked); },
});
const { toast, countLabel, openRefreshHint, openFeedbackHint, doFeedback, loadMoreFeed } = feedKit;
// 信息流分页状态：首页/话题页首屏只渲染最近 FEED_PAGE_SIZE 条，触底/扩页递增（mount/切tab/切分段/进话题重置）
let _feedVisible = FEED_PAGE_SIZE;
let _feedHasMore = false;   // 渲染帧回写：触底监听与自动扩页共用
// 跨视图滚动记忆：首页/话题/作者/详情各记各的（列表→详情→返回不会回顶，见 phone-ui createViewScrollMemo）
const _viewScroll = createViewScrollMemo();
let _pendingTop: number | null = null; // 扩页未达记忆位时的跨帧目标（递归渲染仍要落回原目标）
let _composer: {
  mode: 'post' | 'comment' | 'repost';
  postId?: string;
  replyTo?: string;
  text: string;
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

/** 社媒域快照类型（当前社交数据；帧内传参复用时的形参类型）。 */
type SocialSnapshot = ReturnType<typeof currentSocial>;

function findPost(id: string, social: SocialSnapshot = currentSocial()): WeiboPost | null {
  return social.weibo.find(p => p.id === id) || null;
}

// ─── 渲染工具 ───

/** 正文渲染：#话题# 与 @提及 蓝色高亮。 */
function renderWeiboText(text: string): string {
  const esc = escapeHtml(text);
  return esc
    .replace(/#[^#\n]{1,40}#/g, m => `<span class="topic">${m}</span>`)
    .replace(/@[\p{Script=Han}\w-]{1,20}/gu, m => `<span class="at">${m}</span>`);
}

function verifiedBadge(post: WeiboPost): string {
  if (!post.verified) return '';
  // 皮肤：V 认证 → 印章/木牌/火漆（玉符/金符/官符 · 侠/宗/官 · 诗/宫/国）；字段枚举不变
  const style = currentStyle();
  const profile = socialSkinProfile(style);
  if (profile) {
    const seal = post.verified === 'gold' ? profile.seals.gold : post.verified === 'blue' ? profile.seals.blue : profile.seals.orange;
    const base = style === 'xianxia' ? 'ubp-wb-seal' : style === 'wuxia' ? 'ubp-wb-mupai' : 'ubp-wb-wax';
    return `<i class="${base} ${seal.cls}" title="${seal.noun}">${seal.ch}</i>`;
  }
  return `<i class="ubp-wb-v ${post.verified === 'gold' ? 'g' : post.verified === 'blue' ? 'b' : 'o'}">V</i>`;
}

function renderImages(post: WeiboPost): string {
  if (!post.images.length) return '';
  const cells = post.images.map((img, idx) => {
    const key = idx === 0 ? post.id : `w:${post.id}:${idx}`;
    if (img.imagePath && img.imageStatus === 'ready') {
      // data-id=帖子 id、data-img=路径：点击放大时按整帖图组开灯箱（左右可滑，重绘作用于当前那张）
      return `<button type="button" class="ubp-mo-img" data-ubp-act="zoom" data-id="${escapeAttr(post.id)}" data-img="${escapeAttr(img.imagePath)}" title="查看大图">
        <img src="${escapeAttr(img.imagePath)}" alt="" loading="lazy"></button>`;
    }
    // busy=pending 且引擎确实在跑：中断残留的假 pending 回落为「未开始」可点击
    const busy = img.imageStatus === 'pending' && isSocialImageActive(key);
    const failed = img.imageStatus === 'failed';
    return `<button type="button" class="ubp-mo-imgph${failed ? ' failed' : ''}" data-ubp-act="gen-img" data-id="${escapeAttr(key)}" ${busy ? 'disabled' : ''}>
      ${busy ? '<span class="ubp-spinner"></span>' : failed ? '<span class="ubp-mo-imgph-note">⚠ 生成失败</span>' : ubpIcon('image')}
      <span class="ubp-mo-imgph-desc">${escapeHtml(img.desc)}</span>
      <span class="ubp-mo-imgph-hint">${busy ? '生成中…' : failed ? '点击重试' : '点击生成'}</span>
    </button>`;
  }).join('');
  return `<div class="ubp-wb-pics${post.images.length === 1 ? ' single' : ''}">${cells}</div>`;
}

function renderRepostCard(post: WeiboPost): string {
  if (!post.repost) return '';
  const profile = socialSkinProfile(currentStyle());
  const lead = profile ? `${profile.actRepost} · ${escapeHtml(post.repost.author)}：` : `<b>@${escapeHtml(post.repost.author)}</b>：`;
  return `<div class="ubp-wb-repost">${lead}${escapeHtml(post.repost.text)}${post.repost.imageDesc ? `<span style="color:var(--ubp-text-3);">（${S('配图', '配图')}：${escapeHtml(post.repost.imageDesc)}）</span>` : ''}</div>`;
}

function renderActions(post: WeiboPost, opts: { share?: boolean } = {}): string {
  const profile = socialSkinProfile(currentStyle());
  const nouns = profile ? [profile.actRepost, profile.actComment, profile.actLike] : ['', '', ''];
  return `<div class="ubp-wb-actions">
    <button type="button" class="ubp-wb-act${post.repostedByMe ? ' on' : ''}" data-ubp-act="repost" data-id="${escapeAttr(post.id)}">${ubpIcon('repost')}<i>${nouns[0] ? nouns[0] + ' ' : ''}${countLabel(post.forwards)}</i></button>
    <button type="button" class="ubp-wb-act" data-ubp-act="comment" data-id="${escapeAttr(post.id)}">${ubpIcon('comment')}<i>${nouns[1] ? nouns[1] + ' ' : ''}${countLabel(post.commentsCount)}</i></button>
    <button type="button" class="ubp-wb-act${post.likedByMe ? ' on' : ''}" data-ubp-act="like" data-id="${escapeAttr(post.id)}">${actIcon(post.likedByMe === true, 'like')}<i>${nouns[2] ? nouns[2] + ' ' : ''}${countLabel(post.likes)}</i></button>
    ${opts.share ? `<button type="button" class="ubp-wb-act" data-ubp-act="share" data-id="${escapeAttr(post.id)}" title="${S('分享到聊天', '传阅给道友', '递与茶客', '誊抄给同伴')}">${ubpIcon('share')}<i>${S('分享', '传阅', '递话', '誊抄')}</i></button>` : ''}
  </div>`;
}

// ─── 信息流卡片 ───

/** 渲染帧级 follows 名单（render 顶部读一次传参，避免卡片循环里重复深拷贝）。
 *  关注钮全程双态可逆（已关注=灰底「已关注」，再点取关）；仅已关注作者的作者名可点进主页
 *  （未关注不提供入口——避免误触一次无意义的主页资料生成，用户定案）。 */
function renderPostCard(post: WeiboPost, me: string, followsWeibo: string[], opts: { followable?: boolean; plain?: boolean; share?: boolean; authorLink?: boolean } = {}): string {
  const mine = post.author === me;
  const followed = followsWeibo.includes(post.author);
  const followBtn = opts.followable && !mine && !post.anon
    ? socialFollowBtn(followed, 'weibo', post.author)
    : '';
  const nameHtml = opts.authorLink && !mine && followed && !post.anon
    ? `<span class="ubp-wb-name" style="cursor:pointer;" data-ubp-act="open-author" data-id="${escapeAttr(post.author)}">${escapeHtml(post.author)}${verifiedBadge(post)}${post.vip ? '<span class="ubp-wb-vip">👑</span>' : ''}</span>`
    : `<div class="ubp-wb-name">${escapeHtml(post.author)}${mine || post.anon ? '<i class="ubp-mo-metag">（我）</i>' : ''}${verifiedBadge(post)}${post.vip ? '<span class="ubp-wb-vip">👑</span>' : ''}</div>`;
  return `<div class="ubp-wb-card${opts.plain ? '' : ' clickable'}"${opts.plain ? ` data-ubp-lp-post="${escapeAttr(post.id)}"` : ` data-ubp-act="open-post" data-id="${escapeAttr(post.id)}"`}>
    <div class="ubp-wb-head">
      ${avatarHtml(post.author, '', true)}
      <div class="ubp-wb-whom">
        ${nameHtml}
        <div class="ubp-wb-time">${escapeHtml(postTimeText(post, getRoster().global.time))}${post.source ? ` · ${escapeHtml(post.source)}` : ''}</div>
      </div>
      ${followBtn}
    </div>
    <div class="ubp-wb-text">${renderWeiboText(post.text)}</div>
    ${renderRepostCard(post)}
    ${renderImages(post)}
    ${renderActions(post, opts)}
  </div>`;
}

// ─── 热搜榜与话题页 ───

function renderHot(items: SocialSnapshot['trending'], feeds: SocialSnapshot['weibo']): string {
  if (!items.length) {
    return `<div class="ubp-empty"><b>${S('热搜榜还是空的', '风闻榜还是空的', '今日书目还是空的', '传唱榜还是空的')}</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`;
  }
  const rows = items.map(t => `
    <div class="ubp-wb-hotrow" data-ubp-act="topic" data-id="${escapeAttr(t.title)}">
      <span class="ubp-wb-rank${t.rank <= 3 ? ` r${t.rank}` : ''}">${t.rank}</span>
      <span class="ubp-wb-hotword">${escapeHtml(t.title)}</span>
      ${t.tag ? `<span class="ubp-wb-tag ${escapeAttr(t.tag)}">${escapeHtml(t.tag)}</span>` : ''}
      <span class="ubp-wb-hotnum">${escapeHtml(t.hot)}</span>
    </div>`).join('');
  return `<div class="ubp-wb-hotlist">${rows}</div>
    <div class="ubp-mo-metag" style="display:block;text-align:center;padding:10px 0 0;">${S(
      `共 ${feeds.length} 条博文`,
      `共 ${feeds.length} 条风闻`,
      `共 ${feeds.length} 条茶帖`,
      `共 ${feeds.length} 条见闻`)}</div>`;
}

function renderTopic(topic: string, followsWeibo: string[], feed: SocialSnapshot['weibo']): string {
  const me = getRoster().protagonistName;
  const norm = topic.replace(/^#|#$/g, '').trim();
  const related = feed.filter(p => weiboMatchesTopic(p, norm));
  const { page, hasMore, remaining } = paginateFeed(related, _feedVisible); // 相关博文也只渲染最近10条
  _feedHasMore = hasMore;
  const reads = related.reduce((n, p) => n + p.forwards * 17 + p.likes * 31, 0);
  const profile = socialSkinProfile(currentStyle());
  if (profile) {
    return `<div class="ubp-wb-topic-hero"><div class="ubp-wb-topic-word">${profile.topicWord} · ${escapeHtml(norm)} ${profile.topicVerb}</div>
      <div class="ubp-wb-topic-stat">${profile.statRead} ${countLabel(Math.max(12000, reads))} · ${profile.statDiscuss} ${countLabel(related.reduce((n, p) => n + p.commentsCount, 0))} · ${S('相关博文', '相关风闻', '相关风声', '相关见闻')} ${related.length} 条</div></div>
      <div class="ubp-wb-topic-host"><span class="ubp-wb-topic-chip">${profile.topicWord}</span><span>${S('正在实时讨论中，热度持续上升。', '满城议论正酣，声势愈演愈烈。', '满堂茶客议论正酣，一浪高过一浪。', '酒馆歌声正酣，一浪高过一浪。')}</span></div>
  ${page.length
    ? page.map(p => renderPostCard(p, me, followsWeibo, { followable: true, authorLink: true })).join('') + (hasMore ? feedMoreHtml(remaining) : '')
    : `<div class="ubp-empty"><b>${S('暂无相关博文', '暂无相关风闻', '暂无相关风声', '暂无相关见闻')}</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`}`;
  }
  return `<div class="ubp-wb-topic-hero">
    <div class="ubp-wb-topic-word"># ${escapeHtml(norm)} #</div>
    <div class="ubp-wb-topic-stat">阅读 ${countLabel(Math.max(12000, reads))} · 讨论 ${countLabel(related.reduce((n, p) => n + p.commentsCount, 0))} · 相关博文 ${related.length} 条</div>
  </div>
  <div class="ubp-wb-topic-host"><span class="ubp-wb-topic-chip">话题</span><span>正在实时讨论中，热度持续上升。</span></div>
  ${page.length
    ? page.map(p => renderPostCard(p, me, followsWeibo, { followable: true, authorLink: true })).join('') + (hasMore ? feedMoreHtml(remaining) : '')
    : `<div class="ubp-empty"><b>暂无相关博文</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`}`;
}

// ─── 作者主页（严格对照 docs/follow-mechanism-mockup.html wb-author；资料=1B 型轻量生成一次后缓存） ───

/** 首次进入且无缓存 → 后台轻量生成资料；完成/失败后若仍在该主页则重渲染（失败=本地兜底头部）。 */
function ensureAuthorProfile(name: string): void {
  const profile = readSocialAuthorProfile('weibo', name);
  // 封面先行的最小档案（只选过封面、资料字段仍全空）不算已有资料：进页照常触发资料生成
  const hasStats = Boolean(profile && (profile.signature || profile.following || profile.followers || profile.likes));
  if (hasStats || isAuthorProfileGenerating()) return;
  void runAuthorProfileGeneration('weibo', name)
    .then(() => { if (_ctx && _openAuthor === name) render(); })
    .catch(() => { if (_ctx && _openAuthor === name) render(); });
}

/** 作者主页头部（资料生成中=骨架屏；无资料且非生成中=本地兜底：名字+暂无简介+0 数据）。 */
function renderAuthorHome(name: string, followsWeibo: string[], feed: SocialSnapshot['weibo']): string {
  const me = getRoster().protagonistName;
  const profile: SocialAuthorProfile | null = readSocialAuthorProfile('weibo', name);
  const posts = feed.filter(p => p.author === name);
  const followed = followsWeibo.includes(name);
  const busy = isAuthorProfileGenerating();
  const vBadge = profile?.verified ? `<span class="ubp-wb-vv ${profile.verified === 'gold' ? 'g' : profile.verified === 'blue' ? 'b' : 'o'}">V</span>` : '';
  const headHtml = busy && !profile
    ? `<div class="ubp-sauth-cover ubp-wb-acover"></div>
      <div class="ubp-wb-ahead">
        <div class="ubp-wb-ahead-row1"><div class="ubp-wb-bigava ubp-sk" style="border-color:var(--ubp-card);"></div><div class="ubp-sk" style="width:88px;height:32px;border-radius:17px;margin-left:auto;margin-bottom:9px;"></div></div>
        <div class="ubp-sk" style="height:19px;width:118px;margin-top:9px;"></div>
        <div class="ubp-sk" style="height:13px;width:60%;margin-top:9px;"></div>
        <div class="ubp-wb-stats"><span class="ubp-sk" style="width:50px;height:17px;"></span><span class="ubp-sk" style="width:50px;height:17px;"></span><span class="ubp-sk" style="width:50px;height:17px;"></span></div>
        <div class="ubp-wb-pagetab"><span class="on">${S('微博', '风闻', '茶帖', '见闻')}</span></div>
      </div>
      <div style="padding:8px;"><div class="ubp-sk" style="height:96px;border-radius:8px;"></div></div>`
    : `<div class="ubp-sauth-cover ubp-wb-acover"><div class="ubp-crop-media bg"${profile?.cover ? ` style="background-image:url('${escapeAttr(profile.cover)}');${cropMediaStyle(`wb:${name}`)}"` : ''}></div><button type="button" class="ubp-wb-acover-edit" data-ubp-act="cover-edit" data-id="${escapeAttr(name)}">${S('换封面', '换卷首', '换幌面', '换扉页')}</button></div>
      <div class="ubp-wb-ahead">
        <div class="ubp-wb-ahead-row1">
          <div class="ubp-wb-bigava">${avatarHtml(name, 'ubp-bigava', true)}${vBadge}</div>
          <button type="button" class="ubp-wb-fbtn ${followed ? 'on' : 'off'}" data-ubp-act="follow" data-scope="weibo" data-id="${escapeAttr(name)}">${followed ? S('已关注', '已结交') : S('+ 关注', '+ 结交')}</button>
        </div>
        <div class="ubp-wb-name">${escapeHtml(name)}${name === me ? `<i class="ubp-mo-metag">（我）</i>` : ''}</div>
        ${profile?.verified ? `<div class="ubp-wb-verified"><i>✓</i>${profile.verified === 'gold' ? S('金V认证', '金符认证', '宗师帖认证', '国印认证') : profile.verified === 'blue' ? S('蓝V认证', '官符认证', '官府帖认证', '宫印认证') : S('橙V认证', '玉符认证', '侠名帖认证', '诗印认证')}</div>` : ''}
        <div class="ubp-wb-bio">${escapeHtml(profile?.signature || S('暂无简介', '暂无名帖题记', '暂无题记', '暂无题记'))}</div>
        <div class="ubp-wb-stats">
          <span><b>${escapeHtml(profile?.following || '0')}</b><span>${S('关注', '结交')}</span></span>
          <span><b>${escapeHtml(profile?.followers || '0')}</b><span>${S('粉丝', '拥趸')}</span></span>
          <span><b>${escapeHtml(profile?.likes || '0')}</b><span>${S('转评赞', '转议赞', '转搭赞', '转应赞')}</span></span>
        </div>
        <div class="ubp-wb-pagetab"><span class="on">${S('微博', '风闻', '茶帖', '见闻')}</span></div>
      </div>`;
  const listHtml = posts.length
    ? posts.map(p => renderPostCard(p, me, followsWeibo, { followable: true, authorLink: true })).join('')
    : `<div class="ubp-empty"><b>${S('TA 还没有发过微博', '故人还未投帖', '熟客还未开口', '同路人还未起笔')}</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`;
  return `<div class="ubp-wb-author">${headHtml}<div style="padding:8px;">${listHtml}</div></div>${busy && !profile ? `<div class="ubp-sgen"><span class="ubp-spin"></span>${S('正在生成 TA 的资料…', '正在访 TA 的名帖…', '正在探 TA 的来历…', '正在识 TA 的来历…')}</div>` : ''}`;
}

// ─── 博文详情 ───

function renderDetail(post: WeiboPost, followsWeibo: string[]): string {
  const me = getRoster().protagonistName;
  const threads = buildCommentThreads(post.comments);
  const idxOf = new Map(post.comments.map((c, i) => [c, i]));
  const comments = threads.length
    ? threads.map(t => {
      const ci = idxOf.get(t.comment)!;
      const subs = renderSubReplies({
        kind: 'weibo',
        threadKey: `weibo:${post.id}:${ci}`,
        postId: post.id,
        rootName: t.comment.name,
        subs: t.replies.map(r => ({
          idx: idxOf.get(r)!,
          name: r.name,
          text: r.text,
          replyTo: r.replyTo,
          time: r.time ? commentTimeText(r, post, getRoster().global.time) : '',
          mine: r.name === me || r.anon === true,
          isAuthor: r.name === post.author,
        })),
      });
      return renderComment(post, t.comment, ci, me, subs);
    }).join('')
    : '';
  return renderPostCard(post, me, followsWeibo, { followable: true, plain: true, share: true, authorLink: true })
    + `<div class="ubp-wb-cmts">
    <div class="ubp-mo-metag" style="display:block;padding:10px 14px 2px;">${S(
      `共 ${countLabel(post.commentsCount)} 条评论 · 按热度排序`,
      `共 ${countLabel(post.commentsCount)} 条议论 · 按热度排序`,
      `共 ${countLabel(post.commentsCount)} 条搭话 · 按热度排序`,
      `共 ${countLabel(post.commentsCount)} 条应和 · 按热度排序`)}</div>
    ${comments || `<div class="ubp-empty">${S('还没有评论，抢个热评？', '还无人议论，占个头排？', '还无人搭话，占个头排？', '还无人应和，占个头排？')}</div>`}
  </div>
  <div class="ubp-replybar">
    <button type="button" class="input" data-ubp-act="comment" data-id="${escapeAttr(post.id)}" style="border:none;cursor:pointer;text-align:left;font-family:var(--ubp-font);">${S('说点什么…', '留一言…', '讲两句…', '应一句…')}</button>
    <button type="button" class="go" data-ubp-act="comment" data-id="${escapeAttr(post.id)}">${S('评论', '议论', '搭话', '应和')}</button>
  </div>`;
}

function renderComment(post: WeiboPost, comment: { name: string; text: string; replyTo?: string; time?: string; anon?: true }, idx: number, me: string, subs = ''): string {
  const mine = comment.name === me;
  const mineTag = mine || comment.anon === true;   // 匿名评论也标淡色「（我）」
  const reply = comment.replyTo ? `回复 <b>@${escapeHtml(comment.replyTo)}</b>：` : '';
  const time = comment.time ? `<span>${escapeHtml(commentTimeText(comment, post, getRoster().global.time))}</span>` : '';
  const replyBtn = mine ? '' : `<button type="button" class="ubp-mo-creply" data-ubp-act="reply-c" data-id="${escapeAttr(post.id)}" data-idx="${idx}">回复</button>`;
  const bz = !mine && comment.name === post.author ? '<i class="ubp-wb-bz">博主</i>' : '';
  return `<div class="ubp-wb-cmt" data-ubp-cidx="${idx}">
    ${avatarHtml(comment.name, '', true)}
    <div class="ubp-wb-cmtmain">
      <div class="ubp-wb-cmtname">${escapeHtml(comment.name)}${bz}${mineTag ? '<i class="ubp-mo-metag">（我）</i>' : ''}</div>
      <div class="ubp-wb-cmttext">${reply}${escapeHtml(comment.text)}</div>
      <div class="ubp-wb-cmtmeta">${time}${replyBtn}</div>
      ${subs}
    </div>
  </div>`;
}

// ─── 编辑面板（发微博 / 评论 / 转发） ───

/** 博文 → 分享快照（成品图引用 imagePath；评论带配图；转发链原博一并带入）。 */
function weiboShareSnapshot(post: WeiboPost): SharePostSnapshot {
  return {
    app: 'weibo',
    author: post.author,
    text: post.text,
    images: post.images.map(img => ({
      desc: img.desc,
      ...(img.imagePath && img.imageStatus === 'ready' ? { imagePath: img.imagePath } : {}),
    })),
    ...(post.repost
      ? {
        repost: {
          author: post.repost.author,
          text: post.repost.text,
          ...(post.repost.imageDesc?.trim() ? { image: { desc: post.repost.imageDesc } } : {}),
        },
      }
      : {}),
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
function sharePostToChat(post: WeiboPost): void {
  if (!_ctx) return;
  const message = buildShareMessage(weiboShareSnapshot(post), getRoster().global.time);
  if (!message) return;
  openForwardTargetSheet(_ctx, pick => {
    if (appendForwardedMessage(pick, message)) {
      // L9 成就：玩家亲手把帖子分享到聊天成功
      emitAch('phone_share_to_chat', { platform: 'weibo' });
      toast(S('已分享到聊天', '已传阅道友'));
    }
  });
}

// ─── 长按操作面板（帖子=分享/删除；评论/回复=删除，连带楼中楼子回复） ───

function deletePostAndRender(postId: string): void {
  try {
    deleteUserPost('weibo', postId);
    // L9 成就：玩家亲手删除博文成功（失败分支不打点）
    emitAch('phone_post_deleted', { platform: 'weibo' });
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
    title: socialExcerpt(post.text, 24),
    items: [
      { act: 'share', label: S('分享到聊天', '传阅给道友', '递与茶客', '誊抄给同伴') },
      { act: 'del', label: S('删除博文', '删去风闻', '删去茶帖', '删去见闻'), danger: true },
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
    title: S(`删除 ${target.name} 的这条${target.replyTo ? '回复' : '评论'}？`, `删去 ${target.name} 的这条${target.replyTo ? '回话' : '议论'}？`),
    body: S('其楼中楼的子回复将一并删除，删除后不可恢复。', '其楼中楼的子回话将一并删去，删后不可挽回。'),
    items: [{ act: 'del', label: S('删除', '删去'), danger: true }],
    onPick: act => {
      if (act !== 'del') return;
      try {
        deleteSocialComment('weibo', postId, idx);
        emitPhoneEvent('ubp-phone:data-changed');
        toast('已删除');
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      render();
    },
  });
}

function renderComposer(): string {
  if (!_composer) return '';
  const c = _composer;
  const title = c.mode === 'post' ? S('发微博', '投帖', '说与茶客', '谱写见闻')
    : c.mode === 'repost' ? S('转发微博', '传抄此帖', '转述此帖', '传唱此篇')
    : c.replyTo ? `${S('回复', '回话')} ${c.replyTo}` : S('写评论', '写议论', '写搭话', '写应和');
  const attach = c.mode !== 'post' ? '' : c.imgPath
    ? `<div class="ubp-mo-attach"><span class="ubp-mo-attachchip">${ubpIcon('image')}${escapeHtml(c.imgDesc || S('已选图片', '已选留影'))}<button type="button" class="ubp-mo-attachx" data-ubp-act="compose-detach">×</button></span></div>`
    : c.cameraMode
      ? `<textarea class="ubp-textarea" data-ubp-input="compose-imgdesc" rows="2" placeholder="${S('照片内容描述（发布后按描述生成图片）', '画面描述（投帖后按描述显影留影）', '画面描述（投帖后按描述显影写真）', '画面描述（投稿后按描述显影记影）')}">${escapeHtml(c.imgDesc)}</textarea>
         <div class="ubp-mo-attachrow"><button type="button" class="ubp-btn" data-ubp-act="compose-attach-album">${S('改从相册选择', '改从影阁选取')}</button><button type="button" class="ubp-btn" data-ubp-act="compose-detach">${S('取消附图', '撤去配图')}</button></div>`
      : `<div class="ubp-mo-attachrow"><button type="button" class="ubp-btn" data-ubp-act="compose-attach-camera">${ubpIcon('camera')}${S('拍照描述生图', '摄录留影（描述画面）', '描述画面 · 写真显影', '凝景记影（描述画面）')}</button><button type="button" class="ubp-btn" data-ubp-act="compose-attach-album">${ubpIcon('album')}${S('从相册选择', '从影阁选取')}</button></div>`;
  const placeholder = c.mode === 'post' ? S('分享新鲜事…', '今日风闻，说与诸位听…', '今日风声，说与满堂茶客听…', '今日见闻，唱与诸位旅人听…')
    : c.mode === 'repost' ? S('说说你的转发理由（如「蹲一个后续」「转发微博」）…', '说说你传抄的缘由（如「静待后续」「且看此帖」）…', '说说你转述的缘由（如「且听下回分解」「此事必有内情」）…', '说说你传唱的缘由（如「这事在酒馆都唱开了」「以缪斯之名」）…')
      : c.replyTo ? `${S('回复', '回话')} ${escapeHtml(c.replyTo)}…` : S('说点什么…', '留一言…', '讲两句…', '应一句…');
  const sendable = Boolean(c.text.trim()) && (c.mode !== 'post' || !c.cameraMode || Boolean(c.imgDesc.trim()) || Boolean(c.imgPath));
  return `<div class="ubp-overlay ubp-mo-composer">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">${escapeHtml(title)}</div>
      <textarea class="ubp-textarea" data-ubp-input="compose-text" rows="3" placeholder="${placeholder}">${escapeHtml(c.text)}</textarea>
      ${anonRowHtml(c.anon, c.anonName)}
      ${attach}
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="compose-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="compose-send" ${sendable ? '' : 'disabled'}>${c.mode === 'post' ? S('发布', '投帖') : c.mode === 'repost' ? S('转发', '传抄', '转述', '传唱') : S('发送', '送出')}</button>
      </div>
    </div>
  </div>`;
}

function openComposer(mode: 'post' | 'comment' | 'repost', postId?: string, replyTo?: string): void {
  _composer = { mode, postId, replyTo, text: '', imgPath: '', imgDesc: '', cameraMode: false, anon: false, anonName: '' };
  render();
}

function openAlbumPicker(): void {
  if (!_ctx || !_composer) return;
  openImagePickerSheet(_ctx.container, {
    mode: 'context',
    title: S('从相册选择', '从影阁选取'),
    emptyText: S('相册还是空的——用「拍照描述生图」先拍一张', '影阁还是空的——用「摄录留影」先留一张', '画匣还是空的——用「描述画面 · 写真显影」先照一张', '画廊还是空的——用「凝景记影」先记一幅'),
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
  if (c.mode === 'post') {
    const { postId } = createUserPost({
      kind: 'weibo',
      text,
      ...(c.anon ? { anon: true, anonName: c.anonName } : {}),
      ...(c.imgPath ? { imagePath: c.imgPath } : {}),
      imageDesc: c.imgPath ? c.imgDesc : c.cameraMode ? composeShootDesc(c.imgDesc, getRoster()) : '',
    });
    _composer = null;
    render();
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：玩家亲手发布成功（附图意图即算 hasImage；匿名按开关）
    emitAch('phone_post_published', {
      platform: 'weibo',
      hasImage: achFlag(!!c.imgPath || (c.cameraMode && c.imgDesc.trim())),
      anon: achFlag(c.anon),
      isRepost: 0,
    });
    emitActionOnDate('phone_post');
    toast(c.anon ? S('已匿名发布', '已匿名投帖', '已匿名挂出', '已匿名投稿') : S('已发布', '已投帖', '已挂出', '已投稿'));
    // SO-06：与贴吧/小红书/朋友圈一致——相机口径配文发布即生成配图（不留死占位到下次刷新）
    if (c.cameraMode && c.imgDesc.trim()) {
      try { await generateSocialImage('weibo', postId); } catch (_e) { /* 占位已落 failed */ }
      if (_ctx) render();
    }
    return;
  }
  if (c.mode === 'repost') {
    if (!c.postId) return;
    createUserPost({ kind: 'weibo', text, repostOfId: c.postId, ...(c.anon ? { anon: true, anonName: c.anonName } : {}) });
    _composer = null;
    render();
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：微博转发成功（isRepost 标记；日窗口伴随）
    emitAch('phone_post_published', {
      platform: 'weibo',
      hasImage: 0,
      anon: achFlag(c.anon),
      isRepost: 1,
    });
    emitActionOnDate('phone_post');
    toast(S('转发成功', '传抄成功', '转述成功', '传唱成功'));
    return;
  }
  if (!c.postId) return;
  addSocialComment({ kind: 'weibo', postId: c.postId, text, ...(c.replyTo ? { replyTo: c.replyTo } : {}), ...(c.anon ? { anon: true, anonName: c.anonName } : {}) });
  _composer = null;
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手评论/楼中楼成功
  emitAch('phone_comment_posted', { platform: 'weibo', isReply: achFlag(!!c.replyTo) });
}

// ─── 刷新与求回应 ───

async function doRefresh(focusTopic?: string, hint?: string, picked?: string[], focusAuthor?: string): Promise<void> {
  if (_busy) return;
  _busy = true;
  _lastAttempt = { action: focusAuthor ? 'author' : 'refresh', ...(focusTopic ? { focusTopic } : {}), ...(focusAuthor ? { focusAuthor } : {}), hint: hint || '', picked: picked || [] };
  _error = '';
  render();
  try {
    const focus = focusAuthor ? { author: focusAuthor } : focusTopic ? { topic: focusTopic } : undefined;
    await refreshSocialSnapshot({ kind: 'weibo', ...(focus ? { focus } : {}), ...(hint ? { extraHint: hint } : {}) , ...(picked && picked.length ? { focusNames: picked } : {}) });
    emitPhoneEvent('ubp-phone:data-changed');
    if (_openPostId && !findPost(_openPostId)) _openPostId = null;
    const p = socialSkinProfile(currentStyle());
    toast(focusAuthor
      ? S(`@${focusAuthor} 主页已刷新`, `@${focusAuthor} 名帖已刷新`, `@${focusAuthor} 名帖已刷新`, `@${focusAuthor} 名帖已刷新`)
      : focusTopic
      ? S(`#${focusTopic}# 话题已刷新`, `#${focusTopic}# 风闻已刷新`, `#${focusTopic}# 风声已刷新`, `#${focusTopic}# 传唱已刷新`)
      : p ? p.refreshToast : '微博已刷新');
  } catch (e) {
    _error = isPhoneAbortError(e) ? '' : (e instanceof Error ? e.message : String(e));
  } finally {
    _busy = false;
    render();
    void autoGenerateSocialImages('weibo').then(() => { if (_ctx) render(); });
  }
}

// ─── 主渲染 ───

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const prevBody = container.querySelector<HTMLElement>('.ubp-appbody');
  const prevScrollTop = prevBody?.scrollTop ?? 0;
  _feedHasMore = false; // 详情/消息/我的/热搜榜不分页，只有首页信息流与话题页是信息流

  const me = getRoster().protagonistName;
  const profile = socialSkinProfile(currentStyle());
  const social = currentSocial(); // 帧级一次（本帧各处共用，禁重复深拷贝；对齐 readSocialFollows 纪律）
  const follows = readSocialFollows(); // 帧级一次（卡片循环禁重复深拷贝）
  const followsWeibo = follows.weibo;
  const pendingActions = getPendingActions(social); // 用本帧 social 快照（帧级一次，免二次全量深拷贝）
  const pendingCount = pendingActions.length;
  const msgUnread = getSocialNotificationUnread('weibo'); // 零拷贝 ref 读（徽标热路径纪律）
  const fbBusy = isFeedbackGenerating();
  const autoBusy = isAutoImageRunning('weibo');
  const busyHtml = `
    ${_error ? `<div class="ubp-mo-error">${escapeHtml(_error)}<button class="ubp-mo-retry" data-ubp-act="retry-gen">${S('重试', '重试')}</button></div>` : ''}
    ${_busy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>${_openTopic
      ? S('正在刷新话题讨论…', profile?.refreshingTopicText || '正在收录风闻议论…', '正在听茶客议论…', '正在收录应和…')
      : S('正在刷新微博…', profile?.refreshingText || '正在收录风闻…', '正在沏新茶、收录风声…', '正在誊抄新见闻…')}<button class="ubp-btn" data-ubp-act="abort">${S('终止', '终止')}</button></div>` : ''}
    ${fbBusy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>${S('正在生成互动回应…', '正在催动回应…', '正在邀人回话…', '正在邀人应和…')}<button class="ubp-btn" data-ubp-act="abort">${S('终止', '终止')}</button></div>` : ''}
    ${autoBusy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>${S('正在批量生成配图…', '正在批量显影配图…', '正在批量显影写真…', '正在批量显影记影…')}</div>` : ''}`;

  const openPost = _openPostId ? findPost(_openPostId, social) : null;
  // 滚动记忆视图键：详情/作者/话题页各自独立，列表按 tab+分段分记（键变=换视图，进详情从顶部开始）
  const viewKey = openPost ? `post:${openPost.id}`
    : _openAuthor ? `author:${_openAuthor}`
    : _openTopic ? `topic:${_openTopic}`
    : `${_tab}:${_homeSeg}`;
  let topHtml = '';
  let bodyInner = '';
  let showTabbar = true;
  let activeTab = _tab;

  if (openPost) {
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: _openTopic ? 'back-topic' : 'back-list',
      title: _openTopic ? `#${_openTopic.replace(/^#|#$/g, '')}#` : S('微博正文', '风闻详情', '风声详情', '见闻详情'),
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }),
    });
    bodyInner = busyHtml + renderDetail(openPost, followsWeibo);
  } else if (_openAuthor) {
    // 作者主页：导航（返回 + 主页标题 + 求回应/作者定点刷新）
    showTabbar = false;
    topHtml = socialDetailNav({
      backAct: 'author-back',
      title: `${_openAuthor} · ${S('主页', '名帖', '名帖', '名帖')}`,
      sub: S('刷新只出该作者内容', '刷新只出该报信人风闻', '刷新只出该茶客茶帖', '刷新只出该旅人见闻'),
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy, refreshTitle: S(`作者刷新（生成 @${_openAuthor} 的最新 2-4 条博文）`, `作者刷新（收录 @${_openAuthor} 的新风闻）`, `作者刷新（收录 @${_openAuthor} 的新茶帖）`, `作者刷新（收录 @${_openAuthor} 的新见闻）`) }),
    });
    bodyInner = busyHtml + renderAuthorHome(_openAuthor, followsWeibo, social.weibo);
  } else if (_openTopic) {
    // 话题页：导航（返回热搜 + 话题名 + 求回应/话题定点刷新）+ hero + 相关博文
    showTabbar = false;
    const norm = _openTopic.replace(/^#|#$/g, '');
    topHtml = socialDetailNav({
      backAct: 'back-list',
      title: `# ${norm} #`,
      sub: S('话题刷新只出讨论', '风闻刷新只出议论', '风声刷新只出议论', '传唱刷新只出应和'),
      actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy, refreshTitle: S(`话题刷新（围绕 #${norm}# 生成新讨论）`, `风闻刷新（围绕 #${norm}# 收录新议论）`, `风声刷新（围绕 #${norm}# 收录新茶帖）`, `传唱刷新（围绕 #${norm}# 收录新应和）`) }),
    });
    bodyInner = busyHtml + renderTopic(_openTopic, followsWeibo, social.weibo);
  } else if (_tab === 'messages') {
    topHtml = socialDetailNav({ backAct: 'exit', title: S('消息', '知会'), actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }) });
    bodyInner = busyHtml + renderSocialMessages('weibo', pendingActions, social);
  } else if (_tab === 'me') {
    topHtml = socialDetailNav({ backAct: 'exit', title: profile ? profile.meTitle : S('我的微博', '我的名帖'), actsHtml: socialDetailActs({ busy: _busy, pendingCount, fbBusy }) });
    bodyInner = busyHtml + renderSocialMe('weibo', follows, _meFollowsOpen, social);
  } else {
    // 首页：品牌顶栏（logo+搜索胶囊+铃铛）+ 关注/推荐/热搜分段；
    // 皮肤：仙侠=玉印方印+风闻榜牌卡+市井/故人 chips；武侠=茶旗木牌+今日书目水牌+全堂/熟客；西幻=火漆社印+传唱榜卷轴+广场/同路
    const hint = social.trending[0]?.title || S('看看大家在聊什么', '看看满城在议什么', '听听满堂在议什么', '听听酒馆都在唱什么');
    const actsHtml = `
        <div class="ubp-stop-acts">
          <button class="ubp-iconbtn ubp-sbell${pendingCount ? ' has' : ''}" data-ubp-act="nav" data-id="messages" title="${S('消息（待回应互动）', '知会（待回应动静）', '知会（待回应动静）', '知会（待回应动静）')}">${ubpIcon('bell')}</button>
          ${pendingCount ? `<button class="ubp-iconbtn ubp-fbbadge" data-ubp-act="feedback" title="${S('求回应（生成角色对我互动的回应）', '求回应（生成角色对我动静的回应）')}" ${fbBusy || _busy ? 'disabled' : ''}>${ubpIcon('comment')}<i>${pendingCount}</i></button>` : ''}
          <button class="ubp-iconbtn" data-ubp-act="refresh" title="刷新" ${_busy ? 'disabled' : ''}>
            <span class="${_busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span>
          </button>
        </div>`;
    const boardRow = (t: { title: string; tag?: string; hot: string }): string => `
        <div class="ubp-wb-board-row" data-ubp-act="topic" data-id="${escapeAttr(t.title)}">
          <span class="ubp-wb-btag ${escapeAttr(t.tag || profile?.trendingTags.split('|')[2] || '议')}">${escapeHtml(t.tag || profile?.trendingTags.split('|')[2] || '议')}</span><span class="ubp-wb-board-word">${escapeHtml(t.title)}</span><span class="ubp-wb-board-num">${escapeHtml(t.hot)}</span>
        </div>`;
    // 搜索胶囊（三皮肤共用一处 markup）：点开输入话题 → 进话题页并围绕该话题定向生成（复用 focus.topic 链路）
    const searchBox = (text: string): string => `<button type="button" class="ubp-stop-search" data-ubp-act="search" title="${S('搜索话题', '搜索风闻', '搜索风声', '搜索传唱')}">${ubpIcon('search')}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${text}</span></button>`;
    if (currentStyle() === 'xianxia') {
      const trending = social.trending;
      const boardHtml = trending.length ? `
      <div class="ubp-wb-board">
        <div class="ubp-wb-board-hd">风 闻 榜 <button type="button" class="ubp-wb-board-more" data-ubp-act="seg" data-id="hot">阅全榜 ›</button></div>
        ${trending.slice(0, 3).map(boardRow).join('')}
      </div>` : '';
      topHtml = `<div class="ubp-stop">
        <div class="ubp-stop-row">
          <span class="ubp-wb-seal0">晓</span>
          ${searchBox(`满城都在议：#${escapeHtml(hint)}#`)}
          ${actsHtml}
        </div>
        ${boardHtml}
        <div class="ubp-wb-chips">
          <button type="button" class="ubp-wb-chip${_homeSeg === 'recommend' ? ' on' : ''}" data-ubp-act="seg" data-id="recommend">市井</button>
          <button type="button" class="ubp-wb-chip${_homeSeg === 'follow' ? ' on' : ''}" data-ubp-act="seg" data-id="follow">故人</button>
        </div>
      </div>`;
    } else if (profile) {
      // 武侠·悦来茶馆 / 西幻·吟游诗社：品牌行（茶旗/火漆 + 阁名 + 副题 + 检索 + 铃）+ 榜牌（水牌/卷轴）+ 筛选 chips
      const trending = social.trending;
      const boardHtml = trending.length ? `
      <div class="ubp-wb-board">
        <div class="ubp-wb-board-hd">${profile.boardTitle} <button type="button" class="ubp-wb-board-more" data-ubp-act="seg" data-id="hot">${profile.boardMore}</button></div>
        ${trending.slice(0, 3).map(boardRow).join('')}
      </div>` : '';
      topHtml = `<div class="ubp-stop ubp-wb-branded">
        <div class="ubp-wb-brandrow">
          <span class="ubp-wb-brand">${profile.brandGlyph}</span>
          <div class="ubp-wb-brandname"><div class="n">${escapeHtml(profile.appName)}</div><div class="s">${escapeHtml(profile.tagline)}</div></div>
          ${searchBox(`${escapeHtml(profile.searchLead)}#${escapeHtml(hint)}#`)}
          ${actsHtml}
        </div>
        ${boardHtml}
        <div class="ubp-wb-chips">
          <button type="button" class="ubp-wb-chip${_homeSeg === 'recommend' ? ' on' : ''}" data-ubp-act="seg" data-id="recommend">${profile.segAll}</button>
          <button type="button" class="ubp-wb-chip${_homeSeg === 'follow' ? ' on' : ''}" data-ubp-act="seg" data-id="follow">${profile.segFollow}</button>
        </div>
      </div>`;
    } else {
      topHtml = `<div class="ubp-stop">
        <div class="ubp-stop-row">
          <span class="ubp-stop-logo">微<em>博</em></span>
          ${searchBox(`大家都在搜：#${escapeHtml(hint)}#`)}
          ${actsHtml}
        </div>
        <div class="ubp-sseg">${socialSeg([{ id: 'follow', label: '关注' }, { id: 'recommend', label: '推荐' }, { id: 'hot', label: '热搜' }], _homeSeg)}</div>
      </div>`;
    }
    if (_homeSeg === 'hot') {
      bodyInner = busyHtml + renderHot(social.trending, social.weibo);
    } else {
      const all = social.weibo;
      const posts = _homeSeg === 'follow'
        ? all.filter(p => followsWeibo.includes(p.author) || p.author === me)
        : all;
      const { page, hasMore, remaining } = paginateFeed(posts, _feedVisible); // 只渲染最近10条博文，余下触底加载
      _feedHasMore = hasMore;
      bodyInner = busyHtml + (page.map(p => renderPostCard(p, me, followsWeibo, { followable: true, authorLink: true })).join('')
        || `<div class="ubp-empty"><b>${_homeSeg === 'follow'
          ? S('关注的人还没有发博', '故人还未投帖', '熟客还未开口', '同路人还未起笔')
          : S('信息流还是空的', '满堂风闻还是空的', '满堂风声还是空的', '见闻长卷还是空的')}</b>${_homeSeg === 'follow'
          ? ''
          : '<button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button>'}</div>`)
        + (hasMore ? feedMoreHtml(remaining) : '');
    }
  }

  container.innerHTML = renderSocialShell({
    appClass: 'ubp-wb',
    topHtml,
    bodyInner: `${bodyInner}<div style="height:${showTabbar ? 12 : 20}px;"></div>`,
    tabs: TABS.map(t => (t.id === 'messages'
      ? { ...t, badge: msgUnread, label: S('消息', '知会', '知会', '知会') }
      : { ...t, label: t.id === 'home' ? S('首页', '风闻', '书场', '广场') : S('我', '名帖', '名帖', '名册') })),
    activeTab,
    composeAct: 'compose-post',
    showTabbar,
    extraHtml: `
      ${renderComposer()}`,
  });
  const body = container.querySelector<HTMLElement>('.ubp-appbody');
  if (body) {
    // 跨视图保位：详情页首次进入从顶部开始，返回列表回到离开时读到的位置（同视图重绘=原位）
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
  if (longPressJustFired()) return; // 长按分享刚触发：吞掉残留 click（防误开详情）
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const id = el.dataset.id || '';
  switch (act) {
    case 'exit': _ctx?.closeApp(); break;
    case 'back-list': _openPostId = null; _openTopic = null; render(); break;
    case 'back-topic': _openPostId = null; render(); break;
    // 搜索：输入话题 → 进话题页（复用现有话题页）并围绕该话题定向生成一次
    case 'search': {
      if (!_ctx) break;
      const hint = currentSocial().trending[0]?.title || '';
      openSearchSheet(_ctx.container, {
        title: S('搜索微博话题', '搜索风闻', '搜索风声', '搜索传唱'),
        placeholder: S(`输入话题，如：${hint || '临江暴雨'}`, `输入风闻，如：${hint || '城中异闻'}`, `输入风声，如：${hint || '城外传闻'}`, `输入传唱，如：${hint || '远方歌谣'}`),
        onSubmit: kw => {
          // L9 成就：玩家亲手提交搜索（微博域；AI 定向生成与成败无关）
          emitAch('phone_search_performed', { scope: 'weibo' });
          _openTopic = kw;
          _openPostId = null;
          _openAuthor = null;
          _feedVisible = FEED_PAGE_SIZE;
          render();
          void doRefresh(kw);
        },
      });
      break;
    }
    case 'nav': {
      const next = (TABS.find(t => t.id === id)?.id || 'home') as WeiboTab;
      if (next !== _tab || _openTopic) {
        _tab = next;
        _openTopic = null;
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
    case 'refresh': void doRefresh(_openTopic || undefined, undefined, undefined, _openAuthor || undefined); break;
    case 'abort': abortSocialGeneration(); break;
    case 'feedback': void doFeedback(); break;
    case 'retry-gen': {
      if (!_lastAttempt) break;
      if (_lastAttempt.action === 'refresh') void doRefresh(_lastAttempt.focusTopic, _lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined);
      else if (_lastAttempt.action === 'author') void doRefresh(undefined, _lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined, _lastAttempt.focusAuthor);
      else void doFeedback(_lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined);
      break;
    }
    case 'open-author':
      _openAuthor = id;
      _openPostId = null;
      _openTopic = null;
      ensureAuthorProfile(id);
      render();
      break;
    case 'author-back': _openAuthor = null; render(); break;
    case 'open-follow': {
      // 关注列表行跳转：微博=进作者主页（贴吧/小红书各自 App 同名 case 处理）
      _openAuthor = id;
      _openPostId = null;
      _openTopic = null;
      ensureAuthorProfile(id);
      render();
      break;
    }
    case 'my-follows': _meFollowsOpen = !_meFollowsOpen; render(); break;
    case 'sub-open': toggleSubThread(id); render(); break;
    case 'cover-edit': {
      // 换封面：统一选图弹层 setting 档（立绘/文生图/相册+导入），读写落到作者资料档 cover 字段
      if (_ctx && id) {
        const cover = readSocialAuthorProfile('weibo', id)?.cover || '';
        openImagePickerSheet(_ctx.container, {
          mode: 'setting',
          title: `更换封面 · ${id}`,
          portraitName: id,
          crop: { ratio: 3.1, slot: `wb:${id}`, kind: 'bg', title: '封面' },
          current: cover,
          currentText: '当前封面',
          defaultText: '默认封面',
          pickTip: '设为封面',
          onPick: img => { setSocialAuthorCover('weibo', id, img.path); render(); },
          onImport: path => { setSocialAuthorCover('weibo', id, path); render(); },
          onCropAdjusted: () => render(),
          ...(cover ? { onReset: () => { setSocialAuthorCover('weibo', id, undefined); render(); } } : {}),
        });
      }
      break;
    }
    case 'open-post': _openPostId = id; resetSubThreads(); readPost('weibo', id); render(); break;
    case 'open-notify': {
      const postId = readNotification('weibo', id);
      if (postId) {
        if (findPost(postId)) _openPostId = postId;
        else toast(S('内容已删除', '此帖已焚', '此帖已焚', '此篇已焚'));
      }
      render();
      break;
    }
    case 'mark-all-read': readAllNotifications('weibo'); render(); break;
    case 'topic': _openTopic = id; _openPostId = null; _feedVisible = FEED_PAGE_SIZE; render(); break;
    case 'like': {
      // L9 成就：点赞（取消赞不计）
      if (toggleLike('weibo', id).liked) emitAch('phone_like_given', { platform: 'weibo' });
      emitPhoneEvent('ubp-phone:data-changed');
      render();
      pulseActIcon(_ctx?.container ?? null, 'like', id); // 点亮脉冲：必须在重绘之后挂（重绘会丢类）
      break;
    }
    case 'follow': {
      const scope = el.dataset.scope as 'bars' | 'weibo' | 'xhs';
      const { followed } = toggleFollow(scope || 'weibo', id);
      // L9 成就：关注/取关都发（成就侧只匹配 on:1）
      emitAch('phone_follow_changed', { platform: 'weibo', on: achFlag(followed) });
      emitPhoneEvent('ubp-phone:data-changed');
      const prof = socialSkinProfile(currentStyle());
      toast(followed
        ? S(`已关注 @${id}`, `已结交 @${id}`, `已结识 @${id}`, `已同路 @${id}`)
        : prof ? prof.unfollowToast.replace('${id}', id) : `已取消关注 @${id}`);
      // 主页内重新关注：取关时资料已清，立即补生成（重进主页场景不空荡）
      if (followed && _openAuthor === id) ensureAuthorProfile(id);
      break;
    }
    case 'del-post': {
      if (_ctx) openConfirmSheet(_ctx.container, {
        title: '删除这条微博？',
        message: '删除后无法恢复。',
        confirmLabel: '删除',
        onConfirm: () => {
          try {
            deleteUserPost('weibo', id);
            // L9 成就：长按菜单删除成功
            emitAch('phone_post_deleted', { platform: 'weibo' });
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
    case 'repost': openComposer('repost', id); break;
    case 'share': {
      const post = findPost(id);
      if (post) sharePostToChat(post);
      break;
    }
    case 'comment': openComposer('comment', id); break;
    case 'reply-c': {
      const idx = Number(el.dataset.idx || '-1');
      const post = findPost(id);
      const target = post?.comments[idx];
      if (target) openComposer('comment', id, target.name);
      break;
    }
    case 'compose-post': openComposer('post'); break;
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
      void generateSocialImage('weibo', id)
        .then(() => { emitPhoneEvent('ubp-phone:data-changed'); })
        .catch(e => toast(e instanceof Error ? e.message : String(e)))
        .finally(() => { if (_ctx) render(); });
      break;
    case 'zoom': {
      // 整帖图组（仅已生成的成品图）进统一放大页：左右可滑，重绘于当前那张
      const path = el.dataset.img || '';
      const paths = (findPost(id)?.images || []).filter(i => i.imagePath && i.imageStatus === 'ready').map(i => i.imagePath as string);
      const seq = paths.length ? paths : [path];
      openPhoneLightbox(_ctx?.container, { paths: seq, startIndex: Math.max(0, seq.indexOf(path)) });
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
  else if (field === 'compose-imgdesc') _composer.imgDesc = value;
  else if (field === 'compose-anonname') _composer.anonName = value;
  // 交互态原地更新（渲染纪律）：发送按钮解禁不整帧重绘
  const c = _composer;
  const sendable = Boolean(c.text.trim()) && (c.mode !== 'post' || !c.cameraMode || Boolean(c.imgDesc.trim()) || Boolean(c.imgPath));
  const btn = _ctx?.container.querySelector('[data-ubp-act="compose-send"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = !sendable;
}

export const weiboApp: PhoneApp = {
  id: 'weibo',
  name: '微博',
  icon: ubpIcon('weibo'),
  color: '#E6162D',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _error = '';
    _openPostId = takePendingAppTarget('weibo'); // 全局搜索 / 锁屏通知深链：直接落在该博文详情（目标不存在时渲染回落列表）
    if (_openPostId) readPost('weibo', _openPostId); // 深链=看过该帖：只清这一帖的通知未读
    _openTopic = null;
    _openAuthor = null;
    _meFollowsOpen = false;
    _composer = null;
    _feedVisible = FEED_PAGE_SIZE; // 分页重置：首屏只渲染最近10条博文
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
    // 长按委托：帖子卡/详情主卡=操作面板（分享/删除），评论/子回复=删除面板
    const unbindLongPress = bindLongPress(
      ctx.container,
      t => t.closest('[data-ubp-cidx]') || t.closest('.ubp-wb-card[data-ubp-act="open-post"], .ubp-wb-card[data-ubp-lp-post]'),
      el => {
        const cidx = el.dataset.ubpCidx;
        if (cidx !== undefined && _openPostId) openCommentDeleteSheet(_openPostId, Number(cidx));
        else openPostActionSheet(el.dataset.ubpLpPost || el.dataset.id || '');
      },
    );
    render();
    void autoGenerateSocialImages('weibo').then(() => { if (_ctx) render(); });
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
