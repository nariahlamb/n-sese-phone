// ===== 网上商城 App（docs/52 · docs/54）=====
// 四 tab（首页 / 消息 / 购物车 / 我的）+ 三个子页（商品详情 / 订单详情 / 商家会话）+ 弹层（结算 / 支付成功 / 取消确认）。
// 商家会话（docs/54）整块收在 renderers/shop-chat：本文件只做 tab 与视图切换、详情页「消息」入口与评价区、
// 「我的」页收货地址卡、结算弹层的收货地址行，以及把点击/长按/深链转给它（容器级委托一条不散）。
// 数据域 core/shop-model（追加制货架 + 收藏/购物车保护）；AI 上货·结算·送达结算 core/shop-engine；
// 商品主图 core/shop-images（借用主项目衣柜单品方案）；币种严格解析（miss 拒绝，绝不回落常用币）。
// 纪律：容器级 click 委托 + mount/unmount 成对；滚动位 createViewScrollMemo（按 tab/子页分键）；
//   长按商品卡/收藏卡=删除商品（货架+收藏+购物车一并清除）、长按购物车行=删除（全机统一长按件）；
//   生成/支付各一把闸（防双击重复请求与重复扣款）；
//   打开即送达结算（幂等、无在途订单零开销），绝无常驻定时器。

import { S, currentStyle } from '../core/skins';
import { escapeAttr, escapeHtml } from '../core/ubp-utils';
// 商家消息（docs/54）：消息 tab / 聊天页 / 评价区 / 收货地址簿都在这两个模块里
import {
  bindShopChatHost, closeShopChat, closeShopChatSheet, handleShopChatAct, openShopChat,
  pumpShopChatImages, renderShopAddressCard, renderShopChatConversation, renderShopChatSheet,
  renderShopCheckoutAddressRow, renderShopMessagesTab, renderShopReviewSection, shopChatAfterRender,
  shopChatBackTarget, shopChatFromItemId, shopChatInputHandler, shopChatKeyHandler,
  shopChatLongPressTarget, shopChatThreadId, shopChatUnreadTotal,
  syncCheckoutAddress, unbindShopChatHost,
} from './shop-chat';
import { clearShopThread } from '../core/shop-chat-engine';
import { clearPhoneNotificationsFor } from '../core/notification-feed';
import { getRoster } from '../core/roster';
import { currentPhoneStorageId, mutatePhoneData, readPhoneDataRef } from '../core/phone-store';
import { selfStamp } from '../core/social-time';
import {
  cartAdd, cartRemove, cartSetQty, cartTotalQty, emptyShopData, isFavorited, removeShopItem,
  shopCategories, shopItemKey, shopStats, shopTransitCount, toggleFavorite,
  type ShopCartLine, type ShopItem, type ShopOrder,
} from '../core/shop-model';
import { lastShopPriceFrom, listShopItemsForSeller, type ShopThread } from '../core/shop-chat-model';
import { getPhoneSettings } from '../core/phone-settings';
import { fallbackShopSeller, shopBannerFlavor, shopSpec } from '../core/shop-prompts';
import {
  abortShopGeneration, applyShopRefresh, cancelShopOrder, checkoutShopLines, refreshShopCatalog,
  reorderShopOrder, resolveShopCurrency, settleShopOrders, shopArriveLabel, shopCheckoutBusy,
  shopCheckoutTotals,
} from '../core/shop-engine';
import { isPhoneAbortError } from '../core/phone-error';
import { autoGenerateShopImages, findShopItem, generateShopItemImage, shopItemImageBusy } from '../core/shop-images';
import {
  currencyIconSvg, fmtQty, isCurrencyLinkActive, payBalance, payCommon, payCurrencyList, withPaySnapshot,
} from '../core/currency-link';
import { emitPhoneEvent, emitPhoneNotify, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openActionSheet, openConfirmSheet } from './action-sheet';
import { avatarHtml, createViewScrollMemo, setShopGenActivity, showScreenToast } from './phone-ui';
import { emitAch } from '../core/phone-achievements';
import { bindHintLongPress, openOneShotHintSheet } from './hint-sheet';
import { ubpIcon } from './icons';

type ShopTab = 'home' | 'msg' | 'cart' | 'me';
type ShopView = 'tab' | 'detail' | 'order' | 'chat';
type ShopSheet =
  | null
  | { kind: 'success'; orders: ShopOrder[]; memoFail: number }
  | { kind: 'cancel'; orderId: string }
  // L21：checkout 弹层带下单来源（成就 payload：via=cart 购物车结算 / buy 立即购买）
  | { kind: 'checkout'; lines: ShopCartLine[]; via: 'cart' | 'buy' };

let _ctx: PhoneAppContext | null = null;
let _tab: ShopTab = 'home';
let _view: ShopView = 'tab';
let _detailId = '';
let _orderId = '';
/** 首页分类筛选（'' = 全部；本地筛选不耗 AI）。 */
let _filter = '';
/** 「我的」订单状态筛选（'' = 全部）。 */
let _ofilter = '';
let _generating = false;
let _paying = false;
let _error = '';
/** _error 归属的聊天（storageId）：换聊天后不把上一个聊天的失败原因显示出来（防串味）。 */
let _errorOwner = '';
/** 刷新代次：每次发起/中止都 +1，使在途那一次的收尾（含错误提示）失效。 */
let _refreshSeq = 0;
let _sheet: ShopSheet = null;
/** 购物车勾选（item id）。 */
const _checked = new Set<string>();
/** 商品图生成中的 item id（UI 态；core/shop-images 内有同款闸防重复请求）。 */
const _imgBusy = new Set<string>();
const _scroll = createViewScrollMemo();
const _longPressFiredAt = { at: 0 };
/** F72：上一帧渲染的聊天会话 id（滚动保位判据之一：同会话且消息条数没变=保位，否则贴底）。 */
let _renderedChatThreadId = '';

const appName = (): string => shopSpec(currentStyle()).appName;

function shopData() {
  return readPhoneDataRef().shop || emptyShopData();
}

function itemById(id: string): ShopItem | null {
  return findShopItem(id);
}

/** 价格文本（币种严格解析；币种已删/未命中 → 原样显示币种名，不猜）。 */
function priceParts(item: ShopItem, qty = 1): { amount: string; unit: string } {
  const meta = resolveShopCurrency(item.currencyName);
  const n = item.price * Math.max(1, qty);
  if (meta) return { amount: fmtQty(meta.precision, n), unit: meta.name };
  return { amount: String(n), unit: item.currencyName };
}

function priceHtml(item: ShopItem, qty = 1, cls = 'ubp-shp-price'): string {
  const p = priceParts(item, qty);
  return `<div class="${cls}">${escapeHtml(p.amount)}<small>${escapeHtml(p.unit)}</small></div>`;
}

/** 送货行文案（风格换装）。 */
function deliveryText(item: ShopItem): string {
  return shopSpec(currentStyle()).deliveryText(item.deliveryDays);
}

function sellerText(item: ShopItem): string {
  return item.seller || fallbackShopSeller(currentStyle());
}

/** 图块渐变（按 id 稳定取色，六选一）。 */
function tileClass(item: ShopItem): string {
  let hash = 0;
  for (const ch of item.id + item.name) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return `ubp-shp-g${(hash % 6) + 1}`;
}

/**
 * 图块内容：有商品图用图；**生图中显示与社媒同款的转圈动画**（用户定案：与其他 App 统一表征）；
 * 其余回落 emoji 图符。busy 取引擎的同一把闸（手动点「看主图」与进店自动补图都算）。
 */
function tileInner(item: ShopItem): string {
  if (item.image) return `<img src="${escapeAttr(item.image)}" alt="" loading="lazy">`;
  if (shopItemImageBusy(item.id)) return '<span class="ubp-spinner"></span>';
  return escapeHtml(item.glyph || '🎁');
}

/** 订单状态文案（风格换装）。 */
function orderStatusText(order: ShopOrder): string {
  if (order.status === 'delivered') return S('已送达', '已送到', '已送到', '已送达');
  if (order.status === 'cancelled') return S('已取消', '已作废', '已作废', '已取消');
  return S('运送中', '在途', '在途', '运送中');
}

function todayStamp(): string {
  try { return selfStamp(getRoster().global.time || ''); } catch (_e) { return ''; }
}

function shortStoryDate(raw: string): string {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})/.exec(String(raw || '').trim());
  return m ? `${Number(m[2])}月${Number(m[3])}日` : String(raw || '').trim();
}

// ─── 渲染 ───

/** 渲染入口：整屏共享进入时的**同一份货币快照**（O34 口径——逐处现读会把主扩展账本读十几遍）。 */
function render(): void {
  withPaySnapshot(() => renderView());
}

function renderView(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const body = container.querySelector('#ubp-shp-scroll') as HTMLElement | null;
  const viewKey = `shp:${_view}:${_tab}:${_detailId}:${_orderId}`;
  const restore = _scroll.settle(viewKey, body ? body.scrollTop : 0);
  // F72：聊天页滚动保位（微信口径）——重绘前记下旧滚动位与非系统消息条数，重绘后
  // 「同会话且没来新消息 → 原样恢复；首次进入 / 切会话 / 新消息 → 贴底」。
  const prevMsgs = _view === 'chat' ? container.querySelector('#ubp-shc-msgs') as HTMLElement | null : null;
  const chatPrevTop = prevMsgs?.scrollTop ?? 0;
  const chatPrevCount = prevMsgs ? prevMsgs.querySelectorAll('.ubp-shc-mrow[data-mid]').length : -1;
  const spec = shopSpec(currentStyle());
  let inner = '';
  if (_view === 'detail') inner = renderDetail();
  else if (_view === 'order') inner = renderOrderDetail();
  else if (_view === 'chat') inner = renderShopChatConversation();
  else if (_tab === 'msg') inner = renderShopMessagesTab();
  else if (_tab === 'cart') inner = renderCart();
  else if (_tab === 'me') inner = renderMe();
  else inner = renderHome();
  const chatThread = _view === 'chat' ? shopChatThreadsSnapshot() : null;
  const chatSub = chatThread
    ? (() => {
      const items = listShopItemsForSeller(shopData(), chatThread.seller);
      const focusItem = chatThread.focusItemId ? itemById(chatThread.focusItemId) : null;
      const parts = [S(`在售 ${items.length} 件`, `在售 ${items.length} 件`, `在售 ${items.length} 件`, `在售 ${items.length} 件`)];
      if (focusItem) parts.push(S(`正在咨询：${focusItem.name}`, `正问：${focusItem.name}`, `正问：${focusItem.name}`, `正问：${focusItem.name}`));
      return parts.join(' · ');
    })()
    : '';
  const title = _view === 'detail'
    ? S('商品详情', '货品详情', '货品详情', '货品详情')
    : _view === 'order' ? S('订单详情', '契书详情', '契书详情', '契约详情')
      : _view === 'chat' ? (chatThread?.seller || '')
        : _tab === 'msg' ? S('消息', '传讯', '捎话', '传讯')
          : _tab === 'cart' ? spec.cartLabel : _tab === 'me' ? S('我的', '我的', '我的', '我的') : appName();
  const showRefresh = _view === 'tab' && _tab === 'home';
  const showMenu = _view === 'tab' && _tab === 'cart';
  const showChatMenu = _view === 'chat';
  const rightSlot = showRefresh
    ? `<button class="ubp-iconbtn" data-ubp-act="refresh" title="${escapeAttr(spec.refreshVerb + refreshHintSuffix())}">${_generating ? '<span class="ubp-spinner"></span>' : ubpIcon('refresh')}</button>`
    : showMenu
      ? `<button class="ubp-iconbtn" data-ubp-act="menu" title="${S('菜单', '菜单', '菜单', '菜单')}">${ubpIcon('more')}</button>`
      : showChatMenu
        ? `<button class="ubp-iconbtn" data-ubp-act="chat-menu" title="${S('菜单', '菜单', '菜单', '菜单')}">${ubpIcon('more')}</button>`
        : '<span style="width:32px"></span>';
  // 首页抬头＝品牌行（用户定案：去左上角返回钮，商城图标做成微博式 LOGO 放左上，与其他 App 的顶栏结构统一）：
  // LOGO 方块 + App 名（换装跟风格），右侧仍是刷新；此时不渲染居中标题（与微博品牌顶栏同款，不重复报名字）。
  const branded = _view === 'tab' && _tab === 'home';
  const bodyCls = _view === 'chat' ? 'ubp-appbody noscroll' : 'ubp-appbody';
  container.innerHTML = `
    <div class="ubp-appbar${branded ? ' ubp-shp-brandbar' : ''}">
      ${branded
    ? `<span class="ubp-shp-logo">${ubpIcon('shop')}</span><span class="ubp-shp-brand">${escapeHtml(appName())}</span>`
    : `${_view === 'tab' && _tab !== 'home' && _tab !== 'msg'
      ? '<span style="width:32px"></span>'
      : `<button class="ubp-iconbtn" data-ubp-act="back" title="${S('返回', '返回')}">${ubpIcon(_view === 'tab' ? 'home' : 'back')}</button>`}
      <span class="ubp-appbar-title">${escapeHtml(title)}${chatSub ? `<span class="ubp-appbar-sub">${escapeHtml(chatSub)}</span>` : ''}</span>`}
      ${rightSlot}
    </div>
    <div class="${bodyCls}" id="ubp-shp-scroll">${inner}</div>
    ${_sheet ? renderSheet() : ''}
    ${renderShopChatSheet()}`;
  // 生成中：把状态条钉在内容之上（appbody 内已含；这里只负责 tabbar 与滚动位）
  const tabbar = renderTabbar();
  container.insertAdjacentHTML('beforeend', tabbar);
  const next = container.querySelector('#ubp-shp-scroll') as HTMLElement | null;
  if (next) next.scrollTop = restore.top;
  const msgBody = container.querySelector('#ubp-shc-msgs') as HTMLElement | null;
  if (msgBody) {
    // F72：此前「恒滚到底」——开关＋面板、取消引用、图片开始生成这类无关重绘会把正在翻历史的
    // 视图拽回底部（窥私聊天页同款问题曾返工）。现按微信口径：会话没变且消息条数没变 → 恢复原位。
    const count = msgBody.querySelectorAll('.ubp-shc-mrow[data-mid]').length;
    const threadId = shopChatThreadId();
    const keep = Boolean(_renderedChatThreadId) && _renderedChatThreadId === threadId && chatPrevCount >= 0 && count === chatPrevCount;
    msgBody.scrollTop = keep ? chatPrevTop : msgBody.scrollHeight;
  }
  _renderedChatThreadId = _view === 'chat' ? shopChatThreadId() : '';
  shopChatAfterRender(container);
  // 商城调色板作用域（覆盖 --ubp-accent → 电商橙/风格色）
  container.classList.add('ubp-shp-scope');
}

function renderTabbar(): string {
  if (_view !== 'tab') return '';
  const data = shopData();
  const cartCount = cartTotalQty(data);
  const msgUnread = shopChatUnreadTotal();
  const tab = (id: ShopTab, icon: Parameters<typeof ubpIcon>[0], label: string, badge: number): string =>
    `<div class="ubp-shp-tab${_tab === id ? ' on' : ''}" data-ubp-act="tab" data-tab="${id}">
      <i>${ubpIcon(icon)}</i><span>${escapeHtml(label)}</span>${badge > 0 ? `<span class="ubp-shp-tabbdg">${badge > 99 ? '99+' : badge}</span>` : ''}
    </div>`;
  const spec = shopSpec(currentStyle());
  return `<div class="ubp-shp-tabbar">
    ${tab('home', 'shop', S('首页', '铺面', '铺面', '货栈'), 0)}
    ${tab('msg', 'comment', S('消息', '传讯', '捎话', '传讯'), msgUnread)}
    ${tab('cart', 'cart', spec.cartLabel, cartCount)}
    ${tab('me', 'user', S('我的', '我的', '我的', '我的'), 0)}
  </div>`;
}

/** 首页：横幅 + 分类筛选 + 双列网格（生成中=骨架 / 空态 / 错误态）。 */
function renderHome(): string {
  const data = shopData();
  const spec = shopSpec(currentStyle());
  const currencyOn = isCurrencyLinkActive();
  const warn = currencyOn ? ''
    : `<div class="ubp-shp-warnbar">⚠️ ${S('未启用货币 · 只能浏览', '未启用货币 · 只能浏览', '未启用货币 · 只能浏览', '未启用货币 · 只能浏览')}</div>`;
  // 横幅只留 flavor 一句（用户定案：原来那行「今日上新 · 故事日 X月X日」的 title 没有意义，直接删）
  const banner = `<div class="ubp-shp-banner">
      <span class="ubp-shp-banner-ico">🛍️</span>
      <span class="ubp-shp-banner-d">${escapeHtml(shopBannerFlavor(currentStyle()))}</span>
    </div>`;
  if (_generating) {
    const skel = Array.from({ length: 6 }, () => `<div class="ubp-shp-skel">
        <div class="ubp-shp-skel-b" style="height:118px;border-radius:0"></div>
        <div style="padding:9px">
          <div class="ubp-shp-skel-b" style="height:11px;width:78%"></div>
          <div class="ubp-shp-skel-b" style="height:11px;width:52%;margin-top:6px"></div>
          <div class="ubp-shp-skel-b" style="height:14px;width:46%;margin-top:9px"></div>
        </div>
      </div>`).join('');
    return `${warn}
      <div class="ubp-shp-genbar"><span class="ubp-shp-genbar-dot"></span><span>${escapeHtml(spec.generatingText)}</span>
        <span style="flex:1"></span><button class="ubp-btn" style="height:26px;padding:0 10px" data-ubp-act="abort">${S('取消', '作罢', '作罢', '作罢')}</button>
      </div>
      <div class="ubp-shp-grid" style="margin-top:10px">${skel}</div>`;
  }
  if (_error) {
    return `${warn}<div class="ubp-shp-err">
        <b>${S('没能上出货', '备货未成', '张罗未成', '进货未成')}</b>
        <p>${escapeHtml(_error)}</p>
        <button class="ubp-btn primary" style="height:34px;padding:0 16px" data-ubp-act="refresh" title="${escapeAttr(S('长按可加提示', '长按可加提点', '长按可加提点', '长按可加提点'))}">${S('重试', '再试', '再试', '再试')}</button>
      </div>`;
  }
  const catalog = data.catalog;
  if (!catalog.length) {
    return `${warn}<div class="ubp-empty">
        <b class="ubp-shp-empty-t">${escapeHtml(spec.emptyTitle)}</b>
        ${escapeHtml(spec.emptyText)}<br>
        <button class="ubp-empty-btn" data-ubp-act="refresh" title="${escapeAttr(spec.emptyAction + refreshHintSuffix())}">${escapeHtml(spec.emptyAction)}</button>
      </div>`;
  }
  const today = todayStamp(); // 「新」角标用（横幅已按用户口径只留 flavor 一句）
  const cats = shopCategories(data);
  const chips = [`<span class="ubp-shp-chip${_filter ? '' : ' on'}" data-ubp-act="filter" data-cat="">${S('全部', '全部', '全部', '全部')}</span>`,
    ...cats.map(c => `<span class="ubp-shp-chip${_filter === c ? ' on' : ''}" data-ubp-act="filter" data-cat="${escapeAttr(c)}">${escapeHtml(c)}</span>`)].join('');
  const items = _filter ? catalog.filter(it => it.category === _filter) : catalog;
  const cards = items.map(item => {
    const fav = isFavorited(data, item);
    const isNew = !!item.addedAt && item.addedAt === today;
    return `<div class="ubp-shp-card" data-ubp-act="open-item" data-id="${escapeAttr(item.id)}">
      <div class="ubp-shp-thumb ${tileClass(item)}">
        ${tileInner(item)}
        ${isNew ? `<span class="ubp-shp-new">${S('新', '新', '新', '新')}</span>` : ''}
        <span class="ubp-shp-fav${fav ? ' on' : ''}" data-ubp-act="fav" data-id="${escapeAttr(item.id)}">${ubpIcon(fav ? 'likeFill' : 'like')}</span>
      </div>
      <div class="ubp-shp-pinfo">
        <div class="ubp-shp-name">${escapeHtml(item.name)}</div>
        ${priceHtml(item)}
        <div class="ubp-shp-meta"><span>${escapeHtml(sellerText(item))}</span><span>${escapeHtml(item.category || '')}</span></div>
      </div>
    </div>`;
  }).join('');
  const filtered = _filter && !items.length
    ? `<div class="ubp-empty">${S('这个分类暂时没有货', '此分类暂无货', '此分类暂无货', '此分类暂无货')}</div>`
    : '';
  return `${warn}${banner}<div class="ubp-shp-chips">${chips}</div>${filtered}<div class="ubp-shp-grid">${cards}</div>`;
}

/** 商品详情：主图区（按需生图）+ 信息 + 买家评价 + 吸底操作条。 */
function renderDetail(): string {
  const item = itemById(_detailId);
  if (!item) { _view = 'tab'; _detailId = ''; return renderHome(); }
  const data = shopData();
  const fav = isFavorited(data, item);
  const busy = _imgBusy.has(item.id) || shopItemImageBusy(item.id);
  // 生图中：主图区换成社媒同款转圈（大一号）+ 药丸文案「生成中…」；与卡片图块、购物车/订单缩略图同一套表征
  const heroInner = item.image
    ? `<img src="${escapeAttr(item.image)}" alt="">`
    : busy
      ? '<span class="ubp-spinner ubp-shp-hero-spin"></span>'
      : `<span>${escapeHtml(item.glyph || '🎁')}</span>`;
  const heroBadge = item.image
    ? S('AI 商品图', 'AI 商品图', 'AI 商品图', 'AI 商品图')
    : S('图块 · 未生图', '图块 · 未生图', '图块 · 未生图', '图块 · 未生图');
  const pill = busy
    ? `<span class="ubp-shp-hero-pill">${S('生成中…', '成像中…', '成像中…', '成像中…')}</span>`
    : `<span class="ubp-shp-hero-pill" data-ubp-act="gen-image" data-id="${escapeAttr(item.id)}">${item.image ? S('重新生成', '重新成像', '重新成像', '重新成像') : S('看主图', '看图像', '看图像', '看图像')}</span>`;
  const imgErr = item.imageError && !busy
    ? `<div class="ubp-shp-note red" style="padding:0 2px">${S('商品图生成失败：', '商品图生成失败：', '商品图生成失败：', '商品图生成失败：')}${escapeHtml(item.imageError)}</div>`
    : '';
  // 掌柜让过价：显示划线原价 + 来源细条（原价取「最近一次改价的 from」，从本店会话读，零新增字段）
  const listPrice = lastShopPriceFrom(shopData().threads, item.name);
  const hasDeal = listPrice > 0 && listPrice > item.price;
  const seller = sellerText(item);
  const sellerThread = (shopData().threads || []).find(t => t.seller === seller);
  const dealHint = hasDeal && sellerThread
    ? `<div class="ubp-shc-hintbar" data-ubp-act="shop-msg" data-seller="${escapeAttr(seller)}" data-id="${escapeAttr(item.id)}">💬 ${S(`掌柜刚在消息里给您让了价：${listPrice} → ${item.price} ${item.currencyName}（结算按新价）`, `掌柜刚在消息里给您让了价：${listPrice} → ${item.price} ${item.currencyName}`, `掌柜刚在消息里给您让了价：${listPrice} → ${item.price} ${item.currencyName}`, `管事刚在消息里给您折了价：${listPrice} → ${item.price} ${item.currencyName}`)}</div>`
    : '';
  return `
    <div class="ubp-shp-hero ${item.image ? '' : tileClass(item)}">
      ${heroInner}
      <span class="ubp-shp-hero-badge">${escapeHtml(heroBadge)}</span>
      ${pill}
    </div>
    <div class="ubp-shp-pad">
      <div class="ubp-shp-sec">
        <div class="ubp-shp-dname">${escapeHtml(item.name)}</div>
        ${hasDeal
    ? `<div class="ubp-shp-dprice">${escapeHtml(priceParts(item).amount)}<small>${escapeHtml(priceParts(item).unit)}</small><span class="ubp-shp-was">${escapeHtml(String(listPrice))}</span><span class="ubp-shp-save">${escapeHtml(S('掌柜已让价', '阁主已让价', '掌柜已让价', '管事已折价'))}</span></div>`
    : priceHtml(item, 1, 'ubp-shp-dprice')}
        <div class="ubp-shp-tags">
          <span class="ubp-shp-tag">${escapeHtml(sellerText(item))}</span>
          ${item.category ? `<span class="ubp-shp-tag">${escapeHtml(item.category)}</span>` : ''}
          <span class="ubp-shp-tag">${escapeHtml(deliveryText(item))}</span>
        </div>
      </div>
      ${item.desc ? `<div class="ubp-shp-sec"><div class="ubp-shp-desc">${escapeHtml(item.desc)}</div></div>` : ''}
      ${imgErr}
      ${dealHint}
      ${renderShopReviewSection(item)}
    </div>
    <div class="ubp-shp-buybar">
      <button class="ubp-shp-minibtn pri" data-ubp-act="shop-msg" data-seller="${escapeAttr(seller)}" data-id="${escapeAttr(item.id)}" title="${escapeAttr(S('和掌柜聊聊这件', '和阁主聊聊这件', '和掌柜聊聊这件', '和管事聊聊这件'))}">
        ${ubpIcon('comment')}<span>${escapeHtml(S('消息', '传讯', '捎话', '传讯'))}</span>
      </button>
      <button class="ubp-shp-minibtn${fav ? ' on' : ''}" data-ubp-act="fav" data-id="${escapeAttr(item.id)}">
        ${ubpIcon(fav ? 'likeFill' : 'like')}<span>${escapeHtml(fav ? S('已收藏', '已收', '已收', '已珍藏') : S('收藏', '收着', '收着', '珍藏'))}</span>
      </button>
      <button class="ubp-shp-minibtn" data-ubp-act="cart-add" data-id="${escapeAttr(item.id)}">${ubpIcon('cart')}<span>${escapeHtml(S('加购', '进货担', '进货担', '进行囊'))}</span></button>
      <button class="ubp-shp-btn solid" data-ubp-act="buy-now" data-id="${escapeAttr(item.id)}">${escapeHtml(S('立即购买', '即刻买下', '即刻买下', '即刻买下'))}</button>
    </div>`;
}

/** 购物车：勾选 / 数量 / 删除 + 按币种分组合计。 */
function renderCart(): string {
  const data = shopData();
  const spec = shopSpec(currentStyle());
  const cart = data.cart;
  if (!cart.length) {
    return `<div class="ubp-empty">
      <b class="ubp-shp-empty-t">${escapeHtml(S('购物车还是空的', '储物袋还是空的', '货担还是空的', '行囊还是空的'))}</b>
      ${S('去首页逛逛，把中意的东西放进来。', '去铺面逛逛，把中意的东西放进来。', '去铺面逛逛，把中意的东西放进来。', '去货栈逛逛，把中意的东西放进来。')}<br>
      <button class="ubp-empty-btn" data-ubp-act="tab" data-tab="home">${escapeHtml(S('去逛逛', '去逛逛', '去逛逛', '去逛逛'))}</button>
    </div>`;
  }
  const rows = cart.map(line => {
    const item = line.item;
    const on = _checked.has(item.id);
    return `<div class="ubp-shp-crow" data-cart-row="${escapeAttr(item.id)}">
      <span class="ubp-shp-ck${on ? ' on' : ''}" data-ubp-act="ck" data-id="${escapeAttr(item.id)}">${on ? '✓' : ''}</span>
      <span class="ubp-shp-cthumb ${tileClass(item)}">${tileInner(item)}</span>
      <span class="ubp-shp-cinfo">
        <span class="ubp-shp-cname" style="display:block">${escapeHtml(item.name)}</span>
        <span class="ubp-shp-cshop" style="display:block">${escapeHtml(sellerText(item))}</span>
        ${priceHtml(item, line.qty, 'ubp-shp-cprice')}
        <span class="ubp-shp-stepper">
          <i data-ubp-act="qty-dec" data-id="${escapeAttr(item.id)}">−</i><b>${line.qty}</b><i data-ubp-act="qty-inc" data-id="${escapeAttr(item.id)}">＋</i>
        </span>
      </span>
    </div>`;
  }).join('');
  const lines = cart.filter(line => _checked.has(line.item.id));
  const totals = shopCheckoutTotals(lines);
  const totalHtml = totals.map(t => `<div class="ubp-shp-tot"><span>${escapeHtml(t.currencyName)}</span><span class="v">${escapeHtml(fmtQty(t.meta?.precision ?? 0, t.amount))} <small>${escapeHtml(t.currencyName)}</small></span></div>`).join('');
  const badCount = totals.filter(t => !t.enough).length;
  const hint = !lines.length
    ? S('勾选要买的东西', '勾选要买的货品', '勾选要买的货品', '勾选要买的货品')
    : !isCurrencyLinkActive() ? S('未启用货币系统，无法支付', '未启用货币系统，无法支付', '未启用货币系统，无法支付', '未启用货币系统，无法支付')
      : badCount ? `<span style="color:var(--ubp-danger);font-weight:700">${S('有币种余额不足', '有币种余额不足', '有币种余额不足', '有币种余额不足')}</span>`
        : S('余额校验通过', '余额校验通过', '余额校验通过', '余额校验通过');
  const disabled = !lines.length || !isCurrencyLinkActive() || badCount > 0 || _paying;
  return `
    <div class="ubp-shp-pad" style="padding-bottom:0">${rows}
      <div class="ubp-shp-note">${escapeHtml(S('长按可删除；未勾选的行不参与结算。结算后逐件生成订单与备忘录（各自独立的送货日期）。', '长按可删去；未勾选的货品不参与结算。结算后逐件生成契书与备忘录（各自独立的送货日期）。', '长按可删去；未勾选的货品不参与结算。结算后逐件生成契书与备忘录（各自独立的送货日期）。', '长按可删去；未勾选的货品不参与结算。结算后逐件生成契约与备忘录（各自独立的送货日期）。'))}</div>
    </div>
    <div class="ubp-shp-checkout">
      <div class="ubp-shp-totals">${totalHtml || `<div class="ubp-shp-tot"><span>${escapeHtml(spec.cartLabel)}</span><span class="v">0</span></div>`}</div>
      <div class="ubp-shp-payrow">
        <span class="ubp-shp-sum">${S('已选', '已选', '已选', '已选')} <b>${lines.length}</b> ${S('件 · ', '件 · ', '件 · ', '件 · ')}${hint}</span>
        <button class="ubp-shp-btn solid" style="flex:none;padding:0 20px" data-ubp-act="checkout"${disabled ? ' disabled' : ''}>${escapeHtml(_paying ? S('处理中…', '处理中…', '处理中…', '处理中…') : S('结算', '结账', '结账', '结账'))}(${lines.length})</button>
      </div>
    </div>`;
}

/** 我的：头像 + 累计消费 + 余额卡 + 订单（筛选 chips）+ 收藏。 */
function renderMe(): string {
  const data = shopData();
  const spec = shopSpec(currentStyle());
  const roster = getRoster();
  const me = roster.protagonistName || '我';
  const stats = shopStats(data);
  const spentText = Object.keys(stats.spent).length
    ? Object.entries(stats.spent).map(([name, amount]) => {
      const meta = resolveShopCurrency(name);
      return `${fmtQty(meta?.precision ?? 0, amount)} ${name}`;
    }).join(' · ')
    : S('还没有消费', '还没有消费', '还没有消费', '还没有消费');
  const head = `<div class="ubp-shp-mehead">
      ${avatarHtml(me, 'small', true)}
      <div><div class="ubp-shp-mname">${escapeHtml(me)}</div>
        <div class="ubp-shp-mstat">${S('累计消费', '累计花销', '累计花销', '累计花销')}：${escapeHtml(spentText)}<br>
        ${S('已完成订单', '已完成契书', '已完成契书', '已完成契约')} ${stats.delivered} ${S('笔', '笔', '笔', '笔')} · ${S('在途', '在途', '在途', '在途')} ${shopTransitCount(data)} ${S('笔', '笔', '笔', '笔')}</div>
      </div>
    </div>`;
  const addrCard = renderShopAddressCard();
  // 余额卡（主项目货币体系；未启用时只报结果）
  let balCard = '';
  if (isCurrencyLinkActive()) {
    const common = payCommon();
    const rows = payCurrencyList().map(c => `
      <div class="ubp-shp-bal">
        <span class="ubp-shp-bal-ic">${currencyIconSvg(c.icon, 15)}</span>
        <span class="ubp-shp-bal-n">${escapeHtml(c.name)}${common && common.id === c.id ? `<em>${S('常用', '常用', '常用', '常用')}</em>` : ''}</span>
        <span class="ubp-shp-bal-v">${escapeHtml(fmtQty(c.precision, payBalance(c)))}</span>
      </div>`).join('');
    // 卡头只留「余额」二字（用户定案：删净术语解释性文字）
    balCard = `<div class="ubp-shp-balcard">
      <div class="ubp-shp-bt"><span>${S('余额', '余额', '余额', '余额')}</span></div>
      ${rows}
    </div>`;
  } else {
    balCard = `<div class="ubp-shp-balcard">
      <div class="ubp-shp-bt"><span>${S('余额', '余额', '余额', '余额')}</span></div>
      <div class="ubp-shp-note">${S('尚未启用货币，只能浏览，无法支付。', '尚未启用货币，只能浏览，无法支付。', '尚未启用货币，只能浏览，无法支付。', '尚未启用货币，只能浏览，无法支付。')}</div>
    </div>`;
  }
  // 订单（筛选 chips）
  const orders = data.orders;
  const filterChips: Array<{ id: string; label: string }> = [
    { id: '', label: S('全部', '全部', '全部', '全部') },
    { id: 'transit', label: S('运送中', '在途', '在途', '运送中') },
    { id: 'delivered', label: S('已送达', '已送到', '已送到', '已送达') },
    { id: 'cancelled', label: S('已取消', '已作废', '已作废', '已取消') },
  ];
  const chips = filterChips.map(c => `<span class="ubp-shp-chip${_ofilter === c.id ? ' on' : ''}" data-ubp-act="ofilter" data-cat="${escapeAttr(c.id)}">${escapeHtml(c.label)}</span>`).join('');
  const shown = _ofilter ? orders.filter(o => o.status === _ofilter) : orders;
  const orderCards = shown.map(order => {
    const item = order.item;
    const actions: string[] = [];
    if (order.status === 'transit') actions.push(`<span class="ubp-shp-obtn pri" data-ubp-act="cancel-order" data-id="${escapeAttr(order.id)}">${S('取消订单', '作废契书', '作废契书', '取消契约')}</span>`);
    if (order.status !== 'cancelled') actions.push(`<span class="ubp-shp-obtn" data-ubp-act="reorder" data-id="${escapeAttr(order.id)}">${S('再次购买', '再买一次', '再买一次', '再买一次')}</span>`);
    const arriveText = order.status === 'delivered'
      ? `${S('已于', '已于', '已于', '已于')} ${shortStoryDate(order.arriveDate || order.deliveredAt || '')} ${S('送达', '送到', '送到', '送达')}`
      : order.status === 'cancelled'
        ? S('订单已取消，款项已退回', '契书已作废，款项已退回', '契书已作废，款项已退回', '契约已取消，款项已退回')
        : `${S('预计', '约', '约', '约')} ${shortStoryDate(order.arriveDate)} ${S('送达', '送到', '送到', '送达')}`;
    return `<div class="ubp-shp-ocard">
      <div class="ubp-shp-ohead"><span>${escapeHtml(S('订单 · 故事日', '契书 · 故事日', '契书 · 故事日', '契约 · 故事日'))} ${escapeHtml(shortStoryDate(order.orderedAt))}</span><span class="ubp-shp-ostatus ${order.status}">${escapeHtml(orderStatusText(order))}</span></div>
      <div class="ubp-shp-obody" data-ubp-act="order-open" data-id="${escapeAttr(order.id)}">
        <span class="ubp-shp-othumb ${tileClass(item)}">${tileInner(item)}</span>
        <span style="flex:1;min-width:0">
          <span class="ubp-shp-cname" style="display:block">${escapeHtml(item.name)} ×${order.qty}</span>
          <span class="ubp-shp-cshop" style="display:block">${escapeHtml(priceParts(item, order.qty).amount)} ${escapeHtml(order.currencyName)} · ${escapeHtml(sellerText(item))}</span>
          <span class="ubp-shp-cshop${order.status === 'delivered' ? ' ubp-shp-arrive-ok' : ''}" style="display:block;${order.status === 'transit' ? 'color:var(--shp-acc);' : order.status === 'cancelled' ? 'color:var(--ubp-text-3);' : ''}">${escapeHtml(arriveText)}</span>
        </span>
      </div>
      ${actions.length ? `<div class="ubp-shp-oact">${actions.join('')}</div>` : ''}
    </div>`;
  }).join('');
  const ordersBlock = orders.length
    ? `<div class="ubp-shp-sect"><span>${escapeHtml(spec.orderLabel)}</span><span>${orders.length} ${S('笔', '笔', '笔', '笔')}</span></div>
       <div class="ubp-shp-chips" style="padding:0 0 8px">${chips}</div>
       ${orderCards || `<div class="ubp-empty" style="padding:20px">${S('这个状态下没有订单', '此状态下没有契书', '此状态下没有契书', '此状态下没有契约')}</div>`}`
    : `<div class="ubp-shp-sect"><span>${escapeHtml(spec.orderLabel)}</span></div>
       <div class="ubp-empty" style="padding:20px">${S('还没有订单', '还没有契书', '还没有契书', '还没有契约')}</div>`;
  const favs = data.favorites;
  const favBlock = favs.length
    ? `<div class="ubp-shp-sect"><span>${S('我的收藏', '我的收藏', '我的收藏', '我的珍藏')}</span><span>${favs.length} ${S('件 · 不受下架影响', '件 · 不受下架影响', '件 · 不受下架影响', '件 · 不受下架影响')}</span></div>
       <div class="ubp-shp-favstrip">${favs.map(item => `
        <div class="ubp-shp-fcard" data-ubp-act="open-item" data-id="${escapeAttr(item.id)}">
          <div class="ubp-shp-ft ${tileClass(item)}">${tileInner(item)}</div>
          <div class="ubp-shp-fn">${escapeHtml(item.name)}</div>
        </div>`).join('')}</div>`
    : '';
  return `<div class="ubp-shp-pad">${head}${addrCard}${balCard}${ordersBlock}${favBlock}</div>`;
}

/** 订单详情：快照 + 进度（含入库 / 备忘录标记结果）。 */
function renderOrderDetail(): string {
  const data = shopData();
  const order = data.orders.find(o => o.id === _orderId);
  if (!order) { _view = 'tab'; _tab = 'me'; return renderMe(); }
  const item = order.item;
  const steps: string[] = [];
  steps.push(`<div class="ubp-shp-step done"><span class="ubp-shp-stepdot"></span><span>
      <span class="ubp-shp-stept">${S('已下单并支付', '已立契并付讫', '已立契并付讫', '已立约并支付')}</span>
      <span class="ubp-shp-stepd" style="display:block">${escapeHtml(S('故事日', '故事日', '故事日', '故事日'))} ${escapeHtml(shortStoryDate(order.orderedAt))} · ${order.memoTitle ? escapeHtml(S('已记入备忘录', '已记入备忘录', '已记入备忘录', '已记入备忘录')) : escapeHtml(S('备忘未记录', '备忘未记录', '备忘未记录', '备忘未记录'))}</span>
    </span></div>`);
  if (order.status === 'cancelled') {
    steps.push(`<div class="ubp-shp-step done"><span class="ubp-shp-stepdot"></span><span>
        <span class="ubp-shp-stept">${S('订单已取消', '契书已作废', '契书已作废', '契约已取消')}</span>
        <span class="ubp-shp-stepd" style="display:block">${escapeHtml(S('款项已原路退回（钱包流水：商城退款）', '款项已原路退回', '款项已原路退回', '款项已原路退回'))}</span>
      </span></div>`);
  } else {
    steps.push(`<div class="ubp-shp-step${order.status === 'delivered' ? ' done' : ''}"><span class="ubp-shp-stepdot"></span><span>
        <span class="ubp-shp-stept">${order.status === 'delivered' ? escapeHtml(S('包裹已送达', '货已送到', '货已送到', '货箱已送达')) : escapeHtml(S('运送中', '在途', '在途', '运送中'))}</span>
        <span class="ubp-shp-stepd" style="display:block">${escapeHtml(S('预计', '约', '约', '约'))} ${escapeHtml(shortStoryDate(order.arriveDate))} ${escapeHtml(S('送达', '送到', '送到', '送达'))}${order.status === 'delivered' ? ` · ${escapeHtml(S('已入库', '已入库', '已入库', '已入库'))}` : ''}</span>
      </span></div>`);
  }
  const stepHtml = steps.map((s, i) => i === 0 ? s : `<div class="ubp-shp-stepline"></div>${s}`).join('');
  const actions = order.status === 'transit'
    ? `<div class="ubp-shp-oact" style="margin-top:12px"><span class="ubp-shp-obtn pri" data-ubp-act="cancel-order" data-id="${escapeAttr(order.id)}">${S('取消订单并退款', '作废契书并退款', '作废契书并退款', '取消契约并退款')}</span></div>`
    : `<div class="ubp-shp-oact" style="margin-top:12px"><span class="ubp-shp-obtn" data-ubp-act="reorder" data-id="${escapeAttr(order.id)}">${S('再次购买', '再买一次', '再买一次', '再买一次')}</span></div>`;
  return `<div class="ubp-shp-pad">
    <div class="ubp-shp-sec">
      <div class="ubp-shp-obody">
        <span class="ubp-shp-othumb ${tileClass(item)}">${tileInner(item)}</span>
        <span style="flex:1;min-width:0">
          <span class="ubp-shp-cname ubp-shp-cname-lg" style="display:block">${escapeHtml(item.name)} ×${order.qty}</span>
          <span class="ubp-shp-cshop" style="display:block">${escapeHtml(priceParts(item, order.qty).amount)} ${escapeHtml(order.currencyName)}</span>
        </span>
      </div>
    </div>
    <div class="ubp-shp-sect"><span>${S('订单进度', '契书进度', '契书进度', '契约进度')}</span></div>
    <div class="ubp-shp-sec ubp-shp-steps" style="margin-top:0">${stepHtml}</div>
    <div class="ubp-shp-sec">
      <div class="ubp-shp-row"><span class="k">${S('备忘标题', '备忘标题', '备忘标题', '备忘标题')}</span><span class="v">${escapeHtml(order.memoTitle || '—')}</span></div>
      <div class="ubp-shp-row"><span class="k">${S('支付', '支付', '支付', '支付')}</span><span class="v">${escapeHtml(priceParts(item, order.qty).amount)} ${escapeHtml(order.currencyName)}</span></div>
      <div class="ubp-shp-row"><span class="k">${S('店铺', '字号', '商号', '商铺')}</span><span class="v">${escapeHtml(sellerText(item))}</span></div>
      ${item.category ? `<div class="ubp-shp-row"><span class="k">${S('分类', '分类', '分类', '分类')}</span><span class="v">${escapeHtml(item.category)}</span></div>` : ''}
    </div>
    ${actions}
  </div>`;
}

/** 弹层：结算 / 支付成功 / 取消确认。 */
function renderSheet(): string {
  if (!_sheet) return '';
  if (_sheet.kind === 'checkout') {
    const lines = _sheet.lines;
    const totals = shopCheckoutTotals(lines);
    const today = todayStamp();
    const rows = lines.map(line => `<div class="ubp-shp-sline">
        <span class="k">${escapeHtml(line.item.name)}${line.qty > 1 ? ` ×${line.qty}` : ''}</span>
        <span class="v">${escapeHtml(priceParts(line.item, line.qty).amount)} <small>${escapeHtml(line.item.currencyName)}</small></span>
      </div>`).join('');
    const totalsRows = totals.map(t => `<div class="ubp-shp-sline">
        <span class="k">${escapeHtml(t.currencyName)}${S('余额', '余额', '余额', '余额')}</span>
        <span class="v${t.enough ? '' : ' red'}">${escapeHtml(fmtQty(t.meta?.precision ?? 0, t.balance))}<small>${t.meta ? (t.enough ? S('充足', '充足', '充足', '充足') : S('不足', '不足', '不足', '不足')) : S('币种不可用', '币种不可用', '币种不可用', '币种不可用')}</small></span>
      </div>`).join('');
    const arriveRows = lines.map(line => `<div class="ubp-shp-sline">
        <span class="k">${escapeHtml(line.item.name)} ${S('预计送达', '预计送到', '预计送到', '预计送达')}</span>
        <span class="v">${escapeHtml(shopArriveLabel(addDaysLocal(today, line.item.deliveryDays)))}</span>
      </div>`).join('');
    const bad = totals.filter(t => !t.enough);
    const currencyOn = isCurrencyLinkActive();
    const note = !currencyOn
      ? `<div class="ubp-shp-note red">${S('尚未启用货币，无法支付。', '尚未启用货币，无法支付。', '尚未启用货币，无法支付。', '尚未启用货币，无法支付。')}</div>`
      : bad.length
        ? `<div class="ubp-shp-note red">${bad.map(t => `${escapeHtml(t.currencyName)}${S('余额不足：还差', '余额不足：还差', '余额不足：还差', '余额不足：还差')} ${escapeHtml(fmtQty(t.meta?.precision ?? 0, t.amount - t.balance))}`).join('；')}</div>`
        : `<div class="ubp-shp-note">${S('支付后逐件生成订单与备忘录；送达日当天由手机日程提醒自动提示。', '支付后逐件生成契书与备忘录；送达日当天由手机日程提醒自动提示。', '支付后逐件生成契书与备忘录；送达日当天由手机日程提醒自动提示。', '支付后逐件生成契约与备忘录；送达日当天由手机日程提醒自动提示。')}</div>`;
    const disabled = !currencyOn || bad.length > 0 || _paying || shopCheckoutBusy();
    return `<div class="ubp-shp-dim" data-ubp-act="sheet-close-bg">
      <div class="ubp-shp-sheet" data-sheet-body>
        <div class="ubp-shp-sheet-t">${S('确认订单', '确认契书', '确认契书', '确认契约')}</div>
        <div class="ubp-shp-sheet-sub">${S('共', '共', '共', '共')} ${lines.length} ${S('件商品 · 支付后将逐件记入备忘录', '件货品 · 支付后将逐件记入备忘录', '件货品 · 支付后将逐件记入备忘录', '件货品 · 支付后将逐件记入备忘录')}</div>
        ${renderShopCheckoutAddressRow()}
        ${rows}${totalsRows}${arriveRows}${note}
        <div class="ubp-shp-payrow" style="margin-top:12px">
          <button class="ubp-shp-btn" data-ubp-act="sheet-close">${S('再看看', '再看看', '再看看', '再看看')}</button>
          <button class="ubp-shp-btn solid" data-ubp-act="pay-confirm"${disabled ? ' disabled' : ''}>${escapeHtml(_paying ? S('支付中…', '支付中…', '支付中…', '支付中…') : S('确认支付', '确认付讫', '确认付讫', '确认支付'))}</button>
        </div>
      </div>
    </div>`;
  }
  if (_sheet.kind === 'success') {
    const orders = _sheet.orders;
    const first = orders[0];
    const lines = orders.map(o => `<div class="ubp-shp-sline">
        <span class="k">${escapeHtml(o.item.name)}${o.qty > 1 ? ` ×${o.qty}` : ''}</span>
        <span class="v">${escapeHtml(shopArriveLabel(o.arriveDate))} ${S('送达', '送到', '送到', '送达')}</span>
      </div>`).join('');
    const memoNote = _sheet.memoFail > 0
      ? `<div class="ubp-shp-note red">${S('有', '有', '有', '有')} ${_sheet.memoFail} ${S('件未能记入备忘录（不影响订单）', '件未能记入备忘录（不影响契书）', '件未能记入备忘录（不影响契书）', '件未能记入备忘录（不影响契约）')}</div>`
      : `<div class="ubp-shp-note">${S('已记入主项目备忘录，可在备忘录表查看；送达日当天由手机日程提醒自动提示。', '已记入主项目备忘录；送达日当天由手机日程提醒自动提示。', '已记入主项目备忘录；送达日当天由手机日程提醒自动提示。', '已记入主项目备忘录；送达日当天由手机日程提醒自动提示。')}</div>`;
    return `<div class="ubp-shp-dim" data-ubp-act="sheet-close-bg">
      <div class="ubp-shp-sheet center" data-sheet-body>
        <div class="ubp-shp-okmark">✓</div>
        <div class="ubp-shp-sheet-t">${S('支付成功 · 掌柜已接单', '付讫 · 阁主已备货', '付讫 · 掌柜已接单', '支付成功 · 商队已接单')}</div>
        <div class="ubp-shp-sheet-sub">${first ? `${escapeHtml(first.item.name)}${first.qty > 1 ? ` ×${first.qty}` : ''} · ${escapeHtml(priceParts(first.item, first.qty).amount)} ${escapeHtml(first.currencyName)}` : ''}</div>
        ${lines}${memoNote}
        <div class="ubp-shp-payrow" style="margin-top:12px">
          <button class="ubp-shp-btn" data-ubp-act="sheet-close">${S('继续逛', '继续逛', '继续逛', '继续逛')}</button>
          <button class="ubp-shp-btn solid" data-ubp-act="goto-orders">${S('查看订单', '查看契书', '查看契书', '查看契约')}</button>
        </div>
      </div>
    </div>`;
  }
  const orderId = _sheet.kind === 'cancel' ? _sheet.orderId : '';
  const cancelOrder = shopData().orders.find(o => o.id === orderId);
  return `<div class="ubp-shp-dim" data-ubp-act="sheet-close-bg">
      <div class="ubp-shp-sheet center" data-sheet-body>
        <div class="ubp-shp-sheet-t">${S('取消订单？', '作废契书？', '作废契书？', '取消契约？')}</div>
        <div class="ubp-shp-sheet-sub">${escapeHtml(cancelOrder?.item.name || '')}</div>
        <div class="ubp-shp-note">${S('取消后款项原路退回（钱包流水记「商城退款」），备忘录标记为「已取消」。', '取消后款项原路退回，备忘录标记为「已取消」。', '取消后款项原路退回，备忘录标记为「已取消」。', '取消后款项原路退回，备忘录标记为「已取消」。')}</div>
        <div class="ubp-shp-payrow" style="margin-top:12px">
          <button class="ubp-shp-btn" data-ubp-act="sheet-close">${S('再想想', '再想想', '再想想', '再想想')}</button>
          <button class="ubp-shp-btn solid" data-ubp-act="cancel-confirm" data-id="${escapeAttr(orderId)}">${S('确认取消', '确认作废', '确认作废', '确认取消')}</button>
        </div>
      </div>
    </div>`;
}

/** 送达日计算（弹层预览用；与引擎 addDays 同口径的最小实现，避免把 phone-schedule 拉进渲染层）。 */
function addDaysLocal(date: string, n: number): string {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ─── 动作 ───

function checkedLines(): ShopCartLine[] {
  return shopData().cart.filter(line => _checked.has(line.item.id));
}

/**
 * 发起一次上货。
 * ★ 收尾纪律（2026-10-06 修）：一次上货要花一整发 AI 请求，**结果不因 App 被卸载而丢**——
 *   用户点了刷新去逛别的（App 卸载 / 关小手机）是常态，旧写法「await 回来先判 _ctx，卸载即 return」
 *   会把整批货连错误提示一起吞掉，表现为「AI 明明出货了，商城没更新也没报错」。
 *   现在的口径与全机一致（call-voicemail / app-wechat）：**只按聊天归属丢弃**（切聊天才丢，防写进新聊天），
 *   UI 反馈（渲染 + toast）才看 _ctx；失败原因留在 _error 里，回来那一刻仍能看见并可重试。
 */
function startRefresh(extraHint = ''): void {
  if (_generating) return;
  const owner = currentPhoneStorageId(); // 聊天归属守卫：发起时快照
  const seq = ++_refreshSeq;
  _generating = true;
  _error = '';
  _errorOwner = '';
  setShopGenActivity(true); // 灵动岛「上货中」（跨 App 卸载保留：去逛别的照样亮着）
  render();
  void (async () => {
    try {
      const res = await refreshShopCatalog(extraHint ? { extraPrompt: extraHint } : {});
      if (seq === _refreshSeq) { _generating = false; setShopGenActivity(false); } // 闸门/岛只由「当前这一次」解除
      if (currentPhoneStorageId() !== owner) return; // 已切聊天：这批货不属于当前聊天，整批丢弃
      const storyDate = todayStamp();
      const maxItems = shopMaxItemsSetting();
      let addedCount = 0;
      let firstAddedName = '';
      mutatePhoneData(d => {
        const base = d.shop || emptyShopData();
        const applied = applyShopRefresh(base, res.items, maxItems, storyDate);
        addedCount = applied.added.length;
        firstAddedName = applied.added[0]?.name || '';
        // 上货完成回执：通知中心据此出一条「已上架 N 件」（看过即清，不新造已读状态）
        d.shop = addedCount > 0
          ? { ...applied.data, lastRestock: { count: addedCount, storyTime: storyDate, at: Date.now() } }
          : applied.data;
      });
      _error = '';
      _errorOwner = '';
      emitAch('phone_shop_refreshed', { added: addedCount }); // L21：玩家点刷新且本次成功收尾
      emitPhoneEvent('ubp-phone:data-changed'); // 角标/通知中心刷新与挂载无关
      // 通知横幅（用户定案）：与挂载无关——去逛别的/关着手机也能收到；点横幅即开商城
      if (addedCount > 0) {
        emitPhoneNotify({
          appId: 'shop',
          title: S(`已上架 ${addedCount} 件新货`, `已备好 ${addedCount} 件新货`, `已张罗 ${addedCount} 件新货`, `已进 ${addedCount} 件新货`),
          text: addedCount === 1 && firstAddedName ? firstAddedName : S('点开看看这次到了什么', '点开看看这次到了什么', '点开看看这次到了什么', '点开看看这次到了什么'),
        });
      }
      if (addedCount > 0) pumpAutoImages(); // 新货进店即补图（自动生图开启时；与挂载同一条管线）
      if (!_ctx) return; // 期间被卸载：货已上架（回来即见），只是少一次 toast
      render();
      const droppedNote = res.dropped > 0 ? S(`（${res.dropped} 件因币种/格式无效被忽略）`, `（${res.dropped} 件因币种/格式无效被忽略）`, `（${res.dropped} 件因币种/格式无效被忽略）`, `（${res.dropped} 件因币种/格式无效被忽略）`) : '';
      showScreenToast(_ctx.container, addedCount
        ? S(`已上架 ${addedCount} 件新货${droppedNote}`, `已上架 ${addedCount} 件新货${droppedNote}`, `已上架 ${addedCount} 件新货${droppedNote}`, `已上架 ${addedCount} 件新货${droppedNote}`)
        : S(`没有新货上架（与现有货架重名）${droppedNote}`, `没有新货上架（与现有货架重名）${droppedNote}`, `没有新货上架（与现有货架重名）${droppedNote}`, `没有新货上架（与现有货架重名）${droppedNote}`));
    } catch (e) {
      if (seq === _refreshSeq) { _generating = false; setShopGenActivity(false); }
      // 用户按过「取消」（seq 已推进）或已切聊天：这一发的失败原因不该弹到眼前/落到新聊天
      if (seq !== _refreshSeq || currentPhoneStorageId() !== owner) return;
      if (isPhoneAbortError(e)) { _generating = false; setShopGenActivity(false); _error = ''; render(); return; }
      _error = e instanceof Error ? e.message : String(e);
      _errorOwner = owner;
      render(); // 未挂载时 render 自身早退；错误留在状态里，回来那一刻显示
    }
  })();
}

/** 货架上限（设置项；越界钳制与 normalize 同口径）。 */
function shopMaxItemsSetting(): number {
  const s = getPhoneSettings();
  return Math.max(20, Math.min(100, Math.floor(Number(s.shopMaxItems) || 40)));
}

/**
 * 打开结算弹层（**只开单、不扣款**——规格 §10.5：弹层里的「确认支付」才是付款那一步，
 * 用户必须能在这一步反悔退出。旧实现把两步并成一步＝点「立即购买」直接扣钱，与规格不符）。
 */
function openCheckoutSheet(lines: ShopCartLine[], via: 'cart' | 'buy' = 'cart'): void {
  if (!lines.length || _paying) return;
  syncCheckoutAddress(); // 本单地址回落到默认地址（上一次选的只作用于上一单）
  _sheet = { kind: 'checkout', lines, via };
  render();
}

/** 真正付款（只由「确认支付」触发）：扣款 → 建单 → 备忘 → 成功/失败弹层。 */
function runCheckout(lines: ShopCartLine[]): void {
  if (!lines.length || _paying) return;
  _paying = true;
  render(); // 按钮转「支付中…」并禁用（防双击双扣）
  void (async () => {
    try {
      const via = _sheet?.kind === 'checkout' ? _sheet.via : 'cart';
      const outcome = await checkoutShopLines(lines);
      _paying = false;
      for (const line of lines) _checked.delete(line.item.id);
      if (outcome.orders.length) {
        emitAch('phone_shop_order_placed', { lines: outcome.orders.length, via }); // L21：支付确认成功那一下
        _sheet = { kind: 'success', orders: outcome.orders, memoFail: outcome.memoFailures };
      } else {
        _sheet = null;
        if (_ctx) showScreenToast(_ctx.container, outcome.failures[0]?.error || S('支付失败', '支付失败', '支付失败', '支付失败'));
      }
      if (outcome.failures.length && outcome.orders.length && _ctx) {
        showScreenToast(_ctx.container, S(`${outcome.orders.length} 件已下单，${outcome.failures.length} 件未成功`, `${outcome.orders.length} 件已下单，${outcome.failures.length} 件未成功`, `${outcome.orders.length} 件已下单，${outcome.failures.length} 件未成功`, `${outcome.orders.length} 件已下单，${outcome.failures.length} 件未成功`));
      }
      emitPhoneEvent('ubp-phone:data-changed');
      render();
    } finally {
      _paying = false;
    }
  })();
}

function doCancelOrder(orderId: string): void {
  void (async () => {
    const res = await cancelShopOrder(orderId);
    if (res.ok) emitAch('phone_shop_order_cancelled', {}); // L21
    _sheet = null;
    if (_ctx) showScreenToast(_ctx.container, res.ok
      ? S('订单已取消，款项已退回', '契书已作废，款项已退回', '契书已作废，款项已退回', '契约已取消，款项已退回')
      : (res.error || S('取消失败', '作废失败', '作废失败', '取消失败')));
    emitPhoneEvent('ubp-phone:data-changed');
    render();
  })();
}

// ─── 商家会话（docs/54）：进入 / 离开 / 菜单 / 深链 ───

/** 会话快照（顶栏副标题用；找不到返回 null）。 */
function shopChatThreadsSnapshot(): ShopThread | null {
  const id = shopChatThreadId();
  if (!id) return null;
  return (shopData().threads || []).find(t => t.id === id) || null;
}

/** 从商品详情 / 商品卡进入会话。 */
function enterShopChat(seller: string, itemId = '', backTo: 'detail' | 'tab' = 'detail'): void {
  if (!seller) return;
  const fromDetail = backTo === 'detail' && Boolean(_detailId);
  openShopChat(seller, { itemId, backTo: fromDetail ? 'detail' : 'tab' });
  _view = 'chat';
  emitPhoneEvent('ubp-phone:data-changed');
  render();
  pumpChatImages();
}

/** 会话页返回：从详情进来的回详情，否则回消息列表。 */
export function leaveShopChat(): void {
  const back = shopChatBackTarget();
  const fromItem = shopChatFromItemId();
  closeShopChat();
  if (back === 'detail' && fromItem) {
    _detailId = fromItem;
    _view = 'detail';
  } else {
    _view = 'tab';
    _tab = 'msg';
  }
  render();
}

/** 会话 ⋯ 菜单：清空记录 / 删除会话（与长按同一套动作面板，入口两处）。 */
function openChatMenu(): void {
  const container = _ctx?.container;
  const thread = shopChatThreadsSnapshot();
  if (!container || !thread) return;
  const seller = thread.seller;
  const threadId = thread.id;
  openActionSheet(container, {
    title: seller,
    actions: [
      { label: S('清空聊天记录', '清空符讯往来', '清空书信往来', '清空晶讯往来'), onPick: () => {
        clearShopThread(threadId, false);
        emitPhoneEvent('ubp-phone:data-changed');
        render();
      } },
      { label: S('删除会话', '删除往来', '删除往来', '删除往来'), tone: 'danger' as const, onPick: () => {
        clearShopThread(threadId, true);
        leaveShopChat();
      } },
      { label: S('取消', '作罢', '作罢', '作罢'), onPick: () => { /* 关闭 */ } },
    ],
  });
}

/** 进会话补一次自动生图（自动开关关=零开销）。 */
function pumpChatImages(): void {
  const id = shopChatThreadId();
  if (!id) return;
  pumpShopChatImages(id);
}

/** 长按提示的可发现性后缀（全机同款写法：按钮 title 里点明「长按可加提示」）。 */
function refreshHintSuffix(): string {
  return S('（长按可加提示）', '（长按可加提点）', '（长按可加提点）', '（长按可加提点）');
}

/**
 * 长按刷新钮 → 「本次上货提示」弹层（全机统一的一次性提示件，同微信生成条 ⋯/窥私生成/社媒刷新）。
 * 提示只作用于这一次上货：进指令的「额外要求（优先满足）」段 + 触发注入语料（提到的人名/物名
 * 照样激活世界书条目），不落设置、不改下次默认。
 */
function openRefreshHint(): void {
  if (!_ctx || _generating) return;
  openOneShotHintSheet(_ctx.container, {
    title: S('本次上货提示', '本次采买提示', '本次张罗提示', '本次进货提示'),
    confirmLabel: S('上货', '采买', '张罗', '进货'),
    onConfirm: hint => { startRefresh(hint); },
  });
}

/**
 * 进店自动补图（用户定案：自动生图设置必须对商城生效）。闸门/就绪/串行/归属守卫都在 core；
 * 这里只负责「什么时候跑」与「跑完补渲」——挂载时、上货完成后各一次（幂等：同一时刻只跑一轮）。
 */
function pumpAutoImages(): void {
  void autoGenerateShopImages(() => { if (_ctx) render(); }).then(res => {
    if (res.generated && _ctx) render(); // 兜一次收尾（图一张张出现已在 onProgress 里补渲）
  }).catch(() => undefined);
}

function runItemImage(itemId: string): void {
  // 在跑（本地手动闸）或已在本批自动补图队列里：不重复下单（UI 侧 busy 已挡，这里是兜底）
  if (_imgBusy.has(itemId) || shopItemImageBusy(itemId)) return;
  _imgBusy.add(itemId);
  const job = generateShopItemImage(itemId); // 同步前缀已把该件标 busy
  render(); // 开工即补渲：主图区与卡片图块立刻换上「生成中」转圈（与其他 App 同一表征）
  void job.then(outcome => {
    _imgBusy.delete(itemId);
    if (!outcome.ok && _ctx) showScreenToast(_ctx.container, outcome.error);
    render();
  });
}

/** 购物车行长按：删除该行（确认）。 */
function confirmRemoveCartLine(itemId: string): void {
  const container = _ctx?.container;
  const line = shopData().cart.find(l => l.item.id === itemId);
  if (!container || !line) return;
  openConfirmSheet(container, {
    title: S('从购物车删除？', '从储物袋里取出？', '从货担里取出？', '从行囊里取出？'),
    message: line.item.name,
    confirmLabel: S('删除', '删去', '删去', '删去'),
    onConfirm: () => {
      mutatePhoneData(d => {
        const base = d.shop || emptyShopData();
        d.shop = cartRemove(base, itemId);
      });
      _checked.delete(itemId);
      render();
    },
  });
}

/**
 * 商品卡 / 收藏卡长按：删除这件商品（确认弹层对齐全机「长按行出确认」口径）。
 * 货架 + 收藏 + 购物车三处一并清除（订单快照与已入库物品不受影响）；在收藏/购物车里时正文补一句说明。
 */
function confirmRemoveShopItem(itemId: string): void {
  const container = _ctx?.container;
  const item = itemById(itemId);
  if (!container || !item) return;
  const data = shopData();
  const key = shopItemKey(item.name);
  const alsoHeld = isFavorited(data, item)
    || (data.cart || []).some(line => line.item.id === item.id || shopItemKey(line.item.name) === key);
  openConfirmSheet(container, {
    title: S('删除这件商品？', '删除这件货品？', '删除这件货品？', '删除这件商品？'),
    message: alsoHeld
      ? `${item.name}　${S('同时会从收藏与购物车移除；订单记录不受影响。', '同时会从宝囊与储物袋移除；契书记录不受影响。', '同时会从收藏与货担移除；契书记录不受影响。', '同时会从珍藏与行囊移除；契约记录不受影响。')}`
      : item.name,
    confirmLabel: S('删除', '删去', '删去', '删去'),
    onConfirm: () => {
      mutatePhoneData(d => {
        const base = d.shop || emptyShopData();
        d.shop = removeShopItem(base, item);
      });
      _checked.delete(item.id); // 购物车里的勾选残留一并清掉（与购物车行删除同款）
      emitPhoneEvent('ubp-phone:data-changed');
      render();
      if (_ctx) showScreenToast(_ctx.container, S(`已删除：${item.name}`, `已删去：${item.name}`, `已删去：${item.name}`, `已删去：${item.name}`));
    },
  });
}

function handleClick(event: Event): void {
  // 长按残留 click 一律吞掉（对齐窥私/电话/微信做法）：否则长按刷新开提示弹层后，
  // 松手那一下会再命中 [data-ubp-act="refresh"] → 不带提示地直接上货一次
  if (Date.now() - _longPressFiredAt.at < 600) return;
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const id = el.dataset.id || '';
  // 会话列表点行：视图切换归本文件（模块只负责会话数据），所以在这里先接
  if (act === 'shc-open') {
    enterShopChat(el.dataset.seller || '', '', 'tab');
    return;
  }
  // 商家消息模块先接（弹层/会话/评价/地址全在那边；未命中再走本文件的动作）
  if (act.startsWith('shc-') && handleShopChatAct(act, el, event)) return;
  if (act === 'back') {
    if (_view === 'chat') { leaveShopChat(); return; }
    if (_view === 'detail' || _view === 'order') { _view = 'tab'; _detailId = ''; _orderId = ''; render(); return; }
    if (_tab !== 'home') { _tab = 'home'; render(); return; }
    _ctx?.closeApp();
    return;
  }
  if (act === 'tab') {
    const next = (el.dataset.tab || 'home') as ShopTab;
    _tab = next;
    _view = 'tab';
    render();
    return;
  }
  if (act === 'refresh') { startRefresh(); return; }
  if (act === 'abort') {
    const stopped = abortShopGeneration();
    _refreshSeq += 1; // 使在途那一发的收尾失效：中止后不该再弹「AI 请求失败」红条
    _generating = false;
    render();
    if (_ctx) showScreenToast(_ctx.container, stopped ? S('已取消', '已取消', '已取消', '已取消') : S('这次上货已经不在了', '这次上货已经不在了', '这次上货已经不在了', '这次上货已经不在了'));
    return;
  }
  if (act === 'filter') {
    _filter = el.dataset.cat || '';
    render();
    return;
  }
  if (act === 'ofilter') {
    _ofilter = el.dataset.cat || '';
    render();
    return;
  }
  if (act === 'open-item') {
    _detailId = id;
    _view = 'detail';
    render();
    return;
  }
  if (act === 'shop-msg') {
    enterShopChat(el.dataset.seller || '', id);
    return;
  }
  if (act === 'chat-menu') {
    openChatMenu();
    return;
  }
  if (act === 'order-open') {
    _orderId = id;
    _view = 'order';
    render();
    return;
  }
  if (act === 'fav') {
    const item = itemById(id);
    if (!item) return;
    const wasFav = shopData().favorites.some(f => f.id === id);
    mutatePhoneData(d => {
      const base = d.shop || emptyShopData();
      d.shop = toggleFavorite(base, item);
    });
    if (!wasFav) emitAch('phone_shop_fav_added', {}); // L21：只记「收藏上」那一向
    emitPhoneEvent('ubp-phone:data-changed');
    render();
    return;
  }
  if (act === 'cart-add') {
    const item = itemById(id);
    if (!item) return;
    mutatePhoneData(d => {
      const base = d.shop || emptyShopData();
      d.shop = cartAdd(base, item, 1);
    });
    emitAch('phone_shop_cart_added', {}); // L21
    if (_ctx) showScreenToast(_ctx.container, S(`已加入购物车：${item.name}`, `已放进储物袋：${item.name}`, `已放进货担：${item.name}`, `已放进行囊：${item.name}`));
    emitPhoneEvent('ubp-phone:data-changed');
    render();
    return;
  }
  if (act === 'buy-now') {
    const item = itemById(id);
    if (!item) return;
    openCheckoutSheet([{ item, qty: 1, addedAt: item.addedAt }], 'buy');
    return;
  }
  if (act === 'gen-image') { runItemImage(id); return; }
  if (act === 'ck') {
    if (_checked.has(id)) _checked.delete(id);
    else _checked.add(id);
    render();
    return;
  }
  if (act === 'qty-dec' || act === 'qty-inc') {
    const line = shopData().cart.find(l => l.item.id === id);
    if (!line) return;
    const next = line.qty + (act === 'qty-inc' ? 1 : -1);
    if (next < 1) { confirmRemoveCartLine(id); return; }
    mutatePhoneData(d => {
      const base = d.shop || emptyShopData();
      d.shop = cartSetQty(base, id, next);
    });
    render();
    return;
  }
  if (act === 'checkout') { openCheckoutSheet(checkedLines()); return; }
  if (act === 'pay-confirm') {
    if (_sheet?.kind !== 'checkout') return;
    runCheckout(_sheet.lines);
    return;
  }
  if (act === 'sheet-close') { _sheet = null; render(); return; }
  if (act === 'sheet-close-bg') {
    // 点遮罩关闭；点面板内部不关（closest 命中 data-sheet-body 时忽略）
    if ((event.target as HTMLElement).closest('[data-sheet-body]')) return;
    _sheet = null;
    render();
    return;
  }
  if (act === 'goto-orders') {
    _sheet = null;
    _view = 'tab';
    _tab = 'me';
    _filter = '';
    render();
    return;
  }
  if (act === 'cancel-order') {
    _sheet = { kind: 'cancel', orderId: id };
    render();
    return;
  }
  if (act === 'cancel-confirm') {
    if (id) doCancelOrder(id);
    return;
  }
  if (act === 'reorder') {
    const ok = reorderShopOrder(id);
    if (ok) emitAch('phone_shop_reordered', {}); // L21
    if (_ctx) showScreenToast(_ctx.container, ok
      ? S('已放回购物车', '已放回储物袋', '已放回货担', '已放回行囊')
      : S('订单不存在', '契书不存在', '契书不存在', '契约不存在'));
    emitPhoneEvent('ubp-phone:data-changed');
    render();
    return;
  }
  if (act === 'menu') {
    const container = _ctx?.container;
    if (!container) return;
    openActionSheet(container, {
      title: appName(),
      message: S('商城数据随聊天存档保存。', '商城数据随聊天存档保存。', '商城数据随聊天存档保存。', '商城数据随聊天存档保存。'),
      actions: [
        { label: S('清空购物车', '清空储物袋', '清空货担', '清空行囊'), tone: 'danger' as const, onPick: () => {
          openConfirmSheet(container, {
            title: S('清空购物车？', '清空储物袋？', '清空货担？', '清空行囊？'),
            message: S('只清空未结算的商品，不影响订单与收藏。', '只清空未结算的货品，不影响契书与收藏。', '只清空未结算的货品，不影响契书与收藏。', '只清空未结算的货品，不影响契约与收藏。'),
            confirmLabel: S('清空', '清空', '清空', '清空'),
            onConfirm: () => {
              mutatePhoneData(d => {
                const base = d.shop || emptyShopData();
                d.shop = { ...base, cart: [] };
              });
              _checked.clear();
              render();
            },
          });
        } },
        { label: S('取消', '作罢', '作罢', '作罢'), onPick: () => { /* 关闭 */ } },
      ],
    });
    return;
  }
}

export const shopApp: PhoneApp = {
  id: 'shop',
  name: '商城',
  icon: ubpIcon('shop'),
  color: '#FF6A00',
  available: true,
  closeTopOverlay(): boolean {
    if (closeShopChatSheet()) { render(); return true; }
    if (_sheet) { _sheet = null; render(); return true; }
    if (_view === 'chat') { leaveShopChat(); return true; }
    if (_view === 'detail' || _view === 'order') { _view = 'tab'; _detailId = ''; _orderId = ''; render(); return true; }
    if (_tab !== 'home') { _tab = 'home'; render(); return true; }
    return false;
  },
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _tab = 'home';
    _view = 'tab';
    _detailId = '';
    _orderId = '';
    _filter = '';
    _ofilter = '';
    // 生成中与失败原因都跨「App 卸载」保留：点刷新后去逛别的再回来，骨架屏/失败提示仍在
    //（_generating 不重置：在途那一次回来照样收尾；真卡住了页内「取消」可随时解闸）。
    // 但失败原因属于**别的聊天**时清掉——换聊天后不该看到上一个聊天的报错。
    if (_errorOwner && _errorOwner !== currentPhoneStorageId()) { _error = ''; _errorOwner = ''; }
    _sheet = null;
    _checked.clear();
    _imgBusy.clear();
    _scroll.clear();
    // 打开商城 = 看过（用户返修定案 2026-10-06）：已送达包裹（order.seen）与上架回执一并归零，
    // 通知中心里那两条随之消失——复用通知中心的同一已读入口（clearPhoneNotificationsFor('shop')），
    // 与「打开电话 App 即清未接」同口径。**商家会话未读不在此列**（进会话才清，见 shop-chat.markShopThreadRead）。
    // 先于下面的送达结算执行：本次打开若刚好结算出新包裹，那条仍算未读（角标/通知中心照常出现）。
    if (clearPhoneNotificationsFor('shop')) emitPhoneEvent('ubp-phone:data-changed');
    // 全局搜索 / 编年史深链：商品 id 直达详情；订单 id（sho_ 前缀）直达订单详情
    // （openApp 恒为卸载再挂载 ⇒ 首帧消费一次即可）
    const target = takePendingAppTarget('shop');
    if (target) {
      if (target.startsWith('sho_')) {
        if ((shopData().orders || []).some(o => o.id === target)) { _orderId = target; _view = 'order'; }
      } else if (target.startsWith('thr_')) {
        const thread = (shopData().threads || []).find(t => t.id === target);
        if (thread) {
          openShopChat(thread.seller, { backTo: 'tab' });
          _view = 'chat';
        }
      } else {
        const item = itemById(target);
        if (item) { _detailId = target; _view = 'detail'; }
      }
    }
    // 商家会话（docs/54）：绑宿主（会话模块整块在 renderers/shop-chat）+ 深链消费
    bindShopChatHost(ctx, () => render());
    const onInput = (event: Event): void => shopChatInputHandler(event);
    const onKey = (event: KeyboardEvent): void => {
      // F76：商城自绘弹层（结算/支付成功/取消订单/发红包/选地址/写评价/选地点）补 ESC 关闭——
      // 与返回键 closeTopOverlay 同序（会话弹层最上 → 商城弹层），点按钮/点背景之外的第三通道。
      if (event.key === 'Escape') {
        // 逐层关：先会话弹层（最上），再商城弹层——两层同时开（如结算里选地址）时只关最上面那层。
        if (closeShopChatSheet()) { event.stopPropagation(); event.preventDefault(); render(); return; }
        if (_sheet) { event.stopPropagation(); event.preventDefault(); _sheet = null; render(); return; }
        return;
      }
      shopChatKeyHandler(event);
    };
    ctx.container.addEventListener('input', onInput);
    ctx.container.addEventListener('keydown', onKey);
    // 商品卡/改价卡点开 → 本 App 切到商品详情（返回时回到会话）
    const onOpenItem = (event: Event): void => {
      const itemId = (event as CustomEvent<{ id?: string }>).detail?.id || '';
      if (!itemId || _view !== 'chat') return;
      const item = itemById(itemId);
      if (!item) return;
      _detailId = itemId;
      _view = 'detail';
      render();
    };
    ctx.container.addEventListener('ubp-shop-open-item', onOpenItem);
    ctx.container.addEventListener('click', handleClick);
    const unbindLongPress = bindHintLongPress(ctx.container, t => {
      if (ctx.container.querySelector('.ubp-overlay') || ctx.container.querySelector('.ubp-shp-dim')) return null;
      const chatHit = shopChatLongPressTarget(t);
      if (chatHit) return chatHit;
      // 长按刷新（含空态「请掌柜上货」/失败态「重试」——同一个 act）= 本次上货提示（全机统一的一次性提示件）
      const refreshBtn = t.closest('[data-ubp-act="refresh"]') as HTMLElement | null;
      if (refreshBtn) return { el: refreshBtn, fire: () => { _longPressFiredAt.at = Date.now(); openRefreshHint(); } };
      // 商品卡 / 收藏卡长按 = 删除这件商品（货架+收藏+购物车一并清除；确认弹层防误删）
      const card = t.closest('.ubp-shp-card, .ubp-shp-fcard') as HTMLElement | null;
      const cardId = card?.dataset.id || '';
      if (card && cardId) return { el: card, fire: () => { _longPressFiredAt.at = Date.now(); confirmRemoveShopItem(cardId); } };
      const row = t.closest('[data-cart-row]') as HTMLElement | null;
      const id = row?.dataset.cartRow || '';
      if (!row || !id) return null;
      return { el: row, fire: () => { _longPressFiredAt.at = Date.now(); confirmRemoveCartLine(id); } };
    });
    render();
    // 打开即送达结算（幂等；无在途订单零开销）——结算成功刷新角标与列表
    void settleShopOrders().then(res => {
      if (!_ctx) return;
      if (res.settled) { emitPhoneEvent('ubp-phone:data-changed'); render(); }
    }).catch(() => undefined);
    pumpAutoImages(); // 进店自动补图（自动生图开关关=零开销；失败件不自动重试）
    for (const t of shopData().threads || []) pumpShopChatImages(t.id); // 商家会话里的待生图消息同样补一轮
    if (target && !_detailId && !_orderId) showScreenToast(ctx.container, S('原商品已不在货架上', '原货品已不在货架上', '原货品已不在货架上', '原货品已不在货栈里'));
    return () => {
      ctx.container.removeEventListener('click', handleClick);
      ctx.container.removeEventListener('input', onInput);
      ctx.container.removeEventListener('keydown', onKey);
      ctx.container.removeEventListener('ubp-shop-open-item', onOpenItem);
      unbindLongPress();
      unbindShopChatHost(); // 生成照跑：模块态保留，回来即见
      ctx.container.classList.remove('ubp-shp-scope');
      _ctx = null;
    };
  },
};
