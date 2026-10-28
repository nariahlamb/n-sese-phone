// —— 柏宝绘（ST-BaiBai-Image）生图桥 ——
// 与内置直连、智慧姬并列的第三条生图执行通道：生图整体转交酒馆里的柏宝绘插件执行
//（后端/模型/画师串/质量词/负面词/尺寸/并发闸门/限流退避全用柏宝绘「渠道」页里配的那套），
// 本项目只提供生图提示词。经其公开接口 globalThis.STBaiBaiImage（apiVersion 1，见插件 PUBLIC_API.md）：
//   api.generate({ prompt, nl?, negative?, characters?, size?, seed?, save?, character? }, { signal?, onProgress? })
//   → { dataUrl, format, path, seed, backend, charactersApplied }
// 与事件总线式的文本契约通道不同，这是直调式结构化 API：多角色走 characters 数组、
// 自然语言走独立 nl 字段，不存在「契约标签被对端解析器吃掉」的整类事故。
// 错误按 error.code 分支（对端明言中文文案会随版本变、跨 bundle instanceof 失效，禁匹配 message）。
import { ImageGenError } from './image-gen-error';

/** 柏宝绘通道判定：存储位恒为 apiFormat='openai' + openai.baibai=true（与智慧姬通道同款钉法，互斥）。 */
export function isBaiBaiChannel(provider: { apiFormat?: unknown; openai?: { baibai?: unknown } | null } | null | undefined): boolean {
  return !!provider && provider.apiFormat === 'openai' && provider.openai?.baibai === true;
}

// —— 公开接口的最小结构声明（只声明本项目用到的成员；字段含义以插件 src/public/types.ts 为准） ——

/** 多角色提示里的一位（NAI 4.5/V5 的 Character Prompt）。name 仅用于标识，不进提示词。 */
export interface BaiBaiCharacterPrompt {
  name: string;
  tag: string;
  nl?: string;
}

/** 生图请求：prompt 必填（正向 danbooru 短 tag）；negative 只对 ComfyUI 生效（NAI 负面取其渠道配置）；
 *  size 是画幅方向（像素取其渠道配置，渠道锁定方向时以锁定为准）；seed 省略 = 按其用户设置。 */
export interface BaiBaiGenerateRequest {
  prompt: string;
  negative?: string;
  characters?: BaiBaiCharacterPrompt[];
  size?: 'portrait' | 'landscape';
  seed?: number;
  /** 落盘归档进柏宝绘图库的分组名（其默认 true 落盘；本通道固定归到自己的分组，不混进角色目录）。 */
  character?: string;
}

export interface BaiBaiGenerateResult {
  dataUrl: string;
  format: string;
  path: string | null;
  seed: number;
  backend: string;
  charactersApplied: boolean;
}

export interface BaiBaiBackendStatus {
  backend: string;
  configured: boolean;
  model: string;
  supportsCharacters: boolean;
  reason: string;
}

export interface BaiBaiApi {
  apiVersion: number;
  pluginVersion?: string;
  getBackendStatus(): BaiBaiBackendStatus;
  generate(request: BaiBaiGenerateRequest, options?: { signal?: AbortSignal }): Promise<BaiBaiGenerateResult>;
}

/** 柏宝绘公开接口对象（宿主 window / 父 window 两路候选；未装/未就绪为 null）。 */
export function getBaiBaiApi(): BaiBaiApi | null {
  const candidates: any[] = [];
  try {
    candidates.push((window as any).STBaiBaiImage);
    candidates.push((window.parent as any)?.STBaiBaiImage);
  } catch (_e) { /* cross-origin 或 node 测试环境 */ }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && typeof candidate.generate === 'function') {
      return candidate as BaiBaiApi;
    }
  }
  return null;
}

/** 柏宝绘后端状态（未装插件返回 null；调用方据此给安装指引）。 */
export function baibaiBackendStatus(): BaiBaiBackendStatus | null {
  const api = getBaiBaiApi();
  if (!api || typeof api.getBackendStatus !== 'function') return null;
  try {
    return api.getBackendStatus();
  } catch (_e) {
    return null;
  }
}

/** 柏宝绘通道是否可用（插件在位且后端已配齐；切通道时的 Toast 判据，同智慧姬 chatu8HasGenerator 定位）。 */
export function baibaiPluginReady(): boolean {
  const status = baibaiBackendStatus();
  return !!status && status.configured === true;
}

/** 柏宝绘后端显示名（面板注记/档案 model 用）。 */
export function baibaiBackendLabel(backend: string): string {
  return backend === 'nai' ? 'NovelAI' : backend === 'comfyui' ? 'ComfyUI' : backend || '未知';
}

/** 设置面板/Toast 用的状态注记（后端/就绪/模型/多角色支持；未装时给安装指引）。 */
export function baibaiStatusNote(): string {
  const status = baibaiBackendStatus();
  if (!status) return '（没找到柏宝绘插件（ST-BaiBai-Image）：请在酒馆「扩展 → 安装扩展」装好，再到其「渠道」页配置出图后端）';
  return '（柏宝绘当前后端：' + baibaiBackendLabel(status.backend)
    + '；' + (status.configured ? '已就绪' : '未就绪——' + status.reason)
    + '；模型：' + (status.model || '空')
    + '；' + (status.supportsCharacters ? '支持多角色分角色提示（NAI 4.5/V5）' : '当前后端不支持分角色提示（多角色自动改用单段拼合）') + '）';
}

/** 面板提示词格式行的完整说明（提示词格式由全局三件套决定；柏宝绘会在前后拼它的画师串/质量词）。 */
export function baibaiFormatNote(): string {
  const status = baibaiBackendStatus();
  const natural = status && status.backend === 'comfyui'
    ? '（ComfyUI 后端若用自然语言工作流，可在「生图 AI 请求提示词」板块把提示词模式改为自然语言）'
    : '';
  return '当前提示词按「全局三件套」生成；柏宝绘吃 danbooru 标签，会在标签最前拼你选的画师串、最后拼质量词（自然语言描述不发送）' + natural;
}

/** 柏宝绘接口与全局三件套的对齐建议（只提示、不代改；与智慧姬 chatu8FormatHint 同定位）。 */
export function baibaiFormatHint(format: { promptComposeMode: string }): string {
  const status = baibaiBackendStatus();
  if (!status) return '柏宝绘插件还没装好（或没暴露公开接口）：装好并在其「渠道」页配置出图后端后，本通道才能生图';
  if (format.promptComposeMode !== 'tags' && status.backend !== 'comfyui') {
    return '柏宝绘的提示词主字段吃 danbooru 标签：建议把「提示词模式」改为标签（自然语言段落柏宝绘由它自己的 AI 另写，本通道不代传）';
  }
  return '';
}

/** 宽高比 → 画幅方向（柏宝绘只收方向，像素取其渠道配置；'auto'/1:1/解析失败 = 不传，用其缺省竖屏）。 */
export function baibaiOrientationFromAspectRatio(aspectRatio: unknown): 'portrait' | 'landscape' | undefined {
  const text = String(aspectRatio || '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w === h) return undefined;
  return w > h ? 'landscape' : 'portrait';
}

/** 多角色字段清洗：换行/制表折成逗号（柏宝绘侧只 trim，不清洗换行；tag 流里换行属脏输入）。 */
function _baibaiTagField(text: unknown): string {
  return String(text == null ? '' : text)
    .replace(/[\r\n\t]+/g, ', ')
    .replace(/(,\s*)+/g, ', ')
    .replace(/^[,\s]+|[,\s]+$/g, '');
}

/**
 * 本项目多角色结构 → 柏宝绘 characters 数组。
 * - tag ← 各角色描述（我们的 ch.prompt 即该角色的外貌+着装标签）；
 * - name 仅用于标识（对端不进提示词），合成「角色N」——本项目管线没有稳定的角色名字段；
 * - uc 丢弃（柏宝绘的角色负面 char_captions 恒空串，其负面词由渠道配置统一管）；
 * - centers 丢弃（其公开 API 不收坐标，char centers 固定居中）。
 * name 或 tag 为空整项被对端丢弃，故本地先滤掉空 tag 项。
 */
export function buildBaiBaiCharacters(
  characters: Array<{ prompt?: unknown }>,
): BaiBaiCharacterPrompt[] {
  const list = Array.isArray(characters) ? characters : [];
  const out: BaiBaiCharacterPrompt[] = [];
  for (let i = 0; i < list.length; i++) {
    const tag = _baibaiTagField(list[i] && list[i].prompt);
    if (!tag) continue;
    out.push({ name: '角色' + (out.length + 1), tag });
  }
  return out;
}

function _baibaiAbortError(): Error {
  const error = new Error('图片生成任务已取消');
  error.name = 'AbortError';
  return error;
}

// —— 契约文本净化 ——

/**
 * 契约标签净化：本项目正文插图（与小手机 story 管线）的提示词格式就是
 * 「Scene Composition: …; Character N Prompt: …, |centers:x; Character N UC: …;」契约文本，
 * 柏宝绘是结构化 API（场景进 prompt、角色进 characters 数组），标签行名/行尾分号/坐标残片
 * 对它只是会被当字面 tag 画进图里的垃圾。有标签一律去标签留正文：Character UC 整行丢弃
 *（与 flattenStoryMulti 对非 NAI 的口径一致）、分号还原成逗号、|centers 清掉；无标签逐字节原样。
 */
export function sanitizeBaiBaiPromptText(promptText: string): string {
  const text = String(promptText || '');
  if (!/Scene Composition\s*:|Character\s+\d+\s+Prompt\s*:/.test(text)) return promptText;
  const stripped = text
    .replace(/Character\s+\d+\s+UC\s*:[^;]*;?/gi, '')
    .replace(/Character\s+\d+\s+Prompt\s*:/gi, '')
    .replace(/Scene Composition\s*:/g, '')
    .replace(/\|\s*centers\s*:[^\s,;]*/gi, '')
    .replace(/;/g, ', ');
  const cleaned = stripped
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(?:,\s*)+/g, ', ')
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
    .trim();
  return cleaned || promptText; // 退化输入（连正文都没有）保留原样
}

/**
 * 档案提示词 → 柏宝绘重放形态（场景文本 + 能否配档案 characters 结构化重放）。
 * 档案可能来自任一通道：NAI / 柏宝绘结构化档案的 prompt 本就是场景文本（structured 配 characters）；
 * 事件总线通道旧档案是契约文本（prompt 含 'Scene Composition:…;'、角色另存 characters）——抽取 Scene
 * 字段配 characters 结构化重放；契约残缺则整段净化扁平、不带 characters（角色描述已并入文本，再发必重复）。
 */
export function baibaiReplayPrompt(promptText: string): { scene: string; structured: boolean } {
  const text = String(promptText || '');
  const hasLabels = /Scene Composition\s*:|Character\s+\d+\s+Prompt\s*:/.test(text);
  if (!hasLabels) return { scene: text, structured: true };
  if (/Scene Composition\s*:[^;]+;/.test(text)) {
    const match = /Scene Composition\s*:([^;]+);/.exec(text);
    const scene = match ? _baibaiTagField(match[1]) : '';
    if (scene) return { scene, structured: true };
  }
  return { scene: sanitizeBaiBaiPromptText(text), structured: false };
}

/** 柏宝绘错误 → 本项目 ImageGenError（按 code 分支，禁匹配中文 message——对端明言文案会变）。 */
function _baibaiError(error: unknown): Error {
  if (error && typeof error === 'object' && (error as any).name === 'AbortError') return error as Error;
  const code = String((error as any)?.code || '');
  const message = String((error as any)?.message || error || '未知错误');
  if (code === 'aborted') return _baibaiAbortError();
  if (code === 'not_configured') {
    return new ImageGenError('柏宝绘未就绪：' + message + '——请到柏宝绘的「渠道」页配置出图后端（本地 ComfyUI 或 NovelAI 账号）');
  }
  if (code === 'rate_limited') {
    return new ImageGenError('柏宝绘被限流：' + message + '（其自动退避重试已用尽，稍后再试）');
  }
  if (code === 'invalid_args') {
    return new ImageGenError('柏宝绘拒绝了请求参数：' + message);
  }
  return new ImageGenError('柏宝绘生图失败：' + message);
}

/**
 * 经柏宝绘生图：直调其公开 generate（并发闸门/限流退避/落盘归档都在其对端内部，刻意不绕过）。
 * 返回其对端结果（含实际 seed 与 charactersApplied）；抛 ImageGenError（含可行动指引），取消抛 AbortError。
 * 不设本地超时：NAI 排队 + 限流退避可能远超常规时长，对端有自己的生命周期与错误上报，本地硬超时会
 * 杀掉合法排队中的任务；取消走 AbortSignal（调用方已有的机制）。
 */
export async function generateImageViaBaiBai(
  request: BaiBaiGenerateRequest,
  signal?: AbortSignal,
): Promise<BaiBaiGenerateResult> {
  const api = getBaiBaiApi();
  if (!api) {
    throw new ImageGenError('没找到柏宝绘插件（ST-BaiBai-Image）：请在酒馆「扩展 → 安装扩展」里装好，再到其「渠道」页配置出图后端');
  }
  if (api.apiVersion !== 1) {
    throw new ImageGenError('柏宝绘公开接口版本不匹配（apiVersion=' + String(api.apiVersion) + '）：请更新柏宝绘插件后再试');
  }
  if (signal?.aborted) throw _baibaiAbortError();
  try {
    return await api.generate(request, signal ? { signal } : undefined);
  } catch (error) {
    throw _baibaiError(error);
  }
}
