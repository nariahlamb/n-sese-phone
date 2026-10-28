// ===== 窥私数据模型（角色间私密互动演绎；纯函数为主，可被 .cjs 测试直接 require） =====
// 存储域 PhoneChatData.spy（usb_phone_<h>.json；SpyData 定义在 chat-model）。
// 会话/通话复用 Conversation/CallRecord 同构：私聊 id 'sp:<A>|<B>'（字典序）、群聊 id 'sg:<id>'，
// 群聊带 owner（群主）；通话记录带 caller（拨出方角色名，'me' 行=拨出方台词）。
// 主角不参与：所有互动只在焦点角色间产生（apply 逐块校验，越界发言/成员一律丢弃）。

import { makeId } from './ubp-utils';
import {
  MAX_SPY_CONVERSATIONS,
  appendMessage,
  isMessageEditable,
  normalizePhoneMessage,
  type Conversation,
  type PhoneChatData,
  type PhoneMessage,
  type PhoneMessageType,
  type SpyData,
} from './chat-model';
import { addCallRecord, deleteCallRecord, normalizeCallLine, type CallLine, type CallRecord } from './call-model';
import { mergeFocusPicks } from './extra-hint';
import type { ParsedSpyBlock } from './spy-parser';

/** 取或建窥私域（旧文件无 spy 字段=零迁移；读取路径已过 normalizeSpyData，防御双保险）。 */
export function ensureSpyDomain(data: PhoneChatData): SpyData {
  if (!data.spy) data.spy = { schema: 1, conversations: [], calls: [], lastRound: 0 };
  return data.spy;
}

/** 窥私未读合计（桌面角标；会话 unread 口径同微信）。 */
export function spyUnreadCount(data: PhoneChatData): number {
  return (data.spy?.conversations || []).reduce((sum, c) => sum + (c.unread || 0), 0);
}

// ─── id 与会话取建 ───

/** 窥隐私聊会话 id（两角色名按字典序归一，同一对角色复用同一会话）。 */
export function spyPrivateId(a: string, b: string): string {
  const [x, y] = [a, b].sort((m, n) => m.localeCompare(n, 'zh'));
  return `sp:${x}|${y}`;
}

/** 取或建窥隐私聊会话（同名/单方返回 null）。
 *  srcMesId=正文联动提取的楼层水印（仅新建时写入；已存在的会话不覆盖——它不是这一层建的）。 */
export function ensureSpyPrivateConversation(data: PhoneChatData, a: string, b: string, srcMesId?: string): Conversation | null {
  if (!a || !b || a === b) return null;
  const id = spyPrivateId(a, b);
  const existing = ensureSpyDomain(data).conversations.find(c => c.id === id);
  if (existing) return existing;
  const now = Date.now();
  const conv: Conversation = {
    id,
    kind: 'private',
    title: `${a}、${b}`,
    members: [a, b],
    messages: [],
    createdAt: now,
    updatedAt: now,
    unread: 0,
    ...(srcMesId ? { srcMesId } : {}),
  };
  data.spy!.conversations.push(conv);
  return conv;
}

/** 取窥私群聊（按群名精确匹配；同名取最近更新者）。 */
export function findSpyGroupByTitle(data: PhoneChatData, title: string): Conversation | null {
  const t = String(title || '').trim();
  if (!t) return null;
  const groups = ensureSpyDomain(data).conversations.filter(c => c.kind === 'group' && c.title === t);
  if (!groups.length) return null;
  return groups.reduce((best, c) => (c.updatedAt > best.updatedAt ? c : best), groups[0]!);
}

/** 建窥私群聊（title/owner/members 已由调用方按焦点集合净化）。 */
export function createSpyGroupConversation(data: PhoneChatData, title: string, owner: string, members: string[]): Conversation {
  const unique = Array.from(new Set(members.map(m => m.trim()).filter(Boolean)));
  const safeOwner = unique.includes(owner.trim()) ? owner.trim() : (unique[0] || '');
  const now = Date.now();
  const conv: Conversation = {
    id: `sg:${Math.random().toString(36).slice(2, 8)}_${now.toString(36)}`,
    kind: 'group',
    title: (title.trim() || (unique.slice(0, 3).join('、') + '群聊')).slice(0, 40),
    ...(safeOwner ? { owner: safeOwner } : {}),
    members: unique,
    messages: [],
    createdAt: now,
    updatedAt: now,
    unread: 0,
  };
  ensureSpyDomain(data).conversations.push(conv);
  return conv;
}

// ─── 焦点随机（引擎编排的纯函数侧；可测试注入 rand） ───

/**
 * 焦点角色随机：pool 已由引擎排除主角与在场角色；洗牌后取前 count 个
 * （人数少于 count 则全部为焦点角色——slice 自然收敛）。
 */
export function selectSpyFocus(pool: readonly string[], count: number, rand: () => number = Math.random): string[] {
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  const n = Math.max(1, Math.floor(count));
  return arr.slice(0, n);
}

/** 焦点群聊随机：窥私已有群聊中「含 ≥3 个焦点人物」的集合随机取一个（无则 null）。 */
export function selectFocusGroup(
  conversations: readonly Conversation[],
  focus: readonly string[],
  rand: () => number = Math.random,
): Conversation | null {
  const focusSet = new Set(focus);
  const candidates = conversations.filter(c =>
    c.kind === 'group' && c.members.filter(m => focusSet.has(m)).length >= 3);
  if (!candidates.length) return null;
  return candidates[Math.floor(rand() * candidates.length)] || null;
}

/** 含 ≥3 焦点人物的已有窥私群聊清单（资料块「已有群聊」段用）。 */
export function listSpyGroupsWithFocus(conversations: readonly Conversation[], focus: readonly string[]): Conversation[] {
  const focusSet = new Set(focus);
  return conversations.filter(c => c.kind === 'group' && c.members.filter(m => focusSet.has(m)).length >= 3);
}

// ─── H′ 既有记录兜底（docs/13：无焦点会话且世界书通道关闭时直读存档） ───

/**
 * 挑与本轮焦点相关的既有会话：成员 ∩ 焦点 ≥ 2 人（私聊 members 恰 2 人 ⇒ 两人都在焦点；
 * 群聊 ≥2 人在场）且有消息；按 updatedAt 新→旧取前 limit 场（默认 3，覆盖「一对私聊+一个群」）。
 * excludeIds 用来剔掉资料块已单独喂过的会话（如焦点群聊段），防同一段重复回喂。
 */
export function pickSpyHistoryConversations(
  conversations: readonly Conversation[],
  focus: readonly string[],
  opts: { limit?: number; excludeIds?: readonly string[] } = {},
): Conversation[] {
  const limit = Math.max(0, Math.floor(opts.limit ?? 3));
  if (!limit) return [];
  const focusSet = new Set(focus);
  const exclude = new Set(opts.excludeIds || []);
  return conversations
    .filter(c => !exclude.has(c.id)
      && c.messages.length > 0
      && c.members.filter(m => focusSet.has(m)).length >= 2)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

// ─── 焦点解析（长按弹窗指定名单 → 引擎编排的纯函数侧） ───

export interface SpyFocusResolution {
  focus: string[];
  /** 选中但不在池内的名字（回传渲染层明示「已忽略」，防静默换人）。 */
  dropped: string[];
}

/**
 * 焦点解析：strict=只用选中（∩ 池，不随机补足），有效焦点 <2 返回 null（窥私至少两人才能对话，
 * 引擎据此抛 PhoneChatError）；非 strict=mergeFocusPicks 口径（去重过滤出池 + 不足随机补足到 target）。
 */
export function resolveSpyFocus(
  picks: readonly string[],
  pool: readonly string[],
  target: number,
  strict: boolean,
  rand: () => number = Math.random,
): SpyFocusResolution | null {
  const poolSet = new Set(pool);
  const uniq = Array.from(new Set(picks.filter(Boolean)));
  const dropped = uniq.filter(n => !poolSet.has(n));
  if (strict) {
    const focus = uniq.filter(n => poolSet.has(n));
    return focus.length >= 2 ? { focus, dropped } : null;
  }
  return { focus: mergeFocusPicks(uniq, pool, target, rand), dropped };
}

// ─── 会话删除（整组；私聊/群聊同路径） ───

/** 按 id 删除整组窥私会话（私聊=这条两人会话；群聊=整群）。私聊 id 是确定性生成（字典序两人），
 *  删除后同一对人重新生成会新建空会话——由确认弹窗文案点明。返回是否确有删除。 */
export function deleteSpyConversation(data: PhoneChatData, convId: string): boolean {
  const spy = data.spy;
  if (!spy || !convId) return false;
  const before = spy.conversations.length;
  spy.conversations = spy.conversations.filter(c => c.id !== convId);
  return spy.conversations.length < before;
}

/** 按 id 删除窥私通话记录（只删这条转写，不动会话列表）。返回是否确有删除。 */
export function deleteSpyCall(data: PhoneChatData, recordId: string): boolean {
  const spy = data.spy;
  if (!spy || !recordId) return false;
  const before = spy.calls.length;
  spy.calls = deleteCallRecord(spy.calls, recordId);
  return spy.calls.length < before;
}

// ─── 多选操作条状态（纯函数：渲染与就地同步共用同一份计算，消灭模板/同步双写面） ───

export interface SpySelbarState {
  /** 恰好单选且该条可编辑（文字/语音；复用微信 isMessageEditable 判定）。 */
  canEdit: boolean;
  /** 任一选中。 */
  canDelete: boolean;
  /** 已选满全部可选行（系统消息不可选）。 */
  allSelected: boolean;
}

/** 窥私会话多选操作条状态（canEdit/canDelete/allSelected 渲染与 syncSelUi 共用）。 */
export function spySelbarState(selected: ReadonlySet<string>, messages: readonly PhoneMessage[]): SpySelbarState {
  const selectableCount = messages.filter(m => m.from !== 'system').length;
  const selCount = messages.filter(m => m.from !== 'system' && selected.has(m.id)).length;
  const single = selCount === 1 ? messages.find(m => selected.has(m.id)) : undefined;
  return {
    canEdit: isMessageEditable(single),
    canDelete: selCount > 0,
    allSelected: selectableCount > 0 && selCount >= selectableCount,
  };
}

// ─── 解析结果落库 ───

/** 单块应用结果（index.ts 据此刷 UI）。 */
export interface SpyApplyOutcome {
  ok: boolean;
  kind: 'call' | 'private' | 'group';
  conversationId?: string;
  recordId?: string;
  /** 丢弃原因（校验失败）。 */
  reason?: 'invalid-parties' | 'empty' | 'invalid-action';
}

/** 窥私会话条数收敛（按 updatedAt 新→旧保留前 MAX_SPY_CONVERSATIONS 个）。
 *  导出给正文联动提取复用（它也会新建窥私会话；同一收敛口径）。 */
export function pruneSpyConversations(spy: SpyData): void {
  if (spy.conversations.length <= MAX_SPY_CONVERSATIONS) return;
  spy.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  spy.conversations.splice(MAX_SPY_CONVERSATIONS);
}

/** 消息 → PhoneMessage（ts=批次基点+序号，保序；storyTime=全局时间快照）。 */
function toPhoneMessage(
  sender: string,
  type: PhoneMessageType,
  content: string,
  amount: string | undefined,
  ts: number,
  storyTime?: string,
): PhoneMessage | null {
  return normalizePhoneMessage({
    id: makeId('spy_'),
    from: sender,
    type,
    content,
    ts,
    ...(storyTime ? { storyTime } : {}),
    ...(amount ? { amount } : {}),
  });
}

/**
 * 解析结果批应用到窥私域（纯函数直改 data；引擎经 mutatePhoneData 调用，测试可直接调）。
 * 校验口径：全部当事人必须是焦点角色（越界块/越界动作/越界发言一律丢弃）；
 * 群聊按标题复用已有群（AI 侧的群主/成员头行仅建群时生效），[拉人] 仅群主有效。
 */
export function applySpyBlocks(
  data: PhoneChatData,
  blocks: readonly ParsedSpyBlock[],
  ctx: { focus: readonly string[]; storyTime?: string; avatarFor?: (name: string) => string | undefined; maxBlocks: number },
): SpyApplyOutcome[] {
  const focusSet = new Set(ctx.focus);
  const spy = ensureSpyDomain(data);
  const outcomes: SpyApplyOutcome[] = [];
  for (const block of blocks) {
    if (outcomes.filter(o => o.ok).length >= ctx.maxBlocks) break;
    const parties = block.parties.filter(p => focusSet.has(p));
    if (parties.length !== block.parties.length) {
      outcomes.push({ ok: false, kind: block.kind, reason: 'invalid-parties' });
      continue;
    }
    const baseTs = Date.now();
    if (block.kind === 'call') {
      const [caller, callee] = block.parties;
      if (!caller || !callee || caller === callee) {
        outcomes.push({ ok: false, kind: 'call', reason: 'invalid-parties' });
        continue;
      }
      const lines: CallLine[] = block.items
        .filter((item): item is Extract<typeof item, { kind: 'message' }> => item.kind === 'message')
        .map((m, i) => normalizeCallLine({
          from: m.sender === caller ? 'me' : 'peer',
          text: m.content,
          relSec: i * 8,
        }))
        .filter((l): l is CallLine => l !== null);
      const record: CallRecord = {
        id: `scr_${baseTs.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        peerName: callee,
        ...(ctx.avatarFor?.(callee) ? { peerAvatar: ctx.avatarFor!(callee) } : {}),
        direction: block.missed ? 'incoming' : 'outgoing',
        ...(caller ? { caller } : {}),
        status: block.missed ? 'missed' : 'answered',
        durationSec: block.missed ? 0 : (block.durationSec ?? (lines_lastRelSec(lines) || 0)),
        startedAt: baseTs,
        ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
        lines,
        seen: false,
      };
      if (!block.missed && !lines.length) {
        outcomes.push({ ok: false, kind: 'call', reason: 'empty' });
        continue;
      }
      spy.calls = addCallRecord(spy.calls, record);
      outcomes.push({ ok: true, kind: 'call', recordId: record.id });
      continue;
    }
    if (block.kind === 'private') {
      const [a, b] = block.parties;
      const conv = ensureSpyPrivateConversation(data, a || '', b || '');
      if (!conv) {
        outcomes.push({ ok: false, kind: 'private', reason: 'invalid-parties' });
        continue;
      }
      let appended = 0;
      for (const item of block.items) {
        if (item.kind !== 'message') continue;
        const message = toPhoneMessage(item.sender, item.type, item.content, item.amount, baseTs + appended, ctx.storyTime);
        if (!message) continue;
        appendMessage(conv, message);
        conv.unread += 1;
        appended++;
      }
      if (!appended) {
        outcomes.push({ ok: false, kind: 'private', reason: 'empty' });
        continue;
      }
      conv.updatedAt = baseTs;
      outcomes.push({ ok: true, kind: 'private', conversationId: conv.id });
      continue;
    }
    // 群聊：按标题复用已有群；无命中=新建（title/owner/members 经焦点集合净化）
    const title = String(block.title || '').trim();
    let conv = title ? findSpyGroupByTitle(data, title) : null;
    if (!conv) {
      const members = block.parties.filter(p => focusSet.has(p));
      if (members.length < 3) {
        outcomes.push({ ok: false, kind: 'group', reason: 'invalid-parties' });
        continue;
      }
      conv = createSpyGroupConversation(data, title || '', block.owner || '', members);
    }
    const members = new Set(conv.members);
    let appended = 0;
    for (const item of block.items) {
      if (item.kind === 'action') {
        if (item.action === 'add-member') {
          // 群主拉人：目标必须是焦点角色且不在群中；非群主动作丢弃
          if (item.sender !== conv.owner || !focusSet.has(item.target) || members.has(item.target)) {
            continue;
          }
          members.add(item.target);
          conv.members.push(item.target);
          appendMessage(conv, {
            id: makeId('spy_'),
            from: 'system',
            type: 'text',
            content: `${item.sender} 邀请 ${item.target} 加入了群聊`,
            ts: baseTs + appended,
            ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
          });
          appended++;
          continue;
        }
        // 退群：移出成员（后续发言按成员名单自然丢弃）
        if (!members.has(item.sender)) continue;
        members.delete(item.sender);
        conv.members = conv.members.filter(m => m !== item.sender);
        appendMessage(conv, {
          id: makeId('spy_'),
          from: 'system',
          type: 'text',
          content: `${item.sender} 退出了群聊${item.reason ? `（${item.reason}）` : ''}`,
          ts: baseTs + appended,
          ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
        });
        appended++;
        continue;
      }
      if (!members.has(item.sender)) continue; // 越界发言（未入群/已退群）丢弃
      const message = toPhoneMessage(item.sender, item.type, item.content, item.amount, baseTs + appended, ctx.storyTime);
      if (!message) continue;
      appendMessage(conv, message);
      conv.unread += 1;
      appended++;
    }
    if (!appended) {
      outcomes.push({ ok: false, kind: 'group', reason: 'empty' });
      continue;
    }
    conv.updatedAt = baseTs;
    outcomes.push({ ok: true, kind: 'group', conversationId: conv.id });
  }
  pruneSpyConversations(spy);
  return outcomes;
}

function lines_lastRelSec(lines: readonly CallLine[]): number {
  return lines.length ? lines[lines.length - 1]!.relSec + 10 : 0;
}

/** 清空窥私域（设置-功能-窥私-清空按钮）。 */
export function clearSpyData(data: PhoneChatData): void {
  data.spy = null;
}