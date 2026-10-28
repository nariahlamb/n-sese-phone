// —— 枚举常量（1:1 复刻 phone-ctn_src）——
import { STANDARD_EMOTIONS } from './constants';
import { clampFloat, toIntLoose } from './number';
import type { PortraitTheme } from './portrait-prompts';
import type { PortraitPreset } from './portrait-system';

export const NOVELAI_MODELS = [
  { id: 'nai-diffusion-5-full', name: 'NAI Diffusion V5 Full (最新)' },
  { id: 'nai-diffusion-5-curated', name: 'NAI Diffusion V5 Curated' },
  { id: 'nai-diffusion-4-5-full', name: 'NAI Diffusion V4.5 Full' },
  { id: 'nai-diffusion-4-5-curated', name: 'NAI Diffusion V4.5 Curated' },
  { id: 'nai-diffusion-4-curated-preview', name: 'NAI Diffusion V4 Curated' },
  { id: 'nai-diffusion-4-full', name: 'NAI Diffusion V4 Full' },
  { id: 'nai-diffusion-3', name: 'NAI Diffusion V3' },
  { id: 'nai-diffusion-furry-3', name: 'NAI Diffusion Furry V3' },
  { id: 'safe-diffusion', name: 'Safe Diffusion' },
  { id: 'furry-3', name: 'Furry V3' },
];

export const NOVELAI_SAMPLERS = [
  { id: 'k_euler', name: 'Euler' },
  { id: 'k_euler_ancestral', name: 'Euler a' },
  { id: 'k_dpmpp_2m', name: 'DPM++ 2M' },
  { id: 'k_dpmpp_2m_ancestral', name: 'DPM++ 2M a' },
  { id: 'k_dpmpp_sde', name: 'DPM++ SDE' },
  { id: 'ddim', name: 'DDIM' },
  { id: 'k_dpmpp_2s_ancestral', name: 'DPM++ 2S a' },
  { id: 'k_dpmpp_2m_sde', name: 'DPM++ 2M SDE' },
  { id: 'ddim_v3', name: 'DDIM V3' },
];

// 官方枚举仅 4 个（novelai.net webapp bundle 核实）；无 "normal"（那是 A1111 命名）
export const NOVELAI_SCHEDULERS = [
  { id: 'native', name: 'Native（NAI 4/4.5 推荐）' },
  { id: 'karras', name: 'Karras' },
  { id: 'exponential', name: 'Exponential' },
  { id: 'polyexponential', name: 'Polyexponential' },
];

export const ASPECT_RATIO_OPTIONS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export const UC_PRESET_OPTIONS = [0, 1, 2, 3];

export const RESOLUTION_PRESETS = [
  { id: 'normal', label: 'NORMAL', items: [
    { w: 832, h: 1216, label: 'Portrait (832x1216)' },
    { w: 1216, h: 832, label: 'Landscape (1216x832)' },
    { w: 1024, h: 1024, label: 'Square (1024x1024)' },
  ] },
  { id: 'small', label: 'SMALL', items: [
    { w: 512, h: 768, label: 'Portrait (512x768)' },
    { w: 768, h: 512, label: 'Landscape (768x512)' },
    { w: 640, h: 640, label: 'Square (640x640)' },
  ] },
  { id: 'large', label: 'LARGE（消耗额外点数）', items: [
    { w: 1024, h: 1536, label: 'Portrait (1024x1536)' },
    { w: 1536, h: 1024, label: 'Landscape (1536x1024)' },
    { w: 1472, h: 1472, label: 'Square (1472x1472)' },
  ] },
  { id: 'wallpaper', label: 'WALLPAPER（消耗额外点数）', items: [
    { w: 1088, h: 1920, label: 'Portrait (1088x1920)' },
    { w: 1920, h: 1088, label: 'Landscape (1920x1088)' },
  ] },
];

// —— 提示词串预设（仅 NovelAI）——
// 把 正向前缀/后缀 + 全局负面词 打包为命名预设，切换即写入 live 三字段。
export const DEFAULT_PROMPT_PRESET_ID = 'default';

export interface PortraitPromptPreset {
  id: string;
  name: string;
  promptPrefix: string;
  promptSuffix: string;
  negativePrompt: string;
  isDefault?: boolean;
  /** 是否在本预设负面词之前前置系统固化默认负面提示词（UCP 质量词）；默认开（缺失/非 false 均视为开）。仅 NovelAI 生效 */
  useDefaultNegative?: boolean;
  // 提示词模式 / 自然语言输出语言 / 同人tag传输模式：已提升为全局（PortraitImageGen 字段），预设内旧值不再被消费。
  /** @deprecated 旧版「立绘生图提示词格式规范」：运行时不再消费（能力已迁至「生图 AI 请求提示词」板块
   *  image:portrait:tags）。仅为旧数据迁移提示保留原文；迁移后由 UI 清空。 */
  portraitFormatPrompt?: string;
  /** NovelAI 高级参数切片（13 项，含 model）；旧数据缺失由归一化回填当前全局值 */
  novelai?: PresetNovelAiParams;
  /** OpenAI 兼容生成参数切片（含 model）；旧数据缺失由归一化回填当前全局值 */
  openai?: PresetOpenAiParams;
  /** ComfyUI 生成参数切片（9 项）；旧数据缺失由归一化回填当前全局值 */
  comfyui?: PresetComfyUiParams;
}

export const DEFAULT_NEGATIVE_PROMPT = 'bad anatomy, bad hands, missing fingers, extra digit, fewer digits, bad feet, cropped, signature, username';

export function getDefaultPromptPresets(negativePrompt: string = DEFAULT_NEGATIVE_PROMPT): PortraitPromptPreset[] {
  return [{ id: DEFAULT_PROMPT_PRESET_ID, name: '默认', promptPrefix: '', promptSuffix: '', negativePrompt, isDefault: true, useDefaultNegative: true }];
}

export interface PresetParamsBackfill {
  novelai?: PresetNovelAiParams;
  openai?: PresetOpenAiParams;
  comfyui?: PresetComfyUiParams;
}

export function normalizePromptPresets(
  input: unknown,
  fallback: PortraitPromptPreset[],
  backfill?: PresetParamsBackfill,
): PortraitPromptPreset[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [...fallback].map(p => ({
      ...p,
      ...(backfill?.novelai && !p.novelai ? { novelai: backfill.novelai } : {}),
      ...(backfill?.openai && !p.openai ? { openai: backfill.openai } : {}),
      ...(backfill?.comfyui && !p.comfyui ? { comfyui: backfill.comfyui } : {}),
    }));
  }
  const seen = new Set<string>();
  const out: PortraitPromptPreset[] = [];
  const push = (
    id: string, name: string, prefix: string, suffix: string, neg: string,
    isDefault: boolean, raw?: Record<string, unknown>,
  ) => {
    if (seen.has(id)) return;
    seen.add(id);
    const isDef = isDefault || id === DEFAULT_PROMPT_PRESET_ID;
    const preset: PortraitPromptPreset = {
      id, name, promptPrefix: prefix, promptSuffix: suffix, negativePrompt: neg,
      // 缺失即开（旧数据回填）：只有显式 false 才关闭默认负面质量词
      useDefaultNegative: raw?.useDefaultNegative !== false,
      ...(isDef ? { isDefault: true } : {}),
    };
    if (raw?.novelai !== undefined) {
      preset.novelai = normalizePresetNovelAiParams(raw.novelai, backfill?.novelai ?? buildPresetNovelAiParamsFrom(getDefaultNovelAiConfig()));
    } else if (backfill?.novelai) {
      preset.novelai = backfill.novelai;
    }
    if (raw?.openai !== undefined) {
      preset.openai = normalizePresetOpenAiParams(raw.openai, backfill?.openai ?? buildPresetOpenAiParamsFrom(getDefaultOpenAiConfig()));
    } else if (backfill?.openai) {
      preset.openai = backfill.openai;
    }
    if (raw?.comfyui !== undefined) {
      preset.comfyui = normalizePresetComfyUiParams(raw.comfyui, backfill?.comfyui ?? buildPresetComfyUiParamsFrom(getDefaultComfyUiConfig()));
    } else if (backfill?.comfyui) {
      preset.comfyui = backfill.comfyui;
    }
    // 旧版预设内的 promptComposeMode / naturalPromptLanguage / fanTagTransferMode 一律忽略（已提升为全局）。
    // 格式规范仅保留原文供 UI 迁移提示（运行时不再消费）。
    if (typeof raw?.portraitFormatPrompt === 'string' && raw.portraitFormatPrompt.trim()) {
      preset.portraitFormatPrompt = raw.portraitFormatPrompt;
    }
    out.push(preset);
  };
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const id = typeof c.id === 'string' && c.id ? c.id : '';
    if (!id) continue;
    push(
      id,
      normalizeStr(c.name, '未命名预设'),
      normalizeStr(c.promptPrefix, ''),
      normalizeStr(c.promptSuffix, ''),
      normalizeStr(c.negativePrompt, ''),
      c.isDefault === true,
      c,
    );
  }
  if (!seen.has(DEFAULT_PROMPT_PRESET_ID)) {
    const d = (fallback.find(p => p.isDefault) || fallback[0]) || getDefaultPromptPresets()[0];
    const defId = DEFAULT_PROMPT_PRESET_ID;
    push(defId, d.name, d.promptPrefix, d.promptSuffix, d.negativePrompt, true);
  }
  return out;
}

export function resolveActivePreset(presets: PortraitPromptPreset[], activeId: unknown): PortraitPromptPreset {
  if (typeof activeId === 'string') {
    const hit = presets.find(p => p.id === activeId);
    if (hit) return hit;
  }
  return presets.find(p => p.isDefault) || presets[0] || getDefaultPromptPresets()[0];
}

export function nextPresetId(presets: PortraitPromptPreset[]): string {
  let n = 1;
  while (presets.some(p => p.id === 'preset-' + n)) n++;
  return 'preset-' + n;
}

// —— 预设高级参数切片（NovelAI 13 项 / OpenAI 1 项 / ComfyUI 9 项）——
export interface PresetNovelAiParams {
  /** 生图模型（naid 枚举 id）；模型属于预设，切换预设即切换模型 */
  model: string; sampler: string; scheduler: string; steps: number; cfg: number;
  ucPreset: number; qualityToggle: boolean; autoSmea: boolean; decrisper: boolean;
  sm: boolean; smDyn: boolean; cfgRescale: number; seed: number;
}
export interface PresetOpenAiParams {
  model: string;
}
export interface PresetComfyUiParams {
  model: string; sampler: string; scheduler: string; vae: string; clip: string;
  lora: string; steps: number; cfg: number; seed: number;
}

export function buildPresetNovelAiParamsFrom(source: NovelAiConfig): PresetNovelAiParams {
  return {
    model: source.model, sampler: source.sampler, scheduler: source.scheduler, steps: source.steps, cfg: source.cfg,
    ucPreset: source.ucPreset, qualityToggle: source.qualityToggle, autoSmea: source.autoSmea,
    decrisper: source.decrisper, sm: source.sm, smDyn: source.smDyn,
    cfgRescale: source.cfgRescale, seed: source.seed,
  };
}

export function buildPresetOpenAiParamsFrom(source: OpenAiConfig): PresetOpenAiParams {
  return { model: source.model };
}

export function buildPresetComfyUiParamsFrom(source: ComfyUiConfig): PresetComfyUiParams {
  return {
    model: source.model, sampler: source.sampler, scheduler: source.scheduler,
    vae: source.vae, clip: source.clip, lora: source.lora,
    steps: source.steps, cfg: source.cfg, seed: source.seed,
  };
}

export function normalizePresetNovelAiParams(input: unknown, fallback: PresetNovelAiParams): PresetNovelAiParams {
  const c = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  return {
    model: normalizeStr(c.model, fallback.model),
    sampler: normalizeStr(c.sampler, fallback.sampler),
    scheduler: normalizeStr(c.scheduler, fallback.scheduler),
    steps: toInt(clampNum(c.steps, fallback.steps, 1, 60), fallback.steps),
    cfg: clampNum(c.cfg, fallback.cfg, 0, 30),
    ucPreset: toInt(clampNum(c.ucPreset, fallback.ucPreset, 0, 3), fallback.ucPreset),
    qualityToggle: normalizeBool(c.qualityToggle, fallback.qualityToggle),
    autoSmea: normalizeBool(c.autoSmea, fallback.autoSmea),
    decrisper: normalizeBool(c.decrisper, fallback.decrisper),
    sm: normalizeBool(c.sm, fallback.sm),
    smDyn: normalizeBool(c.smDyn, fallback.smDyn),
    cfgRescale: clampNum(c.cfgRescale, fallback.cfgRescale, 0, 1),
    seed: normalizeSeed(c.seed),
  };
}

export function normalizePresetOpenAiParams(input: unknown, fallback: PresetOpenAiParams): PresetOpenAiParams {
  const c = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  return { model: normalizeStr(c.model, fallback.model) };
}

export function normalizePresetComfyUiParams(input: unknown, fallback: PresetComfyUiParams): PresetComfyUiParams {
  const c = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  return {
    model: normalizeStr(c.model, fallback.model),
    sampler: normalizeStr(c.sampler, fallback.sampler),
    scheduler: normalizeStr(c.scheduler, fallback.scheduler),
    vae: normalizeStr(c.vae, fallback.vae),
    clip: normalizeStr(c.clip, fallback.clip),
    lora: normalizeStr(c.lora, fallback.lora),
    steps: toInt(clampNum(c.steps, fallback.steps, 1, 150), fallback.steps),
    cfg: clampNum(c.cfg, fallback.cfg, 0, 50),
    seed: normalizeSeed(c.seed),
  };
}

export function resolvePresetNovelAiParams(preset: PortraitPromptPreset | null | undefined, provider: NovelAiConfig): PresetNovelAiParams {
  return preset?.novelai ?? buildPresetNovelAiParamsFrom(provider);
}

export function resolvePresetOpenAiParams(preset: PortraitPromptPreset | null | undefined, provider: OpenAiConfig): PresetOpenAiParams {
  return preset?.openai ?? buildPresetOpenAiParamsFrom(provider);
}

export function resolvePresetComfyUiParams(preset: PortraitPromptPreset | null | undefined, provider: ComfyUiConfig): PresetComfyUiParams {
  return preset?.comfyui ?? buildPresetComfyUiParamsFrom(provider);
}

export function applyPresetToConfig(config: NovelAiConfig, preset: PortraitPromptPreset): void {
  config.promptPrefix = preset.promptPrefix;
  config.promptSuffix = preset.promptSuffix;
  config.negativePrompt = preset.negativePrompt;
  config.useDefaultNegative = preset.useDefaultNegative !== false;
  config.activePromptPresetId = preset.id;
  // 高级参数切片镜像进 live 全局字段：切片存在才覆盖（旧预设无切片则不动）
  if (preset.novelai) Object.assign(config, preset.novelai);
}

export function applyPresetOpenAiToConfig(config: OpenAiConfig, preset: PortraitPromptPreset): void {
  if (preset.openai) Object.assign(config, preset.openai);
}

export function applyPresetComfyToConfig(config: ComfyUiConfig, preset: PortraitPromptPreset): void {
  if (preset.comfyui) Object.assign(config, preset.comfyui);
}

// —— 类型（本文件既是产出也自用）——

export type PortraitApiFormat = 'novelai' | 'openai' | 'comfyui';
export type PortraitComposeMode = 'tags' | 'natural';
/** 自然语言生图的输出语言（仅提示词模式为 natural 时生效；tags 模式恒为英文标签）。 */
export type NaturalPromptLanguage = 'en' | 'zh';
/** 同人身份标签拼入最终提示词的加权写法：novelai=1.2::tag::（NAI 专用）；anima=(tag:2)（SD 系通用，Anima 等非 NAI 后端）。 */
export type FanTagTransferMode = 'novelai' | 'anima';

export interface NovelAiConfig {
  url: string; key: string; model: string;
  promptPrefix: string; promptSuffix: string; negativePrompt: string;
  /** 是否前置系统固化默认负面提示词（UCP 质量词）；默认 true。live 值以当前选中预设为准 */
  useDefaultNegative: boolean;
  promptPresets: PortraitPromptPreset[];
  activePromptPresetId: string;
  width: number; height: number; steps: number; cfg: number;
  sampler: string; scheduler: string; seed: number;
  ucPreset: number; qualityToggle: boolean; autoSmea: boolean; decrisper: boolean;
  sm: boolean; smDyn: boolean; cfgRescale: number;
}

export interface OpenAiConfig {
  url: string; key: string; model: string;
  promptPrefix: string; promptSuffix: string; aspectRatio: string;
  /** 生图执行通道（「统一生图 API」最前端的顶层选项「生图接口」）：true=转交酒馆里的智慧姬（st-chatu8）
   *  插件执行（地址/密钥/模型用智慧姬里配的那套），false=内置直连（用下方供应商配置）。
   *  存储形态：true 时 apiFormat 恒为 'openai'（进入前的供应商记在 chatu8PrevApiFormat，切回时恢复）。 */
  chatu8: boolean;
  /** 第三条生图执行通道：true=转交酒馆里的柏宝绘（ST-BaiBai-Image）插件执行（后端/模型/画师串/
   *  质量词/负面/尺寸全用柏宝绘「渠道」页配的那套，本项目只提供提示词）。与 chatu8 互斥
   *  （归一化层强制：两者同真时 chatu8 优先，baibai 落 false）；存储形态与 chatu8 同款钉 openai。 */
  baibai: boolean;
}

/** @deprecated New runtime configuration uses ImageGenerationConfig.provider. */
export interface PortraitImageGen {
  apiFormat: PortraitApiFormat;
  promptComposeMode: PortraitComposeMode;
  naturalPromptLanguage: NaturalPromptLanguage;
  /** 进入外部生图接口（智慧姬/柏宝绘）前的供应商（仅 novelai/comfyui 需要恢复时记录）：切回内置直连时恢复
   *  apiFormat 用。两条外部通道互斥、共用这一个回溯位（切换只在「内置 ↔ 外部」间发生，外部之间直切不动它）。
   *  外部通道在存储上仍表示为 apiFormat='openai' + openai.chatu8/baibai=true（分发/存量设置/手机端零改动）。 */
  chatu8PrevApiFormat?: PortraitApiFormat;
  /** 同人身份标签加权写法：全局设置（原属预设，已提升）；默认 novelai */
  fanTagTransferMode: FanTagTransferMode;
  novelai: NovelAiConfig;
  openai: OpenAiConfig;
  comfyui: ComfyUiConfig;
}

// —— 默认值（1:1 复刻 phone-ctn 0920.js；promptComposeMode 默认改 tags）——

export function getDefaultNovelAiConfig(): NovelAiConfig {
  return {
    url: 'https://image.novelai.net', key: '', model: 'nai-diffusion-4-5-full',
    // 固定正面提示词（前/后）：默认留空，由用户在设置面板自行配置
    promptPrefix: '', promptSuffix: '',
    // 固定负面提示词：仅放立绘专用补充负面（UCP 已覆盖通用质量问题，此处不重复）
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    // 默认负面质量词（UCP）默认开启；用户反馈其会拉低画面效果时可关闭
    useDefaultNegative: true,
    promptPresets: getDefaultPromptPresets(),
    activePromptPresetId: DEFAULT_PROMPT_PRESET_ID,
    width: 1024, height: 1024, steps: 28, cfg: 10,
    // 对齐 st-chatu8：karras 噪声调度 + Heavy UCP 预设
    sampler: 'k_euler', scheduler: 'karras', seed: -1,
    ucPreset: 3, qualityToggle: true, autoSmea: false, decrisper: false,
    // cfg_rescale 0.18 提升多样性（对齐 st-chatu8）
    sm: false, smDyn: false, cfgRescale: 0.18,
  };
}

export function getDefaultOpenAiConfig(): OpenAiConfig {
  return { url: '', key: '', model: '', promptPrefix: '', promptSuffix: '', aspectRatio: 'auto', chatu8: false, baibai: false };
}

export function getDefaultPortraitImageGen(): PortraitImageGen {
  return {
    apiFormat: 'novelai',
    promptComposeMode: 'tags',
    naturalPromptLanguage: 'en',
    fanTagTransferMode: 'novelai',
    novelai: getDefaultNovelAiConfig(),
    openai: getDefaultOpenAiConfig(),
    comfyui: getDefaultComfyUiConfig(),
  };
}

// —— 归一化辅助（1:1 复刻 phone-ctn 0920.js clamp 逻辑）——
// ★U7：实现收拢到 `core/number.ts`（clampFloat / toIntLoose）。这里的脾气是
// 「number 原样；**非空字符串** → Number；其余（''/null/true）无效回退」，且 clampNum **不取整**
// （'5.9'→5.9）。本处保留原函数名与「(值, 兜底, 下界, 上界)」参数顺序，16 处调用点零改动。
function clampNum(e: unknown, fallback: number, lo: number, hi: number): number {
  return clampFloat(e, lo, hi, fallback);
}
function toInt(e: unknown, fallback: number): number {
  return toIntLoose(e, fallback);
}
function multipleOf64(e: unknown, fallback: number): number {
  const t = clampNum(toInt(e, fallback), fallback, 64, 4096);
  return 64 * Math.round(t / 64);
}
function normalizeSeed(e: unknown): number {
  const t = toInt(e, -1);
  return t < 0 ? -1 : clampNum(t, 0, 0, 4294967295);
}
function normalizeBool(e: unknown, fallback: boolean): boolean {
  return typeof e === 'boolean' ? e : fallback;
}
function normalizeStr(e: unknown, fallback: string): string {
  return typeof e === 'string' ? e : fallback;
}
function normalizeApiFormat(e: unknown): PortraitApiFormat {
  if (e === 'openai') return 'openai';
  if (e === 'comfyui') return 'comfyui';
  return 'novelai';
}
function normalizeComposeMode(e: unknown): PortraitComposeMode {
  // 'none'（不绘图）已废弃：旧数据迁移为 'tags'；undefined/非法 → 默认 tags
  return e === 'natural' ? 'natural' : 'tags';
}
function normalizeNaturalPromptLanguage(e: unknown): NaturalPromptLanguage {
  return e === 'zh' ? 'zh' : 'en';
}
function normalizeAspect(e: unknown): string {
  return ASPECT_RATIO_OPTIONS.includes(e as string) ? (e as string) : 'auto';
}

export function normalizeNovelAiConfig(input: unknown): NovelAiConfig {
  const d = getDefaultNovelAiConfig();
  const c = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const hasPresets = Array.isArray(c.promptPresets) && c.promptPresets.length > 0;
  const promptPrefix = normalizeStr(c.promptPrefix, d.promptPrefix);
  const promptSuffix = normalizeStr(c.promptSuffix, d.promptSuffix);
  const negativePrompt = normalizeStr(c.negativePrompt, d.negativePrompt);
  const useDefaultNegative = normalizeBool(c.useDefaultNegative, d.useDefaultNegative);
  // 无预设时：旧配置（或首启默认）迁移为单内置预设，内容取旧三字段，保持不变量
  const promptPresets = hasPresets
    ? normalizePromptPresets(c.promptPresets, d.promptPresets)
    : getDefaultPromptPresets(negativePrompt).map(p => ({ ...p, promptPrefix, promptSuffix, useDefaultNegative }));
  const activePreset = resolveActivePreset(promptPresets, c.activePromptPresetId);
  // 有预设时：live 三字段以当前选中预设为准（迁移/activeId 修复后兜底预设内容）
  const effectivePrefix = hasPresets ? activePreset.promptPrefix : promptPrefix;
  const effectiveSuffix = hasPresets ? activePreset.promptSuffix : promptSuffix;
  const effectiveNegative = hasPresets ? activePreset.negativePrompt : negativePrompt;
  const effectiveUseDefaultNegative = hasPresets ? activePreset.useDefaultNegative !== false : useDefaultNegative;
  return {
    // 空串回退固定默认地址：老配置持久化的空 url 自动升级为官方地址，自定义地址（如反代镜像）不受影响
    url: typeof c.url === 'string' && c.url.trim() !== '' ? c.url : d.url,
    key: normalizeStr(c.key, d.key),
    model: normalizeStr(c.model, d.model),
    promptPrefix: effectivePrefix,
    promptSuffix: effectiveSuffix,
    negativePrompt: effectiveNegative,
    useDefaultNegative: effectiveUseDefaultNegative,
    promptPresets,
    activePromptPresetId: activePreset.id,
    width: multipleOf64(c.width, d.width),
    height: multipleOf64(c.height, d.height),
    steps: toInt(clampNum(c.steps, d.steps, 1, 60), d.steps),
    cfg: clampNum(c.cfg, d.cfg, 0, 30),
    sampler: normalizeStr(c.sampler, d.sampler),
    scheduler: normalizeStr(c.scheduler, d.scheduler),
    seed: normalizeSeed(c.seed),
    ucPreset: toInt(clampNum(c.ucPreset, d.ucPreset, 0, 3), d.ucPreset),
    qualityToggle: normalizeBool(c.qualityToggle, d.qualityToggle),
    autoSmea: normalizeBool(c.autoSmea, d.autoSmea),
    decrisper: normalizeBool(c.decrisper, d.decrisper),
    sm: normalizeBool(c.sm, d.sm),
    smDyn: normalizeBool(c.smDyn, d.smDyn),
    cfgRescale: clampNum(c.cfgRescale, d.cfgRescale, 0, 1),
  };
}

export function normalizeOpenAiConfig(input: unknown): OpenAiConfig {
  const d = getDefaultOpenAiConfig();
  const c = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const chatu8 = c.chatu8 === true;
  return {
    url: normalizeStr(c.url, d.url),
    key: normalizeStr(c.key, d.key),
    model: normalizeStr(c.model, d.model),
    promptPrefix: normalizeStr(c.promptPrefix, d.promptPrefix),
    promptSuffix: normalizeStr(c.promptSuffix, d.promptSuffix),
    aspectRatio: normalizeAspect(c.aspectRatio),
    chatu8,
    // 两条外部通道互斥：脏数据两者同真时 chatu8 优先（存量用户设置不因新通道静默改变）
    baibai: c.baibai === true && !chatu8,
  };
}

export function normalizePortraitImageGen(input: unknown): PortraitImageGen {
  const c = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const openai = normalizeOpenAiConfig(c.openai);
  // 外部生图通道（智慧姬/柏宝绘）的存储形态恒为 apiFormat='openai'（新 UI 切换时同步写入）；
  // 防御性迁移：脏数据（外部通道开启但 apiFormat 指向别家）拉回 openai，保证通道行显示与分发一致
  const externalChannel = openai.chatu8 === true || openai.baibai === true;
  const apiFormat = externalChannel ? 'openai' : normalizeApiFormat(c.apiFormat);
  let promptComposeMode = normalizeComposeMode(c.promptComposeMode);
  // NAI 仅支持标签模式：强制自然语言回落到标签（兜底配置加载/直写等绕过 UI 的路径）
  if (apiFormat === 'novelai' && promptComposeMode === 'natural') promptComposeMode = 'tags';
  return {
    apiFormat,
    promptComposeMode,
    naturalPromptLanguage: normalizeNaturalPromptLanguage(c.naturalPromptLanguage),
    // 同人tag加权写法：白名单归一，缺失/非法 = novelai（全局设置，原属预设字段，已提升）
    fanTagTransferMode: c.fanTagTransferMode === 'anima' ? 'anima' : 'novelai',
    // 仅记录需恢复的非 openai 供应商（'openai' 无需恢复，直接丢弃）
    chatu8PrevApiFormat: c.chatu8PrevApiFormat === 'novelai' || c.chatu8PrevApiFormat === 'comfyui' ? c.chatu8PrevApiFormat : undefined,
    novelai: normalizeNovelAiConfig(c.novelai),
    openai,
    comfyui: normalizeComfyUiConfig(c.comfyui),
  };
}

// —— ComfyUI 配置（占位符注入工作流 + HTTP 轮询）——

export interface ComfyWorkflowPreset {
  id: string;
  name: string;
  workflow: string;    // API 格式工作流 JSON 字符串，含 %token%；空串=默认工作流
  fingerprint: string; // 工作流内容指纹（hash+长度），切换/脏检查用
  isDefault?: boolean;
}

export interface ComfyUiConfig {
  url: string;
  workflows: ComfyWorkflowPreset[];
  activeWorkflowId: string;
  promptPrefix: string;
  promptSuffix: string;
  negativePrompt: string;
  model: string;
  sampler: string;
  scheduler: string;
  vae: string;
  clip: string;
  lora: string;
  steps: number;
  cfg: number;
  seed: number;
  width: number;
  height: number;
  timeoutSeconds: number;
}

export const DEFAULT_COMFY_SAMPLER = 'euler';
export const DEFAULT_COMFY_SCHEDULER = 'normal';

// 默认 txt2img 工作流（API 格式，所有可参数化字段用占位符）。
// 默认 ComfyUI 工作流使用 %token% 占位。
export const DEFAULT_COMFY_WORKFLOW_JSON = JSON.stringify({
  '3': { inputs: { seed: '%seed%', steps: '%steps%', cfg: '%cfg%', sampler_name: '%sampler_name%', scheduler: '%scheduler%', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }, class_type: 'KSampler', _meta: { title: 'KSampler' } },
  '4': { inputs: { ckpt_name: '%MODEL_NAME%' }, class_type: 'CheckpointLoaderSimple', _meta: { title: 'Load Checkpoint' } },
  '5': { inputs: { width: '%width%', height: '%height%', batch_size: 1 }, class_type: 'EmptyLatentImage', _meta: { title: 'Empty Latent Image' } },
  '6': { inputs: { text: '%prompt%', clip: ['4', 1] }, class_type: 'CLIPTextEncode', _meta: { title: 'CLIP Text Encode (Positive Prompt)' } },
  '7': { inputs: { text: '%negative_prompt%', clip: ['4', 1] }, class_type: 'CLIPTextEncode', _meta: { title: 'CLIP Text Encode (Negative Prompt)' } },
  '8': { inputs: { samples: ['3', 0], vae: ['4', 2] }, class_type: 'VAEDecode', _meta: { title: 'VAE Decode' } },
  '9': { inputs: { filename_prefix: 'ub_portrait', images: ['8', 0] }, class_type: 'SaveImage', _meta: { title: 'Save Image' } },
}, null, 2);

export const DEFAULT_COMFY_WORKFLOW_ID = 'wf-default';

// 替换默认工作流前的旧默认指纹（2026-08-16 升级）。旧默认 KSampler 缺 model/positive/negative/latent_image 四条连线，
// 在 ComfyUI /prompt 校验会失败；检测到该指纹即自动升级为新默认。
export const LEGACY_DEFAULT_COMFY_WORKFLOW_FINGERPRINT = 'fe531a3:1525';

// FNV-1a 32-bit hash + 长度，作为工作流指纹。
export function computeComfyFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + text.length;
}

export function getDefaultComfyUiConfig(): ComfyUiConfig {
  const defaultWorkflow: ComfyWorkflowPreset = {
    id: DEFAULT_COMFY_WORKFLOW_ID,
    name: '默认 txt2img',
    workflow: DEFAULT_COMFY_WORKFLOW_JSON,
    fingerprint: computeComfyFingerprint(DEFAULT_COMFY_WORKFLOW_JSON),
    isDefault: true,
  };
  return {
    url: '',
    workflows: [defaultWorkflow],
    activeWorkflowId: DEFAULT_COMFY_WORKFLOW_ID,
    promptPrefix: '',
    promptSuffix: '',
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    model: '',
    sampler: DEFAULT_COMFY_SAMPLER,
    scheduler: DEFAULT_COMFY_SCHEDULER,
    vae: '',
    clip: '',
    lora: '',
    steps: 20,
    cfg: 7,
    seed: -1,
    width: 832,
    height: 1216,
    timeoutSeconds: 300,
  };
}

export function normalizeComfyWorkflowPresets(input: unknown, fallback: ComfyWorkflowPreset[]): ComfyWorkflowPreset[] {
  if (!Array.isArray(input) || input.length === 0) return [...fallback];
  const seen = new Set<string>();
  const out: ComfyWorkflowPreset[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const id = typeof c.id === 'string' && c.id ? c.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const workflow = typeof c.workflow === 'string' ? c.workflow : '';
    // 空 workflow 回退为默认工作流 JSON（保持开箱即用）
    let resolvedWorkflow = workflow || DEFAULT_COMFY_WORKFLOW_JSON;
    // 老用户自动升级：默认预设内容仍是旧默认（缺 KSampler 连线）时替换为新默认，幂等（升级后指纹已变不再命中）
    if (id === DEFAULT_COMFY_WORKFLOW_ID && computeComfyFingerprint(resolvedWorkflow) === LEGACY_DEFAULT_COMFY_WORKFLOW_FINGERPRINT) {
      resolvedWorkflow = DEFAULT_COMFY_WORKFLOW_JSON;
    }
    const isDef = c.isDefault === true || id === DEFAULT_COMFY_WORKFLOW_ID;
    out.push({
      id,
      name: normalizeStr(c.name, '未命名工作流'),
      workflow: resolvedWorkflow,
      fingerprint: computeComfyFingerprint(resolvedWorkflow),
      ...(isDef ? { isDefault: true } : {}),
    });
  }
  if (!seen.has(DEFAULT_COMFY_WORKFLOW_ID)) {
    const d = fallback.find(p => p.isDefault) || fallback[0] || getDefaultComfyUiConfig().workflows[0];
    out.unshift({ id: DEFAULT_COMFY_WORKFLOW_ID, name: d.name, workflow: DEFAULT_COMFY_WORKFLOW_JSON, fingerprint: computeComfyFingerprint(DEFAULT_COMFY_WORKFLOW_JSON), isDefault: true });
  }
  return out;
}

export function resolveActiveComfyWorkflow(presets: ComfyWorkflowPreset[], activeId: unknown): ComfyWorkflowPreset {
  if (typeof activeId === 'string') {
    const hit = presets.find(p => p.id === activeId);
    if (hit) return hit;
  }
  return presets.find(p => p.isDefault) || presets[0] || getDefaultComfyUiConfig().workflows[0];
}

export function nextComfyWorkflowId(presets: ComfyWorkflowPreset[]): string {
  let n = 1;
  while (presets.some(p => p.id === 'wf-' + n)) n++;
  return 'wf-' + n;
}

function multipleOf8(e: unknown, fallback: number): number {
  const t = clampNum(toInt(e, fallback), fallback, 64, 2048);
  return 8 * Math.round(t / 8);
}

export function normalizeComfyUiConfig(input: unknown): ComfyUiConfig {
  const d = getDefaultComfyUiConfig();
  const c = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const workflows = normalizeComfyWorkflowPresets(c.workflows, d.workflows);
  const active = resolveActiveComfyWorkflow(workflows, c.activeWorkflowId);
  return {
    url: normalizeStr(c.url, d.url),
    workflows,
    activeWorkflowId: active.id,
    promptPrefix: normalizeStr(c.promptPrefix, d.promptPrefix),
    promptSuffix: normalizeStr(c.promptSuffix, d.promptSuffix),
    negativePrompt: normalizeStr(c.negativePrompt, d.negativePrompt),
    model: normalizeStr(c.model, d.model),
    sampler: normalizeStr(c.sampler, d.sampler),
    scheduler: normalizeStr(c.scheduler, d.scheduler),
    vae: normalizeStr(c.vae, d.vae),
    clip: normalizeStr(c.clip, d.clip),
    lora: normalizeStr(c.lora, d.lora),
    steps: toInt(clampNum(c.steps, d.steps, 1, 150), d.steps),
    cfg: clampNum(c.cfg, d.cfg, 0, 50),
    seed: normalizeSeed(c.seed),
    width: multipleOf8(c.width, d.width),
    height: multipleOf8(c.height, d.height),
    timeoutSeconds: toInt(clampNum(c.timeoutSeconds, d.timeoutSeconds, 30, 1800), d.timeoutSeconds),
  };
}

// ===== 立绘生成尺寸方向（快捷选择 / 偏好存储用）=====

/** 尺寸方向：portrait=竖 / landscape=横 / square=1:1。按方向存储，生成时按供应商解析为像素或比例。 */
export type PortraitSizeOrientation = 'portrait' | 'landscape' | 'square';

/** 全局唯一的立绘生成偏好（点「保存为偏好」落盘；undefined=无偏好）。 */
export interface PortraitGenPreference {
  preset: PortraitPreset;
  theme: PortraitTheme;
  includeStatus: boolean;
  includeEmotion: boolean;
  includeFanwork: boolean;
  includeProtagonist: boolean;
  extraPrompt: string;
  sizeOrientation: PortraitSizeOrientation;
}

/** 方向 → 供应商尺寸。NAI/ComfyUI 用像素（width/height 非 0），OpenAI 用比例（aspectRatio 非 auto，像素为 0）。 */
const SIZE_BY_ORIENTATION: Record<PortraitSizeOrientation, { w: number; h: number; ratio: string }> = {
  portrait: { w: 832, h: 1216, ratio: '2:3' },
  landscape: { w: 1216, h: 832, ratio: '3:2' },
  square: { w: 1024, h: 1024, ratio: '1:1' },
};

/** 按方向 + 图源供应商解析出尺寸。OpenAI 像素字段返回 0（OpenAI 只用 aspectRatio）。 */
export function resolveSizeByOrientation(
  apiFormat: 'novelai' | 'openai' | 'comfyui',
  orientation: PortraitSizeOrientation,
): { width: number; height: number; aspectRatio: string } {
  const s = SIZE_BY_ORIENTATION[orientation];
  if (apiFormat === 'openai') return { width: 0, height: 0, aspectRatio: s.ratio };
  return { width: s.w, height: s.h, aspectRatio: s.ratio };
}

/** 设置里的任务尺寸与某个快速方向完全一致时返回该方向（弹窗据此省略「默认」按钮，重合项即默认）；无一一致返回 null。 */
export function matchSizeOrientation(
  apiFormat: 'novelai' | 'openai' | 'comfyui',
  width: number,
  height: number,
  aspectRatio: string,
): PortraitSizeOrientation | null {
  for (const o of ['portrait', 'landscape', 'square'] as const) {
    const s = SIZE_BY_ORIENTATION[o];
    if (apiFormat === 'openai' ? aspectRatio === s.ratio : (width === s.w && height === s.h)) return o;
  }
  return null;
}

/** OpenAI aspectRatio → 方向映射（auto 视作 square）。 */
const OPENAI_PORTRAIT_RATIOS = new Set(['2:3', '9:16', '3:4', '4:5']);
const OPENAI_LANDSCAPE_RATIOS = new Set(['3:2', '16:9', '4:3', '21:9']);

/** 由全局任务尺寸反推最接近的方向，供弹窗无偏好时初始化高亮。无法判定返回 null。 */
export function inferSizeOrientation(input: {
  apiFormat: 'novelai' | 'openai' | 'comfyui';
  width: number;
  height: number;
  aspectRatio: string;
}): PortraitSizeOrientation | null {
  if (input.apiFormat === 'openai') {
    if (OPENAI_PORTRAIT_RATIOS.has(input.aspectRatio)) return 'portrait';
    if (OPENAI_LANDSCAPE_RATIOS.has(input.aspectRatio)) return 'landscape';
    if (input.aspectRatio === '1:1' || input.aspectRatio === 'auto') return 'square';
    return null;
  }
  if (input.width > input.height) return 'landscape';
  if (input.width < input.height) return 'portrait';
  if (input.width === input.height && input.width > 0) return 'square';
  return null;
}

// ===== 图库筛选匹配纯函数（供图库筛选器使用；纯逻辑可测）=====
const STANDARD_EMOTION_SET = new Set(STANDARD_EMOTIONS);

/** 图库筛选条件：emotion='全部' 或具体情绪或 '其他'（非标准情绪/未标注）；nsfw='全部'|'daily'|'nsfw'|'untagged' */
export interface PortraitGalleryFilter { emotion: string; nsfw: string; }

/** 判断一张图是否落入某情绪筛选（'全部'恒真；标准情绪精确匹配；'其他'=非标准情绪或未标注） */
export function portraitMatchesEmotionFilter(emotion: string | undefined, filter: string): boolean {
  if (filter === '全部') return true;
  const em = emotion || '';
  if (filter === '其他') return !em || !STANDARD_EMOTION_SET.has(em);
  return em === filter;
}

/** 判断一张图是否落入瑟瑟筛选：'全部'恒真；'nsfw'=nsfw===true；'daily'=nsfw===false；'untagged'=nsfw===undefined */
export function portraitMatchesNsfwFilter(nsfw: boolean | undefined, filter: string): boolean {
  if (filter === '全部') return true;
  if (filter === 'nsfw') return nsfw === true;
  if (filter === 'daily') return nsfw === false;
  if (filter === 'untagged') return nsfw === undefined;
  return true;
}
