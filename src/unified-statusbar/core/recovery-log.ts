// ===== 恢复日志信封统一出口（U36①·十三轮）=====
// 三个模块（story-write-coordinator / story-deletion-transaction / map-image-reference-gc）此前
// 各自手写同一套「信封格式 {schema, records} + 字节数上限 + 解析校验 + 失败当空」的读写样板，
// 连 RecoveryStorage 接口都各写一份，上限还不一致（512K/512K/64K）。收编为公共小模块：
//   · 上限差异做成参数（各模块原值保持）；
//   · 记录级校验/过滤/裁剪是各模块专属口径，保留在调用方；
//   · 读侧只收编「信封解析」，写侧收编「空删 / 超限拒写 / 失败当假」三步。
import { isRecord } from './type-guards';
import { parseJsonWith } from './safe-json';

export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage 可用性探测（node 测试环境/隐私模式降级 undefined）。 */
export function defaultRecoveryStorage(): RecoveryStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** 信封序列化。 */
export function recoveryEnvelopeJson(schema: number, records: readonly unknown[]): string {
  return JSON.stringify({ schema, records });
}

/** 信封解析：空值/解析失败/schema 不符/records 非数组 → null（记录条目校验归调用方）。 */
export function parseRecoveryEnvelope<T>(raw: string | null, schema: number): T[] | null {
  if (!raw) return null;
  const parsed: unknown = parseJsonWith<unknown>(raw, null);
  if (!isRecord(parsed) || parsed.schema !== schema || !Array.isArray(parsed.records)) return null;
  return parsed.records as T[];
}

/** 信封写入：空记录删键；超 maxRecords/maxBytes 拒写不动旧值；写失败返回 false。 */
export function persistRecoveryEnvelope(
  storage: RecoveryStorage | undefined,
  key: string,
  records: readonly unknown[],
  opts: { schema: number; maxBytes: number; maxRecords?: number },
): boolean {
  if (!storage) return false;
  try {
    if (!records.length) {
      storage.removeItem(key);
      return true;
    }
    if (opts.maxRecords !== undefined && records.length > opts.maxRecords) return false;
    const serialized = recoveryEnvelopeJson(opts.schema, records);
    if (serialized.length > opts.maxBytes) return false;
    storage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}
