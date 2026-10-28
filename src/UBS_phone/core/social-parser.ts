// ===== 社媒 AI 回复解析（纯函数，零宿主依赖，可被 .cjs 测试直接 require） =====
// 契约：<ubp_social> 块包裹的 JSON 对象（见 social-prompts 输出格式；每次刷新只含本平台字段）。
// 解析三级容错（三级容错扫描模式）：标签提取 → 整段 JSON.parse → 括号深度配对扫描。
// 朋友圈 author 必须命中通讯录白名单；贴吧/微博/小红书发帖人 70% 是路人（不设白名单）。
// 不做按名屏蔽：主角与角色同名时按名屏蔽会误杀角色内容（反幻觉交由提示词纪律约束）。

import { stripThinkingBlocks, stripHtml } from './chat-parser';
import { SOCIAL_CLOSE_TAG, SOCIAL_OPEN_TAG, lastTagBlock, tagRegex } from './protocol-tags';
import {
  normalizeForumPost,
  normalizeMomentPost,
  normalizeSocialComment,
  normalizeTiebaBar,
  normalizeTiebaPost,
  normalizeTrendingItem,
  normalizeWeiboPost,
  normalizeXhsNote,
  type ForumPost,
  type MomentPost,
  type SocialComment,
  type SocialFeedback,
  type SocialKind,
  type TiebaBar,
  type TiebaPost,
  type TrendingItem,
  type WeiboPost,
  type XhsNote,
} from './social-model';

export interface ParseSocialOptions {
  /** 通讯录白名单（roster contacts 全员）——朋友圈发帖人必须命中；其余平台路人放行。 */
  allowedAuthors: string[];
}

export interface ParseSocialResult {
  moments: MomentPost[];
  /** 贴吧吧列表。 */
  bars: TiebaBar[];
  /** 贴吧置顶（吧规/公告）。 */
  tiebaPinned: TiebaPost | null;
  tiebaPosts: TiebaPost[];
  weiboFeeds: WeiboPost[];
  trending: TrendingItem[];
  xhsNotes: XhsNote[];
  /** 互动反馈项（贴主/评论者对主角动作的回应；按 target+postId 合并回旧帖）。 */
  feedback: SocialFeedback[];
}

/** 名字归一：去空白与装饰符号（对齐 chat-parser）。 */
function normalizeName(value: string): string {
  return value.replace(/^[\s@＠]+|[\s]+$/g, '').trim();
}

/** 白名单解析：精确命中 > 唯一子串命中（「珞」→「珞花」）；歧义/无命中返回 null。 */
function resolveAllowedName(raw: string, allowed: string[]): string | null {
  const name = normalizeName(raw);
  if (!name || name.length > 24) return null;
  if (allowed.includes(name)) return name;
  const hits = allowed.filter(a => a.includes(name) || name.includes(a));
  if (hits.length === 1) return hits[0];
  return null;
}

/** 剥离 markdown 围栏（```json … ```）。 */
function stripCodeFence(text: string): string {
  return text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
}

/** 提取 <ubp_social> 块（取最后一个匹配，防模型重复输出）；无标签时返回整段（交由 JSON 层判定）。 */
export function extractSocialBlock(text: string): string {
  const stripped = stripThinkingBlocks(text);
  const last = lastTagBlock(stripped, SOCIAL_OPEN_TAG, SOCIAL_CLOSE_TAG);
  if (last !== null) return last;
  // 容错：缺闭合标签（截断场景）——取开标签之后全部
  const openIdx = stripped.search(tagRegex(SOCIAL_OPEN_TAG));
  if (openIdx >= 0) return stripped.slice(openIdx + SOCIAL_OPEN_TAG.length);
  return stripCodeFence(stripped);
}

/** 括号深度配对扫描：从第一个 { 或 [ 起找配对闭合，逐段尝试 JSON.parse（跳过坏块）。 */
export function scanJsonObjects(text: string): unknown[] {
  const src = String(text || '');
  const out: unknown[] = [];
  let i = 0;
  while (i < src.length && out.length < 4) {
    const braceIdx = src.indexOf('{', i);
    const bracketIdx = src.indexOf('[', i);
    const open = braceIdx === -1 ? bracketIdx : bracketIdx === -1 ? braceIdx : Math.min(braceIdx, bracketIdx);
    if (open === -1) break;
    const openCh = src[open];
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = open; j < src.length; j++) {
      const ch = src[j];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break;
    const candidate = src.slice(open, end + 1);
    try {
      out.push(JSON.parse(candidate));
    } catch (_e) { /* 跳过坏块 */ }
    i = end + 1;
  }
  return out;
}

/** 解析 AI 输出的 JSON 载荷（多对象时取字段最全的一个）。 */
function parsePayload(block: string): Record<string, unknown> | null {
  const text = stripCodeFence(block);
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text));
  } catch (_e) { /* 走扫描 */ }
  if (!candidates.length) candidates.push(...scanJsonObjects(text));
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const rec = c as Record<string, unknown>;
    const score = ['moments', 'bars', 'pinned', 'posts', 'feeds', 'trending', 'notes', 'feedback'].filter(k => rec[k] !== undefined).length;
    if (score > bestScore) { best = rec; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

/** 评论结构过滤：仅保留对象条目（路人放行；按名屏蔽已废弃——同名会误杀角色评论）。 */
function filterComments(raw: unknown[]): unknown[] {
  return raw.filter(c => Boolean(c) && typeof c === 'object');
}

/** feedback 数组解析：target+postId 必填；论坛旧值丢弃。 */
function parseFeedbackItems(payload: Record<string, unknown>): SocialFeedback[] {
  if (!Array.isArray(payload.feedback)) return [];
  const out: SocialFeedback[] = [];
  for (const raw of payload.feedback.slice(0, 30)) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    if (rec.target !== 'moments' && rec.target !== 'tieba' && rec.target !== 'weibo' && rec.target !== 'xhs') continue;
    const target: SocialKind = rec.target;
    const postId = typeof rec.postId === 'string' ? rec.postId.trim() : '';
    if (!postId) continue;
    const likes = (Array.isArray(rec.likes) ? rec.likes : [])
      .filter((n): n is string => typeof n === 'string' && Boolean(n.trim()))
      .map(n => n.trim().slice(0, 30));
    const comments = (Array.isArray(rec.comments) ? filterComments(rec.comments) : [])
      .map(normalizeSocialComment)
      .filter((c): c is SocialComment => c !== null);
    if (!likes.length && !comments.length) continue;
    out.push({ target, postId, likes, comments });
  }
  return out;
}

/**
 * 解析社媒快照：
 * 1. <ubp_social> 块提取（三级容错）；每次刷新只含本平台字段，其余字段天然为空。
 * 2. 朋友圈 author 白名单过滤（未命中整帖丢弃）；贴吧/微博/小红书发帖人不设白名单
 *    （70% 路人是设计口径）。不做按名屏蔽——主角与角色同名时按名屏蔽会误杀角色内容。
 * 3. 字段归一与长度钳制（social-model normalize 系列）。
 */
export function parseSocialReply(text: string, options: ParseSocialOptions): ParseSocialResult {
  const allowed = options.allowedAuthors.filter(Boolean);
  const result: ParseSocialResult = {
    moments: [], bars: [], tiebaPinned: null, tiebaPosts: [], weiboFeeds: [], trending: [], xhsNotes: [], feedback: [],
  };
  const block = extractSocialBlock(text);
  if (!block.trim()) return result;
  const payload = parsePayload(block);
  if (!payload) return result;

  // 朋友圈动态（熟人广场：作者白名单强过滤）
  if (Array.isArray(payload.moments)) {
    for (const raw of payload.moments.slice(0, 8)) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const authorRaw = typeof rec.author === 'string' ? rec.author : typeof rec.name === 'string' ? rec.name : '';
      if (!authorRaw) continue;
      const author = resolveAllowedName(authorRaw, allowed);
      if (!author) continue; // 朋友圈只发熟人动态——白名单外整帖丢弃
      rec.author = author;
      if (Array.isArray(rec.comments)) rec.comments = filterComments(rec.comments);
      if (Array.isArray(rec.likes)) rec.likes = (rec.likes as unknown[]).filter(n => typeof n === 'string' && Boolean(n.trim()));
      const post = normalizeMomentPost(rec);
      if (post) result.moments.push(post);
    }
  }

  // 贴吧（吧列表 + 置顶 + 帖子；作者 70% 路人不设白名单）
  if (Array.isArray(payload.bars)) {
    result.bars = (payload.bars as unknown[]).slice(0, 12)
      .map(normalizeTiebaBar)
      .filter((b): b is TiebaBar => b !== null);
  }
  const tiebaOf = (raw: unknown, pinned: boolean): TiebaPost | null => {
    if (!raw || typeof raw !== 'object') return null;
    const rec = { ...(raw as Record<string, unknown>) } as Record<string, unknown>;
    const authorRaw = typeof rec.author === 'string' ? rec.author : typeof rec.name === 'string' ? rec.name : '';
    if (!authorRaw) return null;
    rec.author = normalizeName(authorRaw);
    if (Array.isArray(rec.comments)) rec.comments = filterComments(rec.comments);
    if (pinned) rec.pinned = true;
    return normalizeTiebaPost(rec);
  };
  if (payload.pinned && typeof payload.pinned === 'object') {
    result.tiebaPinned = tiebaOf(payload.pinned, true);
  }
  if (Array.isArray(payload.posts)) {
    result.tiebaPosts = (payload.posts as unknown[]).slice(0, 12)
      .map(p => tiebaOf(p, false))
      .filter((p): p is TiebaPost => p !== null);
  }

  // 微博（信息流 + 热搜）
  if (Array.isArray(payload.feeds)) {
    result.weiboFeeds = (payload.feeds as unknown[]).slice(0, 12)
      .map(raw => {
        if (!raw || typeof raw !== 'object') return null;
        const rec = { ...(raw as Record<string, unknown>) } as Record<string, unknown>;
        const authorRaw = typeof rec.author === 'string' ? rec.author : typeof rec.name === 'string' ? rec.name : '';
        if (!authorRaw) return null;
        rec.author = normalizeName(authorRaw);
        if (Array.isArray(rec.comments)) rec.comments = filterComments(rec.comments);
        if (Array.isArray(rec.likes)) delete rec.likes;
        return normalizeWeiboPost(rec);
      })
      .filter((p): p is WeiboPost => p !== null);
  }

  // 热搜
  if (Array.isArray(payload.trending)) {
    result.trending = (payload.trending as unknown[])
      .slice(0, 12)
      .map((t, i) => normalizeTrendingItem(t, i))
      .filter((t): t is TrendingItem => t !== null);
  }

  // 小红书
  if (Array.isArray(payload.notes)) {
    result.xhsNotes = (payload.notes as unknown[]).slice(0, 12)
      .map(raw => {
        if (!raw || typeof raw !== 'object') return null;
        const rec = { ...(raw as Record<string, unknown>) } as Record<string, unknown>;
        const authorRaw = typeof rec.author === 'string' ? rec.author : typeof rec.name === 'string' ? rec.name : '';
        if (!authorRaw) return null;
        rec.author = normalizeName(authorRaw);
        if (Array.isArray(rec.comments)) rec.comments = filterComments(rec.comments);
        return normalizeXhsNote(rec);
      })
      .filter((n): n is XhsNote => n !== null);
  }

  // 互动反馈（贴主/评论者对主角动作的回应）
  result.feedback = parseFeedbackItems(payload);
  return result;
}

/** 已有内容摘要辅助（资料块防重复段的纯文本节选）。 */
export function socialDigestLine(text: string, max = 24): string {
  return stripHtml(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

// normalizeForumPost 仅服务 legacy 存储读回（social-model 直接使用）；此处再导出防误删。
export type { ForumPost };
void normalizeForumPost;
