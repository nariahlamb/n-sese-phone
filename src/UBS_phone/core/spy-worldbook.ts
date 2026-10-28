// ===== 窥私记录注入世界书（角色间窥私记录混合块 → 角色主世界书） =====
// 链路与 message-worldbook 完全同构（同一宿主投影桥 __ubWorldbookProjection.register，
// 小手机不自建任何注入链路）；差异只有两处（用户定案）：
// ① 防全知说明条目改写：所有内容发生在角色之间——私聊/通话仅双方可知、群聊仅群内可知、
//    主角不知晓相关内容（服务正文请求的戏剧性 Irony：AI 知晓、主角不知）。
// ② 分角色条目内容 = 窥私会话/窥私通话的混合块（无社媒源）。
// 条目名沿用 [UBS手机] 统一前缀 → 自有 AI 管线扫描钩子按请求 keep 豁免（用户定案）：
// 窥私/采访/调查/演化放行窥私族+消息记录族（keepPhoneRecordEntries）；聊天/通话/社媒放行窥私族
// （keepSpyRecordEntries——主角侧请求 AI 可用角色间历史但主角仍不知情，防全知说明条目随族放行约束叙事）；
// 其余 [UBS手机] 前缀条目（如正文联动格式）照旧剔除；酒馆正常生成正常消费。

import { createCoalescer } from './ubp-utils';
import { isHostRefillMode } from './host-config';
import { dsCachePos, type WbPosSpec } from '../../unified-statusbar/core/wb-position';
import { createExternalProjectionClient } from '../../unified-statusbar/core/external-projection-client';
import { SPY_RECORDS_KEEP_PREFIX, wbEntryName } from '../../unified-statusbar/core/worldbook-entry';
import type { PhoneChatData, PhoneStyle } from './chat-model';
import { streamFingerprint } from './hash';
import { hostWindow } from './host-env';
import type { MixedRecords } from './phone-timeline';
import { buildMixedRecords } from './phone-timeline';
import { getPhoneSettings } from './phone-settings';
import { onPhoneDataMutated, readPhoneDataRef } from './phone-store';
import { getRoster, mergedContactNames, onRosterInvalidated } from './roster';

// ─── 协议常量 ───

/** 主项目投影 id（registry 内唯一；同 id 幂等覆盖）。 */
export const SPY_MESSAGE_PROJECTION_ID = 'spy-messages';

/** 条目名统一前缀（[UBS手机] 前缀条目被自有 AI 管线扫描钩子按请求剔除/keep 豁免——worldbook-entry.STORY_LINK_ENTRY_PREFIX）。 */
export const SPY_WB_PREFIX = `${SPY_RECORDS_KEEP_PREFIX}-`;
/** 防全知说明条目名（蓝灯 constant；不带尾横线但同属 SPY_KEEP_PREFIX 前缀族）。 */
export const SPY_WB_NOTE_NAME = `${SPY_RECORDS_KEEP_PREFIX}防全知说明`;
/** 扫描钩子 keep 豁免前缀（放行说明条目+分角色条目——worldbook-entry opts.keep；单一来源见 worldbook-entry.SPY_RECORDS_KEEP_PREFIX）。 */
export const SPY_KEEP_PREFIX = SPY_RECORDS_KEEP_PREFIX;

// 注入位置：消息记录条目族（说明 8008/分角色 8009）之后成对排布。
const SPY_WB_NOTE_ORDER = 8010;
const SPY_WB_CHAR_ORDER = 8011;
const NOTE_ORIG_POS: WbPosSpec = { type: 'before_character_definition', role: 'system', depth: 2, order: SPY_WB_NOTE_ORDER };
const CHAR_ORIG_POS: WbPosSpec = { type: 'before_character_definition', role: 'system', depth: 2, order: SPY_WB_CHAR_ORDER };

/** 防全知说明正文（用户定案文案：主角不知晓；风格措辞覆盖见 spyWbNoteContent）。 */
export const SPY_WB_NOTE_CONTENT = [
  '<角色间窥私记录防全知说明>',
  '下面是相关角色之间的私密通话、私聊和群聊记录。所有内容都发生在角色之间：私聊与通话的内容仅参与双方可知；群聊内容仅该群的成员可知；主角并不知晓这些内容。不要让主角或未参与的角色表现出知晓，也不要让他们在主角面前主动提及，除非剧情中角色自己决定透露。',
  '</角色间窥私记录防全知说明>',
].join('\n');

/** 防全知说明正文按风格取用（条目名/结构不变；措辞对齐 message-worldbook 各皮肤 + 主角不知晓句）。 */
export function spyWbNoteContent(style: PhoneStyle): string {
  if (style === 'xianxia') {
    return [
      '<角色间窥私记录防全知说明>',
      '下面是修士之间的私密传音、一对一符讯和共谈记录。所有内容都发生在修士之间：传音与一对一符讯仅互通双方可知；共谈内容仅盟中成员可知；主角并不知晓这些内容。不要让主角或未参与修士表现出知晓，也不要让他们主动提及，除非剧情中角色自己决定透露。',
      '</角色间窥私记录防全知说明>',
    ].join('\n');
  }
  if (style === 'wuxia') {
    return [
      '<角色间窥私记录防全知说明>',
      '下面是江湖人之间的私密传声、书信和群英会话记录。所有内容都发生在江湖人之间：传声与书信仅互通双方可知；群英会话仅会中同道可知；主角并不知晓这些内容。不要让主角或未参与江湖人表现出知晓，也不要让他们主动提及，除非剧情中角色自己决定透露。',
      '</角色间窥私记录防全知说明>',
    ].join('\n');
  }
  if (style === 'fantasy') {
    return [
      '<角色间窥私记录防全知说明>',
      '下面是冒险者之间的私密远语、晶讯和圆桌商谈记录。所有内容都发生在冒险者之间：远语与一对一晶讯仅互通双方可知；圆桌商谈仅桌旁同仁可知；主角并不知晓这些内容。不要让主角或未参与冒险者表现出知晓，也不要让他们主动提及，除非剧情中角色自己决定透露。',
      '</角色间窥私记录防全知说明>',
    ].join('\n');
  }
  return SPY_WB_NOTE_CONTENT;
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
export function buildSpyNoteEntry(style: PhoneStyle = ''): Record<string, unknown> {
  return {
    name: SPY_WB_NOTE_NAME,
    comment: SPY_WB_NOTE_NAME,
    ...baseEntryFields(NOTE_ORIG_POS),
    strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
    content: spyWbNoteContent(style),
  };
}

export interface SpyEntryInput {
  name: string;
  records: MixedRecords;
}

/** 单角色条目：绿灯 selective，触发关键词=角色名，内容=窥私混合块（标签包裹）。 */
export function buildSpyCharacterEntry(input: SpyEntryInput): Record<string, unknown> {
  return {
    name: SPY_WB_PREFIX + input.name,
    comment: SPY_WB_PREFIX + input.name,
    ...baseEntryFields(CHAR_ORIG_POS),
    strategy: { type: 'selective', keys: [input.name], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
    content: `<${input.name}最近窥私记录>\n${input.records.body}\n</${input.name}最近窥私记录>`,
  };
}

/**
 * 单角色窥私混合记录口径：TA 参与的窥隐私聊 + TA 所在的窥私群（按主角发言+故事时间双路线
 * 分块，只注入 TA 参与（发言/被@）的块）+ TA 拨出或接听的窥私通话；无社媒源（窥私域不含）。
 */
export function buildSpyCharacterRecords(data: PhoneChatData, name: string, me: string, count: number): MixedRecords {
  const spy = data.spy;
  if (!spy) return { body: '', units: 0 };
  return buildMixedRecords({
    names: [name],
    conversations: spy.conversations.filter(c => c.kind === 'private' && c.members.includes(name)),
    groupConversations: spy.conversations.filter(c => c.kind === 'group' && c.members.includes(name)),
    calls: (spy.calls || []).filter(c => c.peerName === name || c.caller === name),
    moments: [],
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
 * 目标条目集：防全知说明 + 有窥私记录角色条目（无记录角色不建条目；全体无记录 → 空数组）。
 */
export function collectSpyEntries(contactNames: readonly string[], data: PhoneChatData, me: string, count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of contactNames) {
    if (!nameIsTagSafe(name) || name === me) continue;
    const records = buildSpyCharacterRecords(data, name, me, count);
    if (!records.units) continue;
    out.push(buildSpyCharacterEntry({ name, records }));
  }
  if (!out.length) return [];
  out.unshift(buildSpyNoteEntry(data.style || ''));
  return out;
}

// ─── reconcile（纯函数：整族收敛，语义比对防 ST 往返字段抖动 → 无变化不写盘） ───

function isManagedSpyEntry(entry: any): boolean {
  const name = wbEntryName(entry);
  return name.startsWith(SPY_WB_PREFIX) || name === SPY_WB_NOTE_NAME;
}

function sameSpyEntry(entry: any, target: any): boolean {
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
  const next = entries.filter(entry => !isManagedSpyEntry(entry));
  next.splice(Math.min(insertionIndex, next.length), 0, ...desired.map(item => ({ ...item })));
  entries.splice(0, entries.length, ...next);
}

/** 窥私条目族收敛（desired=空即整族清除）。 */
export function reconcileSpyEntries(entries: any[], desired: readonly Record<string, unknown>[]): boolean {
  const managedIndices = entries
    .map((entry, index) => (isManagedSpyEntry(entry) ? index : -1))
    .filter(index => index >= 0);
  if (managedIndices.length !== desired.length) {
    applyDesired(entries, managedIndices, desired);
    return true;
  }
  for (let i = 0; i < desired.length; i++) {
    if (!sameSpyEntry(entries[managedIndices[i]], desired[i])) {
      applyDesired(entries, managedIndices, desired);
      return true;
    }
  }
  return false;
}

// ─── 投影描述符 + 宿主桥 ───

/** 注册进主项目统一调度的 reconcile（isEnabled=false → 整族清除）。 */
function projectionReconcile(entries: any[]): boolean {
  const settings = getPhoneSettings();
  if (!settings.spyWorldbook) return reconcileSpyEntries(entries, []);
  const data = readPhoneDataRef();
  const roster = getRoster();
  const desired = collectSpyEntries(
    mergedContactNames(roster, data.customContacts || []),
    data,
    roster.protagonistName,
    settings.spyHistoryCount,
  );
  return reconcileSpyEntries(entries, desired);
}

export function spyProjectionDescriptor(): { id: string; isEnabled: () => boolean; reconcile: (entries: any[]) => boolean } {
  return {
    id: SPY_MESSAGE_PROJECTION_ID,
    isEnabled: () => getPhoneSettings().spyWorldbook,
    reconcile: projectionReconcile,
  };
}

// ─── 共享外部投影客户端（桥发现/注册/ready 重试/请求/开关全部复用主项目协议） ───

const projectionClient = createExternalProjectionClient({
  descriptor: spyProjectionDescriptor(),
  window: hostWindow(),
  onRegistered: (source) => {
    if (source === 'ready' && getPhoneSettings().spyWorldbook) notifySpyRecordsChanged();
  },
  log: () => { /* 投影失败由状态栏协调器控制台报；这里保持静默 */ },
});

/** 幂等注册进主项目投影调度（桥不存在=false；主项目晚加载时由 ready 事件补注册）。 */
export function syncSpyProjectionRegistration(): boolean {
  return projectionClient.register();
}

// ─── 变更通知（签名去重 + 防抖 request） ───

const NOTIFY_DEBOUNCE_MS = 1000;

/**
 * 轻量签名：窥私域内容的代理。结构面=名单（合并视图：数据库+自定义联系人）/各源条数与首尾锚点/
 * 取量口径；内容面=各会话逐条内容指纹（消息正文/金额/图片路径/故事时间）与通话转写指纹（对齐
 * message-worldbook 口径）——投影渲染得到的正文变了签名必变（编辑消息/删除单条都触发重投影）。
 * 代价是 O(总字符数)（只在防抖后的签名计算里跑，通知带 1000ms 防抖）。
 */
export function computeSpySignature(data: PhoneChatData, contactNames: readonly string[], me: string, count: number): string {
  const parts: string[] = [`names\u0001${contactNames.join('\u0002')}`, `me\u0001${me}`, `count\u0001${count}`, `style\u0001${data.style || ''}`];
  const spy = data.spy;
  if (spy) {
    for (const conv of spy.conversations) {
      const last = conv.messages[conv.messages.length - 1];
      parts.push(`${conv.id}#${conv.title}#${conv.members.join('+')}#${conv.messages.length}#${last ? last.ts : 0}`);
      parts.push(`mc${streamFingerprint(emit => {
        for (const m of conv.messages) { emit(m.type); emit(m.content); emit(m.amount); emit(m.imagePath); emit(m.storyTime); }
      })}`);
    }
    const calls = spy.calls || [];
    parts.push(`calls#${calls.length}#${calls[0]?.startedAt || 0}#${calls[calls.length - 1]?.startedAt || 0}`);
    parts.push(`cc${streamFingerprint(emit => {
      for (const c of calls) {
        emit(c.peerName); emit(c.direction); emit(c.caller); emit(c.status); emit(c.durationSec); emit(c.rejectReason); emit(c.storyTime);
        for (const l of c.lines) { emit(l.from); emit(l.text); }
      }
    })}`);
  }
  return parts.join('\u0003');
}

let _lastSignature: string | null = null;

function requestProjectionNow(): void {
  if (!getPhoneSettings().spyWorldbook) return;
  if (!projectionClient.isRegistered() && !projectionClient.register()) return;
  const data = readPhoneDataRef();
  const roster = getRoster();
  const signature = computeSpySignature(data, mergedContactNames(roster, data.customContacts || []), roster.protagonistName, getPhoneSettings().spyHistoryCount);
  if (signature === _lastSignature) return;
  _lastSignature = signature;
  void projectionClient.request('data-change');
}

/** 变更入口：coalesce = 「pending 期间忽略后续调用」的合并（不是 debounce 的重排语义，故另名），
 *  统一实现在 core/ubp-utils；签名相同=内容没变，仍然跳过 getWorldbook 空转。 */
const notifyCoalesced = createCoalescer(NOTIFY_DEBOUNCE_MS, requestProjectionNow);

export function notifySpyRecordsChanged(): void {
  if (isHostRefillMode()) return; // F66：重填模式期间不重投影（关闭后由下一次数据变更补刷）
  notifyCoalesced();
}

// ─── 开关接线 + 常驻绑定 ───

/** 开关翻转（设置页调用）：开=确保注册+清主项目侧禁用标记+强制首刷；关=经主项目 setEnabled 整族清除。 */
export function handleSpyWorldbookToggle(on: boolean): void {
  _lastSignature = null;
  if (on) {
    projectionClient.register();
    projectionClient.setEnabled(true);
    notifySpyRecordsChanged();
  } else {
    projectionClient.setEnabled(false);
  }
}

let _bound = false;

/** 常驻绑定（boot 调用一次；回调常驻但门控在设置开关，关=零开销）。 */
export function bindSpyRecordsWorldbook(): void {
  if (_bound) return;
  _bound = true;
  onPhoneDataMutated(() => { if (getPhoneSettings().spyWorldbook) notifySpyRecordsChanged(); });
  onRosterInvalidated(() => { if (getPhoneSettings().spyWorldbook) notifySpyRecordsChanged(); });
  // 主项目可能晚于小手机装载：共享客户端的 ready 监听会补注册并回调 onRegistered → 补投影。
  projectionClient.register();
  if (getPhoneSettings().spyWorldbook) notifySpyRecordsChanged();
}

// ─── 状态（设置页徽标；全本地计算，零世界书 IO） ───

export interface SpyWorldbookStatus {
  bridgeAvailable: boolean;
  registered: boolean;
  enabled: boolean;
  /** 有窥私记录的角色数（=将注入的分角色条目数，0=无条目）。 */
  characterCount: number;
}

export function getSpyWorldbookStatus(): SpyWorldbookStatus {
  const settings = getPhoneSettings();
  const data = readPhoneDataRef();
  const roster = getRoster();
  const desired = settings.spyWorldbook
    ? collectSpyEntries(mergedContactNames(roster, data.customContacts || []), data, roster.protagonistName, settings.spyHistoryCount)
    : [];
  return {
    bridgeAvailable: projectionClient.isBridgeAvailable(),
    registered: projectionClient.isRegistered(),
    enabled: settings.spyWorldbook,
    characterCount: Math.max(0, desired.length - 1),
  };
}