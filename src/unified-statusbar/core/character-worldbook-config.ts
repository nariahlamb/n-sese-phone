// ===== 角色世界书模板库：全局可持久化的创建/更新模板 =====

export interface CharacterWorldbookTemplate {
  id: string;
  name: string;
  body: string;
  builtIn: boolean;
}

export interface CharacterWorldbookTemplateLibrary {
  templates: CharacterWorldbookTemplate[];
  activeCreateTemplateId: string;
}

export interface RemoveCharacterWorldbookTemplateResult {
  ok: boolean;
  error?: string;
  library: CharacterWorldbookTemplateLibrary;
}

const DEFAULT_CREATE_TEMPLATE = `Basic_Info:
  Name: "[姓名]"
  Age: "[年龄周岁，如 20——角色表有生日列时按生日与当前日期推算；新人物自行设定]"
  Identity: "[学生/职员/人妻/偶像/无业/管理...结合标签设定]"
  Archetype: "[总体性格分析: 如 反差婊/伪圣女/隐藏M/高傲S等]"

Physiology:
  Race: "[人种/族裔]"
  Skin: "[肤色质感: 小麦色/苍白/粉嫩/黑亮/晒痕/油光]"
  Face_Hair: "[面部特征，须注明发色、肤色、瞳色与发型。如：墨黑及腰长发，额前碎刘海；肤色冷白，琥珀色瞳仁，杏眼柳眉，鼻梁秀挺，唇形偏薄]"

  Body_Features:
    Figure: |
      # 整体身材描写：着重点明身形、身材比例、胸部、臀部，以及独特有辨识度的身体特征
      [例如：身高165，身形纤细却肉感分明，肩窄腰细，胸围C，腰线明显收窄，
      胯部自然外扩，构成清晰的沙漏比例。乳房饱满圆润、乳尖色浅而敏感，臀部
      挺翘浑圆、触感弹软。双腿修长笔直，常年运动练出的马甲线若隐若现，与娇
      弱的脸形成反差；锁骨两侧各有一颗浅痣，背脊有一道细长胎记。胸部与臀部
      须按示例的细致程度逐层描写，不要只写轮廓。]

  Genitals:
    Type: "[如: 馒头型/一线型/蝴蝶型/白虎...]"
    Description: "[详细描述外观、生理特征、敏感程度等]"

Personality_Traits:
  # 性格是多维系统而非几个标签。以下七轴共同构成一个可演绎的立体人格：
  # 底色 → 外显 → 内隐 → 情绪 → 人际 → 矛盾 → 成因。逐轴填充，缺一不可。

  Core_Disposition:
    Temperament: |
      # 与生俱来的性情基调，是整张性格的底层操作系统。点明天生倾向而非后天习得。
      [例如：天生高敏感——对他人情绪和氛围的捕捉比常人快三拍，既善于共情也
      容易过载；骨子里是趋避型，对新刺激既好奇又本能想撤退，总在"想靠近"和
      "怕受伤"之间拉锯。]
    Core_Drive: |
      # 最深的内在动机，一切外显行为的根源。要写"非有不可什么"——她离了就活不下去的东西。
      [例如：被看见——渴望有人看穿她的伪装后仍不离开，区别于虚荣式的关注；
      这股驱动力让她在亲密关系中反复试探底线，又在被真正理解的瞬间卸下全部
      防御，露出从未示人的柔软。]

  Visible:
    Main: "[主特质：一句概括直观可见的核心性格面，并写出它如何外显于言行、表情、气场]"
    Manifestations:
      # 日常场景中可观察的具体行为，每条承载主特质的一个切面
      - "[外显1：如 习惯用玩笑岔开正经话题，笑声轻快但眼睛不跟着笑，让人分不清是亲和还是疏离]"
      - "[外显2：如 对任何人都能在三句内找到共同话题，但谈及自己时永远只给半真半假的故事]"
      - "[外显3：……]"
    Social_Mask: |
      # 在不同对象/场合前分别戴什么面具，面具与真实自我的落差
      [例如：对长辈是温顺乖巧的乖乖女，语气温软从不顶嘴；对同辈是大大咧咧的
      气氛组，荤段子张口就来；对异性是若即若离的暧昧高手——三副面孔之间没
      有一副是假的，但没有一副是完整的。]

  Hidden:
    Main: "[深层主特质：藏在表象下的真实性格或扭曲面，说明它平时被如何伪装、又在什么时机露出马脚]"
    Triggers:
      # 什么具体情境/言语/刺激会让隐藏面浮现
      - "[触发1：如 有人用温柔的语气说"你辛苦了"时会突然沉默——不是感动，是防御被击穿后的短暂宕机]"
      - "[触发2：……]"
    Secret_Desires: |
      # 不愿承认、甚至自己都未完全察觉的渴望或恐惧
      [例如：嘴上说要自由，实际极度害怕被抛弃——每次主动推开别人都是在
      测试"你会不会还是留下来"，而她自己从未意识到这个模式。]

  Emotional_Patterns:
    Baseline: "[情绪基调：日常情绪底色，如 表面平稳但底层始终有一根紧绷的弦 / 情绪起伏大但来得快去得也快]"
    Stress_Response: |
      # 压力/危机下的反应模式（fight/flight/freeze/fawn）及具体应激行为
      [例如：压力爆表时反向变温柔——声音更轻、笑容更软，却会
      开始无意识地做破坏性决定（主动切断关系、消失几天、酗酒），属于 fawn
      型的扭曲变体：用自我毁灭来恢复掌控感。]
    Emotional_Leakage: "[情绪失控的破防形态：平时自控力如何、破防时是什么样子、事后如何收拾——如 崩溃时反而安静，只会反复整理已经很整齐的东西]"

  Interpersonal_Dynamics:
    Attachment_Style: "[依恋模式：安全型/焦虑型/回避型/恐惧型——她如何靠近他人又如何推开]"
    Power_Orientation: "[权力取向：在关系里争夺什么、让渡什么——如 表面顺从实则暗中掌控节奏，用示弱换取主导权]"
    Intimacy_Logic: |
      # 她对亲密的理解（身体/情感/精神哪一层最重要），如何确认和测试对方
      [例如：认为精神层面的被理解才是真正的亲密，身体可以随便但想法被看穿
      会让她恐慌；测试方式是故意说反话，看对方能否听出弦外之音。]

  Contradictions:
    # 性格中自相矛盾之处，这种张力本身构成人物魅力——至少两条
    - "[矛盾1：如 理性到能在危机中冷静算计最优解，却对"有人记得她随口提过的小事"这件事毫无抵抗力]"
    - "[矛盾2：……]"

  Formation: |
    # 性格关键特质的成因回溯，聚焦心理动因（与 Backstory 互补，不复述事件本身）
    [例如：父亲的缺席让她从小习惯自己扛事，形成"不需要任何人"的自我认知；
    但母亲常对她说"你懂事我就不会累"，让她把"被需要"等同于"被爱"——这组
    矛盾至今未被她察觉，却驱动着她所有关系的走向。]

Fashion:
  Style_1: "[平时着装风格]"
  Style_2: "[私密或特定场合着装，结合内衣/情趣/标签]"

Sex_Parameters:
  Sensitive_Zones: |
    # 总写一段，不要逐条分列：列出敏感位置，并写出这些位置被触碰时的互动表现
    [例如：耳后与脖颈是她的死穴——被湿热气息呵过会立刻软了腰、声音发颤；
    腰侧一被环住就忍不住轻颤躲避；膝盖内侧被轻轻划过便弓起身子、脚趾蜷缩。]

  Fetishes:
    # 放开想象，不必结合标签。深入刻画人物独特的 NSFW 特质：XP、特殊喜好、
    # 性爱互动偏好等。不能笼统抽象，要有特点、能落地到具体互动细节；每条至少 50 字，至少 3 条。
    - "[XP/特殊喜好1：具体到场景、动作与感官细节的描写（不少于50字）]"
    - "[XP/特殊喜好2：……]"
    - "[XP/特殊喜好3：……]"

  Sexual_History: |
    # 性爱经历：是否处女、有无各种经验（爱抚/口交/道具/多人等）、曾有的亲密关系，
    # 以及她对性的态度与偏好如何一步步形成（可结合 Backstory 的逻辑自洽设定）
    [例如：具体到这个人自身的经历……]

  Taboos:
    # 不可触碰的底线与绝对禁忌（性格、性爱、情感层面皆可）
    - "[禁忌/底线1]"
    - "[禁忌/底线2]"

Backstory:
  # 必须是本人真实经历，而非笼统概括。需体现标签的形成过程。
  Phase_1: "[萌芽/初体验: 具体的早期事件]"
  Phase_2: "[发展/转变: 欲望或性格转变的关键转折点]"
  Phase_3: "[现状: 当前的状态与心理活动]"

Dialogue_Corpus:
  Public: "[公开场合常用语]"
  Private: "[私密状态下的说话方式/真实想法]"
  Inner: "[内心独白]`;

function asTemplate(value: unknown, seen: Set<string>): CharacterWorldbookTemplate | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  const body = String(raw.body || '').trim();
  // 丢弃历史的 kind:'update' 死代码条目（更新流程不消费用户模板）
  if (raw.kind === 'update') return null;
  if (!id || seen.has(id) || !name || !body) return null;
  seen.add(id);
  return { id, name, body, builtIn: false };
}

export function getDefaultCharacterWorldbookTemplates(): CharacterWorldbookTemplate[] {
  return [
    { id: 'cw-create-default', name: '默认角色档案模板', body: DEFAULT_CREATE_TEMPLATE, builtIn: true },
  ];
}

export function normalizeCharacterWorldbookTemplateLibrary(value: unknown): CharacterWorldbookTemplateLibrary {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const defaults = getDefaultCharacterWorldbookTemplates();
  const seen = new Set(defaults.map(item => item.id));
  const users = Array.isArray(raw.templates)
    ? raw.templates.map(item => asTemplate(item, seen)).filter((item): item is CharacterWorldbookTemplate => !!item)
    : [];
  const templates = [...defaults, ...users];
  const id = String(raw.activeCreateTemplateId || '').trim();
  const activeCreateTemplateId = templates.some(item => item.id === id) ? id : defaults[0].id;
  return { templates, activeCreateTemplateId };
}

export function resolveCharacterWorldbookTemplate(
  library: CharacterWorldbookTemplateLibrary,
): CharacterWorldbookTemplate {
  return library.templates.find(item => item.id === library.activeCreateTemplateId)
    || getDefaultCharacterWorldbookTemplates()[0];
}

export function nextCharacterWorldbookTemplateId(library: CharacterWorldbookTemplateLibrary): string {
  const ids = new Set(library.templates.map(item => item.id));
  let serial = library.templates.length + 1;
  while (ids.has(`cw-user-${serial}`)) serial += 1;
  return `cw-user-${serial}`;
}

export function removeCharacterWorldbookTemplate(
  library: CharacterWorldbookTemplateLibrary,
  id: string,
): RemoveCharacterWorldbookTemplateResult {
  const target = library.templates.find(item => item.id === id);
  if (!target) return { ok: false, error: '未找到模板', library };
  if (target.builtIn) return { ok: false, error: '内置模板不可删除', library };
  const next = normalizeCharacterWorldbookTemplateLibrary({
    templates: library.templates.filter(item => item.id !== id),
    activeCreateTemplateId: library.activeCreateTemplateId === id ? 'cw-create-default' : library.activeCreateTemplateId,
  });
  return { ok: true, library: next };
}
