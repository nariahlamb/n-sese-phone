export const UI_FONT_SCALE_DEFAULT = 1;
export const UI_FONT_SCALE_MIN = 1;
export const UI_FONT_SCALE_MAX = 1.5;

type StyleRoot = { style: Pick<CSSStyleDeclaration, 'setProperty'> };

/** 弹窗/设置面板字号倍率：默认 100%，范围 100%–150%，吸附到 5% 步进。 */
export function normalizeUiFontScale(value: unknown): number {
  if (value === null || value === undefined || value === '') return UI_FONT_SCALE_DEFAULT;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return UI_FONT_SCALE_DEFAULT;
  const clamped = Math.min(
    UI_FONT_SCALE_MAX,
    Math.max(UI_FONT_SCALE_MIN, numeric),
  );
  return Math.round(clamped * 20) / 20;
}

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/** 预计算稳定 px token。8 档覆盖弹窗/设置面板常见基准（含 10.5/11.5 中间档）。 */
export function buildUiFontVariables(scale: number): Record<string, string> {
  const normalized = normalizeUiFontScale(scale);
  return {
    '--ub-ui-font-9': px(9 * normalized),
    '--ub-ui-font-10': px(10 * normalized),
    '--ub-ui-font-10-5': px(10.5 * normalized),
    '--ub-ui-font-11': px(11 * normalized),
    '--ub-ui-font-11-5': px(11.5 * normalized),
    '--ub-ui-font-12': px(12 * normalized),
    '--ub-ui-font-12-5': px(12.5 * normalized),
    '--ub-ui-font-13': px(13 * normalized),
    '--ub-ui-font-14': px(14 * normalized),
  };
}

/** 只写稳定文档根的 CSS 自定义属性；调用方无需扫描或重渲染。 */
export function applyUiFontScale(
  scale: number,
  root: StyleRoot = document.documentElement,
): number {
  const normalized = normalizeUiFontScale(scale);
  for (const [key, value] of Object.entries(buildUiFontVariables(normalized))) {
    root.style.setProperty(key, value);
  }
  return normalized;
}
