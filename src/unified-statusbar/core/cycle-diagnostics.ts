// ===== 月信与孕育 · 可选诊断日志 =====
// 默认关闭。用于定位「受孕形式确认」在重进聊天后为何再次出现，日志保留在 localStorage，
// 因而可跨页面刷新查看。绝不参与任何周期判定或存档写入。

import { parseJsonWith } from './safe-json';

const ENABLED_KEY = 'unified-statusbar:cycle-diagnostics:enabled';
const EVENTS_KEY = 'unified-statusbar:cycle-diagnostics:events';
// 之前 160 会截断「创建/重开/清空」这些关键 tick（batch 只读到一半）。调高避免再次截断。
const MAX_EVENTS = 1200;

export interface CycleDiagnosticEvent {
  at: string;
  event: string;
  detail: Record<string, unknown>;
}

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch (_e) { return null; }
}

function readEvents(): CycleDiagnosticEvent[] {
  const store = storage();
  if (!store) return [];
  // U33：收编 parseJsonWith（数组校验/过滤是本处专属口径，保留在调用方）
  const parsed: unknown = parseJsonWith<unknown[]>(store.getItem(EVENTS_KEY) ?? '[]', []);
  return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object').slice(-MAX_EVENTS) as CycleDiagnosticEvent[] : [];
}

function writeEvents(events: CycleDiagnosticEvent[]): void {
  try { storage()?.setItem(EVENTS_KEY, JSON.stringify(events.slice(-MAX_EVENTS))); } catch (_e) { /* diagnostics must never affect gameplay */ }
}

export function isCycleDiagnosticsEnabled(): boolean {
  try { return storage()?.getItem(ENABLED_KEY) === '1'; } catch (_e) { return false; }
}

export function traceCycleDiagnostic(event: string, detail: Record<string, unknown> = {}): void {
  if (!isCycleDiagnosticsEnabled()) return;
  const entry: CycleDiagnosticEvent = { at: new Date().toISOString(), event, detail };
  const events = readEvents();
  events.push(entry);
  writeEvents(events);
  try { console.info('[UB cycle diagnostics]', entry); } catch (_e) { /* ignore */ }
}

function setEnabled(enabled: boolean): void {
  try {
    const store = storage();
    if (!store) return;
    if (enabled) store.setItem(ENABLED_KEY, '1');
    else store.removeItem(ENABLED_KEY);
  } catch (_e) { /* ignore */ }
}

/** 暴露给控制台：window.__ubCycleDiagnostics.enable()/dump()/clear()/disable()。 */
export function installCycleDiagnosticsConsole(): void {
  try {
    if (typeof window === 'undefined') return;
    (window as any).__ubCycleDiagnostics = {
      enable: () => { setEnabled(true); return '经期诊断已开启；请按原步骤复现，然后运行 dump()。'; },
      disable: () => { setEnabled(false); return '经期诊断已关闭。'; },
      clear: () => { try { storage()?.removeItem(EVENTS_KEY); } catch (_e) { /* ignore */ } return '经期诊断日志已清空。'; },
      dump: () => readEvents(),
    };
  } catch (_e) { /* ignore */ }
}
