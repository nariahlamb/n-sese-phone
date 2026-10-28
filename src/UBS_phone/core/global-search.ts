// ===== 跨 App 全局搜索（聚合既有数据，零新增结构、零新存储） =====
// 源：微信会话 / 微信聊天记录 / 通话记录 / 对局记录 / 社媒四平台内容 / 不夜城帖子与私信 / 相册条目 / 窥私会话。
// **刻意不含编年史**：编年史本身就是上述源的统计视图，纳入即同一事件重复计数（用户定案 2026-10-02）。
// 也刻意不含通知中心（未读聚合，不是可检索内容）。
// 纯函数：入参给 data + now + style，不读 store、不碰 DOM（可单测；UI 在 renderers/global-search-sheet）。

import { excerptText } from './ubp-utils';
import {
  conversationMatches,
  messagePreviewText,
  searchPhoneMessages,
  storyTimeShort,
  type PhoneChatData,
  type PhoneStyle,
} from './chat-model';
import type { CallRecord } from './call-model';
import { gameTypeName } from './game-model';
import { albumSourceLabel } from './phone-album';
import { formatStampChat, normalizeStoryTimeLabel } from './social-time';

/** 命中分组名（渲染为 grouphead；只输出非空组）。
 *  展示顺序见 searchPhoneGlobal：会话 → 聊天记录 → 通话记录 → 对局记录 → 社媒四平台 → 不夜城 → 相册 → 商城 → 窥私。 */
export type GlobalSearchGroupKey = 'conversation' | 'message' | 'call' | 'game' | 'moments' | 'tieba' | 'weibo' | 'xhs' | 'night' | 'album' | 'shop' | 'spy';

export interface GlobalSearchHit {
  /** 跳转目标 id：微信=会话 id；社媒=帖子/笔记 id；相册=条目 id。 */
  targetId: string;
  /** 行主标题（会话名 / 平台名·作者 / 相册来源）。 */
  title: string;
  /** 摘要（已截断）。 */
  excerpt: string;
  /** 相对时间文案（自锚 + 相对分桶；解析失败回落原文，绝不编造）。 */
  time: string;
  /** 头像位名字（无头像图时渲染单字底色）。 */
  who: string;
  /** 微信聊天记录命中才有的消息定位（直达该条）。 */
  mid?: string;
}

export interface GlobalSearchSection {
  key: GlobalSearchGroupKey;
  /** 组标题（中文；计数由渲染层加）。 */
  label: string;
  /** 跳转 App（会话/聊天记录=wechat；社媒=各平台；相册=album）。 */
  appId: string;
  hits: GlobalSearchHit[];
}

export interface GlobalSearchResult {
  sections: GlobalSearchSection[];
  total: number;
}

export interface GlobalSearchOptions {
  /** 每组最多命中数（默认 8；四平台各自独立计）。 */
  perGroup?: number;
  /** 聊天记录扫描上限（默认 30，与 SEARCH_HIT_LIMIT 同口径）。 */
  messageLimit?: number;
  /** 当前故事时间（相对分桶锚点；缺省=不做相对化，只出原文）。 */
  now?: string;
  /** 当前风格（相册来源标签与全机一致）。 */
  style?: PhoneStyle;
  /** 是否纳入窥私组（默认 false——窥私有自己的开关，调用方按 phoneSettings.spyEnabled 传入）。 */
  includeSpy?: boolean;
}

/** 自锚盖戳 + 相对化（与微信会话行同口径：绝不拿「当前时间」二次换算）。 */
function stampText(raw: string, now: string): string {
  const stamp = raw ? normalizeStoryTimeLabel(raw, raw) : '';
  return (stamp && now ? formatStampChat(stamp, now) : '') || storyTimeShort(raw);
}

function excerptOf(text: string, max = 60): string {
  return excerptText(text, max);
}

/** 社媒条目在纯函数里只需这几个字段（避免为 4 种帖型各写一遍分支）。 */
interface SocialRow { id: string; author: string; storyTime?: string }

function socialSection(
  key: GlobalSearchGroupKey,
  label: string,
  appId: string,
  items: ReadonlyArray<Record<string, unknown>>,
  haystack: (p: Record<string, unknown>) => string,
  titleOf: (p: Record<string, unknown>) => string,
  q: string,
  perGroup: number,
  now: string,
): GlobalSearchSection | null {
  const hits: GlobalSearchHit[] = [];
  for (const p of items) {
    const hay = haystack(p);
    if (!hay.toLowerCase().includes(q)) continue;
    const row = p as unknown as SocialRow;
    hits.push({
      targetId: String(row.id || ''),
      title: titleOf(p),
      excerpt: excerptOf(hay),
      time: stampText(row.storyTime || '', now),
      who: String(row.author || ''),
    });
    if (hits.length >= perGroup) break;
  }
  return hits.length ? { key, label, appId, hits } : null;
}

/**
 * 全局检索。query 为空 = 空结果（UI 自行决定空态展示）。
 * 展示顺序：会话 → 聊天记录 → 通话记录 → 对局记录 → 朋友圈 → 贴吧 → 微博 → 小红书 → 不夜城 → 相册 → 窥私。
 */
export function searchPhoneGlobal(data: PhoneChatData, query: string, opts: GlobalSearchOptions = {}): GlobalSearchResult {
  const q = query.trim().toLowerCase();
  const now = opts.now || '';
  if (!q) return { sections: [], total: 0 };
  const perGroup = Math.max(1, opts.perGroup ?? 8);
  const sections: GlobalSearchSection[] = [];

  // ① 会话（名/成员/末条正文，与微信会话列表搜索同口径）
  const convHits: GlobalSearchHit[] = [];
  for (const conv of data.conversations) {
    if (!conversationMatches(conv, query)) continue;
    const last = conv.messages[conv.messages.length - 1];
    convHits.push({
      targetId: conv.id,
      title: conv.title,
      excerpt: last ? messagePreviewText(last) : '',
      time: stampText(last?.storyTime || '', now),
      who: conv.members[0] || conv.title,
    });
    if (convHits.length >= perGroup) break;
  }
  if (convHits.length) sections.push({ key: 'conversation', label: '会话', appId: 'wechat', hits: convHits });

  // ② 聊天记录（跨会话扫消息正文，全局新→旧，跳过系统消息）
  const msgHits = searchPhoneMessages(data, query, Math.max(1, opts.messageLimit ?? 30)).slice(0, perGroup);
  if (msgHits.length) {
    sections.push({
      key: 'message', label: '聊天记录', appId: 'wechat',
      hits: msgHits.map(hit => ({
        targetId: hit.convId,
        title: hit.convTitle,
        excerpt: messagePreviewText(hit.message),
        time: stampText(hit.message.storyTime || '', now),
        who: hit.convTitle, // 头像用会话名（与聊天记录命中行同口径）
        mid: hit.message.id,
      })),
    });
  }

  // ③ 通话记录（对方名/拒接理由/内心想法/转写正文；跳 phone-call 通话详情）
  const callHits: GlobalSearchHit[] = [];
  for (const rec of data.calls || []) {
    const hay = [rec.peerName, rec.caller, rec.rejectReason, rec.thought, ...rec.lines.map(l => l.text)].filter(Boolean).join(' ');
    if (!hay.toLowerCase().includes(q)) continue;
    callHits.push({
      targetId: rec.id,
      title: rec.peerName,
      excerpt: excerptOf(callSearchExcerpt(rec)),
      time: stampText(rec.storyStamp || rec.storyTime || '', now),
      who: rec.peerName,
    });
    if (callHits.length >= perGroup) break;
  }
  if (callHits.length) sections.push({ key: 'call', label: '通话记录', appId: 'phone-call', hits: callHits });

  // ④ 对局记录（赛后总结/高光/复盘群聊 + 参与者；跳 game-center 复盘详情）
  const gameHits: GlobalSearchHit[] = [];
  for (const rec of [...(data.games?.records.undercover || []), ...(data.games?.records.werewolf || []), ...(data.games?.records.turtlesoup || [])]) {
    const hay = [rec.text, rec.highlight, rec.afterparty, rec.winnerSide, ...rec.players].filter(Boolean).join(' ');
    if (!hay.toLowerCase().includes(q)) continue;
    gameHits.push({
      targetId: rec.id,
      title: `${gameTypeName(rec.gameType)} · ${rec.winnerSide || ''}`.trim(),
      excerpt: excerptOf(rec.text || rec.highlight || ''),
      time: stampText(rec.storyStamp || rec.storyTime || '', now),
      who: '局',
    });
    if (gameHits.length >= perGroup) break;
  }
  if (gameHits.length) sections.push({ key: 'game', label: '对局记录', appId: 'game-center', hits: gameHits });

  // ⑤ 社媒四平台（各平台一次，字段口径显式；朋友圈无标题字段用正文）
  const social = data.social;
  if (social) {
    const items = (list: unknown): Array<Record<string, unknown>> => (Array.isArray(list) ? list : []) as Array<Record<string, unknown>>;
    const platforms: Array<[GlobalSearchGroupKey, string, string, Array<Record<string, unknown>>, (p: Record<string, unknown>) => string, (p: Record<string, unknown>) => string]> = [
      ['moments', '朋友圈', 'moments', items(social.moments),
        p => [p.author, p.text].filter(Boolean).join(' '), p => `${String(p.author || '')} · 动态`],
      ['tieba', '贴吧', 'tieba', items(social.tieba),
        p => [p.author, p.title, p.content, p.bar].filter(Boolean).join(' '), p => String(p.title || '')],
      ['weibo', '微博', 'weibo', items(social.weibo),
        p => [p.author, p.text].filter(Boolean).join(' '), p => `${String(p.author || '')} · 微博`],
      ['xhs', '小红书', 'xhs', items(social.xhs),
        p => [p.author, p.title, p.content, Array.isArray(p.tags) ? (p.tags as string[]).join(' ') : p.tags].filter(Boolean).join(' '),
        p => String(p.title || '')],
    ];
    for (const [key, label, appId, list, hay, tit] of platforms) {
      const sec = socialSection(key, label, appId, list, hay, tit, q, perGroup, now);
      if (sec) sections.push(sec);
    }
  }

  // ⑥ 不夜城（帖子 + 私信；targetId 带 `post:`/`dm:` 前缀区分两类详情，night 深链首帧解码）
  const night = data.night;
  if (night) {
    const nightHits: GlobalSearchHit[] = [];
    for (const p of night.posts) {
      const hay = [p.author, p.title, p.content, ...(p.tags || [])].filter(Boolean).join(' ');
      if (!hay.toLowerCase().includes(q)) continue;
      nightHits.push({
        targetId: `post:${p.id}`,
        title: p.title || '帖子',
        excerpt: excerptOf(p.content || ''),
        time: stampText(p.storyStamp || p.storyTime || '', now),
        who: '夜',
      });
      if (nightHits.length >= perGroup) break;
    }
    if (nightHits.length < perGroup) {
      for (const dm of night.dms) {
        const msgs = dm.msgs || [];
        const hay = [dm.peer, ...msgs.map(m => m.text || '')].filter(Boolean).join(' ');
        if (!hay.toLowerCase().includes(q)) continue;
        const last = msgs[msgs.length - 1];
        nightHits.push({
          targetId: `dm:${dm.id}`,
          title: `${dm.peer} · 私信`,
          excerpt: excerptOf(last?.text || ''),
          time: stampText(last?.storyStamp || '', now),
          who: '夜',
        });
        if (nightHits.length >= perGroup) break;
      }
    }
    if (nightHits.length) sections.push({ key: 'night', label: '不夜城', appId: 'night', hits: nightHits });
  }

  // ⑦ 相册（画面描述 + 出镜角色；来源作标题后缀）
  const albumHits: GlobalSearchHit[] = [];
  for (const e of data.album || []) {
    const hay = [e.desc, ...(e.characters || [])].filter(Boolean).join(' ');
    if (!hay.toLowerCase().includes(q)) continue;
    albumHits.push({
      targetId: e.id,
      title: `相册 · ${albumSourceLabel(e.source, opts.style ?? '')}`,
      excerpt: excerptOf(e.desc),
      time: stampText(e.storyStamp || '', now),
      who: (e.characters && e.characters[0]) || '',
    });
    if (albumHits.length >= perGroup) break;
  }
  if (albumHits.length) sections.push({ key: 'album', label: '相册', appId: 'album', hits: albumHits });

  // ⑧ 网上商城（货架商品 + 订单快照；docs/52——命中直达商城详情，targetId 用商品/订单 id）
  const shop = data.shop;
  if (shop) {
    const shopHits: GlobalSearchHit[] = [];
    for (const item of shop.catalog) {
      const hay = [item.name, item.desc, item.seller, item.category, item.currencyName].filter(Boolean).join(' ');
      if (!hay.toLowerCase().includes(q)) continue;
      shopHits.push({
        targetId: item.id,
        title: item.name,
        excerpt: excerptOf([item.seller, item.desc].filter(Boolean).join(' · ')),
        time: stampText(item.addedAt, now),
        who: item.glyph || '购',
      });
      if (shopHits.length >= perGroup) break;
    }
    if (shopHits.length < perGroup) {
      for (const order of shop.orders) {
        const item = order.item;
        const hay = [item.name, item.desc, item.seller, order.currencyName].filter(Boolean).join(' ');
        if (!hay.toLowerCase().includes(q)) continue;
        const statusText = order.status === 'delivered' ? '已送达' : order.status === 'cancelled' ? '已取消' : '运送中';
        shopHits.push({
          targetId: item.id,
          title: `${item.name} ×${order.qty}`,
          excerpt: excerptOf([statusText, order.arriveDate ? `预计 ${order.arriveDate} 送达` : '', item.seller].filter(Boolean).join(' · ')),
          time: stampText(order.orderedAt, now),
          who: item.glyph || '购',
        });
        if (shopHits.length >= perGroup) break;
      }
    }
    if (shopHits.length) sections.push({ key: 'shop', label: '商城', appId: 'shop', hits: shopHits });
  }

  // ⑧b 商城消息（docs/54：店铺名 + 会话消息命中；targetId 用 thr_<会话 id>，深链直达那条会话）
  if (shop) {
    const chatHits: GlobalSearchHit[] = [];
    for (const thread of shop.threads || []) {
      const titleHit = thread.seller.toLowerCase().includes(q);
      let lastText = '';
      let lastTime = '';
      for (let i = thread.messages.length - 1; i >= 0; i--) {
        const m = thread.messages[i];
        if (m.from === 'system') continue;
        lastText = m.type === 'image' ? `[图片]${m.content}`
          : m.type === 'redpacket' ? `[红包]${m.content || m.amount || ''}`
            : m.type === 'price' && m.priceChange ? `[改价]${m.priceChange.itemName} → ${m.priceChange.to}`
              : m.type === 'item' && m.newItem ? `[新货]${m.newItem.item.name}`
                : m.content;
        lastTime = m.storyTime || '';
        break;
      }
      const msgHit = Boolean(lastText) && lastText.toLowerCase().includes(q);
      if (!titleHit && !msgHit) continue;
      chatHits.push({
        targetId: thread.id,
        title: thread.seller,
        excerpt: excerptOf(msgHit ? lastText : `共 ${thread.messages.length} 条往来`),
        time: stampText(lastTime, now),
        who: thread.seller.slice(0, 1) || '店',
      });
      if (chatHits.length >= perGroup) break;
    }
    if (chatHits.length) sections.push({ key: 'shop', label: '商家', appId: 'shop', hits: chatHits });
  }

  // ⑨ 窥私（会话级；默认不纳入——窥私是可选功能，由调用方按开关传 includeSpy）
  if (opts.includeSpy) {
    const spyHits: GlobalSearchHit[] = [];
    for (const conv of data.spy?.conversations || []) {
      const hay = [conv.title, ...conv.members, ...conv.messages.map(m => m.content)].filter(Boolean).join(' ');
      if (!hay.toLowerCase().includes(q)) continue;
      const last = conv.messages[conv.messages.length - 1];
      spyHits.push({
        targetId: conv.id,
        title: conv.title,
        excerpt: last ? messagePreviewText(last) : '',
        time: stampText(last?.storyTime || '', now),
        who: conv.members[0] || conv.title,
      });
      if (spyHits.length >= perGroup) break;
    }
    if (spyHits.length) sections.push({ key: 'spy', label: '窥私', appId: 'spy', hits: spyHits });
  }

  return { sections, total: sections.reduce((n, s) => n + s.hits.length, 0) };
}

/** 通话命中的摘要：优先第一句转写，其次拒接理由/对方心声，最后回落到对方名。
 *  （不直接用 callRecordPreview——那句是「已接通 03:12」这类状态文案，作为搜索命中太寡淡。） */
function callSearchExcerpt(rec: CallRecord): string {
  const first = rec.lines.find(l => l.text && l.text.trim());
  return first?.text || rec.rejectReason || rec.thought || rec.peerName;
}
