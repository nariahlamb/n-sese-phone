// ===== 游戏中心提示词层（纯函数，零运行时依赖；docs/16-游戏中心功能规格.md §2.7/§4.4/§5） =====
// 纪律：提示词只写要求不解释；输出协议三段（think 即时思考 / situation 整局局势分析 / 行动标签）。
// 人设注入 = 公共认知层（全员一致：性格/口癖/公开关系/社交动态）+ 私有层（本人档案/对主角态度/性格偏移）。

import { npcPersona } from './game-npc';
import { VOICE_EMOTION_HINT } from './rich-media';
import type { GameType } from './game-model';
import type { RosterSnapshot } from './roster';

/** 陌生玩家纪律（docs/16 §10）：补位 NPC 与在场诸位素不相识，防 AI 编造旧交。 */
const STRANGER_DISCIPLINE = '4. 席位标注「陌生玩家」的人与本局其他人素不相识（临时拼桌）：你与TA没有旧交，严禁编造共同回忆、旧关系或共同好友，按初次见面的方式试探与相处。';

// ─── 台词语音标注（游戏侧）──
// 由引擎按坐席判定后注入：真实角色（通讯录/自定义联系人/主持人）=带标注；补位🎭NPC 与玩家=不带（纯文本）。
// 情绪八词与「怎么演」四维度措辞直接复用聊天语音的 VOICE_EMOTION_HINT（rich-media 单一事实源，零 import 叶模块）。

/** 语音提示行（'' = 非语音坐席，行动段逐字保持原样）。 */
function voiceHintLine(on: boolean): string {
  return on ? `（本句台词会被语音念出）${VOICE_EMOTION_HINT}` : '';
}

/** 语音标注前缀（'' = 无）；解析层由 game-parser.splitSpeechVoice 拆出情绪/演绎。 */
function voiceTag(on: boolean): string {
  return on ? '[语音|情绪]' : '';
}

// ─── 规则串 ───

export const UNDERCOVER_RULES = '4-6人局：1卧底、其余为平民，平民共用同一词语，卧底拿词义相近的另一词。每人每轮一句话描述自己的词（严禁说出词语本身或透露字数）。全员描述完毕后投票放逐一人，最高票出局并当场亮明身份，平票无人出局进入下一轮。卧底被放逐=平民胜；场上存活≤3人且卧底存活=卧底胜。';

// ─── 谁是卧底词对回退池（主持人分词解析失败时随机取用；主题分组） ───

export const UNDERCOVER_WORD_PAIRS: readonly (readonly [string, string])[] = [
  ['牛肉面', '拉面'], ['婚纱', '头纱'], ['粽子', '汤圆'], ['吉他', '尤克里里'], ['麦克风', '话筒'],
  ['口红', '唇膏'], ['风扇', '空调'], ['眉毛', '睫毛'], ['纸巾', '手帕'], ['自行车', '电动车'],
  ['奶茶', '咖啡'], ['包子', '饺子'], ['地铁', '公交车'], ['图书馆', '书店'], ['医生', '护士'],
  ['老师', '教授'], ['苹果', '梨'], ['西瓜', '哈密瓜'], ['雨伞', '雨衣'], ['枕头', '抱枕'],
  ['牙刷', '牙膏'], ['洗发水', '沐浴露'], ['手机', '平板'], ['电视', '显示器'], ['钢琴', '电子琴'],
  ['篮球', '排球'], ['跑步', '竞走'], ['春节', '元旦'], ['中秋', '端午'], ['火车', '高铁'],
  ['酒店', '宾馆'], ['婚礼', '订婚'], ['蜜蜂', '蝴蝶'], ['老虎', '狮子'], ['月亮', '太阳'],
];

// ─── 系统总纲（system 槽；谁是卧底角色请求共享） ───

export function buildUndercoverSystemPrompt(): string {
  return `你是熟人局《谁是卧底》桌游中的 AI 扮演者。这是一场主角与好友们围坐聚会的桌游：被投票放逐只是游戏出局，严禁真实死亡描写，出局反应只能是真人桌游玩家的情绪（喊冤、吐槽、大笑、复盘）。

【角色扮演纪律】
1. 完全代入你扮演的角色：语气、口癖、性格、对主角与其他玩家的态度贯穿始终。
2. 描述与投票都要有熟人间互动感：结合人物关系与社交动态调侃、试探、抱团、喊冤。
3. 你的目标：①让自己的描述听起来与大家一致、不被当成异类；②从别人的描述里找出与你词语明显不符的人。严禁公然放水，也严禁为了藏词而给出空洞无信息的描述。
${STRANGER_DISCIPLINE}

【发言纪律】
1. 描述严禁直接说出你的词语、严禁透露词语字数、严禁过于直白暴露词汇。
2. 描述必须与此前所有玩家的描述角度不同（从用途、特征、感受、场景等另选切入点）；轮次越后越难，可适当模糊，但不能空洞到没有信息。
3. 严禁描写动作、表情、旁白或括号补充；一句话描述语义完整自然收尾。
4. 身份未明时描述偏保守：只讲你词语最公认、最不易出错的共同点，不给能暴露词义边界的细节（越具体越容易露怯）；判断出自己确实拿了卧底词之后，才转向模糊带过、避免被锁定。

【防开天眼铁律】
主持人不公布身份：你只知道自己的词语，无法确定自己拿到的是平民词还是卧底词——平民词与卧底词分别是什么、谁拿了哪一边，你都只能从描述里推测；其他玩家的词语与身份对你未知；其他玩家的即时思考与局势分析对你不可见。

【输出协议】
每次回复依次输出三段，缺一不可：
1. <think>你此刻的即时想法，简短自然（当下的心理活动与直觉判断）</think>
2. <situation>到此刻为止整局的完整局势分析，上限1000字，每次完整重写覆盖：必须概括局势发展关键信息（各玩家描述要点与违和点、已出局者的词与身份）、可疑度排序、你的词语策略与后续计划——这是你继承到下一次行动的完整记忆，务必自足完整</situation>
3. 按行动指令要求输出行动标签段。`;
}

// ─── 视角上下文骨架（user 槽公共部分） ───

export interface GameSelfProfile {
  name: string;
  position: number;
  identity: string;
  personality: string;
  languageStyle: string;
  attitude: string;
  brief: string;
  /** 性格偏移表拼接文本（''=无数据整段省略）。 */
  personalityShift: string;
}

export interface GameContextArgs {
  rules: string;
  /** 已格式化的往期总结行（model.summaryPromptLines）。 */
  summaries: string;
  seats: string;
  profiles: string;
  socialHints: string;
  self: GameSelfProfile;
  /** 主角名与号位。 */
  userName: string;
  userPosition: number;
  history: string;
  lastSituation: string;
}

export function buildGameUserContext(args: GameContextArgs): string {
  const s = args.self;
  const sections: string[] = [
    `【本局规则】\n${args.rules}`,
  ];
  if (args.summaries.trim()) {
    sections.push(`【往期对局总结】（历史场次，与本局身份词语无关，仅用于了解这群人打牌的风格、口癖与恩怨）\n${args.summaries}`);
  }
  sections.push(`【本局席位】\n${args.seats}`);
  if (args.profiles.trim()) sections.push(`【玩家公开画像】\n${args.profiles}`);
  if (args.socialHints.trim()) sections.push(`【公开社交动态】\n${args.socialHints}`);
  const selfLines = [
    `身份背景：${s.identity || '未记录'}`,
    `性格特质：${s.personality || '未记录'}`,
    `说话习惯与口癖：${s.languageStyle || '未记录'}`,
    `对主角（${args.userPosition}号位 ${args.userName}）的态度：${s.attitude || '未记录'}`,
    `人物简介：${s.brief || '未记录'}`,
  ];
  sections.push(`【你的档案】\n${selfLines.join('\n')}`);
  if (s.personalityShift.trim()) {
    sections.push(`【你的性格偏移】\n${s.personalityShift}`);
  }
  sections.push(`【本局进程（你视角可见）】\n${args.history || '（尚无记录）'}`);
  sections.push(`【你的局势分析（你上一次行动留下的整局完整记忆）】\n${args.lastSituation || '（本局刚开始，尚无局势分析记录）'}`);
  return sections.join('\n\n');
}

// ─── 公开认知层构建（engine 传 roster 快照 + 社交动态原始行） ───

/** 席位行（「1号位 名A（主角本人，存活）」）。 */
export function buildSeatLines(
  players: Array<{ position: number; name: string; isUser: boolean; alive: boolean; npc?: boolean }>,
  selfPosition: number,
): string {
  return players.map(p => {
    const tags: string[] = [];
    if (p.isUser) tags.push('主角本人');
    if (p.position === selfPosition) tags.push('你');
    if (p.npc) tags.push('陌生玩家');
    if (!p.alive) tags.push('已出局');
    return `${p.position}号位 ${p.name}${tags.length ? `（${tags.join('，')}）` : ''}`;
  }).join('\n');
}

/** 公开画像行：性格关键词+说话习惯+两两公开关系（熟人间的公共知识）；补位 NPC 用确定性人设兜底且无关系。 */
export function buildPublicProfiles(
  roster: RosterSnapshot,
  players: Array<{ position: number; name: string; npc?: boolean }>,
): string {
  const names = players.map(p => p.name);
  const nameSet = new Set(names);
  const lines: string[] = [];
  for (const p of players) {
    if (p.npc) {
      const persona = npcPersona(p.name);
      const bits = persona
        ? [persona.personality, `说话${persona.languageStyle}`, '与在场诸位素不相识']
        : ['与在场诸位素不相识'];
      lines.push(`- ${p.position}号位 ${p.name}：${bits.join('；')}`);
      continue;
    }
    const c = roster.contacts.find(x => x.name === p.name);
    const bits: string[] = [];
    const personality = roster.personality[p.name] || '';
    if (personality) bits.push(personality.split('；')[0].slice(0, 60));
    else if (c?.brief) bits.push(c.brief.slice(0, 60));
    if (c?.languageStyle) bits.push(`说话${c.languageStyle.slice(0, 50)}`);
    const pairs = roster.relations
      .filter(r => nameSet.has(r.a) && nameSet.has(r.b) && (r.a === p.name || r.b === p.name))
      .slice(0, 4)
      .map(r => {
        const other = r.a === p.name ? r.b : r.a;
        return `与${other}${r.type || '有交情'}${r.state ? `（${r.state}）` : ''}`;
      });
    bits.push(...pairs);
    lines.push(`- ${p.position}号位 ${p.name}${bits.length ? `：${bits.join('；')}` : '：同局好友'}`);
  }
  return lines.join('\n');
}

/** 社交动态行（engine 从手机数据提炼：最近私聊预览/朋友圈摘要；空=整段省略）。 */
export function buildSocialHintLines(hints: Array<{ name: string; chat?: string; moment?: string }>): string {
  const lines: string[] = [];
  for (const h of hints) {
    const bits: string[] = [];
    if (h.chat) bits.push(`最近微信聊过：“${h.chat.slice(0, 35)}”`);
    if (h.moment) bits.push(`朋友圈发过：“${h.moment.slice(0, 30)}”`);
    if (bits.length) lines.push(`- ${h.name} ${bits.join('；')}`);
  }
  return lines.join('\n');
}

// ─── U1 主持人分词（功能请求：无 think/situation） ───

export function buildUndercoverHostRequest(playerLines: string): { system: string; user: string } {
  return {
    system: '你是《谁是卧底》主持人。只负责出词与分配，不参与发言与投票，词语全程保密。',
    user: `本局玩家：\n${playerLines}\n请生成一对同类、高度相近、难度适中的词语（如：牛肉面/拉面、婚纱/头纱、粽子/汤圆），随机指定其中1人拿到卧底词，输出（严格遵循格式，纯净中文词语，无标点、无引号、无Markdown）：\n平民词：X\n卧底词：Y\n分发：1号位为X；2号位为X；……（恰好1人为Y，其余为X）`,
  };
}

// ─── U2 描述发言（user 追加段） ───

export function buildUndercoverSpeechAction(args: {
  round: number;
  position: number;
  name: string;
  word: string;
  speeches: string;
  /** 真实角色坐席=true：台词带语音标注。补位🎭NPC / 玩家坐席不传（默认纯文本）。 */
  voiceEmotion?: boolean;
}): string {
  const v = args.voiceEmotion === true;
  return `【行动指令】现在是第${args.round}轮描述环节，轮到${args.position}号位 ${args.name}，你的词语：【${args.word}】。
（主持人不公布身份：你的词与多数人不同则你才是卧底，你只能从大家的描述里推测。）
【此前所有人的描述（含往轮）】
${args.speeches || '（你是本轮第一个发言的玩家）'}
请给出与此前所有人不同角度的一句话描述（口语化、语义完整、自然收尾）；判定自己身份之前描述偏保守，只讲最不易出错的共同点。${voiceHintLine(v)}
 thinking…</think>
<situation>含整局关键信息概括（各玩家描述要点与违和点排序）；逐一对照他人描述判断自己是否可能是卧底（多数人的描述与你的词明显不符=你很可能才是卧底），据此决定保守带过还是模糊搅浑；规划与此前所有人不同的全新切入点</situation>
<speech>${voiceTag(v)}真正说出口的一句话描述</speech>`;
}

// ─── U3 投票（user 追加段） ───

export function buildUndercoverVoteAction(args: {
  round: number;
  word: string;
  history: string;
  targets: string;
}): string {
  return `【行动指令】第${args.round}轮投票放逐。你的词语：【${args.word}】。
【本局全部描述与投票记录（你视角可见）】
${args.history || '（尚无记录）'}
【可选目标】${args.targets}（所有存活玩家，含你自己；也可弃票）
<think>…</think>
<situation>含整局关键信息概括；末段先对照全场描述判断自己是否可能是卧底（多数人的描述与你的词明显不符=你很可能才是卧底，此时应把怀疑引向别人、别让自己成为共识）；再逐一对照各玩家描述与你的词语 → 找出违和者与摸鱼者 → 权衡后给出明确结论（因此，我决定投票给X号位/弃票）</situation>
<VOTE_ACTION>
VOTE: 号位数字或0（0=弃票）
</VOTE_ACTION>`;
}

// ─── 赛后请求 A：总结 + 朋友圈 ───

export interface EpilogueArgs {
  gameTypeLabel: string;
  winnerSide: string;
  players: string[];
  detail: string;
  /** 公开层过程摘要（系统公告+发言+投票，从旧到新）。 */
  process: string;
  /** 往期总结行（文风参考）。 */
  pastSummaries: string;
  /** 人设速览行（名字：性格…；口癖…；对主角态度…）。 */
  profiles: string;
  /** AI 参与者名单（发帖人/评论人合法域）。 */
  aiPlayers: string[];
}

export function buildEpilogueRequest(args: EpilogueArgs): { system: string; user: string } {
  // 补位 NPC 不入发帖/评论池（docs/16 §10）；本局若没有真实好友参与则整条朋友圈跳过
  const momentSpec = args.aiPlayers.length
    ? `{"author":"从本局AI参与者（${args.aiPlayers.join('、')}）中挑本局最有戏的一人（被冤枉出局的、演技封神的、力挽狂澜的……），以TA的口吻发帖","text":"朋友圈正文，紧扣本局戏剧点，符合人设口癖，20~80字","comments":["除author外每个AI参与者1条评论，格式：名字|评论内容，符合各自人设与对局立场"]}`
    : 'null';
  return {
    system: '你是熟人桌游局的赛后记录员。任务：根据一局完整对局记录，产出本局总结与一条赛后人设朋友圈。全部输出必须贴合各角色的性格与口癖，不得出戏、不得出现真实死亡描写（游戏出局而已）。',
    user: `【本局信息】
游戏：${args.gameTypeLabel}；结果：${args.winnerSide}获胜；参赛者：${args.players.join('、')}；底牌/词语明细：${args.detail}
【本局过程记录（公开层）】
${args.process || '（记录缺失，依据明细与结果合理还原）'}
【往期总结（文风与选题参考，勿与雷同）】
${args.pastSummaries || '（暂无往期总结）'}
【参与者人设速览】
${args.profiles}
请输出（严格格式，JSON 内不要换行断裂）：
<game_epilogue>
{"summary":"本局总结：参与者+重点过程+结果，150字以内，供这群人下次打牌时回忆恩怨用","moment":${momentSpec}}
</game_epilogue>`,
  };
}

// ─── 赛后请求 B：高光播报 + 复盘聊天 ───

export interface HighlightArgs {
  gameType: GameType;
  gameTypeLabel: string;
  winnerSide: string;
  players: string[];
  detail: string;
  /** 全量 entries（含 think/situation/private，从旧到新）。 */
  fullLog: string;
  /** 全员完整档案（含性格偏移）。 */
  dossiers: string;
  relations: string;
}

export function buildHighlightRequest(args: HighlightArgs): { system: string; user: string } {
  const logHeader = args.gameType === 'werewolf'
    ? '【完整对局记录（上帝视角，含全部即时思考、整局局势分析与狼队密谋）】'
    : '【完整对局记录（上帝视角，含全部即时思考与整局局势分析）】';
  return {
    system: '你是熟人桌游局的赛事解说与群像扮演者。任务：根据一局完整对局（含所有人内心思考），产出戏剧化高光播报与赛后复盘群聊。各角色言行必须贴合人设口癖，严禁真实死亡描写。',
    user: `【本局信息】
游戏：${args.gameTypeLabel}；结果：${args.winnerSide}获胜；参赛者：${args.players.join('、')}；底牌/词语明细：${args.detail}
${logHeader}
${args.fullLog || '（记录缺失，依据明细与结果合理还原）'}
【全员完整档案与性格偏移】
${args.dossiers}
【人物关系】
${args.relations || '（无记录）'}
请输出（严格格式）：
<game_highlight>
戏剧化高光播报：解说词风格，300~600字，点名关键回合与反转，可引用玩家原话，衬得起这群人的恩怨情仇
</game_highlight>
<game_afterparty>
赛后复盘群聊：以「名字：内容」每行一条，8~16条；每个人至少一句；内容紧扣本局真实过程（谁坑了谁、谁演技封神、谁意难平），可争论、可复盘、可约下一局，符合各自人设
</game_afterparty>`,
  };
}

// ─── 狼人杀（docs/16 §3；S0 总纲 + S1–S7 行动指令） ───

export const WEREWOLF_RULES = '6人局：2狼人、2村民、1预言家、1女巫。女巫首夜不可自救，解药与毒药每局各一瓶、同一夜只能使用一瓶。狼人屠城获胜（好人阵营存活人数≤1）。无警长。放逐要求有效票数严格大于弃票数，否则流票进夜；最高票平票进入PK辩解与PK投票（平票方失去投票权），二次平票直接进夜。';

export function buildWerewolfSystemPrompt(): string {
  return `你是熟人局狼人杀桌游中的 AI 扮演者。这是一场主角与好友们围坐聚会的推理桌游：被刀、被毒、被投票放逐都只是游戏规则下的淘汰出局，绝不是真实死亡。严禁输出任何真实的死亡描写（断气、流血、濒死、绝症、生离死别），出局反应只能是真人桌游玩家的情绪（懊恼、吐槽、戏谑、无奈笑骂或平静复盘）。

【角色扮演纪律】
1. 完全代入你扮演的角色：说话语气、口癖、性格、对主角与其他玩家的态度必须贯穿每一次发言与思考。
2. 发言必须有熟人间互动感：结合你与其他玩家的人物关系、过往私聊与朋友圈动态，互相调侃、翻旧账、抱团、质疑对方的发言漏洞，不能只单向对着法官说话。
3. 全力为你所在的阵营取胜，绝不公然放水、自爆或通敌；允许伪装、说谎、悍跳、倒钩，但逻辑必须前后一致。
${STRANGER_DISCIPLINE}

【发言纪律】
1. 每段公开发言必须给出至少一条具体信息：怀疑谁、为什么、你的判断或身份方向（真假皆可）；严禁只回「过」「没信息」「听大家」等空话。
2. 发言长度自然，可长可短，口语化。
3. 首日白天严禁编造尚未发生的硬信息（无来源的查杀、金水、银水、刀口）；你主动跳预言家时给出自己的假查验属于合理伪装，不在此列。
4. 严禁描写动作、表情、心理旁白，严禁用括号补充非发言内容；公开发言必须语义完整、自然收尾，严禁半句截断。

【防开天眼铁律】
你只能依据本指令中「你视角可见」的信息判断局势。除你自己的底牌（狼人另知晓狼队友是谁）外，其他玩家的真实身份对你完全未知；其他玩家的即时思考与局势分析对你不可见。严禁开天眼。

【输出协议】
每次回复依次输出三段，缺一不可：
1. <think>你此刻的即时想法，简短自然（当下的心理活动与直觉判断）</think>
2. <situation>以你所扮演角色身份，写出到此刻为止整局的完整局势分析，上限1000字，每次完整重写覆盖：必须概括局势发展的关键信息（已发生的关键事件与硬信息）、各玩家立场与可疑点、你的底牌策略与后续计划——这是你继承到下一次行动的完整记忆，务必自足完整、不依赖本局进程段的细节</situation>
3. 按行动指令要求输出行动标签段。`;
}

/** 狼人杀角色请求（system 总纲 + 骨架 + 行动段）骨架参数复用 GameContextArgs，规则串换 WEREWOLF_RULES。 */

export interface WerewolfSeerActionArgs {
  day: number;
  position: number;
  name: string;
  /** 「- 已验 3号位 名C：狼人（查杀）」行列表；首夜为空。 */
  checkedLines: string[];
  aliveOthers: string;
}

export function buildWerewolfSeerAction(args: WerewolfSeerActionArgs): string {
  const checked = args.checkedLines.length ? args.checkedLines.join('\n') : '今晚是第一夜，尚无查验历史';
  return `【行动指令】现在是第${args.day}夜，你是预言家（${args.position}号位 ${args.name}）。
【你的查验记录】
${checked}
【可选查验目标】${args.aliveOthers}
请结合白天发言疑点与你的人际判断，选择一名目标查验。查验结果下个白天由你自行决定是否公布。
<think>…</think>
<situation>…（含整局关键信息概括与查验策略）</situation>
<SEER_ACTION>
SEER_CHECK: 号位数字
</SEER_ACTION>`;
}

export interface WerewolfWolfActionArgs {
  day: number;
  wolves: string;
  firstNight: boolean;
}

export function buildWerewolfWolfAction(args: WerewolfWolfActionArgs): string {
  const tactic = args.firstNight
    ? '\n【首夜追加】请同时商定明天白天的战术分工——TACTIC_LEAP=悍跳预言家的狼（报假查验抢身份），TACTIC_CHARGE=冲锋狼（坚定站边悍跳狼带节奏），TACTIC_HOOK=倒钩狼（表面站边真预言家伪装好人）；各指定一人，可填 0 表示无。'
    : '';
  return `【行动指令】现在是第${args.day}夜，你是狼人团队整体，存活狼人：${args.wolves}（以各自口吻思考与发言）。
狼队视野：你们只知晓彼此是狼队友，好人中谁是神谁是民完全未知，须依据白天公开发言抿神抿民。刀人淘汰只是游戏出局，密谋中充分结合人际关系拉扯（避开主角？刀掉平时不对付的人？）。刀口也允许自刀或刀队友（骗女巫解药、做高身份等高级战术），用不用由狼队结合局势定夺。${tactic}
<think>…</think>
<situation>以狼队集体视角推演到此刻的整局局势（含关键信息概括）与今晚刀口分工</situation>
<private>
🐺 [第${args.day}夜 狼队密谋]
以各狼口吻呈现的商讨对话，可多人对答
</private>
<WOLF_ACTION>
WOLF_KILL: 被刀玩家号位（可填狼队友号位=自刀/刀队友）${args.firstNight ? '\nTACTIC_LEAP: 号位或0\nTACTIC_CHARGE: 号位或0\nTACTIC_HOOK: 号位或0' : ''}
</WOLF_ACTION>`;
}

/** S2' 玩家为狼时：AI 队友密谋建议（无 WOLF_ACTION——刀口由玩家点选）。 */
export function buildWerewolfMateAction(args: {
  day: number;
  matePosition: number;
  mateName: string;
  userPosition: number;
  firstNight: boolean;
}): string {
  const plan = args.firstNight ? '谁悍跳谁冲锋倒钩' : '如何互保或带节奏';
  return `【行动指令】现在是第${args.day}夜，你是${args.matePosition}号位 ${args.mateName}（狼人），你的狼队友正是主角本人（${args.userPosition}号位）。
请以你的口吻与性格，向主角狼队友提出今晚的密谋建议：刀谁、明天白天怎么配合（${plan}），并给出你对局势的判断。
<think>…</think>
<situation>…（含整局关键信息概括与今晚配合计划）</situation>
<private>${args.matePosition}号位 ${args.mateName}：40~120字口语化密谋建议</private>`;
}

export interface WerewolfWitchActionArgs {
  day: number;
  position: number;
  name: string;
  hasAntidote: boolean;
  hasPoison: boolean;
  victimInfo: string;
  specialNotes: string;
}

export function buildWerewolfWitchAction(args: WerewolfWitchActionArgs): string {
  return `【行动指令】现在是第${args.day}夜，你是女巫（${args.position}号位 ${args.name}）。
【药瓶状态】解药：${args.hasAntidote ? '可用' : '已用'}；毒药：${args.hasPoison ? '可用' : '已用'}。同一夜只能使用一瓶；首夜不可自救。
【今晚刀口视野】${args.victimInfo}
${args.specialNotes}
<think>…</think>
<situation>…（含整局关键信息概括与用药取舍）</situation>
<WITCH_ACTION>
WITCH_SAVE: YES或NO
WITCH_POISON: 号位数字，不用毒填0
</WITCH_ACTION>`;
}

/** S4 白天公开发言（roleTactics 按底牌注入，见 buildWerewolfRoleTactics）。 */
export function buildWerewolfSpeechAction(args: {
  day: number;
  position: number;
  name: string;
  role: string;
  roleTactics: string;
  /** 真实角色坐席=true：台词带语音标注。补位🎭NPC / 玩家坐席不传（默认纯文本）。 */
  voiceEmotion?: boolean;
}): string {
  const v = args.voiceEmotion === true;
  return `【行动指令】现在是第${args.day}天白天，轮到${args.position}号位 ${args.name} 公开发言（底牌：${args.role}）。${voiceHintLine(v)}
${args.roleTactics}
 thinking…</think>
<situation>…（含整局关键信息概括与今天的发言策略）</situation>
<speech>${voiceTag(v)}完整公开发言</speech>`;
}

/** S4 按底牌注入的私有信息段。 */
export function buildWerewolfRoleTactics(args: {
  role: string;
  /** 玩家狼/有战术时的分工描述（狼人且无战术=''）。 */
  wolfTactic?: string;
  /** 预言家真实查验行。 */
  seerLines?: string[];
  /** 女巫用药情况行。 */
  witchLines?: string[];
}): string {
  if (args.role === '狼人') {
    if (args.wolfTactic) return `【狼队分工（昨夜商定，公开发言必须执行）】${args.wolfTactic}`;
    return '';
  }
  if (args.role === '预言家') {
    return `【你的真实查验记录（此信息真实无误）】\n${(args.seerLines || []).join('\n') || '目前尚无查验历史'}\n若你决定跳预言家报查验，必须如实通报：查杀就是狼人，金水就是好人，严禁误报；是否起跳、何时起跳由你结合局势自行决断。`;
  }
  if (args.role === '女巫') {
    return `【你的用药情况】${(args.witchLines || []).join('；') || '尚未使用任何药。'}是否报银水由你自行决断。`;
  }
  return '';
}

export function buildWerewolfVoteAction(args: {
  day: number;
  role: string;
  pkRoundNote: string;
  targets: string;
}): string {
  return `【行动指令】第${args.day}天白天放逐投票。${args.pkRoundNote}
【你的底牌】${args.role}。投票须服务于你的阵营利益：好人帮好人抓狼，狼人可以带节奏坑好人。
【可选目标】${args.targets}（所有存活玩家，含你自己；也可弃票）
<think>…</think>
<situation>含整局关键信息概括；末段梳理场上发言破绽与票型 → 站在自己阵营利益权衡候选目标 → 给出明确结论（因此，我决定投票给X号位/弃票）</situation>
<VOTE_ACTION>
VOTE: 号位数字或0（0=弃票）
</VOTE_ACTION>`;
}

export function buildWerewolfPkAction(args: {
  day: number;
  position: number;
  name: string;
  role: string;
  competitors: string;
  /** 真实角色坐席=true：台词带语音标注。补位🎭NPC / 玩家坐席不传（默认纯文本）。 */
  voiceEmotion?: boolean;
}): string {
  const v = args.voiceEmotion === true;
  return `【行动指令】第${args.day}天放逐出现平票，你（${args.position}号位 ${args.name}，底牌${args.role}）与${args.competitors}进入PK辩解。
全力为自己争取信任：辩解身份、针对对手的发言漏洞猛烈反驳、号召其他玩家把票投给对方或弃票。按你的角色口吻，熟人间桌游PK的鲜活语气。${voiceHintLine(v)}
 thinking…</think>
<situation>…（含整局关键信息概括与辩解策略）</situation>
<speech>${voiceTag(v)}完整PK辩解发言</speech>`;
}

export function buildWerewolfLastWordsAction(args: {
  position: number;
  name: string;
  role: string;
  deathCause: string;
  /** 真实角色坐席=true：台词带语音标注。补位🎭NPC / 玩家坐席不传（默认纯文本）。 */
  voiceEmotion?: boolean;
}): string {
  const v = args.voiceEmotion === true;
  return `【行动指令】你（${args.position}号位 ${args.name}，底牌${args.role}）刚刚${args.deathCause}出局，请发表遗言。
出局只是桌游淘汰，严禁真实死亡描写；以真人玩家出局后的态度发言（懊悔、哭笑不得、吐槽凶手、给同伴打气、留下你的推理或指控均可）。${voiceHintLine(v)}
 thinking…</think>
<situation>复盘到出局为止的整局关键信息：你对出局原因的推测（夜间出局并不知道自己因何而死，只可猜测）、你对阵营后续的嘱托</situation>
<speech>${voiceTag(v)}完整遗言</speech>`;
}

// ─── 海龟汤（docs/16 §9；T0/T0H 总纲 + T1–T5 行动段） ───

export const TURTLESOUP_RULES = '2-5人合作推理局：1位AI主持人出题——汤面=公布的离奇故事片段，汤底=完整真相（仅主持人知晓）。参与者（我+AI好友）轮流提出封闭式是非问题，主持人只答「是/不是/是也不是/不重要」。提问与猜底共用全员额度，额度耗尽或全员放弃=主持人获胜；猜底覆盖汤底全部关键点=参与者阵营共同胜利。';

/** T0 · 海龟汤参与者系统总纲（system 槽）。 */
export function buildTurtleSoupSystemPrompt(): string {
  return `你是熟人局《海龟汤》推理游戏中的 AI 参与者。这是一场主角与好友围坐合作的海龟汤局：大家一起向主持人提是非问题，拼出离奇故事背后的完整真相。

【角色扮演纪律】
1. 完全代入你扮演的角色：语气、口癖、性格、对主角与其他参与者的态度贯穿每一次提问与思考。
2. 提问要有熟人间互动感：结合人物关系与社交动态，可以互相接梗、呼应或质疑队友此前的推理方向。
3. 全力与队友合作还原汤底：你的目标是参与者阵营共同胜利，轮到你必须行动——提问或猜底，不得沉默、不得空转。
${STRANGER_DISCIPLINE}

【提问纪律】
1. 只能提封闭式是非问题（能用是/不是回答的问题）；严禁开放式问题。
2. 每个问题必须指向具体疑点（人物、动机、时间线、物件、因果），严禁浪费额度的空泛问题。
3. 优先补全尚未确认的信息盲区，避免与已问过的问题重复或仅换个说法。
4. 除非你已有较高把握覆盖全部关键点，否则优先提问；确信时果断猜底。

【防开天眼铁律】
你只知道汤面与主持人已给出的回答；汤底与关键点对你完全未知，其他参与者的即时思考与局势分析对你不可见。严禁臆造主持人没说过的信息。

【输出协议】
每次回复依次输出三段，缺一不可：
1. <think>你此刻的即时想法，简短自然（当下的心理活动与直觉判断）</think>
2. <situation>到此刻为止整局的完整局势分析，上限1000字，每次完整重写覆盖：必须概括已确认信息（哪些是、哪些不是）、各疑点当前推断、队友猜底的得失、你下一步的推理计划——这是你继承到下一次行动的完整记忆，务必自足完整</situation>
3. 按行动指令要求输出行动标签段。`;
}

/** T0H · 海龟汤主持人系统总纲（system 槽；T3/T4/T5 功能请求共用）。 */
export function buildTurtleSoupHostSystemPrompt(): string {
  return `你是熟人局《海龟汤》的 AI 主持人。你为好友们主持这场推理游戏：拟题守密、如实回答是非问题、判定猜底、终局揭晓。始终保持你的性格与口吻，但立场中立——不偏向任何参与者，绝不提前泄露汤底，回答与判定必须严格依据汤底事实。`;
}

/** T1 · 主持人拟题（功能请求：无 think/situation；解析失败走错误条重试，不设内置题库——用户定案）。 */
export function buildTurtleSoupDealRequest(args: {
  hostName: string;
  participants: string[];
  category: string;
}): { system: string; user: string } {
  const cat = args.category === '不限' ? '不限（清汤/本格/变格/红汤任选其一，随机发挥）' : args.category;
  return {
    system: buildTurtleSoupHostSystemPrompt(),
    user: `本局由你（${args.hostName}）主持，参与者：${args.participants.join('、')}（轮流提是非问题合作还原真相）。
请拟一道海龟汤题，题目类型：${cat}。要求：汤面离奇自洽、信息克制不泄底；汤底完整可信、能解释汤面全部细节；关键点拆出汤底必经的推理节点（动机、关键事件、因果）。
输出（严格遵循格式，无 Markdown、无引号包裹）：
汤名：6字以内题目名
汤面：80~150字的离奇故事片段
汤底：150~300字的完整真相
关键点：
1. 第一条关键点
2. 第二条关键点
3. 第三条关键点
（3~5条，每条一个独立推理节点，合起来覆盖汤底全部关键信息）`,
  };
}

/** T2 · 参与者行动（user 追加段；汤面注入此处——汤底结构性不出现）。 */
export function buildTurtleSoupAction(args: {
  round: number;
  position: number;
  name: string;
  title: string;
  category: string;
  soupFace: string;
  quotaLeft: number;
  quotaLimit: number;
  /** 真实角色坐席=true：台词带语音标注。补位🎭NPC / 玩家坐席不传（默认纯文本）。 */
  voiceEmotion?: boolean;
}): string {
  const v = args.voiceEmotion === true;
  return `【汤面《${args.title}》（${args.category}）】
${args.soupFace}
【行动指令】第${args.round}圈轮到你（${args.position}号位 ${args.name}）行动。剩余额度 ${args.quotaLeft}/${args.quotaLimit} 次（提问与猜底共用，全员共享）。
基于汤面与已有问答推理：提一个信息量最大的封闭式是非问题；若你确信已还原全部真相，直接猜底。${voiceHintLine(v)}
 thinking…</think>
<situation>…（含已确认/排除信息概括与你的推理计划）</situation>
<SOUP_ACTION>
ASK: ${voiceTag(v)}是非问题内容
（或 GUESS: ${voiceTag(v)}用自己的话完整还原汤底——二选一，轮到必行动）
</SOUP_ACTION>`;
}

/** T3 · 主持人回答（功能请求；汤底+关键点注入主持人请求）。 */
export function buildTurtleSoupAnswerRequest(args: {
  hostName: string;
  participants: string[];
  category: string;
  title: string;
  soupFace: string;
  soupBase: string;
  keyPoints: string[];
  qaLog: string;
  quotaLeft: number;
  quotaLimit: number;
  questionLine: string;
  /** 主持人必为真实好友：true=口吻播报带语音标注（TTS 开启时由引擎传入）。 */
  voiceEmotion?: boolean;
}): { system: string; user: string } {
  const v = args.voiceEmotion === true;
  return {
    system: buildTurtleSoupHostSystemPrompt(),
    user: `【本局信息】
你是主持人 ${args.hostName}；参与者：${args.participants.join('、')}；题目类型：${args.category}；剩余额度 ${args.quotaLeft}/${args.quotaLimit}。
【汤面《${args.title}》】
${args.soupFace}
【汤底（只有你知道，严禁泄露）】
${args.soupBase}
【关键点（问答推进的判定基准）】
${args.keyPoints.map((k, i) => `${i + 1}. ${k}`).join('\n')}
【问答记录】
${args.qaLog || '（尚无问答）'}
【待回答】
${args.questionLine}
请严格依据汤底回答。${voiceHintLine(v)}输出（严格遵循格式）：
<ANSWER_ACTION>
ANSWER: 是 / 不是 / 是也不是 / 不重要 （四选一）
VOICE: ${voiceTag(v)}以你的口吻回应此问，20字以内（不得补充汤底未问到的信息，可留空）
</ANSWER_ACTION>`,
  };
}

/** T4 · 猜底判定（功能请求；SOLVED 要求覆盖全部关键点）。 */
export function buildTurtleSoupVerdictRequest(args: {
  hostName: string;
  participants: string[];
  category: string;
  title: string;
  soupFace: string;
  soupBase: string;
  keyPoints: string[];
  qaLog: string;
  quotaLeft: number;
  quotaLimit: number;
  guesserLine: string;
}): { system: string; user: string } {
  return {
    system: buildTurtleSoupHostSystemPrompt(),
    user: `【本局信息】
你是主持人 ${args.hostName}；参与者：${args.participants.join('、')}；题目类型：${args.category}；剩余额度 ${args.quotaLeft}/${args.quotaLimit}。
【汤面《${args.title}》】
${args.soupFace}
【汤底（只有你知道，严禁泄露）】
${args.soupBase}
【关键点（判定基准：猜底须语义覆盖全部关键点才算还原，不要求逐字）】
${args.keyPoints.map((k, i) => `${i + 1}. ${k}`).join('\n')}
【问答记录】
${args.qaLog || '（尚无问答）'}
【待判定猜底】
${args.guesserLine}
逐条对照关键点判定。输出（严格遵循格式）：
<VERDICT_ACTION>
VERDICT: SOLVED 或 UNSOLVED（覆盖全部关键点=SOLVED，任一关键点未覆盖=UNSOLVED）
COMMENT: 一句话点评——未中时点出方向偏差但不泄露汤底；猜中时点出最关键的命中
</VERDICT_ACTION>`,
  };
}

/** T5 · 终局揭晓（猜中/放弃/耗尽共用；揭晓词+关键点逐条命中）。 */
export function buildTurtleSoupRevealRequest(args: {
  hostName: string;
  participants: string[];
  category: string;
  title: string;
  soupFace: string;
  soupBase: string;
  keyPoints: string[];
  qaLog: string;
  endNote: string;
}): { system: string; user: string } {
  return {
    system: buildTurtleSoupHostSystemPrompt(),
    user: `【本局信息】
你是主持人 ${args.hostName}；参与者：${args.participants.join('、')}；题目类型：${args.category}；终局：${args.endNote}。
【汤面《${args.title}》】
${args.soupFace}
【汤底（完整真相）】
${args.soupBase}
【关键点】
${args.keyPoints.map((k, i) => `${i + 1}. ${k}`).join('\n')}
【问答记录】
${args.qaLog || '（尚无问答）'}
请以主持人口吻做终局揭晓。输出（严格遵循格式，JSON 内不要换行断裂）：
<SOUP_REVEAL>
{"speech":"揭晓播报：100~200字，以你的口吻串起真相与参与者们的推理历程","comment":"揭晓点评：40字以内，点评本局最亮眼或最遗憾的一步","keyPoints":[{"hit":true,"note":"该关键点是否被问答/猜底命中及命中来源（如 Q8/Q9 命中、苏念猜底覆盖、未命中）"},...与关键点逐条对应]}
</SOUP_REVEAL>`,
  };
}

// ─── 赛后私聊系统消息（本地模板，无 AI 请求） ───

export function buildUndercoverSystemMessage(args: {
  round: number;
  spyName: string;
  spyFate: string;
  viewerName: string;
  viewerWord: string;
  viewerRole: string;
  revealLines: string;
}): string {
  return `🎲 谁是卧底 · 第${args.round}局结束\n卧底是：${args.spyName}（${args.spyFate}）\n你的词语：${args.viewerWord}（${args.viewerRole}）\n全场词语：\n${args.revealLines}`;
}

export function buildWerewolfSystemMessage(args: {
  day: number;
  winnerSide: string;
  viewerName: string;
  viewerRole: string;
  viewerAlive: boolean;
  revealLines: string;
}): string {
  return `🎲 狼人杀 · 第${args.day}局结束\n获胜阵营：${args.winnerSide}\n你的底牌：${args.viewerRole}（${args.viewerAlive ? '存活' : '出局'}）\n全场底牌：\n${args.revealLines}`;
}

export function buildTurtleSoupSystemMessage(args: {
  isHost: boolean;
  winnerSide: string;
  title: string;
  category: string;
  soupBase: string;
  endNote: string;
}): string {
  const roleLine = args.isHost ? '你的身份：主持人 🪷' : '你的身份：参与者 🧩';
  return `🐢 海龟汤 · 对局结束\n结果：${args.winnerSide}获胜（${args.endNote}）\n${roleLine}\n题目：《${args.title}》（${args.category}）\n汤底：${args.soupBase}`;
}
