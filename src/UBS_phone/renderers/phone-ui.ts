// ===== 手机壳：宿主 Shadow DOM 挂载 + 悬浮球 + 状态栏 + App 路由（docs/01 §3） =====

import { getRoster, bindRosterInvalidation } from '../core/roster';
import { voiceCachePrune } from '../core/voice-cache';
import { getPhoneSettings, orderApply, savePhoneSettings } from '../core/phone-settings';
import { getConfig, onHostConfigSynced } from '../core/host-config';
import { avatarColor, avatarGradient, resolveAvatarPath } from '../core/phone-avatars';
import { readHomeBg, readLockBg } from '../core/phone-backgrounds';
import { cropMediaStyle } from '../core/phone-crops';
import { readTodayWeather } from '../core/phone-weather';
import { type PhoneStyle } from '../core/chat-model';
import { extractStoryDateTime, storyClockText } from '../core/story-clock';
import { S, appDisplayColor, appDisplayName, appDisplayIcon, currentStyle, s } from '../core/skins';
import { currentCustomSkin, currentSkinId, phoneSkinCss, resolvePhoneFontStack, skinAppColor, skinAppIcon, skinAppName } from '../core/skin-themes';
import { hostDocument, hostWindow } from '../core/host-env';
import { gameProgressStatus, onGameStateChanged } from '../core/game-engine';
import { onHostReadinessChanged, probeHostReadiness, rematchHost, type HostReadiness } from '../core/host-readiness';
import {
  cancelAllPhoneAiActivities, cancelPhoneAiActivity, listPhoneAiActivities,
  subscribePhoneAiActivities,
} from '../core/ai-activity';
import { aiPhaseText } from '../../unified-statusbar/core/ai-text-features';
import {
  clearAllPhoneNotifications,
  clearPhoneNotificationsFor,
  collectPhoneNotifications,
  groupPhoneNotifications,
  readPhoneNotification,
  type PhoneNotification,
  type PhoneNotifySource,
} from '../core/notification-feed';
import { ackPhoneSchedule, collectPhoneSchedule, invalidatePhoneScheduleCache, nextScheduleBanner, scheduleDisplayTitle, scheduleDueLabel, type MemoScheduleEntry } from '../core/phone-schedule';
import { mutatePhoneData, readPhoneDataRef } from '../core/phone-store';
import { pushBackGuard, popBackGuard, registerBackClosers, addBackGuardProbe } from '../../unified-statusbar/core/back-guard';
import { PHONE_CSS } from '../styles/phone-theme';
import {
  emitPhoneEvent,
  getAppBadge,
  getPhoneApp,
  getPhoneApps,
  onPhoneEvent,
  setPendingAppTarget,
  type PhoneApp,
  type PhoneAppContext,
  type PhoneNotifyPayload,
} from './app-registry';
import { ubpIcon, weatherIcon } from './icons';

// 默认位改左中后换代 V2：旧键存的多是旧默认（左上）时代拖出的位置，继续沿用会让新默认永不生效
const BALL_POS_KEY = 'ubp_ball_pos_v2';
const PHONE_POS_KEY = 'ubp_phone_pos';
/** 底栏第 4 格钉住的 App（设备本地态，与悬浮球/手机位置同一层：换聊天不重置；''=未钉 → 该格显示「＋」）。 */
const DOCK_PIN_KEY = 'ubp_dock_pin_v1';
/** 底栏固定三格（SH-01 Dock 分层；WX-04 修订：朋友圈退回桌面网格，通话顶上此位）。 */
const DOCK_IDS = ['wechat', 'phone-call', 'settings'];

let _shadow: ShadowRoot | null = null;
let _rootHost: HTMLElement | null = null;
let _open = false;
let _currentAppId: string | null = null;
let _appCleanup: (() => void) | null = null;
let _clockTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 壳层订阅（事件总线 / 主项目配置同步 / 游戏状态）的退订句柄。
 *
 * 宿主摘掉 `#ubp-root` 后 `ensurePhoneMounted()` 会重建壳并再跑一遍 `mountPhone()`；
 * 这些订阅是**模块级集合**（onPhoneEvent/onGameStateChanged/onHostConfigSynced 都按函数引用去重），
 * 而每次 mount 产生的是**新闭包**——旧闭包不等于新闭包，不去订阅就会永久滞留：
 * 每重挂载一份，一次 `data-changed` 派发触发 N 份 refresh/render（线性累积，长会话下越用越卡）。
 * 故 mount 期间登记的句柄必须在下一次重建前成对释放（与 App 层 mount/unmount 同一纪律）。
 */
let _shellCleanups: Array<() => void> = [];

function releaseShellBindings(): void {
  if (!_shellCleanups.length) return;
  for (const off of _shellCleanups) {
    try { off(); } catch (_e) { /* 单个退订故障不阻断其余 */ }
  }
  _shellCleanups = [];
}

/** auto=跟随主项目深浅色（状态栏 DAY/NIGHT 开关写 darkTheme，落盘后经配置变更事件实时推送）。 */
function isDarkMode(): boolean {
  const mode = getPhoneSettings().darkMode;
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return getConfig().darkTheme === true;
}

function readPos(key: string): { left: number; top: number } | null {
  try {
    const raw = hostWindow().localStorage.getItem(key);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos?.left !== 'number' || typeof pos?.top !== 'number') return null;
    return pos;
  } catch (_e) {
    return null;
  }
}

function writePos(key: string, left: number, top: number): void {
  try {
    hostWindow().localStorage.setItem(key, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
  } catch (_e) { /* ignore */ }
}

function clampToViewport(left: number, top: number, width: number, height: number): { left: number; top: number } {
  const win = hostWindow();
  const maxLeft = Math.max(0, win.innerWidth - width);
  const maxTop = Math.max(0, win.innerHeight - height);
  return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) };
}

/** 窄屏全屏态判定：与 phone-theme.ts 的 `@media (max-width: 480px)` 全屏规则同条件。
 *  该态下手机铺满视口，拖拽坐标无意义——历史存档写进 left/top 会把全屏机身顶偏（右/下被裁），
 *  故挂载恢复位置时必须跳过，交给 CSS 全屏规则定位。
 *  win 可传：键盘避让要问**托管壳的那个 window**（本壳的媒体查询就是按它求值的），
 *  默认沿用 hostWindow() 不给既有调用点添乱。 */
function isNarrowFullscreenViewport(win: Window = hostWindow()): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia('(max-width: 480px)').matches;
}

/** 拖拽/手势中断刚结束（600ms 内）的残留 click 识别：调用方在 click 顶部吞掉，防拖完误触
 *  （胶囊「拖手机却跳对局」/悬浮球拖完误开合）。
 *  时间戳法替代早期「拖后在 target 上挂一次性 capture 拦截」——后者在拖后不产生 click 时
 *  会把紧随其后的下一次正常点击一起吞掉（球与胶囊同一隐患），故统一收敛到这里。 */
let _dragEndedAt = 0;
function dragJustEnded(): boolean {
  return Date.now() - _dragEndedAt < 600;
}

/** 顶部「岛」（刘海 / 活动胶囊）双击＝收起手机。
 *  `dblclick` 是鼠标兼容事件，触摸端 UA 不合成它（iOS Safari 不产生「双击→dblclick」，
 *  真机上等于没绑），故改「两次 click 计时」——同 dragJustEnded / ncPullJustEnded 的
 *  时间戳纪律，零定时器；阈值 500ms 覆盖桌面系统双击间隔 ⇒ 鼠标与触摸同一套判定。
 *  两处共用同一时间戳：胶囊显示时压在刘海之上（同一视觉位置），本就互斥，无需各记一份。 */
const TOP_DBLTAP_MS = 500;
let _topTapAt = 0;
function topDoubleTap(): boolean {
  const now = Date.now();
  if (now - _topTapAt < TOP_DBLTAP_MS) {
    _topTapAt = 0; // 命中即复位：第三次点击重新算第一下，不会连成一串「双击」
    return true;
  }
  _topTapAt = now;
  return false;
}

/** 通用拖拽绑定（pointer events，宿主坐标系；宽高惰性取值以适配显隐切换）。 */
function bindDrag(handle: HTMLElement, target: HTMLElement, posKey: string, width: () => number, height: () => number): void {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;
  let moved = false;
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = target.getBoundingClientRect();
    baseLeft = rect.left;
    baseTop = rect.top;
    try { handle.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    const clamped = clampToViewport(baseLeft + dx, baseTop + dy, width(), height());
    target.style.left = `${clamped.left}px`;
    target.style.top = `${clamped.top}px`;
    target.style.right = 'auto';
    target.style.bottom = 'auto';
  });
  handle.addEventListener('pointerup', (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      const rect = target.getBoundingClientRect();
      writePos(posKey, rect.left, rect.top);
      _dragEndedAt = Date.now(); // 拖后吞 click（防误触）
      e.stopPropagation();
      e.preventDefault();
    }
  });
  // 浏览器接管手势（滚动/文本选择/系统 callout）时中断的拖拽不是点击，同样吞掉残留 click
  handle.addEventListener('pointercancel', () => {
    dragging = false;
    _dragEndedAt = Date.now();
  });
}

/**
 * 解析挂载目标文档：
 * dev iframe 模式=含 #ubp-root 占位的自身 document；宿主注入模式=宿主 document（loader 已建 root）。
 */
function resolveRootDocument(): Document {
  try {
    if (typeof document !== 'undefined' && document.getElementById('ubp-root')) return document;
  } catch (_e) { /* ignore */ }
  return hostDocument();
}

/** 主项目悬浮按钮重置桥（unified-statusbar index.ts __ub_resetFloatBtn，与主项目设置项「重置到屏幕中间」同一函数；取不到=主项目未加载/版本过旧，不兜底自实现）。 */
export function resetHostFloatBtn(): void {
  const w = hostWindow() as any;
  const reset = w?.__ub_resetFloatBtn;
  if (typeof reset === 'function') {
    reset();
    return;
  }
  w?.toastr?.error('主项目未就绪，无法重置悬浮按钮', '瑟瑟小手机');
}

/**
 * 键盘事件隔离：焦点在小手机内时，键盘事件止步 #ubp-root（冒泡阶段 stopPropagation），
 * 不再冒泡到宿主 document/window——酒馆的全局快捷键（←/→ 楼层 swipe、↑ 编辑楼层、
 * Esc 关面板、Ctrl+Enter 重生成等）收不到事件。根因：酒馆判断「是否在输入框」用
 * document.activeElement，Shadow DOM 下只会返回外壳 #ubp-root，识别不出内部
 * input/textarea，其防误触守卫全部失效。只停传播不 preventDefault：打字/光标/输入法
 * 照常；小手机自身键盘逻辑全在 Shadow 内部（提示弹层 Esc 走宿主 document 捕获阶段，
 * 先于本冒泡监听），均不受影响。已知边界：宿主 document 捕获阶段的第三方监听拦不住
 * （已核查酒馆核心快捷键与已装扩展此类监听均带自身条件，实际不受影响）。
 */
function bindKeyIsolation(host: HTMLElement): void {
  const marker = host as HTMLElement & { __ubp_key_isolation?: boolean };
  if (marker.__ubp_key_isolation) return;
  marker.__ubp_key_isolation = true;
  const stop = (e: Event): void => { e.stopPropagation(); };
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, stop);
  }
}

/** 挂载手机壳（幂等：宿主已有 #ubp-root 直接复用）。 */
export function mountPhone(): void {
  if (_shadow && _rootHost && _rootHost.isConnected) return;
  // 走到这里=要重建壳：先释放上一轮壳层订阅，防止任何路径下的重复登记（幂等兜底）
  releaseShellBindings();
  const doc = resolveRootDocument();
  if (!doc.body) return;
  let host = doc.getElementById('ubp-root');
  if (!host) {
    host = doc.createElement('div');
    host.id = 'ubp-root';
    doc.body.appendChild(host);
  }
  // dev 占位元素与 loader 建的 root 都统一确保定位样式（幂等赋值）
  host.style.cssText = 'position:fixed;inset:0;z-index:10040;pointer-events:none;';
  bindKeyIsolation(host);
  _rootHost = host;
  // 复用既有 shadow root：宿主把同一个节点摘除后又挂回（或模块态被重置）时，
  // 对已承载 shadow root 的宿主再 attachShadow 会直接抛错。复用必须先清空——
  // 否则旧 .ubp-scope 与新的并存，querySelector 命中旧节点，整个壳层指向已脱离文档的 DOM。
  const shadow: ShadowRoot = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '';
  _shadow = shadow;

  const style = doc.createElement('style');
  style.textContent = PHONE_CSS;
  shadow.appendChild(style);

  const scope = doc.createElement('div');
  scope.className = 'ubp-scope';
  scope.innerHTML = `
    <div class="ubp-ball" title="瑟瑟小手机">
      ${ubpIcon('phone')}
      <span class="ubp-ball-dot"></span>
      <span class="ubp-ball-ai"></span>
      <span class="ubp-ball-game"></span>
    </div>
    <div class="ubp-phone">
      <div class="ubp-screen">
        <div class="ubp-statusbar">
          <span class="ubp-sb-time">--:--</span>
          <div class="ubp-notch" title="拖动移动手机 · 双击收起"></div>
          <span class="ubp-sb-icons">${ubpIcon('signal')}${ubpIcon('wifi')}${ubpIcon('battery')}</span>
        </div>
        <button class="ubp-island" title="点按展开活动" hidden><span class="ubp-island-ico"></span><span class="ubp-island-text"></span></button>
        <!-- 桌面层（第六轮 ⑧）：常驻承载 .ubp-home；与 .ubp-app 同区重叠且排在它前面（App 铺满后压在桌面上） -->
        <div class="ubp-homelayer"></div>
        <div class="ubp-app"></div>
        <div class="ubp-toastlayer"></div>
        <div class="ubp-homebar" title="回到桌面"><span class="ubp-homebar-pill"></span></div>
      </div>
    </div>`;
  shadow.appendChild(scope);

  const ball = scope.querySelector('.ubp-ball') as HTMLElement;
  const phone = scope.querySelector('.ubp-phone') as HTMLElement;
  const homebar = scope.querySelector('.ubp-homebar') as HTMLElement;
  const notch = scope.querySelector('.ubp-notch') as HTMLElement;

  // 位置恢复/初始化
  const ballPos = readPos(BALL_POS_KEY);
  if (ballPos) {
    const p = clampToViewport(ballPos.left, ballPos.top, 46, 46);
    ball.style.left = `${p.left}px`;
    ball.style.top = `${p.top}px`;
    ball.style.right = 'auto';
    ball.style.bottom = 'auto';
  }
  const phonePos = readPos(PHONE_POS_KEY);
  if (phonePos && !isNarrowFullscreenViewport()) {
    const rect = phone.getBoundingClientRect();
    const p = clampToViewport(phonePos.left, phonePos.top, rect.width || 375, rect.height || 700);
    phone.style.left = `${p.left}px`;
    phone.style.top = `${p.top}px`;
    phone.style.right = 'auto';
    phone.style.bottom = 'auto';
  }

  // 拖拽
  bindDrag(ball, ball, BALL_POS_KEY, () => 46, () => 46);
  bindDrag(notch, phone, PHONE_POS_KEY, () => phone.getBoundingClientRect().width || 375, () => phone.getBoundingClientRect().height || 700);

  // 交互：单击=开关手机（SH-05：0.7s 三连击彩蛋退役 → 「重置主项目悬浮按钮」改为设置页显式按钮）
  ball.addEventListener('click', () => {
    if (dragJustEnded()) return; // 拖完的残留 click 不算点击
    togglePhone();
  });
  notch.addEventListener('click', () => {
    if (dragJustEnded()) return; // 拖完的残留 click 不算点按
    if (topDoubleTap()) closePhone(); // 双击=收起（鼠标/触摸同一条路径，见 TOP_DBLTAP_MS）
  });
  homebar.addEventListener('click', () => closeAppToHome());

  // 状态栏下拉 = 通知中心（App 内与桌面通用；灵动岛/刘海除外，见 bindStatusBarPullToNotifications）。
  // 绑在常驻的状态栏元素上：桌面下拉（renderHome 里那条）只在桌面存在，App 内没有它——这条补上 App 内入口。
  bindStatusBarPullToNotifications(scope.querySelector('.ubp-statusbar') as HTMLElement);
  bindStatusBarTapToPanels(scope.querySelector('.ubp-statusbar') as HTMLElement); // 右半点按＝控制中心、左半点按＝通知中心（I-4）
  bindAvatarErrorFallback(scope); // 头像破图兜底（第六轮 ⑦）：一次委托覆盖全机头像位

  // 底栏第 4 格「钉住的 App」：长按 → 更换 / 取消钉住（壳层唯一的长按对象，走全机同一套 bindLongPress）。
  // 绑定挂在常驻的**桌面层**上（第六轮 ⑧：桌面不再住在 .ubp-app 里；层本身常驻、只换 innerHTML，监听器不重建）。
  const appViewport = scope.querySelector('.ubp-homelayer') as HTMLElement;
  bindLongPress(appViewport, el => el.closest('.ubp-dock-pin'), () => openDockPinMenu(appViewport));
  // I-5：长按网格图标进整理态（与 Dock 钉位长按互斥——matcher 只认网格图标，钉位仍走上面的换钉菜单）
  bindLongPress(appViewport, el => (_editMode ? null : el.closest('.ubp-appgrid .ubp-appnode')), () => enterEditMode());

  // 灵动岛对局胶囊：同一元素兼三职——按住拖动=拖手机（与刘海同源 bindDrag）、
  // 未位移的点击=回到对局、双击=收起手机（与刘海共用判定，见 topDoubleTap）。
  // 拖过/被系统中断的那一下 click 由 dragJustEnded 吞掉，不会误跳对局。
  const island = scope.querySelector('.ubp-island') as HTMLElement;
  island.addEventListener('click', () => {
    if (dragJustEnded()) return; // 拖完的残留 click 不算点按（拖手机与展开互不串味）
    // 双击=收起手机：胶囊 z-index 6 压在状态栏之上，显示时把刘海整个盖住
    // ⇒ 这一路是「有活动在跑（对局/通话/生成中/上货）」时唯一的双击出口。
    if (topDoubleTap()) {
      closeIslandCard(); // 第二下先把展开卡收掉（收手机会一并收，显式收不留任何残留帧）
      closePhone();
      return;
    }
    // 点按 = 展开实时活动卡（第五轮 ②，真机口径）：卡里有「回到现场」与通话的「挂断」。
    if (_islandCard) closeIslandCard();
    else openIslandCard();
  });
  bindDrag(island, phone, PHONE_POS_KEY, () => phone.getBoundingClientRect().width || 375, () => phone.getBoundingClientRect().height || 700);

  // 主项目未就绪：常驻横幅退役（SH-04）——只挂根类（桌面设置图标角标）+ 首次 toast；详情在设置页状态卡
  ensureHostAlertBinding();
  renderHostAlert(probeHostReadiness());

  // 未读角标 / 主题 / 故事时间表失效 / 来电摇铃
  bindRosterInvalidation(); // 自带 __ubp_roster_bound 幂等守卫，重挂载不叠加
  // 以下订阅每次 mount 都是新闭包 → 句柄登记进 _shellCleanups，重建前由 releaseShellBindings 统一释放
  _shellCleanups.push(
    onPhoneEvent('ubp-phone:data-changed', () => {
      refreshBallBadge();
      if (_open && !_currentAppId) renderHome(); // 桌面可见时 App 图标角标实时刷新（App 打开中不抢渲染）
      refreshNotificationCenterCoalesced(); // 通知面板开着时才重算（关闭态是 no-op，不进渲染热路径）
      refreshScheduleBanner(); // 日程提醒（缓存命中时纯计算；同一条不重绘）
    }),
    onPhoneEvent('ubp-phone:theme-changed', () => { applyChrome(); refreshHome(); }), // 皮肤/主题切换后桌面图标配色即时跟随（App 打开中桌面不可见，跳过）
    onPhoneEvent('ubp-phone:notify', payload => { onPhoneNotify(payload as PhoneNotifyPayload); }), // 通知横幅 + 提示音（I-2/I-3）
    onHostConfigSynced(applyChrome), // 主项目 DAY/NIGHT 切换落盘推送 → 重读 darkTheme 后刷新明暗
    onPhoneEvent('ubp-phone:call-ring', on => {
      const ball = _shadow?.querySelector('.ubp-ball') as HTMLElement | null;
      ball?.classList.toggle('ubp-ring', on === true);
      // 来电全屏接管（I-1）：铃响期间锁屏让位，让电话界面盖满屏幕；挂断/接听后锁屏回来
      _lockLayer?.classList.toggle('ubp-lock-behind', on === true);
    }),
    // 对局后台推进 → 灵动岛/球游戏胶囊刷新（多监听器：与游戏中心 App 的渲染订阅并存，
    // App 卸载后引擎照常推进时胶囊仍逐步刷新）；对局视图可见性由 App 渲染时广播
    onGameStateChanged(refreshIsland),
    // 灵动岛实时活动（第五轮 ①）：通话会话/计时、AI 生成中——全部经事件进入，壳层不 import 各 App
    onPhoneEvent('ubp-phone:call-session', payload => {
      const p = payload as { active?: boolean; peerName?: string; timer?: string } | undefined;
      _callAct = p?.active === true ? { peerName: String(p.peerName || ''), timer: String(p.timer || '') } : null;
      refreshIsland();
    }),
    onPhoneEvent('ubp-phone:call-tick', timer => {
      if (!_callAct) return; // 只更新已上岛的通话（没有会话时的广播直接丢弃）
      _callAct = { ..._callAct, timer: String(timer || '') };
      refreshIsland();
    }),
    onPhoneEvent('ubp-phone:gen-activity', payload => {
      const p = payload as { convId?: string; title?: string; active?: boolean } | undefined;
      const convId = String(p?.convId || '');
      if (!convId) return;
      if (p?.active === true) _genConvs.set(convId, String(p.title || ''));
      else _genConvs.delete(convId);
      refreshIsland();
    }),
    onPhoneEvent('ubp-phone:game-view', visible => {
      _gamePlayVisible = visible === true;
      refreshIsland();
    }),
  );
  refreshBallBadge();
  resetIslandState(); // 壳重建=新元素，清缓存键/展开卡引用（防「内容未变跳过重写」卡住隐藏态）
  _schedBanner = null; // 横幅随壳一起没（元素在旧 shadow 里）；下次刷新按 isConnected 重建
  _banner = null; // 通知横幅同理（I-2）
  _lockLayer = null; // 锁屏层同理（I-1；元素随旧 shadow 一起没了）
  _locked = false;
  // 两块下拉面板同理（第五轮 ⑧）：物理拆除——移除节点 + 摘 Esc 监听 + 清退场/淡入定时器。
  // 此前控制中心只把模块引用置空（层随 shadow 一起消失，但 doc 上的 Esc 监听与定时器滞留，
  // 每重建一次壳就多留一份），现由基元的 dispose 成对清理，两块面板同一口径。
  notifyPanel.dispose();
  controlPanel.dispose();
  refreshIsland();
  applyChrome();
}

/**
 * 屏内临时层（全局搜索等由外部模块挂到 `.ubp-screen`）的登记口。
 * 壳层不能 import 那些模块（会成环），故由它们装载时登记关闭函数：收手机 / 打开 App / 壳重建时统一收掉。
 */
let _screenOverlayClose: (() => void) | null = null;
export function setScreenOverlayClose(fn: (() => void) | null): void {
  _screenOverlayClose = fn;
}
function dismissScreenOverlay(): void {
  try { _screenOverlayClose?.(); } catch (_e) { /* 单层故障不阻断开关机 */ }
}

/** 桌面搜索胶囊的打开回调（index.ts 装载 renderers/global-search-sheet 后登记）。 */
let _globalSearchOpener: ((screen: HTMLElement) => void) | null = null;
export function setGlobalSearchOpener(fn: ((screen: HTMLElement) => void) | null): void {
  _globalSearchOpener = fn;
}

// ─── 日程提醒横幅（M7）──────────────────────────────────────────────────
// 数据源：主项目「备忘录」表里**约定日期为今天/明天**的条目（core/phone-schedule；过期/未到自动不出）。
// 行为（用户定案）：未确认的按约定日先后**一次弹一条**（队列制）；点「知道了」→ 写 ack（此后不再弹横幅）
//   + 收掉横幅 + 出下一条。未确认的**同时**出现在通知中心（带「知道了」）；确认后那条转为**常驻**
//   （无按钮），直到备忘录被删除或过期。
// 层挂在 `.ubp-screen` 下（与通知中心同款）：App 重绘换 innerHTML 不会冲掉它。
let _schedBanner: HTMLElement | null = null;

/** 当前窗口（今天/明天）内的日程提醒；已确认与未确认都返回。 */
function scheduleEntries(): MemoScheduleEntry[] {
  return collectPhoneSchedule(readPhoneDataRef(), getRoster().global.time);
}

function removeScheduleBanner(): void {
  _schedBanner?.remove();
  _schedBanner = null;
}

/** 横幅卡片内容（形态 A·通知卡，2026-10-02 重设计）：
 *  身份行（橙铃铛 + 来源 + 日期徽章 + 「知道了」）→ 标题（2 行封顶）→ 正文（2 行封顶）。
 *  两条纪律：① 正文必须 clamp 到 2 行——旧版没截断，主项目正文一长卡片就糊成一堵字墙
 *  （80 字能撑到 176px 高）；② 动作收进身份行最右，不再独占一行，正文因此吃满整宽。
 *  徽章装两件事：紧迫度（今天/明天）+ 约定日；还有别的未确认条目时改成「还有 N 条」。 */
function scheduleBannerHtml(entry: MemoScheduleEntry, others: number): string {
  const when = entry.when === 'today' ? '今天' : '明天';
  const due = scheduleDueLabel(entry.dueDate);
  const chip = others > 0 ? `${when} · 还有 ${others} 条` : (due ? `${when} · ${due}` : when);
  return `<span class="ubp-sched-hd">
      <span class="ubp-sched-ico">${ubpIcon('bell')}</span>
      <span class="ubp-sched-app">${S('日程提醒', '日程提醒')}</span>
      <span class="ubp-sched-when">${escapeHtml(chip)}</span>
      <button type="button" class="ubp-sched-ack" data-ubp-sched="ack" data-key="${escapeAttr(entry.key)}">${S('知道了', '知道了')}</button>
    </span>
    <span class="ubp-sched-ti">${escapeHtml(scheduleDisplayTitle(entry.title))}</span>
    ${entry.detail ? `<span class="ubp-sched-bd">${escapeHtml(entry.detail)}</span>` : ''}`;
}

/**
 * 重算横幅（幂等）。无未确认条目 → 收掉；仍是同一条且「还有 N 条」没变 → 不重绘
 * （data-changed 很频繁，重绘会打断正在点的那一下）。force=true 用于数据源刚变过必须重画的场合。
 */
export function refreshScheduleBanner(force = false): void {
  if (!_open) { removeScheduleBanner(); return; } // 收手机=不弹；下次展开仍未确认会再弹
  // 通知中心打开时收掉横幅：横幅与面板是同一件事的两处呈现，叠在一起会把面板头部（时钟/全部清除）压住。
  // 面板关掉后由 removeNotificationCenterLayer 再拉回来（见那里的注释）。
  // 锁屏态（I-1）：锁屏上已有通知卡，日程横幅让位（解锁时 unlockPhone 会把它拉回来）
  if (_locked) { removeScheduleBanner(); return; }
  if (isNotificationCenterOpen()) { removeScheduleBanner(); return; }
  // 通知横幅（I-2）显示期间同样让位：顶部同一时刻只留一条（互斥由两边各让一步实现，无第二套调度）
  if (isPhoneBannerShowing()) { removeScheduleBanner(); return; }
  const entries = scheduleEntries();
  const next = nextScheduleBanner(entries);
  if (!next) { removeScheduleBanner(); return; }
  const screen = _shadow?.querySelector('.ubp-screen') as HTMLElement | null;
  const doc = hostDocument();
  if (!screen || !doc) return;
  if (!_schedBanner || !_schedBanner.isConnected) {
    const el = doc.createElement('div');
    el.className = 'ubp-sched-banner';
    el.addEventListener('click', (event: Event) => {
      const btn = (event.target as HTMLElement).closest('[data-ubp-sched="ack"]') as HTMLElement | null;
      if (btn?.dataset.key) ackScheduleEntry(btn.dataset.key);
    });
    screen.appendChild(el);
    _schedBanner = el;
  }
  // 剩余条数也算进签名：别的条目被确认/删除时，文案要跟着变（只比 key 会留下过期计数）
  const others = entries.filter(e => !e.acked && e.key !== next.key).length;
  const sig = `${next.key}|${others}`;
  if (!force && _schedBanner.dataset.sig === sig) return;
  _schedBanner.dataset.sig = sig;
  _schedBanner.dataset.key = next.key;
  _schedBanner.innerHTML = scheduleBannerHtml(next, others);
}

/** 「知道了」（横幅与通知中心同一入口）：写 ack → 通知中心那条转常驻 → 横幅收掉/出下一条。 */
function ackScheduleEntry(key: string): void {
  const changed = mutatePhoneData(d => ackPhoneSchedule(d, key));
  if (changed) emitPhoneEvent('ubp-phone:data-changed');
  refreshScheduleBanner(true);
  refreshNotificationCenter(); // 面板开着时那条转为常驻（无按钮）
}

// ─── 通知横幅（I-2）──────────────────────────────────────────────────────
// 数据源 = `ubp-phone:notify` 事件（发射侧已完成"值不值得通知"的判定，见 app-registry）。
// 显示门控 = shouldShowBanner（手机展开 + 未锁屏 + 通知中心未开）——只依赖壳层看得见的全局态。
// 与日程横幅（M7）**同一时刻只显示一条**：横幅占了顶部的位就收掉日程横幅，收起后再拉回来
// （复用 M7 已有的同一套"收/放"机制，不新建第二套调度）。
let _banner: HTMLElement | null = null;
/** 当前横幅的内容快照（第五轮 ③：横幅被吸入灵动岛时元素随即消失，来源/标题/正文要从这里取）。 */
let _bannerPayload: PhoneNotifyPayload | null = null;
let _bannerTimer: ReturnType<typeof setTimeout> | null = null;
let _bannerAt = 0;
let _bannerCount = 0;
let _lastMessageSoundAt = 0;
/** 锁屏态（I-1 驱动；横幅据此让位给锁屏通知卡）。 */
let _locked = false;

/** 是否处于锁屏态（壳层内部读口）。 */
export function isPhoneLocked(): boolean {
  return _locked;
}

/** 通知横幅是否正在显示（日程横幅据此让位）。 */
export function isPhoneBannerShowing(): boolean {
  return !!_banner;
}

function removePhoneBanner(absorb = false): void {
  if (_bannerTimer) {
    clearTimeout(_bannerTimer);
    _bannerTimer = null;
  }
  const el = _banner;
  const payload = _bannerPayload;
  _banner = null;
  _bannerPayload = null;
  _bannerCount = 0;
  if (el) {
    // 第五轮 ③：自动收回时「被灵动岛吸入」——横幅朝顶部收拢缩小，落到岛的位置；岛上随即短暂呈现
    // 来源 + 未读点。**岛上没有可落位的活动时才吸**（通话/对局/生成占着岛就退化为原位淡出，不硬塞）；
    // 锁屏/收手机同样不吸（那时岛本就不可见）。
    if (absorb && payload && !currentIslandActivity() && _open && !_locked) {
      showAbsorbedNotification(payload);
      el.classList.add('ubp-banner-absorb');
      setTimeout(() => el.remove(), 300); // 单发自清（动画结束即摘）
    } else {
      el.remove();
    }
  }
  refreshIsland(); // 顶部让位结束：岛状态可能变化（被吸入的来源上岛）
  refreshScheduleBanner(true); // 让位结束 → 日程横幅按原逻辑回来
}

/** 被吸入的通知在岛上短暂呈现（第五轮 ③）：几秒后自行下线（点按可立刻查看）。 */
function showAbsorbedNotification(payload: PhoneNotifyPayload): void {
  if (_notifClearTimer) clearTimeout(_notifClearTimer);
  _notifAct = {
    appId: String(payload.appId || ''),
    title: String(payload.title || ''),
    text: String(payload.text || ''),
    convId: payload.convId || '',
    mid: payload.mid || '',
  };
  _notifClearTimer = setTimeout(() => {
    _notifClearTimer = null;
    _notifAct = null;
    refreshIsland();
  }, 4200);
}

/** 横幅内容：图标 + 来源（同 App 多条时带计数）+ 标题 + 摘要。 */
function bannerHtml(appId: string, title: string, text: string, count: number): string {
  const app = getPhoneApp(appId);
  const style = currentStyle();
  const name = app ? skinAppName(app.id, appDisplayName(app.id, app.name, style)) : '';
  const icon = app ? skinAppIcon(app.id, appDisplayIcon(app.id, app.icon, style)) : ubpIcon('bell');
  const color = app ? skinAppColor(app.id, appDisplayColor(app.id, app.color, style)) : '#8E8E93';
  const tag = count > 1 ? `${name} · ${count} 条新消息` : name;
  return `<span class="ubp-banner-icon" style="background:${color}">${icon}</span>
    <span class="ubp-banner-body">
      <span class="ubp-banner-head"><span class="ubp-banner-app">${escapeHtml(tag)}</span></span>
      ${title ? `<span class="ubp-banner-title">${escapeHtml(title)}</span>` : ''}
      <span class="ubp-banner-text">${escapeHtml(text)}</span>
    </span>`;
}

/** 收到一条通知（壳层唯一入口：提示音 + 横幅；提示音合并窗口内只响一次）。 */
function onPhoneNotify(payload: PhoneNotifyPayload): void {
  const now = Date.now();
  if (now - _lastMessageSoundAt >= MESSAGE_SOUND_GAP_MS) {
    _lastMessageSoundAt = now;
    feedback('message');
  }
  if (!shouldShowBanner({ phoneOpen: _open, locked: _locked, ncOpen: isNotificationCenterOpen() })) return;
  const appId = String(payload.appId || '');
  if (!appId) return;
  const merging = _banner && now - _bannerAt < BANNER_MERGE_MS && _banner.dataset.app === appId;
  if (merging && _banner) {
    _bannerCount += 1; // 同 App 连续到达：合并计数，正文换成最新一条，计时重来
    _bannerPayload = payload;
    _banner.innerHTML = bannerHtml(appId, payload.title, payload.text, _bannerCount);
    _banner.dataset.conv = payload.convId || '';
    _banner.dataset.mid = payload.mid || '';
  } else {
    removePhoneBanner();
    const screen = _shadow?.querySelector('.ubp-screen') as HTMLElement | null;
    const doc = hostDocument();
    if (!screen) return;
    const el = doc.createElement('div');
    el.className = 'ubp-banner';
    el.dataset.app = appId;
    el.dataset.conv = payload.convId || '';
    el.dataset.mid = payload.mid || '';
    el.innerHTML = bannerHtml(appId, payload.title, payload.text, 1);
    el.addEventListener('click', () => {
      const targetApp = el.dataset.app || '';
      const conv = el.dataset.conv || '';
      const mid = el.dataset.mid || '';
      removePhoneBanner();
      if (!targetApp || !getPhoneApp(targetApp)) return;
      if (conv) setPendingAppTarget(targetApp, conv, mid || undefined);
      openApp(targetApp);
    });
    screen.appendChild(el);
    _banner = el;
    _bannerPayload = payload;
    _bannerCount = 1;
    refreshScheduleBanner(true); // 顶部只留一条：横幅占了位，日程横幅让开
  }
  _bannerAt = now;
  if (_bannerTimer) clearTimeout(_bannerTimer);
  _bannerTimer = setTimeout(() => {
    _bannerTimer = null;
    removePhoneBanner(true); // 自动收回 = 被灵动岛吸入（第五轮 ③）；点开/开 App 等路径不吸
  }, BANNER_VISIBLE_MS);
}

// ─── 锁屏（I-1）──────────────────────────────────────────────────────────
// 触发 = **折叠计时**（core/phone-lock 纯判定）；**全程无定时器**：收起写一次时间戳、展开比一次。
// 内容 = 大时钟 + 日期 + 未读通知卡（只读通知聚合，零新增数据）+ 上滑解锁 + 相机快捷。
// 来电全屏接管：铃响期间锁屏让位（.ubp-lock-behind），挂断/接听后回来。
let _lockLayer: HTMLElement | null = null;

function readLockSince(): number | null {
  try {
    const raw = hostWindow().localStorage.getItem(LOCK_SINCE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch (_e) { return null; }
}
function writeLockSince(ts: number): void {
  try { hostWindow().localStorage.setItem(LOCK_SINCE_KEY, String(ts)); } catch (_e) { /* ignore */ }
}
function clearLockSince(): void {
  try { hostWindow().localStorage.removeItem(LOCK_SINCE_KEY); } catch (_e) { /* ignore */ }
}

/** 锁屏通知卡（最多 3 条 + 来源图标；数据全部来自通知聚合的只读结果）。
 *  卡片可点：解锁后直达该 App 的通知落点（与通知中心共用 target 深链）。 */
function lockCardsHtml(): string {
  const list = collectPhoneNotifications().filter(n => !n.pin).slice(0, 3);
  const style = currentStyle();
  return list.map(n => {
    const appId = NC_APP_ID[n.source] || '';
    const app = appId ? getPhoneApp(appId) : null;
    const color = app ? skinAppColor(app.id, appDisplayColor(app.id, app.color, style)) : '#8E8E93';
    const icon = app ? skinAppIcon(app.id, appDisplayIcon(app.id, app.icon, style)) : ubpIcon('bell');
    const label = app ? skinAppName(app.id, appDisplayName(app.id, app.name, style)) : '';
    return `<button type="button" class="ubp-lock-card"${appId ? ` data-ubp-lock-app="${escapeAttr(appId)}"` : ''}${n.target ? ` data-ubp-lock-target="${escapeAttr(n.target)}"` : ''}>
      <span class="ubp-lock-ico" style="background:${color}">${icon}</span>
      <span class="ubp-lock-body">
        <span class="ubp-lock-app">${escapeHtml(label)}${n.count ? ` · ${n.count}` : ''}</span>
        <span class="ubp-lock-ti">${escapeHtml(n.title)}</span>
        ${n.text ? `<span class="ubp-lock-tx">${escapeHtml(n.text)}</span>` : ''}
      </span>
    </button>`;
  }).join('');
}

function lockInnerHtml(bg: string): string {
  const roster = getRoster();
  const { date } = extractStoryDateTime(roster.global.time);
  // 锁屏壁纸（可选）：专用图层承载图与取景 transform（同桌面壁纸做法）；
  // 蒙层不是整屏压暗，而是顶部/底部渐变（时钟与解锁条所在处压暗、中间留透亮，真机口径）。
  const bgHtml = bg
    ? `<div class="ubp-lock-bg"><div class="ubp-crop-media bg" style="background-image:url('${escapeAttr(bg)}');${cropMediaStyle('lock')}"></div></div><div class="ubp-lock-scrim"></div>`
    : '';
  return `${bgHtml}<div class="ubp-lock-clock">${escapeHtml(storyClockText(roster.global.time, currentStyle()))}</div>
    <div class="ubp-lock-date">${escapeHtml(date)}</div>
    <div class="ubp-lock-notis">${lockCardsHtml()}</div>
    <div class="ubp-lock-foot">
      <button type="button" class="ubp-lock-cam" data-ubp-lock="cam" title="打开相机">${ubpIcon('camera')}</button>
      <span class="ubp-lock-hint">上滑解锁</span>
      <span class="ubp-lock-bar"></span>
    </div>`;
}

/** 收掉屏内轻提示。锁屏时用：Toast 层是屏级层（z-95，压在锁屏 12 之上——通知中心「全部清除」的
 *  提示要看得见），所以锁屏盖不住它，得显式收掉这一轮残留（同「展开卡先收起」的不留悬空层纪律）。 */
function clearScreenToasts(): void {
  const layer = _shadow?.querySelector('.ubp-toastlayer') as HTMLElement | null;
  layer?.querySelectorAll('.ubp-toast').forEach(n => n.remove());
}

/** 显示锁屏（幂等）。 */
export function showLockScreen(): void {
  _locked = true;
  closeIslandCard(); // 锁屏层盖住状态栏：展开卡先收起（不留悬空层）
  clearScreenToasts(); // 同上：轻提示层在锁屏之上，锁屏不该顶着上一轮的提示
  if (_lockLayer?.isConnected) return;
  const screen = _shadow?.querySelector('.ubp-screen') as HTMLElement | null;
  const doc = hostDocument();
  if (!screen) return;
  const el = doc.createElement('div');
  const bg = readLockBg();
  el.className = bg ? 'ubp-lock has-bg' : 'ubp-lock';
  el.innerHTML = lockInnerHtml(bg);
  screen.appendChild(el);
  _lockLayer = el;
  bindLockEvents(el);
}

/** 解锁后移除锁屏层；底下的内容原样保留。 */
export function unlockPhone(): void {
  if (!_lockLayer) { _locked = false; return; }
  const el = _lockLayer;
  _lockLayer = null;
  _locked = false;
  el.classList.add('ubp-lock-out');
  setTimeout(() => el.remove(), 220); // 退场动画后摘除（单发自清，无常驻定时器）
  refreshScheduleBanner(true); // 解锁后日程横幅按原逻辑回来
}

/** 通知条目 → 打开 App（可选深链目标）。锁屏卡与通知中心共用这一条路径，
 *  避免两个入口各自拼「先登记深链再 openApp」而漂移。 */
function openNotificationTarget(appId: string, target: string): void {
  if (!appId || !getPhoneApp(appId)) return;
  if (target) setPendingAppTarget(appId, target);
  openApp(appId);
}

/** 锁屏手势：上滑解锁（认领位移后才抓指针，同全机拖拽纪律）+ 相机快捷 + 解锁条点按
 *  + 通知卡直达（点卡 = 解锁 + 打开对应 App 页面）。 */
function bindLockEvents(layer: HTMLElement): void {
  let live = false;
  let claimed = false;
  let moved = false;
  let startY = 0;
  layer.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    live = true;
    claimed = false;
    moved = false;
    startY = e.clientY;
  });
  layer.addEventListener('pointermove', (e: PointerEvent) => {
    if (!live) return;
    const dy = e.clientY - startY;
    if (!claimed) {
      if (dy < -6) {
        claimed = true;
        moved = true;
        try { layer.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
      } else if (dy > 6) {
        live = false; // 下滑不是解锁意图，放手
        moved = true;
      }
      return;
    }
    e.preventDefault();
    layer.style.transform = `translateY(${Math.max(dy, -160)}px)`;
  });
  const end = (e: PointerEvent): void => {
    if (!live) return;
    const wasClaimed = claimed;
    const dy = e.clientY - startY;
    live = false;
    claimed = false;
    layer.style.transform = '';
    if (!wasClaimed) return;
    try { layer.releasePointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
    if (dy <= -48) unlockPhone();
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
  layer.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement;
    if (moved) { moved = false; return; } // 拖动松手后浏览器补派的 click 不当作点卡/点快捷
    const card = target.closest('[data-ubp-lock-app]') as HTMLElement | null;
    if (card) {
      const appId = card.dataset.ubpLockApp || '';
      const deep = card.dataset.ubpLockTarget || '';
      unlockPhone();
      openNotificationTarget(appId, deep);
      return;
    }
    if (target.closest('[data-ubp-lock="cam"]')) {
      unlockPhone();
      openApp('camera');
      return;
    }
    if (target.closest('.ubp-lock-bar, .ubp-lock-hint')) unlockPhone();
  });
}

/** 展开时按计时决定是否进锁屏（调用点：togglePhone 的展开分支）。 */
function applyLockOnOpen(): void {
  if (getPhoneSettings().lockScreenEnabled) {
    const lockNow = shouldLockOnOpen({
      enabled: true,
      since: readLockSince(),
      now: Date.now(),
      delayMs: getPhoneSettings().lockScreenDelaySec * 1000,
    });
    clearLockSince(); // 展开即重置计时（无论是否上锁）
    if (lockNow) showLockScreen();
    return;
  }
  clearLockSince(); // 开关关闭：不写也不留时间戳（零开销）
}

export function togglePhone(force?: boolean, opts?: { system?: boolean }): void {  const next = force === undefined ? !_open : force;
  if (next === _open) return;
  // 先确认壳内元素可达再落状态：壳未挂载/被摘除时若先改 _open，会与界面脱节
  // （isPhoneOpen() 给出「开着」的错误真值，而未读数/灵动岛等判定都读它）。
  const scope = _shadow?.querySelector('.ubp-scope') as HTMLElement | null;
  const phone = _shadow?.querySelector('.ubp-phone') as HTMLElement | null;
  if (!scope || !phone) return;
  _open = next;
  phone.classList.toggle('ubp-open', _open);
  refreshIsland(); // 展开态显灵动岛、折叠态显悬浮球游戏胶囊，开关瞬间即时切换
  if (_open) {
    // L9 成就：玩家亲手展开手机（世界演化来电自动亮屏/切聊天重挂载等系统路径传 system:true，不计）
    if (!opts?.system) emitAch('phone_opened', {});
    applyChrome();
    startClock();
    startKeyboardWatch(); // 软键盘避让随展开起停（与状态栏时钟同款：收起态零监听）
    emitPhoneEvent('ubp-phone:shell-opened'); // U22(十一轮)：App 层补渲收起期间积累的变更
    if (!_currentAppId) {
      renderHome();
      // 首次开机提示一次「下拉看通知」（此后靠真机直觉；只报结果，不写解释）
      const screen = _shadow?.querySelector('.ubp-screen') as HTMLElement | null;
      if (screen) maybeHintNotificationCenter(screen);
    }
    // 安卓返回键：手机开着时返回=回桌面/收起手机，而非离开页面
    refreshScheduleBanner(true); // 展开=日程横幅的弹出示意（未确认的那条，一次一条）
    applyLockOnOpen(); // 折叠计时到了 → 先进锁屏（I-1）；无定时器，只比一次时间戳
    ensurePhoneBackCloser();
    // F64(第十二轮)：注册本产物自己的探针——守卫状态两产物共享，缺探针会让对方误判「无壳」而归还守卫。
    addBackGuardProbe(() => _open);
    pushBackGuard();
  } else {
    // 收起 = 记一次折叠时刻（锁屏计时起点）；开关关闭则清掉，不留时间戳
    if (getPhoneSettings().lockScreenEnabled) writeLockSince(Date.now());
    else clearLockSince();
    stopClock();
    stopKeyboardWatch(); // 摘键盘监听并还原壳高（下次展开从满屏这个已知态出发）
    unlockPhone(); // 锁屏层随手机一起收（下次展开按计时重新判定）
    exitEditMode(); // 图标整理态同理（I-5）
    closeIslandCard(); // 灵动岛展开卡同理（下次展开按新的活动重新出现）
    closeNotificationCenter(false); // 收手机=通知面板一并收掉（不留下次开机的悬空层）
    closeControlCenter(false); // 控制中心同理
    removePhoneBanner(); // 通知横幅同理（下次展开按新的到达重新弹）
    dismissScreenOverlay(); // 屏内临时层（全局搜索）同理
    removeScheduleBanner(); // 横幅=开机时的提醒，收手机一并收（下次展开仍未确认会再弹）
    // U21(十一轮)：语音热缓存随收起修剪到小工作集（12 条 / 8MB——相邻预取 ±1 条 + 最近几条）。
    // 磁盘 IndexedDB 副本不受影响，下次播放自动回落磁盘；预算档（30/60/120MB）的常驻内存不再白占。
    void voiceCachePrune(12, 8 * 1024 * 1024).catch(() => undefined);
    popBackGuard();
  }
}

let _backCloserBound = false;
function ensurePhoneBackCloser(): void {
  if (_backCloserBound) return;
  _backCloserBound = true;
  registerBackClosers([(): boolean => {
    if (!_open) return false;
    // 锁屏态（I-1）：返回键＝解锁（不解锁就不能绕过锁屏，也不会把手机收掉造成"卡住"）
    if (_locked) { unlockPhone(); pushBackGuard(); return true; }
    // 图标整理态（I-5）：返回键＝退出整理（与 App 内显式弹层的语义一致）
    if (_editMode) { exitEditMode(); pushBackGuard(); return true; }
    // 灵动岛展开卡（第五轮 ②）：壳级短暂层，返回键＝收起（不直接退 App/收手机）
    if (_islandCard) { closeIslandCard(); pushBackGuard(); return true; }
    // 返回键优先级（IA-03）：自挂载弹层 → App 内显式弹层状态 → App 自带的返回控件 → 退到桌面 → 收起手机
    if (closeTopSheet()) { pushBackGuard(); return true; }
    const app = _currentAppId ? getPhoneApp(_currentAppId) : null;
    if (app?.closeTopOverlay?.()) { pushBackGuard(); return true; }
    if (_currentAppId) {
      const container = _shadow?.querySelector('.ubp-app') as HTMLElement | null;
      if (container && clickTopBackControl(container)) { pushBackGuard(); return true; }
      closeAppToHome();
      pushBackGuard(); // 回桌面后手机仍开着，重新压守卫
    } else closePhone();
    return true;
  }]);
}

export function closePhone(): void {
  togglePhone(false);
}

// ─── 桌面/App 状态与打开转场（第六轮 ⑧）────────────────────────────────────
/** 桌面状态类（替代原先的 :has(.ubp-home) 判据）：atHome=桌面在前台；homeBg=桌面设了壁纸。
 *  桌面层常驻 ⇒ 必须由 JS 显式表达「在不在桌面」，否则壁纸态配色与「状态栏显不显时刻」会恒为真。 */
function setHomeState(atHome: boolean, homeBg: boolean): void {
  const screen = _shadow?.querySelector('.ubp-screen') as HTMLElement | null;
  if (!screen) return;
  screen.classList.toggle('ubp-at-home', atHome);
  screen.classList.toggle('ubp-has-wallpaper', homeBg);
}

/** 桌面层是否被摘掉可见性（App 铺满时）。 */
function setHomeHidden(hidden: boolean): void {
  const layer = _shadow?.querySelector('.ubp-homelayer') as HTMLElement | null;
  layer?.classList.toggle('ubp-homelayer-hidden', hidden);
}

/** App 开关＝**同步切态，不做任何转场动画**（2026-10-03 用户定调：「过度动画做的一堆问题，
 *  直接 APP 打开关闭的动效动画代码全部删除，回归原始的打开方式」）。
 *  所以这里只剩两件事：桌面层的可见性（openApp 摘掉、closeAppToHome 接回）与桌面状态类
 *  （.ubp-at-home / .ubp-has-wallpaper，驱动状态栏时刻与壁纸态配色）。
 *  历史：第六轮 ⑧ 的 startLaunchTransition / onLaunchEnd / launchMotionAllowed / 起点几何 /
 *  内容淡入 / 桌面退避与收回 / 两条边的交板 / 兜底定时器已**全部删除**，一条不留。 */
/** 打开 App（不可用的 App 忽略；docs/15：皮肤下三社媒 App 恢复，隐藏门控退役）。
 *  点开即显示：挂内容 + 同步把桌面层摘掉可见性（没有转场，故也没有「起点图标」这个概念了）。 */
export function openApp(id: string, opts?: { system?: boolean }): void {
  const app = getPhoneApp(id);
  if (!app || !app.available) return;
  closeNotificationCenter(false); // 通知中心点条目会先收面板再进来；其它路径打开 App 同样收掉
  closeControlCenter(false); // 控制中心同理（对偶两面板）
  closeIslandCard(); // 灵动岛展开卡同理（进 App 即收起）
  exitEditMode(); // 图标整理态同理（进 App 即退出整理，I-5）
  removePhoneBanner(); // 通知横幅同理：进 App 后不该还挂在顶上
  dismissScreenOverlay(); // 屏内临时层（全局搜索）先收：App 铺满后不该被它盖住
  unmountCurrentApp();
  _currentAppId = id;
  togglePhone(true, opts);
  setHomeState(false, false); // 桌面状态类：状态栏时刻隐去 + 壁纸态配色让位
  setHomeHidden(true);        // 桌面层同步摘掉（App 内不该看见桌面/壁纸；顶层无动画，故无中间态）
  const container = _shadow?.querySelector('.ubp-app') as HTMLElement | null;
  if (!container) return;
  const ctx: PhoneAppContext = {
    shadow: _shadow as ShadowRoot,
    container,
    openApp,
    closeApp: closeAppToHome,
  };
  let mounted = true;
  try {
    _appCleanup = app.mount(ctx) || null;
  } catch (error) {
    mounted = false;
    container.innerHTML = `<div class="ubp-empty">App 打开失败：${escapeHtml(String((error as Error)?.message || error))}</div>`;
  }
  // L9 成就：玩家亲手打开 App 成功（系统路径=世界演化来电/切聊天重挂载，传 system:true 不计）；
  // 编年史另有专属事件（打开编年史 App）。
  if (mounted && !opts?.system) {
    emitAch('phone_app_opened', { app: id });
    if (id === 'chronicle') emitAch('phone_chronicle_opened', {});
  }
  refreshIsland(); // 通话页打开 ⇒ 岛上的通话活动让位（同一件事不在两处同时呈现）
  // mount 内会改角标计数的 App（电话 markCallsSeen / 朋友圈整平台已读）不派发 data-changed：
  // 此处统一补刷悬浮球 = 点开 App 瞬间全局红点跟随，不残留旧值等下一次数据变更
  refreshBallBadge();
}

export function closeAppToHome(): void {
  // 回到桌面＝一步到位（无转场）：清 App 内容 → 接回桌面层 → 落桌面状态类 → 重绘桌面。
  unmountCurrentApp();
  _currentAppId = null;
  setHomeHidden(false);
  setHomeState(true, Boolean(readHomeBg()));
  refreshIsland(); // 离开通话页 ⇒ 通话活动重新上岛（第五轮 ①）
  if (_open) renderHome();
}

/** 只跑 App 的卸载回调（摘监听/存盘），**不动 DOM**——反向转场需要内容留在屏上继续播放缩回动画。 */
function _runAppCleanup(): void {
  if (_appCleanup) {
    try {
      _appCleanup();
    } catch (_e) { /* ignore */ }
    _appCleanup = null;
  }
}

/** 只清 App 内容层（.ubp-app）。 */
function clearAppLayer(): void {
  const container = _shadow?.querySelector('.ubp-app') as HTMLElement | null;
  if (container) container.innerHTML = '';
}

function unmountCurrentApp(): void {
  _runAppCleanup();
  clearAppLayer();
}

/** 可钉判定：已注册、可用、且不占固定三格（固定三格恒在底栏，钉了会出重复格）。 */
function isPinnable(id: string): boolean {
  const app = id ? getPhoneApp(id) : null;
  return !!app && app.available && !DOCK_IDS.includes(id);
}

/** 读底栏钉位：脏值（App 下线/被写坏/钉到固定格）一律回落「未钉」，渲染层不承担校验。 */
function readDockPin(): string {
  try {
    const id = hostWindow().localStorage.getItem(DOCK_PIN_KEY) || '';
    return isPinnable(id) ? id : '';
  } catch (_e) {
    return '';
  }
}

function writeDockPin(id: string): void {
  try {
    hostWindow().localStorage.setItem(DOCK_PIN_KEY, id);
  } catch (_e) { /* ignore */ }
}

/**
 * App 磁贴（桌面网格 / 底栏 / 钉住选择器共用，SH-06）：名称跟风格、图标与配色跟皮肤
 * （皮肤 > 风格 > 注册表）。三处共用一条渲染链路，同一 App 不会在两屏之间漂移。
 * dockPin=底栏第 4 格，额外挂 .ubp-dock-pin 供长按委托命中（壳层唯一的长按对象）。
 */
function appTileHtml(app: PhoneApp, style: PhoneStyle, opts?: { dockPin?: boolean }): string {
  const badge = app.available ? getAppBadge(app.id) : 0;
  const name = skinAppName(app.id, appDisplayName(app.id, app.name, style));
  const icon = skinAppIcon(app.id, appDisplayIcon(app.id, app.icon, style));
  const color = skinAppColor(app.id, appDisplayColor(app.id, app.color, style));
  return `<div class="ubp-appnode${app.available ? '' : ' disabled'}${style === 'xianxia' && app.id === 'weibo' ? ' ubp-jade' : ''}${opts?.dockPin ? ' ubp-dock-pin' : ''}" data-ubp-app="${escapeAttr(app.id)}" title="${escapeAttr(name)}">
      <span class="ubp-appicon" style="background:${color}">${icon}<span class="ubp-appbadge${badge ? ' on' : ''}">${badge > 99 ? '99+' : badge}</span></span>
      <span class="ubp-appname">${escapeHtml(name)}</span>
    </div>`;
}

/** 磁贴可用性前置（桌面 / 钉住选择器共用）：不可用 → 就地提示「即将推出」并返回 false。 */
function tileAppAvailable(container: HTMLElement, appId: string): boolean {
  const app = getPhoneApp(appId);
  if (!app) return false;
  if (!app.available) {
    showScreenToast(container, '「' + app.name + '」即将推出');
    return false;
  }
  return true;
}

/** 桌面磁贴点击：可用 → 打开 App 并返回 true。调用方负责「打开前先收掉自己那层弹层」。
 */
function onAppTileClick(container: HTMLElement, appId: string): boolean {
  if (!tileAppAvailable(container, appId)) return false;
  openApp(appId);
  return true;
}

function renderHome(): void {
  // 第六轮 ⑧：桌面住在常驻的 .ubp-homelayer（不再住 .ubp-app——那是 App 内容的容器）
  const container = _shadow?.querySelector('.ubp-homelayer') as HTMLElement | null;
  if (!container) return;
  // 状态类：桌面层是常驻的，所以「在不在桌面」必须由 JS 显式表达（原先靠 :has(.ubp-home)）
  const style = currentStyle();
  const apps = getPhoneApps();
  const roster = getRoster();
  // SH-01/WX-04：主入口沉底底栏（微信/通话/设置 + 用户钉住的一格），其余全部进网格——
  // 底栏格子有限，主次入口不同权；被钉住的 App 从网格让位（与固定三格同口径，取消钉住即回网格）。
  const pin = readDockPin();
  const dockIds = pin ? [...DOCK_IDS, pin] : DOCK_IDS;
  // I-5 图标整理：网格顺序按用户排序（未列出的 App 追加末尾；未排序时与注册顺序完全一致）
  const gridApps = orderApply(apps.filter(a => !dockIds.includes(a.id)), getPhoneSettings().appOrder);
  const gridNodes = gridApps.map(a => appTileHtml(a, style)).join('');
  const pinnedApp = pin ? getPhoneApp(pin) : null;
  const dockNodes = DOCK_IDS.map(id => getPhoneApp(id)).filter((a): a is PhoneApp => !!a).map(a => appTileHtml(a, style)).join('')
    + (pinnedApp
      ? appTileHtml(pinnedApp, style, { dockPin: true })
      : `<div class="ubp-appnode ubp-dock-more" title="钉一个应用到底栏"><span class="ubp-appicon ubp-appicon-more">${ubpIcon('plus')}</span></div>`);
  // 主界面壁纸（设置→通用；空=默认渐变底）。has-bg 时文字强制浅色 + 深色蒙层保证可读。
  // .ubp-home-bg = 裁剪框（overflow:hidden），.ubp-crop-media = 承载壁纸与取景参数的媒体层；
  // 无参数时媒体层铺满图层，观感逐字不变。
  const homeBg = readHomeBg();
  setHomeState(!_currentAppId, Boolean(homeBg)); // 状态类随桌面重绘同步（隐时刻 / 壁纸态配色）
  // 桌面层的可见性也在这里对齐一次（App 开关已无转场，可见性必须与「有没有 App 在前台」恒一致）：
  // 少了这一句，壳层重建后若仍有 App 在前台，桌面层会以「可见」落回 ⇒ 壁纸从状态栏/底栏两条缝里露出来。
  setHomeHidden(Boolean(_currentAppId));
  // 通知入口（有未读才出现）：可见可点——首次反馈「找不到通知中心」的正面解法，
  // 与「顶部下拉」并存（下拉是主路径，这颗药丸负责让它被发现）
  const notifyCount = getPhoneApps().reduce((sum, a) => sum + getAppBadge(a.id), 0);
  // 整层 innerHTML 会换掉网格元素（.ubp-appgrid 可纵向滚）：App 少时无副作用，装得多/矮屏上
  // 「进 App 再退出、钉住/整理」不该把桌面弹回第一行
  const prevGridTop = container.querySelector('.ubp-appgrid')?.scrollTop ?? 0;
  container.innerHTML = `
    <div class="ubp-home${homeBg ? ' has-bg' : ''}${_editMode ? ' ubp-edit' : ''}">
      ${homeBg ? `<div class="ubp-home-bg"><div class="ubp-crop-media bg" style="background-image:url('${escapeAttr(homeBg)}');${cropMediaStyle('home')}"></div></div><div class="ubp-home-scrim"></div>` : ''}
      <div class="ubp-home-top">
        <div class="ubp-home-datetime">
          <div class="ubp-home-time">${escapeHtml(storyClockText(roster.global.time, style))}</div>
          <div class="ubp-home-date"></div>
        </div>
        <div class="ubp-home-ctx">
          <div class="ubp-home-weather"></div>
          <div class="ubp-home-loc"${roster.global.location ? '' : ' hidden'}>${ubpIcon('pin')}<span>${escapeHtml(roster.global.location)}</span></div>
        </div>
      </div>
      ${_editMode
        ? `<div class="ubp-edit-bar"><span>拖动图标调整顺序</span><button type="button" class="ubp-edit-done" data-ubp-edit="done">完成</button></div>`
        : ''}
      ${!(_editMode) && notifyCount
        ? `<button type="button" class="ubp-home-nctip" data-ubp-nctip="1" title="${S('下拉查看通知', '下拉查看通知')}"><i></i><b>${notifyCount > 99 ? '99+' : notifyCount}</b></button>`
        : ''}
      ${!(_editMode) && _globalSearchOpener
        ? `<div class="ubp-home-gsearch" data-ubp-gsearch="open" title="${S('全局搜索', '全机寻访')}">${ubpIcon('search')}<span>${S('搜索会话、聊天记录、帖子、相册', '寻访书信、往来、帖子、画匣')}</span></div>`
        : ''}
      <div class="ubp-appgrid">${gridNodes}</div>
      <div class="ubp-dock">${dockNodes}</div>
    </div>`;
  const grid = container.querySelector('.ubp-appgrid');
  if (grid && prevGridTop) grid.scrollTop = prevGridTop;
  syncHomeClock();
  void fillHomeWeather(container);
  const homeBody = container.querySelector('.ubp-home') as HTMLElement | null;
  if (homeBody) bindHomePullToNotifications(homeBody); // 桌面顶部信息带下拉 = 通知中心（见函数注释）
  container.querySelector('[data-ubp-nctip]')?.addEventListener('click', () => openNotificationCenter());
  container.querySelector('[data-ubp-gsearch="open"]')?.addEventListener('click', () => {
    if (ncPullJustEnded()) return; // 紧接下拉松手的那次残留 click 不算点搜索
    const screen = container.closest('.ubp-screen') as HTMLElement | null;
    if (screen) _globalSearchOpener?.(screen);
  });
  container.querySelector('.ubp-dock-more')?.addEventListener('click', () => { if (!_editMode) openAppDrawer(container); });
  container.querySelectorAll('.ubp-appnode').forEach(node => {
    node.addEventListener('click', () => {
      if (_editMode) return; // 整理态下点图标不打开 App（真机语义）
      if (longPressJustFired()) return; // 底栏钉位长按弹菜单后松手的残留 click（防误开 App）
      if (ncPullJustEnded()) return; // 下拉唤通知后松手的残留 click 同样吞掉
      onAppTileClick(container, (node as HTMLElement).dataset.ubpApp || '');
    });
  });
  container.querySelector('[data-ubp-edit="done"]')?.addEventListener('click', () => exitEditMode());
  bindGridReorder(container); // I-5：整理态下的拖动换位（非整理态零开销，首行即返）
}

// ─── 图标整理（I-5，仅排序 · 全局储存）────────────────────────────────────
// 顺序存 `PhoneSettings.appOrder`（**全局设置文件**，与皮肤/字号同一层——用户定案「排序和设置一样」）。
// 非整理态零开销：拖动委托首行 `if (!_editMode) return`；抖动动画只在 `.ubp-edit` 存在时运行；
// 一次拖拽只在松手时写一次设置。排序只作用于**桌面网格**（Dock 前三格是固定主入口，不参与）。
let _editMode = false;

/** 进入整理态（幂等）。 */
function enterEditMode(): void {
  if (_editMode) return;
  closeIslandCard(); // 整理态是桌面全屏态的短暂模式：展开卡先收起
  _editMode = true;
  refreshHome();
}

/** 退出整理态（幂等）。 */
function exitEditMode(): void {
  if (!_editMode) return;
  _editMode = false;
  refreshHome();
}

/** 整理态下的拖动换位：跟手移动 DOM 节点，松手把 DOM 顺序提交到全局设置（一次拖拽一次写盘）。
 *  命中判定不用 shadow 的 elementFromPoint（兼容性差），改为扫描网格内各图标的矩形取最近一块。 */
function bindGridReorder(container: HTMLElement): void {
  let dragEl: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let claimed = false;
  const tilesOf = (): HTMLElement[] =>
    Array.from(container.querySelectorAll('.ubp-appgrid .ubp-appnode')) as HTMLElement[];
  const tileAt = (x: number, y: number): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let bestD = Infinity;
    for (const t of tilesOf()) {
      if (t === dragEl) continue;
      const r = t.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return t;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (Math.abs(x - cx) > r.width || Math.abs(y - cy) > r.height) continue; // 离得太远不认
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  };
  const commit = (): void => {
    const ids = tilesOf().map(n => n.dataset.ubpApp || '').filter(Boolean);
    void savePhoneSettings({ appOrder: ids });
  };
  container.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!_editMode) return; // 非整理态：零开销
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const tile = (e.target as HTMLElement | null)?.closest?.('.ubp-appgrid .ubp-appnode') as HTMLElement | null;
    if (!tile) return;
    dragEl = tile;
    startX = e.clientX;
    startY = e.clientY;
    claimed = false;
  });
  container.addEventListener('pointermove', (e: PointerEvent) => {
    if (!_editMode || !dragEl) return;
    if (!claimed) {
      if (Math.abs(e.clientX - startX) < 8 && Math.abs(e.clientY - startY) < 8) return;
      claimed = true;
      dragEl.classList.add('ubp-dragging');
      try { container.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
    }
    e.preventDefault();
    const target = tileAt(e.clientX, e.clientY);
    if (!target || target === dragEl) return;
    const grid = container.querySelector('.ubp-appgrid');
    if (!grid) return;
    const r = target.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2 || e.clientX < r.left + r.width / 2;
    grid.insertBefore(dragEl, before ? target : target.nextSibling);
  });
  const end = (): void => {
    if (!dragEl) return;
    const el = dragEl;
    dragEl = null;
    if (!claimed) return; // 只是点了一下：不落盘
    claimed = false;
    el.classList.remove('ubp-dragging');
    commit();
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
}

/** 桌面左上角时间/日期 + 右上角地点就地刷新（时钟定时器与 renderHome 共用）。 */function syncHomeClock(): void {
  const roster = getRoster();
  const { date } = extractStoryDateTime(roster.global.time);
  const timeEl = _shadow?.querySelector('.ubp-home-time') as HTMLElement | null;
  if (timeEl) timeEl.textContent = storyClockText(roster.global.time, currentStyle());
  const dateEl = _shadow?.querySelector('.ubp-home-date') as HTMLElement | null;
  if (dateEl) {
    dateEl.textContent = date;
    dateEl.hidden = !date;
  }
  const locEl = _shadow?.querySelector('.ubp-home-loc') as HTMLElement | null;
  if (locEl) {
    const textEl = locEl.querySelector('span');
    if (textEl) textEl.textContent = roster.global.location;
    locEl.hidden = !roster.global.location;
  }
}

/** 桌面右上角天气（主项目日历「今日天气」；未生成过=整块隐藏）：图标+大类为主视觉，描述小字次行。 */
async function fillHomeWeather(container: HTMLElement): Promise<void> {
  const weather = await readTodayWeather();
  const el = container.querySelector('.ubp-home-weather') as HTMLElement | null;
  if (!el || !weather) return;
  el.innerHTML = `<div class="ubp-home-wmain">${weatherIcon(weather.category)}<b>${escapeHtml(weather.category)}</b></div><div class="ubp-home-wdesc">${escapeHtml(weather.description)}</div>`;
}

/** 屏内轻提示（IA-05 唯一实现；自移除，不改宿主渲染状态）。
 *  宿主优先挂到壳层 `.ubp-toastlayer`——**App 重绘不会冲掉它**（此前社媒把 toast 渲进 App 标记里，
 *  任何状态变化触发的重绘都会把它抹掉，且要为此多跑一次整页 render）。
 *  opts.actionLabel：带动作的提示（音色池「已删除 · 撤销」等）——该变体自己是可点区域（层仍 pointer-events:none），
 *  点了先收提示再执行回调；动作型默认停留 5.2s，普通提示 1.8s。 */
export function showScreenToast(
  container: HTMLElement,
  text: string,
  opts?: { actionLabel?: string; onAction?: () => void; ms?: number },
): void {
  const doc = hostDocument();
  const layer = container.closest('.ubp-screen')?.querySelector('.ubp-toastlayer') as HTMLElement | null;
  const host = layer || container;
  host.querySelectorAll('.ubp-toast').forEach(n => n.remove());
  const toast = doc.createElement('div');
  const actionLabel = String(opts?.actionLabel || '');
  toast.className = actionLabel ? 'ubp-toast act' : 'ubp-toast';
  if (actionLabel) {
    const tx = doc.createElement('span');
    tx.className = 'ubp-toast-tx';
    tx.textContent = text;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ubp-toast-act';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      toast.remove();
      opts?.onAction?.();
    });
    toast.append(tx, btn);
  } else {
    toast.textContent = text;
  }
  host.appendChild(toast);
  setTimeout(() => toast.remove(), opts?.ms ?? (actionLabel ? 5200 : 1800));
}

function refreshBallBadge(): void {
  // 球角标=全部 App 未读合计（微信消息/未接来电/世界演化社媒帖共用此提示通道）
  let badge = 0;
  for (const app of getPhoneApps()) {
    badge += getAppBadge(app.id);
  }
  const dot = _shadow?.querySelector('.ubp-ball-dot') as HTMLElement | null;
  if (!dot) return;
  dot.textContent = badge > 99 ? '99+' : String(badge);
  dot.classList.toggle('on', badge > 0);
}

// ─── 灵动岛：实时活动承载器（第五轮 ①②）+ 折叠态悬浮球游戏胶囊 ───
// 岛是「正在进行的事」的承载器，按优先级仲裁显示哪一个：
//   **通话中（计时） > 对局 > AI 生成中**。
// 数据全部经事件进入（壳层不得 import 任何 App——会成环，契约测试也会拦）：
//   ubp-phone:call-session { active, peerName, timer }  会话接通/结束（app-phone-call 广播）
//   ubp-phone:call-tick    "MM:SS"                       通话计时（由通话会话**既有的** 1s interval 广播 ⇒ 零新增定时器）
//   ubp-phone:gen-activity { convId, title, active }     该会话生成中/结束（app-wechat 广播）
// 点按＝展开成大卡（②，卡内含「回到现场」与通话的「挂断」）；按住拖动＝拖手机（bindDrag 不变，
// 点与拖由既有的 dragJustEnded 区分）。收起/开 App/收手机/锁屏/开面板 都会收掉展开卡（零常驻）。

let _gamePlayVisible = false; // 游戏中心 App 正在展示对局视图（此时胶囊让位，由游戏中心自己渲染进度）
let _lastIslandKey = '';
let _lastPillKey = '';

/** 通话实时活动（壳层持有的最小镜像；未接通=null）。 */
let _callAct: { peerName: string; timer: string } | null = null;
/** AI 生成中的会话（convId → 标题；后到者上岛，并行生成也只在最后一个结束时下线）。 */
const _genConvs = new Map<string, string>();
/** 商城上货活动（app-shop 起止直接调 setShopGenActivity；跨 App 卸载保留——生成照跑）。 */
let _shopGenAct: { text: string } | null = null;
/** 商城「掌柜回复中」（docs/54 §12.3，用户定案）：商家会话生成期间上岛，可点进该会话。 */
let _shopChatAct: { seller: string; threadId: string } | null = null;
/** 被吸入的通知（第五轮 ③：横幅自动收回 → 岛上短暂呈现来源 + 未读点）。最低优先级，
 *  有任何「真的正在进行的事」（通话/对局/生成）都不上岛；几秒后自清。 */
let _notifAct: { appId: string; title: string; text: string; convId: string; mid: string } | null = null;
let _notifClearTimer: ReturnType<typeof setTimeout> | null = null;
/** 展开卡（只在展开时存在；收起即移除）。 */
let _islandCard: HTMLElement | null = null;
let _islandCardKey = '';
/** 展开卡打开期间挂在 .ubp-screen 上的「点外面收起」监听（成对移除，防滞留）。 */
let _islandOutsideOff: (() => void) | null = null;

interface IslandActivity {
  kind: 'call' | 'game' | 'ai' | 'gen' | 'shop' | 'shopchat' | 'notif';
  /** 内容签名（变了才重写 DOM）。 */
  key: string;
  /** 胶囊/卡的附加类（分色）。 */
  cls: string;
  /** 卡片徽章底色。 */
  color: string;
  icon: string;
  name: string;
  sub: string;
  /** 胶囊尾部（计时/输入点）；无则空串。 */
  trailing: string;
}

/** 当前该上岛的活动（按优先级仲裁）。**通话正在通话界面里时不上岛**（通话页自带计时，重复即噪音）。 */
function currentIslandActivity(): IslandActivity | null {
  if (_callAct && _currentAppId !== 'phone-call') {
    return {
      kind: 'call', key: `call|${_callAct.peerName}|${_callAct.timer}`, cls: ' call', color: '#34C759',
      icon: ubpIcon('handset'), name: _callAct.peerName, sub: S('通话中', '神识相连中', '传声相连中', '远语相连中'),
      trailing: `<span class="ubp-island-timer">${escapeHtml(_callAct.timer)}</span>`,
    };
  }
  const info = gameProgressStatus();
  if (info && !_gamePlayVisible) {
    // 游戏分色：狼人杀紫（默认）/ 谁是卧底琥珀 / 海龟汤青绿（docs/16 §9）
    const cls = info.gameType === 'undercover' ? ' undercover' : info.gameType === 'turtlesoup' ? ' soup' : '';
    return {
      kind: 'game', key: `game|${info.gameType}|${info.text}|${info.myTurn}`, cls: `${cls}${info.myTurn ? ' turn' : ''}`, color: '#8B5CF6',
      icon: ubpIcon('gamepad'), name: info.text, sub: info.myTurn ? S('等待你的发言', '等你开口') : S('进行中', '进行中'),
      trailing: info.myTurn ? '<span class="ubp-island-timer">' + S('轮到你', '轮到你') + '</span>' : '',
    };
  }
  // 统一文字 AI 活动（与主项目同口径）：微信保留绿色 tone，商城橙色，其余蓝青。
  // 优先级高于旧 gen（微信 typing 仍由旧通道维持，避免同一请求两套状态时岛上来回跳）。
  const aiList = listPhoneAiActivities();
  if (aiList.length) {
    const first = aiList[0];
    const multi = aiList.length > 1;
    const toneCls = first.tone === 'wechat' ? ' wechat' : first.tone === 'shop' ? ' shop' : '';
    const color = first.tone === 'wechat' ? '#2DC100' : first.tone === 'shop' ? '#FF6A00' : '#12B5CB';
    const phase = aiPhaseText({ phase: first.phase, attempt: first.attempt, maxAttempts: first.maxAttempts });
    return {
      kind: 'ai',
      key: 'ai|' + aiList.map(e => e.id + ':' + e.label + ':' + e.phase + ':' + (e.attempt || 0)).join(','),
      cls: ' ai' + toneCls,
      color,
      icon: 'AI',
      name: multi ? S('AI 请求进行中…', 'AI 请求进行中…') : first.label + S('中…', '中…'),
      sub: multi ? aiList.slice(0, 3).map(e => e.label).join('、') : phase,
      trailing: '<span class="ubp-island-dots"><i></i><i></i><i></i></span>',
    };
  }
  // 最后启动的那个生成会话上岛（Map 保持插入序，取末位）
  const gen = Array.from(_genConvs.entries()).pop();
  if (gen) {
    const [convId, title] = gen;
    return {
      kind: 'gen', key: `gen|${convId}|${title}`, cls: ' gen', color: '#2DC100',
      icon: ubpIcon('wechat'), name: title || S('新消息', '新消息'), sub: S('正在输入', '正在拟字'),
      trailing: '<span class="ubp-island-dots"><i></i><i></i><i></i></span>',
    };
  }
  // 商城上货（docs/52 §7.1，用户定案「生成中灵动岛提示上货中」）：点刷新起岛，收尾落岛。
  // 状态由 app-shop 直接调 setShopGenActivity（不是事件总线——只有它一家用，少一层订阅）。
  if (_shopGenAct) {
    return {
      kind: 'shop', key: 'shop|restock', cls: ' shop', color: '#FF6A00',
      icon: ubpIcon('shop'), name: S('上货中', '备货中', '张罗中', '进货中'), sub: _shopGenAct.text,
      trailing: '<span class="ubp-island-dots"><i></i><i></i><i></i></span>',
    };
  }
  // 商城「掌柜回复中」（docs/54 §12.3）：可点进那条会话（key 里带 threadId 供展开卡深链）
  if (_shopChatAct) {
    return {
      kind: 'shopchat', key: `shopchat|${_shopChatAct.threadId}|${_shopChatAct.seller}`, cls: ' shop', color: '#FF6A00',
      icon: ubpIcon('shop'), name: _shopChatAct.seller, sub: S('掌柜回复中', '阁主回话中', '掌柜回话中', '管事回话中'),
      trailing: '<span class="ubp-island-dots"><i></i><i></i><i></i></span>',
    };
  }
  // 被吸入的通知：优先级最低（任何「正在进行的事」都盖过它）
  if (_notifAct) {
    const app = _notifAct.appId ? getPhoneApp(_notifAct.appId) : null;
    const label = app ? skinAppName(app.id, appDisplayName(app.id, app.name, currentStyle())) : '';
    return {
      kind: 'notif', key: `notif|${_notifAct.appId}|${_notifAct.title}|${_notifAct.text}`, cls: ' notif', color: app?.color || '#8E8E93',
      icon: app ? skinAppIcon(app.id, appDisplayIcon(app.id, app.icon, currentStyle())) : ubpIcon('bell'),
      name: label || S('新通知', '新通知'),
      sub: _notifAct.title || _notifAct.text,
      trailing: '<span class="ubp-island-unread"></span>',
    };
  }
  return null;
}

/** 刷新灵动岛胶囊 + 折叠态悬浮球游戏胶囊。
 *  相同内容跳过重写（生成/对局每步都可能触发，避免无谓 DOM 写）。 */
function refreshIsland(): void {  const island = _shadow?.querySelector('.ubp-island') as HTMLElement | null;
  const pill = _shadow?.querySelector('.ubp-ball-game') as HTMLElement | null;
  if (!island || !pill) return;
  const act = _open ? currentIslandActivity() : null;
  const islandKey = act?.key || '';
  if (islandKey !== _lastIslandKey) {
    _lastIslandKey = islandKey;
    island.hidden = !act;
    if (act) {
      island.className = `ubp-island${act.cls}`;
      const ico = island.querySelector('.ubp-island-ico');
      const text = island.querySelector('.ubp-island-text');
      if (ico) ico.innerHTML = act.icon;
      if (text) text.textContent = act.name;
    }
    // 岛上内容变了 ⇒ 展开卡若开着，同步刷新（同一件事不在两处显示不同内容）
    if (_islandCard) renderIslandCard();
    else if (!act) closeIslandCard();
  }
  // 折叠态：AI 活动角标（蓝青/微信绿/商城橙）+ 呼吸环；与未读红点、游戏胶囊并存
  const aiList = listPhoneAiActivities();
  const showAiBadge = Boolean(!_open && aiList.length);
  const ballAi = _shadow?.querySelector('.ubp-ball-ai') as HTMLElement | null;
  const ball = _shadow?.querySelector('.ubp-ball') as HTMLElement | null;
  if (ballAi) {
    const text = showAiBadge ? (aiList.length > 1 ? String(aiList.length) : 'AI') : '';
    if (ballAi.textContent !== text) ballAi.textContent = text;
    ballAi.classList.toggle('on', showAiBadge);
  }
  if (ball) ball.classList.toggle('ubp-ball-ai-on', showAiBadge);
  // 折叠态：悬浮球只在「轮到我」时提示（对局专属，与岛的多源仲裁无关）
  const info = gameProgressStatus();
  const gameCls = info?.gameType === 'undercover' ? ' undercover' : info?.gameType === 'turtlesoup' ? ' soup' : '';
  const showPill = Boolean(!_open && info?.myTurn);
  const pillKey = showPill ? info!.gameType : '';
  if (pillKey !== _lastPillKey) {
    _lastPillKey = pillKey;
    pill.innerHTML = ubpIcon('gamepad');
    pill.className = `ubp-ball-game${gameCls}${showPill ? ' on' : ''}`;
  }
}

/** 文字 AI 活动变化 → 岛与收起浮球即时刷新（幂等；同一件事不在两处显示不同内容）。 */
subscribePhoneAiActivities(() => refreshIsland());

/**
 * 商城上货的岛活动开关（app-shop 调；docs/52 §7.1）。
 * 起=上岛「上货中」；收=落岛。状态跨 App 卸载保留（生成还在跑，岛就该还亮着），
 * 但**手机收起时岛本就不显示**（refreshIsland 看 _open），展开即按当前状态重绘。
 */
export function setShopGenActivity(active: boolean): void {
  const next = active ? { text: S('商城上货中…', '万宝阁备货中…', '商行张罗中…', '商栈进货中…') } : null;
  if (Boolean(_shopGenAct) === Boolean(next)) return; // 只报「变了」（幂等，重复调用零 DOM 写）
  _shopGenAct = next;
  refreshIsland();
}

/**
 * 商城「掌柜回复中」的岛活动开关（renderers/shop-chat 调；docs/54 §12.3）。
 * 起=上岛「<店名> · 回复中」；收=落岛。状态跨 App 卸载保留（回复还在跑，岛就该还亮着），
 * 展开卡的「去看会话」深链直达那条会话（threadId 走 key）。与「上货中」同色，上货优先显示。
 */
export function setShopChatActivity(active: boolean, seller = '', threadId = ''): void {
  const next = active
    ? { seller: String(seller || '').trim() || S('商家', '商家', '商号', '商铺'), threadId: String(threadId || '') }
    : null;
  // 同一次生成里 seller/threadId 不会变；重复调用零 DOM 写（幂等）
  if (Boolean(_shopChatAct) === Boolean(next)) { _shopChatAct = next; return; }
  _shopChatAct = next;
  refreshIsland();
}

/** 壳重建/收手机时的状态复位（元素随旧 shadow 一起没了，模块引用必须清）。 */
function resetIslandState(): void {
  if (_notifClearTimer) { clearTimeout(_notifClearTimer); _notifClearTimer = null; }
  _notifAct = null;
  _lastIslandKey = '';
  _lastPillKey = '';
  _islandCard = null;
  _islandCardKey = '';
  _islandOutsideOff = null;
}

/** AI 活动列表行（统一卡在 AI / 通话两种宿主里复用）。 */
function phoneAiRowsHtml(): string {
  return listPhoneAiActivities().map((e) => {
    const done = e.phase === 'terminating';
    const sub = done
      ? S('已终止，正在收尾', '已终止，正在收尾')
      : aiPhaseText({ phase: e.phase, attempt: e.attempt, maxAttempts: e.maxAttempts });
    return '<div class="ubp-ai-row' + (done ? ' done' : '') + '">'
      + '<b>' + escapeHtml(e.label) + '</b>'
      + '<span class="sub">' + escapeHtml(sub) + '</span>'
      + (done ? '' : '<button type="button" data-ubp-ai-cancel="' + escapeAttr(e.id) + '">' + S('终止', '终止') + '</button>')
      + '</div>';
  }).join('');
}

/** 展开卡内容（活动详情 + 主动作；与胶囊同源、同一份仲裁结果）。 */
function islandCardHtml(act: IslandActivity): string {
  if (act.kind === 'ai') {
    const list = listPhoneAiActivities();
    const rows = phoneAiRowsHtml();
    const firstApp = list.find(e => e.appId)?.appId || 'wechat';
    return `<div class="ubp-ic-hd">
      <span class="ubp-ic-badge" style="background:${act.color}">${act.icon}</span>
      <span class="ubp-ic-tx"><b class="ubp-ic-name">${escapeHtml(act.name)}</b><span class="ubp-ic-sub">${escapeHtml(act.sub)}</span></span>
    </div>
    <div class="ubp-ai-list">${rows}</div>
    <div class="ubp-ic-acts"><button type="button" class="ubp-ic-btn danger" data-ubp-ic="ai-stop">${S('全部终止', '全部终止')}</button><button type="button" class="ubp-ic-btn go" data-ubp-ic="go" data-ubp-ic-app="${escapeAttr(firstApp)}">${S('去看看', '去看看')}</button></div>`;
  }
  const acts: string[] = [];
  if (act.kind === 'call') {
    acts.push(`<button type="button" class="ubp-ic-btn go" data-ubp-ic="go" data-ubp-ic-app="phone-call">${S('回到通话', '回到传音', '回到传声', '回到远语')}</button>`);
    acts.push(`<button type="button" class="ubp-ic-btn danger" data-ubp-ic="hangup">${S('挂断', '断开', '收线', '断共鸣')}</button>`);
  } else if (act.kind === 'game') {
    acts.push(`<button type="button" class="ubp-ic-btn go" data-ubp-ic="game">${S('回到对局', '回到对局')}</button>`);
  } else if (act.kind === 'notif') {
    acts.push(`<button type="button" class="ubp-ic-btn go" data-ubp-ic="go" data-ubp-ic-app="${escapeAttr(_notifAct?.appId || '')}">${S('查看', '查看')}</button>`);
  } else if (act.kind === 'shop') {
    acts.push(`<button type="button" class="ubp-ic-btn go" data-ubp-ic="go" data-ubp-ic-app="shop">${S('去看货架', '去看货架', '去看货担', '去看行囊')}</button>`);
  } else if (act.kind === 'shopchat') {
    acts.push(`<button type="button" class="ubp-ic-btn go" data-ubp-ic="go" data-ubp-ic-app="shop">${S('去看会话', '去看看', '去看看', '去看看')}</button>`);
  } else {
    acts.push(`<button type="button" class="ubp-ic-btn go" data-ubp-ic="go" data-ubp-ic-app="wechat">${S('回到会话', '回到往来')}</button>`);
  }
  // 通话时卡内同时显示后台 AI 条目（与既有 call 卡合并；逐条终止 + 全部终止）
  const aiRows = act.kind === 'call' ? phoneAiRowsHtml() : '';
  if (aiRows) {
    acts.unshift(`<button type="button" class="ubp-ic-btn" data-ubp-ic="ai-stop">${S('全部终止', '全部终止')}</button>`);
  }
  return `<div class="ubp-ic-hd">
      <span class="ubp-ic-badge" style="background:${act.color}">${act.icon}</span>
      <span class="ubp-ic-tx"><b class="ubp-ic-name">${escapeHtml(act.name)}</b><span class="ubp-ic-sub">${escapeHtml(act.sub)}</span></span>
      ${act.trailing ? `<span class="ubp-ic-timer">${act.trailing.replace(/<\/?span[^>]*>/g, '').trim() || ''}</span>` : ''}
    </div>
    ${aiRows ? `<div class="ubp-ai-list">${aiRows}</div>` : ''}
    <div class="ubp-ic-acts">${acts.join('')}</div>`;
}

/** 就地刷新展开卡（保签名：内容没变不重写）。 */
function renderIslandCard(): void {
  if (!_islandCard) return;
  const act = currentIslandActivity();
  if (!act) { closeIslandCard(); return; }
  if (act.key === _islandCardKey) return;
  _islandCardKey = act.key;
  _islandCard.innerHTML = islandCardHtml(act);
}

/** 展开卡：点按胶囊展开（真机口径）。 */
function openIslandCard(): void {
  const act = currentIslandActivity();
  const screen = _shadow?.querySelector('.ubp-screen') as HTMLElement | null;
  if (!act || !screen) return;
  removePhoneBanner(); // 顶部同一时刻只留一条
  if (!_islandCard) {
    const doc = hostDocument();
    const el = doc.createElement('div');
    el.className = 'ubp-island-card';
    el.addEventListener('click', onIslandCardClick);
    screen.appendChild(el);
    _islandCard = el;
    _islandCardKey = '';
    // 点卡外任意处收起（捕获阶段只收起、不拦事件 ⇒ 点 App 图标照常打开）
    const onOutside = (event: Event): void => {
      const t = event.target as HTMLElement | null;
      if (t && (t.closest?.('.ubp-island-card') || t.closest?.('.ubp-island'))) return;
      closeIslandCard();
    };
    screen.addEventListener('click', onOutside, true);
    _islandOutsideOff = () => screen.removeEventListener('click', onOutside, true);
  }
  renderIslandCard();
}

/** 收起展开卡（幂等；层随之移除、监听成对摘除）。 */
function closeIslandCard(): void {
  _islandOutsideOff?.();
  _islandOutsideOff = null;
  _islandCard?.remove();
  _islandCard = null;
  _islandCardKey = '';
}

function onIslandCardClick(event: Event): void {
  const target = event.target as HTMLElement;
  // AI 活动逐条终止（先于 data-ubp-ic 判定：终止按钮不带动作属性）
  const cancelBtn = target.closest('[data-ubp-ai-cancel]') as HTMLElement | null;
  if (cancelBtn) {
    const id = cancelBtn.getAttribute('data-ubp-ai-cancel') || '';
    if (id) cancelPhoneAiActivity(id);
    _islandCardKey = '';
    renderIslandCard();
    return;
  }
  const btn = target.closest('[data-ubp-ic]') as HTMLElement | null;
  if (!btn) return;
  const action = btn.dataset.ubpIc || '';
  const act = currentIslandActivity();
  if (action === 'ai-stop') {
    cancelAllPhoneAiActivities(e => e.cancelable && e.phase !== 'terminating');
    _islandCardKey = '';
    renderIslandCard();
    return;
  }
  if (action === 'hangup') {
    closeIslandCard();
    emitPhoneEvent('ubp-phone:call-hangup'); // 通话侧模块级监听（壳层不能 import 那个 App）
    return;
  }
  if (action === 'game') { closeIslandCard(); emitPhoneEvent('ubp-phone:goto-game'); return; }
  if (action === 'go') {
    const appId = btn.dataset.ubpIcApp || '';
    closeIslandCard();
    if (!appId || !getPhoneApp(appId)) return;
    if (act?.kind === 'gen') {
      const convId = act.key.split('|')[1] || '';
      if (convId) setPendingAppTarget(appId, convId);
    } else if (act?.kind === 'shopchat') {
      const threadId = _shopChatAct?.threadId || act.key.split('|')[1] || '';
      if (threadId) setPendingAppTarget(appId, threadId);
    } else if (act?.kind === 'notif' && _notifAct?.convId) {
      setPendingAppTarget(appId, _notifAct.convId, _notifAct.mid || undefined);
    }
    _notifAct = null; // 已查看：吸入态下线
    openApp(appId);
  }
}

// ─── 主项目未就绪：降级处理（SH-04）───
// 常驻工程横幅退役 → ①桌面「设置」图标角标（根类驱动，零 JS 生命周期）②设置页状态卡（用户语言 + 重新检测）
// ③首次出现时屏内提示一次（只报结果；「怎么修」由设置卡的按钮承担，不再常驻一句解释）

let _hostAlertBound = false;
let _hostReadiness: HostReadiness | null = null;
let _hostAlertToasted = false;

/** 订阅一次探测广播（壳重建后 renderHostAlert 经 _shadow 查新元素，无需重绑）。 */
function ensureHostAlertBinding(): void {
  if (_hostAlertBound) return;
  _hostAlertBound = true;
  onHostReadinessChanged(renderHostAlert);
}

/** 就绪状态变化：刷新根类角标 + 首次提示。 */
function renderHostAlert(readiness: HostReadiness): void {
  _hostReadiness = readiness;
  _shadow?.querySelector('.ubp-scope')?.classList.toggle('ubp-host-notready', !readiness.ready);
  if (readiness.ready) { _hostAlertToasted = false; return; }
  if (_hostAlertToasted) return;
  _hostAlertToasted = true;
  const container = _shadow?.querySelector('.ubp-app') as HTMLElement | null;
  if (container) showScreenToast(container, '主项目未就绪');
}

/** 设置页状态卡读取用（null=尚未探测）。 */
export function hostReadinessState(): HostReadiness | null {
  return _hostReadiness;
}

/** 设置页状态卡「重新检测」：重匹配（重读配置 + 补注册）后刷新角标与状态卡。 */
export async function rematchHostFromSettings(): Promise<HostReadiness> {
  const readiness = await rematchHost();
  renderHostAlert(readiness);
  return readiness;
}

function applyChrome(): void {
  const scope = _shadow?.querySelector('.ubp-scope') as HTMLElement | null;
  if (!scope) return;
  scope.classList.toggle('ubp-dark', isDarkMode());
  // 风格 class（与 .ubp-dark 正交叠加）：当前风格开、其余风格关（幂等切换）
  const style = currentStyle();
  scope.classList.toggle('ubp-skin-xianxia', style === 'xianxia');
  scope.classList.toggle('ubp-skin-wuxia', style === 'wuxia');
  scope.classList.toggle('ubp-skin-fantasy', style === 'fantasy');
  // 皮肤 class（视觉层，全局设置；置于风格段之后 → 皮肤视觉盖过风格视觉）。
  // 美化工坊派生：custom 皮肤可带 base（在内置皮肤之上叠加）——基底 class 同时挂上，
  // 自定义段注入在主样式之后（syncCustomSkinStyle），同特异性下自定义覆盖基底。
  const skinId = currentSkinId();
  const customSkin = skinId === 'custom' ? currentCustomSkin() : null;
  scope.classList.toggle('ubp-theme-sweet', skinId === 'sweet' || customSkin?.base === 'sweet');
  scope.classList.toggle('ubp-theme-flirty', skinId === 'flirty' || customSkin?.base === 'flirty');
  scope.classList.toggle('ubp-theme-custom', !!customSkin);
  syncCustomSkinStyle(customSkin);
  syncFontFaces();
  // 悬浮球 tooltip 随风格换设备名（元层信息，纯展示）
  const ball = _shadow?.querySelector('.ubp-ball') as HTMLElement | null;
  if (ball) ball.title = s(style, '瑟瑟小手机', '传讯玉简', '天机匣', '传讯水晶');
  // 字体设置（设置→通用）：行内变量优先级最高，字号 calc 与字体族全机即时生效；
  // 字体族不设 = 跟随风格（现代系统字体 / 仙侠楷体 / 武侠宋体 / 西幻楷体）或皮肤默认字体
  const settings = getPhoneSettings();
  if (settings.fontScale !== 1) scope.style.setProperty('--ubp-font-scale', String(settings.fontScale));
  else scope.style.removeProperty('--ubp-font-scale');
  const fontStack = resolvePhoneFontStack(settings.fontFamily);
  if (fontStack) scope.style.setProperty('--ubp-font', fontStack);
  else scope.style.removeProperty('--ubp-font');
  // 整机缩放（设置→通用「手机缩放」）：变量仅 ≠1 时存在（100%=CSS 默认，零差异）
  if (settings.phoneZoom !== 1) scope.style.setProperty('--ubp-zoom', String(settings.phoneZoom));
  else scope.style.removeProperty('--ubp-zoom');
  reclampZoomedPhone();
  updateClock();
}

/** 缩放变更后回拉：已拖放定位（inline left/top 存在）的手机按缩放后 rect 重新钳进视口
 *  （原点左上、放大向右下生长 → 右/下可能溢出；缩小无溢出，clamp 幂等无害。
 *  未定位=默认静态位交给 CSS；收起态 rect 归零、clamp 恒等，不会误写位置）。 */
function reclampZoomedPhone(): void {
  const phone = _shadow?.querySelector('.ubp-phone') as HTMLElement | null;
  if (!phone || !phone.style.left) return;
  const rect = phone.getBoundingClientRect();
  const p = clampToViewport(rect.left, rect.top, rect.width, rect.height);
  if (p.left !== rect.left || p.top !== rect.top) {
    phone.style.left = `${p.left}px`;
    phone.style.top = `${p.top}px`;
  }
}

let _customSkinCss = '';
/** 自定义皮肤样式注入（仅 skin=custom 时存在；内容未变化跳过重写，关闭即整元素摘除；
 *  手机壳重挂载后新 shadow 无 style 元素，按元素缺失重建，避免只切 class 不见样式）。 */
function syncCustomSkinStyle(def: ReturnType<typeof currentCustomSkin>): void {
  const shadow = _shadow;
  if (!shadow) return;
  let style = shadow.querySelector('style[data-ubp-skin-custom]') as HTMLStyleElement | null;
  const css = def ? phoneSkinCss(def) : '';
  if (!def) {
    style?.remove();
    _customSkinCss = '';
    return;
  }
  if (style && css === _customSkinCss) return;
  if (!style) {
    style = hostDocument().createElement('style');
    style.dataset.ubpSkinCustom = '1';
    shadow.appendChild(style); // 主样式之后 → 后写入者胜出
  }
  style.textContent = css;
  _customSkinCss = css;
}

let _fontFaceCss = '';
/** 用户字体库注入（美化工坊上传的 woff/ttf dataUrl 或远程 woff2；空库=零节点零样式）。
 *  @font-face 定义在 Shadow Root 的样式表里 → 天然只作用于手机 UI，不外溢宿主页面。 */
function syncFontFaces(): void {
  const shadow = _shadow;
  if (!shadow) return;
  const fonts = getPhoneSettings().fontLibrary;
  let style = shadow.querySelector('style[data-ubp-fonts]') as HTMLStyleElement | null;
  if (!fonts.length) {
    style?.remove();
    _fontFaceCss = '';
    return;
  }
  const css = fonts.map(f => {
    const src = f.source === 'data' ? (f.dataUrl || '') : (f.url || '');
    if (!src) return '';
    return `@font-face{font-family:"${f.family}";src:url("${src}") format("${f.format}");font-display:swap;}`;
  }).filter(Boolean).join('\n');
  if (style && css === _fontFaceCss) return;
  if (!style) {
    style = hostDocument().createElement('style');
    style.dataset.ubpFonts = '1';
    shadow.appendChild(style);
  }
  style.textContent = css;
  _fontFaceCss = css;
}

function updateClock(): void {
  // 全机只显示故事时间（全局数据表「当前时间」快照），无任何真实时间
  const story = getRoster().global.time;
  const el = _shadow?.querySelector('.ubp-sb-time') as HTMLElement | null;
  if (el) {
    // 状态栏只显示时刻（HH:MM），不显示日期；故事时间缺时刻成分时回退原文
    el.textContent = storyClockText(story, currentStyle());
    el.title = story;
  }
  syncHomeClock();
  refreshScheduleBanner(); // 故事时间推进（跨天）时窗口随之重算：过期消失、明天的变今天（缓存按故事日，无额外读表）
}

/** 桌面可见时重渲染（壁纸等桌面外观变更后调用；App 打开中=桌面不可见，跳过）。 */
export function refreshHome(): void {
  if (_open && !_currentAppId) renderHome();
}

function startClock(): void {
  stopClock();
  _clockTimer = setInterval(updateClock, 10000);
}

function stopClock(): void {
  if (_clockTimer) {
    clearInterval(_clockTimer);
    _clockTimer = null;
  }
}

// ─── 软键盘避让（窄屏全屏态） ───
// 病灶：真机弹软键盘只缩**视觉视口**，布局视口与 100dvh 都不动 ⇒ 窄屏铺满视口的壳高度不变，
// 钉在壳底的输入栏（微信 .ubp-inputbar / 商城消息 .ubp-shc-inputzone / 游戏中心 .ubp-gm-inputbar）
// 被键盘盖住；而输入栏的祖先链里没有可滚动容器（.ubp-screen 是 overflow:hidden、机身与
// #ubp-root 都是 fixed），浏览器「把焦点元素滚进视野」这条兜底也够不着它。
// 修法：壳层把「被键盘盖住的高度」量出来写成 CSS 变量，由 CSS 压矮壳——输入栏随之抬到键盘之上。
//
// 零影响面（不触发移动端输入时逐像素不变）：变量只在窄屏全屏态且确实被盖住时写入，缺省即 0
// （max-height 与 height 等值、translateY(0px) 与 none 等价）；监听随手机开合起停，收起态不挂
// 任何监听（与状态栏时钟同一纪律）。

/** 键盘让位量（px）＝视觉视口比布局视口矮了多少＝壳要压矮多少。
 *  - 浏览器若把**布局**视口一起改小（Chrome interactive-widget=resizes-content 等），算出来恒为 0：
 *    那时 100dvh 自己就矮了，壳不需要再让——不会二次压缩。
 *  - **不含视觉视口偏移（offsetTop）**：可见窗口在布局坐标里是 [offsetTop, offsetTop + vv.height]，
 *    压矮量只由高度差决定，偏移单独由 --ubp-kb-top 平移表达。把 offsetTop 也减进让位量会双重计算
 *    （壳高出 offsetTop，输入栏重新掉回键盘下）——这正是本轮 e2e 抓到的边界。
 *  - 取整：键盘起落动画每帧都在变，取整后同一像素值的多次事件不会重写样式（省掉无谓的重排）。
 *  - 非有限值（老环境/异常探针）归零，真值是「不小于 0」的整数像素。
 *  导出供测试钉真值表（与 app-wechat 的 inputRightSlotAct 同一口径：唯一真值源必须可测）。 */
export function keyboardOverlap(layoutHeight: number, visualHeight: number): number {
  if (!Number.isFinite(layoutHeight) || !Number.isFinite(visualHeight)) return 0;
  if (visualHeight <= 0) return 0; // 视觉视口高 0 = 页面不可见/环境异常，不是键盘——不得据此把壳压成 0
  return Math.max(0, Math.round(layoutHeight - visualHeight));
}

let _kbOff: (() => void) | null = null;
/** 上次写入的让位量/偏移：只在它们变化时才动 CSS 变量与广播（键盘动画期间事件很密，取整后大多命中早退）。
 *  两者**分开比较**——键盘高度不变、视觉视口只滚动（offsetTop 变）时也要跟住（订阅 scroll 就是为了它）。 */
let _kbInset = 0;
let _kbTop = 0;

/** 绑定软键盘避让（手机展开时挂、收起时摘，同状态栏时钟）。 */
function startKeyboardWatch(): void {
  stopKeyboardWatch();
  // 监听**托管手机壳的那个 window**（宿主注入=酒馆页面自身；dev iframe=iframe 本身）：壳体量由它决定，
  // 故窄屏判定也问它——本壳的媒体查询就是按这个视口求值的，用 hostWindow() 会与 CSS 判断脱节。
  const win = resolveRootDocument().defaultView;
  const vv = win?.visualViewport;
  if (!win || !vv) return; // 无 visualViewport（老浏览器）：功能恒不生效，连监听都不挂
  const apply = (): void => {
    const scope = _shadow?.querySelector('.ubp-scope') as HTMLElement | null;
    if (!scope) return;
    const inset = isNarrowFullscreenViewport(win) ? keyboardOverlap(win.innerHeight, vv.height) : 0;
    const top = inset > 0 ? Math.round(vv.offsetTop) : 0;
    if (inset === _kbInset && top === _kbTop) return;
    const prev = _kbInset;
    _kbInset = inset;
    _kbTop = top;
    if (inset > 0) {
      scope.style.setProperty('--ubp-kb-h', `${inset}px`);
      // 视觉视口偏移：多数浏览器（含 iOS）为 0，少数会滚视觉视口的场景里不跟住壳会偏半屏
      // （可见窗口＝[offsetTop, offsetTop+height]，压矮量与偏移各管一半，见 keyboardOverlap 注释）
      scope.style.setProperty('--ubp-kb-top', `${top}px`);
    } else {
      scope.style.removeProperty('--ubp-kb-h');
      scope.style.removeProperty('--ubp-kb-top');
    }
    // 壳矮了 ⇒ 原本贴底的滚动容器要把最后几条重新顶进视野（App 侧按需接，见 app-wechat）
    emitPhoneEvent('ubp-phone:viewport-changed', { inset, prevInset: prev });
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  _kbOff = () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
  };
  apply(); // 挂上先对齐一次（例如键盘还开着时重新展开手机）
}

/** 摘监听并还原：变量不留在壳上，下次展开从「满屏」这个已知态出发（幂等，可重复调用）。 */
function stopKeyboardWatch(): void {
  if (_kbOff) {
    _kbOff();
    _kbOff = null;
  }
  if (!_kbInset && !_kbTop) return;
  _kbInset = 0;
  _kbTop = 0;
  const scope = _shadow?.querySelector('.ubp-scope') as HTMLElement | null;
  scope?.style.removeProperty('--ubp-kb-h');
  scope?.style.removeProperty('--ubp-kb-top');
}

/** 外部刷新入口（切聊天/数据变化时由 index 调）。 */
export function refreshPhone(): void {
  ensurePhoneMounted();
  applyChrome(); // 切聊天=风格随数据换底（皮肤 class 跟随，幂等）
  refreshBallBadge();
  if (!_open) return;
  if (_currentAppId) {
    const id = _currentAppId;
    openApp(id, { system: true }); // 重新挂载当前 App（系统路径：不计 phone_app_opened/phone_opened）
  } else {
    renderHome();
  }
}

/**
 * 确保 UI 挂载在当前文档中：宿主把 #ubp-root 移除后（清聊天/换卡等场景）
 * shadow 仍在内存但脱离文档——此时重建壳并重新挂载当前 App。
 */
export function ensurePhoneMounted(): void {
  if (_shadow && _rootHost && _rootHost.isConnected) return;
  if (_appCleanup) {
    try {
      _appCleanup();
    } catch (_e) { /* ignore */ }
    _appCleanup = null;
  }
  // 两块下拉面板是**本壳内**的浮层：重建会整块摘掉 shadow DOM，但模块态引用与挂在 layer.remove 上的
  // doc keydown 不会随之清理 → 之后 open 会因「已有层」而跳过建层，面板永久打不开且监听滞留。
  // 重建前物理拆除（dispose：立即移除并清引用/监听/定时器）——两块面板同一口径（第五轮 ⑧）。
  notifyPanel.dispose();
  controlPanel.dispose();
  dismissScreenOverlay(); // 屏内临时层随壳一起失效：重建前收掉并清登记（防死引用）
  _schedBanner = null; // 日程横幅同理：元素随 shadow 一起消失，清模块引用
  _sheetClosers.length = 0; // 弹层关闭器栈同理：其 DOM 随壳一起消失，留着是死引用
  releaseShellBindings(); // 壳层订阅与 App 清理成对：重挂载前释放，防监听器随重建线性累积
  _shadow = null;
  _rootHost = null;
  _open = false;
  _currentAppId = null;
  stopClock();
  stopKeyboardWatch(); // 键盘避让监听/变量与壳成对（变量挂在旧 .ubp-scope 上，新壳从零开始）
  mountPhone();
}

// ─── 跨视图滚动记忆（铁律 rerender-scroll-preservation 的跨视图补充） ───
// 全量 innerHTML 重绘会换掉滚动容器（scrollTop 归零）。各 App 的「同视图重绘保位」只覆盖 A→A；
// 「列表 → 帖详情 → 返回列表」这类跨视图往返，渲染前读到的 scrollTop 是**当前视图**的（详情页一般
// 为 0），返回时把它填回列表 → 列表回到顶部（用户报障：微博/贴吧看完帖返回找不到刚才读的位置）。
// 修法：按视图键分别记忆——键变了就把旧视图位置记到旧键下，新视图取自己的记忆位；没访问过的键 = 0
// （从顶开始，详情页首次进入即顶端）。调用点在每次渲染之后（innerHTML 已写入新容器之后）。
export interface ViewScrollState {
  top: number;
  /** 离开时是否贴底（流式日志/聊天：回来应继续跟底，而不是停在某个旧像素）。 */
  atBottom: boolean;
}
export interface ViewScrollMemo {
  /** 每次渲染后调用：传本次视图键 + 渲染前读到的旧容器 scrollTop，返回本次视图应落的位置。 */
  settle(key: string, prevTop: number, prevAtBottom?: boolean): ViewScrollState;
  /** 清空（App 重开 = 新一轮，不继承上一次打开时的滚动位置）。 */
  clear(): void;
}
export function createViewScrollMemo(): ViewScrollMemo {
  const memo = new Map<string, ViewScrollState>();
  let shown = '';
  return {
    settle(key, prevTop, prevAtBottom = false) {
      const same = key === shown;
      if (!same && shown) memo.set(shown, { top: prevTop, atBottom: prevAtBottom }); // 离开旧视图：记位
      shown = key;
      const entry = same ? { top: prevTop, atBottom: prevAtBottom } : memo.get(key);
      return entry ? { top: entry.top, atBottom: entry.atBottom } : { top: 0, atBottom: false };
    },
    clear() {
      memo.clear();
      shown = '';
    },
  };
}

// ─── HTML 转义（统一出口在 core/ubp-utils；此处 re-export，25 个 renderer 的既有 import 路径不变） ───
import { createCoalescer, escapeAttr, escapeHtml } from '../core/ubp-utils';
import { emitAch } from '../core/phone-achievements';
import { feedback } from '../core/device-feedback';
import { BANNER_MERGE_MS, BANNER_VISIBLE_MS, MESSAGE_SOUND_GAP_MS, shouldShowBanner } from '../core/phone-notify-policy';
import { LOCK_SINCE_KEY, shouldLockOnOpen } from '../core/phone-lock';
export { escapeAttr, escapeHtml };

/** 群消息 @ 高亮（微信 / 窥私共用唯一实现）。
 *  原实现在两个 App 里各写一份、且**对每条消息**都 `new RegExp` —— 2000 条群聊等于每帧 2000 次
 *  正则编译。成员集合在一次渲染内是常量，故按集合键缓存编译结果（上限 8 组，跨会话滚动淘汰）。 */
const _mentionPatternCache = new Map<string, RegExp>();
const MENTION_PATTERN_CACHE_MAX = 8;

function mentionPattern(members: readonly string[]): RegExp {
  const key = members.join('\u0000');
  const hit = _mentionPatternCache.get(key);
  if (hit) return hit;
  const names = [...members, '所有人'];
  const pattern = new RegExp(`@(?:${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  if (_mentionPatternCache.size >= MENTION_PATTERN_CACHE_MAX) {
    const oldest = _mentionPatternCache.keys().next().value;
    if (oldest !== undefined) _mentionPatternCache.delete(oldest);
  }
  _mentionPatternCache.set(key, pattern);
  return pattern;
}

export function renderTextWithMentions(content: string, members: readonly string[]): string {
  const pattern = mentionPattern(members);
  pattern.lastIndex = 0; // 复用的全局正则必须复位（否则本次扫描会从上次的游标继续）
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > last) parts.push(escapeHtml(content.slice(last, match.index)));
    parts.push(`<span class="ubp-mention-tag">${escapeHtml(match[0])}</span>`);
    last = match.index + match[0].length;
  }
  parts.push(escapeHtml(content.slice(last)));
  return parts.join('');
}

/** 头像底色：实现在 core/phone-avatars（正文联动渲染也要用同一份，放 core 避免 core→renderers 反向依赖）。 */
export { avatarColor };

/** 头像破图兜底（第六轮 ⑦）：真图加载失败时隐藏上层取景层，露出底层生成头像（不再出现碎裂图标）。
 *  用**委托**而不是行内 onerror：error 事件不冒泡，故必须 capture 阶段；挂在常驻的 .ubp-scope 上，
 *  一处覆盖全机所有头像位（含 App 重绘后新生成的）。
 *  只兜头像位——聊天图/相册图另有自己的三态占位（未开始/生成中/失败），不在此列。 */
function bindAvatarErrorFallback(scope: HTMLElement): void {
  scope.addEventListener('error', (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.tagName !== 'IMG') return;
    const media = target.closest('.ubp-crop-media') as HTMLElement | null;
    if (!media || !media.closest('.ubp-avatar')) return;
    media.style.display = 'none';
  }, true);
}

/** 生成头像（无立绘/无自定义图时的那张脸）：同色系渐变 + 一层极淡图案 + 首字/群字形。
 *  第六轮 ⑦：有真图时它作为**底层**一并输出（真图 .ubp-crop-media 盖在上面）；真图加载失败时由
 *  壳层的委托 error 监听（bindAvatarErrorFallback）把上层隐藏，露出这一层——
 *  不用行内 onerror（怕宿主 CSP 禁掉内联处理器，届时整批静默失效）。
 *  图案层是纯 CSS（.ubp-avatar-pat）、渐变由 core 的 avatarGradient 按名字稳定散列给出，零资源文件。 */
function genAvatarHtml(name: string, extraCls: string, glyph: string): string {
  return `<span class="ubp-avatar ubp-avatar-gen${extraCls}" style="background-image:${escapeAttr(avatarGradient(name))}">` +
    `<span class="ubp-avatar-glyph">${escapeHtml(glyph)}</span><i class="ubp-avatar-pat"></i></span>`;
}

/** 头像 HTML：生效头像图（自定义/主项目立绘）优先，无图时按 fallback 决定是否回退生成头像。
 *  取景参数挂 av:<名> 槽位（一处覆盖全部头像位；无参数不输出 style）。第六轮 ⑦：有图时底层多一层
 *  生成头像（破图兜底），外层结构与取景行为不变。 */
export function avatarHtml(name: string, cls = '', fallback = true, fallbackText?: string): string {
  const path = resolveAvatarPath(name);
  const text = fallbackText ?? name.slice(0, 1);
  const extra = cls ? ' ' + cls : '';
  if (path) {
    const style = cropMediaStyle(`av:${name}`);
    const base = fallback ? genAvatarHtml(name, extra, text) : '';
    return `<span class="ubp-avatar${extra}">${base}<span class="ubp-crop-media"${style ? ` style="${style}"` : ''}><img src="${escapeAttr(path)}" alt="" loading="lazy"></span></span>`;
  }
  if (!fallback) return '';
  return genAvatarHtml(name, extra, text);
}

/** 可点头像（聊天页＝「打开资料卡」入口，本轮新增）：avatarHtml 外层包一个动作节点。
 *  **恒出头像**（fallback=true）——用户定案 2026-10-07：不管有无立绘都显示头像（占位图＝生成头像），
 *  否则没有立绘的角色在聊天里根本没有可点的东西。fallbackText 给主角哨兵 key 用（不然占位字是 `_`）。 */
export function avatarActHtml(name: string, act: string, cls = 'small', fallbackText?: string): string {
  return `<span class="ubp-ava-act" data-ubp-act="${escapeAttr(act)}" data-id="${escapeAttr(name)}">${avatarHtml(name, cls, true, fallbackText)}</span>`;
}

/** 群头像 HTML：会话自定义图（conv.avatar）优先，无图回落「标题哈希渐变 + 群字形」逐字保留上游观感。
 *  glyph 由调用方按皮肤传（微信 群/盟；窥私 群/盟/会/桌）；取景挂 cv:<会话id> 槽位。
 *  第六轮 ⑦：与真人头像同款——有图时底层也铺一层生成头像（破图兜底），渐变/图案口径与 avatarHtml 一致。 */
export function groupAvatarHtml(conv: { id: string; title: string; avatar?: string }, glyph: string): string {
  if (conv.avatar) {
    const style = cropMediaStyle(`cv:${conv.id}`);
    return `<span class="ubp-avatar group">${genAvatarHtml(conv.title, '', glyph)}<span class="ubp-crop-media"${style ? ` style="${style}"` : ''}><img src="${escapeAttr(conv.avatar)}" alt="" loading="lazy"></span></span>`;
  }
  return genAvatarHtml(conv.title, ' group', glyph);
}

/** 点亮反馈（第六轮 ⑥）：给刚被点的那一个动作钮挂一次性脉冲类（图标回弹 + 「+1」浮签）。
 *  **必须在 App 重绘之后调用**——重绘会整块换 innerHTML，类连同旧节点一起丢掉。
 *  为什么用显式脉冲而不是把动画挂在 `.on` 状态上：App 每次 data-changed 都整块重绘，
 *  挂在 `.on` 上会让每一帧重绘都重播一次动画。
 *  自清：单发 setTimeout（用户触发的一次性反馈，同 Toast / 长按 / 语音播放的既有纪律），不常驻、不轮询。
 *  找不到目标（重绘后该条已不在屏上）时静默返回，不抛错。 */
export function pulseActIcon(root: ParentNode | null, act: 'like' | 'collect', id: string): void {
  if (!root || !id) return;
  for (const node of Array.from(root.querySelectorAll(`[data-ubp-act="${act}"]`))) {
    const el = node as HTMLElement;
    if (el.dataset.id !== id) continue;
    el.classList.add('ubp-act-pulse');
    setTimeout(() => el.classList.remove('ubp-act-pulse'), 1000);
    return;
  }
}

// ─── 长按委托（统一底层：壳层内容长按 + hint-sheet 生成钮长按共用一份实现，IA-06） ───
// 原先两套并存的 480ms 计时器（本文件 bindLongPress / hint-sheet bindHintLongPress）已合并为
// bindPressCore；两个导出名与各自语义（命中对象、守卫、是否记「长按刚触发」）完全不变。

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10;
let _lpTimer: ReturnType<typeof setTimeout> | null = null;
let _lpStart: { x: number; y: number } | null = null;
let _lpFiredAt = 0;

/** 长按刚触发后的残留 click 识别（600ms 内；调用方在 handleClick 顶部吞掉，防打开详情）。 */
export function longPressJustFired(): boolean {
  return Date.now() - _lpFiredAt < 600;
}

/** 长按底层入参（token=命中返回值，原样回传 onFire；壳层传元素，提示层传自己的命中对象）。 */
export interface PressCoreOptions<T> {
  /** 命中判定：返回非 null 即武装。 */
  match: (target: HTMLElement) => T | null;
  /** 触发回调（480ms 长按 / 桌面右键同效）。 */
  onFire: (token: T) => void;
  /** 武装前守卫（false=本次不武装，如提示弹层已开着）。 */
  guard?: () => boolean;
  /** 触发时是否记「长按刚触发」时刻（壳层内容长按=true；提示层=false，残留 click 由弹层自吞）。 */
  markJustFired?: boolean;
}

/**
 * 长按统一实现：按住 480ms（移动>10px/抬起取消；桌面 contextmenu 立即）触发 onFire(token)。
 * 返回解绑函数（mount cleanup 成对移除）。
 */
export function bindPressCore<T>(container: HTMLElement, opts: PressCoreOptions<T>): () => void {
  const cancel = (): void => {
    if (_lpTimer) {
      clearTimeout(_lpTimer);
      _lpTimer = null;
    }
    _lpStart = null;
  };
  const fire = (token: T): void => {
    cancel();
    if (opts.markJustFired) _lpFiredAt = Date.now();
    opts.onFire(token);
  };
  const hit = (target: HTMLElement): T | null => {
    if (opts.guard && !opts.guard()) return null;
    return opts.match(target);
  };
  const down = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const token = hit(event.target as HTMLElement);
    if (token === null) return;
    cancel();
    _lpStart = { x: event.clientX, y: event.clientY };
    _lpTimer = setTimeout(() => fire(token), LONG_PRESS_MS);
  };
  const move = (event: PointerEvent): void => {
    if (!_lpTimer || !_lpStart) return;
    if (Math.abs(event.clientX - _lpStart.x) > LONG_PRESS_SLOP || Math.abs(event.clientY - _lpStart.y) > LONG_PRESS_SLOP) cancel();
  };
  const up = (): void => cancel();
  const menu = (event: Event): void => {
    const token = hit(event.target as HTMLElement);
    if (token === null) return;
    event.preventDefault();
    fire(token);
  };
  container.addEventListener('pointerdown', down);
  container.addEventListener('pointermove', move);
  container.addEventListener('pointerup', up);
  container.addEventListener('pointercancel', up);
  container.addEventListener('contextmenu', menu);
  return () => {
    cancel();
    container.removeEventListener('pointerdown', down);
    container.removeEventListener('pointermove', move);
    container.removeEventListener('pointerup', up);
    container.removeEventListener('pointercancel', up);
    container.removeEventListener('contextmenu', menu);
  };
}

/**
 * 容器级长按委托：match 命中的元素按住 480ms（移动>10px 取消；桌面 contextmenu 立即）触发 onFire(el)。
 * 返回解绑函数（mount cleanup 成对移除）。
 */
export function bindLongPress(
  container: HTMLElement,
  match: (target: HTMLElement) => HTMLElement | null,
  onFire: (el: HTMLElement) => void,
): () => void {
  return bindPressCore<HTMLElement>(container, { match, onFire, markJustFired: true });
}

// ─── 底部操作面板（唯一实现；社媒/不夜城长按入口与设置/窥私/相册的确认类共用） ───

export interface ActionSheetItem {
  /** 动作键（onPick 回传）。 */
  act: string;
  label: string;
  danger?: boolean;
}

/** 统一动作面板的一个动作（core/danger 口径）。 */
export interface ActionSheetAction {
  label: string;
  tone?: 'primary' | 'danger';
  onPick: () => void;
}

/** 统一动作面板入参（唯一实现口径）。 */
export interface ActionSheetCoreOptions {
  title: string;
  /** 说明正文（可选）。 */
  message?: string;
  /** 动作列（按序渲染）。menu 版式（默认）下末项即「取消」，单独成块。 */
  actions: ActionSheetAction[];
  /** 版式：menu=竖排动作项（IA-01 A，长按/卡片菜单，默认）；row=横排一行（IA-01 B 确认弹窗）。 */
  layout?: 'menu' | 'row';
  /** 未选项即被关闭（点背景 / Esc / 返回键）时的回调。 */
  onDismiss?: () => void;
}

/** 打开瞬间起忽略点击（长按松手那次 click 落在弹层上，防刚开即被关）。 */
const SHEET_STALE_CLICK_MS = 450;

/** 弹层关闭助手栈：返回键先关最上层弹层，弹层全关后才退 App（IA-03）。
 *  isOpen 用于惰性清理：弹层若已被别的路径（取消/点背景）关掉，返回键触发时自动摘除空登记，
 *  因此各弹层只需「打开时登记一行」，不必在每条关闭路径上记账。 */
interface SheetCloser { fn: () => void; isOpen?: () => boolean }
const _sheetClosers: SheetCloser[] = [];

/** 登记一个「可被返回键关掉」的弹层（打开时调用一次即可）。 */
export function pushSheetCloser(fn: () => void, isOpen?: () => boolean): void {
  _sheetClosers.push({ fn, isOpen });
}

/** 显式摘除登记（可选；不清也不漏——closeTopSheet 会惰性清理）。 */
export function popSheetCloser(fn: () => void): void {
  const i = _sheetClosers.findIndex(s => s.fn === fn);
  if (i >= 0) _sheetClosers.splice(i, 1);
}

/** 返回键调用：关掉最上层仍然开着的弹层；无弹层时返回 false（交给上层继续处理）。 */
export function closeTopSheet(): boolean {
  while (_sheetClosers.length) {
    const top = _sheetClosers.pop() as SheetCloser;
    if (top.isOpen && !top.isOpen()) continue; // 已被其它路径关掉 → 摘除空登记
    top.fn();
    return true;
  }
  return false;
}

/** 是否有弹层开着。 */
export function hasOpenSheet(): boolean {
  return _sheetClosers.some(s => !s.isOpen || s.isOpen());
}

/** 返回键兜底：点当前 App 内最上层的「返回/取消」控件（与屏幕上的返回箭头同语义）。
 *  这些 act 名即各 App 自带的返回控件登记表；新增返回控件须同步加进这里（契约测试会扫）。 */
const BACK_CONTROL_SELECTOR = [
  '[data-ubp-act="msg-menu-close"]',
  '[data-ubp-act="conv-menu-close"]',
  '[data-ubp-act="sel-cancel"]',
  '[data-ubp-act="chat-search-close"]',
  '[data-ubp-act="compose-cancel"]',
  '[data-ubp-act="comment-cancel"]',
  '[data-ubp-act="sub-back"]',
  '[data-ubp-act="author-back"]',
  '[data-ubp-act="bar-back"]',
  '[data-ubp-act="keyword-back"]',
  '[data-ubp-act="topic-back"]',
  '[data-ubp-act="contact-back"]',
  '[data-ubp-act="detail-back"]',
  '[data-ubp-act="back-list"]',
  '[data-ubp-act="back-about"]',
  '[data-ubp-act="back-live"]',
  '[data-ubp-act="back-dm"]',
  '[data-ubp-act="back-date"]',
  '[data-ubp-act="close-detail"]',
  '[data-ubp-act="close-edit"]',
  '[data-ubp-act="close-forward"]',
  '[data-ubp-act="close-del"]',
  '[data-ubp-act="close-viewer"]',
  '[data-ubp-act="num-close"]',
  '[data-ubp-act="speak-close"]',
  '[data-ubp-act="alias-cancel"]',
  '[data-ubp-act="date-cancel"]',
  '[data-ubp-act="live-cancel"]',
  '[data-ubp-act="quit-cancel"]',
  '[data-ubp-act="soup-giveup-cancel"]',
  '[data-ubp-act="soup-guess-cancel"]',
  '[data-ubp-act="start-conflict-cancel"]',
  '[data-ubp-act="overlay-close"]',
  // 网上商城（docs/52）：结算/成功/取消三个弹层的「再看看 / 继续逛 / 再想想」
  '[data-ubp-act="sheet-close"]',
  // 商城消息（docs/54）：会话页弹层的「取消/完成」与地点清单的「返回」
  '[data-ubp-act="shc-sheet-close"]',
  '[data-ubp-act="shc-loc-back"]',
].join(',');

export function clickTopBackControl(container: HTMLElement): boolean {
  const els = container.querySelectorAll<HTMLElement>(BACK_CONTROL_SELECTOR);
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (!el.isConnected || el.getClientRects().length === 0) continue; // 跳过已被移除/不可见的
    el.click();
    return true;
  }
  return false;
}

/**
 * 唯一动作面板实现（IA-01）：`.ubp-actionsheet` + Esc + 点背景 + 返回键 + 450ms 防误触。
 * 点动作先关面板再回传；幂等：先移除同容器旧面板；关闭时自动从返回键栈摘除。
 * 版式（mockup c-ia01）：A 底部动作面板=竖排动作项 + 末项「取消」单独一块（默认，长按菜单）；
 * B 居中确认=横排「取消 | 确认」一行（openConfirmSheet 传 layout:'row'）。
 * 约定：menu 版式下 actions 末项即「取消」（各调用方一致；横排时才用 tone:primary）。
 */
export function openActionSheetCore(container: HTMLElement, opts: ActionSheetCoreOptions): void {
  closeActionSheet(container);
  const doc = hostDocument();
  const openedAt = Date.now();
  let picked = false;
  // 竖排需至少 2 项（末项作取消块）；少于 2 项或显式 row → 走横排，避免空列表
  const menu = (opts.layout ?? 'menu') === 'menu' && opts.actions.length >= 2;
  const bodyHtml = menu
    ? `<div class="ubp-as-list">${opts.actions.slice(0, -1).map((a, i) => `<button type="button" class="ubp-as-item${a.tone === 'danger' ? ' danger' : ''}" data-ubp-as="${i}">${escapeHtml(a.label)}</button>`).join('')}</div>
    <button type="button" class="ubp-as-item ubp-as-cancel" data-ubp-as="${opts.actions.length - 1}">${escapeHtml(opts.actions[opts.actions.length - 1].label)}</button>`
    : `<div class="ubp-sheet-actions">${opts.actions.map((a, i) => `<button type="button" class="ubp-btn${a.tone === 'danger' ? ' danger' : a.tone === 'primary' ? ' primary' : ''}" data-ubp-as="${i}">${escapeHtml(a.label)}</button>`).join('')}</div>`;
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-actionsheet';
  overlay.innerHTML = `<div class="ubp-sheet" data-ubp-asstop="1">
    <div class="ubp-sheet-title">${escapeHtml(opts.title)}</div>
    ${opts.message ? `<div class="ubp-sheet-body" style="padding:0 2px 10px;">${escapeHtml(opts.message)}</div>` : ''}
    ${bodyHtml}
  </div>`;
  container.appendChild(overlay);

  const close = (): void => {
    doc.removeEventListener('keydown', onKeydown, true);
    popSheetCloser(close);
    overlay.remove();
    if (!picked) opts.onDismiss?.(); // 点背景/Esc/返回键关闭=未选项
  };
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
  overlay.addEventListener('click', event => {
    // 长按松手的残留 click：忽略（不关弹层、不触发）
    if (Date.now() - openedAt < SHEET_STALE_CLICK_MS) return;
    const btn = (event.target as HTMLElement).closest('[data-ubp-as]') as HTMLElement | null;
    if (!btn) {
      if (event.target === overlay) close();
      return;
    }
    const action = opts.actions[Number(btn.dataset.ubpAs)];
    picked = true;
    close();
    action?.onPick();
  });
  doc.addEventListener('keydown', onKeydown, true);
  pushSheetCloser(close, () => overlay.isConnected);
}

/** 旧口径适配（社媒/不夜城长按面板）：{items,onPick} → 统一动作面板 + 末尾「取消」。 */
export function openActionSheet(
  container: HTMLElement,
  opts: { title: string; body?: string; items: ActionSheetItem[]; onPick: (act: string) => void; onDismiss?: () => void },
): void {
  openActionSheetCore(container, {
    title: opts.title,
    ...(opts.body ? { message: opts.body } : {}),
    ...(opts.onDismiss ? { onDismiss: opts.onDismiss } : {}),
    actions: [
      ...opts.items.map(i => ({
        label: i.label,
        ...(i.danger ? { tone: 'danger' as const } : {}),
        onPick: () => opts.onPick(i.act),
      })),
      { label: '取消', onPick: () => { /* 取消=不回调 */ } },
    ],
  });
}

/** 移除容器内已存在的动作面板。 */
export function closeActionSheet(container: HTMLElement): void {
  container.querySelector('.ubp-actionsheet')?.remove();
}

/**
 * 底栏钉位长按菜单：更换（重开选择器）/ 取消钉住（第 4 格回到「＋」）。复用统一动作面板（IA-01 A）。
 * 为什么不是单击直达：底栏钉位的单击必须留给「打开这个 App」，更换/取消只能沉到长按。
 */
function openDockPinMenu(container: HTMLElement): void {
  openActionSheet(container, {
    title: '底栏应用',
    body: '这一格是你钉在底栏的 App',
    items: [
      { act: 'change', label: '更换钉住的应用' },
      { act: 'unpin', label: '取消钉住' },
    ],
    onPick: act => {
      if (act === 'change') {
        openAppDrawer(container);
        return;
      }
      writeDockPin('');
      renderHome();
    },
  });
}

/**
 * 底栏「＋」= 钉住选择器（WX-04：此前是「打开全部应用」的第二入口，与桌面网格完全重复，退役）。
 * 版式原样保留（底部抽屉 + 4 列图标网格 + 与桌面共用的磁贴链路 + 抽屉统一头部），只把语义从
 * 「打开」换成「钉住」：点磁贴 = 把它钉到底栏，不再开 App。关闭路径（✕ / 点背景 / Esc / 返回键）
 * 与 450ms 防误触口径跟全机其它弹层一致。
 * 固定三格（微信/通话/设置）本就恒在底栏，点它们只提示、不落钉（否则底栏出两个同款）。
 */
function openAppDrawer(container: HTMLElement): void {
  closeAppDrawer(container); // 幂等：先移除同容器旧抽屉
  const style = currentStyle();
  const doc = hostDocument();
  const openedAt = Date.now();
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-drawer-overlay';
  overlay.innerHTML = `<div class="ubp-sheet">
    <div class="ubp-sheet-head">
      <span class="ubp-sheet-headtitle">钉到底栏</span>
      <button type="button" class="ubp-sheet-x" data-ubp-drawer-x="1" title="关闭">✕</button>
    </div>
    <div class="ubp-drawer-hint">点一个 App，它就会占住底栏第 4 格；长按底栏图标可更换或取消</div>
    <div class="ubp-drawer-grid">${getPhoneApps().map(a => appTileHtml(a, style)).join('')}</div>
  </div>`;
  container.appendChild(overlay);

  const close = (): void => {
    doc.removeEventListener('keydown', onKeydown, true);
    popSheetCloser(close);
    overlay.remove();
  };
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
  overlay.addEventListener('click', event => {
    // 长按松手的残留 click：忽略（不关抽屉、不触发）
    if (Date.now() - openedAt < SHEET_STALE_CLICK_MS) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-ubp-drawer-x]')) {
      close();
      return;
    }
    const tile = target.closest('[data-ubp-app]') as HTMLElement | null;
    if (tile) {
      const appId = tile.dataset.ubpApp || '';
      // 固定三格已在底栏：只提示、不落钉，抽屉留着继续挑（与「不可用」同口径：不关抽屉）
      if (DOCK_IDS.includes(appId)) {
        showScreenToast(container, '「' + (getPhoneApp(appId)?.name || '') + '」已在底栏');
        return;
      }
      if (!tileAppAvailable(container, appId)) return;
      writeDockPin(appId);
      close();
      renderHome(); // 底栏与网格同时换格（钉住的 App 从网格让位）
      return;
    }
    if (target === overlay) close();
  });
  doc.addEventListener('keydown', onKeydown, true);
  pushSheetCloser(close, () => overlay.isConnected);
}

/** 移除容器内已存在的钉住选择器（幂等）。 */
function closeAppDrawer(container: HTMLElement): void {
  container.querySelector('.ubp-drawer-overlay')?.remove();
}

// ─── 通知中心（docs/24 P1）：桌面顶部下拉的跨 App 通知面板 ───
// 分工：数据在 core/notification-feed（零新增数据、只读引用、分组排序纯函数）；本层只管「怎么出现」。
// 高效 —— 整层 DOM 只在打开时创建、关闭即整层移除：关闭态零节点、零订阅、零定时器。
//   聚合只发生在「打开」与「打开期间的数据变更」两处，绝不进渲染热路径（桌面重绘完全不碰它）。
// 流畅 —— 下拉与面板位移一比一跟手（拖拽期写行内 transform 并关掉 CSS 过渡），松手按位移阈值吸附；
//   开合走 cubic-bezier 弹性曲线，内容行按 --ubp-nc-i 错峰淡入（只在本次打开首次渲染上跑一次）。
// 有趣 —— 点某条 = 直达该会话/该 App（微信/窥私经 app-registry 深链，首帧就落在那个会话上）。

/** 通知来源 → 桌面磁贴 id（'game' 无独立磁贴，落到游戏中心）。 */
const NC_APP_ID: Record<PhoneNotifySource, string> = {
  wechat: 'wechat', 'phone-call': 'phone-call', spy: 'spy', night: 'night',
  moments: 'moments', tieba: 'tieba', weibo: 'weibo', xhs: 'xhs', game: 'game-center',
  schedule: '', // 日程提醒无桌面磁贴（走固定橙铃铛；见 ncGroupHtml）
  shop: 'shop', // 网上商城（docs/52）：包裹送达通知
};

/** 「下拉看通知」新手提示只弹一次（设备本地态；同 BALL_POS_KEY 一层，换聊天不重置）。 */
const NC_HINT_KEY = 'ubp_nc_hint_v1';

/** 折叠的分组（第五轮 ⑥）：会话级内存态，不落盘——面板整层移除即清空（每次打开都是全展开，
 *  与「通知中心不是归档器」的定位一致）。签名比较用它 ⇒ 折叠/展开只重绘一次 innerHTML。 */
const _collapsedGroups = new Set<PhoneNotifySource>();

/** 行左滑刚结束的时刻（600ms 内）：吞掉滑动松手落下的那一次 click，
 *  否则「左滑露出已读」会顺带把该条打开成 App（同 ncPullJustEnded 的既有做法）。 */
let _ncSwipeEndedAt = 0;
function ncSwipeJustEnded(): boolean {
  return Date.now() - _ncSwipeEndedAt < 600;
}

/** 左滑露出的动作宽度（与 CSS .ubp-nc-act 的 width 一致，JS 只用来判吸附位）。 */
const NC_SWIPE_ACT_W = 84;
/** 「已滑开」态类名：挂上它动作钮才可见（CSS .ubp-nc-slide.ubp-nc-open .ubp-nc-act）。
 *  第六轮 ⑩ 只靠绘制层次压住动作钮是不够的——条目底色是半透明冰砖，绿钮会从背后透出来。 */
const NC_OPEN_CLS = 'ubp-nc-open';
/** 已滑开的那一条（同一时刻只允许一条滑开；滑动/点别处即复位）。 */
let _ncOpenSlide: HTMLElement | null = null;

/** 复位当前滑开的行（点别处/重绘前调用）。 */
function closeOpenSlide(): void {
  const slide = _ncOpenSlide;
  _ncOpenSlide = null;
  slide?.classList.remove(NC_OPEN_CLS); // 收回「已滑开」态：动作钮随之淡出（CSS 里只有它和 .ubp-nc-swiping 可见）
  const item = slide?.querySelector('.ubp-nc-item') as HTMLElement | null;
  if (item) item.style.transform = '';
}

/** 分组头的点按折叠/展开 + 单条左滑露出「已读」（第五轮 ⑥，绑在面板层上、层移除即失效）。 */
function bindNotifyGestures(layer: HTMLElement): void {
  // 分组头长按 = 清掉这个 App 的未读（与「全部清除」复用同一批既有已读入口）
  bindPressCore<HTMLElement>(layer, {
    match: el => el.closest('.ubp-nc-grouphead') as HTMLElement | null,
    markJustFired: true,
    onFire: head => {
      const source = head.dataset.ubpNcSrc as PhoneNotifySource | undefined;
      if (source) clearNotifySource(source);
    },
  });
  // 行左滑：只认左滑（右滑留给滚动），横向为主才认领手势；松手吸附到「露出/复位」两态之一
  let slide: HTMLElement | null = null;
  let item: HTMLElement | null = null;
  let live = false;
  let claimed = false;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  layer.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    const found = target?.closest?.('.ubp-nc-slide') as HTMLElement | null;
    // 点「已读」按钮本身不进入滑动（由 click 处理）
    if (!found || target?.closest?.('.ubp-nc-act')) { live = false; return; }
    slide = found;
    item = found.querySelector('.ubp-nc-item') as HTMLElement | null;
    live = !!item;
    claimed = false;
    dx = 0;
    startX = e.clientX;
    startY = e.clientY;
  });
  layer.addEventListener('pointermove', (e: PointerEvent) => {
    if (!live || !item || !slide) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!claimed) {
      if (Math.abs(mx) < 8) return;
      if (Math.abs(my) > Math.abs(mx)) { live = false; return; } // 纵向为主：让给面板滚动
      claimed = true;
      if (_ncOpenSlide && _ncOpenSlide !== slide) closeOpenSlide();
      slide.classList.add('ubp-nc-swiping'); // 跟手期间关过渡（位移由指针 1:1 驱动）
      try { layer.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
    }
    e.preventDefault();
    dx = Math.max(-NC_SWIPE_ACT_W, Math.min(0, mx)); // 只允许左滑
    item.style.transform = `translateX(${dx}px)`;
  });
  const end = (): void => {
    const el = item;
    const container = slide;
    live = false;
    if (!claimed || !el || !container) { claimed = false; return; }
    claimed = false;
    container.classList.remove('ubp-nc-swiping');
    const open = dx <= -NC_SWIPE_ACT_W * 0.45;
    el.style.transform = open ? `translateX(${-NC_SWIPE_ACT_W}px)` : '';
    // 吸附展开才挂 .ubp-nc-open（动作钮的可见判据之一）；收回时不挂 ⇒ 钮随行滑回一起淡出
    container.classList.toggle(NC_OPEN_CLS, open);
    _ncOpenSlide = open ? container : (_ncOpenSlide === container ? null : _ncOpenSlide);
    _ncSwipeEndedAt = Date.now(); // 吞掉松手那一次 click
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
}

/** 清掉某个 App 的未读（长按分组头）：既有已读入口 + 角标即时跟随 + 面板就地重绘（滑动动画保留）。 */
function clearNotifySource(source: PhoneNotifySource): void {
  if (!clearPhoneNotificationsFor(source)) return;
  emitPhoneEvent('ubp-phone:data-changed');
  refreshNotificationCenter();
}

// ─── 顶部下拉面板基元（第五轮 ⑧：通知中心 / 控制中心 合一）────────────────
// 通知中心与控制中心是「同一件事的两种内容」：同一套几何（收起点 = -(高+rest)，静止点 = +rest）、
// 同一组吸附阈值、同一套遮罩 / 把手拖动 / 退场 / 清理纪律。此前各写一份 —— 手感要改两处，
// 且已出现真实分叉（跟手遮罩一个 0.45 一个 0.26；控制中心 fresh 定时器没句柄、层移除后仍会触发）。
// 本基元是这两块面板的**唯一实现**，面板只提供三件不同的东西：类名、内容渲染、点击动作。
//
// 逐条沿用的既有纪律（不得回退）：
//  1. 层只在打开时创建、关闭即移除（关闭态零节点、零订阅）；开合动画由 CSS 类 .on / .dragging 驱动；
//  2. `pointerdown` 阶段绝不 setPointerCapture（对容器抓取会改写随后的 click 目标）；
//  3. 把手必须**事件委托按 closest 判定**——面板内层 DOM 每次刷新整块换血，直接绑节点会变死引用；
//  4. 跟手期间 .dragging 既关过渡、也关毛玻璃（模糊采样窗口每帧都变，移动端掉帧）；
//  5. 静止位 rest 从 CSS 变量 --ubp-nc-rest 读一次（唯一事实源），不每帧读计算样式；
//  6. 所有单发定时器（退场 300ms、淡入 700ms）都必须持句柄并在移除时成对清理。

/** 吸附比例：拉过面板高度这么多就吸附展开（低于此 + 无甩动则收回）。 */
const NC_SETTLE_RATIO = 0.3;
/** 甩动判定速度（px/ms，向下为正）：超过即按甩动方向吸附，不再看距离。 */
const NC_FLICK_V = 0.45;
/** 跟手期间遮罩不透明度（静止位 CSS 同为 0.26）。此前通知中心 0.45 / 控制中心 0.26 分叉，
 *  松手瞬间遮罩会从 0.45 跳到 0.26 —— 统一成一个值，两块面板手感一致。 */
const PANEL_VEIL_OPACITY = 0.26;

/** 进度→位移：收起点 = -(高 + rest)（整块离屏），静止点 = +rest（顶边停在状态栏下方）。
 *  **硬限幅在 [0,1]**：真机上拉到顶就顶住，继续拉手指也不动——多出来的位移被吃掉，
 *  面板顶边不会露出一条壁纸缝隙（旧实现直接 translateY(dy-h)，拖过头就把整块面板推下去，很丑）。 */
function panelOffset(rest: number, height: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return rest - (1 - p) * (height + rest);
}

/** 松手吸附判定（两块面板、两条手势机共用）：p=当前进度；flick=竖直速度 px/ms（向下为正）；
 *  closing=true 表示该手势朝关闭方向拉（面板把手）。快速甩动优先于距离阈值（真机手感）。 */
function settleFromDrag(p: number, flick: number, closing: boolean): boolean {
  let open = p >= NC_SETTLE_RATIO;
  if (Math.abs(flick) >= NC_FLICK_V) open = closing ? flick < 0 : flick > 0;
  return open;
}

/** 读静止位下移量（真机口径：面板顶边停在状态栏下方，把状态栏完整让出来）。两块面板共用同一枚 token。 */
function readPanelRest(panel: HTMLElement | null): number {
  if (!panel) return 0;
  try {
    const raw = hostWindow()?.getComputedStyle?.(panel)?.getPropertyValue?.('--ubp-nc-rest') ?? '';
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch (_e) {
    return 0;
  }
}

interface PullPanelHooks {
  /** 打开前的一次性副作用（让位/收回其它顶部横幅、失效缓存）。 */
  onOpen?(panel: HTMLElement): void;
  /** 整层移除之后（把让位出去的东西按原逻辑拉回来）。 */
  onRemoved?(): void;
  /** 面板内点击（事件委托；target 未命中任何规则时传 layer 自身）。 */
  onClick(target: HTMLElement, ctx: { close(animate?: boolean): void; layer: HTMLElement }): void;
  /** 额外的指针手势（层创建时绑一次；层移除即随之失效）。通知中心的行左滑/分组头长按走这里。 */
  bind?(layer: HTMLElement, ctx: { close(animate?: boolean): void }): void;
}

interface PullPanelConfig {
  layerClass: string;
  panelClass: string;
  veilClass: string;
  /** 可拖拽关闭的把手段（closest 选择器）。 */
  gripSelector: string;
  /** 需要保住滚动位的容器（可选）。 */
  scrollSelector?: string;
  render(): string;
  hooks?: PullPanelHooks;
}

export interface PullPanel {
  open(progress?: number): void;
  close(animate?: boolean): void;
  settle(open: boolean): void;
  setProgress(progress: number): void;
  refresh(): void;
  /** 层是否存在（含跟手中途 / 退场中途）。「面板是否开着」的语义读口，别拿它当入口闸门用。 */
  isOpen(): boolean;
  /** 是否**已落位展开**（`.on` 已落）：跟手中途与退场中途都还不是落位态。
   *  入口闸门只认它——见 bindTopPullToNotifications 的「中间态不得锁死入口」纪律。 */
  isCommitted(): boolean;
  /** 下拉位移 → 展开进度（1:1 跟手）。 */
  pullProgress(dy: number): number;
  /** 该手势的吸附提交（closing=true 表示朝关闭方向拉）。 */
  settleFromDrag(p: number, flick: number, closing: boolean): void;
  /** 物理拆除（壳重建前调用：移除节点 + 摘监听 + 清定时器）。 */
  dispose(): void;
}

function createPullPanel(cfg: PullPanelConfig): PullPanel {
  let layer: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let freshTimer: ReturnType<typeof setTimeout> | null = null;
  let rest = 0;
  let lastHtml = '';

  const height = (): number => panel?.getBoundingClientRect().height || 320;

  const teardown = (): void => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (freshTimer) { clearTimeout(freshTimer); freshTimer = null; }
    layer?.remove();
    layer = null;
    panel = null;
    lastHtml = '';
    cfg.hooks?.onRemoved?.();
  };

  const armRemoval = (): void => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      // 退场期间又被打开（.on 回来）则不摘
      if (layer && !layer.classList.contains('on')) teardown();
    }, 300);
  };

  /** 就地重绘内容（保滚动位）。内容签名未变直接返回：连 innerHTML 赋值都省掉
   *  （打开期间的 data-changed 很密，而列表多数时候并没有真的变化）。 */
  const refresh = (): void => {
    if (!layer || !panel) return;
    const inner = panel.querySelector(`.${cfg.panelClass}-inner`) as HTMLElement | null;
    const html = cfg.render();
    if (html === lastHtml) return; // 内容未变：整块不重建（滚动位置也不会被动）
    lastHtml = html;
    const scroll = cfg.scrollSelector ? panel.querySelector(cfg.scrollSelector) as HTMLElement | null : null;
    const top = scroll?.scrollTop ?? 0;
    if (inner) inner.innerHTML = html;
    const next = cfg.scrollSelector ? panel.querySelector(cfg.scrollSelector) as HTMLElement | null : null;
    if (next) next.scrollTop = top;
  };

  const applyProgress = (progress: number): void => {
    if (!layer || !panel) return;
    // 跟手接手 = 取消待拆的退场：退场途中重新按住把手 / 重新下拉时，
    // 层不能被那条 300ms 定时器从手指底下抽走（旧实现在这里漏了 clearTimeout）。
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    layer.classList.add('dragging');
    panel.style.transform = `translateY(${panelOffset(rest, height(), progress)}px)`;
    const veil = layer.querySelector(`.${cfg.veilClass}`) as HTMLElement | null;
    if (veil) veil.style.opacity = String(PANEL_VEIL_OPACITY * Math.min(1, Math.max(0, progress)));
  };

  const setProgress = (progress: number): void => applyProgress(progress);

  const pullProgress = (dy: number): number => Math.max(0, dy) / (height() + rest);

  /** 松手吸附（open=true 回弹展开，false 滑出并移除整层）。 */
  const settle = (open: boolean): void => {
    if (!layer || !panel) return;
    layer.classList.remove('dragging');
    panel.style.transform = '';
    const veil = layer.querySelector(`.${cfg.veilClass}`) as HTMLElement | null;
    if (veil) veil.style.opacity = '';
    layer.classList.toggle('on', open);
    if (!open) armRemoval();
  };

  /** 面板内事件：Esc / 点击（委托给 hooks）/ 把手拖动关闭。closeFn 以形参注入，避免声明顺序倒挂。 */
  const bindPanelEvents = (el: HTMLElement, closeFn: (animate?: boolean) => void): void => {
    const doc = hostDocument();
    const openedAt = Date.now();
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeFn();
      }
    };
    doc.addEventListener('keydown', onKeydown, true);
    const origRemove = el.remove.bind(el);
    el.remove = (): void => {
      doc.removeEventListener('keydown', onKeydown, true);
      origRemove();
    };

    el.addEventListener('click', event => {
      if (Date.now() - openedAt < SHEET_STALE_CLICK_MS) return; // 下拉松手那次残留 click
      cfg.hooks?.onClick(event.target as HTMLElement, { close: closeFn, layer: el });
    });

    let dragging = false;
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let flick = 0;
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(cfg.gripSelector)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      startY = lastY = e.clientY;
      lastT = Date.now();
      flick = 0;
      try { el.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      const now = Date.now();
      const dt = now - lastT;
      if (dt > 0) flick = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = now;
      setProgress(1 - Math.max(0, e.clientY - startY) / (height() + rest));
    });
    const endDrag = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      // 终结位置：正常 pointerup 用事件坐标；捕获被动释放（层被拆/被抢）时事件坐标可能是旧值，退回最后一次跟手位置
      const y = Number.isFinite(e.clientY) && e.clientY > 0 ? e.clientY : lastY;
      const p = 1 - Math.max(0, y - startY) / (height() + rest);
      settle(settleFromDrag(p, flick, true));
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    // 捕获被动释放同样终结手势（与下拉手势机同一纪律）：少了它，拖拽中的层被摘掉后
    // dragging 会一直挂着，下一次 pointermove 还会继续驱动一个已经不存在的层的进度。
    el.addEventListener('lostpointercapture', endDrag);
  };

  /** 关闭（animate=false 用于「打开 App 前立刻收掉」，不做退场动画）。 */
  const close = (animate = true): void => {
    popSheetCloser(close);
    if (!layer) return;
    if (!animate) {
      teardown();
      return;
    }
    layer.classList.remove('on');
    armRemoval();
  };

  const isOpen = (): boolean => !!layer;
  const isCommitted = (): boolean => !!layer && layer.classList.contains('on');

  /** 打开（progress>0 = 从手指位置接着跟手，不放开合动画；0 = 带动画滑入）。 */
  const open = (progress = 0): void => {
    const screen = _shadow?.querySelector('.ubp-screen') as HTMLElement | null;
    if (!screen) return;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (!layer) {
      const doc = hostDocument();
      const el = doc.createElement('div');
      el.className = `${cfg.layerClass} fresh`;
      el.innerHTML = `<div class="${cfg.veilClass}"></div><div class="${cfg.panelClass}"><div class="${cfg.panelClass}-inner"></div></div>`;
      screen.appendChild(el);
      layer = el;
      panel = el.querySelector(`.${cfg.panelClass}`) as HTMLElement;
      rest = readPanelRest(panel); // 静止位（CSS --ubp-nc-rest 为唯一事实源）
      bindPanelEvents(el, close);
      cfg.hooks?.bind?.(el, { close }); // 面板自有手势（行左滑/分组头长按等）
      // 返回键：面板是最上层弹层（惰性清理，与全机弹层同口径）
      pushSheetCloser(close, isOpen);
      // 错峰淡入只跑一次：挂 .fresh → 700ms 后摘（此后刷新不重放动画）；句柄成对清理
      freshTimer = setTimeout(() => {
        freshTimer = null;
        layer?.classList.remove('fresh');
      }, 700);
    }
    cfg.hooks?.onOpen?.(panel as HTMLElement);
    refresh();
    const veil = layer.querySelector(`.${cfg.veilClass}`) as HTMLElement | null;
    if (progress > 0) {
      applyProgress(progress);
    } else {
      layer.classList.remove('dragging');
      (panel as HTMLElement).style.transform = '';
      if (veil) veil.style.opacity = '';
      // 同步落 .on，**不用 requestAnimationFrame**：rAF 在后台标签页/主线程繁忙（例如 AI 生成占满）
      // 时会被推迟甚至停摆，层就会「已存在但不可见」，而 isOpen() 仍为真 —— 手机所有入口被自己的
      // 隐形层挡死（用户实测：下拉唤不出、点一下才消）。先读一次 offsetHeight 强制样式冲刷把「离屏态」
      // 定下来（否则同一帧里加类不触发过渡），再落类：滑入动画照旧，可见性不再交给帧调度。
      void (panel as HTMLElement).offsetHeight;
      layer.classList.add('on');
    }
  };

  return {
    open,
    close,
    settle,
    setProgress,
    refresh,
    isOpen,
    isCommitted,
    pullProgress,
    settleFromDrag: (p, flick, closing) => settle(settleFromDrag(p, flick, closing)),
    dispose: teardown,
  };
}

// ─── 通知中心（内容侧；几何/手势/开合全部走上面的基元）────────────────────
const notifyPanel = createPullPanel({
  layerClass: 'ubp-nc-layer',
  panelClass: 'ubp-nc',
  veilClass: 'ubp-nc-veil',
  gripSelector: '.ubp-nc-top, .ubp-nc-griprow',
  scrollSelector: '.ubp-nc-scroll',
  render: () => ncInnerHtml(),
  hooks: {
    onOpen: () => {
      // 打开面板 = 一次显式重读备忘录表的机会（主项目侧手填/手改的条目也能立刻出现）+ 让横幅与列表同步
      invalidatePhoneScheduleCache();
      refreshScheduleBanner(true);
    },
    // 面板关掉 → 若仍有未确认日程，把桌面横幅拉回来（打开面板时它被收掉了，见 refreshScheduleBanner）；
    // 折叠态是会话级内存态：整层移除即清空（下次打开全展开），滑开的行引用一并作废。
    onRemoved: () => {
      _collapsedGroups.clear();
      _ncOpenSlide = null;
      refreshScheduleBanner(true);
    },
    onClick: (target, ctx) => onNotificationCenterClick(target, ctx),
    bind: (layer) => bindNotifyGestures(layer),
  },
});

export function isNotificationCenterOpen(): boolean {
  return notifyPanel.isOpen();
}

/** 手机壳是否展开（未展开时任何 App 界面都看不见；未读判定用「看不见就不算正在看」，见 app-wechat）。 */
export function isPhoneOpen(): boolean {
  return _open;
}

/** 一组通知 → 卡片 HTML（第五轮 ⑥：可折叠分组头 + 可左滑的单条）。
 *  组头 = 品牌色图标 + App 名 + 未读合计 + 折叠箭头（点按折叠/展开、长按清该 App）；
 *  组体 = 若干「滑动容器」`.ubp-nc-slide`，每条右侧藏一枚「已读」动作（左滑露出，真机口径）。
 *  日程提醒（source='schedule'）无桌面磁贴：走独立「待办岛」（见 ncScheduleIslandHtml），不参与折叠/左滑。
 *  置顶条目（游戏「轮到你」）不给滑动动作——它是进行中的现实状态，清了也还在。 */
function ncGroupHtml(group: { source: PhoneNotifySource; count: number; items: PhoneNotification[] }, style: PhoneStyle): string {
  if (group.source === 'schedule') return ncScheduleIslandHtml(group.items);
  const appId = NC_APP_ID[group.source];
  const app = appId ? getPhoneApp(appId) : null;
  const label = app ? skinAppName(app.id, appDisplayName(app.id, app.name, style)) : group.source;
  const icon = app ? skinAppIcon(app.id, appDisplayIcon(app.id, app.icon, style)) : ubpIcon('bell');
  const color = app ? skinAppColor(app.id, appDisplayColor(app.id, app.color, style)) : '#8E8E93';
  const folded = _collapsedGroups.has(group.source);
  const total = group.count || group.items.length;
  const rows = group.items.map((n, i) => `
      <div class="ubp-nc-slide" style="--ubp-nc-i:${i}">
        <div class="ubp-nc-item" data-ubp-nc="open" data-ubp-nc-app="${escapeAttr(appId)}"${n.target ? ` data-ubp-nc-target="${escapeAttr(n.target)}"` : ''}${n.pin ? ' data-ubp-nc-pin="1"' : ''}>
          <span class="ubp-nc-icon" style="background:${color}">${icon}</span>
          <span class="ubp-nc-body">
            <span class="ubp-nc-head"><span class="ubp-nc-app">${escapeHtml(label)}${n.sub ? ` · ${escapeHtml(n.sub)}` : ''}</span>${n.time ? `<span class="ubp-nc-time">${escapeHtml(n.time)}</span>` : ''}</span>
            <span class="ubp-nc-title">${escapeHtml(n.title)}</span>
            ${n.text ? `<span class="ubp-nc-text">${escapeHtml(n.text)}</span>` : ''}
          </span>
          ${n.count ? `<span class="ubp-nc-badge">${n.count > 99 ? '99+' : n.count}</span>` : ''}
        </div>
        ${n.pin ? '' : `<button type="button" class="ubp-nc-act" data-ubp-nc="read" data-ubp-nc-src="${escapeAttr(n.source)}" data-ubp-nc-nid="${escapeAttr(n.id)}">${ubpIcon('check')}${S('已读', '已读')}</button>`}
      </div>`).join('');
  return `<div class="ubp-nc-group${folded ? ' fold' : ''}">
      <div class="ubp-nc-grouphead" data-ubp-nc="fold" data-ubp-nc-src="${escapeAttr(group.source)}" title="${S('点按折叠 / 长按清这个应用', '点按折叠 / 长按清这个应用')}">
        <span class="ubp-nc-icon" style="background:${color}">${icon}</span>
        <span class="ubp-nc-gname">${escapeHtml(label)}</span>
        <span class="ubp-nc-gcnt">${total}</span>
        <span class="ubp-nc-gchev">${ubpIcon('chevron')}</span>
      </div>
      <div class="ubp-nc-gbody">${rows}</div>
    </div>`;
}

/** 日程提醒在通知中心单独成岛（形态 C，2026-10-02 重设计）：岛头「日程提醒 + 今天/明天件数」淡染日程橙，
 *  行内左侧一条时间轴（实心橙点=今天 / 空心点=明天 / 灰点=已确认），标题下压一行摘要，动作只占一列。
 *  为什么不跟别的通知共用 `.ubp-nc-group`：面板是 --ubp-card、普通组是 --ubp-card-2，两者只差 4.5% 亮度，
 *  日程跟微信/朋友圈挤在一起时组缝几乎看不见——那就是用户说的「堆在一起」。岛头橙染是与普通组唯一的身份差别。
 *  已确认的那条给「✓ 已确认」而不是「按钮凭空消失」；整行不可点（唯一动作是行内「知道了」）。 */
function ncScheduleIslandHtml(items: readonly PhoneNotification[]): string {
  const today = items.filter(n => n.time === '今天').length;
  const tomorrow = items.length - today;
  const cnt = [today ? `今天 ${today}` : '', tomorrow ? `明天 ${tomorrow}` : ''].filter(Boolean).join(' · ');
  const rows = items.map((n, i) => {
    const acked = !n.ackKey;
    const day = [n.time, n.due].filter(Boolean).join(' · ');
    return `
      <div class="ubp-nc-todo${n.time === '明天' ? ' tom' : ''}${acked ? ' done' : ''}" style="--ubp-nc-i:${i}">
        <span class="ubp-nc-todo-rail"><span class="ubp-nc-todo-dot"></span><span class="ubp-nc-todo-line"></span></span>
        <span class="ubp-nc-todo-col">
          ${day ? `<span class="ubp-nc-todo-day">${escapeHtml(day)}</span>` : ''}
          <span class="ubp-nc-todo-ti">${escapeHtml(scheduleDisplayTitle(n.title))}</span>
          ${n.text ? `<span class="ubp-nc-todo-bd">${escapeHtml(n.text)}</span>` : ''}
        </span>
        ${acked
          ? '<span class="ubp-nc-todo-chk">✓ 已确认</span>'
          : `<button type="button" class="ubp-nc-ack" data-ubp-nc="ack" data-key="${escapeAttr(n.ackKey || '')}">${S('知道了', '知道了')}</button>`}
      </div>`;
  }).join('');
  return `<div class="ubp-nc-island">
      <div class="ubp-nc-island-hd"><span class="ubp-nc-island-ttl">${S('日程提醒', '日程提醒')}</span>${cnt ? `<span class="ubp-nc-island-cnt">${escapeHtml(cnt)}</span>` : ''}</div>
      ${rows}
    </div>`;
}

/** 面板内容（时钟/日期与桌面同一故事时间口径；空态=一句状态，不写解释）。 */
function ncInnerHtml(): string {
  const list = collectPhoneNotifications();
  const groups = groupPhoneNotifications(list);
  const roster = getRoster();
  const { date } = extractStoryDateTime(roster.global.time);
  return `<div class="ubp-nc-griprow"><span class="ubp-nc-grip"></span></div>
    <div class="ubp-nc-top">
      <div>
        <div class="ubp-nc-clock">${escapeHtml(storyClockText(roster.global.time, currentStyle()))}</div>
        <div class="ubp-nc-date">${escapeHtml(date)}</div>
      </div>
      ${list.some(n => !n.pin) ? '<button type="button" class="ubp-nc-clear" data-ubp-nc="clear">全部清除</button>' : ''}
    </div>
    <div class="ubp-nc-scroll">
      ${groups.length
        ? groups.map(g => ncGroupHtml(g, currentStyle())).join('')
        : `<div class="ubp-nc-empty">${ubpIcon('bell')}<b>没有新通知</b><span>新消息、来电与互动会出现在这里</span></div>`}
    </div>`;
}

/** P2：合并式刷新（150ms 窗口内只跑一次）——data-changed 密集时避免每个事件都重算整份通知聚合。 */
const refreshNotificationCenterCoalesced = createCoalescer(150, () => refreshNotificationCenter());

/** 就地重绘面板内容（保滚动位；打开期间的 data-changed 走这里，不重建整层、不重放开合动画）。
 *  P2 的内容签名短路现在由面板基元统一持有（两块面板同款）。 */
export function refreshNotificationCenter(): void {
  _ncOpenSlide = null; // 整块重绘后旧的「滑开」引用作废（行内 transform 也不再存在）
  notifyPanel.refresh();
}

/** 松手吸附比例：拉过面板高度这么多就吸附展开（低于此+无甩动则收回）。 */
/** 打开通知中心（progress>0 = 从手指位置接着跟手，不放开合动画；0 = 带动画滑入）。 */
export function openNotificationCenter(progress = 0): void {
  closeControlCenter(false); // 对偶两面板同一时刻只开一个
  closeIslandCard(); // 展开卡是顶部浮层：开面板即收起（避免叠在一起）
  notifyPanel.open(progress);
}

/** 跟手展开进度（0..1；面板自顶滑下，越大越展开）。 */
export function setNotificationCenterProgress(progress: number): void {
  notifyPanel.setProgress(progress);
}

/** 松手吸附（open=true 回弹展开，false 滑出并移除整层）。 */
export function settleNotificationCenter(open: boolean): void {
  notifyPanel.settle(open);
}

/** 关闭（animate=false 用于「打开 App 前立刻收掉」，不做退场动画）。 */
export function closeNotificationCenter(animate = true): void {
  notifyPanel.close(animate);
}

/** 通知中心内点击（事件委托；几何/手势/Esc 全在面板基元里）。 */
function onNotificationCenterClick(target: HTMLElement, ctx: { close(animate?: boolean): void; layer: HTMLElement }): void {
  // 「已读」动作（左滑露出）：既有已读入口 + 角标跟随 + 就地重绘。它不吃左滑残留守卫——
  // 滑开之后紧接着点「已读」正是自然操作（守卫只用于吞掉落在「行」上的那一次合成 click）。
  const readBtn = target.closest('[data-ubp-nc="read"]') as HTMLElement | null;
  if (readBtn) {
    const src = readBtn.dataset.ubpNcSrc as PhoneNotifySource | undefined;
    const nid = readBtn.dataset.ubpNcNid || '';
    closeOpenSlide();
    if (src && nid && readPhoneNotification({ source: src, id: nid })) {
      emitPhoneEvent('ubp-phone:data-changed');
      refreshNotificationCenter();
    }
    return;
  }
  if (ncSwipeJustEnded() && target.closest('[data-ubp-nc="open"]')) return; // 左滑松手那一次残留 click 不打开 App
  // 分组头：点按折叠/展开（长按清该 App 由 bindNotifyGestures 处理，长按后那一次 click 由长按守卫吞掉）
  const head = target.closest('[data-ubp-nc="fold"]') as HTMLElement | null;
  if (head) {
    if (longPressJustFired()) return;
    const src = head.dataset.ubpNcSrc as PhoneNotifySource | undefined;
    if (src) {
      if (_collapsedGroups.has(src)) _collapsedGroups.delete(src);
      else _collapsedGroups.add(src);
      closeOpenSlide();
      refreshNotificationCenter();
    }
    return;
  }
  const ackBtn = target.closest('[data-ubp-nc="ack"]') as HTMLElement | null;
  if (ackBtn) {
    // 「知道了」与横幅同一入口：写 ack（横幅不再弹）+ 该条转常驻 + 出下一条横幅
    if (ackBtn.dataset.key) ackScheduleEntry(ackBtn.dataset.key);
    return;
  }
  if (target.closest('[data-ubp-nc="clear"]')) {
    clearAllPhoneNotifications();
    emitPhoneEvent('ubp-phone:data-changed'); // 角标/桌面磁贴即时跟随
    _collapsedGroups.clear();
    _ncOpenSlide = null;
    refreshNotificationCenter();
    const screen = ctx.layer.parentElement;
    if (screen) showScreenToast(screen, '已清除全部通知');
    return;
  }
  const row = target.closest('[data-ubp-nc="open"]') as HTMLElement | null;
  if (row) {
    // 已滑开的那一条：点它先把滑动复位（真机口径：点滑开的行 = 收起动作），不直接跳 App
    if (_ncOpenSlide && _ncOpenSlide.contains(row)) {
      closeOpenSlide();
      return;
    }
    const appId = row.dataset.ubpNcApp || '';
    const deep = row.dataset.ubpNcTarget || '';
    ctx.close(false); // 开 App 前立刻收掉，不做退场动画
    openNotificationTarget(appId, deep); // 与锁屏卡共用同一条深链路径
    return;
  }
  if (target.classList.contains('ubp-nc-veil')) ctx.close();
}

/** 下拉唤通知的残留 click 识别（600ms 内；桌面磁贴 click 顶部吞掉，防下拉后误开 App）。 */
let _ncPullEndedAt = 0;
function ncPullJustEnded(): boolean {
  return Date.now() - _ncPullEndedAt < 600;
}

// ─── 控制中心（I-4 / 第五轮 ④）────────────────────────────────────────────
// 与通知中心**对偶**：同一套下拉手势机、同一套几何（静止位用同一枚 `--ubp-nc-rest`）、
// 同一组吸附阈值（NC_SETTLE_RATIO / NC_FLICK_V）与同一种玻璃配方，且自第五轮起**共用同一个面板基元**
// （createPullPanel）——差别只剩**入口侧**（左半 → 通知中心；右半 → 控制中心）与内容。
// 开关走注册表 CTRL_TILES：加一项＝加一行描述符，面板代码不动。
// 第五轮把「施工中」退役：顶栏改为真实设备状态行（故事时间/地点/未读），并把第四轮新加的
// 深色模式 / 提示音 / 震动搬上快捷面板——**全部读写既有 PhoneSettings 字段，零新增存储**。

/** 控制中心按钮描述符（加一项＝加一行）。
 *  两类：**开关**（有 state：读当前开/关，activate 取反落盘）与**动作**（无 state：点一下执行，如锁屏）。 */
interface CtrlTile {
  id: string;
  label: string;
  icon: string;
  /** 开关态读口（true=开）；动作按钮留空 ⇒ 不渲染「开/关」角标、也不带 on 高亮。 */
  state?: () => boolean;
  /** 开关态角标文案（缺省「开/关」；深色模式这类多档用自定义文案，如自动/浅色/深色）。 */
  stateLabel?: () => string;
  /** 整行宽（动作按钮用，如锁屏）：占满两列，与其余开关在视觉上分层。 */
  wide?: boolean;
  /** 点按：开关＝取反落盘后重绘；动作＝执行（可自行收面板）。 */
  activate: () => void;
}
const CTRL_TILES: CtrlTile[] = [
  {
    id: 'dark',
    label: '深色模式',
    icon: ubpIcon('moon'),
    // 三档开关（不是布尔）：点按循环 自动 → 浅色 → 深色 → 自动
    state: () => {
      const mode = getPhoneSettings().darkMode;
      return mode === 'dark' || (mode === 'auto' && getConfig().darkTheme === true);
    },
    stateLabel: () => ({ auto: '自动', light: '浅色', dark: '深色' }[getPhoneSettings().darkMode] || '自动'),
    activate: () => {
      const cur = getPhoneSettings().darkMode;
      const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
      void savePhoneSettings({ darkMode: next }).then(() => { applyChrome(); refreshControlCenter(); });
    },
  },
  {
    id: 'silent',
    label: '静音',
    icon: ubpIcon('bellOff'),
    state: () => getPhoneSettings().silent,
    // 静音＝不出声（不影响震动与通知横幅，真机语义：静音≠免打扰）
    activate: () => {
      void savePhoneSettings({ silent: !getPhoneSettings().silent }).then(() => refreshControlCenter());
    },
  },
  {
    id: 'sound',
    label: '提示音',
    icon: ubpIcon('bell'),
    state: () => getPhoneSettings().soundOn,
    activate: () => {
      void savePhoneSettings({ soundOn: !getPhoneSettings().soundOn }).then(() => refreshControlCenter());
    },
  },
  {
    id: 'vibrate',
    label: '震动',
    icon: ubpIcon('vibrate'),
    state: () => getPhoneSettings().vibrateOn,
    activate: () => {
      void savePhoneSettings({ vibrateOn: !getPhoneSettings().vibrateOn }).then(() => refreshControlCenter());
    },
  },
  {
    id: 'lock',
    label: '锁屏',
    icon: ubpIcon('lock'),
    wide: true,
    // 动作按钮（没有「开/关」语义）：立即上锁并收起面板——锁屏层 z-index(12) 低于控制中心(13)，
    // 不先收面板就会被盖住；锁屏后走锁屏页既有的上滑解锁回来。
    activate: () => {
      closeControlCenter(false);
      showLockScreen();
    },
  },
];

/** 控制中心面板（几何/手势/开合/Esc/遮罩/定时器清理全在基元内，见 createPullPanel）。 */
const controlPanel = createPullPanel({
  layerClass: 'ubp-cc-layer',
  panelClass: 'ubp-cc',
  veilClass: 'ubp-cc-veil',
  gripSelector: '.ubp-nc-griprow, .ubp-cc-top',
  render: () => ccInnerHtml(),
  hooks: {
    // 面板打开 = 顶部只留一条：收掉通知横幅（与通知中心「收掉日程横幅」同一口径）
    onOpen: () => removePhoneBanner(),
    onRemoved: () => refreshScheduleBanner(true), // 面板关掉 → 日程横幅按原逻辑回来
    onClick: (target, ctx) => {
      const tile = target.closest('[data-ubp-cc]') as HTMLElement | null;
      if (tile) {
        const def = CTRL_TILES.find(t => t.id === tile.dataset.ubpCc);
        def?.activate();
        return;
      }
      if (target.classList.contains('ubp-cc-veil')) ctx.close();
    },
  },
});

export function isControlCenterOpen(): boolean {
  return controlPanel.isOpen();
}

/** 顶栏状态行（第五轮 ④）：退役「🚧 施工中」，改显示真实设备状态——
 *  故事时间 + 地点 + 未读合计，全部来自既有 roster / 角标，零新增数据、零新增请求。 */
function ccStatusText(): string {
  const roster = getRoster();
  const { date } = extractStoryDateTime(roster.global.time);
  const parts = [storyClockText(roster.global.time, currentStyle()), date, roster.global.location].filter(Boolean);
  let badge = 0;
  for (const app of getPhoneApps()) badge += getAppBadge(app.id);
  return `${escapeHtml(parts.join(' · '))}${badge > 0 ? ` · 未读 <b>${badge > 99 ? '99+' : badge}</b>` : ''}`;
}

function ccInnerHtml(): string {
  const rows = CTRL_TILES.map(t => {
    const on = t.state ? t.state() : undefined;
    const text = t.stateLabel ? t.stateLabel() : (on === undefined ? '' : (on ? '开' : '关'));
    const state = text ? `<span class="ubp-cc-state">${escapeHtml(text)}</span>` : '';
    return `<button type="button" class="ubp-cc-tile${t.wide ? ' wide' : ''}${on ? ' on' : ''}" data-ubp-cc="${escapeAttr(t.id)}">
        <span class="ubp-cc-ic">${t.icon}</span>
        <span class="ubp-cc-label">${escapeHtml(t.label)}</span>
        ${state}
      </button>`;
  }).join('');
  return `<div class="ubp-nc-griprow"><span class="ubp-nc-grip"></span></div>
    <div class="ubp-cc-top">
      <span class="ubp-cc-title">控制中心</span>
      <span class="ubp-cc-status">${ccStatusText()}</span>
    </div>
    <div class="ubp-cc-grid">${rows}</div>`;
}

/** 打开控制中心（progress>0 = 从手指位置接着跟手；0 = 带动画滑入）。与通知中心互斥。 */
export function openControlCenter(progress = 0): void {
  closeNotificationCenter(false); // 对偶两面板同一时刻只开一个
  closeIslandCard(); // 展开卡同上
  controlPanel.open(progress);
}

export function setControlCenterProgress(progress: number): void {
  controlPanel.setProgress(progress);
}

export function settleControlCenter(open: boolean): void {
  controlPanel.settle(open);
}

export function closeControlCenter(animate = true): void {
  controlPanel.close(animate);
}

/** 就地重绘（开关状态变化时只换内层内容，不重建层、不重放开合动画；内容签名由基元统一短路）。 */
export function refreshControlCenter(): void {
  controlPanel.refresh();
}

type PullZone = 'left' | 'right';

/** 状态栏左右分区（I-4 返修 2026-10-02）：以**灵动岛中轴**为界，整条状态栏分左右两片——
 *  右半（含右图标簇与它左侧的空白）→ 控制中心，左半（时刻区与左侧空白）→ 通知中心（对偶）。
 *  旧口径只认右图标簇：岛右侧那片空白既点不开控制中心，下拉还会被判成左半而误开通知中心。
 *  灵动岛/刘海本体是拖手机的把手（bindDrag），既不算左也不算右。 */
function statusBarSide(statusbar: HTMLElement, target: EventTarget | null, clientX: number): PullZone | null {
  if ((target as HTMLElement | null)?.closest?.('.ubp-notch, .ubp-island')) return null;
  const rect = statusbar.getBoundingClientRect();
  if (!rect.width) return null;
  return clientX - rect.left >= rect.width / 2 ? 'right' : 'left';
}

/** 状态栏左右两片点按：右半＝控制中心、左半＝通知中心（与下拉分区同一口径，点按/下拉对偶）。
 *  下拉松手的那一次残留 click 由 ncPullJustEnded 吞掉。 */
function bindStatusBarTapToPanels(statusbar: HTMLElement): void {
  statusbar.addEventListener('click', event => {
    if (ncPullJustEnded()) return; // 下拉松手的那一次残留 click 不算点按
    if (_locked || isNotificationCenterOpen() || isControlCenterOpen()) return;
    const side = statusBarSide(statusbar, event.target, event.clientX);
    if (side === 'right') openControlCenter();
    else if (side === 'left') openNotificationCenter();
  });
}

/** 顶部下拉的手势机（桌面时钟带 / App 内状态栏两条入口共用同一套拖拽纪律）。
 *  zone 判定「这一次起手算不算下拉区域、是哪一侧」——**左半 → 通知中心、右半 → 控制中心**（对偶）：
 *   · 桌面：左上信息带（时间/日期）→ 通知中心；右上天气/地点 → 控制中心；其余留给磁贴。
 *   · App 内状态栏：以灵动岛中轴为界，右半 → 控制中心、左半 → 通知中心；刘海/灵动岛是拖手机的把手，不接下拉。
 *  下面三条对所有入口一视同仁：
 *   · 只在 zone 命中处起手，其余区域留给该层自己的手势（桌面磁贴 / 刘海拖手机）；
 *   · pointerdown 阶段绝不 setPointerCapture：对容器抓取会把随后的 click 目标改写成容器本身，
 *     磁贴自己的 click 监听永远收不到 —— 那就是「下拉后桌面 App 打不开」的根因。认领手势后再抓；
 *   · 位移超过 6px 才认领手势（此后 preventDefault 拦浏览器滚动/文字选择），反向则当场放弃。
 *  两套面板共用同一几何与吸附阈值：唯一差别是 open/set/settle 走到哪一套（side）。
 *
 *  ★ 中间态不得锁死入口（2026-10-03 用户实测返修，两条不得回退）：
 *   1. 闸门只认「**已落位展开**」（isCommitted()），不认「层存在」（isOpen()）。层存在但未落位
 *      = 跟手中途 / 退场中途 / 以及「已认领却始终没 settle」的残层——后者一旦被闸门当成「已展开」，
 *      它（inset:0 的隐形遮罩）就会永久挡死下拉、点按与桌面（用户症状：怎么拉都不出来，点一下才消）。
 *      让新手势接手这些中间态，等于给基元装了自愈：任何残层都会在下一次下拉时被重新驱动并按吸附定态。
 *   2. 手势终结必须**不依赖指针捕获的送达**：宿主节点被整块换掉时（桌面下拉的宿主是 .ubp-home，
 *      renderHome 每次都 innerHTML 整体重绘），浏览器隐式释放捕获，那一记 pointerup 落在命中元素上、
 *      永远到不了宿主 —— 层就卡在「已认领未提交」。故补 lostpointercapture 兜底。 */
function bindTopPullToNotifications(host: HTMLElement, zone: (target: EventTarget | null, clientX: number) => PullZone | null): void {
  let live = false;
  let claimed = false;
  let side: PullZone = 'left';
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let flick = 0;
  const panelOf = (): PullPanel => (side === 'right' ? controlPanel : notifyPanel);
  const pullProgress = (dy: number): number => panelOf().pullProgress(dy);
  const setProgress = (p: number): void => { if (side === 'right') setControlCenterProgress(p); else setNotificationCenterProgress(p); };
  const openPanel = (p: number): void => { if (side === 'right') openControlCenter(p); else openNotificationCenter(p); };
  /** 已落位展开的那块（跟手/退场中途都不算）：只有它才拒绝新的下拉。 */
  const anyCommitted = (): boolean => notifyPanel.isCommitted() || controlPanel.isCommitted();
  host.addEventListener('pointerdown', (e: PointerEvent) => {
    if (anyCommitted()) return; // 已展开：交给面板自己的把手（中间态一律让本手势接手，见函数头 ★1）
    if (_locked) return; // 锁屏态（I-1）：下拉不唤面板，解锁是唯一出路
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const z = zone(e.target, e.clientX);
    if (!z) return; // 只在允许的下拉带起手
    side = z;
    live = true;
    claimed = false;
    startY = lastY = e.clientY;
    lastT = Date.now();
    flick = 0;
    // ★ 刻意不在此处 setPointerCapture：见函数头第 2 条（抓取会吃掉磁贴 click）。认领手势后再抓。
  });
  host.addEventListener('pointermove', (e: PointerEvent) => {
    if (!live) return;
    const dy = e.clientY - startY;
    if (!claimed) {
      if (dy > 6) {
        claimed = true;
        try { host.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
        openPanel(pullProgress(dy));
      } else if (dy < -6) {
        live = false; // 上滑：不是下拉意图，放手
      }
      return;
    }
    const now = Date.now();
    const dt = now - lastT;
    if (dt > 0) flick = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = now;
    e.preventDefault();
    setProgress(pullProgress(dy));
  });
  const end = (e: PointerEvent): void => {
    if (!live) return;
    const wasClaimed = claimed;
    live = false;
    claimed = false;
    if (!wasClaimed) return;
    // 终结位置：正常 pointerup 用事件坐标；捕获被动释放（宿主被换掉）时事件坐标可能是旧值，退回最后一次跟手位置
    const y = Number.isFinite(e.clientY) && e.clientY > 0 ? e.clientY : lastY;
    try { host.releasePointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
    _ncPullEndedAt = Date.now();
    panelOf().settleFromDrag(pullProgress(y - startY), flick, false);
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  // 捕获被动释放（宿主被整块换掉时浏览器隐式释放）也必须终结手势 —— 见函数头 ★2。
  // 自己 releasePointerCapture 触发的那一次由首行 `if (!live) return` 吞掉，不会二次 settle。
  host.addEventListener('lostpointercapture', end);
}

/** 桌面下拉（入口 A）：**只在顶部信息带起手**（时钟/日期/天气那一条），并**按左右分区对偶**：
 *  左上（时间/日期）→ 通知中心；右上（天气/地点）→ 控制中心。
 *  范围刻意收窄到该带：
 *   · 该带不可滚动，CSS 已清 touch-action/user-select，移动端不会被浏览器手势接管（同 bindDrag 把手纪律）；
 *   · 桌面其余区域留给磁贴——整屏可拉会让「按住图标往下滑一点」被判成下拉，磁贴手势互相打架。
 *  可见入口由桌面通知药丸（有未读才出现）承担，所以收窄范围不影响被发现性。 */
function bindHomePullToNotifications(home: HTMLElement): void {
  bindTopPullToNotifications(home, target => {
    const el = target as HTMLElement | null;
    if (el?.closest?.('.ubp-home-ctx')) return 'right'; // 右上（天气/地点）→ 控制中心
    if (el?.closest?.('.ubp-home-top')) return 'left'; // 左上（时间/日期）→ 通知中心
    return null;
  });
}

/** App 内状态栏下拉（入口 A 的 App 内分支，2026-10-02 追加；同日返修＝改按中轴分区）：
 *  **以灵动岛中轴为界整条分左右**：右半（含右图标簇与其左侧空白）→ 控制中心，左半（时刻区与左侧空白）→ 通知中心。
 *  排除灵动岛与刘海——那一小块是「拖动移动手机」的把手（bindDrag），两套手势各归各（island 浮在状态栏之上，
 *  事件本就不落到状态栏，这里连同判定只为把「不碰中间那块」写成显式契约）。状态栏无可点/可滚内容，接下拉不抢既有交互。 */
function bindStatusBarPullToNotifications(statusbar: HTMLElement): void {
  bindTopPullToNotifications(statusbar, (target, clientX) => statusBarSide(statusbar, target, clientX));
}

/** 首次提示「下拉查看通知」（只一次；此后该手势靠真机直觉+本提示已被记住）。 */
function maybeHintNotificationCenter(screen: HTMLElement): void {
  try {
    const win = hostWindow();
    if (win.localStorage.getItem(NC_HINT_KEY)) return;
    win.localStorage.setItem(NC_HINT_KEY, '1');
  } catch (_e) {
    return; // 存储不可用就别提示（避免每次都弹）
  }
  showScreenToast(screen, '桌面顶部下拉，查看全部通知');
}
