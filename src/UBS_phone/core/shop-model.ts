// ===== 网上商城数据域（docs/52 规格）=====
// 定位：小手机里的「淘宝式」商城——AI 按世界观上货、用主项目货币结算、下单写备忘录、到货入库。
// 存储：随聊天存档（usb_phone_<h>.json）的 `shop` 域；旧档无该字段=空壳（零迁移）。
//
// 三条与规格逐条对齐的纪律：
//   1. **追加制 + 上限淘汰**（用户定案）：刷新不清空旧货，只在超出上限时淘汰「最旧且不受保护」的商品；
//      收藏与购物车里的商品**永不淘汰**（用户资产，宁超上限不误删）。
//   2. **币种存名不存 id**：币种 id 是主项目账本内的行键（跨聊天/换存档不稳定），
//      价格一律以「币种名」落库，展示与结算时经 payResolveCurrency 现解析。
//   3. **订单=快照**：下单即冻结商品（名称/价格/币种/描述），此后货架淘汰、改名、删币种都不影响历史订单。
// 纯函数集中在本模块（normalize / 合并淘汰 / 购物车 / 收藏 / 结算判定 / 统计派生），可单测。

import { isRecord } from './ubp-utils';
import { stampMinutes } from './social-time';
// 商家会话 / 我的评价 / 收货地址簿（docs/54）：结构与归一化在 shop-chat-model（叶子模块），
// 这里只做接入——两模块**单向**依赖（shop-model → shop-chat-model），绝不互相 import。
import {
  normalizeShopAddresses, normalizeShopMyReviews, normalizeShopThreads,
  type ShopAddress, type ShopMyReview, type ShopThread,
} from './shop-chat-model';
export type { ShopAddress, ShopMyReview, ShopThread } from './shop-chat-model';

/** 买家评价（AI 随商品一次产出；昵称 + 一句评语）。 */
export interface ShopReview {
  /** 评价者昵称（世界观内；缺省渲染层补「匿名买家」）。 */
  name: string;
  text: string;
}

export interface ShopItem {
  /** 跨批次唯一（'shp_'+时间戳+序号；照主项目 shop-story-ai 先例，防跨次生成撞 id）。 */
  id: string;
  name: string;
  /** 价格（按币种 precision 归一；存数字）。 */
  price: number;
  /** 币种名（存名不存 id，见文件头纪律 2）。 */
  currencyName: string;
  desc: string;
  /** 送货天数（购买后 N 日送达；1~15）。 */
  deliveryDays: number;
  /** 店铺名（缺省渲染层补风格默认）。 */
  seller: string;
  /** 图符 emoji（清洗 ≤2 码位，非法回落 🎁）。 */
  glyph: string;
  /** 分类（风格内自由文本，如 丹药/法器；本地筛选与详情展示用）。 */
  category: string;
  reviews: ShopReview[];
  /** 上架故事时间（YYYY-MM-DD；淘汰排序 + 「新」角标）。 */
  addedAt: string;
  /** 商品图标签缓存（生图第一步「商品标签翻译器」产物；与主项目衣柜单品同款规则）。 */
  imageTags?: string;
  /** 商品图路径（/user/images/...；按需生成，长期缓存）。 */
  image?: string;
  /** 最近一次生图失败原因（详情页展示 + 重试）。 */
  imageError?: string;
}

export interface ShopCartLine {
  /** 商品快照（价格锁定在下单时；货架淘汰不影响已加购的条目）。 */
  item: ShopItem;
  /** 数量（1~99）。 */
  qty: number;
  addedAt: string;
}

export type ShopOrderStatus = 'transit' | 'delivered' | 'cancelled';

export interface ShopOrder {
  id: string;
  /** 商品快照（含价格/币种/描述/图符）。 */
  item: ShopItem;
  qty: number;
  /** 实付金额（= price × qty，下单时按币种精度取整）。 */
  amount: number;
  currencyName: string;
  status: ShopOrderStatus;
  /** 下单故事时间（原文快照）。 */
  orderedAt: string;
  /** 预计送达日 YYYY-MM-DD（= 下单故事日 + deliveryDays；不可解析时留空=永不自动结算）。 */
  arriveDate: string;
  /** 备忘录行定位（插入成功时记实际标题——含 UNIQUE 冲突后缀；空 = 备忘写入失败）。 */
  memoTitle: string;
  /** 送达通知已读（角标/通知中心用）。 */
  seen?: boolean;
  cancelledAt?: string;
  /** 送达结算的入库结果（false = 物品表写入失败，待下次结算重试）。 */
  stocked?: boolean;
  /** 送达结算时间（故事时间快照，展示用）。 */
  deliveredAt?: string;
  /** 收货信息快照（docs/54 §10.4：下单这一刻的收货人/地址；此后改地址不影响历史订单）。 */
  shipTo?: { name: string; detail: string };
}

/**
 * 上一次上货的完成回执（用户定案：上货完成要弹通知横幅 + 进通知中心）。
 * 只存「还没看过的那一次」——通知中心读一次即清空（不新造已读状态，与全库通知口径一致）。
 */
export interface ShopRestockNotice {
  /** 本次新上架件数（0 不记）。 */
  count: number;
  /** 上货完成时的故事时间（通知时间文案用）。 */
  storyTime: string;
  /** 真实时间戳（通知排序用；故事时间不可比）。 */
  at: number;
}

export interface ShopData {
  /** 货架（累积，超上限淘汰最旧的非保护项）。 */
  catalog: ShopItem[];
  /** 收藏（独立于货架，不参与淘汰）。 */
  favorites: ShopItem[];
  cart: ShopCartLine[];
  /** 订单（新→旧）。 */
  orders: ShopOrder[];
  /** 上次上货故事时间（首页「上次上新」）。 */
  lastRefreshAt?: string;
  /** 待看的「上货完成」回执（null/缺省 = 没有）；通知中心消费后置空。 */
  lastRestock?: ShopRestockNotice | null;
  /** 商家会话（docs/54：一家店一条；旧档无字段=空数组，零迁移）。 */
  threads?: ShopThread[];
  /** 我的评价（docs/54：五星 + 文字 + 图，一商品一条）。 */
  myReviews?: ShopMyReview[];
  /** 收货地址簿（docs/54：≤5 条 + 一条默认）。 */
  addresses?: ShopAddress[];
  /** 默认地址 id（缺省/失效时回落最新一条）。 */
  defaultAddressId?: string;
}

// ─── 上限（存储成本与 UI 密度的平衡；货架上限由设置项驱动，见 core/phone-settings） ───

export const MAX_SHOP_ORDERS = 100;
export const MAX_SHOP_FAVORITES = 60;
export const MAX_SHOP_CART_LINES = 50;
/** 货架上限的出厂默认值（= 设置项 shopMaxItems 的默认值；2026-10-06 用户定案 40 → 100）。 */
export const SHOP_MAX_ITEMS_DEFAULT = 100;
export const SHOP_MAX_ITEMS_RANGE: readonly [number, number] = [20, 100];
/** 每批上货件数（= 设置项 shopBatchSize 的默认值/范围）。 */
export const SHOP_BATCH_DEFAULT = 8;
export const SHOP_BATCH_RANGE: readonly [number, number] = [4, 16];

const MAX_NAME = 40;
const MAX_DESC = 60;
const MAX_SELLER = 30;
const MAX_CATEGORY = 12;
const MAX_CURRENCY_NAME = 20;
/** 评价条数上限（解析器与本文件共用一份；提示词已放开条数，这是存储/展示的安全上限）。 */
export const SHOP_MAX_REVIEWS = 6;
const MAX_REVIEW_NAME = 24;
/** 评语字数上限（提示词要求 20~100 字；超长按上限截断）。 */
export const SHOP_MAX_REVIEW_TEXT = 100;
const MAX_GLYPH = 2;
/** 送货天数上限（提示词已放开为「按故事背景自由设定」，这里只钳制离谱值）。 */
export const SHOP_MAX_DELIVERY_DAYS = 99;
const MAX_QTY = 99;
/** 价格上限（防 AI 写出天文数字把余额校验与流水打爆）。 */
export const MAX_ITEM_PRICE = 1e9;

function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 价格归一：有限、>0、≤上限；否则 0（0 价商品在解析层已被丢弃，这里只兜脏数据）。 */
export function normalizePrice(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_ITEM_PRICE);
}

/** 图符清洗：去结构字符与控制符，≤2 码位（1 emoji 或 1 汉字）；非法回落 🎁。 */
export function normalizeGlyph(v: unknown): string {
  const raw = typeof v === 'string' ? v.replace(/[<>{}]/g, '').replace(/[\u0000-\u001f]/g, '').trim() : '';
  if (!raw) return '🎁';
  const chars = [...raw];
  if (chars.length > MAX_GLYPH) return '🎁';
  // 纯 ASCII 字母/数字不像商品图（多半是 AI 乱写）——回落默认图符
  if (/^[\x20-\x7e]+$/.test(raw)) return '🎁';
  return raw;
}

/** 商品名归一键（去空白 + 忽略大小写）：合并去重与「收藏/购物车保护」共用同一口径。 */
export function shopItemKey(name: string): string {
  return String(name || '').replace(/\s+/g, '').toLowerCase();
}

export function normalizeShopReview(raw: unknown): ShopReview | null {
  if (!isRecord(raw)) return null;
  const text = clampStr(raw.text, SHOP_MAX_REVIEW_TEXT);
  if (!text) return null;
  return { name: clampStr(raw.name, MAX_REVIEW_NAME), text };
}

export function normalizeShopItem(raw: unknown): ShopItem | null {
  if (!isRecord(raw)) return null;
  const name = clampStr(raw.name, MAX_NAME);
  const currencyName = clampStr(raw.currencyName, MAX_CURRENCY_NAME);
  const price = normalizePrice(raw.price);
  if (!name || !currencyName || price <= 0) return null;
  const reviews = (Array.isArray(raw.reviews) ? raw.reviews : [])
    .map(normalizeShopReview)
    .filter((r): r is ShopReview => r !== null)
    .slice(0, SHOP_MAX_REVIEWS);
  const item: ShopItem = {
    id: clampStr(raw.id, 60) || makeShopItemId(),
    name,
    price,
    currencyName,
    desc: clampStr(raw.desc, MAX_DESC),
    deliveryDays: clampInt(raw.deliveryDays, 1, SHOP_MAX_DELIVERY_DAYS, 3),
    seller: clampStr(raw.seller, MAX_SELLER),
    glyph: normalizeGlyph(raw.glyph),
    category: clampStr(raw.category, MAX_CATEGORY),
    reviews,
    addedAt: clampStr(raw.addedAt, 40),
  };
  const imageTags = clampStr(raw.imageTags, 400);
  if (imageTags) item.imageTags = imageTags;
  const image = clampStr(raw.image, 400);
  if (image) item.image = image;
  const imageError = clampStr(raw.imageError, 200);
  if (imageError) item.imageError = imageError;
  return item;
}

export function makeShopItemId(): string {
  return 'shp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function normalizeCartLine(raw: unknown): ShopCartLine | null {
  if (!isRecord(raw)) return null;
  const item = normalizeShopItem(raw.item);
  if (!item) return null;
  return { item, qty: clampInt(raw.qty, 1, MAX_QTY, 1), addedAt: clampStr(raw.addedAt, 40) };
}

export function normalizeShopOrder(raw: unknown): ShopOrder | null {
  if (!isRecord(raw)) return null;
  const item = normalizeShopItem(raw.item);
  if (!item) return null;
  const status = raw.status === 'delivered' || raw.status === 'cancelled' ? raw.status : 'transit';
  const qty = clampInt(raw.qty, 1, MAX_QTY, 1);
  const order: ShopOrder = {
    id: clampStr(raw.id, 60) || `sho_${Math.random().toString(36).slice(2, 10)}`,
    item,
    qty,
    amount: normalizePrice(raw.amount) || item.price * qty,
    currencyName: clampStr(raw.currencyName, MAX_CURRENCY_NAME) || item.currencyName,
    status,
    orderedAt: clampStr(raw.orderedAt, 40),
    arriveDate: clampStr(raw.arriveDate, 20),
    memoTitle: clampStr(raw.memoTitle, 60),
  };
  if (raw.seen === true) order.seen = true;
  const cancelledAt = clampStr(raw.cancelledAt, 40);
  if (cancelledAt) order.cancelledAt = cancelledAt;
  if (typeof raw.stocked === 'boolean') order.stocked = raw.stocked;
  const deliveredAt = clampStr(raw.deliveredAt, 40);
  if (deliveredAt) order.deliveredAt = deliveredAt;
  // 收货信息快照（docs/54）：两项都空则不落字段（旧档零迁移）
  if (isRecord(raw.shipTo)) {
    const name = clampStr(raw.shipTo.name, 20);
    const detail = clampStr(raw.shipTo.detail, 120);
    if (name || detail) order.shipTo = { name, detail };
  }
  return order;
}

export function emptyShopData(): ShopData {
  return { catalog: [], favorites: [], cart: [], orders: [] };
}

/** 域净化：脏条目丢弃、逐表收敛上限（订单丢最旧）、货架按名去重（**先出现者胜**——货架按新→旧有序，
 *  首个是最新上架的正式条目，后面的同名项是脏数据）。旧档无域=空壳。 */
export function normalizeShopData(raw: unknown): ShopData {
  if (!isRecord(raw)) return emptyShopData();
  const catalog: ShopItem[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.catalog) ? raw.catalog : []) {
    const item = normalizeShopItem(entry);
    if (!item) continue;
    const key = shopItemKey(item.name);
    if (seen.has(key)) continue;
    seen.add(key);
    catalog.push(item);
  }
  const favorites = (Array.isArray(raw.favorites) ? raw.favorites : [])
    .map(normalizeShopItem)
    .filter((x): x is ShopItem => x !== null)
    .slice(0, MAX_SHOP_FAVORITES);
  const cart = (Array.isArray(raw.cart) ? raw.cart : [])
    .map(normalizeCartLine)
    .filter((x): x is ShopCartLine => x !== null)
    .slice(0, MAX_SHOP_CART_LINES);
  const orders = (Array.isArray(raw.orders) ? raw.orders : [])
    .map(normalizeShopOrder)
    .filter((x): x is ShopOrder => x !== null)
    .slice(0, MAX_SHOP_ORDERS);
  const data: ShopData = { catalog, favorites, cart, orders };
  const lastRefreshAt = clampStr(raw.lastRefreshAt, 40);
  if (lastRefreshAt) data.lastRefreshAt = lastRefreshAt;
  const restock = normalizeRestockNotice(raw.lastRestock);
  if (restock) data.lastRestock = restock;
  // 商家会话 / 我的评价 / 地址簿（docs/54）：全空则**不落字段**（旧档零迁移、不写空壳键）
  const threads = normalizeShopThreads(raw.threads);
  if (threads.length) data.threads = threads;
  const myReviews = normalizeShopMyReviews(raw.myReviews);
  if (myReviews.length) data.myReviews = myReviews;
  const { addresses, defaultId } = normalizeShopAddresses(raw.addresses, raw.defaultAddressId);
  if (addresses.length) {
    data.addresses = addresses;
    if (defaultId) data.defaultAddressId = defaultId;
  }
  return data;
}

/** 上货回执归一化（脏数据一律丢弃——件数非正/不可解析=不是一次真实上货）。 */
function normalizeRestockNotice(raw: unknown): ShopRestockNotice | null {
  if (!isRecord(raw)) return null;
  const count = Math.floor(Number(raw.count));
  if (!Number.isFinite(count) || count <= 0) return null;
  const at = Number(raw.at);
  return { count: Math.min(count, 999), storyTime: clampStr(raw.storyTime, 40), at: Number.isFinite(at) ? at : 0 };
}

/** 取走「上货完成」回执（通知中心已读语义：读一次即清空，不新造已读状态）。 */
export function takeShopRestockNotice(data: ShopData): ShopRestockNotice | null {
  const notice = data.lastRestock || null;
  if (notice) data.lastRestock = null;
  return notice;
}

// ─── 合并 / 淘汰 / 保护（用户定案：追加 + 上限淘汰 + 收藏/购物车保护） ───

/** 受保护商品判定：收藏或购物车里出现过（按 id 或规范化名匹配——快照可能是旧 id）。 */
export function isProtectedItem(
  item: ShopItem,
  favorites: readonly ShopItem[],
  cart: readonly ShopCartLine[],
): boolean {
  const key = shopItemKey(item.name);
  const hit = (cand: ShopItem): boolean => cand.id === item.id || shopItemKey(cand.name) === key;
  return favorites.some(hit) || cart.some(line => hit(line.item));
}

/**
 * 上货合并（纯函数）：**本批新货插在货架最前**（货架按新→旧存，与订单/收藏/购物车同口径，
 * 渲染顺序即上架顺序的倒序——用户返修定案 2026-10-06）→ 按名去重（与既有货架/收藏重名的丢弃）
 * → 超上限时从**最尾的旧货**（本批之前就存在的、且不在收藏/购物车中的）开始淘汰。
 *
 * 两条口径（用户定案「超出才替换掉旧的物品」）：
 *   · **本批新货不参与同批淘汰**——刚上架就被踢掉等于白刷（且提示与实际不符）；
 *   · 旧货全部受保护时**停止淘汰**（允许暂时超上限，不误删用户资产）。
 * 返回新 ShopData（不改入参）。
 */
export function mergeShopCatalog(
  data: ShopData,
  incoming: readonly ShopItem[],
  maxItems: number,
): { data: ShopData; added: ShopItem[]; evicted: ShopItem[]; skipped: number } {
  const catalog = data.catalog.slice();
  const favorites = data.favorites || [];
  const cart = data.cart || [];
  const existing = new Set(catalog.map(it => shopItemKey(it.name)));
  const favKeys = new Set(favorites.map(it => shopItemKey(it.name)));
  const batch: ShopItem[] = [];
  const added: ShopItem[] = [];
  let skipped = 0;
  for (const item of incoming) {
    const key = shopItemKey(item.name);
    if (!key || existing.has(key) || favKeys.has(key)) { skipped += 1; continue; }
    existing.add(key);
    batch.push(item);
    added.push(item);
  }
  // 一批货作为一个整体插到最前（批内保持 AI 给出的顺序）；旧货顺次后移。
  catalog.unshift(...batch);
  const evicted: ShopItem[] = [];
  const cap = Math.max(1, Math.floor(maxItems) || SHOP_MAX_ITEMS_DEFAULT);
  const newIds = new Set(added.map(it => it.id));
  while (catalog.length > cap) {
    // 最旧 = 上架故事时间最早（同时间按入队顺序）——新→旧存的尾部即最旧，从尾往前找第一个非保护旧货
    let idx = -1;
    for (let i = catalog.length - 1; i >= 0; i--) {
      if (!newIds.has(catalog[i].id) && !isProtectedItem(catalog[i], favorites, cart)) { idx = i; break; }
    }
    if (idx < 0) break; // 旧货全部受保护：停止淘汰
    evicted.push(catalog[idx]);
    catalog.splice(idx, 1);
  }
  return { data: { ...data, catalog }, added, evicted, skipped };
}

// ─── 收藏 ───

export function isFavorited(data: ShopData, item: ShopItem): boolean {
  const key = shopItemKey(item.name);
  return (data.favorites || []).some(f => f.id === item.id || shopItemKey(f.name) === key);
}

/** 收藏/取消收藏（返回新 data；收藏表满时丢最旧）。 */
export function toggleFavorite(data: ShopData, item: ShopItem): ShopData {
  const favorites = (data.favorites || []).slice();
  const key = shopItemKey(item.name);
  const idx = favorites.findIndex(f => f.id === item.id || shopItemKey(f.name) === key);
  if (idx >= 0) {
    favorites.splice(idx, 1);
  } else {
    favorites.unshift(item);
    if (favorites.length > MAX_SHOP_FAVORITES) favorites.length = MAX_SHOP_FAVORITES;
  }
  return { ...data, favorites };
}

// ─── 购物车 ───

/** 加入购物车（同名合并数量；新条目在前）。 */
export function cartAdd(data: ShopData, item: ShopItem, qty = 1): ShopData {
  const cart = (data.cart || []).slice();
  const key = shopItemKey(item.name);
  const idx = cart.findIndex(line => line.item.id === item.id || shopItemKey(line.item.name) === key);
  const add = clampInt(qty, 1, MAX_QTY, 1);
  if (idx >= 0) {
    cart[idx] = { ...cart[idx], qty: clampInt(cart[idx].qty + add, 1, MAX_QTY, 1), item };
  } else {
    cart.unshift({ item, qty: add, addedAt: item.addedAt });
    if (cart.length > MAX_SHOP_CART_LINES) cart.length = MAX_SHOP_CART_LINES;
  }
  return { ...data, cart };
}

export function cartRemove(data: ShopData, itemId: string): ShopData {
  return { ...data, cart: (data.cart || []).filter(line => line.item.id !== itemId) };
}

export function cartSetQty(data: ShopData, itemId: string, qty: number): ShopData {
  const cart = (data.cart || []).map(line =>
    line.item.id === itemId ? { ...line, qty: clampInt(qty, 1, MAX_QTY, 1) } : line);
  return { ...data, cart };
}

/** 购物车件数合计（tab 角标；数量计，不是行数）。 */
export function cartTotalQty(data: ShopData): number {
  return (data.cart || []).reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
}

// ─── 手动删除（长按商品卡 / 收藏卡；用户定案 2026-10-15） ───

/**
 * 手动删除商品：从**货架 + 收藏 + 购物车**三处一并清除（订单快照不受影响——历史订单照常展示与送达）。
 * 匹配按 id 或规范化名（收藏/购物车里的快照可能是旧 id；与 isProtectedItem / isFavorited 同口径）。返回新 data。
 */
export function removeShopItem(data: ShopData, item: ShopItem): ShopData {
  const key = shopItemKey(item.name);
  const hit = (cand: ShopItem): boolean => cand.id === item.id || shopItemKey(cand.name) === key;
  return {
    ...data,
    catalog: (data.catalog || []).filter(it => !hit(it)),
    favorites: (data.favorites || []).filter(f => !hit(f)),
    cart: (data.cart || []).filter(line => !hit(line.item)),
  };
}

// ─── 订单 / 结算 / 统计 ───

/** 金额取整（按币种精度；0 位币种四舍五入到整数，2 位到分）。 */
export function clampAmount(n: number, precision: 0 | 2): number {
  const safe = Number.isFinite(n) ? n : 0;
  const f = precision === 2 ? 100 : 1;
  return Math.round(safe * f) / f;
}

/** 待结算订单（送达日 ≤ 今日故事日；arriveDate 不可解析的不参与——绝不拿真实时钟冒充）。
 *  F74：改数值比较（F60 同款）——dateKey 年份 4~6 位，字符串比较在跨位数纪年（9999→10000）下
 *  与数值序相反，会把「一万年才到」的订单提前结算送达（触发入库+通知全链路）。 */
export function shopOrdersDue(orders: readonly ShopOrder[], today: string): ShopOrder[] {
  const t = String(today || '').trim();
  if (!t) return [];
  const todayMin = stampMinutes(`${t} 00:00`);
  if (Number.isNaN(todayMin)) return [];
  return orders.filter(o => {
    if (o.status !== 'transit' || !o.arriveDate) return false;
    const due = stampMinutes(`${String(o.arriveDate).trim()} 00:00`);
    return !Number.isNaN(due) && due <= todayMin;
  });
}

/** 未读送达数（桌面角标：已送达且未看过的订单数）。 */
export function shopUnseenDelivered(data: ShopData): number {
  return (data.orders || []).filter(o => o.status === 'delivered' && o.seen !== true).length;
}

/** 在途订单数（「我的」页统计）。 */
export function shopTransitCount(data: ShopData): number {
  return (data.orders || []).filter(o => o.status === 'transit').length;
}

export interface ShopStats {
  /** 累计消费（币种名 → 金额；排除已取消）。 */
  spent: Record<string, number>;
  /** 已完成订单数（已送达）/ 在途数 / 总数。 */
  delivered: number;
  transit: number;
  total: number;
}

/** 统计派生（不新增存储：全部由 orders 现算）。 */
export function shopStats(data: ShopData): ShopStats {
  const spent: Record<string, number> = {};
  let delivered = 0;
  let transit = 0;
  for (const o of data.orders || []) {
    if (o.status === 'cancelled') continue;
    const key = o.currencyName || o.item.currencyName;
    spent[key] = clampAmount((spent[key] || 0) + (Number(o.amount) || 0), 2);
    if (o.status === 'delivered') delivered += 1;
    else transit += 1;
  }
  return { spent, delivered, transit, total: (data.orders || []).length };
}

/** 订单状态更新（返回新 data）。 */
export function updateOrder(data: ShopData, orderId: string, patch: Partial<ShopOrder>): ShopData {
  const orders = (data.orders || []).map(o => (o.id === orderId ? { ...o, ...patch } : o));
  return { ...data, orders };
}

/** 追加订单（新→旧，上限丢最旧）。 */
export function addOrder(data: ShopData, order: ShopOrder): ShopData {
  const orders = [order, ...(data.orders || [])];
  if (orders.length > MAX_SHOP_ORDERS) orders.length = MAX_SHOP_ORDERS;
  return { ...data, orders };
}

/** 「再次购买」：把订单快照放回购物车（价格以快照为准；币种失效由结算侧拦）。 */
export function reorderToCart(data: ShopData, order: ShopOrder): ShopData {
  return cartAdd(data, order.item, order.qty);
}

/** 货架分类清单（本地筛选 chips；按出现顺序去重）。 */
export function shopCategories(data: ShopData): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of data.catalog || []) {
    const c = String(item.category || '').trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.slice(0, 8);
}
