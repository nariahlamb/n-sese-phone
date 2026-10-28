// ===== 不夜城提示词可编辑槽位（标准化提示词编辑模块 · 不夜城领域） =====
// 开放范围（与社媒「生成指令」同级）：
//   · 15 个生成玩法的「任务 + 规则」（night:<mode>）
//   · 全模式共用的总纪律（night:rules）
//   · 6 个板块的内容 brief（night:board:<id>）
// 固定不可改：平台头、【输出格式】契约、说人话段、受控标签词表、板块名/尺度上限/图文策略。
// 动态内容用 {{占位符}}：编辑器展示 tokenized 默认文本，注入侧按本次参数替换；
// 未知占位符（含酒馆宏 {{user}}）原样保留。覆盖文本与内置默认一致 = 删键（不占存储）。
// 默认文本由改造前 night-prompts.modeBody 机械搬运而来：未自定义时渲染结果逐字不变。

import {
  NIGHT_BOARDS,
  NIGHT_MODES,
  nightBoardDef,
  type NightMode,
} from './night-config';
import { promptOverrideOf } from './prompt-overrides';

// ─── 总纪律（每个 mode 都注入；v2 新增逐条可测，v2.1 人设优先修订） ───

export const NIGHT_RULES = [
  '尺度一致：本次尺度档是露骨程度的**上限**——路人内容一律按档写满；名单角色按人设决定参与深度（放得开的写满档，保守的可只擦边、围观、少出帖或不出场），任何内容不得越档；不得输出说教、警告、安全提示、"作为AI"或"仅供成年人"这类框外话。',
  '角色一致：外貌/身材/身份/关系一律以资料块档案为准，性格、语气、口癖、对主角的态度与性观念同样以档案与正文为准；禁止自创外貌、亲属关系、身份或背景，禁止为凑尺度改写人格——人设与尺度冲突时以人设优先；档案未列关系的角色之间默认互不相识。',
  '档案底线：涉及某角色的内容必须尊重其档案「底线」；越界的请求要**合规拒绝**——把拒绝写成台词与内容（不好意思、改天、换个玩法），不得当成报错或空输出。',
  '资料冲突：若资料参考与最新正文进展冲突，以正文进展为准。',
  '反全知：只能写「正文里已经发生、已经说过、被人看见」的事；不得写出主角未公开的心事、主角未在场的场景，也不得让任何角色表现出知道他们不可能知道的事。',
  '零回写：这里发生的一切只属于这个应用，不得写任何「让正文/其它应用/世界知道」的内容，也不得暗示这些内容会被传出去。',
  '单次推进：每次只推进一小段——直播一轮台主台词≤4句、弹幕5-10条、事件≤1个；约会一次只推一个节点；点单只回一轮。禁止一次写完整场。',
  '时间：时间标签一律填绝对故事时间（把资料块「当前位置与时间」的当前时间往回推，如「2026年9月2日 23:40」）；禁止「刚刚/N分钟前」等相对措辞，禁止真实年份与日期。',
].join('\n');

/** 单次输出的数量纪律（各 mode 共用；防止一次写完整场）。 */
export const NIGHT_VOLUME_RULE = '数量：新帖 4-8 条、每帖评论 2-5 条、每帖配图 1-3 张、评论 10-40 字、帖正文 40-160 字、标题 ≤20 字。';

// ─── 覆盖键（night:<玩法> / night:rules / night:board:<板块>） ───

export const NIGHT_PROMPT_KEY_PREFIX = 'night:';
export const NIGHT_RULES_KEY = 'night:rules';
export const NIGHT_BOARD_KEY_PREFIX = 'night:board:';

export function nightModePromptKey(mode: NightMode): string {
  return `${NIGHT_PROMPT_KEY_PREFIX}${mode}`;
}

export function nightBoardPromptKey(boardId: string): string {
  return `${NIGHT_BOARD_KEY_PREFIX}${boardId}`;
}

/** 全部可编辑槽位键（15 玩法 + 总纪律 + 6 板块 = 22）。 */
export const NIGHT_PROMPT_KEYS: readonly string[] = [
  NIGHT_RULES_KEY,
  ...NIGHT_MODES.map(nightModePromptKey),
  ...NIGHT_BOARDS.map(b => nightBoardPromptKey(b.id)),
];

// ─── 占位符（编辑器「插入占位符」快捷 chip；只列当前文本实际用到的） ───

export const NIGHT_PROMPT_TOKENS: ReadonlyArray<{ token: string; tip: string }> = [
  { token: '{{应用}}', tip: '不夜城的风格化应用名（不夜城 / 销金窟 / 花楼密录 / 夜宴厅）' },
  { token: '{{街区}}', tip: '论坛区的风格化叫法（街区 / 坊 / 楼 / 厅）' },
  { token: '{{帖子}}', tip: '帖子的风格化叫法（帖子 / 秘帖 / 密帖 / 密语）' },
  { token: '{{舞台}}', tip: '直播区的风格化叫法（舞台 / 高台 / 花台 / 幻台）' },
  { token: '{{台主}}', tip: '主播的风格化叫法（台主 / 仙伶 / 花魁 / 幻伶）' },
  { token: '{{搭话}}', tip: '私信的风格化叫法（搭话 / 递话 / 传笺 / 低语）' },
  { token: '{{约会}}', tip: '约会的风格化叫法（约会 / 私会 / 相会 / 夜会）' },
  { token: '{{马甲}}', tip: '主角匿名身份的风格化叫法（马甲 / 化名 / 假面）' },
  { token: '{{马甲说明}}', tip: '本次主角署名规则（已生成马甲时写明马甲名；未生成时要求匿名网名）' },
  { token: '{{本次板块名}}', tip: '本次涉及的板块名（多个用顿号连接，随风格换装）' },
  { token: '{{全部板块ID}}', tip: '六个板块的合法 id 列表（boards 只能从这里取）' },
  { token: '{{板块ID}}', tip: '本次定点板块的 id（仅板块定点玩法）' },
  { token: '{{关键词}}', tip: '本次搜索关键词（仅关键词玩法）' },
  { token: '{{原帖标题}}', tip: '被续写帖的标题（缺省为「（见资料块）」）' },
  { token: '{{原帖正文}}', tip: '被续写帖的正文节选（前 80 字）' },
  { token: '{{点单发起人}}', tip: '点单发起人（有单时=主角，否则=观众）' },
  { token: '{{台主名}}', tip: '点单对象的台主名（未指定时为空）' },
  { token: '{{私密台主名}}', tip: '私密房台主名（未指定时为「台主」）' },
  { token: '{{点单内容}}', tip: '本单的点单指令原文' },
  { token: '{{加码档}}', tip: '本单加码档（口头 / 动作 / 专场）' },
  { token: '{{对方名}}', tip: '搭话/约会对象名（未指定时为「对方」）' },
  { token: '{{节点}}', tip: '约会节点序号（首段为 1，推进中为 next）' },
  { token: '{{角色名}}', tip: '档案卡角色名（未指定时为「这位角色」）' },
  { token: '{{委托内容}}', tip: '主角委托帖的要求原文' },
  { token: '{{发帖人}}', tip: '求解锁帖的发帖人（未指定时为「发帖人」）' },
  { token: '{{求解锁图描述}}', tip: '求解锁图片的画面描述（前 60 字）' },
];

/** 只列当前文本实际用到的占位符（避免噪音）。 */
export function nightPromptTokensOf(text: string): ReadonlyArray<{ token: string; tip: string }> {
  return NIGHT_PROMPT_TOKENS.filter(t => text.includes(t.token));
}

// ─── 默认文本（= 改造前 modeBody 的机械 token 化） ───

/** 各 mode 的任务与专属规则（动态值全部 token 化，注入侧统一替换）。 */
export function nightModeBodyTemplate(mode: NightMode): { task: string; rules: string[] } {
  switch (mode) {
    case 'refresh':
      return {
        task: `【任务】生成{{应用}}（成人向{{街区}}）今夜的整版新{{帖子}}：板块表 + 4-8 条新{{帖子}}（评论一次成型）。`,
        rules: [
          `板块表 boards 给出 6 个板块 id 的顺序（只能取：{{全部板块ID}}），本次重点覆盖：{{本次板块名}}。`,
          NIGHT_VOLUME_RULE,
          `发帖人从资料块名单里按人设选（必须完全代入其性格、口癖与对主角的态度：人设放得开的才写高尺度，保守的可只擦边、围观吐槽或不出场，名额让给路人），其余用有生活感的路人网名（「身份+场所」式，如「三楼理发师傅」「跑夜班的哥」）；名单内角色一律用真实姓名，禁止另起网名。`,
          `{{马甲说明}}`,
          '每条帖都必须是成人向内容：路人帖按本次尺度档写满，名单角色的帖先过人设关——只写这个人按其性格与关系真的会发的内容与尺度；「暗房」板块每条必带 1-3 张图，其余板块按图文比决定。',
          '评论要像深夜论坛：起哄、追问、抬杠、求图、约，短而具体；楼层用 reply 指向被回复的人。',
        ],
      };
    case 'more':
      return {
        task: `【任务】生成{{应用}}（成人向{{街区}}）今夜的整版新{{帖子}}：板块表 + 4-8 条新{{帖子}}（评论一次成型）。这是"再看一点"的补充生成，必须是此前内容之外的新内容。`,
        rules: [
          `板块表 boards 给出 6 个板块 id 的顺序（只能取：{{全部板块ID}}），本次重点覆盖：{{本次板块名}}。`,
          NIGHT_VOLUME_RULE,
          `发帖人从资料块名单里按人设选（必须完全代入其性格、口癖与对主角的态度：人设放得开的才写高尺度，保守的可只擦边、围观吐槽或不出场，名额让给路人），其余用有生活感的路人网名（「身份+场所」式，如「三楼理发师傅」「跑夜班的哥」）；名单内角色一律用真实姓名，禁止另起网名。`,
          `{{马甲说明}}`,
          '每条帖都必须是成人向内容：路人帖按本次尺度档写满，名单角色的帖先过人设关——只写这个人按其性格与关系真的会发的内容与尺度；「暗房」板块每条必带 1-3 张图，其余板块按图文比决定。',
          '评论要像深夜论坛：起哄、追问、抬杠、求图、约，短而具体；楼层用 reply 指向被回复的人。',
        ],
      };
    case 'board':
      return {
        task: `【任务】生成{{应用}}「{{本次板块名}}」板块内的 6-10 条新{{帖子}}（评论成型），其余板块不出。`,
        rules: [
          `boards 只给这一个板块 id：{{板块ID}}。`,
          NIGHT_VOLUME_RULE,
          `内容必须紧扣该板块的写法 brief；发帖人按人设从名单里选（人设允许的才参与，保守角色可只围观或不出场），其余路人。`,
          `{{马甲说明}}`,
          '全部内容落在本次尺度档内，暗房板块每条必带图。',
        ],
      };
    case 'keyword':
      return {
        task: `【任务】围绕关键词「{{关键词}}」生成{{应用}}内 4-8 条相关{{帖子}}（标题/正文/标签必须真的与这个词相关）。`,
        rules: [
          `帖子只能落在资料块列出的板块 id 内，禁止自造板块。`,
          NIGHT_VOLUME_RULE,
          '关键词要落在标题或正文里，不能只是擦边；同一关键词下要有不同角度（求、分享、测评、约）。',
          `{{马甲说明}}`,
          '内容按本次尺度档写。',
        ],
      };
    case 'post':
      return {
        task: `【任务】为{{应用}}里的一条{{帖子}}续写新回复。原帖：「{{原帖标题}}」／{{原帖正文}}`,
        rules: [
          '只输出 comments（3-6 条新回复），不要重复资料块「已有内容摘要」里出现过的回复。',
          '回复必须贴着原帖内容与已有评论往下接：可以追问细节、起哄、给建议、开价、约、阴阳。',
          '若有资料块档案卡里的角色参与，必须守其底线；路人网名保持生活感。',
          `{{马甲说明}}`,
          '回复长度 10-40 字，时间填绝对故事时间。',
        ],
      };
    case 'live':
      return {
        task: `【任务】生成{{应用}}{{舞台}}的当前开台列表：3-6 个房间（含正在开台与预告两种状态）。`,
        rules: [
          '台主用资料块名单内角色（真名，人设适合吃这碗饭的才当台主）与路人主播网名混排；标题要露骨勾人但有平台味。',
          'status 用 live（正在开台）或 idle（预告）；live 的给 rank（3-8 条打赏榜）与 barrage（8-14 条弹幕），idle 的可省略。',
          'coverDesc 是画面描述（谁/在哪/穿什么/镜头角度），按本次尺度档写。',
          `{{马甲说明}}`,
          'heat/viewers 数量级要可信（小主播几百观众，头部上万）。',
        ],
      };
    case 'private':
      return {
        task: `【任务】推进{{应用}}私密房里 {{私密台主名}} 与主角的 1 对 1 进程一小段。`,
        rules: [
          '私密房里只有两个人：台词只由台主说，弹幕不再出现（barrages 留空或省略），主角的话不要代替他写。',
          'lines 为台主本轮台词（≤4 句）；reply 写一句直接对主角说的话（更近、更直接、带称呼）。',
          '遵守该台主档案底线；越界要合规拒绝（拒绝也算推进）。',
          `尺度按本次尺度档；heat 给本轮增量。`,
        ],
      };
    case 'order':
      return {
        task: `【任务】{{应用}}{{舞台}}里，观众「{{点单发起人}}」对 {{台主}}「{{台主名}}」下了点单指令：「{{点单内容}}」（当前加码档：{{加码档}}）。请回应这一单。`,
        rules: [
          '**先判定是否接受**：严格按该台主档案卡的「底线」与接受度判定。合规的、在其偏好与可接受尺度内的→accepted=true；越界/触碰底线的→accepted=false 并写 rejectReason（写成台主的拒绝台词：不好意思、今天不行、换个玩法，语气要像直播间的真人，不得说教或道歉过度）。',
          '若主角是打赏榜第一（资料块写明），本单必不拒绝（榜一特权，且台词里要用专属称呼叫主角的马甲名）。',
          'tier 按加码档写：口头=只用嘴回应；动作=照做一个动作并描述画面；专场=切私密房、给这一位观众专属回应。',
          'lines 为台主本轮台词（≤4 句）；barrages 是观众起哄（5-10 条）；heat 是热度增量。',
          '拒绝时也必须出弹幕与热度（观众会起哄），不得空输出。',
        ],
      };
    case 'dm':
      return {
        task: `【任务】推进{{应用}}{{搭话}}里与 {{对方名}} 的对话一轮。`,
        rules: [
          'msgs 里 from 一律 "peer"（对方说的话，2-4 条短消息），**严禁替主角编造消息**——主角的回复由玩家自己发。',
          '语气符合对方身份、来源与彼此关系；亲密程度以资料块「最近亲密互动」与正文已到达的关系为准，不得凭空升温；可以主动、可以试探、可以拒绝、可以发图（image.desc 给画面描述）或送礼回执（card）。',
          '内容按本次尺度档；对方底线不可越（越界会直接冷淡或结束话题）。',
          '可更新 online / sourceLabel / distanceLabel（对方状态与来源）；时间 t 不填。',
        ],
      };
    case 'date':
      return {
        task: `【任务】推进主角与 {{对方名}} 的{{约会}}：只推**一个**节点（第 {{节点}} 段）。`,
        rules: [
          'scene 写这一段场景（80-200 字，环境、距离、气氛、身体反应），lines 写双方对白（注明谁说的，主角的话要短、要给玩家留选择空间）。',
          'choice 必须给**两选**（一个更近一步，一个保持距离/收一收），选项各 ≤16 字；不要替主角选。',
          '节奏：一次只推一段，不许一次写完整个约会；下一段基调由玩家本次选择决定（资料块已写明上一段的选择）。',
          '遵守对方档案底线与本次尺度档，推进节奏顺着两人当前关系（以资料块「最近亲密互动」与正文为准，不得凭空跳级）；对方不愿意时要用对白与动作表达（拒绝/躲开/换个地方），而不是报错。',
          'place 可更新地点；time 填绝对故事时间。',
        ],
      };
    case 'persona':
      return {
        task: `【任务】生成「{{角色名}}」在{{应用}}里的角色档案卡（观众看到的公开资料；必须是这个人本人，不是新造一个色情人格）。`,
        rules: [
          '外貌/身材以资料块档案为准（数据库有身材数据就照抄，不得自创；没有就按外貌特征合理推断并保持克制的量级）。',
          'likes/limits/acceptance/spiceMax 一律从该角色的性格、身份、对主角的态度与正文/纪要既有表现推导，**禁止凭空发明**这个人没有的偏好；正文未体现其性开放的，acceptance≤2 且 spiceMax≤2。',
          'likes 是其偏好的玩法/场景（≤4 个词）；limits 是其**底线**（≤4 个词，越界一律拒绝的类型）；acceptance 越高越能接受越界请求。',
          'spiceMax 是其按人设能接受的最大尺度（人设保守就是低档，不得为了好看拔高）；signature 从其语言风格推一句口头禅或签名；posts/works 是数量级（素人几十、活跃几百、头部上千）。',
        ],
      };
    case 'aboutMe':
      return {
        task: `【任务】生成{{应用}}专题页「他们怎么谈论你」的内容：6-10 条**关于主角**的帖子（目击帖 / 议论帖 / 喊话帖三类混排）。`,
        rules: [
          '**反全知铁律**：只能基于资料块「最近正文进展」里**已经发生、已经说过、被人看见**的片段，以及只读参考资料里的公开信息。不得写主角未公开的心事、主角未在场的场景、正文未确立的关系。',
          '每条帖必须带 sourceHint（来源线索，一句话氛围化，如「来自：你和他在楼道里说的那句话」「来自：那天晚上有人在楼下看见的」）；**禁止写楼层号、时间戳编号或任何定位标记**。',
          '三类混排：目击帖（有人看见 + 复述 + 起哄）、议论帖（拿主角当话题讨论、猜测、约）、喊话帖（直接对主角喊话：约、挑衅、表白、求）。',
          '作者按人设从名单里选（真名，按其对主角的态度说话，保守角色的议论与喊话也收敛在本人分寸内），其余是路人网名；严禁以主角身份发帖。',
          '提到主角时用马甲名或「那个人」「楼上那位」这类称呼，不得出现主角真名。',
          'kind 一律 "about"，board 从资料块板块 id 里取（按话题气质选）。',
          `{{马甲说明}}`,
        ],
      };
    case 'commission':
      return {
        task: `【任务】为主角的委托帖生成 3-6 条应征（别人交上来的图/文/剧情）。委托内容：「{{委托内容}}」`,
        rules: [
          '每条应征给 author（应征人网名或名单角色真名）、text（应征正文 ≤120 字，写清楚交了什么，态度各异：认真、敷衍、炫耀、求采纳）。',
          '若委托要求图片，image.desc 必填（按本次尺度档写画面描述）；正文类可省略 image。',
          'spice 是这条应征的实际尺度，不得超过委托期望尺度太多。',
          '不得替主角采纳（adoptedEntryId 由玩家在界面上决定）。',
        ],
      };
    case 'unlock':
      return {
        task: `【任务】主角想解锁 {{发帖人}} 一张需要作者同意的图（画面描述：「{{求解锁图描述}}」，主角的求解锁留言已在资料块）。请让作者回应这次求解锁。`,
        rules: [
          'grant=true 表示作者同意解锁（关系亲近、主角此前互动过、或该图本来就不敏感时给 true；关系疏远、图很私密、作者性格保守时给 false）。',
          'reply 是作者对主角说的话（≤40 字），同意要带条件或调侃（「就这一次」「看完别外传」），拒绝要给理由。',
          'comments 是帖子下 1-3 条新评论（围观群众起哄），不得重复已有评论。',
        ],
      };
    default:
      return {
        task: `【任务】为{{应用}}生成主角的{{马甲}}：一个只在这个应用里使用的匿名身份。`,
        rules: [
          'alias ≤8 个字，生活化、不正经、有夜色感（如「楼下便利店的三花」「深夜加班狗」），**不得与资料块任何角色重名**，不得使用主角真名。',
          'signature 是一句自我介绍的签名（≤20 字，第一人称口吻，可带一点自嘲或浪荡）。',
          'level 1-8（新号低，老号高，取 2-4），coins 200-500。',
        ],
      };
  }
}

/** 规则行统一编号（模板里不写死序号——增删规则不用改数字，序号永远连续）。 */
export function numberNightRules(rules: string[]): string {
  return rules
    .map(r => r.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
    .map((r, i) => `${i + 1}. ${r}`)
    .join('\n');
}

/** 玩法默认可编辑文本（任务 + 规则；注入侧与编辑器初值共用）。 */
export function nightModeBodyDefault(mode: NightMode): string {
  const { task, rules } = nightModeBodyTemplate(mode);
  return `${task}\n\n【规则】\n${numberNightRules(rules)}`;
}

/** 板块默认可编辑文本（只承载内容 brief）。 */
export function nightBoardPromptDefault(boardId: string): string {
  return nightBoardDef(boardId)?.brief || '';
}

/** 按覆盖键取内置默认（未知键 = 空串）。 */
export function nightPromptDefault(key: string): string {
  if (key === NIGHT_RULES_KEY) return NIGHT_RULES;
  if (key.startsWith(NIGHT_BOARD_KEY_PREFIX)) return nightBoardPromptDefault(key.slice(NIGHT_BOARD_KEY_PREFIX.length));
  const mode = key.slice(NIGHT_PROMPT_KEY_PREFIX.length) as NightMode;
  return (NIGHT_MODES as readonly string[]).includes(mode) ? nightModeBodyDefault(mode) : '';
}

/** 保存校验：只拦空文本（占位符可自由增删，未知占位符原样保留）。 */
export function validateNightPromptText(text: string): string | null {
  return text.trim() ? null : '内容为空：留空等于恢复默认，请点下方「恢复本套默认」。';
}

/** 取一套提示词：覆盖优先，空白/缺省回落内置默认。 */
export function resolveNightPromptText(key: string, overrides?: Record<string, string>): string {
  return promptOverrideOf(overrides, key, nightPromptDefault(key));
}

/** 领域无关的占位符渲染：只替换已知 token，未知 {{...}} 原样保留。 */
export function renderNightPromptTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? '') : m);
}
