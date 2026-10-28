import { parseJsonWith } from './safe-json';
// ===== 正文插图（自动文生图）：AI 输出解析 + 插入定位 + 正文改写（纯函数） =====
// 输出契约（见 story-image-prompts.ts 默认要求提示词）：
//   <UBS_image><UBS_think>…</UBS_think>position: 正文摘录片段\n\nimage###提示词###</UBS_image>
// 契约标签用 UBS_ 前缀避免被酒馆正则替换/通用标签剥离误伤（<image>/<imgthink> 过于通用）；
// 解析器仍兜底旧 <image>/<imgthink> 变体（解析器只提取不剥离，保留可接住沿用旧习惯的模型）。
// 解析容错：`<\UBS_image>` 变体、中文标点、UBS_think 缺失、position/image### 顺序互换。
// 定位：段落（空行分隔）级匹配——规范化精确子串优先，退化为字符 bigram Dice 模糊匹配。

export interface StoryImageBlock {
  /** 插入定位用正文摘录（position: 行原文，去首尾空白）。 */
  positionQuote: string;
  /** 生图提示词（image###…### 内容，已归一标点/空白）。 */
  promptText: string;
  /** 画面构思（imgthink 内容，仅存档展示，不参与生图）。 */
  think: string;
  /** 中文画面描述（desc: 行，随图入库供悬浮查看；旧格式/AI 漏写时为空串）。 */
  description: string;
}

const IMAGE_BLOCK_RE = /<(?:UBS_image|image)>([\s\S]*?)(?:<\/(?:UBS_image|image)>|<\\(?:UBS_image|image)>|$)/gi;
const IMGTHINK_RE = /<(?:UBS_think|imgthink)>([\s\S]*?)(?:<\/(?:UBS_think|imgthink)>|<\\(?:UBS_think|imgthink)>|$)/i;
const POSITION_RE = /position\s*[:：]\s*([^\n\r]+)/i;
const DESC_RE = /desc\s*[:：]\s*([^\n\r]+)/i;
const PROMPT_RE = /image#{2,}([\s\S]*?)#{2,}/i;
// XML 标签等价变体（部分模型习惯输出）：<position>摘录</position>、<prompt>提示词</prompt>，
// 另可能附带 <type>/<aspect_ratio> 等额外标签（忽略不解析）。
const POSITION_TAG_RE = /<position>([\s\S]*?)(?:<\/position>|<\\position>|$)/i;
const DESC_TAG_RE = /<desc>([\s\S]*?)(?:<\/desc>|<\\desc>|$)/i;
const PROMPT_TAG_RE = /<prompt>([\s\S]*?)(?:<\/prompt>|<\\prompt>|$)/i;

/** 中文标点 → ASCII 对应（提示词归一用，与 st-chatu8 换行修复同源）。 */
function normalizePunctuation(input: string): string {
  return input
    .replace(/，/g, ',')
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/。/g, '.')
    .replace(/《/g, '<')
    .replace(/》/g, '>');
}

/** 提示词归一：标点归一 + 压空白（BREAK 容错保留——旧输出可能仍含，结构化解析会自动排除）。 */
export function normalizeStoryPromptText(raw: string): string {
  let text = normalizePunctuation(String(raw || ''));
  // BREAK 两侧保证空格，便于生图端按分隔符切分；其余换行/多空格压成单空格
  text = text.replace(/\bBREAK\b/g, ' BREAK ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\s*;\s*/g, '; ').replace(/;\s*$/g, '');
  return text.trim();
}

// ---------------------------------------------------------------------------
// 多角色结构化解析（解析角色提示词与坐标）
// ---------------------------------------------------------------------------

/** NAI V4/V5 多角色坐标网格（与 st-chatu8 centersToCoordinates 一致）。 */
export interface StoryCharCenters { x: number; y: number; }

/** 一段正文插图提示词拆出的多角色结构（无 Scene/无角色块时返回 null，调用方回退扁平）。 */
export interface StoryMultiChar {
  /** Scene Composition 行内容（场景/人数/分级/构图，进 base_caption）。 */
  scene: string;
  /** 每角色：正向 prompt（已剥 |centers）、负向 UC、坐标。 */
  characters: Array<{ prompt: string; uc: string; centers: StoryCharCenters }>;
}

const CENTER_DEFAULT: StoryCharCenters = { x: 0.5, y: 0.5 };

/**
 * st-chatu8 网格 → NAI 归一化坐标：字母 a–e（x）× 数字 1–5（y），
 * 映射到 {0.1,0.3,0.5,0.7,0.9}。非法网格回退画面正中。
 */
export function centersToCoordinates(grid: string): StoryCharCenters {
  const m = String(grid || '').match(/^([A-Ea-e])([1-5])$/);
  if (!m) return { ...CENTER_DEFAULT };
  const xMap: Record<string, number> = { a: 0.1, b: 0.3, c: 0.5, d: 0.7, e: 0.9 };
  const yMap: Record<string, number> = { '1': 0.1, '2': 0.3, '3': 0.5, '4': 0.7, '5': 0.9 };
  return { x: xMap[m[1].toLowerCase()] ?? 0.5, y: yMap[m[2]] ?? 0.5 };
}

/**
 * 把 image### 内的标签结构拆成 NAI V4/V5 多角色结构：
 *   Scene Composition: <scene>;
 *   Character N Prompt: <prompt>|centers:C2;
 *   Character N UC: <uc>;
 * 各字段以 `;` 结尾。无 Scene Composition 或无角色块 → null（调用方回退扁平单角色 prompt）。
 * 支持 1–4 角色；`|centers` 缺失回退画面正中；残留 BREAK 自然落在字段外被忽略。
 */
export function parseMultiCharPrompt(text: string): StoryMultiChar | null {
  const t = String(text || '').trim();
  if (!t) return null;
  // 各字段以 `;` 分隔；末字段的尾 `;` 已被 normalizeStoryPromptText 剥离，故不要求终止 `;`。
  // 字段内部不含 `;`（DNA 句/UC 用逗号），用 [^;]+ 贪到下一个 `;` 或串尾。
  const sceneMatch = t.match(/Scene Composition\s*:\s*([^;]+)/i);
  if (!sceneMatch) return null;
  const scene = sceneMatch[1].trim();
  const prompts = new Map<number, { prompt: string; centers: StoryCharCenters }>();
  const promptRe = /Character\s+(\d+)\s*Prompt\s*:\s*([^;]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = promptRe.exec(t)) !== null) {
    const n = parseInt(m[1], 10);
    if (!(n >= 1 && n <= 4)) continue;
    let body = m[2].trim();
    let centers: StoryCharCenters = { ...CENTER_DEFAULT };
    const cm = body.match(/\|centers\s*:\s*([A-Ea-e][1-5])\s*$/i);
    // 剥离 centers 后清掉正文残留的结尾分隔符（NAI 多角色 "prompt, |centers:c3" 会留尾逗号）
    if (cm) { centers = centersToCoordinates(cm[1]); body = body.slice(0, cm.index).trim().replace(/[,;，；]+$/, ''); }
    if (body) prompts.set(n, { prompt: body, centers });
  }
  const ucs = new Map<number, string>();
  const ucRe = /Character\s+(\d+)\s*UC\s*:\s*([^;]+)/gi;
  while ((m = ucRe.exec(t)) !== null) {
    const n = parseInt(m[1], 10);
    if (!(n >= 1 && n <= 4)) continue;
    const uc = m[2].trim();
    if (uc) ucs.set(n, uc);
  }
  const characters: StoryMultiChar['characters'] = [];
  for (let n = 1; n <= 4; n++) {
    const p = prompts.get(n);
    if (!p) continue;
    characters.push({ prompt: p.prompt, uc: ucs.get(n) || '', centers: p.centers });
  }
  if (!characters.length) return null;
  return { scene, characters };
}

/**
 * JSON 变体兜底：部分模型无视 position:/image### 契约，输出
 * `<UBS_image>{ "position":"...", "prompt":"..." }</UBS_image>`，或把提示词拆成
 * characters/clothing/pose/scene/composition/quality 等字段。
 * 兜底取 position 字段做定位；prompt 字段优先，否则按生图顺序拼接提示词相关字段。
 * characters 为角色名数组（非提示词）时跳过；仅在主格式（position:/image### 与 <prompt>）匹配失败时启用。
 */
function tryParseJsonImageBlock(content: string): StoryImageBlock | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  // U33：收编 parseJsonWith（对象校验保留在调用方）
  const obj = parseJsonWith<Record<string, unknown> | null>(content.slice(start, end + 1), null);
  if (obj === null) return null;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const positionQuote = String(obj.position || obj.positionQuote || obj.regex || '')
    .trim().replace(/^["'「『]|["'」』]$/g, '');
  if (!positionQuote) return null;
  let raw = '';
  const p = obj.prompt;
  if (typeof p === 'string' && p.trim()) {
    raw = p;
  } else {
    // 拆字段变体：按生图顺序拼接提示词相关字段（排除角色名数组/元数据）
    for (const f of ['characters', 'clothing', 'pose', 'scene', 'composition', 'quality', 'style']) {
      const v = obj[f];
      if (typeof v === 'string' && v.trim()) raw += (raw ? '; ' : '') + v.trim();
    }
  }
  const promptText = normalizeStoryPromptText(raw);
  if (!promptText) return null;
  return { positionQuote, promptText, think: '', description: clampDescription(obj.description || obj.desc) };
}

/** desc 行内容修剪：剥引号 + 压空白 + 截断（悬浮提示用，超长无意义）。 */
function clampDescription(raw: unknown): string {
  const text = String(raw || '')
    .trim()
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/\s+/g, ' ');
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}

/** 剥离 AI 回复中的思考标签（think/thinking）后供解析。 */
export function stripThinkingTags(input: string): string {
  return String(input || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
}

/**
 * 解析 AI 回复中的全部 <UBS_image> 块。
 * 无有效块返回空数组（engine 据此静默跳过）。缺 position 的块丢弃（无法定位），
 * 缺 image### 的块丢弃（无法生图）。
 */
export function parseStoryImageBlocks(input: string, maxImages: number): StoryImageBlock[] {
  const cap = Math.max(1, Math.min(10, Math.floor(maxImages) || 2));
  const text = stripThinkingTags(input);
  const results: StoryImageBlock[] = [];
  IMAGE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_BLOCK_RE.exec(text)) !== null) {
    const content = m[1] || '';
    if (results.length >= cap) break;
    const thinkMatch = content.match(IMGTHINK_RE);
    const think = thinkMatch ? (thinkMatch[1] || '').trim() : '';
    // position/desc 在 imgthink 之后找（imgthink 概括文字可能撞关键词，先剥再匹配）
    const contentWithoutThink = thinkMatch ? content.replace(thinkMatch[0], '') : content;
    // 两种等价格式：position: 行（契约主格式）→ <position> 标签（模型变体）
    const posMatch = contentWithoutThink.match(POSITION_RE) || contentWithoutThink.match(POSITION_TAG_RE);
    // 提示词两种等价格式：image###…### → <prompt> 标签
    const promptMatch = contentWithoutThink.match(PROMPT_RE) || contentWithoutThink.match(PROMPT_TAG_RE);
    if (!posMatch || !promptMatch) {
      // 兜底：JSON 变体（部分模型输出 {"position":"...","prompt":"..."} 或拆字段）
      const jsonBlock = tryParseJsonImageBlock(contentWithoutThink);
      if (jsonBlock) { results.push(jsonBlock); continue; }
      continue;
    }
    const positionQuote = (posMatch[1] || '').trim().replace(/^["'「『]|["'」』]$/g, '');
    const promptText = normalizeStoryPromptText(promptMatch[1] || '');
    if (!positionQuote || !promptText) continue;
    const descMatch = contentWithoutThink.match(DESC_RE) || contentWithoutThink.match(DESC_TAG_RE);
    results.push({ positionQuote, promptText, think, description: descMatch ? clampDescription(descMatch[1]) : '' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 段落定位
// ---------------------------------------------------------------------------

/** 匹配用规范化：去全部空白 + 中英标点（保留字母数字与 CJK 表意字符）。 */
export function normalizeForMatch(input: string): string {
  return String(input || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、""''「」『』（）【】《》…—·ˉ·,.!?;:'"()[\]{}<>~*\-_|/\\#$%^&+=@`]/g, '');
}

/** 按空行切段落（连续非空行为一段），返回段落正文（保留段内原文）。 */
export function splitStoryParagraphs(text: string): string[] {
  const raw = String(text || '').split(/\n/);
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) paragraphs.push(joined);
    current = [];
  };
  for (const line of raw) {
    if (line.trim() === '') flush();
    else current.push(line);
  }
  flush();
  return paragraphs;
}

function charBigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  if (s.length < 2) {
    if (s) map.set(s, 1);
    return map;
  }
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    map.set(bg, (map.get(bg) || 0) + 1);
  }
  return map;
}

/** 字符 bigram Dice 相似度（0~1，多重集合交集计数）。 */
export function bigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = charBigrams(a);
  const B = charBigrams(b);
  let intersection = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [, n] of A) totalA += n;
  for (const [, n] of B) totalB += n;
  for (const [bg, n] of A) {
    const nb = B.get(bg);
    if (nb) intersection += Math.min(n, nb);
  }
  if (totalA + totalB === 0) return 0;
  return (2 * intersection) / (totalA + totalB);
}

/** 段落内最优滑窗相似度：短段直接整体比，长段按 quote 长度滑窗取最大。 */
function paragraphScore(normQuote: string, normPara: string): number {
  if (!normQuote || !normPara) return 0;
  if (normPara.length <= normQuote.length * 2) return bigramSimilarity(normQuote, normPara);
  const winLen = Math.max(4, normQuote.length);
  const step = Math.max(2, Math.floor(winLen / 2));
  let best = 0;
  for (let start = 0; start + Math.min(winLen, 8) <= normPara.length; start += step) {
    const window = normPara.slice(start, start + winLen);
    const score = bigramSimilarity(normQuote, window);
    if (score > best) best = score;
    if (best === 1) break;
  }
  return best;
}

export const STORY_IMAGE_MATCH_THRESHOLD = 0.45;

/**
 * 在段落列表中定位 position 摘录对应的段落（插图插入该段之后）。
 * 精确子串命中优先（多段命中取最后一处——精彩片段偏后文）；否则模糊匹配取最高分段落。
 * 未达阈值返回 null（engine 兜底追加正文末尾）。
 */
export function findInsertionParagraphIndex(paragraphs: string[], quote: string): number | null {
  const normQuote = normalizeForMatch(quote);
  if (!normQuote) return null;
  const normParas = paragraphs.map(normalizeForMatch);
  // ① 精确子串
  let exact = -1;
  for (let i = 0; i < normParas.length; i++) {
    if (normParas[i] && normParas[i].includes(normQuote)) exact = i;
  }
  if (exact >= 0) return exact;
  // ② 模糊最优
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < normParas.length; i++) {
    if (!normParas[i]) continue;
    const score = paragraphScore(normQuote, normParas[i]);
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  if (bestIndex >= 0 && bestScore >= STORY_IMAGE_MATCH_THRESHOLD) return bestIndex;
  return null;
}

// ---------------------------------------------------------------------------
// 正文改写（插图 markdown 注入）
// ---------------------------------------------------------------------------

export interface StoryImageInsertion {
  /** 目标段落序号（splitStoryParagraphs 下标）；null = 追加正文末尾。 */
  paragraph: number | null;
  /** 完整 markdown 图片行，如 ![正文插图](user/images/.../x.png)。 */
  markdown: string;
}

/**
 * 把插图 markdown 插入正文：非空 paragraph 插到该段落最后一行之后（空行分隔），
 * null 追加正文末尾。同段落多图按传入顺序纵向排列。原文本行结构逐字保留。
 */
export function insertImagesIntoMessage(mes: string, insertions: StoryImageInsertion[]): string {
  if (!insertions.length) return mes;
  const lines = String(mes || '').split('\n');
  // 段落 → 最后一行的行号映射（与 splitStoryParagraphs 同空行切分规则）
  const lastLineOfParagraph: number[] = [];
  let paraStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || lines[i].trim() === '';
    if (!blank) {
      if (paraStart < 0) paraStart = i;
    } else if (paraStart >= 0) {
      lastLineOfParagraph.push(i - 1);
      paraStart = -1;
    }
  }
  const appendAtEnd: string[] = [];
  const afterLine = new Map<number, string[]>();
  for (const ins of insertions) {
    if (!ins.markdown) continue;
    if (ins.paragraph === null || ins.paragraph === undefined) {
      appendAtEnd.push(ins.markdown);
      continue;
    }
    const idx = Math.max(0, Math.min(lastLineOfParagraph.length - 1, Math.floor(ins.paragraph)));
    const lineIdx = lastLineOfParagraph[idx];
    if (lineIdx === undefined) { appendAtEnd.push(ins.markdown); continue; }
    const bucket = afterLine.get(lineIdx) || [];
    bucket.push(ins.markdown);
    afterLine.set(lineIdx, bucket);
  }
  if (!afterLine.size && !appendAtEnd.length) return mes;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const bucket = afterLine.get(i);
    if (bucket && bucket.length) {
      for (const md of bucket) { out.push(''); out.push(md); }
    }
  }
  if (appendAtEnd.length) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    for (const md of appendAtEnd) { out.push(''); out.push(md); }
  }
  return out.join('\n');
}

/** 生成插图 markdown（路径为服务器相对路径，酒馆原生渲染）。 */
export function buildStoryImageMarkdown(path: string): string {
  return `![正文插图](${path})`;
}

/**
 * 从正文中移除全部插图 markdown 行（「重新生成插图」用：只清正文不删图库/服务器文件）。
 * 插图行插入时带有前置空行，移除后把 3+ 连续换行压回 1 个空行、并去掉尾随空白
 * （插入路径 appendAtEnd 本就会先吞尾空行，此处还原插入前的原状）。
 */
export function stripStoryImageMarkdown(mes: string): string {
  const lines = String(mes || '').split('\n').filter((l) => !l.includes('![正文插图]('));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/**
 * 从正文中移除指定路径的插图 markdown 行（正文图片删除入口：只删该图，其余插图不动）。
 * 空行还原规则与 stripStoryImageMarkdown 一致；未命中（该楼层无此图）时原样返回。
 * 路径兼容带/不带前导斜杠两种形态（服务器返回 /user/...，markdown 原样使用；点击侧可能拿到任一形态）。
 */
export function removeSingleStoryImageLine(mes: string, path: string): string {
  const raw = String(path || '');
  if (!raw) return mes;
  const norm = raw.startsWith('/') ? raw.slice(1) : raw;
  const markers = [`![正文插图](${norm})`, `![正文插图](/${norm})`];
  const text = String(mes || '');
  if (!markers.some((m) => text.includes(m))) return mes;
  const lines = text.split('\n').filter((l) => !markers.some((m) => l.includes(m)));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------
// 生图失败占位行（点击原位重试；提示词只在引擎会话内存，不持久化）
// ---------------------------------------------------------------------------

/** 占位锚点 href 前缀：#fragment 形态是酒馆消息渲染/DOMPurify 必保留的链接（纯文本行零加载成本）。 */
export const STORY_IMAGE_PENDING_HREF_PREFIX = '#ub-sig-pending-';

/** 占位行 markdown：酒馆渲染成可点击链接，text-viewer 宿主委托拦截点击触发原位重试。 */
export function buildStoryImagePendingMarker(id: string): string {
  return `[正文插图生成失败，点击重试](${STORY_IMAGE_PENDING_HREF_PREFIX}${id})`;
}

/** 提取正文中全部占位 id（去重；装载/切聊天清尸与点击识别共用）。 */
export function findStoryImagePendingMarkerIds(mes: string): string[] {
  const ids: string[] = [];
  const re = /#ub-sig-pending-([a-z0-9-]+)/g;
  const text = String(mes || '');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** 移除指定 id 的占位行（清尸/缓存失效清理用）；未命中原样返回。空行还原规则同 removeSingleStoryImageLine。 */
export function removeStoryImagePendingMarkerLine(mes: string, id: string): string {
  const token = `${STORY_IMAGE_PENDING_HREF_PREFIX}${id}`;
  const text = String(mes || '');
  if (!text.includes(token)) return mes;
  const lines = text.split('\n').filter((l) => !l.includes(token));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/** 把指定 id 的占位行原位替换为插图 markdown 行（重试成功：占位位置即原定插图位置）；未命中返回 null。 */
export function replaceStoryImagePendingMarkerWithImage(mes: string, id: string, markdown: string): string | null {
  const token = `${STORY_IMAGE_PENDING_HREF_PREFIX}${id}`;
  const lines = String(mes || '').split('\n');
  let hit = false;
  const out = lines.map((l) => {
    if (!hit && l.includes(token)) { hit = true; return markdown; }
    return l;
  });
  return hit ? out.join('\n') : null;
}

/** 移除正文中全部占位行（楼层「重新生成插图」整楼重跑前清占位）；返回清理后的正文与被清的 id 列表。 */
export function stripStoryImagePendingMarkers(mes: string): { mes: string; ids: string[] } {
  const ids = findStoryImagePendingMarkerIds(mes);
  let text = String(mes || '');
  for (const id of ids) text = removeStoryImagePendingMarkerLine(text, id);
  return { mes: text, ids };
}
