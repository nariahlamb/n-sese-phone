// ===== 幻想浏览器数据域（第八轮 §5 · N8；第十轮 §1「AI 自绘网页」）=====
// 定位：一个**诚实的幻想浏览器**——AI 按世界观「编」出网页，前端只展示，**绝不发起真实网络请求**。
// 存储：随聊天存档（usb_phone_<h>.json）的 `browser` 域；历史可清、上限 20 次查询。
//
// 第十轮契约变更（用户口径「生成怎样的界面完全交给 AI 决定」）：
//   · BrowserPage 的主交付物从 content（白名单 markdown）换成 html（**AI 自绘的一整张网页**：
//     自带 <style>，标签/配色/版式/动效全由 AI 决定）；content 保留为旧档降级路径。
//   · 视觉放开的代价是执行面必须收紧 ⇒ 渲染走 sandbox iframe（buildBrowserSrcdoc 装配）
//     + meta CSP：无脚本、无外链、无表单、无顶层跳转、唯一源。
//   · 新增可选展示字段 mark（站点徽记 1 字）/ tint（站点主题色）；只用于结果列表的色块，
//     不参与页面本体——页面本体里 AI 想怎么用色就怎么用色。
// 纯函数集中在本模块（normalize / merge / 页面装配 / 旧 markdown 安全渲染 / 地址栏形态）。

import { isRecord } from './ubp-utils';

export interface BrowserPage {
  /** 伪地址（展示用；绝不请求）。 */
  url: string;
  title: string;
  /** 站点眉（站名 · 栏目；详情页顶栏一行。旧档缺省空串）。 */
  site: string;
  /** 署名行（作者 · 时间 · 阅读/回复数；详情页标题下一行。旧档缺省空串）。 */
  source: string;
  /** 结果列表的摘要（30-50 字量级）。 */
  preview: string;
  /** 页面描述（分享给好友时好友只能读到这段——AI 上下文的「[链接]标题：描述」）。 */
  desc: string;
  /** **AI 自绘的一整张网页**（HTML 片段或整档；第十轮主交付物）。空 = 旧档，回落 content。 */
  html: string;
  /** 站点徽记（1 字/emoji；结果列表色块里的字。可选）。 */
  mark: string;
  /** 站点主题色（#rgb/#rrggbb；结果列表色块底色。可选，非法值丢弃）。 */
  tint: string;
  /** 旧档正文（白名单 markdown；仅 html 为空时用于降级渲染）。 */
  content: string;
}

export interface BrowserQuery {
  id: string;
  /** 原始搜索词（随意乱输入也能生成——不做任何语义校验，空串才禁用）。 */
  query: string;
  /** 故事时间快照（盖戳纪律同全机）。 */
  storyTime?: string;
  /** 规范戳（解析不出不盖）。 */
  storyStamp?: string;
  results: BrowserPage[];
  /** 真实时钟：排序/去重。 */
  createdAt: number;
  /** 正文联动来源楼层 id（同层重提取整层替换）。 */
  srcMesId?: string;
}

export interface BrowserData {
  /** 新→旧。 */
  queries: BrowserQuery[];
}

export const MAX_BROWSER_QUERIES = 20;
export const MAX_BROWSER_RESULTS = 6;
/** 旧档正文上限（防字墙；normalize 截断）。 */
export const MAX_BROWSER_CONTENT = 2400;
/**
 * 自绘页面上限。提示词给的预算是每页 1500–3500 字符，这里留约 1.7 倍余量。
 * ★ 这是存储成本的主要来源（20 次查询 × 6 条 × 此上限 = 最坏 720KB 随档），所以不给更大。
 */
export const MAX_BROWSER_HTML = 6000;
const MAX_URL = 200;
const MAX_TITLE = 120;
const MAX_SITE = 60;
const MAX_SOURCE = 140;
const MAX_PREVIEW = 200;
/** 页面描述上限（提示词要求 80-300 字，留一倍余量）。 */
export const MAX_BROWSER_DESC = 600;
const MAX_QUERY = 80;
/** 站点徽记上限（1 个汉字或 1 个 emoji = 最多 2 个 UTF-16 码元）。 */
export const MAX_BROWSER_MARK = 2;
/** 站点主题色：只认 #rgb / #rgba / #rrggbb / #rrggbbaa（防注入进 style 属性）。 */
const TINT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 主题色净化（非法/缺省回落空串）。结果列表徽记与分享卡缩略块共用同一口径。 */
export function normalizeTint(raw: unknown): string {
  const v = clampStr(raw, 16);
  return TINT_RE.test(v) ? v : '';
}

/**
 * 徽记墨色：底色是 AI 自由选的主题色，字必须任何底色下都读得清——
 * 按 sRGB 加权亮度分「浅底写深字 / 深底写白字」两档（纯函数，可单测）。
 * 认不出的色值（''/非法）返回空串＝走 CSS 默认字色（灰块形态）。
 */
export function tintInk(tint: string): string {
  const v = normalizeTint(tint);
  if (!v) return '';
  let hex = v.slice(1);
  if (hex.length === 4 || hex.length === 8) hex = hex.slice(0, 3); // 忽略 alpha：徽记块不透明
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.62 ? '#1B1B1B' : '#FFFFFF';
}

/** 空壳（缺域/脏数据回落用）。 */
export function emptyBrowserData(): BrowserData {
  return { queries: [] };
}

export function normalizeBrowserPage(raw: unknown): BrowserPage | null {
  if (!isRecord(raw)) return null;
  const title = clampStr(raw.title, MAX_TITLE);
  const url = clampStr(raw.url, MAX_URL);
  const content = clampStr(raw.content, MAX_BROWSER_CONTENT);
  const html = clampStr(raw.html, MAX_BROWSER_HTML);
  const preview = clampStr(raw.preview, MAX_PREVIEW);
  const desc = clampStr(raw.desc, MAX_BROWSER_DESC);
  const site = clampStr(raw.site, MAX_SITE);
  const source = clampStr(raw.source, MAX_SOURCE);
  const mark = clampStr(raw.mark, MAX_BROWSER_MARK).replace(/\s+/g, '');
  const tint = normalizeTint(raw.tint);
  // 标题与正文都空 = 无意义条目（丢弃）；只有地址也丢——列表要能读
  if (!title && !content && !html) return null;
  return { url, title: title || url || '无标题', site, source, preview, desc, html, mark, tint, content };
}

export function normalizeBrowserQuery(raw: unknown): BrowserQuery | null {
  if (!isRecord(raw)) return null;
  const query = clampStr(raw.query, MAX_QUERY);
  const results = (Array.isArray(raw.results)
    ? raw.results.map(normalizeBrowserPage).filter((p): p is BrowserPage => p !== null)
    : []).slice(0, MAX_BROWSER_RESULTS);
  if (!query && !results.length) return null;
  const out: BrowserQuery = {
    id: clampStr(raw.id, 60) || `bq_${Math.random().toString(36).slice(2, 10)}`,
    query,
    results,
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
  };
  const storyTime = clampStr(raw.storyTime, 60);
  if (storyTime) out.storyTime = storyTime;
  const storyStamp = clampStr(raw.storyStamp, 60);
  if (storyStamp) out.storyStamp = storyStamp;
  const srcMesId = clampStr(raw.srcMesId, 24);
  if (srcMesId) out.srcMesId = srcMesId;
  return out;
}

/** 域净化：新→旧、同 id 去重、上限 30（丢最旧）。旧档无域=空壳（零迁移）。 */
export function normalizeBrowserData(raw: unknown): BrowserData {
  const list = isRecord(raw) && Array.isArray(raw.queries)
    ? raw.queries.map(normalizeBrowserQuery).filter((q): q is BrowserQuery => q !== null)
    : [];
  list.sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set<string>();
  const deduped: BrowserQuery[] = [];
  for (const q of list) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    deduped.push(q);
  }
  return { queries: deduped.slice(0, MAX_BROWSER_QUERIES) };
}

/** 合并一次查询（新→旧、上限修剪）。srcMesId 水印：同层重提取=整层替换（与社媒同款）。 */
export function mergeBrowserQuery(data: BrowserData, query: BrowserQuery): BrowserData {
  const rest = (data.queries || []).filter(q => {
    if (q.id === query.id) return false;
    if (query.srcMesId && q.srcMesId === query.srcMesId) return false; // 同层重提取整层替换
    return true;
  });
  return { queries: [query, ...rest].slice(0, MAX_BROWSER_QUERIES) };
}

/** 删除一次历史（长按删）。 */
export function deleteBrowserQuery(data: BrowserData, id: string): BrowserData {
  return { queries: (data.queries || []).filter(q => q.id !== id) };
}

/** 链接卡回跳的定位信息（分享时写进 link 载荷；旧卡只有 url/title）。 */
export interface BrowserPageRef {
  /** 来源检索 id（第十一轮：分享落库时记，精确命中用）。 */
  qid?: string;
  /** 结果序号。 */
  idx?: number;
  url?: string;
  title?: string;
}

/**
 * 链接卡 → 浏览器页面定位（三级回落，纯函数可单测）：
 *   ① 精确：qid + idx 指向的那条结果（历史被清空/被顶掉时自然落空）；
 *   ② 同伪地址：历史（新→旧）里第一条同 url 的页面；旧卡（无 qid/idx）也走这级；
 *   ③ 同标题：再退一步比标题（url 都编重了的情况）。
 * 三级都不中 = null（调用方落首页 + 提示）。
 */
export function findBrowserPage(data: BrowserData, ref: BrowserPageRef): { query: BrowserQuery; index: number } | null {
  const queries = data?.queries || [];
  const qid = String(ref?.qid || '');
  const idx = Number(ref?.idx);
  if (qid && Number.isInteger(idx) && idx >= 0) {
    const hit = queries.find(q => q.id === qid);
    if (hit && hit.results[idx]) return { query: hit, index: idx };
  }
  const url = String(ref?.url || '').trim();
  if (url) {
    for (const q of queries) {
      const i = q.results.findIndex(p => p.url === url);
      if (i >= 0) return { query: q, index: i };
    }
  }
  const title = String(ref?.title || '').trim();
  if (title) {
    for (const q of queries) {
      const i = q.results.findIndex(p => p.title === title);
      if (i >= 0) return { query: q, index: i };
    }
  }
  return null;
}

// ─── 自绘页面装配（sandbox iframe 的 srcdoc；第十轮主路径） ───
// 「样式放开」的代价是「执行面必须收紧」，两者互为条件：
//   · srcdoc + sandbox（不给任何令牌）⇒ 无脚本、无表单、无弹窗、无顶层跳转、唯一源；
//   · meta CSP default-src 'none' ⇒ 就算 AI 写漏了外链图片/字体，也不会真的发出请求
//     （这正是「诚实浏览器」的底线：页面上不会去连任何真实站点）。
// 基础脚手架只有 box-sizing/归零/系统字体/默认字色——是脚手架不是限制，AI 的 CSS 在它之后，想覆盖什么都能覆盖。

/** 页面基础脚手架（极简；AI 的 <style> 一律排在它之后，级联覆盖）。 */
const PAGE_BASE_CSS = '*{box-sizing:border-box}html,body{margin:0;padding:0}'
  + 'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;'
  + 'font-size:14.5px;line-height:1.7;color:#1B1B1B;background:#fff;word-break:break-word;-webkit-text-size-adjust:100%}'
  + 'img,svg,video{max-width:100%}';
/** 页面 CSP：默认全禁；只放行内联样式与 data: 图片/字体（页面自绘的全部手段）。 */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; form-action 'none'";

/** 末道防线：剥掉 <script>（沙箱已禁脚本，这里防的是将来有人解开沙箱）。提示词本就禁脚本，正常产出无感。 */
export function stripPageScripts(html: string): string {
  return String(html || '')
    .replace(/<script\b[^>]*?(?:\/>|>[\s\S]*?<\/script\s*>)/gi, '') // 成对/自闭合的
    .replace(/<script\b[\s\S]*$/i, '') // 未闭合的：吃到末尾（宁可多删，也不留半截脚本）
    .replace(/<\/script\s*>/gi, ''); // 孤立的闭标签
}

/** 把 head 片段塞进 AI 交回来的文档：有 <head> 就插进去，只有 <html> 就补一个 head，片段就自己搭骨架。 */
function withHead(raw: string, head: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(raw);
  const rest = (doctype ? raw.slice(doctype[0].length) : raw).trimStart();
  const prefix = '<!doctype html>';
  if (/<head[^>]*>/i.test(rest)) return `${prefix}${rest.replace(/<head[^>]*>/i, m => m + head)}`;
  if (/<html[^>]*>/i.test(rest)) return `${prefix}${rest.replace(/<html[^>]*>/i, m => m + `<head>${head}</head>`)}`;
  const body = /<body[^>]*>/i.test(rest) ? rest : `<body>${rest}</body>`;
  return `${prefix}<html><head>${head}</head>${body}</html>`;
}

/**
 * 自绘页面 → srcdoc 文档（纯函数，可单测）。
 * 片段（AI 只写 <style> + 内容）与整档（AI 写了 <!doctype/<html/<body）都能吃。
 * 空 html → 空串（调用方据此回落旧 markdown 渲染）。
 */
export function buildBrowserSrcdoc(html: string): string {
  const raw = stripPageScripts(html).trim();
  if (!raw) return '';
  const head = '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`
    + `<style>${PAGE_BASE_CSS}</style>`;
  return withHead(raw, head);
}

// ─── 地址栏形态（四风格；纯展示，绝不请求） ───

export interface BrowserUrlStyle {
  /** 首页地址。 */
  home: string;
  /** 结果页地址（q=搜索词，已编码）。 */
  results: (q: string) => string;
}

/** 地址栏形态表（四风格）。与提示词里的伪 URL 示例同源（browser-prompts 引用同一份口径）。 */
export const BROWSER_URL_STYLES: Readonly<Record<string, BrowserUrlStyle>> = {
  modern: { home: 'home://', results: q => `search://results?q=${encodeURIComponent(q)}` },
  xianxia: { home: '天机阁://卷首', results: q => `天机阁://推演?问=${encodeURIComponent(q)}` },
  wuxia: { home: '江湖录://扉页', results: q => `江湖录://探听?问=${encodeURIComponent(q)}` },
  fantasy: { home: '贤者之镜://扉页', results: q => `贤者之镜://窥探?问=${encodeURIComponent(q)}` },
};

/** 当前风格（认不出回落现代）的地址栏形态。 */
export function browserUrlStyle(style: string): BrowserUrlStyle {
  return BROWSER_URL_STYLES[style] || BROWSER_URL_STYLES.modern;
}

// ─── 安全 markdown 渲染（**先全量转义、再插标签**；白名单标签） ───
// ★ 第十轮降级路径：自绘 html 为主，这里只服务「旧档（无 html）」与「AI 没写页字段」两种情况。
//   新产出不再走这条线——但保留它，旧存档打开即仍是可读的网页。
//   ## / ### 标题、- 列表、**粗体**、空行分段（原有四类）
//   > 引文（联系引用并块）、[图：画面描述]（配图位 + 图注）、#标签（话题签）、---（分隔线）
// ★ 顺序不可反：先插标签会把转义器用不了（AI 原文里的 < 会变成真标签）——参考项目的裸 innerHTML 做法不采纳。
// 标记行一律**整行识别**（段落中出现的 > / [图：…] 不作标记），未知语法原样按文本输出。

function escapeAll(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 行内标记：**粗体**（在已转义文本上做，故只会产出 <strong>）。 */
function inlineMd(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** 配图位：[图：画面描述] / 【图】/ [图片:描述]（方/全角括号、有无冒号都认）。 */
const FIG_RE = /^[[【]\s*图(?:片)?\s*[:：]?\s*([^\]】]*?)\s*[\]】]$/;
/** 引文行：> 文本。 */
const QUOTE_RE = /^>\s?(.*)$/;
/** 分隔线：三个以上 - — _。 */
const HR_RE = /^(?:-{3,}|—{3,}|_{3,})$/;
/** 话题签：#标签（# 后紧跟非空白；## 标题在前一步已拦下）。 */
const TAGS_RE = /^#([^#\s].*)$/;

/** 正文 → 白名单 HTML（h2/h3/ul/li/strong/p/br/blockquote/figure/figcaption/div/span/hr）。纯函数、无 DOM 依赖，可单测。 */
export function renderBrowserMarkdown(text: string): string {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];
  const flushPara = (): void => {
    if (!para.length) return;
    out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
    para = [];
  };
  const flushList = (): void => {
    if (!list.length) return;
    out.push(`<ul>${list.map(li => `<li>${inlineMd(li)}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushQuote = (): void => {
    if (!quote.length) return;
    out.push(`<blockquote>${quote.map(inlineMd).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flushFlow = (): void => { flushPara(); flushList(); flushQuote(); };
  for (const line of lines) {
    const t = line.trim();
    if (!t) { flushFlow(); continue; }
    const h3 = /^###\s+(.*)$/.exec(t);
    const h2 = /^##\s+(.*)$/.exec(t);
    const li = /^[-*]\s+(.*)$/.exec(t);
    const fig = FIG_RE.exec(t);
    const qt = QUOTE_RE.exec(t);
    const tags = TAGS_RE.exec(t);
    if (h3) { flushFlow(); out.push(`<h3>${inlineMd(escapeAll(h3[1]))}</h3>`); continue; }
    if (h2) { flushFlow(); out.push(`<h2>${inlineMd(escapeAll(h2[1]))}</h2>`); continue; }
    // ★ 全量转义在这里做（正文/列表项一律先转义；标题行在上面各自的 escapeAll）——
    //   漏一处就等于把 AI 原文当 HTML 塞进 innerHTML（本批单测抓到的真漏洞）。
    if (li) { flushPara(); flushQuote(); list.push(escapeAll(li[1])); continue; }
    if (fig) {
      flushFlow();
      const cap = fig[1] ? `<figcaption>${inlineMd(escapeAll(fig[1]))}</figcaption>` : '';
      out.push(`<figure class="ubp-br-fig"><span class="ubp-br-fig-ph" aria-hidden="true"></span>${cap}</figure>`);
      continue;
    }
    if (qt) { flushPara(); flushList(); quote.push(escapeAll(qt[1])); continue; }
    if (HR_RE.test(t)) { flushFlow(); out.push('<hr class="ubp-br-hr">'); continue; }
    if (tags) {
      flushFlow();
      const chips = tags[1].split(/\s+/).map(x => x.replace(/^#/, '')).filter(Boolean);
      if (chips.length) {
        out.push(`<div class="ubp-br-tags">${chips.map(x => `<span class="ubp-br-tag">#${escapeAll(x)}</span>`).join('')}</div>`);
        continue;
      }
    }
    flushList();
    flushQuote();
    para.push(escapeAll(t));
  }
  flushFlow();
  return out.join('');
}
