// ===== 不夜城提示词层（三段式：绿灯触发 / 资料块 / 指令模板；契约由 tests/phone-night-prompts.test.ts 锁定） =====
// 设计纪律（对齐 docs/18 §15 与社媒提示词纪律）：
//  - 只做要求不做解释；反 AI 腔禁词表；时间**一律绝对故事时间**（相对化只在渲染层做）；数据可信；防重复摘要。
//  - v2 新增 7 条（NSFW 特化 + 只读单向域）：① 直白条款 ② 尺度一致性 ③ 角色一致性 ④ 档案底线（拒单即内容）
//    ⑤ 反全知 ⑥ 零回写声明 ⑦ 单次推进契约。这八条由 core/night-prompt-slots 的 NIGHT_RULES 统一注入，每个 mode 都带。
//  - v2.1（2026-09-30 人设一致性修订，修复"人物偏离正文人设"）：尺度档从「任务」改为「上限」——路人按档写满，
//    名单角色按人设决定参与深度；「角色一致」扩到性格/语气/性观念并确立**人设优先**；新增第 8 条「资料冲突以正文为准」；
//    persona 档案卡禁止凭空发明偏好（存量卡随 schema 1→2 一次性丢弃，见 night-model）。
//  - 板块 brief / 尺度档 / 受控标签词表只进提示词，界面只显示名字与颜色（D4）。
//  - 只读单向域：本层不认识世界书/时间线/其它 App；"手机已有内容"以**纯函数入参**形式传入（buildNightReadonlySection），
//    由引擎从 readPhoneData() 取字段——不 import 任何投影模块。

import { excerptText } from './ubp-utils';
import type { RosterSnapshot } from './roster';
import { transferAiAmount, type PhoneStyle } from './chat-model';
import { contactSection, relationSection } from './chat-prompts';
import { ANTI_AI_WORDS_RULE } from './social-prompt-templates';
import { formatStampFull } from './social-time';
import { pickRandom } from './social-prompts';
import {
  NIGHT_BOARDS,
  NIGHT_TAG_GROUPS,
  nt,
  nightBoardDef,
  nightBoardName,
  nightSpiceBrief,
  nightSpiceLabel,
  type NightSpice,
} from './night-config';
import type {
  NightData,
  NightDm,
  NightDate,
  NightLive,
  NightPersona,
  NightPost,
} from './night-model';

// ─── 契约标记与 mode 全集 ───

// 契约标签集中到 core/protocol-tags（单一事实源）；import 后原样 re-export，既有 import 路径不变。
import { NIGHT_CLOSE_TAG, NIGHT_OPEN_TAG } from './protocol-tags';
export { NIGHT_CLOSE_TAG, NIGHT_OPEN_TAG };

// mode 全集与分组已下沉到 core/night-config（提示词编辑与引擎共用）；这里只做既有路径的 re-export。
import type { NightMode } from './night-config';
export { NIGHT_MODES, NIGHT_MODE_LABELS } from './night-config';
export type { NightMode };

// 可编辑提示词（玩法任务/规则、总纪律、板块 brief）统一由 core/night-prompt-slots 承载。
import {
  NIGHT_RULES_KEY,
  nightBoardPromptKey,
  nightModePromptKey,
  renderNightPromptTemplate,
  resolveNightPromptText,
} from './night-prompt-slots';
export { NIGHT_RULES, NIGHT_VOLUME_RULE } from './night-prompt-slots';

// ─── 受控标签词表（进提示词；AI 只能从这里选） ───

/** 标签候选列表（分组呈现，AI 只能取用其中的词）。 */
export function nightTagCatalogText(): string {
  return NIGHT_TAG_GROUPS.map(g => `　${g.label}：${g.tags.join(' / ')}`).join('\n');
}

/** 标签纪律句（每帖 3-6 个，词表外一律丢弃）。 */
export const NIGHT_TAG_RULE = `tags 只能从上表取用 3-6 个，不得自造标签，不得写近义词或英文；同一帖内不得重复。`;

// ─── 尺度段 ───

/** 资料块的「尺度与内容边界」段（上限只有板块自己的 spiceMax，见板块段）。 */
export function buildNightSpiceSection(spice: NightSpice): string {
  return [
    `本次尺度档：${nightSpiceLabel(spice)}（${spice}/3）`,
    nightSpiceBrief(spice),
    '路人内容一律落在这一档内，档位越高越直白，不许用省略号、黑幕、"不可描述"等方式回避过程；名单角色的露骨程度按其人设定档（保守角色可只擦边、围观或不出场），但同样不得越档。',
  ].join('\n');
}

// ─── 只读参考资料（手机已有内容节选；纯函数入参，本层不读存储） ───

export interface NightReadonlyMsg {
  from: string;
  type: string;
  content: string;
  amount?: string;
  /** 转账/红包币种名快照（货币系统联动）。 */
  currency?: string;
}

export interface NightReadonlyConv {
  kind: 'private' | 'group';
  title: string;
  members: string[];
  messages: NightReadonlyMsg[];
}

export interface NightReadonlyArgs {
  me: string;
  conversations: NightReadonlyConv[];
  calls?: Array<{ peer: string; kind: string; duration?: string }>;
  /** 既有社媒帖摘要行（贴吧/微博/小红书标题或正文节选）。 */
  socialLines?: string[];
  /** 取多少条（混合口；默认 12）。 */
  count?: number;
}

/** 单条手机消息 → 一行摘要（富媒体给类型前缀，与聊天记录段口径一致）。 */
function readonlyMsgLine(msg: NightReadonlyMsg): string {
  const who = msg.from === 'me' ? '我' : msg.from;
  switch (msg.type) {
    case 'image': return `${who}：[图片]${msg.content}`;
    case 'voice': return `${who}：[语音]${msg.content}`;
    case 'transfer': return `${who}：[转账]${transferAiAmount(msg.amount, msg.currency)}`;
    case 'redpacket': return `${who}：[红包]${msg.content}`;
    default: return `${who}：${msg.content}`;
  }
}

/**
 * 只读参考资料段（只读单向域的"入"侧证据）：主角手机里已有的微信消息/通话/社媒摘要。
 * 段头写明用途与禁止事项——供世界一致性参考，任何角色不得表现出知道主角的私聊内容。
 */
export function buildNightReadonlySection(args: NightReadonlyArgs): string {
  const count = Math.max(1, Math.min(40, args.count ?? 12));
  const lines: string[] = [];
  for (const conv of args.conversations) {
    const msgs = conv.messages.slice(-Math.max(1, Math.ceil(count / 2)));
    if (!msgs.length) continue;
    const label = conv.kind === 'group' ? `${conv.title}（群·${conv.members.slice(0, 4).join('、')}）` : conv.title;
    lines.push(`· ${label}：${msgs.map(readonlyMsgLine).join('；')}`);
    if (lines.length >= 4) break;
  }
  for (const call of (args.calls || []).slice(0, 3)) {
    lines.push(`· 与${call.peer}的通话（${call.kind}${call.duration ? `·${call.duration}` : ''}）`);
  }
  for (const line of (args.socialLines || []).slice(0, 6)) lines.push(`· ${line}`);
  if (!lines.length) return '';
  return [
    '■ 只读参考资料（主角手机里已有内容的节选，仅供保持世界一致：人物近况、正在发生的事、地点时间口径）',
    lines.slice(0, count).join('\n'),
    '该段任何角色都不得表现出读过主角的私聊或通话；只能用于让内容不与手机里已发生的事冲突。',
  ].join('\n');
}

/** 既有社媒帖 → 摘要行（引擎从 readPhoneData().social 取，纯函数转换）。 */
export function nightSocialDigestLines(social: { tieba?: Array<{ title?: string }>; weibo?: Array<{ text?: string }>; xhs?: Array<{ title?: string }>; moments?: Array<{ text?: string }> } | null | undefined): string[] {
  if (!social) return [];
  const out: string[] = [];
  for (const p of (social.tieba || []).slice(0, 4)) if (p.title) out.push(`贴吧：${p.title}`);
  for (const p of (social.weibo || []).slice(0, 3)) if (p.text) out.push(`微博：${String(p.text).slice(0, 40)}`);
  for (const p of (social.xhs || []).slice(0, 3)) if (p.title) out.push(`小红书：${p.title}`);
  for (const p of (social.moments || []).slice(0, 3)) if (p.text) out.push(`朋友圈：${String(p.text).slice(0, 40)}`);
  return out;
}

// ─── 绿灯触发文本 ───

export interface NightTriggerArgs {
  /** 参与扫描的角色名（引擎每次随机抽 N 个：轮换激活不同角色条目）。 */
  names: string[];
  /** 最新 1 层正文（过上下文标签剥离，全量参与扫描）。 */
  storyText: string;
  /** 额外触发词（点单内容/约会对象名等场景词；可选）。 */
  extra?: string;
}

/** 绿灯触发文本（position:'none' + should_scan:true；只参与世界书扫描，不进提示词）。 */
export function buildNightTriggerText(args: NightTriggerArgs): string {
  return [args.names.join(' '), args.storyText, (args.extra || '').trim()]
    .map(p => (p || '').trim())
    .filter(Boolean)
    .join(' ');
}

/** 本次生成随机抽的角色名（进扫描；同 social 的 socialTriggerContacts 口径）。 */
export function pickNightNames(pool: readonly string[], count: number, rand: () => number = Math.random): string[] {
  return count <= 0 ? [] : pickRandom(pool, count, rand);
}

// ─── 资料块 ───

export interface NightDossierArgs {
  roster: RosterSnapshot;
  /** 本次请求的尺度档（已按板块上限降录；板块段自带各自的 spiceMax）。 */
  spice: NightSpice;
  /** 本次涉及的板块（非空时注入板块设定段；多板块=整版刷新）。 */
  boards?: string[];
  /** 剧情纪要块（空串=不带）。 */
  chronicleBlocks: string;
  /** 最近 N 层正文（过上下文标签剥离；空串=不带）。 */
  storyText: string;
  /** 出场角色档案名单（≤10 人截断；空=全部通讯录）。 */
  castNames?: string[];
  /** 既有内容摘要（防重复；refresh/board 传同板块旧帖标题）。 */
  digest?: string[];
  /** 只读参考资料段（buildNightReadonlySection 产物；空串=不带）。 */
  readonlySection?: string;
  /** 场景上下文段（点单/约会/私信/私密房时的在场上下文；空串=不带）。 */
  sceneSection?: string;
  /** 角色档案卡（有则注入「档案底线」段——点单被拒的依据）。 */
  personas?: NightPersona[];
  /** 用户自定义提示词（提示词编辑 · 不夜城；键=night:board:<板块>；空/缺省=内置默认）。 */
  promptOverrides?: Record<string, string>;
  style?: PhoneStyle;
}

/** 资料块出场角色上限（token 控制）。 */
export const NIGHT_CAST_CAP = 10;

/** 档案卡人读行（点单/约会/私信涉及的角色注入；底线是拒单依据）。 */
export function nightPersonaLine(persona: NightPersona): string {
  const body = [
    persona.body.height ? `身高${persona.body.height}` : '',
    persona.body.build ? persona.body.build : '',
    persona.body.bust ? `胸围${persona.body.bust}` : '',
    persona.body.waist ? `腰${persona.body.waist}` : '',
    persona.body.hips ? `臀${persona.body.hips}` : '',
  ].filter(Boolean).join('·');
  const lines = [`· ${persona.name}${body ? `（${body}）` : ''}　接受度：${'★'.repeat(persona.acceptance)}　可接受尺度：${nightSpiceLabel(persona.spiceMax)}`];
  if (persona.appearance) lines.push(`　外貌：${persona.appearance.slice(0, 120)}`);
  if (persona.likes.length) lines.push(`　偏好：${persona.likes.join('、')}`);
  if (persona.limits.length) lines.push(`　底线（不可跨越，越界一律合规拒绝）：${persona.limits.join('、')}`);
  if (persona.signature) lines.push(`　签名/口头禅：${persona.signature}`);
  return lines.join('\n');
}

/** 主角身材/外貌行（主角也参与内容时的画面与感受依据）。 */
function protagonistLine(roster: RosterSnapshot): string {
  const p = roster.protagonist;
  const body = roster.bodyData[roster.protagonistName];
  const parts = [
    p.gender ? `性别：${p.gender}` : '',
    p.age ? `年龄：${p.age}` : '',
    p.appearance ? `外貌：${p.appearance.slice(0, 80)}` : '',
  ].filter(Boolean);
  if (body?.heightWeight) parts.push(`体型：${body.heightWeight}`);
  if (body?.measure) parts.push(`三围：${body.measure}`);
  return parts.length ? parts.join('　') : '（主角档案未提供，外貌以正文为准）';
}

/** 板块设定段（brief 只进提示词；用户可改 brief，板块名/上限/图文策略固定）。 */
export function buildNightBoardSection(boardIds: readonly string[], promptOverrides?: Record<string, string>): string {
  const ids = boardIds.filter(Boolean).slice(0, 6);
  if (!ids.length) return '';
  const lines = ids.map(id => {
    const def = nightBoardDef(id);
    if (!def) return '';
    const brief = resolveNightPromptText(nightBoardPromptKey(id), promptOverrides);
    return `· ${def.name.modern}：${brief}\n　图文策略：${def.imageMode === 'must' ? '每条必带 1-3 张图' : '按全局图文比决定是否配图'}；本板块尺度上限 ${nightSpiceLabel(def.spiceMax)}`;
  }).filter(Boolean);
  return lines.length ? `■ 本次板块设定（只用于写作，界面按氛围化名字展示）\n${lines.join('\n')}` : '';
}

/** 资料块（after_system + should_scan:false 注入）。 */
export function buildNightDossierText(args: NightDossierArgs): string {
  const sections: string[] = ['【不夜城资料参考（供保持人物与世界一致，非剧中人所知）】'];
  const g = args.roster.global;
  const envParts = [g.location ? `地点：${g.location}` : '', g.time ? `时间：${g.time}` : ''].filter(Boolean);
  if (envParts.length) sections.push(`■ 当前位置与时间\n${envParts.join('　')}`);
  sections.push(`■ 本次尺度档与内容边界\n${buildNightSpiceSection(args.spice)}`);
  const boardSection = buildNightBoardSection(args.boards || [], args.promptOverrides);
  if (boardSection) sections.push(boardSection);
  sections.push(`■ 受控标签词表（tags 只能取用其中的词）\n${nightTagCatalogText()}\n${NIGHT_TAG_RULE}`);
  if (args.chronicleBlocks) sections.push(`■ 剧情纪要（从旧到新，供衔接故事过往）\n${args.chronicleBlocks}`);
  const all = args.castNames?.length ? args.castNames : args.roster.contacts.map(c => c.name);
  const cast = all.slice(0, NIGHT_CAST_CAP);
  if (cast.length) {
    // 身材行单列（NSFW信息表 身高体重/三围）：画面描述与正文描写都要与故事里是同一个身体（N5）
    const castLines = cast.map(m => {
      const base = contactSection(args.roster, m);
      const body = args.roster.bodyData[m];
      const bodyLine = [body?.heightWeight ? `身高体重：${body.heightWeight}` : '', body?.measure ? `三围/罩杯：${body.measure}` : ''].filter(Boolean).join('　');
      return bodyLine ? `${base}\n　身材（NSFW信息表，画面与文字一律照此）：${bodyLine}` : base;
    });
    sections.push(`■ 出场角色档案（数据库表格${all.length > cast.length ? `，共 ${all.length} 人仅列前 ${cast.length} 人` : ''}）\n${castLines.join('\n')}\n· 主角：${args.roster.protagonistName}　${protagonistLine(args.roster)}`);
  } else {
    sections.push(`■ 主角档案\n· 主角：${args.roster.protagonistName}　${protagonistLine(args.roster)}`);
  }
  if (args.personas?.length) {
    sections.push(`■ 角色档案卡（含底线，越界一律合规拒绝；点单/约会的判定依据）\n${args.personas.map(nightPersonaLine).join('\n')}`);
  }
  const relations = relationSection(args.roster, [args.roster.protagonistName, ...cast]);
  sections.push(`■ 人物关系（与主角及彼此）\n${relations}`);
  if (args.storyText) sections.push(`■ 最近正文进展（供衔接剧情）\n${args.storyText}`);
  if (args.readonlySection) sections.push(args.readonlySection);
  if (args.digest?.length) {
    sections.push(`■ 已有内容摘要（选题与标题撞车一律换新）\n${args.digest.slice(0, 12).join('\n')}`);
  }
  if (args.sceneSection) sections.push(args.sceneSection);
  return sections.join('\n\n');
}

// ─── 场景上下文段（点单/约会/私信/私密房；引擎拼好传入） ───

/** 直播间场景段（含点单台规则要点）。 */
export function buildLiveSceneSection(live: NightLive, me: string, opts: { privateMode?: boolean } = {}): string {
  const top = live.rank[0];
  const lines: string[] = [
    `台主：${live.streamer}${live.byMe ? '（主角自己的台，署名=马甲）' : ''}　台名：${live.title}`,
    `状态：${live.status === 'live' ? '正在开台' : live.status === 'idle' ? '尚未开台（预告）' : '已结束'}　已推进 ${live.round}/${live.maxRound} 轮　热度 ${live.heat}　在线 ${live.viewers}`,
    `标签：${live.tags.join('、') || '无'}　尺度：${nightSpiceLabel(live.spice)}`,
  ];
  if (live.barrage.length) {
    lines.push(`最近弹幕：${live.barrage.slice(-6).map(b => `${b.name}：${b.text}`).join('；')}`);
  }
  if (top) lines.push(`打赏榜第一：${top.name}（累计 ${top.amount}）；主角${top.name === me ? '就是榜首（榜一特权：下一单必不拒绝、可进私密房、台词里要用专属称呼）' : '不是榜首'}`);
  if (live.orders.length) {
    lines.push(`最近点单：${live.orders.slice(-3).map(o => `${o.from}「${o.text}」→${o.accepted ? '已接受' : `拒绝（${o.rejectReason || '底线'}）`}`).join('；')}`);
  }
  if (opts.privateMode) lines.push('当前处于私密房：只有台主与主角两个人，弹幕停屏，台主只对主角说话。');
  return `■ 直播间场景\n${lines.join('\n')}`;
}

/** 私信场景段。 */
export function buildDmSceneSection(dm: NightDm, me: string, persona?: NightPersona | null): string {
  const lines: string[] = [
    `对方：${dm.peer}${dm.online ? '（在线）' : ''}${dm.sourceLabel ? `　来源：${dm.sourceLabel}` : ''}${dm.distanceLabel ? `　距离：${dm.distanceLabel}` : ''}`,
  ];
  const recent = dm.msgs.slice(-8);
  if (recent.length) lines.push(`最近对话（旧→新）：\n${recent.map(m => `${m.from === 'me' ? `${me}（我）` : dm.peer}：${m.type === 'image' ? `[图片]${m.text || ''}` : m.type === 'date' ? '[约见卡]' : m.type === 'card' ? `[礼物]${m.card?.title || ''}` : (m.text || '')}`).join('\n')}`);
  else lines.push('（还没有对话，这是第一轮）');
  if (persona) lines.push(`对方档案（底线是拒绝依据）：\n${nightPersonaLine(persona)}`);
  return `■ 搭话场景\n${lines.join('\n')}`;
}

/** 约会场景段（含已走节点与本次选择）。 */
export function buildDateSceneSection(date: NightDate, persona?: NightPersona | null): string {
  const lines: string[] = [
    `约会对象：${date.peer}　地点：${date.place || '待定'}　约定的由头：${date.note || '见面'}`,
    `进度：第 ${date.step}/${date.maxStep} 个节点　状态：${date.status === 'ongoing' ? '进行中' : date.status === 'paused' ? '中途暂停' : date.status === 'done' ? '已收尾' : '尚未开始'}`,
  ];
  if (date.nodes.length) {
    lines.push(`已发生的节点（旧→新）：\n${date.nodes.map((n, i) => `${i + 1}. ${n.scene.slice(0, 60)}${n.choice ? `（主角选择：${n.choice.picked !== undefined ? n.choice.options[n.choice.picked] : '未选'}）` : ''}`).join('\n')}`);
  }
  const last = date.nodes[date.nodes.length - 1];
  if (last?.choice && last.choice.picked === undefined) {
    lines.push('注意：上一个节点的两选主角还没做出选择——本次推进必须顺着「保持距离」与「更进一步」的中间地带写，不要替主角决定。');
  } else if (last?.choice && last.choice.picked !== undefined) {
    lines.push(`上一个节点主角选择了「${last.choice.options[last.choice.picked]}」——本次节点基调必须建立在这个选择之上。`);
  }
  if (persona) lines.push(`对方档案（底线是拒绝依据）：\n${nightPersonaLine(persona)}`);
  return `■ 约会场景\n${lines.join('\n')}`;
}

// ─── 指令模板（user_input） ───

export interface NightInstructionArgs {
  mode: NightMode;
  roster: RosterSnapshot;
  spice: NightSpice;
  /** 整版/板块/关键词等定点参数。 */
  focus?: { board?: string; keyword?: string; postId?: string; postTitle?: string; postContent?: string; postTags?: string[]; liveId?: string; streamer?: string; orderText?: string; tier?: string; dmPeer?: string; dateId?: string; commissionWant?: string; unlockImageDesc?: string };
  /** 本次抽中的板块（整版刷新=2-3 个；定点=1 个）。 */
  boards: string[];
  /** 用户额外要求（设置 extraPrompt 或一次性提示）。 */
  extraPrompt?: string;
  /** 主角马甲名（主角发言时的署名）。 */
  alias?: string;
  /** 用户自定义提示词（提示词编辑 · 不夜城；键=night:<玩法>/night:rules；空/缺省=内置默认）。 */
  promptOverrides?: Record<string, string>;
  style?: PhoneStyle;
}

/** 输出格式契约（每个 mode 一段；块内只有一个 JSON 对象）。 */
export function nightFormatOf(mode: NightMode): string {
  const postShape = '{"board":"板块id","kind":"text|gallery|bounty","title":"标题≤20字","content":"正文40-160字","tags":["标签3-6个"],"spice":1|2|3,"author":"发帖人","images":[{"desc":"画面描述（含谁/在哪/穿没穿/什么姿势/光线）"}],"comments":[{"name":"评论人","c":"评论10-40字","reply":"被回复人名（顶层省略）","t":"绝对时间"}],"time":"绝对时间"}';
  switch (mode) {
    case 'refresh':
    case 'board':
    case 'more':
    case 'keyword':
      return `{"boards":["darkroom","nighttalk","city","backstage","forbidden","rooftop"],"posts":[${postShape}]}`;
    case 'post':
      return '{"comments":[{"name":"评论人","c":"评论10-40字","reply":"被回复人名（顶层省略）","t":"绝对时间"}]}';
    case 'live':
      return '{"lives":[{"streamer":"台主名","title":"台名≤20字","tags":["标签"],"spice":1|2|3,"coverDesc":"画面描述","status":"idle|live","viewers":1200,"heat":8600,"rank":[{"name":"打赏人名","gift":"🌹","amount":320}],"barrage":[{"name":"观众名","text":"弹幕≤20字"}]}]}';
    case 'private':
      return '{"lines":["台主台词（≤4句）"],"barrages":[{"name":"观众名","text":"弹幕"}],"heat":320,"reply":"台主对主角说的话"}';
    case 'order':
      return '{"accepted":true|false,"rejectReason":"拒单理由（accepted=false 时必填，写成台词）","tier":"口头|动作|专场","reply":"台主回应（≤2句）","lines":["台主台词（≤4句）"],"barrages":[{"name":"观众名","text":"弹幕5-10条"}],"heat":260}';
    case 'dm':
      return '{"online":true,"sourceLabel":"来自「暗房」","distanceLabel":"同城·6km","msgs":[{"from":"peer","text":"一条消息≤60字","image":{"desc":"图面描述（可选）"},"card":{"title":"礼物名（可选）"}}]}';
    case 'date':
      return '{"place":"当前或下一地点","note":"本次由头一句话","scene":"这一段的场景描写80-200字","lines":["对白（双方，注明谁说的）"],"choice":{"options":["两选之一","两选之二"]},"spice":1|2|3,"time":"绝对时间"}';
    case 'persona':
      return '{"appearance":"外貌要点≤60字","body":{"height":"162cm","build":"纤细","bust":"C","waist":"58cm","hips":"88cm"},"likes":["偏好≤4个词"],"limits":["底线≤4个词"],"acceptance":1|2|3,"spiceMax":1|2|3,"signature":"一句话口头禅≤20字","posts":128,"works":6}';
    case 'aboutMe':
      return '{"items":[{"board":"板块id","kind":"about","title":"标题≤20字","content":"正文40-160字","tags":["标签"],"spice":1|2|3,"author":"发帖人","sourceHint":"来源线索（一句话，如「来自：你和他在楼道里说的那句话」，禁止写楼层号）","images":[{"desc":"画面描述"}],"comments":[{"name":"评论人","c":"评论","t":"绝对时间"}],"time":"绝对时间"}]}';
    case 'commission':
      return '{"entries":[{"author":"应征人","text":"应征正文≤120字","spice":1|2|3,"image":{"desc":"图面描述（求图类必填）"}}]}';
    case 'unlock':
      return '{"grant":true|false,"reply":"作者/台主的一句话回应（≤40字）","comments":[{"name":"回应人","c":"回应10-40字","t":"绝对时间"}]}';
    default:
      return '{"alias":"马甲名≤8字","signature":"一句话签名≤20字","level":3,"coins":260}';
  }
}

/** 输出格式段（块外无文字；块内单一 JSON）。 */
function formatSection(mode: NightMode): string {
  return `【输出格式】（严格遵守）\n只输出一个 ${NIGHT_OPEN_TAG} 块，块外不要有任何文字，块内是一个 JSON 对象：\n${NIGHT_OPEN_TAG}\n${nightFormatOf(mode)}\n${NIGHT_CLOSE_TAG}`;
}

/** 马甲纪律（主角在本 App 的匿名身份；不得暴露真名）。 */
function aliasRule(alias: string | undefined): string {
  const a = (alias || '').trim();
  if (!a) return '主角在本应用的署名是马甲（资料块未提供时，用一个生活化的匿名网名）；严禁出现主角的真名。';
  return `${a}（即 {{user}}，我方）在本应用的署名是马甲「${a}」——以主角身份发帖/评论/点单/发消息时一律署名「${a}」，严禁出现主角的真名。`;
}

/** 本次生成的可渲染参数（占位符 → 实际值；与改造前 modeBody 的动态段同口径）。 */
function nightPromptVars(args: NightInstructionArgs): Record<string, string> {
  const style = args.style || '';
  return {
    应用: nt('app', style),
    街区: nt('street', style),
    帖子: nt('post', style),
    舞台: nt('stage', style),
    台主: nt('streamer', style),
    搭话: nt('dm', style),
    约会: nt('date', style),
    马甲: nt('alias', style),
    马甲说明: aliasRule(args.alias),
    本次板块名: args.boards.map(id => nightBoardName(id, style)).join('、'),
    全部板块ID: NIGHT_BOARDS.map(b => b.id).join(' / '),
    板块ID: args.boards[0] || 'darkroom',
    关键词: (args.focus?.keyword || '').trim(),
    原帖标题: (args.focus?.postTitle || '').trim() || '（见资料块）',
    原帖正文: (args.focus?.postContent || '').trim().slice(0, 80),
    点单发起人: args.focus?.orderText ? '主角' : '观众',
    台主名: (args.focus?.streamer || '').trim(),
    私密台主名: (args.focus?.streamer || '').trim() || '台主',
    点单内容: (args.focus?.orderText || '').trim(),
    加码档: args.focus?.tier || '口头',
    对方名: (args.focus?.dmPeer || '').trim() || '对方',
    节点: args.focus?.dateId ? 'next' : '1',
    角色名: (args.focus?.streamer || '').trim() || '这位角色',
    委托内容: (args.focus?.commissionWant || '').trim(),
    发帖人: (args.focus?.streamer || '').trim() || '发帖人',
    求解锁图描述: (args.focus?.unlockImageDesc || '').trim().slice(0, 60),
  };
}

/** 指令模板（user_input）：任务 + 专属规则 + 总纪律 + 格式 + 说人话 + 额外要求。 */
export function buildNightInstruction(args: NightInstructionArgs): string {
  const style = args.style || '';
  const spiceName = nightSpiceLabel(args.spice, style);
  const app = nt('app', style);
  const extra = (args.extraPrompt || '').trim() ? `\n\n【额外要求】\n${args.extraPrompt!.trim()}` : '';
  const head = `【平台】${app}——${nt('slogan', style)}：一个只存在于主角手机里的成人向夜生活综合体（${nt('street', style)}论坛 + ${nt('stage', style)} + ${nt('dm', style)}）。本次尺度档：${spiceName}。`;
  // 可编辑正文（任务+规则）与总纪律：覆盖优先、空白回落内置；占位符按本次参数渲染。
  const vars = nightPromptVars(args);
  const body = renderNightPromptTemplate(resolveNightPromptText(nightModePromptKey(args.mode), args.promptOverrides), vars);
  const rules = renderNightPromptTemplate(resolveNightPromptText(NIGHT_RULES_KEY, args.promptOverrides), vars);
  return `${head}\n\n${body}\n\n【总纪律】（任何 mode 都不得违反）\n${rules}\n\n${formatSection(args.mode)}\n\n【说人话】像真人在深夜的成人论坛/直播间里说话：大白话、带情绪、贴着具体的人和事。${ANTI_AI_WORDS_RULE}${extra}`;
}

/** 提示词里"已有内容摘要"行（防重复；引擎从旧帖构造）。 */
export function nightDigestLines(posts: readonly NightPost[], limit = 12): string[] {
  return posts.slice(0, limit).map(p => `${nightBoardName(p.board)}|${p.author}：${(p.title || p.content).slice(0, 24)}`);
}

/** 直播间摘要行（防重复开台用）。 */
export function nightLiveDigestLines(lives: readonly NightLive[], limit = 8): string[] {
  return lives.slice(0, limit).map(l => `${l.streamer}：${l.title}`);
}

/** 私信会话摘要行（搭话列表防重复用）。 */
export function nightDmDigestLines(dms: readonly NightDm[], limit = 8): string[] {
  return dms.slice(0, limit).map(d => `${d.peer}${d.sourceLabel ? `（${d.sourceLabel}）` : ''}`);
}

/** 主角马甲未生成时的兜底署名（渲染与本地动作共用；引擎生成后以 me.alias 为准）。 */
export function nightFallbackAlias(): string {
  const pool = ['楼下便利店的三花', '深夜加班狗', '夜班末班车', '巷口的路灯', '三点还没睡'];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 帖子内容 → 提示词里的一行（点单/约会引用原帖时用）。 */
export function nightPostRefLine(post: NightPost, style: PhoneStyle = ''): string {
  return `${nightBoardName(post.board, style)}「${post.title || nightExcerptOf(post.content)}」（${post.author}，尺度 ${nightSpiceLabel(post.spice, style)}）`;
}

function nightExcerptOf(text: string): string {
  return excerptText(text, 20);
}

/** 时间标签提示（把当前时间往回推；所有 mode 共用同一句）。 */
export const NIGHT_TIME_HINT = '所有时间字段填绝对故事时间（把资料块「当前位置与时间」的当前时间往前推几分钟到几小时），禁止相对措辞与真实日期。';

/** 绝对时间戳 → 人读（资料块场景段复用）。 */
export function nightStampText(stamp?: string): string {
  return stamp ? (formatStampFull(stamp) || stamp) : '';
}

/** 风格名（板块/平台术语）导出给渲染层复用（避免两处事实源）。 */
export function nightStyleTerms(style: PhoneStyle): { app: string; street: string; post: string; stage: string; streamer: string; tip: string; dm: string; order: string; date: string; alias: string; reveal: string; live: string } {
  return {
    app: nt('app', style), street: nt('street', style), post: nt('post', style), stage: nt('stage', style),
    streamer: nt('streamer', style), tip: nt('tip', style), dm: nt('dm', style), order: nt('order', style),
    date: nt('date', style), alias: nt('alias', style), reveal: nt('reveal', style), live: nt('live', style),
  };
}

/** 只读域声明行（设置页与 App 底部常驻；两处同源）。 */
export const NIGHT_READONLY_NOTE = '不夜城是单向的：只读正文与手机已有内容，不写世界书、不接入正文、不通知任何角色。';

/** 应用内常驻氛围声明（我的页底部）。 */
export const NIGHT_STANDING_LINE = '这里发生的事，只在你手机上。不会写进故事，也不会有角色知道。';

export type { NightData };
