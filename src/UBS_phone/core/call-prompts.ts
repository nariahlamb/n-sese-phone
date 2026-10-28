// ===== 通话提示词模板与上下文拼装（契约由 tests/phone-call-prompts.test.cjs 锁定） =====
// 输出契约 <ubp_call>（发起版带 status/reason；续话版仅 thought/content）见 docs/05 §4.3。
// 三段式骨架与微信完全一致（docs/05 §4.0 对照表）：①绿灯触发（扫描）②资料块（after_system）
// ③generateRaw 指令。资料块的档案/关系段直接复用 chat-prompts 的段落函数（单一事实源）。

import { contactSection, relationSection } from './chat-prompts';
import { formatCallTranscript, MAX_TRANSCRIPT_LINES, type CallLine } from './call-model';
import type { PhoneStyle } from './chat-model';
import { s } from './skins';
import { mixedRecordSection, type MixedRecords } from './phone-timeline';
import type { RosterSnapshot } from './roster';
import { CALL_CLOSE_TAG, CALL_OPEN_TAG, VOICEMAIL_CLOSE_TAG, VOICEMAIL_OPEN_TAG } from './call-parser';

/** 上次通话上下文（回拨衔接：只供发起指令的回拨判定与时间锚；历史内容一律由混合记录块携带）。 */
export interface CallPrevContext {
  /** 上次通话时的故事时间快照（未记录为空）。 */
  storyTime?: string;
  /** 上次通话内容（判定是否有历史；不再进触发/资料块）。 */
  lines: CallLine[];
}

// ─── ① 绿灯触发文本 ───

export interface CallTriggerArgs {
  peerName: string;
  /** 最近手机记录混合块（与对方的微信消息/通话/朋友圈动态/群聊块；空块=不带该段）。 */
  mixedRecords?: MixedRecords;
  /** 本次通话全内容（最新 MAX_TRANSCRIPT_LINES 条；首轮为空数组）。 */
  callLines: CallLine[];
}

/** 绿灯触发文本（position:'none' + should_scan:true；对齐 buildTriggerText 空段跳过）。纪要不再注入 AM 序号（用户定案：纪要走资料块）。 */
export function buildCallTriggerText(args: CallTriggerArgs): string {
  const parts = [
    args.peerName,
    args.mixedRecords?.body,
    args.callLines.length ? formatCallTranscript(args.callLines, MAX_TRANSCRIPT_LINES, args.peerName) : '',
  ].map(p => (p || '').trim()).filter(Boolean);
  return parts.join(' ');
}

// ─── ② 资料块 ───

export interface CallDossierArgs {
  roster: RosterSnapshot;
  peerName: string;
  /** 剧情纪要块（完整纪要，chronicle-blocks 共享层；空串=不带该段）。 */
  chronicleBlocks: string;
  /** 最近 N 层 AI 回复（全量、过上下文标签剥离；空串=不带正文）。 */
  storyText: string;
  /** 最近手机记录混合块（与对方的微信消息/通话/朋友圈动态/群聊块；已排除本次通话，空块=不带该段）。 */
  mixedRecords?: MixedRecords;
  /** 本次通话内容（最新 MAX_TRANSCRIPT_LINES 条；首轮为空数组）。 */
  callLines: CallLine[];
  /** 末段覆盖（T1 留言场景：无通话内容，整段替换「本次通话内容」；缺省=现状逐字）。 */
  tailNote?: string;
  /** 界面风格（仙侠=神识传音措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
}

/** 通话媒介描述（规则内共用；「句子短、口语化」机制性要求各风格一致托底）。 */
const CALL_MEDIUM = (style: PhoneStyle) => s(style,
  '通话是实时的语音媒介：句子短、口语化、可用语气词和停顿；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '神识传音是实时的心念交谈，闻声如面：句子短、口语为主，可带停顿与轻微修真语气；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '千里传声是机关铜管相连的实时对谈，如隔桌说话：句子短、口语为主，可带停顿与江湖语气；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '远语是水晶共鸣的实时低语，如立耳畔：句子短、口语为主，可带停顿与奇幻语气；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。');

/** 每行句首的情绪标注规则（发起/续话共用；**仅在 TTS 开启时注入**，见 CallInstructionArgs.voiceEmotion）。
 *  **刻意不做四风格改写**：这是给朗读引擎的机器契约（情绪词表与落点见 docs/35 §B.4），
 *  各家皮肤下必须逐字一致，否则同一句在不同风格里会标出不同情绪词。
 *  演绎给的是「怎么演」的维度（语速/语气/气声与音量/停顿与尾音），40 字是**上限裕量不是推荐字数**。 */
const CALL_EMOTION_RULE = `每行句首可加情绪标注（喂给朗读引擎用，不会被念出来）：
   - 写法：\`[情绪]\` 或 \`[情绪|演绎]\`，如 \`[开心]你终于接电话了\`、\`[低语|气声、放慢、字间停顿]别出声\`。
   - 情绪只能取这八个词之一：开心 / 悲伤 / 生气 / 害怕 / 惊讶 / 厌恶 / 平静 / 低语。
   - 演绎是「怎么演」的短指导（上限40字），按需要写清有关的维度：
     语速（偏快 / 拖慢 / 忽快忽慢）、语气（上扬 / 压低 / 发虚 / 带笑）、气声与音量（气声 / 近乎耳语 / 压着嗓子）、
     停顿与尾音（字间停顿 / 尾音拉长 / 尾音发颤）。只写「怎么说」，不写动作、神态或旁白。
   - 不标就按平静处理；不要用方括号写这八个词以外的内容。`;

/** 规则行数组 → 动态编号（情绪那条可整条缺席，编号必须跟着重排，不许留空号）。 */
function numberedRules(rules: readonly string[]): string {
  return rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

/**
 * 资料块（after_system + should_scan:false）。结构镜像微信 buildDossierText，
 * 差异=「最近手机记录」段（与对方相关的混合记录，已排除本次通话）+末段「本次通话内容」。
 */
export function buildCallDossierText(args: CallDossierArgs): string {
  const style = args.style || '';
  const sections: string[] = [s(style,
    '【手机通话资料参考（供保持人物表现一致，非剧中人所知）】',
    '【神识传音资料参考（供保持人物表现一致，非剧中人所知）】',
    '【千里传声资料参考（供保持人物表现一致，非剧中人所知）】',
    '【远语资料参考（供保持人物表现一致，非剧中人所知）】')];
  const g = args.roster.global;
  const envParts = [
    g.location ? `地点：${g.location}` : '',
    g.time ? `时间：${g.time}` : '',
    g.isNsfw ? '氛围：亲密进行中' : '',
  ].filter(Boolean);
  if (envParts.length) sections.push(`■ 当前位置与时间\n${envParts.join('　')}`);
  if (args.chronicleBlocks) {
    sections.push(`■ 剧情纪要（从旧到新，供衔接故事过往）\n${args.chronicleBlocks}`);
  }
  sections.push(`■ 通话对象档案（数据库表格）\n${contactSection(args.roster, args.peerName)}`);
  const relations = relationSection(args.roster, [args.roster.protagonistName, args.peerName]);
  sections.push(`■ 人物关系（与主角及通话对象）\n${relations}`);
  if (args.storyText) {
    sections.push(`■ 最近正文进展（供衔接剧情）\n${args.storyText}`);
  }
  if (args.mixedRecords?.body) {
    sections.push(mixedRecordSection(
      s(style,
        `我与${args.peerName}的微信消息/通话/朋友圈动态`,
        `我与${args.peerName}的符讯/传音/百晓阁风闻`,
        `我与${args.peerName}的书信/传声/茶馆风声`,
        `我与${args.peerName}的晶讯/远语/诗社见闻`),
      args.mixedRecords,
    ));
  }
  const shown = Math.min(args.callLines.length, MAX_TRANSCRIPT_LINES);
  sections.push(args.tailNote
    ? args.tailNote
    : `${s(style, '■ 本次通话内容', '■ 本次传音内容', '■ 本次传声内容', '■ 本次远语内容')}（最近 ${shown} 条）\n${formatCallTranscript(args.callLines, MAX_TRANSCRIPT_LINES, args.peerName)}`);
  return sections.join('\n\n');
}

// ─── ③ 指令模板（user_input）───
// 通话无富媒体块（图片/转账/红包等不适用，docs/05 §4.0）。

export interface CallInstructionArgs {
  roster: RosterSnapshot;
  peerName: string;
  extraPrompt: string;
  /** 回拨继承：上次通话上下文（无则视为首次通话）。 */
  prevCall?: CallPrevContext;
  /** 界面风格（仙侠=神识传音措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
  /** 语音情绪/演绎标注是否注入（= TTS 总开关 + 情绪演绎开关；缺省 true）。
   *  关闭时整条情绪规则缺席、输出格式也不提「每行句首可加情绪标注」，规则编号随之重排。 */
  voiceEmotion?: boolean;
}

/** 通话发起指令（首轮——拨出后第一次生成；带 status/reason 判定字段）。 */
export function buildCallInitiationInstruction(args: CallInstructionArgs): string {
  const me = args.roster.protagonistName;
  const peer = args.peerName;
  const style = args.style || '';
  const isCallback = Boolean(args.prevCall?.lines.length);
  const scene = isCallback
    ? s(style,
      `${me}（即 {{user}}，我方）再次拨打了 ${peer} 的电话（回拨——两人此前通过电话，历史内容见资料块「最近手机记录」），等待对方接听`,
      `${me}（即 {{user}}，我方）再次向 ${peer} 传出神识（重续传音——两人此前有过传音，历史内容见资料块「最近手机记录」），等待对方回应`,
      `${me}（即 {{user}}，我方）再次向 ${peer} 传声（再传一次——两人此前传过声，历史内容见资料块「最近手机记录」），等待对方应声`,
      `${me}（即 {{user}}，我方）再次向 ${peer} 施展远语（再度共鸣——两人此前有过远语，历史内容见资料块「最近手机记录」），等待对方回应`)
    : s(style,
      `${me}（即 {{user}}，我方）拨打了 ${peer} 的电话，等待对方接听`,
      `${me}（即 {{user}}，我方）向 ${peer} 传出神识，等待对方回应`,
      `${me}（即 {{user}}，我方）向 ${peer} 传声，等待对方应声`,
      `${me}（即 {{user}}，我方）向 ${peer} 施展远语，等待对方回应`);
  const withEmotion = args.voiceEmotion !== false;
  const callbackRule = isCallback
    ? `本次是回拨：上次通话发生在过去（上次：${args.prevCall!.storyTime || '时间未记录'}；现在：${args.roster.global.time || '未知'}），开场自然衔接——可问候近况或延续上次话题，但不要把上次通话当作刚刚发生，也不要当作从未发生。`
    : '';
  const extra = args.extraPrompt.trim() ? `\n\n${args.extraPrompt.trim()}` : '';
  const rules = numberedRules([
    `先判定对方是否接听：综合当前故事时间、地点、对方在场状态与情绪、与主角关系、通话时机是否合适。status=answered 表示接听，rejected 表示拒接并给出理由。`,
    `只输出 ${CALL_OPEN_TAG} 块，块外不要有任何文字。`,
    `content 始终以 ${peer} 的身份说话，说几句由你根据通话情境自然决定（如同真人通话节奏），严禁替 {{user}} 编造话语。`,
    `语言必须符合 ${peer} 的语言风格与口癖；内容须与两人当前关系、最新剧情进展、当前时间地点一致。`,
    CALL_MEDIUM(style),
    ...(withEmotion ? [`情绪标注（可选，随每行给出）：${CALL_EMOTION_RULE}`] : []),
    `对方可以在 content 中单独一行输出 <挂断> 表示${s(style,
      '主动挂断电话',
      '主动断开神识（tag 本身不变）',
      '主动收线（tag 本身不变）',
      '主动断开共鸣（tag 本身不变）')}。`,
    `若资料参考与最新正文进展冲突，以正文进展为准。${callbackRule}`,
  ]);
  return `${s(style, '【任务】模拟手机通话。', '【任务】模拟神识传音。', '【任务】模拟千里传声。', '【任务】模拟远语。')}当前场景：${scene}。

【输出格式】（严格遵守）
${CALL_OPEN_TAG}
status: answered 或 rejected
reason: （拒接时给一句话理由，接听时留空）
thought: 对方此刻的内心想法（1-2句）
content: 对方说的话（多行，每行一句，条数由你自然决定${withEmotion ? '；每行句首可加情绪标注' : ''}）
${CALL_CLOSE_TAG}

${s(style, '【通话规则】', '【传音规则】', '【传声规则】', '【远语规则】')}
${rules}${extra}`;
}

/** 通话续话指令（续话轮——用户「说话」后的生成；无 status/reason，只有 thought+content）。 */
export function buildCallContinuationInstruction(args: CallInstructionArgs & { userUtterance: string }): string {
  const me = args.roster.protagonistName;
  const peer = args.peerName;
  const style = args.style || '';
  const utterance = args.userUtterance.trim() || s(style, '（沉默）', '（静默）', '（沉默）', '（沉默）');
  const extra = args.extraPrompt.trim() ? `\n\n${args.extraPrompt.trim()}` : '';
  const withEmotion = args.voiceEmotion !== false;
  const rules = numberedRules([
    `只输出 ${CALL_OPEN_TAG} 块，块外不要有任何文字。`,
    `content 始终以 ${peer} 的身份说话，说几句由你根据通话情境自然决定，严禁替 {{user}} 编造话语。`,
    `语言必须符合 ${peer} 的语言风格与口癖；内容须与两人当前关系、最新剧情进展、当前时间地点一致。`,
    CALL_MEDIUM(style),
    ...(withEmotion ? [`情绪标注（可选，随每行给出）：${CALL_EMOTION_RULE}`] : []),
    `对方可以在 content 中单独一行输出 <挂断> 表示${s(style, '主动挂断电话', '主动断开神识', '主动收线', '主动断开共鸣')}。`,
    `若资料参考与最新正文进展冲突，以正文进展为准。`,
  ]);
  return `${s(style, '【任务】模拟手机通话。', '【任务】模拟神识传音。', '【任务】模拟千里传声。', '【任务】模拟远语。')}当前场景：${me}（即 {{user}}，我方）${s(style,
    `正在和 ${peer} 通话中。`,
    `正与 ${peer} 神识相连、传音交谈中。`,
    `正与 ${peer} 铜管相连、传声对谈中。`,
    `正与 ${peer} 水晶共鸣、远语交谈中。`)}

${s(style, '我方刚刚说：', '我方刚刚传念：', '我方刚刚开口：', '我方刚刚低语：')}
${utterance}

【输出格式】（严格遵守）
${CALL_OPEN_TAG}
thought: 对方此刻的内心想法（1-2句）
content: 对方说的话（多行，每行一句，条数由你自然决定${withEmotion ? '；每行句首可加情绪标注' : ''}）
${CALL_CLOSE_TAG}

${s(style, '【通话规则】', '【传音规则】', '【传声规则】', '【远语规则】')}
${rules}${extra}`;
}

// ─── 语音留言（T1） ───

/** 留言场景：missed=响铃无人接听；rejected=被主角挂断。 */
export type VoicemailScene = 'missed' | 'rejected';

/** 留言场景的资料块末段（替换「本次通话内容」段——留言没有通话内容）。 */
export function voicemailTailNote(scene: VoicemailScene): string {
  return scene === 'missed'
    ? '■ 本次通话\n（来电响铃后无人接听，没有通话内容——对方在提示音后留下了一段语音留言）'
    : '■ 本次通话\n（来电被挂断，没有通话内容——对方在提示音后留下了一段语音留言）';
}

/** 留言媒介描述（四风格；机制性要求与 CALL_MEDIUM 同款托底，差异=「说给不在场的人听」）。 */
const VM_MEDIUM = (style: PhoneStyle) => s(style,
  '语音留言是录给对方事后听的一段话：口语、自然，允许停顿、犹豫、改口、越说越小声；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '神识留音是留给对方事后感知的一段心声：口语自然，可带停顿、迟疑与轻微修真语气；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '传声留话是铜管留声存给对方的几句话：口语自然，可带停顿、迟疑与江湖语气；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '远语留音是水晶里存给对方的低语：口语自然，可带停顿、迟疑与奇幻语气；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。');

export interface VoicemailInstructionArgs {
  roster: RosterSnapshot;
  peerName: string;
  scene: VoicemailScene;
  extraPrompt: string;
  /** 界面风格（仙侠=神识传音措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
  /** 语音情绪/演绎标注是否注入（= TTS 总开关 + 情绪演绎开关；缺省 true）。 */
  voiceEmotion?: boolean;
}

/**
 * 语音留言指令（T1）：AI 以对方身份补留一段 1-3 句的留言。
 * 场景说明里写「提示音后留言」是为了让模型知道这是「对方不在听」的单向独白，
 * 不是通话回复——不解释系统如何生成（提示词只做要求不做解释，§四纪律）。
 */
export function buildVoicemailInstruction(args: VoicemailInstructionArgs): string {
  const me = args.roster.protagonistName;
  const peer = args.peerName;
  const style = args.style || '';
  const withEmotion = args.voiceEmotion !== false;
  const extra = args.extraPrompt.trim() ? `\n\n${args.extraPrompt.trim()}` : '';
  const scene = args.scene === 'missed'
    ? s(style,
      `${peer} 刚刚拨打了 ${me}（即 {{user}}，我方）的电话，响铃后没有人接听；现在响起提示音——请在「嘟」声后留言。`,
      `${peer} 刚刚向 ${me}（即 {{user}}，我方）传出神识，等待中无人回应；现在可以留一段话。`,
      `${peer} 刚刚向 ${me}（即 {{user}}，我方）传声，铜管那头没有人应声；现在可以留几句话。`,
      `${peer} 刚刚向 ${me}（即 {{user}}，我方）施展远语，共鸣中无人回应；现在可以留一段低语。`)
    : s(style,
      `${peer} 刚刚拨打了 ${me}（即 {{user}}，我方）的电话，但被挂断了；随后响起提示音——请在「嘟」声后留言。`,
      `${peer} 刚刚向 ${me}（即 {{user}}，我方）传出神识，却被打断；现在可以留一段话。`,
      `${peer} 刚刚向 ${me}（即 {{user}}，我方）传声，却被收了线；现在可以留几句话。`,
      `${peer} 刚刚向 ${me}（即 {{user}}，我方）施展远语，却被打断；现在可以留一段低语。`);
  const rules = numberedRules([
    `只输出 ${VOICEMAIL_OPEN_TAG} 块，块外不要有任何文字。`,
    `content 始终以 ${peer} 的身份说话（这段留言是你录下的），严禁替 {{user}} 编造话语；留言里提到主角时用「你」。`,
    `留言共 1 至 3 句，每句独立一行。`,
    `这是留音不是通话：对方不会当场回应——可以是等不到回应的自言自语，可以停顿、迟疑、改口，也可以突然想起正事。`,
    `语言必须符合 ${peer} 的语言风格与口癖；内容须与两人当前关系、最新剧情进展、当前时间地点一致；打电话的事由自洽。`,
    VM_MEDIUM(style),
    ...(withEmotion ? [`情绪标注（可选，随每行给出）：${CALL_EMOTION_RULE}`] : []),
    `若资料参考与最新正文进展冲突，以正文进展为准。`,
  ]);
  return `${s(style, '【任务】模拟语音留言。', '【任务】模拟神识留音。', '【任务】模拟传声留话。', '【任务】模拟远语留音。')}当前场景：${scene}

【输出格式】（严格遵守）
${VOICEMAIL_OPEN_TAG}
content: 留言内容（多行，每行一句，1-3 句${withEmotion ? '；每行句首可加情绪标注' : ''}）
${VOICEMAIL_CLOSE_TAG}

${s(style, '【留言规则】', '【留音规则】', '【留话规则】', '【留音规则】')}
${rules}${extra}`;
}
