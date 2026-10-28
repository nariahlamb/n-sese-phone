// ===== 网上商城 · 引擎（docs/52 §4/§6/§7）=====
// 三段式刷新（镜像 browser-engine）：
//   ① 绿灯触发注入 ubp_shop_trigger（position:'none' + should_scan）——点了刷新才注入（零常驻）
//   ② 资料块 ubp_shop_dossier（after_system）——时间地点 + **货币体系（名/描述/精度；不注入余额）** +
//      剧情纪要（最新 N 条，不筛主角名）+ 主角档案 + 最近正文 + 现有货架名（防重名）+ 现有类别
//   ③ runPhoneRaw（全槽位 + max_chat_history 0 + generation_id 可中止）
// 购买/取消/送达结算也收在本模块（编排：扣款 → 建单 → 写备忘 → 通知；幂等与闸门在各自函数内）。
//
// 账目纪律（铁律）：
//   · 一切扣款/退款经宿主桥回到主扩展单一账本（source='shop'，与转账/红包同一本账，绝不双计）；
//   · 币种**严格解析**：商品币种名必须命中当前币种列表——miss 一律拒绝（绝不回落常用币错配价格）；
//   · 余额校验在 UI 收紧（同手机转账/红包口径）：不足即拦，不产生欠款订单。
// 聊天归属：结算/送达结算都只动**当前聊天**的存储（读 store 引用、写 mutatePhoneData）。

import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { emitAch } from './phone-achievements';
import { readLatestChronicleDossierBlocks } from '../../unified-statusbar/core/chronicle-blocks';
import { PhoneChatError, readAiChatHistory } from './chat-engine';
import { getTavernHelper, makeGenerationId, stopGenerationById } from './host-env';
import { keepSpyAndPublicEntries } from './message-worldbook';
import { mergeOneShotHint } from './extra-hint';
import { readPhoneDataRef, mutatePhoneData } from './phone-store';
import { getPhoneSettings } from './phone-settings';
import { validatePhoneApi } from './phone-api';
import { runPhoneRaw } from './phone-raw';
import { getRoster } from './roster';
import { addDays, invalidatePhoneScheduleCache, storyDateOf } from './phone-schedule';
import {
  buildShopDossierText, buildShopInstruction, buildShopTriggerText,
  shopExistingCategories, shopExistingNames, shopSpec,
} from './shop-prompts';
import { parseShopReply } from './shop-parser';
import { insertPhoneMemo, updatePhoneMemoStatus, type MemoDraft } from './phone-memo';
// 商家消息（docs/54）：下单/送达/取消三处推自动消息；下单备忘与订单快照带上收货信息
import { pushShopAutoMessage, shopAutoShipLine } from './shop-chat-engine';
import { defaultShopAddress } from './shop-chat-model';
import { fallbackShopSeller } from './shop-prompts';
import { insertPhoneItem, shopStockTag } from './phone-inventory';
import {
  addOrder, cartAdd, clampAmount, emptyShopData, mergeShopCatalog, shopOrdersDue,
  updateOrder, type ShopCartLine, type ShopData, type ShopItem, type ShopOrder,
} from './shop-model';
import {
  isCurrencyLinkActive, payAdjustResult, payBalance, payCommon, payCurrencyList,
} from './currency-link';
import type { CurrencyMeta } from './currency-link';
import type { RosterSnapshot } from './roster';
import { emitPhoneNotify } from '../renderers/app-registry';
import { s } from './skins';
import type { PhoneStyle } from './chat-model';

// ─── 结算收货地址（docs/54 §10.4） ───

/** 本次结算选定的地址 id（UI 在结算弹层里选；空 = 用默认地址）。 */
let _checkoutAddressId = '';

/** 设置本次结算的收货地址（结算弹层「更换」/打开结算时调用；空串 = 用默认地址）。 */
export function setCheckoutAddressId(id: string): void {
  _checkoutAddressId = String(id || '');
}

/**
 * 取本次结算要用的收货地址：
 * ① 结算弹层选定的那条 → ② 默认地址 → ③ **最近一次订单的收货快照**（地址簿空但买过 → 回填） → ④ null。
 */
export function selectedShopAddress(): { name: string; detail: string; id: string } | null {
  const data = readPhoneDataRef().shop || emptyShopData();
  const picked = (data.addresses || []).find(a => a.id === _checkoutAddressId);
  if (picked) return { name: picked.name, detail: picked.detail, id: picked.id };
  const fallback = defaultShopAddress(data.addresses, data.defaultAddressId || '');
  if (fallback) return { name: fallback.name, detail: fallback.detail, id: fallback.id };
  const lastOrder = (data.orders || []).find(o => o.shipTo && (o.shipTo.name || o.shipTo.detail));
  if (lastOrder?.shipTo) return { name: lastOrder.shipTo.name, detail: lastOrder.shipTo.detail, id: '' };
  return null;
}

// ─── 货币：严格解析（miss 不回落） ───

/** 严格解析商品币种（trim + 忽略大小写全等）；miss 返回 null——**绝不回落常用币**（防价格错配）。 */
export function resolveShopCurrency(currencyName: string): CurrencyMeta | null {
  const key = String(currencyName || '').trim().toLowerCase();
  if (!key) return null;
  return payCurrencyList().find(c => c.name.toLowerCase() === key) || null;
}

// ─── ① 刷新货架 ───

export interface ShopRefreshResult {
  items: ShopItem[];
  /** 因重名/币种未命中被丢弃的条数（页内提示用）。 */
  dropped: number;
  style: string;
}

/** 进行中的商城生成 id（中止用；与聊天/浏览器生成独立计数）。 */
const _activeGenerations = new Set<string>();

/** 终止当前商城生成。返回是否有请求被终止。 */
export function abortShopGeneration(): boolean {
  let stopped = false;
  for (const id of _activeGenerations) {
    if (stopGenerationById(id)) stopped = true;
  }
  _activeGenerations.clear();
  return stopped;
}

/** 生成一批新货（AI 按世界观上货；结果由调用方经 applyShopRefresh 合并入库）。 */
export async function refreshShopCatalog(args: {
  rosterOverride?: RosterSnapshot;
  extraPrompt?: string;
} = {}): Promise<ShopRefreshResult> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  const apiError = validatePhoneApi('chat');
  if (apiError) throw new PhoneChatError('api', apiError);

  const settings = getPhoneSettings();
  const roster = args.rosterOverride ?? getRoster();
  const data = readPhoneDataRef(); // O43：AI 请求装配只读整机数据（原整机深拷贝纯浪费）
  const style = data.style || '';
  const spec = shopSpec(style);
  // 取量直传设置值（0=不带），与其他请求口径一致（用户定夺）；纪要=最新 N 条、不筛主角名
  const chronicleBlocks = readLatestChronicleDossierBlocks(settings.summaryCount);
  const storyText = stripWithContextConfig(readAiChatHistory(settings.chatHistoryCount));
  const mergedExtra = mergeOneShotHint(String(settings.extraPrompt || ''), args.extraPrompt);

  // 货币资料块（币种名 + 币种描述 + 精度；用户定案不注入余额）；无联动 → 占位币种
  const active = isCurrencyLinkActive();
  const currencies = active
    ? payCurrencyList().map(c => ({ name: c.name, desc: c.desc, precision: c.precision }))
    : [];
  const commonName = active ? (payCommon()?.name || '') : '';
  const catalog = data.shop?.catalog || [];
  const existing = shopExistingNames(catalog);
  const existingCats = shopExistingCategories(catalog);

  const prepare = async (): Promise<void> => {
    await th.injectPrompts([{
      id: 'ubp_shop_trigger',
      position: 'none',
      depth: 0,
      role: 'system',
      content: buildShopTriggerText({ roster, style, extraHint: mergedExtra }),
      should_scan: true,
    }], { once: true });
    await th.injectPrompts([{
      id: 'ubp_shop_dossier',
      position: 'after_system',
      depth: 0,
      role: 'system',
      content: buildShopDossierText({
        roster, style, chronicleBlocks, storyText, currencies, commonName,
        existingNames: existing, existingCategories: existingCats,
      }),
      should_scan: false,
    }], { once: true });
  };

  const instructionText = buildShopInstruction({
    roster,
    style,
    batchSize: Number(settings.shopBatchSize) || 8,
    extraPrompt: mergedExtra,
  });
  const instruction = th.substitudeMacros ? th.substitudeMacros(instructionText) : instructionText;
  const generationId = makeGenerationId('ubp-shop');
  _activeGenerations.add(generationId);
  let raw = '';
  try {
    raw = await runPhoneRaw({
      scope: 'chat',
      instruction,
      generationId,
      keep: keepSpyAndPublicEntries,
      prepare,
      activity: {
        feature: '商场上货',
        label: '商场上货',
        appId: 'shop',
        tone: 'shop',
        onCancel: () => { abortShopGeneration(); },
      },
    });
  } finally {
    _activeGenerations.delete(generationId);
  }

  const parsed = parseShopReply(String(raw), {
    currencies: currencies.map(c => ({ name: c.name, precision: c.precision })),
    placeholderCurrency: spec.currencyPlaceholder,
  });
  if (!parsed || !parsed.items.length) {
    throw new PhoneChatError('parse', 'AI 没有按格式给出商品：请重试，或换个时间再上货');
  }
  return { items: parsed.items, dropped: parsed.dropped, style };
}

/**
 * 合并一批新货（纯函数；调用方在 mutatePhoneData 内调用）：
 * 打上架时间戳 → 追加去重 → 超上限淘汰最旧的旧货 → 记 lastRefreshAt（**仅真有新货上架时**——
 * 整批重名被跳过却记「今日上新」会让横幅与实际不符）。
 */
export function applyShopRefresh(
  data: ShopData,
  items: readonly ShopItem[],
  maxItems: number,
  storyDate: string,
): { data: ShopData; added: ShopItem[]; evicted: ShopItem[]; skipped: number } {
  const stamped = items.map(it => (it.addedAt ? it : { ...it, addedAt: storyDate }));
  const merged = mergeShopCatalog(data, stamped, maxItems);
  return {
    ...merged,
    data: {
      ...merged.data,
      ...(storyDate && merged.added.length ? { lastRefreshAt: storyDate } : {}),
    },
  };
}

// ─── ② 结算购买 ───

export interface ShopCheckoutTotals {
  currencyName: string;
  meta: CurrencyMeta | null;
  amount: number;
  balance: number;
  enough: boolean;
}

/** 结算预览（逐币种小计 / 余额 / 是否足额）。币种缺失时 meta=null、enough=false。 */
export function shopCheckoutTotals(lines: readonly ShopCartLine[]): ShopCheckoutTotals[] {
  const byCurrency = new Map<string, { meta: CurrencyMeta | null; amount: number }>();
  for (const line of lines) {
    const meta = resolveShopCurrency(line.item.currencyName);
    const amount = clampAmount(line.item.price * Math.max(1, line.qty), meta?.precision ?? 0);
    const key = meta?.name || line.item.currencyName;
    const cur = byCurrency.get(key) || { meta, amount: 0 };
    cur.amount = clampAmount(cur.amount + amount, meta?.precision ?? 0);
    if (meta) cur.meta = meta;
    byCurrency.set(key, cur);
  }
  const out: ShopCheckoutTotals[] = [];
  for (const [currencyName, entry] of byCurrency) {
    const balance = entry.meta ? payBalance(entry.meta) : 0;
    out.push({
      currencyName,
      meta: entry.meta,
      amount: entry.amount,
      balance,
      enough: !!entry.meta && balance >= entry.amount,
    });
  }
  return out;
}

export interface ShopCheckoutFailure {
  item: ShopItem;
  error: string;
}

export interface ShopCheckoutOutcome {
  /** 全部行都成功下单 = true。 */
  ok: boolean;
  orders: ShopOrder[];
  failures: ShopCheckoutFailure[];
  /** 备忘写入失败的行数（购买仍成立，提示用）。 */
  memoFailures: number;
}

/** 购买闸门（防双击双扣；跨 await 的整段受 finally 保护，照主项目 _regularShopBusy 先例）。 */
let _checkoutBusy = false;

export function shopCheckoutBusy(): boolean {
  return _checkoutBusy;
}

/** 逐行下单：扣款 → 建单落库 → 写备忘录（各自独立送货日期）。已成功的行从购物车移除。 */
export async function checkoutShopLines(lines: readonly ShopCartLine[]): Promise<ShopCheckoutOutcome> {
  const outcome: ShopCheckoutOutcome = { ok: false, orders: [], failures: [], memoFailures: 0 };
  if (_checkoutBusy) {
    outcome.failures.push({ item: lines[0]?.item as ShopItem, error: '正在处理上一笔订单，请稍候' });
    return outcome;
  }
  if (!isCurrencyLinkActive()) {
    outcome.failures.push({ item: lines[0]?.item as ShopItem, error: '未启用货币系统，无法支付（请到主项目开启）' });
    return outcome;
  }
  const roster = getRoster();
  const storyTime = roster.global.time || '';
  const today = storyDateOf(storyTime);
  const style = styleOfCurrent();
  // 收货信息（docs/54 §10.4）：结算弹层选定的地址（缺省=默认地址）；空 = 未填（不阻断下单）
  const address = selectedShopAddress();
  const shipTo = address ? { name: address.name, detail: address.detail } : undefined;
  const shipLine = shopAutoShipLine(address || null);
  _checkoutBusy = true;
  try {
    for (const line of lines) {
      const item = line.item;
      const qty = Math.max(1, Math.floor(line.qty) || 1);
      const meta = resolveShopCurrency(item.currencyName);
      if (!meta) {
        outcome.failures.push({ item, error: `币种「${item.currencyName}」不在当前货币体系中` });
        continue;
      }
      const amount = clampAmount(item.price * qty, meta.precision);
      if (payBalance(meta) < amount) {
        outcome.failures.push({ item, error: `${meta.name}余额不足（还差 ${clampAmount(amount - payBalance(meta), meta.precision)}）` });
        continue;
      }
      // ① 扣款（桥失败即中止该行——绝不建「钱没扣却已下单」的悬空订单）
      const paid = payAdjustResult(meta, -amount, 'shop', `商城购买 · ${item.name}`);
      if (!paid) {
        outcome.failures.push({ item, error: '扣款失败（货币桥不可用），请稍后重试' });
        continue;
      }
      // ② 建单（快照冻结；送达日 = 下单故事日 + 送货天数）
      const order: ShopOrder = {
        id: `sho_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        item: { ...item },
        qty,
        amount,
        currencyName: meta.name,
        status: 'transit',
        orderedAt: storyTime,
        arriveDate: today ? addDays(today, item.deliveryDays) : '',
        memoTitle: '',
        ...(shipTo ? { shipTo } : {}),
      };
      mutatePhoneData(d => {
        const base = d.shop || emptyShopData();
        const withOrder = addOrder(base, order);
        // 已下单的行从购物车移除（与建单同一次写，避免「下单了还在车里」）
        d.shop = { ...withOrder, cart: withOrder.cart.filter(l => l.item.id !== item.id) };
      });
      outcome.orders.push(order);
      // ③ 写备忘录（失败不改购买成立性，只记账并提示；详细内容带收货人/地址）
      const memo = await writeShopMemo(order, style, address || null);
      if (!memo.ok) outcome.memoFailures += 1;
      else {
        mutatePhoneData(d => {
          const base = d.shop || emptyShopData();
          d.shop = updateOrder(base, order.id, { memoTitle: memo.title });
        });
        order.memoTitle = memo.title;
        invalidatePhoneScheduleCache(); // 送达日提醒立刻可被 M7 日程机制读到
      }
      // ④ 商家自动消息（零 AI：下单确认；带收货人+地址，缺了就提醒补填）
      pushShopAutoMessage({
        seller: item.seller || fallbackShopSeller(style),
        kind: 'ordered',
        ship: shipLine,
        arriveLabel: shopArriveLabel(order.arriveDate),
      });
    }
    outcome.ok = outcome.failures.length === 0 && outcome.orders.length > 0;
    return outcome;
  } finally {
    _checkoutBusy = false;
  }
}

function styleOfCurrent(): string {
  try { return readPhoneDataRef().style || ''; } catch (_e) { return ''; }
}

/** 备忘标题前缀（风格换装；UNIQUE 冲突时 insertPhoneMemo 自动加后缀）。 */
export function shopMemoTitle(item: ShopItem, style: string): string {
  return `${shopSpec(style).appName}-${item.name}`;
}

/** 送达日 → 「M月D日」（备忘文案用；不可解析回落原文）。 */
export function shopArriveLabel(arriveDate: string): string {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(String(arriveDate || '').trim());
  if (!m) return String(arriveDate || '').trim();
  return `${Number(m[2])}月${Number(m[3])}日`;
}

/** 下单写备忘录（复用微信备忘同一通道；文案逐字对齐用户模板；docs/54：详细内容追加收货人/地址）。 */
export async function writeShopMemo(
  order: ShopOrder,
  style: string,
  address?: { name: string; detail: string } | null,
): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const item = order.item;
  const qtyText = order.qty > 1 ? `×${order.qty}` : '';
  const arriveText = shopArriveLabel(order.arriveDate);
  const shipText = address && (address.name || address.detail)
    ? `；收货人：${address.name || '—'}；收货地址：${address.detail || '—'}`
    : '；未填写收货信息';
  const draft: MemoDraft = {
    title: shopMemoTitle(item, style),
    memoType: '待办',
    relatedCharacters: '',
    detail: `${s(style as PhoneStyle, '在网上商城', '在万宝阁', '在悦来商行', '在奇物商栈')}购买了${item.name}${qtyText}（${item.desc || '—'}），预计${arriveText}会送到${shipText}`,
    recordDate: storyDateOf(order.orderedAt),
    appointedDate: order.arriveDate,
  };
  const result = await insertPhoneMemo(draft);
  return result.ok ? { ok: true, title: result.title } : { ok: false, error: result.error };
}

// ─── ③ 取消订单与退款 ───

export interface ShopCancelOutcome {
  ok: boolean;
  error?: string;
}

/** 取消订单：原路退款（source='phone-in'）→ 状态置 cancelled → 备忘录标记（留痕，不删除）。 */
export async function cancelShopOrder(orderId: string): Promise<ShopCancelOutcome> {
  const data = readPhoneDataRef();
  const order = (data.shop?.orders || []).find(o => o.id === orderId);
  if (!order) return { ok: false, error: '订单不存在' };
  if (order.status !== 'transit') return { ok: false, error: order.status === 'delivered' ? '货已送到，无法取消' : '订单已取消' };
  const meta = resolveShopCurrency(order.currencyName);
  if (!meta) return { ok: false, error: `币种「${order.currencyName}」不在当前货币体系中，无法退款` };
  const refunded = payAdjustResult(meta, order.amount, 'phone-in', `商城退款 · ${order.item.name}`);
  if (!refunded) return { ok: false, error: '退款失败（货币桥不可用），请稍后重试' };
  const storyTime = getRoster().global.time || '';
  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    d.shop = updateOrder(base, orderId, { status: 'cancelled', cancelledAt: storyTime });
  });
  if (order.memoTitle) {
    try {
      await updatePhoneMemoStatus(order.memoTitle, '已取消', '订单已取消，款项已退回');
      invalidatePhoneScheduleCache();
    } catch (_e) { /* 备忘标记失败不阻断取消（钱已退、状态已改） */ }
  }
  // 商家自动消息（零 AI）：取消回执
  pushShopAutoMessage({
    seller: order.item.seller || fallbackShopSeller(styleOfCurrent()),
    kind: 'cancelled',
  });
  return { ok: true };
}

// ─── ④ 送达结算（入库 + 备忘录标记完成 + 通知） ───

export interface ShopSettleOutcome {
  settled: number;
  /** 物品表入库失败、留待下次重试的订单数。 */
  stockPending: number;
}

let _settling = false;

/**
 * 送达结算（幂等；无轮询——由开机 / 打开商城 / 故事时间推进 / 切聊天重绑触发）：
 * ① 物品表入库（失败则订单保持在途，下次重试）→ ② 备忘录「已完成」→ ③ 通知 + 未读角标。
 */
export async function settleShopOrders(rosterOverride?: RosterSnapshot): Promise<ShopSettleOutcome> {
  const out: ShopSettleOutcome = { settled: 0, stockPending: 0 };
  if (_settling) return out;
  const roster = rosterOverride ?? getRoster();
  const today = storyDateOf(roster.global.time || '');
  if (!today) return out; // 故事时间不可解析：不结算（绝不拿真实时钟冒充）
  const data = readPhoneDataRef();
  const due = shopOrdersDue(data.shop?.orders || [], today);
  if (!due.length) return out;
  _settling = true;
  try {
    const style = styleOfCurrent();
    for (const order of due) {
      // ① 入库（先写外部库；失败则整单不结算，下次触发重试）
      const stocked = await insertPhoneItem({
        name: order.item.name,
        type: order.item.category || '道具',
        quantity: order.qty,
        desc: `${order.item.desc} ${shopStockTag(style)}`.trim(),
      });
      if (!stocked.ok) {
        out.stockPending += 1;
        continue;
      }
      // ② 备忘录标记完成（失败不阻断结算——备忘可能已被用户手删）
      if (order.memoTitle) {
        try {
          await updatePhoneMemoStatus(order.memoTitle, '已完成', `已于 ${shopArriveLabel(today)} 送达`);
          invalidatePhoneScheduleCache();
        } catch (_e) { /* 单条失败不阻断其余 */ }
      }
      // ③ 状态翻转 + 通知
      mutatePhoneData(d => {
        const base = d.shop || emptyShopData();
        d.shop = updateOrder(base, order.id, { status: 'delivered', seen: false, stocked: true, deliveredAt: today });
      });
      out.settled += 1;
      emitPhoneNotify({
        appId: 'shop',
        title: s(style as PhoneStyle, '包裹已送达', '货已送到', '货已送到', '货箱已送达'),
        text: `「${order.item.name}」已送到，记得查收`,
      });
      // 商家自动消息（零 AI）：到货一句招呼（不弹横幅——上面那条通知已经弹过）
      pushShopAutoMessage({
        seller: order.item.seller || fallbackShopSeller(style),
        kind: 'delivered',
      });
    }
    if (out.settled) {
      invalidatePhoneScheduleCache();
      emitAch('phone_shop_order_delivered', { count: out.settled }); // L21：结算只由玩家开商城/推进时间触发（玩家可感知的送达）
    }
    return out;
  } finally {
    _settling = false;
  }
}

/** 送达结算的触发口（App/开机/roster 失效共用；内部幂等 + 无在途订单时零开销）。 */
export function requestShopSettle(): void {
  void settleShopOrders().catch(() => undefined);
}

/** 「再次购买」：订单快照放回购物车（价格以快照为准；币种失效由结算侧拦）。 */
export function reorderShopOrder(orderId: string): boolean {
  const data = readPhoneDataRef();
  const order = (data.shop?.orders || []).find(o => o.id === orderId);
  if (!order) return false;
  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    d.shop = cartAdd(base, order.item, order.qty);
  });
  return true;
}
