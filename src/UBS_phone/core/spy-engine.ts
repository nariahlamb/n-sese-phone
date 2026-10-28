// ===== 窥私 AI 引擎（三段式管线骨架对齐 chat-engine；自动触发对齐世界演化轮数水位） =====
// ① injectPrompts 绿灯触发：position:'none'（不发给 AI）+ should_scan:true + once:true
//    → 内容=本轮焦点人物名单 → 绿灯扫描激活主项目角色条目 + [UBS手机]窥私记录/[UBS手机]消息记录 分角色条目
//    （角色间近期通话/私聊/群聊 + 各角色与主角的近期记录，不进资料块——用户定案）。
// ② injectPrompts 资料块：position:'after_system'（发给 AI）+ should_scan:false
//    → 焦点人物档案/关系/剧情纪要（每角色保底取含名纪要）/已有群聊清单/焦点群最近 20 条/正文上下文。
// ③ generateRaw 全槽位 = phone-raw.runPhoneRaw（单一事实源，见 core/phone-raw.ts）：
//    keep=keepPhoneRecordEntries——窥私请求放行窥私族+消息记录族
//    （用户定案：窥私历史与焦点角色近期主角侧互动都靠世界书条目，资料块无消息记录段）；
//    聊天/通话/社媒 keep 仅放行窥私族（资料块已自带消息记录，防回喂）。
// 自动触发（用户定案复用世界演化机制）：MESSAGE_RECEIVED + 500ms 防抖 + quiet 过滤 +
// 轮数水位（spy.lastRound，间隔=世界演化 worldEvolveEveryTurns 设置）+ 最短回复 100 字闸（固定）。
// 失败处理（用户定案）：错误持久化进 spy.lastError，持续存在直到用户点击清除或下次生成成功。

import { getConfig } from '../../unified-statusbar/core/config-store';
import { isHostRefillMode } from './host-config';
import { keepPhoneRecordEntries } from '../../unified-statusbar/core/worldbook-entry';
import { readChronicleDossierBlocks } from '../../unified-statusbar/core/chronicle-blocks';
import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { getTavernHelper, hostWindow, makeGenerationId, stopGenerationById } from './host-env';
import { mergeOneShotHint } from './extra-hint';
import { PhoneChatError, readAiChatHistory } from './chat-engine';
import { runPhoneRaw } from './phone-raw';
import type { PhoneStyle } from './chat-model';
import { getPhoneSettings } from './phone-settings';
import { validatePhoneApi } from './phone-api';
import { currentPhoneStorageId, mutatePhoneData, readPhoneDataRef } from './phone-store';
import { resolveAvatarPath } from './phone-avatars';
import { getRoster, mergedContactNames, type RosterSnapshot } from './roster';
import {
  applySpyBlocks,
  ensureSpyDomain,
  listSpyGroupsWithFocus,
  pickSpyHistoryConversations,
  resolveSpyFocus,
  selectFocusGroup,
  selectSpyFocus,
  type SpyApplyOutcome,
} from './spy-model';
import { filterValidSpyBlocks, parseSpyReply } from './spy-parser';
import { buildSpyDossierText, buildSpyInstruction, buildSpyTrigger } from './spy-prompts';
import { notifySpyRecordsChanged } from './spy-worldbook';
import { achFlag, emitAch } from './phone-achievements';

// ─── 世界演化设置复用（用户定案：轮数/上下文/纪要三项目只读复用，手机侧不重复设置） ───

export interface SpyWorldConfig {
  /** 纪要总量（每焦点角色保底取含名纪要；worldChronicleTotal）。 */
  chronicleTotal: number;
  /** 正文上下文层数（worldContextCount）。 */
  contextCount: number;
  /** 自动生成轮数间隔（worldEvolveEveryTurns）。 */
  everyTurns: number;
}

/** 读取复用的世界演化设置（主项目 config；读取失败回落默认）。设置页只读展示复用本函数。 */
export function readWorldConfigSafe(): SpyWorldConfig {
  try {
    const cfg = getConfig();
    return {
      chronicleTotal: Math.max(0, Math.floor(Number(cfg?.worldChronicleTotal) || 50)),
      contextCount: Math.max(0, Math.floor(Number(cfg?.worldContextCount) || 2)),
      everyTurns: Math.max(1, Math.floor(Number(cfg?.worldEvolveEveryTurns) || 2)),
    };
  } catch (_e) {
    return { chronicleTotal: 50, contextCount: 2, everyTurns: 2 };
  }
}

/** 自动触发的最短回复字数闸（固定值；防止「嗯/好」这类短回复触发无谓请求；不设设置项）。 */
const SPY_AUTO_MIN_REPLY_CHARS = 100;

const QUIET_MESSAGE_TYPES = new Set(['quiet', 'impersonate', 'command', 'extension', 'first_message']);

// ─── 生成中的管理（独立于聊天/通话管线的 abort id 集） ───

const _activeGenerations = new Set<string>();
let _autoTimer: ReturnType<typeof setTimeout> | null = null;

/** 是否有窥私生成在进行中（App 生成按钮/自动触发共用防重入）。 */
export function hasSpyGeneration(): boolean {
  return _activeGenerations.size > 0;
}

/** 终止当前窥私生成。返回是否有请求被终止。 */
export function abortSpyGeneration(): boolean {
  let stopped = false;
  for (const id of _activeGenerations) {
    if (stopGenerationById(id)) stopped = true;
  }
  _activeGenerations.clear();
  return stopped;
}

/** 当前聊天轮数（=楼层总数；世界演化同款轮数源）。 */
function chatRound(): number {
  try {
    const w = hostWindow() as any;
    const chat = w.SillyTavern?.chat;
    if (Array.isArray(chat)) return chat.length;
  } catch (_e) { /* ignore */ }
  try {
    const th = getTavernHelper();
    const last = th?.getLastMessageId?.();
    if (typeof last === 'number' && last >= 0) return last + 1;
  } catch (_e) { /* ignore */ }
  return 0;
}

/** 持久错误通知写入（用户点击后清除；下次成功生成时作废）。 */
function setSpyLastError(text: string): void {
  try {
    mutatePhoneData(d => {
      const spy = ensureSpyDomain(d);
      spy.lastError = { text: text.slice(0, 300), ts: Date.now() };
    });
  } catch (_e) { /* 存储不可用：仅失去持久通知 */ }
}

/** 清除持久错误通知（App 错误横幅点击时调用）。 */
export function clearSpyError(): void {
  try {
    mutatePhoneData(d => {
      if (d.spy?.lastError) delete d.spy.lastError;
    });
  } catch (_e) { /* ignore */ }
}

// ─── 主流程 ───

export interface SpyGenerateArgs {
  /** manual=App 手动按钮；auto=自动触发（水位推进共用）。 */
  reason?: 'manual' | 'auto';
  /** 自动触发捕获的轮数（水位基准；缺省取当前轮数）。 */
  round?: number;
  /** 一次性「本批额外提示」（长按「生成」追加；只作用于本次生成，不落盘）。 */
  extraHint?: string;
  /** 长按弹窗指定的焦点人物（不足按 spyFocusCount 随机补足、超出则全用所选）。 */
  focusNames?: string[];
  /** 只用选中的人（不随机补足；选中∩池 <2 视为非法请求）。一次性选项，不落盘。 */
  strictFocus?: boolean;
  /** 本场会话 id（会话内「接着演」：候选池并入本场成员、资料块带本场最近消息、指令点明延续）。 */
  focusConversationId?: string;
  /** 供测试注入的 roster 快照。 */
  rosterOverride?: RosterSnapshot;
}

export interface SpyGenerationResult {
  raw: string;
  outcomes: SpyApplyOutcome[];
  /** 本次生成后的水位。 */
  round: number;
  /** 指定但不在候选池内被忽略的焦点名字（防静默换人；空=无）。 */
  droppedFocus?: string[];
  /** 生成完成时聊天已切换 → 本轮产物整体丢弃（未落库、未通知）。 */
  discarded?: boolean;
}

/**
 * 生成一轮窥私内容：焦点随机 → 焦点群聊随机 → 三段式请求 → 解析 → 落库。
 * 抛 PhoneChatError（env/api/network/parse）；失败经 setSpyLastError 持久化通知。
 */
export async function generateSpyContent(args: SpyGenerateArgs = {}): Promise<SpyGenerationResult> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  if (_activeGenerations.size) {
    throw new PhoneChatError('env', '已有窥私生成在进行中');
  }
  const generationId = makeGenerationId('ubp-spy');
  _activeGenerations.add(generationId);
  const round = args.round ?? chatRound();
  try {
    const settings = getPhoneSettings();
    if (!settings.spyEnabled) {
      throw new PhoneChatError('env', '窥私功能未开启（设置 → 功能 → 窥私）');
    }
    const apiError = validatePhoneApi('spy');
    if (apiError) {
      throw new PhoneChatError('api', apiError);
    }
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const phoneData = readPhoneDataRef();
    // 聊天归属快照（F1）：AI 请求期间切聊天/切卡 → 本轮窥私产物属于旧聊天，一律不落库。
    const owner = currentPhoneStorageId();
    const spyConversations = phoneData.spy?.conversations || [];
    // 本场会话（接着演）：会话内长按生成传入；列表页/单击随机路径不传
    const focusConversation = args.focusConversationId
      ? (spyConversations.find(c => c.id === args.focusConversationId) || null)
      : null;
    // 焦点候选池：合并视图（数据库+自定义联系人）− 主角 − 在场；会话内生成并入本场成员
    // （本场成员即使在场也保留——「接着演」最该被选中的人往往正在场；自动/随机路径池子逐字不变）
    const basePool = mergedContactNames(roster, phoneData.customContacts || [])
      .filter(n => n && n !== me && !roster.present[n]);
    const pool = focusConversation
      ? Array.from(new Set([...basePool, ...focusConversation.members.filter(n => n && n !== me)]))
      : basePool;
    if (pool.length < 2) {
      throw new PhoneChatError('env', '排除在场角色后可用角色不足（通讯录至少需要 2 名空闲角色）');
    }
    // 焦点：长按弹窗指定优先（严格=只用选中不补足；否则不足按焦点人数随机补足、超出则全用所选），
    // 否则随机抽选。池外名字经 droppedFocus 回传渲染层明示，不再静默丢弃。
    const picks = args.focusNames || [];
    let focus: string[];
    let droppedFocus: string[] = [];
    if (picks.length || args.strictFocus) {
      const resolved = resolveSpyFocus(picks, pool, Math.max(settings.spyFocusCount, picks.length), !!args.strictFocus);
      if (!resolved) {
        throw new PhoneChatError('env', '「只用选中的人」至少需要勾选 2 名候选范围内角色');
      }
      focus = resolved.focus;
      droppedFocus = resolved.dropped;
    } else {
      focus = selectSpyFocus(pool, Math.min(settings.spyFocusCount, pool.length));
    }
    // 会话内生成：本场会话优先（资料块带「本场最近消息」）；列表页生成：焦点群聊照旧随机
    const focusGroup = focusConversation ? null : selectFocusGroup(spyConversations, focus);
    const existingGroups = listSpyGroupsWithFocus(spyConversations, focus);
    // H′ 既有记录兜底（docs/13）：无焦点会话（列表页/自动触发）且世界书通道关闭
    // （spyWorldbook 默认关 ⇒ 默认配置下这是「过去聊过什么」的唯一通道）时，直读存档注入既有会话；
    // 焦点群聊那一场资料块已单独喂过，剔掉防重复
    const historyConvs = (!focusConversation && !settings.spyWorldbook && settings.spyHistoryCount > 0)
      ? pickSpyHistoryConversations(spyConversations, focus, {
        excludeIds: focusGroup ? [focusGroup.id] : [],
      })
      : [];

    // ① 素材：纪要（焦点并集、每角色保底取含名纪要）+ 正文上下文（复用世界演化设置）
    const worldCfg = readWorldConfigSafe();
    const chronicleBlocks = readChronicleDossierBlocks(focus, worldCfg.chronicleTotal);
    const storyText = stripWithContextConfig(readAiChatHistory(worldCfg.contextCount));

    // 额外要求合并产物（进指令 + 追加进触发注入语料——提示里提到的人名同样激活世界书条目）
    const mergedExtra = mergeOneShotHint(settings.extraPrompt, args.extraHint);

    // ②③ 一次性注入：once:true 只在下一次请求生成中有效 → 交给 runPhoneRaw 的 prepare 每次尝试前重跑
    const prepare = async () => {
    // ② 绿灯触发注入（不进提示词，只参与世界书扫描：焦点人名 + 额外提示文本）
    await th.injectPrompts([{
      id: 'ubp_spy_trigger',
      position: 'none',
      depth: 0,
      role: 'system',
      content: [buildSpyTrigger(focus), mergedExtra.trim()].filter(Boolean).join(' '),
      should_scan: true,
    }], { once: true });

    // ③ 资料块注入（发给 AI，不参与扫描；窥私历史走世界书条目不在此段——用户定案）
    await th.injectPrompts([{
      id: 'ubp_spy_dossier',
      position: 'after_system',
      depth: 0,
      role: 'system',
      content: buildSpyDossierText({
        roster,
        focus,
        focusGroup,
        existingGroups,
        ...(focusConversation ? { focusConversation } : {}),
        ...(historyConvs.length ? { historyConvs, historyCount: settings.spyHistoryCount } : {}),
        chronicleBlocks,
        storyText,
        style: phoneData.style || '',
      }),
      should_scan: false,
    }], { once: true });
    };

    // ④ 裸生成
    const instructionArgs = {
      focus,
      focusGroup,
      ...(focusConversation ? { focusConversation } : {}),
      count: settings.spyContentCount,
      extraPrompt: mergedExtra,
      style: (phoneData.style || '') as PhoneStyle,
      voiceEmotion: settings.voiceEnabled === true && settings.voiceEmotion === true,
    };
    const instruction = th.substitudeMacros
      ? th.substitudeMacros(buildSpyInstruction(instructionArgs))
      : buildSpyInstruction(instructionArgs);

    // 扫描前剔除纪要自投影（防重复回喂）；keep 豁免窥私族+消息记录族（窥私历史与焦点角色近期
    // 主角侧互动都靠世界书条目注入——资料块无消息记录段——keepPhoneRecordEntries）
    const raw = await runPhoneRaw({
      scope: 'spy',
      instruction,
      generationId,
      keep: keepPhoneRecordEntries,
      prepare,
      activity: {
        feature: '窥私',
        label: '窥私',
        appId: 'spy',
        tone: 'ai',
        onCancel: () => { abortSpyGeneration(); },
      },
    });

    // ⑤ 解析（发言者/当事人仅限焦点名单，非成员发言解析失败天然被拒）
    const parsed = parseSpyReply(String(raw), {
      allowedSenders: focus,
    });
    const validBlocks = filterValidSpyBlocks(parsed.blocks);
    if (!validBlocks.length) {
      throw new PhoneChatError('parse', '生成内容无法解析为窥私互动（通话/私聊/群聊块）');
    }

    // 聊天归属守卫（F1）：切走后整轮丢弃——早退不触发 catch，故不会在新聊天留下持久错误通知。
    if (currentPhoneStorageId() !== owner) {
      return { raw: String(raw), outcomes: [], round, discarded: true };
    }
    // ⑥ 落库（纯函数直改 spy 域）+ 水位推进 + 错误通知作废 + 世界书投影刷新
    const storyTime = roster.global.time || undefined;
    const outcomes = mutatePhoneData(d => applySpyBlocks(d, validBlocks, {
      focus,
      storyTime,
      avatarFor: resolveAvatarPath,
      maxBlocks: settings.spyContentCount,
    }));
    const okCount = outcomes.filter(o => o.ok).length;
    if (!okCount) {
      throw new PhoneChatError('parse', '生成内容全部无效（当事人越界或无有效消息）');
    }
    mutatePhoneData(d => {
      const spy = ensureSpyDomain(d);
      spy.lastRound = round;
      if (spy.lastError) delete spy.lastError;
    });
    notifySpyRecordsChanged();
    // L9 成就：玩家亲手生成窥私内容成功（自动触发 reason='auto' 绝不打点）
    if (args.reason !== 'auto') {
      emitAch('phone_spy_generated', { charCount: focus.length, strict: achFlag(!!args.strictFocus) });
    }
    return { raw: String(raw), outcomes, round, ...(droppedFocus.length ? { droppedFocus } : {}) };
  } catch (error) {
    // 用户主动终止：不写持久错误通知（UI 侧静默收口）
    if (error instanceof PhoneChatError && error.kind === 'aborted') throw error;
    const message = error instanceof PhoneChatError ? error.message : `窥私生成失败：${error instanceof Error ? error.message : String(error)}`;
    setSpyLastError(message);
    throw error;
  } finally {
    _activeGenerations.delete(generationId);
  }
}

// ─── 自动触发（AI 回复结束后；机制对齐主项目世界演化） ───

/** 注册自动触发监听（幂等；总开关/自动开关关闭时回调首行即返，零成本常驻）。 */
export function bindSpyAutoTrigger(): void {
  const w = hostWindow() as unknown as Record<string, unknown> & { SillyTavern?: any; __ubp_spy_auto_bound?: boolean };
  if (w.__ubp_spy_auto_bound) return;
  w.__ubp_spy_auto_bound = true;
  try {
    const ctx = w.SillyTavern?.getContext?.();
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (!source || typeof source.on !== 'function' || !types?.MESSAGE_RECEIVED) return;
    source.on(types.MESSAGE_RECEIVED, (_id: unknown, type: unknown) => {
      if (typeof type === 'string' && QUIET_MESSAGE_TYPES.has(type)) return;
      if (isHostRefillMode()) return; // F66：重填模式期间不发起自动 AI 请求
      const settings = getPhoneSettings();
      if (!settings.spyEnabled || !settings.spyAutoGen) return;
      if (_activeGenerations.size) return;
      if (_autoTimer) clearTimeout(_autoTimer);
      _autoTimer = setTimeout(() => {
        _autoTimer = null;
        void runAutoSpy().catch(() => { /* 失败已持久化进 spy.lastError，下轮重试 */ });
      }, 500);
    });
  } catch (_e) { /* 宿主事件不可用：仅失去自动触发 */ }
}

async function runAutoSpy(): Promise<void> {
  const settings = getPhoneSettings();
  if (!settings.spyEnabled || !settings.spyAutoGen) return;
  if (_activeGenerations.size) return;
  const worldCfg = readWorldConfigSafe();
  const round = chatRound();
  const lastRound = readPhoneDataRef().spy?.lastRound || 0;
  if (round - lastRound < worldCfg.everyTurns) return;
  // 最短回复闸（固定 100 字）：短回复不触发，避免无谓请求
  const latest = stripWithContextConfig(readAiChatHistory(1));
  if (latest.replace(/^AI[:：]\s*/, '').trim().length < SPY_AUTO_MIN_REPLY_CHARS) return;
  await generateSpyContent({ reason: 'auto', round });
}