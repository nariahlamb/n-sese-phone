// ===== 世界演化联动（主项目 doEvolve 落盘后经宿主 window.__ubp_world_inject 推送事件） =====
// 数据写链在本模块（core 层）：消息→微信私聊会话+未读；来电→incoming/missed 通话记录；
// 社媒帖→对应平台信息流（复用 social-model 的 normalize/merge，与社媒引擎刷新产物同构融合）
// + 平台未读累计（打开对应 App 清零，悬浮球/桌面角标同微信消息口径）。
// 来电开场白不落库（接听后才经 revealLines 逐条转写进 lines；刷新/占线丢失=未接语义）。
// UI 触发由 index.ts 经 onApplied 回调接线（core 不 import renderers）。

import {
  addCallRecord,
  makeCallRecordId,
  type CallRecord,
} from './call-model';
import {
  appendMessage,
  ensurePrivateConversation,
  makeMessageId,
  normalizePhoneMessage,
  type PhoneChatData,
} from './chat-model';
import { hostWindow } from './host-env';
import { getPhoneSettings } from './phone-settings';
import { resolveAvatarPath } from './phone-avatars';
import { mutatePhoneData, phoneStoreStatus, readPhoneDataRef } from './phone-store';
import {
  MAX_SOCIAL_POSTS_DEFAULT,
  addSocialNotifications,
  mergeMomentPosts,
  mergeScrollPosts,
  normalizeMomentPost,
  normalizeTiebaPost,
  normalizeWeiboPost,
  normalizeXhsNote,
  postNotificationsOf,
  readSocialOf,
  type MomentPost,
  type SocialComment,
  type TiebaPost,
  type WeiboPost,
  type XhsNote,
} from './social-model';
import { getRoster } from './roster';
import { normalizeStoryTimeLabel } from './social-time';

/** 世界演化推来的主动联系/社媒帖事件（与主项目 WorldPhoneEvent 结构一致，桥上只走 JSON）。
 *  kind='money'：货币系统正文提取的转账/红包（主扩展 currency-prose → __ubp_world_inject）。 */
export interface WorldPhoneLinkEvent {
  kind: 'message' | 'call' | 'social' | 'money';
  name: string;
  /** message/social：消息 / 帖子正文。 */
  text?: string;
  /** call：接通后的开场白（接听时投递）。 */
  lines?: string[];
  /** call：对方此刻内心想法（玩家元信息）。 */
  thought?: string;
  /** social：平台。 */
  platform?: 'moments' | 'tieba' | 'weibo' | 'xhs';
  /** social：帖子标题（tieba/xhs）。 */
  title?: string;
  /** social：贴吧吧名（tieba 必填）。 */
  bar?: string;
  /** social：配图画面描述（空 = 无图）。 */
  image?: string;
  /** social：评论区（主项目已完整产出）。 */
  comments?: SocialComment[];
  /** social：点赞人名（仅朋友圈）。 */
  likes?: string[];
  /** money：转账/红包。 */
  moneyKind?: 'transfer' | 'redpacket';
  /** money：in=对方给主角 / out=主角给对方（out 的消息 from='me'）。 */
  direction?: 'in' | 'out';
  /** money：金额（正数）。 */
  amount?: number;
  /** money：币种名快照（缺省由手机侧回落常用货币）。 */
  currency?: string;
  /** money：留言/祝词。 */
  note?: string;
}

/** 单轮事件上限（提示词约定联动内容合计 1-3 份，此为容错上限）。 */
export const WORLD_LINK_EVENTS_MAX = 8;
const NAME_MAX = 60;
const TEXT_MAX = 300;
const LINES_MAX = 6;
const LINE_CHARS = 120;
const THOUGHT_CHARS = 200;
const SOCIAL_TITLE_CHARS = 60;
const SOCIAL_COMMENT_CHARS = 120;
const SOCIAL_IMAGE_CHARS = 160;
const SOCIAL_COMMENTS_MAX = 6;
const SOCIAL_LIKES_MAX = 4;
/** 社媒帖正文/标题/吧名上限（用户定案 1000）：与 story-link 的 SOCIAL_*_MAX 同值，
 *  且不得高于 social-model 各平台帖模型的对应上限（否则帖子在落库/读盘时被二次砍短）。 */
const SOCIAL_POST_TEXT_CHARS = 1000;
const SOCIAL_POST_TITLE_CHARS = 1000;
const SOCIAL_POST_BAR_CHARS = 1000;
export type SocialPlatform = NonNullable<WorldPhoneLinkEvent['platform']>;
const SOCIAL_PLATFORMS: readonly SocialPlatform[] = ['moments', 'tieba', 'weibo', 'xhs'];

function isSocialPlatform(v: unknown): v is SocialPlatform {
  return typeof v === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(v);
}

/** 事件净化（桥上结构校验；超限截断）。按名屏蔽已废弃——主角与角色同名时会误杀角色事件。 */
export function normalizeWorldLinkEvent(value: unknown): WorldPhoneLinkEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind === 'message' || raw.kind === 'call' || raw.kind === 'social' || raw.kind === 'money' ? raw.kind : null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, NAME_MAX) : '';
  if (!kind || !name) return null;
  const out: WorldPhoneLinkEvent = { kind, name };
  if (kind === 'money') {
    const moneyKind = raw.moneyKind === 'transfer' || raw.moneyKind === 'redpacket' ? raw.moneyKind : null;
    const direction = raw.direction === 'out' ? 'out' : 'in';
    const amount = Number(raw.amount);
    if (!moneyKind || !Number.isFinite(amount) || amount <= 0) return null;
    out.moneyKind = moneyKind;
    out.direction = direction;
    out.amount = amount;
    if (typeof raw.currency === 'string' && raw.currency.trim()) out.currency = raw.currency.trim().slice(0, 20);
    if (typeof raw.note === 'string' && raw.note.trim()) out.note = raw.note.trim().slice(0, 100);
    return out;
  }
  if (kind === 'message') {
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, TEXT_MAX) : '';
    if (!text) return null;
    out.text = text;
    return out;
  }
  if (kind === 'call') {
    const lines = Array.isArray(raw.lines)
      ? raw.lines.filter((l): l is string => typeof l === 'string' && Boolean(l.trim()))
        .map(l => l.trim().slice(0, LINE_CHARS)).slice(0, LINES_MAX)
      : [];
    if (!lines.length) return null; // 无开场白的来电没有交付物，丢弃
    out.lines = lines;
    if (typeof raw.thought === 'string' && raw.thought.trim()) out.thought = raw.thought.trim().slice(0, THOUGHT_CHARS);
    return out;
  }
  // social：平台枚举校验 + 帖子必备字段 + 评论区/点赞净化
  if (!isSocialPlatform(raw.platform)) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, SOCIAL_POST_TEXT_CHARS) : '';
  if (!text) return null;
  out.platform = raw.platform;
  out.text = text;
  if (out.platform === 'tieba') {
    const bar = typeof raw.bar === 'string' ? raw.bar.trim().slice(0, SOCIAL_POST_BAR_CHARS) : '';
    if (!bar) return null; // 吧名是贴吧数据模型硬必填
    out.bar = bar;
  }
  if (out.platform === 'tieba' || out.platform === 'xhs') {
    const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, SOCIAL_POST_TITLE_CHARS) : '';
    if (!title) return null;
    out.title = title;
  }
  const image = typeof raw.image === 'string' ? raw.image.trim().slice(0, SOCIAL_IMAGE_CHARS) : '';
  if (image && image.toLowerCase() !== 'none') out.image = image;
  const comments: SocialComment[] = [];
  for (const c of (Array.isArray(raw.comments) ? raw.comments : []).slice(0, SOCIAL_COMMENTS_MAX)) {
    if (!c || typeof c !== 'object') continue;
    const cr = c as Record<string, unknown>;
    const cname = typeof cr.name === 'string' ? cr.name.trim().slice(0, SOCIAL_TITLE_CHARS) : '';
    const ctext = typeof cr.text === 'string' ? cr.text.trim().slice(0, SOCIAL_COMMENT_CHARS) : '';
    if (!cname || !ctext) continue;
    const comment: SocialComment = { name: cname, text: ctext };
    const replyTo = typeof cr.replyTo === 'string' ? cr.replyTo.trim().slice(0, SOCIAL_TITLE_CHARS) : '';
    if (replyTo) comment.replyTo = replyTo;
    comments.push(comment);
  }
  if (comments.length) out.comments = comments;
  if (out.platform === 'moments' && Array.isArray(raw.likes)) {
    const likes = raw.likes
      .filter((n): n is string => typeof n === 'string' && Boolean(n.trim()))
      .map(n => n.trim().slice(0, SOCIAL_TITLE_CHARS)).slice(0, SOCIAL_LIKES_MAX);
    if (likes.length) out.likes = likes;
  }
  return out;
}

/** 事件应用结果（index.ts 据此触发 UI：call→来电全屏、message→微信刷新；social 落库即带平台未读，UI 只走 data-changed）。 */
export interface WorldPhoneApplyOutcome {
  event: WorldPhoneLinkEvent;
  ok: boolean;
  reason?: 'invalid-event';
  /** message：落到的会话 id。 */
  conversationId?: string;
  /** call：新建的通话记录 id。 */
  recordId?: string;
}

/** 事件批应用到手机数据（纯函数直改 data；测试直接调用）。 */
export function applyWorldPhoneEvents(
  data: PhoneChatData,
  events: readonly WorldPhoneLinkEvent[],
  ctx: { storyTime?: string; avatarFor?: (name: string) => string | undefined; maxPostsOf?: (kind: SocialPlatform) => number } = {},
): WorldPhoneApplyOutcome[] {
  const outcomes: WorldPhoneApplyOutcome[] = [];
  for (const ev of events.slice(0, WORLD_LINK_EVENTS_MAX)) {
    const cleaned = normalizeWorldLinkEvent(ev);
    if (!cleaned) {
      outcomes.push({ event: ev, ok: false, reason: 'invalid-event' });
      continue;
    }
    if (cleaned.kind === 'message') {
      const conv = ensurePrivateConversation(data, cleaned.name);
      appendMessage(conv, normalizePhoneMessage({
        id: makeMessageId(),
        from: cleaned.name,
        type: 'text',
        content: cleaned.text!,
        ts: Date.now(),
        ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
      })!);
      conv.unread += 1;
      outcomes.push({ event: cleaned, ok: true, conversationId: conv.id });
      continue;
    }
    if (cleaned.kind === 'money') {
      // 货币正文提取：转账/红包 → 手机消息（out=主角发出 from'me'；收到的红包 claimed=false 待拆）。
      // 记账由主扩展在提取时完成（转账即时 / 发出红包即扣款 / 收到红包拆开才入账），手机侧不重复记账。
      const conv = ensurePrivateConversation(data, cleaned.name);
      const isOut = cleaned.direction === 'out';
      const msg = normalizePhoneMessage({
        id: makeMessageId(),
        from: isOut ? 'me' : cleaned.name,
        type: cleaned.moneyKind!,
        content: cleaned.note || '',
        amount: Math.abs(cleaned.amount!).toFixed(2),
        ...(cleaned.currency ? { currency: cleaned.currency } : {}),
        ...(cleaned.moneyKind === 'redpacket' ? { claimed: isOut ? true : false } : {}),
        ts: Date.now(),
        ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
      });
      if (!msg) {
        outcomes.push({ event: cleaned, ok: false, reason: 'invalid-event' });
        continue;
      }
      appendMessage(conv, msg);
      if (!isOut) conv.unread += 1;
      outcomes.push({ event: cleaned, ok: true, conversationId: conv.id });
      continue;
    }
    if (cleaned.kind === 'social') {
      const post = buildWorldSocialPost(cleaned as WorldPhoneLinkEvent & { kind: 'social'; text: string; platform: SocialPlatform }, ctx);
      if (!post) {
        outcomes.push({ event: cleaned, ok: false, reason: 'invalid-event' });
        continue;
      }
      mergeWorldSocialPost(data, cleaned.platform!, post, ctx.maxPostsOf);
      outcomes.push({ event: cleaned, ok: true });
      continue;
    }
    const avatar = ctx.avatarFor?.(cleaned.name);
    const record: CallRecord = {
      id: makeCallRecordId(),
      peerName: cleaned.name,
      ...(avatar ? { peerAvatar: avatar } : {}),
      direction: 'incoming',
      status: 'missed',
      durationSec: 0,
      startedAt: Date.now(),
      ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
      ...(cleaned.thought ? { thought: cleaned.thought } : {}),
      lines: [],
      seen: false,
    };
    data.calls = addCallRecord(data.calls || [], record);
    outcomes.push({ event: cleaned, ok: true, recordId: record.id });
  }
  return outcomes;
}

/** 演化社媒帖 → 平台数据模型（复用社媒引擎同款 normalize 兜底；正文 #词 提取为小红书话题标签）。
 *  timeLabel/storyTime=演化时故事时间快照；storyStamp=快照的规范绝对时间戳（时间体系见 social-time）；
 *  imageDesc 只存描述，配图走既有占位生图管线。 */
export function buildWorldSocialPost(
  ev: WorldPhoneLinkEvent & { kind: 'social'; text: string; platform: SocialPlatform; srcMesId?: string },
  ctx: { storyTime?: string },
): MomentPost | TiebaPost | WeiboPost | XhsNote | null {
  const base = {
    author: ev.name,
    time: ctx.storyTime || undefined,
    storyTime: ctx.storyTime || undefined,
    storyStamp: normalizeStoryTimeLabel(ctx.storyTime || '', ctx.storyTime || '') || undefined,
    createdAt: Date.now(),
    // 正文联动（第五轮 ⑦）按楼层水印整层替换用；世界演化投递不带该字段（行为不变）
    ...(ev.srcMesId ? { srcMesId: ev.srcMesId } : {}),
  };
  const image = ev.image ? { image: ev.image } : {};
  const comments = ev.comments?.length ? { comments: ev.comments } : {};
  switch (ev.platform) {
    case 'moments':
      return normalizeMomentPost({
        ...base, ...image, ...comments,
        text: ev.text,
        ...(ev.likes?.length ? { likes: ev.likes } : {}),
      });
    case 'tieba':
      return normalizeTiebaPost({
        ...base, ...image, ...comments,
        bar: ev.bar, title: ev.title, content: ev.text,
      });
    case 'weibo':
      return normalizeWeiboPost({
        ...base, ...comments,
        author: ev.name, text: ev.text,
        ...(ev.image ? { images: [ev.image] } : {}),
      });
    case 'xhs':
      return normalizeXhsNote({
        ...base, ...image, ...comments,
        title: ev.title, content: ev.text,
        tags: (ev.text.match(/#([^\s#]{1,16})/g) || []).map(t => t.slice(1)).slice(0, 6),
      });
    default:
      return null;
  }
}

/** 演化社媒帖 merge 进对应平台信息流（既有滚动窗口 FIFO；上限=共享设置 socialMaxPosts）
 *  + **逐条未读通知**（四平台同构：内容型新帖也是一种未读记录，与社媒引擎共用 postNotificationsOf）——
 *    无论作者/吧是否被关注：演化帖是场外异步出现的，用户没在看，必须变成一条可逐条已读的未读，
 *    而不是另一种「平台计数、打开即清零」的第二套体系（2026-10 统一，用户拍板）。 */
export function mergeWorldSocialPost(
  data: PhoneChatData,
  platform: SocialPlatform,
  post: MomentPost | TiebaPost | WeiboPost | XhsNote,
  maxPostsOf?: (kind: SocialPlatform) => number,
): void {
  const cur = readSocialOf(data);
  if (platform === 'moments') {
    cur.moments = mergeMomentPosts(cur.moments, [post as MomentPost], getPhoneSettings().socialMaxPosts);
  } else {
    const cap = maxPostsOf?.(platform) ?? MAX_SOCIAL_POSTS_DEFAULT;
    if (platform === 'tieba') cur.tieba = mergeScrollPosts(cur.tieba, [post as TiebaPost], cap);
    else if (platform === 'weibo') cur.weibo = mergeScrollPosts(cur.weibo, [post as WeiboPost], cap);
    else cur.xhs = mergeScrollPosts(cur.xhs, [post as XhsNote], cap);
  }
  addSocialNotifications(cur, postNotificationsOf(platform, [post]));
  data.social = cur;
}

export interface WorldPhoneBridgeDeps {
  /** 事件落库后的 UI 接线（index.ts：来电开屏 / 微信刷新）。 */
  onApplied: (outcomes: WorldPhoneApplyOutcome[]) => void;
}

/** 注册宿主桥：主项目演化落盘后调 window.__ubp_world_inject(events) 推送；
 *  另注册只读 __ubp_phone_style()（返回当前聊天风格）供主项目世界演化按风格分支（docs/11 §7.4）。
 *  不设一次性 guard：酒馆助手不刷新页面重跑脚本时，旧实例闭包指向已销毁的存储，
 *  留着会让风格探测与事件注入静默失效——必须由最新实例接管；重复赋值天然幂等。 */
export function bindWorldPhoneBridge(deps: WorldPhoneBridgeDeps): void {
  const w = hostWindow() as unknown as Record<string, unknown>;
  w.__ubp_world_link_bound = true;
  w.__ubp_phone_style = (): string => {
    try {
      // 现代主题（style='' 的规范形态）必须显式上报 'modern'：宿主把 '' 当「手机离线」，
      // 返回 '' 会让货币世界书的转账/红包格式段（phoneStyleOnline 分支）永远漏拼。
      // 消费方校验已核对：currency-worldbook.phoneStyleOnline 收 'modern'；
      // world-evolution.findHostPhoneStyle 把非三幻值回退 ''（现代措辞），语义不变。
      const raw = readPhoneDataRef().style;
      return raw === 'xianxia' || raw === 'wuxia' || raw === 'fantasy' ? raw : 'modern';
    } catch (_e) {
      return ''; // 桥异常/存储不可用 = 真离线语义
    }
  };
  w.__ubp_world_inject = (events: unknown): number => {
    const list = Array.isArray(events) ? events : [];
    if (!list.length) return 0;
    const status = phoneStoreStatus();
    if (status.state !== 'ready' && status.state !== 'uninitialized') return 0; // 存储未就绪：丢弃（演化侧静默）
    const outcomes = mutatePhoneData(d => applyWorldPhoneEvents(d, list as WorldPhoneLinkEvent[], {
      storyTime: getRoster().global.time || undefined,
      avatarFor: resolveAvatarPath,
      maxPostsOf: () => getPhoneSettings().socialMaxPosts,
    }));
    try {
      deps.onApplied(outcomes);
    } catch (_e) { /* UI 故障不阻断落库结果 */ }
    return outcomes.filter(o => o.ok).length;
  };
}
