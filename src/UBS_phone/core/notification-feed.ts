// ===== 通知中心数据层（docs/24 P1）=====
// 把各 App **既有的**未读计数与通知流聚合成一条时间倒序的通知列表，供壳层「下拉通知中心」渲染。
//
// 三条纪律：
//  1. 零新增数据 —— 全部来自既有字段（微信/窥私 unread、未接来电 calls.seen、不夜城 notifications+dm.unread、
//     四社媒未读通知流、游戏「轮到我」）。不新建任何持久化结构。
//  2. 零拷贝 —— 全程只用 readPhoneDataRef()（只读引用，禁改写）。聚合只在通知中心打开时执行一次，
//     关闭时本模块零开销（无订阅、无轮询、无缓存）。
//  3. 「清除」不另造已读状态 —— 复用各域既有已读入口（会话 unread 归零 / calls.seen / 通知 read / 社媒已读），
//     一次 mutatePhoneData 全部走完，与各 App 打开即已读的口径天然一致。

import { conversationListPreview, type PhoneStyle } from './chat-model';
import { s } from './skins';
import { gameProgressStatus } from './game-engine';
import { gameTypeName } from './game-model';
import { readPhoneDataRef, mutatePhoneData } from './phone-store';
import { collectPhoneSchedule, scheduleDueLabel } from './phone-schedule';
import { getRoster } from './roster';
import { markAllSocialNotificationsRead, socialNotificationUnread, type SocialKind } from './social-model';
import { takeShopRestockNotice } from './shop-model';
import { socialNotifyVerb } from './social-notify-text';
import { formatStampChat, formatStampRelative, normalizeStoryTimeLabel } from './social-time';

/** 通知来源 App（= 桌面磁贴 id；'game' 无独立磁贴但共用同一套图标链路）。 */
export type PhoneNotifySource = 'wechat' | 'phone-call' | 'spy' | 'night' | 'moments' | 'tieba' | 'weibo' | 'xhs' | 'game' | 'schedule' | 'shop';

/** 一条通知（渲染层直接消费；文案已在本层拼好，渲染层只负责套样式）。 */
export interface PhoneNotification {
  /** 稳定 id（组内 key / 已读动画锚点）。 */
  id: string;
  source: PhoneNotifySource;
  /** 子来源（群聊 / 具体游戏名），渲染层拼成「微信 · 群聊」。 */
  sub?: string;
  /** 主标题行（人名 / 群名 / 计数短语 / 动作文案）。 */
  title: string;
  /** 一行摘要。 */
  text: string;
  /** 右侧时间文案（已格式化；空=不显示）。 */
  time?: string;
  /** 约定日副标签（仅 source='schedule'，「05-19 周二」）：与 time（今天/明天）拼成卡片日期徽章。 */
  due?: string;
  /** 右侧红底计数（0 或不设=不显示）。 */
  count?: number;
  /** 排序权重（ms；来源内可比，跨来源仅用于粗排）。 */
  rank: number;
  /** 常驻置顶（游戏「轮到你」这类需玩家立即行动的条目；不参与「全部清除」）。 */
  pin?: boolean;
  /** 日程提醒的确认键（仅 source='schedule'）：点「知道了」= 写 ack，此后不再显示。 */
  ackKey?: string;
  /** 点击去处（App 内深链目标）：会话 id / 帖子 id / `dm:<id>` / `live:<id>` / 订单 id。
   *  缺省=只打开 source App（落到该 App 的默认页）。锁屏卡与通知中心共用这一份。 */
  target?: string;
}

/** 一组通知（同 App）。 */
export interface PhoneNotificationGroup {
  source: PhoneNotifySource;
  /** 组内未读合计（组头徽标）。 */
  count: number;
  items: PhoneNotification[];
}

/** 单次聚合上限（超出丢弃最旧的——通知中心的职责是「知道有事」，不是归档）。 */
export const MAX_PHONE_NOTIFICATIONS = 40;

/** 会话类来源（微信/窥私）时间文案：与会话列表同口径（今天 HH:mm / 昨天 / 星期X / M-D）。 */
function chatTime(rawTime: string, now: string): string {
  const stamp = rawTime ? normalizeStoryTimeLabel(rawTime, now) : '';
  return (stamp && formatStampChat(stamp, now)) || rawTime;
}

/** 通知流来源（社媒/不夜城）时间文案：相对分桶（刚刚 / N分钟前 / 今天 HH:mm / 昨天 …）。
 *  绝对戳与标签都不可解析时**只用原文，不编造**（对齐既有时间纪律）。 */
function streamTime(rawTime: string, storyStamp: string, now: string): string {
  const stamp = (storyStamp || '').trim() || (rawTime ? normalizeStoryTimeLabel(rawTime, now) : '');
  if (stamp) {
    const rel = formatStampRelative(stamp, now);
    if (rel) return rel;
  }
  return rawTime;
}

/** 未接/未看通话的状态文案（与电话 App 列表口径一致）。 */
function callStatusText(status: string): string {
  if (status === 'missed') return '未接来电';
  if (status === 'rejected') return '对方拒接';
  return '已取消';
}

/**
 * 聚合全部来源的通知（新→旧、置顶优先）。
 * 只读引用（readPhoneDataRef）：调用方若随后写库，须自行保证顺序（本函数不持有引用）。
 */
export function collectPhoneNotifications(): PhoneNotification[] {
  const data = readPhoneDataRef();
  const roster = getRoster();
  const now = roster.global.time;
  const meLabel = roster.protagonistName || '我';
  const out: PhoneNotification[] = [];

  // ── 微信：未读会话逐条（含手动「标为未读」的红点，与图标角标同口径）──
  for (const conv of data.conversations) {
    if (!conv.unread && !conv.manualUnread) continue;
    const last = conv.messages[conv.messages.length - 1];
    out.push({
      id: `wechat:${conv.id}`,
      source: 'wechat',
      ...(conv.kind === 'group' ? { sub: '群聊' } : {}),
      title: conv.title,
      text: conversationListPreview(conv, meLabel),
      time: chatTime(last?.storyTime || '', now),
      count: conv.unread || 0,
      rank: conv.updatedAt || last?.ts || conv.createdAt || 0,
      target: conv.id,
    });
  }

  // ── 窥私：未读会话逐条（会话结构与微信同型，口径直接复用）──
  for (const conv of data.spy?.conversations || []) {
    if (!conv.unread) continue;
    const last = conv.messages[conv.messages.length - 1];
    out.push({
      id: `spy:${conv.id}`,
      source: 'spy',
      ...(conv.kind === 'group' ? { sub: '群聊' } : {}),
      title: conv.title,
      text: conversationListPreview(conv, meLabel),
      time: chatTime(last?.storyTime || '', now),
      count: conv.unread,
      rank: conv.updatedAt || last?.ts || conv.createdAt || 0,
      target: conv.id,
    });
  }

  // ── 电话：未看的不通通话合并成一条（真机「3 个未接来电」），正文报最近一通 ──
  const missed = (data.calls || []).filter(c => !c.seen && (c.status === 'rejected' || c.status === 'cancelled' || c.status === 'missed'));
  if (missed.length) {
    const latest = missed.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    // T1：最近一通带语音留言时正文点明（节点聚合口径不变——不新增条目、不新增未读结构）
    const vmTag = latest.voicemail?.length ? ' · 有留言' : '';
    out.push({
      id: 'phone-call:missed',
      source: 'phone-call',
      title: `${missed.length} 个未接来电`,
      text: `${latest.peerName} · ${callStatusText(latest.status)}${vmTag}`,
      time: chatTime(latest.storyTime || '', now),
      count: missed.length,
      rank: latest.startedAt || 0,
    });
  }

  // ── 不夜城：未读通知流 + 未读私信（两套口径都算未读，与 nightUnread 一致）──
  const night = data.night;
  if (night) {
    for (const n of night.notifications) {
      if (n.read) continue;
      // 落点与 App 内点通知同序：私信 > 直播间 > 帖子（锚点缺省时只开不夜城，回落消息流）
      const target = n.dmId ? `dm:${n.dmId}` : n.liveId ? `live:${n.liveId}` : n.postId ? `post:${n.postId}` : '';
      out.push({
        id: `night:${n.id}`,
        source: 'night',
        title: n.author,
        text: n.content,
        time: streamTime(n.time, n.storyStamp || '', now),
        rank: n.createdAt || 0,
        ...(target ? { target } : {}),
      });
    }
    for (const dm of night.dms) {
      if (!dm.unread) continue;
      const last = dm.msgs[dm.msgs.length - 1];
      out.push({
        id: `night:dm:${dm.id}`,
        source: 'night',
        sub: '私信',
        title: dm.peer,
        text: (last?.text || '').trim() || '（新消息）',
        time: streamTime(last?.timeLabel || '', last?.storyStamp || '', now),
        count: dm.unread,
        rank: dm.updatedAt || dm.createdAt || 0,
        target: `dm:${dm.id}`,
      });
    }
  }

  // ── 社媒：三平台各合并成一条（通知流的逐条未读 ∪ 平台未读计数） + 朋友圈（无通知流，只有未读计数）一条 ──
  // 社媒四平台共用一份未读通知流（逐条已读）。内容型新帖（含世界演化投递）与互动型评论/回复都在这份里，
  // 所以这里只需读它——不再有「平台计数」这第二套未读（2026-10 统一，用户拍板）。
  const social = data.social;
  if (social) {
    for (const kind of ['moments', 'tieba', 'weibo', 'xhs'] as const) {
      const unreadItems = (social.notifications || []).filter(n => n.kind === kind && !n.read);
      if (!unreadItems.length) continue;
      const top = unreadItems[0];
      const count = unreadItems.length;
      out.push({
        id: `social:${kind}`,
        source: kind,
        title: count === 1 ? `${top.author}${socialNotifyVerb(kind, top.type)}` : `${count} 条新消息`,
        text: top.content || '…',
        time: streamTime(top.time || '', top.storyStamp || '', now),
        count,
        rank: top.createdAt || 0,
        // 三平台可直接落到通知所指的帖子/笔记；朋友圈 App 没有详情深链，只开动态流
        ...(kind !== 'moments' && top.postId ? { target: top.postId } : {}),
      });
    }
  }

  // ── 游戏中心：「轮到我」是需立即行动的状态而非可清除的通知，置顶且不参与全部清除 ──
  const game = gameProgressStatus();
  if (game?.myTurn) {
    out.push({
      id: `game:${game.gameType}`,
      source: 'game',
      sub: gameTypeName(game.gameType),
      title: game.text,
      text: '点击回到对局',
      rank: Number.MAX_SAFE_INTEGER,
      pin: true,
    });
  }

  const shopOrders = data.shop?.orders || [];

  // ── 网上商城（docs/52）：上货完成回执一条（用户定案「上货完成要进通知中心」；读过即清）──
  // 与「送达」那条并列但性质不同：上货是「货架变了」的消息（无未读结构、不计角标），
  // 送达是「你的包裹到了」（走 order.seen + 桌面角标）。两者都不新建已读体系。
  const restock = data.shop?.lastRestock || null;
  if (restock) {
    out.push({
      id: 'shop:restock',
      source: 'shop',
      sub: '上新',
      title: s((data.style || '') as PhoneStyle,
        `已上架 ${restock.count} 件新货`, `已备好 ${restock.count} 件新货`,
        `已张罗 ${restock.count} 件新货`, `已进 ${restock.count} 件新货`),
      text: s((data.style || '') as PhoneStyle,
        '点开看看这次到了什么', '点开看看这次采买了什么', '点开看看这次张罗了什么', '点开看看这次进了什么'),
      time: chatTime(restock.storyTime || '', now),
      // 真实时间戳排序（故事时间不可比）；量级抬到订单位次之上——刚上完货就在最上面
      rank: Number.isFinite(restock.at) && restock.at > 0 ? restock.at : shopOrders.length + 1,
    });
  }

  // ── 网上商城（docs/52）：已送达且未看过的订单逐条（与桌面图标角标同口径：order.seen 复用，零新增存储）──
  for (let i = 0; i < shopOrders.length; i++) {
    const order = shopOrders[i];
    if (order.status !== 'delivered' || order.seen === true) continue;
    out.push({
      id: `shop:${order.id}`,
      source: 'shop',
      title: s((data.style || '') as PhoneStyle, '包裹已送达', '货已送到', '货已送到', '货箱已送达'),
      text: `「${order.item.name}」已送到，记得查收`,
      time: chatTime(order.deliveredAt || '', now),
      // 订单表按新→旧存：越靠前越新（rank 用倒序位次，量级小于会话消息——包裹不是急事）
      rank: shopOrders.length - i,
      target: order.id, // 商城 App 的订单深链（openApp('shop') 首帧直落订单详情）
    });
  }

  // ── 日程提醒（M7）：主项目「备忘录」表里约定日期为今天/明天的条目 ──
  // pin：与游戏「轮到你」同款语义——它是「现实里已经到点的事」，不该被「全部清除」抹掉，
  // 只能逐条「知道了」（未确认带按钮；已确认转常驻，无按钮，直到删除或过期）。不产生角标计数。
  for (const s of collectPhoneSchedule(data, now)) {
    out.push({
      id: `schedule:${s.key}`,
      source: 'schedule',
      sub: '备忘录',
      title: s.title,
      text: s.detail,
      time: s.when === 'today' ? '今天' : '明天',
      due: scheduleDueLabel(s.dueDate),
      rank: Number.MAX_SAFE_INTEGER - 1,
      pin: true,
      ...(s.acked ? {} : { ackKey: s.key }), // 已确认=常驻（无「知道了」按钮）
    });
  }

  out.sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || b.rank - a.rank);
  return out.slice(0, MAX_PHONE_NOTIFICATIONS);
}

/** 按来源分组（组序 = 组内最新一条的排序位次；置顶组恒在最前）。 */
export function groupPhoneNotifications(list: readonly PhoneNotification[]): PhoneNotificationGroup[] {
  const groups = new Map<PhoneNotifySource, PhoneNotificationGroup>();
  for (const n of list) {
    let g = groups.get(n.source);
    if (!g) {
      g = { source: n.source, count: 0, items: [] };
      groups.set(n.source, g);
    }
    g.items.push(n);
    g.count += n.count || 0;
  }
  const arr = Array.from(groups.values());
  const rankOf = (g: PhoneNotificationGroup): number => g.items.reduce((max, n) => Math.max(max, n.rank || 0), 0);
  const pinned = (g: PhoneNotificationGroup): boolean => g.items.some(n => n.pin);
  arr.sort((a, b) => (pinned(b) ? 1 : 0) - (pinned(a) ? 1 : 0) || rankOf(b) - rankOf(a));
  return arr;
}

/** 未读合计（含置顶项；壳层如需「有通知才提示」可直接用）。 */
export function phoneNotificationCount(): number {
  return collectPhoneNotifications().reduce((sum, n) => sum + (n.count || (n.pin ? 1 : 0)), 0);
}

/**
 * 「全部清除」：把各域既有未读一次性归零（复用各自已读入口，不新造状态）。
 * 游戏「轮到你」不属于可清除项（它是进行中对局的现实状态，清了也还在）。
 * 无任何未读时**零写盘**（mutatePhoneData 只在确有变化时调用）。
 */
export function clearAllPhoneNotifications(): void {
  const data = readPhoneDataRef();
  const social = data.social;
  const hasChat = data.conversations.some(c => c.unread > 0 || c.manualUnread === true);
  const hasCall = (data.calls || []).some(c => !c.seen);
  const hasSpy = (data.spy?.conversations || []).some(c => c.unread > 0);
  const hasNight = Boolean(data.night && (data.night.notifications.some(n => !n.read) || data.night.dms.some(d => d.unread > 0)));
  const socialKinds: SocialKind[] = ['moments', 'tieba', 'weibo', 'xhs'];
  const hasSocial = Boolean(social && socialKinds.some(k => socialNotificationUnread(social, k) > 0));
  const hasShop = Boolean(data.shop?.lastRestock)
    || (data.shop?.orders || []).some(o => o.status === 'delivered' && o.seen !== true);
  if (!hasChat && !hasCall && !hasSpy && !hasNight && !hasSocial && !hasShop) return;

  mutatePhoneData(d => {
    for (const conv of d.conversations) {
      conv.unread = 0;
      conv.manualUnread = false;
    }
    for (const rec of d.calls || []) rec.seen = true;
    for (const conv of d.spy?.conversations || []) conv.unread = 0;
    if (d.night) {
      for (const n of d.night.notifications) n.read = true;
      for (const dm of d.night.dms) dm.unread = 0;
    }
    if (d.social) {
      for (const kind of socialKinds) markAllSocialNotificationsRead(d.social, kind);
    }
    for (const order of d.shop?.orders || []) {
      if (order.status === 'delivered') order.seen = true;
    }
    if (d.shop) takeShopRestockNotice(d.shop); // 上货回执同样算「已看过」
  });
}

// ─── 逐条 / 按来源处理（第五轮 ⑥：通知中心可打理）────────────────────────
// 两条纪律与「全部清除」完全一致：
//  1. **不新造已读状态**——复用各域既有入口（会话 unread/manualUnread、calls.seen、night 通知 read / dm unread、社媒逐条已读）；
//  2. **无未读时零写盘**——先用 readPhoneDataRef() 只读预检，确有事才进 mutatePhoneData。
// 置顶项（游戏「轮到你」、日程提醒）不参与逐条处理——它们是「现实里正在进行的事」，
// 清了也还在，只能等到事情本身结束（与「不参与全部清除」同一口径）。

/** 通知来源 → 社媒平台（仅四社媒 source 命中）。 */
function socialKindOf(source: PhoneNotifySource): SocialKind | null {
  return source === 'moments' || source === 'tieba' || source === 'weibo' || source === 'xhs' ? source : null;
}

/** 某会话是否真的还有未读（预检用，避免空写盘）。 */
function convHasUnread(conv: { unread?: number; manualUnread?: boolean } | undefined): boolean {
  return Boolean(conv && ((conv.unread || 0) > 0 || conv.manualUnread === true));
}

/** 按来源清掉该 App 的未读（第五轮 ⑥：长按分组头）。返回是否发生了改动。 */
export function clearPhoneNotificationsFor(source: PhoneNotifySource): boolean {
  const data = readPhoneDataRef();
  const kind = socialKindOf(source);
  let todo = false;
  switch (source) {
    case 'wechat': todo = data.conversations.some(convHasUnread); break;
    case 'spy': todo = (data.spy?.conversations || []).some(convHasUnread); break;
    case 'phone-call': todo = (data.calls || []).some(c => !c.seen); break;
    case 'shop': todo = Boolean(data.shop?.lastRestock)
      || (data.shop?.orders || []).some(o => o.status === 'delivered' && o.seen !== true); break;
    case 'night': todo = Boolean(data.night && (data.night.notifications.some(n => !n.read) || data.night.dms.some(d => d.unread > 0))); break;
    default: todo = Boolean(kind && socialNotificationUnread(data.social, kind) > 0);
  }
  if (!todo) return false;
  mutatePhoneData(d => {
    if (source === 'wechat') {
      for (const conv of d.conversations) { conv.unread = 0; conv.manualUnread = false; }
    } else if (source === 'spy') {
      for (const conv of d.spy?.conversations || []) conv.unread = 0;
    } else if (source === 'phone-call') {
      for (const rec of d.calls || []) rec.seen = true;
    } else if (source === 'night' && d.night) {
      for (const n of d.night.notifications) n.read = true;
      for (const dm of d.night.dms) dm.unread = 0;
    } else if (source === 'shop') {
      for (const order of d.shop?.orders || []) {
        if (order.status === 'delivered') order.seen = true;
      }
      if (d.shop) takeShopRestockNotice(d.shop);
    } else if (kind && d.social) {
      markAllSocialNotificationsRead(d.social, kind);
    }
  });
  return true;
}

/** 单条「已读」（第五轮 ⑥：通知行左滑）。参数就是聚合产物的 `{ source, id }`——
 *  id 的形状即各域既有身份（`wechat:<convId>` / `spy:<convId>` / `night:<id>` / `night:dm:<id>` /
 *  `social:<kind>` / `phone-call:missed`）。返回是否发生了改动。 */
export function readPhoneNotification(target: { source: PhoneNotifySource; id: string }): boolean {
  const kind = socialKindOf(target.source);
  if (target.source === 'game' || target.source === 'schedule') return false; // 置顶项不参与逐条已读
  const data = readPhoneDataRef();
  let todo = false;
  if (target.source === 'wechat') {
    todo = convHasUnread(data.conversations.find(c => `wechat:${c.id}` === target.id));
  } else if (target.source === 'spy') {
    todo = convHasUnread((data.spy?.conversations || []).find(c => `spy:${c.id}` === target.id));
  } else if (target.source === 'phone-call') {
    todo = (data.calls || []).some(c => !c.seen);
  } else if (target.source === 'night') {
    const isDm = target.id.startsWith('night:dm:');
    const key = isDm ? target.id.slice('night:dm:'.length) : target.id.slice('night:'.length);
    todo = Boolean(data.night) && (isDm
      ? data.night!.dms.some(dm => dm.id === key && dm.unread > 0)
      : data.night!.notifications.some(n => n.id === key && !n.read));
  } else if (target.source === 'shop') {
    const key = target.id.slice('shop:'.length);
    todo = key === 'restock'
      ? Boolean(data.shop?.lastRestock)
      : (data.shop?.orders || []).some(o => o.id === key && o.status === 'delivered' && o.seen !== true);
  } else if (kind) {
    todo = socialNotificationUnread(data.social, kind) > 0;
  }
  if (!todo) return false;
  mutatePhoneData(d => {
    if (target.source === 'wechat') {
      const conv = d.conversations.find(c => `wechat:${c.id}` === target.id);
      if (conv) { conv.unread = 0; conv.manualUnread = false; }
    } else if (target.source === 'spy') {
      const conv = (d.spy?.conversations || []).find(c => `spy:${c.id}` === target.id);
      if (conv) conv.unread = 0;
    } else if (target.source === 'phone-call') {
      for (const rec of d.calls || []) rec.seen = true;
    } else if (target.source === 'night' && d.night) {
      if (target.id.startsWith('night:dm:')) {
        const dm = d.night.dms.find(x => x.id === target.id.slice('night:dm:'.length));
        if (dm) dm.unread = 0;
      } else {
        const n = d.night.notifications.find(x => x.id === target.id.slice('night:'.length));
        if (n) n.read = true;
      }
    } else if (target.source === 'shop') {
      const key = target.id.slice('shop:'.length);
      if (key === 'restock') {
        if (d.shop) takeShopRestockNotice(d.shop);
      } else {
        const order = (d.shop?.orders || []).find(o => o.id === key);
        if (order && order.status === 'delivered') order.seen = true;
      }
    } else if (kind && d.social) {
      markAllSocialNotificationsRead(d.social, kind);
    }
  });
  return true;
}
