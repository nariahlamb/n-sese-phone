// ===== 角色音色映射（纯逻辑，可单测） =====
// 解析顺序：手动覆盖 → 自动分配（按性别分桶 + hash(名字) 稳定选）→ 全局默认。
// comfy 后端不用音色池（用每角色参考音频），voiceFor 返回 ''，由工作流自身的默认 LoadAudio 兜底。

import { fnv1a } from './voice-cache';

export type VoiceGender = 'f' | 'm' | 'n';

export interface VoiceOption {
  /** 后端音色 id（system=voice.name；api=厂商 voice 字段）。 */
  id: string;
  /** 展示名。 */
  label: string;
  gender: VoiceGender;
  /** 次要说明（拉取时带出的标签/描述），仅用于「挑音色」弹窗里帮选；不落库、不参与解析。 */
  desc?: string;
}

/** 内置 API 音色目录（按厂商分组；用户可用 voiceApiVoices 手工补充）。 */
export const API_VOICE_CATALOGS: Record<string, readonly VoiceOption[]> = {
  // 硅基流动 CosyVoice2（voice = `<model>:<speaker>`）
  siliconflow: [
    { id: 'FunAudioLLM/CosyVoice2-0.5B:alex', label: 'Alex 男', gender: 'm' },
    { id: 'FunAudioLLM/CosyVoice2-0.5B:benjamin', label: 'Benjamin 男', gender: 'm' },
    { id: 'FunAudioLLM/CosyVoice2-0.5B:charles', label: 'Charles 男', gender: 'm' },
    { id: 'FunAudioLLM/CosyVoice2-0.5B:david', label: 'David 男', gender: 'm' },
    { id: 'FunAudioLLM/CosyVoice2-0.5B:anna', label: 'Anna 女', gender: 'f' },
    { id: 'FunAudioLLM/CosyVoice2-0.5B:bella', label: 'Bella 女', gender: 'f' },
    { id: 'FunAudioLLM/CosyVoice2-0.5B:claire', label: 'Claire 女', gender: 'f' },
    { id: 'FunAudioLLM/CosyVoice2-0.5B:diana', label: 'Diana 女', gender: 'f' },
  ],
  // OpenAI tts
  openai: [
    { id: 'alloy', label: 'Alloy', gender: 'n' },
    { id: 'echo', label: 'Echo', gender: 'm' },
    { id: 'fable', label: 'Fable', gender: 'n' },
    { id: 'onyx', label: 'Onyx 男（低沉）', gender: 'm' },
    { id: 'nova', label: 'Nova 女（明亮）', gender: 'f' },
    { id: 'shimmer', label: 'Shimmer 女', gender: 'f' },
    { id: 'coral', label: 'Coral 女', gender: 'f' },
    { id: 'sage', label: 'Sage', gender: 'n' },
  ],
};

/** 手填音色解析：每行/逗号一项，支持 `id` 或 `id|展示名` 或 `id|展示名|f|m|n`。 */
export function parseVoiceList(text: string): VoiceOption[] {
  const out: VoiceOption[] = [];
  for (const raw of String(text || '').split(/[\n,，]/)) {
    const item = raw.trim();
    if (!item) continue;
    const segs = item.split('|').map(s => s.trim());
    const id = segs[0];
    if (!id) continue;
    const label = segs[1] || id;
    const g = segs[2];
    const gender: VoiceGender = g === 'f' || g === 'm' ? g : 'n';
    if (!out.some(o => o.id === id)) out.push({ id, label, gender });
  }
  return out;
}

/** 性别归一：中文/英文/常见写法 → 'f' | 'm' | 'n'。 */
export function normalizeGender(raw: unknown): VoiceGender {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'n';
  if (/^(f|female|女|女性|母)/.test(s)) return 'f';
  if (/^(m|male|男|男性|公)/.test(s)) return 'm';
  if (s.includes('女')) return 'f';
  if (s.includes('男')) return 'm';
  if (s.includes('female') || s.includes('woman') || s.includes('girl')) return 'f';
  if (s.includes('male') || s.includes('man') || s.includes('boy')) return 'm';
  return 'n';
}

/** 从音色池按角色自动挑一个：性别分桶 → hash(名字) 稳定索引（同角色恒定，不随机漂移）。 */
export function autoVoiceFor(
  name: string,
  contact: { gender?: string; age?: string; languageStyle?: string } | null,
  pool: readonly VoiceOption[],
): string {
  if (!pool.length) return '';
  const g = normalizeGender(contact?.gender);
  let bucket = g === 'n' ? pool.slice() : pool.filter(o => o.gender === g);
  if (!bucket.length) bucket = pool.slice();
  const idx = parseInt(fnv1a(String(name || '')), 16) % bucket.length;
  return bucket[idx].id;
}

export interface VoiceResolveArgs {
  name: string;
  backend: string;
  pool: readonly VoiceOption[];
  /** 手动覆盖（按后端分开存；api/system 各一份）。 */
  overrides: Partial<Record<'system' | 'api', Record<string, string>>>;
  autoAssign: boolean;
  contact?: { gender?: string; age?: string; languageStyle?: string } | null;
}

/** 音色解析三段：覆盖 → 自动 → 池首默认。comfy 直接返回 ''（走参考音频）。 */
export function voiceFor(args: VoiceResolveArgs): string {
  if (args.backend === 'comfy' || args.backend === 'off') return '';
  const scope = args.backend === 'system' ? 'system' : 'api';
  const override = args.overrides?.[scope]?.[args.name];
  if (override && args.pool.some(o => o.id === override)) return override;
  if (override) return override; // 覆盖的音色不在池内（手填）也照用
  if (args.autoAssign) {
    const auto = autoVoiceFor(args.name, args.contact || null, args.pool);
    if (auto) return auto;
  }
  return args.pool[0]?.id || '';
}

// ─── 角色 →（服务商 + 音色）解析（支持「不同角色来自不同厂商」）───

export interface RoleVoicePick {
  /** 'system' 或某服务商 id（openai / minimax / …）。 */
  providerId: string;
  /** 该服务商命名空间下的音色 id（可能为空＝用请求构造的兜底）。 */
  voiceId: string;
  /** true = 本次是**自动决定**的结果（自动分配或池首兜底）⇒ 调用方应落库钉住（voiceAutoPick）。
   *  手动覆盖、以及命中已钉住的旧值时为 false（没有新东西要写）。 */
  auto?: boolean;
}

/** 自动分配结果的钉住条目（phone-settings.voiceAutoPick）。 */
export interface AutoVoicePin {
  /** 钉住时的服务商 id（换渠道即作废——别把别家音色 id 发过去）。 */
  p?: string;
  /** 钉住的音色 id。 */
  v?: string;
  /** 钉住时的分桶性别（'f'|'m'|'n'）。档案性别后来补上/改变 ⇒ 作废重算（这才是「跟随档案」）。 */
  g?: string;
}

export interface ResolveRoleVoiceArgs {
  name: string;
  backend: string;
  /** 全局默认服务商（角色未指定时跟随它）。 */
  globalProvider: string;
  /** 该后端的角色音色覆盖（api → voiceMap.api；system → voiceMap.system）。 */
  overrides: Record<string, string>;
  /** 角色 → 指定服务商（voiceRoleProvider；缺省＝跟随全局）。 */
  roleProvider: Record<string, string>;
  /** 角色 → 已钉住的自动结果（voiceAutoPick；命中且仍有效 ⇒ 直接复用，不再重算哈希索引）。 */
  autoPick?: Record<string, AutoVoicePin>;
  /** 给定服务商 id → 它的音色池（由调用方按 provider 解析）。 */
  poolFor: (providerId: string) => VoiceOption[];
  autoAssign: boolean;
  contact?: { gender?: string; age?: string; languageStyle?: string } | null;
}

/** 分桶性别（钉住指纹用；与 autoVoiceFor 的分桶口径同一处取值）。 */
export function bucketGenderOf(contact: { gender?: string } | null | undefined): VoiceGender {
  return normalizeGender(contact?.gender);
}

/**
 * 已钉住的自动音色是否仍有效。
 * 有效性 = 同渠道 + 同分桶性别 + 音色仍在池内；池为空时无从校验 ⇒ 作废（空池本就没有可漂移的音色）。
 * **刻意不校验「池子构成」**：拉取音色列表 / 手填新音色都不该让同一个角色换声——这正是钉住要解决的问题。
 */
export function pinnedAutoVoiceFor(
  name: string,
  autoPick: Record<string, AutoVoicePin> | undefined,
  providerId: string,
  pool: readonly VoiceOption[],
  gender: VoiceGender,
): string {
  const pinned = autoPick?.[name];
  const v = String(pinned?.v || '').trim();
  if (!v) return '';
  if (String(pinned?.p || '') !== providerId) return '';
  if (String(pinned?.g || '') !== gender) return '';
  if (!pool.length) return '';
  return pool.some(o => o.id === v) ? v : '';
}

/**
 * 「跟随自动」在给定渠道下会落到哪个音色（设置页「角色音色」与资料卡快速换音色面板**共用这一支**，
 * 免得两处各算一套、池子变了两个界面对不上）。顺位与 resolveRoleVoice 一致：
 * 已钉住且仍有效的结果 → 自动分配（性别分桶 + 名字哈希）→ 池首；空池返回 ''。
 */
export function autoVoiceOf(
  name: string,
  providerId: string,
  pool: readonly VoiceOption[],
  autoPick: Record<string, AutoVoicePin> | undefined,
  gender: VoiceGender,
  autoAssign: boolean,
): string {
  const pinned = pinnedAutoVoiceFor(name, autoPick, providerId, pool, gender);
  if (pinned) return pinned;
  if (autoAssign) return autoVoiceFor(name, { gender }, pool) || '';
  return pool[0]?.id || '';
}

/**
 * 解析一个角色的「服务商 + 音色」。
 * 顺位：角色指定服务商（否则全局）→ 手动覆盖 → **已钉住的自动结果** → 自动分配 → 池首。
 * off / comfy 返回 null（comfy 走参考音频，不选音色）。
 */
export function resolveRoleVoice(args: ResolveRoleVoiceArgs): RoleVoicePick | null {
  if (args.backend === 'off' || args.backend === 'comfy') return null;
  const explicit = roleProviderFor(args.name, args.roleProvider);
  const providerId = args.backend === 'system' ? 'system' : (explicit || args.globalProvider);
  const pool = args.poolFor(providerId);
  const override = args.overrides?.[args.name];
  // 覆盖值校验：池内当然可用；**池为空**时无从校验（火山豆包 / 本地引擎 / 自定义没有公开音色列表，
  // 用户只能手填）——此时照用，否则手填永远不生效。池非空却不在池内 = 换服务商后的遗留值，忽略（否则会 400）。
  if (override && (!pool.length || pool.some(o => o.id === override))) return { providerId, voiceId: override };
  const gender = bucketGenderOf(args.contact);
  const pinned = pinnedAutoVoiceFor(args.name, args.autoPick, providerId, pool, gender);
  if (pinned) return { providerId, voiceId: pinned };
  if (args.autoAssign) {
    const auto = autoVoiceFor(args.name, args.contact || null, pool);
    if (auto) return { providerId, voiceId: auto, auto: true };
  }
  const head = pool[0]?.id || '';
  return head ? { providerId, voiceId: head, auto: true } : { providerId, voiceId: '' };
}

/** 角色指定服务商（供 UI 渲染/校验用；空＝跟随全局）。 */
export function roleProviderFor(name: string, roleProvider: Record<string, string>): string {
  return String(roleProvider?.[name] || '').trim();
}
