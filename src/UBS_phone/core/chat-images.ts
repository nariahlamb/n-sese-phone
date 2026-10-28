// ===== 聊天图片生成（两步法；第一步双管线，用户定案） =====
// 第一步 提示词生成（buildPhoneImagePrompt 双管线）：
//   单人出镜 → 立绘同源管线：发送者资料块 + 图片描述 + 最近聊天记录 → generateRaw
//     → parsePromptOutput → buildPromptTextByMode（includeFanwork 跟随同人标记）→ assembleFinalPrompt。
//   ≥2 人出镜 → 主项目正文插图同款标签行管线：<UBS_image> 块（Scene/Character N Prompt/UC/|centers），
//     同人规则段逐字复用 STORY_IMAGE_FANWORK_RULE；解析复用 story-image-parser
//     （parseStoryImageBlocks + parseMultiCharPrompt），与主项目正文插图第二步完全同源。
// 第二步 正式生图：固化提示词 + 小手机选的 生图模式/预设（resolveImageTaskConfig 合并链）→ generateImage
//   （模式五选一：NovelAI / OpenAI 兼容 / ComfyUI / 智慧姬 / 柏宝绘——插件通道=转交酒馆里的对应插件执行）
//   → uploadGeneratedImage('phone')。story 形态解析出多角色结构即走 char_captions/centers/use_coords
//   （与正文插图一致，单人物也走；OpenAI/ComfyUI 由 generateImage 内部 flattenStoryMulti 扁平化）；
//   portrait 形态维持 NAI 且 ≥2 有效角色的旧门槛。
// 提示词固化：第一步完成后经 onPromptReady 写回消息（imagePrompt/imageNegative），此后重试/重新生图
//   直接走第二步，不再烧文字 AI。固化提示词无 multiJson 时按标签行结构自愈重解析（朋友圈/社媒批量
//   路径不存 multiJson，story 格式提示词据此恢复 NAI 分角色）。串行队列防并发；失败抛错由调用方落
//   failed 占位，原因经 getImageError 展示。

import { generateImage, generateImageUngated, type ImageGenRecord } from '../../unified-statusbar/core/image-gen';
import { getChatu8Settings } from '../../unified-statusbar/core/chatu8-bridge';
import { getBaiBaiApi, baibaiBackendStatus } from '../../unified-statusbar/core/baibai-bridge';
import { deleteStoredImage, uploadGeneratedImage } from '../../unified-statusbar/core/image-storage';
import { resolveImageTaskConfig, resolvePromptPresetSlice } from '../../unified-statusbar/core/image-generation-config';
import type { ImageGenerationConfig } from '../../unified-statusbar/core/image-generation-config';
import type { CustomApiConfig } from '../../unified-statusbar/core/api-config';
import type { PortraitApiFormat, PortraitImageGen } from '../../unified-statusbar/core/portrait-config';
import { getJailbreakHeadPrompts, getJailbreakTailPrompts } from '../../unified-statusbar/core/jailbreak-config';
import {
  assembleFinalPrompt,
  buildPromptStoryMulti,
  buildPromptTextByMode,
  parsePromptOutput,
} from '../../unified-statusbar/core/portrait-prompt-text';
import { getConfig } from './host-config';
import { getPhoneSettings } from './phone-settings';
import type { PhoneImageMode } from './phone-settings';
import { getTavernHelper, hostWindow, phoneNotify } from './host-env';
import { resolvePhoneApi, withPhoneTextAiRetry } from './phone-api';
import { buildPhoneImagePrompt, buildPhoneImagePromptBatch, type PhoneImageSubject } from './chat-image-prompts';
import {
  parseMultiCharPrompt,
  parseStoryImageBlocks,
  type StoryImageBlock,
  type StoryMultiChar,
} from '../../unified-statusbar/core/story-image-parser';
import type { PhoneMapLocation } from './map-locations';
import type { RosterSnapshot } from './roster';

/** 最近一次生图失败原因（会话内存态，按 messageId；成功即清除）。 */
const _imageErrors = new Map<string, string>();
/** 失败原因表上限（FIFO 淘汰最旧一条）：只用来给 failed 占位显示一行原因，不该无界增长。 */
const IMAGE_ERROR_MAX = 200;

/** 单批自动生图上限（用户拍板，2026-10-05）：一次聊天回复（含其它一次进批的消息）最多自动生成 8 张；
 *  超额的图片消息标 `imageManual=true` 落到「点击生成」占位（自动泵永不接手），并屏内轻提示告知用户手动生成。 */
export const MAX_AUTO_IMAGES_PER_BATCH = 8;

export function getImageError(messageId: string): string {
  return _imageErrors.get(messageId) || '';
}

/**
 * 清空失败原因表（切聊天/重绑时调用）。
 * 失败原因与 messageId 绑定，而 messageId 属于**上一个聊天**的存档；不清理会跨聊天串味，
 * 且 Map 只增不减（仅成功时删单条）⇒ 长时间使用内存单调增长（F7）。
 */
export function clearPhoneImageErrors(): void {
  _imageErrors.clear();
}

let _queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = _queue.then(task, task);
  _queue = run.then(() => undefined, () => undefined);
  return run;
}

/** 小手机生图串行队列（相册重绘等共用，保证同时只有一个生图请求）。 */
export function enqueuePhoneImageTask<T>(task: () => Promise<T>): Promise<T> {
  return enqueue(task);
}

function providerNegative(provider: any): string {
  if (!provider) return '';
  // openai 直连无负面通道；外部通道（智慧姬/柏宝绘）直连不发预设负面（由插件接管）；其余按供应商切片取预设负面
  if (provider.apiFormat === 'openai' && provider.openai?.chatu8 !== true && provider.openai?.baibai !== true) return '';
  return resolvePromptPresetSlice(provider as any).negative;
}

// ─── 共享生图间隔池（跨 bundle 与主项目共用同一间隔闸门，防并发撞车） ───

/** 主项目挂载的共享生图闸门（index.ts __ubImageGenQueue；等待间隔→执行→完成计时）。 */
interface SharedImageQueue {
  enqueue: (task: () => Promise<string>, signal?: AbortSignal) => Promise<string>;
}

/** 取主项目共享闸门；取不到（测试桩/dev 探针页）返回 null 走本地直调。 */
export function sharedImageQueue(): SharedImageQueue | null {
  try {
    const w = hostWindow() as any;
    const q = w?.__ubImageGenQueue;
    return q && typeof q.enqueue === 'function' ? q : null;
  } catch (_e) {
    return null;
  }
}

/**
 * 第二步正式生图：优先经主项目共享闸门排队（多张图自动串行+与主项目生图互不并发），
 * 无桥环境回退本地 generateImage（自带同款闸门）。
 */
function runImageGeneration(
  provider: PortraitImageGen,
  promptText: string,
  negativePrompt: string,
  signal: AbortSignal | undefined,
  storyOpts: { multi: StoryMultiChar; prefix: string; suffix: string } | undefined,
  onRecord?: (record: ImageGenRecord) => void,
): Promise<string> {
  const shared = sharedImageQueue();
  if (shared) {
    return shared.enqueue(
      () => generateImageUngated(provider, promptText, negativePrompt, signal, storyOpts, onRecord),
      signal,
    );
  }
  return generateImage(provider, promptText, negativePrompt, signal, true, storyOpts, onRecord);
}

// ===== 生图模式/预设选择（配置本体只读自主项目） =====

/** 可选生图模式 id（'' = 未选择）。chatu8=智慧姬 / baibai=柏宝绘：生图整体转交酒馆里的对应插件执行
 *  （地址/密钥/模型/后端参数全用插件里配的那套；与主项目「生图接口」同款通道位，存储钉 'openai'+通道位=true）。 */
export type PhoneImageModeId = Exclude<PhoneImageMode, ''>;

export const IMAGE_MODES: Array<{ id: PhoneImageModeId; label: string }> = [
  { id: 'novelai', label: 'NovelAI' },
  { id: 'openai', label: 'OpenAI 兼容' },
  { id: 'comfyui', label: 'ComfyUI' },
  { id: 'chatu8', label: '智慧姬（st-chatu8）' },
  { id: 'baibai', label: '柏宝绘（ST-BaiBai-Image）' },
];

function modeLabel(id: string): string {
  return IMAGE_MODES.find(m => m.id === id)?.label ?? id;
}

/** 智慧姬模式就绪情况（null = 可用）：地址/密钥/模型都收在智慧姬插件里，主项目侧不校验 url/model
 *  （generateImageUngated 的 chatu8 分发先于校验），这里只确认插件设置在位。 */
export function chatu8ChannelMissing(): string | null {
  let settings: Record<string, any> | null = null;
  try {
    settings = getChatu8Settings();
  } catch (_e) {
    settings = null;
  }
  return settings ? null : '没找到智慧姬插件（st-chatu8），请先在酒馆里装好并配置';
}

/** 柏宝绘模式就绪情况（null = 可用）：只做只读探测——插件在不在（globalThis.STBaiBaiImage）、
 *  后端配没配齐（其公开 getBackendStatus 的 configured/reason，不带地址与 Key）。 */
export function baibaiChannelMissing(): string | null {
  try {
    if (!getBaiBaiApi()) return '没找到柏宝绘插件（ST-BaiBai-Image），请先在酒馆里装好';
    const status = baibaiBackendStatus();
    if (status && !status.configured) return '柏宝绘出图后端未配置：' + (status.reason || '请到其「渠道」页配好出图后端');
  } catch (_e) {
    return '没找到柏宝绘插件（ST-BaiBai-Image），请先在酒馆里装好';
  }
  return null;
}

/**
 * 主项目该模式是否已配置好；返回缺失项描述（null = 已配置）。
 * 判定对齐主项目 generateImage 自身校验：NAI 缺 key（url 有官方默认）、OpenAI 缺 url/model（key 可选）、ComfyUI 缺 url。
 * 智慧姬例外：不校验 url/model，只看插件设置在位。
 */
export function imageModeMissing(mode: string): string | null {
  let provider: PortraitImageGen | undefined;
  try {
    provider = getConfig().imageGeneration?.provider;
  } catch (_e) {
    return '主项目配置不可读';
  }
  if (!provider) return '主项目配置不可读';
  if (mode === 'chatu8') return chatu8ChannelMissing();
  if (mode === 'baibai') return baibaiChannelMissing();
  if (mode === 'novelai') return provider.novelai?.key ? null : '缺少 API Key';
  if (mode === 'openai') return provider.openai?.url && provider.openai?.model ? null : '缺少 URL 或模型名';
  if (mode === 'comfyui') return provider.comfyui?.url ? null : '缺少 URL';
  return null;
}

export function listHostImagePresets(): Array<{ id: string; name: string }> {
  try {
    return (getConfig().imageGeneration?.promptPresets || []).map(p => ({ id: p.id, name: p.name || p.id }));
  } catch (_e) {
    return [];
  }
}

export interface PhoneImageResolution {
  provider: PortraitImageGen | null;
  presetName: string;
  /** 未选择/未配置/预设被删的红字文案；null = 可用。 */
  error: string | null;
}

/**
 * 按小手机设置解析生图配置：模式/预设都显式选择后，浅拷贝覆盖任务档预设 id，
 * 仍走主项目 resolveImageTaskConfig 合并链（前后缀/负面词/各模式参数切片），最后钳制 apiFormat。
 * 五种模式并列：三类供应商（novelai/openai/comfyui）用主项目供应商配置；智慧姬（chatu8）/柏宝绘（baibai）转交插件执行。
 *
 * 只管手机自己的任务切片（portrait：聊天/社媒/相册/不夜城）。**网上商城的商品图不走这里**——
 * 它整条照搬主项目「衣柜单品」（文字 API + 生图 API 全跟随主项目，手机侧无覆盖项），见 core/shop-images。
 */
export function resolvePhoneImageConfig(): PhoneImageResolution {
  const s = getPhoneSettings();
  if (!s.imageMode) return { provider: null, presetName: '', error: '尚未选择生图模式，请到 小手机设置→生图 选择' };
  const missing = imageModeMissing(s.imageMode);
  if (missing) {
    return { provider: null, presetName: '', error: s.imageMode === 'chatu8'
      ? `智慧姬（st-chatu8）生图未就绪：${missing}`
      : s.imageMode === 'baibai'
        ? `柏宝绘（ST-BaiBai-Image）生图未就绪：${missing}`
        : `主项目「${modeLabel(s.imageMode)}」生图未配置（${missing}），请到主项目设置补全` };
  }
  let ig: ImageGenerationConfig;
  try {
    ig = getConfig().imageGeneration;
  } catch (_e) {
    return { provider: null, presetName: '', error: '主项目配置不可读' };
  }
  // 智慧姬/柏宝绘直连：不需要、也不允许选画风预设（预设的出图内容全部不生效，由插件接管）；
  // 提示词模式/输出语言/同人tag传输三项为全局设置（跟随主项目），前后缀/负面恒空（切片出口兜底）。
  if (s.imageMode === 'chatu8' || s.imageMode === 'baibai') {
    const base = resolveImageTaskConfig('portrait', ig).provider;
    const provider: PortraitImageGen = {
      ...base,
      apiFormat: 'openai',
      // 两条插件通道互斥：只钉自己选的那一位（主项目侧归一化同款互斥口径）
      openai: { ...base.openai, chatu8: s.imageMode === 'chatu8', baibai: s.imageMode === 'baibai' },
    };
    return { provider, presetName: '', error: null };
  }
  // 预设解析：手机设置必选（本函数只服务手机自己的 portrait 切片）
  if (!s.imagePresetId) return { provider: null, presetName: '', error: '尚未选择画风预设，请到 小手机设置→生图 选择' };
  const chosen = (ig.promptPresets || []).find(p => p.id === s.imagePresetId);
  if (!chosen) return { provider: null, presetName: '', error: '所选画风预设已被删除（主项目），请到 小手机设置→生图 重新选择' };
  const resolved = resolveImageTaskConfig('portrait', {
    ...ig,
    tasks: { ...ig.tasks, portrait: { ...ig.tasks.portrait, promptPresetId: chosen.id } },
  });
  // 三类供应商显式选择时钉自己的 apiFormat；**同时清掉从主项目配置继承来的两条插件通道位**——
  // 主项目开着智慧姬/柏宝绘时，不清位会让手机选的「OpenAI 兼容」悄悄被顶到插件通道（docs/62 §五-2 实测），
  // 与「两处各自显式选择、不做通道跟随」的口径相反。
  const provider: PortraitImageGen = {
    ...resolved.provider,
    apiFormat: s.imageMode as PortraitApiFormat,
    openai: { ...resolved.provider.openai, chatu8: false, baibai: false },
  };
  // NAI 仅支持标签模式（覆盖 apiFormat 后补一次主项目同款回落；提示词模式为全局设置）
  if (provider.apiFormat === 'novelai' && provider.promptComposeMode === 'natural') provider.promptComposeMode = 'tags';
  return { provider, presetName: chosen.name || chosen.id, error: null };
}

// ===== 两步法 =====

export interface PhoneImageJob {
  messageId: string;
  /** 图片的中文画面描述（消息 content / 相机输入）。 */
  description: string;
  /** 出镜角色（聊天=collectChatSubjects；相机=用户多选）。 */
  subjects: PhoneImageSubject[];
  /** 只读 roster 快照（资料块数据源）。 */
  roster: RosterSnapshot;
  /** 会话内最近聊天记录 / 主项目正文（空串则省略该块）。 */
  chatContext?: string;
  /** chatContext 块的标题标签（默认「最近聊天记录（旧→新）」；相机引用正文时传「最近正文进展」）。 */
  contextLabel?: string;
  /** 拍照地点（主项目地图存储；聊天图片不传）。 */
  location?: PhoneMapLocation | null;
  /** 上传文件名词干。 */
  stem: string;
  signal?: AbortSignal;
  /** 已固化提示词：非空 promptText 时跳过第一步直接生图（重新生图/失败重试）。 */
  fixed?: {
    promptText: string;
    negativePrompt: string;
    /** NAI 多角色结构 JSON（buildPromptStoryMulti 产物；多角色图重试时保持 char_captions 分角色）。 */
    multiJson?: string;
  };
  /** 第一步完成后、正式生图前回调（调用方固化写回消息；第二步失败也不丢第一步成果）。 */
  onPromptReady?: (promptText: string, negativePrompt: string, multiJson?: string) => void;
  /** 生图档案回传（generateImage onRecord；调用方存相册供重绘）。 */
  onRecord?: (record: ImageGenRecord) => void;
}

/** 固化回读的 multiJson 防御性解析（磁盘读回/旧数据容错；形状不对回退 null 走扁平）。 */
export function parseFixedMultiJson(raw?: string): StoryMultiChar | null {
  if (!raw || !raw.trim()) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.characters)) return null;
    const characters: StoryMultiChar['characters'] = [];
    for (const c of obj.characters) {
      const ch = c as Record<string, unknown>;
      const prompt = typeof ch.prompt === 'string' ? ch.prompt.trim() : '';
      const center = ch.centers as Record<string, unknown> | undefined;
      if (!prompt || !center || !Number.isFinite(Number(center.x)) || !Number.isFinite(Number(center.y))) continue;
      characters.push({
        prompt,
        uc: typeof ch.uc === 'string' ? ch.uc : '',
        centers: { x: Number(center.x), y: Number(center.y) },
      });
    }
    if (!characters.length) return null;
    return { scene: typeof obj.scene === 'string' ? obj.scene : '', characters };
  } catch (_e) {
    return null;
  }
}

interface PromptStepResult {
  promptText: string;
  negativePrompt: string;
  /** ≥2 个有效角色时的 NAI 多角色结构；单角色/解析不出为 null（走扁平）。 */
  multi: StoryMultiChar | null;
  promptPrefix: string;
  promptSuffix: string;
  /** story 形态（主项目文生图标签行结构）：解析出结构即走 char_captions（与正文插图一致，单人物也走）。 */
  storyStructured: boolean;
}

/** 生图提示词拼接预设前缀/后缀（与主项目正文插图 composeStoryPrompt 同源：修剪首尾逗号后逗号连接）。 */
function composePhoneStoryPrompt(prefix: string, body: string, suffix: string): string {
  return [prefix, body, suffix]
    .map((s) => String(s || '').trim().replace(/^,+/, '').replace(/,+$/, ''))
    .filter(Boolean)
    .join(', ');
}

/** 第一步：文字 AI 生成提示词（单人=立绘同人管线；≥2 人=主项目文生图标签行管线）。 */
async function generatePromptStep(provider: PortraitImageGen, job: PhoneImageJob): Promise<PromptStepResult> {
  const th = getTavernHelper();
  if (!th || typeof th.generateRaw !== 'function') throw new Error('无法访问酒馆助手 API（generateRaw）');
  const built = buildPhoneImagePrompt({
    subjects: job.subjects,
    description: job.description,
    chatContext: job.chatContext || '',
    contextLabel: job.contextLabel,
    location: job.location || null,
    roster: job.roster,
    composeMode: provider.promptComposeMode,
    naturalLanguage: provider.naturalPromptLanguage,
    // 用户自定义生图提示词（标准化提示词编辑模块 · 生图领域）；只覆盖写法规则，契约/示例固定不可改
    promptOverrides: getPhoneSettings().imagePrompts,
  });
  // 与立绘/正文插图同源：破限 system prompt + 主项目生图文字 API（imageGeneration scope）。
  // story 形态全部指令在 user_input 自足注入（对齐正文插图：system 仅破限），空 system 槽位跳过。
  const orderedPrompts: Array<{ role: 'system' | 'user' | 'assistant'; content: string } | 'user_input'> = [
    ...getJailbreakHeadPrompts(),
  ];
  if (built.system.trim()) orderedPrompts.push({ role: 'system', content: built.system });
  orderedPrompts.push('user_input', ...getJailbreakTailPrompts());
  let result: string;
  try {
    const r = await withPhoneTextAiRetry('image', () => th.generateRaw({
      should_silence: true,
      user_input: built.userInput,
      ordered_prompts: orderedPrompts,
      custom_api: resolvePhoneApi('image').api,
    }));
    result = typeof r === 'string' ? r : '';
  } catch (e) {
    throw new Error(`生成提示词失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!result.trim()) throw new Error('生成提示词失败：AI 返回空');
  // 前后缀走统一切片出口（含智慧姬抑制：直连时不拼预设前后缀——由智慧姬接管）
  const slice = resolvePromptPresetSlice(provider);
  const promptPrefix = slice.prefix;
  const promptSuffix = slice.suffix;

  // ── story 形态（≥2 人）：主项目正文插图同款解析（<UBS_image> 块 → 标签行 → 多角色结构）──
  if (built.format === 'story') {
    const blocks = parseStoryImageBlocks(result, 1);
    if (!blocks.length) throw new Error('AI 未输出有效的 <UBS_image> 插图块');
    const body = blocks[0].promptText;
    if (!body.trim()) throw new Error('AI 输出的插图块提示词为空');
    return {
      promptText: composePhoneStoryPrompt(promptPrefix, body, promptSuffix),
      negativePrompt: providerNegative(provider),
      multi: parseMultiCharPrompt(body),
      promptPrefix,
      promptSuffix,
      storyStructured: true,
    };
  }

  // ── portrait 形态（单人）：立绘同源解析与拍平（同人身份 tag 固化后直接拼入）──
  const obj = parsePromptOutput(result);
  if (!obj) throw new Error('AI 输出格式异常，无法解析为图像提示词');
  const promptText = assembleFinalPrompt(
    promptPrefix,
    buildPromptTextByMode(obj, provider.promptComposeMode, built.fanTags, provider.naturalPromptLanguage, provider.fanTagTransferMode),
    promptSuffix,
    provider.promptComposeMode,
  );
  if (!promptText.trim()) throw new Error('组装出的提示词为空');
  // 多角色结构只在 tags 模式下有意义（NAI 强制 tags；natural 的 traits 是散文拍不出角色槽）；
  // 同人身份 tag 缺失时该角色已按普通资料块出（不再抛识别错误，与资料块组装同门槛）
  let multi: StoryMultiChar | null = null;
  if (provider.promptComposeMode === 'tags') {
    multi = buildPromptStoryMulti(obj, built.fanTags, provider.fanTagTransferMode);
  }
  return { promptText, negativePrompt: providerNegative(provider), multi, promptPrefix, promptSuffix, storyStructured: false };
}

/**
 * 生成一张聊天图片并上传，返回 /user/images/… 路径。
 * 两步法：无固化提示词时先走文字 AI 生成提示词（经 onPromptReady 固化），再正式生图。
 * 失败原因记入 _imageErrors 供 failed 占位展示。
 */
export async function generatePhoneImage(job: PhoneImageJob): Promise<string> {
  return enqueue(async () => {
    try {
      const resolution = resolvePhoneImageConfig();
      if (resolution.error || !resolution.provider) throw new Error(resolution.error || '生图配置不可用');
      const provider = resolution.provider;
      let promptText: string;
      let negativePrompt: string;
      let multi: StoryMultiChar | null = null;
      let promptPrefix = '';
      let promptSuffix = '';
      let storyStructured = false;
      if (job.fixed && job.fixed.promptText.trim()) {
        // 已固化：直接用提示词生图（换一张/重试），不再调文字 AI
        promptText = job.fixed.promptText;
        negativePrompt = job.fixed.negativePrompt || '';
        const fixedMulti = parseFixedMultiJson(job.fixed.multiJson);
        multi = fixedMulti;
        if (!fixedMulti) {
          // story 格式固化提示词自愈：朋友圈/社媒批量路径不存 multiJson，按标签行结构重解析
          // 恢复 NAI 分角色；portrait 扁平提示词不匹配标签行结构返回 null，行为不变
          multi = parseMultiCharPrompt(job.fixed.promptText);
          storyStructured = !!multi;
        }
        // 前后缀走统一切片出口（含智慧姬抑制：直连时不拼预设前后缀）
        const fixedSlice = resolvePromptPresetSlice(provider);
        promptPrefix = fixedSlice.prefix;
        promptSuffix = fixedSlice.suffix;
      } else {
        if (!job.description.trim()) throw new Error('图片描述为空');
        const generated = await generatePromptStep(provider, job);
        promptText = generated.promptText;
        negativePrompt = generated.negativePrompt;
        multi = generated.multi;
        promptPrefix = generated.promptPrefix;
        promptSuffix = generated.promptSuffix;
        storyStructured = generated.storyStructured;
        if (job.onPromptReady) {
          try {
            job.onPromptReady(promptText, negativePrompt, multi ? JSON.stringify(multi) : undefined);
          } catch (_e) { /* 固化失败不阻断生图 */ }
        }
      }
      // NAI 多角色：story 形态解析出结构即走 char_captions/centers/use_coords（与正文插图一致，
      // 单人物也走；OpenAI/ComfyUI 由 generateImage 内部 flattenStoryMulti 扁平化）；portrait 形态
      // 维持 ≥2 有效角色门槛（扁平 promptText 对 NAI 多角色请求不生效，仅作 OpenAI/ComfyUI 载体）
      const storyOpts = multi && (storyStructured || (provider.apiFormat === 'novelai' && multi.characters.length >= 2))
        ? { multi, prefix: promptPrefix, suffix: promptSuffix }
        : undefined;
      const dataUrl = await runImageGeneration(provider, promptText, negativePrompt, job.signal, storyOpts, job.onRecord);
      const result = await uploadGeneratedImage(dataUrl, 'phone', job.stem);
      if (!result.path) throw new Error(result.error || '图片上传失败');
      _imageErrors.delete(job.messageId);
      return result.path;
    } catch (e) {
      _imageErrors.set(job.messageId, e instanceof Error ? e.message : String(e));
      // FIFO 上限：超过即淘汰最旧一条（Map 迭代序=插入序；重复 set 同 key 不会增长）
      if (_imageErrors.size > IMAGE_ERROR_MAX) {
        const oldest = _imageErrors.keys().next().value;
        if (oldest !== undefined) _imageErrors.delete(oldest);
      }
      throw e;
    }
  });
}

/** 图片删除（只允许删本插件目录下的 phone_ 前缀文件）。 */
export async function deletePhoneImage(path: string): Promise<void> {
  if (!/\/phone_[A-Za-z0-9_.@-]+\.(png|jpg|jpeg|webp)$/i.test(path)) {
    phoneNotify('拒绝删除非小手机图片', '小手机', 'warning');
    return;
  }
  try {
    await deleteStoredImage(path);
  } catch (_e) { /* best effort */ }
}

// ===== 批量第一步：一次 AI 请求为多张社媒配图出提示词（主项目正文插图同款 <UBS_image> 多块结构） =====

export interface PhoneBatchPromptTask {
  id: string;
  description: string;
  /** 该图涉及出镜角色名（任务行写明；档案块由调用方按并集注入）。 */
  characters: string[];
}

export interface PhoneBatchPromptResult {
  promptText: string;
  negativePrompt: string;
  /** 标签行结构解析结果（含逐角色 UC 与 centers；纯景物照为 null 走扁平）。 */
  multi: StoryMultiChar | null;
}

/**
 * 批量第一步：一次 generateRaw 为多张社媒配图生成提示词（主项目文生图多块契约，position 行=任务 id）。
 * 返回 id → 提示词结果；个别图块缺失/解析失败时该 id 不在 Map 中（调用方按失败处理，不整体抛错）。
 */
export async function generatePhoneBatchPrompts(
  provider: PortraitImageGen,
  args: {
    tasks: PhoneBatchPromptTask[];
    subjects: PhoneImageSubject[];
    roster: RosterSnapshot;
    /** 自定义文字 API（不夜城「生图 API 单独配置」经 resolveNightImageApi 传入；缺省=共用「生图（提示词）」scope）。 */
    api?: CustomApiConfig;
  },
): Promise<Map<string, PhoneBatchPromptResult>> {
  const th = getTavernHelper();
  if (!th || typeof th.generateRaw !== 'function') throw new Error('无法访问酒馆助手 API（generateRaw）');
  const built = buildPhoneImagePromptBatch({
    tasks: args.tasks,
    subjects: args.subjects,
    roster: args.roster,
    composeMode: provider.promptComposeMode,
    naturalLanguage: provider.naturalPromptLanguage,
    // 用户自定义生图提示词（同单图路径；批量与不夜城/社媒配图共用本入口）
    promptOverrides: getPhoneSettings().imagePrompts,
  });
  // story 契约全部指令在 user_input（system 仅破限，built.system 恒空）；防空槽位与单图路径同款跳过
  const orderedPrompts: Array<{ role: 'system' | 'user' | 'assistant'; content: string } | 'user_input'> = [
    ...getJailbreakHeadPrompts(),
  ];
  if (built.system.trim()) orderedPrompts.push({ role: 'system', content: built.system });
  orderedPrompts.push('user_input', ...getJailbreakTailPrompts());
  let result: string;
  try {
    const r = await withPhoneTextAiRetry('image', () => th.generateRaw({
      should_silence: true,
      user_input: built.userInput,
      ordered_prompts: orderedPrompts,
      custom_api: args.api ?? resolvePhoneApi('image').api,
    }));
    result = typeof r === 'string' ? r : '';
  } catch (e) {
    throw new Error(`生成提示词失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!result.trim()) throw new Error('生成提示词失败：AI 返回空');
  // 主项目文生图同款解析：position 行=任务 id；AI 漏写/写错 id 的块按剩余顺序回填（不整体抛错）
  const blocks = parseStoryImageBlocks(result, args.tasks.length);
  // 前后缀走统一切片出口（含智慧姬抑制）
  const batchSlice = resolvePromptPresetSlice(provider);
  const promptPrefix = batchSlice.prefix;
  const promptSuffix = batchSlice.suffix;
  const out = new Map<string, PhoneBatchPromptResult>();
  const remaining: StoryImageBlock[] = [...blocks];
  const exactById = new Map<string, StoryImageBlock>();
  for (const t of args.tasks) {
    const idx = remaining.findIndex(b => b.positionQuote === t.id);
    if (idx >= 0) {
      exactById.set(t.id, remaining[idx]);
      remaining.splice(idx, 1);
    }
  }
  for (const t of args.tasks) {
    const block = exactById.get(t.id) ?? remaining.shift();
    if (!block || !block.promptText.trim()) continue; // 该图缺块/空提示词 → 调用方落 failed
    out.set(t.id, {
      promptText: composePhoneStoryPrompt(promptPrefix, block.promptText, promptSuffix),
      negativePrompt: providerNegative(provider),
      multi: parseMultiCharPrompt(block.promptText),
    });
  }
  return out;
}
