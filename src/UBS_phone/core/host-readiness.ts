// ===== 主项目就绪探测 + 重新匹配（异步装载自愈） =====
// 小手机与主项目（unified-statusbar）是两个独立异步装载的插件，主项目的桥可能晚于小手机出现，
// 表现为「主项目未就绪」长期不消失。本模块只做两件事：
//   ①只读探测主项目相关依赖是否可用；②把各模块既有的补注册入口汇总成一次「重新匹配」。
// 不新增任何桥协议、不写任何存储——rematch 全部复用既有 sync / notify 函数，零重复实现。

import { hostWindow } from './host-env';
import { hostConfigState, refreshHostConfig, type HostConfigState } from './host-config';
import { getPhoneSettings } from './phone-settings';
import {
  isPhoneMessageProjectionBridgeAvailable,
  syncPhoneMessageProjectionRegistration,
  notifyPhoneMessagesChanged,
} from './message-worldbook';
import { syncSpyProjectionRegistration, notifySpyRecordsChanged } from './spy-worldbook';
import { isPhoneRelocationBridgeAvailable, syncPhoneRelocationRegistration } from './phone-relocation';

export interface HostReadinessInput {
  /** 主项目配置读取状态（host-config）。 */
  config: HostConfigState;
  /** `__ubWorldbookProjection` 桥可用（消息记录 / 窥私投影共用同一桥）。 */
  projection: boolean;
  /** `__ubStorageRelocation` 桥可用。 */
  relocation: boolean;
  /** 有世界书注入类功能开启——投影桥缺失才算问题；两个功能都关时缺桥不影响使用。 */
  needsProjection: boolean;
}

export interface HostReadiness extends HostReadinessInput {
  ready: boolean;
  /** 人类可读的问题清单（横幅正文用）；空数组 = 就绪。 */
  issues: string[];
}

/**
 * 纯函数：由探测输入算出问题清单（门控逻辑集中于此，便于单测）。
 * 注意：一键搬家桥缺失始终计入（无对应开关，且缺失时搬家会静默丢手机数据）；
 * 配置 'missing' 仅表示主项目偏好文件未初始化（API 预设为空、走酒馆主 API），与 'error' 区分文案。
 */
export function computeHostIssues(input: HostReadinessInput): string[] {
  const issues: string[] = [];
  if (input.needsProjection && !input.projection) issues.push('世界书注入（消息记录 / 窥私）');
  if (!input.relocation) issues.push('一键搬家数据延续');
  if (input.config === 'error') issues.push('主项目配置读取失败');
  else if (input.config === 'missing') issues.push('主项目偏好文件未初始化');
  return issues;
}

/** 只读探测当前主项目就绪状态（不注册、不写盘、不读世界书）。 */
export function probeHostReadiness(): HostReadiness {
  const settings = getPhoneSettings();
  const input: HostReadinessInput = {
    config: hostConfigState(),
    projection: isPhoneMessageProjectionBridgeAvailable(),
    relocation: isPhoneRelocationBridgeAvailable(),
    needsProjection: !!(settings.messageWorldbook || settings.spyWorldbook),
  };
  const issues = computeHostIssues(input);
  return { ...input, ready: issues.length === 0, issues };
}

// ─── 广播（UI 订阅；对齐 host-config 的 onHostConfigSynced 模式） ───

type HostReadinessListener = (readiness: HostReadiness) => void;
const _listeners = new Set<HostReadinessListener>();

export function onHostReadinessChanged(listener: HostReadinessListener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

function notify(readiness: HostReadiness): void {
  for (const listener of Array.from(_listeners)) {
    try { listener(readiness); } catch (_e) { /* 单个监听器故障不阻断 */ }
  }
}

// ─── 重新匹配 + 未就绪自动退避回补 ───

/** 退避档（ms）：主项目异步装载晚到位时无需用户点，也能在数秒内自愈；用尽后停（不再常驻轮询）。 */
const RETRY_DELAYS_MS = [800, 2000, 5000, 12000, 30000];
let _retryIdx = 0;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
let _watchBound = false;

function clearRetry(): void {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

function armRetry(): void {
  if (_retryTimer || _retryIdx >= RETRY_DELAYS_MS.length) return;
  const delay = RETRY_DELAYS_MS[_retryIdx++];
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    void attemptRematch();
  }, delay);
}

/**
 * 重匹配：按顺序调用各模块既有的补注册 / 刷新入口（全幂等），探测后广播；
 * 未就绪则继续排下一次退避回补，就绪则复位退避计数。
 */
async function attemptRematch(): Promise<HostReadiness> {
  clearRetry();
  await refreshHostConfig().catch(() => undefined);
  syncPhoneMessageProjectionRegistration();
  syncSpyProjectionRegistration();
  syncPhoneRelocationRegistration();
  const settings = getPhoneSettings();
  if (settings.messageWorldbook) notifyPhoneMessagesChanged();
  if (settings.spyWorldbook) notifySpyRecordsChanged();
  const status = probeHostReadiness();
  if (status.ready) _retryIdx = 0;
  else armRetry();
  notify(status);
  return status;
}

/** 用户点「重新检测」：退避计数归零后立即重匹配。 */
export function rematchHost(): Promise<HostReadiness> {
  _retryIdx = 0;
  return attemptRematch();
}

/** 仅重算 + 广播（设置开关翻转等不需要重读配置的场景）。 */
export function refreshHostReadiness(): HostReadiness {
  const status = probeHostReadiness();
  notify(status);
  return status;
}

/** 主项目就绪信号：任一事件到达即重匹配（各模块自身还有各自的就绪监听，此处统一驱动横幅与自愈）。 */
const READY_EVENTS = [
  'ub-worldbook-projection-ready',
  'ub-storage-relocation-ready',
  'ub-statusbar-storage-ready',
  'ub-statusbar-config-changed',
];

/** boot 调用一次：首次探测 + 就绪事件到达即重匹配 + 未就绪自动退避回补（异步装载自愈）。 */
export function bindHostReadinessWatch(): void {
  if (_watchBound) return;
  _watchBound = true;
  const w = hostWindow() as unknown as { addEventListener?: unknown };
  if (typeof w.addEventListener === 'function') {
    for (const type of READY_EVENTS) {
      try {
        (w as unknown as EventTarget).addEventListener(type, () => { void attemptRematch(); });
      } catch (_e) { /* 宿主事件不可用：仅失去事件驱动，退避回补仍在 */ }
    }
  }
  void attemptRematch();
}
