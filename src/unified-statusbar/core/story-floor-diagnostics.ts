// ===== 存储楼层诊断（设置面板存储页显示用）=====
// 纯函数，无 I/O、无定时器、无监听：仅在打开设置面板时由 story-floor-store 包装调用。
import {
  activeStoryAnchors,
  activeStoryReplayAnchors,
  isAnchorCandidate,
  messageLevelAnchor,
  selectedMessageAnchor,
} from './external-story-store';
import { MAX_RETAINED_LAYERS, type StoryDomainJournal } from './story-domain-store';

export interface StoryFloorDiagnostics {
  /** 当前楼层 = 聊天中 AI 锚点消息数（与备份列表「第N层」同口径）；未就绪为 null。 */
  currentFloor: number | null;
  /** 压缩阈值：journal 保留最近 N 层增量 entry，更早的折叠进 baseline。 */
  retainedLayers: number;
  /** 删除当前楼层后数据回退到的楼层（最后一个仍存活 entry 的楼层）；无存活 entry 为 null。 */
  lastSavedFloor: number | null;
  /** 底账（baseline）非空：更早楼层的写入已折叠保存，lastSavedFloor=null 不等于无数据。 */
  hasFoldedBaseline: boolean;
}

/**
 * 计算存储楼层诊断：
 * - currentFloor：AI 锚点消息数。
 * - retainedLayers：压缩阈值（MAX_RETAINED_LAYERS）。
 * - lastSavedFloor：模拟删除最后一条 AI 消息（当前楼层）后，重放集内最后一个 entry 的楼层——
 *   即删除当前楼层后数据回退到的楼层。锚定在当前楼层的 entry 随删除被裁剪，不参与。
 * - hasFoldedBaseline：底账非空。折叠压缩（2026-08-30 起每次 append 运行）把窗口外与锚点
 *   失联的写入折进底账后，lastSavedFloor=null 只表示「无逐层条目」，删除当前楼层回退到的是
 *   底账快照而非空数据——面板据此显示「底账（已折叠）」而非「—」。
 */
export function computeStoryFloorDiagnostics(
  chat: any[],
  coreJournal: StoryDomainJournal,
  mapJournal: StoryDomainJournal,
): StoryFloorDiagnostics {
  const hasFoldedBaseline = Object.keys(coreJournal.baseline || {}).length > 0;
  const currentFloor = activeStoryAnchors(chat).length;
  if (currentFloor === 0) {
    return { currentFloor, retainedLayers: MAX_RETAINED_LAYERS, lastSavedFloor: null, hasFoldedBaseline };
  }

  // 截断聊天 = 去掉最后一条 AI 锚点消息（模拟删除当前楼层）。删除发生在末尾，
  // 幸存锚点消息的索引不变，其锚点与写入时一致。
  let truncated = chat;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAnchorCandidate(chat[i])) {
      truncated = chat.slice(0, i).concat(chat.slice(i + 1));
      break;
    }
  }

  // 删除后的重放集 + 锚点→楼层映射（重放集锚点 = 角色无关稳定锚点 ∪ 多变体消息级锚点）。
  const replaySet = new Set(activeStoryReplayAnchors(truncated));
  const anchorToFloor = new Map<string, number>();
  let floor = 0;
  for (let i = 0; i < truncated.length; i++) {
    const message = truncated[i];
    if (!isAnchorCandidate(message)) continue;
    floor += 1;
    anchorToFloor.set(selectedMessageAnchor(message, i), floor);
    const msgAnchor = messageLevelAnchor(message);
    if (msgAnchor) anchorToFloor.set(msgAnchor, floor);
  }

  let lastSavedFloor: number | null = null;
  for (const entry of [...coreJournal.entries, ...mapJournal.entries]) {
    if (!replaySet.has(entry.anchor)) continue;
    const f = anchorToFloor.get(entry.anchor);
    if (f !== undefined && (lastSavedFloor === null || f > lastSavedFloor)) lastSavedFloor = f;
  }

  return { currentFloor, retainedLayers: MAX_RETAINED_LAYERS, lastSavedFloor, hasFoldedBaseline };
}
