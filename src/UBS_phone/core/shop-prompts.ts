// ===== 网上商城 · 提示词（docs/52 §4/§5）=====
// 四风格单一事实源（SHOP_STYLE_SPECS）：APP 名 / 刷新动词 / 购物车·订单·店铺·评价·收藏·配送等术语 /
//   空态与生成中文案 / 无货币占位币种名 / 世界观调性 / 物流语境——**渲染层与提示词共用一份**。
// 三段式管线（镜像 browser-engine）：
//   ① 绿灯触发（position:'none' + should_scan）——点了刷新才注入（按钮触发型，零常驻）
//   ② 资料块（after_system）——时间地点 + **货币体系（名/描述/精度；用户定案不注入余额）** +
//      剧情纪要（最新 N 条，不筛主角名）+ 主角档案 + 最近正文进展 + 现有货架名（防重名）+ 现有类别
//   ③ generateRaw 全槽位 + max_chat_history 0（runPhoneRaw）
//
// 另含两块**生图**用件（docs/52 §5，借用主项目衣柜单品方案）：
//   · buildShopItemTagInstruction —— 「商品标签翻译器」：AI 把中文名/描述译成**纯净物件标签**
//     （禁人体词/构图词/框定词/数量词，规则逐条对齐 unified-statusbar/core/wardrobe-prompts 的 itemPromptSystem）；
//   · assembleShopItemDisplayPrompt —— 前端拼装最终主提示词（按供应商格式：NAI 标签行 / 自然语言商品规格），
//     逐条对齐 wardrobe-prompts 的 assembleItemDisplayPrompt（纯白无缝背景 / 无人物 / 无文字 / 商品居中）。
// 纪律：只做要求不做解释；AI 只负责「这个世界卖什么」，措辞与标签形态由本文件固定。

import { contactSection } from './chat-prompts';
import type { PhoneStyle } from './chat-model';
import { s } from './skins';
import type { RosterSnapshot } from './roster';
import { shopTag } from './protocol-tags';
import type { ShopItem } from './shop-model';

export interface ShopStyleSpec {
  /** APP 名（桌面图标 / 页头）。 */
  appName: string;
  /** 刷新动词（按钮 title 与生成中文案）。 */
  refreshVerb: string;
  /** 生成中状态条文案。 */
  generatingText: string;
  /** 空态主文案 / 副文案 / 按钮。 */
  emptyTitle: string;
  emptyText: string;
  emptyAction: string;
  /** 术语（渲染层直接用）。 */
  cartLabel: string;
  orderLabel: string;
  sellerLabel: string;
  reviewLabel: string;
  favoriteLabel: string;
  /** 送货行文案（days=送货天数）。 */
  deliveryText: (days: number) => string;
  /** 「包裹/货」一类名词（送达通知与入库标记用）。 */
  parcelWord: string;
  /** 无货币联动时的占位币种名（可逛不可买；AI 按它定价）。 */
  currencyPlaceholder: string;
  /** 世界观调性一句话（这个世界的商城该卖什么、不该出现什么）。 */
  tone: string;
}

/** 四风格表（单一事实源；提示词与 UI 文案共用）。 */
export const SHOP_STYLE_SPECS: Readonly<Record<string, ShopStyleSpec>> = {
  modern: {
    appName: '网上商城',
    refreshVerb: '刷新',
    generatingText: '掌柜正在上货…',
    emptyTitle: '货架空空如也',
    emptyText: '掌柜还没开张。请他按当前的世界与故事，上一批值得买的好货。',
    emptyAction: '请掌柜上货',
    cartLabel: '购物车', orderLabel: '订单', sellerLabel: '店铺', reviewLabel: '买家评价', favoriteLabel: '收藏',
    deliveryText: days => `预计 ${days} 日内送达`,
    parcelWord: '包裹',
    currencyPlaceholder: '元',
    tone: '现代电商语境：品牌、型号、产地、规格都像真的（如「XX 牌 · 限定款」）；不要摆满超市日用品，'
      + '要摆珍品、限定、黑市货、行家私藏、限量发售这类有来历的货色。',
  },
  xianxia: {
    appName: '万宝阁',
    refreshVerb: '重新采买',
    generatingText: '阁主正在备货…',
    emptyTitle: '阁中空空如也',
    emptyText: '阁主尚未开张。请他依当世风物，采买一批值得入手的好货。',
    emptyAction: '请阁主备货',
    cartLabel: '储物袋', orderLabel: '契书', sellerLabel: '字号', reviewLabel: '道友品评', favoriteLabel: '收进宝囊',
    deliveryText: days => `御剑急送，约 ${days} 日可至`,
    parcelWord: '货',
    currencyPlaceholder: '灵石',
    tone: '仙门坊市语境：法器、丹药、灵材、符箓、典籍、灵宠——品阶、产地、炼制者、年份都要像真的'
      + '（如「药王谷·百草堂」）；不得出现现代名词。',
  },
  wuxia: {
    appName: '悦来商行',
    refreshVerb: '重新张罗',
    generatingText: '掌柜正在张罗…',
    emptyTitle: '货架空空如也',
    emptyText: '掌柜还没开张。请他依江湖行情，张罗一批值得买的好货。',
    emptyAction: '请掌柜开张',
    cartLabel: '货担', orderLabel: '契书', sellerLabel: '商号', reviewLabel: '客官点评', favoriteLabel: '收着',
    deliveryText: days => `镖局押送，约 ${days} 日可到`,
    parcelWord: '货',
    currencyPlaceholder: '两',
    tone: '江湖商行语境：兵器、暗器、伤药、机关、皮甲、名马、酒——材质、出处、打造者都要像真的'
      + '（如「铸剑山庄」「唐门暗器坊」）；不得出现现代名词。',
  },
  fantasy: {
    appName: '奇物商栈',
    refreshVerb: '补充货源',
    generatingText: '商队正在卸货…',
    emptyTitle: '货栈空空如也',
    emptyText: '商栈还没进货。请商队依此界风物，备下一批值得入手的好货。',
    emptyAction: '请商队进货',
    cartLabel: '行囊', orderLabel: '契约', sellerLabel: '商铺', reviewLabel: '旅人评述', favoriteLabel: '珍藏',
    deliveryText: days => `商队驮运，约 ${days} 日可至`,
    parcelWord: '货箱',
    currencyPlaceholder: '金币',
    tone: '魔法商栈语境：法杖、卷轴、魔药、炼金材料、附魔装备、奇物——学派、产地、附魔师都要像真的'
      + '（如「星辉塔·典藏」）；不得出现现代名词。',
  },
};

/** 取风格规格（认不出回落现代）。 */
export function shopSpec(style: string): ShopStyleSpec {
  return SHOP_STYLE_SPECS[style] || SHOP_STYLE_SPECS.modern;
}

/** 首页横幅 flavor 池（零 AI：随机取一句，让「上新」像有人气）。 */
export const SHOP_BANNER_FLAVOR: Readonly<Record<string, readonly string[]>> = {
  modern: ['掌柜刚从外面收来一批好货', '今日上新，手快有手慢无', '这几件是行家私藏，掌柜好说歹说才收来'],
  xianxia: ['阁主亲自采买，皆是坊市难寻之物', '今日新到，灵材丹药俱全', '这几件是秘境里带出来的，识货的来'],
  wuxia: ['掌柜刚跑了一趟镖，带回不少好货', '今日新到，兵器伤药俱全', '这几件是关外来的，识货的来'],
  fantasy: ['商队刚卸完货，奇物不少', '今日新到，卷轴魔药俱全', '这几件是从远洋带回来的，识货的来'],
};

/** 取横幅 flavor（按风格；空池回落现代）。 */
export function shopBannerFlavor(style: string): string {
  const pool = SHOP_BANNER_FLAVOR[style] || SHOP_BANNER_FLAVOR.modern;
  return pool[Math.floor(Math.random() * pool.length)] || '';
}

/** 昵称兜底（AI 没给评价者名）。 */
export function shopReviewAnon(style: string): string {
  return s(style as PhoneStyle, '匿名买家', '匿名道友', '匿名客官', '匿名旅人');
}

// ─── ① 触发注入 ───

export interface ShopTriggerArgs {
  roster: RosterSnapshot;
  style?: string;
  /** 用户额外要求（提到的人名也激活世界书）。 */
  extraHint?: string;
}

/** ① 绿灯触发文本（position:'none'，只参与扫描、不发给 AI）。 */
export function buildShopTriggerText(args: ShopTriggerArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = shopSpec(args.style || '');
  const me = args.roster.protagonistName || '主角';
  const scanWords = s(style,
    '商城 购物 商品 商店 店铺 买卖 订单 价格',
    '万宝阁 坊市 灵材 法器 丹药 采买 灵石 价钱',
    '商行 集市 镖局 兵器 伤药 银两 价钱',
    '商栈 集市 货品 魔药 卷轴 金币 价钱');
  return [
    s(style,
      `【购物】${me}在手机的「${spec.appName}」里刷新了货架，想看看有什么可买的。`,
      `【采买】${me}在「${spec.appName}」里重新采买，想看看有什么可入手的。`,
      `【张罗】${me}在「${spec.appName}」里重新张罗货架，想看看有什么可买的。`,
      `【进货】${me}在「${spec.appName}」里补充货源，想看看有什么可买的。`),
    `检索词：${scanWords}`,
    String(args.extraHint || '').trim(),
  ].filter(Boolean).join('\n');
}

// ─── ② 资料块 ───

export interface ShopCurrencyInfo {
  name: string;
  desc: string;
  precision: 0 | 2;
}

export interface ShopDossierArgs {
  roster: RosterSnapshot;
  style?: string;
  chronicleBlocks?: string;
  storyText?: string;
  /** 主角持有的币种（名 + 描述 + 精度 + 余额）；空数组 = 无货币联动（按占位币种定价）。 */
  currencies: readonly ShopCurrencyInfo[];
  /** 常用币种名（默认定价单位）。 */
  commonName?: string;
  /** 现有货架商品名（防重名；最多 40 条）。 */
  existingNames?: readonly string[];
  /** 现有货架分类（用户定案：有多少列多少，由货架上限自然钳制）。 */
  existingCategories?: readonly string[];
}

/** ② 资料块（after_system，发给 AI）。 */
export function buildShopDossierText(args: ShopDossierArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = shopSpec(args.style || '');
  const sections: string[] = [s(style,
    `【手机「${spec.appName}」上货资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」备货资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」备货资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」进货资料参考（供保持世界观一致，非剧中人所知）】`)];
  const g = args.roster.global;
  const envParts = [
    g.location ? `地点：${g.location}` : '',
    g.time ? `时间：${g.time}` : '',
  ].filter(Boolean);
  if (envParts.length) sections.push(`■ 当前位置与时间\n${envParts.join('　')}`);

  // 货币体系（币种名 + 币种描述 + 精度；用户定案不注入余额）——商品定价必须从这份清单里选
  if (args.currencies.length) {
    const lines = args.currencies.map(c => {
      const mark = args.commonName && c.name === args.commonName ? '（常用）' : '';
      const unit = c.precision === 2 ? '可带小数（两位）' : '整数';
      const desc = c.desc ? `：${c.desc}` : '';
      return `· ${c.name}${mark}${desc}｜${unit}`;
    });
    sections.push(s(style,
      `■ 货币体系（本世界的流通货币；商品定价必须从下列币种中选择，不得自造币种）\n${lines.join('\n')}`,
      `■ 灵石体系（本世界的流通之资；货品定价必须从下列币种中选择，不得自造）\n${lines.join('\n')}`,
      `■ 银钱体系（本世界的流通之资；货品定价必须从下列币种中选择，不得自造）\n${lines.join('\n')}`,
      `■ 钱币体系（本世界的流通之资；货品定价必须从下列币种中选择，不得自造）\n${lines.join('\n')}`));
  } else {
    sections.push(s(style,
      `■ 货币体系：本世界暂无明确货币体系。商品价格一律用「${spec.currencyPlaceholder}」计价（整数），按世界观给出合理价位。`,
      `■ 货币体系：本世界暂无明确货币体系。货品价格一律用「${spec.currencyPlaceholder}」计价（整数），依当世物价给出合理价位。`,
      `■ 货币体系：本世界暂无明确货币体系。货品价格一律用「${spec.currencyPlaceholder}」计价（整数），依江湖行情给出合理价位。`,
      `■ 货币体系：本世界暂无明确货币体系。货品价格一律用「${spec.currencyPlaceholder}」计价（整数），依此界物价给出合理价位。`));
  }

  if (args.chronicleBlocks) {
    sections.push(`■ 剧情纪要（从旧到新，供衔接故事过往）\n${args.chronicleBlocks}`);
  }
  sections.push(`■ 主角档案（数据库表格）\n${contactSection(args.roster, args.roster.protagonistName || '我')}`);
  if (args.storyText) {
    sections.push(`■ 最近正文进展（供衔接剧情）\n${args.storyText}`);
  }
  const names = (args.existingNames || []).map(n => String(n || '').trim()).filter(Boolean).slice(0, 40);
  if (names.length) {
    sections.push(`■ 现有货架（新商品**不得**与下列商品重名或近似重名）\n${names.join('、')}`);
  }
  const cats = (args.existingCategories || []).map(c => String(c || '').trim()).filter(Boolean);
  if (cats.length) {
    sections.push(`■ 现有类别（新商品应尽量归入下列分类；确需新类时也请贴近其风格）\n${cats.join('、')}`);
  }
  sections.push(s(style,
    `■ 本次任务\n为「${spec.appName}」上一批新货（这个世界里真实存在、值得购买的东西）。`,
    `■ 本次任务\n为「${spec.appName}」采买一批新货（此界真实存在、值得入手之物）。`,
    `■ 本次任务\n为「${spec.appName}」张罗一批新货（江湖上真实流通、值得买的东西）。`,
    `■ 本次任务\n为「${spec.appName}」进一批新货（此界真实存在、值得入手之物）。`));
  return sections.join('\n\n');
}

// ─── ③ 生成指令 ───

/** 输出格式骨架（按风格换标签与措辞；字段键 名/价/币/述/送/铺/图/类/评 四风格一致——解析器只认一套）。 */
export function shopFormatExample(style: string): string {
  const tag = shopTag(style);
  const sp = shopSpec(style);
  return [
    `<${tag}>`,
    `- 名：{商品名，像这个世界真实可能买到的东西}`,
    `  价：{价格数字，只写数字}`,
    `  币：{币种名，必须是上面货币清单里的一种}`,
    `  述：{40 字以内的描述：材质/来历/功效/稀缺度，写得像店铺里的介绍}`,
    `  送：{送货天数，整数}`,
    `  铺：{${sp.sellerLabel}名，像真的（如「药王谷·百草堂」）}`,
    `  图：{1 个常见 emoji 当商品图符（如 🧪 🗡️ 📜 🏮 💍）}`,
    `  类：{分类，2-4 字（如 丹药/法器/珍玩/典籍）}`,
    `  评：{评价者昵称}|{一句评语，可夸可吐槽，像真买家}`,
    `  评：{评价者昵称}|{一句评语}`,
    `- 名：{第二件商品}`,
    `  价：{}`,
    `  币：{}`,
    `  述：{}`,
    `  送：{}`,
    `  铺：{}`,
    `  图：{}`,
    `  类：{}`,
    `  评：{}|{}`,
    `</${tag}>`,
  ].join('\n');
}

export interface ShopInstructionArgs {
  roster: RosterSnapshot;
  style?: string;
  /** 本批件数（设置项 shopBatchSize）。 */
  batchSize: number;
  /** 用户额外要求（长按刷新输入）。 */
  extraPrompt?: string;
}

/** ③ 指令（user_input）：格式骨架 + 规则编号 + 风格调性 + 附加要求。 */
export function buildShopInstruction(args: ShopInstructionArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = shopSpec(args.style || '');
  const me = args.roster.protagonistName || '主角';
  const n = Math.max(1, Math.floor(args.batchSize) || 8);
  const rules = [
    `这是「${spec.appName}」的货架：主角${me}想看看有什么可买的。请直接上货，不要解释、不要旁白、不要问问题。`,
    `上架 ${n} 件商品；每件的字段固定为 名 / 价 / 币 / 述 / 送 / 铺 / 图 / 类 / 评 九项。字段名不要改字。`,
    `**商品必须相对具备意义**：这个世界里真正值得买、有来历、有故事的东西（${spec.tone}）`,
    '**明确禁止**：随处可见的日用品充当填充（馒头、普通衣物、瓶装水、常见文具这类）——除非当前世界观与剧情赋予了它特殊意义（如「某位大人物用过的那一只」）。',
    `定价必须从上面货币清单里选一种（币 字段写币种名）；金额要与世界观、稀有度相称，允许 1~2 件明显昂贵的目标物（让人有攒钱的念想）。`,
    '送货天数：根据故事背景、路途与物流方式自由设定（整数天）。',
    '商品名不得与「现有货架」里的商品重名或近似重名（换个说法也不行）；同一批内部也不要重复。',
    `每件商品附若干条${spec.reviewLabel}（评 行：昵称|评语）——条数不限、按商品特点自由发挥；每条 20~100 字，要像真买家：可以夸、可以嫌贵、可以吐槽发货慢，让货架有活人味。昵称贴合世界观（不要「用户1234」这类现代 ID）。`,
    `图 用**常见 emoji**（如 🧪 🗡️ 📜 🏮 💍 🐉），一个就够；不要用冷门新符号（显示不出来会变方块）。`,
    '全部内容都要贴合当前世界观与故事进展，且不得与已发生的剧情矛盾；不要写任何现代名词（除非当前就是现代背景）。',
    `整个块用 <${shopTag(args.style || '')}> 包起来。`,
  ];
  const extra = String(args.extraPrompt || '').trim();
  if (extra) rules.push(`本次上货的额外要求（优先满足）：${extra}`);
  return [
    s(style,
      `【任务】模拟手机「${spec.appName}」的掌柜上货`,
      `【任务】模拟手机「${spec.appName}」的阁主备货`,
      `【任务】模拟手机「${spec.appName}」的掌柜张罗货架`,
      `【任务】模拟手机「${spec.appName}」的商队进货`),
    shopFormatExample(args.style || ''),
    '【规则】',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
  ].join('\n\n');
}

// ─── 商品图：标签翻译器（第一步；镜像主项目衣柜单品 itemPromptSystem） ───

/** 商品标签翻译器的输出标签（解析用；与提示词同源）。 */
export const SHOP_ITEM_TAGS_JSON = 'SHOP_ITEM_TAGS_JSON';
/** 批量（进店自动补图用）标签翻译器的输出标签。 */
export const SHOP_ITEMS_TAGS_JSON = 'SHOP_ITEMS_TAGS_JSON';

/**
 * 标签翻译规则正文（单件/批量**共用同一份**，改一处两处同步——防两套口径漂移）。
 * **逐条对齐** unified-statusbar/core/wardrobe-prompts.ts 的 itemPromptSystem：只描述物件本体视觉特征；
 * 展示框定词/构图词/人体词/数量词全部由前端注入，AI 写了会被清洗丢弃（normalizeShopItemTags 同款黑名单）。
 */
const SHOP_TAG_RULES = `【标签范围】只描述该商品本体的视觉特征：颜色、材质、形制/结构、纹样/图案、部件细节、品类。保留并展开物件固有细节，不编造未出现的物件。
第一项必须是最具体的物品品类或「颜色＋品类」（如 jade pendant、black dagger、paper talisman、glass vial、bronze incense burner），后续每项只写一个独立属性。

【严禁输出】
- 展示框定词：no_humans、object_focus、still_life、simple_background、white_background、clothes_focus；
- 构图词：flat_lay、hanging、standing、folded、on_hanger、centered、front_view 等；
- 人体词：human、hands、feet、face、body、skin、person、worn、wearing、mannequin 等；
- 数量词：pair_of、set_of、couple、two、double、multiple items；
- 背景词、文字/水印词、以及任何与商品本体无关的场景描述。

【标签形态】只输出英文 NovelAI/Danbooru 风格标签，小写、下划线连接或空格分隔；每个标签一个独立属性，同一维度只保留一个标签（颜色、材质、形制各自唯一），不并列近义词。`;

/** 商品标签翻译器（单件；详情页「看主图」按需生图的第一步）。 */
export function buildShopItemTagInstruction(args: { name: string; desc: string; style?: string }): { system: string; userInput: string } {
  const system = `你是商品标签翻译器。把给定商品的名称与描述，翻译成纯净的该商品本体标签，供前端拼装商品展示图主提示词。

${SHOP_TAG_RULES}

严格输出：
<${SHOP_ITEM_TAGS_JSON}>
{"tags":["最具体品类标签","颜色/材质/结构标签"]}
</${SHOP_ITEM_TAGS_JSON}>`;
  const userInput = `【商品名称】${String(args.name || '').trim()}\n【商品描述】${String(args.desc || '').trim() || '（无描述）'}\n\n请严格按上述 JSON 输出。`;
  return { system, userInput };
}

/**
 * 商品标签翻译器（**批量**：进店自动补图时把整批待生图商品**合并成一次文字请求**，
 * 用户口径「进入时对未生图内容合并生图提示词请求然后串行生图」；形状对齐主项目衣柜批量的
 * `{prompts:[{targetId,…}]}`——这里按输入序号 `i` 回填，序号缺失/越界即该件算失败，逐件回退单件翻译）。
 */
export function buildShopBatchTagInstruction(items: readonly { name: string; desc: string }[]): { system: string; userInput: string } {
  const n = items.length;
  const system = `你是商品标签翻译器。给定 ${n} 件商品，为**每一件**翻译成纯净的该商品本体标签，供前端拼装商品展示图主提示词。

${SHOP_TAG_RULES}

严格输出（i = 输入序号，从 1 开始，必须与输入**一一对应**、不得缺项、不得合并、不得加解释）：
<${SHOP_ITEMS_TAGS_JSON}>
{"items":[{"i":1,"tags":["最具体品类标签","颜色/材质/结构标签"]},{"i":2,"tags":["…"]}]}
</${SHOP_ITEMS_TAGS_JSON}>`;
  const userInput = items
    .map((it, i) => `【${i + 1}】${String(it.name || '').trim()}\n描述：${String(it.desc || '').trim() || '（无描述）'}`)
    .join('\n\n');
  return { system, userInput };
}

/**
 * 解析批量翻译结果：返回按输入序号对齐的标签数组（缺项=空串，调用方逐件回退单件翻译）。
 * 容错：块标签缺失时整段找对象；对象字段顺序任意；`tags` 支持数组或逗号串；越界/重复序号忽略。
 */
export function parseShopBatchTags(raw: string, count: number): string[] {
  const text = String(raw || '');
  const m = new RegExp(`<${SHOP_ITEMS_TAGS_JSON}>([\\s\\S]*?)</${SHOP_ITEMS_TAGS_JSON}>`, 'i').exec(text);
  const body = m ? m[1] : text;
  const out: string[] = new Array(Math.max(0, Math.floor(count) || 0)).fill('');
  const objRe = /\{[^{}]*\}/g;
  let hit: RegExpExecArray | null;
  while ((hit = objRe.exec(body)) !== null) {
    const obj = hit[0];
    const idx = Number(/"i"\s*:\s*(\d+)/.exec(obj)?.[1]);
    if (!Number.isFinite(idx) || idx < 1 || idx > out.length) continue;
    if (out[idx - 1]) continue; // 重复序号：先出现者胜（与货架同名去重同口径）
    const arr = /"tags"\s*:\s*\[([\s\S]*?)\]/.exec(obj);
    if (!arr) continue;
    const tags: string[] = [];
    const strRe = /"([^"]*)"/g;
    let t: RegExpExecArray | null;
    while ((t = strRe.exec(arr[1])) !== null) tags.push(t[1]);
    const normalized = normalizeShopItemTags(tags);
    if (normalized) out[idx - 1] = normalized;
  }
  return out;
}

// ─── 商品图：最终主提示词装配（第二步前；镜像 wardrobe-prompts 的 assembleItemDisplayPrompt） ───

/** 框定词黑名单（AI 误写时剔除；与主项目 ITEM_TAG_FORBIDDEN 同款五组）。 */
const ITEM_TAG_FORBIDDEN = [
  /\b(?:human|person|girl|boy|woman|man|mannequin)s?\b/i,
  /\b(?:hands?|feet|legs?|arms?|face|skin|body|torso|head|partial body)\b/i,
  /\b(?:worn|wearing|standing|hanging|flat lay|flat_lay|on hanger|folded)\b/i,
  /\b(?:white background|simple background|object focus|clothes focus|footwear focus|still life)\b/i,
  /\b(?:pair of|set of|couple|two|double|multiple items?)\b/i,
];

/** 标签清洗：拆分 → 归一（下划线转空格）→ 剔黑名单 → 去重。 */
export function normalizeShopItemTags(value: unknown): string {
  const parts = Array.isArray(value) ? value.map(v => String(v ?? '')) : String(value ?? '').split(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const tag = raw.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
    if (!tag) continue;
    if (ITEM_TAG_FORBIDDEN.some(re => re.test(tag))) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(', ');
}

/** 解析翻译器输出（`<SHOP_ITEM_TAGS_JSON>{"tags":[...]}</SHOP_ITEM_TAGS_JSON>`；宽松：找不到标签就整段找 JSON 数组）。 */
export function parseShopItemTags(raw: string): string {
  const text = String(raw || '');
  const m = new RegExp(`<${SHOP_ITEM_TAGS_JSON}>([\\s\\S]*?)</${SHOP_ITEM_TAGS_JSON}>`, 'i').exec(text);
  const body = m ? m[1] : text;
  const arr = /\[([\s\S]*?)\]/.exec(body);
  if (!arr) return '';
  const items: string[] = [];
  const re = /"([^"]*)"/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(arr[1])) !== null) items.push(hit[1]);
  return normalizeShopItemTags(items);
}

export interface ShopItemImagePromptArgs {
  apiFormat: 'novelai' | 'openai' | 'comfyui';
  name: string;
  desc: string;
  /** 翻译器产出的纯净物件标签（已清洗）。 */
  tags: string;
  /**
   * 形态覆盖（**智慧姬通道专用**）：智慧姬的存储位钉 openai，光看 apiFormat 会把「吃标签」的
   * SD/NAI/ComfyUI 模式也编译成中文自然语言商品规格 ⇒ 商品标签形同废纸、主图与标签对不上
   * （docs/62 §五-3）。调用方按智慧姬当前模式传 'tags'/'natural'；''（模式未选）或缺省时按 apiFormat 兜底。
   */
  form?: 'tags' | 'natural';
}

/**
 * 商品图主提示词（按供应商编译）。逐条对齐主项目衣柜单品展示图：
 * 自然语言（OpenAI/ComfyUI）= 结构化商品规格 + 硬约束；NAI = 标签行 + 固定展示框定词。
 * args.form 优先（智慧姬按插件当前模式判形态），缺省时才看 apiFormat。
 */
export function assembleShopItemDisplayPrompt(args: ShopItemImagePromptArgs): string {
  const tags = normalizeShopItemTags(args.tags);
  const name = String(args.name || '').trim();
  const natural = args.form ? args.form === 'natural' : (args.apiFormat === 'openai' || args.apiFormat === 'comfyui');
  if (natural) {
    const appearance = [String(args.desc || '').trim(), tags].filter(Boolean).join('；');
    return [
      '用途：独立电商目录商品图。',
      `主体：恰好一件${name}，完整可见。`,
      `外观：${appearance || name}。`,
      '构图：商品居中，正面或轻微俯视，四周留有均匀空白。',
      '背景：纯白无缝背景，只允许轻微接触阴影。',
      '硬约束：画面中只能出现上述商品。不得出现人物、皮肤、肢体、穿戴状态、模特、衣架、支架、包装、家具、其他商品、装饰物、文字、标志或水印。',
    ].join('\n');
  }
  const parts = [
    'no humans', 'object focus', 'still life',
    tags,
    'single item', 'fully visible', 'centered', 'straight-on',
    'simple background', 'white background', 'subtle contact shadow', 'no text',
  ].filter(Boolean);
  return parts.join(', ');
}

/** 生图负面词（商品图专用：防人物/文字/多件；与主项目单品路径同口径）。 */
export const SHOP_ITEM_NEGATIVE = 'human, person, hands, feet, face, skin, wearing, mannequin, multiple items, text, watermark, signature, logo, blurry, lowres';

/** 生图提示词固化前的字数护栏（防 AI 跑飞）。 */
export function clampShopTags(tags: string): string {
  return normalizeShopItemTags(tags).slice(0, 300);
}

/** 商品名的兜底（AI 漏写分类时按名推断；仅展示用）。 */
export function fallbackShopSeller(style: string): string {
  return s(style as PhoneStyle, '杂货铺', '坊市摊子', '街口货摊', '货栈');
}

/** 商品名清单（资料块防重名用）。 */
export function shopExistingNames(catalog: readonly ShopItem[]): string[] {
  return catalog.map(it => it.name).filter(Boolean).slice(0, 40);
}

/** 现有分类清单（资料块用；去重、按货架出现顺序、**不设上限**——货架上限即天然钳制）。 */
export function shopExistingCategories(catalog: readonly ShopItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of catalog) {
    const c = String(it?.category || '').trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}
