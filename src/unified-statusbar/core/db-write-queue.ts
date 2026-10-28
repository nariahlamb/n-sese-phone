// ===== 数据库写回队列（前端即时反馈 + 后台合并落盘） =====
// 设计（docs/superpowers/specs/2026-09-01-db-write-back-design.md §5）：
//   - 写助手把结构化操作入队：同步应用 overlay 到内存缓存（读路径零改动即时生效），
//     同时登记待写批次；防抖窗口（默认 300ms）内合并为单次 executeSqlBatch 落盘。
//   - 插件回调重建缓存时（invalidateCache → buildSheetCache），data-manager 调用
//     replayPendingOverlay() 把未确认批次重放回新缓存，防止「乐观值→flush 完成」间闪回旧值。
//   - flush 失败：重试有界（纯 UPDATE/DELETE 批次重试 3 次；含 INSERT 批次不重试——
//     INSERT OR IGNORE 无唯一约束时重复执行会插重复行），穷尽后整批回滚 overlay 并 resolve(false)，
//     调用点既有补偿逻辑（返还能量等）原样执行。
//   - 本模块零依赖（不 import data-manager，避免环），依赖经 deps 注入，便于测试桩。
import type { DbSchemaTable } from './db-schema-map';

export type DbWriteOp =
  | { kind: 'updateCell'; tableName: string; rowId: number; colName: string; value: string }
  /** 原子增量写：`列 = 列 ± N`（逐行取当前值计算；替代「读当前值→算新值→写绝对值」的读-改-写，防并发丢增量）。 */
  | { kind: 'incrementCell'; tableName: string; rowId: number; colName: string; delta: number }
  | { kind: 'updateRow'; tableName: string; rowId: number; data: Record<string, string> }
  | { kind: 'insertRow'; tableName: string; data: Record<string, string> }
  | { kind: 'deleteRow'; tableName: string; rowId: number };

/** 队列内部附加字段（token=批次内唯一序；prev*=回滚用变更前值）。 */
export type DbWriteOpInternal = DbWriteOp & {
  token: number;
  prevCell?: string;               // updateCell/updateRow 单值回滚
  prevRow?: string[] | null;       // deleteRow 回滚（含 row_id 的整行）
  overlayRowId?: number;           // insertRow 的临时负数 row_id（重放去重用）
};

interface PendingBatch {
  ops: DbWriteOpInternal[];
  resolve: (ok: boolean) => void;
}

export interface DbWriteQueueDeps {
  getApi(): any;
  isSqlite(): boolean;
  schemaMap: Record<string, DbSchemaTable>;
  /** SQL 用的表名（台账后端＝中文原名；真数据库后端＝物理名）。 */
  sqlTableName(tableName: string): string;
  /** SQL 用的列名（同上）；null = 该列不支持 SQL 写（真数据库无映射列）。 */
  sqlColumnName(tableName: string, column: string): string | null;
  /** 把 op 应用到内存缓存（幂等：update/delete 目标行不存在或 insert 行已存在时跳过）。 */
  applyOp(op: DbWriteOpInternal): boolean;
  /** 回滚 op 对缓存的影响（flush 失败整批恢复）。 */
  rollbackOp(op: DbWriteOpInternal): void;
  sqlEscape(s: string): string;
  /** flush 成功后回调（如触发插件侧通知）。 */
  onFlushSuccess?(sql: string): void;
}

export interface DbWriteQueue {
  /** 入队并同步应用 overlay；onApplied 在 overlay 全部应用成功后同步调用（用于立即触发渲染）。返回 flush 完成后 settle 的 Promise。 */
  enqueue(ops: DbWriteOp[], onApplied?: () => void): Promise<boolean>;
  flush(): Promise<boolean>;
  hasPending(): boolean;
  replayPendingOverlay(): void;
  pendingCount(): number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const MAX_RETRIES = 3;

export function createDbWriteQueue(deps: DbWriteQueueDeps, debounceMs = DEFAULT_DEBOUNCE_MS): DbWriteQueue {
  let _seq = 0;
  let _batches: PendingBatch[] = [];
  let _timer: ReturnType<typeof setTimeout> | null = null;
  let _flushing: Promise<boolean> | null = null;

  function isBatchRetryable(ops: DbWriteOpInternal[]): boolean {
    // incrementCell 不可重试：批次「部分应用后报失败」时重试会重复累加（相对表达式非幂等）
    return ops.every(op => op.kind !== 'insertRow' && op.kind !== 'incrementCell');
  }

  function buildSql(ops: DbWriteOpInternal[]): string[] {
    const stmts: string[] = [];
    for (const op of ops) {
      const t = deps.schemaMap[op.tableName];
      if (!t) return [];
      // 表/列名交给 deps 解析：台账后端给中文原名，真数据库后端翻成物理名
      const table = deps.sqlTableName(op.tableName);
      switch (op.kind) {
        case 'updateCell': {
          const col = deps.sqlColumnName(op.tableName, op.colName);
          if (!col) return [];
          stmts.push(`UPDATE ${table} SET ${col} = '${deps.sqlEscape(op.value)}' WHERE row_id = ${op.rowId}`);
          break;
        }
        case 'incrementCell': {
          const col = deps.sqlColumnName(op.tableName, op.colName);
          if (!col) return [];
          const abs = Math.abs(Number(op.delta) || 0);
          stmts.push(`UPDATE ${table} SET ${col} = ${col} ${op.delta >= 0 ? '+' : '-'} ${abs} WHERE row_id = ${op.rowId}`);
          break;
        }
        case 'updateRow': {
          const sets: string[] = [];
          for (const [k, v] of Object.entries(op.data)) {
            const col = deps.sqlColumnName(op.tableName, k);
            if (col) sets.push(`${col} = '${deps.sqlEscape(v)}'`);
          }
          if (sets.length === 0) return [];
          stmts.push(`UPDATE ${table} SET ${sets.join(', ')} WHERE row_id = ${op.rowId}`);
          break;
        }
        case 'insertRow': {
          const cols: string[] = [];
          const vals: string[] = [];
          for (const [k, v] of Object.entries(op.data)) {
            const col = deps.sqlColumnName(op.tableName, k);
            if (col) {
              cols.push(col);
              vals.push(`'${deps.sqlEscape(v)}'`);
            }
          }
          if (cols.length === 0) return [];
          stmts.push(
            `INSERT OR IGNORE INTO ${table} (row_id, ${cols.join(', ')}) ` +
            `VALUES ((SELECT COALESCE(MAX(row_id), 0) + 1 FROM ${table}), ${vals.join(', ')})`,
          );
          break;
        }
        case 'deleteRow':
          stmts.push(`DELETE FROM ${table} WHERE row_id = ${op.rowId}`);
          break;
      }
    }
    return stmts;
  }

  function scheduleFlush(): void {
    if (_timer !== null) clearTimeout(_timer);
    _timer = setTimeout(() => {
      _timer = null;
      void doFlush();
    }, debounceMs);
  }

  async function doFlush(): Promise<boolean> {
    // 顺序敏感（必须「先判在飞」）：旧写法先判 _batches 为空就直接 resolve(true)。
    // 定时器触发的 flush 在 executeSqlBatch 在飞时已把 _batches 快照成空 ⇒ 此刻任何
    // flush()（切卡屏障走的正是这条路径）都会立刻返回 true，屏障形同虚设——
    // 按旧卡 row_id 寻址的批次尚未落盘，新卡初始化已经开始。先判在飞才能让屏障等到它 settle。
    if (_flushing) return _flushing;
    if (_batches.length === 0) return true;
    _flushing = (async () => {
      const batches = _batches;
      _batches = [];
      const ops = batches.flatMap(b => b.ops);
      const stmts = buildSql(ops);
      if (stmts.length === 0) {
        // 映射缺失等构造失败：视为失败（不应发生——入队时已校验映射）
        for (const b of batches) b.resolve(false);
        return false;
      }
      const sql = stmts.join(';\n');
      const api = deps.getApi();
      if (!api || typeof api.executeSqlBatch !== 'function') {
        for (const b of batches) b.resolve(false);
        return false;
      }
      const retries = isBatchRetryable(ops) ? MAX_RETRIES : 0;
      let ok = false;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const r = await api.executeSqlBatch({ sql });
          if (r && r.success) {
            ok = true;
            break;
          }
          if (attempt < retries) {
            await new Promise<void>(res => setTimeout(res, 50 * (attempt + 1)));
          }
        } catch (_e) {
          if (attempt < retries) {
            await new Promise<void>(res => setTimeout(res, 50 * (attempt + 1)));
          }
        }
      }
      if (ok) {
        try { deps.onFlushSuccess?.(sql); } catch { /* ignore */ }
        for (const b of batches) b.resolve(true);
        // flush 成功后防抖窗口内又有新入队 → 重排定时器
        if (_batches.length > 0) scheduleFlush();
        return true;
      }
      // 失败：整批回滚 overlay（逆序恢复），调用点补偿逻辑经 resolve(false) 触发
      for (const b of batches) {
        for (let i = b.ops.length - 1; i >= 0; i--) {
          try { deps.rollbackOp(b.ops[i]); } catch { /* ignore */ }
        }
        b.resolve(false);
      }
      return false;
    })();
    try {
      return await _flushing;
    } finally {
      _flushing = null;
      // 在飞期间新入队、且其定时器已被本次 flush() 的「清定时器」步骤清掉的批次必须重排：
      // 旧写法只在成功分支重排，失败 / 映射构造失败路径会让这些批次无限搁浅（既无定时器也无重试）。
      if (_batches.length > 0 && _timer === null) scheduleFlush();
    }
  }

  return {
    enqueue(ops: DbWriteOp[], onApplied?: () => void): Promise<boolean> {
      if (!deps.isSqlite()) return Promise.resolve(false);
      if (!Array.isArray(ops) || ops.length === 0) return Promise.resolve(true);
      // 入队前校验：全部 op 的表有映射（无映射表写助手本就不会入队）
      for (const op of ops) {
        if (!deps.schemaMap[op.tableName]) return Promise.resolve(false);
      }
      return new Promise<boolean>(resolve => {
        const internal: DbWriteOpInternal[] = ops.map(op => {
          const token = ++_seq;
          const out: DbWriteOpInternal = { ...op, token };
          if (op.kind === 'insertRow') out.overlayRowId = -token;
          return out;
        });
        // 同步应用 overlay（读路径立即看到新值）；任一 op 应用失败（目标行不存在）→ 整批放弃
        for (const op of internal) {
          try {
            if (!deps.applyOp(op)) {
              for (const applied of internal) {
                if (applied === op) break;
                try { deps.rollbackOp(applied); } catch { /* ignore */ }
              }
              resolve(false);
              return;
            }
          } catch (_e) {
            for (const applied of internal) {
              if (applied === op) break;
              try { deps.rollbackOp(applied); } catch { /* ignore */ }
            }
            resolve(false);
            return;
          }
        }
        try { onApplied?.(); } catch { /* ignore */ }
        _batches.push({ ops: internal, resolve });
        scheduleFlush();
      });
    },

    flush(): Promise<boolean> {
      if (_timer !== null) {
        clearTimeout(_timer);
        _timer = null;
      }
      // 屏障语义 = 「排空」：若已有一批在飞，先等它 settle，再排空期间新入队的批次
      // （旧写法两处都可能提前返回 true：_batches 空判在前、且不追新入队的批次）。
      const pending = _flushing;
      if (!pending) return doFlush();
      return pending.then(() => doFlush(), () => doFlush());
    },

    hasPending(): boolean {
      return _batches.length > 0;
    },

    replayPendingOverlay(): void {
      for (const b of _batches) {
        for (const op of b.ops) {
          try { deps.applyOp(op); } catch { /* ignore */ }
        }
      }
    },

    pendingCount(): number {
      return _batches.length;
    },
  };
}
