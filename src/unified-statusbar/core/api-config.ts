import { getTavernHelper, getToastr, makeGenerationId, stopGenerationById } from './env';
import { makeUniqueId } from './id';
import {
  beginAiActivity, readAiActivityChatKey, updateAiActivity,
  type AiActivityHandle, type AiActivityPatch,
} from './ai-activity';
import { AI_TEXT_FEATURE_LABEL, type AiTextFeature, type AiTextPhase } from './ai-text-features';
// ===== 请求生成 API 配置助手 =====
// 负责将配置中的自定义 API 参数转换为 generateRaw 所需的 custom_api 对象，
// 并提供持久化错误通知与模型列表加载能力。
//
// 大调查与日历更新在请求生成时统一调用 getCustomApiConfig()，
// 返回 undefined 时使用酒馆当前 API，从而做到「只替换请求 API，
// 不改变上下文内容与结构」。

import { getConfig } from './config-store';
import { withAiRetry, isAiAbortError, type AiRetryOptions } from './ai-retry';
export { isAiAbortError };
import { stripTailSafeBlock } from './ai-parse';
import { normalizeAiRetryMax, type AiRetryScope } from './constants';
import type { CustomApiPreset } from './constants';

/** 生成预设唯一标识 */
export function generatePresetId(): string {
  return makeUniqueId('ap', 8, '_');
}

// 对应 generate.d.ts 中的 CustomApiConfig
export interface CustomApiConfig {
  proxy_preset?: string;
  apiurl?: string;
  key?: string;
  model?: string;
  source?: string;
  max_tokens?: 'same_as_preset' | 'unset' | number;
  temperature?: 'same_as_preset' | 'unset' | number;
  frequency_penalty?: 'same_as_preset' | 'unset' | number;
  presence_penalty?: 'same_as_preset' | 'unset' | number;
  top_p?: 'same_as_preset' | 'unset' | number;
  top_k?: 'same_as_preset' | 'unset' | number;
}

// 获取 toastr 对象（与 investigation.ts / calendar-ai.ts 一致的方式）

// 获取 TavernHelper 对象

/**
 * 请求生成功能的标识。仅当 apiMode === 'per-feature' 时决定读取哪个功能的绑定预设。
 * - 'investigation' → config.investigationApiPresetId
 * - 'calendar'       → config.calendarApiPresetId
 * - 'map'            → config.mapApiPresetId
 * - 'shopStory'      → config.shopStoryApiPresetId
 * - 'nsfwGuidance'   → config.nsfwGuidanceApiPresetId
 * - 'chronicleMerge' → config.chronicleMergeApiPresetId（[LEGACY-MERGE · DB-ONLY] 仅状态栏数据库模式）
 * - 'imageGeneration' → config.imageGeneration.imagePromptApiPresetId
 * - 'wardrobeExtract' → config.wardrobeExtractApiPresetId
 * 不传（或 tavern/custom 模式下）则忽略，custom 模式统一用 activeApiPresetId。
 */
export type ApiScope = 'investigation' | 'calendar' | 'map' | 'shopStory' | 'imageGeneration' | 'portrait' | 'nsfwGuidance' | 'skillTree' | 'chronicleMerge' | 'wardrobeExtract' | 'characterWorldbook' | 'world';

/**
 * 按 apiMode + scope 解析当前应使用的 customApiPreset id。
 * - tavern：恒为空串（走酒馆主 API）
 * - custom：返回 activeApiPresetId（所有功能共用）
 * - per-feature：返回 scope 对应功能的 *ApiPresetId；scope 缺失则空串
 */
function resolveActivePresetId(scope?: ApiScope): string {
  const config = getConfig();
  if (config.apiMode === 'custom') return config.activeApiPresetId;
  if (config.apiMode === 'per-feature') {
    if (scope === 'investigation') return config.investigationApiPresetId;
    if (scope === 'calendar') return config.calendarApiPresetId;
    if (scope === 'map') return config.mapApiPresetId;
    if (scope === 'shopStory') return config.shopStoryApiPresetId;
    if (scope === 'imageGeneration' || scope === 'portrait') return config.imageGeneration.imagePromptApiPresetId;
    if (scope === 'nsfwGuidance') return config.nsfwGuidanceApiPresetId;
    if (scope === 'skillTree') return config.skillApiPresetId;
    if (scope === 'chronicleMerge') return config.chronicleMergeApiPresetId;
    if (scope === 'wardrobeExtract') return config.wardrobeExtractApiPresetId;
    if (scope === 'characterWorldbook') return config.characterWorldbookApiPresetId;
    if (scope === 'world') return config.worldApiPresetId;
    return '';
  }
  return ''; // tavern
}

/** 在 customApiPresets 仓库中按 id 查找预设；id 为空或找不到时返回 null */
function findCustomApiPreset(id: string): CustomApiPreset | null {
  if (!id) return null;
  const config = getConfig();
  return config.customApiPresets.find(p => p.id === id) || null;
}

/** 把一条 CustomApiPreset 映射成 generateRaw 所需的 custom_api 对象 */
function presetToCustomApiConfig(preset: CustomApiPreset): CustomApiConfig {
  const cfg: CustomApiConfig = {};
  if (preset.url && preset.url.trim()) cfg.apiurl = preset.url.trim();
  if (preset.key) cfg.key = preset.key;
  if (preset.model && preset.model.trim()) cfg.model = preset.model.trim();
  // API 源不走预设：统一由 generateRaw 使用默认源（'openai'）。
  // 数值类参数：始终传入（含 'unset'），让 generateRaw 决定行为
  cfg.max_tokens = preset.maxTokens;
  cfg.temperature = preset.temperature;
  cfg.frequency_penalty = preset.frequencyPenalty;
  cfg.presence_penalty = preset.presencePenalty;
  // top_p 合法区间 (0, 1]（DeepSeek 拒绝 0 / null，报 Invalid top_p value）；
  // 越界值按 'unset' 处理，避免预设里存下的 0 被原样发给上游。
  cfg.top_p = typeof preset.topP === 'number' && (preset.topP <= 0 || preset.topP > 1) ? 'unset' : preset.topP;
  cfg.top_k = preset.topK;
  return cfg;
}

/**
 * 根据当前配置返回 custom_api 对象（决定请求生成时使用的 API 端点）。
 *
 * - apiMode === 'tavern'：返回 undefined，generateRaw 将使用酒馆当前主 API
 * - apiMode === 'custom'：用 activeApiPresetId 对应预设构造；未选/被删则 undefined
 * - apiMode === 'per-feature'：用 scope 对应功能的绑定预设构造；
 *   该功能留空或预设被删则返回 undefined（走酒馆主 API，静默回退）
 *
 * 预设即唯一真相：顶层 customApi* 字段不再被读取，仅作面板编辑态/迁移源。
 *
 * @param scope 仅 per-feature 模式下决定读取哪个功能的绑定
 * @returns CustomApiConfig | undefined
 */
export function getCustomApiConfig(scope?: ApiScope): CustomApiConfig | undefined {
  const config = getConfig();
  if (config.apiMode === 'tavern') return undefined;
  const presetId = resolveActivePresetId(scope);
  if (!presetId) return undefined; // 无绑定 → 走酒馆主 API
  const preset = findCustomApiPreset(presetId);
  if (!preset) return undefined; // 预设已被删 → 防御性回退（validate 会先拦截 custom 模式）
  return presetToCustomApiConfig(preset);
}

/**
 * 校验自定义 API 配置是否可用。三处调用点在 generateRaw 前先调用本函数作闸门。
 *
 * - tavern：恒可用（返回 null）
 * - custom：activeApiPresetId 为空→报「未选择预设」；预设被删→报「已被删除」；缺 URL/模型→报对应错误
 * - per-feature：该功能留空→可用（走酒馆主 API）；预设被删→可用（静默回退，不阻断）；缺 URL/模型→报错
 *
 * @param scope 仅 per-feature 模式下决定校验哪个功能的绑定
 * @returns 错误消息字符串；配置可用时返回 null
 */
export function validateCustomApiConfig(scope?: ApiScope): string | null {
  const config = getConfig();
  if (config.apiMode === 'tavern') return null;
  const presetId = resolveActivePresetId(scope);
  if (!presetId) {
    // custom 模式必须选预设；per-feature 模式该功能留空 = 走酒馆主 API（可用）
    if (config.apiMode === 'custom') {
      return '未选择 API 预设，请到设置→API→API预设管理中保存并选择一个预设。';
    }
    return null;
  }
  const preset = findCustomApiPreset(presetId);
  if (!preset) {
    // custom：报错让用户重选；per-feature：静默回退酒馆主 API（不阻断）
    if (config.apiMode === 'custom') {
      return '绑定的 API 预设已被删除，请到设置→API 中重新选择。';
    }
    return null;
  }
  if (!preset.url || !preset.url.trim()) {
    return '绑定的 API 预设缺少 URL，请先在设置→API→API预设管理中补全。';
  }
  if (!preset.model || !preset.model.trim()) {
    return '绑定的 API 预设缺少模型名，请先在设置→API→API预设管理中补全。';
  }
  return null;
}

/**
 * 返回宅仙只读小助手使用的 custom_api 对象。
 *
 * 小助手拥有**独立**的 API 作用域：仅读取 config.assistantApiPresetId，
 * 不继承全局 apiMode 决策——即使全局 apiMode 为 'tavern' 或 'custom'，
 * 只要绑定了 assistant 预设就独立使用该预设。
 *
 * - assistantApiPresetId 为空：返回 undefined（generateRaw 走酒馆主 API）
 * - 绑定的预设已被删除：返回 undefined（静默回退酒馆主 API）
 * - 正常绑定：返回 presetToCustomApiConfig(preset)
 *
 * @returns CustomApiConfig | undefined
 */
export function getAssistantApiConfig(): CustomApiConfig | undefined {
  const preset = findCustomApiPreset(getConfig().assistantApiPresetId);
  return preset ? presetToCustomApiConfig(preset) : undefined;
}

/**
 * 校验小助手 API 配置是否可用。
 *
 * - 未绑定预设：可用（走酒馆主 API，返回 null）
 * - 绑定的预设已被删除：可用（静默回退酒馆主 API，返回 null）
 * - 预设缺少 URL/模型：报对应错误
 *
 * @returns 错误消息字符串；配置可用时返回 null
 */
export function validateAssistantApiConfig(): string | null {
  const config = getConfig();
  const presetId = config.assistantApiPresetId;
  if (!presetId) return null; // 空串 → 跟随酒馆主 API（可用）
  const preset = findCustomApiPreset(presetId);
  if (!preset) return null; // 预设被删 → 静默回退酒馆主 API（不阻断）
  if (!preset.url || !preset.url.trim()) {
    return '小助手绑定的 API 预设缺少 URL，请先在设置→API→API预设管理中补全。';
  }
  if (!preset.model || !preset.model.trim()) {
    return '小助手绑定的 API 预设缺少模型名，请先在设置→API→API预设管理中补全。';
  }
  return null;
}

/**
 * 拉取可用模型列表。
 *
 * @param apiurl API 地址
 * @param key API 密钥（可选）
 * @returns 模型名称数组；失败时抛出异常
 */
export async function fetchModelList(apiurl: string, key?: string): Promise<string[]> {
  const th = getTavernHelper();
  const fn = th?.getModelList;
  if (typeof fn !== 'function') {
    throw new Error('无法访问 getModelList 函数，请检查酒馆助手版本');
  }
  const params: { apiurl: string; key?: string } = { apiurl: apiurl.trim() };
  if (key) params.key = key;
  return await fn(params);
}

// ═══════════════════════════════════════════════════════════════
// 持久化通知
//
// 默认 toastr 三秒后自动消失。生成请求失败属于需要用户明确知悉的
// 异常情况，因此错误/警告通知改为持续存在（timeOut: 0），
// 用户点击或按关闭按钮后才会消失。
// ═══════════════════════════════════════════════════════════════

// 持久化 toastr 选项
// extraClasses:'ub-persist' 供 styles/notify-base.ts 套报错档红壳（红边+暗红底，与普通报错一致）+ 不自动消失（timeOut:0 不发倒计时条）。
const PERSIST_OPTS: any = {
  timeOut: 0,            // 不自动消失
  extendedTimeOut: 0,    // 悬停时不延长
  tapToDismiss: true,    // 点击可关闭
  closeButton: true,     // 显示关闭按钮
  extraClasses: 'ub-persist',
};

// 持久通知去重：同一（级别+标题+文案）在窗口期内只弹一条。
// 背景：持久通知不自动消失，自动管线故障（如正文插图每条 AI 消息跑一次校验）会线性堆叠
// 常驻 toast（纯 DOM 累积+视觉噪音）。用户主动关掉后窗口期内同文案不再弹——视为已知悉。
const PERSIST_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const _persistToastLastShown = new Map<string, number>();

function persistToastSuppressed(key: string): boolean {
  const now = Date.now();
  const last = _persistToastLastShown.get(key);
  if (last != null && now - last < PERSIST_DEDUP_WINDOW_MS) return true;
  // 顺手清过期项，Map 有界（键数=不同错误文案数）
  if (_persistToastLastShown.size > 50) {
    for (const [k, t] of _persistToastLastShown) {
      if (now - t >= PERSIST_DEDUP_WINDOW_MS) _persistToastLastShown.delete(k);
    }
  }
  _persistToastLastShown.set(key, now);
  return false;
}

/**
 * 显示持续存在的错误通知。
 * 用于请求生成失败等需要用户明确知悉的场景。
 */
export function showPersistentError(message: string, title?: string): void {
  const toastr = getToastr();
  if (!toastr) {
    console.error('[持久错误]', title || '', message);
    return;
  }
  try {
    if (persistToastSuppressed(`error|${title || ''}|${message}`)) return;
    toastr.error(message, title, PERSIST_OPTS);
  } catch (e) {
    console.error(message);
  }
}

/**
 * 显示持续存在的警告通知。
 */
export function showPersistentWarning(message: string, title?: string): void {
  const toastr = getToastr();
  if (!toastr) {
    console.warn('[持久警告]', title || '', message);
    return;
  }
  try {
    if (persistToastSuppressed(`warn|${title || ''}|${message}`)) return;
    toastr.warning(message, title, PERSIST_OPTS);
  } catch (e) {
    console.warn(message);
  }
}

// ═══════════════════════════════════════════════════════════════
// AI 请求失败自动重试
//
// 复用 core/ai-retry.ts 的分类器（限流/5xx/网络/超时/空响应才重试；
// 鉴权/参数/主动中止立即抛出）。本模块只负责「按设置决定重试几次」与
// 「每次重试发一条通知」，不重复实现重试逻辑。
// 粒度与 API 绑定一致：tavern/custom 用总开关；per-feature 用逐功能开关。
// ═══════════════════════════════════════════════════════════════

/**
 * 某功能当前是否启用自动重试。
 *
 * - apiMode 为 per-feature：只看该功能自己的勾选（缺失=关）
 * - 其余模式（tavern/custom）：看总开关
 */
export function isAiRetryEnabled(scope?: AiRetryScope): boolean {
  const config = getConfig();
  if (config.apiMode === 'per-feature') {
    return !!scope && config.aiRetryScopes?.[scope] === true;
  }
  return config.aiRetryEnabled === true;
}

/** 每次自动重试时不再单独弹 toast：进度由活动注册表 + 统一 notifier 聚合展示。 */

/**
 * 构造 withAiRetry 的选项：关闭时 attempts=1（等价于不重试）。
 * 重试间隔沿用 ai-retry 默认（2 秒）。
 * 注意：这里不再挂「正在重试」toast——重试进度由 withTextAiRetry 写入活动注册表，
 * 由统一 notifier 聚合展示（避免与统一通知重复）。
 */
export function getAiRetryOptions(scope?: AiRetryScope): AiRetryOptions {
  if (!isAiRetryEnabled(scope)) return { attempts: 1 };
  const maxRetries = normalizeAiRetryMax(getConfig().aiRetryMax);
  return { attempts: maxRetries + 1 };
}

/** withTextAiRetry 回调上下文：generation_id / 取消信号 / 活动句柄 / 当前尝试序号。 */
export interface TextAiContext {
  /** 本次请求的 generation_id（必须写进 generateRaw，取消才能命中）。 */
  generationId: string;
  /** 取消信号：注册表取消 / 外部 signal 中止时触发。 */
  signal: AbortSignal;
  /** 活动句柄（可 update 阶段/标签）。 */
  activity: AiActivityHandle;
  /** 当前尝试序号（1 起）。 */
  attempt: number;
  /** 更新活动阶段（可附带 attempt/maxAttempts 等补丁）。 */
  setPhase(phase: AiTextPhase, patch?: AiActivityPatch): void;
}

export interface TextAiRetryOptions {
  signal?: AbortSignal;
  /** 统一标签（必填）：决定提示条/聚合 toast 上显示的功能名。 */
  feature: AiTextFeature;
  /** 发起时的聊天键；缺省走注册表读取口（getCurrentStoryChatKey）。 */
  chatKey?: string;
  /** 有专属面板/专属进度 UI：只上提示条与悬浮钮动效，不弹聚合 toast。 */
  suppressToast?: boolean;
  /** 已有 generation_id 的站点传进来，避免重复生成。 */
  generationId?: string;
  /** 外层（如 withAiParseRetry）已建条目时复用，不新建/不 end。 */
  activityId?: string;
  /** 取消时额外回调（置业务中止标志，如世界演化 _evolveAbortRequested）。 */
  onCancel?: () => void;
}

/**
 * 文本 AI 请求的统一入口：按设置重试 + 活动生命周期 + 取消。
 * 调用方把自己的 generateRaw 调用放进 fn，并把 ctx.generationId 写进请求的 generation_id；
 * 中止判定由调用方在 fn 内自行抛出（抛出含「已取消/abort」文本的错误会被分类为 aborted，不再重试）。
 * 成功返回的文本统一过 stripTailSafeBlock：默认尾部破限要求模型在任务输出完成后补 <safe> 无害化段，
 * 那是给审查模型看的、不属于任务输出，在文本出口剥掉可防污染 JSON/信封/生图提示词等下游解析。
 */
export function withTextAiRetry<T>(
  scope: AiRetryScope,
  fn: (ctx: TextAiContext) => Promise<T>,
  opts: TextAiRetryOptions,
): Promise<T> {
  const label = AI_TEXT_FEATURE_LABEL[opts.feature] || (opts.feature as string);
  const generationId = opts.generationId || makeGenerationId('ai');
  const chatKey = opts.chatKey != null ? opts.chatKey : readAiActivityChatKey();
  const controller = new AbortController();
  const externalSignal = opts.signal;
  let externalAbortListener: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      externalAbortListener = () => { try { controller.abort(); } catch (_e) { /* ignore */ } };
      try { externalSignal.addEventListener('abort', externalAbortListener); } catch (_e) { /* ignore */ }
    }
  }

  const retryOpts = getAiRetryOptions(scope);
  const maxAttempts = Math.max(1, retryOpts.attempts ?? 1);
  const reuse = !!opts.activityId;

  // cancel：先标 terminating + 停宿主生成 + abort（不再重试）。
  const doCancel = (): void => {
    const id = reuse ? opts.activityId! : '';
    if (id) updateAiActivity(id, { phase: 'terminating' });
    try { opts.onCancel?.(); } catch (_e) { /* ignore */ }
    try { controller.abort(); } catch (_e) { /* ignore */ }
    stopGenerationById(generationId);
  };

  let activity: AiActivityHandle;
  if (reuse) {
    updateAiActivity(opts.activityId!, {
      label, phase: 'preparing', generationId, chatKey,
      attempt: undefined, maxAttempts, cancelable: true,
      suppressToast: opts.suppressToast === true,
      cancel: doCancel,
    });
    activity = {
      id: opts.activityId!,
      update: (patch: AiActivityPatch) => updateAiActivity(opts.activityId!, patch),
      end: () => { /* 外层负责结束 */ },
    };
  } else {
    activity = beginAiActivity({
      label, phase: 'preparing', generationId, chatKey,
      maxAttempts, cancelable: true,
      suppressToast: opts.suppressToast === true,
      cancel: doCancel,
    });
  }

  const ctx: TextAiContext = {
    generationId,
    signal: controller.signal,
    activity,
    attempt: 0,
    setPhase(phase: AiTextPhase, patch?: AiActivityPatch): void {
      activity.update({ phase, ...patch });
    },
  };

  retryOpts.signal = controller.signal;
  retryOpts.onRetry = ({ attempt }) => {
    if (controller.signal.aborted) return; // 终止瞬间不再发「正在重试」
    activity.update({
      phase: 'retrying',
      attempt: Math.min(attempt + 1, maxAttempts),
      maxAttempts,
    });
  };

  return withAiRetry(async (attempt) => {
    ctx.attempt = attempt;
    activity.update({ phase: 'requesting', attempt, maxAttempts });
    return fn(ctx);
  }, retryOpts).then(result => {
    if (!controller.signal.aborted) activity.update({ phase: 'parsing', attempt: undefined });
    return typeof result === 'string' ? (stripTailSafeBlock(result) as unknown as T) : result;
  }).finally(() => {
    if (externalSignal && externalAbortListener) {
      try { externalSignal.removeEventListener('abort', externalAbortListener); } catch (_e) { /* ignore */ }
    }
    if (!reuse) activity.end();
  });
}
