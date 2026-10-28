// ===== 统一转发/分享模块（核心侧：帖子快照 → 聊天记录消息） =====
// 社媒帖子（朋友圈/贴吧/微博/小红书）分享到聊天 = 转为 type='chatlog' 消息（整条算一条消息）：
// 卡片标题=来源标签（fwdSrc，如「张三的朋友圈」「微博」），点开逐条看发言人；只带互动文字内容
// （正文/原博/配图/评论），点赞评论转发等计数一律不带（用户定案）。楼中楼压成「（回复 xx）」前缀；
// 成品图直接引用 imagePath（渲染层显示原图，AI 侧经 logEntryBody 仍是「[图片]描述」）。
// 微博转发链（转发卡原博）一并带入。渲染器侧（目标选择弹层/落库）见 renderers/forward-sheet.ts。
// 纯函数零依赖，可被 .cjs 测试直接 require。

import {
  chatlogSummary,
  makeMessageId,
  normalizeLogEntry,
  normalizePhoneMessage,
  type PhoneAlbumSource,
  type PhoneLogEntry,
  type PhoneMessage,
  type PhoneStyle,
} from './chat-model';
import { currentStyle, s } from './skins';

/** 可分享的帖子来源 App（docs/15：三 App 皮肤下恢复，四平台全风格可转发）。 */
export type ShareApp = 'moments' | 'tieba' | 'weibo' | 'xhs' | 'night';

/** 帖子配图（imagePath 存在 ⇔ 成品图直接引用；缺省=只带画面描述）。 */
export interface ShareImage {
  desc: string;
  imagePath?: string;
}

/** 帖子快照（渲染器从各平台类型归一而来，与平台模型解耦）。 */
export interface SharePostSnapshot {
  app: ShareApp;
  author: string;
  /** 帖子标题（贴吧/小红书有；与正文按换行拼接）。 */
  title?: string;
  /** 帖子正文。 */
  text: string;
  images: ShareImage[];
  /** 评论/楼层（replyTo=楼中楼指针）。 */
  comments: Array<{
    name: string;
    text: string;
    replyTo?: string;
    /** 评论配图（贴吧回帖/微博评论低频开放）。 */
    image?: ShareImage;
  }>;
  /** 微博转发卡原博（转发链一并带入；新博文在前原博在后）。 */
  repost?: { author: string; text: string; image?: ShareImage };
}

/** 朋友圈类名词（转发来源标签与图片来源标签共用；不含「的」前缀）。 */
function momentsNoun(style: PhoneStyle): string {
  return s(style, '朋友圈', '浮生帖', '故人笺', '篝火手记');
}

/** 来源标签（转发开头「转发消息：来自于…」的来源段；社媒三平台不注明角色，朋友圈保留作者——用户定案）。 */
export function shareSourceLabel(src: Pick<SharePostSnapshot, 'app' | 'author'>, style: PhoneStyle = currentStyle()): string {
  switch (src.app) {
    case 'weibo': return s(style, '微博', '百晓阁', '悦来茶馆', '吟游诗社');
    case 'tieba': return s(style, '贴吧', '论道坛', '英雄楼', '行会大厅');
    case 'xhs': return s(style, '小红书', '云笈录', '风物志', '藏宝图鉴');
    case 'night': return s(style, '不夜城的帖子', '销金窟的秘帖', '花楼密录的密帖', '夜宴厅的密语');
    default: return `${src.author || '?'}的${momentsNoun(style)}`;
  }
}

// ─── 图片来源标签（相册图 → 文字载体；「来源 App + 发帖人」两段，用户定案） ───
// 画面里出现谁改由配图描述文字承载（社媒/聊天提示词同步要求写清主体），相册条目的 characters 只记发帖人；
// 图片描述离开相册进入会进 AI 请求的载体（聊天消息、社交发帖的配图描述）时前置本标签，
// 使 AI 侧的角色指代不再依赖相册界面上的小字。生图第一步的【图片内容】不拼：发帖人已以角色资料块进请求，
// 且平台名进画面描述有被画成 App 界面的风险；转发整条帖子/社媒投影亦不拼（消息头已写平台、条目已写发帖人）。

/** 图片来源（相册条目的来源信息；拼进图片描述用）。 */
export interface ImageOrigin {
  /** 相册来源 id。 */
  source: PhoneAlbumSource;
  /** 发帖人显示名（相册条目 characters[0]；空=路人发帖或未记录 → 只拼平台名）。 */
  poster: string;
}

/** 社媒来源（有「来源 App + 发帖人」可拼；其余来源的图不带出处，原样返回）。 */
export const SOCIAL_ALBUM_SOURCES: readonly PhoneAlbumSource[] = ['moments', 'tieba', 'weibo', 'xhs', 'night'];

/** 图片来源标签（「小明的朋友圈」「小明的微博」「小红书」；非社媒来源返回空串）。 */
export function imageOriginLabel(source: PhoneAlbumSource, poster: string, style: PhoneStyle = currentStyle()): string {
  if (!SOCIAL_ALBUM_SOURCES.includes(source)) return '';
  const who = (poster || '').trim();
  if (source === 'moments') return who ? `${who}的${momentsNoun(style)}` : momentsNoun(style);
  if (source === 'night') return who ? `${who}的${s(style, '不夜城', '销金窟', '花楼密录', '夜宴厅')}` : s(style, '不夜城', '销金窟', '花楼密录', '夜宴厅');
  const app = shareSourceLabel({ app: source as ShareApp, author: who }, style);
  return who ? `${who}的${app}` : app;
}

/** 图片描述拼来源（「小明的小红书：窗边举着手机自拍」）；描述为空或非社媒来源时原样返回。 */
export function composeImageDesc(desc: string, origin?: ImageOrigin | null, style: PhoneStyle = currentStyle()): string {
  const text = (desc || '').trim();
  if (!text || !origin) return text;
  const label = imageOriginLabel(origin.source, origin.poster, style);
  return label ? `${label}：${text}` : text;
}

/** 单条图 → 记录条目（无描述跳过；imagePath 仅在成品图时由调用方传入）。 */
function imageEntry(from: string, img: ShareImage): PhoneLogEntry | null {
  const desc = (img.desc || '').trim();
  if (!desc) return null;
  return normalizeLogEntry({ from, type: 'image', content: desc, ...(img.imagePath ? { imagePath: img.imagePath } : {}) });
}

/** 帖子快照 → 聊天记录条目（正文 → 原博转发链 → 配图 → 评论；仅互动文字）。 */
export function buildShareEntries(src: SharePostSnapshot): PhoneLogEntry[] {
  const out: PhoneLogEntry[] = [];
  const push = (entry: PhoneLogEntry | null) => { if (entry) out.push(entry); };
  const author = src.author || '?';
  const content = [src.title?.trim(), src.text.trim()].filter(Boolean).join('\n');
  if (content) push(normalizeLogEntry({ from: author, type: 'text', content }));
  if (src.repost?.text.trim()) {
    const rp = src.repost;
    push(normalizeLogEntry({ from: rp.author || author, type: 'text', content: rp.text.trim() }));
    push(imageEntry(rp.author || author, rp.image || { desc: '' }));
  }
  for (const img of src.images) push(imageEntry(author, img));
  for (const c of src.comments) {
    const text = (c.text || '').trim();
    const hasImg = Boolean(c.image?.desc.trim());
    if (!text && !hasImg) continue;
    const name = c.name || '?';
    if (text) push(normalizeLogEntry({ from: name, type: 'text', content: c.replyTo ? `（回复 ${c.replyTo}）${text}` : text }));
    if (hasImg) push(imageEntry(name, c.image!));
  }
  return out;
}

/** 帖子快照 → 分享消息（type='chatlog' + fwdSrc 来源标签；content=摘要兼会话预览；整条算一条消息）。 */
export function buildShareMessage(src: SharePostSnapshot, storyTime?: string): PhoneMessage | null {
  const entries = buildShareEntries(src);
  if (!entries.length) return null;
  return normalizePhoneMessage({
    id: makeMessageId(),
    from: 'me',
    type: 'chatlog',
    content: chatlogSummary(entries),
    fwdSrc: shareSourceLabel(src),
    log: entries,
    ts: Date.now(),
    ...(storyTime ? { storyTime } : {}),
  })!;
}