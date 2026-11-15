// ===== 上下文标签剥离工具 =====
//
// 职责：在「取上下文 → 注入提示词」之间，剥离可配置的标签对（如 <image>...</image>），
// 避免富媒体/渲染标签污染提示词。仅服务于 MANUAL 模式（地图 / 立绘 / 瑟瑟指导 / 正文插图 / 台账 / 小手机）——这些
// 模块自取聊天历史或正文后注入上下文，代码完全掌控上下文文本。
//
// 设计要点（单遍栈式配对，避免顺序循环导致的跨块误吞）：
//   - 统一扫描所有目标标签的开/闭/自闭合 token，按位置栈式配对
//   - 外层闭合标签（如 </thinking>）会自动弹出并作废内部提及的未闭合孤儿标签（如思维链里顺嘴提到的 <options>/<orange>），
//     防止按配置顺序先跑内层标签时一路跨出 </thinking> 把整段正文吞掉
//   - 若某孤儿开标签外侧还有同名成对标签，优先配对最近的（栈顶往下），不误吞正文
//   - 大小写不敏感：<Image> 也剥离；属性兼容：<image src="x">…</image>
//   - 自闭合：<image/>、<image src="x"/> 一并清除
//   - 孤儿开/闭标签（无配对）保留原样，绝不误删正文

import { getConfig } from './config-store';

/** 转义正则元字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 剥离指定标签对（含内部内容），栈式配对、大小写不敏感、全部出现处。
 * 例：stripContextTags('a<image>x</image>b<image>y</image>c', ['image']) === 'abc'
 *     stripContextTags('<thinking>提及<options></thinking><content>正文</content><options>1</options>', ['options', 'thinking'])
 *       === '<content>正文</content>'（不会跨出 </thinking> 吃掉正文）。
 */
export function stripContextTags(text: string, tags: string[]): string {
  if (!text || !tags || tags.length === 0) return text;

  const normalized = Array.from(
    new Set(tags.map((t) => String(t == null ? '' : t).trim().toLowerCase()).filter(Boolean)),
  ).sort((a, b) => b.length - a.length);
  if (normalized.length === 0) return text;

  const alts = normalized.map(escapeRe).join('|');
  const tokenRe = new RegExp(`<\\/(${alts})\\s*>|<(${alts})(?=[\\s/>])[^<>]*>`, 'gi');

  const stack: Array<{ tag: string; start: number }> = [];
  const ranges: Array<[number, number]> = [];

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1]) {
      const closeTag = m[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === closeTag) {
          ranges.push([stack[i].start, end]);
          // 外层闭合时作废其内部尚未闭合的孤儿开标签，避免后续闭标签回连到这里吞掉正文。
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const openTag = m[2].toLowerCase();
      if (/\/\s*>$/.test(m[0])) {
        ranges.push([start, end]);
      } else {
        stack.push({ tag: openTag, start });
      }
    }
  }

  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    if (start > cursor) out += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

/** 读取配置并剥离。仅地图/立绘/瑟瑟指导/正文插图/台账/小手机（MANUAL 模式）调用。 */
export function stripWithContextConfig(text: string): string {
  return stripContextTags(text, getConfig().contextStripTags);
}
