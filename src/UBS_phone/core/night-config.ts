// ===== 不夜城 · 静态配置（板块表 / 尺度档 / 受控标签 / 四风格命名） =====
// 纯常量与纯函数，零依赖（可被 .cjs/.ts 测试直接 require）。
// 纪律：板块 brief / spiceMax / imageMode 只进提示词与生成策略，界面上只显示名字与板块色（D4 氛围化命名）；
// 尺度（N1）是**硬约束**：AI 产出超板块上限一律降录（见 night-model.clampNightSpice）。
// 尺度上限只有板块自己一个来源，没有全局上限、也没有禁看标签——那是用户可删的本机过滤，已整体移除。

import type { PhoneStyle } from './chat-model';

/** 四风格取词（本模块自带显式串——不 import skins，保持常量层零耦合与无环依赖）。 */
function pick(style: PhoneStyle, modern: string, xianxia: string, wuxia: string, fantasy: string): string {
  return style === 'xianxia' ? xianxia : style === 'wuxia' ? wuxia : style === 'fantasy' ? fantasy : modern;
}

// ─── 尺度档位（N1） ───

/** 尺度档：1 微涩 / 2 露骨（默认）/ 3 极限。 */
export type NightSpice = 1 | 2 | 3;

export const NIGHT_SPICES: readonly NightSpice[] = [1, 2, 3];

/** 尺度档显示名（四风格；现代=微涩/露骨/极限）。 */
export function nightSpiceLabel(spice: NightSpice, style: PhoneStyle = ''): string {
  const modern = spice === 1 ? '微涩' : spice === 2 ? '露骨' : '极限';
  const xianxia = spice === 1 ? '含蓄' : spice === 2 ? '旖旎' : '无度';
  const fantasy = spice === 1 ? '薄雾' : spice === 2 ? '炽焰' : '深渊';
  return pick(style, modern, xianxia, xianxia, fantasy);
}

/** 尺度档内容口径（进提示词，四风格同构；只有现代/风格措辞差异）。 */
export function nightSpiceBrief(spice: NightSpice): string {
  if (spice === 1) {
    return '微涩档：只写暧昧、暗示、气氛、擦边与心理张力；可以有身体接触与欲望，但不得出现明确的性行为过程与直白的性器官描写。';
  }
  if (spice === 2) {
    return '露骨档：写明确的前戏与性行为，用直白的身体与动作词汇（含性器官与体位），不回避、不打断、不用省略号代替过程、不写「之后的事不必细说」这类回避句。';
  }
  return '极限档：在上档基础上按板块 brief 拉满——极端玩法、多人、重度调教、禁忌越界都可写透；依旧不写排泄/猎奇伤害/未成年人相关内容。';
}

/** 尺度档 → 数值上限内的合法档（脏值回落 2=露骨）。 */
export function normalizeSpice(value: unknown, fallback: NightSpice = 2): NightSpice {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  return n === 1 || n === 2 || n === 3 ? (n as NightSpice) : fallback;
}

/**
 * 自动生成（刷新/定点/关键词）与各处默认档：**最高档＝极限**。
 * 不设「全局上限」——上限只剩板块自己的 spiceMax；这里的档位是「默认就往最高档写」的产物默认值，
 * 实际落在哪一档由 min(本档, 板块上限) 决定（夜谈室/同城夜话 上限=露骨，其余板块=极限）。
 */
export const NIGHT_DEFAULT_SPICE: NightSpice = 3;

/** 尺度降录（写侧唯一口径）：取 min(产出档, 板块上限)。板块上限见 NIGHT_BOARDS.spiceMax。 */
export function clampNightSpice(spice: unknown, boardMax: NightSpice): NightSpice {
  const want = normalizeSpice(spice);
  return Math.min(want, boardMax) as NightSpice;
}

// ─── 板块（六板块全部成人向，D7） ───

/** 板块图文比策略：must=每条必带图（暗房）/ mixed=按全局图文比 / none=纯文字。 */
export type NightImageMode = 'must' | 'mixed';

export interface NightBoardDef {
  id: string;
  /** 界面名（四风格）。 */
  name: Record<'modern' | 'xianxia' | 'wuxia' | 'fantasy', string>;
  /** 界面字形（单字符）。 */
  glyph: string;
  /** 板块色（界面 chip 与卡片角标）。 */
  tint: string;
  /** 内容 brief（**只进提示词**）。 */
  brief: string;
  imageMode: NightImageMode;
  spiceMax: NightSpice;
}

export const NIGHT_BOARDS: readonly NightBoardDef[] = [
  {
    id: 'darkroom',
    name: { modern: '暗房', xianxia: '秘影阁', wuxia: '暗香楼', fantasy: '幽室' },
    glyph: '◐',
    tint: '#B14BFF',
    brief: '自拍/私房/全裸图集区。发帖人本人或分享他人的成人向图片，每条必带 1-3 张；文字以发帖人视角写露骨挑逗与画面描述（谁、在哪、穿没穿、什么姿势、光从哪来）。',
    imageMode: 'must',
    spiceMax: 3,
  },
  {
    id: 'nighttalk',
    name: { modern: '夜谈室', xianxia: '论道夜话', wuxia: '夜话茶坊', fantasy: '夜谈厅' },
    glyph: '◍',
    tint: '#FF2E7E',
    brief: '成人向交流区：经验分享、教程、求助、约伴、悬赏、玩梗、测评（玩具/姿势/场所/安全）。语气热络随意，像一群熟客在深夜互相打趣。',
    imageMode: 'mixed',
    spiceMax: 2,
  },
  {
    id: 'city',
    name: { modern: '同城夜话', xianxia: '同城秘约', wuxia: '同城暗访', fantasy: '同城夜约' },
    glyph: '◉',
    tint: '#22D3EE',
    brief: '同城约：报城市/坐标/年龄身材/想约什么/开房还是上门/怎么联系。语气直白饥渴，带一点现实里的戒备与试探。',
    imageMode: 'mixed',
    spiceMax: 2,
  },
  {
    id: 'backstage',
    name: { modern: '后台', xianxia: '仙伶后台', wuxia: '花魁幕后', fantasy: '幻伶幕后' },
    glyph: '▣',
    tint: '#FFC24B',
    brief: '主播与观众：打赏故事、线下约见、主播私照与私密房内容。可与舞台模块互相引用——帖中出现的台主名可以正是此刻正在开台的那位。',
    imageMode: 'mixed',
    spiceMax: 3,
  },
  {
    id: 'forbidden',
    name: { modern: '禁区', xianxia: '禁地', wuxia: '禁楼', fantasy: '禁域' },
    glyph: '⊘',
    tint: '#FF3B3B',
    brief: '背德禁忌：突破伦理与身份界限的关系与性事。语气隐秘、刺激、负罪又沉溺，强调「不能被知道」的紧张感。',
    imageMode: 'mixed',
    spiceMax: 3,
  },
  {
    id: 'rooftop',
    name: { modern: '天台', xianxia: '云台', wuxia: '屋脊', fantasy: '塔顶' },
    glyph: '◇',
    tint: '#3F8F6E',
    brief: '露出与公共场合：暴露、真空出门、野战、被人撞见的经历与计划。语气兴奋、羞耻、上瘾，强调随时会被发现的危险感。',
    imageMode: 'mixed',
    spiceMax: 3,
  },
];

export function nightBoardDef(id: string): NightBoardDef | null {
  return NIGHT_BOARDS.find(b => b.id === id) || null;
}

/** 板块 id → 界面名（未知板块回落原 id，防脏数据穿透）。 */
export function nightBoardName(id: string, style: PhoneStyle = ''): string {
  const def = nightBoardDef(id);
  if (!def) return id;
  return pick(style, def.name.modern, def.name.xianxia, def.name.wuxia, def.name.fantasy);
}

export function nightBoardTint(id: string): string {
  return nightBoardDef(id)?.tint || '#8B5CF6';
}

export function nightBoardGlyph(id: string): string {
  return nightBoardDef(id)?.glyph || '◍';
}

// ─── 受控标签词表（N9；AI 只能从这里选，词表外一律丢弃） ───

export interface NightTagGroup {
  /** 分组名（发帖选标签面板的标题）。 */
  label: string;
  tags: readonly string[];
}

export const NIGHT_TAG_GROUPS: readonly NightTagGroup[] = [
  { label: '画面', tags: ['全裸', '半裸', '私房', '自拍', '偷拍', '图集'] },
  { label: '场所', tags: ['露出', '野战', '车内', '浴室', '更衣室', '天台', '办公室', '酒局'] },
  { label: '人数', tags: ['双人', '多人', '轮流', '围观'] },
  { label: '关系', tags: ['背德', '偷情', '师生', '上司下属', '陌生人', '熟人'] },
  { label: '玩法', tags: ['束缚', '制服', '道具', '角色扮演', '上位', '后入', '口活', '足控'] },
  { label: '细节', tags: ['内射', '颜射', '无套', '潮吹', '失神'] },
  { label: '情绪', tags: ['羞耻', '沉溺', '上瘾', '求饶', '挑衅'] },
  { label: '视角', tags: ['视角·第一人称', '视角·第三人称'] },
];

/** 受控标签全集（顺序=面板展示顺序，也是提示词里的候选列表顺序）。 */
export const NIGHT_TAGS: readonly string[] = NIGHT_TAG_GROUPS.flatMap(g => [...g.tags]);

const NIGHT_TAG_SET = new Set<string>(NIGHT_TAGS);

/** 标签是否在受控词表内（词表外丢弃——防 AI 自造标签把词表冲散）。 */
export function isNightTag(tag: string): boolean {
  return NIGHT_TAG_SET.has(tag);
}

/** 单帖标签上限（发帖面板与解析同口径）。 */
export const NIGHT_TAGS_PER_POST = 6;
/** 单帖标签下限（AI 产出不足时引擎按板块补，界面不强制）。 */
export const NIGHT_TAGS_MIN = 3;

/** 标签净化：词表内、去重、上限截断。 */
export function normalizeNightTags(value: unknown, cap = NIGHT_TAGS_PER_POST): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const tag = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : '';
    if (!tag || !isNightTag(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= cap) break;
  }
  return out;
}

// ─── 平台术语（四风格命名；docs/18 §5 命名表） ───

export type NightTermKey =
  | 'app' | 'slogan' | 'street' | 'post' | 'postUnit' | 'stage' | 'streamer' | 'tip' | 'dm'
  | 'order' | 'date' | 'alias' | 'reveal' | 'live' | 'coins' | 'viewer' | 'privateRoom';

const NIGHT_TERMS: Record<NightTermKey, [string, string, string, string]> = {
  app: ['不夜城', '销金窟', '花楼密录', '夜宴厅'],
  slogan: ['凌晨三点，城市才刚开始', '月上三更，方是觅影时', '灯烬更深，楼中另有生意', '午夜钟后，厅门方才开启'],
  street: ['街区', '坊', '楼', '厅'],
  post: ['帖子', '秘帖', '密帖', '密语'],
  postUnit: ['条', '帖', '帖', '篇'],
  stage: ['舞台', '高台', '花台', '幻台'],
  streamer: ['台主', '仙伶', '花魁', '幻伶'],
  tip: ['打赏', '添香', '缠头', '献礼'],
  dm: ['搭话', '递话', '传笺', '低语'],
  order: ['点单', '点曲', '点曲', '点令'],
  date: ['约会', '私会', '相会', '夜会'],
  alias: ['马甲', '化名', '化名', '假面'],
  reveal: ['揭开', '揭纱', '揭纱', '揭雾'],
  live: ['直播', '开台', '开台', '幻演'],
  coins: ['硬币', '金铢', '缠头银', '晶币'],
  viewer: ['观众', '看客', '恩客', '座客'],
  privateRoom: ['私密房', '内室', '雅间', '帘后'],
};

/** 平台术语按风格取用（四风格全显式，无兜底翻译）。 */
export function nt(key: NightTermKey, style: PhoneStyle = ''): string {
  const [modern, xianxia, wuxia, fantasy] = NIGHT_TERMS[key];
  return pick(style, modern, xianxia, wuxia, fantasy);
}

// ─── 生成玩法（15；提示词编辑与引擎共用的单一事实源） ───

/**
 * 生成 mode 全集（15）：
 *  街区：refresh（整版）/ board（板块定点）/ more（再看一点）/ keyword（关键词）/ post（详情续写回复）
 *  舞台：live（开台列表）/ private（私密房 1v1 推进）/ order（点单响应）
 *  搭话：dm（私信推进）/ date（约会推进一个节点）
 *  档案/专题：persona（角色档案卡）/ aboutMe（他们怎么谈论你）/ commission（委托应征）/ unlock（求解锁授权）
 *  基础：alias（马甲生成）
 */
export type NightMode =
  | 'refresh' | 'board' | 'more' | 'keyword' | 'post'
  | 'live' | 'private' | 'order'
  | 'dm' | 'date'
  | 'persona' | 'aboutMe' | 'commission' | 'unlock'
  | 'alias';

export const NIGHT_MODES: readonly NightMode[] = [
  'refresh', 'board', 'more', 'keyword', 'post',
  'live', 'private', 'order',
  'dm', 'date',
  'persona', 'aboutMe', 'commission', 'unlock', 'alias',
];

/** mode → 人读任务名（错误文案、加载条与提示词编辑器）。 */
export const NIGHT_MODE_LABELS: Record<NightMode, string> = {
  refresh: '刷新今夜',
  board: '板块定点生成',
  more: '再看一点',
  keyword: '关键词生成',
  post: '续写回复',
  live: '开台列表',
  private: '私密房推进',
  order: '点单响应',
  dm: '搭话回复',
  date: '约会推进',
  persona: '角色档案卡',
  aboutMe: '关于我',
  commission: '委托应征',
  unlock: '求解锁',
  alias: '马甲生成',
};

/** 玩法分组（编辑器首屏卡片的顺序与分组标签；顺序即引擎展示顺序）。 */
export const NIGHT_MODE_GROUPS: ReadonlyArray<{ label: string; modes: readonly NightMode[] }> = [
  { label: '街区', modes: ['refresh', 'board', 'more', 'keyword', 'post'] },
  { label: '舞台', modes: ['live', 'private', 'order'] },
  { label: '搭话', modes: ['dm', 'date'] },
  { label: '档案/专题', modes: ['persona', 'aboutMe', 'commission', 'unlock'] },
  { label: '基础', modes: ['alias'] },
];

// ─── 运行期上限（硬顶；用户可调项见 phone-settings.night*） ───

/** 保留内容数上限（设置 nightMaxPosts 的取值区间）。 */
export const NIGHT_MAX_POSTS_MIN = 10;
export const NIGHT_MAX_POSTS_MAX = 80;
/** 直播回看保留数（ended 态房间）。 */
export const NIGHT_MAX_LIVES = 12;
/** 单直播间弹幕上限。 */
export const NIGHT_MAX_BARRAGE = 120;
/** 单直播间轮次上限（历史轮）。 */
export const NIGHT_MAX_ROUNDS = 30;
/** 单直播间点单上限。 */
export const NIGHT_MAX_ORDERS = 20;
/** 打赏榜条目上限。 */
export const NIGHT_MAX_RANK = 20;
/** 单帖配图上限。 */
export const NIGHT_MAX_IMAGES = 3;
/** 单帖评论上限（与社媒同口径）。 */
export const NIGHT_MAX_COMMENTS = 12;
/** 会话数上限。 */
export const NIGHT_MAX_DMS = 40;
/** 单会话消息上限。 */
export const NIGHT_MAX_DM_MSGS = 500;
/** 单次约会的节点上限。 */
export const NIGHT_DATE_MAX_STEP = 6;
/** 委托应征条目上限。 */
export const NIGHT_MAX_ENTRIES = 12;
/** 通知流上限。 */
export const NIGHT_MAX_NOTIFICATIONS = 100;
/** 角色档案卡缓存上限。 */
export const NIGHT_MAX_PERSONAS = 40;
/** 私密收藏夹需长按解锁的默认设置（nightFavLock）。 */
export const NIGHT_FAV_LOCK_MS = 1200;
/** 礼物档位（本地数值 flavor，无经济系统）。 */
export const NIGHT_GIFTS: ReadonlyArray<{ id: string; glyph: string; name: string; heat: number; coins: number }> = [
  { id: 'rose', glyph: '🌹', name: '玫瑰', heat: 60, coins: 1 },
  { id: 'wine', glyph: '🍷', name: '酒', heat: 180, coins: 6 },
  { id: 'kiss', glyph: '💋', name: '香吻', heat: 320, coins: 12 },
  { id: 'crown', glyph: '👑', name: '王冠', heat: 900, coins: 40 },
  { id: 'car', glyph: '🚗', name: '跑车', heat: 2600, coins: 120 },
  { id: 'castle', glyph: '🏰', name: '城堡', heat: 6800, coins: 320 },
];

/** 点单加码阶梯（同一订单继续送礼 → 反应升级）。 */
export const NIGHT_ORDER_TIERS: readonly ['口头', '动作', '专场'] = ['口头', '动作', '专场'];
/** 订单升到下一档所需的额外打赏值（heat 口径）。 */
export const NIGHT_BOOST_STEPS: readonly number[] = [600, 2400];
