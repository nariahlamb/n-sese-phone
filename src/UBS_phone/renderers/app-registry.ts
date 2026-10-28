// ===== App 注册表 + 手机内部事件总线（避免 phone-ui ↔ app 相互依赖） =====

export interface PhoneAppContext {
  shadow: ShadowRoot;
  /** App 视口容器（.ubp-app）。 */
  container: HTMLElement;
  openApp(id: string): void;
  closeApp(): void;
}

export interface PhoneApp {
  id: string;
  name: string;
  /** 桌面图标 SVG（24 viewBox，currentColor）。 */
  icon: string;
  /** 图标底色（CSS 色）。 */
  color: string;
  available: boolean;
  mount(ctx: PhoneAppContext): (() => void) | void;
  /**
   * 安卓返回键：关掉本 App 最上层的弹层/子视图（IA-03）。
   * 返回 true = 已消费（不要退到桌面）；false/未实现 = 交给壳层继续。
   * 语义须与 App 内屏幕上的返回箭头一致。
   */
  closeTopOverlay?(): boolean;
}

const _apps = new Map<string, PhoneApp>();
const _badgeProviders = new Map<string, () => number>();

export function registerPhoneApp(app: PhoneApp): void {
  _apps.set(app.id, app);
}

export function getPhoneApps(): PhoneApp[] {
  return Array.from(_apps.values());
}

export function getPhoneApp(id: string): PhoneApp | null {
  return _apps.get(id) || null;
}

export function setAppBadgeProvider(id: string, provider: () => number): void {
  _badgeProviders.set(id, provider);
}

export function getAppBadge(id: string): number {
  const provider = _badgeProviders.get(id);
  if (!provider) return 0;
  try {
    return Math.max(0, Math.floor(provider() || 0));
  } catch (_e) {
    return 0;
  }
}

/** 全部 App 未读合计（悬浮球红点：微信/电话/各社媒平台共用此提示通道）。 */
export function getTotalAppBadge(): number {
  let total = 0;
  for (const provider of _badgeProviders.values()) {
    try {
      total += Math.max(0, Math.floor(provider() || 0));
    } catch (_e) { /* 单个 provider 故障不阻断合计 */ }
  }
  return total;
}

// ─── 跨模块深链（壳层通知中心 → App 的「直达某会话」） ───
// 壳层不能 import 各 App（renderers 之间互相 import 会成环），故用注册表中转：
// 壳层 setPendingAppTarget 后立刻 openApp —— openApp 恒为「卸载再挂载」，所以 App 在 mount 首帧
// takePendingAppTarget 就能拿到目标，无需常驻监听器；取走即清空，重复挂载不会误跳。

let _pendingTarget: { appId: string; convId: string; mid?: string } | null = null;

/** 登记一次性深链目标（下一次该 App 挂载时消费）。mid=会话内要落到的消息 id（可选）。 */
export function setPendingAppTarget(appId: string, convId: string, mid?: string): void {
  _pendingTarget = convId ? { appId, convId, ...(mid ? { mid } : {}) } : null;
}

/** 消费深链目标（含消息定位）：仅当 appId 匹配且存在时返回并清空，否则返回 null。 */
export function takePendingAppTargetFull(appId: string): { convId: string; mid?: string } | null {
  if (!_pendingTarget || _pendingTarget.appId !== appId) return null;
  const { convId, mid } = _pendingTarget;
  _pendingTarget = null;
  return { convId, ...(mid ? { mid } : {}) };
}

/** 消费深链目标（只要会话 id）：仅当 appId 匹配且存在时返回并清空，否则返回 null。 */
export function takePendingAppTarget(appId: string): string | null {
  return takePendingAppTargetFull(appId)?.convId ?? null;
}

// ─── 跨模块深链（微信链接卡 → 浏览器「回跳那一页」，第十一轮） ───
// 与会话目标同族的一次性槽（上面那个是「落到某条消息」，这个是「落到某张网页」）：
// 微信点链接卡时登记，浏览器 mount 首帧 take 走；页面是否存在由浏览器在自己的域里裁决
// （历史可被清空/顶掉，所以这里只带定位信息，不做存在性校验）。
/** 回跳定位：qid+idx 精确命中，url/title 供历史被改动后的降级匹配（旧卡只有这两样）。 */
export interface PhonePageTarget {
  qid: string;
  idx: number;
  url: string;
  title: string;
}

let _pendingPage: { appId: string; target: PhonePageTarget } | null = null;

/** 登记一次性页面深链（下一次该 App 挂载时消费）。 */
export function setPendingAppPage(appId: string, target: PhonePageTarget): void {
  _pendingPage = appId && target ? { appId, target } : null;
}

/** 消费页面深链：仅当 appId 匹配且存在时返回并清空，否则返回 null。 */
export function takePendingAppPage(appId: string): PhonePageTarget | null {
  if (!_pendingPage || _pendingPage.appId !== appId) return null;
  const target = _pendingPage.target;
  _pendingPage = null;
  return target;
}

// ─── 通知横幅 / 提示音的内部事件（I-2/I-3） ───
// 壳层订阅 ubp-phone:notify → 顶部横幅 + 提示音（两件事同源，同一批触发放一次）。
// **发射侧负责"值不值得通知"**（自己发的/系统消息/正在看这个会话 = 不发），
// **壳层负责"现在能不能显示"**（手机是否展开、是否锁屏、通知中心是否开着）——
// 后者是壳层能看到的全局态，前者需要 App 私有态（当前会话/当前视图），分工不能反。

export interface PhoneNotifyPayload {
  /** 来源 App id（微信/社媒平台/窥私/电话…），横幅据此取图标与配色。 */
  appId: string;
  /** 标题（私聊=对方名、群聊=群名、社媒=平台名或作者名）。 */
  title: string;
  /** 摘要（一条消息的正文 / 若干条的合并说明）。 */
  text: string;
  /** 合并条数（同 App 多次到达时由壳层累加；缺省 1）。 */
  count?: number;
  /** 深链：点横幅直达的会话 id。 */
  convId?: string;
  /** 深链：会话内要落到的那条消息 id（可选）。 */
  mid?: string;
}

/** 登记一条"新内容到达"（壳层统一消费；无订阅者时是无副作用的空操作）。 */
export function emitPhoneNotify(payload: PhoneNotifyPayload): void {
  emitPhoneEvent('ubp-phone:notify', payload);
}

// ─── 内部事件总线（ubp-phone:*） ───

type PhoneEventHandler = (payload?: unknown) => void;
const _listeners = new Map<string, Set<PhoneEventHandler>>();

export function onPhoneEvent(name: string, handler: PhoneEventHandler): () => void {
  let set = _listeners.get(name);
  if (!set) {
    set = new Set();
    _listeners.set(name, set);
  }
  set.add(handler);
  return () => set?.delete(handler);
}

export function emitPhoneEvent(name: string, payload?: unknown): void {
  const set = _listeners.get(name);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(payload);
    } catch (_e) { /* 单个监听器故障不阻断 */ }
  }
}
