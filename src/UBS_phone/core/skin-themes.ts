// ===== 皮肤系统（视觉层）：与「风格」（core/skins.ts 文案/提示词层）正交 =====
// 皮肤只管外观：色彩 token / 机身桌面装饰 / 桌面图标（形状·配色·图形）/ 桌面时刻布局 / 默认字体字号。
// 作用域=全局设置（PhoneSettings.skin，设备级视觉偏好）；风格继续跟聊天走（提示词/App 数量/名词）。
// 优先级：用户显式设置（壁纸/字体/字号）> 皮肤 > 风格视觉段 > 现代默认。
//   —— 「皮肤盖过风格」由 CSS 顺序保证：.ubp-theme-* 段在 styles/phone-theme.ts 中置于 .ubp-skin-*（风格）之后，
//      同特异性下后写入者胜出；与 .ubp-dark（深浅色）正交叠加。
// 内置皮肤：sweet 甜恋糖果 / flirty 瑟瑟灵感（CSS 静态注入，未启用零开销）；
// 自定义皮肤：用户导入 JSON → normalizePhoneSkin 校验 → phoneSkinCss 生成 CSS 动态注入（仅启用时存在）。
// 安全边界：所有来自皮肤 JSON 的值一律经 saneCssValue/saneGlyph/saneSkinImageUrl 清洗后才进 CSS/DOM。

import { PHONE_FONT_FAMILIES, SKIN_HOME_CENTER_CSS } from '../styles/phone-theme';
import { getPhoneSettings, type PhoneSkinId } from './phone-settings';

/** 设置页「皮肤」选项（自定义项由设置页按 customSkin 是否存在动态追加）。 */
export const SKIN_OPTIONS: ReadonlyArray<{ id: PhoneSkinId; label: string }> = [
  { id: '', label: '默认' },
  { id: 'sweet', label: '甜恋糖果' },
  { id: 'flirty', label: '瑟瑟灵感' },
];

/** 当前皮肤（全局设置；脏值/未导入 custom 落回默认）。 */
export function currentSkinId(): PhoneSkinId {
  const skin = getPhoneSettings().skin;
  if (skin === 'custom' && !currentCustomSkin()) return '';
  return skin;
}

/** 当前自定义皮肤定义（未导入/脏数据=null）。 */
export function currentCustomSkin(): PhoneSkinDef | null {
  return normalizePhoneSkin(getPhoneSettings().customSkin);
}

// ─── 皮肤 JSON 结构（docs/14 皮肤创意手册；工坊界面说明见 docs/65） ───

export interface PhoneSkinAppOverride {
  /** 图标底色（CSS 颜色/渐变）。 */
  color?: string;
  /** 图标图形：单字/emoji 文本（≤4 字符，替换注册表 SVG）。 */
  glyph?: string;
  /** 图标图片：data:image URL（≤900KB）/ /user/images/ 图床路径 / http(s) 线上直链（铺满图标，优先级高于 glyph）。 */
  img?: string;
  /** 桌面显示名（仅改桌面标签；App 内文案跟风格，不改）。 */
  name?: string;
}

/** 自定义皮肤的内置基底（美化工坊从内置皮肤起步时携带；渲染=基底 class + 自定义段叠加）。 */
export type PhoneSkinBase = '' | 'sweet' | 'flirty';

/** 皮肤数值边界（美化工坊滑杆与 normalize 共用一份事实源；测试按此构造越界值）。 */
export const SKIN_LIMITS = {
  /** 桌面图标尺寸 px（默认 54=现状）。 */
  iconSize: { min: 44, max: 68, def: 54 },
  /** 每行图标数（默认 4）。 */
  columns: { min: 3, max: 6, def: 4 },
  /** 图标行距 px（默认 14）。 */
  gap: { min: 8, max: 24, def: 14 },
  /** 底栏图标尺寸 px（默认 50）。 */
  dockSize: { min: 40, max: 60, def: 50 },
  /** 壁纸蒙层不透明度（默认 0.42=现状 .ubp-home-scrim）。 */
  scrim: { min: 0, max: 0.85, def: 0.42 },
  /** 壁纸模糊 px（默认 0=不模糊）。 */
  blur: { min: 0, max: 24, def: 0 },
  /** 自定义 CSS 字符上限。 */
  cssMax: 12_000,
  /** 线上图床直链（图标图片/壁纸 url()）字符上限。 */
  imgUrlMax: 700,
} as const;

export interface PhoneSkinDef {
  /** 皮肤名（设置页「自定义」项显示；≤20 字）。 */
  name?: string;
  /** 派生基底：custom 皮肤叠加在内置皮肤之上（未覆盖的字段沿用基底视觉；applyChrome 据此叠加 .ubp-theme-sweet/flirty）。 */
  base?: PhoneSkinBase;
  /** 亮档 --ubp-* token 覆盖（键须为 --ubp- 前缀，值经 CSS 清洗）。 */
  tokens?: Record<string, string>;
  /** 暗档 token 覆盖（叠加在亮档上，深浅色=深色时生效）。 */
  tokensDark?: Record<string, string>;
  /** 默认字体：family=字体族 CSS 栈 / display=标题展示字体栈 / scale=默认字号缩放（0.85-1.25；用户动过字号滑杆则以用户为准）。 */
  font?: { family?: string; display?: string; scale?: number };
  /** 桌面：layout='center' 时刻居中呈现 / bg·bgDark=默认壁纸（CSS 背景值或图片 URL）/ overlay=壁纸上加深色蒙层+浅色文字（深底图可读）。
   *  scrim=壁纸蒙层不透明度（作用于用户自设壁纸；缺省 0.42）/ blur=壁纸模糊 px（缺省 0）。 */
  home?: {
    layout?: '' | 'center'; bg?: string; bgDark?: string; overlay?: boolean;
    scrim?: number; blur?: number;
  };
  /** 桌面图标：shape=形状 / size·columns·gap·dockSize=网格布局 / label=桌面标签颜色 / apps=按 App id 覆盖。 */
  icons?: {
    shape?: '' | 'round' | 'square' | 'squircle' | 'sharp';
    size?: number; columns?: number; gap?: number; dockSize?: number;
    label?: '' | 'white' | 'black';
    apps?: Record<string, PhoneSkinAppOverride>;
  };
  /** 自定义 CSS（≤12000 字符；黑名单关键字整段作废；Shadow Root 内注入=天然只作用于手机 UI）。 */
  css?: string;
}

// ─── 清洗（安全边界：皮肤 JSON 的每个值都必须过这里才能进 CSS/DOM） ───

/** C0 控制符剥除（按码点判定；no-control-regex 规则下不用控制符正则）。
 *  keepTabNewline=true 时放行 \t(9)/\n(10)/\r(13)——CSS 与多行值需要它们。 */
function stripControlChars(value: string, keepTabNewline = false): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 && !(keepTabNewline && (code === 9 || code === 10 || code === 13))) continue;
    out += ch;
  }
  return out;
}

/** 是否含 C0 控制符（同上范围）。 */
function hasControlChars(value: string): boolean {
  for (const ch of value) if (ch.charCodeAt(0) < 32) return true;
  return false;
}

/** CSS 值清洗：禁结构字符（{}<>;@）与控制符，限长。颜色/渐变/阴影/字体栈的合法字符全保留。 */
function saneCssValue(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().slice(0, max);
  if (!v || /[{}<>;@]/.test(v) || hasControlChars(v)) return null;
  return v;
}

/** token 键清洗：放行一切格式合法的自定义属性名，只挡下字号的档位族。
 *  此前只放行 --ubp- 前缀：皮肤作者写 --nz-（不夜城）、--gmc-（游戏中心）、--tb-、--wb-、--xhs-、
 *  --app-、--cl- 这些 App 调色板族会被**静默丢弃**（不报错、不提示），docs/14 第 6 节的真实 App
 *  色值基准表因此形同虚设，皮肤作者无从察觉。
 *  改为「只挡管线保留族」而非「只放行一个前缀」：以后新增 App 调色板无需回来改这里（不埋坑）。
 *  保留族 --fs-：字号档位是模块加载期用 --ubp-font-scale 算出的（styles/phone-theme.ts），
 *  放开会被绕过全机字号缩放管线；其余 token 全部只作用于 Shadow Root 内，越界改不动宿主。 */
const RESERVED_TOKEN_PREFIX = '--fs-';

function saneTokenKey(key: unknown): string | null {
  if (typeof key !== 'string' || key.length > 60) return null;
  if (!/^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) return null;
  return key.startsWith(RESERVED_TOKEN_PREFIX) ? null : key;
}

/** 图标图形清洗：去 HTML 结构字符与控制符，限 4 个字符（emoji 素慢单码位也占 2）。 */
function saneGlyph(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = stripControlChars(value.replace(/[<>{}]/g, '')).trim();
  return v && [...v].length <= 4 ? v : null;
}

/** 远程图片直链（线上图床）清洗：http(s) 直链、≤700 字符、必须是带点的主机名。
 *  禁空白/控制符与 `{}<>;\\"'` —— 这些能拆出 HTML 属性或 CSS 上下文；`@`（OSS 图像处理后缀）
 *  `?&=#%+~` 等 URL 常见成分放行（两处消费点：<img src> 过 escapeAttr、背景 url() 整体包在括号里）。
 *  消费口径：只作**图片**来源；自定义 CSS 里的 `url(` 仍整段作废（见 saneCustomCss）。 */
export function saneRemoteImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > SKIN_LIMITS.imgUrlMax) return null;
  if (!/^https?:\/\/[^/?#\s]+\.[^/?#\s]+/i.test(v)) return null;
  if (/[\s{}<>;\\"'`]/.test(v) || hasControlChars(v)) return null;
  return v;
}

/** 图标图片清洗：data:image URL（≤900KB）/ /user/images/ 酒馆图床路径 / http(s) 线上图床直链。 */
export function saneSkinImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) return v.slice(0, 900_000);
  if (/^\/user\/images\/[A-Za-z0-9_\-./]{1,260}$/.test(v)) return v;
  return saneRemoteImageUrl(v);
}

function saneColor(value: unknown): string | null {
  return saneCssValue(value, 240);
}

/** 背景值里的 url(...) 取值合法性：data:（导出内联形态）/ /user/images/ / http(s) 线上图床直链。
 *  其余（如 file:、javascript:、相对路径拼串）一律不认。 */
function saneBgUrlInner(url: string): boolean {
  if (/^data:[^)"']*$/.test(url)) return true;
  if (/^\/user\/images\/[A-Za-z0-9_\-./]{1,260}$/.test(url)) return true;
  return Boolean(saneRemoteImageUrl(url));
}

/** 壁纸背景值清洗：同 saneCssValue 的禁字符集；url(...) 整段取出单独校验（data: / 酒馆图床 /
 *  线上图床直链三种放行形态），其余字符照旧收紧。
 *  背景可以叠多层：`url(https://…/a.png), linear-gradient(...)` 合法。 */
function saneBgValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().slice(0, 8_000_000);
  if (!v) return null;
  const rest = v.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi,
    (_m, dq: string | undefined, sq: string | undefined, bq: string | undefined) =>
      (saneBgUrlInner((dq ?? sq ?? bq ?? '').trim()) ? '' : '\u0000'));
  if (/[{}<>;@]/.test(rest) || hasControlChars(rest)) return null;
  return v;
}

/** 自定义 CSS 黑名单：命中任一关键字=整段作废（url(/@import 一并禁掉，
 *  图片诉求走皮肤专用的 img/bg 字段——那些有各自的清洗与体积预算）。 */
const CSS_BLOCKED_KEYWORDS = ['</style', '<script', 'javascript:', 'vbscript:', 'expression(', 'behavior:', '@import', 'url('];

/** 自定义 CSS 清洗：≤12000 字符；黑名单关键字整段作废；剥除控制符（保留换行/制表符——CSS 合法成分）。 */
export function saneCustomCss(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.slice(0, SKIN_LIMITS.cssMax).trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  if (CSS_BLOCKED_KEYWORDS.some(k => lower.includes(k))) return '';
  return stripControlChars(text, true);
}

/** 数值收敛（clamp + 就近取整；供 normalize 的尺寸/布局字段共用）。 */
function clampNum(value: unknown, min: number, max: number, integer: boolean): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const v = Math.min(max, Math.max(min, value));
  return integer ? Math.round(v) : Math.round(v * 100) / 100;
}

function pickRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 皮肤 JSON 归一化：脏键/脏值一律丢弃（缺省回退现代默认，永不报错不白屏）。非对象=null。 */
export function normalizePhoneSkin(value: unknown): PhoneSkinDef | null {
  const raw = pickRecord(value);
  if (!raw) return null;
  const def: PhoneSkinDef = {};
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 20) : '';
  if (name) def.name = name;
  if (raw.base === 'sweet' || raw.base === 'flirty') def.base = raw.base;
  const pickTokens = (source: unknown): Record<string, string> | undefined => {
    const rec = pickRecord(source);
    if (!rec) return undefined;
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(rec)) {
      const k = saneTokenKey(key);
      const v = saneCssValue(val, 400);
      if (k && v) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  def.tokens = pickTokens(raw.tokens);
  def.tokensDark = pickTokens(raw.tokensDark);
  const font = pickRecord(raw.font);
  if (font) {
    def.font = {};
    const family = saneCssValue(font.family, 300);
    if (family) def.font.family = family;
    const display = saneCssValue(font.display, 300);
    if (display) def.font.display = display;
    const scale = typeof font.scale === 'number' && Number.isFinite(font.scale) ? font.scale : 1;
    if (scale !== 1) def.font.scale = Math.max(0.85, Math.min(1.25, scale));
    if (!Object.keys(def.font).length) delete def.font;
  }
  const home = pickRecord(raw.home);
  if (home) {
    def.home = {};
    if (home.layout === 'center') def.home.layout = 'center';
    const bg = saneBgValue(home.bg);
    if (bg) def.home.bg = bg;
    const bgDark = saneBgValue(home.bgDark);
    if (bgDark) def.home.bgDark = bgDark;
    if (home.overlay === true) def.home.overlay = true;
    const scrim = clampNum(home.scrim, SKIN_LIMITS.scrim.min, SKIN_LIMITS.scrim.max, false);
    if (scrim !== null) def.home.scrim = scrim;
    const blur = clampNum(home.blur, SKIN_LIMITS.blur.min, SKIN_LIMITS.blur.max, true);
    if (blur) def.home.blur = blur;
    if (!Object.keys(def.home).length) delete def.home;
  }
  const icons = pickRecord(raw.icons);
  if (icons) {
    def.icons = {};
    if (icons.shape === 'round' || icons.shape === 'square' || icons.shape === 'squircle' || icons.shape === 'sharp') def.icons.shape = icons.shape;
    if (icons.label === 'white' || icons.label === 'black') def.icons.label = icons.label;
    const size = clampNum(icons.size, SKIN_LIMITS.iconSize.min, SKIN_LIMITS.iconSize.max, true);
    if (size !== null) def.icons.size = size;
    const columns = clampNum(icons.columns, SKIN_LIMITS.columns.min, SKIN_LIMITS.columns.max, true);
    if (columns !== null) def.icons.columns = columns;
    const gap = clampNum(icons.gap, SKIN_LIMITS.gap.min, SKIN_LIMITS.gap.max, true);
    if (gap !== null) def.icons.gap = gap;
    const dockSize = clampNum(icons.dockSize, SKIN_LIMITS.dockSize.min, SKIN_LIMITS.dockSize.max, true);
    if (dockSize !== null) def.icons.dockSize = dockSize;
    const apps = pickRecord(icons.apps);
    if (apps) {
      const out: Record<string, PhoneSkinAppOverride> = {};
      for (const [id, val] of Object.entries(apps)) {
        if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) continue;
        const app = pickRecord(val);
        if (!app) continue;
        const override: PhoneSkinAppOverride = {};
        const color = saneColor(app.color);
        if (color) override.color = color;
        const glyph = saneGlyph(app.glyph);
        if (glyph) override.glyph = glyph;
        const img = saneSkinImageUrl(app.img);
        if (img) override.img = img;
        const appName = typeof app.name === 'string' ? app.name.trim().slice(0, 12) : '';
        if (appName) override.name = appName;
        if (Object.keys(override).length) out[id] = override;
      }
      if (Object.keys(out).length) def.icons.apps = out;
    }
    if (!Object.keys(def.icons).length) delete def.icons;
  }
  const css = saneCustomCss(raw.css);
  if (css) def.css = css;
  return def.name || def.base || def.tokens || def.tokensDark || def.font || def.home || def.icons || def.css ? def : null;
}

// ─── 内置皮肤桌面配色（仅图标底色等显示层；App 内色彩走 token 自动跟随） ───

/** 甜恋糖果：糖果罐 pastel 底色（白图形）。 */
export const SWEET_APP_COLORS: Record<string, string> = {
  wechat: '#FF8FAB', moments: '#F0996A', tieba: '#DFA842', weibo: '#A88BDC', xhs: '#F2708E',
  'phone-call': '#6FB5E0', camera: '#7A66C8', album: '#5FBFA0', spy: '#8E7AA8', settings: '#A592AF',
};

/** 瑟瑟灵感：秘纹方章深底色（白图形）。 */
export const FLIRTY_APP_COLORS: Record<string, string> = {
  wechat: '#D060A0', moments: '#B04878', tieba: '#9050C0', weibo: '#7A3E9E', xhs: '#E0558E',
  'phone-call': '#8440A8', camera: '#5E4A8E', album: '#A05088', spy: '#4A2F5E', settings: '#6E5A7E',
};

// ─── 渲染层取用（桌面图标：皮肤 > 风格 > 注册表默认；名称跟风格，皮肤仅可改桌面标签） ───

function skinApps(): Record<string, PhoneSkinAppOverride> {
  if (currentSkinId() !== 'custom') return {};
  return currentCustomSkin()?.icons?.apps || {};
}

/** 桌面图标底色：内置皮肤色表 → 自定义皮肤（含基底）覆盖 → fallback（风格色表/注册表）。 */
export function skinAppColor(id: string, fallback: string): string {
  const skinId = currentSkinId();
  if (skinId === 'sweet') return SWEET_APP_COLORS[id] || fallback;
  if (skinId === 'flirty') return FLIRTY_APP_COLORS[id] || fallback;
  if (skinId === 'custom') {
    const def = currentCustomSkin();
    if (def?.base === 'sweet') return def.icons?.apps?.[id]?.color || SWEET_APP_COLORS[id] || fallback;
    if (def?.base === 'flirty') return def.icons?.apps?.[id]?.color || FLIRTY_APP_COLORS[id] || fallback;
  }
  return skinApps()[id]?.color || fallback;
}

/** 自定义皮肤的派生基底（applyChrome 据此额外叠加 .ubp-theme-sweet/flirty class）。 */
export function skinBaseId(def: PhoneSkinDef | null): PhoneSkinBase {
  return def?.base || '';
}

/** 桌面 App 显示名：自定义皮肤 name 覆盖 → fallback（风格名词/注册表名）。 */
export function skinAppName(id: string, fallback: string): string {
  return skinApps()[id]?.name || fallback;
}

/** 桌面图标内容 HTML：自定义皮肤图片 > 文本图形 > fallback（注册表 SVG/风格 glyph）。 */
export function skinAppIcon(id: string, fallbackIcon: string): string {
  const override = skinApps()[id];
  if (!override) return fallbackIcon;
  if (override.img) return `<img class="ubp-appicon-img" src="${escapeAttr(override.img)}" alt="">`;
  if (override.glyph) return `<span class="ubp-skin-glyph">${escapeAttr(override.glyph)}</span>`;
  return fallbackIcon;
}

// 转义统一走 core/ubp-utils（原先此处还有一份 escapeAttrLocal 私有实现——本次收编时删除）
import { escapeAttr } from './ubp-utils';

// ─── 自定义皮肤 CSS 生成（设置导入后由 phone-ui 注入 shadow root；类名 .ubp-theme-custom） ───

const CUSTOM = '.ubp-scope.ubp-theme-custom';

/** App 调色板命名空间 → 定义该族的 App 根选择器。
 *  这些变量不是定义在 .ubp-scope 上，而是各 App 根元素**就地定义**（.ubp-nz 夜景 / .ubp-gm-page 街机 /
 *  .ubp-tb 吧 / .ubp-wb 热搜 / .ubp-xhs 小红书）：CSS 自定义属性按「就近定义」继承，写在 .ubp-scope 上
 *  会被 App 根自己的定义盖住 ⇒ 皮肤必须投递到根选择器才有同元素特异性可比（与风格层的
 *  `.ubp-skin-xianxia .ubp-wb{--wb-acc:…}` 同一投递方式）。
 *  --app-* / --segl 是跨 App 组件契约（各 App 根各自赋值），同样投到全部根。 */
const APP_TOKEN_ROOTS: Array<{ prefix: string; roots: string[] }> = [
  { prefix: '--nz-', roots: ['.ubp-nz'] },
  { prefix: '--gmc-', roots: ['.ubp-gm-page'] },
  { prefix: '--tb-', roots: ['.ubp-tb'] },
  { prefix: '--wb-', roots: ['.ubp-wb'] },
  { prefix: '--xhs-', roots: ['.ubp-xhs'] },
  { prefix: '--app-', roots: ['.ubp-nz', '.ubp-gm-page', '.ubp-tb', '.ubp-wb', '.ubp-xhs'] },
  { prefix: '--segl', roots: ['.ubp-tb', '.ubp-wb', '.ubp-xhs'] },
];

/** App 命名空间前缀（这些键不进 .ubp-scope 档，改投 App 根）。 */
const APP_TOKEN_PREFIXES = APP_TOKEN_ROOTS.map(r => r.prefix);

/** 归一化皮肤 → CSS 文本（置于主样式之后注入，同特异性下覆盖基础与风格段）。 */
export function phoneSkinCss(def: PhoneSkinDef): string {
  const parts: string[] = [];
  // App 调色板族单独投递（见 APP_TOKEN_ROOTS）——留在 .ubp-scope 档里只会是死声明
  const declScope = (tokens?: Record<string, string>): string =>
    Object.entries(tokens || {}).filter(([key]) => !APP_TOKEN_PREFIXES.some(p => key.startsWith(p)))
      .map(([key, val]) => `${key}:${val};`).join('');
  const declApp = (tokens: Record<string, string> | undefined, dark: boolean): string => {
    if (!tokens) return '';
    const out: string[] = [];
    for (const { prefix, roots } of APP_TOKEN_ROOTS) {
      const decls = Object.entries(tokens).filter(([key]) => key.startsWith(prefix))
        .map(([key, val]) => `${key}:${val};`).join('');
      if (!decls) continue;
      for (const root of roots) {
        out.push(dark ? `${CUSTOM}.ubp-dark ${root}{${decls}}` : `${CUSTOM}:not(.ubp-dark) ${root}{${decls}}`);
      }
    }
    return out.join('');
  };
  // 字体/字号：类默认档（用户行内设置优先级更高，applyChrome 已保证）
  const font = def.font || {};
  const fontDecls: string[] = [];
  if (font.family) fontDecls.push(`--ubp-font:${font.family};`);
  if (font.display) fontDecls.push(`--ubp-font-display:${font.display};`);
  if (font.scale && font.scale !== 1) fontDecls.push(`--ubp-font-scale:${font.scale};`);
  if (fontDecls.length) parts.push(`${CUSTOM}{${fontDecls.join('')}}`);
  // token：亮档 + 暗档（:not(.ubp-dark)/.ubp-dark 同特异性成对，后段胜出与内置皮肤一致）
  const scopeLight = declScope(def.tokens);
  const scopeDark = declScope(def.tokensDark);
  if (scopeLight) parts.push(`${CUSTOM}:not(.ubp-dark){${scopeLight}}`);
  if (scopeDark) parts.push(`${CUSTOM}.ubp-dark{${scopeDark}}`);
  const appLight = declApp(def.tokens, false);
  const appDark = declApp(def.tokensDark, true);
  if (appLight) parts.push(appLight);
  if (appDark) parts.push(appDark);
  // 桌面默认壁纸（用户自设壁纸走 has-bg 行内样式，天然优先于皮肤默认）
  const home = def.home || {};
  if (home.bg) parts.push(`${CUSTOM}:not(.ubp-dark) .ubp-home:not(.has-bg){background:${home.bg}}`);
  if (home.bgDark) parts.push(`${CUSTOM}.ubp-dark .ubp-home:not(.has-bg){background:${home.bgDark}}`);
  if (home.overlay) {
    parts.push(`${CUSTOM} .ubp-home:not(.has-bg){color:#fff}`);
    parts.push(`${CUSTOM} .ubp-home:not(.has-bg)::before{content:'';position:absolute;inset:0;background:rgba(14,16,24,0.42);pointer-events:none}`);
    parts.push(`${CUSTOM} .ubp-home:not(.has-bg) .ubp-home-date,${CUSTOM} .ubp-home:not(.has-bg) .ubp-home-wdesc,${CUSTOM} .ubp-home:not(.has-bg) .ubp-home-loc,${CUSTOM} .ubp-home:not(.has-bg) .ubp-appname{color:rgba(255,255,255,0.86)}`);
    parts.push(`${CUSTOM} .ubp-home:not(.has-bg) .ubp-home-wmain{color:#fff}`);
    parts.push(`${CUSTOM} .ubp-home:not(.has-bg) > :not(.ubp-home-scrim){position:relative;z-index:1}`);
  }
  // 图标形状 + 桌面时刻居中布局
  if (def.icons?.shape === 'round') parts.push(`${CUSTOM} .ubp-appicon{border-radius:50%}`);
  if (def.icons?.shape === 'square') parts.push(`${CUSTOM} .ubp-appicon{border-radius:8px}`);
  if (def.icons?.shape === 'squircle') parts.push(`${CUSTOM} .ubp-appicon{border-radius:30%}`);
  if (def.icons?.shape === 'sharp') parts.push(`${CUSTOM} .ubp-appicon{border-radius:4px}`);
  if (home.layout === 'center') parts.push(SKIN_HOME_CENTER_CSS.replaceAll('.THEME', CUSTOM));
  // 美化工坊布局变量：图标尺寸/每行列数/行距/底栏尺寸/壁纸蒙层与模糊。
  // 默认值写在基础 CSS 的 .ubp-scope token 里（未设置零差异）；此处只写显式覆盖。
  const layoutVars: string[] = [];
  if (def.icons?.size) layoutVars.push(`--ubp-icon-size:${def.icons.size}px;`);
  if (def.icons?.columns) layoutVars.push(`--ubp-grid-cols:${def.icons.columns};`);
  if (def.icons?.gap) layoutVars.push(`--ubp-grid-rowgap:${def.icons.gap}px;`);
  if (def.icons?.dockSize) layoutVars.push(`--ubp-dock-icon:${def.icons.dockSize}px;`);
  if (typeof home.scrim === 'number') layoutVars.push(`--ubp-wp-scrim:${home.scrim};`);
  if (home.blur) layoutVars.push(`--ubp-wp-blur:${home.blur}px;`);
  if (layoutVars.length) parts.push(`${CUSTOM}{${layoutVars.join('')}}`);
  // 桌面标签颜色（显式覆盖壁纸态默认的浅色标签；特异性 (0,4,0) 压过 .has-bg 段）
  if (def.icons?.label === 'white') {
    parts.push(`${CUSTOM} .ubp-home .ubp-appname{color:rgba(255,255,255,0.92);text-shadow:0 1px 3px rgba(0,0,0,0.55)}`);
  }
  if (def.icons?.label === 'black') {
    parts.push(`${CUSTOM} .ubp-home .ubp-appname{color:rgba(24,24,27,0.92);text-shadow:0 1px 2px rgba(255,255,255,0.5)}`);
  }
  // 自定义 CSS：末尾追加（同特异性下最后生效）；已过 saneCustomCss 黑名单清洗
  if (def.css) parts.push(def.css);
  return parts.join('\n');
}

// ─── 全局字体解析（设置→通用「字体」chip 的取值口径） ───
// ''=跟随风格；song/hei/kai/yuan=内置语义键；u:<字体id>=美化工坊上传的用户字体（family 由设置层派生）。

/** 全局字体键 → CSS 字体栈（未知键=''=跟随风格；用户字体回退黑体栈保底缺字）。 */
export function resolvePhoneFontStack(key: string): string {
  if (!key) return '';
  if (key.startsWith('u:')) {
    const font = getPhoneSettings().fontLibrary.find(f => f.id === key.slice(2));
    return font ? `"${font.family}", ${PHONE_FONT_FAMILIES.hei.stack}` : '';
  }
  return PHONE_FONT_FAMILIES[key]?.stack || '';
}

/** 用户字体的 CSS font-family 名（= 引用键 u:<id> 的取值；不存在=''）。 */
export function userFontFamilyOf(id: string): string {
  const font = getPhoneSettings().fontLibrary.find(f => f.id === id);
  return font ? font.family : '';
}
