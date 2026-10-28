// ===== 社媒配图生图编排（贴吧/微博/小红书共用；朋友圈保持 app-moments 自有路径不动） =====
// 两步法批量版（用户定案，参考主项目衣柜「一次整理全部角色」）：
// ① 批量第一步：同一批待生成图合并为一次文字 AI 请求出提示词（任务清单+出镜角色档案并集注入，
//    逐张列明 id/描述/涉及人物；PORTRAIT_JSON_BATCH 契约），解析后逐张固化提示词——第二步失败不丢第一步。
// ② 第二步：**整批一次性入队标记**（排队中的图与在跑的那张同样显示「生成中」）后逐张经 generatePhoneImage
//    （内部优先走主项目共享生图间隔池 __ubImageGenQueue，多张图自动排队且与主项目生图互不并发），
//    成功入相册（source=各 App tag，可筛选/重绘）；中断＝整批释放队列标记，未开跑的回落「未开始」可点击。
// 手动点击单个占位 = 同一管线跑 1 张；自动生图（per-app 设置 autoImageGen）循环消费至无待生成。
// 重试：已固化提示词的目标跳过第一步直接第二步（点失败占位即重试）。
// 入相册条目的来源信息=source（来源 App）+ characters（只记发帖人，「来源角色」；路人留空），
// 画面里出现谁由配图描述文字承载（提示词同步要求写清主体）——用户定案，见 forward-model.composeImageDesc。

import { collectSocialPostSubjects, socialPosterName } from './chat-image-prompts';
import {
  generatePhoneBatchPrompts,
  generatePhoneImage,
  resolvePhoneImageConfig,
  type PhoneBatchPromptTask,
} from './chat-images';
import type { ImageGenRecord } from '../../unified-statusbar/core/image-gen';
import type { PhoneGenRecord, PhoneAlbumSource } from './chat-model';
import { mutatePhoneData, readPhoneDataRef } from './phone-store';
import { getPhoneSettings } from './phone-settings';
import { getRoster } from './roster';
import { addPhoneAlbumEntries, makeAlbumEntryId } from './phone-album';

export type SocialImageKind = 'tieba' | 'weibo' | 'xhs';

const ALBUM_SOURCE: Record<SocialImageKind, PhoneAlbumSource> = { tieba: 'tieba', weibo: 'weibo', xhs: 'xhs' };

/** 一张待生成的图（key 定位：帖子图=postId；贴吧楼层图=`c:帖子:楼层`；微博第 N 图=`w:帖子:序号`）。 */
export interface SocialImageTarget {
  key: string;
  postId: string;
  author: string;
  description: string;
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  imagePrompt?: string;
  imageNegative?: string;
}

interface ImageStatePatch {
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  imagePrompt?: string;
  imageNegative?: string;
}

/** 就地写入一张图的状态（按 kind+key 定位到帖子/楼层/微博图/笔记）。 */
function patchTargetState(kind: SocialImageKind, key: string, patch: ImageStatePatch): void {
  mutatePhoneData(d => {
    const social = d.social;
    if (!social) return;
    const apply = (holder: Record<string, unknown>): void => {
      if (patch.imagePath !== undefined) holder.imagePath = patch.imagePath;
      if (patch.imageStatus !== undefined) holder.imageStatus = patch.imageStatus;
      if (patch.imagePrompt !== undefined) holder.imagePrompt = patch.imagePrompt;
      if (patch.imageNegative !== undefined) holder.imageNegative = patch.imageNegative;
    };
    if (kind === 'tieba') {
      if (key.startsWith('c:')) {
        const [, postId, idxRaw] = key.split(':');
        const post = social.tieba.find(p => p.id === postId);
        const comment = post?.comments[Number(idxRaw)];
        if (comment) apply(comment as unknown as Record<string, unknown>);
      } else {
        const post = social.tieba.find(p => p.id === key);
        if (post) apply(post as unknown as Record<string, unknown>);
      }
    } else if (kind === 'weibo') {
      if (key.startsWith('w:')) {
        const [, postId, idxRaw] = key.split(':');
        const post = social.weibo.find(p => p.id === postId);
        const image = post?.images[Number(idxRaw)];
        if (image) apply(image as unknown as Record<string, unknown>);
      } else {
        const post = social.weibo.find(p => p.id === key);
        if (post?.images[0]) apply(post.images[0] as unknown as Record<string, unknown>);
      }
    } else {
      const note = social.xhs.find(n => n.id === key);
      if (note) apply(note as unknown as Record<string, unknown>);
    }
  });
}

function readTarget(kind: SocialImageKind, key: string): SocialImageTarget | null {
  const social = readSocialOfData();
  if (kind === 'tieba') {
    if (key.startsWith('c:')) {
      const [, postId, idxRaw] = key.split(':');
      const post = social.tieba.find(p => p.id === postId);
      const comment = post?.comments[Number(idxRaw)];
      if (!post || !comment?.imageDesc) return null;
      return {
        key, postId, author: comment.name, description: comment.imageDesc,
        imagePath: comment.imagePath, imageStatus: comment.imageStatus,
        imagePrompt: comment.imagePrompt, imageNegative: comment.imageNegative,
      };
    }
    const post = social.tieba.find(p => p.id === key);
    if (!post?.imageDesc) return null;
    return {
      key, postId: post.id, author: post.author, description: post.imageDesc,
      imagePath: post.imagePath, imageStatus: post.imageStatus,
      imagePrompt: post.imagePrompt, imageNegative: post.imageNegative,
    };
  }
  if (kind === 'weibo') {
    if (key.startsWith('w:')) {
      const [, postId, idxRaw] = key.split(':');
      const post = social.weibo.find(p => p.id === postId);
      const image = post?.images[Number(idxRaw)];
      if (!post || !image?.desc) return null;
      return {
        key, postId: post.id, author: post.author, description: image.desc,
        imagePath: image.imagePath, imageStatus: image.imageStatus,
        imagePrompt: image.imagePrompt, imageNegative: image.imageNegative,
      };
    }
    const post = social.weibo.find(p => p.id === key);
    const image = post?.images[0];
    if (!post || !image?.desc) return null;
    return {
      key, postId: post.id, author: post.author, description: image.desc,
      imagePath: image.imagePath, imageStatus: image.imageStatus,
      imagePrompt: image.imagePrompt, imageNegative: image.imageNegative,
    };
  }
  const note = social.xhs.find(n => n.id === key);
  if (!note?.imageDesc) return null;
  return {
    key, postId: note.id, author: note.author, description: note.imageDesc,
    imagePath: note.imagePath, imageStatus: note.imageStatus,
    imagePrompt: note.imagePrompt, imageNegative: note.imageNegative,
  };
}

/** 社媒域只读快照：走 readPhoneDataRef 零拷贝——readTarget 在收集循环里被逐图调用，
 *  原每次整份深拷贝（收集 N 张待生成图 = N+1 次 normalize）。只读，禁改写。 */
function readSocialOfData() {
  return readPhoneDataRef().social || { moments: [], tieba: [], weibo: [], xhs: [], bars: [], trending: [], refreshedAt: 0, pending: [] };
}

/** 收集本平台全部待生成的图（跳过 failed——失败图由用户点击重试）。 */
export function collectSocialImageTargets(kind: SocialImageKind): SocialImageTarget[] {
  const social = readSocialOfData();
  const out: SocialImageTarget[] = [];
  const wants = (t: { imagePath?: string; imageStatus?: string }) => !t.imagePath && t.imageStatus !== 'failed';
  if (kind === 'tieba') {
    for (const post of social.tieba) {
      if (post.imageDesc && wants(post)) out.push(readTarget(kind, post.id)!);
      post.comments.forEach((c, idx) => {
        if (c.imageDesc && wants(c)) out.push(readTarget(kind, `c:${post.id}:${idx}`)!);
      });
    }
  } else if (kind === 'weibo') {
    for (const post of social.weibo) {
      post.images.forEach((img, idx) => {
        if (img.desc && wants(img)) out.push(readTarget(kind, idx === 0 ? post.id : `w:${post.id}:${idx}`)!);
      });
    }
  } else {
    for (const note of social.xhs) {
      if (note.imageDesc && wants(note)) out.push(readTarget(kind, note.id)!);
    }
  }
  return out.filter(Boolean);
}

// ─── 自动批量（per-app autoImageGen；mount/刷新后调用，循环消费至无待生成） ───

const _autoRunning = new Set<SocialImageKind>();

/** 正在生成的目标 key（**整批入队即登记**：手动单张与自动批量共用；渲染器据此区分
 *  「pending 且在跑（含排队等待）」与中断残留的假 pending）。整批收尾/中断时成批释放。 */
const _activeKeys = new Set<string>();

export function isSocialImageActive(key: string): boolean {
  return _activeKeys.has(key);
}

export function isAutoImageRunning(kind: SocialImageKind): boolean {
  return _autoRunning.has(kind);
}

export async function autoGenerateSocialImages(kind: SocialImageKind): Promise<void> {
  if (_autoRunning.has(kind)) return;
  if (!getPhoneSettings().autoImageGen) return;
  const config = resolvePhoneImageConfig();
  if (config.error || !config.provider) return;
  _autoRunning.add(kind);
  try {
    for (;;) {
      const pending = collectSocialImageTargets(kind);
      if (!pending.length) break;
      try {
        await generateSocialImagesBatch(kind, pending);
      } catch (_e) {
        // 批量第一步（AI 出提示词）失败会整体抛出：把本批待生成图落 failed
        //（占位由「未开始/生成中」变「⚠ 生成失败 · 点击重试」），并结束本轮。
        // ★绝不向上 reject：调用方是 `void autoGenerate(...).then(render)`，reject 会让
        // 重绘不执行、失败无人处理，占位就此卡住（F6）。
        for (const t of pending) patchTargetState(kind, t.key, { imageStatus: 'failed' });
        break;
      }
    }
  } finally {
    _autoRunning.delete(kind);
  }
}

/**
 * 批量生成一组图：无固化提示词的合并为一次批量第一步（出镜角色取并集），随后**整批一次性入队标记**、逐张第二步。
 * 任意图失败只标记该图，不影响其余；中断（第一步抛错/异常）＝整批释放队列标记，未开跑的图回落「未开始」可点击。
 */
export async function generateSocialImagesBatch(kind: SocialImageKind, targets: SocialImageTarget[]): Promise<void> {
  if (!targets.length) return;
  const config = resolvePhoneImageConfig();
  if (config.error || !config.provider) {
    for (const t of targets) patchTargetState(kind, t.key, { imageStatus: 'failed' });
    throw new Error(config.error || '生图配置不可用');
  }
  const provider = config.provider;
  const roster = getRoster();

  // **整批一次性入队标记**（用户定案 2026-10-06「统一小手机口径」：与微信/窥私/商家会话同款）——
  // 本批候选在**第一步（出提示词）之前**就全部登记，两步全程排队中的图与在跑的那张一样显示「生成中」，
  // 不再只有轮到的那张才转圈。第一步没出到提示词的当场出队（回落失败态可点重试）；
  // **中断（第一步抛错/异常）＝ finally 整批释放**，未跑到的回落「未开始」可点击
  //（残留的 pending 就是既有的「假 pending」——渲染判据是 pending 且引擎在跑）。
  const queued: SocialImageTarget[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.key) || _activeKeys.has(t.key)) continue;
    const current = readTarget(kind, t.key);
    if (!current || current.imagePath) continue;
    seen.add(t.key);
    queued.push(t);
  }
  for (const t of queued) {
    _activeKeys.add(t.key);
    patchTargetState(kind, t.key, { imageStatus: 'pending' });
  }
  try {
    // 批量第一步：出镜角色=各图 collectSocialPostSubjects 的并集（按名去重，发帖人仅通讯录/主角带档案+描述点名者）
    const fresh = queued.filter(t => !(readTarget(kind, t.key)?.imagePrompt || '').trim());
    if (fresh.length) {
      const byName = new Map<string, { name: string; isProtagonist: boolean }>();
      for (const t of fresh) {
        for (const s of collectSocialPostSubjects(t.author, t.description, roster)) {
          if (!byName.has(s.name)) byName.set(s.name, s);
        }
      }
      const tasks: PhoneBatchPromptTask[] = fresh.map(t => ({
        id: t.key,
        description: t.description,
        characters: collectSocialPostSubjects(t.author, t.description, roster).map(s => s.name),
      }));
      const prompts = await generatePhoneBatchPrompts(provider, { tasks, subjects: [...byName.values()], roster });
      for (const t of fresh) {
        const hit = prompts.get(t.key);
        if (!hit) {
          patchTargetState(kind, t.key, { imageStatus: 'failed' });
          _activeKeys.delete(t.key); // 第一步就没出提示词：立即出队（失败态可点重试，不留转圈）
          continue;
        }
        patchTargetState(kind, t.key, { imagePrompt: hit.promptText, imageNegative: hit.negativePrompt || '' });
      }
    }

    // 第二步：逐张走 generatePhoneImage（fixed 路径跳过第一步；内部经共享生图间隔池排队）
    for (const t of queued) {
      const current = readTarget(kind, t.key);
      try {
        if (!current?.imagePrompt || current.imagePath) continue;
        const subjects = collectSocialPostSubjects(current.author, current.description, roster);
        let genRecord: ImageGenRecord | undefined;
        try {
          const path = await generatePhoneImage({
            messageId: `social_${kind}_${t.key}`,
            description: current.description,
            subjects,
            roster,
            stem: `${kind}_${t.postId.replace(/^s_/, '')}${t.key.includes(':') ? `_${t.key.split(':').slice(1).join('_')}` : ''}`,
            fixed: { promptText: current.imagePrompt, negativePrompt: current.imageNegative || '' },
            onRecord: record => { genRecord = record; },
          });
          patchTargetState(kind, t.key, { imagePath: path, imageStatus: 'ready' });
          const poster = socialPosterName(current.author, roster);
          addPhoneAlbumEntries([{
            id: makeAlbumEntryId(),
            path,
            source: ALBUM_SOURCE[kind],
            characters: poster ? [poster] : [], // 只记发帖人（来源角色）；画面里出现谁由描述文字承载
            desc: current.description,
            imagePrompt: current.imagePrompt,
            imageNegative: current.imageNegative || '',
            ...(genRecord ? { gen: genRecord as unknown as PhoneGenRecord } : {}),
            createdAt: Date.now(),
          }]);
        } catch (_e) {
          patchTargetState(kind, t.key, { imageStatus: 'failed' });
        }
      } finally {
        _activeKeys.delete(t.key); // 这一张收尾（成功/失败/跳过都释放）：批内其余件仍挂着队列标记继续转圈
      }
    }
  } finally {
    // 中断：本批剩余件整批释放（渲染判据是「pending 且引擎在跑」，撤掉在跑标记即回落「未开始」可点击）
    for (const t of queued) _activeKeys.delete(t.key);
  }
}

/** 手动点击单个占位：同一批量管线跑 1 张（已固化提示词时直接第二步=失败重试）。 */
export async function generateSocialImage(kind: SocialImageKind, key: string): Promise<void> {
  const target = readTarget(kind, key);
  if (!target || target.imagePath) return;
  if (_activeKeys.has(key)) return; // 该图已在生成（防双击重复排队）
  const config = resolvePhoneImageConfig();
  if (config.error || !config.provider) throw new Error(config.error || '生图配置不可用（设置 → API → 生图）');
  patchTargetState(kind, key, { imageStatus: 'pending' });
  try {
    await generateSocialImagesBatch(kind, [readTarget(kind, key)!]);
  } catch (e) {
    patchTargetState(kind, key, { imageStatus: 'failed' });
    throw e;
  }
}
