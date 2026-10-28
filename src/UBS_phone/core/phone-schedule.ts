// ===== 日程提醒（M7）：读主项目「备忘录」表 → 今天/明天窗口内的提醒 =====
// 数据源：主项目「备忘录」表（memo_title + appointed_time 约定时间 + detail_desc）——就是用户在
//   主项目里看的那张表，口径天然一致；也顺带覆盖「在主项目侧手填/手改」的条目（不再依赖聊天气泡）。
// 窗口：**只提醒约定日期是「今天」或「明天」的**。更早 = 已过期（自动消失，不打扰）；更晚 = 还没到。
// 生命周期（用户定案）：
//   首次出现（进入窗口且未确认）→ 弹一次**横幅**（一次一条，点「知道了」出下一条）
//   **同时**在通知中心出现（未确认态，带「知道了」）；
//   「知道了」= 写 scheduleAcks（横幅不再弹）→ 通知中心那条转为**常驻**（无按钮），直到删除或过期。
// 时间纪律：窗口依据 = 主项目全局故事时间的**规范日**（selfStamp → YYYY-MM-DD）；解析不出 = 不产生
//   提醒（绝不拿真实时钟冒充故事时间）。「明天」= 该日 +1 天（纯日历运算，不读真实时钟）。
// 开销：备忘行按「故事日期」缓存（同一故事日内只读一次表）+ 显式失效；无常驻定时器、无轮询。

import { pad2 } from './ubp-utils';
import type { PhoneChatData } from './chat-model';
import { parseStoryDate, readPhoneMemoRows, type PhoneMemoRow } from './phone-memo';
import { selfStamp, stampMinutes, yearOfDateKey } from './social-time';

/** 一条在窗口内的日程提醒。 */
export interface MemoScheduleEntry {
  /** 稳定确认键（跨读取稳定：row_id + 约定日 + 标题；行被删/日期或标题被改 = 视为新内容）。 */
  key: string;
  rowId: string;
  title: string;
  /** 详细内容（卡片副行；已压空白并截断）。 */
  detail: string;
  /** 约定日期（规范日 YYYY-MM-DD）。 */
  dueDate: string;
  /** 窗口段（渲染层据此出「今天 / 明天」文案）。 */
  when: 'today' | 'tomorrow';
  /** 横幅是否已确认（已确认=不再弹横幅；通知中心仍常驻直到删除/过期）。 */
  acked: boolean;
}

/** 单次最多产出的提醒条数（通知中心的职责是「知道有事」，不是归档）。 */
export const MAX_SCHEDULE_ITEMS = 20;

/** 确认键（不含时间戳；日期或标题被改即换键 → 视为新内容，重新弹一次横幅）。 */
export function scheduleKey(rowId: string, dueDate: string, title: string): string {
  return `${rowId}|${dueDate}|${title}`.trim().slice(0, 120);
}

/** 规范日 + N 天（纯日历运算；入参非法返回 ''）。 */
export function addDays(date: string, n: number): string {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  if (Number.isNaN(d.getTime())) return '';
  // 年份幅值至少 4 位补零（getUTCFullYear 对五位纪年原样输出，不必补）
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 约定日 →「05-19 周二」（渲染层卡片日期徽章；非法入参返回 ''，不编造）。
 *  逐字段回验：Date.UTC 会把 13 月/40 日这类越界值静默进位（2026-13-40 → 2027-02-09），
 *  显示文案不能容忍这种「猜出来的日期」。 */
export function scheduleDueLabel(dueDate: string): string {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(String(dueDate || '').trim());
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())
    || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return '';
  return `${m[2]}-${m[3]} ${WEEK_LABELS[d.getUTCDay()]}`;
}

/**
 * 卡片标题（去掉与「今天/明天」徽章重复的日期前缀）。
 * 模型生成备忘时常把日期写进标题（「今天，林安安的柠檬水约定」），而卡片头部已经有一枚
 * 「今天 · 05-19」徽章——照原样渲染就重复一遍。
 * **要求前缀后必须跟分隔符**：否则「今天的事」这类正文会被切成「的事」。去完为空则回退原串。
 */
export function scheduleDisplayTitle(title: string): string {
  const raw = String(title || '').trim();
  if (!raw) return '';
  const stripped = raw.replace(/^(今天|明天|今日)[，,、:：]\s*/, '').trim();
  return stripped || raw;
}

/** 当前故事时间的规范日（YYYY-MM-DD；解析不出返回 ''，调用方据此不产生提醒）。 */
export function storyDateOf(storyTime: string): string {
  const stamp = selfStamp(String(storyTime || '').trim());
  const m = /^(\d{4,6}-\d{2}-\d{2})/.exec(stamp);
  return m ? m[1] : '';
}

// ─── 备忘行缓存（按故事日期） ───

let _rows: PhoneMemoRow[] | null = null;
let _rowsForDate = '';
let _loaded = false;

/**
 * 失效缓存（下次 collect 重新读表）。调用时机：备忘录新增/删除、切聊天重绑、打开通知中心、开机。
 * 我们自己写库不会触发主项目的表格更新回调（那个回调只由主项目数据回路驱动），故必须显式失效。
 */
export function invalidatePhoneScheduleCache(): void {
  _loaded = false;
}

function memoRowsFor(storyDate: string): PhoneMemoRow[] {
  if (_loaded && _rowsForDate === storyDate) return _rows || [];
  const rows = readPhoneMemoRows(); // 无神数据库/无读能力 → null（不产生提醒，不猜）
  _rows = rows;
  _rowsForDate = storyDate;
  _loaded = true;
  return rows || [];
}

/**
 * 窗口内的提醒（约定日期 = 今天或明天），已确认/未确认都返回（未确认的带 acked=false）。
 * 排序：约定日升序（今天在前），同日按标题。
 */
export function collectPhoneSchedule(data: PhoneChatData, now: string): MemoScheduleEntry[] {
  const today = storyDateOf(now);
  if (!today) return []; // 故事时间不可解析：不产生提醒（绝不拿真实时钟冒充）
  const tomorrow = addDays(today, 1);
  // 取值走 yearOfDateKey（幅值 4-6 位安全）；slice(0, 4) 在五位纪年下会把 14900 读成 1490
  const year = yearOfDateKey(today);
  if (Number.isNaN(year)) return [];
  const acked = new Set(data.scheduleAcks || []);
  const out: MemoScheduleEntry[] = [];
  for (const row of memoRowsFor(today)) {
    const dueDate = parseStoryDate(row.appointedTime, year);
    if (!dueDate) continue; // 约定时间不可解析（空/自由文本）→ 这条不参与提醒
    if (dueDate !== today && dueDate !== tomorrow) continue; // 过期（更早）或还没到（更晚）
    const title = String(row.title || '').trim();
    if (!title) continue;
    const key = scheduleKey(row.rowId, dueDate, title);
    out.push({
      key,
      rowId: row.rowId,
      title,
      detail: String(row.detail || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      dueDate,
      when: dueDate === today ? 'today' : 'tomorrow',
      acked: acked.has(key),
    });
  }
  // F60(第十二轮)：dateKey 不再等长（年份 4-6 位），字符串比较会跨位数错序
  // （如 '10000-01-01' < '9999-12-31' 为真）⇒ 改用 social-time 的分钟戳做数值比较。
  out.sort((a, b) => (stampMinutes(a.dueDate + ' 00:00') - stampMinutes(b.dueDate + ' 00:00'))
    || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return out.slice(0, MAX_SCHEDULE_ITEMS);
}

/**
 * 下一条要弹的横幅：**最早约定日里第一条未确认**的（队列制——一次一条，点掉再出下一条）。
 * 无未确认 → null（没有横幅）。
 */
export function nextScheduleBanner(entries: readonly MemoScheduleEntry[]): MemoScheduleEntry | null {
  return entries.find(e => !e.acked) || null;
}

/** 确认「知道了」：写入已确认键；已确认过返回 false（调用方据此省一次写盘/派发）。 */
export function ackPhoneSchedule(data: PhoneChatData, key: string): boolean {
  const k = String(key || '').trim();
  if (!k) return false;
  const list = Array.isArray(data.scheduleAcks) ? data.scheduleAcks : [];
  if (list.includes(k)) return false;
  list.push(k);
  data.scheduleAcks = list;
  return true;
}
