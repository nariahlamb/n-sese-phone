// ===== 相册：小手机全部生成图片的统一档案（docs/02 §7） =====
// 数据存 PhoneChatData.album（usb_phone_<h>.json，按聊天）；条目保留完整生图参数
// （两步法固化提示词 + ImageGenRecord 档案），随时可按档案重绘（regenerateFromRecord）。
// 图片本体在服务器 user/images/unified-statusbar/phone_*（image-storage 上传/删除）。
// 串行队列与聊天图片共用（chat-images.enqueuePhoneImageTask）。
// 循环淘汰（上限/开关）由设置→功能→相册驱动，收藏条目恒豁免淘汰。

import { makeId } from './ubp-utils';
import {
  regenerateFromRecord,
  isRecordReplayable,
  sanitizeImageGenRecord,
  type ImageGenRecord,
  type ImageGenRegenPatch,
} from '../../unified-statusbar/core/image-gen';
import { deleteStoredImage, uploadGeneratedImage } from '../../unified-statusbar/core/image-storage';
import {
  appendAlbumEntries,
  appendMessage,
  buildForwardedImageMessage,
  ensurePrivateConversation,
  trimAlbum,
  type Conversation,
  type PhoneAlbumEntry,
  type PhoneChatData,
  type PhoneGenRecord,
  type PhoneStyle,
} from './chat-model';
import { mutatePhoneData, readPhoneData, readPhoneDataRef } from './phone-store';
import { getRoster } from './roster';
import { selfStamp } from './social-time';
import { getPhoneSettings } from './phone-settings';
import { composeImageDesc } from './forward-model';
import { enqueuePhoneImageTask } from './chat-images';

// 事件通知（ubp-phone:data-changed）由调用方 App 层发射——core 不 import renderers。

/** 相册来源标签（相册 App 筛选/角标与统一选图弹层共用单份；forum=退役遗留只读；import=本地导入图）。 */
export const ALBUM_SOURCE_LABELS: Record<string, string> = {
  chat: '聊天', camera: '拍摄', moments: '朋友圈', forum: '论坛', tieba: '贴吧', weibo: '微博', xhs: '小红书', night: '不夜城', shop: '商城', import: '导入',
};

/** 来源筛选 chips（「全部」+各来源；forum 不入选）。 */
export const ALBUM_SOURCE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: '', label: '全部' },
  ...Object.entries(ALBUM_SOURCE_LABELS)
    .filter(([id]) => id !== 'forum')
    .map(([id, label]) => ({ id, label })),
];

/** 仙侠来源标签（docs/15：三 App 恢复，七来源全列；import 为设备级动作词，四风格统一「导入」）。 */
const ALBUM_SOURCE_LABELS_XX: Record<string, string> = {
  chat: '符讯', camera: '留影', moments: '浮生帖', tieba: '坛帖', xhs: '云笈', weibo: '风闻', night: '销金窟', shop: '货单', import: '导入',
};

/** 武侠来源标签（书信/写真/风声 + 故人笺/楼帖/图志；docs/11、docs/15）。 */
const ALBUM_SOURCE_LABELS_WX: Record<string, string> = {
  chat: '书信', camera: '写真', moments: '故人笺', tieba: '楼帖', xhs: '图志', weibo: '风声', night: '花楼密录', shop: '货单', import: '导入',
};

/** 西幻来源标签（晶讯/记影/见闻 + 篝火手记/榜文/图鉴；docs/11、docs/15）。 */
const ALBUM_SOURCE_LABELS_FT: Record<string, string> = {
  chat: '晶讯', camera: '记影', moments: '篝火手记', tieba: '榜文', xhs: '图鉴', weibo: '见闻', night: '夜宴厅', shop: '货单', import: '导入',
};

function skinnedAlbumLabels(style: PhoneStyle): Record<string, string> | null {
  return style === 'xianxia' ? ALBUM_SOURCE_LABELS_XX
    : style === 'wuxia' ? ALBUM_SOURCE_LABELS_WX
    : style === 'fantasy' ? ALBUM_SOURCE_LABELS_FT
    : null;
}

/** 来源标签按风格取用（缺省回退现代标签再回退来源 id 原文）。 */
export function albumSourceLabel(source: string, style: PhoneStyle): string {
  const labels = skinnedAlbumLabels(style);
  if (!labels) return ALBUM_SOURCE_LABELS[source] || source;
  return labels[source] || (ALBUM_SOURCE_LABELS[source] || source);
}

/** 来源筛选 chips 按风格取用（皮肤风格列 全部+六来源）。 */
export function albumSourceOptions(style: PhoneStyle): Array<{ id: string; label: string }> {
  const labels = skinnedAlbumLabels(style);
  if (!labels) return ALBUM_SOURCE_OPTIONS;
  return [
    { id: '', label: '全部' },
    ...Object.entries(labels).map(([id, label]) => ({ id, label })),
  ];
}

export function makeAlbumEntryId(): string {
  return makeId('a_');
}

/** 相册快照（新→旧，深拷贝）。 */
export function readPhoneAlbum(): PhoneAlbumEntry[] {
  return readPhoneData().album || [];
}

/** 相册只读引用（零拷贝，新→旧）。O43：相册渲染热路径（打开/收藏/筛选/删除每次重绘）专用——
 *  readPhoneData 是整机深拷贝，手机数据随游玩越来越大（聊天+图片引用），纪律「深拷贝不进热路径」。
 *  调用方禁止改写返回的数组与条目（写一律走 mutatePhoneData）。 */
export function readPhoneAlbumRef(): PhoneAlbumEntry[] {
  return readPhoneDataRef().album || [];
}

/** 按 path 找「可重放」（有完整生图档案）的相册条目：同 path 多条时取可重放的那条，无则 null。
 *  重绘的唯一取档判据——相册「换一张」按 id 走，放大页「换一张」（renderers/image-lightbox）按 path 走。 */
export function findReplayableAlbumEntryByPath(path: string): PhoneAlbumEntry | null {
  return readPhoneAlbum().find(e => e.path === path && isRecordReplayable(sanitizeImageGenRecord(e.gen))) || null;
}

/** 追加相册条目（去抖落盘走 mutatePhoneData；溢出条目连带删服务器文件）。
 *  上限与是否循环淘汰由设置驱动（收藏恒豁免淘汰），全部入档方无需各自判断。
 *  入档即盖绝对故事时间戳（编年史按天回顾用）：照片只有真实毫秒 createdAt，故事时间只能在这一刻取快照，
 *  事后用「当前时间」再算会漂移；已有 storyStamp 的条目（如从消息图片同步过来）不覆盖。 */
export function addPhoneAlbumEntries(fresh: PhoneAlbumEntry[]): void {
  if (!fresh.length) return;
  const stamp = selfStamp(getRoster().global.time);
  const incoming = stamp ? fresh.map(e => (e.storyStamp ? e : { ...e, storyStamp: stamp })) : fresh;
  const { albumCycleDelete, albumMaxEntries } = getPhoneSettings();
  let evicted: PhoneAlbumEntry[] = [];
  mutatePhoneData(d => {
    const { kept, evicted: dropped } = appendAlbumEntries(d.album || [], incoming, albumMaxEntries, albumCycleDelete);
    d.album = kept;
    evicted = dropped;
  });
  for (const e of evicted) {
    void deleteStoredImage(e.path).catch(() => undefined);
  }
}

/** 按给定上限预估将被淘汰的非收藏条目数（只读、不落盘、不看设置开关；设置页调小时先弹确认用）。 */
export function albumOverflowCount(cap: number): number {
  let plain = 0;
  let over = 0;
  for (const e of readPhoneAlbum()) {
    if (e.fav) continue;
    plain++;
    if (plain > cap) over++;
  }
  return over;
}

/** 立即按当前设置清理超出上限的非收藏条目（调小上限/重新开启循环删除后调用），连带删服务器文件。
 *  与自动淘汰同一份修剪口径（trimAlbum）；返回实际清理条数。 */
export function pruneAlbumOverflow(): number {
  const { albumCycleDelete, albumMaxEntries } = getPhoneSettings();
  if (!albumCycleDelete) return 0;
  let evicted: PhoneAlbumEntry[] = [];
  mutatePhoneData(d => {
    const { kept, evicted: dropped } = trimAlbum(d.album || [], albumMaxEntries);
    if (dropped.length) d.album = kept;
    evicted = dropped;
  });
  for (const e of evicted) {
    void deleteStoredImage(e.path).catch(() => undefined);
  }
  return evicted.length;
}

export type AlbumFavResult = { ok: true } | { ok: false; error: string };

/** 单条收藏开关（收藏条目恒豁免循环淘汰；取消收藏即回到淘汰队列）。
 *  snapshot 传入=复用调用方本帧已取的相册快照（免存在性检查再深拷贝一次）。 */
export function setAlbumFavorite(entryId: string, fav: boolean, snapshot?: readonly PhoneAlbumEntry[]): AlbumFavResult {
  const list = snapshot ?? readPhoneAlbum();
  if (!list.some(e => e.id === entryId)) return { ok: false, error: '相册条目不存在' };
  mutatePhoneData(d => {
    const target = (d.album || []).find(e => e.id === entryId);
    if (!target) return;
    if (fav) target.fav = true; else delete target.fav;
  });
  return { ok: true };
}

/** 批量收藏开关：一次落盘（对齐 deletePhoneAlbumEntries 口径），返回实际变更条数。 */
export function setAlbumFavorites(entryIds: Iterable<string>, fav: boolean): number {
  const want = new Set(entryIds);
  if (!want.size) return 0;
  let changed = 0;
  mutatePhoneData(d => {
    for (const e of d.album || []) {
      if (!want.has(e.id)) continue;
      if (fav) {
        if (!e.fav) { e.fav = true; changed++; }
      } else if (e.fav) {
        delete e.fav;
        changed++;
      }
    }
  });
  return changed;
}

/**
 * 遍历全机所有可能引用同一图片文件的记录（换图重写与「是否仍被引用」守卫共用同一口径）。
 * 路径字段名不统一，故逐域列出：会话消息/合并转发嵌套、窥私会话消息用 imagePath；
 * 社媒（朋友圈帖·贴吧帖与楼层·微博图与热评·小红书笔记·论坛遗留帖）用 imagePath；
 * 不夜城帖图/楼层图/私信图用 path、直播封面用 coverPath；
 * 另含四类可指向相册图的图片配置（会话背景/通话背景/主界面壁纸/自定义头像）。
 * 漏扫任一域＝换图后原帖或背景指向已删文件（裂图）。
 */
function eachImageRef(d: PhoneChatData, cb: (holder: Record<string, unknown>, field: string) => void): void {
  const visit = (holder: unknown, field: string): void => {
    if (holder && typeof holder === 'object') cb(holder as Record<string, unknown>, field);
  };
  const visitComments = (comments: unknown): void => {
    if (Array.isArray(comments)) for (const c of comments) visit(c, 'imagePath');
  };
  for (const conv of d.conversations) {
    for (const m of conv.messages) {
      visit(m, 'imagePath');
      if (m.log) for (const e of m.log) visit(e, 'imagePath');
    }
  }
  // 微信「我的收藏」（第八轮 §4）：收藏的图片必须算引用，否则「清空聊天/换图重写/相册修剪」
  // 会把收藏的图片文件当孤儿删掉（收藏即失效）——铁律级守卫，别漏。
  for (const f of d.wechatFavs || []) {
    visit(f, 'imagePath');
    if (f.card) visit(f.card, 'imagePath');
  }
  for (const conv of d.spy?.conversations || []) for (const m of conv.messages) visit(m, 'imagePath');
  const social = d.social;
  if (social) {
    for (const p of social.moments) { visit(p, 'imagePath'); visitComments(p.comments); }
    for (const p of social.tieba) { visit(p, 'imagePath'); visitComments(p.comments); }
    for (const p of social.weibo) { for (const i of p.images) visit(i, 'imagePath'); visitComments(p.comments); }
    for (const n of social.xhs) { visit(n, 'imagePath'); visitComments(n.comments); }
    for (const p of social.forum || []) { visit(p, 'imagePath'); visitComments(p.comments); }
  }
  const night = d.night;
  if (night) {
    for (const p of night.posts) {
      for (const i of p.images) visit(i, 'path');
      for (const e of p.entries || []) visit(e.image, 'path');
    }
    for (const l of night.lives) visit(l, 'coverPath');
    for (const dm of night.dms) for (const m of dm.msgs) visit(m.image, 'path');
  }
  for (const rec of [d.chatBgs, d.callBgs, d.avatars]) {
    if (rec) for (const key of Object.keys(rec)) cb(rec as unknown as Record<string, unknown>, key);
  }
  if (d.homeBg) visit(d, 'homeBg');
  if (d.lockBg) visit(d, 'lockBg');
}

/** 全机引用的图片路径集合（含 chatlog 嵌套转发、窥私、社媒、不夜城、图片配置）。单删/批删共用同一扫描口径。 */
function collectReferencedImagePaths(d: PhoneChatData): Set<string> {
  const refs = new Set<string>();
  eachImageRef(d, (holder, field) => {
    const p = holder[field];
    if (typeof p === 'string' && p) refs.add(p);
  });  return refs;
}

/** 纯函数口（契约测试用）：给定手机数据，该路径是否被任何域引用（含微信收藏的图片——铁律级守卫）。 */
export function isImageReferencedIn(data: PhoneChatData, path: string): boolean {
  return collectReferencedImagePaths(data).has(path);
}

/** f-b：本聊天手机数据引用的**全部**图片路径（各域引用 ∪ 相册条目自身），供清空/重置时连带删文件。
 *  引用口径与单删/批删守卫共用 eachImageRef ⇒ 删掉的正是手机自己引用的那些，不会误伤别处文件。 */
export function collectPhoneImagePaths(): string[] {
  const d = readPhoneDataRef();
  const refs = collectReferencedImagePaths(d);
  for (const e of d.album || []) if (e.path) refs.add(e.path);
  return [...refs];
}

/** f-b：删除上列图片文件（best-effort，逐条吞错——文件残留只是多占空间，不影响数据正确性）。 */
export async function deletePhoneImageFiles(paths: Iterable<string>): Promise<number> {
  let n = 0;
  for (const p of paths) {
    try { await deleteStoredImage(p); n += 1; } catch (_e) { /* best effort */ }
  }
  return n;
}

/** 该图片文件是否仍被引用（含合并转发记录嵌套引用与社媒/窥私/不夜城/背景配置；删除相册条目前校验，防裂图）。 */
export function isAlbumImageReferenced(path: string): boolean {
  return collectReferencedImagePaths(readPhoneData()).has(path);
}

/** 批量删除操作条状态（纯函数：渲染与就地同步共用，单测断言状态组合；对齐 spySelbarState）。 */
export interface AlbumSelbarState {
  canDelete: boolean;
  allSelected: boolean;
}

/** 按当前可见列表算操作条态——「全选仅可见项」，与主项目图库同口径。
 *  只读 id：入参可为相册条目，也可为渲染后格子投影的 `{id}[]`（就地同步免深拷贝读盘）。 */
export function albumSelbarState(selected: ReadonlySet<string>, list: readonly { id: string }[]): AlbumSelbarState {
  let picked = 0;
  for (const e of list) if (selected.has(e.id)) picked++;
  return { canDelete: picked > 0, allSelected: list.length > 0 && picked >= list.length };
}

/** 批量操作条收藏钮状态（纯函数：渲染与就地同步共用，对齐 albumSelbarState）。 */
export interface AlbumFavbarState {
  canFav: boolean;
  /** 已选条目是否已全部收藏（是 → 钮显示「取消收藏」，否则「收藏」）。 */
  allFav: boolean;
}

export function albumFavbarState(selected: ReadonlySet<string>, list: readonly { id: string; fav?: boolean }[]): AlbumFavbarState {
  let picked = 0;
  let fav = 0;
  for (const e of list) {
    if (!selected.has(e.id)) continue;
    picked++;
    if (e.fav) fav++;
  }
  return { canFav: picked > 0, allFav: picked > 0 && fav >= picked };
}

/** 全机换图：把任一域中等于 oldPath 的引用改写为 newPath（合并转发副本、窥私、社媒原帖、不夜城、图片配置一并跟随）。 */
function replaceImageRefs(d: PhoneChatData, oldPath: string, newPath: string): void {
  eachImageRef(d, (holder, field) => {
    if (holder[field] === oldPath) holder[field] = newPath;
  });
}

export type AlbumRegenResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * 按档案重新生图（换一张）：有固化提示词则覆盖提示词（负面词同步），seed 新随机；
 * 成功后原位替换相册条目与聊天消息引用，删旧文件。串行队列内执行。
 * 全机唯一重绘链路：相册「换一张」与放大页「换一张」（renderers/image-lightbox）都走这里。
 *
 * 通道按**小手机自己的生图模式**走（与首图同口径，docs/62 §五-1）：智慧姬模式钉 true、内置模式钉 false
 * （不跟主项目「生图接口」开关——两处各自显式选择，可能不一致）；未选择时传 undefined 跟随主项目（历史行为）。
 * 供应商仍按档案（record.provider）重放。
 */
export async function regenAlbumImage(entryId: string, signal?: AbortSignal): Promise<AlbumRegenResult> {
  return enqueuePhoneImageTask(async () => {
    try {
      const entry = readPhoneAlbum().find(e => e.id === entryId);
      if (!entry) return { ok: false, error: '相册条目不存在' };
      const gen = sanitizeImageGenRecord(entry.gen);
      if (!gen || !isRecordReplayable(gen)) return { ok: false, error: '未记录完整生图档案，不支持重新生图' };
      const patch: ImageGenRegenPatch = entry.imagePrompt
        ? { prompt: entry.imagePrompt, ...(entry.imageNegative ? { negative: entry.imageNegative } : {}) }
        : {};
      const mode = getPhoneSettings().imageMode;
      let nextGen: ImageGenRecord | undefined;
      const dataUrl = await regenerateFromRecord(gen, patch, {
        signal,
        quiet: true,
        ...(mode ? { chatu8: mode === 'chatu8', baibai: mode === 'baibai' } : {}),
      }, record => { nextGen = record; });
      const result = await uploadGeneratedImage(dataUrl, 'phone', `phone_album_${entryId.replace(/^a_/, '')}`);
      if (!result.path) return { ok: false, error: result.error || '图片上传失败' };
      const oldPath = entry.path;
      const newPath = result.path;
      mutatePhoneData(d => {
        // 同 path 的兄弟条目（不夜城「存到相册」等重复入档）一并跟随——否则删旧文件后它们裂图
        for (const e of d.album || []) {
          if (e.id === entryId) {
            e.path = newPath;
            if (nextGen) e.gen = nextGen as unknown as PhoneGenRecord;
          } else if (e.path === oldPath) {
            e.path = newPath;
          }
        }
        replaceImageRefs(d, oldPath, newPath);
      });
      if (oldPath && oldPath !== newPath) {
        try { await deleteStoredImage(oldPath); } catch (_e) { /* best effort */ }
      }
      return { ok: true, path: newPath };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export type AlbumDeleteResult = { ok: true } | { ok: false; error: string };

/** 删除相册条目 + 服务器文件（被聊天消息引用时拒绝，防聊天图挂掉）。
 *  一次读盘：条目查找与引用守卫共用同一份快照（对齐批量版 deletePhoneAlbumEntries 口径）。 */
export async function deletePhoneAlbumEntry(entryId: string): Promise<AlbumDeleteResult> {
  const data = readPhoneData();
  const entry = (data.album || []).find(e => e.id === entryId);
  if (!entry) return { ok: false, error: '相册条目不存在' };
  if (collectReferencedImagePaths(data).has(entry.path)) return { ok: false, error: '该图片仍被消息、帖子或背景引用，不能删除' };
  mutatePhoneData(d => {
    d.album = (d.album || []).filter(e => e.id !== entryId);
  });
  try { await deleteStoredImage(entry.path); } catch (_e) { /* best effort */ }
  return { ok: true };
}

export interface AlbumBatchDeleteResult { deleted: number; skipped: number; }

/**
 * 批量删除相册条目 + 服务器文件：一次读盘（引用集与条目筛选共用，避免逐条深拷贝）+ 一次落盘。
 * 仍被任一域引用（会话/窥私/社媒/不夜城/背景配置）的条目沿用单删守卫语义——跳过不删，计入 skipped，由调用方提示。
 */
export function deletePhoneAlbumEntries(entryIds: Iterable<string>): AlbumBatchDeleteResult {
  const want = new Set(entryIds);
  if (!want.size) return { deleted: 0, skipped: 0 };
  const data = readPhoneData();
  const refs = collectReferencedImagePaths(data);
  const removed: PhoneAlbumEntry[] = [];
  let skipped = 0;
  for (const e of data.album || []) {
    if (!want.has(e.id)) continue;
    if (refs.has(e.path)) { skipped++; continue; }
    removed.push(e);
  }
  if (!removed.length) return { deleted: 0, skipped };
  const removedIds = new Set(removed.map(e => e.id));
  mutatePhoneData(d => {
    d.album = (d.album || []).filter(e => !removedIds.has(e.id));
  });
  for (const e of removed) void deleteStoredImage(e.path).catch(() => undefined);
  return { deleted: removed.length, skipped };
}

export type AlbumForwardResult = { ok: true; convId: string } | { ok: false; error: string };

/**
 * 相册转发：把既有图片作为我方图片消息发给通讯录角色（取或建私聊会话）。
 * 复用图片文件不重新生图（imageStatus:'ready'）；content=条目中文描述（社媒来源先拼出处，
 * 「小明的小红书：…」）——AI 侧即「[图片]描述」，前端按 imagePath 渲染为图片。事件由 App 层发射。
 */
export function forwardAlbumImageToContact(entryId: string, contactName: string, storyTime?: string): AlbumForwardResult {
  const name = contactName.trim();
  if (!name) return { ok: false, error: '未选择联系人' };
  const entry = readPhoneAlbum().find(e => e.id === entryId);
  if (!entry) return { ok: false, error: '相册条目不存在' };
  const message = buildForwardedImageMessage(
    composeImageDesc(entry.desc, { source: entry.source, poster: entry.characters[0] || '' }),
    entry.path,
    storyTime,
  );
  if (!message) return { ok: false, error: '转发消息构建失败' };
  const convId = mutatePhoneData(d => appendMessage(ensurePrivateConversation(d, name), message).id);
  return { ok: true, convId };
}

export type AlbumEditResult = { ok: true } | { ok: false; error: string };

/** 标签编辑入参（字段 undefined=不动；空串=清空，重绘时回落到档案内原值）。 */
export interface AlbumTagPatch {
  imagePrompt?: string;
  imageNegative?: string;
}

/** 同图消息侧固化提示词同步：引用同一文件的消息（含转发副本）跟着改标签，
 *  并把按旧提示词算出的多角色结构 JSON 作废（否则 NAI 分角色会盖掉手改标签）。 */
function syncMessageImageTags(
  convs: readonly Conversation[],
  path: string,
  prompt: string | null,
  negative: string | null,
): void {
  for (const conv of convs) {
    for (const m of conv.messages) {
      if (m.imagePath !== path) continue;
      if (prompt !== null) {
        if (prompt) m.imagePrompt = prompt; else delete m.imagePrompt;
        delete m.imagePromptMulti;
      }
      if (negative !== null) {
        if (negative) m.imageNegative = negative; else delete m.imageNegative;
      }
    }
  }
}

/**
 * 编辑相册条目的生图标签（正向/负向提示词）——对齐主项目图库「编辑标签」：标签是重绘的唯一依据，
 * 保存后「换一张」按新标签重放（成功即写入新档案，成为下次基线）。
 * 空串=清空字段，重绘时回落到档案内原提示词（与主项目「空=不覆盖」同口径）；
 * 引用同一文件的消息（含被转发的那条）同步改写，免得相册改了标签、从聊天侧「换一张」还是旧标签。
 * 只改条目本身与消息固化提示词：描述/来源/出镜等其余字段与社媒侧档案不动。
 */
export function updatePhoneAlbumEntry(entryId: string, patch: AlbumTagPatch): AlbumEditResult {
  const entry = readPhoneAlbum().find(e => e.id === entryId);
  if (!entry) return { ok: false, error: '相册条目不存在' };
  const prompt = patch.imagePrompt !== undefined ? patch.imagePrompt.trim() : null;
  const negative = patch.imageNegative !== undefined ? patch.imageNegative.trim() : null;
  if (prompt === null && negative === null) return { ok: true }; // 无字段=空操作
  mutatePhoneData(d => {
    const target = (d.album || []).find(e => e.id === entryId);
    if (target) {
      if (prompt !== null) {
        if (prompt) target.imagePrompt = prompt; else delete target.imagePrompt;
      }
      if (negative !== null) {
        if (negative) target.imageNegative = negative; else delete target.imageNegative;
      }
    }
    syncMessageImageTags(d.conversations, entry.path, prompt, negative);
  });
  return { ok: true };
}

/**
 * 聊天消息「换一张」成功后的相册同步：按旧路径更新条目，并替换全机同一文件的引用
 * （转发副本、社媒原帖、窥私、不夜城、背景配置），最后删旧文件（best effort）。
 */
export function syncAlbumEntryForMessageImage(oldPath: string, newPath: string, gen?: ImageGenRecord): void {
  if (!oldPath || oldPath === newPath) return;
  mutatePhoneData(d => {
    const entry = (d.album || []).find(e => e.path === oldPath);
    if (entry) {
      entry.path = newPath;
      if (gen) entry.gen = gen as unknown as PhoneGenRecord;
    }
    replaceImageRefs(d, oldPath, newPath);
  });
  void deleteStoredImage(oldPath).catch(() => undefined);
}
