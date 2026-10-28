// ===== 锁屏计时（纯判定 + 设备本地键名）=====
// 用户口径：**收起手机 ≠ 自动上锁**；只有「折叠后经过设定时长」再展开才进锁屏，展开即重置计时。
// 性能红线（用户点名）：**一个定时器都不用**——
//   · 收起时写一次时间戳（localStorage，一次写）；
//   · 展开时读一次并与当前时刻比较（一次读）；
//   · 展开后立刻清掉时间戳（＝重置计时）。
// 全程无 setInterval/setTimeout、无轮询、无重绘；开关关闭时连时间戳都不写（零开销）。
// 用 localStorage 而不是模块变量：页面在"折叠状态"下刷新后计时仍然成立（跨刷新一致）。

/** 折叠时刻的存储键（带版本后缀，与 ubp_ball_pos_v2 / ubp_dock_pin_v1 同款惯例）。 */
export const LOCK_SINCE_KEY = 'ubp_lock_since_v1';

export interface LockGate {
  /** 锁屏开关（默认关＝现状零变化）。 */
  enabled: boolean;
  /** 收起时刻（ms）；从未收起过/已清空 = null。 */
  since: number | null;
  /** 当前时刻（ms）。 */
  now: number;
  /** 等待时长（ms）。 */
  delayMs: number;
}

/** 本次展开是否应先进锁屏。 */
export function shouldLockOnOpen(gate: LockGate): boolean {
  if (gate.enabled !== true) return false;
  if (typeof gate.since !== 'number' || !Number.isFinite(gate.since)) return false;
  return gate.now - gate.since >= gate.delayMs;
}
