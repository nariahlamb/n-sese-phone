// ===== 窥私提示词模板（角色间私密互动演绎；契约 <ubp_spy>，三段式①触发②资料块③指令） =====
// 结构对齐 chat-prompts：档案/关系段复用 contactSection/relationSection；焦点群最近消息复用
// formatMessageHistory（群聊口径 GROUP_RECENT_MESSAGES=20）；富媒体块复用 rich-media 注册表
// （group 分支=私聊/群聊段通用集合，另加窥私专属 [拉人]）。窥私历史不进资料块——经世界书
// 分角色绿灯条目（角色名触发）注入，本文件只做「保持连贯」的引用。
// 所有用户可见措辞走 s() 四参（现代为事实源；解析标记/[标签] 协议全风格不变）。

import type { Conversation, PhoneStyle } from './chat-model';
import { contactSection, GROUP_RECENT_MESSAGES, relationSection } from './chat-prompts';
import { buildRichMediaPromptBlock } from './rich-media';
import type { RosterSnapshot } from './roster';
import { s } from './skins';
import { formatMessageHistory } from './phone-timeline';

// 契约标签集中到 core/protocol-tags（单一事实源）；import 后原样 re-export，既有 import 路径不变。
import { SPY_CLOSE_TAG, SPY_OPEN_TAG } from './protocol-tags';
export { SPY_CLOSE_TAG, SPY_OPEN_TAG };
/** 每块消息行数指引下限（上限由解析器兜底）。 */
export const SPY_BLOCK_MIN_LINES = 4;
export const SPY_BLOCK_MAX_LINES = 12;

// ─── ① 绿灯触发文本（position:'none' + should_scan:true；只携带焦点人名 → 激活角色条目） ───

export function buildSpyTrigger(focus: readonly string[]): string {
  return focus.filter(Boolean).join(' ');
}

// ─── ② 资料块（after_system + should_scan:false） ───

export interface SpyDossierArgs {
  roster: RosterSnapshot;
  /** 本轮焦点人物（排除在场角色后的随机名单）。 */
  focus: readonly string[];
  /** 焦点群聊（含 ≥3 焦点人物的已有窥私群；null=没有）。 */
  focusGroup: Conversation | null;
  /** 含 ≥3 焦点人物的已有窥私群清单。 */
  existingGroups: readonly Conversation[];
  /** 本场会话（会话内长按生成「接着演」；不传=列表页随机生成，资料块逐字等于现状）。 */
  focusConversation?: Conversation | null;
  /** H′ 既有记录兜底：与焦点相关的既有会话（无焦点会话且世界书通道关闭时引擎传入；不传=本段不存在）。 */
  historyConvs?: readonly Conversation[];
  /** 既有记录每场条数（跟随「窥私记忆条数」设置）。 */
  historyCount?: number;
  /** 剧情纪要块（readChronicleDossierBlocks，焦点并集、每角色保底取含名纪要）。 */
  chronicleBlocks: string;
  /** 最近 N 层正文（过上下文标签剥离）。 */
  storyText: string;
  style: PhoneStyle;
}

export function buildSpyDossierText(args: SpyDossierArgs): string {
  const style = args.style || '';
  const sections: string[] = [s(style,
    '【窥私资料参考（角色间私密互动的演绎依据，非剧中人所知）】',
    '【窥私资料参考（角色间私密符讯的演绎依据，非剧中人所知）】',
    '【窥私资料参考（角色间私密书信的演绎依据，非剧中人所知）】',
    '【窥私资料参考（角色间私密晶讯的演绎依据，非剧中人所知）】')];
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
  sections.push(`■ 焦点人物档案（数据库表格）\n${args.focus.map(m => contactSection(args.roster, m)).join('\n')}`);
  const relations = relationSection(args.roster, [...args.focus]);
  sections.push(`■ 焦点人物之间的关系\n${relations}`);
  const groupLines = args.existingGroups.map(c =>
    `- 「${c.title}」（群主：${c.owner || '未记录'}；成员：${c.members.join('、')}）`);
  sections.push(`■ 已有群聊（群聊优先发生在这些群里；空=暂无，可新建）\n${groupLines.length ? groupLines.join('\n') : '（暂无）'}`);
  if (args.focusGroup) {
    const recent = formatMessageHistory(args.focusGroup.messages, GROUP_RECENT_MESSAGES);
    sections.push(`■ 焦点群聊「${args.focusGroup.title}」最近消息（最近 ${recent.units} 条，从旧到新；本轮群聊块必须发生在该群）\n${recent.body || '（本群还没有消息）'}`);
  }
  // 本场最近消息（会话内「接着演」专用段；不传 focusConversation 时本段不存在——与微信群聊「本群最近消息」同款口径）
  if (args.focusConversation) {
    const conv = args.focusConversation;
    const recent = formatMessageHistory(conv.messages, GROUP_RECENT_MESSAGES);
    const label = conv.kind === 'group' ? `本场群聊「${conv.title}」最近消息` : '本场会话最近消息';
    sections.push(`■ ${label}（最近 ${recent.units} 条，从旧到新；本轮内容须延续该会话）\n${recent.body || '（本会话还没有消息）'}`);
  }
  // H′ 既有记录兜底（列表页/自动生成且世界书通道关闭时：过去聊过什么只能从这里进上下文）
  if (args.historyConvs && args.historyConvs.length) {
    const n = Math.max(1, Math.floor(args.historyCount || 20));
    const blocks = args.historyConvs.map(conv => {
      const recent = formatMessageHistory(conv.messages, n);
      const head = conv.kind === 'group'
        ? `【群聊】${conv.title}（群主：${conv.owner || '未记录'}；成员：${conv.members.join('、')}）`
        : `【私聊】${conv.members[0] || '?'} ⇄ ${conv.members[1] || '?'}`;
      return `${head}（最近 ${recent.units} 条，从旧到新）\n${recent.body || '（本会话还没有消息）'}`;
    });
    sections.push(`■ 既有记录（本轮之前已经发生过的互动，接着往下写；已经聊过的不必复述）\n${blocks.join('\n')}`);
  }
  if (args.storyText) {
    sections.push(`■ 最近正文进展（供衔接剧情）\n${args.storyText}`);
  }
  return sections.join('\n\n');
}

// ─── ③ 指令模板（user_input） ───

export interface SpyInstructionArgs {
  focus: readonly string[];
  focusGroup: Conversation | null;
  /** 本场会话（会话内「接着演」；不传=指令逐字等于现状）。 */
  focusConversation?: Conversation | null;
  count: number;
  extraPrompt: string;
  style: PhoneStyle;
  /** 语音情绪/演绎是否入富媒体块（= TTS 总开关 + 情绪演绎开关；缺省 true）。 */
  voiceEmotion?: boolean;
}

function spyMediumRule(style: PhoneStyle): string {
  return s(style,
    '手机聊天/通话是轻松的口语媒介：句子短、可用语气词；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
    '符讯与传音是修士间的轻快媒介：句子短、口语为主，可自然带修真用语，但不要文绉绉；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
    '飞鸽书信与传声是江湖人往来的媒介：句子短、白话为主，可自然带江湖口吻，但不要文绉绉；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。',
    '晶讯与远语是冒险者间的轻快媒介：句子短、口语为主，可自然带奇幻比喻，但不要文绉绉；不要写作文，不要旁白，严禁用括号补充动作、神态、语气等非发言内容。');
}

export function buildSpyInstruction(args: SpyInstructionArgs): string {
  const style = args.style || '';
  const focus = args.focus.filter(Boolean);
  const count = Math.max(1, Math.floor(args.count));
  // 与主角有关的块数：尽量五五开（四舍五入取整）且至少 1（用户定案：侧面关联即算——对主角的情感/主角卷入的近期事件/牵涉话题，不刻板议论主角本人）
  const userRelated = Math.max(1, Math.round(count / 2));
  const userAngle = '角度自由：可以聊彼此对主角的情感与心思、聊主角卷入的近期事件，或任何从侧面牵涉到主角的话题，不必直接议论主角本身；主角只是被关联，绝不出场、不发言';
  const userRule = userRelated >= count
    ? `- ${count} 块内容都与主角（{{user}}）有关，${userAngle}。`
    : `- 其中 ${userRelated} 块与主角（{{user}}）有关，${userAngle}；其余 ${count - userRelated} 块与主角无关。`;
  const focusLine = `本轮焦点人物：${focus.join('、')}`;
  // 本场会话（接着演）：群聊=当前群必须承载群聊块；私聊=追加一对一延续约束（群聊规则回落「凑不齐不生成」）
  const focusConv = args.focusConversation || null;
  const groupRule = focusConv
    ? (focusConv.kind === 'group'
      ? `- 群聊：本轮在当前会话群「${focusConv.title}」（成员：${focusConv.members.join('、')}）里继续，群聊块必须发生在该群，可自然延续既有话题或开启新话题。`
      : `- 群聊：焦点人物凑不齐 3 人或没有合适的群聊对象时则不生成群聊块。`)
    : args.focusGroup
      ? `- 群聊：有进行中的焦点群聊「${args.focusGroup.title}」（成员：${args.focusGroup.members.join('、')}），群聊块必须发生在该群，可自然延续既有话题或开启新话题。`
      : `- 群聊：优先包含${count >= 2 ? '至少 1 块群聊' : '1 块群聊'}；焦点人物凑不齐 3 人或没有合适的群聊对象时则不生成群聊块；新建一个（群名贴合成员关系与近期剧情，指定群主，成员全部来自焦点人物）。`;
  const [a, b] = [focusConv?.members[0] || '', focusConv?.members[1] || ''];
  const continueRule = focusConv && focusConv.kind === 'private'
    ? `\n${s(style,
      `- 本场延续：私聊块与通话块必须发生在「${a}」与「${b}」之间（当前会话双方），延续其既有话题，不要另开与他人的一对一互动。`,
      `- 本场延续：一对一符讯块与传音块必须发生在「${a}」与「${b}」之间（当前会话双方），延续其既有话题，不要另开与他人的一对一互动。`,
      `- 本场延续：书信块与传声块必须发生在「${a}」与「${b}」之间（当前会话双方），延续其既有话题，不要另开与他人的一对一互动。`,
      `- 本场延续：一对一晶讯块与远语块必须发生在「${a}」与「${b}」之间（当前会话双方），延续其既有话题，不要另开与他人的一对一互动。`)}`
    : '';
  const extra = args.extraPrompt.trim() ? `\n\n${args.extraPrompt.trim()}` : '';
  return `${s(style,
    `【任务】演绎主角（{{user}}）视线之外的通讯录角色之间的私密手机互动。这些互动发生在最近的剧情背景下：主角不在场、也不知晓这些内容；角色们各自按性格与彼此关系主动联系。`,
    `【任务】演绎主角（{{user}}）视线之外的修士之间的私密符讯互动（传音/一对一符讯/共谈）。这些互动发生在最近的剧情背景下：主角不在场也不知晓；修士们各自按性格与彼此关系主动传讯。`,
    `【任务】演绎主角（{{user}}）视线之外的江湖人之间的私密书信互动（传声/飞鸽书信/群英会）。这些互动发生在最近的剧情背景下：主角不在场也不知晓；江湖人各自按性格与彼此关系主动传书。`,
    `【任务】演绎主角（{{user}}）视线之外的冒险者之间的私密晶讯互动（远语/一对一晶讯/圆桌商谈）。这些互动发生在最近的剧情背景下：主角不在场也不知晓；冒险者们各自按性格与彼此关系主动联络。`)}

${focusLine}
【生成要求】
- 最多生成 ${count} 块内容（通话/私聊/群聊自由组合，每块独立成段，话题互不重复、时间上都在最近发生）；找不到合适的互动对象时宁可少生成一块，绝不为凑数虚构或挪用名单外的人物。
- 所有互动只发生在「本轮焦点人物」名单内：通话/私聊的双方、群聊的群主与全部成员、每一行的发言者都必须是名单中的人物。
${userRule}
${groupRule}${continueRule}
- 每块 ${SPY_BLOCK_MIN_LINES}~${SPY_BLOCK_MAX_LINES} 行左右，模拟真人节奏。

【输出格式】（严格遵守；整段输出以 ${SPY_OPEN_TAG} 开头、${SPY_CLOSE_TAG} 结尾，只输出这一个块，块外不要有任何文字）
- 每块以块头行开头，块头行之后直接跟对话行，每行「名字：内容」。
- 通话块头行：[通话]拨出方|接听方（可加第三段：未接，或通话秒数；通话只有你一言我一语的对话行，不用富媒体前缀）。
- 私聊块头行：[私聊]A|B。
- 群聊块头行：[群聊]群名|群主：X|成员、成员、成员（复用「已有群聊」清单里的群时，群名必须逐字一致）。
- 群聊里 @某人 直接写 @名字；群主加人一行 [拉人]名字（只能由群主发出）；成员退出一行 [退群]理由。

${buildRichMediaPromptBlock('group', style, { voiceEmotion: args.voiceEmotion !== false })}

【规则】
1. 只输出 ${SPY_OPEN_TAG} 块，块外不要有任何文字。
2. 所有互动只发生在本轮焦点人物之间；严禁出现主角（{{user}}）、「我」或名单外的人物发言——与主角有关的内容只从侧面关联主角，主角本人不参与任何互动；宁可少生成一块，也不得让名单外的人物出场或发言。
3. 各角色严格按档案的语言风格与口癖说话；内容须符合彼此关系、近期剧情与当前时间地点，群聊延续既有群内的相处氛围。
4. ${spyMediumRule(style)}
5. 富媒体前缀按上方【富媒体类型】块的时机与结构使用（[拉人]/[退群] 动作行除外）；滥用会破坏真实感。
6. 角色间近期的通话/私聊/群聊记录（世界书提供的「最近窥私记录」）是延续的过往：新内容与其连贯，不要复述已经发生过的内容。
7. 若资料参考与最近正文进展冲突，以正文进展为准。${extra}`;
}