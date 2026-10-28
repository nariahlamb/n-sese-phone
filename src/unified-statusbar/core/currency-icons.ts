// ===== 币种图标：唯一事实源（主项目与手机 bundle 共用）=====
// 为什么单开一个窄模块：手机 bundle 内嵌一份自己的运行环境，**不能** import core/icons.ts
// （那会把整张图标表打进手机分发包）；但两边必须同名同形——于是这 6 条路径只在这里定义：
//   · core/icons.ts 的 PATHS 用 `...CURRENCY_ICON_PATHS` 取用（图标表仍是唯一装配处）
//   · 小手机 core/currency-link.ts 直接取用本模块（含 currencyIconSvg）
// 改动纪律：新增币种图标只改这里 + CURRENCY_ICONS；两边自动一致（有测试锁）。
export type CurrencyIconName =
  | 'coin' | 'coin-jade' | 'coin-gold' | 'coin-ingot' | 'coin-copper' | 'coin-cash';

export const CURRENCY_ICONS: readonly CurrencyIconName[] = [
  'coin', 'coin-jade', 'coin-gold', 'coin-ingot', 'coin-copper', 'coin-cash',
];

/** 24×24 描边图形（外观属性由调用方的 .ub-ic / svg 属性控制，与 core/icons.ts 同规格）。 */
export const CURRENCY_ICON_PATHS: Record<CurrencyIconName, string> = {
  coin: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.1"/>',
  // coin-jade 键名沿用历史数据；UI 文案为「灵石」，图形=六棱晶石+顶面棱线+右上灵光
  'coin-jade': '<path d="M12 3.2l6.9 4v9.6l-6.9 4-6.9-4V7.2l6.9-4z"/><path d="M5.1 7.2l6.9 4 6.9-4"/><path d="M12 11.2v9.6"/><path d="M18.6 2.9l1.3 1.3-1.3 1.3-1.3-1.3 1.3-1.3z"/>',
  'coin-gold': '<circle cx="12" cy="12" r="8.2"/><path d="M12 8.4l1.04 2.1 2.32.34-1.68 1.64.4 2.32L12 13.74l-2.08 1.06.4-2.32-1.68-1.64 2.32-.34L12 8.4z"/>',
  // 元宝：船形托+中央顶起的元宝剪影（旧版“云朵+方盒”完全不像元宝，已重画）
  'coin-ingot': '<path d="M3.6 8.8c.6 4 4 7.2 8.4 7.2s7.8 0 8.4-7.2c-1 2.6-2.7 3.4-4.8 3-.5-1.6-1.7-2.6-3.6-2.6s-3.1 1-3.6 2.6c-2.1.4-3.8-.4-4.8-3z"/>',
  'coin-copper': '<circle cx="12" cy="12" r="8.3"/><rect x="9.4" y="9.4" width="5.2" height="5.2" rx="0.6"/>',
  'coin-cash': '<rect x="3.2" y="6.4" width="17.6" height="11.2" rx="2"/><circle cx="12" cy="12" r="2.7"/><path d="M6.4 10.1h.01M17.6 13.9h.01"/>',
};

/** 内联币种 SVG（currentColor 描边，尺寸随调用方）。 */
export function currencyIconSvg(icon: CurrencyIconName | string, size = 15): string {
  const inner = CURRENCY_ICON_PATHS[icon as CurrencyIconName] || CURRENCY_ICON_PATHS.coin;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}
