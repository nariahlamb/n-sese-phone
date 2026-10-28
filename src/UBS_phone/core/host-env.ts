// ===== 宿主环境访问（window.parent 兜底 window，兼容 dev iframe 与宿主注入两种形态） =====
// 与主项目 core/env.ts 同款纪律：跨源访问必须 try/catch。

import { getTavernHelper, getToastr, makeGenerationId, stopGenerationById } from '../../unified-statusbar/core/env';

export { getTavernHelper, getToastr, makeGenerationId, stopGenerationById };

/** 宿主 window（dev iframe 场景=parent；宿主注入场景=window 自身；Node 测试=globalThis 兜底）。 */
export function hostWindow(): Window {
  try {
    const parent = (typeof window !== 'undefined' ? window.parent : undefined) as Window | undefined;
    if (parent && parent !== window && parent.document && parent.document.body) return parent;
  } catch (_e) { /* cross-origin */ }
  if (typeof window !== 'undefined') return window;
  return globalThis as unknown as Window;
}

/** 宿主 document。 */
export function hostDocument(): Document {
  const win = hostWindow() as unknown as { document?: Document };
  return (win.document as Document) || (globalThis as any).document;
}

/**
 * 宿主弹 toastr 通知（安全包装，环境缺失时 console 兜底）。
 * 小手机 UI 在 Shadow DOM 内，跨 realm 的元素判断用 tagName 不用 instanceof。
 */
export function phoneNotify(message: string, title?: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  const toastr = getToastr();
  const text = `[小手机] ${message}`;
  try {
    if (!toastr) {
      (level === 'error' ? console.error : console.warn)(text, title || '');
      return;
    }
    if (level === 'error') toastr.error(message, title || '小手机');
    else if (level === 'warning') toastr.warning(message, title || '小手机');
    else toastr.info(message, title || '小手机');
  } catch (_e) { /* ignore */ }
}
