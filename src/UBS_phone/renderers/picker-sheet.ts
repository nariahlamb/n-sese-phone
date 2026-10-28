// ===== 底部选择弹层（相机出镜角色/拍摄地点/音色抓取共用） =====
// 成熟选择交互：搜索过滤 + 分组吸顶 + 行内选中态；单选即点即走，多选暂存后确认。
// 自挂载 overlay（同 image-picker-sheet 模式），不依赖宿主 App 的 overlay 状态机。
// 分组数据每次打开求值一次（支持异步：弹层先显示加载态）；搜索只过滤已取到的数据。
// 多选行点击原地更新（不整列重渲染，保滚动位）；搜索输入才整列重渲染。
// 可选增强（缺省不出现 ⇒ 既有调用一字不动）：
//   selectAll   —— 多选底部「全选 / 全不选」钮（作用域=当前筛出来的行）；
//   extraAction —— 列表尾部「再拉一页」（分页拉取专用：追加去重、勾选保留、拉尽收「已到底」）；
//   item.actionHtml + onItemAction —— 行内小动作（音色面板的「▷ 试听」）：只回调、不改选择、不关面板；
//   toolbar     —— 顶部工具条（音色面板的「渠道」下拉）：换一套选项用，回调返回 true ⇒ 重取 groups 并重画列表。

import { hostDocument } from '../core/host-env';
import { escapeAttr, escapeHtml, pushSheetCloser } from './phone-ui';

export interface PickerItem {
  id: string;
  label: string;
  /** 次要说明行（角色简介/地点探索摘要），搜索同样命中。 */
  sub?: string;
  /** 默认勾选（首拉与「追加页」同口径）：带上则直接进勾选集。 */
  checked?: boolean;
  /** 行内小动作按钮的内容（图标 HTML，调用方自备转义）；与 options.onItemAction 同时给才出现。 */
  actionHtml?: string;
  /** 行内小动作的悬浮说明（缺省不设 title）。 */
  actionTitle?: string;
}

/** 顶部工具条（可选）：html 每次重画时求值；点/选工具条里 [data-ubp-pk="tb"] 的元素交给 onToolbarAct，
 *  返回 true ⇒ 调用方状态变了（如换了渠道）⇒ 清搜索词、重取 groups()、重画工具条。 */
export interface PickerToolbar {
  html: () => string;
  onToolbarAct: (act: string, el: HTMLElement) => boolean;
}

export interface PickerGroup {
  key: string;
  /** 分组标题（列表内吸顶）；空串 = 不出标题条。 */
  label: string;
  items: PickerItem[];
  /** 这一组**筛完为空**时顶替列表的位置说明（换行用 \n；搜索中不显示）。缺省不出现 ⇒ 既有调用一字不动。 */
  emptyHint?: string;
}

/** 列表尾部动作（「再拉一页」这类分页拉取；只在传入时出现）。 */
export interface PickerExtraAction {
  /** 按钮文案（每次渲染求值）。 */
  label: (ctx: { count: number }) => string;
  /** 是否还显示按钮（缺省恒显示）；返回 false 时若已拉过页，收成「已到底」提示。 */
  visible?: (ctx: { count: number }) => boolean;
  /** 执行拉取：返回新选项（追加、按 id 去重、带 checked 的直接勾上）；返回 null/[] = 本次没有新增。 */
  onAction: () => Promise<PickerItem[] | null>;
}

export interface PickerSheetOptions {
  /** 标题；传函数=每次追加后重求值（分页拉取用来显示「已加载 N 条」）。 */
  title: string | (() => string);
  /** 分组数据；传函数=打开时求值一次（支持异步：弹层先显示加载态）。 */
  groups: PickerGroup[] | (() => PickerGroup[] | Promise<PickerGroup[]>);
  /** 多选模式（默认单选）。 */
  multi?: boolean;
  /** 多选初始选中。 */
  selected?: string[];
  /** 多选上限（超出后新选中被忽略，计数行可见上限）。 */
  max?: number;
  /** 多选：底部「全选 / 全不选」钮（作用域=当前筛出来的行；缺省不出现）。 */
  selectAll?: boolean;
  /** 列表尾部动作（分页拉取；缺省不出现）。 */
  extraAction?: PickerExtraAction;
  /** 行内小动作点击（单选/多选皆可；配合 item.actionHtml）。 */
  onItemAction?: (id: string, el: HTMLElement) => void;
  /** 顶部工具条（换一套选项用；缺省不出现）。 */
  toolbar?: PickerToolbar;
  /** 单选：列表顶部「清除选择」行文案（搜索时隐藏）。 */
  clearLabel?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  loadingText?: string;
  errorText?: string;
  /** 多选确认按钮文案（旁列计数 n/max）。 */
  confirmLabel?: string;
  /** 单选：点选（id=''=清除）后自动关闭。 */
  onPick?: (id: string) => void;
  /** 多选：确认（含清空）后关闭。 */
  onConfirm?: (ids: string[]) => void;
}

/** 打开选择弹层（幂等：先移除同容器旧弹层）。 */
export function openPickerSheet(container: HTMLElement, opts: PickerSheetOptions): void {
  closePickerSheet(container);

  const multi = Boolean(opts.multi);
  const checked = new Set<string>(opts.selected || []);
  let groups: PickerGroup[] | null = null; // 异步提供方取回后缓存；搜索只过滤这份
  let query = '';
  let closed = false;
  let moreBusy = false; // 「再拉一页」进行中（防连点）
  let moreUsed = false; // 拉过至少一次：拉尽后收「已到底」而不是无声消失

  const doc = hostDocument();
  const titleText = (): string => typeof opts.title === 'function' ? opts.title() : opts.title;
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-picker-sheet';
  overlay.innerHTML = `
    <div class="ubp-sheet">
      <div class="ubp-sheet-head">
        <span class="ubp-sheet-headtitle">${escapeHtml(titleText())}</span>
        <button type="button" class="ubp-sheet-x" data-ubp-pk="close" title="关闭">✕</button>
      </div>
      ${opts.toolbar ? `<div class="ubp-picker-toolbar">${opts.toolbar.html()}</div>` : ''}
      <input class="ubp-fieldinput ubp-picker-search" type="text"
        placeholder="${escapeAttr(opts.searchPlaceholder || '搜索')}" autocomplete="off">
      <div class="ubp-picker-list"></div>
      <div class="ubp-picker-foot">
        <span class="ubp-picker-count"></span>
        ${multi && opts.selectAll ? '<button type="button" class="ubp-picker-all" data-ubp-pk="all">全选</button>' : ''}
        <button type="button" class="ubp-btn" data-ubp-pk="close">取消</button>
        ${multi ? `<button type="button" class="ubp-btn primary" data-ubp-pk="confirm">${escapeHtml(opts.confirmLabel || '完成')}</button>` : ''}
      </div>
    </div>`;
  container.appendChild(overlay);

  const listEl = overlay.querySelector('.ubp-picker-list') as HTMLElement;
  const searchEl = overlay.querySelector('.ubp-picker-search') as HTMLInputElement;
  const countEl = overlay.querySelector('.ubp-picker-count') as HTMLElement;
  const titleEl = overlay.querySelector('.ubp-sheet-headtitle') as HTMLElement | null;
  const allEl = overlay.querySelector('.ubp-picker-all') as HTMLButtonElement | null;
  const toolbarEl = overlay.querySelector('.ubp-picker-toolbar') as HTMLElement | null;

  const close = (): void => {
    closed = true;
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
  };
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
  doc.addEventListener('keydown', onKeydown, true);
  pushSheetCloser(close, () => overlay.isConnected);

  const hit = (item: PickerItem): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return item.label.toLowerCase().includes(q) || (item.sub || '').toLowerCase().includes(q);
  };

  const rowHtml = (item: PickerItem): string => {
    const on = checked.has(item.id);
    return `<div class="ubp-picker-row${on ? ' on' : ''}" data-ubp-pk="row" data-id="${escapeAttr(item.id)}">`
      + `<span class="ubp-check${on ? ' on' : ''}">${on ? '✓' : ''}</span>`
      + `<span class="ubp-picker-main"><span class="ubp-picker-label">${escapeHtml(item.label)}</span>`
      + (item.sub ? `<span class="ubp-picker-sub">${escapeHtml(item.sub)}</span>` : '')
      + `</span>`
      + (opts.onItemAction && item.actionHtml
        ? `<button type="button" class="ubp-picker-iact" data-ubp-pk="iact" data-id="${escapeAttr(item.id)}"${item.actionTitle ? ` title="${escapeAttr(item.actionTitle)}"` : ''}>${item.actionHtml}</button>`
        : '')
      + `</div>`;
  };

  /** 当前能看到的行（搜索过滤后）——「全选」的作用域就是这份，没搜索时即全部已加载项。 */
  const visibleItems = (): PickerItem[] => {
    if (!groups) return [];
    const out: PickerItem[] = [];
    for (const group of groups) for (const item of group.items) if (hit(item)) out.push(item);
    return out;
  };

  const allVisibleOn = (): boolean => {
    const vis = visibleItems();
    return vis.length > 0 && vis.every(item => checked.has(item.id));
  };

  const updateCount = (): void => {
    if (!multi || !countEl) return;
    countEl.textContent = `${checked.size}${opts.max ? `/${opts.max}` : ''}`;
  };

  const updateAllBtn = (): void => {
    if (allEl) allEl.textContent = allVisibleOn() ? '全不选' : '全选';
  };

  const updateTitle = (): void => {
    if (titleEl && typeof opts.title === 'function') titleEl.textContent = opts.title();
  };

  /** 列表尾部动作：还有下一页=按钮；拉尽=「已到底」；从未有过=什么都不出。 */
  const extraHtml = (): string => {
    if (!opts.extraAction) return '';
    const ctx = { count: checked.size };
    const visible = opts.extraAction.visible ? Boolean(opts.extraAction.visible(ctx)) : true;
    if (!visible) return moreUsed ? '<div class="ubp-picker-end">已到底</div>' : '';
    return `<button type="button" class="ubp-picker-more" data-ubp-pk="more">${escapeHtml(opts.extraAction.label(ctx))}</button>`;
  };

  const renderList = (): void => {
    if (!groups) return;
    let html = '';
    for (const group of groups) {
      const items = group.items.filter(hit);
      if (!items.length) {
        // 空组：有 emptyHint 就顶一格说明（换行走 white-space: pre-line）；搜索中不插（与 clearLabel 同口径）
        if (group.emptyHint && !query.trim()) html += `<div class="ubp-picker-empty">${escapeHtml(group.emptyHint)}</div>`;
        continue;
      }
      if (group.label) html += `<div class="ubp-picker-group">${escapeHtml(group.label)}</div>`;
      html += items.map(rowHtml).join('');
    }
    if (opts.clearLabel && !query.trim()) {
      html = `<div class="ubp-picker-row" data-ubp-pk="clear"><span class="ubp-check"></span>`
        + `<span class="ubp-picker-main"><span class="ubp-picker-label placeholder">${escapeHtml(opts.clearLabel)}</span></span></div>`
        + html;
    }
    if (!html) html = `<div class="ubp-picker-empty">${escapeHtml(opts.emptyText || '暂无可选项')}</div>`;
    listEl.innerHTML = html + extraHtml();
    updateAllBtn();
  };

  /** 整列重渲染但保滚动位（全选/追加页用；搜索输入仍回顶部）。 */
  const renderListKeepScroll = (): void => {
    const top = listEl.scrollTop;
    renderList();
    listEl.scrollTop = top;
  };

  const toggleRow = (row: HTMLElement, id: string): void => {
    if (checked.has(id)) {
      checked.delete(id);
    } else {
      if (opts.max !== undefined && checked.size >= opts.max) return; // 达上限：忽略（计数行可见上限）
      checked.add(id);
    }
    const on = checked.has(id);
    row.classList.toggle('on', on);
    const check = row.querySelector('.ubp-check');
    if (check) {
      check.classList.toggle('on', on);
      check.textContent = on ? '✓' : '';
    }
    updateCount();
    updateAllBtn();
  };

  /** 「全选 / 全不选」：对当前筛出来的行一键勾满 / 清空（未搜索时即全部已加载项）。 */
  const applyAll = (): void => {
    pickerToggleAllVisible(checked, visibleItems(), opts.max);
    updateCount();
    renderListKeepScroll();
  };

  /** 追加一页：按 id 去重（保留先到的行）、带 checked 的直接勾上（与首拉口径一致）。 */
  const appendItems = (items: PickerItem[]): void => {
    if (!groups) groups = [];
    if (pickerAppendItems(groups, items, checked)) updateCount();
  };

  const runMore = (): void => {
    const action = opts.extraAction;
    if (!action || moreBusy) return;
    moreBusy = true;
    const btn = listEl.querySelector('.ubp-picker-more') as HTMLButtonElement | null;
    const prev = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="ubp-spinner"></span>拉取中…';
    }
    Promise.resolve()
      .then(() => action.onAction())
      .then(items => {
        if (closed) return;
        moreUsed = true;
        if (Array.isArray(items) && items.length) {
          appendItems(items);
          updateTitle();
        }
        renderListKeepScroll();
      })
      .catch(() => {
        // 拉取失败：恢复按钮（调用方负责把可读错误提示出去），已勾选不受影响
        if (!closed && btn) {
          btn.disabled = false;
          btn.innerHTML = prev;
        }
      })
      .finally(() => { moreBusy = false; });
  };

  const ingest = (list: PickerGroup[]): void => {
    groups = list;
    for (const group of groups) for (const item of group.items) if (item.checked) checked.add(item.id);
    updateCount();
    renderList();
  };

  const loadGroups = (): void => {
    if (typeof opts.groups !== 'function') {
      ingest(opts.groups);
      return;
    }
    listEl.innerHTML = `<div class="ubp-picker-loading"><span class="ubp-spinner"></span><span>${escapeHtml(opts.loadingText || '加载中…')}</span></div>`;
    Promise.resolve()
      .then(opts.groups)
      .then(result => {
        if (closed) return;
        ingest(Array.isArray(result) ? result : []);
      })
      .catch(() => {
        if (!closed) listEl.innerHTML = `<div class="ubp-picker-empty">${escapeHtml(opts.errorText || '加载失败，请关闭后重试')}</div>`;
      });
  };

  /** 工具条动作（如换渠道）：调用方返回 true ⇒ 状态变了 —— 重画工具条 + 清搜索词 + 重取选项（列表回顶部）。
   *  勾选集同时**按新选项重建**：旧勾选属于旧那一套选项，留着会串到同名 id 上（单选面板的 ✓ 也走这里）。 */
  const runToolbarAct = (el: HTMLElement): void => {
    if (!opts.toolbar) return;
    if (!opts.toolbar.onToolbarAct(el.dataset.ubpPkTb || '', el)) return;
    if (toolbarEl) toolbarEl.innerHTML = opts.toolbar.html();
    if (query) {
      query = '';
      searchEl.value = '';
    }
    checked.clear();
    updateCount();
    loadGroups();
  };

  overlay.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement;
    if (target === overlay) {
      close(); // 点背景=取消（多选未确认的勾选不生效）
      return;
    }
    const el = target.closest('[data-ubp-pk]') as HTMLElement | null;
    if (!el) return;
    const act = el.dataset.ubpPk || '';
    if (act === 'close') {
      close(); // 取消/✕：多选未确认的勾选不生效
      return;
    }
    if (act === 'confirm') {
      opts.onConfirm?.([...checked]);
      close();
      return;
    }
    if (act === 'clear') {
      opts.onPick?.('');
      close();
      return;
    }
    if (act === 'all') {
      applyAll();
      return;
    }
    if (act === 'more') {
      runMore();
      return;
    }
    if (act === 'iact') {
      opts.onItemAction?.(el.dataset.id || '', el); // 行内小动作：不改选择、不关面板
      return;
    }
    if (act === 'tb') {
      runToolbarAct(el); // 工具条（下拉这类由 change 触发；此处兜住按钮形态）
      return;
    }
    if (act !== 'row') return;
    const id = el.dataset.id || '';
    if (multi) toggleRow(el as HTMLElement, id);
    else {
      opts.onPick?.(id);
      close();
    }
  });
  /* 工具条里的 <select>：选择走 change（点开下拉本身也发 click，别当成动作重复跑一次） */
  overlay.addEventListener('change', (event: Event) => {
    const node = event.target as HTMLElement | null;
    const el = node && typeof node.closest === 'function' ? node.closest('[data-ubp-pk="tb"]') as HTMLElement | null : null;
    if (el) runToolbarAct(el);
  });
  searchEl.addEventListener('input', () => {
    query = searchEl.value;
    renderList();
  });

  loadGroups();
}

/** 移除容器内已存在的选择弹层。 */
export function closePickerSheet(container: HTMLElement): void {
  container.querySelector('.ubp-picker-sheet')?.remove();
}

/** 「全选 / 全不选」的作用计算（导出供契约测试）：可见行已全勾 → 全清；否则全勾（max 封顶，不越限）。 */
export function pickerToggleAllVisible(checked: Set<string>, visible: readonly PickerItem[], max?: number): void {
  if (!visible.length) return;
  const allOn = visible.every(item => checked.has(item.id));
  if (allOn) {
    for (const item of visible) checked.delete(item.id);
    return;
  }
  for (const item of visible) {
    if (checked.has(item.id)) continue;
    if (max !== undefined && checked.size >= max) break;
    checked.add(item.id);
  }
}

/** 追加页合并（导出供契约测试）：并入最后一个分组（无分组时新建无标题组）、按 id 去重（保留先到的行）、
 *  带 `checked` 的项直接进勾选集（与首拉口径一致）；返回真正新增的条数（0 = 全为重复，调用方不必重渲）。 */
export function pickerAppendItems(groups: PickerGroup[], items: readonly PickerItem[], checked: Set<string>): number {
  if (!groups.length) groups.push({ key: 'more', label: '', items: [] });
  const seen = new Set<string>();
  for (const group of groups) for (const item of group.items) seen.add(item.id);
  const target = groups[groups.length - 1];
  let added = 0;
  for (const item of items) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    target.items.push(item);
    if (item.checked) checked.add(item.id);
    added++;
  }
  return added;
}
