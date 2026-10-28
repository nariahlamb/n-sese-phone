// ===== 商城消息（商家沟通）· 提示词（docs/54 §3）=====
// 三段式（镜像微信私聊，资料块换血）：
//   ① 触发注入（position:'none' + should_scan）——点了生成条才注入（零常驻）
//   ② 资料块（after_system）——时间地点 + 货币体系 + 主角档案 + 纪要 + 正文 + **收货信息** +
//      **本店（在售清单带商品当前状态）** + **买家评价** + **红包与返现记录** + **本会话沟通记录（最近 30 条）**
//   ③ 指令（user_input + runPhoneRaw 全槽位）——四类富媒体（图片/红包/改价/新商品）+ 谈价/售后/状态纪律
//
// 与微信资料块的差异（用户口径）：没有人物关系段、没有混合记录块（通话/朋友圈/群聊）、没有桌游联动；
// 换成"这家店 + 这件货 + 我和这位掌柜说过的话"。术语与文案随四风格 S() 换装。

import type { PhoneStyle } from './chat-model';
import { contactSection } from './chat-prompts';
import { s } from './skins';
import type { RosterSnapshot } from './roster';
import { shopSpec } from './shop-prompts';
import type { ShopMessage } from './shop-chat-model';

// ─── 术语（四风格；渲染与提示词共用一份口径） ───

/** 店铺方的称呼（掌柜/阁主/管事）。 */
export function shopSellerWord(style: string): string {
  return s(style as PhoneStyle, '掌柜', '阁主', '掌柜', '商队管事');
}

/** 「消息」页与详情按钮的措辞。 */
export function shopMessageWord(style: string): string {
  return s(style as PhoneStyle, '消息', '传讯', '捎话', '传讯');
}

/** 红包（好评返现/定金/补差价）。 */
export function shopRedPacketWord(style: string): string {
  return s(style as PhoneStyle, '红包', '灵石福袋', '赏钱', '钱袋');
}

/** 收货人/收货地址。 */
export function shopShipWords(style: string): [string, string] {
  return s(style as PhoneStyle, '收货人', '收件人', '收货人', '收件人') === '收货人'
    ? ['收货人', '收货地址']
    : [s(style as PhoneStyle, '收货人', '收件人', '收货人', '收件人'), s(style as PhoneStyle, '收货地址', '送件之处', '收货之处', '送达之处')];
}

// ─── ① 触发注入 ───

export interface ShopChatTriggerArgs {
  roster: RosterSnapshot;
  style?: string;
  seller: string;
  /** 当前咨询商品名（可空）。 */
  focusItemName?: string;
  /** 我方本批消息全文（上屏不截断）。 */
  userText?: string;
  /** 一次性额外提示（长按生成条 ⋯）。 */
  extraHint?: string;
}

export function buildShopChatTriggerText(args: ShopChatTriggerArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = shopSpec(args.style || '');
  const me = args.roster.protagonistName || '主角';
  const word = shopSellerWord(args.style || '');
  const scanWords = s(style,
    '商城 购物 商品 店铺 商家 客服 掌柜 讨价还价 砍价 返现 评价 收货 发货',
    '万宝阁 坊市 货品 阁主 议价 让价 好评回礼 收货 发货',
    '商行 集市 货品 掌柜 还价 让价 好评回礼 收货 发货',
    '商栈 集市 奇物 管事 谈价 折价 好评回礼 收货 发货');
  return [
    s(style,
      `【购物咨询】${me}在手机的「${spec.appName}」里找「${args.seller}」的${word}聊天`,
      `【采买咨询】${me}在「${spec.appName}」里找「${args.seller}」的${word}问货`,
      `【张罗咨询】${me}在「${spec.appName}」里找「${args.seller}」的${word}问货`,
      `【进货咨询】${me}在「${spec.appName}」里找「${args.seller}」的${word}问货`)
      + (args.focusItemName ? `，问的是「${args.focusItemName}」。` : '。'),
    `检索词：${scanWords}`,
    String(args.userText || '').trim(),
    String(args.extraHint || '').trim(),
  ].filter(Boolean).join('\n');
}

// ─── ② 资料块 ───

export interface ShopChatCurrencyInfo {
  name: string;
  desc: string;
  precision: 0 | 2;
  balance: number;
}

/** 资料块里的一件在售商品（含状态标注）。 */
export interface ShopChatItemLine {
  name: string;
  price: number;
  currencyName: string;
  category: string;
  /** 商品当前状态（在购物车/已下单/已送达/已评价/未买过）。 */
  status: string;
}

export interface ShopChatReviewLine {
  itemName: string;
  rating: number;
  text: string;
  images: number;
  createdAt: string;
}

export interface ShopChatDossierArgs {
  roster: RosterSnapshot;
  style?: string;
  chronicleBlocks?: string;
  storyText?: string;
  currencies: readonly ShopChatCurrencyInfo[];
  commonName?: string;
  seller: string;
  items: readonly ShopChatItemLine[];
  focusItemName?: string;
  focusStatus?: string;
  /** 与这位买家的沟通记录（已格式化的行，从旧到新）。 */
  transcript: readonly string[];
  /** 主角写过的本店评价（最多 10 条）。 */
  myReviews?: readonly ShopChatReviewLine[];
  /** 本店商品自带的买家评价摘要（AI 上货时生成的那些，最多 3 条）。 */
  buyerReviews?: readonly string[];
  /** 已返现记录（防重复返现）。 */
  rebateLines?: readonly string[];
  /** 主角的默认收货信息（未填为空串）。 */
  shipTo?: string;
}

function fmtNum(n: number, precision: 0 | 2): string {
  const safe = Number.isFinite(n) ? n : 0;
  const v = precision === 2 ? safe.toFixed(2) : String(Math.round(safe));
  const parts = v.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

function stars(rating: number): string {
  const n = Math.max(0, Math.min(5, Math.floor(rating) || 0));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** 把会话消息格式化成资料块里的沟通记录行（我方=「我」，商家=店名）。 */
export function formatShopTranscript(messages: readonly ShopMessage[], limit: number): string[] {
  const sliced = messages.slice(Math.max(0, messages.length - Math.max(0, limit)));
  const lines: string[] = [];
  for (const m of sliced) {
    if (m.from === 'system') continue;
    const who = m.from === 'me' ? '我' : m.from;
    if (m.type === 'image') {
      lines.push(`${who}: [图片]${m.content}`);
      continue;
    }
    if (m.type === 'redpacket') {
      const state = m.claimed === false ? '（未领取）' : '（已领取）';
      lines.push(`${who}: [红包]${m.amount || ''} ${m.currency || ''}${m.content ? `|${m.content}` : ''}${state}`);
      continue;
    }
    if (m.type === 'price' && m.priceChange) {
      const pc = m.priceChange;
      lines.push(`${who}: [改价]${pc.itemName} ${pc.from} → ${pc.to}${pc.note ? `（${pc.note}）` : ''}`);
      continue;
    }
    if (m.type === 'item' && m.newItem) {
      const it = m.newItem.item;
      lines.push(`${who}: [新商品]${it.name} 价 ${it.currencyName} ${it.price}${m.newItem.listed ? '（已上架）' : '（已在货架）'}`);
      continue;
    }
    lines.push(`${who}: ${m.content}`);
  }
  return lines;
}

/** ② 资料块（after_system，发给 AI）。 */
export function buildShopChatDossierText(args: ShopChatDossierArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = shopSpec(args.style || '');
  const word = shopSellerWord(args.style || '');
  const [shipNameWord, shipAddrWord] = shopShipWords(args.style || '');
  const sections: string[] = [s(style,
    `【手机「${spec.appName}」商家沟通资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」商家沟通资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」商家沟通资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」商家沟通资料参考（供保持世界观一致，非剧中人所知）】`)];
  const g = args.roster.global;
  const envParts = [g.location ? `地点：${g.location}` : '', g.time ? `时间：${g.time}` : ''].filter(Boolean);
  if (envParts.length) sections.push(`■ 当前位置与时间\n${envParts.join('　')}`);

  if (args.currencies.length) {
    const lines = args.currencies.map(c => {
      const mark = args.commonName && c.name === args.commonName ? '（常用）' : '';
      const unit = c.precision === 2 ? '可带小数（两位）' : '整数';
      const desc = c.desc ? `：${c.desc}` : '';
      return `· ${c.name}${mark}${desc}｜${unit}｜主角余额 ${fmtNum(c.balance, c.precision)}`;
    });
    sections.push(s(style,
      `■ 货币体系（本世界的流通货币；定价与红包金额必须从下列币种中选择，不得自造）\n${lines.join('\n')}`,
      `■ 灵石体系（本世界的流通之资；定价与红包必须从下列币种中选，不得自造）\n${lines.join('\n')}`,
      `■ 银钱体系（本世界的流通之资；定价与红包必须从下列币种中选，不得自造）\n${lines.join('\n')}`,
      `■ 钱币体系（本世界的流通之资；定价与红包必须从下列币种中选，不得自造）\n${lines.join('\n')}`));
  } else {
    sections.push(s(style,
      `■ 货币体系：本世界暂无明确货币体系。价格与红包一律用「${spec.currencyPlaceholder}」计价（整数）。`,
      `■ 货币体系：本世界暂无明确货币体系。价格与红包一律用「${spec.currencyPlaceholder}」计价（整数）。`,
      `■ 货币体系：本世界暂无明确货币体系。价格与红包一律用「${spec.currencyPlaceholder}」计价（整数）。`,
      `■ 货币体系：本世界暂无明确货币体系。价格与红包一律用「${spec.currencyPlaceholder}」计价（整数）。`));
  }

  if (args.chronicleBlocks) sections.push(`■ 剧情纪要（从旧到新，供衔接故事过往）\n${args.chronicleBlocks}`);
  sections.push(`■ 主角档案（数据库表格）\n${contactSection(args.roster, args.roster.protagonistName || '我')}`);
  if (args.storyText) sections.push(`■ 最近正文进展（供衔接剧情）\n${args.storyText}`);

  sections.push(s(style,
    `■ ${shipNameWord}与${shipAddrWord}（主角在本商城登记的收货信息；发货与确认以它为准）\n${args.shipTo || `主角尚未填写${shipAddrWord}（可提醒他补填）`}`,
    `■ ${shipNameWord}与${shipAddrWord}（主角登记的收件信息；发货与确认以它为准）\n${args.shipTo || `主角尚未填写${shipAddrWord}（可提醒他补填）`}`,
    `■ ${shipNameWord}与${shipAddrWord}（主角登记的收货信息；发货与确认以它为准）\n${args.shipTo || `主角尚未填写${shipAddrWord}（可提醒他补填）`}`,
    `■ ${shipNameWord}与${shipAddrWord}（主角登记的送达信息；发货与确认以它为准）\n${args.shipTo || `主角尚未填写${shipAddrWord}（可提醒他补填）`}`));

  // 本店：店名 + 在售清单（带商品当前状态）+ 当前咨询商品
  const itemLines = args.items.map(it => {
    const cat = it.category ? `｜${it.category}` : '';
    return `     ${it.name}（${it.currencyName} ${fmtNum(it.price, 0)}${cat}｜${it.status}）`;
  });
  const focusLine = args.focusItemName
    ? `   · 当前咨询商品：${args.focusItemName}${args.focusStatus ? `（${args.focusStatus}）` : ''}——买家是从这件商品的页面找上门的`
    : '   · 当前咨询商品：（未指定——买家可能只是进店问问）';
  sections.push(s(style,
    `■ 本店（会话对象）\n   · 店名：${args.seller}\n   · 你是这家店的${word}，说话要像这家店的生意人。`,
    `■ 本店（会话对象）\n   · 字号：${args.seller}\n   · 你是这家字号的${word}，说话要像这家店的生意人。`,
    `■ 本店（会话对象）\n   · 商号：${args.seller}\n   · 你是这家商号的${word}，说话要像这家店的生意人。`,
    `■ 本店（会话对象）\n   · 商铺：${args.seller}\n   · 你是这家商铺的${word}，说话要像这家店的生意人。`));
  sections.push([
    s(style, '   · 在售商品（本店货架；改价与红包只能围绕这些商品）', '   · 在售货品（本店货架；让价与回礼只能围绕这些货品）',
      '   · 在售货品（本店货架；让价与回礼只能围绕这些货品）', '   · 在售奇物（本店货架；折价与回礼只能围绕这些奇物）')
      + `（括号里是**买家与这件商品的当前状态**）：`,
    ...itemLines,
    `     共 ${args.items.length} 件；其余商品不属本店、不得出现在本店语境里。`,
    focusLine,
    '   · 状态口径（供你说话用）：**在购物车**=看上了还没买（可以促单）、**已下单**=在途（可说发货/催单）、'
    + '**已送达**=买到手了（问一句用得如何）、**已评价**=写了评价（好话就谢、抱怨就补）、**未买过**=还没打过交道。',
  ].join('\n'));

  const reviewLines: string[] = [];
  for (const rv of args.myReviews || []) {
    reviewLines.push(`   ★ ${rv.itemName}｜主角给出的评价｜${stars(rv.rating)}｜${rv.text ? `「${rv.text}」｜` : ''}${rv.images ? `附 ${rv.images} 张图｜` : ''}${rv.createdAt || ''}`);
  }
  for (const line of args.buyerReviews || []) reviewLines.push(`     ${line}`);
  if (reviewLines.length) {
    sections.push(s(style,
      `■ 买家评价（与本店有关；★ 标记的是主角自己写的那条）\n${reviewLines.join('\n')}`,
      `■ 买家品评（与本店有关；★ 标记的是主角自己写的那条）\n${reviewLines.join('\n')}`,
      `■ 买家点评（与本店有关；★ 标记的是主角自己写的那条）\n${reviewLines.join('\n')}`,
      `■ 买家评述（与本店有关；★ 标记的是主角自己写的那条）\n${reviewLines.join('\n')}`));
  }
  if (args.rebateLines && args.rebateLines.length) {
    sections.push(`■ 红包与返现记录（防止重复返现；已返过的商品不要再返）\n${args.rebateLines.map(l => `   · ${l}`).join('\n')}`);
  }

  sections.push(s(style,
    `■ 与这位买家的沟通记录（**本会话上下文**，从旧到新，最近 ${args.transcript.length} 条）\n${args.transcript.join('\n') || '（这是第一次说话）'}`,
    `■ 与这位买家的符讯往来（**本会话上下文**，从旧到新，最近 ${args.transcript.length} 条）\n${args.transcript.join('\n') || '（这是第一次说话）'}`,
    `■ 与这位买家的书信往来（**本会话上下文**，从旧到新，最近 ${args.transcript.length} 条）\n${args.transcript.join('\n') || '（这是第一次说话）'}`,
    `■ 与这位买家的晶讯往来（**本会话上下文**，从旧到新，最近 ${args.transcript.length} 条）\n${args.transcript.join('\n') || '（这是第一次说话）'}`));
  sections.push(s(style,
    '■ 本次任务：以店家的身份接待这位买家，围绕商品把话说清楚（介绍 / 答疑 / 议价 / 推销 / 售后 / 催单）。',
    '■ 本次任务：以阁主的身份接待这位道兄，围绕货品把话说清楚（介绍 / 答疑 / 议价 / 推销 / 售后 / 催单）。',
    '■ 本次任务：以掌柜的身份接待这位客官，围绕货品把话说清楚（介绍 / 答疑 / 议价 / 推销 / 售后 / 催单）。',
    '■ 本次任务：以管事的身份接待这位旅人，围绕奇物把话说清楚（介绍 / 答疑 / 议价 / 推销 / 售后 / 催单）。'));
  return sections.join('\n\n');
}

// ─── ③ 富媒体块 + 指令 ───

/** 四类富媒体的结构说明（提示词与解析器同一份口径）。 */
export function buildShopRichMediaBlock(style: string): string {
  const word = shopSellerWord(style);
  const money = shopRedPacketWord(style);
  return [
    '【富媒体类型】（消息行的可选前缀，仅在生成时机合适时使用，正常文字消息无需前缀）',
    '■ 名称：图片｜生成时机：要展示实物、包装、成色、细节时｜结构要求：[图片]画面内容中文描述（30-60字，商品实拍口吻，写清物件与场景）',
    `■ 名称：${money}｜生成时机：好评返现（看到主角给本店商品写的评价）、弥补过失（少发/迟发/货不对板）、让利挽留｜`
    + `结构要求：[红包]金额数字 币种名|祝福语（如 [红包]88 上品灵石|好评返现，多谢照应）。金额要小巧体面（商品价的一两成以内，或固定的吉利小数）；`
    + '同一件商品只返现一次；不要每轮都发',
    '■ 名称：改价｜生成时机：买家讨价还价、而你确实愿意让价时｜结构要求：[改价]商品名|新价格数字|一句话说明'
    + '（如 [改价]九转还魂丹|1050|老主顾了，这个价你拿去）。商品名必须是本店在售商品之一；只写数字不写币种；一轮最多一处',
    '■ 名称：新商品｜生成时机：买家问起别的货、或你想推销新货时｜结构要求：'
    + '[新商品]名：{商品名}｜价：{数字}｜币：{币种名}｜述：{40字内}｜送：{天数}｜图：{1个emoji}｜类：{分类}｜评：{昵称}|{评语}'
    + '（名/价必填，其余可省；一轮最多 2 件；铺名不用写，就是本店）',
    `（不要使用其他前缀；不要写旁白、动作、神态。你是${word}，不是旁白。）`,
  ].join('\n');
}

export interface ShopChatInstructionArgs {
  roster: RosterSnapshot;
  style?: string;
  seller: string;
  /** 我方本批消息（逐条上屏，不截断）。 */
  userText: string;
  extraPrompt?: string;
  focusItemName?: string;
}

/** ③ 指令（user_input）。 */
export function buildShopChatInstruction(args: ShopChatInstructionArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = shopSpec(args.style || '');
  const word = shopSellerWord(args.style || '');
  const me = args.roster.protagonistName || '主角';
  const userBlock = args.userText.trim() || s(style,
    '（买家没有发新消息——请主动招呼一句，或就本店与当前商品找点由头）',
    '（买家没有发新讯——请主动招呼一声，或就本店与当前货品找个由头）',
    '（买家没有发新书信——请主动招呼一声，或就本店与当前货品找个由头）',
    '（买家没有发新讯——请主动招呼一声，或就本店与当前奇物找个由头）');
  const rules = [
    `这是「${spec.appName}」的商家会话：主角${me}（即 {{user}}，我方）正在和「${args.seller}」的${word}聊`
    + (args.focusItemName ? `商品「${args.focusItemName}」。请直接说话，不要解释、不要旁白、不要问问题。` : `店里的事。请直接说话，不要解释、不要旁白、不要问问题。`),
    `只输出 ${'<ubp_shop_reply>'} 块，块外不要有任何文字。`,
    `每行一条消息；每行都以「${args.seller}: 」开头（发言者名固定为店名，不要写「${word}」「客服」等称呼当发言者）。`,
    '模拟真人店家的节奏：短句口语、可带招呼语，不要旁白、不要括号动作、不要写作文。',
    `你是谁由「本店」段决定：说话要像这家店的生意人——熟悉自家货、会介绍、会推荐、有分寸地让价；`
    + '不合理的要求要会婉拒，买家不买也别死缠；同一件货不要一而再地大让步。',
    '谈价纪律：只有确实愿意让价时才出 [改价]，每轮最多一处；让价幅度要像真生意（小本货让一两成，贵重货让得更少）；'
    + '本店没有的货不要凭空答应，想卖新货就出 [新商品]。',
    '售后纪律：买家提到评价、少发错发、货有问题时，按「买家评价」与「投递信息」段回应；该返现就发 [红包]（一件商品一次，金额小），'
    + '该认错就认错，别过度承诺。',
    '善用「在售商品」后面的状态标注：在购物车里的可以顺势促单、在途的报个行程、已送达的问一句用得如何、'
    + '已评价的（尤其差评）先谢再补——但不要生硬复述状态，像真掌柜那样随口带出来。',
    '买家下单后（你收到的下单通知见上文），若投递信息完整就以它为准复述确认；缺失就提醒买家补填；'
    + '买家要求改送到别处时，告诉他下单页可以换收货地址，你会按新地址发货。',
    '图片/红包/改价/新商品按上方时机使用，滥发会破坏真实感。',
    '全部内容都要贴合当前世界观与故事进展，且不得与已发生的剧情矛盾。',
    '若资料参考与最新正文进展冲突，以正文进展为准。',
  ];
  const extra = String(args.extraPrompt || '').trim();
  if (extra) rules.push(`本次回复的额外要求（优先满足）：${extra}`);
  return [
    s(style,
      `【任务】模拟手机「${spec.appName}」里的商家在线沟通`,
      `【任务】模拟手机「${spec.appName}」里的商家在线沟通`,
      `【任务】模拟手机「${spec.appName}」里的商家在线沟通`,
      `【任务】模拟手机「${spec.appName}」里的商家在线沟通`),
    '',
    `我方刚刚发送：\n${userBlock}`,
    '',
    `【输出格式】（严格遵守）\n${'<ubp_shop_reply>'}\n${args.seller}: 消息文本\n${args.seller}: [富媒体前缀]按【富媒体类型】块的结构要求（仅在时机合适时使用）\n</ubp_shop_reply>`,
    '',
    buildShopRichMediaBlock(args.style || ''),
    '',
    '【规则】',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
  ].join('\n');
}

// ─── 商家自动消息（零 AI：下单 / 送达 / 取消） ───

/** 自动消息文案池（每时机 2~3 条随机；`ship` 为空 = 未填收货信息）。 */
export const SHOP_AUTO_MESSAGES = {
  ordered: (style: string, ship: string, arriveLabel: string): string[] => {
    const [nameWord, addrWord] = shopShipWords(style);
    // 故事时间不可解析时不编造送达日：整句去掉「预计 …」这一截（全库反漂移口径）
    const arrive = arriveLabel ? `，预计 ${arriveLabel} 送到` : '';
    const arriveTail = arriveLabel ? `，预计 ${arriveLabel} 到` : '';
    return ship
      ? [
        `已收到您的订单啦，${nameWord} ${ship.split(' · ')[0] || ''}，送到 ${ship.split(' · ')[1] || ship}${arrive}。地址有出入随时说。`,
        `订单收到，这就给您打包。${nameWord} ${ship.split(' · ')[0] || ''}，${addrWord} ${ship.split(' · ')[1] || ship}${arriveTail}。`,
      ]
      : [
        `已收到您的订单啦，这就给您打包${arrive}。方便的话把${nameWord}和${addrWord}发我一下。`,
        `订单收到，这就备货${arriveTail}。还没看到您的收货信息，麻烦发一下。`,
      ];
  },
  delivered: (style: string): string[] => [
    s(style as PhoneStyle, '您的货到啦，记得查收。有问题随时找我。', '货已送到，道友查收。有不对的地方言语一声。', '货已送到，客官查收。有不对的地方言语一声。', '货箱已送达，旅人查收。有不对的地方言语一声。'),
    s(style as PhoneStyle, '包裹已送达，您验一下；有磕碰别闷着，跟我说。', '货已送到，当面验一验，有磕碰尽管说。', '货已送到，当面验一验，有磕碰尽管说。', '货箱已送达，开箱验一验，有磕碰尽管说。'),
  ],
  cancelled: (style: string): string[] => [
    s(style as PhoneStyle, '订单已为您取消，钱款原路退回，欢迎下次再来。', '契书已作废，灵石原路退回，改日再来逛逛。', '契书已作废，银钱原路退回，改日再来逛逛。', '契约已取消，钱币原路退回，改日再来看看。'),
    s(style as PhoneStyle, '已取消，款项退回了。有别的主意随时喊我。', '已作废，款项退回。有别的主意随时招呼。', '已作废，款项退回。有别的主意随时招呼。', '已取消，款项退回。有别的主意随时招呼。'),
  ],
} as const;

/** 从文案池随机取一条（池空回退空串；rand 可注入以便测试）。 */
export function pickShopAutoMessage(pool: readonly string[], rand: () => number = Math.random): string {
  if (!pool.length) return '';
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))] || pool[0];
}

/** 收货信息一行（备忘 / 商家消息共用；未填给统一占位语）。 */
export function shopShipLine(style: string, ship: string): string {
  const [nameWord, addrWord] = shopShipWords(style);
  return ship ? `${nameWord}：${ship.split(' · ')[0] || ''}；${addrWord}：${ship.split(' · ')[1] || ship}` : '未填写收货信息';
}
