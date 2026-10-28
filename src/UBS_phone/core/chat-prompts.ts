// ===== 聊天提示词模板与上下文拼装（契约由 tests/phone-prompts.test.cjs 锁定） =====
// 输出契约 <ubp_reply> 与资料块结构见 docs/02 §4-§5。

import {
  type AtmosphereRequirementBatch,
  type Conversation,
  type GroupMentions,
  type PhoneStyle,
  pendingAtmosphereBatches,
  readyAtmosphereMembers,
} from './chat-model';
import type { RosterSnapshot } from './roster';
import { buildMemoPromptBlock, buildRichMediaPromptBlock, type ChatBranch } from './rich-media';
import { payCommon } from './currency-link';
import { mixedRecordSection, type MixedRecords } from './phone-timeline';
import { s } from './skins';

export type { ChatBranch };

// 契约标签集中到 core/protocol-tags（单一事实源）；此处 import 后原样 re-export，既有 import 路径不变。
import { ATMO_CLOSE_TAG, ATMO_OPEN_TAG, REPLY_CLOSE_TAG, REPLY_OPEN_TAG } from './protocol-tags';
export { REPLY_CLOSE_TAG, REPLY_OPEN_TAG };

/** 群聊资料块「本群最近消息」独立段条数（群聊自身消息不进混合时间线，单独整段呈现）。 */
export const GROUP_RECENT_MESSAGES = 20;

// ─── 绿灯触发文本 ───

export interface TriggerArgs {
  /** 绿灯注入名单（群聊>5人=随机5人∪被@者；成员名段只注入这批，聊天记录/用户输入段不受影响）。 */
  members: string[];
  /** 本轮用户输入（全量，不截断；无则空串）。 */
  userText: string;
  /** 最近手机记录混合块（微信私聊消息/通话/朋友圈动态/群聊块，见 phone-timeline 文件头★；空块=不带该段）。 */
  mixedRecords: MixedRecords;
  /** 群聊「本群最近消息」段正文（仅群聊传——本群自身消息不进混合块（排除本群），单独参与扫描）。 */
  groupRecent?: MixedRecords;
  /** 界面风格（仙侠=符讯措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
}

/** 绿灯触发文本（position:'none' + should_scan:true，空段跳过）。纪要不再注入 AM 序号（用户定案：纪要走资料块）。 */
export function buildTriggerText(args: TriggerArgs): string {
  const parts = [
    ...args.members,
    args.userText,
    args.mixedRecords.body,
    args.groupRecent?.body,
  ].map(p => (p || '').trim()).filter(Boolean);
  return parts.join(' ');
}

// ─── 资料块 ───

export interface DossierArgs {
  roster: RosterSnapshot;
  conversation: Conversation;
  /** 绿灯注入名单（档案与关系段按此收窄；缺省=全员，私聊即唯一成员）。 */
  injectedMembers?: string[];
  /** 剧情纪要块（完整纪要，chronicle-blocks 共享层；空串=不带该段）。 */
  chronicleBlocks: string;
  /** 最近 N 层 AI 回复（全量、过上下文标签剥离；空串=不带正文）。 */
  storyText: string;
  /** 最近手机记录混合块（微信私聊消息/通话/朋友圈动态/群聊块混排；群聊=注入名单人物相关，本群自身消息单独成段）。 */
  mixedRecords: MixedRecords;
  /** 群聊「本群最近消息」独立段（仅群聊传——参考通话「本次通话内容」的呈现方式）。 */
  groupRecent?: MixedRecords;
  /** 本轮焦点气氛组名单（缺省=全部 ready，兼容旧调用；空数组=本轮无焦点气氛组）。 */
  focusAtmosphereNames?: string[];
  /** 界面风格（仙侠=符讯措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
}

/** 聊天媒介描述（规则第 5 条共用；机制性要求「句子短、可用语气词」各风格一致托底）。 */
const MEDIUM_RULE = (style: PhoneStyle) => s(style,
  '手机聊天是轻松的口语媒介：句子短、可用语气词；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '符讯是修士间的轻快灵讯：句子短、口语为主，可自然带修真用语，但不要文绉绉；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '飞鸽书信是江湖人往来的短笺：句子短、白话为主，可自然带江湖口吻，但不要文绉绉；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
  '晶讯是冒险者间的轻快讯息：句子短、口语为主，可自然带奇幻比喻，但不要文绉绉；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。');

/** 单个联系人档案段（通讯录表 + 在场状态；电话资料块复用）。 */
export function contactSection(roster: RosterSnapshot, name: string): string {
  const contact = roster.contacts.find(c => c.name === name);
  const present = roster.present[name];
  const lines: string[] = [];
  const meta = [
    contact?.gender,
    contact?.age,
    contact?.identity || contact?.brief,
  ].filter(Boolean).join('/');
  lines.push(`· ${name}${meta ? `（${meta}）` : ''}`);
  if (contact?.languageStyle) lines.push(`　语言风格与口癖：${contact.languageStyle.slice(0, 200)}`);
  if (contact?.attitude) lines.push(`　对主角态度：${contact.attitude.slice(0, 200)}`);
  if (contact?.recentIntimacy) lines.push(`　最近亲密互动：${contact.recentIntimacy.slice(0, 200)}`);
  if (present?.status || present?.emotion) {
    lines.push(`　当前状态：${present.status || '未记录'}　情绪：${present.emotion || '未记录'}`);
  }
  if (contact?.appearance) lines.push(`　外貌要点：${contact.appearance.slice(0, 80)}`);
  if (!contact && !present) lines.push('　（数据库无档案——性格表现以世界书与角色卡为准）');
  return lines.join('\n');
}

/**
 * 人物关系段（names 两两之间已登记的关系对，全量不截断；电话/社媒/窥私资料块复用）。
 * 主项目「人物关系表」只在两人产生过互动时才登记一行，故未列出=没有互动过——段尾固定附默认值纪律，
 * 空表也成段：否则模型会把通讯录默认当熟人圈，演出貌似熟识的互动。
 */
export function relationSection(roster: RosterSnapshot, names: string[]): string {
  const nameSet = new Set(names);
  const pairs = roster.relations.filter(r => nameSet.has(r.a) && nameSet.has(r.b));
  return [
    ...pairs.map(r => `${r.a} ↔ ${r.b}：${r.type || '关系'}${r.state ? `（${r.state}）` : ''}`),
    '未列出关系的角色之间默认互不相识或关系疏远（正文已确立的关系除外）：不得演出熟识、亲密、旧识式的互动，同群、同场、同属一方都不算相识。',
  ].join('\n');
}

/** 资料块（after_system + should_scan:false 注入）。 */
export function buildDossierText(args: DossierArgs): string {
  const style = args.style || '';
  const sections: string[] = [s(style,
    '【手机聊天资料参考（供保持人物表现一致，非剧中人所知）】',
    '【符讯资料参考（供保持人物表现一致，非剧中人所知）】',
    '【飞鸽书信资料参考（供保持人物表现一致，非剧中人所知）】',
    '【晶讯资料参考（供保持人物表现一致，非剧中人所知）】')];
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
  sections.push(`■ 对话对象档案（数据库表格）\n${(args.injectedMembers || args.conversation.members).map(m => contactSection(args.roster, m)).join('\n')}`);
  const relations = relationSection(args.roster, [args.roster.protagonistName, ...(args.injectedMembers || args.conversation.members)]);
  sections.push(`■ 人物关系（在场成员间及与主角）\n${relations}`);
  // 气氛组：只给焦点人物「姓名 + 性别/身份 + 一句性格」，不查数据库档案、不进关系表/混合记录。
  const allAtmosphere = args.conversation.kind === 'group' ? readyAtmosphereMembers(args.conversation) : [];
  const focusSet = Array.isArray(args.focusAtmosphereNames) ? new Set(args.focusAtmosphereNames) : null;
  const atmosphere = focusSet ? allAtmosphere.filter(a => focusSet.has(a.name)) : allAtmosphere;
  if (atmosphere.length) {
    const hidden = Math.max(0, allAtmosphere.length - atmosphere.length);
    const meta = (a: { gender?: string; identity?: string }): string =>
      [a.gender || '性别未设定', a.identity || '身份未设定'].join('/');
    const focusNote = hidden
      ? `本轮只有以上 ${atmosphere.length} 位焦点气氛组参与群聊；另有 ${hidden} 位气氛组本轮不读入、不发言。`
      : '以上为本轮焦点气氛组。';
    sections.push(`■ 本轮焦点气氛组（普通群友，非通讯录角色）\n${atmosphere.map(a => `· ${a.name}（${meta(a)}）：${a.personality || '未设定'}`).join('\n')}\n说明：${focusNote}他们与主角和正式成员泛泛之交；可以自然接话、附和、吐槽，但不推动主线，不替正式成员表态。`);
  }
  if (args.storyText) {
    sections.push(`■ 最近正文进展（供衔接剧情）\n${args.storyText}`);
  }
  // 混合块 scope：私聊=与对方（含对方参与的群聊块）；群聊=注入名单（随机∪被@者）人物相关
  // （排除本群），本群自身消息以「本群最近消息」段单独呈现（结构参考通话「本次通话内容」）。
  const isGroup = args.conversation.kind === 'group';
  const scope = isGroup
    ? s(style,
      `与${(args.injectedMembers || args.conversation.members).join('、')}相关的微信消息/通话/朋友圈动态/群聊`,
      `与${(args.injectedMembers || args.conversation.members).join('、')}相关的符讯/传音/共谈/百晓阁风闻`,
      `与${(args.injectedMembers || args.conversation.members).join('、')}相关的书信/传声/群英会话/茶馆风声`,
      `与${(args.injectedMembers || args.conversation.members).join('、')}相关的晶讯/远语/圆桌商谈/诗社见闻`)
    : s(style,
      `我与${args.conversation.members[0]}的微信消息/通话/朋友圈动态/群聊`,
      `我与${args.conversation.members[0]}的符讯/传音/共谈/百晓阁风闻`,
      `我与${args.conversation.members[0]}的书信/传声/群英会话/茶馆风声`,
      `我与${args.conversation.members[0]}的晶讯/远语/圆桌商谈/诗社见闻`);
  sections.push(mixedRecordSection(scope, args.mixedRecords));
  if (isGroup) {
    sections.push(`■ 本群最近消息（最近 ${args.groupRecent?.units || 0} 条，从旧到新）\n${args.groupRecent?.body || '（本群还没有消息）'}`);
  }
  return sections.join('\n\n');
}

// ─── 指令模板（user_input）───
// 富媒体类型（图片/语音/转账/红包/备忘）的生成时机与结构要求统一由 rich-media 注册表
// 注入为【富媒体类型】内容块（标准三要素【名称】【生成时机】【结构要求】，docs/02 §5.4）；
// 备忘不在此块——不是聊天消息，由 buildMemoPromptBlock 单独成【备忘记录】段（docs/02 §5.4）。

const FORMAT_RULES_PRIVATE = (name: string, style: PhoneStyle = '') => `【规则】
1. 只输出 ${REPLY_OPEN_TAG} 块，块外不要有任何文字。
2. 每行一条消息，模拟真人连续发消息的节奏，条数按聊天发展自然决定。
3. 只能以 ${name} 的身份发言，严禁替 {{user}} 编造消息。
4. 语言必须符合 ${name} 的语言风格与口癖；内容须与两人当前关系、最新剧情进展、当前时间地点一致。
5. ${MEDIUM_RULE(style)}
6. 富媒体前缀按上方【富媒体类型】块的时机与结构使用，滥用会破坏真实感。
7. 若资料参考与最新正文进展冲突，以正文进展为准。`;

const FORMAT_RULES_GROUP = (
  members: string[],
  injected: string[],
  style: PhoneStyle = '',
  mentions?: GroupMentions,
  atmoNames: string[] = [],
  pendingAtmosphere = 0,
  hiddenAtmoCount = 0,
) => {
  const atmoParts = [...atmoNames];
  if (pendingAtmosphere > 0) atmoParts.push('本轮新生成的气氛组');
  const hasAtmo = atmoParts.length > 0;
  const atmoLabel = atmoParts.length ? atmoParts.join('、') : '气氛组';
  const atmoSpeak = hasAtmo ? `；气氛组（${atmoLabel}）可作为背景自然接话` : '';
  // 限流时（注入名单≠全员）：发言人限于注入名单 + 聊天中被提到的人物
  const speakerRule = injected.length && injected.length < members.length
    ? `3. 回复主要由 ${injected.join('、')} 及聊天中被角色和用户提到过的人物进行${atmoSpeak}；严禁替 {{user}} 编造消息。`
    : `3. 只能以群成员（${members.join('、')}${hasAtmo ? `）及气氛组（${atmoLabel}` : ''}）的身份发言，严禁替 {{user}} 编造消息。`;
  const hiddenRule = hiddenAtmoCount > 0 ? `本轮未被选中的 ${hiddenAtmoCount} 位气氛组不要发言。` : '';
  const atmoRules = hasAtmo ? `
8. 本轮焦点气氛组（${atmoLabel}）是群里的普通群友：只偶尔接话、附和、吐槽、起哄；每轮最多 2～4 人各说 1 句短话，不是每轮都必须有人说话；气氛组总发言量不超过正式成员，不推动主线，不替正式成员或 {{user}} 表态。${hiddenRule}
9. 气氛组只发纯文本短句，不使用图片/语音/转账/红包/备忘/退群等任何前缀或动作。` : '';
  const mentionRule = mentions && mentions.atAll
    ? `\n${hasAtmo ? 10 : 8}. ${hasAtmo
      ? '本轮@了所有人：所有正式成员须优先回应；全部气氛组已读入，可自然接话，不必人人发言。'
      : '本轮@了所有人，所有成员须优先回应。'}`
    : mentions && mentions.names.length
      ? `\n${hasAtmo ? 10 : 8}. 本轮被@：${mentions.names.join('、')}，被@的成员必须优先回应。`
      : '';
  const headTag = pendingAtmosphere > 0 ? `${ATMO_OPEN_TAG} 与 ${REPLY_OPEN_TAG}` : REPLY_OPEN_TAG;
  return `【规则】
1. 只输出 ${headTag} 块，块外不要有任何文字。
2. 每行一条消息（注明发言者），模拟群聊里多人接话的节奏，条数按聊天发展自然决定。
${speakerRule}
4. 多名成员可以互相接话、斗嘴，须符合各自的语言风格与彼此关系。
5. ${MEDIUM_RULE(style)}
6. 富媒体前缀按上方【富媒体类型】块的时机与结构使用，滥用会破坏真实感。
7. 若资料参考与最新正文进展冲突，以正文进展为准。${atmoRules}${mentionRule}`;
};

function outputFormatExample(names: string[]): string {
  const a = names[0];
  const b = names[1] || a;
  return `${REPLY_OPEN_TAG}
${a}: 消息文本
${b}: [富媒体前缀]按【富媒体类型】块的结构要求（仅在时机合适时使用）
${REPLY_CLOSE_TAG}`;
}

/** 有待生成气氛组时的两块输出示例（atmo 先、reply 后）。 */
function outputFormatExampleWithAtmo(names: string[]): string {
  const a = names[0] || '群成员';
  const b = names[1] || a;
  return `${ATMO_OPEN_TAG}
阿强|男|同部门同事|爱接梗，说话直
小美|女|楼下咖啡店店员|话少，偶尔毒舌
${ATMO_CLOSE_TAG}
${REPLY_OPEN_TAG}
${a}: 消息文本
${b}: 消息文本
${REPLY_CLOSE_TAG}`;
}

/** 待生成气氛组任务段（同一条请求内先设定、再对话）。 */
function pendingAtmosphereTask(
  count: number,
  blocked: string[],
  batches: AtmosphereRequirementBatch[] = [],
): string {
  const activeBatches = batches.filter(b => b.count > 0);
  const withReq = activeBatches.filter(b => Boolean(b.requirement));
  let reqSection = '';
  let conflictRule = '';
  if (withReq.length) {
    if (withReq.length === 1 && withReq[0].count === count) {
      reqSection = `\n- 本批额外要求（姓名、性别、身份与性格都必须遵守）：${withReq[0].requirement}`;
    } else {
      reqSection = `\n- 共 ${count} 位，按以下批次生成，不同批次之间也不要重名：\n${activeBatches.map(b => `  · ${b.count} 位：${b.requirement || '无额外要求'}`).join('\n')}`;
    }
    conflictRule = '\n- 额外要求优先满足；若与姓名/字段规则（姓名 2～12 字且不含空格/@/分隔符；性别、身份、性格长度）或已有名字冲突，以规则为准。';
  }
  const blockedLine = blocked.length ? `\n- 不要与以下已有名字重复：${blocked.join('、')}。` : '';
  const reqOnlyRule = withReq.length ? '\n- 额外要求只约束生成字段，不要写进性格原文、聊天内容或系统提示。' : '';
  return `\n\n【本群待生成群友】
本群还有 ${count} 位气氛组群友尚未设定。请先在 ${ATMO_OPEN_TAG} 块内为每人写一行「姓名|性别|身份|一句性格」，再在 ${REPLY_OPEN_TAG} 块内让他们像普通群成员一样自然参与聊天（不必人人发言）。${reqSection}${conflictRule}
- 姓名 2～12 字，符合当前世界观与群氛围。${blockedLine}
- 性别只写「男」「女」或「其他」。
- 身份 2～20 字：写清群内/社会身份或与群的关系（如：同部门同事、楼下咖啡店店员、健身房常客），不要写背景故事。
- 性格只写 12～30 字的一句话，具体、有区分度、适合在群聊里接话。
- 性别、身份、性格都要有区分度；不要所有人同一种身份或同一种性格。${reqOnlyRule}
- 气氛组只是普通群友，与主角泛泛之交；不要设定成重要角色或与主角有亲密关系。
- ${ATMO_OPEN_TAG} 必须先于 ${REPLY_OPEN_TAG}；atmo 块只用于设定，不要出现在聊天记录里。`;
}

export interface InstructionArgs {
  roster: RosterSnapshot;
  conversation: Conversation;
  userText: string;
  extraPrompt: string;
  /** 绿灯注入名单（群聊>5人时≠全员，规则3随之改写）。 */
  injectedMembers?: string[];
  /** 本批被@情况（群聊；被@成员须优先回应）。 */
  mentions?: GroupMentions;
  /** 待生成气氛组人数（>0 时同一请求追加 <ubp_atmo> 先设定、<ubp_reply> 后对话）。 */
  pendingAtmosphere?: number;
  /** 本轮焦点气氛组名单（缺省=全部 ready，兼容旧调用；空数组=无焦点）。 */
  focusAtmosphereNames?: string[];
  /** 不可重名名单（主角/正式成员/已生成气氛组/通讯录角色）。 */
  blockedAtmosphereNames?: string[];
  /** 聊天分支（缺省按会话类型推导：群聊=group，私聊=private）。 */
  branch?: ChatBranch;
  /** 界面风格（仙侠=符讯措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
  /** 语音情绪/演绎是否入富媒体块（= TTS 总开关 + 情绪演绎开关；缺省 true）。
   *  关闭时语音条目只教学 `[语音]转写`（无 |情绪 前缀、无情绪尾注），其余类型逐字不变。 */
  voiceEmotion?: boolean;
}

/** 富媒体块选项（三处指令共用同一份口径）。 */
function mediaOpts(args: InstructionArgs): { voiceEmotion: boolean; currencyUnit?: string } {
  // 货币联动：常用货币名注入转账/红包结构（关/无币种 = 不注入，回落各风格默认措辞）
  const common = payCommon();
  return { voiceEmotion: args.voiceEmotion !== false, ...(common ? { currencyUnit: common.name } : {}) };
}

/** 私聊指令（user_input）。 */
export function buildPrivateInstruction(args: InstructionArgs): string {
  const name = args.conversation.members[0] || '对方';
  const me = args.roster.protagonistName;
  const style = args.style || '';
  const userBlock = args.userText.trim()
    ? args.userText.trim()
    : s(style,
      `（我方未发送新消息——请让 ${name} 主动继续话题或开启新话题）`,
      `（我方未发出新符讯——请让 ${name} 主动延续话头或开启新话题）`,
      `（我方未送出新书信——请让 ${name} 主动延续话头或开启新话题）`,
      `（我方未发出新晶讯——请让 ${name} 主动延续话头或开启新话题）`);
  const extra = args.extraPrompt.trim() ? `\n\n${args.extraPrompt.trim()}` : '';
  return `${s(style,
    `【任务】模拟手机即时聊天。当前场景：${me}（即 {{user}}，我方）正在和 ${name} 进行一对一手机聊天。`,
    `【任务】模拟传讯玉简符讯。当前场景：${me}（即 {{user}}，我方）正在与 ${name} 以传讯玉简互刻符讯。`,
    `【任务】模拟天机匣飞鸽书信。当前场景：${me}（即 {{user}}，我方）正在与 ${name} 以飞鸽互传书信。`,
    `【任务】模拟传讯水晶晶讯。当前场景：${me}（即 {{user}}，我方）正在与 ${name} 以水晶互传晶讯。`)}

我方刚刚发送：
${userBlock}

【输出格式】（严格遵守）
${outputFormatExample([name])}

${buildRichMediaPromptBlock('private', style, mediaOpts(args))}

${buildMemoPromptBlock({ branch: 'private', style })}

${FORMAT_RULES_PRIVATE(name, style)}${extra}`;
}

/** 群聊指令（user_input）。 */
export function buildGroupInstruction(args: InstructionArgs): string {
  const members = args.conversation.members;
  const injected = args.injectedMembers || members;
  const me = args.roster.protagonistName;
  const style = args.style || '';
  const allAtmo = readyAtmosphereMembers(args.conversation);
  const focusSet = Array.isArray(args.focusAtmosphereNames) ? new Set(args.focusAtmosphereNames) : null;
  const atmoNames = (focusSet ? allAtmo.filter(a => focusSet.has(a.name)) : allAtmo).map(a => a.name);
  const hiddenAtmoCount = Math.max(0, allAtmo.length - atmoNames.length);
  const pendingAtmosphere = Math.max(0, Math.floor(args.pendingAtmosphere || 0));
  const pendingBatches = pendingAtmosphereBatches(args.conversation);
  const userBlock = args.userText.trim()
    ? args.userText.trim()
    : s(style,
      `（我方未发送新消息——请让群成员们继续聊下去或开启新话题）`,
      `（我方未发出新符讯——请让盟友们继续谈下去或开启新话题）`,
      `（我方未送出新书信——请让同道们继续谈下去或开启新话题）`,
      `（我方未发出新晶讯——请让同仁们继续谈下去或开启新话题）`);
  const extra = args.extraPrompt.trim() ? `\n\n${args.extraPrompt.trim()}` : '';
  const memberLabel = s(style, '正式成员', '盟友', '同道', '同仁');
  const atmoLabel = s(style, '气氛组', '闲谈道友', '捧场朋友', '闲聊同伴');
  const memberClause = atmoNames.length
    ? `${memberLabel}：${members.join('、')}；${atmoLabel}（本轮焦点）：${atmoNames.join('、')}`
    : s(style,
      `成员：${members.join('、')}`,
      `盟友：${members.join('、')}`,
      `同道：${members.join('、')}`,
      `同仁：${members.join('、')}`);
  return `${s(style,
    `【任务】模拟手机即时聊天。当前场景：群聊「${args.conversation.title}」（${memberClause}），${me}（即 {{user}}，我方）在群里。`,
    `【任务】模拟传讯玉简符讯。当前场景：道盟「${args.conversation.title}」（${memberClause}），${me}（即 {{user}}，我方）在盟中共谈。`,
    `【任务】模拟天机匣飞鸽书信。当前场景：群英会「${args.conversation.title}」（${memberClause}），${me}（即 {{user}}，我方）在会中共话。`,
    `【任务】模拟传讯水晶晶讯。当前场景：圆桌「${args.conversation.title}」（${memberClause}），${me}（即 {{user}}，我方）在桌旁商谈。`)}${pendingAtmosphere ? pendingAtmosphereTask(pendingAtmosphere, args.blockedAtmosphereNames || [], pendingBatches) : ''}

我方刚刚发送：
${userBlock}

【输出格式】（严格遵守）
${pendingAtmosphere
    ? outputFormatExampleWithAtmo(injected.length > 1 ? injected : members)
    : outputFormatExample(injected.length > 1 ? injected : members)}

${buildRichMediaPromptBlock('group', style, mediaOpts(args))}

${buildMemoPromptBlock({ branch: 'group', style })}

${FORMAT_RULES_GROUP(members, injected, style, args.mentions, atmoNames, pendingAtmosphere, hiddenAtmoCount)}${extra}`;
}

/** 好友申请指令（user_input）：非好友私聊分支——AI 只做 通过/拒绝 裁决（通过后可立刻说话）。 */
export function buildFriendRequestInstruction(args: InstructionArgs): string {
  const name = args.conversation.members[0] || '对方';
  const me = args.roster.protagonistName;
  const style = args.style || '';
  const reasonBlock = args.userText.trim() || s(style,
    '（我方未附上申请理由）', '（我方未附上结交缘由）', '（我方未附上结识缘由）', '（我方未附上引荐缘由）');
  const extra = args.extraPrompt.trim() ? `\n\n${args.extraPrompt.trim()}` : '';
  return `${s(style,
    `【任务】模拟手机好友申请。当前场景：${me}（即 {{user}}，我方）向 ${name} 发送了好友申请，两人还不是好友，${name} 将决定是否通过。`,
    `【任务】模拟传讯玉简名帖。当前场景：${me}（即 {{user}}，我方）向 ${name} 递上了名帖，两人尚未结为道友，${name} 将决定是否应允。`,
    `【任务】模拟天机匣拜帖。当前场景：${me}（即 {{user}}，我方）向 ${name} 递上了拜帖，两人尚未互通名帖，${name} 将决定是否应下。`,
    `【任务】模拟传讯水晶荐书。当前场景：${me}（即 {{user}}，我方）向 ${name} 递上了荐书，两人尚未结为同伴，${name} 将决定是否应允。`)}

${s(style, '申请理由：', '结交缘由：', '结识缘由：', '引荐缘由：')}
${reasonBlock}

【输出格式】（严格遵守）
${REPLY_OPEN_TAG}
${name}: [通过]
${name}: ${s(style, '通过后立刻想说的话', '应允后立刻想说的话', '应下后立刻想说的话', '应允后立刻想说的话')}（正常消息行，仅在通过时输出）
${REPLY_CLOSE_TAG}

${buildRichMediaPromptBlock('friend-request', style, mediaOpts(args))}

【规则】
1. 只输出 ${REPLY_OPEN_TAG} 块，块外不要有任何文字。
2. 以 ${name} 的身份决定是否${s(style,
    '通过本次好友申请：愿意则单独一行 [通过]，不愿意则 [拒绝]理由',
    '应允此次结交：愿意则单独一行 [通过]，不愿意则 [拒绝]婉拒缘由',
    '应下此次结交：愿意则单独一行 [通过]，不愿意则 [拒绝]婉拒缘由',
    '应允此次结伴：愿意则单独一行 [通过]，不愿意则 [拒绝]婉拒缘由')}；一轮只给一个决定。
3. ${s(style, '通过后', '应允后', '应下后', '应允后')}可以紧接正常消息行（模拟${s(style, '通过后立刻说话', '应允后立刻说话', '应下后立刻说话', '应允后立刻说话')}），语言须符合 ${name} 的风格；拒绝后本轮不要再输出其他消息行。
4. 决定必须符合 ${name} 的性格、对主角的态度与两人当前关系；此前的${s(style, '申请、拒绝与拉黑记录', '名帖、婉拒与两清记录', '拜帖、婉拒与决裂记录', '荐书、婉拒与绝交记录')}见「最近手机记录」段，再次申请时的反应要与历史连贯。
5. 只能以 ${name} 的身份发言，严禁替 {{user}} 编造消息。
6. 若资料参考与最新正文进展冲突，以正文进展为准。${extra}`;
}

export function buildChatInstruction(args: InstructionArgs): string {
  const branch: ChatBranch = args.branch
    || (args.conversation.kind === 'group' ? 'group' : 'private');
  if (branch === 'friend-request') return buildFriendRequestInstruction(args);
  return branch === 'group' ? buildGroupInstruction(args) : buildPrivateInstruction(args);
}
