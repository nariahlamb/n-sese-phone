// ===== 正文插图（自动文生图）：AI 要求提示词与指令组装 =====
// 两层分离（结构 vs 规则）：
//   - 输出结构契约（STORY_IMAGE_FORMAT_CONTRACT）= 规定「必须输出什么」（<UBS_image> 块骨架、
//     position 原样摘录、image###提示词###），写死在代码里，不随用户自定义变化——
//     保证前端能解析、能定位、能提取提示词。提示词只规定死唯一格式，不在提示词里声明变体
//     或列举负面/后果（反样本污染）——变体兜底全归解析器。
//   契约标签用 UBS_ 前缀（<UBS_image>/<UBS_think>）而非通用 image/imgthink 名——通用名易被
//     酒馆正则替换或通用标签剥离误伤；UBS_ 前缀唯一、不会被误剥离。解析器仍兜底旧 image/imgthink 名。
//   - 要求提示词（DEFAULT_STORY_IMAGE_REQUIREMENT / 用户自定义）= 规定「生图提示词怎么写」
//     （导演构思流程、角色 DNA、服装签名、动作空间关系、构图三问），默认内置、可自定义。
// 默认要求提示词（2026-08-28 整体重构）按系统化的文生图方法论构建：导演思维链（S1-S9 逐项核对）、
// 自然语言 DNA 长句跨图逐字复用（无权重符号，强调靠位置与措辞具体度）、分级三问、主体优先 A-I、
// 角色 DNA 四级🔴🟡🟢⚫ + 人数不删减、服装签名、胸部等级锁定、同人/原创三问判定、
// source#/target# 交互前缀+接触点+空间位置+动作相位、表情五维视觉转译、构图三问+禁三件套、
// 跨图连续性状态只增不减。
// 2026-08-28 迭代：①主角出镜限制——采用三级递降制
//   + 立绘 PORTRAIT_PROTAGONIST_ADDENDUM 措辞，只约束主角（persona/用户角色）：不入镜＞仅局部
//   肢体＞无脸入镜（绝不刻画五官）；其余男性角色不隐藏（旧全局男性三级制仍不回归），无名配角才
//   用 faceless 精简模板。②契约新增 desc: 行——AI 每图附一句中文画面描述（15~40 字），随图入库
//   供图库/正文悬浮查看（story-image-parser description 字段）。
// 用户可在设置中自定义要求提示词（storyImage.requirementPrompt，空串 = 用默认）。
// 2026-08-28 组装机制精简（用户确认）：提示词请求不再携带酒馆全套上下文（世界书蓝绿灯/角色卡/
//   persona/场景/对话示例全部剔除，ordered_prompts 只剩破限 system + user_input），改为在
//   user_input 内自足注入「角色资料块」——从最新正文匹配恋爱对象表/重要角色表角色 + 主角，
//   按立绘同源格式注入【角色姓名】【性别】【年龄】【外貌特征】【身体数据】（外貌唯一来源=数据库表）；
//   立绘「固定一致性 tag」开启时用 tag 替代外貌/身材描述（姓名/性别/年龄保留，与立绘一致）。
//   资料块仅供外貌核对，是否出镜、穿着以正文为准（块首守卫声明）。
import type { FanIdentityTags } from './portrait-prompt-text';

/**
 * 输出结构契约（写死，任何情况下拼接在指令最前，用户自定义要求提示词无法覆盖）。
 * 只规定「输出什么结构」，纯正向指令——不列举负面格式、不描述后果（反样本污染 + 系统脆弱性
 * 描述不属于给 AI 的指令）。变体（XML/JSON）兜底全归解析器，不在提示词开口子。
 */
export const STORY_IMAGE_FORMAT_CONTRACT = `## 输出结构契约（最高优先级，必须严格遵守）
1. 每张图输出一个 <UBS_image></UBS_image> 块，多个块连续输出；除 <UBS_image> 块外不输出任何其他内容（思考放在块内 <UBS_think> 中）。
2. 每个块内必须依次包含四部分：<UBS_think>导演构思</UBS_think>、一行以 position: 开头的定位行、一行以 desc: 开头的描述行、image###生图提示词###。四部分缺一不可、顺序不可颠倒。
3. position: 行从正文中原样摘录一段连续片段（15~50 字），禁止改写、缩写、翻译；插图插入该片段所在段落之后。多张图的 position 不得指向同一段落，分散在正文前中后不同位置。
4. desc: 行写一句中文画面描述（15~40 字）：谁、在哪、正在做什么——写给读者看的图片说明，将随图片一起保存展示；用平实叙述，不写英文 Tag、不写构图术语。
5. image### 与 ### 之间填写给绘画 AI 的英文提示词，必须严格按下列标签行结构书写（顺序固定、每行以 ; 结尾、标签名称逐字照写、N 从 1 起按角色顺序递增）：
Scene Composition: <人数性别与组合>, <一句场景与构图>;
Character 1 Prompt: <角色1完整描述>, |centers:<字母><数字>;
Character 1 UC: <角色1负面词>;
Character 2 Prompt: <角色2完整描述>, |centers:<字母><数字>;
Character 2 UC: <角色2负面词>;
多角色依此类推（Character 3/4…），单人只写 Character 1 两行。各字段内容写法见下方要求提示词。
6. |centers:<字母><数字> 是角色画面定位坐标，每个 Character N Prompt 行末尾必带：字母 a–e 表示横向位置（a=最左、c=居中、e=最右），数字 1–5 表示纵向位置（1=最上、3=居中、5=最下）。多角色必须给出不同坐标以分开定位；不得省略。
7. 提示词完整写在 image### 与 ### 之间，这是它唯一的位置。`;

/** 默认文生图要求提示词（用户自定义留空时的兜底，永不丢失）。 */
export const DEFAULT_STORY_IMAGE_REQUIREMENT = `你是一名专业插画导演兼摄影指导。阅读下方正文与角色资料块，在人物登场、动作交锋、情感转折、精彩或激情场景处挑选**最具画面感的瞬间**，为每张画面撰写结构化英文生图提示词。（张数与上限以指令中给明的数字为准，不超过上限）

选图优先级：①正文直接描写的影像（照片/镜中/屏幕上的画面）②动作与情感最浓烈的瞬间 ③人物登场、换装、互动的代表画面。多张图分散在正文前、中、后，禁止堆在同一段。

## 一、主角出镜限制（最高优先级，覆盖其余规则的出镜要求）
主角＝你扮演的用户角色（角色资料块中的「主角」；正文以第一人称叙述时「我」即主角）。主角出镜严格按以下递降优先级执行，能满足上一级就不用下一级：
1. **主角不入镜**：默认主角完全不出现在画面中——优先其余角色单人/双人构图与环境空镜，此为最优方案；正文未直接描写主角的画面一律不带入主角。
2. **仅局部肢体**：仅当本图必须表现主角与他人的接触/互动（拥抱、牵手等无法回避）时，采用主角第一视角，只保留手/手臂等最小限度局部肢体入画（pov、hand、arm、head out of frame），躯干与面部不出现。
3. **无脸入镜**：仅当前两级都无法满足（必须展现主角躯干参与的画面）时才允许主角入画，且必须 faceless 或 from behind，绝不刻画主角的眼睛与五官。此为最后手段。
主角入画时露出的肢体（肤色/体型/毛发）与主角设定一致，不添加设定外的显著特征。主角不入镜时，控制词与角色块只写其余在场角色（solo/duo 等组合标签本身即排除主角，UC 不需要额外排斥主角）。其余角色（AI 角色/NPC）不受本条约束，按正文正常描绘。<UBS_think> 的人物清点须写明主角采用的出镜等级（不入镜/局部肢体/无脸）。

## 二、导演构思流程（<UBS_think> 内用中文逐项执行）
每张图在 <UBS_think> 内按 S1~S9 逐项思考，每项一行、写明「来源→判断→结果」，禁止跳步、禁止写"同上/略"：

S1 原文定格：本图对应的正文关键句「…」→ 画什么：谁、在哪、正在做什么；定格瞬间：动作进行到哪一帧、双方相对位置、此刻累积状态（衣物凌乱度/汗水/伤痕/手中持物）。图2起标前图承接（前图定格姿态→本图自然发展→不变项→累积递增）。
S2 分级：三问判定——有裸体（主要部位无衣物遮挡，内衣泳装不算）？有性器官露出（乳头/阴部/阴茎/肛门，仅乳沟臀缝不算）？有性行为（性交/口交/手淫/插入）？→ Safe（全否）/ R（有裸无器官）/ X（有器官或性行为）→ 分级开关：Safe 与 R 写 sfw，X 写 nsfw → 器官描述：仅 X 级按画面写（nipples/pussy/penis 等），Safe/R 不写任何器官词。每张独立判定，不沿用上一张。
S3 人物清点：画面实际人数 N=几？逐个列出（性别+身份+此刻着装与情绪）。正文在场且有戏份的角色必须入画（主角除外——主角按「一、主角出镜限制」判定入镜等级并写明）；正文没写的角色禁止凭空添加；纯背景路人一笔带过为 background figures；正文未给出外貌的临时配角用精简模板（1boy, faceless male, 体型, 核心动作）。N=1 必含 solo；N=2 必含 duo（或 hetero/yuri/yaoi）禁 solo；N≥3 用对应多人组合标签。
S4 主体与构图：先定主体类型（A角色美貌 / B动作 / C情感 / D魔法特效 / E服装 / F多人互动 / G视角冲击 / H身体局部 / I纯环境空镜，必须≠前图）→ 主体强调用具体措辞（A类 beautiful/stunning presence，C类 overwhelming ecstasy/desperate sorrow 等），UC 排斥其反义（plain/calm/emotionless）。再答构图三问：①摄像机在哪里（胸口高度/头顶俯拍/桌下/门缝/身后，禁止不假思索默认正面平视）②这是谁的眼睛（旁观者/对方/她本人）③什么角度能把主体核心放大（力量→仰拍/脆弱→俯拍/亲密→贴近/孤独→远景）→ 选定景别+视角+焦点词。禁止 front view + upper body + mid shot 三件套（=平庸证件照）。构图自洽：该角度看不见的部位（from behind 的表情、特写时的全身）不写、移入 UC；正文聚焦某身体局部→局部特写+对应 focus 词（breast focus/hand focus/leg focus…）；纯环境转场→无人物空镜（no humans，仅 Scene 行，无 Character 块）。连续两图主体类型、视角词、焦点词均不得相同。
S5 外貌核对→角色DNA句（逐角色逐项）：从角色资料块与前图 DNA 句抄录——🔴锁定层（发色/发型签名含长度与刘海/瞳色/脸型/胸部/肤色/非人核心特征如兽耳尾巴角翅膀）必写；🟡标志层（眼型/体型/身体标记如疤痕痣/标志性配饰）有则写；🟢细节层（眉/睫/鼻/唇/肤质/年龄外观/普通配饰）画面相关则写。铁律：人数增加不降低单角色 DNA 完整度（N≥2 仍逐角色完整，不因人多而精简）。胸部等级（flat chest/small breasts/medium breasts/large breasts/huge breasts）跨图锁定不变、UC 排斥其他等级。同人/原创判定：Q1 角色名深度搜索（精确名/翻译名/部分名/昵称，任一命中 IP→同人，用 Danbooru 下划线标签如 hatsune_miku、rem_(re:zero)，标签后不重复模型已知外貌、只写与默认形象的差异项）；Q1 全未命中→原创，不加名条直接以 DNA 句开头（宁可多写完整描述也不编造标签）。正文明确变化（淋湿/受伤/换装/变身）→ DNA 句后追加变化项，不改动🔴锁定层基础。→ 产出「角色DNA句」，跨图逐字重复同一句，禁止缩写/换词/漏项。多人场景脸型/眼型尽量互异（双人脸型必须不同）。
S6 服装核对（逐件）：此刻每件可见服装=颜色+款式+长度（裙/靴/袜/外套必带 mini/knee-length/thigh-high 等）+图案面料（有则写）+穿着状态（wet clothes/torn/disheveled/slipping off，正常不写）。衣物来源：正文优先，正文未细写时参照角色资料块的衣着（NPC=当前穿搭+上装/下装/内衣/袜子/鞋子/饰品分项，主角=衣柜穿搭基线）；正文明确描写换装/脱衣/整理衣衫时以正文为准。全裸→写 nude 不提取服装。禁裸词 dress/shirt/clothes/outfit——每件必带颜色与款式。内衣按可见性：外衣完整不透明→禁写内衣、UC 加 visible underwear；仅穿内衣无外衣→必写。跨图颜色一致：上一张 red dress 本张仍 red dress，直到正文明确换装。
S7 动作+表情+空间：每角色——姿势/身体朝向/双手各做一件事（一只手只能做一件事）。双人以上——接触点精确到部位（his right hand on her waist），主动方 source#动作、被动方 target#动作成对出现，每人空间位置（left/center/right + foreground/midground/background），互动双方面向彼此。动作相位：本图相位≥前图（蓄力→执行→命中→后果→余韵，同一动作序列内只进不退，新序列可重置）。身体接触物理自洽——先在脑中摆人偶：双方能否同时处于此姿势、这个角度手够得到。表情：视线方向+眼部（half-lidded/wide eyes/glazed）+嘴部（biting lip/parted lips/smirk）+生理（blush/sweat/trembling/tears）至少各一项，禁抽象词 happy/sad。两人共用道具状态必须一致（不能一方手持、另一方写道具落地）。
S8 负面清单（UC=负面提示词，告诉生图模型本图禁止出现什么，每张独立推导、不沿用上一张）：①防崩坏 bad face, poorly drawn face, distorted face, asymmetrical face（每角色必含）②防路人 background characters，多人加 fused bodies ③角色互斥：排斥他人发色/瞳色/服装主色（对方不入镜跳过互斥、同色系不互斥发色各自正面写清、禁止排斥性别词 male/female/1boy/1girl 会让角色消失）④构图不可见部位移入 UC ⑤分级：Safe/R 排斥 nsfw/nude/器官词，X 排斥 censored/mosaic/clothes ⑥胸部互斥其他等级。UC 只排除、不替代正向描述。
S9 最终检查：Scene（地点/时间/光源/氛围/构图）齐✓ Char（DNA句+服装+动作+表情）齐✓ UC（脸部防崩4词+分级+互斥）齐✓ 主体类型≠前图✓ 分级开关正确✓ 连续性（动作相位未回退/状态只增不减/空间位置有据/共用道具一致）✓——任一不符回到对应 S 步修正后再输出。

多张图节奏：至少一张呈现核心角色清晰面容与表情（核心角色＝画面主体角色，通常为 AI 角色；神情是叙事核心，全背影/特写肢体等于丢掉神情。主角面容不在此列，见「一、主角出镜限制」）；无脸、背影与纯空镜合计不超过一半。

## 三、生图提示词写法（image### 内，英文）
image### 内的标签行结构、|centers 坐标、行序与行末分号见上方「输出结构契约」（不可更改）。下列细则只规定各字段**内容怎么写好**：

写法细则：
1. 控制词永远最前：人数性别、分级开关（sfw/nsfw）；其余按「越重要越靠前」——主体强调紧跟其后、核心动作紧跟 DNA 句。
2. 角色DNA句（S5 产出）：一句连贯英文覆盖体型年龄+发型发色刘海+瞳色眼型+脸型+胸部+肤色+种族特征+标志性配饰。范例：a petite young woman with long waist-length black hair and blunt bangs, sharp almond-shaped amber eyes, a delicate oval face, small breasts, fair skin, and a black ribbon choker。跨图逐字重复，禁止缩写/换词/漏项——这是人物一致性的锚。
3. 分级与器官（S2）：Safe/R→sfw，服装完整描述、不写任何器官词；X→nsfw，全裸写 nude/completely naked 不提取服装，按画面写器官（nipples/pussy/penis 等）与性行为词（penetration/missionary 等）。
4. 同人/原创（S5）：同人用 Danbooru 下划线标签（hatsune_miku、rem_(re:zero)），标签后不重复模型已知外貌、只写差异项；不确定标签是否存在→按原创处理（宁可多写完整 DNA 也不编造标签）。原创不加名条，直接以 DNA 句开头。
5. 服装（S6）：每件独立短语、由内到外逐件列出：white pleated mini skirt, navy sailor uniform with white collar；衣物状态词跟随其后（wet clothes, slipping off one shoulder）。每件必带颜色与款式，禁裸词。
6. 动作（S7）：动词短语具体到部位与接触点（one hand gripping her wrist / fingers tangled in his hair），source#/target# 成对出现在互动双方；朝向写明（facing each other / looking back over shoulder）；禁止笼统的 interacting with each other。
7. 表情（S7）：视线+眼+嘴+生理至少各一项，紧跟动作之后。
8. 场景句（S4）：同一场景未切换时各图地点陈设保持一致，仅视角光影可变；正文切换场景后随正文更新。
9. UC（S8）：只排除不替代正向描述。
10. 禁止权重符号（{}、[]、::）——强调靠位置与措辞具体度表达。
11. 连续性：本图是上一张的下一帧——衣物凌乱/汗水/体液/伤痕只增不减（正文明确重置除外：整理衣衫/擦干/换装/休息后）；道具不凭空消失（前图手持的书，正文没写放下就还在手里）；动作相位只进不退。
12. 多人（N≥3）构图改 wide shot/中远景，每个实际角色仍独立成块完整 DNA 描述，只有真正群演归入 background figures。

## 四、完整示例
### 示例1：SFW 单人背影（N=1）
<UBS_image>
<UBS_think>
S1 原文定格:「她背对着他站在窗边，指尖抵着冰凉的玻璃」→ 画什么：深夜卧室，少女独自立在窗前的背影；定格瞬间：指尖刚触上玻璃、肩带滑落一侧、肩膀微缩。
S2 分级:无裸体/无器官/无性行为→Safe→sfw→不写器官。
S3 人物清点:N=1，少女（睡裙、强自镇定的低落）；对话中的主角无画面动作，按主角出镜限制①不入镜→solo。
S4 主体与构图:主体=C情感（压抑孤独）；强调 quiet suppressed sadness，UC 排斥 calm/emotionless。构图三问：①摄像机室内床沿高度距三步 ②留在房门处男性的视线 ③背影+环抱放大孤独→full body, from behind，窗外冷色轮廓光。禁三件套否（from behind）。不可见：正面表情移 UC。
S5 外貌核对:设定=及腰黑长直+齐刘海/琥珀色杏眼/鹅蛋脸/纤瘦小胸/白皙/黑色缎带颈环→🔴锁定层齐→DNA 句与前图逐字一致。原创（无 IP 匹配）不加名条。
S6 服装核对:淡蓝色过膝棉睡裙=pale blue knee-length cotton nightgown，肩带滑落一侧=strap slipping off one shoulder；赤足。
S7 动作+表情+空间:站姿背对镜头居中；右手指尖抵窗玻璃，左臂环抱自己手肘；朝向 from behind。表情：侧头微垂望窗外雨幕，half-lidded，唇线抿直，quiet suppressed sadness。无强生理反应。
S8 负面:bad face, poorly drawn face, distorted face, asymmetrical face；background characters；eyes visible from behind, facial expression（背影不可见）；extra fingers；nsfw, nude（Safe 级排斥）。
S9 最终检查:Scene 齐✓ Char 齐✓ UC 齐✓ 主体=C≠前图✓ sfw✓ 连续性起始帧✓
</UBS_think>
position: 她背对着他站在窗边，指尖抵着冰凉的玻璃，久久没有回头。
desc: 深夜卧室，黑长直少女背对镜头立于窗前，指尖轻触雨幕玻璃，睡裙肩带滑落一侧。

image###
Scene Composition: 1girl, solo, sfw, a quiet bedroom at midnight, rain streaming down the tall window with faint city lights beyond the glass, cold rim light tracing her silhouette, melancholic and still atmosphere, full body, medium long shot, from behind;
Character 1 Prompt: 1girl, a petite young woman with long waist-length straight black hair and blunt bangs, sharp almond-shaped amber eyes, a delicate oval face, small breasts, fair skin, and a black ribbon choker, pale blue knee-length cotton nightgown with the strap slipping off one shoulder, barefoot, standing with her back to the viewer at the window, right fingertip pressed against the cold glass, left arm wrapped around her own elbow, head slightly bowed toward the rainy night, half-lidded eyes, lips pressed thin, quiet suppressed sadness|centers:C3;
Character 1 UC: bad face, poorly drawn face, distorted face, asymmetrical face, background characters, eyes visible from behind, facial expression, extra fingers, nsfw, nude;###
</UBS_image>

### 示例2：SFW 双人互动（N=2，展示 source-target / UC 互斥）
<UBS_image>
<UBS_think>
S1 原文定格:「她凑过去伸出食指戳了戳他的脸颊，笑得眉眼弯弯」→ 画什么：图书馆窗边，粉发少女靠在黑发青年肩上伸手戳他脸；定格瞬间：指尖刚触上脸颊、青年微侧头、少女憋笑。
S2 分级:无裸无器官无行为→Safe→sfw。
S3 人物清点:N=2→duo, 1girl and 1boy。少女 A（粉长发、便装、调皮）、青年 B（黑短发、衬衫、无奈），两人均为剧情角色（非主角），按正文正常入画。
S4 主体与构图:主体=F多人互动；强调 playful intimate interaction。构图三问：①摄像机长椅侧面距两步、齐胸高 ②旁观者视角 ③贴近放大互动亲昵→medium shot, from side。禁三件套否（from side）。两人面向彼此。
S5 外貌核对:A=及腰粉直发+空气刘海/绿瞳/圆脸/小胸/白皙→DNA 句；B=黑色短碎发/灰瞳/方下颌/中等体型/小麦色→DNA 句。两人原创无 IP。脸型互异（圆脸 vs 方下颌）。
S6 服装核对:A=白色棉质吊带裙 white cotton spaghetti-strap dress, knee-length；B=浅灰亚麻衬衫 light grey linen shirt, sleeves rolled up，黑色长裤 black trousers。
S7 动作+表情+空间:A 靠在 B 右肩、右手食指戳 B 左颊（source#poking cheek）、facing right、左位前景；B 坐姿微侧头、左手持书、target#being poked on cheek、facing left、右位。接触点=食指触左颊。表情：A 眉眼弯弯 grinning eyes、slight blush；B 微蹙 slightly furrowed brows、wry smile。
S8 负面:A UC 排斥 B 发色瞳色脸型+防崩+防融合；B UC 排斥 A 发色瞳色脸型+防崩+防融合。互斥只排外貌特征，禁排性别词。
S9 最终检查:Scene 齐✓ Char1/Char2 齐✓ UC 互斥齐✓ 主体=F≠前图✓ sfw✓ 连续性✓
</UBS_think>
position: 她凑过去伸出食指戳了戳他的脸颊，笑得眉眼弯弯。
desc: 午后图书馆窗边，粉发少女倚在黑发青年肩头，伸手轻戳他的脸颊，笑得眉眼弯弯。

image###
Scene Composition: 1girl and 1boy, duo, sfw, a library reading nook by a tall window, afternoon sunlight casting warm rectangles on wooden floor, two cushioned chairs side by side, peaceful and playful atmosphere, medium shot, from side;
Character 1 Prompt: 1girl, a young woman with long waist-length pink hair and airy bangs, round green eyes, a round face, small breasts, fair skin, white cotton spaghetti-strap dress knee-length, leaning on his right shoulder, right index finger poking his left cheek, grinning eyes, slight blush, facing right, source#poking cheek|centers:C2;
Character 1 UC: bad face, poorly drawn face, distorted face, asymmetrical face, background characters, fused bodies, black hair, grey eyes, square jaw;
Character 2 Prompt: 1boy, a young man with short messy black hair, grey eyes, a square jaw, medium build, light tan skin, light grey linen shirt with sleeves rolled up, black trousers, sitting with head slightly turned, left hand holding an open book, slightly furrowed brows, wry smile, facing left, target#being poked on cheek|centers:D2;
Character 2 UC: bad face, poorly drawn face, distorted face, asymmetrical face, background characters, fused bodies, pink hair, green eyes, round face;###
</UBS_image>`;

/** 单个角色的外貌/体型资料（引擎从数据库表收集；appearance/body 已按 charTags 开关解析完毕）。 */
export interface StoryImageCharacterProfile {
  name: string;
  gender: string;
  age: string;
  /** charTags.appearance 或数据库「外貌特征」中文散文；同人角色恒空（整段省略，外貌交给角色标签）。 */
  appearance: string;
  /** charTags.body 或 NSFW信息表 身高体重/三围罩杯拼接；主角无身体数据列，恒空。同人角色恒空。 */
  body: string;
  /** 同人角色标记（立绘索引 fanwork 开关 + 身份 tag 就绪）：资料块不注入外貌/身材，身份由 fanTags 给出。 */
  fanwork?: boolean;
  /** 同人身份标签（固化）：原作人物标签 + 作品标签，生图提示词必须以它们开头（原样照抄，不得改写）。 */
  fanTags?: FanIdentityTags;
  /** 衣着块（引擎预格式化整段）：NPC=在场角色表七项（当前穿搭+上装/下装/内衣/袜子/鞋子/饰品）；
   *  主角=衣柜穿搭基线【当前穿搭（衣柜）】。无衣着数据时为空（整段省略）。 */
  outfit?: string;
}

/** 立绘同源格式的单角色资料块（【角色姓名】/【性别】/【年龄】/【外貌特征】/【身体数据】/衣着块）。
 *  同人角色（fanwork）：省略【外貌特征】【身体数据】整段（不写「未描述」），块首打【同人】标记
 *  并给出固化身份标签【同人身份标签】，与写死同人规则段呼应。 */
function formatProfileBlock(p: StoryImageCharacterProfile): string {
  const parts: string[] = [];
  if (p.fanwork) parts.push('【同人】');
  parts.push(
    `【角色姓名】\n${p.name}`,
    `【性别】\n${p.gender || '未知'}`,
    `【年龄】\n${p.age || '未知'}`,
  );
  // 固化身份标签：原样给出，提示词只需照抄开头（不再让 AI 自行推断原作）
  if (p.fanwork && p.fanTags) parts.push(`【同人身份标签】\n${p.fanTags.character}, ${p.fanTags.copyright}`);
  if (!p.fanwork) parts.push(`【外貌特征】\n${p.appearance || '未描述'}`);
  if (!p.fanwork && p.body) parts.push(`【身体数据】\n${p.body}`);
  // 衣着块由引擎预格式化（NPC=在场角色表七项：当前穿搭+上装/下装/内衣/袜子/鞋子/饰品；
  // 主角=衣柜穿搭基线【当前穿搭（衣柜）】），整段原样注入（同人角色同样保留衣着）。
  if (p.outfit) parts.push(p.outfit);
  return parts.join('\n');
}

/** 同人生成规则（写死通用规则段，仅在资料块含【同人】角色时拼接在输出结构契约之后；
 *  不进要求提示词——requirementPrompt 可被用户自定义整体覆盖，同人规则不能依赖它；
 *  措辞完全自足，不引用要求提示词中的 S5/UC 等编号概念）。身份标签由资料块固化给出，AI 只照抄。 */
export const STORY_IMAGE_FANWORK_RULE = `## 同人生成规则（仅适用于角色资料中标注【同人】的角色）
标注【同人】的角色，其 Character Prompt 必须以该角色资料块【同人身份标签】给出的标签开头（人物标签在前、作品标签在后，逐字照抄，不得改写、翻译、简写或替换成其他作品）；该角色的固有外貌（发型/发色/瞳色/脸型/体型/肤色/种族）完全由这些标签自带，禁止书写其外貌/身材描述；只写与默认形象的差异项、此刻服装、动作与表情。`;

/**
 * 角色资料块：主角在前、匹配角色在后；无任何块返回空串（指令中整节约省略）。
 * 块首守卫声明防 AI 把资料块角色误认为「必须入画」——出镜只认正文；穿着以资料块为基础，
 * 正文明确描写换装/脱衣等即时变化时以正文为准（资料块可能是上一时刻状态）。
 * 同人角色仅提供衣着与身份，外貌由其固化身份标签识别（见同人生成规则段）。
 */
export function buildStoryImageCharacterSection(
  protagonist: StoryImageCharacterProfile | null,
  characters: StoryImageCharacterProfile[],
): string {
  const blocks: string[] = [];
  if (protagonist) blocks.push(`主角（你扮演的用户角色，正文第一人称的「我」）：\n${formatProfileBlock(protagonist)}`);
  for (const c of characters) blocks.push(formatProfileBlock(c));
  if (!blocks.length) return '';
  return [
    '## 角色资料（仅供外貌/体型/穿着核对；是否出镜以下方正文为准；正文明确描写换装/脱衣时衣物以正文为准；标注【同人】的角色仅提供衣着与身份，外貌由其角色标签识别）',
    blocks.join('\n\n'),
  ].join('\n\n');
}

export interface BuildStoryImageInstructionArgs {
  /** 最后一条 AI 回复正文（已剥 HTML/首尾空白）。 */
  storyText: string;
  /** 用户自定义要求提示词；空串用 DEFAULT_STORY_IMAGE_REQUIREMENT。 */
  requirementPrompt: string;
  /** 自定义输出结构契约（「生图 AI 请求提示词」板块 image:storyImage:structure）；空串用内置 STORY_IMAGE_FORMAT_CONTRACT。 */
  structurePrompt?: string;
  /** 本轮最多插图张数（1-10）。 */
  maxImages: number;
  /** 角色资料块（buildStoryImageCharacterSection 产出）；空串/缺省=不注入该节。 */
  characterSection?: string;
  /** 本轮资料块含【同人】角色（引擎按 profiles 计算）；true 时在结构契约之后注入写死同人规则段。 */
  hasFanworkCharacter?: boolean;
}

/** 组装 user_input：任务说明 + 结构要求（内置/自定义）+（含同人角色时）写死同人规则段 + 要求提示词（默认/自定义）+ 角色资料块 + 张数上限 + 正文全文。 */
export function buildStoryImageInstruction(args: BuildStoryImageInstructionArgs): string {
  const requirement = args.requirementPrompt && args.requirementPrompt.trim()
    ? args.requirementPrompt.trim()
    : DEFAULT_STORY_IMAGE_REQUIREMENT;
  const structure = args.structurePrompt && args.structurePrompt.trim()
    ? args.structurePrompt.trim()
    : STORY_IMAGE_FORMAT_CONTRACT;
  const cap = Math.max(1, Math.min(10, Math.floor(args.maxImages) || 2));
  const sections = [
    '## 任务：阅读下方正文，挑选画面并生成插图提示词（角色外貌以角色资料块与正文为准）',
    structure,
  ];
  // 同人规则段写死在代码里、紧跟结构契约（用户自定义要求提示词无法覆盖/丢弃它）
  if (args.hasFanworkCharacter) sections.push(STORY_IMAGE_FANWORK_RULE);
  sections.push(`## 要求提示词（生图提示词写法规则，必须逐条遵循）\n${requirement}`);
  if (args.characterSection && args.characterSection.trim()) sections.push(args.characterSection.trim());
  sections.push(
    `## 张数上限\n本轮最多输出 ${cap} 个 <UBS_image> 块（在要求提示词张数与该上限之间取较小值）。`,
    `## 正文（插图的唯一素材来源，position 必须从中原样摘录）\n${args.storyText}`,
  );
  return sections.join('\n\n');
}

// 结构头（破限）由 core/jailbreak-config.getJailbreakHeadPrompts() 在请求装配处统一提供：
// 原「取破限字符串」的透传壳函数已删——它无法承载多段式自定义，留着只会绕开用户设置。