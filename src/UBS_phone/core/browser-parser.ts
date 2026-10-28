// ===== 幻想浏览器 · 解析器（第八轮 §5；第十轮 §1 换自绘页协议）=====
// 第十轮格式（行式结构 + 一个围栏块；不引 YAML 依赖）：
//   <天机阁>
//   问：城西当铺的来历
//   卷宗：                      ← 结果段标题（四风格各一词；解析只看「- 题：」起条）
//   - 题：城西「永昌当」百年沉浮考
//     址：天机阁·卷宗/丁字第七号
//     站：天机阁 · 卷宗府          ← 站点眉（结果列表与分享卡用）
//     徽：报                       ← 可选：站点徽记（1 字）
//     色：#A8322A                  ← 可选：站点主题色
//     摘：三十字上下预览……
//     述：页面描述（分享给好友的唯一读本）
//     页：
//     ```html
//     <style>…</style>
//     <div>…</div>
//     ```
//   </天机阁>
//
// 宽松容错（第十轮新增后半段）：
//   · HTML 围栏认 ```html / ```HTML / ``` / ```htm；**围栏行本身不算内容**；
//   · 没写围栏也吃（`页：` 之后到条目结束全算页面）；
//   · 连 `页：` 都没写，但条目里出现了一个围栏块 → 当页面收（模型漏字段时的兜底）；
//   · 围栏没闭合（模型被截断）→ 收到条目末尾；此时遇到左对齐的「- 题：」仍能起下一条
//     ⇒ 截断不再等于整次失败，前面写好的条目照常可用；
//   · HTML 原样保行（只按最小缩进去公共缩进，不 trim 每行——缩进是 AI 排版的一部分）。
//
// 旧口径（`文：` + 白名单 markdown）继续支持：字段别名、全半角冒号、站/源/述 可选、
// 缺标题条目丢弃、条数截到 6、正文超限截断，全部不变。
// 失败口径：找不到标签块 = null（调用方如实报错，不静默）。

import { MAX_BROWSER_RESULTS } from './browser-model';
import { BROWSER_TAGS, browserBlockRegex } from './protocol-tags';
import type { BrowserPage } from './browser-model';

export interface BrowserParseResult {
  query: string;
  results: BrowserPage[];
}

const FIELD_ALIASES = {
  title: ['题', '标题'],
  url: ['址', '网址', '地址', '链接'],
  site: ['站', '站点', '站名'],
  source: ['源', '来源', '署名'],
  preview: ['摘', '预览', '摘要'],
  desc: ['述', '描述', '简介', '页面描述'],
  html: ['页', '页面', '网页', 'HTML', 'html'],
  mark: ['徽', '徽记', '标'],
  tint: ['色', '主题色', '颜色'],
  content: ['文', '正文'],
} as const;

/** 开围栏：```html / ```HTML / ```htm / ``` （可带尾随空白）。 */
const FENCE_OPEN_RE = /^```(?:html|htm|iframe)?\s*$/i;
/** 闭围栏：单独一行 ``` （允许尾随空白）。 */
const FENCE_CLOSE_RE = /^```\s*$/;
/** 条目起始行（左对齐的「- 题：」）——截断兜底用：围栏没闭合时遇到它立刻收尾起新条。 */
const ENTRY_RE = /^[-*]\s*题\s*[:：]/;

/** 「名：值」行解析（全角/半角冒号；返回 null = 不是字段行）。 */
function fieldOf(line: string): { key: string; value: string } | null {
  const m = /^[-*\s]*([^\s:：]{1,4})\s*[:：]\s*(.*)$/.exec(line);
  if (!m) return null;
  return { key: m[1].trim(), value: m[2].trim() };
}

function matchField(key: string, names: readonly string[]): boolean {
  return names.includes(key);
}

/** 去公共缩进（不 trim 每行；全空返回空串）。 */
function dedent(lines: string[]): string {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    min = Math.min(min, /^[ \t]*/.exec(l)![0].length);
  }
  if (!Number.isFinite(min) || min === 0) return lines.join('\n').trim();
  return lines.map(l => (l.trim() ? l.slice(min) : '')).join('\n').trim();
}

function emptyPage(title = ''): BrowserPage {
  return { url: '', title, site: '', source: '', preview: '', desc: '', html: '', mark: '', tint: '', content: '' };
}

/** 从文本里取**最后一个**浏览器标签块并解析。无块/块内无有效条目 → null。 */
export function parseBrowserReply(text: string): BrowserParseResult | null {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const re = browserBlockRegex();
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) last = m[1];
  if (last !== null) {
    const parsed = parseBrowserBlock(last);
    if (parsed) return parsed;
  }
  // 截断容错：标签没闭合（最后一个开标签之后就是全部内容）——最后这一段当整块解析
  const openAlt = BROWSER_TAGS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const tail = new RegExp(`<(?:${openAlt})>`, 'gi');
  let openAt = -1;
  while ((m = tail.exec(raw)) !== null) openAt = m.index;
  if (openAt >= 0) return parseBrowserBlock(raw.slice(openAt));
  return null;
}

/** 解析块内容（已去标签）。导出供单测直调。 */
export function parseBrowserBlock(block: string): BrowserParseResult | null {
  const lines = String(block || '').replace(/\r\n?/g, '\n').split('\n');
  let query = '';
  let current: BrowserPage | null = null;
  let inContent = false;
  const contentLines: string[] = [];
  // HTML 收集态：inHtml=收集中；htmlFenced=已见到开围栏（决定闭围栏语义）
  let inHtml = false;
  let htmlFenced = false;
  const htmlLines: string[] = [];
  const results: BrowserPage[] = [];

  const flushHtml = (): void => {
    if (!current) { inHtml = false; htmlFenced = false; htmlLines.length = 0; return; }
    const text = dedent(htmlLines);
    if (text) current.html = current.html ? `${current.html}\n${text}` : text;
    inHtml = false;
    htmlFenced = false;
    htmlLines.length = 0;
  };

  const flush = (): void => {
    if (!current) return;
    flushHtml();
    if (contentLines.length) current.content = contentLines.join('\n').trim();
    // 缺标题的条目丢弃（无意义）；标题空但正文/页面有 → 用正文首行兜底，仍空则丢
    if (!current.title && current.content) current.title = current.content.split('\n')[0].slice(0, 120);
    if (current.title || current.content || current.html) results.push(current);
    current = null;
    inContent = false;
    contentLines.length = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const t = line.trim();

    // ── HTML 收集态：整段原样吃，只放行「围栏」与「左对齐的 - 题：」两个出口 ──
    if (inHtml) {
      if (!htmlFenced) {
        if (FENCE_OPEN_RE.test(t)) { htmlFenced = true; continue; } // 围栏行本身不算内容
      } else if (FENCE_CLOSE_RE.test(t)) {
        flushHtml(); continue;
      }
      if (ENTRY_RE.test(line)) flush(); // 截断兜底：围栏没闭合也能起下一条；落到下面正常分支
      else { htmlLines.push(line); continue; }
    }

    if (!t) {
      if (inContent) contentLines.push('');
      continue;
    }

    const f = fieldOf(t);
    if (f) {
      // 新条目：- 题： / 题：
      if (matchField(f.key, FIELD_ALIASES.title)) {
        flush();
        current = emptyPage(f.value);
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.url)) {
        if (current) current.url = f.value;
        else inContent = false;
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.site)) {
        if (current) current.site = f.value;
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.source)) {
        if (current) current.source = f.value;
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.preview)) {
        if (current) current.preview = f.value;
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.desc)) {
        if (current) current.desc = f.value;
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.mark)) {
        if (current) current.mark = f.value;
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.tint)) {
        if (current) current.tint = f.value;
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.html)) {
        if (current) { inContent = false; inHtml = true; htmlFenced = false; if (f.value) htmlLines.push(f.value); }
        continue;
      }
      if (matchField(f.key, FIELD_ALIASES.content)) {
        if (current) { inContent = true; if (f.value) contentLines.push(f.value); }
        continue;
      }
      // 问：/ 结果段标题（卷宗/邸报/晶书/结果/……）等
      if (f.key === '问' || f.key === '搜索词' || f.key === '关键词') {
        if (!query) query = f.value;
        continue;
      }
      // 其余「xx：」在条目内=字段续行，条目外=忽略
      if (current && inContent) contentLines.push(t);
      continue;
    }

    // 裸围栏块兜底：模型漏写「页：」，但条目里出现了一个围栏 → 当页面收（开闭同形，一律按「待闭合」处理）
    if (current && !current.html && !inContent && (FENCE_OPEN_RE.test(t) || FENCE_CLOSE_RE.test(t))) {
      inHtml = true;
      htmlFenced = true;
      continue;
    }

    // 非字段行：条目正文（缩进或普通段落都收）
    if (current) {
      inContent = true;
      contentLines.push(line.replace(/^\s{2}/, '').trim());
    }
  }
  flush();

  if (!results.length) return null;
  return { query: query.slice(0, 80), results: results.slice(0, MAX_BROWSER_RESULTS) };
}
