// ===== 小手机聊天图片·两步法第一步：提示词生成的上下文组装 =====
// 对齐主项目立绘生图（portrait-prompts.buildPortraitPrompt）的方案：
// system = 立绘 base system prompt（tags/natural 跟随所选预设的 composeMode，纯函数来自 portrait-prompt-text）
//        + 「聊天照片」场景增补段（覆盖 base 里的 solo/portrait 立绘默认倾向）；
// user_input = 发送者资料块 + 描述中点名的其他角色资料块 + 【图片内容】 + 【最近聊天记录】。
// 角色资料全部读取自小手机只读 roster 快照（神数据库 AutoCardUpdaterAPI），不 import 主项目 data-manager；
// 人物固定一致性 tag 另经 window.__ubPortraitCharTags 桥只读注入（主项目未加载/版本过旧/开关未开时回落散文）。
// 可编辑文本（单人基底/场景增补/标签网格、多人结构契约/要求提示词）已抽到
// core/image-prompt-slots（标准化提示词编辑模块 · 生图领域）；本文件只保留结构化常量与装配。
// 单人两个基底槽未本机覆盖时【跟随主项目】立绘同名槽（读主项目配置只读视图，不写）。

import type { NaturalPromptLanguage, PortraitComposeMode } from '../../unified-statusbar/core/portrait-config';
import {
  buildPortraitSystemPromptNatural,
  buildPortraitSystemPromptTags,
} from '../../unified-statusbar/core/portrait-prompt-text';
import { STORY_IMAGE_FANWORK_RULE } from '../../unified-statusbar/core/story-image-prompts';
import { composeShotDesc, type PhoneMessage } from './chat-model';
import { hostWindow } from './host-env';
import { getConfig as getHostConfig } from './host-config';
import type { BodyData, PresentState, RosterSnapshot } from './roster';
import type { PhoneMapLocation } from './map-locations';
// 可编辑写法规则文本的单一事实源（标准化提示词编辑模块 · 生图领域）：
// 用户覆盖由调用方经 promptOverrides 传入（= PhoneSettings.imagePrompts），空/缺省回落内置默认。
// 输出结构契约 / 同人规则段 / 完整示例 / 资料块与输入块结构均不在其中，用户改动碰不到。
import {
  IMAGE_SLOT_MULTI_REQUIREMENT,
  IMAGE_SLOT_MULTI_STRUCTURE,
  IMAGE_SLOT_MULTI_STRUCTURE_BATCH,
  IMAGE_SLOT_SINGLE_ADDENDUM,
  IMAGE_SLOT_SINGLE_GRID,
  IMAGE_SLOT_SINGLE_NATURAL,
  IMAGE_SLOT_SINGLE_TAGS,
  PHONE_FIXED_TAG_NOTE,
  PHONE_FIXED_TAG_RULE,
  PHONE_STORY_BATCH_CONTRACT,
  PHONE_STORY_IMAGE_CONTRACT,
  resolveImageSlotText,
} from './image-prompt-slots';

/** 主项目「生图 AI 请求提示词」板块覆盖表（只读；单人基底跟随链：本机 → 主项目 → 内置）。 */
function readHostImagePromptTemplates(): Record<string, string> {
  try {
    return (getHostConfig().imageGeneration?.promptTemplates || {}) as Record<string, string>;
  } catch (_e) {
    return {};
  }
}

/** 描述中最多附加几个"其他角色/主角"资料块（防 prompt 无界膨胀）。 */
const MAX_EXTRA_CHARACTERS = 3;
/** 单次生图出镜角色上限（相机多选同限；超出截断）。 */
const MAX_SUBJECTS = 4;
/** 聊天上下文：最近条数与总字数钳制。 */
const CONTEXT_MESSAGES = 12;
const CONTEXT_TOTAL_CHARS = 900;

/** 出镜角色（聊天=发送者+描述点名者；相机=用户多选）。 */
export interface PhoneImageSubject {
  name: string;
  isProtagonist: boolean;
}

// ─── 人物固定一致性 tag 跨 bundle 桥（主项目 index.ts 挂载 __ubPortraitCharTags） ───
// 主项目立绘为每个角色一次性生成 danbooru 外貌/身材固定标签（portrait-system charTags，useCharTags 开关
// 控制），立绘与正文插图均以此替代数据库散文注入；本桥让小手机生图同源复用。get 读主项目内存层最新值
// （含主角哨兵键匹配）；主项目未加载/版本过旧/开关未开启/角色无 tag 时返回 null → 回落 roster 散文注入
// （与 chat-images sharedImageQueue 同纪律）。

interface PhoneCharTags {
  appearance: string;
  body: string;
}

interface PortraitCharTagsBridge {
  get: (npc: string, isProtagonist?: boolean) => PhoneCharTags | null | undefined;
}

/** 读主项目固定 tag 桥；取不到或返回形态异常时返回 null（不缓存，每次生图现读最新内存态）。 */
export function sharedPortraitCharTags(npc: string, isProtagonist: boolean): PhoneCharTags | null {
  try {
    const bridge = (hostWindow() as unknown as { __ubPortraitCharTags?: PortraitCharTagsBridge })?.__ubPortraitCharTags;
    if (!bridge || typeof bridge.get !== 'function') return null;
    const tags = bridge.get(npc, isProtagonist);
    if (!tags || typeof tags.appearance !== 'string' || typeof tags.body !== 'string') return null;
    return tags.appearance.trim() ? { appearance: tags.appearance, body: tags.body } : null;
  } catch (_e) {
    return null;
  }
}

// ─── 同人角色标记跨 bundle 桥（主项目 index.ts 挂载 __ubPortraitFanwork） ───
// 与人物固定 tag 同一触发机制（按角色开关、与 useCharTags 互斥）：标注【同人】的角色资料块
// 不注入外貌/身材，身份由固化的同人身份 tag（__ubPortraitFanTags 桥）原样给出。
// 主项目未加载/版本过旧/未标记/身份 tag 未填时回落资料块散文注入，零破坏。

interface PortraitFanworkBridge {
  get: (npc: string) => boolean | undefined;
}

/** 读主项目同人标记桥；桥缺失/异常/主角返回 false（不缓存，每次生图现读最新内存态）。 */
export function sharedPortraitFanwork(npc: string, isProtagonist: boolean): boolean {
  if (!npc || isProtagonist) return false;
  try {
    const bridge = (hostWindow() as unknown as { __ubPortraitFanwork?: PortraitFanworkBridge })?.__ubPortraitFanwork;
    if (!bridge || typeof bridge.get !== 'function') return false;
    return bridge.get(npc) === true;
  } catch (_e) {
    return false;
  }
}

interface PortraitFanTagsBridge {
  get: (npc: string) => { character?: string; copyright?: string } | null | undefined;
}

/** 读主项目固化的同人身份 tag 桥（原作人物/作品）；桥缺失/异常/两项缺一/主角返回 null。
 *  同人标记开着但 tag 未识别未填时同样返回 null → 该角色按普通出图（不产出无身份可依的同人块）。 */
export function sharedPortraitFanTags(npc: string, isProtagonist: boolean): { character: string; copyright: string } | null {
  if (!npc || isProtagonist) return null;
  try {
    const bridge = (hostWindow() as unknown as { __ubPortraitFanTags?: PortraitFanTagsBridge })?.__ubPortraitFanTags;
    if (!bridge || typeof bridge.get !== 'function') return null;
    const t = bridge.get(npc);
    const character = String(t?.character || '').trim();
    const copyright = String(t?.copyright || '').trim();
    return character && copyright ? { character, copyright } : null;
  } catch (_e) {
    return null;
  }
}

// ─── 多人出镜：主项目正文插图（story-image）同款标签行管线 ───
// ≥2 个出镜角色时，第一步提示词请求整体切换为主项目文生图的结构与处理方法（用户定案）：
// 输出结构 = <UBS_image> 块内 Scene Composition / Character N Prompt / Character N UC / |centers
// 标签行（契约文案移植自主项目 STORY_IMAGE_FORMAT_CONTRACT 条款 5/6，去掉正文插图专属的
// position 定位/desc 行与多块输出）；同人生成规则段逐字复用主项目 STORY_IMAGE_FANWORK_RULE
// （其「Character Prompt 必须以角色标签开头」措辞与标签行结构天然对应，多同人角色逐角色各写
// 各的身份标签，无立绘单人身份槽位问题）；导演构思要求段移植主项目 DEFAULT_STORY_IMAGE_REQUIREMENT
// 的 S2~S9 写法（去掉正文选图/跨图连续性/主角出镜限制等正文专属项）。
// 第二步解析复用主项目 story-image-parser：parseMultiCharPrompt 拆多角色结构（含逐角色 UC 与
// centers 坐标），NAI 走 char_captions/use_coords，与主项目正文插图第二步完全同源。

// 完整示例（双人，其中一人为同人角色）：positionLine 参数区分单图（无 position 行）与批量（position=任务 id）
function phoneStoryExample(positionLine: string): string {
  return `<UBS_image>
<UBS_think>
S1 画面定格:「便利店门口两人分吃一支冰淇淋」→ 谁在哪做什么：店门口屋檐下两人并肩，同一支冰淇淋各自舔了一口；定格：递手瞬间，夕阳侧光。
S2 分级:无裸体/无器官/无性行为→Safe→sfw→不写器官。
S3 人物清点:N=2，雷姆（资料块【同人】，当前穿搭女仆装，开心）、阿伟（主角，连帽卫衣，窘）→duo, 1girl and 1boy。
S4 主体与构图:主体=C情感（亲昵打闹）；强调 playful intimacy，UC 排斥 calm/emotionless。构图三问：①马路对面齐胸高 ②路人旁观视线 ③侧面贴近放大互动→medium shot, from side。禁三件套否。
S5 外貌核对:雷姆→Q1 命中 IP→同人→Character Prompt 以 rem_(re:zero), re:zero_kara_hajimeru_isekai_seikatsu 开头，不写蓝发蓝瞳等模型已知外貌，只写此刻状态（微翘发梢、脸颊微红）；阿伟→原创→DNA 句开头（short messy brown hair, warm brown eyes, square jaw, medium build, tan skin）。脸型互异✓
S6 服装核对:雷姆=black maid dress with white apron, white headband；阿伟=navy hoodie, beige pants。
S7 动作+表情+空间:雷姆左位踮脚递冰淇淋（source#holding out ice cream cone）、grinning eyes, slight blush；阿伟右位俯身舔（target#leaning in to lick）、wry smile。facing each other✓
S8 负面:双方各带防崩4词+background characters+fused bodies；雷姆 UC 排斥 brown hair/brown eyes；阿伟 UC 排斥 blue hair/blue eyes/maid dress；双方排斥 nsfw, nude（Safe 级）。
S9 最终检查:Scene 齐✓ 双人物齐✓ UC 齐✓ sfw✓ centers=B2/D2 互异✓
</UBS_think>
${positionLine}image###
Scene Composition: 1girl and 1boy, duo, sfw, outside a convenience store at sunset, warm side light, playful intimate atmosphere, medium shot, from side;
Character 1 Prompt: rem_(re:zero), re:zero_kara_hajimeru_isekai_seikatsu, 1girl, black maid dress with white apron, white headband, hair slightly tousled, faint blush on cheeks, tiptoeing while holding out an ice cream cone, grinning eyes, source#holding out ice cream cone, facing right|centers:B2;
Character 1 UC: bad face, poorly drawn face, distorted face, asymmetrical face, background characters, fused bodies, brown hair, brown eyes, nsfw, nude;
Character 2 Prompt: 1boy, a young man with short messy brown hair, warm brown eyes, a square jaw, medium build, tan skin, navy hoodie, beige pants, leaning in to lick the ice cream, wry smile, target#leaning in to lick, facing left|centers:D2;
Character 2 UC: bad face, poorly drawn face, distorted face, asymmetrical face, background characters, fused bodies, blue hair, blue eyes, maid dress, nsfw, nude;###
</UBS_image>`;
}

/** 单图版示例（无 position 行，与单图输出结构契约一致）。 */
const PHONE_STORY_EXAMPLE_SINGLE = `## 完整示例（双人，其中一人为同人角色）\n${phoneStoryExample('')}`;

/** 批量版示例（带 position: 任务 id 行，与批量输出结构契约一致）。 */
const PHONE_STORY_EXAMPLE_BATCH = `## 完整示例（双人、含一位同人角色；批量时每块多一行 position: 任务id）\n${phoneStoryExample('position: s_post1\n')}`;

// 多人单图的角色资料节守卫头（对齐主项目 buildStoryImageCharacterSection 的守卫声明，出镜以【图片内容】为准）
const PHONE_STORY_CHAR_SECTION_HEADER = '## 角色资料（仅供外貌/体型/穿着核对；是否出镜以【图片内容】为准；标注【同人】的角色仅提供衣着与身份，外貌由其角色标签识别）';

/** 单个角色的资料块（结构对齐立绘 user_input，字段名与 base system prompt 的映射规则一致）。 */
interface CharacterInfo {
  name: string;
  gender: string;
  age: string;
  appearance: string;
  /** 一句话介绍（角色）/ 身份背景（主角）。 */
  intro: string;
  /** 显式当前状态（主角=主角信息表「近况」），优先于在场状态。 */
  status?: string;
  body?: BodyData | null;
  present?: PresentState | null;
  /** 主项目固定 tag 的身材段（桥命中时替代 body 注入，替代 NSFW信息数据，格式对齐立绘【身体数据】）。 */
  fixedBody?: string;
  /** 同人角色（主项目 fanwork 桥命中且身份 tag 就绪）：块首打【同人】标记，省略【外貌特征】【身体数据】。 */
  fanwork?: boolean;
  /** 固化的同人身份标签（原作人物/作品）：资料块原样给出，提示词照抄开头。 */
  fanTags?: { character: string; copyright: string };
}

function characterBlock(c: CharacterInfo, isProtagonist: boolean): string {
  const parts: string[] = [];
  if (c.fanwork) parts.push('【同人】');
  parts.push(
    `【角色姓名】\n${c.name}`,
    `【性别】\n${c.gender || '未知'}`,
    `【年龄】\n${c.age || '未知'}`,
  );
  if (c.fanwork && c.fanTags) parts.push(`【同人身份标签】\n${c.fanTags.character}, ${c.fanTags.copyright}`);
  if (!c.fanwork) parts.push(`【外貌特征】\n${c.appearance || '未描述'}`);
  if (!c.fanwork) {
    if (c.fixedBody) {
      parts.push(`【身体数据】\n${c.fixedBody}`);
    } else if (c.body && (c.body.heightWeight || c.body.measure)) {
      const segs: string[] = [];
      if (c.body.heightWeight) segs.push(`身高/体重：${c.body.heightWeight}`);
      if (c.body.measure) segs.push(`三围/罩杯：${c.body.measure}`);
      parts.push(`【身体数据】\n${segs.join('　')}`);
    }
  }
  parts.push(`【${isProtagonist ? '身份背景' : '一句话介绍'}】\n${c.intro || '无'}`);
  const status = c.status || c.present?.status || '';
  if (status) parts.push(`【当前状态】\n${status}`);
  if (c.present?.emotion) parts.push(`【情绪】\n${c.present.emotion}`);
  if (c.present && (c.present.outfit || c.present.top || c.present.bottom)) {
    parts.push(`【当前穿搭】\n${c.present.outfit || '未描述'}`);
    parts.push(`【上装】${c.present.top || '无'}　【下装】${c.present.bottom || '无'}　【内衣】${c.present.inner || '无'}　【袜子】${c.present.socks || '无'}　【鞋子】${c.present.shoes || '无'}　【饰品】${c.present.acc || '无'}`);
  }
  return parts.join('\n');
}

function protagonistInfo(name: string, roster: RosterSnapshot): CharacterInfo {
  return {
    name,
    gender: roster.protagonist.gender,
    age: roster.protagonist.age,
    appearance: roster.protagonist.appearance,
    intro: roster.protagonist.identity,
    status: roster.protagonist.condition,
    present: roster.present[name] || null,
  };
}

function contactInfo(name: string, roster: RosterSnapshot): CharacterInfo {
  const contact = roster.contacts.find(c => c.name === name) || null;
  return {
    name,
    gender: contact?.gender || '',
    age: contact?.age || '',
    appearance: contact?.appearance || '',
    intro: contact?.brief || '',
    body: roster.bodyData[name] || null,
    present: roster.present[name] || null,
  };
}

/**
 * 取会话内最近聊天记录（旧→新，一行一条「名字：内容」），作为第一步的"当前场景"上下文。
 * system 消息跳过；图片/语音转成短摘要；条数与总字数钳制。
 */
export function buildPhoneChatContext(messages: PhoneMessage[], protagonistName: string): string {
  const recent = messages.filter(m => m.from !== 'system').slice(-CONTEXT_MESSAGES);
  const lines: string[] = [];
  let total = 0;
  for (const m of recent) {
    const name = m.from === 'me' ? protagonistName : m.from;
    let content: string;
    if (m.type === 'image') content = `[照片：${m.content.slice(0, 40)}]`;
    else if (m.type === 'voice') content = `[语音]${m.content.slice(0, 40)}`;
    else content = m.content;
    content = content.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!content) continue;
    const line = `${name}：${content}`;
    total += line.length;
    if (total > CONTEXT_TOTAL_CHARS) break;
    lines.push(line);
  }
  return lines.join('\n');
}

/** 聊天照片的出镜角色集合：发送者 + 描述中点名的主角/通讯录角色（封顶补充 3 个）。 */
export function collectChatSubjects(
  senderName: string,
  senderIsProtagonist: boolean,
  description: string,
  roster: RosterSnapshot,
): PhoneImageSubject[] {
  const subjects: PhoneImageSubject[] = [{ name: senderName, isProtagonist: senderIsProtagonist }];
  if (!senderIsProtagonist && roster.protagonistName && description.includes(roster.protagonistName)) {
    subjects.push({ name: roster.protagonistName, isProtagonist: true });
  }
  for (const c of roster.contacts) {
    if (subjects.length >= 1 + MAX_EXTRA_CHARACTERS) break;
    if (c.name === senderName || !description.includes(c.name)) continue;
    if (subjects.some(s => s.name === c.name)) continue;
    subjects.push({ name: c.name, isProtagonist: false });
  }
  return subjects;
}

/**
 * 社媒帖子的出镜角色集合（贴吧/微博/小红书/朋友圈共用）：发帖人仅在其为主角或通讯录角色时携带资料块，
 * 路人作者（社媒 30% 配比的路人发帖人）不注入——否则 contactInfo 查无此人只会产出
 * 「性别未知/外貌未描述/介绍无」的空档案块污染第一步提示词；描述点名的角色本就只取自通讯录，保持不变。
 */
export function collectSocialPostSubjects(
  authorName: string,
  description: string,
  roster: RosterSnapshot,
): PhoneImageSubject[] {
  const isProtagonist = !!roster.protagonistName && authorName === roster.protagonistName;
  const subjects = collectChatSubjects(authorName, isProtagonist, description, roster);
  if (isProtagonist || roster.contacts.some(c => c.name === authorName)) return subjects;
  return subjects.filter(s => s.name !== authorName);
}

/**
 * 社媒帖的发帖人（相册条目的「来源角色」；用户定案：characters 只记发帖人一个，不再记出镜集合——
 * 画面里出现谁改由配图描述文字承载）。口径与 collectSocialPostSubjects 的档案注入一致：
 * 路人作者返回空串（没有档案，名字也无从指代）。
 */
export function socialPosterName(authorName: string, roster: RosterSnapshot): string {
  const name = (authorName || '').trim();
  if (!name) return '';
  if (roster.protagonistName && name === roster.protagonistName) return name;
  return roster.contacts.some(c => c.name === name) ? name : '';
}

/**
 * 「拍照描述生图」的图片描述拼接（发帖面板四 App 与聊天➕拍照共用；相机 App 在 shoot 时已同款拼接）：
 * 人物=生图实际出镜集合（发送者/发帖人 + 描述点名的通讯录角色，与生成侧 subjects 同源），
 * 按相机同款格式拼成「人物：描述」，无人物时自然降级为原描述。
 */
export function composeShootDesc(description: string, roster: RosterSnapshot): string {
  const desc = description.trim();
  if (!desc) return '';
  const me = roster.protagonistName || roster.userName || '我';
  return composeShotDesc(collectChatSubjects(me, true, desc, roster).map(s => s.name), '', desc);
}

/** 地点信息块（相机拍照用；来自主项目地图存储的描述信息）。 */
export function buildLocationBlock(location: PhoneMapLocation): string {
  const lines = [location.fullPath || location.name];
  if (location.summary) lines.push(`环境：${location.summary}`);
  if (location.rooms) lines.push(`内部：${location.rooms}`);
  if (location.items) lines.push(`可见物品：${location.items}`);
  return `【拍摄地点】\n${lines.join('\n')}`;
}

export interface BuildPhoneImagePromptArgs {
  /** 出镜角色（聊天=collectChatSubjects 产出；相机=用户所选）。 */
  subjects: PhoneImageSubject[];
  /** 图片消息的中文画面描述（消息 content / 相机输入）。 */
  description: string;
  /** 会话内最近聊天记录 / 主项目正文（空串则省略该块）。 */
  chatContext?: string;
  /** chatContext 块的标题标签（默认「最近聊天记录（旧→新）」；相机引用正文时传「最近正文进展」）。 */
  contextLabel?: string;
  /** 拍照地点（主项目地图存储；空则省略该块）。 */
  location?: PhoneMapLocation | null;
  roster: RosterSnapshot;
  composeMode: PortraitComposeMode;
  naturalLanguage?: NaturalPromptLanguage;
  /** 用户自定义生图提示词覆盖（PhoneSettings.imagePrompts；空/缺省=内置默认，见 core/image-prompt-slots）。 */
  promptOverrides?: Record<string, string>;
}

/** 第一步提示词的管线形态：portrait=主项目立绘同源（单人出镜）；story=主项目正文插图同款标签行结构（多人出镜）。 */
export type PhoneImagePromptFormat = 'portrait' | 'story';

export interface PhoneImagePromptResult {
  system: string;
  userInput: string;
  /** 管线形态（chat-images 据此选择解析与拍平路径）。 */
  format: PhoneImagePromptFormat;
  /** 出镜角色含【同人】（portrait 形态第二步拍平须传身份 tag；story 形态仅供上层感知）。 */
  fanwork: boolean;
  /** 固化同人身份 tag：portrait 形态单人出镜时为其身份标签，拍进最终提示词；story 形态为 null（逐角色在资料块内）。 */
  fanTags: { character: string; copyright: string } | null;
}

/**
 * 组装两步法第一步的 generateRaw 输入（用户定案的双管线）：
 * - 单人出镜：立绘同源管线，base system prompt 的 includeFanwork 跟随同人标记——同人角色的
 *   「禁外貌」由立绘 base 同人分支接管，身份 tag 由固化数据（__ubPortraitFanTags 桥）拍进提示词；
 * - ≥2 人出镜：主项目正文插图同款标签行管线（<UBS_image>/Scene/Character N Prompt/UC/|centers），
 *   同人规则段逐字复用 STORY_IMAGE_FANWORK_RULE，逐角色各写各的身份标签（无单人身份槽位问题）。
 */
export function buildPhoneImagePrompt(args: BuildPhoneImagePromptArgs): PhoneImagePromptResult {
  const { description, chatContext, contextLabel, location, roster, composeMode, naturalLanguage } = args;
  // 可编辑槽位文本（用户覆盖优先，空/缺省回落内置默认）；结构化常量不走这里，用户改不动
  const slotText = (key: string): string => resolveImageSlotText(key, args.promptOverrides);
  /** 追加段（原常量自带前导空行，这里按 \n\n 拼回；文本为空则不占位）。 */
  const slotSeg = (key: string): string => {
    const text = slotText(key);
    return text ? `\n\n${text}` : '';
  };

  // 资料块组装（两形态共用）：同人优先——fanwork 命中去外貌/身材（块首【同人】标记），charTags 替代跳过
  const subjects = args.subjects.slice(0, MAX_SUBJECTS);
  const blocks: string[] = [];
  let charTagsActive = false;
  let fanworkActive = false;
  let fanTagsActive: { character: string; copyright: string } | null = null;
  for (const subject of subjects) {
    const info = subject.isProtagonist ? protagonistInfo(subject.name, roster) : contactInfo(subject.name, roster);
    // 同人身份 tag 就绪才按同人块出（标记开着但未识别未填 → 回落普通资料块，避免无身份可依）
    const fanwork = sharedPortraitFanwork(subject.name, subject.isProtagonist);
    const fanTags = fanwork ? sharedPortraitFanTags(subject.name, subject.isProtagonist) : null;
    if (fanTags) {
      info.fanwork = true;
      info.fanTags = fanTags;
      fanworkActive = true;
      fanTagsActive = fanTags;
    } else {
      const tags = sharedPortraitCharTags(subject.name, subject.isProtagonist);
      if (tags) {
        info.appearance = tags.appearance;
        info.fixedBody = tags.body;
        charTagsActive = true;
      }
    }
    blocks.push(characterBlock(info, subject.isProtagonist));
  }

  // ── 多人（≥2 出镜角色）：主项目正文插图同款标签行管线 ──
  if (subjects.length >= 2) {
    const sections: string[] = [
      '## 任务：根据下方【图片内容】与角色资料块，为这张照片生成一个 <UBS_image> 插图块',
      slotText(IMAGE_SLOT_MULTI_STRUCTURE) || PHONE_STORY_IMAGE_CONTRACT,
    ];
    // 同人规则段写死逐字复用主项目（用户自定义无法覆盖；含【同人】角色时才拼接）
    if (fanworkActive) sections.push(STORY_IMAGE_FANWORK_RULE);
    sections.push(slotText(IMAGE_SLOT_MULTI_REQUIREMENT), PHONE_STORY_EXAMPLE_SINGLE);
    if (blocks.length) {
      sections.push([PHONE_STORY_CHAR_SECTION_HEADER + (charTagsActive ? `\n\n${PHONE_FIXED_TAG_NOTE}` : ''), blocks.join('\n\n')].join('\n\n'));
    }
    if (location) sections.push(buildLocationBlock(location));
    sections.push(`【图片内容】\n${description}`);
    if (chatContext) sections.push(`【${contextLabel || '最近聊天记录（旧→新）'}】\n${chatContext}`);
    sections.push('请按输出结构契约为该照片生成唯一一个 <UBS_image> 块。');
    // 全部指令在 user_input 自足注入（对齐主项目正文插图：system 仅破限），故 system 返回空串
    return { system: '', userInput: sections.join('\n\n'), format: 'story', fanwork: fanworkActive, fanTags: null };
  }

  // ── 单人：立绘同源管线（includeFanwork 跟随同人标记）──
  // 基底跟随链：本机覆盖 → 主项目立绘同名槽覆盖 → 内置（未自定义时按同人开关/语言自动分支）
  const localBase = (key: string): string => String((args.promptOverrides || {})[key] || '').trim();
  const hostBase = (slot: 'tags' | 'natural'): string => {
    const templates = readHostImagePromptTemplates();
    return String(templates[slot === 'natural' ? 'image:portrait:natural' : 'image:portrait:tags'] || '').trim();
  };
  const base = composeMode === 'natural'
    ? (localBase(IMAGE_SLOT_SINGLE_NATURAL) || hostBase('natural') || buildPortraitSystemPromptNatural(fanworkActive, naturalLanguage ?? 'en'))
    : (localBase(IMAGE_SLOT_SINGLE_TAGS) || hostBase('tags') || buildPortraitSystemPromptTags(fanworkActive));
  const parts: string[] = blocks;
  // 多角色 centers 网格说明仅 tags 模式有意义（NAI 多角色路径；natural 走散文没有角色槽）；
  // 同人角色的外貌禁令/角色标签要求已由 base 同人分支接管，不再追加任何同人规则段
  const system = base + slotSeg(IMAGE_SLOT_SINGLE_ADDENDUM)
    + (composeMode === 'tags' ? slotSeg(IMAGE_SLOT_SINGLE_GRID) : '')
    + (charTagsActive ? `\n\n${PHONE_FIXED_TAG_RULE}` : '');

  if (location) parts.push(buildLocationBlock(location));
  parts.push(`【图片内容】\n${description}`);
  if (chatContext) parts.push(`【${contextLabel || '最近聊天记录（旧→新）'}】\n${chatContext}`);
  parts.push(`请根据以上信息生成该照片的提示词。`);

  return { system, userInput: parts.join('\n\n'), format: 'portrait', fanwork: fanworkActive, fanTags: fanTagsActive };
}

// ─── 社媒配图批量第一步（一次 AI 请求为多张图出提示词；主项目正文插图同款 <UBS_image> 多块结构） ───
// 用户定案：批量路径整体切换主项目文生图结构——契约天然支持多块输出与单/多/零人物任务
// （S3 人物清点决定每块 Character 行数），每块的 position: 行写任务 id 供结果对应，
// 解析复用主项目 parseStoryImageBlocks（position 语义=任务 id，正文插图原文案兼容）。

export interface PhoneBatchImageTask {
  /** 任务 id（调用方自定义，如帖子 id 或 `c:帖子:楼层`——解析结果按此回填）。 */
  id: string;
  /** 该图的中文画面描述。 */
  description: string;
  /** 该图涉及的出镜角色名（用于在任务行写明，人物档案按并集注入）。 */
  characters: string[];
}

export interface BuildPhoneImagePromptBatchArgs {
  /** 本次批量任务（每任务一块；单图路径走 buildPhoneImagePrompt）。 */
  tasks: PhoneBatchImageTask[];
  /** 出镜角色并集（调用方对各任务涉及角色去重合并；档案块按上限截断）。 */
  subjects: PhoneImageSubject[];
  roster: RosterSnapshot;
  composeMode: PortraitComposeMode;
  naturalLanguage?: NaturalPromptLanguage;
  /** 用户自定义生图提示词覆盖（PhoneSettings.imagePrompts；空/缺省=内置默认，见 core/image-prompt-slots）。 */
  promptOverrides?: Record<string, string>;
}

/**
 * 组装批量第一步的 generateRaw 输入：主项目正文插图同款多块结构（每任务一个 <UBS_image> 块，
 * position: 行=任务 id）。全部指令在 user_input 自足注入（system 仅破限，返回空串）；
 * 含【同人】出镜角色时注入写死同人规则段（逐字复用主项目 STORY_IMAGE_FANWORK_RULE）。
 */
export function buildPhoneImagePromptBatch(args: BuildPhoneImagePromptBatchArgs): { system: string; userInput: string } {
  const subjects = args.subjects.slice(0, MAX_SUBJECTS * 2);
  // 可编辑槽位文本（用户覆盖优先，空/缺省回落内置默认）；契约/同人规则/示例仍是写死常量
  const slotText = (key: string): string => resolveImageSlotText(key, args.promptOverrides);
  const blocks: string[] = [];
  let fanworkActive = false;
  let charTagsActive = false;
  for (const subject of subjects) {
    const info = subject.isProtagonist ? protagonistInfo(subject.name, args.roster) : contactInfo(subject.name, args.roster);
    // 同人优先：fanwork 命中且身份 tag 就绪时资料块去外貌/身材（块打【同人】标记 + 身份标签行），charTags 替代跳过
    const fanwork = sharedPortraitFanwork(subject.name, subject.isProtagonist);
    const fanTags = fanwork ? sharedPortraitFanTags(subject.name, subject.isProtagonist) : null;
    if (fanTags) {
      info.fanwork = true;
      info.fanTags = fanTags;
      fanworkActive = true;
    } else {
      const tags = sharedPortraitCharTags(subject.name, subject.isProtagonist);
      if (tags) {
        info.appearance = tags.appearance;
        info.fixedBody = tags.body;
        charTagsActive = true;
      }
    }
    blocks.push(characterBlock(info, subject.isProtagonist));
  }
  const sections: string[] = [
    `## 任务：为下方清单中的每张图片各生成一个 <UBS_image> 插图块（共 ${args.tasks.length} 张，按清单顺序输出）`,
    slotText(IMAGE_SLOT_MULTI_STRUCTURE_BATCH) || PHONE_STORY_BATCH_CONTRACT,
  ];
  // 同人规则段写死逐字复用主项目（含【同人】角色时才拼接）
  if (fanworkActive) sections.push(STORY_IMAGE_FANWORK_RULE);
  sections.push(slotText(IMAGE_SLOT_MULTI_REQUIREMENT), PHONE_STORY_EXAMPLE_BATCH);
  if (blocks.length) {
    sections.push([PHONE_STORY_CHAR_SECTION_HEADER + (charTagsActive ? `\n\n${PHONE_FIXED_TAG_NOTE}` : ''), blocks.join('\n\n')].join('\n\n'));
  }
  sections.push(`## 本次待生成的图片清单（共 ${args.tasks.length} 张）`);
  for (const t of args.tasks) {
    const who = t.characters.length ? `（出镜：${t.characters.join('、')}）` : '';
    sections.push(`◇ 任务 ${t.id}${who}\n画面内容：${t.description}`);
  }
  sections.push(`请严格按任务顺序逐张输出 ${args.tasks.length} 个 <UBS_image> 块，每个块的 position: 行原样抄写对应任务 id。`);
  return { system: '', userInput: sections.join('\n\n') };
}
