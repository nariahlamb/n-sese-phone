// ===== 社媒「通知/动作」动词与内容名词（唯一事实源） =====
// 原先定义在 renderers/social-shell.ts（消息页通知行用）。通知中心（壳层）要拼同一套
// 「谁 + 做了什么」文案，而 renderers 之间互相 import 会成环（social-shell 依赖 phone-ui）——
// 故上提到 core：social-shell 与壳层都从这里取，动词/名词永远只有一份。

import { S } from './skins';
import type { SocialKind, SocialNotifyType } from './social-model';

/** 通知动词（按风格四档；post 需再拼内容名词，见 socialNotifyVerb）。 */
const NOTIFY_VERBS: Record<SocialNotifyType, [string, string, string, string]> = {
  post: ['发布了新', '投了新', '投了新', '投了新'],
  comment: ['评论了你的', '议论了你的', '搭话了你的', '应和了你的'],
  reply: ['回复了你', '回话于你', '回话于你', '回话于你'],
};

/** 平台内容名词（docs/15：贴吧=帖子/坛帖/楼帖/榜文，小红书=笔记/云笈/图志/图鉴，朋友圈=动态/浮生帖/故人笺/篝火手记）。 */
const TARGET_NOUNS: Partial<Record<SocialKind, [string, string, string, string]>> = {
  tieba: ['帖子', '坛帖', '楼帖', '榜文'],
  weibo: ['博文', '风闻', '茶帖', '见闻'],
  xhs: ['笔记', '云笈', '图志', '图鉴'],
  moments: ['动态', '浮生帖', '故人笺', '篝火手记'],
};

/** 平台内容名词（未知平台回落「内容」）。 */
export function socialTargetNoun(kind: SocialKind): string {
  return S(...(TARGET_NOUNS[kind] || ['内容', '内容', '内容', '内容']));
}

/** 通知动作文案：post=「发布了新帖子」（动词+名词），comment/reply 自成一句。 */
export function socialNotifyVerb(kind: SocialKind, type: SocialNotifyType): string {
  return type === 'post' ? `${S(...NOTIFY_VERBS.post)}${socialTargetNoun(kind)}` : S(...NOTIFY_VERBS[type]);
}
