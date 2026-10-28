// ===== 商城消息（商家沟通）· 回复解析（docs/54 §4）=====
// 输出契约（提示词与解析器唯一锚点，标签常量在 core/protocol-tags）：
//   <ubp_shop_reply>
//   药王谷·百草堂: 客官好眼力
//   药王谷·百草堂: [图片]商品实拍：一只白玉瓷瓶…
//   药王谷·百草堂: [红包]88 上品灵石|好评返现，多谢照应
//   药王谷·百草堂: [改价]九转还魂丹|1050|老主顾了，这个价你拿去
//   药王谷·百草堂: [新商品]名：续命八丸｜价：400｜币：上品灵石｜述：…｜送：3｜图：🍃｜类：丹药
//   </ubp_shop_reply>
//
// 与微信 chat-parser 的差异（逐条对齐用户口径）：
//   · 发言者恒为本会话店铺名（外加少量别名兜底：商家/客服/掌柜…）；
//   · 富媒体**只认四类**（图片/红包/改价/新商品），其余前缀（[语音]/[转账]/[备忘]…）当普通文字
//     （与微信"分支外标签当普通文字"同口径，反幻觉）；
//   · 无备忘裸行兜底（商聊没有备忘）；
//   · 配额：改价 ≤1、红包 ≤1、新商品 ≤2、图片 ≤3；超出的行**降级为普通文字**（不丢 AI 说的话）；
//   · 0 条有效消息 = 解析失败（调用方如实报错，不静默）。
// 纯函数（除 sender 归一用到的正则外零依赖），可直测。

import { SENDER_LINE_RE, stripThinkingBlocks, resolveSender } from './chat-parser';
import { SHOP_REPLY_CLOSE_TAG, SHOP_REPLY_OPEN_TAG, lastTagBlock } from './protocol-tags';
import { unescapeBasicEntities } from './ubp-utils';
import {
  MAX_SHOP_MESSAGE_TEXT, shopNameKey, type ShopMessage,
} from './shop-chat-model';

/** 商家发言者别名兜底（AI 没写店名时的容忍写法；只认这批，不做模糊匹配）。 */
export const SHOP_CHAT_SENDER_ALIASES: readonly string[] = [
  '商家', '客服', '掌柜', '阁主', '店家', '小二', '伙计', '老板', '店主', '管事',
];

/** 单轮富媒体配额（超出降级为普通文字；提示词同口径）。 */
export const SHOP_CHAT_QUOTA = { image: 3, redpacket: 1, price: 1, item: 2 } as const;

export interface ShopParseQuotaInfo {
  /** 因配额耗尽被降级为普通文字的条数。 */
  downgraded: number;
  /** 因格式/币种无效被丢弃的条数（页内小字提示用）。 */
  dropped: number;
}

export interface ShopChatParseResult {
  /** 商家发言消息（按 AI 输出顺序）。 */
  messages: ParsedShopMessage[];
  quota: ShopParseQuotaInfo;
}

/** 解析出的商家消息（尚未落库；time/图片等字段由引擎补）。 */
export interface ParsedShopMessage {
  type: 'text' | 'image' | 'redpacket' | 'price' | 'item';
  /** 文本 / 图片画面描述 / 红包祝福语 / 新商品卡摘要。 */
  content: string;
  /** 红包金额串（两位小数/整数，按币种精度在引擎侧定稿）。 */
  amount?: string;
  /** 红包币种名（AI 原文，引擎侧严格解析）。 */
  currency?: string;
  /** 改价：商品名 + 新价数字 + 理由。 */
  price?: { itemName: string; to: number; note: string };
  /** 新商品：行式字段（与商城上架的 [商城] 块同一批字段键，引擎侧走同一套校验）。 */
  item?: { fields: Record<string, string>; reviews: string[] };
}

export interface ShopChatParseOptions {
  /** 本会话店铺名（发言者必须命中它或别名）。 */
  seller: string;
  /** 允许的币种名（红包 / 新商品定价必须命中；空数组 = 无货币联动，按占位币种放行）。 */
  currencies?: readonly string[];
  /** 无货币联动时的占位币种名（缺省「元」）。 */
  placeholderCurrency?: string;
}

/** 取最后一个 `<ubp_shop_reply>` 块；无标签时宽容兜底（多数行是「名字: 内容」就整段当块）。 */
export function extractShopReplyBlock(text: string): string {
  const stripped = stripThinkingBlocks(String(text || ''));
  const last = lastTagBlock(stripped, SHOP_REPLY_OPEN_TAG, SHOP_REPLY_CLOSE_TAG);
  if (last !== null) return last;
  // 截断容错：标签没闭合（被 max_tokens 截断）——取**最后一个开标签之后**整段当块
  // （与 shop-parser 同口径；不看闭合标签，因为那时它根本不存在）
  const openAt = stripped.lastIndexOf(SHOP_REPLY_OPEN_TAG);
  if (openAt >= 0) return stripped.slice(openAt + SHOP_REPLY_OPEN_TAG.length);
  const noFence = stripped.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const lines = noFence.split(/\n+/).filter(Boolean);
  if (!lines.length) return '';
  const senderLines = lines.filter(l => /^\s*[^:：\n]{1,24}[:：]\s*\S/.test(l)).length;
  return senderLines >= Math.ceil(lines.length * 0.6) ? noFence : '';
}

/** 发言者解析：店名精确/子串命中 > 商家别名兜底；解析不出返回 null（该行丢弃）。 */
export function resolveShopSender(raw: string, seller: string): string | null {
  const exact = resolveSender(raw, [seller]);
  if (exact) return seller;
  const name = String(raw || '').trim().replace(/^[\s@＠]+|[\s]+$/g, '');
  if (!name) return null;
  if (SHOP_CHAT_SENDER_ALIASES.some(a => name === a || name.startsWith(a))) return seller;
  // 店名被 AI 写残（「药王谷百草堂」少了间隔号 / 多了后缀）时按**去分隔符**的子串兜底
  const loose = (v: string): string => shopNameKey(v).replace(/[·・•．.\-_/\|]+/g, '');
  const a = loose(name);
  const b = loose(seller);
  if (a && b && (a.includes(b) || b.includes(a))) return seller;
  return null;
}

/** 金额解析（同微信口径：去符号取数、>0 且 <100 万）；可带币种名（"[红包]88 上品灵石|祝福语"）。 */
export function parseShopAmountNote(raw: string): { amount: number; currency: string; note: string } | null {
  const idx = raw.indexOf('|');
  const head = (idx >= 0 ? raw.slice(0, idx) : raw).trim();
  const note = (idx >= 0 ? raw.slice(idx + 1) : '').trim();
  const m = head.match(/^([+-]?\d+(?:\.\d+)?)\s*(.*)$/);
  const n = m ? Number(m[1]) : Number(head.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n >= 1000000) return null;
  return { amount: n, currency: m && m[2] ? m[2].trim().slice(0, 20) : '', note: note.slice(0, 100) };
}

/** 币种命中判定（trim + 忽略大小写全等；无货币联动时认占位币种名）。 */
function currencyAllowed(name: string, opts: ShopChatParseOptions): boolean {
  const list = opts.currencies || [];
  const key = String(name || '').trim().toLowerCase();
  if (!key) return list.length === 0; // 空币种：有联动时必须写；无联动可省（回落常用/占位）
  if (list.length) return list.some(c => c.toLowerCase() === key);
  const placeholder = String(opts.placeholderCurrency || '元').toLowerCase();
  return key === placeholder;
}

/** 改价载荷解析：`商品名|新价|理由`（理由可空；新价取数、>0）。 */
function parsePricePayload(rest: string): ParsedShopMessage['price'] | null {
  const parts = rest.split(/[|｜]/);
  const itemName = (parts[0] || '').trim().slice(0, 60);
  const price = Number(String(parts[1] || '').replace(/[^\d.]/g, ''));
  if (!itemName || !Number.isFinite(price) || price <= 0) return null;
  return { itemName, to: price, note: (parts.slice(2).join('|') || '').trim().slice(0, 120) };
}

/** 新商品载荷解析：`名：X｜价：N｜币：C｜述：…｜送：3｜图：🍃｜类：丹药｜评：昵称|评语`（｜ 与 | 都可）。 */
function parseItemPayload(rest: string): ParsedShopMessage['item'] | null {
  const fields: Record<string, string> = {};
  const reviews: string[] = [];
  const segs = rest.split(/[｜|]/);
  for (const seg of segs) {
    const m = /^\s*([^\s:：]{1,4})\s*[:：]\s*(.*)$/.exec(seg);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (!value) continue;
    if (key === '评' || key === '评价') {
      if (reviews.length < 3) reviews.push(value.slice(0, 120));
      continue;
    }
    if (!fields[key]) fields[key] = value.slice(0, 200);
  }
  return Object.keys(fields).length ? { fields, reviews } : null;
}

/**
 * 解析商家回复。
 * 逐行 `店铺名: 内容`；富媒体前缀白名单四类且受配额限制（超出降级为普通文字）；
 * 币种未命中的红包/新商品计入 dropped（丢弃该行但不打断其余消息）。
 */
export function parseShopReply(text: string, opts: ShopChatParseOptions): ShopChatParseResult | null {
  const block = extractShopReplyBlock(text);
  const result: ShopChatParseResult = { messages: [], quota: { downgraded: 0, dropped: 0 } };
  if (!block) return null;
  const used = { image: 0, redpacket: 0, price: 0, item: 0 };
  for (const rawLine of block.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[（(【\[]?系统提示|^[（(【\[]?注意[:：]/.test(line)) continue;
    const match = line.match(SENDER_LINE_RE);
    if (!match) continue; // 商聊无裸行兜底：非「名字: 内容」一律丢弃
    const sender = resolveShopSender(match[1], opts.seller);
    if (!sender) continue;
    let content = match[2].trim().replace(/^["“'『「]+/, '').replace(/["”'』」]+$/, '').trim();
    if (!content) continue;
    const fm = /^[【\[]\s*([^【\[\]】]{1,6})\s*[】\]]\s*([\s\S]*)$/.exec(content);
    const keyword = fm ? fm[1].trim() : '';
    const rest = fm ? fm[2].trim() : '';
    const pushText = (): void => {
      result.messages.push({ type: 'text', content: content.slice(0, MAX_SHOP_MESSAGE_TEXT) });
    };
    if (keyword === '图片' || keyword === '照片') {
      if (!rest) { result.quota.dropped += 1; continue; }
      if (used.image >= SHOP_CHAT_QUOTA.image) { result.quota.downgraded += 1; pushText(); continue; }
      used.image += 1;
      result.messages.push({ type: 'image', content: rest.slice(0, 200) });
      continue;
    }
    if (keyword === '红包') {
      const parsed = parseShopAmountNote(rest);
      if (!parsed) { result.quota.dropped += 1; continue; }
      if (used.redpacket >= SHOP_CHAT_QUOTA.redpacket) { result.quota.downgraded += 1; pushText(); continue; }
      if (parsed.currency && !currencyAllowed(parsed.currency, opts)) { result.quota.dropped += 1; continue; }
      used.redpacket += 1;
      result.messages.push({
        type: 'redpacket',
        content: parsed.note,
        amount: String(parsed.amount),
        currency: parsed.currency,
      });
      continue;
    }
    if (keyword === '改价') {
      const parsed = parsePricePayload(rest);
      if (!parsed) { result.quota.dropped += 1; continue; }
      if (used.price >= SHOP_CHAT_QUOTA.price) { result.quota.downgraded += 1; pushText(); continue; }
      used.price += 1;
      result.messages.push({ type: 'price', content: parsed.note, price: parsed });
      continue;
    }
    if (keyword === '新商品' || keyword === '上新') {
      const parsed = parseItemPayload(rest);
      if (!parsed) { result.quota.dropped += 1; continue; }
      if (used.item >= SHOP_CHAT_QUOTA.item) { result.quota.downgraded += 1; pushText(); continue; }
      used.item += 1;
      result.messages.push({ type: 'item', content: '', item: parsed });
      continue;
    }
    pushText();
  }
  if (!result.messages.length) return null;
  return result;
}

/** 消息一行摘要（会话内搜索/预览复用；与 shop-chat-model.shopMessagePreview 同口径的解析期版本）。 */
export function parsedShopMessagePreview(message: ParsedShopMessage): string {
  if (message.type === 'image') return `[图片] ${message.content.slice(0, 24)}`;
  if (message.type === 'redpacket') return `[红包] ${message.content.slice(0, 24) || '红包'}`;
  if (message.type === 'price') return message.price ? `[改价] ${message.price.itemName} → ${message.price.to}` : '[改价]';
  if (message.type === 'item') return `[新货] ${message.item?.fields['名'] || ''}`;
  return message.content.replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** 供引擎复用的 ShopMessage 空壳构造（解析结果 → 待落库消息）。 */
export function toShopMessageSkeleton(sender: string, parsed: ParsedShopMessage): ShopMessage | null {
  if (!sender) return null;
  const base = {
    id: '',
    from: sender,
    content: String(parsed.content || '').slice(0, MAX_SHOP_MESSAGE_TEXT),
    ts: 0,
  };
  if (parsed.type === 'text') return { ...base, id: '', type: 'text' } as ShopMessage;
  return null; // 富媒体由引擎逐类构造（携带各自的载荷与校验）
}

/** 反实体（AI 偶尔输出 &amp; 等；与全机同出口）。 */
export function cleanShopText(text: string): string {
  return unescapeBasicEntities(String(text || ''));
}
