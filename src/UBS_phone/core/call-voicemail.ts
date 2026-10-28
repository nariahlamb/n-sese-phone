// ===== 语音留言编排（T1）：未接/拒接来电后的 AI 补留 =====
// 闸门 = 语音总开关 && 通话逐句朗读（voiceReadCalls，默认关 ⇒ 零开销：不发起任何请求）。
// 数据写链在本模块（core 层）：生成（call-engine.generateVoicemail）→ 落库 calls[].voicemail。
// 通知/跨模块事件由调用方发射（index.ts / app-phone-call）——core 不 import renderers
// （phone-album 同款纪律）；聊天归属守卫照 social-engine 先例（发起时记快照，落盘前比对）。

import { generateVoicemail } from './call-engine';
import type { CallLine } from './call-model';
import { getPhoneSettings } from './phone-settings';
import { currentPhoneStorageId, mutatePhoneData, readPhoneDataRef } from './phone-store';
import type { VoicemailScene } from './call-prompts';

/** 闸门：语音总开关 + 通话逐句朗读（与逐句重听/连播同一开关，见 app-phone-call.callReplayEnabled）。 */
export function voicemailEnabled(): boolean {
  const s = getPhoneSettings();
  return s.voiceEnabled === true && s.voiceReadCalls === true;
}

/** 同一条记录同一时刻只生成一次（并发去重；完成后释放——失败可通过再次场景触发重试）。 */
const _pending = new Set<string>();

export interface VoicemailOutcome {
  ok: boolean;
  recordId: string;
  peerName: string;
  scene: VoicemailScene;
  /** 未生成的原因（ok=false 时）：gate/not-found/exists/pending/empty/stale/error。 */
  reason?: string;
}

/**
 * 生成并落库一条语音留言（fire-and-forget 调用方式：调用方 void + then 决定通知）。
 * 不抛出——任何失败返回 { ok:false, reason }，调用方静默即可（留言是增值层，绝不打扰主流程）。
 */
export async function scheduleVoicemail(args: {
  recordId: string;
  peerName: string;
  scene: VoicemailScene;
}): Promise<VoicemailOutcome> {
  const base: VoicemailOutcome = { ok: false, recordId: args.recordId, peerName: args.peerName, scene: args.scene };
  if (!voicemailEnabled()) return { ...base, reason: 'gate' };
  if (!args.recordId || !args.peerName.trim()) return { ...base, reason: 'not-found' };
  // 前置只读检查：记录不存在 / 已有留言 / 正在生成 ⇒ 不重复（readPhoneDataRef 零拷贝守卫）。
  const rec = (readPhoneDataRef().calls || []).find(c => c.id === args.recordId);
  if (!rec) return { ...base, reason: 'not-found' };
  if (rec.voicemail?.length) return { ...base, reason: 'exists' };
  if (_pending.has(args.recordId)) return { ...base, reason: 'pending' };
  _pending.add(args.recordId);
  const owner = currentPhoneStorageId(); // 聊天归属守卫：发起时快照
  try {
    const res = await generateVoicemail({ peerName: args.peerName, scene: args.scene });
    if (!res.lines.length) return { ...base, reason: 'empty' };
    if (currentPhoneStorageId() !== owner) return { ...base, reason: 'stale' }; // 已切聊天：整轮丢弃（不写库不通知）
    let saved = false;
    mutatePhoneData(d => {
      const target = (d.calls || []).find(c => c.id === args.recordId);
      if (!target) return;
      // 记录终态复核：只给「仍未接听/被拒」的记录留留言（接听了/被回拨改写 ⇒ 丢弃）
      if (target.status !== 'missed' && target.status !== 'rejected') return;
      if (target.voicemail?.length) return; // 落库竞争兜底
      target.voicemail = res.lines.map((l: CallLine) => ({ ...l }));
      saved = true;
    });
    return saved ? { ...base, ok: true } : { ...base, reason: 'stale' };
  } catch (_e) {
    return { ...base, reason: 'error' };
  } finally {
    _pending.delete(args.recordId);
  }
}
