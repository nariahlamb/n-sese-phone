// ===== 富媒体类型注册表（提示词块 + 解析提取的单一事实源，纯函数零依赖） =====
// 每个富文本类型的三要素：【名称】【生成时机】【结构要求】——像破限/防八股一样作为
// 完整内容块注入聊天 AI 指令（docs/02 §5.4）；前端提取（chat-parser detectType）由
// 同一张表驱动：kind='message' 显示在聊天记录，kind='memo' 触发额外操作（备忘录入库），
// kind='action' 触发会话级动作（好友申请裁决/拉黑/退群，前端落系统消息并改会话状态）。
// 例外：memo 不进【富媒体类型】块——备忘不是聊天消息，塞进「消息行可选前缀」框架会
// 压低触发（且窥私复用富媒体块而窥私解析器丢弃备忘行，拆出后两处口径一致），
// 由 buildMemoPromptBlock 单独成【备忘记录】段（时机/结构仍由本表驱动）。
// 新增类型 = 在此表加一行（提示词与解析自动生效），必要时在渲染层补一个分支。
// branches 字段限定该类型只在哪些聊天分支注入/解析（缺省=全部分支）——
// 好友申请分支只露出 通过/拒绝；拉黑仅私聊；退群仅群聊。

export type RichMediaKind = 'message' | 'memo' | 'action';

/** 聊天分支：私聊 / 群聊 / 好友申请（非好友私聊）。指令模板与富媒体块按此分流。 */
export type ChatBranch = 'private' | 'group' | 'friend-request';

export interface RichMediaSpec {
  /** 消息模型类型 id（chat-model PhoneMessageType / 备忘 / 动作）。 */
  id: string;
  /** 【名称】 */
  name: string;
  /** 输出前缀（半角方括号；解析兼容全角）。 */
  tag: string;
  /** 【生成时机】 */
  timing: string;
  /** 【结构要求】（一行紧凑文本，阐明要求即可，不占多余 token）。 */
  structure: string;
  /** 仙侠风格覆盖（docs/11 §5.3：name/timing/structure 换措辞；tag/branches/机制性字数限制不变）。 */
  xianxia?: { name: string; timing: string; structure: string };
  /** 武侠风格覆盖（docs/11：天机匣/银票/赏钱/口信/手札；tag/branches/机制性字数限制不变）。 */
  wuxia?: { name: string; timing: string; structure: string };
  /** 西幻风格覆盖（docs/11：传讯水晶/金币转赠/钱袋/回声/羊皮笺；tag/branches/机制性字数限制不变）。 */
  fantasy?: { name: string; timing: string; structure: string };
  /** message=聊天记录内展示；memo=触发额外操作（不入消息流）；action=会话级动作（落系统消息）。 */
  kind: RichMediaKind;
  /** 只在这些分支注入提示词并参与解析（缺省=全部）。 */
  branches?: readonly ChatBranch[];
}

const CHAT_BRANCHES: readonly ChatBranch[] = ['private', 'group'];

/** 语音情绪/演绎尾注（docs/35 §B.4 + 2026-10-03 演绎专业化）。
 *  **40 字是上限**（用户定案）：提示词只写「（上限40字）」，不附加字数建议。
 *  演绎给的是「怎么演」的维度（语速/语气/气声与音量/停顿与尾音），不是一个形容词——
 *  依据：ElevenLabs 音频标签指南（[whispers] 等 + 标点控节奏 + 越具体越好）与 OpenAI
 *  gpt-4o-mini-tts `instructions` 的官方可控项（Emotional range / Intonation / Speed of speech / Tone / Whispering）。
 *  **仅在 TTS 开启时注入**（关闭走 plainVoiceStructure 机械剥离本段）。 */
export const VOICE_EMOTION_HINT = '；情绪取「开心/悲伤/生气/害怕/惊讶/厌恶/平静/低语」之一，拿不准写「平静」。想让这句念得更有味道，可再补一段演绎：[语音|情绪|演绎]——演绎是「怎么演」的短指导（上限40字），按需要写清有关的维度：语速（偏快/拖慢/忽快忽慢）、语气（上扬/压低/发虚/带笑/冷淡）、气声与音量（气声/近乎耳语/压着嗓子/抬高）、停顿与尾音（字间停顿/尾音拉长/尾音发颤）；只写「怎么说」，不写动作、神态或旁白。';

export const RICH_MEDIA_SPECS: readonly RichMediaSpec[] = [
  {
    id: 'image',
    name: '图片',
    tag: '[图片]',
    timing: '分享所见、发自拍、说不清的事',
    structure: '[图片]画面内容中文描述（30-60字，写清场景/人物/动作；并点明画面主体——发送者自己出镜就写明本人（自拍/自己拍的），画面里出现其他角色就写出其名）',
    xianxia: {
      name: '留影',
      timing: '分享所见、自照留影、说不清的事',
      structure: '[图片]留影石映出的画面中文描述（30-60字，写清场景/人物/动作；并点明画面主体——发送者自己入画就写明本人（自照留影），画面里出现其他角色就写出其名）',
    },
    wuxia: {
      name: '写真',
      timing: '分享所见、自画像、说不清的事',
      structure: '[图片]写真匣映出的画面中文描述（30-60字，写清场景/人物/动作；并点明画面主体——发送者自己入画就写明本人（自摄写真），画面里出现其他角色就写出其名）',
    },
    fantasy: {
      name: '记影',
      timing: '分享所见、魔镜自照、说不清的事',
      structure: '[图片]魔镜记下的画面中文描述（30-60字，写清场景/人物/动作；并点明画面主体——发送者自己入画就写明本人（自记影像），画面里出现其他角色就写出其名）',
    },
    kind: 'message',
    branches: CHAT_BRANCHES,
  },
  {
    id: 'voice',
    name: '语音',
    tag: '[语音]',
    timing: '情绪浓、懒得打字、想说又不好意思打字时',
    structure: '[语音|情绪]语音内容的文字转写（口语化，像真的说出来的话）' + VOICE_EMOTION_HINT,
    xianxia: {
      name: '传音',
      timing: '情绪浓、懒于刻符、想说又不好意思落笔时',
      structure: '[语音|情绪]传音内容的文字转写（口语化，像真的说出来的话）' + VOICE_EMOTION_HINT,
    },
    wuxia: {
      name: '口信',
      timing: '情绪浓、懒得研墨、想说又不好意思落笔时',
      structure: '[语音|情绪]口信内容的文字转写（口语化，像托人捎的话）' + VOICE_EMOTION_HINT,
    },
    fantasy: {
      name: '回声',
      timing: '情绪浓、懒于提笔、想说又不好意思落笔时',
      structure: '[语音|情绪]回声内容的文字转写（口语化，像水晶里留下的话）' + VOICE_EMOTION_HINT,
    },
    kind: 'message',
    branches: CHAT_BRANCHES,
  },
  {
    id: 'transfer',
    name: '转账',
    tag: '[转账]',
    timing: '剧情自然需要转账、还钱、发生活费、请客时',
    structure: '[转账]金额数字|转账留言（如 [转账]520|拿去买点好吃的）',
    xianxia: {
      name: '灵石转让',
      timing: '剧情自然需要交付灵石、还债、赠予资财时',
      structure: '[转账]灵石数目|转让留言（如 [转账]520|拿去换些心仪之物）',
    },
    wuxia: {
      name: '汇银',
      timing: '剧情自然需要交割银钱、还债、赠予盘缠时',
      structure: '[转账]银两数目|汇兑留言（如 [转账]520|拿去添些盘缠）',
    },
    fantasy: {
      name: '金币转赠',
      timing: '剧情自然需要赠予金币、偿还旅费、置办行装时',
      structure: '[转账]金币数目|赠言（如 [转账]520|拿去修整装备）',
    },
    kind: 'message',
    branches: CHAT_BRANCHES,
  },
  {
    id: 'redpacket',
    name: '红包',
    tag: '[红包]',
    timing: '节日、庆祝、道歉、撒娇哄人时',
    structure: '[红包]金额数字|祝福语（如 [红包]88.8|生日快乐）',
    xianxia: {
      name: '灵石福袋',
      timing: '节庆、道贺、赔礼、娇嗔讨好时',
      structure: '[红包]灵石数目|祝词（如 [红包]88.8|生辰之喜）',
    },
    wuxia: {
      name: '赏钱',
      timing: '打赏、谢礼、道贺、讨个彩头时',
      structure: '[红包]金额数字|赏钱祝词（如 [红包]88.8|生辰之喜）',
    },
    fantasy: {
      name: '钱袋',
      timing: '打赏、谢礼、道贺、赠予好运时',
      structure: '[红包]金币数目|钱袋祝词（如 [红包]88.8|愿星光照拂）',
    },
    kind: 'message',
    branches: CHAT_BRANCHES,
  },
  {
    id: 'memo',
    name: '备忘',
    tag: '[备忘]',
    timing: '本轮出现值得记住的剧情事项就记一条——与对方达成约定（约好何时何地做什么）、你或对方许下承诺、接受或交代了任务要求、对方提到之后的变化或安排（如某日要出门、有事不能来）、剧情埋下伏笔（对方透露了以后会发生的事）',
    structure: '[备忘]标题|类型|约定时间|详细内容（如「书店买参考书|约定|2026-03-02|与{{user}}约定周六上午去书店买参考书，下周考试要用」）。标题=简明事件名，12字内，不以「明天/下周」等相对时间开头；类型限：约定/待办/伏笔/临时变化；约定时间填游戏内日期，可只写「3月2日」，或留空；详细内容简单写明前因后果（涉及谁、因何事——备忘常驻，聊天记录被覆盖后凭此能懂缘由）。每轮最多一条',
    xianxia: {
      name: '道简',
      timing: '本轮出现值得记住的剧情事项就记一条——与对方达成约定（约好何时何地做什么）、你或对方许下承诺、接受或交代了任务要求、对方提到之后的变化或安排（如某日要出门、闭关不能通讯）、剧情埋下伏笔（对方透露了以后会发生的事）',
      structure: '[备忘]标题|类型|约定时间|详细内容（如「初五坊市购符纸|约定|2026-03-02|与{{user}}约定初五同去坊市购符纸，符箓将尽需补充」）。标题=简明事件名，12字内，不以「明日/来月」等相对时间开头；类型限：约定/待办/伏笔/临时变化；约定时间填游戏内日期，可只写「3月2日」，或留空；详细内容简单写明前因后果（涉及谁、因何事——备忘常驻，聊天记录被覆盖后凭此能懂缘由）。每轮最多一条',
    },
    wuxia: {
      name: '手札',
      timing: '本轮出现值得记住的剧情事项就记一条——与对方达成约定（约好何时何地做什么）、你或对方许下承诺、接受或交代了任务要求、对方提到之后的变化或安排（如某日要出门、有事不能赴约）、剧情埋下伏笔（对方透露了以后会发生的事）',
      structure: '[备忘]标题|类型|约定时间|详细内容（如「初六渡口会船|约定|2026-03-02|与{{user}}约定初六在渡口会合乘船，同赴汉水办差」）。标题=简明事件名，12字内，不以「明日/来月」等相对时间开头；类型限：约定/待办/伏笔/临时变化；约定时间填游戏内日期，可只写「3月2日」，或留空；详细内容简单写明前因后果（涉及谁、因何事——备忘常驻，聊天记录被覆盖后凭此能懂缘由）。每轮最多一条',
    },
    fantasy: {
      name: '羊皮笺',
      timing: '本轮出现值得记住的剧情事项就记一条——与对方达成约定（约好何时何地做什么）、你或对方许下承诺、接受或交代了任务要求、对方提到之后的变化或安排（如某日要出门、有事不能来）、剧情埋下伏笔（对方透露了以后会发生的事）',
      structure: '[备忘]标题|类型|约定时间|详细内容（如「初六北塔会合|约定|2026-03-02|与{{user}}约定初六在北塔会合，一同探查塔中秘藏」）。标题=简明事件名，12字内，不以「明天/下周」等相对时间开头；类型限：约定/待办/伏笔/临时变化；约定时间填游戏内日期，可只写「3月2日」，或留空；详细内容简单写明前因后果（涉及谁、因何事——备忘常驻，聊天记录被覆盖后凭此能懂缘由）。每轮最多一条',
    },
    kind: 'memo',
    branches: CHAT_BRANCHES,
  },
  {
    id: 'friend-accept',
    name: '通过',
    tag: '[通过]',
    timing: '好友申请环节，愿意接受对方为好友时',
    structure: '[通过]（独立一行；通过后如想立刻说话，下一行起输出正常消息行）',
    xianxia: {
      name: '应允',
      timing: '名帖递交流程，愿意应允对方结为道友时',
      structure: '[通过]（独立一行；应允后如想立刻说话，下一行起输出正常消息行）',
    },
    wuxia: {
      name: '应下',
      timing: '拜帖递交流程，愿意与对方互通名帖时',
      structure: '[通过]（独立一行；应下后如想立刻说话，下一行起输出正常消息行）',
    },
    fantasy: {
      name: '应允',
      timing: '荐书递交流程，愿意收下对方为同伴时',
      structure: '[通过]（独立一行；应允后如想立刻说话，下一行起输出正常消息行）',
    },
    kind: 'action',
    branches: ['friend-request'],
  },
  {
    id: 'friend-reject',
    name: '拒绝',
    tag: '[拒绝]',
    timing: '好友申请环节，不愿接受对方为好友时',
    structure: '[拒绝]拒绝理由（一句话，贴合人物性格与两人当前关系）',
    xianxia: {
      name: '婉拒',
      timing: '名帖递交流程，不愿应允对方结为道友时',
      structure: '[拒绝]婉拒缘由（一句话，贴合人物性情与两人当前关系）',
    },
    wuxia: {
      name: '婉拒',
      timing: '拜帖递交流程，不愿与对方互通名帖时',
      structure: '[拒绝]婉拒缘由（一句话，贴合人物性情与两人当前关系）',
    },
    fantasy: {
      name: '婉拒',
      timing: '荐书递交流程，不愿收下对方为同伴时',
      structure: '[拒绝]婉拒缘由（一句话，贴合人物性情与两人当前关系）',
    },
    kind: 'action',
    branches: ['friend-request'],
  },
  {
    id: 'block',
    name: '拉黑',
    tag: '[拉黑]',
    timing: '私聊中被严重冒犯、纠缠不休或关系破裂，不想再理会对方时（重大决定，慎用）',
    structure: '[拉黑]拉黑理由（输出后你不再接收对方消息，对方须重新申请好友才可能恢复联系）',
    xianxia: {
      name: '道途两清',
      timing: '私聊中被严重冒犯、纠缠不休或道侣情断，不愿再互通符讯时（重大决定，慎用）',
      structure: '[拉黑]两清缘由（输出后你不再接收对方符讯，对方须重新递名帖才可能恢复往来）',
    },
    wuxia: {
      name: '恩断义绝',
      timing: '私聊中被严重冒犯、纠缠不休或情义破裂，不愿再通书信时（重大决定，慎用）',
      structure: '[拉黑]决裂缘由（输出后你不再收对方书信，对方须重新递拜帖才可能恢复往来）',
    },
    fantasy: {
      name: '绝交',
      timing: '私聊中被严重冒犯、纠缠不休或情谊破裂，不愿再通讯息时（重大决定，慎用）',
      structure: '[拉黑]绝交缘由（输出后你不再收对方讯息，对方须重新递荐书才可能恢复往来）',
    },
    kind: 'action',
    branches: ['private'],
  },
  {
    id: 'leave-group',
    name: '退群',
    tag: '[退群]',
    timing: '群聊中想退出该群时（与群成员闹翻、话题令你不适等）',
    structure: '[退群]退群理由（输出后你退出该群聊，不再出现在群成员列表）',
    xianxia: {
      name: '出盟',
      timing: '道盟共谈中想退出该盟时（与盟友闹翻、话题令你不适等）',
      structure: '[退群]出盟缘由（输出后你退出此盟，不再出现在盟友名录）',
    },
    wuxia: {
      name: '离席',
      timing: '群英会中想离席而去时（与同道闹翻、话题令你不适等）',
      structure: '[退群]离席缘由（输出后你退出此会，不再出现在同道名录）',
    },
    fantasy: {
      name: '告退',
      timing: '圆桌商谈中想起身告退时（与同仁闹翻、话题令你不适等）',
      structure: '[退群]告退缘由（输出后你离开此圆桌，不再出现在同仁名册）',
    },
    kind: 'action',
    branches: ['group'],
  },
];

/** 备忘类型合法值（对齐主项目备忘录表「类型」列约定）。 */
export const MEMO_TYPES = ['约定', '待办', '伏笔', '临时变化'] as const;

/** 该类型是否在指定分支可用（缺省 branches=全部）。 */
export function specBranchAllows(spec: RichMediaSpec, branch: ChatBranch): boolean {
  return !spec.branches || spec.branches.includes(branch);
}

/**
 * 提示词富媒体块：注入聊天指令模板【输出格式】之后（docs/02 §5.4 标准格式），
 * 按分支过滤（好友申请只给 通过/拒绝；私聊附 拉黑；群聊附 退群）。
 * memo 不入此块（不是聊天消息，走 buildMemoPromptBlock 独立成段；窥私复用本块也无需备忘）。
 * style 走文案层覆盖（tag 不变）。
 * opts.voiceEmotion=false（TTS 总开关关闭）时**只有语音条目降级**为 `[语音]转写`——去标注前缀与情绪尾注，
 * 其余类型逐字不变。注意：`[语音]` 消息本身照常教学与生成，关掉的只是「情绪|演绎」这一层（用户定案）。
 */
export interface RichMediaBlockOptions {
  /** 是否要求模型给语音标注情绪/演绎（= TTS 开启且情绪演绎开关开启）。缺省 true（向后兼容）。 */
  voiceEmotion?: boolean;
  /** 货币系统常用货币名（联动激活时由调用方传入）：转账/红包金额后必须带币种名。 */
  currencyUnit?: string;
}

/** 语音「无情绪」结构：从带属性结构机械推导（去标注前缀与尾注）——单一事实源，避免两处漂移。 */
function plainVoiceStructure(full: string): string {
  return full.replace('[语音|情绪]', '[语音]').replace(VOICE_EMOTION_HINT, '');
}

export function buildRichMediaPromptBlock(
  branch: ChatBranch,
  style: '' | 'xianxia' | 'wuxia' | 'fantasy' = '',
  opts: RichMediaBlockOptions = {},
): string {
  const withEmotion = opts.voiceEmotion !== false;
  const lines = RICH_MEDIA_SPECS
    .filter(spec => spec.kind !== 'memo' && specBranchAllows(spec, branch))
    .map(spec => {
      const o = style === 'xianxia' ? spec.xianxia : style === 'wuxia' ? spec.wuxia : style === 'fantasy' ? spec.fantasy : undefined;
      const name = o?.name ?? spec.name;
      const timing = o?.timing ?? spec.timing;
      const raw = o?.structure ?? spec.structure;
      const structure = spec.id === 'voice' && !withEmotion ? plainVoiceStructure(raw) : raw;
      return `■ 名称：${name}｜生成时机：${timing}｜结构要求：${structure}${spec.kind === 'action' ? '；此行独立输出，不计入聊天消息' : ''}`;
    });
  // 货币联动：转账/红包金额后必须带币种名（手机侧解析按"金额 币种名"提取；缺省回落常用货币）
  if (opts.currencyUnit) {
    lines.push(`■ 名称：货币｜生成时机：所有转账/红包｜结构要求：金额后必须带币种名（单位：${opts.currencyUnit}），如 [转账]520 ${opts.currencyUnit}|丹药钱、[红包]88.8 ${opts.currencyUnit}|生日快乐`);
  }
  return `【富媒体类型】（消息行的可选前缀，仅在生成时机合适时使用，正常文字消息无需前缀）\n${lines.join('\n')}`;
}

/** 备忘独立提示块参数。 */
export interface MemoPromptBlockArgs {
  branch: ChatBranch;
  /** 界面风格（仙侠/武侠/西幻=对应措辞覆盖；缺省=现代）。 */
  style?: '' | 'xianxia' | 'wuxia' | 'fantasy';
}

/**
 * 备忘独立提示块（注入富媒体块之后、【规则】之前，docs/02 §5.4）。
 * 三行轻量结构：块头声明「独立行、放回复块内」；时机正向列举四类型触发场景（无默认出口）；
 * 写法行免名字前缀——备忘不入消息流，`[备忘]…` 裸行直出，解析端裸行兜底
 * （chat-parser 回退会话首位成员；带名字的写法同样可解析）。时机/结构仍由注册表
 * memo 条目驱动（单一事实源）；好友申请分支无备忘 → 空串。
 */
export function buildMemoPromptBlock(args: MemoPromptBlockArgs): string {
  const spec = RICH_MEDIA_SPECS.find(s => s.id === 'memo');
  if (!spec || !specBranchAllows(spec, args.branch)) return '';
  const o = args.style === 'xianxia' ? spec.xianxia : args.style === 'wuxia' ? spec.wuxia : args.style === 'fantasy' ? spec.fantasy : undefined;
  const name = o?.name ?? spec.name;
  const timing = o?.timing ?? spec.timing;
  const structure = o?.structure ?? spec.structure;
  return [
    `【${name}记录】（写给备忘录的独立行，放在回复块内，不会显示在聊天记录里）`,
    `■ 时机：${timing}`,
    `■ 写法：${structure}`,
  ].join('\n');
}
