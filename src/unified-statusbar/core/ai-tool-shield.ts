// core/ai-tool-shield.ts
// AI 请求工具注入防护：本插件所有 generateRaw 请求不受宿主「工具调用」机制影响，
// 且不动酒馆自身与其他脚本的任何请求。
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
//   ① delete tools / tool_choice；② custom_prompt_post_processing 置 ''（我方管线自控
//   消息结构，不做服务端消息合并）；③ 剥末条消息尾部的工具调用指令文本。
//   指纹 = ordered_prompts[0]（结构头 system 段）宏展开后的前缀（19+ 站点全线满足）；
//   无结构头的请求退化为 custom_api 的 apiurl+model 匹配；两者皆缺 → 不防护（隔离优先，
//   宁可放过不可错杀宿主请求）。
//
// 逃生口：request.allow_host_tools === true 时本次请求跳过防护（未来若某功能真要工具调用）。
// 接线：core/env.ts getTavernHelper() 记忆化代理仅覆盖 generateRaw——全部站点（含小手机，
// 其 host-env re-export 本模块）自动受保、零调用点改动。
//
// 另：出站前统一补 ordered_prompts 的酒馆宏展开（core/ai-prompt-macros）。酒馆助手自定义
// 生成路径不展开这些对象项，自定义破限里的 {{roll}}/{{setvar}}/{{getvar}}/{{//}} 会原样发出。
// 展开必须在指纹之前：指纹要用展开后的首段比对事件负载，且避免 {{roll}} 被再掷一次。

import { expandOrderedPromptMacros } from './ai-prompt-macros';

/** 事件负载里的消息数组形态：ST 原生路径 data.messages；酒馆助手 custom 路径同为 messages。 */
function extractMessages(data: any): any[] {
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.prompt)) return data.prompt;
  return [];
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
    return normalizeUrl(data.reverse_proxy) === normalizeUrl(fp.apiurl) && data.model === fp.model;
  }
  return false;
}

/** 末条消息尾部的第三方工具调用指令（如 emit_complete_response_* 追加的调用要求）。 */
const TOOL_CALL_INSTRUCTION_TAIL = /\n+Call the `[A-Za-z0-9_.-]{6,}` function exactly once\b[\s\S]*$/;

export interface ScrubResult {
  touched: boolean;
  removedTools: string[];
  strippedInstruction: boolean;
}

/**
 * 对事件负载执行剥离（仅当指纹命中）。纯逻辑、原地修改 data：
 *   delete tools/tool_choice；custom_prompt_post_processing 置 ''；剥末条消息尾部工具指令。
 * 未命中（宿主/他脚本请求）原样返回 {touched:false}，一个字节都不改。
 */
export function scrubGenerateData(data: any, fp: RequestFingerprint | null): ScrubResult {
  if (!isOurGenerateData(data, fp)) return { touched: false, removedTools: [], strippedInstruction: false };
  const removedTools: string[] = [];
  if (Array.isArray(data.tools)) {
    for (const t of data.tools) removedTools.push(String(t?.function?.name ?? t?.name ?? 'unknown'));
    delete data.tools;
  }
  if ('tool_choice' in data) delete data.tool_choice;
  data.custom_prompt_post_processing = '';
  let strippedInstruction = false;
  const messages = extractMessages(data);
  const last = messages[messages.length - 1];
  if (last && typeof last.content === 'string' && TOOL_CALL_INSTRUCTION_TAIL.test(last.content)) {
    last.content = last.content.replace(TOOL_CALL_INSTRUCTION_TAIL, '');
    strippedInstruction = true;
  }
  return { touched: true, removedTools, strippedInstruction };
}

/** 事件总线（生产环境自动探测；测试可注入桩）。导入期不触碰 window。 */
export interface ShieldEventBus {
  eventSource: { on(type: string, fn: (...args: any[]) => void): unknown; removeListener(type: string, fn: (...args: any[]) => void): unknown };
  type: string;
}

export function detectShieldEventBus(): ShieldEventBus | null {
  if (typeof window === 'undefined') return null;
  try {
    const rawSt: any =
      (window as any).SillyTavern ||
      (window.parent as any)?.SillyTavern ||
      (window as any).TavernHelper?.SillyTavern ||
      (window.parent as any)?.TavernHelper?.SillyTavern;
    const st: any = typeof rawSt?.getContext === 'function' ? rawSt.getContext() : rawSt;
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

/**
 * 生成带防护的 generateRaw 包装。arm → 调用 → finally disarm；
 * 指纹缺失 / 总线缺失 / allow_host_tools 请求 → 原样透传（不注册监听）。
 */
export function createShieldedGenerateRaw(
  rawFn: (request: any) => Promise<any>,
  host: { substitudeMacros?: (text: string) => string },
  busOverride?: ShieldEventBus | null,
): (request: any) => Promise<any> {
  return async function shieldedGenerateRaw(request: any): Promise<any> {
    // 统一出口补宏展开（无候选宏时原样返回同一 request，零克隆/零宿主调用）。
    const prepared = expandOrderedPromptMacros(request, host?.substitudeMacros);
    if (prepared?.allow_host_tools === true) return rawFn(prepared);
    const bus = busOverride !== undefined ? busOverride : detectShieldEventBus();
    // prepared 已在上一行尝试展开，这里不再传 substitudeMacros：避免 {{roll}}/{{setvar}} 二次执行。
    const fp = buildRequestFingerprint(prepared);
    if (!bus || !fp) return rawFn(prepared);
    const handler = (data: any) => {
      try {
        const result = scrubGenerateData(data, fp);
        if (result.removedTools.length > 0 || result.strippedInstruction) {
          console.log('[统一状态栏] 已剥离宿主工具注入（' + result.removedTools.join('、') + '）');
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
