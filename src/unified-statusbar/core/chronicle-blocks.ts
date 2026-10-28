// core/chronicle-blocks.ts
// 纪要资料块共享层（轻依赖，只拉 data-manager）：读纪要表 → 按名选取 → 分块格式化。
// 用户定案（V3.710/V3.711）：所有涉及纪要的 1A 类请求，纪要统一放资料块（完整纪要 → 最近上下文），
// 触发注入不再注入 AM 序号；数据库纪要世界书条目改由各请求 suspend（纪要不再走世界书通道）。
// 取多少条/要不要概览与各功能原逻辑完全一致：概览/完整 70/30 拆分是世界演化专属；
// 大调查/大采访/小手机按「纪要内容含名」取最新 N 条全部完整（对齐原 findSummaryIdentifiers 口径）。
// 展示顺序（用户定案 2026-09-05）：所有用方统一从旧到新（时间正序，最新在末）——选取仍取最新 N 条，
// 仅翻转展示；不做新旧双逻辑。
import { getSheetByName, queryLogicalTablePage } from './data-manager';
import { parseDateKeyFromText, compareDateKey } from './calendar-core';

/** F69：纪要 time_span 数值比较（降序＝最新在前）。time_span 形如 'YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM'，
 * 起始日期允许 4~6 位年份与公元前——字典序下 10000-01-01 会排在 9999-12-31 之前（跨位数即错序）。
 * 先按起始日期数值比（compareDateKey 同源），同日再比当日内时刻；解析失败回退字典序（保持旧行为确定性）。 */
export function compareChronicleTimeSpanNewestFirst(a: string, b: string): number {
  const ka = parseDateKeyFromText(String(a || ''));
  const kb = parseDateKeyFromText(String(b || ''));
  if (ka && kb) {
    const byDate = compareDateKey(ka, kb);
    if (byDate !== 0) return -byDate;
    const ta = timeOfDayMinutes(a);
    const tb = timeOfDayMinutes(b);
    if (ta !== tb) return ta > tb ? -1 : 1;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

/** 取文本中首个 HH:MM 的当日分钟数（无时刻返回 -1，排在有时刻的之后不影响正确性）。 */
function timeOfDayMinutes(text: string): number {
  const m = String(text || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return -1;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return -1;
  return h * 60 + mm;
}

/** 台账纪要投影条目前缀（台账自己的英文简称词根；仅用于识别台账自投影并按请求剔除）。 */
export const CHRONICLE_WB_PREFIX = 'SeseLedger-纪要';

/** 旧前缀（台账换词根前的写法，与真数据库插件同名族）：过渡期双匹配，防旧条目叠进提示词造成纪要双重注入。 */
export const LEGACY_CHRONICLE_WB_PREFIXES = ['TavernDB-ACU-CustomExport-纪要'];

/** 纪要族条目名判定：新前缀 + 旧前缀（双匹配）。 */
export function isChronicleEntryName(name: unknown): boolean {
  const nm = String(name ?? '');
  if (!nm) return false;
  return nm.startsWith(CHRONICLE_WB_PREFIX) || LEGACY_CHRONICLE_WB_PREFIXES.some((p) => nm.startsWith(p));
}

/** 纪要行（camelCase 视图）。 */
export interface ChronicleRow {
  timeSpan: string;
  summary: string;
  chronicleText?: string;
  keyDialogue?: string;
}

/** 纪要分段：前 overview 条只概览，后 full 条完整。timeSpan 与 summary 用空格分隔（契约测试断言 D1 S1）。 */
export function formatChronicleBlocks(
  rows: ChronicleRow[],
  opts: { overview: number; full: number },
): string {
  const lines: string[] = [];
  rows.forEach((row, i) => {
    if (i < opts.overview) {
      lines.push(`- ${row.timeSpan} ${row.summary}`);
    } else if (i < opts.overview + opts.full) {
      lines.push(`- ${row.timeSpan} ${row.summary}\n  ${row.chronicleText || ''}${row.keyDialogue ? `\n  关键对话：${row.keyDialogue}` : ''}`);
    }
  });
  return lines.length ? lines.join('\n') : '（暂无纪要）';
}

/** v2 纪选取（替代 filterChronicleRows）：
 *  总量可配 total（默认 50）+ 每焦点角色「summary 含名」保底 perRole 条（默认 5）+ 跨角色去重 +
 *  超量全保留 + 不足时以焦点名并集补足。rows 须已按 time_span 倒序（最新在前）传入，选取取最新；
 *  返回时间正序（从旧到新，最新在末）——展示顺序全用方统一（用户定案，勿改回倒序）。
 *  只匹配 summary 摘要列（正文/关键对话含名不算，见用户确认的口径）。兜底：并集补足后仍不足则有多少给多少。 */
export function selectChronicleRows(rows: ChronicleRow[], focusNames: string[], total = 50, perRole = 5): ChronicleRow[] {
  if (!rows.length) return [];
  const names = focusNames.filter(Boolean);
  if (!names.length) return [];
  const perRoleCount = Math.max(1, Math.floor(perRole || 5));
  const target = Math.max(1, Math.floor(total || 50));
  const seen = new Set<ChronicleRow>();
  const picked: ChronicleRow[] = [];
  // 第一阶段：每个焦点角色各取 summary 含名的最新 perRole 条（跨角色去重）。
  for (const name of names) {
    let count = 0;
    for (const row of rows) {
      if (count >= perRoleCount) break;
      if (seen.has(row)) continue;
      if (!(row.summary || '').includes(name)) continue;
      picked.push(row);
      seen.add(row);
      count += 1;
    }
  }
  // 超量全保留：第一阶段去重后已达或超过 total，直接返回（不裁剪）。
  if (picked.length < target && seen.size < rows.length) {
    // 不足：以所有焦点名取并集（summary 含任一），从后续未选纪要按倒序补足到 total。
    for (const row of rows) {
      if (picked.length >= target) break;
      if (seen.has(row)) continue;
      if (!names.some(n => (row.summary || '').includes(n))) continue;
      picked.push(row);
      seen.add(row);
    }
  }
  // 按 rows 原时间正序（从旧到新）输出：选取仍自最新起取，仅展示翻转（用户定案）。
  const order = new Map<ChronicleRow, number>();
  rows.forEach((r, i) => order.set(r, i));
  return picked.slice().sort((a, b) => order.get(b)! - order.get(a)!);
}

/** rowsFromChronicleSheet：兼容对象行与 string[][] 数组行，仅作 queryLogicalTablePage 失败时的兜底。 */
export function rowsFromChronicleSheet(sheet: any): ChronicleRow[] {
  if (!sheet || !Array.isArray(sheet.content) || sheet.content.length < 2) return [];
  const header = sheet.content[0];
  // 表头即中文列名（台账口径；真数据库的 sheet.content 也是中文表头）——两形态共用中文键
  const pick = (row: any, key: string): string => {
    if (!Array.isArray(row)) return String(row?.[key] ?? '');
    const idx = header.indexOf(key);
    return idx >= 0 ? String(row[idx] ?? '') : '';
  };
  const out: ChronicleRow[] = [];
  for (let i = 1; i < sheet.content.length; i++) {
    const row = sheet.content[i];
    const timeSpan = pick(row, '时间跨度');
    const summary = pick(row, '概览');
    const chronicleText = pick(row, '纪要');
    const keyDialogue = pick(row, '重要对话');
    if (!timeSpan && !summary) continue;
    out.push({ timeSpan, summary, chronicleText, keyDialogue });
  }
  return out.sort((a, b) => compareChronicleTimeSpanNewestFirst(a.timeSpan, b.timeSpan)); // F69：数值比较
}

/** 读纪要表全部行（最新在前）：queryLogicalTablePage 按时间跨度倒序（上限 1000），失败兜底读纪要表 sheet。
 *  列名一律中文（台账口径）；真数据库后端返回的物理列名由 data-manager 按请求顺序归一。 */
function readAllChronicleRowsNewestFirst(): ChronicleRow[] {
  const page = queryLogicalTablePage({
    tableName: '纪要表',
    columns: ['时间跨度', '概览', '纪要', '重要对话'],
    orderBy: { column: '时间跨度', direction: 'DESC' },
    limit: 1000,
    offset: 0,
  });
  if (page) {
    const rows = page.map(row => ({
      timeSpan: String(row['时间跨度'] ?? ''),
      summary: String(row['概览'] ?? ''),
      chronicleText: String(row['纪要'] ?? ''),
      keyDialogue: String(row['重要对话'] ?? ''),
    }));
    // F69：SQL 的 ORDER BY 时间跨度 DESC 是文本排序，跨位数纪年（9999→10000）下字典序与数值序相反——
    // 读出后按同口径内存复排一次（不改数据库行为，只保证进 AI 的顺序正确）。
    rows.sort((a, b) => compareChronicleTimeSpanNewestFirst(a.timeSpan, b.timeSpan));
    return rows;
  }
  return rowsFromChronicleSheet(getSheetByName('纪要表'));
}

/** 读纪要表并按名选取（summary 含名口径；选取取最新，输出从旧到新）——世界演化 v2 规则（每焦点保底+并集补足），演化专用。 */
export function readChronicleRowsForNames(focusNames: string[], total: number): ChronicleRow[] {
  return selectChronicleRows(readAllChronicleRowsNewestFirst(), focusNames, total);
}

/**
 * 纪要资料块文本（大调查/大采访/小手机共用）：按「纪要内容含名」取最新 total 条，全部完整格式。
 * 匹配口径对齐原 findSummaryIdentifiers（世界书条目 content 含名）＝summary/正文/关键对话任一含名；
 * 取多少条=各功能既有设置（total），**无概览拆分**——概览/完整 70/30 是世界演化的专属逻辑，各功能
 * 要不要概览、取多少条一律与各自原逻辑一致（用户定案 V3.711）。展示从旧到新（时间正序）。
 * 无命中/total≤0 返回 ''。
 */
export function readChronicleDossierBlocks(names: string[], total: number): string {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  if (t <= 0 || !names || names.length === 0) return '';
  const all = readAllChronicleRowsNewestFirst();
  const rows: ChronicleRow[] = [];
  for (const row of all) {
    if (rows.length >= t) break;
    const hay = `${row.summary}\n${row.chronicleText || ''}\n${row.keyDialogue || ''}`;
    if (names.some(n => n && hay.includes(n))) rows.push(row);
  }
  if (!rows.length) return '';
  const blocks = formatChronicleBlocks(rows.slice().reverse(), { overview: 0, full: rows.length });
  return blocks === '（暂无纪要）' ? '' : blocks;
}

/**
 * 纪要资料块文本（**取最新 total 条，不按名筛选**）：手机网上商城资料块专用（用户定案 2026-10-06）——
 * 商城看的是世界行情，某条纪要是否提到主角与其是否该进上下文无关。展示从旧到新（时间正序），
 * 全部完整格式（无概览拆分）。无数据/total≤0 返回 ''。
 */
export function readLatestChronicleDossierBlocks(total: number): string {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  if (t <= 0) return '';
  const rows = readAllChronicleRowsNewestFirst().slice(0, t);
  if (!rows.length) return '';
  const blocks = formatChronicleBlocks(rows.slice().reverse(), { overview: 0, full: rows.length });
  return blocks === '（暂无纪要）' ? '' : blocks;
}