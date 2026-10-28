// ===== 通用类型守卫（U11，零依赖纯模块）=====
//
// 背景：`isRecord` 此前在 **14 个模块**各写一份、实现逐字节相同（storage 全家、story 全家、
// story-write-coordinator 等）——改一处漏十三处；`sameStringArray` 另有 3 份，其中两种签名
// （带/不带 Array.isArray 守卫）。
//
// 本模块是唯一出口。迁移纪律：对既有调用点的真实输入产出**逐字节等价**
// （parity 测试 tests/type-guards-parity.test.ts 把迁移前实现逐字抄进测试当 oracle）。
// ★唯一刻意差异：sameStringArray 统一采用**带守卫**的形态——非数组输入原版会抛 TypeError，
//   新版返回 false。调用点（character-relation-worldbook / wardrobe-worldbook / map-scene-store）
//   传入的 left 均已在调用前判过数组或只可能是数组，故无行为变化。

/** 非 null 且非数组的普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 与 `right` 等长且逐项全等；`left` 非数组时返回 false（原 map-scene-store 版会抛错）。 */
export function sameStringArray(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((v, i) => v === right[i]);
}
