// ===== 编年史 App（docs/25）=====
// 只读视图：把 core/chronicle 聚合出的时间轴画成「按天分组的生活流」+「某一天的日视图」。
// 纪律与通知中心同款：打开时算一次、零新增存储、只读引用；点条目走既有深链
// （setPendingAppTarget + openApp，微信可带到具体消息）。
// 分页：默认最近 CHRONICLE_PAGE_DAYS 天，滑到顶再往前补——补的是「更早的天」，
// 重绘后按高度差回补 scrollTop（renders 铁律：任何 innerHTML 重建都要保滚动位）。

import {
  CHRONICLE_PAGE_DAYS,
  chronicleDayStats,
  collectChronicle,
  paginateChronicle,
  type ChronicleDay,
  type ChronicleEntry,
  type ChronicleView,
} from '../core/chronicle';
import { appDisplayColor, currentStyle, S } from '../core/skins';
import { getPhoneApp, setPendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { ubpIcon } from './icons';
import { createViewScrollMemo, escapeAttr, escapeHtml } from './phone-ui';

let _ctx: PhoneAppContext | null = null;
/** 已展开的天数（分页游标；重开 App 复位）。 */
let _visibleDays = CHRONICLE_PAGE_DAYS;
/** 日视图打开的日期键（null=主线）。 */
let _dayKey: string | null = null;
/** 本次渲染的聚合快照（分页只切它，不重复读盘）。 */
let _view: ChronicleView | null = null;
/** 分页节流（同一次滚动手势只补一屏）。 */
let _lastLoadAt = 0;
/** 跨视图滚动记忆（主线 ↔ 日视图；重开 App 复位）。 */
const _viewScroll = createViewScrollMemo();

/** 来源 → 品牌色（风格皮肤覆盖 → 注册表默认；图标恒用注册表 SVG，缩放安全）。 */
function sourceColor(appId: string): string {
  const app = getPhoneApp(appId);
  return appDisplayColor(appId, app?.color || '#8A8A8E', currentStyle());
}

function rowHtml(entry: ChronicleEntry): string {
  const color = sourceColor(entry.open.app);
  const icon = getPhoneApp(entry.open.app)?.icon || '';
  const chips = entry.chips?.length
    ? `<span class="ubp-chr-strip">${entry.chips.map(c => `<span class="ubp-chr-chip">${escapeHtml(c)}</span>`).join('')}</span>`
    : '';
  const shots = entry.thumbs?.length
    ? `<span class="ubp-chr-shots">${entry.thumbs.map(p => `<span style="background-image:url('${escapeAttr(p)}')"></span>`).join('')}</span>`
    : '';
  // 第六轮 ②：带 target 的条目点进去直达那条记录（各 App 首帧消费深链）；
  // 行尾箭头由灰转品牌色，把「这一条有去处」变成看得见的事。
  const live = Boolean(entry.open.target);
  return `<div class="ubp-chr-row" data-ubp-act="open" data-app="${escapeAttr(entry.open.app)}" data-conv="${escapeAttr(entry.open.conv || '')}" data-mid="${escapeAttr(entry.open.mid || '')}" data-target="${escapeAttr(entry.open.target || '')}">
      <div class="ubp-chr-time">${escapeHtml(entry.time)}</div>
      <div class="ubp-chr-rail"><i style="background:${escapeAttr(color)}"></i></div>
      <div class="ubp-chr-card">
        <span class="ubp-chr-ico" style="background:${escapeAttr(color)}">${icon}</span>
        <span class="ubp-chr-main">
          <span class="ubp-chr-head"><b>${escapeHtml(entry.title)}</b><em>${escapeHtml(entry.sourceLabel)}</em>${entry.count && entry.count > 1 ? `<em class="ubp-chr-n">${entry.count} 条</em>` : ''}</span>
          ${entry.text ? `<span class="ubp-chr-text">${escapeHtml(entry.text)}</span>` : ''}
          ${chips}${shots}
        </span>
        <span class="ubp-chr-go${live ? ' ubp-chr-go-live' : ''}">›</span>
      </div>
    </div>`;
}

function dayHtml(day: ChronicleDay): string {
  return `<div class="ubp-chr-day">
      <button type="button" class="ubp-chr-dayhead${day.today ? ' today' : ''}" data-ubp-act="day-open" data-day="${escapeAttr(day.day)}">
        <b>${escapeHtml(day.label)}</b><span>${day.count} 条</span>
      </button>
      ${day.entries.map(rowHtml).join('')}
    </div>`;
}

/** 未收录脚注（时间不可解析的记录；空态与有内容态都显示，口径与 mockup 一致）。 */
function footnoteHtml(undated: number): string {
  if (undated <= 0) return '';
  return `<div class="ubp-chr-foot"><b>另有 ${undated} 条记录没有绝对时间，未收录。</b><br>它们写入时只有相对说法（如「刚刚」）又缺锚点，按本项目的反漂移口径不做猜测。</div>`;
}

function emptyHtml(undated: number): string {
  return `<div class="ubp-chr-empty">${ubpIcon('calendar')}
      <b>还没有可以编年的记录</b>
      <span>聊天、通话、发帖、拍照、对局，只要有时间，都会自动长到这条轴上。</span>
    </div>${footnoteHtml(undated)}`;
}

function agendaHtml(view: ChronicleView): string {
  const { days, hasMore } = paginateChronicle(view.days, _visibleDays);
  const body = days.length
    ? `${days.map(dayHtml).join('')}${hasMore ? '<div class="ubp-chr-more">上滑加载更早</div>' : ''}${footnoteHtml(view.undated)}`
    : emptyHtml(view.undated);
  return `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="back" title="返回桌面">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${S('编年史', '岁华录', '江湖纪事')}</span>
      <button class="ubp-iconbtn" data-ubp-act="to-top" title="回到最近">${ubpIcon('calendar')}</button>
    </div>
    <div class="ubp-appbody noscroll">
      <div class="ubp-chr-scroll${days.length ? '' : ' empty'}" id="ubp-chr-scroll">${body}</div>
    </div>`;
}

function densityHtml(day: ChronicleDay): string {
  const segments = day.entries.map(entry => {
    const left = Math.min(95, ((entry.at % 1440) / 1440) * 100);
    return `<em style="left:${left.toFixed(2)}%;background:${escapeAttr(sourceColor(entry.open.app))}"></em>`;
  }).join('');
  const times = day.entries.map(entry => entry.time).filter(Boolean);
  const span = times.length ? `${times[0]} — ${times[times.length - 1]}` : '00:00 — 24:00';
  return `<div class="ubp-chr-daybar"><i>${segments}</i></div>
    <div class="ubp-chr-dayhead static"><b>活动密度</b><span>${escapeHtml(span)}</span></div>`;
}

function dayViewHtml(view: ChronicleView): string {
  const day = view.days.find(d => d.day === _dayKey);
  if (!day) return agendaHtml(view);
  const stats = chronicleDayStats(day.entries);
  return `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="back" title="返回">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${escapeHtml(day.label)}</span>
      <span class="ubp-iconbtn" style="visibility:hidden"></span>
    </div>
    <div class="ubp-appbody noscroll">
      <div class="ubp-chr-scroll" id="ubp-chr-scroll">
        <div class="ubp-chr-stats">
          <div class="ubp-chr-stat"><b>${stats.messages}</b><span>条消息</span></div>
          <div class="ubp-chr-stat"><b>${stats.calls}</b><span>通电话</span></div>
          <div class="ubp-chr-stat"><b>${stats.posts}</b><span>条动态</span></div>
          <div class="ubp-chr-stat"><b>${stats.photos}</b><span>张影像</span></div>
        </div>
        ${densityHtml(day)}
        ${day.entries.map(rowHtml).join('')}
      </div>
    </div>`;
}

function render(): void {
  const container = _ctx?.container;
  if (!container) return;
  _view = collectChronicle();
  // 跨视图保位：整页 innerHTML 会换掉滚动容器（#ubp-chr-scroll）⇒ 按视图键记忆，
  // 点进某天再返回主线回到离开处；重绘（分页/新记录）原位保全。
  const prevTop = (container.querySelector('#ubp-chr-scroll') as HTMLElement | null)?.scrollTop ?? 0;
  const key = _dayKey ? `day:${_dayKey}` : 'agenda';
  container.innerHTML = _dayKey ? dayViewHtml(_view) : agendaHtml(_view);
  const body = container.querySelector('#ubp-chr-scroll') as HTMLElement | null;
  if (body) body.scrollTop = _viewScroll.settle(key, prevTop).top;
}

/** 分页：补一屏更早的天，并按高度差回补滚动位（内容加在顶部，scrollTop≈0 时须等于高度差）。 */
function loadMore(): void {
  const container = _ctx?.container;
  const view = _view;
  if (!container || !view) return;
  if (!paginateChronicle(view.days, _visibleDays).hasMore) return;
  if (Date.now() - _lastLoadAt < 250) return; // 同一次手势只补一屏
  _lastLoadAt = Date.now();
  const body = container.querySelector('#ubp-chr-scroll') as HTMLElement | null;
  const prevHeight = body?.scrollHeight ?? 0;
  _visibleDays += CHRONICLE_PAGE_DAYS;
  render();
  const next = container.querySelector('#ubp-chr-scroll') as HTMLElement | null;
  if (next) next.scrollTop = Math.max(0, next.scrollHeight - prevHeight);
}

function scrollToTop(): void {
  const body = _ctx?.container.querySelector('#ubp-chr-scroll') as HTMLElement | null;
  if (body) body.scrollTop = 0;
}

function handleClick(ev: MouseEvent): void {
  const el = (ev.target as HTMLElement | null)?.closest?.('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  if (act === 'back') {
    if (_dayKey) { _dayKey = null; render(); return; } // 日视图内返回=回主线
    _ctx?.closeApp();
    return;
  }
  if (act === 'day-open') {
    _dayKey = el.dataset.day || null;
    render();
    return;
  }
  if (act === 'to-top') { scrollToTop(); return; }
  if (act === 'open') {
    const app = el.dataset.app || '';
    if (!app) return;
    const conv = el.dataset.conv || '';
    const target = el.dataset.target || '';
    // 有会话的（微信/窥私会话）带到具体位置；有记录 id 的（通话/社媒/不夜城/对局/相册）直达那条详情
    // （第六轮 ②）——两者只会有一个，均走各 App 既有的首帧深链入口；都没有则只开 App（回落列表）。
    if (conv) setPendingAppTarget(app, conv, el.dataset.mid || undefined);
    else if (target) setPendingAppTarget(app, target);
    _ctx?.openApp(app);
  }
}

function handleScroll(ev: Event): void {
  const el = ev.target as HTMLElement | null;
  if (!el || el.id !== 'ubp-chr-scroll' || _dayKey) return;
  if (el.scrollTop > 6) return;
  loadMore();
}

export const chronicleApp: PhoneApp = {
  id: 'chronicle',
  name: '编年史',
  icon: ubpIcon('calendar'),
  color: '#3E4A63',
  available: true,
  /** 返回键：日视图 → 主线（与屏幕上返回箭头同语义）；主线 → 交给壳层退回桌面。 */
  closeTopOverlay(): boolean {
    if (_dayKey) { _dayKey = null; render(); return true; }
    return false;
  },
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _visibleDays = CHRONICLE_PAGE_DAYS;
    _dayKey = null;
    _view = null;
    _lastLoadAt = 0;
    _viewScroll.clear(); // 重开 App = 新一轮，不继承上次打开时的滚动位置
    ctx.container.addEventListener('click', handleClick);
    ctx.container.addEventListener('scroll', handleScroll, true); // scroll 不冒泡，须捕获
    render();
    return () => {
      ctx.container.removeEventListener('click', handleClick);
      ctx.container.removeEventListener('scroll', handleScroll, true);
      _ctx = null;
      _view = null;
      _dayKey = null;
    };
  },
};
