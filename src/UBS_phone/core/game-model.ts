// ===== 游戏中心数据模型（纯函数，零依赖，可被 .cjs 测试直接 require） =====
// 三游戏（狼人杀 werewolf / 谁是卧底 undercover / 海龟汤 turtlesoup）共享：150 字总结池（各 10 局）、
// 完整对局记录（各 10 局，含全景复盘 entries + 高光播报 + 复盘聊天）、进行中局（断点恢复）。
// 存储于 PhoneChatData.games（跟聊天走）；docs/16-游戏中心功能规格.md §2.3/§6。

import { isRecord, makeId } from './ubp-utils';
import { matchedInsideDigitRun, selfStamp } from './social-time';

export type GameType = 'werewolf' | 'undercover' | 'turtlesoup';

export const GAME_TYPES: readonly GameType[] = ['werewolf', 'undercover', 'turtlesoup'];

export function isGameType(value: unknown): value is GameType {
  return value === 'werewolf' || value === 'undercover' || value === 'turtlesoup';
}

export function gameTypeName(type: GameType): string {
  return type === 'werewolf' ? '狼人杀' : type === 'undercover' ? '谁是卧底' : '海龟汤';
}

/** 150 字赛后总结（供后续对局当上下文；按游戏分池 FIFO）。 */
export interface GameSummary {
  id: string;
  ts: number;
  /** 终局时全局数据表「当前时间」快照。 */
  storyTime: string;
  /** 规范绝对故事时间戳（由 storyTime 自锚归一；编年史按天回顾用；解析失败不写）。 */
  storyStamp?: string;
  gameType: GameType;
  /** 全部参与者（含主角）。 */
  players: string[];
  /** 「好人阵营」/「狼人阵营」/「平民阵营」/「卧底」。 */
  winnerSide: string;
  /** ≤150 字（写作时约束，读取侧 400 字防御）。 */
  text: string;
}

/** 全景复盘条目（游戏过程流水；UI 与记录页共用）。 */
export interface GameReplayEntry {
  type: 'system' | 'speech' | 'think' | 'situation' | 'private' | 'vote' | 'action' | 'answer' | 'guess' | 'verdict';
  /** 发言/思考作者号位（system/answer=undefined——海龟汤主持人不在参与者席位内）。 */
  pos?: number;
  /** 卧底轮次 / 海龟汤额度序号 Qn（从 1）。 */
  round?: number;
  text: string;
  /** 语音条（引擎按坐席判定后写入：真实角色=语音条，补位🎭NPC 与玩家台词恒缺省=文字气泡）。
   *  总开关关闭时渲染层一个语音节点都不输出（docs/40 纪律），故本字段只表达「生成时的意图」。 */
  voice?: boolean;
  /** 语音情绪（规范中文八词之一；''=未标注）。 */
  voiceEmotion?: string;
  /** 语音演绎说明（40 字上限裕量；只写「怎么演」）。 */
  voiceDelivery?: string;
}

/** 完整对局记录（终局落库；highlight/afterparty 由赛后请求 B 异步补写）。 */
export interface GameRecord extends GameSummary {
  /** 底牌/词语明细行。 */
  detail: string;
  /** 全景复盘（含全部 think/situation/private——仅记录页可见，docs/16 §0.9）。 */
  entries: GameReplayEntry[];
  /** 戏剧化高光播报（赛后请求 B 产物；''=未生成/失败可重试）。 */
  highlight: string;
  /** 赛后复盘群聊（赛后请求 B 产物；''=未生成/失败可重试）。 */
  afterparty: string;
  /** 赛后朋友圈落库回链（MomentPost.id）。 */
  momentPostId?: string;
}

/** 谁是卧底玩家席位（存储态）。 */
export interface UndercoverSeat {
  position: number;
  name: string;
  isUser: boolean;
  /** 平民词/卧底词（分词前=''）。 */
  word: string;
  isSpy: boolean;
  role: string;
  alive: boolean;
  hasSpoken: boolean;
  /** 本轮投票目标数组下标（null=弃票/未投）。 */
  votedFor: number | null;
  /** 本步投票已完成（含弃票）；请求失败/中断保持 false，重试只补投未完成者。 */
  voteDone: boolean;
  /** 该角色最新整局局势分析（每次请求覆盖写；跨轮记忆唯一载体）。 */
  situation: string;
}

/** 进行中卧底局（断点恢复；phase=words 分词中 / speak 描述 / vote 投票 / end 已终局待清）。 */
export interface ActiveUndercover {
  gameType: 'undercover';
  session: number;
  phase: 'words' | 'speak' | 'vote' | 'end';
  round: number;
  /** 当前发言人下标。 */
  currentSpeaker: number;
  players: UndercoverSeat[];
  civilianWord: string;
  spyWord: string;
  winner: string;
  entries: GameReplayEntry[];
  startedAt: number;
  storyTime: string;
}

// ─── 狼人杀（docs/16 §3） ───

export type WerewolfRole = '狼人' | '村民' | '预言家' | '女巫';

export interface WerewolfSeat {
  position: number;
  name: string;
  isUser: boolean;
  role: WerewolfRole;
  alive: boolean;
  hasSpoken: boolean;
  /** 本轮投票目标数组下标（null=弃票/未投）。 */
  votedFor: number | null;
  /** 本步投票已完成（含弃票）；请求失败/中断保持 false，重试只补投未完成者。 */
  voteDone: boolean;
  /** 该角色最新整局局势分析（跨轮记忆唯一载体）。 */
  situation: string;
}

/** 狼人杀进行中局（断点恢复）。phase=夜晚三步（seer/wolf/witch）→ 白天（speak/vote）→ PK（pk-speak/pk-vote）→ end。 */
export interface ActiveWerewolf {
  gameType: 'werewolf';
  session: number;
  phase: 'seer' | 'wolf' | 'witch' | 'speak' | 'vote' | 'pk-speak' | 'pk-vote' | 'end';
  day: number;
  currentSpeaker: number;
  players: WerewolfSeat[];
  /** 狼刀号位（女巫救后清空）。 */
  nightKillPos: number | null;
  /** 本夜死亡清单（天亮结算公告用）。 */
  nightDeaths: Array<{ pos: number; cause: '狼杀' | '毒杀' }>;
  /** 预言家已验号位（结果由底牌推导，仅预言家视角注入）。 */
  seerChecked: Record<string, boolean>;
  witchUsedAntidote: boolean;
  witchUsedPoison: boolean;
  witchSavedPos: number | null;
  /** AI 狼队首夜战术（悍跳/冲锋/倒钩号位，0=无）。 */
  wolfTactics: { leap: number; charge: number; hook: number } | null;
  /** 玩家当狼时的战术板选择（AI 战术与玩家战术互斥单选+补充指令）。 */
  userTactics: { ai: string; user: string; custom: string } | null;
  /** 玩家狼刀口确认完成（防重复选）。 */
  userKillDone: boolean;
  /** 平票候选号位（PK 轮）。 */
  pkCandidates: number[];
  winner: string;
  entries: GameReplayEntry[];
  startedAt: number;
  storyTime: string;
}

// ─── 海龟汤（docs/16 §9） ───

/** 题目类型（邀请页 chips；AI 主持按此拟题）。 */
export const SOUP_CATEGORIES = ['不限', '清汤', '本格', '变格', '红汤'] as const;
export const SOUP_QUOTA_MIN = 10;
export const SOUP_QUOTA_MAX = 99;
export const SOUP_QUOTA_DEFAULT = 30;
/** 邀请的好友数范围：1~4 位 AI 参与者（+ 我 + 1 位 AI 主持人）。 */
export const SOUP_PARTICIPANT_FRIENDS_MAX = 4;

/** 海龟汤参与者席位（我 + 1~4 位 AI 好友；主持人不入席）。 */
export interface TurtleSoupSeat {
  position: number;
  name: string;
  isUser: boolean;
  /** 该角色最新整局局势分析（每次请求覆盖写；跨轮记忆唯一载体）。 */
  situation: string;
}

/**
 * 进行中海龟汤局（断点恢复）。phase：deal=主持人拟题中 → ask=提问轮转 → reveal=终局揭晓中 → end=已终局待清。
 * 防全知：soupBase/keyPoints 只注入主持人请求（T3/T4/T5），参与者请求结构性不含；
 * 过程 UI 只渲染 soupFace 与问答流，绝不渲染汤底线索。
 * entries 扩展类型：answer（text=`tag|voice`，voice 可空）/ guess（pos=猜底者）/ verdict（text=`miss|comment`或`hit|comment`）。
 */
export interface ActiveTurtleSoup {
  gameType: 'turtlesoup';
  session: number;
  phase: 'deal' | 'ask' | 'reveal' | 'end';
  /** 圈数（全员各行动一次为一圈，从 1）。 */
  round: number;
  /** 当前行动参与者下标。 */
  currentSpeaker: number;
  /** 主持人（好友名单中的 1 位 AI 角色）。 */
  hostName: string;
  players: TurtleSoupSeat[];
  category: string;
  /** 提问上限（10~99，全员共享）。 */
  quotaLimit: number;
  /** 已消耗额度（提问与猜底都计次；跳过不计）。 */
  quotaUsed: number;
  title: string;
  /** 汤面（公布的故事片段；''=拟题中）。 */
  soupFace: string;
  /** 汤底（完整真相；仅主持人请求注入）。 */
  soupBase: string;
  /** 关键点 3~5 条（猜底需全部覆盖；仅主持人请求/终局注入）。 */
  keyPoints: string[];
  winner: string;
  /** 终局路径：guess=有人猜中 / giveup=我发起放弃 / quota=额度耗尽。 */
  endReason: 'guess' | 'giveup' | 'quota' | '';
  /** 猜中路：猜中者名（含我）。 */
  solverName: string;
  entries: GameReplayEntry[];
  startedAt: number;
  storyTime: string;
}

/** 游戏中心数据域（PhoneChatData.games；全空=null 不占形状）。 */
export interface PhoneGames {
  active: {
    werewolf?: ActiveWerewolf | null;
    undercover?: ActiveUndercover | null;
    turtleSoup?: ActiveTurtleSoup | null;
  };
  summaries: { werewolf: GameSummary[]; undercover: GameSummary[]; turtlesoup: GameSummary[] };
  records: { werewolf: GameRecord[]; undercover: GameRecord[]; turtlesoup: GameRecord[] };
}

/** 总结池/记录池上限（用户定案：各游戏 10 局）。 */
export const MAX_GAME_SUMMARIES = 10;
export const MAX_GAME_RECORDS = 10;
/** 两游戏每局邀请的好友数（6 人局=主角+5）。 */
export const GAME_FRIEND_SLOTS = 5;

// ─── 归一化（磁盘读回容错） ───

function str(value: unknown, maxLen: number): string {
  return typeof value === 'string' ? value.slice(0, maxLen) : '';
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strList(value: unknown, maxLen = 60): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((n): n is string => typeof n === 'string' && Boolean(n.trim()))
    .map(n => n.trim().slice(0, maxLen));
}

function makeGameId(): string {
  return makeId('g_');
}

function normalizeReplayEntry(value: unknown): GameReplayEntry | null {
  if (!isRecord(value)) return null;
  const text = str(value.text, 4000).trim();
  if (!text) return null;
  const type = value.type === 'speech' || value.type === 'think' || value.type === 'situation'
    || value.type === 'private' || value.type === 'vote' || value.type === 'action'
    || value.type === 'answer' || value.type === 'guess' || value.type === 'verdict'
    ? value.type
    : 'system';
  const entry: GameReplayEntry = { type, text };
  if (typeof value.pos === 'number' && Number.isFinite(value.pos)) entry.pos = value.pos;
  if (typeof value.round === 'number' && Number.isFinite(value.round) && value.round >= 1) entry.round = value.round;
  // 语音三字段（旧存档无此键 → 原样跳过，零迁移）；空标注不写键，与 chat-model 语音字段同款。
  if (value.voice === true) entry.voice = true;
  const emo = str(value.voiceEmotion, 20).trim();
  if (emo) entry.voiceEmotion = emo;
  const dev = str(value.voiceDelivery, 40).trim();
  if (dev) entry.voiceDelivery = dev;
  return entry;
}

export function normalizeGameSummary(value: unknown): GameSummary | null {
  if (!isRecord(value)) return null;
  const text = str(value.text, 400).trim();
  if (!text || !isGameType(value.gameType)) return null;
  const storyTime = str(value.storyTime, 60);
  const stamp = selfStamp(storyTime);
  return {
    id: typeof value.id === 'string' && value.id ? value.id : makeGameId(),
    ts: numOr(value.ts, Date.now()),
    storyTime,
    ...(stamp ? { storyStamp: stamp } : {}),
    gameType: value.gameType,
    players: strList(value.players),
    winnerSide: str(value.winnerSide, 30).trim() || '未知',
    text,
  };
}

export function normalizeGameRecord(value: unknown): GameRecord | null {
  // 终局瞬间的记录 text=''（赛后总结异步补写）：不得沿用 summary 池的 text 必填校验，
  // 否则任何一次归一化（读/落盘快照）都会把刚打完的局静默丢掉——历史无记录、赛后总结找不到记录、终局面板不出现。
  if (!isRecord(value) || !isGameType(value.gameType)) return null;
  const raw = value;
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map(normalizeReplayEntry)
    .filter((e): e is GameReplayEntry => e !== null)
    .slice(0, 600);
  const record: GameRecord = {
    id: typeof value.id === 'string' && value.id ? value.id : makeGameId(),
    ts: numOr(value.ts, Date.now()),
    storyTime: str(value.storyTime, 60),
    gameType: value.gameType,
    players: strList(value.players),
    winnerSide: str(value.winnerSide, 30).trim() || '未知',
    text: str(value.text, 400).trim(),
    detail: str(raw.detail, 2000),
    entries,
    highlight: str(raw.highlight, 4000),
    afterparty: str(raw.afterparty, 6000),
  };
  const gameStamp = selfStamp(record.storyTime);
  if (gameStamp) record.storyStamp = gameStamp;
  if (typeof raw.momentPostId === 'string' && raw.momentPostId) record.momentPostId = raw.momentPostId.slice(0, 80);
  return record;
}

function normalizeUndercoverSeat(value: unknown): UndercoverSeat | null {
  if (!isRecord(value)) return null;
  const name = str(value.name, 60).trim();
  const position = numOr(value.position, 0);
  if (!name || position < 1 || position > 12) return null;
  const votedRaw = value.votedFor;
  return {
    position,
    name,
    isUser: value.isUser === true,
    word: str(value.word, 40),
    isSpy: value.isSpy === true,
    role: str(value.role, 20).trim() || (value.isSpy === true ? '卧底' : '平民'),
    alive: value.alive !== false,
    hasSpoken: value.hasSpoken === true,
    votedFor: typeof votedRaw === 'number' && Number.isFinite(votedRaw) ? votedRaw : null,
    voteDone: value.voteDone === true,
    situation: str(value.situation, 2000),
  };
}

export function normalizeActiveUndercover(value: unknown): ActiveUndercover | null {
  if (!isRecord(value)) return null;
  const players = (Array.isArray(value.players) ? value.players : [])
    .map(normalizeUndercoverSeat)
    .filter((p): p is UndercoverSeat => p !== null);
  if (players.length < 3) return null;
  const phase = value.phase === 'speak' || value.phase === 'vote' || value.phase === 'end' ? value.phase : 'words';
  return {
    gameType: 'undercover',
    session: numOr(value.session, 1),
    phase,
    round: Math.max(1, Math.floor(numOr(value.round, 1))),
    currentSpeaker: Math.max(0, Math.floor(numOr(value.currentSpeaker, 0))),
    players,
    civilianWord: str(value.civilianWord, 40),
    spyWord: str(value.spyWord, 40),
    winner: str(value.winner, 30),
    entries: (Array.isArray(value.entries) ? value.entries : [])
      .map(normalizeReplayEntry)
      .filter((e): e is GameReplayEntry => e !== null)
      .slice(0, 600),
    startedAt: numOr(value.startedAt, Date.now()),
    storyTime: str(value.storyTime, 60),
  };
}

// ─── 狼人杀归一化 ───

function normalizeWerewolfSeat(value: unknown): WerewolfSeat | null {
  if (!isRecord(value)) return null;
  const name = str(value.name, 60).trim();
  const position = numOr(value.position, 0);
  if (!name || position < 1 || position > 12) return null;
  const role = value.role === '狼人' || value.role === '预言家' || value.role === '女巫' ? value.role : '村民';
  const votedRaw = value.votedFor;
  return {
    position,
    name,
    isUser: value.isUser === true,
    role,
    alive: value.alive !== false,
    hasSpoken: value.hasSpoken === true,
    votedFor: typeof votedRaw === 'number' && Number.isFinite(votedRaw) ? votedRaw : null,
    voteDone: value.voteDone === true,
    situation: str(value.situation, 2000),
  };
}

const WOLF_PHASES = ['seer', 'wolf', 'witch', 'speak', 'vote', 'pk-speak', 'pk-vote', 'end'];

export function normalizeActiveWerewolf(value: unknown): ActiveWerewolf | null {
  if (!isRecord(value)) return null;
  const players = (Array.isArray(value.players) ? value.players : [])
    .map(normalizeWerewolfSeat)
    .filter((p): p is WerewolfSeat => p !== null);
  if (players.length < 3) return null;
  const phase = WOLF_PHASES.includes(String(value.phase)) ? (value.phase as ActiveWerewolf['phase']) : 'seer';
  const seerChecked: Record<string, boolean> = {};
  if (isRecord(value.seerChecked)) {
    for (const [k, v] of Object.entries(value.seerChecked)) {
      if (/^\d+$/.test(k) && v === true) seerChecked[k] = true;
    }
  }
  const deaths = (Array.isArray(value.nightDeaths) ? value.nightDeaths : [])
    .map(d => {
      if (!isRecord(d)) return null;
      const pos = numOr(d.pos, 0);
      if (pos < 1) return null;
      return { pos, cause: d.cause === '毒杀' ? ('毒杀' as const) : ('狼杀' as const) };
    })
    .filter((d): d is { pos: number; cause: '狼杀' | '毒杀' } => d !== null);
  const tacticsRaw = isRecord(value.wolfTactics) ? value.wolfTactics : null;
  const userTacticsRaw = isRecord(value.userTactics) ? value.userTactics : null;
  return {
    gameType: 'werewolf',
    session: numOr(value.session, 1),
    phase,
    day: Math.max(1, Math.floor(numOr(value.day, 1))),
    currentSpeaker: Math.max(0, Math.floor(numOr(value.currentSpeaker, 0))),
    players,
    nightKillPos: typeof value.nightKillPos === 'number' && Number.isFinite(value.nightKillPos) ? value.nightKillPos : null,
    nightDeaths: deaths.slice(0, 12),
    seerChecked,
    witchUsedAntidote: value.witchUsedAntidote === true,
    witchUsedPoison: value.witchUsedPoison === true,
    witchSavedPos: typeof value.witchSavedPos === 'number' ? value.witchSavedPos : null,
    wolfTactics: tacticsRaw
      ? { leap: numOr(tacticsRaw.leap, 0), charge: numOr(tacticsRaw.charge, 0), hook: numOr(tacticsRaw.hook, 0) }
      : null,
    userTactics: userTacticsRaw
      ? {
          ai: str(userTacticsRaw.ai, 10),
          user: str(userTacticsRaw.user, 10),
          custom: str(userTacticsRaw.custom, 200),
        }
      : null,
    userKillDone: value.userKillDone === true,
    pkCandidates: (Array.isArray(value.pkCandidates) ? value.pkCandidates : [])
      .map(n => numOr(n, 0))
      .filter(n => n > 0)
      .slice(0, 6),
    winner: str(value.winner, 30),
    entries: (Array.isArray(value.entries) ? value.entries : [])
      .map(normalizeReplayEntry)
      .filter((e): e is GameReplayEntry => e !== null)
      .slice(0, 600),
    startedAt: numOr(value.startedAt, Date.now()),
    storyTime: str(value.storyTime, 60),
  };
}

// ─── 海龟汤归一化 ───

function normalizeTurtleSoupSeat(value: unknown): TurtleSoupSeat | null {
  if (!isRecord(value)) return null;
  const name = str(value.name, 60).trim();
  const position = numOr(value.position, 0);
  if (!name || position < 1 || position > 12) return null;
  return {
    position,
    name,
    isUser: value.isUser === true,
    situation: str(value.situation, 2000),
  };
}

export function normalizeActiveTurtleSoup(value: unknown): ActiveTurtleSoup | null {
  if (!isRecord(value)) return null;
  const players = (Array.isArray(value.players) ? value.players : [])
    .map(normalizeTurtleSoupSeat)
    .filter((p): p is TurtleSoupSeat => p !== null);
  const hostName = str(value.hostName, 60).trim();
  if (players.length < 2 || players.length > 5 || !hostName) return null;
  const phase = value.phase === 'ask' || value.phase === 'reveal' || value.phase === 'end' ? value.phase : 'deal';
  return {
    gameType: 'turtlesoup',
    session: numOr(value.session, 1),
    phase,
    round: Math.max(1, Math.floor(numOr(value.round, 1))),
    currentSpeaker: Math.max(0, Math.floor(numOr(value.currentSpeaker, 0))),
    hostName,
    players,
    category: str(value.category, 10) || '不限',
    quotaLimit: Math.min(SOUP_QUOTA_MAX, Math.max(SOUP_QUOTA_MIN, Math.floor(numOr(value.quotaLimit, SOUP_QUOTA_DEFAULT)))),
    quotaUsed: Math.max(0, Math.floor(numOr(value.quotaUsed, 0))),
    title: str(value.title, 60),
    soupFace: str(value.soupFace, 1200),
    soupBase: str(value.soupBase, 2000),
    keyPoints: strList(value.keyPoints, 200).slice(0, 5),
    winner: str(value.winner, 30),
    endReason: value.endReason === 'guess' || value.endReason === 'giveup' || value.endReason === 'quota' ? value.endReason : '',
    solverName: str(value.solverName, 60),
    entries: (Array.isArray(value.entries) ? value.entries : [])
      .map(normalizeReplayEntry)
      .filter((e): e is GameReplayEntry => e !== null)
      .slice(0, 600),
    startedAt: numOr(value.startedAt, Date.now()),
    storyTime: str(value.storyTime, 60),
  };
}

/** 全空域返回 null：旧文件零迁移，不向存档写入空 games 键（对齐 spy/social 模式）。 */
export function normalizePhoneGames(value: unknown): PhoneGames | null {
  const raw = isRecord(value) ? value : {};
  const activeRaw = isRecord(raw.active) ? raw.active : {};
  const summariesRaw = isRecord(raw.summaries) ? raw.summaries : {};
  const recordsRaw = isRecord(raw.records) ? raw.records : {};
  const sortNewest = <T extends { ts: number }>(list: T[]): T[] => [...list].sort((a, b) => b.ts - a.ts);
  const loadPool = (type: GameType): GameSummary[] =>
    sortNewest((Array.isArray(summariesRaw[type]) ? summariesRaw[type] : [])
      .map(normalizeGameSummary)
      .filter((s): s is GameSummary => s !== null)).slice(0, MAX_GAME_SUMMARIES);
  const loadRecords = (type: GameType): GameRecord[] =>
    sortNewest((Array.isArray(recordsRaw[type]) ? recordsRaw[type] : [])
      .map(normalizeGameRecord)
      .filter((r): r is GameRecord => r !== null)).slice(0, MAX_GAME_RECORDS);
  const out: PhoneGames = {
    active: {
      werewolf: normalizeActiveWerewolf(activeRaw.werewolf),
      undercover: normalizeActiveUndercover(activeRaw.undercover),
      turtleSoup: normalizeActiveTurtleSoup(activeRaw.turtleSoup),
    },
    summaries: { werewolf: loadPool('werewolf'), undercover: loadPool('undercover'), turtlesoup: loadPool('turtlesoup') },
    records: { werewolf: loadRecords('werewolf'), undercover: loadRecords('undercover'), turtlesoup: loadRecords('turtlesoup') },
  };
  const hasActive = hasAnyRunningGame(out);
  const hasSummaries = out.summaries.werewolf.length > 0 || out.summaries.undercover.length > 0 || out.summaries.turtlesoup.length > 0;
  const hasRecords = out.records.werewolf.length > 0 || out.records.undercover.length > 0 || out.records.turtlesoup.length > 0;
  if (!hasActive && !hasSummaries && !hasRecords) return null;
  return out;
}

// ─── 池操作（纯函数） ───

/** 空游戏域（games 首次落库形状）。 */
export function emptyPhoneGames(): PhoneGames {
  return {
    active: { werewolf: null, undercover: null, turtleSoup: null },
    summaries: { werewolf: [], undercover: [], turtlesoup: [] },
    records: { werewolf: [], undercover: [], turtlesoup: [] },
  };
}

/**
 * 是否有进行中的对局（三款游戏任一占用 active 槽位）。
 * 纯函数收 games 本体：同一渲染帧/净化流程内已有的数据直接传入，免二次全量深拷贝。
 */
export function hasAnyRunningGame(games: PhoneGames | null | undefined): boolean {
  const active = games?.active;
  return Boolean(active && (active.undercover || active.werewolf || active.turtleSoup));
}

/** 总结入池（新→旧，FIFO 裁剪）。 */
export function pushGameSummary(pool: GameSummary[], fresh: GameSummary): GameSummary[] {
  return [fresh, ...pool].slice(0, MAX_GAME_SUMMARIES);
}

/** 记录入池（新→旧，FIFO 裁剪）。 */
export function pushGameRecord(pool: GameRecord[], fresh: GameRecord): GameRecord[] {
  return [fresh, ...pool].slice(0, MAX_GAME_RECORDS);
}

/**
 * 取与 names 有交集的最近 count 场总结（聊天关键词注入/赛后文风参考共用口径）。
 * pool 新→旧；返回保持新→旧。
 */
export function summariesForPlayers(pool: readonly GameSummary[], names: readonly string[], count = 3): GameSummary[] {
  const nameSet = new Set(names.filter(Boolean));
  if (!nameSet.size) return [];
  const out: GameSummary[] = [];
  for (const s of pool) {
    if (s.players.some(p => nameSet.has(p))) {
      out.push(s);
      if (out.length >= count) break;
    }
  }
  return out;
}

/** 聊天关键词 → 游戏类型（docs/16 §2.8：用户输入含「狼人杀/谁是卧底/海龟汤」即触发总结注入）。 */
export function gameTypesFromText(text: unknown): GameType[] {
  const t = String(text ?? '');
  const out: GameType[] = [];
  if (t.includes('狼人杀')) out.push('werewolf');
  if (t.includes('谁是卧底')) out.push('undercover');
  if (t.includes('海龟汤')) out.push('turtlesoup');
  return out;
}

/** 总结 → 提示词行（「- [谁是卧底 · 05-12] …」；无日期省略日期段）。 */
export function summaryPromptLines(list: readonly GameSummary[]): string[] {
  return list.map(s => {
    // F60(第十二轮)：补 ≥7 位年份护栏——裸正则会把 1234567-01-01 从第 2 个字符起匹配成 234567-01-01，
    // 把错日期写进提示词；宁可不给日期也不给错日期（与 social-time 同口径）。
    const dm = s.storyTime.match(/(\d{1,6}-\d{1,2}-\d{1,2})/);
    const date = dm && !matchedInsideDigitRun(s.storyTime, dm.index) ? dm[1] : '';
    const head = `[${gameTypeName(s.gameType)}${date ? ` · ${date}` : ''}]`;
    return `- ${head} ${s.winnerSide}获胜。${s.text}`;
  });
}
