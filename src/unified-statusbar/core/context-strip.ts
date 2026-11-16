// ===== 上下文标签剥离工具 =====
//
// 职责：在「取上下文 → 注入提示词 / 手机提取」之间，按两套独立名单清洗每条 AI 回复：
//   1. 剥离标签（stripTags，黑名单，从上到下按优先级，如 think/thinking/options/orange/image）
//   2. 保留标签（keepTags，白名单，如 content/playtxt）
//
// 两层防误伤管线（单条消息独立处理，避免跨楼连坐）：
//   ① 先按「剥离标签」从上到下优先级做栈式配对清除（思考/功能外壳里的任何提及都一并清掉，
//      且交叉配对时高优先级标签优先保护不被低优先级闭标签打断；启用保留标签时，若思考块内
//      顺嘴提到过闭合思考标签且外层保留标签之外还有真正的闭合思考标签，自动续延剥离至真实闭合）；
//   ② 若配置了「保留标签」且剩余文本中存在成对的保留标签：只提取顶层保留标签内的正文段
//      （并解包内层嵌套保留标签壳），最后对提取出的正文再跑一次剥离标签以清除正文内嵌的
//      <orange>/<image>/<novel_header> 等杂项；
//   ③ 若未配置保留标签、或当前消息未命中任何保留标签，则回退返回第 ① 步剥离后的全部内容。

import { getConfig } from './config-store';

const THINKING_RECOVERY_TAGS = new Set([
  'thinking', 'think', 'reasoning', 'reflection', 'deep_thinking', 'dream_think', 'thought',
]);

/** 转义正则元字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化标签列表：去尖括号、去空白、小写、去重，并严格保持用户从上到下的顺序（下标=优先级）。 */
export function normalizeContextTags(tags: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(tags) || tags.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = String(raw == null ? '' : raw)
      .trim()
      .replace(/^<\/?\s*|\s*\/?>$/g, '')
      .trim()
      .toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

interface TagToken {
  kind: 'open' | 'close' | 'self';
  tag: string;
  priority: number;
  start: number;
  end: number;
}

function tokenizeTags(text: string, orderedTags: string[]): TagToken[] {
  const priorityMap = new Map<string, number>();
  orderedTags.forEach((t, idx) => priorityMap.set(t, idx));
  const alts = [...orderedTags].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const tokenRe = new RegExp('<\\/(' + alts + ')\\s*>|<(' + alts + ')(?=[\\s/>])[^<>]*>', 'gi');
  const tokens: TagToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      tokens.push({ kind: 'close', tag, priority: priorityMap.get(tag) ?? 0, start, end });
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const kind = /\/\s*>$/.test(m[0]) ? 'self' : 'open';
      tokens.push({ kind, tag, priority: priorityMap.get(tag) ?? 0, start, end });
    }
  }
  return tokens;
}

/** 判断 fromIdx 之后是否存在尚未被同类开标签抵消的 </targetTag>（用于交叉标签时的优先级保护）。 */
function hasUnmatchedCloseAhead(tokens: TagToken[], fromIdx: number, targetTag: string): boolean {
  let depth = 0;
  for (let k = fromIdx + 1; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.tag !== targetTag) continue;
    if (tok.kind === 'open') depth++;
    else if (tok.kind === 'close') {
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** 收集文本中成对顶层保留标签的完整范围 [openStart, closeEnd]，仅用于判断孤儿闭合思考标签是否在正文外部。 */
function findOuterKeepShellRanges(text: string, normalizedKeep: string[]): Array<[number, number]> {
  if (!text || normalizedKeep.length === 0) return [];
  const tokens = tokenizeTags(text, normalizedKeep);
  if (tokens.length === 0) return [];
  const stack: Array<{ tag: string; start: number }> = [];
  const out: Array<[number, number]> = [];
  for (const tok of tokens) {
    if (tok.kind === 'self') continue;
    if (tok.kind === 'open') {
      stack.push({ tag: tok.tag, start: tok.start });
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tok.tag) {
          const start = stack[i].start;
          stack.length = i;
          if (stack.length === 0) out.push([start, tok.end]);
          break;
        }
      }
    }
  }
  return out;
}

function isInsideRanges(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (pos >= s && pos < e) return true;
  }
  return false;
}

function stripTagsCore(
  text: string,
  normalizedStrip: string[],
  keepShellRanges: Array<[number, number]> = [],
): string {
  if (!text || normalizedStrip.length === 0) return text;
  const tokens = tokenizeTags(text, normalizedStrip);
  if (tokens.length === 0) return text;

  const stack: Array<{ tag: string; priority: number; start: number }> = [];
  const ranges: Array<[number, number]> = [];
  const lastRangeIdxByTag = new Map<string, number>();

  for (let tIdx = 0; tIdx < tokens.length; tIdx++) {
    const tok = tokens[tIdx];
    if (tok.kind === 'self') {
      ranges.push([tok.start, tok.end]);
    } else if (tok.kind === 'open') {
      stack.push({ tag: tok.tag, priority: tok.priority, start: tok.start });
    } else {
      let matched = false;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tok.tag) continue;
        let blockedByHigher = false;
        for (let j = i + 1; j < stack.length; j++) {
          if (stack[j].priority < tok.priority && hasUnmatchedCloseAhead(tokens, tIdx, stack[j].tag)) {
            blockedByHigher = true;
            break;
          }
        }
        if (blockedByHigher) break;
        const idx = ranges.length;
        ranges.push([stack[i].start, tok.end]);
        lastRangeIdxByTag.set(tok.tag, idx);
        stack.length = i;
        matched = true;
        break;
      }
      // 当启用了保留标签且保留块外部出现多余的 </thinking> 等闭合思考标签时，说明前文思考内部
      // 顺嘴提到过闭合标签导致提前闭合——将上一次思考剥离区间续延到这枚真实闭标签处。
      if (
        !matched &&
        keepShellRanges.length > 0 &&
        THINKING_RECOVERY_TAGS.has(tok.tag) &&
        !isInsideRanges(tok.start, keepShellRanges)
      ) {
        const prevIdx = lastRangeIdxByTag.get(tok.tag);
        if (prevIdx !== undefined && ranges[prevIdx][1] < tok.end) {
          ranges[prevIdx][1] = tok.end;
        }
      }
    }
  }

  if (ranges.length === 0) return text;

  const merged = mergeRanges(ranges);
  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    if (end <= cursor) continue;
    if (start > cursor) out += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

/**
 * 剥离指定标签对（含内部内容），单遍栈式配对 + 从上到下优先级保护、大小写不敏感、全部出现处。
 */
export function stripContextTags(text: string, tags: string[]): string {
  if (!text || !tags || tags.length === 0) return text;
  const normalized = normalizeContextTags(tags);
  if (normalized.length === 0) return text;
  return stripTagsCore(text, normalized);
}

/** 剥去顶层提取块内部嵌套的成对保留标签壳（只删标签本身，保留内部文字）。 */
function unwrapPairedKeepTagShells(text: string, normalizedKeep: string[]): string {
  const tokens = tokenizeTags(text, normalizedKeep);
  if (tokens.length === 0) return text;
  const stack: Array<{ tag: string; start: number; end: number }> = [];
  const tagRanges: Array<[number, number]> = [];
  for (const tok of tokens) {
    if (tok.kind === 'self') {
      tagRanges.push([tok.start, tok.end]);
    } else if (tok.kind === 'open') {
      stack.push({ tag: tok.tag, start: tok.start, end: tok.end });
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tok.tag) {
          tagRanges.push([stack[i].start, stack[i].end], [tok.start, tok.end]);
          stack.length = i;
          break;
        }
      }
    }
  }
  if (tagRanges.length === 0) return text;
  const merged = mergeRanges(tagRanges);
  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

/**
 * 提取所有成对「保留标签」（如 <content>...</content>、<playtxt>...</playtxt>）的内部正文。
 */
export function extractKeepTagBlocks(text: string, keepTags: string[]): string | null {
  if (!text || !keepTags || keepTags.length === 0) return null;
  const normalized = normalizeContextTags(keepTags);
  if (normalized.length === 0) return null;

  const tokens = tokenizeTags(text, normalized);
  if (tokens.length === 0) return null;

  const stack: Array<{ tag: string; priority: number; openEnd: number }> = [];
  const innerRanges: Array<[number, number]> = [];

  for (let tIdx = 0; tIdx < tokens.length; tIdx++) {
    const tok = tokens[tIdx];
    if (tok.kind === 'self') continue;
    if (tok.kind === 'open') {
      stack.push({ tag: tok.tag, priority: tok.priority, openEnd: tok.end });
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tok.tag) continue;
        let blockedByHigher = false;
        for (let j = i + 1; j < stack.length; j++) {
          if (stack[j].priority < tok.priority && hasUnmatchedCloseAhead(tokens, tIdx, stack[j].tag)) {
            blockedByHigher = true;
            break;
          }
        }
        if (blockedByHigher) break;
        const openEnd = stack[i].openEnd;
        stack.length = i;
        if (stack.length === 0) {
          innerRanges.push([openEnd, tok.start]);
        }
        break;
      }
    }
  }

  if (innerRanges.length === 0) return null;

  const chunks: string[] = [];
  for (const [s, e] of innerRanges) {
    if (e <= s) continue;
    const rawChunk = unwrapPairedKeepTagShells(text.slice(s, e), normalized).trim();
    if (rawChunk) chunks.push(rawChunk);
  }
  return chunks.join('\n\n');
}

export interface CleanContextOptions {
  keepTags?: string[];
  stripTags?: string[];
}

export interface CleanContextResult {
  text: string;
  /** 是否配置了保留标签且当前文本实际命中至少一个成对保留标签块 */
  matchedKeepTag: boolean;
}

/**
 * 综合清洗单条文本（返回结果与是否命中保留标签）：
 * 1. 先按 stripTags（从上到下优先级）剥离思考与外部功能块；
 * 2. 若配置了 keepTags 且剩余文本命中保留标签，则只保留其内部正文并二次剥离内部杂项；
 * 3. 未配置或未命中保留标签时，回退保留第 1 步剥离后的全部内容。
 */
export function cleanContextTextWithMeta(text: string, opts: CleanContextOptions = {}): CleanContextResult {
  const raw = String(text || '');
  if (!raw) return { text: '', matchedKeepTag: false };
  const stripTags = normalizeContextTags(opts.stripTags);
  const keepTags = normalizeContextTags(opts.keepTags);

  const keepShellRanges = keepTags.length > 0 ? findOuterKeepShellRanges(raw, keepTags) : [];
  const afterStrip = stripTags.length > 0 ? stripTagsCore(raw, stripTags, keepShellRanges) : raw;
  if (keepTags.length > 0) {
    const kept = extractKeepTagBlocks(afterStrip, keepTags);
    if (kept !== null) {
      const cleanedKept = stripTags.length > 0 ? stripContextTags(kept, stripTags) : kept;
      return { text: cleanedKept.trim(), matchedKeepTag: true };
    }
  }
  return { text: afterStrip.trim(), matchedKeepTag: false };
}

/** 综合清洗单条文本（剥离标签 → 保留标签提取与二次剥离，未命中保留标签时自动回退）。 */
export function cleanContextText(text: string, opts: CleanContextOptions = {}): string {
  return cleanContextTextWithMeta(text, opts).text;
}

/** 逐条清洗多楼层 AI 消息后再拼接（单楼隔离，杜绝前楼未闭合标签跨楼吞噬后文）。 */
export function cleanContextMessages(
  messages: readonly string[],
  opts: CleanContextOptions & { prefix?: string } = {},
): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const prefix = opts.prefix ?? '';
  const out: string[] = [];
  for (const msg of messages) {
    const cleaned = cleanContextText(msg, opts);
    if (!cleaned) continue;
    out.push(prefix ? prefix + cleaned : cleaned);
  }
  return out.join('\n\n');
}

/** 读取配置并清洗单段文本。仅地图/立绘/瑟瑟指导/正文插图/台账/小手机（MANUAL 模式）调用。 */
export function stripWithContextConfig(text: string): string {
  const cfg = getConfig();
  return cleanContextText(text, {
    keepTags: cfg.contextKeepTags,
    stripTags: cfg.contextStripTags,
  });
}

/** 读取配置并逐条清洗多楼层 AI 回复后拼接（避免跨楼层标签污染）。 */
export function stripWithContextMessages(messages: readonly string[], prefix = ''): string {
  const cfg = getConfig();
  return cleanContextMessages(messages, {
    keepTags: cfg.contextKeepTags,
    stripTags: cfg.contextStripTags,
    prefix,
  });
}
