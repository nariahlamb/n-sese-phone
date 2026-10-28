// ===== 转发/分享目标选择弹层（聊天合并转发与社媒帖子分享共用的落点） =====
// 目标口径（与聊天转发一致）：现有会话（好友申请会话除外）+ 尚无会话的好友；
// 落库 = mutatePhoneData 追加消息 + data-changed 广播（调用方自行 render/吐司）。
// 自挂载 overlay（picker-sheet 模式），不依赖宿主 App 的 overlay 状态机。

import {
  appendMessage,
  conversationPreview,
  ensurePrivateConversation,
  isFriend,
  sortedConversations,
  type PhoneChatData,
  type PhoneMessage,
} from '../core/chat-model';
import { S } from '../core/skins';
import { mutatePhoneData, readPhoneData } from '../core/phone-store';
import { getRoster } from '../core/roster';
import { emitPhoneEvent } from './app-registry';
import { openPickerSheet } from './picker-sheet';

/** 打开「转发给…」目标弹层（单选即点即走；pick='c:会话id' | 'n:好友名'）。 */
export function openForwardTargetSheet(ctx: { container: HTMLElement }, onPick: (pick: string) => void): void {
  let data: PhoneChatData;
  try {
    data = readPhoneData();
  } catch (_e) {
    data = { schema: 1, conversations: [] };
  }
  const friendSet = new Set(data.friends || []);
  const convItems = sortedConversations(data)
    .filter(c => c.kind === 'group' || isFriend(data, c.members[0])) // 申请会话不是转发目标
    .map(c => ({ id: `c:${c.id}`, label: c.title, sub: conversationPreview(c) }));
  const noConvFriends = getRoster().contacts
    .filter(c => friendSet.has(c.name) && !data.conversations.some(cc => cc.id === `p:${c.name}`))
    .map(c => ({ id: `n:${c.name}`, label: c.name, sub: c.brief || c.identity || '好友' }));
  openPickerSheet(ctx.container, {
    title: S('转发给…', '转呈给…'),
    multi: false,
    searchPlaceholder: S('搜索', '寻访'),
    emptyText: S('没有可转发的对象——先去加个好友或开个聊天', '无可转呈之人——先结交一位道友或开启传讯'),
    groups: [
      { key: 'conv', label: S('最近聊天', '近来传讯'), items: convItems },
      ...(noConvFriends.length ? [{ key: 'friends', label: S('好友', '道友'), items: noConvFriends }] : []),
    ],
    onPick,
  });
}

/** 落库到目标会话（'c:会话id'=现有会话；'n:名字'=取或建私聊）。成功=已追加并广播 data-changed。 */
export function appendForwardedMessage(pick: string, message: PhoneMessage): boolean {
  if (!pick.startsWith('c:') && !pick.startsWith('n:')) return false;
  let ok = false;
  mutatePhoneData(d => {
    if (pick.startsWith('c:')) {
      const target = d.conversations.find(c => c.id === pick.slice(2));
      if (target) {
        appendMessage(target, message);
        ok = true;
      }
    } else {
      appendMessage(ensurePrivateConversation(d, pick.slice(2)), message);
      ok = true;
    }
  });
  if (ok) emitPhoneEvent('ubp-phone:data-changed');
  return ok;
}