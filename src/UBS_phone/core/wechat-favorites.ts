// ===== 微信「我的收藏」（第八轮 §4 · A2）=====
// 定位：给「值得回味的内容」一个统一的家——文本 / 图片 / 语音 / 转发卡四类。
// 存储：随聊天存档（usb_phone_<h>.json）的 `wechatFavs` 域——文本/引用类收藏随备份搬家；
//   与**语音收藏**（IndexedDB ubp-voice-fav，存音频本体）是两回事，命名刻意分开避免混淆：
//   微信收藏里的语音只存「转写 + 时长 + 原消息 id」，回跳播放原消息，不复制音频。
// 上限：MAX_WECHAT_FAVORITES=500，超出丢最旧（图片条目同样丢最旧——删除前由调用方落盘，
//   引用守卫按**当前数据**重算，收藏移除后图片才允许被清理）。
// 纯函数集中在本模块（normalize / 可收判定 / 消息→条目 / 修剪 / 筛选 / 回跳目标），渲染层只消费。

import type { Conversation, PhoneLogEntry, PhoneMessage } from './chat-model';

export type WeChatFavoriteType = 'text' | 'image' | 'voice' | 'card';

export interface WeChatFavorite {
  id: string;
  type: WeChatFavoriteType;
  /** 来源会话 id（p:名字 / g:群 id）与标题快照（会话改名/删除后仍可读）。 */
  conversationId: string;
  conversationTitle: string;
  /** 发送人显示名快照（'me' 已解析为显示名）。 */
  fromName: string;
  /** 故事时间快照（盖戳纪律：解析不出不盖）。 */
  storyTime?: string;
  /** 规范绝对故事时间戳（selfStamp 产物；解析不出不写）。 */
  storyStamp?: string;
  /** 真实时钟（排序/上限修剪）。 */
  createdAt: number;
  /** 原消息 id：同 messageId 全类型去重 + 回跳目标。 */
  messageId: string;
  /** text：正文（2 行封顶渲染）。 */
  content?: string;
  /** image：相册图片路径（**必须进图片引用守卫 eachImageRef**）。 */
  imagePath?: string;
  /** voice：时长（秒；回跳播放原消息用，不复制音频）。 */
  durationSec?: number;
  /** card（转发卡/合并转发）：快照（复用 PhoneLogEntry 结构，与引用卡同源）。 */
  card?: PhoneLogEntry;
}

/** 收藏条数上限（超出丢最旧）。 */
export const MAX_WECHAT_FAVORITES = 500;

const TYPES: readonly WeChatFavoriteType[] = ['text', 'image', 'voice', 'card'];

/** 该消息能否收藏（纯函数）：系统气泡不可收；图片未就绪/失败不可收；其余四类可收。
 *  文本/图片/语音/转发卡以外的类型（转账/红包）不收录——它们有金额语义，收藏会失真。 */
export function canFavoriteMessage(
  m: Pick<PhoneMessage, 'type' | 'from' | 'content' | 'imagePath' | 'imageStatus' | 'log'>,
): boolean {
  if (!m || m.from === 'system') return false;
  if (m.type === 'image') return Boolean(m.imagePath) && m.imageStatus !== 'failed';
  if (m.type === 'voice') return Boolean(m.content) || Boolean((m as { voiceKey?: string }).voiceKey);
  if (m.type === 'text') return Boolean(String(m.content || '').trim());
  if (m.type === 'chatlog') return Array.isArray(m.log) && m.log.length > 0;
  return false;
}

/** 消息 → 收藏条目（纯函数；不可收返回 null）。fromName = 发送方显示名（'me' 已解析）。 */
export function favoriteFromMessage(
  m: PhoneMessage,
  conv: Pick<Conversation, 'id' | 'title'>,
  fromName: string,
  now = Date.now(),
): WeChatFavorite | null {
  if (!canFavoriteMessage(m)) return null;
  const base: WeChatFavorite = {
    id: `wf_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type: m.type === 'chatlog' ? 'card' : (m.type as WeChatFavoriteType),
    conversationId: conv.id,
    conversationTitle: conv.title,
    fromName: fromName || m.from,
    createdAt: now,
    messageId: m.id,
  };
  if (m.storyTime) base.storyTime = m.storyTime;
  if (m.storyStamp) base.storyStamp = m.storyStamp;
  if (base.type === 'text') base.content = String(m.content || '').slice(0, 4000);
  if (base.type === 'image') base.imagePath = m.imagePath;
  if (base.type === 'voice') {
    base.content = String(m.content || '').slice(0, 4000);
    const sec = Number((m as { voiceDurationSeconds?: number }).voiceDurationSeconds);
    if (Number.isFinite(sec) && sec > 0) base.durationSec = Math.round(sec);
  }
  if (base.type === 'card') {
    base.card = {
      from: m.from,
      type: 'chatlog',
      content: String(m.content || '').slice(0, 200),
      ...(m.imagePath ? { imagePath: m.imagePath } : {}),
      ...(m.storyTime ? { storyTime: m.storyTime } : {}),
    };
  }
  return base;
}

/** 条目净化（磁盘读回容错）：缺关键字段/类型不认的丢弃；逐字段 clamp。 */
export function normalizeWechatFavorite(raw: unknown): WeChatFavorite | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = String(r.type || '') as WeChatFavoriteType;
  if (!TYPES.includes(type)) return null;
  const messageId = String(r.messageId || '').slice(0, 120);
  const conversationId = String(r.conversationId || '').slice(0, 120);
  if (!messageId || !conversationId) return null;
  const out: WeChatFavorite = {
    id: String(r.id || '').slice(0, 60) || `wf_${messageId}`,
    type,
    conversationId,
    conversationTitle: String(r.conversationTitle || '').slice(0, 120),
    fromName: String(r.fromName || '').slice(0, 120) || '未知',
    createdAt: Number.isFinite(r.createdAt) ? Number(r.createdAt) : Date.now(),
    messageId,
  };
  if (typeof r.storyTime === 'string' && r.storyTime) out.storyTime = r.storyTime.slice(0, 60);
  if (typeof r.storyStamp === 'string' && r.storyStamp) out.storyStamp = r.storyStamp.slice(0, 60);
  if (typeof r.content === 'string' && r.content) out.content = r.content.slice(0, 4000);
  if (typeof r.imagePath === 'string' && r.imagePath) out.imagePath = r.imagePath;
  if (Number.isFinite(r.durationSec) && Number(r.durationSec) > 0) out.durationSec = Math.round(Number(r.durationSec));
  if (r.card && typeof r.card === 'object') {
    const c = r.card as Record<string, unknown>;
    out.card = {
      from: String(c.from || '').slice(0, 120),
      type: 'chatlog',
      content: String(c.content || '').slice(0, 200),
      ...(typeof c.imagePath === 'string' && c.imagePath ? { imagePath: c.imagePath } : {}),
      ...(typeof c.storyTime === 'string' && c.storyTime ? { storyTime: c.storyTime.slice(0, 60) } : {}),
    };
  }
  // 类型与关键字段必须自洽（坏条目丢弃，避免渲染层到处判空）
  if (type === 'image' && !out.imagePath) return null;
  if (type === 'card' && !out.card) return null;
  return out;
}

/** 收藏域净化（新→旧；同 messageId 去重（保留新的一条）；上限修剪，丢最旧）。 */
export function normalizeWechatFavs(raw: unknown): WeChatFavorite[] {
  const list = Array.isArray(raw)
    ? raw.map(normalizeWechatFavorite).filter((f): f is WeChatFavorite => f !== null)
    : [];
  list.sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set<string>();
  const deduped: WeChatFavorite[] = [];
  for (const f of list) {
    if (seen.has(f.messageId)) continue; // 同 messageId 全类型去重
    seen.add(f.messageId);
    deduped.push(f);
  }
  return trimWechatFavs(deduped).kept;
}

/** 上限修剪（纯函数）：新→旧保留前 max 条；返回被丢的（调用方用于提示/审计）。 */
export function trimWechatFavs(
  list: readonly WeChatFavorite[],
  max = MAX_WECHAT_FAVORITES,
): { kept: WeChatFavorite[]; dropped: WeChatFavorite[] } {
  const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
  return { kept: sorted.slice(0, max), dropped: sorted.slice(max) };
}

/** 收藏页筛选（纯函数）：'' = 全部；否则按类型。 */
export function filterWechatFavs(
  list: readonly WeChatFavorite[],
  type: '' | WeChatFavoriteType,
): WeChatFavorite[] {
  return type ? list.filter(f => f.type === type) : [...list];
}

/** 回跳目标（纯函数）：text/voice/card → 进原会话滚到原消息；image → null（走大图查看器，不跳会话）。 */
export function favoriteJumpTarget(fav: WeChatFavorite): { convId: string; mid: string } | null {
  if (fav.type === 'image') return null;
  if (!fav.conversationId || !fav.messageId) return null;
  return { convId: fav.conversationId, mid: fav.messageId };
}

/** 收藏行文案（纯函数）：各类型的内容摘要（渲染层补图标/时间）。 */
export function favoriteSummary(fav: WeChatFavorite): string {
  if (fav.type === 'text') return String(fav.content || '').trim() || '（空文本）';
  if (fav.type === 'voice') return String(fav.content || '').trim() || '（语音）';
  if (fav.type === 'image') return '图片';
  if (fav.type === 'card') return String(fav.card?.content || '').trim() || '聊天记录';
  return '';
}
