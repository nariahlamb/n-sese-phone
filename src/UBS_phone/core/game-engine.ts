// ===== 游戏中心引擎（2 类轻量请求管线 + 谁是卧底状态机 + 赛后管线） =====
// 2 类请求（用户定案）：不走世界书激活——无 injectPrompts、无 world_info/角色卡槽位，
// 全部上下文自拼进 ordered_prompts=[system 总纲, 'user_input']，max_chat_history:0；
// 用户定案（2026-10-15）：游戏引擎不挂破限头/尾部破限——总纲即身份，破限会与其打架。
// 防全知：每角色请求按 docs/16 §2.5 视角矩阵拼装（situation 仅作者回注；think 不回喂）。
// 存档：PhoneChatData.games（每步 mutatePhoneData 去抖写盘）；session 守卫防陈旧异步回调。

import { makeId } from './ubp-utils';
import { ensurePrivateConversation, appendMessage, makeMessageId, type PhoneMessage } from './chat-model';
import { PhoneChatError } from './chat-engine';
import { getTavernHelper, makeGenerationId, stopGenerationById } from './host-env';
import {
  emptyPhoneGames,
  gameTypeName,
  normalizePhoneGames,
  pushGameRecord,
  pushGameSummary,
  summariesForPlayers,
  summaryPromptLines,
  SOUP_QUOTA_DEFAULT,
  SOUP_QUOTA_MAX,
  SOUP_QUOTA_MIN,
  type ActiveTurtleSoup,
  type ActiveUndercover,
  type ActiveWerewolf,
  type GameRecord,
  type GameReplayEntry,
  type GameSummary,
  type GameType,
  type TurtleSoupSeat,
  type UndercoverSeat,
  type WerewolfRole,
  type WerewolfSeat,
} from './game-model';
import {
  buildEpilogueRequest,
  buildTurtleSoupAction,
  buildTurtleSoupDealRequest,
  buildTurtleSoupAnswerRequest,
  buildTurtleSoupRevealRequest,
  buildTurtleSoupSystemMessage,
  buildTurtleSoupSystemPrompt,
  buildTurtleSoupVerdictRequest,
  TURTLESOUP_RULES,
  buildWerewolfLastWordsAction,
  buildWerewolfMateAction,
  buildWerewolfPkAction,
  buildWerewolfRoleTactics,
  buildWerewolfSeerAction,
  buildWerewolfSpeechAction,
  buildWerewolfSystemMessage,
  buildWerewolfSystemPrompt,
  buildWerewolfVoteAction,
  buildWerewolfWitchAction,
  buildWerewolfWolfAction,
  WEREWOLF_RULES,
  buildGameUserContext,
  buildHighlightRequest,
  buildPublicProfiles,
  buildSeatLines,
  buildSocialHintLines,
  buildUndercoverHostRequest,
  buildUndercoverSpeechAction,
  buildUndercoverSystemPrompt,
  buildUndercoverVoteAction,
  UNDERCOVER_RULES,
} from './game-prompts';
import {
  fallbackSpyWordPair,
  parseGameEpilogue,
  parseGameHighlight,
  parseSeatToken,
  parseTriple,
  parseSpeechReply,
  parseSpyHostReply,
  parseTurtleSoupAction,
  parseTurtleSoupAnswer,
  parseTurtleSoupPuzzle,
  parseTurtleSoupReveal,
  parseTurtleSoupVerdict,
  parseVoteAction,
  type ParsedSoupReveal,
} from './game-parser';
import { getPhoneSettings, isVoiceEnabled } from './phone-settings';
import { resolvePhoneApi, validatePhoneApi, withPhoneTextAiRetry } from './phone-api';
import { beginPhoneAiActivity, updatePhoneAiActivity } from './ai-activity';
import { mutatePhoneData, readPhoneData, readPhoneDataRef, phoneDataRevision } from './phone-store';
import { getRoster } from './roster';
import { npcPersona } from './game-npc';
import { makeSocialPostId, mergeMomentPosts, normalizeMomentPost, readSocialOf, type MomentPost } from './social-model';
import { achFlag, emitAch } from './phone-achievements';

const GAME_HISTORY_LIMIT = 20;

// ─── NPC 补位（docs/16 §10） ───
// 用户定案：邀请页显式开关（默认开）选定补位名单，UI 把「真实好友 + 补位者」一并传进来；
// 引擎不做隐式补齐，只负责按通讯录判定谁是补位者（提示词与赛后隔离共用同一口径）。
// 人设由名字确定性推导（零存档字段）；赛后零残留——朋友圈/私聊系统消息/总结匹配名单全部按真实角色过滤。

/** 真实参与者名集合（主角 / 通讯录角色 / 自定义联系人）；NPC = 不在集合内的补位角色。 */
function knownParticipantNames(): Set<string> {
  const roster = getRoster();
  const set = new Set<string>(roster.contacts.map(c => c.name));
  for (const name of readPhoneDataRef().customContacts || []) set.add(name);
  set.add(roster.protagonistName);
  return set;
}

/** 单个判定（零拷贝只读，避免整份数据归一化）。 */
function isKnownParticipant(name: string): boolean {
  const roster = getRoster();
  if (name === roster.protagonistName) return true;
  if (roster.contacts.some(c => c.name === name)) return true;
  return (readPhoneDataRef().customContacts || []).includes(name);
}

/** 席位 → npc 标记（提示词构建用；同一判定口径，名单只构建一次）。 */
function npcFlags(players: ReadonlyArray<{ name: string }>): boolean[] {
  const known = knownParticipantNames();
  return players.map(p => !known.has(p.name));
}

// ─── 台词语音（docs/50） ───
// 判定按说话人身份自动完成，不依赖提示词纪律：真实角色（通讯录/自定义联系人/主持人）=语音条；
// 补位🎭NPC 与玩家席位恒为纯文本（玩家输入即文字）。提示词纪律只是第三层。

/** 该坐席的台词是否发语音条（TTS 总开关开 + 非补位者）。玩家席位恒不调用（玩家发言不语音化）。 */
function speechVoiceOn(name: string): boolean {
  try {
    if (!isVoiceEnabled()) return false;
  } catch (_e) {
    return false;
  }
  return isKnownParticipant(name);
}

/** 是否要求模型写情绪/演绎标注（情绪演绎开关未关）。 */
function voiceEmotionOn(): boolean {
  try {
    return getPhoneSettings().voiceEmotion !== false;
  } catch (_e) {
    return false;
  }
}

/** 行动指令是否追加语音标注要求（= 该坐席会发语音条 且 情绪演绎开关未关）。 */
function voicePromptOn(name: string): boolean {
  return speechVoiceOn(name) && voiceEmotionOn();
}

/** 语音条目三字段（未开语音的坐席返回空对象，条目上不写键——与旧存档形状一致）。 */
type EntryVoiceFields = { voice?: true; voiceEmotion?: string; voiceDelivery?: string };

function voiceFields(name: string, parsed: { emotion?: string; delivery?: string }): EntryVoiceFields {
  if (!speechVoiceOn(name)) return {};
  const out: EntryVoiceFields = { voice: true };
  const emo = String(parsed.emotion || '').trim().slice(0, 20);
  const dev = String(parsed.delivery || '').trim().slice(0, 40);
  if (emo) out.voiceEmotion = emo;
  if (dev) out.voiceDelivery = dev;
  return out;
}

export class PhoneGameError extends Error {
  kind: 'env' | 'network' | 'parse' | 'state' | 'aborted';
  constructor(kind: 'env' | 'network' | 'parse' | 'state' | 'aborted', message: string) {
    super(message);
    this.name = 'PhoneGameError';
    this.kind = kind;
  }
}

// ─── 状态变化通知（App mount 注册 → render + data-changed） ───
// 多监听器：游戏中心 App（挂载期间）与手机壳（灵动岛胶囊，常驻）同时订阅——
// 退出游戏界面/App 卸载后引擎照常推进，胶囊仍能逐步刷新。

const _changeListeners = new Set<() => void>();

/** 注册游戏状态变化监听；返回退订函数（App unmount 成对调用）。传 null 清空全部。 */
export function onGameStateChanged(cb: (() => void) | null): () => void {
  if (!cb) {
    _changeListeners.clear();
    return () => undefined;
  }
  _changeListeners.add(cb);
  return () => { _changeListeners.delete(cb); };
}

function notifyChanged(): void {
  for (const cb of [..._changeListeners]) {
    try { cb(); } catch (_e) { /* UI 故障不阻断引擎 */ }
  }
}

// ─── 错误通道（UI 重试条；重试成功/新步骤开始时清空） ───

let _lastError = '';

export function lastGameError(): string {
  return _lastError;
}

function setLastError(message: string): void {
  _lastError = message;
  notifyChanged();
}

// ─── session 守卫 ───

let _session = 0;
const _activeGenIds = new Set<string>();
const _activeAbortControllers = new Set<AbortController>();

function isSessionValid(session: number): boolean {
  return session === _session;
}

/** 当前是否有活跃生成（UI 终止按钮/防重入）。 */
export function hasGameGeneration(): boolean {
  return _activeGenIds.size > 0;
}

/** 终止当前游戏内生成（结果丢弃，状态停留在当前步可重试）。 */
export function stopGameGeneration(): void {
  for (const id of [..._activeGenIds]) {
    try { stopGenerationById(id); } catch (_e) { /* ignore */ }
  }
  for (const controller of [..._activeAbortControllers]) {
    try { controller.abort(); } catch (_e) { /* ignore */ }
  }
}

// ─── 对局进度快照（灵动岛胶囊/悬浮球提示；只读公开信息，不泄露夜间身份） ───

export interface GameProgressInfo {
  gameType: GameType;
  /** 展示文案（如「小美 发言中」「投票中 3/6」「轮到你发言」）。 */
  text: string;
  /** 是否等待玩家操作（球胶囊只在 myTurn 时出现）。 */
  myTurn: boolean;
}

/** 当前对局进度（无进行中对局=null）。夜间步只报角色不报名字（视角矩阵）。 */
export function gameProgressStatus(): GameProgressInfo | null {
  const games = readGames();
  const ww = games.active.werewolf;
  const uc = games.active.undercover;
  const ts = games.active.turtleSoup;
  if (ww && ww.phase !== 'end') {
    const me = ww.players.find(p => p.isUser);
    const pending = _pendingLastWords;
    if (pending && pending.session === ww.session) {
      return { gameType: 'werewolf', text: '等待你的遗言', myTurn: true };
    }
    if (ww.phase === 'seer') {
      const iAmSeer = me?.role === '预言家' && me.alive;
      return { gameType: 'werewolf', text: iAmSeer ? '轮到你查验' : '预言家行动中', myTurn: iAmSeer };
    }
    if (ww.phase === 'wolf') {
      const iAmWolf = me?.role === '狼人' && me.alive;
      return { gameType: 'werewolf', text: iAmWolf ? (ww.userTactics ? '轮到你选定刀口' : '轮到你安排战术') : '狼人行动中', myTurn: iAmWolf };
    }
    if (ww.phase === 'witch') {
      const iAmWitch = me?.role === '女巫' && me.alive;
      return { gameType: 'werewolf', text: iAmWitch ? '轮到你用药' : '女巫行动中', myTurn: iAmWitch };
    }
    if (ww.phase === 'speak' || ww.phase === 'pk-speak') {
      const seat = ww.players[ww.currentSpeaker];
      const myTurn = Boolean(seat?.isUser && seat.alive);
      return { gameType: 'werewolf', text: myTurn ? '轮到你发言' : `${seat?.name || 'AI'} 发言中`, myTurn };
    }
    // vote / pk-vote
    const voters = ww.players.filter(p => p.alive && !(ww.phase === 'pk-vote' && ww.pkCandidates.includes(p.position)));
    const done = voters.filter(p => p.voteDone).length;
    const myTurn = Boolean(me?.alive && !me?.voteDone && voters.includes(me!));
    return { gameType: 'werewolf', text: myTurn ? '轮到你投票' : `投票中 ${done}/${voters.length}`, myTurn };
  }
  if (uc && uc.phase !== 'end') {
    const me = uc.players.find(p => p.isUser);
    if (uc.phase === 'words') return { gameType: 'undercover', text: '主持人分词中', myTurn: false };
    if (uc.phase === 'speak') {
      const seat = uc.players[uc.currentSpeaker];
      const myTurn = Boolean(seat?.isUser && seat.alive);
      return { gameType: 'undercover', text: myTurn ? '轮到你描述' : `${seat?.name || 'AI'} 发言中`, myTurn };
    }
    const alive = uc.players.filter(p => p.alive);
    const done = alive.filter(p => p.voteDone).length;
    const myTurn = Boolean(me?.alive && !me?.voteDone);
    return { gameType: 'undercover', text: myTurn ? '轮到你投票' : `投票中 ${done}/${alive.length}`, myTurn };
  }
  if (ts && ts.phase !== 'end') {
    if (ts.phase === 'deal') return { gameType: 'turtlesoup', text: '主持人拟题中', myTurn: false };
    if (ts.phase === 'reveal') return { gameType: 'turtlesoup', text: '主持人揭晓中', myTurn: false };
    const seat = ts.players[ts.currentSpeaker];
    const myTurn = Boolean(seat?.isUser);
    return { gameType: 'turtlesoup', text: myTurn ? '轮到你提问' : `${seat?.name || 'AI'} 思考中`, myTurn };
  }
  return null;
}

// ─── 对局生命周期：单局制收口 + 放弃（docs/16 §2.11） ───
// 引擎只维护一条活链（_session 全局唯一 + isSessionValid 守卫），多局并存时除最新一局外
// 全是被永久失效的断链僵尸（提交静默 no-op、续玩条永不消失）——故产品定案「同一时间只允许
// 一局进行中」：UI 开新局前确认放弃旧局，本层再兜一道守卫；老档历史多局由收口函数清理。

/** 未完成对局的游戏类型（单局制下至多一局；无=null）。 */
export function runningGameType(): GameType | null {
  const active = readGames().active;
  if (active.werewolf) return 'werewolf';
  if (active.undercover) return 'undercover';
  if (active.turtleSoup) return 'turtlesoup';
  return null;
}

/** 单局制开局守卫（三款游戏 start* 共用）：已有未完成对局时拒绝——UI 已先弹确认放弃旧局，
 *  此处是防绕过兜底（直调引擎/未来新入口都不会造出第二局僵尸）。 */
function assertNoRunningGame(): void {
  const running = runningGameType();
  if (running) throw new PhoneGameError('state', `还有一局${gameTypeName(running)}没打完 —— 先结束它再开新局`);
}

/** 放弃并清空一局未完成对局（玩家主动退出；不写对局记录、不落总结池、不进摘要）。
 *  先终止在途请求：迟到的回调由各步 currentX / isSessionValid 守卫丢弃，槽位不会被复活。 */
export function abandonGame(type: GameType): void {
  const active = readGames().active;
  const slot = type === 'turtlesoup' ? active.turtleSoup : type === 'werewolf' ? active.werewolf : active.undercover;
  if (!slot) return;
  _lastError = '';
  stopGameGeneration();
  mutatePhoneData(d => {
    if (!d.games) return;
    if (type === 'turtlesoup') d.games.active.turtleSoup = null;
    else d.games.active[type] = null;
  });
  notifyChanged();
  // L9 成就：玩家亲手放弃本局（无进行中局时首行早退，天然只记成功）
  emitAch('phone_game_abandoned', { game: type });
}

/** 单局收口（游戏中心挂载时调用）：老档可能同时留着 2~3 局未完成（旧版多局并存遗留，
 *  除最新一局外都已是断链僵尸）——按 startedAt 保留最新一局，其余清空。
 *  返回被清理的局数（0=无动作，无并存时零开销）。 */
export function enforceSingleActiveGame(): number {
  const { active } = readGames();
  const entries = [
    active.werewolf ? { slot: 'werewolf' as const, at: active.werewolf.startedAt } : null,
    active.undercover ? { slot: 'undercover' as const, at: active.undercover.startedAt } : null,
    active.turtleSoup ? { slot: 'turtleSoup' as const, at: active.turtleSoup.startedAt } : null,
  ].filter((x): x is { slot: 'werewolf' | 'undercover' | 'turtleSoup'; at: number } => x !== null);
  if (entries.length <= 1) return 0;
  entries.sort((a, b) => b.at - a.at);
  const dropped = entries.slice(1).map(e => e.slot);
  mutatePhoneData(d => {
    if (!d.games) return;
    for (const slot of dropped) d.games.active[slot] = null;
  });
  notifyChanged();
  return dropped.length;
}

// ─── 2 类轻量请求管线 ───

/** 单请求硬超时：流式挂死/网关无响应时兜底中断，座位留在「未完成」态走重试，投票不再永久卡死。 */
const GAME_REQUEST_TIMEOUT_MS = 180000;

async function runGameRequest(args: { system: string; user: string }): Promise<string> {
  const th = getTavernHelper();
  if (!th?.generateRaw) throw new PhoneGameError('env', '无法访问酒馆助手 API（generateRaw），请检查酒馆助手版本');
  const apiWarning = validatePhoneApi('game');
  if (apiWarning) throw new PhoneGameError('env', apiWarning);
  const generationId = makeGenerationId('ubp-game');
  _activeGenIds.add(generationId);
  let activity: ReturnType<typeof beginPhoneAiActivity> | null = null;
  activity = beginPhoneAiActivity({
    feature: '游戏中心',
    label: '游戏中心',
    phase: 'requesting',
    generationId,
    appId: 'game',
    tone: 'ai',
    cancelable: true,
    cancel: () => {
      if (activity) updatePhoneAiActivity(activity.id, { phase: 'terminating' });
      stopGameGeneration();
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 超时同时 abort 重试循环（否则 race 拒绝后内层重试会在后台继续发请求）
  const controller = new AbortController();
  _activeAbortControllers.add(controller);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      try { stopGenerationById(generationId); } catch (_e) { /* ignore */ }
      reject(new PhoneGameError('network', `AI 请求超时（${Math.round(GAME_REQUEST_TIMEOUT_MS / 1000)} 秒无响应，已自动中断）`));
    }, GAME_REQUEST_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([
      withPhoneTextAiRetry('game', () => th.generateRaw({
        should_silence: true,
        user_input: args.user,
        ordered_prompts: [
          { role: 'system', content: args.system },
          'user_input',
        ],
        max_chat_history: 0,
        ...(resolvePhoneApi('game').api ? { custom_api: resolvePhoneApi('game').api } : {}),
        generation_id: generationId,
      }), { signal: controller.signal, activityId: activity?.id }),
      timeout,
    ]);
    const text = String(raw ?? '').trim();
    if (!text) throw new PhoneGameError('parse', 'AI 返回了空内容');
    return text;
  } catch (error) {
    // 超时已由上面的 setTimeout 分支构造为 PhoneGameError（network），优先原样抛出
    if (error instanceof PhoneChatError || error instanceof PhoneGameError) throw error;
    if (controller.signal.aborted) throw new PhoneGameError('aborted', '已终止本次生成');
    const message = error instanceof Error ? error.message : String(error);
    throw new PhoneGameError('network', `AI 请求失败：${message}`);
  } finally {
    if (timer) clearTimeout(timer);
    _activeAbortControllers.delete(controller);
    _activeGenIds.delete(generationId);
    activity?.end();
  }
}

// ─── games 域存取 ───

// U23(十一轮)：按数据修订记忆化——游戏域读取原是「每次全域 normalize 重建」（通话期间
// refreshIsland 每秒一次）。返回的共享对象只读（写入一律走 mutatePhoneData 改原始数据，
// 修订推进后此处自然重建）。
let _gamesMemo: { rev: number; src: unknown; out: NonNullable<ReturnType<typeof normalizePhoneGames>> } | null = null;
/** 测试钩子：驱动一次 readGames 并观测记忆化状态（生产零消费）。 */
export function __readGamesForTests(): { rev: number | null; out: unknown } {
  const out = readGames();
  return { rev: _gamesMemo ? _gamesMemo.rev : null, out };
}
function readGames() {
  const raw = readPhoneDataRef().games;
  const rev = phoneDataRevision();
  // 双键：修订计数 + 原始 games 对象身份。修订覆盖一切走 mutatePhoneData 的写入；
  // 身份兜住「绕过写通道的整体替换」（测试播种/防御式换绑）。
  if (_gamesMemo && _gamesMemo.rev === rev && _gamesMemo.src === raw) return _gamesMemo.out;
  const out = normalizePhoneGames(raw) || emptyPhoneGames();
  _gamesMemo = { rev, src: raw, out };
  return out;
}

function currentUndercover(): ActiveUndercover | null {
  return readGames().active.undercover || null;
}

function storyTimeNow(): string {
  return getRoster().global.time || '';
}

function meName(): string {
  return getRoster().protagonistName;
}

/** 历史可见行（视角矩阵：system/speech/vote 全员；think/situation 不回喂；狼人杀 private 仅狼视角）。 */
function visibleHistoryLines(
  entries: readonly GameReplayEntry[],
  players: readonly UndercoverSeat[] | readonly WerewolfSeat[],
  viewer?: { isWolf?: boolean },
): string {
  const posName = (pos?: number): string => {
    if (pos === undefined) return '';
    const p = players.find(x => x.position === pos);
    return p ? `${pos}号位 ${p.name}` : `${pos}号位`;
  };
  const lines: string[] = [];
  for (const e of entries) {
    if (e.type === 'system') lines.push(e.text);
    else if (e.type === 'speech') lines.push(`${posName(e.pos)}：${e.text}`);
    else if (e.type === 'vote') lines.push(e.text);
    else if (e.type === 'private' && viewer?.isWolf) lines.push(e.text);
  }
  return lines.slice(-GAME_HISTORY_LIMIT).join('\n');
}

function speechLines(entries: readonly GameReplayEntry[], round: number | null, players: readonly UndercoverSeat[]): string {
  const posName = (pos?: number): string => {
    const p = players.find(x => x.position === pos);
    return p ? `${p.position}号位 ${p.name}` : '';
  };
  return entries
    .filter(e => e.type === 'speech' && (round === null || e.round === round))
    .map(e => `${posName(e.pos)}：${e.text}`)
    .join('\n');
}

/** 存储当前卧底局（session 校验内）。 */
function mutateUndercover(session: number, mutator: (uc: ActiveUndercover) => void): void {
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    const uc = d.games.active.undercover;
    if (uc && uc.session === session) mutator(uc);
  });
  notifyChanged();
}

// ─── 人设上下文构建 ───

function buildSelfProfile(name: string, position: number) {
  const roster = getRoster();
  const c = roster.contacts.find(x => x.name === name);
  // 补位 NPC 用确定性人设兜底（自定义联系人等真实角色维持「未记录」原状）
  const npc = !c && !isKnownParticipant(name) ? npcPersona(name) : null;
  return {
    name,
    position,
    identity: c?.identity || npc?.identity || '',
    personality: c?.brief || npc?.personality || '',
    languageStyle: c?.languageStyle || npc?.languageStyle || '',
    attitude: c?.attitude || npc?.attitude || '',
    brief: c?.brief || npc?.brief || '',
    personalityShift: roster.personality[name] || '',
  };
}

function buildSocialHints(names: readonly string[]): string {
  const data = readPhoneData();
  const social = readSocialOf(data);
  const hints: Array<{ name: string; chat?: string; moment?: string }> = [];
  for (const name of names) {
    const conv = data.conversations.find(c => c.kind === 'private' && c.members.includes(name));
    const last = [...(conv?.messages || [])].reverse().find(m => m.from !== 'system');
    const moment = social.moments.find(m => m.author === name);
    const hint: { name: string; chat?: string; moment?: string } = { name };
    if (last?.content) hint.chat = last.content;
    if (moment?.text) hint.moment = moment.text;
    if (hint.chat || hint.moment) hints.push(hint);
  }
  return buildSocialHintLines(hints);
}

/** 卧底角色请求（system 总纲 + 骨架 + 行动段）。 */
function undercoverRequestUser(uc: ActiveUndercover, seat: UndercoverSeat, actionPrompt: string): string {
  const roster = getRoster();
  const me = uc.players.find(p => p.isUser);
  const npc = npcFlags(uc.players);
  const user = buildGameUserContext({
    rules: UNDERCOVER_RULES,
    summaries: summaryPromptLines(summariesForPlayers(readGames().summaries.undercover, uc.players.map(p => p.name), 3)).join('\n'),
    seats: buildSeatLines(uc.players.map((p, i) => ({ position: p.position, name: p.name, isUser: p.isUser, alive: p.alive, npc: npc[i] })), seat.position),
    profiles: buildPublicProfiles(roster, uc.players.map((p, i) => ({ position: p.position, name: p.name, npc: npc[i] }))),
    socialHints: buildSocialHints(uc.players.map(p => p.name)),
    self: buildSelfProfile(seat.name, seat.position),
    userName: me?.name || meName(),
    userPosition: me?.position || 1,
    history: visibleHistoryLines(uc.entries, uc.players),
    lastSituation: seat.situation,
  });
  return `${user}\n\n${actionPrompt}`;
}

function appendEntries(uc: { entries: GameReplayEntry[] }, list: GameReplayEntry[]): void {
  uc.entries.push(...list);
  if (uc.entries.length > 600) uc.entries.splice(0, uc.entries.length - 600);
}

function shuffle<T>(list: T[], rand: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── 谁是卧底：开局与分词 ───

export async function startUndercover(inviteeNames: readonly string[]): Promise<void> {
  assertNoRunningGame();
  const roster = getRoster();
  const me = roster.protagonistName;
  const invitees = inviteeNames.map(n => n.trim()).filter(Boolean).slice(0, 5);
  if (invitees.length < 3) throw new PhoneGameError('state', '至少邀请 3 位好友（4-6 人局）');
  const names = shuffle([me, ...invitees]);
  const seats: UndercoverSeat[] = names.map((name, idx) => ({
    position: idx + 1,
    name,
    isUser: name === me,
    word: '',
    isSpy: false,
    role: '平民',
    alive: true,
    hasSpoken: false,
    votedFor: null,
    voteDone: false,
    situation: '',
  }));
  const session = ++_session;
  const uc: ActiveUndercover = {
    gameType: 'undercover',
    session,
    phase: 'words',
    round: 1,
    currentSpeaker: 0,
    players: seats,
    civilianWord: '',
    spyWord: '',
    winner: '',
    entries: [{ type: 'system', text: `🎲 谁是卧底开始！${names.length} 人局（1 卧底、${names.length - 1} 平民），主持人正在生成词语并私发…` }],
    startedAt: Date.now(),
    storyTime: storyTimeNow(),
  };
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    d.games.active.undercover = uc;
  });
  notifyChanged();
  await runHostWordAssignment(session);
}

async function runHostWordAssignment(session: number): Promise<void> {
  const uc = currentUndercover();
  if (!uc || !isSessionValid(session)) return;
  const host = buildUndercoverHostRequest(uc.players.map(p => `${p.position}号位 ${p.name}${p.isUser ? '（人类玩家）' : ''}`).join('、'));
  let parsed = { civilianWord: '', spyWord: '', assignment: {} as Record<number, string> };
  try {
    const raw = await runGameRequest({ system: host.system, user: host.user });
    if (!isSessionValid(session)) return;
    parsed = parseSpyHostReply(raw, uc.players.map(p => ({ position: p.position, name: p.name })));
  } catch (_e) {
    if (!isSessionValid(session)) return;
    // 主持人失败静默走回退词对池（不阻断开局）
  }
  mutateUndercover(session, target => {
    const ucNow = target;
    let civilianWord = parsed.civilianWord;
    let spyWord = parsed.spyWord;
    if (!civilianWord || !spyWord) {
      const pair = fallbackSpyWordPair();
      civilianWord = pair[0];
      spyWord = pair[1];
    }
    ucNow.civilianWord = civilianWord;
    ucNow.spyWord = spyWord;
    // 卧底席位：按 AI 分配 → 兜底随机
    let spyPos = 0;
    for (const [posStr, w] of Object.entries(parsed.assignment)) {
      if (w === spyWord) spyPos = parseInt(posStr, 10);
    }
    if (!spyPos || !ucNow.players.some(p => p.position === spyPos)) {
      spyPos = ucNow.players[Math.floor(Math.random() * ucNow.players.length)].position;
    }
    for (const p of ucNow.players) {
      p.isSpy = p.position === spyPos;
      p.role = p.isSpy ? '卧底' : '平民';
      p.word = parsed.assignment[p.position] || (p.isSpy ? spyWord : civilianWord);
    }
    appendEntries(ucNow, [
      { type: 'action', text: `[主持人分词] 平民词【${civilianWord}】；卧底词【${spyWord}】；卧底：${spyPos}号位 ${ucNow.players.find(p => p.position === spyPos)?.name || '?'}` },
      { type: 'system', text: '🤫 主持人已将词语悄悄私发给每位玩家，请轮流用一句话描述自己的词。' },
    ]);
    ucNow.phase = 'speak';
    ucNow.round = 1;
    ucNow.currentSpeaker = 0;
  });
  void runSpeakStep(session);
}

// ─── 谁是卧底：描述轮 ───

function advanceSpeaker(uc: ActiveUndercover): 'speak' | 'vote' {
  let next = uc.currentSpeaker + 1;
  while (next < uc.players.length && (!uc.players[next].alive || uc.players[next].hasSpoken)) next++;
  if (next >= uc.players.length) return 'vote';
  uc.currentSpeaker = next;
  return 'speak';
}

/** 推进当前发言人（AI 自动请求；玩家=等待输入）。可从断点/重试调用。 */
export async function runSpeakStep(session: number): Promise<void> {
  const uc = currentUndercover();
  if (!uc || !isSessionValid(session) || uc.phase !== 'speak') return;
  // 跳过死者/已发言者：跳过结果必须经 mutate 落库——currentUndercover() 返回归一化副本，
  // 在副本上推进 currentSpeaker 会让提交守卫（按 currentSpeaker 取座位）错位 → 同一步骤无限重复请求。
  let idx = uc.currentSpeaker;
  while (idx < uc.players.length && (!uc.players[idx].alive || uc.players[idx].hasSpoken)) idx++;
  if (idx >= uc.players.length) {
    startUndercoverVote(session);
    return;
  }
  if (idx !== uc.currentSpeaker) {
    mutateUndercover(session, target => { target.currentSpeaker = idx; });
    if (!isSessionValid(session)) return;
  }
  const seat = uc.players[idx];
  if (seat.isUser) {
    _lastError = '';
    notifyChanged(); // 等待玩家输入（UI 呈现输入条）
    return;
  }
  const action = buildUndercoverSpeechAction({
    round: uc.round,
    position: seat.position,
    name: seat.name,
    word: seat.word,
    speeches: speechLines(uc.entries, null, uc.players),
    voiceEmotion: voicePromptOn(seat.name),
  });
  try {
    const raw = await runGameRequest({ system: buildUndercoverSystemPrompt(), user: undercoverRequestUser(uc, seat, action) });
    if (!isSessionValid(session)) return;
    const parsed = parseSpeechReply(raw, '嗯……这个东西大家生活里挺常见的，后置位继续听听看。', '，后置位继续听听看。');
    mutateUndercover(session, target => {
      const cur = target.players.find(p => p.position === seat.position);
      if (!cur) return;
      cur.situation = parsed.situation || cur.situation;
      cur.hasSpoken = true;
      const list: GameReplayEntry[] = [];
      if (parsed.think) list.push({ type: 'think', pos: seat.position, round: target.round, text: parsed.think });
      if (parsed.situation) list.push({ type: 'situation', pos: seat.position, round: target.round, text: parsed.situation });
      list.push({ type: 'speech', pos: seat.position, round: target.round, text: parsed.speech, ...voiceFields(seat.name, parsed) });
      appendEntries(target, list);
      advanceSpeaker(target);
    });
    void runSpeakStep(session);
  } catch (error) {
    if (!isSessionValid(session)) return;
    if (error instanceof PhoneGameError && error.kind === 'aborted') return; // 用户终止：状态不变可重试
    setLastError(error instanceof Error ? error.message : String(error)); // 状态未变：App 呈现重试条
  }
}

/** 玩家提交描述（skip=跳过：落兜底话术）。 */
export function submitUndercoverSpeech(session: number, text: string, skip = false): void {
  const uc = currentUndercover();
  if (!uc || !isSessionValid(session) || uc.phase !== 'speak') return;
  const seat = uc.players[uc.currentSpeaker];
  if (!seat || !seat.isUser) return;
  const content = (text || '').trim() || (skip ? '（这轮我先过，听听大家怎么说。）' : '');
  if (!content) return;
  mutateUndercover(session, target => {
    const cur = target.players[target.currentSpeaker];
    cur.hasSpoken = true;
    appendEntries(target, [{ type: 'speech', pos: cur.position, round: target.round, text: content }]);
    advanceSpeaker(target);
  });
  void runSpeakStep(session).catch(() => { /* 失败已入错误通道，UI 重试 */ });
}

/** UI 重试条：重跑狼人杀当前步骤。 */
export function retryWerewolfStep(session: number): void {
  if (hasGameGeneration()) return; // 在途防双发：投票等并发波未跑完时重试会对同批座位再发一波（限流元凶）
  setLastError(''); // 即时清错误条并重绘（裸赋值不触发渲染）
  const ww = currentWerewolf();
  if (!ww || ww.session !== session) return;
  if (ww.phase === 'seer') void runNightSeer(session);
  else if (ww.phase === 'wolf') void runNightWolf(session);
  else if (ww.phase === 'witch') void runNightWitch(session);
  else if (ww.phase === 'speak') void runWerewolfSpeakStep(session);
  else if (ww.phase === 'vote' || ww.phase === 'pk-vote') void runWerewolfAiVotes(session);
  else if (ww.phase === 'pk-speak') void runWerewolfPkStep(session);
  else notifyChanged();
}

/** UI 重试条：重跑当前步骤（发言等待/投票 AI）。 */
export function retryCurrentStep(session: number): void {
  if (hasGameGeneration()) return; // 在途防双发：同 retryWerewolfStep
  setLastError('');
  const uc = currentUndercover();
  if (!uc || uc.session !== session) return;
  if (uc.phase === 'speak') void runSpeakStep(session).catch(() => { /* 失败已入错误通道 */ });
  else if (uc.phase === 'vote') void runUndercoverAiVotes(session).catch(() => { /* 同上 */ });
  else notifyChanged();
}

// ─── 续玩点火（docs/16 §2.9）：对局链是纯内存异步链，页面刷新/脚本更新即断链 ───
// 「续玩」时按 phase 重启当前步。守卫 hasGameGeneration()：链条在途时不点火，
// 防双链并行导致重复请求与重复落库；等待玩家输入的步骤重入只会 notifyChanged，安全。

/** 续玩点火（谁是卧底）：words=补主持人分词 / speak / vote。 */
export function resumeUndercoverChain(session: number): void {
  const uc = currentUndercover();
  if (!uc || uc.session !== session || hasGameGeneration()) return;
  _session = Math.max(_session, session); // 会话采纳：页面刷新后 _session 归零，不采纳则一切提交守卫静默失效
  if (uc.phase === 'words') void runHostWordAssignment(session);
  else if (uc.phase === 'speak') void runSpeakStep(session).catch(() => { /* 失败已入错误通道 */ });
  else if (uc.phase === 'vote') void runUndercoverAiVotes(session).catch(() => { /* 同上 */ });
  else notifyChanged();
}

/** 续玩点火（狼人杀）：夜晚三步/白天发言/投票/PK 按当前 phase 续跑。 */
export function resumeWerewolfChain(session: number): void {
  const ww = currentWerewolf();
  if (!ww || ww.session !== session || hasGameGeneration()) return;
  _session = Math.max(_session, session); // 会话采纳：同上（刷新后守卫恢复）
  if (ww.phase === 'seer') void runNightSeer(session);
  else if (ww.phase === 'wolf') void runNightWolf(session);
  else if (ww.phase === 'witch') void runNightWitch(session);
  else if (ww.phase === 'speak') void runWerewolfSpeakStep(session);
  else if (ww.phase === 'vote' || ww.phase === 'pk-vote') void runWerewolfAiVotes(session);
  else if (ww.phase === 'pk-speak') void runWerewolfPkStep(session);
  else notifyChanged();
}

// ─── 谁是卧底：投票 ───

function startUndercoverVote(session: number): void {
  mutateUndercover(session, target => {
    target.phase = 'vote';
    for (const p of target.players) {
      p.hasSpoken = false;
      p.votedFor = null;
      p.voteDone = false;
    }
    appendEntries(target, [{ type: 'system', text: '📢 全员描述完毕，进入投票放逐环节！点击头像投出你怀疑的卧底（可弃票）。' }]);
  });
  void runUndercoverAiVotes(session).catch(() => { /* 失败已入错误通道，UI 重试 */ });
}

async function runUndercoverAiVotes(session: number): Promise<void> {
  const uc = currentUndercover();
  if (!uc || !isSessionValid(session) || uc.phase !== 'vote') return;
  const aliveTargets = uc.players.filter(p => p.alive).map(p => `${p.position}号位(${p.name})`).join('、');
  // 只请求未完成投票的 AI 座位：终止/失败后重试不重投已完成者（voteDone 语义）
  const pending = uc.players.filter(p => p.alive && !p.isUser && !p.voteDone);
  await Promise.all(pending.map(async seat => {
    const action = buildUndercoverVoteAction({
      round: uc.round,
      word: seat.word,
      history: visibleHistoryLines(uc.entries, uc.players),
      targets: aliveTargets,
    });
    let think = '';
    let situation = '';
    let vote: number | null = null;
    try {
      const raw = await runGameRequest({ system: buildUndercoverSystemPrompt(), user: undercoverRequestUser(uc, seat, action) });
      const parsed = parseTripleForVote(raw);
      think = parsed.think;
      situation = parsed.situation;
      vote = parsed.vote;
    } catch (error) {
      // 失败不入账：座位保持未完成，错误条 + 重试只补投未完成者（旧实现吞错置 null 会被当成未投，投票永久卡死）
      if (isSessionValid(session)) setLastError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!isSessionValid(session)) return;
    // 逐座即时落库：投票进度 x/y 可见，其余请求中断不影响已提交者
    mutateUndercover(session, target => {
      const cur = target.players.find(p => p.position === seat.position);
      if (!cur || !cur.alive || cur.voteDone) return;
      if (situation) cur.situation = situation;
      if (think) appendEntries(target, [{ type: 'think', pos: cur.position, round: target.round, text: think }]);
      if (vote !== null && vote > 0) {
        const t = target.players.find(p => p.position === vote && p.alive);
        cur.votedFor = t ? target.players.indexOf(t) : null;
      } else {
        cur.votedFor = null; // AI 明确弃票（voteDone 已置位，与「未投」区分）
      }
      cur.voteDone = true;
    });
    finishUndercoverVoteIfReady(session);
  }));
}

function parseTripleForVote(raw: string): { think: string; situation: string; vote: number | null } {
  const thinkM = String(raw || '').match(/<think>([\s\S]*?)<\/think>/i);
  const sitM = String(raw || '').match(/<situation>([\s\S]*?)<\/situation>/i);
  const vote = parseVoteAction(String(raw || ''));
  return {
    think: thinkM ? thinkM[1].trim() : '',
    situation: sitM ? sitM[1].trim() : '',
    vote: vote ? vote.target : null,
  };
}

/** 玩家投票（targetPos=0 弃票）。全员投完自动结算。 */
export function submitUndercoverVote(session: number, targetPos: number): void {
  const uc = currentUndercover();
  if (!uc || !isSessionValid(session) || uc.phase !== 'vote') return;
  const me = uc.players.find(p => p.isUser);
  if (!me || !me.alive || me.voteDone) return;
  mutateUndercover(session, target => {
    const self = target.players.find(p => p.isUser);
    if (!self || self.voteDone) return;
    const t = targetPos > 0 ? target.players.find(p => p.position === targetPos && p.alive) : null;
    self.votedFor = t ? target.players.indexOf(t) : null;
    self.voteDone = true;
    appendEntries(target, [{ type: 'vote', pos: self.position, round: target.round, text: `🗳️ 我（${self.position}号位）${t ? `投给了 ${t.name}（${t.position}号位）` : '弃票'}` }]);
  });
  finishUndercoverVoteIfReady(session);
}

function finishUndercoverVoteIfReady(session: number): void {
  const uc = currentUndercover();
  if (!uc || !isSessionValid(session) || uc.phase !== 'vote') return;
  const alive = uc.players.filter(p => p.alive);
  if (alive.some(p => !p.voteDone)) return; // 还有人未投完（voteDone 区分弃票与未投）
  finishUndercoverVote(session);
}

function finishUndercoverVote(session: number): void {
  const uc = currentUndercover();
  if (!uc || !isSessionValid(session)) return;
  const tally = new Map<number, number>();
  const voteLines: string[] = [];
  for (const p of uc.players) {
    if (!p.alive) continue;
    if (p.votedFor !== null) {
      const t = uc.players[p.votedFor];
      if (t) {
        tally.set(t.position, (tally.get(t.position) || 0) + 1);
        voteLines.push(`🗳️ ${p.name}（${p.position}号位）投给了 ${t.name}（${t.position}号位）`);
      }
    } else {
      voteLines.push(`🗳️ ${p.name}（${p.position}号位）弃票`);
    }
  }
  let maxVotes = 0;
  let top: number[] = [];
  for (const [pos, count] of tally) {
    if (count > maxVotes) {
      maxVotes = count;
      top = [pos];
    } else if (count === maxVotes) top.push(pos);
  }
  mutateUndercover(session, target => {
    appendEntries(target, [{ type: 'vote', round: target.round, text: voteLines.join('\n') }]);
    if (maxVotes === 0 || top.length === 0) {
      appendEntries(target, [{ type: 'system', text: '⚖️ 本轮无人得票，无人出局，直接进入下一轮描述！' }]);
      nextUndercoverRound(target);
      return;
    }
    if (top.length > 1) {
      const names = top.map(pos => `${pos}号位 ${target.players.find(p => p.position === pos)?.name || '?'}`).join('、');
      appendEntries(target, [{ type: 'system', text: `⚖️ 平票！（${names} 均为 ${maxVotes} 票），无人出局，直接进入下一轮描述！` }]);
      nextUndercoverRound(target);
      return;
    }
    const out = target.players.find(p => p.position === top[0]);
    if (out) {
      out.alive = false;
      appendEntries(target, [{ type: 'system', text: `💀 ${out.name}（${out.position}号位）以 ${maxVotes} 票最高票出局！【TA 的身份是：${out.isSpy ? '卧底' : '平民'}】` }]);
    }
  });
  const after = currentUndercover();
  if (!after || !isSessionValid(session)) return;
  const spy = after.players.find(p => p.isSpy);
  const aliveCount = after.players.filter(p => p.alive).length;
  if (spy && !spy.alive) {
    endUndercover(session, '平民阵营');
    return;
  }
  if (spy && aliveCount <= 3) {
    endUndercover(session, '卧底阵营');
    return;
  }
  mutateUndercover(session, target => nextUndercoverRound(target));
  void runSpeakStep(session);
}

function nextUndercoverRound(target: ActiveUndercover): void {
  target.round++;
  for (const p of target.players) {
    p.hasSpoken = false;
    p.votedFor = null;
    p.voteDone = false;
  }
  target.phase = 'speak';
  target.currentSpeaker = 0;
  appendEntries(target, [{ type: 'system', text: `📢 —— 第 ${target.round} 轮描述开始 ——` }]);
}

// ─── 终局与赛后管线 ───

function endUndercover(session: number, winnerSide: string): void {
  const uc = currentUndercover();
  if (!uc || !isSessionValid(session)) return;
  const detail = uc.players
    .map(p => `${p.position}号位 ${p.name}${p.isUser ? '（主角）' : ''}：${p.word || '?'}（${p.isSpy ? '卧底' : '平民'}·${p.alive ? '存活' : '出局'}）`)
    .join('；');
  const record: GameRecord = {
    id: makeId('g_'),
    ts: Date.now(),
    storyTime: uc.storyTime || storyTimeNow(),
    gameType: 'undercover',
    players: uc.players.map(p => p.name),
    winnerSide,
    text: '',
    detail,
    entries: [...uc.entries],
    highlight: '',
    afterparty: '',
  };
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    const ucNow = d.games.active.undercover;
    if (ucNow && ucNow.session === session) {
      ucNow.phase = 'end';
      ucNow.winner = winnerSide;
      appendEntries(ucNow, [{ type: 'system', text: `🏆 游戏结束，${winnerSide}获胜！` }]);
      record.entries = [...ucNow.entries];
    }
    d.games.records.undercover = pushGameRecord(d.games.records.undercover, record);
    d.games.active.undercover = null;
  });
  sendUndercoverResultMessages(winnerSide, uc.players);
  notifyChanged();
  // L9 成就：终局落记录（阵营胜=玩家阵营胜；卧底/狼人杀无 endReason 字段，置空串）
  const me = uc.players.find(p => p.isUser);
  emitAch('phone_game_finished', {
    game: 'undercover',
    won: achFlag(!!me && (me.isSpy ? winnerSide === '卧底阵营' : winnerSide === '平民阵营')),
    endReason: '',
    rounds: uc.round,
  });
  void runGameEpilogue('undercover', record.id, session);
}

/** 赛后请求完成后回调（App 层据此 emit data-changed；core 不 import renderers）。
 *  多监听器 + 退订函数，与 onGameStateChanged 同构。 */
const _epilogueListeners = new Set<() => void>();

export function onGameEpilogueChanged(cb: (() => void) | null): () => void {
  if (!cb) {
    _epilogueListeners.clear();
    return () => undefined;
  }
  _epilogueListeners.add(cb);
  return () => { _epilogueListeners.delete(cb); };
}

function notifyEpilogue(): void {
  for (const cb of [..._epilogueListeners]) {
    try { cb(); } catch (_e) { /* ignore */ }
  }
}

function findRecordById(type: GameType, id: string): GameRecord | null {
  return readGames().records[type].find(r => r.id === id) || null;
}

/** 赛后 A：总结入池 + 朋友圈落库；赛后 B：高光+复盘。两条独立容错。 */
async function runGameEpilogue(gameType: GameType, recordId: string, session: number): Promise<void> {
  await runEpilogueSummary(gameType, recordId);
  await runEpilogueHighlight(gameType, recordId);
  if (!isSessionValid(session)) return;
  notifyEpilogue();
}

async function runEpilogueSummary(gameType: GameType, recordId: string): Promise<void> {
  const record = findRecordById(gameType, recordId);
  if (!record) return;
  try {
    const roster = getRoster();
    const known = knownParticipantNames();
    // NPC 零残留（docs/16 §10）：朋友圈发帖人/评论人池只取真实好友——NPC 不发帖、不评论、不落任何非对局内容
    const aiPlayers = record.players.filter(n => n !== roster.protagonistName && known.has(n));
    const profiles = record.players.map(name => {
      const c = roster.contacts.find(x => x.name === name);
      const npc = !c && !known.has(name) ? npcPersona(name) : null;
      const bits = [roster.personality[name]?.split('；')[0], c?.languageStyle || npc?.languageStyle, c?.attitude || npc?.attitude].filter(Boolean).map(s => String(s).slice(0, 60));
      return `- ${name}${bits.length ? `：${bits.join('；')}` : ''}`;
    }).join('\n');
    const process = record.entries
      .filter(e => e.type === 'system' || e.type === 'speech' || e.type === 'vote'
        || e.type === 'answer' || e.type === 'guess' || e.type === 'verdict')
      .slice(-40)
      .map(e => {
        if (e.type === 'answer') {
          const split = e.text.indexOf('|');
          const tag = split > 0 ? e.text.slice(0, split) : e.text;
          const voice = split > 0 ? e.text.slice(split + 1) : '';
          return `→ ${tag}${voice ? `（${voice}）` : ''}`;
        }
        if (e.type === 'verdict') return e.text.replace(/^(hit|miss)\|/, '');
        return e.text;
      })
      .join('\n');
    const req = buildEpilogueRequest({
      gameTypeLabel: gameTypeName(gameType),
      winnerSide: record.winnerSide,
      players: record.players,
      detail: record.detail,
      process,
      pastSummaries: summaryPromptLines(summariesForPlayers(readGames().summaries[gameType], record.players, 3)).join('\n'),
      profiles,
      aiPlayers,
    });
    const raw = await runGameRequest({ system: req.system, user: req.user });
    const parsed = parseGameEpilogue(raw);
    if (!parsed) return;
    mutatePhoneData(d => {
      if (!d.games) d.games = emptyPhoneGames();
      const rec = d.games.records[gameType].find(r => r.id === recordId);
      if (!rec) return;
      rec.text = parsed.summary;
      // 总结池 players 只存真实好友：聊天关键词注入按名单匹配，NPC 名不入匹配域（零残留）
      d.games.summaries[gameType] = pushGameSummary(d.games.summaries[gameType], {
        id: rec.id,
        ts: rec.ts,
        storyTime: rec.storyTime,
        gameType,
        players: rec.players.filter(n => isKnownParticipant(n)),
        winnerSide: rec.winnerSide,
        text: parsed.summary,
      } satisfies GameSummary);
      // 朋友圈落库（作者必须为本局 AI 参与者；评论过滤非法名）
      if (parsed.moment && aiPlayers.includes(parsed.moment.author)) {
        const settings = getPhoneSettings();
        const post = normalizeMomentPost({
          id: makeSocialPostId(),
          author: parsed.moment.author,
          text: parsed.moment.text,
          image: 'none',
          likes: [],
          comments: parsed.moment.comments
            .filter(c => aiPlayers.includes(c.name) && c.name !== parsed.moment!.author)
            .map(c => ({ name: c.name, text: c.text })),
          time: '刚刚',
          createdAt: Date.now(),
          storyTime: rec.storyTime || storyTimeNow(),
        });
        if (post) {
          const social = readSocialOf(d);
          social.moments = mergeMomentPosts(social.moments, [post as MomentPost], settings.socialMaxPosts);
          rec.momentPostId = post.id;
        }
      }
    });
    notifyEpilogue();
  } catch (_e) { /* 总结失败：summary 留空，记录页可回看全过程 */ }
}

async function runEpilogueHighlight(gameType: GameType, recordId: string): Promise<boolean> {
  const record = findRecordById(gameType, recordId);
  if (!record) return false;
  try {
    const roster = getRoster();
    // 海龟汤 players[0]=主持人（参与者 pos=数组下标）；answer/verdict 条目文本带 `tag|` 结构前缀
    const soup = gameType === 'turtlesoup';
    const soupEntryText = (e: GameReplayEntry): string => {
      if (e.type === 'answer') {
        const split = e.text.indexOf('|');
        const tag = split > 0 ? e.text.slice(0, split) : e.text;
        const voice = split > 0 ? e.text.slice(split + 1) : '';
        return `${tag}${voice ? `（${voice}）` : ''}`;
      }
      if (e.type === 'verdict') return e.text.replace(/^(hit|miss)\|/, '');
      return e.text;
    };
    const fullLog = record.entries
      .map(e => {
        const who = e.pos !== undefined
          ? record.players[soup ? e.pos : e.pos - 1] || ''
          : (soup ? record.players[0] || '' : '');
        const prefix = e.type === 'system' || e.type === 'vote' ? '' : `${e.pos !== undefined ? `${e.pos}号位 ` : ''}${who} [${e.type === 'answer' ? '主持回答' : e.type === 'verdict' ? '判定' : e.type}]：`;
        return `${prefix}${soup ? soupEntryText(e) : e.text}`;
      })
      .join('\n');
    const known = knownParticipantNames();
    const dossiers = record.players.map(name => {
      const c = roster.contacts.find(x => x.name === name);
      const npc = !c && !known.has(name) ? npcPersona(name) : null;
      const shift = roster.personality[name];
      const lines = [
        npc
          ? `- ${name}：身份${npc.identity}；性格${npc.personality}；口癖${npc.languageStyle}；对主角态度${npc.attitude}（临时拼桌的陌生玩家）`
          : `- ${name}：身份${c?.identity || '未记录'}；性格${c?.brief || '未记录'}；口癖${c?.languageStyle || '未记录'}；对主角态度${c?.attitude || '未记录'}`,
      ];
      if (shift) lines.push(`　性格偏移：${shift.slice(0, 300)}`);
      return lines.join('\n');
    }).join('\n');
    const relations = roster.relations
      .filter(r => record.players.includes(r.a) && record.players.includes(r.b))
      .map(r => `${r.a} ↔ ${r.b}：${r.type || '关系'}${r.state ? `（${r.state}）` : ''}`)
      .join('\n');
    const req = buildHighlightRequest({
      gameType,
      gameTypeLabel: gameTypeName(gameType),
      winnerSide: record.winnerSide,
      players: record.players,
      detail: record.detail,
      fullLog,
      dossiers,
      relations,
    });
    const raw = await runGameRequest({ system: req.system, user: req.user });
    const parsed = parseGameHighlight(raw);
    if (!parsed.highlight && !parsed.afterparty) return false;
    mutatePhoneData(d => {
      const rec = d.games?.records[gameType].find(r => r.id === recordId);
      if (!rec) return;
      if (parsed.highlight) rec.highlight = parsed.highlight;
      if (parsed.afterparty) rec.afterparty = parsed.afterparty;
    });
    notifyEpilogue();
    return true;
  } catch (_e) { /* 高光失败：留空，记录页可重试 */ return false; }
}

/** 记录页「重新生成」高光+复盘。 */
export async function regenerateGameEpilogue(type: GameType, recordId: string): Promise<void> {
  const ok = await runEpilogueHighlight(type, recordId);
  notifyEpilogue();
  // L9 成就：玩家亲手重新生成高光与复盘成功（终局自动生成走 runGameEpilogue，不经过本函数）
  if (ok) emitAch('phone_game_epilogue_regen', {});
}

// ─── 赛后私聊系统消息（终局同步落库；不计未读——用户定案：游戏结果不触发小手机未读角标） ───

function sendUndercoverResultMessages(winnerSide: string, detailSeats: UndercoverSeat[]): void {
  const spy = detailSeats.find(p => p.isSpy);
  if (!spy) return;
  const revealLines = detailSeats
    .map(p => `${p.position}号位 ${p.name}（${p.word || '?'} · ${p.isSpy ? '卧底' : '平民'} · ${p.alive ? '存活' : '出局'}）`)
    .join('\n');
  const known = knownParticipantNames();
  mutatePhoneData(d => {
    for (const seat of detailSeats) {
      if (seat.isUser || !known.has(seat.name)) continue; // NPC 不发私聊（不凭空建会话）
      const conv = ensurePrivateConversation(d, seat.name);
      const message: PhoneMessage = {
        id: makeMessageId(),
        from: 'system',
        type: 'text',
        content: `🎲 谁是卧底 · 对局结束\n获胜方：${winnerSide}\n卧底是：${spy.name}（${spy.alive ? '存活到终局' : '被投票放逐'}）\n你的词语：${seat.word || '?'}（${seat.isSpy ? '卧底' : '平民'}）\n全场词语：\n${revealLines}`,
        ts: Date.now(),
        storyTime: storyTimeNow(),
      };
      appendMessage(conv, message);
    }
  });
}

// ─── 狼人杀状态机（docs/16 §3；夜晚三步→白天→PK→终局） ───

const WEREWOLF_ROLES: readonly WerewolfRole[] = ['狼人', '狼人', '村民', '村民', '预言家', '女巫'];

function currentWerewolf(): ActiveWerewolf | null {
  return readGames().active.werewolf || null;
}

function mutateWerewolf(session: number, mutator: (ww: ActiveWerewolf) => void): void {
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    const ww = d.games.active.werewolf;
    if (ww && ww.session === session) mutator(ww);
  });
  notifyChanged();
}

/** 狼人杀视角历史（狼人可读狼队密谋）。 */
function wolfHistoryLines(ww: ActiveWerewolf, seat: WerewolfSeat): string {
  return visibleHistoryLines(ww.entries, ww.players, { isWolf: seat.role === '狼人' });
}

function seerCheckedLines(ww: ActiveWerewolf): string[] {
  return Object.keys(ww.seerChecked).map(posStr => {
    const pos = parseInt(posStr, 10);
    const target = ww.players.find(p => p.position === pos);
    if (!target) return '';
    const isWolf = target.role === '狼人';
    return `- 已验 ${pos}号位 ${target.name}${target.isUser ? '（主角本人）' : ''}：${isWolf ? '狼人（查杀）' : '好人（金水）'}`;
  }).filter(Boolean);
}

function aliveOthersStr(ww: ActiveWerewolf, selfPos: number): string {
  return ww.players.filter(p => p.alive && p.position !== selfPos).map(p => `${p.position}号位(${p.name})`).join('、');
}

function werewolfRequestUser(ww: ActiveWerewolf, seat: WerewolfSeat, actionPrompt: string): string {
  const roster = getRoster();
  const me = ww.players.find(p => p.isUser);
  const npc = npcFlags(ww.players);
  const user = buildGameUserContext({
    rules: WEREWOLF_RULES,
    summaries: summaryPromptLines(summariesForPlayers(readGames().summaries.werewolf, ww.players.map(p => p.name), 3)).join('\n'),
    seats: buildSeatLines(ww.players.map((p, i) => ({ position: p.position, name: p.name, isUser: p.isUser, alive: p.alive, npc: npc[i] })), seat.position),
    profiles: buildPublicProfiles(roster, ww.players.map((p, i) => ({ position: p.position, name: p.name, npc: npc[i] }))),
    socialHints: buildSocialHints(ww.players.map(p => p.name)),
    self: buildSelfProfile(seat.name, seat.position),
    userName: me?.name || meName(),
    userPosition: me?.position || 1,
    history: wolfHistoryLines(ww, seat),
    lastSituation: seat.situation,
  });
  return `${user}\n\n${actionPrompt}`;
}

export async function startWerewolf(inviteeNames: readonly string[]): Promise<void> {
  assertNoRunningGame();
  const roster = getRoster();
  const me = roster.protagonistName;
  const invitees = inviteeNames.map(n => n.trim()).filter(Boolean).slice(0, 5);
  if (invitees.length !== 5) throw new PhoneGameError('state', '需要邀请 5 位好友');
  const names = shuffle([me, ...invitees]);
  const roles = shuffle([...WEREWOLF_ROLES]);
  const seats: WerewolfSeat[] = names.map((name, idx) => ({
    position: idx + 1,
    name,
    isUser: name === me,
    role: roles[idx] || '村民',
    alive: true,
    hasSpoken: false,
    votedFor: null,
    voteDone: false,
    situation: '',
  }));
  const session = ++_session;
  const ww: ActiveWerewolf = {
    gameType: 'werewolf',
    session,
    phase: 'seer',
    day: 1,
    currentSpeaker: 0,
    players: seats,
    nightKillPos: null,
    nightDeaths: [],
    seerChecked: {},
    witchUsedAntidote: false,
    witchUsedPoison: false,
    witchSavedPos: null,
    wolfTactics: null,
    userTactics: null,
    userKillDone: false,
    pkCandidates: [],
    winner: '',
    entries: [{ type: 'system', text: '🐺 狼人杀开始！6 人局：2 狼人 · 2 村民 · 1 预言家 · 1 女巫，身份已随机分配。' }],
    startedAt: Date.now(),
    storyTime: storyTimeNow(),
  };
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    d.games.active.werewolf = ww;
  });
  notifyChanged();
  await runNightSeer(session);
}

// ─── 夜晚第 1 步：预言家查验 ───

async function runNightSeer(session: number): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'seer') return;
  const seer = ww.players.find(p => p.role === '预言家' && p.alive);
  if (!seer) {
    mutateWerewolf(session, target => {
      appendEntries(target, [{ type: 'system', text: '🔮 预言家已出局，今晚无人查验。' }]);
      target.phase = 'wolf';
    });
    void runNightWolf(session);
    return;
  }
  if (seer.isUser) {
    _lastError = '';
    notifyChanged(); // 等待玩家点选验人
    return;
  }
  const action = buildWerewolfSeerAction({
    day: ww.day,
    position: seer.position,
    name: seer.name,
    checkedLines: seerCheckedLines(ww),
    aliveOthers: aliveOthersStr(ww, seer.position),
  });
  try {
    const raw = await runGameRequest({ system: buildWerewolfSystemPrompt(), user: werewolfRequestUser(ww, seer, action) });
    if (!isSessionValid(session)) return;
    const parsed = parseTriple(raw);
    const m = parsed.rest.match(/SEER_CHECK\s*[：:]\s*[\[【（(]?\s*([1-9一二三四五六七八十])\s*[\]】）)]?/i);
    let targetPos = m ? parseSeatToken(m[1]) : 0;
    if (!targetPos || targetPos === seer.position || ww.seerChecked[String(targetPos)]) {
      const pool = ww.players.filter(p => p.alive && p.position !== seer.position && !ww.seerChecked[String(p.position)]);
      targetPos = (pool[0] || ww.players.find(p => p.alive && p.position !== seer.position))?.position || 0;
    }
    commitSeerCheck(session, targetPos);
  } catch (error) {
    if (!isSessionValid(session)) return;
    setLastError(error instanceof Error ? error.message : String(error));
  }
}

function commitSeerCheck(session: number, targetPos: number): void {
  mutateWerewolf(session, target => {
    if (targetPos > 0) target.seerChecked[String(targetPos)] = true;
    target.phase = 'wolf';
  });
  void runNightWolf(session);
}

/** 玩家预言家点选验人。 */
export function submitWerewolfSeerCheck(session: number, targetPos: number): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'seer') return;
  const me = ww.players.find(p => p.isUser);
  if (!me || me.role !== '预言家' || !me.alive) return;
  if (targetPos === me.position || ww.seerChecked[String(targetPos)]) return;
  _lastError = '';
  commitSeerCheck(session, targetPos);
}

// ─── 夜晚第 2 步：狼队密谋与刀口 ───

async function runNightWolf(session: number): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'wolf') return;
  const wolves = ww.players.filter(p => p.role === '狼人' && p.alive);
  if (!wolves.length) {
    mutateWerewolf(session, target => {
      target.nightKillPos = null;
      target.phase = 'witch';
    });
    void runNightWitch(session);
    return;
  }
  const userWolf = wolves.find(p => p.isUser);
  if (userWolf) {
    // 玩家当狼：AI 队友先密谋（或孤狼直接战术板），刀口与战术由玩家点选
    // 续玩重入守卫：密谋落库时 userTactics 已初始化（同一 mutate 原子写），非空=已在等待玩家输入
    if (ww.userTactics) {
      _lastError = '';
      notifyChanged();
      return;
    }
    const mate = wolves.find(p => !p.isUser);
    if (!mate) {
      mutateWerewolf(session, target => {
        appendEntries(target, [{ type: 'private', pos: userWolf.position, text: '🐺 你是场上唯一存活的狼人，请规划战术并选择击杀目标。' }]);
        target.userTactics = target.userTactics || { ai: '', user: '', custom: '' };
      });
      return; // 等待玩家战术板+刀口
    }
    const firstNight = ww.day === 1 && !ww.wolfTactics && !ww.userTactics;
    const action = buildWerewolfMateAction({
      day: ww.day,
      matePosition: mate.position,
      mateName: mate.name,
      userPosition: userWolf.position,
      firstNight,
    });
    try {
      const raw = await runGameRequest({ system: buildWerewolfSystemPrompt(), user: werewolfRequestUser(ww, mate, action) });
      if (!isSessionValid(session)) return;
      const parsed = parseTriple(raw);
      const mPriv = parsed.rest.match(/<private>([\s\S]*?)<\/private>/i);
      const priv = mPriv ? mPriv[1].trim() : `${mate.name}：今晚怎么打，你来定。`;
      mutateWerewolf(session, target => {
        const cur = target.players.find(p => p.position === mate.position);
        if (parsed.situation && cur) cur.situation = parsed.situation;
        appendEntries(target, [
          ...(parsed.think ? [{ type: 'think' as const, pos: mate.position, text: parsed.think }] : []),
          ...(parsed.situation ? [{ type: 'situation' as const, pos: mate.position, text: parsed.situation }] : []),
          { type: 'private' as const, pos: mate.position, text: priv },
        ]);
        target.userTactics = target.userTactics || { ai: '', user: '', custom: '' };
      });
      return; // 等待玩家战术板+刀口
    } catch (error) {
      if (!isSessionValid(session)) return;
      setLastError(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  // 纯 AI 狼队
  const firstNight = ww.day === 1;
  const leadWolf = wolves[0];
  const action = buildWerewolfWolfAction({
    day: ww.day,
    wolves: wolves.map(w => `${w.position}号位 ${w.name}`).join('、'),
    firstNight,
  });
  try {
    const raw = await runGameRequest({ system: buildWerewolfSystemPrompt(), user: werewolfRequestUser(ww, leadWolf, action) });
    if (!isSessionValid(session)) return;
    const parsed = parseTriple(raw);
    const mPriv = parsed.rest.match(/<private>([\s\S]*?)<\/private>/i);
    const priv = mPriv ? mPriv[1].trim() : `🐺 [第${ww.day}夜 狼队密谋] 已达成刀人共识。`;
    const mKill = parsed.rest.match(/WOLF_KILL\s*[：:]\s*[\[【（(]?\s*([0-9一二三四五六七八十]+)\s*[\]】）)]?/i);
    let killPos = mKill ? parseSeatToken(mKill[1]) : 0;
    const wolfPosSet = new Set(wolves.map(w => w.position));
    // 自刀/刀队友=狼队战术放行（骗女巫解药）；仅目标无效（0/已死）才兜底，兜底池仍排除狼位防解析失败误刀
    if (!killPos || !ww.players.some(p => p.position === killPos && p.alive)) {
      const pool = ww.players.filter(p => p.alive && !wolfPosSet.has(p.position));
      killPos = (pool[0] || ww.players.find(p => p.alive))?.position || 0;
    }
    mutateWerewolf(session, target => {
      const lead = target.players.find(p => p.position === leadWolf.position);
      if (parsed.situation && lead) lead.situation = parsed.situation;
      appendEntries(target, [
        ...(parsed.think ? [{ type: 'think' as const, pos: leadWolf.position, text: parsed.think }] : []),
        ...(parsed.situation ? [{ type: 'situation' as const, pos: leadWolf.position, text: parsed.situation }] : []),
        { type: 'private' as const, pos: leadWolf.position, text: priv },
      ]);
      if (firstNight) {
        const mLeap = parsed.rest.match(/TACTIC_LEAP\s*[：:]\s*[\[【（(]?\s*([0-9一二三四五六七八十]+)/i);
        const mCharge = parsed.rest.match(/TACTIC_CHARGE\s*[：:]\s*[\[【（(]?\s*([0-9一二三四五六七八十]+)/i);
        const mHook = parsed.rest.match(/TACTIC_HOOK\s*[：:]\s*[\[【（(]?\s*([0-9一二三四五六七八十]+)/i);
        target.wolfTactics = {
          leap: mLeap ? parseSeatToken(mLeap[1]) : 0,
          charge: mCharge ? parseSeatToken(mCharge[1]) : 0,
          hook: mHook ? parseSeatToken(mHook[1]) : 0,
        };
      }
      target.nightKillPos = killPos > 0 ? killPos : null;
      target.phase = 'witch';
    });
    void runNightWitch(session);
  } catch (error) {
    if (!isSessionValid(session)) return;
    setLastError(error instanceof Error ? error.message : String(error));
  }
}

/** 玩家狼：确认战术板（AI 战术与我的战术互斥单选+补充指令）。 */
export function submitWerewolfUserTactics(session: number, ai: string, user: string, custom: string): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'wolf') return;
  const me = ww.players.find(p => p.isUser);
  if (!me || me.role !== '狼人' || !me.alive) return;
  _lastError = '';
  mutateWerewolf(session, target => {
    target.userTactics = { ai, user, custom: custom.slice(0, 200) };
  });
}

/** 玩家狼：确认刀口（进女巫步）。 */
export function submitWerewolfUserKill(session: number, targetPos: number): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'wolf') return;
  const me = ww.players.find(p => p.isUser);
  if (!me || me.role !== '狼人' || !me.alive || ww.userKillDone) return;
  const target = ww.players.find(p => p.position === targetPos && p.alive);
  if (!target || (target.role === '狼人' && targetPos !== me.position)) return; // 目标须存活；狼位仅可自刀（自刀骗药），队友仍禁刀
  mutateWerewolf(session, target => {
    target.nightKillPos = targetPos > 0 ? targetPos : null;
    target.userKillDone = true;
    target.phase = 'witch';
  });
  void runNightWitch(session);
}

// ─── 夜晚第 3 步：女巫用药 ───

async function runNightWitch(session: number): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'witch') return;
  const witch = ww.players.find(p => p.role === '女巫' && p.alive);
  if (!witch) {
    mutateWerewolf(session, target => {
      appendEntries(target, [{ type: 'system', text: '🧪 女巫已出局，今晚无人用药。' }]);
    });
    void finishNight(session);
    return;
  }
  if (witch.isUser) {
    _lastError = '';
    notifyChanged(); // 等待玩家药瓶操作
    return;
  }
  const hasAntidote = !ww.witchUsedAntidote;
  const hasPoison = !ww.witchUsedPoison;
  const victimPos = ww.nightKillPos;
  const victim = victimPos ? ww.players.find(p => p.position === victimPos) : null;
  const victimInfo = hasAntidote
    ? (victim ? `${victim.position}号位 ${victim.name}` : '无人中刀')
    : '解药已用，你失去了刀口视野';
  const specialNotes: string[] = [];
  if (victim && victim.isUser && hasAntidote) {
    specialNotes.push('今晚中刀的是主角本人！你对主角有真挚的感情，请让你的用药决断带上这份情感——救或不救由你决定，但必须符合你对TA的真实感情。');
  }
  if (ww.day === 1 && victim && victim.position === witch.position && hasPoison) {
    specialNotes.push('你自己首夜中刀且不可自救！请从存活玩家中盲毒带走你认为最有嫌疑的一人。');
  }
  const action = buildWerewolfWitchAction({
    day: ww.day,
    position: witch.position,
    name: witch.name,
    hasAntidote,
    hasPoison,
    victimInfo,
    specialNotes: specialNotes.join('\n'),
  });
  try {
    const raw = await runGameRequest({ system: buildWerewolfSystemPrompt(), user: werewolfRequestUser(ww, witch, action) });
    if (!isSessionValid(session)) return;
    const parsed = parseTriple(raw);
    const mSave = parsed.rest.match(/WITCH_SAVE\s*[：:]\s*[\[【（(]?\s*(YES|NO|是|否|救|不救)\s*[\]】）)]?/i);
    const save = Boolean(mSave && (mSave[1].toUpperCase() === 'YES' || mSave[1] === '是' || mSave[1] === '救'));
    const mPoison = parsed.rest.match(/WITCH_POISON\s*[：:]\s*[\[【（(]?\s*([0-9一二三四五六七八十]+)\s*[\]】）)]?/i);
    let poisonPos = mPoison ? parseSeatToken(mPoison[1]) : 0;
    // 首夜自刀盲毒兜底：AI 未填毒时大概率随机带走
    if (ww.day === 1 && victim && victim.position === witch.position && hasPoison && poisonPos === 0 && Math.random() < 0.9) {
      const pool = ww.players.filter(p => p.alive && p.position !== witch.position);
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      if (chosen) poisonPos = chosen.position;
    }
    commitWitchAction(session, { think: parsed.think, situation: parsed.situation, save, poisonPos });
  } catch (error) {
    if (!isSessionValid(session)) return;
    setLastError(error instanceof Error ? error.message : String(error));
  }
}

function commitWitchAction(session: number, args: { think: string; situation: string; save: boolean; poisonPos: number }): void {
  mutateWerewolf(session, target => {
    const witch = target.players.find(p => p.role === '女巫' && p.alive);
    if (!witch) return;
    if (args.situation) witch.situation = args.situation;
    appendEntries(target, [
      ...(args.think ? [{ type: 'think' as const, pos: witch.position, text: args.think }] : []),
      ...(args.situation ? [{ type: 'situation' as const, pos: witch.position, text: args.situation }] : []),
    ]);
    const hasAntidote = !target.witchUsedAntidote;
    const hasPoison = !target.witchUsedPoison;
    const victimPos = target.nightKillPos;
    const victim = victimPos ? target.players.find(p => p.position === victimPos && p.alive) : null;
    // 同夜双药互斥（代码层加固）：优先解药；毒不自毒
    if (args.save && hasAntidote && victim && !(target.day === 1 && victim.position === witch.position)) {
      target.witchUsedAntidote = true;
      target.witchSavedPos = victim.position;
      target.nightKillPos = null; // 救成功=平安夜
    } else if (args.poisonPos > 0 && hasPoison && args.poisonPos !== witch.position) {
      const poisonTarget = target.players.find(p => p.position === args.poisonPos && p.alive);
      if (poisonTarget) {
        target.witchUsedPoison = true;
        target.nightDeaths.push({ pos: poisonTarget.position, cause: '毒杀' });
        poisonTarget.alive = false;
      }
    }
  });
  void finishNight(session);
}

/** 玩家女巫：药瓶操作（save=用解药；poisonPos=毒杀号位 0=不用）。 */
export function submitWerewolfWitch(session: number, save: boolean, poisonPos: number): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'witch') return;
  const me = ww.players.find(p => p.isUser);
  if (!me || me.role !== '女巫' || !me.alive) return;
  _lastError = '';
  commitWitchAction(session, { think: '', situation: '', save, poisonPos });
}

// ─── 天亮：结算死亡 + 公告 + 首夜遗言 ───

interface LastWordsJob {
  pos: number;
  cause: '狼杀' | '毒杀' | '放逐';
}

async function finishNight(session: number): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session)) return;
  const killPos = ww.nightKillPos;
  const deathList: LastWordsJob[] = ww.nightDeaths.map(d => ({ pos: d.pos, cause: d.cause }));
  mutateWerewolf(session, target => {
    // 狼刀结算必须在 mutate 内落库——currentWerewolf() 是归一化副本，副本上置 alive=false
    // 不会持久化：公告死了、座位还活着 → 死人继续发言/投票，胜负判定人数也错（V1.016 实锤）
    if (killPos) {
      const victim = target.players.find(p => p.position === killPos && p.alive);
      if (victim) {
        victim.alive = false;
        deathList.push({ pos: killPos, cause: '狼杀' });
      }
    }
    target.nightDeaths = deathList.map(d => ({ pos: d.pos, cause: d.cause === '毒杀' ? '毒杀' as const : '狼杀' as const }));
    // 死因（狼杀/毒杀）不进天亮公告——毒杀保密是女巫玩法根基；cause 仅存 nightDeaths 供终局复盘
    const deathText = deathList.length
      ? deathList.map(d => `${d.pos}号位 ${target.players.find(p => p.position === d.pos)?.name || '?'}`).join('、')
      : '';
    appendEntries(target, [{
      type: 'system',
      text: deathList.length
        ? `☀️ 天亮了。昨夜，${deathText} 死亡出局`
        : '☀️ 天亮了。昨夜是平安夜，无人死亡。',
    }]);
    target.phase = 'speak';
    target.currentSpeaker = 0;
  });
  const after = currentWerewolf();
  if (!after || !isSessionValid(session)) return;
  if (checkWerewolfWin(after)) {
    endWerewolf(session);
    return;
  }
  // 首夜死者遗言（仅第一夜；多死者逐个）
  if (after.day === 1 && deathList.length) {
    for (const death of deathList) {
      await runLastWords(session, death);
      if (!isSessionValid(session)) return;
    }
  }
  beginDaySpeak(session);
}

function beginDaySpeak(session: number): void {
  mutateWerewolf(session, target => {
    for (const p of target.players) {
      p.hasSpoken = false;
      p.votedFor = null;
    }
    target.currentSpeaker = 0;
    const first = target.players.find(p => p.alive);
    if (first) appendEntries(target, [{ type: 'system', text: `💬 从 ${first.position}号位 ${first.name} 开始发言` }]);
  });
  void runWerewolfSpeakStep(session);
}

let _pendingLastWords: { session: number; pos: number; cause: string } | null = null;

/** 遗言（AI 请求；玩家等待输入）。 */
async function runLastWords(session: number, death: LastWordsJob): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session)) return;
  const seat = ww.players.find(p => p.position === death.pos);
  if (!seat) return;
  if (seat.isUser) {
    _pendingLastWords = { session, pos: seat.position, cause: death.cause };
    notifyChanged(); // 玩家遗言输入框
    return;
  }
  const action = buildWerewolfLastWordsAction({
    position: seat.position,
    name: seat.name,
    role: seat.role,
    // 夜间死亡不告知死因（与天亮公告同口径，防毒杀从遗言漏出）；放逐本就是公开信息
    deathCause: death.cause === '放逐' ? '被投票放逐' : '',
    voiceEmotion: voicePromptOn(seat.name),
  });
  try {
    const raw = await runGameRequest({ system: buildWerewolfSystemPrompt(), user: werewolfRequestUser(ww, seat, action) });
    if (!isSessionValid(session)) return;
    const parsed = parseSpeechReply(raw, '没想到这一轮我被淘汰了，剩下的朋友们加油继续推理吧！', '，剩下的大家加油继续推理吧！');
    mutateWerewolf(session, target => {
      const cur = target.players.find(p => p.position === seat.position);
      if (parsed.situation && cur) cur.situation = parsed.situation;
      appendEntries(target, [
        ...(parsed.think ? [{ type: 'think' as const, pos: seat.position, text: parsed.think }] : []),
        ...(parsed.situation ? [{ type: 'situation' as const, pos: seat.position, text: parsed.situation }] : []),
        { type: 'speech' as const, pos: seat.position, text: `遗言：${parsed.speech}`, ...voiceFields(seat.name, parsed) },
      ]);
    });
  } catch (error) {
    if (!isSessionValid(session)) return;
    setLastError(error instanceof Error ? error.message : String(error));
  }
}

/** 玩家遗言待提交状态（UI 渲染遗言输入框用）。 */
export function pendingLastWordsInfo(): { session: number; pos: number; cause: string } | null {
  return _pendingLastWords;
}

/** 玩家遗言提交（继续日间流程）。 */
export function submitWerewolfLastWords(session: number, text: string, opts?: { exileDone?: boolean }): void {
  const pending = _pendingLastWords;
  if (!pending || pending.session !== session) return;
  const content = (text || '').trim() || '这局就到这里了，剩下的朋友们加油。';
  mutateWerewolf(session, target => {
    appendEntries(target, [{ type: 'speech', pos: pending.pos, text: `遗言：${content}` }]);
  });
  _pendingLastWords = null;
  if (opts?.exileDone) {
    void finishWerewolfDay(session);
  } else {
    beginDaySpeak(session);
  }
}

// ─── 白天发言 ───

function werewolfRoleTactics(ww: ActiveWerewolf, seat: WerewolfSeat): string {
  if (seat.role === '狼人') {
    const ut = ww.userTactics;
    if (ut && (ut.ai || ut.user)) {
      const role = seat.isUser ? ut.user : ut.ai;
      if (role) {
        const custom = ut.custom ? `；用户补充指示：${ut.custom}` : '';
        return buildWerewolfRoleTactics({ role: '狼人', wolfTactic: `你的战术角色：【${role}】${custom}` });
      }
    }
    if (ww.wolfTactics) {
      const map: Record<number, string> = {
        [ww.wolfTactics.leap]: '悍跳预言家——报出假查验，攻击真预言家，全力骗取信任',
        [ww.wolfTactics.charge]: '冲锋站边——坚定支持悍跳的狼队友，猛烈质疑真预言家',
        [ww.wolfTactics.hook]: '倒钩伪装——表面站边真预言家，通过表水和踩队友做高自身好人面',
      };
      const mine = map[seat.position];
      if (mine) return buildWerewolfRoleTactics({ role: '狼人', wolfTactic: `你的战术角色：【${mine}】` });
    }
    return '';
  }
  if (seat.role === '预言家') return buildWerewolfRoleTactics({ role: '预言家', seerLines: seerCheckedLines(ww) });
  if (seat.role === '女巫') {
    const lines: string[] = [`解药${ww.witchUsedAntidote ? '已用' : '未用'}`, `毒药${ww.witchUsedPoison ? '已用' : '未用'}`];
    if (ww.witchSavedPos) {
      const saved = ww.players.find(p => p.position === ww.witchSavedPos);
      if (saved) lines.push(`昨夜你用解药救下 ${saved.position}号位 ${saved.name}（银水）`);
    }
    return buildWerewolfRoleTactics({ role: '女巫', witchLines: lines });
  }
  return '';
}

async function runWerewolfSpeakStep(session: number): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'speak') return;
  // 跳过死者/已发言者：跳过结果必须经 mutate 落库——currentWerewolf() 返回归一化副本，
  // 在副本上推进 currentSpeaker 会让提交守卫（按 currentSpeaker 取座位）错位 → 同一步骤无限重复请求
  // （实例：1号位首夜出局后，白天发言永久卡在 2号位反复请求）。
  let idx = ww.currentSpeaker;
  while (idx < ww.players.length && (!ww.players[idx].alive || ww.players[idx].hasSpoken)) idx++;
  if (idx >= ww.players.length) {
    startWerewolfVote(session, false);
    return;
  }
  if (idx !== ww.currentSpeaker) {
    mutateWerewolf(session, target => { target.currentSpeaker = idx; });
    if (!isSessionValid(session)) return;
  }
  const seat = ww.players[idx];
  if (seat.isUser) {
    _lastError = '';
    notifyChanged();
    return;
  }
  const action = buildWerewolfSpeechAction({
    day: ww.day,
    position: seat.position,
    name: seat.name,
    role: seat.role,
    roleTactics: werewolfRoleTactics(ww, seat),
    voiceEmotion: voicePromptOn(seat.name),
  });
  try {
    const raw = await runGameRequest({ system: buildWerewolfSystemPrompt(), user: werewolfRequestUser(ww, seat, action) });
    if (!isSessionValid(session)) return;
    const parsed = parseSpeechReply(raw, '我仔细听了前面的发言，疑点不少，建议后置位多给些信息，我先过了。', '，这就是我目前看出来的疑点，后置位继续听发言。');
    mutateWerewolf(session, target => {
      const cur = target.players.find(p => p.position === seat.position);
      if (!cur) return;
      if (parsed.situation) cur.situation = parsed.situation;
      cur.hasSpoken = true;
      appendEntries(target, [
        ...(parsed.think ? [{ type: 'think' as const, pos: seat.position, text: parsed.think }] : []),
        ...(parsed.situation ? [{ type: 'situation' as const, pos: seat.position, text: parsed.situation }] : []),
        { type: 'speech' as const, pos: seat.position, text: parsed.speech, ...voiceFields(seat.name, parsed) },
      ]);
      advanceWerewolfSpeaker(target);
    });
    void runWerewolfSpeakStep(session);
  } catch (error) {
    if (!isSessionValid(session)) return;
    setLastError(error instanceof Error ? error.message : String(error));
  }
}

function advanceWerewolfSpeaker(ww: ActiveWerewolf): void {
  let next = ww.currentSpeaker + 1;
  while (next < ww.players.length && (!ww.players[next].alive || ww.players[next].hasSpoken)) next++;
  ww.currentSpeaker = next;
}

/** 玩家白天发言。 */
export function submitWerewolfSpeech(session: number, text: string): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'speak') return;
  const seat = ww.players[ww.currentSpeaker];
  if (!seat || !seat.isUser || !seat.alive) return;
  const content = (text || '').trim() || '（这轮我先过，听听大家怎么说。）';
  mutateWerewolf(session, target => {
    const cur = target.players[target.currentSpeaker];
    cur.hasSpoken = true;
    appendEntries(target, [{ type: 'speech', pos: cur.position, text: content }]);
    advanceWerewolfSpeaker(target);
  });
  void runWerewolfSpeakStep(session).catch(() => { /* 失败已入错误通道 */ });
}

// ─── 投票与 PK ───

function startWerewolfVote(session: number, isPk = false): void {
  mutateWerewolf(session, target => {
    target.phase = isPk ? 'pk-vote' : 'vote';
    for (const p of target.players) {
      p.votedFor = null;
      p.voteDone = false;
    }
    if (!isPk) {
      appendEntries(target, [{ type: 'system', text: '📢 发言结束，进入投票环节：点击头像投出放逐对象（可投自己/弃票）。' }]);
    } else {
      const names = target.pkCandidates.map(pos => `${pos}号位 ${target.players.find(p => p.position === pos)?.name || '?'}`).join('、');
      appendEntries(target, [{ type: 'system', text: `⚖️ 平票辩解结束（${names}），平票方失去投票权，其余存活玩家重新投票或弃票。` }]);
    }
  });
  void runWerewolfAiVotes(session).catch(() => { /* 失败已入错误通道 */ });
}

async function runWerewolfAiVotes(session: number): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session)) return;
  const isPk = ww.phase === 'pk-vote';
  if (ww.phase !== 'vote' && ww.phase !== 'pk-vote') return;
  // 零投票人（平票方覆盖全部存活玩家，如三人局三人平票）：没有任何座位会回来触发结算，
  // 必须在此就地收口走流票进夜——否则状态机永久停在 pk-vote（pending 为空 + 玩家是平票方不能投，无路可走）
  const voters = ww.players.filter(p => p.alive && !(isPk && ww.pkCandidates.includes(p.position)));
  if (!voters.length) {
    finishWerewolfVoteIfReady(session);
    return;
  }
  const aliveTargets = ww.players.filter(p => p.alive).map(p => `${p.position}号位(${p.name})`).join('、');
  // 只请求未完成投票的 AI 座位（平票方无投票权）；终止/失败后重试不重投已完成者
  const pending = ww.players.filter(p => {
    if (!p.alive || p.isUser || p.voteDone) return false;
    if (isPk && ww.pkCandidates.includes(p.position)) return false;
    return true;
  });
  await Promise.all(pending.map(async seat => {
    const action = buildWerewolfVoteAction({
      day: ww.day,
      role: seat.role,
      pkRoundNote: isPk ? '当前为平票PK决选轮：平票候选人刚完成辩解，平票方失去投票权，你须根据辩解与全程发言重新决定。' : '',
      targets: aliveTargets,
    });
    let think = '';
    let situation = '';
    let vote: number | null = null;
    try {
      const raw = await runGameRequest({ system: buildWerewolfSystemPrompt(), user: werewolfRequestUser(ww, seat, action) });
      const parsed = parseTripleForVote(raw);
      think = parsed.think;
      situation = parsed.situation;
      vote = parsed.vote;
    } catch (error) {
      // 失败不入账：座位保持未完成，错误条 + 重试只补投未完成者（旧实现吞错置 null 会被当成未投，投票永久卡死）
      if (isSessionValid(session)) setLastError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!isSessionValid(session)) return;
    // 逐座即时落库：投票进度 x/y 可见，其余请求中断不影响已提交者
    mutateWerewolf(session, target => {
      const cur = target.players.find(p => p.position === seat.position);
      if (!cur || !cur.alive || cur.voteDone) return;
      if (situation) cur.situation = situation;
      if (think) appendEntries(target, [{ type: 'think', pos: cur.position, text: think }]);
      if (vote !== null && vote > 0) {
        const t = target.players.find(p => p.position === vote && p.alive);
        cur.votedFor = t ? target.players.indexOf(t) : null;
      } else {
        cur.votedFor = null; // AI 明确弃票（voteDone 已置位，与「未投」区分）
      }
      cur.voteDone = true;
    });
    finishWerewolfVoteIfReady(session);
  }));
}

/** 玩家投票（vote 或 pk-vote 阶段；targetPos=0 弃票）。 */
export function submitWerewolfVote(session: number, targetPos: number): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session)) return;
  if (ww.phase !== 'vote' && ww.phase !== 'pk-vote') return;
  _lastError = '';
  mutateWerewolf(session, target => {
    const me = target.players.find(p => p.isUser);
    if (!me || !me.alive || me.voteDone) return;
    if (ww.phase === 'pk-vote' && target.pkCandidates.includes(me.position)) return; // 平票方无投票权
    const t = targetPos > 0 ? target.players.find(p => p.position === targetPos && p.alive) : null;
    me.votedFor = t ? target.players.indexOf(t) : null;
    me.voteDone = true;
    appendEntries(target, [{ type: 'vote', pos: me.position, text: `🗳️ 我（${me.position}号位）${t ? `投给了 ${t.name}（${t.position}号位）` : '弃票'}` }]);
  });
  finishWerewolfVoteIfReady(session);
}

function finishWerewolfVoteIfReady(session: number): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session)) return;
  const isPk = ww.phase === 'pk-vote';
  const voters = ww.players.filter(p => {
    if (!p.alive) return false;
    if (isPk && ww.pkCandidates.includes(p.position)) return false;
    return true;
  });
  if (voters.some(p => !p.voteDone)) return;
  finishWerewolfVote(session);
}

function finishWerewolfVote(session: number): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session)) return;
  const isPk = ww.phase === 'pk-vote';
  let votedCount = 0;
  let skipCount = 0;
  const tally = new Map<number, number>();
  const voteLines: string[] = [];
  for (const p of ww.players) {
    if (!p.alive) continue;
    if (isPk && ww.pkCandidates.includes(p.position)) {
      voteLines.push(`🗳️ ${p.name}（${p.position}号位）平票玩家无投票权`);
      continue;
    }
    if (p.votedFor !== null) {
      const t = ww.players[p.votedFor];
      if (t) {
        votedCount++;
        tally.set(t.position, (tally.get(t.position) || 0) + 1);
        voteLines.push(`🗳️ ${p.name}（${p.position}号位）投给了 ${t.name}（${t.position}号位）`);
      }
    } else {
      skipCount++;
      voteLines.push(`🗳️ ${p.name}（${p.position}号位）弃票`);
    }
  }
  let exilePos = 0;
  let toPk = false;
  // 进夜（流票/无人得票/二次平票）一律不在 mutate 内推进：统一落回 finishWerewolfDay → toNextNightByService，
  // 否则 toNextNight 被执行两次——天数 +2 且打印两条「夜晚来临」（V1.164 修复）
  mutateWerewolf(session, target => {
    appendEntries(target, [{ type: 'vote', text: voteLines.join('\n') }]);
    // 有效票必须严格大于弃票数（参考实现自创规则，docs/16 §3.1 写明）
    if (votedCount <= skipCount) {
      appendEntries(target, [{ type: 'system', text: `⚖️ 有效投票（${votedCount}票）不大于弃票（${skipCount}票），流票，无人出局，直接进入夜晚。` }]);
      return;
    }
    let maxVotes = 0;
    let top: number[] = [];
    for (const [pos, count] of tally) {
      if (count > maxVotes) {
        maxVotes = count;
        top = [pos];
      } else if (count === maxVotes) top.push(pos);
    }
    if (maxVotes === 0 || !top.length) {
      appendEntries(target, [{ type: 'system', text: '⚖️ 今日无人得票，流票进夜。' }]);
      return;
    }
    if (top.length > 1) {
      if (isPk) {
        const names = top.map(pos => `${pos}号位 ${target.players.find(p => p.position === pos)?.name || '?'}`).join('、');
        appendEntries(target, [{ type: 'system', text: `⚖️ PK投票再次平票（${names}）！二次平票，无人出局，直接进入夜晚。` }]);
      } else {
        target.pkCandidates = top;
        target.phase = 'pk-speak';
        target.currentSpeaker = 0;
        // 白天发言后全员 hasSpoken=true，不重置会让 PK 辩解步把候选人整体跳过、直接进决选
        for (const p of target.players) if (p.alive && target.pkCandidates.includes(p.position)) p.hasSpoken = false;
        const names = top.map(pos => `${pos}号位 ${target.players.find(p => p.position === pos)?.name || '?'}`).join('、');
        appendEntries(target, [{ type: 'system', text: `⚖️ 出现平票！${names} 均为 ${maxVotes} 票。进入平票 PK 辩解环节！` }]);
        toPk = true;
      }
      return;
    }
    const out = target.players.find(p => p.position === top[0] && p.alive);
    if (out) {
      out.alive = false;
      appendEntries(target, [{ type: 'system', text: `💀 ${out.name}（${out.position}号位）以 ${maxVotes} 票（有效投票 ${votedCount} 票 vs 弃票 ${skipCount} 票）被放逐出局` }]);
      exilePos = out.position;
    }
  });
  void (async () => {
    if (!isSessionValid(session)) return;
    if (exilePos) {
      await runLastWords(session, { pos: exilePos, cause: '放逐' });
      if (!isSessionValid(session)) return;
    }
    if (toPk) {
      void runWerewolfPkStep(session);
      return;
    }
    finishWerewolfDay(session);
  })();
}

/** 放逐/玩家遗言后的日间收束：胜负判定 → PK 辩解或进夜。 */
async function finishWerewolfDay(session: number): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session)) return;
  if (checkWerewolfWin(ww)) {
    endWerewolf(session);
    return;
  }
  toNextNightByService(session);
}

function toNextNightByService(session: number): void {
  mutateWerewolf(session, target => toNextNight(target));
  void (async () => {
    const ww = currentWerewolf();
    if (!ww || !isSessionValid(session)) return;
    if (checkWerewolfWin(ww)) {
      endWerewolf(session);
      return;
    }
    await runNightSeer(session);
  })();
}

function toNextNight(target: ActiveWerewolf): void {
  target.day++;
  target.phase = 'seer';
  target.nightKillPos = null;
  target.nightDeaths = [];
  target.witchSavedPos = null;
  target.userKillDone = false;
  target.pkCandidates = [];
  target.currentSpeaker = 0;
  for (const p of target.players) {
    p.hasSpoken = false;
    p.votedFor = null;
    p.voteDone = false;
  }
  appendEntries(target, [{ type: 'system', text: `🌙 第 ${target.day} 天夜晚来临` }]);
}

// ─── PK 辩解 ───

async function runWerewolfPkStep(session: number): Promise<void> {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'pk-speak') return;
  // 同 runWerewolfSpeakStep：跳过结果必须落库（副本推进 → 提交守卫错位 → 无限重复请求）
  let idx = ww.currentSpeaker;
  while (idx < ww.players.length && (!ww.pkCandidates.includes(ww.players[idx].position) || !ww.players[idx].alive || ww.players[idx].hasSpoken)) {
    idx++;
  }
  if (idx >= ww.players.length) {
    startWerewolfVote(session, true);
    return;
  }
  if (idx !== ww.currentSpeaker) {
    mutateWerewolf(session, target => { target.currentSpeaker = idx; });
    if (!isSessionValid(session)) return;
  }
  const seat = ww.players[idx];
  const competitors = ww.pkCandidates
    .filter(pos => pos !== seat.position)
    .map(pos => `${pos}号位 ${ww.players.find(p => p.position === pos)?.name || '?'}`)
    .join('、');
  if (seat.isUser) {
    _lastError = '';
    notifyChanged();
    return;
  }
  const action = buildWerewolfPkAction({
    day: ww.day,
    position: seat.position,
    name: seat.name,
    role: seat.role,
    competitors,
    voiceEmotion: voicePromptOn(seat.name),
  });
  try {
    const raw = await runGameRequest({ system: buildWerewolfSystemPrompt(), user: werewolfRequestUser(ww, seat, action) });
    if (!isSessionValid(session)) return;
    const parsed = parseSpeechReply(raw, '我真的是好人，大家仔细看前置位的投票和发言，投我的问题很大！', '，请好人看清局势把票归过去！');
    mutateWerewolf(session, target => {
      const cur = target.players.find(p => p.position === seat.position);
      if (!cur) return;
      if (parsed.situation) cur.situation = parsed.situation;
      cur.hasSpoken = true;
      appendEntries(target, [
        ...(parsed.think ? [{ type: 'think' as const, pos: seat.position, text: parsed.think }] : []),
        ...(parsed.situation ? [{ type: 'situation' as const, pos: seat.position, text: parsed.situation }] : []),
        { type: 'speech' as const, pos: seat.position, text: `PK辩解：${parsed.speech}`, ...voiceFields(seat.name, parsed) },
      ]);
      advanceWerewolfSpeaker(target);
    });
    void runWerewolfPkStep(session);
  } catch (error) {
    if (!isSessionValid(session)) return;
    setLastError(error instanceof Error ? error.message : String(error));
  }
}

/** 玩家 PK 辩解提交。 */
export function submitWerewolfPkSpeech(session: number, text: string): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session) || ww.phase !== 'pk-speak') return;
  const seat = ww.players[ww.currentSpeaker];
  if (!seat || !seat.isUser || !ww.pkCandidates.includes(seat.position)) return;
  const content = (text || '').trim() || '我真的不是狼，请大家看清局势！';
  mutateWerewolf(session, target => {
    const cur = target.players[target.currentSpeaker];
    cur.hasSpoken = true;
    appendEntries(target, [{ type: 'speech', pos: cur.position, text: `PK辩解：${content}` }]);
    advanceWerewolfSpeaker(target);
  });
  void runWerewolfPkStep(session).catch(() => { /* 失败已入错误通道 */ });
}

// ─── 胜负与终局 ───

function checkWerewolfWin(ww: ActiveWerewolf): boolean {
  const alive = ww.players.filter(p => p.alive);
  const wolves = alive.filter(p => p.role === '狼人');
  const good = alive.filter(p => p.role !== '狼人');
  return wolves.length === 0 || good.length <= 1;
}

function werewolfWinnerSide(ww: ActiveWerewolf): string {
  const wolves = ww.players.filter(p => p.alive && p.role === '狼人').length;
  return wolves === 0 ? '好人阵营' : '狼人阵营';
}

function endWerewolf(session: number): void {
  const ww = currentWerewolf();
  if (!ww || !isSessionValid(session)) return;
  const winnerSide = werewolfWinnerSide(ww);
  const detail = ww.players
    .map(p => `${p.position}号位 ${p.name}${p.isUser ? '（主角）' : ''}：${p.role}·${p.alive ? '存活' : '出局'}`)
    .join('；');
  const record: GameRecord = {
    id: makeId('g_'),
    ts: Date.now(),
    storyTime: ww.storyTime || storyTimeNow(),
    gameType: 'werewolf',
    players: ww.players.map(p => p.name),
    winnerSide,
    text: '',
    detail,
    entries: [],
    highlight: '',
    afterparty: '',
  };
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    const wwNow = d.games.active.werewolf;
    if (wwNow && wwNow.session === session) {
      wwNow.phase = 'end';
      wwNow.winner = winnerSide;
      appendEntries(wwNow, [{ type: 'system', text: `🏆 游戏结束，${winnerSide}获胜！` }]);
      record.entries = [...wwNow.entries];
    }
    d.games.records.werewolf = pushGameRecord(d.games.records.werewolf, record);
    d.games.active.werewolf = null;
  });
  sendWerewolfResultMessages(winnerSide, ww.players, ww.day);
  notifyChanged();
  // L9 成就：终局落记录（rounds=天数；endReason 置空串）
  const me = ww.players.find(p => p.isUser);
  emitAch('phone_game_finished', {
    game: 'werewolf',
    won: achFlag(!!me && ((me.role === '狼人') === (winnerSide === '狼人阵营'))),
    endReason: '',
    rounds: ww.day,
  });
  void runGameEpilogue('werewolf', record.id, session);
}

function sendWerewolfResultMessages(winnerSide: string, seats: WerewolfSeat[], day: number): void {
  const revealLines = seats
    .map(p => `${p.position}号位 ${p.name}（${p.role} · ${p.alive ? '存活' : '出局'}）`)
    .join('\n');
  const known = knownParticipantNames();
  mutatePhoneData(d => {
    for (const seat of seats) {
      if (seat.isUser || !known.has(seat.name)) continue; // NPC 不发私聊（不凭空建会话）
      const conv = ensurePrivateConversation(d, seat.name);
      const message: PhoneMessage = {
        id: makeMessageId(),
        from: 'system',
        type: 'text',
        content: buildWerewolfSystemMessage({
          day,
          winnerSide,
          viewerName: seat.name,
          viewerRole: seat.role,
          viewerAlive: seat.alive,
          revealLines,
        }),
        ts: Date.now(),
        storyTime: storyTimeNow(),
      };
      appendMessage(conv, message);
    }
  });
}

export function currentWerewolfSession(): number {
  return currentWerewolf()?.session || 0;
}

/** 玩家狼密谋数据（UI 战术板展示）。 */
export function werewolfWolfDraft(): { privates: string[]; tactics: { ai: string; user: string; custom: string } | null } {
  const ww = currentWerewolf();
  if (!ww) return { privates: [], tactics: null };
  return {
    privates: ww.entries.filter(e => e.type === 'private').map(e => e.text),
    tactics: ww.userTactics,
  };
}


/** 当前 session（App 恢复对局时取得）。 */
export function currentUndercoverSession(): number {
  return currentUndercover()?.session || 0;
}

// ─── 海龟汤状态机（docs/16 §9；deal 拟题 → ask 轮转提问/猜底 → reveal 终局揭晓 → end） ───
// 防全知视角矩阵：soupBase/keyPoints 只进主持人请求（T3/T4/T5），参与者请求（T2）结构性不含；
// 过程 UI 只渲染汤面与问答流。entries 扩展类型：answer=`tag|voice` / guess / verdict=`miss|文案`或`hit|文案`。

function currentTurtleSoup(): ActiveTurtleSoup | null {
  return readGames().active.turtleSoup || null;
}

function mutateTurtleSoup(session: number, mutator: (ts: ActiveTurtleSoup) => void): void {
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    const ts = d.games.active.turtleSoup;
    if (ts && ts.session === session) mutator(ts);
  });
  notifyChanged();
}

function soupSeatLabel(ts: ActiveTurtleSoup, pos: number | undefined): string {
  if (pos === undefined) return ts.hostName;
  const p = ts.players.find(x => x.position === pos);
  return p ? (p.isUser ? `${p.position}号位 我` : `${p.position}号位 ${p.name}`) : `${pos}号位`;
}

/** 海龟汤历史行（视角矩阵：system/verdict 全员；speech/guess/answer=Q 序号问答；think/situation 不回喂）。 */
function soupHistoryLines(ts: ActiveTurtleSoup): string {
  const lines: string[] = [];
  let q = 0;
  for (const e of ts.entries) {
    if (e.type === 'system' || e.type === 'verdict') {
      lines.push(e.text.replace(/^[a-z]+\|/i, ''));
    } else if (e.type === 'speech') {
      q++;
      lines.push(`Q${q} ${soupSeatLabel(ts, e.pos)}：${e.text}`);
    } else if (e.type === 'guess') {
      q++;
      lines.push(`Q${q} ${soupSeatLabel(ts, e.pos)} 猜汤底：${e.text}`);
    } else if (e.type === 'answer') {
      const split = e.text.indexOf('|');
      const tag = split > 0 ? e.text.slice(0, split) : e.text;
      const voice = split > 0 ? e.text.slice(split + 1) : '';
      lines.push(`→ ${tag}${voice ? `（${voice}）` : ''}`);
    }
  }
  return lines.slice(-GAME_HISTORY_LIMIT).join('\n');
}

/** 日志尾扫描：问题/猜底已落库但主持人回答/判定未落 → 中断点（重试与 UI 防重复提交共用）。 */
function soupPendingStep(ts: ActiveTurtleSoup): { kind: 'answer' | 'verdict'; pos: number; text: string } | null {
  for (let i = ts.entries.length - 1; i >= 0; i--) {
    const e = ts.entries[i];
    if (e.type === 'think' || e.type === 'situation') continue;
    if (e.type === 'speech' && e.pos !== undefined) return { kind: 'answer', pos: e.pos, text: e.text };
    if (e.type === 'guess' && e.pos !== undefined) return { kind: 'verdict', pos: e.pos, text: e.text };
    return null;
  }
  return null;
}

/** 主持人回答/判定在途（UI 据此隐藏输入条防重复提交；等待玩家输入的步骤重入=安全 no-op）。 */
export function turtleSoupBusyStep(): { kind: 'answer' | 'verdict'; pos: number; text: string } | null {
  const ts = currentTurtleSoup();
  if (!ts || ts.phase !== 'ask') return null;
  return soupPendingStep(ts);
}

function advanceSoupSpeaker(ts: ActiveTurtleSoup): void {
  const next = ts.currentSpeaker + 1;
  if (next >= ts.players.length) {
    ts.currentSpeaker = 0;
    ts.round++;
  } else {
    ts.currentSpeaker = next;
  }
}

/** 参与者请求（system 总纲 + 骨架 + 行动段；汤面在行动段注入，汤底结构性不出现）。 */
function turtleSoupRequestUser(ts: ActiveTurtleSoup, seat: TurtleSoupSeat, actionPrompt: string): string {
  const roster = getRoster();
  const me = ts.players.find(p => p.isUser);
  const npc = npcFlags(ts.players);
  const seatLines = [
    ...ts.players.map((p, i) => {
      const tags: string[] = [];
      if (p.isUser) tags.push('主角本人');
      if (p.position === seat.position) tags.push('你');
      if (npc[i]) tags.push('陌生玩家');
      return `${p.position}号位 ${p.name}${tags.length ? `（${tags.join('，')}）` : ''}`;
    }),
    `${ts.hostName}（AI 主持人，出题与守密者，只答是/不是/是也不是/不重要）`,
  ].join('\n');
  const user = buildGameUserContext({
    rules: TURTLESOUP_RULES,
    summaries: summaryPromptLines(summariesForPlayers(readGames().summaries.turtlesoup, ts.players.map(p => p.name), 3)).join('\n'),
    seats: seatLines,
    profiles: buildPublicProfiles(roster, ts.players.map((p, i) => ({ position: p.position, name: p.name, npc: npc[i] }))),
    socialHints: buildSocialHints([...ts.players.filter(p => !p.isUser).map(p => p.name), ts.hostName]),
    self: buildSelfProfile(seat.name, seat.position),
    userName: me?.name || meName(),
    userPosition: me?.position || 1,
    history: soupHistoryLines(ts),
    lastSituation: seat.situation,
  });
  return `${user}\n\n${actionPrompt}`;
}

export async function startTurtleSoup(args: {
  hostName: string;
  inviteeNames: readonly string[];
  category: string;
  quotaLimit: number;
}): Promise<void> {
  assertNoRunningGame();
  const roster = getRoster();
  const me = roster.protagonistName;
  const host = args.hostName.trim();
  const invitees = args.inviteeNames.map(n => n.trim()).filter(Boolean).filter(n => n !== host).slice(0, 4);
  if (!host) throw new PhoneGameError('state', '请先选择 1 位 AI 好友当主持人');
  if (host === me) throw new PhoneGameError('state', '主持人必须是 AI 好友，你是固定参与者');
  if (invitees.length < 1) throw new PhoneGameError('state', '至少邀请 1 位好友参与者（2-5 人局，不含主持人）');
  const quota = Math.min(SOUP_QUOTA_MAX, Math.max(SOUP_QUOTA_MIN, Math.floor(args.quotaLimit) || SOUP_QUOTA_DEFAULT));
  const names = shuffle([me, ...invitees]);
  const seats: TurtleSoupSeat[] = names.map((name, idx) => ({
    position: idx + 1,
    name,
    isUser: name === me,
    situation: '',
  }));
  const session = ++_session;
  const ts: ActiveTurtleSoup = {
    gameType: 'turtlesoup',
    session,
    phase: 'deal',
    round: 1,
    currentSpeaker: 0,
    hostName: host,
    players: seats,
    category: args.category || '不限',
    quotaLimit: quota,
    quotaUsed: 0,
    title: '',
    soupFace: '',
    soupBase: '',
    keyPoints: [],
    winner: '',
    endReason: '',
    solverName: '',
    entries: [{ type: 'system', text: `🐢 海龟汤开始！${seats.length} 位参与者（含我）合作还原汤底 · 主持人 ${host} 正在按「${args.category || '不限'}」类型拟题…` }],
    startedAt: Date.now(),
    storyTime: storyTimeNow(),
  };
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    d.games.active.turtleSoup = ts;
  });
  notifyChanged();
  await runTurtleSoupDeal(session);
}

/** T1 拟题：解析失败进错误条重试（不设内置题库——用户定案 V1.1）。 */
async function runTurtleSoupDeal(session: number): Promise<void> {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'deal') return;
  const req = buildTurtleSoupDealRequest({
    hostName: ts.hostName,
    participants: ts.players.map(p => `${p.position}号位 ${p.name}${p.isUser ? '（人类玩家）' : ''}`),
    category: ts.category,
  });
  let puzzle: ReturnType<typeof parseTurtleSoupPuzzle> = null;
  try {
    const raw = await runGameRequest({ system: req.system, user: req.user });
    if (!isSessionValid(session)) return;
    puzzle = parseTurtleSoupPuzzle(raw);
    if (!puzzle) throw new PhoneGameError('parse', '拟题失败：AI 输出的汤面/汤底/关键点不完整，请重试');
  } catch (error) {
    if (!isSessionValid(session)) return;
    setLastError(error instanceof Error ? error.message : String(error)); // 状态停在 deal，UI 重试条
    return;
  }
  mutateTurtleSoup(session, target => {
    target.title = puzzle!.title;
    target.soupFace = puzzle!.face;
    target.soupBase = puzzle!.base;
    target.keyPoints = puzzle!.keyPoints;
    target.phase = 'ask';
    target.round = 1;
    target.currentSpeaker = 0;
    const first = target.players[0];
    appendEntries(target, [{ type: 'system', text: `🪷 ${target.hostName} 公布了汤面《${target.title}》 · 请轮流提问（${first ? `${first.position}号位 ${first.isUser ? '我' : first.name}` : '?'} 先开始）` }]);
  });
  void runTurtleSoupAskStep(session);
}

/** T2 参与者轮次（AI 自动请求；玩家=等待输入；轮到必行动——提问或猜底，无沉默权）。 */
async function runTurtleSoupAskStep(session: number): Promise<void> {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'ask') return;
  if (soupPendingStep(ts)) {
    await restartTurtleSoupPending(session, ts); // 断链重入：补未完成的主持步
    return;
  }
  const seat = ts.players[ts.currentSpeaker];
  if (!seat) return;
  if (seat.isUser) {
    _lastError = '';
    notifyChanged(); // 等待玩家输入（UI 呈现输入条+猜底+跳过）
    return;
  }
  if (ts.quotaUsed >= ts.quotaLimit) {
    startSoupReveal(session, 'quota'); // 防御：断点恢复时额度已耗尽
    return;
  }
  const action = buildTurtleSoupAction({
    round: ts.round,
    position: seat.position,
    name: seat.name,
    title: ts.title,
    category: ts.category,
    soupFace: ts.soupFace,
    quotaLeft: ts.quotaLimit - ts.quotaUsed,
    quotaLimit: ts.quotaLimit,
    voiceEmotion: voicePromptOn(seat.name),
  });
  try {
    const raw = await runGameRequest({ system: buildTurtleSoupSystemPrompt(), user: turtleSoupRequestUser(ts, seat, action) });
    if (!isSessionValid(session) || currentTurtleSoup()?.phase !== 'ask') return; // 放弃/终局后丢弃迟到结果
    const parsed = parseTriple(raw);
    const act = parseTurtleSoupAction(raw);
    if (act.kind === 'guess') {
      mutateTurtleSoup(session, target => {
        const cur = target.players.find(p => p.position === seat.position);
        if (parsed.situation && cur) cur.situation = parsed.situation;
        target.quotaUsed += 1; // 猜底扣 1 次额度
        appendEntries(target, [
          ...(parsed.think ? [{ type: 'think' as const, pos: seat.position, round: target.round, text: parsed.think }] : []),
          ...(parsed.situation ? [{ type: 'situation' as const, pos: seat.position, round: target.round, text: parsed.situation }] : []),
          { type: 'guess' as const, pos: seat.position, round: target.quotaUsed, text: act.text, ...voiceFields(seat.name, act) },
        ]);
      });
      await runSoupGuessVerdict(session, seat.position, act.text);
    } else {
      mutateTurtleSoup(session, target => {
        const cur = target.players.find(p => p.position === seat.position);
        if (parsed.situation && cur) cur.situation = parsed.situation;
        target.quotaUsed += 1; // 提问扣 1 次额度
        appendEntries(target, [
          ...(parsed.think ? [{ type: 'think' as const, pos: seat.position, round: target.round, text: parsed.think }] : []),
          ...(parsed.situation ? [{ type: 'situation' as const, pos: seat.position, round: target.round, text: parsed.situation }] : []),
          { type: 'speech' as const, pos: seat.position, round: target.quotaUsed, text: act.text, ...voiceFields(seat.name, act) },
        ]);
      });
      await runSoupHostAnswer(session, seat.position, act.text);
    }
  } catch (error) {
    if (!isSessionValid(session) || currentTurtleSoup()?.phase !== 'ask') return; // 放弃/终局后丢弃迟到报错
    setLastError(error instanceof Error ? error.message : String(error)); // 状态未变：App 呈现重试条
  }
}

/** T3 主持人回答（功能请求；汤底+关键点只进主持人请求）。 */
async function runSoupHostAnswer(session: number, askerPos: number, question: string): Promise<void> {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'ask') return;
  const qNo = ts.quotaUsed; // 本问题对应的 Q 序号（提交时已扣次）
  const req = buildTurtleSoupAnswerRequest({
    hostName: ts.hostName,
    participants: ts.players.map(p => `${p.position}号位 ${p.name}${p.isUser ? '（人类玩家）' : ''}`),
    category: ts.category,
    title: ts.title,
    soupFace: ts.soupFace,
    soupBase: ts.soupBase,
    keyPoints: ts.keyPoints,
    qaLog: soupHistoryLines(ts),
    quotaLeft: ts.quotaLimit - ts.quotaUsed,
    quotaLimit: ts.quotaLimit,
    questionLine: `Q${qNo} ${soupSeatLabel(ts, askerPos)}：${question}`,
    voiceEmotion: voicePromptOn(ts.hostName),
  });
  const raw = await runGameRequest({ system: req.system, user: req.user });
  if (!isSessionValid(session) || currentTurtleSoup()?.phase !== 'ask') return; // 放弃/终局后丢弃迟到回答
  const { tag, voice, emotion, delivery } = parseTurtleSoupAnswer(raw);
  mutateTurtleSoup(session, target => {
    appendEntries(target, [{ type: 'answer', round: qNo, text: `${tag}|${voice}`, ...voiceFields(ts.hostName, { emotion, delivery }) }]);
  });
  const after = currentTurtleSoup();
  if (!after || !isSessionValid(session)) return;
  if (after.quotaUsed >= after.quotaLimit) {
    startSoupReveal(session, 'quota'); // 回答完最后一问直接揭晓
    return;
  }
  mutateTurtleSoup(session, target => advanceSoupSpeaker(target));
  void runTurtleSoupAskStep(session);
}

/** T4 猜底判定（功能请求；SOLVED=覆盖全部关键点）。 */
async function runSoupGuessVerdict(session: number, guesserPos: number, guessText: string): Promise<void> {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'ask') return;
  const req = buildTurtleSoupVerdictRequest({
    hostName: ts.hostName,
    participants: ts.players.map(p => `${p.position}号位 ${p.name}${p.isUser ? '（人类玩家）' : ''}`),
    category: ts.category,
    title: ts.title,
    soupFace: ts.soupFace,
    soupBase: ts.soupBase,
    keyPoints: ts.keyPoints,
    qaLog: soupHistoryLines(ts),
    quotaLeft: ts.quotaLimit - ts.quotaUsed,
    quotaLimit: ts.quotaLimit,
    guesserLine: `Q${ts.quotaUsed} ${soupSeatLabel(ts, guesserPos)} 猜汤底：${guessText}`,
  });
  const raw = await runGameRequest({ system: req.system, user: req.user });
  if (!isSessionValid(session) || currentTurtleSoup()?.phase !== 'ask') return; // 放弃/终局后丢弃迟到判定
  const { solved, comment } = parseTurtleSoupVerdict(raw);
  if (solved) {
    const guesser = ts.players.find(p => p.position === guesserPos);
    mutateTurtleSoup(session, target => {
      appendEntries(target, [{ type: 'verdict', round: target.quotaUsed, text: `hit|🎯 ${target.hostName}判定：还原成功！——「${comment}」` }]);
      target.phase = 'reveal';
      target.endReason = 'guess';
      target.solverName = guesser ? (guesser.isUser ? '我' : guesser.name) : '';
    });
    void runSoupReveal(session).catch(() => { /* 失败已入错误通道 */ });
    return;
  }
  mutateTurtleSoup(session, target => {
    appendEntries(target, [{ type: 'verdict', round: target.quotaUsed, text: `miss|🎯 ${target.hostName}判定：还原未中 · 消耗 1 次额度（${target.quotaUsed}/${target.quotaLimit}）——「${comment}」` }]);
  });
  const after = currentTurtleSoup();
  if (!after || !isSessionValid(session)) return;
  if (after.quotaUsed >= after.quotaLimit) {
    startSoupReveal(session, 'quota'); // 猜错耗尽最后一格
    return;
  }
  mutateTurtleSoup(session, target => advanceSoupSpeaker(target));
  void runTurtleSoupAskStep(session);
}

/** 玩家提问（扣 1 次额度 → 主持答）。 */
export function submitTurtleSoupQuestion(session: number, text: string): void {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'ask') return;
  const seat = ts.players[ts.currentSpeaker];
  if (!seat || !seat.isUser || soupPendingStep(ts)) return;
  const content = (text || '').trim();
  if (!content || ts.quotaUsed >= ts.quotaLimit) return;
  _lastError = '';
  mutateTurtleSoup(session, target => {
    target.quotaUsed += 1;
    appendEntries(target, [{ type: 'speech', pos: seat.position, round: target.quotaUsed, text: content }]);
  });
  runSoupHostAnswer(session, seat.position, content).catch(error => {
    if (isSessionValid(session) && currentTurtleSoup()?.phase === 'ask') setLastError(error instanceof Error ? error.message : String(error));
  });
}

/** 玩家猜底（扣 1 次额度 → 主持判定；覆盖全部关键点=参与者阵营胜利）。 */
export function submitTurtleSoupGuess(session: number, text: string): void {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'ask') return;
  const seat = ts.players[ts.currentSpeaker];
  if (!seat || !seat.isUser || soupPendingStep(ts)) return;
  const content = (text || '').trim();
  if (!content || ts.quotaUsed >= ts.quotaLimit) return;
  _lastError = '';
  mutateTurtleSoup(session, target => {
    target.quotaUsed += 1;
    appendEntries(target, [{ type: 'guess', pos: seat.position, round: target.quotaUsed, text: content }]);
  });
  runSoupGuessVerdict(session, seat.position, content).catch(error => {
    if (isSessionValid(session) && currentTurtleSoup()?.phase === 'ask') setLastError(error instanceof Error ? error.message : String(error));
  });
}

/** 玩家跳过本轮（不消耗额度；AI 无沉默权，跳过仅玩家可用）。 */
export function submitTurtleSoupSkip(session: number): void {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'ask') return;
  const seat = ts.players[ts.currentSpeaker];
  if (!seat || !seat.isUser || soupPendingStep(ts)) return;
  _lastError = '';
  mutateTurtleSoup(session, target => {
    appendEntries(target, [{ type: 'system', text: `⏭️ 我 跳过本轮提问（不消耗额度，剩余 ${target.quotaLimit - target.quotaUsed}/${target.quotaLimit}）` }]);
    advanceSoupSpeaker(target);
  });
  void runTurtleSoupAskStep(session);
}

/** 玩家发起放弃（不消耗额度、无需 AI 同意 → 主持人立即揭晓，主持人胜）。
 *  先终止在途请求：迟到的提交/报错由各步的「阶段已离开 ask」守卫丢弃，不污染揭晓阶段。 */
export function giveUpTurtleSoup(session: number): void {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'ask') return;
  _lastError = '';
  stopGameGeneration();
  startSoupReveal(session, 'giveup');
}

/** 进入终局揭晓（放弃/额度耗尽共用；猜中路在 runSoupGuessVerdict 内直进 reveal）。 */
function startSoupReveal(session: number, reason: 'giveup' | 'quota'): void {
  mutateTurtleSoup(session, target => {
    target.phase = 'reveal';
    target.endReason = reason;
    appendEntries(target, [{
      type: 'system',
      text: reason === 'giveup'
        ? `🏳️ 我 发起放弃 · 主持人 ${target.hostName} 开始揭晓汤底`
        : `❓ 额度耗尽（${target.quotaUsed}/${target.quotaLimit}）· 主持人 ${target.hostName} 开始揭晓汤底`,
    }]);
  });
  void runSoupReveal(session).catch(() => { /* 失败已入错误通道 */ });
}

/** T5 终局揭晓（猜中/放弃/耗尽共用）：揭晓词 + 关键点逐条命中；解析失败停在 reveal 可重试。 */
async function runSoupReveal(session: number): Promise<void> {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'reveal') return;
  const endNote = ts.endReason === 'guess'
    ? `${ts.solverName || '参与者'} 猜中汤底（参与者阵营胜利）`
    : ts.endReason === 'giveup' ? '我发起放弃，主持人获胜' : '额度耗尽，主持人获胜';
  const req = buildTurtleSoupRevealRequest({
    hostName: ts.hostName,
    participants: ts.players.map(p => `${p.position}号位 ${p.name}${p.isUser ? '（人类玩家）' : ''}`),
    category: ts.category,
    title: ts.title,
    soupFace: ts.soupFace,
    soupBase: ts.soupBase,
    keyPoints: ts.keyPoints,
    qaLog: soupHistoryLines(ts),
    endNote,
  });
  let reveal: ParsedSoupReveal;
  try {
    const raw = await runGameRequest({ system: req.system, user: req.user });
    if (!isSessionValid(session)) return;
    const parsed = parseTurtleSoupReveal(raw);
    if (!parsed) throw new PhoneGameError('parse', '揭晓内容解析失败，请重试');
    reveal = parsed;
  } catch (error) {
    if (!isSessionValid(session)) return;
    setLastError(error instanceof Error ? error.message : String(error)); // 停在 reveal，UI 重试条
    return;
  }
  endTurtleSoup(session, reveal);
}

function endTurtleSoup(session: number, reveal: ParsedSoupReveal): void {
  const ts = currentTurtleSoup();
  if (!ts || !isSessionValid(session) || ts.phase !== 'reveal') return;
  const participantsWin = ts.endReason === 'guess';
  const winnerSide = participantsWin ? '参与者阵营' : '主持人';
  const endLabel = participantsWin
    ? `${ts.solverName || '参与者'} 猜中汤底（第 ${ts.round} 圈）`
    : ts.endReason === 'giveup' ? '我发起放弃' : '额度耗尽';
  const detailLines = [
    `主持人：${ts.hostName}`,
    `题目：《${ts.title}》（${ts.category} · 额度 ${ts.quotaUsed}/${ts.quotaLimit}）`,
    `结局：${endLabel}`,
    `汤底：${ts.soupBase}`,
    `点评：${reveal.comment || '—'}`,
    ...ts.keyPoints.map((kp, i) => {
      const hit = reveal.keyPoints[i]?.hit === true;
      const note = reveal.keyPoints[i]?.note || (hit ? '已命中' : '未命中');
      return `关键点${i + 1}：${hit ? '✅' : '❌'}|${kp}|${note}`;
    }),
  ];
  const record: GameRecord = {
    id: makeId('g_'),
    ts: Date.now(),
    storyTime: ts.storyTime || storyTimeNow(),
    gameType: 'turtlesoup',
    players: [ts.hostName, ...ts.players.map(p => p.name)],
    winnerSide,
    text: '',
    detail: detailLines.join('\n').slice(0, 2000),
    entries: [],
    highlight: '',
    afterparty: '',
  };
  mutatePhoneData(d => {
    if (!d.games) d.games = emptyPhoneGames();
    const tsNow = d.games.active.turtleSoup;
    if (tsNow && tsNow.session === session) {
      tsNow.phase = 'end';
      tsNow.winner = winnerSide;
      appendEntries(tsNow, [
        { type: 'system', text: `🐢 ${tsNow.hostName} 揭晓：${reveal.speech}` },
        { type: 'system', text: `🏆 游戏结束，${winnerSide}获胜！` },
      ]);
      record.entries = [...tsNow.entries];
    }
    d.games.records.turtlesoup = pushGameRecord(d.games.records.turtlesoup, record);
    d.games.active.turtleSoup = null;
  });
  sendTurtleSoupResultMessages(winnerSide, ts, endLabel);
  notifyChanged();
  // L9 成就：终局落记录（一口猜中 = endReason 'guess'，无论玩家本人还是队友猜中，参与者阵营都算胜）
  emitAch('phone_game_finished', {
    game: 'turtlesoup',
    won: achFlag(participantsWin),
    endReason: ts.endReason || '',
    rounds: ts.round,
  });
  void runGameEpilogue('turtlesoup', record.id, session);
}

/** 赛后私聊系统消息（主持人与 AI 参与者各一条；不计未读——V1.019 用户定案）。 */
function sendTurtleSoupResultMessages(winnerSide: string, ts: ActiveTurtleSoup, endNote: string): void {
  const known = knownParticipantNames();
  const targets = [ts.hostName, ...ts.players.filter(p => !p.isUser).map(p => p.name)].filter(n => known.has(n));
  mutatePhoneData(d => {
    for (const name of targets) {
      const conv = ensurePrivateConversation(d, name);
      const message: PhoneMessage = {
        id: makeMessageId(),
        from: 'system',
        type: 'text',
        content: buildTurtleSoupSystemMessage({
          isHost: name === ts.hostName,
          winnerSide,
          title: ts.title,
          category: ts.category,
          soupBase: ts.soupBase,
          endNote,
        }),
        ts: Date.now(),
        storyTime: storyTimeNow(),
      };
      appendMessage(conv, message);
    }
  });
}

/** 断点补链：日志尾有已提交未判决的问题/猜底 → 重跑对应主持步（而非重新要参与者行动）。 */
async function restartTurtleSoupPending(session: number, ts: ActiveTurtleSoup): Promise<void> {
  const pending = soupPendingStep(ts);
  if (!pending) return;
  try {
    if (pending.kind === 'answer') await runSoupHostAnswer(session, pending.pos, pending.text);
    else await runSoupGuessVerdict(session, pending.pos, pending.text);
  } catch (error) {
    if (isSessionValid(session) && currentTurtleSoup()?.phase === 'ask') setLastError(error instanceof Error ? error.message : String(error));
  }
}

/** 续玩点火（海龟汤）：deal=补拟题 / ask=补主持步或当前轮 / reveal=补揭晓。
 *  会话采纳：页面刷新后 _session 归零，不采纳则一切提交守卫静默失效（V1.015 教训）。 */
export function resumeTurtleSoupChain(session: number): void {
  const ts = currentTurtleSoup();
  if (!ts || ts.session !== session || hasGameGeneration()) return;
  _session = Math.max(_session, session);
  if (ts.phase === 'deal') void runTurtleSoupDeal(session);
  else if (ts.phase === 'reveal') void runSoupReveal(session).catch(() => { /* 失败已入错误通道 */ });
  else if (ts.phase === 'ask') {
    if (soupPendingStep(ts)) void restartTurtleSoupPending(session, ts);
    else void runTurtleSoupAskStep(session);
  } else notifyChanged();
}

/** UI 重试条：重跑海龟汤当前步骤。 */
export function retryTurtleSoupStep(session: number): void {
  if (hasGameGeneration()) return; // 在途防双发：不先挡住会把错误条清掉又被 resume 守卫弹回
  setLastError('');
  const ts = currentTurtleSoup();
  if (!ts || ts.session !== session) return;
  resumeTurtleSoupChain(session);
}

export function currentTurtleSoupSession(): number {
  return currentTurtleSoup()?.session || 0;
}

