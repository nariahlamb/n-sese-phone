// ===== 游戏中心 NPC 补位（docs/16 §10） =====
// 好友不足/勾选人数达不到最低人数时，本地随机补「临时牌友」凑桌，保证对局能开起来。
// 用户定案（2026-10-01）：① 玩家侧不做任何 NPC 标记（与普通参与者一视同仁）；
// ② 自动补位，无开关；③ 海龟汤主持人必须真实好友（NPC 只补参与者位）；
// ④ 姓名/性格/口癖跟随当前剧本风格，轻量词库。
// 纪律：纯函数、零运行时依赖（可被 .cjs 测试直接 require）；不产生任何 AI 请求与持久化字段——
// 人设由「名字本身」确定性推导（名字在哪个风格词库的第几位 → 取第几组性格/口癖），
// 断点续玩/刷新后完全一致，故三套 Active* 结构与存档格式零改动。
// NPC 的唯一事实源 = 名字；「是不是 NPC」在引擎侧按通讯录判定（见 game-engine.isKnownParticipant）。

/** 风格键（对齐 chat-model.PhoneStyle：''=现代）。 */
export type NpcStyleKey = '' | 'xianxia' | 'wuxia' | 'fantasy';

export interface NpcPersona {
  name: string;
  /** 身份背景。 */
  identity: string;
  /** 性格特质。 */
  personality: string;
  /** 说话习惯与口癖。 */
  languageStyle: string;
  /** 对主角态度。 */
  attitude: string;
  /** 人物简介。 */
  brief: string;
}

interface NpcBank {
  /** 简单姓名池（12 个；风格语境）。 */
  names: readonly string[];
  /** 性格侧面（6 条）。 */
  traits: readonly string[];
  /** 口癖（7 条；与 traits 互质 → 前 12 个名字的性格/口癖组合互不重复）。 */
  quirks: readonly string[];
  /** 身份背景（陌生人口径）。 */
  identity: string;
  /** 对主角态度（陌生人口径）。 */
  attitude: string;
}

const NPC_BANKS: Record<NpcStyleKey, NpcBank> = {
  '': {
    names: ['阿凯', '小满', '大壮', '阿珍', '老王', '小赵', '阿豪', '小丁', '大鹏', '阿香', '小虎', '阿梅'],
    traits: ['话痨热心肠', '慢性子的老好人', '轴、认死理', '社恐闷葫芦', '爱抬杠的杠精', '大大咧咧的乐天派'],
    quirks: ['讲道理', '那个啥', '就这？', '嗯……让我想想', '好家伙', '不是我说', '嗨呀'],
    identity: '临时拼桌的陌生人',
    attitude: '初次见面，谈不上交情',
  },
  xianxia: {
    names: ['云舟', '秦川', '阿离', '洛九', '青禾', '白露', '子墨', '玄一', '苏木', '江沅', '沈砚', '温言'],
    traits: ['侠气直性子', '清冷寡言', '心细如发', '好酒贪杯', '面冷心热', '一根筋的剑痴'],
    quirks: ['贫道', '兄台', '罢了罢了', '此话说来', '哦？有点意思', '且看', '不才'],
    identity: '萍水相逢的陌生人',
    attitude: '素不相识，井水不犯河水',
  },
  wuxia: {
    names: ['赵铁', '柳七', '阿九', '石敢当', '白鹭', '秦五', '周三', '铁牛', '阿绣', '关山', '何四', '燕小六'],
    traits: ['仗义豪爽', '沉得住气', '疑心重', '嘴上不饶人', '义字当头', '憨直猛汉'],
    quirks: ['好说好说', '兄弟', '江湖规矩', '得罪了', '嘿，有意思', '少废话', '这厢有礼'],
    identity: '江湖上偶遇的陌生人',
    attitude: '素昧平生，先看人品',
  },
  fantasy: {
    names: ['亚瑟', '莉娜', '卡尔', '艾拉', '罗兰', '米娅', '德鲁', '薇薇', '奥恩', '瑟琳', '加文', '伊莎'],
    traits: ['好奇心旺盛', '沉默的守望者', '骄傲自负', '谨小慎微', '狂热求知', '天生乐天派'],
    quirks: ['以圣光之名', '有趣的凡人', '诸神在上', '哼', '吾辈', '值得记录', '见鬼'],
    identity: '旅途上结识的陌生人',
    attitude: '素未谋面的同路人',
  },
};

/** 风格归一（未知/空 → 现代）。 */
export function normalizeNpcStyle(raw: unknown): NpcStyleKey {
  return raw === 'xianxia' || raw === 'wuxia' || raw === 'fantasy' ? raw : '';
}

/** 名字 → 词库命中（去尾数字以容纳极端兜底名「阿凯2」）。 */
function bankOf(name: unknown): { bank: NpcBank; index: number } | null {
  const base = String(name ?? '').trim().replace(/\d+$/, '');
  if (!base) return null;
  for (const key of Object.keys(NPC_BANKS) as NpcStyleKey[]) {
    const bank = NPC_BANKS[key];
    const index = bank.names.indexOf(base);
    if (index >= 0) return { bank, index };
  }
  return null;
}

/** 该名字是否出自 NPC 词库（UI/引擎判定补位名用；通讯录判定见 engine.isKnownParticipant）。 */
export function isNpcName(name: unknown): boolean {
  return bankOf(name) !== null;
}

/** 名字 → 确定性人设（不在词库 → null；同名恒等，无需存档）。 */
export function npcPersona(name: string): NpcPersona | null {
  const hit = bankOf(name);
  if (!hit) return null;
  const { bank, index } = hit;
  const trait = bank.traits[index % bank.traits.length];
  const quirk = bank.quirks[index % bank.quirks.length];
  return {
    name,
    identity: bank.identity,
    personality: trait,
    languageStyle: `常把「${quirk}」挂在嘴边`,
    attitude: bank.attitude,
    brief: `${trait}的陌生人`,
  };
}

function shuffle<T>(list: readonly T[], rand: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 抽取 count 个补位名（避开 exclude：通讯录/自定义联系人/主角/已邀请好友）。
 * 词库被占满时退化为「名字+数字」兜底名——人设解析会剥掉尾部数字，仍能取到同一套性格/口癖。
 */
export function rollNpcNames(
  count: number,
  style: unknown,
  exclude: Iterable<string> = [],
  rand: () => number = Math.random,
): string[] {
  const need = Math.max(0, Math.floor(count) || 0);
  if (!need) return [];
  const bank = NPC_BANKS[normalizeNpcStyle(style)];
  const taken = new Set<string>();
  for (const raw of exclude) {
    const name = String(raw || '').trim();
    if (name) taken.add(name);
  }
  const out = shuffle(bank.names.filter(name => !taken.has(name)), rand).slice(0, need);
  let suffix = 2;
  while (out.length < need) {
    const base = bank.names[(out.length + taken.size) % bank.names.length];
    const candidate = `${base}${suffix++}`;
    if (!taken.has(candidate) && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}
