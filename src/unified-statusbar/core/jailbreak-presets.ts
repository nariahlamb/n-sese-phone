// core/jailbreak-presets.ts
// 破限槽位（破限头 / 尾部破限）的数据归一化与预设导入导出：纯函数、零 DOM、零 config-store 依赖。
// 独立成模块的原因：config-store 归一化与设置页导入导出都要用同一套校验，且 config-store ↔
// jailbreak-config 之间不能互相 import（jailbreak-config 读 getConfig ⇒ 反向依赖会成环）。
import type {
  JailbreakPreset,
  JailbreakSegment,
  JailbreakSegmentRole,
  JailbreakSlotState,
} from './constants';
import { createJailbreakSlotState } from './constants';

const SEGMENT_ROLES: readonly JailbreakSegmentRole[] = ['system', 'user', 'assistant'];

/** 导入导出文件的格式标识与版本（导出文件顶层 format 字段；导入按此识别） */
export const JAILBREAK_PRESET_EXPORT_FORMAT = 'ub-jailbreak-presets';
export const JAILBREAK_PRESET_EXPORT_VERSION = 1;

/** 单个预设名称长度上限（防手改文件塞超长名） */
const MAX_PRESET_NAME_LEN = 60;
/** 单个预设段落数上限（UI 不设硬限，仅防畸形文件） */
const MAX_PRESET_SEGMENTS = 40;
/** 单段文本长度上限（内置破限约 2K 字符，留足自定义余量） */
const MAX_SEGMENT_TEXT_LEN = 20000;

/** 段落身份归一：非法值一律回落 system。 */
export function normalizeJailbreakSegmentRole(raw: unknown): JailbreakSegmentRole {
  return SEGMENT_ROLES.includes(raw as JailbreakSegmentRole) ? (raw as JailbreakSegmentRole) : 'system';
}

/** 单段归一：{role,text} 合法则返回新对象，非法返回 null（调用方丢弃）。 */
export function normalizeJailbreakSegment(raw: unknown): JailbreakSegment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const seg = raw as Record<string, unknown>;
  if (typeof seg.text !== 'string') return null;
  return {
    role: normalizeJailbreakSegmentRole(seg.role),
    text: seg.text.length > MAX_SEGMENT_TEXT_LEN ? seg.text.slice(0, MAX_SEGMENT_TEXT_LEN) : seg.text,
  };
}

/** 段落数组归一：逐段校验、丢弃非法项（不抛错，读侧永不因脏数据崩）。 */
export function normalizeJailbreakSegments(raw: unknown): JailbreakSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: JailbreakSegment[] = [];
  for (const item of raw) {
    const seg = normalizeJailbreakSegment(item);
    if (seg) out.push(seg);
    if (out.length >= MAX_PRESET_SEGMENTS) break;
  }
  return out;
}

/** 预设外形归一（name + segments + createdAt）：本地状态与导入文件共用的校验核心（不要求 id）。 */
function normalizePresetShape(raw: unknown): { name: string; segments: JailbreakSegment[]; createdAt: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) return null;
  return {
    name: name.length > MAX_PRESET_NAME_LEN ? name.slice(0, MAX_PRESET_NAME_LEN) : name,
    segments: normalizeJailbreakSegments(item.segments),
    createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
  };
}

/** 单预设归一：需 id 非空 + name 非空；segments 走数组归一。 */
export function normalizeJailbreakPreset(raw: unknown): JailbreakPreset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof (raw as Record<string, unknown>).id === 'string' ? String((raw as Record<string, unknown>).id).trim() : '';
  if (!id) return null;
  const shape = normalizePresetShape(raw);
  return shape ? { id, ...shape } : null;
}

/** 预设数组归一：丢弃非法项 + 同名去重（保留先出现的）。 */
export function normalizeJailbreakPresets(raw: unknown): JailbreakPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: JailbreakPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const preset = normalizeJailbreakPreset(item);
    if (!preset || seen.has(preset.name)) continue;
    seen.add(preset.name);
    out.push(preset);
  }
  return out;
}

/** 槽位状态归一：缺字段/脏数据一律回落到该字段的合法默认值。 */
export function normalizeJailbreakSlotState(raw: unknown): JailbreakSlotState {
  const fallback = createJailbreakSlotState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const item = raw as Record<string, unknown>;
  const mode = item.mode === 'none' || item.mode === 'custom' ? item.mode : 'default';
  const presets = normalizeJailbreakPresets(item.presets);
  const presetId = typeof item.presetId === 'string' ? item.presetId.trim() : '';
  return {
    mode,
    segments: normalizeJailbreakSegments(item.segments),
    // 引用已不存在的预设 ⇒ 视为临时编辑（不留悬空引用）
    presetId: presetId && presets.some(p => p.id === presetId) ? presetId : '',
    presets,
  };
}

/** 生效段落：剥掉纯空白段（空段不发送；全空由解析侧回退内置，见 jailbreak-config）。 */
export function activeJailbreakSegments(segments: readonly JailbreakSegment[]): JailbreakSegment[] {
  return segments.filter(seg => seg.text.trim() !== '');
}

/** 段落列表是否含至少一段有效内容（自定义模式「不允许为空」的判据）。 */
export function hasActiveJailbreakSegments(segments: readonly JailbreakSegment[]): boolean {
  return activeJailbreakSegments(segments).length > 0;
}

/** 导出文件名：ub破限预设-<槽位>-<日期>.json */
export function jailbreakPresetExportFilename(slot: 'head' | 'tail', now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `ub破限预设-${slot === 'head' ? '破限头' : '尾部破限'}-${stamp}.json`;
}

/** 序列化导出文本：{format,version,slot,exportedAt,presets:[{name,segments}]}（不带本地 id，导入时重新生成）。 */
export function buildJailbreakPresetExport(slot: 'head' | 'tail', presets: readonly JailbreakPreset[]): string {
  return JSON.stringify({
    format: JAILBREAK_PRESET_EXPORT_FORMAT,
    version: JAILBREAK_PRESET_EXPORT_VERSION,
    slot,
    exportedAt: Date.now(),
    presets: presets.map(preset => ({
      name: preset.name,
      segments: preset.segments.map(seg => ({ role: seg.role, text: seg.text })),
    })),
  }, null, 2);
}

export interface ParsedJailbreakPresetImport {
  /** 文件声明的槽位（缺失或非法为 ''） */
  slot: 'head' | 'tail' | '';
  presets: JailbreakPreset[];
}

/**
 * 解析导入文本：支持本模块导出格式，也接受裸数组 / {presets:[…]} 的简写形态
 * （手写分享友好）。id 一律重新生成（避免与本地预设 id 撞车）。
 * @param makeId id 生成器（面板传 generatePresetId；测试可传固定值）
 */
export function parseJailbreakPresetImport(
  text: string,
  makeId: () => string,
  now: () => number = () => Date.now(),
): ParsedJailbreakPresetImport | null {
  let raw: unknown = null;
  try {
    raw = JSON.parse(String(text ?? '').trim());
  } catch (_e) {
    return null;
  }
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).presets))
      ? (raw as Record<string, unknown>).presets
      : null;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const presets: JailbreakPreset[] = [];
  for (const item of list) {
    // 导入文件刻意不带本地 id（导出侧只写 name+segments），故此处按外形校验后重新发号
    const shape = normalizePresetShape(item);
    if (!shape || seen.has(shape.name)) continue;
    seen.add(shape.name);
    presets.push({ ...shape, id: makeId(), createdAt: shape.createdAt || now() });
  }
  const declared = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).slot
    : undefined;
  return {
    slot: declared === 'head' || declared === 'tail' ? declared : '',
    presets,
  };
}

export type JailbreakPresetMergeStrategy = 'skip' | 'overwrite';

export interface JailbreakPresetMergeResult {
  presets: JailbreakPreset[];
  added: number;
  skipped: number;
  overwritten: number;
}

/** 合并导入预设：同名按策略跳过或覆盖（覆盖保留原 id，引用它的 presetId 不悬空）。 */
export function mergeJailbreakPresets(
  existing: readonly JailbreakPreset[],
  incoming: readonly JailbreakPreset[],
  strategy: JailbreakPresetMergeStrategy,
): JailbreakPresetMergeResult {
  const presets = existing.map(p => ({ ...p, segments: p.segments.map(s => ({ ...s })) }));
  let added = 0;
  let skipped = 0;
  let overwritten = 0;
  for (const item of incoming) {
    const idx = presets.findIndex(p => p.name === item.name);
    if (idx === -1) {
      presets.push({ ...item, segments: item.segments.map(s => ({ ...s })) });
      added += 1;
      continue;
    }
    if (strategy !== 'overwrite') {
      skipped += 1;
      continue;
    }
    presets[idx] = {
      ...presets[idx],
      segments: item.segments.map(s => ({ ...s })),
    };
    overwritten += 1;
  }
  return { presets, added, skipped, overwritten };
}

/** 导入预设中的同名清单（面板预览用）。 */
export function listPresetNameConflicts(
  existing: readonly JailbreakPreset[],
  incoming: readonly JailbreakPreset[],
): string[] {
  const names = new Set(existing.map(p => p.name));
  return incoming.map(p => p.name).filter(name => names.has(name));
}
