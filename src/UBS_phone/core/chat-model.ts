// ===== 微信数据模型（纯函数，零依赖，可被 .cjs 测试直接 require） =====
// 存储语义见 docs/01 §5.3：按聊天存 usb_phone_<h>.json，不做楼层锚定。
// 通话记录（calls）的类型与净化在 call-model（同为零依赖模块，type-only 引入不破坏本模块纯度）。

import { IMAGE_TEXT_NO_LIMIT, isRecord, makeId } from './ubp-utils';
import { MAX_CALL_RECORDS, normalizeCallRecord, type CallRecord } from './call-model';
import { normalizePhoneGames, type PhoneGames } from './game-model';
import { normalizeNightData, type NightData } from './night-model';
import { normalizeSocialData, type SocialData } from './social-model';
import { normalizeWechatFavs, type WeChatFavorite } from './wechat-favorites';
import {
  MAX_BROWSER_MARK, MAX_BROWSER_RESULTS, normalizeBrowserData, normalizeTint,
  type BrowserData,
} from './browser-model';
import { normalizeShopData, type ShopData } from './shop-model';
import { selfStamp, monthDayOfDateKey, matchedInsideDigitRun } from './social-time';

export type PhoneMessageType = 'text' | 'image' | 'voice' | 'transfer' | 'redpacket' | 'chatlog' | 'link';
export type PhoneMessageSender = 'me' | 'system' | string; // 成员角色名

/**
 * 界面风格（跟聊天走：一个聊天=一个故事=一个世界观；docs/11、docs/11）。
 * ''=现代（默认，现状）；'xianxia'=仙侠·玄青；'wuxia'=武侠·惊堂；'fantasy'=西幻·纹章。
 * 只影响显示与生成语境，数据结构/解析标记零改动。
 */
export type PhoneStyle = '' | 'xianxia' | 'wuxia' | 'fantasy';

/** 风格值净化（脏值回落现代 ''；旧文件无字段=undefined→现代，零迁移）。 */
export function normalizeStyleValue(raw: unknown): PhoneStyle {
  return raw === 'xianxia' || raw === 'wuxia' || raw === 'fantasy' ? raw : '';
}

/** 合并转发聊天记录的嵌套条目（静态快照，跨会话复用；图片按路径引用原文件）。 */
export interface PhoneLogEntry {
  /** 'me' | 角色名 */
  from: string;
  /** 嵌套不允许 chatlog（展平为 text，防套娃）。 */
  type: PhoneMessageType;
  content: string;
  amount?: string;
  /** 转账/红包币种名快照（货币系统联动；AI 可见行拼在金额后）。 */
  currency?: string;
  imagePath?: string;
  storyTime?: string;
}

/** 图片来源（相册筛选用）。forum=论坛退役遗留条目。 */
export type PhoneAlbumSource = 'chat' | 'camera' | 'moments' | 'forum' | 'tieba' | 'weibo' | 'xhs' | 'night' | 'shop' | 'import';

/**
 * 生图完整档案（结构对齐主项目 image-gen ImageGenRecord：生成那一刻实际发出的
 * 完整请求快照）。chat-model 保持零依赖，此处只声明结构；写入前经
 * sanitizeImageGenRecord 净化（phone-album 侧），读取后由主项目函数消费。
 */
export interface PhoneGenRecord {
  provider: string;
  model: string;
  prompt: string;
  negative: string;
  params: Record<string, unknown>;
  workflow?: string;
  [key: string]: unknown;
}

/** 相册条目：小手机全部生成图片的统一档案（完整参数，供随时重新生图）。 */
export interface PhoneAlbumEntry {
  id: string;
  /** /user/images/unified-statusbar/phone_*.png */
  path: string;
  source: PhoneAlbumSource;
  /** 出镜/发送角色名（主角存显示名；空=无角色，如纯场景）。 */
  characters: string[];
  /** 中文画面描述。 */
  desc: string;
  /** 两步法第一步固化的最终提示词/负面词（存在=重绘可跳过文字 AI）。 */
  imagePrompt?: string;
  imageNegative?: string;
  /** 生图档案（重绘依据；旧条目/采集失败无此字段）。 */
  gen?: PhoneGenRecord;
  /** 收藏：恒豁免循环淘汰（上限只约束非收藏条目）；旧存档无此字段=未收藏。 */
  fav?: boolean;
  createdAt: number;
  /** 规范绝对故事时间戳（入档时按当时故事时间盖；编年史用。旧条目无此字段=不收录，不猜）。 */
  storyStamp?: string;
}

export interface PhoneMessage {
  id: string;
  from: PhoneMessageSender;
  type: PhoneMessageType;
  /** 文本内容 / 语音转写 / 图片提示词 / 转账·红包留言 */
  content: string;
  /** 转账/红包金额（元，字符串两位小数；记账预留，P5 钱包账本消费）。 */
  amount?: string;
  /** 转账/红包币种名快照（货币系统联动；缺省回落常用货币，无联动回落风格单位）。 */
  currency?: string;
  /** 红包拆开标记：收到未拆=false（显示「開」，拆开才入账）；缺省视为已拆（旧消息不追溯补账）。 */
  claimed?: boolean;
  /** 内部时间戳（ms）：仅用于排序/去重/ID，不显示、不进提示词（全机只用故事时间）。 */
  ts: number;
  /** 世界观时间快照（生成时全局数据表「当前时间」） */
  storyTime?: string;
  /** 规范绝对故事时间戳（由 storyTime 自锚归一；编年史/按天回顾用；解析失败不写）。 */
  storyStamp?: string;
  /** 正文联动提取来源楼层 id（重提取=同层整替去重；仅提取条目带）。 */
  srcMesId?: string;
  /** 图片消息：/user/images/unified-statusbar/phone_*.png */
  imagePath?: string;
  imageStatus?: 'pending' | 'ready' | 'failed';
  /** 超额图片＝只能点击手动生成（本批自动生图已达 `MAX_AUTO_IMAGES_PER_BATCH`）：
   *  自动生图泵恒跳过，占位提示「点击生成」；点击后清标记走手动管线。旧档无字段＝false。 */
  imageManual?: boolean;
  /** 已固化的生图提示词（两步法第一步产物，含预设前后缀；存在=重试/重新生图跳过文字 AI）。 */
  imagePrompt?: string;
  /** 已固化的负向提示词（openai 恒空串）。 */
  imageNegative?: string;
  /** 已固化的 NAI 多角色结构 JSON（buildPromptStoryMulti 产物；多角色图重试保持 char_captions 分角色）。 */
  imagePromptMulti?: string;
  /** 拍照消息（相机同款控件）所选角色名（含主角显示名）；字段存在=生图走相机口径（空数组=纯景物，不带聊天上下文）。 */
  imageSubjects?: string[];
  /** 拍照所选地点 nodeId（主项目地图）；生图时解析为结构化【拍摄地点】块。 */
  imageLocationId?: string;
  /** 拍照勾选「引用最新正文」：生图带主项目最近一层 AI 回复（替代聊天记录块）。 */
  imageStoryCtx?: boolean;
  /** 语音消息：缓存 key（后端+音色+语速+情绪+文本 哈希）；缺失时渲染层按 content 现算。 */
  voiceKey?: string;
  /** 语音合成态（与 imageStatus 同构；system 后端无此字段＝点击即读）。 */
  voiceStatus?: 'pending' | 'ready' | 'failed';
  /** 语音真实时长（ms；api/comfy 解码得到后固化；缺失回退 voiceDurationSeconds 估算）。 */
  voiceDurationMs?: number;
  /** 语音情绪（规范中文八词之一；由 [语音|情绪|演绎] 带出，供按服务商改写）。 */
  voiceEmotion?: string;
  /** 语音演绎说明（40 字上限裕量、通常远短于它；仅发支持自由文本的服务商）。 */
  voiceDelivery?: string;
  /** 合并转发的聊天记录条目（仅 type='chatlog'）。 */
  log?: PhoneLogEntry[];
  /** 转发来源标签（type='chatlog' 的转发消息带：和XX的聊天/XX群聊/XX的朋友圈/微博/贴吧/小红书；卡片标题/AI 口径用）。 */
  fwdSrc?: string;
  /**
   * 链接卡（type='link'；第八轮 §5 浏览器分享到微信）：伪地址/标题/预览/来源站名/页面描述
   * （desc=分享后进 AI 上下文）——只展示，绝不请求。
   * 第十一轮加四项可选项：mark/tint=站点徽记与主题色（分享卡缩略块）；qid/idx=来源检索定位
   * （点卡回跳那一页）。旧卡（第八轮落的）缺字段照常渲染，回跳走 url/title 回落。
   */
  link?: {
    url: string; title: string; preview: string; site: string; desc?: string;
    mark?: string; tint?: string; qid?: string; idx?: number;
  };
  /** 引用回复：被引用发言的快照（静态快照——原消息后续删除/编辑不影响本引用；旧存档无字段=undefined，零迁移）。 */
  quote?: PhoneLogEntry;
  /** 成功写入主项目备忘录表的记录：写入时的备忘标题（AI 标题/UNIQUE 冲突后缀，不含时间锚定前缀）。
   *  存在=该系统气泡长按可删（仅此气泡，不参与多选）；级联删备忘录表同名条目，前缀兼容见 core/phone-memo。 */
  memoTitle?: string;
  /** 内部路由标记：气氛组发言（头像走只读小资料卡，不提供加好友/发消息）。
   *  不参与展示/排序/提示词；仅用于移出气氛组后历史消息仍能走只读卡片。 */
  fromAtmosphere?: boolean;
}

export interface AtmosphereMember {
  /** 稳定 id：待生成→已生成、删除、重试都按它定位。 */
  id: string;
  /** 待生成时为空串；生成后为群友姓名。 */
  name: string;
  /** 性别：男/女/其他；旧档缺省=空串（UI 显示未设定）。 */
  gender?: string;
  /** 群内/社会身份：同部门同事、楼下咖啡店店员等；旧档缺省=空串。 */
  identity?: string;
  /** 一句性格/说话风格（生成后落库；待生成时为空串）。 */
  personality: string;
  status: 'pending' | 'ready';
  createdAt: number;
  /** 本批待生成群友的额外要求（用户填写；仅 pending 阶段进入提示词）。 */
  requirement?: string;
}

export interface Conversation {
  /** 'p:<角色名>' | 'g:<id>' */
  id: string;
  kind: 'private' | 'group';
  title: string;
  /** 成员角色名（不含主角） */
  members: string[];
  /** 气氛组（仅群聊；不占 members，不参与好友/私聊体系）。 */
  atmosphere?: AtmosphereMember[];
  /** 群主角色名（仅群聊；缺省=主角微信群未设置；窥私群必填）。 */
  owner?: string;
  /** 群头像图路径（仅群聊；存会话自身而非 avatars 名字键表——键语义是「人名」，混入群 id 会误命中且群删留孤儿）。 */
  avatar?: string;
  messages: PhoneMessage[];
  createdAt: number;
  updatedAt: number;
  unread: number;
  /** 置顶（真机微信长按会话「置顶该聊天」；列表排序优先于 updatedAt）。 */
  pinned?: boolean;
  /** 手动「标为未读」（真机=红点无数字；打开会话即清除）。与 unread 计数并存互不干扰。 */
  manualUnread?: boolean;
  /** 输入框草稿（真机微信：未发送的输入在会话列表显示 [草稿]，重进会话恢复）。
   *  只存用户手打的原文；发送/清空即删除该字段（不留空串）。 */
  draft?: string;
  /** 正文联动提取创建标记（仅窥私会话带；= 创建它的楼层 id）：
   *  swipe/编辑重提取把该会话消息清空时连会话一起移除，不留空壳（微信侧不写此字段）。 */
  srcMesId?: string;
}

export interface PhoneChatData {
  schema: 1;
  conversations: Conversation[];
  /** 好友角色名名单（是好友 ⇔ 名单含此名；非好友私聊一律走好友申请分支）。 */
  friends?: string[];
  /** 自定义联系人（通讯录「＋」手动添加、数据库无记录的角色名名单；数据库出现同名后自动让位为正常角色）。 */
  customContacts?: string[];
  /** 自定义头像（角色名/主角哨兵 key → 图片路径；生效优先级高于主项目立绘）。 */
  avatars?: Record<string, string>;
  /** 角色备注（角色名 → 玩家自己写的备忘，**随本聊天存档**；资料卡末尾一行可编辑。
   *  与 avatars 同层同理：同一个人在另一条聊天里各记各的，互不串台）。 */
  characterNotes?: Record<string, string>;
  /** 相册（小手机全部生成图片的统一档案，新→旧）。 */
  album?: PhoneAlbumEntry[];
  /** 通话记录（电话 App，新→旧；不写微信会话，docs/05 §3）。 */
  calls?: CallRecord[];
  /** 通话背景（电话 App；角色名 → 图片路径，每角色一张，默认回落头像）。 */
  callBgs?: Record<string, string>;
  /** 自定义手机号（电话 App 通讯录；角色名 → 数字串；未设置/清空=回落 T9 伪号码）。 */
  phoneNumbers?: Record<string, string>;
  /** 聊天背景（微信；会话 id（p:名字 / g:xxx）→ 图片路径，私聊群聊通用）。 */
  chatBgs?: Record<string, string>;
  /** 微信「我的收藏」（第八轮 §4：文本/图片/语音/转发卡；随存档走，上限 500 丢最旧）。
   *  与语音收藏（IndexedDB ubp-voice-fav，存音频本体）是两回事——命名刻意分开避免混淆。 */
  wechatFavs?: WeChatFavorite[];
  /** 幻想浏览器（第八轮 §5）：检索历史与结果（随存档走；历史可清、上限 30 次）。 */
  browser?: BrowserData;
  /** 主界面壁纸（桌面背景图路径；空=默认渐变底）。 */
  homeBg?: string;
  /** 锁屏壁纸（锁屏背景图路径；空=默认深色渐变底，与主界面壁纸各自独立）。 */
  lockBg?: string;
  /** 取景参数（槽位 → 非破坏性参数；槽位如 av:<名>/cv:<会话id>/cb:<名>/bg:<会话id>/home/lock/wb:<名>，见 core/phone-crops）。 */
  crops?: Record<string, PhoneCropParams>;
  /** 界面风格（跟聊天走；缺省/''=现代。旧文件无此字段零迁移）。 */
  style?: PhoneStyle;
  /** 日程提醒「横幅已确认」键（M7：点过「知道了」的条目不再弹横幅；
   *  通知中心那条转为常驻，直到备忘录被删除或过期。键见 core/phone-schedule.scheduleKey）。 */
  scheduleAcks?: string[];
  /** 社媒（朋友圈+论坛+热搜，P3.1 快照流；空=未生成过）。 */
  social?: SocialData | null;
  /** 窥私域（角色间私密互动记录；SpyData 定义见本文件下方，空=未生成过）。 */
  spy?: SpyData | null;
  /** 游戏中心域（进行中局+150字总结池+完整对局记录，各游戏分池；空=未玩过）。 */
  games?: PhoneGames | null;
  /** 不夜城域（成人向夜生活综合体；**只读单向域**——只读正文/通讯录/手机已有内容，绝不回写世界书/时间线/正文）。空=未生成过（零迁移）。 */
  night?: NightData | null;
  /** 网上商城域（docs/52：AI 按世界观上货 + 主项目货币结算 + 下单写备忘录 + 到货入库）。空=未逛过（零迁移）。 */
  shop?: ShopData;
}

/**
 * 窥私域（spy-engine 专用）：通讯录角色之间的私密互动（主角不参与不参与不可见的演绎记录）。
 * 复用 Conversation/CallRecord 同构；会话 id 前缀 sp:/sg: 与主角微信数据（p:/g:）隔离。
 */
export interface SpyData {
  schema: 1;
  /** 窥私会话（'sp:<A>|<B>' 私聊 / 'sg:<id>' 群聊；群聊带 owner）。 */
  conversations: Conversation[];
  /** 窥隐私聊/群聊通话记录（caller=拨出方角色名）。 */
  calls: CallRecord[];
  /** 自动生成水位（上次自动生成时的 chat.length；世界演化同款双轨判定的轮数侧）。 */
  lastRound: number;
  /** 最近一次生成失败的持久通知（用户点击后才清除；成功生成时作废）。 */
  lastError?: { text: string; ts: number };
}

/** 单会话消息上限（超出丢最旧保尾）。 */
export const MAX_MESSAGES_PER_CONVERSATION = 2000;
/** 相册条目上限的出厂默认值（= 设置项 albumMaxEntries 的默认值；实际上限由设置驱动，见 core/phone-album）。 */
export const MAX_ALBUM_ENTRIES = 200;
/** 相册读盘安全阀（远超设置上限，纯防脏数据撑爆存档；收藏恒豁免）。 */
export const ALBUM_LOAD_LIMIT = 3000;
/** 群聊绿灯注入人数上限默认值（设置 groupTriggerCap 可调；超过此人数触发随机抽取，见 selectInjectedMembers）。 */
export const GROUP_TRIGGER_MEMBER_CAP = 5;
/** 单群气氛组上限（prompt/UI 防撑爆）。 */
export const MAX_ATMOSPHERE_PER_GROUP = 30;
/** 气氛组姓名/性别/身份/性格/额外要求长度上限。 */
export const MAX_ATMOSPHERE_NAME_LEN = 12;
export const MAX_ATMOSPHERE_GENDER_LEN = 6;
export const MAX_ATMOSPHERE_IDENTITY_LEN = 20;
export const MAX_ATMOSPHERE_PERSONALITY_LEN = 60;
export const MAX_ATMOSPHERE_REQUIREMENT_LEN = 80;
/** 气氛组焦点人数范围（已生成池 >5 时随机抽取；强制 @/回复可超过上限）。 */
export const ATMO_FOCUS_MIN = 3;
export const ATMO_FOCUS_MAX = 5;
/** 单轮气氛组发言软上限（解析层防刷屏；显示仍是普通消息）。 */
export const MAX_ATMOSPHERE_MESSAGES = 8;
/** 单会话草稿长度上限（防御脏数据；正常输入远达不到，超出截断而非丢弃）。 */
export const MAX_DRAFT_LENGTH = 2000;

/** 好友名单上限（防御；自定义联系人名单同口径）。 */
export const MAX_FRIENDS = 1000;
/** 单条合并转发聊天记录的条目上限。 */
export const MAX_LOG_ENTRIES = 100;
/** 背景映射条目上限（通话/聊天各一张图，条目数=联系人规模；防御）。 */
export const MAX_BG_ENTRIES = 1000;
/** 头像映射条目上限（条目数=联系人+会话规模；防御）。 */
export const MAX_AVATAR_ENTRIES = 1000;

/** 角色备注条目上限（条目数=联系人规模；防御）与单条备注长度上限（与 extraPrompt 同档 500）。 */
export const MAX_CHARACTER_NOTES = 1000;
export const MAX_CHARACTER_NOTE_LEN = 500;

/** 取景参数条目上限（槽位数=联系人+会话规模；纯防脏数据撑爆存档）。 */
export const MAX_CROP_ENTRIES = 1000;

/** 取景参数（非破坏性：只存平移/缩放/旋转，不动原图；{0,0,1,0} = 与未取景逐字节同观感）。 */
export interface PhoneCropParams {
  /** 水平平移（% of 媒体层自身宽；0=居中，±100=贴到可平移余量两端）。 */
  x: number;
  /** 垂直平移（% of 媒体层自身高；0=居中，±100=贴到可平移余量两端）。 */
  y: number;
  /** 缩放（1~3；1=原始 cover 大小）。 */
  z: number;
  /** 旋转角（仅 90° 步进：0/90/180/270）。 */
  r: 0 | 90 | 180 | 270;
  /** 原图宽高比 w/h。有了它媒体层才能按「cover 后的整张图」定形，从而平移到照片顶部；
   *  历史数据缺此字段 ⇒ 渲染退回旧口径（媒体铺满容器 + translate/scale），与改造前逐字节一致。 */
  a?: number;
}

/** 单条取景参数净化（脏值整条丢弃，返回 null）。 */
export function normalizeCropParams(value: unknown): PhoneCropParams | null {
  if (!isRecord(value)) return null;
  const x = value.x, y = value.y, z = value.z, r = value.r;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  if (typeof z !== 'number' || !Number.isFinite(z)) return null;
  if (r !== 0 && r !== 90 && r !== 180 && r !== 270) return null;
  const out: PhoneCropParams = {
    x: Math.max(-100, Math.min(100, x)),
    y: Math.max(-100, Math.min(100, y)),
    z: Math.max(1, Math.min(3, z)),
    r,
  };
  // a 可以缺席（历史数据）；非法 a 只丢这个字段退回旧口径，不连累整条参数
  const a = value.a;
  if (typeof a === 'number' && Number.isFinite(a) && a > 0) {
    out.a = Math.max(0.02, Math.min(50, a));
  }
  return out;
}

/** 取景参数表净化（键 ≤64 字符、脏值丢弃、条目上限）。 */
export function normalizeCrops(value: unknown): Record<string, PhoneCropParams> | undefined {
  const raw = isRecord(value) ? value : null;
  if (!raw) return undefined;
  const out: Record<string, PhoneCropParams> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_CROP_ENTRIES) break;
    const k = key.slice(0, 64);
    if (!k) continue;
    const params = normalizeCropParams(item);
    if (params) out[k] = params;
  }
  return Object.keys(out).length ? out : undefined;
}

function str(value: unknown, maxLen = 4000): string {
  return typeof value === 'string' ? value.slice(0, maxLen) : '';
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function makeMessageId(): string {
  return makeId('m_');
}

export function privateConversationId(name: string): string {
  return `p:${name}`;
}

export function groupConversationId(storageId: string): string {
  const short = (storageId || 'x').replace(/-/g, '').slice(0, 8);
  return `g:${short}_${Date.now().toString(36)}`;
}

/** 合并转发条目净化（磁盘读回容错；嵌套 chatlog 展平为 text）。 */
export function normalizeLogEntry(value: unknown): PhoneLogEntry | null {
  if (!isRecord(value)) return null;
  const from = typeof value.from === 'string' && value.from.trim() ? value.from.trim() : null;
  if (!from) return null;
  const rawType = value.type;
  const type: PhoneMessageType = rawType === 'image' || rawType === 'voice' || rawType === 'transfer' || rawType === 'redpacket'
    ? rawType
    : 'text';
  let content = str(value.content, 2000);
  if (rawType === 'chatlog') content = `[聊天记录]${content}`.slice(0, 2000); // 展平：不允许嵌套记录
  const entry: PhoneLogEntry = { from, type, content };
  if ((type === 'transfer' || type === 'redpacket') && typeof value.amount === 'string' && value.amount) {
    entry.amount = value.amount.slice(0, 12);
    if (typeof value.currency === 'string' && value.currency.trim()) entry.currency = value.currency.trim().slice(0, 20);
    entry.content = entry.content.slice(0, 100);
  }
  if (typeof value.storyTime === 'string' && value.storyTime) entry.storyTime = value.storyTime.slice(0, 60);
  if (type === 'image' && typeof value.imagePath === 'string' && value.imagePath) entry.imagePath = value.imagePath;
  return entry;
}

export function normalizePhoneMessage(value: unknown): PhoneMessage | null {
  if (!isRecord(value)) return null;
  const type = value.type === 'image' || value.type === 'voice' || value.type === 'transfer' || value.type === 'redpacket' || value.type === 'chatlog' || value.type === 'link'
    ? value.type
    : 'text';
  const from = typeof value.from === 'string' && value.from.trim() ? value.from.trim() : null;
  if (!from) return null;
  // 图片 content=生图第一步输入：不截断；其余类型维持 4000 上限
  const content = str(value.content, type === 'image' ? IMAGE_TEXT_NO_LIMIT : 4000);
  const imageStatus = value.imageStatus === 'ready' || value.imageStatus === 'failed' || value.imageStatus === 'pending'
    ? value.imageStatus
    : undefined;
  const message: PhoneMessage = {
    id: typeof value.id === 'string' && value.id ? value.id : makeMessageId(),
    from,
    type,
    content: type === 'transfer' || type === 'redpacket' ? content.slice(0, 100)
      : type === 'chatlog' ? content.slice(0, 200)
        : content,
    ts: num(value.ts, Date.now()),
  };
  if ((type === 'transfer' || type === 'redpacket') && typeof value.amount === 'string' && value.amount) {
    message.amount = value.amount.slice(0, 12);
  }
  if ((type === 'transfer' || type === 'redpacket') && typeof value.currency === 'string' && value.currency.trim()) {
    message.currency = value.currency.trim().slice(0, 20);
  }
  if (type === 'redpacket') message.claimed = value.claimed !== false;
  if (typeof value.storyTime === 'string' && value.storyTime) message.storyTime = value.storyTime.slice(0, 60);
  // 绝对故事时间戳：写侧盖（生成时快照自锚）＋存量惰性回填（旧存档只有 storyTime）。零迁移。
  if (message.storyTime) {
    const stamp = selfStamp(message.storyTime);
    if (stamp) message.storyStamp = stamp;
  }
  if (typeof value.srcMesId === 'string' && value.srcMesId) message.srcMesId = value.srcMesId.slice(0, 24);
  if (typeof value.imagePath === 'string' && value.imagePath) message.imagePath = value.imagePath;
  if (type === 'image') {
    if (imageStatus) message.imageStatus = imageStatus;
    if (value.imageManual === true) message.imageManual = true;
    // 固化提示词（第一步产物；仅图片消息保留）；生图文字不截断
    if (typeof value.imagePrompt === 'string' && value.imagePrompt.trim()) message.imagePrompt = value.imagePrompt;
    if (typeof value.imageNegative === 'string') message.imageNegative = value.imageNegative;
    if (typeof value.imagePromptMulti === 'string' && value.imagePromptMulti.trim()) message.imagePromptMulti = value.imagePromptMulti;
    // 拍照（相机同款控件）所选参数；imageSubjects 存在即相机口径——空数组（纯景物）也要保留标记
    if (Array.isArray(value.imageSubjects)) {
      message.imageSubjects = value.imageSubjects
        .filter((n): n is string => typeof n === 'string' && Boolean(n.trim()))
        .map(n => n.trim())
        .slice(0, 8);
    }
    if (typeof value.imageLocationId === 'string' && value.imageLocationId.trim()) message.imageLocationId = value.imageLocationId.trim().slice(0, 64);
    if (value.imageStoryCtx === true) message.imageStoryCtx = true;
  }
  if (type === 'voice') {
    if (typeof value.voiceKey === 'string' && value.voiceKey.trim()) message.voiceKey = value.voiceKey.trim().slice(0, 80);
    const vs = value.voiceStatus;
    if (vs === 'pending' || vs === 'ready' || vs === 'failed') message.voiceStatus = vs;
    if (typeof value.voiceDurationMs === 'number' && Number.isFinite(value.voiceDurationMs) && value.voiceDurationMs > 0) {
      message.voiceDurationMs = Math.min(600000, Math.round(value.voiceDurationMs));
    }
    if (typeof value.voiceEmotion === 'string' && value.voiceEmotion.trim()) {
      message.voiceEmotion = value.voiceEmotion.trim().slice(0, 20);
    }
    if (typeof value.voiceDelivery === 'string' && value.voiceDelivery.trim()) {
      message.voiceDelivery = value.voiceDelivery.trim().slice(0, 40);
    }
  }
  if (type === 'chatlog' && Array.isArray(value.log)) {
    const log = value.log.map(normalizeLogEntry).filter((e): e is PhoneLogEntry => e !== null).slice(0, MAX_LOG_ENTRIES);
    if (log.length) message.log = log;
  }
  if (type === 'chatlog' && typeof value.fwdSrc === 'string' && value.fwdSrc.trim()) {
    message.fwdSrc = value.fwdSrc.trim().slice(0, 60);
  }
  // 链接卡（第八轮 §5：浏览器分享到微信；伪地址只展示，绝不请求）
  // 第十一轮：+mark/tint（缩略块）、+qid/idx（回跳定位）——四项可选，旧卡零迁移。
  if (type === 'link') {
    const link = value.link && typeof value.link === 'object' ? value.link as Record<string, unknown> : null;
    if (link) {
      const url = typeof link.url === 'string' ? link.url.trim().slice(0, 200) : '';
      const title = typeof link.title === 'string' ? link.title.trim().slice(0, 120) : '';
      const preview = typeof link.preview === 'string' ? link.preview.trim().slice(0, 200) : '';
      const site = typeof link.site === 'string' ? link.site.trim().slice(0, 80) : '';
      const desc = typeof link.desc === 'string' ? link.desc.trim().slice(0, 400) : '';
      const mark = typeof link.mark === 'string' ? link.mark.trim().replace(/\s+/g, '').slice(0, MAX_BROWSER_MARK) : '';
      const tint = normalizeTint(link.tint);
      const qid = typeof link.qid === 'string' ? link.qid.trim().slice(0, 60) : '';
      const idxNum = Number(link.idx);
      const idx = Number.isInteger(idxNum) && idxNum >= 0 && idxNum < MAX_BROWSER_RESULTS ? idxNum : -1;
      if (url || title) {
        message.link = {
          url, title, preview, site,
          ...(desc ? { desc } : {}),
          ...(mark ? { mark } : {}),
          ...(tint ? { tint } : {}),
          ...(qid ? { qid } : {}),
          ...(idx >= 0 ? { idx } : {}),
        };
      }
    }
  }
  // 引用回复快照：复用转发条目的既有净化（长度上限、嵌套 chatlog 展平、脏条目丢弃）
  if (isRecord(value.quote)) {
    const quote = normalizeLogEntry(value.quote);
    if (quote) message.quote = quote;
  }
  if (typeof value.memoTitle === 'string' && value.memoTitle.trim()) message.memoTitle = value.memoTitle.trim().slice(0, 60);
  if (value.fromAtmosphere === true) message.fromAtmosphere = true;
  return message;
}

/** 性别归一化：常见同义词收敛到男/女/其他；未知/未设定留空；其他世界观性别词保留。 */
export function normalizeAtmosphereGender(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().replace(/\s+/g, '') : '';
  if (!raw) return '';
  if (/^(男|男性|男生)$/.test(raw)) return '男';
  if (/^(女|女性|女生)$/.test(raw)) return '女';
  if (/^(其他|其它|非二元)$/.test(raw)) return '其他';
  if (/^(未知|不详|未设定)$/.test(raw)) return '';
  return raw.slice(0, MAX_ATMOSPHERE_GENDER_LEN);
}

/** 身份归一化：折叠空白、去首尾引号、截断；空串不落字段。 */
export function normalizeAtmosphereIdentity(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').replace(/^["“'『「]+|["”'』」]+$/g, '').slice(0, MAX_ATMOSPHERE_IDENTITY_LEN);
}

/** 额外要求归一化：换行/连续空白折叠为单空格、trim、截断；空串不落字段。 */
export function normalizeAtmosphereRequirement(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ATMOSPHERE_REQUIREMENT_LEN);
}

/** 气氛组净化（仅群聊接收）：有合法姓名=ready，空姓名=pending；重名/与正式成员重名回落 pending。 */
export function normalizeAtmosphereMembers(value: unknown, members: string[] = []): AtmosphereMember[] {
  if (!Array.isArray(value)) return [];
  const out: AtmosphereMember[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const memberSet = new Set(members);
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 40) : '';
    if (!id || ids.has(id)) id = makeId('a_');
    if (ids.has(id)) continue;
    let name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_ATMOSPHERE_NAME_LEN) : '';
    let gender = normalizeAtmosphereGender(raw.gender);
    let identity = normalizeAtmosphereIdentity(raw.identity);
    let personality = typeof raw.personality === 'string' ? raw.personality.trim().slice(0, MAX_ATMOSPHERE_PERSONALITY_LEN) : '';
    const requirement = normalizeAtmosphereRequirement(raw.requirement);
    let status: 'pending' | 'ready' = name ? 'ready' : 'pending';
    if (status === 'ready') {
      const key = name.toLowerCase();
      if (memberSet.has(name) || names.has(key)) {
        name = '';
        gender = '';
        identity = '';
        personality = '';
        status = 'pending';
      } else {
        names.add(key);
      }
    }
    ids.add(id);
    const member: AtmosphereMember = { id, name, personality, status, createdAt: num(raw.createdAt, Date.now()) };
    if (gender) member.gender = gender;
    if (identity) member.identity = identity;
    if (requirement) member.requirement = requirement;
    out.push(member);
    if (out.length >= MAX_ATMOSPHERE_PER_GROUP) break;
  }
  return out;
}

export function normalizeConversation(value: unknown): Conversation | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' && value.id ? value.id : '';
  const kind = value.kind === 'group' ? 'group' : 'private';
  const rawMembers = Array.isArray(value.members)
    ? value.members.filter((m): m is string => typeof m === 'string' && Boolean(m.trim())).map(m => m.trim())
    : [];
  const members = Array.from(new Set(rawMembers));
  if (!id || members.length === 0) return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizePhoneMessage).filter((m): m is PhoneMessage => m !== null)
    : [];
  const title = typeof value.title === 'string' && value.title.trim()
    ? value.title.trim().slice(0, 40)
    : (kind === 'private' ? members[0] : members.slice(0, 3).join('、') + '群聊');
  const conv: Conversation = {
    id,
    kind,
    title,
    members,
    messages,
    createdAt: num(value.createdAt, Date.now()),
    updatedAt: num(value.updatedAt, Date.now()),
    unread: Math.max(0, Math.floor(num(value.unread, 0))),
  };
  // 置顶/手动未读（真机微信会话列表长按动作）：脏值一律丢弃，缺省不存在=关闭
  if (value.pinned === true) conv.pinned = true;
  if (value.manualUnread === true) conv.manualUnread = true;
  const owner = typeof value.owner === 'string' ? value.owner.trim().slice(0, 60) : '';
  if (kind === 'group' && owner && members.includes(owner)) conv.owner = owner;
  // 群头像：仅群聊收（私聊头像=成员个人头像，不存会话）；脏值丢弃回落哈希色
  if (kind === 'group' && typeof value.avatar === 'string' && value.avatar.trim()) {
    conv.avatar = value.avatar.trim().slice(0, 300);
  }
  // 输入框草稿（真机微信：退出会话后列表显示 [草稿]，重进会话草稿还在）
  if (typeof value.draft === 'string' && value.draft.trim()) {
    conv.draft = value.draft.slice(0, MAX_DRAFT_LENGTH);
  }
  // 正文联动提取创建标记（窥私会话；水印语义见 core/story-link.removeStoryLinkItems）
  if (typeof value.srcMesId === 'string' && value.srcMesId.trim()) {
    conv.srcMesId = value.srcMesId.trim().slice(0, 24);
  }
  // 气氛组：仅群聊接收；私聊脏字段丢弃
  if (kind === 'group') {
    const atmosphere = normalizeAtmosphereMembers(value.atmosphere, members);
    if (atmosphere.length) conv.atmosphere = atmosphere;
  }
  return conv;
}

/** 气氛组：仅群聊返回；私聊恒空。 */
export function atmosphereMembersOf(conv: Conversation): AtmosphereMember[] {
  return conv.kind === 'group' && Array.isArray(conv.atmosphere) ? conv.atmosphere : [];
}

/** 已生成气氛组（有姓名的 ready 条目）。 */
export function readyAtmosphereMembers(conv: Conversation): AtmosphereMember[] {
  return atmosphereMembersOf(conv).filter(a => a.status === 'ready' && Boolean(a.name));
}

/** 已生成气氛组名字（@/解析/渲染用）。 */
export function readyAtmosphereNames(conv: Conversation): string[] {
  return readyAtmosphereMembers(conv).map(a => a.name);
}

/** 待生成气氛组。 */
export function pendingAtmosphere(conv: Conversation): AtmosphereMember[] {
  return atmosphereMembersOf(conv).filter(a => a.status === 'pending');
}

/** 待生成气氛组按额外要求分组（保持首次出现顺序；空要求也作为一组）。 */
export interface AtmosphereRequirementBatch {
  count: number;
  requirement: string;
}

export function pendingAtmosphereBatches(conv: Conversation): AtmosphereRequirementBatch[] {
  const counts = new Map<string, number>();
  for (const a of pendingAtmosphere(conv)) {
    const req = a.requirement || '';
    counts.set(req, (counts.get(req) || 0) + 1);
  }
  return Array.from(counts, ([requirement, count]) => ({ count, requirement }));
}

/** 群内可发言者 = 正式成员 + 已生成气氛组（@ 候选/解析允许名单）。 */
export function groupSpeakerNames(conv: Conversation): string[] {
  return Array.from(new Set([...conv.members, ...readyAtmosphereNames(conv)]));
}

/** 群内总人数（含主角；气氛组待生成也计入）。 */
export function groupPeopleCount(conv: Conversation): number {
  return conv.members.length + atmosphereMembersOf(conv).length + 1;
}

/** 批量添加待生成占位（仅群聊；返回新增条目）。requirement 为这一批共用的额外要求。 */
export function addAtmospherePlaceholders(conv: Conversation, count: number, requirement = ''): AtmosphereMember[] {
  if (conv.kind !== 'group') return [];
  const room = Math.max(0, MAX_ATMOSPHERE_PER_GROUP - atmosphereMembersOf(conv).length);
  const n = Math.min(Math.max(0, Math.floor(count)), room);
  if (!n) return [];
  if (!conv.atmosphere) conv.atmosphere = [];
  const req = normalizeAtmosphereRequirement(requirement);
  const added: AtmosphereMember[] = [];
  for (let i = 0; i < n; i++) {
    const member: AtmosphereMember = {
      id: makeId('a_'),
      name: '',
      personality: '',
      status: 'pending',
      createdAt: Date.now(),
    };
    if (req) member.requirement = req;
    conv.atmosphere.push(member);
    added.push(member);
  }
  return added;
}

/**
 * 把本轮 AI 生成的姓名/性别/身份/性格按 pending 顺序填充。
 * ids 存在时只填这批 id（生成期间用户删掉的条目不复活）；返回本轮实际填入的名字。
 */
export function fillAtmosphereProfiles(
  conv: Conversation,
  profiles: Array<{ name: string; gender?: string; identity?: string; personality: string }>,
  ids?: string[],
): string[] {
  if (conv.kind !== 'group' || !profiles.length) return [];
  const idSet = ids ? new Set(ids) : null;
  const targets = atmosphereMembersOf(conv).filter(a => a.status === 'pending' && (!idSet || idSet.has(a.id)));
  if (!targets.length) return [];
  const used = new Set(readyAtmosphereNames(conv).map(n => n.toLowerCase()));
  const filled: string[] = [];
  let ti = 0;
  for (const profile of profiles) {
    if (ti >= targets.length) break;
    const name = String(profile.name || '').trim().slice(0, MAX_ATMOSPHERE_NAME_LEN);
    const key = name.toLowerCase();
    if (!name || used.has(key) || conv.members.includes(name)) continue;
    const target = targets[ti++];
    const gender = normalizeAtmosphereGender(profile.gender);
    const identity = normalizeAtmosphereIdentity(profile.identity);
    target.name = name;
    target.personality = String(profile.personality || '').trim().slice(0, MAX_ATMOSPHERE_PERSONALITY_LEN);
    if (gender) target.gender = gender; else delete target.gender;
    if (identity) target.identity = identity; else delete target.identity;
    target.status = 'ready';
    used.add(key);
    filled.push(name);
  }
  return filled;
}

/** 移出气氛组（按 id）；返回被移除条目（供落系统消息），未命中返回 null。 */
export function removeAtmosphereMember(conv: Conversation, id: string): AtmosphereMember | null {
  if (!conv.atmosphere || !id) return null;
  const idx = conv.atmosphere.findIndex(a => a.id === id);
  if (idx < 0) return null;
  const [removed] = conv.atmosphere.splice(idx, 1);
  if (!conv.atmosphere.length) delete conv.atmosphere;
  return removed || null;
}

/** 是否为当前会话的已生成气氛组（消息头像/资料卡分流用）。 */
export function isAtmosphereName(conv: Conversation, name: string): boolean {
  return readyAtmosphereMembers(conv).some(a => a.name === name);
}

/** 当前会话某气氛组的性格（@ 面板副行用）。 */
export function atmospherePersonalityOf(conv: Conversation, name: string): string {
  return readyAtmosphereMembers(conv).find(a => a.name === name)?.personality || '';
}

export function normalizePhoneChatData(value: unknown): PhoneChatData {
  const raw = isRecord(value) ? value : {};
  const conversations = Array.isArray(raw.conversations)
    ? raw.conversations.map(normalizeConversation).filter((c): c is Conversation => c !== null)
    : [];
  // 会话 id 去重（后者胜）
  const byId = new Map<string, Conversation>();
  for (const conv of conversations) byId.set(conv.id, conv);
  // 读盘只做安全阀修剪（收藏豁免）——实际上限由设置 albumMaxEntries 在入档/立即清理时执行
  const album = trimAlbum(normalizeAlbum(raw.album), ALBUM_LOAD_LIMIT).kept;
  const calls = (Array.isArray(raw.calls)
    ? raw.calls.map(normalizeCallRecord).filter((c): c is CallRecord => c !== null)
    : []).slice(0, MAX_CALL_RECORDS);
  return {
    schema: 1,
    conversations: Array.from(byId.values()),
    friends: normalizeFriends(raw.friends),
    customContacts: normalizeFriends(raw.customContacts),
    avatars: normalizeAvatars(raw.avatars),
    characterNotes: normalizeCharacterNotes(raw.characterNotes),
    album,
    calls,
    callBgs: normalizeBgMap(raw.callBgs),
    phoneNumbers: normalizePhoneNumbers(raw.phoneNumbers),
    chatBgs: normalizeBgMap(raw.chatBgs),
    wechatFavs: normalizeWechatFavs(raw.wechatFavs),
    browser: normalizeBrowserData(raw.browser),
    homeBg: normalizeBgPath(raw.homeBg),
    lockBg: normalizeBgPath(raw.lockBg),
    crops: normalizeCrops(raw.crops),
    style: normalizeStyleValue(raw.style),
    scheduleAcks: normalizeScheduleAcks(raw.scheduleAcks),
    social: normalizeSocialData(raw.social),
    spy: normalizeSpyData(raw.spy),
    games: normalizePhoneGames(raw.games),
    night: normalizeNightData(raw.night),
    shop: normalizeShopData(raw.shop),
  };
}

/** 窥私会话数上限（超出按 updatedAt 淘汰最旧）。 */
export const MAX_SPY_CONVERSATIONS = 60;

/** 窥私域净化（磁盘读回容错；复用 Conversation/CallRecord 同款净化，FIFO 收敛到上限）。 */
export function normalizeSpyData(value: unknown): SpyData | null {
  const raw = isRecord(value) ? value : {};
  const conversations = Array.isArray(raw.conversations)
    ? raw.conversations.map(normalizeConversation).filter((c): c is Conversation => c !== null)
    : [];
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  const calls = (Array.isArray(raw.calls)
    ? raw.calls.map(normalizeCallRecord).filter((c): c is CallRecord => c !== null)
    : []).slice(0, MAX_CALL_RECORDS);
  const spy: SpyData = {
    schema: 1,
    conversations: conversations.slice(0, MAX_SPY_CONVERSATIONS),
    calls,
    lastRound: Math.max(0, Math.floor(num(raw.lastRound, 0))),
  };
  const errRaw = isRecord(raw.lastError) ? raw.lastError : null;
  const errText = errRaw && typeof errRaw.text === 'string' ? errRaw.text.trim().slice(0, 300) : '';
  if (errText) spy.lastError = { text: errText, ts: num(errRaw!.ts, Date.now()) };
  // 全空域（无会话/通话/水位/错误）返回 null：旧文件零迁移，不向存档写入空 spy 键
  if (!spy.conversations.length && !spy.calls.length && !spy.lastRound && !spy.lastError) return null;
  return spy;
}

function normalizeFriends(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.filter((n): n is string => typeof n === 'string' && Boolean(n.trim())).map(n => n.trim().slice(0, 60));
  return Array.from(new Set(names)).slice(0, MAX_FRIENDS);
}

// ─── 好友关系（是好友 ⇔ friends 名单含此名；申请/被拒/被拉黑都只是非好友+聊天记录留痕） ───

export function isFriend(data: PhoneChatData, name: string): boolean {
  return (data.friends || []).includes(name);
}

export function addFriend(data: PhoneChatData, name: string): void {
  const n = name.trim();
  if (!n) return;
  data.friends = data.friends || [];
  if (!data.friends.includes(n) && data.friends.length < MAX_FRIENDS) data.friends.push(n);
}

export function removeFriend(data: PhoneChatData, name: string): void {
  data.friends = (data.friends || []).filter(f => f !== name);
}

// ─── 自定义联系人（通讯录「＋」添加的数据库外角色；名单语义与 friends 同构，净化复用 normalizeFriends） ───

/** 是否自定义联系人（仅数据库无记录的添加角色；数据库出现同名后此判据自然转 false=自动让位）。 */
export function isCustomContact(data: PhoneChatData, name: string): boolean {
  return (data.customContacts || []).includes(name);
}

export function addCustomContact(data: PhoneChatData, name: string): void {
  const n = name.trim();
  if (!n) return;
  data.customContacts = data.customContacts || [];
  if (!data.customContacts.includes(n) && data.customContacts.length < MAX_FRIENDS) data.customContacts.push(n);
}

export function removeCustomContact(data: PhoneChatData, name: string): void {
  data.customContacts = (data.customContacts || []).filter(c => c !== name);
}

function normalizeAvatars(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, path] of Object.entries(value)) {
    const name = key.trim().slice(0, 60);
    if (!name || typeof path !== 'string' || !path) continue;
    out[name] = path.slice(0, 400);
    if (Object.keys(out).length >= MAX_AVATAR_ENTRIES) break;
  }
  return out;
}

/** 角色备注净化（角色名 key；空串不落键——「没写过」与「写了空」在数据上等价，不留垃圾键）。 */
function normalizeCharacterNotes(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, text] of Object.entries(value)) {
    const name = key.trim().slice(0, 60);
    const note = typeof text === 'string' ? text.trim().slice(0, MAX_CHARACTER_NOTE_LEN) : '';
    if (!name || !note) continue;
    out[name] = note;
    if (Object.keys(out).length >= MAX_CHARACTER_NOTES) break;
  }
  return out;
}

/** 背景映射净化（通话=角色名 key；聊天=会话 id key；值=本插件图床路径）。 */
function normalizeBgMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, path] of Object.entries(value)) {
    const k = key.trim().slice(0, 120);
    if (!k || typeof path !== 'string' || !path.trim() || path.length > 2048) continue;
    out[k] = path.trim();
    if (Object.keys(out).length >= MAX_BG_ENTRIES) break;
  }
  return out;
}

/** 自定义手机号映射净化（角色名 key；值=1~20 位纯数字，滤除非数字字符）。 */
function normalizePhoneNumbers(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, num] of Object.entries(value)) {
    const k = key.trim().slice(0, 60);
    const digits = typeof num === 'string' ? num.replace(/\D/g, '') : '';
    if (!k || digits.length < 1 || digits.length > 20) continue;
    out[k] = digits;
    if (Object.keys(out).length >= MAX_BG_ENTRIES) break;
  }
  return out;
}

/** 日程已确认键净化（去重 + FIFO 上限；键形如 `会话id|约定戳|标题`，见 phone-schedule.scheduleKey）。 */
export const MAX_SCHEDULE_ACKS = 300;
function normalizeScheduleAcks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const k = typeof item === 'string' ? item.trim().slice(0, 120) : '';
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  // FIFO：只保留最近 MAX_SCHEDULE_ACKS 个（超出丢最旧）
  return out.slice(Math.max(0, out.length - MAX_SCHEDULE_ACKS));
}

/** 单值背景路径净化（主界面壁纸；与 normalizeBgMap 同口径）。 */
function normalizeBgPath(value: unknown): string {
  const p = typeof value === 'string' ? value.trim() : '';
  return p && p.length <= 2048 ? p : '';
}

/** 相册条目防御性净化（磁盘读回容错；gen 只做结构校验，净化由写入侧负责）。 */
export function normalizeAlbumEntry(value: unknown): PhoneAlbumEntry | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' && value.id ? value.id : '';
  const path = typeof value.path === 'string' && value.path ? value.path : '';
  if (!id || !path) return null;
  const source = value.source === 'camera' ? 'camera'
    : value.source === 'moments' ? 'moments'
      : value.source === 'forum' ? 'forum'
        : value.source === 'tieba' ? 'tieba'
          : value.source === 'weibo' ? 'weibo'
            : value.source === 'xhs' ? 'xhs'
              : value.source === 'night' ? 'night'
                : value.source === 'shop' ? 'shop'
                  : value.source === 'import' ? 'import' : 'chat';
  const characters = Array.isArray(value.characters)
    ? value.characters.filter((c): c is string => typeof c === 'string' && Boolean(c.trim())).map(c => c.trim().slice(0, 40)).slice(0, 6)
    : [];
  const entry: PhoneAlbumEntry = {
    id,
    path: path.slice(0, 400),
    source,
    characters: Array.from(new Set(characters)),
    desc: str(value.desc, IMAGE_TEXT_NO_LIMIT),
    createdAt: num(value.createdAt, Date.now()),
  };
  if (typeof value.imagePrompt === 'string' && value.imagePrompt.trim()) entry.imagePrompt = value.imagePrompt;
  if (typeof value.imageNegative === 'string') entry.imageNegative = value.imageNegative;
  if (value.fav === true) entry.fav = true;
  // 绝对故事时间戳：只读回已有值（旧条目无此字段=不猜——入档时由 phone-album 盖）。
  if (typeof value.storyStamp === 'string' && value.storyStamp.trim()) entry.storyStamp = value.storyStamp.trim().slice(0, 32);
  if (isRecord(value.gen)
    && (typeof value.gen.prompt === 'string' || typeof value.gen.workflow === 'string')) {
    entry.gen = value.gen as PhoneGenRecord;
  }
  return entry;
}

function normalizeAlbum(value: unknown): PhoneAlbumEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeAlbumEntry).filter((e): e is PhoneAlbumEntry => e !== null);
}

/**
 * 纯函数：相册修剪（入参须为新→旧有序）。**收藏恒保留**；非收藏按序保留 cap 张，
 * 溢出进 evicted（调用方决定是否删服务器文件）。上限只约束非收藏条目。
 */
export function trimAlbum(
  album: PhoneAlbumEntry[],
  cap: number,
): { kept: PhoneAlbumEntry[]; evicted: PhoneAlbumEntry[] } {
  const kept: PhoneAlbumEntry[] = [];
  const evicted: PhoneAlbumEntry[] = [];
  let plainKept = 0;
  for (const e of album) {
    if (e.fav) { kept.push(e); continue; }
    if (plainKept < cap) { plainKept++; kept.push(e); } else evicted.push(e);
  }
  return { kept, evicted };
}

/** 纯函数：相册追加 + 修剪，返回 [保留列表(新→旧), 需删除文件的溢出条目]。
 *  cycle=false（设置关掉循环删除）时不淘汰，原样保留全部；收藏条目两种模式下都不被淘汰。 */
export function appendAlbumEntries(
  album: PhoneAlbumEntry[],
  fresh: PhoneAlbumEntry[],
  cap = MAX_ALBUM_ENTRIES,
  cycle = true,
): { kept: PhoneAlbumEntry[]; evicted: PhoneAlbumEntry[] } {
  const merged = [...fresh, ...album].sort((a, b) => b.createdAt - a.createdAt);
  if (!cycle) return { kept: merged, evicted: [] };
  return trimAlbum(merged, cap);
}

/**
 * 相册条目中文描述：拍照 = 出镜角色 + 地点 + 用户描述拼接（缺项自然降级）；
 * 聊天图 = AI 的【图片】描述，天然自带。该描述是转发时的消息内容（AI 侧即「[图片]描述」）。
 */
export function composeShotDesc(names: string[], locationName: string, userDesc: string): string {
  const who = names.map(n => n.trim()).filter(Boolean).join('、');
  const loc = locationName.trim();
  const desc = userDesc.trim();
  if (who && loc) return `${who}在${loc}：${desc}`;
  if (who) return `${who}：${desc}`;
  if (loc) return `${loc}：${desc}`;
  return desc;
}

/** 空数据（新聊天首建）。 */
export function emptyPhoneChatData(): PhoneChatData {
  return { schema: 1, conversations: [] };
}

export function findConversation(data: PhoneChatData, id: string): Conversation | null {
  return data.conversations.find(c => c.id === id) || null;
}

/** 取或建私聊会话（同角色复用同一会话）。 */
export function ensurePrivateConversation(data: PhoneChatData, name: string): Conversation {
  const id = privateConversationId(name);
  const existing = findConversation(data, id);
  if (existing) return existing;
  const now = Date.now();
  const conv: Conversation = {
    id,
    kind: 'private',
    title: name,
    members: [name],
    messages: [],
    createdAt: now,
    updatedAt: now,
    unread: 0,
  };
  data.conversations.push(conv);
  return conv;
}

/** 设置/清除群头像（微信 conversations 与窥私 spy.conversations 两域按会话 id 找；id 前缀 g:/sg: 天然不冲突）。
 *  path=null = 清除（回落标题哈希色）。返回是否命中群会话。 */
export function setGroupAvatar(data: PhoneChatData, convId: string, path: string | null): boolean {
  if (!convId) return false;
  let hit = false;
  const apply = (list: Conversation[]): void => {
    for (const c of list) {
      if (c.id !== convId || c.kind !== 'group') continue;
      hit = true;
      if (path) c.avatar = path;
      else delete c.avatar;
    }
  };
  apply(data.conversations);
  if (data.spy) apply(data.spy.conversations);
  return hit;
}

export function createGroupConversation(data: PhoneChatData, members: string[], title: string, storageId: string): Conversation {
  const unique = Array.from(new Set(members.map(m => m.trim()).filter(Boolean)));
  const conv: Conversation = {
    id: groupConversationId(storageId),
    kind: 'group',
    title: (title.trim() || (unique.slice(0, 3).join('、') + '群聊')).slice(0, 40),
    members: unique,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    unread: 0,
  };
  data.conversations.push(conv);
  return conv;
}

/** 追加消息（更新 updatedAt / unread，超限截断保尾）。返回追加后的会话。 */
export function appendMessage(conv: Conversation, message: PhoneMessage): Conversation {
  conv.messages.push(message);
  if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    conv.messages.splice(0, conv.messages.length - MAX_MESSAGES_PER_CONVERSATION);
  }
  conv.updatedAt = message.ts;
  return conv;
}

/**
 * 相册转发的我方图片消息：复用既有图片文件（imageStatus:'ready'，不重新生图）；
 * content=中文描述——AI 资料块里呈现为「[图片]描述」，前端按 imagePath 渲染为图片。
 */
export function buildForwardedImageMessage(desc: string, imagePath: string, storyTime?: string): PhoneMessage | null {
  return normalizePhoneMessage({
    id: makeMessageId(),
    from: 'me',
    type: 'image',
    content: (desc || '').trim() || '一张照片',
    ts: Date.now(),
    ...(storyTime ? { storyTime } : {}),
    imagePath,
    imageStatus: 'ready',
  });
}

// ─── 合并转发聊天记录 ───

// ─── 货币联动单位解析（注入式：chat-model 保持零依赖，currency-link 模块装载时注册）───
// 解析器入参为消息自带币种名（可空），返回单位文本（币种名）或 null（回落 ¥）。
type MoneyUnitResolver = (currency: string | undefined) => string | null;
let _moneyUnitResolver: MoneyUnitResolver | null = null;

export function setMoneyUnitResolver(fn: MoneyUnitResolver | null): void {
  _moneyUnitResolver = fn;
}

/** 转账行金额文本（AI 可见/预览统一口径）：币种名（自带或联动常用货币）→ "520 上品灵石"；无联动 → "¥520.00"。 */
export function transferAiAmount(amount: string | number | undefined, currency?: string): string {
  const n = Number.parseFloat(String(amount ?? '0'));
  const safe = Number.isFinite(n) ? n : 0;
  const unit = currency || _moneyUnitResolver?.(undefined) || null;
  return unit ? `${safe} ${unit}` : `¥${safe.toFixed(2)}`;
}

/** 记录条目 → 单行正文（AI/预览口径，富媒体前缀与聊天记录段约定一致）。 */
export function logEntryBody(entry: PhoneLogEntry): string {
  switch (entry.type) {
    case 'image': return `[图片]${entry.content}`;
    case 'voice': return `[语音]${entry.content}`;
    case 'transfer': return `[转账]${transferAiAmount(entry.amount, entry.currency)}${entry.content ? ` ${entry.content}` : ''}`;
    case 'redpacket': return `[红包]${entry.content}`;
    // 链接卡转发条目：content 由收集方拼成「标题：页面描述」（条目结构无 link 载荷，见 collectSelectedLogEntries）
    case 'link': return `[链接]${entry.content}`;
    default: return entry.content;
  }
}

/**
 * 引用前缀（AI 视角；批次与时间线共用同一口径）：`（引用 发言人：原文）`。
 * 原文不截断——与「用户输入全量不截断」（批次）同口径，引用卡与提示词始终看到同一份完整内容。
 * @ 转全角：被引用的原句含「@成员名」时会被 parseMentions 误当本轮 @提醒（额外拉人进绿灯名单），转全角即规避。
 */
export function quotePromptPrefix(quote: PhoneLogEntry): string {
  const who = quote.from === 'me' ? '我' : quote.from;
  return `（引用 ${who}：${logEntryBody(quote).replace(/@/g, '＠')}）`;
}

/** 聊天记录摘要（消息 content，兼作会话预览与 AI 视角正文）：前两条 + 总数。 */
export function chatlogSummary(entries: PhoneLogEntry[]): string {
  const who = (from: string) => (from === 'me' ? '我' : from);
  const head = entries.slice(0, 2).map(e => `${who(e.from)}：${logEntryBody(e).slice(0, 24)}`).join('；');
  const tail = entries.length > 2 ? `等${entries.length}条` : '';
  return `${head}${tail}`.slice(0, 80);
}

/** 合并转发的我方聊天记录消息（自包含静态快照；点卡片展开查看；fwdSrc=转发来源，AI 视角=「转发消息：来自于…」包裹块）。 */
export function buildChatlogMessage(entries: PhoneLogEntry[], storyTime?: string, fwdSrc?: string): PhoneMessage | null {
  const clean = entries.map(normalizeLogEntry).filter((e): e is PhoneLogEntry => e !== null).slice(0, MAX_LOG_ENTRIES);
  if (!clean.length) return null;
  return normalizePhoneMessage({
    id: makeMessageId(),
    from: 'me',
    type: 'chatlog',
    content: chatlogSummary(clean),
    log: clean,
    ts: Date.now(),
    ...(storyTime ? { storyTime } : {}),
    ...(fwdSrc ? { fwdSrc } : {}),
  })!;
}

/** 是否转发消息（帖子分享/聊天合并转发均带 fwdSrc 来源；无 log 的存量 chatlog 回退摘要）。 */
export function isForwardedMessage(message: PhoneMessage): boolean {
  return message.type === 'chatlog' && (Boolean(message.fwdSrc) || Boolean(message.log?.length));
}

/** 转发消息的逐条发言行（「发言人：正文」，富媒体转类型前缀描述；批注展开与混合块共用，不设截断——混合块以 5 条/条中和 token 影响）。 */
export function chatlogShareEntryLines(message: PhoneMessage): string[] {
  const who = (from: string) => (from === 'me' ? '我' : from);
  return (message.log || []).map(e => `${who(e.from)}：${logEntryBody(e)}`);
}

/** 转发内容闭合标记（协议标记，全风格不变；与开始标记成对包裹转发块——用户定案）。 */
export const FORWARD_BLOCK_END = '〖转发内容结束〗';

/**
 * 转发消息的 AI 视角全文块（批注与混合块共用同一包裹）：首行=统一开头「转发消息：来自于…」
 * （fwdSrc 来源：和XX的聊天/XX群聊/XX的朋友圈/微博/贴吧/小红书），中间=逐条发言人，末行=闭合标记；
 * 整块被 〖〗 成对包裹，与时间线其他记录（通话转写/评论子行）明确区隔。无 fwdSrc 的存量消息回退通用来源。
 */
export function chatlogForwardBlock(message: PhoneMessage): string[] {
  const head = message.fwdSrc
    ? `〖转发消息：来自于${message.fwdSrc}〗`
    : '〖转发消息：来自于聊天记录〗';
  return [head, ...chatlogShareEntryLines(message), FORWARD_BLOCK_END];
}

// ─── 批次（上屏≠触发：我方消息先攒批，点触发按钮才生成） ───

/**
 * 尾部连续我方消息 = 待触发批次（最近一次对方消息之后攒的全部我方消息）。
 * 系统气泡（错误提示/备忘反馈）不算对方回复，不截断批次——失败重试时批次不丢。
 */
export function trailingUserBatch(messages: PhoneMessage[]): PhoneMessage[] {
  const batch: PhoneMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) break;
    if (m.from === 'system') continue;
    if (m.from !== 'me') break;
    batch.unshift(m);
  }
  return batch;
}

/**
 * 批次 → 「我方刚刚发送」多行文本（AI 视角：富媒体带类型前缀，与聊天记录段约定一致；
 * 引用消息前置 `（引用 X：原文）`；全量不截断——用户输入全量进绿灯扫描与指令）。
 */
export function composeBatchUserText(messages: PhoneMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.from !== 'me') continue;
    // 转发消息（帖子分享/聊天合并转发）全文展开 + 〖〗成对包裹（用户定案不设上限，包裹标记让 AI 明确转发边界）
    if (isForwardedMessage(m)) {
      for (const l of chatlogForwardBlock(m)) if (l.trim()) lines.push(l);
      continue;
    }
    let line: string;
    switch (m.type) {
      case 'image': line = `[图片]${m.content}`; break;
      case 'voice': line = `[语音]${m.content}`; break;
      case 'transfer': line = `[转账]${transferAiAmount(m.amount, m.currency)}${m.content ? ` ${m.content}` : ''}`; break;
      case 'redpacket': line = `[红包]${m.content}`; break;
      case 'chatlog': line = `[聊天记录]${m.content}`; break;
      default: line = m.content;
    }
    if (line.trim()) lines.push(`${m.quote ? quotePromptPrefix(m.quote) : ''}${line}`);
  }
  return lines.join('\n');
}

/** 本批我方消息引用到的发言人（被回复者）：排除 me/system、去重、保持出现顺序。
 *  直接读 m.quote.from，不依赖 composeBatchUserText 是否拼上引用前缀（转发分支不拼）。 */
export function collectQuotedSenders(messages: readonly PhoneMessage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    const from = m.quote?.from;
    if (!from || from === 'me' || from === 'system' || seen.has(from)) continue;
    seen.add(from);
    out.push(from);
  }
  return out;
}

// ─── 群聊 @ 与绿灯注入名单 ───

export interface GroupMentions {
  /** 本批被@的成员规范名（按出现顺序去重）。 */
  names: string[];
  /** 出现过 @所有人。 */
  atAll: boolean;
}

/** 空的 @ 解析结果（私聊/未 @）。 */
export function emptyMentions(): GroupMentions {
  return { names: [], atAll: false };
}

/** @片段：@ 后到下一个空白/句读为止的名字（不含 @）。 */
const MENTION_FRAG_RE = /@([^\s@，。,；;：:！!？?]+)/g;

/**
 * 从批次文本解析 @：@名字 精确匹配成员名，@所有人 置 atAll；
 * 手打的不存在名字不生效（仅作为普通文字，靠绿灯文本扫描自然处理）。
 */
export function parseMentions(text: string, members: string[]): GroupMentions {
  const out = emptyMentions();
  MENTION_FRAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_FRAG_RE.exec(String(text || ''))) !== null) {
    const frag = match[1];
    if (frag === '所有人') {
      out.atAll = true;
    } else if (members.includes(frag) && !out.names.includes(frag)) {
      out.names.push(frag);
    }
  }
  return out;
}

/**
 * 群聊绿灯注入名单（token 限流）：
 * - 成员 ≤上限 → 全员；
 * - @所有人 → 全员（突破限制）；
 * - 否则 = 被@者 ∪ 被回复者 + 随机补足——强制人数计入上限名额
 *   （@2 人 → 再随机补足至上限；强制 ≥上限 → 不再随机，只保留强制名单）；
 * cap 来自设置 groupTriggerCap（默认 5）；rand 可注入（测试可复现）。
 */
export function selectInjectedMembers(
  members: string[],
  mentions: GroupMentions,
  rand: () => number = Math.random,
  cap: number = GROUP_TRIGGER_MEMBER_CAP,
  repliedNames: readonly string[] = [],
): string[] {
  const limit = Math.max(1, Math.floor(cap));
  if (members.length <= limit) return [...members];
  if (mentions.atAll) return [...members];
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const name of [...mentions.names, ...repliedNames]) {
    const n = String(name || '').trim();
    if (!n || seen.has(n) || !members.includes(n)) continue;
    seen.add(n);
    picked.push(n);
  }
  const randomCount = Math.max(0, limit - picked.length);
  if (randomCount > 0) {
    const pool = members.filter(m => !seen.has(m));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    picked.push(...pool.slice(0, randomCount));
  }
  return picked;
}

/**
 * 气氛组焦点名单：
 * - 池子 ≤ max → 全员；
 * - 池子 > max → 随机 min~max；
 * - forcedNames（@ / 被回复）全部保留；强制人数超过目标时按强制人数，可超过 max；
 * - 不足目标从剩余池随机补足。
 * rand 可注入（测试可复现）。
 */
export function selectFocusAtmosphereNames(
  readyNames: readonly string[],
  forcedNames: readonly string[] = [],
  rand: () => number = Math.random,
  min: number = ATMO_FOCUS_MIN,
  max: number = ATMO_FOCUS_MAX,
): string[] {
  const pool = Array.from(new Set(readyNames.map(n => String(n || '').trim()).filter(Boolean)));
  if (!pool.length) return [];
  const poolSet = new Set(pool);
  const forced: string[] = [];
  const seen = new Set<string>();
  for (const name of forcedNames) {
    const n = String(name || '').trim();
    if (!n || seen.has(n) || !poolSet.has(n)) continue;
    seen.add(n);
    forced.push(n);
  }
  const lo = Math.max(1, Math.floor(min));
  const hi = Math.max(lo, Math.floor(max));
  if (pool.length <= hi) return pool;
  const r = Math.max(0, Math.min(0.999999, Number(rand()) || 0));
  const target = Math.max(forced.length, lo + Math.floor(r * (hi - lo + 1)));
  if (target >= pool.length) return pool;
  const need = Math.max(0, target - forced.length);
  const rest = pool.filter(n => !seen.has(n));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.max(0, Math.min(0.999999, Number(rand()) || 0)) * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return [...forced, ...rest.slice(0, need)];
}

// ─── 群聊分块（混合块注入用，用户定案：主角发言 + 故事时间 双路线边界） ───

/** 群聊块：一次发送请求范围内（或同故事时段的连续角色轮）的消息（含随块系统行）+ 参与者。 */
export interface GroupChunk {
  messages: PhoneMessage[];
  /** 发言者∪被@者（@所有人=全员；不含我/系统）。 */
  participants: string[];
}

/** 块内参与者：非系统非我方发言者 ∪ 消息文本 @ 到的成员（@所有人=全员；parseMentions 已按成员名单过滤）。 */
function chunkParticipants(messages: PhoneMessage[], members: string[]): string[] {
  const speakers = new Set<string>();
  const texts: string[] = [];
  for (const m of messages) {
    if (m.from === 'system') continue;
    if (m.from !== 'me') speakers.add(m.from);
    texts.push(m.content);
  }
  const mentioned = parseMentions(texts.join('\n'), members);
  if (mentioned.atAll) return [...members];
  return Array.from(new Set([...speakers, ...mentioned.names]));
}

/**
 * 群聊消息分块（双路线，用户定案）：
 * ①发言路线——角色发言之后出现主角发言即分块（每次聊天以用户发言开始，直到下一次用户发言）；
 * ②时间路线——相邻非系统消息 storyTime 严格不一致即分块（覆盖无主角发言的连续角色主动轮：
 *   空批次触发不产生我方消息，全局时间没变=同一轮对话，时间走了=新一轮）。
 * 系统行不打断比较、随块携带（不计参与者）；无 storyTime（旧数据/全局时间为空）按空串比较。
 * 返回旧→新。纯函数零依赖。
 */
export function groupRequestChunks(messages: PhoneMessage[], members: string[]): GroupChunk[] {
  const chunks: GroupChunk[] = [];
  let cur: PhoneMessage[] = [];
  let prev: PhoneMessage | null = null;
  const flush = () => {
    if (cur.length) chunks.push({ messages: cur, participants: chunkParticipants(cur, members) });
    cur = [];
  };
  for (const m of messages) {
    if (m.from === 'system') {
      cur.push(m);
      continue;
    }
    if (prev && ((m.from === 'me' && prev.from !== 'me') || (m.storyTime || '') !== (prev.storyTime || ''))) flush();
    prev = m;
    cur.push(m);
  }
  flush();
  return chunks;
}

/** 单条消息的一行摘要（会话列表预览与聊天内搜索结果共用一份口径；新增富媒体类型只改这里）。 */
export function messagePreviewText(m: PhoneMessage): string {
  if (m.type === 'image') return `[图片] ${m.content.slice(0, 20)}`;
  if (m.type === 'voice') return `[语音] ${m.content.slice(0, 20)}`;
  if (m.type === 'transfer') return `[转账] ${transferAiAmount(m.amount, m.currency)}${m.content ? `：${m.content.slice(0, 16)}` : ''}`;
  if (m.type === 'redpacket') return `[红包] ${m.content.slice(0, 20) || '微信红包'}`;
  if (m.type === 'chatlog') return `[聊天记录] ${m.content.slice(0, 26)}`;
  if (m.type === 'link') return `[链接] ${(m.link?.title || m.content).slice(0, 26)}`;
  return m.content.replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** 会话列表预览文本（最后一条非系统消息；富媒体给类型摘要）。 */
export function conversationPreview(conv: Conversation): string {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.from === 'system') continue;
    return messagePreviewText(m);
  }
  return conv.kind === 'group' ? `群聊（${groupPeopleCount(conv)}人）` : '开始聊天吧';
}

/** 会话列表一行的预览文本：群聊带发送者署名（真机微信「林晚：今晚八点老地方见」），私聊=纯预览。
 *  群内无任何非系统消息（预览是占位语）时不加署名，避免「群聊（3人）」被拼成「某某：群聊（3人）」。 */
export function conversationListPreview(conv: Conversation, meLabel: string): string {
  const base = conversationPreview(conv);
  if (conv.kind !== 'group') return base;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.from === 'system') continue;
    return `${m.from === 'me' ? meLabel : m.from}：${base}`;
  }
  return base;
}

/** 一条跨会话的消息命中（会话列表搜索 → 「聊天记录」段）。 */
export interface PhoneMessageHit {
  convId: string;
  convTitle: string;
  /** 群聊=行内补发送者署名（与会话列表群预览同口径）。 */
  isGroup: boolean;
  /** 发送者：'me' | 角色名 | 'system'（system 不进结果）。 */
  sender: string;
  message: PhoneMessage;
}

/**
 * 跨会话搜索消息正文（真机微信：会话列表搜索框 → 除「会话」外另有「聊天记录」段，点条目直达该条）。
 * 命中全局**新→旧**（按消息 ts 排，而非会话顺序），上限由调用方给（防超长会话撑爆结果页）。
 * 只搜非系统消息的正文；与聊天内搜索同一匹配口径（`includes`，大小写不敏感）。
 */
export function searchPhoneMessages(data: PhoneChatData, query: string, limit = 30): PhoneMessageHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: PhoneMessageHit[] = [];
  for (const conv of data.conversations) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.from === 'system') continue;
      if (!m.content.toLowerCase().includes(q)) continue;
      hits.push({ convId: conv.id, convTitle: conv.title, isGroup: conv.kind === 'group', sender: m.from, message: m });
    }
  }
  hits.sort((a, b) => b.message.ts - a.message.ts);
  return hits.slice(0, limit);
}

/** 会话列表搜索命中（真机微信：会话名 / 成员名 / 消息内容均可搜到）。 */
export function conversationMatches(conv: Conversation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (conv.title.toLowerCase().includes(q)) return true;
  if (conv.members.some(m => m.toLowerCase().includes(q))) return true;
  if (readyAtmosphereNames(conv).some(n => n.toLowerCase().includes(q))) return true;
  return conv.messages.some(m => m.content.toLowerCase().includes(q));
}

/** 语音条时长按转写字数前端直算（约 4 字/秒语速），1~60 秒（微信单条语音上限 60s）。 */
export function voiceDurationSeconds(content: string): number {
  const len = String(content || '').replace(/\s+/g, '').length;
  if (len <= 0) return 1;
  return Math.min(60, Math.max(1, Math.round(len / 4)));
}

/** 多选「编辑」准入判定（纯函数）：非系统气泡 + 文字/语音（语音 content=转写文本）。
 *  图片/转账/红包/合并记录不给编辑——改它们没有单一语义（画面描述/金额语义/快照）。 */
export function isMessageEditable(message: Pick<PhoneMessage, 'from' | 'type'> | undefined | null): boolean {
  if (!message || message.from === 'system') return false;
  return message.type === 'text' || message.type === 'voice';
}

// 故事时间快照是自由文本（全局数据表「当前时间」），显示侧只做成分提取，不做真实时钟。

/** 从故事时间文本提取日期（YYYY-MM-DD）与时刻（HH:MM）；提取不到为 ''。
 *  年份幅值 4-6 位（四位纪年为常态，五位以上如 14900 不能被截断）。 */
export function extractStoryDateTime(text: string): { date: string; time: string } {
  const raw = String(text || '');
  const dm = raw.match(/(\d{4,6})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})/);
  const hit = dm && !matchedInsideDigitRun(raw, dm.index) ? dm : null;
  const date = hit
    ? `${hit[1]}-${String(Number(hit[2])).padStart(2, '0')}-${String(Number(hit[3])).padStart(2, '0')}`
    : '';
  let time = '';
  const tm = raw.match(/(\d{1,2}):(\d{2})/);
  if (tm) {
    const h = Number(tm[1]);
    const m = Number(tm[2]);
    if (h <= 23 && m <= 59) time = `${String(h).padStart(2, '0')}:${tm[2]}`;
  }
  return { date, time };
}

/** 短时间（会话列表等紧凑位）：「05-18 17:24」；只有时刻→「17:24」；无时间成分回退原文。 */
export function storyTimeShort(text: string): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const { date, time } = extractStoryDateTime(raw);
  // 取月日走 monthDayOfDateKey：dateKey 允许 4-6 位年份，slice(5) 在五位纪年下会连字符错位
  if (date && time) return `${monthDayOfDateKey(date) || date} ${time}`;
  if (time) return time;
  if (date) return date;
  return raw;
}

// 真实时钟格式化函数已删除：全项目时间显示与提示词只用消息上的故事时间快照。

/** 会话排序快照（置顶优先，其次 updatedAt 降序；真机微信置顶会话恒定在列表顶部）。 */
export function sortedConversations(data: PhoneChatData): Conversation[] {
  return [...data.conversations].sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
}

/** 全部未读数。 */
export function totalUnread(data: PhoneChatData): number {
  return data.conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
}
