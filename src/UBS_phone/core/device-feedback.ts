// ===== 设备反馈（唯一出口）：提示音 + 震动 =====
// 纪律与理由：
//  ① **零音频资源**：全部用 WebAudio 现场合成（振荡器 + 增益包络）。不引入任何音频素材文件，
//     产物体积零增长——这是"手机有声音"这件事能立项的前提。
//  ② **全项目只保留一个 AudioContext**：浏览器对同一页面可创建的 AudioContext 数量有上限（约 6 个），
//     而本模块出现前来电铃声与拨号 DTMF 各自 new 了一个（`renderers/app-phone-call.ts` 的 _dtmfCtx）。
//     现在由本模块独占创建入口（`phoneAudioContext()`），铃声/按键音改为取这一份 ⇒ 全局恒为 1 个。
//  ③ **未开启＝零开销**：`soundOn=false` 且 `vibrateOn=false` 时连 AudioContext 都不创建；
//     发声只在触发当刻建极短的振荡器节点，无常驻节点、无定时器、无轮询。
//  ④ **静音（silent）＝不出声**，但**不影响震动、也不影响通知横幅**（真机语义：静音 ≠ 免打扰）。
//  ⑤ 移动端自动播放策略：AudioContext 通常要**先有一次用户交互**才会真正出声（本模块在每次发声前
//     尝试 `resume()` 兜底）。首次点击前无声是平台行为，不是故障——UI 上不做任何"坏掉了"的暗示。

import { getPhoneSettings } from './phone-settings';

/** 反馈种类（唯一枚举，调用方只传这个）。 */
export type PhoneFeedbackKind = 'message' | 'send' | 'shutter' | 'key';

/** 判定入参（由调用方从全局设置取值；纯函数，可单测）。 */
export interface SoundGate {
  /** 提示音总开关。 */
  soundOn: boolean;
  /** 键盘音单独开关（默认关；聊天框每次按键都响容易烦）。 */
  keyboardSound: boolean;
  /** 静音（控制中心）：恒不出声。 */
  silent: boolean;
}

/** 是否应发声：静音恒否；总开关关否；键盘音另看自己的开关。 */
export function shouldPlaySound(kind: PhoneFeedbackKind, gate: SoundGate): boolean {
  if (gate.silent || !gate.soundOn) return false;
  if (kind === 'key' && !gate.keyboardSound) return false;
  return true;
}

/** 是否应震动：**只看震动开关**——静音刻意不影响震动（静音≠免打扰）。 */
export function shouldVibrate(gate: { vibrateOn: boolean }): boolean {
  return gate.vibrateOn === true;
}

// ─── 音频上下文（全项目唯一创建入口） ───

let _ctx: unknown = null;

/** 取共享 AudioContext（首次调用时创建；环境无 WebAudio 或创建失败一律返回 null ⇒ 静默）。
 *  来电铃声/拨号按键音也从这里取，避免出现第二个上下文。 */
export function phoneAudioContext(): any {
  try {
    const w = (typeof window !== 'undefined' ? window : globalThis) as any;
    const AC = w.AudioContext || w.webkitAudioContext;
    if (!AC) return null;
    if (!_ctx) _ctx = new AC();
    const ctx = _ctx as any;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') void ctx.resume().catch(() => undefined);
    return ctx;
  } catch (_e) {
    return null;
  }
}

/** 只读探测已创建的共享 AudioContext（不存在返回 null，**不新建**）。
 *  播放解锁（第八轮 §2）用它判断「需要唤醒吗」——不为检查而凭空造一个上下文。 */
export function peekPhoneAudioContext(): any {
  return _ctx as any;
}

/** 播放一串音符（每步：频率/时长/波形/相对起点延迟）。任何异常静默——声音永远不该弄坏功能。 */
function playNotes(steps: ReadonlyArray<{ freq: number; dur: number; type?: OscillatorType; at?: number }>, volume: number): void {
  try {
    const ctx = phoneAudioContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (const s of steps) {
      const start = t0 + (s.at || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = s.type || 'sine';
      osc.frequency.setValueAtTime(s.freq, start);
      // 起音给 6ms 防爆音，尾音指数衰减到近似无声（与既有 DTMF/铃声同款包络写法）
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + s.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + s.dur + 0.02);
    }
  } catch (_e) { /* 无音频环境/被策略拦截：静默 */ }
}

/** 音色（现场合成）。音量 = 设置档位 × 各音色自身权重。 */
function playSound(kind: PhoneFeedbackKind, volume: number): void {
  const v = Math.min(1, Math.max(0.01, volume));
  switch (kind) {
    case 'message':
      // 两音上行短促提示：清脆、不刺耳
      playNotes([
        { freq: 880, dur: 0.09, at: 0 },
        { freq: 1320, dur: 0.11, at: 0.085 },
      ], 0.05 * v);
      return;
    case 'send':
      // 单音快速下滑（"嗖"）
      playNotes([{ freq: 1180, dur: 0.09 }], 0.035 * v);
      return;
    case 'shutter':
      // 两道极短方波"咔—嚓"
      playNotes([
        { freq: 1900, dur: 0.025, type: 'square' },
        { freq: 1100, dur: 0.03, type: 'square', at: 0.045 },
      ], 0.05 * v);
      return;
    case 'key':
      playNotes([{ freq: 1500, dur: 0.022, type: 'square' }], 0.02 * v);
      return;
    default:
      return;
  }
}

/** 震动时长/节奏（ms）。键盘不给震动（打字时震个不停是负担）。 */
const VIBRATE_MS: Record<PhoneFeedbackKind, number | number[]> = {
  message: [16, 70, 16],
  send: 10,
  shutter: 8,
  key: 0,
};

function vibrate(kind: PhoneFeedbackKind): void {
  try {
    const w = (typeof window !== 'undefined' ? window : globalThis) as any;
    const pattern = VIBRATE_MS[kind];
    if (!pattern || typeof w?.navigator?.vibrate !== 'function') return;
    w.navigator.vibrate(pattern);
  } catch (_e) { /* iOS 无此 API：静默忽略，不做 polyfill */ }
}

/** 统一入口：按当前全局设置判定 → 发声 / 震动。**调用方只需传 kind**（设置在本模块内读一次，
 *  调用点保持一行；未开启时连 AudioContext 都不会创建）。 */
export function feedback(kind: PhoneFeedbackKind): void {
  const s = getPhoneSettings();
  const gate: SoundGate & { vibrateOn: boolean; soundVolume: number } = {
    soundOn: s.soundOn,
    keyboardSound: s.keyboardSound,
    silent: s.silent,
    vibrateOn: s.vibrateOn,
    soundVolume: s.soundVolume,
  };
  if (shouldPlaySound(kind, gate)) playSound(kind, gate.soundVolume);
  if (shouldVibrate(gate) && VIBRATE_MS[kind]) vibrate(kind);
}
