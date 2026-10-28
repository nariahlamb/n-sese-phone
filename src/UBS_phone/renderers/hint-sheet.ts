// ===== 一次性「本批额外提示」弹层（自挂载 overlay，照 image-picker-sheet 模式：不依赖宿主 App 的 overlay 状态机） =====
// 入口=长按任意手动生成按钮（微信生成条 ⋯/拨打电话/刷新/求回应/生成）→ 输入提示 → onConfirm(hint, picked) 走本次生成。
// 社媒刷新/求回应与窥私弹窗带焦点人物候选（contacts）：行内按钮打开 openPickerSheet
// （项目成熟选人方案：搜索+分组+多选暂存确认），勾选只作用于本次请求、不足由引擎随机补足。
// 属性走 data-ubp-hint* 命名空间——宿主 App 的 data-ubp-act 委派分派不会吃掉事件。

import { hostDocument } from '../core/host-env';
import { S } from '../core/skins';
import { bindPressCore, escapeAttr, escapeHtml, pushSheetCloser } from './phone-ui';
import { openPickerSheet } from './picker-sheet';

/** 打开瞬间起忽略点击（长按松手那次 click 落在弹层上，防刚开即被关）。 */
const STALE_CLICK_WINDOW_MS = 450;

export interface HintSheetOptions {
  /** 弹层标题（如「本批额外提示」「本次刷新提示」）。 */
  title: string;
  /** 确认按钮文案（默认「发送」）。 */
  confirmLabel?: string;
  /** 焦点人物候选（可选；胶囊行展示已选人名——点×就地移除，＋胶囊打开 openPickerSheet 多选；社媒/窥私弹窗传，聊天/通话不传）。 */
  contacts?: string[];
  /** 预置选中（如会话内「接着演」默认勾上本场成员；缺省=空）。 */
  initialPicked?: string[];
  /** 可选开关行（如窥私「只用选中的人（不随机补足）」）；缺省=不渲染该行。 */
  toggle?: { label: string; initial: boolean };
  /** 确认门扩展（在默认「提示或选人至少一项非空」之外再设门槛；返回 false 时确认钮禁用）。 */
  canConfirm?: (hint: string, picked: string[], toggleOn: boolean) => boolean;
  /** 确认回调（hint 已 trim；picked=勾选名单保序；toggleOn=开关行当前态，未配置开关时恒 false；三者全空不会回调）。 */
  onConfirm: (hint: string, picked: string[], toggleOn: boolean) => void;
}

/** 打开提示弹层（幂等：先移除同容器旧弹层）。 */
export function openOneShotHintSheet(container: HTMLElement, opts: HintSheetOptions): void {
  const doc = hostDocument();
  container.querySelector('.ubp-hintsheet')?.remove();
  const openedAt = Date.now();
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-hintsheet';
  let picked: string[] = opts.initialPicked ? [...opts.initialPicked] : [];
  let toggleOn = opts.toggle ? !!opts.toggle.initial : false;
  overlay.innerHTML = `
    <div class="ubp-sheet" data-ubp-hintstop="1">
      <div class="ubp-sheet-title">${escapeHtml(opts.title)}</div>
      ${opts.contacts && opts.contacts.length ? '<div class="ubp-hint-pills" id="ubp-hint-pills"></div>' : ''}
      <textarea class="ubp-textarea" id="ubp-hint-text" placeholder="${escapeAttr(S('（可选）想让这次生成注意什么', '（可选）想让这次生成留意什么', '（可选）想让这次推演留意什么', '（可选）想让这次生成留意什么'))}"></textarea>
      ${opts.toggle ? `<label class="ubp-hint-toggle"><input type="checkbox" id="ubp-hint-toggle"${toggleOn ? ' checked' : ''}><span>${escapeHtml(opts.toggle.label)}</span></label>` : ''}
      <div class="ubp-sheet-actions">
        <button class="ubp-btn" data-ubp-hint="cancel">${S('取消', '作罢')}</button>
        <button class="ubp-btn primary" data-ubp-hint="send" disabled>${escapeHtml(opts.confirmLabel || S('发送', '送出'))}</button>
      </div>
    </div>`;
  container.appendChild(overlay);

  const close = (): void => {
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
  };
  pushSheetCloser(close, () => overlay.isConnected);
  const textarea = overlay.querySelector('#ubp-hint-text') as HTMLTextAreaElement | null;
  const confirmBtn = overlay.querySelector('[data-ubp-hint="send"]') as HTMLButtonElement | null;
  const pillsEl = overlay.querySelector('#ubp-hint-pills') as HTMLElement | null;
  const toggleInput = overlay.querySelector('#ubp-hint-toggle') as HTMLInputElement | null;
  const syncConfirm = (): void => {
    if (!confirmBtn) return;
    const hint = (textarea?.value || '').trim();
    const baseOk = !!hint || picked.length > 0;
    const extraOk = opts.canConfirm ? opts.canConfirm(hint, [...picked], toggleOn) : true;
    confirmBtn.disabled = !(baseOk && extraOk);
  };
  /** 胶囊行：已选人名（点 × 就地移除）+ 尾部 ＋ 胶囊（打开选人弹层）；空态只有 ＋ 胶囊。 */
  const renderPills = (): void => {
    if (!pillsEl) return;
    pillsEl.innerHTML = picked.map(n =>
      `<span class="ubp-hint-pill">${escapeHtml(n)}<button type="button" class="ubp-hint-pill-x" data-ubp-hintx="${escapeAttr(n)}" title="移除">×</button></span>`
    ).join('')
      + `<button type="button" class="ubp-hint-pill add" data-ubp-hint="pick">＋ 指定焦点人物</button>`;
  };
  textarea?.addEventListener('input', syncConfirm);
  toggleInput?.addEventListener('change', () => {
    toggleOn = !!(toggleInput && toggleInput.checked);
    syncConfirm();
  });
  renderPills();
  syncConfirm();
  textarea?.focus();

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
  overlay.addEventListener('click', event => {
    // 长按松手的残留 click：忽略（不关弹层、不触发）
    if (Date.now() - openedAt < STALE_CLICK_WINDOW_MS) return;
    const target = event.target as HTMLElement;
    const removeBtn = target.closest('[data-ubp-hintx]') as HTMLElement | null;
    if (removeBtn) {
      const name = removeBtn.dataset.ubpHintx || '';
      picked = picked.filter(n => n !== name);
      renderPills();
      syncConfirm();
      return;
    }
    const act = target.closest('[data-ubp-hint]')?.getAttribute('data-ubp-hint') || (target === overlay ? 'cancel' : '');
    if (act === 'pick' && opts.contacts && opts.contacts.length) {
      // 成熟选人方案（picker-sheet）：搜索+多选暂存，确认后更新摘要与发送钮可用态
      openPickerSheet(container, {
        title: S('指定焦点人物', '指定焦点人物', '指定焦点人物', '指定焦点人物'),
        groups: [{ key: 'contacts', label: S('通讯录', '道友录'), items: opts.contacts.map(n => ({ id: n, label: n })) }],
        multi: true,
        selected: [...picked],
        confirmLabel: S('完成', '成了'),
        onConfirm: ids => {
          picked = ids;
          renderPills();
          syncConfirm();
        },
      });
      return;
    }
    if (act === 'cancel') close();
    else if (act === 'send' && confirmBtn && !confirmBtn.disabled) {
      const hint = (textarea?.value || '').trim();
      const names = [...picked];
      const withToggle = toggleOn;
      close();
      if (hint || names.length) opts.onConfirm(hint, names, withToggle);
    }
  });
  doc.addEventListener('keydown', onKeydown, true);
}

export interface HintLongPressHit {
  /** 命中的入口元素。 */
  el: HTMLElement;
  /** 长按触发动作（通常=打开提示弹层）。 */
  fire: () => void;
}

/**
 * 长按生成入口 → 触发动作（480ms；移动>10px/抬起取消；桌面右键同效）。返回解绑函数（unmount 成对移除）。
 * 与宿主 App 自身的 click 委派并存：松手后的残留 click 由弹层内的 STALE_CLICK_WINDOW_MS 兜住。
 * IA-06：底层与壳层内容长按共用 phone-ui.bindPressCore（同一份 480ms 计时器实现），语义不变——
 * 命中对象是 HintLongPressHit、已有提示弹层时不武装、不记「长按刚触发」（残留 click 由弹层自吞）。
 */
export function bindHintLongPress(container: HTMLElement, hit: (target: HTMLElement) => HintLongPressHit | null): () => void {
  return bindPressCore<HintLongPressHit>(container, {
    match: hit,
    onFire: found => found.fire(),
    guard: () => !container.querySelector('.ubp-hintsheet'),
  });
}