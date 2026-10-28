// ===== 幻想浏览器 App（第八轮 §5 · N8；第十轮 §1 换「AI 自绘网页」）=====
// 一个**诚实的幻想浏览器**：输入任意词（不做语义校验，空串才禁用）→ AI 按当前世界观编出 3-4 个
// 「网页」→ 结果列表 / 详情（详情是**一整张 AI 自绘的网页**，跑在 sandbox iframe 里）。
// 第十轮：前端不再渲染正文、也不再管样式——详情页只提供一块铺满的沙箱画布（sandbox 无令牌 + CSP），
// 页面自己的色板/字体/版式/动效全由 AI 的 <style> 决定；旧档（无 html）回落白名单 markdown 渲染。
// 真实感排版：结果列表照真网页走「站点徽记 → 站名 → 伪地址 → 标题 → 预览」；伪地址只在上方地址栏展示；
// 分享不在页面里（出戏）——收进页头 ⋯ 菜单，分享后落 link 链接卡（带页面描述 desc，进好友侧 AI 上下文）。
// 第十一轮：链接卡记 qid+idx+徽/色，点卡回跳那一页（takePendingAppPage 首帧消费 + findBrowserPage 三级回落）。
// 伪地址只展示，绝不请求。五态：home（搜索 + 最近搜索）/ loading（可终止）/ error / results / detail。
// 纪律：打开才读历史；生成走 browser-engine 三段式；中止走 abortBrowserGeneration（generation_id）；
//   列表滚动位按 `query:<id>` 记（createViewScrollMemo）。

import { S, currentStyle } from '../core/skins';
import { escapeAttr, escapeHtml } from '../core/ubp-utils';
import { getRoster, mergedContactNames } from '../core/roster';
import { ensurePrivateConversation, makeMessageId, type PhoneMessage } from '../core/chat-model';
import { mutatePhoneData, readPhoneDataRef } from '../core/phone-store';
import { selfStamp } from '../core/social-time';
import {
  browserUrlStyle, buildBrowserSrcdoc, deleteBrowserQuery, emptyBrowserData, findBrowserPage,
  mergeBrowserQuery, renderBrowserMarkdown, MAX_BROWSER_QUERIES, type BrowserPage, type BrowserQuery,
} from '../core/browser-model';
import { browserSpec } from '../core/browser-prompts';
import { abortBrowserGeneration, generateBrowserSearch } from '../core/browser-engine';
import { isPhoneAbortError } from '../core/phone-error';
import { emitPhoneEvent, takePendingAppPage, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openActionSheet, openConfirmSheet, type ActionSheetAction } from './action-sheet';
import { openPickerSheet } from './picker-sheet';
import { createViewScrollMemo, showScreenToast } from './phone-ui';
import { bindHintLongPress } from './hint-sheet';
import { ubpIcon } from './icons';
import { emitAch } from '../core/phone-achievements';

type BrowserView = 'home' | 'loading' | 'error' | 'results' | 'detail';

let _ctx: PhoneAppContext | null = null;
let _view: BrowserView = 'home';
let _input = '';
let _error = '';
let _currentId = '';
let _detailIdx = -1;
let _generating = false;
const _scroll = createViewScrollMemo();
const _longPressFiredAt = { at: 0 };

const appName = (): string => browserSpec(currentStyle()).appName;
const verb = (): string => browserSpec(currentStyle()).verb;
const resultsLabel = (): string => browserSpec(currentStyle()).resultsLabel;

function history(): BrowserQuery[] {
  return readPhoneDataRef().browser?.queries || [];
}

function currentQuery(): BrowserQuery | null {
  return history().find(q => q.id === _currentId) || null;
}

function currentPage(): BrowserPage | null {
  const q = currentQuery();
  return q && _detailIdx >= 0 ? (q.results[_detailIdx] || null) : null;
}

/** 伪地址的站名（分享卡「来源」用；纯展示）。 */
function siteOf(url: string): string {
  const u = String(url || '').trim();
  if (!u) return '';
  const modern = /^(?:https?:\/\/)?([^/?#]+)/i.exec(u);
  if (modern && /\./.test(modern[1])) return modern[1].replace(/^www\./i, '');
  const pseudo = u.split(/[·/]/)[0];
  return pseudo || u.slice(0, 40);
}

/** 地址栏文本（五态各自形态；纯展示）。 */
function urlText(): string {
  const style = browserUrlStyle(currentStyle());
  if (_view === 'home') return style.home;
  if (_view === 'loading') return style.results(_input);
  if (_view === 'results' || _view === 'error') {
    const q = currentQuery();
    return style.results(q?.query || _input);
  }
  const page = currentPage();
  return page?.url || style.home;
}

function shortDate(ms: number): string {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const body = container.querySelector('#ubp-br-scroll') as HTMLElement | null;
  // 滚动位按视图键记（结果页按查询 id 分键——与社媒/通话的 createViewScrollMemo 同款）
  const viewKey = `br:${_view}${_view === 'results' || _view === 'detail' ? `:${_currentId}` : ''}${_view === 'detail' ? `:${_detailIdx}` : ''}`;
  const restore = _scroll.settle(viewKey, body ? body.scrollTop : 0);
  const spec = browserSpec(currentStyle());
  const hist = history();
  let inner = '';
  if (_view === 'home') {
    const rows = hist.length
      ? hist.slice(0, 12).map(q => `<div class="ubp-br-hrow" data-ubp-act="open-history" data-id="${escapeAttr(q.id)}">
          ${ubpIcon('compass')}
          <span class="ubp-br-hmain"><b>${escapeHtml(q.query || '（空）')}</b><span class="t">${q.results.length} 条 · ${escapeHtml(q.storyTime || shortDate(q.createdAt))}</span></span>
          ${ubpIcon('chevron')}
        </div>`).join('')
      : `<div class="ubp-empty"><b>${S('还没有搜过什么', '尚无推演之问')}</b><br>${S('随便输点什么试试——结果由 AI 按当前世界观编出来', '随意写下想问之事——结果会依当世设定推演而出')}</div>`;
    inner = `
      <div class="ubp-br-hero">
        <div class="ubp-br-logo">${ubpIcon('compass')}<span>${escapeHtml(spec.appName)}</span></div>
        <div class="ubp-br-search">
          <input class="ubp-fieldinput" id="ubp-br-input" type="text" value="${escapeAttr(_input)}"
            placeholder="${escapeAttr(S('随便输点什么…', '随意写点什么…'))}" autocomplete="off">
          <button class="ubp-btn primary" data-ubp-act="search"${_input.trim() ? '' : ' disabled'}>${escapeHtml(verb())}</button>
        </div>
        <div class="ubp-br-hint">${S('幻想浏览器：整张网页由 AI 按当前世界观现画（含样式），不会真的上网。', '此乃幻想之器：整幅页面依当世设定现画（连同形制），不会真的去查。')}</div>
      </div>
      <div class="ubp-br-history">
        <div class="ubp-br-hd">${S('最近搜索', '近期推演')}</div>
        ${rows}
      </div>`;
  } else if (_view === 'loading') {
    inner = `<div class="ubp-br-loading">
        <span class="ubp-spinner"></span>
        <span>${S('正在搜索…', '正在推演…')}</span>
        <button class="ubp-btn" data-ubp-act="abort">${S('终止', '终止')}</button>
      </div>`;
  } else if (_view === 'error') {
    inner = `<div class="ubp-br-error">
        <b>${S('没能搜出来', '推演未成')}</b>
        <p>${escapeHtml(_error)}</p>
        <button class="ubp-btn" data-ubp-act="back-home">${S('返回', '返回')}</button>
      </div>`;
  } else if (_view === 'results') {
    const q = currentQuery();
    if (!q) { _view = 'home'; render(); return; }
    const cards = q.results.map((p, i) => {
      // 站点徽记（徽+色，可选）：真机搜索结果那枚 favicon 色块的位置——有它才像在逛不同的站
      const mark = p.mark
        ? `<span class="ubp-br-card-mark"${p.tint ? ` style="background:${escapeAttr(p.tint)}"` : ''}>${escapeHtml(p.mark)}</span>`
        : '';
      return `<div class="ubp-br-card" data-ubp-act="open-page" data-idx="${i}">
        <div class="ubp-br-card-head${mark ? ' has-mark' : ''}">
          ${mark}${p.site ? `<span class="ubp-br-card-site">${escapeHtml(p.site)}</span>` : ''}
          <span class="ubp-br-card-url">${escapeHtml(p.url || '—')}</span>
        </div>
        <div class="ubp-br-card-title">${escapeHtml(p.title)}</div>
        <div class="ubp-br-card-preview">${escapeHtml(p.preview || p.desc || '')}</div>
      </div>`;
    }).join('');
    inner = `<div class="ubp-br-querybar">
        <span class="q">${escapeHtml(q.query || '（空）')}</span>
        <span class="n">${S(`找到 ${q.results.length} 个${resultsLabel()}`, `得 ${q.results.length} 条${resultsLabel()}`)}</span>
      </div>
      <div class="ubp-br-results">${cards}</div>`;
  } else {
    const page = currentPage();
    if (!page) { _view = 'results'; render(); return; }
    // 详情页 = 一块铺满的沙箱画布：整张网页由 AI 自绘（自带 <style>），前端不渲染正文也不管样式。
    // 返回/分享都在工具层（页头 ‹ 与 ⋯）——「页面里长出分享钮」正是出戏源。伪地址由上方地址栏承载。
    // 旧档（无 html）回落白名单 markdown 渲染：还能读，只是没有站点自己的样子。
    inner = page.html
      ? `<iframe class="ubp-br-frame" sandbox="" title="${escapeAttr(page.title)}"></iframe>`
      : `<div class="ubp-br-doc">
        ${page.site ? `<div class="ubp-br-doc-site"><span class="ubp-br-doc-dot" aria-hidden="true"></span>${escapeHtml(page.site)}</div>` : ''}
        <h1 class="ubp-br-doc-title">${escapeHtml(page.title)}</h1>
        ${page.source ? `<div class="ubp-br-doc-src">${escapeHtml(page.source)}</div>` : ''}
        <div class="ubp-br-doc-body">${renderBrowserMarkdown(page.content || page.preview || '')}</div>
      </div>`;
  }
  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="back" title="${S('返回', '返回')}">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${escapeHtml(appName())}<span class="ubp-appbar-sub">（${hist.length}）</span></span>
      <button class="ubp-iconbtn" data-ubp-act="menu" title="${S('菜单', '菜单')}">${ubpIcon('more')}</button>
    </div>
    <div class="ubp-br-urlbar">${escapeHtml(urlText())}</div>
    <div class="ubp-appbody${_view === 'detail' && currentPage()?.html ? ' noscroll' : ''}" id="ubp-br-scroll">${inner}</div>`;
  const next = container.querySelector('#ubp-br-scroll') as HTMLElement | null;
  if (next) next.scrollTop = restore.top;
  // 自绘页里全是引号与 &，走属性转义易出错：占位 iframe 建好后直接赋 srcdoc（沙箱语义由 sandbox 属性给）。
  const frame = container.querySelector('.ubp-br-frame') as HTMLIFrameElement | null;
  if (frame) frame.srcdoc = buildBrowserSrcdoc(currentPage()?.html || '');
}

/** 开始一次检索（生成 → 落库 → 结果页）。 */
function runSearch(text: string): void {
  const query = String(text || '').trim();
  if (!query || _generating) return;
  _input = query;
  _view = 'loading';
  _error = '';
  _generating = true;
  // L9 成就：玩家亲手提交浏览器检索（与各 App 搜索框同口径=提交即计；结果由 AI 生成，成败不影响提交动作）
  emitAch('phone_search_performed', { scope: 'browser' });
  render();
  void (async () => {
    try {
      const res = await generateBrowserSearch({ query });
      if (!_ctx) return; // 期间被卸载
      const roster = getRoster();
      const storyTime = roster.global.time || '';
      const created: BrowserQuery = {
        id: `bq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        query: res.query || query,
        results: res.results,
        createdAt: Date.now(),
        ...(storyTime ? { storyTime } : {}),
        ...(storyTime && selfStamp(storyTime) ? { storyStamp: selfStamp(storyTime) } : {}),
      };
      mutatePhoneData(d => { d.browser = mergeBrowserQuery(d.browser || { queries: [] }, created); });
      _currentId = created.id;
      _view = 'results';
      _generating = false;
      render();
    } catch (e) {
      if (!_ctx) return;
      _generating = false;
      if (isPhoneAbortError(e)) { _view = 'home'; render(); return; } // 用户终止：静默回检索首页
      _error = e instanceof Error ? e.message : String(e);
      _view = 'error';
      render();
    }
  })();
}

/** 分享到微信：选联系人 → 落一条 link 链接卡（发送方=我方，不涨未读）。页面描述随卡落库=好友侧 AI 的读本。 */
function openShare(page: BrowserPage): void {
  if (!_ctx) return;
  const roster = getRoster();
  const names = mergedContactNames(roster, readPhoneDataRef().customContacts || []);
  if (!names.length) { showScreenToast(_ctx.container, S('通讯录还没有角色', '名录尚无人物')); return; }
  openPickerSheet(_ctx.container, {
    title: S('分享给…', '转呈给…'),
    groups: [{ key: 'contacts', label: S('联系人', '名录'), items: names.map(n => ({ id: n, label: n })) }],
    searchPlaceholder: S('搜索角色', '寻访人物'),
    emptyText: S('通讯录暂无角色', '名录暂无人物'),
    onPick: id => { if (id) shareTo(id, page); },
  });
}

/** 分享落库：把「那一页」的定位（检索 id + 序号 → 精确回跳）与徽记/主题色（缩略块）一并带上。 */
function shareTo(name: string, page: BrowserPage): void {
  const storyTime = getRoster().global.time || '';
  const qid = _currentId || '';
  const idx = _detailIdx;
  const msg: PhoneMessage = {
    id: makeMessageId(), from: 'me', type: 'link', content: page.title, ts: Date.now(),
    ...(storyTime ? { storyTime } : {}),
    link: {
      url: page.url,
      title: page.title,
      preview: page.preview,
      // 站名优先用页面顶栏的站名（「海城晚报 · 社会」比裸域名更像真卡片）；缺省回落域名
      site: page.site || siteOf(page.url),
      // 页面描述=分享后好友（AI）唯一读得到的内容；旧档无 desc 时回落搜索预览
      ...(page.desc ? { desc: page.desc } : {}),
      // 缩略块（徽+色）与回跳定位：旧档页面没有这两样就照旧不写（渲染与回跳都有回落）
      ...(page.mark ? { mark: page.mark } : {}),
      ...(page.tint ? { tint: page.tint } : {}),
      ...(qid && idx >= 0 ? { qid, idx } : {}),
    },
  };
  mutatePhoneData(d => {
    const conv = ensurePrivateConversation(d, name);
    conv.messages.push(msg);
    conv.updatedAt = Date.now();
  });
  if (_ctx) showScreenToast(_ctx.container, S(`已分享给 ${name}`, `已转呈给 ${name}`));
  // L9 成就：玩家亲手把网页分享到聊天成功（落 link 链接卡 ⇒ phone_msg_sent type='link'；目标是私聊恒非群）
  emitAch('phone_msg_sent', {
    type: 'link',
    isGroup: 0,
    len: page.title.length,
    quote: 0,
  });
  emitPhoneEvent('ubp-phone:data-changed'); // 会话列表预览要跟着变
}

/** 长按历史行：删除该条（确认）。 */
function confirmDeleteHistory(id: string): void {
  const container = _ctx?.container;
  const q = history().find(x => x.id === id);
  if (!container || !q) return;
  openConfirmSheet(container, {
    title: S('删除这条记录？', '删去这条记录？'),
    message: q.query,
    confirmLabel: S('删除', '删去'),
    onConfirm: () => {
      mutatePhoneData(d => { d.browser = deleteBrowserQuery(d.browser || { queries: [] }, id); });
      if (_currentId === id) { _currentId = ''; _view = 'home'; }
      render();
    },
  });
}

/** 页头 ⋯：在详情页时=分享（分享给好友）+ 清空历史；其余视图只有清空历史（分享是「分享当前页」，与真机一致）。 */
function openMenu(): void {
  const container = _ctx?.container;
  if (!container) return;
  const total = history().length;
  const page = _view === 'detail' ? currentPage() : null;
  const actions: ActionSheetAction[] = [];
  if (page) {
    actions.push({ label: S('分享到微信', '转呈入符讯'), onPick: () => { openShare(page); } });
  }
  actions.push(
    { label: S('清空历史', '清空记录'), tone: 'danger' as const, onPick: () => {
      openConfirmSheet(container, {
        title: S('清空检索历史？', '清空推演记录？'),
        message: S('只删本机的检索记录，不影响聊天与相册。', '只删本机记录，不伤符讯与影集。'),
        confirmLabel: S('清空', '清空'),
        onConfirm: () => {
          mutatePhoneData(d => { d.browser = { queries: [] }; });
          _currentId = '';
          _view = 'home';
          render();
        },
      });
    } },
    { label: S('取消', '作罢'), onPick: () => { /* 关闭 */ } },
  );
  openActionSheet(container, {
    title: `${appName()}（${total}）`,
    message: page
      ? S(`当前页面：${page.title}`, `当前卷目：${page.title}`)
      : S(`检索记录随聊天存档保存（上限 ${MAX_BROWSER_QUERIES} 次，超出丢最旧）。`, `推演记录随存档保存（上限 ${MAX_BROWSER_QUERIES} 次，超出丢最旧）。`),
    actions,
  });
}

function handleClick(event: Event): void {
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  if (act === 'back') {
    if (_view === 'detail') { _view = 'results'; render(); return; }
    if (_view === 'results' || _view === 'error') { _view = 'home'; render(); return; }
    _ctx?.closeApp();
    return;
  }
  if (act === 'menu') { openMenu(); return; }
  if (act === 'search') { runSearch(_input); return; }
  if (act === 'abort') {
    const stopped = abortBrowserGeneration();
    _generating = false;
    _view = 'home';
    render();
    if (_ctx) showScreenToast(_ctx.container, stopped ? S('已终止', '已终止') : S('这次搜索已经不在了', '这次推演已不在'));
    return;
  }
  if (act === 'back-home') { _view = 'home'; render(); return; }
  if (act === 'open-history') {
    if (Date.now() - _longPressFiredAt.at < 600) return; // 长按后的残留 click
    _currentId = el.dataset.id || '';
    _detailIdx = -1;
    _view = 'results';
    render();
    return;
  }
  if (act === 'open-page') {
    _detailIdx = Number(el.dataset.idx);
    _view = 'detail';
    render();
    return;
  }
}

export const browserApp: PhoneApp = {
  id: 'browser',
  name: appName(),
  icon: ubpIcon('compass'),
  color: '#4A6FA5',
  available: true,
  closeTopOverlay(): boolean {
    return false; // 动作面板/确认弹窗/选人弹层自管（pushSheetCloser）
  },
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _view = 'home';
    _input = '';
    _error = '';
    _currentId = '';
    _detailIdx = -1;
    _generating = false;
    _scroll.clear();
    // 链接卡回跳（第十一轮）：openApp 恒为卸载再挂载 ⇒ 目标在首帧消费一次即可，无需常驻监听。
    // 页面历史可被清空/被 20 条上限顶掉 ⇒ 三级回落；彻底没有就落首页并如实提示（提示放在首帧渲染之后）。
    const pageTarget = takePendingAppPage('browser');
    const pageHit = pageTarget ? findBrowserPage(readPhoneDataRef().browser || emptyBrowserData(), pageTarget) : null;
    if (pageHit) {
      _currentId = pageHit.query.id;
      _detailIdx = pageHit.index;
      _view = 'detail';
    }
    ctx.container.addEventListener('click', handleClick);
    // 输入：只记草稿（不整帧重绘，保焦点）；搜索按钮的 disabled 态就地切换
    const onInput = (event: Event): void => {
      const el = event.target as HTMLInputElement;
      if (!el || el.id !== 'ubp-br-input') return;
      _input = el.value;
      const btn = ctx.container.querySelector('[data-ubp-act="search"]') as HTMLButtonElement | null;
      if (btn) btn.disabled = !_input.trim();
    };
    ctx.container.addEventListener('input', onInput);
    // 长按历史行 = 删除（全机统一长按件；与相册/录音机同款）
    const unbindLongPress = bindHintLongPress(ctx.container, target => {
      if (ctx.container.querySelector('.ubp-overlay')) return null;
      const row = target.closest('.ubp-br-hrow') as HTMLElement | null;
      const id = row?.dataset.id || '';
      if (!row || !id) return null;
      return { el: row, fire: () => { _longPressFiredAt.at = Date.now(); confirmDeleteHistory(id); } };
    });
    render();
    // 回跳落空：页面首帧就位后再提示（toast 挂在屏幕层，不随 App 重绘消失）
    if (pageTarget && !pageHit) showScreenToast(ctx.container, S('原页面已不在，已打开首页', '原卷已佚，现归扉页'));
    return () => {
      ctx.container.removeEventListener('click', handleClick);
      ctx.container.removeEventListener('input', onInput);
      unbindLongPress();
      _ctx = null;
    };
  },
};
