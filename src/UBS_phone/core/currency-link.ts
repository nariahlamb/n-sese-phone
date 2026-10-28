// ===== 货币联动桥（小手机 → 主扩展货币系统）=====
// ⚠ 手机 bundle 内嵌的 story-floor-store 副本永不 bootstrap（phone-weather.ts 头注），
// 直接 import 主扩展 currency/config-store 读到的是空 store——一切数据/记账必须经宿主桥
// __ub_currency_host（主扩展 bindCurrencyHostBridge 注册在 [自身, parent] 双 window，
// 见 core/cross-window.ts）。联动激活 = 桥快照存在（主扩展货币开启且有币种；无独立开关，
// 方案 §0.4）。转账/红包弹层余额条与币种 chips、发送扣款、收入入账、红包拆开全部经此
// 回到主扩展 currency 单一事实源（与正文提取/钱包弹窗同一账本，不会双计）。
import {
  CURRENCY_HOST_BRIDGE_KEY, CURRENCY_HOST_CHANGED_EVENT, topWindowCandidates,
} from '../../unified-statusbar/core/cross-window';
import type { CurrencyMeta } from '../../unified-statusbar/core/currency';
import { emitPhoneEvent } from '../renderers/app-registry';
// 币种元数据类型再导出：手机侧渲染件（app-wechat 等）不必各自去 deep import 主项目模块。
export type { CurrencyMeta } from '../../unified-statusbar/core/currency';
import { setMoneyUnitResolver } from './chat-model';

interface CurrencyHostSnapshot {
  enabled: true;
  currencies: CurrencyMeta[];
  balances: Record<string, number>;
  commonId: string;
}

interface CurrencyHostBridge {
  snapshot(): CurrencyHostSnapshot | null;
  /** source：手机转账进出 / 红包拆开 / **网上商城消费与退款**（'shop'，钱包流水徽章显示「商城消费」）。 */
  adjust(id: string, delta: number, source: 'phone-out' | 'phone-in' | 'rp-open' | 'shop', note: string): boolean;
}

function hostBridge(): CurrencyHostBridge | null {
  for (const w of topWindowCandidates()) {
    try {
      const b = w[CURRENCY_HOST_BRIDGE_KEY] as CurrencyHostBridge | undefined;
      if (b && typeof b.snapshot === 'function' && typeof b.adjust === 'function') return b;
    } catch (_e) { /* 下一个候选 */ }
  }
  return null;
}

function snapshot(): CurrencyHostSnapshot | null {
  try { return hostBridge()?.snapshot() ?? null; } catch (_e) { return null; }
}

// ── O34：渲染期单快照 ────────────────────────────────────────────
// 读一次账本 = 过桥 + 现读主扩展 store + 归一。渲染时逐条气泡、逐个币种 chip 各读一遍，
// 一屏就是 3~6 遍；withPaySnapshot 把「进入渲染时取一次」钉住，内部所有读取复用同一份。
// 未包裹时逐次现取（行为与包裹前一致，绝不使用陈旧数据）。
let _renderSnapshot: { snap: CurrencyHostSnapshot | null } | null = null;

// F68(第十二轮)：主项目每次写货币都向宿主窗口派发 ub-currency-host-changed，此前手机零订阅
// ⇒ 正开着转账/红包弹层时，别处（正文提取记账 / 钱包调账）改了余额，弹层里仍显示旧值。
// 订阅后作废本帧快照并补渲当前 App（快照即取即真，无需其它失效处理）。
let _hostChangeBound = false;
export function bindCurrencyHostChange(): void {
  if (_hostChangeBound) return;
  _hostChangeBound = true;
  for (const w of topWindowCandidates() as unknown as Window[]) {
    try {
      if (w === window) continue; // 本窗由 currency.ts 的自身派发路径覆盖
      w.addEventListener(CURRENCY_HOST_CHANGED_EVENT, () => {
        _renderSnapshot = null;
        emitPhoneEvent('ubp-phone:data-changed');
      });
    } catch (_e) { /* 跨窗异常忽略 */ }
  }
}

/** 渲染入口包一层：内部 isCurrencyLinkActive / payXxx 共享进入时的同一份快照。 */
export function withPaySnapshot<T>(fn: () => T): T {
  const prev = _renderSnapshot;
  _renderSnapshot = { snap: snapshot() };
  try { return fn(); } finally { _renderSnapshot = prev; }
}

function liveSnapshot(): CurrencyHostSnapshot | null {
  return _renderSnapshot ? _renderSnapshot.snap : snapshot();
}

/** 联动是否激活（桥快照存在 = 主扩展货币开启且有币种）。 */
export function isCurrencyLinkActive(): boolean {
  return liveSnapshot() !== null;
}

/** 常用货币（联动未激活返回 null）。 */
export function payCommon(): CurrencyMeta | null {
  const s = liveSnapshot();
  if (!s) return null;
  return s.currencies.find(c => c.id === s.commonId) || s.currencies[0] || null;
}

/** 可选支付币种列表（联动未激活返回空）。 */
export function payCurrencyList(): CurrencyMeta[] {
  return liveSnapshot()?.currencies ?? [];
}

export function payBalance(meta: CurrencyMeta): number {
  const n = liveSnapshot()?.balances?.[meta.id];
  return Number.isFinite(n) ? (n as number) : 0;
}

/** 标签/消息里的币种名 → 币种（trim+忽略大小写，miss 回落常用货币）。 */
export function payResolveCurrency(name: string | undefined | null): CurrencyMeta | null {
  const s = liveSnapshot();
  if (!s) return null;
  const key = String(name ?? '').trim().toLowerCase();
  if (key) {
    const hit = s.currencies.find(c => c.name.toLowerCase() === key);
    if (hit) return hit;
  }
  // miss 回落常用货币：直接用手上这份快照取（O34 口径：一次读取不重复过桥）
  return s.currencies.find(c => c.id === s.commonId) || s.currencies[0] || null;
}

/** 记账（联动激活时经宿主桥落主扩展账本；桥失效静默）。 */
export function payAdjust(meta: CurrencyMeta, delta: number, source: 'phone-out' | 'phone-in' | 'rp-open' | 'shop', note: string): void {
  try { hostBridge()?.adjust(meta.id, delta, source, note); } catch (_e) { /* ignore */ }
}

/**
 * 记账（带结果）：返回桥是否真的落账（币种被删/货币关闭/桥失效 = false）。
 * 商城结算/退款专用——「钱扣没扣」必须可判定，绝不能静默继续（转账/红包沿用上面的静默版）。
 */
export function payAdjustResult(meta: CurrencyMeta, delta: number, source: 'phone-out' | 'phone-in' | 'rp-open' | 'shop', note: string): boolean {
  try { return hostBridge()?.adjust(meta.id, delta, source, note) === true; } catch (_e) { return false; }
}

/** 金额 + 单位文本（"520 上品灵石" / "88.8 人民币"）。 */
export function moneyAmountText(amount: string | number | undefined, meta: { name: string; precision: 0 | 2 } | null): string {
  const n = Number(amount ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  if (!meta) return `¥${safe.toFixed(2)}`;
  return `${fmtQty(meta.precision, safe)} ${meta.name}`;
}

/** 千分位数量格式化（与主扩展 currency.fmtQty 同式；本地实现避免拉入主扩展数据链）。 */
export function fmtQty(precision: 0 | 2, n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  const v = precision === 2 ? safe.toFixed(2) : String(Math.round(safe));
  const parts = v.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

// 币种图标：与主项目共用同一份唯一实现（unified-statusbar/core/currency-icons.ts）。
// 不能直接 import 主项目的 core/icons.ts——那会把整张图标表打进手机分发包。
export { currencyIconSvg } from '../../unified-statusbar/core/currency-icons';

// 注册 AI 可见金额的单位解析（chat-model 保持零依赖，注入式回接常用货币名；
// 桥未注册/联动未激活时快照为 null → 联动回落 ¥）。
setMoneyUnitResolver(currency => {
  const meta = currency ? payResolveCurrency(currency) : payCommon();
  return meta ? meta.name : null;
});
