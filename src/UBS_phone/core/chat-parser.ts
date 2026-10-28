// ===== AI 聊天回复解析（纯函数，零依赖，可被 .cjs 测试直接 require） =====
// 输出契约见 docs/02 §5.3：<ubp_reply> 块 + 「名字: 内容」行格式。
// 富媒体提取由 rich-media 注册表驱动：kind='message' 进消息流，kind='memo' 触发额外操作。

import type { PhoneMessageType } from './chat-model';
import { MEMO_TYPES, RICH_MEDIA_SPECS, specBranchAllows, type ChatBranch } from './rich-media';
import { REPLY_CLOSE_TAG, REPLY_OPEN_TAG, lastTagBlock, tagRegex } from './protocol-tags';
import { truncateText, unescapeBasicEntities } from './ubp-utils';

/** 会话级动作 id（rich-media 注册表 kind='action' 的类型）。 */
export type ChatActionKind = 'friend-accept' | 'friend-reject' | 'block' | 'leave-group';

export interface ParsedChatMessage {
  sender: string;
  type: PhoneMessageType;
  content: string;
  /** 转账/红包金额（元，两位小数字符串）。 */
  amount?: string;
  /** 语音情绪（规范中文八词之一；仅 [语音|情绪|演绎] 形态带）。 */
  emotion?: string;
  /** 语音演绎说明（40 字上限裕量；仅带）。 */
  delivery?: string;
}

/** 备忘提取结果（触发额外操作：注入主项目备忘录表，docs/02 §5.5）。 */
export interface ParsedChatMemo {
  sender: string;
  /** AI 生成的备忘标题（可空串——旧格式/缺省时由前端兜底生成）。 */
  title: string;
  /** 约定/待办/伏笔/临时变化。 */
  memoType: string;
  /** 约定时间（AI 原文，可空串）。 */
  appointedTime: string;
  detail: string;
}

export interface ParseChatResult {
  /** 显示在聊天记录中的消息。 */
  messages: ParsedChatMessage[];
  /** 触发额外操作的备忘（不入消息流）。 */
  memos: ParsedChatMemo[];
  /** 会话级动作（好友申请裁决/拉黑/退群）：按 AI 输出顺序携带 index=应插入到第几条消息之后。 */
  actions: ParsedChatAction[];
}

/** 会话级动作（前端落系统消息并改会话状态：加好友/移好友/移群成员）。 */
export interface ParsedChatAction {
  sender: string;
  action: ChatActionKind;
  /** 拒绝/拉黑/退群理由（通过=空）。 */
  reason: string;
  /** 在消息流中的落点：本动作行之前已输出的消息条数（reveal 逐条上屏时按此插叙系统消息）。 */
  index: number;
}

export interface ParseReplyOptions {
  /** 允许的发言者（会话成员的规范名）。 */
  allowedSenders: string[];
  /** 单次解析消息上限（缺省＝不限；聊天引擎不传，仅调用方按需自限）。 */
  maxMessages?: number;
  /** 聊天分支（决定富媒体/action 标签的合法性；缺省=私聊）。 */
  branch?: ChatBranch;
  /** 气氛组名字：只收纯文本、丢弃动作/备忘/富媒体，并做单轮 8 条软上限；消息仍进普通 messages。 */
  atmosphereSenders?: string[];
}

/** 单轮气氛组发言软上限（与 chat-model 规格一致；解析器保持零依赖，故本地常量）。 */
const MAX_ATMOSPHERE_MESSAGES = 8;

const THINK_CLOSE_RE = /<\/(think|thinking|reasoning|reflection)>/gi;

/** 剥离模型思考块：取最后一个闭合思考标签之后的内容（兼容多个/嵌套误用）。 */
export function stripThinkingBlocks(text: string): string {
  let out = String(text || '');
  THINK_CLOSE_RE.lastIndex = 0;
  let lastClose = -1;
  let match: RegExpExecArray | null;
  while ((match = THINK_CLOSE_RE.exec(out)) !== null) {
    lastClose = match.index + match[0].length;
  }
  if (lastClose >= 0) out = out.slice(lastClose);
  // 兜底：未闭合的 <think> 开头（吞掉其后所有内容的场景）——其后若还有回复块则保留回复块
  const openIdx = out.search(/<(think|thinking|reasoning|reflection)>/i);
  if (openIdx >= 0) {
    const after = out.slice(openIdx);
    const replyIdx = after.search(tagRegex(REPLY_OPEN_TAG));
    if (replyIdx >= 0) out = after.slice(replyIdx);
  }
  return out.trim();
}

/** 提取 <ubp_reply> 块（取最后一个匹配，防模型重复输出）；无标签时做宽容兜底。 */
export function extractReplyBlock(text: string): string {
  const stripped = stripThinkingBlocks(text);
  const last = lastTagBlock(stripped, REPLY_OPEN_TAG, REPLY_CLOSE_TAG);
  if (last !== null) return last;
  // 兜底：剥掉 markdown 围栏后，若多数行是「名字: 内容」形态则整段当回复
  const noFence = stripped.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  const lines = noFence.split(/\n+/).filter(Boolean);
  if (lines.length === 0) return '';
  const senderLines = lines.filter(l => /^\s*[^:：\n]{1,24}[:：]\s*\S/.test(l)).length;
  if (senderLines >= Math.ceil(lines.length * 0.6)) return noFence;
  return '';
}

// 发言者行：名字（≤24字，不含冒号/括号类标点）+ 半角或全角冒号 + 内容
// （导出供窥私解析器复用同一行协议）
export const SENDER_LINE_RE = /^\s*([^:：\[\]（）(){}【】,，。.!！?？"'“”\s][^:：\n]{0,23}?)\s*[:：]\s*(.+)$/;

/** 名字归一：去空白与常见装饰符号。 */
function normalizeName(value: string): string {
  return value.replace(/^[\s@＠]+|[\s]+$/g, '').trim();
}

/**
 * 发言者解析：精确命中 > 唯一子串命中（「珞」→「珞花」）；歧义/无命中返回 null。
 * （导出供窥私解析器复用同一反幻觉口径）
 */
export function resolveSender(raw: string, allowed: string[]): string | null {
  const name = normalizeName(raw);
  if (!name || name.length > 24) return null;
  if (allowed.includes(name)) return name;
  const substringHits = allowed.filter(a => a.includes(name) || name.includes(a));
  if (substringHits.length === 1) return substringHits[0];
  return null;
}

// ─── 富媒体提取（rich-media 注册表驱动） ───

/** 各类型的前缀别名（注册表 tag 之外的容忍写法；全角中括号统一兼容）。 */
const TYPE_ALIASES: Record<string, string[]> = {
  image: ['图片', '照片', 'photo', 'image'],
  voice: ['语音', 'voice', '音频'],
  transfer: ['转账', 'transfer'],
  redpacket: ['红包', 'redpacket'],
  memo: ['备忘', 'memo'],
  'friend-accept': ['通过', '同意', 'accept'],
  'friend-reject': ['拒绝', 'reject'],
  block: ['拉黑', '屏蔽', 'block'],
  'leave-group': ['退群', '退出群聊', 'leave'],
};

export interface TypedContent {
  kind: 'message' | 'memo' | 'action';
  type?: PhoneMessageType;
  action?: ChatActionKind;
  /** 动作理由（拒绝/拉黑/退群）。 */
  reason?: string;
  content: string;
  amount?: string;
  /** 转账/红包币种名（"[转账]520 上品灵石|留言" 形态；缺省由上层回落常用货币）。 */
  currency?: string;
  /** 语音情绪（`[语音|情绪|演绎]` 形态；规范中文八词，认不出留给上层归一）。 */
  emotion?: string;
  /** 语音演绎说明（`[语音|情绪|演绎]` 第三段；40 字上限裕量）。 */
  delivery?: string;
  memo?: { title: string; memoType: string; appointedTime: string; detail: string };
}

/** 金额清洗：去货币符号取数字，>0 且 <100 万，两位小数；无效返回 null（丢该行）。
 *  金额后可带币种名（"[转账]520 上品灵石|留言"）；导出供我方转账/红包发送弹层复用（同一校验口径）。 */
export function parseAmountNote(raw: string): { amount: string; note: string; currency?: string } | null {
  const idx = raw.indexOf('|');
  const amountText = (idx >= 0 ? raw.slice(0, idx) : raw).trim();
  const note = (idx >= 0 ? raw.slice(idx + 1) : '').trim();
  const m = amountText.match(/^([+-]?\d+(?:\.\d+)?)\s*(.*)$/);
  const n = m ? Number(m[1]) : Number(amountText.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n >= 1000000) return null;
  const currency = m && m[2] ? m[2].trim().slice(0, 20) : '';
  return { amount: n.toFixed(2), note, ...(currency ? { currency } : {}) };
}

/**
 * 备忘内容解析：标题|类型|约定时间|详细内容（约定时间留空＝三段式 标题|类型|详细内容）。
 * 兼容旧格式（无标题）：类型|约定时间|详细内容 / 类型|详细内容——第二段为合法类型时判为新格式。
 */
function parseMemoFields(raw: string): { title: string; memoType: string; appointedTime: string; detail: string } | null {
  const parts = raw.split('|').map(p => p.trim());
  let title = '';
  let memoType = '';
  let appointedTime = '';
  let detail = '';
  if (parts.length === 3 && (MEMO_TYPES as readonly string[]).includes(parts[1])) {
    title = parts[0];
    memoType = parts[1];
    detail = parts[2];
  } else if (parts.length === 2) {
    if ((MEMO_TYPES as readonly string[]).includes(parts[1])) return null; // 新格式缺详细内容 → 丢
    memoType = parts[0];
    detail = parts[1];
  } else if (parts.length === 3) {
    memoType = parts[0];
    appointedTime = parts[1];
    detail = parts[2];
  } else {
    title = parts[0];
    memoType = parts[1] || '';
    appointedTime = parts[2] || '';
    detail = parts.slice(3).join('|');
  }
  if (!detail) return null;
  if (!(MEMO_TYPES as readonly string[]).includes(memoType)) memoType = '约定';
  return {
    title: title.replace(/\s+/g, ' ').trim().slice(0, 30),
    memoType,
    appointedTime: appointedTime.slice(0, 40),
    detail: detail.slice(0, 500),
  };
}

/** 消息类型前缀识别（兼容半角/全角中括号；由 RICH_MEDIA_SPECS 决定类型集合，
 *  不在当前分支的类型当普通文字——反幻觉：提示词从未教过该分支这些标签）。
 *  （导出供窥私解析器复用同一富媒体口径；[拉人] 等窥私专属标签由调用方先行识别） */
export function detectType(content: string, branch: ChatBranch): TypedContent | null {
  // 带属性形态：`[语音|情绪]` / `[语音|情绪|演绎]`（注册表里只有语音支持属性；docs/35 §B.4）。
  // 旧形态 `[语音]转写` 不受影响（不带 | 时走下面的原路径）。
  const vm = content.match(/^[【[]\s*(?:语音|voice|音频)\s*[|｜]\s*([^【】]{0,80}?)\s*[】\]]\s*([\s\S]*)$/i);
  if (vm) {
    const spec = RICH_MEDIA_SPECS.find(s => s.id === 'voice');
    if (spec && specBranchAllows(spec, branch)) {
      const fields = vm[1].split(/[|｜]/).map(s => s.trim());
      return {
        kind: 'message',
        type: 'voice',
        content: vm[2].trim(),
        emotion: fields[0] || '',
        delivery: fields[1] || '',
      };
    }
    // 分支外标签：当普通文字（与既有反幻觉口径一致）
    return { kind: 'message', type: 'text', content };
  }
  const m = content.match(/^[【\[]\s*([^【\[\]】]{1,6})\s*[】\]]\s*(.*)$/);
  if (!m) return { kind: 'message', type: 'text', content };
  const keyword = m[1].toLowerCase();
  for (const spec of RICH_MEDIA_SPECS) {
    const aliases = TYPE_ALIASES[spec.id] || [spec.tag.slice(1, -1)];
    if (!aliases.some(a => a.toLowerCase() === keyword)) continue;
    if (!specBranchAllows(spec, branch)) break; // 分支外标签：当普通文字
    const rest = m[2].trim();
    if (spec.kind === 'memo') {
      const memo = parseMemoFields(rest);
      return memo ? { kind: 'memo', content: rest, memo } : null;
    }
    if (spec.kind === 'action') {
      return {
        kind: 'action',
        action: spec.id as ChatActionKind,
        content: rest,
        reason: spec.id === 'friend-accept' ? '' : rest.slice(0, 120),
      };
    }
    // 图片 content=生图第一步输入：不截断（截断会让生图拿到残缺文本）
    if (spec.id === 'image') return { kind: 'message', type: 'image', content: rest };
    if (spec.id === 'transfer' || spec.id === 'redpacket') {
      const parsed = parseAmountNote(rest);
      if (!parsed) return null;
      return { kind: 'message', type: spec.id, content: parsed.note, amount: parsed.amount, ...(parsed.currency ? { currency: parsed.currency } : {}) };
    }
    return { kind: 'message', type: spec.id as PhoneMessageType, content: rest };
  }
  return { kind: 'message', type: 'text', content };
}

/**
 * 备忘裸行兜底：无「名字:」前缀的 `[备忘]…` 行 → 备忘条目（备忘独立块允许免名字直出；
 * 不入消息流，sender 无实质用途，回退会话首位成员=私聊对方）。非备忘行返回 null。
 */
function bareMemoFromLine(line: string, branch: ChatBranch, fallbackSender: string): ParsedChatMemo | null {
  const typed = detectType(line, branch);
  if (!typed || typed.kind !== 'memo' || !typed.memo) return null;
  return { sender: fallbackSender, ...typed.memo };
}

/**
 * 解析 AI 回复：
 * 1. 逐行匹配「名字: 内容」；
 * 2. 丢弃无法归到会话成员的行（sender 解析失败——主角名/「我」不是成员，天然被拒，
 *    不做按名屏蔽：主角与角色同名时按名屏蔽会误杀角色发言）；
 * 3. 富媒体前缀识别（rich-media 注册表驱动，按分支过滤）：message 进消息流，
 *    memo 进备忘流，action 进动作流；
 * 4. 裸 `[备忘]…` 行（无名字前缀）走备忘兜底收进备忘流；
 * 5. 同轮矛盾行丢弃：某角色已 [拉黑]/[退群]/[拒绝]，其后同角色的消息行不再成立。
 */
export function parseChatReply(text: string, options: ParseReplyOptions): ParseChatResult {
  const allowed = options.allowedSenders.filter(Boolean);
  const branch = options.branch || 'private';
  // 条数不设上限（用户拍板，2026-10-05：有多少条收多少条）；maxMessages 仅留给调用方按需自限。
  const max = options.maxMessages ?? Infinity;
  const block = extractReplyBlock(text);
  const result: ParseChatResult = { messages: [], memos: [], actions: [] };
  if (!block) return result;
  const actionSenders = new Set<string>(); // 每角色最多一个动作（先到先得，防通过+拒绝两头下注）
  const silenced = new Set<string>();      // 已拉黑/退群/拒绝的角色：后续消息行丢弃
  const atmosphereSet = new Set((options.atmosphereSenders || []).filter(Boolean));
  let atmosphereCount = 0;
  for (const rawLine of block.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 纯格式噪声行
    if (/^[（(【\[]?系统提示|^[（(【\[]?注意[:：]/.test(line)) continue;
    const match = line.match(SENDER_LINE_RE);
    if (!match) {
      // 备忘裸行兜底（备忘独立块允许免名字直出）；其余裸富媒体行照旧丢弃
      const bare = bareMemoFromLine(line, branch, allowed[0] || '');
      if (bare && result.memos.length < 3) result.memos.push(bare);
      continue;
    }
    const resolved = resolveSender(match[1], allowed);
    if (!resolved) continue;
    let content = match[2].trim();
    // 去首尾包裹引号
    content = content.replace(/^["“'『「]+/, '').replace(/["”'』」]+$/, '').trim();
    if (!content) continue;
    const typed = detectType(content, branch);
    if (!typed) continue;
    const isAtmosphere = atmosphereSet.has(resolved);
    if (isAtmosphere) {
      // 气氛组只发纯文本短句：动作/备忘/图片/语音/转账/红包一律丢弃（提示词从未教过这些形态）。
      if (typed.kind !== 'message' || typed.type !== 'text') continue;
      if (silenced.has(resolved)) continue;
      if (result.messages.length >= max) continue;
      if (atmosphereCount >= MAX_ATMOSPHERE_MESSAGES) continue;
      atmosphereCount++;
      result.messages.push({ sender: resolved, type: 'text', content: typed.content.slice(0, 200) });
      continue;
    }
    if (typed.kind === 'memo') {
      if (result.memos.length < 3) {
        result.memos.push({ sender: resolved, ...typed.memo! });
      }
      continue;
    }
    if (typed.kind === 'action') {
      if (result.actions.length < 3 && !actionSenders.has(resolved)) {
        actionSenders.add(resolved);
        if (typed.action !== 'friend-accept') silenced.add(resolved);
        result.actions.push({
          sender: resolved,
          action: typed.action!,
          reason: (typed.reason || '').trim(),
          index: result.messages.length,
        });
      }
      continue;
    }
    if (silenced.has(resolved)) continue;
    if (result.messages.length >= max) continue;
    result.messages.push({
      sender: resolved,
      type: typed.type || 'text',
      // 图片 content=生图第一步输入：不截断；其余类型维持 2000 上限
      content: typed.type === 'image' ? typed.content : typed.content.slice(0, 2000),
      ...(typed.amount ? { amount: typed.amount } : {}),
      ...(typed.type === 'voice' && typed.emotion ? { emotion: typed.emotion.slice(0, 20) } : {}),
      ...(typed.type === 'voice' && typed.delivery ? { delivery: typed.delivery.slice(0, 60) } : {}),
    });
  }
  return result;
}

/** HTML 剥离（取正文楼层用，字符级无 DOM 依赖）。实体还原走统一出口（含 &#39;，且 &amp; 最后还原）。 */
export function stripHtml(text: string): string {
  return unescapeBasicEntities(
    String(text || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 截断到 max 字（按码点）；实现统一走 core/ubp-utils.truncateText。 */
export function truncateCjk(text: string, max: number): string {
  return truncateText(text, max);
}
