// ===== 物品表写入（网上商城送达入库；docs/52 §7.2 / §9.3）=====
// 与 phone-memo 同一纪律：经 AutoCardUpdaterAPI 对主项目「物品表」做**单条参数化 INSERT**，
// 语句构造对齐主项目 data-manager 的 SQL 试点（row_id 子查询自增 + targetSheetKeys），
// 但**不 import data-manager**（其自带写回队列链，为单条 INSERT 引入整链不值）。
// 物理列映射 = 主项目 SQL_PILOT_TABLES['物品表']（wupinbiao / sheet_inventory）：
//   物品名称→item_name / 类型→item_type / 数量→quantity / 描述→description。
// 仅 SQLite 模式可用；失败分级返回（调用方按「订单保持在途、下次结算重试」处理）。

import { getAutoCardAPI, mutationChangedExactlyOneRow, sqlEscape } from './phone-memo';
import { sqlColumnName, sqlTableName } from '../../unified-statusbar/core/db-schema-map';

/** 物品表逻辑列 → 物理列（对齐主项目 SQL_PILOT_TABLES['物品表']；两处任一改动需同步）。 */
const ITEM_COLUMNS: readonly string[] = ['物品名称', '类型', '数量', '描述'];
const ITEM_TABLE = '物品表';

const ITEM_SHEET_KEY = 'sheet_inventory';

/** 待写入的物品行（键=逻辑列名）。 */
export type ItemRow = Record<string, string>;

export interface PhoneItemInput {
  name: string;
  /** 类型（商品分类；缺省「道具」）。 */
  type: string;
  quantity: number;
  desc: string;
}

/** 输入 → 数据库行。 */
export function itemInputToRow(input: PhoneItemInput): ItemRow {
  const qty = Math.max(1, Math.floor(Number(input.quantity) || 1));
  return {
    '物品名称': String(input.name || '').trim().slice(0, 40),
    '类型': String(input.type || '').trim().slice(0, 20) || '道具',
    '数量': String(qty),
    '描述': String(input.desc || '').trim().slice(0, 200),
  };
}

function buildInsertSql(row: ItemRow): { parameterizedSql: string; params: string[]; batchSql: string } {
  const table = sqlTableName(ITEM_TABLE);
  const columns: string[] = [];
  const params: string[] = [];
  const values: string[] = [];
  for (const header of ITEM_COLUMNS) {
    columns.push(sqlColumnName(ITEM_TABLE, header) ?? header);
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

async function runInsert(row: ItemRow): Promise<boolean> {
  const api = getAutoCardAPI();
  if (!api) return false;
  const stmt = buildInsertSql(row);
  if (typeof api.executeSqlMutation === 'function') {
    try {
      const result = await api.executeSqlMutation(stmt.parameterizedSql, stmt.params, { targetSheetKeys: [ITEM_SHEET_KEY] });
      return mutationChangedExactlyOneRow(result);
    } catch (_e) {
      return false;
    }
  }
  if (typeof api.executeSqlBatch === 'function') {
    try {
      const result = await api.executeSqlBatch({ sql: stmt.batchSql, targetSheetKeys: [ITEM_SHEET_KEY] });
      return result?.success === true;
    } catch (_e) {
      return false;
    }
  }
  return false;
}

export type ItemInsertResult = { ok: true } | { ok: false; error: string };

/** 写入一件商品（送达入库）。失败原因分级返回，调用方据此决定重试与提示。 */
export async function insertPhoneItem(input: PhoneItemInput): Promise<ItemInsertResult> {
  const row = itemInputToRow(input);
  if (!row['物品名称']) return { ok: false, error: '物品名为空' };
  const api = getAutoCardAPI();
  if (!api) return { ok: false, error: '未检测到表格后端（真数据库 / 瑟瑟台账）' };
  if (typeof api.executeSqlMutation !== 'function' && typeof api.executeSqlBatch !== 'function') {
    return { ok: false, error: '表格后端不支持 SQL 写入（真数据库需 SQLite 模式）' };
  }
  if (await runInsert(row)) return { ok: true };
  return { ok: false, error: '写入物品表失败（数据库拒绝）' };
}

/** 入库描述的统一后缀（风格换装；主项目商店用 ' [剧情特卖]'，商城同款标记便于溯源）。 */
export function shopStockTag(style: string): string {
  const name = style === 'xianxia' ? '万宝阁购入'
    : style === 'wuxia' ? '悦来商行购入'
    : style === 'fantasy' ? '奇物商栈购入'
    : '网上商城购入';
  return `[${name}]`;
}
