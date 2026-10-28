// ===== 窥私 AI 回复解析（<ubp_spy> 契约；行协议/富媒体/反幻觉全部复用 chat-parser 口径） =====
// 块头行协议：
//   [通话]拨出方|接听方          （第三段可选：未接 / 秒数）
//   [私聊]A|B
//   [群聊]群名|群主：X|成员、成员、成员   （群主前缀可省冒号；成员、分隔）
// 消息行=「名字: 内容」（SENDER_LINE_RE）；窥私专属动作 [拉人]名字 / [退群]理由 先于富媒体识别。
// 反幻觉：allowedSenders=焦点名单（主角不参与，非成员发言解析失败天然被拒）。

import type { PhoneMessageType } from './chat-model';
import { detectType, resolveSender, SENDER_LINE_RE, stripThinkingBlocks, type TypedContent } from './chat-parser';
import type { ChatBranch } from './rich-media';
import { SPY_CLOSE_TAG, SPY_OPEN_TAG, lastTagBlock } from './protocol-tags';

// 契约标签集中到 core/protocol-tags（单一事实源）；原样 re-export，既有 import 路径不变。
// （此处原先还各定义了一份 SPY_OPEN_TAG/SPY_CLOSE_TAG 且全库零引用——本次收编时删除。）
export { SPY_CLOSE_TAG, SPY_OPEN_TAG };

/** 窥私专属动作（[拉人]=群主加人；[退群] 复用群聊语义）。 */
export type SpyActionKind = 'add-member' | 'leave-group';

/** 窥私块内条目：消息或动作（按 AI 输出顺序平铺，apply 按序处理成员变化）。 */
export type ParsedSpyItem =
  | { kind: 'message'; sender: string; type: PhoneMessageType; content: string; amount?: string }
  | { kind: 'action'; action: SpyActionKind; sender: string; target: string; reason: string };

export interface ParsedSpyBlock {
  kind: 'call' | 'private' | 'group';
  /** 当事人：call=[拨出方,接听方]；private=[A,B]；group=头行成员（建群用）。 */
  parties: string[];
  /** 群聊：群名（复用已有群的匹配键）。 */
  title?: string;
  /** 群聊：头行群主（仅建群时生效）。 */
  owner?: string;
  /** 通话：未接（无转写）。 */
  missed?: boolean;
  /** 通话：头行秒数（缺省按行数推算）。 */
  durationSec?: number;
  items: ParsedSpyItem[];
}

export interface ParseSpyOptions {
  /** 允许的发言者/当事人（=本轮焦点名单）。 */
  allowedSenders: string[];
  /** 单块消息行上限。 */
  maxBlockMessages?: number;
  /** 解析块数上限。 */
  maxBlocks?: number;
}

export interface ParseSpyResult {
  blocks: ParsedSpyBlock[];
}

/** 提取 <ubp_spy> 块（取最后一个，防模型重复输出；无块=空）。 */
export function extractSpyBlock(text: string): string {
  const stripped = stripThinkingBlocks(String(text || ''));
  return lastTagBlock(stripped, SPY_OPEN_TAG, SPY_CLOSE_TAG) ?? '';
}

// 块头行：[通话] / [私聊]（兼容 [私]）/ [群聊]，兼容全角中括号
const CALL_HEADER_RE = /^\s*[【\[]\s*通话\s*[】\]]\s*(.+)$/;
const PRIVATE_HEADER_RE = /^\s*[【\[]\s*私(?:聊)?\s*[】\]]\s*(.+)$/;
const GROUP_HEADER_RE = /^\s*[【\[]\s*群聊\s*[】\]]\s*(.+)$/;
const ADD_MEMBER_RE = /^\s*[【\[]拉人[】\]]\s*(.+)$/;
const LEAVE_GROUP_RE = /^\s*[【\[]退群[】\]]\s*(.*)$/;

function splitNames(raw: string): string[] {
  return String(raw || '')
    .split(/[|、,，]/)
    .map(p => p.trim())
    .filter(Boolean);
}

/**
 * 解析窥私回复：
 * 1. 提取 <ubp_spy> 块，按块头行切段（通话/私聊/群聊）；
 * 2. 段内逐行「名字: 内容」，[拉人]/[退群] 动作行先于富媒体识别；
 * 3. 发言者按焦点名单解析（复用 resolveSender 口径），主角名冒充行丢弃；
 * 4. 备忘（[备忘]）与拉黑等窥私外动作不适用，丢弃该行。
 */
export function parseSpyReply(text: string, options: ParseSpyOptions): ParseSpyResult {
  const allowed = options.allowedSenders.filter(Boolean);
  const maxMessages = options.maxBlockMessages ?? 16;
  const maxBlocks = options.maxBlocks ?? 6;
  const result: ParseSpyResult = { blocks: [] };
  const block = extractSpyBlock(text);
  if (!block) return result;

  let current: ParsedSpyBlock | null = null;
  let branch: ChatBranch = 'group';
  /** 本段发言者白名单：私聊/通话=该段当事人；群聊=焦点名单（群内发言随成员变化由 apply 校验）。 */
  let segmentAllowed: string[] = allowed;

  const pushCurrent = (): void => {
    // 未接通话块无消息行也要保留（missed 本身就是交付物）；其余空块丢弃
    if (current && (current.items.length || current.missed)) result.blocks.push(current);
    current = null;
  };

  for (const rawLine of block.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const callHead = line.match(CALL_HEADER_RE);
    const privateHead = line.match(PRIVATE_HEADER_RE);
    const groupHead = line.match(GROUP_HEADER_RE);
    if (callHead || privateHead || groupHead) {
      pushCurrent();
      if (result.blocks.length >= maxBlocks) break;
      if (callHead) {
        const parts = splitNames(callHead[1]);
        const caller = parts[0] || '';
        const callee = parts[1] || '';
        const third = parts.slice(2).join('');
        const parsed: ParsedSpyBlock = { kind: 'call', parties: [caller, callee], items: [] };
        if (third.includes('未接') || third.includes('未接通') || third.includes('未接听')) {
          parsed.missed = true;
        } else {
          const sec = Number(String(third || '').replace(/[^\d]/g, ''));
          if (Number.isFinite(sec) && sec > 0) parsed.durationSec = Math.min(7200, Math.floor(sec));
        }
        current = parsed;
        branch = 'private';
        segmentAllowed = parsed.parties;
      } else if (privateHead) {
        const parts = splitNames(privateHead[1]);
        current = { kind: 'private', parties: [parts[0] || '', parts[1] || ''], items: [] };
        branch = 'private';
        segmentAllowed = current.parties;
      } else if (groupHead) {
        const parts = splitNames(groupHead[1]);
        const title = (parts[0] || '').slice(0, 24);
        const ownerRaw = (parts[1] || '').replace(/^群主[:：]?/, '').trim();
        const members = splitNames(parts.slice(2).join('、'));
        current = { kind: 'group', parties: members.length ? members : [], title, owner: ownerRaw, items: [] };
        branch = 'group';
        segmentAllowed = allowed;
      }
      continue;
    }
    if (!current) continue;
    const match = line.match(SENDER_LINE_RE);
    if (!match) continue;
    const sender = resolveSender(match[1], segmentAllowed);
    if (!sender) continue;
    let content = match[2].trim()
      .replace(/^["“'『「]+/, '')
      .replace(/["”'』」]+$/, '')
      .trim();
    if (!content) continue;
    // 窥私专属动作优先于富媒体识别
    const add = content.match(ADD_MEMBER_RE);
    if (add) {
      const target = resolveSender(add[1], allowed);
      if (target) {
        current.items.push({ kind: 'action', action: 'add-member', sender, target, reason: '' });
      }
      continue;
    }
    const leave = content.match(LEAVE_GROUP_RE);
    if (leave) {
      current.items.push({ kind: 'action', action: 'leave-group', sender, target: '', reason: leave[1].trim().slice(0, 60) });
      continue;
    }
    const typed: TypedContent | null = detectType(content, branch);
    if (!typed || typed.kind !== 'message') continue; // 备忘/好友裁决/拉黑不适用于窥私
    if (current.items.filter(i => i.kind === 'message').length >= maxMessages) continue;
    current.items.push({
      kind: 'message',
      sender,
      type: typed.type || 'text',
      content: typed.content.slice(0, 1000),
      ...(typed.amount ? { amount: typed.amount } : {}),
    });
  }
  pushCurrent();
  return result;
}

/** 结果有效性过滤（引擎在落库前调用）：通话未接可无消息，其余块至少 1 条消息；当事人齐备。 */
export function filterValidSpyBlocks(blocks: readonly ParsedSpyBlock[]): ParsedSpyBlock[] {
  return blocks.filter(b => {
    if (b.parties.some(p => !p)) return false;
    if (b.kind === 'call') return b.missed === true || b.items.some(i => i.kind === 'message');
    return b.items.some(i => i.kind === 'message');
  });
}