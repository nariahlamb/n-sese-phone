// core/jailbreak-config.ts
// 破限提示词解析器：唯一真相模块（破限头 / 尾部破限 / 反八股 三个槽位的运行时取值）。
// 默认值事实源在 constants.ts（JAILBREAK_SYSTEM_PROMPT / TAIL_JAILBREAK_PROMPT / ANTI_CLICHE_PROMPT）；
// 用户在设置页「破限提示词」改过之后，本模块按配置返回段落数组，各请求站点直接展开进 ordered_prompts：
//   ...getJailbreakHeadPrompts({ antiCliche: true, task })  →  九元素中段  →  ...getJailbreakTailPrompts()
// 头/尾槽位结构完全同构（default / none / custom），区别只在拼进请求的位置（最上端 / 最下端）。
// 反八股是独立设置项（不属于破限），叙事文本类请求在破限头之后拼接。
import { getConfig } from './config-store';
import {
  JAILBREAK_SYSTEM_PROMPT,
  createJailbreakSlotState,
  ANTI_CLICHE_PROMPT,
  TAIL_JAILBREAK_PROMPT,
  type JailbreakSegmentRole,
  type JailbreakSlotState,
} from './constants';
import { activeJailbreakSegments, hasActiveJailbreakSegments } from './jailbreak-presets';

/** 拼进 ordered_prompts 的一条破限消息（身份 + 内容）。 */
export interface JailbreakPromptEntry {
  role: JailbreakSegmentRole;
  content: string;
}

/** 读取槽位状态：归一在 config-store 读取侧完成（core/jailbreak-presets），此处只兜底
 *  「配置对象缺字段 / 被替换」（如测试桩、早期初始化）——缺则按默认档，绝不因脏配置抛错。 */
function readSlot(kind: 'head' | 'tail'): JailbreakSlotState {
  const cfg = getConfig() as Partial<{ jailbreakHead: JailbreakSlotState; jailbreakTail: JailbreakSlotState }> | undefined;
  const raw = kind === 'head' ? cfg?.jailbreakHead : cfg?.jailbreakTail;
  return raw && typeof raw === 'object' && typeof raw.mode === 'string' && Array.isArray(raw.segments)
    ? raw
    : createJailbreakSlotState();
}

/** 反八股写作要求。custom 且文本非空时用用户自定义，否则回退内置。仅叙事文本类 AI 请求拼接。 */
export function getAntiClichePrompt(): string {
  const c = getConfig();
  return c.antiClicheMode === 'custom' && c.antiClicheText.trim() !== ''
    ? c.antiClicheText
    : ANTI_CLICHE_PROMPT;
}

/** 自定义段落 → 提示条目（空段不发；文本原样保留，只按空白判空）。
 *  宏（{{roll}}/{{setvar}}/{{//}} 等）留到出站层统一展开（core/ai-prompt-macros），此处不得预先展开。 */
function segmentsToEntries(slot: JailbreakSlotState): JailbreakPromptEntry[] {
  return activeJailbreakSegments(slot.segments).map(seg => ({ role: seg.role, content: seg.text }));
}

/**
 * 破限头段数组（拼在 ordered_prompts 最上端）。
 * - default：单条 system ＝ 内置破限 [+ 反八股] [+ 站点任务段]（与历史逐字节一致）
 * - none：空数组（该端不发送任何内容）
 * - custom：用户段落逐条发出，其后各自独立成条追加 反八股段（antiCliche=true 时）与站点任务段
 *   ※「自定义但全段空白」属非法态（设置页拦截）；此处安全回退 default，绝不静默发出无破限的请求。
 * @param opts.antiCliche 叙事文本类请求传 true（拼反八股）
 * @param opts.task 站点自带任务段（世界演化 / 技能树 / 瑟瑟指导），拼在破限之后
 */
export function getJailbreakHeadPrompts(opts?: { antiCliche?: boolean; task?: string }): JailbreakPromptEntry[] {
  const antiCliche = opts?.antiCliche === true;
  const task = typeof opts?.task === 'string' ? opts.task : '';
  const slot = readSlot('head');
  if (slot.mode === 'none') return [];

  const useDefault = slot.mode !== 'custom' || !hasActiveJailbreakSegments(slot.segments);
  if (useDefault) {
    const content = JAILBREAK_SYSTEM_PROMPT
      + (antiCliche ? getAntiClichePrompt() : '')
      + (task ? '\n\n' + task : '');
    return [{ role: 'system', content }];
  }

  const entries = segmentsToEntries(slot);
  if (antiCliche) entries.push({ role: 'system', content: getAntiClichePrompt().trim() });
  if (task.trim() !== '') entries.push({ role: 'system', content: task.trim() });
  return entries;
}

/**
 * 尾部破限段数组（拼在 ordered_prompts 最下端）。
 * - default：单条 system ＝ 内置尾部破限（原「反截断」原文）
 * - none：空数组
 * - custom：用户段落逐条发出（全段空白同样安全回退 default）
 */
export function getJailbreakTailPrompts(): JailbreakPromptEntry[] {
  const slot = readSlot('tail');
  if (slot.mode === 'none') return [];
  const useDefault = slot.mode !== 'custom' || !hasActiveJailbreakSegments(slot.segments);
  if (useDefault) return [{ role: 'system', content: TAIL_JAILBREAK_PROMPT }];
  return segmentsToEntries(slot);
}
