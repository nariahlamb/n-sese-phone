// ===== 美化工坊（设置 → 通用 → 外观 → 美化工坊；皮肤可视化编辑器，docs/65） =====
// 一切编辑直接落在「自定义皮肤」这一个事实上：进入工坊即持有草稿（当前自定义皮肤 / 从当前内置
// 皮肤派生 base / 从零开始），每次改动立即 normalize → 落盘 → theme-changed（手机外观实时刷新）。
// 草稿之外只有两类本机数据：用户字体库（PhoneSettings.fontLibrary，跨皮肤共享）与全局字体引用
// （fontFamily='u:<id>'）。导入/导出走 core/skin-pack 的外观包信封（旧裸格式永久兼容）。
// 交互纪律：滑杆「input=行内变量即时预览、change=落盘」（落盘前清预览变量，交给皮肤 class 接管）；
// 文本类控件 change 才提交（不打断输入、不整面重绘）；自定义 CSS 走「应用」按钮显式提交。

import { hostDocument, phoneNotify } from '../core/host-env';
import {
  getPhoneSettings, savePhoneSettings, makeUserFontId,
  PHONE_USER_FONT_MAX, PHONE_USER_FONT_MAX_CHARS,
  type PhoneUserFont,
} from '../core/phone-settings';
import {
  currentCustomSkin, currentSkinId, normalizePhoneSkin, resolvePhoneFontStack,
  saneCustomCss, saneSkinImageUrl, skinAppColor, skinAppIcon, skinAppName,
  SKIN_LIMITS, type PhoneSkinAppOverride, type PhoneSkinDef,
} from '../core/skin-themes';
import { SKIN_PALETTE_PRESETS, randomSkinPalette, SKIN_TOKEN_GROUPS } from '../core/skin-palettes';
import {
  buildSkinPack, collectSkinDataUrlImages, inlineSkinImages, markUsedFonts,
  parseSkinPack, skinPackFailureMessage, wirePackFontIntoDef,
} from '../core/skin-pack';
import { importPhoneImageFromDataUrl } from '../core/phone-backgrounds';
import { PHONE_FONT_FAMILIES } from '../styles/phone-theme';
import { emitPhoneEvent, getPhoneApps } from './app-registry';
import { openImagePickerSheet } from './image-picker-sheet';
import { openConfirmSheet } from './action-sheet';
import { pushSheetCloser } from './phone-ui';
import { ubpIcon } from './icons';
import { escapeAttr, escapeHtml } from '../core/ubp-utils';

// ─── 模块态（同屏只开一个工坊） ───

let _overlay: HTMLElement | null = null;
/** 折叠卡开合记忆（渲染层会话内；整面重绘时保住用户展开的区块）。 */
const _openSecs = new Set<string>(['sks-color', 'sks-icons']);

/** 是否线上直链图片（图标编辑器里「图片地址」框的回填判据：data:/图床路径不回填）。 */
function isRemoteImg(value: string | undefined): boolean {
  return Boolean(value && /^https?:\/\//i.test(value));
}

export function closeSkinStudio(): void {
  _overlay?.remove();
  _overlay = null;
}

/** 工坊是否开着（设置页 render 前问一句：整页重绘会连工坊弹层一起清掉）。 */
export function isSkinStudioOpen(): boolean {
  return Boolean(_overlay?.isConnected);
}

// ─── 外观包导入（工坊「导入」与设置页「导入自定义皮肤」共用一条链） ───

/** 字体条目形状校验（与 phone-settings.normalizeUserFonts 同判据的本地实现——那里不导出逐条口）。 */
function normalizeFontProbe(rec: Record<string, unknown>): Omit<PhoneUserFont, 'id' | 'family'> | null {
  const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 20) : '';
  const format = (['woff2', 'woff', 'truetype', 'opentype'] as const).includes(rec.format as 'woff2')
    ? rec.format as PhoneUserFont['format']
    : 'woff2';
  if (rec.source === 'data') {
    const dataUrl = typeof rec.dataUrl === 'string' ? rec.dataUrl.slice(0, PHONE_USER_FONT_MAX_CHARS) : '';
    if (/^data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff2?|x-font-ttf|octet-stream));base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      return { name: name || '未命名字体', source: 'data', dataUrl, format };
    }
    return null;
  }
  if (rec.source === 'url') {
    const url = typeof rec.url === 'string' ? rec.url.trim().slice(0, 500) : '';
    if (/^https:\/\//.test(url)) return { name: name || '未命名字体', source: 'url', url, format };
  }
  return null;
}

/** 合并字体进字体库（同名视为同款跳过；新条目换新 id；超量截断）。返回 [合并后的整库, 实际并入数]。 */
function mergeFonts(library: readonly PhoneUserFont[], incoming: unknown[]): [PhoneUserFont[], number] {
  const out = library.slice();
  let added = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const probe = normalizeFontProbe(raw as Record<string, unknown>);
    if (!probe) continue;
    if (out.some(f => f.name === probe.name)) continue; // 同名=已导入过
    if (out.length >= PHONE_USER_FONT_MAX) break;
    const id = makeUserFontId();
    out.push({ ...probe, id, family: `UBPUserFont_${id}` });
    added++;
  }
  return [out, added];
}

/**
 * 导入皮肤文本（外观包 / 旧裸格式 / 顶层数组取第 1 条）：清洗 → data: 图片上传回图床换路径 →
 * 字体合并（带 use 标记的自动接成皮肤字体）→ 落盘。返回导入结果（ok=false 时 message 是
 * **分诊文案**：说清哪里不对、下一步怎么办；数据未动）。
 */
export async function importSkinFromText(text: string): Promise<{ ok: boolean; message: string; def: PhoneSkinDef | null }> {
  const parsed = parseSkinPack(text);
  if (!parsed.ok) return { ok: false, message: skinPackFailureMessage(parsed), def: null };
  // data: 图片换回服务器路径（跨设备可分享的关键一步）：在**原文**上替换——normalize 之后再换
  // 会丢字段（如含 data: 的 bg 虽有 saneBgValue 放行，但直接在原文层操作对 img/bg 一致最稳）。
  // 上传失败的保留 data:（img ≤900KB、bg 走 saneBgValue，仍可用）。线上图床直链原样保留，不上传不内联。
  const rawSkin = parsed.skin as Record<string, unknown>;
  const dataUrls = collectSkinDataUrlImages(rawSkin as unknown as PhoneSkinDef);
  let skinSource: unknown = rawSkin;
  if (dataUrls.length) {
    const replaceMap = new Map<string, string>();
    for (const dataUrl of dataUrls) {
      try {
        const path = await importPhoneImageFromDataUrl(dataUrl);
        if (path) replaceMap.set(dataUrl, path);
      } catch (_e) { /* 保留 dataUrl */ }
    }
    if (replaceMap.size) {
      let json = JSON.stringify(rawSkin);
      for (const [dataUrl, path] of replaceMap) json = json.split(dataUrl).join(path);
      skinSource = JSON.parse(json);
    }
  }
  let def = normalizePhoneSkin(skinSource);
  if (!def) return { ok: false, message: '未识别到任何有效的皮肤字段，请检查文件内容', def: null };
  const patch: Record<string, unknown> = {};
  let fontAdded = 0;
  let wiredFont = '';
  if (parsed.fonts.length) {
    const [merged, added] = mergeFonts(getPhoneSettings().fontLibrary, parsed.fonts);
    patch.fontLibrary = merged; // 整库回写（合并结果）
    fontAdded = added;
    // 包内字体带 use:true → 皮肤字体自动接线（导入即生效）：family 名恒由导入时生成的 id 派生，
    // AI 的皮肤引用不到它；同名已在库=沿用既有。
    const wiredStep = wirePackFontIntoDef(def, parsed.fonts, merged);
    if (wiredStep.wired) {
      wiredFont = wiredStep.wired;
      def = normalizePhoneSkin(wiredStep.def) || wiredStep.def; // 变化过的字段再过一遍清洗（长度上限等）
    }
  }
  patch.skin = 'custom';
  patch.customSkin = def as unknown as Record<string, unknown>;
  const ok = await savePhoneSettings(patch);
  if (!ok) return { ok: false, message: '存储写入失败，请稍后重试', def: null };
  emitPhoneEvent('ubp-phone:theme-changed');
  const extra = fontAdded ? `；并入 ${fontAdded} 个字体` : '';
  const wiredNote = wiredFont ? `；字体「${wiredFont}」已设为皮肤字体` : '';
  // 数组包装（AI 多方案）取首条时说清——不许静默替用户做选择
  const arrNote = parsed.arrayCount && parsed.arrayCount > 1 ? `；文件含 ${parsed.arrayCount} 条皮肤，已取第 1 条` : '';
  return { ok: true, message: `皮肤「${def.name || '自定义'}」已应用${extra}${wiredNote}${arrNote}`, def };
}

/** 导出外观包为 JSON 文件（图片内联 data:；字体可选携带，皮肤正在引用的那款打上 use 标记）。 */
export async function exportSkinToFile(def: PhoneSkinDef, includeFonts: boolean): Promise<void> {
  const fetcher = async (path: string): Promise<string | null> => {
    try {
      const res = await fetch(path);
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise<string | null>(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (_e) {
      return null;
    }
  };
  const { def: inlined, inlined: count, skipped } = await inlineSkinImages(def, fetcher);
  const fonts = includeFonts ? markUsedFonts(def, getPhoneSettings().fontLibrary) : null;
  const pack = buildSkinPack(inlined, fonts);
  const name = (def.name || '自定义').replace(/[\\/:*?"<>|]/g, '_');
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = hostDocument().createElement('a');
  a.href = url;
  a.download = `瑟瑟小手机皮肤-${name}.json`;
  hostDocument().body.appendChild(a); // 部分浏览器要求锚点在文档内才触发下载
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  const detail = skipped.length ? `（${skipped.length} 张图过大或读取失败，保留了服务器路径）` : '';
  phoneNotify(`已导出外观包（内联 ${count} 张图片${fonts ? `、${fonts.length} 个字体` : ''}）${detail}`);
}

// ─── 工坊 UI 小组件 ───

interface SelectOption { value: string; label: string }

const selectRow = (label: string, act: string, options: ReadonlyArray<SelectOption>, current: string): string => `
  <div class="ubp-fieldrow">
    <span class="ubp-fieldlabel">${label}</span>
    <select class="ubp-select" data-sks="${act}">${options.map(o =>
      `<option value="${escapeAttr(o.value)}"${o.value === current ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>
  </div>`;

const section = (id: string, title: string, body: string, sub = ''): string => `
  <details class="ubp-set-sec" data-ubp-sec="${id}"${_openSecs.has(id) ? ' open' : ''}>
    <summary class="ubp-set-sec-summary">
      <span class="ubp-set-sec-main"><span class="ubp-set-sec-title">${title}</span></span>
      <span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span>
    </summary>
    <div class="ubp-set-sec-body">${sub ? `<div class="ubp-sks-sub">${escapeHtml(sub)}</div>` : ''}${body}</div>
  </details>`;

const hexOf = (value: string | undefined, fallback: string): string =>
  value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;

const PHONE_SCALE_STEPS = [0.85, 0.92, 1, 1.08, 1.16, 1.25];

// ─── 工坊本体 ───

export function openSkinStudio(container: HTMLElement, onChanged: () => void): void {
  closeSkinStudio();
  const doc = container.ownerDocument || document;
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-sks-sheet';
  const panel = doc.createElement('div');
  panel.className = 'ubp-sheet ubp-sks-panel';
  overlay.appendChild(panel);
  container.appendChild(overlay);
  _overlay = overlay;
  pushSheetCloser(() => { closeSkinStudio(); onChanged(); }, () => overlay.isConnected);

  // 草稿种子：当前自定义皮肤 → 当前内置皮肤派生 base → 从零开始
  const seed = (): PhoneSkinDef => {
    const skinId = currentSkinId();
    if (skinId === 'custom') return JSON.parse(JSON.stringify(currentCustomSkin() || {}));
    if (skinId === 'sweet' || skinId === 'flirty') return { base: skinId };
    return {};
  };
  let draft: PhoneSkinDef = seed();
  /** 自定义 CSS 的编辑区文本（「应用」时才过清洗进草稿；未应用的不落盘）。 */
  let cssRaw = draft.css || '';
  /** 自定义 CSS 卡的错误提示（黑名单命中）。 */
  let cssErr = '';

  const ensureIcons = (): NonNullable<PhoneSkinDef['icons']> => (draft.icons = draft.icons || {});
  const ensureHome = (): NonNullable<PhoneSkinDef['home']> => (draft.home = draft.home || {});
  const ensureFont = (): NonNullable<PhoneSkinDef['font']> => (draft.font = draft.font || {});
  const cleanSub = (): void => {
    if (draft.icons && !Object.keys(draft.icons).length) delete draft.icons;
    if (draft.home && !Object.keys(draft.home).length) delete draft.home;
    if (draft.font && !Object.keys(draft.font).length) delete draft.font;
  };

  // 滑杆即时预览：直接写 .ubp-scope 行内变量（元素行内 > 皮肤 class 规则）；
  // 落盘时清掉预览值，交给皮肤 class 生成的变量接管（单一生效来源）。
  const PREVIEW_VARS = ['--ubp-icon-size', '--ubp-grid-cols', '--ubp-grid-rowgap', '--ubp-dock-icon', '--ubp-wp-scrim', '--ubp-wp-blur'];
  const scopeEl = (): HTMLElement | null => overlay.closest('.ubp-scope') as HTMLElement | null;
  const setPreviewVar = (key: string, value: string): void => { scopeEl()?.style.setProperty(key, value); };
  const clearPreviewVars = (): void => { for (const k of PREVIEW_VARS) scopeEl()?.style.removeProperty(k); };

  /** 提交草稿（normalize → 落盘 → 主题事件）。空草稿=退回默认皮肤。 */
  const persist = async (): Promise<void> => {
    cleanSub();
    const cleaned = normalizePhoneSkin(draft);
    clearPreviewVars();
    if (cleaned) await savePhoneSettings({ skin: 'custom', customSkin: cleaned as unknown as Record<string, unknown> });
    else await savePhoneSettings({ skin: '', customSkin: null });
    emitPhoneEvent('ubp-phone:theme-changed');
  };

  interface SliderSpec { cssVar: string; raw: boolean; fmt: (v: number) => string; apply: (v: number) => void }
  const SLIDERS: Readonly<Record<string, SliderSpec>> = {
    'icon-size': { cssVar: '--ubp-icon-size', raw: false, fmt: v => `${v}px`, apply: v => { ensureIcons().size = v; } },
    columns: { cssVar: '--ubp-grid-cols', raw: true, fmt: v => `${v} 列`, apply: v => { ensureIcons().columns = v; } },
    gap: { cssVar: '--ubp-grid-rowgap', raw: false, fmt: v => `${v}px`, apply: v => { ensureIcons().gap = v; } },
    'dock-size': { cssVar: '--ubp-dock-icon', raw: false, fmt: v => `${v}px`, apply: v => { ensureIcons().dockSize = v; } },
    scrim: { cssVar: '--ubp-wp-scrim', raw: true, fmt: v => v.toFixed(2), apply: v => { ensureHome().scrim = v; } },
    blur: { cssVar: '--ubp-wp-blur', raw: false, fmt: v => `${v}px`, apply: v => { if (v) ensureHome().blur = v; else delete ensureHome().blur; } },
  };

  const sliderRow = (act: string, label: string, min: number, max: number, step: number, val: number): string => `
    <div class="ubp-sks-slider">
      <span class="ubp-sks-lab">${label}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-sks="${act}">
      <b data-sks-out="${act}">${SLIDERS[act].fmt(val)}</b>
    </div>`;

  const tokenRow = (key: string, label: string): string => {
    const light = draft.tokens?.[key] || '';
    const dark = draft.tokensDark?.[key] || '';
    return `
    <div class="ubp-sks-tokrow" data-tok="${escapeAttr(key)}">
      <span class="ubp-sks-toklabel" title="${escapeAttr(key)}">${escapeHtml(label)}</span>
      <input type="color" class="ubp-sks-cin" data-sks="tok-sw" data-mode="light" value="${hexOf(light, '#ffffff')}" title="亮档取色">
      <input type="text" class="ubp-sks-tin" data-sks="tok-tx" data-mode="light" placeholder="亮" value="${escapeAttr(light)}">
      <input type="color" class="ubp-sks-cin" data-sks="tok-sw" data-mode="dark" value="${hexOf(dark, '#111111')}" title="暗档取色">
      <input type="text" class="ubp-sks-tin" data-sks="tok-tx" data-mode="dark" placeholder="暗" value="${escapeAttr(dark)}">
      <button type="button" class="ubp-sks-x" data-sks="tok-clr" title="清除该 token">✕</button>
    </div>`;
  };

  const CURATED_KEYS = new Set(SKIN_TOKEN_GROUPS.flatMap(g => g.tokens.map(t => t.key)));

  const fontStackOptions = (): ReadonlyArray<SelectOption> => [
    { value: '', label: '跟随风格' },
    ...Object.entries(PHONE_FONT_FAMILIES).map(([, f]) => ({ value: f.stack, label: f.label })),
    ...getPhoneSettings().fontLibrary.map(f => ({
      value: resolvePhoneFontStack(`u:${f.id}`),
      label: `用户·${f.name}`,
    })),
  ];
  // 选中态兜底：当前值不在选项里（手写栈/字体已删）→ 附加一项「自定义」避免 select 显示错位
  const withCurrent = (options: ReadonlyArray<SelectOption>, current: string): ReadonlyArray<SelectOption> =>
    current && !options.some(o => o.value === current)
      ? [...options, { value: current, label: `当前：${current.slice(0, 18)}` }]
      : options;

  const colorSection = (): string => {
    const curated = SKIN_TOKEN_GROUPS.map(group => `
      <div class="ubp-sks-sub">${escapeHtml(group.label)}</div>
      ${group.tokens.map(t => tokenRow(t.key, t.label)).join('')}`).join('');
    const extras = [...new Set([...Object.keys(draft.tokens || {}), ...Object.keys(draft.tokensDark || {})])]
      .filter(k => !CURATED_KEYS.has(k));
    const advanced = `
      <div class="ubp-sks-sub">高级 token（任意 --ubp-*/--nz-*/--tb-* 等 App 调色板族）</div>
      ${extras.map(key => tokenRow(key, key)).join('')}
      <div class="ubp-sks-tokrow">
        <input type="text" class="ubp-sks-tin" style="width:110px" data-sks="tok-newkey" placeholder="--nz-acc">
        <input type="text" class="ubp-sks-tin" data-sks="tok-newlight" placeholder="亮档值">
        <input type="text" class="ubp-sks-tin" data-sks="tok-newdark" placeholder="暗档值">
        <button type="button" class="ubp-sks-mini" data-sks="tok-add">添加</button>
      </div>`;
    const paletteChips = SKIN_PALETTE_PRESETS.map(p => `
      <button type="button" class="ubp-sks-pal" data-sks="palette" data-pal="${escapeAttr(p.id)}" title="一键套用整套配色">
        <i style="background:${escapeAttr(p.tokens['--ubp-accent'] || '#888')}"></i>
        <i style="background:${escapeAttr(p.tokens['--ubp-bubble-me'] || '#888')}"></i>
        <i style="background:${escapeAttr(p.tokensDark['--ubp-accent'] || '#888')}"></i>
        ${escapeHtml(p.label)}
      </button>`).join('');
    return section('sks-color', '配色', `
      ${selectRow('基底', 'base', [
        { value: '', label: '从零开始（现代默认）' },
        { value: 'sweet', label: '基于·甜恋糖果' },
        { value: 'flirty', label: '基于·瑟瑟灵感' },
      ], draft.base || '')}
      <div class="ubp-sks-sub">预设色板（点击整组覆写亮/暗两档颜色）</div>
      <div class="ubp-sks-palettes">${paletteChips}
        <button type="button" class="ubp-sks-pal" data-sks="palette-random" title="随机生成一套调和配色">🎲 随机灵感</button>
      </div>
      ${curated}
      ${advanced}`, '颜色 token 逐枚覆盖；空=不覆盖（沿用基底/默认）。色板与随机灵感会整组覆写颜色。');
  };

  const iconsSection = (): string => {
    const apps = getPhoneApps();
    const tiles = apps.map(app => {
      const override = draft.icons?.apps?.[app.id];
      const color = override?.color || skinAppColor(app.id, app.color);
      const icon = override?.img
        ? `<img class="ubp-appicon-img" src="${escapeAttr(override.img)}" alt="">`
        : override?.glyph
          ? `<span class="ubp-skin-glyph">${escapeHtml(override.glyph)}</span>`
          : skinAppIcon(app.id, app.icon);
      const name = override?.name || skinAppName(app.id, app.name);
      return `<div class="ubp-sks-app" data-sks="app" data-app="${escapeAttr(app.id)}" title="编辑图标">
        <span class="ubp-appicon" style="background:${escapeAttr(color)}">${icon}</span>
        <span class="ubp-appname">${escapeHtml(name)}</span>${override ? '<span class="tag" title="已自定义"></span>' : ''}
      </div>`;
    }).join('');
    const icons = draft.icons || {};
    const home = draft.home || {};
    return section('sks-icons', '图标与桌面', `
      ${selectRow('图标形状', 'shape', [
        { value: '', label: '现代圆角方（默认）' }, { value: 'round', label: '圆形' },
        { value: 'square', label: '方章' }, { value: 'squircle', label: '超椭圆' }, { value: 'sharp', label: '锐利小圆角' },
      ], icons.shape || '')}
      ${sliderRow('icon-size', '图标大小', SKIN_LIMITS.iconSize.min, SKIN_LIMITS.iconSize.max, 1, icons.size ?? SKIN_LIMITS.iconSize.def)}
      ${sliderRow('columns', '每行图标', SKIN_LIMITS.columns.min, SKIN_LIMITS.columns.max, 1, icons.columns ?? SKIN_LIMITS.columns.def)}
      ${sliderRow('gap', '行距', SKIN_LIMITS.gap.min, SKIN_LIMITS.gap.max, 1, icons.gap ?? SKIN_LIMITS.gap.def)}
      ${sliderRow('dock-size', '底栏图标', SKIN_LIMITS.dockSize.min, SKIN_LIMITS.dockSize.max, 1, icons.dockSize ?? SKIN_LIMITS.dockSize.def)}
      ${selectRow('标签颜色', 'label-color', [
        { value: '', label: '跟随壁纸（默认）' }, { value: 'white', label: '白色' }, { value: 'black', label: '黑色' },
      ], icons.label || '')}
      ${selectRow('桌面时刻', 'home-layout', [
        { value: '', label: '左右分列（默认）' }, { value: 'center', label: '居中纵排' },
      ], home.layout || '')}
      <div class="ubp-fieldrow"><span class="ubp-fieldlabel">皮肤默认壁纸加蒙层</span>
        <label class="ubp-switch"><input type="checkbox" data-sks="overlay"${home.overlay ? ' checked' : ''}><span class="ubp-switch-track"></span><span class="ubp-switch-knob"></span></label>
      </div>
      ${sliderRow('scrim', '壁纸蒙层', SKIN_LIMITS.scrim.min, SKIN_LIMITS.scrim.max, 0.05, home.scrim ?? SKIN_LIMITS.scrim.def)}
      ${sliderRow('blur', '壁纸模糊', SKIN_LIMITS.blur.min, SKIN_LIMITS.blur.max, 1, home.blur ?? SKIN_LIMITS.blur.def)}
      <div class="ubp-sks-sub">皮肤默认壁纸（CSS 背景值：渐变或图片 URL；用户自设壁纸优先于它）</div>
      <div class="ubp-sks-tokrow"><input type="text" class="ubp-fieldinput" style="flex:1" data-sks="bg" placeholder="亮档，如 linear-gradient(#FFE3EC,#FBD3E2)" value="${escapeAttr(home.bg || '')}"></div>
      <div class="ubp-sks-tokrow"><input type="text" class="ubp-fieldinput" style="flex:1" data-sks="bgDark" placeholder="暗档" value="${escapeAttr(home.bgDark || '')}"></div>
      <div class="ubp-sks-sub">App 图标（点击编辑：图片 / 字形 / 底色 / 名称）</div>
      <div class="ubp-sks-apps">${tiles}</div>`, '布局即刻生效于桌面；壁纸蒙层/模糊作用于「主界面背景」自设的壁纸。');
  };

  const fontSection = (): string => {
    const fonts = getPhoneSettings().fontLibrary;
    const family = draft.font?.family || '';
    const display = draft.font?.display || '';
    const rows = fonts.map(f => `
      <div class="ubp-sks-fontrow">
        <span class="ubp-sks-fontprev" style="font-family:'${escapeAttr(f.family)}', sans-serif" title="${escapeAttr(f.family)}">${escapeHtml(f.name)} · 晴夜落雪，信笺长明 0123</span>
        <button type="button" class="ubp-sks-mini" data-sks="font-theme" data-id="${escapeAttr(f.id)}">主题</button>
        <button type="button" class="ubp-sks-mini" data-sks="font-global" data-id="${escapeAttr(f.id)}">全局</button>
        <button type="button" class="ubp-sks-mini" data-sks="font-del" data-id="${escapeAttr(f.id)}">删除</button>
      </div>`).join('');
    return section('sks-font', '字体', `
      ${selectRow('主题字体（随皮肤分享）', 'font-family', withCurrent(fontStackOptions(), family), family)}
      ${selectRow('标题展示字体（随皮肤分享）', 'font-display', withCurrent(fontStackOptions(), display), display)}
      ${selectRow('主题字号', 'font-scale', PHONE_SCALE_STEPS.map(v => ({ value: String(v), label: `${Math.round(v * 100)}%` })), String(draft.font?.scale ?? 1))}
      <div class="ubp-sks-sub">用户字体库（本机设备级；导出时可勾选随包携带）· ${fonts.length}/${PHONE_USER_FONT_MAX}</div>
      ${rows || '<div class="ubp-set-note">还没有用户字体。</div>'}
      <div class="ubp-sks-tokrow">
        <button type="button" class="ubp-sks-mini" data-sks="font-upload">上传字体文件…</button>
        <input type="text" class="ubp-fieldinput" style="flex:1" data-sks="font-url" placeholder="或粘贴 https:// 字体地址（woff2）">
        <button type="button" class="ubp-sks-mini" data-sks="font-url-add">添加</button>
      </div>
      <div class="ubp-set-note">支持 woff2/woff/ttf/otf；中文字体往往很大（建议 woff2 子集或远程地址）。字体只作用于手机 UI。</div>`,
      '主题字体是皮肤的默认字体（用户在 设置→通用→字体 选过则以其为准）；「全局」立刻切换本机全局字体。');
  };

  const cssSection = (): string => section('sks-css', '自定义 CSS', `
      <textarea class="ubp-textarea" data-sks="css" style="min-height:140px" placeholder="/* 直接写规则，只作用于手机 UI，例： */&#10;.ubp-chatlist { border-radius: 2px; }">${escapeHtml(cssRaw)}</textarea>
      <div class="ubp-sks-tokrow">
        <button type="button" class="ubp-sks-mini" data-sks="css-apply">应用</button>
        <button type="button" class="ubp-sks-mini" data-sks="css-clear">清空</button>
        <span class="ubp-sks-hint">${cssRaw.length}/${SKIN_LIMITS.cssMax} 字符</span>
      </div>
      ${cssErr ? `<div class="ubp-set-note" style="color:var(--ubp-danger)">${escapeHtml(cssErr)}</div>` : ''}
      <div class="ubp-set-note">黑名单（命中即整段不生效）：url(、@import、javascript:、expression( 等。换行可用；上限 ${SKIN_LIMITS.cssMax} 字符。</div>`,
    '任意 CSS 直接注入手机 Shadow Root（天然只影响手机）；暗色适配可用 .ubp-dark 前缀选择器。');

  const ioSection = (): string => {
    const fonts = getPhoneSettings().fontLibrary;
    return section('sks-io', '导入 / 导出 / 重置', `
      <div class="ubp-sks-tokrow">
        <button type="button" class="ubp-sks-mini" data-sks="export">导出外观包…</button>
        <button type="button" class="ubp-sks-mini" data-sks="import">导入外观包…</button>
        ${fonts.length ? `<label class="ubp-sks-chk"><input type="checkbox" data-sks="export-fonts">含字体</label>` : ''}
        <span style="flex:1"></span>
        <button type="button" class="ubp-sks-mini" style="color:var(--ubp-danger)" data-sks="reset">恢复默认</button>
      </div>
      <div class="ubp-set-note">导出会把皮肤里的图片内联进 JSON（跨设备可分享），字体可选携带；导入兼容旧版裸皮肤 JSON 与新外观包。</div>`,
      '外观包=皮肤定义+可选字体；换台设备导入即还原整套外观。');
  };

  const renderPanel = (): void => {
    const prevTop = panel.querySelector('.ubp-sks-body')?.scrollTop ?? 0;
    panel.innerHTML = `
      <div class="ubp-sks-head">
        <span class="ubp-sks-title">美化工坊</span>
        <input type="text" class="ubp-sks-name" data-sks="name" placeholder="皮肤名（导出文件名）" value="${escapeAttr(draft.name || '')}" maxlength="20">
        <button type="button" class="ubp-sheet-x" data-sks="close" title="完成并关闭">✕</button>
      </div>
      <div class="ubp-sks-body">
        ${colorSection()}${iconsSection()}${fontSection()}${cssSection()}${ioSection()}
        <div style="height:16px"></div>
      </div>`;
    const body = panel.querySelector('.ubp-sks-body');
    if (body) body.scrollTop = prevTop;
  };
  renderPanel();

  // ── 图标编辑弹层（App 粒度：图片/字形/底色/名称） ──
  const openIconEditor = (appId: string): void => {
    const app = getPhoneApps().find(a => a.id === appId);
    if (!app) return;
    const edOverlay = doc.createElement('div');
    edOverlay.className = 'ubp-overlay ubp-sks-iedit';
    const edPanel = doc.createElement('div');
    edPanel.className = 'ubp-sheet ubp-sks-iepanel';
    edOverlay.appendChild(edPanel);
    overlay.appendChild(edOverlay); // 叠在工坊层内：关工坊连带关掉
    const copy: PhoneSkinAppOverride = { ...(draft.icons?.apps?.[appId] || {}) };
    const previewHtml = (): string => {
      const icon = copy.img
        ? `<img class="ubp-appicon-img" src="${escapeAttr(copy.img)}" alt="">`
        : copy.glyph
          ? `<span class="ubp-skin-glyph">${escapeHtml(copy.glyph)}</span>`
          : skinAppIcon(appId, app.icon);
      return `<span class="ubp-appicon" style="background:${escapeAttr(copy.color || skinAppColor(appId, app.color))}">${icon}</span>`;
    };
    edPanel.innerHTML = `
      <div class="ubp-sheet-head">
        <span class="ubp-sheet-headtitle">编辑图标 · ${escapeHtml(skinAppName(appId, app.name))}</span>
        <button type="button" class="ubp-sheet-x" data-ie="cancel" title="关闭">✕</button>
      </div>
      <div class="ubp-sks-ieprev" data-ie="prev">${previewHtml()}</div>
      <div class="ubp-sks-tokrow">
        <span class="ubp-sks-lab sm">字形</span>
        <input type="text" class="ubp-sks-tin" style="flex:1" data-ie="glyph" placeholder="单字/emoji，≤4 字符（替换 SVG 图标）" value="${escapeAttr(copy.glyph || '')}">
      </div>
      <div class="ubp-sks-tokrow">
        <span class="ubp-sks-lab sm">底色</span>
        <input type="color" class="ubp-sks-cin" data-ie="color-sw" value="${hexOf(copy.color, hexOf(app.color, '#4A9E8A'))}">
        <input type="text" class="ubp-sks-tin" style="flex:1" data-ie="color-tx" placeholder="CSS 颜色/渐变" value="${escapeAttr(copy.color || '')}">
      </div>
      <div class="ubp-sks-tokrow">
        <span class="ubp-sks-lab sm">名称</span>
        <input type="text" class="ubp-sks-tin" style="flex:1" data-ie="name" placeholder="桌面标签（≤12 字）" value="${escapeAttr(copy.name || '')}" maxlength="12">
      </div>
      <div class="ubp-sks-tokrow">
        <span class="ubp-sks-lab sm">图片</span>
        <button type="button" class="ubp-sks-mini" data-ie="pick">从图库选择…</button>
        ${copy.img ? '<button type="button" class="ubp-sks-mini" data-ie="img-clr">清除图片</button>' : ''}
        <span class="ubp-sks-hint">${copy.img ? escapeHtml(copy.img) : '无（用字形/注册表图标）'}</span>
      </div>
      <div class="ubp-sks-tokrow">
        <span class="ubp-sks-lab sm">图片地址</span>
        <input type="text" class="ubp-sks-tin" style="flex:1" data-ie="img-url" placeholder="https://…/icon.png（线上直链，≤700 字符）" value="${escapeAttr(isRemoteImg(copy.img) ? copy.img : '')}">
        <button type="button" class="ubp-sks-mini" data-ie="img-url-set">用地址</button>
      </div>
      <div class="ubp-sheet-actions cols2">
        <button type="button" class="ubp-btn" data-ie="reset">重置整项</button>
        <button type="button" class="ubp-btn primary" data-ie="done">完成</button>
      </div>`;
    /** 结构里有随 copy.img 条件渲染的按钮——变更后整层重建最稳（含预览与状态）。 */
    const reopen = (): void => {
      edOverlay.remove();
      openIconEditor(appId);
    };
    edPanel.addEventListener('input', (ev) => {
      const el = ev.target as HTMLElement;
      const act = el.dataset?.ie;
      if (act === 'glyph') { copy.glyph = (el as HTMLInputElement).value; (edPanel.querySelector('[data-ie="prev"]') as HTMLElement).innerHTML = previewHtml(); }
      else if (act === 'name') copy.name = (el as HTMLInputElement).value;
      else if (act === 'color-tx') { copy.color = (el as HTMLInputElement).value; (edPanel.querySelector('[data-ie="prev"]') as HTMLElement).innerHTML = previewHtml(); }
    });
    edPanel.addEventListener('change', (ev) => {
      const el = ev.target as HTMLElement;
      if (el.dataset?.ie === 'color-sw') {
        copy.color = (el as HTMLInputElement).value;
        const twin = edPanel.querySelector('[data-ie="color-tx"]') as HTMLInputElement | null;
        if (twin) twin.value = copy.color;
        (edPanel.querySelector('[data-ie="prev"]') as HTMLElement).innerHTML = previewHtml();
      }
    });
    edPanel.addEventListener('click', (ev) => {
      const el = (ev.target as HTMLElement).closest('[data-ie]') as HTMLElement | null;
      if (!el) return;
      const act = el.dataset.ie;
      if (act === 'cancel') edOverlay.remove();
      else if (act === 'img-clr') { delete copy.img; reopen(); }
      else if (act === 'img-url-set') {
        const raw = (edPanel.querySelector('[data-ie="img-url"]') as HTMLInputElement | null)?.value.trim() || '';
        const sane = saneSkinImageUrl(raw);
        if (!sane) { phoneNotify('图片地址不合法：要 http(s) 图片直链（≤700 字符），或 /user/images/ 图床路径', '图标图片', 'error'); return; }
        copy.img = sane;
        reopen();
      }
      else if (act === 'pick') {
        openImagePickerSheet(edPanel, {
          mode: 'setting',
          title: '图标图片',
          current: copy.img,
          currentText: '当前图标图',
          defaultText: '未设置图片',
          pickTip: '设为图标',
          emptyText: '相册还是空的——可导入本地图片作为图标',
          onPick: img => { copy.img = img.path; reopen(); },
          onImport: path => { copy.img = path; reopen(); },
          ...(copy.img ? { onReset: () => { delete copy.img; reopen(); } } : {}),
        });
      }
      else if (act === 'reset') { for (const k of Object.keys(copy)) delete (copy as Record<string, unknown>)[k]; reopen(); }
      else if (act === 'done') {
        // 「完成」：整项过一遍 normalize（清洗字形/图片/名称），空覆盖=删键
        if (draft.icons?.apps) delete draft.icons.apps[appId];
        const sane = normalizePhoneSkin({ icons: { apps: { [appId]: copy } } });
        const cleaned = sane?.icons?.apps?.[appId];
        if (cleaned) ensureIcons().apps = { ...(draft.icons?.apps || {}), [appId]: cleaned };
        cleanSub();
        edOverlay.remove();
        void persist().then(renderPanel);
      }
    });
  };

  // ── 事件（委托在 panel 上，整面重绘不掉监听） ──
  panel.addEventListener('toggle', (ev) => {
    const details = ev.target as HTMLElement;
    const id = details.dataset?.ubpSec;
    if (!id) return;
    if (details.hasAttribute('open')) _openSecs.add(id);
    else _openSecs.delete(id);
  }, true);

  panel.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement;
    const act = el.dataset?.sks || '';
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const spec = SLIDERS[act];
      if (!spec) return;
      const v = Number(el.value);
      setPreviewVar(spec.cssVar, spec.raw ? String(v) : `${v}px`);
      const out = panel.querySelector(`[data-sks-out="${act}"]`);
      if (out) out.textContent = spec.fmt(v);
      return;
    }
    if (act === 'css') cssRaw = (el as HTMLTextAreaElement).value.slice(0, SKIN_LIMITS.cssMax);
  });

  panel.addEventListener('change', async (ev) => {
    const el = ev.target as HTMLElement;
    const act = el.dataset?.sks;
    if (!act) return;
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const spec = SLIDERS[act];
      if (!spec) return;
      spec.apply(Number(el.value));
      await persist();
      return;
    }
    if (act === 'name') {
      const v = (el as HTMLInputElement).value.trim().slice(0, 20);
      if (v) draft.name = v; else delete draft.name;
    }
    else if (act === 'base') {
      const v = (el as HTMLSelectElement).value as PhoneSkinDef['base'];
      if (v) draft.base = v; else delete draft.base;
    }
    else if (act === 'tok-tx' || act === 'tok-sw') {
      const row = el.closest('[data-tok]') as HTMLElement | null;
      const key = row?.dataset.tok || '';
      const mode = el.dataset.mode === 'dark' ? 'dark' : 'light';
      const value = (el as HTMLInputElement).value.trim();
      if (!key) return;
      const bucket = mode === 'dark' ? (draft.tokensDark = draft.tokensDark || {}) : (draft.tokens = draft.tokens || {});
      if (value) bucket[key] = value;
      else delete bucket[key];
      if (act === 'tok-sw') {
        const twin = row?.querySelector<HTMLInputElement>(`[data-sks="tok-tx"][data-mode="${mode}"]`);
        if (twin) twin.value = value;
      }
    }
    else if (act === 'overlay') {
      const on = (el as HTMLInputElement).checked;
      if (on) ensureHome().overlay = true; else delete ensureHome().overlay;
    }
    else if (act === 'shape') {
      const v = (el as HTMLSelectElement).value;
      if (v) ensureIcons().shape = v as never; else delete ensureIcons().shape;
    }
    else if (act === 'label-color') {
      const v = (el as HTMLSelectElement).value;
      if (v) ensureIcons().label = v as never; else delete ensureIcons().label;
    }
    else if (act === 'home-layout') {
      const v = (el as HTMLSelectElement).value;
      if (v === 'center') ensureHome().layout = 'center'; else delete ensureHome().layout;
    }
    else if (act === 'font-family') {
      const v = (el as HTMLSelectElement).value;
      if (v) ensureFont().family = v; else delete ensureFont().family;
    }
    else if (act === 'font-display') {
      const v = (el as HTMLSelectElement).value;
      if (v) ensureFont().display = v; else delete ensureFont().display;
    }
    else if (act === 'font-scale') {
      const v = Number((el as HTMLSelectElement).value);
      if (v && v !== 1) ensureFont().scale = v; else delete ensureFont().scale;
    }
    else if (act === 'bg') {
      const v = (el as HTMLInputElement).value.trim();
      if (v) ensureHome().bg = v; else delete ensureHome().bg;
    }
    else if (act === 'bgDark') {
      const v = (el as HTMLInputElement).value.trim();
      if (v) ensureHome().bgDark = v; else delete ensureHome().bgDark;
    }
    else if (act === 'css') return; // textarea 只更新 cssRaw（input 阶段），应用走按钮
    else if (act === 'font-url' || act === 'export-fonts') return; // 纯输入/勾选，不提交
    await persist();
  });

  panel.addEventListener('click', async (ev) => {
    const el = (ev.target as HTMLElement).closest('[data-sks]') as HTMLElement | null;
    if (!el || el.dataset.sks === 'tok-tx' || el.dataset.sks === 'tok-sw') return;
    const act = el.dataset.sks;
    if (act === 'close') { closeSkinStudio(); onChanged(); return; }
    if (act === 'palette') {
      const preset = SKIN_PALETTE_PRESETS.find(p => p.id === el.dataset.pal);
      if (preset) {
        draft.tokens = { ...preset.tokens };
        draft.tokensDark = { ...preset.tokensDark };
        await persist(); renderPanel();
      }
      return;
    }
    if (act === 'palette-random') {
      const pal = randomSkinPalette();
      draft.tokens = pal.tokens;
      draft.tokensDark = pal.tokensDark;
      await persist(); renderPanel();
      return;
    }
    if (act === 'tok-clr') {
      const row = el.closest('[data-tok]') as HTMLElement | null;
      const key = row?.dataset.tok || '';
      if (key) {
        delete draft.tokens?.[key];
        delete draft.tokensDark?.[key];
        await persist(); renderPanel();
      }
      return;
    }
    if (act === 'tok-add') {
      const key = (panel.querySelector('[data-sks="tok-newkey"]') as HTMLInputElement | null)?.value.trim() || '';
      const light = (panel.querySelector('[data-sks="tok-newlight"]') as HTMLInputElement | null)?.value.trim() || '';
      const dark = (panel.querySelector('[data-sks="tok-newdark"]') as HTMLInputElement | null)?.value.trim() || '';
      if (!/^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) { phoneNotify('token 键形如 --nz-acc（小写连字符）', '添加失败', 'error'); return; }
      if (!light && !dark) { phoneNotify('至少填一个亮档或暗档值', '添加失败', 'error'); return; }
      if (light) (draft.tokens = draft.tokens || {})[key] = light;
      if (dark) (draft.tokensDark = draft.tokensDark || {})[key] = dark;
      await persist(); renderPanel();
      return;
    }
    if (act === 'app') { openIconEditor(el.dataset.app || ''); return; }
    if (act === 'css-apply') {
      const sane = saneCustomCss(cssRaw);
      if (cssRaw.trim() && !sane) {
        cssErr = '包含禁用内容（url(、@import、javascript: 等），整段未生效——请移除后重试';
        renderPanel();
        return;
      }
      cssErr = '';
      if (sane) draft.css = sane; else delete draft.css;
      await persist();
      phoneNotify(sane ? '自定义 CSS 已应用' : '自定义 CSS 已清空');
      renderPanel();
      return;
    }
    if (act === 'css-clear') { cssRaw = ''; cssErr = ''; delete draft.css; await persist(); renderPanel(); return; }
    if (act === 'export') {
      const cleaned = normalizePhoneSkin(draft) || draft;
      const includeFonts = Boolean((panel.querySelector('[data-sks="export-fonts"]') as HTMLInputElement | null)?.checked);
      await exportSkinToFile(cleaned, includeFonts);
      return;
    }
    if (act === 'import') {
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        void file.text().then(async text => {
          const result = await importSkinFromText(text);
          phoneNotify(result.message, result.ok ? '导入外观包' : '导入失败', result.ok ? 'info' : 'error');
          if (result.ok && result.def) {
            draft = result.def;
            cssRaw = draft.css || '';
            cssErr = '';
            renderPanel();
          }
        });
      });
      doc.body.appendChild(input);
      input.click();
      return;
    }
    if (act === 'reset') {
      openConfirmSheet(panel, {
        title: '恢复默认外观？',
        message: '清掉当前自定义皮肤（字体库保留），皮肤回到「默认」。',
        confirmLabel: '恢复默认',
        onConfirm: () => {
          void (async () => {
            draft = {};
            cssRaw = '';
            cssErr = '';
            await savePhoneSettings({ skin: '', customSkin: null });
            emitPhoneEvent('ubp-phone:theme-changed');
            renderPanel();
            phoneNotify('已恢复默认外观');
          })();
        },
      });
      return;
    }
    if (act === 'font-upload') {
      const library = getPhoneSettings().fontLibrary;
      if (library.length >= PHONE_USER_FONT_MAX) { phoneNotify(`字体库已满（${PHONE_USER_FONT_MAX} 个）`, '上传字体', 'error'); return; }
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = '.woff2,.woff,.ttf,.otf';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        if (file.size > PHONE_USER_FONT_MAX_CHARS * 0.75) {
          phoneNotify(`字体文件过大（上限约 ${Math.round(PHONE_USER_FONT_MAX_CHARS * 0.75 / 1024 / 1024)}MB）——建议用 woff2 子集或远程地址`, '上传字体', 'error');
          return;
        }
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const format: PhoneUserFont['format'] = ext === 'woff' ? 'woff' : ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : 'woff2';
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : '';
          if (!dataUrl.startsWith('data:')) { phoneNotify('字体文件读取失败', '上传字体', 'error'); return; }
          const id = makeUserFontId();
          const font: PhoneUserFont = {
            id, name: file.name.replace(/\.[^.]+$/, '').trim().slice(0, 20) || '未命名字体',
            family: `UBPUserFont_${id}`, source: 'data', dataUrl, format,
          };
          void savePhoneSettings({ fontLibrary: [...getPhoneSettings().fontLibrary, font] }).then(ok => {
            if (!ok) { phoneNotify('存储写入失败，请稍后重试', '上传字体', 'error'); return; }
            emitPhoneEvent('ubp-phone:theme-changed');
            renderPanel();
            phoneNotify(`字体「${font.name}」已入库，可在下方设为主题/全局字体`);
          });
        };
        reader.readAsDataURL(file);
      });
      doc.body.appendChild(input);
      input.click();
      return;
    }
    if (act === 'font-url-add') {
      const input = panel.querySelector('[data-sks="font-url"]') as HTMLInputElement | null;
      const url = input?.value.trim() || '';
      if (!/^https:\/\//.test(url)) { phoneNotify('字体地址须以 https:// 开头', '添加字体', 'error'); return; }
      const library = getPhoneSettings().fontLibrary;
      if (library.length >= PHONE_USER_FONT_MAX) { phoneNotify(`字体库已满（${PHONE_USER_FONT_MAX} 个）`, '添加字体', 'error'); return; }
      const id = makeUserFontId();
      const font: PhoneUserFont = {
        id, name: decodeURIComponent(url.split('/').pop()?.split('?')[0] || '').slice(0, 20) || '远程字体',
        family: `UBPUserFont_${id}`, source: 'url', url, format: 'woff2',
      };
      await savePhoneSettings({ fontLibrary: [...library, font] });
      emitPhoneEvent('ubp-phone:theme-changed');
      renderPanel();
      phoneNotify(`远程字体「${font.name}」已入库`);
      return;
    }
    if (act === 'font-theme' || act === 'font-global' || act === 'font-del') {
      const id = el.dataset.id || '';
      const library = getPhoneSettings().fontLibrary;
      const font = library.find(f => f.id === id);
      if (!font) return;
      if (act === 'font-theme') {
        ensureFont().family = `"${font.family}", ${PHONE_FONT_FAMILIES.hei.stack}`;
        await persist(); renderPanel();
      } else if (act === 'font-global') {
        await savePhoneSettings({ fontFamily: `u:${id}` });
        emitPhoneEvent('ubp-phone:theme-changed');
        phoneNotify(`全局字体已切换为「${font.name}」`);
      } else {
        const patch: Record<string, unknown> = { fontLibrary: library.filter(f => f.id !== id) };
        if (getPhoneSettings().fontFamily === `u:${id}`) patch.fontFamily = '';
        await savePhoneSettings(patch);
        emitPhoneEvent('ubp-phone:theme-changed');
        renderPanel();
        phoneNotify(`字体「${font.name}」已删除`);
      }
      return;
    }
  });
}
