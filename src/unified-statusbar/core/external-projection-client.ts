// ===== 外部世界书投影客户端（纯协议，无宿主运行时依赖） =====
//
// 谁在用：
// - UBS_phone 的消息记录 / 窥私投影（两个 descriptor）
// - sese-ledger 的 `ledger-projections`
//
// 职责只有「找宿主桥 + 注册/注销 + 请求 + 开关 + 串行」：
// - 宿主桥 = 状态栏 index.ts 暴露的 `window.__ubWorldbookProjection`；
// - 本模块不 import 状态栏运行时/协调器，只做跨 bundle 的客户端协议；
// - 每个 bundle 各自打包一份，台账/小手机谁没加载都不会影响对方；
//   状态栏未加载时找不到桥 → 等 `ub-worldbook-projection-ready`，投影不可用（与现状一致）。
//
// 纪律：这里不放任何业务判定（条目内容、数据源、重填策略）。业务方只提供 descriptor
// 与自己的请求门（签名/跳过门），其余生命周期统一走本模块。

export type ExternalProjectionReason = 'data-change' | 'config-change';
export type ExternalProjectionRegisterSource = 'manual' | 'ready';

export interface ExternalProjectionDescriptor {
  id: string;
  isEnabled(): boolean;
  reconcile(entries: any[], context: any): boolean | Promise<boolean>;
}

interface HostProjectionBridge {
  register?: (descriptor: unknown) => boolean;
  unregister?: (id: string) => boolean;
  request?: (id: string, reason: ExternalProjectionReason) => void;
  requestAsync?: (id: string, reason: ExternalProjectionReason) => Promise<boolean>;
  setEnabled?: (id: string, enabled: boolean) => void;
  exclusive?: <T>(task: () => Promise<T>) => Promise<T>;
  isRefillMode?: () => boolean;
}

export interface ExternalProjectionClientOptions {
  descriptor: ExternalProjectionDescriptor;
  /** 找桥的起点：伴生插件传自己的宿主 window（会自动再查 parent/top）。 */
  window: Window;
  readyEvent?: string;
  /** 注册成功（含 ready 事件补注册）。source='ready' 表示宿主晚于本插件装载/重载。 */
  onRegistered?: (source: ExternalProjectionRegisterSource) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export const EXTERNAL_PROJECTION_READY_EVENT = 'ub-worldbook-projection-ready';

const READY_HANDLERS_KEY = '__ubExternalProjectionReadyHandlers';
const READY_BOUND_KEY = '__ubExternalProjectionReadyBound';
const READY_LISTENER_KEY = '__ubExternalProjectionReadyListener';

function candidateWindows(win: Window): Window[] {
  const out: Window[] = [];
  const push = (candidate: unknown) => {
    try {
      const w = candidate as Window | null | undefined;
      if (w && !out.includes(w)) out.push(w);
    } catch (_e) { /* cross-origin */ }
  };
  push(win);
  try { push(win.parent); } catch (_e) { /* cross-origin */ }
  try { push(win.top); } catch (_e) { /* cross-origin */ }
  return out;
}

function findHostBridge(win: Window): HostProjectionBridge | null {
  for (const candidate of candidateWindows(win)) {
    try {
      const bridge = (candidate as any).__ubWorldbookProjection as HostProjectionBridge | undefined;
      if (bridge && typeof bridge.register === 'function') return bridge;
    } catch (_e) { /* cross-origin */ }
  }
  return null;
}

/** 就绪监听按「窗口 + 事件名」单例，按 descriptor id 存回调：
 *  - 脚本重注入（小手机/台账重新求值）不会在宿主窗口叠加监听；
 *  - 同 id 的新实例覆盖旧回调，避免旧闭包继续注册旧 descriptor。 */
function bindReadyHandler(win: Window, id: string, readyEvent: string, fn: () => void): string | null {
  try {
    const anyWin = win as any;
    const handlersKey = `${READY_HANDLERS_KEY}:${readyEvent}`;
    const boundKey = `${READY_BOUND_KEY}:${readyEvent}`;
    const listenerKey = `${READY_LISTENER_KEY}:${readyEvent}`;
    const handlers = anyWin[handlersKey] || (anyWin[handlersKey] = {});
    handlers[id] = fn;
    if (!anyWin[boundKey]) {
      const listener = () => {
        const current = anyWin[handlersKey] || {};
        for (const key of Object.keys(current)) {
          try { current[key](); } catch (_e) { /* 单插件失败不影响其余 */ }
        }
      };
      // 先 add 成功再置 bound 标记：宿主晚提供 addEventListener 时下次 register 还能重试。
      win.addEventListener(readyEvent, listener);
      anyWin[listenerKey] = listener;
      anyWin[boundKey] = true;
    }
    return handlersKey;
  } catch (_e) {
    return null;
  }
}

export function createExternalProjectionClient(options: ExternalProjectionClientOptions) {
  const id = options.descriptor.id;
  const readyEvent = options.readyEvent || EXTERNAL_PROJECTION_READY_EVENT;
  const log = options.log || (() => { /* silent */ });
  let host: HostProjectionBridge | null = null;
  let registered = false;
  let disposed = false;
  const readyRegistrations: Array<{ win: Window; handlersKey: string }> = [];

  /** 惰性绑定 ready 监听：宿主/测试环境可能晚于模块装载才提供 addEventListener，
   *  每次 register() 重试一次；已绑定的窗口由 handlersKey 去重（不会叠加监听）。 */
  function ensureReadyBindings(): void {
    for (const win of candidateWindows(options.window)) {
      const handlersKey = bindReadyHandler(win, id, readyEvent, () => { register('ready'); });
      if (!handlersKey) continue;
      if (!readyRegistrations.some((item) => item.win === win && item.handlersKey === handlersKey)) {
        readyRegistrations.push({ win, handlersKey });
      }
    }
  }

  function register(source: ExternalProjectionRegisterSource = 'manual'): boolean {
    if (disposed) return false;
    ensureReadyBindings();
    const found = findHostBridge(options.window);
    host = found;
    if (!found) {
      registered = false;
      return false;
    }
    try {
      registered = found.register?.(options.descriptor) === true;
    } catch (_e) {
      registered = false;
    }
    if (registered) {
      try { options.onRegistered?.(source); } catch (_e) { /* 业务回调失败不阻断注册 */ }
    }
    return registered;
  }

  /** 请求一次投影。有 requestAsync 时返回协调器的真实结果；旧桥只有 request 时按已派发处理。 */
  function request(reason: ExternalProjectionReason = 'data-change'): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (!registered && !register()) return Promise.resolve(false);
    if (typeof host?.requestAsync === 'function') {
      return host.requestAsync(id, reason).catch((e) => {
        log('warn', `世界书投影请求失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
      });
    }
    try {
      host?.request?.(id, reason);
      return Promise.resolve(true);
    } catch (e) {
      log('warn', `世界书投影请求失败：${e instanceof Error ? e.message : String(e)}`);
      return Promise.resolve(false);
    }
  }

  /** 功能开关（关=经宿主协调器整族清除；桥不存在时只落业务侧设置）。
   *  不在这里自动注册：调用方（手机开关）要求「注册先于 setEnabled」，由调用方显式排序。 */
  function setEnabled(enabled: boolean): void {
    if (disposed) return;
    const found = findHostBridge(options.window);
    if (found) host = found;
    try { (found || host)?.setEnabled?.(id, enabled); } catch (_e) { /* 桥故障静默，下次注册重试 */ }
  }

  /** 手工清理等非投影写入：有宿主协调器就共用其串行队列。 */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (disposed) return task();
    if (!registered && !register()) return task();
    try {
      if (host?.exclusive) return host.exclusive(task);
    } catch (_e) { /* fall through to direct */ }
    return task();
  }

  function isRefillMode(): boolean {
    try { return host?.isRefillMode?.() === true; } catch (_e) { return false; }
  }

  function isRegistered(): boolean {
    return registered;
  }

  /** 只读探测：不注册、不构建条目（设置页徽标用）。 */
  function isBridgeAvailable(): boolean {
    return findHostBridge(options.window) !== null;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const boundKey = `${READY_BOUND_KEY}:${readyEvent}`;
    const listenerKey = `${READY_LISTENER_KEY}:${readyEvent}`;
    for (const { win, handlersKey } of readyRegistrations.splice(0)) {
      try {
        const anyWin = win as any;
        const handlers = anyWin[handlersKey];
        if (!handlers) continue;
        delete handlers[id];
        if (Object.keys(handlers).length > 0) continue;
        const listener = anyWin[listenerKey];
        if (typeof listener === 'function') win.removeEventListener(readyEvent, listener);
        delete anyWin[handlersKey];
        delete anyWin[listenerKey];
        delete anyWin[boundKey];
      } catch (_e) { /* cross-origin / 无 removeEventListener */ }
    }
    try {
      if (registered) host?.unregister?.(id);
    } catch (_e) { /* best-effort */ }
    host = null;
    registered = false;
  }

  register();

  return {
    descriptorId: id,
    register,
    request,
    setEnabled,
    exclusive,
    isRefillMode,
    isRegistered,
    isBridgeAvailable,
    dispose,
  };
}
