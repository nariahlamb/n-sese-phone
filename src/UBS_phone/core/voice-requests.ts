// ===== 语音请求构造（按方言）+ 情绪改写器 =====
// 纯函数：给定「服务商预设 + 凭据 + 台词/情绪/演绎」，吐出一次合成的 HTTP 描述与响应解码方式。
// 这是 docs/35 §B.5 的唯一新逻辑，可在 Node 测试直调（断言请求形状，不真的联网）。

import {
  EMOTION_EN, normalizeEmotion,
  type VoiceDialect, type VoiceEmotionMode, type VoiceProviderPreset, type VoiceTextStyle,
} from './voice-providers';

/** 服务商凭据（按服务商分存；见 phone-settings.voiceCredentials）。 */
export interface VoiceCredential {
  key?: string;
  appId?: string;
  accessKey?: string;
  model?: string;
  voice?: string;
  url?: string;
  format?: 'mp3' | 'wav';
  resourceId?: string;
}

export interface VoiceSynthInput {
  text: string;
  voiceId: string;
  speed: number;
  /** 规范中文八词之一（可空）。 */
  emotion?: string;
  /** 可选演绎说明（≤20 字，软限制；原样透传，不截断）。 */
  delivery?: string;
}

/** 响应怎么变成音频字节。 */
export type VoiceDecodeKind = 'binary' | 'hex-json' | 'json-base64' | 'ndjson-base64' | 'mimo-base64';

export interface VoiceHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  format: 'mp3' | 'wav';
  decode: VoiceDecodeKind;
  /** 合成请求走原生协议（供错误提示区分「中转说」）。 */
  dialect: VoiceDialect;
}

/** 情绪改写结果：不同方言各取所需。 */
export interface EmotionRender {
  /** OpenAI instructions。 */
  instructions?: string;
  /** 拼到台词前面的文本（行内标签 / instruct 指令）。 */
  textPrefix?: string;
  /** MiniMax 等固定枚举。 */
  emotionEnum?: string;
  /** 火山 v3 的语气句。 */
  contextText?: string;
}

/** 情绪 + 演绎合并成一句「描述」（用户定案：后者是对前者的扩展补充）。 */
export function emotionPhrase(emotion: string, delivery: string): string {
  const e = normalizeEmotion(emotion);
  const d = String(delivery || '').trim();
  if (e && d) return `${e}，${d}`;
  return e || d;
}

/**
 * 按方言把情绪/演绎改写成该家认识的形式。
 * 纪律：不支持的方言**什么都不发**（尤其别把 [开心] 塞进纯文本——那会被真的念出来）。
 */
export function renderEmotion(
  mode: VoiceEmotionMode,
  dialect: VoiceDialect,
  textStyle: VoiceTextStyle | null,
  emotion: string,
  delivery: string,
  model = '',
): EmotionRender {
  const e = normalizeEmotion(emotion);
  const phrase = emotionPhrase(e, delivery);
  if (!phrase) return {};
  switch (mode) {
    case 'none':
      return {};
    case 'enum': {
      if (!e) return {};
      return { emotionEnum: EMOTION_EN[e] };
    }
    case 'text': {
      if (dialect === 'volcengine') return { contextText: phrase };
      if (textStyle === 'instruct-prefix') return { textPrefix: phrase }; // 调用方补 <|endofprompt|>
      if (textStyle === 'instructions') {
        // 只有 gpt-4o 系模型认 instructions；其余模型发了可能 400，故不带。
        if (!/gpt-4o/i.test(String(model || ''))) return {};
        return { instructions: phrase };
      }
      return {};
    }
    case 'inline': {
      if (dialect === 'mimo') {
        const style = e ? `<style>${e}</style>` : '';
        const paren = String(delivery || '').trim();
        return { textPrefix: `${style}${paren ? `（${paren}）` : ''}` };
      }
      if (dialect === 'fish' && /(^|[^a-z])s1([^0-9]|$)/i.test(String(model || ''))) {
        // Fish S1 只认圆括号固定标签，且要英文枚举
        return e ? { textPrefix: `(${EMOTION_EN[e]}) ` } : {};
      }
      // ElevenLabs v3/v4 与 Fish S2/S2.1：方括号自由描述（中文描述亦可）
      return { textPrefix: `[${phrase}] ` };
    }
    default:
      return {};
  }
}

// ─── 各方言请求构造 ───

/** 火山新版控制台那把 API Key 的参数名。它**不能走请求头**：`X-Api-Key` 不在该家的 CORS
 *  预检白名单里（2026-10-11 实测 OPTIONS 原文），浏览器会直接拦下、请求根本发不出去。
 *  服务端 header / query 两处都认（报错原文 "app key not found in header or query"），
 *  所以只填 Key 时改挂 URL 参数。代价：密钥进服务端日志 ⇒ 能用但不推荐（docs/62）。 */
export const VOLC_API_KEY_PARAM = 'api_key';

/** 往地址上挂一个查询参数：已有 `?` 用 `&`，值整体 encodeURIComponent。
 *  地址以 ? / & 结尾时不重复补分隔符（用户手填的地址里出现过）。 */
export function withQuery(url: string, name: string, value: string): string {
  const raw = String(url || '');
  const sep = /[?&]$/.test(raw) ? '' : raw.includes('?') ? '&' : '?';
  return `${raw}${sep}${name}=${encodeURIComponent(value)}`;
}

function authHeaders(cred: VoiceCredential): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = String(cred.key || '').trim();
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

function resolvedUrl(provider: VoiceProviderPreset, cred: VoiceCredential): string {
  const own = String(cred.url || '').trim();
  return own || provider.baseUrl;
}

function resolvedModel(provider: VoiceProviderPreset, cred: VoiceCredential): string {
  const m = String(cred.model || '').trim();
  return m || provider.models[0] || '';
}

/** 构造一次合成请求；缺关键字段时抛可读错误（由 UI 兜）。 */
export function buildVoiceRequest(
  provider: VoiceProviderPreset,
  cred: VoiceCredential,
  input: VoiceSynthInput,
): VoiceHttpRequest {
  const model = resolvedModel(provider, cred);
  const voice = String(input.voiceId || cred.voice || '').trim();
  const speed = Math.min(2, Math.max(0.5, Number(input.speed) || 1));
  const format: 'mp3' | 'wav' = cred.format === 'wav' || cred.format === 'mp3' ? cred.format : provider.format;
  const em = renderEmotion(provider.emotion, provider.dialect, provider.textStyle, input.emotion || '', input.delivery || '', model);
  const text = String(input.text || '');

  switch (provider.dialect) {
    case 'openai': {
      const body: Record<string, unknown> = {
        model,
        input: em.textPrefix ? `${em.textPrefix} <|endofprompt|> ${text}` : text,
        voice: voice || 'alloy',
        response_format: format,
        speed,
      };
      if (em.instructions) body.instructions = em.instructions;
      return { url: resolvedUrl(provider, cred), headers: authHeaders(cred), body, format, decode: 'binary', dialect: provider.dialect };
    }

    case 'volcengine': {
      const appId = String(cred.appId || '').trim();
      const accessKey = String(cred.accessKey || cred.key || '').trim();
      const resourceId = String(cred.resourceId || provider.extra?.resourceId || 'seed-tts-2.0').trim();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Api-Resource-Id': resourceId,
      };
      let url = resolvedUrl(provider, cred);
      if (appId) {
        // 旧版控制台（推荐）：头名必须是 X-Api-App-Key，不能写 X-Api-App-Id：服务端两个名字都认（2026-10-07 实测同一鉴权阶段），
        // 但火山的 CORS 预检白名单只放行 App-Key —— 写成 App-Id 时浏览器预检直接失败，请求根本发不出去。
        headers['X-Api-App-Key'] = appId;
        headers['X-Api-Access-Key'] = accessKey;
      } else if (accessKey) {
        // 新版控制台：只有一把 API Key，AppID 留空。钥匙只能挂 URL（见 VOLC_API_KEY_PARAM）。
        url = withQuery(url, VOLC_API_KEY_PARAM, accessKey);
      } else {
        // 两样都没填：维持旧形状（空的凭据头），由上层校验给出可读错误。
        headers['X-Api-App-Key'] = '';
        headers['X-Api-Access-Key'] = '';
      }
      const reqParams: Record<string, unknown> = {
        text,
        speaker: voice,
        reqid: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        audio_params: { format: format === 'wav' ? 'wav' : 'mp3', sample_rate: 24000 },
      };
      if (em.contextText) reqParams.additions = JSON.stringify({ context_texts: [em.contextText] });
      const body = { user: { uid: 'ubp-phone' }, req_params: reqParams };
      return { url, headers, body, format, decode: 'ndjson-base64', dialect: provider.dialect };
    }

    case 'minimax': {
      const headers = authHeaders(cred);
      const voiceSetting: Record<string, unknown> = { voice_id: voice, speed, vol: 1, pitch: 0 };
      if (em.emotionEnum) voiceSetting.emotion = em.emotionEnum;
      const body = {
        model,
        text,
        stream: false,
        voice_setting: voiceSetting,
        audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
      };
      return { url: resolvedUrl(provider, cred), headers, body, format: 'mp3', decode: 'hex-json', dialect: provider.dialect };
    }

    case 'elevenlabs': {
      const base = resolvedUrl(provider, cred).replace(/\/+$/, '');
      const url = `${base}/${encodeURIComponent(voice || '21m00Tcm4TlvDq8ikWAM')}?output_format=mp3_44100_128`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const key = String(cred.key || '').trim();
      if (key) headers['xi-api-key'] = key;
      const body = {
        text: em.textPrefix ? `${em.textPrefix}${text}` : text,
        model_id: model,
        // v3 只接受 0 / 0.5 / 1；统一给 0.5（自然档）
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed },
      };
      return { url, headers, body, format: 'mp3', decode: 'binary', dialect: provider.dialect };
    }

    case 'mimo': {
      const body = {
        model,
        messages: [{ role: 'assistant', content: em.textPrefix ? `${em.textPrefix}${text}` : text }],
        audio: { format: 'wav', voice },
      };
      return { url: resolvedUrl(provider, cred), headers: authHeaders(cred), body, format: 'wav', decode: 'mimo-base64', dialect: provider.dialect };
    }

    case 'fish': {
      const fishOptions: Record<string, unknown> = { prosody: { speed } };
      const body = {
        model: `fish-audio/${model}`,
        input: text,
        voice,
        response_format: format,
        provider: { options: { 'fish-audio': fishOptions } },
      };
      const req: VoiceHttpRequest = { url: resolvedUrl(provider, cred), headers: authHeaders(cred), body, format, decode: 'binary', dialect: provider.dialect };
      // S2/S2.1 认行内方括号 → 拼进 input（不改 body 结构）
      if (em.textPrefix) (body as Record<string, unknown>).input = `${em.textPrefix}${text}`;
      return req;
    }

    default:
      throw new Error('未知的语音协议方言');
  }
}

// ─── 响应解码（纯字节层；Blob 由调用方包）──

function base64ToBytes(b64: string): Uint8Array {
  const clean = String(b64 || '').replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  const g = globalThis as any;
  const bin = typeof atob === 'function' ? atob(clean) : g.Buffer.from(clean, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const s = String(hex || '').trim();
  if (!s || s.length % 2 || !/^[\da-f]+$/i.test(s)) throw new Error('返回的音频数据无效（不是十六进制）');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** 响应体开头片段（≤60 字、压掉控制字符）：正文不是 JSON 时，把「到底收到了什么」带进错误文案。 */
function bodyPeek(raw: string, max = 60): string {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 火山 v3 的 NDJSON：每行一个 JSON，`code` 非成功码即抛错，`data` 是 base64 音频。
 *  失败信封是 `{"header":{code,message}}`（HTTP 401/400，HTTP 200 也可能出现）——两种外形都要认，
 *  否则真实的「密钥/资源不对」会被笼统地报成「没有返回音频数据」（2026-10-07 排查踩过）。 */
export function decodeVolcengineNdjson(raw: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let lines = 0;
  let parsed = 0;
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    lines++;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    parsed++;
    const code = obj?.code ?? obj?.Code ?? obj?.header?.code;
    if (typeof code === 'number' && code !== 0 && code !== 20000000) {
      const said = obj?.message ?? obj?.Message ?? obj?.header?.message;
      throw new Error(`火山豆包返回错误码 ${code}${said ? `：${said}` : ''}`);
    }
    const data = obj?.data ?? obj?.Data;
    if (typeof data === 'string' && data) chunks.push(base64ToBytes(data));
  }
  if (!chunks.length) {
    // 一行都没解析成 JSON：拿到的不是火山 NDJSON（中间层改写 / 压缩没解开 / 网关页），
    // 报出开头片段——只报「没有返回音频数据」会把真正的原因埋掉。
    if (lines && !parsed) throw new Error(`火山豆包没有返回 NDJSON（收到的开头是：${bodyPeek(raw)}）`);
    throw new Error('火山豆包没有返回音频数据');
  }
  return concat(chunks);
}

/** 把服务端响应体按解码方式取出音频字节；失败给可读错误。 */
export function decodeVoiceResponse(kind: VoiceDecodeKind, raw: string | Uint8Array): Uint8Array {
  if (kind === 'binary') return typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  switch (kind) {
    case 'ndjson-base64':
      return decodeVolcengineNdjson(text);
    case 'mimo-base64': {
      let json: any;
      try { json = JSON.parse(text); } catch { throw new Error('小米 MiMo 返回了无效响应'); }
      if (json?.error) throw new Error('小米 MiMo：' + (json.error.message || '请求失败'));
      const data = json?.choices?.[0]?.message?.audio?.data;
      if (typeof data !== 'string' || !data) throw new Error('小米 MiMo 没有返回音频');
      return base64ToBytes(data);
    }
    case 'hex-json': {
      let json: any;
      try { json = JSON.parse(text); } catch { throw new Error('MiniMax 返回了无效响应'); }
      const code = json?.base_resp?.status_code;
      if (typeof code === 'number' && code !== 0) throw new Error(`MiniMax 返回错误 ${code}${json?.base_resp?.status_msg ? `：${json.base_resp.status_msg}` : ''}`);
      const audio = json?.data?.audio;
      if (typeof audio !== 'string' || !audio) throw new Error('MiniMax 没有返回音频');
      return hexToBytes(audio);
    }
    case 'json-base64': {
      let json: any;
      try { json = JSON.parse(text); } catch { throw new Error('语音服务返回了无效响应'); }
      const data = json?.data?.audio ?? json?.audio;
      if (typeof data !== 'string' || !data) throw new Error('语音服务没有返回音频');
      return base64ToBytes(data);
    }
    default:
      throw new Error('未知的响应解码方式');
  }
}
