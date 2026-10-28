// ===== 语音合成管线（把消息/说话人 → 播放计划；复刻生图的 pending→ready 思路，轻量版） =====
// 职责：解析「这条语音该用什么后端/音色/参考音频/缓存 key」，并负责预合成（只入缓存不播放）。
// 播放本身在 core/voice-tts；本模块不碰 DOM。

import { getPhoneSettings, savePhoneSettings } from './phone-settings';
import { getRoster, findContact, type RosterSnapshot } from './roster';
import { resolveRoleVoice, bucketGenderOf, type RoleVoicePick } from './voice-mapping';
import { resolveProvider } from './voice-providers';
import { voiceCacheKey, fnv1a } from './voice-cache';
import {
  resolveVoiceBackend, voicePoolFor, prewarmVoice, resolveVoiceProviderConfig, resolveComfyUrl, type VoiceBackend,
} from './voice-tts';

export interface VoicePlan {
  backend: VoiceBackend;
  text: string;
  cacheKey: string;
  voiceId: string;
  /** 本句实际使用的服务商（角色可指定厂商；api 后端用；system='system'）。 */
  providerId: string;
  refAudio: string;
  speed: number;
  /** 情绪（规范中文八词之一；api 后端按服务商改写，进缓存 key）。 */
  emotion: string;
  /** 可选演绎说明（40 字上限裕量；按服务商改写或丢弃）。 */
  delivery: string;
  /** 窥私失真（调用方决定是否传 true）。 */
  muffle: boolean;
  /** 发送方显示名（第八轮 §1：缓存元数据「角色」，录音机列表显示用）。 */
  role: string;
}

/** 名字 → 该用哪份档案（纯函数，便于单测）：通讯录精确/唯一子串命中 → 主角 → 无。
 *  主角（「我」/主角信息表姓名）此前从没被语音侧消费过（`protagonist.gender` 只给生图提示词用），
 *  于是我方台词被当成「性别未知」在全池里抽签（docs/38 §1 关卡 1）。
 *  自定义联系人（`customContacts` 只是名字数组，没有性别列）仍会落到 null ⇒ 全池抽签，
 *  只能靠设置页「角色音色」手动指定来钉住。 */
export function contactSourceFor(
  roster: RosterSnapshot,
  name: string,
): { gender?: string; age?: string; languageStyle?: string } | null {
  const hit = findContact(roster, name);
  if (hit) return hit;
  if (name === '我' || (!!roster.protagonistName && name === roster.protagonistName)) {
    return { gender: roster.protagonist.gender, age: roster.protagonist.age };
  }
  return null;
}

/** 取角色的档案（性别/年龄/语气）用于自动配音；找不到/读不到返回 null。 */
function contactFor(name: string): { gender?: string; age?: string; languageStyle?: string } | null {
  try {
    return contactSourceFor(getRoster(), name);
  } catch (_e) {
    return null;
  }
}

/** 把「本次自动决定的音色」钉住（voiceAutoPick）：同一角色+渠道+分桶性别只写一次。
 *  钉住之后池子怎么变（拉取音色列表 / 手填新音色 / 换池序）都不再让同一角色换声；
 *  手动覆盖、以及命中已钉住的值都不写。写失败静默——钉住是稳定性优化，不该弄坏本次播放。 */
function pinAutoVoice(
  name: string,
  pick: RoleVoicePick | null,
  contact: { gender?: string } | null,
): void {
  if (!pick?.auto || !pick.voiceId || !name) return;
  try {
    const s = getPhoneSettings() as any;
    const cur = (s.voiceAutoPick || {})[name];
    if (cur && cur.p === pick.providerId && cur.v === pick.voiceId) return;
    const gender = bucketGenderOf(contact);
    void savePhoneSettings({ voiceAutoPick: { ...(s.voiceAutoPick || {}), [name]: { p: pick.providerId, v: pick.voiceId, g: gender } } });
  } catch (_e) { /* ignore */ }
}

/** 解析角色音色（覆盖→钉住→自动→默认；含指定服务商；comfy/off 返回 null）。 */
export function resolveSenderVoicePlan(name: string): RoleVoicePick | null {
  const backend = resolveVoiceBackend();
  if (backend === 'off' || backend === 'comfy') return null;
  const s = getPhoneSettings() as any;
  const globalProvider = resolveProvider(s.voiceProvider).id;
  const scope = backend === 'system' ? 'system' : 'api';
  const contact = contactFor(name);
  const pick = resolveRoleVoice({
    name,
    backend,
    globalProvider,
    overrides: (s.voiceMap || {})[scope] || {},
    roleProvider: s.voiceRoleProvider || {},
    autoPick: s.voiceAutoPick || {},
    poolFor: (pid: string) => voicePoolFor(backend, pid),
    autoAssign: s.voiceAutoAssign !== false,
    contact,
  });
  pinAutoVoice(name, pick, contact);
  return pick;
}

/** 兼容旧调用点：只取音色 id（不带服务商）。 */
export function resolveSenderVoice(name: string, backend: VoiceBackend): string {
  if (backend === 'off' || backend === 'comfy') return '';
  const pick = resolveSenderVoicePlan(name);
  return pick ? pick.voiceId : '';
}

/** 取角色参考音频文件名（ComfyUI input/；空=用工作流内置默认）。 */
export function voiceRefAudioFor(name: string): string {
  const s = getPhoneSettings() as any;
  return String(s.voiceRefAudio?.[name] || '');
}

/** comfy 缓存变体指纹：地址 + 工作流 + 参考音频（任一变化即换 key，不会命中旧工作流的音频）。 */
function comfyVariantOf(refAudio: string): string {
  try {
    const comfy = (getPhoneSettings() as any).voiceComfy || {};
    return fnv1a(`${resolveComfyUrl(comfy)}\u0002${String(comfy.workflow || '')}\u0002${refAudio}`);
  } catch (_e) {
    return fnv1a(refAudio);
  }
}

/** api 缓存指纹：模型 + 输出格式（按指定服务商取；读不到时留空，不影响正确性）。 */
function apiFingerprint(providerId: string): { model: string; format: string } {
  try {
    const c = resolveVoiceProviderConfig(providerId);
    return { model: c.model, format: c.format };
  } catch (_e) {
    return { model: '', format: '' };
  }
}

/** 试听用覆盖：临时指定「服务商 + 音色」，只影响这一条播放计划与它的缓存 key，**不落库、不改设置**。
 *  资料卡快速换音色面板里挑一个**还没选中**的音色试听时用它（选了才写 voiceMap）。 */
export interface VoicePlanOverride {
  providerId?: string;
  voiceId: string;
}

/** 组装播放计划；后端 off / 文本空 → null（调用方走原假动画兜底）。
 *  cacheKey 覆盖「服务商 / 模型 / 输出格式 / ComfyUI 工作流 / 参考音频 / 情绪 / 演绎」——换任一参数都会重新合成。
 *  第 5 参 override 缺省 ⇒ 与改造前逐字节相同（按角色解析出来的音色走）。 */
export function voicePlanFor(text: string, senderName: string, emotion = '', delivery = '', override?: VoicePlanOverride): VoicePlan | null {
  const backend = resolveVoiceBackend();
  const t = String(text || '').trim();
  if (backend === 'off' || !t) return null;
  const s = getPhoneSettings() as any;
  const speed = Number(s.voiceSpeed) || 1;
  const pick = resolveSenderVoicePlan(senderName);
  const providerId = backend === 'system' ? 'system' : (override?.providerId || pick?.providerId || resolveProvider(s.voiceProvider).id);
  const voiceId = override ? override.voiceId : (pick?.voiceId || '');
  const refAudio = backend === 'comfy' ? voiceRefAudioFor(senderName) : '';
  const fp = backend === 'api' ? apiFingerprint(providerId) : { model: '', format: '' };
  const emo = s.voiceEmotion === false ? '' : String(emotion || '');
  const dev = s.voiceEmotion === false ? '' : String(delivery || '');
  const cacheKey = voiceCacheKey({
    backend,
    provider: backend === 'api' ? providerId : '',
    voiceId: voiceId || '',
    speed,
    emotion: emo,
    delivery: dev,
    model: fp.model,
    format: fp.format,
    variant: backend === 'comfy' ? comfyVariantOf(refAudio) : '',
    text: t,
  });
  return { backend, text: t, cacheKey, voiceId, providerId, refAudio, speed, emotion: emo, delivery: dev, muffle: false, role: String(senderName || '') };
}

/** 一条可预合成的语音（文本 + 发送方 + 可选情绪/演绎）。 */
export interface VoiceWarmItem {
  text: string;
  sender: string;
  emotion?: string;
  delivery?: string;
}

/** 预合成闸门（warmRecentVoices / prewarmNeighbors 同一套）：仅 api/comfy 后端 + voicePreGen 未关。
 *  闸门关闭 ⇒ 零请求（用户关掉开关就是不要预合成）。 */
function prewarmGateOpen(): boolean {
  const backend = resolveVoiceBackend();
  if (backend !== 'api' && backend !== 'comfy') return false;
  try {
    return (getPhoneSettings() as any).voicePreGen !== false;
  } catch (_e) {
    return false;
  }
}

/** 预合成最近若干条语音（仅 api/comfy + voicePreGen；串行、限量、失败静默）。 */
export function warmRecentVoices(
  items: ReadonlyArray<VoiceWarmItem>,
  limit = 3,
): void {
  if (!prewarmGateOpen()) return;
  const seen = new Set<string>();
  const jobs: VoicePlan[] = [];
  for (let i = items.length - 1; i >= 0 && jobs.length < limit; i--) {
    const it = items[i];
    const plan = voicePlanFor(it.text, it.sender, it.emotion, it.delivery);
    if (!plan || seen.has(plan.cacheKey)) continue;
    seen.add(plan.cacheKey);
    jobs.push(plan);
  }
  if (!jobs.length) return;
  void (async () => {
    for (const plan of jobs.reverse()) await prewarmVoice(plan);
  })();
}

/** 播放序列槽位：null = 非语音/不可播（占位保持下标与消息/行序列一一对应）。 */
export type VoiceWarmSlot = VoiceWarmItem | null;

/** 从槽位里挑相邻预取项（纯函数，便于单测）：dirs 顺序=优先级，每方向向外找**最近一条**可预取项，
 *  总量封顶 limit（默认 2 = 下一条 + 上一条）。越界/空表/全 null 返回空数组。 */
export function pickNeighborSlots(
  slots: ReadonlyArray<VoiceWarmSlot>,
  currentIndex: number,
  dirs: ReadonlyArray<'next' | 'prev'> = ['next', 'prev'],
  limit = 2,
): VoiceWarmItem[] {
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= slots.length) return [];
  const picked: VoiceWarmItem[] = [];
  for (const dir of dirs) {
    if (picked.length >= limit) break;
    const step = dir === 'next' ? 1 : -1;
    for (let i = currentIndex + step; i >= 0 && i < slots.length; i += step) {
      const it = slots[i];
      if (!it) continue; // 非语音/不可播：继续向外找最近的一条
      picked.push(it);
      break;
    }
  }
  return picked;
}

/** 相邻预取（第八轮 §2 · T8-① 用户理解版）：播放当前条时，顺手把「下一条优先、再上一条」的
 *  语音预合成进缓存——下一次点击即缓存命中，不重合成、不卡顿。
 *  - 槽位数组与消息/行序列**同下标**（非语音填 null），`currentIndex` 指向正在播的那条；
 *  - 选取见 pickNeighborSlots；闸门同 warmRecentVoices（api/comfy + voicePreGen；关掉=零请求）；
 *  - 串行、静默、不阻塞播放；不做整会话预取、不碰缓存上限——预取产物与按需合成同一份缓存/同一套 LRU。
 *  返回实际发起的预合成条数（0 = 闸门关/无相邻；契约测试用）。 */
export function prewarmNeighbors(
  slots: ReadonlyArray<VoiceWarmSlot>,
  currentIndex: number,
  dirs: ReadonlyArray<'next' | 'prev'> = ['next', 'prev'],
  limit = 2,
): number {
  if (!prewarmGateOpen()) return 0;
  const picked = pickNeighborSlots(slots, currentIndex, dirs, limit);
  if (!picked.length) return 0;
  const seenKeys = new Set<string>();
  const jobs: VoicePlan[] = [];
  for (const it of picked) {
    const plan = voicePlanFor(it.text, it.sender, it.emotion, it.delivery);
    if (!plan || seenKeys.has(plan.cacheKey)) continue; // 同一段音频（复用 plan）不重复预取
    seenKeys.add(plan.cacheKey);
    jobs.push(plan);
  }
  if (!jobs.length) return 0;
  void (async () => {
    for (const plan of jobs) await prewarmVoice(plan);
  })();
  return jobs.length;
}
