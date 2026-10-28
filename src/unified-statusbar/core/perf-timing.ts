// 零开销性能打点：仅当 setPerfDebug(true) 时记录耗时，默认全 no-op（一次布尔判断）。
// 由 index.ts 初始化时按 localStorage['ub_perf_debug']==='1' 开启；供 Phase 0 基线与每期对比。
interface PerfRecord { count: number; total: number; last: number; max: number; }
let _debug = false;
const _marks: Record<string, number> = {};
const _log: Record<string, PerfRecord> = {};

export function setPerfDebug(v: boolean): void { _debug = v; }

/** 标记一次操作的开始（重复调用覆盖起点）。 */
export function perfStart(name: string): void {
  if (!_debug) return;
  _marks[name] = performance.now();
}

/** 结束一次操作并累计；每 60 次打点输出一次汇总（console.log 便于采集）。 */
export function perfEnd(name: string): void {
  if (!_debug) return;
  const start = _marks[name];
  if (start == null) return;
  const dur = performance.now() - start;
  let rec = _log[name];
  if (!rec) { rec = _log[name] = { count: 0, total: 0, last: 0, max: 0 }; }
  rec.count++; rec.total += dur; rec.last = dur; if (dur > rec.max) rec.max = dur;
  if (rec.count % 60 === 0) {
    // eslint-disable-next-line no-console
    console.log(`[ub-perf] ${name} avg=${(rec.total / rec.count).toFixed(2)}ms last=${dur.toFixed(2)}ms max=${rec.max.toFixed(2)}ms count=${rec.count}`);
  }
}

/** 立即输出全部累计统计（供采集结束手动 dump）。 */
export function perfDump(): void {
  if (!_debug) return;
  for (const [name, rec] of Object.entries(_log)) {
    // eslint-disable-next-line no-console
    console.log(`[ub-perf] ${name} avg=${(rec.total / rec.count).toFixed(2)}ms last=${rec.last.toFixed(2)}ms max=${rec.max.toFixed(2)}ms count=${rec.count}`);
  }
}

/** 重置打点与统计（重复采集前调用）。 */
export function perfReset(): void {
  for (const k of Object.keys(_marks)) delete _marks[k];
  for (const k of Object.keys(_log)) delete _log[k];
}

/** 暴露内部统计供测试断言；关闭时返回空对象。 */
export function perfStats(): Record<string, PerfRecord> {
  return _debug ? { ..._log } : {};
}
