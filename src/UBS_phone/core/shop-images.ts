// ===== 网上商城 · 商品主图生图（docs/52 §5）=====
// **照搬主项目「衣柜单品」那一套**（用户定案 2026-10-06：手机侧不再有任何商品图设置——
// 「商品图预设」那个选项没有意义，文字 API 与生图 API 都跟随主项目）。两步：
//   ① 商品标签翻译器（**文字 API = 主项目「生图提示词」scope**：`getCustomApiConfig('imageGeneration')`，
//      与主项目衣柜提示词生成同一发；仅首次，结果缓存进 item.imageTags）——纯净物件标签，
//      禁人体/构图/框定/数量词（规则逐条对齐 unified-statusbar/core/wardrobe-prompts 的 itemPromptSystem）；
//   ② 前端装配主提示词（纯白无缝背景 / 商品居中 / 不得出现人物·文字·水印）→
//      按供应商格式（NAI 标签行 / OpenAI·ComfyUI 自然语言）编译 → 走手机串行生图队列 → 上传 → 缓存路径。
// **生图 API = 主项目「衣柜单品」任务切片**（`resolveImageTaskConfig('wardrobeItem', …)`：全局 provider +
// 该任务的画风预设/尺寸，1024×1024 方图）——手机自己的「生图模式/画风预设」只管聊天/社媒/相册/不夜城，与本 App 无关。
// **按需生成**：卡片永远用 emoji 图块，详情页点「看主图」才生成。
// 失败原因写回 item.imageError（详情页展示 + 重试）；同商品并发闸防双击重复生图。

import { generateImage, generateImageUngated, type ImageGenRecord } from '../../unified-statusbar/core/image-gen';
import { uploadGeneratedImage } from '../../unified-statusbar/core/image-storage';
import { getCustomApiConfig, validateCustomApiConfig } from '../../unified-statusbar/core/api-config';
import { resolveImageTaskConfig } from '../../unified-statusbar/core/image-generation-config';
import { isChatu8Channel, chatu8PromptComposeMode } from '../../unified-statusbar/core/chatu8-bridge';
import { isBaiBaiChannel } from '../../unified-statusbar/core/baibai-bridge';
import type { PortraitImageGen } from '../../unified-statusbar/core/portrait-config';
import { getJailbreakHeadPrompts, getJailbreakTailPrompts } from '../../unified-statusbar/core/jailbreak-config';
import { getTavernHelper } from './host-env';
import { getConfig } from './host-config';
import { withPhoneTextAiRetry } from './phone-api';
import { getPhoneSettings } from './phone-settings';
import { currentPhoneStorageId, mutatePhoneData, readPhoneDataRef } from './phone-store';
import { chatu8ChannelMissing, baibaiChannelMissing, enqueuePhoneImageTask, sharedImageQueue } from './chat-images';
import { emptyShopData, type ShopData, type ShopItem } from './shop-model';
import {
  assembleShopItemDisplayPrompt, buildShopBatchTagInstruction, buildShopItemTagInstruction, clampShopTags,
  parseShopBatchTags, parseShopItemTags, SHOP_ITEM_NEGATIVE,
} from './shop-prompts';

/** 正在生图的商品 id（防双击；跨 await 段受 finally 保护）。 */
const _imageBusy = new Set<string>();

/**
 * **已入队等串行生图的商品 id**（用户定案 2026-10-06「统一小手机口径」：与微信/窥私/商家会话同款——
 * 自动补图开工即把整批候选一次性登记，排队中的商品卡片与主图区同样显示「生成中」，
 * 不再只有轮到的那一件才转圈）。轮到某件时交接给 `_imageBusy`（同一同步段，画面不闪）；
 * **中断（切聊天/异常）＝ finally 整批释放**，未跑到的回落 emoji 图块可点生成。
 * 只在内存：刷新/重载即清空，不会留下点不动的「假生成中」。
 */
const _imageQueued = new Set<string>();

export function shopItemImageBusy(itemId: string): boolean {
  return _imageBusy.has(itemId) || _imageQueued.has(itemId);
}

/** 就地改写商品（货架/收藏/购物车/订单里的同一件一起改——图与标签是全域共享资产）。 */
export function patchShopItem(itemId: string, patch: Partial<ShopItem>): void {
  if (!itemId) return;
  mutatePhoneData(d => {
    const base = d.shop;
    if (!base) return;
    const apply = (it: ShopItem): ShopItem => (it.id === itemId ? { ...it, ...patch } : it);
    d.shop = {
      ...base,
      catalog: base.catalog.map(apply),
      favorites: base.favorites.map(apply),
      cart: base.cart.map(line => ({ ...line, item: apply(line.item) })),
      orders: base.orders.map(order => ({ ...order, item: apply(order.item) })),
    };
  });
}

/** 从任意域取商品（详情页打开时可能来自货架/收藏/购物车/订单）。 */
export function findShopItem(itemId: string): ShopItem | null {
  const data: ShopData = readPhoneDataRef().shop || emptyShopData();
  const hit = data.catalog.find(it => it.id === itemId)
    || data.favorites.find(it => it.id === itemId)
    || data.cart.find(line => line.item.id === itemId)?.item
    || data.orders.find(order => order.item.id === itemId)?.item;
  return hit || null;
}

/**
 * ① 标签翻译（文字 AI；失败抛错由调用方转成 imageError）。
 * **文字 API = 主项目「生图提示词」scope**（与主项目衣柜提示词生成同一发，照搬用户口径）：
 * 闸门与取用都直接走主项目 api-config（同一份偏好文件、同一个 config 单例），手机侧不再有独立选择。
 * 重试仍走小手机「生图提示词」那条自动重试设置（重试策略是手机自己的事，与 API 归属无关）。
 */
async function translateItemTags(item: ShopItem): Promise<string> {
  const cached = clampShopTags(item.imageTags || '');
  if (cached) return cached;
  const th = getTavernHelper();
  if (!th || typeof th.generateRaw !== 'function') throw new Error('无法访问酒馆助手 API（generateRaw）');
  const apiError = validateCustomApiConfig('imageGeneration');
  if (apiError) throw new Error(apiError);
  const built = buildShopItemTagInstruction({ name: item.name, desc: item.desc });
  const orderedPrompts: Array<{ role: 'system' | 'user' | 'assistant'; content: string } | 'user_input'> = [
    ...getJailbreakHeadPrompts(),
    { role: 'system', content: built.system },
    'user_input',
    ...getJailbreakTailPrompts(),
  ];
  const result = await withPhoneTextAiRetry('image', () => th.generateRaw({
    should_silence: true,
    user_input: built.userInput,
    ordered_prompts: orderedPrompts,
    custom_api: getCustomApiConfig('imageGeneration'),
  }));
  const tags = clampShopTags(parseShopItemTags(typeof result === 'string' ? result : ''));
  if (!tags) throw new Error('商品标签翻译失败（AI 未按格式输出）');
  return tags;
}

/**
 * 批量标签翻译：把整批待生图商品**合并成一次文字请求**（用户口径：进店自动补图时合并提示词请求）。
 * 失败抛错由调用方降级（逐件走单件翻译，绝不因批量失败而整批不生图）。
 */
async function translateItemsTagsBatch(items: readonly ShopItem[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!items.length) return out;
  const th = getTavernHelper();
  if (!th || typeof th.generateRaw !== 'function') throw new Error('无法访问酒馆助手 API（generateRaw）');
  const apiError = validateCustomApiConfig('imageGeneration');
  if (apiError) throw new Error(apiError);
  const built = buildShopBatchTagInstruction(items.map(it => ({ name: it.name, desc: it.desc })));
  const orderedPrompts: Array<{ role: 'system' | 'user' | 'assistant'; content: string } | 'user_input'> = [
    ...getJailbreakHeadPrompts(),
    { role: 'system', content: built.system },
    'user_input',
    ...getJailbreakTailPrompts(),
  ];
  const result = await withPhoneTextAiRetry('image', () => th.generateRaw({
    should_silence: true,
    user_input: built.userInput,
    ordered_prompts: orderedPrompts,
    custom_api: getCustomApiConfig('imageGeneration'),
  }));
  const tags = parseShopBatchTags(typeof result === 'string' ? result : '', items.length);
  items.forEach((item, i) => {
    const hit = clampShopTags(tags[i] || '');
    if (hit) out.set(item.id, hit);
  });
  return out;
}

// ─── 进店自动补图（用户口径：自动生图设置必须对商城生效） ───

/**
 * 单次文字请求最多翻译多少件（分批合并；**唯一的一处上限**，用户口径 2026-10-06 追问「有没有限制单次请求数量」）。
 * 为什么要限：货架上限可到 100 件，而商城第一步是**一次请求出全部标签**——
 * ① 请求越大越容易被截断（输出被截在中间），而截断的缺项会**逐件回退单件翻译**＝一次坏请求换来 N 发请求；
 * ② 上限取 20 与主项目衣柜批量的实际用法同量级（那边是用户手选一批，通常十几件）。
 * 分块只影响「一次请求带几件」，不影响结果：逐块翻译后仍是一次性串行生图。
 */
export const SHOP_TAG_BATCH_MAX = 20;

/** 自动补图闸（模块级：同一时刻只跑一轮，重复进店/刷新不叠加）。 */
let _autoPumpRunning = false;

export function shopAutoImageRunning(): boolean {
  return _autoPumpRunning;
}

/**
 * 待补图商品（只取**货架**：收藏/购物车/订单里的同一件走 catalog 的同一 id，不必重复扫）。
 * 跳过：已有图、上次失败（失败=用户显式重试，自动泵不反复烧请求）、正在生图中。
 */
export function shopAutoImageCandidates(): ShopItem[] {
  const data: ShopData = readPhoneDataRef().shop || emptyShopData();
  return data.catalog.filter(it => !it.image && !String(it.imageError || '').trim() && !_imageBusy.has(it.id));
}

export interface ShopAutoImageOutcome {
  /** 本轮成功补图件数。 */
  generated: number;
  /** 失败件数（原因已写回 item.imageError）。 */
  failed: number;
  /** 因未就绪/切聊天而没跑的件数。 */
  skipped: number;
  /** 本轮实际处理件数（进度文案用）。 */
  total: number;
}

/**
 * 进店自动补图（App 挂载 / 上货完成后调用）：
 *   ① 闸门＝手机全局「自动生成图片」开关（与聊天/社媒/不夜城同一把，关=零开销直接返回）；
 *   ② 配置就绪才跑（主项目「衣柜单品」不可用时不逐件失败）；
 *   ③ **整批一次性入队标记**（`_imageQueued`：排队中的商品同样显示「生成中」，与微信/窥私/商家会话同款）→
 *      **合并一次**文字请求把整批标签翻译好（缓存进 item.imageTags），再**串行**逐件生图
 *      （enqueuePhoneImageTask 本身是串行队列，且与聊天/社媒共用，不抢带宽）；
 *   ④ 聊天归属守卫：期间切聊天即停（图片与失败态都不写新聊天），中断＝队列标记整批释放。
 * onProgress：标记落位与每件完成后回调（渲染层据此补渲：整批转圈本帧可见、图一张张出现）。
 */
export async function autoGenerateShopImages(
  onProgress?: (done: number, total: number) => void,
): Promise<ShopAutoImageOutcome> {
  const out: ShopAutoImageOutcome = { generated: 0, failed: 0, skipped: 0, total: 0 };
  if (!getPhoneSettings().autoImageGen) return out; // 关=零开销（连候选都不扫）
  if (_autoPumpRunning) return out;
  const pending = shopAutoImageCandidates();
  if (!pending.length) return out;
  if (!shopImageReadiness().ready) { out.skipped = pending.length; return out; }
  const owner = currentPhoneStorageId();
  _autoPumpRunning = true;
  out.total = pending.length;
  try {
    // ③-⓪ **整批一次性入队标记**（用户定案 2026-10-06「统一小手机口径」）：先把本批候选全部登记，
    // 排队中的卡片/主图区与在跑的那件同样转圈（与微信/窥私/商家会话同款表征）；
    // 标记是内存态：中断/重载即清，不会有留在「生成中」点不动的假态。
    for (const item of pending) _imageQueued.add(item.id);
    onProgress?.(0, pending.length); // 标记落位即补渲一次（整批转圈本帧可见）
    // ③-① 合并文字请求（每块 SHOP_TAG_BATCH_MAX 件一次；失败不阻断：逐件生成时各自补翻）
    for (let i = 0; i < pending.length; i += SHOP_TAG_BATCH_MAX) {
      if (currentPhoneStorageId() !== owner) { out.skipped = pending.length; return out; }
      try {
        const batch = await translateItemsTagsBatch(pending.slice(i, i + SHOP_TAG_BATCH_MAX));
        for (const [id, tags] of batch) patchShopItem(id, { imageTags: tags });
      } catch (_e) { /* 该块翻译失败：下面逐件翻译兜底 */ }
    }
    if (currentPhoneStorageId() !== owner) { out.skipped = pending.length; return out; }
    // ③-② 串行生图（每件**开工即回调一次**补渲：卡片/主图区的转圈要马上可见，
    // 不能等到这一件生成完才让用户看到「在跑」——用户口径：生图过程要有和其他 App 一样的生成中表征）
    let done = 0;
    for (const item of pending) {
      if (currentPhoneStorageId() !== owner) { out.skipped = pending.length - done; break; }
      _imageQueued.delete(item.id); // 轮到它了：队列标记交接给在途闸（同一同步段，画面不闪）
      const job = generateShopItemImage(item.id); // 同步前缀已把该件标 busy
      onProgress?.(done, pending.length);
      const res = await job;
      if (res.ok) out.generated += 1;
      else out.failed += 1;
      done += 1;
      onProgress?.(done, pending.length);
    }
    return out;
  } finally {
    // 收尾与中断统一走这里：本批剩余件的队列标记整批释放（未跑到的回落 emoji 图块，可点「看主图」）
    for (const item of pending) _imageQueued.delete(item.id);
    _autoPumpRunning = false;
  }
}

/**
 * 生图配置 = 主项目「衣柜单品」任务切片（全局 provider + 该任务自己的画风预设/尺寸）。
 * 与主项目 `prepareWardrobeImageGeneration` 同源同口径——手机侧无任何覆盖项。
 */
export function resolveShopImageProvider(): { provider: PortraitImageGen | null; error: string | null } {
  let ig;
  try { ig = getConfig().imageGeneration; } catch (_e) { return { provider: null, error: '主项目配置不可读' }; }
  if (!ig) return { provider: null, error: '主项目配置不可读' };
  let provider: PortraitImageGen;
  try { provider = resolveImageTaskConfig('wardrobeItem', ig).provider; } catch (_e) { return { provider: null, error: '主项目生图配置不可读' }; }
  if (!provider) return { provider: null, error: '主项目生图未配置' };
  const missing = shopProviderMissing(provider);
  return missing ? { provider: null, error: `主项目「衣柜单品」生图未就绪：${missing}` } : { provider, error: null };
}

/** 通道可用性（与主项目衣柜单品同口径：按 apiFormat 查 key/url/model；插件通道只看插件在不在/配没配齐）。 */
function shopProviderMissing(p: PortraitImageGen): string | null {
  if (isChatu8Channel(p)) return chatu8ChannelMissing();
  if (isBaiBaiChannel(p)) return baibaiChannelMissing();
  if (p.apiFormat === 'novelai') return p.novelai?.key ? null : '缺少 API Key';
  if (p.apiFormat === 'openai') return p.openai?.url && p.openai?.model ? null : '缺少 URL 或模型名';
  if (p.apiFormat === 'comfyui') return p.comfyui?.url ? null : '缺少 URL';
  return null;
}

/** 第二步正式生图（优先主项目共享闸门；无桥回退本地 generateImage，与聊天生图同一套口径）。 */
function runItemImageGeneration(
  provider: Parameters<typeof generateImage>[0],
  promptText: string,
  negativePrompt: string,
  onRecord?: (record: ImageGenRecord) => void,
): Promise<string> {
  const shared = sharedImageQueue();
  if (shared) return shared.enqueue(() => generateImageUngated(provider, promptText, negativePrompt, undefined, undefined, onRecord));
  return generateImage(provider, promptText, negativePrompt, undefined, true, undefined, onRecord);
}

export type ShopImageOutcome = { ok: true; path: string } | { ok: false; error: string };

/**
 * 生成商品主图（首次会先跑标签翻译并缓存）。成功返回图片路径并写回商品；
 * 失败把原因写进 item.imageError（详情页展示 + 重试按钮）。
 */
export async function generateShopItemImage(itemId: string): Promise<ShopImageOutcome> {
  const item = findShopItem(itemId);
  if (!item) return { ok: false, error: '商品不存在' };
  if (_imageBusy.has(itemId)) return { ok: false, error: '这张图正在生成中' };
  // 聊天归属快照：生图要几十秒，期间切聊天则结果与失败态都不写新聊天（同聊天生图 F1 口径）
  const owner = currentPhoneStorageId();
  _imageBusy.add(itemId);
  try {
    const outcome = await enqueuePhoneImageTask(async (): Promise<ShopImageOutcome> => {
      try {
        const resolution = resolveShopImageProvider();
        if (resolution.error || !resolution.provider) throw new Error(resolution.error || '生图配置不可用');
        const provider = resolution.provider;
        const tags = await translateItemTags(item);
        if (tags !== (item.imageTags || '')) patchShopItem(itemId, { imageTags: tags, imageError: '' });
        const apiFormat = provider.apiFormat === 'openai' ? 'openai' : provider.apiFormat === 'comfyui' ? 'comfyui' : 'novelai';
        // 智慧姬通道按插件当前模式判形态（SD/NAI/ComfyUI 吃标签、Banana 读自然语言）；柏宝绘恒为标签
        //（其提示词主字段吃 danbooru tag）——两条插件通道的存储位都钉 openai，光看 apiFormat 会把吃标签的
        // 通道也编译成中文自然语言商品规格，商品标签形同废纸、主图与标签对不上（docs/62 §五-3）；
        // 智慧姬模式未选时 round 回 apiFormat 口径兜底。
        const chatu8Form = isChatu8Channel(provider) ? chatu8PromptComposeMode() : isBaiBaiChannel(provider) ? 'tags' : '';
        const promptText = assembleShopItemDisplayPrompt({
          apiFormat, name: item.name, desc: item.desc, tags,
          ...(chatu8Form ? { form: chatu8Form } : {}),
        });
        // 任务专属负面（防「游戏背包 UI 截图」化）任何通道都发送；OpenAI 直连无负面通道除外
        const negative = apiFormat === 'openai' && !isChatu8Channel(provider) && !isBaiBaiChannel(provider) ? '' : SHOP_ITEM_NEGATIVE;
        const dataUrl = await runItemImageGeneration(provider, promptText, negative);
        const uploaded = await uploadGeneratedImage(dataUrl, 'phone', `shop_${item.id}`);
        if (!uploaded.path) throw new Error(uploaded.error || '图片上传失败');
        if (currentPhoneStorageId() !== owner) return { ok: false, error: '已切聊天，本次生图结果丢弃' };
        patchShopItem(itemId, { image: uploaded.path, imageError: '' });
        return { ok: true, path: uploaded.path };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (currentPhoneStorageId() === owner) patchShopItem(itemId, { imageError: message.slice(0, 200) });
        return { ok: false, error: message };
      }
    });
    return outcome;
  } finally {
    _imageBusy.delete(itemId);
  }
}

/** 商品图是否可生成（主项目「衣柜单品」就绪探测；详情页据此决定按钮态与提示）。 */
export function shopImageReadiness(): { ready: boolean; error: string } {
  try {
    const resolution = resolveShopImageProvider();
    if (resolution.error || !resolution.provider) return { ready: false, error: resolution.error || '生图配置不可用' };
    return { ready: true, error: '' };
  } catch (e) {
    return { ready: false, error: e instanceof Error ? e.message : String(e) };
  }
}
