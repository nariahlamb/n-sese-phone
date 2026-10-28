export const STATUSBAR_CONTENT_FONT_SCALE_DEFAULT = 1.1;
export const STATUSBAR_CONTENT_FONT_SCALE_MIN = 1;
export const STATUSBAR_CONTENT_FONT_SCALE_MAX = 1.5;

type StyleRoot = { style: Pick<CSSStyleDeclaration, 'setProperty'> };

/** 状态栏正文倍率：默认 110%，范围 100%–150%，吸附到 5% 步进。 */
export function normalizeStatusbarContentFontScale(value: unknown): number {
  if (value === null || value === undefined || value === '') return STATUSBAR_CONTENT_FONT_SCALE_DEFAULT;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return STATUSBAR_CONTENT_FONT_SCALE_DEFAULT;
  const clamped = Math.min(
    STATUSBAR_CONTENT_FONT_SCALE_MAX,
    Math.max(STATUSBAR_CONTENT_FONT_SCALE_MIN, numeric),
  );
  return Math.round(clamped * 20) / 20;
}

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/** 预计算稳定 px token，避免依赖 zoom 或逐元素读取 computedStyle。 */
export function buildStatusbarContentFontVariables(scale: number): Record<string, string> {
  const normalized = normalizeStatusbarContentFontScale(scale);
  return {
    '--ub-content-font-scale': String(normalized),
    '--ub-content-font-10': px(10 * normalized),
    '--ub-content-font-11': px(11 * normalized),
    '--ub-content-font-12': px(12 * normalized),
    '--ub-content-font-13': px(13 * normalized),
    '--ub-content-font-label': px(Math.min(14, 11 * normalized)),
  };
}

/** 只写稳定文档根的 CSS 自定义属性；调用方无需扫描或重渲染正文节点。 */
export function applyStatusbarContentFontScale(
  scale: number,
  root: StyleRoot = document.documentElement,
): number {
  const normalized = normalizeStatusbarContentFontScale(scale);
  for (const [key, value] of Object.entries(buildStatusbarContentFontVariables(normalized))) {
    root.style.setProperty(key, value);
  }
  return normalized;
}
