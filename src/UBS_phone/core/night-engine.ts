// ===== 不夜城 AI 引擎（三段式管线 + 本地动作 + 只读单向域） =====
//
// ★ 只读单向域护栏（docs/18 §1，tests/phone-night-readonly.test.ts 锁定）：
//   本模块**不 import** message-worldbook / world-link / spy-worldbook / phone-timeline，
//   不注册任何投影，不改 phone-timeline；扫描 keep 谓词恒 false（[UBS手机] 前缀条目一律不进本次扫描——
//   本 App 的"入"只有资料块里显式给出的正文与只读节选，杜绝经投影回喂形成隐性回写）。
//
// 三段式（镜像 social-engine）：
//   ① injectPrompts 绿灯触发 ubp_night_trigger_<mode>  position:'none' + should_scan + once
//   ② injectPrompts 资料块 ubp_night_dossier_<mode>     position:'after_system'
//   ③ generateRaw（runPhoneRaw，scope:'night'）+ max_chat_history:0 + generation_id 可中断
//
// 落盘：只写 PhoneChatData.night（滚动窗口 + 各域合并），绝不触碰 worldbook/时间线/其它 App。

import { makeId, revealDelay, sleep } from './ubp-utils';
import { readChronicleDossierBlocks } from '../../unified-statusbar/core/chronicle-blocks';
import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { getTavernHelper, makeGenerationId, stopGenerationById } from './host-env';
import { mergeFocusPicks, mergeOneShotHint } from './extra-hint';
import { PhoneChatError, readAiChatHistory } from './chat-engine';
import { runPhoneRaw } from './phone-raw';
import { getRoster, type RosterSnapshot } from './roster';
import type { PhoneChatData } from './chat-model';
import { currentPhoneStorageId, mutatePhoneData, readPhoneData, readPhoneDataRef } from './phone-store';
import { getPhoneSettings } from './phone-settings';
import { validatePhoneApi } from './phone-api';
import {
  NIGHT_BOARDS,
  NIGHT_DEFAULT_SPICE,
  NIGHT_GIFTS,
  NIGHT_MAX_POSTS_MAX,
  NIGHT_MAX_POSTS_MIN,
  NIGHT_BOOST_STEPS,
  clampNightSpice,
  nightBoardDef,
  nightBoardName,
  normalizeSpice,
  type NightSpice,
} from './night-config';
import {
  addNightNotifications,
  addNightTip,
  appendNightBarrage,
  appendNightComments,
  appendNightOrders,
  appendNightRound,
  applyNightDateNode,
  deleteNightComment,
  deleteNightDm,
  deleteNightItems,
  ensureNightData,
  fillNightTags,
  isNightFavorited,
  isNightDmMsgEditable,
  makeNightDateId,
  makeNightDmId,
  makeNightEntryId,
  makeNightLiveId,
  makeNightMsgId,
  makeNightNotifyId,
  makeNightOrderId,
  markAllNightNotificationsRead,
  markNightNotificationsRead,
  mergeNightDms,
  mergeNightLives,
  mergeNightPosts,
  nightActiveDate,
  nightPlausibleCount,
  nightTintOf,
  nightTopPrivilege,
  normalizeNightBarrage,
  normalizeNightCommentInput,
  normalizeNightData,
  pickNightDateChoice,
  readNightOf,
  replaceNightBoards,
  toggleNightFavorite,
  toggleNightFollow,
  type NightBarrage,
  type NightData,
  type NightDate,
  type NightDm,
  type NightDmMsg,
  type NightImage,
  type NightLive,
  type NightNotification,
  type NightOrder,
  type NightPost,
} from './night-model';
import {
  buildDateSceneSection,
  buildDmSceneSection,
  buildLiveSceneSection,
  buildNightDossierText,
  buildNightInstruction,
  buildNightReadonlySection,
  buildNightTriggerText,
  nightDigestLines,
  nightFallbackAlias,
  nightLiveDigestLines,
  nightSocialDigestLines,
  pickNightNames,
  type NightMode,
} from './night-prompts';
import {
  nightParseHasContent,
  parseNightReply,
  type NightParseResult,
} from './night-parser';
import { normalizeStoryTimeLabel } from './social-time';
import { emitAch } from './phone-achievements';

// ─── 运行期状态（防重入 + 可中止） ───

/** 进行中的 generation id（终止用）。 */
const _activeGenerations = new Set<string>();
/** 生成中作用域键（同作用域互斥：`night:refresh` / `night:order:<liveId>` / `night:dm:<peer>` …）。 */
const _busy = new Set<string>();

/** 终止当前全部不夜城生成。返回是否有请求被终止。 */
export function abortNightGeneration(): boolean {
  let stopped = false;
  for (const id of _activeGenerations) {
    if (stopGenerationById(id)) stopped = true;
  }
  _activeGenerations.clear();
  _busy.clear();
  return stopped;
}

export function isNightBusy(scope?: string): boolean {
  return scope ? _busy.has(scope) : _busy.size > 0;
}

function nightScope(...parts: string[]): string {
  return ['night', ...parts.filter(Boolean)].join(':');
}

// ─── 设置读取（一处口径，渲染与引擎共用） ───

/** 尺度降录（写侧唯一入口）：只按板块上限降录（全局上限与禁看标签已整体移除）。 */
export function nightClampSpice(spice: unknown, board: string): NightSpice {
  const boardMax = nightBoardDef(board)?.spiceMax ?? 3;
  return clampNightSpice(spice, boardMax);
}

/** 保留内容数（滚动窗口；设置 nightMaxPosts）。 */
function nightMaxPosts(): number {
  const value = getPhoneSettings().nightMaxPosts;
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 40;
  return Math.max(NIGHT_MAX_POSTS_MIN, Math.min(NIGHT_MAX_POSTS_MAX, n));
}

/** 触发随机人物数（nightTriggerContacts）。 */
function triggerCount(): number {
  const value = getPhoneSettings().nightTriggerContacts;
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 3;
  return Math.max(0, Math.min(10, n));
}

/** 单场轮数上限（nightLiveRounds）。 */
function liveRoundCap(): number {
  const value = getPhoneSettings().nightLiveRounds;
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 12;
  return Math.max(1, Math.min(30, n));
}

/** 正文楼层数（复用社媒口径 socialHistoryCount；0=不带正文）。 */
function storyCount(): number {
  const value = getPhoneSettings().socialHistoryCount;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : 4;
}

/** 图文比（50/70/90）与是否给这条帖配图。 */
function wantsImage(seed: string, board: string): boolean {
  const def = nightBoardDef(board);
  if (def?.imageMode === 'must') return true;
  const ratio = getPhoneSettings().nightImageRatio;
  const pct = ratio === 50 || ratio === 90 ? ratio : 70;
  const hash = nightPlausibleCount(`i|${seed}`);
  return hash % 100 < pct;
}

/** 隐身浏览（默认开；未设置视为开）。 */
export function nightStealthOn(): boolean {
  const me = readPhoneDataRef().night?.me;
  return me ? me.stealth !== false : true;
}

// ─── 马甲（主角在本 App 的匿名身份） ───

/** 当前马甲（未生成过返回兜底名；渲染层与本地动作共用同一入口）。 */
export function nightAlias(): string {
  const alias = readPhoneDataRef().night?.me?.alias || '';
  return alias || nightFallbackAlias();
}

/** 马甲是否已由 AI 生成过（UI 提示与「重新生成马甲」入口用）。 */
export function hasNightAlias(): boolean {
  return Boolean(readPhoneDataRef().night?.me?.alias);
}

/** 设置马甲（本地改名；≤8 字，禁与主角/通讯录重名）。 */
export function setNightAlias(alias: string): { ok: boolean; error?: string } {
  const name = alias.trim().slice(0, 8);
  if (!name) return { ok: false, error: '马甲不能为空' };
  const roster = getRoster();
  if (name === roster.protagonistName || roster.contacts.some(c => c.name === name)) {
    return { ok: false, error: '马甲不能与已有角色重名' };
  }
  mutatePhoneData(d => {
    const night = ensureNightData(d);
    night.me.alias = name;
    night.me.aliasEdited = true;
  });
  return { ok: true };
}

// ─── 只读上下文组装 ───

/** 只读参考资料段（从 readPhoneData 取字段传进纯函数——不 import 任何投影模块）。 */
function readonlySectionOf(me: string): string {
  const data = readPhoneData();
  const conversations = [...data.conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4)
    .map(c => ({
      kind: c.kind,
      title: c.title,
      members: c.members,
      messages: c.messages.slice(-4).map(m => ({ from: m.from, type: m.type, content: m.content, ...(m.amount ? { amount: m.amount } : {}) })),
    }));
  const calls = (data.calls || []).slice(0, 3).map(c => ({
    peer: c.peerName,
    kind: c.direction === 'outgoing' ? '拨出' : '来电',
    ...(c.durationSec ? { duration: `${Math.max(1, Math.round(c.durationSec / 60))}分钟` } : {}),
  }));
  return buildNightReadonlySection({
    me,
    conversations,
    calls,
    socialLines: nightSocialDigestLines(data.social),
    count: 12,
  });
}

/** 本次资料块的角色名单（触发随机 + 场景必需角色；去重、上限 10）。 */
function castNamesFor(roster: RosterSnapshot, extra: string[], trigger: number): string[] {
  const pool = roster.contacts.map(c => c.name);
  const picked = pickNightNames(pool, trigger);
  const out: string[] = [];
  for (const name of [...extra, ...picked]) {
    if (name && pool.includes(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, 10);
}

/** 本次参与的板块（整版刷新抽 3 个；定点=指定板块）。 */
function pickBoards(boardId: string | undefined, existing: NightData): string[] {
  if (boardId) return [boardId];
  const ids = existing.boards.map(b => b.id).filter(id => NIGHT_BOARDS.some(b => b.id === id));
  const pool = ids.length ? ids : NIGHT_BOARDS.map(b => b.id);
  return pickNightNames(pool, Math.min(3, pool.length));
}

/** 角色档案卡（涉及的角色若已生成过则注入——点单被拒的依据）。 */
function personasOf(names: string[]): NonNullable<NightData['personas']>[string][] | undefined {
  const personas = readPhoneDataRef().night?.personas;
  if (!personas || !names.length) return undefined;
  const out = names.map(n => personas[n]).filter(Boolean);
  return out.length ? out : undefined;
}

// ─── 共享生成段 ───

interface NightRawArgs {
  mode: NightMode;
  scope: string;
  triggerText: string;
  dossierText: string;
  instruction: string;
}

/** 三段式：① 绿灯触发注入 ② 资料块注入 ③ 裸生成（可中止）。 */
async function generateNightRaw(args: NightRawArgs): Promise<string> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  // ①② 一次性注入：once:true 只在下一次请求生成中有效 → 交给 runPhoneRaw 的 prepare 每次尝试前重跑
  const prepare = async () => {
  if (args.triggerText.trim()) {
    await th.injectPrompts([{
      id: `ubp_night_trigger_${args.mode}`,
      position: 'none',
      depth: 0,
      role: 'system',
      content: args.triggerText,
      should_scan: true,
    }], { once: true });
  }
  await th.injectPrompts([{
    id: `ubp_night_dossier_${args.mode}`,
    position: 'after_system',
    depth: 0,
    role: 'system',
    content: args.dossierText,
    should_scan: false,
  }], { once: true });
  };
  const instruction = th.substitudeMacros ? th.substitudeMacros(args.instruction) : args.instruction;
  const generationId = makeGenerationId('ubp-night');
  _activeGenerations.add(generationId);
  try {
    // keep 恒 false：不夜城是只读单向域——[UBS手机] 前缀条目一律不进本次扫描（"入"只有资料块里的显式内容）
    return await runPhoneRaw({
      scope: 'night',
      instruction,
      generationId,
      keep: () => false,
      prepare,
      activity: {
        feature: '不夜城',
        label: '不夜城',
        appId: 'night',
        tone: 'ai',
        onCancel: () => { abortNightGeneration(); },
      },
    });
  } finally {
    _activeGenerations.delete(generationId);
  }
}

function assertNightReady(): void {
  const apiError = validatePhoneApi('night');
  if (apiError) throw new PhoneChatError('api', apiError);
}

/** 生成中互斥包装（同 scope 再点直接抛；返回作用域键供调用方复用）。 */
async function withScope<T>(scope: string, label: string, run: () => Promise<T>): Promise<T> {
  if (_busy.has(scope)) throw new PhoneChatError('env', `${label}正在生成中，请稍候`);
  assertNightReady();
  _busy.add(scope);
  try {
    return await run();
  } finally {
    _busy.delete(scope);
  }
}

/** W1 聊天归属守卫:夜城产物只落发起时的聊天;已切聊天则整轮静默丢弃(不写库、不记错误、不派发)。 */
function mutateNightOwned<T>(owner: string, fn: (d: PhoneChatData) => T): T | undefined {
  if (currentPhoneStorageId() !== owner) return undefined;
  return mutatePhoneData(fn);
}

/** 失败持久通知（用户点开 App 才清；成功生成时作废）。 */
function recordNightError(message: string): void {
  mutatePhoneData(d => {
    const night = ensureNightData(d);
    night.lastError = { text: message.slice(0, 300), ts: Date.now() };
  });
}

function clearNightError(): void {
  mutatePhoneData(d => {
    const night = d.night;
    if (night?.lastError) delete night.lastError;
  });
}

/** 帖盖故事时间戳（落盘口径；timeLabel/storyTime 原文保留兜底）。 */
function stampPost<T extends { timeLabel: string; storyStamp?: string }>(post: T, anchor: string): T {
  const stamp = normalizeStoryTimeLabel(post.timeLabel, anchor) || undefined;
  return stamp ? { ...post, storyStamp: stamp } : post;
}

// ─── 街区：整版/定点刷新 ───

export interface NightRefreshArgs {
  /** 定点板块（长按板块 chip）。 */
  board?: string;
  /** 关键词定点生成。 */
  keyword?: string;
  /** 「再看一点」补充生成。 */
  more?: boolean;
  extraHint?: string;
  /** 长按弹层勾选的角色名（进扫描，不足补足）。 */
  focusNames?: string[];
  rosterOverride?: RosterSnapshot;
}

export interface NightRefreshResult {
  mode: NightParseResult;
  raw: string;
  added: number;
}

/**
 * 刷新不夜城内容：整版（多板块 4-8 帖）/ 板块定点（6-10 帖）/ 关键词（4-8 帖）/ 再看一点（4-8 帖）。
 * 评论一次成型；贴吧式滚动窗口合并；消息页通知对照合并前状态生成。
 */
export async function refreshNight(args: NightRefreshArgs = {}): Promise<NightRefreshResult> {
  const mode: NightMode = args.keyword ? 'keyword' : args.board ? 'board' : args.more ? 'more' : 'refresh';
  const scope = nightScope('refresh');
  return withScope(scope, '不夜城刷新', async () => {
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const settings = getPhoneSettings();
    const data = readPhoneData();
    const night = readNightOf(data);
    const style = data.style || '';
    const boards = args.board ? [args.board] : pickBoards(undefined, night);
    const anchor = roster.global.time || '';
    // 自动生成的尺度档：默认档（最高档）与本次板块上限取小——上限由板块决定，全局不再压
    const boardCeiling = boards.reduce<number>((min, id) => Math.min(min, nightClampSpice(NIGHT_DEFAULT_SPICE, id)), NIGHT_DEFAULT_SPICE);
    const spice = normalizeSpice(boardCeiling, NIGHT_DEFAULT_SPICE);
    const triggerNames = args.focusNames?.length
      ? mergeFocusPicks(args.focusNames, roster.contacts.map(c => c.name), Math.max(triggerCount(), args.focusNames.length))
      : pickNightNames(roster.contacts.map(c => c.name), triggerCount());
    const cast = castNamesFor(roster, triggerNames, triggerCount());
    const extra = mergeOneShotHint(settings.extraPrompt, args.extraHint);
    const instruction = buildNightInstruction({
      promptOverrides: getPhoneSettings().nightPrompts,
      mode,
      roster,
      spice,
      boards,
      ...(args.board ? { focus: { board: args.board } } : {}),
      ...(args.keyword ? { focus: { keyword: args.keyword } } : {}),
      ...(extra ? { extraPrompt: extra } : {}),
      alias: nightAlias(),
      style,
    });
    let raw: string;
    try {
      raw = await generateNightRaw({
        mode,
        scope,
        triggerText: buildNightTriggerText({ names: triggerNames, storyText: stripWithContextConfig(readAiChatHistory(1)), ...((args.keyword || '').trim() ? { extra: args.keyword!.trim() } : {}) }),
        dossierText: buildNightDossierText({
          promptOverrides: getPhoneSettings().nightPrompts,
          roster,
          spice,
          boards,
          chronicleBlocks: readChronicleDossierBlocks(cast, settings.summaryCount),
          storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
          castNames: cast,
          digest: nightDigestLines(night.posts),
          readonlySection: readonlySectionOf(me),
          style,
        }),
        instruction,
      });
    } catch (e) {
      if (currentPhoneStorageId() === owner) recordNightError(e instanceof Error ? e.message : String(e)); // W1:错误只记发起聊天
      throw e;
    }
    if (!raw.trim()) throw new PhoneChatError('parse', 'AI 返回了空内容');
    const parsed = parseNightReply(raw, { mode: mode === 'keyword' ? 'keyword' : mode, me, alias: nightAlias(), ...(args.board ? { allowedBoards: [args.board] } : {}) });
    if (!parsed || !nightParseHasContent(mode, parsed)) {
      throw new PhoneChatError('parse', '生成内容无法解析为不夜城内容');
    }
    clearNightError();
    const kept = parsed.posts
      .map(p => stampPost({ ...p, storyTime: roster.global.time || undefined }, anchor))
      .map(p => fillNightTags({
        ...p,
        spice: nightClampSpice(p.spice, p.board),
        // 图文比：暗房恒带图，其余板块按设置比例决定是否保留配图（本地策略，零 AI）
        images: wantsImage(`${p.title}|${p.content.slice(0, 12)}`, p.board) ? p.images : [],
      }));
    mutatePhoneData(d => {
      const live = ensureNightData(d);
      live.boards = replaceNightBoards(live.boards, parsed.boards.length ? parsed.boards.map(id => ({ id })) : boards.map(id => ({ id })));
      const notes = notificationBatchFor(live, kept, me, nightAlias(), anchor, nightStealthOn());
      addNightNotifications(live, notes);
      live.posts = mergeNightPosts(live.posts, kept, nightMaxPosts());
      live.refreshedAt = Date.now();
    });
    return { mode: parsed, raw, added: kept.length };
  });
}

/**
 * 刷新后置通知（对照合并前状态）：① 我帖子的新回复（隐身也生成）② 关注的人发新帖（隐身也生成）
 * ③ 委托被应征 ④ 被点名/被拒（隐身时不生成——隐身浏览不留痕）。
 */
function notificationBatchFor(night: NightData, fresh: NightPost[], me: string, alias: string, anchor: string, stealth: boolean): NightNotification[] {
  const out: NightNotification[] = [];
  const existingById = new Map(night.posts.map(p => [p.id, p]));
  for (const post of fresh) {
    const before = existingById.get(post.id);
    const mine = post.byMe === true || post.author === alias;
    if (mine) {
      const known = new Set((before?.comments || []).map(c => `${c.name}\u0001${c.text}`));
      for (const comment of post.comments) {
        if (comment.name === alias || comment.name === me) continue;
        if (known.has(`${comment.name}\u0001${comment.text}`)) continue;
        out.push({
          id: makeNightNotifyId(),
          type: 'reply',
          author: comment.name,
          content: comment.text.slice(0, 40),
          postId: post.id,
          time: comment.time || '',
          createdAt: Date.now(),
        });
      }
    } else if (night.me.follows.includes(post.author)) {
      out.push({
        id: makeNightNotifyId(),
        type: 'post',
        author: post.author,
        content: (post.title || post.content).slice(0, 40),
        postId: post.id,
        time: post.timeLabel || '',
        createdAt: Date.now(),
      });
    }
    if (post.kind === 'bounty' && post.entries?.length) {
      if (stealth) continue;
      const known = new Set((before?.entries || []).map(e => e.id));
      for (const entry of post.entries) {
        if (known.has(entry.id)) continue;
        out.push({
          id: makeNightNotifyId(),
          type: 'entry',
          author: entry.author,
          content: entry.text.slice(0, 40),
          postId: post.id,
          time: post.timeLabel || '',
          createdAt: Date.now(),
        });
      }
    }
  }
  void anchor;
  return out;
}

/** 帖子详情「跟一层」：为该帖续写 3-6 条新回复（1 次调用）。 */
export async function expandNightPost(postId: string, args: { extraHint?: string; rosterOverride?: RosterSnapshot } = {}): Promise<number> {
  const scope = nightScope('post', postId);
  return withScope(scope, '回复生成', async () => {
    const data = readPhoneData();
    const night = readNightOf(data);
    const post = night.posts.find(p => p.id === postId);
    if (!post) throw new PhoneChatError('env', '帖子不存在或已沉底');
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const style = data.style || '';
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const cast = castNamesFor(roster, [post.author, ...post.comments.slice(-3).map(c => c.name)], triggerCount());
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'post',
      scope,
      triggerText: buildNightTriggerText({ names: [post.author, ...cast], storyText: stripWithContextConfig(readAiChatHistory(1)) }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice: nightClampSpice(post.spice, post.board),
        boards: [post.board],
        chronicleBlocks: readChronicleDossierBlocks(cast, getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: cast,
        digest: [`原帖：${post.title || post.content.slice(0, 24)}`, ...post.comments.slice(-6).map(c => `${c.name}：${c.text}`)],
        sceneSection: `■ 目标帖子\n${post.author} 在「${nightBoardName(post.board, style)}」发了：${post.title ? `《${post.title}》` : ''}${post.content}\n标签：${post.tags.join('、')}　尺度：${post.spice}/3\n现有评论：\n${post.comments.map(c => `${c.name}${c.replyTo ? `（回复 ${c.replyTo}）` : ''}：${c.text}`).join('\n') || '（还没有评论）'}`,
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'post',
        roster,
        spice: nightClampSpice(post.spice, post.board),
        boards: [post.board],
        focus: { postId, postTitle: post.title, postContent: post.content, postTags: post.tags },
        ...(extra ? { extraPrompt: extra } : {}),
        alias: nightAlias(),
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'post', me, alias: nightAlias() });
    if (!parsed || !parsed.comments.length) throw new PhoneChatError('parse', '生成内容无法解析为新回复');
    if (currentPhoneStorageId() === owner) clearNightError();
    let added = 0;
    mutateNightOwned(owner, d => {
      const live = d.night;
      const target = live?.posts.find(p => p.id === postId);
      if (!live || !target) return;
      const anchor = getRoster().global.time || '';
      const before = target.comments.length;
      appendNightComments(target, parsed.comments.map(c => stampPost({ ...c, timeLabel: c.time || '刚刚' }, anchor)), live.me.alias);
      added = target.comments.length - before;
      const notes = parsed.comments
        .filter(c => c.name !== me && c.name !== live.me.alias)
        .filter((_c, i) => i < 2)
        .map(c => ({
          id: makeNightNotifyId(),
          type: 'reply' as const,
          author: c.name,
          content: c.text.slice(0, 40),
          postId,
          time: c.time || '',
          createdAt: Date.now(),
        }));
      if (target.byMe) addNightNotifications(live, notes);
    });
    return added;
  });
}

// ─── 舞台 ───

/** 刷新开台列表（3-6 个房间；正在开台/预告混排）。 */
export async function refreshNightLives(args: { extraHint?: string; focusNames?: string[]; rosterOverride?: RosterSnapshot } = {}): Promise<number> {
  const scope = nightScope('live');
  return withScope(scope, '开台列表生成', async () => {
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const data = readPhoneData();
    const night = readNightOf(data);
    const style = data.style || '';
    const triggerNames = pickNightNames(roster.contacts.map(c => c.name), triggerCount());
    const cast = castNamesFor(roster, triggerNames, triggerCount());
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const spice = nightClampSpice(3, 'backstage');
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'live',
      scope,
      triggerText: buildNightTriggerText({ names: triggerNames, storyText: stripWithContextConfig(readAiChatHistory(1)) }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice,
        boards: ['backstage'],
        chronicleBlocks: readChronicleDossierBlocks(cast, getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: cast,
        digest: nightLiveDigestLines(night.lives),
        readonlySection: readonlySectionOf(me),
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'live',
        roster,
        spice,
        boards: ['backstage'],
        ...(extra ? { extraPrompt: extra } : {}),
        alias: nightAlias(),
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'live', me, alias: nightAlias() });
    if (!parsed || !parsed.lives.length) throw new PhoneChatError('parse', '生成内容无法解析为开台列表');
    if (currentPhoneStorageId() === owner) clearNightError();
    const anchor = roster.global.time || '';
    mutateNightOwned(owner, d => {
      const live = ensureNightData(d);
      const fresh = parsed.lives.map(l => stampPost({
        ...l,
        spice: nightClampSpice(l.spice, 'backstage'),
        maxRound: liveRoundCap(),
        timeLabel: l.timeLabel || '刚刚',
      }, anchor));
      live.lives = mergeNightLives(live.lives, fresh);
      live.refreshedAt = Date.now();
    });
    return parsed.lives.length;
  });
}

/** 推进一次直播（1 段：台主台词 ≤4 + 弹幕 + 事件；私密房=1 对 1 进程）。 */
export async function advanceNightLive(liveId: string, args: { extraHint?: string; rosterOverride?: RosterSnapshot } = {}): Promise<{ lines: string[]; barrages: NightBarrage[]; heat: number; ended: boolean }> {
  const scope = nightScope('advance', liveId);
  return withScope(scope, '直播推进', async () => {
    const data = readPhoneData();
    const night = readNightOf(data);
    const live = night.lives.find(l => l.id === liveId);
    if (!live) throw new PhoneChatError('env', '直播间不存在');
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const style = data.style || '';
    const privateMode = live.privateEntered === true;
    const mode: NightMode = 'private';
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const personas = personasOf([live.streamer]);
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode,
      scope,
      triggerText: buildNightTriggerText({ names: [live.streamer], storyText: stripWithContextConfig(readAiChatHistory(1)), extra: live.title }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice: nightClampSpice(live.spice, 'backstage'),
        boards: ['backstage'],
        chronicleBlocks: readChronicleDossierBlocks([live.streamer], getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: [live.streamer],
        digest: live.rounds.slice(-3).map(r => r.streamerLines.join(' ')),
        ...(personas ? { personas } : {}),
        sceneSection: buildLiveSceneSection(live, night.me.alias || me, { privateMode }),
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode,
        roster,
        spice: nightClampSpice(live.spice, 'backstage'),
        boards: ['backstage'],
        focus: { liveId, streamer: live.streamer },
        ...(extra ? { extraPrompt: extra } : {}),
        alias: night.me.alias || me,
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'private', me, alias: night.me.alias || undefined });
    if (!parsed || !nightParseHasContent('private', parsed)) throw new PhoneChatError('parse', '生成内容无法解析为直播推进');
    if (currentPhoneStorageId() === owner) clearNightError();
    const anchor = roster.global.time || '';
    let ended = false;
    mutateNightOwned(owner, d => {
      const cur = d.night;
      const target = cur?.lives.find(l => l.id === liveId);
      if (!cur || !target) return;
      const round = {
        id: makeId('nr_'),
        at: Date.now(),
        timeLabel: anchor || '刚刚',
        streamerLines: parsed.lines.length ? parsed.lines : (parsed.reply ? [parsed.reply] : []),
        barrages: privateMode ? [] : parsed.barrages,
        heatDelta: parsed.heat,
        ...(privateMode ? { private: true } : {}),
      };
      appendNightRound(target, round);
      appendNightBarrage(target, round.barrages);
      target.heat += parsed.heat;
      target.viewers = Math.max(1, target.viewers + Math.round((nightPlausibleCount(String(round.id)) % 40) - 12));
      if (target.status === 'idle') target.status = 'live';
      if (target.round >= target.maxRound) {
        target.status = 'ended';
        ended = true;
      }
      cur.refreshedAt = Date.now();
    });
    return { lines: parsed.lines, barrages: parsed.barrages, heat: parsed.heat, ended };
  });
}

/** 观众/主角发弹幕（本地零 AI）。 */
export function sendNightBarrage(liveId: string, text: string): boolean {
  const body = text.trim().slice(0, 60);
  if (!body) return false;
  mutatePhoneData(d => {
    const live = d.night?.lives.find(l => l.id === liveId);
    if (!live) return;
    const me = d.night!.me.alias || nightFallbackAlias();
    const barrage = normalizeNightBarrage({ name: me, text: body, byMe: true, tint: nightTintOf(me) });
    if (barrage) {
      barrage.byMe = true;
      appendNightBarrage(live, [barrage]);
    }
    live.heat += 12;
  });
  return true;
}

/** 打赏（本地数值 flavor；同步打赏榜、热度、加码阶梯）。返回本单是否升级。 */
export function sendNightGift(liveId: string, giftId: string): { ok: boolean; upgraded: boolean; tier?: string } {
  const gift = NIGHT_GIFTS.find(g => g.id === giftId);
  if (!gift) return { ok: false, upgraded: false };
  let upgraded = false;
  let tier: string | undefined;
  mutatePhoneData(d => {
    const night = d.night;
    const live = night?.lives.find(l => l.id === liveId);
    if (!night || !live) return;
    const me = night.me.alias || nightFallbackAlias();
    night.me.coins = Math.max(0, night.me.coins - gift.coins);
    live.heat += gift.heat;
    addNightTip(live, me, gift.glyph, gift.heat);
    // 加码：把最新一单的 boost 抬到下一阶梯（口头 → 动作 → 专场）
    const mine = [...live.orders].reverse().find(o => o.byMe);
    if (mine && mine.tier !== '专场') {
      mine.boost += gift.heat;
      const nextThreshold = NIGHT_BOOST_STEPS[mine.tier === '口头' ? 0 : 1] ?? Number.MAX_SAFE_INTEGER;
      if (mine.boost >= nextThreshold) {
        mine.tier = mine.tier === '口头' ? '动作' : '专场';
        upgraded = true;
        tier = mine.tier;
        if (mine.tier === '专场') live.privateAvailable = true;
      }
    }
    const barrage = normalizeNightBarrage({ name: me, text: `${gift.glyph} ${gift.name}`, byMe: true, tint: nightTintOf(me) });
    if (barrage) {
      barrage.byMe = true;
      appendNightBarrage(live, [barrage]);
    }
  });
  return { ok: true, upgraded, ...(tier ? { tier } : {}) };
}

/** 点单（1 次 AI 调用；按档案底线判定拒绝；拒绝时退款一半硬币并记「被拒」）。 */
export async function submitNightOrder(liveId: string, text: string, args: { extraHint?: string; rosterOverride?: RosterSnapshot } = {}): Promise<{ accepted: boolean; rejectReason?: string; tier: string; reply?: string; lines: string[] }> {
  const order = text.trim().slice(0, 40);
  if (!order) throw new PhoneChatError('env', '点单内容不能为空');
  const scope = nightScope('order', liveId);
  return withScope(scope, '点单响应', async () => {
    const data = readPhoneData();
    const night = readNightOf(data);
    const live = night.lives.find(l => l.id === liveId);
    if (!live) throw new PhoneChatError('env', '直播间不存在');
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const style = data.style || '';
    const alias = night.me.alias || nightFallbackAlias();
    const personas = personasOf([live.streamer]);
    const topPrivilege = nightTopPrivilege(live, alias);
    const prevTier = [...live.orders].reverse().find(o => o.byMe)?.tier || '口头';
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'order',
      scope,
      triggerText: buildNightTriggerText({ names: [live.streamer], storyText: stripWithContextConfig(readAiChatHistory(1)), extra: order }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice: nightClampSpice(live.spice, 'backstage'),
        boards: ['backstage'],
        chronicleBlocks: readChronicleDossierBlocks([live.streamer], getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: [live.streamer],
        ...(personas ? { personas } : {}),
        sceneSection: [
          buildLiveSceneSection(live, alias),
          '■ 本次点单',
          `下单人：${alias}（主角在本应用的马甲名）`,
          `点单内容：${order}`,
          `当前加码档：${prevTier}`,
          topPrivilege ? `★ 该下单人是本场打赏榜第一 → 榜一特权：本单必不拒绝，且台词里要用「${alias}」这个专属称呼` : '',
        ].filter(Boolean).join('\n'),
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'order',
        roster,
        spice: nightClampSpice(live.spice, 'backstage'),
        boards: ['backstage'],
        focus: { liveId, streamer: live.streamer, orderText: order, tier: prevTier },
        ...(extra ? { extraPrompt: extra } : {}),
        alias,
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'order', me, alias });
    if (!parsed || !nightParseHasContent('order', parsed)) throw new PhoneChatError('parse', '生成内容无法解析为点单响应');
    if (currentPhoneStorageId() === owner) clearNightError();
    const accepted = parsed.accepted !== false;
    const rejectReason = accepted ? undefined : (parsed.rejectReason || '今天不行，下次吧');
    const anchor = roster.global.time || '';
    mutateNightOwned(owner, d => {
      const cur = d.night;
      const target = cur?.lives.find(l => l.id === liveId);
      if (!cur || !target) return;
      const record: NightOrder = {
        id: makeNightOrderId(),
        byMe: true,
        from: alias,
        text: order,
        spice: nightClampSpice(3, 'backstage'),
        tier: prevTier,
        accepted,
        ...(rejectReason ? { rejectReason } : {}),
        boost: 0,
        coins: accepted ? 0 : 2,
        at: Date.now(),
        timeLabel: anchor || '刚刚',
        ...(parsed.reply ? { reply: parsed.reply } : {}),
      };
      appendNightOrders(target, [record]);
      if (!accepted) {
        cur.me.coins = Math.max(0, cur.me.coins - 2);
        cur.me.rejections = [...cur.me.rejections, { peer: target.streamer, reason: rejectReason || '', at: Date.now() }].slice(-20);
      }
      appendNightRound(target, {
        id: makeId('nr_'),
        at: Date.now(),
        timeLabel: anchor || '刚刚',
        streamerLines: parsed.lines.length ? parsed.lines : (parsed.reply ? [parsed.reply] : []),
        barrages: parsed.barrages,
        heatDelta: parsed.heat,
        event: accepted
          ? { type: 'order', name: alias, text: order }
          : { type: 'reject', name: alias, text: rejectReason || '' },
      });
      appendNightBarrage(target, parsed.barrages);
      target.heat += parsed.heat;
      if (target.status === 'idle') target.status = 'live';
      // 通知：被点名/被拒（隐身时不生成）
      if (cur.me.stealth === false) {
        addNightNotifications(cur, [{
          id: makeNightNotifyId(),
          type: accepted ? 'order' : 'reject',
          author: target.streamer,
          content: accepted ? `回应了点单：${parsed.reply || parsed.lines[0] || order}`.slice(0, 40) : `拒绝了点单：${rejectReason}`.slice(0, 40),
          liveId: target.id,
          time: anchor || '刚刚',
          createdAt: Date.now(),
        }]);
      }
    });
    return { accepted, ...(rejectReason ? { rejectReason } : {}), tier: prevTier, ...(parsed.reply ? { reply: parsed.reply } : {}), lines: parsed.lines };
  });
}

/** 进私密房（本地门槛：热度达标 / 已打赏进榜 / 已关注）。 */
export function enterNightPrivateRoom(liveId: string): { ok: boolean; reason?: string } {
  let ok = false;
  let reason = '门槛未达：先在房间里打赏一次或关注台主';
  mutatePhoneData(d => {
    const night = d.night;
    const live = night?.lives.find(l => l.id === liveId);
    if (!night || !live) return;
    const me = night.me.alias || nightFallbackAlias();
    const inRank = live.rank.some(r => r.name === me);
    const followed = night.me.follows.includes(live.streamer);
    if (!live.privateAvailable && !inRank && !followed && live.heat < 2000) return;
    live.privateEntered = true;
    ok = true;
    reason = '';
  });
  return ok ? { ok } : { ok, reason };
}

/** 退出私密房。 */
export function exitNightPrivateRoom(liveId: string): void {
  mutatePhoneData(d => {
    const live = d.night?.lives.find(l => l.id === liveId);
    if (live) live.privateEntered = false;
  });
}

/** 结束本轮（本地状态机：live → ended）。 */
export function endNightLive(liveId: string): void {
  mutatePhoneData(d => {
    const live = d.night?.lives.find(l => l.id === liveId);
    if (live && live.status !== 'ended') live.status = 'ended';
  });
}

/** 主角自己开台（本地创建，马甲署名；封面可描述生图）。 */
export function startMyNightLive(title: string, coverDesc: string, spice: NightSpice = NIGHT_DEFAULT_SPICE): string {
  const liveId = makeNightLiveId();
  mutatePhoneData(d => {
    const night = ensureNightData(d);
    const live: NightLive = {
      id: liveId,
      streamer: night.me.alias || nightFallbackAlias(),
      byMe: true,
      title: title.trim().slice(0, 30) || '深夜随便聊聊',
      tags: [],
      spice: nightClampSpice(spice, 'backstage'),
      coverDesc: coverDesc.trim(), // 生图文字不截断
      heat: 0,
      viewers: 0,
      status: 'live',
      round: 0,
      maxRound: liveRoundCap(),
      barrage: [],
      rounds: [],
      rank: [],
      orders: [],
      timeLabel: '刚刚',
      createdAt: Date.now(),
    };
    night.lives = mergeNightLives(night.lives, [live]);
    night.me.myLiveId = liveId;
  });
  return liveId;
}

// ─── 搭话（私信） ───

/** 打开/建立与某人的搭话会话（本地，零 AI）。 */
export function ensureNightDm(peer: string, opts: { sourceLabel?: string; distanceLabel?: string } = {}): string {
  const name = peer.trim().slice(0, 40);
  if (!name) throw new PhoneChatError('env', '对方不存在');
  const existing = readPhoneDataRef().night?.dms.find(d => d.peer === name);
  if (existing) return existing.id;
  const dmId = makeNightDmId();
  mutatePhoneData(d => {
    const night = ensureNightData(d);
    const dm: NightDm = {
      id: dmId,
      peer: name,
      unread: 0,
      msgs: [],
      updatedAt: Date.now(),
      createdAt: Date.now(),
      ...(opts.sourceLabel ? { sourceLabel: opts.sourceLabel } : {}),
      ...(opts.distanceLabel ? { distanceLabel: opts.distanceLabel } : {}),
    };
    night.dms = mergeNightDms(night.dms, [dm]);
  });
  return dmId;
}

/** 主角发一条消息（本地即时上屏，零 AI；图片消息走统一选图）。 */
export function sendNightDmMessage(peer: string, msg: { text?: string; imageDesc?: string; imagePath?: string }): void {
  const text = (msg.text || '').trim().slice(0, 300);
  const imageDesc = (msg.imageDesc || '').trim(); // 生图文字不截断
  if (!text && !imageDesc) throw new PhoneChatError('env', '内容不能为空');
  ensureNightDm(peer);
  mutatePhoneData(d => {
    const night = d.night;
    const dm = night?.dms.find(x => x.peer === peer);
    if (!night || !dm) return;
    const message: NightDmMsg = imageDesc
      ? {
        id: makeNightMsgId(),
        from: 'me',
        type: 'image',
        image: { desc: imageDesc, ...(msg.imagePath ? { path: msg.imagePath, status: 'ready' as const } : {}), reveal: 0 },
        ts: Date.now(),
        timeLabel: night_myTime(),
      }
      : { id: makeNightMsgId(), from: 'me', type: 'text', text, ts: Date.now(), timeLabel: night_myTime() };
    dm.msgs.push(message);
    dm.updatedAt = message.ts;
  });
  // L9 成就：玩家亲手发私信成功（三个入口共用本函数；AI 搭话走 pushNightDm，不经过此处）
  emitAch('phone_night_dm_sent', { type: imageDesc ? 'image' : 'text' });
}

function night_myTime(): string {
  try {
    return getRoster().global.time || '刚刚';
  } catch (_e) {
    return '刚刚';
  }
}

/** 推进一步搭话（1 次 AI 调用：对方 2-4 条回复；可带图/礼物回执）。
 *  回复按真人节奏逐条落库（`onDelivered` 供渲染层逐条上屏）；终止时丢弃未送达部分。 */
export async function pushNightDm(
  peer: string,
  args: { extraHint?: string; rosterOverride?: RosterSnapshot; seed?: string; onDelivered?: (msg: NightDmMsg) => void } = {},
): Promise<number> {
  const scope = nightScope('dm', peer);
  return withScope(scope, '搭话回复', async () => {
    const data = readPhoneData();
    const night = readNightOf(data);
    const dm = night.dms.find(d => d.peer === peer);
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const style = data.style || '';
    const personas = personasOf([peer]);
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const spice = nightClampSpice(personas?.[0]?.spiceMax ?? 2, 'nighttalk');
    const sceneSection = dm
      ? buildDmSceneSection(dm, me, personas?.[0] ?? null)
      : `■ 搭话场景\n对方：${peer}\n（第一条消息：${(args.seed || '在某个帖子里看到你，就点进来了').slice(0, 80)}）`;
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'dm',
      scope,
      triggerText: buildNightTriggerText({ names: [peer], storyText: stripWithContextConfig(readAiChatHistory(1)), extra: dm?.msgs.slice(-2).map(m => m.text || '').join(' ') }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice,
        boards: ['nighttalk'],
        chronicleBlocks: readChronicleDossierBlocks([peer], getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: [peer],
        ...(personas ? { personas } : {}),
        sceneSection,
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'dm',
        roster,
        spice,
        boards: ['nighttalk'],
        focus: { dmPeer: peer },
        ...(extra ? { extraPrompt: extra } : {}),
        alias: night.me.alias || me,
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'dm', me, alias: night.me.alias || undefined });
    if (!parsed || !parsed.msgs.length) throw new PhoneChatError('parse', '生成内容无法解析为搭话回复');
    if (currentPhoneStorageId() === owner) clearNightError();
    const anchor = getRoster().global.time || '';
    const fresh = parsed.msgs.map(m => ({
      ...m,
      from: 'peer' as const,
      timeLabel: anchor || '刚刚',
    }));
    let added = 0;
    // 逐条送达（真人节奏）：每落一条就让渲染层上屏一次；终止或切聊天时丢弃剩余消息。
    for (const msg of fresh) {
      await sleep(revealDelay(msg.text || ''));
      if (!_busy.has(scope)) return added;
      const appended = mutateNightOwned(owner, d => {
        const cur = d.night;
        if (!cur) return false;
        let target = cur.dms.find(x => x.peer === peer);
        if (!target) {
          target = { id: makeNightDmId(), peer, msgs: [], unread: 0, updatedAt: Date.now(), createdAt: Date.now() };
          cur.dms = mergeNightDms(cur.dms, [target]);
          target = cur.dms.find(x => x.peer === peer)!;
        }
        if (!target.msgs.some(m => m.id === msg.id)) target.msgs.push(msg);
        target.msgs.sort((a, b) => a.ts - b.ts);
        target.msgs = target.msgs.slice(-500);
        target.updatedAt = Date.now();
        return true;
      });
      if (!appended) return added;
      added++;
      args.onDelivered?.(msg);
    }
    // 会话级元数据与未读通知整批只写一次（逐条写会重复通知）。
    mutateNightOwned(owner, d => {
      const cur = d.night;
      const target = cur?.dms.find(x => x.peer === peer);
      if (!cur || !target) return;
      if (parsed.online !== undefined) target.online = parsed.online;
      if (parsed.sourceLabel) target.sourceLabel = parsed.sourceLabel;
      if (parsed.distanceLabel) target.distanceLabel = parsed.distanceLabel;
      if (cur.me.stealth === false) {
        addNightNotifications(cur, [{
          id: makeNightNotifyId(),
          type: 'dm',
          author: peer,
          content: (fresh[0]?.text || '发来一条消息').slice(0, 40),
          dmId: target.id,
          time: anchor || '刚刚',
          createdAt: Date.now(),
        }]);
      }
      cur.refreshedAt = Date.now();
    });
    return added;
  });
}

/** 对方主动发起搭话（本地：从帖子/直播间作者发起，带来源标签；随后用户点「推进」触发 AI）。 */
export function openNightDmFrom(peer: string, sourceLabel: string, seedText?: string): string {
  const dmId = ensureNightDm(peer, { sourceLabel });
  if (seedText?.trim()) {
    mutatePhoneData(d => {
      const dm = d.night?.dms.find(x => x.id === dmId);
      if (!dm || dm.msgs.length) return;
      dm.msgs.push({ id: makeNightMsgId(), from: 'peer', type: 'text', text: seedText.trim().slice(0, 120), ts: Date.now(), timeLabel: night_myTime() });
      dm.updatedAt = Date.now();
      dm.unread = 1;
    });
  }
  return dmId;
}

// ─── 约会进程（N4） ───

/** 发约见卡（本地：写入一条 date 消息 + 建立约会记录，status='planned'）。 */
export function proposeNightDate(peer: string, place: string, note: string): string {
  const active = nightActiveDate(readNightOf(readPhoneData()).me);
  if (active) throw new PhoneChatError('env', `已经有一个进行中的约（与${active.peer}），先收尾或结束它`);
  const dateId = makeNightDateId();
  mutatePhoneData(d => {
    const night = ensureNightData(d);
    const dmId = ensureNightDmInData(night, peer);
    const record: NightDate = {
      id: dateId,
      peer,
      place: place.trim().slice(0, 40),
      note: note.trim().slice(0, 120),
      status: 'planned',
      step: 0,
      maxStep: 6,
      nodes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    night.me.dates = [...night.me.dates, record].slice(-20);
    const dm = night.dms.find(x => x.id === dmId);
    if (dm) {
      dm.msgs.push({ id: makeNightMsgId(), from: 'me', type: 'date', dateId, text: `${place || '见面'}｜${note || '今晚有空吗'}`, ts: Date.now(), timeLabel: night_myTime() });
      dm.updatedAt = Date.now();
    }
  });
  return dateId;
}

function ensureNightDmInData(night: NightData, peer: string): string {
  const existing = night.dms.find(d => d.peer === peer);
  if (existing) return existing.id;
  const dm: NightDm = { id: makeNightDmId(), peer, msgs: [], unread: 0, updatedAt: Date.now(), createdAt: Date.now() };
  night.dms = mergeNightDms(night.dms, [dm]);
  return night.dms.find(d => d.peer === peer)!.id;
}

/** 推进约会一个节点（1 次 AI 调用；上限 6 节点；可选记录本次两选）。 */
export async function advanceNightDate(dateId: string, args: { choicePicked?: number; extraHint?: string; rosterOverride?: RosterSnapshot } = {}): Promise<{ step: number; done: boolean; scene: string; options: string[] }> {
  const scope = nightScope('date', dateId);
  return withScope(scope, '约会推进', async () => {
    const data = readPhoneData();
    const night = readNightOf(data);
    const date = night.me.dates.find(x => x.id === dateId);
    if (!date) throw new PhoneChatError('env', '约会记录不存在');
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const style = data.style || '';
    const personas = personasOf([date.peer]);
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const spice = nightClampSpice(personas?.[0]?.spiceMax ?? 2, 'nighttalk');
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'date',
      scope,
      triggerText: buildNightTriggerText({ names: [date.peer], storyText: stripWithContextConfig(readAiChatHistory(1)), extra: `${date.place} ${date.note}` }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice,
        boards: ['nighttalk'],
        chronicleBlocks: readChronicleDossierBlocks([date.peer], getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: [date.peer],
        ...(personas ? { personas } : {}),
        sceneSection: buildDateSceneSection(date, personas?.[0] ?? null),
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'date',
        roster,
        spice,
        boards: ['nighttalk'],
        focus: { dmPeer: date.peer, dateId },
        ...(extra ? { extraPrompt: extra } : {}),
        alias: night.me.alias || me,
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'date', me, alias: night.me.alias || undefined });
    if (!parsed?.dateNode) throw new PhoneChatError('parse', '生成内容无法解析为约会节点');
    if (currentPhoneStorageId() === owner) clearNightError();
    let step = 0;
    let done = false;
    let scene = '';
    let options: string[] = [];
    mutateNightOwned(owner, d => {
      const cur = d.night;
      const target = cur?.me.dates.find(x => x.id === dateId);
      if (!cur || !target) return;
      // 先把玩家上一节点的选择记下（选择改变下一节点基调）
      if (args.choicePicked !== undefined) {
        const lastIdx = target.nodes.length - 1;
        if (lastIdx >= 0) pickNightDateChoice(target, lastIdx, args.choicePicked);
      }
      const node = parsed.dateNode!;
      const anchor = getRoster().global.time || '';
      applyNightDateNode(target, {
        id: node.id,
        at: Date.now(),
        scene: node.scene,
        lines: node.lines,
        ...(node.choice ? { choice: { options: node.choice.options } } : {}),
        spice: nightClampSpice(node.spice, 'nighttalk'),
        timeLabel: node.timeLabel || anchor || '刚刚',
        ...(node.storyStamp ? { storyStamp: node.storyStamp } : {}),
      });
      if (node.place) target.place = node.place;
      if (node.note) target.note = node.note;
      step = target.step;
      done = target.status === 'done';
      scene = node.scene;
      options = node.choice?.options || [];
      cur.refreshedAt = Date.now();
    });
    return { step, done, scene, options };
  });
}

/** 暂停/继续约会（本地状态机）。 */
export function setNightDateStatus(dateId: string, status: 'ongoing' | 'paused' | 'done'): void {
  mutatePhoneData(d => {
    const date = d.night?.me.dates.find(x => x.id === dateId);
    if (!date) return;
    date.status = status;
    date.updatedAt = Date.now();
  });
}

// ─── 角色档案卡（N5） ───

/** 生成角色档案卡（1 次调用；已存在时返回缓存，force=true 重新生成）。 */
export async function runNightPersona(name: string, args: { force?: boolean; rosterOverride?: RosterSnapshot } = {}): Promise<boolean> {
  const cached = readPhoneDataRef().night?.personas?.[name];
  if (cached && !args.force) return true;
  const scope = nightScope('persona', name);
  return withScope(scope, '档案卡生成', async () => {
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const data = readPhoneData();
    const night = readNightOf(data);
    const style = data.style || '';
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'persona',
      scope,
      triggerText: buildNightTriggerText({ names: [name], storyText: '' }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice: nightClampSpice(3, 'nighttalk'),
        boards: ['nighttalk'],
        chronicleBlocks: readChronicleDossierBlocks([name], getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: [name],
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'persona',
        roster,
        spice: nightClampSpice(3, 'nighttalk'),
        boards: ['nighttalk'],
        focus: { streamer: name },
        alias: night.me.alias || me,
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'persona', me, alias: night.me.alias || undefined });
    if (!parsed?.persona) throw new PhoneChatError('parse', '生成内容无法解析为角色档案卡');
    if (currentPhoneStorageId() === owner) clearNightError();
    mutateNightOwned(owner, d => {
      const night = ensureNightData(d);
      night.personas = { ...(night.personas || {}), [name]: { ...parsed.persona!, name } };
    });
    return true;
  });
}

/** 本地兜底档案卡（AI 不可用或未生成时，用 roster 数据拼一个最小卡）。 */
export function nightPersonaFallback(name: string): NonNullable<NightData['personas']>[string] {
  const roster = getRoster();
  const contact = roster.contacts.find(c => c.name === name);
  const body = roster.bodyData[name];
  return {
    name,
    body: {
      ...(body?.heightWeight ? { height: body.heightWeight.split(/[/／]/)[0] || undefined } : {}),
      ...(body?.measure ? { bust: body.measure } : {}),
    },
    ...(contact?.appearance ? { appearance: contact.appearance } : {}),
    likes: [],
    limits: [],
    acceptance: 2,
    spiceMax: 2,
    posts: nightPlausibleCount(`p|${name}`) % 400,
    works: nightPlausibleCount(`w|${name}`) % 90,
    createdAt: 0,
  };
}

/** 读档案卡（无则 null；渲染层据此决定是否触发生成）。 */
export function readNightPersona(name: string): NonNullable<NightData['personas']>[string] | null {
  return readPhoneDataRef().night?.personas?.[name] || null;
}

// ─── 专题页「他们怎么谈论你」（N6） ───

/** 生成/刷新「他们怎么谈论你」（1 次调用；聚合目击/议论/喊话三类帖）。 */
export async function refreshNightAboutMe(args: { extraHint?: string; focusNames?: string[]; rosterOverride?: RosterSnapshot } = {}): Promise<number> {
  const scope = nightScope('about');
  return withScope(scope, '关于我生成', async () => {
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const data = readPhoneData();
    const night = readNightOf(data);
    const style = data.style || '';
    const triggerNames = pickNightNames(roster.contacts.map(c => c.name), triggerCount());
    const cast = castNamesFor(roster, triggerNames, triggerCount());
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const spice = nightClampSpice(NIGHT_DEFAULT_SPICE, 'nighttalk');
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'aboutMe',
      scope,
      triggerText: buildNightTriggerText({ names: triggerNames, storyText: stripWithContextConfig(readAiChatHistory(1)) }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice,
        boards: pickBoards(undefined, night),
        chronicleBlocks: readChronicleDossierBlocks(cast, getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: cast,
        digest: nightDigestLines(night.about?.items || []),
        readonlySection: readonlySectionOf(me),
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'aboutMe',
        roster,
        spice,
        boards: night.boards.map(b => b.id),
        ...(extra ? { extraPrompt: extra } : {}),
        alias: night.me.alias || me,
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'aboutMe', me, alias: night.me.alias || undefined });
    if (!parsed || !parsed.posts.length) throw new PhoneChatError('parse', '生成内容无法解析为关于我的内容');
    if (currentPhoneStorageId() === owner) clearNightError();
    const anchor = roster.global.time || '';
    const items = parsed.posts
      .map(p => ({ ...p, kind: 'about' as const }))
      .map(p => stampPost(p, anchor))
      .map(p => ({ ...p, spice: nightClampSpice(p.spice, p.board) }));
    mutateNightOwned(owner, d => {
      const night2 = ensureNightData(d);
      night2.about = { items: mergeNightPosts(night2.about?.items || [], items, nightMaxPosts()), refreshedAt: Date.now() };
      night2.refreshedAt = Date.now();
    });
    return items.length;
  });
}

/** 前端过滤已有命中（首屏不空；零 AI）。 */
export function readNightAbout(): NightPost[] {
  return readNightDataRef().about?.items || [];
}

function readNightDataRef(): NightData {
  return readPhoneDataRef().night || { schema: 2, boards: [], posts: [], lives: [], dms: [], notifications: [], me: { alias: '', level: 1, coins: 0, follows: [], favorites: [], dates: [], rejections: [] }, refreshedAt: 0 };
}

// ─── 委托（N7） ───

/** 生成委托应征（1 次调用：3-6 条应征）。 */
export async function runNightCommissionEntries(postId: string, args: { extraHint?: string; rosterOverride?: RosterSnapshot } = {}): Promise<number> {
  const scope = nightScope('commission', postId);
  return withScope(scope, '委托应征生成', async () => {
    const data = readPhoneData();
    const night = readNightOf(data);
    const post = night.posts.find(p => p.id === postId);
    if (!post?.commission) throw new PhoneChatError('env', '该帖不是委托帖');
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const style = data.style || '';
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const spice = nightClampSpice(post.commission.spiceWanted, post.board);
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'commission',
      scope,
      triggerText: buildNightTriggerText({ names: post.author === me ? [] : [post.author], storyText: stripWithContextConfig(readAiChatHistory(1)), extra: post.commission.want }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice,
        boards: [post.board],
        chronicleBlocks: '',
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: castNamesFor(roster, [], triggerCount()),
        digest: (post.entries || []).map(e => `${e.author}：${e.text.slice(0, 20)}`),
        sceneSection: `■ 委托内容\n${post.author} 悬赏：${post.commission.want}\n期望尺度：${post.commission.spiceWanted}/3　期望标签：${post.commission.tags.join('、') || '不限'}\n悬赏：${post.commission.reward || '（未写）'}`,
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'commission',
        roster,
        spice,
        boards: [post.board],
        focus: { postId, commissionWant: post.commission.want },
        ...(extra ? { extraPrompt: extra } : {}),
        alias: night.me.alias || me,
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'commission', me, alias: night.me.alias || undefined });
    if (!parsed || !parsed.entries.length) throw new PhoneChatError('parse', '生成内容无法解析为委托应征');
    if (currentPhoneStorageId() === owner) clearNightError();
    let added = 0;
    mutateNightOwned(owner, d => {
      const live = d.night;
      const target = live?.posts.find(p => p.id === postId);
      if (!live || !target) return;
      const entries = parsed.entries.map(e => ({ ...e, id: e.id || makeNightEntryId(), spice: nightClampSpice(e.spice, target.board) }));
      const before = target.entries?.length || 0;
      target.entries = [...(target.entries || []), ...entries].slice(-12);
      added = (target.entries?.length || 0) - before;
      if (live.me.stealth === false) {
        addNightNotifications(live, entries.slice(0, 2).map(e => ({
          id: makeNightNotifyId(),
          type: 'entry' as const,
          author: e.author,
          content: e.text.slice(0, 40),
          postId,
          time: '刚刚',
          createdAt: Date.now(),
        })));
      }
    });
    return added;
  });
}

/** 采纳某条应征（本地动作；同帖只允许一条 adopted）。 */
export function adoptNightEntry(postId: string, entryId: string): boolean {
  let ok = false;
  mutatePhoneData(d => {
    const post = d.night?.posts.find(p => p.id === postId);
    if (!post?.entries) return;
    post.adoptedEntryId = entryId;
    for (const entry of post.entries) entry.adopted = entry.id === entryId;
    ok = true;
  });
  return ok;
}

// ─── 求解锁（N2 consent 门槛） ───

/** 求解锁：本地追加一条求解锁评论 + 计数 +1，随后 1 次 AI 调用让作者授权。 */
export async function requestNightUnlock(postId: string, imageIndex: number, args: { extraHint?: string; rosterOverride?: RosterSnapshot } = {}): Promise<{ grant: boolean; reply?: string }> {
  const scope = nightScope('unlock', postId);
  return withScope(scope, '求解锁', async () => {
    const data = readPhoneData();
    const night = readNightOf(data);
    const post = night.posts.find(p => p.id === postId);
    if (!post) throw new PhoneChatError('env', '帖子不存在或已沉底');
    const image = post.images[imageIndex];
    if (!image) throw new PhoneChatError('env', '这张图不存在');
    if (!image.unlock?.consent) throw new PhoneChatError('env', '这张图不需要作者同意');
    if (image.unlocked) return { grant: true };
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const alias = night.me.alias || nightFallbackAlias();
    const style = data.style || '';
    const anchor = roster.global.time || '';
    // 本地部分：求解锁留言 + 计数（AI 失败也已留下痕迹，符合"求解锁是互动"的设计）
    mutatePhoneData(d => {
      const target = d.night?.posts.find(p => p.id === postId);
      if (!target) return;
      const comment = normalizeNightCommentInput({ name: alias, text: `求个解锁，私信我？`, time: anchor || '刚刚' });
      if (comment) {
        comment.name = alias;
        appendNightComments(target, [comment], alias);
      }
      target.unlockRequests += 1;
      const img = target.images[imageIndex];
      if (img) img.unlock = { ...(img.unlock || {}), consent: true };
    });
    const extra = mergeOneShotHint(getPhoneSettings().extraPrompt, args.extraHint);
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'unlock',
      scope,
      triggerText: buildNightTriggerText({ names: [post.author], storyText: stripWithContextConfig(readAiChatHistory(1)), extra: image.desc.slice(0, 40) }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice: nightClampSpice(post.spice, post.board),
        boards: [post.board],
        chronicleBlocks: readChronicleDossierBlocks([post.author], getPhoneSettings().summaryCount),
        storyText: stripWithContextConfig(readAiChatHistory(storyCount())),
        castNames: [post.author],
        sceneSection: `■ 求解锁场景\n发帖人：${post.author}　帖子：${post.title || post.content.slice(0, 30)}\n这张图的画面描述：${image.desc}\n当前互动：帖子获赞 ${post.likes}、收藏 ${post.collects}、已有 ${post.unlockRequests} 人求解锁\n主角的求解锁留言：「求个解锁，私信我？」（署名马甲「${alias}」）`,
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'unlock',
        roster,
        spice: nightClampSpice(post.spice, post.board),
        boards: [post.board],
        focus: { postId, streamer: post.author, unlockImageDesc: image.desc },
        ...(extra ? { extraPrompt: extra } : {}),
        alias,
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'unlock', me, alias });
    if (!parsed) throw new PhoneChatError('parse', '生成内容无法解析为解锁回应');
    if (currentPhoneStorageId() === owner) clearNightError();
    const grant = parsed.grant === true;
    mutateNightOwned(owner, d => {
      const target = d.night?.posts.find(p => p.id === postId);
      if (!target) return;
      const img = target.images[imageIndex];
      if (img && grant) img.unlocked = true;
      const comments = parsed.comments.map(c => ({ ...c, time: c.time || anchor || '刚刚' }));
      if (comments.length) appendNightComments(target, comments, alias);
      if (grant) target.collects += 1;
    });
    return { grant, ...(parsed.reply ? { reply: parsed.reply } : {}) };
  });
}

// ─── 马甲生成（alias） ───

/** 生成马甲（1 次调用；仅当未生成过或用户点重新生成时调用）。 */
export async function runNightAlias(args: { force?: boolean; rosterOverride?: RosterSnapshot } = {}): Promise<string | null> {
  const existing = readPhoneDataRef().night?.me;
  if (existing?.alias && !args.force) return existing.alias;
  const scope = nightScope('alias');
  if (_busy.has(scope)) return null;
  try {
    assertNightReady();
  } catch (_e) {
    return null; // 马甲是装饰性前置：API 不可用时静默跳过，用兜底名
  }
  _busy.add(scope);
  try {
    const roster = args.rosterOverride ?? getRoster();
    const me = roster.protagonistName;
    const data = readPhoneData();
    const style = data.style || '';
    const owner = currentPhoneStorageId(); // W1:聊天归属快照(生成期间切聊天 → 整轮静默丢弃,不写新聊天)
    const raw = await generateNightRaw({
      mode: 'alias',
      scope,
      triggerText: buildNightTriggerText({ names: [], storyText: '' }),
      dossierText: buildNightDossierText({
        promptOverrides: getPhoneSettings().nightPrompts,
        roster,
        spice: nightClampSpice(NIGHT_DEFAULT_SPICE, 'nighttalk'),
        boards: ['nighttalk'],
        chronicleBlocks: '',
        storyText: '',
        castNames: [],
        style,
      }),
      instruction: buildNightInstruction({
        promptOverrides: getPhoneSettings().nightPrompts,
        mode: 'alias',
        roster,
        spice: nightClampSpice(NIGHT_DEFAULT_SPICE, 'nighttalk'),
        boards: ['nighttalk'],
        alias: '',
        style,
      }),
    });
    const parsed = parseNightReply(raw, { mode: 'alias', me });
    if (!parsed?.alias) return null;
    const name = parsed.alias.alias;
    if (roster.contacts.some(c => c.name === name) || name === me) return null;
    mutateNightOwned(owner, d => {
      const night = ensureNightData(d);
      night.me.alias = name;
      if (parsed.alias?.signature) night.me.aliasEdited = night.me.aliasEdited === true;
    });
    return name;
  } catch (_e) {
    return null;
  } finally {
    _busy.delete(scope);
  }
}

// ─── 本地动作（零 AI） ───

/** 点赞/取消点赞（本地计数 ±1）。 */
export function toggleNightLike(postId: string): boolean {
  let liked = false;
  mutatePhoneData(d => {
    const post = d.night?.posts.find(p => p.id === postId)
      || d.night?.about?.items.find(p => p.id === postId);
    if (!post) return;
    liked = !post.likedByMe;
    post.likes = Math.max(0, post.likes + (liked ? 1 : -1));
    post.likedByMe = liked || undefined;
  });
  return liked;
}

/** 收藏/取消（可入私密收藏夹 N8）。 */
export function toggleNightCollect(postId: string, favPrivate = false): boolean {
  let collected = false;
  mutatePhoneData(d => {
    const night = d.night;
    if (!night) return;
    const post = night.posts.find(p => p.id === postId) || night.about?.items.find(p => p.id === postId);
    if (!post) return;
    const wasFav = isNightFavorited(night.me, postId);
    collected = !post.collectedByMe;
    post.collects = Math.max(0, post.collects + (collected ? 1 : -1));
    post.collectedByMe = collected || undefined;
    if (collected) {
      if (favPrivate) post.collectPrivate = true;
      if (!wasFav) toggleNightFavorite(night.me, postId, favPrivate);
    } else {
      delete post.collectPrivate;
      if (wasFav) toggleNightFavorite(night.me, postId, favPrivate);
    }
  });
  return collected;
}

/** 关注/取关（本地；关注作者新帖会进通知）。 */
export function toggleNightAuthorFollow(name: string): boolean {
  let followed = false;
  mutatePhoneData(d => {
    const night = d.night;
    if (!night) return;
    followed = toggleNightFollow(night.me, name);
  });
  return followed;
}

/** 隐身浏览开关（默认开）。 */
export function setNightStealth(on: boolean): void {
  mutatePhoneData(d => {
    const night = ensureNightData(d);
    night.me.stealth = on;
  });
}

/** 删除帖子（连带通知/收藏/悬空预告帖）。 */
export function deleteNightPost(postId: string): number {
  let removed = 0;
  mutatePhoneData(d => {
    const night = d.night;
    if (!night) return;
    removed = deleteNightItems(night, [postId]);
  });
  return removed;
}

/** 删除一条评论（楼中楼子回复连带）。 */
export function deleteNightPostComment(postId: string, index: number): number {
  let removed = 0;
  mutatePhoneData(d => {
    const night = d.night;
    if (!night) return;
    removed = deleteNightComment(night, postId, index);
  });
  return removed;
}

/** 删除直播间（连带其预告帖）。 */
export function deleteNightLive(liveId: string): number {
  let removed = 0;
  mutatePhoneData(d => {
    const night = d.night;
    if (!night) return;
    removed = deleteNightItems(night, [liveId]);
  });
  return removed;
}

/** 删除搭话会话（连带其约会与通知）。 */
export function deleteNightConversation(dmId: string): boolean {
  let ok = false;
  mutatePhoneData(d => {
    const night = d.night;
    if (!night) return;
    ok = deleteNightDm(night, dmId);
  });
  return ok;
}

/** 删除搭话会话里的一条消息（本地；图片文件与相册条目不动）。 */
export function deleteNightDmMessage(dmId: string, msgId: string): boolean {
  let ok = false;
  mutatePhoneData(d => {
    const dm = d.night?.dms.find(x => x.id === dmId);
    if (!dm) return;
    const next = dm.msgs.filter(m => m.id !== msgId);
    ok = next.length !== dm.msgs.length;
    if (ok) dm.msgs = next;
  });
  return ok;
}

/** 编辑搭话会话里的一条文字消息（就地改写 text，不动 ts——改写≠新消息，排序/相对时间不变）。 */
export function editNightDmMessage(dmId: string, msgId: string, text: string): boolean {
  const next = text.trim().slice(0, 300);
  if (!next) return false;
  let ok = false;
  mutatePhoneData(d => {
    const dm = d.night?.dms.find(x => x.id === dmId);
    const msg = dm?.msgs.find(m => m.id === msgId);
    if (!msg || !isNightDmMsgEditable(msg)) return;
    msg.text = next;
    ok = true;
  });
  return ok;
}

/** 打开 App / 打开某内容 → 已读（零写盘守卫）。 */
export function markNightSeen(patch: { all?: boolean; postId?: string; liveId?: string; dmId?: string } = {}): void {
  const night = readPhoneDataRef().night;
  if (!night) return;
  const hasUnread = patch.all
    ? night.notifications.some(n => !n.read) || night.dms.some(d => d.unread > 0)
    : (patch.dmId ? (night.dms.find(d => d.id === patch.dmId)?.unread || 0) > 0 : night.notifications.some(n => !n.read && ((patch.postId && n.postId === patch.postId) || (patch.liveId && n.liveId === patch.liveId))));
  if (!hasUnread) return;
  mutatePhoneData(d => {
    const cur = d.night;
    if (!cur) return;
    if (patch.all) {
      markAllNightNotificationsRead(cur);
      for (const dm of cur.dms) dm.unread = 0;
      return;
    }
    if (patch.dmId) {
      const dm = cur.dms.find(x => x.id === patch.dmId);
      if (dm) dm.unread = 0;
    }
    markNightNotificationsRead(cur, { ...(patch.postId ? { postId: patch.postId } : {}), ...(patch.liveId ? { liveId: patch.liveId } : {}) });
  });
}

/** 未读数（badge 热路径）。 */
export function nightUnread(): number {
  const night = readPhoneDataRef().night;
  if (!night) return 0;
  const notif = night.notifications.reduce((sum, n) => sum + (n.read ? 0 : 1), 0);
  const dm = night.dms.reduce((sum, d) => sum + (d.unread || 0), 0);
  return notif + dm;
}

/** 是否存在未生成内容（首屏空态判断；零拷贝 ref 读）。 */
export function hasNightContent(): boolean {
  const night = readPhoneDataRef().night;
  if (!night) return false;
  return Boolean(night.posts.length || night.lives.length || night.dms.length || night.me.alias);
}

/** 清空不夜城数据（设置页出口）。 */
export function clearNightData(): void {
  mutatePhoneData(d => {
    delete d.night;
  });
}

/** 归一化当前 night 域（备份恢复等路径复用；保持引用不变）。 */
export function normalizeNightInPlace(): void {
  mutatePhoneData(d => {
    const normalized = d.night ? normalizeNightData(d.night) : null;
    if (normalized) d.night = normalized;
    else delete d.night;
  });
}

export type { NightData, NightPost, NightLive, NightDm, NightOrder, NightImage };
