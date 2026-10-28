// ===== 电话通话数据模型（纯函数，零依赖，可被 .cjs 测试直接 require） =====
// 存储语义见 docs/05 §3：通话记录挂 PhoneChatData.calls（usb_phone_<h>.json），
// 不写微信会话/不写主项目楼层。direction：outgoing=拨出 / incoming=来电（世界演化联动）。
// 时间戳纪律同社媒：storyTime=快照原文，storyStamp=自锚归一后的规范绝对戳（见 social-time）。

import { formatMMSS, isRecord, makeId } from './ubp-utils';
import { selfStamp } from './social-time';

export type CallStatus = 'answered' | 'rejected' | 'cancelled' | 'missed';
export type CallDirection = 'outgoing' | 'incoming';

/** 通话中的一行转写。 */
export interface CallLine {
  from: 'me' | 'peer';
  text: string;
  /** 相对接通时刻的秒数。 */
  relSec: number;
  /** 该句语音的缓存指纹（voicePlanFor 的 cacheKey；开逐句朗读时写入，供重听/导出复用同一份音频）。 */
  audio?: string;
  /** 该句情绪（规范中文八词之一；来源＝AI 行首标注，见 call-parser.splitLineTag）。 */
  voiceEmotion?: string;
  /** 该句演绎说明（怎么念，≤40 字）。 */
  voiceDelivery?: string;
}

/** 通话记录。 */
export interface CallRecord {
  id: string;
  peerName: string;
  /** 头像快照路径（拨出/来电时定格；空=无头像）。 */
  peerAvatar?: string;
  /** outgoing=我方拨出；incoming=对方来电（世界演化联动）。 */
  direction: CallDirection;
  /** 拨出方角色名（仅窥隐私下通话记录带：主角通话不设=按「我」渲染）。 */
  caller?: string;
  status: CallStatus;
  /** 拒接理由（outgoing status='rejected' 时=对方拒接原因）。 */
  rejectReason?: string;
  /** 通话秒数（rejected/cancelled=0）。 */
  durationSec: number;
  /** 故事时间快照（拨出时）。 */
  storyTime?: string;
  /** 规范绝对故事时间戳（由 storyTime 自锚归一；编年史按天回顾用；解析失败不写）。 */
  storyStamp?: string;
  /** 正文联动提取来源楼层 id（重提取=同层整替去重；仅提取条目带）。 */
  srcMesId?: string;
  /** 真实时间戳（拨出时刻）。 */
  startedAt: number;
  /** 对方接通时内心想法（首轮；玩家元信息）。 */
  thought?: string;
  lines: CallLine[];
  /** 语音留言（T1）：来电未接/被拒后对方补留的话（1-3 行，from 恒 'peer'）。
   *  由 `call-voicemail.scheduleVoicemail` 异步落库；旧档无此字段零迁移。 */
  voicemail?: CallLine[];
  /** 留言是否已听过（开始播放留言即置 true；缺省=未听，记录行显示红点）。 */
  voicemailSeen?: boolean;
  /** TTS 预留（P2 不写）。 */
  audio?: string;
  /** 已在通话记录里看过（未看的 rejected/cancelled/missed 计入桌面角标）。 */
  seen?: boolean;
}

/** 通话记录上限（超出丢最旧）。 */
export const MAX_CALL_RECORDS = 200;
/** 单次通话转写行数**不设内容上限**（用户定案：正文联动提取的通话行数不截断）。
 *  这里保留的 5000 行只是**损坏数据护栏**（导入的脏存档别把界面拖死），正常内容永远撞不到：
 *  单层正文写满 5000 行台词在模型输出量级上不存在。 */
export const MAX_CALL_LINES = 5000;
/** 绿灯触发/资料块携带的通话转写上限（docs/05 §4）。 */
export const MAX_TRANSCRIPT_LINES = 100;
/** 语音留言行上限（T1：解析/落库两端同口径）。 */
export const MAX_VOICEMAIL_LINES = 3;

function str(value: unknown, maxLen = 2000): string {
  return typeof value === 'string' ? value.slice(0, maxLen) : '';
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function makeCallRecordId(): string {
  return makeId('cr_');
}

export function normalizeCallLine(value: unknown): CallLine | null {
  if (!isRecord(value)) return null;
  const from = value.from === 'me' ? 'me' : value.from === 'peer' ? 'peer' : null;
  const text = str(value.text).trim();
  if (!from || !text) return null;
  const line: CallLine = { from, text, relSec: Math.max(0, Math.floor(num(value.relSec, 0))) };
  const audio = str(value.audio, 400);
  if (audio) line.audio = audio;
  const emotion = str(value.voiceEmotion, 20).trim();
  if (emotion) line.voiceEmotion = emotion;
  const delivery = str(value.voiceDelivery, 40).trim();
  if (delivery) line.voiceDelivery = delivery;
  return line;
}

/** 通话记录净化（磁盘读回容错）。 */
export function normalizeCallRecord(value: unknown): CallRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' && value.id ? value.id : '';
  const peerName = str(value.peerName, 60).trim();
  if (!id || !peerName) return null;
  const status: CallStatus = value.status === 'rejected' || value.status === 'cancelled' || value.status === 'missed'
    ? value.status
    : 'answered';
  const direction: CallDirection = value.direction === 'incoming' ? 'incoming' : 'outgoing';
  const lines = Array.isArray(value.lines)
    ? value.lines.map(normalizeCallLine).filter((l): l is CallLine => l !== null).slice(-MAX_CALL_LINES)
    : [];
  const record: CallRecord = {
    id,
    peerName,
    direction,
    // missed 仅来电合法；拨出侧旧数据防御归一为 cancelled
    status: direction === 'outgoing' && status === 'missed' ? 'cancelled' : status,
    durationSec: Math.max(0, Math.floor(num(value.durationSec, 0))),
    startedAt: num(value.startedAt, Date.now()),
    lines,
    seen: value.seen === true,
  };
  const caller = str(value.caller, 60).trim();
  if (caller) record.caller = caller;
  const rejectReason = str(value.rejectReason, 200).trim();
  if (rejectReason) record.rejectReason = rejectReason;
  const storyTime = str(value.storyTime, 60).trim();
  if (storyTime) {
    record.storyTime = storyTime;
    // 绝对故事时间戳：写侧盖（拨出时快照自锚）＋存量惰性回填。零迁移。
    const stamp = selfStamp(storyTime);
    if (stamp) record.storyStamp = stamp;
  }
  const thought = str(value.thought, 500).trim();
  if (thought) record.thought = thought;
  const peerAvatar = str(value.peerAvatar, 400).trim();
  if (peerAvatar) record.peerAvatar = peerAvatar;
  const audio = str(value.audio, 400).trim();
  if (audio) record.audio = audio;
  const srcMesId = str(value.srcMesId, 24).trim();
  if (srcMesId) record.srcMesId = srcMesId;
  // 语音留言（T1）：只收 from='peer' 的行（数据契约），上限同解析端。
  const voicemail = Array.isArray(value.voicemail)
    ? value.voicemail
      .map(normalizeCallLine)
      .filter((l): l is CallLine => l !== null && l.from === 'peer')
      .slice(0, MAX_VOICEMAIL_LINES)
    : [];
  if (voicemail.length) {
    record.voicemail = voicemail;
    if (value.voicemailSeen === true) record.voicemailSeen = true;
  }
  return record;
}

// ─── 展示与匹配 ───

/** 秒 → MM:SS（3600 → 60:00，负数按 0）；实现统一在 core/ubp-utils。 */
export function formatDuration(sec: number): string {
  return formatMMSS(sec);
}

/**
 * 语音留言总时长估算（秒）：每行 ≈4 字/秒（对齐 voiceDurationSeconds 口径）+ 1s 行间停顿，每行下限 1s。
 * 留言卡恒用估算显示（不随是否已合成跳变）——真实时长只影响播放进度，不参与展示。
 */
export function voicemailDurationSec(lines: readonly CallLine[]): number {
  let t = 0;
  for (const l of lines) {
    const len = String(l.text || '').replace(/\s+/g, '').length;
    t += Math.max(1, Math.round(len / 4)) + 1;
  }
  return lines.length ? Math.max(1, t) : 0;
}

/** 连播序列（T2，纯函数）：可播行 = 对方台词且已固化音频指纹（与重听置灰口径一致）。 */
export function replayableLineIndexes(record: Pick<CallRecord, 'lines'>): number[] {
  const out: number[] = [];
  record.lines.forEach((l, i) => {
    if (l.from !== 'me' && l.audio) out.push(i);
  });
  return out;
}

/** 留言未听判定（记录行红点）。 */
export function voicemailUnheard(record: Pick<CallRecord, 'voicemail' | 'voicemailSeen'>): boolean {
  return Boolean(record.voicemail?.length) && record.voicemailSeen !== true;
}

/** status+direction → 图标名（渲染层映射 SVG：answered=拨出/呼入箭头，其余=未接叉）。 */
export function callStatusIcon(record: Pick<CallRecord, 'status' | 'direction'>): 'callOut' | 'callIn' | 'callMissed' {
  if (record.status !== 'answered') return 'callMissed';
  return record.direction === 'incoming' ? 'callIn' : 'callOut';
}

/** 记录列表预览文案（通话记录行第二行；来电与拨出口径区分）。 */
export function callRecordPreview(record: CallRecord): string {
  if (record.status === 'missed') return record.direction === 'incoming' ? '未接来电' : '已取消';
  if (record.direction === 'incoming') {
    if (record.status === 'rejected') return '已拒接';
    if (record.status === 'cancelled') return '已取消';
    return `已接通 ${formatDuration(record.durationSec)}`;
  }
  if (record.status === 'rejected') return record.rejectReason ? `对方拒接：${record.rejectReason}` : '对方拒接';
  if (record.status === 'cancelled') return '已取消';
  return `已接通 ${formatDuration(record.durationSec)}`;
}

/**
 * 名字 → 稳定 11 位伪手机号（前缀 1）。同步 FNV 双轮散列取数字：
 * 同名恒同号（重开/换会话不漂移），不同名极小概率同号（T9 场景可接受）。
 */
export function t9PseudoNumber(name: string): string {
  const s = String(name || '').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let g = 0x9e3779b9;
  for (let i = s.length - 1; i >= 0; i--) {
    g = Math.imul(g ^ Math.imul(s.charCodeAt(i), 31), 0x85ebca6b) >>> 0;
  }
  const digits = `${h >>> 0}`.padStart(10, '0') + `${g >>> 0}`.padStart(10, '0');
  return `1${digits.slice(0, 10)}`;
}

/** 按已输入数字前缀匹配联系人（号码 startsWith；空输入返回空。getNumber 缺省=T9 伪号码，电话 App 传入「自定义号码优先」取值）。 */
export function matchByDigits<T extends { name: string }>(
  digits: string,
  contacts: readonly T[],
  getNumber: (contact: T) => string = c => t9PseudoNumber(c.name),
): T[] {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return [];
  return contacts.filter(c => getNumber(c).startsWith(d));
}

/** 姓名模糊匹配（双向子串，通讯录/拨号盘搜索共用）。 */
export function matchByName<T extends { name: string }>(query: string, contacts: readonly T[]): T[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return contacts.filter(c => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()));
}

/**
 * 通话转写格式化（绿灯触发 + 资料块复用）：`[MM:SS] 我：xxx / [MM:SS] {peer}：xxx`，
 * 取最新 maxLines 条；空数组 → 占位文案。meLabel：拨出方显示名（窥隐私下通话=拨出方角色名，
 * 主角通话缺省「我」）。
 */
export function formatCallTranscript(lines: readonly CallLine[], maxLines: number, peerName = '对方', meLabel = '我'): string {
  if (!lines.length) return '（本通话刚开始）';
  const tail = lines.slice(-Math.max(1, Math.floor(maxLines)));
  return tail
    .map(l => `[${formatDuration(l.relSec)}] ${l.from === 'me' ? meLabel : peerName}：${l.text}`)
    .join('\n');
}

// ─── 记录增删（不可变） ───

/** 追加记录（新→旧，超上限丢最旧）。 */
export function addCallRecord(calls: readonly CallRecord[], record: CallRecord, cap = MAX_CALL_RECORDS): CallRecord[] {
  return [record, ...calls].slice(0, Math.max(1, cap));
}

/** 删除指定 id 的记录。 */
export function deleteCallRecord(calls: readonly CallRecord[], id: string): CallRecord[] {
  return calls.filter(c => c.id !== id);
}

/** 未看角标计数：未看的 rejected/cancelled/missed（打开电话 App 即全部置 seen）。 */
export function unreadCallCount(calls: readonly CallRecord[]): number {
  return calls.filter(c => !c.seen && (c.status === 'rejected' || c.status === 'cancelled' || c.status === 'missed')).length;
}
