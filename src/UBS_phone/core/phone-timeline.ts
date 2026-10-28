// ===== 最近手机记录混合时间线（微信消息 + 通话记录 + 朋友圈动态 + 社媒帖子，按时间混排） =====
// 聊天/通话/社媒三个 AI 请求共用同一份「最近发生了什么」上下文：角色的反应不止受当前互动项目影响，
// 最近的其他手机活动同样影响（与 A 聊天会被上午和 A 的通话影响）。
// 取量口径（用户定案）：微信消息 / 通话记录头+每行转写 / 朋友圈与社媒帖子=主贴+每条评论 各算 1 条，
// 从最新往旧取满 count 条；边界落在通话或帖子上时不截断——整条带入（允许超出 count）。
// 社媒收录口径（用户定案）：朋友圈与贴吧/微博/小红书帖子，发帖人=主角或名单角色，或名单角色参与过
// （评论/回复；点赞不算）——角色评论过的路人帖整条带入（原帖+全部评论）；单条超出预算不截断。
// ★群聊消息按「主角发言 + 故事时间」双路线分块参与混合块（用户定案）：①角色发言后出现主角
//   发言即分块（每次聊天以用户发言开始，直到下一次用户发言）；②相邻非系统消息 storyTime 严格
//   不一致即分块（覆盖无主角发言的连续角色主动轮——空批次触发全局时间没变=同一轮）。块=原子
//   条目，块内每条消息各计 1 条（转发帖 5 条），预算边界落在块上整块带入不截断；块只注入给
//   「参与者（发言者∪被@者）∩服务名单」相关的混合块；当前群聊请求排除本群（自身消息由
//   「本群最近消息」段单独呈现）。
// 排序键=各记录的真实时间戳（消息 ts / 通话 startedAt / 帖子 createdAt，仅排序用不显示）；
// 展示只用故事时间快照（变化才标注，绝不回退真实时钟）。朋友圈/社媒条目的时间戳=规范绝对故事时间
// （timeLabel+storyTime 锚点归一，记录用绝对——用户定案；解析失败回退原文标签）。纯函数零依赖，可被 .cjs 测试直接 require。

import { callRecordPreview, formatCallTranscript, MAX_TRANSCRIPT_LINES, type CallRecord } from './call-model';
import { chatlogForwardBlock, groupRequestChunks, isForwardedMessage, quotePromptPrefix, transferAiAmount, type Conversation, type GroupChunk, type PhoneMessage, type PhoneStyle } from './chat-model';
import { s } from './skins';
import { tiebaTimelinePosts, weiboTimelinePosts, xhsTimelinePosts, type MomentPost, type SocialTimelinePost } from './social-model';
import { formatStampFull, postStoryStamp } from './social-time';

/** 转发消息（帖子分享/聊天合并转发）在混合块计条口径（用户定案）：整条算 5 条，中和全文展开的 token 影响。 */
export const SHARE_MESSAGE_UNITS = 5;

/** 混合记录查询（服务对象口径：通话与帖子按 names 过滤，聊天以 conversations 为准）。 */
export interface MixedRecordQuery {
  /** 服务对象名单（通话=与这些人的通话；朋友圈与社媒帖=这些人或主角发的，或这些人评论过的；私聊消息=与这些人的私聊会话）。 */
  names: string[];
  /** 私聊来源会话（逐消息参与混合块）。 */
  conversations: Conversation[];
  /** 群聊来源会话（按主角发言+故事时间双路线分块参与，见文件头★；调用方按成员交集预过滤并排除当前请求的群）。 */
  groupConversations?: Conversation[];
  calls: CallRecord[];
  moments: MomentPost[];
  /** 贴吧/微博/小红书帖子（角色/主角发的或名单角色评论过的进混合块，纯路人互动帖按名单过滤）。 */
  socialPosts?: SocialTimelinePost[];
  /** 主角名（主角自己发的内容对方也看得到，同样收录；评论者=主角显示为「我」）。 */
  me: string;
  /** 条数预算（=设置·手机记录条数）。 */
  count: number;
  /** 排除的通话记录 id（当前进行中的通话——已在「本次通话内容」段，防重复携带）。 */
  excludeCallId?: string;
  /** 排除的帖子 id（待反馈互动的帖子——已在「待反馈的用户互动」段，防重复携带）。 */
  excludePostIds?: string[];
  /** 界面风格：混合块【类型】标签与发帖动词按风格取词（docs/15：三 App 皮肤下全量参与，不再剔除）。 */
  style?: PhoneStyle;
}

export interface MixedRecords {
  /** 区块正文（从旧到新多行；空串=无任何记录，由调用方决定占位/省略）。 */
  body: string;
  /** 实际携带条数（计条口径见文件头）。 */
  units: number;
}

/** 混合块条目类型（渲染时同类型连续内容共用一个【类型】标签，类型切换换标——用户定案格式）。 */
type TimelineKind = 'chat' | 'group' | 'call' | 'moment' | 'tieba' | 'weibo' | 'xhs';

const KIND_LABELS: Record<TimelineKind, string> = {
  chat: '【微信聊天记录】',
  group: '【群聊记录】',
  call: '【通话记录】',
  moment: '【朋友圈动态】',
  tieba: '【贴吧帖子】',
  weibo: '【微博博文】',
  xhs: '【小红书笔记】',
};

/** 混合块【类型】标签（走风格：仙侠=符讯/传音/百晓阁风闻/浮生帖/论道坛帖/云笈录；docs/15 §3.4）。 */
const KIND_LABELS_XX: Record<TimelineKind, string> = {
  chat: '【符讯记录】',
  group: '【共谈记录】',
  call: '【传音记录】',
  moment: '【浮生帖】',
  tieba: '【论道坛帖】',
  weibo: '【百晓阁风闻】',
  xhs: '【云笈录】',
};

/** 武侠·惊堂类型标签（书信/传声/群英会话/茶馆风声/故人笺/英雄楼帖/风物图志；docs/11、docs/15）。 */
const KIND_LABELS_WX: Record<TimelineKind, string> = {
  chat: '【飞鸽书信】',
  group: '【群英会话】',
  call: '【传声记录】',
  moment: '【故人笺】',
  tieba: '【英雄楼帖】',
  weibo: '【茶馆风声】',
  xhs: '【风物图志】',
};

/** 西幻·纹章类型标签（晶讯/远语/圆桌商谈/诗社见闻/篝火手记/行会榜文/藏宝图鉴；docs/11、docs/15）。 */
const KIND_LABELS_FT: Record<TimelineKind, string> = {
  chat: '【晶讯记录】',
  group: '【圆桌商谈】',
  call: '【远语记录】',
  moment: '【篝火手记】',
  tieba: '【行会榜文】',
  weibo: '【诗社见闻】',
  xhs: '【藏宝图鉴】',
};

function kindLabel(kind: TimelineKind, style: PhoneStyle): string {
  return style === 'xianxia' ? KIND_LABELS_XX[kind]
    : style === 'wuxia' ? KIND_LABELS_WX[kind]
    : style === 'fantasy' ? KIND_LABELS_FT[kind]
    : KIND_LABELS[kind];
}

/** 内部候选条目（先选后渲染：排序与计数零字符串开销）。 */
interface TimelineCandidate {
  ts: number;
  /** 占用条数。 */
  units: number;
  /** 条目类型（渲染标签用）。 */
  kind: TimelineKind;
  /** 首行时间戳（故事时间域；格式化时变化才标注）。 */
  storyTime?: string;
  /** 首行正文（不含时间戳前缀）。 */
  first: string;
  /** 后续缩进子行（通话转写/评论；可空）。 */
  rest: string[];
}

/** 链接卡在 AI 视角的一行：`[链接]标题：页面描述`——描述是分享后好友唯一的读本（旧档无 desc 回落预览/标题）。 */
function linkRecordText(message: PhoneMessage): string {
  const title = (message.link?.title || message.content).slice(0, 60);
  const desc = (message.link?.desc || message.link?.preview || '').slice(0, 200);
  return `[链接]${title}${desc ? `：${desc}` : ''}`;
}

/** 单条微信消息 → 候选（正文格式与原聊天记录段同源：系统行括号 + 富媒体类型前缀；引用消息前置「（引用 X：原文）」全文不截断；转发消息=全文行+计 5 条）。 */
function chatCandidate(message: PhoneMessage): TimelineCandidate {
  if (message.from === 'system') {
    return { ts: message.ts, units: 1, kind: 'chat', storyTime: message.storyTime, first: `（${message.content.slice(0, 80)}）`, rest: [] };
  }
  const who = message.from === 'me' ? '我' : message.from;
  if (isForwardedMessage(message)) {
    // 转发块整段 〖〗 成对包裹（首行标记自带来源），与通话转写/评论子行明确区隔（用户定案）
    const block = chatlogForwardBlock(message);
    return {
      ts: message.ts,
      units: SHARE_MESSAGE_UNITS,
      kind: 'chat',
      storyTime: message.storyTime,
      first: block[0],
      rest: block.slice(1).map(l => `　${l}`),
    };
  }
  const body = message.type === 'image' ? `[图片]${message.content.slice(0, 60)}`
    : message.type === 'voice' ? `[语音]${message.content.slice(0, 60)}`
      : message.type === 'transfer' ? `[转账]${transferAiAmount(message.amount, message.currency)} ${message.content.slice(0, 40)}`
        : message.type === 'redpacket' ? `[红包]${message.content.slice(0, 40)}`
          : message.type === 'chatlog' ? `[聊天记录]${message.content.slice(0, 60)}`
            : message.type === 'link' ? linkRecordText(message)
              : message.content.slice(0, 120);
  const quote = message.quote ? quotePromptPrefix(message.quote) : '';
  return { ts: message.ts, units: 1, kind: 'chat', storyTime: message.storyTime, first: `${who}：${quote}${body}`, rest: [] };
}

/**
 * 群聊请求块 → 候选（首行=群名｜首条消息行，子行=块内其余消息行缩进；计条=块内每条消息口径之和）。
 * 首行带群名区分不同群；排序键=块内最新一条消息 ts；展示戳=块内首个非系统消息的故事时间
 * （同块内故事时间严格一致——分块口径即如此）。
 */
function groupChunkCandidate(conv: Conversation, chunk: GroupChunk): TimelineCandidate {
  const lines: string[] = [];
  let units = 0;
  let storyTime = '';
  for (const message of chunk.messages) {
    const c = chatCandidate(message);
    lines.push(...(lines.length ? [`　${c.first}`, ...c.rest] : [c.first, ...c.rest]));
    units += c.units;
    if (!storyTime && message.from !== 'system') storyTime = message.storyTime || '';
  }
  return {
    ts: chunk.messages[chunk.messages.length - 1]?.ts || 0,
    units,
    kind: 'group',
    storyTime,
    first: `${conv.title}｜${lines[0] || ''}`,
    rest: lines.slice(1),
  };
}

/** 单次通话 → 候选（首行=记录头：方向+结果，子行=转写逐行缩进；计条=1+转写行数）。窥隐私下通话（caller=拨出方角色名）按「A打给B」渲染。 */
function callCandidate(record: CallRecord, style: PhoneStyle): TimelineCandidate {
  const direction = record.caller
    ? s(style,
      `${record.caller}打给${record.peerName}`,
      `${record.caller}向${record.peerName}传出神识`,
      `${record.caller}向${record.peerName}传声`,
      `${record.caller}向${record.peerName}施展远语`)
    : record.direction === 'incoming'
      ? s(style, `${record.peerName}打来`, `${record.peerName}传来神识`, `${record.peerName}传声而来`, `${record.peerName}远语传来`)
      : s(style, `我打给${record.peerName}`, `我向${record.peerName}传出神识`, `我向${record.peerName}传声`, `我向${record.peerName}施展远语`);
  const first = `${direction}（${callRecordPreview(record)}）`;
  const rest = record.lines.length
    ? formatCallTranscript(record.lines, MAX_TRANSCRIPT_LINES, record.peerName, record.caller || '我').split('\n').map(l => `　${l}`)
    : [];
  return {
    ts: record.startedAt,
    units: 1 + rest.length,
    kind: 'call',
    storyTime: record.storyTime,
    first,
    rest,
  };
}

/** 朋友圈/社媒条目时间戳=规范绝对故事时间全文（记录用绝对——用户定案；解析失败回退原文标签）。 */
function absoluteStampText(post: { timeLabel: string; storyTime?: string; storyStamp?: string }): string {
  return formatStampFull(postStoryStamp(post)) || post.timeLabel;
}

/** 单条朋友圈动态 → 候选（首行=发帖人+正文，子行=评论逐行缩进；计条=1+评论数）。 */
function momentCandidate(post: MomentPost, me: string, style: PhoneStyle = ''): TimelineCandidate {
  const author = post.author === me ? '我' : post.author;
  const verb = s(style, '发动态', '报近况', '投笺', '记手记');
  const first = `${author}${verb}：${post.text.slice(0, 120)}${post.imageDesc ? `（配图：${post.imageDesc.slice(0, 60)}）` : ''}`;
  const rest = post.comments.map(c => {
    const name = c.name === me ? '我' : c.name;
    const reply = c.replyTo ? `（回复 ${c.replyTo}）` : '';
    return `　评论 ${name}${reply}：${c.text}`;
  });
  return { ts: post.createdAt, units: 1 + rest.length, kind: 'moment', storyTime: absoluteStampText(post), first, rest };
}

/** 单条贴吧/微博/小红书帖子 → 候选（格式同朋友圈；平台标签区分；maxComments=每帖评论子行上限）。 */
function socialCandidate(post: SocialTimelinePost, me: string, style: PhoneStyle, maxComments = Number.POSITIVE_INFINITY): TimelineCandidate {
  const author = post.author === me ? '我' : post.author;
  const verb = post.platform === 'tieba' ? s(style, '发帖', '发坛帖', '发楼帖', '发榜文')
    : post.platform === 'weibo' ? s(style, '发微博', '发风闻', '发风声', '发见闻')
      : s(style, '发笔记', '录云笈', '撰图志', '辑图鉴');
  const first = `${author}${verb}：${post.text.slice(0, 120)}${post.imageDesc ? `（配图：${post.imageDesc.slice(0, 60)}）` : ''}`;
  const rest = post.comments.slice(0, maxComments).map(c => {
    const name = c.name === me ? '我' : c.name;
    const reply = c.replyTo ? `（回复 ${c.replyTo}）` : '';
    return `　评论 ${name}${reply}：${c.text}`;
  });
  return { ts: post.createdAt, units: 1 + rest.length, kind: post.platform, storyTime: absoluteStampText(post), first, rest };
}

/**
 * 渲染已选条目（从旧到新；首行故事时间变化才标注，全块共用同一标注游标）。
 * withLabels=true：同类型连续条目共用一个【类型】标签（首条带标签、后续行缩进），类型切换换标；
 * withLabels=false：纯消息列表（专属段落标题已表明类型，不加标签）。
 */
function renderEntries(selected: TimelineCandidate[], withLabels: boolean, style: PhoneStyle = ''): MixedRecords {
  if (!selected.length) return { body: '', units: 0 };
  const lines: string[] = [];
  let lastStory = '';
  let prevKind: TimelineKind | null = null;
  for (const item of selected) {
    const stamp = item.storyTime && item.storyTime !== lastStory ? `[${item.storyTime}] ` : '';
    if (item.storyTime) lastStory = item.storyTime;
    const lead = !withLabels ? '' : item.kind === prevKind ? '　' : kindLabel(item.kind, style);
    lines.push(`${lead}${stamp}${item.first}`, ...item.rest);
    prevKind = item.kind;
  }
  return { body: lines.join('\n'), units: selected.reduce((n, item) => n + item.units, 0) };
}

/**
 * 纯微信消息列表格式化（群聊「本群最近消息」独立段用）：不走混合选取，
 * 直接取最新 count 条按同款格式渲染——本群自身消息不进本请求的混合时间线（见文件头★）。
 */
export function formatMessageHistory(messages: PhoneMessage[], count: number): MixedRecords {
  const take = Math.max(0, Math.floor(count));
  if (!take) return { body: '', units: 0 };
  return renderEntries(messages.slice(-take).map(m => chatCandidate(m)), false);
}

/**
 * 构建最近手机记录混合块：三源混排 + 群聊分块（见文件头★）→ 从最新往旧取满 count 条
 * （边界整条带入）→ 从旧到新渲染。群聊块从新到旧构建至覆盖预算即可止步——更旧的块
 * 必然排在预算耗尽之后（每群入选新块的条数合计≥count），不浪费渲染开销。
 */
export function buildMixedRecords(query: MixedRecordQuery): MixedRecords {
  const count = Math.max(0, Math.floor(query.count));
  if (!count) return { body: '', units: 0 };
  const style = query.style || '';
  const nameSet = new Set(query.names);

  const candidates: TimelineCandidate[] = [];
  for (const conv of query.conversations) {
    if (conv.kind !== 'private') continue;
    for (const message of conv.messages.slice(-count)) candidates.push(chatCandidate(message));
  }
  // 群聊块（用户定案）：参与者（发言者∪被@者）∩服务名单非空才收录；原子条目，从新到旧
  // 构建至覆盖 count（不匹配的块跳过但不影响预算判断——它本来就不会被选中）。
  for (const conv of query.groupConversations || []) {
    if (conv.kind !== 'group') continue;
    let groupUnits = 0;
    const chunks = groupRequestChunks(conv.messages, conv.members);
    for (let i = chunks.length - 1; i >= 0 && groupUnits < count; i--) {
      const chunk = chunks[i]!;
      if (!chunk.participants.some(p => nameSet.has(p))) continue;
      const candidate = groupChunkCandidate(conv, chunk);
      candidates.push(candidate);
      groupUnits += candidate.units;
    }
  }
  const excludedPosts = new Set(query.excludePostIds || []);
  // 收录口径（用户定案）：发帖人=主角或名单角色，或名单角色参与过（评论/回复；点赞不算）——
  // 角色评论过的路人帖整条带入原帖+全部评论。
  const authoredOrInvolved = (post: { author: string; comments: Array<{ name: string }> }): boolean =>
    post.author === query.me || nameSet.has(post.author) || post.comments.some(c => nameSet.has(c.name));
  for (const record of query.calls) {
    if (record.id === query.excludeCallId) continue;
    // 窥隐私下通话按拨出方（caller）也可命中服务名单（主角通话 caller 缺省，口径不变）
    if (!nameSet.has(record.peerName) && !(record.caller && nameSet.has(record.caller))) continue;
    candidates.push(callCandidate(record, style));
  }
  for (const post of query.moments) {
    if (excludedPosts.has(post.id) || !authoredOrInvolved(post)) continue;
    candidates.push(momentCandidate(post, query.me, style));
  }
  for (const post of query.socialPosts || []) {
    if (excludedPosts.has(post.id) || !authoredOrInvolved(post)) continue;
    candidates.push(socialCandidate(post, query.me, style));
  }

  candidates.sort((a, b) => b.ts - a.ts);
  const selected: TimelineCandidate[] = [];
  let remaining = count;
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    selected.push(candidate);
    remaining -= candidate.units;
  }
  selected.reverse();
  return renderEntries(selected, true, style);
}

/** 三平台帖子 → 通用混合时间线视图（聊天/通话/社媒反馈共用；路人帖由调用方名单过滤）。 */
export function socialTimelinePosts(social: { tieba?: unknown[]; weibo?: unknown[]; xhs?: unknown[] }): SocialTimelinePost[] {
  return [
    ...tiebaTimelinePosts((social.tieba || []) as Parameters<typeof tiebaTimelinePosts>[0]),
    ...weiboTimelinePosts((social.weibo || []) as Parameters<typeof weiboTimelinePosts>[0]),
    ...xhsTimelinePosts((social.xhs || []) as Parameters<typeof xhsTimelinePosts>[0]),
  ];
}

/** 公共舆论条目的帖子段（世界书投影用）：行格式与【类型】标签和混合块逐字同源（皮肤感知标签）。 */
export function formatPublicPostsSection(posts: SocialTimelinePost[], me: string, style: PhoneStyle, maxComments = 2): string {
  return renderEntries(posts.map(p => socialCandidate(p, me, style, maxComments)), true, style).body;
}

/** 混合块段头（聊天/通话/社媒共用措辞基座；scope 描述服务对象）。 */
export function mixedRecordSection(scope: string, records: MixedRecords, placeholder = '（暂无手机记录）'): string {
  return `■ 最近手机记录（${scope}，从旧到新，最近 ${records.units} 条）\n${records.body || placeholder}`;
}
