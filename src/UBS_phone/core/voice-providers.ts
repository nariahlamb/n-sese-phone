// ===== 语音服务商元数据表（设置页与请求构造的唯一事实源） =====
// 设计：一张声明式表驱动「服务商选择器 / 预填地址与音色 / 凭据字段 / 情绪改写方式」，
// 避免把这些差异散落成一堆 if（见 docs/35 §A.3/§A.4）。
// 纯数据 + 纯函数，可在 Node 测试直调。

import { normalizeGender, type VoiceOption, type VoiceGender } from './voice-mapping';

/** 请求协议方言。openai 之外的几家属「厂商原生」，由 core/voice-requests 按方言构造请求。 */
export type VoiceDialect = 'openai' | 'volcengine' | 'minimax' | 'elevenlabs' | 'mimo' | 'fish';

/** 情绪落地方式：none=不发；enum=固定枚举字段；inline=行内标签；text=自由文本。 */
export type VoiceEmotionMode = 'none' | 'enum' | 'inline' | 'text';

/** OpenAI 兼容家里「自由文本」的具体落点。 */
export type VoiceTextStyle = 'instructions' | 'instruct-prefix';

/** 凭据形态：key=一个密钥；appid=AppID + AccessKey；none=本地无需密钥。 */
export type VoiceAuth = 'key' | 'appid' | 'none';

/** 「拉取音色列表」的可选筛选条件（各家接口形状不同，故用声明式描述驱动设置页 UI 与请求拼装）。
 *  GET 方言拼进 query、POST 方言合进 body；值为空串 = 不传该字段。 */
export interface VoiceFilterSpec {
  /** 接口里的字段名。 */
  key: string;
  label: string;
  hint?: string;
  /** 固定候选 ⇒ 渲染成下拉；不给 ⇒ 渲染成自由文本框（如 Fish 的 tag）。 */
  options?: readonly VoiceFilterOption[];
  placeholder?: string;
  /** 默认值（'' = 不传该字段）。 */
  default: string;
}

export interface VoiceFilterOption {
  /** 接口真正要的值（'' = 不传该字段）。 */
  value: string;
  label: string;
}

/** 「拉取音色列表」一页的结果：选项 + 下一页游标（页码或 token 串）。
 *  `parse` 也允许继续返回裸数组（老实现零改动兼容）——统一走 `normalizeVoiceFetchResult` 归一。 */
export interface VoiceFetchPage {
  options: VoiceOption[];
  /** 下一页游标：原样回传给 listUrl/parse 的 page 参数；无 = 已到底（前端不出现「再拉一页」）。 */
  next?: string;
}

export type VoiceFetchResult = VoiceOption[] | VoiceFetchPage;

/** 归一「一页结果」：数组=单页/无分页；{options,next}=可分页。空 next 视为已到底。 */
export function normalizeVoiceFetchResult(result: VoiceFetchResult | null | undefined): VoiceFetchPage {
  if (Array.isArray(result)) return { options: result };
  const options = Array.isArray(result?.options) ? result.options : [];
  const next = String(result?.next ?? '').trim();
  return next ? { options, next } : { options };
}

/** 「拉取音色列表」的接口描述（只对有公开列表接口的家有意义；见 core/voice-catalog）。 */
export interface VoiceFetcher {
  method: 'GET' | 'POST';
  /** 从预设/用户填的合成地址推导列表接口地址；filters = 已选筛选值（键为 VoiceFilterSpec.key）；
   *  page = 上一页回传的游标（首页不传，实现自行决定是页码还是 token）。 */
  listUrl: (base: string, cred: { key?: string; appId?: string }, filters: Readonly<Record<string, string>>, page?: string) => string;
  headers: (cred: { key?: string; appId?: string }) => Record<string, string>;
  body?: (cred: { key?: string; appId?: string }, filters: Readonly<Record<string, string>>) => unknown;
  /** 该家支持的筛选条件（设置页据此渲染；无 = 这家没有可筛的维度）。 */
  filters?: readonly VoiceFilterSpec[];
  /** 返回 JSON → 一页音色（裸数组=无分页；{options,next}=可分页，next 供「再拉一页」）。 */
  parse: (json: any, page?: string) => VoiceFetchResult;
}

export interface VoiceProviderPreset {
  id: string;
  name: string;
  dialect: VoiceDialect;
  auth: VoiceAuth;
  /** 预填的完整接口地址（用户可改）。 */
  baseUrl: string;
  models: readonly string[];
  voices: readonly VoiceOption[];
  format: 'mp3' | 'wav';
  emotion: VoiceEmotionMode;
  /** 仅 openai 方言有意义；其余方言留 null。 */
  textStyle: VoiceTextStyle | null;
  /** 厂商特有的额外预填（如火山的 resourceId）。 */
  extra?: Readonly<Record<string, string>>;
  /** 选择器上的副标题（协议 / 音色数等）。 */
  meta: string;
  /** 一句话说明。 */
  note: string;
  /** 原生协议：需适配器，且未上机实测。 */
  experimental?: boolean;
  /** AppID 可留空（该家新版控制台只发一把 API Key）。留空时凭据改走 URL 参数——
   *  因为对应的那个请求头不在厂商 CORS 预检白名单里，请求头写法在浏览器里发不出去（docs/62）。
   *  能用但不推荐：URL 会进服务端日志，所以 UI 必须如实标注，不能只说「可空」。 */
  appIdOptional?: boolean;
}

// ─── 规范情绪（八词闭集）──
// 选中文八词：prompt 友好，且恰好覆盖 MiniMax 的固定枚举（docs/35 §B.2）。

export const VOICE_EMOTIONS = ['开心', '悲伤', '生气', '害怕', '惊讶', '厌恶', '平静', '低语'] as const;
export type VoiceEmotion = (typeof VOICE_EMOTIONS)[number];

/** 中文八词 → 英文枚举（MiniMax / 行内标签用）。 */
export const EMOTION_EN: Readonly<Record<VoiceEmotion, string>> = {
  开心: 'happy',
  悲伤: 'sad',
  生气: 'angry',
  害怕: 'fearful',
  惊讶: 'surprised',
  厌恶: 'disgusted',
  平静: 'calm',
  低语: 'whisper',
};

/** 把任意输入归一到一个规范情绪；认不出返回 ''（=不标情绪）。 */
export function normalizeEmotion(raw: unknown): VoiceEmotion | '' {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const hit = (VOICE_EMOTIONS as readonly string[]).find(e => e === s);
  if (hit) return hit as VoiceEmotion;
  // 常见同义/英文写法归一到八词
  const table: Array<[VoiceEmotion, RegExp]> = [
    ['开心', /happy|joy|excited|cheer|delight|高兴|快乐|喜悦|兴奋|愉快|欣喜|开心/],
    ['悲伤', /sad|sorrow|depress|cry|难过|伤心|悲伤|沮丧|失落|委屈|哭/],
    ['生气', /angry|furious|mad|annoy|生气|愤怒|恼火|不满|气愤|烦躁|不耐烦/],
    ['害怕', /fear|scare|afraid|nervous|anxious|害怕|恐惧|紧张|担心|不安|惊恐|慌/],
    ['惊讶', /surpris|shock|astonish|惊讶|吃惊|震惊|意外|诧异|惊喜/],
    ['厌恶', /disgust|contempt| disdain|scorn|厌恶|嫌弃|恶心|鄙视|轻蔑|不屑/],
    ['低语', /whisper|低语|耳语|悄悄|小声/],
    ['平静', /calm|gentle|neutral|soft|relax|平静|冷静|温柔|淡然|冷淡|平淡|轻声|温和|沉稳/],
  ];
  for (const [emo, re] of table) if (re.test(s)) return emo;
  return '';
}

/** 情绪标签的**展示**口径（纯函数，渲染层三处共用）：key=色相（八词英文键，认不出=unknown），
 *  label=原文（认不出也如实显示，不丢失信息）。**空标注返回 null ⇒ 调用方不渲染任何标签**
 *  （刻意不给「未标注」占位——用户定案 2026-10-03）。 */
export function emotionBadge(raw: unknown): { key: string; label: string } | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const norm = normalizeEmotion(text);
  return { key: norm ? EMOTION_EN[norm] : 'unknown', label: text.slice(0, 8) };
}

// ─── 音色池（按服务商）──

const OPENAI_VOICES: VoiceOption[] = [
  { id: 'alloy', label: 'Alloy', gender: 'n' },
  { id: 'ash', label: 'Ash', gender: 'n' },
  { id: 'ballad', label: 'Ballad', gender: 'n' },
  { id: 'coral', label: 'Coral 女', gender: 'f' },
  { id: 'echo', label: 'Echo 男', gender: 'm' },
  { id: 'fable', label: 'Fable', gender: 'n' },
  { id: 'nova', label: 'Nova 女（明亮）', gender: 'f' },
  { id: 'onyx', label: 'Onyx 男（低沉）', gender: 'm' },
  { id: 'sage', label: 'Sage', gender: 'n' },
  { id: 'shimmer', label: 'Shimmer 女', gender: 'f' },
  { id: 'verse', label: 'Verse', gender: 'n' },
  { id: 'marin', label: 'Marin 女', gender: 'f' },
  { id: 'cedar', label: 'Cedar 男', gender: 'm' },
];

const SILICONFLOW_VOICES: VoiceOption[] = [
  { id: 'FunAudioLLM/CosyVoice2-0.5B:alex', label: 'Alex 男', gender: 'm' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:benjamin', label: 'Benjamin 男', gender: 'm' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:charles', label: 'Charles 男', gender: 'm' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:david', label: 'David 男', gender: 'm' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:anna', label: 'Anna 女', gender: 'f' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:bella', label: 'Bella 女', gender: 'f' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:claire', label: 'Claire 女', gender: 'f' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:diana', label: 'Diana 女', gender: 'f' },
];

// MiniMax 系统音色（官方文档公开的固定 voice_id；账号内另可用 /v1/get_voice 拉取克隆音色）。
const MINIMAX_VOICES: VoiceOption[] = [
  { id: 'male-qn-qingse', label: '青涩青年音色', gender: 'm' },
  { id: 'male-qn-jingying', label: '精英青年音色', gender: 'm' },
  { id: 'male-qn-badao', label: '霸道青年音色', gender: 'm' },
  { id: 'male-qn-daxuesheng', label: '青年大学生音色', gender: 'm' },
  { id: 'male-qn-qingse-jingpin', label: '青涩青年音色（精品）', gender: 'm' },
  { id: 'male-qn-jingying-jingpin', label: '精英青年音色（精品）', gender: 'm' },
  { id: 'male-qn-badao-jingpin', label: '霸道青年音色（精品）', gender: 'm' },
  { id: 'male-qn-daxuesheng-jingpin', label: '青年大学生音色（精品）', gender: 'm' },
  { id: 'female-shaonv', label: '少女音色', gender: 'f' },
  { id: 'female-yujie', label: '御姐音色', gender: 'f' },
  { id: 'female-chengshu', label: '成熟女性音色', gender: 'f' },
  { id: 'female-tianmei', label: '甜美女声音色', gender: 'f' },
  { id: 'female-shaonv-jingpin', label: '少女音色（精品）', gender: 'f' },
  { id: 'female-yujie-jingpin', label: '御姐音色（精品）', gender: 'f' },
  { id: 'female-chengshu-jingpin', label: '成熟女性音色（精品）', gender: 'f' },
  { id: 'female-tianmei-jingpin', label: '甜美女声音色（精品）', gender: 'f' },
  { id: 'presenter_male', label: '男性主持人', gender: 'm' },
  { id: 'presenter_female', label: '女性主持人', gender: 'f' },
  { id: 'audiobook_male_1', label: '男性有声书 1', gender: 'm' },
  { id: 'audiobook_male_2', label: '男性有声书 2', gender: 'm' },
  { id: 'audiobook_female_1', label: '女性有声书 1', gender: 'f' },
  { id: 'audiobook_female_2', label: '女性有声书 2', gender: 'f' },
  { id: 'clever_boy', label: '聪明男童', gender: 'm' },
  { id: 'cute_boy', label: '可爱男童', gender: 'm' },
  { id: 'lovely_girl', label: '萌萌女童', gender: 'f' },
  { id: 'charming_lady', label: '魅力女性', gender: 'f' },
  { id: 'elegant_man', label: '优雅男性', gender: 'm' },
  { id: 'wise_woman', label: '智慧女性', gender: 'f' },
  { id: 'deep_voice_male', label: '低沉男声', gender: 'm' },
];

// ElevenLabs 预置音色（Premade Voices，ID 官方固定；账号内另有克隆音色，用 /v2/voices 拉取）。
const ELEVEN_VOICES: VoiceOption[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel 女（默认）', gender: 'f' },
  { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi 女', gender: 'f' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella 女', gender: 'f' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli 女', gender: 'f' },
  { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte 女', gender: 'f' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice 女', gender: 'f' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda 女', gender: 'f' },
  { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica 女', gender: 'f' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', label: 'Lily 女', gender: 'f' },
  { id: 'SOYHLrjzK2X1ezoPC6cr', label: 'Sarah 女', gender: 'f' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', label: 'Laura 女', gender: 'f' },
  { id: 'piTKgcLEGmPE4e6mEKli', label: 'Nicole 女', gender: 'f' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni 男', gender: 'm' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh 男', gender: 'm' },
  { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold 男', gender: 'm' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam 男', gender: 'm' },
  { id: 'yoZ06aMxZJJ28mfd3POQ', label: 'Sam 男', gender: 'm' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam 男', gender: 'm' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', label: 'Callum 男', gender: 'm' },
  { id: 'bIHbv24MWmeRgasZH58o', label: 'Will 男', gender: 'm' },
  { id: 'cjVigY5qzO86Huf0OWal', label: 'Eric 男', gender: 'm' },
  { id: 'iP95p4xoKVk53GoZ742B', label: 'Chris 男', gender: 'm' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian 男', gender: 'm' },
  { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel 男', gender: 'm' },
  { id: 'CwhRBWXzGAHq8TQ4Fs17', label: 'Roger 男', gender: 'm' },
  { id: 'IKne3meq5aSn9XLyUdCD', label: 'Charlie 男', gender: 'm' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George 男', gender: 'm' },
  { id: 'SAz9YHcvj6GT2YYXdXww', label: 'River 中性', gender: 'n' },
];

const MIMO_VOICES: VoiceOption[] = [
  { id: '冰糖', label: '冰糖 · 中文女声', gender: 'f' },
  { id: '茉莉', label: '茉莉 · 中文女声', gender: 'f' },
  { id: '苏打', label: '苏打 · 中文男声', gender: 'm' },
  { id: '白桦', label: '白桦 · 中文男声', gender: 'm' },
  { id: 'Mia', label: 'Mia · 英文女声', gender: 'f' },
  { id: 'Chloe', label: 'Chloe · 英文女声', gender: 'f' },
  { id: 'Milo', label: 'Milo · 英文男声', gender: 'm' },
  { id: 'Dean', label: 'Dean · 英文男声', gender: 'm' },
];

// ─── 服务商表 ───

export const VOICE_PROVIDERS: readonly VoiceProviderPreset[] = [
  {
    id: 'openai', name: 'OpenAI', dialect: 'openai', auth: 'key',
    baseUrl: 'https://api.openai.com/v1/audio/speech',
    models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    voices: OPENAI_VOICES, format: 'mp3', emotion: 'text', textStyle: 'instructions',
    meta: 'OpenAI 兼容 · 13 音色',
    note: '只有 gpt-4o-mini-tts 读 instructions（自由演绎）；tts-1 / tts-1-hd 忽略情绪。',
  },
  {
    id: 'siliconflow', name: '硅基流动', dialect: 'openai', auth: 'key',
    baseUrl: 'https://api.siliconflow.cn/v1/audio/speech',
    models: ['FunAudioLLM/CosyVoice2-0.5B', 'fishaudio/fish-speech-1.5'],
    voices: SILICONFLOW_VOICES, format: 'mp3', emotion: 'text', textStyle: 'instruct-prefix',
    meta: 'OpenAI 兼容 · 8 音色',
    note: 'CosyVoice2 支持 instruct 演绎（写成 `<指令> <|endofprompt|> 台词`）；fish-speech-1.5 无情绪。',
  },
  {
    id: 'fish', name: 'Fish Audio', dialect: 'fish', auth: 'key',
    baseUrl: 'https://api.fish.audio/compat/v1/audio/speech',
    models: ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1'],
    voices: [], format: 'mp3', emotion: 'inline', textStyle: null,
    meta: '原生协议 · 可拉取音色',
    note: 'S2/S2.1 认方括号自由描述，S1 认圆括号固定标签。s2.1-pro-free 是官方免费档（不保证延迟，适合试听）。点「拉取音色列表」按语言/标签从账号取音色，或从 fish.audio 音色页地址里手抄 ID。',
    experimental: true,
  },
  {
    id: 'volcengine', name: '火山豆包', dialect: 'volcengine', auth: 'appid', appIdOptional: true,
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    models: ['seed-tts-2.0'],
    voices: [], format: 'mp3', emotion: 'text', textStyle: null,
    extra: { resourceId: 'seed-tts-2.0' },
    meta: '原生协议 · AppID 可空',
    note: '情绪走自然语言语气句（仅 seed-tts-2.0 系音色生效）；音色名在火山控制台复制。'
      + 'AppID 留空时按新版控制台只发 API Key——但密钥会被拼进请求地址、可能落在服务端日志里，'
      + '安全性低于旧版控制台的 AppID + AccessToken，能用但不推荐。',
    experimental: true,
  },
  {
    id: 'minimax', name: 'MiniMax', dialect: 'minimax', auth: 'appid',
    baseUrl: 'https://api.minimax.io/v1/t2a_v2',
    models: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'],
    voices: MINIMAX_VOICES, format: 'mp3', emotion: 'enum', textStyle: null,
    meta: '原生协议 · 可拉取音色',
    note: '情绪是固定枚举；演绎说明不适用（会被丢弃）。可点「拉取音色列表」带出账号里的克隆音色。',
    experimental: true,
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', dialect: 'elevenlabs', auth: 'key',
    baseUrl: 'https://api.elevenlabs.io/v1/text-to-speech',
    models: ['eleven_v4', 'eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'],
    voices: ELEVEN_VOICES, format: 'mp3', emotion: 'inline', textStyle: null,
    meta: '原生协议 · 可拉取音色',
    note: '只有 eleven_v3 / v4 读行内 [标签]；其余模型忽略。内置预置音色，可点「拉取音色列表」带出账号里的克隆音色。',
    experimental: true,
  },
  {
    id: 'mimo', name: '小米 MiMo', dialect: 'mimo', auth: 'key',
    baseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone'],
    voices: MIMO_VOICES, format: 'wav', emotion: 'inline', textStyle: null,
    meta: '原生协议 · 中文风格词',
    note: '情绪写成句首 <style>标签</style> + 圆括号演绎，中文最准。',
    experimental: true,
  },
  {
    id: 'local', name: '本地引擎', dialect: 'openai', auth: 'none',
    baseUrl: 'http://127.0.0.1:7778/v1/audio/speech',
    models: ['tts-1'],
    voices: [], format: 'wav', emotion: 'none', textStyle: null,
    meta: 'OpenAI 兼容 · 无需密钥',
    note: 'GPT-SoVITS / CosyVoice / TTS-WebUI 等本机服务；地址按你的部署改。',
  },
  {
    id: 'custom', name: '自定义 / 中转', dialect: 'openai', auth: 'key',
    baseUrl: '',
    models: ['tts-1'],
    voices: [], format: 'mp3', emotion: 'text', textStyle: 'instructions',
    meta: 'OpenAI 兼容 · 手动填写',
    note: '任何 /v1/audio/speech 地址与模型；不支持情绪服务商可不填。',
  },
];

// ─── 音色列表拉取（有公开接口的家；地址从合成地址推导，故换中转也能跟着走）───

function originOf(url: string, fallback: string): string {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return fallback;
  const m = u.match(/^(https?:\/\/[^/]+)/i);
  return m ? m[1] : fallback;
}

function bearer(key?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const k = String(key || '').trim();
  if (k) h.Authorization = `Bearer ${k}`;
  return h;
}

/** 已选筛选值里「非空」的项 → GET query 尾巴（'' 或 '&k=v'）；空串 = 用户选了「不限」。 */
function queryOf(filters: Readonly<Record<string, string>> | undefined): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filters || {})) {
    const s = String(v ?? '').trim();
    if (s) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s)}`);
  }
  return parts.length ? `&${parts.join('&')}` : '';
}

/** 已选筛选值里「非空」的项 → POST body 片段。 */
function filterBody(filters: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters || {})) {
    const s = String(v ?? '').trim();
    if (s) out[k] = s;
  }
  return out;
}

/** 常见音色语言候选（Fish / ElevenLabs 的语言筛选共用；接口只认小写码）。 */
const LANG_OPTIONS: readonly VoiceFilterOption[] = [
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日语' },
  { value: 'en', label: '英语' },
  { value: 'ko', label: '韩语' },
  { value: 'yue', label: '粤语' },
  { value: 'fr', label: '法语' },
  { value: 'de', label: '德语' },
  { value: 'es', label: '西班牙语' },
  { value: '', label: '不限' },
];

/** 从拉回的音色里挑一个次要说明（标签/描述），给「挑音色」弹窗做选择依据。 */
function descOf(raw: unknown, max = 8): string {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of list) {
    const s = String(item ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out.join(' · ');
}

/** 只在确实有可展示的标签/描述时才挂 desc（不给每条音色都留一个空字符串键）。 */
function withDesc(v: VoiceOption, desc: string): VoiceOption {
  return desc ? { ...v, desc } : v;
}

/** Fish 的性别只能从 tags 里认（接口没有单独的性别字段）：tags 里带 male/female/男/女/御姐…
 *  逐个 tag 判定而不是拼成一串再判——否则「甲 tag 的 男」会被「乙 tag 的 female」抢答。
 *  认不出＝'n'（与手填 `id` 的口径一致，`autoVoiceFor` 会把 'n' 回退成全池）。 */
function genderFromTags(tags: readonly unknown[]): VoiceGender {
  for (const tag of tags) {
    const g = normalizeGender(tag);
    if (g !== 'n') return g;
  }
  return 'n';
}

/** Fish 列表接口的页大小（listUrl 与「末页判定」必须同一份事实源）。 */
const FISH_PAGE_SIZE = 100;
/** ElevenLabs 列表接口的页大小（官方上限 100）。 */
const ELEVEN_PAGE_SIZE = 100;

/** Fish 页码参数归一：认不出/缺省/非法值一律落回第 1 页（避免把脏游标发给接口）。 */
function fishPageNumber(page?: string): number {
  const n = Math.floor(Number(String(page ?? '').trim()));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export const VOICE_FETCHERS: Readonly<Record<string, VoiceFetcher>> = {
  // Fish：GET {origin}/model?page_size=100&page_number=N[&language=&tag=] → {total, items[].{_id,title,tags,languages}}
  // 关键：不传 language 时接口按全站热度排（几乎全是英语音色）——这就是「拉回来都是外国人」的成因。
  fish: {
    method: 'GET',
    listUrl: (base, _cred, filters, page) =>
      `${originOf(base, 'https://api.fish.audio')}/model?page_size=${FISH_PAGE_SIZE}&page_number=${fishPageNumber(page)}${queryOf(filters)}`,
    headers: (cred) => bearer(cred.key),
    filters: [
      {
        key: 'language', label: '语言', default: 'zh',
        hint: '按音色语言筛选。默认中文——不筛就是全站最热的一批，几乎都是英语音色。',
        options: LANG_OPTIONS,
      },
      { key: 'tag', label: '标签', default: '', placeholder: '如 female / male / 御姐 / 新闻' },
    ],
    parse: (json, page) => {
      const items = Array.isArray(json?.items) ? json.items : (Array.isArray(json?.data) ? json.data : []);
      const options = items.map((it: any): VoiceOption => {
        const id = String(it?._id ?? it?.id ?? '').trim();
        const tags = Array.isArray(it?.tags) ? it.tags : [];
        const langs = Array.isArray(it?.languages) ? it.languages.join('/') : '';
        // 性别从 tags 推断（Fish 不单列性别字段）；desc 里的同一批 tags 供「挑音色」弹窗帮选。
        const desc = [descOf(tags), langs].filter(Boolean).join(' · ');
        return withDesc({ id, label: String(it?.title ?? it?.name ?? (id || '未命名音色')), gender: genderFromTags(tags) }, desc);
      }).filter((o: VoiceOption) => o.id);
      // 末页判定：接口给 total 就按 total 算；给了 has_more 就用它；都没有就「整页返回＝可能还有」
      // （多拉一次空页即收，代价一次请求，换来不误判少给）。
      const cur = fishPageNumber(page);
      const total = Number(json?.total ?? json?.total_count);
      const explicit = json?.has_more;
      const hasMore = typeof explicit === 'boolean' ? explicit
        : Number.isFinite(total) && total > 0 ? cur * FISH_PAGE_SIZE < total
          : items.length >= FISH_PAGE_SIZE;
      return hasMore ? { options, next: String(cur + 1) } : { options };
    },
  },
  // MiniMax：POST {origin}/v1/get_voice {voice_type} → system_voice[] / voice_cloning[] / voice_generation[]（GroupId 走 query）
  // 一次全量、官方无分页参数 ⇒ parse 保持返回裸数组（也正是「老实现零改动兼容」的活例）。
  minimax: {
    method: 'POST',
    listUrl: (base, cred) => {
      const origin = originOf(base, 'https://api.minimax.io');
      const g = String(cred.appId || '').trim();
      return `${origin}/v1/get_voice${g ? `?GroupId=${encodeURIComponent(g)}` : ''}`;
    },
    headers: (cred) => bearer(cred.key),
    body: (_cred, filters) => ({ voice_type: 'all', ...filterBody(filters) }),
    filters: [
      {
        key: 'voice_type', label: '音色类型', default: 'all',
        hint: '接口按类型分支返回；「全部」= 系统音色 + 克隆 + 音色生成。',
        options: [
          { value: 'all', label: '全部' },
          { value: 'system', label: '系统音色' },
          { value: 'voice_cloning', label: '快速克隆' },
          { value: 'voice_generation', label: '音色生成' },
        ],
      },
    ],
    parse: (json) => {
      const groups = ['system_voice', 'voice_cloning', 'voice_generation'];
      const out: VoiceOption[] = [];
      for (const g of groups) {
        const list = Array.isArray(json?.[g]) ? json[g] : [];
        for (const it of list) {
          const id = String(it?.voice_id ?? '').trim();
          if (id) out.push(withDesc({ id, label: String(it?.voice_name ?? id), gender: 'n' }, descOf(it?.description)));
        }
      }
      return out;
    },
  },
  // ElevenLabs：GET {origin}/v2/voices?page_size=100[&next_page_token=…][&language=&category=&search=]
  //   → {voices[].{voice_id,name,labels,description}, has_more, next_page_token}
  elevenlabs: {
    method: 'GET',
    listUrl: (base, _cred, filters, page) => {
      const cursor = String(page ?? '').trim();
      return `${originOf(base, 'https://api.elevenlabs.io')}/v2/voices?page_size=${ELEVEN_PAGE_SIZE}`
        + (cursor ? `&next_page_token=${encodeURIComponent(cursor)}` : '') + queryOf(filters);
    },
    headers: (cred) => {
      const h: Record<string, string> = { 'Content-Type': 'application/json' };
      const k = String(cred.key || '').trim();
      if (k) h['xi-api-key'] = k;
      return h;
    },
    filters: [
      { key: 'language', label: '语言', default: 'zh', hint: '按音色 language 标签筛选。', options: LANG_OPTIONS },
      {
        key: 'category', label: '类别', default: '',
        options: [
          { value: '', label: '不限' },
          { value: 'premade', label: '预置' },
          { value: 'cloned', label: '克隆' },
          { value: 'generated', label: '生成' },
          { value: 'professional', label: '专业' },
        ],
      },
      { key: 'search', label: '关键词', default: '', placeholder: '按名称/描述搜索' },
    ],
    parse: (json) => {
      const list = Array.isArray(json?.voices) ? json.voices : [];
      const options = list.map((it: any): VoiceOption => {
        const id = String(it?.voice_id ?? '').trim();
        const g = String(it?.labels?.gender ?? '').toLowerCase();
        const gender: VoiceGender = g.startsWith('f') ? 'f' : g.startsWith('m') ? 'm' : 'n';
        // desc 里排掉 gender 标签：它已经落到 gender 字段，重复一遍只是噪声
        const labelsObj = it?.labels && typeof it.labels === 'object' ? it.labels as Record<string, unknown> : {};
        const labelVals = Object.entries(labelsObj).filter(([k]) => k !== 'gender').map(([, v]) => v);
        const desc = [descOf(labelVals, 5), descOf(it?.description, 2)].filter(Boolean).join(' · ');
        return withDesc({ id, label: String(it?.name ?? id), gender }, desc);
      }).filter((o: VoiceOption) => o.id);
      // 官方分页契约：has_more=true 且给了 next_page_token 才继续；缺 token 视同到底（不发无效请求）。
      const next = String(json?.next_page_token ?? '').trim();
      return json?.has_more === true && next ? { options, next } : { options };
    },
  },
};

/** 这家是否有「拉取音色列表」接口。 */
export function hasVoiceFetcher(id: string): boolean {
  return Boolean(VOICE_FETCHERS[id]);
}

/** 这家「拉取音色列表」支持的筛选条件（空 = 没有可筛的维度）。 */
export function voiceFilterSpecs(id: string): readonly VoiceFilterSpec[] {
  return VOICE_FETCHERS[id]?.filters || [];
}

/** 该家筛选条件的实际取值：已存值优先（**空串是有效值**＝用户选了「不限」），缺项落回默认。
 *  设置页渲染与拉取请求共用这一份口径，避免两处各拼一次 query 导致界面与请求不一致。 */
export function resolveVoiceFilters(
  id: string,
  stored: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of voiceFilterSpecs(id)) {
    out[spec.key] = stored && spec.key in stored ? String(stored[spec.key] ?? '') : spec.default;
  }
  return out;
}

const BY_ID = new Map(VOICE_PROVIDERS.map(p => [p.id, p]));

export function getProvider(id: unknown): VoiceProviderPreset | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

/** 按地址猜服务商（旧 voiceApi 迁移用：老用户已填的 URL 要落到对应预设上）。 */
export function detectProviderByUrl(url: unknown): string {
  const u = String(url || '').toLowerCase();
  if (!u) return 'custom';
  if (u.includes('siliconflow')) return 'siliconflow';
  if (u.includes('api.openai.com')) return 'openai';
  if (u.includes('fish.audio')) return 'fish';
  if (u.includes('minimax')) return 'minimax';
  if (u.includes('elevenlabs')) return 'elevenlabs';
  if (u.includes('xiaomimimo')) return 'mimo';
  if (u.includes('openspeech.bytedance')) return 'volcengine';
  if (/localhost|127\.0\.0\.1|\[::1\]/.test(u)) return 'local';
  return 'custom';
}

export const DEFAULT_PROVIDER_ID = 'openai';

/** 每家音色目录（`voiceCatalog`）的文本上限。除了内置音色，还要装得下「拉取音色列表」的结果——
 *  Fish 一次拉 100 条、每条 `id|标题|性别` 约 60–80 字符。旧值 4000 会把一半音色截在门外，
 *  而一旦被截掉的那条正是钉住的音色，钉住就会失效并重新分配（表现为「音色又变了」）。 */
export const VOICE_CATALOG_MAX = 8000;

/** 当前服务商（认不出回落到自定义，避免误发到别家）。 */
export function resolveProvider(id: unknown): VoiceProviderPreset {
  return getProvider(id) || getProvider('custom')!;
}

/** 选择器卡片上「需要几步配置」的说明（诚实标注，docs/35 §A.5）。
 *  appIdOptional 的家标注成「AppID 可空」——但选择器只放得下一个短语，
 *  「不推荐」的理由在凭据区的字段提示与家说明里写全（docs/62）。 */
export function authLabel(auth: VoiceAuth, appIdOptional = false): string {
  if (auth === 'appid') return appIdOptional ? 'AppID 可空' : '需 AppID+Key';
  return auth === 'key' ? '只填 Key' : '无需 Key';
}

/** AppID 型服务商第二个凭据字段的显示名（火山=AccessKey，MiniMax=API Key）。 */
export function secondCredentialLabel(provider: VoiceProviderPreset): string {
  if (provider.id === 'volcengine') return 'AccessKey';
  if (provider.id === 'minimax') return 'API Key';
  return '密钥';
}

/** 音色池：服务商自带 + 手填（id 或 id|名|f/m）+ 拉取/按家分存目录。 */
export function providerVoices(provider: VoiceProviderPreset, manualList: string, catalogList = ''): VoiceOption[] {
  const manual = parseManualVoices(manualList);
  const catalog = parseManualVoices(catalogList);
  const out: VoiceOption[] = [];
  for (const v of [...manual, ...provider.voices, ...catalog]) if (!out.some(o => o.id === v.id)) out.push(v);
  return out;
}

/** 手填音色解析：每行/逗号一项，`id` 或 `id|展示名` 或 `id|展示名|f|m|n`。 */
export function parseManualVoices(text: string): VoiceOption[] {
  const out: VoiceOption[] = [];
  for (const raw of String(text || '').split(/[\n,，]/)) {
    const item = raw.trim();
    if (!item) continue;
    const segs = item.split('|').map(s => s.trim());
    const id = segs[0];
    if (!id) continue;
    const g = segs[2];
    const gender = g === 'f' || g === 'm' ? g : 'n';
    if (!out.some(o => o.id === id)) out.push({ id, label: segs[1] || id, gender });
  }
  return out;
}

/** 音色池写回序列化（设置页表格 → 文本；与 parseManualVoices 同一张口径表，往返无损）：
 *  中性且无名称 → `id`；中性有名称 → `id|名称`；有性别无名称 → `id||f`；有性别有名称 → `id|名称|f`。
 *  名称里的 `|` 落全角「｜」、换行落空格（这两个字符是文本格式的分隔符，留在名称里会把行拆坏）；
 *  id 侧不做替换——含 `|` 的 id 由设置页校验拦下，不静默改值（它是要发给服务商的那个字符串）。 */
export function serializeVoicePool(rows: readonly VoiceOption[]): string {
  const out: string[] = [];
  for (const row of rows) {
    const id = String(row.id || '').trim();
    if (!id) continue;
    const label = String(row.label || '').trim().replace(/\|/g, '｜').replace(/[\r\n]+/g, ' ');
    const named = label && label !== id;
    const g = row.gender === 'f' || row.gender === 'm' ? row.gender : 'n';
    if (g === 'n') out.push(named ? `${id}|${label}` : id);
    else out.push(named ? `${id}|${label}|${g}` : `${id}||${g}`);
  }
  return out.join('\n');
}
