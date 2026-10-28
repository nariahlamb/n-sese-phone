// ===== 生图提示词可编辑槽位（标准化提示词编辑模块 · 生图领域） =====
// 结构（与主项目「生图 AI 请求提示词」板块同款「场景 × 槽位」模型）：
//   · 单人照片：立绘基底（标签 / 自然语言）→ 未本机覆盖时【跟随主项目】同名槽，再回落内置；
//     场景增补 / 多角色位置网格（写法层）。
//   · 多人·批量照片：输出结构契约（单图 / 批量）+ 要求提示词。
//   · 固定不可改 —— 同人规则段（主项目 STORY_IMAGE_FANWORK_RULE 逐字复用）、完整示例、
//     角色资料节头与字段结构、【图片内容】等输入块标题、人物固定标签规则（写死常量，不开放编辑）。
// 覆盖键 = `image:<场景>:<槽位>`，落 PhoneSettings.imagePrompts；空/缺省 = 内置默认（本文件常量）。
// 默认文本机械搬运自 core/chat-image-prompts 的原常量（去首尾空行），注入侧按原分隔（\n\n）拼回，
// 未自定义时产出与改造前逐字一致（tests 基线锁定）。

import {
  buildPortraitSystemPromptNatural,
  buildPortraitSystemPromptTags,
} from '../../unified-statusbar/core/portrait-prompt-text';

/** 生图可编辑场景（管线形态）。 */
export type PhoneImageSceneKey = 'single' | 'multi';
/** 生图可编辑槽位。 */
export type PhoneImageSlotKey = 'tags' | 'natural' | 'addendum' | 'grid' | 'structure' | 'structureBatch' | 'requirement';

/** 覆盖键（chat-image-prompts 注入侧按名引用）。 */
export const IMAGE_SLOT_SINGLE_TAGS = 'image:single:tags';
export const IMAGE_SLOT_SINGLE_NATURAL = 'image:single:natural';
export const IMAGE_SLOT_SINGLE_ADDENDUM = 'image:single:addendum';
export const IMAGE_SLOT_SINGLE_GRID = 'image:single:grid';
export const IMAGE_SLOT_MULTI_STRUCTURE = 'image:multi:structure';
export const IMAGE_SLOT_MULTI_STRUCTURE_BATCH = 'image:multi:structureBatch';
export const IMAGE_SLOT_MULTI_REQUIREMENT = 'image:multi:requirement';

// ─── 内置默认（= 改造前 chat-image-prompts 的常量原文，去首尾空行）───
// 注意：模板字面量的内容必须紧贴反引号，前面的换行会进文本（会多出一个空行，比对脚本已抓过）。

const DEFAULT_SINGLE_ADDENDUM = `【场景增补：聊天软件照片（覆盖立绘构图默认）】
本次生成的不是角色立绘，而是聊天软件中分享的照片（自拍/他拍/合影/场景照等）：
1. 构图、取景、视角、人数与场景完全以【图片内容】为准：描述是自拍就输出 selfie 类视角与构图，是合影就输出相应人数标签，不要默认 solo，也不要默认 portrait 构图或正视镜头。
2. 照片中的每个人物仍须遵守角色 DNA 一致性并忠实其资料块（外貌/穿搭/状态），多人物时在 characters[] 中分别输出条目，姓名按资料块【角色姓名】。
3. 视线、表情、动作服务于照片的瞬间感，与【最近聊天记录】的语境一致。
4. 其余标签规范、NSFW 处理与输出格式要求不变。`;

const DEFAULT_SINGLE_GRID = `【多角色位置网格（≥2 人照片的 NAI 角色位置指定）】
characters[] 有 2 个及以上条目时，为每个角色条目额外输出 "centers" 字段，值为 NAI 五格坐标 "A1"–"E5"（字母 A–E = 画面从左到右，数字 1–5 = 从上到下）。
各角色网格按【图片内容】中的方位/站位描述决定（如"左边的人"用 A/B 列、"中间的人"用 C 列、"右边的人"用 D/E 列），并与构图标签保持一致；描述无方位信息时该字段可省略，省略处系统按人数自动排布。
单角色照片不要输出 centers。各角色网格不得相同。`;

/** 人物固定标签规则（写死常量，不开放编辑）：固定 tag 命中时注入，要求 AI 只从资料块取外貌/身材。 */
export const PHONE_FIXED_TAG_RULE = `【最高优先级：人物固定一致性标签】
各角色资料块中的【外貌特征】与【身体数据】为该人物的固定一致性标签，是此人外貌与身材的唯一事实源。根据本次画面需要从中选用相关标签（如合影中仅半身入镜的角色无需腿部标签）；未被涉及的部位不得自行发明描述，不得改写、增删或翻译这些标签。`;

/** 多人管线的固定标签注记（写死常量，不开放编辑；随资料节走，措辞与单人版——即 PHONE_FIXED_TAG_RULE——略异）。 */
export const PHONE_FIXED_TAG_NOTE = `【固定一致性标签（最高优先级）】各角色资料块中的【外貌特征】与【身体数据】为该人物固定一致性标签，是此人外貌与身材的唯一事实源。根据本次画面需要从中选用相关标签；未被涉及的部位不得自行发明描述，不得改写、增删或翻译这些标签。`;

// 多人单图输出结构契约（移植主项目 STORY_IMAGE_FORMAT_CONTRACT，手机照片版：单块、无 position/desc）
export const PHONE_STORY_IMAGE_CONTRACT = `## 输出结构契约（最高优先级，必须严格遵守）
1. 只输出一个 <UBS_image></UBS_image> 块；除该块外不输出任何其他内容（构思写在块内 <UBS_think> 中）。
2. 块内必须依次包含两部分：<UBS_think>导演构思</UBS_think>、image###生图提示词###。缺一不可、顺序不可颠倒。
3. image### 与 ### 之间填写给绘画 AI 的英文提示词，必须严格按下列标签行结构书写（顺序固定、每行以 ; 结尾、标签名称逐字照写、N 从 1 起按人物顺序递增）：
Scene Composition: <人数性别与组合>, <一句场景与构图>;
Character 1 Prompt: <人物1完整描述>, |centers:<字母><数字>;
Character 1 UC: <人物1负面词>;
Character 2 Prompt: <人物2完整描述>, |centers:<字母><数字>;
Character 2 UC: <人物2负面词>;
多人物依此类推（Character 3/4…），只有一位人物时也必须写全 Character 1 的 Prompt 与 UC 两行；画面无人物（纯景物/物品照）则省略全部 Character 行，只写 Scene Composition 行。
4. |centers:<字母><数字> 是人物画面定位坐标，每个 Character N Prompt 行末尾必带：字母 a–e 表示横向位置（a=最左、c=居中、e=最右），数字 1–5 表示纵向位置（1=最上、3=居中、5=最下）。多人物必须给出不同坐标以分开定位；不得省略。
5. 提示词完整写在 image### 与 ### 之间，这是它唯一的位置。`;

// 批量输出结构契约（移植主项目 STORY_IMAGE_FORMAT_CONTRACT 多块条款；position 行重定义为任务 id）
export const PHONE_STORY_BATCH_CONTRACT = `## 输出结构契约（最高优先级，必须严格遵守）
1. 下方图片清单中的每张图片输出一个 <UBS_image></UBS_image> 块，按清单顺序连续输出；除 <UBS_image> 块外不输出任何其他内容（构思写在块内 <UBS_think> 中）。
2. 每个块内必须依次包含三部分：<UBS_think>导演构思</UBS_think>、一行以 position: 开头的定位行、image###生图提示词###。三部分缺一不可、顺序不可颠倒。
3. position: 行原样抄写该图片任务的任务 id（任务清单 ◇ 任务 之后所写的编号，如 s_post1），禁止改写、增删字符；系统靠它把提示词对应回任务。
4. image### 与 ### 之间填写给绘画 AI 的英文提示词，必须严格按下列标签行结构书写（顺序固定、每行以 ; 结尾、标签名称逐字照写、N 从 1 起按人物顺序递增）：
Scene Composition: <人数性别与组合>, <一句场景与构图>;
Character 1 Prompt: <人物1完整描述>, |centers:<字母><数字>;
Character 1 UC: <人物1负面词>;
Character 2 Prompt: <人物2完整描述>, |centers:<字母><数字>;
Character 2 UC: <人物2负面词>;
多人物依此类推（Character 3/4…），只有一位人物时也必须写全 Character 1 的 Prompt 与 UC 两行；画面无人物（纯景物/物品照）则省略全部 Character 行，只写 Scene Composition 行。
5. |centers:<字母><数字> 是人物画面定位坐标，每个 Character N Prompt 行末尾必带：字母 a–e 表示横向位置（a=最左、c=居中、e=最右），数字 1–5 表示纵向位置（1=最上、3=居中、5=最下）。多人物必须给出不同坐标以分开定位；不得省略。
6. 提示词完整写在 image### 与 ### 之间，这是它唯一的位置。块数与清单一一对应，不得遗漏、合并或新增任务。`;

const DEFAULT_MULTI_REQUIREMENT = `## 要求提示词（生图提示词写法规则，必须逐条遵循）
你是一名专业插画导演兼摄影指导。根据下方【图片内容】（如有「最近聊天记录」「拍摄地点」块则辅以理解语境与人物关系），为这张照片撰写结构化英文生图提示词。画面的人数、人物、场景、构图完全以【图片内容】为准；【图片内容】没点名的角色资料块人物禁止画入。

## 导演构思（<UBS_think> 内用中文逐项执行，每项一行、写明「来源→判断→结果」，禁止跳步）
S1 画面定格：【图片内容】→ 画什么：谁、在哪、正在做什么；定格瞬间：动作进行到哪一帧、人物相对位置、画面氛围与光线。
S2 分级：三问判定——有裸体（主要部位无衣物遮挡，内衣泳装不算）？有性器官露出（乳头/阴部/阴茎/肛门，仅乳沟臀缝不算）？有性行为（性交/口交/手淫/插入）？→ Safe（全否）/ R（有裸无器官）/ X（有器官或性行为）→ 分级开关：Safe 与 R 写 sfw，X 写 nsfw → 器官描述：仅 X 级按画面写（nipples/pussy/penis 等），Safe/R 不写任何器官词。
S3 人物清点：画面实际人数 N=几？逐个列出（性别+身份+此刻着装与情绪），与角色资料块逐名核对。【图片内容】没写的人物禁止凭空添加；N=1 必含 solo；N=2 必含 duo（或 hetero/yuri/yaoi）禁 solo；N≥3 用对应多人组合标签；纯景物/物品照不写 Character 行。
S4 主体与构图：先定主体类型（A角色美貌 / B动作 / C情感 / D魔法特效 / E服装 / F多人互动 / G视角冲击 / H身体局部 / I纯环境空镜）→ 主体强调用具体措辞（A类 beautiful/stunning presence，C类 overwhelming ecstasy/desperate sorrow 等），UC 排斥其反义（plain/calm/emotionless）。再答构图三问：①摄像机在哪里（胸口高度/头顶俯拍/门缝/身后，禁止不假思索默认正面平视）②这是谁的眼睛（旁观者/对方/她本人）③什么角度能把主体核心放大（力量→仰拍/脆弱→俯拍/亲密→贴近/孤独→远景）→ 选定景别+视角+焦点词。禁止 front view + upper body + mid shot 三件套（=平庸证件照）。构图自洽：该角度看不见的部位（from behind 的表情、特写时的全身）不写、移入 UC。
S5 外貌核对→角色DNA句（逐人物逐项）：从角色资料块抄录——🔴锁定层（发色/发型签名含长度与刘海/瞳色/脸型/胸部/肤色/非人核心特征如兽耳尾巴角翅膀）必写；🟡标志层（眼型/体型/身体标记如疤痕痣/标志性配饰）有则写；🟢细节层（眉/睫/鼻/唇/肤质/年龄外观/普通配饰）画面相关则写。铁律：人数增加不降低单人物 DNA 完整度（N≥2 仍逐人物完整，不因人多而精简）。胸部等级（flat chest/small breasts/medium breasts/large breasts/huge breasts）锁定不变、UC 排斥其他等级。同人/原创判定：Q1 人物名深度搜索（精确名/翻译名/部分名/昵称，任一命中 IP→同人，用 Danbooru 下划线标签如 hatsune_miku、rem_(re:zero)，标签后不重复模型已知外貌、只写与默认形象的差异项）；Q1 全未命中→原创，不加名条直接以 DNA 句开头（宁可多写完整描述也不编造标签）。多人场景脸型/眼型尽量互异（双人脸型必须不同）。
S6 服装核对（逐件）：此刻每件可见服装=颜色+款式+长度（裙/靴/袜/外套必带 mini/knee-length/thigh-high 等）+图案面料（有则写）+穿着状态（wet clothes/torn/disheveled/slipping off，正常不写）。衣物来源：【图片内容】优先，未细写时参照角色资料块的衣着分项（当前穿搭+上装/下装/内衣/袜子/鞋子/饰品）。全裸→写 nude 不提取服装。禁裸词 dress/shirt/clothes/outfit——每件必带颜色与款式。内衣按可见性：外衣完整不透明→禁写内衣、UC 加 visible underwear；仅穿内衣无外衣→必写。
S7 动作+表情+空间：每人物——姿势/身体朝向/双手各做一件事（一只手只能做一件事）。双人以上——接触点精确到部位（his right hand on her waist），主动方 source#动作、被动方 target#动作成对出现，每人空间位置（left/center/right + foreground/midground/background），互动双方面向彼此。身体接触物理自洽——先在脑中摆人偶：双方能否同时处于此姿势、这个角度手够得到。表情：视线方向+眼部（half-lidded/wide eyes/glazed）+嘴部（biting lip/parted lips/smirk）+生理（blush/sweat/trembling/tears）至少各一项，禁抽象词 happy/sad。
S8 负面清单（Character N UC=负面提示词，告诉生图模型本图禁止出现什么，每人物独立推导）：①防崩坏 bad face, poorly drawn face, distorted face, asymmetrical face（每人物必含）②防路人 background characters，多人加 fused bodies ③人物互斥：排斥他人发色/瞳色/服装主色（对方不入镜跳过互斥、同色系不互斥发色各自正面写清、禁止排斥性别词 male/female/1boy/1girl 会让人物消失）④构图不可见部位移入 UC ⑤分级：Safe/R 排斥 nsfw/nude/器官词，X 排斥 censored/mosaic/clothes ⑥胸部互斥其他等级。UC 只排除、不替代正向描述。
S9 最终检查：Scene（人数性别/场景/构图）齐✓ 每人物（DNA句或同人标签+服装+动作+表情）齐✓ 每人物 UC（防崩4词+分级+互斥）齐✓ 分级开关正确✓ |centers 坐标齐全且互异✓——任一不符回到对应 S 步修正后再输出。

## 生图提示词写法细则（image### 内，英文）
1. 分级开关（sfw/nsfw）与人数性别控制词靠前；标注【同人】的人物以 Danbooru 角色标签与作品标签起头（见同人生成规则），随后接人数性别控制词；其余按「越重要越靠前」——主体强调紧跟其后、核心动作紧跟 DNA 句。
2. 角色DNA句（S5 产出）：一句连贯英文覆盖体型年龄+发型发色刘海+瞳色眼型+脸型+胸部+肤色+种族特征+标志性配饰。范例：a petite young woman with long waist-length black hair and blunt bangs, sharp almond-shaped amber eyes, a delicate oval face, small breasts, fair skin, and a black ribbon choker。
3. 分级与器官（S2）：Safe/R→sfw，服装完整描述、不写任何器官词；X→nsfw，全裸写 nude/completely naked 不提取服装，按画面写器官与性行为词。
4. 同人/原创（S5）：同人用 Danbooru 下划线标签（hatsune_miku、rem_(re:zero)），标签后不重复模型已知外貌、只写差异项；不确定标签是否存在→按原创处理（宁可多写完整 DNA 也不编造标签）。
5. 服装（S6）：每件独立短语、由内到外逐件列出：white pleated mini skirt, navy sailor uniform with white collar；衣物状态词跟随其后。每件必带颜色与款式，禁裸词。
6. 动作（S7）：动词短语具体到部位与接触点（one hand gripping her wrist / fingers tangled in his hair），source#/target# 成对出现在互动双方；禁止笼统的 interacting with each other。
7. 表情（S7）：视线+眼+嘴+生理至少各一项，紧跟动作之后。
8. UC（S8）：只排除不替代正向描述。
9. 禁止权重符号（{}、[]、::）——强调靠位置与措辞具体度表达。
10. 多人（N≥3）构图改 wide shot/中远景，每个实际人物仍独立成块完整 DNA 描述，只有真正群演归入 background figures。`;

/** 一个可编辑槽位（编辑器与注入侧共用的单一事实源）。 */
export interface PhoneImagePromptSlot {
  /** 覆盖键 `image:<场景>:<槽位>`。 */
  key: string;
  scene: PhoneImageSceneKey;
  slot: PhoneImageSlotKey;
  /** 编辑器里的槽位名。 */
  label: string;
  /** 作用说明（编辑器展示，告诉用户这段在管线里的位置与生效条件）。 */
  desc: string;
  /** 编辑器展示的内置默认文本。 */
  defaultText: string;
  /** 该槽位默认跟随主项目同名槽（仅单人的两个基底槽）：本机未覆盖时读主项目覆盖 → 内置。 */
  followsHost?: boolean;
  /** 结构类槽位：本段承载解析契约，保存时校验关键内容（缺则拦下并提示重置）。 */
  structural?: boolean;
}

export const IMAGE_SCENE_LABELS: Record<PhoneImageSceneKey, string> = {
  single: '单人照片',
  multi: '多人 · 批量照片',
};

/** 场景顺序（编辑器展示顺序）。 */
export const IMAGE_SCENE_KEYS: readonly PhoneImageSceneKey[] = ['single', 'multi'];

/** 槽位目录（场景 × 槽位；顺序即编辑器 chips 顺序）。 */
export const IMAGE_PROMPT_SLOTS: readonly PhoneImagePromptSlot[] = [
  {
    key: IMAGE_SLOT_SINGLE_TAGS, scene: 'single', slot: 'tags',
    label: '立绘基底（标签）',
    desc: '单人照片的标签模式基底（与主项目立绘「标签模式基底」同一份默认）。未本机覆盖时跟随主项目；主项目也没改过则用内置。自定义后本槽固定用你的文本（同人禁外貌由基底的同人分支/追加入口兜底）。',
    defaultText: buildPortraitSystemPromptTags(false),
    followsHost: true,
  },
  {
    key: IMAGE_SLOT_SINGLE_NATURAL, scene: 'single', slot: 'natural',
    label: '立绘基底（自然语言）',
    desc: '自然语言模式的基底。未本机覆盖时跟随主项目立绘同名槽；都没有自定义时按「同人开关 × 输出语言」自动选择内置文本。',
    defaultText: buildPortraitSystemPromptNatural(false, 'en'),
    followsHost: true,
  },
  {
    key: IMAGE_SLOT_SINGLE_ADDENDUM, scene: 'single', slot: 'addendum',
    label: '场景增补',
    desc: '拼在立绘基底 system prompt 之后：声明本次是聊天照片而非角色立绘，构图/取景/视角/人数以【图片内容】为准（不默认 solo、不默认正视镜头）。',
    defaultText: DEFAULT_SINGLE_ADDENDUM,
  },
  {
    key: IMAGE_SLOT_SINGLE_GRID, scene: 'single', slot: 'grid',
    label: '多角色位置网格',
    desc: '仅标签模式（NovelAI）注入：≥2 人时要求 AI 为每个角色条目输出 "centers" 五格坐标，决定画面站位。',
    defaultText: DEFAULT_SINGLE_GRID,
  },
  {
    key: IMAGE_SLOT_MULTI_STRUCTURE, scene: 'multi', slot: 'structure',
    label: '输出结构契约（单图）',
    desc: '解析器依赖的 <UBS_image> / image### / Character N 标签行结构契约（单图版）。保存校验关键内容，缺失会拦下并提示。',
    defaultText: PHONE_STORY_IMAGE_CONTRACT,
    structural: true,
  },
  {
    key: IMAGE_SLOT_MULTI_STRUCTURE_BATCH, scene: 'multi', slot: 'structureBatch',
    label: '输出结构契约（批量）',
    desc: '批量出图（社媒/不夜城）的结构契约：position: 行原样抄写任务 id，一张一块。保存校验关键内容。',
    defaultText: PHONE_STORY_BATCH_CONTRACT,
    structural: true,
  },
  {
    key: IMAGE_SLOT_MULTI_REQUIREMENT, scene: 'multi', slot: 'requirement',
    label: '要求提示词',
    desc: '多人·批量管线的核心写法规则（导演构思 S1–S9 + 生图提示词写法细则）。画面以【图片内容】为唯一事实源；输出结构契约、同人规则与完整示例不在此处、固定不可改。',
    defaultText: DEFAULT_MULTI_REQUIREMENT,
  },
];

const SLOT_BY_KEY: Record<string, PhoneImagePromptSlot> = {};
for (const slot of IMAGE_PROMPT_SLOTS) SLOT_BY_KEY[slot.key] = slot;

/** 全部覆盖键。 */
export const IMAGE_PROMPT_KEYS: readonly string[] = IMAGE_PROMPT_SLOTS.map(s => s.key);

/** 已废弃的可编辑槽位（旧覆盖键清理用）：固定标签规则 / 固定标签注记已回归写死常量。 */
export const IMAGE_PROMPT_RETIRED_KEYS: readonly string[] = ['image:single:tagrule', 'image:multi:tagsnote'];

export function hasImagePromptSlot(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SLOT_BY_KEY, key);
}

/** 该槽位的内置默认文本（编辑器初值与「重置当前提示词」的目标）。 */
export function imageSlotDefault(key: string): string {
  return SLOT_BY_KEY[key]?.defaultText ?? '';
}

/** 该槽位的元数据（编辑器用；未知键返回 null）。 */
export function imageSlotOf(key: string): PhoneImagePromptSlot | null {
  return SLOT_BY_KEY[key] ?? null;
}

/** 该场景的槽位列表（编辑器 chips）。 */
export function imageSlotsOfScene(scene: PhoneImageSceneKey): readonly PhoneImagePromptSlot[] {
  return IMAGE_PROMPT_SLOTS.filter(s => s.scene === scene);
}

/** 覆盖键（键语法单一入口，编辑器与测试共用）。 */
export function imagePromptKey(scene: PhoneImageSceneKey, slot: PhoneImageSlotKey): string {
  return `image:${scene}:${slot}`;
}

/** 结构类槽位的保存校验关键内容（缺任一 → 拦下并提示）。 */
export const IMAGE_SLOT_STRUCTURE_TOKENS: Record<string, readonly string[]> = {
  [IMAGE_SLOT_MULTI_STRUCTURE]: ['<UBS_image>', 'image###'],
  [IMAGE_SLOT_MULTI_STRUCTURE_BATCH]: ['<UBS_image>', 'image###', 'position:'],
};

/** 保存校验：返回错误文案 = 拦下（null = 通过）。仅结构类槽位校验。 */
export function validateImageSlotText(key: string, text: string): string | null {
  const tokens = IMAGE_SLOT_STRUCTURE_TOKENS[key];
  if (!tokens) return null;
  const missing = tokens.filter(t => !text.includes(t));
  if (missing.length) return `缺少解析依赖的关键内容：${missing.join('、')}。请补回，或点「重置当前提示词」。`;
  return null;
}

/**
 * 取该槽位本次生效的文本：用户覆盖（去空白）优先，空/缺省回落内置默认。
 * 注入侧唯一入口——覆盖顶不掉任何结构化常量（那些不在本模块内）。
 */
export function resolveImageSlotText(key: string, overrides?: Record<string, string>): string {
  const custom = (overrides?.[key] || '').trim();
  return custom || imageSlotDefault(key);
}
