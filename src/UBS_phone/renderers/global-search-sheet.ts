// ===== 全局搜索（跨 App）：全屏结果页 =====
// 入口：桌面搜索胶囊（phone-ui renderHome 渲染）→ 回调本模块 openGlobalSearch(screen)。
// 结果页挂在 `.ubp-screen` 下（不是 `.ubp-app`）——App 重绘换 innerHTML 不会把它冲掉。
// 样式零新增组件：复用微信搜索页的 .ubp-cs-* 件与 .ubp-wx-grouphead；仅 .ubp-gsearch 层本身是新类。
// 检索本体在 core/global-search（纯函数、不含编年史）；本模块只做输入/渲染/跳转。
// 跳转走既有深链：微信（会话/聊天记录，带 mid 直达该条）与各 App 的 mount 首帧消费。

import { getRoster } from '../core/roster';
import { debounceTrailing } from '../core/ubp-utils';
import { currentStyle } from '../core/skins';
import { getPhoneSettings } from '../core/phone-settings';
import { readPhoneDataRef } from '../core/phone-store';
import { searchPhoneGlobal, type GlobalSearchResult, type GlobalSearchHit } from '../core/global-search';
import { hostDocument } from '../core/host-env';
import { setPendingAppTarget } from './app-registry';
import {
  avatarHtml,
  escapeAttr,
  escapeHtml,
  openApp,
  popSheetCloser,
  pushSheetCloser,
  setScreenOverlayClose,
} from './phone-ui';
import { ubpIcon } from './icons';
import { emitAch } from '../core/phone-achievements';

/** 支持「mount 首帧消费深链、直达详情」的 App。
 *  wechat 带 mid 直达该条消息；贴吧/微博/小红书/相册直达帖/笔记/条目详情；
 *  通话=记录 id（进通话详情）、对局=记录 id（进复盘详情）、不夜城=`post:<id>` / `dm:<id>`（两类详情）、
 *  窥私=会话 id（已有消费者）、**商城=商品 id（进商品详情）**。
 *  **朋友圈不在此列**：它没有帖详情页（评论内联），给了目标也无人消费 → 会留悬挂目标；只打开 App。 */
const DEEP_LINK_APPS = new Set(['wechat', 'tieba', 'weibo', 'xhs', 'album', 'phone-call', 'game-center', 'night', 'spy', 'shop']);

let _layer: HTMLElement | null = null;
let _keydown: ((e: KeyboardEvent) => void) | null = null;

/** 当前是否打开（供壳层/测试查询）。 */
export function isGlobalSearchOpen(): boolean {
  return Boolean(_layer && _layer.isConnected);
}

/** 关闭（幂等；animate 无参数——直接移除，不做淡出）。 */
export function closeGlobalSearch(): void {
  popSheetCloser(closeGlobalSearch);
  if (_keydown) {
    hostDocument()?.removeEventListener('keydown', _keydown, true);
    _keydown = null;
  }
  _layer?.remove();
  _layer = null;
  setScreenOverlayClose(null);
}

function resultHtml(result: GlobalSearchResult): string {
  if (!result.total) {
    return `<div class="ubp-empty"><b>没有找到相关内容</b><br>换个词试试：会话名、消息正文、通话转写、帖子标题、私信、相册画面描述</div>`;
  }
  return result.sections.map(sec => `
    <div class="ubp-wx-grouphead">${escapeHtml(sec.label)}（${sec.hits.length}）</div>
    ${sec.hits.map(hit => hitHtml(sec.key, sec.appId, hit)).join('')}`).join('');
}

function hitHtml(key: string, appId: string, hit: GlobalSearchHit): string {
  return `<div class="ubp-cs-row" data-ubp-gsearch="hit" data-key="${escapeAttr(key)}" data-app="${escapeAttr(appId)}" data-target="${escapeAttr(hit.targetId)}"${hit.mid ? ` data-mid="${escapeAttr(hit.mid)}"` : ''}>
      ${avatarHtml(hit.who || '?', 'small', true)}
      <span class="ubp-cs-main">
        <span class="ubp-cs-name">${escapeHtml(hit.title)}</span>
        <span class="ubp-cs-text">${escapeHtml(hit.excerpt || '…')}</span>
      </span>
      <span class="ubp-cs-time">${escapeHtml(hit.time)}</span>
    </div>`;
}

function renderResults(layer: HTMLElement, query: string): void {
  const scroll = layer.querySelector('.ubp-cs-scroll') as HTMLElement | null;
  if (!scroll) return;
  const roster = getRoster();
  const result = searchPhoneGlobal(readPhoneDataRef(), query, {
    now: roster.global.time,
    style: currentStyle(),
    includeSpy: getPhoneSettings().spyEnabled, // 窥私是可选功能：关着就不把它的内容摆到搜索结果里
  });
  scroll.innerHTML = resultHtml(result);
  scroll.scrollTop = 0;
}

/** 打开全局搜索（幂等：重复调用只重置输入）。screen=`.ubp-screen` 元素。 */
export function openGlobalSearch(screen: HTMLElement): void {
  const doc = hostDocument();
  if (!doc) return;
  closeGlobalSearch(); // 先清旧层，避免叠层
  const layer = doc.createElement('div');
  layer.className = 'ubp-gsearch';
  layer.innerHTML = `
    <div class="ubp-appbar ubp-cs-appbar">
      <span class="ubp-cs-field">${ubpIcon('search')}<input class="ubp-cs-input" id="ubp-gsearch-input" maxlength="40" placeholder="搜索：会话 / 聊天记录 / 帖子 / 相册" autocomplete="off"></span>
      <button type="button" class="ubp-cs-cancel" data-ubp-gsearch="cancel">取消</button>
    </div>
    <div class="ubp-cs-scroll"></div>
    <div class="ubp-homebar" data-ubp-gsearch="home"><span class="ubp-homebar-pill"></span></div>`;
  screen.appendChild(layer);
  _layer = layer;
  renderResults(layer, '');
  pushSheetCloser(closeGlobalSearch, () => Boolean(_layer && _layer.isConnected));
  setScreenOverlayClose(closeGlobalSearch);

  const input = layer.querySelector('#ubp-gsearch-input') as HTMLInputElement | null;
  input?.focus();
  // O41(第十二轮)：全局搜索要跨会话/通话/社媒/相册/窥私建串扫描，去抖 160ms（首帧仍即时渲染空态）。
  const scheduleResults = debounceTrailing(160, () => { if (_layer === layer) renderResults(layer, input?.value ?? ''); });
  input?.addEventListener('input', () => scheduleResults());

  layer.addEventListener('click', (e: Event) => {
    const el = (e.target as HTMLElement).closest('[data-ubp-gsearch]') as HTMLElement | null;
    if (!el) return;
    const kind = el.dataset.ubpGsearch;
    if (kind === 'cancel' || kind === 'home') { closeGlobalSearch(); return; }
    if (kind !== 'hit') return;
    const appId = el.dataset.app || '';
    const target = el.dataset.target || '';
    const mid = el.dataset.mid;
    if (!appId || !target) return;
    // L9 成就：全局搜索是实时过滤（无提交动作）——以「点中结果跳转」作为一次检索完成的代理口径
    emitAch('phone_search_performed', { scope: 'global' });
    closeGlobalSearch();
    // 深链（App 在 mount 首帧消费）+ 打开该 App；微信带 mid 直达该条消息。
    // 朋友圈等无详情页的 App 只打开、不设目标（避免悬挂目标永不被消费）。
    if (DEEP_LINK_APPS.has(appId)) setPendingAppTarget(appId, target, mid);
    openApp(appId);
  });

  // Esc 关闭（capture：先于宿主其它监听；与其它弹层同款纪律）
  _keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeGlobalSearch();
  };
  doc.addEventListener('keydown', _keydown, true);
}
