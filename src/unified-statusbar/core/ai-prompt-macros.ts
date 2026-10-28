// core/ai-prompt-macros.ts
// 出站提示词宏展开（酒馆宏语法）：generateRaw 的 ordered_prompts 对象项不会被宿主预处理。
// 证据：酒馆助手 handleCustomPath 对 order 里的 {role,content} 直接 Message.createAsync，
// 不走 substituteParams；只有 user_input、预设路径、扩展注入会展开。自定义破限 / 任务段于是
// 把 {{roll}}、{{setvar}}、{{getvar}}、{{// 注释}} 原样发给模型。
// 本模块在统一出口补这一步：纯函数、零 DOM、零轮询，只在请求装配时跑一次。
//
// 性能红线：
// - 无候选宏（不含 '{{'，也不含 <USER>/<BOT> 等旧式宏）⇒ 原样返回同一对象/同一数组：
//   不克隆、不调宿主、零分配（内置破限/普通任务段全走这条）。
// - 有候选才逐个调一次 substitudeMacros；展开结果与原文相同 ⇒ 同样原样返回（不克隆）。
// - 每请求只展开一次：{{roll}}/{{setvar}} 有副作用，重复展开会多掷一次 / 多写一次。

/** 旧式尖括号宏（酒馆宏引擎 preEnvMacros 的非 {{}} 部分）。 */
const LEGACY_ANGLE_MACRO = /<(?:USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/i;

export type MacroSubstituter = (text: string) => string;

/** 是否有值得调用 substitudeMacros 的候选：所有 {{}} 宏都含 '{{'，旧式尖括号宏单独判。 */
export function hasMacroCandidate(text: string): boolean {
  return text.includes('{{') || LEGACY_ANGLE_MACRO.test(text);
}

/**
 * 展开一个提示词数组（ordered_prompts 与直连 messages 共用）。
 * 只处理 { role, content } 对象项；字符串占位符（'user_input'）与非字符串 content 原样保留。
 * 展开失败（宿主抛错 / 返回非字符串）回退原文，绝不阻断请求。
 * @returns 有变化时返回新数组；无变化返回原数组（调用方可用引用相等判断是否需要克隆 request）。
 */
export function expandPromptEntryMacros<T>(entries: T[], substitudeMacros?: MacroSubstituter): T[] {
  if (!Array.isArray(entries) || entries.length === 0 || typeof substitudeMacros !== 'function') return entries;
  let out: T[] | null = null;
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const content = (item as { content?: unknown }).content;
    if (typeof content !== 'string' || !hasMacroCandidate(content)) continue;
    let next = content;
    try {
      const result = substitudeMacros(content);
      if (typeof result === 'string') next = result;
    } catch (_e) {
      /* 展宏失败用原文（与请求指纹的兜底同口径） */
    }
    if (next === content) continue;
    if (!out) out = entries.slice();
    out[i] = { ...(item as object), content: next } as unknown as T;
  }
  return out || entries;
}

/**
 * 请求级展开：只碰 ordered_prompts。
 * 无变化返回原 request（引用相等；调用方据此零成本透传）；有变化返回浅克隆 request +
 * 新 ordered_prompts 数组，原请求对象与其项均不被修改。
 */
export function expandOrderedPromptMacros<T>(request: T, substitudeMacros?: MacroSubstituter): T {
  if (!request || typeof request !== 'object') return request;
  const prompts = (request as { ordered_prompts?: unknown }).ordered_prompts;
  if (!Array.isArray(prompts)) return request;
  const expanded = expandPromptEntryMacros(prompts as unknown[], substitudeMacros);
  if (expanded === prompts) return request;
  return { ...(request as object), ordered_prompts: expanded } as unknown as T;
}
