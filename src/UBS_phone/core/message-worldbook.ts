// ===== 消息记录注入世界书（各角色最近手机记录混合块 → 角色主世界书，正文互通） =====
// 链路：本模块把投影描述符 {id, isEnabled, reconcile} 经宿主桥 __ubWorldbookProjection.register
// 注册进主项目世界书投影统一调度（与日历/关系表等内部模块同一协调器：串行化整书读写、
// 切卡 epoch、refreshAll、DS 缓存重定位）——小手机不自建任何注入链路（用户定案）。
// 条目：①每角色一条（仅通讯录中有手机记录的角色）绿灯 selective 触发词=角色名，内容=
// <角色名最近消息记录> 包裹的混合块（复用 phone-timeline 格式；动态/帖子只收 TA 发的或 TA 参与评论的
// 防跨条目重复；群聊=TA 参与（发言/被@）的块——用户定案）；②说明条目蓝灯 constant、order 在分角色条目前一位。
// [UBS手机] 统一前缀 → 自有 AI 管线扫描钩子按请求 keep 豁免：消息记录族放行窥私/采访/调查/演化
// （keepPhoneRecordEntries——资料块无消息注入，靠条目丰满人物、衔接主角侧互动）；聊天/通话/社媒剔除
// （防回喂，资料块已自带消息记录）；酒馆正常生成正常消费。
// 触发：mutatePhoneData / roster 失效 / 切聊重绑 / 开关翻转 → 签名去重 → 防抖 request；
// 主项目未加载（无桥）不兜底自注入，设置页提示状态（用户定案）。

import { createCoalescer } from './ubp-utils';
import { isHostRefillMode } from './host-config';
import { dsCachePos, type WbPosSpec } from '../../unified-statusbar/core/wb-position';
import { createExternalProjectionClient } from '../../unified-statusbar/core/external-projection-client';
import { keepSpyRecordEntries, MESSAGE_RECORDS_KEEP_PREFIX, wbEntryName } from '../../unified-statusbar/core/worldbook-entry';
import type { PhoneChatData, PhoneStyle } from './chat-model';
import { streamFingerprint } from './hash';
import { hostWindow } from './host-env';
import type { MixedRecords } from './phone-timeline';
import { buildMixedRecords, formatPublicPostsSection, socialTimelinePosts } from './phone-timeline';
import { getPhoneSettings } from './phone-settings';
import { onPhoneDataMutated, readPhoneDataRef } from './phone-store';
import { getRoster, onRosterInvalidated, type RosterSnapshot } from './roster';
import { readSocialOf } from './social-model';
import { s, socialSkinProfile } from './skins';

// ─── 协议常量 ───

/** 主项目投影 id（registry 内唯一；同 id 幂等覆盖）。 */
export const PHONE_MESSAGE_PROJECTION_ID = 'phone-messages';

/** 条目名统一前缀（[UBS手机] 前缀条目被自有 AI 管线扫描钩子按请求剔除/keep 豁免——worldbook-entry.STORY_LINK_ENTRY_PREFIX）。 */
export const MESSAGE_WB_PREFIX = `${MESSAGE_RECORDS_KEEP_PREFIX}-`;
/** 防全知说明条目名（蓝灯 constant）。 */
export const MESSAGE_WB_NOTE_NAME = `${MESSAGE_RECORDS_KEEP_PREFIX}防全知说明`;

// 注入位置：角色相关表格条目同区（角色表 8005、人物关系表 8006 之后；地图节点 8007+ 在 depth 0 不冲突；
// 技能 8124/衣柜 8125+ 之前）。说明条目 = 分角色条目前一位（用户定案）。
const MESSAGE_WB_NOTE_ORDER = 8008;
const MESSAGE_WB_CHAR_ORDER = 8009;
const NOTE_ORIG_POS: WbPosSpec = { type: 'before_character_definition', role: 'system', depth: 2, order: MESSAGE_WB_NOTE_ORDER };
const CHAR_ORIG_POS: WbPosSpec = { type: 'before_character_definition', role: 'system', depth: 2, order: MESSAGE_WB_CHAR_ORDER };

/** 防全知说明正文（用户定案文案；仙侠差异覆盖见 messageWbNoteContent；群聊句=群聊块参与混合块配套）。 */
export const MESSAGE_WB_NOTE_CONTENT = [
  '<手机消息记录防全知说明>',
  '下面是相关角色最近的通话、聊天、群聊和社媒记录，其中通话、私聊为私人信息，不应该被交流双方以外的其他人所知；群聊内容为群内成员共同所见，只应当被该群的成员所知；社媒内容为有限公开，只应当被熟识或者关注的人所知，不要默认所有人都知道相关信息。',
  '</手机消息记录防全知说明>',
].join('\n');

/** 防全知说明正文按风格取用（条目名/结构不变；仙侠措辞见 docs/11 §5.7，武侠/西幻见 docs/11）。 */
export function messageWbNoteContent(style: PhoneStyle): string {
  if (style === 'xianxia') {
    return [
      '<手机消息记录防全知说明>',
      '下面是相关角色最近的传音、符讯、共谈和百晓阁风闻，其中传音、一对一符讯为私人信息，不应该被互通双方以外的其他人所知；共谈内容为盟中成员共同所见，只应当被该盟的成员所知；百晓阁风闻为有限公开，只应当被熟识或者关注的人所知，不要默认所有人都知道相关信息。',
      '</手机消息记录防全知说明>',
    ].join('\n');
  }
  if (style === 'wuxia') {
    return [
      '<手机消息记录防全知说明>',
      '下面是相关角色最近的传声、书信、群英会话和茶馆风声，其中传声、一对一书信为私人信息，不应该被互通双方以外的其他人所知；群英会话为会中成员共同所见，只应当被该会同道所知；茶馆风声为有限公开，只应当被熟识或者结交的人所知，不要默认所有人都知道相关信息。',
      '</手机消息记录防全知说明>',
    ].join('\n');
  }
  if (style === 'fantasy') {
    return [
      '<手机消息记录防全知说明>',
      '下面是相关角色最近的远语、晶讯、圆桌商谈和诗社见闻，其中远语、一对一晶讯为私人信息，不应该被互通双方以外的其他人所知；圆桌商谈为桌上成员共同所见，只应当被该圆桌同仁所知；诗社见闻为有限公开，只应当被熟识或者同路的人所知，不要默认所有人都知道相关信息。',
      '</手机消息记录防全知说明>',
    ].join('\n');
  }
  return MESSAGE_WB_NOTE_CONTENT;
}

// ─── 条目构建（纯函数，.cjs 测试可直接 require） ───

function baseEntryFields(position: WbPosSpec) {
  return {
    enabled: true,
    position: dsCachePos(position),
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
    addMemo: true,
    triggers: [],
  };
}

/** 防全知说明条目（蓝灯常亮；正文按风格取用）。 */
export function buildMessageNoteEntry(style: PhoneStyle = ''): Record<string, unknown> {
  return {
    name: MESSAGE_WB_NOTE_NAME,
    comment: MESSAGE_WB_NOTE_NAME,
    ...baseEntryFields(NOTE_ORIG_POS),
    strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
    content: messageWbNoteContent(style),
  };
}

export interface PhoneMessageEntryInput {
  name: string;
  records: MixedRecords;
}

/** 单角色条目：绿灯 selective，触发关键词=角色名，内容=混合块（标签包裹）。 */
export function buildCharacterMessageEntry(input: PhoneMessageEntryInput): Record<string, unknown> {
  return {
    name: MESSAGE_WB_PREFIX + input.name,
    comment: MESSAGE_WB_PREFIX + input.name,
    ...baseEntryFields(CHAR_ORIG_POS),
    strategy: { type: 'selective', keys: [input.name], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
    content: `<${input.name}最近消息记录>\n${input.records.body}\n</${input.name}最近消息记录>`,
  };
}

/**
 * 单角色混合记录口径（用户定案）：与TA的私聊+与TA的通话+TA发的或TA参与评论的动态/帖子
 * +TA参与（发言/被@）的群聊块（按主角发言+故事时间双路线分块，见 phone-timeline 文件头★）；不含「我」发/评的动态内容。
 */
export function buildCharacterMessageRecords(data: PhoneChatData, name: string, me: string, count: number): MixedRecords {
  const social = readSocialOf(data);
  const involved = (p: { author: string; comments: Array<{ name: string }> }): boolean =>
    p.author === name || p.comments.some(c => c.name === name);
  return buildMixedRecords({
    names: [name],
    conversations: data.conversations.filter(c => c.kind === 'private' && c.members[0] === name),
    groupConversations: data.conversations.filter(c => c.kind === 'group' && c.members.includes(name)),
    calls: (data.calls || []).filter(c => c.peerName === name),
    moments: social.moments.filter(involved),
    socialPosts: socialTimelinePosts(social).filter(involved),
    me,
    count,
    style: data.style || '',
  });
}

/** 角色名可作标签（拒绝破坏 <标签> 结构的字符）。 */
function nameIsTagSafe(name: string): boolean {
  return !!name && !/[<>/\\\s]/.test(name);
}

/**
 * 目标条目集：防全知说明 + 有记录角色条目（用户定案：无记录角色不建条目）。
 * 全体角色都无记录 → 空数组（说明条目孤立无指向，不注入）。
 */
export function collectPhoneMessageEntries(contactNames: string[], data: PhoneChatData, me: string, count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of contactNames) {
    if (!nameIsTagSafe(name)) continue;
    const records = buildCharacterMessageRecords(data, name, me, count);
    if (!records.units) continue;
    out.push(buildCharacterMessageEntry({ name, records }));
  }
  if (!out.length) return [];
  out.unshift(buildMessageNoteEntry(data.style || ''));
  return out;
}

// ─── 公共舆论条目（可选投影：热搜榜 + 公开平台帖；常驻蓝灯——用户定案默认关） ───

/** 公共条目名（[UBS手机] 消息记录族前缀 → 整族清理天然覆盖；keepPhoneRecordEntries 天然放行）。 */
export const MESSAGE_WB_PUBLIC_NAME = `${MESSAGE_WB_PREFIX}公共舆论`;

/** 口径常量：榜单 ≤10（存储上限 12）；每平台 ≤5 帖、每帖 ≤2 条评论；总行数硬顶（常驻条目每轮都占预算）。 */
const PUBLIC_TRENDING_CAP = 10;
const PUBLIC_POSTS_PER_PLATFORM = 5;
const PUBLIC_POST_COMMENTS = 2;
const PUBLIC_LINE_BUDGET = 48;

/** 框定语（与「防全知说明」口径协调：话题是公共的 ≠ 谁都看过具体哪条）。 */
function publicOpinionFraming(style: PhoneStyle): string {
  return s(style,
    '以下是当前公开可见的内容：榜单是大家在议的话题，具体帖子不必然人人看过。',
    '以下是当前公开可见的风闻：榜上是满城在议的话题，具体风闻不必然人人听过。',
    '以下是当前公开可见的风声：书目是满堂在议的话题，具体茶帖不必然人人听过。',
    '以下是当前公开可见的见闻：传唱是酒馆在传的话题，具体见闻不必然人人听过。');
}

/** 榜单段（榜名取皮肤词表 boardTitle 并去排版空格；无词条=无段）。 */
function publicBoardLines(social: ReturnType<typeof readSocialOf>, style: PhoneStyle): string[] {
  const items = (social.trending || []).slice(0, PUBLIC_TRENDING_CAP);
  if (!items.length) return [];
  const title = (socialSkinProfile(style)?.boardTitle || '热搜榜').replace(/\s+/g, '');
  return [`【${title}】`, ...items.map(t => `${t.rank}. ${t.title}（${t.hot}）${t.tag ? ` ${t.tag}` : ''}`)];
}

/**
 * 公共舆论条目（纯函数）：内容=框定语+榜单+公开平台帖。帖子段的行格式与【类型】标签和
 * 混合块逐字同源（formatPublicPostsSection，皮肤感知）；内容归属逐段可辨（用户定案——
 * 像混合块那样每段标明属于什么）。收录口径：路人/机构/主角的公开帖都算公共内容
 * （主角帖=作者「我」不在名单 → 天然不认领）；已被角色条目认领的帖子（名单角色发的
 * 或评论过的）不重复携带；皮肤隐藏平台整源剔除。
 * 无任何公开内容 → null（不建条目）。
 */
export function buildPublicOpinionEntry(input: { data: PhoneChatData; contactNames: string[]; me: string }): Record<string, unknown> | null {
  const social = readSocialOf(input.data);
  const style = input.data.style || '';
  const lines = publicBoardLines(social, style);
  const claimed = new Set(input.contactNames);
  const allPosts = socialTimelinePosts(social);
  const sections: string[] = [];
  let used = lines.length + 2;
  for (const platform of ['tieba', 'weibo', 'xhs'] as const) {
    const posts = allPosts
      .filter(p => p.platform === platform
        && !claimed.has(p.author)
        && !p.comments.some(c => claimed.has(c.name)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, PUBLIC_POSTS_PER_PLATFORM);
    if (!posts.length) continue;
    const body = formatPublicPostsSection(posts, input.me, style, PUBLIC_POST_COMMENTS);
    if (!body) continue;
    const count = body.split('\n').length;
    if (used + count > PUBLIC_LINE_BUDGET) continue; // 预算见底整段让位（榜单优先已就位）
    sections.push(body);
    used += count;
  }
  if (!lines.length && !sections.length) return null;
  const content = ['<公共舆论>', publicOpinionFraming(style), '', ...lines, ...sections, '</公共舆论>'].join('\n');
  return {
    name: MESSAGE_WB_PUBLIC_NAME,
    comment: MESSAGE_WB_PUBLIC_NAME,
    ...baseEntryFields(NOTE_ORIG_POS),
    strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
    content,
  };
}

/** 1A 请求 keep：窥私族 + 公共舆论条目（用户定案——公共内容对手机自身生成持续放行，不设子开关；
 *  角色私有消息记录族照旧剔除防回喂）。聊天/通话/社媒用；窥私侧 keepPhoneRecordEntries 本就放行消息记录族。 */
export function keepSpyAndPublicEntries(name: string): boolean {
  return keepSpyRecordEntries(name) || name === MESSAGE_WB_PUBLIC_NAME;
}

// ─── reconcile（纯函数：整族收敛，语义比对防 ST 往返字段抖动 → 无变化不写盘） ───

function isManagedMessageEntry(entry: any): boolean {
  const name = wbEntryName(entry);
  return name.startsWith(MESSAGE_WB_PREFIX) || name === MESSAGE_WB_NOTE_NAME;
}

function sameMessageEntry(entry: any, target: any): boolean {
  return entry?.name === target.name
    && entry?.enabled === true
    && entry?.content === target.content
    && entry?.strategy?.type === target.strategy.type
    && JSON.stringify(entry?.strategy?.keys) === JSON.stringify(target.strategy.keys)
    && entry?.position?.type === target.position.type
    && entry?.position?.role === target.position.role
    && entry?.position?.depth === target.position.depth
    && entry?.position?.order === target.position.order
    && entry?.recursion?.prevent_incoming === true
    && entry?.recursion?.prevent_outgoing === true;
}

function applyDesired(entries: any[], managedIndices: readonly number[], desired: readonly Record<string, unknown>[]): void {
  const insertionIndex = managedIndices[0] ?? entries.length;
  const next = entries.filter(entry => !isManagedMessageEntry(entry));
  next.splice(Math.min(insertionIndex, next.length), 0, ...desired.map(item => ({ ...item })));
  entries.splice(0, entries.length, ...next);
}

/** 消息记录条目族收敛（desired=空即整族清除；对齐 reconcileCharacterRelationEntries 语义）。 */
export function reconcilePhoneMessageEntries(entries: any[], desired: readonly Record<string, unknown>[]): boolean {
  const managedIndices = entries
    .map((entry, index) => (isManagedMessageEntry(entry) ? index : -1))
    .filter(index => index >= 0);
  if (managedIndices.length !== desired.length) {
    applyDesired(entries, managedIndices, desired);
    return true;
  }
  for (let i = 0; i < desired.length; i++) {
    if (!sameMessageEntry(entries[managedIndices[i]], desired[i])) {
      applyDesired(entries, managedIndices, desired);
      return true;
    }
  }
  return false;
}

// ─── 投影描述符 + 宿主桥 ───

/** 目标条目集（共享口径）：防全知说明居首 + 分角色条目 + 公共舆论条目（projectPublic 开且确有公开内容才带；
 *  无角色条目但公共条目存在时补说明条目——孤条目无指向不注入）。 */
function desiredMessageEntries(settings: { messageWorldbook: boolean; projectPublic: boolean; phoneHistoryCount: number }, roster: RosterSnapshot, data: PhoneChatData): Record<string, unknown>[] {
  const names = roster.contacts.map(c => c.name);
  const desired = collectPhoneMessageEntries(names, data, roster.protagonistName, settings.phoneHistoryCount);
  if (settings.projectPublic) {
    const pub = buildPublicOpinionEntry({ data, contactNames: names, me: roster.protagonistName });
    if (pub) {
      if (!desired.length) desired.unshift(buildMessageNoteEntry(data.style || ''));
      desired.push(pub);
    }
  }
  return desired;
}

/** 注册进主项目统一调度的 reconcile（isEnabled=false → 整族清除）。 */
function projectionReconcile(entries: any[]): boolean {
  const settings = getPhoneSettings();
  if (!settings.messageWorldbook) return reconcilePhoneMessageEntries(entries, []);
  return reconcilePhoneMessageEntries(entries, desiredMessageEntries(settings, getRoster(), readPhoneDataRef()));
}

export function phoneMessageProjectionDescriptor(): { id: string; isEnabled: () => boolean; reconcile: (entries: any[]) => boolean } {
  return {
    id: PHONE_MESSAGE_PROJECTION_ID,
    isEnabled: () => getPhoneSettings().messageWorldbook,
    reconcile: projectionReconcile,
  };
}

// ─── 共享外部投影客户端（桥发现/注册/ready 重试/请求/开关全部复用主项目协议） ───

const projectionClient = createExternalProjectionClient({
  descriptor: phoneMessageProjectionDescriptor(),
  window: hostWindow(),
  // ready 只在宿主晚装载/重载时补一次投影；构造期 initial register 不重复 notify。
  onRegistered: (source) => {
    if (source === 'ready' && getPhoneSettings().messageWorldbook) notifyPhoneMessagesChanged();
  },
  log: () => { /* 投影失败由状态栏协调器控制台报；这里保持静默 */ },
});

export function isPhoneMessageProjectionRegistered(): boolean {
  return projectionClient.isRegistered();
}

/** 投影桥是否可用（就绪探测用：只读不注册，避免设置页状态查询的条目构建开销）。 */
export function isPhoneMessageProjectionBridgeAvailable(): boolean {
  return projectionClient.isBridgeAvailable();
}

/** 幂等注册进主项目投影调度（桥不存在=false；主项目晚加载时由 ready 事件补注册）。 */
export function syncPhoneMessageProjectionRegistration(): boolean {
  return projectionClient.register();
}

// ─── 变更通知（签名去重 + 防抖 request） ───

const NOTIFY_DEBOUNCE_MS = 1000;

/**
 * 轻量签名：条目内容的代理。结构面=名单/各源条数与首尾锚点/取量口径；内容面=各源逐条
 * 内容指纹（消息正文/图片路径、通话转写、帖子正文与评论、热搜词条）——投影渲染得到的
 * 正文变了签名必变（编辑消息/重新生图/评论改字/榜单换新都触发重投影）。
 */
export function computePhoneMessageSignature(data: PhoneChatData, contactNames: string[], me: string, count: number): string {
  const parts: string[] = [`names\u0001${contactNames.join('\u0002')}`, `me\u0001${me}`, `count\u0001${count}`, `style\u0001${data.style || ''}`];
  for (const conv of data.conversations) {
    const last = conv.messages[conv.messages.length - 1];
    if (conv.kind === 'private') {
      parts.push(`${conv.members[0]}#${conv.messages.length}#${last ? last.ts : 0}`);
    } else {
      // 群聊：标题/成员/消息数/末条时间任一变化都影响分角色条目内容（群聊块参与混合块——用户定案）
      parts.push(`${conv.id}#${conv.title}#${conv.members.join('+')}#${conv.messages.length}#${last ? last.ts : 0}`);
    }
    parts.push(`mc${streamFingerprint(emit => {
      for (const m of conv.messages) { emit(m.type); emit(m.content); emit(m.amount); emit(m.imagePath); emit(m.storyTime); }
    })}`);
  }
  const calls = data.calls || [];
  parts.push(`calls#${calls.length}#${calls[0]?.startedAt || 0}#${calls[calls.length - 1]?.startedAt || 0}`);
  parts.push(`cc${streamFingerprint(emit => {
    for (const c of calls) {
      emit(c.peerName); emit(c.direction); emit(c.caller); emit(c.status); emit(c.durationSec); emit(c.rejectReason); emit(c.storyTime);
      for (const l of c.lines) { emit(l.from); emit(l.text); }
    }
  })}`);
  const social = readSocialOf(data);
  let momentComments = 0;
  for (const post of social.moments) momentComments += Array.isArray(post?.comments) ? post.comments.length : 0;
  parts.push(`moments#${social.moments.length}#${momentComments}#${social.moments[0]?.id || ''}#${social.moments[social.moments.length - 1]?.id || ''}`);
  parts.push(`mc2${streamFingerprint(emit => {
    for (const p of social.moments) {
      emit(p.author); emit(p.text); emit(p.imageDesc); emit(p.timeLabel); emit(p.storyTime);
      for (const c of p.comments || []) { emit(c.name); emit(c.replyTo); emit(c.text); }
    }
  })}`);
  for (const key of ['tieba', 'weibo', 'xhs'] as const) {
    const posts = (social[key] || []) as SocialPostFingerprintSource[];
    let comments = 0;
    for (const post of posts) comments += Array.isArray(post?.comments) ? post.comments.length : 0;
    parts.push(`${key}#${posts.length}#${comments}#${posts[0]?.id || ''}#${posts[posts.length - 1]?.id || ''}`);
    parts.push(`${key}c${streamFingerprint(emit => {
      for (const p of posts) for (const f of socialPostFingerprintFields(key, p)) emit(f);
    })}`);
  }
  parts.push(`tc${streamFingerprint(emit => {
    for (const t of social.trending || []) { emit(t.rank); emit(t.title); emit(t.hot); emit(t.tag); }
  })}`);
  return parts.join('\u0003');
}

/** 平台帖子投影可见字段的宽松视图（签名只读不校验；三平台字段名不同，按平台取材）。 */
interface SocialPostFingerprintSource {
  id?: string;
  author?: string;
  text?: string;
  title?: string;
  content?: string;
  bar?: string;
  topic?: string;
  imageDesc?: string;
  timeLabel?: string;
  storyTime?: string;
  comments?: Array<{ name?: string; replyTo?: string; text?: string }>;
}

function socialPostFingerprintFields(key: 'tieba' | 'weibo' | 'xhs', post: SocialPostFingerprintSource): unknown[] {
  const common: unknown[] = [post.author, post.timeLabel, post.storyTime];
  for (const c of post.comments || []) common.push(c.name, c.replyTo, c.text);
  if (key === 'weibo') return [post.text, post.topic, ...common];
  if (key === 'xhs') return [post.title, post.content, post.imageDesc, ...common];
  return [post.bar, post.title, post.content, post.imageDesc, ...common];
}

let _lastSignature: string | null = null;

function requestProjectionNow(): void {
  if (!getPhoneSettings().messageWorldbook) return;
  // 主项目晚于小手机就绪：请求入口惰性补注册（幂等、桥不存在即静默放弃）
  if (!projectionClient.isRegistered() && !projectionClient.register()) return;
  const data = readPhoneDataRef();
  const roster = getRoster();
  const signature = computePhoneMessageSignature(data, roster.contacts.map(c => c.name), roster.protagonistName, getPhoneSettings().phoneHistoryCount);
  if (signature === _lastSignature) return;
  _lastSignature = signature;
  void projectionClient.request('data-change');
}

/** 变更入口：coalesce = 「pending 期间忽略后续调用」的合并（不是 debounce 的重排语义，故另名），
 *  统一实现在 core/ubp-utils；签名相同=内容没变，仍然跳过 getWorldbook 空转。 */
const notifyCoalesced = createCoalescer(NOTIFY_DEBOUNCE_MS, requestProjectionNow);

export function notifyPhoneMessagesChanged(): void {
  if (isHostRefillMode()) return; // F66：重填模式期间不重投影（关闭后由下一次数据变更补刷）
  notifyCoalesced();
}

// ─── 开关接线 + 常驻绑定 ───

/** 开关翻转（设置页调用）：开=确保注册+清主项目侧禁用标记+强制首刷；关=经主项目 setEnabled 整族清除（无桥则只落设置）。 */
export function handlePhoneMessageWorldbookToggle(on: boolean): void {
  _lastSignature = null;
  if (on) {
    // 注册必须先于 setEnabled：描述符未收录时主项目 setEnabled 是空操作
    projectionClient.register();
    // 关→开循环：协调器 featureEnabled 仍记忆 false，必须显式置回 true，
    // 否则 requestProjection 一直被静默丢弃（切卡 refreshAll / 刷新页面才自愈）
    projectionClient.setEnabled(true);
    notifyPhoneMessagesChanged();
  } else {
    projectionClient.setEnabled(false);
  }
}

/** 公共内容投影开关（设置页调用）：条目有无变了 → 清签名强制重投影（签名不看设置档位）；
 *  总开关关闭时无从投影，只落设置。 */
export function handlePhonePublicProjectionToggle(): void {
  _lastSignature = null;
  if (getPhoneSettings().messageWorldbook) notifyPhoneMessagesChanged();
}

let _bound = false;

/** 常驻绑定（boot 调用一次；回调常驻但门控在设置开关，关=零开销）。 */
export function bindPhoneMessagesWorldbook(): void {
  if (_bound) return;
  _bound = true;
  onPhoneDataMutated(() => { if (getPhoneSettings().messageWorldbook) notifyPhoneMessagesChanged(); });
  onRosterInvalidated(() => { if (getPhoneSettings().messageWorldbook) notifyPhoneMessagesChanged(); });
  // 主项目可能晚于小手机装载：共享客户端的 ready 监听会补注册并回调 onRegistered → 补投影。
  projectionClient.register();
  if (getPhoneSettings().messageWorldbook) notifyPhoneMessagesChanged();
}

// ─── 状态（设置页徽标；全本地计算，零世界书 IO） ───

export interface PhoneMessageWorldbookStatus {
  /** 主项目投影桥可用（false=未加载/版本过旧）。 */
  bridgeAvailable: boolean;
  /** 描述符已注册进主项目调度。 */
  registered: boolean;
  enabled: boolean;
  /** 有记录的角色数（=将注入的分角色条目数，0=无条目）。 */
  characterCount: number;
}

export function getPhoneMessageWorldbookStatus(): PhoneMessageWorldbookStatus {
  const settings = getPhoneSettings();
  const data = readPhoneDataRef();
  const roster = getRoster();
  const desired = settings.messageWorldbook
    ? desiredMessageEntries(settings, roster, data)
    : [];
  return {
    bridgeAvailable: projectionClient.isBridgeAvailable(),
    registered: projectionClient.isRegistered(),
    enabled: settings.messageWorldbook,
    // 说明条目/公共条目占首尾，余量为分角色条目
    characterCount: desired.filter(entry => String(entry.name).startsWith(MESSAGE_WB_PREFIX) && entry.name !== MESSAGE_WB_PUBLIC_NAME).length,
  };
}
