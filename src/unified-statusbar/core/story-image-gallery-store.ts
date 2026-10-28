// ===== 正文插图全局图库（跨聊天/跨角色卡共享） =====
// 与仓库/衣柜目录同级全局域：usb_g_story-images_* snapshot+segment 协议（连字符，见 core/storage-namespaces.ts）。
// 条目含来源角色卡名标签；图片本体在服务器 user/images/unified-statusbar/story-image_*，
// 删除条目时连带删服务器文件（imageStorage.deleteStoredImage）。
import { cloneJson } from './external-storage-codec';
import type { ExternalObjectStore } from './external-object-store';
import { imageStorage, isOwnedStoryImagePath } from './image-storage';
import { sanitizeImageGenRecord, type ImageGenRecord } from './image-gen';

export type StoryImageGenRecord = ImageGenRecord;

export interface StoryImageEntry {
  id: string;
  path: string;
  filename: string;
  /** 来源角色卡名（图库卡片标签）。 */
  charName: string;
  /** 生图提示词（AI 原始 tag 块，存档，供排查/复刻）。 */
  promptText: string;
  /** 中文画面描述（AI desc: 行；旧条目/漏写为空串，悬浮查看用）。 */
  description?: string;
  /** 生图档案：生成那一刻实际发出的完整请求快照（最终提示词+参数+实际 seed）。
   *  旧条目/采集前生成无此字段，详情弹窗显示「未记录」。 */
  gen?: StoryImageGenRecord;
  createdAt: number;
}

let _store: ExternalObjectStore | null = null;
let _entries: StoryImageEntry[] | null = null;
let _writeChain: Promise<unknown> = Promise.resolve();

export function configureStoryImageGalleryStorage(store: ExternalObjectStore | null): void {
  _store = store;
  _entries = null;
  _writeChain = Promise.resolve();
}

function sanitizeEntries(raw: unknown): StoryImageEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: StoryImageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) continue;
    if (!isOwnedStoryImagePath(e.path)) continue;
    out.push({
      id: e.id,
      path: e.path,
      filename: typeof e.filename === 'string' && e.filename ? e.filename : String(e.path).split('/').pop() || '',
      charName: typeof e.charName === 'string' ? e.charName : '',
      promptText: typeof e.promptText === 'string' ? e.promptText : '',
      description: typeof e.description === 'string' ? e.description.slice(0, 200) : '',
      gen: sanitizeImageGenRecord(e.gen),
      createdAt: typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0,
    });
  }
  return out;
}

/** 读取图库（新→旧）；无存储时返回空数组。 */
export function readStoryImageGallery(): StoryImageEntry[] {
  if (_entries) return cloneJson(_entries);
  const raw = _store?.readAll() || {};
  const list = sanitizeEntries(raw.images).sort((a, b) => b.createdAt - a.createdAt);
  _entries = list;
  return cloneJson(list);
}

/** 纯函数：加入新条目并修剪到上限，返回 [保留列表, 需删除的溢出条目]。 */
export function appendAndPruneStoryImages(
  entries: StoryImageEntry[],
  fresh: StoryImageEntry,
  limit: number,
): { kept: StoryImageEntry[]; evicted: StoryImageEntry[] } {
  const merged = [...entries, fresh].sort((a, b) => b.createdAt - a.createdAt);
  const cap = Math.max(20, Math.min(500, Math.floor(limit) || 200));
  return { kept: merged.slice(0, cap), evicted: merged.slice(cap) };
}

function persist(next: StoryImageEntry[], evicted: StoryImageEntry[]): Promise<boolean> {
  const store = _store;
  const run = async (): Promise<boolean> => {
    if (!store) return false;
    const ok = await store.patch({ images: next } as unknown as Record<string, unknown>);
    if (!ok) return false;
    _entries = cloneJson(next);
    // 溢出条目连带删服务器文件（失败仅忽略——文件残留无害，条目已清）
    for (const e of evicted) {
      try { await imageStorage.deleteStoredImage(e.path); } catch (_err) { /* ignore */ }
    }
    return true;
  };
  const result = _writeChain.then(run, run);
  _writeChain = result.then(() => undefined, () => undefined);
  return result;
}

/** 新增一条图库记录（含上限修剪）。返回是否落盘成功。 */
export function addStoryImageEntry(entry: StoryImageEntry, limit: number): Promise<boolean> {
  const current = _entries || readStoryImageGallery();
  const { kept, evicted } = appendAndPruneStoryImages(current, entry, limit);
  return persist(kept, evicted);
}

/** 删除单条（连带服务器文件）。返回是否落盘成功。 */
export async function deleteStoryImageEntry(id: string): Promise<boolean> {
  const current = _entries || readStoryImageGallery();
  const target = current.find(e => e.id === id);
  if (!target) return false;
  const next = current.filter(e => e.id !== id);
  const ok = await persist(next, [target]);
  return ok;
}

/** 编辑单条的文本字段（详情弹窗保存）：描述/AI 原始提示词块/档案内最终正负提示词。
 *  档案缺失（旧条目）但改了档案提示词时补建 unknown 档案；模型与参数恒不可改。返回是否落盘成功。 */
export async function updateStoryImageEntry(
  id: string,
  patch: { description?: string; promptText?: string; genPrompt?: string; genNegative?: string },
): Promise<boolean> {
  const current = _entries || readStoryImageGallery();
  const idx = current.findIndex(e => e.id === id);
  if (idx < 0) return false;
  const target = cloneJson(current[idx]) as StoryImageEntry;
  if (patch.description !== undefined) target.description = patch.description.slice(0, 200);
  if (patch.promptText !== undefined) target.promptText = patch.promptText.slice(0, 8000);
  if (!target.gen && (patch.genPrompt !== undefined || patch.genNegative !== undefined)) {
    target.gen = { provider: 'unknown', model: '', prompt: '', negative: '', params: {} };
  }
  if (target.gen) {
    if (patch.genPrompt !== undefined) target.gen.prompt = patch.genPrompt.slice(0, 8000);
    if (patch.genNegative !== undefined) target.gen.negative = patch.genNegative.slice(0, 4000);
  }
  const next = current.slice();
  next[idx] = target;
  return persist(next, []);
}

/** 重新生图：替换单条的图片本体引用（新 path/filename）与生图档案（=本次实际发送形态）。
 *  仅替换不追加，不触发上限修剪；失败不落盘，旧引用原样。返回是否落盘成功。 */
export async function replaceStoryImageEntry(
  id: string,
  patch: { path: string; filename: string; gen?: StoryImageGenRecord; createdAt?: number },
): Promise<boolean> {
  const current = _entries || readStoryImageGallery();
  const idx = current.findIndex(e => e.id === id);
  if (idx < 0) return false;
  if (!isOwnedStoryImagePath(patch.path)) return false;
  const target = cloneJson(current[idx]) as StoryImageEntry;
  target.path = patch.path;
  target.filename = patch.filename;
  if (patch.gen) target.gen = patch.gen;
  if (patch.createdAt !== undefined) target.createdAt = patch.createdAt;
  const next = current.slice();
  next[idx] = target;
  return persist(next, []);
}

export async function flushStoryImageGallery(): Promise<void> {
  await _writeChain;
  await _store?.flush();
}
