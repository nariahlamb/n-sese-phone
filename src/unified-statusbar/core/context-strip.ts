// ===== 上下文标签剥离工具 =====
//
// 职责：在「取上下文 → 注入提示词」之间，剥离可配置的标签对（如 <image>...</image>），
// 避免富媒体/渲染标签污染提示词。仅服务于 MANUAL 模式（地图 / 立绘 / 瑟瑟指导 / 正文插图）——这些
// 模块自取聊天历史或正文后注入 user_input，代码完全掌控上下文文本。
//
// 设计要点：
//   - 最短匹配（非贪婪）：每个 <tag> 配最近的 </tag>，多次出现逐个剥离
//   - 大小写不敏感：<Image> 也剥离
//   - 全部剥离：g 标志
//   - 属性兼容：<image src="x">…</image> 也匹配
//   - 自闭合：<image/>、<image src="x"/> 一并清除
//   - 不处理孤儿开/闭标签（只有 <image> 无闭合）——保留原样，避免误删正文
//   - 不动系统提示词，只作用于上下文文本

import { getConfig } from './config-store';

/** 转义正则元字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 剥离指定标签对（含内部内容），最短匹配、大小写不敏感、全部出现处。
 * 例：stripContextTags('a<image>x</image>b<image>y</image>c', ['image']) === 'abc'
 *     不会把 'b' 也吃掉（非贪婪）。
 *     自闭合 <image/> 也会被清除。
 */
export function stripContextTags(text: string, tags: string[]): string {
  if (!text || !tags || tags.length === 0) return text;
  let out = text;
  for (const rawTag of tags) {
    const tag = String(rawTag == null ? '' : rawTag).trim().toLowerCase();
    if (!tag) continue;
    const t = escapeRe(tag);
    // 成对：<tag ...>...</tag>（属性兼容，非贪婪）；自闭合：<tag .../>
    const re = new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${t}>|<${t}(?:\\s[^>]*)?\\/>`, 'gi');
    out = out.replace(re, '');
  }
  return out;
}

/** 读取配置并剥离。仅地图/立绘/瑟瑟指导/正文插图（MANUAL 模式）调用。 */
export function stripWithContextConfig(text: string): string {
  return stripContextTags(text, getConfig().contextStripTags);
}
