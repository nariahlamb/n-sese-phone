// ===== 数据获取与缓存管理 =====
import { isRowIdColumn } from './db-crud';
import { perfStart, perfEnd } from './perf-timing';
import { hasDbSchemaMapping, normalizeRowKeys, sqlColumnName, sqlTableName, DB_SCHEMA_MAP } from './db-schema-map';
import { createDbWriteQueue, type DbWriteOp, type DbWriteOpInternal } from './db-write-queue';
import { UB_EVENT, emitUbEvent } from './events';
import { getLedgerCanonical } from './ledger-takeover';

export type { DbWriteOp } from './db-write-queue';

export interface SheetContent {
  name: string;
  content: string[][];
  uid?: string;
  key?: string;
  sourceData?: { ddl?: string };
}

// 表格缓存
let _allSheetsCache: Record<string, SheetContent> | null = null;
/**
 * 最近一次表格缓存重建（invalidateCache 随真实快照回调或写库发生）所归属的聊天 storageId。
 * '' = 尚无真实快照（欢迎页 / 切卡过渡期：此时缓存要么为空、要么仍是上一张卡的残留表格）。
 * 由 index.ts 在收到非空表格快照时用 markSheetCacheChatKey(getCurrentStoryChatKey()) 打标。
 * 用于判定「当前表格快照是否属于当前聊天」——切卡过渡期旧卡残留表格会串到新卡业务里。
 */
let _sheetCacheChatKey = '';

// ===== O13/O14：表格数据修订令牌 =====
// 不变量：_allSheetsCache 的内容只在两处改变——(a) buildSheetCache 整体重建（换对象，epoch++），
// (b) applyQueueOp / rollbackQueueOp 就地增删改单元格（contentRev++）。除此之外无任何就地写
// （全库 grep 已确认）。因此 (epoch, contentRev) 唯一决定缓存内容。
// ★但「唯一决定」≠「可作跨 tick 缓存键」：invalidateCache 随插件每次快照推送推进 epoch
// （每 300ms tick 至少一次），故整串令牌跨 tick 必变。八轮实测：以它作键的衣柜预闸永不命中。
let _sheetsCacheEpoch = 0;
let _sheetsContentRev = 0;
let _tableSigMemo: { key: string; sig: string } | null = null;

/** 表格数据修订令牌（(缓存代, 内容修订, 是否已填充)）。仅用于「可能变过」判断（O13 渲染签名 memo）。
 *  ★勿作跨 tick 缓存键：含「缓存代」，而每 tick 的 invalidateCache() 都会推进它 ⇒ 键永不命中。
 *  需要跨 tick 稳定的内容信号请用 getSheetsContentRevision()，或按目标数据自建指纹（如 O14 名单来源指纹）。
 *  保留理由：O13 令牌 API（外部可能引用），勿当死代码删除。 */
export function getSheetsDataRevision(): string {
  return `${_sheetsCacheEpoch}|${_sheetsContentRev}|${_allSheetsCache ? 1 : 0}`;
}

/**
 * O13 令牌的「内容修订」分量（不含缓存代）：仅当表格内容被就地改写（applyQueueOp / rollbackQueueOp）时推进；
 * 插件推送导致的「内容未变重建」（invalidateCache，代++）**不**推进。
 * O32 用途：日历日期计数缓存的键——用整串令牌会因每 tick 的 invalidateCache 而永不命中。
 */
export function getSheetsContentRevision(): number {
  return _sheetsContentRev;
}

function buildSheetCache(): void {
  const API = getAutoCardAPI();
  const all = API ? API.exportTableAsJson() : {};
  _allSheetsCache = {};
  for (const key in all) {
    if (!key.startsWith('sheet_')) continue;
    const sheet = all[key] as SheetContent;
    _allSheetsCache[sheet.name] = sheet;
    _allSheetsCache[key] = sheet;
    if (sheet.uid) _allSheetsCache[sheet.uid] = sheet;
    if (sheet.key) _allSheetsCache[sheet.key] = sheet;
    const ddl = sheet.sourceData?.ddl || '';
    const m = ddl.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
    if (m) _allSheetsCache[m[1]] = sheet;
  }
  // 写回队列重放：缓存重建（插件回调后 invalidateCache）时把未确认批次重新叠加上去，
  // 防止「乐观值 → flush 完成」之间 UI 闪回旧值；flush 已完成时批次为空，零开销。
  try { dbWriteQueue.replayPendingOverlay(); } catch { /* ignore */ }
  // 重建完成才记代（重放内若触发 applyQueueOp 会另增 contentRev，此处再收口一次即可）
  _sheetsCacheEpoch += 1;
  _tableSigMemo = null;
}

/** 新模板主字段：NSFW 下体状态列名。 */
export function getNsfwGenitalsColumn(): string {
  return '下体状态';
}

/** 新模板生理反应字段（label, 列名）。 */
export function getPhysiologyFields(): [string, string][] {
  return [
    ['胸部', '胸部'], ['下体', '下体'], ['口穴', '口穴'],
    ['菊穴', '菊穴'], ['其他部位', '其他部位'],
  ];
}

/** 将新模板业务名解析为当前完整模板的真实表名。 */
export function resolveTableNameForApi(tableName: string): string {
  return getSheetByName(tableName)?.name || tableName;
}

export function getAutoCardAPI(): any {
  // 瑟瑟台账（SeseLedger）canonical API 优先；未装载时回落 AutoCardUpdaterAPI（真数据库/台账别名）。
  let api: any = null;
  const ledger = getLedgerCanonical();
  if (ledger) api = tableApiOf(ledger);
  if (!api) {
    try {
      if (parent && (parent as any).AutoCardUpdaterAPI) api = (parent as any).AutoCardUpdaterAPI;
    } catch (e) { /* cross-origin */ }
  }
  if (!api && (window as any).AutoCardUpdaterAPI) api = (window as any).AutoCardUpdaterAPI;
  return api;
}

/** 台账 canonical API 的兼容面投影（legacy 形状方法桥接；canonical 独有方法不在此暴露）。 */
function tableApiOf(ledger: any): any {
  if (!ledger || typeof ledger !== 'object') return null;
  const face = (ledger.__legacyFace as any) || null;
  return face || ledger;
}

export function getSheetByName(tableName: string): SheetContent | null {
  if (!_allSheetsCache) buildSheetCache();
  return _allSheetsCache?.[tableName] || null;
}

/**
 * 返回当前已暖表缓存中的唯一表副本；缓存尚未建立时返回空数组，本函数自身
 * 绝不触发 exportTableAsJson。冷缓存主动暖化走 ensureSheetsCacheWarm（每聊天至多一次）。
 */
export function getCachedSheetsSnapshot(): SheetContent[] {
  if (!_allSheetsCache) return [];
  const seen = new Set<SheetContent>();
  const sheets: SheetContent[] = [];
  for (const sheet of Object.values(_allSheetsCache)) {
    if (!sheet || seen.has(sheet)) continue;
    seen.add(sheet);
    sheets.push({
      ...sheet,
      content: Array.isArray(sheet.content) ? sheet.content.map(row => [...row]) : [],
      sourceData: sheet.sourceData ? { ...sheet.sourceData } : undefined,
    });
  }
  return sheets;
}

/**
 * 冷缓存时主动读一次全表（同步毫秒级，一次 exportTableAsJson），供宅仙目录构建等
 * 低频按需路径使用。缓存已暖或读取失败时为无操作；调用方须保证低频（勿在回调/轮询里调）。
 */
export function ensureSheetsCacheWarm(): boolean {
  if (_allSheetsCache) return true;
  try {
    buildSheetCache();
  } catch (_e) {
    return false;
  }
  return !!_allSheetsCache && Object.keys(_allSheetsCache).length > 0;
}

export function getCellByHeader(tableName: string, rowIndex: number, colName: string): string | null {
  const sheet = getSheetByName(tableName);
  if (!sheet) return null;
  const headers = sheet.content[0];
  const colIdx = headers.indexOf(colName);
  if (colIdx === -1) return null;
  return sheet.content[rowIndex]?.[colIdx] ?? null;
}

/** 是否处于色色状态（全局数据表「是否色色」）。兼容中文「是」与英文 true/True/TRUE。 */
export function isNsfwPlayActive(): boolean {
  const value = getCellByHeader('全局数据表', 1, '是否色色') || '';
  return value === '是' || value === 'true' || value === 'True' || value === 'TRUE';
}

/** 解析当前选中角色（在场角色表）：读 _activeChar 校验其仍在场，失效回退第1行，回写缓存。 */
export function resolveActiveCharacter(): string | null {
  let active = (window as any)._activeChar || null;
  if (!active || findRowByColumn('在场角色表', '姓名', active) === -1) {
    active = getCellByHeader('在场角色表', 1, '姓名') || null;
  }
  (window as any)._activeChar = active;
  return active;
}

export function findRowByColumn(tableName: string, colName: string, value: string): number {
  const sheet = getSheetByName(tableName);
  if (!sheet) return -1;
  const headers = sheet.content[0];
  const colIdx = headers.indexOf(colName);
  if (colIdx === -1) return -1;
  for (let i = 1; i < sheet.content.length; i++) {
    if (String(sheet.content[i][colIdx]) === String(value)) return i;
  }
  return -1;
}

/** 读一列的全部值（跳过表头、逐行 trim、含空串——行为与散落各处的手写样板一致）。
 *  U57 单源出口：全项目「找列号→for 循环→收集」样板原有 53 处，此后新增读列一律走这里；
 *  存量样板按批次逐步迁移（见 docs/unification/PLAN.md U57）。表/列不存在返回空数组。
 *  注意：不做列索引缓存（O26 已封板）。 */
export function readColumnValues(tableName: string, colName: string): string[] {
  const sheet = getSheetByName(tableName);
  if (!sheet || sheet.content.length < 2) return [];
  const colIdx = sheet.content[0].indexOf(colName);
  if (colIdx === -1) return [];
  const out: string[] = [];
  for (let i = 1; i < sheet.content.length; i++) {
    out.push(String(sheet.content[i][colIdx] ?? '').trim());
  }
  return out;
}

export function invalidateCache(): void {
  _allSheetsCache = null;
  _playListCache = null;
  // O13/O14：失效即推进令牌（缓存代++），保证「已失效→重建」前后令牌必不同
  _sheetsCacheEpoch += 1;
  _tableSigMemo = null;
}

/** 由 index.ts 在收到非空表格快照时打标：当前缓存（重建后）属于该聊天。 */
export function markSheetCacheChatKey(chatKey: string): void {
  _sheetCacheChatKey = chatKey;
}

/** 最近一次表格缓存所属的聊天 storageId（'' = 尚无真实快照）。切卡后新卡首个非空快照到达前仍指向前卡。 */
export function getSheetCacheChatKey(): string {
  return _sheetCacheChatKey;
}

// ===== SQL 写入辅助函数 =====
// 本项目已正式抛弃原生数据库结构：表格写入只走 SQLite（executeSqlMutation/executeSqlBatch），
// SQL 能力不可用或执行失败时写入直接失败返回 false——没有任何「回退原生 CRUD」的降级路径
// （原生按 content 索引逐条删行在批量场景会索引错位删错行，历史上是真实数据破坏源）。

/** 检测当前是否处于 SQLite 模式（API 同时暴露 querySql 和 executeSqlBatch） */
export function isSqliteMode(): boolean {
  const api = getAutoCardAPI();
  return !!(api && typeof api.querySql === 'function' && typeof api.executeSqlBatch === 'function');
}

/** SQLite 字符串转义：双写单引号 */
export function sqlEscape(s: string): string {
  return String(s ?? '').replace(/'/g, "''");
}

export interface LogicalTableQuery {
  tableName: string;
  columns: readonly string[];
  where?: Readonly<Record<string, string | number | boolean | null>>;
  orderBy?: { column: string; direction?: 'ASC' | 'DESC' };
  limit?: number;
}

/** 单页声明式查询：用于按需阅读大表，不改变 queryLogicalTableRows 的全量语义。 */
export interface LogicalTablePageQuery extends LogicalTableQuery {
  offset?: number;
}

// 中文/字母开头 + 中文/字母数字下划线（台账口径：表/列名一律中文；真数据库物理名同样合法）
const SQL_IDENTIFIER_RE = /^[一-鿿A-Za-z_][一-鿿A-Za-z0-9_]*$/;
const QUERY_TABLE_ROWS_PAGE_SIZE = 1000;

function validateSqlIdentifier(identifier: string): string {
  if (!SQL_IDENTIFIER_RE.test(identifier)) {
    throw new Error('非法 SQL 标识符');
  }
  return identifier;
}

/**
 * 跨数据库插件版本的只读查询入口。
 *
 * 禁止把中文表名重新放进 raw querySql：数据库插件的 NameMapper 在表名映射
 * 缺失时会继续做列名子串替换，把「纪要表」改成不存在的「chronicle_text表」。
 * queryTableRows 会先按当前 sheet.name 定位表，再由各版本生成真实物理名，
 * 因而同时兼容数据库插件的多个版本。
 *
 * 四个版本的单次声明式查询都最多返回 1000 行，因此这里同步分页且任一页失败
 * 就返回 null，绝不把部分数据伪装成完整结果。当最低支持版本提供无此上限的
 * 稳定声明式读取 API，并完成最低版+最新版回归后，才可删除分页兼容代码。
 *
 * 返回 null 表示读取失败；[] 才表示查询成功但没有匹配行。
 */
export function queryLogicalTableRows(
  query: LogicalTableQuery,
): Record<string, unknown>[] | null {
  const tableName = String(query?.tableName || '').trim();
  try {
    const api = getAutoCardAPI();
    if (!api || typeof api.queryTableRows !== 'function') throw new Error('queryTableRows unavailable');
    if (!tableName) throw new Error('逻辑表名不能为空');
    if (!Array.isArray(query.columns) || query.columns.length === 0) {
      throw new Error('查询列不能为空');
    }

    const columns = query.columns.map(column => validateSqlIdentifier(String(column)));
    for (const column of Object.keys(query.where || {})) validateSqlIdentifier(column);

    let orderBy: { column: string; direction: 'ASC' | 'DESC' } | undefined;
    if (query.orderBy) {
      const direction = String(query.orderBy.direction || 'ASC').toUpperCase();
      if (direction !== 'ASC' && direction !== 'DESC') throw new Error('非法排序方向');
      orderBy = {
        column: validateSqlIdentifier(query.orderBy.column),
        direction,
      };
    }

    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit <= 0) throw new Error('非法查询行数');
    }

    const rows: Record<string, unknown>[] = [];
    let offset = 0;
    while (query.limit === undefined || rows.length < query.limit) {
      const remaining = query.limit === undefined
        ? QUERY_TABLE_ROWS_PAGE_SIZE
        : query.limit - rows.length;
      const pageLimit = Math.min(QUERY_TABLE_ROWS_PAGE_SIZE, remaining);
      const result = api.queryTableRows({
        tableName,
        columns: [...columns],
        ...(query.where ? { where: query.where } : {}),
        ...(orderBy ? { orderBy } : {}),
        limit: pageLimit,
        offset,
      });
      if (!Array.isArray(result?.rows) || result.rows.length > pageLimit) {
        throw new Error('queryTableRows invalid result');
      }

      const pageRows = normalizeRowKeys(result.rows as Record<string, unknown>[], columns);
      rows.push(...pageRows);
      if (pageRows.length < pageLimit) break;
      offset += pageRows.length;
    }
    return rows;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error(`[统一状态栏] 逻辑表查询失败（${tableName || '未知表'}，${errorName}）`);
    return null;
  }
}

/**
 * 只读取一个已指定 offset 的页面。调用者必须自行保存 offset；本函数绝不扫描其余页面，
 * 因而适用于纪要等数百行的按需阅读界面。
 */
export function queryLogicalTablePage(
  query: LogicalTablePageQuery,
): Record<string, unknown>[] | null {
  const tableName = String(query?.tableName || '').trim();
  try {
    const api = getAutoCardAPI();
    if (!api || typeof api.queryTableRows !== 'function') throw new Error('queryTableRows unavailable');
    if (!tableName || !Array.isArray(query.columns) || query.columns.length === 0) throw new Error('invalid query');
    const columns = query.columns.map(column => validateSqlIdentifier(String(column)));
    for (const column of Object.keys(query.where || {})) validateSqlIdentifier(column);
    if (!Number.isInteger(query.limit) || (query.limit as number) <= 0 || (query.limit as number) > QUERY_TABLE_ROWS_PAGE_SIZE) throw new Error('invalid limit');
    const offset = query.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid offset');
    let orderBy: { column: string; direction: 'ASC' | 'DESC' } | undefined;
    if (query.orderBy) {
      const direction = String(query.orderBy.direction || 'ASC').toUpperCase();
      if (direction !== 'ASC' && direction !== 'DESC') throw new Error('invalid order');
      orderBy = { column: validateSqlIdentifier(query.orderBy.column), direction };
    }
    const limit = Number(query.limit);
    const result = api.queryTableRows({ tableName, columns: [...columns], ...(query.where ? { where: query.where } : {}), ...(orderBy ? { orderBy } : {}), limit, offset });
    if (!Array.isArray(result?.rows) || result.rows.length > limit) throw new Error('invalid result');
    return normalizeRowKeys(result.rows as Record<string, unknown>[], columns);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error(`[统一状态栏] 逻辑分页查询失败（${tableName || '未知表'}，${errorName}）`);
    return null;
  }
}

// ===== 三表 SQL 写入试点 =====

export type SqlPilotTableName = '物品表' | '备忘录' | '瑟瑟任务表';

/** SQL 优先写入的结构化失败原因：code 稳定（日志/测试用），message 面向用户（toast 直接用）。 */
export type SqlWriteFailureCode =
  | 'invalid_table'
  | 'invalid_row'
  | 'no_sheet'
  | 'no_row_id_column'
  | 'invalid_row_id'
  | 'api_unavailable'
  | 'not_sqlite'
  | 'not_ready'
  | 'no_write_scope'
  | 'recovery'
  | 'no_table_remote'
  | 'no_column_remote'
  | 'row_not_found'
  | 'changed_not_one'
  | 'sql_error'
  | 'exception';

export interface SqlWriteFailure {
  code: SqlWriteFailureCode;
  message: string;
  detail?: string;
}

export type SqlWriteResult = { ok: true } | { ok: false; failure: SqlWriteFailure };

interface SqlPilotTableDescriptor {
  sheetKey: string;
}

// 表/列名一律交给 db-schema-map 的适配器（台账后端＝中文原名；真数据库后端＝物理名），
// 本处只留 targetSheetKeys 需要的 sheetKey——不再重复维护第二份名字映射。
const SQL_PILOT_TABLES: Readonly<Record<SqlPilotTableName, SqlPilotTableDescriptor>> = {
  '物品表': { sheetKey: 'sheet_inventory' },
  '备忘录': { sheetKey: 'sheet_memo' },
  '瑟瑟任务表': { sheetKey: 'sheet_k7gp2gbw7' },
};

export function isSqlPilotTableName(tableName: string): tableName is SqlPilotTableName {
  return Object.prototype.hasOwnProperty.call(SQL_PILOT_TABLES, tableName);
}

function mutationChangedExactlyOneRow(result: any): boolean {
  if (!result || result.success === false || result.saved === false || result.error) return false;
  if (Array.isArray(result.errors) && result.errors.length > 0) return false;
  if (result.changes != null) {
    const changes = Number(result.changes);
    if (!Number.isFinite(changes) || changes !== 1) return false;
  }
  return true;
}

function sqlStringLiteral(value: unknown): string {
  return `'${sqlEscape(String(value ?? ''))}'`;
}

function buildPilotInsert(
  tableName: SqlPilotTableName,
  data: Record<string, string>,
): { parameterizedSql: string; batchSql: string; params: string[] } | null {
  const table = sqlTableName(tableName);
  const columns: string[] = [];
  const params: string[] = [];
  for (const [logicalColumn, rawValue] of Object.entries(data)) {
    if (isRowIdColumn(logicalColumn)) continue;
    const column = sqlColumnName(tableName, logicalColumn);
    if (!column) return null;
    columns.push(column);
    params.push(String(rawValue ?? ''));
  }
  if (columns.length === 0) return null;

  const rowIdExpr = `(SELECT COALESCE(MAX(row_id), 0) + 1 FROM ${table})`;
  const columnsSql = ['row_id', ...columns].join(', ');
  const parameterizedValues = [rowIdExpr, ...params.map(() => '?')].join(', ');
  const batchValues = [rowIdExpr, ...params.map(sqlStringLiteral)].join(', ');
  return {
    parameterizedSql: `INSERT INTO ${table} (${columnsSql}) VALUES (${parameterizedValues})`,
    batchSql: `INSERT INTO ${table} (${columnsSql}) VALUES (${batchValues})`,
    params,
  };
}

/**
 * 三表新增试点：参数化 SQL mutation → SQL batch。仅 SQLite 模式可用；SQL 已调用后的失败
 * 不再重试或改道，避免约束失败或结果不明时重复新增。SQL 不可用时直接失败（无原生回退）。
 */
export async function insertContentRowSqlFirst(
  tableName: SqlPilotTableName,
  data: Record<string, string>,
): Promise<boolean> {
  return withDbWriteTiming('db-write:insertSqlFirst', async () => {
    if (!isSqlPilotTableName(tableName)) return false;
    const descriptor = SQL_PILOT_TABLES[tableName];
    const statement = buildPilotInsert(tableName, data);
    if (!statement) return false;
    const api = getAutoCardAPI();
    if (!api) return false;
    if (!isSqliteMode()) return false;

    if (typeof api.executeSqlMutation === 'function') {
      try {
        const result = await api.executeSqlMutation(
          statement.parameterizedSql,
          statement.params,
          { targetSheetKeys: [descriptor.sheetKey] },
        );
        if (!mutationChangedExactlyOneRow(result)) return false;
        invalidateCache();
        emitDbWriteCommitted();
        return true;
      } catch (_error) {
        return false;
      }
    }

    if (typeof api.executeSqlBatch === 'function') {
      try {
        const result = await api.executeSqlBatch({
          sql: statement.batchSql,
          targetSheetKeys: [descriptor.sheetKey],
        });
        if (result?.success !== true) return false;
        invalidateCache();
        emitDbWriteCommitted();
        return true;
      } catch (_error) {
        return false;
      }
    }

    return false;
  });
}

/** 单行摘要（toast / 日志 message 用，避免整段 JSON 撑爆通知）。 */
function shortSqlWriteMessage(text: unknown, limit = 160): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 错误对象 → 短消息 / 详情（状态栏零耦合，不引入台账侧 error-detail）。 */
function sqlWriteErrorText(error: unknown): { message: string; detail: string } {
  try {
    if (error instanceof Error) return { message: shortSqlWriteMessage(error.message), detail: error.stack || error.message };
    return { message: shortSqlWriteMessage(error), detail: String(error ?? '') };
  } catch (_e) {
    return { message: '未知错误', detail: '' };
  }
}

/** 结果对象的安全摘要（异常形状/循环引用不阻断失败上报）。 */
function sqlWriteResultDetail(result: unknown): string {
  try { return shortSqlWriteMessage(JSON.stringify(result ?? null), 400); } catch (_e) { return shortSqlWriteMessage(result, 400); }
}

/** 台账错误清单 → 稳定 code + 可读文案（台账已写中文原因，这里只归类）。 */
function classifySqlWriteErrors(errors: string[]): { code: SqlWriteFailureCode; message: string } {
  const text = errors.join('；');
  if (text.includes('台账待恢复')) return { code: 'recovery', message: '台账处于待恢复状态，请先到「迁移 → 台账恢复」处理' };
  if (text.includes('台账未就绪')) return { code: 'not_ready', message: '台账尚未就绪，请稍后重试' };
  if (text.includes('没有可写入的 AI 楼层')) return { code: 'no_write_scope', message: '当前聊天没有可写入的 AI 楼层' };
  if (text.includes('未找到表')) return { code: 'no_table_remote', message: shortSqlWriteMessage(text, 120) };
  if (text.includes('不存在列')) return { code: 'no_column_remote', message: shortSqlWriteMessage(text, 120) };
  return { code: 'sql_error', message: shortSqlWriteMessage(text ? `删除被拒绝：${text}` : '表格后端拒绝了删除') };
}

/** 删除失败统一上报：console 永远留痕；台账存在时再转一份到工作台日志（来源归「其他」）。
 *  forwardToLedger=false 只用于「台账 runSql 已记录同一失败」的 API 返回错误，避免日志重复。 */
function reportSqlDeleteFailure(
  context: { tableName: string; rowIndex: number; rowId?: number; sheetRows?: number; api?: any },
  failure: SqlWriteFailure,
  opts: { forwardToLedger: boolean },
): void {
  let ledger: any = null;
  try { ledger = getLedgerCanonical(); } catch (_e) { /* cross-origin */ }
  const backend = ledger ? 'ledger' : context.api ? 'autocard' : 'none';
  const sqlite = !!context.api && typeof context.api.querySql === 'function' && typeof context.api.executeSqlBatch === 'function';
  const payload = {
    code: failure.code,
    table: context.tableName,
    rowIndex: context.rowIndex,
    ...(context.rowId !== undefined ? { rowId: context.rowId } : {}),
    ...(context.sheetRows !== undefined ? { cachedRows: context.sheetRows } : {}),
    backend,
    sqlite,
    message: failure.message,
    ...(failure.detail ? { detail: failure.detail } : {}),
  };
  try { console.error('[统一状态栏] SQL 删除失败', payload); } catch (_e) { /* ignore */ }
  if (!opts.forwardToLedger || !ledger || typeof ledger.reportIssue !== 'function') return;
  try {
    const detail = [
      `code=${failure.code}`,
      `table=${context.tableName}`,
      `rowIndex=${context.rowIndex}`,
      context.rowId !== undefined ? `rowId=${context.rowId}` : '',
      context.sheetRows !== undefined ? `cachedRows=${context.sheetRows}` : '',
      `backend=${backend}`,
      failure.detail || '',
    ].filter(Boolean).join('\n');
    ledger.reportIssue('error', '其他', `状态栏删除失败：${failure.message}`, detail);
  } catch (_e) { /* 诊断上报失败不影响操作结果 */ }
}

/**
 * 三表删除试点（结构化版本）：从现有快照把 rowIndex 解析为稳定 row_id，再走 SQL 删除。
 * 失败一定会写 console，并在台账存在时同步一份到工作台日志（API 返回的错误由台账 runSql 自己记录，
 * 这里不重复上报）。SQL 已调用后的失败不按位置重试，避免快照过期时删除其他记录；仅 SQLite 模式可用。
 */
export async function deleteContentRowSqlFirstDetailed(
  tableName: SqlPilotTableName,
  rowIndex: number,
): Promise<SqlWriteResult> {
  return withDbWriteTiming('db-write:deleteSqlFirst', async () => {
    const context: { tableName: string; rowIndex: number; rowId?: number; sheetRows?: number; api?: any } = { tableName, rowIndex };
    const fail = (
      code: SqlWriteFailureCode,
      message: string,
      detail?: string,
      forwardToLedger = true,
    ): SqlWriteResult => {
      const failure: SqlWriteFailure = { code, message, ...(detail ? { detail } : {}) };
      reportSqlDeleteFailure(context, failure, { forwardToLedger });
      return { ok: false, failure };
    };

    try {
      if (!isSqlPilotTableName(tableName)) return fail('invalid_table', `不支持 SQL 删除的表「${tableName}」`);
      if (!Number.isInteger(rowIndex) || rowIndex < 1) return fail('invalid_row', '行号无效，请刷新列表后重试', `rowIndex=${rowIndex}`);
      const sheet = getSheetByName(tableName);
      context.sheetRows = sheet?.content?.length;
      if (!sheet?.content?.length) return fail('no_sheet', `未找到表「${tableName}」或表为空`);
      const headers = sheet.content[0] || [];
      const rowIdColumn = headers.findIndex(isRowIdColumn);
      if (rowIdColumn < 0) return fail('no_row_id_column', `表「${tableName}」缺少 row_id 主键列`, `headers=${headers.join('|')}`);
      const row = sheet.content[rowIndex];
      if (!row) return fail('row_not_found', '该记录已不存在（数据可能已被更新），请刷新列表后重试', `contentRows=${sheet.content.length}`);
      const rowId = Number(row[rowIdColumn]);
      if (!Number.isInteger(rowId) || rowId <= 0) return fail('invalid_row_id', `无法解析第 ${rowIndex} 行的 row_id`, `cell=${String(row[rowIdColumn] ?? '')}`);
      context.rowId = rowId;

      const descriptor = SQL_PILOT_TABLES[tableName];
      const api = getAutoCardAPI();
      context.api = api;
      if (!api) return fail('api_unavailable', '表格后端不可用（台账可能尚未装载）');
      if (!isSqliteMode()) return fail('not_sqlite', '当前表格后端不支持 SQL 写入');
      const parameterizedSql = `DELETE FROM ${sqlTableName(tableName)} WHERE row_id = ?`;

      if (typeof api.executeSqlMutation === 'function') {
        const result = await api.executeSqlMutation(
          parameterizedSql,
          [rowId],
          { targetSheetKeys: [descriptor.sheetKey] },
        );
        if (mutationChangedExactlyOneRow(result)) {
          invalidateCache();
          emitDbWriteCommitted();
          return { ok: true };
        }
        const errors = Array.isArray(result?.errors) ? result.errors.map(String) : [];
        if (errors.length > 0) {
          const classified = classifySqlWriteErrors(errors);
          // 同一失败已由台账 runSql 写进工作台日志——这里只补 console，不重复上报。
          return fail(classified.code, classified.message, errors.join('\n'), false);
        }
        if (result?.success === false || result?.saved === false || result?.error) {
          const reason = result?.error ? String(result.error) : result?.saved === false ? '删除结果未确认落盘' : '表格后端拒绝了删除';
          return fail('sql_error', `删除失败：${shortSqlWriteMessage(reason)}`, sqlWriteResultDetail(result));
        }
        const changes = Number(result?.changes);
        if (Number.isFinite(changes) && changes === 0) {
          return fail('row_not_found', '没有找到要删除的行（数据可能已被更新），请刷新列表后重试', 'changes=0');
        }
        return fail('changed_not_one', `删除未命中唯一一行（实际 ${Number.isFinite(changes) ? changes : '未知'} 行）`, sqlWriteResultDetail(result));
      }

      if (typeof api.executeSqlBatch === 'function') {
        const result = await api.executeSqlBatch({
          sql: `DELETE FROM ${sqlTableName(tableName)} WHERE row_id = ${rowId}`,
          targetSheetKeys: [descriptor.sheetKey],
        });
        if (result?.success === true) {
          invalidateCache();
          emitDbWriteCommitted();
          return { ok: true };
        }
        const errors = Array.isArray(result?.errors) ? result.errors.map(String) : [];
        if (errors.length > 0) {
          const classified = classifySqlWriteErrors(errors);
          return fail(classified.code, classified.message, errors.join('\n'), false);
        }
        return fail('sql_error', '表格后端拒绝了删除', sqlWriteResultDetail(result));
      }

      return fail('not_sqlite', '当前表格后端不支持 SQL 删除');
    } catch (error) {
      const text = sqlWriteErrorText(error);
      return fail('exception', `删除请求异常：${text.message}`, text.detail);
    }
  });
}

/** 兼容旧调用：布尔语义不变（失败仍写 console / 台账日志）。需要 toast 原因时用 Detailed 版本。 */
export async function deleteContentRowSqlFirst(
  tableName: SqlPilotTableName,
  rowIndex: number,
): Promise<boolean> {
  return (await deleteContentRowSqlFirstDetailed(tableName, rowIndex)).ok;
}

// ===== 批量 SQL 动作（长按批量选择用） =====

/** 批量删除 SQL 构造：DELETE FROM <物理表> WHERE row_id IN (...)。
 *  row_id 为整数白名单（Number.isInteger && >0），无注入风险。 */
export function buildBatchDeleteSql(
  tableName: SqlPilotTableName,
  rowIds: number[],
): string | null {
  if (!isSqlPilotTableName(tableName)) return null;
  if (!Array.isArray(rowIds) || rowIds.length === 0) return null;
  const ids = rowIds.filter(id => Number.isInteger(id) && id > 0);
  if (ids.length !== rowIds.length || ids.length === 0) return null;
  return `DELETE FROM ${sqlTableName(tableName)} WHERE row_id IN (${ids.join(',')})`;
}

/** 批量插入 SQL 构造：N 条 INSERT 各带 MAX(row_id)+1 子查询。
 *  不能用单条多值 INSERT——单语句内所有行会算出同一个 row_id 触发主键冲突。 */
export function buildBatchInsertSql(
  tableName: SqlPilotTableName,
  rows: Array<Record<string, string>>,
): string | null {
  if (!isSqlPilotTableName(tableName) || !Array.isArray(rows) || rows.length === 0) return null;
  const statements: string[] = [];
  for (const data of rows) {
    const built = buildPilotInsert(tableName, data);
    if (!built) return null;
    statements.push(built.batchSql);
  }
  return statements.join(';\n');
}

/** 批量删除：把表行索引（0 是表头）解析为稳定 row_id，再单条 SQL 批量删除。
 *  无法解析的行跳过；SQL 已执行后失败不二次写入（三表试点纪律）。仅 SQLite 模式可用。 */
export async function applyBatchDeleteToTable(
  tableName: SqlPilotTableName,
  rowIndexes: number[],
): Promise<{ ok: boolean; deleted: number; skipped: number }> {
  return withDbWriteTiming('db-write:batchDelete', async () => {
    if (!isSqlPilotTableName(tableName) || !Array.isArray(rowIndexes) || rowIndexes.length === 0) {
      return { ok: false, deleted: 0, skipped: 0 };
    }
    const sheet = getSheetByName(tableName);
    if (!sheet?.content?.length) return { ok: false, deleted: 0, skipped: 0 };
    const headers = sheet.content[0] || [];
    const rowIdColumn = headers.findIndex(isRowIdColumn);
    if (rowIdColumn < 0) return { ok: false, deleted: 0, skipped: 0 };

    const rowIds: number[] = [];
    let skipped = 0;
    for (const rowIndex of rowIndexes) {
      if (!Number.isInteger(rowIndex) || rowIndex < 1) { skipped++; continue; }
      const row = sheet.content[rowIndex];
      if (!row) { skipped++; continue; }
      const rowId = Number(row[rowIdColumn]);
      if (!Number.isInteger(rowId) || rowId <= 0) { skipped++; continue; }
      rowIds.push(rowId);
    }
    if (rowIds.length === 0) return { ok: false, deleted: 0, skipped };

    const api = getAutoCardAPI();
    if (!api) return { ok: false, deleted: 0, skipped };
    if (!isSqliteMode()) return { ok: false, deleted: 0, skipped };

    const sql = buildBatchDeleteSql(tableName, rowIds);
    if (!sql) return { ok: false, deleted: 0, skipped };
    try {
      const result = await api.executeSqlBatch({
        sql,
        targetSheetKeys: [SQL_PILOT_TABLES[tableName].sheetKey],
      });
      if (result?.success !== true) return { ok: false, deleted: 0, skipped };
      invalidateCache();
      emitDbWriteCommitted();
      return { ok: true, deleted: rowIds.length, skipped };
    } catch (_error) {
      return { ok: false, deleted: 0, skipped };
    }
  });
}

/** 批量插入：N 条 INSERT 拼一次 executeSqlBatch；仅 SQLite 模式可用（无原生回退）。 */
export async function batchInsertRows(
  tableName: SqlPilotTableName,
  rows: Array<Record<string, string>>,
): Promise<boolean> {
  return withDbWriteTiming('db-write:batchInsert', async () => {
    if (!isSqlPilotTableName(tableName) || !Array.isArray(rows) || rows.length === 0) return false;
    const api = getAutoCardAPI();
    if (!api) return false;
    if (!isSqliteMode()) return false;
    const sql = buildBatchInsertSql(tableName, rows);
    if (!sql) return false;
    try {
      const result = await api.executeSqlBatch({
        sql,
        targetSheetKeys: [SQL_PILOT_TABLES[tableName].sheetKey],
      });
      if (result?.success !== true) return false;
      invalidateCache();
      emitDbWriteCommitted();
      return true;
    } catch (_error) {
      return false;
    }
  });
}

// ===== 渲染签名（脏检查用） =====
// 覆盖 buildHTML / renderMinimal / renderBadges 读取的全部数据源：
//   - 9 张关键表的全 content（行数+列值，含玩法表/检定建议表间接读取）
//   - localStorage 玩法状态 + 物品使用开关
//   - 当前选中角色 _activeChar
//   - 3 个徽章计数
// 签名未变时 render() 跳过全量重建，数据真变化时签名必变。
// 注意：配置字段签名由 index.ts 侧补充（避免此处依赖 config-store）。

/** 渲染签名依赖的数据表清单（与 buildHTML 读取范围一致） */
const RENDER_SIGNATURE_TABLES = [
  '全局数据表',
  '主角信息表',
  '在场角色表',
  '恋爱对象表',
  'NSFW信息表',
  '即时生理反应表',
  '恋爱日记表',
  '玩法表',
  '检定建议表',
  '物品表',
  '瑟瑟任务表',
  '备忘录',
];

/** 计算渲染数据签名（仅含表格数据部分）。
 *  必须在 _allSheetsCache 已填充时调用；缓存为空时返回 null 表示「需强制渲染」。
 *  配置/localStorage/_activeChar/_badge 部分由 index.ts 的 composeRenderSignature 拼接。
 *  O13：结果按修订令牌缓存——(epoch, contentRev) 完全决定表内容（见文件头不变量说明），
 *  令牌未变即返回上次那份字符串，省掉每次渲染把 12 张表全内容重新 join 一遍的开销；
 *  语义与逐次重算逐字节等价（令牌变则重算，不存在陈旧）。 */
export function buildTableDataSignature(): string | null {
  if (!_allSheetsCache) return null;
  const key = `${_sheetsCacheEpoch}|${_sheetsContentRev}`;
  if (_tableSigMemo && _tableSigMemo.key === key) return _tableSigMemo.sig;
  let sig = '';
  for (const tableName of RENDER_SIGNATURE_TABLES) {
    const sheet = _allSheetsCache[tableName];
    if (!sheet || !sheet.content) {
      sig += tableName + ':|;';
      continue;
    }
    // content 是 string[][]，直接 join 即可覆盖行数+列值变化
    sig += tableName + ':' + sheet.content.length + '|' + sheet.content.join('\u0001') + ';';
  }
  _tableSigMemo = { key, sig };
  return sig;
}

export function getInitials(name: string): string {
  return name ? name.charAt(0) : '?';
}

// ===== 数据修改操作 =====
/**
 * 数据库写完成事件：各写助手成功落库后派发（仅成功路径）。
 * index.ts 监听后立即 render()，省去等插件 _notifyTableUpdate 回调的 300ms 节流；
 * 回调到达后的重渲染由渲染签名脏检查早退兜住，不会重复全量重建。
 * 测试桩环境（无 window）静默跳过。
 */
export function emitDbWriteCommitted(): void {
  // U4：统一走 emitUbEvent（事件名登记处 + 一致的非浏览器守卫）
  emitUbEvent(UB_EVENT.dbWriteCommitted);
}

// ===== 写回队列 overlay（内存缓存即真相，flush 后台合并落盘） =====
// 见 core/db-write-queue.ts 与规格 2026-09-01-db-write-back-design.md §5。
// applyOp 幂等：目标行不存在（update/delete）或临时行已存在（insert）时按「已生效」跳过，
// 同一函数在 flush 前 overlay 与 flush 后缓存重建重放两处复用。

function locateRowByRowId(sheet: SheetContent, rowId: number): number {
  const headers = sheet.content[0] || [];
  const rowIdCol = headers.findIndex(isRowIdColumn);
  if (rowIdCol < 0) return -1;
  for (let i = 1; i < sheet.content.length; i++) {
    if (Number(sheet.content[i][rowIdCol]) === rowId) return i;
  }
  return -1;
}

/** 从缓存解析 rowIndex（0=表头）行的稳定 row_id；行不存在返回 null。 */
export function resolveRowIdFromCache(tableName: string, rowIndex: number): number | null {
  const sheet = _allSheetsCache?.[tableName];
  if (!sheet || !sheet.content) return null;
  const headers = sheet.content[0] || [];
  const rowIdCol = headers.findIndex(isRowIdColumn);
  const row = sheet.content[rowIndex];
  if (rowIdCol < 0 || !row) return null;
  const rowId = Number(row[rowIdCol]);
  return Number.isInteger(rowId) && rowId > 0 ? rowId : null;
}

function applyQueueOp(op: DbWriteOpInternal): boolean {
  const sheet = _allSheetsCache?.[op.tableName];
  if (!sheet || !sheet.content?.length) return false;
  _sheetsContentRev += 1; // O13：就地写缓存 → 推进内容修订（宁可多算，绝不错过）
  const headers = sheet.content[0] || [];
  const rowIdCol = headers.findIndex(isRowIdColumn);
  switch (op.kind) {
    case 'updateCell': {
      const colIdx = headers.indexOf(op.colName);
      if (rowIdCol < 0 || colIdx < 0) return false;
      const rowIdx = locateRowByRowId(sheet, op.rowId);
      if (rowIdx < 0) return true; // 行不存在 → 已生效（flush 完成或行被删）
      op.prevCell = sheet.content[rowIdx][colIdx] ?? '';
      sheet.content[rowIdx][colIdx] = op.value;
      return true;
    }
    case 'incrementCell': {
      const colIdx = headers.indexOf(op.colName);
      if (rowIdCol < 0 || colIdx < 0) return false;
      const rowIdx = locateRowByRowId(sheet, op.rowId);
      if (rowIdx < 0) return true; // 行不存在 → 已生效（flush 完成或行被删）
      const cur = sheet.content[rowIdx][colIdx] ?? '';
      op.prevCell = cur;
      sheet.content[rowIdx][colIdx] = String((parseInt(String(cur) || '0', 10) || 0) + (Number(op.delta) || 0));
      return true;
    }
    case 'updateRow': {
      if (rowIdCol < 0) return false;
      const rowIdx = locateRowByRowId(sheet, op.rowId);
      if (rowIdx < 0) return true;
      if (!op.prevRow) op.prevRow = [...sheet.content[rowIdx]];
      for (const [k, v] of Object.entries(op.data)) {
        const colIdx = headers.indexOf(k);
        if (colIdx >= 0) sheet.content[rowIdx][colIdx] = v;
      }
      return true;
    }
    case 'insertRow': {
      // 已应用（重放场景）：按临时负数 row_id 查找
      if (op.overlayRowId != null && rowIdCol >= 0 && locateRowByRowId(sheet, op.overlayRowId) >= 0) return true;
      const row: string[] = headers.map(() => '');
      if (rowIdCol >= 0) row[rowIdCol] = String(op.overlayRowId ?? '');
      for (const [k, v] of Object.entries(op.data)) {
        const colIdx = headers.indexOf(k);
        if (colIdx >= 0) row[colIdx] = v;
      }
      sheet.content.push(row);
      return true;
    }
    case 'deleteRow': {
      if (rowIdCol < 0) return false;
      const rowIdx = locateRowByRowId(sheet, op.rowId);
      if (rowIdx < 0) return true; // 行已不存在 → 已生效
      op.prevRow = [...sheet.content[rowIdx]];
      sheet.content.splice(rowIdx, 1);
      return true;
    }
  }
  return false;
}

function rollbackQueueOp(op: DbWriteOpInternal): void {
  const sheet = _allSheetsCache?.[op.tableName];
  if (!sheet || !sheet.content) return;
  _sheetsContentRev += 1; // O13：回滚亦就地写缓存 → 推进内容修订
  const headers = sheet.content[0] || [];
  const rowIdCol = headers.findIndex(isRowIdColumn);
  switch (op.kind) {
    case 'updateCell': {
      const colIdx = headers.indexOf(op.colName);
      const rowIdx = locateRowByRowId(sheet, op.rowId);
      if (rowIdx >= 0 && colIdx >= 0 && op.prevCell !== undefined) sheet.content[rowIdx][colIdx] = op.prevCell;
      break;
    }
    case 'incrementCell':
    case 'updateRow': {
      const rowIdx = locateRowByRowId(sheet, op.rowId);
      if (op.kind === 'incrementCell') {
        const colIdx = headers.indexOf(op.colName);
        if (rowIdx >= 0 && colIdx >= 0 && op.prevCell !== undefined) sheet.content[rowIdx][colIdx] = op.prevCell;
        break;
      }
      if (rowIdx >= 0 && op.prevRow) sheet.content[rowIdx] = [...op.prevRow];
      break;
    }
    case 'insertRow': {
      if (op.overlayRowId != null && rowIdCol >= 0) {
        const rowIdx = locateRowByRowId(sheet, op.overlayRowId);
        if (rowIdx >= 0) sheet.content.splice(rowIdx, 1);
      }
      break;
    }
    case 'deleteRow': {
      if (op.prevRow && rowIdCol >= 0) {
        // 恢复原行并按 row_id 升序归位（content 顺序约定按 row_id 排列）
        const rowId = Number(op.prevRow[rowIdCol]);
        const insertAt = sheet.content.findIndex((r, i) => i >= 1 && Number(r[rowIdCol]) > rowId);
        sheet.content.splice(insertAt === -1 ? sheet.content.length : insertAt, 0, [...op.prevRow]);
      }
      break;
    }
  }
}

/** 写回队列单例：deps 闭包引用本模块缓存/API，无环。 */
const dbWriteQueue = createDbWriteQueue({
  getApi: getAutoCardAPI,
  sqlTableName,
  sqlColumnName,
  isSqlite: isSqliteMode,
  schemaMap: DB_SCHEMA_MAP,
  applyOp: applyQueueOp,
  rollbackOp: rollbackQueueOp,
  sqlEscape,
  onFlushSuccess: () => {
    // flush 落盘成功：插件内存已含改动；主动通知一次（插件 executeSqlBatch 内部通常已通知，
    // 双保险且经前端 300ms 节流合并，无叠加成本）
    try { getAutoCardAPI()?._notifyTableUpdate?.(); } catch { /* ignore */ }
  },
});

/** 立即排空写回队列（AI 消息入栈前/切卡/pagehide 等屏障时机调用）。 */
export async function flushDbWrites(): Promise<boolean> {
  return dbWriteQueue.flush();
}

/** 队列是否有未落盘批次（屏障/测试用）。 */
export function hasPendingDbWrites(): boolean {
  return dbWriteQueue.hasPending();
}

/**
 * 批量结构化写（一次入队一个批次，flush 时单次 executeSqlBatch 合并落盘）。
 * 仅支持 DB_SCHEMA_MAP 有映射的表；调用点 await 结果 = flush 成败（失败已回滚 overlay），
 * 补偿逻辑（返还等）原样保留。
 */
export function runDbBatch(ops: DbWriteOp[]): Promise<boolean> {
  return dbWriteQueue.enqueue(ops, emitDbWriteCommitted);
}

/** 写助手整体耗时打点（零开销：perf-timing 默认全 no-op，仅 ub_perf_debug=1 时记录）。 */
function withDbWriteTiming<T>(name: string, fn: () => Promise<T>): Promise<T> {
  perfStart(name);
  return fn().finally(() => perfEnd(name));
}

/** 入队路径（有映射表）：overlay 应用后立即派发渲染事件（不等 flush），返回 flush 结果。 */
function enqueueOrLegacy(
  ops: DbWriteOp[],
  legacy: () => Promise<boolean>,
): Promise<boolean> {
  if (!isSqliteMode()) return legacy();
  const allMapped = ops.every(op => hasDbSchemaMapping(op.tableName));
  if (!allMapped) return legacy();
  // enqueue 内部同步应用 overlay，返回的 Promise 在 flush 完成后 settle
  const p = dbWriteQueue.enqueue(ops, emitDbWriteCommitted);
  // overlay 应用失败（enqueue 已 resolve(false) 且未派发事件）时补一次渲染？——
  // 不需要：失败路径调用点会 toast 错误，缓存未变。
  return p;
}

export async function updateCell(tableName: string, rowIndex: number, colName: string, value: string): Promise<boolean> {
  return withDbWriteTiming('db-write:updateCell', async () => {
    if (hasDbSchemaMapping(tableName) && isSqliteMode()) {
      const rowId = resolveRowIdFromCache(tableName, rowIndex);
      if (rowId === null) return false;
      return enqueueOrLegacy([{ kind: 'updateCell', tableName, rowId, colName, value }], async () => false);
    }
    const api = getAutoCardAPI();
    if (!api) return false;
    try {
      const ok = await api.updateCell(resolveTableNameForApi(tableName), rowIndex, colName, value);
      if (ok) {
        invalidateCache();
        emitDbWriteCommitted();
      }
      return ok;
    } catch (e) {
      console.error('updateCell failed:', e);
      return false;
    }
  });
}

/**
 * 原子增量写（并发安全）：`列 = 列 ± N`，由引擎逐行取当前值计算。
 * 用于取代「读当前值→算新值→写绝对值」的读-改-写：两个写者读到同一个旧值时，绝对值写只 +N 一次（丢增量）。
 * 走写回队列（白名单表）或 SQL 直写；增量非幂等，队列失败不重试（见 db-write-queue）。
 */
export async function incrementCell(tableName: string, rowIndex: number, colName: string, delta: number): Promise<boolean> {
  return withDbWriteTiming('db-write:incrementCell', async () => {
    const step = Number(delta);
    if (!Number.isFinite(step) || step === 0) return true; // 无变化不写（省一次 flush）
    if (isSqliteMode()) {
      const rowId = resolveRowIdFromCache(tableName, rowIndex);
      if (rowId === null) return false;
      if (hasDbSchemaMapping(tableName)) {
        return enqueueOrLegacy([{ kind: 'incrementCell', tableName, rowId, colName, delta: step }], async () => false);
      }
      const api0 = getAutoCardAPI();
      const col = sqlColumnName(tableName, colName);
      if (!api0 || typeof api0.executeSqlMutation !== 'function' || !col) return false;
      const table = sqlTableName(tableName);
      const sqlText = `UPDATE ${table} SET ${col} = ${col} ${step >= 0 ? '+' : '-'} ${Math.abs(step)} WHERE row_id = ?`;
      try {
        const result = await api0.executeSqlMutation(sqlText, [rowId]);
        if (!mutationChangedExactlyOneRow(result)) return false;
        invalidateCache();
        emitDbWriteCommitted();
        return true;
      } catch (_e) {
        return false;
      }
    }
    // 非 SQLite 后端（旧数据库插件/测试桩）：原生读-改-写回退——无原子性，但保持「非 SQL 环境可用」的历史语义
    const api = getAutoCardAPI();
    if (!api || typeof api.updateCell !== 'function') return false;
    const cur = parseInt(String(getCellByHeader(tableName, rowIndex, colName) ?? '0'), 10) || 0;
    try {
      const ok = await api.updateCell(resolveTableNameForApi(tableName), rowIndex, colName, String(cur + step));
      if (ok) {
        invalidateCache();
        emitDbWriteCommitted();
      }
      return !!ok;
    } catch (_e) {
      return false;
    }
  });
}

export async function updateRow(tableName: string, rowIndex: number, data: Record<string, string>, skipNotify = false): Promise<boolean> {
  return withDbWriteTiming('db-write:updateRow', async () => {
    if (hasDbSchemaMapping(tableName) && isSqliteMode()) {
      const rowId = resolveRowIdFromCache(tableName, rowIndex);
      if (rowId === null) return false;
      return enqueueOrLegacy([{ kind: 'updateRow', tableName, rowId, data }], async () => false);
    }
    const api = getAutoCardAPI();
    if (!api) return false;
    try {
      const ok = await api.updateRow({ tableName: resolveTableNameForApi(tableName), rowIndex, data, skipNotify });
      if (ok) {
        invalidateCache();
        emitDbWriteCommitted();
      }
      return ok;
    } catch (e) {
      console.error('updateRow failed:', e);
      return false;
    }
  });
}

export async function deleteRow(tableName: string, rowIndex: number): Promise<boolean> {
  return withDbWriteTiming('db-write:deleteRow', async () => {
    if (hasDbSchemaMapping(tableName) && isSqliteMode()) {
      const rowId = resolveRowIdFromCache(tableName, rowIndex);
      if (rowId === null) return false;
      return enqueueOrLegacy([{ kind: 'deleteRow', tableName, rowId }], async () => false);
    }
    const api = getAutoCardAPI();
    if (!api || typeof api.deleteRow !== 'function') return false;
    try {
      const ok = await api.deleteRow(resolveTableNameForApi(tableName), rowIndex);
      if (ok) {
        invalidateCache();
        emitDbWriteCommitted();
      }
      return !!ok;
    } catch (e) {
      console.error('deleteRow failed:', e);
      return false;
    }
  });
}

export async function addRow(tableName: string, data: Record<string, string>): Promise<boolean> {
  return withDbWriteTiming('db-write:addRow', async () => {
    if (hasDbSchemaMapping(tableName) && isSqliteMode()) {
      return enqueueOrLegacy([{ kind: 'insertRow', tableName, data }], async () => false);
    }
    const api = getAutoCardAPI();
    if (!api) return false;
    // 数据库侧（ACU / 台账）只导出 insertRow；不存在 addRow 这个别名。
    const fn = typeof api.insertRow === 'function' ? api.insertRow.bind(api) : null;
    if (!fn) return false;
    try {
      await fn(resolveTableNameForApi(tableName), data);
      invalidateCache();
      emitDbWriteCommitted();
      return true;
    } catch (e) {
      console.error('addRow failed:', e);
      return false;
    }
  });
}

export function getPlayList(
  type: { label: string; colName: string },
  defaultList: string[],
): string[] {
  // 使用缓存避免每次渲染都重建玩法列表
  if (_playListCache && _playListCache[type.colName]) {
    return _playListCache[type.colName];
  }
  const sheet = getSheetByName('玩法表');
  const values = new Set<string>();
  defaultList.forEach(item => values.add(item));
  if (sheet && sheet.content.length >= 2) {
    const headers = sheet.content[0];
    const colIdx = headers.indexOf(type.colName);
    if (colIdx !== -1) {
      for (let i = 1; i < sheet.content.length; i++) {
        const val = sheet.content[i][colIdx];
        if (val && val !== '无' && val !== '') values.add(val);
      }
    }
  }
  const result = Array.from(values);
  if (!_playListCache) _playListCache = {};
  _playListCache[type.colName] = result;
  return result;
}

let _playListCache: Record<string, string[]> | null = null;

// ===== 发送消息到聊天输入框 =====
export function sendMessageToChat(text: string): void {
  const parentDoc = (window.parent as any).document;
  const input = parentDoc.getElementById('send_textarea');
  if (input) {
    const nativeInputValueSetter =
      Object.getOwnPropertyDescriptor((window as any).HTMLTextAreaElement.prototype, 'value')!.set!;
    nativeInputValueSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** 追加到聊天输入框现有文字后（原内容为空时直接填入），不覆盖已有内容。 */
export function appendMessageToChat(text: string): void {
  const parentDoc = (window.parent as any).document;
  const input = parentDoc.getElementById('send_textarea');
  if (!input) return;
  const nativeInputValueSetter =
    Object.getOwnPropertyDescriptor((window as any).HTMLTextAreaElement.prototype, 'value')!.set!;
  const current = String(input.value || '');
  const next = current ? current + '\n' + text : text;
  nativeInputValueSetter.call(input, next);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.selectionStart = next.length;
  input.selectionEnd = next.length;
  input.focus();
}

// ===== 选项栏数据读取 ===== */
export interface OptionBarRow {
  displayText: string;
}

export function getOptionBarItems(): OptionBarRow[] {
  const sheet = getSheetByName('检定建议表');
  if (!sheet || sheet.content.length < 2) return [];

  const headers = sheet.content[0];
  const textCol = headers.indexOf('展示文本');
  if (textCol === -1) return [];

  const items: OptionBarRow[] = [];
  for (let i = 1; i < sheet.content.length; i++) {
    const displayText = (sheet.content[i][textCol] || '').trim();
    if (!displayText) continue;
    items.push({ displayText });
  }
  return items;
}

// ===== 表格锁定 API 封装（数据库原生锁定，按"当前聊天+数据隔离标识"分槽持久化） =====
// rowIndex 沿用 content 数组下标（1-based，content[0]=表头），与 updateRow/deleteRow 一致；
// colIndex 用 headers 数组下标（0-based）。两者基准若与原生 UI 不一致需实测后调整。

/** 原生锁状态结构：rows/cols 为索引数组，cells 为 "row:col" 字符串数组。 */
export interface TableLockState {
  rows: number[];
  cols: number[];
  cells: string[];
}

/** 读取指定表的锁定状态。API 不存在或读取失败时返回 null（调用方视作全表未锁）。 */
export function getTableLockState(sheetKey: string): TableLockState | null {
  const api = getAutoCardAPI();
  if (!api || typeof api.getTableLockState !== 'function') return null;
  try {
    const r = api.getTableLockState(sheetKey);
    if (!r) return null;
    return {
      rows: Array.isArray(r.rows) ? r.rows.filter((n: any) => Number.isInteger(n)) : [],
      cols: Array.isArray(r.cols) ? r.cols.filter((n: any) => Number.isInteger(n)) : [],
      cells: Array.isArray(r.cells) ? r.cells.map((c: any) => String(c)) : [],
    };
  } catch (e) {
    console.error('getTableLockState failed:', e);
    return null;
  }
}

/** 锁/解锁指定行。rowIndex 为 content 数组下标（1-based）。返回原生 API 是否确认成功。 */
export async function setRowLock(sheetKey: string, rowIndex: number, locked: boolean): Promise<boolean> {
  const api = getAutoCardAPI();
  if (!api || typeof api.lockTableRow !== 'function') return false;
  try {
    const ok = await api.lockTableRow(sheetKey, rowIndex, locked);
    return ok === true;
  } catch (e) {
    console.error('lockTableRow failed:', e);
    return false;
  }
}

/** 锁/解锁指定单元格。rowIndex 为 content 下标（1-based），colIndex 为 headers 下标（0-based）。 */
export async function setCellLock(sheetKey: string, rowIndex: number, colIndex: number, locked: boolean): Promise<boolean> {
  const api = getAutoCardAPI();
  if (!api || typeof api.lockTableCell !== 'function') return false;
  try {
    const ok = await api.lockTableCell(sheetKey, rowIndex, colIndex, locked);
    return ok === true;
  } catch (e) {
    console.error('lockTableCell failed:', e);
    return false;
  }
}
