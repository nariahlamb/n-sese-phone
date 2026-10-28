// ===== 统一状态栏外部剧情存储 · 消息锚点助手 =====
//
// 锚点体系（角色无关，V3 起为唯一体系）：
// - 写入/读取身份**角色无关**（['message', stable] 等）——外部扩展（隐藏助手等）标记
//   is_system 不再改变锚点，永不漂移。
// - 旧体系（含角色）变体与一次性迁移代码已整体删除；不兼容的旧格式数据走设置-存储重置清除。

import {
  sha256Hex,
  stableStringify,
} from './external-storage-codec';

function selectedSwipe(message: any): { id: number; text: string; info: any } {
  const rawId = Number(message?.swipe_id);
  const id = Number.isInteger(rawId) && rawId >= 0 ? rawId : 0;
  const text = Array.isArray(message?.swipes) && typeof message.swipes[id] === 'string'
    ? message.swipes[id]
    : String(message?.mes ?? '');
  const info = Array.isArray(message?.swipe_info) && message.swipe_info[id] && typeof message.swipe_info[id] === 'object'
    ? message.swipe_info[id]
    : {};
  return { id, text, info };
}

function firstStableValue(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/**
 * 当前选中消息/swipe 的**稳定**外部身份（角色无关）；绝不回写聊天对象。
 *
 * 稳定性规则（针对"无切 swipe 却丢数据"的漂移根治）：
 * - **单变体消息**（`swipes` 数组不存在或长度 ≤1）：永远用消息级稳定身份
 *   （`message.id` → `send_date` → `extra.gen_id`），**绝不**用 `swipe_info`。
 *   因为新生成的回复 swipe_info 是异步补全的，若依赖它，消息生成几毫秒后锚点就会漂移。
 * - **多变体消息**（`swipes.length > 1`）：才按当前选中 swipe 区分（swipe 回滚语义需要）。
 *   此时 swipe_info 已随多个变体一起落定，不会再有"补全"造成的漂移。
 * - 身份**不含角色**（is_system 不参与）：外部扩展标记/取消标记 is_system 不改变锚点。
 */
export function selectedMessageAnchor(message: any, index: number): string {
  const hasSwipeVariants = Array.isArray(message?.swipes) && message.swipes.length > 1;
  if (hasSwipeVariants) {
    const swipe = selectedSwipe(message);
    const swipeStable = firstStableValue([
      swipe.info?.send_date,
      swipe.info?.gen_id,
      swipe.info?.id,
      swipe.info?.extra?.gen_id,
    ]);
    const messageStable = firstStableValue([
      message?.id,
      message?.send_date,
      message?.extra?.gen_id,
    ]);
    const identity = swipeStable
      ? ['swipe', swipeStable]
      : messageStable
        ? ['message-swipe', messageStable, swipe.id, swipe.text]
        : ['fallback', Math.max(0, Number(index) || 0), swipe.id, swipe.text];
    return `a_${sha256Hex(stableStringify(identity)).slice(0, 24)}`;
  }
  return legacyMessageAnchor(message, index);
}

/**
 * fallback 锚点（消息尚无可识别稳定身份时的兜底身份，角色无关）。
 * 新聊天 greeting 在生成瞬间尚无 id/send_date/gen_id，stable/legacy 都落到此锚点；
 * 随后 SillyTavern 补全稳定身份，stable 锚点随之改变。此锚点由 index+swipe.id+swipe.text
 * 复合而成，补全稳定身份后同一消息仍能复算出相同值，因此**保留集必须包含它**——
 * 否则绑定到它的 entry 在重新派生（load）时被丢弃，造成新聊天首次
 * 冷启动数据「消失」→ 下个 tick 再次冷启动（重复弹 toastr + 重复 upload）。
 * 仅用于读取重放/保留（compatibleActiveAnchors / allRetainedAnchors），写入仍绑定稳定锚点。
 */
export function selectedMessageAnchorFallback(message: any, index: number): string {
  const swipe = selectedSwipe(message);
  const identity = ['fallback', Math.max(0, Number(index) || 0), swipe.id, swipe.text];
  return `a_${sha256Hex(stableStringify(identity)).slice(0, 24)}`;
}

/** 单变体消息的消息级稳定身份（id → send_date → extra.gen_id → fallback，角色无关）。 */
function legacyMessageAnchor(message: any, index: number): string {
  const msgAnchor = messageLevelAnchor(message);
  if (msgAnchor) return msgAnchor;
  const swipe = selectedSwipe(message);
  return `a_${sha256Hex(stableStringify(['fallback', Math.max(0, Number(index) || 0), swipe.id, swipe.text])).slice(0, 24)}`;
}

/**
 * 消息级稳定锚点（与具体 swipe 变体无关，角色无关）：`['message', id|send_date|gen_id]`。
 * 单变体消息的 selectedMessageAnchor 就走这个锚点；多变体消息需额外保留它，
 * 否则消息从单变体变多变体（重生成加 swipe）后，单变体时期写入该锚点的 entry 会失活
 * → 重放回退过头（该层完整快照被跳过，退到角色出现之前 → 冷启动重弹）。
 * 无稳定身份（无 id/send_date/gen_id）返回 null。
 */
export function messageLevelAnchor(message: any): string | null {
  const messageStable = firstStableValue([
    message?.id,
    message?.send_date,
    message?.extra?.gen_id,
  ]);
  if (!messageStable) return null;
  return `a_${sha256Hex(stableStringify(['message', messageStable])).slice(0, 24)}`;
}

/**
 * 判定消息是否可作为剧情状态锚点：
 * - 用户消息永远不是锚点（剧情状态只在 AI 回合落点）。
 * - 非 system 的 assistant 消息直接是锚点。
 * - system 消息仅在具备稳定身份（顶层或当前 swipe 的 send_date/id/gen_id）时是锚点——
 *   部分卡的 AI 剧情回复/思考区以 system 消息落地（narrator / 主动推理框架等），
 *   若无此放宽，长会话锚点塌缩成极少数、全部写入挤进最后一个锚点，
 *   重生成/删除承载锚点的消息即整体回退（经期建立、事后弹窗确认被吞）。
 *   注入的纯元消息（无稳定身份）仍被跳过。
 */
export function isAnchorCandidate(message: any): boolean {
  if (!message || message.is_user === true) return false;
  if (message.is_system !== true) return true;
  if (firstStableValue([message?.id, message?.send_date, message?.extra?.gen_id])) return true;
  if (Array.isArray(message?.swipe_info)) {
    for (const info of message.swipe_info) {
      if (info && firstStableValue([info?.send_date, info?.gen_id, info?.id, info?.extra?.gen_id])) return true;
    }
  }
  return false;
}

export function activeStoryAnchors(chat: any[]): string[] {
  if (!Array.isArray(chat)) return [];
  const anchors: string[] = [];
  for (let i = 0; i < chat.length; i++) {
    const message = chat[i];
    if (!isAnchorCandidate(message)) continue;
    anchors.push(selectedMessageAnchor(message, i));
  }
  return anchors;
}

/**
 * 重放/保留锚点集（角色无关，迁移后运行时用）= 每消息当前稳定锚点（activeStoryAnchors）
 * ∪ 多变体消息的「消息级稳定锚点」。
 *
 * 背景：消息从单变体变多变体（重生成会加一个 swipe）时，selectedMessageAnchor 的锚点算法
 * 从消息级切换为 swipe 级，导致单变体时期写入、绑定在消息级锚点上的 entry 在 activeStoryAnchors
 * 里失活 → 回退跳过头（该层完整快照被跳过，退到更早状态 → handleCycleTick 对已生成角色
 * 重新冷启动、重弹事后窗）。本集合把多变体消息的消息级锚点也纳入，保证该层快照在重生成后
 * 仍可重放 → 回退精确到上一层、已生成的角色记录保留。
 *
 * 仅用于重放/保留（coordinator getActiveAnchors、删除事务 survivingAnchors、bundle 读取）。
 * 写入绑定仍用 activeStoryAnchors 的最后元素（当前稳定锚点），不改变写入落点。
 * 轻量：每消息 1-2 个短身份哈希，无 fallback 全文（V3.405 卡死事故的修复）。
 */
export function activeStoryReplayAnchors(chat: any[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (anchor: string): void => {
    if (!seen.has(anchor)) { seen.add(anchor); out.push(anchor); }
  };
  if (!Array.isArray(chat)) return out;
  for (let i = 0; i < chat.length; i++) {
    const message = chat[i];
    if (!isAnchorCandidate(message)) continue;
    push(selectedMessageAnchor(message, i));
    const hasSwipeVariants = Array.isArray(message?.swipes) && message.swipes.length > 1;
    if (hasSwipeVariants) {
      const msgAnchor = messageLevelAnchor(message);
      if (msgAnchor) push(msgAnchor);
    }
  }
  return out;
}

/**
 * 枚举当前聊天里**每条 AI 消息所有 swipe 变体**的锚点并集（角色无关：stable + fallback）。
 * 用于「裁剪孤儿 entry」：journal.entries 中锚点不在此集的 entry，必然来自已被删除的消息
 * （整个消息对象已从 chat 移除，所有变体锚点都不可再派生）→ 可安全物理删除。
 *
 * 含 fallback 全文锚点：身份补全前写入、绑定到 fallback 锚点的 entry 仍属于幸存消息，
 * 必须保留以防误裁。低频路径（删除事务），全文哈希可接受。
 */
export function allRetainedAnchors(chat: any[]): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(chat)) return set;
  for (let i = 0; i < chat.length; i++) {
    const message = chat[i];
    if (!isAnchorCandidate(message)) continue;
    const swipes = Array.isArray(message.swipes) ? message.swipes : null;
    const variantCount = swipes && swipes.length > 1 ? swipes.length : 1;
    for (let v = 0; v < variantCount; v++) {
      const msg = variantCount > 1 ? { ...message, swipe_id: v } : message;
      set.add(selectedMessageAnchor(msg, i));
      set.add(selectedMessageAnchorFallback(msg, i));
    }
  }
  return set;
}
