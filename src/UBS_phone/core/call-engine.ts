// ===== 通话 AI 引擎：三段式管线（镜像 chat-engine，差异见 docs/05 §4.0 对照表） =====
// ①绿灯触发（position:'none' + should_scan:true）内容=被叫角色名+最近手机记录混合块+本次通话全内容（纪要走资料块，不再注入 AM 序号）
// ②资料块（after_system + should_scan:false）与微信同构，「最近手机记录」段（已排除本次通话）+末段「本次通话内容」
// ③generateRaw 全槽位 + max_chat_history:0 + custom_api + generation_id 可中止
// 富媒体块不带（通话无图片/转账/红包）。不写微信会话/主项目楼层。

import { readChronicleDossierBlocks } from '../../unified-statusbar/core/chronicle-blocks';
import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { getTavernHelper, makeGenerationId, stopGenerationById } from './host-env';
import { mergeOneShotHint } from './extra-hint';
import { keepSpyAndPublicEntries } from './message-worldbook';
import { readAiChatHistory, PhoneChatError } from './chat-engine';
import { runPhoneRaw } from './phone-raw';
import {
  buildCallContinuationInstruction,
  buildCallDossierText,
  buildCallInitiationInstruction,
  buildCallTriggerText,
  buildVoicemailInstruction,
  voicemailTailNote,
  type CallPrevContext,
  type VoicemailScene,
} from './call-prompts';
import { parseCallReply, parseVoicemailReply, type ParseCallResult } from './call-parser';
import type { CallLine } from './call-model';
import { buildMixedRecords, socialTimelinePosts } from './phone-timeline';
import { readSocialOf } from './social-model';
import { readPhoneData } from './phone-store';
import { getPhoneSettings } from './phone-settings';
import { validatePhoneApi } from './phone-api';
import { getRoster, type RosterSnapshot } from './roster';

export interface CallEngineResult {
  result: ParseCallResult;
  raw: string;
}

/** 当前进行中的通话 generation id 集合（中止用；与聊天生成独立计数）。 */
const _activeGenerations = new Set<string>();

/** 终止当前全部小手机通话生成。返回是否有请求被终止。 */
export function abortCallGeneration(): boolean {
  let stopped = false;
  for (const id of _activeGenerations) {
    if (stopGenerationById(id)) stopped = true;
  }
  _activeGenerations.clear();
  return stopped;
}

type CallTurnKind = 'initiate' | 'continue';

interface CallTurnArgs {
  peerName: string;
  kind: CallTurnKind;
  /** 已有通话内容（①②两段共用；发起轮为空数组）。 */
  callLines: CallLine[];
  /** 回拨衔接：上次通话上下文（只进发起指令的回拨判定与时间锚；无历史通话则不传）。 */
  prevCall?: CallPrevContext;
  /** 一次性「本批额外提示」（长按拨打追加；只作用于本次生成，不落盘）。 */
  extraHint?: string;
  /** 本次通话记录 id（混合块排除它——通话内容已在「本次通话内容」段，防重复携带）。 */
  excludeCallId?: string;
  /** 续话轮：用户「说话」输入的文本。 */
  userUtterance?: string;
  rosterOverride?: RosterSnapshot;
}

async function callTurn(args: CallTurnArgs): Promise<CallEngineResult> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  const apiError = validatePhoneApi('chat');
  if (apiError) {
    throw new PhoneChatError('api', apiError);
  }

  const settings = getPhoneSettings();
  const roster = args.rosterOverride ?? getRoster();
  // 纪要统一走资料块（用户定案 V3.710）：被叫角色的完整纪要（取量与原逻辑一致，无概览拆分）；触发注入不再收集 AM 序号
  const chronicleBlocks = readChronicleDossierBlocks([args.peerName], settings.summaryCount);
  const storyText = stripWithContextConfig(readAiChatHistory(settings.chatHistoryCount));
  // 最近手机记录混合块：与对方的微信消息+通话+朋友圈动态+对方参与的群聊块（排除本次通话，防与「本次通话内容」段重复）
  const phoneData = readPhoneData();
  const mixedRecords = buildMixedRecords({
    names: [args.peerName],
    conversations: phoneData.conversations.filter(c => c.kind === 'private' && c.members[0] === args.peerName),
    groupConversations: phoneData.conversations.filter(c => c.kind === 'group' && c.members.includes(args.peerName)),
    calls: phoneData.calls || [],
    moments: readSocialOf(phoneData).moments,
    socialPosts: socialTimelinePosts(readSocialOf(phoneData)),
    me: roster.protagonistName,
    count: settings.phoneHistoryCount,
    excludeCallId: args.excludeCallId,
    style: phoneData.style || '',
  });

  // 额外要求合并产物（进指令 + 追加进触发注入语料——提示里提到的人名同样激活世界书条目）
  const mergedExtra = mergeOneShotHint(settings.extraPrompt, args.extraHint);

  // ①② 一次性注入：once:true 只在下一次请求生成中有效 → 交给 runPhoneRaw 的 prepare 每次尝试前重跑
  const prepare = async () => {
  // ① 绿灯触发注入（不进提示词，只参与世界书扫描；内容=被叫角色名+混合记录+本次通话内容+额外提示）
  await th.injectPrompts([{
    id: `ubp_call_trigger_${args.peerName}`,
    position: 'none',
    depth: 0,
    role: 'system',
    content: [buildCallTriggerText({ peerName: args.peerName, mixedRecords, callLines: args.callLines }), mergedExtra.trim()].filter(Boolean).join(' '),
    should_scan: true,
  }], { once: true });

  // ② 资料块注入（发给 AI，不参与扫描；与微信同构，混合记录段+末段=本次通话内容）
  await th.injectPrompts([{
    id: `ubp_call_dossier_${args.peerName}`,
    position: 'after_system',
    depth: 0,
    role: 'system',
    content: buildCallDossierText({ roster, peerName: args.peerName, chronicleBlocks, storyText, mixedRecords, callLines: args.callLines, style: phoneData.style || '' }),
    should_scan: false,
  }], { once: true });
  };

  // ③ 裸生成（指令按轮次：发起=接听判定+首轮内容（回拨带衔接规则）；续话=回应我方）
  // 情绪/演绎标注只在 TTS 开启（且情绪演绎开关开着）时教学——关闭时整条规则不发、编号重排
  const voiceEmotion = settings.voiceEnabled === true && settings.voiceEmotion === true;
  const instructionText = args.kind === 'continue'
    ? buildCallContinuationInstruction({
      roster, peerName: args.peerName, extraPrompt: mergedExtra,
      userUtterance: args.userUtterance || '',
      style: phoneData.style || '',
      voiceEmotion,
    })
    : buildCallInitiationInstruction({ roster, peerName: args.peerName, extraPrompt: mergedExtra, prevCall: args.prevCall, style: phoneData.style || '', voiceEmotion });
  const instruction = th.substitudeMacros ? th.substitudeMacros(instructionText) : instructionText;

  const generationId = makeGenerationId('ubp-call');
  _activeGenerations.add(generationId);
  let raw = '';
  try {
    // 扫描前剔除纪要自投影 + [UBS手机] 前缀条目按族 keep 豁免（keep 放行窥私记录族+公共舆论条目：
    // 被叫角色的角色间历史供其言行连贯、公共话题人人可知；消息记录族照旧剔除——资料块已自带）
    raw = await runPhoneRaw({
      scope: 'chat',
      instruction,
      generationId,
      keep: keepSpyAndPublicEntries,
      prepare,
      activity: {
        feature: '通话',
        label: '通话',
        appId: 'phone-call',
        tone: 'ai',
        onCancel: () => { abortCallGeneration(); },
      },
    });
  } finally {
    _activeGenerations.delete(generationId);
  }

  const result = parseCallReply(String(raw));
  return { result, raw: String(raw) };
}

/** 通话发起：拨出 → 振铃（AI 生成中）→ 接听/拒接判定 + 首轮通话内容（回拨带衔接时间锚）。 */
export async function initiateCall(args: { peerName: string; prevCall?: CallPrevContext; excludeCallId?: string; extraHint?: string; rosterOverride?: RosterSnapshot }): Promise<CallEngineResult> {
  return callTurn({ peerName: args.peerName, kind: 'initiate', callLines: [], prevCall: args.prevCall, excludeCallId: args.excludeCallId, extraHint: args.extraHint, rosterOverride: args.rosterOverride });
}

/** 通话续话：用户「说话」→ 角色回复（仅角色说话；<挂断> 可结束通话）。 */
export async function continueCall(args: {
  peerName: string;
  userUtterance: string;
  callLines: CallLine[];
  prevCall?: CallPrevContext;
  excludeCallId?: string;
  extraHint?: string;
  rosterOverride?: RosterSnapshot;
}): Promise<CallEngineResult> {
  return callTurn({
    peerName: args.peerName,
    kind: 'continue',
    callLines: args.callLines,
    prevCall: args.prevCall,
    excludeCallId: args.excludeCallId,
    extraHint: args.extraHint,
    userUtterance: args.userUtterance,
    rosterOverride: args.rosterOverride,
  });
}

// ─── 语音留言（T1） ───

export interface VoicemailEngineResult {
  /** 留言行（from 恒 'peer'；relSec=按语速估算的累计秒，仅供展示排序，不参与播放）。 */
  lines: CallLine[];
  raw: string;
}

/**
 * 生成一段语音留言（T1）：未接/拒接来电后对方补留（1-3 句）。
 * 与通话共用三段式骨架（绿灯触发+资料块+裸生成），差异：
 *  ① 触发文本无通话行（留言发生在通话之外）；② 资料块末段换成留言场景说明；
 *  ③ 指令为留言版（单向独白，不是通话回复）。
 * 闸门判定在调用方（core/call-voicemail.scheduleVoicemail）——此处不做闸门，纯生成。
 */
export async function generateVoicemail(args: {
  peerName: string;
  scene: VoicemailScene;
  rosterOverride?: RosterSnapshot;
}): Promise<VoicemailEngineResult> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  const apiError = validatePhoneApi('chat');
  if (apiError) {
    throw new PhoneChatError('api', apiError);
  }

  const settings = getPhoneSettings();
  const roster = args.rosterOverride ?? getRoster();
  const chronicleBlocks = readChronicleDossierBlocks([args.peerName], settings.summaryCount);
  const storyText = stripWithContextConfig(readAiChatHistory(settings.chatHistoryCount));
  const phoneData = readPhoneData();
  const mixedRecords = buildMixedRecords({
    names: [args.peerName],
    conversations: phoneData.conversations.filter(c => c.kind === 'private' && c.members[0] === args.peerName),
    groupConversations: phoneData.conversations.filter(c => c.kind === 'group' && c.members.includes(args.peerName)),
    calls: phoneData.calls || [],
    moments: readSocialOf(phoneData).moments,
    socialPosts: socialTimelinePosts(readSocialOf(phoneData)),
    me: roster.protagonistName,
    count: settings.phoneHistoryCount,
    style: phoneData.style || '',
  });
  const mergedExtra = mergeOneShotHint(settings.extraPrompt, undefined);

  const prepare = async () => {
    await th.injectPrompts([{
      id: `ubp_vm_trigger_${args.peerName}`,
      position: 'none',
      depth: 0,
      role: 'system',
      content: [buildCallTriggerText({ peerName: args.peerName, mixedRecords, callLines: [] }), mergedExtra.trim()].filter(Boolean).join(' '),
      should_scan: true,
    }], { once: true });
    await th.injectPrompts([{
      id: `ubp_vm_dossier_${args.peerName}`,
      position: 'after_system',
      depth: 0,
      role: 'system',
      content: buildCallDossierText({
        roster, peerName: args.peerName, chronicleBlocks, storyText, mixedRecords,
        callLines: [], tailNote: voicemailTailNote(args.scene), style: phoneData.style || '',
      }),
      should_scan: false,
    }], { once: true });
  };

  const voiceEmotion = settings.voiceEnabled === true && settings.voiceEmotion === true;
  const instructionText = buildVoicemailInstruction({
    roster, peerName: args.peerName, scene: args.scene, extraPrompt: mergedExtra,
    style: phoneData.style || '', voiceEmotion,
  });
  const instruction = th.substitudeMacros ? th.substitudeMacros(instructionText) : instructionText;

  const generationId = makeGenerationId('ubp-vm');
  _activeGenerations.add(generationId);
  let raw = '';
  try {
    raw = await runPhoneRaw({
      scope: 'chat',
      instruction,
      generationId,
      keep: keepSpyAndPublicEntries,
      prepare,
      activity: {
        feature: '留言',
        label: '留言',
        appId: 'phone-call',
        tone: 'ai',
        onCancel: () => { abortCallGeneration(); },
      },
    });
  } finally {
    _activeGenerations.delete(generationId);
  }

  const parsed = parseVoicemailReply(String(raw));
  let acc = 0;
  const lines: CallLine[] = parsed.lines.map((text, i) => {
    const relSec = acc;
    acc += Math.max(1, Math.round(text.replace(/\s+/g, '').length / 4)) + 1;
    const tag = parsed.lineTags[i];
    return {
      from: 'peer' as const,
      text,
      relSec,
      ...(tag?.emotion ? { voiceEmotion: tag.emotion } : {}),
      ...(tag?.delivery ? { voiceDelivery: tag.delivery } : {}),
    };
  });
  return { lines, raw: String(raw) };
}
