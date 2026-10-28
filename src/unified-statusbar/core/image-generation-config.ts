import {
  DEFAULT_PROMPT_PRESET_ID,
  buildPresetComfyUiParamsFrom,
  buildPresetNovelAiParamsFrom,
  buildPresetOpenAiParamsFrom,
  getDefaultPortraitImageGen,
  normalizePortraitImageGen,
  normalizePromptPresets,
  resolveActivePreset,
  resolvePresetComfyUiParams,
  resolvePresetNovelAiParams,
  resolvePresetOpenAiParams,
  type PortraitImageGen,
  type PortraitPromptPreset,
  type PresetParamsBackfill,
} from './portrait-config';
import { isChatu8Channel } from './chatu8-bridge';
import { isBaiBaiChannel } from './baibai-bridge';
import { normalizeImagePromptTemplates } from './image-prompt-templates';

export type ImageTaskType = 'portrait' | 'wardrobeItem' | 'wardrobeOutfit' | 'mapScene' | 'itemOverview' | 'storyImage';

export interface ImageTaskConfig {
  promptPresetId: string;
  width: number;
  height: number;
  aspectRatio: string;
}

export interface ResolvedImageTaskConfig extends ImageTaskConfig {
  provider: PortraitImageGen;
}

export interface ImageGenerationConfig {
  provider: PortraitImageGen;
  intervalSeconds: number;
  imagePromptApiPresetId: string;
  promptPresets: PortraitPromptPreset[];
  /** 生图 AI 请求提示词模板覆盖表（键 `image:<场景>:<槽位>`，见 core/image-prompt-templates）。
   *  与预设解耦：智慧姬直连下照常生效；空表 = 全部用内置默认（禁物化）。 */
  promptTemplates: Record<string, string>;
  tasks: Record<ImageTaskType, ImageTaskConfig>;
}

export interface LegacyImageGenerationConfig {
  portraitImageGen?: unknown;
  portraitApiPresetId?: unknown;
  imageGenerationIntervalSeconds?: unknown;
  wardrobeGenerationIntervalSeconds?: unknown;
}

const DEFAULT_INTERVAL_SECONDS = 45;

function clonePromptPresets(presets: PortraitPromptPreset[]): PortraitPromptPreset[] {
  return presets.map(preset => ({ ...preset }));
}

function normalizeIntervalSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_INTERVAL_SECONDS;
  return Math.max(0, Math.min(120, Math.floor(value)));
}

function normalizeDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeTaskConfig(input: unknown, fallback: ImageTaskConfig): ImageTaskConfig {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    promptPresetId: typeof value.promptPresetId === 'string' && value.promptPresetId
      ? value.promptPresetId
      : fallback.promptPresetId,
    width: normalizeDimension(value.width, fallback.width),
    height: normalizeDimension(value.height, fallback.height),
    aspectRatio: typeof value.aspectRatio === 'string' && value.aspectRatio
      ? value.aspectRatio
      : fallback.aspectRatio,
  };
}

export function getDefaultImageGenerationConfig(): ImageGenerationConfig {
  const provider = getDefaultPortraitImageGen();
  return {
    provider,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    imagePromptApiPresetId: '',
    promptPresets: clonePromptPresets(provider.novelai.promptPresets),
    promptTemplates: {},
    tasks: {
      portrait: { promptPresetId: DEFAULT_PROMPT_PRESET_ID, width: 1024, height: 1024, aspectRatio: 'auto' },
      wardrobeItem: { promptPresetId: DEFAULT_PROMPT_PRESET_ID, width: 1024, height: 1024, aspectRatio: '1:1' },
      wardrobeOutfit: { promptPresetId: DEFAULT_PROMPT_PRESET_ID, width: 832, height: 1216, aspectRatio: '2:3' },
      mapScene: { promptPresetId: DEFAULT_PROMPT_PRESET_ID, width: 1216, height: 832, aspectRatio: '3:2' },
      itemOverview: { promptPresetId: DEFAULT_PROMPT_PRESET_ID, width: 1216, height: 832, aspectRatio: '3:2' },
      storyImage: { promptPresetId: DEFAULT_PROMPT_PRESET_ID, width: 1024, height: 1024, aspectRatio: '1:1' },
    },
  };
}

function normalizeNewImageGenerationConfig(input: unknown): ImageGenerationConfig {
  const defaults = getDefaultImageGenerationConfig();
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const provider = normalizePortraitImageGen(value.provider);
  const backfill: PresetParamsBackfill = {
    novelai: buildPresetNovelAiParamsFrom(provider.novelai),
    openai: buildPresetOpenAiParamsFrom(provider.openai),
    comfyui: buildPresetComfyUiParamsFrom(provider.comfyui),
  };
  const promptPresets = normalizePromptPresets(value.promptPresets, provider.novelai.promptPresets, backfill);
  const tasks = value.tasks && typeof value.tasks === 'object' ? value.tasks as Record<string, unknown> : {};

  return {
    provider,
    intervalSeconds: normalizeIntervalSeconds(value.intervalSeconds),
    imagePromptApiPresetId: typeof value.imagePromptApiPresetId === 'string' ? value.imagePromptApiPresetId : '',
    promptPresets,
    promptTemplates: normalizeImagePromptTemplates(value.promptTemplates),
    tasks: {
      portrait: normalizeTaskConfig(tasks.portrait, defaults.tasks.portrait),
      wardrobeItem: normalizeTaskConfig(tasks.wardrobeItem, defaults.tasks.wardrobeItem),
      wardrobeOutfit: normalizeTaskConfig(tasks.wardrobeOutfit, defaults.tasks.wardrobeOutfit),
      mapScene: normalizeTaskConfig(tasks.mapScene, defaults.tasks.mapScene),
      itemOverview: normalizeTaskConfig(tasks.itemOverview, defaults.tasks.itemOverview),
      storyImage: normalizeTaskConfig(tasks.storyImage, defaults.tasks.storyImage),
    },
  };
}

function migrateLegacyImageGenerationConfig(legacy: LegacyImageGenerationConfig | undefined): ImageGenerationConfig {
  const defaults = getDefaultImageGenerationConfig();
  const legacyInterval = legacy?.imageGenerationIntervalSeconds === undefined
    ? legacy?.wardrobeGenerationIntervalSeconds
    : legacy.imageGenerationIntervalSeconds;
  const provider = normalizePortraitImageGen(legacy?.portraitImageGen);
  const backfill: PresetParamsBackfill = {
    novelai: buildPresetNovelAiParamsFrom(provider.novelai),
    openai: buildPresetOpenAiParamsFrom(provider.openai),
    comfyui: buildPresetComfyUiParamsFrom(provider.comfyui),
  };

  return {
    ...defaults,
    provider,
    intervalSeconds: normalizeIntervalSeconds(legacyInterval),
    imagePromptApiPresetId: typeof legacy?.portraitApiPresetId === 'string' ? legacy.portraitApiPresetId : '',
    promptPresets: normalizePromptPresets(clonePromptPresets(provider.novelai.promptPresets), provider.novelai.promptPresets, backfill),
  };
}

export function normalizeImageGenerationConfig(
  imageGeneration: unknown,
  legacy?: LegacyImageGenerationConfig,
): ImageGenerationConfig {
  return imageGeneration === undefined
    ? migrateLegacyImageGenerationConfig(legacy)
    : normalizeNewImageGenerationConfig(imageGeneration);
}

export function resolveImageTaskConfig(task: ImageTaskType, config: ImageGenerationConfig): ResolvedImageTaskConfig {
  const taskConfig = config.tasks[task];
  const promptPreset = resolveActivePreset(config.promptPresets, taskConfig.promptPresetId);
  const provider = config.provider;
  // 提示词模式 / 自然语言输出语言 / 同人tag加权写法：全局设置（原属预设，已提升）——
  // 智慧姬直连下同样生效（它们决定发给文字 AI 的请求形态，与出图通道无关）。
  // NAI 仅支持标签模式：运行时回落（供应商能力限制，非对齐）。
  const promptComposeMode = provider.apiFormat === 'novelai' && provider.promptComposeMode === 'natural'
    ? 'tags'
    : provider.promptComposeMode;
  const naturalPromptLanguage = provider.naturalPromptLanguage;
  const fanTagTransferMode = provider.fanTagTransferMode === 'anima' ? 'anima' : 'novelai';

  return {
    ...taskConfig,
    provider: {
      ...provider,
      promptComposeMode,
      naturalPromptLanguage,
      fanTagTransferMode,
      novelai: {
        ...provider.novelai,
        ...resolvePresetNovelAiParams(promptPreset, provider.novelai),
        promptPrefix: promptPreset.promptPrefix,
        promptSuffix: promptPreset.promptSuffix,
        negativePrompt: promptPreset.negativePrompt,
        // 默认负面质量词开关属于预设（旧预设缺字段视为开）；仅 NovelAI 请求体消费
        useDefaultNegative: promptPreset.useDefaultNegative !== false,
        promptPresets: clonePromptPresets(config.promptPresets),
        activePromptPresetId: promptPreset.id,
        width: taskConfig.width,
        height: taskConfig.height,
      },
      openai: {
        ...provider.openai,
        ...resolvePresetOpenAiParams(promptPreset, provider.openai),
        promptPrefix: promptPreset.promptPrefix,
        promptSuffix: promptPreset.promptSuffix,
        aspectRatio: taskConfig.aspectRatio,
      },
      comfyui: {
        ...provider.comfyui,
        ...resolvePresetComfyUiParams(promptPreset, provider.comfyui),
        promptPrefix: promptPreset.promptPrefix,
        promptSuffix: promptPreset.promptSuffix,
        negativePrompt: promptPreset.negativePrompt,
        width: taskConfig.width,
        height: taskConfig.height,
      },
    },
  };
}

/**
 * 预设出图内容切片（正向前缀 / 正向后缀 / 负面词）——**含智慧姬/柏宝绘抑制**。
 * 外部生图通道直连时：前端不再拼前后缀、不发送预设负面（全部返回空串）——出图由插件按其自身预设处理
 *（智慧姬拼它的固定词/质量预设，柏宝绘拼它的画师串/质量词）；切回内置直连即恢复（配置本体不动，仅此出口抑制）。
 * 任务专属负面词（地图无人 / 衣柜品类 / 物品总览防 UI 化）与 AI 返回的负面词不属于预设内容，各任务自行合并保留
 *（柏宝绘只在 ComfyUI 后端消费动态负面，NAI 后端忽略——与智慧姬负面透传同构）。
 */
export function resolvePromptPresetSlice(provider: PortraitImageGen): { prefix: string; suffix: string; negative: string } {
  if (isChatu8Channel(provider) || isBaiBaiChannel(provider)) return { prefix: '', suffix: '', negative: '' };
  const sub: { promptPrefix?: string; promptSuffix?: string; negativePrompt?: string } = provider.apiFormat === 'openai'
    ? provider.openai
    : provider.apiFormat === 'comfyui'
      ? provider.comfyui
      : provider.novelai;
  return {
    prefix: String(sub.promptPrefix || ''),
    suffix: String(sub.promptSuffix || ''),
    negative: String(sub.negativePrompt || ''),
  };
}
