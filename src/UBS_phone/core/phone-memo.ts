// ===== 备忘录联动：AI 输出提取 → 草稿补全 → 注入主项目备忘录表（docs/02 §5.5 / docs/03） =====
// 写入对齐主项目 data-manager 的 SQL 试点（INSERT INTO beiwanglu，row_id 子查询自增，
// 备忘标题 UNIQUE 冲突时加时间后缀重试一次），但不 import data-manager（其带写回队列链）——
// 本模块只做单条 INSERT，AutoCard 插件自身负责表格缓存失效与回调广播。

import type { Conversation } from './chat-model';
import type { ParsedChatMemo } from './chat-parser';
import type { RosterSnapshot } from './roster';
import { hostWindow } from './host-env';
import { yearOfDateKey, matchedInsideDigitRun } from './social-time';
import { readPhoneDataRef } from './phone-store';
import { normalizeRowKeys, sqlColumnName, sqlTableName } from '../../unified-statusbar/core/db-schema-map';

/** 备忘录表列清单（中文口径；写 SQL 时由主项目 db-schema-map 适配器按后端决定是否翻物理名）。 */
const MEMO_COLUMNS: readonly string[] = ['备忘标题', '类型', '相关角色', '详细内容', '当前状态', '记录时间', '约定时间', '后续结果'];
const MEMO_TABLE = '备忘录';
/** 备忘录列的 SQL 名（台账后端＝中文；真数据库后端＝物理名）。 */
const memoCol = (header: string): string => sqlColumnName(MEMO_TABLE, header) ?? header;
const MEMO_SHEET_KEY = 'sheet_memo';

/** 待写入的完整备忘行（键=逻辑列名）。 */
export type MemoRow = Record<string, string>;

export interface MemoDraft {
  title: string;
  memoType: string;
  relatedCharacters: string;
  detail: string;
  /** 记录时间（YYYY-MM-DD，故事时间解析；不可解析留空，绝不回退真实日期）。 */
  recordDate: string;
  /** 约定时间（YYYY-MM-DD 或 ''）。 */
  appointedDate: string;
}

// ─── 纯函数（测试直接覆盖） ───

/** 从文本解析 YYYY-MM-DD；支持 2026-03-02 / 2026年3月2日 / 3月2日（缺年补 baseYear，无 baseYear 返回 ''）；失败返回 ''。
 *  年份幅值 4-6 位：四位纪年为常态，五位以上（如 14900）不能被截断成后四位。 */
export function parseStoryDate(text: string, baseYear?: number): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const ymd = raw.match(/(\d{4,6})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})/);
  if (ymd && !matchedInsideDigitRun(raw, ymd.index)) return fmtDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  let m = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) return baseYear ? fmtDate(baseYear, Number(m[1]), Number(m[2])) : '';
  m = raw.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) return baseYear ? fmtDate(baseYear, Number(m[1]), Number(m[2])) : '';
  return '';
}

function fmtDate(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 相关角色：私聊=对方；群聊=详细内容中点名的成员（无命中再查通讯录；仍无则留空）。 */
export function extractRelatedCharacters(detail: string, conv: Conversation, roster: RosterSnapshot): string {
  if (conv.kind === 'private') return conv.members[0] || '';
  const hits = conv.members.filter(name => name && detail.includes(name));
  if (hits.length) return hits.slice(0, 3).join('、');
  const contactHits = roster.contacts.filter(c => detail.includes(c.name)).map(c => c.name);
  return contactHits.slice(0, 3).join('、');
}

/** 备忘标题兜底（AI 未给标题时前端生成）：类型-详细内容前 12 字。 */
export function buildMemoTitle(memoType: string, detail: string): string {
  return `${memoType}-${detail.replace(/\s+/g, ' ').trim().slice(0, 12)}`;
}

/** AI 提取的备忘 → 完整草稿（标题优先 AI 生成、缺省前端兜底；日期一律取自故事时间，不落真实日期）。 */
export function buildMemoDraft(parsed: ParsedChatMemo, conv: Conversation, roster: RosterSnapshot): MemoDraft {
  // 故事时间的完整日期作记录时间；其年份供「3月2日」类缺年约定的补年（故事内年份，非真实年份）
  const recordDate = parseStoryDate(roster.global.time);
  // 年份取值走 yearOfDateKey（幅值 4-6 位安全）；slice(0, 4) 在五位纪年下只取到前四位
  const parsedYear = yearOfDateKey(recordDate);
  const storyYear = Number.isNaN(parsedYear) ? undefined : parsedYear;
  return {
    title: parsed.title || buildMemoTitle(parsed.memoType, parsed.detail),
    memoType: parsed.memoType,
    relatedCharacters: extractRelatedCharacters(parsed.detail, conv, roster),
    detail: parsed.detail,
    recordDate,
    appointedDate: parseStoryDate(parsed.appointedTime, storyYear),
  };
}

/** 草稿 → 数据库行（当前状态固定「未开始」，后续结果空）。 */
export function memoDraftToRow(draft: MemoDraft): MemoRow {
  return {
    '备忘标题': draft.title,
    '类型': draft.memoType,
    '相关角色': draft.relatedCharacters,
    '详细内容': draft.detail,
    '当前状态': '未开始',
    '记录时间': draft.recordDate,
    '约定时间': draft.appointedDate,
    '后续结果': '',
  };
}

// ─── 写入（AutoCard SQL，对齐主项目 insertContentRowSqlFirst 的语句构造） ───

/** 神数据库 API 取用口（导出给 phone-inventory 复用——物品表写入与备忘录同一套宿主访问纪律）。 */
export function getAutoCardAPI(): any {
  // 瑟瑟台账（SeseLedger）canonical 优先（__legacyFace 为兼容方法面）；未装载回落 AutoCardUpdaterAPI。
  try {
    const w = hostWindow() as any;
    if (w.SeseLedgerAPI) return w.SeseLedgerAPI.__legacyFace || w.SeseLedgerAPI;
    if (w.AutoCardUpdaterAPI) return w.AutoCardUpdaterAPI;
  } catch (_e) { /* cross-origin */ }
  try {
    const win = (globalThis as any).window;
    if (win?.SeseLedgerAPI) return win.SeseLedgerAPI.__legacyFace || win.SeseLedgerAPI;
    if (win?.AutoCardUpdaterAPI) return win.AutoCardUpdaterAPI;
  } catch (_e) { /* ignore */ }
  return null;
}

/** SQL 字符串转义（导出给 phone-inventory 复用同一口径）。 */
export function sqlEscape(s: string): string {
  return String(s ?? '').replace(/'/g, "''");
}

function buildInsertSql(row: MemoRow): { parameterizedSql: string; params: string[]; batchSql: string } {
  const table = sqlTableName(MEMO_TABLE);
  const columns: string[] = [];
  const params: string[] = [];
  const values: string[] = [];
  for (const header of MEMO_COLUMNS) {
    columns.push(sqlColumnName(MEMO_TABLE, header) ?? header);
    params.push(row[header] ?? '');
    values.push(sqlEscape(row[header] ?? ''));
  }
  const rowIdExpr = `(SELECT COALESCE(MAX(row_id), 0) + 1 FROM ${table})`;
  const columnsSql = ['row_id', ...columns].join(', ');
  return {
    parameterizedSql: `INSERT INTO ${table} (${columnsSql}) VALUES (${rowIdExpr}, ${params.map(() => '?').join(', ')})`,
    params,
    batchSql: `INSERT INTO ${table} (${columnsSql}) VALUES (${rowIdExpr}, ${values.map(v => `'${v}'`).join(', ')})`,
  };
}

/** 从后端写响应里取可展示的失败原因：
 *  - 台账把具体拒绝原因放在 `errors[]`（台账未就绪 / 待恢复 / 无可写 AI 楼层 / 未找到表列…）；
 *  - 真数据库放在 `error`（如 UNIQUE constraint failed）。
 *  统一收成一句话交给气泡，避免所有失败都被写成「数据库拒绝，可能标题重复」而无法排查。 */
export function sqlBackendFailureReason(result: any, fallback: string): string {
  if (Array.isArray(result?.errors)) {
    const errors = result.errors.map((e: unknown) => String(e ?? '').trim()).filter(Boolean);
    if (errors.length > 0) return errors.join('；');
  }
  const direct = result?.error ?? result?.message;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (direct && typeof direct === 'object' && typeof (direct as any).message === 'string' && (direct as any).message.trim()) {
    return String((direct as any).message).trim();
  }
  return fallback;
}

/** 错误文案是否为「唯一约束冲突」（真数据库撞 UNIQUE；台账已把冲突转成更新、不报这个）。 */
function isUniqueConflictError(message: string): boolean {
  return /unique|constraint|唯一/i.test(String(message || ''));
}

/** 写结果是否「恰好改了一行」（导出给 phone-inventory 复用同一判定口径）。 */
export function mutationChangedExactlyOneRow(result: any): boolean {
  if (!result || result.success === false || result.saved === false || result.error) return false;
  if (Array.isArray(result.errors) && result.errors.length > 0) return false;
  if (result.changes != null) {
    const changes = Number(result.changes);
    if (!Number.isFinite(changes) || changes !== 1) return false;
  }
  return true;
}

type SqlWriteOutcome = { ok: true } | { ok: false; error: string };

async function runInsert(row: MemoRow): Promise<SqlWriteOutcome> {
  const api = getAutoCardAPI();
  if (!api) return { ok: false, error: '未检测到表格后端（真数据库 / 瑟瑟台账）' };
  const stmt = buildInsertSql(row);
  if (typeof api.executeSqlMutation === 'function') {
    try {
      const result = await api.executeSqlMutation(stmt.parameterizedSql, stmt.params, { targetSheetKeys: [MEMO_SHEET_KEY] });
      return mutationChangedExactlyOneRow(result)
        ? { ok: true }
        : { ok: false, error: sqlBackendFailureReason(result, '数据库拒绝写入') };
    } catch (e) {
      return { ok: false, error: `写入异常：${(e as Error)?.message || String(e)}` };
    }
  }
  if (typeof api.executeSqlBatch === 'function') {
    try {
      const result = await api.executeSqlBatch({ sql: stmt.batchSql, targetSheetKeys: [MEMO_SHEET_KEY] });
      return result?.success === true
        ? { ok: true }
        : { ok: false, error: sqlBackendFailureReason(result, '数据库拒绝写入') };
    } catch (e) {
      return { ok: false, error: `写入异常：${(e as Error)?.message || String(e)}` };
    }
  }
  return { ok: false, error: '表格后端不支持 SQL 写入（真数据库需 SQLite 模式）' };
}

export type MemoInsertResult = { ok: true; title: string } | { ok: false; error: string };

/**
 * 注入备忘录（标题 UNIQUE 冲突 → 加随机后缀重试一次）。
 * 失败原因分级返回，调用方以系统气泡反馈；两次都失败时透出后端具体原因（台账/真数据库原文）。
 */
export async function insertPhoneMemo(draft: MemoDraft): Promise<MemoInsertResult> {
  const api = getAutoCardAPI();
  if (!api) return { ok: false, error: '未检测到表格后端（真数据库 / 瑟瑟台账）' };
  if (typeof api.executeSqlMutation !== 'function' && typeof api.executeSqlBatch !== 'function') {
    return { ok: false, error: '表格后端不支持 SQL 写入（真数据库需 SQLite 模式）' };
  }
  const first = await runInsert(memoDraftToRow(draft));
  if (first.ok) return { ok: true, title: draft.title };
  // 标题 UNIQUE 冲突 → 随机短后缀重试一次（不用时钟，保持全库无真实时间）
  const suffix = Math.random().toString(36).slice(2, 6);
  const retried: MemoDraft = { ...draft, title: `${draft.title}(${suffix})` };
  const second = await runInsert(memoDraftToRow(retried));
  if (second.ok) return { ok: true, title: retried.title };
  // 「标题重复」只在两次都确实撞唯一约束时才成立；否则（台账未就绪/待恢复/无可写楼层/缺表列…）
  // 必须原样透出后端原因——这正是此前排查不到真实失败原因的地方。
  const conflict = isUniqueConflictError(first.error) && isUniqueConflictError(second.error);
  if (!conflict) {
    try { console.warn('[小手机] 备忘录写入失败：', draft.title, first.error, second.error); } catch (_e) { /* ignore */ }
  }
  return { ok: false, error: conflict ? '写入备忘录失败（标题重复）' : `写入备忘录失败：${second.error || first.error || '数据库拒绝写入'}` };
}

// ─── 删除（微信备忘气泡长按；级联删备忘录表同名条目） ───

/** 备忘录标题的时间锚定前缀形式（对齐主项目 time-anchor.formatMemoAnchor：
 *  今天/明天/后天/N天后/昨天/前天/N天前 + 「，」）。跨项目不能 import，此处镜像一份最小形式；
 *  两处任一改形式需同步（同 INSERT 语句构造对齐 data-manager 的做法）。 */
const MEMO_ANCHOR_PREFIX_RE = /^(?:今天|明天|后天|昨天|前天|\d+天[前后])，$/;

/** 备忘录表标题是否对应待删标题：完全同名，或剥去时间锚定前缀后同名（前缀恒加在标题开头）。 */
export function memoTitleMatches(rowTitle: string, title: string): boolean {
  const t = String(rowTitle || '').trim();
  const base = String(title || '').trim();
  if (!t || !base) return false;
  if (t === base) return true;
  if (!t.endsWith(base)) return false;
  return MEMO_ANCHOR_PREFIX_RE.test(t.slice(0, t.length - base.length));
}

/** 历史备忘气泡（旧存档无 memoTitle 字段）：从文案尾部「…「标题」…查看」回填标题，
 *  使旧气泡同样可长按删除。成功气泡四风格（已记录备忘/道简已录/已记录手札/已记录羊皮笺）
 *  均以「查看」结尾；写入失败气泡以「未能记录」结尾、群名变更等系统气泡不以「查看」结尾，均不命中。 */
const MEMO_BUBBLE_TITLE_RE = /「([^「」]+)」[^「」]*查看\s*$/;
export function memoTitleFromBubbleText(text: string): string {
  const m = String(text || '').match(MEMO_BUBBLE_TITLE_RE);
  return m ? m[1].trim() : '';
}

/** 备忘录表通用查询：columns 必带 row_id；行最近优先（DESC，手机新增条目在尾部）；
 *  1000=各版本 queryTableRows 单页上限。无读能力/异常返回 null（区别于「空表」）。 */
function queryMemoRows(api: any, columns: string[]): Array<Record<string, unknown>> | null {
  if (typeof api.queryTableRows !== 'function') return null;
  try {
    const res = api.queryTableRows({
      tableName: '备忘录',
      columns: ['row_id', ...columns],
      orderBy: { column: 'row_id', direction: 'DESC' },
      limit: 1000,
    });
    const rows = res?.rows;
    if (!Array.isArray(rows)) return null;
    // 真数据库后端回物理列名 → 按请求顺序归一到中文列名（台账后端本就是中文）
    return normalizeRowKeys(rows as Array<Record<string, unknown>>, ['row_id', ...columns]);
  } catch (_e) {
    return null;
  }
}

/** 读备忘录表 (row_id, 备忘标题)；无读能力/异常返回 null。 */
function readMemoRows(api: any): Array<{ rowId: string; title: string }> | null {
  const rows = queryMemoRows(api, ['备忘标题']);
  if (rows === null) return null;
  return rows
    .map(r => ({ rowId: String(r?.row_id ?? ''), title: String(r?.['备忘标题'] ?? '') }))
    .filter(x => x.rowId !== '');
}

/** 日程提醒用的备忘行（只读）：约定时间原文 + 详细内容。 */
export interface PhoneMemoRow {
  rowId: string;
  title: string;
  /** 约定时间原文（appointed_time；手机写入的是 YYYY-MM-DD，主项目侧手填可能是自由写法）。 */
  appointedTime: string;
  /** 详细内容（卡片副行用）。 */
  detail: string;
}

/**
 * 读备忘录表供**日程提醒**用（M7 的数据源：主项目「备忘录」表就是用户看的那张，口径天然一致）。
 * 无神数据库/不支持读取/异常 → null（调用方按「读不到=不产生提醒」处理，不猜、不回落旧数据）。
 * 同步读取（queryTableRows 无 await，与 deletePhoneMemoByTitle 同款用法）；调用方经
 * `phone-schedule.invalidatePhoneScheduleCache()` 按需失效缓存。
 */
export function readPhoneMemoRows(): PhoneMemoRow[] | null {
  const api = getAutoCardAPI();
  if (!api) return null;
  const rows = queryMemoRows(api, ['备忘标题', '约定时间', '详细内容']);
  if (rows === null) return null;
  return rows
    .map(r => ({
      rowId: String(r?.row_id ?? ''),
      title: String(r?.['备忘标题'] ?? ''),
      appointedTime: String(r?.['约定时间'] ?? ''),
      detail: String(r?.['详细内容'] ?? ''),
    }))
    .filter(x => x.rowId !== '');
}

/** 执行参数化删除；API 明确失败返回 null，成功返回变更行数（未知计为 1）。 */
async function runDelete(sql: string, params: string[], api: any): Promise<number | null> {
  if (typeof api.executeSqlMutation !== 'function') return null;
  try {
    const result = await api.executeSqlMutation(sql, params, { targetSheetKeys: [MEMO_SHEET_KEY] });
    if (!result || result.success === false || result.saved === false || result.error) return null;
    if (Array.isArray(result.errors) && result.errors.length > 0) return null;
    return Number.isFinite(Number(result.changes)) ? Number(result.changes) : 1;
  } catch (_e) {
    return null;
  }
}

export type MemoDeleteResult = { ok: true; deleted: number } | { ok: false; error: string };

/**
 * f-b：清空/重置时删除**本聊天手机自己写过的**备忘录行。
 * 只认手机在系统气泡上记下的 `PhoneMessage.memoTitle`——那是手机插入成功时记下的真实标题
 * （含 UNIQUE 冲突时的后缀），不自造口径、不按「看起来像手机写的」猜，避免误删用户手填的行。
 * 必须在数据被清空**之前**调用（标题只能从当前数据里读出来）。任一条删除失败不阻断其余。
 */
export async function deletePhoneMemosForChat(): Promise<number> {
  const titles = new Set<string>();
  for (const conv of readPhoneDataRef().conversations) {
    for (const m of conv.messages) if (m.memoTitle) titles.add(m.memoTitle);
  }
  let deleted = 0;
  for (const title of titles) {
    try {
      const r = await deletePhoneMemoByTitle(title);
      if (r.ok) deleted += r.deleted;
    } catch (_e) { /* best effort：单条失败不阻断其余 */ }
  }
  return deleted;
}

/**
 * 删除备忘录表内同名条目（时间锚定前缀兼容）：读表定位「完全同名或剥前缀后同名」的行，
 * 按 row_id 参数化删除。找不到不算失败（deleted=0）；无数据库/不支持 SQL 写入才判失败。
 * 手机无读能力时退回精确同名 DELETE。
 */
export async function deletePhoneMemoByTitle(title: string): Promise<MemoDeleteResult> {
  const base = String(title || '').trim();
  if (!base) return { ok: false, error: '备忘标题为空' };
  const api = getAutoCardAPI();
  if (!api) return { ok: false, error: '未检测到表格后端（真数据库 / 瑟瑟台账）' };
  if (typeof api.executeSqlMutation !== 'function') {
    return { ok: false, error: '表格后端不支持 SQL 写入（真数据库需 SQLite 模式）' };
  }
  const rows = readMemoRows(api);
  if (rows === null) {
    // 无读能力：只按完全同名删（有前缀的行删不到，宁缺勿错删）
    const exact = await runDelete(`DELETE FROM ${sqlTableName(MEMO_TABLE)} WHERE ${memoCol('备忘标题')} = ?`, [base], api);
    return exact === null ? { ok: false, error: '删除备忘录失败' } : { ok: true, deleted: exact };
  }
  const hitIds = rows.filter(r => memoTitleMatches(r.title, base)).map(r => r.rowId);
  if (!hitIds.length) return { ok: true, deleted: 0 };
  const deleted = await runDelete(
    `DELETE FROM ${sqlTableName(MEMO_TABLE)} WHERE row_id IN (${hitIds.map(() => '?').join(', ')})`,
    hitIds,
    api,
  );
  return deleted === null ? { ok: false, error: '删除备忘录失败' } : { ok: true, deleted: Math.max(deleted, hitIds.length) };
}

// ─── 状态更新（商城订单送达/取消标记；docs/52 §8.3） ───

export type MemoStatusUpdateResult = { ok: true; updated: number } | { ok: false; error: string };

/**
 * 更新备忘录行的「当前状态 / 后续结果」（商城订单送达=已完成、取消=已取消）。
 * 定位口径与删除同款（完全同名或剥时间锚定前缀后同名）；行已被用户手删 = 静默跳过（ok/0，不报错）。
 * 与 phone-memo 其余写路径同一纪律：单条参数化 SQL、不 import data-manager、失败分级返回。
 */
export async function updatePhoneMemoStatus(
  title: string,
  status: string,
  result: string,
): Promise<MemoStatusUpdateResult> {
  const base = String(title || '').trim();
  if (!base) return { ok: false, error: '备忘标题为空' };
  const api = getAutoCardAPI();
  if (!api) return { ok: false, error: '未检测到表格后端（真数据库 / 瑟瑟台账）' };
  if (typeof api.executeSqlMutation !== 'function') {
    return { ok: false, error: '表格后端不支持 SQL 写入（真数据库需 SQLite 模式）' };
  }
  const rows = readMemoRows(api);
  if (rows === null) return { ok: false, error: '备忘录不可读（需 SQLite 模式）' };
  const hitIds = rows.filter(r => memoTitleMatches(r.title, base)).map(r => r.rowId);
  if (!hitIds.length) return { ok: true, updated: 0 };
  const sql = `UPDATE ${sqlTableName(MEMO_TABLE)} SET ${memoCol('当前状态')} = ?, ${memoCol('后续结果')} = ? WHERE row_id = ?`;
  let updated = 0;
  for (const rowId of hitIds) {
    try {
      const res = await api.executeSqlMutation(sql, [String(status ?? ''), String(result ?? ''), rowId], { targetSheetKeys: [MEMO_SHEET_KEY] });
      if (res && res.success !== false && res.saved !== false && !res.error
        && !(Array.isArray(res.errors) && res.errors.length > 0)) updated += 1;
    } catch (_e) { /* 单行失败不阻断其余 */ }
  }
  if (!updated) return { ok: false, error: '更新备忘录失败' };
  return { ok: true, updated };
}
