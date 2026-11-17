// core/ai-tool-shield.ts
// AI 请求工具注入防护与出站消息序列兼容：本插件所有 generateRaw 请求不受宿主「工具调用」机制影响，
// 且按策略在前端出站层规整中段 system/developer 消息（兼容 gpt-load / Gemini / Claude 等网关），
// 同时不动酒馆自身与其他脚本的任何请求。
//
// 背景链（2026-10-07 实锤，合并纪要在使用者机器上空回复的根因）：
//   酒馆助手 generateRaw（custom_api 与宿主路径 alike）内部调 ST≥1.15 原生
//   createGenerationParameters（type 恒 'normal'）→ 当宿主「函数调用」开且
//   custom_prompt_post_processing ∈ {'', merge_tools, semi_tools, strict_tools} 时，
//   ST ToolManager 把宿主已注册的全部工具（含第三方扩展注册的 emit_complete_response_*
//   捕获工具）连同 tool_choice:'auto' 拼进请求，第三方还可能往末条 user 消息追加
//   "Call the `xxx` function exactly once..." 指令。请求参数层无开关可关（CustomApiConfig
//   没有对应字段）；gemini 系中转对 function calling 支持差 → 空 content → 全线解析失败。
//
// 方案：CHAT_COMPLETION_SETTINGS_READY 事件（酒馆助手/ST 在 fetch 前对最终请求体发射，
// 两条路径都有）按「本插件请求指纹」精确拦截，仅对我方请求执行：
//   ① delete tools / tool_choice；② custom_prompt_post_processing 置 ''（继续阻断 ST 后端
//   工具注入与二次处理）；③ 剥末条消息尾部的工具调用指令文本；④ 按绑定预设或宿主映射的
//   策略执行前端侧 normalizeOutboundMessages，将首条对话消息之后的 system/developer 折叠
//   为 user 并合并相邻同角色。
//   指纹 = ordered_prompts[0]（结构头 system 段）宏展开后的前缀（19+ 站点全线满足）；
//   无结构头的请求退化为 custom_api 的 apiurl+model 匹配；两者皆缺 → 不防护（隔离优先，
//   宁可放过不可错杀宿主请求）。
//
// 逃生口：request.allow_host_tools === true 时本次请求跳过防护（未来若某功能真要工具调用）。
// 接线：core/env.ts getTavernHelper() 记忆化代理仅覆盖 generateRaw——全部站点（含台账与小手机）
// 自动受保、零调用点改动。
//
// 另：出站前统一补 ordered_prompts 的酒馆宏展开（core/ai-prompt-macros）。酒馆助手自定义
// 生成路径不展开这些对象项，自定义破限里的 {{roll}}/{{setvar}}/{{getvar}}/{{//}} 会原样发出。
// 展开必须在指纹之前：指纹要用展开后的首段比对事件负载，且避免 {{roll}} 被再掷一次。

import { expandOrderedPromptMacros } from './ai-prompt-macros';
import type { CustomApiPostProcessingMode } from './constants';

/** 事件负载里的消息数组形态：ST 原生路径 data.messages；酒馆助手 custom 路径同为 messages。 */
function extractMessages(data: any): any[] {
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.prompt)) return data.prompt;
  return [];
}

/** 登记 custom_api 对象对应的前端消息后处理策略（三仓共有零额外依赖）。 */
const _customApiPostModeMap = new WeakMap<object, CustomApiPostProcessingMode>();

export function tagCustomApiPostProcessing<T extends object>(
  api: T,
  mode?: CustomApiPostProcessingMode,
): T {
  if (api && typeof api === 'object' && mode) {
    _customApiPostModeMap.set(api, mode);
  }
  return api;
}

export function getCustomApiPostProcessingMode(api: unknown): CustomApiPostProcessingMode | undefined {
  if (!api || typeof api !== 'object') return undefined;
  return _customApiPostModeMap.get(api);
}

/** 将 SillyTavern 宿主 custom_prompt_post_processing 值映射为前端策略。 */
export function mapTavernPromptPostProcessing(raw: unknown): CustomApiPostProcessingMode {
  switch (raw) {
    case 'semi':
    case 'semi_tools':
      return 'semi';
    case 'strict':
    case 'strict_tools':
      return 'strict';
    case 'merge':
    case 'merge_tools':
      return 'merge';
    case 'single':
      return 'single';
    default:
      return 'none';
  }
}

function isSystemLikeRole(role: unknown): boolean {
  return role === 'system' || role === 'developer';
}

function hasSpecialPayload(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (Array.isArray(msg.content)) return true;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  if (typeof msg.tool_call_id === 'string' && msg.tool_call_id.length > 0) return true;
  return false;
}

function joinMessageText(a: string, b: string): string {
  if (a && b) return a + '\n\n' + b;
  return a || b;
}

function mergeConsecutiveSameRole(messages: any[]): any[] {
  const out: any[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') {
      out.push(raw);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev &&
      typeof prev === 'object' &&
      prev.role === raw.role &&
      prev.role !== 'tool' &&
      !hasSpecialPayload(prev) &&
      !hasSpecialPayload(raw) &&
      typeof prev.content === 'string' &&
      typeof raw.content === 'string'
    ) {
      out[out.length - 1] = {
        ...prev,
        content: joinMessageText(prev.content, raw.content),
      };
    } else {
      out.push({ ...raw });
    }
  }
  return out;
}

/**
 * 纯函数：按策略规整出站消息序列。
 * - none：原样返回（不克隆）
 * - merge：保留原始角色，合并相邻同角色纯文本消息
 * - semi：首条非系统（非 system/developer）消息之后出现的 system/developer 原地转为 user，并合并全序列相邻同角色
 * - strict：在 semi 基础上保证前置 system 之后第一条对话消息为 user（缺失则插入 '[Start a new chat]'）
 * - single：全部纯文本消息合并为单条 user（含多模态/tool_calls 时安全降级为 semi）
 */
export function normalizeOutboundMessages(
  messages: any[],
  mode: CustomApiPostProcessingMode,
): any[] {
  if (!Array.isArray(messages) || messages.length === 0 || mode === 'none') {
    return messages;
  }

  if (mode === 'merge') {
    return mergeConsecutiveSameRole(messages);
  }

  if (mode === 'single') {
    const canFlattenAll = messages.every(
      m => m && typeof m === 'object' && !hasSpecialPayload(m) && typeof m.content === 'string',
    );
    if (canFlattenAll) {
      const parts = messages.map(m => m.content).filter((s: string) => s.length > 0);
      return [{ role: 'user', content: parts.join('\n\n') }];
    }
    // 含多模态或工具调用时安全退化为 semi
    mode = 'semi';
  }

  let seenConversation = false;
  const normalizedRoles = messages.map(raw => {
    if (!raw || typeof raw !== 'object') return raw;
    const isSys = isSystemLikeRole(raw.role);
    if (!isSys) {
      seenConversation = true;
      return { ...raw };
    }
    if (seenConversation) {
      return { ...raw, role: 'user' };
    }
    return { ...raw };
  });

  if (mode === 'strict') {
    let firstNonSystemIdx = 0;
    while (
      firstNonSystemIdx < normalizedRoles.length &&
      normalizedRoles[firstNonSystemIdx] &&
      isSystemLikeRole(normalizedRoles[firstNonSystemIdx].role)
    ) {
      firstNonSystemIdx++;
    }
    if (
      firstNonSystemIdx >= normalizedRoles.length ||
      normalizedRoles[firstNonSystemIdx]?.role !== 'user'
    ) {
      normalizedRoles.splice(firstNonSystemIdx, 0, { role: 'user', content: '[Start a new chat]' });
    }
  }

  return mergeConsecutiveSameRole(normalizedRoles);
}

/** 请求指纹：head = 结构头前缀（宏已展开）；apiurl+model = 无结构头时的退化匹配。 */
export interface RequestFingerprint {
  head?: string;
  apiurl?: string;
  model?: string;
}

const HEAD_PREFIX_LEN = 64;

/** URL 归一：去空白、去尾斜杠（酒馆助手出站侧 reverse_proxy 亦为去尾斜杠形态）。 */
function normalizeUrl(u: unknown): string {
  return typeof u === 'string' ? u.replace(/\s+/g, '').replace(/\/+$/, '') : '';
}

/** 从 generateRaw 请求配置提取指纹；无法安全识别（无结构头且无 custom_api）返回 null。 */
export function buildRequestFingerprint(
  request: any,
  substitudeMacros?: (text: string) => string,
): RequestFingerprint | null {
  const fp: RequestFingerprint = {};
  const first = Array.isArray(request?.ordered_prompts) ? request.ordered_prompts[0] : null;
  if (first && typeof first === 'object' && typeof first.content === 'string' && first.content) {
    let content: string = first.content;
    if (typeof substitudeMacros === 'function') {
      try {
        content = substitudeMacros(content);
      } catch (_e) {
        /* 展宏失败用原文（与请求侧 toOrderedPrompt 行为差异仅致指纹不命中，不误伤） */
      }
    }
    if (content) fp.head = content.slice(0, HEAD_PREFIX_LEN);
  }
  if (typeof request?.custom_api?.apiurl === 'string' && request.custom_api.apiurl) {
    fp.apiurl = request.custom_api.apiurl;
  }
  if (typeof request?.custom_api?.model === 'string' && request.custom_api.model) {
    fp.model = request.custom_api.model;
  }
  return fp.head || (fp.apiurl && fp.model) ? fp : null;
}

/** 判定事件负载是否为本插件请求（隔离关键：非我方一律不动）。 */
export function isOurGenerateData(data: any, fp: RequestFingerprint | null): boolean {
  if (!fp || !data || typeof data !== 'object') return false;
  if (fp.head) {
    const first = extractMessages(data)[0];
    return typeof first?.content === 'string' && first.content.startsWith(fp.head);
  }
  if (fp.apiurl && fp.model) {
    const targetUrl = normalizeUrl(data.reverse_proxy || data.custom_url);
    return targetUrl === normalizeUrl(fp.apiurl) && data.model === fp.model;
  }
  return false;
}

/** 末条消息尾部的第三方工具调用指令（如 emit_complete_response_* 追加的调用要求）。 */
const TOOL_CALL_INSTRUCTION_TAIL = /\n+Call the `[A-Za-z0-9_.-]{6,}` function exactly once\b[\s\S]*$/;

export interface OutboundIsolationOptions {
  /** 是否在指纹命中后剥离非我方注入（stray assistant 伪插话 + 第三方 extensionPrompts）；默认 false。 */
  stripForeignInjections?: boolean;
  /** ordered_prompts 中我方合法携带的 assistant 正文集合（trim 后）。 */
  expectedAssistantContents?: ReadonlySet<string>;
  /** 请求是否显式携带了非零历史的 chat_history（为 true 时保留历史 assistant）。 */
  allowHistoryAssistant?: boolean;
  /** 当前请求自身的 user_input 正文（防止误伤玩家剧情里恰好出现的文字）。 */
  rawUserInput?: string;
  /** 从 SillyTavern.extensionPrompts 读取到的第三方常驻注入正文集合（trim 后）。 */
  foreignExtensionValues?: ReadonlySet<string>;
}

export interface ScrubResult {
  touched: boolean;
  removedTools: string[];
  strippedInstruction: boolean;
  removedForeignInjections: number;
}

let _foreignStripProvider: (() => boolean) | null = null;

/** 注册运行期「出站剥离非我方注入」开关读取器（由 config-store 注册，避免循环依赖）。 */
export function setShieldForeignStripProvider(fn: (() => boolean) | null): void {
  _foreignStripProvider = fn;
}

function isForeignStripEnabled(): boolean {
  if (!_foreignStripProvider) return true;
  try {
    return _foreignStripProvider() !== false;
  } catch (_e) {
    return true;
  }
}

const OUR_EXTENSION_PROMPT_PREFIXES = ['ub_', 'sl_', 'ubp_', 'unified_statusbar', 'sese_ledger', 'ubs_phone'];

function collectExpectedAssistantContents(request: any): Set<string> {
  const out = new Set<string>();
  const list = request?.ordered_prompts;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (item && typeof item === 'object' && item.role === 'assistant' && typeof item.content === 'string') {
      const trimmed = item.content.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  return out;
}

function collectForeignExtensionValues(): Set<string> {
  const out = new Set<string>();
  try {
    const extPrompts = detectSillyTavernContext()?.extensionPrompts;
    if (!extPrompts || typeof extPrompts !== 'object') return out;
    for (const [key, entry] of Object.entries<any>(extPrompts)) {
      if (OUR_EXTENSION_PROMPT_PREFIXES.some(p => key.startsWith(p))) continue;
      const val = typeof entry === 'string' ? entry.trim() : typeof entry?.value === 'string' ? entry.value.trim() : '';
      if (val.length >= 12) out.add(val);
    }
  } catch (_e) {
    /* ignore */
  }
  return out;
}

function filterForeignMessages(
  messages: any[],
  opts: OutboundIsolationOptions,
): { messages: any[]; removed: number } {
  let removed = 0;
  const expectedAssistants = opts.expectedAssistantContents;
  const foreignSet = opts.foreignExtensionValues;
  const rawUserInputTrimmed = typeof opts.rawUserInput === 'string' ? opts.rawUserInput.trim() : '';
  const out: any[] = [];
  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (!msg || typeof msg !== 'object') {
      out.push(msg);
      continue;
    }
    if (
      msg.role === 'assistant' &&
      !opts.allowHistoryAssistant &&
      !hasSpecialPayload(msg) &&
      typeof msg.content === 'string'
    ) {
      const trimmed = msg.content.trim();
      if (!expectedAssistants?.has(trimmed)) {
        removed += 1;
        continue;
      }
    }
    if (foreignSet && foreignSet.size > 0 && typeof msg.content === 'string' && !hasSpecialPayload(msg)) {
      const trimmed = msg.content.trim();
      if (trimmed && (!rawUserInputTrimmed || trimmed !== rawUserInputTrimmed)) {
        if (foreignSet.has(trimmed)) {
          removed += 1;
          continue;
        }
        // ST 部分扩展注入会被并入 system 消息段：仅对长度 >= 32 且非首条/非 user_input 的整段匹配做移除
        if (idx > 0 && msg.role === 'system') {
          let updated = msg.content;
          let matchedInBlock = false;
          for (const foreign of foreignSet) {
            if (foreign.length >= 32 && updated.includes(foreign)) {
              updated = updated.split(foreign).join('').replace(/\n{3,}/g, '\n\n').trim();
              matchedInBlock = true;
            }
          }
          if (matchedInBlock) {
            removed += 1;
            if (!updated) continue;
            out.push({ ...msg, content: updated });
            continue;
          }
        }
      }
    }
    out.push(msg);
  }
  return { messages: out, removed };
}

/**
 * 对事件负载执行剥离与消息序列规整（仅当指纹命中）。纯逻辑、原地修改 data：
 *   delete tools/tool_choice；custom_prompt_post_processing 置 ''；
 *   可选剥离非我方注入（stray assistant 伪插话 + 第三方 extensionPrompts）；
 *   剥末条消息尾部工具指令；按 postMode 规整 data.messages / data.prompt。
 * 未命中（宿主/他脚本请求）原样返回 {touched:false}，一个字节都不改。
 */
export function scrubGenerateData(
  data: any,
  fp: RequestFingerprint | null,
  postMode: CustomApiPostProcessingMode = 'none',
  isolationOpts?: OutboundIsolationOptions,
): ScrubResult {
  if (!isOurGenerateData(data, fp)) {
    return { touched: false, removedTools: [], strippedInstruction: false, removedForeignInjections: 0 };
  }
  const removedTools: string[] = [];
  if (Array.isArray(data.tools)) {
    for (const t of data.tools) removedTools.push(String(t?.function?.name ?? t?.name ?? 'unknown'));
    delete data.tools;
  }
  if ('tool_choice' in data) delete data.tool_choice;
  data.custom_prompt_post_processing = '';
  let removedForeignInjections = 0;
  if (isolationOpts?.stripForeignInjections) {
    if (Array.isArray(data.messages)) {
      const res = filterForeignMessages(data.messages, isolationOpts);
      data.messages = res.messages;
      removedForeignInjections = res.removed;
    } else if (Array.isArray(data.prompt)) {
      const res = filterForeignMessages(data.prompt, isolationOpts);
      data.prompt = res.messages;
      removedForeignInjections = res.removed;
    }
  }
  let strippedInstruction = false;
  const messages = extractMessages(data);
  const last = messages[messages.length - 1];
  if (last && typeof last.content === 'string' && TOOL_CALL_INSTRUCTION_TAIL.test(last.content)) {
    last.content = last.content.replace(TOOL_CALL_INSTRUCTION_TAIL, '');
    strippedInstruction = true;
  }
  if (postMode !== 'none') {
    if (Array.isArray(data.messages)) {
      data.messages = normalizeOutboundMessages(data.messages, postMode);
    } else if (Array.isArray(data.prompt)) {
      data.prompt = normalizeOutboundMessages(data.prompt, postMode);
    }
  }
  return { touched: true, removedTools, strippedInstruction, removedForeignInjections };
}

/** 事件总线（生产环境自动探测；测试可注入桩）。导入期不触碰 window。 */
export interface ShieldEventBus {
  eventSource: { on(type: string, fn: (...args: any[]) => void): unknown; removeListener(type: string, fn: (...args: any[]) => void): unknown };
  type: string;
}

function detectSillyTavernContext(): any {
  if (typeof window === 'undefined') return null;
  try {
    const rawSt: any =
      (window as any).SillyTavern ||
      (window.parent as any)?.SillyTavern ||
      (window as any).TavernHelper?.SillyTavern ||
      (window.parent as any)?.TavernHelper?.SillyTavern;
    return typeof rawSt?.getContext === 'function' ? rawSt.getContext() : rawSt;
  } catch (_e) {
    return null;
  }
}

export function detectShieldEventBus(): ShieldEventBus | null {
  try {
    const st = detectSillyTavernContext();
    const eventSource = st?.eventSource;
    const type: string | undefined = st?.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
    if (eventSource && typeof eventSource.on === 'function' && typeof eventSource.removeListener === 'function' && type) {
      return { eventSource, type };
    }
  } catch (_e) {
    /* 跨源受限 → 无总线 → 防护缺位但功能不受阻 */
  }
  return null;
}

export function resolveShieldPostProcessingMode(
  request: any,
  hostPostSetting?: () => unknown,
): CustomApiPostProcessingMode {
  if (request && typeof request === 'object' && request.custom_api) {
    return getCustomApiPostProcessingMode(request.custom_api) ?? 'semi';
  }
  try {
    const raw = typeof hostPostSetting === 'function'
      ? hostPostSetting()
      : detectSillyTavernContext()?.chatCompletionSettings?.custom_prompt_post_processing;
    return mapTavernPromptPostProcessing(raw);
  } catch (_e) {
    return 'none';
  }
}

/**
 * 生成带防护的 generateRaw 包装。arm → 调用 → finally disarm；
 * 指纹缺失 / 总线缺失 / allow_host_tools 请求 → 原样透传（不注册监听）。
 */
export function createShieldedGenerateRaw(
  rawFn: (request: any) => Promise<any>,
  host: { substitudeMacros?: (text: string) => string },
  busOverride?: ShieldEventBus | null,
  hostPostSetting?: () => unknown,
): (request: any) => Promise<any> {
  return async function shieldedGenerateRaw(request: any): Promise<any> {
    // 统一出口补宏展开（无候选宏时原样返回同一 request，零克隆/零宿主调用）。
    const prepared = expandOrderedPromptMacros(request, host?.substitudeMacros);
    if (prepared?.allow_host_tools === true) return rawFn(prepared);
    const bus = busOverride !== undefined ? busOverride : detectShieldEventBus();
    // prepared 已在上一行尝试展开，这里不再传 substitudeMacros：避免 {{roll}}/{{setvar}} 二次执行。
    const fp = buildRequestFingerprint(prepared);
    if (!bus || !fp) return rawFn(prepared);
    const postMode = resolveShieldPostProcessingMode(prepared, hostPostSetting);
    const stripForeign = isForeignStripEnabled();
    const isolationOpts: OutboundIsolationOptions | undefined = stripForeign
      ? {
          stripForeignInjections: true,
          expectedAssistantContents: collectExpectedAssistantContents(prepared),
          allowHistoryAssistant: Array.isArray(prepared?.ordered_prompts)
            && prepared.ordered_prompts.includes('chat_history')
            && Number(prepared?.max_chat_history) > 0,
          rawUserInput: typeof prepared?.user_input === 'string' ? prepared.user_input : undefined,
          foreignExtensionValues: collectForeignExtensionValues(),
        }
      : undefined;
    const handler = (data: any) => {
      try {
        const result = scrubGenerateData(data, fp, postMode, isolationOpts);
        if (result.removedTools.length > 0 || result.strippedInstruction) {
          console.log('[统一状态栏] 已剥离宿主工具注入（' + result.removedTools.join('、') + '）');
        }
        if (result.removedForeignInjections > 0) {
          console.log(`[统一状态栏] 已净化出站残留非我方注入（${result.removedForeignInjections} 条）`);
        }
      } catch (_e) {
        /* 剥离失败不阻断请求 */
      }
    };
    bus.eventSource.on(bus.type, handler);
    try {
      return await rawFn(prepared);
    } finally {
      try {
        bus.eventSource.removeListener(bus.type, handler);
      } catch (_e) {
        /* 移除失败仅残留一次性无效监听（handler 内部有指纹闸） */
      }
    }
  };
}
