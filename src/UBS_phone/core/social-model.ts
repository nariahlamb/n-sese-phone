// ===== 社媒数据模型（朋友圈 + 贴吧 + 微博 + 小红书，纯函数，零依赖，可被 .cjs 测试直接 require） =====
// 快照流模式：手动刷新一次生成整版（帖+评论成型），
// 各平台走滚动窗口 FIFO（上限=共享设置 socialMaxPosts），热搜、吧列表整版重写。
// P3.2 互动层：用户动作（发帖/点赞/评论/回复/转发）本地即时生效 + pending 待反馈清单；
// AI 反馈（贴主必回 + 其他角色 0-2 跟评，增量协议：禁止重复已有评论/禁止代替主角发言）
// 经 merge*Feedback 合并回旧帖。收藏是小红书本地动作，不进 pending。
// 论坛（forum/trending 旧字段）已退役：存量数据原样保留在存储里但不再读写渲染（legacy passthrough）。
// 存储语义对齐 PhoneChatData（usb_phone_<h>.json，按聊天，无楼层锚定）。
// 时间体系（用户定案）：记录用绝对、显示用相对——帖/评论/动作落盘时盖 storyStamp（规范绝对故事时间戳，
// 由 AI 时间标签 + 生成时的 storyTime 快照锚点归一，见 social-time）；timeLabel/time 原文保留做兜底。

import { excerptText, IMAGE_TEXT_NO_LIMIT, isRecord, makeId } from './ubp-utils';
import { normalizeStoryTimeLabel, parseStamp, postStoryStamp } from './social-time';

export type SocialKind = 'moments' | 'tieba' | 'weibo' | 'xhs';
/** 论坛退役前的旧平台值（存量 pending/feedback 归一化时静默丢弃）。 */
export const LEGACY_SOCIAL_KINDS: readonly string[] = ['forum'];

/** 匿名发言缺省网名（用户未填时的兜底；UI 占位符与引擎同源）。 */
export const ANON_DEFAULT_NAME = '匿名用户';
/** 匿名网名长度上限（界面 maxlength 与引擎截断同口径）。 */
export const ANON_NAME_MAX = 12;

/** 社媒帖正文字数上限（用户定案 1000）：落库/读盘归一化**不得低于**正文联动与演化侧的字段上限，
 *  否则正文里写足的帖子会在每次读盘时被砍短（读盘归一化跑在每次 readPhoneData 上）。 */
const SOCIAL_POST_TEXT_MAX = 1000;
/** 社媒帖标题上限（小红书/贴吧，用户定案 1000）。 */
const SOCIAL_POST_TITLE_MAX = 1000;
/** 吧名上限（用户定案 1000）。 */
const SOCIAL_POST_BAR_MAX = 1000;

/** 社媒评论（扁平结构 + replyTo 指针；楼中楼由前端重建——社媒论坛验证过的稳定方案）。 */
export interface SocialComment {
  /** 评论者（roster 角色名或有生活感的路人网名；主角名在解析层被屏蔽）。 */
  name: string;
  /** 评论正文（10-40 字）。 */
  text: string;
  /** 用户匿名评论标记（存在=用户以匿名网名发出，name 即匿名网名；界面加淡色「（我）」标记，注入侧按匿名网友对待）。 */
  anon?: true;
  /** 被回复评论者名（楼中楼指针；可空 = 顶层评论）。 */
  replyTo?: string;
  /** 互动时间（AI 基于全局数据表当前时间编造；用户评论=动作时的故事时间快照）。 */
  time?: string;
  /** 规范绝对故事时间戳（落盘时盖；显示/注入用它换算，time 原文兜底）。 */
  storyStamp?: string;
  /** 配图画面描述（'' 缺省 = 无图；贴吧回帖/微博评论可低频开放）。 */
  imageDesc?: string;
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  /** 固化生图提示词（两步法第一步产物；存在=重试跳过文字 AI）。 */
  imagePrompt?: string;
  imageNegative?: string;
}

/** 朋友圈动态。 */
export interface MomentPost {
  id: string;
  /** 发帖人（roster 白名单角色；用户发帖 = 主角名，用户匿名发帖 = 匿名网名）。 */
  author: string;
  /** 用户匿名发帖标记（存在=用户以匿名网名发出，author 即匿名网名）。 */
  anon?: true;
  /** 正文（30-120 字）。 */
  text: string;
  /** 配图画面描述（'' = 无图）。 */
  imageDesc: string;
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  /** 固化生图提示词（两步法第一步产物；存在=重试跳过文字 AI）。 */
  imagePrompt?: string;
  imageNegative?: string;
  /** 点赞人名（空数组 = 无人点赞；用户点赞 = 主角名入列）。 */
  likes: string[];
  comments: SocialComment[];
  /** 发帖时间（AI 基于当前故事时间编造；用户发帖 = 故事时间快照）。 */
  timeLabel: string;
  /** 生成时全局数据表「当前时间」快照。 */
  storyTime?: string;
  /** 规范绝对故事时间戳（落盘时由 timeLabel+storyTime 锚点归一；注入/显示用它换算）。 */
  storyStamp?: string;
  createdAt: number;

  /** 正文联动来源楼层 id（第五轮 ⑦：swipe/编辑重提取时按此整层替换，防重复）。 */
  srcMesId?: string;}

// ─── 论坛（legacy：仅保留类型与归一化，供存量数据原样保留；不再生成/渲染） ───

export type SocialBoard = 'nearby' | 'discover';

/** 论坛帖子（退役遗留类型）。 */
export interface ForumPost {
  id: string;
  board: SocialBoard;
  pinned: boolean;
  title: string;
  content: string;
  author: string;
  category: string;
  views: number;
  likes: number;
  likedByMe?: boolean;
  imageDesc: string;
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  imagePrompt?: string;
  imageNegative?: string;
  comments: SocialComment[];
  timeLabel: string;
  storyTime?: string;
  /** 规范绝对故事时间戳（落盘时由 timeLabel+storyTime 锚点归一；注入/显示用它换算）。 */
  storyStamp?: string;
  createdAt: number;
}

// ─── 贴吧（吧 + 楼层盖楼帖） ───

/** 贴吧吧信息（进吧页列表；每版刷新整表重写）。 */
export interface TiebaBar {
  name: string;
  /** 关注数文案（如「12.3万」）。 */
  members: string;
  /** 贴子数文案（如「890万」）。 */
  posts: string;
  /** 用户手动添加（进吧页 + 号；跨整版刷新存活，AI 重写同名吧时让位 AI 版）。 */
  custom?: boolean;
}

/** 贴吧帖子：主楼 + 楼层评论（comments=存下的代表性楼层，楼层号=下标+2，1楼=主楼）。 */
export interface TiebaPost {
  id: string;
  /** 吧名（如「临江大学吧」）。 */
  bar: string;
  /** 吧务置顶（吧规/公告，每吧至多一条）。 */
  pinned: boolean;
  title: string;
  /** 主楼正文（60-300 字）。 */
  content: string;
  author: string;
  /** 用户匿名发帖标记（存在=用户以匿名网名发出，author 即匿名网名）。 */
  anon?: true;
  /** 楼主等级头衔 flavor（如「Lv.8 核心会员」；可空）。 */
  authorTitle?: string;
  views: number;
  /** 全部回复数（显示用；存下的楼层=comments）。 */
  replies: number;
  likes: number;
  likedByMe?: boolean;
  /** 镇楼图画面描述（'' = 无图）。 */
  imageDesc: string;
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  imagePrompt?: string;
  imageNegative?: string;
  /** 楼层回复（replyTo 指针=楼中楼）。 */
  comments: SocialComment[];
  timeLabel: string;
  storyTime?: string;
  /** 规范绝对故事时间戳（落盘时由 timeLabel+storyTime 锚点归一；注入/显示用它换算）。 */
  storyStamp?: string;
  createdAt: number;

  /** 正文联动来源楼层 id（第五轮 ⑦：swipe/编辑重提取时按此整层替换，防重复）。 */
  srcMesId?: string;}

// ─── 微博（时间线 + 热搜 + 转发链 + 认证体系） ───

/** 微博配图（0-3 张，逐张两步法生图）。 */
export interface WeiboImage {
  desc: string;
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  imagePrompt?: string;
  imageNegative?: string;
}

/** 转发卡原博（单层转发链：AI 生成「转发理由 + //@原博」结构）。 */
export interface WeiboRepost {
  author: string;
  text: string;
  imageDesc?: string;
}

/** 微博博文。 */
export interface WeiboPost {
  id: string;
  author: string;
  /** 用户匿名发帖标记（存在=用户以匿名网名发出，author 即匿名网名）。 */
  anon?: true;
  /** 认证标识（orange=个人橙V / gold=金V / blue=机构蓝V；无=普通用户）。 */
  verified?: 'orange' | 'gold' | 'blue';
  /** 会员标（皇冠 flavor）。 */
  vip?: boolean;
  text: string;
  images: WeiboImage[];
  /** 转发卡（博主转发他人博文时存在；用户转发=本地生成带转发卡的博文）。 */
  repost?: WeiboRepost;
  /** 所属话题词（关联热搜；可空。话题页=按此字段前端过滤聚合）。 */
  topic?: string;
  forwards: number;
  /** 评论总数（显示用；存下的热评=comments）。 */
  commentsCount: number;
  likes: number;
  likedByMe?: boolean;
  /** 我是否已转发（转发=本地新增博文+此标记防重复转发）。 */
  repostedByMe?: boolean;
  /** 热评（replyTo 指针=楼中楼）。 */
  comments: SocialComment[];
  /** 来源 flavor（如「来自 iPhone 15 Pro」；可空）。 */
  source?: string;
  timeLabel: string;
  storyTime?: string;
  /** 规范绝对故事时间戳（落盘时由 timeLabel+storyTime 锚点归一；注入/显示用它换算）。 */
  storyStamp?: string;
  createdAt: number;

  /** 正文联动来源楼层 id（第五轮 ⑦：swipe/编辑重提取时按此整层替换，防重复）。 */
  srcMesId?: string;}

/** 热搜条目（榜单整版重写，无历史包袱）。 */
export interface TrendingItem {
  /** 1-based 排名。 */
  rank: number;
  title: string;
  /** 热度值文本（如「486.2万」）。 */
  hot: string;
  /** 榜单标签（爆/沸/热/新…；可空）。 */
  tag: string;
}

// ─── 小红书（双列瀑布流笔记） ───

/** 小红书笔记（封面图+标题+emoji 正文+话题标签；收藏文化）。 */
export interface XhsNote {
  id: string;
  title: string;
  content: string;
  /** 话题标签（3-6 个，不带 # 前缀存储）。 */
  tags: string[];
  author: string;
  /** 用户匿名发帖标记（存在=用户以匿名网名发出，author 即匿名网名）。 */
  anon?: true;
  /** 封面图画面描述（大多数笔记有——小红书以图为先）。 */
  imageDesc: string;
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  imagePrompt?: string;
  imageNegative?: string;
  likes: number;
  /** 收藏数（码住文化；收藏是特色互动）。 */
  collects: number;
  likedByMe?: boolean;
  collectedByMe?: boolean;
  comments: SocialComment[];
  timeLabel: string;
  storyTime?: string;
  /** 规范绝对故事时间戳（落盘时由 timeLabel+storyTime 锚点归一；注入/显示用它换算）。 */
  storyStamp?: string;
  createdAt: number;

  /** 正文联动来源楼层 id（第五轮 ⑦：swipe/编辑重提取时按此整层替换，防重复）。 */
  srcMesId?: string;}

// ─── 互动层 ───

/** 关注集合（本地动作零 AI：贴吧吧/微博博主/小红书作者；刷新重写吧表/信息流后仍按名保留）。 */
export interface SocialFollows {
  /** 关注的吧名（TiebaBar.name）。 */
  bars: string[];
  /** 关注的微博博主名。 */
  weibo: string[];
  /** 关注的小红书作者名。 */
  xhs: string[];
}

/** 每个关注域的容量上限。 */
export const MAX_FOLLOWS_PER_SCOPE = 30;

/** 作者主页资料（微博/小红书作者；首次进入时 AI 轻量生成一次后缓存，名字锚定）。 */
export interface SocialAuthorProfile {
  scope: 'weibo' | 'xhs';
  name: string;
  /** 个性签名/认证行简介。 */
  signature: string;
  /** 关注数文案（「312」「8.4万」，AI 文本直存）。 */
  following: string;
  /** 粉丝数文案。 */
  followers: string;
  /** 获赞（与收藏）总数文案。 */
  likes: string;
  verified?: 'orange' | 'gold' | 'blue';
  /** 生成时的规范绝对故事时间戳。 */
  storyStamp?: string;
  /** 用户手选封面（换封面弹层写入口；立绘/文生图/相册/导入的图片路径，AI 重生成不覆盖）。 */
  cover?: string;
  createdAt: number;
}

/** 作者资料缓存上限（LRU：超出按 createdAt 裁最旧）。 */
export const MAX_AUTHOR_PROFILES = 40;

/** 用户互动动作（本地即时生效 + 记入 pending，等 AI 反馈消费——增量协议）。 */
export type SocialActionType = 'post' | 'like' | 'comment' | 'reply' | 'repost';

export interface SocialUserAction {
  id: string;
  type: SocialActionType;
  /** 动作所在平台。 */
  target: SocialKind;
  postId: string;
  /** 贴主（被互动人；用户自己发帖时 = 主角名，匿名发帖时 = 匿名网名）。 */
  author: string;
  /** 匿名网名（存在=该动作以匿名账号发出；缺省=实名动作即主角本人。注入侧据此不将其算作主角的发言）。 */
  anon?: string;
  /** 用户发言内容：帖子正文/转发语/评论内容；点赞/转发无文字时为空串。 */
  content: string;
  /** type='reply' 时的被回复评论人。 */
  replyTo?: string;
  /** 用户帖子附图的画面描述（进 AI 请求，语义同聊天转发「[图片]描述」）。 */
  imageDesc?: string;
  /** 动作时的故事时间快照（全局数据表当前时间）。 */
  time: string;
  /** 规范绝对故事时间戳（动作落盘时盖）。 */
  storyStamp?: string;
  createdAt: number;
}

/** AI 反馈项（feedback 数组元素；按 target+postId 定位合并回旧帖）。 */
export interface SocialFeedback {
  target: SocialKind;
  postId: string;
  /** 点赞人名（moments 用；其余平台点赞是计数，反馈忽略）。 */
  likes: string[];
  comments: SocialComment[];
}

/** 平台通知类型（新帖=关注对象发帖/世界演化投递；评论=我帖子的新评论；回复=回复我的评论）。 */
export type SocialNotifyType = 'post' | 'comment' | 'reply';

/**
 * 社媒未读通知（四平台共用；**社媒唯一的未读事实源**）。
 * 「内容型」（有新帖）与「互动型」（有人评论/回复我）都是逐条记录、逐条已读——
 * 桌面图标角标、消息页 tab 徽标、悬浮球红点、通知中心全部读这一份，不再有第二套计数体系。
 * 朋友圈无消息页（不渲染通知流），但其未读同样落在这里：打开朋友圈即整平台已读。
 */
export interface SocialNotification {
  id: string;
  /** 通知归属平台（= 该 App / 桌面磁贴 id）。 */
  kind: SocialKind;
  type: SocialNotifyType;
  /** 关联帖子 id（打开详情即已读的锚点；帖子沉底后通知仍自包含可显示）。 */
  postId: string;
  /** 动作发起人（新帖=发帖人；评论/回复=评论者）。 */
  author: string;
  /** 自包含摘要（新帖=标题/正文节选；评论=评论内容）。 */
  content: string;
  /** 事件时间标签原文（AI 标签或演化快照）。 */
  time: string;
  /** 规范绝对故事时间戳（落盘时盖；显示用相对分桶）。 */
  storyStamp?: string;
  createdAt: number;
  read?: boolean;
}

export interface SocialData {
  moments: MomentPost[];
  tieba: TiebaPost[];
  weibo: WeiboPost[];
  xhs: XhsNote[];
  /** 贴吧吧列表（整表重写）。 */
  bars: TiebaBar[];
  trending: TrendingItem[];
  /** 用户关注集合（本地动作；名字锚定，整版刷新后仍有效）。 */
  follows?: SocialFollows;
  /** 作者主页资料缓存（微博/小红书；key=`${scope}:${name}`，LRU）。 */
  authorProfiles?: Record<string, SocialAuthorProfile>;
  /** 上次刷新时间戳（内部，排序/去重用；不显示、不进提示词）。 */
  refreshedAt: number;
  /** 用户待反馈动作（本地已生效，等刷新或「求回应」消费）。 */
  pending?: SocialUserAction[];
  /** 各平台未读通知流（新→旧；**唯一的未读事实源**，四平台同构：内容型新帖与互动型评论/回复都在这里，逐条已读）。 */
  notifications?: SocialNotification[];
  /** 论坛退役遗留数据（原样保留不再读写渲染）。 */
  forum?: ForumPost[];
}

// ─── 上限常量（maxPosts 运行时可调，此处为默认值与硬顶） ───

export const MAX_MOMENT_POSTS = 30;
export const MAX_SOCIAL_POSTS_DEFAULT = 40;
export const MAX_SOCIAL_POSTS_CAP = 80;
export const MAX_TRENDING_ITEMS = 12;
export const MAX_BARS = 12;
export const MAX_COMMENTS_PER_POST = 12;
export const MAX_MOMENT_LIKES = 12;
export const MAX_PENDING_ACTIONS = 30;
export const MAX_SOCIAL_NOTIFICATIONS = 100;
export const MAX_WEIBO_IMAGES = 3;
export const MAX_XHS_TAGS = 6;

export function makeSocialPostId(): string {
  return makeId('s_');
}

/**
 * 匿名网名解析（纯函数）：空=默认「匿名用户」，超长截断；与已占用名（主角/通讯录角色）重名时回 conflict。
 * 匿名归属全靠作者名比对（「（我）」标记、混合记录认领、反馈回复指向），重名会当场冒充成那个角色 → 调用方必须拒绝。
 */
export function resolveAnonName(raw: string | undefined, taken: readonly string[]): { name: string; conflict?: string } {
  const name = (raw || '').trim().slice(0, ANON_NAME_MAX) || ANON_DEFAULT_NAME;
  return taken.includes(name) ? { name, conflict: name } : { name };
}

export function makeSocialActionId(): string {
  return makeId('sa_');
}

export function makeSocialNotificationId(): string {
  return makeId('sn_');
}

function str(value: unknown, maxLen = 4000): string {
  return typeof value === 'string' ? value.slice(0, maxLen) : '';
}

/** storyStamp 输入净化（合法规范戳才透传；防脏数据进存储）。 */
function stampInput(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().slice(0, 20) : '';
  return raw && parseStamp(raw).date ? raw : '';
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 可信浏览/点赞数：非法输入按 名字+标题 确定性散列出 200~9200 的数（同帖恒同值，重渲染不跳变）。 */
export function plausibleCount(seed: string, base: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return base > 0 ? base : 200 + (hash % 9000);
}

// ─── 归一化（磁盘读回容错 + AI 输出净化共用） ───

export function normalizeSocialComment(value: unknown): SocialComment | null {
  if (!isRecord(value)) return null;
  const name = str(value.name ?? value.from, 30).trim();
  const text = str(value.text ?? value.c ?? value.content, 160).trim();
  if (!name || !text) return null;
  const comment: SocialComment = { name, text };
  if (value.anon === true) comment.anon = true;
  const replyTo = str(value.replyTo ?? value.reply, 30).trim();
  if (replyTo && replyTo !== name) comment.replyTo = replyTo;
  const time = str(value.t ?? value.time, 24).trim();
  if (time) comment.time = time;
  const stamp = stampInput(value.storyStamp);
  if (stamp) comment.storyStamp = stamp;
  const rawImage = str(value.image ?? value.imageDesc ?? value.img, IMAGE_TEXT_NO_LIMIT).trim();
  if (rawImage && rawImage.toLowerCase() !== 'none') comment.imageDesc = rawImage;
  if (typeof value.imagePath === 'string' && value.imagePath) comment.imagePath = value.imagePath;
  if (value.imageStatus === 'ready' || value.imageStatus === 'failed' || value.imageStatus === 'pending') {
    comment.imageStatus = value.imageStatus;
  }
  if (typeof value.imagePrompt === 'string' && value.imagePrompt.trim()) comment.imagePrompt = value.imagePrompt;
  if (typeof value.imageNegative === 'string') comment.imageNegative = value.imageNegative;
  return comment;
}

function takeImageState(value: Record<string, unknown>): {
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  imagePrompt?: string;
  imageNegative?: string;
} {
  const state: ReturnType<typeof takeImageState> = {};
  if (typeof value.imagePath === 'string' && value.imagePath) state.imagePath = value.imagePath;
  if (value.imageStatus === 'ready' || value.imageStatus === 'failed' || value.imageStatus === 'pending') {
    state.imageStatus = value.imageStatus;
  }
  if (typeof value.imagePrompt === 'string' && value.imagePrompt.trim()) state.imagePrompt = value.imagePrompt;
  if (typeof value.imageNegative === 'string') state.imageNegative = value.imageNegative;
  return state;
}

function normalizeComments(value: unknown, blocked: (name: string) => boolean = () => false): SocialComment[] {
  return (Array.isArray(value) ? value : [])
    .map(normalizeSocialComment)
    .filter((c): c is SocialComment => c !== null && !blocked(c.name))
    .slice(0, MAX_COMMENTS_PER_POST);
}

export function normalizeMomentPost(value: unknown): MomentPost | null {
  if (!isRecord(value)) return null;
  const author = str(value.author ?? value.name, 40).trim();
  const text = str(value.text ?? value.content, SOCIAL_POST_TEXT_MAX).trim();
  if (!author || !text) return null;
  const rawImage = str(value.image ?? value.imageDesc ?? value.img, IMAGE_TEXT_NO_LIMIT).trim();
  const imageDesc = rawImage && rawImage.toLowerCase() !== 'none' ? rawImage : '';
  const likes = (Array.isArray(value.likes)
    ? value.likes.filter((n): n is string => typeof n === 'string' && Boolean(n.trim())).map(n => n.trim().slice(0, 30))
    : []).slice(0, MAX_MOMENT_LIKES);
  const post: MomentPost = {
    id: typeof value.id === 'string' && value.id ? value.id : makeSocialPostId(),
    author,
    text,
    imageDesc,
    likes: Array.from(new Set(likes.filter(n => n !== author))),
    comments: normalizeComments(value.comments),
    timeLabel: (str(value.time ?? value.timeLabel ?? value.t, 24).trim() || '刚刚'),
    createdAt: num(value.createdAt, Date.now()),
  };
  Object.assign(post, takeImageState(value));
  if (value.anon === true) post.anon = true;
  if (typeof post.imagePath !== 'string' || !post.imagePath) delete post.imagePath;
  if (typeof value.storyTime === 'string' && value.storyTime) post.storyTime = value.storyTime.slice(0, 60);
  const postStamp = stampInput(value.storyStamp);
  if (postStamp) post.storyStamp = postStamp;
  if (typeof value.srcMesId === 'string' && value.srcMesId) post.srcMesId = value.srcMesId.slice(0, 40);
  return post;
}

/** 论坛帖子归一化（legacy：仅存储读回时保留，不再生成）。 */
export function normalizeForumPost(value: unknown): ForumPost | null {
  if (!isRecord(value)) return null;
  const title = str(value.title, SOCIAL_POST_TITLE_MAX).trim();
  const content = str(value.content ?? value.text, SOCIAL_POST_TEXT_MAX).trim();
  const author = str(value.author ?? value.name, 40).trim();
  if (!title || !content || !author) return null;
  const board: SocialBoard = value.board === 'discover' ? 'discover' : 'nearby';
  const rawImage = str(value.image ?? value.imageDesc ?? value.img, IMAGE_TEXT_NO_LIMIT).trim();
  const post: ForumPost = {
    id: typeof value.id === 'string' && value.id ? value.id : makeSocialPostId(),
    board,
    pinned: value.pinned === true,
    title,
    content,
    author,
    category: str(value.category ?? value.tag, 12).trim() || '闲聊',
    views: Math.max(0, Math.floor(num(value.views, 0))) || plausibleCount(`${author}|${title}`, 0),
    likes: Math.max(0, Math.floor(num(value.likes, 0))) || Math.max(1, plausibleCount(title, 0) % 400),
    imageDesc: rawImage && rawImage.toLowerCase() !== 'none' ? rawImage : '',
    comments: normalizeComments(value.comments),
    timeLabel: (str(value.time ?? value.timeLabel ?? value.t, 24).trim() || '刚刚'),
    createdAt: num(value.createdAt, Date.now()),
  };
  if (value.likedByMe === true) post.likedByMe = true;
  Object.assign(post, takeImageState(value));
  if (typeof post.imagePath !== 'string' || !post.imagePath) delete post.imagePath;
  if (typeof value.storyTime === 'string' && value.storyTime) post.storyTime = value.storyTime.slice(0, 60);
  const postStamp = stampInput(value.storyStamp);
  if (postStamp) post.storyStamp = postStamp;
  return post;
}

export function normalizeTiebaBar(value: unknown): TiebaBar | null {
  if (!isRecord(value)) return null;
  const name = str(value.name, SOCIAL_POST_BAR_MAX).trim();
  if (!name) return null;
  return {
    name,
    members: str(value.members ?? value.fans, 12).trim() || '1万',
    posts: str(value.posts ?? value.total, 12).trim() || '10万',
    ...(value.custom === true ? { custom: true } : {}),
  };
}

export function normalizeTiebaPost(value: unknown): TiebaPost | null {
  if (!isRecord(value)) return null;
  const title = str(value.title, SOCIAL_POST_TITLE_MAX).trim();
  const content = str(value.content ?? value.text, 1200).trim();
  const author = str(value.author ?? value.name, 40).trim();
  const bar = str(value.bar, SOCIAL_POST_BAR_MAX).trim();
  if (!title || !content || !author || !bar) return null;
  const rawImage = str(value.image ?? value.imageDesc ?? value.img, IMAGE_TEXT_NO_LIMIT).trim();
  const post: TiebaPost = {
    id: typeof value.id === 'string' && value.id ? value.id : makeSocialPostId(),
    bar,
    pinned: value.pinned === true,
    title,
    content,
    author,
    views: Math.max(0, Math.floor(num(value.views, 0))) || plausibleCount(`${author}|${title}`, 0),
    replies: Math.max(0, Math.floor(num(value.replies ?? value.comments_count, 0))) || Math.max(2, plausibleCount(`r|${title}`, 0) % 400),
    likes: Math.max(0, Math.floor(num(value.likes, 0))) || Math.max(1, plausibleCount(`l|${title}`, 0) % 200),
    imageDesc: rawImage && rawImage.toLowerCase() !== 'none' ? rawImage : '',
    comments: normalizeComments(value.comments),
    timeLabel: (str(value.time ?? value.timeLabel ?? value.t, 24).trim() || '刚刚'),
    createdAt: num(value.createdAt, Date.now()),
  };
  const authorTitle = str(value.authorTitle ?? value.level, 20).trim();
  if (authorTitle) post.authorTitle = authorTitle;
  if (value.likedByMe === true) post.likedByMe = true;
  if (value.anon === true) post.anon = true;
  Object.assign(post, takeImageState(value));
  if (typeof post.imagePath !== 'string' || !post.imagePath) delete post.imagePath;
  if (typeof value.storyTime === 'string' && value.storyTime) post.storyTime = value.storyTime.slice(0, 60);
  const postStamp = stampInput(value.storyStamp);
  if (postStamp) post.storyStamp = postStamp;
  if (typeof value.srcMesId === 'string' && value.srcMesId) post.srcMesId = value.srcMesId.slice(0, 40);
  return post;
}

function normalizeVerified(value: unknown): 'orange' | 'gold' | 'blue' | undefined {
  if (value === 'orange' || value === 'gold' || value === 'blue') return value;
  if (value === 'o') return 'orange';
  if (value === 'g') return 'gold';
  if (value === 'b' || value === 'org') return 'blue';
  return undefined;
}

function normalizeWeiboImage(value: unknown): WeiboImage | null {
  const desc = str(isRecord(value) ? (value.desc ?? value.image ?? value.d) : value, IMAGE_TEXT_NO_LIMIT).trim();
  if (!desc || desc.toLowerCase() === 'none') return null;
  const image: WeiboImage = { desc };
  if (isRecord(value)) {
    const state = takeImageState(value);
    Object.assign(image, state);
    if (typeof image.imagePath !== 'string' || !image.imagePath) delete image.imagePath;
  }
  return image;
}

function normalizeWeiboRepost(value: unknown): WeiboRepost | null {
  if (!isRecord(value)) return null;
  const author = str(value.author ?? value.name, 40).trim();
  const text = str(value.text ?? value.content ?? value.c, 400).trim();
  if (!author || !text) return null;
  const repost: WeiboRepost = { author, text };
  const imageDesc = str(value.image ?? value.imageDesc, IMAGE_TEXT_NO_LIMIT).trim();
  if (imageDesc && imageDesc.toLowerCase() !== 'none') repost.imageDesc = imageDesc;
  return repost;
}

export function normalizeWeiboPost(value: unknown): WeiboPost | null {
  if (!isRecord(value)) return null;
  const author = str(value.author ?? value.name, 40).trim();
  const text = str(value.text ?? value.content, SOCIAL_POST_TEXT_MAX).trim();
  if (!author || !text) return null;
  const images = (Array.isArray(value.images) ? value.images : (str(value.image ?? value.imageDesc, IMAGE_TEXT_NO_LIMIT).trim() ? [value.image ?? value.imageDesc] : []))
    .map(normalizeWeiboImage)
    .filter((i): i is WeiboImage => i !== null)
    .slice(0, MAX_WEIBO_IMAGES);
  const post: WeiboPost = {
    id: typeof value.id === 'string' && value.id ? value.id : makeSocialPostId(),
    author,
    text,
    images,
    forwards: Math.max(0, Math.floor(num(value.forwards ?? value.shares, 0))) || plausibleCount(`f|${author}|${text}`, 0) % 5000,
    commentsCount: Math.max(0, Math.floor(num(value.commentsCount ?? value.comments_count, 0))) || Math.max(2, plausibleCount(`c|${text}`, 0) % 8000),
    likes: Math.max(0, Math.floor(num(value.likes, 0))) || plausibleCount(`w|${author}|${text}`, 0),
    comments: normalizeComments(value.comments),
    timeLabel: (str(value.time ?? value.timeLabel ?? value.t, 24).trim() || '刚刚'),
    createdAt: num(value.createdAt, Date.now()),
  };
  const verified = normalizeVerified(value.verified ?? value.v);
  if (verified) post.verified = verified;
  if (value.vip === true) post.vip = true;
  const repost = normalizeWeiboRepost(value.repost ?? value.forward);
  if (repost) post.repost = repost;
  const topic = str(value.topic, 40).trim();
  if (topic) post.topic = topic;
  const source = str(value.source, 30).trim();
  if (source) post.source = source;
  if (value.likedByMe === true) post.likedByMe = true;
  if (value.repostedByMe === true) post.repostedByMe = true;
  if (value.anon === true) post.anon = true;
  if (typeof value.storyTime === 'string' && value.storyTime) post.storyTime = value.storyTime.slice(0, 60);
  const postStamp = stampInput(value.storyStamp);
  if (postStamp) post.storyStamp = postStamp;
  if (typeof value.srcMesId === 'string' && value.srcMesId) post.srcMesId = value.srcMesId.slice(0, 40);
  return post;
}

export function normalizeXhsNote(value: unknown): XhsNote | null {
  if (!isRecord(value)) return null;
  const title = str(value.title, SOCIAL_POST_TITLE_MAX).trim();
  const content = str(value.content ?? value.text, 1200).trim();
  const author = str(value.author ?? value.name, 40).trim();
  if (!title || !content || !author) return null;
  const rawImage = str(value.image ?? value.imageDesc ?? value.img, IMAGE_TEXT_NO_LIMIT).trim();
  const tags = (Array.isArray(value.tags)
    ? value.tags.filter((t): t is string => typeof t === 'string' && Boolean(t.trim())).map(t => t.trim().replace(/^#/, '').slice(0, 16))
    : (str(value.tags, 120).trim() ? str(value.tags, 120).split(/[##\s]+/).map(t => t.trim()).filter(Boolean) : [])
  ).slice(0, MAX_XHS_TAGS);
  const note: XhsNote = {
    id: typeof value.id === 'string' && value.id ? value.id : makeSocialPostId(),
    title,
    content,
    tags,
    author,
    imageDesc: rawImage && rawImage.toLowerCase() !== 'none' ? rawImage : '',
    likes: Math.max(0, Math.floor(num(value.likes, 0))) || plausibleCount(`x|${title}`, 0),
    collects: Math.max(0, Math.floor(num(value.collects ?? value.stars, 0))) || plausibleCount(`s|${title}`, 0),
    comments: normalizeComments(value.comments),
    timeLabel: (str(value.time ?? value.timeLabel ?? value.t, 24).trim() || '刚刚'),
    createdAt: num(value.createdAt, Date.now()),
  };
  if (value.likedByMe === true) note.likedByMe = true;
  if (value.collectedByMe === true) note.collectedByMe = true;
  if (value.anon === true) note.anon = true;
  Object.assign(note, takeImageState(value));
  if (typeof note.imagePath !== 'string' || !note.imagePath) delete note.imagePath;
  if (typeof value.storyTime === 'string' && value.storyTime) note.storyTime = value.storyTime.slice(0, 60);
  const noteStamp = stampInput(value.storyStamp);
  if (noteStamp) note.storyStamp = noteStamp;
  if (typeof value.srcMesId === 'string' && value.srcMesId) note.srcMesId = value.srcMesId.slice(0, 40);
  return note;
}

export function normalizeTrendingItem(value: unknown, index: number): TrendingItem | null {
  if (!isRecord(value)) return null;
  const title = str(value.title ?? value.word, 60).trim();
  if (!title) return null;
  return {
    rank: Math.max(1, Math.floor(num(value.rank, index + 1))),
    title,
    hot: str(value.hot, 12).trim() || '热度中',
    tag: str(value.tag, 6).trim(),
  };
}

function normalizeSocialActions(value: unknown): SocialUserAction[] {
  if (!Array.isArray(value)) return [];
  const out: SocialUserAction[] = [];
  for (const raw of value.slice(0, MAX_PENDING_ACTIONS)) {
    if (!isRecord(raw)) continue;
    // 论坛退役：存量 forum 动作静默丢弃
    if (raw.target !== 'moments' && raw.target !== 'tieba' && raw.target !== 'weibo' && raw.target !== 'xhs') continue;
    const target: SocialKind = raw.target;
    const type = raw.type === 'post' || raw.type === 'like' || raw.type === 'reply' || raw.type === 'repost' ? raw.type : 'comment';
    const postId = str(raw.postId, 60).trim();
    const author = str(raw.author, 40).trim();
    const content = str(raw.content, 400).trim();
    if (!postId || !author) continue;
    const action: SocialUserAction = {
      id: str(raw.id, 40).trim() || makeSocialActionId(),
      type,
      target,
      postId,
      author,
      content,
      time: str(raw.time, 24).trim() || '刚刚',
      createdAt: num(raw.createdAt, Date.now()),
    };
    const actionStamp = stampInput(raw.storyStamp);
    if (actionStamp) action.storyStamp = actionStamp;
    const replyTo = str(raw.replyTo, 30).trim();
    if (replyTo) action.replyTo = replyTo;
    const anon = str(raw.anon, ANON_NAME_MAX).trim();
    if (anon) action.anon = anon;
    const imageDesc = str(raw.imageDesc, IMAGE_TEXT_NO_LIMIT).trim();
    if (imageDesc) action.imageDesc = imageDesc;
    out.push(action);
  }
  return out;
}

/** 关注集合归一化（截断 + 去空；空集合整体省略，不占存储形状）。 */
export function normalizeSocialFollows(value: unknown): SocialFollows | undefined {
  if (!isRecord(value)) return undefined;
  const scope = (key: 'bars' | 'weibo' | 'xhs'): string[] => Array.isArray(value[key])
    ? Array.from(new Set(
      value[key].filter((n): n is string => typeof n === 'string' && Boolean(n.trim())).map(n => n.trim().slice(0, 40)),
    )).slice(0, MAX_FOLLOWS_PER_SCOPE)
    : [];
  const follows: SocialFollows = { bars: scope('bars'), weibo: scope('weibo'), xhs: scope('xhs') };
  if (!follows.bars.length && !follows.weibo.length && !follows.xhs.length) return undefined;
  return follows;
}

/** 刷新后按名保留关注（吧表/信息流整版重写，关注以名字锚定不受影响；无此过程无需清理）。 */
export function mergeFollowsWithSnapshot(follows: SocialFollows | undefined): SocialFollows | undefined {
  if (!follows) return undefined;
  return {
    bars: follows.bars.slice(0, MAX_FOLLOWS_PER_SCOPE),
    weibo: follows.weibo.slice(0, MAX_FOLLOWS_PER_SCOPE),
    xhs: follows.xhs.slice(0, MAX_FOLLOWS_PER_SCOPE),
  };
}

/** 作者资料缓存键（scope:name；scope 仅 weibo/xhs，贴吧=吧无需资料页）。 */
export function socialAuthorProfileKey(scope: 'weibo' | 'xhs', name: string): string {
  return `${scope}:${name.trim()}`;
}

/** 作者资料归一化（磁盘读回容错：scope/name 非法丢弃，LRU 按 createdAt 取最新，空表整体省略）。 */
export function normalizeSocialAuthorProfiles(value: unknown): Record<string, SocialAuthorProfile> | undefined {
  if (!isRecord(value)) return undefined;
  const out = new Map<string, SocialAuthorProfile>();
  for (const raw of Object.values(value)) {
    if (!isRecord(raw)) continue;
    const scope = str(raw.scope, 8).trim();
    if (scope !== 'weibo' && scope !== 'xhs') continue;
    const name = str(raw.name, 24).trim();
    if (!name) continue;
    const verified = str(raw.verified, 8).trim();
    const storyStamp = stampInput(raw.storyStamp);
    const cover = str(raw.cover, 400).trim();
    const profile: SocialAuthorProfile = {
      scope,
      name,
      signature: str(raw.signature, 120).trim(),
      following: str(raw.following, 16).trim(),
      followers: str(raw.followers, 16).trim(),
      likes: str(raw.likes, 16).trim(),
      createdAt: num(raw.createdAt, Date.now()),
      ...(verified === 'orange' || verified === 'gold' || verified === 'blue' ? { verified: verified as SocialAuthorProfile['verified'] } : {}),
      ...(storyStamp ? { storyStamp } : {}),
      ...(cover ? { cover } : {}),
    };
    out.set(socialAuthorProfileKey(scope, name), profile);
  }
  if (!out.size) return undefined;
  const lru = [...out.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, MAX_AUTHOR_PROFILES);
  return Object.fromEntries(lru);
}

/** 作者资料写缓存（原地改；key 冲突覆盖，超出 LRU 裁最旧）。 */
export function upsertSocialAuthorProfile(social: SocialData, profile: SocialAuthorProfile): void {
  const key = socialAuthorProfileKey(profile.scope, profile.name);
  const next = { ...(social.authorProfiles || {}), [key]: profile };
  const entries = Object.values(next).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_AUTHOR_PROFILES);
  const capped: Record<string, SocialAuthorProfile> = {};
  for (const p of entries) capped[socialAuthorProfileKey(p.scope, p.name)] = p;
  social.authorProfiles = capped;
}

/**
 * 关注帖豁免集合（滚动删除池：贴吧=帖属关注吧；微博/小红书=帖主已关注）。
 * mergeScrollPosts 的 keepIds 入参——关注帖不被滚动淘汰、不占公共上限（混合块/世界书注入口径不受影响）。
 */
export function socialFollowKeepIds(
  kind: Exclude<SocialKind, 'moments'>,
  posts: ReadonlyArray<{ id: string; author?: string; bar?: string }>,
  follows: SocialFollows | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!follows) return out;
  if (kind === 'tieba') {
    if (!follows.bars.length) return out;
    const bars = new Set(follows.bars);
    for (const p of posts) if (p.bar && bars.has(p.bar)) out.add(p.id);
    return out;
  }
  const names = new Set(kind === 'weibo' ? follows.weibo : follows.xhs);
  if (!names.size) return out;
  for (const p of posts) if (p.author && names.has(p.author)) out.add(p.id);
  return out;
}

/** SocialData 归一化；空/非法输入返回 null（PhoneChatData.social 保持 optional，不占空数据形状）。 */
export function normalizeSocialData(value: unknown): SocialData | null {
  if (!isRecord(value)) return null;
  const rawMoments = Array.isArray(value.moments)
    ? value.moments.map(normalizeMomentPost).filter((p): p is MomentPost => p !== null)
    : [];
  const rawTieba = Array.isArray(value.tieba)
    ? value.tieba.map(normalizeTiebaPost).filter((p): p is TiebaPost => p !== null)
    : [];
  const rawWeibo = Array.isArray(value.weibo)
    ? value.weibo.map(normalizeWeiboPost).filter((p): p is WeiboPost => p !== null)
    : [];
  const rawXhs = Array.isArray(value.xhs)
    ? value.xhs.map(normalizeXhsNote).filter((n): n is XhsNote => n !== null)
    : [];
  const rawBars = Array.isArray(value.bars)
    ? value.bars.map(normalizeTiebaBar).filter((b): b is TiebaBar => b !== null)
    : [];
  const rawTrending = Array.isArray(value.trending)
    ? value.trending.map(normalizeTrendingItem).filter((t): t is TrendingItem => t !== null)
    : [];
  const rawPending = normalizeSocialActions(value.pending);
  const rawFollows = normalizeSocialFollows(value.follows);
  const rawAuthorProfiles = normalizeSocialAuthorProfiles(value.authorProfiles);
  // 旧存档的 `unread` 平台计数（2026-10 统一前的第二套未读）在此丢弃：它只是「有新内容」的提示，
  // 丢弃后角标随下一次新内容/互动重新累计；不做猜测式迁移（计数说不出是哪几条帖）。
  const rawNotifications = normalizeSocialNotifications(value.notifications);
  // 论坛 legacy：原样保留（不再生成/渲染，避免存量数据丢失）
  const legacyForum = Array.isArray(value.forum)
    ? value.forum.map(normalizeForumPost).filter((p): p is ForumPost => p !== null)
    : [];
  if (!rawMoments.length && !rawTieba.length && !rawWeibo.length && !rawXhs.length && !rawTrending.length && !rawPending.length && !rawFollows) return null;
  return {
    // 载入期安全上限=硬顶（80）；运行期按共享设置 socialMaxPosts 收敛（mergeMomentPosts 传参）
    moments: rawMoments.slice(0, MAX_SOCIAL_POSTS_CAP),
    tieba: rawTieba,
    weibo: rawWeibo,
    xhs: rawXhs,
    bars: rawBars.slice(0, MAX_BARS),
    trending: rawTrending.slice(0, MAX_TRENDING_ITEMS),
    ...(rawFollows ? { follows: rawFollows } : {}),
    ...(rawAuthorProfiles ? { authorProfiles: rawAuthorProfiles } : {}),
    refreshedAt: num(value.refreshedAt, Date.now()),
    pending: rawPending,
    ...(rawNotifications.length ? { notifications: rawNotifications } : {}),
    ...(legacyForum.length ? { forum: legacyForum } : {}),
  };
}

// ─── 未读通知流（四平台唯一的未读事实源；逐条已读） ───

/** 通知归一化（磁盘读回容错；kind 限四平台、必填字段缺失丢弃、新→旧、容量截断）。 */
function normalizeSocialNotifications(value: unknown): SocialNotification[] {
  if (!Array.isArray(value)) return [];
  const out: SocialNotification[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const kind = str(raw.kind, 12).trim();
    if (kind !== 'moments' && kind !== 'tieba' && kind !== 'weibo' && kind !== 'xhs') continue;
    const type = str(raw.type, 10).trim();
    if (type !== 'post' && type !== 'comment' && type !== 'reply') continue;
    const postId = str(raw.postId, 80).trim();
    const author = str(raw.author, 40).trim();
    const content = str(raw.content, 160).trim();
    if (!postId || !author) continue;
    const notif: SocialNotification = {
      id: str(raw.id, 60).trim() || makeSocialNotificationId(),
      kind,
      type,
      postId,
      author,
      content,
      time: str(raw.time, 24).trim(),
      createdAt: num(raw.createdAt, Date.now()),
    };
    const stamp = stampInput(raw.storyStamp);
    if (stamp) notif.storyStamp = stamp;
    if (raw.read === true) notif.read = true;
    out.push(notif);
  }
  return out.slice(0, MAX_SOCIAL_NOTIFICATIONS);
}

/** 平台通知流（新→旧；无通知=空数组）。 */
export function socialNotificationsOf(social: SocialData | null | undefined, kind: SocialKind): SocialNotification[] {
  return (social?.notifications || []).filter(n => n.kind === kind);
}

/** 平台未读通知数（消息 tab 徽标读值）。 */
export function socialNotificationUnread(social: SocialData | null | undefined, kind: SocialKind): number {
  return socialNotificationsOf(social, kind).filter(n => !n.read).length;
}

/** 单帖关联未读通知数（详情打开前零写盘守卫用）。 */
export function socialPostNotificationUnread(social: SocialData | null | undefined, kind: SocialKind, postId: string): number {
  return (social?.notifications || []).filter(n => n.kind === kind && n.postId === postId && !n.read).length;
}

/**
 * 追加通知（原地改；新条目排最前）：同键（平台+帖子+类型+作者+内容）去重防重复计数，
 * 总量截到 MAX_SOCIAL_NOTIFICATIONS（最旧裁剪）。空输入零改动。
 */
export function addSocialNotifications(social: SocialData, items: SocialNotification[]): void {
  if (!items.length) return;
  const seen = new Set((social.notifications || []).map(n => `${n.kind}\u0001${n.postId}\u0001${n.type}\u0001${n.author}\u0001${n.content}`));
  const fresh: SocialNotification[] = [];
  for (const n of items) {
    const key = `${n.kind}\u0001${n.postId}\u0001${n.type}\u0001${n.author}\u0001${n.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(n);
  }
  if (!fresh.length) return;
  social.notifications = [...fresh, ...(social.notifications || [])].slice(0, MAX_SOCIAL_NOTIFICATIONS);
}

/** 打开帖子详情 → 该帖全部通知标已读（任何入口统一钩子；返回是否有变化——无未读零写盘）。 */
export function markSocialNotificationsForPost(social: SocialData, kind: SocialKind, postId: string): boolean {
  if (!social.notifications?.length) return false;
  let changed = false;
  for (const n of social.notifications) {
    if (n.kind === kind && n.postId === postId && !n.read) {
      n.read = true;
      changed = true;
    }
  }
  return changed;
}

/** 平台通知全部已读（「全部已读」按钮；返回是否有变化——无未读零写盘）。 */
export function markAllSocialNotificationsRead(social: SocialData, kind: SocialKind): boolean {
  if (!social.notifications?.length) return false;
  let changed = false;
  for (const n of social.notifications) {
    if (n.kind === kind && !n.read) {
      n.read = true;
      changed = true;
    }
  }
  return changed;
}

/** 快照读值（无 social 域时空对象，调用方按需初始化）。 */
export function readSocialOf(data: { social?: SocialData | null }): SocialData {
  return data.social || { moments: [], tieba: [], weibo: [], xhs: [], bars: [], trending: [], refreshedAt: 0, pending: [] };
}

/** 关注对象新帖判定：贴吧按吧、微博/小红书按作者（follows 域口径，与首页关注分段一致）。
 *  朋友圈不进关注体系（无 follows 分段）⇒ 恒 false。 */
export function isFollowedPost(kind: SocialKind, post: TiebaPost | WeiboPost | XhsNote | MomentPost, follows: SocialFollows | undefined): boolean {
  if (!follows) return false;
  if (kind === 'tieba') return follows.bars.includes((post as TiebaPost).bar);
  if (kind === 'weibo') return follows.weibo.includes((post as WeiboPost).author);
  if (kind === 'xhs') return follows.xhs.includes((post as XhsNote).author);
  return false;
}

/** 新帖 → 未读通知（四平台同构，**社媒「有新内容」的唯一入口**）。
 *  content 摘要取该平台的主文本：微博/朋友圈=正文，贴吧/小红书=标题。
 *  follows 传入=只收关注对象的新帖（社媒引擎自己刷新时的口径：用户正在看）；
 *  **不传=全量收**（世界演化投递：帖是场外异步出现的，无论是否关注都要变成逐条未读）。 */
export function postNotificationsOf(
  kind: SocialKind,
  posts: ReadonlyArray<MomentPost | TiebaPost | WeiboPost | XhsNote>,
  follows?: SocialFollows,
): SocialNotification[] {
  const out: SocialNotification[] = [];
  for (const p of posts) {
    if (follows && !isFollowedPost(kind, p, follows)) continue;
    const body = kind === 'weibo' ? (p as WeiboPost).text
      : kind === 'moments' ? (p as MomentPost).text
        : (p as TiebaPost | XhsNote).title;
    const stamp = postStoryStamp(p);
    out.push({
      id: makeSocialNotificationId(),
      kind,
      type: 'post',
      postId: p.id,
      author: p.author,
      content: socialExcerpt(body, 40),
      time: (p.timeLabel || '').trim(),
      ...(stamp ? { storyStamp: stamp } : {}),
      createdAt: Date.now(),
    });
  }
  return out;
}

// ─── 快照合并（纯函数：刷新落盘口径） ───

/**
 * 朋友圈滚动窗口合并：新帖在前去重合并（同 id 保留新值），裁剪到上限。
 */
export function mergeMomentPosts(existing: MomentPost[], fresh: MomentPost[], cap = MAX_MOMENT_POSTS): MomentPost[] {
  const byId = new Map<string, MomentPost>();
  for (const p of [...fresh, ...existing]) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return Array.from(byId.values()).slice(0, cap);
}

/**
 * 通用滚动窗口合并（贴吧/微博/小红书共用）：本版帖子为头部，旧帖中 id 不同的追加为可回看历史，
 * 裁剪到上限（=共享设置 socialMaxPosts；刷新换血但旧帖沉底可翻）。
 * keepIds=关注帖豁免集合——豁免帖不被滚动淘汰、不占公共上限（总硬顶 MAX_SOCIAL_POSTS_CAP 兜底防无界）。
 */
export function mergeScrollPosts<T extends { id: string; pinned?: boolean }>(existing: T[], fresh: T[], cap: number, keepIds?: ReadonlySet<string>): T[] {
  const freshIds = new Set(fresh.map(p => p.id));
  const history = existing.filter(p => !freshIds.has(p.id) && !p.pinned);
  const all = [...fresh, ...history];
  if (!keepIds || !keepIds.size) return all.slice(0, Math.max(1, cap));
  const limit = Math.max(1, cap);
  const kept: T[] = [];
  let publicCount = 0;
  let keepCount = 0;
  for (const p of all) {
    if (keepIds.has(p.id)) {
      if (keepCount >= MAX_SOCIAL_POSTS_CAP) continue;
      keepCount++;
    } else {
      if (publicCount >= limit) continue;
      publicCount++;
    }
    kept.push(p);
  }
  return kept;
}

// ─── 信息流分页（渲染层口径：首屏只渲染最近 N 条，触底增量加载更早帖子） ───

/** 信息流分页大小：初屏渲染条数 = 每次触底追加条数（新帖在前，旧帖沉底可翻）。 */
export const FEED_PAGE_SIZE = 10;

/**
 * 信息流分页切片：取前 visible 条为可见页（visible 由各 App 会话状态递增），
 * 返回可见页 + 是否还有更多 + 未渲染余量（触底提示行文案用）。
 */
export function paginateFeed<T>(items: T[], visible: number): { page: T[]; hasMore: boolean; remaining: number } {
  const shown = Math.max(0, Math.floor(visible) || 0);
  const hasMore = items.length > shown;
  return { page: items.slice(0, shown), hasMore, remaining: hasMore ? items.length - shown : 0 };
}

/** 热搜整版重写（每版换血，无历史包袱；榜单条目按 AI 输出顺序即排名）。 */
export function replaceTrending(fresh: TrendingItem[]): TrendingItem[] {
  return fresh.slice(0, MAX_TRENDING_ITEMS);
}

/** 吧列表整版重写。 */
export function replaceBars(fresh: TiebaBar[]): TiebaBar[] {
  return fresh.slice(0, MAX_BARS);
}

/** 删除主角的帖子（按 id；关联的待反馈动作与通知一并作废）。纯函数，返回新 SocialData。 */
export function deleteUserPosts(social: SocialData, kind: SocialKind, ids: string[]): SocialData {
  const idSet = new Set(ids);
  if (!idSet.size) return social;
  const next: SocialData = { ...social };
  if (kind === 'moments') next.moments = social.moments.filter(p => !idSet.has(p.id));
  else if (kind === 'tieba') next.tieba = social.tieba.filter(p => !idSet.has(p.id));
  else if (kind === 'weibo') next.weibo = social.weibo.filter(p => !idSet.has(p.id));
  else next.xhs = social.xhs.filter(p => !idSet.has(p.id));
  if (social.pending) next.pending = social.pending.filter(a => !(a.target === kind && idSet.has(a.postId)));
  if (social.notifications?.length) {
    next.notifications = social.notifications.filter(n => !(n.kind === kind && idSet.has(n.postId)));
    if (!next.notifications.length) delete next.notifications;
  }
  return next;
}

/** 帖子列表摘要（正文前 n 字，列表页展示；详情页渲染全文）。 */
export function socialExcerpt(content: string, max = 52): string {
  return excerptText(content, max);
}

/** 微博文与话题是否相关（topic 字段互含或正文包含词条；话题页过滤与引擎定点共用）。 */
export function weiboMatchesTopic(post: WeiboPost, topic: string): boolean {
  const norm = topic.replace(/^#|#$/g, '').trim();
  if (!norm) return false;
  const postTopic = (post.topic || '').replace(/^#|#$/g, '').trim();
  if (postTopic && (postTopic.includes(norm) || norm.includes(postTopic))) return true;
  return post.text.includes(norm);
}

/** 小红书笔记与搜索话题是否相关（标签/标题/正文命中；搜索结果页与引擎关键词定点共用）。 */
export function xhsMatchesTopic(note: XhsNote, topic: string): boolean {
  const norm = topic.replace(/^#|#$/g, '').trim();
  if (!norm) return false;
  if (note.tags.some(t => {
    const tag = t.replace(/^#/, '').trim();
    return Boolean(tag) && (tag.includes(norm) || norm.includes(tag));
  })) return true;
  return note.title.includes(norm) || note.content.includes(norm);
}

/** 贴吧帖与搜索关键词是否相关（标题/正文/吧名命中；搜索结果页与引擎关键词定点共用）。 */
export function tiebaMatchesKeyword(post: TiebaPost, keyword: string): boolean {
  const norm = keyword.trim();
  if (!norm) return false;
  return post.title.includes(norm) || post.content.includes(norm) || post.bar.includes(norm);
}

// ─── 评论追加与反馈合并（互动层落盘口径） ───

/**
 * 评论追加（去重 + 超限裁剪）：同「名+文」视为重复丢弃；超上限从最旧开始裁
 * 非主角评论（主角/用户的发言永不被挤掉——增量协议「失败也不丢用户输入」的落盘侧）。
 */
export function appendSocialComments(existing: SocialComment[], incoming: SocialComment[], me: string, cap = MAX_COMMENTS_PER_POST): SocialComment[] {
  const seen = new Set(existing.map(c => `${c.name}\u0001${c.text}`));
  const merged = [...existing];
  for (const c of incoming) {
    const key = `${c.name}\u0001${c.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  while (merged.length > cap) {
    // 裁剪保护：主角评论与用户匿名评论永不被挤掉（只裁 AI/路人评论）
    const idx = merged.findIndex(c => c.name !== me && !c.anon);
    if (idx === -1) break;
    merged.splice(idx, 1);
  }
  return merged;
}

/** 反馈评论盖规范绝对故事时间戳（锚=反馈时刻的全局「当前时间」快照；解析失败不盖，显示回退原文）。 */
export function stampFeedbackComment(comment: SocialComment, anchor?: string): SocialComment {
  if (!anchor || comment.storyStamp) return comment;
  const stamp = normalizeStoryTimeLabel(comment.time || '', anchor);
  return stamp ? { ...comment, storyStamp: stamp } : comment;
}

function mergeCountedFeedback(
  posts: Array<{ id: string; comments: SocialComment[] }>,
  items: SocialFeedback[],
  target: SocialKind,
  me: string,
  anchor?: string,
): Map<string, SocialComment[]> {
  const byId = new Map<string, SocialComment[]>();
  for (const fb of items) {
    if (fb.target !== target) continue;
    if (!fb.comments.length) continue;
    const list = byId.get(fb.postId) || [];
    list.push(...fb.comments.map(c => stampFeedbackComment(c, anchor)));
    byId.set(fb.postId, list);
  }
  void posts;
  void me;
  return byId;
}

/** AI 反馈合并进朋友圈旧帖（点赞入名单去重 + 评论追加；anchor=反馈时故事时间快照，盖评论绝对戳）。 */
export function mergeMomentFeedback(posts: MomentPost[], items: SocialFeedback[], me: string, anchor?: string): MomentPost[] {
  const byId = new Map<string, SocialFeedback[]>();
  for (const fb of items) {
    if (fb.target !== 'moments') continue;
    if (!fb.likes.length && !fb.comments.length) continue;
    const list = byId.get(fb.postId) || [];
    list.push(fb);
    byId.set(fb.postId, list);
  }
  if (!byId.size) return posts;
  return posts.map(post => {
    const fbs = byId.get(post.id);
    if (!fbs) return post;
    const likes = Array.from(new Set([
      ...post.likes,
      ...fbs.flatMap(fb => fb.likes).filter(n => n && n !== post.author && n !== me),
    ])).slice(0, MAX_MOMENT_LIKES);
    return { ...post, likes, comments: appendSocialComments(post.comments, fbs.flatMap(fb => fb.comments).map(c => stampFeedbackComment(c, anchor)), me) };
  });
}

/** AI 反馈合并进贴吧帖子（只合并楼层评论；贴吧点赞是计数）。 */
export function mergeTiebaFeedback(posts: TiebaPost[], items: SocialFeedback[], me: string, anchor?: string): TiebaPost[] {
  const byId = mergeCountedFeedback(posts, items, 'tieba', me, anchor);
  if (!byId.size) return posts;
  return posts.map(post => {
    const incoming = byId.get(post.id);
    if (!incoming) return post;
    return { ...post, comments: appendSocialComments(post.comments, incoming, me) };
  });
}

/** AI 反馈合并进微博博文（评论进热评；likes 忽略——微博点赞是计数）。 */
export function mergeWeiboFeedback(posts: WeiboPost[], items: SocialFeedback[], me: string, anchor?: string): WeiboPost[] {
  const byId = mergeCountedFeedback(posts, items, 'weibo', me, anchor);
  if (!byId.size) return posts;
  return posts.map(post => {
    const incoming = byId.get(post.id);
    if (!incoming) return post;
    return { ...post, comments: appendSocialComments(post.comments, incoming, me) };
  });
}

/** AI 反馈合并进小红书笔记（作者/路人回复评论）。 */
export function mergeXhsFeedback(posts: XhsNote[], items: SocialFeedback[], me: string, anchor?: string): XhsNote[] {
  const byId = mergeCountedFeedback(posts, items, 'xhs', me, anchor);
  if (!byId.size) return posts;
  return posts.map(post => {
    const incoming = byId.get(post.id);
    if (!incoming) return post;
    return { ...post, comments: appendSocialComments(post.comments, incoming, me) };
  });
}

/**
 * 评论楼中楼分组（真实 App 口径）：无 replyTo（或自回复）的为顶层；
 * 回复沿「名字指针」解析到最近前驱评论，若目标是别的回复则继续向上爬，
 * 全部子孙扁平化挂进根评论的 replies（楼中楼内的对话不再溢出为顶层）；
 * replyTo 指向不存在的名字（如已被删除）时归顶层（UI 保留「回复 @」前缀显示）。
 * parentOf 只指向更早的评论，向上爬必然终止。
 */
export interface ThreadedComment {
  comment: SocialComment;
  replies: SocialComment[];
}

export function buildCommentThreads(comments: SocialComment[]): ThreadedComment[] {
  const parentOf = new Map<SocialComment, SocialComment>();
  const lastByName = new Map<string, SocialComment>();
  for (const c of comments) {
    if (c.replyTo && c.replyTo !== c.name) {
      const parent = lastByName.get(c.replyTo);
      if (parent) parentOf.set(c, parent);
    }
    lastByName.set(c.name, c);
  }
  const threads: ThreadedComment[] = [];
  const rootOf = new Map<SocialComment, ThreadedComment>();
  for (const c of comments) {
    if (!parentOf.has(c)) {
      const thread: ThreadedComment = { comment: c, replies: [] };
      threads.push(thread);
      rootOf.set(c, thread);
    }
  }
  for (const c of comments) {
    let parent = parentOf.get(c);
    if (!parent) continue;
    while (parentOf.has(parent)) parent = parentOf.get(parent)!;
    rootOf.get(parent)!.replies.push(c);
  }
  return threads;
}

/**
 * 删除一条评论及其整棵子回复（楼中楼按名字指针成链：replyTo 指向已删者名的回复连带，
 * 逐层传递到孙回复）。纯函数返回新数组；index 越界原样返回（零改动）。
 */
export function removeCommentThread(comments: SocialComment[], index: number): SocialComment[] {
  const target = comments[index];
  if (!target) return comments;
  const gone = new Set<string>([target.name]);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of comments) {
      if (c.replyTo && gone.has(c.replyTo) && !gone.has(c.name)) {
        gone.add(c.name);
        changed = true;
      }
    }
  }
  return comments.filter((c, i) => i !== index && !gone.has(c.name));
}

// ─── 混合时间线适配（贴吧/微博/小红书 → 通用帖子视图；排序/过滤在 phone-timeline） ───

/** 混合时间线通用社媒帖子（贴吧/微博/小红书共用视图；moments 走自己的候选构建器）。 */
export interface SocialTimelinePost {
  id: string;
  platform: Exclude<SocialKind, 'moments'>;
  author: string;
  /** 首行正文（标题/正文已拼装）。 */
  text: string;
  imageDesc?: string;
  comments: Array<{ name: string; text: string; replyTo?: string }>;
  timeLabel: string;
  /** 规范绝对故事时间戳（混合时间线条目时间戳用；存量数据在适配时惰性归一）。 */
  storyStamp?: string;
  createdAt: number;
}

function toTimelinePost(platform: SocialTimelinePost['platform'], id: string, author: string, text: string, imageDesc: string, comments: SocialComment[], timeLabel: string, createdAt: number, storyStamp?: string): SocialTimelinePost {
  return {
    id,
    platform,
    author,
    text,
    ...(imageDesc ? { imageDesc } : {}),
    comments: comments.map(c => ({ name: c.name, text: c.text, ...(c.replyTo ? { replyTo: c.replyTo } : {}) })),
    timeLabel,
    ...(storyStamp ? { storyStamp } : {}),
    createdAt,
  };
}

export function tiebaTimelinePosts(posts: TiebaPost[]): SocialTimelinePost[] {
  return posts.map(p => toTimelinePost('tieba', p.id, p.author, `${p.title}：${p.content}`, p.imageDesc, p.comments, p.timeLabel, p.createdAt, postStoryStamp(p) || undefined));
}

export function weiboTimelinePosts(posts: WeiboPost[]): SocialTimelinePost[] {
  return posts.map(p => {
    const repost = p.repost ? `（转发 @${p.repost.author}：${p.repost.text.slice(0, 60)}）` : '';
    return toTimelinePost('weibo', p.id, p.author, `${p.text}${repost}`, p.images[0]?.desc || '', p.comments, p.timeLabel, p.createdAt, postStoryStamp(p) || undefined);
  });
}

export function xhsTimelinePosts(notes: XhsNote[]): SocialTimelinePost[] {
  return notes.map(n => toTimelinePost('xhs', n.id, n.author, `${n.title}：${n.content}`, n.imageDesc, n.comments, n.timeLabel, n.createdAt, postStoryStamp(n) || undefined));
}
