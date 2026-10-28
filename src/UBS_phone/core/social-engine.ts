// ===== 社媒 AI 引擎：三段式管线（镜像 chat-engine，快照流模式） =====
//
// ① injectPrompts 绿灯触发 ubp_social_trigger_<id>
//    position:'none'（不发给 AI）｜should_scan:true｜once:true
//    内容=通讯录随机 N 人（四平台与求回应共享 socialTriggerContacts）
//    + 最新 1 层正文（处理后的）；
//    有待反馈互动时追加贴主名+主贴文本+现有评论+用户动作内容
//    （保证回应条目被激活，其余注入触发不了绿灯是纯噪音）。求回应请求=随机 N 人+互动内容。
// ② injectPrompts 资料块 ubp_social_dossier_<id>
//    position:'after_system'（发给 AI）｜should_scan:false｜once:true
//    内容=时间地点+纪要+发帖人档案（≤12人截断）+人物关系+最近正文+已有内容摘要（防重复）
//    +待反馈互动段（帖子全文+全部现有评论+主角动作——保证回应针对性）。
// ③ generateRaw 标准模板（全槽位 + max_chat_history 硬编码 0 + generation_id 可中止）。
//
// 触发方式：手动刷新（整版快照）+ 顶栏「求回应」（跨平台只出互动反馈——增量协议）。
// 用户动作（发帖/点赞/评论/回复/转发）本地即时生效并记入 pending（收藏=小红书本地动作不进 pending），
// 由刷新（本平台动作）或求回应（全部平台动作）消费：AI 反馈解析后合并回旧帖，pending 清单同步清空。
// 落盘：各平台滚动窗口合并（上限=共享设置 socialMaxPosts）/ 热搜、吧列表整版重写。

import { readChronicleDossierBlocks } from '../../unified-statusbar/core/chronicle-blocks';
import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { getTavernHelper, makeGenerationId, stopGenerationById } from './host-env';
import { mergeFocusPicks, mergeOneShotHint } from './extra-hint';
import { keepSpyAndPublicEntries } from './message-worldbook';
import { PhoneChatError, readAiChatHistory } from './chat-engine';
import { runPhoneRaw } from './phone-raw';
import {
  buildAuthorProfileDossier,
  buildAuthorProfileInstruction,
  buildSocialDossierText,
  buildSocialFeedbackInstruction,
  buildSocialInstruction,
  buildSocialPendingTriggerText,
  buildSocialTriggerText,
  hasAnonymousPending,
  parseAuthorProfileOutput,
  pendingInvolvedNames,
  pickFollowFocuses,
  pickRandom,
  pickSocialThemes,
  SOCIAL_DOSSIER_AUTHOR_CAP,
  socialThemePool,
  type SocialDossierArgs,
  type SocialKind,
  type SocialPendingPostContext,
} from './social-prompts';
import { buildMixedRecords, socialTimelinePosts } from './phone-timeline';
import type { PhoneStyle } from './chat-model';
import { parseSocialReply } from './social-parser';
import { commentStoryStamp, formatStampFull, normalizeStoryTimeLabel, postStoryStamp } from './social-time';
import {
  appendSocialComments,
  addSocialNotifications,
  deleteUserPosts,
  makeSocialActionId,
  makeSocialNotificationId,
  makeSocialPostId,
  markAllSocialNotificationsRead,
  markSocialNotificationsForPost,
  postNotificationsOf,
  MAX_FOLLOWS_PER_SCOPE,
  mergeFollowsWithSnapshot,
  mergeMomentFeedback,
  mergeMomentPosts,
  mergeScrollPosts,
  mergeTiebaFeedback,
  mergeWeiboFeedback,
  mergeXhsFeedback,
  readSocialOf,
  removeCommentThread,
  replaceBars,
  replaceTrending,
  socialAuthorProfileKey,
  socialExcerpt,
  socialFollowKeepIds,
  socialNotificationUnread,
  socialNotificationsOf,
  socialPostNotificationUnread,
  stampFeedbackComment,
  tiebaMatchesKeyword,
  upsertSocialAuthorProfile,
  weiboMatchesTopic,
  xhsMatchesTopic,
  MAX_PENDING_ACTIONS,
  MAX_MOMENT_LIKES,
  resolveAnonName as resolveAnonNameOf,
  type MomentPost,
  type SocialAuthorProfile,
  type SocialComment,
  type SocialData,
  type SocialFeedback,
  type SocialFollows,
  type SocialNotification,
  type SocialUserAction,
  type TiebaPost,
  type TrendingItem,
  type WeiboPost,
  type XhsNote,
} from './social-model';
import { currentPhoneStorageId, mutatePhoneData, readPhoneData, readPhoneDataRef } from './phone-store';
import { getPhoneSettings } from './phone-settings';
import { validatePhoneApi } from './phone-api';
import { getRoster, type RosterSnapshot } from './roster';

export type { SocialKind, SocialActionType } from './social-model';

export interface SocialRefreshResult {
  raw: string;
  /** 落盘后的社媒域（快照深拷贝）。 */
  moments: MomentPost[];
  tieba: TiebaPost[];
  weibo: WeiboPost[];
  xhs: XhsNote[];
  trending: TrendingItem[];
}

/** 平台滚动窗口上限（四平台共享 socialMaxPosts）。 */
function maxPostsOf(_kind: SocialKind): number {
  return getPhoneSettings().socialMaxPosts;
}

/** 绿灯触发随机通讯录人数（四平台与求回应共享 socialTriggerContacts）。 */
function triggerContactsOf(_kind: SocialKind | 'feedback'): number {
  return getPhoneSettings().socialTriggerContacts;
}

/** 当前进行中的社媒 generation id 集合（终止用；与聊天/通话生成独立计数）。 */
const _activeGenerations = new Set<string>();
/** 生成中标记（按 kind 互斥：同平台生成中再点刷新直接拒绝）。 */
const _busyKinds = new Set<SocialKind>();
/** 求回应生成中（跨平台请求，与刷新互斥）。 */
let _feedbackBusy = false;

/** 终止当前全部小手机社媒生成。返回是否有请求被终止。 */
export function abortSocialGeneration(): boolean {
  let stopped = false;
  for (const id of _activeGenerations) {
    if (stopGenerationById(id)) stopped = true;
  }
  _activeGenerations.clear();
  return stopped;
}

/** 是否正在生成互动反馈。 */
export function isFeedbackGenerating(): boolean {
  return _feedbackBusy;
}

// ─── 用户动作（本地即时生效 + 记入待反馈清单） ───

function myStoryTime(roster: RosterSnapshot): string {
  return roster.global.time || '刚刚';
}

/** 故事时间标签 → 规范绝对时间戳（解析失败 undefined，显示/注入侧回退原文）。 */
function storyStampOf(label: string, anchor: string): string | undefined {
  return normalizeStoryTimeLabel(label, anchor) || undefined;
}

/** 帖子盖规范绝对故事时间戳（落盘口径；timeLabel/storyTime 原文保留兜底）。 */
function stampPost<T extends { timeLabel: string; storyStamp?: string }>(post: T, anchor: string): T {
  const stamp = storyStampOf(post.timeLabel, anchor);
  return stamp ? { ...post, storyStamp: stamp } : post;
}

function recordPendingActions(actions: SocialUserAction[]): void {
  mutatePhoneData(d => {
    const cur = d.social || { moments: [], tieba: [], weibo: [], xhs: [], bars: [], trending: [], refreshedAt: 0, pending: [] };
    cur.pending = [...(cur.pending || []), ...actions].slice(0, MAX_PENDING_ACTIONS);
    d.social = cur;
  });
}

/**
 * 匿名发言的显示名（空=默认「匿名用户」）。**禁与主角/通讯录角色重名**——匿名帖的归属全靠
 * 作者名比对（「（我）」标记、混合记录认领、反馈回复指向），重名会当场冒充成那个角色。
 */
function resolveAnonName(raw: string | undefined, roster: RosterSnapshot): string {
  const { name, conflict } = resolveAnonNameOf(raw, [roster.protagonistName, ...roster.contacts.map(c => c.name)]);
  if (conflict) throw new PhoneChatError('env', '匿名名不能与已有角色重名');
  return name;
}

/** 用户发帖（朋友圈动态/贴吧帖子/微博博文/小红书笔记；附图走微信聊天同款：拍照生图 or 相册选图）。 */
export function createUserPost(args: {
  kind: SocialKind;
  /** 朋友圈=动态正文；贴吧/小红书=正文；微博=博文正文。 */
  text: string;
  /** 贴吧/小红书标题。 */
  title?: string;
  /** 贴吧吧名（缺省取已生成吧列表第一个或「灌水吧」）。 */
  bar?: string;
  /** 小红书话题标签。 */
  tags?: string[];
  /** 微博转发（转发目标帖 id；本地生成带转发卡的博文 + 待反馈记录挂原帖）。 */
  repostOfId?: string;
  imagePath?: string;
  imageDesc?: string;
  /** 匿名发布（true=以匿名账号发出，作者名取 anonName 或默认「匿名用户」；匿名内容不计入主角发言）。 */
  anon?: boolean;
  /** 自定义匿名网名（缺省「匿名用户」；禁与主角/通讯录角色重名）。 */
  anonName?: string;
}): { postId: string } {
  const roster = getRoster();
  const me = roster.protagonistName;
  const time = myStoryTime(roster);
  const stamp = storyStampOf(time, roster.global.time);
  const text = args.text.trim();
  if (!text) throw new PhoneChatError('env', '内容不能为空');
  if ((args.kind === 'tieba' || args.kind === 'xhs') && !(args.title || '').trim()) throw new PhoneChatError('env', '标题不能为空');
  const postId = makeSocialPostId();
  const imageDesc = (args.imageDesc || '').trim();
  const anonName = args.anon ? resolveAnonName(args.anonName, roster) : '';
  const author = anonName || me;
  const anonFlag = anonName ? { anon: true as const } : {};

  // 微博转发：本地新增一条带转发卡的博文，待反馈动作挂原帖（原博主/评论者回应）
  if (args.kind === 'weibo' && args.repostOfId) {
    const original = readSocialOf(readPhoneData()).weibo.find(p => p.id === args.repostOfId);
    if (!original) throw new PhoneChatError('env', '原微博不存在或已沉底');
    mutatePhoneData(d => {
      const cur = d.social;
      if (!cur) return;
      const target = cur.weibo.find(p => p.id === args.repostOfId);
      if (!target) return;
      target.repostedByMe = true;
      const mine: WeiboPost = {
        id: postId,
        author,
        ...anonFlag,
        text: text.slice(0, 600),
        images: [],
        repost: { author: target.author, text: target.text.slice(0, 200), ...(target.images[0]?.desc ? { imageDesc: target.images[0].desc } : {}) },
        forwards: 1,
        commentsCount: 0,
        likes: 0,
        comments: [],
        timeLabel: time,
        storyTime: roster.global.time || undefined,
        ...(stamp ? { storyStamp: stamp } : {}),
        createdAt: Date.now(),
      };
      cur.weibo = mergeScrollPosts(cur.weibo, [mine], maxPostsOf('weibo'));
    });
    recordPendingActions([{
      id: makeSocialActionId(),
      type: 'repost',
      target: 'weibo',
      postId: args.repostOfId,
      author: original.author,
      content: text.slice(0, 400),
      ...(anonName ? { anon: anonName } : {}),
      time,
      ...(stamp ? { storyStamp: stamp } : {}),
      createdAt: Date.now(),
    }]);
    return { postId };
  }

  mutatePhoneData(d => {
    const cur: SocialData = d.social || { moments: [], tieba: [], weibo: [], xhs: [], bars: [], trending: [], refreshedAt: 0, pending: [] };
    if (args.kind === 'moments') {
      const post: MomentPost = {
        id: postId,
        author,
        ...anonFlag,
        text: text.slice(0, 400),
        imageDesc,
        likes: [],
        comments: [],
        timeLabel: time,
        storyTime: roster.global.time || undefined,
        ...(stamp ? { storyStamp: stamp } : {}),
        createdAt: Date.now(),
      };
      if (args.imagePath) { post.imagePath = args.imagePath; post.imageStatus = 'ready'; }
      cur.moments = mergeMomentPosts(cur.moments, [post], getPhoneSettings().socialMaxPosts);
    } else if (args.kind === 'tieba') {
      const post: TiebaPost = {
        id: postId,
        bar: (args.bar || cur.bars[0]?.name || '灌水吧').slice(0, 24),
        pinned: false,
        title: (args.title || '').trim().slice(0, 80),
        content: text.slice(0, 1200),
        author,
        ...anonFlag,
        views: 1,
        replies: 0,
        likes: 0,
        imageDesc,
        comments: [],
        timeLabel: time,
        storyTime: roster.global.time || undefined,
        ...(stamp ? { storyStamp: stamp } : {}),
        createdAt: Date.now(),
      };
      if (args.imagePath) { post.imagePath = args.imagePath; post.imageStatus = 'ready'; }
      cur.tieba = mergeScrollPosts(cur.tieba, [post], maxPostsOf('tieba'));
    } else if (args.kind === 'weibo') {
      const post: WeiboPost = {
        id: postId,
        author,
        ...anonFlag,
        text: text.slice(0, 600),
        images: args.imagePath ? [{ desc: imageDesc, imagePath: args.imagePath, imageStatus: 'ready' }] : [],
        forwards: 0,
        commentsCount: 0,
        likes: 0,
        comments: [],
        timeLabel: time,
        storyTime: roster.global.time || undefined,
        ...(stamp ? { storyStamp: stamp } : {}),
        createdAt: Date.now(),
      };
      cur.weibo = mergeScrollPosts(cur.weibo, [post], maxPostsOf('weibo'));
    } else {
      const note: XhsNote = {
        id: postId,
        title: (args.title || '').trim().slice(0, 40),
        content: text.slice(0, 1200),
        tags: (args.tags || []).slice(0, 6),
        author,
        ...anonFlag,
        imageDesc,
        likes: 0,
        collects: 0,
        comments: [],
        timeLabel: time,
        storyTime: roster.global.time || undefined,
        ...(stamp ? { storyStamp: stamp } : {}),
        createdAt: Date.now(),
      };
      if (args.imagePath) { note.imagePath = args.imagePath; note.imageStatus = 'ready'; }
      cur.xhs = mergeScrollPosts(cur.xhs, [note], maxPostsOf('xhs'));
    }
    d.social = cur;
  });
  const titlePrefix = args.title?.trim() ? `${args.title.trim()}：` : '';
  recordPendingActions([{
    id: makeSocialActionId(),
    type: 'post',
    target: args.kind,
    postId,
    author,
    content: `${titlePrefix}${text}`.slice(0, 400),
    ...(anonName ? { anon: anonName } : {}),
    ...(imageDesc ? { imageDesc } : {}),
    time,
    ...(stamp ? { storyStamp: stamp } : {}),
    createdAt: Date.now(),
  }]);
  return { postId };
}

/** 点赞/取消点赞（朋友圈=名单增删主角名；贴吧/微博/小红书=计数±1+likedByMe）。撤销同时移除待反馈记录。 */
export function toggleLike(kind: SocialKind, postId: string): { liked: boolean } {
  const roster = getRoster();
  const me = roster.protagonistName;
  const time = myStoryTime(roster);
  const stamp = storyStampOf(time, roster.global.time);
  let liked = false;
  let author = '';
  mutatePhoneData(d => {
    const cur = d.social;
    if (!cur) return;
    if (kind === 'moments') {
      const post = cur.moments.find(p => p.id === postId);
      if (!post) return;
      author = post.author;
      const has = post.likes.includes(me);
      liked = !has;
      post.likes = has ? post.likes.filter(n => n !== me) : [...post.likes, me].slice(0, MAX_MOMENT_LIKES);
    } else if (kind === 'tieba') {
      const post = cur.tieba.find(p => p.id === postId);
      if (!post) return;
      author = post.author;
      liked = !post.likedByMe;
      post.likes = Math.max(0, post.likes + (liked ? 1 : -1));
      post.likedByMe = liked || undefined;
    } else if (kind === 'weibo') {
      const post = cur.weibo.find(p => p.id === postId);
      if (!post) return;
      author = post.author;
      liked = !post.likedByMe;
      post.likes = Math.max(0, post.likes + (liked ? 1 : -1));
      post.likedByMe = liked || undefined;
    } else {
      const note = cur.xhs.find(n => n.id === postId);
      if (!note) return;
      author = note.author;
      liked = !note.likedByMe;
      note.likes = Math.max(0, note.likes + (liked ? 1 : -1));
      note.likedByMe = liked || undefined;
    }
  });
  if (!author) return { liked: false };
  if (liked) {
    recordPendingActions([{
      id: makeSocialActionId(),
      type: 'like',
      target: kind,
      postId,
      author,
      content: '',
      time,
      ...(stamp ? { storyStamp: stamp } : {}),
      createdAt: Date.now(),
    }]);
  } else {
    // 取消赞：撤销对应的待反馈记录
    mutatePhoneData(d => {
      if (d.social?.pending) {
        d.social.pending = d.social.pending.filter(a => !(a.target === kind && a.postId === postId && a.type === 'like'));
      }
    });
  }
  return { liked };
}

/** 小红书收藏/取消收藏（码住文化）：本地计数±1+collectedByMe；收藏是无声动作，不进待反馈。 */
export function toggleCollect(noteId: string): { collected: boolean } {
  let collected = false;
  mutatePhoneData(d => {
    const note = d.social?.xhs.find(n => n.id === noteId);
    if (!note) return;
    collected = !note.collectedByMe;
    note.collects = Math.max(0, note.collects + (collected ? 1 : -1));
    note.collectedByMe = collected || undefined;
  });
  return { collected };
}

/** 关注域（贴吧吧/微博博主/小红书作者——名字锚定的本地关注，零 AI）。 */
export type SocialFollowScope = keyof SocialFollows;

/** 关注/取关（本地即时生效；整版刷新重写内容后按名保留，无 AI 反馈）。
 *  取关同步清理：删该作者的主页资料缓存（无意义残留不堆积）；其帖子自此移出滚动淘汰例外区
 *  （keepIds 每次落盘按当前 follows 重算，无需额外清理）。 */
export function toggleFollow(scope: SocialFollowScope, name: string): { followed: boolean } {
  const key = name.trim().slice(0, 40);
  if (!key) return { followed: false };
  let followed = false;
  mutatePhoneData(d => {
    const cur = d.social;
    if (!cur) return;
    const follows: SocialFollows = cur.follows || { bars: [], weibo: [], xhs: [] };
    const list = follows[scope];
    const idx = list.indexOf(key);
    if (idx >= 0) {
      list.splice(idx, 1);
      followed = false;
      // 取关清理：删主页资料缓存（仅微博/小红书域有资料；空表还原为无形状不占存储）
      if (scope === 'weibo' || scope === 'xhs') {
        if (cur.authorProfiles) {
          delete cur.authorProfiles[socialAuthorProfileKey(scope, key)];
          if (!Object.keys(cur.authorProfiles).length) cur.authorProfiles = undefined;
        }
      }
    } else {
      list.push(key);
      if (list.length > MAX_FOLLOWS_PER_SCOPE) list.splice(0, list.length - MAX_FOLLOWS_PER_SCOPE);
      followed = true;
    }
    follows[scope] = list;
    cur.follows = mergeFollowsWithSnapshot(follows);
    d.social = cur;
  });
  return { followed };
}

/** 当前关注集合（空域安全读）。P1：走零拷贝引用——原先这个「看起来是浅读」的函数内部是完整的
 *  readPhoneData()（整机深拷贝），而社媒三 App 每次渲染都调它 ⇒ 每帧白付一份整机拷贝。 */
export function readSocialFollows(): SocialFollows {
  return readSocialOf(readPhoneDataRef()).follows || { bars: [], weibo: [], xhs: [] };
}

// ─── 作者主页资料（1B 型轻量生成：绿灯触发=作者名扫描世界书；资料块=含名纪要+路人帖摘要；一次生成后缓存） ───

let _authorBusy = false;

/** 读缓存的作者主页资料（无则 null——调用方触发生成并降级渲染）。P1：零拷贝引用读。 */
export function readSocialAuthorProfile(scope: 'weibo' | 'xhs', name: string): SocialAuthorProfile | null {
  return readSocialOf(readPhoneDataRef()).authorProfiles?.[socialAuthorProfileKey(scope, name)] || null;
}

/** 设置/清除作者主页封面（换封面弹层写入口；无资料时先落最小档案——纯本地零 AI）。 */
export function setSocialAuthorCover(scope: 'weibo' | 'xhs', name: string, cover?: string): void {
  const path = cover?.trim();
  mutatePhoneData(d => {
    const cur = readSocialOf(d);
    const existing = cur.authorProfiles?.[socialAuthorProfileKey(scope, name)];
    if (path) {
      upsertSocialAuthorProfile(cur, existing
        ? { ...existing, cover: path }
        : { scope, name, signature: '', following: '', followers: '', likes: '', cover: path, createdAt: Date.now() });
    } else if (existing) {
      const next = { ...existing };
      delete next.cover;
      upsertSocialAuthorProfile(cur, next);
    }
    d.social = cur;
  });
}

/** 作者资料是否生成中（同请求互斥；骨架屏判断用）。 */
export function isAuthorProfileGenerating(): boolean {
  return _authorBusy;
}

/**
 * 生成作者主页资料：触发文本=作者名（扫描激活所有名字命中的世界书条目，含 [UBS手机] 消息记录条目），
 * 资料块=含名纪要（summaryCount 口径）+当前时间地点，路人以已有帖摘要兜底；解析后写缓存。
 * 生成中重复调用返回 null（静默）；失败抛 PhoneChatError（调用方降级为本地兜底渲染）。
 */
export async function runAuthorProfileGeneration(scope: 'weibo' | 'xhs', name: string, rosterOverride?: RosterSnapshot): Promise<SocialAuthorProfile | null> {
  if (_authorBusy) return null;
  assertPhoneReady();
  const settings = getPhoneSettings();
  const roster = rosterOverride ?? getRoster();
  const contactNames = roster.contacts.map(c => c.name);
  _authorBusy = true;
  try {
    const isContact = contactNames.includes(name);
    const chronicleBlocks = isContact ? readChronicleDossierBlocks([name], settings.summaryCount) : '';
    const social = readSocialOf(readPhoneData());
    const ownPosts = scope === 'weibo' ? social.weibo.filter(p => p.author === name) : social.xhs.filter(n => n.author === name);
    const excerpt = ownPosts.slice(0, 5).map(p => `· ${socialExcerpt(scope === 'weibo' ? (p as WeiboPost).text : (p as XhsNote).title, 40)}`).join('\n');
    const raw = await generateSocialRaw({
      triggerId: `ubp_social_trigger_author_${scope}`,
      dossierId: `ubp_social_dossier_author_${scope}`,
      triggerText: name,
      dossierText: buildAuthorProfileDossier({ roster, chronicleBlocks, ...(excerpt ? { excerpt } : {}) }),
      instruction: buildAuthorProfileInstruction({ roster, scope, name, style: readPhoneData().style || '' }),
      activityLabel: '作者资料',
      activityAppId: 'moments',
    });
    const parsedProfile = parseAuthorProfileOutput(String(raw || ''));
    if (!parsedProfile) throw new PhoneChatError('parse', '生成资料无法解析');
    const profile: SocialAuthorProfile = { scope, name, ...parsedProfile, createdAt: Date.now() };
    mutatePhoneData(d => {
      const cur = readSocialOf(d);
      // AI 重生成整档覆盖：用户手选封面不随重生成丢失（取关清档语义不受影响）
      const existingCover = cur.authorProfiles?.[socialAuthorProfileKey(scope, name)]?.cover;
      upsertSocialAuthorProfile(cur, existingCover ? { ...profile, cover: existingCover } : profile);
      d.social = cur;
    });
    return profile;
  } finally {
    _authorBusy = false;
  }
}

/** 删除帖子（任意作者的帖子/动态/博文/笔记皆可删；连带给该帖记的待反馈动作与通知一起作废）。 */
export function deleteUserPost(kind: SocialKind, postId: string): void {
  let removed = false;
  mutatePhoneData(d => {
    if (!d.social) return;
    const pool = kind === 'tieba' ? d.social.tieba : kind === 'weibo' ? d.social.weibo : kind === 'xhs' ? d.social.xhs : d.social.moments;
    if (!pool.some(p => p.id === postId)) return;
    d.social = deleteUserPosts(d.social, kind, [postId]);
    removed = true;
  });
  if (!removed) throw new PhoneChatError('env', '帖子不存在或已沉底');
}

/** 手动添加贴吧（进吧页 + 号；重名不重复加；custom 标记跨整版刷新存活）。 */
export function addTiebaBar(name: string): boolean {
  const key = name.trim().slice(0, 24);
  if (!key) return false;
  let added = false;
  mutatePhoneData(d => {
    const cur = readSocialOf(d);
    if (cur.bars.some(b => b.name === key)) return;
    cur.bars = replaceBars([{ name: key, members: '1', posts: '0', custom: true }, ...cur.bars]);
    d.social = cur;
    added = true;
  });
  return added;
}

/** 删除贴吧（进吧页长按；吧条目+该吧全部帖子+待反馈/通知连带作废+关注列表剔除）。 */
export function deleteTiebaBar(name: string): void {
  mutatePhoneData(d => {
    if (!d.social) return;
    const cur = d.social;
    const ids = cur.tieba.filter(p => p.bar === name).map(p => p.id);
    if (cur.bars.length) cur.bars = cur.bars.filter(b => b.name !== name);
    if (cur.follows?.bars?.includes(name)) {
      cur.follows.bars = cur.follows.bars.filter(n => n !== name);
    }
    d.social = deleteUserPosts(cur, 'tieba', ids);
  });
}

/**
 * 删除一条评论/回复（其楼中楼子回复按名字指针链一并删除）。
 * 连带清理：微博评论计数回退；待反馈清单里同帖同文的用户评论动作作废（防 AI 回应已删内容）；
 * 通知流里指向该评论的条目一并移除。
 */
export function deleteSocialComment(kind: SocialKind, postId: string, index: number): void {
  let removed = 0;
  mutatePhoneData(d => {
    if (!d.social) return;
    const pool = kind === 'tieba' ? d.social.tieba : kind === 'weibo' ? d.social.weibo : kind === 'xhs' ? d.social.xhs : d.social.moments;
    const post = pool.find(p => p.id === postId);
    if (!post || !post.comments[index]) return;
    const target = post.comments[index];
    const next = removeCommentThread(post.comments, index);
    removed = post.comments.length - next.length;
    post.comments = next;
    if (kind === 'weibo') (post as { commentsCount: number }).commentsCount = Math.max(0, (post as { commentsCount: number }).commentsCount - removed);
    if (d.social.pending?.length) {
      d.social.pending = d.social.pending.filter(a => !((a.type === 'comment' || a.type === 'reply') && a.target === kind && a.postId === postId && a.content === target.text));
    }
    if (d.social.notifications?.length) {
      // 通知 content 存的是 socialExcerpt(text, 40) 截断文（feedbackNotificationsOf 落盘口径），按同口径匹配
      d.social.notifications = d.social.notifications.filter(n => !((n.type === 'comment' || n.type === 'reply') && n.kind === kind && n.postId === postId && n.author === target.name && n.content === socialExcerpt(target.text, 40)));
    }
  });
  if (!removed) throw new PhoneChatError('env', '评论不存在或已删除');
}

/** 用户评论/回复（本地即时上屏 + 记入待反馈；回复自动记为 reply 类型；可选匿名网名）。 */
export function addSocialComment(args: { kind: SocialKind; postId: string; text: string; replyTo?: string; anon?: boolean; anonName?: string }): void {
  const roster = getRoster();
  const me = roster.protagonistName;
  const time = myStoryTime(roster);
  const stamp = storyStampOf(time, roster.global.time);
  const text = args.text.trim();
  if (!text) throw new PhoneChatError('env', '评论内容不能为空');
  const anonName = args.anon ? resolveAnonName(args.anonName, roster) : '';
  const comment: SocialComment = {
    name: anonName || me,
    text: text.slice(0, 400),
    ...(anonName ? { anon: true as const } : {}),
    time,
    ...(stamp ? { storyStamp: stamp } : {}),
  };
  if (args.replyTo) (comment as { replyTo?: string }).replyTo = args.replyTo;
  let author = '';
  mutatePhoneData(d => {
    const cur = d.social;
    if (!cur) return;
    if (args.kind === 'moments') {
      const found = cur.moments.find(p => p.id === args.postId);
      if (found) { author = found.author; found.comments = appendSocialComments(found.comments, [comment], me); }
    } else if (args.kind === 'tieba') {
      const found = cur.tieba.find(p => p.id === args.postId);
      if (found) { author = found.author; found.comments = appendSocialComments(found.comments, [comment], me); }
    } else if (args.kind === 'weibo') {
      const found = cur.weibo.find(p => p.id === args.postId);
      if (found) { author = found.author; found.comments = appendSocialComments(found.comments, [comment], me); found.commentsCount += 1; }
    } else {
      const found = cur.xhs.find(p => p.id === args.postId);
      if (found) { author = found.author; found.comments = appendSocialComments(found.comments, [comment], me); }
    }
  });
  if (!author) throw new PhoneChatError('env', '帖子不存在或已沉底');
  recordPendingActions([{
    id: makeSocialActionId(),
    type: args.replyTo ? 'reply' : 'comment',
    target: args.kind,
    postId: args.postId,
    author,
    content: text.slice(0, 400),
    ...(anonName ? { anon: anonName } : {}),
    ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    time,
    ...(stamp ? { storyStamp: stamp } : {}),
    createdAt: Date.now(),
  }]);
}

/** 全部待反馈动作（跨平台；UI 徽标与求回应按钮用）。
 *  social 传入=用调用方本帧已取的快照（渲染层帧级一次纪律，免二次全量深拷贝）；
 *  不传=自行读库（事件回调等非帧内场景）。null=无社媒域（返回空）。 */
export function getPendingActions(social?: SocialData | null): SocialUserAction[] {
  const s = social === undefined ? readSocialOf(readPhoneData()) : social;
  return s?.pending || [];
}

/** 待反馈动作的零拷贝读口（渲染帧专用）：直读 store 引用，不深拷贝（纪律见 phone-store.readPhoneDataRef）。 */
export function readPendingActionsRef(): SocialUserAction[] {
  return readPhoneDataRef().social?.pending || [];
}

/** 打开消息页即已读的平台语义见 `markAllNotificationsRead`；朋友圈无消息页，App mount 直接调它整平台已读。 */

// ─── 消息页通知生成（刷新/求回应落盘点；朋友圈无消息页不生成） ───

/** 平台内找帖（通知生成对照合并前评论区用）。 */
function socialPostOf(social: SocialData, kind: SocialKind, postId: string): MomentPost | TiebaPost | WeiboPost | XhsNote | undefined {
  if (kind === 'moments') return social.moments.find(p => p.id === postId);
  if (kind === 'tieba') return social.tieba.find(p => p.id === postId);
  if (kind === 'weibo') return social.weibo.find(p => p.id === postId);
  return social.xhs.find(p => p.id === postId);
}

/** 关注对象新帖判定与「新帖 → 通知」的构造统一在 `core/social-model`（postNotificationsOf），
 *  世界演化投递与此处共用同一份映射，避免两处漂移。 */

/**
 * 反馈评论 → 与我相关互动通知（四平台同构，含朋友圈）：
 * 回复我的评论（replyTo=主角）→ reply；我帖子上的新评论 → comment。
 * 只对实际会合并成功的新评论生成（同「名+文」与 appendSocialComments 同判据，防重复计数）。
 * 朋友圈无消息页，但互动同样入 Unread 流：看信息流即整平台已读（真机朋友圈红点语义）。
 */
function feedbackNotificationsOf(kind: SocialKind, feedbacks: SocialFeedback[], social: SocialData, me: string, anchor: string): SocialNotification[] {
  const out: SocialNotification[] = [];
  for (const fb of feedbacks) {
    if (fb.target !== kind) continue;
    const post = socialPostOf(social, kind, fb.postId);
    if (!post) continue;
    for (const c of fb.comments) {
      if (post.comments.some(c0 => c0.name === c.name && c0.text === c.text)) continue;
      // 匿名帖的回应也算「回我」：帖主不是主角名，按帖子自身作者名判回复指向
      const isReply = c.replyTo === me || (Boolean(post.anon) && c.replyTo === post.author);
      if (!isReply && post.author !== me && !post.anon) continue;
      out.push({
        id: makeSocialNotificationId(),
        kind,
        type: isReply ? 'reply' : 'comment',
        postId: fb.postId,
        author: c.name,
        content: socialExcerpt(c.text, 40),
        time: (c.time || '').trim(),
        ...(stampFeedbackComment(c, anchor).storyStamp ? { storyStamp: stampFeedbackComment(c, anchor).storyStamp } : {}),
        createdAt: Date.now(),
      });
    }
  }
  return out;
}

/** 平台通知流（消息页渲染用）。
 *  social 传入=用调用方本帧已取的快照（帧级一次纪律）；不传=自行读库。 */
export function getSocialNotifications(kind: SocialKind, social?: SocialData | null): SocialNotification[] {
  const s = social === undefined ? readSocialOf(readPhoneData()) : social;
  return socialNotificationsOf(s, kind);
}

/** 平台未读通知数（tab 徽标便捷口；渲染帧已有快照时优先用纯函数 socialNotificationUnread）。 */
export function getSocialNotificationUnread(kind: SocialKind): number {
  return socialNotificationUnread(readPhoneDataRef().social, kind);
}

/** 打开帖子详情 → 该帖通知全部已读（任何入口统一钩子；无未读零写盘）。 */
export function markNotificationsReadForPost(kind: SocialKind, postId: string): void {
  if (!socialPostNotificationUnread(readPhoneDataRef().social, kind, postId)) return;
  mutatePhoneData(d => {
    markSocialNotificationsForPost(readSocialOf(d), kind, postId);
  });
}

/** 消息页「全部已读」（清本平台；无未读零写盘）。 */
export function markAllNotificationsRead(kind: SocialKind): void {
  if (!socialNotificationUnread(readPhoneDataRef().social, kind)) return;
  mutatePhoneData(d => {
    markAllSocialNotificationsRead(readSocialOf(d), kind);
  });
}

/** 消息页点击通知：该帖关联通知全部已读，返回帖子 id 供跳详情（通知不存在返回 null；帖子沉底也标已读）。 */
export function openSocialNotification(kind: SocialKind, notificationId: string): string | null {
  const target = getSocialNotifications(kind).find(n => n.id === notificationId);
  if (!target) return null;
  markNotificationsReadForPost(kind, target.postId);
  return target.postId;
}

// ─── 待反馈上下文（动作 → 帖子全文/现有评论；沉底帖动作判 stale 丢弃） ───

function postTextOf(kind: SocialKind, post: MomentPost | TiebaPost | WeiboPost | XhsNote): string {
  if (kind === 'moments') return (post as MomentPost).text;
  if (kind === 'tieba') { const p = post as TiebaPost; return `${p.title}：${p.content}`; }
  if (kind === 'weibo') {
    const p = post as WeiboPost;
    const repost = p.repost ? `（转发 @${p.repost.author}：${p.repost.text}）` : '';
    return `${p.text}${repost}`;
  }
  const n = post as XhsNote;
  return `${n.title}：${n.content}`;
}

function buildPendingContexts(actions: SocialUserAction[], social: SocialData): {
  contexts: SocialPendingPostContext[];
  consumedIds: string[];
  staleIds: string[];
} {
  const byPost = new Map<string, SocialUserAction[]>();
  for (const a of actions) {
    const list = byPost.get(a.postId) || [];
    list.push(a);
    byPost.set(a.postId, list);
  }
  const contexts: SocialPendingPostContext[] = [];
  const consumedIds: string[] = [];
  const staleIds: string[] = [];
  for (const [postId, acts] of byPost) {
    const first = acts[0];
    const kind = first.target;
    let found: MomentPost | TiebaPost | WeiboPost | XhsNote | undefined;
    if (kind === 'moments') found = social.moments.find(p => p.id === postId);
    else if (kind === 'tieba') found = social.tieba.find(p => p.id === postId);
    else if (kind === 'weibo') found = social.weibo.find(p => p.id === postId);
    else found = social.xhs.find(p => p.id === postId);
    if (!found) { staleIds.push(...acts.map(a => a.id)); continue; }
    const imageDesc = kind === 'weibo' ? (found as WeiboPost).images[0]?.desc : (found as MomentPost | TiebaPost | XhsNote).imageDesc;
    // 时间纪律（用户定案）：待反馈段一律绝对故事时间——主贴时间取规范戳全文；现有评论的 time 升级为绝对全文
    // （触发段只取文本不受影响）；解析失败回退原文标签。
    contexts.push({
      target: kind,
      postId,
      author: found.author,
      ...(found.anon ? { anon: true as const } : {}),
      postTime: formatStampFull(postStoryStamp(found)) || found.timeLabel,
      postText: postTextOf(kind, found),
      ...(imageDesc ? { imageDesc } : {}),
      comments: found.comments.map(c => {
        const stamp = commentStoryStamp(c, found);
        return stamp ? { ...c, time: formatStampFull(stamp) } : c;
      }),
      actions: acts,
    });
    consumedIds.push(...acts.map(a => a.id));
  }
  return { contexts, consumedIds, staleIds };
}

function dropPendingActions(removeIds: string[]): void {
  if (!removeIds.length) return;
  const ids = new Set(removeIds);
  mutatePhoneData(d => {
    if (!d.social) return;
    const remaining = (d.social.pending || []).filter(a => !ids.has(a.id));
    if (remaining.length) d.social.pending = remaining;
    else delete d.social.pending;
  });
}

/**
 * 涉及互动反馈时构建「最近手机记录」混合块（用户定案）：服务对象=本次反馈涉及人物并集
 * （贴主+被回复者；主角发帖动作=通讯录随机 3 人）；排除待反馈的帖子——该帖全文
 * 已在「待反馈的用户互动」段单独呈现，防重复携带。纯刷新（无待反馈）不注入。
 */
function buildFeedbackMixedRecords(
  contexts: SocialPendingPostContext[],
  phoneData: ReturnType<typeof readPhoneData>,
  social: SocialData,
  authors: string[],
  me: string,
  count: number,
): { names: string[]; records: ReturnType<typeof buildMixedRecords> } | undefined {
  const names = pendingInvolvedNames(contexts, authors, me);
  if (!names.length) return undefined;
  const records = buildMixedRecords({
    names,
    conversations: phoneData.conversations.filter(c => c.kind === 'private' && names.includes(c.members[0])),
    groupConversations: phoneData.conversations.filter(c => c.kind === 'group' && names.some(n => c.members.includes(n))),
    calls: phoneData.calls || [],
    moments: social.moments,
    socialPosts: socialTimelinePosts(social),
    me,
    count,
    excludeCallId: undefined,
    excludePostIds: contexts.map(c => c.postId),
    style: phoneData.style || '',
  });
  return { names, records };
}

// ─── 共享生成段（① 触发注入 + ② 资料块注入 + ③ 裸生成） ───

async function generateSocialRaw(args: {
  triggerId: string;
  dossierId: string;
  triggerText: string;
  dossierText: string;
  instruction: string;
  /** 统一 AI 活动标签（作者资料 / 朋友圈刷新 / 互动回应 …）。 */
  activityLabel?: string;
  activityAppId?: string;
}): Promise<string> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  // ①② 一次性注入：once:true 只在下一次请求生成中有效 → 交给 runPhoneRaw 的 prepare 每次尝试前重跑
  const prepare = async () => {
  // ① 绿灯触发注入（不进提示词，只参与世界书扫描；空文本跳过）
  if (args.triggerText.trim()) {
    await th.injectPrompts([{
      id: args.triggerId,
      position: 'none',
      depth: 0,
      role: 'system',
      content: args.triggerText,
      should_scan: true,
    }], { once: true });
  }
  // ② 资料块注入（发给 AI，不参与扫描）
  await th.injectPrompts([{
    id: args.dossierId,
    position: 'after_system',
    depth: 0,
    role: 'system',
    content: args.dossierText,
    should_scan: false,
  }], { once: true });
  };

  // ③ 裸生成（指令模板先做宏替换）
  const instruction = th.substitudeMacros ? th.substitudeMacros(args.instruction) : args.instruction;
  const generationId = makeGenerationId('ubp-social');
  _activeGenerations.add(generationId);
  try {
    // 扫描前剔除纪要自投影 + [UBS手机] 前缀条目按族 keep 豁免（keep 放行窥私记录族+公共舆论条目：
    // 发帖角色的角色间历史供其言行连贯、公共话题人人可知；消息记录族照旧剔除——资料块已自带）
    return await runPhoneRaw({
      scope: 'social',
      instruction,
      generationId,
      keep: keepSpyAndPublicEntries,
      prepare,
      activity: {
        feature: args.activityLabel || '社媒刷新',
        label: args.activityLabel || '社媒刷新',
        appId: args.activityAppId || 'moments',
        tone: 'ai',
        onCancel: () => { abortSocialGeneration(); },
      },
    });
  } finally {
    _activeGenerations.delete(generationId);
  }
}

function assertPhoneReady(): void {
  const apiError = validatePhoneApi('social');
  if (apiError) {
    throw new PhoneChatError('api', apiError);
  }
}

const KIND_LABELS: Record<SocialKind, string> = {
  moments: '朋友圈',
  tieba: '贴吧',
  weibo: '微博',
  xhs: '小红书',
};

// ─── 手动刷新（整版快照；消费本平台待反馈动作） ───

/** 定点刷新范围（贴吧=指定吧内或跨吧关键词搜索；微博=指定话题页或作者主页；小红书=搜索话题或作者主页；其余平台忽略）。 */
export interface SocialRefreshFocus {
  bar?: string;
  topic?: string;
  author?: string;
  /** 搜索关键词（贴吧/小红书搜索结果页的定点生成——第四条入口，与 bar/topic/author 互斥）。 */
  keyword?: string;
}

/**
 * 手动刷新社媒快照：一次生成整版（帖+评论成型）→ 解析 → 反幻觉过滤 → 滚动窗口落盘。
 * focus 定点刷新：贴吧只出某吧新帖（不重写吧表）；微博只出某话题相关博文（不重写热搜）；
 * 贴吧/小红书关键词搜索只出该关键词相关帖（不重写吧表/热搜）。
 * 有本平台待反馈动作时：触发/资料块追加互动内容，指令追加反馈规则，feedback 合并回旧帖。
 * 抛 PhoneChatError（kind: env/api/network/parse）。
 */
export async function refreshSocialSnapshot(args: { kind: SocialKind; rosterOverride?: RosterSnapshot; focus?: SocialRefreshFocus; extraHint?: string; focusNames?: string[] }): Promise<SocialRefreshResult> {
  const kind = args.kind;
  if (_busyKinds.has(kind)) {
    throw new PhoneChatError('env', `${KIND_LABELS[kind]}正在刷新中`);
  }
  if (_feedbackBusy) {
    throw new PhoneChatError('env', '正在生成互动回应，请稍候');
  }
  const focus: SocialRefreshFocus = kind === 'tieba' && args.focus?.bar
    ? { bar: args.focus.bar.trim().slice(0, 24) }
    : kind === 'tieba' && args.focus?.keyword
      ? { keyword: args.focus.keyword.trim().slice(0, 40) }
      : kind === 'weibo' && args.focus?.topic
        ? { topic: args.focus.topic.trim().slice(0, 40) }
        : kind === 'weibo' && args.focus?.author
          ? { author: args.focus.author.trim().slice(0, 24) }
          : kind === 'xhs' && args.focus?.keyword
            ? { keyword: args.focus.keyword.trim().slice(0, 40) }
            : kind === 'xhs' && args.focus?.author
              ? { author: args.focus.author.trim().slice(0, 24) }
              : {};
  _busyKinds.add(kind);
  try {
    return await runRefresh(kind, args.rosterOverride, focus, args.extraHint, args.focusNames);
  } finally {
    _busyKinds.delete(kind);
  }
}

function pickThemesFor(kind: SocialKind, style: PhoneStyle = '') {
  const pool = socialThemePool(kind, style, getPhoneSettings().socialThemes);
  // 朋友圈/小红书抽 2 个选题，贴吧/微博抽 1 个热议方向（用户自定义池同规则）
  return pickSocialThemes(pool, kind === 'moments' || kind === 'xhs' ? 2 : 1);
}

function hasContentFor(kind: SocialKind, parsed: ReturnType<typeof parseSocialReply>): boolean {
  if (kind === 'moments') return parsed.moments.length > 0;
  if (kind === 'tieba') return Boolean(parsed.tiebaPinned) || parsed.tiebaPosts.length > 0 || parsed.bars.length > 0;
  if (kind === 'weibo') return parsed.weiboFeeds.length > 0 || parsed.trending.length > 0;
  return parsed.xhsNotes.length > 0;
}

async function runRefresh(kind: SocialKind, rosterOverride?: RosterSnapshot, focus: SocialRefreshFocus = {}, extraHint?: string, focusNames?: string[]): Promise<SocialRefreshResult> {
  assertPhoneReady();
  const settings = getPhoneSettings();
  const roster = rosterOverride ?? getRoster();
  const authors = roster.contacts.map(c => c.name);
  const me = roster.protagonistName;
  const storyText = stripWithContextConfig(readAiChatHistory(settings.socialHistoryCount));
  const latestLayer = stripWithContextConfig(readAiChatHistory(1));
  const chronicleBlocks = readChronicleDossierBlocks(authors.slice(0, SOCIAL_DOSSIER_AUTHOR_CAP), settings.summaryCount);
  const phoneData = readPhoneData();
  const oldSocial = readSocialOf(phoneData);
  // 聊天归属快照（F1）：AI 请求 15~120s，期间切聊天/切卡 → 本轮产物属于旧聊天，一律不落库。
  const owner = currentPhoneStorageId();

  // 待反馈动作（本平台）→ 帖子上下文；沉底帖动作判 stale 丢弃
  const kindPending = (oldSocial.pending || []).filter(a => a.target === kind);
  const { contexts, consumedIds, staleIds } = buildPendingContexts(kindPending, oldSocial);

  // 题材抽签（防同质化：朋友圈/小红书 2 个选题 / 贴吧/微博 1 个热议方向；仙侠微博=百晓阁风闻池）
  const style = phoneData.style || '';
  const themes = pickThemesFor(kind, style);

  // ① 绿灯触发：通讯录随机 N 人（各平台设置；长按弹窗指定=勾选优先、不足补足、超出全用）+ 最新 1 层正文（+待反馈互动内容+额外提示）
  // 关注焦点：整版刷新时随机抽 ≤3 个关注对象（模仿世界演化「焦点子集」；定点刷新=专属场景不抽），名字进扫描激活世界书
  const focusMode = Boolean(focus.bar || focus.topic || focus.author || focus.keyword);
  const socialFocus = focusMode ? [] : pickFollowFocuses(oldSocial.follows, kind);
  const mergedExtra = mergeOneShotHint(settings.extraPrompt, extraHint);
  const triggerAuthors = focusNames && focusNames.length
    ? mergeFocusPicks(focusNames, authors, Math.max(triggerContactsOf(kind), focusNames.length))
    : pickRandom(authors, triggerContactsOf(kind));
  const triggerText = [
    buildSocialTriggerText({ authors: triggerAuthors, storyText: latestLayer, followNames: socialFocus }),
    contexts.length ? buildSocialPendingTriggerText(contexts) : '',
    mergedExtra.trim(),
  ].filter(Boolean).join(' ');

  // ② 资料块（防重复摘要按 focus 聚焦：吧内=该吧旧帖 / 搜索关键词=命中旧帖 / 话题=相关旧博文 / 作者=该作者旧帖；待反馈时追加互动段）
  const focusBar = focus.bar;
  const focusTopic = focus.topic;
  const focusAuthor = focus.author;
  const focusKeyword = focus.keyword;
  const dossierArgs: SocialDossierArgs = {
    roster,
    kind,
    authors,
    chronicleBlocks,
    storyText,
    oldMoments: oldSocial.moments,
    oldTieba: focusBar ? oldSocial.tieba.filter(p => p.bar === focusBar)
      : focusKeyword ? oldSocial.tieba.filter(p => tiebaMatchesKeyword(p, focusKeyword)) : oldSocial.tieba,
    oldWeibo: focusTopic ? oldSocial.weibo.filter(p => weiboMatchesTopic(p, focusTopic))
      : focusAuthor ? oldSocial.weibo.filter(p => p.author === focusAuthor) : oldSocial.weibo,
    oldXhs: focusKeyword ? oldSocial.xhs.filter(n => xhsMatchesTopic(n, focusKeyword))
      : focusAuthor ? oldSocial.xhs.filter(n => n.author === focusAuthor) : oldSocial.xhs,
    // 贴吧关键词搜索的帖子 bar 必须落在已有吧上（定点刷新不重写吧表）→ 吧名列表进资料块
    ...(kind === 'tieba' && focusKeyword ? { barNames: oldSocial.bars.map(b => b.name) } : {}),
    ...(socialFocus.length ? { socialFocus } : {}),
    style,
  };
  if (contexts.length) {
    dossierArgs.pending = contexts;
    const mixed = buildFeedbackMixedRecords(contexts, phoneData, oldSocial, authors, me, settings.phoneHistoryCount);
    if (mixed) {
      dossierArgs.mixedNames = mixed.names;
      dossierArgs.mixedRecords = mixed.records;
    }
  }

  // ③ 指令（focus 定点：吧内/话题页/作者主页专用模板；有待反馈时追加反馈规则+格式）
  const instruction = buildSocialInstruction({
    roster,
    kind,
    themes,
    extraPrompt: mergedExtra,
    promptOverrides: settings.socialPrompts,
    ...(Object.keys(focus).length ? { focus } : {}),
    ...(socialFocus.length ? { socialFocus } : {}),
    ...(contexts.length ? { pending: contexts } : {}),
    style,
  });

  const raw = await generateSocialRaw({
    triggerId: `ubp_social_trigger_${kind}`,
    dossierId: `ubp_social_dossier_${kind}`,
    triggerText,
    dossierText: buildSocialDossierText(dossierArgs),
    instruction,
    activityLabel: (KIND_LABELS[kind] || '社媒') + '刷新',
    activityAppId: kind,
  });

  if (!raw || !String(raw).trim()) {
    throw new PhoneChatError('parse', 'AI 返回了空内容');
  }

  // ④ 解析（朋友圈 author 白名单过滤）
  const parsed = parseSocialReply(String(raw), {
    allowedAuthors: authors,
  });
  const hasFeedbackOnly = contexts.length > 0 && parsed.feedback.length > 0;
  if (!hasContentFor(kind, parsed) && !hasFeedbackOnly) {
    throw new PhoneChatError('parse', `生成内容无法解析为${KIND_LABELS[kind]}内容`);
  }

  // 聊天归属守卫（F1）：切走后本轮产物不落库，返回当前（新聊天）的社媒快照，调用方照常渲染。
  if (currentPhoneStorageId() !== owner) {
    const cur = readSocialOf(readPhoneDataRef());
    return { raw: String(raw), moments: cur.moments, tieba: cur.tieba, weibo: cur.weibo, xhs: cur.xhs, trending: cur.trending };
  }
  // ⑤ 落盘（滚动窗口 + feedback 合并回旧帖 + 清掉已消费动作；盖故事时间戳 + 规范绝对时间戳）
  // 消息页通知先算（对照合并前状态：关注新帖 + 与我相关反馈；反馈评论对照合并前评论区防重复计数）
  const storyTime = roster.global.time || undefined;
  const anchor = roster.global.time || '';
  const freshNotes: SocialNotification[] = [];
  mutatePhoneData(d => {
    const cur: SocialData = d.social || { moments: [], tieba: [], weibo: [], xhs: [], bars: [], trending: [], refreshedAt: 0, pending: [] };
    if (kind === 'moments') {
      // 朋友圈互动（点赞/评论）同样入未读流；自己刷新出的动态不算未读（用户正在看），故不加 post 通知
      freshNotes.push(...feedbackNotificationsOf('moments', parsed.feedback, cur, me, anchor));
      cur.moments = mergeMomentFeedback(mergeMomentPosts(cur.moments, parsed.moments.map(p => stampPost({ ...p, storyTime }, anchor)), getPhoneSettings().socialMaxPosts), parsed.feedback, me, anchor);
    } else if (kind === 'tieba') {
      const fresh: TiebaPost[] = [
        ...(parsed.tiebaPinned ? [parsed.tiebaPinned] : []),
        ...parsed.tiebaPosts,
      ].map(p => stampPost({ ...p, storyTime }, anchor));
      // 定点刷新（关注/吧内）时用户正在看该吧内容：新帖不进通知流；feedback 通知照常
      if (!focusMode) freshNotes.push(...postNotificationsOf('tieba', fresh, cur.follows));
      freshNotes.push(...feedbackNotificationsOf('tieba', parsed.feedback, cur, me, anchor));
      cur.tieba = mergeTiebaFeedback(mergeScrollPosts(cur.tieba, fresh, maxPostsOf('tieba'), socialFollowKeepIds('tieba', [...cur.tieba, ...fresh], cur.follows)), parsed.feedback, me, anchor);
      // 整版重写吧列表：用户手动添加（custom）的吧按名保留——AI 未提及也存活（AI 同名版本则用 AI 的）
      if (parsed.bars.length) {
        const customs = cur.bars.filter(b => b.custom && !parsed.bars.some(f => f.name === b.name));
        cur.bars = replaceBars([...customs, ...parsed.bars]);
      }
    } else if (kind === 'weibo') {
      const fresh = parsed.weiboFeeds.map(p => stampPost({ ...p, storyTime }, anchor));
      if (!focusMode) freshNotes.push(...postNotificationsOf('weibo', fresh, cur.follows));
      freshNotes.push(...feedbackNotificationsOf('weibo', parsed.feedback, cur, me, anchor));
      cur.weibo = mergeWeiboFeedback(mergeScrollPosts(cur.weibo, fresh, maxPostsOf('weibo'), socialFollowKeepIds('weibo', [...cur.weibo, ...fresh], cur.follows)), parsed.feedback, me, anchor);
      // 话题页/作者主页定点刷新不出热搜——榜单只在整版刷新时重写
      if (parsed.trending.length) cur.trending = replaceTrending(parsed.trending);
    } else {
      const fresh = parsed.xhsNotes.map(n => stampPost({ ...n, storyTime }, anchor));
      if (!focusMode) freshNotes.push(...postNotificationsOf('xhs', fresh, cur.follows));
      freshNotes.push(...feedbackNotificationsOf('xhs', parsed.feedback, cur, me, anchor));
      cur.xhs = mergeXhsFeedback(mergeScrollPosts(cur.xhs, fresh, maxPostsOf('xhs'), socialFollowKeepIds('xhs', [...cur.xhs, ...fresh], cur.follows)), parsed.feedback, me, anchor);
    }
    addSocialNotifications(cur, freshNotes);
    cur.refreshedAt = Date.now();
    dropPendingActionsIn(cur, [...consumedIds, ...staleIds]);
    d.social = cur;
  });

  const social = readSocialOf(readPhoneData());
  return { raw: String(raw), moments: social.moments, tieba: social.tieba, weibo: social.weibo, xhs: social.xhs, trending: social.trending };
}

// ─── 顶栏「求回应」（跨平台只出互动反馈——增量协议） ───

/**
 * 主动请求互动反馈：收集全部平台的待反馈动作（沉底帖动作判 stale 丢弃），触发注入=
 * 通讯录随机 N 人（全局 socialTriggerContacts——激活互动角色条目，避免只靠互动内容无人可回应）
 * +互动内容，资料块带标准档案+互动段，指令=回应规则；feedback 解析后合并回旧帖并清清单。
 */
export async function requestSocialFeedback(args: { extraHint?: string; focusNames?: string[] } = {}): Promise<{ applied: number }> {
  if (_busyKinds.size || _feedbackBusy) {
    throw new PhoneChatError('env', '正在生成中，请稍候');
  }
  assertPhoneReady();
  const roster = getRoster();
  const phoneData = readPhoneData();
  const social = readSocialOf(phoneData);
  const style = phoneData.style || '';
  const { contexts, consumedIds, staleIds } = buildPendingContexts(social.pending || [], social);
  // 先把沉底帖动作清掉（永远无法回喂）
  dropPendingActions(staleIds);
  if (!contexts.length) {
    throw new PhoneChatError('env', '没有待回应的互动——先去点赞或评论吧');
  }

  _feedbackBusy = true;
  // 聊天归属快照（F1）：切走后不把互动回应合并进新聊天的社媒域。
  const owner = currentPhoneStorageId();
  try {
    const authors = roster.contacts.map(c => c.name);
    const targets = Array.from(new Set(contexts.map(c => c.target)));
    // 跨平台累积：有几个平台就体现几个平台的规则；资料块摘要段取第一个涉及平台
    const dossierKind = targets[0];
    const settings = getPhoneSettings();
    const mixed = buildFeedbackMixedRecords(contexts, phoneData, social, authors, roster.protagonistName, settings.phoneHistoryCount);
    const raw = await generateSocialRaw({
      triggerId: 'ubp_social_trigger_feedback',
      dossierId: 'ubp_social_dossier_feedback',
      triggerText: [
        (args.focusNames && args.focusNames.length
          ? mergeFocusPicks(args.focusNames, authors, Math.max(triggerContactsOf('feedback'), args.focusNames.length))
          : pickRandom(authors, triggerContactsOf('feedback'))).join(' '),
        buildSocialPendingTriggerText(contexts),
        (args.extraHint || '').trim(),
      ].filter(Boolean).join(' '),
      dossierText: buildSocialDossierText({
        roster,
        kind: dossierKind,
        authors,
        chronicleBlocks: readChronicleDossierBlocks(authors.slice(0, SOCIAL_DOSSIER_AUTHOR_CAP), settings.summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(settings.socialHistoryCount)),
        oldMoments: social.moments,
        oldTieba: social.tieba,
        oldWeibo: social.weibo,
        oldXhs: social.xhs,
        pending: contexts,
        ...(mixed ? { mixedNames: mixed.names, mixedRecords: mixed.records } : {}),
        style,
      }),
      activityLabel: '互动回应',
      activityAppId: dossierKind || 'moments',
      instruction: buildSocialFeedbackInstruction({ roster, targets, me: roster.protagonistName, extraPrompt: mergeOneShotHint('', args.extraHint), style, hasAnonymous: hasAnonymousPending(contexts) }),
    });
    if (!raw || !String(raw).trim()) {
      throw new PhoneChatError('parse', 'AI 返回了空内容');
    }
    const parsed = parseSocialReply(String(raw), {
      allowedAuthors: authors,
    });
    if (!parsed.feedback.length) {
      throw new PhoneChatError('parse', '生成内容无法解析为互动回应');
    }
    const me = roster.protagonistName;
    const anchor = roster.global.time || '';
    if (currentPhoneStorageId() !== owner) return { applied: 0 }; // 已切聊天：静默丢弃
    mutatePhoneData(d => {
      const cur: SocialData = d.social || { moments: [], tieba: [], weibo: [], xhs: [], bars: [], trending: [], refreshedAt: 0, pending: [] };
      // 未读通知先算（对照合并前评论区防重复计数）；四平台同构（含朋友圈）
      const freshNotes: SocialNotification[] = (['moments', 'tieba', 'weibo', 'xhs'] as const)
        .flatMap(k => feedbackNotificationsOf(k, parsed.feedback, cur, me, anchor));
      cur.moments = mergeMomentFeedback(cur.moments, parsed.feedback, me, anchor);
      cur.tieba = mergeTiebaFeedback(cur.tieba, parsed.feedback, me, anchor);
      cur.weibo = mergeWeiboFeedback(cur.weibo, parsed.feedback, me, anchor);
      cur.xhs = mergeXhsFeedback(cur.xhs, parsed.feedback, me, anchor);
      addSocialNotifications(cur, freshNotes);
      dropPendingActionsIn(cur, [...consumedIds, ...staleIds]);
      d.social = cur;
    });
    const applied = parsed.feedback.reduce((n, fb) => n + fb.comments.length + fb.likes.length, 0);
    return { applied };
  } finally {
    _feedbackBusy = false;
  }
}

/** SocialData 原位移除待反馈动作（mutatePhoneData 回调内使用）。 */
function dropPendingActionsIn(cur: SocialData, removeIds: string[]): void {
  if (!removeIds.length) return;
  const ids = new Set(removeIds);
  const remaining = (cur.pending || []).filter(a => !ids.has(a.id));
  if (remaining.length) cur.pending = remaining;
  else delete cur.pending;
}
