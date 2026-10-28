// ===== 游戏中心 App（狼人杀 · 谁是卧底；docs/16） =====
// 视觉基线：docs/game-center-mockup.html V2（暗色稿）逐屏复刻——.ubp-gm-page 携带独立
// 暗色调色板；全部字号必须走 CSS 类（进 PHONE_CSS calc 缩放管线），禁止内联字号样式。
// 视图：home（恢复条+渐变游戏卡+记录入口）/ invite（好友多选）/ play（卧底+狼人杀）/
// records / detail（四区 tab）。
// 过程信息隔离（docs/16 §0.9）：对局界面只渲染 system/speech/vote（狼人另可见狼队密谋）——
// 他人 think/situation/身份仅终局与记录详情可见；全员渲染 roster 头像（avatarHtml 兜底）。

import {
  abandonGame,
  currentTurtleSoupSession,
  currentUndercoverSession,
  currentWerewolfSession,
  enforceSingleActiveGame,
  giveUpTurtleSoup,
  hasGameGeneration,
  lastGameError,
  onGameEpilogueChanged,
  onGameStateChanged,
  pendingLastWordsInfo,
  regenerateGameEpilogue,
  resumeTurtleSoupChain,
  resumeUndercoverChain,
  resumeWerewolfChain,
  retryCurrentStep,
  retryTurtleSoupStep,
  retryWerewolfStep,
  runningGameType,
  startTurtleSoup,
  startUndercover,
  startWerewolf,
  stopGameGeneration,
  submitTurtleSoupGuess,
  submitTurtleSoupQuestion,
  submitTurtleSoupSkip,
  submitUndercoverSpeech,
  submitUndercoverVote,
  submitWerewolfLastWords,
  submitWerewolfPkSpeech,
  submitWerewolfSeerCheck,
  submitWerewolfSpeech,
  submitWerewolfUserKill,
  submitWerewolfUserTactics,
  submitWerewolfVote,
  submitWerewolfWitch,
  turtleSoupBusyStep,
  werewolfWolfDraft,
} from '../core/game-engine';
import {
  gameTypeName,
  hasAnyRunningGame,
  normalizePhoneGames,
  SOUP_CATEGORIES,
  SOUP_PARTICIPANT_FRIENDS_MAX,
  SOUP_QUOTA_DEFAULT,
  SOUP_QUOTA_MAX,
  SOUP_QUOTA_MIN,
  type ActiveTurtleSoup,
  type ActiveUndercover,
  type ActiveWerewolf,
  type GameRecord,
  type GameReplayEntry,
  type UndercoverSeat,
  type WerewolfSeat,
} from '../core/game-model';
import { getRoster, mergeCustomContacts } from '../core/roster';
import { npcPersona, rollNpcNames } from '../core/game-npc';
import { currentStyle } from '../core/skins';
import { isFriend, storyTimeShort, voiceDurationSeconds, type PhoneChatData } from '../core/chat-model';
import { isVoiceEnabled } from '../core/phone-settings';
import { prewarmNeighbors, voicePlanFor, type VoiceWarmSlot } from '../core/chat-voice';
import { playVoice, stopVoice, type VoiceHandle, type VoicePlayState } from '../core/voice-tts';
import { voiceMetaHtml } from './voice-meta';
import { persistPhoneData, readPhoneDataRef } from '../core/phone-store';
import { emitPhoneEvent, onPhoneEvent, takePendingAppTarget, type PhoneApp, type PhoneAppContext } from './app-registry';
import { avatarColor, avatarHtml, createViewScrollMemo, escapeAttr, escapeHtml, openApp, showScreenToast } from './phone-ui';
import { ubpIcon } from './icons';
import { emitAch, emitActionOnDate } from '../core/phone-achievements';

type View = 'home' | 'invite' | 'play' | 'records' | 'detail' | 'end';
type InviteGame = 'werewolf' | 'undercover' | 'turtlesoup';

let _ctx: PhoneAppContext | null = null;
let _view: View = 'home';
let _invitePicked = new Set<string>();
let _inviteGame: InviteGame = 'undercover';
let _wolfAiTactic = '';
let _wolfUserTactic = '';
let _witchSave = false;
let _witchPoisonPos = 0;
let _wolfKillArmed = false; // 狼战术确认后解锁刀口点选
let _wolfKillPick = 0; // 刀口两步选择：已点选未确认的目标号位
let _seerPick = 0; // 验人两步选择：已点选未确认的目标号位
let _starting = false; // 开局请求进行中（确认按钮 loading 态）
let _detailId = '';
let _detailTab: 'replay' | 'summary' | 'highlight' | 'afterparty' = 'replay';
let _votePickPos = 0;
let _mountToken = 0;
let _renderedView: View | '' = ''; // 滚动保持：本次已渲染视图（同视图重绘还原 scrollTop，跨视图按视图键取记忆位）
// 跨视图滚动记忆：战绩列表 → 对局详情 → 返回不再回顶（见 phone-ui createViewScrollMemo）
const _viewScroll = createViewScrollMemo();
// ─── 海龟汤邀请/对局本地态（不入库） ───
let _soupCategory: (typeof SOUP_CATEGORIES)[number] = '不限';
let _soupQuota = SOUP_QUOTA_DEFAULT;
let _soupHost = ''; // 主持人单选（好友名）
let _soupGuessOpen = false; // 猜汤底弹层
let _soupGiveupOpen = false; // 放弃确认弹层
let _quitOpen = false; // 🚪 退出对局弹层（后台继续 / 结束本局）
let _startConflict = false; // 单局制：已有未完成对局时开新局的冲突确认弹层
// ─── NPC 补位（docs/16 §10：邀请页显式可选、默认开启；补位者全流程带 🎭 角标） ───
let _npcFill = true; // 补位开关（默认开；关掉则退回「人数不足不能开局」）
let _npcPreview: string[] = []; // 本次邀请的补位名单（本地点数/换一批；开局时随邀请名单一并传入引擎）

/** 🚪 退出对局入口（对局页 appbar 右侧；三款游戏共用）。 */
const QUIT_BTN = '<button class="ubp-gm-navact" data-ubp-act="quit-open" title="退出对局">🚪</button>';

/** P1：游戏中心的读取一律只读（改状态全部走 mutate*），故直接用零拷贝引用——
 *  原先每次对局状态变化（一局内 notifyChanged 数十次）都整机深拷贝 2~3 份。 */
function readDataSafe(): PhoneChatData {
  try {
    return readPhoneDataRef();
  } catch (_e) {
    return { schema: 1, conversations: [] };
  }
}

/** 通讯录真实角色名集合（判定「谁是补位者」的唯一口径，与引擎侧一致）。
 *  每次 render 前失效（render() 顶部置空），单帧内多处取用零重复开销。 */
let _knownNamesCache: Set<string> | null = null;

function knownContactNames(): Set<string> {
  if (_knownNamesCache) return _knownNamesCache;
  const roster = getRoster();
  const data = readDataSafe();
  const set = new Set<string>([roster.protagonistName, ...roster.contacts.map(c => c.name)]);
  for (const name of data.customContacts || []) set.add(name);
  _knownNamesCache = set;
  return set;
}

/** 该名字是否为补位者（不在通讯录 ⇒ 本局临时凑桌的陌生人）。 */
function isNpcParticipant(name: string, known?: Set<string>): boolean {
  return !(known || knownContactNames()).has(name);
}

/** 名字后的 🎭 角标（席位/气泡/底牌共用；非补位者返回空串）。 */
function npcMark(name: string, known?: Set<string>): string {
  return isNpcParticipant(name, known) ? '<span class="ubp-gm-npctag" title="临时凑桌的陌生人">🎭</span>' : '';
}

/** 本品还差几位才到最低人数（0=已够，不需要补位）。 */
function inviteNpcNeed(): number {
  const min = _inviteGame === 'werewolf' ? 5 : _inviteGame === 'turtlesoup' ? 1 : 3;
  return Math.max(0, min - _invitePicked.size);
}

/** 按当前勾选/开关重算补位名单（人数没变就不换人，避免每次渲染都重掷）。 */
function syncNpcPreview(): void {
  const need = _npcFill ? inviteNpcNeed() : 0;
  if (!need) {
    _npcPreview = [];
    return;
  }
  if (_npcPreview.length === need) return;
  const exclude = knownContactNames();
  for (const name of _invitePicked) exclude.add(name);
  _npcPreview = rollNpcNames(need, currentStyle(), exclude);
}

/** 开局名单 = 勾选好友 + 补位者（补位开关关闭时不带补位者）。 */
function inviteNames(): string[] {
  return [..._invitePicked, ...(_npcFill ? _npcPreview : [])];
}

function gamesOf(data: PhoneChatData) {
  return normalizePhoneGames(data.games);
}

function findDetailRecord(): GameRecord | null {
  const games = gamesOf(readDataSafe());
  if (!games) return null;
  return games.records.undercover.find(r => r.id === _detailId)
    || games.records.werewolf.find(r => r.id === _detailId)
    || games.records.turtlesoup.find(r => r.id === _detailId)
    || null;
}

function allRecordsSorted(): GameRecord[] {
  const games = gamesOf(readDataSafe());
  return [...(games?.records.undercover || []), ...(games?.records.werewolf || []), ...(games?.records.turtlesoup || [])].sort((a, b) => b.ts - a.ts);
}

function render(): void {
  if (!_ctx) return;
  _knownNamesCache = null; // 补位者判定口径随数据变动（单帧内复用）
  _gmvCache.clear(); // 语音条参数表随本轮 DOM 重建（节点键→参数，点击/补丁取用）
  if (_view === 'invite') renderInvite();
  else if (_view === 'play') renderPlay();
  else if (_view === 'records') renderRecords();
  else if (_view === 'detail') renderDetail();
  else if (_view === 'end') {
    // 终局面板是独立视图态：赛后产物（总结/高光）补写完成回调重进这里刷新，不会被 renderPlay 顶回主页
    const record = findDetailRecord();
    if (record) renderEndView(record);
    else {
      _view = 'home';
      renderHome();
    }
  } else renderHome();
}

// ─── 台词语音条（docs/50） ───
// 只认引擎写入的 entry.voice（真实角色=语音条；补位🎭NPC 与玩家台词引擎根本不写），
// 且**总开关关闭时一个语音节点都不渲染**（与 renderers/voice-meta 同一条纪律，docs/40）。
// 组件复用微信的 .ubp-voice / .ubp-voice-bar / .ubp-vmeta（CSS 在 .ubp-gm-page 作用域补暗色配方）。
// 播放就地补丁不整屏重绘；整屏重绘时节点按 _gmv 自动渲染成播放态，滚动与输入焦点都不受影响。

interface GmVoiceArgs {
  key: string;
  idx: number;
  /** 台词发送方显示名（音色解析用）。 */
  sender: string;
  /** 气泡头一行（🗣️/🪷 + 名字 + 号位）。 */
  who: string;
  text: string;
  emotion: string;
  delivery: string;
  /** 我方镜像（本功能不产生我方语音，保留以备二期复盘回放）。 */
  rev: boolean;
}

/** 本轮渲染出的语音条参数表（render() 开头清空；点击与就地补丁按节点键取用）。 */
const _gmvCache = new Map<string, GmVoiceArgs>();
let _gmvArgs: GmVoiceArgs | null = null;
let _gmv: { key: string; state: VoicePlayState; ratio: number; remainSec: number; durSec: number } | null = null;
let _gmvHandle: VoiceHandle | null = null;

/** 节点键：`${gameType}:${session}:${entries下标}`（条目追加式写入，下标稳定）。 */
function gmvKey(type: string, session: number, idx: number): string {
  return `${type}:${session}:${idx}`;
}

/** 台词取词：answer 条目取「|」后的口吻半句；speech/guess 剥掉遗言/PK 前缀（前缀只是展示标记）。 */
function gmVoiceText(e: GameReplayEntry): string {
  if (e.type === 'answer') {
    const i = e.text.indexOf('|');
    return (i > 0 ? e.text.slice(i + 1) : '').trim();
  }
  return e.text.replace(/^(遗言|PK辩解)：/, '').trim();
}

/** 该条目是否渲染成语音条。 */
function gmVoiceOn(e: GameReplayEntry): boolean {
  return e.voice === true && isVoiceEnabled();
}

/** 语音条节点（播放态读 _gmv；静止态显示按字数估算的时长，点击才真合成）。 */
function gmVoiceHtml(args: GmVoiceArgs): string {
  _gmvCache.set(args.key, args);
  const st = _gmv && _gmv.key === args.key ? _gmv : null;
  const total = Math.max(1, voiceDurationSeconds(args.text));
  const loading = st?.state === 'loading';
  const playing = st?.state === 'playing' || st?.state === 'paused';
  const durText = loading ? '生成中…' : playing ? `${Math.max(0, Math.ceil(st!.remainSec))}''` : `${total}''`;
  const wave = loading ? '<span class="ubp-spinner"></span>' : ubpIcon('voiceWave');
  const progress = playing ? `<span class="ubp-voice-progress" style="width:${Math.round((st!.ratio || 0) * 100)}%"></span>` : '';
  const bar = `<button type="button" class="ubp-voice-bar${args.rev ? ' rev' : ''}" data-ubp-act="gm-voice-play" data-gmv-key="${escapeAttr(args.key)}" aria-label="播放语音${total}秒">${wave}<span class="ubp-voice-dur">${durText}</span>${progress}</button>`;
  const meta = voiceMetaHtml(args.emotion, args.delivery);
  const transcript = args.text ? `<span class="ubp-voice-text">${escapeHtml(args.text)}</span>` : '';
  const head = args.who ? `<div class="ubp-gm-who">${args.who}</div>` : '';
  return `<div class="ubp-voice${playing ? ' playing' : ''}${loading ? ' loading' : ''}" data-gmv-node="${escapeAttr(args.key)}">${head}${bar}${meta}${transcript}</div>`;
}

/** 就地重建某条语音条节点（不整屏重绘，保滚动与输入焦点）。 */
function gmVoicePatch(key: string): void {
  const host = _ctx?.container;
  const args = _gmvCache.get(key);
  if (!host || !args) return;
  const el = host.querySelector(`[data-gmv-node="${key.replace(/"/g, '\\"')}"]`);
  if (el) el.outerHTML = gmVoiceHtml(args);
}

/** 停止台词语音播放（rerender=false 时只复位状态，由调用方自行补丁/整体重绘）。 */
function gmVoiceStop(rerender = true): void {
  const key = _gmv?.key || _gmvArgs?.key || '';
  _gmv = null;
  if (_gmvHandle) { try { _gmvHandle.stop(); } catch (_e) { /* ignore */ } _gmvHandle = null; }
  try { stopVoice(); } catch (_e) { /* ignore */ }
  if (rerender && key) gmVoicePatch(key);
}

/** 点击语音条：切换播放（同一条再点即停；换一条先停旧条）。 */
function gmVoiceToggle(key: string): void {
  if (_gmv && _gmv.key === key) { gmVoiceStop(); return; }
  const args = _gmvCache.get(key);
  if (!args) return;
  const prev = _gmv?.key || '';
  gmVoiceStop(false);
  if (prev) gmVoicePatch(prev);
  if (!isVoiceEnabled()) return; // 总开关关闭时按钮本就不渲染，这里是防绕过兜底
  const plan = voicePlanFor(args.text, args.sender, args.emotion, args.delivery);
  if (!plan) return;
  const total = Math.max(1, voiceDurationSeconds(args.text));
  _gmvArgs = args;
  _gmv = { key, state: 'loading', ratio: 0, remainSec: total, durSec: total };
  gmVoicePatch(key);
  let achEmitted = false; // L9：真正开播才计一次（loading/失败不计）
  _gmvHandle = playVoice({
    backend: plan.backend,
    cacheKey: plan.cacheKey,
    text: plan.text,
    voiceId: plan.voiceId,
    providerId: plan.providerId,
    refAudio: plan.refAudio,
    role: plan.role,
    speed: plan.speed,
    emotion: plan.emotion,
    delivery: plan.delivery,
    onState: st => {
      if (st === 'playing' && !achEmitted) { achEmitted = true; emitAch('phone_voice_played', { from: 'game' }); }
      if (st === 'ended' || st === 'error') {
        if (_gmv && _gmv.key === key) { _gmv = null; _gmvHandle = null; gmVoicePatch(key); }
        return;
      }
      if (_gmv && _gmv.key === key) { _gmv = { ..._gmv, state: st }; gmVoicePatch(key); }
    },
    onProgress: (ratio, remain, dur) => {
      if (!_gmv || _gmv.key !== key) return;
      _gmv = { ..._gmv, state: 'playing', ratio, remainSec: remain, durSec: dur };
      gmVoicePatch(key);
    },
  });
  // 相邻预取（与微信同款）：播这条时顺手把下一条优先/上一条预合成进缓存；不做整局预取。
  prewarmNeighbors(gmVoiceSlots(), args.idx);
}

/** 当前对局台词 → 预取槽位（与 entries 同下标；非语音/取不到发送方填 null）。 */
function gmVoiceSlots(): VoiceWarmSlot[] {
  const games = gamesOf(readDataSafe());
  const active = games?.active;
  if (!active) return [];
  const slotOf = (e: GameReplayEntry, sender: string): VoiceWarmSlot => {
    const text = gmVoiceText(e);
    if (e.voice !== true || !sender || !text) return null;
    return { text, sender, emotion: e.voiceEmotion || '', delivery: e.voiceDelivery || '' };
  };
  if (active.undercover) {
    const uc = active.undercover;
    return uc.entries.map(e => slotOf(e, e.pos === undefined ? '' : uc.players.find(p => p.position === e.pos)?.name || ''));
  }
  if (active.werewolf) {
    const ww = active.werewolf;
    return ww.entries.map(e => slotOf(e, e.pos === undefined ? '' : ww.players.find(p => p.position === e.pos)?.name || ''));
  }
  if (active.turtleSoup) {
    const ts = active.turtleSoup;
    return ts.entries.map(e => slotOf(e, e.type === 'answer' ? ts.hostName : e.pos === undefined ? '' : ts.players.find(p => p.position === e.pos)?.name || ''));
  }
  return [];
}

// ─── 页面骨架（.ubp-gm-page 暗色作用域；body 滚动 + footer 固定） ───

/** 页面骨架（.ubp-gm-page 暗色作用域；body 滚动 + footer 固定）。
 *  right=appbar 右侧动作槽（如海龟汤 🏳️ 放弃入口）；extra=页尾弹层（overlay 挂 .ubp-gm-page 内）。 */
function pageShell(title: string, body: string, footer = '', backAct = '', preBody = '', right = '', extra = ''): string {
  const back = backAct
    ? `<button class="ubp-iconbtn" data-ubp-act="${backAct}" title="返回">${ubpIcon('back')}</button>`
    : '<span style="width:32px;flex:none;"></span>';
  const rightSlot = right || '<span style="width:32px;flex:none;"></span>';
  return `
    <div class="ubp-gm-page">
      <div class="ubp-appbar">${back}<span class="ubp-appbar-title">${title}</span>${rightSlot}</div>
      ${preBody}
      ${body}
      ${footer}
      ${extra}
    </div>`;
}

/** 统一渲染出口：innerHTML 全量替换会重置滚动位置——同视图重绘时还原 scrollTop；
 *  重绘前已在底部则跟随贴底（日志流式视图，如聊天）。跨视图切换按视图键取上次离开时的位置
 *  （战绩列表 → 对局详情 → 返回列表不回顶；首次进入的视图=0，从顶开始）。
 *  同时广播对局视图可见性（phone-ui 据此隐藏灵动岛胶囊——正在看对局时无需提示）。 */
function renderShell(html: string): void {
  const container = _ctx?.container;
  if (!container) return;
  const sameView = _view === _renderedView;
  // 视图键：战绩详情/终局页按对局 id 分记（换一局详情不能继承上一局的滚动位置）
  const viewKey = _view === 'detail' ? `detail:${_detailId}` : _view === 'end' ? `end:${_detailId}` : _view;
  const prevBody = container.querySelector('.ubp-gm-body') as HTMLElement | null;
  const prevTopNow = prevBody?.scrollTop ?? 0;
  const atBottomNow = prevBody ? prevBody.scrollTop + prevBody.clientHeight >= prevBody.scrollHeight - 6 : false;
  // 跨视图：把离开的视图位置记进记忆（同视图重绘由下方 prevTop 原位保全）
  const memo = sameView ? { top: prevTopNow, atBottom: atBottomNow } : _viewScroll.settle(viewKey, prevTopNow, atBottomNow);
  container.innerHTML = html;
  _renderedView = _view;
  // 台词语音：离开对局视图即停；播放中的节点若已不在新 DOM 里也停（防孤儿音频）。
  // 仍在播放且节点还在（对局推进引起的整屏重绘）则不动——节点已由 gmVoiceHtml 按 _gmv 渲染成播放态。
  const gmvAttr = _gmv ? _gmv.key.replace(/"/g, '\\"') : '';
  if (_view !== 'play' || (_gmv && !container.querySelector(`[data-gmv-node="${gmvAttr}"]`))) gmVoiceStop(false);
  emitPhoneEvent('ubp-phone:game-view', _view === 'play');
  const body = container.querySelector('.ubp-gm-body') as HTMLElement | null;
  if (!body) return;
  const prevTop = memo.top;
  if (memo.atBottom) body.scrollTop = body.scrollHeight;
  else body.scrollTop = prevTop;
}

// ─── 记录小工具（主角胜败 / 卧底词对，均解析自 detail 快照） ───

function userWinTag(r: GameRecord): { text: string; cls: string } | null {
  if (r.gameType === 'turtlesoup') {
    const won = r.winnerSide === '参与者阵营';
    return { text: won ? '主角胜' : '主角负', cls: won ? 'green' : 'red' };
  }
  const line = r.detail.split('；').find(l => l.includes('（主角）'));
  if (!line) return null;
  const isWolfSide = r.gameType === 'werewolf' ? /：狼人/.test(line) : /（卧底/.test(line);
  const evilWon = r.winnerSide === '狼人阵营' || r.winnerSide === '卧底';
  const won = isWolfSide === evilWon;
  return { text: won ? '主角胜' : '主角负', cls: won ? 'green' : 'red' };
}

function undercoverWordsLine(r: GameRecord): string {
  const parts = r.detail.split('；');
  const w = (l?: string) => l?.match(/：(.+?)（/)?.[1] || '';
  const spy = w(parts.find(l => /（卧底/.test(l)));
  const good = w(parts.find(l => /（平民/.test(l)));
  if (!spy && !good) return '';
  return `平民词「${good || '?'}」 vs 卧底词「${spy || '?'}」`;
}

function recRowHtml(r: GameRecord): string {
  const wolf = r.gameType === 'werewolf';
  const soup = r.gameType === 'turtlesoup';
  const tag = userWinTag(r);
  const ico = wolf ? '🐺' : soup ? '🐢' : '🕵️';
  const bg = wolf ? 'rgba(180,83,255,0.14)' : soup ? 'rgba(45,212,191,0.13)' : 'rgba(245,158,11,0.13)';
  const snippet = soup
    ? (() => {
      const titleLine = r.detail.split('\n').find(l => l.startsWith('题目：')) || '';
      const title = titleLine.match(/《(.+?)》/)?.[1] || '拟题中';
      const used = titleLine.match(/额度\s*(\d+)\//)?.[1] || '?';
      return `《${title}》· 用了 ${used} 次额度`;
    })()
    : (r.text || '').slice(0, 24) || '总结生成中…';
  return `<div class="ubp-gm-recrow" data-ubp-act="open-detail" data-id="${escapeAttr(r.id)}">
    <div class="ubp-gm-recico" style="background:${bg};">${ico}</div>
    <div class="ubp-gm-flex1">
      <div class="ubp-gm-recname">${escapeHtml(gameTypeName(r.gameType))} · ${escapeHtml(r.winnerSide)}${tag ? ` <span class="ubp-gm-tag ${tag.cls}">${tag.text}</span>` : ''}</div>
      <div class="ubp-gm-recsub">${escapeHtml(snippet)} · ${escapeHtml(storyTimeShort(r.storyTime || ''))}</div>
    </div>
  </div>`;
}

// ─── 单局制：未完成对局摘要 + 两个确认弹层（docs/16 §2.11） ───

/** 未完成对局一行摘要（开局冲突确认层用；单局制下至多一局，无=空串）。 */
function runningGameLine(): string {
  const active = gamesOf(readDataSafe())?.active;
  if (active?.werewolf) {
    const ww = active.werewolf;
    const night = ww.phase === 'seer' || ww.phase === 'wolf' || ww.phase === 'witch';
    return `狼人杀 · 第 ${ww.day} 天${night ? '夜晚' : '白天'}`;
  }
  if (active?.undercover) return `谁是卧底 · 第 ${active.undercover.round} 轮`;
  if (active?.turtleSoup) return `海龟汤 · 第 ${active.turtleSoup.round} 圈`;
  return '';
}

/** 🚪 退出对局弹层：把两条出路一次说清（退出≠结束，避免误以为退出即放弃）。 */
function quitOverlay(): string {
  return `<div class="ubp-gm-overlay">
    <div class="ubp-gm-sheet">
      <div class="ubp-gm-sht">🚪 退出对局</div>
      <div class="ubp-gm-shd">· <b>后台继续</b>：AI 接着推进到轮到你为止，顶部灵动岛随时点回来<br>· <b>结束本局</b>：立即放弃，<b style="color:var(--gmc-red);">不写入对局记录</b>，续玩入口与灵动岛一并消失</div>
      <div class="ubp-gm-row">
        <button class="ubp-gm-btn ghost" data-ubp-act="back-home-confirm">退出 · 后台继续</button>
        <button class="ubp-gm-btn danger" data-ubp-act="quit-confirm">结束本局 · 放弃</button>
      </div>
      <div class="ubp-gm-row" style="margin-top:8px;">
        <button class="ubp-gm-btn ghost" data-ubp-act="quit-cancel">再想想</button>
      </div>
    </div>
  </div>`;
}

/** 单局制冲突确认层：已有未完成对局时开新局——说清放弃代价后再放行。 */
function startConflictOverlay(): string {
  return `<div class="ubp-gm-overlay">
    <div class="ubp-gm-sheet danger">
      <div class="ubp-gm-sht">⚠️ 还有一局没打完</div>
      <div class="ubp-gm-shd">当前进行中：<b>${escapeHtml(runningGameLine())}</b>。同一时间只能打一局 —— 开始新对局会<b style="color:var(--gmc-red);">放弃它</b>（不写入对局记录，续玩入口与灵动岛一并消失）。</div>
      <div class="ubp-gm-row">
        <button class="ubp-gm-btn ghost" data-ubp-act="start-conflict-cancel">取消</button>
        <button class="ubp-gm-btn danger" data-ubp-act="start-game-force">放弃旧局 · 开始新局</button>
      </div>
    </div>
  </div>`;
}

// ─── 首页（mockup 屏1） ───

function seatOf(uc: ActiveUndercover): UndercoverSeat | undefined {
  return uc.players.find(p => p.isUser);
}

function renderHome(): void {
  const games = gamesOf(readDataSafe());
  const uc = games?.active.undercover || null;
  const ww = games?.active.werewolf || null;
  const ts = games?.active.turtleSoup || null;
  const phaseLabelUc = (u: ActiveUndercover) => (u.phase === 'speak' ? '描述' : u.phase === 'vote' ? '投票' : '进行中');
  const resumes: string[] = [];
  if (uc) {
    resumes.push(`<div class="ubp-gm-resumebar" data-ubp-act="resume" data-id="undercover">
      <span class="ubp-gm-dot"></span>
      <div class="ubp-gm-flex1">
        <div class="ubp-gm-rt">谁是卧底 · 第 ${uc.round} 轮 ${phaseLabelUc(uc)}进行中</div>
        <div class="ubp-gm-rs">你是 ${seatOf(uc)?.position ?? '?'}号位 · 点击续玩</div>
      </div>
      <span class="ubp-gm-go2">续玩 ›</span>
    </div>`);
  }
  if (ww) {
    const me = ww.players.find(p => p.isUser);
    const night = ww.phase === 'seer' || ww.phase === 'wolf' || ww.phase === 'witch';
    const phaseWw = ww.phase.startsWith('pk') ? (ww.phase === 'pk-speak' ? 'PK辩解' : 'PK决选') : ww.phase === 'speak' ? '白天发言' : ww.phase === 'vote' ? '投票' : '结算';
    resumes.push(`<div class="ubp-gm-resumebar" data-ubp-act="resume" data-id="werewolf">
      <span class="ubp-gm-dot"></span>
      <div class="ubp-gm-flex1">
        <div class="ubp-gm-rt">狼人杀 · 第 ${ww.day} 天 ${night ? '夜晚' : '白天'} · ${phaseWw}</div>
        <div class="ubp-gm-rs">你是 ${me?.position ?? '?'}号位 ${me ? `· ${escapeHtml(me.role)} · ${me.alive ? '存活' : '出局'}` : ''} · 点击续玩</div>
      </div>
      <span class="ubp-gm-go2">续玩 ›</span>
    </div>`);
  }
  if (ts) {
    const me = ts.players.find(p => p.isUser);
    const phaseTs = ts.phase === 'deal' ? '拟题中' : ts.phase === 'reveal' ? '揭晓中' : '提问中';
    resumes.push(`<div class="ubp-gm-resumebar soup" data-ubp-act="resume" data-id="turtlesoup">
      <span class="ubp-gm-dot"></span>
      <div class="ubp-gm-flex1">
        <div class="ubp-gm-rt">🐢 海龟汤 · 第 ${ts.round} 圈 ${phaseTs}</div>
        <div class="ubp-gm-rs">你是 ${me?.position ?? '?'} 号参与者 · 额度 ${ts.quotaUsed}/${ts.quotaLimit} · 主持人 ${escapeHtml(ts.hostName)}</div>
      </div>
      <span class="ubp-gm-go2">续玩 ›</span>
    </div>`);
  }
  const recs = allRecordsSorted().slice(0, 2);
  renderShell(pageShell('游戏中心', `
    <div class="ubp-gm-body">
      ${resumes.join('')}
      <div class="ubp-gm-gcard werewolf" data-ubp-act="invite" data-id="werewolf">
        <span class="ubp-gm-tag purple ubp-gm-ribbon">6 人局</span>
        <div class="ubp-gm-gico">🐺</div>
        <div class="ubp-gm-gname">狼人杀</div>
        <div class="ubp-gm-gdesc">2狼 · 2民 · 预言家 · 女巫｜悍跳、倒钩、狼队密谋，邀请 5 位好友开一局熟人杀</div>
        <div class="ubp-gm-go">开始 ›</div>
      </div>
      <div class="ubp-gm-gcard undercover" data-ubp-act="invite" data-id="undercover">
        <span class="ubp-gm-tag amber ubp-gm-ribbon">4-6 人局</span>
        <div class="ubp-gm-gico">🕵️</div>
        <div class="ubp-gm-gname">谁是卧底</div>
        <div class="ubp-gm-gdesc">1 卧底 · 3-5 平民｜一句话描述找违和，AI 自选词对，你的演技顶得住吗</div>
        <div class="ubp-gm-go">开始 ›</div>
      </div>
      <div class="ubp-gm-gcard turtlesoup" data-ubp-act="invite" data-id="turtlesoup">
        <span class="ubp-gm-tag soup ubp-gm-ribbon">1+2~5 人</span>
        <div class="ubp-gm-gico">🐢</div>
        <div class="ubp-gm-gname">海龟汤</div>
        <div class="ubp-gm-gdesc">1 位 AI 主持出题 · 你与好友轮流是非提问，一步步还原汤底真相｜额度共享，猜底需扣次，随时可放弃听揭晓</div>
        <div class="ubp-gm-go">开始 ›</div>
      </div>
      <div class="ubp-gm-card" style="padding:4px 12px;" data-ubp-act="records">
        <div class="ubp-gm-row" style="padding:9px 0 5px;">
          <span class="ubp-gm-t13">📜 对局记录</span>
          <span class="ubp-gm-t105">每游戏保留 10 局 ›</span>
        </div>
        ${recs.map(recRowHtml).join('') || '<div class="ubp-gm-recsub" style="padding:6px 0 10px;">还没有打完任何一局</div>'}
      </div>
      <div class="ubp-gm-placeholder">🎲 更多游戏 · 敬请期待</div>
    </div>`));
}

// ─── 邀请（仅好友可选；docs/16 §0.1；mockup 屏2） ───

/** 补位开关 + 状态文案（三款邀请页共用；docs/16 §10）。 */
function npcFillBar(): string {
  const need = inviteNpcNeed();
  const text = !need
    ? '人数已够 · 不需要补位'
    : _npcFill
      ? `还差 <b>${need}</b> 位 · 已自动补 <b>${need}</b> 位临时牌友`
      : `还差 <b>${need}</b> 位才够开局<br><span class="ubp-gm-dim">打开右侧开关可补临时牌友凑桌</span>`;
  const cls = _npcFill && need ? ' on' : need ? '' : ' idle';
  return `<div class="ubp-gm-fillbar${cls}">
    <span class="ubp-gm-fillico">🎭</span>
    <div class="ubp-gm-flex1 ubp-gm-t115">${text}</div>
    <span class="ubp-gm-switch${_npcFill ? ' on' : ''}" data-ubp-act="npc-toggle" title="临时牌友补位">${'<i></i>'}</span>
  </div>`;
}

/** 补位名单预览（开关开启且人数不足时出现；仅本局有效，可换一批）。 */
function npcPreviewCard(): string {
  if (!_npcFill || !_npcPreview.length) return '';
  const rows = _npcPreview.map(name => {
    const p = npcPersona(name);
    return `<div class="ubp-gm-friendrow npc">
      ${avatarHtml(name)}
      <div class="ubp-gm-flex1">
        <div class="ubp-gm-t13">${escapeHtml(name)} <span class="ubp-gm-npctag">🎭</span></div>
        <div class="ubp-gm-t105">${escapeHtml(p ? `${p.personality} · ${p.languageStyle}` : '临时凑桌的陌生人')}</div>
      </div>
    </div>`;
  }).join('');
  return `<div class="ubp-gm-card" style="padding:4px 12px;">
    <div class="ubp-gm-row" style="padding:9px 0 5px;">
      <span class="ubp-gm-t125b">🎭 临时牌友</span>
      <button class="ubp-gm-btn ghost sm" data-ubp-act="npc-reroll" style="margin-left:auto;">🎲 换一批</button>
    </div>
    ${rows}
    <div class="ubp-gm-dim" style="padding:4px 4px 9px;">· 随机生成，仅本局有效，打完即散 · 不影响对局外的任何内容</div>
  </div>`;
}

function renderInvite(): void {
  if (_inviteGame === 'turtlesoup') {
    renderSoupInvite();
    return;
  }
  syncNpcPreview();
  const isWolf = _inviteGame === 'werewolf';
  const boardDesc = isWolf
    ? '2 狼人 · 2 村民 · 1 预言家 · 1 女巫｜女巫首夜不可自救，同夜一瓶药｜放逐需有效票多于弃票，平票 PK 后二次平票流票'
    : '1 卧底 · 3-5 平民｜AI 主持人生成词对并私发｜最高票出局当场亮身份，平票流轮｜存活≤3 且卧底存活=卧底胜';
  const roster = getRoster();
  const data = readDataSafe();
  const contacts = mergeCustomContacts(roster, data.customContacts || [])
    .filter(c => c.name !== roster.protagonistName && isFriend(data, c.name));
  const rows = contacts.map(c => {
    const on = _invitePicked.has(c.name);
    return `<div class="ubp-gm-friendrow" data-ubp-act="toggle-friend" data-id="${escapeAttr(c.name)}">
      ${avatarHtml(c.name)}
      <div class="ubp-gm-flex1">
        <div class="ubp-gm-t13">${escapeHtml(c.name)}</div>
        <div class="ubp-gm-t105">${escapeHtml(c.identity || c.brief || '好友')}</div>
      </div>
      <span class="ubp-gm-checkbox${on ? ' on' : ''}"></span>
    </div>`;
  }).join('');
  renderShell(pageShell(inviteTitle(), `
    <div class="ubp-gm-body${_startConflict ? ' blur' : ''}">
      <div class="ubp-gm-card">
        <div class="ubp-gm-t125b" style="margin-bottom:5px;">${isWolf ? '板子 · 6 人标准场' : '板子 · 4-6 人灵活场'}</div>
        <div class="ubp-gm-muted">${boardDesc}</div>
      </div>
      ${npcFillBar()}
      <div class="ubp-gm-card" style="padding:4px 12px;">
        ${rows || '<div class="ubp-gm-dim" style="padding:18px 8px;text-align:center;">还没有可邀请的好友<br>打开补位开关即可与临时牌友开局</div>'}
      </div>
      <div data-npc-slot>${npcPreviewCard()}</div>
      <div class="ubp-gm-dim">· 仅可邀请已加为好友的通讯录角色<br>· 临时牌友为随机生成的陌生人，仅本局有效、打完即散<br>· 头像取自通讯录，缺省渐变首字母兜底 · 座次开局随机分配</div>
    </div>`, `
    <div class="ubp-gm-ctl"><button class="ubp-gm-btn primary block" data-ubp-act="start-game" ${inviteValid() && !_starting ? '' : 'disabled'}>${startBtnLabel()}</button></div>`,
    'back-home', '', '', _startConflict ? startConflictOverlay() : ''));
}

/** 本品是否可开局（补位开关按需计入补位人数）。 */
function inviteValid(): boolean {
  const min = _inviteGame === 'werewolf' ? 5 : _inviteGame === 'turtlesoup' ? 1 : 3;
  return _invitePicked.size + (_npcFill ? inviteNpcNeed() : 0) >= min;
}

// ─── 海龟汤邀请（mockup 屏2：类型 chips + 上限 stepper + 主持人单选 + 参与者多选） ───

function soupInviteValid(): boolean {
  // 主持人必须是真实好友；参与者人数不足可由补位开关补齐（docs/16 §10）
  if (!_soupHost) return false;
  return _invitePicked.size + (_npcFill ? inviteNpcNeed() : 0) >= 1;
}

/** 邀请页标题（计数随勾选变化；refreshInviteChrome 原地重写，不重绘）。 */
function inviteTitle(): string {
  if (_inviteGame === 'turtlesoup') return `🐢 邀请汤局（参与者 ${1 + _invitePicked.size}/5 · 含我）`;
  const isWolf = _inviteGame === 'werewolf';
  return `${isWolf ? '🐺' : '🕵️'} 邀请好友（${_invitePicked.size}/${isWolf ? '5' : '3-5'}）`;
}

/** 确认按钮文案（含补位人数提示；开局中为 loading 态）。 */
function startBtnLabel(): string {
  if (_starting) {
    return _inviteGame === 'turtlesoup'
      ? '<span class="ubp-gm-spin soup"></span>正在开局 · 主持人拟题中…'
      : '<span class="ubp-gm-spin"></span>正在开局 · 主持人准备中…';
  }
  const extra = _npcPreview.length ? `（+${_npcPreview.length} 临时牌友）` : '';
  return _inviteGame === 'turtlesoup' ? `🧉 确认汤局 · 开始拟题${extra}` : `确认邀请 · 开始对局${extra}`;
}

/** 补位条与补位名单卡原地刷新（勾选变化后人数变了，避免整页重绘丢滚动位）。 */
function refreshNpcFillChrome(): void {
  const container = _ctx?.container;
  if (!container) return;
  syncNpcPreview();
  const bar = container.querySelector('.ubp-gm-fillbar');
  if (bar) bar.outerHTML = npcFillBar();
  const slot = container.querySelector('[data-npc-slot]');
  if (slot) slot.innerHTML = npcPreviewCard();
}

/** 邀请交互的原地刷新（免全量重绘闪烁）：标题计数 + 确认按钮可用性。 */
function refreshInviteChrome(): void {
  const container = _ctx?.container;
  if (!container) return;
  const title = container.querySelector('.ubp-appbar-title');
  if (title) title.textContent = inviteTitle();
  if (_starting) return;
  const btn = container.querySelector('.ubp-gm-ctl [data-ubp-act="start-game"]') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = !(_inviteGame === 'turtlesoup' ? soupInviteValid() : inviteValid());
    btn.innerHTML = startBtnLabel();
  }
}

/** 海龟汤单行状态原地刷新：host 高亮 / 🪷 按钮态 / checkbox 勾选与禁用。 */
function refreshSoupRow(name: string): void {
  const container = _ctx?.container;
  if (!container) return;
  for (const row of Array.from(container.querySelectorAll<HTMLElement>('.ubp-gm-friendrow[data-soup-row]'))) {
    if (row.dataset.soupRow !== name) continue;
    const isHost = _soupHost === name;
    row.classList.toggle('host', isHost);
    const hostBtn = row.querySelector('.ubp-gm-hostbtn');
    if (hostBtn) hostBtn.classList.toggle('on', isHost);
    const box = row.querySelector('.ubp-gm-checkbox');
    if (box) {
      box.classList.toggle('on', _invitePicked.has(name));
      box.classList.toggle('dis', isHost);
    }
  }
}

function refreshSoupChips(): void {
  const container = _ctx?.container;
  if (!container) return;
  for (const chip of Array.from(container.querySelectorAll<HTMLElement>('.ubp-gm-chip'))) {
    chip.classList.toggle('on', chip.dataset.id === _soupCategory);
  }
}

function refreshSoupStepper(): void {
  const container = _ctx?.container;
  if (!container) return;
  const num = container.querySelector('.ubp-gm-num');
  if (num) num.textContent = String(_soupQuota);
  const minus = container.querySelector('[data-ubp-act="soup-quota-minus"]') as HTMLButtonElement | null;
  const plus = container.querySelector('[data-ubp-act="soup-quota-plus"]') as HTMLButtonElement | null;
  if (minus) minus.disabled = _soupQuota <= SOUP_QUOTA_MIN;
  if (plus) plus.disabled = _soupQuota >= SOUP_QUOTA_MAX;
}

/** 进入海龟汤邀请页：重置类型/额度/主持人选择（勾选域由调用方清空）。 */
function resetSoupInviteState(): void {
  _soupCategory = '不限';
  _soupQuota = SOUP_QUOTA_DEFAULT;
  _soupHost = '';
  _soupGuessOpen = false;
  _soupGiveupOpen = false;
}

function renderSoupInvite(): void {
  syncNpcPreview();
  const roster = getRoster();
  const data = readDataSafe();
  const protagonist = roster.protagonistName;
  const contacts = mergeCustomContacts(roster, data.customContacts || [])
    .filter(c => c.name !== protagonist && isFriend(data, c.name));
  // 单列表双控件（用户定案：主持/参与两份名单合一免冗长）——行尾 🪷=设主持人（唯一，与参与互斥），
  // 整行点击=勾选参与者；行状态经 refreshSoupRow 原地更新（免全量重绘闪烁），host 行保留青绿高亮
  const rows = contacts.map(c => {
    const isHost = c.name === _soupHost;
    return `<div class="ubp-gm-friendrow${isHost ? ' host' : ''}" data-ubp-act="soup-toggle-participant" data-id="${escapeAttr(c.name)}" data-soup-row="${escapeAttr(c.name)}">
      ${avatarHtml(c.name)}
      <div class="ubp-gm-flex1">
        <div class="ubp-gm-t13">${escapeHtml(c.name)}</div>
        <div class="ubp-gm-t105">${escapeHtml(c.identity || c.brief || '好友')}</div>
      </div>
      <button class="ubp-gm-hostbtn${isHost ? ' on' : ''}" data-ubp-act="soup-pick-host" data-id="${escapeAttr(c.name)}" title="设为主持人">🪷</button>
      <span class="ubp-gm-checkbox${_invitePicked.has(c.name) ? ' on' : ''}${isHost ? ' dis' : ''}"></span>
    </div>`;
  }).join('');
  const chips = SOUP_CATEGORIES.map(cat =>
    `<button class="ubp-gm-chip${_soupCategory === cat ? ' on' : ''}" data-ubp-act="soup-cat" data-id="${cat}">${cat}</button>`).join('');
  renderShell(pageShell(inviteTitle(), `
    <div class="ubp-gm-body ubp-gm-soupinv${_startConflict ? ' blur' : ''}">
      <div class="ubp-gm-card">
        <div class="ubp-gm-seclabel">🧉 汤局设置</div>
        <div class="ubp-gm-dim" style="margin-bottom:6px;">题目类型（AI 主持按此拟题）</div>
        <div class="ubp-gm-chips">${chips}</div>
        <div class="ubp-gm-dim" style="margin:10px 0 6px;">提问上限（所有参与者共享，提问与猜底都计次）</div>
        <div class="ubp-gm-stepper">
          <button class="ubp-gm-stp" data-ubp-act="soup-quota-minus" ${_soupQuota <= SOUP_QUOTA_MIN ? 'disabled' : ''}>−</button>
          <div class="ubp-gm-num">${_soupQuota}</div>
          <button class="ubp-gm-stp" data-ubp-act="soup-quota-plus" ${_soupQuota >= SOUP_QUOTA_MAX ? 'disabled' : ''}>+</button>
          <div class="ubp-gm-dim" style="flex:1;">范围 ${SOUP_QUOTA_MIN} ~ ${SOUP_QUOTA_MAX} 次<br>耗尽后主持人直接揭晓汤底</div>
        </div>
      </div>
      ${npcFillBar()}
      <div class="ubp-gm-card" style="padding:4px 12px;">
        <div class="ubp-gm-seclabel" style="padding-top:10px;">🪷🧩 主持与参与者（我 + 1~4 位好友参与）</div>
        <div class="ubp-gm-friendrow" style="cursor:default;">
          ${avatarHtml(protagonist)}
          <div class="ubp-gm-flex1">
            <div class="ubp-gm-t13">我</div>
            <div class="ubp-gm-t105">主角本人 · 固定参与</div>
          </div>
          <span class="ubp-gm-checkbox fixed soup-fixed"></span>
        </div>
        ${rows || '<div class="ubp-gm-dim" style="padding:12px 8px;">还没有可邀请的好友<br>（主持人必须是真实好友，请先去微信添加）</div>'}
        <div class="ubp-gm-dim" style="padding:6px 4px 9px;">· 点 🪷 设为主持人（唯一，与参与者互斥）· 点整行勾选参与者<br>· 参与者不足时可打开上方开关补临时牌友，仅本局有效</div>
      </div>
      <div data-npc-slot>${npcPreviewCard()}</div>
      <div class="ubp-gm-dim">· 只能提是非题；主持人只答「是 / 不是 / 是也不是 / 不重要」<br>· 提问与猜底共用额度；猜底需覆盖汤底全部关键点才算还原<br>· 轮到你时可提问、猜底或跳过；AI 队友推理到位也会主动抢答<br>· 对局中随时可 🏳️ 放弃，主持人立即揭晓汤底 · 仅可邀请已加好友的角色</div>
    </div>`, `
    <div class="ubp-gm-ctl"><button class="ubp-gm-btn soup block" data-ubp-act="start-game" ${soupInviteValid() && !_starting ? '' : 'disabled'}>${startBtnLabel()}</button></div>`,
    'back-home', '', '', _startConflict ? startConflictOverlay() : ''));
}

// ─── 对局视图分发 ───

function renderPlay(): void {
  const games = gamesOf(readDataSafe());
  const ww = games?.active.werewolf || null;
  const uc = games?.active.undercover || null;
  const ts = games?.active.turtleSoup || null;
  // 多游戏并存时渲染最近开局的一局（旧局链后台等待，不在 UI 抢占）
  const newest = [
    ww ? { at: ww.startedAt, go: () => renderWerewolfPlay(ww) } : null,
    uc ? { at: uc.startedAt, go: () => renderUndercoverPlay(uc) } : null,
    ts ? { at: ts.startedAt, go: () => renderSoupPlay(ts) } : null,
  ].filter((x): x is { at: number; go: () => void } => x !== null)
    .sort((a, b) => b.at - a.at)[0];
  if (newest) {
    newest.go();
    return;
  }
  _view = 'home';
  renderHome();
}

// ─── 谁是卧底对局（mockup 屏9/10） ───

function seatCell(p: { position: number; name: string; isUser: boolean; alive: boolean }, opts: { pickable: boolean; act: string; picked: boolean; badge?: string; badgeCls?: string; dead?: boolean; selCls?: string }): string {
  return `<div class="ubp-gm-seat${p.isUser ? ' me' : ''}${opts.dead ? ' dead' : ''}${opts.pickable ? ' pick' : ''}${opts.picked ? ` sel${opts.selCls || ''}` : ''}"
    ${opts.pickable ? `data-ubp-act="${opts.act}" data-id="${p.position}"` : ''}>
    ${opts.badge ? `<span class="ubp-gm-badge ${opts.badgeCls || ''}">${opts.badge}</span>` : ''}
    ${p.isUser ? '' : `<span class="ubp-gm-npcpin">${isNpcParticipant(p.name) ? '🎭' : ''}</span>`}
    ${avatarHtml(p.name)}
    <div class="ubp-gm-nm">${p.isUser ? '我' : escapeHtml(p.name)}</div>
    <div class="ubp-gm-ps">${p.position}号位</div>
  </div>`;
}

function sysLogHtml(text: string): string {
  const cls = text.startsWith('🌙') ? ' night' : text.startsWith('💀') || text.includes('死亡') ? ' death' : '';
  return `<div class="ubp-gm-log"><div class="ubp-gm-sys${cls}">${escapeHtml(text).replace(/\n/g, '<br>')}</div></div>`;
}

function speechDescline(name: string, pos: number | undefined, text: string, turn = false): string {
  const who = name === '?' ? `${pos}号位` : name;
  return `<div class="ubp-gm-descline${turn ? ' turn' : ''}">${avatarHtml(name)}
    <div class="ubp-gm-flex1"><div class="ubp-gm-who">🗣️ ${escapeHtml(who)} · ${pos}号位${npcMark(name)}</div>${escapeHtml(text)}</div>
  </div>`;
}

/** 卧底日志一条发言：语音条目走语音条（真实角色），其余走原文字行。 */
function undercoverSpeechHtml(uc: ActiveUndercover, e: GameReplayEntry, idx: number): string {
  const name = uc.players.find(p => p.position === e.pos)?.name || '?';
  if (!gmVoiceOn(e)) return speechDescline(name, e.pos, e.text);
  const who = name === '?' ? `${e.pos}号位` : name;
  return `<div class="ubp-gm-descline">${avatarHtml(name)}<div class="ubp-gm-flex1">${gmVoiceHtml({
    key: gmvKey('undercover', uc.session, idx), idx, sender: name,
    who: `🗣️ ${escapeHtml(who)} · ${e.pos}号位`, text: gmVoiceText(e),
    emotion: e.voiceEmotion || '', delivery: e.voiceDelivery || '', rev: false,
  })}</div></div>`;
}

function errorFooter(): string {
  return `<div class="ubp-gm-ctlcol">
    <div class="ubp-gm-sys death">${escapeHtml(lastGameError())}</div>
    <div style="display:flex;gap:8px;">
      <button class="ubp-gm-btn primary" data-ubp-act="retry" style="flex:1;">重试当前步骤</button>
      <button class="ubp-gm-btn" data-ubp-act="abort-gen" style="flex:1;">终止</button>
    </div>
  </div>`;
}

/** 投票阶段的轻量错误行：AI 票失败不阻塞玩家本地投票（完整重试条仅在玩家无可操作时出现）。 */
function errorLineHtml(): string {
  return `<div class="ubp-gm-sys death" style="margin-bottom:8px;">${escapeHtml(lastGameError())}</div>`;
}

function genFooter(text: string): string {
  return `<div class="ubp-gm-genbar"><span>${text}</span><button data-ubp-act="abort-gen">终止</button></div>`;
}

function waitFooter(text: string): string {
  return `<div class="ubp-gm-ctl"><span class="ubp-gm-dim" style="flex:1;text-align:center;">${text}</span></div>`;
}

function renderUndercoverPlay(uc: ActiveUndercover): void {
  const container = _ctx!.container;
  const session = uc.session;
  const me = seatOf(uc);
  const voting = uc.phase === 'vote' && !!me && me.alive && !me.voteDone;
  const speaking = uc.phase === 'speak' && uc.players[uc.currentSpeaker]?.isUser === true;
  const busy = hasGameGeneration();
  const err = lastGameError();

  // 席位阵（仅投票阶段出现；角标=收到票数实时票型）
  const tally = (pos: number) => uc.players.filter(x => x.votedFor === pos).length;
  const voteDoneCount = uc.players.filter(p => p.alive && p.voteDone).length;
  const voteTotal = uc.players.filter(p => p.alive).length;
  const seats = uc.players.map(p => {
    const badge = !p.alive ? { text: '出局', cls: 'gray' }
      : uc.phase === 'vote' && tally(p.position) > 0 ? { text: `${tally(p.position)} 票`, cls: '' }
      : uc.phase === 'vote' && p.voteDone && p.votedFor === null ? { text: '弃票', cls: 'gray' } : null;
    return seatCell(p, {
      pickable: Boolean(voting && p.alive),
      act: 'pick-seat',
      picked: _votePickPos === p.position,
      badge: badge?.text,
      badgeCls: badge?.cls,
      dead: !p.alive,
    });
  }).join('');
  const seatGrid = uc.phase === 'vote'
    ? `<div class="ubp-gm-phase">🗳️ 投票进度：${voteDoneCount}/${voteTotal} 人已完成投票 · 点击你怀疑的卧底${voting ? '' : ' · 我已提交'}</div><div class="ubp-gm-seatgrid">${seats}</div>`
    : '';

  // 日志流（过程隔离：仅 system/speech/vote；think/situation/private/action 不渲染）
  const logs: string[] = [];
  for (let i = 0; i < uc.entries.length; i++) {
    const e = uc.entries[i];
    if (e.type === 'system' || e.type === 'vote') logs.push(sysLogHtml(e.text));
    else if (e.type === 'speech') logs.push(undercoverSpeechHtml(uc, e, i));
  }

  // 词语大卡（仅自己的词）
  const wordCard = me && me.word
    ? `<div class="ubp-gm-wordcard">
        <div class="ubp-gm-wordkey">🔑 你的词语</div>
        <div class="ubp-gm-word">${escapeHtml(me.word)}</div>
        <div class="ubp-gm-wordsub">主持人没有公布身份 · 你的词与大家不符时，你才是卧底</div>
      </div>`
    : `<div class="ubp-gm-wordcard"><div class="ubp-gm-wordsub">⏳ AI 主持人正在生成词语并悄悄分发…</div></div>`;

  let footer: string;
  // 投票优先于错误条：AI 票失败只降级为提示行，玩家的本地投票不被阻塞（重试走座位上方进度+错误行）
  if (voting) footer = `${err ? errorLineHtml() : ''}
    <div class="ubp-gm-ctl">
      <button class="ubp-gm-btn ghost" data-ubp-act="vote-skip" style="flex:1;">弃票</button>
      <button class="ubp-gm-btn primary" data-ubp-act="vote-confirm" style="flex:2;" ${_votePickPos ? '' : 'disabled'}>${_votePickPos ? `投票给 ${_votePickPos} 号位` : '确认投票'}</button>
    </div>`;
  else if (err) footer = errorFooter();
  else if (speaking) footer = `
    <div class="ubp-gm-inputbar">
      <input id="ubp-gm-speak-input" type="text" placeholder="用一句话描述你的词（严禁说出词与字数）…" autocomplete="off">
      <button class="ubp-gm-btn amber" data-ubp-act="speak-send" style="flex:none;">发言</button>
      <button class="ubp-gm-btn ghost" data-ubp-act="speak-skip" style="flex:none;">跳过</button>
    </div>`;
  else if (busy) footer = genFooter(uc.phase === 'vote' ? 'AI 玩家们正在推演投票…' : `${uc.players[uc.currentSpeaker]?.name || 'AI'} 正在构思描述…`);
  else if (uc.phase === 'vote') footer = `<div class="ubp-gm-ctl"><button class="ubp-gm-btn" data-ubp-act="retry" style="flex:1;">重试未完成的投票</button></div>`;
  else footer = waitFooter('等待其他玩家…');

  renderShell(pageShell(`🕵️ 第 ${uc.round} 轮 · ${uc.phase === 'speak' ? '描述' : '投票'}`, `
    <div class="ubp-gm-body${_quitOpen ? ' blur' : ''}">
      ${wordCard}
      ${seatGrid}
      ${logs.join('')}
      <div class="ubp-gm-dim" style="margin-top:6px;">🔒 过程界面：只看得到公开发言——他人的思考、局势分析与身份，终局和「全景复盘」才解锁。</div>
    </div>`, footer, 'back-home-confirm', '', QUIT_BTN, _quitOpen ? quitOverlay() : ''));

  bindSpeakInput('#ubp-gm-speak-input', () => {
    const input = container.querySelector('#ubp-gm-speak-input') as HTMLInputElement | null;
    if (input && input.value.trim()) submitUndercoverSpeech(session, input.value.trim());
  });
}

function bindSpeakInput(selector: string, onSend: () => void): void {
  const container = _ctx?.container;
  if (!container) return;
  const input = container.querySelector(selector) as HTMLInputElement | null;
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onSend();
      }
    });
  }
}

// ─── 狼人杀对局（夜晚三步/白天/投票/PK；docs/16 §3.5；mockup 屏3-7） ───

const ROLE_EMOJI: Record<string, string> = { '狼人': '🐺', '村民': '👤', '预言家': '🔮', '女巫': '🧪' };

function speechBrow(name: string, pos: number | undefined, text: string): string {
  return `<div class="ubp-gm-brow">${avatarHtml(name)}<div class="ubp-gm-bubble"><div class="ubp-gm-who">🗣️ ${escapeHtml(name)} · ${pos}号位${npcMark(name)}</div>${escapeHtml(text)}</div></div>`;
}

/** 狼人杀日志一条发言：语音条目走语音条（真实角色），其余走原文字气泡。 */
function werewolfSpeechHtml(ww: ActiveWerewolf, e: GameReplayEntry, idx: number): string {
  const speaker = ww.players.find(p => p.position === e.pos);
  const name = speaker ? (speaker.isUser ? '我' : speaker.name) : '?';
  if (!gmVoiceOn(e)) return speechBrow(name, e.pos, e.text);
  return `<div class="ubp-gm-brow">${avatarHtml(name)}${gmVoiceHtml({
    key: gmvKey('werewolf', ww.session, idx), idx, sender: name,
    who: `🗣️ ${escapeHtml(name)} · ${e.pos}号位`, text: gmVoiceText(e),
    emotion: e.voiceEmotion || '', delivery: e.voiceDelivery || '', rev: false,
  })}</div>`;
}

function renderWerewolfPlay(ww: ActiveWerewolf): void {
  const container = _ctx!.container;
  const session = ww.session;
  const me = ww.players.find(p => p.isUser);
  const busy = hasGameGeneration();
  const err = lastGameError();
  const isNight = ww.phase === 'seer' || ww.phase === 'wolf' || ww.phase === 'witch';
  const iAmSeer = ww.phase === 'seer' && me?.role === '预言家' && me.alive === true;
  const iAmWolf = ww.phase === 'wolf' && me?.role === '狼人' && me.alive === true;
  const iAmWitch = ww.phase === 'witch' && me?.role === '女巫' && me.alive === true;
  const myTurnSpeak = ww.phase === 'speak' && ww.players[ww.currentSpeaker]?.isUser === true;
  const pendingWords = pendingLastWordsInfo();
  const myTurnPk = ww.phase === 'pk-speak' && ww.pkCandidates.includes(ww.players[ww.currentSpeaker]?.position ?? 0) && ww.players[ww.currentSpeaker]?.isUser === true;
  const voting = (ww.phase === 'vote' || ww.phase === 'pk-vote') && !!me && me.alive && !me.voteDone
    && !(ww.phase === 'pk-vote' && ww.pkCandidates.includes(me.position));

  // 底牌大卡（mockup 屏3：自己的身份只有自己可见）
  const roleCls = me?.role === '狼人' ? 'role-wolf' : me?.role === '预言家' ? 'role-seer' : me?.role === '女巫' ? 'role-witch' : 'role-good';
  const roleSub = me?.role === '狼人'
    ? '狼队目标：屠城（好人生存≤1）<br>白天伪装好人 · 夜晚与队友密谋刀人（可自刀骗药）'
    : me?.role === '预言家'
      ? '每晚验一人 · 白天自主决定是否跳身份'
      : me?.role === '女巫'
        ? '解药 💚 与毒药 ❤️ 各一瓶<br>同一夜只能用一瓶 · 首夜不可自救'
        : '用发言帮好人抓出全部狼人';
  const roleCard = me ? `
    <div class="ubp-gm-rolecard ${roleCls}">
      ${avatarHtml(me.name || '我')}
      <div class="ubp-gm-rolename">${ROLE_EMOJI[me.role] || ''} ${escapeHtml(me.role)}</div>
      <div class="ubp-gm-muted" style="margin-top:6px;">${roleSub}</div>
    </div>` : '';

  // 阶段横线（mockup .phase）；投票阶段带实时完成进度（x/y 人已完成投票）
  const voteStats = (() => {
    if (ww.phase !== 'vote' && ww.phase !== 'pk-vote') return null;
    const voters = ww.players.filter(p => p.alive && !(ww.phase === 'pk-vote' && ww.pkCandidates.includes(p.position)));
    return { done: voters.filter(p => p.voteDone).length, total: voters.length };
  })();
  const phaseLine = isNight
    ? `<div class="ubp-gm-phase">🌙 夜晚 · ${ww.phase === 'seer' ? '预言家请睁眼' : ww.phase === 'wolf' ? '狼人请睁眼' : '女巫请睁眼'}</div>`
    : ww.phase === 'vote' || ww.phase === 'pk-vote'
      ? `<div class="ubp-gm-phase">🗳️ ${ww.phase === 'pk-vote' ? '决选 · ' : ''}投票进度：${voteStats!.done}/${voteStats!.total} 人已完成投票 · 点击头像投票或弃票</div>`
      : ww.phase === 'pk-speak'
        ? '<div class="ubp-gm-phase">⚖️ 平票 PK · 轮流辩解</div>'
        : '';

  // 日志流（狼视角加 private 紫流；其余同隔离口径）
  const iSeeWolfPrivate = me?.role === '狼人';
  const logs: string[] = [];
  if (pendingWords && pendingWords.session === session) {
    logs.push(sysLogHtml(`💬 请发表你的遗言（${pendingWords.cause === '放逐' ? '被投票放逐' : '昨夜出局'}）：`));
  }
  for (let i = 0; i < ww.entries.length; i++) {
    const e = ww.entries[i];
    if (e.type === 'system' || e.type === 'vote') {
      logs.push(sysLogHtml(e.text));
    } else if (e.type === 'speech') {
      logs.push(werewolfSpeechHtml(ww, e, i));
    } else if (e.type === 'private' && iSeeWolfPrivate) {
      const speaker = ww.players.find(p => p.position === e.pos);
      logs.push(`<div class="ubp-gm-brow">${avatarHtml(speaker?.name || '狼队友')}<div class="ubp-gm-wolfpriv"><b>🐺 狼队密谋 · ${speaker ? `${e.pos}号位 ${escapeHtml(speaker.isUser ? '我' : speaker.name)}` : ''}：</b><br>${escapeHtml(e.text)}</div></div>`);
    }
  }

  // 席位阵工具（badge=收到票数实时票型；pickedPos=两步选择的当前选中）
  const tally = (pos: number) => ww.players.filter(x => x.votedFor === pos).length;
  const seatGridHtml = (act: string, pick: (p: WerewolfSeat) => boolean, opts: { tallyMode?: boolean; showChecked?: boolean; only?: (p: WerewolfSeat) => boolean; pickedPos?: number; pickedBadge?: boolean; selCls?: string } = {}): string =>
    `<div class="ubp-gm-seatgrid" style="margin-bottom:4px;">${ww.players.filter(p => !opts.only || opts.only(p)).map(p => {
      const picked = (opts.pickedPos ?? 0) === p.position;
      const checked = Boolean(ww.seerChecked[String(p.position)]);
      const badge = picked && opts.pickedBadge ? { text: '已选中', cls: 'amber' }
        : !p.alive ? { text: '出局', cls: 'gray' }
        : opts.showChecked && checked ? { text: '已验', cls: 'purple' }
        : opts.tallyMode && tally(p.position) > 0 ? { text: `${tally(p.position)} 票`, cls: '' }
        : opts.tallyMode && p.voteDone && p.votedFor === null ? { text: '弃票', cls: 'gray' } : null;
      return seatCell(p, {
        pickable: p.alive && pick(p),
        act,
        picked,
        selCls: opts.selCls,
        badge: badge?.text,
        badgeCls: badge?.cls,
        dead: !p.alive,
      });
    }).join('')}</div>`;

  // 狼人夜：战术板 + 刀口卡（mockup 屏4 / V3 交互稿 A）
  let wolfCards = '';
  if (iAmWolf) {
    const aiMate = ww.players.find(p => p.role === '狼人' && !p.isUser);
    const draft = werewolfWolfDraft();
    const tactics = draft.tactics || { ai: '', user: '', custom: '' };
    // 选中态渲染本地选择（_wolfAiTactic/_wolfUserTactic），store 值只作进入时兜底——点「确定」才落库
    const selAi = _wolfAiTactic || tactics.ai || '';
    const selUser = _wolfUserTactic || tactics.user || '';
    const tacticRowHtml = (label: string, side: 'ai' | 'user') => {
      const sel = side === 'ai' ? selAi : selUser;
      return `
      <div class="ubp-gm-tactic-label">${label}</div>
      <div class="ubp-gm-tactic-row">${['悍跳', '冲锋', '倒钩'].map(t => `<button class="ubp-gm-tactic-btn${sel === t ? ' on' : ''}" data-ubp-act="wolf-tactic" data-side="${side}" data-id="${t}">${t}</button>`).join('')}</div>`;
    };
    const killPick = (p: WerewolfSeat) => p.position === me?.position || p.role !== '狼人'; // 自刀放行，狼队友仍禁选
    wolfCards = `
      <div class="ubp-gm-tactic-card">
        <div class="ubp-gm-tactic-title">⚡ 安排战术（单选，不可与队友重复）</div>
        ${tacticRowHtml(`队友 ${aiMate ? `${aiMate.position}号位 ${escapeHtml(aiMate.name)}` : '（无存活队友）'} 执行：`, 'ai')}
        ${tacticRowHtml('我自己执行：', 'user')}
        <div class="ubp-gm-inputbar" style="border:none;background:transparent;padding:8px 0 0;">
          <input id="ubp-gm-tactic-custom" type="text" placeholder="补充具体战术细节或指令…" value="${escapeAttr(tactics.custom)}" autocomplete="off">
          <button class="ubp-gm-btn primary" data-ubp-act="wolf-tactic-confirm" style="flex:none;">确定</button>
        </div>
      </div>
      <div class="ubp-gm-card">
        <div class="ubp-gm-t13" style="margin-bottom:8px;">🔪 选择今晚的刀口（点击头像）</div>
        ${seatGridHtml('wolf-kill-pick', _wolfKillArmed ? killPick : () => false, { only: p => p.alive && (p.position === me?.position || p.role !== '狼人'), pickedPos: _wolfKillPick, pickedBadge: true })}
        <div class="ubp-gm-dim">${_wolfKillArmed ? '点选后经底部「确认刀口」生效 · 再点一次可改选 · 可点自己=自刀骗药' : '先「确定」战术后解锁刀口点选'}</div>
      </div>`;
  }

  // 预言家夜：查验卡（两步确认；不可重复验人）
  const seerCard = iAmSeer ? `
    <div class="ubp-gm-card">
      <div class="ubp-gm-t13" style="margin-bottom:8px;">🔮 选择查验目标（点击头像）</div>
      ${seatGridHtml('seer-pick', p => p.position !== me?.position && !ww.seerChecked[String(p.position)], { showChecked: true, pickedPos: _seerPick, pickedBadge: true, selCls: ' seer-sel' })}
      <div class="ubp-gm-dim">紫标=已验不可重复 · 青环=当前选中，确认后生效</div>
    </div>` : '';

  // 女巫夜：药瓶卡 + 毒药点选（同夜一瓶；毒不自毒）
  let witchCards = '';
  if (iAmWitch) {
    const victim = ww.nightKillPos ? ww.players.find(p => p.position === ww.nightKillPos) : null;
    const firstNightSelf = ww.day === 1 && ww.nightKillPos === me?.position;
    const canSave = !ww.witchUsedAntidote && Boolean(victim) && !firstNightSelf;
    const canPoison = !ww.witchUsedPoison;
    witchCards = `
      <div class="ubp-gm-tactic-card">
        <div class="ubp-gm-tactic-title">🧪 女巫行动（同夜只能用一瓶药）</div>
        <div class="ubp-gm-muted">药瓶状态：解药 ${ww.witchUsedAntidote ? '已用' : '可用'} · 毒药 ${ww.witchUsedPoison ? '已用' : '可用'}<br>今晚刀口：${victim ? `${victim.position}号位 ${escapeHtml(victim.name)}${victim.isUser ? '（你自己！）' : ''}` : '无人中刀（平安夜）'}</div>
        ${firstNightSelf ? '<div class="ubp-gm-sys death" style="margin-top:8px;">首夜中刀且不可自救！可用毒药盲毒带走最可疑的人。</div>' : ''}
        <div class="ubp-gm-tactic-row" style="margin-top:8px;">
          <button class="ubp-gm-tactic-btn${_witchSave ? ' on green' : ''}" data-ubp-act="witch-toggle-save" ${canSave ? '' : 'disabled'}>💚 用解药救 ${victim && !firstNightSelf ? escapeHtml(victim.name) : '（今晚无人可救）'}</button>
        </div>
        ${canPoison ? `<div class="ubp-gm-tactic-label">毒药目标：${_witchPoisonPos ? `${_witchPoisonPos} 号位（点下方头像可改）` : '点下方头像选人，或不用毒'}</div>` : ''}
      </div>
      ${canPoison ? `
      <div class="ubp-gm-card">
        <div class="ubp-gm-t13" style="margin-bottom:8px;">❤️ 毒药目标（点击头像）</div>
        ${seatGridHtml('poison-pick', p => p.position !== me?.position, { pickedPos: _witchPoisonPos, pickedBadge: true })}
        <div class="ubp-gm-dim">毒药不可对自己使用 · 选中后经底部「确认用药」生效</div>
      </div>` : ''}`;
  }

  // 投票（含 PK 决选）：票型角标 + 结算规则卡（mockup 屏6）
  const showVoteGrid = ww.phase === 'vote' || ww.phase === 'pk-vote';
  const voteGrid = showVoteGrid ? seatGridHtml('pick-seat', () => true, { tallyMode: true }) : '';
  const voteCard = showVoteGrid ? `
    <div class="ubp-gm-card" style="background:rgba(139,92,246,0.07);border:1px solid rgba(139,92,246,0.3);">
      <div class="ubp-gm-t125b" style="margin-bottom:4px;">⚖️ ${ww.phase === 'pk-vote' ? 'PK 决选' : '放逐'}结算</div>
      <div class="ubp-gm-muted">有效票必须严格大于弃票数，否则流票进夜。<br>平票：进入 PK 辩解 → PK 投票（平票方失去投票权）→ 再平票流票进夜。</div>
    </div>` : '';

  let footer: string;
  // 投票优先于错误条（含 pk-vote）：AI 票失败只降级为提示行，玩家投票不被阻塞（同谁是卧底口径）
  if (voting) footer = `${err ? errorLineHtml() : ''}
    <div class="ubp-gm-ctl">
      <button class="ubp-gm-btn ghost" data-ubp-act="vote-skip" style="flex:1;">弃票</button>
      <button class="ubp-gm-btn primary" data-ubp-act="vote-confirm" style="flex:2;" ${_votePickPos ? '' : 'disabled'}>${_votePickPos ? `投票给 ${_votePickPos} 号位` : '确认投票'}</button>
    </div>`;
  else if (err) footer = errorFooter();
  else if (pendingWords && pendingWords.session === session) footer = `
    <div class="ubp-gm-inputbar">
      <input id="ubp-gm-speak-input" type="text" placeholder="输入你的遗言…" autocomplete="off">
      <button class="ubp-gm-btn primary" data-ubp-act="lastwords-send" style="flex:none;">发送遗言</button>
    </div>`;
  else if (iAmSeer) {
    const target = _seerPick ? ww.players.find(p => p.position === _seerPick) : null;
    footer = target
      ? `<div class="ubp-gm-ctl"><div class="ubp-gm-strip seer">🔮 已选 ${_seerPick}号位 ${escapeHtml(target.name)}</div><button class="ubp-gm-btn primary" data-ubp-act="seer-confirm" style="flex:none;">确认查验</button></div>`
      : waitFooter('🔮 请点击上方头像选择查验目标（再点一次可取消）');
  }
  else if (iAmWolf) {
    const target = _wolfKillPick ? ww.players.find(p => p.position === _wolfKillPick) : null;
    footer = target
      ? `<div class="ubp-gm-ctl"><div class="ubp-gm-strip">🔪 已选 ${_wolfKillPick}号位 ${escapeHtml(target.name)}</div><button class="ubp-gm-btn amber" data-ubp-act="wolf-kill-confirm" style="flex:none;">确认刀口</button></div>`
      : waitFooter(_wolfKillArmed ? '🔪 点击上方头像选择今晚的刀口' : '⚡ 请先在战术板点「确定」，再选择刀口');
  }
  else if (iAmWitch) footer = `
    <div class="ubp-gm-ctl">
      ${!ww.witchUsedPoison ? `<button class="ubp-gm-btn ghost" data-ubp-act="witch-poison-clear" style="flex:1;">不用毒</button>
      <button class="ubp-gm-btn primary" data-ubp-act="witch-confirm" style="flex:2;">确认用药</button>`
      : '<button class="ubp-gm-btn primary" data-ubp-act="witch-confirm" style="flex:1;">确认（今晚不用药）</button>'}
    </div>`;
  else if (myTurnSpeak) footer = `
    <div class="ubp-gm-inputbar">
      <input id="ubp-gm-speak-input" type="text" placeholder="轮到你公开发言…" autocomplete="off">
      <button class="ubp-gm-btn primary" data-ubp-act="wolf-speak-send" style="flex:none;">发言</button>
      <button class="ubp-gm-btn ghost" data-ubp-act="wolf-speak-skip" style="flex:none;">跳过</button>
    </div>`;
  else if (myTurnPk) footer = `
    <div class="ubp-gm-inputbar">
      <input id="ubp-gm-speak-input" type="text" placeholder="进行你的 PK 辩解…" autocomplete="off">
      <button class="ubp-gm-btn primary" data-ubp-act="pk-send" style="flex:none;">辩解</button>
    </div>`;
  else if (ww.phase === 'pk-vote' && me && ww.pkCandidates.includes(me.position)) footer = waitFooter('你是平票方，本轮无投票权，等待决选结果…');
  else if (busy) footer = genFooter(isNight ? 'AI 玩家正在夜间行动…' : ww.phase === 'pk-speak' ? '平票玩家正在辩解…' : ww.phase === 'speak' ? `${ww.players[ww.currentSpeaker]?.name || 'AI'} 正在组织发言…` : 'AI 玩家们正在推演投票…');
  else footer = waitFooter('等待其他玩家…');

  const navPhase = isNight ? '🌙 夜晚' : ww.phase === 'speak' ? '☀️ 白天' : ww.phase === 'vote' ? '🗳️ 投票' : ww.phase === 'pk-speak' ? '⚖️ PK 辩解' : ww.phase === 'pk-vote' ? '⚖️ 决选投票' : '结算';
  renderShell(pageShell(`🐺 第 ${ww.day} 天 · ${navPhase}`, `
    <div class="ubp-gm-body${_quitOpen ? ' blur' : ''}">
      ${roleCard}
      ${phaseLine}
      ${logs.join('')}
      ${wolfCards}
      ${seerCard}
      ${witchCards}
      ${voteGrid}
      ${voteCard}
      <div class="ubp-gm-dim" style="margin-top:6px;">🔒 过程中只能看到公开发言——他人的思考、局势分析与身份，终局和「全景复盘」才解锁。</div>
    </div>`, footer, 'back-home-confirm', '', QUIT_BTN, _quitOpen ? quitOverlay() : ''));

  const input = () => container.querySelector('#ubp-gm-speak-input') as HTMLInputElement | null;
  bindSpeakInput('#ubp-gm-speak-input', () => {
    const el = input();
    if (!el) return;
    if (pendingWords && pendingWords.session === session) submitWerewolfLastWords(session, el.value);
    else if (myTurnSpeak) submitWerewolfSpeech(session, el.value);
    else if (myTurnPk) submitWerewolfPkSpeech(session, el.value);
  });
}

// ─── 海龟汤对局（mockup 屏3/4：汤面卡 + 额度条 + 问答日志流 + 输入条；屏5/6 弹层） ───

const SOUP_ANS_CLS: Record<string, string> = { '是': 'yes', '不是': 'no', '是也不是': 'part', '不重要': 'irr' };

function soupSysHtml(text: string): string {
  return `<div class="ubp-gm-log"><div class="ubp-gm-sys soup">${escapeHtml(text).replace(/\n/g, '<br>')}</div></div>`;
}

/** 主持人回答行（🪷 皇冠头像 + 四色答案标签 + 口吻播报）。
 *  gmv=语音条参数时口吻播报渲染成语音条（主持人必为真实好友）；复盘页（二期回放）不传=纯文本。 */
function soupAnswerHtml(hostName: string, tag: string, voice: string, qNo?: number, gmv?: GmVoiceArgs): string {
  const body = gmv ? gmVoiceHtml(gmv) : voice ? `<div class="ubp-gm-ansvoice">「${escapeHtml(voice)}」</div>` : '';
  return `<div class="ubp-gm-ansrow">
    <div class="ubp-gm-hostava">${avatarHtml(hostName)}<span class="ubp-gm-crown">🪷</span></div>
    <div class="ubp-gm-ansbox">
      <div class="ubp-gm-ansline"><span class="ubp-gm-ans-tag ${SOUP_ANS_CLS[tag] || 'irr'}">${escapeHtml(tag)}</span><span class="ubp-gm-by">${escapeHtml(hostName)}${qNo ? ` · Q${qNo}` : ''}</span></div>
      ${body}
    </div>
  </div>`;
}

function soupGenFooter(text: string): string {
  return `<div class="ubp-gm-soupgen"><span class="ubp-gm-spin soup"></span><span class="ubp-gm-flex1">${escapeHtml(text)}</span><button data-ubp-act="abort-gen">终止</button></div>`;
}

function renderSoupPlay(ts: ActiveTurtleSoup): void {
  const container = _ctx!.container;
  const session = ts.session;
  const busy = hasGameGeneration();
  const err = lastGameError();
  const pending = turtleSoupBusyStep();
  const curSeat = ts.players[ts.currentSpeaker];
  const myTurn = ts.phase === 'ask' && !pending && !err && curSeat?.isUser === true && ts.quotaUsed < ts.quotaLimit;
  const overlayOpen = _soupGuessOpen || _soupGiveupOpen || _quitOpen;

  // 汤面卡（拟题中=占位态）
  const soupFaceCard = ts.soupFace
    ? `<div class="ubp-gm-soupface">
        <div class="ubp-gm-st"><span class="ubp-gm-sticon">🧉</span><span class="ubp-gm-stitle">${escapeHtml(ts.title)}</span><span class="ubp-gm-tag soup" style="margin-left:auto;">${escapeHtml(ts.category)}</span></div>
        <div class="ubp-gm-stext">${escapeHtml(ts.soupFace)}</div>
        <div class="ubp-gm-skey">🔒 汤底全程保密 · 只有主持人${escapeHtml(ts.hostName)}知道</div>
      </div>`
    : `<div class="ubp-gm-soupface">
        <div class="ubp-gm-st"><span class="ubp-gm-sticon">🧉</span><span class="ubp-gm-stitle">主持人拟题中…</span></div>
        <div class="ubp-gm-stext">🪷 ${escapeHtml(ts.hostName)} 正在按「${escapeHtml(ts.category)}」类型拟题，汤面就绪后公布。</div>
      </div>`;

  // 额度条（全员共享；提问与猜底都计次）
  const quotaPct = Math.min(100, Math.round((ts.quotaUsed / Math.max(1, ts.quotaLimit)) * 100));
  const quotaBar = ts.soupFace
    ? `<div class="ubp-gm-quota"><span class="ubp-gm-qnum">❓ ${ts.quotaUsed}/${ts.quotaLimit}</span><div class="ubp-gm-qbar"><i style="width:${quotaPct}%"></i></div><span class="ubp-gm-qtxt">全员共享额度</span></div>`
    : '';

  // 日志流（过程隔离：system/speech/answer/guess/verdict；think/situation 与汤底线索禁渲染）
  const logs: string[] = [];
  let q = 0;
  for (let i = 0; i < ts.entries.length; i++) {
    const e = ts.entries[i];
    if (e.type === 'system') {
      logs.push(soupSysHtml(e.text));
    } else if (e.type === 'verdict') {
      const hit = e.text.startsWith('hit|');
      logs.push(`<div class="ubp-gm-verdictline ${hit ? 'hit' : 'miss'}">${escapeHtml(e.text.replace(/^(hit|miss)\|/, ''))}</div>`);
    } else if (e.type === 'speech' || e.type === 'guess') {
      q++;
      const p = ts.players.find(x => x.position === e.pos);
      const name = p ? (p.isUser ? '我' : p.name) : `${e.pos ?? '?'}号位`;
      const cls = e.type === 'guess' ? 'bubble guess' : `bubble${p?.isUser ? ' mine' : ''}`;
      const qno = e.type === 'guess' ? `🎯 Q${q}` : `Q${q}`;
      const who = e.type === 'guess' ? `<b>${escapeHtml(name)} · 猜汤底</b>` : escapeHtml(name);
      if (gmVoiceOn(e)) {
        logs.push(`<div class="ubp-gm-brow">${avatarHtml(p?.name || name)}${gmVoiceHtml({
          key: gmvKey('turtlesoup', ts.session, i), idx: i, sender: p?.name || name,
          who: `${qno} · ${who}${npcMark(p?.name || '')}`, text: gmVoiceText(e),
          emotion: e.voiceEmotion || '', delivery: e.voiceDelivery || '', rev: false,
        })}</div>`);
      } else {
        logs.push(`<div class="ubp-gm-brow">${avatarHtml(p?.name || name)}<div class="ubp-gm-${cls}"><span class="ubp-gm-qno">${qno}</span><div class="ubp-gm-who">${who}${npcMark(p?.name || '')}</div>${escapeHtml(e.text)}</div></div>`);
      }
    } else if (e.type === 'answer') {
      const split = e.text.indexOf('|');
      const tag = split > 0 ? e.text.slice(0, split) : '不重要';
      const voice = split > 0 ? e.text.slice(split + 1) : '';
      const gmv: GmVoiceArgs | undefined = gmVoiceOn(e) && voice
        ? { key: gmvKey('turtlesoup', ts.session, i), idx: i, sender: ts.hostName, who: '', text: voice, emotion: e.voiceEmotion || '', delivery: e.voiceDelivery || '', rev: false }
        : undefined;
      logs.push(soupAnswerHtml(ts.hostName, tag, voice, e.round, gmv));
    }
  }
  if (myTurn && !_soupGuessOpen && !_soupGiveupOpen) {
    logs.push(soupSysHtml('🎯 轮到你提问了 · 问出关键的是非问题，或直接猜汤底'));
  }

  let footer: string;
  if (err) footer = errorFooter();
  else if (ts.phase === 'deal') footer = soupGenFooter(`🪷 ${ts.hostName} 正在拟题…`);
  else if (ts.phase === 'reveal') footer = soupGenFooter(`🪷 ${ts.hostName} 正在揭晓汤底…`);
  else if (myTurn) footer = `
    <div class="ubp-gm-inputbar">
      <input id="ubp-gm-speak-input" type="text" placeholder="向主持人提一个是非问题…" autocomplete="off">
      <button class="ubp-gm-btn soup" data-ubp-act="soup-guess-open" style="flex:none;padding:9px 12px;">🎯 猜底</button>
      <button class="ubp-gm-btn ghost" data-ubp-act="soup-ask-skip" style="flex:none;">跳过</button>
    </div>`;
  else if (pending) footer = soupGenFooter(pending.kind === 'verdict' ? `🎯 ${ts.hostName} 正在判定猜底…` : `🪷 ${ts.hostName} 正在斟酌回答…`);
  else if (busy) footer = soupGenFooter(`${curSeat?.name || 'AI'} 正在思考下一个问题…`);
  else footer = waitFooter('等待其他参与者…');

  // 🏳️ 放弃入口（走揭晓终局）+ 🚪 退出对局入口，均挂 appbar 右侧
  const flagBtn = ts.phase === 'ask' && !err
    ? '<button class="ubp-gm-navact" data-ubp-act="soup-giveup-open" title="放弃本局">🏳️</button>'
    : '';

  // 弹层（mockup 屏5 猜底 / 屏6 放弃确认 / 三游戏共用 🚪 退出对局）
  let overlay = '';
  if (_quitOpen) {
    overlay = quitOverlay();
  } else if (_soupGuessOpen) {
    overlay = `<div class="ubp-gm-overlay">
      <div class="ubp-gm-sheet">
        <div class="ubp-gm-sht">🎯 猜汤底</div>
        <div class="ubp-gm-shd">用你自己的话讲出完整真相。提交会消耗 <b style="color:var(--gmc-soup2);">1 次提问额度</b>（当前 ${ts.quotaUsed}/${ts.quotaLimit}）——覆盖汤底<b>全部关键点</b>才算还原成功，猜错主持人会提示方向。</div>
        <textarea id="ubp-soup-guess-input" placeholder="我认为真相是……（把动机、那晚发生了什么、为什么再也不走那条路都讲清楚）"></textarea>
        <div class="ubp-gm-row">
          <button class="ubp-gm-btn ghost" data-ubp-act="soup-guess-cancel">取消</button>
          <button class="ubp-gm-btn soup" data-ubp-act="soup-guess-send">提交猜底（扣 1 次）</button>
        </div>
      </div>
    </div>`;
  } else if (_soupGiveupOpen) {
    overlay = `<div class="ubp-gm-overlay">
      <div class="ubp-gm-sheet danger">
        <div class="ubp-gm-sht">🏳️ 放弃这碗汤？</div>
        <div class="ubp-gm-shd">放弃后 AI 参与者停止提问，<b style="color:var(--gmc-red);">主持人${escapeHtml(ts.hostName)}将立即揭晓汤底</b>，本局判定主持人获胜。已消耗的额度与问答记录都会保留在「对局记录」里。</div>
        <div class="ubp-gm-row">
          <button class="ubp-gm-btn ghost" data-ubp-act="soup-giveup-cancel">再想想</button>
          <button class="ubp-gm-btn danger" data-ubp-act="soup-giveup-confirm">确认放弃 · 听揭晓</button>
        </div>
      </div>
    </div>`;
  }

  renderShell(pageShell(`🐢 海龟汤 · 第 ${ts.round} 圈`, `
    <div class="ubp-gm-body${overlayOpen ? ' blur' : ''}">
      ${soupFaceCard}
      ${quotaBar}
      ${logs.join('')}
      <div class="ubp-gm-dim" style="margin-top:6px;">🔒 汤底全程保密——他人与我都不知真相，命中全部关键点才算还原。</div>
    </div>`, footer, 'back-home-confirm', '', flagBtn + QUIT_BTN, overlay));

  bindSpeakInput('#ubp-gm-speak-input', () => {
    const input = container.querySelector('#ubp-gm-speak-input') as HTMLInputElement | null;
    if (input && input.value.trim()) submitTurtleSoupQuestion(session, input.value.trim());
  });
}

// ─── 终局面板（mockup 屏7；赛后产物异步补写自动刷新） ───

function renderEndView(record: GameRecord): void {
  _view = 'end';
  _detailId = record.id;
  if (record.gameType === 'turtlesoup') {
    renderSoupEnd(record);
    return;
  }
  const win = userWinTag(record);
  const iWon = win?.text === '主角胜';
  const isWolfGame = record.gameType === 'werewolf';
  const revealRows = record.detail.split('；').map(line => {
    const m = line.match(/^(\d+)号位 (.+?)(（主角）)?：(.+)$/);
    if (!m) return `<div class="ubp-gm-reveal"><span class="ubp-gm-flex1">${escapeHtml(line)}</span></div>`;
    const pos = m[1];
    const name = m[2];
    const rest = m[4];
    const uw = rest.match(/^(.*?)（(卧底|平民)·(存活|出局)）$/);
    const wwRole = rest.match(/^(狼人|村民|预言家|女巫)·(存活|出局)$/);
    const roleName = uw ? uw[2] : wwRole ? wwRole[1] : rest;
    const state = uw ? uw[3] : wwRole ? wwRole[2] : '';
    const word = uw ? uw[1] : '';
    const tagCls = roleName === '狼人' || roleName === '卧底' ? 'red' : roleName === '预言家' || roleName === '女巫' ? 'green' : 'gray';
    return `<div class="ubp-gm-reveal">${avatarHtml(name, 'small')}
      <span class="ubp-gm-flex1">${escapeHtml(name)}${npcMark(name)} · ${pos}号位${word ? `<div class="ubp-gm-t105">词语「${escapeHtml(word)}」</div>` : ''}</span>
      <span class="ubp-gm-tag ${tagCls}">${escapeHtml(roleName)} · ${escapeHtml(state || '?')}</span>
    </div>`;
  }).join('');
  const words = !isWolfGame ? undercoverWordsLine(record) : '';
  renderShell(pageShell(`${isWolfGame ? '🐺' : '🕵️'} 对局结束`, `
    <div class="ubp-gm-body">
      <div class="ubp-gm-verdict${iWon ? '' : ' lost'}">
        <div class="ubp-gm-vemoji">${iWon ? '🏆' : '😵'}</div>
        <div class="ubp-gm-vbig">${escapeHtml(record.winnerSide)}获胜</div>
        <div class="ubp-gm-vwho">${escapeHtml(storyTimeShort(record.storyTime || ''))}${win ? ` · <span class="ubp-gm-tag ${win.cls}">${win.text}</span>` : ''}</div>
        ${words ? `<div class="ubp-gm-vwho">${escapeHtml(words)}</div>` : ''}
      </div>
      <div class="ubp-gm-card">
        <div class="ubp-gm-t12b" style="margin-bottom:6px;">底牌公布（终局解锁）</div>
        ${revealRows}
      </div>
      ${record.text ? `<div class="ubp-gm-card"><div class="ubp-gm-t12b" style="margin-bottom:5px;">📝 对局总结</div><div class="ubp-gm-muted">${escapeHtml(record.text)}</div></div>` : ''}
      ${record.highlight
        ? `<div class="ubp-gm-hl">🎙️ <b>高光播报</b><br>${escapeHtml(record.highlight)}</div>`
        : '<div class="ubp-gm-dim" style="text-align:center;padding:4px 0 10px;">🎙️ 高光播报与复盘聊天生成中…可稍后在记录页查看</div>'}
    </div>`, `
    <div class="ubp-gm-ctl">
      <button class="ubp-gm-btn" data-ubp-act="open-detail" data-id="${escapeAttr(record.id)}" style="flex:1;">📜 全景复盘</button>
      <button class="ubp-gm-btn primary" data-ubp-act="again" data-id="${record.gameType}" style="flex:1;">再来一局</button>
      <button class="ubp-gm-btn ghost" data-ubp-act="open-afterparty" data-id="${escapeAttr(record.id)}" style="flex:1;">💬 复盘聊天</button>
    </div>`, 'back-home'));
}

// ─── 记录列表（双游戏合并，时间倒序） ───

function renderRecords(): void {
  const all = allRecordsSorted();
  renderShell(pageShell('📜 对局记录', `
    <div class="ubp-gm-body">
      ${all.length
        ? `<div class="ubp-gm-card" style="padding:4px 12px;">${all.map(recRowHtml).join('')}</div>`
        : '<div class="ubp-gm-placeholder">还没有打完任何一局<br>去开一局吧</div>'}
    </div>`, '', 'back-home'));
}

// ─── 海龟汤终局面板（mockup 屏7 揭晓败局 / 屏8 猜中合作胜） ───

interface SoupDetailInfo {
  host: string;
  title: string;
  category: string;
  quotaUsed: number;
  quotaLimit: number;
  endLabel: string;
  base: string;
  comment: string;
  kps: Array<{ hit: boolean; text: string; note: string }>;
}

/** 解析海龟汤记录 detail 行（endTurtleSoup 落库格式：`key：value` 逐行）。 */
function parseSoupDetail(record: GameRecord): SoupDetailInfo {
  const lines = record.detail.split('\n');
  const get = (key: string) => lines.find(l => l.startsWith(`${key}：`))?.slice(key.length + 1) || '';
  const titleLine = get('题目');
  const kpLines = lines.filter(l => /^关键点\d+：/.test(l));
  return {
    host: get('主持人') || record.players[0] || '主持人',
    title: titleLine.match(/《(.+?)》/)?.[1] || titleLine || '未知题目',
    category: titleLine.match(/（(.+?) · 额度/)?.[1] || '',
    quotaUsed: parseInt(titleLine.match(/额度\s*(\d+)\//)?.[1] || '0', 10),
    quotaLimit: parseInt(titleLine.match(/额度\s*\d+\/(\d+)/)?.[1] || '0', 10),
    endLabel: get('结局'),
    base: get('汤底'),
    comment: get('点评'),
    kps: kpLines.map(l => {
      const body = l.replace(/^关键点\d+：/, '');
      const hit = body.startsWith('✅');
      const parts = body.replace(/^[✅❌]\s*\|/, '').split('|');
      return { hit, text: (parts[0] || '').trim(), note: (parts[1] || '').trim() };
    }),
  };
}

function renderSoupEnd(record: GameRecord): void {
  const info = parseSoupDetail(record);
  const win = userWinTag(record);
  const iWon = win?.text === '主角胜';
  const guessM = info.endLabel.match(/^(.+?) 猜中汤底（第 (\d+) 圈）$/);
  const endLine = iWon
    ? `🎯 由 ${escapeHtml(guessM ? guessM[1] : '参与者')} 在第 ${guessM ? guessM[2] : '?'} 圈猜中`
    : info.endLabel.includes('放弃')
      ? `你于 ${info.quotaUsed}/${info.quotaLimit} 额度处发起放弃`
      : `额度 ${info.quotaUsed}/${info.quotaLimit} 全部耗尽 · 未能还原`;
  const verdictBlock = iWon
    ? `<div class="ubp-gm-verdict soup">
        <div class="ubp-gm-vemoji">🎉</div>
        <div class="ubp-gm-vbig">真相还原成功</div>
        <div class="ubp-gm-vwho">参与者阵营获胜 · ${escapeHtml(storyTimeShort(record.storyTime || ''))}${win ? ` <span class="ubp-gm-tag ${win.cls}">${win.text}</span>` : ''}</div>
        <div class="ubp-gm-vwho">${endLine} · 共消耗 ${info.quotaUsed}/${info.quotaLimit} 次额度</div>
      </div>`
    : `<div class="ubp-gm-verdict lost">
        <div class="ubp-gm-vemoji">🥲</div>
        <div class="ubp-gm-vbig">汤底未能还原</div>
        <div class="ubp-gm-vwho">主持人 ${escapeHtml(info.host)} 获胜 · ${escapeHtml(storyTimeShort(record.storyTime || ''))}${win ? ` <span class="ubp-gm-tag ${win.cls}">${win.text}</span>` : ''}</div>
        <div class="ubp-gm-vwho">${escapeHtml(endLine)}</div>
      </div>`;
  const revealCard = `<div class="ubp-gm-soupface">
      <div class="ubp-gm-st"><span class="ubp-gm-sticon">🐢</span><span class="ubp-gm-stitle reveal">汤底揭晓</span><span class="ubp-gm-tag soup" style="margin-left:auto;">${escapeHtml(info.category)}</span></div>
      <div class="ubp-gm-stext">${escapeHtml(info.base || '（汤底缺失）')}</div>
    </div>`;
  const hostComment = info.comment && info.comment !== '—'
    ? `<div class="ubp-gm-ansrow">
        <div class="ubp-gm-hostava">${avatarHtml(info.host)}<span class="ubp-gm-crown">🪷</span></div>
        <div class="ubp-gm-ansbox">
          <div class="ubp-gm-ansline"><span class="ubp-gm-by" style="font-weight:700;color:var(--gmc-soup2);">🪷 ${escapeHtml(info.host)} · 揭晓点评</span></div>
          <div class="ubp-gm-ansvoice">「${escapeHtml(info.comment)}」</div>
        </div>
      </div>`
    : '';
  const kpCard = info.kps.length ? `
    <div class="ubp-gm-card">
      <div class="ubp-gm-t12b" style="margin-bottom:6px;">🧩 关键点命中复盘</div>
      ${info.kps.map(k => `<div class="ubp-gm-kp${k.hit ? '' : ' miss'}"><span class="ubp-gm-kic">${k.hit ? '✅' : '❌'}</span><span>${escapeHtml(k.text)}（${escapeHtml(k.note)}）</span></div>`).join('')}
    </div>` : '';
  renderShell(pageShell('🐢 对局结束', `
    <div class="ubp-gm-body">
      ${verdictBlock}
      ${revealCard}
      ${hostComment}
      ${kpCard}
      ${record.text ? `<div class="ubp-gm-card"><div class="ubp-gm-t12b" style="margin-bottom:5px;">📝 对局总结</div><div class="ubp-gm-muted">${escapeHtml(record.text)}</div></div>` : ''}
      ${record.highlight
        ? `<div class="ubp-gm-hl">🎙️ <b>高光播报</b><br>${escapeHtml(record.highlight)}</div>`
        : '<div class="ubp-gm-dim" style="text-align:center;padding:4px 0 10px;">🎙️ 高光播报与复盘聊天生成中…可稍后在记录页查看</div>'}
    </div>`, `
    <div class="ubp-gm-ctl">
      <button class="ubp-gm-btn" data-ubp-act="open-detail" data-id="${escapeAttr(record.id)}" style="flex:1;">📜 全景复盘</button>
      <button class="ubp-gm-btn soup" data-ubp-act="again" data-id="turtlesoup" style="flex:1;">再来一局</button>
      <button class="ubp-gm-btn ghost" data-ubp-act="open-afterparty" data-id="${escapeAttr(record.id)}" style="flex:1;">💬 复盘聊天</button>
    </div>`, 'back-home'));
}

// ─── 记录详情（四区 tab；上帝视角，docs/16 §0.9；mockup 屏8） ───

// 全景复盘重设计：situation/action 不展示；系统流水缩为细分割线；
// 发言=角色色气泡（复用对局页 brow/bubble，色取 avatarColor 名字散列）；思考=同色虚线小卡挂在同名额上方；
// 连续 private（含其前 think）聚成紫底狼队密谋面板，狼人杀/谁是卧底共用同一分支。
type ReplayNameOf = (pos?: number) => string;

/** 复盘分割线：夜/昼/投票/结算一行细字（红=出局）。 */
function replayDivider(text: string): string {
  const red = text.includes('出局') || text.includes('💀');
  return `<div class="ubp-gm-rdiv${red ? ' red' : ''}">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

/** 复盘一行：可选思考虚线卡 + 角色色气泡（同人 think+发言 合并；mine=主角行镜像右对齐）。 */
function replayTurnHtml(name: string, pos: number | undefined, think: string | undefined, speech: string | undefined, mine = false): string {
  const color = avatarColor(name || '?');
  const whoLine = `<div class="ubp-gm-rwho" style="color:${color};">${escapeHtml(name)}${pos ? `<i>${pos}号位</i>` : ''}</div>`;
  const thinkCard = think
    ? `<div class="ubp-gm-rthink" style="border-color:${color}99;background:${color}17;"><b style="color:${color};">💭 内心</b>${escapeHtml(think)}</div>`
    : '';
  const accent = mine ? `border-right:3px solid ${color}b3;` : `border-left:3px solid ${color}b3;`;
  const bubble = speech
    ? `<div class="ubp-gm-bubble" style="background:${color}2b;border:1px solid ${color}5e;${accent}">${whoLine}${escapeHtml(speech)}</div>`
    : '';
  return `<div class="ubp-gm-brow${mine ? ' rev' : ''}">${avatarHtml(name || '?')}<div class="ubp-gm-flex1">${think ? `${thinkCard}${bubble || whoLine}` : bubble}</div></div>`;
}

function renderReplayRows(entries: GameRecord['entries'], nameOf: ReplayNameOf, isMe: (name: string) => boolean): string {
  const rows: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.type === 'situation' || e.type === 'action') { i++; continue; }
    if (e.type === 'system' || e.type === 'vote') { rows.push(replayDivider(e.text)); i++; continue; }
    if (e.type === 'private') {
      const wolfRows: string[] = [];
      while (i < entries.length) {
        const w = entries[i];
        if (w.type === 'situation' || w.type === 'action') { i++; continue; }
        if (w.type !== 'think' && w.type !== 'private') break;
        if (w.type === 'think') {
          i++;
          let priv: string | undefined;
          while (i < entries.length) {
            const n = entries[i];
            if (n.type === 'situation' || n.type === 'action') { i++; continue; }
            if (n.type === 'private') { priv = n.text; i++; }
            break;
          }
          wolfRows.push(replayTurnHtml(nameOf(w.pos), w.pos, w.text, priv, isMe(nameOf(w.pos))));
        } else {
          wolfRows.push(replayTurnHtml(nameOf(w.pos), w.pos, undefined, w.text, isMe(nameOf(w.pos))));
          i++;
        }
      }
      if (wolfRows.length) rows.push(`<div class="ubp-gm-rwolf"><div class="ubp-gm-rwolf-hd">🐺 狼队密谋</div>${wolfRows.join('')}</div>`);
      continue;
    }
    if (e.type === 'think') {
      i++;
      let speech: string | undefined;
      while (i < entries.length) {
        const n = entries[i];
        if (n.type === 'situation' || n.type === 'action') { i++; continue; }
        if (n.type === 'speech' && n.pos === e.pos) { speech = n.text; i++; }
        break;
      }
      rows.push(replayTurnHtml(nameOf(e.pos), e.pos, e.text, speech, isMe(nameOf(e.pos))));
      continue;
    }
    rows.push(replayTurnHtml(nameOf(e.pos), e.pos, undefined, e.text, isMe(nameOf(e.pos))));
    i++;
  }
  return rows.join('');
}

/** 海龟汤复盘分割线（红=放弃/未中/出局/揭晓类节点）。 */
function soupReplayDivider(text: string): string {
  const red = /出局|💀|🏳️|未中|揭晓|游戏结束/.test(text);
  return `<div class="ubp-gm-rdiv${red ? ' red' : ''}">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

/** 海龟汤全景复盘（上帝视角）：💭 推理笔记虚线卡 + 问答气泡（Q 号）+ 🪷 主持回答 + 🎯 猜底/判定分割线。
 *  record.players[0]=主持人，participants 从下标 1 起（endTurtleSoup 落库顺序）。 */
function renderSoupReplayRows(record: GameRecord): string {
  const host = record.players[0] || '主持人';
  const nameOf = (pos?: number) => (pos === undefined ? host : record.players[pos] || `${pos}号位`);
  const rows: string[] = [];
  const entries = record.entries;
  let i = 0;
  let q = 0;
  const nextQ = () => ++q;
  while (i < entries.length) {
    const e = entries[i];
    if (e.type === 'think') {
      i++;
      // 同人思考与其后紧邻的提问/猜底合并成组（跳过夹在中间的 situation/action）
      let speech: GameRecord['entries'][number] | undefined;
      while (i < entries.length) {
        const n = entries[i];
        if (n.type === 'situation' || n.type === 'action') { i++; continue; }
        if ((n.type === 'speech' || n.type === 'guess') && n.pos === e.pos) { speech = n; i++; }
        break;
      }
      const name = nameOf(e.pos);
      const color = avatarColor(name);
      const thinkCard = `<div class="ubp-gm-rthink" style="border-color:${color}99;background:${color}17;"><b style="color:${color};">💭 内心</b>${escapeHtml(e.text)}</div>`;
      rows.push(speech
        ? `<div class="ubp-gm-brow">${soupBubbleHtml(speech, nameOf, nextQ, thinkCard)}</div>`
        : thinkCard);
      continue;
    }
    if (e.type === 'speech' || e.type === 'guess') {
      rows.push(`<div class="ubp-gm-brow">${soupBubbleHtml(e, nameOf, nextQ)}</div>`);
      i++;
      continue;
    }
    if (e.type === 'answer') {
      const split = e.text.indexOf('|');
      const tag = split > 0 ? e.text.slice(0, split) : '不重要';
      const voice = split > 0 ? e.text.slice(split + 1) : '';
      rows.push(soupAnswerHtml(host, tag, voice, e.round));
      i++;
      continue;
    }
    if (e.type === 'system' || e.type === 'vote' || e.type === 'verdict') {
      rows.push(soupReplayDivider(e.type === 'verdict' ? e.text.replace(/^(hit|miss)\|/, '') : e.text));
      i++;
      continue;
    }
    i++; // situation/action 复盘不展示（与其他游戏口径一致）
  }
  return rows.join('');
}

/** 海龟汤问答气泡（Q 号徽标 + 我的紫描边 + 猜底青绿描边；thinkCard=同人推理笔记挂气泡上方）。 */
function soupBubbleHtml(
  e: GameRecord['entries'][number],
  nameOf: (pos?: number) => string,
  nextQ: () => number,
  thinkCard = '',
): string {
  const name = nameOf(e.pos);
  const mine = name === getRoster().protagonistName || name === '我';
  const qNo = nextQ();
  const qno = e.type === 'guess' ? `🎯 Q${qNo}` : `Q${qNo}`;
  const who = e.type === 'guess' ? `<b>${escapeHtml(name)} · 猜汤底</b>` : escapeHtml(name);
  const cls = e.type === 'guess' ? ' guess' : mine ? ' mine' : '';
  return `${avatarHtml(name)}<div class="ubp-gm-flex1">${thinkCard}<div class="ubp-gm-bubble${cls}"><span class="ubp-gm-qno">${qno}</span><div class="ubp-gm-who">${who}${npcMark(name)}</div>${escapeHtml(e.text)}</div></div>`;
}

function renderDetail(): void {
  const record = findDetailRecord();
  if (!record) {
    _view = 'records';
    renderRecords();
    return;
  }
  const tabs: Array<[typeof _detailTab, string]> = [
    ['replay', '全景复盘'], ['summary', '总结'], ['highlight', '高光'], ['afterparty', '复盘聊天'],
  ];
  const tabsHtml = `<div class="ubp-gm-tabs">${tabs.map(([key, label]) =>
    `<button class="ubp-gm-tab${_detailTab === key ? ' on' : ''}" data-ubp-act="detail-tab" data-id="${key}">${label}</button>`).join('')}</div>`;

  let body: string;
  if (_detailTab === 'replay') {
    if (record.gameType === 'turtlesoup') {
      const rows = renderSoupReplayRows(record);
      body = `<div class="ubp-gm-soupreplay">${rows || '<div class="ubp-gm-placeholder">无记录</div>'}</div>
      <div class="ubp-gm-dim" style="margin-top:6px;">· 海龟汤全景复盘 = 上帝视角：🗣️提问与 🎯猜底 + 💭推理笔记（同人同色成组，我的消息紫描边）· 🪷 主持回答与判定逐条可溯<br>· 汤底全文见「总结」tab 与终局面板；总结已入池供后续对局与聊天关键词联动</div>`;
    } else {
      const players = record.players;
      const myName = getRoster().protagonistName;
      const nameOf = (pos?: number) => (pos !== undefined ? (players[pos - 1] || `${pos}号位`) : '');
      const isMe = (name: string) => name === myName || name === '我';
      const rows = renderReplayRows(record.entries, nameOf, isMe);
      body = `${rows || '<div class="ubp-gm-placeholder">无记录</div>'}
      <div class="ubp-gm-dim" style="margin-top:6px;">· 全景复盘 = 上帝视角：🗣️发言 + 💭内心思考（同人同色成组，我的消息靠右）· 紫底段 = 🐺狼队密谋<br>· 总结 tab 的 150 字总结同款已入池，供后续对局注入</div>`;
    }
  } else if (_detailTab === 'summary') {
    const soupInfo = record.gameType === 'turtlesoup' ? parseSoupDetail(record) : null;
    const soupBase = soupInfo
      ? `<div class="ubp-gm-soupface">
          <div class="ubp-gm-st"><span class="ubp-gm-sticon">🐢</span><span class="ubp-gm-stitle reveal">汤底揭晓</span><span class="ubp-gm-tag soup" style="margin-left:auto;">${escapeHtml(soupInfo.category)}</span></div>
          <div class="ubp-gm-stext">${escapeHtml(soupInfo.base || '（汤底缺失）')}</div>
        </div>`
      : '';
    body = record.text
      ? `${soupBase}<div class="ubp-gm-card"><div class="ubp-gm-muted" style="line-height:1.7;">${escapeHtml(record.text)}</div></div>
         <div class="ubp-gm-dim">· 150 字总结已入池（每游戏保留 10 局），注入后续对局与聊天关键词联动</div>`
      : `${soupBase}<div class="ubp-gm-placeholder">总结生成中<br>赛后请求未完成，稍后回来刷新</div>`;
  } else if (_detailTab === 'highlight') {
    body = record.highlight
      ? `<div class="ubp-gm-hl">🎙️ ${escapeHtml(record.highlight)}</div>`
      : `<div class="ubp-gm-placeholder">高光播报未生成<br><button class="ubp-gm-btn primary" data-ubp-act="regen" style="margin-top:10px;">重新生成</button></div>`;
  } else {
    const myName = getRoster().protagonistName;
    const lines = record.afterparty.split('\n').filter(Boolean);
    body = lines.length
      ? `<div class="ubp-gm-card" style="background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.25);">
          <div class="ubp-gm-t12b" style="color:var(--gmc-amber);margin-bottom:8px;">💬 赛后复盘聊天（我的消息靠右）</div>
          ${lines.map(line => {
            const idx = line.indexOf('：');
            const who = idx > 0 ? line.slice(0, idx).trim() : '';
            const text = idx > 0 ? line.slice(idx + 1) : line;
            if (!who) return `<div class="ubp-gm-dim" style="margin-bottom:6px;">${escapeHtml(text)}</div>`;
            return replayTurnHtml(who, undefined, undefined, text, who === myName || who === '我');
          }).join('')}
        </div>`
      : `<div class="ubp-gm-placeholder">复盘聊天未生成<br><button class="ubp-gm-btn primary" data-ubp-act="regen" style="margin-top:10px;">重新生成</button></div>`;
  }

  renderShell(pageShell(`📜 ${escapeHtml(gameTypeName(record.gameType))} · ${escapeHtml(storyTimeShort(record.storyTime || ''))}`, `
    <div class="ubp-gm-body">${body}</div>`, '', 'back-records', tabsHtml));
}

// ─── 事件路由 ───

/** 进入对局视图（「续玩」与灵动岛胶囊回归共用）：重置本地选择态 + 断链点火。
 *  点火只在无进行中生成时发生：等待玩家输入的步骤重入=notifyChanged 安全 no-op，
 *  AI 请求在途时 hasGameGeneration 守卫防双链并行。 */
function enterPlayView(): void {
  _view = 'play';
  _votePickPos = 0;
  _wolfKillArmed = false;
  _wolfAiTactic = '';
  _wolfUserTactic = '';
  _wolfKillPick = 0;
  _seerPick = 0;
  _witchSave = false;
  _witchPoisonPos = 0;
  _soupGuessOpen = false;
  _soupGiveupOpen = false;
  _quitOpen = false;
  _startConflict = false;
  render();
  // 续玩点火：内存异步链会因页面刷新/脚本更新断链，按 phase 重启当前步；
  // 多游戏并存时只点火最近开局的一局（防双链并行重复请求）
  if (!hasGameGeneration()) {
    const games = gamesOf(readDataSafe());
    const newestKind = ([
      games?.active.werewolf ? { kind: 'werewolf' as const, at: games.active.werewolf.startedAt } : null,
      games?.active.undercover ? { kind: 'undercover' as const, at: games.active.undercover.startedAt } : null,
      games?.active.turtleSoup ? { kind: 'turtlesoup' as const, at: games.active.turtleSoup.startedAt } : null,
    ].filter((x): x is { kind: 'werewolf' | 'undercover' | 'turtlesoup'; at: number } => x !== null)
      .sort((a, b) => b.at - a.at)[0] || {}).kind;
    if (newestKind === 'werewolf') resumeWerewolfChain(games!.active.werewolf!.session);
    else if (newestKind === 'undercover') resumeUndercoverChain(games!.active.undercover!.session);
    else if (newestKind === 'turtlesoup') resumeTurtleSoupChain(games!.active.turtleSoup!.session);
  }
}

async function confirmInvite(force = false): Promise<void> {
  const valid = _inviteGame === 'turtlesoup' ? soupInviteValid() : inviteValid();
  if (!_ctx || !valid || _starting) return;
  // 单局制（docs/16 §2.11）：已有未完成对局先弹确认层，玩家点头才放弃旧局开局
  const running = runningGameType();
  if (running && !force) {
    _startConflict = true;
    render();
    return;
  }
  if (running) abandonGame(running);
  _startConflict = false;
  _starting = true; // 按钮转 loading，防重复点击；成功才进对局视图
  render();
  try {
    syncNpcPreview();
    const names = inviteNames(); // 勾选好友 + 补位者（docs/16 §10；引擎按通讯录判定谁是补位者）
    if (_inviteGame === 'werewolf') await startWerewolf(names);
    else if (_inviteGame === 'turtlesoup') {
      await startTurtleSoup({ hostName: _soupHost, inviteeNames: names, category: _soupCategory, quotaLimit: _soupQuota });
    } else await startUndercover(names);
    // L9 成就：玩家亲手开局成功（三款游戏；日窗口伴随）+ 补位数按引擎同口径（isNpcParticipant）
    emitAch('phone_game_started', {
      game: _inviteGame,
      playerCount: 1 + names.length,
      npcFill: names.filter(n => isNpcParticipant(n)).length,
    });
    emitActionOnDate('phone_game');
    _invitePicked = new Set();
    _npcPreview = [];
    _soupHost = '';
    _view = 'play';
    render();
    emitPhoneEvent('ubp-phone:data-changed');
  } catch (error) {
    showScreenToast(_ctx.container, error instanceof Error ? error.message : String(error));
  } finally {
    _starting = false;
    if (_view === 'invite') render();
  }
}

function handleClick(event: Event): void {
  const target = event.target as HTMLElement;
  const el = target.closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const ucSession = currentUndercoverSession();
  const wwSession = currentWerewolfSession();
  const tsSession = currentTurtleSoupSession();
  const gameOf = (id?: string): InviteGame => (id === 'werewolf' ? 'werewolf' : id === 'turtlesoup' ? 'turtlesoup' : 'undercover');
  switch (act) {
    case 'invite':
    case 'again':
      _inviteGame = gameOf(el.dataset.id);
      _invitePicked = new Set();
      _npcPreview = [];
      _startConflict = false;
      if (_inviteGame === 'turtlesoup') resetSoupInviteState();
      _view = 'invite';
      render();
      break;
    case 'npc-toggle':
      _npcFill = !_npcFill;
      _npcPreview = [];
      render();
      break;
    case 'npc-reroll': {
      const need = _npcFill ? inviteNpcNeed() : 0;
      const exclude = knownContactNames();
      for (const name of _invitePicked) exclude.add(name);
      _npcPreview = need ? rollNpcNames(need, currentStyle(), exclude) : [];
      refreshInviteChrome();
      const slot = _ctx?.container.querySelector('[data-npc-slot]');
      if (slot) slot.innerHTML = npcPreviewCard();
      break;
    }
    case 'toggle-friend': {
      // 狼人杀/卧底勾选：原地切换勾选态（免全量重绘闪烁），标题计数/补位卡/确认按钮同步刷新
      const name = el.dataset.id || '';
      if (!name) break;
      if (_invitePicked.has(name)) _invitePicked.delete(name);
      else if (_invitePicked.size < 5) _invitePicked.add(name);
      else break;
      const box = el.querySelector('.ubp-gm-checkbox');
      if (box) box.classList.toggle('on', _invitePicked.has(name));
      refreshNpcFillChrome();
      refreshInviteChrome();
      break;
    }
    case 'start-game': void confirmInvite(); break;
    case 'start-game-force': void confirmInvite(true); break;
    case 'start-conflict-cancel':
      _startConflict = false;
      render();
      break;
    case 'quit-open':
      _quitOpen = true;
      render();
      break;
    case 'quit-cancel':
      _quitOpen = false;
      render();
      break;
    case 'quit-confirm': {
      // 结束本局：清空槽位（不写对局记录）→ 回首页；续玩条/灵动岛随 notifyChanged 一并消失
      _quitOpen = false;
      const kind = runningGameType();
      _view = 'home';
      if (kind) abandonGame(kind);
      render();
      if (kind && _ctx) showScreenToast(_ctx.container, '本局已结束 · 未写入对局记录');
      break;
    }
    case 'resume':
      enterPlayView();
      break;
    case 'pick-seat': {
      const pos = parseInt(el.dataset.id || '0', 10);
      _votePickPos = pos > 0 ? pos : 0;
      render();
      break;
    }
    case 'vote-confirm':
      if (ucSession && _votePickPos) {
        submitUndercoverVote(ucSession, _votePickPos);
        _votePickPos = 0;
      } else if (wwSession && _votePickPos) {
        submitWerewolfVote(wwSession, _votePickPos);
        _votePickPos = 0;
      }
      break;
    case 'vote-skip':
      if (ucSession) {
        submitUndercoverVote(ucSession, 0);
        _votePickPos = 0;
      } else if (wwSession) {
        submitWerewolfVote(wwSession, 0);
        _votePickPos = 0;
      }
      break;
    case 'speak-send': {
      const input = _ctx!.container.querySelector('#ubp-gm-speak-input') as HTMLInputElement | null;
      if (ucSession && input && input.value.trim()) {
        submitUndercoverSpeech(ucSession, input.value.trim());
      }
      break;
    }
    case 'speak-skip':
      if (ucSession) submitUndercoverSpeech(ucSession, '', true);
      break;
    // ─── 海龟汤 ───
    case 'soup-pick-host': {
      // 主持人单选（原地更新免闪烁）：再点取消；换人时旧行恢复、新行高亮，并从参与者勾选中移除
      const name = el.dataset.id || '';
      if (!name) break;
      const prev = _soupHost;
      _soupHost = prev === name ? '' : name;
      if (_soupHost) _invitePicked.delete(_soupHost);
      if (prev && prev !== _soupHost) refreshSoupRow(prev);
      if (prev) refreshSoupRow(prev);
      if (_soupHost) refreshSoupRow(_soupHost);
      refreshNpcFillChrome();
      refreshInviteChrome();
      break;
    }
    case 'soup-toggle-participant': {
      // 参与者勾选（原地更新免闪烁）；主持人与参与者互斥；满 4 位提示
      const name = el.dataset.id || el.dataset.soupRow || '';
      if (!name || name === _soupHost) break;
      if (_invitePicked.has(name)) _invitePicked.delete(name);
      else if (_invitePicked.size < SOUP_PARTICIPANT_FRIENDS_MAX) _invitePicked.add(name);
      else {
        if (_ctx) showScreenToast(_ctx.container, `参与者最多 ${SOUP_PARTICIPANT_FRIENDS_MAX} 位（共 ${SOUP_PARTICIPANT_FRIENDS_MAX + 1} 人含我）`);
        break;
      }
      refreshSoupRow(name);
      refreshNpcFillChrome();
      refreshInviteChrome();
      break;
    }
    case 'soup-cat':
      // 类型 chips：原地切换 on 态（免全量重绘闪烁）
      _soupCategory = (SOUP_CATEGORIES as readonly string[]).includes(el.dataset.id || '') ? (el.dataset.id as typeof _soupCategory) : '不限';
      refreshSoupChips();
      break;
    case 'soup-quota-minus':
      // 额度 stepper：原地更新数字与按钮可用态（免全量重绘闪烁）
      _soupQuota = Math.max(SOUP_QUOTA_MIN, _soupQuota - 1);
      refreshSoupStepper();
      break;
    case 'soup-quota-plus':
      _soupQuota = Math.min(SOUP_QUOTA_MAX, _soupQuota + 1);
      refreshSoupStepper();
      break;
    case 'soup-ask-send': {
      const input = _ctx!.container.querySelector('#ubp-gm-speak-input') as HTMLInputElement | null;
      if (tsSession && input && input.value.trim()) submitTurtleSoupQuestion(tsSession, input.value.trim());
      break;
    }
    case 'soup-ask-skip':
      if (tsSession) submitTurtleSoupSkip(tsSession);
      break;
    case 'soup-guess-open':
      _soupGuessOpen = true;
      render();
      break;
    case 'soup-guess-cancel':
      _soupGuessOpen = false;
      render();
      break;
    case 'soup-guess-send': {
      const textarea = _ctx!.container.querySelector('#ubp-soup-guess-input') as HTMLTextAreaElement | null;
      const value = (textarea?.value || '').trim();
      if (!tsSession || !value) break;
      _soupGuessOpen = false;
      submitTurtleSoupGuess(tsSession, value);
      break;
    }
    case 'soup-giveup-open':
      _soupGiveupOpen = true;
      render();
      break;
    case 'soup-giveup-cancel':
      _soupGiveupOpen = false;
      render();
      break;
    case 'soup-giveup-confirm':
      _soupGiveupOpen = false;
      if (tsSession) giveUpTurtleSoup(tsSession);
      break;
    // ─── 狼人杀 ───
    case 'seer-pick': {
      // 两步选择：点选高亮，经底部「确认查验」生效；再点同一目标取消
      const pos = parseInt(el.dataset.id || '0', 10);
      _seerPick = pos > 0 && _seerPick !== pos ? pos : 0;
      render();
      break;
    }
    case 'seer-confirm': {
      if (wwSession && _seerPick) {
        const pos = _seerPick;
        _seerPick = 0;
        submitWerewolfSeerCheck(wwSession, pos);
      }
      break;
    }
    case 'wolf-tactic': {
      const side = el.dataset.side === 'user' ? 'user' : 'ai';
      const val = el.dataset.id || '';
      const other = side === 'ai' ? _wolfUserTactic : _wolfAiTactic;
      if (val && other === val) {
        _ctx && showScreenToast(_ctx.container, 'AI 战术与我的战术不能重复选择');
        break;
      }
      if (side === 'ai') _wolfAiTactic = _wolfAiTactic === val ? '' : val;
      else _wolfUserTactic = _wolfUserTactic === val ? '' : val;
      render();
      break;
    }
    case 'wolf-tactic-confirm': {
      const custom = (_ctx!.container.querySelector('#ubp-gm-tactic-custom') as HTMLInputElement | null)?.value || '';
      if (wwSession) {
        submitWerewolfUserTactics(wwSession, _wolfAiTactic, _wolfUserTactic, custom);
        _wolfKillArmed = true;
        render();
        _ctx && showScreenToast(_ctx.container, '战术已确认，请选择今晚的刀口');
      }
      break;
    }
    case 'wolf-kill-pick': {
      // 两步选择：点选高亮，经底部「确认刀口」生效；再点同一目标取消
      const pos = parseInt(el.dataset.id || '0', 10);
      _wolfKillPick = pos > 0 && _wolfKillPick !== pos ? pos : 0;
      render();
      break;
    }
    case 'wolf-kill-confirm': {
      if (wwSession && _wolfKillPick) {
        const pos = _wolfKillPick;
        _wolfKillPick = 0;
        _wolfKillArmed = false;
        _wolfAiTactic = '';
        _wolfUserTactic = '';
        submitWerewolfUserKill(wwSession, pos);
      }
      break;
    }
    case 'poison-pick': {
      const pos = parseInt(el.dataset.id || '0', 10);
      _witchPoisonPos = pos > 0 && _witchPoisonPos !== pos ? pos : 0; // 再点同一目标取消
      if (_witchPoisonPos) _witchSave = false; // 同夜一瓶
      render();
      break;
    }
    case 'witch-toggle-save':
      _witchSave = !_witchSave;
      if (_witchSave) _witchPoisonPos = 0; // 同夜一瓶
      render();
      break;
    case 'witch-poison-clear':
      _witchPoisonPos = 0;
      render();
      break;
    case 'witch-confirm': {
      if (wwSession) {
        submitWerewolfWitch(wwSession, _witchSave, _witchPoisonPos);
        _witchSave = false;
        _witchPoisonPos = 0;
      }
      break;
    }
    case 'wolf-speak-send': {
      const input = _ctx!.container.querySelector('#ubp-gm-speak-input') as HTMLInputElement | null;
      if (wwSession && input && input.value.trim()) submitWerewolfSpeech(wwSession, input.value.trim());
      break;
    }
    case 'wolf-speak-skip':
      if (wwSession) submitWerewolfSpeech(wwSession, '');
      break;
    case 'pk-send': {
      const input = _ctx!.container.querySelector('#ubp-gm-speak-input') as HTMLInputElement | null;
      if (wwSession) submitWerewolfPkSpeech(wwSession, input?.value || '');
      break;
    }
    case 'lastwords-send': {
      const input = _ctx!.container.querySelector('#ubp-gm-speak-input') as HTMLInputElement | null;
      if (wwSession) submitWerewolfLastWords(wwSession, input?.value || '', { exileDone: true });
      break;
    }
    case 'retry':
      if (ucSession) retryCurrentStep(ucSession);
      else if (wwSession) retryWerewolfStep(wwSession);
      else if (tsSession) retryTurtleSoupStep(tsSession);
      break;
    case 'abort-gen':
      stopGameGeneration();
      break;
    case 'gm-voice-play':
      // 台词语音条：同一条再点即停；换一条先停旧条（playVoice 会接管全局播放）
      gmVoiceToggle(el.dataset.gmvKey || '');
      break;
    case 'records':
      _view = 'records';
      render();
      break;
    case 'open-detail':
      _detailId = el.dataset.id || '';
      _detailTab = 'replay';
      _view = 'detail';
      render();
      break;
    case 'open-afterparty':
      _detailId = el.dataset.id || '';
      _detailTab = 'afterparty';
      _view = 'detail';
      render();
      break;
    case 'detail-tab':
      _detailTab = (el.dataset.id as typeof _detailTab) || 'replay';
      render();
      break;
    case 'regen':
      if (_ctx) {
        showScreenToast(_ctx.container, '正在重新生成高光与复盘…');
        void regenerateGameEpilogue(findDetailRecord()?.gameType || 'undercover', _detailId);
      }
      break;
    case 'back-records':
      _view = 'records';
      render();
      break;
    case 'back-home-confirm': {
      // 对局不随退出中断：AI 链后台继续推进（用户定案：只有「终止」按钮或关闭酒馆才停）
      const inGame = Boolean(ucSession || wwSession || tsSession);
      _quitOpen = false; // 退出弹层内点「后台继续」也要收层，防下次进对局视图时残留
      _view = 'home';
      render();
      if (inGame && _ctx) showScreenToast(_ctx.container, '对局已在后台继续 · 点顶部胶囊可回到对局');
      break;
    }
    case 'back-home':
      _view = 'home';
      render();
      break;
    default: break;
  }
}

// ─── App 定义 ───

// 灵动岛胶囊「回到对局」入口：phone-ui 经事件总线跳转（避免 phone-ui ↔ 本模块循环依赖）。
// 模块单例监听，App 未挂载时先 openApp 再进对局视图。
onPhoneEvent('ubp-phone:goto-game', () => {
  if (!_ctx) openApp('game-center');
  enterPlayView();
});

export const gameCenterApp: PhoneApp = {
  id: 'game-center',
  name: '游戏中心',
  icon: ubpIcon('gamepad'),
  color: '#8B5CF6',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    const token = ++_mountToken;
    _view = 'home';
    _renderedView = '';
    _viewScroll.clear(); // 滚动记忆重置：重开 App 从顶开始，不继承上一次打开时的位置
    _invitePicked = new Set();
    _votePickPos = 0;
    _quitOpen = false;
    _startConflict = false;
    resetSoupInviteState();
    // 单局制收口：老档可能留着 2~3 局未完成（旧版多局并存遗留，除最新一局外全是断链僵尸）
    const dropped = enforceSingleActiveGame();
    // 全局搜索深链：目标=对局记录 id → 直接落在复盘详情（记录不在时 render 回落记录列表）
    const deepGame = takePendingAppTarget('game-center');
    if (deepGame) {
      _detailId = deepGame;
      _detailTab = 'summary';
      _view = 'detail';
    }
    // 引擎状态推进 → 重渲染（对局后台推进也能刷新；终局赛后产物补写同理）
    const offState = onGameStateChanged(() => {
      if (_ctx !== ctx || token !== _mountToken) return;
      const games = gamesOf(readDataSafe());
      const hasActive = hasAnyRunningGame(games);
      if (_view === 'play' && !hasActive) {
        const latest = allRecordsSorted()[0] || null;
        if (latest) {
          renderEndView(latest);
          return;
        }
      }
      render();
    });
    const offEpilogue = onGameEpilogueChanged(() => {
      if (_ctx !== ctx || token !== _mountToken) return;
      emitPhoneEvent('ubp-phone:data-changed');
      if (_view === 'detail' || _view === 'records' || _view === 'play' || _view === 'end') render();
    });
    ctx.container.addEventListener('click', handleClick);
    render();
    if (dropped > 0) showScreenToast(ctx.container, `已清理 ${dropped} 局过期的未完成对局`);
    return () => {
      _mountToken++;
      offState();
      offEpilogue();
      gmVoiceStop(false); // 卸载即停台词语音（不给已销毁的 DOM 打补丁）
      emitPhoneEvent('ubp-phone:game-view', false);
      ctx.container.removeEventListener('click', handleClick);
      void persistPhoneData();
      _ctx = null;
    };
  },
};
