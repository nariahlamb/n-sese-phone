// ===== 不夜城输出解析（三级容错 + 每 mode 契约 + 反幻觉过滤） =====
// 三级容错（与社媒同纪律）：① 取 <ubp_night> 标签块 → ② 首个 {...} 括号扫描 → ③ 逐字段宽松取值。
// 反幻觉：未知板块丢弃（normalizeNightPost）、悬空 liveRef 丢弃、词表外标签丢弃、gallery 缺图描述降级 text、
// 非法 spice 回落板块默认；作者=主角真名一律丢弃（严禁以主角身份发言，主角署名只能是马甲）。
// 纯函数零依赖（只依赖 night-model / night-config / social-model 的净化器）。

import {
  normalizeNightBarrageList,
  normalizeNightPost,
  normalizeNightLive,
  normalizeNightDm,
  normalizeNightEntry,
  normalizeNightPersona,
  normalizeNightDateNode,
  type NightBarrage,
  type NightDateNode,
  type NightDmMsg,
  type NightEntry,
  type NightLive,
  type NightPersona,
  type NightPost,
} from './night-model';
import { NIGHT_BOARDS, NIGHT_TAGS_PER_POST, normalizeSpice, type NightSpice } from './night-config';
import { NIGHT_CLOSE_TAG, NIGHT_OPEN_TAG } from './protocol-tags';
import type { SocialComment } from './social-model';
import { normalizeSocialComment } from './social-model';
import { isRecord } from './ubp-utils';

export type NightParseMode =
  | 'refresh' | 'board' | 'more' | 'keyword' | 'post'
  | 'live' | 'private' | 'order'
  | 'dm' | 'date'
  | 'persona' | 'aboutMe' | 'commission' | 'unlock'
  | 'alias';

/** 解析上下文（锚定信息由调用方给出，防 AI 改名/换板块）。 */
export interface NightParseContext {
  mode: NightParseMode;
  /** 主角真名（出现的作者名一律丢弃——主角只能以马甲发言）。 */
  me: string;
  /** 主角马甲名（作为作者出现时标记 byMe）。 */
  alias?: string;
  /** 定向生成限定的板块（board/keyword 时帖子只能落在这里；空=不限）。 */
  allowedBoards?: string[];
}

/** 解析结果（各 mode 只填自己那几个字段；调用方按 mode 取用）。 */
export interface NightParseResult {
  boards: string[];
  posts: NightPost[];
  comments: SocialComment[];
  lives: NightLive[];
  /** 台主本轮台词。 */
  lines: string[];
  barrages: NightBarrage[];
  heat: number;
  /** 点单/私钥回应：是否接受 + 拒单理由 + 加码档 + 台主回应。 */
  accepted?: boolean;
  rejectReason?: string;
  tier?: string;
  reply?: string;
  /** 求解锁：作者是否同意。 */
  grant?: boolean;
  /** 私信推进。 */
  online?: boolean;
  sourceLabel?: string;
  distanceLabel?: string;
  msgs: NightDmMsg[];
  /** 约会节点。 */
  dateNode: (NightDateNode & { place?: string; note?: string }) | null;
  persona: NightPersona | null;
  entries: NightEntry[];
  /** 马甲生成。 */
  alias: { alias: string; signature?: string; level?: number; coins?: number } | null;
}

export function emptyNightParseResult(): NightParseResult {
  return {
    boards: [],
    posts: [],
    comments: [],
    lives: [],
    lines: [],
    barrages: [],
    heat: 0,
    msgs: [],
    dateNode: null,
    persona: null,
    entries: [],
    alias: null,
  };
}

function str(value: unknown, maxLen = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 三级容错取 JSON 对象（标签块 → 首个 {...} → null）。 */
export function extractNightObject(text: string): Record<string, unknown> | null {
  const raw = String(text || '');
  const tagStart = raw.indexOf(NIGHT_OPEN_TAG);
  const tagEnd = raw.indexOf(NIGHT_CLOSE_TAG);
  const candidates: string[] = [];
  if (tagStart >= 0 && tagEnd > tagStart) candidates.push(raw.slice(tagStart + NIGHT_OPEN_TAG.length, tagEnd));
  candidates.push(raw);
  for (const candidate of candidates) {
    for (const fragment of [candidate.trim(), braceFragment(candidate), arrayFragment(candidate)]) {
      if (!fragment) continue;
      try {
        const parsed = JSON.parse(fragment);
        if (isRecord(parsed)) return parsed;
        // 顶层是数组（AI 少写了外层对象）→ 包一层，交给各 mode 的宽松取值兜底
        if (Array.isArray(parsed)) return { posts: parsed, comments: parsed, items: parsed, msgs: parsed, entries: parsed, lives: parsed };
      } catch { /* 继续下一候选 */ }
    }
  }
  return null;
}

function braceFragment(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '';
}

function arrayFragment(text: string): string {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '';
}

/** 合法板块 id 集合（含用户自定义板块的宽松放行：只在有 allowedBoards 时才收窄）。 */
function boardAllowed(board: string, ctx: NightParseContext): boolean {
  if (ctx.allowedBoards?.length) return ctx.allowedBoards.includes(board);
  return NIGHT_BOARDS.some(b => b.id === board);
}

/** 帖子集合净化：反幻觉 + 作者过滤 + 板块收窄 + 主角署名转马甲。 */
export function normalizeNightPostsFrom(raw: unknown, ctx: NightParseContext): NightPost[] {
  if (!Array.isArray(raw)) return [];
  const out: NightPost[] = [];
  for (const item of raw) {
    const post = normalizeNightPost(item);
    if (!post) continue;
    if (!boardAllowed(post.board, ctx)) continue; // 未知板块/越界板块丢弃
    if (post.author === ctx.me) continue; // 严禁以主角真名发言
    if (ctx.alias && post.author === ctx.alias) {
      post.byMe = true;
      post.maskedName = ctx.alias;
    }
    // 悬空 liveRef 丢弃（指向不存在的台=点进去空页）
    if (post.liveRef && post.kind !== 'live') post.kind = 'live';
    if (post.kind === 'live' && !post.liveRef) delete post.liveRef;
    if (post.tags.length > NIGHT_TAGS_PER_POST) post.tags = post.tags.slice(0, NIGHT_TAGS_PER_POST);
    out.push(post);
  }
  return out;
}

/** 评论集合净化。 */
export function normalizeNightCommentsFrom(raw: unknown): SocialComment[] {
  if (!Array.isArray(raw)) return [];
  const out: SocialComment[] = [];
  for (const item of raw) {
    const comment = normalizeSocialComment(item);
    if (comment) out.push(comment);
  }
  return out;
}

/**
 * 解析一次生成（按 mode 取用对应字段）。
 * 空对象/无法解析时返回 null（调用方落 parse 错误）。
 */
export function parseNightReply(text: string, ctx: NightParseContext): NightParseResult | null {
  const obj = extractNightObject(text);
  if (!obj) return null;
  const result = emptyNightParseResult();

  // 板块表（refresh/board/more：AI 给的顺序即优先级；未知板块丢弃）
  const rawBoards = Array.isArray(obj.boards) ? obj.boards : [];
  for (const item of rawBoards) {
    const id = typeof item === 'string' ? item.trim() : str(isRecord(item) ? item.id : '', 24);
    if (!id || !NIGHT_BOARDS.some(b => b.id === id)) continue;
    if (!result.boards.includes(id)) result.boards.push(id);
  }

  // 帖子（含 aboutMe 的 items 段）
  const postSource = Array.isArray(obj.posts) ? obj.posts
    : Array.isArray(obj.items) ? obj.items
      : Array.isArray(obj.feed) ? obj.feed : [];
  result.posts = normalizeNightPostsFrom(postSource, ctx);

  // 评论（post 续写 / unlock 回应共用同一数组）
  result.comments = normalizeNightCommentsFrom(obj.comments);

  // 直播间
  const liveSource = Array.isArray(obj.lives) ? obj.lives : Array.isArray(obj.rooms) ? obj.rooms : [];
  for (const item of liveSource) {
    const live = normalizeNightLive(item);
    if (!live) continue;
    if (live.streamer === ctx.me) continue;
    if (ctx.alias && live.streamer === ctx.alias) live.byMe = true;
    result.lives.push(live);
  }

  // 台主台词 / 弹幕 / 热度（private、order、private 私密房共用）
  result.lines = (Array.isArray(obj.lines) ? obj.lines : []).map(l => str(l, 200)).filter(Boolean).slice(0, 6);
  result.barrages = normalizeNightBarrageList(obj.barrages ?? obj.danmaku, 40);
  result.heat = Math.max(0, Math.floor(num(obj.heat ?? obj.heatDelta, 0)));

  // 点单响应
  if (obj.accepted !== undefined) result.accepted = obj.accepted !== false;
  const reject = str(obj.rejectReason ?? obj.reason, 80);
  if (reject) result.rejectReason = reject;
  const tier = str(obj.tier, 6);
  if (tier === '口头' || tier === '动作' || tier === '专场') result.tier = tier;
  const reply = str(obj.reply, 200);
  if (reply) result.reply = reply;

  // 求解锁授权
  if (obj.grant !== undefined) result.grant = obj.grant === true;

  // 私信推进
  if (obj.online !== undefined) result.online = obj.online === true;
  const sourceLabel = str(obj.sourceLabel ?? obj.source, 40);
  if (sourceLabel) result.sourceLabel = sourceLabel;
  const distanceLabel = str(obj.distanceLabel ?? obj.distance, 24);
  if (distanceLabel) result.distanceLabel = distanceLabel;
  const msgSource = Array.isArray(obj.msgs) ? obj.msgs : Array.isArray(obj.messages) ? obj.messages : [];
  if (msgSource.length) {
    const dm = normalizeNightDm({ peer: '_parse_', msgs: msgSource });
    if (dm) result.msgs = dm.msgs;
  }

  // 约会节点
  if (isRecord(obj) && (obj.scene !== undefined || obj.choice !== undefined || obj.lines !== undefined) && ctx.mode === 'date') {
    const node = normalizeNightDateNode({
      scene: obj.scene ?? obj.text,
      lines: obj.lines,
      choice: obj.choice,
      spice: obj.spice,
      time: obj.time,
      storyStamp: obj.storyStamp,
    });
    if (node) {
      result.dateNode = {
        ...node,
        ...(str(obj.place, 40) ? { place: str(obj.place, 40) } : {}),
        ...(str(obj.note, 120) ? { note: str(obj.note, 120) } : {}),
      };
    }
  }

  // 角色档案卡
  if (ctx.mode === 'persona') {
    // 名字由调用方锚定（防 AI 改名）：归一化器要求 name 字段，这里给占位后清回，由引擎填真名
    const persona = normalizeNightPersona({ ...obj, name: str(obj.name, 40) || '__night_persona__' });
    if (persona) result.persona = { ...persona, name: str(obj.name, 40) };
  }

  // 委托应征
  const entrySource = Array.isArray(obj.entries) ? obj.entries : [];
  for (const item of entrySource) {
    const entry = normalizeNightEntry(item);
    if (entry) result.entries.push(entry);
  }

  // 马甲
  if (ctx.mode === 'alias') {
    const alias = str(obj.alias ?? obj.name ?? obj.nickname, 12);
    if (alias && alias !== ctx.me) {
      result.alias = {
        alias,
        ...(str(obj.signature, 60) ? { signature: str(obj.signature, 60) } : {}),
        ...(typeof obj.level === 'number' ? { level: Math.max(1, Math.min(8, Math.floor(obj.level))) } : {}),
        ...(typeof obj.coins === 'number' ? { coins: Math.max(0, Math.min(99999, Math.floor(obj.coins))) } : {}),
      };
    }
  }

  return result;
}

/** 本次解析是否有该 mode 需要的内容（调用方据此判"无法解析"）。 */
export function nightParseHasContent(mode: NightParseMode, result: NightParseResult): boolean {
  switch (mode) {
    case 'refresh': case 'board': case 'more': case 'keyword': return result.posts.length > 0;
    case 'aboutMe': return result.posts.length > 0;
    case 'post': return result.comments.length > 0;
    case 'live': return result.lives.length > 0;
    case 'private': return result.lines.length > 0 || Boolean(result.reply);
    case 'order': return result.lines.length > 0 || Boolean(result.reply) || result.accepted !== undefined;
    case 'dm': return result.msgs.length > 0;
    case 'date': return Boolean(result.dateNode);
    case 'persona': return Boolean(result.persona);
    case 'commission': return result.entries.length > 0;
    case 'unlock': return result.grant !== undefined || result.comments.length > 0;
    case 'alias': return Boolean(result.alias);
    default: return false;
  }
}

/** 解析时的尺度回落（非法 spice → 板块默认；调用方再按板块上限降录一次）。 */
export function spiceOrBoardDefault(value: unknown, board: string): NightSpice {
  const def = NIGHT_BOARDS.find(b => b.id === board);
  return normalizeSpice(value, def?.spiceMax ?? 2);
}
