// ===== 皮肤配色预设 + 随机灵感（美化工坊「配色」卡的数据源；纯函数零依赖） =====
// 一套色板 = 16 枚核心 token 的亮/暗双档值（覆盖面与 docs/skins/example-skin.json 一致）。
// 只动「颜色族」token；布局/图标/字体不在色板职责内（那些由皮肤其它字段与美化工坊各自管理）。

export interface SkinPalettePreset {
  id: string;
  label: string;
  /** 亮档 token（键全部是基础 CSS 既有 --ubp-* 颜色 token）。 */
  tokens: Record<string, string>;
  /** 暗档 token。 */
  tokensDark: Record<string, string>;
}

/** 桌面图标底色随板（可选：色板顺带换一套 App 图标底色；键=App id）。 */
export interface SkinPaletteAccent {
  [appId: string]: string;
}

const T = (o: Record<string, string>) => o;

/** 内置色板（一键换肤：点击即整组覆写 tokens/tokensDark）。 */
export const SKIN_PALETTE_PRESETS: readonly SkinPalettePreset[] = [
  {
    id: 'cherry', label: '樱花信笺',
    tokens: T({
      '--ubp-bg': '#FBF3F4', '--ubp-card': '#FFFFFF', '--ubp-card-2': '#F9ECEE', '--ubp-text': '#3B2A30',
      '--ubp-text-2': '#8C737C', '--ubp-text-3': '#B39AA2', '--ubp-line': 'rgba(150, 84, 100, 0.16)',
      '--ubp-accent': '#E86A8A', '--ubp-accent-press': '#D25374', '--ubp-accent-soft': 'rgba(232, 106, 138, 0.13)',
      '--ubp-bubble-me': '#FBD6DE', '--ubp-bubble-me-text': '#4A2431', '--ubp-bubble-other': '#FFF8F9',
      '--ubp-badge': '#E8584A', '--ubp-link': '#B5586E', '--ubp-frame': '#3B2A30',
    }),
    tokensDark: T({
      '--ubp-bg': '#1A1114', '--ubp-card': '#241820', '--ubp-card-2': '#2C1E26', '--ubp-text': '#EBD9DE',
      '--ubp-text-2': '#A98F98', '--ubp-text-3': '#7E666E', '--ubp-line': 'rgba(240, 160, 180, 0.14)',
      '--ubp-accent': '#F291AB', '--ubp-accent-press': '#DE7C97', '--ubp-accent-soft': 'rgba(242, 145, 171, 0.15)',
      '--ubp-bubble-me': '#57303C', '--ubp-bubble-me-text': '#F7E3E9', '--ubp-bubble-other': '#2C1E26',
      '--ubp-badge': '#E8584A', '--ubp-link': '#E8A5B5', '--ubp-frame': '#140D0F',
    }),
  },
  {
    id: 'mint', label: '薄荷奶绿',
    tokens: T({
      '--ubp-bg': '#F2F9F4', '--ubp-card': '#FFFFFF', '--ubp-card-2': '#EAF5EE', '--ubp-text': '#2E4638',
      '--ubp-text-2': '#6A8175', '--ubp-text-3': '#93A89B', '--ubp-line': 'rgba(72, 156, 112, 0.20)',
      '--ubp-accent': '#4CAF83', '--ubp-accent-press': '#3D996F', '--ubp-accent-soft': 'rgba(76, 175, 131, 0.14)',
      '--ubp-bubble-me': '#BFE8CF', '--ubp-bubble-me-text': '#1D4630', '--ubp-bubble-other': '#F7FCF8',
      '--ubp-badge': '#E8865A', '--ubp-link': '#4A8A66', '--ubp-frame': '#2E4638',
    }),
    tokensDark: T({
      '--ubp-bg': '#14201A', '--ubp-card': '#1C2A22', '--ubp-card-2': '#22332A', '--ubp-text': '#D8E8DE',
      '--ubp-text-2': '#8AA294', '--ubp-text-3': '#6E8578', '--ubp-line': 'rgba(120, 200, 160, 0.16)',
      '--ubp-accent': '#6FCF9A', '--ubp-accent-press': '#5BC08A', '--ubp-accent-soft': 'rgba(111, 207, 154, 0.14)',
      '--ubp-bubble-me': '#2E5C44', '--ubp-bubble-me-text': '#DFF5E8', '--ubp-bubble-other': '#22332A',
      '--ubp-badge': '#E8865A', '--ubp-link': '#C9A24B', '--ubp-frame': '#101B14',
    }),
  },
  {
    id: 'obsidian', label: '曜石黑金',
    tokens: T({
      '--ubp-bg': '#F4F2ED', '--ubp-card': '#FFFFFF', '--ubp-card-2': '#EFEBE2', '--ubp-text': '#26221B',
      '--ubp-text-2': '#77705F', '--ubp-text-3': '#A39B87', '--ubp-line': 'rgba(120, 104, 60, 0.18)',
      '--ubp-accent': '#A9822F', '--ubp-accent-press': '#8F6C22', '--ubp-accent-soft': 'rgba(169, 130, 47, 0.14)',
      '--ubp-bubble-me': '#EADFC4', '--ubp-bubble-me-text': '#3A3018', '--ubp-bubble-other': '#FAF8F3',
      '--ubp-badge': '#B4543C', '--ubp-link': '#8A6D2E', '--ubp-frame': '#191611',
    }),
    tokensDark: T({
      '--ubp-bg': '#12100C', '--ubp-card': '#1C1913', '--ubp-card-2': '#242017', '--ubp-text': '#E8E1CF',
      '--ubp-text-2': '#A69C82', '--ubp-text-3': '#786F58', '--ubp-line': 'rgba(201, 162, 75, 0.16)',
      '--ubp-accent': '#D9B45C', '--ubp-accent-press': '#C5A047', '--ubp-accent-soft': 'rgba(217, 180, 92, 0.13)',
      '--ubp-bubble-me': '#463D24', '--ubp-bubble-me-text': '#F2E9D2', '--ubp-bubble-other': '#242017',
      '--ubp-badge': '#C96A4E', '--ubp-link': '#D9B45C', '--ubp-frame': '#0B0A07',
    }),
  },
  {
    id: 'ocean', label: '海盐蓝调',
    tokens: T({
      '--ubp-bg': '#F0F5FA', '--ubp-card': '#FFFFFF', '--ubp-card-2': '#E9F1F8', '--ubp-text': '#1F2D3A',
      '--ubp-text-2': '#6B7E8F', '--ubp-text-3': '#9AA9B6', '--ubp-line': 'rgba(60, 110, 160, 0.16)',
      '--ubp-accent': '#3E7BC0', '--ubp-accent-press': '#33689F', '--ubp-accent-soft': 'rgba(62, 123, 192, 0.13)',
      '--ubp-bubble-me': '#CBE2F6', '--ubp-bubble-me-text': '#1B3550', '--ubp-bubble-other': '#F6FAFD',
      '--ubp-badge': '#E8743C', '--ubp-link': '#3E6C9E', '--ubp-frame': '#1F2D3A',
    }),
    tokensDark: T({
      '--ubp-bg': '#10171F', '--ubp-card': '#182230', '--ubp-card-2': '#1E2A3A', '--ubp-text': '#D9E4EE',
      '--ubp-text-2': '#8B9CAC', '--ubp-text-3': '#667588', '--ubp-line': 'rgba(120, 170, 220, 0.14)',
      '--ubp-accent': '#6AA8E0', '--ubp-accent-press': '#5893CB', '--ubp-accent-soft': 'rgba(106, 168, 224, 0.14)',
      '--ubp-bubble-me': '#2A455F', '--ubp-bubble-me-text': '#DCEAF7', '--ubp-bubble-other': '#1E2A3A',
      '--ubp-badge': '#E8743C', '--ubp-link': '#9CC3E8', '--ubp-frame': '#0B0F14',
    }),
  },
  {
    id: 'sunset', label: '落日橙屿',
    tokens: T({
      '--ubp-bg': '#FCF5EF', '--ubp-card': '#FFFFFF', '--ubp-card-2': '#F9EEE4', '--ubp-text': '#3A2A20',
      '--ubp-text-2': '#8C7767', '--ubp-text-3': '#B39C8B', '--ubp-line': 'rgba(170, 100, 50, 0.16)',
      '--ubp-accent': '#E5813C', '--ubp-accent-press': '#C96D2A', '--ubp-accent-soft': 'rgba(229, 129, 60, 0.13)',
      '--ubp-bubble-me': '#FAD9BE', '--ubp-bubble-me-text': '#4A3018', '--ubp-bubble-other': '#FEFAF6',
      '--ubp-badge': '#D84A5A', '--ubp-link': '#B06A34', '--ubp-frame': '#3A2A20',
    }),
    tokensDark: T({
      '--ubp-bg': '#1A120D', '--ubp-card': '#241A13', '--ubp-card-2': '#2C2018', '--ubp-text': '#EDDECF',
      '--ubp-text-2': '#AE9681', '--ubp-text-3': '#82705E', '--ubp-line': 'rgba(235, 160, 90, 0.14)',
      '--ubp-accent': '#F2A45C', '--ubp-accent-press': '#DE9147', '--ubp-accent-soft': 'rgba(242, 164, 92, 0.14)',
      '--ubp-bubble-me': '#4E341C', '--ubp-bubble-me-text': '#F7E7D2', '--ubp-bubble-other': '#2C2018',
      '--ubp-badge': '#D84A5A', '--ubp-link': '#F2B57E', '--ubp-frame': '#100B07',
    }),
  },
  {
    id: 'lavender', label: '薰衣草田',
    tokens: T({
      '--ubp-bg': '#F5F3FB', '--ubp-card': '#FFFFFF', '--ubp-card-2': '#EEEAF8', '--ubp-text': '#2C2740',
      '--ubp-text-2': '#71678C', '--ubp-text-3': '#9C93B4', '--ubp-line': 'rgba(110, 90, 170, 0.16)',
      '--ubp-accent': '#7A5FC0', '--ubp-accent-press': '#6750A8', '--ubp-accent-soft': 'rgba(122, 95, 192, 0.13)',
      '--ubp-bubble-me': '#DED4F4', '--ubp-bubble-me-text': '#2E2450', '--ubp-bubble-other': '#FAF8FE',
      '--ubp-badge': '#D8566E', '--ubp-link': '#6A55A8', '--ubp-frame': '#2C2740',
    }),
    tokensDark: T({
      '--ubp-bg': '#15121E', '--ubp-card': '#1E1A2C', '--ubp-card-2': '#252038', '--ubp-text': '#E2DCEE',
      '--ubp-text-2': '#9A90B4', '--ubp-text-3': '#6F6788', '--ubp-line': 'rgba(170, 150, 230, 0.14)',
      '--ubp-accent': '#A58AE8', '--ubp-accent-press': '#9177D4', '--ubp-accent-soft': 'rgba(165, 138, 232, 0.14)',
      '--ubp-bubble-me': '#3B3158', '--ubp-bubble-me-text': '#E9E1F7', '--ubp-bubble-other': '#252038',
      '--ubp-badge': '#D8566E', '--ubp-link': '#BCA9EC', '--ubp-frame': '#0E0B15',
    }),
  },
  {
    id: 'matcha', label: '抹茶奶油',
    tokens: T({
      '--ubp-bg': '#F6F7EE', '--ubp-card': '#FFFFFF', '--ubp-card-2': '#EFF1E3', '--ubp-text': '#333826',
      '--ubp-text-2': '#79805F', '--ubp-text-3': '#A3A98B', '--ubp-line': 'rgba(110, 120, 60, 0.16)',
      '--ubp-accent': '#7E9438', '--ubp-accent-press': '#6A7E2C', '--ubp-accent-soft': 'rgba(126, 148, 56, 0.13)',
      '--ubp-bubble-me': '#E1EAC2', '--ubp-bubble-me-text': '#33401A', '--ubp-bubble-other': '#FBFCF6',
      '--ubp-badge': '#D07B3A', '--ubp-link': '#6E7E3A', '--ubp-frame': '#333826',
    }),
    tokensDark: T({
      '--ubp-bg': '#171A10', '--ubp-card': '#202415', '--ubp-card-2': '#272C1B', '--ubp-text': '#E4E8D2',
      '--ubp-text-2': '#A8AF8C', '--ubp-text-3': '#7C8364', '--ubp-line': 'rgba(190, 205, 130, 0.14)',
      '--ubp-accent': '#A8C055', '--ubp-accent-press': '#94AA45', '--ubp-accent-soft': 'rgba(168, 192, 85, 0.14)',
      '--ubp-bubble-me': '#414A22', '--ubp-bubble-me-text': '#EEF3DA', '--ubp-bubble-other': '#272C1B',
      '--ubp-badge': '#D07B3A', '--ubp-link': '#C3CF85', '--ubp-frame': '#0F1109',
    }),
  },
  {
    id: 'crimson', label: '暗夜绯红',
    tokens: T({
      '--ubp-bg': '#F8F1F1', '--ubp-card': '#FFFFFF', '--ubp-card-2': '#F4EAEA', '--ubp-text': '#362024',
      '--ubp-text-2': '#84666B', '--ubp-text-3': '#AC9095', '--ubp-line': 'rgba(140, 50, 60, 0.16)',
      '--ubp-accent': '#B43A4A', '--ubp-accent-press': '#9B303E', '--ubp-accent-soft': 'rgba(180, 58, 74, 0.13)',
      '--ubp-bubble-me': '#F0CFD2', '--ubp-bubble-me-text': '#451E24', '--ubp-bubble-other': '#FCF7F7',
      '--ubp-badge': '#C93A2E', '--ubp-link': '#9E3E48', '--ubp-frame': '#2A1518',
    }),
    tokensDark: T({
      '--ubp-bg': '#180F11', '--ubp-card': '#221618', '--ubp-card-2': '#2A1D20', '--ubp-text': '#EBDCDE',
      '--ubp-text-2': '#A98F93', '--ubp-text-3': '#7E666A', '--ubp-line': 'rgba(220, 120, 130, 0.14)',
      '--ubp-accent': '#E05C6C', '--ubp-accent-press': '#CB4A5A', '--ubp-accent-soft': 'rgba(224, 92, 108, 0.14)',
      '--ubp-bubble-me': '#502428', '--ubp-bubble-me-text': '#F5E2E4', '--ubp-bubble-other': '#2A1D20',
      '--ubp-badge': '#D84A3E', '--ubp-link': '#E88F9A', '--ubp-frame': '#0F0809',
    }),
  },
];

// ─── 随机灵感（HSL 调和配色：随机主色调 → 推整套亮/暗 token；纯函数、可反复摇） ───

/** HSL → #rrggbb（h 0-359 / s,l 0-100）。 */
function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const li = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(li, 1 - li);
  const f = (n: number): number => Math.round(255 * (li - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** rgba() 近似（供 -soft 透明色）。 */
function hslRgba(h: number, s: number, l: number, alpha: number): string {
  const sat = s / 100;
  const li = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(li, 1 - li);
  const f = (n: number): number => Math.round(255 * (li - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `rgba(${f(0)}, ${f(8)}, ${f(4)}, ${alpha})`;
}

/** 随机一套调和配色（亮/暗双档 16 token；每次调用主色相随机）。 */
export function randomSkinPalette(): { tokens: Record<string, string>; tokensDark: Record<string, string> } {
  const h = Math.floor(Math.random() * 360);
  const s = 42 + Math.floor(Math.random() * 26); // 42–67：饱和适中，不俗不灰
  return {
    tokens: {
      '--ubp-bg': hslHex(h, 30, 96), '--ubp-card': hslHex(h, 40, 99), '--ubp-card-2': hslHex(h, 30, 94),
      '--ubp-text': hslHex(h, 28, 16), '--ubp-text-2': hslHex(h, 14, 42), '--ubp-text-3': hslHex(h, 11, 58),
      '--ubp-line': hslRgba(h, 30, 30, 0.16),
      '--ubp-accent': hslHex(h, s + 14, 40), '--ubp-accent-press': hslHex(h, s + 14, 32), '--ubp-accent-soft': hslRgba(h, s + 14, 45, 0.14),
      '--ubp-bubble-me': hslHex(h, 40, 78), '--ubp-bubble-me-text': hslHex(h, 36, 17), '--ubp-bubble-other': hslHex(h, 34, 99),
      '--ubp-badge': hslHex((h + 165) % 360, 68, 50), '--ubp-link': hslHex(h, 32, 38), '--ubp-frame': hslHex(h, 26, 13),
    },
    tokensDark: {
      '--ubp-bg': hslHex(h, 22, 8), '--ubp-card': hslHex(h, 20, 12), '--ubp-card-2': hslHex(h, 18, 15),
      '--ubp-text': hslHex(h, 20, 86), '--ubp-text-2': hslHex(h, 12, 62), '--ubp-text-3': hslHex(h, 10, 47),
      '--ubp-line': hslRgba(h, 30, 80, 0.14),
      '--ubp-accent': hslHex(h, s + 10, 60), '--ubp-accent-press': hslHex(h, s + 10, 51), '--ubp-accent-soft': hslRgba(h, s + 10, 60, 0.14),
      '--ubp-bubble-me': hslHex(h, 36, 27), '--ubp-bubble-me-text': hslHex(h, 32, 88), '--ubp-bubble-other': hslHex(h, 18, 15),
      '--ubp-badge': hslHex((h + 165) % 360, 66, 58), '--ubp-link': hslHex(h, 36, 70), '--ubp-frame': hslHex(h, 24, 6),
    },
  };
}

// ─── 美化工坊 token 编辑器的分组目录（人工挑的常用面；「高级」区可自由加任意 token 键） ───

export interface SkinTokenMeta { key: string; label: string }

export const SKIN_TOKEN_GROUPS: ReadonlyArray<{ id: string; label: string; tokens: readonly SkinTokenMeta[] }> = [
  {
    id: 'surface', label: '底色', tokens: [
      { key: '--ubp-bg', label: '屏幕底色' }, { key: '--ubp-card', label: '卡片/导航' },
      { key: '--ubp-card-2', label: '次级底色' },
    ],
  },
  {
    id: 'text', label: '文字', tokens: [
      { key: '--ubp-text', label: '主文字' }, { key: '--ubp-text-2', label: '次级文字' },
      { key: '--ubp-text-3', label: '弱化文字' },
    ],
  },
  {
    id: 'accent', label: '强调色', tokens: [
      { key: '--ubp-accent', label: '主题强调' }, { key: '--ubp-accent-press', label: '强调·按下' },
      { key: '--ubp-accent-soft', label: '强调·浅底' },
    ],
  },
  {
    id: 'bubble', label: '聊天气泡', tokens: [
      { key: '--ubp-bubble-me', label: '我的气泡' }, { key: '--ubp-bubble-me-text', label: '我的气泡文字' },
      { key: '--ubp-bubble-other', label: '对方气泡' },
    ],
  },
  {
    id: 'misc', label: '点缀', tokens: [
      { key: '--ubp-badge', label: '未读红点' }, { key: '--ubp-link', label: '链接色' },
      { key: '--ubp-line', label: '分隔线' }, { key: '--ubp-frame', label: '机身/悬浮球' },
    ],
  },
];
