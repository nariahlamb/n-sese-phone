// ===== 通话 AI 回复解析（纯函数；<ubp_call> 契约见 docs/05 §4.3-4.4） =====
// 发起版字段：status/reason/thought/content；续话版仅 thought/content（status 缺省 answered）。
// content 始终只有对方说话（无名字前缀）；「<挂断>」单独一行 = 对方主动挂断。
// 解析策略对齐 chat-parser：剥思考块 → 取最后一个标签块（无标签宽容兜底）→ 逐行过滤。

import { stripThinkingBlocks } from './chat-parser';
import { normalizeEmotion } from './voice-providers';
import { CALL_CLOSE_TAG, CALL_OPEN_TAG, VOICEMAIL_CLOSE_TAG, VOICEMAIL_OPEN_TAG, lastTagBlock } from './protocol-tags';

// 契约标签集中到 core/protocol-tags（单一事实源）；原样 re-export，既有 import 路径不变。
export { CALL_CLOSE_TAG, CALL_OPEN_TAG, VOICEMAIL_CLOSE_TAG, VOICEMAIL_OPEN_TAG };

/** 单行情绪标注（TTS 消费；无标注＝两个空串）。 */
export interface CallLineTag {
  /** 规范中文八词之一（vocabulary 唯一事实源见 voice-providers.VOICE_EMOTIONS）；'' = 未标注。 */
  emotion: string;
  /** 可选演绎说明（怎么念，不写动作/旁白）。 */
  delivery: string;
}

export interface ParseCallResult {
  /** answered/rejected（发起版字段；续话版缺省 answered）。非法值默认 answered。 */
  status: 'answered' | 'rejected';
  /** 拒接理由（status=rejected 时）。 */
  rejectReason?: string;
  /** 对方此刻内心想法（玩家元信息）。 */
  thought?: string;
  /** content 逐行解析后的对方通话行（已剥离 <挂断> 标记与句首情绪标注）。 */
  lines: string[];
  /** 与 lines **等长对齐**的每行情绪标注（下标一一对应；未标注 = 空串对）。 */
  lineTags: CallLineTag[];
  /** 对方是否输出了 <挂断> 信号。 */
  hangup: boolean;
}

/** 行首情绪标注：`[情绪]台词` / `[情绪|演绎]台词`（方括号/【】、半角/全角竖线皆可）。
 *  **只在第一段能归一到规范情绪时才认**——否则整行原样返回（别吃掉台词里方括号的正常用法）。
 *  与微信语音条同构（docs/35 §B.4 双通道），差别只是通话每行天然就是「说出来的话」，无需 [语音] 前缀。 */
export function splitLineTag(line: string): { text: string; emotion: string; delivery: string } {
  const raw = String(line || '');
  const m = raw.match(/^\s*[[【]\s*([^[\]【】]{1,40})\s*[\]】]\s*([\s\S]*)$/);
  if (!m) return { text: raw.trim(), emotion: '', delivery: '' };
  const segs = m[1].split(/[|｜]/).map(s => s.trim());
  const emotion = normalizeEmotion(segs[0]);
  if (!emotion) return { text: raw.trim(), emotion: '', delivery: '' };
  const rest = m[2].trim();
  if (!rest) return { text: raw.trim(), emotion: '', delivery: '' }; // 只有标签没有台词：当普通文字
  return { text: rest, emotion, delivery: (segs[1] || '').slice(0, 40) };
}

export interface ParseCallOptions {
  /** 单次解析通话行上限。 */
  maxLines?: number;
}

/** 挂断标记行：<挂断> / （挂断） /(挂断)，允许尾随标点。 */
const HANGUP_LINE_RE = /^(?:<挂断>|[（(]挂断[)）])[。.!！?？]?$/;

/** 提取 <ubp_call> 块（取最后一个，防模型重复输出）；无标签时宽容兜底（≥60% 行是字段行）。 */
export function extractCallBlock(text: string): string {
  const stripped = stripThinkingBlocks(text)
    .replace(CALL_OPEN_TAG_RE, CALL_OPEN_TAG) // 容错：全角/带空格写法归一
    .replace(CALL_CLOSE_RE, CALL_CLOSE_TAG);
  const last = lastTagBlock(stripped, CALL_OPEN_TAG, CALL_CLOSE_TAG);
  if (last !== null) return last;
  // 兜底：剥 markdown 围栏后，多数行是「字段: 值」形态（status/reason/thought/content）则整段当块
  const noFence = stripped.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  const lines = noFence.split(/\n+/).filter(Boolean);
  if (!lines.length) return '';
  const fieldLines = lines.filter(l => /^\s*(status|reason|thought|content)\s*[:：]/i.test(l)).length;
  if (fieldLines >= Math.ceil(lines.length * 0.6)) return noFence;
  return '';
}

const CALL_OPEN_TAG_RE = /<\s*ubp[_-]?call\s*>/gi;
const CALL_CLOSE_RE = /<\s*\/\s*ubp[_-]?call\s*>/gi;

/**
 * 解析通话回复：
 * 1. status/reason/thought 单行字段（半角/全角冒号兼容）；
 * 2. content: 起始行之后全部为通话内容（首行可跟在同段）；
 * 3. 内容行丢弃：空行、<挂断> 标记行（置 hangup）、以哨兵「{{user}}：/我：」开头冒充我方的行
 *    （只匹配字面哨兵不匹配真名——主角名按名屏蔽在同名场景会误杀对方台词）；
 * 4. status=rejected 时忽略全部内容（拒接不产生通话）。
 */
export function parseCallReply(text: string, options: ParseCallOptions = {}): ParseCallResult {
  const max = options.maxLines ?? 20;
  const result: ParseCallResult = { status: 'answered', lines: [], lineTags: [], hangup: false };
  const block = extractCallBlock(text);
  if (!block) return result;

  const pushContent = (rawLine: string): void => {
    const raw = rawLine.trim().replace(/^["“'『「]+/, '').replace(/["”'』」]+$/, '').trim();
    if (!raw) return;
    // 先剥句首情绪标注，再判定挂断/冒充——`[低语]<挂断>` 这类写法也能正确识别为挂断。
    const tagged = splitLineTag(raw);
    const line = tagged.text;
    if (!line) return;
    if (HANGUP_LINE_RE.test(line)) {
      result.hangup = true;
      return;
    }
    // 冒充我方的行（「{{user}}：xxx」「我：xxx」）丢弃；不做子串前缀匹配——
    // 对方台词完全可能以「我」字开头（如「我也想你」）。
    if (/^\{\{user\}\}\s*[:：]/.test(line) || /^我\s*[:：]/.test(line)) return;
    if (result.lines.length < max) {
      result.lines.push(line.slice(0, 1000));
      result.lineTags.push({ emotion: tagged.emotion, delivery: tagged.delivery });
    }
  };

  let inContent = false;
  for (const rawLine of block.split('\n')) {
    if (!inContent) {
      const field = rawLine.trim().match(/^(status|reason|thought|content)\s*[:：]\s*(.*)$/i);
      if (!field) continue; // 块内未知行（格式噪声）忽略
      const key = field[1].toLowerCase();
      const value = field[2].trim();
      if (key === 'status') {
        result.status = value.toLowerCase() === 'rejected' ? 'rejected' : 'answered';
      } else if (key === 'reason') {
        if (value) result.rejectReason = value.slice(0, 200);
      } else if (key === 'thought') {
        if (value) result.thought = value.slice(0, 500);
      } else {
        inContent = true;
        pushContent(value);
      }
    } else {
      pushContent(rawLine);
    }
  }

  if (result.status === 'rejected') {
    result.lines = [];
    result.lineTags = [];
    result.hangup = false;
  }
  return result;
}

// ─── 语音留言解析（T1） ───

export interface ParseVoicemailResult {
  /** 留言行（已剥离句首情绪标注与常见字段前缀；1..maxLines 条）。 */
  lines: string[];
  /** 与 lines 等长对齐的情绪标注（下标一一对应；未标注 = 空串对）。 */
  lineTags: CallLineTag[];
}

/** 留言的「字段前缀」行：`content: xxx` / `留言：xxx` / `内容: xxx`（AI 常按通话格式把首行写成字段名）。 */
const VM_FIELD_PREFIX_RE = /^(?:content|留言|内容)\s*[:：]\s*/i;

/**
 * 解析语音留言回复（T1，契约见 docs/44 §9）：输出 `<ubp_voicemail>` 块，块内逐行=每句留言。
 * 宽容兜底：无标签块时整段文本按留言处理（与 parseCallReply 的「剥围栏整段当块」同精神）；
 * 丢弃空行、<挂断> 标记行、冒充我方的行；每行剥句首情绪标注；上限 maxLines（默认 3，落库契约同值）。
 */
export function parseVoicemailReply(text: string, options: ParseCallOptions = {}): ParseVoicemailResult {
  const max = options.maxLines ?? 3;
  const result: ParseVoicemailResult = { lines: [], lineTags: [] };
  const stripped = stripThinkingBlocks(String(text || ''));
  const block = lastTagBlock(
    stripped.replace(VM_OPEN_TAG_RE, VOICEMAIL_OPEN_TAG).replace(VM_CLOSE_RE, VOICEMAIL_CLOSE_TAG),
    VOICEMAIL_OPEN_TAG,
    VOICEMAIL_CLOSE_TAG,
  ) ?? stripped.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!block.trim()) return result;

  for (const rawLine of block.split('\n')) {
    const raw = rawLine.trim().replace(VM_FIELD_PREFIX_RE, '').trim().replace(/^["“'『「]+/, '').replace(/["”'』」]+$/, '').trim();
    if (!raw) continue;
    if (/ubp[_-]?voicemail/i.test(raw)) continue; // 标签残骸行（含全角/错形兜底路径）：不是留言内容
    const tagged = splitLineTag(raw);
    const line = tagged.text;
    if (!line) continue;
    if (HANGUP_LINE_RE.test(line)) continue; // 留言里冒出 <挂断> 标记：不是留言内容，丢弃
    if (/^\{\{user\}\}\s*[:：]/.test(line) || /^我\s*[:：]/.test(line)) continue; // 冒充我方行：同通话口径丢弃
    if (result.lines.length < max) {
      result.lines.push(line.slice(0, 1000));
      result.lineTags.push({ emotion: tagged.emotion, delivery: tagged.delivery });
    }
  }
  return result;
}

const VM_OPEN_TAG_RE = /<\s*ubp[_-]?voicemail\s*>/gi;
const VM_CLOSE_RE = /<\s*\/\s*ubp[_-]?voicemail\s*>/gi;
