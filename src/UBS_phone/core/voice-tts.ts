// ===== TTS 语音合成与播放（唯一出口；同 device-feedback 的纪律） =====
// 三后端：
//   system —— 浏览器 speechSynthesis（零配置、离线、免费；无字节 ⇒ 不进缓存/不进失真滤镜/时长靠估）
//   api    —— OpenAI 兼容 POST /v1/audio/speech（直连 → 酒馆 /proxy/ → 可读报错 三级回退）
//   comfy  —— 本地 ComfyUI 音频工作流（声音克隆，见 voice-comfy.ts）
// 纪律：
//   ① 后端 off ⇒ 零开销：不建 AudioContext、不开 IndexedDB、不碰 speechSynthesis、无监听。
//   ② 全项目仍只保留一个 AudioContext（窥私失真滤镜复用 phoneAudioContext()）。
//   ③ 无常驻定时器：进度靠 <audio> 事件 / utterance onboundary；停止即清。
//   ④ 播放一律由用户点击触发（自动播放策略；系统 TTS 亦需一次手势，非故障）。

import { getPhoneSettings } from './phone-settings';
import { getConfig } from './host-config';
import { hostWindow, phoneNotify } from './host-env';
import { phoneAudioContext, peekPhoneAudioContext } from './device-feedback';
import { voiceCacheGet, voiceCachePut, voiceCachePrune, voiceCacheStats, type VoiceCacheEntry } from './voice-cache';
import type { VoiceOption } from './voice-mapping';
import { resolveProvider, providerVoices, secondCredentialLabel, resolveVoiceFilters, type VoiceProviderPreset } from './voice-providers';
import { buildVoiceRequest, decodeVoiceResponse, type VoiceCredential } from './voice-requests';
import { fetchProviderVoices } from './voice-catalog';
import { parseVoiceWorkflow, isApiFormatWorkflow, injectVoiceWorkflow, submitComfyAudioWorkflow, decodeAudioDurationMs } from './voice-comfy';

export type VoiceBackend = 'off' | 'system' | 'api' | 'comfy';
export type VoicePlayState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface VoiceHandle {
  stop(): void;
  pause(): void;
  resume(): void;
  setRate(rate: number): void;
}

const NOOP_HANDLE: VoiceHandle = { stop() {}, pause() {}, resume() {}, setRate() {} };

// ─── 后端 / 配置解析 ───

export function resolveVoiceBackend(): VoiceBackend {
  const s = getPhoneSettings();
  // 总开关先手：关闭即 off（旧版用后端下拉的「关闭」当总开关，语义等价）。
  // 这样所有播放/预合成/试听路径在关闭时天然 no-op——「播放按钮自动失效」在模型层成立。
  if (s.voiceEnabled !== true) return 'off';
  const b = (s as any).voiceBackend;
  return b === 'system' || b === 'api' || b === 'comfy' ? b : 'off';
}

export interface VoiceApiConfig { url: string; key: string; model: string; format: 'mp3' | 'wav'; }

/** 当前服务商预设 + 该家凭据 + 解析后的最终值（缓存指纹 / 请求 / UI 预览共用）。 */
export interface VoiceProviderConfig {
  provider: VoiceProviderPreset;
  cred: VoiceCredential;
  url: string;
  key: string;
  appId: string;
  accessKey: string;
  model: string;
  format: 'mp3' | 'wav';
  resourceId: string;
}

/** 解析服务商与凭据：地址/模型留空则回落到服务商预填。
 *  传 providerId 时用该家（按角色指定厂商用），否则用全局 `voiceProvider`。 */
export function resolveVoiceProviderConfig(providerId?: string): VoiceProviderConfig {
  const s = getPhoneSettings() as any;
  const picked = String(providerId || '').trim();
  const provider = resolveProvider(picked || s.voiceProvider);
  const cred: VoiceCredential = { ...(s.voiceCredentials?.[provider.id] || {}) };
  const url = String(cred.url || '').trim() || provider.baseUrl;
  const format: 'mp3' | 'wav' = cred.format === 'wav' || cred.format === 'mp3' ? cred.format : provider.format;
  return {
    provider,
    cred,
    url,
    key: String(cred.key || ''),
    appId: String(cred.appId || ''),
    accessKey: String(cred.accessKey || ''),
    model: String(cred.model || provider.models[0] || ''),
    format,
    resourceId: String(cred.resourceId || provider.extra?.resourceId || ''),
  };
}

/** 合成前的凭据校验：缺关键字段时抛可读错误（由 UI 兜）。
 *  `appIdOptional` 的家（火山豆包）另有「只填 Key」一档——新版控制台不发 AppID，
 *  此时 AppID 留空不算错，凭据改走 URL 参数（请求头写法被 CORS 白名单拦住，见 docs/62）；
 *  但**密钥不能空**，且缺密钥时要一次说清两套取法，别让新版控制台用户以为无解。 */
export function assertVoiceCredentials(
  provider: VoiceProviderPreset,
  cred: { appId: string; accessKey: string; key: string },
): void {
  const appId = String(cred.appId || '').trim();
  const secret = String(cred.accessKey || cred.key || '').trim();
  if (provider.auth === 'key') {
    if (!String(cred.key || '').trim()) throw new Error(`请先填 ${provider.name} 的密钥（设置 → 功能 → 语音）`);
    return;
  }
  if (provider.auth !== 'appid') return;
  if (secret && (appId || provider.appIdOptional)) return;
  if (provider.appIdOptional) {
    throw new Error(`${provider.name} 需要密钥：旧版控制台填 AppID + ${secondCredentialLabel(provider)}，`
      + `或新版控制台只填 API Key（AppID 留空）（设置 → 功能 → 语音）`);
  }
  throw new Error(`${provider.name} 需要 AppID 与${secondCredentialLabel(provider)}（设置 → 功能 → 语音）`);
}

/** 兼容旧调用点（缓存指纹）：从服务商配置取 OpenAI 形状的四件。 */
export function resolveVoiceApiConfig(): VoiceApiConfig {
  const c = resolveVoiceProviderConfig();
  return { url: c.url, key: c.key, model: c.model, format: c.format };
}

/** 当前后端可用的音色池（system 从 getVoices 动态取；api 走指定/当前服务商音色池 + 手填 + 按家目录；comfy 空）。 */
export function voicePoolFor(backend: VoiceBackend, providerId?: string): VoiceOption[] {
  if (backend === 'system') return systemVoices();
  if (backend === 'api') {
    const s = getPhoneSettings() as any;
    const provider = resolveProvider(String(providerId || '').trim() || s.voiceProvider);
    const catalog = String(s.voiceCatalog?.[provider.id] || '');
    // 全局手填只并入「全局服务商」，避免串到别的家。
    const globalId = resolveProvider(s.voiceProvider).id;
    const manual = provider.id === globalId ? String(s.voiceApiVoices || '') : '';
    return providerVoices(provider, manual, catalog);
  }
  return [];
}

/** 一页音色拉取结果（含下一页游标）。 */
export interface VoiceProviderListPage {
  options: VoiceOption[];
  next?: string;
}

/** 拉取指定（默认全局）服务商的音色列表**一页**（next 供「再拉一页」继续透传）。
 *  filters 缺省时用该家已存的筛选条件（voiceFetchFilters）兜底，与设置页所见一致。 */
export async function listProviderVoicesPage(
  providerId?: string,
  filters?: Readonly<Record<string, string>>,
  page?: string,
): Promise<VoiceProviderListPage> {
  const picked = String(providerId || '').trim();
  const cfg = resolveVoiceProviderConfig(picked || undefined);
  const s = getPhoneSettings() as any;
  const applied = filters
    || resolveVoiceFilters(cfg.provider.id, (s.voiceFetchFilters || {})[cfg.provider.id]);
  return fetchProviderVoices(cfg.provider.id, { key: cfg.key, appId: cfg.appId }, cfg.url, applied, page);
}

/** 兼容旧口径：只要第一页的选项数组。 */
export async function listProviderVoices(
  providerId?: string,
  filters?: Readonly<Record<string, string>>,
): Promise<VoiceOption[]> {
  return (await listProviderVoicesPage(providerId, filters)).options;
}

// ─── 系统 TTS ───

/** 播放前显式唤醒已存在的共享 AudioContext（第八轮 §2 · P1-6）：
 *  窥私失真滤镜链与提示音都走这一份上下文——被浏览器挂起时它们会静默无声。
 *  不新建上下文（纯 <audio> 播放与系统 TTS 不依赖它）；`resume()` 用 250ms 兜底竞速，
 *  任何情况都不让播放被「唤醒」卡住（挂起时最多多等 250ms，失败照常往下播）。 */
async function wakePhoneAudio(): Promise<void> {
  try {
    const ctx = peekPhoneAudioContext();
    if (!ctx || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
    await Promise.race([
      Promise.resolve(ctx.resume()).catch(() => undefined),
      new Promise<void>(resolve => { setTimeout(resolve, 250); }),
    ]);
  } catch (_e) { /* 唤醒失败：按原样继续播放（原有拦截提示兜底不变） */ }
}

interface SysVoice { name: string; lang: string; }

function speechSynthesis(): any {
  try {
    const w = hostWindow() as any;
    const synth = w?.speechSynthesis || (typeof window !== 'undefined' ? (window as any).speechSynthesis : null);
    return synth && typeof synth.speak === 'function' ? synth : null;
  } catch (_e) {
    return null;
  }
}

/** 系统音色快照：**首个非空结果即冻结**（本次会话内不再变化）。
 *  为什么必须冻结：`getVoices()` 在 `voiceschanged` 之前返回空数组，且不同时刻可能给出不同列表——
 *  池子一变，`hash(名字) % bucket.length` 选出的索引就跟着变，同一通电话里前后句会换成不同音色
 *  （用户报的「同一通话中时男时女」，docs/38 §2）。空列表不缓存（等浏览器就绪后下次调用再取）。
 *  代价：会话中途新装的系统音色要刷新页面才可见——远小于「同一角色换声」的困扰。 */
let _sysVoices: VoiceOption[] | null = null;

/** 系统音色列表（中文优先排序；冻结口径见 `_sysVoices`）。 */
export function systemVoices(): VoiceOption[] {
  if (_sysVoices?.length) return _sysVoices;
  const synth = speechSynthesis();
  if (!synth || typeof synth.getVoices !== 'function') return [];
  let list: SysVoice[] = [];
  try { list = synth.getVoices() || []; } catch (_e) { list = []; }
  const zh = list.filter(v => /^zh/i.test(String(v.lang || '')));
  const pick = zh.length ? zh : list;
  const mapped = pick.map(v => ({ id: v.name, label: `${v.name}（${v.lang}）`, gender: guessVoiceGender(v.name) }));
  if (mapped.length) _sysVoices = mapped;
  return mapped;
}

/** 清系统音色快照（测试用；也为将来「刷新音色列表」类入口留口）。 */
export function resetSystemVoiceCache(): void {
  _sysVoices = null;
}

function guessVoiceGender(name: string): 'f' | 'm' | 'n' {
  const n = String(name || '');
  if (/kangkang|yunxi|yunyang|yunjian|male|男|M1|M2/i.test(n)) return 'm';
  if (/huihui|xiaoxiao|xiaoyi|yaoyao|xiaohan|xiaomeng|female|女|F1|F2/i.test(n)) return 'f';
  return 'n';
}

/** 注册系统音色就绪回调（voiceschanged）；返回解除函数。未启用后端时零成本。 */
export function onSystemVoicesReady(cb: () => void): () => void {
  const synth = speechSynthesis();
  if (!synth || typeof synth.addEventListener !== 'function') return () => undefined;
  const handler = () => cb();
  try {
    synth.addEventListener('voiceschanged', handler);
  } catch (_e) {
    return () => undefined;
  }
  return () => { try { synth.removeEventListener('voiceschanged', handler); } catch (_e) { /* ignore */ } };
}

/** 系统 TTS 长文分块（Chromium 超长 utterance 会截断；抄酒馆官方 160 字口径）。 */
export function splitForSystem(text: string, maxLen = 160): string[] {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];
  const out: string[] = [];
  const sentences = t.split(/(?<=[。！？!?；;…\n])/);
  let buf = '';
  for (const seg of sentences) {
    if ((buf + seg).length > maxLen && buf) { out.push(buf); buf = ''; }
    if (seg.length > maxLen) {
      for (let i = 0; i < seg.length; i += maxLen) out.push(seg.slice(i, i + maxLen));
    } else {
      buf += seg;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 时长估算（系统 TTS 无真实时长；按 ~4 字/秒）。 */
export function estimateSeconds(text: string): number {
  const n = String(text || '').replace(/\s/g, '').length;
  return Math.min(60, Math.max(1, Math.round(n / 4)));
}

interface SpeakCallbacks {
  onStart?: () => void;
  onProgress?: (ratio: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

/** 系统 TTS 播放（分块串行；onboundary 驱动进度）。返回句柄可停止/暂停。 */
export function speakSystem(text: string, voiceId: string, rate: number, cb: SpeakCallbacks): VoiceHandle {
  const synth = speechSynthesis();
  if (!synth) { cb.onError?.('当前环境不支持系统语音合成'); return NOOP_HANDLE; }
  const w = hostWindow() as any;
  const Utter = w?.SpeechSynthesisUtterance;
  if (typeof Utter !== 'function') { cb.onError?.('当前环境不支持系统语音合成'); return NOOP_HANDLE; }
  const chunks = splitForSystem(text);
  if (!chunks.length) { cb.onEnd?.(); return NOOP_HANDLE; }
  const total = chunks.reduce((s, c) => s + c.length, 0) || 1;
  let done = 0;
  let idx = 0;
  let stopped = false;
  let paused = false;

  const speakNext = () => {
    if (stopped) return;
    if (idx >= chunks.length) { cb.onEnd?.(); return; }
    const chunk = chunks[idx];
    const u = new Utter(chunk);
    u.rate = Math.min(2, Math.max(0.5, rate || 1));
    if (voiceId) {
      try {
        const match = (synth.getVoices() || []).find((v: any) => v.name === voiceId);
        if (match) u.voice = match;
      } catch (_e) { /* ignore */ }
    }
    const base = done;
    u.onstart = () => { if (idx === 0) cb.onStart?.(); };
    u.onboundary = (ev: any) => {
      const charIndex = Number(ev?.charIndex) || 0;
      cb.onProgress?.(Math.min(1, (base + charIndex) / total));
    };
    u.onend = () => { done = base + chunk.length; idx += 1; cb.onProgress?.(Math.min(1, done / total)); speakNext(); };
    u.onerror = () => { cb.onError?.('系统语音合成出错'); };
    try { synth.speak(u); } catch (_e) { cb.onError?.('系统语音合成失败'); }
  };
  try { synth.cancel(); } catch (_e) { /* ignore */ }
  // 播放解锁（第八轮 §2）：上下文已存在且被挂起时先唤醒再开口；未挂起/无上下文则同步直走（不变）
  const ctx = peekPhoneAudioContext();
  if (ctx && ctx.state === 'suspended') void wakePhoneAudio().then(() => speakNext());
  else speakNext();

  return {
    stop() { stopped = true; try { synth.cancel(); } catch (_e) { /* ignore */ } },
    pause() { paused = true; try { synth.pause(); } catch (_e) { /* ignore */ } },
    resume() { if (paused) { paused = false; try { synth.resume(); } catch (_e) { /* ignore */ } } },
    setRate() { /* 系统 TTS 逐块 rate 固定；改速需重播 */ },
  };
}

// ─── API（OpenAI 兼容 /v1/audio/speech） ───

function stRequestHeaders(): Record<string, string> {
  try {
    const w = hostWindow() as any;
    const st = w?.SillyTavern || (typeof window !== 'undefined' ? (window as any).SillyTavern : null);
    const ctx = st && typeof st.getContext === 'function' ? st.getContext() : st;
    if (ctx && typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
  } catch (_e) { /* ignore */ }
  return {};
}

// ─── 错误可读化 + 脱敏（对齐 ST-iPhonie providers.js 的口径） ───

/** 常见服务端错误码 → 中文指引（OpenAI 兼容 / 主流中转站通用）。 */
const TTS_CODE_REASONS: Record<string, string> = {
  invalid_api_key: '密钥无效：请重新完整复制密钥（注意不要带空格或引号）',
  invalid_key: '密钥无效：请重新完整复制密钥',
  missing_api_key: '没有带上密钥：请在「设置 → 功能 → 语音」重新填写',
  insufficient_quota: '额度用完了：请到服务商后台充值或换一个密钥',
  quota_exceeded: '额度用完了',
  insufficient_credits: '额度用完了',
  billing_hard_limit_reached: '账户达到额度上限',
  rate_limit_exceeded: '请求太频繁：稍等一会儿再试',
  model_not_found: '找不到这个模型：检查「模型」一项是否填写正确',
  voice_not_found: '找不到这个音色：检查音色 ID，或换一个音色',
  invalid_voice: '音色 ID 无效：请重新选择或填写音色',
  text_too_long: '这段文本太长了：请缩短台词',
  context_length_exceeded: '这段文本太长了：请缩短台词',
};

/** HTTP 状态 → 中文兜底话术。 */
const TTS_HTTP_FALLBACK: Record<number, string> = {
  400: '请求里有服务不接受的内容（模型、音色或参数可能不对）',
  401: '密钥没有通过验证：请在「设置 → 功能 → 语音」重新填写密钥',
  402: '额度不足或需要付费档',
  403: '这个密钥没有该操作的权限（也可能是中转站拒绝）',
  404: '接口地址不对：确认它指向合成接口（OpenAI 兼容为 /v1/audio/speech）',
  422: '请求里有服务不接受的内容',
  429: '请求太频繁：稍等一会儿再试',
  500: '语音服务自己出错了：稍后再试',
  502: '语音服务网关出错：稍后再试',
  503: '语音服务暂时不可用：稍后再试',
};

/** 从响应体里抽取服务端的错误码与原文（兼容 OpenAI 兼容 / 厂商自研字段）。 */
function parseTtsErrorBody(bodyText: string): { code: string; message: string } {
  const text = String(bodyText || '').trim();
  if (!text) return { code: '', message: '' };
  try {
    const json = JSON.parse(text) as any;
    // header 层是火山豆包的错误信封：{"header":{"code":45000010,"message":"…"}}
    const err = json?.error ?? json?.detail ?? json?.base_resp ?? json?.header ?? json;
    const code = String(err?.code ?? err?.type ?? err?.status_code ?? json?.code ?? '').trim();
    const message = String(
      typeof err === 'string' ? err : err?.message ?? err?.status_msg ?? json?.message ?? '',
    ).trim();
    return { code, message };
  } catch (_e) {
    return { code: '', message: text };
  }
}

/** 脱敏：抹掉已知密钥与像密钥的长串，再截断（错误信息不进日志也要不回显密钥）。 */
export function sanitizeTtsDetail(text: string, secrets: ReadonlyArray<string> = []): string {
  let out = String(text || '');
  for (const s of secrets) {
    const key = String(s || '').trim();
    if (key.length >= 6) out = out.split(key).join('***');
  }
  out = out.replace(/[A-Za-z0-9_-]{24,}/g, t => (/\d/.test(t) && /[A-Za-z]/.test(t) ? '***' : t));
  return out.slice(0, 300);
}

/** 把一次失败的 HTTP 响应写成可读、脱敏的错误文案。 */
export function ttsHttpError(status: number, bodyText: string, secrets: ReadonlyArray<string> = []): string {
  const { code, message } = parseTtsErrorBody(bodyText);
  const reason = (code && TTS_CODE_REASONS[code]) || TTS_HTTP_FALLBACK[status] || '请求失败';
  const said = sanitizeTtsDetail([code, message].filter(Boolean).join('：'), secrets);
  return `TTS 接口 HTTP ${status} · ${reason}${said ? `（${said}）` : ''}`;
}

interface TtsRawResponse { bytes: Uint8Array; contentType: string; }

/** 这些方言的请求里**没有音色 id** 时，服务端会自己挑一个默认音色（往往每次不同 ⇒ 用起来就是
 *  「音色钉不住」）。同一家每次会话只提示一次，避免每句都弹。 */
export const VOICE_REQUIRED_DIALECTS: ReadonlyArray<string> = ['fish', 'minimax', 'volcengine'];
const _voiceMissingWarned = new Set<string>();

function warnIfVoiceMissing(provider: { id: string; name: string; dialect: string }, voiceId: string): void {
  if (!VOICE_REQUIRED_DIALECTS.includes(provider.dialect)) return;
  if (String(voiceId || '').trim()) return;
  if (_voiceMissingWarned.has(provider.id)) return;
  _voiceMissingWarned.add(provider.id);
  try {
    phoneNotify(`未指定音色：服务端会用默认音色，可能每次不同。到「设置 → 语音 → 角色音色」拉取或手填一个。`, `${provider.name} · 语音`, 'warning');
  } catch (_e) { /* ignore */ }
}

/** 发一次合成请求并按需解出音频字节；三级回退（直连 → 酒馆代理 → 可读报错）保留。 */
async function fetchTtsAudio(
  url: string,
  reqHeaders: Record<string, string>,
  body: unknown,
  secrets: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<TtsRawResponse> {
  if (!url) throw new Error('未配置语音接口地址（设置 → 功能 → 语音，或选一个服务商）');
  const headers = { ...reqHeaders };
  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body), signal };
  const take = async (resp: Response): Promise<TtsRawResponse> => ({
    bytes: new Uint8Array(await resp.arrayBuffer()),
    contentType: resp.headers.get('content-type') || '',
  });
  let serverSaid = ''; // 服务端给过的原话（直连或代理）；最后优先报它，而不是一律甩「跨域」
  // ① 直连
  try {
    const resp = await fetch(url, init);
    if (resp.ok) return await take(resp);
    const text = await resp.text().catch(() => '');
    serverSaid = ttsHttpError(resp.status, text, secrets);
    // 4xx（403 除外）是服务的确定性答复，不必再走代理（403 可能是中转/网关，留给代理再试）
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 403) throw new Error(serverSaid);
  } catch (e) {
    if (e instanceof Error && /^TTS 接口 HTTP/.test(e.message)) throw e;
    // 网络 / CORS 失败 → 落到代理
  }
  // ② 酒馆 CORS 代理（需 config.yaml enableCorsProxy: true）
  try {
    const proxied = '/proxy/' + encodeURIComponent(url);
    const resp = await fetch(proxied, { ...init, headers: { ...headers, ...stRequestHeaders() } });
    if (resp.ok) return await take(resp);
    const text = await resp.text().catch(() => '');
    serverSaid = ttsHttpError(resp.status, text, secrets);
  } catch (_e2) { /* 落 ③ */ }
  // ③ 可读报错：服务端说过什么就报什么，否则才是跨域
  throw new Error(serverSaid || 'TTS 请求被跨域拦截：请改用允许 CORS 的中转站，或在酒馆 config.yaml 打开 enableCorsProxy 后重启');
}

/** api/comfy 合成 → Blob（带缓存；返回缓存 key 与真实时长）。 */
async function synthesizeToBlob(
  backend: VoiceBackend,
  req: { text: string; voiceId: string; speed?: number; emotion?: string; delivery?: string; refAudio?: string; cacheKey: string; providerId?: string },
  signal?: AbortSignal,
): Promise<{ blob: Blob; mime: string; durationMs?: number }> {
  if (backend === 'comfy') {
    const s = getPhoneSettings() as any;
    const comfy = s.voiceComfy || {};
    const url = resolveComfyUrl(comfy);
    const wf = parseVoiceWorkflow(String(comfy.workflow || ''));
    if (!isApiFormatWorkflow(wf)) {
      throw new Error('ComfyUI 语音工作流不是 API 格式：请在 ComfyUI 用「Save (API Format)」重新导出后粘贴');
    }
    const seed = Math.floor(Math.random() * 4294967296);
    const ok = injectVoiceWorkflow(wf, { text: req.text, seed, refAudio: req.refAudio });
    if (!ok) throw new Error('ComfyUI 工作流里找不到可写入台词(text)的节点：请把台词节点改为 %text% 或确认其为 TTS 节点');
    const { blob, mime } = await submitComfyAudioWorkflow({ url, timeoutSeconds: Number(comfy.timeoutSeconds) || 180 }, wf, signal);
    const durationMs = await decodeAudioDurationMs(blob);
    return { blob, mime, durationMs };
  }
  // api / 厂商原生协议
  const cfg = resolveVoiceProviderConfig(req.providerId);
  if (!['custom', 'local'].includes(cfg.provider.id)) {
    assertVoiceCredentials(cfg.provider, { appId: cfg.appId, accessKey: cfg.accessKey, key: cfg.key });
  }
  const request = buildVoiceRequest(cfg.provider, {
    key: cfg.key,
    appId: cfg.appId,
    accessKey: cfg.accessKey,
    model: cfg.model,
    voice: req.voiceId,
    url: String(cfg.cred.url || '').trim(),
    format: cfg.format,
    resourceId: cfg.resourceId,
  }, {
    text: req.text, voiceId: req.voiceId, speed: req.speed || 1, emotion: req.emotion, delivery: req.delivery,
  });
  // 遮蔽清单要含 cfg 里的原始密钥：火山「只填 Key」模式下密钥在 URL 里而不在任何头上，
  // 服务端把整条地址回显进错误文案时会漏出去。
  const secrets = [
    request.headers.Authorization, request.headers['xi-api-key'], request.headers['X-Api-Access-Key'],
    cfg.accessKey, cfg.key,
  ].filter((v): v is string => Boolean(v));
  // 这家要求显式音色而这次没带上 ⇒ 服务端会用默认音色（可能每次不同）：说清楚，别让用户以为是「钉不住」
  warnIfVoiceMissing(cfg.provider, req.voiceId || cfg.cred.voice || '');
  const raw = await fetchTtsAudio(request.url, request.headers, request.body, secrets, signal);
  const decoded = decodeVoiceResponse(request.decode, raw.bytes);
  if (!decoded.length) throw new Error('语音服务没有返回音频');
  const mime = request.format === 'wav' ? 'audio/wav' : (raw.contentType || 'audio/mpeg');
  const blob = new Blob([decoded as unknown as BlobPart], { type: mime });
  const durationMs = await decodeAudioDurationMs(blob);
  return { blob, mime, durationMs };
}

/** 解析 ComfyUI 地址：本模块 url 优先；useHostImageUrl 时跟随主项目生图 ComfyUI 地址。 */
export function resolveComfyUrl(comfy: { url?: string; useHostImageUrl?: boolean }): string {
  const own = String(comfy?.url || '').trim();
  if (own) return own;
  if (comfy?.useHostImageUrl !== false) {
    try {
      const p = getConfig().imageGeneration?.provider as any;
      const host = String(p?.comfyui?.url || '').trim();
      if (host) return host;
    } catch (_e) { /* ignore */ }
  }
  return '';
}

// ─── 播放器（单例；blob 走 <audio>，可选窥私失真滤镜） ───

let _current: { handle: VoiceHandle; stop: () => void } | null = null;

/** 停止当前播放（切换消息/离开会话/挂断时调用）。 */
export function stopVoice(): void {
  if (_current) {
    try { _current.handle.stop(); } catch (_e) { /* ignore */ }
    _current = null;
  }
}

export function isVoicePlaying(): boolean {
  return _current !== null;
}

export interface PlayVoiceOptions {
  backend: VoiceBackend;
  cacheKey: string;
  text: string;
  voiceId?: string;
  /** 指定服务商（按角色指定厂商用；缺省＝全局 `voiceProvider`）。 */
  providerId?: string;
  refAudio?: string;
  speed?: number;
  emotion?: string;
  /** 可选演绎说明（≤20 字，软限制；按服务商改写或丢弃）。 */
  delivery?: string;
  /** 窥私失真：低通 + 衰减（仅 blob 后端生效；系统 TTS 无字节，降级为语速偏慢）。 */
  muffle?: boolean;
  /** 发送方显示名（第八轮 §1：写进缓存元数据「角色」，录音机列表显示用）。 */
  role?: string;
  onState?: (state: VoicePlayState, detail?: string) => void;
  onProgress?: (ratio: number, remainSec: number, durationSec: number) => void;
  signal?: AbortSignal;
}

/** 播放一条语音（自动：缓存命中即播，未命中先合成；系统后端直接朗读）。 */
export function playVoice(opts: PlayVoiceOptions): VoiceHandle {
  stopVoice();
  const speed = Math.min(2, Math.max(0.5, opts.speed || 1));
  const emit = (s: VoicePlayState, d?: string) => { try { opts.onState?.(s, d); } catch (_e) { /* ignore */ } };
  const progress = (r: number, remain: number, dur: number) => { try { opts.onProgress?.(r, remain, dur); } catch (_e) { /* ignore */ } };

  if (opts.backend === 'off') { emit('error', '未开启语音'); return NOOP_HANDLE; }

  if (opts.backend === 'system') {
    const est = estimateSeconds(opts.text);
    let started = false;
    const handle = speakSystem(opts.text, opts.voiceId || '', opts.muffle ? speed * 0.9 : speed, {
      onStart: () => { started = true; emit('playing'); },
      onProgress: (r) => progress(r, Math.max(0, est * (1 - r)), est),
      onEnd: () => { _current = null; emit('ended'); },
      onError: (m) => { _current = null; emit('error', m); },
    });
    _current = { handle, stop: () => emit('ended') };
    if (!started) emit('loading');
    return handle;
  }

  // blob 后端（api / comfy）：缓存优先
  emit('loading');
  let cancelled = false;
  let handle: VoiceHandle = NOOP_HANDLE;
  void (async () => {
    try {
      let entry = await voiceCacheGet(opts.cacheKey);
      if (!entry) {
        const res = await synthesizeToBlob(opts.backend, {
          text: opts.text, voiceId: opts.voiceId || '', speed, emotion: opts.emotion,
          delivery: opts.delivery, refAudio: opts.refAudio, cacheKey: opts.cacheKey, providerId: opts.providerId,
        }, opts.signal);
        const created: VoiceCacheEntry = {
          key: opts.cacheKey, blob: res.blob, mime: res.mime, durationMs: res.durationMs,
          size: res.blob.size || 0, createdAt: Date.now(), lastAccessAt: Date.now(),
        };
        await voiceCachePut(created, { role: opts.role, text: opts.text, emotion: opts.emotion });
        void pruneVoiceCache();
        entry = created;
      }
      if (cancelled) return;
      handle = playBlob(entry.blob, speed, !!opts.muffle, emit, progress);
      _current = { handle, stop: () => emit('ended') };
    } catch (e) {
      if (cancelled) return;
      _current = null;
      const msg = e instanceof Error ? e.message : String(e);
      emit('error', msg);
      if (/ComfyUI|TTS 接口|跨域|未配置|密钥|AppID|豆包/.test(msg)) phoneNotify(msg, '小手机 · 语音');
    }
  })();

  return {
    stop() { cancelled = true; try { handle.stop(); } catch (_e) { /* ignore */ } if (_current) _current = null; },
    pause() { try { handle.pause(); } catch (_e) { /* ignore */ } },
    resume() { try { handle.resume(); } catch (_e) { /* ignore */ } },
    setRate(r) { try { handle.setRate(r); } catch (_e) { /* ignore */ } },
  };
}

/** <audio> 播放一个 Blob；可选接入 WebAudio 窥私滤镜。 */
function playBlob(
  blob: Blob,
  speed: number,
  muffle: boolean,
  emit: (s: VoicePlayState, d?: string) => void,
  progress: (r: number, remain: number, dur: number) => void,
): VoiceHandle {
  const w = hostWindow() as any;
  const url = URL.createObjectURL(blob);
  const audio: HTMLAudioElement = new w.Audio();
  audio.src = url;
  audio.playbackRate = speed;
  audio.preload = 'auto';
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { URL.revokeObjectURL(url); } catch (_e) { /* ignore */ }
  };

  let volume = 1;
  try { volume = Number(getPhoneSettings().soundVolume) || 0.7; } catch (_e) { volume = 0.7; }

  if (muffle) {
    try {
      const ctx = phoneAudioContext();
      if (ctx && typeof ctx.createMediaElementSource === 'function') {
        const src = ctx.createMediaElementSource(audio);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1200;
        const gain = ctx.createGain();
        gain.gain.value = volume * 0.35;
        src.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
        volume = 1; // 已由 gain 控制
      }
    } catch (_e) { /* 滤镜失败：退化为纯音量衰减 */ volume = volume * 0.5; }
  }

  const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : estimateSeconds('') || 1);
  const tick = () => {
    const d = duration();
    const cur = audio.currentTime || 0;
    progress(d ? Math.min(1, cur / d) : 0, Math.max(0, d - cur), d);
  };

  audio.onloadedmetadata = () => { try { audio.volume = volume; } catch (_e) { /* ignore */ } tick(); };
  audio.ontimeupdate = tick;
  audio.onplay = () => emit('playing');
  audio.onpause = () => { if (!audio.ended) emit('paused'); };
  audio.onended = () => { cleanup(); emit('ended'); };
  audio.onerror = () => { cleanup(); emit('error', '音频播放失败'); };

  void (async () => {
    await wakePhoneAudio(); // 播放解锁（第八轮 §2）：先唤醒再播；唤醒失败照常尝试
    if (cleaned) return;    // 唤醒期间已被停/被下一条顶掉：不再起播
    try { await audio.play(); } catch (_e) { emit('error', '播放被浏览器拦截：请再点一下'); }
  })();

  return {
    stop() { try { audio.pause(); } catch (_e) { /* ignore */ } cleanup(); },
    pause() { try { audio.pause(); } catch (_e) { /* ignore */ } },
    resume() { try { void audio.play(); } catch (_e) { /* ignore */ } },
    setRate(r) { try { audio.playbackRate = Math.min(2, Math.max(0.5, r)); } catch (_e) { /* ignore */ } },
  };
}

export interface PlayBlobOptions {
  speed?: number;
  /** 窥私失真（低通 + 衰减）。 */
  muffle?: boolean;
  onState?: (state: VoicePlayState, detail?: string) => void;
  onProgress?: (ratio: number, remainSec: number, durationSec: number) => void;
}

/** 直接播放一段已拿到的音频（收藏 / 已下载音频回放用；不走缓存与合成）。 */
export function playVoiceBlob(blob: Blob, opts: PlayBlobOptions = {}): VoiceHandle {
  stopVoice();
  if (!blob || typeof blob.size !== 'number' || !blob.size) {
    try { opts.onState?.('error', '没有可播放的音频'); } catch (_e) { /* ignore */ }
    return NOOP_HANDLE;
  }
  const speed = Math.min(2, Math.max(0.5, opts.speed || 1));
  const emit = (s: VoicePlayState, d?: string) => { try { opts.onState?.(s, d); } catch (_e) { /* ignore */ } };
  const progress = (r: number, remain: number, dur: number) => { try { opts.onProgress?.(r, remain, dur); } catch (_e) { /* ignore */ } };
  const handle = playBlob(blob, speed, !!opts.muffle, emit, progress);
  _current = { handle, stop: () => emit('ended') };
  return handle;
}

/** 预合成（只入缓存、不播放；仅 api/comfy 有意义）。失败静默——缓存是加速层。 */
export async function prewarmVoice(plan: {
  backend: VoiceBackend; cacheKey: string; text: string; voiceId?: string; providerId?: string; refAudio?: string; speed?: number;
  emotion?: string; delivery?: string; role?: string;
}): Promise<void> {
  if (plan.backend !== 'api' && plan.backend !== 'comfy') return;
  if (!plan.text.trim() || !plan.cacheKey) return;
  try {
    if (await voiceCacheGet(plan.cacheKey)) return;
    const res = await synthesizeToBlob(plan.backend, {
      text: plan.text, voiceId: plan.voiceId || '', speed: plan.speed, refAudio: plan.refAudio,
      emotion: plan.emotion, delivery: plan.delivery, cacheKey: plan.cacheKey, providerId: plan.providerId,
    });
    await voiceCachePut({
      key: plan.cacheKey, blob: res.blob, mime: res.mime, durationMs: res.durationMs,
      size: res.blob.size || 0, createdAt: Date.now(), lastAccessAt: Date.now(),
    }, { role: plan.role, text: plan.text, emotion: plan.emotion });
    void pruneVoiceCache();
  } catch (_e) { /* 预合成失败不影响点击时按需合成 */ }
}

// ─── 缓存维护 ───
let _pruneTimer: ReturnType<typeof setTimeout> | null = null;
function pruneVoiceCache(): void {
  if (_pruneTimer) return;
  _pruneTimer = setTimeout(async () => {
    _pruneTimer = null;
    try {
      const s = getPhoneSettings() as any;
      const maxMB = Number(s.voiceCacheMaxMB) || 60;
      await voiceCachePrune(200, maxMB * 1024 * 1024);
    } catch (_e) { /* ignore */ }
  }, 1500);
}

export { voiceCacheStats };
