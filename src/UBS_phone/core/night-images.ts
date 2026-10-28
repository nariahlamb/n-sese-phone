// ===== 不夜城配图生图编排（复用社媒两步法批量管线；相册来源 source='night'） =====
// 两步法（与社媒完全同构）：① 同一批待生成图合并为一次文字 AI 请求出提示词（出镜角色档案并集注入；
//    文字 API 可在设置页「不夜城 → 生图 API 单独配置」独立指定，缺省跟随共用「生图（提示词）」scope）
// ② **整批一次性入队标记**（排队中的图与在跑的那张同样显示「生成中」）后逐张经 generatePhoneImage
//    （内部走主项目共享间隔池，与主项目/其它 App 生图互不并发）→ 成功入相册；
//    中断＝整批释放队列标记，未开跑的图回落「未开始」可点击。
// 不夜城特有：① 图片带分层揭开状态（reveal/zones），生图完成后只改图本身，不改揭开级（用户自己点开）；
//            ② 连拍序列（seq）：同一次批量出 2-3 张同场景不同姿势，任务行写明差异；
//            ③ 图目标覆盖帖子图 / 直播间封面 / 搭话图片 / 委托应征图 / 专题页图。

import { collectSocialPostSubjects, socialPosterName } from './chat-image-prompts';
import {
  generatePhoneBatchPrompts,
  generatePhoneImage,
  resolvePhoneImageConfig,
  type PhoneBatchPromptTask,
} from './chat-images';
import type { ImageGenRecord } from '../../unified-statusbar/core/image-gen';
import type { PhoneGenRecord } from './chat-model';
import { mutatePhoneData, readPhoneDataRef } from './phone-store';
import { getPhoneSettings } from './phone-settings';
import { resolveNightImageApi } from './phone-api';
import { getRoster } from './roster';
import { addPhoneAlbumEntries, makeAlbumEntryId } from './phone-album';
import { nightBoardName, nt } from './night-config';
import type { NightImage, NightReveal } from './night-model';

/** 图目标定位（key 编码归属；引擎/渲染层只传 key）。 */
export interface NightImageTarget {
  key: string;
  /** 出镜主角（发帖人/台主/对方）——生图档案与相册 characters 用。 */
  author: string;
  description: string;
  /** 同批（连拍序列）内该图的差异提示（如「第 2 张：换成正脸」）。 */
  variation?: string;
  image: NightImage;
}

interface ImagePatch {
  path?: string;
  status?: 'pending' | 'ready' | 'failed';
  prompt?: string;
  negative?: string;
}

/** key 解析：`p:<postId>:<idx>` / `a:<postId>:<idx>`（专题页）/ `l:<liveId>` / `d:<dmId>:<msgId>` / `e:<postId>:<entryId>`。 */
function holderOf(key: string): { apply: (patch: ImagePatch, fn?: (img: NightImage) => void) => void; read: () => NightImage | null; postId: string } | null {
  const parts = key.split(':');
  const kind = parts[0];
  const postId = parts[1] || '';
  const idx = Number(parts[2] || '0');
  if (kind === 'p' || kind === 'a') {
    const pool = kind === 'p' ? 'posts' : 'about';
    return {
      postId,
      read: () => {
        const night = readPhoneDataRef().night;
        const holder = pool === 'posts'
          ? night?.posts.find(p => p.id === postId)
          : night?.about?.items.find(p => p.id === postId);
        return holder?.images[idx] || null;
      },
      apply: (patch, fn) => {
        mutatePhoneData(d => {
          const night = d.night;
          if (!night) return;
          const holder = pool === 'posts'
            ? night.posts.find(p => p.id === postId)
            : night.about?.items.find(p => p.id === postId);
          const img = holder?.images[idx];
          if (!img) return;
          if (patch.path !== undefined) img.path = patch.path;
          if (patch.status !== undefined) img.status = patch.status;
          if (patch.prompt !== undefined) img.prompt = patch.prompt;
          if (patch.negative !== undefined) img.negative = patch.negative;
          if (fn) fn(img);
        });
      },
    };
  }
  if (kind === 'l') {
    return {
      postId,
      read: () => {
        const live = readPhoneDataRef().night?.lives.find(l => l.id === postId);
        if (!live?.coverDesc) return null;
        return { desc: live.coverDesc, ...(live.coverPath ? { path: live.coverPath } : {}), ...(live.coverStatus ? { status: live.coverStatus } : {}), ...(live.coverPrompt ? { prompt: live.coverPrompt } : {}), ...(live.coverNegative ? { negative: live.coverNegative } : {}), ...(live.coverReveal !== undefined ? { reveal: live.coverReveal } : {}) };
      },
      apply: (patch, fn) => {
        mutatePhoneData(d => {
          const live = d.night?.lives.find(l => l.id === postId);
          if (!live) return;
          if (patch.path !== undefined) live.coverPath = patch.path;
          if (patch.status !== undefined) live.coverStatus = patch.status;
          if (patch.prompt !== undefined) live.coverPrompt = patch.prompt;
          if (patch.negative !== undefined) live.coverNegative = patch.negative;
          // 封面揭开级落在 coverReveal（无 coverZones——封面是单张主视觉，不走三区）。
          if (fn) {
            const cover: NightImage = { desc: live.coverDesc, ...(live.coverReveal !== undefined ? { reveal: live.coverReveal } : {}) };
            fn(cover);
            if (cover.reveal !== undefined) live.coverReveal = cover.reveal;
          }
        });
      },
    };
  }
  if (kind === 'd') {
    const msgId = parts[2] || '';
    return {
      postId: parts[1] || '',
      read: () => {
        const dm = readPhoneDataRef().night?.dms.find(x => x.id === postId);
        return dm?.msgs.find(m => m.id === msgId)?.image || null;
      },
      apply: (patch, fn) => {
        mutatePhoneData(d => {
          const dm = d.night?.dms.find(x => x.id === postId);
          const img = dm?.msgs.find(m => m.id === msgId)?.image;
          if (!img) return;
          if (patch.path !== undefined) img.path = patch.path;
          if (patch.status !== undefined) img.status = patch.status;
          if (patch.prompt !== undefined) img.prompt = patch.prompt;
          if (patch.negative !== undefined) img.negative = patch.negative;
          if (fn) fn(img);
        });
      },
    };
  }
  if (kind === 'e') {
    const entryId = parts[2] || '';
    return {
      postId,
      read: () => {
        const post = readPhoneDataRef().night?.posts.find(p => p.id === postId);
        return post?.entries?.find(e => e.id === entryId)?.image || null;
      },
      apply: (patch, fn) => {
        mutatePhoneData(d => {
          const post = d.night?.posts.find(p => p.id === postId);
          const img = post?.entries?.find(e => e.id === entryId)?.image;
          if (!img) return;
          if (patch.path !== undefined) img.path = patch.path;
          if (patch.status !== undefined) img.status = patch.status;
          if (patch.prompt !== undefined) img.prompt = patch.prompt;
          if (patch.negative !== undefined) img.negative = patch.negative;
          if (fn) fn(img);
        });
      },
    };
  }
  return null;
}

/** 收集全部待生成的不夜城图（跳过 failed——失败图由用户点击重试）。 */
export function collectNightImageTargets(): NightImageTarget[] {
  const night = readPhoneDataRef().night;
  if (!night) return [];
  const out: NightImageTarget[] = [];
  const wants = (img: NightImage): boolean => Boolean(img.desc) && !img.path && img.status !== 'failed';
  const pushImages = (prefix: string, id: string, author: string, images: NightImage[]): void => {
    const seqTotal = images.length;
    images.forEach((img, idx) => {
      if (!wants(img)) return;
      out.push({
        key: `${prefix}:${id}:${idx}`,
        author,
        description: img.desc,
        ...(seqTotal > 1 ? { variation: `同一次连拍的第 ${idx + 1}/${seqTotal} 张：保持同一场景同一人物，只改变姿势与机位` } : {}),
        image: img,
      });
    });
  };
  for (const post of night.posts) pushImages('p', post.id, post.author, post.images);
  for (const item of night.about?.items || []) pushImages('a', item.id, item.author, item.images);
  for (const post of night.posts) {
    for (const entry of post.entries || []) {
      if (entry.image && wants(entry.image)) {
        out.push({ key: `e:${post.id}:${entry.id}`, author: entry.author, description: entry.image.desc, image: entry.image });
      }
    }
  }
  for (const live of night.lives) {
    if (live.coverDesc && !live.coverPath && live.coverStatus !== 'failed') {
      out.push({
        key: `l:${live.id}`,
        author: live.streamer,
        description: live.coverDesc,
        image: { desc: live.coverDesc },
      });
    }
  }
  for (const dm of night.dms) {
    for (const msg of dm.msgs) {
      if (msg.image && wants(msg.image)) out.push({ key: `d:${dm.id}:${msg.id}`, author: dm.peer, description: msg.image.desc, image: msg.image });
    }
  }
  return out;
}

const _autoRunning = new Set<string>();
/** 正在生成的目标 key（**整批入队即登记**：渲染层据此判「生成中」——见 night-views.nzRevealBlock；
 *  中断残留的 pending 因不在本集合内而回落「未开始」可点击）。整批收尾/中断时成批释放。 */
const _activeKeys = new Set<string>();

export function isNightImageActive(key: string): boolean {
  return _activeKeys.has(key);
}

export function isNightAutoImageRunning(): boolean {
  return _autoRunning.size > 0;
}

/** 自动批量（与其它 App 共用全局「自动生成图片」总开关 autoImageGen：关=保留占位，点击才生图）。 */
export async function autoGenerateNightImages(): Promise<void> {
  if (_autoRunning.size) return;
  if (!getPhoneSettings().autoImageGen) return;
  const config = resolvePhoneImageConfig();
  if (config.error || !config.provider) return;
  _autoRunning.add('night');
  try {
    for (;;) {
      const pending = collectNightImageTargets();
      if (!pending.length) break;
      try {
        await generateNightImagesBatch(pending);
      } catch (_e) {
        // 批量第一步（AI 出提示词）失败整体抛出：本批待生成图落 failed（占位变「点击重试」）后结束本轮。
        // ★绝不向上 reject：调用方 `void autoGenerateNightImages()` 无 catch，reject 会让失败无人处理（F6）。
        for (const t of pending) holderOf(t.key)?.apply({ status: 'failed' });
        break;
      }
    }
  } finally {
    _autoRunning.delete('night');
  }
}

/** 批量生成一组图（无固化提示词的一次批量第一步 → **整批一次性入队标记** + 逐张第二步；单图失败只标该图）。 */
export async function generateNightImagesBatch(targets: NightImageTarget[]): Promise<void> {
  if (!targets.length) return;
  const config = resolvePhoneImageConfig();
  if (config.error || !config.provider) {
    for (const t of targets) holderOf(t.key)?.apply({ status: 'failed' });
    throw new Error(config.error || '生图配置不可用');
  }
  const provider = config.provider;
  const roster = getRoster();

  // **整批一次性入队标记**（用户定案 2026-10-06「统一小手机口径」：与微信/窥私/商家会话同款）——
  // 本批候选在**第一步（出提示词）之前**就全部登记（落盘 pending + 在跑标记），两步全程排队中的图
  // 与在跑的那张一样显示「生成中」。第一步没出到提示词的当场出队（回落失败态可点重试）；
  // **中断（第一步抛错/异常）＝ finally 整批释放**，未跑到的图回落「未开始」可点击。
  const queued: NightImageTarget[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.key) || _activeKeys.has(t.key)) continue;
    const holder = holderOf(t.key);
    const current = holder?.read();
    if (!holder || !current || current.path) continue;
    seen.add(t.key);
    queued.push(t);
  }
  for (const t of queued) {
    _activeKeys.add(t.key);
    holderOf(t.key)?.apply({ status: 'pending' });
  }
  try {
    // 批量第一步：无固化提示词的合并为一次请求（出镜角色取并集）
    const fresh = queued.filter(t => !(holderOf(t.key)?.read()?.prompt || '').trim());
    if (fresh.length) {
      const byName = new Map<string, { name: string; isProtagonist: boolean }>();
      for (const t of fresh) {
        for (const subject of collectSocialPostSubjects(t.author, t.description, roster)) {
          if (!byName.has(subject.name)) byName.set(subject.name, subject);
        }
      }
      const tasks: PhoneBatchPromptTask[] = fresh.map(t => ({
        id: t.key,
        description: t.variation ? `${t.description}（${t.variation}）` : t.description,
        characters: collectSocialPostSubjects(t.author, t.description, roster).map(x => x.name),
      }));
      const prompts = await generatePhoneBatchPrompts(provider, {
        tasks,
        subjects: [...byName.values()],
        roster,
        // 不夜城生图提示词的文字 API：设置页可单独配（关/未选=跟随共用「生图（提示词）」scope）
        api: resolveNightImageApi().api,
      });
      for (const t of fresh) {
        const hit = prompts.get(t.key);
        if (!hit) {
          holderOf(t.key)?.apply({ status: 'failed' });
          _activeKeys.delete(t.key); // 第一步就没出提示词：立即出队（失败态可点重试，不留转圈）
          continue;
        }
        holderOf(t.key)?.apply({ prompt: hit.promptText, negative: hit.negativePrompt || '' });
      }
    }

    // 第二步：逐张经 generatePhoneImage（内部走主项目共享间隔池）
    for (const t of queued) {
      const holder = holderOf(t.key);
      try {
        const current = holder?.read();
        if (!holder || !current?.prompt || current.path) continue;
        const subjects = collectSocialPostSubjects(t.author, t.description, roster);
        let genRecord: ImageGenRecord | undefined;
        try {
          const path = await generatePhoneImage({
            messageId: `night_${t.key.replace(/[:]/g, '_')}`,
            description: t.variation ? `${t.description}（${t.variation}）` : t.description,
            subjects,
            roster,
            stem: `night_${t.key.replace(/[:]/g, '_').slice(0, 40)}`,
            fixed: { promptText: current.prompt, negativePrompt: current.negative || '' },
            onRecord: record => { genRecord = record; },
          });
          holder.apply({ path, status: 'ready' });
          const poster = socialPosterName(t.author, roster);
          addPhoneAlbumEntries([{
            id: makeAlbumEntryId(),
            path,
            source: 'night',
            characters: poster ? [poster] : [],
            desc: t.description,
            imagePrompt: current.prompt,
            imageNegative: current.negative || '',
            ...(genRecord ? { gen: genRecord as unknown as PhoneGenRecord } : {}),
            createdAt: Date.now(),
          }]);
        } catch (_e) {
          holder.apply({ status: 'failed' });
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

/** 手动点单个占位（失败重试 / 用户主动洗照片）。 */
export async function generateNightImage(key: string): Promise<void> {
  const holder = holderOf(key);
  const target = collectNightImageTargets().find(t => t.key === key);
  const current = holder?.read();
  if (!holder || !current) return;
  if (current.path || _activeKeys.has(key)) return;
  const config = resolvePhoneImageConfig();
  if (config.error || !config.provider) throw new Error(config.error || '生图配置不可用（设置 → API → 生图）');
  const full = target || { key, author: '', description: current.desc, image: current };
  holder.apply({ status: 'pending' });
  try {
    await generateNightImagesBatch([full]);
  } catch (e) {
    holder.apply({ status: 'failed' });
    throw e;
  }
}

/** 不夜城图描述 → 进 AI/转发的文字（相册/私信用；拼马甲或台主的出处）。 */
export function nightImageDescWithOrigin(author: string, desc: string, style: PhoneStyleLike = ''): string {
  const who = (author || '').trim();
  const app = nt('app', style);
  return who ? `${who}的${app}：${desc}` : `${app}：${desc}`;
}

type PhoneStyleLike = '' | 'xianxia' | 'wuxia' | 'fantasy';

/** 帖子图标签（渲染层标题用）。 */
export function nightImageBoardLabel(board: string, style: PhoneStyleLike = ''): string {
  return nightBoardName(board, style);
}

// ─── 分层揭开（N2）与打码总开关：写操作归图片域，渲染层只传 image key ───

/** 按 key 读一张图（不存在返回 null）。
 *  ★返回的是 store 的**只读 live 引用**（readPhoneDataRef，零拷贝）——渲染/查看器/批量逐张读
 *  原为每张一次全量深拷贝（N 张图 = N 次整份 normalize）。只许读，写一律走 apply/updateNightImageByKey。 */
export function readNightImageByKey(key: string): NightImage | null {
  return holderOf(key)?.read() || null;
}

/** 按 key 原地改一张图（揭示级/分区/门槛解锁等本地动作的唯一写入口）。 */
export function updateNightImageByKey(key: string, fn: (img: NightImage) => void): void {
  holderOf(key)?.apply({}, fn);
}

/** 揭开到指定级（L0 轮廓 / L1 局部 / L2 全图）。 */
export function nightImageReveal(key: string, reveal: NightReveal): void {
  updateNightImageByKey(key, img => {
    img.reveal = reveal;
  });
}

/** L1 分区逐块揭开（三区：脸 / 上身 / 下身；三区全开自动转全图）。 */
export function nightImageToggleZone(key: string, zone: number): void {
  updateNightImageByKey(key, img => {
    const zones = img.zones ? [...img.zones] : [false, false, false];
    zones[zone] = !zones[zone];
    img.zones = zones;
    if (zones.every(Boolean)) img.reveal = 2;
    else if (img.reveal === 2) img.reveal = 1;
  });
}

/** 打码总开关重设：把全部图重置到设置默认级（设置页「立即重设」与开关联动用）。 */
export function nightResetAllReveals(): void {
  const settings = getPhoneSettings();
  const mask = settings.nightMaskDefault !== false;
  const def = (settings.nightRevealDefault ?? 0) as NightReveal;
  mutatePhoneData(d => {
    const night = d.night;
    if (!night) return;
    const apply = (img: NightImage): void => {
      img.reveal = mask ? def : 2;
      if (def === 0 || !mask) img.zones = [false, false, false];
    };
    for (const post of night.posts) for (const img of post.images) apply(img);
    for (const item of night.about?.items || []) for (const img of item.images) apply(img);
    for (const live of night.lives) live.coverReveal = mask ? def : 2;
    for (const dm of night.dms) for (const msg of dm.msgs) if (msg.image) apply(msg.image);
  });
}

/** 有效揭层级（未打码总开关关闭 → 恒全图；未设置 → 跟随默认级）。 */
export function nightImageEffectiveReveal(img: NightImage): NightReveal {
  const settings = getPhoneSettings();
  if (settings.nightMaskDefault === false) return 2;
  if (img.reveal !== undefined) return img.reveal;
  return (settings.nightRevealDefault ?? 0) as NightReveal;
}
