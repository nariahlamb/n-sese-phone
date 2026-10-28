// ===== 手机编年史聚合层（docs/25）=====
// 把散在各 App 里的生活记录并到同一条时间轴上：微信/窥私消息、通话、朋友圈与社媒三平台、
// 不夜城（通知 + 私信）、游戏对局、相册、**网上商城（下单/送达/取消，docs/52 §16.6）**。
// 它不是新数据——这些记录本来就都带时间，只是各处格式不一。
//
// 三条纪律（与通知中心同款）：
//  1. 零新增数据 —— 只读既有字段的 storyStamp（社媒/不夜城早已落盘；消息/通话/对局/相册由写侧自锚补齐，
//     见 chat-model / call-model / game-model / phone-album 的 normalize 与入档路径）。
//  2. 零拷贝 —— 全程只用 readPhoneDataRef()；编年史只在打开时聚合一次，关闭后本模块零开销。
//  3. 不猜时间 —— 解析不出绝对戳的记录一律不收录，只计数后在视图底部如实告知（宁可少收录，不编造时间）。
//
// 纯函数 + 零依赖（social-time 为叶子模块），可被单测直接调用。

import { callRecordPreview, type CallRecord } from './call-model';
import { messagePreviewText, type Conversation, type PhoneChatData, type PhoneMessage } from './chat-model';
import { gameTypeName, type GameRecord, type GameSummary, type GameType } from './game-model';
import { readPhoneDataRef } from './phone-store';
import { getRoster } from './roster';
import { appDisplayName, currentStyle, S } from './skins';
import { parseStamp, parseStoryAnchor, postStoryStamp, selfStamp, stampMinutes } from './social-time';

/** 编年史来源（= 桌面磁贴 id；'game' 无独立磁贴口径同通知中心）。 */
export type ChronicleSource =
  | 'wechat' | 'spy' | 'phone-call' | 'moments' | 'tieba' | 'weibo' | 'xhs' | 'night' | 'game' | 'album' | 'shop';

/** 一条编年史记录（渲染层直接消费；文案已在本层拼好）。 */
export interface ChronicleEntry {
  id: string;
  source: ChronicleSource;
  /** 来源标签（渲染层右侧小字，如「微信」「群聊」「电话 · 2 分 14 秒」）。 */
  sourceLabel: string;
  /** 分钟序号（日期序号×1440 + 当日分钟）：按天分组、同日排序、密度条定位都用它。 */
  at: number;
  /** 规范绝对故事时间戳。 */
  stamp: string;
  /** 时刻文案 HH:MM（左侧时间槽；无时刻成分=空串）。 */
  time: string;
  /** 主标题（人名 / 群名 / 吧名 / 游戏名）。 */
  title: string;
  /** 一行摘要。 */
  text: string;
  /** 计数小片（「赞 12」「未接」「好人阵营获胜」…）。 */
  chips?: string[];
  /** 相册缩略图（1-2 张；仅相册条目有）。 */
  thumbs?: string[];
  /** 合并的原始条数（会话分段用；1 不显示）。 */
  count?: number;
  /** 点击去处：目标 App +（可选）会话/消息定位 +（第六轮 ②）目标记录 id。
   *  `target` 走各 App **已有**的深链入口（与全局搜索同一口径）：裸 id 或带类型前缀
   *  （不夜城 post:/dm:、窥私通话 call:）。缺 id 的条目**不设** target（不留悬挂目标），
   *  目标 App 按既有回落渲染列表。 */
  open: { app: string; conv?: string; mid?: string; target?: string };
  /** 同刻排序兜底键（真实毫秒；仅排序用，不显示）。 */
  seq: number;
}

/** 同会话相邻消息超过此间隔（分钟）即断成两条——对齐真实时间线的「一段话说完就停」。 */
export const CHRONICLE_BURST_GAP_MINUTES = 120;
/** 默认首屏天数（往上滑再往前补）。 */
export const CHRONICLE_PAGE_DAYS = 7;

export interface ChronicleBuildResult {
  /** 时间升序（同日从早到晚）。 */
  entries: ChronicleEntry[];
  /** 有记录但时间不可解析、未收录的条数（底部如实告知；宁少不猜）。 */
  undated: number;
}

/** 取第一个可解析的绝对戳（storyStamp 优先，storyTime 自锚兜底）。 */
function stampFrom(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const value = (candidate || '').trim();
    if (!value || Number.isNaN(stampMinutes(value))) continue;
    return value;
  }
  return '';
}

/** 会话消息的绝对戳（写侧已盖；未盖的自锚兜底，相对说法解析失败=空）。 */
function messageStamp(message: PhoneMessage): string {
  return stampFrom(message.storyStamp, selfStamp(message.storyTime || ''));
}

/** 来源标签走 App 显示名皮肤（docs/11/15：传讯/飞鸽传书/晶讯…；night/game 无皮肤覆盖=回落原名）。 */
function appLabel(id: string, fallback: string): string {
  return appDisplayName(id, fallback, currentStyle());
}

/** 秒 → 「2 分 14 秒」（真机通话时长口语口径）。 */
function cnDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/** 群聊消息署名（私聊不加）。 */
function burstPreview(conv: Conversation, message: PhoneMessage, meLabel: string): string {
  const base = messagePreviewText(message);
  if (conv.kind !== 'group' || message.from === 'system') return base;
  return `${message.from === 'me' ? meLabel : message.from}：${base}`;
}

/** 社媒帖的最小形状（三平台字段名不同，取值时统一收口）。 */
interface SocialPostLike {
  id?: string;
  author?: string;
  bar?: string;
  title?: string;
  text?: string;
  content?: string;
  likes?: number | string[];
  comments?: unknown[];
  commentsCount?: number;
  replies?: number;
  collects?: number;
  timeLabel?: string;
  storyTime?: string;
  storyStamp?: string;
  createdAt?: number;
}

interface NightMsgLike {
  text?: string;
  image?: unknown;
  card?: { title?: string };
  timeLabel?: string;
  storyStamp?: string;
  ts?: number;
}

function nightMsgText(message: NightMsgLike): string {
  const text = (message.text || '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 40);
  if (message.image) return '[图片]';
  const card = message.card?.title?.trim();
  if (card) return card.slice(0, 40);
  return '（新消息）';
}

function chip(label: string, value: number): string[] {
  return value > 0 ? [`${label} ${value}`] : [];
}

/**
 * 聚合全部来源（时间升序）。只读引用（readPhoneDataRef）：调用方若随后写库须自行保证顺序。
 */
export function buildChronicle(data: PhoneChatData, meLabel = '我'): ChronicleBuildResult {
  const out: ChronicleEntry[] = [];
  let undated = 0;
  let seq = 0;

  const emit = (
    source: ChronicleSource,
    sourceLabel: string,
    stamp: string,
    realTs: number,
    title: string,
    text: string,
    open: ChronicleEntry['open'],
    extra: Partial<Pick<ChronicleEntry, 'chips' | 'thumbs' | 'count'>> = {},
  ): void => {
    const at = stampMinutes(stamp);
    if (Number.isNaN(at)) return;
    out.push({
      id: `${source}#${seq++}`,
      source,
      sourceLabel,
      at,
      stamp,
      time: parseStamp(stamp).time,
      title: title.trim() || sourceLabel,
      text,
      open,
      seq: realTs,
      ...(extra.chips?.length ? { chips: extra.chips } : {}),
      ...(extra.thumbs?.length ? { thumbs: extra.thumbs } : {}),
      ...(extra.count && extra.count > 1 ? { count: extra.count } : {}),
    });
  };

  // ── 微信 / 窥私：同会话按间隔分段（一段=一屏里连着说完的几句话）──
  const pushConversation = (conv: Conversation, app: string, label: string, labelGroup: string): void => {
    let run: PhoneMessage[] = [];
    let runAt = Number.NaN;
    const flush = (): void => {
      if (!run.length) return;
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const stamp = messageStamp(first);
      emit(
        app === 'spy' ? 'spy' : 'wechat',
        conv.kind === 'group' ? labelGroup : label,
        stamp,
        last.ts,
        conv.title,
        burstPreview(conv, last, meLabel),
        { app, conv: conv.id, mid: last.id },
        { count: run.length },
      );
      run = [];
      runAt = Number.NaN;
    };
    for (const message of conv.messages) {
      if (message.from === 'system') continue;
      const stamp = messageStamp(message);
      if (!stamp) { undated++; continue; }
      const at = stampMinutes(stamp);
      if (run.length && (at - runAt > CHRONICLE_BURST_GAP_MINUTES || at < runAt)) flush();
      if (!run.length) runAt = at;
      run.push(message);
    }
    flush();
  };

  for (const conv of data.conversations || []) pushConversation(conv, 'wechat', appLabel('wechat', '微信'), S('群聊', '共谈'));
  for (const conv of data.spy?.conversations || []) pushConversation(conv, 'spy', appLabel('spy', '窥私'), `${appLabel('spy', '窥私')} · ${S('群聊', '共谈')}`);

  // ── 通话（主角 + 窥私），未接/拒接带状态片 ──
  const pushCalls = (calls: readonly CallRecord[] | undefined, app: string, label: string): void => {
    for (const record of calls || []) {
      const stamp = stampFrom(record.storyStamp, selfStamp(record.storyTime || ''));
      if (!stamp) { undated++; continue; }
      const chips: string[] = [];
      if (record.status === 'missed') chips.push('未接');
      else if (record.status === 'rejected') chips.push(record.caller ? '未接通' : '对方拒接');
      else if (record.status === 'cancelled') chips.push('已取消');
      emit(
        app === 'spy' ? 'spy' : 'phone-call',
        record.durationSec > 0 ? `${label} · ${cnDuration(record.durationSec)}` : label,
        stamp,
        record.startedAt,
        record.peerName,
        callRecordPreview(record),
        // 第六轮 ②：带到那条记录。窥私 App 的通话与会话共用同一个深链槽，故通话加 call: 前缀区分。
        { app, ...(app === 'spy' ? { target: `call:${record.id}` } : { target: record.id }) },
        { chips },
      );
    }
  };
  pushCalls(data.calls, 'phone-call', appLabel('phone-call', '电话'));
  pushCalls(data.spy?.calls, 'spy', `${appLabel('spy', '窥私')} · ${appLabel('phone-call', '电话')}`);

  // ── 社媒：朋友圈 + 三平台 ──
  const pushPosts = (posts: readonly unknown[] | undefined, app: ChronicleSource, label: string, titleOf: (p: SocialPostLike) => string, textOf: (p: SocialPostLike) => string, chipsOf: (p: SocialPostLike) => string[]): void => {
    for (const raw of posts || []) {
      const post = raw as SocialPostLike;
      // 落盘 storyStamp 优先；存量走社媒同款惰性回填（timeLabel + storyTime 锚点），再退到 storyTime 自锚
      const stamp = stampFrom(postStoryStamp(post), selfStamp(post.storyTime || ''));
      if (!stamp) { undated++; continue; }
      emit(app, label, stamp, typeof post.createdAt === 'number' ? post.createdAt : 0, titleOf(post), textOf(post),
        { app, target: post.id }, { chips: chipsOf(post) });
    }
  };
  const social = data.social;
  if (social) {
    pushPosts(social.moments, 'moments', appLabel('moments', '朋友圈'),
      p => p.author || appLabel('moments', '朋友圈'), p => (p.text || '').slice(0, 60),
      p => [...chip('赞', Array.isArray(p.likes) ? p.likes.length : Number(p.likes) || 0), ...chip('评', (p.comments || []).length)]);
    pushPosts(social.tieba, 'tieba', appLabel('tieba', '贴吧'),
      p => p.bar || appLabel('tieba', '贴吧'), p => (p.title || p.content || '').slice(0, 60),
      p => [...chip('赞', Number(p.likes) || 0), ...chip('回', Number(p.replies) || 0)]);
    pushPosts(social.weibo, 'weibo', appLabel('weibo', '微博'),
      p => p.author || appLabel('weibo', '微博'), p => (p.text || '').slice(0, 60),
      p => [...chip('赞', Number(p.likes) || 0), ...chip('评', Number(p.commentsCount) || 0)]);
    pushPosts(social.xhs, 'xhs', appLabel('xhs', '小红书'),
      p => p.author || appLabel('xhs', '小红书'), p => (p.title || p.content || '').slice(0, 60),
      p => [...chip('赞', Number(p.likes) || 0), ...chip('收藏', Number(p.collects) || 0)]);
  }

  // ── 不夜城：通知流 + 私信（私信按天合并，一天一条）──
  const night = data.night;
  if (night) {
    for (const note of night.notifications || []) {
      const stamp = stampFrom(note.storyStamp, selfStamp(note.time || ''));
      if (!stamp) { undated++; continue; }
      // 第六轮 ②：通知帖能带 post: 前缀直达帖子详情；没有关联帖（沉底内容）就不设目标，App 回落列表。
      emit('night', appLabel('night', '不夜城'), stamp, note.createdAt || 0, note.author || appLabel('night', '不夜城'),
        (note.content || '').slice(0, 60),
        note.postId ? { app: 'night', target: `post:${note.postId}` } : { app: 'night' });
    }
    for (const dm of night.dms || []) {
      const byDay = new Map<string, { stamp: string; ts: number; msg: NightMsgLike; count: number }>();
      for (const raw of dm.msgs || []) {
        const message = raw as unknown as NightMsgLike;
        const stamp = stampFrom(message.storyStamp, selfStamp(message.timeLabel || ''));
        if (!stamp) { undated++; continue; }
        const day = parseStamp(stamp).date;
        const bucket = byDay.get(day);
        if (bucket) { bucket.stamp = stamp; bucket.msg = message; bucket.ts = message.ts || bucket.ts; bucket.count += 1; }
        else byDay.set(day, { stamp, ts: message.ts || 0, msg: message, count: 1 });
      }
      for (const bucket of byDay.values()) {
        // 第六轮 ②：私信房间沿用既有 dm: 前缀直达（与全局搜索同口径）
        emit('night', `${appLabel('night', '不夜城')} · 私信`, bucket.stamp, bucket.ts, dm.peer || appLabel('night', '不夜城'), nightMsgText(bucket.msg), { app: 'night', target: `dm:${dm.id}` }, { count: bucket.count });
      }
    }
  }

  // ── 游戏中心：完整对局记录优先；某游戏无记录时退回总结池（避免同一局计两次）──
  const games = data.games;
  if (games) {
    const pushRecords = (records: readonly GameRecord[] | readonly GameSummary[] | undefined, type: GameType): void => {
      for (const record of records || []) {
        const stamp = stampFrom(record.storyStamp, selfStamp(record.storyTime || ''));
        if (!stamp) { undated++; continue; }
        const extra = record as { highlight?: string; detail?: string };
        const text = (record.text || '').trim() || (extra.highlight || '').trim() || (extra.detail || '').trim();
        emit('game', appLabel('game-center', '游戏中心'), stamp, record.ts || 0, gameTypeName(type), text.slice(0, 60),
          { app: 'game-center', target: record.id }, { chips: record.winnerSide && record.winnerSide !== '未知' ? [record.winnerSide] : [] });
      }
    };
    for (const type of ['werewolf', 'undercover', 'turtlesoup'] as const) {
      const records = games.records?.[type];
      if (records?.length) { pushRecords(records, type); continue; }
      pushRecords(games.summaries?.[type], type);
    }
  }

  // ── 相册（只有入档时盖过戳的条目可收录；老照片无绝对时间=不猜）──
  // 有出镜角色时标题=角色名，摘要=画面描述；纯景物（无角色）时标题取描述首段、过长才把全文放摘要，
  // 避免「相册 / 相册」这种标题与来源标签重复的读数。
  for (const entry of data.album || []) {
    const stamp = stampFrom(entry.storyStamp);
    if (!stamp) { undated++; continue; }
    const desc = (entry.desc || '').replace(/\s+/g, ' ').trim();
    const people = (entry.characters || []).join('、');
    emit('album', appLabel('album', '相册'), stamp, entry.createdAt || 0,
      people || desc.slice(0, 12) || appLabel('album', '相册'),
      people ? desc.slice(0, 60) : desc.length > 12 ? desc.slice(0, 60) : '',
      { app: 'album', target: entry.id },
      { thumbs: entry.path ? [entry.path] : [] });
  }

  // ── 网上商城（docs/52 §16.6，用户定案「商城内容要接入编年史」）：下单 / 送达 / 取消各一条 ──
  // 订单自带故事时间快照：orderedAt=完整时刻、deliveredAt=送达**故事日**（只有日期→当日 00:00）、
  // cancelledAt=完整时刻。时间不可解析=不收录（只计数，宁少不猜——与全库同一口径）。
  // 点条目直达订单详情（shop App 消费 `sho_` 前缀深链；商品名做标题，金额做摘要）。
  const shopLabel = appLabel('shop', '商城');
  for (const order of data.shop?.orders || []) {
    const name = (order.item?.name || '').trim() || shopLabel;
    const qtyText = order.qty > 1 ? ` ×${order.qty}` : '';
    const moneyText = `${order.amount} ${order.currencyName}${qtyText}`;
    const pushShopEntry = (stamp: string, label: string, text: string, chips: string[] = []): void => {
      if (!stamp) { undated++; return; }
      emit('shop', `${shopLabel} · ${label}`, stamp, stampMinutes(stamp), name, text,
        { app: 'shop', target: order.id }, { chips });
    };
    pushShopEntry(stampFrom(selfStamp(order.orderedAt)), S('下单', '订货', '订货', '订货'), moneyText);
    if (order.status === 'delivered') {
      pushShopEntry(stampFrom(selfStamp(order.deliveredAt || order.arriveDate)), S('送达', '到货', '到货', '到货'), '', [S('已送到', '已送到', '已送到', '已送到')]);
    } else if (order.status === 'cancelled') {
      pushShopEntry(stampFrom(selfStamp(order.cancelledAt || '')), S('取消', '作废', '作废', '取消'), S('款项已退回', '款项已退回', '款项已退回', '款项已退回'));
    }
  }

  out.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return { entries: out, undated };
}

// ─── 按天分组 + 显示文案 ───

export interface ChronicleDay {
  /** 日期键 YYYY-MM-DD。 */
  day: string;
  /** 日期头文案（如「三月十四 · 周四」；跨年补年份）。 */
  label: string;
  /** 是否当前故事日（绿色高亮）。 */
  today: boolean;
  /** 当日记录条数。 */
  count: number;
  entries: ChronicleEntry[];
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 1..99 → 中文数字（1-31 日期用；超出原样返回）。 */
function cnNum(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 99) return String(n);
  if (n < 10) return CN_DIGITS[n]!;
  if (n === 10) return '十';
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${tens === 1 ? '' : CN_DIGITS[tens]}十${ones ? CN_DIGITS[ones] : ''}`;
}

/** 日期键 → 星期（公历；编年史用短式「周四」，与微信列表口径的「星期四」区分）。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function weekdayOf(day: string): string {
  const at = stampMinutes(`${day} 00:00`);
  if (Number.isNaN(at)) return '';
  const serial = Math.floor(at / 1440);
  return WEEKDAYS[(((serial + 4) % 7) + 7) % 7] ?? '';
}

/** 日期头文案：`三月十四 · 周四`（与当前故事时间同年不写年份）。 */
export function chronicleDayLabel(day: string, now: string): string {
  const matched = day.match(/^(-?\d{4,6})-(\d{2})-(\d{2})$/);
  if (!matched) return day;
  const year = Number(matched[1]);
  const nowYear = (parseStoryAnchor(now).date.match(/^(-?\d{4,6})/) || [])[1];
  const yearPart = nowYear !== undefined && String(year) === nowYear ? '' : `${year < 0 ? '-' : ''}${Math.abs(year)}年`;
  const weekday = weekdayOf(day);
  return `${yearPart}${cnNum(Number(matched[2]))}月${cnNum(Number(matched[3]))}${weekday ? ` · ${weekday}` : ''}`;
}

/** 按天分组（天倒序=最近在前；天内升序）。 */
export function groupChronicleByDay(entries: readonly ChronicleEntry[], now: string): ChronicleDay[] {
  const nowDate = parseStoryAnchor(now).date;
  const buckets = new Map<string, ChronicleEntry[]>();
  for (const entry of entries) {
    const day = parseStamp(entry.stamp).date;
    if (!day) continue;
    const bucket = buckets.get(day);
    if (bucket) bucket.push(entry);
    else buckets.set(day, [entry]);
  }
  const days = Array.from(buckets.entries()).map(([day, list]) => ({
    day,
    label: chronicleDayLabel(day, now),
    today: Boolean(nowDate) && day === nowDate,
    count: list.reduce((sum, e) => sum + (e.count || 1), 0),
    entries: list,
  }));
  // 用日期序号倒序（不能用字符串比较：负年份会反向）
  days.sort((a, b) => (stampMinutes(`${b.day} 00:00`) || 0) - (stampMinutes(`${a.day} 00:00`) || 0));
  return days;
}

export interface ChronicleDayStats {
  messages: number;
  calls: number;
  posts: number;
  photos: number;
}

/** 日视图顶部四个计数（消息=微信/窥私原始条数；动态=四社媒；影像=相册）。 */
export function chronicleDayStats(entries: readonly ChronicleEntry[]): ChronicleDayStats {
  let messages = 0;
  let calls = 0;
  let posts = 0;
  let photos = 0;
  for (const entry of entries) {
    if (entry.source === 'wechat' || entry.source === 'spy') messages += entry.count || 1;
    else if (entry.source === 'phone-call') calls += 1;
    else if (entry.source === 'moments' || entry.source === 'tieba' || entry.source === 'weibo' || entry.source === 'xhs') posts += 1;
    else if (entry.source === 'album') photos += 1;
  }
  return { messages, calls, posts, photos };
}

/** 分页切片（days 已天倒序；返回最近 visibleDays 天 + 是否还有更早的）。 */
export function paginateChronicle(days: readonly ChronicleDay[], visibleDays: number): { days: ChronicleDay[]; hasMore: boolean } {
  const take = Math.max(1, Math.floor(visibleDays) || 1);
  return { days: days.slice(0, take), hasMore: days.length > take };
}

export interface ChronicleView {
  days: ChronicleDay[];
  /** 未收录（时间不可解析）条数。 */
  undated: number;
  /** 收录总条数（含分段内的原始条数）。 */
  total: number;
  /** 当前故事时间文案（渲染层可显示）。 */
  now: string;
}

/** 读盘聚合（渲染层入口）：零拷贝 + 一次分组。 */
export function collectChronicle(): ChronicleView {
  const roster = getRoster();
  const now = roster.global.time;
  const { entries, undated } = buildChronicle(readPhoneDataRef(), roster.protagonistName || '我');
  return {
    days: groupChronicleByDay(entries, now),
    undated,
    total: entries.reduce((sum, e) => sum + (e.count || 1), 0),
    now,
  };
}
