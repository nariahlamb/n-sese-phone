// ===== 取景弹层（docs/13：非破坏性裁剪，全部换图流程共用） =====
// 拖动平移 + 滑杆缩放 + 90° 步进旋转 + 复位；预览框按目标显示位真实比例、同一份样式口径
// （cropMediaStyle 家族）渲染 ⇒ 所见即最终效果。应用=回传参数由调用方落库；取消=零副作用。
// 自挂载 overlay（同 image-picker-sheet 家族），不依赖宿主 App 的 overlay 状态机。
// 交互态就地更新（直接改媒体元素 style，不重建 DOM——保预览帧不闪，本仓「交互态局部变化优先原地更新」纪律）。
//
// 几何口径（本次修订要点，图文见 docs/wb-cover-crop-fix-mockup.html）：
//   媒体层 = 「cover 后的整张图」——按原图宽高比 a 定形、min 尺寸随缩放 z 放大，居中后整体
//   translate/rotate，由预览框 overflow:hidden 裁剪。整张图都在媒体层里 ⇒ 平移能把照片任意
//   高度（含顶部）移进窗口。旧口径把媒体铺成与框等大再 object-fit:cover：cover 会先把图按
//   居中裁进框、框外像素当场丢弃，平移永远拉不回来——这就是「长横条封面选不到照片上半部分」
//   的成因。平移上限按轴算 (1 − 框/图) × 50，且用实测尺寸 ⇒ 与框的比例无关。

import { normalizeCropParams, type PhoneCropParams } from '../core/chat-model';
import { hostDocument } from '../core/host-env';
import { escapeAttr, escapeHtml, pushSheetCloser } from './phone-ui';

export interface CropSheetOptions {
  /** 待取景的图片路径。 */
  src: string;
  /** 目标显示位宽高比（w/h）；预览框与显示位同比例。 */
  ratio: number;
  /** 渲染机制与目标显示位一致：img=图片元素（头像/通话背景）；bg=背景图层（聊天背景/壁纸/封面）。 */
  kind?: 'img' | 'bg';
  title?: string;
  /** 初始参数（缺省 = 未取景）。 */
  params?: PhoneCropParams;
  /** 应用（参数已含默认值；调用方负责落库与后续流程）。 */
  onApply: (params: PhoneCropParams) => void;
  /** 取消/关闭（参数不动）。 */
  onCancel?: () => void;
}

/** 打开取景弹层（幂等：先移除同容器旧弹层）。 */
export function openCropSheet(container: HTMLElement, opts: CropSheetOptions): void {
  container.querySelector('.ubp-crop-sheet')?.remove();
  const doc = hostDocument();
  const kind = opts.kind || 'img';
  const safeRatio = Number.isFinite(opts.ratio) && opts.ratio > 0 ? opts.ratio : 1;
  const start = opts.params;
  // 旧数据（无 a）的 x/y 是「% of 容器」口径，在新几何下没有意义 ⇒ 平移归零，缩放/旋转保留
  const legacyStart = Boolean(start) && start!.a === undefined;
  let x = legacyStart ? 0 : start?.x ?? 0;
  let y = legacyStart ? 0 : start?.y ?? 0;
  let z = start?.z ?? 1;
  let r = start?.r ?? 0;
  let a = start?.a ?? 0; // 0 = 尚未量出原图宽高比（此时退化为「铺满 + translate/scale」的旧观感）

  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-crop-sheet';
  overlay.innerHTML = `
    <div class="ubp-sheet">
      <div class="ubp-ip-title">${escapeHtml(`取景${opts.title ? ` · ${opts.title}` : ''}`)}</div>
      <div class="ubp-crop-box" style="aspect-ratio:${safeRatio}" data-ubp-cropbox="1">
        <div class="ubp-crop-media${kind === 'bg' ? ' bg' : ''}" data-ubp-cropmedia="1"${kind === 'bg' ? ` style="background-image:url('${escapeAttr(opts.src)}')"` : ''}>${kind === 'img' ? `<img src="${escapeAttr(opts.src)}" alt="" draggable="false">` : ''}</div>
      </div>
      <div class="ubp-crop-row">
        <span>缩放</span>
        <input type="range" min="100" max="300" step="1" value="${Math.round(z * 100)}" data-ubp-cropzoom="1">
        <span class="ubp-crop-zoomval" data-ubp-cropzoomval="1">${Math.round(z * 100)}%</span>
      </div>
      <div class="ubp-crop-tools">
        <button type="button" class="ubp-btn" data-ubp-crop="rotate">旋转 90°</button>
        <button type="button" class="ubp-btn" data-ubp-crop="reset">复位</button>
      </div>
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-crop="cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-crop="apply">应用</button>
      </div>
    </div>`;
  container.appendChild(overlay);

  const box = overlay.querySelector('[data-ubp-cropbox]') as HTMLElement;
  const media = overlay.querySelector('[data-ubp-cropmedia]') as HTMLElement;
  const zoom = overlay.querySelector('[data-ubp-cropzoom]') as HTMLInputElement | null;
  const zoomVal = overlay.querySelector('[data-ubp-cropzoomval]') as HTMLElement | null;

  /** 量出原图宽高比后启用新几何；量不出（加载失败）= 维持铺满旧观感。 */
  const probe = doc.createElement('img');
  probe.onload = () => {
    const w = probe.naturalWidth, h = probe.naturalHeight;
    if (w > 0 && h > 0) { a = w / h; paint(); }
  };
  probe.src = opts.src;

  /** 平移上限与媒体层实测尺寸。旋转 90°/270° 时框的宽高与媒体层错轴，按轴交换取近似
   *  （预览即最终效果，极端组合的露底用户当场可见）。 */
  const metrics = (): { mx: number; my: number; W: number; H: number } => {
    const fw0 = box.clientWidth || 1, fh0 = box.clientHeight || 1;
    const rot = r % 180 !== 0;
    const fw = rot ? fh0 : fw0, fh = rot ? fw0 : fh0;
    if (a <= 0) return { mx: (z - 1) * 50, my: (z - 1) * 50, W: fw0, H: fh0 };
    // 实测媒体层尺寸（已含 z：min 尺寸随 z 放大）⇒ 上限不依赖框/图比例，也不依赖调用方传的 ratio
    const W = media.offsetWidth || 1, H = media.offsetHeight || 1;
    return { mx: Math.max(0, (1 - fw / W) * 50), my: Math.max(0, (1 - fh / H) * 50), W, H };
  };

  const clampPan = (): void => {
    const { mx, my } = metrics();
    x = Math.max(-mx, Math.min(mx, x));
    y = Math.max(-my, Math.min(my, y));
  };

  const close = (fire: () => void): void => {
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    fire();
  };
  // 返回键 = 取消取景（与 Esc 同语义）
  pushSheetCloser(() => close(() => opts.onCancel?.()), () => overlay.isConnected);
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(() => opts.onCancel?.());
    }
  }
  doc.addEventListener('keydown', onKeydown, true);

  /** 交互态就地更新：只改媒体元素 style，不重建 DOM。
   *  顺序要紧：先落尺寸（z/a 决定媒体层大小）→ 量测 → 夹紧平移 → 再写 transform。 */
  const paint = (): void => {
    if (a > 0) {
      media.style.inset = 'auto';
      media.style.left = '50%';
      media.style.top = '50%';
      media.style.width = '';
      media.style.height = '';
      media.style.aspectRatio = String(a);
      media.style.minWidth = `calc(100% * ${z})`;
      media.style.minHeight = `calc(100% * ${z})`;
    } else {
      media.style.aspectRatio = '';
      media.style.minWidth = '';
      media.style.minHeight = '';
      media.style.inset = '0';
      media.style.width = '100%';
      media.style.height = '100%';
    }
    clampPan();
    media.style.transform = a > 0
      ? `translate(-50%,-50%) translate(${x}%,${y}%) rotate(${r}deg)`
      : `translate(${x}%,${y}%) scale(${z}) rotate(${r}deg)`;
    if (zoomVal) zoomVal.textContent = `${Math.round(z * 100)}%`;
  };

  // 拖动平移：pointer 捕获在预览框上；位移换算为「媒体层自身尺寸」百分比（与 transform 口径一致）
  let drag: { px: number; py: number; x0: number; y0: number; w: number; h: number } | null = null;
  box.addEventListener('pointerdown', (event: PointerEvent) => {
    const { W, H } = metrics();
    drag = { px: event.clientX, py: event.clientY, x0: x, y0: y, w: W, h: H };
    box.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  box.addEventListener('pointermove', (event: PointerEvent) => {
    if (!drag) return;
    x = drag.x0 + ((event.clientX - drag.px) / drag.w) * 100;
    y = drag.y0 + ((event.clientY - drag.py) / drag.h) * 100;
    paint();
  });
  const endDrag = (): void => { drag = null; };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  zoom?.addEventListener('input', () => {
    z = Math.max(1, Math.min(3, (Number(zoom.value) || 100) / 100));
    paint();
  });

  overlay.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement;
    if (target === overlay) { close(() => opts.onCancel?.()); return; } // 点背景=取消
    const act = target.closest('[data-ubp-crop]')?.getAttribute('data-ubp-crop') || '';
    if (act === 'cancel') close(() => opts.onCancel?.());
    else if (act === 'apply') {
      // 量不出原图尺寸 ⇒ 不写 a（落库走旧口径），免得渲染端按错误比例定形
      const params = normalizeCropParams(a > 0 ? { x, y, z, r, a } : { x, y, z, r });
      close(() => (params ? opts.onApply(params) : opts.onCancel?.()));
    } else if (act === 'rotate') {
      r = ((r + 90) % 360) as PhoneCropParams['r'];
      paint();
    } else if (act === 'reset') {
      x = 0; y = 0; z = 1; r = 0;
      if (zoom) zoom.value = '100';
      paint();
    }
  });

  paint();
}

/** 移除容器内已存在的取景弹层。 */
export function closeCropSheet(container: HTMLElement): void {
  container.querySelector('.ubp-crop-sheet')?.remove();
}
