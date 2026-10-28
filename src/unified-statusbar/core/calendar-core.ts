import { getTavernHelper } from './env';
import { STANDARD_RECURSION } from './constants';
// ===== 日历核心数据模型 =====
import { getCellByHeader, getSheetByName } from './data-manager';
import { getConfig } from './config-store';
import { deleteStoryFeature, getCurrentStoryChatKey, hasStoryFeature, readStoryFeature, writeStoryFeature } from './story-floor-store';
import { dsCachePos, registerManagedWbEntry } from './wb-position';
import { hasWorldbookProjectionDispatcher, requestWorldbookProjection } from './worldbook-projection-events';
import { buildTodayBirthdayLine, collectCharacterBirthdays } from './birthday';
import { wbEntryName, wbEntryIndexByName } from './worldbook-entry';
import type { WeatherCategory } from './constants';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/** 天气条目 */
export interface WeatherEntry {
  dateKey: string;           // "2026-06-15"
  category: WeatherCategory;  // 大类
  description: string;        // 具体描述（含温度和感官描述）
}

/** 日历事件类型 */
export type CalendarEventType = 'world' | 'major' | 'character' | 'memo';

/** 单条日历事件 */
export interface CalendarEvent {
  id: string;                // "world_1", "major_2", "char_3", "memo_行号"
  date: string;              // "2026-06-15"
  type: CalendarEventType;
  title: string;
  description: string;
  startTime?: string;        // major 类型
  endTime?: string;          // major 类型
  location?: string;         // major/character/memo 类型
  participants?: string;     // major 类型
  character?: string;        // character/memo 类型
  // 备忘录专用字段
  status?: string;           // memo 类型：当前状态
  result?: string;           // memo 类型：后续结果
}

/** 世界书条目中存储的数据结构 */
export interface CalendarWBData {
  weather: string;    // 单行天气文本，如 "晴:描述"
  calendar: string;   // 原始 YAML 事件文本
  newspaper: string;  // 日报原始文本
}

interface CalendarStoryData {
  schema: 1;
  past: CalendarWBData;
  future: CalendarWBData;
}

/** 日历格子数据 */
export interface CalendarCell {
  key: string;              // "2026-06-15"
  day: number;              // 1-31
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  hasContent: boolean;
  events: CalendarEvent[];
}

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/** 世界书条目名称 */
export const WB_TODAY_NAME = 'UBS-日历-今日';
export const WB_FUTURE_NAME = 'UBS-日历-未发生';
export const WB_PAST_NAME = 'UBS-日历-已发生';
// O18-A：旧版条目名（`瑟瑟灵感状态栏-*`）兼容已退役——改由 core/legacy-worldbook-entries.ts
// 在投影全量刷新时统一回收；本模块只认当前名。

// DS 缓存优化：登记本模块管理的世界书条目（翻转开关时由 repositionManagedWbEntries 重定位）
registerManagedWbEntry({
  match: (e) => wbEntryName(e) === WB_TODAY_NAME,
  origPos: () => ({ type: 'at_depth', role: 'system', depth: 0, order: 199 }),
});
registerManagedWbEntry({
  match: (e) => wbEntryName(e) === WB_FUTURE_NAME,
  origPos: () => ({ type: 'before_character_definition', role: 'system', depth: 0, order: 100 }),
});

/** 空的世界书数据 */
const EMPTY_WB_DATA: CalendarWBData = { weather: '', calendar: '', newspaper: '' };
const CALENDAR_STORY_KEY = 'calendar';
const CALENDAR_LAST_DATE_KEY = 'calendar.lastDateKey';

/** 日期键正则：YYYY-MM-DD（年份接受带符号 1-6 位：兼容虚构世界观中的短年份如 021、01、
 *  负年份/公元前如 -500，以及超出四位纪年的远未来年份如 14900——不设上限时年份一旦更长
 *  就会被静默截断成后四位，年龄/事件全部错算；七位以上由 matchedInsideDigitRun 判无日期，
 *  6 位是本解析契约的硬上限） */
const DATE_KEY_RE = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})/;

// ═══════════════════════════════════════════════════════════════
// TavernHelper 访问
// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
// YAML 解析与序列化
// ═══════════════════════════════════════════════════════════════

/** 错误容忍的 YAML 文本解析器，将日历 YAML 文本解析为 CalendarEvent[] */
export function parseCalendarYaml(text: string): CalendarEvent[] {
  if (!text || !text.trim()) return [];

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return [];

  const events: CalendarEvent[] = [];

  const blocks = normalized.split(/\n(?=\s*-?\s*id\s*:)/);

  for (const rawBlock of blocks) {
    const block = rawBlock.replace(/^\s*-?\s*/, '');
    if (!block.trim()) continue;

    const idMatch = block.match(/^id\s*:\s*"([^"]*)"|^id\s*:\s*(\S+)/m);
    if (!idMatch) continue;
    const id = (idMatch[1] || idMatch[2] || '').trim();
    if (!id) continue;

    const dateMatch = block.match(/date\s*:\s*(-?\d{1,6}-\d{1,2}-\d{1,2})/);
    if (!dateMatch) continue;

    const titleMatch = block.match(/title\s*:\s*(.+)/m);
    if (!titleMatch) continue;

    const descMatch = block.match(/description\s*:\s*(.+)/m);
    const locMatch = block.match(/location\s*:\s*(.+)/m);
    const charMatch = block.match(/character\s*:\s*(.+)/m);
    const partMatch = block.match(/participants\s*:\s*(.+)/m);
    const stMatch = block.match(/startTime\s*:\s*"([^"]*)"/);
    const etMatch = block.match(/endTime\s*:\s*"([^"]*)"/);
    const timeMatch = block.match(/time\s*:\s*"([^"]*)"/);

    let type: CalendarEventType = 'character';
    if (id.startsWith('world')) type = 'world';
    else if (id.startsWith('major')) type = 'major';
    else if (id.startsWith('char')) type = 'character';
    else if (id.startsWith('memo')) type = 'memo';

    events.push({
      id,
      // 规范化为 4 位年份 + 2 位月日，避免 AI 按短年份写出的事件日期与 monthPrefix/今日键失配
      date: parseDateKeyFromText(dateMatch[1]) || dateMatch[1],
      type,
      title: titleMatch[1].trim(),
      description: (descMatch?.[1] || '').trim(),
      location: locMatch?.[1]?.trim() || undefined,
      character: charMatch?.[1]?.trim() || undefined,
      participants: partMatch?.[1]?.trim() || undefined,
      startTime: (stMatch?.[1] || timeMatch?.[1] || '').trim() || undefined,
      endTime: etMatch?.[1]?.trim() || undefined,
    });
  }

  return events;
}

/** 将 CalendarEvent[] 序列化回 YAML 文本 */
function rebuildEventsYaml(events: CalendarEvent[]): string {
  if (!events || events.length === 0) return '';

  return events.map(ev => {
    const parts: string[] = [`- id: "${ev.id}"`, `  date: ${ev.date}`];

    if (ev.type === 'major') {
      if (ev.startTime) parts.push(`  startTime: "${ev.startTime}"`);
      if (ev.endTime) parts.push(`  endTime: "${ev.endTime}"`);
    } else if (ev.type === 'character' || ev.type === 'memo') {
      if (ev.startTime) parts.push(`  time: "${ev.startTime}"`);
    }

    parts.push(`  title: ${ev.title}`, `  description: ${ev.description || ''}`);

    if (ev.location) parts.push(`  location: ${ev.location}`);
    if (ev.character) parts.push(`  character: ${ev.character}`);
    if (ev.participants) parts.push(`  participants: ${ev.participants}`);

    return parts.join('\n');
  }).join('\n\n');
}

/** 解析"类别:描述"格式的天气文本，返回 WeatherEntry */
export function parseWeatherText(text: string): WeatherEntry | null {
  if (!text || !text.trim()) return null;

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return null;

  const colonIdx = normalized.indexOf(':');
  if (colonIdx === -1) return null;

  const category = normalized.substring(0, colonIdx).trim();
  const description = normalized.substring(colonIdx + 1).trim();
  if (!category || !description) return null;

  const todayKey = getTodayDateKey();

  return {
    dateKey: todayKey || '',
    category: category as WeatherCategory,
    description,
  };
}

// ═══════════════════════════════════════════════════════════════
// 世界书存储操作
// ═══════════════════════════════════════════════════════════════

/** 获取用于日历提示词投影及旧数据迁移的世界书名称（仅角色卡绑定世界书；无则返回 null，不再新建聊天世界书）。 */
async function getStorageWorldbookName(): Promise<string | null> {
  const th = getTavernHelper();
  if (!th) return null;

  try {
    if (typeof th.getCharWorldbookNames === 'function') {
      const charWbs = th.getCharWorldbookNames('current');
      if (charWbs) {
        if (charWbs.primary) {
          const allNames: string[] = th.getWorldbookNames ? th.getWorldbookNames() : [];
          if (allNames.includes(charWbs.primary)) return charWbs.primary;
        }
      }
    }
    // 不再回退 getOrCreateChatWorldbook（会为每张新角色卡自动新建聊天世界书）
    return null;
  } catch (e) {
    console.warn('[日历] 获取存储世界书失败:', e);
    return null;
  }
}

function emptyCalendarStory(): CalendarStoryData {
  return { schema: 1, past: { ...EMPTY_WB_DATA }, future: { ...EMPTY_WB_DATA } };
}

function normalizeCalendarStory(raw: any): CalendarStoryData {
  const out = emptyCalendarStory();
  for (const side of ['past', 'future'] as const) {
    const v = raw?.[side];
    if (!v || typeof v !== 'object') continue;
    out[side] = {
      weather: typeof v.weather === 'string' ? v.weather : '',
      calendar: typeof v.calendar === 'string' ? v.calendar : '',
      newspaper: typeof v.newspaper === 'string' ? v.newspaper : '',
    };
  }
  return out;
}

function normalizeEventDate(event: CalendarEvent): string {
  return parseDateKeyFromText(event.date) || event.date;
}

function getWeekdayLabel(dateKey: string): string {
  try {
    const currentTime = readStoryClockRaw();
    const parsedCurrent = parseCurrentTimeToDateTime(currentTime);
    if (parsedCurrent?.dateKey === dateKey && parsedCurrent.weekday) return parsedCurrent.weekday;
  } catch (_e) { /* fall through to Gregorian calculation */ }

  const parsed = parseDateKey(dateKey);
  if (!parsed) return '';
  const weekday = makeDate(parsed.year, parsed.month - 1, parsed.day).getDay();
  return `周${'日一二三四五六'[weekday]}`;
}

function formatTodayEvent(event: CalendarEvent): string {
  const parts: string[] = [];
  if (event.startTime) parts.push(event.startTime + (event.endTime ? `-${event.endTime}` : ''));
  parts.push(event.title || '未命名事件');
  if (event.description) parts.push(event.description);
  if (event.location) parts.push(`地点：${event.location}`);
  if (event.participants) parts.push(`参与者：${event.participants}`);
  if (event.character) parts.push(`角色：${event.character}`);
  if (event.status) parts.push(`状态：${event.status}`);
  if (event.result) parts.push(`结果：${event.result}`);
  return parts.join('｜');
}

function dedupeCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  const byId = new Map<string, CalendarEvent>();
  for (const event of events) byId.set(event.id, event);
  return Array.from(byId.values());
}

function buildTodayProjectionContent(data: CalendarStoryData, todayKey: string | null): string {
  if (!todayKey) return '';
  const parsed = parseDateKey(todayKey);
  if (!parsed) return '';

  const weekday = getWeekdayLabel(todayKey);
  const todayEvents = dedupeCalendarEvents([
    ...parseCalendarYaml(data.past.calendar),
    ...parseCalendarYaml(data.future.calendar),
  ]).filter(event => event.type !== 'memo' && normalizeEventDate(event) === todayKey);
  const lines = [
    `今日日期:${formatYear(parsed.year)}年${String(parsed.month).padStart(2, '0')}月${String(parsed.day).padStart(2, '0')}日${weekday ? ` ${weekday}` : ''}`,
    `今日天气：${data.future.weather.trim() || '无'}`,
  ];
  // 人物生日（恋爱对象表/重要角色表「生日」列）：今天是某角色的生日时注入一行描述；
  // 设置「日历生日」关闭时跳过（日历标注同开关，年龄推算不受影响）
  if (getConfig().calendarBirthdayEnabled !== false) {
    const birthdayLine = buildTodayBirthdayLine(todayKey);
    if (birthdayLine) lines.push(birthdayLine);
  }
  const eventHeading = '今日事件：（不要默认主角知道相关事件，除非主角已得知相关消息。事件会在主角和世界互动时自然获得相关情报）';

  if (todayEvents.length > 0) {
    lines.push(eventHeading, ...todayEvents.map(event => `- ${formatTodayEvent(event)}`));
  } else {
    lines.push(eventHeading, '无');
  }

  return lines.join('\n');
}

function buildFutureProjectionContent(data: CalendarWBData, todayKey: string | null): string {
  if (!data.calendar) return '';
  const events = parseCalendarYaml(data.calendar).filter(event => event.type !== 'memo');
  // 缺少剧情日期时保留全部事件，避免因日期表暂时不可用而让提示词静默丢失。
  const futureEvents = todayKey
    ? events.filter(event => compareDateKey(normalizeEventDate(event), todayKey) > 0)
    : events;
  const calendar = rebuildEventsYaml(futureEvents);
  return calendar ? '后面一段时间的事件：\n<calendar>\n' + calendar + '\n</calendar>' : '';
}

function projectionEntryMatches(current: any, target: any): boolean {
  return current?.name === target.name
    && current?.comment === target.comment
    && current?.enabled === target.enabled
    && current?.content === target.content
    && JSON.stringify(current?.strategy) === JSON.stringify(target.strategy)
    && JSON.stringify(current?.position) === JSON.stringify(target.position)
    && JSON.stringify(current?.recursion) === JSON.stringify(target.recursion)
    && current?.addMemo === target.addMemo
    && JSON.stringify(current?.triggers) === JSON.stringify(target.triggers);
}

/** Reconciles calendar-managed entries inside an already-loaded primary worldbook. */
export function reconcileCalendarWorldbookEntries(entries: any[], input?: CalendarStoryData): boolean {
  const data = input || normalizeCalendarStory(readStoryFeature(CALENDAR_STORY_KEY, emptyCalendarStory()));
  const todayKey = getTodayDateKey();
  const calendarEnabled = getConfig().calendarEnabled !== false;
  // O6：正文各构建一次（此前 enabled 判定与 content 各调一遍=双倍构建）
  const todayContent = buildTodayProjectionContent(data, todayKey);
  const futureContent = buildFutureProjectionContent(data.future, todayKey);
  const targets = [
    { name: WB_TODAY_NAME, comment: WB_TODAY_NAME, enabled: calendarEnabled && !!todayContent, content: todayContent, strategy: { type: 'constant', keys: [] }, position: dsCachePos({ type: 'at_depth', depth: 0, role: 'system', order: 199 }), recursion: STANDARD_RECURSION, addMemo: true, triggers: [] },
    { name: WB_FUTURE_NAME, comment: WB_FUTURE_NAME, enabled: calendarEnabled && !!futureContent, content: futureContent, strategy: { type: 'constant', keys: [] }, position: dsCachePos({ type: 'before_character_definition', role: 'system', depth: 0, order: 100 }), recursion: STANDARD_RECURSION, addMemo: true, triggers: [] },
  ];
  let changed = false;
  for (const entry of targets) {
    const idx = wbEntryIndexByName(entries, entry.name);
    if (idx < 0 && !entry.content) continue;
    if (idx < 0) { entries.push(entry); changed = true; }
    else if (!projectionEntryMatches(entries[idx], entry)) { entries[idx] = { ...entries[idx], ...entry }; changed = true; }
  }
  const filtered = entries.filter((e: any) => wbEntryName(e) !== WB_PAST_NAME);
  if (filtered.length !== entries.length) { entries.splice(0, entries.length, ...filtered); changed = true; }
  return changed;
}

// O6 签名闸门：日历投影内容只依赖【calendar story 数据（journal 令牌覆盖）+ 今日键 +
// 日历/生日开关 + 生日表名单】——备忘录提取事件被投影明确排除（type !== 'memo'），不构成依赖。
// 此前每次表格推送 tick 都无条件派发 = 每次整本读世界书+全量 structuredClone；签名不变直接早退。
// O28 收窄：journal 全局令牌含 pendingSeq，任何无关 story 写（换装/演化/经期落盘）都会重开闸门
// （整本读+克隆白做）⇒ 改为聊天键 + 日历 story 内容原文（真实依赖）+ ambient。
let _lastCalendarProjSig: string | null = null;

function computeCalendarProjectionSignature(): string {
  const ambient = `${getTodayDateKey() ?? 'none'}|${getConfig().calendarEnabled !== false}|${getConfig().calendarBirthdayEnabled !== false}|${JSON.stringify(collectCharacterBirthdays())}`;
  const calendarContent = JSON.stringify(readStoryFeature(CALENDAR_STORY_KEY, null));
  return `${getCurrentStoryChatKey()}|${calendarContent}|${ambient}`;
}

export async function projectCalendarToWorldbook(input?: CalendarStoryData): Promise<boolean> {
  if (hasWorldbookProjectionDispatcher()) {
    const signature = computeCalendarProjectionSignature();
    if (signature === _lastCalendarProjSig) return true;
    _lastCalendarProjSig = signature;
    requestWorldbookProjection('calendar', 'data-change');
    return true;
  }
  const th = getTavernHelper();
  const wbName = await getStorageWorldbookName();
  if (!th) return false;
  if (!wbName) {
    return false;
  }
  const data = input || normalizeCalendarStory(readStoryFeature(CALENDAR_STORY_KEY, emptyCalendarStory()));
  try {
    const wb = await th.getWorldbook(wbName);
    if (!Array.isArray(wb)) return false;
    const todayKey = getTodayDateKey();
    const calendarEnabled = getConfig().calendarEnabled !== false;
    const todayContent = buildTodayProjectionContent(data, todayKey);
    const futureContent = buildFutureProjectionContent(data.future, todayKey);
    const todayEntry = {
      name: WB_TODAY_NAME, comment: WB_TODAY_NAME,
      enabled: calendarEnabled && !!todayContent,
      content: todayContent,
      strategy: { type: 'constant', keys: [] },
      position: dsCachePos({ type: 'at_depth', depth: 0, role: 'system', order: 199 }),
      recursion: STANDARD_RECURSION,
      addMemo: true, triggers: [],
    };
    const futureEntry = {
      name: WB_FUTURE_NAME, comment: WB_FUTURE_NAME,
      enabled: calendarEnabled && !!futureContent,
      content: futureContent,
      strategy: { type: 'constant', keys: [] },
      position: dsCachePos({ type: 'before_character_definition', role: 'system', depth: 0, order: 100 }),
      recursion: STANDARD_RECURSION,
      addMemo: true, triggers: [],
    };

    let changed = false;
    for (const entry of [todayEntry, futureEntry]) {
      const idx = wbEntryIndexByName(wb, entry.name);
      // 没有可投影内容时不新建空条目；已有条目则保留并关闭，便于后续无损恢复。
      if (idx < 0 && !entry.content) continue;
      if (idx < 0) {
        wb.push(entry);
        changed = true;
      } else if (!projectionEntryMatches(wb[idx], entry)) {
        wb[idx] = { ...wb[idx], ...entry };
        changed = true;
      }
    }

    const projected = wb.filter((e: any) => wbEntryName(e) !== WB_PAST_NAME);
    if (projected.length !== wb.length) changed = true;
    if (changed) await th.replaceWorldbook(wbName, projected);
    return true;
  } catch (e) {
    console.warn('[日历] 世界书投影失败:', e);
    return false;
  }
}

export async function loadCalendarData(): Promise<{ past: CalendarWBData; future: CalendarWBData }> {
  const data = normalizeCalendarStory(readStoryFeature(CALENDAR_STORY_KEY, emptyCalendarStory()));
  return { past: data.past, future: data.future };
}

async function saveCalendarStory(data: CalendarStoryData, refreshProjection: boolean): Promise<boolean> {
  const normalized = normalizeCalendarStory(data);
  const ok = await writeStoryFeature(CALENDAR_STORY_KEY, normalized);
  if (ok && refreshProjection) await projectCalendarToWorldbook(normalized);
  return ok;
}

async function saveFutureData(future: CalendarWBData): Promise<boolean> {
  const data = normalizeCalendarStory(readStoryFeature(CALENDAR_STORY_KEY, emptyCalendarStory()));
  data.future = { ...EMPTY_WB_DATA, ...future };
  return saveCalendarStory(data, true);
}

export async function saveWeather(text: string): Promise<boolean> {
  const { future } = await loadCalendarData();
  future.weather = text;
  return saveFutureData(future);
}

export async function appendFutureEvents(newText: string): Promise<boolean> {
  const { past, future } = await loadCalendarData();
  const pastEvents = parseCalendarYaml(past.calendar);
  const futureEvents = parseCalendarYaml(future.calendar);
  const futureIds = new Set(futureEvents.map(e => e.id));
  const allIds = new Set([...pastEvents, ...futureEvents].map(e => e.id));
  const kept: CalendarEvent[] = [];
  for (const event of parseCalendarYaml(newText)) {
    if (futureIds.has(event.id)) continue; // future 内已有：AI 重复输出，跳过
    if (allIds.has(event.id)) {
      // 与 past 同 id：AI 复用旧 id 的新事件 → 重新编号保留内容。
      // 否则日历 UI 合并 past+future 按 id 去重（past 优先）会把新事件吞掉，
      // 而世界书投影只读 future 仍显示新事件，造成「世界书有、日历没有」的不一致。
      const nextId = nextEventId([...pastEvents, ...futureEvents, ...kept], event.type);
      allIds.add(nextId);
      kept.push({ ...event, id: nextId });
    } else {
      allIds.add(event.id);
      kept.push(event);
    }
  }
  if (!kept.length) return true;
  const yaml = rebuildEventsYaml(kept);
  future.calendar = future.calendar ? (future.calendar.trim() + '\n\n' + yaml).trim() : yaml;
  return saveFutureData(future);
}

// ═══════════════════════════════════════════════════════════════
// 事件编辑（增删改）— 纯逻辑 + IO 包装
// memo 事件来自备忘录表，不在此流程内；此处只读写 YAML 中的 world/major/character。
// ═══════════════════════════════════════════════════════════════

/** 为指定类型生成下一个递增 id（如 world_3）；无同类时从 1 开始。纯函数。 */
export function nextEventId(events: CalendarEvent[], type: CalendarEventType): string {
  const prefix = type === 'world' ? 'world' : type === 'major' ? 'major' : 'char';
  let max = 0;
  const re = new RegExp('^' + prefix + '_(\\d+)$');
  for (const e of events) {
    const m = e.id.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}_${max + 1}`;
}

/** 对合并后的事件列表应用一条编辑/删除操作，返回新列表。纯函数。 */
export function applyEventOp(
  events: CalendarEvent[],
  op: { mode: 'upsert'; event: CalendarEvent } | { mode: 'delete'; id: string },
): CalendarEvent[] {
  if (op.mode === 'delete') return events.filter(e => e.id !== op.id);
  const idx = events.findIndex(e => e.id === op.event.id);
  if (idx >= 0) {
    const next = events.slice();
    next[idx] = op.event;
    return next;
  }
  return [...events, op.event];
}

/** 按 todayKey 将事件列表分为 past（< today）/ future（>= today）。纯函数。 */
export function splitEventsByToday(
  events: CalendarEvent[],
  todayKey: string,
): { past: CalendarEvent[]; future: CalendarEvent[] } {
  const past: CalendarEvent[] = [];
  const future: CalendarEvent[] = [];
  for (const e of events) {
    (compareDateKey(normalizeEventDate(e), todayKey) < 0 ? past : future).push(e);
  }
  return { past, future };
}

/**
 * 新增或编辑一条事件。改日期后 past/future 自动按今日重分类。
 * 无今日锚点（全局数据表无「当前时间」）时就地替换原侧、新事件入 future。
 */
export async function upsertCalendarEvent(event: CalendarEvent): Promise<boolean> {
  const { past, future } = await loadCalendarData();
  const pastEvents = parseCalendarYaml(past.calendar);
  const futureEvents = parseCalendarYaml(future.calendar);
  const todayKey = getTodayDateKey();

  let nextPast: CalendarEvent[];
  let nextFuture: CalendarEvent[];
  if (todayKey) {
    const merged = dedupeCalendarEvents([...pastEvents, ...futureEvents]);
    const applied = applyEventOp(merged, { mode: 'upsert', event });
    const split = splitEventsByToday(applied, todayKey);
    nextPast = split.past;
    nextFuture = split.future;
  } else {
    const idxP = pastEvents.findIndex(e => e.id === event.id);
    const idxF = futureEvents.findIndex(e => e.id === event.id);
    if (idxP >= 0) {
      nextPast = pastEvents.slice(); nextPast[idxP] = event; nextFuture = futureEvents;
    } else if (idxF >= 0) {
      nextFuture = futureEvents.slice(); nextFuture[idxF] = event; nextPast = pastEvents;
    } else {
      nextPast = pastEvents; nextFuture = [...futureEvents, event];
    }
  }

  const newData: CalendarStoryData = {
    schema: 1,
    past: { ...past, calendar: rebuildEventsYaml(nextPast) },
    future: { ...future, calendar: rebuildEventsYaml(nextFuture) },
  };
  return saveCalendarStory(newData, true);
}

/** 按 id 删除一条事件（两侧同时查找）。 */
export async function deleteCalendarEvent(id: string): Promise<boolean> {
  const { past, future } = await loadCalendarData();
  const pastEvents = parseCalendarYaml(past.calendar).filter(e => e.id !== id);
  const futureEvents = parseCalendarYaml(future.calendar).filter(e => e.id !== id);
  const newData: CalendarStoryData = {
    schema: 1,
    past: { ...past, calendar: rebuildEventsYaml(pastEvents) },
    future: { ...future, calendar: rebuildEventsYaml(futureEvents) },
  };
  return saveCalendarStory(newData, true);
}

/** 为新增事件生成下一个递增 id（读取 past+future 全量事件后计算）。 */
export async function generateNewEventId(type: CalendarEventType): Promise<string> {
  const { past, future } = await loadCalendarData();
  const merged = dedupeCalendarEvents([...parseCalendarYaml(past.calendar), ...parseCalendarYaml(future.calendar)]);
  return nextEventId(merged, type);
}

export async function migratePastEvents(): Promise<void> {
  const todayKey = getTodayDateKey();
  if (!todayKey) return;
  const { past, future } = await loadCalendarData();
  // 日期可能被用户手动向前或向后调整，因此必须合并两侧后重新分类，不能只做单向“未来→过去”。
  const allEvents = dedupeCalendarEvents([
    ...parseCalendarYaml(past.calendar),
    ...parseCalendarYaml(future.calendar),
  ]);
  const reclassifiedPast: CalendarEvent[] = [];
  const upcoming: CalendarEvent[] = [];
  for (const event of allEvents) {
    (compareDateKey(normalizeEventDate(event), todayKey) < 0 ? reclassifiedPast : upcoming).push(event);
  }

  const weather = parseWeatherText(future.weather);
  const nextWeather = weather && compareDateKey(weather.dateKey, todayKey) >= 0 ? future.weather : '';
  const oneYearAgo = computeDateKeyForOffset(todayKey, -365);
  const retainedPast = oneYearAgo
    ? reclassifiedPast.filter(event => compareDateKey(normalizeEventDate(event), oneYearAgo) >= 0)
    : reclassifiedPast;
  const nextPastCalendar = rebuildEventsYaml(retainedPast);
  const nextFutureCalendar = rebuildEventsYaml(upcoming);
  const changed = past.calendar.trim() !== nextPastCalendar
    || future.calendar.trim() !== nextFutureCalendar
    || nextWeather !== future.weather
    || !!future.newspaper;
  if (!changed) return;

  past.calendar = nextPastCalendar;
  future.calendar = nextFutureCalendar;
  future.weather = nextWeather;
  future.newspaper = '';
  // 日期变更处理器会在迁移及可选自动生成全部完成后统一、同步地重投影。
  await saveCalendarStory({ schema: 1, past, future }, false);
}

export async function deleteCalendarWBEntries(): Promise<{ deleted: number; error?: string }> {
  const hadStory = hasStoryFeature(CALENDAR_STORY_KEY);
  if (hadStory && !(await deleteStoryFeature(CALENDAR_STORY_KEY))) {
    return { deleted: 0, error: '聊天楼层保存失败，未删除日历数据' };
  }
  await deleteStoryFeature(CALENDAR_LAST_DATE_KEY);
  let deleted = hadStory ? 1 : 0;
  const th = getTavernHelper();
  const wbName = await getStorageWorldbookName();
  if (th && wbName) {
    try {
      const wb = await th.getWorldbook(wbName);
      if (Array.isArray(wb)) {
        const filtered = wb.filter((e: any) => {
          const name = wbEntryName(e);
          return name !== WB_TODAY_NAME && name !== WB_FUTURE_NAME && name !== WB_PAST_NAME;
        });
        deleted += wb.length - filtered.length;
        if (filtered.length !== wb.length) await th.replaceWorldbook(wbName, filtered);
      }
    } catch (_e) {
      return { deleted, error: '楼层数据已清空，但世界书投影清理失败' };
    }
  }
  return deleted ? { deleted } : { deleted: 0, error: '当前聊天没有日历数据' };
}




// ═══════════════════════════════════════════════════════════════
// 日期计算
// ═══════════════════════════════════════════════════════════════

/**
 * O16：按「原始时钟单元格文本」记忆解析结果。
 * 缓存键**就是输入本身**（时钟串）⇒ 时钟一变自动失效，不引入陈旧风险。
 * 评估器路径每 tick 会重复问上百次（日期驱动型成就 139 条：calendar-event 59 / daily-action 48 /
 * window-action 32），旧实现每次都重跑正则 + 日期换算。
 */
let _todayDateKeyMemo: { raw: string; value: string | null } | null = null;

/** 读全局数据表「当前时间」原始文本（U43 单源：原 16 处内联 getCellByHeader 样板，
 *  表名/行号/列名此后改一处即全局生效；读取异常一律返回空串，调用方免 try-catch）。 */
export function readStoryClockRaw(): string {
  try { return getCellByHeader('全局数据表', 1, '当前时间') || ''; } catch (_e) { return ''; }
}

/** 从全局数据表「当前时间」解析日期键（YYYY-MM-DD） */
export function getTodayDateKey(): string | null {
  try {
    const currentTime = readStoryClockRaw();
    if (!currentTime) return null;
    const memo = _todayDateKeyMemo;
    if (memo && memo.raw === currentTime) return memo.value;
    // 与日历 parseCurrentTimeToDateTime 同口径：自定义纪年卡（如「3年4月1日 22:00 周五」）
    // 不以 YYYY-MM-DD 开头，仅靠 parseDateKeyFromText 恒 null——周期引擎 handleCycleTick
    // 会在「无法推进」处整体早退，而日历用后者解析正常（同一单元格两套解析口径不一致）。
    const value = parseDateKeyFromText(currentTime) ?? parseCurrentTimeToDateTime(currentTime)?.dateKey ?? null;
    _todayDateKeyMemo = { raw: currentTime, value };
    return value;
  } catch (e) {
    return null;
  }
}

/** 宽松匹配落在数字串中间（年份超过 6 位）时返回 true：正则只吃到后 6 位、丢掉首位数字
 *  （七位年份 1234567 → 234567，日期整整错一个量级）。这种情况宁可判「无日期」，
 *  也不返回一个看起来合法的错日期——调用方据此显示原文/跳过注入，问题可见。 */
export function matchedInsideDigitRun(text: string, index: number | undefined): boolean {
  const i = index ?? 0;
  return i > 0 && /\d/.test(text.charAt(i - 1));
}

/** 从文本中提取 YYYY-MM-DD 日期键（年份带符号，负年份为公元前） */
export function parseDateKeyFromText(text: string): string | null {
  const match = text.match(DATE_KEY_RE);
  if (!match || matchedInsideDigitRun(text, match.index)) return null;
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 年份取符号 + 幅值补零至至少 4 位：4 位及以下年份的键与旧版逐字一致（历史存档不迁移），
  // 5-6 位年份原样保留幅值宽度（14900 → "14900-07-15"，绝不截断成 4900）。
  // ★注意：dateKey 不再保证等长——下游一律用 parseDateKey/compareDateKey/monthDayOfDateKey
  // 取值，禁止 slice(5)/slice(0,4) 偏移切片，也禁止用字符串比较日期先后。
  const year = parseInt(match[1], 10);
  const sign = year < 0 ? '-' : '';
  return `${sign}${String(Math.abs(year)).padStart(4, '0')}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

/** 从当前时间文本中解析日期键和周几 */
export function parseCurrentTimeToDateTime(text: string): { dateKey: string; weekday: string; fullText: string } | null {
  const fullMatch = text.match(/(-?\d{1,6})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})?\s*周([一二三四五六日])/);
  if (fullMatch && !matchedInsideDigitRun(text, fullMatch.index)) {
    const year = formatYear(parseInt(fullMatch[1], 10)); // 规范带符号「至少 4 位幅值」年份，与 dateKey 体系一致
    const month = fullMatch[2].padStart(2, '0');
    const day = fullMatch[3].padStart(2, '0');
    const time = fullMatch[4] || '';
    const weekday = '周' + fullMatch[5];
    return {
      dateKey: `${year}-${month}-${day}`,
      weekday,
      fullText: `${fullMatch[1]}年${parseInt(fullMatch[2], 10)}月${parseInt(fullMatch[3], 10)}日 ${time} ${weekday}`.trim(),
    };
  }

  // 格式2：YYYY-MM-DD HH:MM 周X
  const isoMatch = text.match(/(-?\d{1,6}-\d{1,2}-\d{1,2})\s*(\d{1,2}:\d{2})?\s*周([一二三四五六日])/);
  if (isoMatch && !matchedInsideDigitRun(text, isoMatch.index)) {
    const dateKey = parseDateKeyFromText(isoMatch[1]);
    if (dateKey) {
      const weekday = '周' + isoMatch[3];
      return { dateKey, weekday, fullText: text };
    }
  }

  // 回退：仅提取 YYYY-MM-DD
  const dateKey = parseDateKeyFromText(text);
  if (!dateKey) return null;

  return {
    dateKey,
    weekday: '',
    fullText: text,
  };
}

/** 将日期键解析为年/月/日（年份可为负，公元前） */
export function parseDateKey(dateKey: string): { year: number; month: number; day: number } | null {
  const match = dateKey.match(DATE_KEY_RE);
  if (!match) return null;
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
    day: parseInt(match[3], 10),
  };
}

/**
 * 数值比较两个 dateKey：先年、再月、再日。返回 -1/0/1。
 * 负年份不能靠字符串字典序比较（-0501 会被排到 -0500 之后），必须数值比较。
 * 任一侧解析失败返回 0（视为不可比，不重排）。
 */
export function compareDateKey(a: string, b: string): number {
  const pa = parseDateKey(a);
  const pb = parseDateKey(b);
  if (!pa || !pb) return 0;
  if (pa.year !== pb.year) return pa.year < pb.year ? -1 : 1;
  if (pa.month !== pb.month) return pa.month < pb.month ? -1 : 1;
  if (pa.day !== pb.day) return pa.day < pb.day ? -1 : 1;
  return 0;
}

/** 年份显示/键格式化：带符号 + 幅值至少 4 位（正 0500 / 负 -0500 / 五位纪年 14900；
 *  负年份为公元前）。padStart 只补零不截断，故 5-6 位年份原样输出。 */
export function formatYear(year: number): string {
  const sign = year < 0 ? '-' : '';
  return sign + String(Math.abs(year)).padStart(4, '0');
}

/** 将年/月/日格式化为日期键（年份带符号、幅值至少 4 位补零，确保与 DATE_KEY_RE 兼容） */
export function formatDateKey(year: number, month: number, day: number): string {
  return `${formatYear(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 构造指定公历日期的本地 Date。用 setFullYear 绕过 new Date(year,…) 对 0-99 年按 1900+ 偏移的陷阱，
 * 使虚构世界观中的短年份（如 21、1）能正确计算星期与日期偏移。
 * 参数与 Date 构造器一致：monthIndex 为 0-based，day 默认 1。溢出校验语义不变（如 Feb 30 仍被识别为 3 月）。
 */
export function makeDate(year: number, monthIndex: number, day: number = 1): Date {
  const d = new Date(2000, monthIndex, day);
  d.setFullYear(year);
  return d;
}

/** 计算指定日期 ±offset 天的新日期键 */
export function computeDateKeyForOffset(dateKey: string, offsetDays: number): string | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;

  const d = makeDate(parsed.year, parsed.month - 1, parsed.day);
  d.setDate(d.getDate() + offsetDays);

  return formatDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 将中文星期几转为数字索引（0=周一 ... 6=周日，-1=无效） */
const WEEKDAY_MAP: Record<string, number> = {
  '周一': 0, '周二': 1, '周三': 2, '周四': 3, '周五': 4, '周六': 5, '周日': 6,
  '星期一': 0, '星期二': 1, '星期三': 2, '星期四': 3, '星期五': 4, '星期六': 5, '星期日': 6,
  '周1': 0, '周2': 1, '周3': 2, '周4': 3, '周5': 4, '周6': 5, '周7': 6,
};

// ═══════════════════════════════════════════════════════════════
// 日期工具（成就引擎 calendar-event / daily-action 用）
// ═══════════════════════════════════════════════════════════════

/** dateKey 预计算缓存：同一 scan 只算一次 m/d/weekday */
interface DateKeyCacheEntry { m: number; d: number; weekday: number; }
const _dateKeyCache = new Map<string, DateKeyCacheEntry>();

/** 解析月日字符串 "MM-DD" → {m,d}，O(1)，不每次 parse */
export function parseMonthDay(md: string): { m: number; d: number } {
  const parts = md.split('-');
  if (parts.length !== 2) return { m: 0, d: 0 };
  const m = parseInt(parts[0], 10);
  const d = parseInt(parts[1], 10);
  return { m, d };
}

/** 月日数值比较辅助：按 (m,d) 排序，相同返回 0 */
function cmpMonthDay(a: { m: number; d: number }, b: { m: number; d: number }): number {
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

/** 当前 dateKey 是否命中月日区间（含端点，跨年自动） */
export function dateInRange(todayMd: string, range: [string, string]): boolean {
  const t = parseMonthDay(todayMd);
  const a = parseMonthDay(range[0]);
  const b = parseMonthDay(range[1]);
  if (a.m < b.m || (a.m === b.m && a.d <= b.d)) {
    // 同年区间：a <= t <= b
    return cmpMonthDay(t, a) >= 0 && cmpMonthDay(t, b) <= 0;
  }
  // 跨年区间：t >= a 或 t <= b
  return cmpMonthDay(t, a) >= 0 || cmpMonthDay(t, b) <= 0;
}


/** 公历季节（固定分界）：春3-5/夏6-8/秋9-11/冬12-2 */
export function seasonOfMonthDay(todayMd: string): 'spring' | 'summer' | 'autumn' | 'winter' {
  const m = parseMonthDay(todayMd).m;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

/**
 * 当前游戏内季节窗口标识（"YYYY-season"，如 "2026-spring"）。取不到游戏内日期返回 null。
 * 单一来源：成就引擎的 window-action 求值与本插件成就簿的进度显示（peek）共用同一处，
 * 避免「引擎算一套、面板算一套」的季节口径漂移（第九轮 F33 自 achievement-engine 下沉至此，逻辑逐字未改）。
 */
export function currentSeasonWindowId(): string | null {
  const todayKey = getTodayDateKey();
  if (!todayKey) return null;
  const parsed = parseDateKey(todayKey);
  const md = monthDayOfDateKey(todayKey);
  if (!parsed || !md) return null;
  return `${parsed.year}-${seasonOfMonthDay(md)}`;
}

/** F3：从 dateKey 取 "MM-DD"（负年份安全）。slice(5) 假设恒 4 位正年份——公元前
 *  "-0044-03-15".slice(5) 得 "-03-15"，纪念日/季节/区间成就因此永不命中。
 *  成就引擎 calendar-event / 季节窗口一律走这里，不再对 dateKey 做偏移切片。 */
export function monthDayOfDateKey(dateKey: string): string | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  return `${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
}

/** 从 dateKey "YYYY-MM-DD" 算周几（1-7，周一=1…周日=7），进程内缓存一次 */
export function weekdayOfDateKey(dateKey: string): number {
  const cached = _dateKeyCache.get(dateKey);
  if (cached) return cached.weekday;
  const parsed = parseDateKey(dateKey);
  if (!parsed) return 0;
  // 使用 Date 对象计算一次（Gregorian 星期），获取后缓存
  const d = makeDate(parsed.year, parsed.month - 1, parsed.day);
  const gregorian = d.getDay(); // 0=Sun … 6=Sat
  const weekday = gregorian === 0 ? 7 : gregorian; // 转为 1=Mon … 7=Sun
  // F4：无上限增长封顶（长会话按游戏内日期累加；满则整清，重算成本一次 Date 构造）
  if (_dateKeyCache.size >= 4000) _dateKeyCache.clear();
  _dateKeyCache.set(dateKey, { m: parsed.month, d: parsed.day, weekday });
  return weekday;
}

function getWeekdayIndex(weekdayText: string): number {
  for (const [key, val] of Object.entries(WEEKDAY_MAP)) {
    if (weekdayText.includes(key)) return val;
  }
  return -1;
}

/** 计算用户定义周几与真实公历周几之间的偏移量 */
function getWeekdayShift(): number {
  try {
    const currentTime = readStoryClockRaw();
    const parsed = parseCurrentTimeToDateTime(currentTime);
    if (!parsed || !parsed.weekday) return 0;

    const userWeekday = getWeekdayIndex(parsed.weekday);
    if (userWeekday < 0) return 0;

    const d = parseDateKey(parsed.dateKey);
    if (!d) return 0;

    const gregorian = makeDate(d.year, d.month - 1, d.day).getDay(); // 0=Sun
    const gregorianMonday = (gregorian + 6) % 7; // 转为 0=周一
    return userWeekday - gregorianMonday;
  } catch (e) {
    return 0;
  }
}

/** 判断公历闰年（0-99 年也按真实公历规则，不依赖 Date 对象的 1900 偏移）。
 *  U45 单源：chronicle-reader / time-anchor 原各持一份逐字同构副本（birthday 刻意零依赖内联，见其头注）。 */
export function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 获取某月有多少天（month 为 1-12；纯算术实现，规避 new Date(year,month,0) 的 0-99 年偏移） */
export function getDaysInMonth(year: number, month: number): number {
  const days = [31, isGregorianLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1];
}

// ═══════════════════════════════════════════════════════════════
// 日历数据检索
// ═══════════════════════════════════════════════════════════════

/** 获取今日天气 */
export async function getTodayWeather(): Promise<WeatherEntry | null> {
  const todayKey = getTodayDateKey();
  if (!todayKey) return null;

  const { future } = await loadCalendarData();
  const weatherEntry = parseWeatherText(future.weather);
  if (weatherEntry && weatherEntry.dateKey === todayKey) return weatherEntry;
  return null;
}

// ═══════════════════════════════════════════════════════════════
// 今日天气缓存（供 buildHTML 同步读取——世界书是异步源）
// 缓存由 refreshTodayWeather() 填充；handleCalendarDateChange 在
// 首次加载/日期变更/角色切换时刷新。calendar-core 内部清缓存，
// index.ts 通过 composeRenderSignature 纳入缓存签名触发重渲染。
// ═══════════════════════════════════════════════════════════════
let _cachedTodayWeather: WeatherEntry | null = null;

/** 同步读取缓存的今日天气（buildHTML 用，O(1) 读变量） */
export function getCachedTodayWeather(): WeatherEntry | null {
  return _cachedTodayWeather;
}

/** 异步刷新今日天气缓存，返回最新天气（仅读世界书一次） */
export async function refreshTodayWeather(): Promise<WeatherEntry | null> {
  _cachedTodayWeather = await getTodayWeather();
  return _cachedTodayWeather;
}

/** 清空今日天气缓存（角色卡切换/重置时调用，防残留旧角色天气） */
export function clearCachedTodayWeather(): void {
  _cachedTodayWeather = null;
}

/** 构建某月的事件映射（合并已发生+未发生+备忘录，备忘录直接从表格读取） */
export async function buildEventMap(_year: number, _month: number): Promise<Map<string, CalendarEvent[]>> {
  const map = new Map<string, CalendarEvent[]>();

  const { past, future } = await loadCalendarData();

  const memoEvents = extractMemoEvents();

  const futureEvents = parseCalendarYaml(future.calendar);
  const pastEvents = parseCalendarYaml(past.calendar);
  const worldEvents = [...pastEvents, ...futureEvents].filter(e => e.type !== 'memo');
  const allEvents = [...worldEvents, ...memoEvents];

  // 按 id 去重（防止世界书和备忘录中出现重复事件）
  const seenIds = new Set<string>();
  for (const ev of allEvents) {
    if (seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);
    if (!map.has(ev.date)) map.set(ev.date, []);
    map.get(ev.date)!.push(ev);
  }

  const weatherEntry = parseWeatherText(future.weather);
  if (weatherEntry && weatherEntry.dateKey) {
    if (!map.has(weatherEntry.dateKey)) map.set(weatherEntry.dateKey, []);
  }

  return map;
}

/** 构建天气描述映射（dateKey → 天气描述文本） */
export async function buildWeatherMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { future } = await loadCalendarData();
  const weatherEntry = parseWeatherText(future.weather);
  if (weatherEntry && weatherEntry.dateKey) {
    map.set(weatherEntry.dateKey, weatherEntry.category + ': ' + weatherEntry.description);
  }
  return map;
}

/** 提取备忘录中的约定事件（按标题+日期去重） */
function extractMemoEvents(): CalendarEvent[] {
  try {
    const sheet = getSheetByName('备忘录');
    if (!sheet || !sheet.content || sheet.content.length <= 1) return [];

    const events: CalendarEvent[] = [];
    const seen = new Set<string>();
    for (let i = 1; i < sheet.content.length; i++) {
      const rowIndex = i;
      const appointedTime = getCellByHeader('备忘录', rowIndex, '约定时间') || '';
      if (!appointedTime) continue;

      const dateKey = parseDateKeyFromText(appointedTime);
      if (!dateKey) continue;

      const title = getCellByHeader('备忘录', rowIndex, '备忘标题') || '';
      const dedupKey = dateKey + '|' + title;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      events.push({
        id: `memo_${rowIndex}`,
        date: dateKey,
        type: 'memo',
        title: title,
        description: getCellByHeader('备忘录', rowIndex, '详细内容') || '',
        character: getCellByHeader('备忘录', rowIndex, '相关角色') || '',
        status: getCellByHeader('备忘录', rowIndex, '当前状态') || '',
        result: getCellByHeader('备忘录', rowIndex, '后续结果') || '',
      });
    }

    return events;
  } catch (e) {
    console.warn('[日历] 提取备忘录事件失败:', e);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// 日历网格构建
// ═══════════════════════════════════════════════════════════════

/** 构建月历网格（以用户定义周几为准） */
export function buildMonthGrid(
  year: number,
  month: number,
  eventMap: Map<string, CalendarEvent[]>,
  selectedKey: string | null,
  todayKey: string | null,
): CalendarCell[] {
  const cells: CalendarCell[] = [];
  const daysInMonth = getDaysInMonth(year, month);

  const weekdayShift = getWeekdayShift();
  const gregorianFirst = makeDate(year, month - 1, 1).getDay(); // 0=Sun
  const gregorianMonday = (gregorianFirst + 6) % 7; // 转为 0=周一
  const adjustedFirst = ((gregorianMonday + weekdayShift) % 7 + 7) % 7; // 0=周一
  const startOffset = adjustedFirst;

  // 上月填充
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevDays = getDaysInMonth(prevYear, prevMonth);
  for (let i = startOffset - 1; i >= 0; i--) {
    const day = prevDays - i;
    const key = formatDateKey(prevYear, prevMonth, day);
    cells.push({
      key,
      day,
      isCurrentMonth: false,
      isToday: key === todayKey,
      isSelected: key === selectedKey,
      hasContent: eventMap.has(key),
      events: eventMap.get(key) || [],
    });
  }

  // 当前月
  for (let d = 1; d <= daysInMonth; d++) {
    const key = formatDateKey(year, month, d);
    cells.push({
      key,
      day: d,
      isCurrentMonth: true,
      isToday: key === todayKey,
      isSelected: key === selectedKey,
      hasContent: eventMap.has(key),
      events: eventMap.get(key) || [],
    });
  }

  // 下月填充
  const totalCells = cells.length;
  const remaining = (7 - (totalCells % 7)) % 7;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  for (let d = 1; d <= remaining; d++) {
    const key = formatDateKey(nextYear, nextMonth, d);
    cells.push({
      key,
      day: d,
      isCurrentMonth: false,
      isToday: key === todayKey,
      isSelected: key === selectedKey,
      hasContent: eventMap.has(key),
      events: eventMap.get(key) || [],
    });
  }

  return cells;
}

// ═══════════════════════════════════════════════════════════════
// 自动更新
// ═══════════════════════════════════════════════════════════════

/** 上次检测的日期键（用于日期变化检测） */
let _lastDateKey: string | null = null;

/** 上次主角身份指纹（用于检测角色卡切换 → 冷启动） */
let _lastCharacterFingerprint: string | null = null;

// ─── 跨会话日期追踪（持久化 _lastDateKey，修复过夜冷启动不清理） ───

// _lastDateKey 是内存态，页面重载即丢失 → 冷启动分支只记录今天、不清理。
// 持久化上次处理日期后，重开页面即可对比出「自上次处理后日期已推进」，
// 从而在未开自动更新时也执行过期清理（迁移过期事件 + 清除旧日报）。

/** 读取当前聊天上次处理日期。 */
function getPersistedLastDateKey(): string | null {
  const value = readStoryFeature<string | null>(CALENDAR_LAST_DATE_KEY, null);
  return typeof value === 'string' && value ? value : null;
}

/** 持久化当前聊天上次处理日期；与角色卡其他聊天完全隔离。 */
function persistLastDateKey(dateKey: string): void {
  if (getPersistedLastDateKey() === dateKey) return;
  void writeStoryFeature(CALENDAR_LAST_DATE_KEY, dateKey);
}

/**
 * 获取当前主角身份指纹
 * 通过主角信息表的姓名+生日/年龄+性别+身份背景（前100字符）构建签名
 * 不同角色卡的主角信息几乎不可能完全相同，切换时签名变化即可检测
 * 身份背景字段通常为长文本（数百到数千字），截取前100字符足以区分不同卡片
 */
function getCharacterFingerprint(): string {
  try {
    const name = getCellByHeader('主角信息表', 1, '姓名') || '';
    // 原始「生日/年龄」格值（不取推算周岁——周岁随日期变化，会误触发角色卡切换冷启动）
    const age = getCellByHeader('主角信息表', 1, '生日') || getCellByHeader('主角信息表', 1, '年龄') || '';
    const gender = getCellByHeader('主角信息表', 1, '性别') || '';
    // 身份背景通常是长文本，不同卡片几乎不可能相同，用于区分同名主角的不同卡片
    const identity = (getCellByHeader('主角信息表', 1, '身份背景') || '').slice(0, 100);
    return `${name}|${age}|${gender}|${identity}`;
  } catch {
    return '';
  }
}

/**
 * 检测是否因角色卡切换触发冷启动
 * 比较当前主角身份指纹与上次记录的指纹：
 *   - 首次调用（_lastCharacterFingerprint 为 null）：仅记录指纹，不算切换
 *   - 后续调用：指纹变化 → 角色卡已切换 → 重置 _lastDateKey 进入冷启动
 */
function detectCharacterSwitch(): void {
  const charFingerprint = getCharacterFingerprint();

  if (_lastCharacterFingerprint !== null && charFingerprint !== _lastCharacterFingerprint) {
    _lastDateKey = null; // 角色卡已切换，重置日期追踪
    clearCachedTodayWeather(); // 旧角色天气缓存失效，下次 handleCalendarDateChange 会重读
  }

  _lastCharacterFingerprint = charFingerprint;
}

/**
 * 日期变化时的处理：迁移过期事件 + 清理旧日报 + 自动生成（仅向前且开自动更新时）。
 * 过期清理（migratePastEvents）与自动更新开关无关——会话内日期变更、以及跨会话
 * （过夜重开页面）检测到日期推进时均会执行；仅「向前生成新内容」受 calendarAutoDaily gate。
 * 返回 true 表示产生了需要重渲染的变化（首次加载/日期变更/角色切换后首次），
 * 调用方据此触发 render(true) 显示天气图标；返回 false 表示无变化（日期未变）。
 */
export async function handleCalendarDateChange(onAutoGenerate: () => Promise<void>): Promise<boolean> {
  const config = getConfig();
  if (!config.calendarEnabled) return false;

  // 检测角色卡切换（必须在读取 todayKey 之前，确保指纹已更新）
  detectCharacterSwitch();

  const todayKey = getTodayDateKey();
  if (!todayKey) return false;

  // 首次加载或角色切换后首次：记录日期 + 加载当前角色已有天气，不触发自动生成
  if (_lastDateKey === null) {
    _lastDateKey = todayKey;
    // 跨会话日期变更检测：_lastDateKey 是内存态、页面重载即丢失。
    // 若持久化的上次处理日期与今天不同（过夜/重开页面），说明自上次处理后日期已推进，
    // 即使未开自动更新，也须执行过期清理（迁移过期事件 + 清除旧日报）。
    // 无持久化记录（首次）时不清理，避免误清当天数据。
    const persistedKey = getPersistedLastDateKey();
    persistLastDateKey(todayKey);
    if (persistedKey && persistedKey !== todayKey) {
      await migratePastEvents();
    }
    // 首次/跨会话日期变化都同步投影；即使迁移数据本身无变化，也必须刷新日期与今日事件筛选。
    await projectCalendarToWorldbook();
    await refreshTodayWeather();
    return true;
  }

  if (todayKey === _lastDateKey) return false;


  const isForward = compareDateKey(todayKey, _lastDateKey) > 0;
  _lastDateKey = todayKey;
  persistLastDateKey(todayKey);

  // 日期变更（前向或后向）均触发事件迁移 + 清理旧日报
  await migratePastEvents();

  // 仅前向推进时触发自动生成
  if (isForward && config.calendarAutoDaily) {
    await onAutoGenerate();
  }

  // 日期本身就是投影输入。即使没有事件迁移或日报清理，也必须更新今日条目。
  await projectCalendarToWorldbook();

  // 日期变更后刷新天气缓存（migration 可能清了旧天气，生成可能写了新天气）
  await refreshTodayWeather();
  return true;
}

/** 判断日期是否在 ±rangeMonths 范围内（用于日历导航限制） */
export function isMonthInRange(year: number, month: number, maxRange: number): boolean {
  const todayKey = getTodayDateKey();
  if (!todayKey) return true;

  const parsed = parseDateKey(todayKey);
  if (!parsed) return true;

  const targetMonths = year * 12 + (month - 1);
  const todayMonths = parsed.year * 12 + (parsed.month - 1);
  const diff = targetMonths - todayMonths;

  return Math.abs(diff) <= maxRange;
}
