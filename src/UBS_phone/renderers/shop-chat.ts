// ===== 商城消息（商家沟通）· 渲染层（docs/54）=====
// 一个 module 收三块 UI（都由 app-shop 的容器承载，避免 app-shop 继续膨胀）：
//   ① 消息 tab（会话列表：一家店一条）；
//   ② 聊天页（气泡 / 四类富媒体卡片 / 输入区：咨询条 + 生成条 + ＋面板 + 输入框）；
//   ③ 附带件：商品详情的评价区与写评价弹层、我的页收货地址卡与地址簿弹层、结算弹层的收货地址行。
//
// 纪律（与全机一致）：
//   · **全量重绘 + 滚动保位**（聊天页滚动由 app-shop 统一处理：同会话且消息数没变=保位，否则贴底）；
//     输入框草稿与弹层表单存在模块态里，重绘不丢；
//   · **容器级 click 委托**（app-shop 的 handleClick 把 data-ubp-act 转进来）+ 长按由 app-shop 的 bindHintLongPress 转进来；
//   · 生成中不重绘输入区（防吞字），状态跨 App 卸载保留（_busy 不随 mount 重置，只按聊天归属清理）；
//   · 版式逐条对齐 docs/54 mockup（就是「像素级一致」的那一份）。
//
// 归属守卫：一次生成要花一整发 AI 请求，结果不因 App 卸载而丢——只按**聊天归属**丢弃（切聊天即整批丢弃）。

import { S, currentStyle } from '../core/skins';
import { escapeAttr, escapeHtml } from '../core/ubp-utils';
import { getRoster } from '../core/roster';
import { currentPhoneStorageId, mutatePhoneData, readPhoneDataRef } from '../core/phone-store';
import { selfStamp } from '../core/social-time';
import { addPhoneAlbumEntries, makeAlbumEntryId } from '../core/phone-album';
import { generatePhoneImage, MAX_AUTO_IMAGES_PER_BATCH } from '../core/chat-images';
import { getPhoneSettings } from '../core/phone-settings';
import { readPhoneMapLocations, type PhoneMapLocation } from '../core/map-locations';
import { emptyShopData, type ShopData, type ShopItem } from '../core/shop-model';
import {
  buildShopTextMessage, canReviewItem, defaultShopAddress, ensureShopThread, findShopReview,
  makeShopAddressId, makeShopReviewId, shopItemStatus, shopItemStatusLabel, shopMessagePreview,
  shopThreadLastMessage, shopThreadUnreadTotal, upsertShopAddress, upsertShopReview,
  MAX_SHOP_REVIEW_IMAGES, MAX_SHOP_REVIEW_TEXT, type ShopAddress, type ShopMessage,
  type ShopMyReview, type ShopThread,
} from '../core/shop-chat-model';
import {
  abortShopChatGeneration, applyShopChatReply, buildShopChatContext, claimShopRedPacket, clearShopThread,
  generateShopChatReply, markShopThreadRead, sendShopRedPacket, sendShopUserMessage, setShopThreadDraft,
  setShopThreadFocus, shopChatGenerating, shopTrailingUserBatch,
} from '../core/shop-chat-engine';
import { fallbackShopSeller, shopReviewAnon, shopSpec } from '../core/shop-prompts';
import { isPhoneAbortError } from '../core/phone-error';
import { findShopItem, shopItemImageBusy } from '../core/shop-images';
import { fmtQty, isCurrencyLinkActive, payBalance, payCommon, payCurrencyList } from '../core/currency-link';
import { selectedShopAddress, setCheckoutAddressId } from '../core/shop-engine';
import { emitPhoneEvent, type PhoneAppContext } from './app-registry';
import { openActionSheet } from './action-sheet';
import { openOneShotHintSheet } from './hint-sheet';
import { openImagePickerSheet } from './image-picker-sheet';
import { setShopChatActivity, showScreenToast } from './phone-ui';
import { openPhoneLightbox } from './image-lightbox';
import { emitAch } from '../core/phone-achievements';
import { ubpIcon } from './icons';

// ─── 模块态 ───

let _ctx: PhoneAppContext | null = null;
let _rerender: (() => void) | null = null;
/** 当前打开的会话 id（'' = 未进会话）。 */
let _threadId = '';
/** 从详情进来的返回栈（'detail' = 返回回商品详情；'tab' = 返回回消息列表）。 */
let _backTo: 'detail' | 'tab' = 'tab';
/** 从详情进入时带的商品 id（返回时详情页要还原）。 */
let _fromItemId = '';
let _draft = '';
let _plusOpen = false;
let _sheet: ShopChatSheet = null;
/** 生成中（跨 App 卸载保留；只由「当前这一次」的收尾解除）。 */
let _busy = false;
/**
 * 本次生成绑定的会话 id。**必须在发起那一刻就同步置位**——渲染判「生成中」时若只看引擎的
 * `shopChatGenerating`，会慢一拍：引擎是在 async 函数体里才登记的，而点完条的那次重绘在那之前，
 * 于是「生成条」会一直亮到回复落地（用户实报：微信里点完条它立刻消失，商城版没消失）。
 */
let _busyThreadId = '';
/** 生成代次：终止/切会话使在途那一发的收尾失效。 */
let _seq = 0;
/** 待发引用（随下一条消息带出）。 */
let _quote: { from: string; content: string } | null = null;
/** 图片生成中的消息 id（UI 态；引擎侧另有并发闸）。 */
const _imgBusy = new Set<string>();

/** 弹层（长按动作面板走 openActionSheet，不进这里）。 */
type ShopChatSheet =
  | null
  | { kind: 'rp' }                                            // 我方发红包
  | { kind: 'addr-edit' }                                      // 收货地址编辑（表单态在 _addrForm 里）
  | { kind: 'addr-list' }                                      // 地址簿管理（我的页）
  | { kind: 'addr-pick' }                                      // 结算选地址
  | { kind: 'loc' }                                            // 主项目地点清单
  | { kind: 'review' };                                        // 写评价

/** 弹层表单态（重绘不丢；input 事件实时同步）。 */
const _addrForm = { id: '', name: '', detail: '' };
const _revForm = { itemId: '', rating: 5, text: '', images: [] as string[] };
const _rpForm = { amount: '', currency: '', note: '' };
/** 渲染后要重新聚焦的字段（防全量重绘吞掉光标；'chat' = 聊天输入框，其余 = 弹层字段名）。 */
let _focusField = '';

// ─── 宿主绑定 ───

/** app-shop 在 mount 时注册：重渲染入口 + 容器（长按/输入事件也挂在这里）。 */
export function bindShopChatHost(ctx: PhoneAppContext, rerender: () => void): void {
  _ctx = ctx;
  _rerender = rerender;
}

/** app-shop 卸载时调用（清 ctx/rerender；模块态保留——生成照跑，回来即见）。 */
export function unbindShopChatHost(): void {
  _ctx = null;
  _rerender = null;
}

/** 渲染后调用：恢复输入焦点与光标（全量重绘不吞字）。 */
export function shopChatAfterRender(container: HTMLElement): void {
  if (!_focusField) return;
  const sel = _focusField === 'chat' ? '#ubp-shc-field' : `[data-shc-field="${_focusField}"]`;
  const el = container.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
  _focusField = '';
  if (!el) return;
  try {
    el.focus();
    const len = el.value.length;
    el.setSelectionRange?.(len, len);
  } catch (_e) { /* 焦点恢复失败不阻断 */ }
}

function redraw(): void {
  _rerender?.();
}

/** 切聊天（storageId 变更）时的模块态清理（view 层在 app-shop 的 mount 里做）。 */
export function resetShopChatForNewChat(): void {
  _threadId = '';
  _backTo = 'tab';
  _fromItemId = '';
  _draft = '';
  _plusOpen = false;
  _sheet = null;
  _quote = null;
  _busy = false;
  _busyThreadId = '';
  _imgBusy.clear();
}

// ─── 小工具 ───

function shopData(): ShopData {
  return readPhoneDataRef().shop || emptyShopData();
}

function threads(): ShopThread[] {
  return shopData().threads || [];
}

function currentThread(): ShopThread | null {
  if (!_threadId) return null;
  return threads().find(t => t.id === _threadId) || null;
}

/** 店铺显示名（商品没写铺名时补风格默认——与商城其它处同一口径）。 */
export function shopSellerOf(item: ShopItem | null | undefined): string {
  return item?.seller || fallbackShopSeller(currentStyle());
}

/** 会话头像色（按店名稳定取色，六选一）。 */
function sellerClass(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return `ubp-shp-g${(hash % 6) + 1}`;
}

function shortStoryDate(raw: string): string {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})/.exec(String(raw || '').trim());
  return m ? `${Number(m[2])}月${Number(m[3])}日` : String(raw || '').trim();
}

function storyTimeShort(text: string): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const dm = raw.match(/(\d{4,6})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})/);
  const tm = raw.match(/(\d{1,2}):(\d{2})/);
  if (dm && tm) return `${Number(dm[2])}月${Number(dm[3])}日 ${tm[1].padStart(2, '0')}:${tm[2]}`;
  if (tm) return `${tm[1].padStart(2, '0')}:${tm[2]}`;
  if (dm) return `${Number(dm[2])}月${Number(dm[3])}日`;
  return raw.slice(0, 16);
}

function priceText(item: ShopItem, qty = 1): string {
  const meta = payCurrencyList().find(c => c.name === item.currencyName) || null;
  const n = item.price * Math.max(1, qty);
  return `${meta ? fmtQty(meta.precision, n) : String(n)} ${item.currencyName}`;
}

/** F73：按币种真实精度格式化数量。聊天卡此前写死 fmtQty(0,…)——两位小数币种（如 $12.50）被
 *  四舍五入成整数，同一商品在聊天卡/详情页/实扣金额三个地方三个样。 */
function qtyOf(currencyName: string, n: number): string {
  const meta = payCurrencyList().find(c => c.name === currencyName) || null;
  return meta ? fmtQty(meta.precision, n) : String(n);
}

function itemTile(item: ShopItem): string {
  if (item.image) return `<img src="${escapeAttr(item.image)}" alt="" loading="lazy">`;
  if (shopItemImageBusy(item.id) || _imgBusy.has(item.id)) return '<span class="ubp-spinner"></span>';
  return escapeHtml(item.glyph || '🎁');
}

function tileClassOf(item: ShopItem): string {
  let hash = 0;
  for (const ch of item.id + item.name) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return `ubp-shp-g${(hash % 6) + 1}`;
}

/** 消息缩略图（改价/商品卡头图）：有图用图，否则 emoji 图块。 */
function cardAvatar(item: ShopItem, cls = ''): string {
  const tileCls = tileClassOf(item);
  if (item.image) return `<span class="xava ${tileCls} ${cls}">${itemTile(item)}</span>`;
  return `<span class="xava ${tileCls} ${cls}">${escapeHtml(item.glyph || '🎁')}</span>`;
}

// ─── ① 消息 tab（会话列表） ───

export function renderShopMessagesTab(): string {
  const list = threads();
  if (!list.length) {
    return `<div class="ubp-empty">
      <b class="ubp-shp-empty-t">${S('还没有和商家聊过', '还没有和商家通过信', '还没有和商号联络过', '还没有和商铺通过讯')}</b>
      ${S('在商品详情点左下角的「消息」，就能和这个掌柜聊这件东西。', '在货品详情点左下角的「传讯」，就能和阁主聊这件货。', '在货品详情点左下角的「捎话」，就能和掌柜聊这件货。', '在奇物详情点左下角的「传讯」，就能和管事聊这件奇物。')}<br>
      <button class="ubp-empty-btn" data-ubp-act="tab" data-tab="home">${S('去逛逛', '去逛逛', '去逛逛', '去逛逛')}</button>
    </div>`;
  }
  const rows = list.map(thread => {
    const last = shopThreadLastMessage(thread);
    const preview = last ? shopMessagePreview(last) : '';
    const tag = last ? messagePreviewTag(last) : '';
    const time = last ? storyTimeShort(last.storyTime || '') : '';
    const initial = Array.from(thread.seller.replace(/[·\s]/g, ''))[0] || '店';
    return `<div class="ubp-shc-crow" data-ubp-act="shc-open" data-id="${escapeAttr(thread.id)}" data-seller="${escapeAttr(thread.seller)}">
      <span class="ubp-shc-cava ${sellerClass(thread.seller)}">${escapeHtml(initial)}</span>
      <span class="ubp-shc-cmain">
        <span class="ubp-shc-cline"><span class="ubp-shc-cname">${escapeHtml(thread.seller)}</span><span class="ubp-shc-ctime">${escapeHtml(time)}</span></span>
        <span class="ubp-shc-cprev">${tag}${escapeHtml(preview)}</span>
      </span>
      ${thread.unread > 0
        ? `<span class="ubp-shc-cbadge">${thread.unread > 99 ? '99+' : thread.unread}</span>`
        : '<span class="ubp-shc-cread" style="background:transparent"></span>'}
    </div>`;
  }).join('');
  return `<div class="ubp-shc-clist">${rows}</div>`;
}

/** 预览行前缀标签（四类富媒体；与 mockup 的 [红包]/[新货] 一致）。 */
function messagePreviewTag(m: ShopMessage): string {
  if (m.type === 'redpacket') return `<span class="ubp-shc-tagx rpx">${escapeHtml(S('红包', '福袋', '赏钱', '钱袋'))}</span>`;
  if (m.type === 'price') return `<span class="ubp-shc-tagx">${escapeHtml(S('改价', '让价', '让价', '折价'))}</span>`;
  if (m.type === 'item') return `<span class="ubp-shc-tagx">${escapeHtml(S('新货', '新货', '新货', '新货'))}</span>`;
  if (m.type === 'image') return '';
  return '';
}

/** 消息 tab 顶栏右侧（保持干净：清空/删除都在会话级操作里）。 */
export function shopMessagesTabActions(): string {
  return '<span class="ph"></span>';
}

// ─── ② 聊天页 ───

/** 进入某家店的会话（详情页「消息」或列表点行）。 */
export function openShopChat(seller: string, opts: { itemId?: string; backTo?: 'detail' | 'tab' } = {}): void {
  const name = String(seller || '').trim();
  if (!name) return;
  let id = '';
  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    const list = (base.threads || []).slice();
    const thread = ensureShopThread(list, name);
    id = thread.id;
    d.shop = { ...base, threads: list.sort((a, b) => b.updatedAt - a.updatedAt) };
  });
  if (!id) return;
  _threadId = id;
  _backTo = opts.backTo || 'tab';
  _fromItemId = opts.itemId || '';
  _draft = '';
  _plusOpen = false;
  _sheet = null;
  _quote = null;
  // 当前咨询商品：本会话若已有 focus 且本次没带商品，则保留原样
  if (opts.itemId) setShopThreadFocus(id, opts.itemId);
  const thread = currentThread();
  // 首次进入新会话（还没有任何消息）时，自动发一张我方商品卡（真机行为，仅首次）
  if (opts.itemId && thread && !thread.messages.length) {
    const item = findShopItem(opts.itemId);
    if (item) {
      sendShopUserMessage(id, { type: 'text', content: buildChatItemIntro(item) });
      appendShopItemCard(id, item);
    }
  }
  markShopThreadRead(id);
  emitPhoneEvent('ubp-phone:data-changed');
  emitAch('phone_shop_chat_opened', {}); // L21：商城成就打点（玩家进会话=亲手动作）
}

/** 首次进入时那条「我想问一下这件」的说明文字（真机=商品卡；这里文字 + 卡片一体）。 */
function buildChatItemIntro(item: ShopItem): string {
  return S(`你好，我想问一下这件：${item.name}`, `道友，想问一下这件：${item.name}`, `掌柜，想问一下这件：${item.name}`, `想问一下这件：${item.name}`);
}

/** 追加一张我方商品卡（from='me'，卡片指向货架商品）。 */
function appendShopItemCard(threadId: string, item: ShopItem): void {
  const storyTime = getRoster().global.time || '';
  mutatePhoneData(d => {
    const base = d.shop || emptyShopData();
    const t = (base.threads || []).find(x => x.id === threadId);
    if (!t) return;
    t.messages.push({
      ...buildShopTextMessage('me', '', storyTime),
      type: 'item',
      newItem: { item: { ...item }, listed: true },
    });
    t.updatedAt = Date.now();
    d.shop = { ...base, threads: base.threads };
  });
}

/** 关闭会话视图（app-shop 返回时调；模块态一并复位）。 */
export function closeShopChat(): void {
  _threadId = '';
  _sheet = null;
  _plusOpen = false;
  _quote = null;
  _draft = '';
}

/** 会话页是否开着弹层（返回键逐层消费用）。 */
export function shopChatHasOpenSheet(): boolean {
  return _sheet !== null;
}

/** 关掉会话页弹层；返回是否关掉了（返回键逐层消费用）。 */
export function closeShopChatSheet(): boolean {
  if (!_sheet) return false;
  _sheet = null;
  return true;
}

/** 当前会话 id（app-shop 渲染与 deep-link 用）。 */
export function shopChatThreadId(): string {
  return _threadId;
}

export function shopChatBackTarget(): 'detail' | 'tab' {
  return _backTo;
}

export function shopChatFromItemId(): string {
  return _fromItemId;
}

/** 聊天页主体（消息流 + 输入区；app-shop 放进 .ubp-appbody.noscroll）。 */
export function renderShopChatConversation(): string {
  const thread = currentThread();
  if (!thread) {
    return `<div class="ubp-empty">${S('会话不存在', '符讯不存在', '书信不存在', '晶讯不存在')}</div>`;
  }
  // F72：滚动位不在此处处理——app-shop 渲染后按微信口径统一落位（同会话且消息数没变=保位，否则贴底）。
  // 生成中（本会话）：同步标志优先——点完条立刻成立，条立即消失、typing 立即出现（微信手感）
  const busy = (_busy && _busyThreadId === thread.id) || shopChatGenerating(thread.id);
  const rows: string[] = [];
  let lastStory = '';
  for (const m of thread.messages) {
    if (m.storyTime && m.storyTime !== lastStory) {
      rows.push(`<div class="ubp-shc-tdiv">${escapeHtml(m.storyTime)}</div>`);
      lastStory = m.storyTime;
    }
    rows.push(renderShopMessage(m, thread));
  }
  if (busy) {
    rows.push(`<div class="ubp-shc-typing"><span class="dots"><i></i><i></i><i></i></span>
      <button type="button" class="ubp-shc-abort" data-ubp-act="shc-abort">${S('终止', '终止', '终止', '终止')}</button></div>`);
  }
  const focusItem = thread.focusItemId ? findShopItem(thread.focusItemId) : null;
  const batchCount = busy ? 0 : shopTrailingUserBatch(thread.messages).length;
  const canSend = _draft.trim().length > 0;
  const inputZone = `
    <div class="ubp-shc-inputzone">
      ${focusItem ? `<div class="ubp-shc-focusbar">
        <span class="fic ${tileClassOf(focusItem)}">${itemTile(focusItem)}</span>
        <span class="ft">${S('正在咨询', '正问', '正问', '正问')}：<b>${escapeHtml(focusItem.name)}</b> · ${escapeHtml(priceText(focusItem))}</span>
        <button type="button" class="fx" data-ubp-act="shc-focus-clear" title="${S('关闭', '关闭', '关闭', '关闭')}">✕</button>
      </div>` : ''}
      ${_quote ? `<div class="ubp-shc-quotebar"><span class="qt">${escapeHtml(S('引用', '引述', '引述', '引述'))} ${escapeHtml(_quote.from === 'me' ? S('我', '我', '我', '我') : _quote.from)}：${escapeHtml(_quote.content.slice(0, 40))}</span>
        <button type="button" class="qx" data-ubp-act="shc-quote-cancel">✕</button></div>` : ''}
      ${batchCount > 0 ? `<div class="ubp-shc-pendbar">
        <button type="button" class="ubp-shc-pendmain" data-ubp-act="shc-trigger">▶ ${escapeHtml(triggerLabel(batchCount))}</button>
        <button type="button" class="ubp-shc-pendmore" data-ubp-act="shc-extra-hint" title="${S('本批额外提示', '本批额外提点', '本批额外提点', '本批额外提点')}">${ubpIcon('more')}</button>
      </div>` : ''}
      <div class="ubp-shc-inputrow">
        <button type="button" class="ubp-shc-plusbtn" data-ubp-act="shc-plus" title="${S('更多', '更多', '更多', '更多')}">${_plusOpen ? '✕' : '＋'}</button>
        <input class="ubp-shc-field" id="ubp-shc-field" data-shc-field="chat" placeholder="${escapeAttr(S('说点什么…', '写点什么…', '写点什么…', '写点什么…'))}" value="${escapeAttr(_draft)}" maxlength="500">
        <button type="button" class="ubp-shc-sendbtn" data-ubp-act="shc-send"${canSend ? '' : ' disabled'}>${S('发送', '发送', '发出', '发送')}</button>
      </div>
      ${_plusOpen ? `<div class="ubp-shc-pluspanel">
        <button type="button" class="ubp-shc-pcell" data-ubp-act="shc-image"><span class="pi">🖼️</span>${S('相册', '影阁', '图册', '图册')}</button>
        <button type="button" class="ubp-shc-pcell" data-ubp-act="shc-camera"><span class="pi">📷</span>${S('拍照', '留影', '写真', '记影')}</button>
        ${isCurrencyLinkActive() ? `<button type="button" class="ubp-shc-pcell" data-ubp-act="shc-rp"><span class="pi rp">${S('福', '福', '赏', '袋')}</span>${escapeHtml(S('红包', '福袋', '赏钱', '钱袋'))}</button>` : ''}
      </div>` : ''}
    </div>`;
  return `<div class="ubp-shc-msgs" id="ubp-shc-msgs">${rows.join('')}</div>${inputZone}`;
}

/** 生成条文案（用户引用的微信口径：待发送 X 条 › 生成回复）。 */
function triggerLabel(batchCount: number): string {
  const verb = S('让掌柜回复', '请阁主回话', '请掌柜回话', '请管事回话');
  return S(`待发送 ${batchCount} 条 › ${verb}`, `待发出 ${batchCount} 则 › ${verb}`, `待发出 ${batchCount} 则 › ${verb}`, `待发出 ${batchCount} 则 › ${verb}`);
}

/** 单条消息渲染（气泡 / 图片 / 红包 / 改价卡 / 商品卡 / 系统行）。 */
function renderShopMessage(m: ShopMessage, thread: ShopThread): string {
  if (m.from === 'system') {
    const isError = m.content.startsWith('[错误]');
    return `<div class="ubp-shc-sysmsg${isError ? ' err' : ''}"${isError ? ' data-ubp-act="shc-retry"' : ''}>${escapeHtml(m.content)}</div>`;
  }
  const me = m.from === 'me';
  const avatar = `<span class="ubp-shc-mava ${me ? 'ubp-shp-g2' : sellerClass(thread.seller)}"${me ? ' style="color:#3A5A8A"' : ''}>${escapeHtml(me ? '我' : (Array.from(thread.seller.replace(/[·\s]/g, ''))[0] || '店'))}</span>`;
  const nameTag = me ? '' : `<span class="ubp-shc-sname">${escapeHtml(thread.seller)}</span>`;
  let body: string;
  if (m.type === 'image') {
    if (m.imageStatus === 'ready' && m.imagePath) {
      body = `<div class="ubp-shc-imgmsg" data-ubp-act="shc-img-view" data-id="${escapeAttr(m.imagePath)}"><img src="${escapeAttr(m.imagePath)}" alt="" loading="lazy"></div>`;
    } else if (m.imageStatus === 'failed') {
      body = `<div class="ubp-shc-imgmsg" data-ubp-act="shc-img-gen" data-id="${escapeAttr(m.id)}"><div class="ubp-shc-imgph failed">
        <span>⚠ ${S('生成失败', '成像失败', '成像失败', '成像失败')}</span>
        <span>${escapeHtml(m.content.slice(0, 44))}</span>
        <span>${S('点击重试', '点击重试', '点击重试', '点击重试')}</span></div></div>`;
    } else if (_imgBusy.has(m.id)) {
      body = `<div class="ubp-shc-imgmsg" data-ubp-act="shc-img-gen" data-id="${escapeAttr(m.id)}"><div class="ubp-shc-imgph">
        <span class="ubp-spinner"></span><span>${escapeHtml(m.content.slice(0, 44) || S('生成中…', '成像中…', '成像中…', '成像中…'))}</span></div></div>`;
    } else {
      body = `<div class="ubp-shc-imgmsg" data-ubp-act="shc-img-gen" data-id="${escapeAttr(m.id)}"><div class="ubp-shc-imgph">
        <span>🖼️</span><span>${escapeHtml(m.content.slice(0, 44))}</span><span>${S('点击生成', '点击成像', '点击成像', '点击成像')}</span></div></div>`;
    }
  } else if (m.type === 'redpacket') {
    const claimable = !me && m.claimed === false;
    const cur = m.currency ? ` · ${m.currency}` : '';
    body = `<div class="ubp-shc-rp${claimable ? '' : ' claimed'}">
      <div class="rt">
        <span class="rcoin">${S('福', '福', '赏', '袋')}</span>
        <span class="rmain">
          <span class="rmsg">${escapeHtml(m.content || S('红包', '福袋', '赏钱', '钱袋'))}</span>
          <span class="rmt">${escapeHtml((me ? S('我发出的红包', '我发出的福袋', '我发出的赏钱', '我发出的钱袋') : S(`${thread.seller}的红包`, `${thread.seller}的福袋`, `${thread.seller}的赏钱`, `${thread.seller}的钱袋`)) + cur)}</span>
        </span>
      </div>
      ${claimable
        ? `<button type="button" class="ropen" data-ubp-act="shc-claim" data-id="${escapeAttr(m.id)}">${S('開', '开', '开', '开')}</button>`
        : `<span class="rstamp">${escapeHtml(m.claimed === false ? '' : `${S('已入账', '已入袋', '已入账', '已入袋')} ${escapeHtml(String(m.amount || ''))}`)}</span>`}
    </div>`;
  } else if (m.type === 'price' && m.priceChange) {
    const pc = m.priceChange;
    const item = findShopItemByName(pc.itemName);
    body = `<div class="ubp-shc-xcard"${item ? ` data-ubp-act="shc-open-item" data-id="${escapeAttr(item.id)}"` : ''}>
      <div class="xh">${item ? cardAvatar(item) : `<span class="xava">💰</span>`}<span class="xt">
        <span class="xk">${escapeHtml(S('同意改价', '已让价', '已让价', '已折价'))}</span><span class="xn">${escapeHtml(pc.itemName)}</span></span></div>
      <div class="xb">
        <div class="xprice">${escapeHtml(qtyOf(pc.currencyName, pc.to))}<small>${escapeHtml(pc.currencyName)}</small>${pc.from > pc.to ? `<span class="was">${escapeHtml(String(pc.from))}</span>` : ''}</div>
        ${pc.note ? `<div class="xnote">「${escapeHtml(pc.note)}」</div>` : ''}
        <div class="xfoot${pc.applied ? '' : ' gray'}">${pc.applied
          ? `✓ ${S('已同步到商城（货架 / 收藏 / 购物车）', '已记入阁中账（货架 / 收藏 / 储物袋）', '已记入商行（货架 / 收藏 / 货担）', '已记入商栈（货架 / 收藏 / 行囊）')}`
          : S('该商品已不在货架上（记录保留）', '该货品已不在货架上（记录保留）', '该货品已不在货架上（记录保留）', '该奇物已不在货架上（记录保留）')}</div>
      </div>
    </div>`;
  } else if (m.type === 'item' && m.newItem) {
    const it = m.newItem.item;
    const listed = m.newItem.listed;
    body = `<div class="ubp-shc-xcard item" data-ubp-act="shc-open-item" data-id="${escapeAttr(it.id)}">
      <div class="xh">${cardAvatar(it)}<span class="xt">
        <span class="xk">${escapeHtml(listed ? S('本店新品', '本店新货', '本店新货', '本店新货') : S('本店货品', '本店货品', '本店货品', '本店奇物'))}</span><span class="xn">${escapeHtml(it.name)}</span></span></div>
      <div class="xb">
        <div class="xprice">${escapeHtml(qtyOf(it.currencyName, it.price))}<small>${escapeHtml(it.currencyName)}</small></div>
        ${it.desc ? `<div class="xdesc">${escapeHtml(it.desc)}</div>` : ''}
        <div class="xfoot${listed ? '' : ' gray'}">${listed
          ? `✓ ${S('已在商城上架 · 点开看详情', '已记入阁中货架 · 点开看详情', '已记入商行货架 · 点开看详情', '已记入商栈货架 · 点开看详情')}`
          : S('已在货架上 · 点开看详情', '已在货架上 · 点开看详情', '已在货架上 · 点开看详情', '已在货架上 · 点开看详情')}</div>
      </div>
    </div>`;
  } else {
    const quoteBar = m.quote
      ? `<span class="ubp-shc-quote">${escapeHtml(S('引用', '引述', '引述', '引述'))} ${escapeHtml(m.quote.from === 'me' ? '我' : m.quote.from)}：${escapeHtml(String(m.quote.content || '').slice(0, 60))}</span>`
      : '';
    body = `<span class="ubp-shc-bubble">${quoteBar}${escapeHtml(m.content)}</span>`;
  }
  const col = `<span class="ubp-shc-mcol">${nameTag}${body}</span>`;
  return me
    ? `<div class="ubp-shc-mrow me" data-mid="${escapeAttr(m.id)}">${col}${avatar}</div>`
    : `<div class="ubp-shc-mrow" data-mid="${escapeAttr(m.id)}">${avatar}${col}</div>`;
}

/** 按名找货架/收藏/购物车里的商品（改价卡与商品卡点开用）。 */
function findShopItemByName(name: string): ShopItem | null {
  const key = name.replace(/\s+/g, '').toLowerCase();
  const data = shopData();
  const all = [...data.catalog, ...data.favorites, ...data.cart.map(l => l.item)];
  return all.find(it => it.name.replace(/\s+/g, '').toLowerCase() === key) || null;
}

// ─── 输入区事件（草稿 / 弹层表单同步） ───

export function shopChatInputHandler(event: Event): void {
  const el = event.target as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return;
  const field = el.dataset.shcField || '';
  if (!field) return;
  const value = el.value;
  if (field === 'chat') {
    _draft = value;
    // 发送钮可用态就地同步（不整帧重绘：重绘会吞光标；与本仓「聊天稳定壳」同一考量）
    const btn = (_ctx?.container ?? el.closest('.ubp-screen'))?.querySelector('[data-ubp-act="shc-send"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = !value.trim();
    return;
  }
  if (field === 'addr-name') { _addrForm.name = value; return; }
  if (field === 'addr-detail') { _addrForm.detail = value; return; }
  if (field === 'rp-amount') {
    _rpForm.amount = value;
    syncShopRpSendButton(); // 金额/余额变了就地同步按钮态（弹层不整帧重绘，免吞输入）
    return;
  }
  if (field === 'rp-note') { _rpForm.note = value; return; }
  if (field === 'rev-text') { _revForm.text = value; return; }
}

/** 发红包弹层的「塞钱进红包」可用态（金额 >0 且余额够；不重绘，就地改 disabled）。 */
function syncShopRpSendButton(): void {
  const btn = _ctx?.container?.querySelector('[data-ubp-act="shc-rp-send"]') as HTMLButtonElement | null;
  if (!btn) return;
  const metas = payCurrencyList();
  const picked = metas.find(c => c.name === _rpForm.currency) || payCommon() || metas[0] || null;
  const amount = Number(String(_rpForm.amount).replace(/[^\d.]/g, ''));
  btn.disabled = !picked || !(amount > 0) || payBalance(picked) < amount;
}

/** 输入区 Enter 发送（真机习惯：回车即发，Shift+Enter 换行）。 */
export function shopChatKeyHandler(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement | null;
  if (!el || el.dataset.shcField !== 'chat') return false;
  if (event.key !== 'Enter' || event.shiftKey) return false;
  event.preventDefault();
  sendDraft();
  return true;
}

/** 发送（上屏攒批；≠ 触发）。 */
function sendDraft(): void {
  const text = _draft.trim();
  if (!text) return;
  _draft = '';
  const threadId = _threadId;
  const quote = _quote;
  _quote = null;
  const ok = sendShopUserMessage(threadId, { type: 'text', content: text });
  if (ok) emitAch('phone_msg_sent', { type: 'text', isGroup: 0, len: text.length, quote: quote ? 1 : 0, shop: 1 }); // L21：复用既有事件（shop 位与微信区分）
  if (ok && quote) {
    // 引用：贴到刚发出去的那条上（同一条消息，AI 侧呈现为「（引用 商家：原文）」）
    mutatePhoneData(d => {
      const t = (d.shop?.threads || []).find(x => x.id === threadId);
      const last = t?.messages[t.messages.length - 1];
      if (last && last.from === 'me') last.quote = { from: quote.from, content: quote.content.slice(0, 200) };
    });
  }
  setShopThreadDraft(threadId, '');
  emitPhoneEvent('ubp-phone:data-changed');
  redraw();
}

// ─── 生成（点生成条） ───

/**
 * 发起一次商家回复。
 * ★ 收尾纪律（照商城上货 + 微信）：一次生成花一整发 AI 请求，**结果不因 App 卸载而丢**——
 *   只按**聊天归属**丢弃（切聊天才丢）；UI 反馈（渲染 + toast）才看是否挂载；
 *   失败落在会话内的系统错误行（可点重试），回来那一刻仍能看见。
 */
function triggerShopChat(extraHint = '', errorThreadId = ''): void {
  const thread = currentThread() || (errorThreadId ? threads().find(t => t.id === errorThreadId) || null : null);
  if (!thread) return;
  const threadId = thread.id;
  if (_busy || shopChatGenerating(threadId)) return;
  const owner = currentPhoneStorageId();
  const seq = ++_seq;
  _busy = true;
  _busyThreadId = threadId;   // ★ 同步置位：这一帧重绘就要看到「生成中」
  setShopChatActivity(true, thread.seller);
  redraw();
  void (async () => {
    try {
      const res = await generateShopChatReply({ threadId, ...(extraHint ? { extraHint } : {}) });
      if (seq === _seq) { _busy = false; _busyThreadId = ''; setShopChatActivity(false, ''); }
      if (currentPhoneStorageId() !== owner) return; // 已切聊天：这一批不属于当前聊天，整批丢弃
      const watching = Boolean(_ctx) && _threadId === threadId;
      const outcome = applyShopChatReply(threadId, res.messages, { watching });
      emitPhoneEvent('ubp-phone:data-changed');
      pumpShopChatImages(threadId); // 图片富媒体按需/自动生图（与微信同一把自动开关）
      if (!_ctx) return;
      redraw();
      const notes: string[] = [];
      if (watching) for (const _name of outcome.priceChanged) emitAch('phone_shop_bargain_win', {}); // L21：玩家发起的议价回合结出改价卡
      if (outcome.priceChanged.length) notes.push(S(`掌柜改价：${outcome.priceChanged.join('、')}`, `阁主让价：${outcome.priceChanged.join('、')}`, `掌柜让价：${outcome.priceChanged.join('、')}`, `管事折价：${outcome.priceChanged.join('、')}`));
      if (outcome.listed.length) notes.push(S(`本店上新：${outcome.listed.join('、')}`, `本店新货：${outcome.listed.join('、')}`, `本店新货：${outcome.listed.join('、')}`, `本店新货：${outcome.listed.join('、')}`));
      const dropped = res.quota.dropped + outcome.dropped;
      if (dropped > 0) notes.push(S(`${dropped} 条富媒体因格式/额度无效被忽略`, `${dropped} 条富媒体因格式/额度无效被忽略`, `${dropped} 条富媒体因格式/额度无效被忽略`, `${dropped} 条富媒体因格式/额度无效被忽略`));
      if (notes.length && _ctx) showScreenToast(_ctx.container, notes.join(' · '));
    } catch (e) {
      if (seq === _seq) { _busy = false; _busyThreadId = ''; setShopChatActivity(false, ''); }
      // 用户按过「终止」（seq 已推进）或已切聊天：这一发的失败不该弹到眼前/落到新聊天
      if (seq !== _seq || currentPhoneStorageId() !== owner) return;
      // 统一 AI 活动的取消同样静默收口（不落错误行）
      if (isPhoneAbortError(e)) { redraw(); return; }
      // 落一条系统错误行（可点重试），与微信同款；失败态随会话存档走，不需要额外模块字段
      const text = `[错误] ${e instanceof Error ? e.message : String(e)}`;
      mutatePhoneData(d => {
        const t = (d.shop?.threads || []).find(x => x.id === threadId);
        if (!t) return;
        t.messages.push({ ...buildShopTextMessage('system', text, getRoster().global.time || '') });
      });
      emitPhoneEvent('ubp-phone:data-changed');
      redraw();
    }
  })();
}

/** 长按生成条 ⋯：本批额外提示（一次性；全机统一件）。 */
function openExtraHintSheet(): void {
  const container = _ctx?.container;
  const threadId = _threadId;
  if (!container || !threadId) return;
  openOneShotHintSheet(container, {
    title: S('本批额外提示', '本批额外提点', '本批额外提点', '本批额外提点'),
    confirmLabel: S('回复', '回话', '回话', '回话'),
    onConfirm: hint => { triggerShopChat(hint, threadId); },
  });
}

// ─── 图片消息（两步法；纯景物，入相册 source='shop'） ───

/** 商家图是否需要自动生图（进会话/收到新图时各扫一次；自动开关关=零开销）。 */
export function pumpShopChatImages(threadId: string): void {
  if (getPhoneSettings().autoImageGen !== true) return;
  const thread = threads().find(t => t.id === threadId);
  if (!thread) return;
  const pending = thread.messages
    .filter(m => m.type === 'image' && m.imageStatus === 'pending' && !m.imageManual && !_imgBusy.has(m.id))
    .slice(0, MAX_AUTO_IMAGES_PER_BATCH);
  for (const m of pending) void runShopChatImage(threadId, m.id);
}

/** 生成一条商家图片消息（点击重试 / 自动补图共用）。 */
async function runShopChatImage(threadId: string, messageId: string): Promise<void> {
  if (_imgBusy.has(messageId)) return;
  const owner = currentPhoneStorageId();
  const thread = threads().find(t => t.id === threadId);
  const msg = thread?.messages.find(m => m.id === messageId);
  if (!thread || !msg || msg.type !== 'image') return;
  _imgBusy.add(messageId);
  redraw();
  const roster = getRoster();
  let genRecord: Parameters<typeof addPhoneAlbumEntries>[0][number]['gen'] | undefined;
  let fixedPrompt = '';
  let fixedNegative = '';
  try {
    const path = await generatePhoneImage({
      messageId,
      description: msg.content,
      subjects: [], // 商家图=纯景物（商家不是通讯录角色，画面里没有"角色"）
      roster,
      chatContext: buildShopChatContext(thread.messages),
      stem: `phone_${messageId.replace(/^(shm_|m_)/, '')}`,
      fixed: msg.imagePrompt ? { promptText: msg.imagePrompt, negativePrompt: msg.imageNegative || '' } : undefined,
      onPromptReady: (promptText, negativePrompt) => {
        fixedPrompt = promptText;
        fixedNegative = negativePrompt;
        if (currentPhoneStorageId() !== owner) return;
        mutatePhoneData(d => {
          const m = (d.shop?.threads || []).find(t => t.id === threadId)?.messages.find(x => x.id === messageId);
          if (m) { m.imagePrompt = promptText; m.imageNegative = negativePrompt; }
        });
      },
      onRecord: record => { genRecord = record as unknown as typeof genRecord; },
    });
    if (currentPhoneStorageId() !== owner) return;
    mutatePhoneData(d => {
      const m = (d.shop?.threads || []).find(t => t.id === threadId)?.messages.find(x => x.id === messageId);
      if (m) { m.imagePath = path; m.imageStatus = 'ready'; }
    });
    addPhoneAlbumEntries([{
      id: makeAlbumEntryId(),
      path,
      source: 'shop',
      characters: [],
      desc: msg.content,
      ...(fixedPrompt || msg.imagePrompt ? { imagePrompt: fixedPrompt || msg.imagePrompt, imageNegative: msg.imageNegative || fixedNegative } : {}),
      ...(genRecord ? { gen: genRecord } : {}),
      createdAt: Date.now(),
    }]);
    emitPhoneEvent('ubp-phone:data-changed');
  } catch (_e) {
    if (currentPhoneStorageId() === owner) {
      mutatePhoneData(d => {
        const m = (d.shop?.threads || []).find(t => t.id === threadId)?.messages.find(x => x.id === messageId);
        if (m) m.imageStatus = 'failed';
      });
    }
  } finally {
    _imgBusy.delete(messageId);
    if (_ctx) redraw();
  }
}

// ─── ③ 商品详情：评价区 + 写评价 ───

/**
 * 该商品能否评价（用户 2026-10-06 二轮口径：**买了且收到货才能评价**）。
 * 判据 = 该商品存在**已送达**订单（按名归并）；未收货 = 只能看、不能评。
 */
export function canReviewShopItem(item: ShopItem): boolean {
  return canReviewItem(shopData().orders, item.name);
}

/** 详情页评价区（我的评价 + 买家评价；未收货不给写评价入口）。 */
export function renderShopReviewSection(item: ShopItem): string {
  const data = shopData();
  const mine = findShopReview(data.myReviews, item.name);
  const canReview = canReviewShopItem(item);
  const reviewLabel = shopSpec(currentStyle()).reviewLabel;
  const myBlock = mine
    ? `<div class="ubp-shc-myrev">
        <div class="mrh"><span class="ubp-shc-stars">${'★'.repeat(mine.rating)}${'☆'.repeat(Math.max(0, 5 - mine.rating))}</span>
          <span class="mrt">${escapeHtml(S('我的评价', '我的留评', '我的留评', '我的留评'))}${mine.verified ? ` · ${escapeHtml(S('已购', '已入手', '已入手', '已入手'))}` : ''}</span></div>
        ${mine.text ? `<div class="mrtx">${escapeHtml(mine.text)}</div>` : ''}
        ${mine.images.length ? `<div class="mrimgs">${mine.images.map(p => `<span><img src="${escapeAttr(p)}" alt="" loading="lazy"></span>`).join('')}</div>` : ''}
        <div class="mrf"><span>${escapeHtml(mine.createdAt || '')}</span>${canReview
    ? `<b data-ubp-act="shc-review-write" data-id="${escapeAttr(item.id)}">${escapeHtml(S('修改', '修改', '修改', '修改'))}</b>` : ''}</div>
      </div>`
    : canReview
      ? `<div class="ubp-shp-sec" style="margin-top:0">
        <div class="ubp-shp-note">${S('还没有你的评价。给后来的买家一点参考。', '还没有你的留评。给后来的人一点参考。', '还没有你的留评。给后来的人一点参考。', '还没有你的留评。给后来的人一点参考。')}</div>
        <div class="ubp-shc-writebtn" data-ubp-act="shc-review-write" data-id="${escapeAttr(item.id)}">${escapeHtml(S('写评价', '留评', '留评', '留评'))}</div>
      </div>`
      : `<div class="ubp-shp-sec" style="margin-top:0">
        <div class="ubp-shp-note">${S('收到货之后才能评价（下单并等包裹送达）。', '货到之后才能留评（下单并等货送到）。', '货到之后才能留评（下单并等货送到）。', '货箱送达之后才能留评（下单并等送达）。')}</div>
      </div>`;
  const buyers = item.reviews.length
    ? item.reviews.map(rv => `<div class="ubp-shc-review">
        <span class="ubp-shc-rva">${escapeHtml((rv.name || shopReviewAnon(currentStyle())).slice(0, 1))}</span>
        <span style="flex:1;min-width:0"><span class="ubp-shc-rvn">${escapeHtml(rv.name || shopReviewAnon(currentStyle()))}</span><span class="ubp-shc-rvt">${escapeHtml(rv.text)}</span></span>
      </div>`).join('')
    : '';
  return `<div class="ubp-shp-sect"><span>${escapeHtml(S('评价', '留评', '留评', '留评'))}</span><span>${S('我的', '我的', '我的', '我的')} ${mine ? 1 : 0} · ${escapeHtml(reviewLabel)} ${item.reviews.length}</span></div>
    ${myBlock}
    ${buyers ? `<div class="ubp-shp-sect"><span>${escapeHtml(reviewLabel)}</span><span>${item.reviews.length} ${S('条', '条', '条', '条')}</span></div><div class="ubp-shp-sec" style="margin-top:0">${buyers}</div>` : ''}`;
}

/** 打开写评价弹层（详情页「写评价 / 修改」；**未收货直接拦下**）。 */
export function openShopReviewSheet(itemId: string): void {
  const item = findShopItem(itemId);
  if (!item) return;
  if (!canReviewShopItem(item)) {
    if (_ctx) showScreenToast(_ctx.container, S('收到货之后才能评价', '货到之后才能留评', '货到之后才能留评', '货箱送达之后才能留评'));
    return;
  }
  const mine = findShopReview(shopData().myReviews, item.name);
  _revForm.itemId = itemId;
  _focusField = 'rev-text';
  _revForm.rating = mine?.rating || 5;
  _revForm.text = mine?.text || '';
  _revForm.images = mine ? mine.images.slice(0, MAX_SHOP_REVIEW_IMAGES) : [];
  _sheet = { kind: 'review' };
  redraw();
}

// ─── ④ 收货地址（我的页卡 + 地址簿弹层 + 结算选地址） ───

/** 「我的」页收货地址卡。 */
export function renderShopAddressCard(): string {
  const data = shopData();
  const list = data.addresses || [];
  const def = defaultShopAddress(list, data.defaultAddressId || '');
  if (!def) {
    return `<div class="ubp-shc-adrcard" data-ubp-act="shc-addr-list">
      <div class="ah"><b>${escapeHtml(S('收货地址', '送件之处', '收货之处', '送达之处'))}</b><span>${escapeHtml(S('去填写', '去填写', '去填写', '去填写'))}</span></div>
      <div class="ae">${S('还没填收货地址——下单前填一下，掌柜才知道往哪儿送。', '还没填写送件之处——下单前填一下，店家才知道往哪儿送。', '还没填写收货之处——下单前填一下，店家才知道往哪儿送。', '还没填写送达之处——下单前填一下，商队才知道往哪儿送。')}</div>
    </div>`;
  }
  return `<div class="ubp-shc-adrcard" data-ubp-act="shc-addr-list">
    <div class="ah"><b>${escapeHtml(S('收货地址', '送件之处', '收货之处', '送达之处'))}</b><span>${escapeHtml(S(`管理 · 共 ${list.length} 条`, `管理 · 共 ${list.length} 条`, `管理 · 共 ${list.length} 条`, `管理 · 共 ${list.length} 条`))}</span></div>
    <div class="an">${escapeHtml(def.name || S('未填姓名', '未填姓名', '未填姓名', '未填姓名'))}<em>${escapeHtml(S('默认', '默认', '默认', '默认'))}</em></div>
    <div class="ad">${escapeHtml(def.detail || '')}</div>
  </div>`;
}

/** 结算弹层顶部的收货地址行（立即购买 / 购物车同一张；显示**本单选中**的地址，未选=默认）。 */
export function renderShopCheckoutAddressRow(): string {
  const data = shopData();
  const list = data.addresses || [];
  const def = defaultShopAddress(list, data.defaultAddressId || '');
  const picked = selectedShopAddress();   // 本单地址（含「更换」选中的那条；地址簿空时回填最近订单快照）
  if (!picked) {
    return `<div class="ubp-shc-adrrow none" data-ubp-act="shc-addr-list">
      <span class="ai">📍</span>
      <span class="at"><span class="an">${escapeHtml(S('还没填收货地址', '还没填写送件之处', '还没填写收货之处', '还没填写送达之处'))}</span>
        <span class="ad">${S('点这里填一个，掌柜才知道往哪儿送', '点这里填一个，店家才知道往哪儿送', '点这里填一个，店家才知道往哪儿送', '点这里填一个，商队才知道往哪儿送')}</span></span>
      <span class="ax">${escapeHtml(S('去填写', '去填写', '去填写', '去填写'))}</span>
    </div>`;
  }
  const isDefault = Boolean(def && picked.id && def.id === picked.id);
  return `<div class="ubp-shc-adrrow">
    <span class="ai">📍</span>
    <span class="at"><span class="an">${escapeHtml([picked.name, picked.detail].filter(Boolean).join(' · '))}</span>
      <span class="ad">${escapeHtml(isDefault ? S('默认收货地址', '默认送件之处', '默认收货之处', '默认送达之处') : S('本单收货地址', '本单送件之处', '本单收货之处', '本单送达之处'))}${list.length > 1 ? ` · ${S(`共 ${list.length} 条`, `共 ${list.length} 条`, `共 ${list.length} 条`, `共 ${list.length} 条`)}` : ''}</span></span>
    <button type="button" class="ax" data-ubp-act="shc-addr-pick">${escapeHtml(S('更换', '更换', '更换', '更换'))}</button>
  </div>`;
}

/** 从地址簿取一条。 */
function addressById(id: string): ShopAddress | null {
  return (shopData().addresses || []).find(a => a.id === id) || null;
}

/** 生成本次结算用地址（结算弹层打开时调用；空 = 用默认）。 */
export function syncCheckoutAddress(): void {
  setCheckoutAddressId('');
}

// ─── ⑤ 弹层渲染（全部走 .ubp-overlay/.ubp-sheet，与全机同料） ───

export function renderShopChatSheet(): string {
  if (!_sheet) return '';
  const closeBg = 'data-ubp-act="shc-sheet-close-bg"';
  if (_sheet.kind === 'rp') {
    const metas = payCurrencyList();
    const common = payCommon();
    const picked = metas.find(c => c.name === _rpForm.currency) || common || metas[0] || null;
    if (picked && !_rpForm.currency) _rpForm.currency = picked.name;
    const amount = Number(String(_rpForm.amount).replace(/[^\d.]/g, ''));
    const enough = picked ? payBalance(picked) >= (Number.isFinite(amount) ? amount : 0) : false;
    const rows = metas.map(c => `<div class="ubp-shc-pickrow" data-ubp-act="shc-rp-cur" data-id="${escapeAttr(c.name)}">
        <span class="pk${picked && picked.name === c.name ? ' on' : ''}">${picked && picked.name === c.name ? '✓' : ''}</span>
        <span class="pt"><span class="pn">${escapeHtml(c.name)}</span><span class="pd">${escapeHtml(S('余额', '余额', '余额', '余额'))} ${escapeHtml(fmtQty(c.precision, payBalance(c)))}</span></span>
        ${common && common.name === c.name ? `<span class="pdef">${escapeHtml(S('常用', '常用', '常用', '常用'))}</span>` : ''}
      </div>`).join('');
    return `<div class="ubp-overlay ubp-actionsheet" ${closeBg}>
      <div class="ubp-sheet" data-ubp-asstop="1">
        <div class="ubp-sheet-title">${escapeHtml(S('发红包', '送福袋', '给赏钱', '送钱袋'))}</div>
        <div class="ubp-sheet-body" style="padding:0 2px 8px;">${escapeHtml(S(`给「${currentThread()?.seller || ''}」的掌柜发个红包：定金、补差价、加急费都走这里。`, `给「${currentThread()?.seller || ''}」送个福袋：定金、补差价、加急都走这里。`, `给「${currentThread()?.seller || ''}」的掌柜一份赏钱：定金、补差价、加急都走这里。`, `给「${currentThread()?.seller || ''}」送个钱袋：定金、补差价、加急都走这里。`))}</div>
        <div class="ubp-shc-fld"><label>${escapeHtml(S('金额', '数目', '数目', '数目'))}</label>
          <input class="inp" data-shc-field="rp-amount" inputmode="decimal" placeholder="${escapeAttr(S('如 88', '如 88', '如 88', '如 88'))}" value="${escapeAttr(_rpForm.amount)}"></div>
        <div class="ubp-shc-fld"><label>${escapeHtml(S('留言', '附言', '附言', '附言'))}</label>
          <input class="inp" data-shc-field="rp-note" placeholder="${escapeAttr(S('这是定金，麻烦掌柜排炉', '这是定金，劳烦阁主备货', '这是定金，劳烦掌柜备货', '这是定金，劳烦管事备货'))}" value="${escapeAttr(_rpForm.note)}"></div>
        <div class="ubp-shc-fld"><label>${escapeHtml(S('币种', '币种', '币种', '币种'))}</label>${rows || `<div class="ae">${S('未启用货币系统', '未启用货币系统', '未启用货币系统', '未启用货币系统')}</div>`}</div>
        <div class="ubp-shp-note">${escapeHtml(S('发出即从钱包扣款（流水记「商城消费」）；红包不影响商品价格与订单。', '发出即从钱袋扣款；福袋不影响货价与契书。', '发出即从钱袋扣款；赏钱不影响货价与契书。', '发出即从钱袋扣款；钱袋不影响货价与契约。'))}</div>
        <div class="ubp-shp-payrow" style="margin-top:11px">
          <button type="button" class="ubp-btn" data-ubp-act="shc-sheet-close">${S('取消', '作罢', '作罢', '作罢')}</button>
          <button type="button" class="ubp-btn primary" data-ubp-act="shc-rp-send"${picked && enough && amount > 0 ? '' : ' disabled'}>${escapeHtml(S('塞钱进红包', '装进福袋', '封赏钱', '装进钱袋'))}</button>
        </div>
        ${picked && !enough ? `<div class="ubp-shp-note red">${escapeHtml(S(`${picked.name}余额不足`, `${picked.name}余额不足`, `${picked.name}余额不足`, `${picked.name}余额不足`))}</div>` : ''}
      </div>
    </div>`;
  }
  if (_sheet.kind === 'addr-edit') {
    return `<div class="ubp-overlay ubp-actionsheet" ${closeBg}>
      <div class="ubp-sheet" data-ubp-asstop="1">
        <div class="ubp-sheet-title">${escapeHtml(_addrForm.id ? S('编辑收货地址', '编辑送件之处', '编辑收货之处', '编辑送达之处') : S('新增收货地址', '新增送件之处', '新增收货之处', '新增送达之处'))}</div>
        <div class="ubp-sheet-body" style="padding:0 2px 8px;">${escapeHtml(S('下单时写进备忘录，也会发给掌柜确认。', '下单时写进手札，也会捎给店家确认。', '下单时写进账册，也会捎给店家确认。', '下单时写进羊皮笺，也会捎给商队确认。'))}</div>
        <div class="ubp-shc-fld"><label>${escapeHtml(S('收货人', '收件人', '收货人', '收件人'))}</label>
          <input class="inp" data-shc-field="addr-name" maxlength="20" placeholder="${escapeAttr(S('姓名', '姓名', '姓名', '姓名'))}" value="${escapeAttr(_addrForm.name)}"></div>
        <div class="ubp-shc-fld"><label>${escapeHtml(S('收货地址', '送件之处', '收货之处', '送达之处'))}</label>
          <textarea data-shc-field="addr-detail" maxlength="120" placeholder="${escapeAttr(S('写清送到哪里（也可以从地点清单选）', '写清送到哪里（也可以从地点清单选）', '写清送到哪里（也可以从地点清单选）', '写清送到哪里（也可以从地点清单选）'))}">${escapeHtml(_addrForm.detail)}</textarea></div>
        <div class="ubp-shp-payrow" style="margin-top:9px">
          <button type="button" class="ubp-btn" data-ubp-act="shc-addr-loc">📍 ${escapeHtml(S('从主项目地点清单选择', '从主项目地点清单选择', '从主项目地点清单选择', '从主项目地点清单选择'))}</button>
        </div>
        <div class="ubp-shp-payrow">
          <button type="button" class="ubp-btn" data-ubp-act="shc-sheet-close">${S('取消', '作罢', '作罢', '作罢')}</button>
          <button type="button" class="ubp-btn primary" data-ubp-act="shc-addr-save">${S('保存', '保存', '保存', '保存')}</button>
        </div>
      </div>
    </div>`;
  }
  if (_sheet.kind === 'loc') {
    const list = _locCache || [];
    const rows = list.map(l => `<div class="ubp-shc-locrow" data-ubp-act="shc-loc-pick" data-id="${escapeAttr(l.nodeId)}">
        <span class="lp">📍</span>
        <span style="flex:1;min-width:0"><span class="ln">${escapeHtml(l.name)}</span><span class="ls">${escapeHtml(l.fullPath || l.name)}</span>
          ${l.summary ? `<span class="lf">${escapeHtml(l.summary)}</span>` : ''}</span>
      </div>`).join('');
    return `<div class="ubp-overlay ubp-actionsheet" ${closeBg}>
      <div class="ubp-sheet" data-ubp-asstop="1">
        <div class="ubp-sheet-title">${escapeHtml(S('选择地点', '选择地点', '选择地点', '选择地点'))}</div>
        <div class="ubp-sheet-body" style="padding:0 2px 8px;">${escapeHtml(S('取自主项目地图（与拍照地点同一份清单），选中即填入地址。', '取自主项目舆图（与留影地点同一份清单），选中即填入。', '取自主项目舆图（与写真地点同一份清单），选中即填入。', '取自主项目地图（与记影地点同一份清单），选中即填入。'))}</div>
        ${rows || `<div class="ubp-shp-note">${escapeHtml(S('暂无可选地点，直接手填即可。', '暂无可选地点，直接手填即可。', '暂无可选地点，直接手填即可。', '暂无可选地点，直接手填即可。'))}</div>`}
        <div class="ubp-shp-payrow" style="margin-top:11px"><button type="button" class="ubp-btn" data-ubp-act="shc-loc-back">${S('返回', '返回', '返回', '返回')}</button></div>
      </div>
    </div>`;
  }
  if (_sheet.kind === 'addr-pick' || _sheet.kind === 'addr-list') {
    const data = shopData();
    const list = data.addresses || [];
    const def = defaultShopAddress(list, data.defaultAddressId || '');
    const manage = _sheet.kind === 'addr-list';
    const rows = list.map(a => `<div class="ubp-shc-pickrow" data-ubp-act="${manage ? 'shc-addr-edit' : 'shc-addr-use'}" data-id="${escapeAttr(a.id)}">
        <span class="pk${!manage && def && def.id === a.id ? ' on' : ''}">${!manage && def && def.id === a.id ? '✓' : ''}</span>
        <span class="pt"><span class="pn">${escapeHtml(a.name || S('未填姓名', '未填姓名', '未填姓名', '未填姓名'))}</span><span class="pd">${escapeHtml(a.detail)}</span></span>
        ${data.defaultAddressId === a.id ? `<span class="pdef">${escapeHtml(S('默认', '默认', '默认', '默认'))}</span>` : `<span class="pdef" data-ubp-act="shc-addr-default" data-id="${escapeAttr(a.id)}" style="background:var(--ubp-card-3);color:var(--ubp-text-2)">${escapeHtml(S('设为默认', '设为默认', '设为默认', '设为默认'))}</span>`}
      </div>`).join('');
    const title = manage
      ? S('收货地址', '送件之处', '收货之处', '送达之处')
      : S('选择收货地址', '选择送件之处', '选择收货之处', '选择送达之处');
    return `<div class="ubp-overlay ubp-actionsheet" ${closeBg}>
      <div class="ubp-sheet" data-ubp-asstop="1">
        <div class="ubp-sheet-title">${escapeHtml(title)}</div>
        ${rows || `<div class="ubp-shp-note">${S('还没有地址，先新增一条。', '还没有地址，先新增一条。', '还没有地址，先新增一条。', '还没有地址，先新增一条。')}</div>`}
        <div class="ubp-shp-payrow" style="margin-top:9px">
          <button type="button" class="ubp-btn" data-ubp-act="shc-addr-new">＋ ${escapeHtml(S('新增地址', '新增地址', '新增地址', '新增地址'))}</button>
          ${manage ? `<button type="button" class="ubp-btn" data-ubp-act="shc-sheet-close">${S('完成', '完成', '完成', '完成')}</button>`
            : `<button type="button" class="ubp-btn primary" data-ubp-act="shc-addr-confirm">${S('用这条', '用这条', '用这条', '用这条')}</button>`}
        </div>
      </div>
    </div>`;
  }
  // 写评价
  const item = findShopItem(_revForm.itemId);
  const stars = [1, 2, 3, 4, 5].map(n =>
    `<button type="button" class="st${n <= _revForm.rating ? ' on' : ''}" data-ubp-act="shc-rev-star" data-id="${n}">★</button>`).join('');
  const labels = [S('很差', '很差', '很差', '很差'), S('一般', '一般', '一般', '一般'), S('还行', '还行', '还行', '还行'), S('不错', '不错', '不错', '不错'), S('很好', '很好', '很好', '很好')];
  const imgs = _revForm.images.map((p, i) => `<span class="cell"><img src="${escapeAttr(p)}" alt=""><button type="button" class="del" data-ubp-act="shc-rev-img-del" data-id="${i}">✕</button></span>`).join('');
  return `<div class="ubp-overlay ubp-actionsheet" ${closeBg}>
    <div class="ubp-sheet" data-ubp-asstop="1">
      <div class="ubp-sheet-title">${escapeHtml(S('写评价', '留评', '留评', '留评'))}</div>
      <div class="ubp-sheet-body" style="padding:0 2px 4px;">${escapeHtml(item ? `${item.name} · ${shopSellerOf(item)}` : '')}</div>
      <div class="ubp-shc-starpick">${stars}<span class="lb">${escapeHtml(labels[Math.max(0, Math.min(4, _revForm.rating - 1))])}</span></div>
      <div class="ubp-shc-fld"><textarea data-shc-field="rev-text" maxlength="${MAX_SHOP_REVIEW_TEXT}" placeholder="${escapeAttr(S('说说这件东西怎么样…（可不填）', '说说这件货怎么样…（可不填）', '说说这件货怎么样…（可不填）', '说说这件奇物怎么样…（可不填）'))}">${escapeHtml(_revForm.text)}</textarea></div>
      <div class="ubp-shc-imgadd">${imgs}${_revForm.images.length < MAX_SHOP_REVIEW_IMAGES ? `<span class="cell add" data-ubp-act="shc-rev-img-add">＋</span>` : ''}</div>
      <div class="ubp-shp-note">${escapeHtml(S(`最多 ${MAX_SHOP_REVIEW_IMAGES} 张图，从手机相册选。评价会随掌柜的资料块一并读到。`, `最多 ${MAX_SHOP_REVIEW_IMAGES} 张图，从手机相册选。`, `最多 ${MAX_SHOP_REVIEW_IMAGES} 张图，从手机相册选。`, `最多 ${MAX_SHOP_REVIEW_IMAGES} 张图，从手机相册选。`))}</div>
      <div class="ubp-shp-payrow" style="margin-top:11px">
        <button type="button" class="ubp-btn" data-ubp-act="shc-sheet-close">${S('取消', '作罢', '作罢', '作罢')}</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="shc-rev-save">${escapeHtml(S('提交评价', '提交留评', '提交留评', '提交留评'))}</button>
      </div>
    </div>
  </div>`;
}

/** 地点清单缓存（打开「选择地点」时读一次）。 */
let _locCache: PhoneMapLocation[] | null = null;

export function openShopLocationSheet(): void {
  _sheet = { kind: 'loc' };
  redraw();
  if (_locCache) return;
  void readPhoneMapLocations().then(list => {
    _locCache = list;
    redraw();
  }).catch(() => {
    _locCache = [];
    redraw();
  });
}

/** 打开地址编辑（id='' 新增；否则带出原值）。 */
export function openShopAddressEdit(id = ''): void {
  const hit = id ? addressById(id) : null;
  _addrForm.id = hit?.id || '';
  _addrForm.name = hit?.name || '';
  _addrForm.detail = hit?.detail || '';
  _sheet = { kind: 'addr-edit' };
  redraw();
}

// ─── ⑥ 点击分发（app-shop 的 handleClick 转进来） ───

export function handleShopChatAct(act: string, el: HTMLElement, event: Event): boolean {
  const id = el.dataset.id || '';
  // ── 会话列表 ──
  if (act === 'shc-open') {
    const seller = el.dataset.seller || '';
    if (seller) {
      openShopChat(seller, { backTo: 'tab' });
      emitPhoneEvent('ubp-phone:data-changed');
      redraw();
    }
    return true;
  }
  // ── 聊天页 ──
  if (act === 'shc-send') { sendDraft(); return true; }
  if (act === 'shc-trigger') { triggerShopChat(); return true; }
  if (act === 'shc-retry') { triggerShopChat('', _threadId); return true; }
  if (act === 'shc-abort') {
    abortShopChatGeneration(_threadId);
    _seq += 1; // 使在途那一发的收尾失效：终止后不再误报
    _busy = false;
    _busyThreadId = '';
    setShopChatActivity(false, '');
    redraw();
    return true;
  }
  if (act === 'shc-extra-hint') { openExtraHintSheet(); return true; }
  if (act === 'shc-plus') { _plusOpen = !_plusOpen; if (_draft.trim()) _focusField = 'chat'; redraw(); return true; }
  if (act === 'shc-focus-clear') {
    setShopThreadFocus(_threadId, '');
    redraw();
    return true;
  }
  if (act === 'shc-quote-cancel') { _quote = null; redraw(); return true; }
  if (act === 'shc-claim') {
    const res = claimShopRedPacket(_threadId, id);
    if (!res.ok && res.error && _ctx) showScreenToast(_ctx.container, res.error);
    if (res.ok) {
      emitAch('phone_redpacket_claimed', { shop: 1 }); // L21：复用既有事件（shop 位区分商家红包）
      emitPhoneEvent('ubp-phone:data-changed');
    }
    redraw();
    return true;
  }
  if (act === 'shc-image' || act === 'shc-camera') {
    const container = _ctx?.container;
    if (!container) return true;
    const threadId = _threadId;
    const desc = act === 'shc-camera'
      ? S('我刚拍的', '我刚留的影', '我刚拍的写真', '我刚记的影')
      : S('相册里的一张', '影阁里的一张', '图册里的一张', '图册里的一张');
    const probe = act === 'shc-camera'
      ? () => ({ ok: false, error: S('相机在手机里独立成 App，请从桌面打开相机拍照后再从相册发。', '留影在手机里独立成 App，请从桌面打开留影后再从相册发。', '写真在手机里独立成 App，请从桌面打开写真后再从相册发。', '记影在手机里独立成 App，请从桌面打开记影后再从相册发。') })
      : null;
    if (probe) {
      const res = probe();
      if (!res.ok && res.error && _ctx) showScreenToast(_ctx.container, res.error);
      return true;
    }
    openImagePickerSheet(container, {
      mode: 'context',
      title: S('选择图片', '选择影像', '选择影像', '选择影像'),
      onPick: picked => {
        if (!picked.path) return;
        sendShopUserMessage(threadId, { type: 'image', content: picked.desc || desc, imagePath: picked.path });
        emitAch('phone_msg_sent', { type: 'image', isGroup: 0, len: (picked.desc || desc).length, quote: 0, shop: 1 }); // L21
        emitPhoneEvent('ubp-phone:data-changed');
        redraw();
      },
    });
    return true;
  }
  if (act === 'shc-img-gen') { void runShopChatImage(_threadId, id); return true; }
  if (act === 'shc-img-view') { openPhoneLightbox(_ctx?.container, { paths: [id] }); return true; }
  if (act === 'shc-open-item') {
    // 商品卡 / 改价卡 → 商品详情（app-shop 接管视图切换）
    const target = el.closest('[data-ubp-act="shc-open-item"]') as HTMLElement | null;
    const itemId = target?.dataset.id || id;
    if (itemId) {
      _sheet = null;
      _ctx?.container.dispatchEvent(new CustomEvent('ubp-shop-open-item', { detail: { id: itemId }, bubbles: false }));
    }
    return true;
  }
  // ── 发红包 ──
  if (act === 'shc-rp') {
    _rpForm.amount = '';
    _rpForm.note = '';
    _rpForm.currency = payCommon()?.name || '';
    _sheet = { kind: 'rp' };
    redraw();
    return true;
  }
  if (act === 'shc-rp-cur') { _rpForm.currency = id; redraw(); return true; }
  if (act === 'shc-rp-send') {
    const amount = Number(String(_rpForm.amount).replace(/[^\d.]/g, ''));
    const res = sendShopRedPacket({ threadId: _threadId, amount, currencyName: _rpForm.currency, note: _rpForm.note });
    if (!res.ok) { if (_ctx) showScreenToast(_ctx.container, res.error); return true; }
    emitAch('phone_shop_redpacket_sent', { amount: Math.max(0, Math.round(amount) || 0) }); // L21
    _sheet = null;
    emitPhoneEvent('ubp-phone:data-changed');
    redraw();
    return true;
  }
  // ── 弹层通用 ──
  if (act === 'shc-sheet-close') { _sheet = null; redraw(); return true; }
  if (act === 'shc-sheet-close-bg') {
    if ((event.target as HTMLElement).closest('[data-ubp-asstop]')) return true;
    _sheet = null;
    redraw();
    return true;
  }
  // ── 地址簿 ──
  if (act === 'shc-addr-list') { _sheet = { kind: 'addr-list' }; redraw(); return true; }
  if (act === 'shc-addr-pick') { _sheet = { kind: 'addr-pick' }; redraw(); return true; }
  if (act === 'shc-addr-new') { openShopAddressEdit(''); return true; }
  if (act === 'shc-addr-edit') { openShopAddressEdit(id); return true; }
  if (act === 'shc-addr-loc') { openShopLocationSheet(); return true; }
  if (act === 'shc-loc-back') { _sheet = { kind: 'addr-edit' }; _focusField = 'addr-detail'; redraw(); return true; }
  if (act === 'shc-loc-pick') {
    const hit = (_locCache || []).find(l => l.nodeId === id);
    if (hit) {
      _addrForm.detail = (hit.fullPath || hit.name).slice(0, 120);
    }
    // O43③：此处只改弹层表单态（_addrForm），保存时才落盘——原来的空 mutatePhoneData 是白写一次盘
    // + 白刷新一次数据修订号（「选地点」必经路径）。
    _sheet = { kind: 'addr-edit' };
    _focusField = 'addr-detail';
    redraw();
    return true;
  }
  if (act === 'shc-addr-save') {
    const name = _addrForm.name.trim().slice(0, 20);
    const detail = _addrForm.detail.trim().slice(0, 120);
    if (!name && !detail) { if (_ctx) showScreenToast(_ctx.container, S('收货人和地址至少填一项', '收件人和地址至少填一项', '收货人和地址至少填一项', '收件人和送达之处至少填一项')); return true; }
    const now = Date.now();
    mutatePhoneData(d => {
      const base = d.shop || emptyShopData();
      const list = (base.addresses || []).slice();
      const addr: ShopAddress = {
        id: _addrForm.id || makeShopAddressId(),
        name,
        detail,
        updatedAt: now,
      };
      const next = upsertShopAddress(list, addr);
      const defaultId = base.defaultAddressId && next.some(a => a.id === base.defaultAddressId)
        ? base.defaultAddressId
        : (next[0]?.id || '');
      d.shop = { ...base, addresses: next, defaultAddressId: defaultId };
    });
    _sheet = null;
    emitPhoneEvent('ubp-phone:data-changed');
    redraw();
    return true;
  }
  if (act === 'shc-addr-use') {
    // 结算选地址：只作用于这一单（不自动改默认）
    setCheckoutAddressId(id);
    _sheet = null;
    redraw();
    return true;
  }
  if (act === 'shc-addr-confirm') {
    // 「用这条」：把弹层里当前选中的作为本单地址（默认那条）
    const data = shopData();
    const def = defaultShopAddress(data.addresses, data.defaultAddressId || '');
    setCheckoutAddressId(def?.id || '');
    _sheet = null;
    redraw();
    return true;
  }
  if (act === 'shc-addr-default') {
    mutatePhoneData(d => {
      const base = d.shop;
      if (!base) return;
      d.shop = { ...base, defaultAddressId: id };
    });
    emitPhoneEvent('ubp-phone:data-changed');
    redraw();
    return true;
  }
  // ── 评价 ──
  if (act === 'shc-review-write') { openShopReviewSheet(id); return true; }
  if (act === 'shc-rev-star') { _revForm.rating = Math.max(1, Math.min(5, Number(id) || 5)); _focusField = 'rev-text'; redraw(); return true; }
  if (act === 'shc-rev-img-add') {
    const container = _ctx?.container;
    if (!container) return true;
    openImagePickerSheet(container, {
      mode: 'context',
      title: S('选择图片', '选择影像', '选择影像', '选择影像'),
      onPick: picked => {
        if (!picked.path) return;
        if (_revForm.images.length >= MAX_SHOP_REVIEW_IMAGES) return;
        _revForm.images = [..._revForm.images, picked.path];
        redraw();
      },
    });
    return true;
  }
  if (act === 'shc-rev-img-del') {
    const idx = Number(id);
    _revForm.images = _revForm.images.filter((_, i) => i !== idx);
    redraw();
    return true;
  }
  if (act === 'shc-rev-save') {
    const item = findShopItem(_revForm.itemId);
    if (!item) { _sheet = null; redraw(); return true; }
    if (!canReviewShopItem(item)) {   // 保存侧兜底：入口被绕过也不落评价
      _sheet = null;
      redraw();
      if (_ctx) showScreenToast(_ctx.container, S('收到货之后才能评价', '货到之后才能留评', '货到之后才能留评', '货箱送达之后才能留评'));
      return true;
    }
    const data = shopData();
    const delivered = (data.orders || []).some(o => o.status === 'delivered' && o.item.name.replace(/\s+/g, '').toLowerCase() === item.name.replace(/\s+/g, '').toLowerCase());
    const review: ShopMyReview = {
      id: makeShopReviewId(),
      itemKey: item.name.replace(/\s+/g, '').toLowerCase(),
      itemName: item.name,
      rating: Math.max(1, Math.min(5, _revForm.rating)),
      text: _revForm.text.trim().slice(0, MAX_SHOP_REVIEW_TEXT),
      images: _revForm.images.slice(0, MAX_SHOP_REVIEW_IMAGES),
      createdAt: selfStamp(getRoster().global.time || '') || shortStoryDate(getRoster().global.time || ''),
      ts: Date.now(),
      ...(delivered ? { verified: true } : {}),
    };
    mutatePhoneData(d => {
      const base = d.shop || emptyShopData();
      d.shop = { ...base, myReviews: upsertShopReview(base.myReviews, review) };
    });
    emitAch('phone_shop_review_written', { rating: review.rating, imgs: review.images.length, len: review.text.length }); // L21
    _sheet = null;
    emitPhoneEvent('ubp-phone:data-changed');
    redraw();
    return true;
  }
  return false;
}

/** 长按命中（app-shop 的 bindHintLongPress 回调转进来）：会话行 / 消息。 */
export function shopChatLongPressTarget(target: HTMLElement): { el: HTMLElement; fire: () => void } | null {
  const row = target.closest('.ubp-shc-crow') as HTMLElement | null;
  if (row) {
    const id = row.dataset.id || '';
    const seller = row.dataset.seller || '';
    if (id) return { el: row, fire: () => openShopThreadMenu(id, seller) };
  }
  const msg = target.closest('.ubp-shc-mrow') as HTMLElement | null;
  if (msg) {
    const mid = msg.dataset.mid || '';
    if (mid) return { el: msg, fire: () => openShopMessageMenu(mid) };
  }
  return null;
}

/** 长按会话行 → 全机统一动作面板（居中卡片 + 竖排药丸 + 末项取消）。 */
function openShopThreadMenu(threadId: string, seller: string): void {
  const container = _ctx?.container;
  if (!container) return;
  openActionSheet(container, {
    title: seller || shopSpec(currentStyle()).appName,
    actions: [
      { label: S('清空聊天记录', '清空符讯往来', '清空书信往来', '清空晶讯往来'), onPick: () => {
        clearShopThread(threadId, false);
        emitPhoneEvent('ubp-phone:data-changed');
        redraw();
      } },
      { label: S('删除会话', '删除往来', '删除往来', '删除往来'), tone: 'danger' as const, onPick: () => {
        clearShopThread(threadId, true);
        if (_threadId === threadId) _threadId = '';
        emitPhoneEvent('ubp-phone:data-changed');
        redraw();
      } },
      { label: S('取消', '作罢', '作罢', '作罢'), onPick: () => { /* 关闭 */ } },
    ],
  });
}

/** 长按消息 → 复制 / 引用 / 删除。 */
function openShopMessageMenu(messageId: string): void {
  const container = _ctx?.container;
  if (!container) return;
  const thread = currentThread();
  const msg = thread?.messages.find(m => m.id === messageId);
  if (!thread || !msg) return;
  const isImage = msg.type === 'image';
  openActionSheet(container, {
    title: msg.from === 'me' ? S('我的消息', '我的讯', '我的书信', '我的讯') : thread.seller,
    actions: [
      { label: S('复制', '抄录', '抄录', '抄录'), onPick: () => {
        copyShopText(msg.content);
      } },
      { label: S('引用', '引述', '引述', '引述'), onPick: () => {
        if (isImage) return;
        _quote = { from: msg.from, content: msg.content };
        redraw();
      } },
      { label: S('删除', '删除', '删除', '删除'), tone: 'danger' as const, onPick: () => {
        mutatePhoneData(d => {
          const t = (d.shop?.threads || []).find(x => x.id === thread.id);
          if (!t) return;
          t.messages = t.messages.filter(m => m.id !== messageId);
        });
        emitPhoneEvent('ubp-phone:data-changed');
        redraw();
      } },
      { label: S('取消', '作罢', '作罢', '作罢'), onPick: () => { /* 关闭 */ } },
    ],
  });
}

function copyShopText(text: string): void {
  try {
    const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator;
    void nav?.clipboard?.writeText?.(text);
  } catch (_e) { /* 剪贴板不可用不阻断 */ }
}

// ─── 供 app-shop 用的只读查询 ───

/** 未读商家消息总数（消息 tab 角标 / 桌面角标）。 */
export function shopChatUnreadTotal(): number {
  return shopThreadUnreadTotal(threads());
}

/** 会话列表（通知中心/深链用）。 */
export function shopChatThreads(): ShopThread[] {
  return threads();
}

/** 会话预览文案（通知中心/全局搜索用）。 */
export function shopChatThreadPreview(thread: ShopThread): string {
  const last = shopThreadLastMessage(thread);
  return last ? shopMessagePreview(last) : '';
}

/** 会话里某件商品的当前状态（调试/展示用）。 */
export function shopChatItemStatusLabel(itemName: string): string {
  return shopItemStatusLabel(shopItemStatus(shopData(), itemName));
}
