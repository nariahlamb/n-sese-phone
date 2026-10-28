// ===== 设置 App（docs/02 §7 + docs/01 §6） =====
// 结构对齐主项目 config-panel：四标签页（通用/功能/API/存储）＋页内折叠分组
// （summary 行内总开关/状态徽标）。说明文字一律收进「?」悬浮气泡（helpTip）；
// 文本 API 支持全局独立 / 按功能（通话与聊天/社媒/窥私/生图提示词）分配；
// 四个社媒平台共享一个设置模块；自动生图全局一个开关。

import { clampInt } from '../core/ubp-utils';
import { hostConfigState, onHostConfigSynced, refreshHostConfig } from '../core/host-config';
import { hostDocument, hostWindow, phoneNotify } from '../core/host-env';
import { refreshHostReadiness } from '../core/host-readiness';
import { hostReadinessState, rematchHostFromSettings, resetHostFloatBtn } from './phone-ui';
import { listHostPresets } from '../core/phone-api';
import { SHOP_BATCH_RANGE, SHOP_MAX_ITEMS_RANGE } from '../core/shop-model';
import { IMAGE_MODES, imageModeMissing, listHostImagePresets, resolvePhoneImageConfig } from '../core/chat-images';
import type { PortraitImageGen } from '../../unified-statusbar/core/portrait-config';
import {
  getPhoneMessageWorldbookStatus,
  handlePhoneMessageWorldbookToggle,
  handlePhonePublicProjectionToggle,
  notifyPhoneMessagesChanged,
} from '../core/message-worldbook';
import {
  clearSpyData,
} from '../core/spy-model';
import { readWorldConfigSafe } from '../core/spy-engine';
import {
  getSpyWorldbookStatus,
  handleSpyWorldbookToggle,
  notifySpyRecordsChanged,
} from '../core/spy-worldbook';
import {
  flushPhoneSettings,
  getPhoneSettings,
  savePhoneSettings,
  promptCustomCount,
  socialCustomCount,
  nightCustomCount,
  PHONE_FONT_SCALES,
  PHONE_ZOOM_SCALES,
  PHONE_SOUND_VOLUMES,
  PHONE_LOCK_DELAYS,
  STORY_LINK_SOCIAL_KINDS,
  normalizeStoryLinkSocial,
  type PhoneApiMode,
  type PhoneApiScopeKey,
  type PhoneDarkMode,
  type PhoneImageMode,
  type PhoneSettings,
} from '../core/phone-settings';
import { PHONE_VOICE_SPEEDS, PHONE_VOICE_CACHE_MB, type PhoneVoiceBackend } from '../core/phone-settings';
import { getRoster } from '../core/roster';
import { playVoice, stopVoice, resolveComfyUrl, voicePoolFor, listProviderVoicesPage, systemVoices } from '../core/voice-tts';
import { VOICE_CATALOG_MAX, VOICE_PROVIDERS, resolveProvider, authLabel, secondCredentialLabel, hasVoiceFetcher, voiceFilterSpecs, resolveVoiceFilters, parseManualVoices, serializeVoicePool, type VoiceProviderPreset } from '../core/voice-providers';
import type { VoiceCredential } from '../core/voice-requests';
import type { VoiceGender, VoiceOption } from '../core/voice-mapping';
import { autoVoiceOf, bucketGenderOf, roleProviderFor } from '../core/voice-mapping';
import { uploadComfyAudio } from '../core/voice-comfy';
import { voicePlanFor, resolveSenderVoicePlan } from '../core/chat-voice';
import { voiceCacheClear } from '../core/voice-cache';
import {
  deletePhoneBackup,
  listPhoneBackups,
  manualPhoneBackup,
  resetPhoneDataWithBackups,
  restorePhoneBackup,
  type PhoneBackupMeta,
} from '../core/phone-backup';
import { flushPhoneStore, mutatePhoneData, phoneStoreStatus, readPhoneData, readPhoneDataRef, resetPhoneData } from '../core/phone-store';
import { normalizeStyleValue, type PhoneStyle } from '../core/chat-model';
import { S, STYLE_OPTIONS } from '../core/skins';
import { currentCustomSkin, SKIN_OPTIONS } from '../core/skin-themes';
import {
  checkStoryLinkStatus,
  ensureStoryLinkInjection,
  removeStoryLinkInjection,
  storyLinkSocialLabel,
  type StoryLinkStatus,
} from '../core/story-link';
import { syncStoryCallEnhancer } from './story-link-enhance';
import { PROTAGONIST_AVATAR_KEY } from '../core/phone-avatars';
import { albumOverflowCount, collectPhoneImagePaths, deletePhoneImageFiles, pruneAlbumOverflow } from '../core/phone-album';
import { deletePhoneMemosForChat } from '../core/phone-memo';
import { clearHomeBg, clearLockBg, readHomeBg, readLockBg, setHomeBg, setLockBg } from '../core/phone-backgrounds';
import { PHONE_VERSION, PHONE_BUILD_TAG } from '../core/version';
import { PHONE_FONT_FAMILIES } from '../styles/phone-theme';
import { emitPhoneEvent, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openConfirmSheet } from './action-sheet';
import { openAvatarPickerSheet, openImagePickerSheet } from './image-picker-sheet';
import { openPickerSheet } from './picker-sheet';
import { openStorageManagerSheet } from './storage-manager-sheet';
import { openPromptSheet } from './prompt-editor-sheet';
import { closeSkinStudio, importSkinFromText, isSkinStudioOpen, openSkinStudio } from './skin-studio';
import { nightSyncImageSettings } from './app-night';
import { avatarHtml, escapeAttr, escapeHtml, refreshHome, refreshPhone, showScreenToast } from './phone-ui';
import { emitAch } from '../core/phone-achievements';
import { ubpIcon } from './icons';

type SetTab = 'general' | 'features' | 'api' | 'storage';
const SET_TABS: ReadonlyArray<{ id: SetTab; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'features', label: '功能' },
  { id: 'api', label: 'API' },
  { id: 'storage', label: '存储' },
];

/** 文本 API 按功能分配的作用域（顺序即设置页展示顺序）。 */
const API_SCOPES: ReadonlyArray<{ key: PhoneApiScopeKey; label: string; tip: string }> = [
  { key: 'chat', label: '通话与聊天', tip: '微信私聊/群聊消息与通话记录生成所用 API。' },
  { key: 'social', label: '社媒', tip: '朋友圈/贴吧/微博/小红书刷新与互动反馈生成所用 API。' },
  { key: 'spy', label: '窥私 APP', tip: '角色间私密互动（通话/私聊/群聊）演绎所用 API。' },
  { key: 'night', label: '不夜城', tip: '不夜城全部生成（刷新/直播推进/点单/搭话/约会/档案卡/关于我/委托）所用 API。' },
  { key: 'game', label: '游戏中心', tip: '游戏中心对局内 AI（狼人杀/海龟汤等）生成所用 API。' },
  { key: 'image', label: '生图（提示词）', tip: '生成图片提示词的文本 API；正式出图的后端与画风预设在下方「生图」区选择。' },
];

let _ctx: PhoneAppContext | null = null;
let _tab: SetTab = 'general';
/** 折叠组展开态：跨重绘记忆（对齐主项目 details 恢复逻辑），切标签页不重置 */
const _openSections = new Set<string>();
/** 正文联动注入状态（打开设置页/功能页时异步拉取一次；null=检查中） */
let _storyStatus: StoryLinkStatus | null = null;
/** 存储页备份列表快照（null=待加载；操作后置 null 触发重载）。 */
let _backups: { list: PhoneBackupMeta[]; ready: boolean } | null = null;

async function loadBackups(): Promise<void> {
  try {
    _backups = await listPhoneBackups();
  } catch (_e) {
    _backups = { list: [], ready: false };
  }
}

/**
 * 手机数据整值换底后的统一刷新（清空/重置/恢复三条路径共用）：
 * 角标/桌面/界面重绘 + 两条世界书投影按新数据收敛（消息记录 + 窥私记录）。
 * 缺窥私通知曾导致清空后投影条目仍留旧记录（AI 仍能读到已清空的数据）。
 */
function afterPhoneDataReplaced(): void {
  emitPhoneEvent('ubp-phone:data-changed');
  notifyPhoneMessagesChanged();
  notifySpyRecordsChanged();
  refreshPhone();
}

/** 世界书注入状态徽标：开关已表达「关/开」，这里只报开关表达不了的对接状态。
 *  （关闭态返回空串——再挂一枚「已关闭」文字徽标就是同一件事说两遍。） */
function worldbookBadge(st: { enabled: boolean; bridgeAvailable: boolean; registered: boolean; characterCount: number }): string {
  if (!st.enabled) return '';
  if (!st.bridgeAvailable) return '<span class="ubp-set-badge off">主项目未就绪</span>';
  if (st.registered) return `<span class="ubp-set-badge on">已接入 · ${st.characterCount} 名角色</span>`;
  return '<span class="ubp-set-badge off">未接入调度</span>';
}

function dot(state: 'ok' | 'warn' | 'err'): string {
  return `<span class="ubp-dot ${state}"></span>`;
}

function switchInputHtml(checked: boolean, act: string): string {
  return `<label class="ubp-switch"><input type="checkbox" data-ubp-set="${escapeAttr(act)}" ${checked ? 'checked' : ''}><span class="ubp-switch-track"></span><span class="ubp-switch-knob"></span></label>`;
}

/**
 * 「?」提示按钮：设置项说明收进气泡，不再平铺占版面。
 * 说明文字放 data-ubp-tip；展示由容器级 mouseover（悬停）+ click（点按，触屏）驱动，
 * 移出必收（150ms 延迟、再次悬停取消，复刻主项目 hideHelpTooltip），
 * 浮层定位对齐主项目 showHelpTooltip（按钮下方居中、贴底上翻），见 showTip/hideTip。
 */
/** 主项目状态卡（SH-04）：仅在未就绪时出现——用户语言 + 处理入口 + 重新检测（替代常驻工程横幅）。 */
function hostCardHtml(): string {
  const r = hostReadinessState();
  if (!r || r.ready) return '';
  return `<div class="ubp-hostcard">
    <span class="ubp-hostcard-main">主项目还没就绪：${escapeHtml(r.issues.join('、'))}暂不可用。装好对应功能后点右侧重试。</span>
    <button type="button" class="ubp-btn" data-ubp-set-app="host-rematch">重新检测</button>
  </div>`;
}

function helpTip(text: string): string {
  return `<span class="ubp-tipbtn" tabindex="0" data-ubp-tip="${escapeAttr(text)}">?</span>`;
}

/** 当前展示中的说明浮层（挂在 shadow root，单例；anchor=来源按钮）。 */
let _tipPop: HTMLElement | null = null;
let _tipAnchor: HTMLElement | null = null;
let _tipHideTimer: ReturnType<typeof setTimeout> | null = null;

function showTip(btn: HTMLElement): void {
  // 挂进 .ubp-scope 而非 shadow 根：主题变量（卡片底色/文字色）定义在 .ubp-scope 上，
  // 挂 shadow 根取不到值 → 背景透明（scope 无 transform，fixed 仍相对视口）
  const scope = _ctx?.shadow.querySelector('.ubp-scope') as HTMLElement | null;
  if (!scope) return;
  if (_tipHideTimer) { clearTimeout(_tipHideTimer); _tipHideTimer = null; } // 移出后 150ms 内回来不闪
  if (_tipAnchor === btn && _tipPop) return;
  hideTip();
  const pop = document.createElement('div');
  pop.className = 'ubp-tip-pop';
  pop.textContent = btn.dataset.ubpTip || '';
  scope.appendChild(pop);
  _tipPop = pop;
  _tipAnchor = btn;
  btn.classList.add('open');
  // 定位对齐主项目 showHelpTooltip：按钮水平居中、默认展开在下方；下方空间不足翻到上方
  const rect = btn.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const width = Math.ceil(popRect.width) || 260;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(8, Math.min(left, (window.innerWidth || 360) - width - 8));
  const spaceBelow = (window.innerHeight || 640) - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  pop.style.left = `${Math.round(left)}px`;
  if (spaceBelow >= 80 || spaceBelow > spaceAbove) {
    pop.style.top = `${Math.round(rect.bottom + 6)}px`;
  } else {
    pop.style.top = `${Math.round(rect.top - 6)}px`;
    pop.style.transform = 'translateY(-100%)';
  }
}

function hideTip(): void {
  if (_tipHideTimer) { clearTimeout(_tipHideTimer); _tipHideTimer = null; }
  if (_tipAnchor) _tipAnchor.classList.remove('open');
  _tipPop?.remove();
  _tipPop = null;
  _tipAnchor = null;
}

/** 延迟收起（复刻主项目 hideHelpTooltip 的 150ms 缓冲：按钮间移动/进出按钮不闪；showTip 会取消）。 */
function hideTipSoon(): void {
  if (_tipHideTimer) return;
  _tipHideTimer = setTimeout(() => { _tipHideTimer = null; hideTip(); }, 150);
}

/** 悬停展示（mouseover 冒泡委托；移出即排延迟收起——悬停态不钉住，与主项目一致）。 */
function handleTipOver(event: Event): void {
  const btn = (event.target as HTMLElement).closest?.('span.ubp-tipbtn') as HTMLElement | null;
  if (btn) showTip(btn);
}

function handleTipOut(event: Event): void {
  if (!_tipAnchor) return;
  const to = (event as MouseEvent).relatedTarget;
  if (to && _tipAnchor.contains(to as Node)) return;
  hideTipSoon();
}

function numRow(label: string, act: string, value: number, min: number, max: number, hint?: string): string {
  return `<div class="ubp-fieldrow">
    <span class="ubp-fieldlabel">${escapeHtml(label)}${hint ? helpTip(hint) : ''}</span>
    <input type="number" class="ubp-num" data-ubp-set="${escapeAttr(act)}" min="${min}" max="${max}" step="1" value="${value}">
  </div>`;
}

function badgeHtml(on: boolean, onText: string, offText: string): string {
  return `<span class="ubp-set-badge ${on ? 'on' : 'off'}">${on ? onText : offText}</span>`;
}

/**
 * 折叠态数值摘要徽标（中性灰）：卡片收起也能看到当前配置。
 * 与 badgeHtml 分工——开关已表达的状态不再重复挂徽标；只读引用值一律走这里，不让它穿「已开启」的绿。
 */
function valBadge(text: string): string {
  return `<span class="ubp-set-badge val">${escapeHtml(text)}</span>`;
}

/** 提示词编辑器入口行（AI 生成段的通用入口 / 社媒卡内的 social 定向入口 / 不夜城卡内的 night 定向入口共用）。
 *  data-domain 交给 handleClick 透传给 openPromptSheet 的 initialDomain。 */
function promptEntryRow(scope: 'all' | 'social' | 'night'): string {
  const s = getPhoneSettings();
  const count = scope === 'social' ? socialCustomCount(s) : scope === 'night' ? nightCustomCount(s) : promptCustomCount(s);
  const badgeAttr = scope === 'all' ? ' data-ubp-prompt-badge' : ` data-ubp-prompt-badge="${scope}"`;
  const label = scope === 'social'
    ? '生成指令与选题池<span class="ubp-fieldhint-inline">朋友圈 / 贴吧 / 微博 / 小红书</span>'
    : scope === 'night'
      ? '生成指令与板块设定<span class="ubp-fieldhint-inline">15 个玩法 / 总纪律 / 6 个板块</span>'
      : `提示词编辑${helpTip('自定义各平台的生成指令与生图写法、不夜城的玩法与板块。改坏了不影响输出格式，点「恢复默认」即可还原内置文本。')}`;
  const domainAttr = scope === 'social' ? ' data-domain="social"' : scope === 'night' ? ' data-domain="night"' : '';
  return `<div class="ubp-fieldrow" data-ubp-set-app="prompt-edit"${domainAttr} style="cursor:pointer;">
    <span class="ubp-fieldlabel">${label}</span>
    <span class="ubp-set-badge"${badgeAttr}${count ? ' on' : ' hidden'}>${count ? `已自定义 ${count} 处` : ''}</span>
    <span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span>
  </div>`;
}

// ─── 正文联动（条目/正则注入状态 + 开关接线） ───

async function refreshStoryStatus(): Promise<void> {
  _storyStatus = await checkStoryLinkStatus();
}

function storyEntryBadge(st: StoryLinkStatus | null): string {
  if (!st) return '<span class="ubp-set-badge off">检查中…</span>';
  if (st.group) return '<span class="ubp-set-badge off">群聊不支持</span>';
  if (!st.api) return '<span class="ubp-set-badge off">API 不可用</span>';
  if (st.entry === 'injected') return '<span class="ubp-set-badge on">已注入</span>';
  if (st.entry === 'stale') return '<span class="ubp-set-badge off">内容过期</span>';
  if (st.entry === 'no-book') return '<span class="ubp-set-badge off">角色未绑定主世界书</span>';
  if (st.entry === 'missing') return '<span class="ubp-set-badge off">未注入</span>';
  return '<span class="ubp-set-badge off">未知</span>';
}

function storyRegexBadge(st: StoryLinkStatus | null): string {
  if (!st) return '<span class="ubp-set-badge off">检查中…</span>';
  if (st.regexCount >= st.regexTotal) return `<span class="ubp-set-badge on">已注入 ${st.regexCount}/${st.regexTotal}</span>`;
  if (!st.api) return '<span class="ubp-set-badge off">API 不可用</span>';
  return `<span class="ubp-set-badge off">缺 ${st.regexTotal - st.regexCount} 项</span>`;
}

async function handleStoryLinkToggle(on: boolean): Promise<void> {
  await savePhoneSettings({ storyLink: on });
  syncStoryCallEnhancer(on); // 通话卡片行级气泡增强随开关启停
  if (on) {
    try {
      await ensureStoryLinkInjection();
      phoneNotify('正文联动已开启：格式条目与渲染正则注入完成');
    } catch (e) {
      phoneNotify(String((e as Error)?.message || e), '正文联动开启失败', 'error');
    }
  } else {
    await removeStoryLinkInjection();
  }
  await refreshStoryStatus();
  render();
}

/** 折叠分组卡片：side = summary 行右侧附加控件（总开关/状态徽标），tip = 标题旁「?」说明。
 *  （副标题描述行已取消——说明文字统一进气泡。） */
function sectionHtml(id: string, title: string, body: string, side = '', tip = ''): string {
  return `<details class="ubp-set-sec" data-ubp-sec="${escapeAttr(id)}"${_openSections.has(id) ? ' open' : ''}>
    <summary class="ubp-set-sec-summary">
      <span class="ubp-set-sec-main">
        <span class="ubp-set-sec-title">${title}${tip ? helpTip(tip) : ''}</span>
      </span>
      ${side}
      <span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span>
    </summary>
    <div class="ubp-set-sec-body">${body}</div>
  </details>`;
}

/** 设置行下方备注小字（如注入 token 粗估——按条数直算给个心理数，不扫数据）。 */
function noteHtml(text: string): string {
  return `<div class="ubp-set-note">${escapeHtml(text)}</div>`;
}

/** 注入条数的 token 粗估备注（每条混合记录按 ≈30 token 估，仅作心理参考）。 */
function tokenNoteHtml(prefix: string, count: number): string {
  return noteHtml(`${prefix}当前 ${count} 条 ≈ 约 ${count * 30} token（每条按 ≈30 token 粗估）`);
}

// ─── 语音（TTS，第 31 篇）设置分组 ───

const VOICE_BACKEND_LABELS: Record<string, string> = { off: '关', system: '系统', api: 'API', comfy: '本地' };

function voiceBackendLabel(b: string): string {
  return VOICE_BACKEND_LABELS[b] || '关';
}

/** 次级折叠（本次新增：折叠时只报当前配置模式；docs/35 §A.2）。复用 data-ubp-sec 记录展开态。 */
function subSecHtml(id: string, title: string, side: string, body: string): string {
  return `<details class="ubp-set-subsec" data-ubp-sec="${escapeAttr(id)}"${_openSections.has(id) ? ' open' : ''}>
    <summary class="ubp-set-subsec-summary"><span class="ubp-set-subsec-title">${title}</span>${side}<span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span></summary>
    <div class="ubp-set-subsec-body">${body}</div>
  </details>`;
}

/** 通讯录角色（含性别/年龄/语气，供自动分配展示）。档案不可读时返回空。 */
/** 角色音色面板/试听用的档案条目（custom = 通讯录「＋」添加、数据库无档案）。 */
type RoleMeta = { name: string; gender?: string; age?: string; languageStyle?: string; custom?: boolean };

/** 角色音色面板/试听用的档案列表：通讯录（人物档案）+ 通讯录「＋」添加的自定义联系人。
 *  自定义联系人在人物库里没有档案（customContacts 只是名字数组，无性别列），但仍要能在面板里
 *  手动指定音色——否则它们只能在全池里抽签，且没有任何可纠正的入口（docs/38 §1 关卡 1）。 */
function safeRosterMeta(): RoleMeta[] {
  try {
    const roster = getRoster();
    const list: RoleMeta[] = roster.contacts
      .filter(c => Boolean(c.name))
      .slice(0, 40)
      .map(c => ({ name: c.name, gender: c.gender, age: c.age, languageStyle: c.languageStyle }));
    let extra = 0;
    for (const name of (readPhoneDataRef().customContacts || [])) {
      if (!name || extra >= 20 || list.some(c => c.name === name)) continue;
      list.push({ name, custom: true });
      extra++;
    }
    return list;
  } catch (_e) {
    return [];
  }
}

/** 当前服务商凭据（认不出服务商时回落自定义）。 */
function activeVoiceCred(s: PhoneSettings): VoiceCredential {
  const provider = resolveProvider(s.voiceProvider);
  return (s.voiceCredentials || {})[provider.id] || {};
}

// ─── 音色池表格化编辑（docs/53）：同一份 voiceCatalog[pid] 文本的两种视图 ───
// 表格态 = 名称 / 音色 ID / 性别 三列（点行展开编辑卡）；文本态 = 原来那块 textarea（「批量编辑」）。
// 纪律三条：
//   ① 数据只有一个来源（settings.voiceCatalog[pid]），两态都只是它的渲染，两态互切不丢内容；
//   ② 单元格落盘只重绘这张卡（不跑整页 render —— 滚动位置、其它输入的焦点都不动）；
//   ③ **失焦提交不重绘**：失焦常常紧跟着一次点击（点另一行 / 点删除），此刻重排 DOM 会让那次
//      点击落到重排后的新元素上（可能误伤邻行）—— 所以这之外的动作一律先「封存」再动手。

/** 正在展开编辑的行（'' = 无；形如 `pid#序号`；序号 -1 = 正在新增的那一条）。 */
let _vpoolEditKey = '';
/** 表格 / 纯文本两态，按服务商记忆。 */
const _vpoolMode: Record<string, 'table' | 'text'> = {};
/** 搜索词（记 pid：换一家不串台；纯 UI 态，不落盘）。 */
let _vpoolQuery = '';
let _vpoolQueryPid = '';
/** 提交失败的就地提示（渲染一次即清）。 */
let _vpoolErr = '';

const VPOOL_GENDERS: ReadonlyArray<{ g: VoiceGender; label: string }> = [
  { g: 'f', label: '女' },
  { g: 'm', label: '男' },
  { g: 'n', label: '中性' },
];

function vpoolGenderLabel(g: string): string {
  return VPOOL_GENDERS.find(x => x.g === g)?.label || '中性';
}

/** 当前全局服务商 id（= 音色池的存储键）。 */
function vpoolPid(): string {
  return resolveProvider(getPhoneSettings().voiceProvider).id;
}

/** 当前服务商的池子文本（表格与文本两态的唯一数据来源）。 */
function vpoolCatalog(pid: string): string {
  return String((getPhoneSettings().voiceCatalog || {})[pid] || '');
}

/** 当前服务商的池子行（解析同一份文本；行序号即 data-row）。 */
function vpoolRows(pid: string): VoiceOption[] {
  return parseManualVoices(vpoolCatalog(pid));
}

/** 落盘这一家的池子文本（空 = 删键；与文本框时代同口径）。 */
function saveVoiceCatalog(pid: string, text: string): void {
  const s = getPhoneSettings();
  const next = { ...(s.voiceCatalog || {}) };
  const v = String(text || '').slice(0, VOICE_CATALOG_MAX);
  if (v.trim()) next[pid] = v;
  else delete next[pid];
  void savePhoneSettings({ voiceCatalog: next });
}

/** 认不出的行数（非空但第一段没有 id，形如 `|名称`）——列进保存前警示。 */
function vpoolBadLines(text: string): number {
  let bad = 0;
  for (const raw of String(text || '').split(/[\n,，]/)) {
    const item = raw.trim();
    if (item && !item.split('|')[0].trim()) bad++;
  }
  return bad;
}

/** 音色池行编辑校验（就地红字，不落盘）。 */
function vpoolValidate(pid: string, draft: VoiceOption, selfIdx: number): string {
  if (!draft.id) return '音色 ID 不能为空（它是发给服务商的那个值）。';
  if (draft.id.includes('|')) return '音色 ID 里不能有「|」（它是文本格式的分隔符）。';
  const rows = vpoolRows(pid);
  const dup = rows.findIndex((r, i) => i !== selfIdx && r.id === draft.id);
  if (dup >= 0) return `ID 与第 ${dup + 1} 条「${rows[dup].label || rows[dup].id}」重复 —— 同一个 id 只会留一条。`;
  if (resolveProvider(pid).voices.some(v => v.id === draft.id)) return '与内置音色同 id：内置先到先得（见下方只读列表），这一条不会生效。';
  return '';
}

/** 行展开编辑卡（名称 / 音色 ID / 性别 / 动作）。isNew = 顶部那张新增卡。 */
function vpoolEditHtml(r: VoiceOption, idx: number, isNew: boolean): string {
  const named = String(r.label || '').trim();
  return `<div class="ubp-vpool-editrow">
    ${_vpoolErr ? `<div class="ubp-vpool-err">${escapeHtml(_vpoolErr)}</div>` : ''}
    <div class="ubp-vpool-erow"><label>名称</label>
      <input class="ubp-vpool-input" data-ubp-set="vpoolName" data-row="${idx}" value="${escapeAttr(named && named !== r.id ? named : '')}" placeholder="留空用 ID"></div>
    <div class="ubp-vpool-erow"><label>音色 ID</label><div class="ubp-vpool-idwrap">
      <input class="ubp-vpool-input id${_vpoolErr ? ' bad' : ''}" data-ubp-set="vpoolId" data-row="${idx}" value="${escapeAttr(r.id)}" placeholder="厂商控制台里的音色 id">
      ${isNew ? '' : `<button class="ubp-vpool-btn sm" data-ubp-set-app="vpool-copy" data-row="${idx}">复制</button>`}
    </div></div>
    <div class="ubp-vpool-erow"><label>性别</label><div class="ubp-vpool-seg">
      ${VPOOL_GENDERS.map(x => `<button class="${r.gender === x.g ? `on ${x.g}` : ''}" data-ubp-set-app="vpool-gender" data-row="${idx}" data-g="${x.g}">${x.label}</button>`).join('')}
    </div></div>
    <div class="ubp-vpool-eacts">
      ${isNew ? '' : `<button class="ubp-vpool-btn sm" data-ubp-set-app="vpool-top" data-row="${idx}">置顶为兜底</button>`}
      <span class="spacer"></span>
      ${isNew ? '' : `<button class="ubp-vpool-btn sm danger" data-ubp-set-app="vpool-del" data-row="${idx}">删除</button>`}
      <button class="ubp-vpool-btn sm primary" data-ubp-set-app="vpool-commit" data-row="${idx}">完成</button>
    </div>
  </div>`;
}

/** 收起态的一行（名称 / 性别 / 删除；池首带「兜底」徽标）。
 *  **ID 不上屏**（2026-10-06 复审：浏览时看 id 没意义）——悬停出提示、点一下进编辑卡改；
 *  名称留空的行直接显示 id（灰斜体）：解析时 label 本就回落成 id，不显示的话一屏「未命名」无从分辨。 */
function vpoolRowHtml(r: VoiceOption, idx: number): string {
  const raw = String(r.label || '').trim();
  const named = raw && raw !== r.id ? raw : '';
  return `<div class="ubp-vpool-row" title="音色 ID：${escapeAttr(r.id)}（点一下可改）">
    <span class="ubp-vpool-cell${named ? '' : ' nolabel'}" data-ubp-set-app="vpool-edit" data-row="${idx}" data-field="name">${escapeHtml(named || r.id)}${idx === 0 ? '<span class="ubp-vpool-fb">兜底</span>' : ''}</span>
    <button class="ubp-vpool-g ${r.gender}" data-ubp-set-app="vpool-gender" data-row="${idx}" title="点一下换性别（女 → 男 → 中性）">${vpoolGenderLabel(r.gender)}</button>
    <button class="ubp-vpool-del" data-ubp-set-app="vpool-del" data-row="${idx}" title="删除这条">${ubpIcon('trash')}</button>
  </div>`;
}

/** 行区（搜索过滤 + 展开中的编辑卡；搜索框自身不在其中，敲字只换这一块）。 */
function vpoolRowsHtml(pid: string): string {
  const rows = vpoolRows(pid);
  const q = _vpoolQueryPid === pid ? _vpoolQuery.trim().toLowerCase() : '';
  const shown = rows.map((r, i) => ({ r, i })).filter(x => !q || x.r.id.toLowerCase().includes(q) || String(x.r.label || '').toLowerCase().includes(q));
  const newOpen = _vpoolEditKey === `${pid}#-1`;
  let html = newOpen ? vpoolEditHtml({ id: '', label: '', gender: 'n' }, -1, true) : '';
  if (!shown.length && !newOpen) html += `<div class="ubp-vpool-row"><span class="ubp-vpool-cell miss">没有匹配「${escapeHtml(_vpoolQuery)}」的音色</span></div>`;
  html += shown.map(x => (_vpoolEditKey === `${pid}#${x.i}` ? vpoolEditHtml(x.r, x.i, false) : vpoolRowHtml(x.r, x.i))).join('');
  return html;
}

/** 内置音色（代码预设，删了也会回来）—— 只读折叠，避免用户以为池子里漏了它们。 */
function vpoolBuiltinHtml(provider: VoiceProviderPreset): string {
  const builtin = provider.voices || [];
  if (!builtin.length) return '';
  return `<details class="ubp-vpool-builtin"><summary>内置音色 ${builtin.length} 个（只读，不可删改）</summary>
    <div class="ubp-vpool-chips">${builtin.map(v => `<span>${escapeHtml(v.id)}</span>`).join('')}</div></details>`;
}

/** 表格态：三列 + 统计 + 搜索（行数多才出）+ 添加 + 内置只读 + 拉取栏。 */
function vpoolTableHtml(s: PhoneSettings, provider: VoiceProviderPreset): string {
  const pid = provider.id;
  const rows = vpoolRows(pid);
  const canFetch = hasVoiceFetcher(pid);
  const count = { f: 0, m: 0, n: 0 } as Record<string, number>;
  for (const r of rows) count[r.gender] = (count[r.gender] || 0) + 1;
  const head = `<div class="ubp-vpool-head">
      <span class="ubp-vpool-title">${escapeHtml(provider.name)} 音色池${helpTip('这家供自动分配用的音色：内置音色 + 这张表。按服务商分存，换家不串台；点名称/ID 改这一条，点性别直接换。')}</span>
      ${rows.length ? '<button class="ubp-vpool-btn sm" data-ubp-set-app="vpool-text">批量编辑</button>' : ''}
    </div>`;
  const fetchWrap = canFetch ? `<div class="ubp-vpool-fetch">${voiceFetchBarHtml(s, pid)}</div>` : '';

  if (!rows.length && _vpoolEditKey !== `${pid}#-1`) {
    return `<div class="ubp-vpool">${head}
      <div class="ubp-vpool-empty">
        <div class="e1">这家还没有手填音色</div>
        <div class="e2">池子为空时，自动分配无从落点，请求也不会带音色 id（服务端会用它的默认音色，可能每次不同）。</div>
        <div class="ubp-vpool-empty-acts">
          <button class="ubp-vpool-btn primary" data-ubp-set-app="vpool-add">＋ 添加音色</button>
          <button class="ubp-vpool-btn" data-ubp-set-app="vpool-text">批量粘贴</button>
        </div>
        ${canFetch ? '' : '<div class="e2" style="margin-top:10px">这家没有公开的音色列表接口 → 手填音色 id，或直接「批量粘贴」。</div>'}
      </div>
      ${vpoolBuiltinHtml(provider)}
      <div class="ubp-vpool-note">每行：<code>id</code> · <code>id|名称</code> · <code>id|名称|f/m/n</code>；表格与纯文本随时互相切换，改的都是同一份数据。</div>
      ${fetchWrap}</div>`;
  }

  const first = rows[0];
  const pin = first ? `<span class="pin">　池首「${escapeHtml((String(first.label || '').trim() || first.id).slice(0, 12))}」＝兜底音色</span>` : '';
  return `<div class="ubp-vpool">${head}
    <div class="ubp-vpool-stat">共 <b>${rows.length}</b> 条 · 女 ${count.f || 0} · 男 ${count.m || 0} · 中性 ${count.n || 0}${pin}</div>
    ${rows.length > 8 ? `<div class="ubp-vpool-tools"><input class="ubp-vpool-search" data-ubp-set="vpoolQuery" value="${escapeAttr(_vpoolQueryPid === pid ? _vpoolQuery : '')}" placeholder="搜索名称 / ID（共 ${rows.length} 条）"></div>` : ''}
    <div class="ubp-vpool-list">
      <div class="ubp-vpool-thead"><span>名称</span><span>性别</span><span></span></div>
      <div class="ubp-vpool-rows">${vpoolRowsHtml(pid)}</div>
    </div>
    <button class="ubp-vpool-add" data-ubp-set-app="vpool-add">＋ 添加音色</button>
    ${vpoolBuiltinHtml(provider)}
    <div class="ubp-vpool-note">性别用于「自动分配音色」按角色档案分桶（中性 = 全池抽签）；音色 ID 悬停可见、点一下可改。</div>
    ${fetchWrap}</div>`;
}

/** 纯文本态（「批量编辑」）：就是原来那块 textarea，格式与即时保存规矩都不变。 */
function vpoolTextHtml(s: PhoneSettings, provider: VoiceProviderPreset): string {
  const pid = provider.id;
  const catalog = vpoolCatalog(pid);
  const parsed = parseManualVoices(catalog).length;
  const bad = vpoolBadLines(catalog);
  return `<div class="ubp-vpool">
    <div class="ubp-vpool-head">
      <span class="ubp-vpool-title">${escapeHtml(provider.name)} 音色池 · 批量编辑</span>
      <button class="ubp-vpool-btn sm primary" data-ubp-set-app="vpool-table">完成（回到表格）</button>
    </div>
    <div class="ubp-vpool-hint">分行编排：每条音色一行 —— <code>id</code> 或 <code>id|名称</code> 或 <code>id|名称|性别</code>（性别写 f / m / n，留空 = 中性）。「名称」留空时，角色音色里会显示音色 ID。改动即时保存。</div>
    <textarea class="ubp-vpool-textarea" data-ubp-set="voiceCatalogText" spellcheck="false">${escapeHtml(catalog)}</textarea>
    ${bad ? `<div class="ubp-vpool-warn">有 ${bad} 行没读出音色 ID（形如 <code>|名称</code>），保存时会被丢弃 —— 先回上面对一下。</div>` : ''}
    <div class="ubp-vpool-tfoot">
      <span class="ubp-vpool-count" data-ubp-vpool-count>已识别 <b>${parsed}</b> 条${bad ? ` · 待修 ${bad} 行` : ''}</span>
      <button class="ubp-vpool-btn" data-ubp-set-app="vpool-table">完成</button>
    </div>
    ${hasVoiceFetcher(pid) ? `<div class="ubp-vpool-fetch">${voiceFetchBarHtml(s, pid)}</div>` : ''}
  </div>`;
}

/** 音色池编辑器（表格 / 纯文本两态；docs/53）。根节点带 data-ubp-vpool：局部重绘按它整块换。 */
function voicePoolEditorHtml(s: PhoneSettings, provider: VoiceProviderPreset): string {
  const mode = _vpoolMode[provider.id] === 'text' ? 'text' : 'table';
  const card = mode === 'text' ? vpoolTextHtml(s, provider) : vpoolTableHtml(s, provider);
  return `<div class="ubp-vpool-wrap" data-ubp-vpool="${escapeAttr(provider.id)}">${card}</div>`;
}

/** 只重绘音色池这张卡（不跑整页 render）。focus = 重绘后把光标交回哪个输入框。 */
function refreshVoicePoolCard(focus?: 'name' | 'id'): void {
  if (!_ctx) return;
  const host = _ctx.container.querySelector('[data-ubp-vpool]') as HTMLElement | null;
  if (!host) return;
  // 整块 outerHTML 换新 ⇒ 池内行区（.ubp-vpool-rows，上限 298px 内滚）元素被换、scrollTop 归零：
  // 性别筛选/删除/置顶这类就地操作要保位（纯文本态没有该行区，取不到即 no-op）
  const prevRowsTop = host.querySelector('.ubp-vpool-rows')?.scrollTop ?? 0;
  const s = getPhoneSettings();
  host.outerHTML = voicePoolEditorHtml(s, resolveProvider(s.voiceProvider));
  const rows = _ctx.container.querySelector('[data-ubp-vpool] .ubp-vpool-rows');
  if (rows && prevRowsTop) rows.scrollTop = prevRowsTop;
  if (!focus) return;
  const next = _ctx.container.querySelector(`[data-ubp-set="${focus === 'id' ? 'vpoolId' : 'vpoolName'}"]`) as HTMLInputElement | null;
  if (!next) return;
  next.focus();
  try { next.setSelectionRange(next.value.length, next.value.length); } catch (_e) { /* ignore */ }
}

/** 搜索框敲字：只换行区（搜索框自身不重绘，光标不跳）。 */
function refreshVoicePoolRows(): void {
  if (!_ctx) return;
  const box = _ctx.container.querySelector('[data-ubp-vpool] .ubp-vpool-rows');
  if (!box) return;
  const pid = resolveProvider(getPhoneSettings().voiceProvider).id;
  box.innerHTML = vpoolRowsHtml(pid);
}

/** 文本态计数（敲字时实时更新，不重绘页面）。 */
function refreshVoicePoolTextCount(text: string): void {
  const el = _ctx?.container.querySelector('[data-ubp-vpool-count]');
  if (!el) return;
  const bad = vpoolBadLines(text);
  el.innerHTML = `已识别 <b>${parseManualVoices(text).length}</b> 条${bad ? ` · 待修 ${bad} 行` : ''}`;
}

/** 失焦提交出错：把红字就地补进编辑卡（推后一拍，别打断正在进行的那次点击的命中判定）。 */
function showVoicePoolEditError(err: string): void {
  setTimeout(() => {
    if (!_ctx || _vpoolErr !== err) return;
    const card = _ctx.container.querySelector('.ubp-vpool-editrow');
    if (!card) return;
    card.querySelector('[data-ubp-set="vpoolId"]')?.classList.add('bad');
    let line = card.querySelector('.ubp-vpool-err') as HTMLElement | null;
    if (!line) {
      line = hostDocument().createElement('div');
      line.className = 'ubp-vpool-err';
      card.insertBefore(line, card.firstChild);
    }
    line.textContent = err;
  }, 0);
}

/** 新增卡落盘后「转正」成第 0 行的编辑卡：只改属性、不动布局（失焦路径不重绘的原因见块首纪律③）。 */
function promoteNewEditCard(pid: string): void {
  _vpoolEditKey = `${pid}#0`;
  _ctx?.container.querySelectorAll('.ubp-vpool-editrow [data-row]').forEach(el => el.setAttribute('data-row', '0'));
}

/** 把编辑卡里的值落盘（close = 收起卡片并重绘；false = 失焦提交，**不重绘**）。
 *  返回 false = 校验没过（调用方应中止这次动作，别拿旧值动手）。 */
function commitVoicePoolEdit(close: boolean): boolean {
  if (!_ctx) return true;
  const pid = resolveProvider(getPhoneSettings().voiceProvider).id;
  if (!_vpoolEditKey.startsWith(`${pid}#`)) return true;
  const idx = Number(_vpoolEditKey.slice(pid.length + 1));
  const idEl = _ctx.container.querySelector('[data-ubp-set="vpoolId"]') as HTMLInputElement | null;
  const nameEl = _ctx.container.querySelector('[data-ubp-set="vpoolName"]') as HTMLInputElement | null;
  const rows = vpoolRows(pid);
  if (!idEl) {
    if (close) { _vpoolEditKey = ''; refreshVoicePoolCard(); }
    return true;
  }
  const isNew = idx < 0;
  const draft: VoiceOption = {
    id: idEl.value.trim(),
    label: (nameEl?.value || '').trim(),
    gender: isNew ? 'n' : (rows[idx]?.gender || 'n'),
  };
  const err = vpoolValidate(pid, draft, isNew ? -1 : idx);
  if (err) {
    _vpoolErr = err;
    if (close) refreshVoicePoolCard();
    else showVoicePoolEditError(err);
    return false;
  }
  _vpoolErr = '';
  if (isNew) {
    // 空 id = 放弃这一行（只收卡，不落盘）
    if (!draft.id) {
      if (close) { _vpoolEditKey = ''; refreshVoicePoolCard(); }
      return true;
    }
    rows.unshift(draft);
    saveVoiceCatalog(pid, serializeVoicePool(rows));
    if (close) { _vpoolEditKey = ''; refreshVoicePoolCard(); }
    else promoteNewEditCard(pid);
    return true;
  }
  if (!rows[idx]) {
    if (close) { _vpoolEditKey = ''; refreshVoicePoolCard(); }
    return true;
  }
  rows[idx] = draft;
  saveVoiceCatalog(pid, serializeVoicePool(rows));
  if (close) { _vpoolEditKey = ''; refreshVoicePoolCard(); }
  return true;
}

/** 动别的之前先把编辑卡里的改动落盘（失败则中止这次动作，避免拿旧值动手）。 */
function sealVoicePoolEdit(): boolean {
  return commitVoicePoolEdit(false);
}

/** 复制音色 id（宿主不给剪贴板时退到「选中」，手动 Ctrl+C 也能拿走）。 */
async function copyVoiceId(id: string): Promise<void> {
  try {
    const win = hostWindow() as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } };
    if (win?.navigator?.clipboard?.writeText) await win.navigator.clipboard.writeText(id);
  } catch (_e) { /* ignore */ }
  const box = _ctx?.container.querySelector('[data-ubp-set="vpoolId"]') as HTMLInputElement | null;
  box?.select();
  if (_ctx) showScreenToast(_ctx.container, '已复制音色 ID');
}

/** 「后端与接口」次级折叠内容：后端模式 + 按模式换字段（docs/35 §A.3）。 */
function voiceConnectHtml(s: PhoneSettings, backend: string): string {  const provider = resolveProvider(s.voiceProvider);
  const cred = activeVoiceCred(s);
  const modeRow = `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">后端模式${helpTip('系统 TTS=浏览器自带、免费离线；在线 API=预填服务商地址与音色，只填密钥；本地=ComfyUI 声音克隆。开关/关闭由折叠条的语音总开关收口。')}</span>
    <select class="ubp-select" data-ubp-set="voiceBackend">
      <option value="system" ${backend === 'system' ? 'selected' : ''}>系统 TTS</option>
      <option value="api" ${backend === 'api' ? 'selected' : ''}>在线 API</option>
      <option value="comfy" ${backend === 'comfy' ? 'selected' : ''}>本地 ComfyUI</option>
    </select></div>`;

  if (backend === 'api') {
    const providerRow = `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">服务商${helpTip('选一家即自动填好地址、模型与音色池，你只需填密钥。标「需 AppID+Key」的是厂商原生协议，会多要一个字段。')}</span>
      <select class="ubp-select" data-ubp-set="voiceProvider">
        ${VOICE_PROVIDERS.map(p => `<option value="${escapeAttr(p.id)}" ${provider.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}（${authLabel(p.auth, p.appIdOptional)}）</option>`).join('')}
      </select></div>`;
    const urlRow = `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">接口地址<span class="ubp-fieldhint">预填 · 可改</span></span>
      <input class="ubp-fieldinput" data-ubp-set="voiceCredUrl" value="${escapeAttr(String(cred.url || ''))}" placeholder="${escapeAttr(provider.baseUrl || 'https://.../v1/audio/speech')}"></div>`;
    // AppID 可空的家（火山：「可留空」这半句必写在字段上，别只藏在问号里）。
    // 留空时密钥只能拼进请求地址（那个请求头不在厂商 CORS 白名单里，见 docs/62），
    // 地址会进服务端日志 ⇒ 能用但不推荐——所以「不推荐」三个字也必须写在同一行。
    const appIdOptional = provider.appIdOptional === true;
    // 带提示的标签比「AppID」长得多，行内 flex 会把输入框挤窄 ⇒ 换本面板既有的列式
    // （接口地址 / 模型两行就是这个布局）；不带提示的家标记逐字不变。
    const rowCls = appIdOptional ? 'ubp-fieldrow column' : 'ubp-fieldrow';
    const appIdRows = `<div class="${rowCls}"><span class="ubp-fieldlabel">AppID${appIdOptional ? `<span class="ubp-fieldhint">可留空 · 不推荐</span>${helpTip('旧版控制台的 AppID。新版控制台不再发 AppID、只发一把 API Key：那种情况下这一格留空，把 API Key 填到下一格即可。但留空后密钥会被拼进请求地址、可能留在服务端日志里，安全性低于「AppID + AccessToken」，所以只在拿不到旧版控制台凭据时才这么用。')}` : ''}</span><input class="ubp-fieldinput" data-ubp-set="voiceCredAppId" value="${escapeAttr(String(cred.appId || ''))}" placeholder="应用 ID"></div>
           <div class="${rowCls}"><span class="ubp-fieldlabel">${secondCredentialLabel(provider)}${appIdOptional ? '<span class="ubp-fieldhint">新版控制台填 API Key</span>' : ''}</span><input class="ubp-fieldinput" type="password" data-ubp-set="voiceCredAccessKey" value="${escapeAttr(String(cred.accessKey || ''))}" placeholder="密钥"></div>`;
    const keyRow = provider.auth === 'none'
      ? `<div class="ubp-set-note">这家不需要密钥（本机服务）。</div>`
      : provider.auth === 'appid'
        ? appIdRows
        : `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">密钥${helpTip('只存在你的浏览器里（随设置走）。被跨域拦截时请改用允许 CORS 的中转站，或在酒馆 config.yaml 打开 enableCorsProxy。')}</span>
             <input class="ubp-fieldinput" type="password" data-ubp-set="voiceCredKey" value="${escapeAttr(String(cred.key || ''))}" placeholder="sk-..."></div>`;
    const modelRow = `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">模型<span class="ubp-fieldhint">预填 · 可改</span></span>
      <input class="ubp-fieldinput" data-ubp-set="voiceCredModel" list="ubp-voice-models" value="${escapeAttr(String(cred.model || ''))}" placeholder="${escapeAttr(provider.models[0] || '')}">
      <datalist id="ubp-voice-models">${provider.models.map(m => `<option value="${escapeAttr(m)}"></option>`).join('')}</datalist></div>`;
    // 音色池：表格化编辑（docs/53）——同一份 catalog 文本的两种视图；拉取筛选条与旧版一致，挂在卡尾
    const poolsRow = voicePoolEditorHtml(s, provider);
    const formatRow = `<div class="ubp-fieldrow"><span class="ubp-fieldlabel">输出格式</span>
      <select class="ubp-select" data-ubp-set="voiceCredFormat">
        <option value="mp3" ${(cred.format || provider.format) === 'mp3' ? 'selected' : ''}>mp3</option>
        <option value="wav" ${(cred.format || provider.format) === 'wav' ? 'selected' : ''}>wav</option>
      </select></div>`;
    const testRow = `<div class="actions"><button class="ubp-btn" data-ubp-set-app="voice-test">试听测试</button></div>
      <div class="ubp-set-note">${escapeHtml(provider.note)}</div>`;
    return modeRow + providerRow + urlRow + keyRow + modelRow + poolsRow + formatRow + testRow;
  }

  if (backend === 'comfy') {
    return modeRow + `
      <div class="ubp-fieldrow column"><span class="ubp-fieldlabel">ComfyUI 地址${helpTip('留空并勾选下方「跟随生图地址」可复用主项目生图的 ComfyUI 地址。')}</span>
        <input class="ubp-fieldinput" data-ubp-set="voiceComfyUrl" value="${escapeAttr(s.voiceComfy.url)}" placeholder="http://127.0.0.1:8188"></div>
      <div class="ubp-fieldrow"><span class="ubp-fieldlabel">跟随生图地址</span>${switchInputHtml(s.voiceComfy.useHostImageUrl, 'voiceComfyFollow')}</div>
      <div class="ubp-fieldrow column"><span class="ubp-fieldlabel">工作流 JSON${helpTip('在 ComfyUI 用「Save (API Format)」导出后整段粘贴。台词节点可写 %text% 占位符；保持原样时插件会自动把台词写入 TTS/克隆节点的 text 输入。')}</span>
        <textarea class="ubp-textarea" data-ubp-set="voiceComfyWorkflow" style="min-height:150px;font-family:monospace" placeholder='{"12":{"class_type":"LongCatVoiceCloneTTS","inputs":{"text":"%text%"}}}'>${escapeHtml(s.voiceComfy.workflow)}</textarea></div>
      <div class="ubp-set-note">每角色的参考音频（克隆音色）在上方「角色音色」里逐个上传。</div>`;
  }

  if (backend === 'system') return modeRow + `<div class="ubp-set-note">系统 TTS 用浏览器自带音色：免费、离线、无需密钥；音色一般，且拿不到音频文件（不进缓存、无失真滤镜）。音色在下方「角色音色」里逐人选。</div>`;
  return modeRow + `<div class="ubp-set-note">语音已关闭：不出声，也不建立任何后台开销。选「在线 API」或「系统 TTS」即可开启。</div>`;
}

/** 角色音色面板当前选中的角色（跨重绘记忆；失配时回落通讯录首位）。 */
let _voiceRoleSel = '';

/** 角色头像底色：名字稳定散列 → 色相（不读任何头像数据，零 IO）。 */
function roleAvatarStyle(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `background:hsl(${h}, 46%, 58%)`;
}

/** 角色音色的存储域：三种后端各一份（system / api / comfy）。 */
function voiceRoleScope(backend: string): 'system' | 'api' | 'comfy' {
  return backend === 'comfy' ? 'comfy' : backend === 'system' ? 'system' : 'api';
}

/** 该角色是否做过独立设置（下拉 ✓ 标记与面板徽标共用）。 */
function roleIsCustomized(s: PhoneSettings, scope: string, name: string): boolean {
  if (scope === 'comfy') return Boolean(s.voiceRefAudio?.[name]);
  if (scope === 'api' && roleProviderFor(name, s.voiceRoleProvider || {})) return true;
  return Boolean((s.voiceMap?.[scope as 'system' | 'api'] || {})[name]);
}

/** 「角色音色」次级折叠：先选角色 → 只呈现这一个角色的面板（渠道 / 音色 / 试听 / 当前生效）。
 *  旧版「每角色一行」在 40 人时是 40 行且行内挤爆（名字被压成竖排、音色下拉溢出屏幕）；
 *  本版面板高度与角色数无关。三种后端共用同一形状：api=指定厂商+音色 · system=浏览器音色 · comfy=参考音频。 */
function voiceRolesHtml(s: PhoneSettings, backend: string): string {
  if (backend === 'off') return '<div class="ubp-set-note">语音已关闭，无需选择音色。</div>';
  const meta = safeRosterMeta();
  if (!meta.length) return '<div class="ubp-set-note">通讯录暂无角色。</div>';
  const scope = voiceRoleScope(backend);
  const isComfy = scope === 'comfy';
  const isSystem = scope === 'system';
  const globalProvider = resolveProvider(s.voiceProvider);
  const roleProviders = s.voiceRoleProvider || {};
  const overrides = (s.voiceMap || {})[isSystem ? 'system' : 'api'] || {};
  const isSet = (n: string): boolean => roleIsCustomized(s, scope, n);

  const picked = meta.find(c => c.name === _voiceRoleSel) || meta[0];
  const name = picked.name;
  const setCount = meta.filter(c => isSet(c.name)).length;
  const customized = isSet(name);
  const pinOf = (n: string): string => String((s.voiceAutoPick || {})[n]?.v || '');
  const pinnedHere = pinOf(name);
  // 钉住但没手动设置过 = 自动分配的结果（按钮语义要说「重新分配」，不是「恢复」）
  const pinOnlyCount = meta.filter(c => !isSet(c.name) && Boolean(pinOf(c.name))).length;
  const reRollableCount = setCount + pinOnlyCount;
  const prof = picked.custom
    ? '自定义角色 · 数据库暂无档案'
    : ([picked.gender, picked.age, picked.languageStyle].filter(Boolean).join(' · ') || '无档案');

  const pickRow = `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">角色<span class="ubp-fieldhint">✓ = 已单独设置；未标记 = 跟随自动分配${setCount ? `（已设置 ${setCount} 人）` : ''}</span></span>
    <select class="ubp-select" data-ubp-set="voiceRolePick" style="max-width:100%;">
      ${meta.map(c => `<option value="${escapeAttr(c.name)}" ${c.name === name ? 'selected' : ''}>${isSet(c.name) ? '✓ ' : ''}${escapeHtml(c.name)}</option>`).join('')}
    </select></div>`;

  const head = `<div class="ubp-vrole-head">
    <span class="ubp-vrole-av" style="${roleAvatarStyle(name)}">${escapeHtml(name.slice(0, 1))}</span>
    <span class="ubp-vrole-who"><b>${escapeHtml(name)}</b><span>${escapeHtml(prof)}</span></span>
    ${customized ? '<span class="ubp-set-badge on">已单独设置</span>' : '<span class="ubp-set-badge off">跟随自动</span>'}
  </div>`;

  let rows = '';
  let eff = '';
  let foot = '';
  let note = '';

  if (isComfy) {
    const file = String(s.voiceRefAudio?.[name] || '');
    rows = `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">参考音频<span class="ubp-fieldhint">${file ? escapeHtml(file) : '未上传（留空用工作流内置默认）'}</span></span>
      <span class="ubp-vrole-btns">
        <button class="ubp-btn ubp-btn-sm" data-ubp-set-app="voice-ref" data-char="${escapeAttr(name)}">${file ? '更换' : '上传'}</button>
        ${file ? `<button class="ubp-btn ubp-btn-sm danger-quiet" data-ubp-set-app="voice-ref-clear" data-char="${escapeAttr(name)}">清除</button>` : ''}
      </span></div>`;
    eff = `<div class="ubp-vrole-eff"><span class="ubp-vrole-tag">当前生效</span><b>本地 ComfyUI</b> · ${file ? `参考音频 <b>${escapeHtml(file)}</b>` : '<span class="ubp-vrole-auto">工作流内置默认音色</span>'}</div>`;
    foot = `<div class="ubp-vrole-foot"><button class="ubp-btn ubp-btn-sm" data-ubp-set-app="voice-try" data-char="${escapeAttr(name)}">▷ 试听该角色</button></div>`;
    note = '<div class="ubp-vrole-note">本地克隆的「音色」就是每位角色的参考音频：一段 5–10 秒样本，克隆 TA 的声音。</div>';
  } else {
    const rolePid = roleProviderFor(name, roleProviders);
    const pid = isSystem ? 'system' : (rolePid || globalProvider.id);
    const pool = voicePoolFor(isSystem ? 'system' : 'api', pid);
    const cur = overrides[name] || '';
    // 「跟随自动」显示的实际取值：与资料卡那行、与播放同源（autoVoiceOf：钉住 → 自动分配 → 池首）
    const auto = autoVoiceOf(name, pid, pool, s.voiceAutoPick, bucketGenderOf(picked), s.voiceAutoAssign !== false);
    const labelOf = (id: string): string => pool.find(o => o.id === id)?.label || id || '';
    const autoLabel = labelOf(auto);
    const resolved = resolveSenderVoicePlan(name);
    const effVoice = resolved?.voiceId || '';
    const effLabel = labelOf(effVoice) || effVoice || '（无可选音色）';
    const effProvider = isSystem ? '系统 TTS' : resolveProvider(resolved?.providerId || pid).name;
    // 「怎么定的」：手填覆盖在本渠道生效才算手动；其余（自动分配 / 已钉住 / 空池未填）如实归类。
    // 注意不能用 effVoice === auto 判定——钉住后二者可能不同（池子变了，钉住值仍是旧的那一个）。
    const manualActive = Boolean(cur) && (!pool.length || pool.some(o => o.id === cur));
    const howLabel = effVoice ? (manualActive ? '手动指定' : '自动分配') : '未指定音色';
    const stale = !isSystem && Boolean(cur) && pool.length > 0 && !pool.some(o => o.id === cur);
    // 音色池为空（火山豆包 / 本地引擎 / 自定义：没有公开列表接口）→ 直接手填，不再显示「自动（无可选音色）」死路
    const canFetchRole = !isSystem && hasVoiceFetcher(pid);
    const voiceRow = pool.length
      ? `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">音色${helpTip('留「跟随自动」= 按性别 + 名字哈希稳定分配，结果会钉住（以后拉取音色列表/手填新音色都不会换声）；选了具体音色则固定不变。想重新分配点下方按钮。')}</span>
          <select class="ubp-select" data-ubp-set="voiceOverride" data-char="${escapeAttr(name)}" style="max-width:100%;">
            <option value="">跟随自动${autoLabel ? `「${escapeHtml(autoLabel)}」` : ''}</option>
            ${pool.map(o => `<option value="${escapeAttr(o.id)}" ${cur === o.id ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
          </select></div>`
      : `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">音色<span class="ubp-fieldhint">${canFetchRole ? '这家的音色池还是空的' : '这家没有公开音色列表 → 直接手填音色 id'}</span></span>
          <input class="ubp-fieldinput" data-ubp-set="voiceOverrideManual" data-char="${escapeAttr(name)}" value="${escapeAttr(cur)}" placeholder="控制台复制的音色 id">
          ${canFetchRole ? `<div class="actions"><button class="ubp-btn ubp-btn-sm" data-ubp-set-app="voice-role-catalog-fetch" data-char="${escapeAttr(name)}">拉取音色列表</button></div>` : ''}
          <div class="ubp-vrole-note">留空 = 不带音色 id（服务端用默认音色，可能每次不同）；也可以手填一个音色 id 固定下来。</div></div>`;
    rows = (isSystem ? '' : `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">渠道${helpTip('不同角色可以来自不同厂商；换渠道会清掉这个角色的音色选择与自动分配结果，避免把别家的音色 id 发过去。')}</span>
        <select class="ubp-select" data-ubp-set="voiceRoleProvider" data-char="${escapeAttr(name)}" style="max-width:100%;">
          <option value="" ${rolePid ? '' : 'selected'}>跟随全局（${escapeHtml(globalProvider.name)}）</option>
          ${VOICE_PROVIDERS.map(p => `<option value="${escapeAttr(p.id)}" ${rolePid === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select></div>`) + voiceRow;
    eff = `<div class="ubp-vrole-eff"><span class="ubp-vrole-tag">当前生效</span><b>${escapeHtml(effProvider)}</b> · <b>${escapeHtml(effLabel)}</b> <span class="ubp-vrole-auto">（${howLabel}）</span></div>`;
    const resetBtn = customized
      ? `<button class="ubp-vrole-quiet danger" data-ubp-set-app="voice-role-reset" data-char="${escapeAttr(name)}">恢复自动</button>`
      : pinnedHere
        ? `<button class="ubp-vrole-quiet" data-ubp-set-app="voice-role-reset" data-char="${escapeAttr(name)}">重新分配</button>`
        : '';
    foot = `<div class="ubp-vrole-foot">
      <button class="ubp-btn ubp-btn-sm" data-ubp-set-app="voice-try" data-char="${escapeAttr(name)}">▷ 试听该角色</button>
      <span class="ubp-vrole-grow"></span>
      ${resetBtn}
    </div>`;
    if (stale) note += '<div class="ubp-vrole-warn">这个角色选的音色不属于当前渠道的音色池，已被忽略——请重新选一个，或把该音色加进「后端与接口 → 音色池」。</div>';
    if (picked.custom) note += '<div class="ubp-vrole-note">自定义联系人没有人物档案（不知道性别），自动分配只能从全部音色里挑一个；在这里手动选一个即可固定。</div>';
    if (!isSystem && !pool.length) note += canFetchRole
      ? `<div class="ubp-vrole-warn">「${escapeHtml(resolveProvider(pid).name)}」的音色池还是空的：点上面的「拉取音色列表」从账号带出音色——没有音色 id 时这次合成不会指定音色，服务端会用默认音色（可能每次不同），自动分配也无从钉住。</div>`
      : `<div class="ubp-vrole-warn">「${escapeHtml(resolveProvider(pid).name)}」没有公开的音色列表接口：在上面的「音色」里直接手填，或到「后端与接口 → 音色池」批量粘贴。</div>`;
  }

  const footAll = !isComfy && reRollableCount >= 2
    ? `<div class="ubp-vrole-all"><button class="ubp-vrole-quiet" data-ubp-set-app="voice-roles-reset-all">全部重新分配（${reRollableCount} 人）</button></div>`
    : '';
  return pickRow + `<div class="ubp-vrole-panel">${head}<div class="ubp-vrole-body">${rows}</div>${eff}${foot}</div>` + note + footAll;
}

function voiceSectionHtml(s: PhoneSettings): string {
  // 总开关坐折叠条（同「窥私」「不夜城」）；关闭时卡内不渲染任何语音配置（不是折叠，是不存在）
  const masterSwitch = switchInputHtml(s.voiceEnabled, 'voiceEnabled');
  if (!s.voiceEnabled) {
    return sectionHtml('feat-voice', '语音（TTS）',
      `<div class="ubp-set-note">语音已关闭：不出声，也不建立任何后台开销。聊天与通话里的语音条只保留文字转写（播放条置灰失效、情绪标签隐藏），
       发给 AI 的「情绪|演绎」标注要求整段不注入——<b>[语音] 消息本身照常生成</b>，只是不朗读。打开这枚开关后，语速 / 后端 / 角色音色 / 缓存才会出现。</div>`,
      masterSwitch,
      '语音总开关：把微信语音条变成真出声，并让模型逐句标注情绪与演绎。关闭时零开销——不建 AudioContext、不碰缓存、不发情绪提示词。');
  }
  // 开启态：老存档的 voiceBackend='off'（此前从未选过后端）在界面按「在线 API」呈现，避免出现空的选项
  const backend = s.voiceBackend === 'off' ? 'api' : s.voiceBackend;
  const provider = resolveProvider(s.voiceProvider);
  const modeLabel = backend === 'api' ? `API · ${provider.name}` : voiceBackendLabel(backend);
  const roleMeta = safeRosterMeta();
  const roleCount = roleMeta.length;
  const roleScope = voiceRoleScope(backend);
  const roleSetCount = roleMeta.filter(c => roleIsCustomized(s, roleScope, c.name)).length;
  const rolesBadge = backend === 'comfy'
    ? `${roleCount} 人 · ${roleSetCount} 人已上传`
    : `${roleCount} 人${roleSetCount ? ` · ${roleSetCount} 人已设置` : ''}`;

  const behavior =
    `<div class="ubp-fieldrow"><span class="ubp-fieldlabel">语速</span>
      <select class="ubp-select" data-ubp-set="voiceSpeed">${PHONE_VOICE_SPEEDS.map(v => `<option value="${v}" ${s.voiceSpeed === v ? 'selected' : ''}>${v}×</option>`).join('')}</select>
    </div>
    <div class="ubp-fieldrow"><span class="ubp-fieldlabel">自动分配音色${helpTip('按角色性别/年龄 + 名字哈希稳定选一个音色；关闭则该后端只用默认音色。可在下方「角色音色」里逐人覆盖。')}</span>${switchInputHtml(s.voiceAutoAssign, 'voiceAutoAssign')}</div>
    <div class="ubp-fieldrow"><span class="ubp-fieldlabel">情绪演绎${helpTip('让模型给每句台词标「情绪|演绎」，插件按服务商自动改写：固定枚举的家只取情绪，支持自由文本的家把「情绪，演绎」合并成描述发出。关闭则完全不标情绪。')}</span>${switchInputHtml(s.voiceEmotion, 'voiceEmotion')}</div>
    <div class="ubp-fieldrow"><span class="ubp-fieldlabel">预合成最近语音${helpTip('进入聊天时先把最近几条语音合成好（仅 API/本地后端；会耗 TTS 额度）。')}</span>${switchInputHtml(s.voicePreGen, 'voicePreGen')}</div>
    <div class="ubp-fieldrow"><span class="ubp-fieldlabel">通话逐句朗读${helpTip('通话时对方每说一句就念出来（音色为该角色的音色）。')}</span>${switchInputHtml(s.voiceReadCalls, 'voiceReadCalls')}</div>
    <div class="ubp-fieldrow"><span class="ubp-fieldlabel">窥私隔墙失真${helpTip('窥私语音走低通 + 衰减，做偷听临场感（仅 API/本地后端有真实音频，系统 TTS 会自动降级）。')}</span>${switchInputHtml(s.voiceSpyMuffle, 'voiceSpyMuffle')}</div>`;

  // 第八轮 §1：缓存折叠只留「上限 + 清空」；浏览/管理与收藏管理整体移到桌面「录音机」APP
  const cache = `<div class="ubp-fieldrow"><span class="ubp-fieldlabel">缓存上限</span>
      <select class="ubp-select" data-ubp-set="voiceCacheMaxMB">${PHONE_VOICE_CACHE_MB.map(v => `<option value="${v}" ${s.voiceCacheMaxMB === v ? 'selected' : ''}>${v}MB</option>`).join('')}</select>
    </div>
    <div class="ubp-fieldrow"><span class="ubp-fieldlabel">语音缓存${helpTip('存在浏览器本地 IndexedDB，不占服务器磁盘、不随存档备份；超上限按最久未用淘汰。浏览与单条管理已移到桌面「录音机」的缓存页签。')}</span>
      <button class="ubp-btn" data-ubp-set-app="voice-cache-clear">清空</button></div>
    <div class="ubp-fieldrow"><span class="ubp-fieldlabel">语音收藏${helpTip('长按聊天里的语音条选「收藏语音」即可收藏。收藏与缓存分开保存：清缓存不会删收藏；浏览、播放、下载、删除都在「录音机」里。')}</span>
      <button class="ubp-btn" data-ubp-set-app="voice-fav-open">打开录音机</button></div>`;

  const body = `<div class="ubp-set-note">当前：${escapeHtml(modeLabel)} · 音色 ${roleCount} 人 · 缓存 ${s.voiceCacheMaxMB} MB</div>`
    + behavior
    + `<div class="ubp-set-note">语音收藏与缓存的浏览/管理已移到桌面「录音机」：${S('收藏可随时播放/下载，清缓存不影响收藏', '珍藏可随时播放/下载，清缓存不伤珍藏')}。</div>`
    + subSecHtml('voice-connect', '后端与接口', valBadge(modeLabel), voiceConnectHtml(s, backend))
    + subSecHtml('voice-roles', '角色音色', valBadge(rolesBadge), voiceRolesHtml(s, backend))
    + subSecHtml('voice-cache', '语音缓存', valBadge(`${s.voiceCacheMaxMB} MB`), cache);

  return sectionHtml('feat-voice', '语音（TTS）', body,
    masterSwitch,
    '把微信语音条变成真出声：系统 TTS / 在线 API（预填服务商）/ 本地 ComfyUI 克隆。配置是低频操作，收在「后端与接口」里。');
}

/** 「拉取音色列表」筛选条：按该家接口真正支持的维度渲染（Fish 语言/标签、MiniMax 音色类型、
 *  ElevenLabs 语言/类别/关键词）。没有可筛维度的家只出按钮。值落 voiceFetchFilters，随拉取请求一起发。 */
function voiceFetchBarHtml(s: PhoneSettings, providerId: string): string {
  const specs = voiceFilterSpecs(providerId);
  const applied = resolveVoiceFilters(providerId, (s.voiceFetchFilters || {})[providerId]);
  const rows = specs.map(spec => {
    const val = String(applied[spec.key] ?? '');
    const ctl = spec.options
      ? `<select class="ubp-select" data-ubp-set="voiceFetchFilter" data-vff="${escapeAttr(spec.key)}">
          ${spec.options.map(o => `<option value="${escapeAttr(o.value)}" ${val === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>`
      : `<input class="ubp-fieldinput" data-ubp-set="voiceFetchFilter" data-vff="${escapeAttr(spec.key)}" value="${escapeAttr(val)}" placeholder="${escapeAttr(spec.placeholder || '')}">`;
    return `<div class="ubp-fieldrow column"><span class="ubp-fieldlabel">${escapeHtml(spec.label)}${spec.hint ? helpTip(spec.hint) : ''}</span>${ctl}</div>`;
  }).join('');
  return `<div class="ubp-vfetch">
      ${rows}
      <div class="actions"><button class="ubp-btn" data-ubp-set-app="voice-catalog-fetch">拉取音色列表</button></div>
      <div class="ubp-set-note">拉回后弹出勾选清单，只有你选中的才会加入音色池（不会一次全塞进去）。</div>
    </div>`;
}

/** 拉取某家的音色列表 → **弹窗勾选** → 把勾选的并入 `voiceCatalog[该家]`（全局按钮与角色面板按钮共用；
 *  不传 providerId = 全局服务商）。不再「拉多少进多少」：一次可能回 100 条，全进池子会让自动分配
 *  从一百个里挑，且大半不是你要的。
 *  可分页的家（Fish / ElevenLabs）在列表尾部给「再拉一页」：新页追加、已勾不丢、拉尽收「已到底」；
 *  MiniMax 一次全量、无游标 ⇒ 该按钮不出现。 */
function runVoiceCatalogFetch(providerId?: string): void {
  const s = getPhoneSettings();
  const provider = resolveProvider(providerId || s.voiceProvider);
  const container = _ctx?.container;
  if (!container) return;
  const targetId = providerId ? provider.id : undefined;
  void (async () => {
    try {
      const first = await listProviderVoicesPage(targetId);
      if (!first.options.length) {
        phoneNotify(`没拉到音色（${provider.name}）：换个筛选条件再试`, '语音', 'warning');
        return;
      }
      // 已加载（含翻页追加）的音色：确认时按这份映射 id → 选项；标题/去重都读它
      const loaded = new Map<string, VoiceOption>();
      const pushLoaded = (options: VoiceOption[]): VoiceOption[] => {
        const fresh: VoiceOption[] = [];
        for (const o of options) {
          if (loaded.has(o.id)) continue;
          loaded.set(o.id, o);
          fresh.push(o);
        }
        return fresh;
      };
      pushLoaded(first.options);
      let cursor: string | undefined = first.next;
      const existing = parseManualVoices(String((getPhoneSettings().voiceCatalog || {})[provider.id] || ''));
      const have = new Set(existing.map(o => o.id));
      // 已在池中的默认勾上：确认一遍不会丢，也不会重复写入（按 id 去重）；翻页追加的项同口径。
      const toItem = (o: VoiceOption): { id: string; label: string; sub?: string; checked: boolean } =>
        ({ id: o.id, label: o.label, sub: o.desc, checked: have.has(o.id) });
      openPickerSheet(container, {
        title: () => `${provider.name} 音色（${loaded.size}）`,
        multi: true,
        selectAll: true,
        groups: [{
          key: provider.id,
          label: '勾选要加入音色池的',
          items: [...loaded.values()].map(toItem),
        }],
        extraAction: {
          label: () => '再拉一页',
          visible: () => Boolean(cursor),
          onAction: async () => {
            if (!cursor) return null;
            try {
              const nextPage = await listProviderVoicesPage(targetId, undefined, cursor);
              cursor = nextPage.next;
              return pushLoaded(nextPage.options).map(toItem);
            } catch (e) {
              // 翻页失败：如实提示、保留已勾与游标（按钮留在原地可重试）
              phoneNotify(e instanceof Error ? e.message : '拉取音色失败', `${provider.name} 音色列表`, 'error');
              return [];
            }
          },
        },
        searchPlaceholder: '搜索音色名/标签',
        confirmLabel: '加入音色池',
        emptyText: '这家没有可选的音色',
        onConfirm: (ids) => { void applyFetchedVoices(provider.id, [...loaded.values()], ids); },
      });
    } catch (e) {
      phoneNotify(e instanceof Error ? e.message : '拉取音色失败', `${provider.name} 音色列表`, 'error');
    }
  })();
}

/** 把勾选的音色并入该家音色目录（按 id 去重、保留池内既有行不覆盖；超上限截尾）。 */
async function applyFetchedVoices(providerId: string, fetched: VoiceOption[], pickedIds: string[]): Promise<void> {
  const pid = resolveProvider(providerId).id;
  const cur = String((getPhoneSettings().voiceCatalog || {})[pid] || '');
  const lines = cur.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const have = new Set(lines.map(l => (l.split('|')[0] || '').trim()));
  const byId = new Map(fetched.map(o => [o.id, o]));
  let added = 0;
  for (const id of pickedIds) {
    const v = byId.get(id);
    if (!v || have.has(id)) continue;
    lines.push(`${v.id}|${String(v.label).replace(/[|\r\n]/g, ' ')}|${v.gender}`);
    have.add(id);
    added++;
  }
  const next = { ...(getPhoneSettings().voiceCatalog || {}), [pid]: lines.join('\n').slice(0, VOICE_CATALOG_MAX) };
  await savePhoneSettings({ voiceCatalog: next });
  const name = resolveProvider(pid).name;
  phoneNotify(added ? `已加入 ${added} 个音色（${name}）` : `没有新增音色（${name}）`, '语音');
  render();
}

/** 保存当前服务商的凭据（按服务商分存，切服务商不丢 Key）。 */
function saveVoiceCred(patch: Partial<VoiceCredential>): void {
  const s = getPhoneSettings();
  const id = resolveProvider(s.voiceProvider).id;
  const next = { ...(s.voiceCredentials || {}) };
  next[id] = { ...(next[id] || {}), ...patch };
  void savePhoneSettings({ voiceCredentials: next });
}

/** 保存角色指定服务商（空 = 跟随全局）；换厂商时清掉该角色的音色覆盖与**钉住的自动结果**
 *  （音色 id 是按渠道命名的，钉住值换渠道即作废；一并清掉才会按新渠道重新分配）。 */
function saveVoiceRoleProvider(name: string, providerId: string): void {
  const s = getPhoneSettings();
  const nextP = { ...(s.voiceRoleProvider || {}) };
  if (providerId) nextP[name] = providerId; else delete nextP[name];
  const nextMap = { system: { ...s.voiceMap.system }, api: { ...s.voiceMap.api } };
  delete nextMap.api[name];
  const nextPick = { ...(s.voiceAutoPick || {}) };
  delete nextPick[name];
  void savePhoneSettings({ voiceRoleProvider: nextP, voiceMap: nextMap, voiceAutoPick: nextPick }).then(() => render());
}

/** 保存角色音色手动覆盖（空 = 删除覆盖，回到自动分配）。 */
function saveVoiceOverride(scope: 'system' | 'api', name: string, voiceId: string): Promise<void> {
  const s = getPhoneSettings();
  const next = { system: { ...s.voiceMap.system }, api: { ...s.voiceMap.api } };
  if (voiceId) next[scope][name] = voiceId;
  else delete next[scope][name];
  return savePhoneSettings({ voiceMap: next }).then(() => undefined);
}

/** 上传角色参考音频到 ComfyUI（声音克隆用）；文件名写回 voiceRefAudio。 */
function openVoiceRefImport(charName: string): void {
  const url = resolveComfyUrl(getPhoneSettings().voiceComfy);
  if (!url) { phoneNotify('请先填写 ComfyUI 地址（或勾选跟随生图地址）', '语音', 'warning'); return; }
  const doc = hostDocument();
  const input = doc.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    const stem = `${charName || 'ref'}_${Date.now().toString(36)}`;
    void uploadComfyAudio(url, file, stem).then(name => {
      void savePhoneSettings({ voiceRefAudio: { ...getPhoneSettings().voiceRefAudio, [charName]: name } })
        .then(() => { phoneNotify(`已上传「${charName}」参考音频：${name}`); render(); });
    }).catch((e: unknown) => {
      phoneNotify(String((e as Error)?.message || e), '参考音频上传失败', 'error');
    });
  });
  doc.body.appendChild(input);
  input.click();
}

/** 功能页「正文互通」折叠卡：卡内灰字大白话分工提示 + 消息记录注入世界书 + 正文联动。
 *  折叠态摘要「注入 开/关 · 联动 开/关」——两个独立开关塞进 46px 摘要行会互相挤压，故摘要只给状态概览。 */
function storyBridgeSectionHtml(s: PhoneSettings): string {
  const st = getPhoneMessageWorldbookStatus();
  const wbBadge = worldbookBadge(st);
  const wbNote = !st.enabled ? '' : tokenNoteHtml('注入条数跟随「手机记录条数」（功能 → 聊天上下文）：', s.phoneHistoryCount);
  // 第五轮 ⑦：勾选哪些平台，正文里就允许出现哪些平台的社媒动态（提示词按勾选拼装；
  // 取消勾选会连渲染正则一起撤掉——勾选就是闸门）。
  const socialChips = STORY_LINK_SOCIAL_KINDS.map(kind => {
    const on = s.storyLinkSocial.includes(kind);
    return `<button type="button" class="ubp-chip${on ? ' on' : ''}" data-ubp-set-app="story-social" data-kind="${escapeAttr(kind)}">${escapeHtml(storyLinkSocialLabel(kind))}</button>`;
  }).join('');
  const storySub = !s.storyLink ? '' : `
      <div class="ubp-fieldrow column">
        <span class="ubp-fieldlabel">正文里的社媒${helpTip('勾选哪些平台，正文里就允许出现哪些平台的动态（朋友圈/贴吧/微博/小红书按当前风格换名）。未勾选的平台既不教格式、也不渲染、也不收进手机。')}</span>
        <div class="ubp-chips">${socialChips}</div>
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">格式条目<span class="ubp-fieldhint-inline">注入当前角色主世界书（蓝灯常亮）</span></span>
        ${storyEntryBadge(_storyStatus)}
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">渲染正则<span class="ubp-fieldhint-inline">酒馆全局显示正则（微信/通话/勾选的社媒）</span></span>
        ${storyRegexBadge(_storyStatus)}
      </div>
      <div class="ubp-fieldrow">
        <button class="ubp-btn" data-ubp-set-app="story-inject" style="flex:1;">立即注入 / 修复</button>
      </div>`;
  const body = `
      <div class="ubp-set-sec-sub">想让正文读到小手机消息，就打开「消息记录注入世界书」；想让正文里出现微信和通话，就打开「正文联动」。</div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">消息记录注入世界书${helpTip('开启后，正文读到某个角色时会带上 TA 最近的手机记录（微信/通话/朋友圈/社媒）。私密交流不会让其他人知道。')}</span>
        ${wbBadge}
        ${switchInputHtml(s.messageWorldbook, 'messageWorldbook')}
      </div>
      ${wbNote}
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">正文联动${helpTip('开启后，AI 在正文里写出的微信/通话片段会在酒馆渲染成微信气泡，并自动收进小手机。与主角无关的角色间消息不进小手机；群聊会话暂不支持。')}</span>
        ${switchInputHtml(s.storyLink, 'storyLink')}
      </div>
      ${storySub}`;
  return sectionHtml('feat-bridge', '正文互通', body,
    valBadge(`注入 ${s.messageWorldbook ? '开' : '关'} · 联动 ${s.storyLink ? '开' : '关'}`),
    '两条通道各管一段：一条让正文读到手机里的消息，一条让正文里的微信/通话渲染成气泡并收进手机。');
}

function describeImageProvider(p: PortraitImageGen): string {
  // 插件通道（生图整体转交对应插件）：模型/地址/密钥全在插件里配，主项目侧配置不参与
  if (p.openai?.chatu8 === true) return '智慧姬（st-chatu8）';
  if (p.openai?.baibai === true) return '柏宝绘（ST-BaiBai-Image）';
  if (p.apiFormat === 'novelai') return `NovelAI · ${p.novelai.model || '默认模型'}`;
  if (p.apiFormat === 'openai') return `OpenAI 兼容 · ${p.openai.model || '默认模型'}`;
  return 'ComfyUI';
}

/** 通用页「字体」折叠组本体：字号分档滑杆（示例气泡实时预览）+ 字体族 chips。 */
function fontGroupBodyHtml(s: PhoneSettings): string {
  const idx = Math.max(0, PHONE_FONT_SCALES.indexOf(s.fontScale));
  const chip = (key: string, label: string, stack: string): string =>
    `<button type="button" class="ubp-chip${s.fontFamily === key ? ' on' : ''}" data-ubp-set-app="fontFamily" data-font="${escapeAttr(key)}"${stack ? ` style="font-family:${escapeAttr(stack)}"` : ''}>${escapeHtml(label)}</button>`;
  const chips = [
    chip('', '跟随风格', ''),
    ...Object.entries(PHONE_FONT_FAMILIES).map(([key, f]) => chip(key, f.label, f.stack)),
    // 用户字体（美化工坊上传）：引用键 u:<id>，chip 用字体本身预览
    ...s.fontLibrary.map(f => chip(`u:${f.id}`, f.name, `"${f.family}", sans-serif`)),
  ].join('');
  return `
        <div class="ubp-fieldrow column">
          <span class="ubp-fieldlabel">字体大小<span class="ubp-fieldhint" data-ubp-font-pct>${Math.round(s.fontScale * 100)}%</span></span>
          <div class="ubp-font-preview">
            <div class="ubp-msg-name">林晚</div>
            <div class="ubp-bubble">在忙吗？晚上一起吃饭吗？</div>
          </div>
          <div class="ubp-font-slider">
            <span class="ubp-font-slider-end">A</span>
            <input type="range" min="0" max="${PHONE_FONT_SCALES.length - 1}" step="1" value="${idx}" data-ubp-set="fontScale">
            <span class="ubp-font-slider-end lg">A</span>
          </div>
        </div>
        <div class="ubp-fieldrow column">
          <span class="ubp-fieldlabel">字体</span>
          <div class="ubp-chips">${chips}</div>
        </div>
        ${noteHtml('拖动即时生效、松手保存；「跟随风格」用风格/皮肤默认字体。')}`;
}

/** 通用页「手机缩放」折叠组本体：整机缩放分档滑杆（拖动整机实时预览，松手保存）。
 *  滑杆样式复用字体档 .ubp-font-slider，零新增 CSS；即时预览与松手落盘同 handleInput。 */
function zoomGroupBodyHtml(s: PhoneSettings): string {
  const idx = Math.max(0, PHONE_ZOOM_SCALES.indexOf(s.phoneZoom));
  return `
        <div class="ubp-fieldrow column">
          <span class="ubp-fieldlabel">缩放大小<span class="ubp-fieldhint" data-ubp-zoom-pct>${Math.round(s.phoneZoom * 100)}%</span></span>
          <div class="ubp-font-slider">
            <span class="ubp-font-slider-end">小</span>
            <input type="range" min="0" max="${PHONE_ZOOM_SCALES.length - 1}" step="1" value="${idx}" data-ubp-set="phoneZoom">
            <span class="ubp-font-slider-end lg">大</span>
          </div>
        </div>
        ${noteHtml('拖动即时预览整机大小，松手保存；50%–120% 分档，100% 为原始大小（窄屏全屏模式下不生效）。')}`;
}

/** 功能页「相册」折叠卡：循环删除开关 + 最多保留数量（上限只约束未收藏图片）。
 *  改小上限/开启循环删除会立即按新上限清理并删服务器文件（不可恢复），故走二次确认（见 applyAlbumMax）。
 *  折叠态摘要：上限数值（中性徽标）+ 循环删除开关（开关进摘要即当前状态，不再另挂文字徽标）。 */
function albumSectionHtml(s: PhoneSettings): string {
  const body = `
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">循环删除${helpTip('开启后，图片超过上限时自动删掉最旧的非收藏图；关闭则不自动删除。收藏的图永不被自动删除。')}</span>
          ${switchInputHtml(s.albumCycleDelete, 'albumCycleDelete')}
        </div>
        ${numRow('最多保留图片数量', 'albumMaxEntries', s.albumMaxEntries, 10, 2000, '滚动窗口上限，只约束未收藏的图片（收藏的图片恒保留在前）。出厂默认 200，与旧版本固化值一致；调小会立即清理超出的最旧图片，不可恢复。')}
        ${s.albumCycleDelete ? '' : noteHtml('「循环删除」已关闭，上方数量暂不生效；重新开启时会按该数量立即清理一次。')}`;
  return sectionHtml('feat-album', '相册', body,
    valBadge(`上限 ${s.albumMaxEntries} 张`),
    '相册是本地滚动窗口：超出上限时自动删掉最旧的非收藏图片，收藏的图片恒保留。');
}

/** 功能页「网上商城」折叠卡（docs/52）：货架容量 / 每批上货。
 *  商城无总开关（App 常驻桌面）：浏览、AI 上货、购物车都不依赖主项目；
 *  只有「支付」依赖主项目货币系统（未启用时结算禁用并引导）。
 *  商品主图**无手机侧设置**（用户定案：那个「商品图预设」选项没有意义）——
 *  文字 API 与生图 API 一律照搬主项目「衣柜单品」那套（见 core/shop-images）。 */
function shopSectionHtml(s: PhoneSettings): string {
  const body = `
      <div class="ubp-set-sec-sub">AI 按当前世界观上货的购物 App：商品由 AI 生成，用主项目货币结算，下单自动记进备忘录，到货写进物品表。</div>
      ${numRow('物品上限', 'shopMaxItems', s.shopMaxItems, 20, 100, '货架保留的商品数上限。刷新是「追加」而不是清空重来——只在超出上限时淘汰最旧的商品；收藏与购物车里的商品不会被淘汰。')}
      ${numRow('每批上货', 'shopBatchSize', s.shopBatchSize, 4, 16, '每次点刷新时 AI 生成的新商品件数（生成免费，但会消耗一次文本 AI 请求）。')}
      ${noteHtml('商品主图（详情页点「看主图」按需生成）照搬主项目「衣柜单品」：文字 API 与生图 API 都跟随主项目那套设置。')}`;
  return sectionHtml('feat-shop', '网上商城', body,
    valBadge(`上限 ${s.shopMaxItems} · 每批 ${s.shopBatchSize}`),
    'AI 上货 + 主项目货币结算 + 备忘录 + 物品表入库。');
}

/** 功能页「窥私」折叠卡：角色间私密互动演绎（通话/私聊/群聊；只读围观）。
 *  轮数间隔/正文上下文/纪要总量三项目只读复用「世界演化」设置（用户定案，在此展示+提示，中性徽标不穿绿）。
 *  摘要右侧只放总开关：它才是这块的功能闸；自动生成等子开关退到卡内。 */
function spyGroupHtml(s: PhoneSettings): string {
  const st = getSpyWorldbookStatus();
  const wbBadge = worldbookBadge(st);
  const worldCfg = readWorldConfigSafe();
  const spyNote = !st.enabled ? '' : tokenNoteHtml('注入条数跟随上方「窥私记忆条数」：', s.spyHistoryCount);
  const body = `
      <div class="ubp-set-sec-sub">把通讯录角色之间的私密互动（通话 / 私聊 / 群聊）演绎出来，主角只能围观。总开关关掉后 App 仍在桌面，只是不再能生成。</div>
      ${numRow('焦点人数', 'spyFocusCount', s.spyFocusCount, 2, 10, '每次生成随机抽选的焦点角色数（自动排除主角与在场角色；可用人数不足则全部取用）。长按生成指定的人物不足此数时会从其余空闲角色随机补足；勾选「只用选中的人」时不补足')}
      ${numRow('期望生成内容数', 'spyContentCount', s.spyContentCount, 1, 6, '单次生成的最大块数（硬上限，也是提示词里的生成块数；想要更多内容请调高）。至少包含一块群聊（有焦点群聊则必须在其中发生，否则优先新建群）')}
      ${numRow('窥私记忆条数', 'spyHistoryCount', s.spyHistoryCount, 0, 100, '参考的窥私记录条数。世界书开启时随角色条目一同注入；关闭时改为把相关既有会话直接带进生成。0=不注入')}
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">窥私记录注入世界书${helpTip('开启后，正文读到角色时会带上 TA 的窥私记录。私聊/通话仅双方可知、群聊仅群内可知，主角不会知道。')}</span>
        ${wbBadge}
        ${switchInputHtml(s.spyWorldbook, 'spyWorldbook')}
      </div>
      ${spyNote}
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">自动生成${helpTip('AI 回复结束后按「演化轮数间隔」自动生成一版（短回复不触发）。只决定要不要自动生成——关掉后 App 内的手动生成照常可用，桌面图标也不受此开关影响。')}</span>
        ${switchInputHtml(s.spyAutoGen, 'spyAutoGen')}
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">演化轮数间隔${helpTip('复用主项目「世界演化」设置（只读），如需更改请到主项目。')}</span>
        ${valBadge(`${worldCfg.everyTurns} 轮`)}
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">世界演化层数${helpTip('复用主项目「世界演化」设置（只读），如需更改请到主项目。')}</span>
        ${valBadge(`${worldCfg.contextCount} 层`)}
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">纪要注入总量${helpTip('复用主项目「世界演化」设置（只读）；每焦点角色保底取含名纪要。')}</span>
        ${valBadge(`${worldCfg.chronicleTotal} 条`)}
      </div>
      <div class="ubp-fieldrow">
        <button class="ubp-btn danger-quiet" data-ubp-set-app="spy-clear" style="flex:1;">清空窥私数据</button>
      </div>`;
  return sectionHtml('feat-spy', '窥私', body,
    switchInputHtml(s.spyEnabled, 'spyEnabled'),
    '演绎通讯录角色之间的私密互动（通话/私聊/群聊），主角只能围观。');
}

/** 不夜城折叠组本体（docs/18 §17；分组底部常驻只读边界说明）。 */
function nightGroupBodyHtml(s: PhoneSettings): string {
  // 生图文字 API 的独立预设（沿用 API 页同源列表：主项目 customApiPresets）；仅开关开启时渲染下拉
  const imageApiRow = s.nightImageApi ? `
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">生图 API 预设${helpTip('主项目「设置 → API → 预设管理」里的预设。留空或该预设被删=跟随共用「生图（提示词）」预设（API 页）。')}</span>
        <select class="ubp-select" data-ubp-set="nightImageApiPresetId" style="max-width:100%;">
          <option value="" ${s.nightImageApiPresetId ? '' : 'selected'}>跟随「生图（提示词）」</option>
          ${listHostPresets().map(p => `<option value="${escapeAttr(p.id)}" ${s.nightImageApiPresetId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select>
      </div>` : '';
  return `
      ${noteHtml('尺度档按帖/按板块自选（板块各有自己的上限）；本机不再做全局屏蔽——不想看的内容请直接跳过。')}
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">图文比${helpTip('帖子带图的比例（「暗房」板块恒为每条必带）。')}</span>
        <select class="ubp-select" data-ubp-set="nightImageRatio">
          ${[50, 70, 90].map(v => `<option value="${v}" ${s.nightImageRatio === v ? 'selected' : ''}>${v}%${v === 70 ? '（默认）' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">默认揭示级${helpTip('新图默认停在哪一级：轮廓（模糊剪影）→ 局部（三区马赛克，逐区点开）→ 全图。')}</span>
        <select class="ubp-select" data-ubp-set="nightRevealDefault">
          <option value="0" ${s.nightRevealDefault === 0 ? 'selected' : ''}>轮廓（默认）</option>
          <option value="1" ${s.nightRevealDefault === 1 ? 'selected' : ''}>局部</option>
          <option value="2" ${s.nightRevealDefault === 2 ? 'selected' : ''}>全图</option>
        </select>
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">新图打码${helpTip('开=按「默认揭示级」打码（逐层点开），关=直接全图。改开关会把已有图重置到对应级。')}</span>
        ${switchInputHtml(s.nightMaskDefault, 'nightMaskDefault')}
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">生图 API 单独配置${helpTip('开启后，不夜城配图的提示词改用单独选择的预设；关闭则跟随「API → 生图」。仅影响提示词这一步。')}</span>
        ${switchInputHtml(s.nightImageApi, 'nightImageApi')}
      </div>${imageApiRow}
      ${numRow('内容保留上限（条）', 'nightMaxPosts', s.nightMaxPosts, 10, 80, '滚动窗口上限：超出后旧帖沉底淘汰（图片文件归相册管理，不受此数影响）')}
      ${numRow('触发随机人物数', 'nightTriggerContacts', s.nightTriggerContacts, 0, 10, '每次生成随机抽进正文扫描的通讯录人数（0=不注入）')}
      ${numRow('单场轮数上限', 'nightLiveRounds', s.nightLiveRounds, 1, 30, '一个直播间最多推进多少轮，达上限转「回看」')}
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">点单台${helpTip('直播间底部「点单」入口；关=只保留推进与打赏。')}</span>
        ${switchInputHtml(s.nightOrders, 'nightOrders')}
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">约会进程${helpTip('搭话里可发约见卡，一段一段推进（上限 6 段，同时只允许一个人在约）。')}</span>
        ${switchInputHtml(s.nightDates, 'nightDates')}
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">私密收藏夹需长按解锁${helpTip('开启后「我的→收藏夹」里的私密部分要长按 2 秒才展开（仅本次会话有效）。')}</span>
        ${switchInputHtml(s.nightFavLock, 'nightFavLock')}
      </div>
      ${promptEntryRow('night')}
      ${noteHtml('不夜城是单向的——只读正文与手机已有内容，不写世界书、不接入正文、不通知任何角色。')}`;
}

function render(preserveScroll = true): void {
  if (!_ctx) return;
  hideTip(); // 浮层挂在 shadow root 不会被 innerHTML 换掉，先收起防锚点失效
  if (isSkinStudioOpen()) return; // 美化工坊开着：整页重绘会连弹层一起清掉（异步就绪刷新等触发的渲染直接跳过）
  const container = _ctx.container;
  // 全量重绘会换掉滚动容器（.ubp-appbody 是 innerHTML 的一部分），先存 scrollTop 再恢复，
  // 否则每选一项设置滚动条就跳回顶部；切标签页时（preserveScroll=false）从顶部开始
  const prevBody = container.querySelector('.ubp-appbody');
  const prevScrollTop = preserveScroll ? prevBody?.scrollTop ?? 0 : 0;
  const s = getPhoneSettings();
  const store = phoneStoreStatus();
  const data = readPhoneData();
  const messageCount = data.conversations.reduce((sum, c) => sum + c.messages.length, 0);

  let bodyHtml = '';

  if (_tab === 'general') {
    const homeBg = readHomeBg();
    const lockBg = readLockBg();
    const style = data.style || '';
    // 皮肤下拉：三内置项 + 已导入自定义皮肤时追加「自定义」项
    const customDef = currentCustomSkin();
    const skinOptions = SKIN_OPTIONS.map(o =>
      `<option value="${o.id}" ${s.skin === o.id ? 'selected' : ''}>${o.label}</option>`).join('')
      + (customDef ? `<option value="custom" ${s.skin === 'custom' ? 'selected' : ''}>${escapeHtml(customDef.name || '自定义')}</option>` : '');
    // 摘要徽标取值（折叠态也要看得见当前配置）
    const styleLabel = (STYLE_OPTIONS.find(o => o.id === style)?.label || '现代（默认）').replace('（默认）', '');
    const skinLabel = s.skin === 'custom'
      ? (customDef?.name || '自定义')
      : (SKIN_OPTIONS.find(o => o.id === s.skin)?.label || '默认');
    const appearanceBody = `
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">深浅色模式</span>
          <select class="ubp-select" data-ubp-set="darkMode">
            <option value="auto" ${s.darkMode === 'auto' ? 'selected' : ''}>跟随主项目</option>
            <option value="light" ${s.darkMode === 'light' ? 'selected' : ''}>浅色</option>
            <option value="dark" ${s.darkMode === 'dark' ? 'selected' : ''}>深色</option>
          </select>
        </div>
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">风格（当前聊天）${helpTip(S('按聊天适配世界观：现代 / 仙侠·玄青 / 武侠·惊堂 / 西幻·纹章', '一部玉简一个世界：现代 / 仙侠·玄青 / 武侠·惊堂 / 西幻·纹章', '一部天机匣一个江湖：现代 / 仙侠·玄青 / 武侠·惊堂 / 西幻·纹章', '一颗水晶一个王国：现代 / 仙侠·玄青 / 武侠·惊堂 / 西幻·纹章'))}</span>
          <select class="ubp-select" data-ubp-set="phoneStyle">
            ${STYLE_OPTIONS.map(o => `<option value="${o.id}" ${style === o.id ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">皮肤${helpTip('全局视觉换装：默认背景、桌面图标、时刻呈现、默认字体字号。与「风格」独立，可任意组合（皮肤优先，风格管名词/App 数量/提示词）。')}</span>
          <select class="ubp-select" data-ubp-set="skin">${skinOptions}</select>
        </div>
        <div class="ubp-fieldrow" data-ubp-set-app="skin-studio" style="cursor:pointer;">
          <span class="ubp-fieldlabel">美化工坊${helpTip('可视化自定义外观：逐个换图标、调网格与图标大小、色板一键换肤、上传字体、写自定义 CSS，并可导出 JSON 分享。所有改动即时生效。')}</span>
          <span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span>
        </div>
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">导入皮肤 JSON${helpTip('选择皮肤 JSON 文件（旧版裸皮肤或新版外观包均认）：导入即应用并出现在上方「皮肤」下拉；重复导入=替换。可视化编辑请用「美化工坊」。')}</span>
          <button class="ubp-btn" data-ubp-set-app="skin-import" style="flex:none;">选择文件…</button>
        </div>
        <div class="ubp-fieldrow" data-ubp-set-app="home-bg" style="cursor:pointer;">
          <span class="ubp-fieldlabel">主界面背景${helpTip(S('手机桌面的壁纸：从相册选择，或导入本地图片（自设壁纸优先于皮肤默认背景）', '桌面底图：从影阁选取，或导入本地图片（自设底图优先于皮肤默认）', '天机匣桌面底图：从画匣选取，或收入本地图卷（自设底图优先于皮肤默认）', '水晶桌面底图：从画廊选取，或收入本地图卷（自设底图优先于皮肤默认）'))}</span>
          ${homeBg ? `<img class="ubp-homebg-thumb" src="${escapeAttr(homeBg)}" alt="">` : '<span class="ubp-homebg-thumb"></span>'}
          <span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span>
        </div>`;
    // I-3 声音与震动 / I-1 锁屏：默认值保守（键盘音默认关；锁屏默认关＝现状零变化）
    const volLabel = (v: number): string => (v === 0.4 ? '轻' : v === 0.7 ? '中' : '响');
    const delayLabel = (d: number): string => (d === 30 ? '30 秒' : d === 60 ? '1 分钟' : d === 120 ? '2 分钟' : d === 300 ? '5 分钟' : `${d} 秒`);
    const soundBody = `
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">提示音${helpTip('收到消息、发出消息、按下快门时的提示音。音是现场合成的，不占任何存储空间；关闭后完全不出声、也不会创建音频对象。')}</span>
          ${switchInputHtml(s.soundOn, 'soundOn')}
        </div>
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">提示音音量</span>
          <select class="ubp-select" data-ubp-set="soundVolume"${s.soundOn ? '' : ' disabled'}>
            ${PHONE_SOUND_VOLUMES.map(v => `<option value="${v}" ${s.soundVolume === v ? 'selected' : ''}>${volLabel(v)}</option>`).join('')}
          </select>
        </div>
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">键盘音${helpTip('聊天输入时每次按键的轻响。默认关闭——打字时每键都响是负担。')}</span>
          ${switchInputHtml(s.keyboardSound, 'keyboardSound')}
        </div>
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">震动${helpTip('收到消息与拍照时的轻微震动。iOS 浏览器不支持震动 API，该平台开关无效（不做兼容垫片）。')}</span>
          ${switchInputHtml(s.vibrateOn, 'vibrateOn')}
        </div>
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">AI 进行中通知常驻${helpTip('默认关；关闭时酒馆里的「AI 请求进行中」通知 3 秒自动隐去。灵动岛/收起浮球与卡内终止不受影响；生图/TTS 不在本轮统一范围。')}</span>
          ${switchInputHtml(s.aiNoticePersist, 'aiNoticePersist')}
        </div>`;
    const lockBody = `
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">锁屏${helpTip('手机「锁」起来：折叠超过设定时长后再展开，先显示锁屏（大时钟 + 未读通知堆叠），上滑解锁。默认关闭。')}</span>
          ${switchInputHtml(s.lockScreenEnabled, 'lockScreenEnabled')}
        </div>
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">折叠后多久上锁</span>
          <select class="ubp-select" data-ubp-set="lockScreenDelaySec"${s.lockScreenEnabled ? '' : ' disabled'}>
            ${PHONE_LOCK_DELAYS.map(d => `<option value="${d}" ${s.lockScreenDelaySec === d ? 'selected' : ''}>${delayLabel(d)}</option>`).join('')}
          </select>
        </div>
        <div class="ubp-fieldrow" data-ubp-set-app="lock-bg" style="cursor:pointer;">
          <span class="ubp-fieldlabel">锁屏壁纸${helpTip('锁屏背景图：从相册选择，或导入本地图片。空=默认深色渐变底。与「主界面背景」各自独立。')}</span>
          ${lockBg ? `<img class="ubp-lockbg-thumb" src="${escapeAttr(lockBg)}" alt="">` : '<span class="ubp-lockbg-thumb"></span>'}
          <span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span>
        </div>`;
    const aboutBody = `        ${hostCardHtml()}
        <div class="ubp-fieldrow column">
          <span class="ubp-setinfo">
            <b>瑟瑟小手机</b> ${escapeHtml(PHONE_VERSION)}<br>
            统一状态栏伴生插件 —— 数据/配置/AI 管线全部构建在主项目之上。<br>
            构建：${escapeHtml(PHONE_BUILD_TAG)}
          </span>
        </div>`;
    bodyHtml =
      `<div class="ubp-set-grouptitle">外观与显示</div>` +
      sectionHtml('gen-appearance', '外观', appearanceBody,
        valBadge(`${styleLabel} · ${skinLabel}`),
        '深浅色 / 风格 / 皮肤 / 壁纸。皮肤是全局视觉换装，风格按聊天适配世界观，两者独立可组合。') +
      sectionHtml('gen-fontzoom', '字体与缩放', fontGroupBodyHtml(s) + zoomGroupBodyHtml(s),
        valBadge(`字号 ${Math.round(s.fontScale * 100)}% · 缩放 ${Math.round(s.phoneZoom * 100)}%`),
        '全机字号与整机缩放：分档调节，拖动即时预览、松手保存。') +
      `<div class="ubp-set-grouptitle">声音与锁屏</div>` +
      sectionHtml('gen-sound', '声音与震动', soundBody,
        valBadge(s.soundOn ? `提示音 · ${volLabel(s.soundVolume)}` : '提示音已关闭'),
        '提示音、键盘音与震动。音为现场合成，不占存储；全部关闭时零开销。') +
      sectionHtml('gen-lock', '锁屏', lockBody,
        valBadge(s.lockScreenEnabled ? `折叠 ${delayLabel(s.lockScreenDelaySec)} 后上锁` : '关闭'),
        '折叠手机后超过设定时长，再展开时先显示锁屏（大时钟 + 未读通知），上滑解锁。') +
      `<div class="ubp-set-group">
        <div class="ubp-fieldrow" data-ubp-set-app="my-avatar" style="cursor:pointer;">
          ${avatarHtml(PROTAGONIST_AVATAR_KEY, '', true, '我')}
          <span class="ubp-fieldlabel">我的头像${helpTip('聊天中「我」的头像：默认用主项目主角立绘，也可从图库选择或导入本地图片')}</span>
          <span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span>
        </div>
      </div>` +
      `<div class="ubp-set-grouptitle">关于</div>` +
      sectionHtml('gen-about', '关于瑟瑟小手机', aboutBody,
        valBadge(PHONE_VERSION),
        '版本与构建信息。') +
      // 悬浮球复位是主项目侧的操作入口，不属于「关于小手机」的自述，单独成行卡跟在卡片之后
      `<div class="ubp-set-group">
        <div class="ubp-fieldrow" data-ubp-set-app="reset-float" style="cursor:pointer;">
          <span class="ubp-fieldlabel">重置主项目悬浮按钮${helpTip('把主项目的悬浮球放回屏幕中间（拖出屏幕外时用）')}</span>
          <span class="ubp-set-sec-arrow">${ubpIcon('chevron')}</span>
        </div>
      </div>`;
  } else if (_tab === 'features') {
    const ctxBody = `
      ${numRow('剧情纪要数量', 'summaryCount', s.summaryCount, 0, 99, '资料块携带的完整纪要条数（从旧到新）；聊天/通话/朋友圈论坛共用，0=不带')}
      ${numRow('引用正文层数（聊天）', 'chatHistoryCount', s.chatHistoryCount, 0, 20, '聊天与通话资料块中的正文楼层数（仅AI回复，全量；0=不带）')}
      ${numRow('手机记录条数', 'phoneHistoryCount', s.phoneHistoryCount, 10, 100, '最近手机记录的条数上限（微信/通话/朋友圈/群聊混排）。私聊、群聊、通话与社媒反馈共用。')}
      ${numRow('群聊注入人数', 'groupTriggerCap', s.groupTriggerCap, 1, 10, '群聊成员超过上限时，触发注入只带被@者+随机补足至上限（@计入名额）')}
      <div class="ubp-fieldrow column">
        <span class="ubp-fieldlabel">生成要求${helpTip('拼进每次聊天生成指令（如「多用表情包语气」）')}</span>
        <textarea class="ubp-textarea" data-ubp-set="extraPrompt" placeholder="（可选）">${escapeHtml(s.extraPrompt)}</textarea>
      </div>`;
    const socialBody = `
      <div class="ubp-set-sec-sub">朋友圈 · 贴吧 · 微博 · 小红书 四个平台共用下面这些设置；社媒为手动刷新（点各 App 右上角刷新生成一版新内容）。</div>
      ${numRow('内容保留上限（帖）', 'socialMaxPosts', s.socialMaxPosts, 10, 80, '四个平台共享的滚动窗口上限：超出后旧帖沉底淘汰（图片文件由相册统一管理，不受此数影响）')}
      ${numRow('触发随机人物数', 'socialTriggerContacts', s.socialTriggerContacts, 0, 10, '朋友圈/贴吧/微博/小红书刷新与跨平台「求回应」触发注入携带的通讯录随机人物名数量（0=不注入）；四平台共享')}
      ${numRow('引用正文层数（社媒）', 'socialHistoryCount', s.socialHistoryCount, 0, 20, '刷新时资料块携带的最近正文楼层数（0=不带）')}
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">公共动态同步${helpTip('开启后，角色回复会知道世界上的公开动态（热搜与各平台公开帖）。会占用每轮提示词预算，默认关闭。')}</span>
        ${switchInputHtml(s.projectPublic, 'projectPublic')}
      </div>
      ${s.projectPublic ? noteHtml('每轮都会携带，粗估 ≈1000～1500 token/轮；不需要时请关闭。') : ''}
      ${promptEntryRow('social')}`;
    const promptEntryCard = `<div class="ubp-set-group">${promptEntryRow('all')}</div>`;
    const autoImageCard = `
      <div class="ubp-set-group">
        <div class="ubp-fieldrow">
          <span class="ubp-fieldlabel">自动生成图片${helpTip('所有生图场景共用这一个开关；关闭后保留占位，可点击逐张手动生成。生图后端与预设在「API」页配置。')}</span>
          ${switchInputHtml(s.autoImageGen, 'autoImageGen')}
        </div>
      </div>`;
    bodyHtml =
      `<div class="ubp-set-grouptitle">与主项目联动</div>` +
      storyBridgeSectionHtml(s) +
      `<div class="ubp-set-grouptitle">AI 生成</div>` +
      sectionHtml('feat-ctx', '聊天上下文', ctxBody,
        valBadge(`纪要 ${s.summaryCount} · 记录 ${s.phoneHistoryCount}`),
        'AI 聊天/通话携带的资料量与生成要求') +
      promptEntryCard +
      autoImageCard +
      voiceSectionHtml(s) +
      `<div class="ubp-set-grouptitle">APP</div>` +
      sectionHtml('feat-social', '社媒', socialBody,
        valBadge(`上限 ${s.socialMaxPosts} 帖`),
        '四个平台共用的内容量与生成指令入口。社媒为手动刷新：点各 App 右上角刷新生成一版新内容。') +
      spyGroupHtml(s) +
      sectionHtml('feat-night', '不夜城', nightGroupBodyHtml(s),
        valBadge(`图文比 ${s.nightImageRatio}% · 上限 ${s.nightMaxPosts}`),
        '不夜城是独立的成人向夜生活综合体（论坛 + 直播 + 搭话）：只根据正文与手机已有内容生成，不写世界书、不接入正文、不通知任何角色。') +
      shopSectionHtml(s) +
      `<div class="ubp-set-grouptitle">本地内容</div>` +
      albumSectionHtml(s);
  } else if (_tab === 'api') {
    const presets = listHostPresets();
    const hostState = hostConfigState();
    const hostDot = hostState === 'ready' ? dot('ok') : hostState === 'missing' ? dot('warn') : dot('err');
    const hostHint = hostState === 'ready'
      ? '预设仓库=主项目设置→API→预设管理（主项目配置已读取）'
      : hostState === 'missing'
        ? '未找到主项目偏好文件：预设列表为空，走酒馆主 API'
        : '主项目配置读取失败：预设列表为空，走酒馆主 API';
    const presetOptions = (emptyLabel: string, current: string): string =>
      [`<option value="" ${current === '' ? 'selected' : ''}>${emptyLabel}</option>`,
       ...presets.map(p => `<option value="${escapeAttr(p.id)}" ${current === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`),
      ].join('');
    const modeRow = `
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">API 分配${helpTip('选「全局独立」=所有功能共用一个预设；选「按功能单独设置」=各功能分别绑定，留空跟随全局。')}</span>
        <select class="ubp-select" data-ubp-set="apiMode">
          <option value="global" ${s.apiMode === 'global' ? 'selected' : ''}>全局独立 API</option>
          <option value="per-feature" ${s.apiMode === 'per-feature' ? 'selected' : ''}>按功能单独设置</option>
        </select>
      </div>`;
    const globalRow = s.apiMode === 'global' ? `
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">接口预设（全局）${helpTip(hostHint)}</span>
        <select class="ubp-select" data-ubp-set="apiPresetId" style="max-width:100%;">${presetOptions('酒馆主 API（默认）', s.apiPresetId)}</select>
      </div>` : '';
    // 自动重试（总开关仅 global 模式；per-feature 模式改为每个功能行右侧勾选）
    const retryTip = '请求失败时自动重试：只对网络类错误（限流 429 / 5xx / 超时 / 连接中断）与空响应重试；鉴权 401/403、参数 400、主动终止不重试。重试间隔 2 秒，重试进度显示在灵动岛与「AI 请求进行中」通知上。';
    const retryToggleRow = s.apiMode === 'global' ? `
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">自动重试${helpTip(retryTip)}</span>
        ${switchInputHtml(s.aiRetryEnabled, 'aiRetryEnabled')}
      </div>` : '';
    const retryMaxRow = numRow('最大重试次数', 'aiRetryMax', s.aiRetryMax, 1, 5, '失败后最多再试几次（总请求次数 = 该值 + 1）。默认 3 次。');
    const scopeRows = s.apiMode === 'per-feature' ? API_SCOPES.map(sc => `
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">${escapeHtml(sc.label)}${helpTip(`${sc.tip} ${hostHint}`)}</span>
        <select class="ubp-select" data-ubp-set="api-${sc.key}" style="flex:1;min-width:0;max-width:100%;">${presetOptions('跟随全局', s.apiScopes[sc.key])}</select>
        <label class="ubp-retry-check" title="该功能失败时自动重试"><input type="checkbox" data-ubp-set="ai-retry-${sc.key}" ${s.aiRetryScopes[sc.key] ? 'checked' : ''}>重试</label>
      </div>`).join('') : '';
    const textBody = modeRow + globalRow + retryToggleRow + retryMaxRow + scopeRows;

    const imageResolution = resolvePhoneImageConfig();
    const imageModeOptions = [
      `<option value="" ${s.imageMode ? '' : 'selected'}>请选择</option>`,
      ...IMAGE_MODES.map(m => {
        const miss = imageModeMissing(m.id);
        return `<option value="${escapeAttr(m.id)}" ${s.imageMode === m.id ? 'selected' : ''}>${escapeHtml(m.label)}${miss ? '（未配置）' : ''}</option>`;
      }),
    ].join('');
    // 插件通道直连（智慧姬/柏宝绘）：不需要也不允许选画风预设（预设的前后缀/负面/参数全部不生效，由插件接管）
    const pluginChannel = s.imageMode === 'chatu8' || s.imageMode === 'baibai';
    const pluginChannelLabel = s.imageMode === 'chatu8' ? '智慧姬' : '柏宝绘';
    const imagePresetOptions = pluginChannel
      ? `<option value="">— ${pluginChannelLabel}直连下不可选 —</option>`
      : [
        `<option value="" ${s.imagePresetId ? '' : 'selected'}>请选择</option>`,
        ...listHostImagePresets().map(p => `<option value="${escapeAttr(p.id)}" ${s.imagePresetId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`),
      ].join('');
    // 红字提醒（未选择/未配置/预设被删）；可用时展示当前生效组合摘要
    const imageHintRow = imageResolution.error || !imageResolution.provider
      ? `<div class="ubp-fieldrow column"><span class="ubp-fieldhint" style="color:var(--ubp-danger);">${escapeHtml(imageResolution.error || '生图配置不可用')}</span></div>`
      : `<div class="ubp-fieldrow column"><span class="ubp-fieldhint">${escapeHtml(`${describeImageProvider(imageResolution.provider)} · 预设：${pluginChannel ? `—（由${pluginChannelLabel}接管）` : imageResolution.presetName}`)}</span></div>`;
    const imageOk = !imageResolution.error && !!imageResolution.provider;
    const imgBody = `
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">生图模式${helpTip('使用主项目对应模式的完整配置；智慧姬/柏宝绘＝转交酒馆里的对应插件执行：智慧姬（st-chatu8）的地址/密钥/模型用智慧姬里配的那套；柏宝绘（ST-BaiBai-Image）的后端/模型/画师串/质量词/负面/尺寸全用其「渠道」页配置')}</span>
        <select class="ubp-select" data-ubp-set="imageMode">${imageModeOptions}</select>
      </div>
      <div class="ubp-fieldrow">
        <span class="ubp-fieldlabel">画风预设${helpTip('主项目提示词预设（前缀/后缀/负面词/参数）；插件通道（智慧姬/柏宝绘）直连下不需要也不生效')}</span>
        <select class="ubp-select" data-ubp-set="imagePresetId" style="max-width:100%;"${pluginChannel ? ' disabled' : ''}>${imagePresetOptions}</select>
      </div>
      ${pluginChannel ? `<div class="ubp-fieldrow column"><span class="ubp-fieldhint" style="color:var(--ubp-warn,var(--ubp-danger));">${pluginChannelLabel}直连下不需要画风预设：前后缀/负面词/参数由${pluginChannelLabel}接管；提示词格式（模式/输出语言/同人tag写法）与提示词写法跟随「提示词编辑」页（全局三项跟随主项目）。</span></div>` : ''}
      ${imageHintRow}`;
    bodyHtml =
      sectionHtml('api-text', `${hostDot}文本 API`, textBody, '', '小手机各 AI 功能（通话与聊天/社媒/窥私/生图提示词）的请求 API 来源。只替换请求所用的 API，不改变上下文内容与结构。') +
      sectionHtml('api-image', '生图', imgBody, badgeHtml(imageOk, '已配置', '未配置'),
        '选用主项目的生图后端与提示词预设（配置本体在主项目维护；智慧姬模式用智慧姬插件里配的那套）。聊天图片/朋友圈/贴吧/微博/小红书/窥私配图共用这一套生图配置。');
  } else {
    // 备份列表懒加载（首进存储页拉一次；操作后置 null 重载）
    if (!_backups) void loadBackups().then(() => { if (_ctx) render(); });
    const backups = _backups;
    const backupRows = !backups
      ? '<div class="ubp-set-note">备份列表加载中…</div>'
      : !backups.list.length
        ? '<div class="ubp-set-note">暂无备份（下次达到间隔层数时自动创建，或点「立即备份」）</div>'
        : backups.list.map(b => {
          const when = new Date(b.createdAt).toLocaleString();
          const size = b.bytes >= 1024 ? `${(b.bytes / 1024).toFixed(1)}KB` : `${b.bytes}B`;
          return `<div class="ubp-fieldrow" style="gap:6px;">
            <span class="ubp-fieldlabel" style="flex:1;min-width:0;">${escapeHtml(when)} · ${b.reason === 'auto' ? '自动' : '手动'} · 第${b.turns}层 · ${size}</span>
            <button class="ubp-btn ubp-btn-sm" data-ubp-set-app="backup-restore" data-file="${escapeAttr(b.file)}">恢复</button>
            <button class="ubp-btn ubp-btn-sm danger" data-ubp-set-app="backup-del" data-file="${escapeAttr(b.file)}"${backups.ready ? '' : ' disabled'}>删除</button>
          </div>`;
        }).join('');
    bodyHtml = `
      <div class="ubp-set-grouptitle">当前聊天存储</div>
      <div class="ubp-set-group">
        <div class="ubp-fieldrow column">
          <span class="ubp-setinfo">
            ${store.state === 'ready' ? dot('ok') : store.state === 'uninitialized' ? dot('warn') : dot('err')}
            <b>当前聊天存储</b><br>
            身份：${escapeHtml(store.storageId ? store.storageId.slice(0, 13) + '…' : '—')}<br>
            文件：${escapeHtml(store.filename || '—')}<br>
            会话 ${data.conversations.length} 个 · 消息 ${messageCount} 条<br>
            ${store.state === 'uninitialized' ? '（尚未写入过，首次发消息时创建文件）' : store.state === 'read-only' ? `只读：${escapeHtml(store.error || '')}` : ''}
          </span>
        </div>
      </div>
      <div class="ubp-set-grouptitle">备份快照</div>
      <div class="ubp-set-group">
        ${numRow('自动备份间隔', 'phoneBackupInterval', s.phoneBackupInterval, 1, 999, '每 N 层 AI 回复自动备份一次（会话/消息/相册/社媒/窥私）。恢复前会自动存一份安全快照。')}
        <div class="ubp-fieldrow">
          <button class="ubp-btn" data-ubp-set-app="backup-now" style="flex:1;"${backups?.ready ? '' : ' disabled'}>立即备份</button>
        </div>
        ${backupRows}
      </div>
      <div class="ubp-set-grouptitle">全局手机存储管理</div>
      <div class="ubp-set-group">
        <div class="ubp-fieldrow column">
          <span class="ubp-setinfo">浏览所有聊天的小手机数据文件，可整份恢复到当前聊天，或删除不用的聊天数据与备份。</span>
        </div>
        <div class="ubp-fieldrow">
          <button class="ubp-btn" data-ubp-set-app="storage-manage" style="flex:1;">打开存储管理</button>
        </div>
      </div>
      <div class="ubp-set-grouptitle">危险区</div>
      <div class="ubp-set-group danger">
        <div class="ubp-fieldrow column">
          <span class="ubp-setinfo">以下操作不可恢复，请谨慎使用。均会弹窗二次确认。</span>
        </div>
        <div class="ubp-fieldrow">
          <button class="ubp-btn danger" data-ubp-set-app="clear" style="flex:1;">清空当前聊天数据（保留备份）</button>
        </div>
        <div class="ubp-fieldrow">
          <button class="ubp-btn danger" data-ubp-set-app="reset" style="flex:1;">重置当前数据（含备份）</button>
        </div>
      </div>`;
  }

  const tabsHtml = SET_TABS.map(t =>
    `<button class="ubp-set-tab${_tab === t.id ? ' active' : ''}" data-ubp-set-app="tab" data-tab="${t.id}">${t.label}</button>`).join('');

  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-set-app="back" title="返回桌面">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">设置</span>
      <span style="width:32px;"></span>
    </div>
    <div class="ubp-set-tabs">${tabsHtml}</div>
    <div class="ubp-appbody">
      ${bodyHtml}
      <div style="height:20px;"></div>
    </div>`;
  const body = container.querySelector('.ubp-appbody');
  if (body) body.scrollTop = prevScrollTop;
}

/**
 * 提示词编辑器的保存回调：只原地刷新入口行徽标，**不整页重绘**。
 * 弹层挂在 .ubp-app 容器上，整页 render() 会连弹层一起清掉（存储/头像弹层的既有行为是「操作即关闭」，
 * 编辑器需要连续编辑多套，故走局部更新）。
 * 三个入口各算各的数：通用入口（无 scope）给社媒+生图+不夜城总数，社媒/不夜城卡内入口只给自己的领域数。
 */
function syncPromptBadge(): void {
  const badges = _ctx?.container.querySelectorAll('[data-ubp-prompt-badge]');
  if (!badges?.length) return;
  const s = getPhoneSettings();
  const total = promptCustomCount(s);
  const social = socialCustomCount(s);
  const night = nightCustomCount(s);
  badges.forEach(node => {
    const badge = node as HTMLElement;
    const count = badge.dataset.ubpPromptBadge === 'social'
      ? social
      : badge.dataset.ubpPromptBadge === 'night' ? night : total;
    badge.textContent = count ? `已自定义 ${count} 处` : '';
    badge.hidden = count === 0;
    badge.classList.toggle('on', count > 0);
  });
}
async function applyPatch(patch: Partial<PhoneSettings>): Promise<void> {
  await savePhoneSettings(patch);
  emitPhoneEvent('ubp-phone:theme-changed');
  render();
}

/**
 * 相册上限/循环删除变更：溢出条数 > 0 时二次确认（清理不可恢复），确认后落设置并按新上限立即清理。
 * 取消时 render 回滚控件显示态（输入框/开关已先被用户改动）——弹层先关、再落库、再重绘。
 */
function applyAlbumRetention(patch: Partial<PhoneSettings>, overflow: number, title: string, message: string): void {
  const finish = (): void => {
    void savePhoneSettings(patch).then(() => {
      const deleted = pruneAlbumOverflow();
      emitPhoneEvent('ubp-phone:data-changed');
      if (deleted) phoneNotify(`已按新上限清理 ${deleted} 张最旧的未收藏图片`);
      render();
    });
  };
  if (!overflow || !_ctx) { finish(); return; }
  openConfirmSheet(_ctx.container, {
    title,
    message,
    confirmLabel: '清理并应用',
    onConfirm: finish,
    onCancel: () => render(),
  });
}

/* ── 破坏性操作执行体（统一由确认弹窗 onConfirm 调用；弹层已先行关闭） ── */

/** f-b：清空/重置前的连带清理——删除本聊天引用的图片文件 + 手机自己写进主项目「备忘录」的行。
 *  必须在数据被清空**之前**调用（图片路径与备忘标题只能从当前数据里读出来）。best-effort：
 *  任一步失败都不阻断清空本身，返回计数供提示。 */
async function cleanupPhoneArtifacts(): Promise<{ files: number; memos: number }> {
  let files = 0;
  let memos = 0;
  try { files = await deletePhoneImageFiles(collectPhoneImagePaths()); } catch (_e) { /* best effort */ }
  try { memos = await deletePhoneMemosForChat(); } catch (_e) { /* best effort */ }
  return { files, memos };
}

/** 连带清理的提示后缀（无可报内容时为空串）。 */
function cleanupSuffix(c: { files: number; memos: number }): string {
  const parts = [c.files ? `${c.files} 张图片` : '', c.memos ? `${c.memos} 条主项目备忘` : ''].filter(Boolean);
  return parts.length ? `；另清理 ${parts.join('、')}` : '';
}

/** 清空当前聊天的小手机数据（保留备份快照，可回滚）。 */
async function doClearPhoneData(): Promise<void> {
  const cleaned = await cleanupPhoneArtifacts(); // 先清理（数据还在，才读得出路径与标题）
  const ok = await resetPhoneData();
  if (ok) {
    afterPhoneDataReplaced(); // 只有真清空了才派发刷新/投影收敛（失败时别把空数据投影进世界书）
    phoneNotify(`已清空当前聊天的小手机数据（备份快照保留，可恢复）${cleanupSuffix(cleaned)}`);
  } else {
    // F3：resetPhoneData 改成「先写盘成功才清内存」，所以这句「未改动」现在是真的
    phoneNotify('清空未完成：存储只读或网络异常，数据未改动（可稍后重试）', '清空数据', 'error');
  }
  render();
}

/** 重置当前数据（含本聊天备份快照，不可恢复）。 */
async function doResetPhoneData(): Promise<void> {
  const cleaned = await cleanupPhoneArtifacts();
  const report = await resetPhoneDataWithBackups();
  if (report.dataOk) {
    afterPhoneDataReplaced();
    _backups = null; // 备份列表已清空，重载快照
    phoneNotify((report.backupsDeleted
      ? `已重置当前聊天的小手机数据（含 ${report.backupsDeleted} 份备份快照）`
      : '已重置当前聊天的小手机数据') + cleanupSuffix(cleaned));
  } else {
    // F3：清数据失败时一份备份都不删（顺序已倒过来），所以「可回滚」也是真的
    phoneNotify('重置未完成：数据未改动，备份快照全部保留（可稍后重试）', '重置当前数据', 'error');
  }
  render();
}

/** 清空窥私记录（投影整族收敛为空）。 */
function doClearSpyData(): void {
  mutatePhoneData(clearSpyData);
  notifySpyRecordsChanged(); // 投影整族收敛为空（开关开启时）
  emitPhoneEvent('ubp-phone:data-changed');
  render();
}

/** 恢复指定备份到当前聊天。 */
async function doRestoreBackup(file: string): Promise<void> {
  const result = await restorePhoneBackup(file);
  if (result.ok) {
    afterPhoneDataReplaced();
    phoneNotify(result.warning ? '已恢复（备份索引更新失败，不影响数据）' : '备份已恢复到当前聊天');
  } else {
    phoneNotify(result.error === 'phone-restore-unconfirmed' && result.compensationFailed
      ? '恢复失败且回滚未确认，请勿重复操作，稍后检查数据'
      : `恢复失败：${result.error}`, '恢复备份', 'error');
  }
  _backups = null;
  render();
}

/** 删除指定备份快照（不可恢复）。 */
async function doDeleteBackup(file: string): Promise<void> {
  await deletePhoneBackup(file);
  _backups = null;
  render();
}

/**
 * 风格切换（跟聊天走）：落 PhoneChatData.style → 皮肤 class + 当前界面重渲染；
 * 世界书投影随签名（含 style）变化自动按新风格收敛；正文联动条目内容按风格重注入
 * （幂等，失败静默——设置页状态徽标可见）。
 */
async function applyStyleChange(style: PhoneStyle): Promise<void> {
  const prev = readPhoneDataRef().style || '';
  if (prev === style) return;
  mutatePhoneData(d => { d.style = style; });
  emitPhoneEvent('ubp-phone:theme-changed');
  notifyPhoneMessagesChanged();
  if (getPhoneSettings().storyLink) {
    void ensureStoryLinkInjection().catch(() => undefined);
  }
  refreshPhone();
  render();
}

/** 导入皮肤：文件选择 → 外观包/旧裸格式解析清洗（图片上传回图床、字体并入字体库）→ 落盘并立即应用。 */
function openSkinImport(): void {
  const doc = hostDocument();
  const input = doc.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    void file.text().then(async text => {
      const result = await importSkinFromText(text);
      phoneNotify(result.message, result.ok ? '导入皮肤' : '导入皮肤失败', result.ok ? 'info' : 'error');
      render();
    });
  });
  doc.body.appendChild(input);
  input.click();
}

function handleChange(event: Event): void {
  const target = event.target as HTMLElement;
  const key = (target as HTMLElement).dataset?.ubpSet;
  if (!key) return;
  const s = getPhoneSettings();
  switch (key) {
    case 'apiMode':
      void applyPatch({ apiMode: (target as HTMLSelectElement).value as PhoneApiMode });
      break;
    case 'apiPresetId':
      void applyPatch({ apiPresetId: (target as HTMLSelectElement).value });
      break;
    case 'api-chat':
    case 'api-social':
    case 'api-spy':
    case 'api-game':
    case 'api-night':
    case 'api-image': {
      const scope = key.slice(4) as PhoneApiScopeKey;
      void applyPatch({ apiScopes: { ...s.apiScopes, [scope]: (target as HTMLSelectElement).value } });
      break;
    }
    case 'aiRetryEnabled':
      void applyPatch({ aiRetryEnabled: (target as HTMLInputElement).checked });
      break;
    case 'aiRetryMax':
      void applyPatch({ aiRetryMax: clampNum((target as HTMLInputElement).value, 1, 5, s.aiRetryMax) });
      break;
    case 'aiNoticePersist':
      void applyPatch({ aiNoticePersist: (target as HTMLInputElement).checked });
      break;
    case 'ai-retry-chat':
    case 'ai-retry-social':
    case 'ai-retry-spy':
    case 'ai-retry-game':
    case 'ai-retry-night':
    case 'ai-retry-image': {
      const scope = key.slice('ai-retry-'.length) as PhoneApiScopeKey;
      void applyPatch({ aiRetryScopes: { ...s.aiRetryScopes, [scope]: (target as HTMLInputElement).checked } });
      break;
    }
    case 'imageMode':
      void applyPatch({ imageMode: (target as HTMLSelectElement).value as PhoneImageMode });
      break;
    case 'imagePresetId': // 插件通道（智慧姬/柏宝绘）直连下下拉已禁用；此处兜底拒绝（避免脚本改值绕过）
      if (getPhoneSettings().imageMode === 'chatu8' || getPhoneSettings().imageMode === 'baibai') return;
      void applyPatch({ imagePresetId: (target as HTMLSelectElement).value });
      break;
    case 'summaryCount':
      void applyPatch({ summaryCount: clampNum((target as HTMLInputElement).value, 0, 99, s.summaryCount) });
      break;
    case 'chatHistoryCount':
      void applyPatch({ chatHistoryCount: clampNum((target as HTMLInputElement).value, 0, 20, s.chatHistoryCount) });
      break;
    case 'socialHistoryCount':
      void applyPatch({ socialHistoryCount: clampNum((target as HTMLInputElement).value, 0, 20, s.socialHistoryCount) });
      break;
    case 'nightImageRatio': {
      const v = clampNum((target as HTMLSelectElement).value, 50, 90, s.nightImageRatio);
      void applyPatch({ nightImageRatio: (v === 50 || v === 90 ? v : 70) as 50 | 70 | 90 });
      break;
    }
    case 'nightRevealDefault': {
      const v = clampNum((target as HTMLSelectElement).value, 0, 2, s.nightRevealDefault);
      void applyPatch({ nightRevealDefault: (v === 1 || v === 2 ? v : 0) as 0 | 1 | 2 });
      break;
    }
    case 'nightMaxPosts':
      void applyPatch({ nightMaxPosts: clampNum((target as HTMLInputElement).value, 10, 80, s.nightMaxPosts) });
      break;
    case 'shopMaxItems':
      void applyPatch({ shopMaxItems: clampNum((target as HTMLInputElement).value, SHOP_MAX_ITEMS_RANGE[0], SHOP_MAX_ITEMS_RANGE[1], s.shopMaxItems) });
      break;
    case 'shopBatchSize':
      void applyPatch({ shopBatchSize: clampNum((target as HTMLInputElement).value, SHOP_BATCH_RANGE[0], SHOP_BATCH_RANGE[1], s.shopBatchSize) });
      break;
    case 'nightTriggerContacts':
      void applyPatch({ nightTriggerContacts: clampNum((target as HTMLInputElement).value, 0, 10, s.nightTriggerContacts) });
      break;
    case 'nightLiveRounds':
      void applyPatch({ nightLiveRounds: clampNum((target as HTMLInputElement).value, 1, 30, s.nightLiveRounds) });
      break;
    case 'nightMaskDefault':
      // 打码总开关联动：落设置后把已有图重置到对应级（core/night-images.nightResetAllReveals），
      // 关=全部图直接全图、开=回到「默认揭示级」——否则总开关只管新图、旧图钉在原地像坏了
      void applyPatch({ nightMaskDefault: (target as HTMLInputElement).checked }).then(() => nightSyncImageSettings());
      break;
    case 'nightImageApi':
      void applyPatch({ nightImageApi: (target as HTMLInputElement).checked });
      break;
    case 'nightImageApiPresetId':
      void applyPatch({ nightImageApiPresetId: (target as HTMLSelectElement).value });
      break;
    case 'nightOrders':
      void applyPatch({ nightOrders: (target as HTMLInputElement).checked });
      break;
    case 'nightDates':
      void applyPatch({ nightDates: (target as HTMLInputElement).checked });
      break;
    case 'nightFavLock':
      void applyPatch({ nightFavLock: (target as HTMLInputElement).checked });
      break;
    case 'albumCycleDelete': {
      const on = (target as HTMLInputElement).checked;
      if (!on) { void applyPatch({ albumCycleDelete: false }); break; }
      const over = albumOverflowCount(s.albumMaxEntries);
      applyAlbumRetention(
        { albumCycleDelete: true },
        over,
        `开启后会立即删除 ${over} 张图片`,
        '当前未收藏的图片已超过保留上限，开启循环删除会立刻删掉最旧的溢出图片（服务器文件一并删除），不可恢复；收藏的图片不受影响。',
      );
      break;
    }
    case 'albumMaxEntries': {
      const next = clampNum((target as HTMLInputElement).value, 10, 2000, s.albumMaxEntries);
      // 调大 / 循环删除关闭时不涉及删除，直接落设置
      if (next >= s.albumMaxEntries || !s.albumCycleDelete) {
        void applyPatch({ albumMaxEntries: next });
        break;
      }
      const over = albumOverflowCount(next);
      applyAlbumRetention(
        { albumMaxEntries: next },
        over,
        `立即删除 ${over} 张超出上限的图片？`,
        '会删除最旧的未收藏图片（服务器文件一并删除），不可恢复；收藏的图片不受影响。',
      );
      break;
    }
    case 'socialMaxPosts':
      void applyPatch({ socialMaxPosts: clampNum((target as HTMLInputElement).value, 10, 80, s.socialMaxPosts) });
      break;
    case 'socialTriggerContacts':
      void applyPatch({ socialTriggerContacts: clampNum((target as HTMLInputElement).value, 0, 10, s.socialTriggerContacts) });
      break;
    case 'groupTriggerCap':
      void applyPatch({ groupTriggerCap: clampNum((target as HTMLInputElement).value, 1, 10, s.groupTriggerCap) });
      break;
    case 'phoneHistoryCount':
      void applyPatch({ phoneHistoryCount: clampNum((target as HTMLInputElement).value, 10, 100, s.phoneHistoryCount) });
      break;
    case 'extraPrompt':
      void savePhoneSettings({ extraPrompt: (target as HTMLTextAreaElement).value.slice(0, 500) });
      break;
    case 'darkMode':
      void applyPatch({ darkMode: (target as HTMLSelectElement).value as PhoneDarkMode });
      break;
    case 'soundOn':
      void applyPatch({ soundOn: (target as HTMLInputElement).checked });
      break;
    case 'soundVolume':
      void applyPatch({ soundVolume: clampNum((target as HTMLSelectElement).value, 0, 1, s.soundVolume) });
      break;
    case 'keyboardSound':
      void applyPatch({ keyboardSound: (target as HTMLInputElement).checked });
      break;
    case 'vibrateOn':
      void applyPatch({ vibrateOn: (target as HTMLInputElement).checked });
      break;
    case 'lockScreenEnabled':
      void applyPatch({ lockScreenEnabled: (target as HTMLInputElement).checked });
      break;
    case 'lockScreenDelaySec':
      void applyPatch({ lockScreenDelaySec: clampNum((target as HTMLSelectElement).value, 0, 3600, s.lockScreenDelaySec) });
      break;
    // ─── 语音（TTS，第 31 篇）───
    case 'voiceBackend': {
      const next = (target as HTMLSelectElement).value as PhoneVoiceBackend;
      // 切到系统 TTS 时顺手预热一次音色池：浏览器 getVoices() 异步就绪，而池子为空会让首句走系统默认音
      // （同一通电话里「第一句男声、后面女声」即由此而来）。仅在用户显式开启时有这一次开销。
      if (next === 'system') { try { systemVoices(); } catch (_e) { /* ignore */ } }
      void applyPatch({ voiceBackend: next });
      break;
    }
    case 'voiceSpeed':
      void applyPatch({ voiceSpeed: clampNum((target as HTMLSelectElement).value, 0.5, 2, s.voiceSpeed) });
      break;
    case 'voiceAutoAssign':
      void applyPatch({ voiceAutoAssign: (target as HTMLInputElement).checked });
      break;
    case 'voiceEmotion':
      void applyPatch({ voiceEmotion: (target as HTMLInputElement).checked });
      break;
    case 'voiceProvider':
      void savePhoneSettings({ voiceProvider: (target as HTMLSelectElement).value.slice(0, 32) }).then(() => render());
      break;
    case 'voiceCredUrl':
      saveVoiceCred({ url: (target as HTMLInputElement).value.slice(0, 400) });
      break;
    case 'voiceCredKey':
      saveVoiceCred({ key: (target as HTMLInputElement).value.slice(0, 400) });
      break;
    case 'voiceCredAppId':
      saveVoiceCred({ appId: (target as HTMLInputElement).value.slice(0, 200) });
      break;
    case 'voiceCredAccessKey':
      saveVoiceCred({ accessKey: (target as HTMLInputElement).value.slice(0, 400) });
      break;
    case 'voiceCredModel':
      saveVoiceCred({ model: (target as HTMLInputElement).value.slice(0, 120) });
      break;
    case 'voiceCredFormat':
      saveVoiceCred({ format: (target as HTMLSelectElement).value === 'wav' ? 'wav' : 'mp3' });
      break;
    case 'voiceRolePick':
      // 仅切「在看哪个角色」——面板内容随之重绘；选择本身不落盘
      _voiceRoleSel = (target as HTMLSelectElement).value.slice(0, 64);
      render();
      break;
    case 'voiceOverride': {
      const char = (target as HTMLSelectElement).dataset.char || '';
      // 下拉改完要重绘：面板的「当前生效」与下拉 ✓ 标记都依赖它（手填输入框相反，见下）
      if (char) void saveVoiceOverride(s.voiceBackend === 'system' ? 'system' : 'api', char, (target as HTMLSelectElement).value).then(() => render());
      break;
    }
    case 'voiceOverrideManual': {
      // 音色池为空时的自由输入：不重绘（否则每敲一个字都丢焦点）；失焦/回车后由 change 落盘
      const char = (target as HTMLInputElement).dataset.char || '';
      if (char) saveVoiceOverride(s.voiceBackend === 'system' ? 'system' : 'api', char, (target as HTMLInputElement).value.trim().slice(0, 200));
      break;
    }
    case 'voiceRoleProvider': {
      const char = (target as HTMLSelectElement).dataset.char || '';
      if (char) saveVoiceRoleProvider(char, (target as HTMLSelectElement).value.slice(0, 32));
      break;
    }
    case 'voiceCatalogText': {
      // 纯文本态（「批量编辑」）：整段落盘（表格态不经过这里，走 saveVoiceCatalog）
      const pid = resolveProvider(s.voiceProvider).id;
      const next = { ...(s.voiceCatalog || {}) };
      const v = (target as HTMLTextAreaElement).value.slice(0, VOICE_CATALOG_MAX);
      if (v.trim()) next[pid] = v; else delete next[pid];
      void savePhoneSettings({ voiceCatalog: next });
      break;
    }
    case 'vpoolName':
    case 'vpoolId':
      // 编辑卡失焦提交：落盘但**不重绘**（紧随其后的那次点击要落在原控件上，见块首纪律③）
      commitVoicePoolEdit(false);
      break;
    case 'voiceFetchFilter': {
      // 拉取筛选条件：不重绘（否则每敲一个字都丢焦点）；失焦/回车后由 change 落盘
      const key = (target as HTMLElement).dataset.vff || '';
      const pid = resolveProvider(s.voiceProvider).id;
      if (!key || !voiceFilterSpecs(pid).some(spec => spec.key === key)) break;
      const cur = { ...(s.voiceFetchFilters || {}) };
      cur[pid] = { ...(cur[pid] || {}), [key]: (target as HTMLInputElement | HTMLSelectElement).value.slice(0, 128) };
      void savePhoneSettings({ voiceFetchFilters: cur });
      break;
    }
    case 'voicePreGen':
      void applyPatch({ voicePreGen: (target as HTMLInputElement).checked });
      break;
    case 'voiceReadCalls':
      void applyPatch({ voiceReadCalls: (target as HTMLInputElement).checked });
      break;
    case 'voiceSpyMuffle':
      void applyPatch({ voiceSpyMuffle: (target as HTMLInputElement).checked });
      break;
    case 'voiceCacheMaxMB':
      void applyPatch({ voiceCacheMaxMB: clampNum((target as HTMLSelectElement).value, 10, 500, s.voiceCacheMaxMB) });
      break;
    case 'voiceApiUrl':
      void savePhoneSettings({ voiceApi: { ...s.voiceApi, url: (target as HTMLInputElement).value.slice(0, 400) } });
      break;
    case 'voiceApiModel':
      void savePhoneSettings({ voiceApi: { ...s.voiceApi, model: (target as HTMLInputElement).value.slice(0, 120) } });
      break;
    case 'voiceApiVoices':
      void savePhoneSettings({ voiceApiVoices: (target as HTMLTextAreaElement).value.slice(0, 2000) });
      break;
    case 'voiceComfyUrl':
      void savePhoneSettings({ voiceComfy: { ...s.voiceComfy, url: (target as HTMLInputElement).value.slice(0, 400) } });
      break;
    case 'voiceComfyFollow':
      void savePhoneSettings({ voiceComfy: { ...s.voiceComfy, useHostImageUrl: (target as HTMLInputElement).checked } });
      break;
    case 'voiceComfyWorkflow':
      void savePhoneSettings({ voiceComfy: { ...s.voiceComfy, workflow: (target as HTMLTextAreaElement).value.slice(0, 400000) } });
      break;
    case 'fontScale': {
      // 松手落盘（拖动中的即时反馈走 handleInput）；applyChrome 经 theme-changed 统一收敛
      const idx = clampNum((target as HTMLInputElement).value, 0, PHONE_FONT_SCALES.length - 1, PHONE_FONT_SCALES.indexOf(1));
      void applyPatch({ fontScale: PHONE_FONT_SCALES[idx] });
      break;
    }
    case 'phoneZoom': {
      // 松手落盘（拖动中的即时反馈走 handleInput）；applyChrome 经 theme-changed 统一收敛+越界回拉
      const idx = clampNum((target as HTMLInputElement).value, 0, PHONE_ZOOM_SCALES.length - 1, PHONE_ZOOM_SCALES.indexOf(1));
      void applyPatch({ phoneZoom: PHONE_ZOOM_SCALES[idx] });
      break;
    }
    case 'phoneStyle':
      void applyStyleChange(normalizeStyleValue((target as HTMLSelectElement).value));
      break;
    case 'skin': {
      const value = (target as HTMLSelectElement).value as PhoneSettings['skin'];
      if (value === 'custom' && !currentCustomSkin()) {
        phoneNotify('尚未导入自定义皮肤：请先点「导入自定义皮肤」选择 JSON 文件');
        render(); // 回正下拉框（无效的 custom 不落盘）
        break;
      }
      void applyPatch({ skin: value });
      break;
    }
    case 'messageWorldbook': {
      const on = (target as HTMLInputElement).checked;
      void applyPatch({ messageWorldbook: on }).then(() => { handlePhoneMessageWorldbookToggle(on); refreshHostReadiness(); }); // 先落设置再接线：开=注册+强制首刷，关=经主项目调度整族清除；开关翻转改变投影门控 → 重算横幅
      break;
    }
    case 'projectPublic': {
      const on = (target as HTMLInputElement).checked;
      void applyPatch({ projectPublic: on }).then(() => handlePhonePublicProjectionToggle()); // 条目有无变了：清签名强制重投影（总开关关=只落设置）
      break;
    }
    case 'spyWorldbook': {
      const on = (target as HTMLInputElement).checked;
      void applyPatch({ spyWorldbook: on }).then(() => { handleSpyWorldbookToggle(on); refreshHostReadiness(); });
      break;
    }
    case 'spyAutoGen':
      void applyPatch({ spyAutoGen: (target as HTMLInputElement).checked });
      break;
    case 'spyFocusCount':
      void applyPatch({ spyFocusCount: clampNum((target as HTMLInputElement).value, 2, 10, s.spyFocusCount) });
      break;
    case 'spyContentCount':
      void applyPatch({ spyContentCount: clampNum((target as HTMLInputElement).value, 1, 6, s.spyContentCount) });
      break;
    case 'spyHistoryCount':
      void applyPatch({ spyHistoryCount: clampNum((target as HTMLInputElement).value, 0, 100, s.spyHistoryCount) });
      break;
    case 'storyLink':
      void handleStoryLinkToggle((target as HTMLInputElement).checked);
      break;
    case 'autoImageGen':
      void applyPatch({ autoImageGen: (target as HTMLInputElement).checked });
      break;
    case 'phoneBackupInterval':
      void applyPatch({ phoneBackupInterval: clampNum((target as HTMLInputElement).value, 1, 999, s.phoneBackupInterval) });
      break;
    default: break;
  }
}

function clampNum(value: string, min: number, max: number, fallback: number): number {
  return clampInt(Number(value), min, max, fallback); // 实现统一在 core/ubp-utils
}

// toggle 不冒泡，靠捕获阶段监听容器即可记录折叠组展开态
function handleToggle(event: Event): void {
  const details = event.target as HTMLDetailsElement;
  const id = details.dataset?.ubpSec;
  if (!id) return;
  if (details.open) _openSections.add(id);
  else _openSections.delete(id);
}

/** 字号滑杆拖动中（input 不落盘）：scope 变量即时生效，全机与示例气泡实时跟随；松手 change 才存档。 */
/** 分档滑杆拖动中（input 不落盘）：scope 变量即时生效——fontScale 缩文字、phoneZoom 缩整机，
 *  实时预览所见即所得；松手 change 才存档（handleChange 统一收敛）。 */
/** input 事件：字体/缩放滑杆的即时预览 + 音色池的搜索过滤与文本计数（都不重绘整页，免丢焦点）。 */
function handleInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  const key = target.dataset?.ubpSet;
  // 音色池搜索：只换行区（搜索框自身不动，光标不跳）
  if (key === 'vpoolQuery') {
    _vpoolQuery = target.value.slice(0, 64);
    _vpoolQueryPid = vpoolPid();
    refreshVoicePoolRows();
    return;
  }
  // 纯文本态：实时报「已识别 N 条 · 待修 M 行」（不落盘也不重绘——落盘走 change）
  if (key === 'voiceCatalogText') {
    refreshVoicePoolTextCount(target.value);
    return;
  }
  if ((key !== 'fontScale' && key !== 'phoneZoom') || !_ctx) return;
  const scales = key === 'fontScale' ? PHONE_FONT_SCALES : PHONE_ZOOM_SCALES;
  const idx = clampNum(target.value, 0, scales.length - 1, Math.max(0, scales.indexOf(1)));
  const scale = scales[idx] ?? 1;
  const scope = _ctx.shadow.querySelector('.ubp-scope') as HTMLElement | null;
  scope?.style.setProperty(key === 'fontScale' ? '--ubp-font-scale' : '--ubp-zoom', String(scale));
  const pct = _ctx.container.querySelector(key === 'fontScale' ? '[data-ubp-font-pct]' : '[data-ubp-zoom-pct]');
  if (pct) pct.textContent = `${Math.round(scale * 100)}%`;
}

/** 键盘：音色池编辑卡回车=完成、Esc=取消（触屏也可接实体键盘）；搜索框回车收起键盘。 */
function handleKeydown(event: KeyboardEvent): void {
  const el = event.target as HTMLElement;
  const key = el?.dataset?.ubpSet;
  if (key === 'vpoolName' || key === 'vpoolId') {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitVoicePoolEdit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      _vpoolEditKey = '';
      _vpoolErr = '';
      refreshVoicePoolCard();
    }
    return;
  }
  if (key === 'vpoolQuery' && event.key === 'Enter') {
    event.preventDefault();
    el.blur();
  }
}

/** 主界面壁纸：统一选图弹层 setting 档（文生图图库/手机相册 + 导入/恢复默认）。 */
function openWallpaperPicker(container: HTMLElement): void {
  const apply = (path: string): void => {
    if (path) setHomeBg(path);
    else clearHomeBg();
    refreshHome(); // 桌面可见时立即生效
    render();
    // L9 成就：设置主界面壁纸成功（恢复默认为清除，不计）
    if (path) emitAch('phone_wallpaper_set', { target: 'home' });
  };
  const current = readHomeBg();
  openImagePickerSheet(container, {
    mode: 'setting',
    title: '主界面背景',
    crop: { ratio: 0.52, slot: 'home', kind: 'bg', title: '壁纸' },
    current,
    currentText: '当前壁纸',
    defaultText: '默认渐变底',
    pickTip: '设为壁纸',
    emptyText: '相册还是空的——可导入本地图片作为壁纸',
    onPick: img => apply(img.path),
    onImport: path => apply(path),
    onCropAdjusted: () => { refreshHome(); render(); },
    ...(current ? { onReset: () => apply('') } : {}),
  });
}

/** 锁屏壁纸：统一选图弹层 setting 档（文生图图库/手机相册 + 导入/恢复默认）。 */
function openLockWallpaperPicker(container: HTMLElement): void {
  const apply = (path: string): void => {
    if (path) setLockBg(path);
    else clearLockBg();
    render();
    // L9 成就：设置锁屏壁纸成功（恢复默认为清除，不计）
    if (path) emitAch('phone_wallpaper_set', { target: 'lock' });
  };
  const current = readLockBg();
  openImagePickerSheet(container, {
    mode: 'setting',
    title: '锁屏壁纸',
    crop: { ratio: 0.52, slot: 'lock', kind: 'bg', title: '锁屏壁纸' },
    current,
    currentText: '当前壁纸',
    defaultText: '默认渐变底',
    pickTip: '设为锁屏壁纸',
    emptyText: '相册还是空的——可导入本地图片作为锁屏壁纸',
    onPick: img => apply(img.path),
    onImport: path => apply(path),
    ...(current ? { onReset: () => apply('') } : {}),
  });
}

async function handleClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement;
  // 「?」提示气泡：点按切换展示/收起（触屏无悬停，靠此开关；桌面移出即收，与主项目一致）；点其它位置收起
  const tipBtn = target.closest('span.ubp-tipbtn') as HTMLElement | null;
  if (tipBtn) {
    event.preventDefault(); // 在 summary 内时不触发折叠
    event.stopPropagation();
    if (_tipAnchor === tipBtn && _tipPop) hideTip();
    else showTip(tipBtn);
    return;
  }
  hideTip();
  // summary 行内开关：阻止 label 默认激活（会连动 details 折叠），手动翻转后走统一 patch
  const sw = target.closest('label.ubp-switch');
  if (sw && sw.closest('summary')) {
    event.preventDefault();
    const input = sw.querySelector('input');
    if (input) {
      input.checked = !input.checked;
      const key = input.dataset?.ubpSet || '';
      if (key === 'storyLink') void handleStoryLinkToggle(input.checked);
      else if (key === 'spyEnabled') void applyPatch({ spyEnabled: input.checked });
      else if (key === 'voiceEnabled') {
        // 开启时若从没选过后端（老存档的 off），补一个可用档位——否则界面会停在「后端模式」空选。
        const patch: Partial<PhoneSettings> = { voiceEnabled: input.checked };
        if (input.checked && getPhoneSettings().voiceBackend === 'off') patch.voiceBackend = 'api';
        void applyPatch(patch);
      }
      else void applyPatch({ [key]: input.checked } as Partial<PhoneSettings>);
    }
    return;
  }
  const el = target.closest('[data-ubp-set-app]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpSetApp || '';
  if (act === 'tab') {
    const next = SET_TABS.find(t => t.id === el.dataset.tab)?.id;
    if (next && next !== _tab) {
      _tab = next;
      if (next === 'storage') { _backups = null; } // 重进存储页重载备份列表
      render(false);
    }
  } else if (act === 'back') {
    _ctx?.closeApp();
  } else if (act === 'my-avatar') {
    if (_ctx) openAvatarPickerSheet(_ctx.container, PROTAGONIST_AVATAR_KEY, { title: '我的头像', onChanged: () => render() });
  } else if (act === 'home-bg') {
    if (_ctx) openWallpaperPicker(_ctx.container);
  } else if (act === 'lock-bg') {
    if (_ctx) openLockWallpaperPicker(_ctx.container);
  } else if (act === 'reset-float') {
    resetHostFloatBtn();
    phoneNotify('已重置主项目悬浮按钮');
  } else if (act === 'host-rematch') {
    void rematchHostFromSettings().then(rr => { phoneNotify(rr.ready ? '主项目已就绪' : '仍未就绪'); render(); });
  } else if (act === 'prompt-edit') {
    // data-domain：社媒卡内的入口定向到社媒域；通用入口留空走默认首屏
    if (_ctx) openPromptSheet(_ctx.container, syncPromptBadge, el.dataset.domain || undefined);
  } else if (act === 'skin-import') {
    openSkinImport();
  } else if (act === 'skin-studio') {
    if (_ctx) openSkinStudio(_ctx.container, () => render());
  } else if (act === 'fontFamily') {
    void applyPatch({ fontFamily: el.dataset.font || '' }); // ''=跟随风格（applyChrome 摘掉行内字体变量）
  } else if (act === 'clear') {
    if (_ctx) openConfirmSheet(_ctx.container, {
      title: '清空小手机数据？',
      message: '清空当前聊天的会话、消息、相册、社媒、窥私、通话与游戏记录。备份快照保留，可随时恢复。',
      confirmLabel: '清空',
      onConfirm: () => { void doClearPhoneData(); },
    });
  } else if (act === 'reset') {
    if (_ctx) openConfirmSheet(_ctx.container, {
      title: '重置当前数据？',
      message: '清空当前聊天的全部小手机数据，并删除本聊天的备份快照。此操作不可恢复。',
      confirmLabel: '重置',
      onConfirm: () => { void doResetPhoneData(); },
    });
  } else if (act === 'spy-clear') {
    if (_ctx) openConfirmSheet(_ctx.container, {
      title: '清空窥私数据？',
      message: '删除当前聊天的全部窥私记录。此操作不可恢复。',
      confirmLabel: '清空',
      onConfirm: doClearSpyData,
    });
  } else if (act === 'voice-catalog-fetch') {
    runVoiceCatalogFetch();
  } else if (act === 'vpool-text') {
    // 表格 → 纯文本（原界面，内容即当前存储的那份文本，原样呈现不做规范化）
    const pid = vpoolPid();
    if (!sealVoicePoolEdit()) return;
    _vpoolEditKey = '';
    _vpoolErr = '';
    _vpoolMode[pid] = 'text';
    refreshVoicePoolCard();
  } else if (act === 'vpool-table') {
    // 纯文本 → 表格：按行拆（认不出的行丢弃；有坏行先让用户拍板）
    const pid = vpoolPid();
    const text = (el.closest('[data-ubp-vpool]')?.querySelector('.ubp-vpool-textarea') as HTMLTextAreaElement | null)?.value ?? vpoolCatalog(pid);
    const applyText = (): void => {
      const rows = parseManualVoices(text);
      saveVoiceCatalog(pid, serializeVoicePool(rows));
      _vpoolMode[pid] = 'table';
      _vpoolEditKey = '';
      _vpoolErr = '';
      refreshVoicePoolCard();
      if (_ctx) showScreenToast(_ctx.container, `已从文本同步 ${rows.length} 条`);
    };
    const bad = vpoolBadLines(text);
    if (bad && _ctx) {
      openConfirmSheet(_ctx.container, {
        title: '有认不出的行',
        message: `有 ${bad} 行没读出音色 ID（形如「|名称」），保存会丢弃这些行。`,
        confirmLabel: '丢弃并保存',
        onConfirm: applyText,
      });
    } else applyText();
  } else if (act === 'vpool-edit') {
    const pid = vpoolPid();
    if (!sealVoicePoolEdit()) return;
    _vpoolErr = '';
    _vpoolEditKey = `${pid}#${Number(el.dataset.row ?? -1)}`;
    refreshVoicePoolCard(el.dataset.field === 'id' ? 'id' : 'name');
  } else if (act === 'vpool-add') {
    const pid = vpoolPid();
    if (!sealVoicePoolEdit()) return;
    _vpoolErr = '';
    _vpoolQuery = '';
    _vpoolQueryPid = pid;
    _vpoolEditKey = `${pid}#-1`;
    refreshVoicePoolCard('id');
  } else if (act === 'vpool-commit') {
    commitVoicePoolEdit(true);
  } else if (act === 'vpool-del') {
    const pid = vpoolPid();
    if (!sealVoicePoolEdit()) return;
    const i = Number(el.dataset.row ?? -1);
    const rows = vpoolRows(pid);
    const gone = rows[i];
    if (!gone) { _vpoolEditKey = ''; _vpoolErr = ''; refreshVoicePoolCard(); return; } // 新增卡上的删除 = 放弃
    rows.splice(i, 1);
    saveVoiceCatalog(pid, serializeVoicePool(rows));
    _vpoolEditKey = '';
    _vpoolErr = '';
    refreshVoicePoolCard();
    if (_ctx) {
      showScreenToast(_ctx.container, `已删除「${gone.label || gone.id}」`, {
        actionLabel: '撤销',
        onAction: () => {
          const cur = vpoolRows(pid);
          cur.splice(Math.min(i, cur.length), 0, gone);
          saveVoiceCatalog(pid, serializeVoicePool(cur));
          refreshVoicePoolCard();
        },
      });
    }
  } else if (act === 'vpool-top') {
    const pid = vpoolPid();
    if (!sealVoicePoolEdit()) return;
    const i = Number(el.dataset.row ?? -1);
    const rows = vpoolRows(pid);
    const row = rows[i];
    if (!row) return;
    rows.splice(i, 1);
    rows.unshift(row);
    saveVoiceCatalog(pid, serializeVoicePool(rows));
    _vpoolEditKey = '';
    _vpoolErr = '';
    refreshVoicePoolCard();
    if (_ctx) showScreenToast(_ctx.container, '已置顶：无匹配时默认用它');
  } else if (act === 'vpool-gender') {
    const pid = vpoolPid();
    if (!sealVoicePoolEdit()) return;
    const i = Number(el.dataset.row ?? -1);
    const rows = vpoolRows(pid);
    const row = rows[i];
    if (!row) return;
    const pick = el.dataset.g as VoiceGender | undefined;
    row.gender = pick === 'f' || pick === 'm' || pick === 'n' ? pick : (row.gender === 'f' ? 'm' : row.gender === 'm' ? 'n' : 'f');
    saveVoiceCatalog(pid, serializeVoicePool(rows));
    refreshVoicePoolCard();
    // 表格里点 chip 才提示（编辑卡里那排分段控件本身就是所见即所得，不必再弹）
    if (_ctx && el.classList.contains('ubp-vpool-g')) {
      showScreenToast(_ctx.container, `「${row.label || row.id}」性别 → ${vpoolGenderLabel(row.gender)}（自动分配按此分桶）`);
    }
  } else if (act === 'vpool-copy') {
    const rows = vpoolRows(vpoolPid());
    const id = rows[Number(el.dataset.row ?? -1)]?.id || '';
    if (id) void copyVoiceId(id);
  } else if (act === 'voice-role-catalog-fetch') {
    // 角色面板里对自己那家拉取：角色可以用「渠道」指定别家（如全局硅基流动 + 某角色 Fish），
    // 而「后端与接口」的音色池/拉取只作用于全局那家 —— 没有这个入口，那家的池子永远是空的（docs/38 §1 关卡 3 的可操作部分）。
    const char = el.dataset.char || '';
    const cur = getPhoneSettings();
    runVoiceCatalogFetch(roleProviderFor(char, cur.voiceRoleProvider || {}) || undefined);
  } else if (act === 'voice-cache-clear') {
    if (_ctx) openConfirmSheet(_ctx.container, {
      title: '清空语音缓存？',
      message: '删除本设备已合成的语音音频（浏览器本地 IndexedDB）。之后播放会重新合成（会耗 TTS 额度）。',
      confirmLabel: '清空',
      onConfirm: () => { void voiceCacheClear().then(() => { phoneNotify('语音缓存已清空'); render(); }); },
    });
  } else if (act === 'voice-ref') {
    openVoiceRefImport(el.dataset.char || '');
  } else if (act === 'voice-ref-clear') {
    const char = el.dataset.char || '';
    const next = { ...getPhoneSettings().voiceRefAudio };
    delete next[char];
    void savePhoneSettings({ voiceRefAudio: next }).then(() => render());
  } else if (act === 'voice-role-reset') {
    // 单角色「恢复自动 / 重新分配」：清掉音色覆盖、指定厂商**与钉住的自动结果**（不清钉就不会重新分配）
    const char = el.dataset.char || '';
    const cur = getPhoneSettings();
    const nextMap = { system: { ...cur.voiceMap.system }, api: { ...cur.voiceMap.api } };
    delete nextMap.system[char];
    delete nextMap.api[char];
    const nextP = { ...(cur.voiceRoleProvider || {}) };
    delete nextP[char];
    const nextPick = { ...(cur.voiceAutoPick || {}) };
    delete nextPick[char];
    void savePhoneSettings({ voiceMap: nextMap, voiceRoleProvider: nextP, voiceAutoPick: nextPick }).then(() => render());
  } else if (act === 'voice-roles-reset-all') {
    if (_ctx) openConfirmSheet(_ctx.container, {
      title: '全部重新分配？',
      message: '清除所有角色的音色手动选择、指定厂商与自动分配结果，然后按档案重新分配一遍。角色参考音频与语音缓存不受影响。',
      confirmLabel: '重新分配',
      onConfirm: () => {
        void savePhoneSettings({ voiceMap: { system: {}, api: {} }, voiceRoleProvider: {}, voiceAutoPick: {} }).then(() => render());
      },
    });
  } else if (act === 'voice-try') {
    const char = el.dataset.char || '';
    const plan = voicePlanFor('这是一段语音试听，用来确认音色。', char);
    if (!plan) { phoneNotify('请先把「语音后端」选为系统/API/本地', '语音试听', 'warning'); return; }
    stopVoice();
    playVoice({
      backend: plan.backend, cacheKey: plan.cacheKey, text: plan.text,
      voiceId: plan.voiceId, providerId: plan.providerId, refAudio: plan.refAudio, speed: plan.speed, emotion: plan.emotion, delivery: plan.delivery, role: plan.role,
      onState: (st, detail) => { if (st === 'error' && detail) phoneNotify(detail, '试听失败', 'error'); },
    });
  } else if (act === 'voice-fav-open') {
    // 第八轮 §1：收藏/缓存的浏览与管理归位到桌面「录音机」APP（设置页只留入口）
    _ctx?.openApp('recorder');
  } else if (act === 'voice-test') {
    const plan = voicePlanFor('这是一段语音试听，用来确认服务商与音色是否可用。', '我');
    if (!plan) { phoneNotify('请先把「后端模式」选为系统 / 在线 API / 本地', '语音测试', 'warning'); return; }
    stopVoice();
    playVoice({
      backend: plan.backend, cacheKey: plan.cacheKey, text: plan.text,
      voiceId: plan.voiceId, providerId: plan.providerId, refAudio: plan.refAudio, speed: plan.speed, emotion: plan.emotion, delivery: plan.delivery, role: plan.role,
      onState: (st, detail) => { if (st === 'error' && detail) phoneNotify(detail, '语音测试失败', 'error'); },
    });
  } else if (act === 'story-social') {
    const kind = el.dataset.kind || '';
    if (!(STORY_LINK_SOCIAL_KINDS as readonly string[]).includes(kind)) return;
    const cur = getPhoneSettings().storyLinkSocial;
    const next = normalizeStoryLinkSocial(cur.includes(kind as never) ? cur.filter(k => k !== kind) : [...cur, kind]);
    await savePhoneSettings({ storyLinkSocial: next });
    // 勾选集合变了 ⇒ 条目内容与渲染正则都要跟着重注入（ensure 内部按集合增删脚本）
    if (getPhoneSettings().storyLink) {
      try {
        await ensureStoryLinkInjection();
      } catch (e) {
        phoneNotify(String((e as Error)?.message || e), '社媒联动更新失败', 'error');
      }
    }
    await refreshStoryStatus();
    render();
  } else if (act === 'story-inject') {
    try {
      await ensureStoryLinkInjection();
      phoneNotify('正文联动注入完成');
    } catch (e) {
      phoneNotify(String((e as Error)?.message || e), '正文联动注入失败', 'error');
    }
    await refreshStoryStatus();
    render();
  } else if (act === 'backup-now') {
    const ok = await manualPhoneBackup();
    // L9 成就：玩家手动备份成功（自动备份走 MESSAGE_RECEIVED 通道，不经过此处）
    if (ok) emitAch('phone_backup_manual', {});
    if (ok) phoneNotify('备份完成');
    else phoneNotify('备份失败（存储只读或网络异常），请稍后重试', '备份', 'error');
    _backups = null;
    render();
  } else if (act === 'backup-restore') {
    const file = el.dataset.file || '';
    if (!file || !_ctx) return;
    openConfirmSheet(_ctx.container, {
      title: '恢复这份备份？',
      message: '将整份覆盖当前聊天的小手机数据；恢复前会自动存一份安全快照。',
      confirmLabel: '恢复',
      onConfirm: () => { void doRestoreBackup(file); },
    });
  } else if (act === 'backup-del') {
    const file = el.dataset.file || '';
    if (!file || !_ctx) return;
    openConfirmSheet(_ctx.container, {
      title: '删除这份备份？',
      message: '删除后无法找回。',
      confirmLabel: '删除',
      onConfirm: () => { void doDeleteBackup(file); },
    });
  } else if (act === 'storage-manage') {
    if (_ctx) openStorageManagerSheet(_ctx.container, () => render());
  }
}

export const settingsApp: PhoneApp = {
  id: 'settings',
  name: '设置',
  icon: ubpIcon('settings'),
  color: '#8E8E93',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _backups = null;
    ctx.container.addEventListener('change', handleChange);
    ctx.container.addEventListener('click', handleClick as EventListener);
    ctx.container.addEventListener('input', handleInput);
    ctx.container.addEventListener('keydown', handleKeydown);
    ctx.container.addEventListener('toggle', handleToggle, true);
    ctx.container.addEventListener('mouseover', handleTipOver as EventListener);
    ctx.container.addEventListener('mouseout', handleTipOut as EventListener);
    // 滚动时收起浮层（scroll 不冒泡，捕获阶段接）
    ctx.container.addEventListener('scroll', hideTip, true);
    render();
    // 主项目配置即时同步：打开时拉取兜底（防错过推送）+ 重读完成后刷新 API 页快照
    void refreshHostConfig().then(() => { if (_ctx === ctx) render(); });
    // 正文联动注入状态：打开设置页异步检查一次（两条只读 API），完成后刷新
    void refreshStoryStatus().then(() => { if (_ctx === ctx) render(); });
    const offHostSynced = onHostConfigSynced(() => { if (_tab === 'api') render(); });
    return () => {
      ctx.container.removeEventListener('change', handleChange);
      ctx.container.removeEventListener('click', handleClick as EventListener);
      ctx.container.removeEventListener('input', handleInput);
      ctx.container.removeEventListener('keydown', handleKeydown);
      ctx.container.removeEventListener('toggle', handleToggle, true);
      ctx.container.removeEventListener('mouseover', handleTipOver as EventListener);
      ctx.container.removeEventListener('mouseout', handleTipOut as EventListener);
      ctx.container.removeEventListener('scroll', hideTip, true);
      offHostSynced();
      hideTip();
      closeSkinStudio(); // 工坊弹层住在本容器里，卸载时一并收掉（顺带清模块态指针）
      void flushPhoneSettings();
      void flushPhoneStore();
      _ctx = null;
    };
  },
};
