// ===== 通用动作表单（薄包装：唯一实现已下沉到 phone-ui.openActionSheetCore，IA-01） =====
// 这里只保留「确认类」便捷构造，避免仓内并存两套弹层实现与两种关闭行为。
// ⚠️ 自挂载弹层会被容器 innerHTML 重建冲掉（本仓基线是全量重绘）。调用方纪律：
//    打开弹层前不得发生重绘；确认回调里先关弹层、再落库、再 render（关弹在 onPick 内已先行）。

import { openActionSheetCore, type ActionSheetAction } from './phone-ui';
import { S } from '../core/skins';

export type { ActionSheetAction };

export interface ActionSheetOptions {
  /** 标题。 */
  title: string;
  /** 说明正文（可选）。 */
  message?: string;
  /** 动作列表（至少一项；通常首项为「取消」）。 */
  actions: ActionSheetAction[];
  /** 未选项即被关闭（点背景 / Esc / 返回键）时的回调——供调用方回滚「先改了 DOM 再确认」的控件显示态。 */
  onDismiss?: () => void;
}

/** 打开动作表单（统一实现见 phone-ui.openActionSheetCore：Esc / 点背景 / 返回键 / 防误触）。 */
export function openActionSheet(container: HTMLElement, opts: ActionSheetOptions): void {
  openActionSheetCore(container, opts);
}

/** 便捷构造：确认类两选（取消 + 危险确认）。onCancel 供调用方回滚「先改了 DOM 再确认」的控件显示态
 *  （取消钮与点背景/Esc/返回键三条关闭路径都会触发）。 */
export function openConfirmSheet(
  container: HTMLElement,
  opts: { title: string; message?: string; confirmLabel?: string; onConfirm: () => void; onCancel?: () => void },
): void {
  openActionSheetCore(container, {
    title: opts.title,
    ...(opts.message ? { message: opts.message } : {}),
    layout: 'row', // IA-01 B 确认弹窗：横排「取消 | 确认」（menu 竖排版式留给长按动作面板）
    onDismiss: () => opts.onCancel?.(),
    actions: [
      { label: S('取消', '作罢'), onPick: () => { opts.onCancel?.(); } },
      { label: opts.confirmLabel || S('确认', '照办'), tone: 'danger', onPick: opts.onConfirm },
    ],
  });
}
