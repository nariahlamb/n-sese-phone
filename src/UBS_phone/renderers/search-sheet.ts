// ===== 社媒搜索输入弹层（自挂载 overlay，照 hint-sheet / app-tieba openAddBarSheet 模式：不依赖宿主 App 的弹层状态机） =====
// 入口=社媒三 App 顶栏搜索胶囊（data-ubp-act="search"）→ 输入话题/关键词 → onSubmit 进该 App 搜索结果页并定向生成。
// 属性走 data-ubp-search 命名空间——宿主 App 的 data-ubp-act 委派分派不会吃掉事件。

import { hostDocument } from '../core/host-env';
import { escapeAttr, escapeHtml, pushSheetCloser } from './phone-ui';

export interface SearchSheetOptions {
  /** 弹层标题（如「搜索微博话题」）。 */
  title: string;
  /** 输入框占位（如「输入话题，如：临江暴雨」）。 */
  placeholder: string;
  /** 确认按钮文案（默认「搜索」）。 */
  submitLabel?: string;
  /** 确认回调（关键词已 trim；空串不回调）。 */
  onSubmit: (keyword: string) => void;
}

/** 打开搜索输入弹层（幂等：先移除同容器旧弹层）。 */
export function openSearchSheet(container: HTMLElement, opts: SearchSheetOptions): void {
  const doc = hostDocument();
  container.querySelector('.ubp-searchsheet')?.remove();
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-searchsheet';
  overlay.innerHTML = `
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">${escapeHtml(opts.title)}</div>
      <input class="ubp-fieldinput" id="ubp-searchsheet-input" maxlength="40" placeholder="${escapeAttr(opts.placeholder)}" autocomplete="off">
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-search="cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-search="ok">${escapeHtml(opts.submitLabel || '搜索')}</button>
      </div>
    </div>`;
  container.appendChild(overlay);
  const input = overlay.querySelector('#ubp-searchsheet-input') as HTMLInputElement;
  const close = (): void => overlay.remove();
  pushSheetCloser(close, () => overlay.isConnected);
  overlay.addEventListener('click', (e: Event) => {
    const el = (e.target as HTMLElement).closest('[data-ubp-search]') as HTMLElement | null;
    if (!el) {
      if (!(e.target as HTMLElement).closest('.ubp-sheet')) close(); // 点背景关闭
      return;
    }
    if (el.dataset.ubpSearch === 'cancel') { close(); return; }
    const keyword = input.value.trim();
    if (!keyword) { input.focus(); return; } // 空输入不关层，光标回到输入框
    close();
    opts.onSubmit(keyword);
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') (overlay.querySelector('[data-ubp-search="ok"]') as HTMLElement).click();
  });
}
