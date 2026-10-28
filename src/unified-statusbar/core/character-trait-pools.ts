// ===== 角色世界书创建：性格池与 NSFW 特质池 =====
// 标签设计原则（2026-09-02 定稿）：
//   - 简要（多为 2-8 字）且相互独特，不考虑互斥性——矛盾标签（如 性欲旺盛+性冷淡倾向）
//     如何调和由创建提示词交给 AI 处理（不同场景显影 / 表里反差等）；
//   - 允许正面、中性与轻微负面（增强人物立体感）；
//   - 性格池混入生活特质（口味/作息/癖好/恐惧等），NSFW 池混入身体特质、玩法偏好与观念。
export const PERSONALITY_TRAIT_POOL: readonly string[] = [
  // 核心性情
  '阳光开朗', '阴郁低沉', '热情外放', '冷若冰霜', '温柔体贴', '傲娇', '天然呆', '腹黑',
  '毒舌', '八面玲珑', '内向社恐', '沉默寡言', '话痨', '不爱笑', '笑点极低', '冷幽默',
  '恶作剧体质', '老好人', '笑面虎', '嘴硬心软', '单纯天真', '世故圆滑', '愤世嫉俗', '心思缜密',
  '粗枝大叶', '谨慎多疑', '理性冷静', '感情用事', '冲动易怒',
  // 自我与人际
  '自恋', '自卑', '玻璃心', '钝感力强', '争强好胜', '完美主义', '拖延症晚期', '三分钟热度',
  '优柔寡断', '杀伐果断', '偏执', '耳根子软', '原则性强', '没有底线', '恩怨分明', '知恩图报',
  '唯利是图', '欺软怕硬', '势利眼', '控制欲强', '独占欲强',
  // 社会风格
  '自来熟', '慢热', '独来独往', '领导气质', '好为人师', '爱管闲事', '张扬高调', '幼稚任性',
  '早熟稳重', '母性泛滥', '粘人精', '恶趣味', '恋爱脑', '不解风情', '情场老手',
  // 生活特质
  '爱吃甜食', '嗜辣如命', '夜猫子', '洁癖', '不修边幅', '收集癖', '精打细算', '挥霍无度',
  '千杯不醉', '一杯就倒', '咖啡因依赖', '嗜睡', '失眠体质', '爱养宠物', '爱下厨', '厨艺黑洞',
  '挑食', '爱打扮', '素面朝天', '穿着复古', '爱唱歌', '音痴', '旱鸭子', '恐高',
  '怕黑', '爱撒娇', '不擅撒娇', '爱逞强', '敏感多思', '爱幻想', '占卜迷信', '日记狂魔',
  '旅行上瘾', '宅家不出门', '打破砂锅问到底',
];

export const NSFW_TRAIT_POOL: readonly string[] = [
  // 身体特质
  '敏感体质', '极易湿润', '难以高潮', '多重高潮体质', '容易潮吹', '泌乳体质', '乳头敏感', '耳朵敏感',
  '全身敏感带', '深喉快感体质', '后庭开发度高', '后庭冷淡', '紧致名器', '白虎无毛', '体香馥郁', '巨根',
  '性耐力超强', '不应期极短', '秒射体质', '发情期体质', '排卵期敏感', '性欲旺盛', '性冷淡倾向', '禁欲主义者',
  '看到就起反应', '声控敏感',
  // 玩法偏好
  '足交', '腿交', '乳交', '手交', '腋交', '吞精癖', '颜射爱好者', '中出偏好',
  '厌恶安全套', '乳头调教', '玩具爱好者', '远程操控玩具', '强制高潮癖', '寸止爱好者', '龟责爱好者', '喜欢留咬痕',
  '打屁股爱好者', '言语羞辱癖', '被夸奖会害羞', '外表清纯好色', '妩媚勾人', '主动骑乘派', '被动承受派', '野外交合癖',
  '录像癖', '露出癖', '出门不穿内裤', '轻度窒息play', '绳缚爱好者', '手铐束缚', '蒙眼play', '口球',
  'S倾向', 'M倾向', '女王气质', '服从型宠物', '角色扮演癖', '制服诱惑', '女仆play', '异装癖',
  '兽耳爱好者', '触手幻想',
  // 恋物取向
  '恋足癖', '恋手癖', '恋胸癖', '恋腿癖', '恋喉结', '恋体味', '恋丝袜', '肌肉控',
  '丰腴控', '骨感控', '大胸控', '贫乳控', '御姐控', '大叔控', '人妻情结', '处子情结',
  // 场景与观念
  '晨起性爱派', '车内性爱', '办公室幻想', '经期不忌讳', '想留到婚后', '文爱高手', '自慰成瘾', '自慰羞耻',
  '3P爱好者', '只能一对一', '伴侣交换癖', '主动NTR癖', '被NTR兴奋', '窥视癖', '无爱不做', '性爱分离主义',
];

export interface CharacterWorldbookTraitPoolState {
  /** 性格池抽取数量（1-10）。 */
  personalityCount: number;
  /** NSFW 特质池抽取数量（1-10）。 */
  nsfwCount: number;
  /** 已抽取并保留的性格标签；空数组 = 不启用性格池。 */
  personalityTags: string[];
  /** 已抽取并保留的 NSFW 特质标签；空数组 = 不启用 NSFW 池。 */
  nsfwTags: string[];
}

export const TRAIT_POOL_COUNT_MIN = 1;
export const TRAIT_POOL_COUNT_MAX = 10;

export const DEFAULT_TRAIT_POOL_STATE: CharacterWorldbookTraitPoolState = {
  personalityCount: 3,
  nsfwCount: 3,
  personalityTags: [],
  nsfwTags: [],
};

function normalizeCount(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(TRAIT_POOL_COUNT_MIN, Math.min(TRAIT_POOL_COUNT_MAX, n));
}

/** 只保留池内存在的标签（去重、保序）；池外标签（历史数据/池升级删除项）静默剔除。 */
function normalizeTags(value: unknown, pool: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set(pool);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const tag = String(raw || '').trim();
    if (!tag || !valid.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function normalizeTraitPoolState(value: unknown): CharacterWorldbookTraitPoolState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    personalityCount: normalizeCount(raw.personalityCount, DEFAULT_TRAIT_POOL_STATE.personalityCount),
    nsfwCount: normalizeCount(raw.nsfwCount, DEFAULT_TRAIT_POOL_STATE.nsfwCount),
    personalityTags: normalizeTags(raw.personalityTags, PERSONALITY_TRAIT_POOL),
    nsfwTags: normalizeTags(raw.nsfwTags, NSFW_TRAIT_POOL),
  };
}

/**
 * 从池中随机抽取 count 个不重复标签。传入 exclude 时尽量避开已选标签
 * （池剩余量不足时允许回落到全部池标签，保证总能抽出足量）。
 */
export function pickRandomTraitTags(
  pool: readonly string[],
  count: number,
  exclude: readonly string[] = [],
): string[] {
  const size = Math.max(0, Math.floor(Number(count) || 0));
  if (!pool.length || size <= 0) return [];
  const n = Math.min(size, pool.length);
  const avoid = new Set(exclude);
  const candidates = pool.filter(tag => !avoid.has(tag));
  const source = candidates.length >= n ? candidates : pool;
  // 部分 Fisher-Yates：只洗前 n 个位置，避免整池排序
  const indices = source.map((_, index) => index);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (indices.length - i));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, n).map(index => source[index]);
}
