// ===== 小手机全局设置（usb_global_phone-settings_<hash>.json） =====
// 设备本地态（悬浮球/手机壳位置等）走 localStorage，不进此文件。

import { clampInt } from './ubp-utils';
import {
  createExternalObjectStore,
  type ExternalObjectStore,
} from '../../unified-statusbar/core/external-object-store';
import type { ExternalStoreStatus } from '../../unified-statusbar/core/external-storage-types';
import { createServerFileStore } from '../../unified-statusbar/core/server-file-store';
import { AI_RETRY_MAX_DEFAULT, normalizeAiRetryMax } from '../../unified-statusbar/core/constants';
import { MAX_ALBUM_ENTRIES } from './chat-model';
import { SHOP_BATCH_DEFAULT, SHOP_BATCH_RANGE, SHOP_MAX_ITEMS_DEFAULT, SHOP_MAX_ITEMS_RANGE } from './shop-model';
import { normalizePromptOverrides, promptOverrideCount } from './prompt-overrides';
import { IMAGE_PROMPT_RETIRED_KEYS } from './image-prompt-slots';
import { DEFAULT_PROVIDER_ID, detectProviderByUrl, VOICE_CATALOG_MAX, VOICE_PROVIDERS, voiceFilterSpecs } from './voice-providers';
import type { VoiceCredential } from './voice-requests';

export type PhoneDarkMode = 'auto' | 'light' | 'dark';

/** 正文联动可选的四社媒平台（第五轮 ⑦）：勾选哪些，就允许正文出现哪些平台的内容
 *  （提示词按勾选**拼装**——未勾选的平台既不教格式也不注入渲染正则、也不提取）。 */
export const STORY_LINK_SOCIAL_KINDS = ['moments', 'tieba', 'weibo', 'xhs'] as const;
export type StoryLinkSocialKind = (typeof STORY_LINK_SOCIAL_KINDS)[number];
/** 生图模式（主项目三种生图后端 + 两条插件通道）。'' = 未选择（生图被闸门拦下）。
 *  chatu8=智慧姬（st-chatu8）：生图整体转交酒馆里的智慧姬插件执行，地址/密钥/模型用智慧姬里配的那套；
 *  baibai=柏宝绘（ST-BaiBai-Image）：转交柏宝绘插件执行，后端/模型/画师串/质量词/负面/尺寸全用其「渠道」页配置。 */
export type PhoneImageMode = '' | 'novelai' | 'openai' | 'comfyui' | 'chatu8' | 'baibai';
/** 语音合成后端：off=关闭（零开销）｜system=浏览器 speechSynthesis｜api=OpenAI 兼容｜comfy=本地 ComfyUI 工作流。 */
export type PhoneVoiceBackend = 'off' | 'system' | 'api' | 'comfy';
/** 语音语速档位（0.8/1/1.2/1.5；默认 1）。 */
export const PHONE_VOICE_SPEEDS: readonly number[] = [0.8, 1, 1.2, 1.5];
/** 语音缓存上限档位（MB；默认 60）。 */
export const PHONE_VOICE_CACHE_MB: readonly number[] = [30, 60, 120];
/** 皮肤（视觉层，全局生效；''=默认。custom=用户导入的皮肤定义，本体存 customSkin 字段）。
 *  与「风格」（跟聊天的文案/提示词层）正交；详见 core/skin-themes.ts 与 docs/14。 */
export type PhoneSkinId = '' | 'sweet' | 'flirty' | 'custom';
const SKIN_IDS: readonly PhoneSkinId[] = ['', 'sweet', 'flirty', 'custom'];

/** 文本 API 分配模式：global=全体功能共用一个预设；per-feature=按功能单独绑定（留空跟随全局）。 */
export type PhoneApiMode = 'global' | 'per-feature';
/** 按功能分配的作用域（通话与聊天 / 社媒 / 窥私 / 游戏中心 / 生图提示词）。 */
export type PhoneApiScopeKey = 'chat' | 'social' | 'spy' | 'game' | 'image' | 'night';
export type PhoneApiScopes = Record<PhoneApiScopeKey, string>;

/** 按功能自动重试开关（仅 per-feature 模式生效；缺省全 false）。 */
export type PhoneRetryScopes = Record<PhoneApiScopeKey, boolean>;

/** 整体字号缩放档位（设置→通用，微信式分档滑杆；下标即滑杆值，1=现状不变）。 */
export const PHONE_FONT_SCALES: readonly number[] = [0.85, 0.92, 1, 1.08, 1.16, 1.25];

/** 整机缩放档位（设置→通用「手机缩放」，transform 等比缩放；下标即滑杆值，1=现状不变）。 */
export const PHONE_ZOOM_SCALES: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2];

/** 提示音音量档位（轻 / 中 / 响；存实际值，与 PHONE_FONT_SCALES 同款口径）。 */
export const PHONE_SOUND_VOLUMES: readonly number[] = [0.4, 0.7, 1];

/** 锁屏等待档位（秒）：折叠后超过该时长再展开才锁屏（默认 1 分钟）。 */
export const PHONE_LOCK_DELAYS: readonly number[] = [30, 60, 120, 300];

/** 桌面图标顺序上限（App id 数组；未知 id 由渲染层自然忽略，本处只管形状）。 */
export const APP_ORDER_CAP = 64;

/** 全局字体族白名单（栈定义在 styles/phone-theme 的 PHONE_FONT_FAMILIES；''=跟随风格）。
 *  用户上传字体不走此白名单——引用键为 `u:<字体id>`（fontLibrary 派生，见 normalizeUserFonts）。 */
const FONT_FAMILY_KEYS = ['song', 'hei', 'kai', 'yuan'] as const;

// ── 用户字体库（美化工坊）──
/** 用户字体条数上限。 */
export const PHONE_USER_FONT_MAX = 6;
/** 单个 dataUrl 字符上限（≈2.9MB 二进制；CJK 全量字体常超此限，建议用 woff2 子集或远程 URL）。 */
export const PHONE_USER_FONT_MAX_CHARS = 4_000_000;
/** 远程字体地址长度上限。 */
export const PHONE_USER_FONT_URL_MAX = 500;

/** 用户字体（美化工坊上传字体文件或远程 woff2；@font-face 注入 Shadow Root，仅手机 UI 生效）。 */
export interface PhoneUserFont {
  /** 引用 id（uf_ + 随机；fontFamily 引用键 = `u:<id>`）。 */
  id: string;
  /** 展示名（≤20 字）。 */
  name: string;
  /** CSS font-family 名（恒为 UBPUserFont_<id>，normalize 派生——外部传什么都会被改写）。 */
  family: string;
  /** 来源：data=上传文件（dataUrl）/ url=远程字体地址（仅 https）。 */
  source: 'data' | 'url';
  dataUrl?: string;
  url?: string;
  /** @font-face format() 提示。 */
  format: 'woff2' | 'woff' | 'truetype' | 'opentype';
}

/** 生成用户字体 id（随机 8 位十六进制，带前缀；碰撞概率可忽略）。 */
export function makeUserFontId(): string {
  return `uf_${Math.random().toString(16).slice(2, 10)}`;
}

const USER_FONT_DATA_RE = /^data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff2?|x-font-ttf|octet-stream));base64,[A-Za-z0-9+/=]+$/;
const USER_FONT_FORMATS: ReadonlyArray<PhoneUserFont['format']> = ['woff2', 'woff', 'truetype', 'opentype'];

/** 用户字体归一化（逐条清洗：family 恒由 id 派生；data 校验 base64 形状与体积；url 仅 https；超量截断）。 */
function normalizeUserFonts(value: unknown): PhoneUserFont[] {
  if (!Array.isArray(value)) return [];
  const out: PhoneUserFont[] = [];
  for (const raw of value) {
    if (out.length >= PHONE_USER_FONT_MAX) break;
    const rec = pickRecordLocal(raw);
    if (!rec) continue;
    const id = typeof rec.id === 'string' && /^uf_[a-z0-9]{6,12}$/.test(rec.id) ? rec.id : '';
    if (!id) continue;
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 20) : '';
    const format = USER_FONT_FORMATS.includes(rec.format as PhoneUserFont['format']) ? rec.format as PhoneUserFont['format'] : 'woff2';
    let font: PhoneUserFont | null = null;
    if (rec.source === 'data') {
      const dataUrl = typeof rec.dataUrl === 'string' ? rec.dataUrl.slice(0, PHONE_USER_FONT_MAX_CHARS) : '';
      if (USER_FONT_DATA_RE.test(dataUrl)) font = { id, name: name || '未命名字体', family: `UBPUserFont_${id}`, source: 'data', dataUrl, format };
    } else if (rec.source === 'url') {
      const url = typeof rec.url === 'string' ? rec.url.trim().slice(0, PHONE_USER_FONT_URL_MAX) : '';
      if (/^https:\/\//.test(url)) font = { id, name: name || '未命名字体', family: `UBPUserFont_${id}`, source: 'url', url, format };
    }
    if (font) out.push(font);
  }
  return out;
}

/** 社媒选题条目（用户自定义选题池；结构对齐 core/social-prompts 的 SocialTheme，引擎直接消费）。 */
export interface PhoneSocialTheme {
  id: string;
  /** 选题名（注入指令「本次选题方向」）。 */
  label: string;
  /** 该选题的写作指导。 */
  guide: string;
}

export interface PhoneSettings {
  /** 档结构代次（2 起：商城货架上限出厂默认 100；1 档里的旧默认 40 由 normalize 一次性迁移）。 */
  schema: 1 | 2;
  /** 文本 API 分配模式（预设仓库=主项目 customApiPresets；''=走酒馆主 API）。 */
  apiMode: PhoneApiMode;
  /** 全局文本 API 预设 id（'' = 酒馆主 API）。 */
  apiPresetId: string;
  /** 按功能绑定预设（仅 per-feature 模式生效；''=跟随全局）。 */
  apiScopes: PhoneApiScopes;
  /** AI 请求失败自动重试总开关（global 模式生效；per-feature 模式改用 aiRetryScopes）。默认关。 */
  aiRetryEnabled: boolean;
  /** 最大重试次数（1-5；总请求次数 = 该值 + 1）。默认 3。 */
  aiRetryMax: number;
  /** 按功能自动重试开关（仅 per-feature 模式生效）。 */
  aiRetryScopes: PhoneRetryScopes;
  /** AI 进行中通知常驻：true=酒馆 toast 常驻；false（默认）=3 秒自动隐去（灵动岛/浮球不变）。 */
  aiNoticePersist: boolean;
  /** 生图模式（必须显式选择；配置本体跟主项目走，小手机只存选择）。 */
  imageMode: PhoneImageMode;
  /** 生图提示词预设 id（主项目 imageGeneration.promptPresets；'' = 未选择）。 */
  imagePresetId: string;
  /** 资料块携带的剧情纪要条数（聊天/通话/社媒共用，从旧到新展示；0-10，0=不带）。 */
  summaryCount: number;
  /** 资料块中提供给 AI 的正文楼层数（聊天/通话共用；仅 AI 回复，全量、过上下文标签剥离；0=不带正文，默认 0）。 */
  chatHistoryCount: number;
  /** 社媒刷新资料块携带的正文楼层数（朋友圈/贴吧/微博/小红书共用；0=不带正文）。 */
  socialHistoryCount: number;
  /** 社媒指令提示词覆盖（键=`平台:风格:分支`，见 core/social-prompt-templates；空/缺省=用内置默认）。 */
  socialPrompts: Record<string, string>;
  /** 社媒选题池覆盖（键=`平台:风格`；空/缺省=用内置默认池）。 */
  socialThemes: Record<string, PhoneSocialTheme[]>;
  /** 生图提示词覆盖（键=`image:场景:槽位`，见 core/image-prompt-slots；空/缺省=用内置默认）。
   *  只承载「怎么写」（场景增补/标签网格/要求提示词…）；输出结构契约与示例固定不可改。 */
  imagePrompts: Record<string, string>;
  /** 不夜城提示词覆盖（键=`night:<玩法>` / `night:rules` / `night:board:<板块>`，见 core/night-prompt-slots；
   *  空/缺省=用内置默认）。只承载「任务+规则 / 总纪律 / 板块 brief」；输出格式契约与平台头固定不可改。 */
  nightPrompts: Record<string, string>;
  /** 四个社媒平台共享的保留帖子数（滚动窗口上限，超出滚动删最旧；10-80）。 */
  socialMaxPosts: number;
  /** 社媒触发注入携带的通讯录随机人物名数量（朋友圈刷新与求回应+三个独立 App 共用；0=不注入）。 */
  socialTriggerContacts: number;
  /** 群聊绿灯注入人数上限（被@者恒注入并计入名额；1-10）。 */
  groupTriggerCap: number;
  /** 最近手机记录混合块条数（微信私聊消息/通话/朋友圈与社媒帖子/群聊块混排；群聊块=按主角发言+故事时间分块只注入参与者，本群自身消息单独成段；私聊/群聊/通话/社媒反馈共用，10-100）。 */
  phoneHistoryCount: number;
  /** 图片消息自动生图（聊天图片+朋友圈+贴吧/微博/小红书+窥私配图 全部共用一个开关）。 */
  autoImageGen: boolean;
  /** 自动备份间隔：每 N 层 AI 回复备份一次当前聊天的小手机数据（1-999；对齐主项目备份机制）。 */
  phoneBackupInterval: number;
  /** 额外要求（拼进指令模板，≤500 字）。 */
  extraPrompt: string;
  /** 正文联动：正文微信/电话片段渲染+提取进手机（开启=注入条目+正则+CSS，关闭=全部移除）。 */
  storyLink: boolean;
  /** 正文联动·允许出现的社媒平台（第五轮 ⑦；空数组=不写社媒。只影响正文联动，不影响世界演化投递）。 */
  storyLinkSocial: StoryLinkSocialKind[];
  /** 消息记录注入世界书：各角色最近手机记录混合块经主项目投影调度写入角色主世界书（正文互通）。 */
  messageWorldbook: boolean;
  /** 公共内容投影：额外注入 1 条常驻「公共舆论」条目（热搜榜+公开平台帖；从属于 messageWorldbook；默认关——常驻注入每轮占提示词预算）。 */
  projectPublic: boolean;
  /** 窥私功能总开关（角色间私密互动演绎 APP；关=桌面 App 置灰提示）。 */
  spyEnabled: boolean;
  /** 窥私角色记忆条数（窥私记录混合块；经角色名绿灯世界书条目注入——窥私请求与正文请求共用，0-100，0=不投影）。 */
  spyHistoryCount: number;
  /** 窥私记录注入世界书（防全知说明=主角不知晓；分角色条目角色名绿灯触发）。 */
  spyWorldbook: boolean;
  /** 窥私自动生成（AI 回复结束后按演化轮数间隔触发，世界演化同款事件监听）。 */
  spyAutoGen: boolean;
  /** 窥私请求焦点人数（排除在场角色后随机抽取；2-10）。 */
  spyFocusCount: number;
  /** 窥私期望生成内容数（每次生成的通话/私聊/群聊块数；1-6，含至少一块群聊）。 */
  spyContentCount: number;
  /** 不夜城图文比（50/70/90；默认 70。「暗房」板块恒为 100%）。 */
  nightImageRatio: 50 | 70 | 90;
  /** 默认揭层级（0 轮廓 / 1 局部 / 2 全图；默认 0=轮廓）。 */
  nightRevealDefault: 0 | 1 | 2;
  /** 新图是否打码总开关（关=新图直接全图；默认开）。 */
  nightMaskDefault: boolean;
  /** 不夜城生图提示词的独立文字 API（默认关=跟随共用「生图（提示词）」预设）。 */
  nightImageApi: boolean;
  /** 不夜城生图提示词的独立 API 预设 id（主项目 customApiPresets；''=跟随共用，见 phone-api.resolveNightImageApi）。 */
  nightImageApiPresetId: string;
  /** 不夜城保留内容数（滚动窗口；10-80，默认 40）。 */
  nightMaxPosts: number;
  /** 不夜城触发随机人物数（0-10，默认 3）。 */
  nightTriggerContacts: number;
  /** 单场直播轮数上限（1-30，默认 12）。 */
  nightLiveRounds: number;
  /** 点单台（默认开；关=直播间不显示点单入口）。 */
  nightOrders: boolean;
  /** 约会进程（默认开；关=约见卡退回普通私信）。 */
  nightDates: boolean;
  /** 私密收藏夹需长按解锁（默认开）。 */
  nightFavLock: boolean;
  /** 商城货架物品上限（超出淘汰最旧的非保护商品；20-100，默认 100）。收藏与购物车里的商品不受淘汰。 */
  shopMaxItems: number;
  /** 商城每批上货件数（4-16，默认 8）。 */
  shopBatchSize: number;
  /** 相册循环删除（默认开：超出「最多保留图片数量」时丢最旧并删服务器文件；关=不自动删除，数量自由增长）。 */
  albumCycleDelete: boolean;
  /** 相册最多保留图片数量（仅循环删除开启时生效；只约束非收藏条目，收藏恒保留。10-2000，默认 200）。 */
  albumMaxEntries: number;
  /** 主题模式。 */
  darkMode: PhoneDarkMode;
  /** 整体字号缩放（PHONE_FONT_SCALES 之一，默认 1=现状；calc 缩放仅文字，不动图标/布局）。 */
  fontScale: number;
  /** 整机缩放（PHONE_ZOOM_SCALES 之一，默认 1=现状；transform 等比缩放整机，字体/图标/布局一起缩）。 */
  phoneZoom: number;
  /** 全局字体族（''=跟随风格：现代=系统字体/仙侠=楷体；具体值覆盖皮肤；'u:<id>'=用户字体库引用）。 */
  fontFamily: string;
  /** 皮肤（视觉换装，全局；''=默认，sweet/flirty=内置，custom=用 customSkin 定义渲染）。 */
  skin: PhoneSkinId;
  /** 自定义皮肤定义（导入时已经 normalizePhoneSkin 校验；消费侧再防御式清洗，结构见 core/skin-themes.ts）。 */
  customSkin: Record<string, unknown> | null;
  /** 用户字体库（美化工坊上传/远程；@font-face 注入 Shadow Root；上限 PHONE_USER_FONT_MAX 条）。 */
  fontLibrary: PhoneUserFont[];
  // ── 提示音与震动（I-3） ──
  /** 提示音总开关（消息/发送/快门；默认开）。 */
  soundOn: boolean;
  /** 提示音音量（PHONE_SOUND_VOLUMES 取值；默认 0.7=中）。 */
  soundVolume: number;
  /** 键盘音开关（聊天输入框按键轻点；默认关——打字时每键都响是负担）。 */
  keyboardSound: boolean;
  /** 震动开关（默认开；iOS 无 vibrate API，该平台自然无效）。 */
  vibrateOn: boolean;
  /** 静音（控制中心开关；=不出声，**不影响震动与通知横幅**，真机语义：静音≠免打扰）。 */
  silent: boolean;
  // ── 通话全屏层顶栏（方案 C；默认收起＝对话区最大化） ──
  /** 通话中顶栏展开态：false=紧凑信息带（头像 46px 横排），true=大版式（头像 88px 竖向居中）。
   *  振铃/来电态不走本开关（那时没有对白，恒为大版式）；只影响接通后的顶栏。 */
  callBarExpanded: boolean;
  // ── 锁屏（I-1，默认关＝现状零变化） ──
  /** 锁屏总开关（默认关）。 */
  lockScreenEnabled: boolean;
  /** 折叠后多久才上锁（PHONE_LOCK_DELAYS 取值秒数；默认 60）。 */
  lockScreenDelaySec: number;
  // ── 桌面图标顺序（I-5，仅排序；全局储存，与设置同一层） ──
  /** 桌面网格图标顺序（App id 的数组；未列出的 App 由渲染层追加到末尾）。 */
  appOrder: string[];
  // ── 语音合成（TTS，第 31 篇；默认 off＝零开销，不引依赖） ──
  /** 语音总开关（TTS）：关=整块语音配置不渲染、播放条失效、情绪/演绎提示词不注入；默认关（零开销）。
   *  老存档没有本字段时按「voiceBackend 是否非 off」推导（旧版用后端下拉里的「关闭」当总开关）。 */
  voiceEnabled: boolean;
  /** 语音后端（system/api/comfy；off 仅作内部哨兵与老存档兼容，界面由总开关收口）。 */
  voiceBackend: PhoneVoiceBackend;
  /** 语速（PHONE_VOICE_SPEEDS 取值；默认 1）。 */
  voiceSpeed: number;
  /** 自动分配音色（按角色性别/年龄 + hash(名字) 稳定选；默认 true）。 */
  voiceAutoAssign: boolean;
  /** 当前语音服务商 id（见 core/voice-providers 的 VOICE_PROVIDERS；默认 openai）。 */
  voiceProvider: string;
  /** 按服务商分存的凭据（切服务商不丢已填 Key；key/appId/accessKey/model/voice/url/format）。 */
  voiceCredentials: Record<string, VoiceCredential>;
  /** 情绪演绎（让模型给每句台词标「情绪|演绎」，按服务商自动改写；默认 true）。 */
  voiceEmotion: boolean;
  /** 旧版单条 OpenAI 兼容配置（已迁移进 voiceCredentials；保留仅为读回老存档）。 */
  voiceApi: { url: string; model: string; format: 'mp3' | 'wav' };
  /** 手填候选音色（逗号/换行分隔，`id` 或 `id|展示名|f|m|n`；并入内置目录供自动分配）。 */
  voiceApiVoices: string;
  /** 按服务商分存的音色目录（「拉取音色列表」或手填；`id|展示名|f|m|n` 每行一项；并入该家音色池）。 */
  voiceCatalog: Record<string, string>;
  /** 「拉取音色列表」的筛选条件（按服务商分存：providerId → { 字段名: 值 }）。
   *  只对接口支持筛选的家有效（Fish 语言/标签、MiniMax 音色类型、ElevenLabs 语言/类别/关键词）；
   *  空串是有效值＝「不限」（不等于「没设置」，故用 voice-providers.resolveVoiceFilters 归一）。 */
  voiceFetchFilters: Record<string, Record<string, string>>;
  /** 本地 ComfyUI 语音工作流（API 格式 JSON；useHostImageUrl=跟随主项目生图 ComfyUI 地址）。 */
  voiceComfy: { url: string; workflow: string; useHostImageUrl: boolean };
  /** 每角色参考音频（ComfyUI input/ 内文件名；声音克隆用；空=用工作流内置默认）。 */
  voiceRefAudio: Record<string, string>;
  /** 角色音色手动覆盖（按后端分开存：system/api）。 */
  voiceMap: { system: Record<string, string>; api: Record<string, string> };
  /** 角色 → 指定服务商 id（空/缺省 = 跟随全局 `voiceProvider`；支持不同角色来自不同厂商）。 */
  voiceRoleProvider: Record<string, string>;
  /** 角色 → **已钉住的自动分配结果**（`autoVoicePick`：{p 服务商, v 音色, g 分桶性别}）。
   *  首次自动决定后落库，之后只读校验——拉取音色列表/手填新音色不再让同一角色换声（docs/38）。 */
  voiceAutoPick: Record<string, { p: string; v: string; g: string }>;
  /** 通话逐句朗读（默认 false；开启后对方每说一句念一句）。 */
  voiceReadCalls: boolean;
  /** 窥私语音隔墙失真（低通+衰减；仅 api/comfy 后端生效；默认 true）。 */
  voiceSpyMuffle: boolean;
  /** 语音缓存上限（PHONE_VOICE_CACHE_MB 取值，MB；默认 60）。 */
  voiceCacheMaxMB: number;
  /** 预合成最近未读语音（仅 api/comfy 后端；默认 true）。 */
  voicePreGen: boolean;
}

// ===== 归一化辅助 =====

/** 按功能 API 作用域归一化（''=跟随全局；老数据无此字段全空）。 */
function normalizeApiScopes(value: unknown): PhoneApiScopes {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const pick = (key: PhoneApiScopeKey): string =>
    typeof raw[key] === 'string' ? (raw[key] as string).slice(0, 64) : '';
  return { chat: pick('chat'), social: pick('social'), spy: pick('spy'), game: pick('game'), image: pick('image'), night: pick('night') };
}

/** 按功能重试开关归一化（老数据无此字段全 false；非 true 一律当 false）。 */
function normalizeRetryScopes(value: unknown): PhoneRetryScopes {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const pick = (key: PhoneApiScopeKey): boolean => raw[key] === true;
  return { chat: pick('chat'), social: pick('social'), spy: pick('spy'), game: pick('game'), image: pick('image'), night: pick('night') };
}

// ===== 提示词自定义（四张覆盖表）归一化 =====
// 文本表（socialPrompts / imagePrompts / nightPrompts）走领域无关的 core/prompt-overrides（形状/长度/键数兜底）；
// 选题池是结构化条目表，本文件单独归一化。键语法由各领域模块定义，未知键天然回落内置默认，
// 故此处无需重复白名单，避免两处事实源漂移。上限防脏数据把设置文件撑爆。

const SOCIAL_THEME_KEYS_CAP = 32;
const SOCIAL_THEME_ITEMS_CAP = 30;

function normalizeSocialThemes(value: unknown): Record<string, PhoneSocialTheme[]> {
  const raw = pickRecordLocal(value);
  if (!raw) return {};
  const out: Record<string, PhoneSocialTheme[]> = {};
  for (const [key, list] of Object.entries(raw)) {
    if (Object.keys(out).length >= SOCIAL_THEME_KEYS_CAP) break;
    const k = key.slice(0, 64);
    if (!k || !Array.isArray(list)) continue;
    const items: PhoneSocialTheme[] = [];
    for (const item of list) {
      if (items.length >= SOCIAL_THEME_ITEMS_CAP) break;
      const rec = pickRecordLocal(item);
      if (!rec) continue;
      const label = typeof rec.label === 'string' ? rec.label.trim().slice(0, 40) : '';
      const guide = typeof rec.guide === 'string' ? rec.guide.trim().slice(0, 300) : '';
      if (!label && !guide) continue;
      const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim().slice(0, 40) : `c${items.length + 1}`;
      items.push({ id, label, guide });
    }
    if (!items.length) continue;
    out[k] = items;
  }
  return out;
}

/** 社媒自定义数量（提示词套数 + 选题池数；设置页/编辑器徽标用）。 */
export function socialCustomCount(settings: PhoneSettings): number {
  return promptOverrideCount(settings.socialPrompts, settings.socialThemes);
}

/** 清掉已退休的槽位覆盖键（固定标签规则/注记已回归写死常量）。 */
function pruneRetiredImagePrompts(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...map };
  for (const retired of IMAGE_PROMPT_RETIRED_KEYS) delete out[retired];
  return out;
}

/** 生图提示词自定义数量（槽位数；退休键不计）。 */
export function imagePromptCustomCount(settings: PhoneSettings): number {
  return promptOverrideCount(pruneRetiredImagePrompts(settings.imagePrompts || {}));
}

/** 不夜城提示词自定义数量（玩法 + 总纪律 + 板块 brief）。 */
export function nightCustomCount(settings: PhoneSettings): number {
  return promptOverrideCount(settings.nightPrompts);
}

/** 提示词自定义总数（社媒 + 生图 + 不夜城；设置页「提示词」入口徽标用）。 */
export function promptCustomCount(settings: PhoneSettings): number {
  return socialCustomCount(settings) + imagePromptCustomCount(settings) + nightCustomCount(settings);
}

/** 自定义皮肤定义透传（仅收合法普通对象；叶子字段由消费侧 skin-themes 防御式清洗）。 */
function pickRecordLocal(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 按用户顺序排列 App（I-5 图标整理，纯函数）：
 *  · 在 order 里出现且存在的 → 按 order 的顺序；
 *  · order 未列出的（新注册的 App、被写坏的 id 对应不上）→ 按注册顺序追加到末尾 ⇒ 新增 App 自动排最后，
 *    不必回来改顺序；order 为空/全是陌生 id 时结果与注册顺序完全一致（＝现状零变化）。 */
export function orderApply<T extends { id: string }>(apps: readonly T[], order: readonly string[]): T[] {
  if (!order.length) return apps.slice();
  const rest = new Map(apps.map(a => [a.id, a]));
  const out: T[] = [];
  for (const id of order) {
    const app = rest.get(id);
    if (!app) continue;
    out.push(app);
    rest.delete(id);
  }
  for (const app of apps) {
    if (rest.has(app.id)) out.push(app);
  }
  return out;
}

// ===== 语音（TTS）配置归一化 =====

function normalizeVoiceApi(value: unknown): PhoneSettings['voiceApi'] {
  const raw = pickRecordLocal(value) || {};
  return {
    url: typeof raw.url === 'string' ? raw.url.trim().slice(0, 400) : '',
    model: typeof raw.model === 'string' ? raw.model.trim().slice(0, 120) : '',
    format: raw.format === 'wav' ? 'wav' : 'mp3',
  };
}

/** 按服务商分存的凭据归一化（只保留已知字段；服务商 id 上限 32、最多 20 家）。 */
function normalizeVoiceCredentials(value: unknown): Record<string, VoiceCredential> {
  const raw = pickRecordLocal(value);
  if (!raw) return {};
  const out: Record<string, VoiceCredential> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 20) break;
    const id = String(k).slice(0, 32);
    const rec = pickRecordLocal(v);
    if (!id || !rec) continue;
    const cred: VoiceCredential = {};
    if (typeof rec.key === 'string') cred.key = rec.key.slice(0, 400);
    if (typeof rec.appId === 'string') cred.appId = rec.appId.trim().slice(0, 200);
    if (typeof rec.accessKey === 'string') cred.accessKey = rec.accessKey.slice(0, 400);
    if (typeof rec.model === 'string') cred.model = rec.model.trim().slice(0, 120);
    if (typeof rec.voice === 'string') cred.voice = rec.voice.trim().slice(0, 200);
    if (typeof rec.url === 'string') cred.url = rec.url.trim().slice(0, 400);
    if (typeof rec.resourceId === 'string') cred.resourceId = rec.resourceId.trim().slice(0, 80);
    if (rec.format === 'wav' || rec.format === 'mp3') cred.format = rec.format;
    out[id] = cred;
  }
  return out;
}

function normalizeVoiceComfy(value: unknown): PhoneSettings['voiceComfy'] {
  const raw = pickRecordLocal(value) || {};
  return {
    url: typeof raw.url === 'string' ? raw.url.trim().slice(0, 400) : '',
    workflow: typeof raw.workflow === 'string' ? raw.workflow.slice(0, 400000) : '',
    useHostImageUrl: raw.useHostImageUrl !== false,
  };
}

function normalizeVoiceRefAudio(value: unknown): Record<string, string> {
  const raw = pickRecordLocal(value);
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 200) break;
    const name = String(k).slice(0, 64);
    const file = typeof v === 'string' ? v.trim().slice(0, 240) : '';
    if (!name || !file) continue;
    out[name] = file;
  }
  return out;
}

function normalizeVoiceMap(value: unknown): PhoneSettings['voiceMap'] {
  const raw = pickRecordLocal(value) || {};
  const pick = (v: unknown): Record<string, string> => {
    const rec = pickRecordLocal(v);
    if (!rec) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(rec)) {
      if (Object.keys(out).length >= 200) break;
      const name = String(k).slice(0, 64);
      const voice = typeof val === 'string' ? val.slice(0, 160) : '';
      if (name && voice) out[name] = voice;
    }
    return out;
  };
  return { system: pick(raw.system), api: pick(raw.api) };
}

/** 按服务商分存的音色目录归一化（provider id → 列表文本；每家限长 VOICE_CATALOG_MAX、最多 20 家）。 */
function normalizeVoiceCatalog(value: unknown): Record<string, string> {
  const raw = pickRecordLocal(value);
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 20) break;
    const id = String(k).slice(0, 32);
    const text = typeof v === 'string' ? v.slice(0, VOICE_CATALOG_MAX) : '';
    if (id && text) out[id] = text;
  }
  return out;
}

/** 拉取筛选条件归一化（只收「有该筛选维度的服务商」+「该家已声明的字段」，脏键丢弃；最多 20 家）。
 *  注意保留空串：空串＝用户明确选了「不限」，与「没设置过（用默认值）」是两回事。 */
function normalizeVoiceFetchFilters(value: unknown): Record<string, Record<string, string>> {
  const raw = pickRecordLocal(value);
  if (!raw) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 20) break;
    const providerId = String(k).slice(0, 32);
    const specs = voiceFilterSpecs(providerId);
    if (!providerId || !specs.length) continue;
    const inner = pickRecordLocal(v);
    if (!inner) continue;
    const picked: Record<string, string> = {};
    for (const spec of specs) {
      if (!(spec.key in inner)) continue;
      picked[spec.key] = String(inner[spec.key] ?? '').slice(0, 128);
    }
    if (Object.keys(picked).length) out[providerId] = picked;
  }
  return out;
}

/** 角色 → 服务商 归一化（只收已知服务商 id，避免脏值；最多 200 角色）。 */
function normalizeVoiceRoleProvider(value: unknown): Record<string, string> {
  const raw = pickRecordLocal(value);
  if (!raw) return {};
  const known = new Set(VOICE_PROVIDERS.map(p => p.id));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 200) break;
    const name = String(k).slice(0, 64);
    const id = typeof v === 'string' ? v.slice(0, 32) : '';
    if (name && id && known.has(id)) out[name] = id;
  }
  return out;
}

/** 钉住的自动音色（角色 → {p,v,g}）。三条都要非空才算有效条目；音色 id 是唯一必需项。 */
function normalizeVoiceAutoPick(value: unknown): PhoneSettings['voiceAutoPick'] {
  const raw = pickRecordLocal(value);
  if (!raw) return {};
  const out: PhoneSettings['voiceAutoPick'] = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 200) break;
    const name = String(k).slice(0, 64);
    const rec = pickRecordLocal(v);
    const pick = typeof rec?.v === 'string' ? rec.v.trim().slice(0, 200) : '';
    if (!name || !pick) continue;
    out[name] = {
      p: typeof rec?.p === 'string' ? rec.p.slice(0, 32) : '',
      v: pick,
      g: rec?.g === 'f' || rec?.g === 'm' ? rec.g : 'n',
    };
  }
  return out;
}

export function defaultPhoneSettings(): PhoneSettings {  return {
    schema: 2,
    apiMode: 'global',
    apiPresetId: '',
    apiScopes: { chat: '', social: '', spy: '', game: '', image: '', night: '' },
    aiRetryEnabled: false,
    aiRetryMax: AI_RETRY_MAX_DEFAULT,
    aiRetryScopes: { chat: false, social: false, spy: false, game: false, image: false, night: false },
    aiNoticePersist: false,
    imageMode: '',
    imagePresetId: '',
    summaryCount: 5,
    chatHistoryCount: 0,
    socialHistoryCount: 4,
    socialPrompts: {},
    socialThemes: {},
    imagePrompts: {},
    nightPrompts: {},
    socialMaxPosts: 40,
    socialTriggerContacts: 3,
    groupTriggerCap: 5,
    phoneHistoryCount: 30,
    autoImageGen: true,
    phoneBackupInterval: 5,
    extraPrompt: '',
    storyLink: false,
    storyLinkSocial: [],
    messageWorldbook: false,
    projectPublic: false,
    spyEnabled: false,
    spyHistoryCount: 40,
    spyWorldbook: false,
    spyAutoGen: false,
    spyFocusCount: 5,
    spyContentCount: 3,
    nightImageRatio: 70,
    nightRevealDefault: 0,
    nightMaskDefault: true,
    nightImageApi: false,
    nightImageApiPresetId: '',
    nightMaxPosts: 40,
    nightTriggerContacts: 3,
    nightLiveRounds: 12,
    nightOrders: true,
    nightDates: true,
    nightFavLock: true,
    shopMaxItems: SHOP_MAX_ITEMS_DEFAULT,
    shopBatchSize: SHOP_BATCH_DEFAULT,
    albumCycleDelete: true,
    albumMaxEntries: MAX_ALBUM_ENTRIES,
    darkMode: 'auto',
    fontScale: 1,
    phoneZoom: 1,
    fontFamily: '',
    skin: '',
    customSkin: null,
    fontLibrary: [],
    soundOn: true,
    soundVolume: 0.7,
    keyboardSound: false,
    vibrateOn: true,
    silent: false,
    callBarExpanded: false,
    lockScreenEnabled: false,
    lockScreenDelaySec: 60,
    appOrder: [],
    voiceEnabled: false,
    voiceBackend: 'off',
    voiceSpeed: 1,
    voiceAutoAssign: true,
    voiceProvider: DEFAULT_PROVIDER_ID,
    voiceCredentials: {},
    voiceEmotion: true,
    voiceApi: { url: '', model: '', format: 'mp3' },
    voiceApiVoices: '',
    voiceCatalog: {},
    voiceFetchFilters: {},
    voiceComfy: { url: '', workflow: '', useHostImageUrl: true },
    voiceRefAudio: {},
    voiceMap: { system: {}, api: {} },
    voiceRoleProvider: {},
    voiceAutoPick: {},
    voiceReadCalls: false,
    voiceSpyMuffle: true,
    voiceCacheMaxMB: 60,
    voicePreGen: true,
  };
}

/** 缩放吸附到最近档位（脏值/越界一并兜住；档位表首位兜底，脏值=1 时取 1 所在档）。
 *  字号（PHONE_FONT_SCALES）与整机（PHONE_ZOOM_SCALES）两档共用；1=默认档。 */
function snapScale(value: unknown, scales: readonly number[]): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  let best = scales[0];
  for (const step of scales) {
    if (Math.abs(step - n) < Math.abs(best - n)) best = step;
  }
  return best;
}

/** 数值吸附到最近档位并带**指定**兜底（`snapScale` 的兜底是"最接近 1 的档"，对音量/时长不合适：
 *  音量脏值应回落"中"而不是"响"，锁屏时长应回落 60 秒而不是档位表首位）。 */
function snapTo(value: unknown, scales: readonly number[], fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  let best = scales[0];
  for (const step of scales) {
    if (Math.abs(step - n) < Math.abs(best - n)) best = step;
  }
  return best;
}

/** 桌面图标顺序归一化（形状层）：只收非空字符串、去重、限长限量。
 *  **不在这里剔除已下线 App 的 id**——注册表在 renderers，core 不认识它；
 *  渲染层的 `orderApply` 天然忽略匹配不到的 id（它们排不进网格，也不影响别的图标）。 */
export function normalizeAppOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (out.length >= APP_ORDER_CAP) break;
    if (typeof raw !== 'string') continue;
    const id = raw.trim().slice(0, 64);
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** 社媒平台勾选归一化（纯函数）：白名单过滤 + 去重 + 保序（按白名单顺序，与 UI 展示一致）。 */
export function normalizeStoryLinkSocial(value: unknown): StoryLinkSocialKind[] {
  if (!Array.isArray(value)) return [];
  const picked = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    if ((STORY_LINK_SOCIAL_KINDS as readonly string[]).includes(raw)) picked.add(raw);
  }
  return STORY_LINK_SOCIAL_KINDS.filter(kind => picked.has(kind));
}

/** 服务商 / 凭据 / 情绪三件：新字段优先；老存档把旧 voiceApi 迁移到对应服务商（不丢已填 Key）。 */
function migrateVoiceProvider(raw: Record<string, unknown>): Pick<PhoneSettings, 'voiceProvider' | 'voiceCredentials' | 'voiceEmotion'> {
  const creds = normalizeVoiceCredentials(raw.voiceCredentials);
  let provider = typeof raw.voiceProvider === 'string' ? raw.voiceProvider.slice(0, 32) : '';
  if (!Object.keys(creds).length) {
    const legacy = normalizeVoiceApi(raw.voiceApi);
    if (legacy.url || legacy.model) {
      const id = detectProviderByUrl(legacy.url);
      const cred: VoiceCredential = { format: legacy.format };
      if (legacy.url) cred.url = legacy.url;
      if (legacy.model) cred.model = legacy.model;
      creds[id] = cred;
      if (!provider) provider = id;
    }
  }
  return {
    voiceProvider: provider || DEFAULT_PROVIDER_ID,
    voiceCredentials: creds,
    voiceEmotion: raw.voiceEmotion === undefined ? true : raw.voiceEmotion === true,
  };
}

export function normalizePhoneSettings(value: unknown): PhoneSettings {  const d = defaultPhoneSettings();
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const darkMode = raw.darkMode === 'light' || raw.darkMode === 'dark' ? raw.darkMode : 'auto';
  const imageMode = raw.imageMode === 'novelai' || raw.imageMode === 'openai' || raw.imageMode === 'comfyui' || raw.imageMode === 'chatu8' || raw.imageMode === 'baibai'
    ? raw.imageMode
    : '';
  // 老数据迁移：apiSource('' /'tavern'/预设id) → apiPresetId('' /预设id)；''=走酒馆主 API
  const legacySource = typeof raw.apiSource === 'string' ? raw.apiSource.slice(0, 64) : '';
  const migratedPresetId = legacySource === 'tavern' ? '' : legacySource;
  // 老数据迁移：三个 App 各自 maxPosts → 共享 socialMaxPosts（取贴吧档）
  const legacyApps = raw.socialApps && typeof raw.socialApps === 'object'
    ? raw.socialApps as Record<string, unknown>
    : {};
  const legacyTieba = legacyApps.tieba && typeof legacyApps.tieba === 'object'
    ? legacyApps.tieba as Record<string, unknown>
    : {};
  // 老数据迁移（2026-10-06 用户定案）：货架上限出厂默认 40 → 100。保存写的是**整份归一化对象**
  // ⇒ 老档里「没改过」的那一项也被固化成 40 了，只改代码默认值救不回来。schema<2 的档里恰好等于
  // 旧默认 40 的一并升到新默认 100（刻意要 40 的用户改一次即生效：写回后 schema=2 不再迁移）。
  const legacyShopCap = Number(raw.schema) < 2 && Math.floor(Number(raw.shopMaxItems)) === 40;
  const shopMaxItems = legacyShopCap
    ? SHOP_MAX_ITEMS_DEFAULT
    : clampInt(raw.shopMaxItems, SHOP_MAX_ITEMS_RANGE[0], SHOP_MAX_ITEMS_RANGE[1], d.shopMaxItems);
  return {
    schema: 2,
    apiMode: raw.apiMode === 'per-feature' ? 'per-feature' : 'global',
    apiPresetId: typeof raw.apiPresetId === 'string' ? raw.apiPresetId.slice(0, 64) : migratedPresetId,
    apiScopes: normalizeApiScopes(raw.apiScopes),
    aiRetryEnabled: raw.aiRetryEnabled === true,
    aiRetryMax: normalizeAiRetryMax(raw.aiRetryMax),
    aiRetryScopes: normalizeRetryScopes(raw.aiRetryScopes),
    aiNoticePersist: raw.aiNoticePersist === true,
    imageMode,
    imagePresetId: typeof raw.imagePresetId === 'string' ? raw.imagePresetId.slice(0, 64) : '',
    summaryCount: clampInt(raw.summaryCount, 0, 99, d.summaryCount),
    chatHistoryCount: clampInt(raw.chatHistoryCount, 0, 20, d.chatHistoryCount),
    socialHistoryCount: clampInt(raw.socialHistoryCount, 0, 20, d.socialHistoryCount),
    socialPrompts: normalizePromptOverrides(raw.socialPrompts),
    socialThemes: normalizeSocialThemes(raw.socialThemes),
    imagePrompts: pruneRetiredImagePrompts(normalizePromptOverrides(raw.imagePrompts)),
    nightPrompts: normalizePromptOverrides(raw.nightPrompts),
    socialMaxPosts: clampInt(raw.socialMaxPosts ?? legacyTieba.maxPosts, 10, 80, d.socialMaxPosts),
    socialTriggerContacts: clampInt(raw.socialTriggerContacts, 0, 10, d.socialTriggerContacts),
    groupTriggerCap: clampInt(raw.groupTriggerCap, 1, 10, d.groupTriggerCap),
    phoneHistoryCount: clampInt(raw.phoneHistoryCount, 10, 100, d.phoneHistoryCount),
    autoImageGen: raw.autoImageGen === undefined ? d.autoImageGen : raw.autoImageGen === true,
    phoneBackupInterval: clampInt(raw.phoneBackupInterval, 1, 999, d.phoneBackupInterval),
    extraPrompt: typeof raw.extraPrompt === 'string' ? raw.extraPrompt.slice(0, 500) : '',
    storyLink: raw.storyLink === true,
    storyLinkSocial: normalizeStoryLinkSocial(raw.storyLinkSocial),
    messageWorldbook: raw.messageWorldbook === true,
    projectPublic: raw.projectPublic === true,
    spyEnabled: raw.spyEnabled === true,
    spyHistoryCount: clampInt(raw.spyHistoryCount, 0, 100, d.spyHistoryCount),
    spyWorldbook: raw.spyWorldbook === true,
    spyAutoGen: raw.spyAutoGen === true,
    spyFocusCount: clampInt(raw.spyFocusCount, 2, 10, d.spyFocusCount),
    spyContentCount: clampInt(raw.spyContentCount, 1, 6, d.spyContentCount),
    nightImageRatio: raw.nightImageRatio === 50 || raw.nightImageRatio === 90 ? raw.nightImageRatio : 70,
    nightRevealDefault: raw.nightRevealDefault === 1 || raw.nightRevealDefault === 2 ? raw.nightRevealDefault : 0,
    nightMaskDefault: raw.nightMaskDefault === undefined ? d.nightMaskDefault : raw.nightMaskDefault === true,
    nightImageApi: raw.nightImageApi === true,
    nightImageApiPresetId: typeof raw.nightImageApiPresetId === 'string' ? raw.nightImageApiPresetId.slice(0, 64) : '',
    nightMaxPosts: clampInt(raw.nightMaxPosts, 10, 80, d.nightMaxPosts),
    nightTriggerContacts: clampInt(raw.nightTriggerContacts, 0, 10, d.nightTriggerContacts),
    nightLiveRounds: clampInt(raw.nightLiveRounds, 1, 30, d.nightLiveRounds),
    nightOrders: raw.nightOrders === undefined ? d.nightOrders : raw.nightOrders === true,
    nightDates: raw.nightDates === undefined ? d.nightDates : raw.nightDates === true,
    nightFavLock: raw.nightFavLock === undefined ? d.nightFavLock : raw.nightFavLock === true,
    shopMaxItems,
    shopBatchSize: clampInt(raw.shopBatchSize, SHOP_BATCH_RANGE[0], SHOP_BATCH_RANGE[1], d.shopBatchSize),
    albumCycleDelete: raw.albumCycleDelete === undefined ? d.albumCycleDelete : raw.albumCycleDelete === true,
    albumMaxEntries: clampInt(raw.albumMaxEntries, 10, 2000, d.albumMaxEntries),
    darkMode,
    fontScale: snapScale(raw.fontScale, PHONE_FONT_SCALES),
    phoneZoom: snapScale(raw.phoneZoom, PHONE_ZOOM_SCALES),
    // 字体键三形态：''=跟随风格 / song·hei·kai·yuan=内置语义键 / u:<id>=用户字体库引用
    // （引用的字体已不在库里=悬空键，回落 ''，避免「选着一个不存在的字体」静默失效）。
    fontFamily: (() => {
      const v = typeof raw.fontFamily === 'string' ? raw.fontFamily.trim() : '';
      if (FONT_FAMILY_KEYS.includes(v as typeof FONT_FAMILY_KEYS[number])) return v;
      if (/^u:uf_[a-z0-9]{6,12}$/.test(v)) {
        const fonts = normalizeUserFonts(raw.fontLibrary);
        return fonts.some(f => f.id === v.slice(2)) ? v : '';
      }
      return '';
    })(),
    skin: SKIN_IDS.includes(raw.skin as PhoneSkinId) ? (raw.skin as PhoneSkinId) : '',
    customSkin: pickRecordLocal(raw.customSkin),
    fontLibrary: normalizeUserFonts(raw.fontLibrary),
    soundOn: raw.soundOn === undefined ? d.soundOn : raw.soundOn === true,
    soundVolume: snapTo(raw.soundVolume, PHONE_SOUND_VOLUMES, d.soundVolume),
    keyboardSound: raw.keyboardSound === true,
    vibrateOn: raw.vibrateOn === undefined ? d.vibrateOn : raw.vibrateOn === true,
    silent: raw.silent === true,
    callBarExpanded: raw.callBarExpanded === true,
    lockScreenEnabled: raw.lockScreenEnabled === true,
    lockScreenDelaySec: snapTo(raw.lockScreenDelaySec, PHONE_LOCK_DELAYS, d.lockScreenDelaySec),
    appOrder: normalizeAppOrder(raw.appOrder),
    // 老存档（无 voiceEnabled）：此前「关闭」是后端下拉的一项 ⇒ 非 off 档位即视为总开关开启；
    // 一旦本字段落过盘，就以它为准（关→开能回到原档位，不猜）。
    voiceEnabled: raw.voiceEnabled === undefined
      ? (raw.voiceBackend === 'system' || raw.voiceBackend === 'api' || raw.voiceBackend === 'comfy')
      : raw.voiceEnabled === true,
    // 开启时不允许停在 off 档（否则开关亮着却永远不出声——只有手改存档能造出这个态，这里收口）
    voiceBackend: (raw.voiceBackend === 'system' || raw.voiceBackend === 'api' || raw.voiceBackend === 'comfy')
      ? raw.voiceBackend
      : (raw.voiceEnabled === true ? 'api' : 'off'),
    voiceSpeed: snapTo(raw.voiceSpeed, PHONE_VOICE_SPEEDS, d.voiceSpeed),
    voiceAutoAssign: raw.voiceAutoAssign === undefined ? d.voiceAutoAssign : raw.voiceAutoAssign === true,
    ...migrateVoiceProvider(raw),
    voiceApi: normalizeVoiceApi(raw.voiceApi),
    voiceApiVoices: typeof raw.voiceApiVoices === 'string' ? raw.voiceApiVoices.slice(0, 2000) : '',
    voiceCatalog: normalizeVoiceCatalog(raw.voiceCatalog),
    voiceFetchFilters: normalizeVoiceFetchFilters(raw.voiceFetchFilters),
    voiceComfy: normalizeVoiceComfy(raw.voiceComfy),
    voiceRefAudio: normalizeVoiceRefAudio(raw.voiceRefAudio),
    voiceMap: normalizeVoiceMap(raw.voiceMap),
    voiceRoleProvider: normalizeVoiceRoleProvider(raw.voiceRoleProvider),
    voiceAutoPick: normalizeVoiceAutoPick(raw.voiceAutoPick),
    voiceReadCalls: raw.voiceReadCalls === true,
    voiceSpyMuffle: raw.voiceSpyMuffle === undefined ? d.voiceSpyMuffle : raw.voiceSpyMuffle === true,
    voiceCacheMaxMB: snapTo(raw.voiceCacheMaxMB, PHONE_VOICE_CACHE_MB, d.voiceCacheMaxMB),
    voicePreGen: raw.voicePreGen === undefined ? d.voicePreGen : raw.voicePreGen === true,
  };
}

// ===== 运行时单例 =====

let _store: ExternalObjectStore | null = null;
let _settings: PhoneSettings = defaultPhoneSettings();
let _booted = false;

export async function initPhoneSettingsStore(): Promise<ExternalStoreStatus | null> {
  if (_booted) return _store?.status() || null;
  _booted = true;
  _store = createExternalObjectStore({
    files: createServerFileStore(),
    namespace: 'phone-settings',
    writerId: 'ubs-phone',
    now: () => Date.now(),
    makeId: prefix => `${prefix}_${Date.now().toString(36)}`,
  });
  const status = await _store.load();
  _settings = normalizePhoneSettings(_store.read('settings', null));
  return status;
}

export function getPhoneSettings(): PhoneSettings {
  return { ..._settings };
}

/** 语音总开关的唯一语义入口（渲染层/引擎层/合成层共用一处口径，别各自读字段）：
 *  关闭 ⇒ `resolveVoiceBackend()` 短路成 off、界面不渲染任何语音能力与情绪标签、
 *  提示词不注入「情绪|演绎」标注要求。`[语音]` 消息本身不受影响（照常生成，只是不朗读）。 */
export function isVoiceEnabled(): boolean {
  return _settings.voiceEnabled === true;
}

export async function savePhoneSettings(patch: Partial<PhoneSettings>): Promise<boolean> {
  const next = normalizePhoneSettings({ ..._settings, ...patch });
  _settings = next;
  if (!_store) return false;
  const ok = await _store.patch({ settings: next });
  return ok;
}

export async function flushPhoneSettings(): Promise<void> {
  await _store?.flush();
}
