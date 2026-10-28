// ===== 商城消息（商家沟通）· 引擎（docs/54 §3/§4/§5/§8/§11）=====
// 三段式生成（镜像 chat-engine 私聊，资料块换血）：① 触发注入 → ② 资料块 → ③ runPhoneRaw 全槽位。
// 结果落库（applyShopChatReply）逐类带副作用：
//   · 文字 → 直接上屏；
//   · 图片 → 上屏为 pending，走既有两步法生图（纯景物；入相册 source='shop'，见 renderers/shop-chat）；
//   · 改价 → **真的改商城里的价**（货架∪收藏∪购物车同步，订单不动），卡片标「已同步/已不在货架上」；
//   · 新商品 → **真的上架**（铺名强制=本会话店铺；走 mergeShopCatalog 的同名去重与上限淘汰）；
//   · 红包 → 商家发的挂「開」（点开才入账，走 rp-open 同一本账）；再叠**返现额度闸**（同商品一次 + 会话 ≤5）。
// 另收：我方发红包（扣款 source='shop'）、我方文字/图片上屏、商家自动消息（零 AI：下单/送达/取消）、红包领取。
// 聊天归属：生成结果只写**发起时那一个聊天**（调用方在落库前比 currentPhoneStorageId 快照，切聊天整批丢弃）。

import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { readChronicleDossierBlocks } from '../../unified-statusbar/core/chronicle-blocks';
import { PhoneChatError, readAiChatHistory } from './chat-engine';
import { getTavernHelper, makeGenerationId, stopGenerationById } from './host-env';
import { keepSpyAndPublicEntries } from './message-worldbook';
import { mergeOneShotHint } from './extra-hint';
import { mutatePhoneData, readPhoneDataRef } from './phone-store';
import { getPhoneSettings } from './phone-settings';
import { validatePhoneApi } from './phone-api';
import { runPhoneRaw } from './phone-raw';
import { getRoster, type RosterSnapshot } from './roster';
import { storyDateOf } from './phone-schedule';
import { s } from './skins';
import type { PhoneStyle } from './chat-model';
import { emitPhoneEvent } from '../renderers/app-registry';
import {
  appendShopMessage, applyShopPriceChange, buildShopRedPacketMessage, buildShopTextMessage,
  canShopRebate, defaultShopAddress, ensureShopThread, listShopItemsForSeller, markShopRebate,
  shopItemStatus, shopItemStatusLabel, SHOP_CHAT_CONTEXT_LINES, type ShopMessage, type ShopThread,
} from './shop-chat-model';
import {
  buildShopChatDossierText, buildShopChatInstruction, buildShopChatTriggerText, formatShopTranscript,
  pickShopAutoMessage, SHOP_AUTO_MESSAGES, type ShopChatItemLine, type ShopChatReviewLine,
} from './shop-chat-prompts';
import { parseShopReply, type ParsedShopMessage, type ShopParseQuotaInfo } from './shop-chat-parser';
import { emptyShopData, makeShopItemId, mergeShopCatalog, type ShopData, type ShopItem } from './shop-model';
import { buildShopItemFromFields } from './shop-parser';
import { shopSpec } from './shop-prompts';
import {
  isCurrencyLinkActive, payAdjustResult, payBalance, payCommon, payCurrencyList,
} from './currency-link';

// ─── 归属守卫 / 生成闸 ───

/** 进行中的生成 id（按会话隔离，照微信 _activeGenerations）。 */
const _activeGenerations = new Map<string, Set<string>>();
/** 单会话生成闸（同一家店同时只允许一发在途）。 */
const _generating = new Set<string>();

export function shopChatGenerating(threadId: string): boolean {
  return _generating.has(threadId);
}

/** 终止：传会话 id 只终止该会话，省略则全部。返回是否有请求被终止。 */
export function abortShopChatGeneration(threadId?: string): boolean {
  let stopped = false;
  const ids = threadId ? [threadId] : [..._activeGenerations.keys()];
  for (const id of ids) {
    const set = _activeGenerations.get(id);
    if (!set) continue;
    for (const gid of set) {
      if (stopGenerationById(gid)) stopped = true;
    }
    set.clear();
    _activeGenerations.delete(id);
  }
  return stopped;
}

// ─── 上下文素材 ───

/** 我方本批：尾部连续 me 消息（不含 system；商聊里"上屏≠触发"，点生成条才发请求）。 */
export function shopTrailingUserBatch(messages: readonly ShopMessage[]): ShopMessage[] {
  const batch: ShopMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) break;
    if (m.from === 'system') continue;
    if (m.from !== 'me') break;
    batch.unshift(m);
  }
  return batch;
}

/** 我方批次 → 指令里的「我方刚刚发送」多行文本（我方不发富媒体，恒为文本/图片描述）。 */
export function composeShopUserText(messages: readonly ShopMessage[]): string {
  return messages
    .filter(m => m.from === 'me')
    .map(m => {
      const body = m.type === 'image' ? `[图片]${m.content}` : m.content;
      // 引用前缀（AI 视角；`@` 转全角同微信口径，避免被当提醒）
      const prefix = m.quote
        ? `（引用 ${m.quote.from === 'me' ? '我' : m.quote.from}：${String(m.quote.content || '').replace(/@/g, '＠')}）`
        : '';
      return `${prefix}${body}`;
    })
    .filter(l => Boolean(l.trim()))
    .join('\n');
}

/** 会话内最近几条消息 → 生图参考上下文（商家图只带本会话上下文，不带微信/正文）。 */
export function buildShopChatContext(messages: readonly ShopMessage[], limit = 8): string {
  return formatShopTranscript(messages, limit).join('\n');
}

// ─── 资料块取材（纯函数，可直测） ───

export function shopChatItemLines(data: ShopData, seller: string): ShopChatItemLine[] {
  return listShopItemsForSeller(data, seller).map(item => ({
    name: item.name,
    price: item.price,
    currencyName: item.currencyName,
    category: item.category,
    status: shopItemStatusLabel(shopItemStatus(data, item.name)),
  }));
}

export function shopChatMyReviewLines(data: ShopData, seller: string): ShopChatReviewLine[] {
  const names = new Set(listShopItemsForSeller(data, seller).map(it => it.name));
  return (data.myReviews || [])
    .filter(rv => names.has(rv.itemName))
    .slice(0, 10)
    .map(rv => ({
      itemName: rv.itemName,
      rating: rv.rating,
      text: rv.text,
      images: rv.images.length,
      createdAt: rv.createdAt,
    }));
}

export function shopChatBuyerReviewLines(data: ShopData, seller: string): string[] {
  const out: string[] = [];
  for (const item of listShopItemsForSeller(data, seller)) {
    for (const rv of item.reviews || []) {
      out.push(`${item.name}｜买家「${rv.name || '匿名买家'}」｜${rv.text}`);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

export function shopChatRebateLines(thread: ShopThread): string[] {
  return (thread.rebates || []).map(r => `${r.itemName}：已于 ${r.at || '先前'} 返现`);
}

// ─── ① 生成 ───

export interface ShopChatGenerateResult {
  messages: ParsedShopMessage[];
  quota: ShopParseQuotaInfo;
  raw: string;
}

export interface ShopChatGenerateArgs {
  threadId: string;
  /** 一次性额外提示（长按生成条 ⋯；只作用这一次）。 */
  extraHint?: string;
  rosterOverride?: RosterSnapshot;
}

/**
 * 生成一轮商家回复（**不落库**；落库走 applyShopChatReply）。
 * 抛 PhoneChatError（kind: env/api/parse）。
 */
export async function generateShopChatReply(args: ShopChatGenerateArgs): Promise<ShopChatGenerateResult> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  const apiError = validatePhoneApi('chat');
  if (apiError) throw new PhoneChatError('api', apiError);

  const data = readPhoneDataRef(); // O43：AI 请求装配只读整机数据（原整机深拷贝纯浪费）
  const thread = (data.shop?.threads || []).find(t => t.id === args.threadId);
  if (!thread) throw new PhoneChatError('env', '会话不存在');
  const settings = getPhoneSettings();
  const roster = args.rosterOverride ?? getRoster();
  const style = data.style || '';
  const seller = thread.seller;
  const shopData: ShopData = data.shop || emptyShopData();

  const userText = composeShopUserText(shopTrailingUserBatch(thread.messages));
  const mergedExtra = mergeOneShotHint(String(settings.extraPrompt || ''), args.extraHint);
  const chronicleBlocks = readChronicleDossierBlocks([roster.protagonistName || '我'], Number(settings.summaryCount) || 5);
  const storyText = stripWithContextConfig(readAiChatHistory(Number(settings.chatHistoryCount) || 5));

  const active = isCurrencyLinkActive();
  const currencies = active
    ? payCurrencyList().map(c => ({ name: c.name, desc: c.desc, precision: c.precision, balance: payBalance(c) }))
    : [];
  const commonName = active ? (payCommon()?.name || '') : '';
  const items = shopChatItemLines(shopData, seller);
  const focusItem = thread.focusItemId
    ? (shopData.catalog.concat(shopData.favorites).find(it => it.id === thread.focusItemId) || null)
    : null;
  const focusItemName = focusItem?.name || '';
  const focusStatus = focusItem ? shopItemStatusLabel(shopItemStatus(shopData, focusItem.name)) : '';
  const transcript = formatShopTranscript(thread.messages, SHOP_CHAT_CONTEXT_LINES);
  const myReviews = shopChatMyReviewLines(shopData, seller);
  const buyerReviews = shopChatBuyerReviewLines(shopData, seller);
  const rebateLines = shopChatRebateLines(thread);
  const ship = defaultShopAddress(shopData.addresses, shopData.defaultAddressId || '');
  const shipTo = ship ? [ship.name, ship.detail].filter(Boolean).join(' · ') : '';

  const prepare = async (): Promise<void> => {
    await th.injectPrompts([{
      id: `ubp_shop_chat_trigger_${thread.id}`,
      position: 'none',
      depth: 0,
      role: 'system',
      content: buildShopChatTriggerText({ roster, style, seller, focusItemName, userText, extraHint: mergedExtra }),
      should_scan: true,
    }], { once: true });
    await th.injectPrompts([{
      id: `ubp_shop_chat_dossier_${thread.id}`,
      position: 'after_system',
      depth: 0,
      role: 'system',
      content: buildShopChatDossierText({
        roster, style, chronicleBlocks, storyText, currencies, commonName,
        seller, items, focusItemName, focusStatus, transcript, myReviews, buyerReviews, rebateLines, shipTo,
      }),
      should_scan: false,
    }], { once: true });
  };

  const instructionText = buildShopChatInstruction({ roster, style, seller, userText, extraPrompt: mergedExtra, focusItemName });
  const instruction = th.substitudeMacros ? th.substitudeMacros(instructionText) : instructionText;
  const generationId = makeGenerationId('ubp-shop-chat');
  let genIds = _activeGenerations.get(thread.id);
  if (!genIds) _activeGenerations.set(thread.id, (genIds = new Set()));
  genIds.add(generationId);
  _generating.add(thread.id);
  let raw = '';
  try {
    raw = await runPhoneRaw({
      scope: 'chat',
      instruction,
      generationId,
      keep: keepSpyAndPublicEntries,
      prepare,
      activity: {
        feature: '商家会话',
        label: '商家会话',
        appId: 'shop',
        tone: 'shop',
        onCancel: () => { abortShopChatGeneration(thread.id); },
      },
    });
  } finally {
    genIds.delete(generationId);
    if (!genIds.size && _activeGenerations.get(thread.id) === genIds) _activeGenerations.delete(thread.id);
    _generating.delete(thread.id);
  }

  const parsed = parseShopReply(String(raw), {
    seller,
    currencies: currencies.map(c => c.name),
    placeholderCurrency: shopSpec(style).currencyPlaceholder,
  });
  if (!parsed || !parsed.messages.length) {
    throw new PhoneChatError('parse', s(style as PhoneStyle,
      '掌柜没接上话（生成内容无法解析为消息）',
      '阁主没接上话（生成内容无法解析为消息）',
      '掌柜没接上话（生成内容无法解析为消息）',
      '管事没接上话（生成内容无法解析为消息）'));
  }
  return { messages: parsed.messages, quota: parsed.quota, raw: String(raw) };
}

// ─── ② 落库（改价 / 上架 / 红包） ───

export interface ApplyShopChatOptions {
  /** 落库时用户是否正看着这条会话（在看着 = 不计未读）。 */
  watching?: boolean;
}

export interface ApplyShopChatOutcome {
  /** 实际写入的消息条数。 */
  added: number;
  /** 因币种/格式无效被丢弃的条数。 */
  dropped: number;
  /** 因额度（返现/配额）被降级为普通文字的条数。 */
  downgraded: number;
  /** 本次真的改了价的商品名 / 真的上了架的商品名（供 toast）。 */
  priceChanged: string[];
  listed: string[];
  /** 本次发出的商家红包数。 */
  rebates: number;
}

/**
 * 把解析结果落库。**必须在发起时的聊天里调用**（调用方负责归属守卫与 UI 补渲）。
 * 逐条副作用见文件头；改价/上架的中间态在**同一份工作副本**上顺序推进（最后一次性写回）。
 */
export function applyShopChatReply(
  threadId: string,
  messages: readonly ParsedShopMessage[],
  opts: ApplyShopChatOptions = {},
): ApplyShopChatOutcome {
  const out: ApplyShopChatOutcome = { added: 0, dropped: 0, downgraded: 0, priceChanged: [], listed: [], rebates: 0 };
  const roster = getRoster();
  const storyTime = roster.global.time || '';
  const storyDate = storyDateOf(storyTime);
  const style = readPhoneDataRef().style || '';
  const currencyNames = isCurrencyLinkActive() ? payCurrencyList().map(c => c.name) : [];
  const placeholder = shopSpec(style).currencyPlaceholder;
  const maxItems = Math.max(20, Math.min(100, Math.floor(Number(getPhoneSettings().shopMaxItems) || 40)));

  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    const threads: ShopThread[] = (base.threads || []).slice();
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;
    const seller = thread.seller;
    let working: ShopData = { ...base, threads };
    for (const parsed of messages) {
      const built = buildMessageFromParsed(parsed, {
        seller, storyTime, storyDate, thread, data: working, currencyNames, placeholder, maxItems, out,
      });
      if (!built) continue;
      appendShopMessage(thread, built.message);
      working = { ...built.data, threads };
      out.added += 1;
    }
    if (!opts.watching && out.added > 0) thread.unread = Math.min(999, thread.unread + out.added);
    d.shop = { ...working, threads: threads.slice().sort((a, b) => b.updatedAt - a.updatedAt) };
  });
  return out;
}

/** 单条解析结果 → 落库消息 + 推进后的工作数据；返回 null = 该条无效被丢弃。 */
function buildMessageFromParsed(
  parsed: ParsedShopMessage,
  ctx: {
    seller: string;
    storyTime: string;
    storyDate: string;
    thread: ShopThread;
    data: ShopData;
    currencyNames: readonly string[];
    placeholder: string;
    maxItems: number;
    out: ApplyShopChatOutcome;
  },
): { message: ShopMessage; data: ShopData } | null {
  const { seller, storyTime, storyDate, thread, out } = ctx;
  if (parsed.type === 'text') {
    return { message: buildShopTextMessage(seller, parsed.content, storyTime), data: ctx.data };
  }
  if (parsed.type === 'image') {
    if (!parsed.content.trim()) {
      out.dropped += 1;
      return null;
    }
    const message = { ...buildShopTextMessage(seller, parsed.content, storyTime), type: 'image' as const, imageStatus: 'pending' as const };
    return { message, data: ctx.data };
  }
  if (parsed.type === 'redpacket') {
    const meta = resolveCurrencyStrict(parsed.currency || '', ctx.currencyNames, ctx.placeholder);
    if (!meta) {
      out.dropped += 1;
      return null;
    }
    // 返现额度闸：同一商品只返一次 + 会话累计上限（超了「话照说、钱不发」）
    const rebateTarget = shopChatFocusItemName(thread, ctx.data);
    if (!canShopRebate(thread, rebateTarget || parsed.content)) {
      out.downgraded += 1;
      return { message: buildShopTextMessage(seller, parsed.content || s('', '红包', '回礼', '回礼'), storyTime), data: ctx.data };
    }
    markShopRebate(thread, rebateTarget || parsed.content.slice(0, 40), storyDate);
    out.rebates += 1;
    const amountNum = clampAmountLocal(Number(String(parsed.amount || '').replace(/[^\d.]/g, '')), meta.precision);
    if (!(amountNum > 0)) {
      out.dropped += 1;
      return null;
    }
    return {
      message: buildShopRedPacketMessage({
        from: seller,
        amount: formatAmountLocal(amountNum, meta.precision),
        currency: meta.name,
        note: parsed.content,
        claimed: false,
        storyTime,
      }),
      data: ctx.data,
    };
  }
  if (parsed.type === 'price') {
    const payload = parsed.price;
    if (!payload) {
      out.dropped += 1;
      return null;
    }
    const hit = findStoreItem(ctx.data, seller, payload.itemName);
    const meta = hit
      ? resolveCurrencyStrict(hit.currencyName, ctx.currencyNames, ctx.placeholder)
      : resolveCurrencyStrict(ctx.currencyNames[0] || ctx.placeholder, ctx.currencyNames, ctx.placeholder);
    const to = clampAmountLocal(payload.to, meta?.precision ?? 0);
    if (!(to > 0)) {
      out.dropped += 1;
      return null;
    }
    let data = ctx.data;
    let applied = false;
    if (hit) {
      const changed = applyShopPriceChange(ctx.data, payload.itemName, to);
      applied = changed.applied;
      data = changed.data;
      if (applied) out.priceChanged.push(payload.itemName);
    }
    return {
      message: {
        ...buildShopTextMessage(seller, payload.note, storyTime),
        type: 'price',
        priceChange: {
          itemName: payload.itemName,
          from: hit ? hit.price : 0,
          to,
          currencyName: hit?.currencyName || meta?.name || '',
          note: payload.note,
          applied,
        },
      },
      data,
    };
  }
  // 新商品：字段校验沿用商城上架那一套；铺名强制 = 本会话店铺（用户口径：商铺无需再重复生成）
  const item = buildShopItemFromFields(parsed.item?.fields || {}, parsed.item?.reviews || [], {
    currencies: ctx.currencyNames.map(name => ({ name, precision: 0 as const })),
    placeholderCurrency: ctx.placeholder,
    sellerOverride: seller,
  });
  if (!item) {
    out.dropped += 1;
    return null;
  }
  const stamped: ShopItem = { ...item, addedAt: storyDate || '' };
  const merged = mergeShopCatalog(ctx.data, [stamped], ctx.maxItems);
  const added = merged.added[0] || null;
  const listed = Boolean(added);
  if (listed) out.listed.push(stamped.name);
  return {
    message: {
      ...buildShopTextMessage(seller, '', storyTime),
      type: 'item',
      newItem: { item: added || { ...stamped, id: makeShopItemId() }, listed },
    },
    data: merged.data,
  };
}

/** 币种严格解析（trim + 忽略大小写全等；无货币联动时认占位名；miss 返回 null）。 */
function resolveCurrencyStrict(
  name: string,
  currencies: readonly string[],
  placeholder: string,
): { name: string; precision: 0 | 2 } | null {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (currencies.length) {
    const hit = payCurrencyList().find(c => c.name.toLowerCase() === key);
    return hit ? { name: hit.name, precision: hit.precision } : null;
  }
  return key === String(placeholder || '元').toLowerCase() ? { name: placeholder, precision: 0 } : null;
}

function clampAmountLocal(n: number, precision: 0 | 2): number {
  const safe = Number.isFinite(n) ? n : 0;
  const f = precision === 2 ? 100 : 1;
  return Math.round(safe * f) / f;
}

function formatAmountLocal(n: number, precision: 0 | 2): string {
  return precision === 2 ? n.toFixed(2) : String(Math.round(n));
}

/** 本店某件商品（货架∪收藏∪购物车；按名归并）。 */
function findStoreItem(data: ShopData, seller: string, itemName: string): ShopItem | null {
  const key = shopNameKeyLocal(itemName);
  if (!key) return null;
  return listShopItemsForSeller(data, seller, 200).find(it => shopNameKeyLocal(it.name) === key) || null;
}

function shopNameKeyLocal(name: string): string {
  return String(name || '').replace(/\s+/g, '').toLowerCase();
}

/** 返现归属商品：当前咨询商品 > 本店第一件（额度记录需要一个稳定的名）。 */
function shopChatFocusItemName(thread: ShopThread, data: ShopData): string {
  const focus = thread.focusItemId
    ? (data.catalog.concat(data.favorites).find(it => it.id === thread.focusItemId) || null)
    : null;
  if (focus) return focus.name;
  return listShopItemsForSeller(data, thread.seller)[0]?.name || '';
}

// ─── ③ 我方动作（发红包 / 发文字图片 / 草稿 / 咨询商品 / 清空） ───

/** 我方发红包：扣款（source='shop'）成功才上屏；失败返回原因（同转账口径，绝不赊账）。 */
export function sendShopRedPacket(args: {
  threadId: string;
  amount: number;
  currencyName: string;
  note: string;
}): { ok: true } | { ok: false; error: string } {
  if (!isCurrencyLinkActive()) return { ok: false, error: '未启用货币系统，无法发红包' };
  if (!(args.amount > 0) || args.amount >= 1000000) return { ok: false, error: '金额无效' };
  const meta = payCurrencyList().find(c => c.name === args.currencyName) || null;
  if (!meta) return { ok: false, error: `币种「${args.currencyName}」不在当前货币体系中` };
  const amount = clampAmountLocal(args.amount, meta.precision);
  if (!(amount > 0)) return { ok: false, error: '金额无效' };
  if (payBalance(meta) < amount) return { ok: false, error: `${meta.name}余额不足` };
  const seller = (readPhoneDataRef().shop?.threads || []).find(t => t.id === args.threadId)?.seller || '';
  const paid = payAdjustResult(meta, -amount, 'shop', `商城红包 · ${seller}`.trim());
  if (!paid) return { ok: false, error: '扣款失败（货币桥不可用），请稍后重试' };
  const storyTime = getRoster().global.time || '';
  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    const threads = (base.threads || []).slice();
    const thread = threads.find(t => t.id === args.threadId);
    if (!thread) return;
    appendShopMessage(thread, buildShopRedPacketMessage({
      from: 'me',
      amount: formatAmountLocal(amount, meta.precision),
      currency: meta.name,
      note: String(args.note || '').slice(0, 100),
      claimed: true,
      storyTime,
    }));
    d.shop = { ...base, threads: threads.sort((a, b) => b.updatedAt - a.updatedAt) };
  });
  return { ok: true };
}

/** 我方发文字/图片（上屏攒批；不触发）。 */
export function sendShopUserMessage(
  threadId: string,
  message: { type: 'text' | 'image'; content: string; imagePath?: string },
): boolean {
  const text = String(message.content || '').trim();
  if (!text) return false;
  const storyTime = getRoster().global.time || '';
  let ok = false;
  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    const threads = (base.threads || []).slice();
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;
    const built: ShopMessage = message.type === 'image'
      ? {
        ...buildShopTextMessage('me', text, storyTime),
        type: 'image',
        ...(message.imagePath ? { imagePath: message.imagePath, imageStatus: 'ready' as const } : {}),
      }
      : buildShopTextMessage('me', text, storyTime);
    appendShopMessage(thread, built);
    d.shop = { ...base, threads: threads.sort((a, b) => b.updatedAt - a.updatedAt) };
    ok = true;
  });
  return ok;
}

/** 领取商家红包（claimed 守卫 + 入账 rp-open 同一本账）。已领过返回 false。 */
export function claimShopRedPacket(threadId: string, messageId: string): { ok: boolean; error?: string } {
  const data = readPhoneDataRef();
  const thread = (data.shop?.threads || []).find(t => t.id === threadId);
  const msg = thread?.messages.find(m => m.id === messageId);
  if (!msg || msg.type !== 'redpacket' || msg.claimed !== false) return { ok: false };
  const amount = Number(msg.amount) || 0;
  if (!(amount > 0)) return { ok: false, error: '红包金额无效' };
  const meta = payCurrencyList().find(c => c.name === (msg.currency || '')) || null;
  if (!meta) return { ok: false, error: '该币种已不在货币体系中，无法领取' };
  if (payAdjustResult(meta, amount, 'rp-open', `红包 · ${thread?.seller || ''}`.trim())) {
    mutatePhoneData(d => {
      const m = (d.shop?.threads || []).find(x => x.id === threadId)?.messages.find(x => x.id === messageId);
      if (m) m.claimed = true;
    });
    return { ok: true };
  }
  return { ok: false, error: '入账失败（货币桥不可用）' };
}

/** 标记会话已读（打开会话时调用）。 */
export function markShopThreadRead(threadId: string): void {
  const thread = (readPhoneDataRef().shop?.threads || []).find(t => t.id === threadId);
  if (!thread || thread.unread === 0) return;
  mutatePhoneData(d => {
    const t = (d.shop?.threads || []).find(x => x.id === threadId);
    if (t) t.unread = 0;
  });
}

/** 写输入框草稿（空串 = 删字段）。 */
export function setShopThreadDraft(threadId: string, draft: string): void {
  mutatePhoneData(d => {
    const t = (d.shop?.threads || []).find(x => x.id === threadId);
    if (!t) return;
    const text = String(draft || '').slice(0, 500);
    if (text) t.draft = text;
    else delete t.draft;
  });
}

/** 设置当前咨询商品（从商品详情进入会话时调用；只做 UI 记忆，不影响货架）。 */
export function setShopThreadFocus(threadId: string, itemId: string): void {
  mutatePhoneData(d => {
    const t = (d.shop?.threads || []).find(x => x.id === threadId);
    if (!t) return;
    if (itemId) t.focusItemId = itemId;
    else delete t.focusItemId;
  });
}

/** 清空会话记录 / 删除会话（长按动作面板用）。 */
export function clearShopThread(threadId: string, removeThread = false): void {
  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    const threads = (base.threads || []).slice();
    const idx = threads.findIndex(t => t.id === threadId);
    if (idx < 0) return;
    if (removeThread) threads.splice(idx, 1);
    else threads[idx] = { ...threads[idx], messages: [], unread: 0, updatedAt: Date.now() };
    d.shop = { ...base, threads };
  });
}

// ─── ④ 商家自动消息（零 AI：下单 / 送达 / 取消） ───

/**
 * 推一条商家自动消息（订单事件驱动，不烧 AI）：
 * 没会话就建一条（真机也是这么来的）；计未读与桌面角标；**不弹横幅**（订单事件本身已有横幅）。
 * 返回是否成功写入。
 */
export function pushShopAutoMessage(args: {
  seller: string;
  kind: 'ordered' | 'delivered' | 'cancelled';
  /** 下单时用：收货信息一行（`收货人 · 地址`；未填给空串 → 文案走"提醒补填"分支）。 */
  ship?: string;
  /** 下单时用：预计送达的短标签（M月D日）。 */
  arriveLabel?: string;
}): boolean {
  const seller = String(args.seller || '').trim();
  if (!seller) return false;
  const style = readPhoneDataRef().style || '';
  const pool = args.kind === 'ordered'
    ? SHOP_AUTO_MESSAGES.ordered(style, String(args.ship || ''), String(args.arriveLabel || ''))
    : args.kind === 'delivered'
      ? SHOP_AUTO_MESSAGES.delivered(style)
      : SHOP_AUTO_MESSAGES.cancelled(style);
  const text = pickShopAutoMessage(pool);
  if (!text) return false;
  const storyTime = getRoster().global.time || '';
  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    const threads = (base.threads || []).slice();
    const thread = ensureShopThread(threads, seller);
    appendShopMessage(thread, buildShopTextMessage(thread.seller, text, storyTime));
    thread.unread = Math.min(999, thread.unread + 1);
    d.shop = { ...base, threads: threads.sort((a, b) => b.updatedAt - a.updatedAt) };
  });
  emitPhoneEvent('ubp-phone:data-changed');
  return true;
}

/** 下单自动消息里的收货信息一行（未填返回空串 → 文案走"提醒补填"分支）。 */
export function shopAutoShipLine(address: { name: string; detail: string } | null | undefined): string {
  if (!address) return '';
  return [address.name, address.detail].map(v => String(v || '').trim()).filter(Boolean).join(' · ');
}
