// ===== 人物生日（主角信息表 / 恋爱对象表 / 重要角色表「生日」列，格式 YYYY-MM-DD） =====
// 恋爱对象表/重要角色表自 V3.2.0、主角信息表自 V3.3.0 标准模板起把「年龄」列替换为「生日」列；
// 旧库存量「年龄」列（值形如“20岁”）继续兼容：读不到生日时按旧值原样透传（★旧年龄兜底，
// 新库全面覆盖后未来删除，见 formatAgeCellText/parseAgeCellNumber 内标注）。本模块刻意零依赖
// calendar-core（todayKey 由调用方传入），避免 calendar-core ↔ birthday 循环引用；日期规范化
// 契约与 calendar-core 的 parseDateKeyFromText 一致（带符号、幅值至少 4 位补零的年份 + 两位月日；
// 年份识别放宽到 1-6 位，五位以上纪年不再被截断成后四位）。
import { getCellByHeader, getSheetByName } from './data-manager';

/** 生日在日历上的标注（仅打开日历弹窗时计算；与世界书今日行同源）。 */
export interface BirthdayDayMark {
  kind: 'birthday';
  charName: string;
  /** 规范 YYYY-MM-DD */
  birthday: string;
  /** 该周年日满的周岁；推算失败（如年份为公元前的怪异推算）为 null */
  ageAt: number | null;
}

/** 消费生日的角色表（主角优先，同名去重按此顺序取名）。 */
const BIRTHDAY_TABLES = ['主角信息表', '恋爱对象表', '重要角色表'] as const;

const BIRTHDAY_RE = /(-?\d{1,6})-(\d{1,2})-(\d{1,2})/;

/** 各月天数上限（2 月按 29 收——闰年语义交给周年函数处理）。 */
const MONTH_DAY_CAPS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= MONTH_DAY_CAPS[month - 1];
}

/** 从单元格文本解析生日为规范 YYYY-MM-DD（带符号、幅值至少 4 位）；解析失败返回 null。 */
export function parseBirthday(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  const match = text.match(BIRTHDAY_RE);
  if (!match) return null;
  // 年份超 6 位时宽松匹配会丢首位数字（1234567-01-01 → 234567-01-01，生日错一个量级）：
  // 宁可判「无生日」退回原文显示，也不给一个错生日去推算年龄
  if (match.index !== undefined && match.index > 0 && /\d/.test(text.charAt(match.index - 1))) return null;
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (!validMonthDay(month, day)) return null;
  const year = parseInt(match[1], 10);
  // U32：此处与 formatDateKey 同形但**不可 import**——calendar-core 反向依赖 birthday（buildTodayBirthdayLine），
  // 收编会造环（依赖环债务上限 20，已满）。保持本地同形实现，两处（本函数 + birthdayAnniversaryInYear）留档。
  const sign = year < 0 ? '-' : '';
  return `${sign}${String(Math.abs(year)).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 解析 dateKey 为 { 年, 月日 }；负年份（公元前）取完整带符号年份。 */
function parseYMD(dateKey: string): { year: number; md: string } | null {
  const match = String(dateKey).match(BIRTHDAY_RE);
  if (!match) return null;
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (!validMonthDay(month, day)) return null;
  return { year: parseInt(match[1], 10), md: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

/** 生日在指定年份的周年日 dateKey；02-29 生日在平年落到 02-28（提前庆祝口径）。 */
export function birthdayAnniversaryInYear(birthday: string, year: number): string | null {
  const b = parseYMD(birthday);
  if (!b) return null;
  let day = b.md.slice(3);
  if (b.md === '02-29' && !isLeapYear(year)) day = '28';
  const sign = year < 0 ? '-' : '';
  return `${sign}${String(Math.abs(year)).padStart(4, '0')}-${b.md.slice(0, 2)}-${day}`;
}

/** dateKey 的月日是否命中生日的周年日（含 02-29 平年落 02-28 规则）。 */
export function isBirthdayOn(birthday: string, dateKey: string): boolean {
  const b = parseYMD(birthday);
  const d = parseYMD(dateKey);
  if (!b || !d) return false;
  if (b.md === d.md) return true;
  return b.md === '02-29' && d.md === '02-28' && !isLeapYear(d.year);
}

/** 按 dateKey 计算周岁；dateKey 早于生日（未出生/数据异常）返回 null。 */
export function computeAgeAt(birthday: string, dateKey: string): number | null {
  const b = parseYMD(birthday);
  const d = parseYMD(dateKey);
  if (!b || !d) return null;
  let age = d.year - b.year;
  if (d.md < b.md) age -= 1;
  return age < 0 ? null : age;
}

/** 读角色表「生日/年龄」格并格式化为年龄显示文本：生日按 todayKey 推算“X岁”（无基准时退显日期）；
 *  旧格式值原样透传（纯数字补“岁”）。两列都缺/都空返回 ''。 */
export function readCharAgeText(table: string, row: number, todayKey: string | null): string {
  // 「年龄」回退 = 旧年龄兜底（旧库存量），新库全覆盖后未来删除
  return formatAgeCellText(String(getCellByHeader(table, row, '生日') ?? getCellByHeader(table, row, '年龄') ?? ''), todayKey);
}

/** 同 readCharAgeText 的数值版（周期 roster / 成就统计用）；无有效年龄返回 null。 */
export function readCharAgeNumber(table: string, row: number, todayKey: string | null): number | null {
  // 「年龄」回退 = 旧年龄兜底（旧库存量），新库全覆盖后未来删除
  return parseAgeCellNumber(String(getCellByHeader(table, row, '生日') ?? getCellByHeader(table, row, '年龄') ?? ''), todayKey);
}

export function formatAgeCellText(raw: string, todayKey: string | null): string {
  const value = (raw || '').trim();
  if (!value) return '';
  const birthday = parseBirthday(value);
  if (birthday) {
    if (!todayKey) return birthday;
    const age = computeAgeAt(birthday, todayKey);
    return age == null ? birthday : `${age}岁`;
  }
  // ── 旧年龄兜底（旧库存量“20岁”/纯数字透传补“岁”）：生日列全面覆盖后未来删除 ──
  return /^\d+(?:\.\d+)?$/.test(value) ? `${value}岁` : value;
}

export function parseAgeCellNumber(raw: string, todayKey: string | null): number | null {
  const value = (raw || '').trim();
  if (!value) return null;
  const birthday = parseBirthday(value);
  // 日期型值必须有 todayKey 才推算——无基准时绝不把年份当年龄数字捡走
  if (birthday) return todayKey ? computeAgeAt(birthday, todayKey) : null;
  // ── 旧年龄兜底（旧库存量“20岁”捡数字）：生日列全面覆盖后未来删除 ──
  const match = value.match(/(\d+(?:\.\d+)?)/);
  const n = match ? parseFloat(match[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 遍历三张角色表（主角信息表优先）的（姓名, 生日）对；同名去重（同中枢合并语义）。 */
export function collectCharacterBirthdays(): Array<{ name: string; birthday: string }> {
  const out: Array<{ name: string; birthday: string }> = [];
  const seen = new Set<string>();
  for (const table of BIRTHDAY_TABLES) {
    let sheet: any;
    try { sheet = getSheetByName(table); } catch (_e) { continue; }
    if (!sheet || !Array.isArray(sheet.content)) continue;
    for (let i = 1; i < sheet.content.length; i++) {
      const name = String(getCellByHeader(table, i, '姓名') || '').trim();
      if (!name || name === '无' || seen.has(name)) continue;
      const birthday = parseBirthday(getCellByHeader(table, i, '生日'));
      if (!birthday) continue;
      seen.add(name);
      out.push({ name, birthday });
    }
  }
  return out;
}

/** 日历生日标注（仅打开日历弹窗时调用，平时零开销）：dateKey → 该日生日的角色列表。
 *  生成 year±1 三年的周年日，跨年界的相邻月格子（如 12 月/1 月）直接命中。 */
export function getBirthdayCalendarAnnotations(year: number): Map<string, BirthdayDayMark[]> {
  const out = new Map<string, BirthdayDayMark[]>();
  for (const { name, birthday } of collectCharacterBirthdays()) {
    for (const y of [year - 1, year, year + 1]) {
      const anniversary = birthdayAnniversaryInYear(birthday, y);
      if (!anniversary) continue;
      const arr = out.get(anniversary) || [];
      arr.push({ kind: 'birthday', charName: name, birthday, ageAt: computeAgeAt(birthday, anniversary) });
      out.set(anniversary, arr);
    }
  }
  return out;
}

/** 世界书「今日日历」注入的生日行：如「今日生日：今天是艾莉丝（满20岁）、白瑾（满22岁）的生日」；无生日返回 ''。 */
export function buildTodayBirthdayLine(todayKey: string | null): string {
  if (!todayKey) return '';
  const parts: string[] = [];
  for (const { name, birthday } of collectCharacterBirthdays()) {
    if (!isBirthdayOn(birthday, todayKey)) continue;
    const age = computeAgeAt(birthday, todayKey);
    parts.push(age == null ? name : `${name}（满${age}岁）`);
  }
  if (!parts.length) return '';
  return `今日生日：今天是${parts.join('、')}的生日`;
}
