// ===== 数值归一化：钳制工具的「唯一事实源」（U7，零依赖纯模块）=====
//
// 背景：项目里原本有四个名字相近、脾气不同的钳制工具，其中**两个都叫 `clampInt` 却行为不同**
// （story-image-config 的只认 number；cycle-eligibility 的认字符串并走 parseInt）——
// 「同名不同脾气」的真实隐患：同一个配置项在这处填 "5" 生效、在那处静默回退默认。
//
// 本模块把**各种脾气各自命名**并集中实现。刻意**不做统一化改造**（把所有入口都收敛成
// 一种宽松/严格规则属于行为变更，会让既有存档的解析结果变化）；调用点按各自原有脾气迁移，
// 迁移后同一输入产出的结果逐字节等价（见 tests/number-clamp-parity.test.ts 的逐例对照）。
//
// 脾气对照（差异集中在「什么算有效输入」与「怎么取整」）：
//   parseNumericLoose      number 原样；**非空字符串** → Number；其余 → NaN（'' / null / true 都无效）
//   clampIntStrictNumber   只认 number（字符串一律无效）→ Math.floor
//   clampIntNumberTrunc    先 Number() 再 Math.trunc ⇒ ''→0、null→0、true→1、'5abc'→无效
//   clampIntParseInt       number 走 floor，否则 parseInt(…,10) ⇒ '5abc'→5、'0x10'→0、true→无效
//   clampFloat             用 parseNumericLoose，**不取整** ⇒ '5.9'→5.9
//   toIntLoose             用 parseNumericLoose + Math.trunc ⇒ '5.9'→5
//   padNumber              零填充（U11 并入）：时间戳/文件名补零，默认 2 位；与各本地 `pad` 等价

/** 宽松数值解析（**只做解析，不做钳制**）：number 原样；非空字符串 → Number；其余 NaN。 */
export function parseNumericLoose(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/** 严格型：**只接受 number 类型**（字符串、null、布尔一律视为无效）→ 回退 fallback；否则 floor 后钳制到 [min, max]。 */
export function clampIntStrictNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** 宽松型（Number 语义）：`Math.trunc(Number(value))`，非有限值回退 fallback；否则钳制到 [min, max]。 */
export function clampIntNumberTrunc(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** 宽松型（parseInt 语义）：number 走 floor，否则 `parseInt(value, 10)`（`'5abc'`→5）；非有限回退 fallback。 */
export function clampIntParseInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : parseInt(value as string, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 浮点型：用 parseNumericLoose 解析，**不取整**；无效回退 fallback；否则钳制到 [min, max]。 */
export function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const n = parseNumericLoose(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** 取整（不钳制）：用 parseNumericLoose 解析后 Math.trunc；无效回退 fallback。 */
export function toIntLoose(value: unknown, fallback: number): number {
  const n = parseNumericLoose(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 零填充（U11 并入）：`String(value).padStart(size, '0')`，默认 2 位。与各文件本地 `pad` 等价。 */
export function padNumber(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}
