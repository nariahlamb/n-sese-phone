// ===== 皮肤外观包（导入/导出的 JSON 信封；纯函数，IO 一律由渲染层注入） =====
// 三种可导入形态：
//   ① 新信封 { format:'ubs-phone-skin', version≤2, skin, fonts? } —— 美化工坊导出（含用户字体）；
//   ② 裸 PhoneSkinDef —— docs/14 时代的旧格式（永久兼容；无字体）；
//   ③ 顶层数组 —— AI 生成物的常见形态（把多个候选方案包成数组）：取第 1 条对象条目并回报条数
//      （arrayCount，>1 时调用方提示「已取第 1 条」）；数组里没有对象条目=拒绝。
// 失败一律返回**带原因**的结果（不抛错、不返回裸 null）：syntax/not-object/array-empty/
// foreign-format/version/bad-envelope，文案由 skinPackFailureMessage 统一分诊——别家包不吞、
// 版本过新不装作不认识（信封规范见 docs/14 §3.7）。
// 图片可移植性：皮肤里的 img/home.bg 若是 /user/images/ 服务器路径，导出时由渲染层
// fetch 内联成 data: URL（有总字节预算）；导入时再把 data: 上传回图床换回路径——
// 两边各做一次，包就跨设备可分享。

import type { PhoneSkinDef } from './skin-themes';
import type { PhoneUserFont } from './phone-settings';

export const SKIN_PACK_FORMAT = 'ubs-phone-skin';
export const SKIN_PACK_VERSION = 2;
/** 导出时图片内联的总字节预算（dataUrl 字符数；超出部分保留原路径并在 skipped 里报告）。 */
export const SKIN_PACK_IMAGE_BUDGET = 8_000_000;

/** 包内字体条目：用户字体 + `use` 标记（true=导入时把这张皮肤的字体系到这个字体上）。 */
export type SkinPackFont = PhoneUserFont & { use?: boolean };

export interface SkinPack {
  format: typeof SKIN_PACK_FORMAT;
  version: number;
  exportedAt: string;
  /** 皮肤定义（已 normalize；img 可能已内联为 data: URL）。 */
  skin: PhoneSkinDef;
  /** 用户字体（可选；导入方合并进 fontLibrary，id 冲突时换新 id；带 use 标记的自动接进皮肤字体）。 */
  fonts?: SkinPackFont[];
}

export interface ParsedSkinPack {
  /** 皮肤定义原文（调用方再走 normalizePhoneSkin 清洗）。 */
  skin: unknown;
  /** 字体原文（调用方再走渲染层合并/换 id）。 */
  fonts: unknown[];
  /** 顶层是数组时：数组长度（>1 时调用方提示「已取第 1 条」）。 */
  arrayCount?: number;
}

/** 解析失败的原因（渲染层用它分诊文案，见 skinPackFailureMessage）。 */
export type SkinPackFailureReason =
  | 'syntax' // JSON 语法错（截断/注释/多余逗号）
  | 'not-object' // 顶层不是对象（数字/字符串/布尔）
  | 'array-empty' // 顶层是数组，但没有对象条目
  | 'foreign-format' // 带别家 format 字段（防误吞）
  | 'version' // 本格式信封但版本过新
  | 'bad-envelope'; // 本格式信封残缺（缺 version 或 skin 不是对象）

export interface SkinPackParseFailure {
  ok: false;
  reason: SkinPackFailureReason;
  /** 补充信息（foreign-format=对方 format 值；version=版本号）。 */
  detail?: string;
}

export type SkinPackParseResult = ({ ok: true } & ParsedSkinPack) | SkinPackParseFailure;

/** 单个对象条目的归属判定：本格式信封 / 别家包 / 裸皮肤定义。 */
function resolveSkinEntry(rec: Record<string, unknown>): SkinPackParseResult {
  if (rec.format === SKIN_PACK_FORMAT) {
    if (typeof rec.version !== 'number') return { ok: false, reason: 'bad-envelope' };
    if (rec.version > SKIN_PACK_VERSION) return { ok: false, reason: 'version', detail: String(rec.version) };
    if (!rec.skin || typeof rec.skin !== 'object' || Array.isArray(rec.skin)) {
      return { ok: false, reason: 'bad-envelope' };
    }
    return { ok: true, skin: rec.skin, fonts: Array.isArray(rec.fonts) ? rec.fonts : [] };
  }
  // 旧格式：裸 PhoneSkinDef（顶层带 format 字段但不是本格式=不认，防误吞别家包）
  if ('format' in rec) {
    return { ok: false, reason: 'foreign-format', detail: typeof rec.format === 'string' ? rec.format : undefined };
  }
  return { ok: true, skin: rec, fonts: [] };
}

/**
 * 解析皮肤文本：新信封 / 裸皮肤定义 / 顶层数组（取第 1 条对象条目并回报条数）。
 * 失败返回原因而非 null——调用方用 skinPackFailureMessage 出可读文案（用户拿到的
 * 报错必须能指向「哪里不对、接下来怎么办」）。
 */
export function parseSkinPack(text: string): SkinPackParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (_e) {
    return { ok: false, reason: 'syntax' };
  }
  if (Array.isArray(parsed)) {
    // AI 常把「多套方案」包成一个数组：取第 1 条对象条目，条数交给调用方提示（不静默）。
    const first = parsed.find((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
    if (!first) return { ok: false, reason: 'array-empty' };
    const resolved = resolveSkinEntry(first);
    return resolved.ok ? { ...resolved, arrayCount: parsed.length } : resolved;
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not-object' };
  return resolveSkinEntry(parsed as Record<string, unknown>);
}

/** 解析失败 → 面向用户的分诊文案（工坊与设置页共用一条链；说清出处与下一步）。 */
export function skinPackFailureMessage(fail: SkinPackParseFailure): string {
  switch (fail.reason) {
    case 'syntax':
      return 'JSON 语法有误（文件可能被截断、含注释或多余逗号）——请让 AI 重新输出一份完整 JSON';
    case 'not-object':
      return '顶层不是对象：皮肤应为单个 JSON 对象 {...}（或含 format 的外观包）';
    case 'array-empty':
      return '文件顶层是数组，但里面没有皮肤对象——请把其中一个皮肤单独存成文件再导入';
    case 'foreign-format':
      return `这是别家的外观包格式${fail.detail ? `（format=${fail.detail}）` : ''}，小手机无法识别`;
    case 'version':
      return `外观包版本过新（v${fail.detail}），请先升级小手机再导入`;
    case 'bad-envelope':
      return '外观包信封不完整（缺 version，或 skin 不是对象）——请重新导出外观包';
  }
}

/** 组装导出包（渲染层已把要内联的图片换成 data: URL 后调用）。 */
export function buildSkinPack(def: PhoneSkinDef, fonts: PhoneUserFont[] | null, exportedAt = new Date().toISOString()): SkinPack {
  const pack: SkinPack = { format: SKIN_PACK_FORMAT, version: SKIN_PACK_VERSION, exportedAt, skin: def };
  if (fonts && fonts.length) pack.fonts = fonts;
  return pack;
}

// ─── 包内字体的「皮肤字体」接线（use 标记；导入/导出两侧共用的纯函数） ───
// 动机：用户字体的 family 名恒由**导入时**生成的 id 派生（UBPUserFont_uf_xxxxxxxx），AI 生成的皮肤
// 引用不到——上一版只能让用户导入后在字体列表里手动点一次。约定：包内 fonts[] 条目带 use:true =
// 「我要这张皮肤用它」；导入渲染层把它的 family 前置进皮肤字体栈，导入即生效。

/** 包内标记 use 的字体名（损坏条目跳过；多个只认第一个；无=null）。 */
export function packUseFontName(fonts: readonly unknown[]): string | null {
  for (const raw of fonts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.use !== true) continue;
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 20) : '';
    if (name) return name;
  }
  return null;
}

/** 皮肤字体栈前置用户字体（`"UBPUserFont_uf_xxx", <原栈>`）；原栈里的用户字体引用一律剔掉——
 *  导入包里的旧 id 必悬空，留着只会在控制台刷找不到字体且永远回落。 */
export function prefixUserFontStack(existing: string | undefined, family: string): string {
  const cleaned = (existing || '')
    .replace(/["']?UBPUserFont_uf_[a-z0-9]{8}["']?\s*,?/g, '')
    .replace(/^\s*,+\s*/, '')
    .replace(/\s*,+\s*$/, '')
    .trim();
  return cleaned ? `"${family}", ${cleaned}` : `"${family}"`;
}

/** 导出时给「皮肤正在引用」的字体打 use 标记（字体栈里出现其 family 即算），跨设备导入后自动接线。 */
export function markUsedFonts(def: PhoneSkinDef, fonts: readonly PhoneUserFont[]): SkinPackFont[] {
  const stack = `${def.font?.family || ''} ${def.font?.display || ''}`;
  return fonts.map(f => (f.family && stack.includes(f.family) ? { ...f, use: true } : f));
}

/** 接线步骤（纯函数；渲染层合并字体库后调用）：包内 use 字体 → 皮肤字体前置。
 *  同名已在库=沿用既有；包内没标记 use=原样返回（旧包行为不变）。 */
export function wirePackFontIntoDef(
  def: PhoneSkinDef,
  packFonts: readonly unknown[],
  library: readonly PhoneUserFont[],
): { def: PhoneSkinDef; wired: string } {
  const useName = packUseFontName(packFonts);
  const hit = useName ? library.find(f => f.name === useName) : undefined;
  if (!hit || !hit.family) return { def, wired: '' };
  const font = { ...(def.font || {}) };
  font.family = prefixUserFontStack(font.family, hit.family);
  if (font.display) font.display = prefixUserFontStack(font.display, hit.family);
  return { def: { ...def, font }, wired: hit.name };
}

/** 收集皮肤里引用的服务器图片路径（img 与 home.bg/bgDark 里的 url("...") 一并算）。 */
export function collectSkinServerImagePaths(def: PhoneSkinDef): string[] {
  const paths: string[] = [];
  const push = (value: string | undefined): void => {
    if (!value) return;
    if (value.startsWith('/user/images/')) {
      paths.push(value);
      return;
    }
    // CSS 背景值里的 url("...") / url(...)
    const re = /url\((?:"|')?(\/user\/images\/[A-Za-z0-9_\-./]+)(?:"|')?\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value))) paths.push(m[1]);
  };
  for (const app of Object.values(def.icons?.apps || {})) push(app.img);
  push(def.home?.bg);
  push(def.home?.bgDark);
  return [...new Set(paths)];
}

/** 把服务器图片路径换成 data: URL（fetcher 由渲染层注入：成功=dataUrl、失败=null）。
 *  超出总预算的保留原路径并计入 skipped；def 结构其余部分逐字保留。 */
export async function inlineSkinImages(
  def: PhoneSkinDef,
  fetcher: (path: string) => Promise<string | null>,
  budget = SKIN_PACK_IMAGE_BUDGET,
): Promise<{ def: PhoneSkinDef; inlined: number; skipped: string[] }> {
  const out: PhoneSkinDef = JSON.parse(JSON.stringify(def));
  const map = new Map<string, string>();
  let used = 0;
  const skipped: string[] = [];
  for (const path of collectSkinServerImagePaths(def)) {
    const dataUrl = await fetcher(path);
    if (!dataUrl) {
      skipped.push(path);
      continue;
    }
    if (used + dataUrl.length > budget) {
      skipped.push(path);
      continue;
    }
    used += dataUrl.length;
    map.set(path, dataUrl);
  }
  const replace = (value: string | undefined): string | undefined =>
    value ? value.replace(/\/user\/images\/[A-Za-z0-9_\-./]+/g, p => map.get(p) || p) : value;
  if (out.icons?.apps) {
    for (const id of Object.keys(out.icons.apps)) {
      out.icons.apps[id].img = replace(out.icons.apps[id].img);
    }
  }
  if (out.home) {
    out.home.bg = replace(out.home.bg);
    out.home.bgDark = replace(out.home.bgDark);
  }
  return { def: out, inlined: map.size, skipped };
}

/** 收集皮肤里的 data: 图片（导入时上传回图床换路径用；含 img 与 bg 里的 url(...) 形态）。 */
export function collectSkinDataUrlImages(def: PhoneSkinDef): string[] {
  const urls: string[] = [];
  const push = (value: string | undefined): void => {
    if (!value) return;
    if (value.startsWith('data:image/')) {
      urls.push(value);
      return;
    }
    const re = /url\((?:"|')?(data:image\/[^)"]+)(?:"|')?\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value))) urls.push(m[1]);
  };
  for (const app of Object.values(def.icons?.apps || {})) push(app.img);
  push(def.home?.bg);
  push(def.home?.bgDark);
  return [...new Set(urls)];
}
