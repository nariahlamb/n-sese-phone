// ===== 游戏中心解析层（纯函数容错；docs/16 §3.3/§4.3） =====
// 输出协议三段：<think>（即时思考）/ <situation>（整局局势分析）/ 行动标签。
// 容错策略继承参考实现：标签 → 标签变形归一 → 全文兜底正则；缺失均不重试（非关键）。

import { UNDERCOVER_WORD_PAIRS } from './game-prompts';
import { detectType } from './chat-parser';

// ─── 台词语音标注拆解（复用聊天的富媒体口径：[语音|情绪|演绎]转写） ───
// 刻意不另写正则：detectType 是 rich-media 注册表驱动的唯一解析出口（chat-parser 注释里已声明
// 「导出供窥私解析器复用同一富媒体口径」），复用可保证游戏台词与聊天语音永不漂移。
// 注意：必须在 cleanSoupLine 之前调用——它会把方括号一并剥掉。

export interface SpeechVoice {
  /** 台词是否带语音标注（是否真发语音条由引擎按坐席决定，这里只描述文本形态）。 */
  tagged: boolean;
  /** 规范八词情绪；''=未标注。 */
  emotion: string;
  /** 演绎说明；''=未标注。 */
  delivery: string;
  /** 剥掉标注后的转写正文。 */
  text: string;
}

/** 拆台词里的语音标注（无标注原样返回）。 */
export function splitSpeechVoice(raw: string): SpeechVoice {
  const src = String(raw ?? '');
  const typed = detectType(src, 'private');
  if (typed && typed.kind === 'message' && typed.type === 'voice') {
    return { tagged: true, emotion: typed.emotion || '', delivery: typed.delivery || '', text: typed.content };
  }
  return { tagged: false, emotion: '', delivery: '', text: src };
}

export interface ParsedTriple {
  think: string;
  situation: string;
  /** 剥除 think/situation 后的剩余正文（行动标签解析的兜底语料）。 */
  rest: string;
}

function stripTags(text: string): string {
  return text
    .replace(/<\s*\/?\s*think\s*>/gi, '')
    .replace(/<\s*\/?\s*situation\s*>/gi, '')
    .trim();
}

/** 三段协议解析：think/situation 缺失均不重试（非关键），rest 供行动标签兜底。 */
export function parseTriple(raw: string): ParsedTriple {
  const text = String(raw || '');
  const mThink = text.match(/<\s*think\s*>([\s\S]*?)<\s*\/\s*think\s*>/i);
  const mSit = text.match(/<\s*situation\s*>([\s\S]*?)<\s*\/\s*situation\s*>/i);
  const rest = stripTags(
    text
      .replace(/<\s*think\s*>[\s\S]*?(<\s*\/\s*think\s*>|$)/gi, '')
      .replace(/<\s*situation\s*>[\s\S]*?(<\s*\/\s*situation\s*>|$)/gi, ''),
  );
  return {
    think: mThink ? mThink[1].trim() : '',
    situation: mSit ? mSit[1].trim() : '',
    rest,
  };
}

// ─── 号位解析（支持中文数字；0=弃票哨兵） ───

const CN_NUM: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

/** 解析号位 token（'3'/'三'/3）；非法返回 0。 */
export function parseSeatToken(token: string | number): number {
  if (typeof token === 'number' && Number.isFinite(token)) return Math.trunc(token);
  const s = String(token || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return CN_NUM[s[0]] ?? 0;
}

/** 从行动块文本提取 VOTE 值（'VOTE: 3' / 'VOTE：三' / 'VOTE: 0'/'弃票'）；未命中返回 null。 */
export function parseVoteAction(text: string): { target: number; skip: boolean } | null {
  const block = text.match(/<\s*VOTE_ACTION\s*>([\s\S]*?)<\/\s*VOTE_ACTION\s*>/i);
  const body = block ? block[1] : text;
  const m = body.match(/VOTE\s*[：:]\s*([\[【（(]?\s*([0-9一二三四五六七八十]+|弃票|skip)\s*[\]】）)]?\s*号?)/i);
  if (m) {
    const token = (m[2] || '').trim();
    if (/弃票|^0$|skip/i.test(token)) return { target: 0, skip: true };
    const n = parseSeatToken(token);
    if (n > 0) return { target: n, skip: false };
  }
  if (/弃票|skip/i.test(body)) return { target: 0, skip: true };
  // 全文兜底：「投给X号位/投X号」
  const hint = body.match(/(?:投给|投票给|投)\s*[\[【（(]?\s*([1-9一二三四五六七八十])\s*号?/i);
  if (hint) {
    const n = parseSeatToken(hint[1]);
    if (n > 0) return { target: n, skip: false };
  }
  return null;
}

// ─── speech 提取（发言/描述/遗言/PK 共用；含半句截断补丁） ───

const INCOMPLETE_TAIL = /[，,、:：—\-与和及或者并并且但是然而因为所以虽然如果]$/;

/** 双字连接词结尾（整词删除更自然）。 */
const TWO_CHAR_TAILS = ['但是', '然而', '因为', '所以', '虽然', '如果', '或者', '并且', '而且', '不过', '于是', '总之'];

/** 半句截断补尾：检测到双字连接词/单字符/悬空标点结尾才补；删词后去悬空标点（tailSuffix 自带连接符）。 */
function fixTrailing(speech: string, tailSuffix: string): string {
  for (const w of TWO_CHAR_TAILS) {
    if (speech.endsWith(w)) {
      return speech.slice(0, -2).replace(/[，,、;；:：]$/, '') + tailSuffix;
    }
  }
  if (INCOMPLETE_TAIL.test(speech)) return speech.replace(INCOMPLETE_TAIL, '') + tailSuffix;
  return speech;
}

export interface ParsedSpeech extends ParsedTriple {
  speech: string;
  /** 语音情绪（规范八词之一；''=台词未带标注）。 */
  emotion: string;
  /** 语音演绎说明（≤40 字；''=未标注）。 */
  delivery: string;
}

/** speech 解析 + 截断补尾（参考实现策略保留精简）；fallbackText=完全无 speech 时的兜底话术。 */
export function parseSpeechReply(raw: string, fallbackText: string, tailSuffix: string): ParsedSpeech {
  const triple = parseTriple(raw);
  const m = triple.rest.match(/<speech>([\s\S]*?)(?:<\/speech>|$)/i);
  let speech = m ? m[1].trim() : '';
  if (!speech) {
    // 无标签：剥除行动块后剩余正文兜底
    const stripped = triple.rest
      .replace(/<\s*VOTE_ACTION\s*>[\s\S]*?(<\/\s*VOTE_ACTION\s*>|$)/gi, '')
      .replace(/<\s*SEER_ACTION\s*>[\s\S]*?(<\/\s*SEER_ACTION\s*>|$)/gi, '')
      .replace(/<\s*WOLF_ACTION\s*>[\s\S]*?(<\/\s*WOLF_ACTION\s*>|$)/gi, '')
      .replace(/<\s*WITCH_ACTION\s*>[\s\S]*?(<\/\s*WITCH_ACTION\s*>|$)/gi, '')
      .trim();
    speech = stripped;
  }
  speech = speech
    .replace(/\*\*/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/【思考原因】|【公开发言】/g, '')
    .trim();
  // 语音标注在截断补尾之前拆走：补尾只落在转写上，标注既不进正文也不进回喂历史。
  const sv = splitSpeechVoice(speech);
  speech = sv.text.trim();
  if (speech) speech = fixTrailing(speech, tailSuffix);
  // 走了兜底话术 = 模型压根没给台词，标注一并丢弃（避免空台词挂个语音条）。
  if (!speech) return { ...triple, speech: fallbackText, emotion: '', delivery: '' };
  return { ...triple, speech, emotion: sv.emotion, delivery: sv.delivery };
}

// ─── 谁是卧底主持人分词解析（两级：格式化字段 → 逐玩家分配 → 高频词反推） ───

export function cleanSpyWord(w: string): string {
  return String(w || '')
    .replace(/[*_`~「」【】\[\]（）()""''"']/g, '')
    .replace(/^[:：\s]+|[:：\s]+$/g, '')
    .trim()
    .slice(0, 20);
}

export interface ParsedSpyWords {
  civilianWord: string;
  spyWord: string;
  /** 号位 → 词（按 AI 分配；空=完全未解析出）。 */
  assignment: Record<number, string>;
}

/** 主持人输出解析；解析不出词对时各字段为 ''（engine 走回退词对池）。 */
export function parseSpyHostReply(raw: string, seats: Array<{ position: number; name: string }>): ParsedSpyWords {
  const text = String(raw || '');
  const mCiv = text.match(/平民词\s*[：:]\s*[【「\[]?([^\n\r，,；;。】」\]]+)[】」\]]?/);
  const mSpy = text.match(/卧底词\s*[：:]\s*[【「\[]?([^\n\r，,；;。】」\]]+)[】」\]]?/);
  const assignment: Record<number, string> = {};
  for (const seat of seats) {
    const escaped = seat.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reg = new RegExp(`(?:${seat.position}\\s*号位|${escaped})[^\\n，,；;。]*?[为是:：=]\\s*[【「\\[]?([^\\n\\r，,；;。】\\]]+)[】\\]]?`, 'i');
    const m = text.match(reg);
    if (m) {
      const w = cleanSpyWord(m[1]);
      if (w) assignment[seat.position] = w;
    }
  }
  let civilianWord = mCiv ? cleanSpyWord(mCiv[1]) : '';
  let spyWord = mSpy ? cleanSpyWord(mSpy[1]) : '';
  // 高频词反推：分配列表中次数最多的=平民词，最少的=卧底词
  const assigned = Object.values(assignment);
  if ((!civilianWord || !spyWord) && assigned.length >= 2) {
    const counts = new Map<string, number>();
    for (const w of assigned) counts.set(w, (counts.get(w) || 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      if (!civilianWord) civilianWord = sorted[0][0];
      if (!spyWord) spyWord = sorted[sorted.length - 1][0];
    }
  }
  if (civilianWord === spyWord) spyWord = '';
  return { civilianWord, spyWord, assignment };
}

/** 回退词对（随机取池中一对）。 */
export function fallbackSpyWordPair(rand: () => number = Math.random): readonly [string, string] {
  return UNDERCOVER_WORD_PAIRS[Math.floor(rand() * UNDERCOVER_WORD_PAIRS.length)] || UNDERCOVER_WORD_PAIRS[0];
}

// ─── 海龟汤解析（docs/16 §9.3；拟题/参与者行动/主持回答/猜底判定/终局揭晓） ───

export interface ParsedSoupPuzzle {
  title: string;
  face: string;
  base: string;
  keyPoints: string[];
}

function cleanSoupLine(w: string): string {
  return String(w || '')
    .replace(/^[:：\s]+/, '')
    .replace(/[*_`~「」【】\[\]《》]/g, '')
    .trim();
}

/** T1 拟题解析：汤名/汤面/汤底/关键点（3~5 条）；任一缺失返回 null（engine 走错误条重试，不设题库兜底——用户定案）。 */
export function parseTurtleSoupPuzzle(raw: string): ParsedSoupPuzzle | null {
  const text = String(raw || '');
  const mTitle = text.match(/汤名\s*[：:]\s*([^\n\r]{1,30})/);
  const mFace = text.match(/汤面\s*[：:]\s*([\s\S]*?)(?=\n\s*汤底\s*[：:]|$)/);
  const mBase = text.match(/汤底\s*[：:]\s*([\s\S]*?)(?=\n\s*关键点\s*[：:]|$)/);
  const kpBlock = text.match(/关键点\s*[：:]?\s*\n?([\s\S]*)$/);
  const title = cleanSoupLine(mTitle?.[1] || '').slice(0, 20);
  const face = cleanSoupLine(mFace?.[1] || '');
  const base = cleanSoupLine(mBase?.[1] || '');
  const keyPoints = (kpBlock ? kpBlock[1] : '')
    .split(/\n+/)
    .map(line => cleanSoupLine(line.replace(/^\s*(?:\d+\s*[.、）)]|[-•*])\s*/, '')))
    .filter(line => line && line.length >= 2)
    .slice(0, 5);
  if (!title || !face || face.length < 20 || !base || base.length < 30 || keyPoints.length < 3) return null;
  return { title, face: face.slice(0, 600), base: base.slice(0, 1200), keyPoints: keyPoints.map(k => k.slice(0, 120)) };
}

export interface ParsedSoupAction {
  kind: 'ask' | 'guess';
  text: string;
  /** 语音情绪（规范八词之一；''=未标注）。 */
  emotion: string;
  /** 语音演绎说明（≤40 字；''=未标注）。 */
  delivery: string;
}

/** T2 参与者行动解析：ASK/GUESS 二选一；标签缺失时全文兜底（AI 无沉默权——解析不出按提问处理）。 */
export function parseTurtleSoupAction(raw: string): ParsedSoupAction {
  const triple = parseTriple(raw);
  const block = triple.rest.match(/<\s*SOUP_ACTION\s*>([\s\S]*?)(?:<\/\s*SOUP_ACTION\s*>|$)/i);
  const body = block ? block[1] : triple.rest;
  // 语音标注必须赶在 cleanSoupLine 之前拆——cleanSoupLine 会把方括号一并剥掉，拆晚了标注就废了。
  const mGuess = body.match(/(?:GUESS|猜底|猜汤底)\s*[：:]\s*([\s\S]+)/i);
  if (mGuess) {
    const gv = splitSpeechVoice(mGuess[1]);
    const guess = cleanSoupLine(gv.text).slice(0, 600);
    if (guess) return { kind: 'guess', text: guess, emotion: gv.emotion, delivery: gv.delivery };
  }
  const mAsk = body.match(/(?:ASK|提问|问题)\s*[：:]\s*([\s\S]+)/i);
  if (mAsk) {
    const av = splitSpeechVoice(mAsk[1]);
    const ask = cleanSoupLine(av.text).replace(/\n[\s\S]*$/, '').slice(0, 300);
    if (ask) return { kind: 'ask', text: ask, emotion: av.emotion, delivery: av.delivery };
  }
  // 全文兜底：剥掉残缺标签后的整段当问题（保证必行动）
  const fv = splitSpeechVoice(body.replace(/<\/?[A-Z_]+>/g, ''));
  const fallback = cleanSoupLine(fv.text).slice(0, 300);
  return fallback
    ? { kind: 'ask', text: fallback, emotion: fv.emotion, delivery: fv.delivery }
    : { kind: 'ask', text: '这件事和某个具体的人有关吗？', emotion: '', delivery: '' };
}

export type SoupAnswerTag = '是' | '不是' | '是也不是' | '不重要';

/** T3 主持人回答解析：ANSWER 四选一 + VOICE 口吻播报；解析不出回落「不重要」（最安全的非承诺回答）。 */
export function parseTurtleSoupAnswer(raw: string): { tag: SoupAnswerTag; voice: string; emotion: string; delivery: string } {
  const text = String(raw || '');
  const block = text.match(/<\s*ANSWER_ACTION\s*>([\s\S]*?)(?:<\/\s*ANSWER_ACTION\s*>|$)/i);
  const body = block ? block[1] : text;
  const mVoice = body.match(/VOICE\s*[：:]\s*([\s\S]*)/i);
  const vv = splitSpeechVoice(mVoice ? mVoice[1] : '');
  const voice = cleanSoupLine(vv.text).slice(0, 60);
  const answerBody = mVoice ? body.slice(0, mVoice.index) : body;
  let tag: SoupAnswerTag | null = null;
  if (answerBody.includes('是也不是') || answerBody.includes('既是又不是')) tag = '是也不是';
  else if (answerBody.includes('不重要') || answerBody.includes('无关')) tag = '不重要';
  else if (answerBody.includes('不是') || /NO/i.test(answerBody)) tag = '不是';
  else if (answerBody.includes('是') || /YES/i.test(answerBody)) tag = '是';
  // 口吻行空着（可留空）时连带丢弃标注，不给空台词挂语音条
  return voice
    ? { tag: tag || '不重要', voice, emotion: vv.emotion, delivery: vv.delivery }
    : { tag: tag || '不重要', voice, emotion: '', delivery: '' };
}

/** T4 猜底判定解析：VERDICT SOLVED/UNSOLVED + COMMENT；解析不出回落 UNSOLVED（不冤判胜利）。 */
export function parseTurtleSoupVerdict(raw: string): { solved: boolean; comment: string } {
  const text = String(raw || '');
  const block = text.match(/<\s*VERDICT_ACTION\s*>([\s\S]*?)(?:<\/\s*VERDICT_ACTION\s*>|$)/i);
  const body = block ? block[1] : text;
  const mComment = body.match(/COMMENT\s*[：:|]\s*([\s\S]*)/i);
  const comment = cleanSoupLine(mComment ? mComment[1] : '').slice(0, 120);
  const verdictBody = mComment ? body.slice(0, mComment.index) : body;
  const solved = /UNSOLVED/i.test(verdictBody) ? false : /SOLVED|还原成功|猜中/i.test(verdictBody);
  return { solved, comment };
}

export interface ParsedSoupReveal {
  speech: string;
  comment: string;
  keyPoints: Array<{ hit: boolean; note: string }>;
}

/** T5 终局揭晓解析：SOUP_REVEAL JSON（speech/comment/keyPoints.hit[]）；解析失败返回 null（engine 错误条重试）。 */
export function parseTurtleSoupReveal(raw: string): ParsedSoupReveal | null {
  const text = String(raw || '');
  const mTag = text.match(/<\s*SOUP_REVEAL\s*>([\s\S]*?)(?:<\/\s*SOUP_REVEAL\s*>|$)/i);
  const body = mTag ? mTag[1] : text;
  const data = extractJsonLoose(body);
  if (!data) return null;
  const speech = typeof data.speech === 'string' ? data.speech.trim().slice(0, 600) : '';
  const comment = typeof data.comment === 'string' ? data.comment.trim().slice(0, 120) : '';
  const keyPoints = (Array.isArray(data.keyPoints) ? data.keyPoints : [])
    .map((k: unknown) => {
      if (k && typeof k === 'object' && !Array.isArray(k)) {
        const o = k as Record<string, unknown>;
        const note = typeof o.note === 'string' ? o.note.trim().slice(0, 150) : '';
        return { hit: o.hit === true, note };
      }
      return null;
    })
    .filter((k: { hit: boolean; note: string } | null): k is { hit: boolean; note: string } => k !== null);
  if (!speech) return null;
  return { speech, comment, keyPoints };
}

// ─── 赛后 A：game_epilogue JSON（三级容错：标签 → 整段 → 括号深度扫描） ───

export interface ParsedEpilogue {
  summary: string;
  moment: {
    author: string;
    text: string;
    comments: Array<{ name: string; text: string }>;
  } | null;
}

function extractJsonLoose(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const body = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch (_e) {
    return null;
  }
}

/** 赛后 A 解析：summary 必须非空才算成功；moment 可缺（发帖人校验由 engine 按参与者名单过滤）。 */
export function parseGameEpilogue(raw: string): ParsedEpilogue | null {
  const text = String(raw || '');
  const mTag = text.match(/<game_epilogue>([\s\S]*?)<\/game_epilogue>/i) || text.match(/<game_epilogue>([\s\S]*)/i);
  const body = mTag ? mTag[1] : text;
  const data = extractJsonLoose(body);
  if (!data) return null;
  const summary = typeof data.summary === 'string' ? data.summary.trim().slice(0, 400) : '';
  if (!summary) return null;
  const out: ParsedEpilogue = { summary, moment: null };
  const rawMoment = data.moment;
  if (rawMoment && typeof rawMoment === 'object' && !Array.isArray(rawMoment)) {
    const m = rawMoment as Record<string, unknown>;
    const author = typeof m.author === 'string' ? m.author.trim().slice(0, 40) : '';
    const text2 = typeof m.text === 'string' ? m.text.trim().slice(0, 400) : '';
    if (author && text2) {
      const comments = (Array.isArray(m.comments) ? m.comments : [])
        .map(c => {
          if (typeof c === 'string') {
            const idx = c.indexOf('|');
            const name = (idx > 0 ? c.slice(0, idx) : '').trim();
            const content = (idx > 0 ? c.slice(idx + 1) : '').trim();
            return name && content ? { name: name.slice(0, 40), text: content.slice(0, 200) } : null;
          }
          if (c && typeof c === 'object' && !Array.isArray(c)) {
            const o = c as Record<string, unknown>;
            const name = typeof o.name === 'string' ? o.name.trim() : '';
            const content = typeof o.text === 'string' ? o.text.trim() : '';
            return name && content ? { name: name.slice(0, 40), text: content.slice(0, 200) } : null;
          }
          return null;
        })
        .filter((c): c is { name: string; text: string } => c !== null);
      out.moment = { author, text: text2, comments };
    }
  }
  return out;
}

// ─── 赛后 B：highlight / afterparty ───

export interface ParsedHighlight {
  highlight: string;
  afterparty: string;
}

export function parseGameHighlight(raw: string): ParsedHighlight {
  const text = String(raw || '');
  const mHl = text.match(/<game_highlight>([\s\S]*?)<\/game_highlight>/i) || text.match(/<game_highlight>([\s\S]*)/i);
  const mAp = text.match(/<game_afterparty>([\s\S]*?)<\/game_afterparty>/i) || text.match(/<game_afterparty>([\s\S]*)/i);
  const clean = (s: string | undefined) => (s || '').replace(/<[^>]+>/g, '').trim();
  // 无标签兜底：整段当高光（复盘聊天缺失可重试）
  const highlight = clean(mHl?.[1]) || (mHl || mAp ? '' : clean(text));
  return { highlight, afterparty: clean(mAp?.[1]) };
}
