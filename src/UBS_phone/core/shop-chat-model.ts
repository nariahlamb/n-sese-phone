// ===== 商城消息（商家沟通）· 数据域（docs/54 §2）=====
// 定位：商城第四个 tab「消息」——**一家店一条会话**；从商品详情左下角「消息」进入，聊的围绕那件商品。
// 本模块是**叶子模块**（运行期只依赖 ubp-utils；对 shop-model 只有 type 引用），
// 由 core/shop-model 反向 import 它的归一化函数接进 ShopData——两模块不互相 import，杜绝环形依赖。
//
// 四条纪律：
//   1. **不进微信 conversations**：商家会话对微信完全隐形（否则会被微信的转发/收藏/多选/搜索作用到，
//      更糟的是微信资料块的「最近手机记录」会把商家消息当角色聊天读进提示词）。
//   2. **消息字段命名对齐 PhoneMessage**（from/type/content/ts/storyTime…）：解析器与渲染层照微信写法抄，
//      但类型自持（微信的电话簿/收藏/转发对商聊无意义）。
//   3. **名字归并一律走 shopNameKey**（去空白 + 忽略大小写）——与 `shop-model.shopItemKey` 同口径，
//      单测锁一致性；会话主键、返现额度、评价归并、改价命中四处共用同一把尺。
//   4. **改价/返现都只动当前聊天的存储**：历史订单是快照，永不回溯。

import { isRecord } from './ubp-utils';
import type { ShopCartLine, ShopData, ShopItem, ShopOrder } from './shop-model';

// ─── 上限（防脏数据撑爆存档；UI 与提示词共用） ───

/** 会话数上限（超出按 updatedAt 淘汰最旧）。 */
export const MAX_SHOP_THREADS = 60;
/** 单会话消息上限（超出丢最旧保尾）。 */
export const MAX_SHOP_THREAD_MESSAGES = 500;
/** 输入框草稿上限。 */
export const MAX_SHOP_DRAFT = 500;
/** 我的评价条数上限（一商品一条，重评覆盖）。 */
export const MAX_SHOP_MY_REVIEWS = 100;
/** 地址簿条数上限。 */
export const MAX_SHOP_ADDRESSES = 5;
/** 单条文本上限。 */
export const MAX_SHOP_MESSAGE_TEXT = 2000;
/** 评价文字上限 / 图片张数 / 星级上限。 */
export const MAX_SHOP_REVIEW_TEXT = 200;
export const MAX_SHOP_REVIEW_IMAGES = 3;
export const MAX_SHOP_REVIEW_RATING = 5;
/** 收货人 / 地址长度上限。 */
export const MAX_SHOP_ADDRESS_NAME = 20;
export const MAX_SHOP_ADDRESS_DETAIL = 120;
/**
 * 资料块「与这位买家的沟通记录」条数（用户 2026-10-06 定案 30 条）。
 * 商聊单轮信息密度低（一句一句短消息），30 条足以跨过一整轮砍价→下单→收货的完整往来。
 */
export const SHOP_CHAT_CONTEXT_LINES = 30;
/** 单会话商家红包累计上限（防 AI 无限返现）。 */
export const SHOP_CHAT_REBATE_LIMIT = 5;
/** 商家红包金额上限（与微信 parseAmountNote 同口径：>0 且 <100 万）。 */
export const MAX_SHOP_REDPACKET = 1000000;

// ─── 结构 ───

/** 商城消息类型（四类富媒体 + 文字）。 */
export type ShopMessageType = 'text' | 'image' | 'redpacket' | 'price' | 'item';

export interface ShopMessage {
  id: string;
  /** 'me' | 'system' | 店铺名（商家发言恒为本会话店铺名）。 */
  from: string;
  type: ShopMessageType;
  /** 文本 / 图片画面描述 / 红包祝福语。 */
  content: string;
  /** 内部时间戳（ms）：仅排序/去重/ID 用，不显示、不进提示词（全机只用故事时间）。 */
  ts: number;
  /** 世界观时间快照（生成时全局数据表「当前时间」）。 */
  storyTime?: string;
  /** 图片消息（同微信口径：两步法生图 + 固化提示词 + 手动重试）。 */
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  imageManual?: boolean;
  imagePrompt?: string;
  imageNegative?: string;
  /** 红包：金额串 + 币种名 + 领取标记（商家发的未领取时气泡右侧挂「開」；我方发的恒已领取）。 */
  amount?: string;
  currency?: string;
  claimed?: boolean;
  /** 改价卡：from=改前价，to=改后价，applied=是否已在商城命中落价。 */
  priceChange?: {
    itemName: string;
    from: number;
    to: number;
    currencyName: string;
    note: string;
    applied: boolean;
  };
  /** 商品卡（商家上新）：快照 + 上架结果（listed=false = 重名已在架）。 */
  newItem?: { item: ShopItem; listed: boolean };
  /** 引用回复：被引用发言的快照（静态；原消息后续删除不影响本引用）。 */
  quote?: { from: string; content: string };
}

/** 一条商家会话（主键 = 店铺名归一键）。 */
export interface ShopThread {
  id: string;
  /** 显示用店铺名（首次建会话时的原文；此后只读）。 */
  seller: string;
  messages: ShopMessage[];
  createdAt: number;
  updatedAt: number;
  /** 未读消息数（打开会话即清零）。 */
  unread: number;
  /** 输入框草稿（真机习惯；发送/清空即删字段）。 */
  draft?: string;
  /** 本次进入时的咨询商品 id（仅 UI 记忆，可空）。 */
  focusItemId?: string;
  /** 已返现记录（防 AI 无限返现：同一商品只返现一次）。 */
  rebates?: Array<{ itemName: string; at: string }>;
}

/** 用户评价（一商品一条，重评覆盖）。 */
export interface ShopMyReview {
  id: string;
  /** 商品归一键（shopNameKey）——商品可能被淘汰，名是稳定键。 */
  itemKey: string;
  /** 展示用商品名（原文快照）。 */
  itemName: string;
  /** 1~5 星。 */
  rating: number;
  /** 文字描述（≤200 字，可空——只打星也算评价）。 */
  text: string;
  /** 图片（≤3 张；复用相册既有图片路径，绝不重新生图）。 */
  images: string[];
  /** 评价时的故事时间（展示与资料块共用）。 */
  createdAt: string;
  ts: number;
  /** 评价时该商品有已送达订单（详情页显示「已购」角标）。 */
  verified?: boolean;
}

/** 收货地址（地址簿一条；可多条、可设默认）。 */
export interface ShopAddress {
  id: string;
  /** 收货人姓名。 */
  name: string;
  /** 收货地址（自由文本；从地点清单选时填入地点全路径）。 */
  detail: string;
  /** 来源地点 nodeId（可选，仅作来源回显）。 */
  locationId?: string;
  updatedAt: number;
}

// ─── 归一键 ───

/** 名字归一键（去空白 + 忽略大小写）：与 `shop-model.shopItemKey` 同口径（单测锁一致性）。 */
export function shopNameKey(name: string): string {
  return String(name || '').replace(/\s+/g, '').toLowerCase();
}

/** 店铺归一键（会话主键；与商品 seller 归并同口径）。 */
export function shopSellerKey(seller: string): string {
  return shopNameKey(seller);
}

let _seq = 0;
function makeId(prefix: string): string {
  _seq = (_seq + 1) % 100000;
  return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function makeShopMessageId(): string {
  return makeId('shm_');
}

export function makeShopThreadId(seller: string): string {
  return `thr_${shopSellerKey(seller) || makeId('x')}`;
}

export function makeShopReviewId(): string {
  return makeId('shr_');
}

export function makeShopAddressId(): string {
  return makeId('sha_');
}

// ─── 归一化 ───

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 单个改价载荷净化（脏数据整块丢弃）。 */
function normalizePriceChange(raw: unknown): ShopMessage['priceChange'] | undefined {
  if (!isRecord(raw)) return undefined;
  const itemName = str(raw.itemName, 60);
  const from = Number(raw.from);
  const to = Number(raw.to);
  if (!itemName || !Number.isFinite(from) || !Number.isFinite(to) || to <= 0) return undefined;
  return {
    itemName,
    from: Math.max(0, from),
    to,
    currencyName: str(raw.currencyName, 20),
    note: str(raw.note, 120),
    applied: raw.applied === true,
  };
}

/** 单个商品卡载荷净化（商品快照走 ShopItem 的归一化，由调用方传入以复用；此处只兜结构）。 */
function normalizeNewItem(raw: unknown): ShopMessage['newItem'] | undefined {
  if (!isRecord(raw) || !isRecord(raw.item)) return undefined;
  return { item: raw.item as unknown as ShopItem, listed: raw.listed === true };
}

export function normalizeShopMessage(raw: unknown): ShopMessage | null {
  if (!isRecord(raw)) return null;
  const from = str(raw.from, 60);
  if (!from) return null;
  const type: ShopMessageType = raw.type === 'image' || raw.type === 'redpacket' || raw.type === 'price' || raw.type === 'item'
    ? raw.type
    : 'text';
  const message: ShopMessage = {
    id: str(raw.id, 60) || makeShopMessageId(),
    from,
    type,
    content: str(raw.content, MAX_SHOP_MESSAGE_TEXT),
    ts: num(raw.ts, Date.now()),
  };
  const storyTime = str(raw.storyTime, 60);
  if (storyTime) message.storyTime = storyTime;
  if (type === 'image') {
    const imagePath = str(raw.imagePath, 400);
    if (imagePath) message.imagePath = imagePath;
    const st = raw.imageStatus;
    if (st === 'pending' || st === 'ready' || st === 'failed') message.imageStatus = st;
    if (raw.imageManual === true) message.imageManual = true;
    const prompt = str(raw.imagePrompt, 4000);
    if (prompt) message.imagePrompt = prompt;
    const neg = typeof raw.imageNegative === 'string' ? raw.imageNegative.slice(0, 2000) : '';
    if (neg) message.imageNegative = neg;
  }
  if (type === 'redpacket') {
    const amount = str(raw.amount, 12);
    if (amount) message.amount = amount;
    const currency = str(raw.currency, 20);
    if (currency) message.currency = currency;
    message.claimed = raw.claimed !== false; // 缺省视为已领取（旧档/我方发出的）
  }
  if (type === 'price') {
    const pc = normalizePriceChange(raw.priceChange);
    if (!pc) return null; // 改价卡没有载荷 = 脏数据
    message.priceChange = pc;
  }
  if (type === 'item') {
    const ni = normalizeNewItem(raw.newItem);
    if (!ni) return null;
    message.newItem = ni;
  }
  if (isRecord(raw.quote)) {
    const from = str(raw.quote.from, 60);
    const content = str(raw.quote.content, 200);
    if (from && content) message.quote = { from, content };
  }
  return message;
}

/** 会话归一化（消息逐条净化；`draft` 空串不存）。 */
export function normalizeShopThread(raw: unknown): ShopThread | null {
  if (!isRecord(raw)) return null;
  const seller = str(raw.seller, 30);
  if (!seller) return null;
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map(normalizeShopMessage)
    .filter((m): m is ShopMessage => m !== null);
  const thread: ShopThread = {
    id: str(raw.id, 60) || makeShopThreadId(seller),
    seller,
    messages: messages.slice(Math.max(0, messages.length - MAX_SHOP_THREAD_MESSAGES)),
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    unread: Math.max(0, Math.floor(num(raw.unread, 0))),
  };
  const draft = str(raw.draft, MAX_SHOP_DRAFT);
  if (draft) thread.draft = draft;
  const focus = str(raw.focusItemId, 60);
  if (focus) thread.focusItemId = focus;
  if (Array.isArray(raw.rebates)) {
    const rebates = raw.rebates
      .map(r => (isRecord(r) ? { itemName: str(r.itemName, 60), at: str(r.at, 40) } : null))
      .filter((r): r is { itemName: string; at: string } => r !== null && Boolean(r.itemName))
      .slice(0, 50);
    if (rebates.length) thread.rebates = rebates;
  }
  return thread;
}

/** 会话表归一化：同名归并（先出现者胜）+ 上限按 updatedAt 淘汰最旧。 */
export function normalizeShopThreads(raw: unknown): ShopThread[] {
  const list = (Array.isArray(raw) ? raw : [])
    .map(normalizeShopThread)
    .filter((t): t is ShopThread => t !== null);
  const byKey = new Map<string, ShopThread>();
  for (const thread of list) {
    const key = shopSellerKey(thread.seller);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, thread);
  }
  const out = Array.from(byKey.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, MAX_SHOP_THREADS);
}

export function normalizeShopMyReview(raw: unknown): ShopMyReview | null {
  if (!isRecord(raw)) return null;
  const itemName = str(raw.itemName, 60);
  if (!itemName) return null;
  const rating = clampInt(raw.rating, 1, MAX_SHOP_REVIEW_RATING, 5);
  const images = (Array.isArray(raw.images) ? raw.images : [])
    .map(p => str(p, 400))
    .filter(Boolean)
    .slice(0, MAX_SHOP_REVIEW_IMAGES);
  const review: ShopMyReview = {
    id: str(raw.id, 60) || makeShopReviewId(),
    itemKey: str(raw.itemKey, 80) || shopNameKey(itemName),
    itemName,
    rating,
    text: str(raw.text, MAX_SHOP_REVIEW_TEXT),
    images,
    createdAt: str(raw.createdAt, 40),
    ts: num(raw.ts, Date.now()),
  };
  if (raw.verified === true) review.verified = true;
  return review;
}

/** 我的评价表归一化：一商品一条（先出现者胜）+ 上限丢最旧。 */
export function normalizeShopMyReviews(raw: unknown): ShopMyReview[] {
  const list = (Array.isArray(raw) ? raw : [])
    .map(normalizeShopMyReview)
    .filter((r): r is ShopMyReview => r !== null);
  const byKey = new Map<string, ShopMyReview>();
  for (const review of list) {
    const key = review.itemKey || shopNameKey(review.itemName);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, review);
  }
  return Array.from(byKey.values()).sort((a, b) => b.ts - a.ts).slice(0, MAX_SHOP_MY_REVIEWS);
}

export function normalizeShopAddress(raw: unknown): ShopAddress | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name, MAX_SHOP_ADDRESS_NAME);
  const detail = str(raw.detail, MAX_SHOP_ADDRESS_DETAIL);
  if (!name && !detail) return null;
  const address: ShopAddress = {
    id: str(raw.id, 60) || makeShopAddressId(),
    name,
    detail,
    updatedAt: num(raw.updatedAt, Date.now()),
  };
  const locationId = str(raw.locationId, 64);
  if (locationId) address.locationId = locationId;
  return address;
}

/** 地址簿归一化：去重（同 id/同全称去重）+ 上限丢最旧 + 默认键校正（默认缺失回落最新一条）。 */
export function normalizeShopAddresses(raw: unknown, rawDefaultId: unknown): { addresses: ShopAddress[]; defaultId: string } {
  const list = (Array.isArray(raw) ? raw : [])
    .map(normalizeShopAddress)
    .filter((a): a is ShopAddress => a !== null);
  const seen = new Set<string>();
  const addresses: ShopAddress[] = [];
  for (const address of list) {
    const key = `${address.name}|${address.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }
  const capped = addresses.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SHOP_ADDRESSES);
  const want = str(rawDefaultId, 60);
  const defaultId = capped.some(a => a.id === want) ? want : (capped[0]?.id || '');
  return { addresses: capped, defaultId };
}

// ─── 会话操作 ───

export function findShopThread(threads: readonly ShopThread[] | undefined, seller: string): ShopThread | null {
  const key = shopSellerKey(seller);
  if (!key) return null;
  return (threads || []).find(t => t.id === makeShopThreadId(seller) || shopSellerKey(t.seller) === key) || null;
}

/** 取或建会话（就地 push 进 threads；调用方保证 threads 是可变数组）。 */
export function ensureShopThread(threads: ShopThread[], seller: string, now = Date.now()): ShopThread {
  const hit = findShopThread(threads, seller);
  if (hit) return hit;
  const thread: ShopThread = {
    id: makeShopThreadId(seller),
    seller: seller.slice(0, 30),
    messages: [],
    createdAt: now,
    updatedAt: now,
    unread: 0,
  };
  threads.push(thread);
  if (threads.length > MAX_SHOP_THREADS) {
    // 淘汰最旧（刚建的这条不参与——它一定是最新的）
    const oldest = threads
      .map((t, i) => ({ t, i }))
      .filter(x => x.t !== thread)
      .sort((a, b) => a.t.updatedAt - b.t.updatedAt)[0];
    if (oldest) threads.splice(oldest.i, 1);
  }
  return thread;
}

/** 追加消息（更新 updatedAt；超上限丢最旧保尾）。 */
export function appendShopMessage(thread: ShopThread, message: ShopMessage): ShopThread {
  thread.messages.push(message);
  if (thread.messages.length > MAX_SHOP_THREAD_MESSAGES) {
    thread.messages.splice(0, thread.messages.length - MAX_SHOP_THREAD_MESSAGES);
  }
  thread.updatedAt = message.ts;
  return thread;
}

/** 未读合计（消息 tab 角标 / 桌面角标用）。 */
export function shopThreadUnreadTotal(threads: readonly ShopThread[] | undefined): number {
  return (threads || []).reduce((sum, t) => sum + Math.max(0, Math.floor(Number(t.unread) || 0)), 0);
}

/** 最近一条非 system 消息（会话列表预览）。 */
export function shopThreadLastMessage(thread: ShopThread): ShopMessage | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i];
    if (m.from === 'system') continue;
    return m;
  }
  return null;
}

/** 单条消息的一行摘要（会话列表预览）。 */
export function shopMessagePreview(m: ShopMessage): string {
  if (m.type === 'image') return `[图片] ${m.content.slice(0, 24)}`;
  if (m.type === 'redpacket') return `[红包] ${m.content.slice(0, 24) || '红包'}`;
  if (m.type === 'price') {
    const pc = m.priceChange;
    return pc ? `[改价] ${pc.itemName} ${pc.from} → ${pc.to}` : '[改价]';
  }
  if (m.type === 'item') {
    const it = m.newItem?.item;
    return it ? `[新货] ${it.name} ${it.currencyName} ${it.price}` : '[新货]';
  }
  return m.content.replace(/\s+/g, ' ').trim().slice(0, 40);
}

// ─── 商品状态派生（资料块「商品当前状态」，零新增存储） ───

/** 一件商品与本买家的关系状态（现算：来自购物车/订单/我的评价）。 */
export interface ShopItemStatus {
  /** 购物车里的数量（0 = 不在车里）。 */
  cartQty: number;
  /** 在途订单：件数合计 + 最近一条预计到达日。 */
  transitQty: number;
  transitArrive: string;
  /** 已送达件数合计。 */
  deliveredQty: number;
  /** 我给的星级（0 = 没评过）。 */
  rating: number;
}

export function emptyShopItemStatus(): ShopItemStatus {
  return { cartQty: 0, transitQty: 0, transitArrive: '', deliveredQty: 0, rating: 0 };
}

/** 现算某件商品的状态（购物车 ∪ 订单 ∪ 我的评价；按名归并）。 */
export function shopItemStatus(
  data: Pick<ShopData, 'cart' | 'orders' | 'myReviews'> | null | undefined,
  itemName: string,
): ShopItemStatus {
  const status = emptyShopItemStatus();
  const key = shopNameKey(itemName);
  if (!key || !data) return status;
  for (const line of (data.cart || []) as ShopCartLine[]) {
    if (shopNameKey(line?.item?.name || '') === key) status.cartQty += Math.max(0, Math.floor(Number(line.qty) || 0));
  }
  for (const order of (data.orders || []) as ShopOrder[]) {
    if (shopNameKey(order?.item?.name || '') !== key) continue;
    const qty = Math.max(1, Math.floor(Number(order.qty) || 1));
    if (order.status === 'delivered') status.deliveredQty += qty;
    else if (order.status === 'transit') {
      status.transitQty += qty;
      const arrive = String(order.arriveDate || '').trim();
      if (arrive && (!status.transitArrive || arrive < status.transitArrive)) status.transitArrive = arrive;
    }
  }
  for (const review of (data.myReviews || []) as ShopMyReview[]) {
    if ((review.itemKey || shopNameKey(review.itemName)) === key) status.rating = Math.max(status.rating, Math.floor(Number(review.rating) || 0));
  }
  return status;
}

/** 状态一句话（资料块与商品卡共用）：如「已送达 ×2、已评价 ★★★★★」；无记录 = 「未买过」。 */
export function shopItemStatusLabel(status: ShopItemStatus): string {
  const parts: string[] = [];
  if (status.cartQty > 0) parts.push(`在购物车 ×${status.cartQty}`);
  if (status.transitQty > 0) parts.push(`已下单 ${status.transitQty} 件${status.transitArrive ? `，预计 ${status.transitArrive} 到` : ''}`);
  if (status.deliveredQty > 0) parts.push(`已送达 ×${status.deliveredQty}`);
  if (status.rating > 0) parts.push(`已评价 ${'★'.repeat(Math.max(1, Math.min(5, status.rating)))}`);
  return parts.join('、') || '未买过';
}

/** 本店在售商品（货架 ∪ 收藏 ∪ 购物车中 seller 命中的；按名去重、上限 40）——资料块与店铺视图共用。 */
export function listShopItemsForSeller(data: ShopData | null | undefined, seller: string, cap = 40): ShopItem[] {
  const key = shopSellerKey(seller);
  if (!key || !data) return [];
  const seen = new Set<string>();
  const out: ShopItem[] = [];
  const push = (item: ShopItem | undefined | null): void => {
    if (!item) return;
    if (shopSellerKey(item.seller) !== key) return;
    const nameKey = shopNameKey(item.name);
    if (!nameKey || seen.has(nameKey)) return;
    seen.add(nameKey);
    out.push(item);
  };
  for (const item of data.catalog || []) push(item);
  for (const item of data.favorites || []) push(item);
  for (const line of data.cart || []) push(line.item);
  return out.slice(0, cap);
}

// ─── 改价应用（用户口径：体现在前端物品界面） ───

/**
 * 把某件商品的价格改成 newPrice（货架 ∪ 收藏 ∪ 购物车三表同步；**订单不动**——快照冻结）。
 * 返回新 data 与是否命中（一处未命中 = 该商品已不在货架，卡片标「已不在货架上」）。
 */
export function applyShopPriceChange(
  data: ShopData,
  itemName: string,
  newPrice: number,
): { data: ShopData; applied: boolean } {
  const key = shopNameKey(itemName);
  if (!key || !(newPrice > 0)) return { data, applied: false };
  let applied = false;
  const hit = (item: ShopItem): ShopItem => {
    if (shopNameKey(item.name) !== key || item.price === newPrice) return item;
    applied = true;
    return { ...item, price: newPrice };
  };
  const catalog = (data.catalog || []).map(hit);
  const favorites = (data.favorites || []).map(hit);
  const cart = (data.cart || []).map(line => {
    const item = hit(line.item);
    return item === line.item ? line : { ...line, item };
  });
  if (!applied) return { data, applied: false };
  return { data: { ...data, catalog, favorites, cart }, applied: true };
}

/** 该商品「最近一次改价的原价」（详情/购物车划线用；没有则 ''）。 */
export function lastShopPriceFrom(threads: readonly ShopThread[] | undefined, itemName: string): number {
  const key = shopNameKey(itemName);
  if (!key) return 0;
  let latest: ShopMessage | null = null;
  for (const thread of threads || []) {
    for (const m of thread.messages || []) {
      if (m.type !== 'price' || !m.priceChange) continue;
      if (shopNameKey(m.priceChange.itemName) !== key) continue;
      if (!latest || m.ts >= latest.ts) latest = m;
    }
  }
  return latest?.priceChange ? latest.priceChange.from : 0;
}

// ─── 评价准入（用户 2026-10-06 二轮口径：买了且收到货才能评价） ───

/**
 * 该商品能否评价：**存在已送达订单**（按名归并；取消/在途都不算）。
 * 渲染层（入口显隐）与动作层（保存兜底）共用同一判据——避免两处漂移。
 */
export function canReviewItem(orders: readonly ShopOrder[] | undefined, itemName: string): boolean {
  const key = shopNameKey(itemName);
  if (!key) return false;
  return (orders || []).some(o => o.status === 'delivered' && shopNameKey(o?.item?.name || '') === key);
}

// ─── 返现额度（防 AI 无限返现） ───

/** 该商品是否还能返现（同一商品只返一次；会话累计 ≤ SHOP_CHAT_REBATE_LIMIT）。 */
export function canShopRebate(thread: ShopThread, itemName: string): boolean {
  const key = shopNameKey(itemName);
  if (!key) return false;
  if ((thread.rebates || []).some(r => shopNameKey(r.itemName) === key)) return false;
  const count = (thread.messages || []).filter(m => m.type === 'redpacket' && m.from !== 'me').length;
  return count < SHOP_CHAT_REBATE_LIMIT;
}

/** 记一笔返现（就地写进会话；配合 canShopRebate 用）。 */
export function markShopRebate(thread: ShopThread, itemName: string, at: string): void {
  thread.rebates = [...(thread.rebates || []), { itemName: itemName.slice(0, 60), at: at.slice(0, 40) }].slice(-50);
}

// ─── 评价 / 地址的增改删（返回新数组） ───

export function findShopReview(reviews: readonly ShopMyReview[] | undefined, itemName: string): ShopMyReview | null {
  const key = shopNameKey(itemName);
  if (!key) return null;
  return (reviews || []).find(r => r.itemKey === key || shopNameKey(r.itemName) === key) || null;
}

/** 一商品一条：已有则整条替换（重评），否则插入最前 + 上限丢最旧。 */
export function upsertShopReview(reviews: readonly ShopMyReview[] | undefined, review: ShopMyReview): ShopMyReview[] {
  const key = review.itemKey || shopNameKey(review.itemName);
  const rest = (reviews || []).filter(r => (r.itemKey || shopNameKey(r.itemName)) !== key);
  return [review, ...rest].slice(0, MAX_SHOP_MY_REVIEWS);
}

export function removeShopReview(reviews: readonly ShopMyReview[] | undefined, itemName: string): ShopMyReview[] {
  const key = shopNameKey(itemName);
  return (reviews || []).filter(r => (r.itemKey || shopNameKey(r.itemName)) !== key);
}

/** 加/改一条地址（同 id 覆盖，否则插入最前）+ 上限丢最旧；返回新数组。 */
export function upsertShopAddress(addresses: readonly ShopAddress[] | undefined, address: ShopAddress): ShopAddress[] {
  const rest = (addresses || []).filter(a => a.id !== address.id);
  return [address, ...rest].slice(0, MAX_SHOP_ADDRESSES);
}

export function removeShopAddress(addresses: readonly ShopAddress[] | undefined, id: string): ShopAddress[] {
  return (addresses || []).filter(a => a.id !== id);
}

/** 默认地址（defaultId 命中优先；缺失回落最新一条）。 */
export function defaultShopAddress(
  addresses: readonly ShopAddress[] | undefined,
  defaultId: string,
): ShopAddress | null {
  const list = addresses || [];
  if (!list.length) return null;
  return list.find(a => a.id === defaultId) || list[0] || null;
}

/** 地址一行文本（备忘 / 商家消息 / 结算行共用）：`收货人 · 地址`。 */
export function shopAddressText(address: ShopAddress | null): string {
  if (!address) return '';
  const name = String(address.name || '').trim();
  const detail = String(address.detail || '').trim();
  if (name && detail) return `${name} · ${detail}`;
  return name || detail;
}

// ─── 消息构造 ───

export function buildShopTextMessage(from: string, content: string, storyTime?: string): ShopMessage {
  return {
    id: makeShopMessageId(),
    from,
    type: 'text',
    content: String(content || '').slice(0, MAX_SHOP_MESSAGE_TEXT),
    ts: Date.now(),
    ...(storyTime ? { storyTime } : {}),
  };
}

export function buildShopRedPacketMessage(args: {
  from: string;
  amount: string;
  currency: string;
  note: string;
  claimed: boolean;
  storyTime?: string;
}): ShopMessage {
  return {
    id: makeShopMessageId(),
    from: args.from,
    type: 'redpacket',
    content: String(args.note || '').slice(0, 100),
    ts: Date.now(),
    amount: String(args.amount || '').slice(0, 12),
    currency: String(args.currency || '').slice(0, 20),
    claimed: args.claimed,
    ...(args.storyTime ? { storyTime: args.storyTime } : {}),
  };
}

/** 空域（新建会话时的默认 shape；与 shop-model.emptyShopData 的字段互补，避免循环依赖）。 */
export function emptyShopChatFields(): { threads: ShopThread[]; myReviews: ShopMyReview[]; addresses: ShopAddress[]; defaultAddressId: string } {
  return { threads: [], myReviews: [], addresses: [], defaultAddressId: '' };
}
