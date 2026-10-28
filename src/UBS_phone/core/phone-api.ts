// ===== 小手机文本 API 解析（预设仓库=主项目 customApiPresets，对齐主项目 API 三模式思路） =====
// apiMode='global'      → 全体功能共用 apiPresetId（''=酒馆主 API）
// apiMode='per-feature' → scope 取 apiScopes[scope]（''=跟随全局；全局也未选=酒馆主 API）
// 只替换请求 API，不改上下文结构；预设被删/缺 URL 模型 → 静默回退酒馆主 API（校验函数负责提示）。

import type { CustomApiConfig } from '../../unified-statusbar/core/api-config';
import type { CustomApiPreset } from '../../unified-statusbar/core/constants';
import { normalizeAiRetryMax } from '../../unified-statusbar/core/constants';
import { withAiRetry, type AiRetryOptions } from '../../unified-statusbar/core/ai-retry';
import { stripTailSafeBlock } from '../../unified-statusbar/core/ai-parse';
import { getConfig } from './host-config';
import { updatePhoneAiActivity } from './ai-activity';
import { getPhoneSettings, type PhoneApiScopeKey } from './phone-settings';

export interface PhoneApiResolution {
  api: CustomApiConfig | undefined;
  presetId: string;
  presetName: string;
}

function presetToApi(preset: CustomApiPreset): CustomApiConfig {
  const cfg: CustomApiConfig = {};
  if (preset.url && preset.url.trim()) cfg.apiurl = preset.url.trim();
  if (preset.key) cfg.key = preset.key;
  if (preset.model && preset.model.trim()) cfg.model = preset.model.trim();
  cfg.max_tokens = preset.maxTokens;
  cfg.temperature = preset.temperature;
  cfg.frequency_penalty = preset.frequencyPenalty;
  cfg.presence_penalty = preset.presencePenalty;
  cfg.top_p = preset.topP;
  cfg.top_k = preset.topK;
  return cfg;
}

/** 主项目预设仓库（设置页下拉数据源；主项目未就绪=空列表）。 */
export function listHostPresets(): Array<{ id: string; name: string }> {
  try {
    const config = getConfig();
    return (config.customApiPresets || [])
      .filter(p => p && typeof p.id === 'string')
      .map(p => ({ id: p.id, name: p.name || p.model || p.id }));
  } catch (_e) {
    return [];
  }
}

/** 当前生效预设 id（global 模式忽略 scope；per-feature 缺 scope 视为全局）。 */
function resolvePresetId(scope?: PhoneApiScopeKey): string {
  const settings = getPhoneSettings();
  if (settings.apiMode === 'per-feature' && scope) return settings.apiScopes[scope] || settings.apiPresetId;
  return settings.apiPresetId;
}

/** 预设 id → API 解析：未选/预设被删 → undefined（generateRaw 走酒馆主 API）。 */
function resolveByPresetId(presetId: string): PhoneApiResolution {
  if (!presetId) return { api: undefined, presetId: '', presetName: '' };
  const preset = listHostPresets().find(p => p.id === presetId);
  if (!preset) return { api: undefined, presetId, presetName: '' };
  return { api: presetToApi(getConfig().customApiPresets.find(p => p.id === presetId)!), presetId, presetName: preset.name };
}

/** 请求生成时解析 custom_api：未选/预设被删 → undefined（generateRaw 走酒馆主 API）。 */
export function resolvePhoneApi(scope?: PhoneApiScopeKey): PhoneApiResolution {
  return resolveByPresetId(resolvePresetId(scope));
}

/**
 * 不夜城生图提示词的文字 API（设置→功能→不夜城「生图 API 单独配置」）：
 * 开关开启且所选预设可解析时用它；否则跟随共用「生图（提示词）」scope——预设被删也一并跟随，
 * 不静默掉到酒馆主 API（与三个 scope 绑定的失效口径不同：那三者是用户显式绑定，这里是可选覆盖）。
 */
export function resolveNightImageApi(): PhoneApiResolution {
  const s = getPhoneSettings();
  if (s.nightImageApi && s.nightImageApiPresetId) {
    const hit = resolveByPresetId(s.nightImageApiPresetId);
    if (hit.api) return hit;
  }
  return resolvePhoneApi('image');
}

/** 请求前闸门：返回错误消息；可用时返回 null（未选预设=走酒馆主 API，恒可用）。 */
export function validatePhoneApi(scope?: PhoneApiScopeKey): string | null {
  const presetId = resolvePresetId(scope);
  if (!presetId) return null;
  let preset: CustomApiPreset | undefined;
  try {
    preset = (getConfig().customApiPresets || []).find(p => p.id === presetId);
  } catch (_e) {
    return null; // 主项目配置不可读：静默走酒馆主 API
  }
  if (!preset) return '小手机绑定的 API 预设已被删除（主项目设置），已回退酒馆主 API。';
  if (!preset.url || !preset.url.trim()) return '小手机绑定的 API 预设缺少 URL，请到主项目设置→API→预设管理中补全。';
  if (!preset.model || !preset.model.trim()) return '小手机绑定的 API 预设缺少模型名，请到主项目设置→API→预设管理中补全。';
  return null;
}

// ═══════════════════════════════════════════════════════════════
// AI 请求失败自动重试（小手机独立设置；复用主项目 core/ai-retry 分类器）
//
// 粒度与 API 分配一致：global 模式看总开关；per-feature 模式看该功能自己的勾选。
// 关闭时 attempts=1（等价于不重试）。
// ═══════════════════════════════════════════════════════════════

/** 该功能当前是否启用自动重试。 */
export function isPhoneAiRetryEnabled(scope?: PhoneApiScopeKey): boolean {
  const s = getPhoneSettings();
  if (s.apiMode === 'per-feature') return !!scope && s.aiRetryScopes?.[scope] === true;
  return s.aiRetryEnabled === true;
}

/** 每次自动重试的进度不再单独发通知：由活动注册表阶段更新 + 灵动岛/统一 notifier 展示。 */

/** 构造 withAiRetry 选项：关闭时 attempts=1（只发一次，不重试）。 */
export function getPhoneAiRetryOptions(scope?: PhoneApiScopeKey): AiRetryOptions {
  if (!isPhoneAiRetryEnabled(scope)) return { attempts: 1 };
  const maxRetries = normalizeAiRetryMax(getPhoneSettings().aiRetryMax);
  return { attempts: maxRetries + 1 };
}

/**
 * 小手机文本 AI 请求的统一重试入口（runPhoneRaw / 生图提示词 / 游戏中心共用）。
 * 调用方在 fn 内自行抛出「已取消」类错误即可中止重试（分类器归为 aborted 立即外抛）。
 * 传入 activityId 时，每次尝试/重试都会更新注册表阶段（统一通知与灵动岛由此驱动）。
 * 成功返回的文本统一过 stripTailSafeBlock（与主项目 withTextAiRetry 同口径）：
 * 默认尾部破限要求模型补 <safe> 无害化段，那不属于任务输出，须在文本出口剥掉防污染下游解析。
 */
export function withPhoneTextAiRetry<T>(
  scope: PhoneApiScopeKey,
  fn: () => Promise<T>,
  opts?: { signal?: AbortSignal; activityId?: string; maxAttempts?: number },
): Promise<T> {
  const retryOpts = getPhoneAiRetryOptions(scope);
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? retryOpts.attempts ?? 1);
  if (opts?.signal) {
    retryOpts.signal = opts.signal;
    // 已取消时不再更新重试阶段——避免超时/终止瞬间发出与实际不符的进度
    const signal = opts.signal;
    const activityId = opts.activityId;
    if (activityId) {
      retryOpts.onRetry = ({ attempt }) => {
        if (signal.aborted) return;
        updatePhoneAiActivity(activityId, {
          phase: 'retrying',
          attempt: Math.min(attempt + 1, maxAttempts),
          maxAttempts,
        });
      };
    }
  } else if (opts?.activityId) {
    const activityId = opts.activityId;
    retryOpts.onRetry = ({ attempt }) => {
      updatePhoneAiActivity(activityId, {
        phase: 'retrying',
        attempt: Math.min(attempt + 1, maxAttempts),
        maxAttempts,
      });
    };
  }
  const activityId = opts?.activityId;
  return withAiRetry(async (attempt) => {
    if (activityId) updatePhoneAiActivity(activityId, { phase: 'requesting', attempt, maxAttempts });
    return fn();
  }, retryOpts).then(result => (
    typeof result === 'string' ? (stripTailSafeBlock(result) as unknown as T) : result
  ));
}
