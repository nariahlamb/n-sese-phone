// ===== 幻想浏览器 · 提示词（第八轮 §5 · N8；第十轮 §1 换「AI 自绘网页」口径）=====
// 四风格单一事实源（BROWSER_STYLE_SPECS）：APP 名 / 检索措辞 / 结果段标题 / 伪 URL 示例 /
//   内容调性 / **视觉语言** / **视觉母题库** / **可用交互**——提示词与 UI 文案共用一份。
// 三段式管线（镜像 call/social）：
//   ① 绿灯触发（position:'none' + should_scan）——用户在浏览器里点了搜索才注入（按钮触发型，零常驻）
//   ② 资料块（after_system）——角色档案 + 在场状态 + 最近正文 + 手机既有记录（反全知：只喂已发生/已说过）
//   ③ generateRaw 全槽位 + max_chat_history 0（runPhoneRaw）
//
// 第十轮口径变更（用户定案：「生成怎样的界面完全交给 AI 决定，CSS 元素/结构/样式/色调天马行空」）：
//   · 交付物从「markdown 标记文本 + 前端白名单渲染」换成「**AI 自绘的一整张网页**」（页 字段，
//     ```html 围栏，自带 <style>）；标签、布局、配色、字体、动效全由 AI 定，前端只提供沙箱画布。
//   · 删掉的旧限制：7 类正文标记清单（## - ** > [图：…] # ---）、6 条页面类型配方（新闻/百科/…）、
//     正文 300-800 字与「至少 1 图 1 引 1 列表」的元素硬指标、站/源/页脚的示例格式。
//   · 换上的新写法：**设计简报 + 视觉母题库**（给灵感不给模板）+ **资源约束**（自足/自绘/无脚本/
//     竖屏尺寸/字符预算）——约束资源而不是约束审美，这是让模型敢放手画的关键。
//   · 推荐项（用户点名）：鼓励页内带**简单交互或子页面**（CSS 实现：<details> / radio 标签页 /
//     :target 子屏 / scroll-snap），让页面点得动。
//   · 述（页面描述）除总体说明外，**尽量写进页面里的关键具体信息**（人名/时间/数字/结论/原话/要点）
//     ——分享给好友后好友侧的 AI 只读得到这一段。
// 纪律：只做要求不做解释；伪 URL 只展示、前端绝不发起真实请求。

import { contactSection, relationSection } from './chat-prompts';
import { mixedRecordSection, type MixedRecords } from './phone-timeline';
import type { PhoneStyle } from './chat-model';
import { s } from './skins';
import type { RosterSnapshot } from './roster';
import { BROWSER_TAG_BY_STYLE, browserTag } from './protocol-tags';

export interface BrowserStyleSpec {
  /** APP 名（桌面图标 / 页头）。 */
  appName: string;
  /** 一次检索的动词（搜索 / 推演 / 探听 / 窥探）。 */
  verb: string;
  /** 结果段标题（结果 / 卷宗 / 邸报 / 晶书）。 */
  resultsLabel: string;
  /** 伪 URL 形态示例（提示词注入用；前端只展示）。 */
  urlExamples: readonly string[];
  /** 内容调性一句话（世界观纪律：这个世界的页面该说什么、不该说什么）。 */
  tone: string;
  /** 这一界的**视觉语言**：纸料/色料/字体气质/纹样/落款——整页应当长成什么样。 */
  visual: string;
  /** **视觉母题库**（灵感清单，不是模板）：这一界能长出哪些气质的站点/页面。 */
  motifs: readonly string[];
  /** 这一界说得出口的 CSS 交互与子页花样（推荐项，不强制）。 */
  interactions: string;
}

/** 四风格表（单一事实源；提示词与 UI 文案共用）。 */
export const BROWSER_STYLE_SPECS: Readonly<Record<string, BrowserStyleSpec>> = {
  modern: {
    appName: '浏览器', verb: '搜索', resultsLabel: '结果',
    urlExamples: ['www.海城晚报.com/社会/20240519-07', 'zh.wikipedia.org/wiki/永昌当'],
    tone: '现代网络用语与新闻腔：站点名/栏目/记者署名（如「海城晚报 · 记者 陈默」）都像真的；正文可带 #话题标签 与 © 版权行。',
    visual: '现代都市的数字界面：干净的无衬线字体（苹方/思源黑一族）、明确的品牌色、卡片与圆角、真实的排版层次与留白。'
      + '配色按站点类型各自走，不要全站一个色：报纸=泛黄纸+朱红、百科=象牙白+链接蓝、社区=亮蓝顶栏、'
      + '政务=红头+公文宋、商户=深色+霓虹渐变、专栏=衬线+大图留白。允许 emoji、数据图表、状态灯。',
    motifs: [
      '旧报纸：泛黄纸纹 + 双栏线 + 朱红报头 + 首字下沉 + 当票/票据式卡片',
      '百科词条：象牙白 + 右浮动信息框（含自绘小地图）+ 目录 + 上标引用 + 参考来源',
      '社区论坛：亮蓝顶栏 + 楼主/楼层徽章 + 渐变头像 + 引文块 + 点赞胶囊 + 底部回复栏',
      '政务公告：红色报头 + 圆形编号清单 + 落款 + 旋转红章 + 备案页脚',
      '霓虹商户：深色底 + 粉青霓虹渐变 + 玻璃拟态卡 + 自绘夜景 + 悬浮下单条',
      '监控/数据面板：深色底 + 折线图 + 状态指示灯 + 时间轴',
      '专栏长文：衬线字体 + 大图 + 极简留白 + 作者卡',
    ],
    interactions: '折叠评论区 <details>、「展开全文」、板块/图集 radio 标签页、图片横向 scroll-snap、'
      + '点赞数 :checked 切换、:target 切到「评论页 / 相关阅读」第二屏、加载骨架或跑马灯动效',
  },
  xianxia: {
    appName: '天机阁', verb: '推演', resultsLabel: '卷宗',
    urlExamples: ['天机阁·卷宗/丁字第七号', '万卷楼·藏册/风物志·海隅篇'],
    tone: '仙门典籍腔：卷宗/藏册/玉简/洞府志，落款用「辑录」「按语」一类；正文以按语或跋收尾，不得出现现代名词。',
    visual: '仙门典籍的纸与朱：宣纸/绢帛底色（米白、淡青、藕荷），以朱砂与墨两色为主，云纹/回纹/缠枝做边饰；'
      + '字体偏宋楷，标题可竖排（writing-mode:vertical-rl），卷首卷尾用木轴，末页钤印或按语收束。'
      + '一切画面（云气、山形、丹青、玉简、星图）都用渐变与内联 SVG 画。',
    motifs: [
      '木轴卷轴：上下轴杆 + 纸纹 + 竖排标题 + 按语框 + 钤印',
      '玉简/简牍：竹木条 + 刻痕 + 编绳 + 竖排条目',
      '邸报：分栏条目 + 朱笔圈点 + 录事落款',
      '丹青描摹图：水墨渲染 + 题跋 + 图记',
      '榜文：朱框大字 + 赏格 + 钤印',
      '洞府志/灵物志：图鉴 + 形制表 + 习性录',
      '星图罗盘：环形刻度 + 云气 + 光点连线',
    ],
    interactions: '卷轴展开（高度/遮罩过渡）、钤印盖章（:checked 切换）、翻页「下一札」（:target 第二屏）、'
      + '按语与注解 <details> 折叠、云气 @keyframes 缓动',
  },
  wuxia: {
    appName: '江湖录', verb: '探听', resultsLabel: '邸报',
    urlExamples: ['江湖录·邸报/榜文十二', '听风阁·密报/癸卯卷三'],
    tone: '江湖邸报腔：榜文/密报/镖局行情/门派旧闻，落款用「录事」「探子」一类；不得出现现代名词。',
    visual: '江湖的皮纸与墨：皮纸/毛边纸底、墨黑正文、朱红榜文框与批注；木刻感的双线边、毛笔画影、'
      + '火漆或朱印收尾。字体偏宋/楷，条目可有「○」「◆」一类古式点号，落款用「录事」「探子」。',
    motifs: [
      '榜文：朱框双线 + 悬赏大字 + 赏格行 + 朱印',
      '邸报：要闻条 + 条目列表 + 录事按',
      '密报：短句 + 火漆印 + 线人原话',
      '镖局行情：价目表 + 镖路 + 行话脚注',
      '客栈风物：招牌 + 掌故 + 招牌菜单',
      '画影拓本：墨色画影 + 题字 + 出处',
    ],
    interactions: '榜文展开、火漆印 :checked 撕开、翻页「下一折」（:target 第二屏）、脚力行话 <details> 折叠',
  },
  fantasy: {
    appName: '贤者之镜', verb: '窥探', resultsLabel: '晶书',
    urlExamples: ['贤者之镜·晶书/第七札', '星辉塔·典藏/元素志·第三卷'],
    tone: '魔法典籍腔：晶书/典藏/札记/吟游诗篇，落款用「星辉塔」「抄录者」一类；不得出现现代名词。',
    visual: '塔与星的魔法典籍：夜空蓝紫的底、羊皮纸的内页、烫金与辉光作强调；发光首字母（illuminated capital）、'
      + '星图/符阵/水晶切面做纹样。字体偏衬线，条目配宝石色的小图标。',
    motifs: [
      '羊皮纸典藏：烫金边 + 发光首字母 + 校注辉光框',
      '星图星盘：光点连线 + 刻度环 + 塔徽',
      '水晶图鉴：切面 + 辉光 + 属性表 + 编号',
      '行会榜文：徽记 + 酬金 + 印鉴',
      '吟游诗篇：诗行 + 本事注 + 异闻',
      '炼金配方：材料表 + 步骤 + 警告框',
    ],
    interactions: '星图点亮、书页翻动（:target 第二屏）、配方步骤 <details> 折叠、图鉴 radio 标签页切换',
  },
};

/** 取风格规格（认不出回落现代）。 */
export function browserSpec(style: string): BrowserStyleSpec {
  return BROWSER_STYLE_SPECS[style] || BROWSER_STYLE_SPECS.modern;
}

/** 结果条数（提示词与规则共用一句；自绘页很吃输出预算，所以比旧口径少）。 */
export const BROWSER_RESULT_RANGE = '3-4';
/** 单页字符预算（提示词口径；数据域留 1.7 倍余量）。 */
export const BROWSER_PAGE_BUDGET = '1500-3500';

/** 输出格式骨架（按风格换标签与措辞；字段名 题/址/站/徽/色/摘/述/页 四风格一致——解析器只认一套）。 */
export function browserFormatExample(style: string): string {
  const spec = browserSpec(style);
  const tag = browserTag(style);
  const urls = spec.urlExamples;
  const fence = '`'.repeat(3);
  return [
    `<${tag}>`,
    `问：{${s(style as PhoneStyle, '搜索词', '推演之问', '探听之事', '窥探之问')}}`,
    `${spec.resultsLabel}：`,
    `- 题：{网页标题，像真标题那样具体（20-40 字）}`,
    `  址：${urls[0] || 'www.example.com/a/1'}`,
    `  站：{站点眉：站名 · 栏目}`,
    `  徽：{1 个字或 1 个 emoji——这个站点的徽记}`,
    `  色：{#RRGGBB，这个站点的主题色}`,
    `  摘：{30-50 字搜索预览，可带省略号}`,
    `  述：{80-300 字页面描述：一句话说清这页是什么，再写进页面里的关键具体信息}`,
    `  页：`,
    `  ${fence}html`,
    `  <style>{这一页的全部样式：色板 / 字体 / 纹理 / 版式 / 动效}</style>`,
    `  <div>{这一页的全部结构：顶栏 / 头图 / 标题 / 正文 / 页脚——标签与元素随意}</div>`,
    `  ${fence}`,
    `- 题：{第二条}`,
    `  址：${urls[1] || 'www.example.com/a/2'}`,
    `  站：{站点眉}`,
    `  徽：{徽记}`,
    `  色：{#RRGGBB}`,
    `  摘：{预览}`,
    `  述：{页面描述}`,
    `  页：`,
    `  ${fence}html`,
    `  {第二条的整张页面}`,
    `  ${fence}`,
    `</${tag}>`,
  ].join('\n');
}

/**
 * 【画布】——页 字段的写法。这是第十轮唯一新增的「写法」段，
 * 全是**资源约束**（自足 / 自绘 / 无脚本 / 竖屏尺寸 / 字符预算），不碰配色与版式。
 */
export function browserCanvasGuide(style: string): string {
  const spec = browserSpec(style);
  return [
    '【画布】页 是一整张手机网页，由你从零画出来。下面全是资源约束，不是风格约束——配色、字体、版式怎么排，你说了算：',
    '  · 整页自足：不引用任何外部图片 / 字体 / 脚本 / 网络资源（会被沙箱拦掉，页面会开天窗）。',
    '  · 画面自己画：渐变、纹理、噪点、图标、插画、地图、图表、印章、纹样——全部用 CSS 与内联 <svg> 画出来。',
    '  · 不写 <script>（沙箱禁脚本）。要让页面动，就用 CSS 动，这些都可用且鼓励用：',
    '      <details><summary> 折叠 ｜ <input type="radio">+<label> 标签页 ｜ :checked 勾选切换 ｜ :target 锚点子页',
    '      :hover / :active 悬停按压 ｜ @keyframes 动效 ｜ scroll-snap 横滑 ｜ conic-gradient 进度环',
    `  · 一页里尽量带一处简单交互，或藏一屏子页面（点「展开全文」「查看评论」「下一节」切到同一张网页的另一屏）——点得动才像网页，别做一张静止的图。这一界说得出口的花样：${spec.interactions}。`,
    '  · 竖屏手机：按宽 360–430、可视高约 620 设计，按一屏两屏的节奏排版；不要做成 PC 页面缩下来。',
    `  · 每页 ${BROWSER_PAGE_BUDGET} 字符（含标签）。写满会被截断——宁可少几个部件，也要把一张画完。`,
    '  · 每页至少有一处非文字的视觉元素（图 / 表 / 徽记 / 纹样 / 图表），否则不算网页。',
    '',
    `这一界整页应当长成什么样（视觉语言）：${spec.visual}`,
    '',
    '可以借用的视觉母题（灵感清单，不是模板，也可以自己另想）：',
    ...spec.motifs.map(m => `  · ${m}`),
  ].join('\n');
}

export interface BrowserTriggerArgs {
  query: string;
  roster: RosterSnapshot;
  style?: string;
}

/** ① 绿灯触发文本（position:'none'，只参与扫描、不发给 AI）。 */
export function buildBrowserTriggerText(args: BrowserTriggerArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = browserSpec(args.style || '');
  const me = args.roster.protagonistName || '主角';
  return [
    s(style,
      `【检索】${me}在手机的「${spec.appName}」里${spec.verb}了：${args.query}`,
      `【推演】${me}在「${spec.appName}」里${spec.verb}了：${args.query}`,
      `【探听】${me}在「${spec.appName}」里${spec.verb}了：${args.query}`,
      `【窥探】${me}在「${spec.appName}」里${spec.verb}了：${args.query}`),
    s(style,
      '这是主角自己发起的信息检索，接下来要按当前世界观生成若干「网页」结果。',
      '此乃主角自行发起之推演，接着须依当世设定，拟出若干「卷宗」条目。',
      '此乃主角自行打探，接着须依江湖见闻，拟出若干「邸报」条目。',
      '此乃主角自行窥探，接着须依此界设定，拟出若干「晶书」条目。'),
  ].join('\n');
}

export interface BrowserDossierArgs {
  roster: RosterSnapshot;
  query: string;
  chronicleBlocks?: string;
  storyText?: string;
  mixedRecords?: MixedRecords;
  style?: string;
}

/** ② 资料块（after_system，发给 AI）。 */
export function buildBrowserDossierText(args: BrowserDossierArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = browserSpec(args.style || '');
  const sections: string[] = [s(style,
    `【手机「${spec.appName}」检索资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」推演资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」探听资料参考（供保持世界观一致，非剧中人所知）】`,
    `【手机「${spec.appName}」窥探资料参考（供保持世界观一致，非剧中人所知）】`)];
  const g = args.roster.global;
  const envParts = [
    g.location ? `地点：${g.location}` : '',
    g.time ? `时间：${g.time}` : '',
    g.isNsfw ? '氛围：亲密进行中' : '',
  ].filter(Boolean);
  if (envParts.length) sections.push(`■ 当前位置与时间\n${envParts.join('　')}`);
  if (args.chronicleBlocks) {
    sections.push(`■ 剧情纪要（从旧到新，供衔接故事过往）\n${args.chronicleBlocks}`);
  }
  sections.push(`■ 主角档案（数据库表格）\n${contactSection(args.roster, args.roster.protagonistName || '我')}`);
  const relations = relationSection(args.roster, [args.roster.protagonistName]);
  if (relations) sections.push(`■ 人物关系（与主角）\n${relations}`);
  if (args.storyText) {
    sections.push(`■ 最近正文进展（供衔接剧情）\n${args.storyText}`);
  }
  if (args.mixedRecords?.body) {
    sections.push(mixedRecordSection(
      s(style, '主角的手机消息/通话/朋友圈动态', '主角的符讯/传音/百晓阁风闻', '主角的书信/传声/茶馆风声', '主角的晶讯/远语/诗社见闻'),
      args.mixedRecords,
    ));
  }
  sections.push(s(style,
    `■ 本次检索\n主角在「${spec.appName}」里${spec.verb}的词是：${args.query}\n（结果须像这个世界里真实存在的网页/卷宗/邸报/晶书：各有各的站点与视觉，页面要画得像真的；与已有剧情冲突的内容不要写。）`,
    `■ 本次推演\n主角在「${spec.appName}」里推演之问是：${args.query}\n（卷宗须像此界真实存在的记载：各有各的藏处与形制，卷面要画得像真的；与已有剧情冲突的内容不要写。）`,
    `■ 本次探听\n主角在「${spec.appName}」里打探之事是：${args.query}\n（邸报须像江湖中真实流传的消息：各有各的出处与形制，报面要画得像真的；与已有剧情冲突的内容不要写。）`,
    `■ 本次窥探\n主角在「${spec.appName}」里窥探之问是：${args.query}\n（晶书须像此界真实存在的典藏：各有各的塔与形制，书页要画得像真的；与已有剧情冲突的内容不要写。）`));
  return sections.join('\n\n');
}

export interface BrowserInstructionArgs {
  roster: RosterSnapshot;
  query: string;
  extraPrompt?: string;
  style?: string;
}

/** ③ 指令（user_input）：格式骨架 + 画布写法 + 规则编号 + 风格调性 + 附加要求。 */
export function buildBrowserInstruction(args: BrowserInstructionArgs): string {
  const style = (args.style || '') as PhoneStyle;
  const spec = browserSpec(args.style || '');
  const me = args.roster.protagonistName || '主角';
  const rules = [
    `这是「${spec.appName}」的${spec.verb}结果页：主角${me}${spec.verb}了「${args.query}」。请直接给出结果，不要解释、不要旁白、不要问问题。`,
    `输出 ${BROWSER_RESULT_RANGE} 条；每条的字段固定为 题 / 址 / 站 / 徽 / 色 / 摘 / 述 / 页 八项（页 是围栏里的整张网页）。字段名不要改字。`,
    '每条都是一整张网页：从顶栏（站名、栏目、可点元素）到页脚（署名、版权、备案一类收尾），中间怎么排由你定。',
    `这 ${BROWSER_RESULT_RANGE} 条的**视觉基调必须明显不同**——不许同一套配色、同一套版式换了文字再来一遍；站点、行业、气质都要不一样，让人一眼看出是在逛不同的网站。`,
    `页 用 ${'`'.repeat(3)}html 围栏包起来（围栏单独占一行），整页 ${BROWSER_PAGE_BUDGET} 字符，具体写法见【画布】。`,
    '一页里尽量带一处简单交互，或藏一屏子页面（展开全文 / 查看评论 / 下一节），用 CSS 实现——点得动的才像网页。',
    `摘 是搜索结果列表里的一句预览（30-50 字，可带省略号）；述 是分享给好友时**好友唯一读得到的内容**（80-300 字）：先用一句话说清这页是什么，再尽量把页面里的**关键具体信息**写进去——人名、地名、时间、数字、结论、原话摘录、清单要点，让没打开过这页的人也拿得到干货。不要写「本文/本页」这类元话语，不要复述标题。`,
    '徽 是 1 个字或 1 个 emoji（站点徽记），色 是 #RRGGBB（站点主题色）——这两个只给结果列表的色块用，不参与页面本体。',
    `址 用这个世界里像真的的形态：${spec.urlExamples.map(u => `「${u}」`).join('、')}；只是给主角看的地址，不会被真正打开。`,
    `全部内容都要贴合当前世界观与故事进展：${spec.tone}`,
    `任意搜索词都要能编出结果（哪怕词很怪、很随意）——这就是这个「${spec.appName}」的乐趣；但不得与已发生的剧情矛盾。`,
    `整个块用 <${browserTag(args.style || '')}> 包起来。`,
  ];
  const extra = String(args.extraPrompt || '').trim();
  if (extra) rules.push(extra);
  return [
    s(style,
      `【任务】模拟手机「${spec.appName}」给出一次检索结果`,
      `【任务】模拟手机「${spec.appName}」给出一次推演结果`,
      `【任务】模拟手机「${spec.appName}」给出一次探听结果`,
      `【任务】模拟手机「${spec.appName}」给出一次窥探结果`),
    browserFormatExample(args.style || ''),
    browserCanvasGuide(args.style || ''),
    '【规则】',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
  ].join('\n\n');
}

/** 输出协议标签（四风格别名组；解析器与提示词共用一份）。 */
export { BROWSER_TAG_BY_STYLE };
