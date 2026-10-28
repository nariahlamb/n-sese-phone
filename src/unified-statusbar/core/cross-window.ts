// ===== 跨脚本窗口面：桥常量 + 候选窗口序列 =====
// 状态栏与小手机是两个独立酒馆助手脚本 bundle，运行拓扑既可能是同一 window，也可能互处
// iframe 关系（世界演化探测 __ubp_world_inject「本层与 parent 各查一次」先例）。一切跨
// bundle 桥（__ubp_* / __ub_*）的注册、探测、事件广播都必须覆盖 topWindowCandidates()
// 返回的每个窗口——缺一个候选就在对应拓扑下静默失效。
// ⚠ 小手机 bundle 内嵌的 story-floor-store 副本永不 bootstrap（phone-weather.ts 头注），
// 手机侧一切主扩展数据读取/记账只能走桥，禁止直接 import 主扩展有状态模块。

export const CURRENCY_HOST_BRIDGE_KEY = '__ub_currency_host';
export const CURRENCY_HOST_CHANGED_EVENT = 'ub-currency-host-changed';
export const PHONE_ONLINE_EVENT = 'ub-phone-online';

/** 桥注册/探测/广播面：自身优先，globalThis 去重补位，跨 iframe 时 parent 追加。 */
export function topWindowCandidates(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const push = (w: unknown): void => {
    if (!w || out.indexOf(w as Record<string, unknown>) >= 0) return;
    out.push(w as Record<string, unknown>);
  };
  try { push(typeof window !== 'undefined' ? window : undefined); } catch (_e) { /* ignore */ }
  push(globalThis as unknown as Record<string, unknown>);
  try {
    const w = typeof window !== 'undefined' ? (window as any) : undefined;
    if (w?.parent && w.parent !== w) push(w.parent);
  } catch (_e) { /* cross-origin */ }
  return out;
}
