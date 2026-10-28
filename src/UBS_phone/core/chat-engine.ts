// ===== 聊天 AI 引擎：三段式管线骨架（本项目复用模板，见 docs/02 §4） =====
//
// 模板只固定「位置 + 是否参与绿灯扫描」；①② 的具体内容由功能自定（一功能一讨论）。
//
// ① injectPrompts 绿灯触发
//    位置 position:'none'（不发给 AI）｜扫描 should_scan:true｜once:true
//    → 内容由功能决定。这是除真实酒馆聊天外，唯一主动进绿灯扫描文本的通道。
//    → 群聊超上限时限流：成员名段只注入「被@/被回复者 ∪ 随机补足至上限」（强制者计入名额，
//      强制≥上限或 @所有人 突破限制；上限=设置 groupTriggerCap，默认 5）；用户输入/聊天记录段保持全量
//      （提到谁，谁的世界书仍被扫描激活）。气氛组独立焦点：≤5 全员、>5 随机 3～5；
//      被@/被回复必进，@所有人=全部已生成气氛组；未进焦点不进成员名段。
//
// ② injectPrompts 资料块
//    位置 position:'after_system'（发给 AI）｜扫描 should_scan:false｜once:true
//    → 内容由功能决定；发给 AI 但不参与绿灯扫描。
//    → 正文（AI 回复）上下文不走 chat_history 槽位，而是经主项目"上下文标签剥离"
//      （stripWithContextConfig）处理后通过本段注入；具体带几层等由功能决定。
//
// ③ generateRaw 标准模板 = phone-raw.runPhoneRaw（全槽位 + max_chat_history 0 的单一事实源，
//    槽位清单与扫描钩说明见 core/phone-raw.ts；本引擎只传 scope/instruction/generationId/keep）。
//
// 绿灯扫描文本 = 真实酒馆聊天（按全局 scan_depth）+ ①。
// ② 资料块、③ user_input 均不参与绿灯扫描。

import { readChronicleDossierBlocks } from '../../unified-statusbar/core/chronicle-blocks';
import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { getTavernHelper, hostWindow, makeGenerationId, stopGenerationById } from './host-env';
import { mergeOneShotHint } from './extra-hint';
import { keepSpyAndPublicEntries } from './message-worldbook';
import { runPhoneRaw } from './phone-raw';
import { parseChatReply, type ParseChatResult } from './chat-parser';
import { parseAtmosphereProfiles } from './atmosphere';
import { buildChatInstruction, buildDossierText, buildTriggerText, GROUP_RECENT_MESSAGES, type InstructionArgs } from './chat-prompts';
import type { ChatBranch } from './rich-media';
import {
  collectQuotedSenders,
  composeBatchUserText,
  emptyMentions,
  fillAtmosphereProfiles,
  groupSpeakerNames,
  isFriend,
  parseMentions,
  pendingAtmosphere,
  readyAtmosphereNames,
  selectFocusAtmosphereNames,
  selectInjectedMembers,
  trailingUserBatch,
  type Conversation,
  type GroupMentions,
} from './chat-model';
import { currentPhoneStorageId, mutatePhoneData, readPhoneData } from './phone-store';
import { buildMixedRecords, formatMessageHistory, socialTimelinePosts } from './phone-timeline';
import { readSocialOf } from './social-model';
import {
  gameTypesFromText,
  summariesForPlayers,
  summaryPromptLines,
  type PhoneGames,
} from './game-model';
import { getPhoneSettings } from './phone-settings';
import { validatePhoneApi } from './phone-api';
import { PhoneChatError, type PhoneChatErrorKind } from './phone-error';
import { getRoster, type RosterSnapshot } from './roster';

// 错误类型迁至 phone-error（叶模块，供 phone-raw 复用）；此处 re-export，既有调用方零改动。
export { PhoneChatError };
export type { PhoneChatErrorKind };

/** 桌游总结注入段（docs/16 §2.8）：关键词命中时按注入名单取该游戏池最近 3 场（跨池合并行）。 */
function buildGameSummariesSection(userText: string, names: readonly string[], games: PhoneGames | null): string {
  const types = gameTypesFromText(userText);
  if (!types.length || !games) return '';
  const lines: string[] = [];
  for (const type of types) {
    lines.push(...summaryPromptLines(summariesForPlayers(games.summaries[type], names, 3)));
  }
  if (!lines.length) return '';
  return `■ 最近桌游对局（与聊天角色的历史对局总结；历史身份与本对话无关，仅供回忆恩怨与打趣）\n${lines.join('\n')}`;
}

export interface ChatReplyResult {
  raw: string;
  parsed: ParseChatResult;
  /** 本轮同一条回复里新生成并落库的气氛组名字（无 pending/未生成时缺省）。 */
  atmosphereProfiles?: string[];
}

/** 进行中的生成：会话 id → generation id 集合（多会话可并行，终止/清理按会话隔离）。 */
const _activeGenerations = new Map<string, Set<string>>();

/** 终止小手机聊天生成：传会话 id 只终止该会话，省略则全部终止。返回是否有请求被终止。 */
export function abortPhoneGeneration(conversationId?: string): boolean {
  let stopped = false;
  const convIds = conversationId ? [conversationId] : [..._activeGenerations.keys()];
  for (const convId of convIds) {
    const ids = _activeGenerations.get(convId);
    if (!ids) continue;
    for (const id of ids) {
      if (stopGenerationById(id)) stopped = true;
    }
    ids.clear();
    _activeGenerations.delete(convId);
  }
  return stopped;
}

// ─── 上下文素材收集 ───

/**
 * 取最近 count 层 AI 回复（仅 assistant，含隐藏楼层，全量不截断），供资料块正文段。
 * 与主项目 map-system.getCleanChatHistory 同源逻辑（不 import map-system 以免带入重依赖）；
 * 标签剥离由调用方过 stripWithContextConfig（主项目"上下文标签剥离"设置）。
 * count<=0 返回空串。
 */
export function readAiChatHistory(count: number): string {
  if (count <= 0) return '';
  const th = getTavernHelper();
  if (th && typeof th.getChatMessages === 'function' && typeof th.getLastMessageId === 'function') {
    try {
      const lastId = th.getLastMessageId();
      if (typeof lastId === 'number' && lastId >= 0) {
        const startId = Math.max(0, lastId - count + 1);
        const messages = th.getChatMessages(`${startId}-${lastId}`, {
          role: 'assistant',
          hide_state: 'all',
          include_swipes: false,
        }) as any[];
        if (Array.isArray(messages) && messages.length) {
          const lines: string[] = [];
          let taken = 0;
          for (let i = messages.length - 1; i >= 0 && taken < count; i--) {
            const m = messages[i];
            if (!m || typeof m.message !== 'string' || !m.message.trim()) continue;
            lines.unshift(`AI：${m.message.trim()}`);
            taken++;
          }
          if (lines.length) return lines.join('\n\n');
        }
      }
    } catch (_e) { /* fallthrough */ }
  }
  try {
    const w = hostWindow() as any;
    const chat = w.SillyTavern?.chat;
    if (Array.isArray(chat)) {
      const lines: string[] = [];
      let taken = 0;
      for (let i = chat.length - 1; i >= 0 && taken < count; i--) {
        const m = chat[i];
        if (m && !m.is_user && typeof m.mes === 'string' && m.mes.trim()) {
          lines.unshift(`AI：${m.mes.trim()}`);
          taken++;
        }
      }
      if (lines.length) return lines.join('\n\n');
    }
  } catch (_e) { /* ignore */ }
  return '';
}

// ─── 主流程 ───

export interface GenerateReplyArgs {
  conversationId: string;
  /** 一次性「本批额外提示」（微信输入栏生成条 ⋯ 追加；只作用于本次生成，不落盘）。 */
  extraHint?: string;
  /** 供测试注入的 roster 快照。 */
  rosterOverride?: RosterSnapshot;
}

/**
 * 生成一轮聊天回复。本批用户输入由引擎内部从存储推导：尾部连续我方消息
 * （trailingUserBatch）拼为 userText——调用方只负责触发，上屏≠触发。
 * 抛 PhoneChatError（kind: env/api/network/parse）。
 */
export async function generateConversationReply(args: GenerateReplyArgs): Promise<ChatReplyResult> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  const apiError = validatePhoneApi('chat');
  if (apiError) {
    throw new PhoneChatError('api', apiError);
  }
  // 气氛组落库守卫：生成期间切聊天时，姓名/性格与消息一样整批丢弃。
  const ownerStorageId = currentPhoneStorageId();

  const phoneData = readPhoneData();
  const conversation: Conversation | undefined = phoneData.conversations.find(c => c.id === args.conversationId);
  if (!conversation || !conversation.members.length) {
    throw new PhoneChatError('env', '会话不存在或没有成员');
  }

  const settings = getPhoneSettings();
  const roster = args.rosterOverride ?? getRoster();

  // 聊天分支（与私聊/群聊并列的第三分支）：非好友私聊一律走好友申请指令（管线结构不变）
  const branch: ChatBranch = conversation.kind === 'group'
    ? 'group'
    : isFriend(phoneData, conversation.members[0]) ? 'private' : 'friend-request';

  // ① 素材收集：批次→userText；群聊算绿灯注入名单（>上限=被@/被回复者 ∪ 随机补足；上限=设置 groupTriggerCap）
  //    气氛组独立焦点：已生成池 ≤5 全员、>5 随机 3～5；被@/被回复必进；@所有人=全部气氛组。
  const isGroup = conversation.kind === 'group';
  const batch = trailingUserBatch(conversation.messages);
  const userText = composeBatchUserText(batch);
  const repliedNames = isGroup ? collectQuotedSenders(batch) : [];
  const pendingAtmo = isGroup ? pendingAtmosphere(conversation) : [];
  const pendingAtmoIds = pendingAtmo.map(a => a.id);
  const readyAtmoNames = isGroup ? readyAtmosphereNames(conversation) : [];
  let injectedMembers = conversation.members;
  let mentions: GroupMentions = emptyMentions();
  let focusAtmoNames: string[] = [];
  if (isGroup) {
    mentions = parseMentions(userText, groupSpeakerNames(conversation));
    injectedMembers = selectInjectedMembers(
      conversation.members,
      mentions,
      Math.random,
      settings.groupTriggerCap,
      repliedNames,
    );
    focusAtmoNames = mentions.atAll
      ? readyAtmoNames
      : selectFocusAtmosphereNames(readyAtmoNames, [...mentions.names, ...repliedNames], Math.random);
  }
  // 纪要统一走资料块（用户定案 V3.710）：在场成员的完整纪要（取量与原逻辑一致，无概览拆分）；触发注入不再收集 AM 序号
  const chronicleBlocks = readChronicleDossierBlocks(injectedMembers, settings.summaryCount);
  // 最近手机记录混合块（群聊按「主角发言+故事时间」双路线分块参与——用户定案，见 phone-timeline 文件头★）：
  // 私聊=本会话消息+与对方的通话+对方/我发的朋友圈动态+对方参与（发言/被@）的群聊块；
  // 群聊=注入名单（随机∪被@∪被回复）人物相关的跨渠道记录（排除本群——自身消息另以「本群最近消息」段单独呈现）
  const blockedAtmosphereNames = isGroup && pendingAtmo.length
    ? Array.from(new Set([
      roster.protagonistName,
      roster.userName,
      ...conversation.members,
      ...readyAtmoNames,
      ...(roster.contacts || []).map(c => c.name),
    ].filter(Boolean)))
    : [];
  const relatedNames = isGroup ? injectedMembers : conversation.members;
  const mixedRecords = buildMixedRecords({
    names: relatedNames,
    conversations: isGroup
      ? phoneData.conversations.filter(c => c.kind === 'private' && injectedMembers.includes(c.members[0]))
      : [conversation],
    groupConversations: phoneData.conversations.filter(c =>
      c.kind === 'group' && (!isGroup || c.id !== conversation.id) && relatedNames.some(n => c.members.includes(n))),
    calls: phoneData.calls || [],
    moments: readSocialOf(phoneData).moments,
    socialPosts: socialTimelinePosts(readSocialOf(phoneData)),
    me: roster.protagonistName,
    count: settings.phoneHistoryCount,
    style: phoneData.style || '',
  });
  const groupRecent = isGroup
    ? formatMessageHistory(conversation.messages, GROUP_RECENT_MESSAGES)
    : undefined;
  const storyText = stripWithContextConfig(readAiChatHistory(settings.chatHistoryCount));

  // 额外要求合并产物（进指令 + 追加进触发注入语料——提示里提到的人名同样激活世界书条目）
  const mergedExtra = mergeOneShotHint(settings.extraPrompt, args.extraHint);

  // ②③ 一次性注入（绿灯触发 + 资料块）：once:true 只在下一次请求生成中有效，故不能只做一次——
  // 交给 runPhoneRaw 的 prepare 在【每次尝试】前重跑，自动重试那一发才不会丢掉资料块。
  const prepare = async () => {
    // ② 绿灯触发注入（不进提示词，只参与世界书扫描；成员名段=注入名单，用户输入/聊天记录段全量+额外提示）
    await th.injectPrompts([{
      id: `ubp_phone_trigger_${conversation.id}`,
      position: 'none',
      depth: 0,
      role: 'system',
      content: [buildTriggerText({
        members: [...injectedMembers, ...focusAtmoNames],
        userText,
        mixedRecords,
        ...(groupRecent ? { groupRecent } : {}),
      }), mergedExtra.trim()].filter(Boolean).join(' '),
      should_scan: true,
    }], { once: true });

    // ③ 资料块注入（发给 AI，不参与扫描；档案/关系段按注入名单收窄）
    // 桌游关键词联动（docs/16 §2.8）：用户输入含「狼人杀/谁是卧底」→ 注入与聊天相关角色有关的最近 3 场总结
    const gameSection = buildGameSummariesSection(userText, relatedNames, phoneData.games || null);
    await th.injectPrompts([{
      id: `ubp_phone_dossier_${conversation.id}`,
      position: 'after_system',
      depth: 0,
      role: 'system',
      content: [buildDossierText({
        roster,
        conversation,
        injectedMembers,
        chronicleBlocks,
        storyText,
        mixedRecords,
        ...(groupRecent ? { groupRecent } : {}),
        focusAtmosphereNames: focusAtmoNames,
        style: phoneData.style || '',
      }), gameSection].filter(Boolean).join('\n\n'),
      should_scan: false,
    }], { once: true });
  };

  // ④ 裸生成（指令按分支：私聊/群聊/好友申请）
  const instructionArgs: InstructionArgs = {
    roster,
    conversation,
    userText,
    extraPrompt: mergedExtra,
    injectedMembers,
    mentions,
    pendingAtmosphere: pendingAtmo.length,
    focusAtmosphereNames: focusAtmoNames,
    blockedAtmosphereNames,
    branch,
    style: phoneData.style || '',
    // 情绪/演绎只在 TTS 开启（且情绪演绎开关开着）时注入——关闭时不发这段无意义提示词
    voiceEmotion: settings.voiceEnabled === true && settings.voiceEmotion === true,
  };
  const instruction = th.substitudeMacros
    ? th.substitudeMacros(buildChatInstruction(instructionArgs))
    : buildChatInstruction(instructionArgs);

  const generationId = makeGenerationId('ubp-phone');
  let genIds = _activeGenerations.get(args.conversationId);
  if (!genIds) _activeGenerations.set(args.conversationId, (genIds = new Set()));
  genIds.add(generationId);
  let raw = '';
  try {
    // 扫描前剔除纪要自投影 + [UBS手机] 前缀条目按族 keep 豁免（keep 放行窥私记录族+公共舆论条目：
    // 角色间历史供对方言行连贯、公共话题人人可知；消息记录族照旧剔除——资料块已自带）
    raw = await runPhoneRaw({
      scope: 'chat',
      instruction,
      generationId,
      keep: keepSpyAndPublicEntries,
      prepare,
      activity: {
        feature: '微信回复',
        label: '微信回复',
        appId: 'wechat',
        tone: 'wechat',
        onCancel: () => { abortPhoneGeneration(args.conversationId); },
      },
    });
  } finally {
    genIds.delete(generationId);
    if (!genIds.size && _activeGenerations.get(args.conversationId) === genIds) {
      _activeGenerations.delete(args.conversationId);
    }
  }


  // ⑤ 解析：先从同一条回复的 <ubp_atmo> 落库姓名/性别/身份/性格，再用新名字解析 <ubp_reply>。
  let newAtmoNames: string[] = [];
  if (isGroup && pendingAtmo.length) {
    const profiles = parseAtmosphereProfiles(String(raw), pendingAtmo.length, blockedAtmosphereNames);
    if (profiles.length && currentPhoneStorageId() === ownerStorageId) {
      newAtmoNames = mutatePhoneData(d => {
        const live = d.conversations.find(c => c.id === conversation.id);
        if (!live || live.kind !== 'group') return [];
        return fillAtmosphereProfiles(live, profiles, pendingAtmoIds);
      });
    }
  }
  // 正式成员维持现有口径（被提到者可发言）；气氛组只允许本轮焦点 + 本轮新生成。
  const atmosphereSenders = Array.from(new Set([...focusAtmoNames, ...newAtmoNames]));
  const allowedSenders = Array.from(new Set([...conversation.members, ...atmosphereSenders]));
  const parsed = parseChatReply(String(raw), {
    allowedSenders,
    branch,
    ...(atmosphereSenders.length ? { atmosphereSenders } : {}),
  });
  if (!parsed.messages.length && !parsed.memos.length && !parsed.actions.length) {
    throw new PhoneChatError('parse', '对方没有回复（生成内容无法解析为聊天消息）');
  }
  return { raw: String(raw), parsed, ...(newAtmoNames.length ? { atmosphereProfiles: newAtmoNames } : {}) };
}
