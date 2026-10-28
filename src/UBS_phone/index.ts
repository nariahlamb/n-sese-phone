// ===== 瑟瑟小手机 · 入口（docs/01 §2/§6.1 引导序列） =====
// 装载形态：酒馆助手脚本（loader 注入宿主 head 的 module）或 dev iframe。
// 引导：主项目配置（只读）→ 小手机设置 → roster 失效绑定 → 按聊天存储重绑 → 挂载手机壳。

import { bindHostConfigSync, bootHostConfig } from './core/host-config';
import { bindCurrencyHostChange } from './core/currency-link';
import { clearPhoneImageErrors } from './core/chat-images';
import { hostWindow } from './core/host-env';
import { initPhoneAiActivityNotify } from './core/ai-activity-notify';
import { PHONE_ONLINE_EVENT, topWindowCandidates } from '../unified-statusbar/core/cross-window';
import { clearPhoneMapLocationsCache } from './core/map-locations';
import { bindPhoneMessagesWorldbook, notifyPhoneMessagesChanged, syncPhoneMessageProjectionRegistration } from './core/message-worldbook';
import { flushPhoneSettings, getPhoneSettings, initPhoneSettingsStore } from './core/phone-settings';
import { flushPhoneStore, readPhoneDataRef, rebindPhoneStore } from './core/phone-store';
import { rebindPhoneAvatars, refreshPhoneAvatars } from './core/phone-avatars';
import { totalUnread } from './core/chat-model';
import { socialNotificationUnread } from './core/social-model';
import { bindRosterInvalidation, onRosterInvalidated } from './core/roster';
import { bindStoryLinkListener, verifyStoryLinkOnChatChange, STORY_LINK_ME } from './core/story-link';
import { syncStoryCallEnhancer } from './renderers/story-link-enhance';
import { bindWorldPhoneBridge } from './core/world-link';
import { scheduleVoicemail } from './core/call-voicemail';
import { bindSpyAutoTrigger } from './core/spy-engine';
import { bindPhoneAutoBackup } from './core/phone-backup';
import { bindPhoneRelocationCopy } from './core/phone-relocation';
import { bindHostReadinessWatch } from './core/host-readiness';
import { bindSpyRecordsWorldbook, syncSpyProjectionRegistration, notifySpyRecordsChanged } from './core/spy-worldbook';
import { spyUnreadCount } from './core/spy-model';
import { nightUnread } from './core/night-engine';
import { emptyShopData, shopUnseenDelivered } from './core/shop-model';
import { shopThreadUnreadTotal } from './core/shop-chat-model';
import { requestShopSettle } from './core/shop-engine';
import { PHONE_BUILD_TAG, PHONE_VERSION } from './core/version';
import { registerPhoneApp, setAppBadgeProvider, emitPhoneEvent, emitPhoneNotify } from './renderers/app-registry';
import { settingsApp } from './renderers/app-settings';
import { wechatApp, notifyExternalMessage, isConversationBeingViewed } from './renderers/app-wechat';
import { cameraApp } from './renderers/app-camera';
import { albumApp } from './renderers/app-album';
import { recorderApp } from './renderers/app-recorder';
import { browserApp } from './renderers/app-browser';
import { momentsApp } from './renderers/app-moments';
import { tiebaApp } from './renderers/app-tieba';
import { weiboApp } from './renderers/app-weibo';
import { xhsApp } from './renderers/app-xhs';
import { phoneCallApp, beginIncomingCall, isCallSessionBusy, announceVoicemailReady } from './renderers/app-phone-call';
import { spyApp } from './renderers/app-spy';
import { gameCenterApp } from './renderers/app-game-center';
import { nightApp } from './renderers/app-night';
import { shopApp } from './renderers/app-shop';
import { chronicleApp } from './renderers/app-chronicle';
import { unreadCallCount } from './core/call-model';
import { mountPhone, refreshPhone, togglePhone, openApp, setGlobalSearchOpener } from './renderers/phone-ui';
import { openGlobalSearch } from './renderers/global-search-sheet';

let _rebindTimer: ReturnType<typeof setTimeout> | null = null;

/** 聊天切换重绑（防抖 600ms；loader 的 CHAT_CHANGED 钩子与自身绑定共用此入口）。 */
function scheduleChatRebind(): void {
  if (_rebindTimer) clearTimeout(_rebindTimer);
  _rebindTimer = setTimeout(async () => {
    _rebindTimer = null;
    try {
      const status = await rebindPhoneStore();
      void rebindPhoneAvatars(status.storageId).catch(() => undefined); // 立绘只读快照随聊天身份重建
      clearPhoneMapLocationsCache(); // 地点只读快照随聊天身份重建
      clearPhoneImageErrors(); // 生图失败原因表按 messageId 归属上一聊天：换聊天即清（防串味 + 防无界增长，F7）
    } catch (_e) { /* 状态栏负责恢复路径；小手机保持空态 */ }
    // 消息记录世界书投影：切聊天=手机数据换底（签名必变）→ 请求重投影；主项目晚就绪时惰性补注册
    syncPhoneMessageProjectionRegistration();
    notifyPhoneMessagesChanged();
    syncSpyProjectionRegistration();
    notifySpyRecordsChanged();
    void verifyStoryLinkOnChatChange(); // 正文联动：切角色=切世界书，幂等校验补注入（内部先查开关，关=零开销）
    // 第六轮 ⑨：「ubp-phone:chat-changed」原先在这里广播，但全库已无任何监听方
    // （换聊天刷新实际靠本函数末尾的 refreshPhone 直调）——按「死导出清理」纪律退役，勿复活。
    refreshPhone();
  }, 600);
}

function bindChatChanged(): void {
  const w = hostWindow() as any;
  if (w.__ubp_chat_bound) return;
  w.__ubp_chat_bound = true;
  let bound = false;
  try {
    const ctx = w.SillyTavern?.getContext?.();
    const eventSource = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (eventSource && typeof eventSource.on === 'function' && types?.CHAT_CHANGED) {
      eventSource.on(types.CHAT_CHANGED, () => scheduleChatRebind());
      bound = true;
    }
  } catch (_e) { /* fallthrough */ }
  if (!bound) {
    // 兜底：主项目存储就绪事件（其自身在 CHAT_CHANGED 时派发）
    try {
      w.addEventListener('ub-statusbar-storage-ready', () => scheduleChatRebind());
    } catch (_e) { /* ignore */ }
  }
}

/**
 * L18①(第十二轮)：主项目立绘变动 → 重建头像快照 + 补渲。
 * 此前手机只在「App 挂载 / 选图弹层 / 窥私选人」三个惰性点重读头像 ⇒ 手机已开着时生成的立绘不生效。
 * 宿主窗口一次性订阅（__ubp_* 守卫，脚本重求值不叠加）。
 */
function bindPortraitInvalidation(): void {
  const w = hostWindow() as any;
  if (w.__ubp_portrait_bound) return;
  w.__ubp_portrait_bound = true;
  w.addEventListener('portrait:generated', () => {
    void refreshPhoneAvatars().then(() => emitPhoneEvent('ubp-phone:data-changed'));
  });
}

async function main(): Promise<void> {
  const w = hostWindow() as any;
  if (w.__ubp_booted) return;
  w.__ubp_booted = true;
  console.log(`[瑟瑟小手机] 初始化 ${PHONE_VERSION} (${PHONE_BUILD_TAG})`);

  // App 注册（第六轮 ⑨：registerPlaceholderApps 退役——占位表恒为空数组、每次开机空转；
  // 朋友圈/论坛/相机/电话等早已转正，由下面逐个注册真实 App）
  registerPhoneApp(wechatApp);
  registerPhoneApp(cameraApp);
  registerPhoneApp(albumApp);
  registerPhoneApp(recorderApp);
  registerPhoneApp(browserApp);
  registerPhoneApp(momentsApp);
  registerPhoneApp(tiebaApp);
  registerPhoneApp(weiboApp);
  registerPhoneApp(xhsApp);
  registerPhoneApp(phoneCallApp);
  registerPhoneApp(spyApp);
  registerPhoneApp(gameCenterApp);
  registerPhoneApp(nightApp);
  registerPhoneApp(shopApp);
  registerPhoneApp(chronicleApp);
  registerPhoneApp(settingsApp);
  setAppBadgeProvider('wechat', () => totalUnread(readPhoneDataRef()));
  setAppBadgeProvider('phone-call', () => unreadCallCount(readPhoneDataRef().calls || []));
  setAppBadgeProvider('spy', () => spyUnreadCount(readPhoneDataRef()));
  setAppBadgeProvider('night', () => nightUnread());
  // 网上商城（docs/52 + docs/54）：未读送达包裹 + **未读商家消息**（用户定案：两者合并为商城角标）
  setAppBadgeProvider('shop', () => {
    const shop = readPhoneDataRef().shop || emptyShopData();
    return shopUnseenDelivered(shop) + shopThreadUnreadTotal(shop.threads);
  });
  // 社媒四平台共用一份未读通知流（逐条已读：内容型新帖 + 互动型评论/回复都在里面）
  setAppBadgeProvider('moments', () => socialNotificationUnread(readPhoneDataRef().social, 'moments'));
  setAppBadgeProvider('tieba', () => socialNotificationUnread(readPhoneDataRef().social, 'tieba'));
  setAppBadgeProvider('weibo', () => socialNotificationUnread(readPhoneDataRef().social, 'weibo'));
  setAppBadgeProvider('xhs', () => socialNotificationUnread(readPhoneDataRef().social, 'xhs'));

  // 配置与存储引导（各自失败不阻断后续）
  // U24(第十一轮)：前两步（宿主配置 / 设置存储）互不依赖，并行省一个网络往返；
  // 后两步有依赖（rebindPhoneAvatars 需 rebindPhoneStore 的 storageId）保持顺序。
  await Promise.all([
    bootHostConfig().catch(() => undefined),
    initPhoneSettingsStore().catch(() => undefined),
  ]);
  bindHostConfigSync(); // 主项目配置落盘推送 → 重读偏好文件 + 失效缓存（App 层经 onHostConfigSynced 刷新）
  bindRosterInvalidation();
  const bootStatus = await rebindPhoneStore().catch(() => null);
  await rebindPhoneAvatars(bootStatus?.storageId || '').catch(() => undefined);
  bindChatChanged();

  // UI 挂载
  initPhoneAiActivityNotify(); // 文字 AI 统一通知（幂等；灵动岛/浮球在 phone-ui 侧订阅）
  mountPhone();
  // 全局搜索：桌面搜索胶囊的打开回调（壳层不能 import 该模块，经注册口接线，避免成环）
  setGlobalSearchOpener(screen => openGlobalSearch(screen));

  // 世界演化联动桥（主项目 doEvolve 落盘后经 window.__ubp_world_inject 推送）：
  // 消息→微信红点+会话刷新；来电→自动亮屏进电话 App 来电界面（占线则保持未接记录）；
  // 社媒帖→平台未读累计（悬浮球+桌面图标角标，打开对应 App 清零）。
  bindPortraitInvalidation(); // L18①：立绘变动失效通知（宿主窗口订阅一次）
  bindCurrencyHostChange(); // F68：宿主货币变更广播订阅（转账弹层余额即时）
  bindWorldPhoneBridge({
    onApplied: outcomes => {
      for (const o of outcomes) {
        if (!o.ok) continue;
        if (o.event.kind === 'message' && o.conversationId) {
          notifyExternalMessage(o.conversationId);
          // 通知横幅 + 提示音（I-2/I-3）：主角正看着这个会话时不打扰
          if (!isConversationBeingViewed(o.conversationId)) {
            emitPhoneNotify({ appId: 'wechat', title: o.event.name, text: o.event.text || '', convId: o.conversationId });
          }
        } else if (o.ok && o.event.kind === 'social') {
          // L18②(第十二轮)：与演化路径同口径——正文里写出的社媒片段此前只落库不发横幅
          // （演化路径的 social 分支有横幅），同一件事两条链路可见性不一致。
          const platform = o.event.platform || 'moments';
          emitPhoneNotify({ appId: platform, title: o.event.name, text: o.event.text || o.event.title || '' });
        } else if (o.event.kind === 'money' && o.conversationId) {
          // 货币正文提取：转账/红包消息入会话（记账在主扩展提取侧已完成，此处只做 UI）
          notifyExternalMessage(o.conversationId);
          if (o.event.direction !== 'out' && !isConversationBeingViewed(o.conversationId)) {
            const prefix = o.event.moneyKind === 'redpacket' ? '[红包]' : '[转账]';
            emitPhoneNotify({ appId: 'wechat', title: o.event.name, text: `${prefix}${o.event.note || ''}`, convId: o.conversationId });
          }
        } else if (o.event.kind === 'social') {
          // 场外异步出现的新帖（演化投递）——正是"通知横幅"该出现的场合
          const platform = o.event.platform || 'moments';
          emitPhoneNotify({ appId: platform, title: o.event.name, text: o.event.text || o.event.title || '' });
        } else if (o.event.kind === 'call' && o.recordId) {
          if (!isCallSessionBusy()) {
            beginIncomingCall({
              recordId: o.recordId,
              peerName: o.event.name,
              opening: o.event.lines || [],
              thought: o.event.thought,
            });
            openApp('phone-call', { system: true }); // 系统路径（世界演化来电）：亮屏切界面但不计成就打点
          } else {
            // 占线未接（T1）：电话没人接也弹不出来——真正的错过，后台补一条语音留言
            // （闸门=语音总开关+通话逐句朗读，默认关零请求；生成完成才通知，见 core/call-voicemail）
            void scheduleVoicemail({ recordId: o.recordId, peerName: o.event.name, scene: 'missed' }).then(r => {
              if (r.ok) announceVoicemailReady(r);
            });
          }
        }
      }
      emitPhoneEvent('ubp-phone:data-changed'); // 悬浮球/桌面角标
    },
  });
  // 手机（重）上线广播：主扩展监听后重投影货币世界书（转账/红包格式段按在线分支重建）。
  // 必须在 bindWorldPhoneBridge 之后派发——__ubp_phone_style 已就位，宿主重建时探测才有值。
  for (const w of topWindowCandidates()) {
    try { (w as { dispatchEvent?: (e: unknown) => void }).dispatchEvent?.(new CustomEvent(PHONE_ONLINE_EVENT)); } catch (_e) { /* ignore */ }
  }

  // 正文联动（MESSAGE_RECEIVED + 500ms 防抖提取，时点对齐世界演化）：
  // 消息→私聊会话红点；通话→已接通记录（不弹来电 UI）；角色间互动→窥私域（不通知、不打扰，只更新列表/角标）；
  // 功能关闭时回调首行即返。
  bindStoryLinkListener({
    onApplied: outcomes => {
      for (const o of outcomes) {
        // 窥私事件（角色间互动）不走微信通知/横幅：围观口径，角标与列表由 data-changed 刷新
        if (o.ok && o.event.kind === 'message' && o.conversationId && !o.event.spy) {
          notifyExternalMessage(o.conversationId);
          // 正文里「角色发给主角」的消息才通知；主角自己发出的（STORY_LINK_ME）不发
          if (o.event.name !== STORY_LINK_ME && !isConversationBeingViewed(o.conversationId)) {
            emitPhoneNotify({ appId: 'wechat', title: o.event.peer || o.event.name, text: o.event.text || '', convId: o.conversationId });
          }
        }
      }
      emitPhoneEvent('ubp-phone:data-changed'); // 悬浮球/桌面角标
    },
  });
  syncStoryCallEnhancer(getPhoneSettings().storyLink); // 通话卡片行级气泡增强（关=不观察，零开销）
  bindPhoneMessagesWorldbook(); // 消息记录注入世界书：注册投影+数据/名单变更监听（关=回调首行即返，零开销）
  bindSpyRecordsWorldbook(); // 窥私记录注入世界书：注册投影+数据/名单变更监听（关=零开销）
  bindSpyAutoTrigger(); // 窥私自动生成：MESSAGE_RECEIVED+防抖+轮数水位（总开关/自动开关关闭时零成本常驻）
  bindPhoneAutoBackup(); // 手机数据自动备份：MESSAGE_RECEIVED+AI层数水位（不达水位零写请求，机制对齐主项目备份）
  bindPhoneRelocationCopy(); // 一键搬家：把手机数据文件随搬家复制到新 storageId（经主项目 __ubStorageRelocation 桥）
  bindHostReadinessWatch(); // 主项目就绪探测：首次探测 + 就绪事件重匹配 + 未就绪自动退避回补（横幅数据源）
  // 网上商城（docs/52 §7.1）送达结算：开机 + 故事时间推进（roster 失效）两个触发口；
  // 幂等且无在途订单时零开销（settleShopOrders 首行即返），绝无常驻定时器。
  onRosterInvalidated(requestShopSettle);
  requestShopSettle();

  // 对外桥（loader / 未来状态栏入口用）
  try {
    w.__ubp_toggle = (force?: boolean) => togglePhone(force);
    w.__ubp_on_chat_changed = () => scheduleChatRebind();
  } catch (_e) { /* ignore */ }

  // 收尾 flush
  w.addEventListener('pagehide', () => {
    void flushPhoneStore();
    void flushPhoneSettings();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main());
} else {
  void main();
}
