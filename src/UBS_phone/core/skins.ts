// ===== 风格文案层（docs/11 §4-§6 + docs/11 + docs/15：现代=现状基底，差异风格按需覆盖） =====
// 设计取舍（对齐 docs/11 §4 的「减法」实现）：不建 130 键注册表——现代文案的唯一事实源
// 仍是各调用点源码本身；差异以 S()/s() 内联多写在取用处，缺省自然回退现代，永不白屏。
// 武侠/西幻（docs/11）在双写之上加一层「术语包」兜底：调用点未显式给出第 3/4 参时，
// 按最长匹配一次性替换现代串里的设备/媒介名词——全机文案自动获得时代语境，个别句子
// 再用显式参数精修。纯函数部分（s/表/金额/术语包）零依赖可被 .cjs 测试直接 require；
// currentStyle 走只读 ref（禁热路径深拷贝）。解析标记/协议/[转账][红包] 等 tag 全风格不变（docs/11 §2 硬约束）。
// docs/15（2026-09-11）：三社媒 App（贴吧/小红书/朋友圈）皮肤下全面恢复——隐藏门控退役，
// 新增三份 App 名词档案（论道坛/英雄楼/行会大厅 · 云笈录/风物志/藏宝图鉴 · 浮生帖/故人笺/篝火手记），
// 渲染与提示词共用同一事实源。

import { normalizeStyleValue, type PhoneStyle } from './chat-model';
import { readPhoneDataRef } from './phone-store';

/** 设置页「风格」选项（现代=默认；其余三套皮肤 docs/11、docs/11）。 */
export const STYLE_OPTIONS: ReadonlyArray<{ id: PhoneStyle; label: string }> = [
  { id: '', label: '现代（默认）' },
  { id: 'xianxia', label: '仙侠·玄青' },
  { id: 'wuxia', label: '武侠·惊堂' },
  { id: 'fantasy', label: '西幻·纹章' },
];

/** 当前聊天风格（跟聊天走：PhoneChatData.style；存储未就绪/异常=现代）。 */
export function currentStyle(): PhoneStyle {
  try {
    return normalizeStyleValue(readPhoneDataRef().style);
  } catch (_e) {
    return '';
  }
}

// ─── 术语包（武侠/西幻兜底翻译：单遍最长匹配，替换产物不二次扫描） ───

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 词表编译缓存：键排序 + 正则编译只做一次（按词表对象引用缓存）。
 * 术语包是模块级常量、全库 S() 调用点数百，武侠/西幻下每个 S() 都回落此处——
 * 原实现每次重排 Object.keys 并重编译 RegExp（O(调用数 × 词条数 log)）。
 */
const _termRegexCache = new WeakMap<Record<string, string>, RegExp | null>();

function compiledTermRegex(terms: Record<string, string>): RegExp | null {
  const cached = _termRegexCache.get(terms);
  if (cached !== undefined) return cached;
  const keys = Object.keys(terms).sort((a, b) => b.length - a.length);
  const re = keys.length ? new RegExp(keys.map(escapeRegExp).join('|'), 'g') : null;
  _termRegexCache.set(terms, re);
  return re;
}

/** 单遍最长匹配替换：键按长度降序进同一 alternation，回调一次成型（防「群聊→群英会」再被「群」误伤）。 */
function localizeTerms(text: string, terms: Record<string, string>): string {
  const re = compiledTermRegex(terms);
  if (!re) return text;
  re.lastIndex = 0; // 复用的全局正则：每次替换前必须归零（否则从上次位置续扫）
  return text.replace(re, m => terms[m] ?? m);
}

/** 武侠·惊堂术语包：天机匣（墨家机关匣）/ 飞鸽传书 / 悦来茶馆（docs/11）。 */
export const WUXIA_TERMS: Record<string, string> = {
  // 设备与 App
  手机: '天机匣', 微信: '飞鸽传书', 微博: '茶馆', 相册: '画匣', 照片: '画面', 图片: '写真',
  拍照: '写真', 拍摄: '写真', 语音: '口信', 备忘: '手札',
  // 关系与会话
  发送好友申请: '递上拜帖', 好友申请: '拜帖', 非好友: '未相识', 好友: '故人',
  群成员: '同道', 发起群聊: '召集群英', 群聊: '群英会', 群名: '会名', 群: '会',
  通讯录: '名录', 聊天记录: '书信往来', 聊天: '书信', 消息: '音讯', 转发: '转寄',
  // 通话
  通话记录: '传声录', 通话: '传声', 电话: '传声', 来电: '唤话', 拨号盘: '唤话', 拨打: '传声', 拨打电话: '发起传声', 挂断电话: '收了线', 回拨: '再传一声',
  挂断: '收线', 接听: '应接', 拒接: '不接', 静音: '封音',
  // 金钱与动作
  转账: '汇银', 红包: '赏钱', 祝福语: '祝词', 已关注: '已结识', 关注: '结识',
  删除: '删去', 清空: '焚去', 保存: '存录', 发布: '投帖', 评论: '搭话',
  搜索: '寻访', 角色: '人物', 来源: '出处', 输入: '录入',
};

/** 西幻·纹章术语包：传讯水晶 / 晶讯 / 远语 / 吟游诗社（docs/11）。 */
export const FANTASY_TERMS: Record<string, string> = {
  // 设备与 App
  手机: '传讯水晶', 微信: '晶讯', 微博: '诗社', 相册: '画廊', 照片: '画面', 图片: '记影',
  拍照: '记影', 拍摄: '记影', 语音: '回声', 备忘: '羊皮笺',
  // 关系与会话
  发送好友申请: '递上荐书', 好友申请: '荐书', 非好友: '未相识', 好友: '同伴',
  群成员: '同仁', 发起群聊: '召集圆桌', 群聊: '圆桌', 群名: '圆桌名', 群: '圆',
  通讯录: '名录', 聊天记录: '晶讯往来', 聊天: '晶讯', 消息: '讯息', 转发: '转递',
  // 通话
  通话记录: '远语录', 通话: '远语', 电话: '远语', 来电: '唤语', 拨号盘: '唤语', 拨打: '远语', 拨打电话: '发起远语', 挂断电话: '断了共鸣', 回拨: '再唤一次',
  挂断: '断开', 接听: '应答', 静音: '静默',
  // 金钱与动作
  转账: '金币转赠', 红包: '钱袋', 已关注: '已同路', 关注: '结伴',
  清空: '烧去', 发布: '投稿', 评论: '应和', 搜索: '检索', 角色: '人物',
};

/** 纯选择器：提示词构建等已持有 style 的场合用（零存储依赖）。
 *  显式覆盖顺序 xianxia → wuxia → fantasy；武侠/西幻未给显式串时回落术语包翻译现代串。 */
export function s(style: PhoneStyle, modern: string, xianxia: string, wuxia?: string, fantasy?: string): string {
  if (style === 'xianxia') return xianxia;
  if (style === 'wuxia') return wuxia ?? localizeTerms(modern, WUXIA_TERMS);
  if (style === 'fantasy') return fantasy ?? localizeTerms(modern, FANTASY_TERMS);
  return modern;
}

/** 渲染层速用：按当前聊天风格取词（只读属性访问，进渲染热路径无碍；风格切换即重渲染）。 */
export function S(modern: string, xianxia: string, wuxia?: string, fantasy?: string): string {
  const style = currentStyle();
  return style === 'xianxia' ? xianxia
    : style === 'wuxia' ? (wuxia ?? localizeTerms(modern, WUXIA_TERMS))
    : style === 'fantasy' ? (fantasy ?? localizeTerms(modern, FANTASY_TERMS))
    : modern;
}

// ─── 桌面 App 显示名/底色/图标（PhoneApp 注册表不动；仅显示层换装） ───

export interface SkinAppDisplay {
  name: string;
  /** 图标底色（仙侠：玉青系功能 App / 鎏金百晓阁；武侠：竹青·黛蓝·朱砂茶馆；西幻：魔蓝·秘紫·酒红诗社）。 */
  color: string;
  /** 桌面图标内容（自绘 HTML；缺省回退注册表 SVG）。 */
  glyph?: string;
}

/** 仙侠桌面显示覆盖（缺省回退注册表原值；settings 名称不变）。
 *  docs/15：贴吧/小红书/朋友圈三 App 皮肤下恢复（论道坛/云笈录/浮生帖）。 */
export const XIAXIA_APP_DISPLAY: Record<string, SkinAppDisplay> = {
  wechat: { name: '传讯', color: '#2E7D5B' },
  'phone-call': { name: '传音', color: '#2E7D5B' },
  camera: { name: '留影', color: '#5E5240' },
  album: { name: '影阁', color: '#3A688F' },
  moments: { name: '浮生帖', color: '#5E8A6E', glyph: '<span class="ubp-skin-glyph">浮</span>' },
  tieba: { name: '论道坛', color: '#3E6A8E', glyph: '<span class="ubp-skin-glyph">坛</span>' },
  xhs: { name: '云笈录', color: '#B4543E', glyph: '<span class="ubp-skin-glyph">笈</span>' },
  weibo: { name: '百晓阁', color: '#C9A24B', glyph: '<span class="ubp-skin-glyph">阁</span>' },
  spy: { name: '窃语符', color: '#5E4B7E', glyph: '<span class="ubp-skin-glyph">窥</span>' },
  chronicle: { name: '岁华录', color: '#5A7391' },
  // 网上商城（docs/52）：仙侠=万宝阁（鎏金）
  shop: { name: '万宝阁', color: '#C9A227', glyph: '<span class="ubp-skin-glyph">宝</span>' },
};

/** 武侠·惊堂桌面显示覆盖（docs/11：天机匣五件套 + 朱砂悦来茶馆；docs/15：英雄楼/风物志/故人笺）。 */
export const WUXIA_APP_DISPLAY: Record<string, SkinAppDisplay> = {
  wechat: { name: '飞鸽传书', color: '#3F7053' },
  'phone-call': { name: '传声', color: '#44647E' },
  camera: { name: '写真匣', color: '#6B4E30' },
  album: { name: '画匣', color: '#8A5A34' },
  moments: { name: '故人笺', color: '#8A6A4A', glyph: '<span class="ubp-skin-glyph">笺</span>' },
  tieba: { name: '英雄楼', color: '#3E5C74', glyph: '<span class="ubp-skin-glyph">楼</span>' },
  xhs: { name: '风物志', color: '#4F7048', glyph: '<span class="ubp-skin-glyph">志</span>' },
  weibo: { name: '悦来茶馆', color: '#A93226', glyph: '<span class="ubp-skin-glyph">茶</span>' },
  spy: { name: '江湖密报', color: '#7A4A32', glyph: '<span class="ubp-skin-glyph">密</span>' },
  chronicle: { name: '江湖纪事', color: '#6B5A3E' },
  // 网上商城（docs/52）：武侠=悦来商行（朱砂）
  shop: { name: '悦来商行', color: '#A63A2E', glyph: '<span class="ubp-skin-glyph">商</span>' },
};

/** 西幻·纹章桌面显示覆盖（docs/11：传讯水晶五件套 + 酒红吟游诗社；docs/15：行会大厅/藏宝图鉴/篝火手记）。 */
export const FANTASY_APP_DISPLAY: Record<string, SkinAppDisplay> = {
  wechat: { name: '晶讯', color: '#3E5C9E' },
  'phone-call': { name: '远语', color: '#5B4A8E' },
  camera: { name: '魔镜', color: '#4E7E8A' },
  album: { name: '画廊', color: '#7D5A3C' },
  moments: { name: '篝火手记', color: '#A0522D', glyph: '<span class="ubp-skin-glyph">篝</span>' },
  tieba: { name: '行会大厅', color: '#46589E', glyph: '<span class="ubp-skin-glyph">会</span>' },
  xhs: { name: '藏宝图鉴', color: '#8A6A2E', glyph: '<span class="ubp-skin-glyph">鉴</span>' },
  weibo: { name: '吟游诗社', color: '#8A2F44', glyph: '<span class="ubp-skin-glyph">诗</span>' },
  spy: { name: '预言之眼', color: '#6E4A8E', glyph: '<span class="ubp-skin-glyph">眼</span>' },
  chronicle: { name: '纪元石', color: '#5A4A8E' },
  // 网上商城（docs/52）：西幻=奇物商栈（酒红）
  shop: { name: '奇物商栈', color: '#9C4A6B', glyph: '<span class="ubp-skin-glyph">栈</span>' },
};

function appDisplayMap(style: PhoneStyle): Record<string, SkinAppDisplay> | null {
  return style === 'xianxia' ? XIAXIA_APP_DISPLAY
    : style === 'wuxia' ? WUXIA_APP_DISPLAY
    : style === 'fantasy' ? FANTASY_APP_DISPLAY
    : null;
}

export function appDisplayName(id: string, fallback: string, style: PhoneStyle): string {
  return appDisplayMap(style)?.[id]?.name || fallback;
}

export function appDisplayColor(id: string, fallback: string, style: PhoneStyle): string {
  return appDisplayMap(style)?.[id]?.color || fallback;
}

export function appDisplayIcon(id: string, fallbackIcon: string, style: PhoneStyle): string {
  return appDisplayMap(style)?.[id]?.glyph || fallbackIcon;
}

// ─── 货币显示（金额仍存数字；仅显示层换算：¥520.00 ⇄ 520 灵石 / 520 银两 / 520 金币） ───

export function displayAmount(amount: string | undefined, style: PhoneStyle): string {
  if (style === 'xianxia' || style === 'wuxia' || style === 'fantasy') {
    const n = Number.parseFloat(String(amount || '0'));
    const unit = style === 'xianxia' ? '灵石' : style === 'wuxia' ? '银两' : '金币';
    return `${Number.isFinite(n) ? n : 0} ${unit}`;
  }
  return `¥${amount || '0.00'}`;
}

// ─── 时钟显示（武侠=时辰制「未初二刻」；西幻=昼夜徽记「☾ 21:15」；现代/仙侠=HH:MM） ───

const SHI_CHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'] as const;
const KE_NUM = ['', '一', '二', '三', '四'] as const;

/** HH:MM → 武侠时辰制（明清初正刻法：13:07=未初、14:30=未正二刻、15:45=申初三刻）。 */
function hhmmToShiChen(hh: number, mm: number): string {
  const branch = SHI_CHEN[Math.floor(((hh + 1) % 24) / 2)] ?? '子';
  const half = hh % 2 === 1 ? '初' : '正';
  const ke = KE_NUM[Math.min(4, Math.floor(mm / 15))] ?? '';
  return `${branch}${half}${ke ? ke + '刻' : ''}`;
}

/** 故事时刻显示：按风格换算 HH:MM 文本（无时刻成分回退原文；全机无真实时钟）。 */
export function displayClockText(hhmm: string, fallback: string, style: PhoneStyle): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return fallback;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return fallback;
  if (style === 'wuxia') return hhmmToShiChen(hh, mm);
  if (style === 'fantasy') return `${hh >= 6 && hh < 18 ? '☀' : '☾'} ${hhmm.trim()}`;
  return hhmm.trim();
}

// ─── 保留社媒档案（三套皮肤共用 weibo 数据底座；docs/11 §6、docs/11） ───

export interface SocialSealSpec {
  /** 印记单字（印章/木牌/火漆）。 */
  ch: string;
  /** 徽标 class 后缀（ubp-wb-seal.yu / ubp-wb-mupai.zong / ubp-wb-wax.shi）。 */
  cls: string;
  /** 提示词侧名称（玉符/名宿/游方诗人…）。 */
  noun: string;
}

export interface SocialSkinProfile {
  /** App 全名（顶栏/提示词）。 */
  appName: string;
  /** 社媒名词（kindNoun：百晓阁风闻 / 茶馆风声 / 诗社见闻）。 */
  postNoun: string;
  /** 顶栏品牌单字印（晓/茶/诗）。 */
  brandGlyph: string;
  /** 顶栏副题。 */
  tagline: string;
  /** 搜索胶囊前缀（满城都在议：/满堂茶客都在议：/酒馆里都在唱：）。 */
  searchLead: string;
  /** 榜牌标题（风闻榜/今日书目/传唱榜）。 */
  boardTitle: string;
  /** 榜牌「查看全榜」入口（阅全榜 ›/听全部书目 ›/展开全榜 ›）。 */
  boardMore: string;
  /** 全榜页空态/榜行热度词（万议论/万传唱）。 */
  hotUnit: string;
  /** 首页筛选 chips：全部流（市井/全堂/广场）。 */
  segAll: string;
  /** 首页筛选 chips：关注流（故人/熟客/同路）。 */
  segFollow: string;
  /** 底部 Tab：首页（风闻/书场/广场）。 */
  tabHome: string;
  /** 底部 Tab：消息（知会）。 */
  tabMessages: string;
  /** 底部 Tab：我（名帖/名帖/名册）。 */
  tabMe: string;
  /** 发帖人名词（报信人/茶客/旅人）。 */
  authorNoun: string;
  /** 行动行名词：转述/议论/喝彩 式三元组（转发/评论/点赞）。 */
  actRepost: string;
  actComment: string;
  actLike: string;
  /** 认证印记（orange/gold/blue → 玉符·金符·官符 / 侠·宗·官 / 诗·宫·国）。 */
  seals: Record<'orange' | 'gold' | 'blue', SocialSealSpec>;
  /** vip 贵客名词（仙盟贵客/茶馆贵客/诗社贵宾）。 */
  vipNoun: string;
  /** 详情页评论栏引导（留一言…/讲两句…/应一句…）。 */
  commentLead: string;
  /** 榜单 tag 枚举提示词（惊|扬|议|新 …）。 */
  trendingTags: string;
  /** 话题页 hero 名词（风闻/风声/传唱）。 */
  topicWord: string;
  /** 话题页 hero 动词（正在发酵/满堂哗然/歌声不歇）。 */
  topicVerb: string;
  /** 话题页统计：阅读量动词（阅/听/唱）。 */
  statRead: string;
  /** 话题页统计：讨论量动词（议/议/和）。 */
  statDiscuss: string;
  /** 发帖 composer 标题（投帖/说与茶客/谱写见闻）。 */
  composePostTitle: string;
  /** 发帖 composer 占位（今日风闻…/今日风声…/今日见闻…）。 */
  composePostPlaceholder: string;
  /** 转述/传唱 composer 标题（传抄此帖/转述此帖/传唱此篇）。 */
  composeRepostTitle: string;
  /** 转述理由占位示例词（如「静待后续」/「且听下回分解」/「这事在酒馆都唱开了」）。 */
  composeRepostHint: string;
  /** 整版刷新 toast（百晓阁已刷新/悦来茶馆已上新/吟游诗社已更新）。 */
  refreshToast: string;
  /** 刷新进行中文案（正在收录风闻…/正在沏新茶收风声…/正在誊抄新见闻…）。 */
  refreshingText: string;
  /** 话题页刷新进行中（正在收录风闻议论…/正在听茶客议论…/正在收录应和…）。 */
  refreshingTopicText: string;
  /** 详情页标题（风闻详情/风声详情/见闻详情）。 */
  detailTitle: string;
  /** 榜单页空态标题（风闻榜还是空的/书目还是空的/传唱榜还是空的）。 */
  hotEmptyTitle: string;
  /** 信息流空态标题（满堂风闻还是空的/满堂风声还是空的/见闻长卷还是空的）。 */
  feedEmptyTitle: string;
  /** 关注流空态标题（故人还未投帖/熟客还未开口/同路人还未起笔）。 */
  followEmptyTitle: string;
  /** 「我的」页标题（我的名帖/我的名帖/我的名册）。 */
  meTitle: string;
  /** 本地账号说明（本地名帖 · 只列我所投之帖 式）。 */
  meLocalNote: string;
  /** 取关 toast（已与 @X 相忘于江湖 式）。 */
  unfollowToast: string;
}

const XIAXIA_SEALS: Record<'orange' | 'gold' | 'blue', SocialSealSpec> = {
  orange: { ch: '玉', cls: 'yu', noun: '玉符' },
  gold: { ch: '金', cls: 'jin', noun: '金符' },
  blue: { ch: '官', cls: 'guan', noun: '官符' },
};

const WUXIA_SEALS: Record<'orange' | 'gold' | 'blue', SocialSealSpec> = {
  orange: { ch: '侠', cls: 'xia', noun: '侠名帖' },
  gold: { ch: '宗', cls: 'zong', noun: '宗师帖' },
  blue: { ch: '官', cls: 'guan', noun: '官府帖' },
};

const FANTASY_SEALS: Record<'orange' | 'gold' | 'blue', SocialSealSpec> = {
  orange: { ch: '诗', cls: 'shi', noun: '诗社印' },
  gold: { ch: '宫', cls: 'gong', noun: '宫廷印' },
  blue: { ch: '国', cls: 'guo', noun: '王国印' },
};

/** 各风格保留社媒档案（现代走微博原文，不入此表）。 */
export const SOCIAL_SKIN_PROFILES: Record<'xianxia' | 'wuxia' | 'fantasy', SocialSkinProfile> = {
  xianxia: {
    appName: '百晓阁', postNoun: '百晓阁风闻', brandGlyph: '晓',
    tagline: '天下风闻 · 皆出于此', searchLead: '满城都在议：', boardTitle: '风 闻 榜', boardMore: '阅全榜 ›',
    hotUnit: '议论', segAll: '市井', segFollow: '故人', tabHome: '风闻', tabMessages: '知会', tabMe: '名帖',
    authorNoun: '报信人', actRepost: '传抄', actComment: '议论', actLike: '喝彩',
    seals: XIAXIA_SEALS, vipNoun: '仙盟贵客', commentLead: '留一言…', trendingTags: '惊|扬|议|新',
    topicWord: '风闻', topicVerb: '正在发酵', statRead: '阅', statDiscuss: '议',
    composePostTitle: '投帖', composePostPlaceholder: '今日风闻，说与诸位听…',
    composeRepostTitle: '传抄此帖', composeRepostHint: '静待后续」或「且看此帖',
    refreshToast: '百晓阁已刷新', refreshingText: '正在收录风闻…', refreshingTopicText: '正在收录风闻议论…',
    detailTitle: '风闻详情', hotEmptyTitle: '风闻榜还是空的', feedEmptyTitle: '满堂风闻还是空的',
    followEmptyTitle: '故人还未投帖', meTitle: '我的名帖', meLocalNote: '本地名帖 · 只列我所投之帖',
    unfollowToast: '已与 @${id} 相忘于江湖',
  },
  wuxia: {
    appName: '悦来茶馆', postNoun: '茶馆风声', brandGlyph: '茶',
    tagline: '江湖风声 · 皆入茶来', searchLead: '满堂茶客都在议：', boardTitle: '今日书目', boardMore: '听全部书目 ›',
    hotUnit: '议论', segAll: '全堂', segFollow: '熟客', tabHome: '书场', tabMessages: '知会', tabMe: '名帖',
    authorNoun: '茶客', actRepost: '转述', actComment: '搭话', actLike: '叫好',
    seals: WUXIA_SEALS, vipNoun: '茶馆贵客', commentLead: '讲两句…', trendingTags: '惊|彩|议|新',
    topicWord: '风声', topicVerb: '满堂哗然', statRead: '听', statDiscuss: '议',
    composePostTitle: '说与茶客', composePostPlaceholder: '今日风声，说与满堂茶客听…',
    composeRepostTitle: '转述此帖', composeRepostHint: '且听下回分解」或「此事必有内情',
    refreshToast: '悦来茶馆已上新', refreshingText: '正在沏新茶、收录风声…', refreshingTopicText: '正在听茶客议论…',
    detailTitle: '风声详情', hotEmptyTitle: '今日书目还是空的', feedEmptyTitle: '满堂风声还是空的',
    followEmptyTitle: '熟客还未开口', meTitle: '我的名帖', meLocalNote: '本地名帖 · 只列我所投之帖',
    unfollowToast: '已与 @${id} 渐行渐远',
  },
  fantasy: {
    appName: '吟游诗社', postNoun: '诗社见闻', brandGlyph: '诗',
    tagline: '歌谣与见闻 · 自酒馆传向王国', searchLead: '酒馆里都在唱：', boardTitle: '传唱榜', boardMore: '展开全榜 ›',
    hotUnit: '传唱', segAll: '广场', segFollow: '同路', tabHome: '广场', tabMessages: '知会', tabMe: '名册',
    authorNoun: '旅人', actRepost: '传唱', actComment: '应和', actLike: '喝彩',
    seals: FANTASY_SEALS, vipNoun: '诗社贵宾', commentLead: '应一句…', trendingTags: '炽|喧|秘|新',
    topicWord: '传唱', topicVerb: '歌声不歇', statRead: '唱', statDiscuss: '和',
    composePostTitle: '谱写见闻', composePostPlaceholder: '今日见闻，唱与诸位旅人听…',
    composeRepostTitle: '传唱此篇', composeRepostHint: '这事在酒馆都唱开了」或「以缪斯之名',
    refreshToast: '吟游诗社已更新', refreshingText: '正在誊抄新见闻…', refreshingTopicText: '正在收录应和…',
    detailTitle: '见闻详情', hotEmptyTitle: '传唱榜还是空的', feedEmptyTitle: '见闻长卷还是空的',
    followEmptyTitle: '同路人还未起笔', meTitle: '我的名册', meLocalNote: '本地名册 · 只列我所投之篇',
    unfollowToast: '已与 @${id} 分道而行',
  },
};

/** 保留社媒档案按风格取用（现代=微博原文，返回 null 走现代渲染分支）。 */
export function socialSkinProfile(style: PhoneStyle): SocialSkinProfile | null {
  return style === 'xianxia' || style === 'wuxia' || style === 'fantasy' ? SOCIAL_SKIN_PROFILES[style] : null;
}

// ─── 三 App 皮肤档案（docs/15 §3：贴吧/小红书/朋友圈 × 三风格；渲染与提示词共用同一事实源） ───
// 楼层骨架（楼层号/楼主/楼中楼/盖楼/只看楼主）与熟人广场机制全风格保留——论坛通用语/既有机制不换词。

/** 贴吧皮肤档案（吧→坛/堂/行会）。 */
export interface TiebaSkinProfile {
  appName: string;
  /** 社区单位（吧）。 */
  unitNoun: string;
  /** 帖子单位。 */
  postNoun: string;
  /** 社区成员（吧友）。 */
  memberNoun: string;
  /** 社区管理者（吧务）。 */
  modNoun: string;
  /** 搜索胶囊前缀。 */
  searchLead: string;
  /** 首页分段：关注流。 */
  segFollow: string;
  /** 首页分段：推荐流。 */
  segRec: string;
  /** 首页分段：热议流。 */
  segHot: string;
  /** 底部 Tab：进吧。 */
  tabEnter: string;
  /** 签到按钮（彩蛋）。 */
  signLabel: string;
  /** 签到 toast 后缀（经验 +8）。 */
  signToast: string;
  /** 置顶公告前缀（吧规）。 */
  pinnedPrefix: string;
  /** 回帖栏占位。 */
  replyLead: string;
  /** 回帖动作词（回帖/应帖）。 */
  replyAct: string;
  /** 整版刷新 toast。 */
  refreshToast: string;
  /** 刷新进行中文案。 */
  refreshingText: string;
  /** 手动加吧按钮（添加贴吧）。 */
  addUnit: string;
  /** 提示词等级头衔示例（authorTitle 产出侧）。 */
  levelExamples: string;
  /** 我的等级 flavor（吧详情头部；按吧名散列取用）。 */
  selfLevels: readonly string[];
}

/** 小红书皮肤档案（笔记→云笈/图志/图鉴）。 */
export interface XhsSkinProfile {
  appName: string;
  /** 笔记单位。 */
  noteNoun: string;
  /** 搜索胶囊前缀。 */
  searchLead: string;
  /** 分段：关注流。 */
  segFollow: string;
  /** 分段：发现流。 */
  segDiscover: string;
  /** 底部 Tab：首页。 */
  tabHome: string;
  /** 点赞词。 */
  likeNoun: string;
  /** 收藏词（码住）。 */
  collectNoun: string;
  /** 已收藏词。 */
  collectedNoun: string;
  /** 评论词。 */
  commentNoun: string;
  /** 作者主页「号」字段名。 */
  authorIdNoun: string;
  /** 作者主页属地字段名（IP 属地）。 */
  authorLocNoun: string;
  /** 作者主页收藏 tab 名。 */
  collectTab: string;
  /** 作者主页赞过 tab 名。 */
  likeTab: string;
}

/** 朋友圈皮肤档案（熟人广场机制全风格不变，只换人称与物件名词）。 */
export interface MomentsSkinProfile {
  appName: string;
  /** 动态单位。 */
  postNoun: string;
  /** 发动态动作词。 */
  postVerb: string;
  /** 点赞词（名单制点赞行）。 */
  likeNoun: string;
  /** 评论词。 */
  commentNoun: string;
  /** composer 占位。 */
  composerLead: string;
}

const TIEBA_SKIN_PROFILES: Record<'xianxia' | 'wuxia' | 'fantasy', TiebaSkinProfile> = {
  xianxia: {
    appName: '论道坛', unitNoun: '坛', postNoun: '坛帖', memberNoun: '坛友', modNoun: '坛务',
    searchLead: '坛中都在论：', segFollow: '结缘', segRec: '荐阅', segHot: '争鸣',
    tabEnter: '进坛', signLabel: '参坛', signToast: '道行 +8', pinnedPrefix: '坛规',
    replyLead: '刻一句…', replyAct: '回帖',
    refreshToast: '论道坛已收录新帖', refreshingText: '正在收录坛中新帖…', addUnit: '添加坛',
    levelExamples: '修为境界（如「炼气七层」「筑基剑修」，可省略）',
    selfLevels: ['炼气修士', '炼气后期', '筑基初期', '筑基后期', '金丹真人', '元婴修士', '化神尊座'],
  },
  wuxia: {
    appName: '英雄楼', unitNoun: '堂', postNoun: '楼帖', memberNoun: '堂友', modNoun: '堂务',
    searchLead: '道上都在传：', segFollow: '熟识', segRec: '荐阅', segHot: '争鸣',
    tabEnter: '进堂', signLabel: '到堂', signToast: '阅历 +8', pinnedPrefix: '堂规',
    replyLead: '留一句…', replyAct: '回帖',
    refreshToast: '英雄楼已上新', refreshingText: '正在收录堂中新帖…', addUnit: '添加堂',
    levelExamples: '江湖辈分（如「武当三代弟子」「漕帮香主」，可省略）',
    selfLevels: ['三代弟子', '二代弟子', '内门好手', '外堂香主', '堂口前辈', '一派宗师', '武林名宿'],
  },
  fantasy: {
    appName: '行会大厅', unitNoun: '行会', postNoun: '榜文', memberNoun: '会众', modNoun: '会首',
    searchLead: '会里都在问：', segFollow: '同路', segRec: '荐阅', segHot: '争鸣',
    tabEnter: '进会', signLabel: '点卯', signToast: '功勋 +8', pinnedPrefix: '会规',
    replyLead: '应一句…', replyAct: '应帖',
    refreshToast: '行会大厅已更新', refreshingText: '正在收录会中新帖…', addUnit: '添加行会',
    levelExamples: '行会阶级（如「铜级冒险者」「银环会员」，可省略）',
    selfLevels: ['铜级会员', '铁级会员', '银环会员', '金环会员', '资深会众', '会中长老', '名誉会首'],
  },
};

const XHS_SKIN_PROFILES: Record<'xianxia' | 'wuxia' | 'fantasy', XhsSkinProfile> = {
  xianxia: {
    appName: '云笈录', noteNoun: '云笈',
    searchLead: '同好都在寻：', segFollow: '结缘', segDiscover: '拾遗', tabHome: '云笈',
    likeNoun: '道好', collectNoun: '入笈', collectedNoun: '已入笈', commentNoun: '附言',
    authorIdNoun: '道号', authorLocNoun: '所在坊市', collectTab: '入过的笈', likeTab: '道过的好',
  },
  wuxia: {
    appName: '风物志', noteNoun: '图志',
    searchLead: '江湖都在寻：', segFollow: '熟识', segDiscover: '拾趣', tabHome: '图志',
    likeNoun: '称好', collectNoun: '珍藏', collectedNoun: '已珍藏', commentNoun: '留话',
    authorIdNoun: '名号', authorLocNoun: '所在州府', collectTab: '珍过的藏', likeTab: '称过的好',
  },
  fantasy: {
    appName: '藏宝图鉴', noteNoun: '图鉴',
    searchLead: '冒险者都在翻：', segFollow: '同路', segDiscover: '巡览', tabHome: '图鉴',
    likeNoun: '喝彩', collectNoun: '收录', collectedNoun: '已收录', commentNoun: '附言',
    authorIdNoun: '徽记', authorLocNoun: '所属领地', collectTab: '收过的录', likeTab: '喝过的彩',
  },
};

const MOMENTS_SKIN_PROFILES: Record<'xianxia' | 'wuxia' | 'fantasy', MomentsSkinProfile> = {
  xianxia: {
    appName: '浮生帖', postNoun: '浮生帖', postVerb: '报近况',
    likeNoun: '道好', commentNoun: '附言', composerLead: '念一句近况…',
  },
  wuxia: {
    appName: '故人笺', postNoun: '故人笺', postVerb: '投笺',
    likeNoun: '称善', commentNoun: '留话', composerLead: '报一句平安…',
  },
  fantasy: {
    appName: '篝火手记', postNoun: '篝火手记', postVerb: '记手记',
    likeNoun: '喝彩', commentNoun: '附言', composerLead: '记一笔近况…',
  },
};

/** 贴吧皮肤档案按风格取用（现代返回 null 走现代渲染分支）。 */
export function tiebaSkinProfile(style: PhoneStyle): TiebaSkinProfile | null {
  return style === 'xianxia' || style === 'wuxia' || style === 'fantasy' ? TIEBA_SKIN_PROFILES[style] : null;
}

/** 小红书皮肤档案按风格取用（现代返回 null 走现代渲染分支）。 */
export function xhsSkinProfile(style: PhoneStyle): XhsSkinProfile | null {
  return style === 'xianxia' || style === 'wuxia' || style === 'fantasy' ? XHS_SKIN_PROFILES[style] : null;
}

/** 朋友圈皮肤档案按风格取用（现代返回 null 走现代渲染分支）。 */
export function momentsSkinProfile(style: PhoneStyle): MomentsSkinProfile | null {
  return style === 'xianxia' || style === 'wuxia' || style === 'fantasy' ? MOMENTS_SKIN_PROFILES[style] : null;
}
