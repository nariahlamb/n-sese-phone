// ===== 数据库可视化：纯逻辑（筛选 / 安全分类 / 高亮） =====
// 无 DOM、无 API 依赖，可脱离渲染层独立自检。

import { escapeHtml } from './html-escape'; // U2：转义统一出口

/** 系统表名单：删除需二次确认 + 风险红字。 */
const SYSTEM_TABLES = ['全局数据表', '主角信息表', '检定建议表'] as const;

/** 判定表的安全等级。未知表名默认 'content'（默认放行单次确认）。 */
export function classifyTableSafety(name: string): 'system' | 'content' {
  return (SYSTEM_TABLES as readonly string[]).indexOf(name) >= 0 ? 'system' : 'content';
}

/** 识别 row_id 主键列：SQLite `row_id INTEGER PRIMARY KEY`，由系统 MAX(row_id)+1 自增分配，
 *  用户不可填写/不可修改。headers 里该列名为英文物理名 "row_id"（也可能出现 rowid/中文"行号"）。
 *  新增行时 data 须排除此列，由系统自动分配；编辑时也排除以防误改主键。 */
const ROW_ID_KEYS = new Set(['row_id', 'rowid', '行号']);
export function isRowIdColumn(header: string): boolean {
  const h = String(header == null ? '' : header).trim().toLowerCase();
  return ROW_ID_KEYS.has(h);
}

/** 跨列关键词筛选。
 *  kw 为空（trim 后）→ 返回全部行 idx（content 数组下标，0=首条数据行）。
 *  命中规则：任一列的字符串值（小写）包含 kw（小写）。不区分大小写。 */
export function filterRows(
  rows: string[][],
  _headers: string[],
  kw: string,
): { idx: number[]; hits: number } {
  const k = (kw == null ? '' : String(kw)).trim().toLowerCase();
  if (!k) {
    const all = rows.map(function (_, i) { return i; });
    return { idx: all, hits: rows.length };
  }
  const idx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c] != null ? String(row[c]).toLowerCase() : '';
      if (v.indexOf(k) >= 0) { idx.push(i); break; }   // 命中即收录，跳出该行列扫描
    }
  }
  return { idx, hits: idx.length };
}

/** 在【已 escDb 转义】的文本上高亮命中片段，包 <mark class="db-hit">。
 *  入参 escapedText 必须已经过 HTML 转义；kw 为原始（未转义）关键词。
 *  返回可安全 innerHTML 的字符串。空 kw 原样返回。
 *  注意：转义后 & < > " 变成实体，关键词若含这些字符则不会命中——
 *  这是有意的（防注入），可接受（用户搜这些字符的场景极少）。 */
export function buildHighlight(escapedText: string, kw: string): string {
  const k = (kw == null ? '' : String(kw)).trim();
  if (!k) return escapedText;
  // 关键词本身也需转义后再做匹配，避免关键词里的 < > 破坏 DOM
  // U2：统一出口（实体集 & < > " 与原拼接形态逐字节一致）
  const escKw = escapeHtml(k);
  const lower = escapedText.toLowerCase();
  const lowerK = escKw.toLowerCase();
  if (!lowerK) return escapedText;
  let out = '';
  let i = 0;
  while (i < escapedText.length) {
    const pos = lower.indexOf(lowerK, i);
    if (pos < 0) { out += escapedText.slice(i); break; }
    out += escapedText.slice(i, pos);
    out += '<mark class="db-hit">' + escapedText.slice(pos, pos + escKw.length) + '</mark>';
    i = pos + escKw.length;
  }
  return out;
}

/** 排序方向。 */
export type SortDir = 'asc' | 'desc';

/** 一张表的当前排序状态：col 为列下标（0=首列，通常 row_id）；dir 升/降。 */
export interface DbSortState {
  col: number;
  dir: SortDir;
}

/** 对【已筛选】的行下标数组按指定列+方向排序，返回新下标数组（不改入参 idx/rows）。
 *  - 数值列自动数值比较：当 idx 集合内该列所有「非空」值 Number() 解析为有限数 → 数值比；
 *    否则 localeCompare('zh-Hans') 字符串比。
 *  - 空值（null/undefined/纯空白）恒沉底，不受 dir 影响。
 *  - 稳定：同值保持原 idx 顺序（依赖 Array.sort ES2019+ 稳定性）。
 *  - col 越界（行无该列）视作空值。 */
export function sortRows(
  rows: string[][],
  _headers: string[],
  idx: number[],
  sort: DbSortState,
): number[] {
  const col = sort.col;
  const dir = sort.dir;
  const val = function (i: number): string {
    const r = rows[i] || [];
    const v = r[col];
    return v != null ? String(v) : '';
  };
  // 分区：空值沉底
  const nonEmpty: number[] = [];
  const empty: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const v = val(idx[k]);
    if (v.trim()) nonEmpty.push(idx[k]);
    else empty.push(idx[k]);
  }
  // 数值模式检测：所有非空值 Number() 为有限数
  let numeric = nonEmpty.length > 0;
  for (let k = 0; k < nonEmpty.length; k++) {
    if (!isFinite(Number(val(nonEmpty[k]).trim()))) { numeric = false; break; }
  }
  const sorted = nonEmpty.slice().sort(function (a, b) {
    let cmp: number;
    if (numeric) {
      cmp = Number(val(a).trim()) - Number(val(b).trim());
    } else {
      cmp = String(val(a)).localeCompare(String(val(b)), 'zh-Hans');
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted.concat(empty);
}

// ===== 锁状态纯逻辑查询（无 DOM、无 API 依赖） =====
// 与 data-manager.getTableLockState 返回结构同形；rowIndex 为 content 下标(1-based)，
// colIndex 为 headers 下标(0-based)。基准若与原生 API 不一致需实测后同步调整。
export type LockStateLike = { rows: number[]; cols: number[]; cells: string[] } | null;

/** 该行是否被行锁。 */
export function isRowLocked(lockState: LockStateLike, rowIndex: number): boolean {
  if (!lockState || !Array.isArray(lockState.rows)) return false;
  return lockState.rows.indexOf(rowIndex) >= 0;
}

/** 该单元格是否被锁（行锁时所有单元格视为已锁；否则查 cells 数组的 "row:col" 串）。 */
export function isCellLocked(lockState: LockStateLike, rowIndex: number, colIndex: number): boolean {
  if (!lockState) return false;
  if (isRowLocked(lockState, rowIndex)) return true;
  if (!Array.isArray(lockState.cells)) return false;
  return lockState.cells.indexOf(rowIndex + ':' + colIndex) >= 0;
}

/** 该行是否有任意锁（行锁 or 任意单元格锁）——用于禁用删除/迁移整行。 */
export function hasAnyLock(lockState: LockStateLike, rowIndex: number): boolean {
  if (!lockState) return false;
  if (isRowLocked(lockState, rowIndex)) return true;
  if (!Array.isArray(lockState.cells) || lockState.cells.length === 0) return false;
  const prefix = rowIndex + ':';
  for (let i = 0; i < lockState.cells.length; i++) {
    if (String(lockState.cells[i]).indexOf(prefix) === 0) return true;
  }
  return false;
}
