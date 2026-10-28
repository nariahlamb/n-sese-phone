// ===== 社媒提示词模板与上下文拼装（朋友圈 + 贴吧 + 微博 + 小红书，契约由 tests/phone-social-prompts.test.cjs 锁定） =====
// 设计参考（2026-09 平台调研）：
//  - 选题与人格：破防瞬间选题库 / 网络抽象人格滤镜 / 信息边界句式 / 反例引用禁令 / 禁止现实日期 / 反无事件条款
//  - 沉浸与节奏：80/20 沉浸法则 / 板块功能定义 / 拟真禁令 / 数量区间量化 / 回复层次语法 / 增量协议
//  - 内容与关系：题材抽签+单题材注入 / 角色路入配比 / 关系→行为映射 / 反AI腔禁词表 / 示例即规则 / @主角
//  - 贴吧调研：吧为单位的兴趣社区 + 楼层盖楼（楼层号/楼主/楼中楼/只看楼主）+ 老哥语言（火钳刘明/十五字/典孝急乐绷）
//  - 微博调研：时间线+热搜广场媒体 + 转发链传播（//@）+ 认证体系（橙V/金V/蓝V）+ 吃瓜粉圈用语
//  - 小红书调研：双列瀑布流封面驱动 + 收藏码住文化 + 标题公式（救命体/谁懂啊/数字攻略）+ emoji 清单体正文
// 配比（用户定案）：三平台发帖人约 30% 通讯录角色 + 70% 有生活感路人——社媒用于拓展世界感，
// 朋友圈例外（熟人广场，发帖人白名单全量角色）。
// 时间体系（用户定案 2026-09 改）：填表一律绝对故事时间——AI 把资料块「当前位置与时间」的当前时间往回推成
// 「YYYY年M月D日 HH:MM」（久远旧帖可省时刻），填表禁止一切相对措辞（相对词易原样漏进注入侧，且部分无法可靠解析）；
// 落盘归一化为规范绝对故事时间戳（social-time，相对措辞仅作存量/失误兜底解析），注入侧（混合块/世界书/待反馈段）一律绝对时间；
// 相对化只存在于 UI 渲染层（postTimeText 等按当前故事时间动态分桶）。

import type { RosterSnapshot } from './roster';
import type { PhoneStyle } from './chat-model';
import { s } from './skins';
import { contactSection, relationSection } from './chat-prompts';
import { formatStampFull } from './social-time';
import type {
  MomentPost, TiebaPost, WeiboPost, XhsNote, SocialComment, SocialKind, SocialUserAction, SocialFollows, SocialAuthorProfile,
} from './social-model';
import type { MixedRecords } from './phone-timeline';
import {
  ANTI_AI_WORDS_RULE,
  SOCIAL_CLOSE_TAG,
  SOCIAL_OPEN_TAG,
  renderSocialPromptTemplate,
  socialPromptEditableDefault,
  socialPromptKey,
  socialStyleKeyOf,
  socialThemeKey,
  type SocialBranchKey,
  type SocialPromptVars,
} from './social-prompt-templates';

export type { SocialKind };
// 契约常量与 40 套指令模板的单一事实源已移至 social-prompt-templates（数据与常量同处）；
// 此处转出，既有导入点（parser/engine/测试）不受影响。
export { SOCIAL_OPEN_TAG, SOCIAL_CLOSE_TAG } from './social-prompt-templates';


// ─── 随机抽样（题材抽签 / 绿灯触发随机联系人共用，测试可注入 rand 复现） ───

/** Fisher-Yates 洗牌取样（不改动入参）。 */
export function pickRandom<T>(items: readonly T[], count: number, rand: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

// ─── 题材池（抽签注入，防同质化） ───

export interface SocialTheme {
  id: string;
  /** 注入提示词的题材名。 */
  label: string;
  /** 该题材的写作指导（含具体选题句式）。 */
  guide: string;
}

/** 朋友圈选题池（每次刷新随机抽 2 个注入）。 */
export const MOMENT_THEMES: readonly SocialTheme[] = [
  { id: 'breakdown', label: '破防瞬间', guide: '被打脸、被放鸽子、外卖被偷、游戏连跪、被迫加班、买到烂货——生活里的破防小事，最容易让人上网发疯的那种' },
  { id: 'flex', label: '晒物晒生活', guide: '新买的、自己做的饭、今日穿搭、宠物、房间一角——带一点小得意或小纠结，像随手的照片配文' },
  { id: 'mood', label: '情绪与心事', guide: '深夜emo、突然的感慨、说不出口的心事——含蓄克制，像随手发出去又懒得删的那种' },
  { id: 'romance', label: '感情线', guide: '约会/暧昧/官宣/吃醋/阴阳——严格按各角色与主角的真实关系和态度来（好感高可晒可@主角，关系差可阴阳），禁止全员恋爱脑' },
  { id: 'help', label: '求助提问', guide: '生活难题、求推荐、求救命——问题要具体，评论区帮倒忙也可以' },
  { id: 'fun', label: '吃喝玩乐', guide: '探店、电影、旅游、排队、踩雷——有细节有情绪，好吃就夸难吃就骂' },
  { id: 'chaos', label: '抽象发疯', guide: '发疯文学、无厘头、半夜抽风、谜语人——越抽象越好，但仍是这个人本人会发的那种疯' },
  { id: 'work', label: '工作学习', guide: '社畜日常、考试周、老板语录、赶工带娃——吐槽要具体到事，不写职场感悟散文' },
];

/** 贴吧热议方向池（每次刷新随机抽 1 个，主导置顶与部分帖子）。 */
export const TIEBA_THEMES: readonly SocialTheme[] = [
  { id: 'city', label: '城市与设施', guide: '天气突变、停水停电、道路检修、公共交通、公共活动——市政与邻里的具体麻烦和通知' },
  { id: 'price', label: '物价与消费', guide: '菜价、新品、二手交易、避雷某店、薅羊毛——掏钱的喜怒哀乐，要具体到东西和价格' },
  { id: 'gossip', label: '本地八卦', guide: '谁和谁、某店老板、小区纷争、传闻求证——小道消息要有鼻子有眼但留不确定性' },
  { id: 'world', label: '世界特有话题', guide: '只属于当前世界观的事（按资料块的世界背景推断：校园=考试社团、都市=公司八卦、异世界=该世界特有制度/物价/传闻）' },
  { id: 'help', label: '求助与失物', guide: '寻物启事、求推荐、拼车拼单、招领——帖子短平快，评论区热心或跑题' },
  { id: 'debate', label: '热点争议', guide: '有对立立场的话题（该不该X、某新规、某现象）——楼主有立场，评论区吵起来，两派都要有人说' },
];

/** 微博热搜方向池（每次刷新随机抽 1 个，主导热搜榜与部分博文）。 */
export const WEIBO_THEMES: readonly SocialTheme[] = [
  { id: 'event', label: '公共事件', guide: '马拉松封路、 concerts、展览开幕、极端天气、事故通报——有官方通报也有市民吐槽，两极共存' },
  { id: 'ent', label: '文娱八卦', guide: '明星恋情/塌房、影视剧集、演唱会官宣——吃瓜群众蹲锤、粉丝控评、路人看乐子' },
  { id: 'relation', label: '情感与人际', guide: '恋爱脑讨论、职场人际、亲情友情话题——「家人们谁懂啊」式共鸣向投稿与争论' },
  { id: 'world', label: '世界特有热点', guide: '只属于当前世界观的大事件（按资料块推断：校园=保研/社团风波、都市=行业新闻、异世界=该世界特有大事）' },
  { id: 'livelihood', label: '民生与消费', guide: '物价、工资、租房、新店开业倒闭——「月薪X千在XX能活吗」式讨论，评论区现身说法' },
  { id: 'funny', label: '乐子与梗', guide: '本地梗、迷惑行为大赏、神评截图——笑不活了式转发链，评论区接梗盖楼' },
];

/** 百晓阁风闻方向池（仙侠差异覆盖；结构/抽签机制同微博池，docs/11 §7.2）。 */
export const WEIBO_THEMES_XX: readonly SocialTheme[] = [
  { id: 'sect', label: '宗门风云', guide: '宗门大比、掌门更迭、门规风波、正邪摩擦——修真界的大事，官方通报与坊间议论并存' },
  { id: 'market', label: '坊市百态', guide: '灵物价涨跌、新铺开张、坊市治安、黑心商贩——掏灵石的喜怒哀乐，要具体到东西和价' },
  { id: 'secret', label: '秘境异闻', guide: '秘境开启、遗迹现世、异象传闻——有板有眼但留不确定性，蹲一个亲历者现身' },
  { id: 'vip', label: '大能轶事', guide: '大能收徒、斗法旧闻、癖好八卦——说书人渲染体与目击者口吻并存' },
  { id: 'calamity', label: '妖患天灾', guide: '妖兽出没、灵潮异动、天时反常——官符通报体与百姓自危声浪' },
  { id: 'craft', label: '丹器符阵新方', guide: '新丹方、法器开炉、符箓新绘——行家点评与外行看热闹' },
];

/** 悦来茶馆风声方向池（武侠差异覆盖；结构/抽签机制同微博池，docs/11）。 */
export const WEIBO_THEMES_WX: readonly SocialTheme[] = [
  { id: 'sect', label: '门派恩怨', guide: '门派比武、掌门更迭、门规风波、正邪摩擦——武林大事，官府告示与坊间议论并存' },
  { id: 'escort', label: '镖局江湖', guide: '镖队劫案、走镖险途、镖局开张倒闭、趟子手招募——刀口舔血的生计与传闻' },
  { id: 'contest', label: '武林大会', guide: '论剑英雄帖、擂台踢馆、名次爆冷、赌盘赔率——武人论高下，茶客论输赢' },
  { id: 'master', label: '奇人异事', guide: '隐世高人、绝技失传、怪医神算、江湖轶闻——有鼻子有眼但留三分不确定' },
  { id: 'official', label: '官府海捕', guide: '通缉要犯、封河戒严、悬赏告示、衙门新政——官府告示体与百姓议论声浪' },
  { id: 'market', label: '市井百态', guide: '米价盐价、客栈开张、庙会社戏、偷鸡摸狗——掏铜板的喜怒哀乐，具体到东西和价' },
];

/** 吟游诗社见闻方向池（西幻差异覆盖；结构/抽签机制同微博池，docs/11）。 */
export const WEIBO_THEMES_FT: readonly SocialTheme[] = [
  { id: 'crown', label: '王国政局', guide: '王室婚讯、领主摩擦、征税新政、骑士册封——王都的大事，布告体与酒馆议论并存' },
  { id: 'tavern', label: '酒馆见闻', guide: '酒馆斗殴、新酿开桶、旅人怪谈、悬赏委托——冒险者落脚处的鸡毛蒜皮与传闻' },
  { id: 'dungeon', label: '地城异闻', guide: '北塔动静、地城开启、遗迹现世、异象传闻——有板有眼但留不确定性，蹲一个亲历者现身' },
  { id: 'dragon', label: '巨龙与魔兽', guide: '龙影掠空、魔兽出没、猎人结队、赏金飙升——惊叹体与自危声浪' },
  { id: 'guild', label: '学院与公会', guide: '学院招生、公会榜单、法师轶事、学徒纠纷——行家点评与外行看热闹' },
  { id: 'caravan', label: '商队市集', guide: '商队护送、市集物价、新货到港、黑店避雷——掏金币的喜怒哀乐，具体到东西和价' },
];

/** 微博热搜方向池按风格取用（仙侠=百晓阁 / 武侠=悦来茶馆 / 西幻=吟游诗社）。 */
export function weiboThemesOf(style: PhoneStyle): readonly SocialTheme[] {
  return style === 'xianxia' ? WEIBO_THEMES_XX
    : style === 'wuxia' ? WEIBO_THEMES_WX
    : style === 'fantasy' ? WEIBO_THEMES_FT
    : WEIBO_THEMES;
}

/** 朋友圈选题池风格覆盖（docs/15 §4：熟人广场机制不变，选题域换装）。 */
export const MOMENT_THEMES_XX: readonly SocialTheme[] = [
  { id: 'breakdown', label: '道途破防', guide: '机缘被截胡、丹炉炸了、坊市被宰、御剑摔沟里、大比垫底——修真生活里破防的小事，最容易让人上网发疯的那种' },
  { id: 'flex', label: '晒宝晒物', guide: '新炼的法器、自己种的灵植、今日穿搭、灵宠——带一点小得意或小纠结，像随手的留影配文' },
  { id: 'mood', label: '心境杂录', guide: '闭关出关的感慨、说不出口的心事、境界卡关的郁结——含蓄克制，像随手发出去又懒得删的那种' },
  { id: 'romance', label: '情缘线', guide: '道侣约会/双修/吃醋/阴阳——严格按各角色与主角的真实关系和态度来（好感高可晒可@主角，关系差可阴阳），禁止全员恋爱脑' },
  { id: 'help', label: '求助问道', guide: '修炼难题、求丹方、求灵物鉴别——问题要具体，评论区帮倒忙也可以' },
  { id: 'fun', label: '游历吃喝', guide: '坊市探店、灵膳、游历、排队、踩雷——有细节有情绪，好吃就夸难吃就骂' },
  { id: 'chaos', label: '抽象发疯', guide: '发疯文学、无厘头、半夜抽风、谜语人——越抽象越好，但仍是这个人本人会发的那种疯' },
  { id: 'work', label: '课业宗务', guide: '宗门杂役、传功任务、掌门语录、赶工炼器——吐槽要具体到事，不写修真感悟散文' },
];

export const MOMENT_THEMES_WX: readonly SocialTheme[] = [
  { id: 'breakdown', label: '江湖破防', guide: '被师父罚站桩、比武输给后辈、镖被劫、客栈被宰——江湖生活里破防的小事' },
  { id: 'flex', label: '晒物晒镖', guide: '新打的刀、自己得的宝、今日行头、坐骑——带一点小得意或小纠结，像随手的写真配文' },
  { id: 'mood', label: '心事', guide: '深夜独酌、说不出口的心事、恩怨难了——含蓄克制，像随手写出去又懒得撕的那种' },
  { id: 'romance', label: '情缘线', guide: '相好/提亲/吃醋/阴阳——严格按各角色与主角的真实关系和态度来，禁止全员恋爱脑' },
  { id: 'help', label: '求助', guide: '武学难题、求药方、寻人寻物——问题要具体，评论区帮倒忙也可以' },
  { id: 'fun', label: '吃喝玩乐', guide: '客栈探店、庙会社戏、游历、排队、踩雷——有细节有情绪，好吃就夸难吃就骂' },
  { id: 'chaos', label: '抽象发疯', guide: '无厘头、半夜抽风、谜语人——越抽象越好，但仍是这个人本人会发的那种疯' },
  { id: 'work', label: '镖局营生', guide: '走镖日常、东家语录、赶工交货、带徒——吐槽要具体到事，不写江湖感悟散文' },
];

export const MOMENT_THEMES_FT: readonly SocialTheme[] = [
  { id: 'breakdown', label: '冒险破防', guide: '被队友坑、地城空手而归、装备被黑店宰、坐骑跑了——冒险生活里破防的小事' },
  { id: 'flex', label: '晒物晒藏', guide: '新得的宝、自己酿的酒、今日法袍、魔宠——带一点小得意或小纠结，像随手的记影配文' },
  { id: 'mood', label: '心事', guide: '烛光下的感慨、说不出口的心事、诅咒缠身的郁结——含蓄克制，像随手记下来又懒得撕的那种' },
  { id: 'romance', label: '情缘线', guide: '约会/求婚/吃醋/阴阳——严格按各角色与主角的真实关系和态度来，禁止全员恋爱脑' },
  { id: 'help', label: '求助', guide: '诅咒怎么解、求药方、求装备鉴别——问题要具体，评论区帮倒忙也可以' },
  { id: 'fun', label: '吃喝玩乐', guide: '酒馆探店、节庆集市、冒险、排队、踩雷——有细节有情绪，好吃就夸难吃就骂' },
  { id: 'chaos', label: '抽象发疯', guide: '无厘头、半夜抽风、谜语人——越抽象越好，但仍是这个人本人会发的那种疯' },
  { id: 'work', label: '佣兵营生', guide: '委托日常、雇主语录、赶工交差、带新人——吐槽要具体到事，不写冒险感悟散文' },
];

/** 贴吧热议方向池风格覆盖（docs/15 §4：抽签机制同现代池）。 */
export const TIEBA_THEMES_XX: readonly SocialTheme[] = [
  { id: 'help', label: '问道互助', guide: '修炼卡关、功法选择、求支招——帖子短平快，评论区热心或跑题' },
  { id: 'witness', label: '秘境亲历', guide: '坊市异象、遗迹见闻、亲历爆料——有鼻子有眼但留不确定性，蹲一个亲历者现身' },
  { id: 'price', label: '坊市避雷', guide: '灵物价、新铺开张、黑店避雷、薅羊毛——掏灵石的喜怒哀乐，要具体到东西和价' },
  { id: 'gossip', label: '宗门恩怨', guide: '门派摩擦、大比恩怨、传闻求证——小道消息要有鼻子有眼但留不确定性' },
  { id: 'craft', label: '丹器比试', guide: '丹方斗法、法器开炉、符箓比试——行家点评与外行看热闹' },
  { id: 'chaos', label: '怪谈水楼', guide: '夜谈怪谈、无厘头水帖、谜语人——盖楼水经验，越水越欢乐' },
];

export const TIEBA_THEMES_WX: readonly SocialTheme[] = [
  { id: 'help', label: '武学切磋', guide: '功法选择、站桩心得、求支招——帖子短平快，评论区热心或跑题' },
  { id: 'witness', label: '镖路见闻', guide: '镖队劫案、行路见闻、亲历爆料——有鼻子有眼但留不确定性，蹲一个亲历者现身' },
  { id: 'price', label: '市井物价', guide: '米价盐价、新铺开张、黑店避雷——掏铜板的喜怒哀乐，要具体到东西和价' },
  { id: 'gossip', label: '门派八卦', guide: '门派恩怨、大比传闻、求证——小道消息要有鼻子有眼但留不确定性' },
  { id: 'duel', label: '比武赌局', guide: '擂台赛、赌盘赔率、名次爆冷——武人论高下，堂友论输赢' },
  { id: 'chaos', label: '酒楼怪谈', guide: '夜谈怪谈、无厘头水帖、谜语人——盖楼水阅历，越水越欢乐' },
];

export const TIEBA_THEMES_FT: readonly SocialTheme[] = [
  { id: 'help', label: '委托互助', guide: '委托怎么接、地城路线、求支招——帖子短平快，评论区热心或跑题' },
  { id: 'witness', label: '地城见闻', guide: '遗迹见闻、亲历爆料、异象传闻——有鼻子有眼但留不确定性，蹲一个亲历者现身' },
  { id: 'price', label: '集市物价', guide: '装备价、新铺开张、黑店避雷——掏金币的喜怒哀乐，要具体到东西和价' },
  { id: 'gossip', label: '行会八卦', guide: '行会摩擦、榜单争议、传闻求证——小道消息要有鼻子有眼但留不确定性' },
  { id: 'duel', label: '斗法比试', guide: '擂台赛、赌盘赔率、名次爆冷——武人论高下，会众论输赢' },
  { id: 'chaos', label: '旅人怪谈', guide: '夜谈怪谈、无厘头水帖、谜语人——盖楼水功勋，越水越欢乐' },
];

/** 小红书种草题材池风格覆盖（docs/15 §4：抽 2 注入机制同现代池）。 */
export const XHS_THEMES_XX: readonly SocialTheme[] = [
  { id: 'food', label: '坊市探铺', guide: '苍蝇馆子/网红铺/夜市攻略——人均灵石、排队时长、必点清单、避雷项，细节到菜名' },
  { id: 'fashion', label: '洞府布置', guide: '洞府装修/阵法氛围/平价替代——3件套清单、方位参考、铺子式描述' },
  { id: 'guide', label: '修炼攻略', guide: '突破境界/灵田打理/考核经验——「保姆级」「抄作业」式干货，步骤化罗列' },
  { id: 'avoid', label: '丹服测评', guide: '养气丹/驻颜丹亲测对比、真假灵物——有理有据的劝退或安利，评论区有人反驳有人附和' },
  { id: 'goods', label: '平价好物', guide: '符纸/法器/灵宠用品——「真香」「码住」式种草，价格+使用感受' },
  { id: 'daily', label: '日常心境', guide: '修真碎片/洞府日常/深夜emo——氛围感文字+随手留影，共鸣向' },
];

export const XHS_THEMES_WX: readonly SocialTheme[] = [
  { id: 'food', label: '客栈评测', guide: '苍蝇馆子/老字号/夜市攻略——人均银两、排队时长、必点清单、避雷项，细节到菜名' },
  { id: 'fashion', label: '穿戴易容', guide: '易容改装/发髻行头/平价替代——3套式清单、身形参考、铺子式描述' },
  { id: 'guide', label: '行旅攻略', guide: '行商路线/镖路/比武经验——「保姆级」「抄作业」式干货，步骤化罗列' },
  { id: 'avoid', label: '避雷亲测', guide: '千万别住/亲测踩雷/真假对比——有理有据的劝退，评论区有人反驳有人附和' },
  { id: 'goods', label: '好物分享', guide: '兵器/行囊/坐骑用品——「真香」「码住」式种草，价格+使用感受' },
  { id: 'daily', label: '日常情绪', guide: '江湖碎片/客栈日常/深夜独酌——氛围感文字+随手写真，共鸣向' },
];

export const XHS_THEMES_FT: readonly SocialTheme[] = [
  { id: 'food', label: '酒馆评测', guide: '苍蝇酒馆/网红酒馆/夜市攻略——人均金币、排队时长、必点清单、避雷项，细节到菜名' },
  { id: 'fashion', label: '装备穿搭', guide: '法袍穿搭/附魔/平价替代——3套式清单、身形参考、铺子式描述' },
  { id: 'guide', label: '冒险攻略', guide: '地城路线/委托经验/升级指南——「保姆级」「抄作业」式干货，步骤化罗列' },
  { id: 'avoid', label: '避雷亲测', guide: '千万别买/亲测踩雷/真假对比——有理有据的劝退，评论区有人反驳有人附和' },
  { id: 'goods', label: '好物分享', guide: '魔药/卷轴/魔宠用品——「真香」「码住」式种草，价格+使用感受' },
  { id: 'daily', label: '日常情绪', guide: '冒险碎片/营地日常/烛光emo——氛围感文字+随手记影，共鸣向' },
];

/** 朋友圈/贴吧/小红书题材池按风格取用（docs/15 §4）。 */
export function momentsThemesOf(style: PhoneStyle): readonly SocialTheme[] {
  return style === 'xianxia' ? MOMENT_THEMES_XX : style === 'wuxia' ? MOMENT_THEMES_WX : style === 'fantasy' ? MOMENT_THEMES_FT : MOMENT_THEMES;
}

export function tiebaThemesOf(style: PhoneStyle): readonly SocialTheme[] {
  return style === 'xianxia' ? TIEBA_THEMES_XX : style === 'wuxia' ? TIEBA_THEMES_WX : style === 'fantasy' ? TIEBA_THEMES_FT : TIEBA_THEMES;
}

export function xhsThemesOf(style: PhoneStyle): readonly SocialTheme[] {
  return style === 'xianxia' ? XHS_THEMES_XX : style === 'wuxia' ? XHS_THEMES_WX : style === 'fantasy' ? XHS_THEMES_FT : XHS_THEMES;
}

/** 小红书种草题材池（每次刷新随机抽 2 个注入）。 */
export const XHS_THEMES: readonly SocialTheme[] = [
  { id: 'food', label: '探店觅食', guide: '苍蝇馆子/网红店/夜市攻略——人均价格、排队时长、必点清单、避雷项，细节到菜名' },
  { id: 'fashion', label: '穿搭美妆', guide: '通勤穿搭/小个子/平价替代——3套式清单、身高体重参考、链接式描述' },
  { id: 'guide', label: '攻略清单', guide: '周末去哪儿/旅游路线/考试经验——「保姆级」「抄作业」式干货，步骤化罗列' },
  { id: 'avoid', label: '避雷测评', guide: '千万别去/亲测踩雷/真假对比——有理有据的劝退，评论区有人反驳有人附和' },
  { id: 'goods', label: '好物分享', guide: '独居好物/宿舍神器/平价宝藏——「真香」「码住」式种草，价格+使用感受' },
  { id: 'daily', label: '日常与情绪', guide: '生活碎片/自习室vlog/深夜emo——氛围感文字+随手拍，共鸣向' },
];

/** 题材抽签（复用 pickRandom；朋友圈/小红书抽 2 个，贴吧/微博抽 1 个）。 */
export function pickSocialThemes(pool: readonly SocialTheme[], count: number, rand: () => number = Math.random): SocialTheme[] {
  return pickRandom(pool, count, rand);
}

// ─── 反AI腔禁词表 / 发帖人配比条款（定义在 social-prompt-templates，顶部已转出） ───


// ─── 绿灯触发文本 ───

export interface SocialTriggerArgs {
  /** 参与扫描的联系人名（引擎每次随机抽 N 个——轮换激活不同角色条目，其余名字触发不了绿灯就是纯噪音）。 */
  authors: string[];
  /** 最新 1 层正文（过上下文标签剥离，全量参与扫描）。 */
  storyText: string;
  /** 本次抽中的关注焦点名（关注角色名进扫描——激活其世界书条目，发帖质量提升的机制基础）。 */
  followNames?: string[];
}

/** 绿灯触发文本（position:'none' + should_scan:true；只参与世界书扫描，不进提示词）。 */
export function buildSocialTriggerText(args: SocialTriggerArgs): string {
  return [args.authors.join(' '), (args.followNames || []).join(' '), args.storyText].map(p => (p || '').trim()).filter(Boolean).join(' ');
}

// ─── 关注焦点（模仿世界演化「焦点子集」：每次生成随机抽 ≤3 个关注对象，不全量注入） ───

/** 本次生成随机抽 ≤3 个关注焦点（贴吧=关注吧 / 微博=关注博主 / 小红书=关注作者；朋友圈无关注域返回空）。 */
export function pickFollowFocuses(follows: SocialFollows | undefined, kind: SocialKind, rand: () => number = Math.random): string[] {
  const list = kind === 'tieba' ? follows?.bars : kind === 'weibo' ? follows?.weibo : kind === 'xhs' ? follows?.xhs : undefined;
  return list && list.length ? pickRandom(list, 3, rand) : [];
}

// ─── 待反馈互动上下文（引擎按 pending 动作解析出帖子全文/现有评论后拼装，触发与资料块共用） ───

export interface SocialPendingPostContext {
  target: SocialKind;
  postId: string;
  /** 贴主名（匿名帖=匿名网名）。 */
  author: string;
  /** 该帖是用户匿名帖（存在即匿名；其身份对 AI 侧角色未知）。 */
  anon?: true;
  /** 主贴发帖时间标签。 */
  postTime: string;
  /** 主贴文本（朋友圈=正文；贴吧=标题+正文；微博=博文（含转发）；小红书=标题+正文）。 */
  postText: string;
  /** 主贴配图描述（可空）。 */
  imageDesc?: string;
  /** 该帖全部现有评论（含主角自己那条——AI 需要知道回应谁）。 */
  comments: SocialComment[];
  /** 用户在此帖上的待反馈动作。 */
  actions: SocialUserAction[];
}

/** 动作的人读描述（点赞无 content，落成「点赞了」；时间=规范绝对故事时间全文，无戳回退原文快照）。 */
function actionLine(action: SocialUserAction): string {
  const act = action.type === 'like' ? '点赞了'
    : action.type === 'post' ? '发了帖'
      : action.type === 'repost' ? `转发了并说：「${action.content}」`
        : action.type === 'reply' ? `回复 ${action.replyTo || '评论'}：「${action.content}」`
          : `评论：「${action.content}」`;
  const when = action.storyStamp ? (formatStampFull(action.storyStamp) || action.time) : (action.time || '刚刚');
  return `${act}（${when}）`;
}

function commentLine(c: SocialComment): string {
  const reply = c.replyTo ? `（回复 ${c.replyTo}）` : '';
  return `${c.name}${reply}：${c.text}${c.time ? `（${c.time}）` : ''}`;
}

/**
 * 匿名动作行（用户以匿名网名做的动作）。ownPost=该帖本身就是匿名帖——◇ 行已写明楼主网名故不重复；
 * 时间口径与 actionLine 逐字同源。
 */
function anonActionLine(action: SocialUserAction, ownPost: boolean): string {
  const act = action.type === 'like' ? '点赞了'
    : action.type === 'post' ? '发帖'
      : action.type === 'repost' ? `转发并说：「${action.content}」`
        : action.type === 'reply' ? `回复 ${action.replyTo || '评论'}：「${action.content}」`
          : `评论：「${action.content}」`;
  const when = action.storyStamp ? (formatStampFull(action.storyStamp) || action.time) : (action.time || '刚刚');
  return `${ownPost ? '' : `匿名账号「${action.anon}」`}${act}（${when}）`;
}

/** 匿名条目纪律（贴在匿名段头，逐帖不重复）。 */
const ANON_PENDING_RULE = '发帖/评论人身份未知的匿名网友，不得推断、猜测、暗示或点破其真实身份，一律按对陌生网友的态度回应——规则见指令';

/** 绿灯触发的互动段：贴主名 + 主贴文本 + 现有评论 + 用户动作内容（全部参与扫描，保证回应条目被激活）。 */
export function buildSocialPendingTriggerText(contexts: SocialPendingPostContext[]): string {
  return contexts.map(ctx => [
    ctx.author,
    ctx.postText,
    ...ctx.comments.map(c => c.text),
    ...ctx.actions.map(a => (a.type === 'post' ? a.content : a.type === 'like' ? '' : a.content)),
  ].map(p => (p || '').trim()).filter(Boolean).join(' ')).join(' ');
}

/**
 * 资料块的待反馈互动段（发给 AI：帖子全文 + 全部现有评论 + 动作，保证回应针对性）。
 * 匿名条目单列一段（■ 匿名账号动态）：不落进「主角动作」框，避免模型把匿名发言算作主角所为；
 * 实名条目段逐字维持原口径。
 */
export function buildSocialPendingDossierSection(contexts: SocialPendingPostContext[], style: PhoneStyle = ''): string {
  const named = contexts.filter(c => !c.anon);
  const anon = contexts.filter(c => c.anon);
  const sections: string[] = [];
  if (named.length) {
    const hasAnonAction = named.some(c => c.actions.some(a => a.anon));
    const blocks = named.map(ctx => {
      const lines = [
        `◇ ${kindNoun(ctx.target, style)} ${ctx.postId}（${ctx.author}，发帖于 ${ctx.postTime}）：${ctx.postText}`,
      ];
      if (ctx.imageDesc) lines.push(`　帖子配图：${ctx.imageDesc}`);
      if (ctx.comments.length) lines.push(`　现有评论：${ctx.comments.map(commentLine).join('；')}`);
      const mine = ctx.actions.filter(a => !a.anon);
      const anonymous = ctx.actions.filter(a => a.anon);
      if (mine.length) lines.push(`　主角动作：${mine.map(actionLine).join('；')}`);
      if (anonymous.length) lines.push(`　匿名动作（${ANON_PENDING_RULE}）：${anonymous.map(a => anonActionLine(a, false)).join('；')}`);
      return lines.join('\n');
    });
    sections.push(`${hasAnonAction ? '■ 待反馈的用户互动（需要相关角色回应——规则见指令）' : '■ 待反馈的用户互动（主角的动作，需要相关角色回应——规则见指令）'}\n${blocks.join('\n')}`);
  }
  if (anon.length) {
    const blocks = anon.map(ctx => {
      const lines = [
        `◇ ${kindNoun(ctx.target, style)} ${ctx.postId}（匿名楼主「${ctx.author}」，发帖于 ${ctx.postTime}）：${ctx.postText}`,
      ];
      if (ctx.imageDesc) lines.push(`　帖子配图：${ctx.imageDesc}`);
      if (ctx.comments.length) lines.push(`　现有评论：${ctx.comments.map(commentLine).join('；')}`);
      lines.push(`　匿名动作：${ctx.actions.map(a => anonActionLine(a, true)).join('；')}`);
      return lines.join('\n');
    });
    sections.push(`■ 匿名账号动态（${ANON_PENDING_RULE}）\n${blocks.join('\n')}`);
  }
  return sections.join('\n\n');
}

// ─── 资料块 ───

/** 资料块注入的发帖人档案上限（token 控制：恋爱对象优先，超出截断；白名单过滤不受影响）。 */
export const SOCIAL_DOSSIER_AUTHOR_CAP = 12;

/** 已有内容摘要上限（防重复参考）。 */
export const SOCIAL_DIGEST_LIMIT = 12;

/** 平台 → 人读名词。 */
export const KIND_NOUNS: Record<SocialKind, string> = {
  moments: '朋友圈动态',
  tieba: '贴吧帖子',
  weibo: '微博博文',
  xhs: '小红书笔记',
};

/** 平台人读名词按风格取用（docs/15 §3.4：仙侠=百晓阁风闻/论道坛帖/云笈录/浮生帖；武侠/西幻同构）。 */
export function kindNoun(kind: SocialKind, style: PhoneStyle): string {
  if (style === 'xianxia') {
    if (kind === 'weibo') return '百晓阁风闻';
    if (kind === 'tieba') return '论道坛帖';
    if (kind === 'xhs') return '云笈录';
    return '浮生帖';
  }
  if (style === 'wuxia') {
    if (kind === 'weibo') return '茶馆风声';
    if (kind === 'tieba') return '英雄楼帖';
    if (kind === 'xhs') return '风物图志';
    return '故人笺';
  }
  if (style === 'fantasy') {
    if (kind === 'weibo') return '诗社见闻';
    if (kind === 'tieba') return '行会榜文';
    if (kind === 'xhs') return '藏宝图鉴';
    return '篝火手记';
  }
  return KIND_NOUNS[kind];
}

/**
 * 待反馈动作涉及的混合记录服务对象（并集口径，用户定案）：
 * 贴主必带；回复动作追加被回复者；主角自己的发帖动作没有特定对象，按刷新触发同款
 * 「通讯录随机 N 人」覆盖（谁可能回应谁就有上下文）。路人网名（非通讯录）会自然贡献零记录，无害。
 */
export function pendingInvolvedNames(
  contexts: SocialPendingPostContext[],
  contactNames: string[],
  me: string,
  rand: () => number = Math.random,
): string[] {
  const set = new Set<string>();
  for (const ctx of contexts) {
    if (ctx.author && ctx.author !== me) set.add(ctx.author);
    for (const a of ctx.actions) {
      if (a.type === 'reply' && a.replyTo && a.replyTo !== me) set.add(a.replyTo);
      if (a.type === 'post') for (const n of pickRandom(contactNames, 3, rand)) set.add(n);
    }
  }
  return [...set];
}

export interface SocialDossierArgs {
  roster: RosterSnapshot;
  kind: SocialKind;
  /** 发帖人白名单（=roster 通讯录全员；档案段按上限截断）。 */
  authors: string[];
  /** 剧情纪要块（空串=不带该段）。 */
  chronicleBlocks: string;
  /** 最近 N 层 AI 回复（过上下文标签剥离；空串=不带正文）。 */
  storyText: string;
  /** 各平台已有内容（防重复摘要；只取本平台）。 */
  oldMoments: MomentPost[];
  oldTieba: TiebaPost[];
  oldWeibo: WeiboPost[];
  oldXhs: XhsNote[];
  /** 待反馈互动上下文（非空时追加互动段；主动求回应请求必带，刷新累积时带本平台动作）。 */
  pending?: SocialPendingPostContext[];
  /** 混合记录服务对象（涉及人物并集；与 mixedRecords 成对出现）。 */
  mixedNames?: string[];
  /** 最近手机记录混合块（涉及人物的微信消息/通话/朋友圈与社媒帖子/群聊块；已排除待反馈的帖子）。 */
  mixedRecords?: MixedRecords;
  /** 本次抽中的关注焦点（≤3 个关注对象名；非空时输出「关注焦点」段）。 */
  socialFocus?: string[];
  /** 已有吧名列表（仅贴吧关键词搜索传：结果页帖子的 bar 只能取自这里，定点刷新不重写吧表）。 */
  barNames?: string[];
  /** 界面风格（仙侠=百晓阁措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
}

function socialDigest(lines: string[]): string {
  return lines.slice(0, SOCIAL_DIGEST_LIMIT).join('\n');
}

/** 资料块（after_system + should_scan:false 注入）。 */
export function buildSocialDossierText(args: SocialDossierArgs): string {
  const sections: string[] = ['【社媒资料参考（供保持人物与世界一致，非剧中人所知）】'];
  const g = args.roster.global;
  const envParts = [
    g.location ? `地点：${g.location}` : '',
    g.time ? `时间：${g.time}` : '',
  ].filter(Boolean);
  if (envParts.length) sections.push(`■ 当前位置与时间\n${envParts.join('　')}`);
  if (args.chronicleBlocks) {
    sections.push(`■ 剧情纪要（从旧到新，供衔接故事过往）\n${args.chronicleBlocks}`);
  }
  // 档案段：恋爱对象优先截断（白名单不变，仅风格参考收窄——定向角色注入手法）
  const ordered = [...args.authors];
  const dossierAuthors = ordered.slice(0, SOCIAL_DOSSIER_AUTHOR_CAP);
  sections.push(`■ 发帖人档案（数据库表格${ordered.length > dossierAuthors.length ? `，共 ${ordered.length} 人仅列前 ${dossierAuthors.length} 人` : ''}）\n${dossierAuthors.map(m => contactSection(args.roster, m)).join('\n')}`);
  const relations = relationSection(args.roster, [args.roster.protagonistName, ...ordered]);
  sections.push(`■ 人物关系（与主角及彼此）\n${relations}`);
  if (args.storyText) {
    sections.push(`■ 最近正文进展（供衔接剧情）\n${args.storyText}`);
  }
  const digestTitle = '■ 已有内容摘要（选题撞车一律换新）';
  if (args.socialFocus?.length) {
    sections.push(`■ 关注焦点（主角已关注的${s(args.style || '', '账号/吧', '结交的号/阁', '结识的号/堂', '同路的号/社')}；本次生成推荐至少覆盖其中 1 个）\n${args.socialFocus.join('、')}`);
  }
  if (args.barNames?.length) {
    sections.push(`■ 已有${s(args.style || '', '吧', '坛', '堂', '行会')}列表（搜索结果的帖子 bar 只能取自这些，选兴趣气质最贴合关键词的）\n${args.barNames.join('、')}`);
  }
  if (args.kind === 'moments') {
    const digest = socialDigest(args.oldMoments.map(p => `${p.author}：${p.text.slice(0, 24)}`));
    if (digest) sections.push(`${digestTitle}\n${digest}`);
  } else if (args.kind === 'tieba') {
    const digest = socialDigest(args.oldTieba.filter(p => !p.pinned).map(p => `${p.author}：${p.title}`));
    if (digest) sections.push(`${digestTitle}\n${digest}`);
  } else if (args.kind === 'weibo') {
    const digest = socialDigest(args.oldWeibo.map(p => `${p.author}：${p.text.slice(0, 24)}`));
    if (digest) sections.push(`${digestTitle}\n${digest}`);
  } else {
    const digest = socialDigest(args.oldXhs.map(p => `${p.author}：${p.title}`));
    if (digest) sections.push(`${digestTitle}\n${digest}`);
  }
  // 混合记录段（涉及互动反馈时）：段头写明服务对象，防止与发帖素材混淆
  if (args.mixedRecords?.body) {
    const names = (args.mixedNames || []).join('、');
    const scope = s(args.style || '',
      `与${names}相关的微信消息/通话/朋友圈与社媒帖子`,
      `与${names}相关的符讯/传音/百晓阁风闻`,
      `与${names}相关的书信/传声/茶馆风声`,
      `与${names}相关的晶讯/远语/诗社见闻`);
    sections.push(`■ 最近手机记录（最近 ${args.mixedRecords.units} 条，从旧到新：${scope}——生成下方互动回应时，注意衔接与这些角色的近期互动）\n${args.mixedRecords.body}`);
  }
  if (args.pending?.length) {
    sections.push(buildSocialPendingDossierSection(args.pending, args.style || ''));
  }
  return sections.join('\n\n');
}

// ─── 反馈规则与格式（刷新累积与主动求回应共用——增量协议） ───

/** 反馈规则（只列涉及平台的条目；moments 条目带 likes，其余平台点赞是计数只回评论）。
 *  hasAnonymous=本次待反馈含匿名条目时追加匿名例外条款（角色不知匿名网友是谁）。 */
export function buildSocialFeedbackRules(targets: SocialKind[], me: string, style: PhoneStyle = '', hasAnonymous = false): string {
  const anonClause = hasAnonymous
    ? ' 匿名例外：资料块「匿名账号动态」中的条目与标注「匿名动作」的动作来自身份未知的匿名网友（匿名楼主/匿名评论者）——回应一律按对陌生网友的态度（好奇、附和、抬杠、追问皆可），严禁推断、猜测、暗示或点破其真实身份，严禁按对主角的称谓与语气，不得暗示此事与主角有关。'
    : '';
  const lines = [
    `1. 资料块「待反馈的用户互动」中列出的每个帖子，贴主必须对主角的动作作出回应：主角评论过的就回复主角，回应要贴着评论/帖子的具体内容，符合各自性格、口癖与对主角的态度；主角只点过赞的，贴主可顺带回应也可不理（不强求）。${anonClause}`,
    `2. 除贴主外，其他角色或路人可跟评 0-2 条，不强求每帖都有；名单内角色一律用真实姓名回应，禁止另起网名；严禁以 ${me}（{{user}}）${hasAnonymous ? '、匿名网名' : ''}或任何用户身份发言——主角的评论和帖子前端已自行插入，你只生成其他人的回应。`,
    '3. 禁止重复输出已有评论（资料块「现有评论」里的都不许再出）；每帖回应 1-3 条，短、锐、具体，有网感，允许调侃/追问/阴阳。',
    '4. feedback 里每条回应的 t 写回应时间：填绝对时间（年月日+时刻，如「2026年9月2日 21:30」——把资料块「当前位置与时间」的当前时间往回推），必须晚于被回应内容的时间且不晚于当前时间；禁止一切相对措辞（相对化只在界面渲染层做）；禁止现实年份与日期。',
  ];
  if (targets.includes('moments')) lines.push(s(style,
    '5. 朋友圈条目：回应进 comments（回复主角评论时 reply 指向主角或被回复人名），点赞人名进 likes。',
    '5. 浮生帖条目：回应进 comments（回复主角评论时 reply 指向主角或被回复人名），道好人名进 likes。',
    '5. 故人笺条目：回应进 comments（回复主角留话时 reply 指向主角或被回复人名），称善人名进 likes。',
    '5. 篝火手记条目：回应进 comments（回复主角附言时 reply 指向主角或被回复人名），喝彩人名进 likes。'));
  if (targets.includes('tieba')) lines.push(s(style,
    '5. 贴吧条目：楼主或其他吧友的回应进 comments（回复主角楼层时 reply 指向主角或被回复人名），像盖楼跟帖一样自然；贴吧不带 likes。',
    '5. 论道坛条目：楼主或其他坛友的回应进 comments（回复主角楼层时 reply 指向主角或被回复人名），像盖楼跟帖一样自然；论道坛不带 likes。',
    '5. 英雄楼条目：楼主或其他堂友的回应进 comments（回复主角楼层时 reply 指向主角或被回复人名），像盖楼跟帖一样自然；英雄楼不带 likes。',
    '5. 行会大厅条目：楼主或其他会众的回应进 comments（回复主角楼层时 reply 指向主角或被回复人名），像盖楼跟帖一样自然；行会大厅不带 likes。'));
  if (targets.includes('weibo')) lines.push(s(style,
    '5. 微博条目：博主或评论者的回应进 comments（reply 指向被回复人名）；主角转发过的博文，原博主可在评论区回应也可不理；微博不带 likes。',
    '5. 百晓阁条目：报信人或议论者的回应进 comments（reply 指向被回复人名）；主角传抄过的风闻，原报信人可在议论区回应也可不理；百晓阁不带 likes。',
    '5. 悦来茶馆条目：茶客或搭话者的回应进 comments（reply 指向被回复人名）；主角转述过的茶帖，原茶客可在搭话区回应也可不理；茶馆不带 likes。',
    '5. 吟游诗社条目：旅人或应和者的回应进 comments（reply 指向被回复人名）；主角传唱过的见闻，原作者可在应和区回应也可不理；诗社不带 likes。'));
  if (targets.includes('xhs')) lines.push(s(style,
    '5. 小红书条目：笔记作者或评论者的回应进 comments（回复主角评论时 reply 指向主角或被回复人名），语气热情像姐妹聊天；小红书不带 likes。',
    '5. 云笈录条目：献笈人或评论者的回应进 comments（回复主角评论时 reply 指向主角或被回复人名），语气热情像同好闲聊；云笈录不带 likes。',
    '5. 风物志条目：采风人或评论者的回应进 comments（回复主角留话时 reply 指向主角或被回复人名），语气热情像江湖同行搭腔；风物志不带 likes。',
    '5. 藏宝图鉴条目：编纂者或评论者的回应进 comments（回复主角附言时 reply 指向主角或被回复人名），语气热情像冒险同伴应和；藏宝图鉴不带 likes。'));
  return lines.join('\n');
}

/** feedback 字段格式说明（统一 target+postId 定位，跨平台累积时同一数组混排）。 */
export function buildSocialFeedbackFormat(): string {
  return `"feedback":[{"target":"moments|tieba|weibo|xhs","postId":"帖子id","likes":["点赞人名（仅moments）"],"comments":[{"name":"回应人","c":"回应内容（10-40字）","reply":"被回复人名（顶层省略）","t":"回应时间"}]}]（贴吧/微博/小红书条目省略 likes）`;
}

// ─── 指令模板（user_input） ───
// 模板本体（40 套 = 平台 × 风格 × 指令分支）在 social-prompt-templates；本层只做三件事：
// ① 解析命中的分支 → 取覆盖文本（用户自定义优先）或内置默认；② 算占位符取值；③ 交给渲染器。
// 分支优先级与旧实现逐字一致（贴吧 吧内>跨吧搜索；微博 作者主页>话题页；小红书 作者主页>关键词；朋友圈仅整版）。

export interface SocialInstructionArgs {
  roster: RosterSnapshot;
  kind: SocialKind;
  /** 本次抽中的题材。 */
  themes: SocialTheme[];
  /** 用户额外要求（设置页，可为空）。 */
  extraPrompt: string;
  /** 本平台待反馈互动（非空时指令追加反馈规则+格式）。 */
  pending?: SocialPendingPostContext[];
  /** 定点刷新范围（贴吧=指定吧内刷新/跨吧关键词搜索；微博=指定话题页/作者主页刷新；小红书=搜索话题/作者主页；缺省=整版）。 */
  focus?: { bar?: string; topic?: string; author?: string; keyword?: string };
  /** 本次抽中的关注焦点（≤3 个关注对象名；非空时资料块加「关注焦点」段+指令加保守覆盖条款）。 */
  socialFocus?: string[];
  /** 界面风格（仙侠=百晓阁措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
  /** 用户自定义提示词（设置→功能→社媒→「社媒提示词」；键=kind:style:branch；空/缺省=用内置默认）。 */
  promptOverrides?: Record<string, string>;
}

/**
 * 配图主体要求（用户定案：画面里出现谁改由配图描述文字承载，相册条目 characters 只记发帖人）。
 * 追加在各平台配图/封面规则句末；「自拍」类词按皮肤风格取用，避免现代词进古风指令
 * （相册图发出去时另由 forward-model.composeImageDesc 前置「发帖人+来源App」出处）。
 */
function imageSubjectRule(style: PhoneStyle | undefined): string {
  return s(style || '',
    '画面描述必须点明主体：是发帖人自己（自拍/自己拍的）就写明，画面里出现其他角色就写出其角色名；纯景物照写清环境即可。',
    '画面描述必须点明主体：是发帖人自己（自照留影/自己留下的影）就写明，画面里出现其他角色就写出其角色名；纯景物照写清环境即可。',
    '画面描述必须点明主体：是发帖人自己（自摄写真/自己摄下的真）就写明，画面里出现其他角色就写出其角色名；纯景物照写清环境即可。',
    '画面描述必须点明主体：是发帖人自己（自记影像/自己记下的影）就写明，画面里出现其他角色就写出其角色名；纯景物照写清环境即可。',
  );
}

/** 定点值归一化（口径与旧分支逐字一致：贴吧关键词不剥 #，话题/小红书关键词剥首尾 #；长度上限同旧值）。 */
function focusValues(kind: SocialKind, focus: SocialInstructionArgs['focus']): { bar: string; keyword: string; topic: string; author: string } {
  const t = (v?: string) => (v || '').trim();
  return {
    bar: t(focus?.bar).slice(0, 24),
    keyword: (kind === 'tieba' ? t(focus?.keyword) : t(focus?.keyword).replace(/^#|#$/g, '')).slice(0, 40),
    topic: t(focus?.topic).replace(/^#|#$/g, '').slice(0, 40),
    author: t(focus?.author).slice(0, 24),
  };
}

/** 命中的指令分支。 */
export function socialBranchOf(kind: SocialKind, focus: SocialInstructionArgs['focus']): SocialBranchKey {
  const f = focusValues(kind, focus);
  if (kind === 'tieba') return f.bar ? 'bar' : f.keyword ? 'keyword' : 'default';
  if (kind === 'weibo') return f.author ? 'author' : f.topic ? 'topic' : 'default';
  if (kind === 'xhs') return f.author ? 'author' : f.keyword ? 'keyword' : 'default';
  return 'default';
}

// ─── 占位符取值 ───

/** 待反馈段首句（按平台×风格取词；微博作者主页分支无「除新X外」前缀——旧实现如此）。 */
const PENDING_HEADS: Record<string, string> = {
  'moments:modern': '除新动态外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'moments:xianxia': '除新近况外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'moments:wuxia': '除新笺外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'moments:fantasy': '除新手记外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'tieba:modern': '除新帖外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'tieba:xianxia': '除新帖外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'tieba:wuxia': '除新帖外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'tieba:fantasy': '除新帖外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'weibo:modern': '除新博文外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'weibo:xianxia': '除新风闻外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'weibo:wuxia': '除新风声外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'weibo:fantasy': '除新见闻外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'xhs:modern': '除新笔记外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'xhs:xianxia': '除新云笈外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'xhs:wuxia': '除新图志外，同时输出 feedback 字段回应资料块中列出的主角动作：',
  'xhs:fantasy': '除新图鉴外，同时输出 feedback 字段回应资料块中列出的主角动作：',
};
const PENDING_HEAD_AUTHOR = '同时输出 feedback 字段回应资料块中列出的主角动作：';

/** 关注焦点条款（编号按旧口径：贴吧 定点=10/整版=11；微博 12；小红书 11）。 */
function followRuleOf(kind: SocialKind, style: PhoneStyle | undefined, branch: SocialBranchKey, socialFocus: readonly string[] | undefined): string {
  if (!socialFocus?.length || kind === 'moments') return '';
  const styleKey = socialStyleKeyOf(style);
  const names = socialFocus.join('」「');
  if (kind === 'tieba') {
    const unit = s(style || '', '吧', '坛', '堂', '行会');
    return `\n${branch === 'default' ? 11 : 10}. 推荐至少 1 条新帖来自${styleKey === 'modern' ? '已关注' : '已结交'}的${unit}「${names}」（资料块「关注焦点」）。`;
  }
  if (kind === 'weibo') {
    const noun = s(style || '', '博文', '风闻', '茶帖', '见闻');
    const who = s(style || '', '博主', '报信人', '茶客', '旅人');
    return `\n12. 推荐至少 1 条${noun}来自已关注的${who}（资料块「关注焦点」）。`;
  }
  const noun = s(style || '', '笔记', '云笈', '图志', '图鉴');
  return `\n11. 推荐至少 1 篇${noun}来自${styleKey === 'modern' ? '已关注' : '已结交'}的作者（资料块「关注焦点」）。`;
}

/** 待反馈含匿名条目判定（匿名帖本身 or 匿名动作；两处口径唯一）。 */
export function hasAnonymousPending(pending?: readonly SocialPendingPostContext[]): boolean {
  return Boolean(pending?.some(c => c.anon || c.actions.some(a => a.anon)));
}

/** 占位符取值表（键=模板里的 {{占位符}} 名）。 */
function socialPromptVarsOf(kind: SocialKind, branch: SocialBranchKey, args: SocialInstructionArgs): SocialPromptVars {
  const me = args.roster.protagonistName;
  const f = focusValues(kind, args.focus);
  const hasAnon = hasAnonymousPending(args.pending);
  // 选题方向：朋友圈/小红书=抽中 2 个拼接；贴吧/微博=1 个（句号写在模板里，见 40 套模板）
  const theme = (kind === 'moments' || kind === 'xhs')
    ? args.themes.map(t => `「${t.label}」${t.guide}`).join('；')
    : (args.themes[0] ? `「${args.themes[0].label}」${args.themes[0].guide}` : '');
  const headBase = kind === 'weibo' && branch === 'author'
    ? PENDING_HEAD_AUTHOR
    : (PENDING_HEADS[`${kind}:${socialStyleKeyOf(args.style)}`] || '');
  // 有匿名条目时把段首指向扩到匿名段（无匿名=逐字现状）
  const head = hasAnon ? headBase.replace('主角动作', '主角动作与匿名动作') : headBase;
  const pending = args.pending?.length
    ? `\n【待反馈的用户互动】\n${head}\n${buildSocialFeedbackRules([kind], me, args.style, hasAnon)}\n${buildSocialFeedbackFormat()}\n`
    : '';
  const extra = args.extraPrompt.trim() ? `\n\n${args.extraPrompt.trim()}` : '';
  return {
    主角: me,
    选题: theme,
    吧名: f.bar,
    关键词: f.keyword,
    话题: f.topic,
    作者名: f.author,
    关注焦点: followRuleOf(kind, args.style, branch, args.socialFocus),
    待反馈: pending,
    配图要求: imageSubjectRule(args.style),
    生成要求: extra,
    反馈字段: args.pending?.length ? ',"feedback":[…]' : '',
  };
}

/** 渲染一套指令：用户覆盖优先（trim 后为空=用默认），契约段由渲染器统一注入。 */
function renderSocialInstruction(kind: SocialKind, args: SocialInstructionArgs): string {
  const branch = socialBranchOf(kind, args.focus);
  const key = socialPromptKey(kind, args.style, branch);
  const tpl = (args.promptOverrides?.[key] || '').trim() || socialPromptEditableDefault(key);
  return renderSocialPromptTemplate(key, tpl, socialPromptVarsOf(kind, branch, args));
}

/** 朋友圈指令（user_input）。 */
export function buildMomentsInstruction(args: SocialInstructionArgs): string {
  return renderSocialInstruction('moments', args);
}

/** 贴吧指令（user_input；focus.bar=吧内定点刷新，focus.keyword=跨吧搜索，省略=整版）。 */
export function buildTiebaInstruction(args: SocialInstructionArgs): string {
  return renderSocialInstruction('tieba', args);
}

/** 微博作者主页指令（定点刷新；等价于 focus.author——保留导出供定点路径直调）。 */
export function buildWeiboAuthorInstruction(args: SocialInstructionArgs, focusAuthor: string): string {
  return renderSocialInstruction('weibo', { ...args, focus: { ...args.focus, author: focusAuthor } });
}

/** 微博指令（user_input；focus.topic=话题页，focus.author=作者主页，省略=整版）。 */
export function buildWeiboInstruction(args: SocialInstructionArgs): string {
  return renderSocialInstruction('weibo', args);
}

/** 小红书指令（user_input；focus.author=作者主页，focus.keyword=关键词搜索，省略=整版）。 */
export function buildXhsInstruction(args: SocialInstructionArgs): string {
  return renderSocialInstruction('xhs', args);
}

export function buildSocialInstruction(args: SocialInstructionArgs): string {
  return renderSocialInstruction(args.kind, args);
}

// ─── 题材池（用户自定义优先） ───

/** 平台内置题材池（现代/仙侠/武侠/西幻）。 */
export function socialThemesOf(kind: SocialKind, style: PhoneStyle): readonly SocialTheme[] {
  if (kind === 'moments') return momentsThemesOf(style);
  if (kind === 'tieba') return tiebaThemesOf(style);
  if (kind === 'weibo') return weiboThemesOf(style);
  return xhsThemesOf(style);
}

/** 平台题材池：用户自定义池优先（空表回落内置默认）。 */
export function socialThemePool(
  kind: SocialKind,
  style: PhoneStyle,
  overrides?: Record<string, ReadonlyArray<SocialTheme>>,
): readonly SocialTheme[] {
  const custom = overrides?.[socialThemeKey(kind, style)];
  return custom && custom.length ? custom : socialThemesOf(kind, style);
}

// ─── 互动反馈指令（顶栏「求回应」主动请求；跨平台累积，只生成回应不出新帖） ───

export interface SocialFeedbackInstructionArgs {
  roster: RosterSnapshot;
  /** 涉及平台（有几个待反馈平台就体现几个平台的规则）。 */
  targets: SocialKind[];
  /** 主角名（=roster.protagonistName，占位符展开前的字面量）。 */
  me: string;
  /** 额外要求（一次性本批提示经 mergeOneShotHint 传入；可为空——本模板不消费全局额外要求）。 */
  extraPrompt?: string;
  /** 界面风格（仙侠=百晓阁措辞；缺省现代=现状逐字）。 */
  style?: PhoneStyle;
  /** 本次待反馈含匿名条目（追加匿名例外条款）。 */
  hasAnonymous?: boolean;
}

/** 互动反馈指令（user_input）：只回应主角动作，不生成新帖——增量协议。 */
export function buildSocialFeedbackInstruction(args: SocialFeedbackInstructionArgs): string {
  const style = args.style || '';
  const targets = args.targets.map(t => kindNoun(t, style)).join('和');
  const extra = (args.extraPrompt || '').trim() ? `\n\n${args.extraPrompt!.trim()}` : '';
  return `【任务】模拟社媒互动反馈。${args.me}（即 {{user}}，我方）刚在${s(style,
    '手机的', '传讯玉简的', '天机匣的', '传讯水晶的')}${targets}上做了动作（${s(style,
    '发帖/点赞/评论/回复/转发',
    '投帖/喝彩/议论/回话/传抄',
    '投帖/叫好/搭话/回话/转述',
    '投稿/喝彩/应和/回话/传唱')}），具体见资料块「待反馈的用户互动」。请生成相关角色的回应——像${s(style,
    '熟人刷到后随手回复', '道友见闻后随手回话', '茶客听罢随口搭话', '同伴听闻随手应和')}那样自然，只生成回应，不要生成任何新动态或新帖子。
【回应规则】
${buildSocialFeedbackRules(args.targets, args.me, style, args.hasAnonymous)}

【输出格式】（严格遵守）
只输出一个 ${SOCIAL_OPEN_TAG} 块，块外不要有任何文字，块内是一个 JSON 对象：
${SOCIAL_OPEN_TAG}
{${buildSocialFeedbackFormat()}}
${SOCIAL_CLOSE_TAG}

【说人话】回应像真人随口说的：大白话、带情绪、贴着具体内容。${ANTI_AI_WORDS_RULE}${extra}`;
}

// ─── 作者主页资料（1B 型轻量请求：绿灯触发=作者名扫描世界书 + 资料块=含名纪要；生成一次后缓存） ───

// 契约标签集中到 core/protocol-tags（单一事实源）；import 后原样 re-export，既有 import 路径不变。
import { AUTHOR_CLOSE_TAG, AUTHOR_OPEN_TAG } from './protocol-tags';
export { AUTHOR_CLOSE_TAG, AUTHOR_OPEN_TAG };

/** 作者资料指令（user_input）：只生成账号资料 JSON，不出帖。 */
export function buildAuthorProfileInstruction(args: { roster: RosterSnapshot; scope: 'weibo' | 'xhs'; name: string; style?: PhoneStyle }): string {
  const style = args.style || '';
  const me = args.roster.protagonistName;
  const platform = args.scope === 'weibo' ? s(style, '微博', '百晓阁', '悦来茶馆', '吟游诗社')
    : s(style, '小红书', '云笈录', '风物志', '藏宝图鉴');
  const role = args.scope === 'weibo' ? s(style, '博主', '报信人', '茶客', '旅人') : s(style, '作者', '献笈人', '采风人', '编纂者');
  return `【任务】生成${platform}${role}「${args.name}」的账号资料，供 TA 的个人主页展示。${me}（即 {{user}}，我方）刚点进 TA 的主页。

【输出格式】（严格遵守）
只输出一个 ${AUTHOR_OPEN_TAG} 块，块外不要有任何文字，块内是一个 JSON 对象：
${AUTHOR_OPEN_TAG}
{"signature":"一句话签名（≤30字，第一人称口吻）","following":"312","followers":"1.8万","likes":"4.6万","verified":"orange|gold|blue|省略"}
${AUTHOR_CLOSE_TAG}

【规则】
1. signature 贴合该账号的身份、性格与已有帖子风格（资料块有档案就代入角色本人，没有就凭帖风推断其人设）。
2. following/followers/likes 数量级随体量可信（素人几十~几百、活跃账号上千、大V上万），禁止爆表；likes=获赞（与收藏）总数。
  3. ${args.scope === 'weibo' ? 'verified 只给路人博主（orange=个人创作者、gold=高影响力大V、blue=官方机构）；通讯录角色大多是普通人省略。' : s(style,
    '小红书作者不认证，省略 verified。',
    '云笈录作者不认证，省略 verified。',
    '风物志作者不认证，省略 verified。',
    '藏宝图鉴作者不认证，省略 verified。')}
4. 严禁输出 ${me}（{{user}}）或任何用户身份的资料；只输出 JSON，不要解释。`;
}

/** 作者资料资料块（after_system）：时间地点 + 含名纪要 + （路人）已有帖摘要。 */
export function buildAuthorProfileDossier(args: { roster: RosterSnapshot; chronicleBlocks: string; excerpt?: string }): string {
  const g = args.roster.global;
  const sections: string[] = ['【社媒资料参考（供保持人物与世界一致，非剧中人所知）】'];
  const envParts = [g.location ? `地点：${g.location}` : '', g.time ? `时间：${g.time}` : ''].filter(Boolean);
  if (envParts.length) sections.push(`■ 当前位置与时间\n${envParts.join('　')}`);
  if (args.chronicleBlocks) sections.push(`■ 剧情纪要（从旧到新，供了解 TA 的近况）\n${args.chronicleBlocks}`);
  const excerpt = (args.excerpt || '').trim();
  if (excerpt) sections.push(`■ 该账号已有帖子（帖风参考）\n${excerpt}`);
  return sections.join('\n\n');
}

/** 作者资料解析（三级容错：标签→JSON.parse→括号扫描；scope/name 由调用方锚定，防 AI 改名）。 */
export function parseAuthorProfileOutput(text: string): Omit<SocialAuthorProfile, 'scope' | 'name' | 'createdAt'> | null {
  const tagStart = text.indexOf(AUTHOR_OPEN_TAG);
  const tagEnd = text.indexOf(AUTHOR_CLOSE_TAG);
  let raw = tagStart >= 0 && tagEnd > tagStart ? text.slice(tagStart + AUTHOR_OPEN_TAG.length, tagEnd) : text;
  let parsed: Record<string, unknown> | null = null;
  try {
    const obj = JSON.parse(raw.trim());
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj as Record<string, unknown>;
  } catch { /* fallthrough */ }
  if (!parsed) {
    const braceStart = raw.indexOf('{');
    const braceEnd = raw.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      try {
        const obj = JSON.parse(raw.slice(braceStart, braceEnd + 1));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj as Record<string, unknown>;
      } catch { return null; }
    }
  }
  if (!parsed) return null;
  const strOf = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const signature = strOf(parsed.signature, 120);
  const following = strOf(parsed.following, 16);
  const followers = strOf(parsed.followers, 16);
  const likes = strOf(parsed.likes, 16);
  const verified = strOf(parsed.verified, 8);
  if (!signature && !following && !followers && !likes) return null;
  return {
    signature,
    following,
    followers,
    likes,
    ...(verified === 'orange' || verified === 'gold' || verified === 'blue' ? { verified: verified as SocialAuthorProfile['verified'] } : {}),
  };
}
