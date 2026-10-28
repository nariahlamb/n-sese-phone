// ===== 社媒故事时间体系（纯函数，零依赖，可被 .cjs 测试直接 require） =====
// 记录用绝对、显示用相对（用户定案）：
//  - 归一化：AI 的自由文本时间标签（「26分钟前」「昨天 23:41」「9月3日 08:15」…）+
//    帖子落盘时的 storyTime 快照锚点（=AI 编相对时间时参照的全局「当前时间」）→ 规范绝对故事时间戳
//    （「YYYY-MM-DD HH:MM」，时刻可缺省）。解析失败返回 ''，调用方回退原文标签，绝不编造。
//  - 注入侧（混合块/世界书/待反馈段）一律用绝对故事时间，与聊天/通话的 storyTime 快照同一体系；
//  - 渲染侧（四个社媒 App UI）按「当前故事时间」与记录的绝对时间的关系动态分桶（微博式，用户定案）：
//    1小时内「X分钟前」→ 当日「今天 HH:MM」→ 昨日「昨天 HH:MM」→ 当年「M月D日」→ 跨年「YYYY年M月D日」。
//  - 相对化基准=故事时间域（当前全局数据表时间），不用真实时钟；日期运算用纯历法算法（负年份安全）。

/** 规范绝对故事时间戳：「YYYY-MM-DD」或「YYYY-MM-DD HH:MM」。 */
export type StoryStamp = string;

/** 解析出的故事日期+时刻（date=YYYY-MM-DD，可为负号年份；time=HH:MM 或 ''）。 */
export interface StoryDateTime {
  date: string;
  time: string;
}

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 数量解析：阿拉伯数字优先，兼容常见中文数字（一~九十九、半）。失败 -1。 */
function parseCount(text: string): number {
  const raw = String(text || '').trim();
  if (!raw) return -1;
  if (raw === '半') return 0.5;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (!/^[零一二两三四五六七八九十]+$/.test(raw)) return -1;
  if (raw === '十') return 10;
  const tenIdx = raw.indexOf('十');
  if (tenIdx === -1) return CN_DIGITS[raw] ?? -1;
  const tens = tenIdx === 0 ? 1 : CN_DIGITS[raw[0]] ?? -1;
  const ones = tenIdx === raw.length - 1 ? 0 : CN_DIGITS[raw[raw.length - 1]] ?? -1;
  if (tens < 0 || ones < 0) return -1;
  return tens * 10 + ones;
}

function fmtDateKey(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${y < 0 ? '-' : ''}${String(Math.abs(y)).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 宽松匹配落在数字串中间（年份超过 6 位）时返回 true：正则只吃到后 6 位、丢掉首位数字
 *  （七位年份 1234567 → 234567，日期整整错一个量级）。这种情况宁可判「无日期」，
 *  也不返回一个看起来合法的错日期——6 位是本解析契约的硬上限。 */
export function matchedInsideDigitRun(text: string, index: number | undefined): boolean {
  const i = index ?? 0;
  return i > 0 && /\d/.test(text.charAt(i - 1));
}

/** 从文本解析日期键 YYYY-MM-DD：2026-03-02 / 2026年3月2日；「3月2日」类缺年形式需 baseYear 补年。失败 ''。
 *  年份幅值接受 1-6 位：四位纪年是常态，五位以上（如 14900）不能被截断成后四位。 */
export function parseStoryDateKey(text: string, baseYear?: number): string {
  const raw = String(text || '');
  const m = raw.match(/(-?\d{1,6})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})/);
  if (m && !matchedInsideDigitRun(raw, m.index)) return fmtDateKey(Number(m[1]), Number(m[2]), Number(m[3]));
  const md = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (md && baseYear !== undefined) return fmtDateKey(baseYear, Number(md[1]), Number(md[2]));
  return '';
}

/** 从文本解析时刻 HH:MM（14:20 / 14时20分 / 14点20分）。失败 ''。 */
export function parseStoryClock(text: string): string {
  const raw = String(text || '');
  let m = raw.match(/(\d{1,2})[:：](\d{2})/);
  if (m) {
    const h = Number(m[1]);
    if (h <= 23 && Number(m[2]) <= 59) return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  m = raw.match(/(\d{1,2})[时点](\d{1,2})分?/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h <= 23 && min <= 59) return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return '';
}

/** 解析故事时间快照文本（全局数据表「当前时间」，如「2026年9月3日 14:20 周五」）；无年份成分 date=''。 */
export function parseStoryAnchor(text: string): StoryDateTime {
  const raw = String(text || '').trim();
  if (!raw) return { date: '', time: '' };
  const dm = raw.match(/(-?\d{1,6})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})/);
  const hit = dm && !matchedInsideDigitRun(raw, dm.index) ? dm : null;
  return { date: hit ? fmtDateKey(Number(hit[1]), Number(hit[2]), Number(hit[3])) : '', time: parseStoryClock(raw) };
}

// ─── 历法纯运算（Howard Hinnant civil 换算；负年份安全，不依赖真实时钟对象） ───

/** 天序号（自 1970-01-01 起；公历换算）。 */
function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 天序号 → 公历 y/m/d。参数名勿用裸 z（unplugin-auto-import 误注入 import {z} from 'zod' → 全局 z 外部引用）。 */
function civilFromDays(days: number): { y: number; m: number; d: number } {
  days += 719468;
  const era = Math.floor(days / 146097);
  const doe = days - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

function dateKeyToSerial(key: string): number {
  const m = key.match(/^(-?\d{4,6})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
}

function serialToKey(serial: number): string {
  const { y, m, d } = civilFromDays(serial);
  return fmtDateKey(y, m, d);
}

function yearOf(key: string): number {
  const m = key.match(/^(-?\d{4,6})-/);
  return m ? Number(m[1]) : NaN;
}

/** 日期键 → "MM-DD"（年份幅值 4-6 位、负年份都安全）；不可解析返回 ''。
 *  替代 slice(5)——五位纪年下会切进月日（14900-07-15 → "-07-15"）。 */
export function monthDayOfDateKey(dateKey: string): string {
  const m = String(dateKey || '').match(/^-?\d{4,6}-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}` : '';
}

/** 日期键 → 年份数值（幅值 4-6 位、负年份；不可解析返回 NaN）。
 *  替代 slice(0, 4)——五位纪年下只取到前四位（14900 → 1490）。 */
export function yearOfDateKey(dateKey: string): number {
  const m = String(dateKey || '').match(/^(-?\d{1,6})-/);
  return m ? Number(m[1]) : NaN;
}

function clockToMinutes(clock: string): number {
  const m = clock.match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function minutesToClock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function shiftDays(dateKey: string, days: number): string {
  return serialToKey(dateKeyToSerial(dateKey) + days);
}

function daysInMonth(y: number, m: number): number {
  if (m < 1 || m > 12) return 0;
  const feb = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [31, feb, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function shiftMonths(dateKey: string, months: number): string {
  const m = dateKey.match(/^(-?\d{4,6})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const total = y * 12 + (mo - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return fmtDateKey(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** 锚点日期移动分钟数（跨日安全；时刻可越过午夜）。 */
function shiftMinutes(dateKey: string, clock: string, minutes: number): string {
  const base = clockToMinutes(clock);
  if (Number.isNaN(base)) return '';
  const total = base - minutes;
  const serial = dateKeyToSerial(dateKey) + Math.floor(total / 1440);
  return `${serialToKey(serial)} ${minutesToClock(((total % 1440) + 1440) % 1440)}`;
}

// ─── 标签 → 绝对时间戳归一化 ───

/** 规范时间戳 → {date, time}。 */
export function parseStamp(stamp: string): StoryDateTime {
  const m = String(stamp || '').trim().match(/^(-?\d{4,6}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/);
  return m ? { date: m[1], time: m[2] || '' } : { date: '', time: '' };
}

/**
 * 规范时间戳 → 分钟序号（日期序号×1440 + 当日分钟；无时刻成分按当日 00:00）。
 * 不可解析返回 NaN——调用方据此判定「未收录」。编年史的分段间隔与密度条定位用它。
 */
export function stampMinutes(stamp: string): number {
  const { date, time } = parseStamp(stamp);
  if (!date) return NaN;
  const serial = dateKeyToSerial(date);
  if (Number.isNaN(serial)) return NaN;
  const clock = clockToMinutes(time);
  return serial * 1440 + (Number.isNaN(clock) ? 0 : clock);
}

/**
 * 记录自带的故事时间快照 → 规范绝对时间戳（自锚：快照即锚点，绝不用「当前时间」二次换算）。
 * 快照通常是「2026年9月3日 14:20 周五」这类绝对文本，直接归一；若快照本身是「刚刚/昨天」这类
 * 相对说法则解析失败返回 ''（不猜、不漂移——这正是编年史「未收录」口径的来源）。
 */
export function selfStamp(storyTime: string): string {
  const t = String(storyTime || '').trim();
  return t ? normalizeStoryTimeLabel(t, t) : '';
}

function withTime(date: string, clock: string): string {
  if (!date) return '';
  return clock ? `${date} ${clock}` : date;
}

/**
 * AI 自由文本时间标签 → 规范绝对故事时间戳（''=不可解析，调用方回退原文）。
 * 提示词已要求填表一律绝对时间（2026-09 定案）；此处相对形式（刚刚/N分钟前/半小时/N小时前/N刻钟前/N个时辰前/
 * N天前/N周前/N个月前/昨天/前天/今天）全部保留为存量数据与 AI 失误的兜底解析，全部基于锚点换算；
 * 绝对形式（M月D日 / YYYY年M月D日 / YYYY-M-D / 裸 HH:MM）不依赖锚点时刻，仅缺年时补锚点年份。
 */
export function normalizeStoryTimeLabel(label: string, anchor?: string): string {
  const raw = String(label || '').trim();
  if (!raw) return '';
  const a = parseStoryAnchor(anchor || '');

  if (/^(刚刚|刚才)/.test(raw)) return withTime(a.date, a.time);

  // 相对分钟/小时/刻钟/时辰（一刻钟=15分、时辰=2小时；锚点无时刻时退化为锚点同日，时刻不编造）
  const agoMin = raw.match(/^(半|[零一二两三四五六七八九十\d]+)\s*(分钟|小时|刻钟|个时辰)前/);
  if (agoMin) {
    const n = parseCount(agoMin[1]);
    if (n >= 0 && a.date) {
      const unit = agoMin[2];
      const shift = Math.round(n * (unit === '小时' ? 60 : unit === '刻钟' ? 15 : unit === '个时辰' ? 120 : 1));
      return a.time ? shiftMinutes(a.date, a.time, shift) : a.date;
    }
  }

  // 相对天/周/月（「N天前」「3天前 21:03」「两周前」「2个月前」；缺省只到日）
  const agoLong = raw.match(/^([零一二两三四五六七八九十\d]+)\s*(天|日|周|星期|个月)前/);
  if (agoLong) {
    const n = parseCount(agoLong[1]);
    if (n > 0 && a.date) {
      const unit = agoLong[2];
      const target = unit === '周' || unit === '星期' ? shiftDays(a.date, -7 * n)
        : unit === '个月' ? shiftMonths(a.date, n)
          : shiftDays(a.date, -n);
      return withTime(target, parseStoryClock(raw));
    }
  }

  // 今天/昨天/前天（可带时刻）
  const dayRel = raw.match(/^(昨天|昨日|前天|今天|今日)\s*(.*)$/);
  if (dayRel) {
    if (!a.date) return '';
    const offset = dayRel[1].startsWith('昨') ? -1 : dayRel[1].startsWith('前') ? -2 : 0;
    return withTime(shiftDays(a.date, offset), parseStoryClock(dayRel[2]));
  }

  // M月D日（补锚点年份；候选晚于锚点日期视作上一年——故事时间不能是未来）
  const md = raw.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(.*)$/);
  if (md && a.date) {
    let candidate = parseStoryDateKey(`${md[1]}月${md[2]}日`, yearOf(a.date));
    if (candidate && dateKeyToSerial(candidate) > dateKeyToSerial(a.date)) {
      candidate = parseStoryDateKey(`${md[1]}月${md[2]}日`, yearOf(a.date) - 1);
    }
    if (candidate) return withTime(candidate, parseStoryClock(md[3]));
  }

  // 绝对形式（完整年份）与裸时刻
  const full = parseStoryDateKey(raw);
  if (full) return withTime(full, parseStoryClock(raw));
  const clock = parseStoryClock(raw);
  if (clock && a.date) return withTime(a.date, clock);

  return '';
}

// ─── 绝对时间戳格式化 ───

/** 绝对时间戳 → 人读全文（「2026年9月2日 23:41」；无时刻只到日）。''=不可解析。 */
export function formatStampFull(stamp: string): string {
  const { date, time } = parseStamp(stamp);
  if (!date) return '';
  const m = date.match(/^(-?\d{4,6})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const y = Number(m[1]);
  return `${y < 0 ? '-' : ''}${Math.abs(y)}年${Number(m[2])}月${Number(m[3])}日${time ? ` ${time}` : ''}`;
}

/**
 * 绝对时间戳 → 相对显示（微博式分桶，用户定案；基准=当前故事时间文本）：
 * 当日 1小时内「X分钟前」→ 当日「今天 HH:MM」（无时刻成分「今天」）→「昨天 HH:MM」→「M月D日」→ 跨年「YYYY年M月D日」。
 * 时间戳不可解析返回 ''（调用方回退）；当前故事时间不可解析返回 ''（调用方退回绝对全文）。
 */
export function formatStampRelative(stamp: string, now: string): string {
  const s = parseStamp(stamp);
  if (!s.date) return '';
  const n = parseStoryAnchor(now || '');
  if (!n.date) return '';
  const sd = dateKeyToSerial(s.date);
  const nd = dateKeyToSerial(n.date);
  if (sd === nd) {
    if (s.time && n.time) {
      const delta = clockToMinutes(n.time) - clockToMinutes(s.time);
      if (delta >= 0 && delta < 60) return delta === 0 ? '刚刚' : `${delta}分钟前`;
    }
    return s.time ? `今天 ${s.time}` : '今天';
  }
  if (nd - sd === 1) return s.time ? `昨天 ${s.time}` : '昨天';
  const sm = s.date.match(/^(-?\d{4,6})-(\d{2})-(\d{2})$/);
  if (!sm) return '';
  const y = Number(sm[1]);
  const dateText = `${Number(sm[2])}月${Number(sm[3])}日`;
  return yearOf(s.date) === yearOf(n.date) ? dateText : `${y < 0 ? '-' : ''}${Math.abs(y)}年${dateText}`;
}

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 日期键 → 星期（公历；serial 0=1970-01-01 星期四）。 */
function weekdayName(dateKey: string): string {
  const serial = dateKeyToSerial(dateKey);
  if (Number.isNaN(serial)) return '';
  return WEEKDAY_NAMES[(((serial + 4) % 7) + 7) % 7];
}

/**
 * 绝对时间戳 → 微信会话列表相对显示（真机微信口径，与社媒分桶不同，用户定案）：
 *  当日「HH:mm」（无时刻成分退回「今天」）→「昨天」→ 一周内「星期X」→ 更早「M-D」（跨年「YYYY-MM-DD」）。
 * 时间戳不可解析返回 ''（调用方回退原文）；当前故事时间不可解析返回 ''（调用方退回绝对原文）。
 */
export function formatStampChat(stamp: string, now: string): string {
  const s = parseStamp(stamp);
  if (!s.date) return '';
  const n = parseStoryAnchor(now || '');
  if (!n.date) return '';
  const delta = dateKeyToSerial(n.date) - dateKeyToSerial(s.date);
  if (Number.isNaN(delta)) return '';
  if (delta <= 0) return s.time || '今天'; // 当日（或更晚的故事时间，理论上不出现）
  if (delta === 1) return '昨天';
  if (delta <= 6) return weekdayName(s.date) || '昨天';
  const sm = s.date.match(/^(-?\d{4,6})-(\d{2})-(\d{2})$/);
  if (!sm) return '';
  const y = Number(sm[1]);
  const md = `${sm[2]}-${sm[3]}`;
  return yearOf(s.date) === yearOf(n.date) ? md : `${y < 0 ? '-' : ''}${Math.abs(y)}-${md}`;
}

// ─── 帖/评论/动作的取戳与显示（落盘 storyStamp 优先，存量数据用标签+锚点惰性回填） ───

/** 社媒时间相关对象的最小形状（帖/评论/待反馈动作共用）。 */
export interface SocialTimeLike {
  /** AI/快照时间标签原文（帖子 timeLabel；评论/动作 time）。 */
  timeLabel?: string;
  time?: string;
  /** 生成时的故事时间快照（锚点）。 */
  storyTime?: string;
  /** 已归一化的规范绝对时间戳（落盘时盖；优先使用）。 */
  storyStamp?: string;
}

/** 帖子的绝对时间戳：已存 storyStamp 优先，否则 timeLabel+storyTime 锚点惰性归一（存量回填）。 */
export function postStoryStamp(post: SocialTimeLike): string {
  const stored = (post.storyStamp || '').trim();
  if (stored) return stored;
  return normalizeStoryTimeLabel(post.timeLabel || '', post.storyTime || '');
}

/** 评论的绝对时间戳（评论不存锚点，锚定父帖快照；存量反馈评论尽力回填）。 */
export function commentStoryStamp(comment: { time?: string; storyStamp?: string }, post: SocialTimeLike): string {
  const stored = (comment.storyStamp || '').trim();
  if (stored) return stored;
  return normalizeStoryTimeLabel(comment.time || '', post.storyTime || post.timeLabel || '');
}

/** 帖子显示时间：相对分桶优先；当前时间/标签不可解析时退回绝对全文/原文标签。 */
export function postTimeText(post: SocialTimeLike, now: string): string {
  const label = (post.timeLabel || '').trim();
  const stamp = postStoryStamp(post);
  if (!stamp) return label;
  return formatStampRelative(stamp, now) || formatStampFull(stamp) || label;
}

/** 评论显示时间（无时间标签返回 ''，由调用方决定省略）。 */
export function commentTimeText(comment: { time?: string; storyStamp?: string }, post: SocialTimeLike, now: string): string {
  if (!comment.time && !comment.storyStamp) return '';
  const stamp = commentStoryStamp(comment, post);
  if (!stamp) return (comment.time || '').trim();
  return formatStampRelative(stamp, now) || formatStampFull(stamp) || (comment.time || '').trim();
}

/** 待反馈动作显示时间（动作的标签即动作时的故事时间快照，自锚定归一）。 */
export function actionTimeText(action: { time?: string; storyStamp?: string }, now: string): string {
  const label = (action.time || '').trim();
  const stamp = (action.storyStamp || '').trim() || normalizeStoryTimeLabel(label, label);
  if (!stamp) return label || '刚刚';
  return formatStampRelative(stamp, now) || formatStampFull(stamp) || label || '刚刚';
}