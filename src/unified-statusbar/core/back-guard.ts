// ===== 安卓系统返回键守卫（零依赖，unified-statusbar 与 UBS_phone 共用） =====
// 背景：全屏弹窗打开时按系统返回键，浏览器默认行为是导航离开页面 = 丢失整个会话。
// 机制：第一个全屏壳打开时 pushState 压入一条守卫记录（幂等）；此后一次返回键只消费
// 这条记录，改为「从上往下找第一个可见壳并执行其关闭动作」。壳经 UI 关闭时
// popBackGuard 归还记录（自身 history.back，popstate 只作废不再关窗）。
// 状态挂 window（__ubBackGuard）：两个子项目 bundle 各自内嵌本模块副本时仍共享同一份
// 守卫，避免互相触发对方的 selfNav/重复压栈。
type BackCloser = () => boolean;

interface BackGuardState {
  armed: boolean;
  selfNav: boolean;
  bound: boolean;
  closers: BackCloser[];
  probe: (() => boolean) | null;
  /** F64(第十二轮)：额外所有者探针（跨产物共享同一份守卫状态时，各产物各报「我这边还有壳吗」）。 */
  probes?: Array<() => boolean>;
}

function state(): BackGuardState {
  const w = window as unknown as { __ubBackGuard?: BackGuardState };
  if (!w.__ubBackGuard) {
    w.__ubBackGuard = { armed: false, selfNav: false, bound: false, closers: [], probe: null, probes: [] };
  }
  // 旧版本 bundle 先建过 state（无 probes 字段）时补齐，避免跨产物升级期读到 undefined。
  if (!Array.isArray(w.__ubBackGuard.probes)) w.__ubBackGuard.probes = [];
  return w.__ubBackGuard;
}

/** F64：注册「我这边的全屏壳是否还开着」探针（可多次调用=多所有者，各自独立）。 */
export function addBackGuardProbe(fn: () => boolean): void {
  const s = state();
  if (s.probes!.indexOf(fn) < 0) s.probes!.push(fn);
}

/**
 * F64(第十二轮)：任一所持者仍有全屏壳。
 * 病灶：原实现只有主项目注册探针（手机从不注册），而两产物共用 armed 单一状态 ⇒
 * 手机开着时关掉任一状态栏弹窗，releaseBackGuardIfIdle 判定「无壳」归还守卫 ⇒
 * 下一次返回键不再被拦，浏览器默认返回直接离开酒馆页面（该守卫存在的理由）。
 */
export function anyBackGuardShellOpen(): boolean {
  const s = state();
  try { if (s.probe && s.probe()) return true; } catch (_e) { /* 探针异常视为无壳 */ }
  for (const p of s.probes!) {
    try { if (p()) return true; } catch (_e) { /* 同上 */ }
  }
  return false;
}

function bind(): void {
  const s = state();
  if (s.bound) return;
  s.bound = true;
  window.addEventListener('popstate', () => {
    if (s.selfNav) { s.selfNav = false; return; }
    if (!s.armed) return;
    s.armed = false;
    dispatchBackClosers();
  });
}

/**
 * 执行一次「关闭最顶层可见全屏壳」：closers 按注册顺序 = z 从低到高登记，
 * 从数组尾（栈顶）往下找第一个响应者，响应即停；关掉一层后若仍有壳开着则重新压守卫记录。
 * 返回键（popstate）与桌面 ESC 键（F27，renderers/html-builder.ts 绑定）共用本分发。
 * 返回是否有 closer 消费了本次请求。
 */
export function dispatchBackClosers(): boolean {
  const s = state();
  for (let i = s.closers.length - 1; i >= 0; i--) {
    if (s.closers[i]()) {
      // 关掉一层后若仍有壳开着，重新压一条守卫，保证下一次返回键仍被拦截
      if (anyBackGuardShellOpen()) pushBackGuard();
      return true;
    }
  }
  return false;
}

/** 全屏壳打开时调用：压入一条守卫记录（幂等，重复调用不重复压栈）。 */
export function pushBackGuard(): void {
  if (typeof history === 'undefined' || typeof window === 'undefined') return;
  const s = state();
  if (s.armed) return;
  bind();
  s.armed = true;
  try { history.pushState({ __ubBackGuard: true }, ''); }
  catch (_e) { s.armed = false; }
}

/** 壳经 UI 关闭且再无可见壳时调用：归还守卫记录（自身触发 history.back）。 */
export function popBackGuard(): void {
  const s = state();
  if (!s.armed) return;
  s.armed = false;
  try {
    if ((history.state as Record<string, unknown> | null)?.__ubBackGuard) {
      s.selfNav = true;
      history.back();
    }
  } catch (_e) { s.selfNav = false; }
}

/** 登记各壳的关闭动作（返回是否消费了本次返回键）；须按 z 从低到高注册。 */
export function registerBackClosers(fns: BackCloser[]): void {
  state().closers.push(...fns);
}

/** 注册「是否仍有全屏壳可见」探针，供返回键关掉一层后判断是否重新压守卫。 */
export function setBackGuardOpenProbe(fn: () => boolean): void {
  state().probe = fn;
}
