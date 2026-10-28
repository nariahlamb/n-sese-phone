// ===== 不夜城数据模型（纯函数，零依赖，可被测试直接 require） =====
// 存储：PhoneChatData.night（并入 usb_phone_<h>.json，不新建存储域、不新建文件）。
// 只读单向域（docs/18 §1）：本模块只描述"本 App 自己的"数据形状，不认识世界书/时间线/其它 App；
// 归一化沿用社媒纪律——别名容错、none 哨兵、数量钳制、确定性散列、缺字段丢弃、全空域返回 null（零迁移）。
// 评论复用 social-model 的 SocialComment（含楼中楼 replyTo 指针与 buildCommentThreads）。

import { clampInt, excerptText, IMAGE_TEXT_NO_LIMIT, isRecord, makeId } from './ubp-utils';
import {
  appendSocialComments,
  normalizeSocialComment,
  removeCommentThread,
  type SocialComment,
} from './social-model';
import {
  clampNightSpice,
  isNightTag,
  NIGHT_DATE_MAX_STEP,
  NIGHT_MAX_BARRAGE,
  NIGHT_MAX_COMMENTS,
  NIGHT_MAX_DMS,
  NIGHT_MAX_DM_MSGS,
  NIGHT_MAX_ENTRIES,
  NIGHT_MAX_IMAGES,
  NIGHT_MAX_LIVES,
  NIGHT_MAX_NOTIFICATIONS,
  NIGHT_MAX_ORDERS,
  NIGHT_MAX_PERSONAS,
  NIGHT_MAX_POSTS_MAX,
  NIGHT_MAX_RANK,
  NIGHT_MAX_ROUNDS,
  NIGHT_BOARDS,
  NIGHT_TAGS_PER_POST,
  nightBoardDef,
  normalizeNightTags,
  normalizeSpice,
  type NightImageMode,
  type NightSpice,
} from './night-config';
import { formatStampFull, formatStampRelative, normalizeStoryTimeLabel, parseStamp } from './social-time';

// ─── 上限与常量（硬顶；用户可调项见 phone-settings） ───

/** 通知类型（消息页行图标与文案据此分派）。 */
export type NightNotifyType = 'reply' | 'post' | 'live' | 'entry' | 'dm' | 'order' | 'spot' | 'reject' | 'unlock';

/** 帖子类型（about 只在专题页出现）。 */
export type NightPostKind = 'text' | 'gallery' | 'bounty' | 'live' | 'about';

/** 揭层级（N2 分层揭开）：0 轮廓 / 1 局部 / 2 全图。 */
export type NightReveal = 0 | 1 | 2;

/** 直播状态机：预告 → 开台中 → 已结束（回看）。 */
export type NightLiveStatus = 'idle' | 'live' | 'ended';

/** 约会进程状态。 */
export type NightDateStatus = 'planned' | 'ongoing' | 'paused' | 'done';

/** 私信消息四型（date=约会卡）。 */
export type NightDmType = 'text' | 'image' | 'card' | 'date';

/** 点单反应的加码档位。 */
export type NightOrderTier = '口头' | '动作' | '专场';

// ─── 实体 ───

/** 一张图（分层揭开 + 可选门槛；与生图正交：L0/L1 点击若图未生成则同时触发生图）。 */
export interface NightImage {
  /** 中文画面描述（进生图提示词；相册条目 desc）。 */
  desc: string;
  path?: string;
  status?: 'pending' | 'ready' | 'failed';
  /** 固化的生图提示词（两步法第一步产物；存在=重试跳过文字 AI）。 */
  prompt?: string;
  negative?: string;
  /** 已选的揭层级；缺省=跟随设置 nightRevealDefault（未打码总开关关闭时恒为 2）。 */
  reveal?: NightReveal;
  /** L1 三区（脸/上身/下身）逐区揭开状态；缺省=[false,false,false]。 */
  zones?: boolean[];
  /** 门槛（成人平台特有）：热度/硬币达标即揭；consent=需作者同意（求解锁互动）。 */
  unlock?: { heat?: number; coins?: number; consent?: boolean };
  /** consent 门槛已获作者授权（本地置位）。 */
  unlocked?: boolean;
  /** 连拍序号（同一批出图的序列，查看器显示序列条）。 */
  seq?: number;
}

/** 委托（N7 悬赏）：求图/求文/求剧情。 */
export interface NightCommission {
  /** 想要什么（≤120 字）。 */
  want: string;
  spiceWanted: NightSpice;
  tags: string[];
  /** 悬赏文案（如「300 硬币 + 榜一署名」）。 */
  reward: string;
}

/** 委托应征条目。 */
export interface NightEntry {
  id: string;
  author: string;
  text: string;
  image?: NightImage;
  spice: NightSpice;
  at: number;
  adopted?: boolean;
}

export interface NightPost {
  id: string;
  /** 板块 id（NIGHT_BOARDS）。 */
  board: string;
  kind: NightPostKind;
  title: string;
  content: string;
  tags: string[];
  spice: NightSpice;
  author: string;
  /** 主角以马甲发的帖（界面加「马甲」徽标，不暴露真实身份）。 */
  byMe?: boolean;
  /** 该帖署名是马甲（byMe 时恒真；用于 AI 侧"匿名网友"口径）。 */
  maskedName?: string;
  images: NightImage[];
  commission?: NightCommission;
  entries?: NightEntry[];
  adoptedEntryId?: string;
  /** kind='live' 的预告帖指向的直播间 id。 */
  liveRef?: string;
  /** kind='about'（N6）的来源线索——AI 生成的一句氛围化线索，**不写楼层号**。 */
  sourceHint?: string;
  likes: number;
  likedByMe?: boolean;
  collects: number;
  collectedByMe?: boolean;
  /** 收藏是否入私密收藏夹（N8）。 */
  collectPrivate?: boolean;
  /** 求解锁次数（consent 门槛的计数展示）。 */
  unlockRequests: number;
  comments: SocialComment[];
  timeLabel: string;
  storyTime?: string;
  /** 规范绝对故事时间戳（落盘时盖；显示/注入用它换算）。 */
  storyStamp?: string;
  createdAt: number;
}

export interface NightBarrage {
  name: string;
  text: string;
  /** 弹幕行色调（本地按名字散列）。 */
  tint?: string;
  /** 被点名（台主叫到了这位观众）→ 高亮。 */
  spotlight?: boolean;
  /** 本 App 观众自己发的弹幕（界面标「我」）。 */
  byMe?: boolean;
}

export interface NightOrder {
  id: string;
  byMe?: boolean;
  /** 下单人（byMe=false 时是路人网名）。 */
  from: string;
  /** 点单内容（≤40 字）。 */
  text: string;
  spice: NightSpice;
  tier: NightOrderTier;
  accepted: boolean;
  /** 拒单理由（合规拒绝的对白，拒绝对白本身是内容）。 */
  rejectReason?: string;
  /** 加码累计值（heat 口径）。 */
  boost: number;
  coins: number;
  at: number;
  timeLabel: string;
  storyStamp?: string;
  /** 台主对该单的回应。 */
  reply?: string;
}

export interface NightRound {
  id: string;
  at: number;
  timeLabel: string;
  storyStamp?: string;
  /** 台主本轮发言（≤4 行）。 */
  streamerLines: string[];
  /** 本轮新增弹幕。 */
  barrages: NightBarrage[];
  heatDelta: number;
  /** 本轮事件（下播/榜一点名/私密房邀请/被拒；≤1）。 */
  event?: { type: string; name?: string; text?: string };
  /** 本轮为 1 对 1 私密房进程。 */
  private?: boolean;
}

export interface NightLive {
  id: string;
  streamer: string;
  /** 主角自己开的台（马甲署名）。 */
  byMe?: boolean;
  title: string;
  tags: string[];
  spice: NightSpice;
  coverDesc: string;
  coverPath?: string;
  coverStatus?: 'pending' | 'ready' | 'failed';
  coverPrompt?: string;
  coverNegative?: string;
  coverReveal?: NightReveal;
  heat: number;
  viewers: number;
  /** 私密房：需邀请/榜一可进。 */
  privateAvailable?: boolean;
  privateEntered?: boolean;
  status: NightLiveStatus;
  round: number;
  maxRound: number;
  barrage: NightBarrage[];
  rounds: NightRound[];
  /** 打赏榜（本地生成，新→旧按 amount 排序）。 */
  rank: Array<{ name: string; gift: string; amount: number }>;
  orders: NightOrder[];
  timeLabel: string;
  storyTime?: string;
  storyStamp?: string;
  createdAt: number;
}

export interface NightDmMsg {
  id: string;
  from: 'me' | 'peer';
  type: NightDmType;
  text?: string;
  image?: NightImage;
  card?: { title: string; sub?: string; glyph?: string };
  /** type='date' 时指向 night.me.dates 的约会 id。 */
  dateId?: string;
  ts: number;
  timeLabel: string;
  storyStamp?: string;
}

/** 单条私信是否可编辑（纯函数）：只有文字消息有单一语义；图片/礼物/约见卡改文字会改变类型语义。
 *  编辑与菜单准入共用同一口径（引擎写侧 + 渲染层入口）。 */
export function isNightDmMsgEditable(message: Pick<NightDmMsg, 'type' | 'text'> | undefined | null): boolean {
  return Boolean(message && message.type === 'text' && (message.text || '').trim());
}

export interface NightDm {
  id: string;
  peer: string;
  online?: boolean;
  /** 来源标签（来自「暗房」/来自 XX 的舞台）。 */
  sourceLabel?: string;
  /** 距离 flavor（同城夜话的人）。 */
  distanceLabel?: string;
  msgs: NightDmMsg[];
  unread: number;
  updatedAt: number;
  createdAt: number;
}

export interface NightDateNode {
  id: string;
  at: number;
  scene: string;
  lines: string[];
  /** 两选（改变下一节点基调）。 */
  choice?: { options: string[]; picked?: number };
  spice: NightSpice;
  timeLabel: string;
  storyStamp?: string;
}

export interface NightDate {
  id: string;
  peer: string;
  place: string;
  note: string;
  status: NightDateStatus;
  step: number;
  maxStep: number;
  nodes: NightDateNode[];
  createdAt: number;
  updatedAt: number;
}

/** N5 角色档案卡（身材/外貌取自 roster，偏好/底线/接受度 AI 生成）——点单被拒的依据。 */
export interface NightPersona {
  name: string;
  body: { height?: string; build?: string; bust?: string; waist?: string; hips?: string };
  appearance?: string;
  likes: string[];
  limits: string[];
  /** 接受度 1-3（越高越能接受越界请求）。 */
  acceptance: 1 | 2 | 3;
  spiceMax: NightSpice;
  posts: number;
  works: number;
  signature?: string;
  createdAt: number;
}

export interface NightFavorite {
  id: string;
  /** 私密收藏（N8：需长按解锁才显示）。 */
  private?: boolean;
}

export interface NightMe {
  /** 马甲（主角在本 App 的匿名身份；未生成过=''）。 */
  alias: string;
  aliasEdited?: boolean;
  level: number;
  coins: number;
  follows: string[];
  favorites: NightFavorite[];
  /** 我的约会（同时只允许 1 个进行中，见 nightActiveDateOf）。 */
  dates: NightDate[];
  /** 被拒记录（点单被台主按底线拒；本地记录）。 */
  rejections: Array<{ peer: string; reason: string; at: number }>;
  /** 隐身浏览（默认开）：浏览不写足迹、不生成「与我相关」通知。 */
  stealth?: boolean;
  /** 主角自己的台（开台=本地生成 1 次）。 */
  myLiveId?: string;
}

export interface NightNotification {
  id: string;
  type: NightNotifyType;
  /** 主动作人（回复我的人/发帖人/台主）。 */
  author: string;
  /** 自包含摘要（≤60 字）。 */
  content: string;
  /** 关联锚点（点行跳对应详情；缺省该内容已沉底）。 */
  postId?: string;
  liveId?: string;
  dmId?: string;
  time: string;
  storyStamp?: string;
  read?: boolean;
  createdAt: number;
}

export interface NightAbout {
  items: NightPost[];
  refreshedAt: number;
}

export interface NightData {
  /** 2 = persona 档案卡生成规则收紧为「从正文人设推导」（schema<2 存量卡一次性丢弃，见 normalizeNightData）。 */
  schema: 2;
  /** 板块表（整版重写，custom 保留；AI 不能自造板块）。 */
  boards: Array<{ id: string; custom?: boolean }>;
  posts: NightPost[];
  lives: NightLive[];
  dms: NightDm[];
  notifications: NightNotification[];
  me: NightMe;
  about?: NightAbout | null;
  /** 角色档案卡缓存（key=角色名）。 */
  personas?: Record<string, NightPersona>;
  refreshedAt: number;
  /** 最近一次生成失败的持久通知（用户点开才清；成功生成时作废）。 */
  lastError?: { text: string; ts: number };
}

// ─── 基础工具 ───

// ID 生成统一走 core/ubp-utils（原先此处自带一个 _seq 自增变体 = 全库第二份实现，本次收编删除）。

export const makeNightPostId = (): string => makeId('np');
export const makeNightLiveId = (): string => makeId('nl');
export const makeNightDmId = (): string => makeId('nd');
export const makeNightMsgId = (): string => makeId('nm');
export const makeNightOrderId = (): string => makeId('no');
export const makeNightDateId = (): string => makeId('nt');
export const makeNightEntryId = (): string => makeId('ne');
export const makeNightNotifyId = (): string => makeId('nn');

function trimmed(value: unknown, maxLen: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 数值钳制（参数顺序按本文件历史：value, fallback, min, max）；实现统一在 core/ubp-utils。 */
function int(value: unknown, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return clampInt(value, min, max, fallback);
}

/** storyStamp 输入净化（合法规范戳才透传）。 */
function stampInput(value: unknown): string {
  const raw = trimmed(value, 20);
  return raw && parseStamp(raw).date ? raw : '';
}

/**
 * 可信计数：非法输入按 种子 确定性散列出 120~9800 的数（同帖恒同值，重渲染不跳变）。
 * 与 social-model.plausibleCount 同思路，独立实现以保持本模块对外零耦合。
 */
export function nightPlausibleCount(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return 120 + (hash % 9700);
}

/** 弹幕行色调（按名字散列到一组霓虹色；界面与本地发弹幕共用）。 */
const BARRAGE_TINTS = ['#FF8FC7', '#8FD8FF', '#FFD48F', '#B79CFF', '#8FFFC2', '#FF9E9E'];
export function nightTintOf(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return BARRAGE_TINTS[hash % BARRAGE_TINTS.length];
}

// ─── 归一化 ───

function normalizeReveal(value: unknown): NightReveal | undefined {
  return value === 0 || value === 1 || value === 2 ? value : undefined;
}

function normalizeZones(value: unknown): boolean[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const zones = [Boolean(value[0]), Boolean(value[1]), Boolean(value[2])];
  return zones.some(Boolean) ? zones : [false, false, false];
}

function normalizeUnlock(value: unknown): NightImage['unlock'] {
  if (!isRecord(value)) return undefined;
  const unlock: NonNullable<NightImage['unlock']> = {};
  if (typeof value.heat === 'number' && Number.isFinite(value.heat) && value.heat > 0) unlock.heat = Math.floor(value.heat);
  if (typeof value.coins === 'number' && Number.isFinite(value.coins) && value.coins > 0) unlock.coins = Math.floor(value.coins);
  if (value.consent === true) unlock.consent = true;
  return Object.keys(unlock).length ? unlock : undefined;
}

/** 图片归一化（别名：image/imageDesc/img/desc；无描述又无成品图 → null）。 */
export function normalizeNightImage(value: unknown): NightImage | null {
  const raw: Record<string, unknown> = isRecord(value) ? value : { desc: value };
  const desc = trimmed(raw.desc ?? raw.image ?? raw.imageDesc ?? raw.img, IMAGE_TEXT_NO_LIMIT);
  const path = typeof raw.path === 'string' && raw.path ? raw.path.slice(0, 400) : '';
  if (!desc && !path) return null;
  const image: NightImage = { desc };
  if (path) image.path = path;
  if (raw.status === 'ready' || raw.status === 'pending' || raw.status === 'failed') image.status = raw.status;
  if (typeof raw.prompt === 'string' && raw.prompt.trim()) image.prompt = raw.prompt;
  else if (typeof raw.imagePrompt === 'string' && raw.imagePrompt.trim()) image.prompt = raw.imagePrompt;
  if (typeof raw.negative === 'string') image.negative = raw.negative;
  else if (typeof raw.imageNegative === 'string') image.negative = raw.imageNegative;
  const reveal = normalizeReveal(raw.reveal);
  if (reveal !== undefined) image.reveal = reveal;
  const zones = normalizeZones(raw.zones);
  if (zones) image.zones = zones;
  const unlock = normalizeUnlock(raw.unlock);
  if (unlock) image.unlock = unlock;
  if (raw.unlocked === true) image.unlocked = true;
  if (typeof raw.seq === 'number' && Number.isFinite(raw.seq)) image.seq = Math.floor(raw.seq);
  return image;
}

function normalizeImages(value: unknown): NightImage[] {
  if (!Array.isArray(value)) return [];
  const out: NightImage[] = [];
  let seq = 0;
  for (const raw of value) {
    const image = normalizeNightImage(raw);
    if (!image || !image.desc) continue;
    seq++;
    if (out.length === 0) image.seq = image.seq ?? 1;
    else if (image.seq === undefined) image.seq = seq;
    out.push(image);
    if (out.length >= NIGHT_MAX_IMAGES) break;
  }
  return out;
}

function normalizeCommission(value: unknown): NightCommission | undefined {
  if (!isRecord(value)) return undefined;
  const want = trimmed(value.want ?? value.text ?? value.content, 120);
  if (!want) return undefined;
  return {
    want,
    spiceWanted: normalizeSpice(value.spiceWanted ?? value.spice, 3),
    tags: normalizeNightTags(value.tags),
    reward: trimmed(value.reward ?? value.price, 40),
  };
}

function normalizeEntries(value: unknown): NightEntry[] {
  if (!Array.isArray(value)) return [];
  const out: NightEntry[] = [];
  for (const raw of value) {
    const entry = normalizeNightEntry(raw);
    if (!entry) continue;
    out.push(entry);
    if (out.length >= NIGHT_MAX_ENTRIES) break;
  }
  return out;
}

/** 单条委托应征归一化（解析层与存储层共用）。 */
export function normalizeNightEntry(value: unknown): NightEntry | null {
  if (!isRecord(value)) return null;
  const author = trimmed(value.author ?? value.name ?? value.from, 40);
  const text = trimmed(value.text ?? value.content, 600);
  const image = normalizeNightImage(value.image ?? value.imageDesc);
  if (!author || (!text && !image?.desc)) return null;
  const entry: NightEntry = {
    id: trimmed(value.id, 40) || makeNightEntryId(),
    author,
    text,
    spice: normalizeSpice(value.spice, 2),
    at: num(value.at ?? value.createdAt, Date.now()),
  };
  if (image?.desc) entry.image = image;
  if (value.adopted === true) entry.adopted = true;
  return entry;
}

function normalizeComments(value: unknown): SocialComment[] {
  return (Array.isArray(value) ? value : [])
    .map(normalizeSocialComment)
    .filter((c): c is SocialComment => c !== null)
    .slice(0, NIGHT_MAX_COMMENTS);
}

/** 帖子归一化：board 必须在册（AI 自造板块丢弃）、标题/正文至少有其一、byMe 与 maskedName 成对。 */
export function normalizeNightPost(value: unknown): NightPost | null {
  if (!isRecord(value)) return null;
  const board = trimmed(value.board ?? value.boardId, 24);
  const def = nightBoardDef(board);
  if (!def) return null;
  const kindRaw = trimmed(value.kind ?? value.type, 12);
  const kind: NightPostKind = kindRaw === 'gallery' || kindRaw === 'bounty' || kindRaw === 'live' || kindRaw === 'about' ? kindRaw : 'text';
  const title = trimmed(value.title, 60);
  const content = trimmed(value.content ?? value.text, 900);
  const author = trimmed(value.author ?? value.from ?? value.name, 40);
  if (!author) return null;
  if (!title && !content) return null;
  const images = normalizeImages(value.images ?? (value.image ?? value.imageDesc ? [value] : []));
  // gallery 缺图描述 → 降级 text（反幻觉：不能出现空图集）
  const finalKind: NightPostKind = kind === 'gallery' && !images.length ? 'text' : kind;
  const post: NightPost = {
    id: trimmed(value.id, 40) || makeNightPostId(),
    board,
    kind: finalKind,
    title,
    content,
    tags: normalizeNightTags(value.tags),
    spice: clampNightSpice(value.spice, def.spiceMax),
    author,
    images,
    likes: int(value.likes, 0, 0, 999999) || nightPlausibleCount(`l|${author}|${title || content.slice(0, 20)}`),
    collects: int(value.collects ?? value.stars, 0, 0, 999999) || Math.floor(nightPlausibleCount(`s|${title || content.slice(0, 20)}`) / 3),
    unlockRequests: int(value.unlockRequests ?? value.unlocks, 0, 0, 9999),
    comments: normalizeComments(value.comments),
    timeLabel: trimmed(value.time ?? value.timeLabel ?? value.t, 24) || '刚刚',
    createdAt: num(value.createdAt, Date.now()),
  };
  if (value.byMe === true) post.byMe = true;
  const masked = trimmed(value.maskedName, 12);
  if (masked) post.maskedName = masked;
  if (value.likedByMe === true) post.likedByMe = true;
  if (value.collectedByMe === true) post.collectedByMe = true;
  if (value.collectPrivate === true) post.collectPrivate = true;
  const commission = normalizeCommission(value.commission);
  if (commission) post.commission = commission;
  const entries = normalizeEntries(value.entries);
  if (entries.length) post.entries = entries;
  const adopted = trimmed(value.adoptedEntryId, 40);
  if (adopted) post.adoptedEntryId = adopted;
  const liveRef = trimmed(value.liveRef, 40);
  if (liveRef) post.liveRef = liveRef;
  const sourceHint = trimmed(value.sourceHint ?? value.source ?? value.hint, 60);
  if (sourceHint) {
    // 反全知 + 用户侧信道纪律：来源线索不写楼层号（"第X楼/楼层N"一律剥掉）
    post.sourceHint = sourceHint.replace(/第\s*\d+\s*楼|楼层\s*\d+/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 60);
  }
  if (typeof value.storyTime === 'string' && value.storyTime) post.storyTime = value.storyTime.slice(0, 60);
  const stamp = stampInput(value.storyStamp);
  if (stamp) post.storyStamp = stamp;
  for (const img of post.images) if (img.path && !img.status) img.status = 'ready';
  return post;
}

function normalizeBarrages(value: unknown, cap = NIGHT_MAX_BARRAGE): NightBarrage[] {
  return (Array.isArray(value) ? value : [])
    .map(normalizeNightBarrage)
    .filter((b): b is NightBarrage => b !== null)
    .slice(-cap);
}

/** 弹幕集合归一化（解析层与存储层共用同一实现）。 */
export function normalizeNightBarrageList(value: unknown, cap = NIGHT_MAX_BARRAGE): NightBarrage[] {
  return normalizeBarrages(value, cap);
}

/** 单条弹幕归一化（本地发弹幕与 AI 弹幕共用）。 */
export function normalizeNightBarrage(value: unknown): NightBarrage | null {
  if (!isRecord(value)) return null;
  const name = trimmed(value.name ?? value.from, 30);
  const text = trimmed(value.text ?? value.content ?? value.c, 80);
  if (!name || !text) return null;
  const barrage: NightBarrage = { name, text };
  const tint = trimmed(value.tint, 16);
  barrage.tint = tint || nightTintOf(name);
  if (value.spotlight === true) barrage.spotlight = true;
  if (value.byMe === true) barrage.byMe = true;
  return barrage;
}

function normalizeOrder(value: unknown): NightOrder | null {
  if (!isRecord(value)) return null;
  const text = trimmed(value.text ?? value.content ?? value.order, 60);
  if (!text) return null;
  const tierRaw = trimmed(value.tier, 6);
  const order: NightOrder = {
    id: trimmed(value.id, 40) || makeNightOrderId(),
    from: trimmed(value.from ?? value.name ?? value.by, 30) || '匿名观众',
    text,
    spice: normalizeSpice(value.spice, 2),
    tier: tierRaw === '动作' || tierRaw === '专场' ? tierRaw : '口头',
    accepted: value.accepted !== false,
    boost: int(value.boost, 0, 0, 9999999),
    coins: int(value.coins, 0, 0, 9999999),
    at: num(value.at ?? value.createdAt, Date.now()),
    timeLabel: trimmed(value.time ?? value.timeLabel, 24) || '刚刚',
  };
  if (value.byMe === true) order.byMe = true;
  const reason = trimmed(value.rejectReason ?? value.reason, 80);
  if (reason) order.rejectReason = reason;
  const reply = trimmed(value.reply, 200);
  if (reply) order.reply = reply;
  const stamp = stampInput(value.storyStamp);
  if (stamp) order.storyStamp = stamp;
  return order;
}

function normalizeRound(value: unknown): NightRound | null {
  if (!isRecord(value)) return null;
  const lines = (Array.isArray(value.streamerLines ?? value.lines)
    ? (value.streamerLines ?? value.lines) as unknown[]
    : []).map(l => trimmed(l, 200)).filter(Boolean).slice(0, 6);
  const round: NightRound = {
    id: trimmed(value.id, 40) || makeId('nr'),
    at: num(value.at, Date.now()),
    timeLabel: trimmed(value.time ?? value.timeLabel, 24) || '刚刚',
    streamerLines: lines,
    barrages: normalizeBarrages(value.barrages, 40),
    heatDelta: int(value.heatDelta ?? value.heat, 0, 0, 9999999),
  };
  if (isRecord(value.event)) {
    const type = trimmed(value.event.type, 20);
    if (type) round.event = { type, ...(trimmed(value.event.name, 30) ? { name: trimmed(value.event.name, 30) } : {}), ...(trimmed(value.event.text, 120) ? { text: trimmed(value.event.text, 120) } : {}) };
  }
  if (value.private === true) round.private = true;
  const stamp = stampInput(value.storyStamp);
  if (stamp) round.storyStamp = stamp;
  return round;
}

function normalizeRank(value: unknown): NightLive['rank'] {
  if (!Array.isArray(value)) return [];
  const out: NightLive['rank'] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = trimmed(raw.name ?? raw.from, 30);
    if (!name) continue;
    out.push({ name, gift: trimmed(raw.gift, 12) || '🌹', amount: int(raw.amount ?? raw.heat, 0, 0, 99999999) });
  }
  return out.sort((a, b) => b.amount - a.amount).slice(0, NIGHT_MAX_RANK);
}

export function normalizeNightLive(value: unknown): NightLive | null {
  if (!isRecord(value)) return null;
  const streamer = trimmed(value.streamer ?? value.author ?? value.name, 40);
  const title = trimmed(value.title, 60);
  if (!streamer || !title) return null;
  const statusRaw = trimmed(value.status, 8);
  const status: NightLiveStatus = statusRaw === 'live' || statusRaw === 'ended' ? statusRaw : 'idle';
  const live: NightLive = {
    id: trimmed(value.id, 40) || makeNightLiveId(),
    streamer,
    title,
    tags: normalizeNightTags(value.tags),
    spice: clampNightSpice(value.spice, 3),
    coverDesc: trimmed(value.coverDesc ?? value.cover, IMAGE_TEXT_NO_LIMIT),
    heat: int(value.heat, 0, 0, 99999999),
    viewers: int(value.viewers, 0, 0, 9999999) || nightPlausibleCount(`v|${streamer}|${title}`),
    status,
    round: int(value.round, 0, 0, 999),
    maxRound: int(value.maxRound, 12, 1, 99),
    barrage: normalizeBarrages(value.barrage),
    rounds: (Array.isArray(value.rounds) ? value.rounds : []).map(normalizeRound).filter((r): r is NightRound => r !== null).slice(-NIGHT_MAX_ROUNDS),
    rank: normalizeRank(value.rank),
    orders: (Array.isArray(value.orders) ? value.orders : []).map(normalizeOrder).filter((o): o is NightOrder => o !== null).slice(-NIGHT_MAX_ORDERS),
    timeLabel: trimmed(value.time ?? value.timeLabel, 24) || '刚刚',
    createdAt: num(value.createdAt, Date.now()),
  };
  if (value.byMe === true) live.byMe = true;
  if (typeof value.coverPath === 'string' && value.coverPath) live.coverPath = value.coverPath.slice(0, 400);
  if (value.coverStatus === 'ready' || value.coverStatus === 'pending' || value.coverStatus === 'failed') live.coverStatus = value.coverStatus;
  if (typeof value.coverPrompt === 'string' && value.coverPrompt.trim()) live.coverPrompt = value.coverPrompt;
  if (typeof value.coverNegative === 'string') live.coverNegative = value.coverNegative;
  const creveal = normalizeReveal(value.coverReveal);
  if (creveal !== undefined) live.coverReveal = creveal;
  if (value.privateAvailable === true) live.privateAvailable = true;
  if (value.privateEntered === true) live.privateEntered = true;
  if (typeof value.storyTime === 'string' && value.storyTime) live.storyTime = value.storyTime.slice(0, 60);
  const stamp = stampInput(value.storyStamp);
  if (stamp) live.storyStamp = stamp;
  if (live.coverPath && !live.coverStatus) live.coverStatus = 'ready';
  return live;
}

function normalizeDmMsg(value: unknown): NightDmMsg | null {
  if (!isRecord(value)) return null;
  const typeRaw = trimmed(value.type, 8);
  const text = trimmed(value.text ?? value.content, 300);
  const dateId = trimmed(value.dateId, 40);
  // AI 搭话契约（night-prompts「dm」）只给 text/image/card，不带 type。缺省时必须按字段形状判型：
  // 否则对方发来的图落到 text 分支（无文字→整条丢弃，有文字→只剩文字），礼物回执同样被降级。
  // 存量消息带显式 type，仍走原分支（显式优先）。
  const inferred: NightDmType = (value.image !== undefined && value.image !== null && value.image !== '')
    ? 'image'
    : isRecord(value.card) ? 'card'
      : dateId ? 'date'
        : 'text';
  const type: NightDmType = typeRaw === 'image' || typeRaw === 'card' || typeRaw === 'date' ? typeRaw : inferred;
  const image = type === 'image' ? normalizeNightImage(value.image ?? (text ? { desc: text } : null)) : null;
  const card = type === 'card' && isRecord(value.card)
    ? { title: trimmed(value.card.title, 40) || '礼物', ...(trimmed(value.card.sub, 60) ? { sub: trimmed(value.card.sub, 60) } : {}), ...(trimmed(value.card.glyph, 8) ? { glyph: trimmed(value.card.glyph, 8) } : {}) }
    : undefined;
  if (type === 'text' && !text) return null;
  if (type === 'image' && !image?.desc) return null;
  if (type === 'date' && !dateId) return null;
  const msg: NightDmMsg = {
    id: trimmed(value.id, 40) || makeNightMsgId(),
    from: value.from === 'peer' ? 'peer' : 'me',
    type,
    ts: num(value.ts ?? value.at, Date.now()),
    timeLabel: trimmed(value.time ?? value.timeLabel, 24) || '刚刚',
  };
  if (text) msg.text = text;
  if (image) msg.image = image;
  if (card) msg.card = card;
  if (dateId) msg.dateId = dateId;
  const stamp = stampInput(value.storyStamp);
  if (stamp) msg.storyStamp = stamp;
  return msg;
}

/** 私信会话归一化（peer 必填；消息按 ts 稳定排序并截断到上限）。 */
export function normalizeNightDm(value: unknown): NightDm | null {
  if (!isRecord(value)) return null;
  const peer = trimmed(value.peer ?? value.name, 40);
  if (!peer) return null;
  const msgs = (Array.isArray(value.msgs ?? value.messages) ? (value.msgs ?? value.messages) as unknown[] : [])
    .map(normalizeDmMsg)
    .filter((m): m is NightDmMsg => m !== null)
    .sort((a, b) => a.ts - b.ts)
    .slice(-NIGHT_MAX_DM_MSGS);
  const dm: NightDm = {
    id: trimmed(value.id, 40) || makeNightDmId(),
    peer,
    msgs,
    unread: int(value.unread, 0, 0, 999),
    updatedAt: num(value.updatedAt, msgs.length ? msgs[msgs.length - 1].ts : Date.now()),
    createdAt: num(value.createdAt, Date.now()),
  };
  if (value.online === true) dm.online = true;
  const sourceLabel = trimmed(value.sourceLabel ?? value.source, 40);
  if (sourceLabel) dm.sourceLabel = sourceLabel;
  const distanceLabel = trimmed(value.distanceLabel ?? value.distance, 24);
  if (distanceLabel) dm.distanceLabel = distanceLabel;
  return dm;
}

/** 单个约会节点归一化（解析层与存储层共用）。 */
export function normalizeNightDateNode(value: unknown): NightDateNode | null {
  if (!isRecord(value)) return null;
  const scene = trimmed(value.scene ?? value.text ?? value.content, 900);
  const lines = (Array.isArray(value.lines) ? value.lines : []).map(l => trimmed(l, 200)).filter(Boolean).slice(0, 8);
  if (!scene && !lines.length) return null;
  const node: NightDateNode = {
    id: trimmed(value.id, 40) || makeId('nd'),
    at: num(value.at, Date.now()),
    scene,
    lines,
    spice: normalizeSpice(value.spice, 2),
    timeLabel: trimmed(value.time ?? value.timeLabel, 24) || '刚刚',
  };
  if (isRecord(value.choice)) {
    const options = (Array.isArray(value.choice.options) ? value.choice.options : []).map(o => trimmed(o, 40)).filter(Boolean).slice(0, 3);
    if (options.length) {
      const pickedRaw = value.choice.picked;
      const picked = typeof pickedRaw === 'number' && Number.isFinite(pickedRaw) && pickedRaw >= 0 && pickedRaw < options.length
        ? Math.floor(pickedRaw)
        : undefined;
      node.choice = { options, ...(picked !== undefined ? { picked } : {}) };
    }
  }
  const stamp = stampInput(value.storyStamp);
  if (stamp) node.storyStamp = stamp;
  return node;
}

export function normalizeNightDate(value: unknown): NightDate | null {
  if (!isRecord(value)) return null;
  const peer = trimmed(value.peer ?? value.name, 40);
  if (!peer) return null;
  const statusRaw = trimmed(value.status, 10);
  const status: NightDateStatus = statusRaw === 'ongoing' || statusRaw === 'paused' || statusRaw === 'done' ? statusRaw : 'planned';
  const nodes = (Array.isArray(value.nodes) ? value.nodes : [])
    .map(normalizeNightDateNode)
    .filter((n): n is NightDateNode => n !== null)
    .slice(0, NIGHT_DATE_MAX_STEP);
  const date: NightDate = {
    id: trimmed(value.id, 40) || makeNightDateId(),
    peer,
    place: trimmed(value.place, 40),
    note: trimmed(value.note, 120),
    status,
    step: int(value.step, nodes.length, 0, NIGHT_DATE_MAX_STEP),
    maxStep: int(value.maxStep, NIGHT_DATE_MAX_STEP, 1, NIGHT_DATE_MAX_STEP),
    nodes,
    createdAt: num(value.createdAt, Date.now()),
    updatedAt: num(value.updatedAt, Date.now()),
  };
  return date;
}

export function normalizeNightPersona(value: unknown): NightPersona | null {
  if (!isRecord(value)) return null;
  const name = trimmed(value.name ?? value.author, 40);
  if (!name) return null;
  const bodyRaw = isRecord(value.body) ? value.body : {};
  const strList = (v: unknown, cap: number): string[] => (Array.isArray(v) ? v : [])
    .map(x => trimmed(x, 40)).filter(Boolean).slice(0, cap);
  const acceptanceRaw = typeof value.acceptance === 'number' ? Math.round(value.acceptance) : 2;
  const persona: NightPersona = {
    name,
    body: {
      ...(trimmed(bodyRaw.height ?? value.height, 20) ? { height: trimmed(bodyRaw.height ?? value.height, 20) } : {}),
      ...(trimmed(bodyRaw.build ?? value.build, 30) ? { build: trimmed(bodyRaw.build ?? value.build, 30) } : {}),
      ...(trimmed(bodyRaw.bust ?? value.bust, 20) ? { bust: trimmed(bodyRaw.bust ?? value.bust, 20) } : {}),
      ...(trimmed(bodyRaw.waist ?? value.waist, 20) ? { waist: trimmed(bodyRaw.waist ?? value.waist, 20) } : {}),
      ...(trimmed(bodyRaw.hips ?? value.hips, 20) ? { hips: trimmed(bodyRaw.hips ?? value.hips, 20) } : {}),
    },
    likes: strList(value.likes, 8),
    limits: strList(value.limits, 8),
    acceptance: (acceptanceRaw === 1 || acceptanceRaw === 3 ? acceptanceRaw : 2),
    spiceMax: normalizeSpice(value.spiceMax ?? value.spice, 2),
    posts: int(value.posts, 0, 0, 99999) || nightPlausibleCount(`p|${name}`) % 400,
    works: int(value.works, 0, 0, 99999) || nightPlausibleCount(`w|${name}`) % 90,
    createdAt: num(value.createdAt, Date.now()),
  };
  const appearance = trimmed(value.appearance, 200);
  if (appearance) persona.appearance = appearance;
  const signature = trimmed(value.signature, 60);
  if (signature) persona.signature = signature;
  return persona;
}

function normalizeFavorites(value: unknown): NightFavorite[] {
  if (!Array.isArray(value)) return [];
  const out: NightFavorite[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw.trim().slice(0, 40) : trimmed(isRecord(raw) ? raw.id : '', 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fav: NightFavorite = { id };
    if (isRecord(raw) && raw.private === true) fav.private = true;
    out.push(fav);
  }
  return out;
}

function normalizeMe(value: unknown): NightMe {
  const raw = isRecord(value) ? value : {};
  const me: NightMe = {
    alias: trimmed(raw.alias ?? raw.nickname, 12),
    level: int(raw.level, 1, 1, 999),
    coins: int(raw.coins, 260, 0, 9999999),
    follows: (Array.isArray(raw.follows) ? raw.follows : []).map(f => trimmed(f, 40)).filter(Boolean).slice(0, 60),
    favorites: normalizeFavorites(raw.favorites),
    dates: (Array.isArray(raw.dates) ? raw.dates : []).map(normalizeNightDate).filter((d): d is NightDate => d !== null).slice(-20),
    rejections: (Array.isArray(raw.rejections) ? raw.rejections : []).map(r => {
      if (!isRecord(r)) return null;
      const peer = trimmed(r.peer, 40);
      if (!peer) return null;
      return { peer, reason: trimmed(r.reason, 80), at: num(r.at, Date.now()) };
    }).filter((r): r is NightMe['rejections'][number] => r !== null).slice(-20),
  };
  if (raw.aliasEdited === true) me.aliasEdited = true;
  if (raw.stealth !== undefined) me.stealth = raw.stealth === true;
  const myLiveId = trimmed(raw.myLiveId, 40);
  if (myLiveId) me.myLiveId = myLiveId;
  return me;
}

function normalizeNotifications(value: unknown): NightNotification[] {
  if (!Array.isArray(value)) return [];
  const out: NightNotification[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const typeRaw = trimmed(raw.type, 10);
    const type: NightNotifyType = (
      typeRaw === 'reply' || typeRaw === 'post' || typeRaw === 'live' || typeRaw === 'entry'
      || typeRaw === 'dm' || typeRaw === 'order' || typeRaw === 'spot' || typeRaw === 'reject' || typeRaw === 'unlock'
    ) ? typeRaw : 'reply';
    const author = trimmed(raw.author ?? raw.name, 40);
    const content = trimmed(raw.content ?? raw.text, 60);
    if (!author || !content) continue;
    const postId = trimmed(raw.postId, 40);
    const liveId = trimmed(raw.liveId, 40);
    const dmId = trimmed(raw.dmId, 40);
    const key = `${type}\u0001${author}\u0001${content}\u0001${postId}\u0001${liveId}\u0001${dmId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const notif: NightNotification = {
      id: trimmed(raw.id, 40) || makeNightNotifyId(),
      type,
      author,
      content,
      time: trimmed(raw.time ?? raw.timeLabel, 24),
      createdAt: num(raw.createdAt, Date.now()),
    };
    if (postId) notif.postId = postId;
    if (liveId) notif.liveId = liveId;
    if (dmId) notif.dmId = dmId;
    const stamp = stampInput(raw.storyStamp);
    if (stamp) notif.storyStamp = stamp;
    if (raw.read === true) notif.read = true;
    out.push(notif);
    if (out.length >= NIGHT_MAX_NOTIFICATIONS) break;
  }
  return out;
}

function normalizeBoards(value: unknown): NightData['boards'] {
  const out: NightData['boards'] = [];
  const seen = new Set<string>();
  for (const raw of (Array.isArray(value) ? value : [])) {
    const id = typeof raw === 'string' ? raw.trim() : trimmed(isRecord(raw) ? raw.id : '', 24);
    if (!id || seen.has(id)) continue;
    const custom = isRecord(raw) && raw.custom === true;
    // AI 不能自造板块：非在册板块只允许 custom（用户手加）存活
    if (!nightBoardDef(id) && !custom) continue;
    seen.add(id);
    out.push({ id, ...(custom ? { custom: true } : {}) });
  }
  if (!out.length) return NIGHT_BOARDS.map(b => ({ id: b.id }));
  return out.slice(0, 12);
}

/**
 * NightData 归一化（磁盘读回容错）。
 * 全空域（无帖/无台/无会话/无通知/无马甲且无约会）返回 null——旧存档零迁移，不写空 night 键。
 */
export function normalizeNightData(value: unknown): NightData | null {
  if (!isRecord(value)) return null;
  const boards = normalizeBoards(value.boards);
  const posts = (Array.isArray(value.posts) ? value.posts : [])
    .map(normalizeNightPost)
    .filter((p): p is NightPost => p !== null)
    .slice(0, NIGHT_MAX_POSTS_MAX);
  const lives = (Array.isArray(value.lives) ? value.lives : [])
    .map(normalizeNightLive)
    .filter((l): l is NightLive => l !== null)
    .slice(0, NIGHT_MAX_LIVES);
  const dms = (Array.isArray(value.dms) ? value.dms : [])
    .map(normalizeNightDm)
    .filter((d): d is NightDm => d !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, NIGHT_MAX_DMS);
  const notifications = normalizeNotifications(value.notifications);
  const me = normalizeMe(value.me);
  const aboutRaw = isRecord(value.about) ? value.about : null;
  const aboutItems = aboutRaw && Array.isArray(aboutRaw.items)
    ? aboutRaw.items.map(normalizeNightPost).filter((p): p is NightPost => p !== null).slice(0, NIGHT_MAX_POSTS_MAX)
    : [];
  const about: NightAbout | null = aboutItems.length
    ? { items: aboutItems, refreshedAt: num(aboutRaw?.refreshedAt, Date.now()) }
    : null;
  // schema 1→2（2026-09-30 人设一致性修订）：档案卡生成规则收紧为「从正文人设推导」，
  // 旧缓存可能含凭空发明的偏好/接受度——升级时一次性丢弃（档案卡是可再生的缓存，用到会按新规则重生成）。
  const personasRaw = isRecord(value.personas) && num(value.schema, 1) >= 2 ? value.personas : {};
  const personas: Record<string, NightPersona> = {};
  for (const raw of Object.values(personasRaw)) {
    const persona = normalizeNightPersona(raw);
    if (!persona) continue;
    personas[persona.name] = persona;
    if (Object.keys(personas).length >= NIGHT_MAX_PERSONAS) break;
  }
  const data: NightData = {
    schema: 2,
    boards,
    posts,
    lives,
    dms,
    notifications,
    me,
    refreshedAt: num(value.refreshedAt, 0),
  };
  if (about) data.about = about;
  if (Object.keys(personas).length) data.personas = personas;
  if (isRecord(value.lastError)) {
    const text = trimmed(value.lastError.text, 300);
    if (text) data.lastError = { text, ts: num(value.lastError.ts, Date.now()) };
  }
  if (!data.posts.length && !data.lives.length && !data.dms.length && !data.notifications.length
    && !data.me.alias && !data.me.dates.length && !data.me.follows.length && !data.me.favorites.length
    && !data.about && data.boards.every(b => nightBoardDef(b.id))) return null;
  return data;
}

/** 空域（首建；板块表=内置六板块）。 */
export function emptyNightData(): NightData {
  return {
    schema: 2,
    boards: NIGHT_BOARDS.map(b => ({ id: b.id })),
    posts: [],
    lives: [],
    dms: [],
    notifications: [],
    me: { alias: '', level: 1, coins: 260, follows: [], favorites: [], dates: [], rejections: [], stealth: true },
    refreshedAt: 0,
  };
}

/** 取或建 night 域（引擎与渲染写路径共用；不动存储域外的任何字段）。 */
export function ensureNightData(holder: { night?: NightData | null }): NightData {
  const existing = holder.night;
  if (existing) return existing;
  const fresh = emptyNightData();
  holder.night = fresh;
  return fresh;
}

/** 读值（无 night 域时返回空域副本；渲染帧只读用，禁改写返回值）。 */
export function readNightOf(data: { night?: NightData | null }): NightData {
  return data.night || emptyNightData();
}

// ─── 板块表（整版重写，custom 保留） ───

export function replaceNightBoards(existing: NightData['boards'], fresh: Array<{ id: string }>): NightData['boards'] {
  // 模型层也守「AI 不能自造板块」：非在册且未标 custom 的 id 一律丢弃（custom=用户手加，跨刷新存活）
  const kept = fresh.filter(f => nightBoardDef(f.id) || existing.some(b => b.id === f.id && b.custom));
  const customs = existing.filter(b => b.custom && !kept.some(f => f.id === b.id) && !nightBoardDef(b.id));
  const merged: NightData['boards'] = [];
  const seen = new Set<string>();
  for (const b of [...kept, ...customs]) {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      merged.push(b);
    }
  }
  return merged.length ? merged : NIGHT_BOARDS.map(b => ({ id: b.id }));
}

/** 手动加板块（用户自造；custom 跨整版刷新存活）。 */
export function addNightBoard(data: NightData, id: string): boolean {
  const key = id.trim().slice(0, 12);
  if (!key || data.boards.some(b => b.id === key)) return false;
  data.boards = [...data.boards, { id: key, custom: true }];
  return true;
}

export function removeNightBoard(data: NightData, id: string): void {
  data.boards = data.boards.filter(b => b.id !== id || !b.custom);
  data.posts = data.posts.filter(p => p.board !== id);
}

// ─── 合并（滚动窗口） ───

/** 帖滚动窗口合并：新帖在前、同 id 保留新值、裁剪到上限。 */
export function mergeNightPosts(existing: NightPost[], fresh: NightPost[], cap: number): NightPost[] {
  const byId = new Map<string, NightPost>();
  for (const post of [...fresh, ...existing]) {
    if (!byId.has(post.id)) byId.set(post.id, post);
  }
  return Array.from(byId.values()).slice(0, Math.max(1, cap));
}

/** 直播间合并（同 id 保留新值；ended 超出上限按 createdAt 淘汰最旧）。 */
export function mergeNightLives(existing: NightLive[], fresh: NightLive[]): NightLive[] {
  const byId = new Map<string, NightLive>();
  for (const live of [...fresh, ...existing]) {
    if (!byId.has(live.id)) byId.set(live.id, live);
  }
  return Array.from(byId.values()).slice(0, NIGHT_MAX_LIVES);
}

/** 私信会话合并：同 peer 合流（消息按 id 去重、ts 排序），新会话在前。 */
export function mergeNightDms(existing: NightDm[], fresh: NightDm[]): NightDm[] {
  const byPeer = new Map<string, NightDm>();
  const absorb = (dm: NightDm): void => {
    const kept = byPeer.get(dm.peer);
    if (!kept) {
      byPeer.set(dm.peer, { ...dm, msgs: [...dm.msgs] });
      return;
    }
    const seen = new Set(kept.msgs.map(m => m.id));
    for (const msg of dm.msgs) if (!seen.has(msg.id)) kept.msgs.push(msg);
    kept.msgs.sort((a, b) => a.ts - b.ts);
    kept.msgs = kept.msgs.slice(-NIGHT_MAX_DM_MSGS);
    kept.updatedAt = Math.max(kept.updatedAt, dm.updatedAt);
    if (dm.online) kept.online = true;
    if (dm.sourceLabel) kept.sourceLabel = dm.sourceLabel;
    if (dm.distanceLabel) kept.distanceLabel = dm.distanceLabel;
  };
  for (const dm of existing) absorb(dm);
  for (const dm of fresh) absorb(dm);
  return Array.from(byPeer.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, NIGHT_MAX_DMS);
}

/** 轮次追加（原地；上限截断保尾）。 */
export function appendNightRound(live: NightLive, round: NightRound): void {
  live.rounds.push(round);
  if (live.rounds.length > NIGHT_MAX_ROUNDS) live.rounds.splice(0, live.rounds.length - NIGHT_MAX_ROUNDS);
  live.round = live.rounds.length;
}

/** 点单追加（原地；上限截断保尾）。 */
export function appendNightOrders(live: NightLive, orders: NightOrder[]): void {
  if (!orders.length) return;
  live.orders.push(...orders);
  if (live.orders.length > NIGHT_MAX_ORDERS) live.orders.splice(0, live.orders.length - NIGHT_MAX_ORDERS);
}

/** 弹幕追加（原地；上限截断保尾）。 */
export function appendNightBarrage(live: NightLive, items: NightBarrage[]): void {
  if (!items.length) return;
  live.barrage.push(...items);
  if (live.barrage.length > NIGHT_MAX_BARRAGE) live.barrage.splice(0, live.barrage.length - NIGHT_MAX_BARRAGE);
}

/** 打赏榜入账（原地：同名累加、按累计排序、上限截断）。 */
export function addNightTip(live: NightLive, name: string, gift: string, amount: number): void {
  if (amount <= 0) return;
  const hit = live.rank.find(r => r.name === name);
  if (hit) {
    hit.amount += amount;
    hit.gift = gift;
  } else {
    live.rank.push({ name, gift, amount });
  }
  live.rank.sort((a, b) => b.amount - a.amount);
  if (live.rank.length > NIGHT_MAX_RANK) live.rank.length = NIGHT_MAX_RANK;
}

/** 打赏榜首（无榜单返回 null）。 */
export function nightTopTipper(live: NightLive): NightLive['rank'][number] | null {
  return live.rank[0] || null;
}

/** 榜一特权：主角是榜首时，下一单必不拒绝 + 私密房直通 + 专属称呼。 */
export function nightTopPrivilege(live: NightLive, me: string): boolean {
  const top = nightTopTipper(live);
  return Boolean(top && top.name && top.name === me);
}

// ─── 约会进程（N4） ───

/** 当前进行中的约会（planned/ongoing/paused 均算占用；done 不算）。 */
export function nightActiveDate(me: NightMe): NightDate | null {
  return me.dates.find(d => d.status !== 'done') || null;
}

/** 追加约会节点（原地：步进 +1、节点截断到 maxStep、状态转 ongoing）。 */
export function applyNightDateNode(date: NightDate, node: NightDateNode): NightDate {
  date.nodes.push(node);
  if (date.nodes.length > date.maxStep) date.nodes.splice(0, date.nodes.length - date.maxStep);
  date.step = Math.min(date.nodes.length, date.maxStep);
  date.status = date.step >= date.maxStep ? 'done' : 'ongoing';
  date.updatedAt = Date.now();
  return date;
}

/** 记录本次节点的两选（选择改变下一节点基调）。 */
export function pickNightDateChoice(date: NightDate, nodeIndex: number, option: number): boolean {
  const node = date.nodes[nodeIndex];
  if (!node?.choice || option < 0 || option >= node.choice.options.length) return false;
  node.choice.picked = option;
  date.updatedAt = Date.now();
  return true;
}

// ─── 收藏 / 关注 / 通知（N8） ───

export function isNightFavorited(me: NightMe, id: string): boolean {
  return me.favorites.some(f => f.id === id);
}

/** 收藏切换（返回收藏后的状态；私密收藏夹标记随 favPrivate 传入）。 */
export function toggleNightFavorite(me: NightMe, id: string, favPrivate: boolean): boolean {
  const idx = me.favorites.findIndex(f => f.id === id);
  if (idx >= 0) {
    me.favorites.splice(idx, 1);
    return false;
  }
  me.favorites.unshift(favPrivate ? { id, private: true } : { id });
  if (me.favorites.length > 200) me.favorites.length = 200;
  return true;
}

export function toggleNightFollow(me: NightMe, name: string): boolean {
  const key = name.trim().slice(0, 40);
  if (!key) return false;
  const idx = me.follows.indexOf(key);
  if (idx >= 0) {
    me.follows.splice(idx, 1);
    return false;
  }
  me.follows.push(key);
  if (me.follows.length > 60) me.follows.splice(0, me.follows.length - 60);
  return true;
}

/** 通知追加（原地；同键去重、新→旧、上限截断）。 */
export function addNightNotifications(data: NightData, items: NightNotification[]): void {
  if (!items.length) return;
  const seen = new Set(data.notifications.map(n => `${n.type}\u0001${n.author}\u0001${n.content}\u0001${n.postId || ''}\u0001${n.liveId || ''}\u0001${n.dmId || ''}`));
  const fresh: NightNotification[] = [];
  for (const item of items) {
    const key = `${item.type}\u0001${item.author}\u0001${item.content}\u0001${item.postId || ''}\u0001${item.liveId || ''}\u0001${item.dmId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(item);
  }
  if (!fresh.length) return;
  data.notifications = [...fresh, ...data.notifications].slice(0, NIGHT_MAX_NOTIFICATIONS);
}

/** 未读通知数（badge 热路径读值）。 */
export function nightUnreadCount(night: NightData | null | undefined): number {
  if (!night) return 0;
  const notif = night.notifications.filter(n => !n.read).length;
  const dm = night.dms.reduce((sum, d) => sum + (d.unread || 0), 0);
  return notif + dm;
}

/** 打开某帖/某台/某会话 → 关联通知标已读（返回是否有变化——无未读零写盘）。 */
export function markNightNotificationsRead(data: NightData, patch: { postId?: string; liveId?: string; dmId?: string }): boolean {
  if (!data.notifications.length) return false;
  let changed = false;
  for (const n of data.notifications) {
    if (n.read) continue;
    if ((patch.postId && n.postId === patch.postId)
      || (patch.liveId && n.liveId === patch.liveId)
      || (patch.dmId && n.dmId === patch.dmId)) {
      n.read = true;
      changed = true;
    }
  }
  return changed;
}

export function markAllNightNotificationsRead(data: NightData): boolean {
  let changed = false;
  for (const n of data.notifications) {
    if (!n.read) {
      n.read = true;
      changed = true;
    }
  }
  return changed;
}

// ─── 读侧过滤（只按板块/标签/尺度档筛列表；不再有本机屏蔽与尺度上限） ───

export interface NightReadFilter {
  /** 只显示某一尺度档（0=不限；点击尺度徽标进入的「只看该档」）。 */
  spiceOnly?: NightSpice | 0;
  /** 板块筛选（''=全部）。 */
  board?: string;
  /** 标签筛选（''=全部）。 */
  tag?: string;
}

/** 帖子读侧可见性（纯列表筛选）。 */
export function nightPostVisible(post: NightPost, filter: NightReadFilter): boolean {
  if (filter.spiceOnly && post.spice !== filter.spiceOnly) return false;
  if (filter.board && post.board !== filter.board) return false;
  if (filter.tag && !post.tags.includes(filter.tag)) return false;
  return true;
}

/** 帖列表读侧过滤（专题页/我的帖不过滤——那是主角自己的产出）。 */
export function filterNightPosts(posts: NightPost[], filter: NightReadFilter): NightPost[] {
  return posts.filter(p => nightPostVisible(p, filter));
}

/** 帖子有效揭层级（未打码总开关关闭 → 恒全图）。 */
export function nightEffectiveReveal(image: NightImage, maskDefault: boolean, revealDefault: NightReveal): NightReveal {
  if (!maskDefault) return 2;
  if (image.reveal !== undefined) return image.reveal;
  return revealDefault;
}

/** 门槛是否已达标（热度/硬币为本地 flavor；consent 需作者授权）。 */
export function nightUnlockReady(image: NightImage, heat: number, coins: number): boolean {
  const unlock = image.unlock;
  if (!unlock) return true;
  if (unlock.consent) return image.unlocked === true;
  if (unlock.heat !== undefined && heat < unlock.heat) return false;
  if (unlock.coins !== undefined && coins < unlock.coins) return false;
  return true;
}

// ─── 删除连带（用户帖/会话/评论） ───

/**
 * 删除内容（帖/台）连带作废：帖 + 其关联通知 + 收藏 + about 里的副本；
 * 委托被删时其应征一并消失；直播间被删时其预告帖的 liveRef 悬空 → 预告帖一并删除（反幻觉）。
 */
export function deleteNightItems(data: NightData, ids: string[]): number {
  const idSet = new Set(ids.filter(Boolean));
  if (!idSet.size) return 0;
  const before = data.posts.length;
  data.posts = data.posts.filter(p => !idSet.has(p.id));
  // liveRef 悬空的预告帖一并清掉（防点进去空页）
  const liveIds = new Set(data.lives.map(l => l.id));
  data.posts = data.posts.filter(p => !(p.kind === 'live' && p.liveRef && !liveIds.has(p.liveRef)));
  const removed = before - data.posts.length;
  data.lives = data.lives.filter(l => !idSet.has(l.id));
  data.me.favorites = data.me.favorites.filter(f => !idSet.has(f.id));
  if (data.about) data.about.items = data.about.items.filter(p => !idSet.has(p.id));
  data.notifications = data.notifications.filter(n => !((n.postId && idSet.has(n.postId)) || (n.liveId && idSet.has(n.liveId))));
  return removed;
}

/** 删除一条评论（其楼中楼子回复按名字指针链一并删除）+ 关联通知作废。
    「关于我」传闻条目与普通帖共用详情视图与评论区，故两处都要找（此前只查 posts，
    传闻详情里删评论会静默失败）。 */
export function deleteNightComment(data: NightData, postId: string, index: number): number {
  const post = data.posts.find(p => p.id === postId) || data.about?.items.find(p => p.id === postId);
  if (!post || !post.comments[index]) return 0;
  const target = post.comments[index];
  const next = removeCommentThread(post.comments, index);
  const removed = post.comments.length - next.length;
  post.comments = next;
  const excerpt = target.text.slice(0, 40);
  data.notifications = data.notifications.filter(n => !(n.postId === postId && n.author === target.name && n.content === excerpt));
  return removed;
}

/** 删除私信会话（连带其约会进程与通知）。 */
export function deleteNightDm(data: NightData, dmId: string): boolean {
  const dm = data.dms.find(d => d.id === dmId);
  if (!dm) return false;
  data.dms = data.dms.filter(d => d.id !== dmId);
  data.me.dates = data.me.dates.filter(d => d.peer !== dm.peer);
  data.notifications = data.notifications.filter(n => n.dmId !== dmId);
  return true;
}

// ─── 评论追加（复用 social 纪律：主角发言永不被挤出） ───

export function appendNightComments(post: NightPost, incoming: SocialComment[], me: string): void {
  post.comments = appendSocialComments(post.comments, incoming, me, NIGHT_MAX_COMMENTS);
}

// ─── 摘要（列表页/资料块防重复共用） ───

export function nightExcerpt(text: string, max = 52): string {
  return excerptText(text, max);
}

/** 帖子人读标题（无标题的纯文字帖取正文首段）。 */
export function nightPostTitle(post: NightPost): string {
  return post.title || nightExcerpt(post.content, 18);
}

/** 时间（显示口径：相对分桶优先；存量数据用标签+锚点惰性归一，不可解析回退原文标签）。 */
export function nightTimeText(item: { timeLabel?: string; time?: string; storyStamp?: string; storyTime?: string }, now: string): string {
  const label = (item.timeLabel || item.time || '').trim();
  const stamp = (item.storyStamp || '').trim() || normalizeStoryTimeLabel(label, item.storyTime || '');
  if (!stamp) return label || '刚刚';
  return formatStampRelative(stamp, now) || formatStampFull(stamp) || label || '刚刚';
}

/** 帖时间（nightTimeText 的帖子专用别名）。 */
export function nightPostTime(post: { timeLabel?: string; storyStamp?: string; storyTime?: string }, now: string): string {
  return nightTimeText(post, now);
}

/** 帖标签补足（AI 产出不足下限时按板块补默认标签；不改已有标签）。 */
export function fillNightTags(post: NightPost): NightPost {
  if (post.tags.length >= 3) return post;
  const def = nightBoardDef(post.board);
  const fallback = def?.id === 'darkroom' ? ['私房', '自拍', '半裸']
    : def?.id === 'city' ? ['熟人', '双人']
      : def?.id === 'forbidden' ? ['背德', '偷情']
        : def?.id === 'rooftop' ? ['露出', '羞耻']
          : def?.id === 'backstage' ? ['道具', '沉溺']
            : ['羞耻', '双人'];
  const merged = [...post.tags];
  for (const tag of fallback) {
    if (merged.length >= 3) break;
    if (isNightTag(tag) && !merged.includes(tag)) merged.push(tag);
  }
  post.tags = merged.slice(0, NIGHT_TAGS_PER_POST);
  return post;
}

export type { NightImageMode };

/** 单条评论归一化（本地留言与 AI 评论共用同一净化器；解析层与引擎共用）。 */
export function normalizeNightCommentInput(value: unknown): SocialComment | null {
  return normalizeSocialComment(value);
}

/** 约会状态 → 人读标签（渲染层与资料块共用）。 */
export function nightDateStatusLabel(status: NightDateStatus): string {
  return status === 'ongoing' ? '进行中' : status === 'paused' ? '已暂停' : status === 'done' ? '已收尾' : '待应约';
}
