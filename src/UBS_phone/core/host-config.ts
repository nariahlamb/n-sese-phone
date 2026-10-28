// ===== 主项目配置引导（只读） =====
// 小手机 import 主项目 config-store 单例后自举一份实例，接在与主项目相同的
// 偏好外部文件（usb_global_preferences_<h>.json）+ extensionSettings 密钥影子上，
// 经只读视图硬保证「永不写主项目配置文件」（docs/01 §6.1）。

import { hostWindow } from './host-env';
import { isLedgerTakeover } from '../../unified-statusbar/core/ledger-takeover';
import {
  configureConfigStorage,
  getConfig,
  invalidateConfigCache,
  STATUSBAR_CONFIG_CHANGED_EVENT,
} from '../../unified-statusbar/core/config-store';
import {
  createExternalObjectStore,
  type ExternalObjectStore,
} from '../../unified-statusbar/core/external-object-store';
import { createServerFileStore } from '../../unified-statusbar/core/server-file-store';

export type HostConfigState = 'ready' | 'missing' | 'error';

let _state: HostConfigState = 'error';
let _warned = false;

/**
 * 只读外壳：写方法静默吞掉并返回 true（防主项目 config-store 归一化触发的
 * 回写补丁把重试噪音打进控制台）；读方法透传真 store。
 */
function readOnlyView(store: ExternalObjectStore): ExternalObjectStore {
  const swallow = (label: string) => {
    if (!_warned) {
      _warned = true;
      console.warn('[小手机] 拦截了一次对主项目偏好文件的写入（小手机对主项目配置只读）:', label);
    }
    return true;
  };
  return {
    load: () => store.load(),
    sync: () => store.sync(),
    read: (key, fallback) => store.read(key, fallback),
    readAll: () => store.readAll(),
    patch: () => Promise.resolve(swallow('patch')),
    replaceAll: () => Promise.resolve(swallow('replaceAll')),
    patchCommit: async () => ({ ok: true, confirmed: true, retryable: false }),
    replaceCommit: async () => ({ ok: true, confirmed: true, retryable: false }),
    flush: () => store.flush(),
    status: () => store.status(),
    _internal: store._internal,
  };
}

/**
 * 自举/重读主项目配置。原子信封 load 有一次性守卫（实例只读一次磁盘），
 * 所以每次调用都重建只读 store 实例=重读偏好文件，并同步重建归一化配置缓存；
 * 失败保留旧 store 与旧缓存（读路径不受影响，状态如实置 error）。
 * 引导调用一次（main __ubp_booted 守卫），此后仅由 refreshHostConfig 触发。
 */
export async function bootHostConfig(): Promise<HostConfigState> {
  try {
    const store = createExternalObjectStore({
      files: createServerFileStore(),
      namespace: 'preferences',
      writerId: 'ubs-phone-readonly',
      now: () => Date.now(),
      makeId: prefix => `${prefix}_${Date.now().toString(36)}`,
    });
    const status = await store.load();
    configureConfigStorage('external', readOnlyView(store));
    invalidateConfigCache();
    _state = status.state === 'ready' ? 'ready' : status.state === 'uninitialized' ? 'missing' : 'error';
    return _state;
  } catch (_e) {
    _state = 'error';
    return _state;
  }
}

export function hostConfigState(): HostConfigState {
  return _state;
}

/**
 * 重读主项目偏好文件并重建归一化缓存（下次 getConfig 拿新值）。
 * 触发：主项目配置落盘推送（bindHostConfigSync）+ 设置页打开时拉取兜底。
 */
export function refreshHostConfig(): Promise<HostConfigState> {
  return bootHostConfig();
}

// ─── 主项目配置变更推送（ub-statusbar-config-changed） ───

type HostConfigSyncedListener = () => void;
const _syncedListeners = new Set<HostConfigSyncedListener>();

/** 注册重读完成回调（renderers 层刷新 UI 用）；返回解绑函数。 */
export function onHostConfigSynced(listener: HostConfigSyncedListener): () => void {
  _syncedListeners.add(listener);
  return () => { _syncedListeners.delete(listener); };
}

function notifySynced(): void {
  for (const listener of _syncedListeners) {
    try { listener(); } catch (_e) { /* 单个监听器故障不阻断 */ }
  }
}

/** 绑定主项目偏好文件落盘事件（守卫防重，幂等；对齐 bindPhoneMapInvalidation 先例）。 */
export function bindHostConfigSync(): void {
  const w = hostWindow() as unknown as { __ubp_hostcfg_bound?: boolean; addEventListener?: unknown };
  if (w.__ubp_hostcfg_bound || typeof w.addEventListener !== 'function') return;
  w.__ubp_hostcfg_bound = true;
  try {
    w.addEventListener(STATUSBAR_CONFIG_CHANGED_EVENT, () => {
      void refreshHostConfig().then(notifySynced);
    });
  } catch (_e) {
    w.__ubp_hostcfg_bound = false;
  }
}

export { getConfig, invalidateConfigCache };

/**
 * F66(第十二轮)：主项目「重填模式」是否开启。
 * 用户开该模式的目的是「让状态栏的自动反应别和重填打架」——手机侧同源同目的，
 * 故自动 AI 请求（自动窥私）与自动写入（自动备份/世界书投影）一律停摆。
 * 手机已只读同一份偏好文件（getConfig 走 host-config 自举副本），零新增桥。
 *
 * 台账接管时主项目把该开关视为关闭（设置页也整块隐藏），手机同源同口径：
 * 否则主项目自动链已恢复、手机仍停摆，且用户无处关闭。
 */
export function isHostRefillMode(): boolean {
  try {
    if (isLedgerTakeover()) return false;
    return (getConfig() as { refillModeEnabled?: boolean }).refillModeEnabled === true;
  } catch (_e) { return false; }
}
