// ===== 小手机文字 AI 请求统一酒馆通知（聚合单条 toast） =====
// 与主项目 core/ai-activity-notify.ts 同口径：默认 3 秒自动隐去（aiNoticePersist=true 时常驻）；
// 点击 toast 本体终止第一条；关闭按钮只关通知。灵动岛/浮球与卡内终止不受该开关影响。
import { getToastr } from './host-env';
import { getPhoneSettings } from './phone-settings';
import { aiPhaseText } from '../../unified-statusbar/core/ai-text-features';
import {
  cancelPhoneAiActivity, listPhoneAiActivities, subscribePhoneAiActivities,
  type PhoneAiActivityEntry,
} from './ai-activity';

const TOAST_TITLE = '小手机 · AI 请求';
const AUTO_HIDE_MS = 3000;

let _inited = false;
let _toastEl: any = null;
let _toastText: Text | null = null;

function _hostDoc(): Document | null {
  try { return (window.parent as any).document || document; } catch (_e) { return document; }
}

function _toastAlive(el: any): boolean {
  try {
    const node = el?.[0] ?? el;
    return !!(node && node.isConnected !== false && node.parentNode);
  } catch (_e) { return false; }
}

function _closeToast(): void {
  const el = _toastEl;
  _toastEl = null;
  _toastText = null;
  if (!el) return;
  const toastr: any = getToastr();
  try { if (toastr && typeof toastr.clear === 'function') toastr.clear(el, { force: true }); } catch (_e) { /* ignore */ }
  try { el.remove?.(); } catch (_e) { /* ignore */ }
}

function _noticeText(entries: PhoneAiActivityEntry[]): string {
  if (!entries.length) return '';
  if (entries.length > 1) {
    const names = entries.slice(0, 3).map(e => e.label).join('、');
    const more = entries.length > 3 ? ' 等' : '';
    return `${entries.length} 项 AI 请求进行中：${names}${more}（点击终止）`;
  }
  const e = entries[0];
  return `${e.label} · ${aiPhaseText({ phase: e.phase, attempt: e.attempt, maxAttempts: e.maxAttempts })}${e.cancelable ? '（点击终止）' : ''}`;
}

function _ensureToast(text: string): void {
  const toastr: any = getToastr();
  if (!toastr || typeof toastr.info !== 'function') return;
  const persist = getPhoneSettings().aiNoticePersist === true;
  let el: any = null;
  try {
    el = toastr.info(text, TOAST_TITLE, {
      timeOut: persist ? 0 : AUTO_HIDE_MS,
      extendedTimeOut: 0,
      tapToDismiss: false,
      closeButton: true,
      progressBar: !persist,
    });
  } catch (_e) { return; }
  _toastEl = el;
  const doc = _hostDoc();
  const container: HTMLElement | undefined = el?.find?.('.toast-message')?.get?.(0);
  if (container && doc) {
    container.textContent = '';
    _toastText = doc.createTextNode(text);
    container.appendChild(_toastText);
  } else {
    _toastText = null;
  }
  const node: HTMLElement | undefined = el?.[0];
  if (node) {
    node.addEventListener('click', (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      if (target && target.closest && target.closest('.toast-close-button')) return;
      const list = listPhoneAiActivities().filter(e => e.cancelable && e.phase !== 'terminating');
      if (list.length) cancelPhoneAiActivity(list[0].id);
    });
  }
}

function _render(): void {
  const entries = listPhoneAiActivities().filter(e => e.suppressToast !== true);
  if (!entries.length) { _closeToast(); return; }
  const text = _noticeText(entries);
  if (!text) { _closeToast(); return; }
  if (_toastEl && _toastText && _toastAlive(_toastEl)) {
    _toastText.nodeValue = text;
    return;
  }
  _closeToast();
  _ensureToast(text);
}

/** 初始化统一通知（幂等）：订阅注册表，首次有活动时才创建 toast。 */
export function initPhoneAiActivityNotify(): void {
  if (_inited) return;
  _inited = true;
  subscribePhoneAiActivities(() => _render());
}

/** 测试用：重置内部句柄。 */
export function _resetPhoneAiActivityNotifyForTest(): void {
  _inited = false;
  _toastEl = null;
  _toastText = null;
}
