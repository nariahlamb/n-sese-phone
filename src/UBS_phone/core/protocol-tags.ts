// ===== AI 协议标签：提示词与解析器之间**唯一**的契约锚点（单一事实源） =====
// 每个 AI 域用一对标签块当输出协议：提示词告诉 AI 怎么写，解析器从回复里把块抠出来。
// 两者若各写一份字面量，改一处必漏一处，且失败模式是「编译不报错、运行时解析静默返回 null」
// （内容凭空消失，最难查的一类 bug）。常量集中在此 ⇒ 改一处全链跟随。
//
// 纪律：core/ + renderers/ 的源码里不得再出现这些标签的字面量（除本文件）；
// 各域模块以 `export { X } from './protocol-tags'` 保持既有 import 路径不变（零改调用方）。
// 反向断言见 tests/phone-hardening-contract.test.ts。

export const REPLY_OPEN_TAG = '<ubp_reply>';
export const REPLY_CLOSE_TAG = '</ubp_reply>';
/** 气氛组姓名/性格设定块（与 <ubp_reply> 同一条回复；必须先于 reply 输出）。 */
export const ATMO_OPEN_TAG = '<ubp_atmo>';
export const ATMO_CLOSE_TAG = '</ubp_atmo>';
export const CALL_OPEN_TAG = '<ubp_call>';
export const CALL_CLOSE_TAG = '</ubp_call>';
/** 语音留言（T1）：未接/拒接来电后对方补留；只有 content 字段（无 status/thought）。 */
export const VOICEMAIL_OPEN_TAG = '<ubp_voicemail>';
export const VOICEMAIL_CLOSE_TAG = '</ubp_voicemail>';
export const SPY_OPEN_TAG = '<ubp_spy>';
export const SPY_CLOSE_TAG = '</ubp_spy>';
export const NIGHT_OPEN_TAG = '<ubp_night>';
export const NIGHT_CLOSE_TAG = '</ubp_night>';
export const SOCIAL_OPEN_TAG = '<ubp_social>';
export const SOCIAL_CLOSE_TAG = '</ubp_social>';
export const AUTHOR_OPEN_TAG = '<ubp_author>';
export const AUTHOR_CLOSE_TAG = '</ubp_author>';

/** 「取最后一个标签块」的宽松正则（与各解析器既有口径一致：gi + 取 last）。
 *  标签字符本身不含正则元字符，仍统一转义一次，防将来改标签形态（如加 `-`/`+`）时静默失配。 */
export function tagBlockRegex(open: string, close: string, flags = 'gi'): RegExp {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc(open)}([\\s\\S]*?)${esc(close)}`, flags);
}

// ─── 正文联动·社媒动态标签（第五轮 ⑦） ───
// 与 <微信>/<通话> 族同款纪律：**多标签永久兼容**（任一别名都能解析与渲染），
// 提示词按当前风格只教一个。协议字段按平台不同（见 core/story-link 的平台表）：
//   朋友圈/微博：平台|作者|内容        贴吧：平台|吧名|作者|标题|内容      小红书：平台|作者|标题|内容
export const SOCIAL_POST_TAG_BY_STYLE = {
  modern: '动态',
  xianxia: '风闻',
  wuxia: '榜帖',
  fantasy: '见闻',
} as const;

/** 全部社媒动态标签别名（正则交替用；顺序即文档展示顺序）。 */
export const SOCIAL_POST_TAGS: readonly string[] = Object.values(SOCIAL_POST_TAG_BY_STYLE);

/** 按风格取社媒动态标签（未知风格回落到现代）。 */
export function socialPostTag(style: string): string {
  return (SOCIAL_POST_TAG_BY_STYLE as Record<string, string>)[style] || SOCIAL_POST_TAG_BY_STYLE.modern;
}

/** 单个标签的宽松匹配正则（默认大小写不敏感）：用于只找位置的扫描（对齐各解析器既有的 /i 口径）。 */
export function tagRegex(tag: string, flags = 'i'): RegExp {
  return new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

/** 从文本里取**最后一个**标签块的内容（无块 = null）。各解析器共用同一口径。 */
export function lastTagBlock(text: string, open: string, close: string): string | null {
  const re = tagBlockRegex(open, close);
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) last = match[1];
  return last;
}

// ─── 幻想浏览器标签（第八轮 §5 · N8） ───
// 与社媒动态族同款纪律：**多标签永久兼容**（任一别名都能解析），提示词按当前风格只教一个。
// 块内为行式结构（不引 YAML 依赖）：
//   问：搜索词
//   卷宗：            ← 风格化标题行（现代「结果：」/仙侠「卷宗：」/武侠「邸报：」/西幻「晶书：」）
//   - 题：标题
//     址：伪地址
//     摘：预览
//     文：
//     正文（可含 ## / - / ** 标记）
export const BROWSER_TAG_BY_STYLE = {
  modern: '浏览器',
  xianxia: '天机阁',
  wuxia: '江湖录',
  fantasy: '贤者之镜',
} as const;

/** 全部浏览器标签别名（正则交替用；顺序即文档展示顺序）。 */
export const BROWSER_TAGS: readonly string[] = Object.values(BROWSER_TAG_BY_STYLE);

/** 按风格取浏览器标签（未知风格回落到现代）。 */
export function browserTag(style: string): string {
  return (BROWSER_TAG_BY_STYLE as Record<string, string>)[style] || BROWSER_TAG_BY_STYLE.modern;
}

/** 标签块的宽松正则（任一别名；gi + 取 last，与 tagBlockRegex 同口径）。 */
export function browserBlockRegex(): RegExp {
  const alt = BROWSER_TAGS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`<(?:${alt})>([\\s\\S]*?)</(?:${alt})>`, 'gi');
}

// ─── 网上商城标签（docs/52 · 网上商城） ───
// 与社媒/浏览器族同款纪律：**多标签永久兼容**（任一别名都能解析），提示词按当前风格只教一个。
// 块内为行式结构（不引 YAML 依赖），字段键四风格统一（名/价/币/述/送/铺/图/类/评）：
//   <商城>
//   - 名：九转还魂丹
//     价：1200
//     币：上品灵石
//     述：以三味灵草炼成，服之可续断脉、活死肌。
//     送：3
//     铺：药王谷·百草堂
//     图：🧪
//     类：丹药
//     评：青云门小师弟|药香扑鼻，服下三日便觉经脉通泰
//   </商城>
export const SHOP_TAG_BY_STYLE = {
  modern: '商城',
  xianxia: '万宝阁',
  wuxia: '悦来商行',
  fantasy: '奇物商栈',
} as const;

/** 全部商城标签别名（正则交替用；顺序即文档展示顺序）。 */
export const SHOP_TAGS: readonly string[] = Object.values(SHOP_TAG_BY_STYLE);

/** 按风格取商城标签（未知风格回落到现代）。 */
export function shopTag(style: string): string {
  return (SHOP_TAG_BY_STYLE as Record<string, string>)[style] || SHOP_TAG_BY_STYLE.modern;
}

/** 商城标签块的宽松正则（任一别名；gi + 取 last，与浏览器同口径）。 */
export function shopBlockRegex(): RegExp {
  const alt = SHOP_TAGS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`<(?:${alt})>([\\s\\S]*?)</(?:${alt})>`, 'gi');
}

// ─── 商城消息（商家沟通）标签（docs/54 · 商家会话回复） ───
// 与 <ubp_reply>（微信）同族纪律：一对标签 + 「发言者: 内容」行 + 方括号富媒体前缀；
// 但**发言者恒为本会话店铺名**，富媒体只认四类（图片/红包/改价/新商品）。
export const SHOP_REPLY_OPEN_TAG = '<ubp_shop_reply>';
export const SHOP_REPLY_CLOSE_TAG = '</ubp_shop_reply>';
