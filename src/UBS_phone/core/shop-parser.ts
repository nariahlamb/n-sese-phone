// ===== 网上商城 · 解析器（docs/52 §4.4）=====
// 行式结构（不引 YAML 依赖，与浏览器/社媒同族）：
//   <商城>
//   - 名：九转还魂丹
//     价：1200
//     币：上品灵石
//     述：以三味灵草炼成，服之可续断脉、活死肌。
//     送：3
//     铺：药王谷·百草堂
//     图：🧪
//     类：丹药
//     评：青云门小师弟|药香扑鼻，服下三日便觉经脉通泰
//   </商城>
//
// 校验口径（逐条对齐规格 §4.4）：
//   · 名 非空（≤40 字）；缺名条目丢弃；
//   · 价 有限数 >0 ≤1e9，按币种 precision 取整；
//   · 币 **必须命中当前币种列表**（trim+忽略大小写）；未命中 → 丢弃该商品并计数
//     （绝不错配成别的币种——价格的世界观尺度不同，换币等于凭空造钱）；
//   · 述 ≤60 字截断；送 整数 1~99 钳制（缺省 3；提示词已放开为「按故事背景自由设定」，这里只防离谱值）；
//     铺/类 截断；图 清洗（非法回落 🎁）；
//   · 评 条数上限 6（提示词不设条数、自由发挥）、评语 ≤100 字，`昵称|内容` 拆分
//     （无 | 时整行作内容、昵称留空，渲染层补「匿名买家」）。
// 容错：取**最后一个**标签块（全机统一口径）；标签没闭合（截断）时把最后一个开标签之后当整块解析。
// 失败口径：无块 / 0 件有效商品 = null（调用方如实报错，不静默）。

import { shopBlockRegex, SHOP_TAGS } from './protocol-tags';
import {
  clampAmount, makeShopItemId, normalizeGlyph, normalizePrice,
  SHOP_MAX_DELIVERY_DAYS, SHOP_MAX_REVIEWS, SHOP_MAX_REVIEW_TEXT,
  type ShopItem, type ShopReview,
} from './shop-model';

/** 解析所需的币种快照（名 + 精度；调用方从货币联动桥现取）。 */
export interface ShopCurrencyOption {
  name: string;
  precision: 0 | 2;
}

export interface ShopParseOptions {
  /** 当前可用币种（商品币种必须命中；空数组 = 只认「无币种降级」占位名，见 placeholderCurrency）。 */
  currencies: readonly ShopCurrencyOption[];
  /** 无货币联动时的占位币种名（商品按它定价、可逛不可买）；缺省「元」。 */
  placeholderCurrency?: string;
}

export interface ShopParseResult {
  items: ShopItem[];
  /** 因币种未命中/格式无效被丢弃的条目数（页内提示用）。 */
  dropped: number;
}

const FIELD_ALIASES = {
  name: ['名', '名称', '商品名'],
  price: ['价', '价格', '售价'],
  currency: ['币', '币种', '货币'],
  desc: ['述', '描述', '简介'],
  delivery: ['送', '送达', '送货', '送货时间'],
  seller: ['铺', '店铺', '卖家', '字号'],
  glyph: ['图', '图符', '图标'],
  category: ['类', '分类', '品类'],
  review: ['评', '评价', '买家评价'],
} as const;

const MAX_NAME = 40;
const MAX_DESC = 60;
const MAX_SELLER = 30;
const MAX_CATEGORY = 12;

/** 「名：值」行解析（全角/半角冒号；返回 null = 不是字段行）。 */
function fieldOf(line: string): { key: string; value: string } | null {
  const m = /^[-*\s]*([^\s:：]{1,4})\s*[:：]\s*(.*)$/.exec(line);
  if (!m) return null;
  return { key: m[1].trim(), value: m[2].trim() };
}

function matchField(key: string, names: readonly string[]): boolean {
  return names.includes(key);
}

/** 币种解析（trim + 忽略大小写全等）；未命中返回 null。 */
function resolveCurrency(
  name: string,
  currencies: readonly ShopCurrencyOption[],
  placeholder: string,
): ShopCurrencyOption | null {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const hit = currencies.find(c => c.name.toLowerCase() === key);
  if (hit) return hit;
  // 无货币联动：只认占位币种名（AI 被要求按它定价）
  if (!currencies.length && placeholder && placeholder.toLowerCase() === key) {
    return { name: placeholder, precision: 0 };
  }
  return null;
}

/** 单条商品（收集中间态）。 */
interface Draft {
  name: string;
  price: string;
  currency: string;
  desc: string;
  delivery: string;
  seller: string;
  glyph: string;
  category: string;
  reviews: ShopReview[];
}

function emptyDraft(): Draft {
  return { name: '', price: '', currency: '', desc: '', delivery: '', seller: '', glyph: '', category: '', reviews: [] };
}

function parseReview(raw: string): ShopReview | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const idx = text.indexOf('|');
  if (idx < 0) return { name: '', text: text.slice(0, SHOP_MAX_REVIEW_TEXT) };
  return { name: text.slice(0, idx).trim().slice(0, 24), text: text.slice(idx + 1).trim().slice(0, SHOP_MAX_REVIEW_TEXT) };
}

function draftToItem(draft: Draft, opts: ShopParseOptions): ShopItem | null {
  const name = draft.name.trim().slice(0, MAX_NAME);
  if (!name) return null;
  const meta = resolveCurrency(draft.currency, opts.currencies, opts.placeholderCurrency || '元');
  if (!meta) return null;
  const price = normalizePrice(draft.price.replace(/[¥$€,，\s]/g, ''));
  if (price <= 0) return null;
  const days = Math.floor(Number(String(draft.delivery).replace(/[^\d.-]/g, '')));
  return {
    id: makeShopItemId(),
    name,
    price: clampAmount(price, meta.precision),
    currencyName: meta.name,
    desc: draft.desc.trim().slice(0, MAX_DESC),
    deliveryDays: Number.isFinite(days) ? Math.max(1, Math.min(SHOP_MAX_DELIVERY_DAYS, days)) : 3,
    seller: draft.seller.trim().slice(0, MAX_SELLER),
    glyph: normalizeGlyph(draft.glyph),
    category: draft.category.trim().slice(0, MAX_CATEGORY),
    reviews: draft.reviews.slice(0, SHOP_MAX_REVIEWS),
    addedAt: '',
  };
}

/**
 * 从**行式字段表**构造商品（docs/54：商家会话里的 `[新商品]名：…｜价：…｜币：…` 行走这条路）。
 * 校验口径与 `[商城]` 块**完全一致**（同一 draftToItem：名 ≤40 / 价 >0 ≤1e9 / 币必须命中 /
 * 送 1~15 缺省 3 / 图清洗 / 类 ≤12 / 评 ≤3），确保"商家甩的新货"与"AI 上货"同质。
 * `sellerOverride` = 会话店铺名（用户口径：商铺无需再重复生成，AI 写的铺名一律忽略）。
 */
export function buildShopItemFromFields(
  fields: Readonly<Record<string, string>>,
  reviewLines: readonly string[],
  opts: ShopParseOptions & { sellerOverride?: string },
): ShopItem | null {
  const pick = (...names: readonly string[]): string => {
    for (const n of names) {
      const v = fields[n];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  };
  const reviews = reviewLines
    .map(parseReview)
    .filter((r): r is ShopReview => r !== null)
    .slice(0, SHOP_MAX_REVIEWS);
  const draft: Draft = {
    name: pick(...FIELD_ALIASES.name),
    price: pick(...FIELD_ALIASES.price),
    currency: pick(...FIELD_ALIASES.currency),
    desc: pick(...FIELD_ALIASES.desc),
    delivery: pick(...FIELD_ALIASES.delivery),
    seller: opts.sellerOverride || pick(...FIELD_ALIASES.seller),
    glyph: pick(...FIELD_ALIASES.glyph),
    category: pick(...FIELD_ALIASES.category),
    reviews,
  };
  return draftToItem(draft, opts);
}

/** 从文本里取**最后一个**商城标签块并解析。无块/0 件有效商品 → null。 */
export function parseShopReply(text: string, opts: ShopParseOptions): ShopParseResult | null {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const re = shopBlockRegex();
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) last = m[1];
  if (last !== null) {
    const parsed = parseShopBlock(last, opts);
    if (parsed) return parsed;
  }
  // 截断容错：标签没闭合（最后一个开标签之后就是全部内容）——最后这一段当整块解析
  const openAlt = SHOP_TAGS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const tail = new RegExp(`<(?:${openAlt})>`, 'gi');
  let openAt = -1;
  while ((m = tail.exec(raw)) !== null) openAt = m.index;
  if (openAt >= 0) return parseShopBlock(raw.slice(openAt), opts);
  return null;
}

/** 解析块内容（已去标签）。导出供单测直调。 */
export function parseShopBlock(block: string, opts: ShopParseOptions): ShopParseResult | null {
  const lines = String(block || '').replace(/\r\n?/g, '\n').split('\n');
  const items: ShopItem[] = [];
  let current: Draft | null = null;
  let dropped = 0;

  const flush = (): void => {
    if (!current) return;
    const item = draftToItem(current, opts);
    if (item) items.push(item);
    else dropped += 1;
    current = null;
  };

  for (const rawLine of lines) {
    const t = rawLine.replace(/\s+$/, '').trim();
    if (!t) continue;
    const f = fieldOf(t);
    if (!f) continue; // 商城块里没有正文段落；非字段行一律忽略
    if (matchField(f.key, FIELD_ALIASES.name)) {
      flush();
      current = emptyDraft();
      current.name = f.value;
      continue;
    }
    if (!current) continue;
    if (// 价 / 币 / 述 / 送 / 铺 / 图 / 类 各一行
      matchField(f.key, FIELD_ALIASES.price)) { current.price = f.value; continue; }
    if (matchField(f.key, FIELD_ALIASES.currency)) { current.currency = f.value; continue; }
    if (matchField(f.key, FIELD_ALIASES.desc)) { current.desc = f.value; continue; }
    if (matchField(f.key, FIELD_ALIASES.delivery)) { current.delivery = f.value; continue; }
    if (matchField(f.key, FIELD_ALIASES.seller)) { current.seller = f.value; continue; }
    if (matchField(f.key, FIELD_ALIASES.glyph)) { current.glyph = f.value; continue; }
    if (matchField(f.key, FIELD_ALIASES.category)) { current.category = f.value; continue; }
    if (matchField(f.key, FIELD_ALIASES.review)) {
      const rv = parseReview(f.value);
      if (rv && current.reviews.length < SHOP_MAX_REVIEWS) current.reviews.push(rv);
      continue;
    }
  }
  flush();

  if (!items.length) return null;
  return { items, dropped };
}
