// ===== 正文联动（正文微信/电话：格式条目注入 + 渲染正则注入 + 提取落库） =====
// 链路：①世界书条目（[UBS手机]正文微信电话格式）教会 AI 在正文输出 <微信>/<通话> 片段；
//      ②全局显示正则（markdownOnly，不动聊天记录）把片段渲染成气泡/通话卡片；
//      ③MESSAGE_RECEIVED（对齐世界演化时点，500ms 防抖）提取片段写进小手机
//        （消息→私聊会话、通话→已接通记录；角色间互动→窥私域会话/通话；带 srcMesId 水印，
//         swipe/编辑重提取即整层替换——窥私侧含「提取建的空壳会话连场移除」）。
// 与世界演化联动（world-link）并存独立：事件结构同构但语义不同（演化=场外主动联系，本模块=场上已发生），
// 不做跨机制去重（用户定案）。渲染 CSS 走宿主 head 单份 <style>（消息内 class 会被 ST 加 custom- 前缀，
// 选择器双写兼容）；群聊会话不支持（角色书语义不明）。
// 仅私聊（用户定案）：统一三字段（发送人|接收人|内容）——发送人「我」=主角发出、接收人「我」=角色发给主角。
// 旧式两字段（角色名|内容）=角色发给主角，保留为**兼容形态**（历史楼层/swipe 重提取照常渲染提取），
// 但条目只教三字段（发送人|我|内容）这一种。
// 收发双方都是角色（与主角无关）=**角色间互动**：落库进**窥私域**（ensureSpyPrivateConversation，
// 同一对人=同一场；双方须为通讯录已知角色，正文仍渲染「A → B」气泡），不污染主角会话。
// 「我」为协议保留字；正文把主角写成真名等价于「我」（落库侧归一后再判方向）。

import { STORY_LINK_ENTRY_PREFIX } from '../../unified-statusbar/core/worldbook-entry';
import {
  addCallRecord,
  makeCallRecordId,
  normalizeCallRecord,
} from './call-model';
import {
  appendMessage,
  ensurePrivateConversation,
  makeMessageId,
  normalizePhoneMessage,
  type PhoneChatData,
  type PhoneStyle,
} from './chat-model';
import { getTavernHelper, hostWindow } from './host-env';
import { resolveAvatarPath } from './phone-avatars';
import { STORY_LINK_SOCIAL_KINDS, getPhoneSettings, type StoryLinkSocialKind } from './phone-settings';
import { mutatePhoneData, phoneStoreStatus, readPhoneDataRef } from './phone-store';
import { SOCIAL_POST_TAGS, socialPostTag } from './protocol-tags';
import { getRoster, mergedContactNames } from './roster';
import { ensureSpyDomain, ensureSpyPrivateConversation, pruneSpyConversations } from './spy-model';
import { appDisplayName, currentStyle } from './skins';
import { buildWorldSocialPost, mergeWorldSocialPost, type SocialPlatform } from './world-link';

// ─── 协议常量 ───

/** 主角消息发送人保留字（渲染与提取零歧义；存库映射为 from:'me'）。 */
export const STORY_LINK_ME = '__me__';

/** 格式条目名（受管前缀见主项目 worldbook-entry.STORY_LINK_ENTRY_PREFIX，自有 AI 管线一律剔除）。 */
export const STORY_LINK_ENTRY_NAME = `${STORY_LINK_ENTRY_PREFIX}正文微信电话格式`;

// ─── 社媒动态协议（第五轮 ⑦）─────────────────────────────────────────────
// 与 <微信>/<通话> 同款「多标签永久兼容 + 提示词按风格教一个」，差别在**字段布局按平台不同**：
//   朋友圈/微博：平台|作者|内容            贴吧：平台|吧名|作者|标题|内容      小红书：平台|作者|标题|内容
// 平台名按**风格**取（复用桌面 App 名的唯一事实源 appDisplayName：现代 朋友圈/贴吧/微博/小红书，
// 仙侠 浮生帖/论道坛/百晓阁/云笈录，武侠 故人笺/英雄楼/悦来茶馆/风物志，西幻 篝火手记/行会大厅/吟游诗社/藏宝图鉴），
// 解析侧同时认规范名与四套风格名（AI 用哪套都收）。
// **只做被勾选的平台**：未勾选的平台既不进提示词，也不注入渲染正则，也不提取（用户定案）。

interface SocialSpec {
  /** 规范名（现代风格名；appDisplayName 的 fallback）。 */
  canonical: string;
  /** 字段语义（含平台名在内共 fields.length+1 段；提示词与解析共用这一份）。 */
  fields: readonly string[];
}

const SOCIAL_SPECS: Record<SocialPlatform, SocialSpec> = {
  moments: { canonical: '朋友圈', fields: ['作者', '内容'] },
  weibo: { canonical: '微博', fields: ['作者', '内容'] },
  tieba: { canonical: '贴吧', fields: ['吧名', '作者', '标题', '内容'] },
  xhs: { canonical: '小红书', fields: ['作者', '标题', '内容'] },
};

const SOCIAL_STYLES: readonly PhoneStyle[] = ['', 'xianxia', 'wuxia', 'fantasy'];

/** 某平台的全部可识别名（规范名 + 四风格名，去重保序）。 */
function platformLabels(kind: SocialPlatform): string[] {
  const out: string[] = [];
  for (const style of SOCIAL_STYLES) {
    const label = appDisplayName(kind, SOCIAL_SPECS[kind].canonical, style);
    if (label && !out.includes(label)) out.push(label);
  }
  if (!out.includes(SOCIAL_SPECS[kind].canonical)) out.unshift(SOCIAL_SPECS[kind].canonical);
  return out;
}

const SOCIAL_LABELS: Record<SocialPlatform, string[]> = {
  moments: platformLabels('moments'),
  tieba: platformLabels('tieba'),
  weibo: platformLabels('weibo'),
  xhs: platformLabels('xhs'),
};

const SOCIAL_TAG_ALT = `(?:${SOCIAL_POST_TAGS.join('|')})`;
const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 单平台动态的匹配源码（渲染与提取**共用同一份**，行为必然一致）：
 *  `<标签>平台|字段…</标签>`；平台名用该平台的全部别名，字段字符类不允许 `|`/`｜`/`<`（协议要求里已声明）。 */
function socialSource(kind: SocialPlatform): string {
  const labels = SOCIAL_LABELS[kind].map(esc).join('|');
  const fields = SOCIAL_SPECS[kind].fields.map(() => '([^<|｜]+?)').join('\\s*[|｜]\\s*');
  return `<\\s*${SOCIAL_TAG_ALT}\\s*>\\s*(?:${labels})\\s*[|｜]\\s*${fields}\\s*<\\s*\\/\\s*${SOCIAL_TAG_ALT}\\s*>`;
}

/** 单平台动态 → 渲染卡片 HTML（正则壳；平台图标与品牌色由 DOM 增强器回填，core 不碰 DOM/图标）。 */
function socialReplace(kind: SocialPlatform): string {
  const glyph = `<span class="ubp-sl-post-glyph" data-ubp-sl-kind="${kind}"></span>`;
  if (kind === 'tieba') {
    return `<div class="ubp-sl-post" data-ubp-sl-post="tieba"><div class="ubp-sl-post-head">${glyph}<span class="nm">$2</span><span class="mt">$1</span></div><div class="ubp-sl-post-title">$3</div><div class="ubp-sl-post-body">$4</div></div>`;
  }
  if (kind === 'xhs') {
    return `<div class="ubp-sl-post" data-ubp-sl-post="xhs"><div class="ubp-sl-post-head">${glyph}<span class="nm">$1</span></div><div class="ubp-sl-post-title">$2</div><div class="ubp-sl-post-body">$3</div></div>`;
  }
  return `<div class="ubp-sl-post" data-ubp-sl-post="${kind}"><div class="ubp-sl-post-head">${glyph}<span class="nm">$1</span></div><div class="ubp-sl-post-body">$2</div></div>`;
}

/** 脚本展示名（酒馆正则面板可见，查重/移除锚点沿用 STORY_LINK_REGEX_PREFIX）。 */
const SOCIAL_SCRIPT_LABEL: Record<SocialPlatform, string> = {
  moments: '社媒动态（朋友圈）', tieba: '社媒动态（贴吧）', weibo: '社媒动态（微博）', xhs: '社媒动态（小红书）',
};
const SOCIAL_SCRIPT_ID: Record<SocialPlatform, string> = {
  moments: 'f3a1c2d4-0005-4a6b-9c2e-ub0000000005',
  tieba: 'f3a1c2d4-0006-4a6b-9c2e-ub0000000006',
  weibo: 'f3a1c2d4-0007-4a6b-9c2e-ub0000000007',
  xhs: 'f3a1c2d4-0008-4a6b-9c2e-ub0000000008',
};

/** 平台展示名（设置页 chips 与提示词里的平台名**同一份事实源**：规范名 + 风格名都从这里出）。 */
export function storyLinkSocialLabel(kind: SocialPlatform, style: PhoneStyle = currentStyle()): string {
  return appDisplayName(kind, SOCIAL_SPECS[kind].canonical, style);
}

/** 当前勾选的社媒平台（设置读取口；默认参数用它 ⇒ 调用签名与老代码兼容）。 */
export function storyLinkSocialKinds(): SocialPlatform[] {
  const picked = getPhoneSettings().storyLinkSocial;
  return STORY_LINK_SOCIAL_KINDS.filter((kind): kind is SocialPlatform => picked.includes(kind as StoryLinkSocialKind));
}

/** 条目内容（单条目、蓝灯常亮、钉 at_depth:0；只做要求不做解释）。 */
export const STORY_LINK_ENTRY_CONTENT = [
  '<正文手机格式>',
  '当剧情自然发展到微信聊天或打电话时，把内容按以下格式插进正文，其余照常叙述：',
  '微信：<微信>发送人|接收人|内容</微信>（都写角色真名，主角写「我」）；主角发出写 <微信>我|对方角色名|内容</微信>，角色发来写 <微信>角色名|我|内容</微信>，角色发给角色写 <微信>发送角色名|接收角色名|内容</微信>（连续多条消息就写多个<微信>标签）',
  '打电话：<通话>',
  '角色名：台词',
  '我：台词',
  '角色名：台词',
  '</通话>（每行一句台词；对方台词行以「角色名：」开头——写角色真名，不要写「对方」；我方台词行以「我：」开头）',
  '要求：消息与台词口语化简短，消息单条≤50字；消息内容与台词中不使用「|」和「<」；没有情节动机就不写；不要复述消息已表达的内容',
  '</正文手机格式>',
].join('\n');

/** 条目内容按风格取用（docs/11 §7.5：仙侠教 AI 写 <传讯>/<传音>；docs/11：武侠 <飞鸽>/<传声>、西幻 <晶讯>/<远语>；条目名/结构不变）。 */
/** 社媒段（按勾选平台拼装；未勾选=整段不出现）。平台名与字段布局都按当前风格/平台给出。 */
function socialEntryLines(style: PhoneStyle, social: readonly SocialPlatform[]): string[] {
  if (!social.length) return [];
  const tag = socialPostTag(style);
  const lines = ['社媒动态（下列每个平台写一条就是一条动态；平台名照抄，一条写一个标签）：'];
  for (const kind of social) {
    const label = appDisplayName(kind, SOCIAL_SPECS[kind].canonical, style);
    lines.push(`${label}：<${tag}>${[label, ...SOCIAL_SPECS[kind].fields].join('|')}</${tag}>`);
  }
  lines.push('要求：平台名只能用上面列出的那些；作者写角色真名（不写「我」）；字段顺序严格照上式（每个平台的字段都在上面列出）；标题与内容口语化简短，内容≤80字；内容中不使用「|」和「<」；没有情节动机就不写；不要复述正文已写过的内容');
  return lines;
}

export function storyLinkEntryContent(style: PhoneStyle, social: readonly SocialPlatform[] = storyLinkSocialKinds()): string {
  if (style === 'xianxia') {
    return [
      '<正文手机格式>',
      '当剧情自然发展到修士间传讯（玉简符讯）或神识传音时，把内容按以下格式插进正文，其余照常叙述：',
      '传讯：<传讯>发送人|接收人|内容</传讯>（都写名字，主角写「我」）；主角发出写 <传讯>我|对方名字|内容</传讯>，对方发来写 <传讯>名字|我|内容</传讯>，修士之间写 <传讯>发送者名字|接收者名字|内容</传讯>（连续多条消息就写多个<传讯>标签）',
      '神识传音：<传音>',
      '角色名：台词',
      '我：台词',
      '角色名：台词',
      '</传音>（每行一句台词；对方台词行以「角色名：」开头——写角色真名，不要写「对方」；我方台词行以「我：」开头）',
      '要求：消息与台词口语化简短，消息单条≤50字；消息内容与台词中不使用「|」和「<」；没有情节动机就不写；不要复述消息已表达的内容',
      ...socialEntryLines(style, social),
      '</正文手机格式>',
    ].join('\n');
  }
  if (style === 'wuxia') {
    return [
      '<正文手机格式>',
      '当剧情自然发展到江湖传书（飞鸽书信）或千里传声时，把内容按以下格式插进正文，其余照常叙述：',
      '飞鸽传书：<飞鸽>发送人|接收人|内容</飞鸽>（都写名字，主角写「我」）；主角发出写 <飞鸽>我|对方名字|内容</飞鸽>，对方发来写 <飞鸽>名字|我|内容</飞鸽>，角色之间写 <飞鸽>发送者名字|接收者名字|内容</飞鸽>（连续多条消息就写多个<飞鸽>标签）',
      '千里传声：<传声>',
      '角色名：台词',
      '我：台词',
      '角色名：台词',
      '</传声>（每行一句台词；对方台词行以「角色名：」开头——写角色真名，不要写「对方」；我方台词行以「我：」开头）',
      '要求：消息与台词口语化简短，消息单条≤50字；消息内容与台词中不使用「|」和「<」；没有情节动机就不写；不要复述消息已表达的内容',
      ...socialEntryLines(style, social),
      '</正文手机格式>',
    ].join('\n');
  }
  if (style === 'fantasy') {
    return [
      '<正文手机格式>',
      '当剧情自然发展到水晶传讯（晶讯）或远语时，把内容按以下格式插进正文，其余照常叙述：',
      '晶讯：<晶讯>发送人|接收人|内容</晶讯>（都写名字，主角写「我」）；主角发出写 <晶讯>我|对方名字|内容</晶讯>，对方发来写 <晶讯>名字|我|内容</晶讯>，角色之间写 <晶讯>发送者名字|接收者名字|内容</晶讯>（连续多条消息就写多个<晶讯>标签）',
      '远语：<远语>',
      '角色名：台词',
      '我：台词',
      '角色名：台词',
      '</远语>（每行一句台词；对方台词行以「角色名：」开头——写角色真名，不要写「对方」；我方台词行以「我：」开头）',
      '要求：消息与台词口语化简短，消息单条≤50字；消息内容与台词中不使用「|」和「<」；没有情节动机就不写；不要复述消息已表达的内容',
      ...socialEntryLines(style, social),
      '</正文手机格式>',
    ].join('\n');
  }
  // 现代（默认）：静态常量是契约锚点（tests 断言它的要素），社媒段按勾选拼在其后
  return [STORY_LINK_ENTRY_CONTENT, ...socialEntryLines(style, social)].join('\n');
}

/** 渲染正则脚本名前缀（酒馆正则面板可见，查重/移除锚点）。 */
export const STORY_LINK_REGEX_PREFIX = 'UBS手机-';

/** 提取/渲染共用正则（显示与提取同一套模式，行为必然一致）。
 *  多标签永久兼容：现代 <微信>/<通话>、仙侠 <传讯>/<传音>、武侠 <飞鸽>/<传声>、西幻 <晶讯>/<远语>
 *  都能渲染与提取（docs/11 §7.5、docs/11）。
 *  协议统一为 发送人|接收人|内容（条目只教这一种）：接收人「我」=角色发给主角、发送人「我」=主角发出、
 *  双方都不是「我」=角色间；旧式两字段（角色名|内容）=角色发给主角，作为兼容形态一并认。
 *  收发双方都是角色（与主角无关）只渲染不提取——三条消息正则互斥，「|」不出现在内容字段中保证不误配。 */
const WX_TAG = '(?:微信|传讯|飞鸽|晶讯)';
const WX_OPEN = `<\\s*${WX_TAG}\\s*>\\s*`;
const WX_CLOSE = `<\\s*\\/\\s*${WX_TAG}\\s*>`;
/** 发送人非「我」的守卫（「我」为协议保留字，单独走我方模式）。 */
const WX_NOT_ME = '(?!我\\s*[|｜])';
const WX_NAME = '([^|<｜]+?)';
const WX_CONTENT = '([^<|｜]+?)';
/** 主角发出：<标签>我|接收角色名|内容</标签>。 */
const WX_ME_SOURCE = `${WX_OPEN}我\\s*[|｜]\\s*${WX_NAME}\\s*[|｜]\\s*${WX_CONTENT}\\s*${WX_CLOSE}`;
/** 角色发给主角：规范形态 <标签>角色名|我|内容</标签>（接收人必须是「我」），
 *  兼容旧式两字段 <标签>角色名|内容</标签>（历史楼层/swipe 重提取照常渲染提取）。
 *  内容不得恰为「我」：那是规范形态漏写内容的残缺片段（`角色名|我`），按畸形整体丢弃，
 *  既不出气泡也不提取，免得把接收人字段当成一条内容为「我」的消息。 */
const WX_PEER_SOURCE = `${WX_OPEN}${WX_NOT_ME}${WX_NAME}\\s*[|｜]\\s*(?:我\\s*[|｜]\\s*)?(?!我\\s*${WX_CLOSE})${WX_CONTENT}\\s*${WX_CLOSE}`;
/** 角色发给角色（与主角无关）：<标签>发送角色名|接收角色名|内容</标签>——渲染「A → B」气泡，
 *  提取为 spy 事件落窥私域（收发双方都不是「我」；「我」在两侧都由 WX_NOT_ME 守卫排除）。 */
const WX_NPC_SOURCE = `${WX_OPEN}${WX_NOT_ME}${WX_NAME}\\s*[|｜]\\s*${WX_NOT_ME}${WX_NAME}\\s*[|｜]\\s*${WX_CONTENT}\\s*${WX_CLOSE}`;
// 通话块整体捕获（对方名不再单独占行，由台词行的「角色名：」前缀推导）
const CALL_SOURCE = '<\\s*(?:通话|传音|传声|远语)\\s*>([\\s\\S]*?)<\\s*\\/\\s*(?:通话|传音|传声|远语)\\s*>';

const WX_PEER_RE = new RegExp(WX_PEER_SOURCE, 'g');
const WX_ME_RE = new RegExp(WX_ME_SOURCE, 'g');
const WX_NPC_RE = new RegExp(WX_NPC_SOURCE, 'g');
const CALL_RE = new RegExp(CALL_SOURCE, 'g');

// ─── 渲染正则脚本（酒馆 RegexScriptData 形状；placement 2=AI输出，markdownOnly=只影响显示） ───

export interface StoryRegexScript {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number;
  minDepth: null;
  maxDepth: number | null;
}

function buildRegexScripts(social: readonly SocialPlatform[]): StoryRegexScript[] {
  const base = {
    trimStrings: [] as string[],
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    // 只渲染距最新楼 N 层以内的片段（控性能）；用户定案 6。
    maxDepth: 6 as number | null,
  };
  const socialScripts = SOCIAL_POST_SCRIPT_ORDER
    .filter(kind => social.includes(kind))
    .map(kind => ({
      ...base,
      id: SOCIAL_SCRIPT_ID[kind],
      scriptName: `${STORY_LINK_REGEX_PREFIX}${SOCIAL_SCRIPT_LABEL[kind]}`,
      findRegex: `/${socialSource(kind)}/g`,
      replaceString: socialReplace(kind),
    }));
  return [
    {
      ...base,
      id: 'f3a1c2d4-0002-4a6b-9c2e-ub0000000002',
      scriptName: `${STORY_LINK_REGEX_PREFIX}微信消息（我方）`,
      findRegex: `/${WX_ME_SOURCE}/g`,
      replaceString: '<div class="ubp-sl-wx ubp-sl-me" data-sender="我" data-peer="$1"><span class="ubp-sl-av"></span><div class="ubp-sl-col"><div class="ubp-sl-wx-bubble">$2</div></div></div>',
    },
    {
      ...base,
      id: 'f3a1c2d4-0001-4a6b-9c2e-ub0000000001',
      scriptName: `${STORY_LINK_REGEX_PREFIX}微信消息（角色）`,
      findRegex: `/${WX_PEER_SOURCE}/g`,
      replaceString: '<div class="ubp-sl-wx" data-sender="$1"><span class="ubp-sl-av"></span><div class="ubp-sl-col"><span class="ubp-sl-wx-name">$1</span><div class="ubp-sl-wx-bubble">$2</div></div></div>',
    },
    {
      ...base,
      id: 'f3a1c2d4-0004-4a6b-9c2e-ub0000000004',
      scriptName: `${STORY_LINK_REGEX_PREFIX}微信消息（角色间）`,
      findRegex: `/${WX_NPC_SOURCE}/g`,
      replaceString: '<div class="ubp-sl-wx" data-sender="$1" data-peer="$2"><span class="ubp-sl-av"></span><div class="ubp-sl-col"><span class="ubp-sl-wx-name">$1 → $2</span><div class="ubp-sl-wx-bubble">$3</div></div></div>',
    },
    {
      ...base,
      id: 'f3a1c2d4-0003-4a6b-9c2e-ub0000000003',
      scriptName: `${STORY_LINK_REGEX_PREFIX}通话卡片`,
      findRegex: `/${CALL_SOURCE}/g`,
      replaceString: '<div class="ubp-sl-call"><div class="ubp-sl-call-head"><span class="ubp-sl-call-title">通话</span></div><div class="ubp-sl-call-body">$1</div></div>',
    },
    // 第五轮 ⑦：社媒动态卡片（**只注入被勾选的平台**）
    ...socialScripts,
  ];
}

/** 全部社媒脚本的固定顺序（移除「已取消勾选」的脚本时要按名比对，故与勾选集合无关）。 */
const SOCIAL_POST_SCRIPT_ORDER: readonly SocialPlatform[] = ['moments', 'weibo', 'tieba', 'xhs'];

/** 全部社媒动态脚本名（勾选集合变化时用来清掉不再需要的那些）。 */
export const SOCIAL_POST_SCRIPT_NAMES: readonly string[] =
  SOCIAL_POST_SCRIPT_ORDER.map(kind => `${STORY_LINK_REGEX_PREFIX}${SOCIAL_SCRIPT_LABEL[kind]}`);

/** 注入用快照（每次取新数组，防调用方误改常量）。social 缺省=读设置（老调用签名不变）。 */
export function storyLinkRegexScripts(social: readonly SocialPlatform[] = storyLinkSocialKinds()): StoryRegexScript[] {
  return buildRegexScripts(social);
}

// ─── 提取（楼层原文 → 事件） ───

export interface StoryCallLine {
  from: 'me' | 'peer';
  text: string;
}

export interface StoryPhoneEvent {
  kind: 'message' | 'call' | 'post';
  /** message：发送人（STORY_LINK_ME=主角）；call：对方角色名（spy 通话=拨出方）；post：作者名。 */
  name: string;
  /** post（第五轮 ⑦）：平台。 */
  platform?: SocialPlatform;
  /** post：标题（贴吧/小红书必填）。 */
  title?: string;
  /** post：吧名（贴吧必填）。 */
  bar?: string;
  /** message：接收角色名（两字段我方/角色发给主角形态缺省）；spy 通话：接听方。 */
  peer?: string;
  text?: string;
  lines?: StoryCallLine[];
  /** 角色间互动（收发双方都不是主角）→ 落库目标是**窥私域**而非微信：
   *  message：name=发送人、peer=接收人；call：name=拨出方、peer=接听方（lines 的 'me'=拨出方台词）。 */
  spy?: true;
}

const NAME_MAX = 60;
const TEXT_MAX = 300;
const CALL_LINE_MAX = 200;
/** 社媒字段上限（用户定案：正文/标题/吧名一律 1000，parse 与落库两处同口径——
 *  下面这三个值必须 ≥ world-link 的 normalizeWorldLinkEvent 与 social-model 的帖模型上限，
 *  否则正文里写足的内容会在落库/读盘时被二次砍短）。 */
const SOCIAL_TEXT_MAX = 1000;
const SOCIAL_TITLE_MAX = 1000;
const SOCIAL_BAR_MAX = 1000;
// 通话行数与单层事件数**不设上限**（用户定案）：正文渲染本来无上限，落库侧设限会表现为
// 「正文完整、手机里那段少了半截」，且这两处都撞不出性能问题（单会话另有 2000 条 FIFO 护栏）。

function collectMatches(re: RegExp, text: string, map: (m: RegExpExecArray) => StoryPhoneEvent | null): Array<{ at: number; event: StoryPhoneEvent }> {
  const out: Array<{ at: number; event: StoryPhoneEvent }> = [];
  const rx = new RegExp(re.source, re.flags);
  for (let m = rx.exec(text); m !== null; m = rx.exec(text)) {
    const event = map(m);
    if (event) out.push({ at: m.index, event });
    if (m.index === rx.lastIndex) rx.lastIndex++; // 空匹配防御
  }
  return out;
}

function normalizePeerName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, NAME_MAX) : '';
}

/** 行内说话人前缀（容忍 AI 把名字与「对方」粘连：如「祝佩玲对方：」→ 名字取「祝佩玲」）。
 *  提取（parseCallBlock）与呈现层（renderers/story-link-enhance 的通话卡逐行气泡）共用。 */
export function splitSpeakerPrefix(line: string): { speaker: string; text: string } | null {
  const m = /^([^\s：:]{1,20})[：:]\s*(.+)$/.exec(line);
  if (!m) return null;
  const speaker = m[1].replace(/对方$/, '').trim();
  const text = m[2].trim();
  if (!speaker || !text) return null;
  return { speaker, text };
}

/** 通话块解析：对方名=首个非「我」说话人前缀（找不到则事件无效）。 */
export function parseCallBlock(body: string): { peer: string; lines: StoryCallLine[] } {
  let peer = '';
  const lines: StoryCallLine[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) continue;
    if (text.startsWith('我：') || text.startsWith('我:')) {
      const said = text.slice(2).trim();
      if (said) lines.push({ from: 'me', text: said.slice(0, CALL_LINE_MAX) });
      continue;
    }
    const split = splitSpeakerPrefix(text);
    if (split) {
      if (!peer) peer = split.speaker.slice(0, NAME_MAX);
      lines.push({ from: 'peer', text: split.text.slice(0, CALL_LINE_MAX) });
    } else {
      // 无前缀行（旁白容错）：归对方，但不确立对方名
      lines.push({ from: 'peer', text: text.slice(0, CALL_LINE_MAX) });
    }
  }
  return { peer, lines };
}

/** 角色间通话块解析（与主角通话互斥）：块里没有「我：」台词、且出现 ≥2 个不同说话人 → 角色间通话。
 *  拨出方=首个说话人（lines 的 'me'=拨出方）、接听方=第二个说话人；无前缀行归接听方（旁白容错同 parseCallBlock）。
 *  返回 null = 不是角色间通话（含「我」=主角通话；只有单方说话人=AI 只写了主角对面的台词，仍按主角通话）。 */
export function parseNpcCallBlock(body: string): { caller: string; callee: string; lines: StoryCallLine[] } | null {
  const raw: Array<{ speaker: string | null; text: string }> = [];
  const speakers: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) continue;
    if (text.startsWith('我：') || text.startsWith('我:')) return null; // 我方台词在场 → 主角通话
    const split = splitSpeakerPrefix(text);
    if (split) {
      if (split.speaker === '我') return null;
      if (!speakers.includes(split.speaker)) speakers.push(split.speaker);
      raw.push({ speaker: split.speaker, text: split.text });
    } else {
      raw.push({ speaker: null, text });
    }
  }
  const caller = speakers[0];
  const callee = speakers[1];
  if (!caller || !callee) return null;
  return {
    caller,
    callee,
    lines: raw.map(line => ({
      from: line.speaker === caller ? 'me' : 'peer',
      text: line.text.slice(0, CALL_LINE_MAX),
    })),
  };
}

/** 事件去重键：身份与内容完全相同的条目视为「同一条」。
 *  只用来压**相邻**重复（草稿/自检抄件、AI 手滑复读）；不同方向（`我|甲` 与 `甲`）键不同，不会互相误并。 */
function storyEventKey(event: StoryPhoneEvent): string {
  if (event.kind === 'message') return `m|${event.name}|${event.peer ?? ''}|${event.text ?? ''}`;
  if (event.kind === 'post') return `p|${event.platform ?? ''}|${event.name}|${event.bar ?? ''}|${event.title ?? ''}|${event.text ?? ''}`;
  const lines = Array.isArray(event.lines) ? event.lines : [];
  return `c|${event.name}|${event.peer ?? ''}|${lines.map(line => `${line.from}\u0001${line.text}`).join('\u0002')}`;
}

/** 楼层原文 → 社媒动态事件（第五轮 ⑦）：**只认被勾选的平台**；字段数/必备字段不符=丢弃，不猜。
 *  字段语义按平台（与提示词、渲染正则三方共用 SOCIAL_SPECS 一份）：朋友圈/微博=[作者,内容]、
 *  小红书=[作者,标题,内容]、贴吧=[吧名,作者,标题,内容]。作者写「我」的条目只渲染不落库（与角色间消息同口径）。 */
function collectSocialEvents(text: string, social: readonly SocialPlatform[]): Array<{ at: number; event: StoryPhoneEvent }> {
  const out: Array<{ at: number; event: StoryPhoneEvent }> = [];
  for (const kind of social) {
    const spec = SOCIAL_SPECS[kind];
    const needsTitle = kind === 'tieba' || kind === 'xhs';
    out.push(...collectMatches(new RegExp(socialSource(kind), 'g'), text, m => {
      const vals = spec.fields.map((_f, i) => String(m[i + 1] ?? '').trim());
      const clamp = (v: string, max: number): string => v.slice(0, max);
      let name = '';
      let title = '';
      let bar = '';
      let content = '';
      if (kind === 'tieba') {
        bar = clamp(vals[0] || '', SOCIAL_BAR_MAX);
        name = clamp(vals[1] || '', NAME_MAX);
        title = clamp(vals[2] || '', SOCIAL_TITLE_MAX);
        content = clamp(vals[3] || '', SOCIAL_TEXT_MAX);
        if (!bar) return null;
      } else if (kind === 'xhs') {
        name = clamp(vals[0] || '', NAME_MAX);
        title = clamp(vals[1] || '', SOCIAL_TITLE_MAX);
        content = clamp(vals[2] || '', SOCIAL_TEXT_MAX);
      } else {
        name = clamp(vals[0] || '', NAME_MAX);
        content = clamp(vals[1] || '', SOCIAL_TEXT_MAX);
      }
      if (!name || name === '我' || (needsTitle && !title) || !content) return null;
      const event: StoryPhoneEvent = { kind: 'post', platform: kind, name, text: content };
      if (bar) event.bar = bar;
      if (title) event.title = title;
      return event;
    }));
  }
  return out;
}

/** 楼层原文 → 事件列表（按正文出现顺序；相邻同内容压成一条）。
 *  角色间消息（WX_NPC_SOURCE 命中）提取为 spy 事件（落窥私域；落库侧按主角真名归一与白名单收口）。 */
export function extractStoryPhoneEvents(text: string, social: readonly SocialPlatform[] = storyLinkSocialKinds()): StoryPhoneEvent[] {
  if (!text) return [];
  const found: Array<{ at: number; event: StoryPhoneEvent }> = [
    ...collectMatches(WX_PEER_RE, text, m => {
      // 两字段=角色发给主角；三字段接收人=「我」也走这里（收件人字段由 WX_PEER 正则的可选段吸收）
      const name = normalizePeerName(m[1]);
      const content = typeof m[2] === 'string' ? m[2].trim().slice(0, TEXT_MAX) : '';
      if (!name || name === '我' || !content) return null;
      return { kind: 'message', name, text: content };
    }),
    ...collectMatches(WX_ME_RE, text, m => {
      const peer = normalizePeerName(m[1]);
      const content = typeof m[2] === 'string' ? m[2].trim().slice(0, TEXT_MAX) : '';
      if (!peer || peer === '我' || !content) return null;
      return { kind: 'message', name: STORY_LINK_ME, peer, text: content };
    }),
    ...collectMatches(WX_NPC_RE, text, m => {
      // 角色间消息（发送人|接收人|内容，双方都不是「我」）→ spy 事件
      const sender = normalizePeerName(m[1]);
      const receiver = normalizePeerName(m[2]);
      const content = typeof m[3] === 'string' ? m[3].trim().slice(0, TEXT_MAX) : '';
      if (!sender || !receiver || sender === receiver || !content) return null;
      return { kind: 'message', name: sender, peer: receiver, text: content, spy: true as const };
    }),
    ...collectMatches(CALL_RE, text, m => {
      const body = String(m[1] ?? '');
      const npc = parseNpcCallBlock(body);
      if (npc) return { kind: 'call', name: npc.caller, peer: npc.callee, lines: npc.lines, spy: true as const };
      const { peer, lines } = parseCallBlock(body);
      if (!peer || !lines.length) return null;
      return { kind: 'call', name: peer, lines };
    }),
    ...collectSocialEvents(text, social),
  ];
  let prevKey = '';
  const events: StoryPhoneEvent[] = [];
  for (const item of found.sort((a, b) => a.at - b.at)) {
    const key = storyEventKey(item.event);
    if (key === prevKey) continue; // 前后去重：同内容连着来几遍只留一条
    prevKey = key;
    events.push(item.event);
  }
  return events;
}

// ─── 落库（消息→私聊会话；通话→已接通记录；整层替换去重） ───

export interface StoryPhoneApplyOutcome {
  event: StoryPhoneEvent;
  ok: boolean;
  /** unknown-parties=角色间互动的当事人不在通讯录（窥私白名单；用户定案）。 */
  reason?: 'invalid-event' | 'unknown-parties';
  conversationId?: string;
  recordId?: string;
  /** post：落库的帖子 id（第五轮 ⑦）。 */
  postId?: string;
}

export interface StoryPhoneApplyCtx {
  storyTime?: string;
  srcMesId?: string;
  avatarFor?: (name: string) => string | undefined;
  /** 主角真名（正文把主角写成真名而非协议保留字「我」时按主角归一；空=不归一）。 */
  protagonistName?: string;
  /** 窥私白名单=通讯录已知角色（含自定义联系人，排除主角）；缺省=不设门槛（仅测试/旧调用路径会省略）。 */
  knownNames?: ReadonlySet<string> | null;
}

/** 通话方向启发：第一句台词是我方说的=主角拨出，否则=对方打来。 */
export function callDirectionFromLines(lines: readonly StoryCallLine[]): 'outgoing' | 'incoming' {
  return lines.length && lines[0].from === 'me' ? 'outgoing' : 'incoming';
}

/**
 * 通话时长估算：每句按 ≈4字/秒 语速（对齐 voiceDurationSeconds 口径）+ 2s 交接停顿累加，
 * 下限 10s（短通话不至于显示 00:00），上限 2h 防御。返回总时长与逐句相对秒（播放进度用）。
 */
export function estimateCallTiming(lines: readonly StoryCallLine[]): { durationSec: number; relSecs: number[] } {
  const relSecs: number[] = [];
  let t = 0;
  for (const line of lines) {
    relSecs.push(t);
    const speech = Math.ceil(line.text.replace(/\s/g, '').length / 4);
    t += Math.max(2, speech) + 2;
  }
  return { durationSec: lines.length ? Math.min(7200, Math.max(10, t)) : 0, relSecs };
}

/** 事件批应用到手机数据（纯函数直改 data；测试直接调用）。 */
export function applyStoryPhoneEvents(
  data: PhoneChatData,
  events: readonly StoryPhoneEvent[],
  ctx: StoryPhoneApplyCtx = {},
): StoryPhoneApplyOutcome[] {
  const outcomes: StoryPhoneApplyOutcome[] = [];
  let touchedSpy = false;
  for (const event of events) {
    if (event.kind === 'message') {
      const text = typeof event.text === 'string' ? event.text.trim().slice(0, TEXT_MAX) : '';
      if (!text) {
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      const me = (ctx.protagonistName || '').trim();
      let sender = normalizePeerName(event.name);
      let receiver = normalizePeerName(event.peer);
      // 主角真名归一（仅三字段形态需要）：正文常把主角写成真名而非协议保留字「我」——
      // 接收人=主角真名 ⇒ 角色发给主角；发送人=主角真名 ⇒ 主角发出（都退回微信路径）
      if (event.spy && me) {
        if (sender === me) sender = STORY_LINK_ME;
        if (receiver === me) receiver = '';
      }
      const isMe = sender === STORY_LINK_ME;
      if (event.spy && !isMe && receiver) {
        // 真·角色间（收发双方都不是主角）→ 窥私域：同一对人=同一场；双方须为通讯录已知角色
        if (sender === receiver) {
          outcomes.push({ event, ok: false, reason: 'invalid-event' });
          continue;
        }
        const known = ctx.knownNames;
        if (known && (!known.has(sender) || !known.has(receiver))) {
          outcomes.push({ event, ok: false, reason: 'unknown-parties' });
          continue;
        }
        const message = normalizePhoneMessage({
          id: makeMessageId(),
          from: sender,
          type: 'text',
          content: text,
          ts: Date.now(),
          ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
          ...(ctx.srcMesId ? { srcMesId: ctx.srcMesId } : {}),
        });
        const conv = message ? ensureSpyPrivateConversation(data, sender, receiver, ctx.srcMesId) : null;
        if (!conv || !message) {
          outcomes.push({ event, ok: false, reason: 'invalid-event' });
          continue;
        }
        appendMessage(conv, message);
        conv.unread += 1; // 窥私口径：与生成侧一致，逐条累计（含角色自己发的）
        touchedSpy = true;
        outcomes.push({ event, ok: true, conversationId: conv.id });
        continue;
      }
      if (!isMe && me && sender === me) {
        // 两字段形态写主角真名：发送人是主角但接收人缺省，无从归属（不落库，防建出以主角为名的会话）
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      if (isMe && (!receiver || receiver === '我')) {
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      const convName = isMe ? receiver : sender;
      if (!convName || convName === '我') {
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      const conv = ensurePrivateConversation(data, convName);
      const message = normalizePhoneMessage({
        id: makeMessageId(),
        from: isMe ? 'me' : convName,
        type: 'text',
        content: text,
        ts: Date.now(),
        ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
        ...(ctx.srcMesId ? { srcMesId: ctx.srcMesId } : {}),
      });
      if (!message) {
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      appendMessage(conv, message);
      if (!isMe) conv.unread += 1;
      outcomes.push({ event, ok: true, conversationId: conv.id });
      continue;
    }
    if (event.kind === 'post') {
      const platform = event.platform;
      const author = normalizePeerName(event.name);
      const content = typeof event.text === 'string' ? event.text.trim().slice(0, SOCIAL_TEXT_MAX) : '';
      if (!platform || !author || author === '我' || !content) {
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      // 复用世界演化投递的同一套「帖子构造 + 平台信息流 merge」（含滚动窗口与逐条未读通知）——
      // 正文里发生的事与演化投递在手机里是同一种存在，不另写一套落库管线。
      const post = buildWorldSocialPost({
        kind: 'social', platform, name: author, text: content,
        ...(event.title ? { title: event.title } : {}),
        ...(event.bar ? { bar: event.bar } : {}),
        ...(ctx.srcMesId ? { srcMesId: ctx.srcMesId } : {}),
      }, { storyTime: ctx.storyTime });
      if (!post) {
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      mergeWorldSocialPost(data, platform, post, () => getPhoneSettings().socialMaxPosts);
      outcomes.push({ event, ok: true, postId: post.id });
      continue;
    }
    const name = normalizePeerName(event.name);
    const lines = Array.isArray(event.lines) ? event.lines : [];
    if (!name || name === '我' || !lines.length) {
      outcomes.push({ event, ok: false, reason: 'invalid-event' });
      continue;
    }
    if (event.spy) {
      // 角色间通话（name=拨出方、peer=接听方；lines 的 'me'=拨出方台词）→ 窥私通话记录
      const callee = normalizePeerName(event.peer);
      if (!callee || callee === name) {
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      const known = ctx.knownNames;
      if (known && (!known.has(name) || !known.has(callee))) {
        outcomes.push({ event, ok: false, reason: 'unknown-parties' });
        continue;
      }
      const avatar = ctx.avatarFor?.(callee);
      const timing = estimateCallTiming(lines);
      const record = normalizeCallRecord({
        id: makeCallRecordId(),
        peerName: callee,
        ...(avatar ? { peerAvatar: avatar } : {}),
        caller: name,
        direction: 'outgoing',
        status: 'answered',
        durationSec: timing.durationSec,
        startedAt: Date.now(),
        ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
        lines: lines.map((line, index) => ({ from: line.from, text: line.text, relSec: timing.relSecs[index] ?? 0 })),
        seen: false, // 窥私口径：与生成侧一致（打开通话 tab 置 seen）
        ...(ctx.srcMesId ? { srcMesId: ctx.srcMesId } : {}),
      });
      if (!record) {
        outcomes.push({ event, ok: false, reason: 'invalid-event' });
        continue;
      }
      const spy = ensureSpyDomain(data);
      spy.calls = addCallRecord(spy.calls, record);
      touchedSpy = true;
      outcomes.push({ event, ok: true, recordId: record.id });
      continue;
    }
    const avatar = ctx.avatarFor?.(name);
    const timing = estimateCallTiming(lines);
    const record = normalizeCallRecord({
      id: makeCallRecordId(),
      peerName: name,
      ...(avatar ? { peerAvatar: avatar } : {}),
      direction: callDirectionFromLines(lines),
      status: 'answered',
      durationSec: timing.durationSec,
      startedAt: Date.now(),
      ...(ctx.storyTime ? { storyTime: ctx.storyTime } : {}),
      lines: lines.map((line, index) => ({ from: line.from, text: line.text, relSec: timing.relSecs[index] ?? 0 })),
      seen: true,
      ...(ctx.srcMesId ? { srcMesId: ctx.srcMesId } : {}),
    });
    if (!record) {
      outcomes.push({ event, ok: false, reason: 'invalid-event' });
      continue;
    }
    data.calls = addCallRecord(data.calls || [], record);
    outcomes.push({ event, ok: true, recordId: record.id });
  }
  // 窥私域有新增 → 会话条数按生成侧同款 FIFO 收敛（提取也会新建会话）
  if (touchedSpy) pruneSpyConversations(ensureSpyDomain(data));
  return outcomes;
}

/** 同楼层重提取：清掉旧提取条目（swipe/编辑/重生成→整层替换）。 */
/** 社媒四条信息流（正文联动提取的帖子按 srcMesId 混在其间）。 */
function socialFeeds(data: PhoneChatData): Array<Array<{ srcMesId?: string }>> {
  const social = data.social;
  if (!social) return [];
  return [social.moments, social.tieba, social.weibo, social.xhs] as Array<Array<{ srcMesId?: string }>>;
}

export function removeStoryLinkItems(data: PhoneChatData, srcMesId: string): void {
  if (!srcMesId) return;
  const convs = [data.conversations, ...(data.spy?.conversations ? [data.spy.conversations] : [])];
  for (const list of convs) {
    // 倒序：提取建出的窥私会话被清空时要整场移除（不留空壳）
    for (let i = list.length - 1; i >= 0; i--) {
      const conv = list[i]!;
      if (!conv.messages.some(m => (m as { srcMesId?: string }).srcMesId === srcMesId)) continue;
      conv.messages = conv.messages.filter(m => (m as { srcMesId?: string }).srcMesId !== srcMesId);
      // 带标记=这场的存在源于提取（窥私只读、不会混入用户消息）：消息清空即整场移除，不留空壳；
      // 手动建的场（无标记）空着也不动（可能有用户的空场引导意图）
      if (!conv.messages.length && conv.srcMesId) list.splice(i, 1);
    }
  }
  if (data.calls?.length) {
    data.calls = data.calls.filter(c => c.srcMesId !== srcMesId);
  }
  if (data.spy?.calls?.length) {
    data.spy.calls = data.spy.calls.filter(c => c.srcMesId !== srcMesId);
  }
  for (const feed of socialFeeds(data)) {
    if (feed.some(p => p.srcMesId === srcMesId)) {
      const kept = feed.filter(p => p.srcMesId !== srcMesId);
      feed.length = 0;
      feed.push(...kept);
    }
  }
}

/** 该楼层是否已有提取条目（有则即使本轮无事件也要清旧）。微信/窥私两域同口径。 */
export function hasStoryLinkItems(data: PhoneChatData | null | undefined, srcMesId: string): boolean {
  if (!data || !srcMesId) return false;
  for (const conv of [...data.conversations, ...(data.spy?.conversations || [])]) {
    for (const m of conv.messages) {
      if ((m as { srcMesId?: string }).srcMesId === srcMesId) return true;
    }
  }
  for (const c of [...(data.calls || []), ...(data.spy?.calls || [])]) {
    if (c.srcMesId === srcMesId) return true;
  }
  for (const feed of socialFeeds(data)) {
    if (feed.some(p => p.srcMesId === srcMesId)) return true;
  }
  return false;
}

// ─── 注入/移除/状态（世界书条目 + 全局显示正则 + 渲染 CSS） ───

const HELPER_NEEDS = [
  'getCharWorldbookNames', 'getWorldbook', 'createWorldbookEntries', 'updateWorldbookWith',
  'deleteWorldbookEntries', 'getTavernRegexes', 'importRawTavernRegex', 'updateTavernRegexesWith',
] as const;

async function requireStoryHelper(): Promise<any> {
  const th = getTavernHelper();
  if (!th || HELPER_NEEDS.some(key => typeof th[key] !== 'function')) {
    throw new Error('酒馆助手接口不可用（需要较新版本的世界书/正则 API）');
  }
  return th;
}

/** 当前是否群聊会话（群聊角色书语义不明，正文联动不支持）。 */
export function currentChatIsGroup(): boolean {
  try {
    const ctx = (hostWindow() as any).SillyTavern?.getContext?.();
    return Boolean(ctx?.groupId);
  } catch (_e) { return false; }
}

/**
 * 渲染 CSS 存在性探针（呈现层登记；**core 绝不碰 DOM**，只问一个布尔）。
 * renderers/story-link-enhance 模块装载时登记；未登记（测试/未装载）=按未注入报告。
 */
let _cssProbe: (() => boolean) | null = null;

/** 呈现层登记/注销 CSS 存在性探针。 */
export function setStoryLinkCssProbe(fn: (() => boolean) | null): void {
  _cssProbe = fn;
}

export interface StoryLinkStatus {
  /** TavernHelper 世界书/正则 API 可用。 */
  api: boolean;
  /** 当前是群聊会话（不支持）。 */
  group: boolean;
  /** 角色主世界书名（null=未绑定，注入被拒）。 */
  book: string | null;
  entry: 'injected' | 'stale' | 'missing' | 'no-book' | 'unknown';
  /** 渲染正则注入数（共 3）。 */
  regexCount: number;
  regexTotal: number;
  cssInjected: boolean;
}

async function readEntryState(th: any): Promise<Pick<StoryLinkStatus, 'book' | 'entry'>> {
  const bound = th.getCharWorldbookNames('current');
  const book = typeof bound?.primary === 'string' && bound.primary ? bound.primary : null;
  if (!book) return { book: null, entry: 'no-book' };
  const entries = await th.getWorldbook(book);
  if (!Array.isArray(entries)) return { book, entry: 'unknown' };
  const hit = entries.find((e: any) => String(e?.name ?? e?.comment ?? '') === STORY_LINK_ENTRY_NAME);
  if (!hit) return { book, entry: 'missing' };
  // 与「当前聊天风格」的预期内容比对——风格切换后内容不符=stale，走既有原地更新路径重注入
  return { book, entry: String(hit.content ?? '') === storyLinkEntryContent(currentStyle()) ? 'injected' : 'stale' };
}

/** 只读状态（设置页展示；不写任何东西）。 */
export async function checkStoryLinkStatus(): Promise<StoryLinkStatus> {
  const base: StoryLinkStatus = {
    api: false,
    group: currentChatIsGroup(),
    book: null,
    entry: 'unknown',
    regexCount: 0,
    regexTotal: storyLinkRegexScripts().length,
    cssInjected: false,
  };
  try {
    const th = await requireStoryHelper();
    base.api = true;
    try {
      const regexes = th.getTavernRegexes({ type: 'global' });
      base.regexCount = Array.isArray(regexes)
        ? regexes.filter((r: any) => String(r?.script_name ?? r?.scriptName ?? '').startsWith(STORY_LINK_REGEX_PREFIX)).length
        : 0;
    } catch (_e) { /* 保持 0 */ }
    base.cssInjected = Boolean(_cssProbe?.());
    const entryState = await readEntryState(th);
    base.book = entryState.book;
    base.entry = entryState.entry;
  } catch (_e) { /* api=false，字段保持初值 */ }
  return base;
}

/**
 * 幂等注入全部三件（条目先删后建语义：存在但内容过期→原地更新；正则缺哪补哪；CSS 单份）。
 * 失败抛错（调用方展示：无主世界书/群聊/API 不可用）。
 */
export async function ensureStoryLinkInjection(): Promise<StoryLinkStatus> {
  if (currentChatIsGroup()) throw new Error('群聊会话不支持正文联动');
  const th = await requireStoryHelper();
  const entryContent = storyLinkEntryContent(currentStyle());
  const scripts = storyLinkRegexScripts();
  // ① 渲染正则：缺哪补哪（importRawTavernRegex 纯增量 push）；同名的找/换/深度过期→原地更新
  const regexes = th.getTavernRegexes({ type: 'global' });
  const existing = new Map<string, any>();
  for (const r of Array.isArray(regexes) ? regexes : []) {
    const name = String(r?.script_name ?? r?.scriptName ?? '');
    if (name) existing.set(name, r);
  }
  for (const script of scripts) {
    if (!existing.has(script.scriptName)) {
      const ok = th.importRawTavernRegex(script.scriptName, JSON.stringify(script));
      if (!ok) throw new Error(`渲染正则「${script.scriptName}」注入失败`);
    }
  }
  const staleScripts = scripts.filter(script => {
    const cur = existing.get(script.scriptName);
    if (!cur) return false;
    return String(cur.find_regex ?? cur.findRegex ?? '') !== script.findRegex
      || String(cur.replace_string ?? cur.replaceString ?? '') !== script.replaceString
      || (cur.max_depth ?? cur.maxDepth ?? null) !== script.maxDepth;
  });
  if (staleScripts.length) {
    const patchByName = new Map(staleScripts.map(s => [s.scriptName, s] as const));
    await th.updateTavernRegexesWith((list: any[]) => (Array.isArray(list) ? list : []).map((r: any) => {
      const patch = patchByName.get(String(r?.script_name ?? ''));
      // 只动我们自己的三条字段，其他脚本原样放行
      return patch ? { ...r, find_regex: patch.findRegex, replace_string: patch.replaceString, min_depth: patch.minDepth, max_depth: patch.maxDepth } : r;
    }), { type: 'global' });
  }
  // ⑧-a 社媒动态正则按**勾选集合**存在（第五轮 ⑦）：取消勾选的平台必须连脚本一起删掉——
  // 提示词里不再教它，但旧脚本留着仍会把该平台的标签渲染出来，那就等于「勾选」没关住闸门。
  const wantedNames = new Set(scripts.map(s => s.scriptName));
  const dropNames = new Set(SOCIAL_POST_SCRIPT_NAMES.filter(name => !wantedNames.has(name)));
  if (dropNames.size && [...existing.keys()].some(name => dropNames.has(name))) {
    await th.updateTavernRegexesWith((list: any[]) => (Array.isArray(list) ? list : [])
      .filter((r: any) => !dropNames.has(String(r?.script_name ?? r?.scriptName ?? ''))), { type: 'global' });
  }
  // ② 渲染 CSS 由呈现层负责（renderers/story-link-enhance 的 syncStoryCallEnhancer 随开关注入/移除）
  // ③ 格式条目：仅注入角色主世界书（用户定案：无主书直接报错，不降级）
  const bound = th.getCharWorldbookNames('current');
  const book = typeof bound?.primary === 'string' && bound.primary ? bound.primary : null;
  if (!book) throw new Error('当前角色未绑定主世界书，无法注入格式条目（请先在世界书管理里给角色绑书）');
  const entries = await th.getWorldbook(book);
  if (!Array.isArray(entries)) throw new Error(`主世界书「${book}」读取失败`);
  const hit = entries.find((e: any) => String(e?.name ?? e?.comment ?? '') === STORY_LINK_ENTRY_NAME);
  if (!hit) {
    await th.createWorldbookEntries(book, [{
      name: STORY_LINK_ENTRY_NAME,
      enabled: true,
      strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
      position: { type: 'at_depth', role: 'system', depth: 0, order: 104 },
      recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
      content: entryContent,
    }], { render: 'immediate' });
  } else if (String(hit.content ?? '') !== entryContent) {
    await th.updateWorldbookWith(book, (list: any[]) => list.map((e: any) => (
      String(e?.name ?? e?.comment ?? '') === STORY_LINK_ENTRY_NAME ? { ...e, content: entryContent } : e
    )));
  }
  return checkStoryLinkStatus();
}

/** 关闭功能：移除条目/正则/CSS（best-effort，逐项容错）。 */
export async function removeStoryLinkInjection(): Promise<void> {
  const th = await requireStoryHelper().catch(() => null);
  if (th) {
    try {
      const bound = th.getCharWorldbookNames('current');
      const book = typeof bound?.primary === 'string' && bound.primary ? bound.primary : null;
      if (book) await th.deleteWorldbookEntries(book, (e: any) => String(e?.name ?? e?.comment ?? '') === STORY_LINK_ENTRY_NAME);
    } catch (_e) { /* ignore */ }
    try {
      await th.updateTavernRegexesWith(
        (list: any[]) => (Array.isArray(list) ? list : []).filter((r: any) => !String(r?.script_name ?? r?.scriptName ?? '').startsWith(STORY_LINK_REGEX_PREFIX)),
        { type: 'global' },
      );
    } catch (_e) { /* ignore */ }
  }
  // CSS 的移除同理由呈现层负责（syncStoryCallEnhancer(false) → removeStoryLinkCss）
}

// ─── 提取触发（MESSAGE_RECEIVED + 500ms 防抖，对齐世界演化时点） ───

const QUIET_MESSAGE_TYPES = new Set(['quiet', 'impersonate', 'command', 'extension', 'first_message']);

/** 读最新一层 AI 回复（原文含 <微信>/<通话> 标记——markdownOnly 正则不改存储原文）。 */
function readLatestFloorText(): { mesId: string; text: string } | null {
  const th = getTavernHelper();
  if (th && typeof th.getLastMessageId === 'function' && typeof th.getChatMessages === 'function') {
    try {
      const lastId = th.getLastMessageId();
      if (typeof lastId === 'number' && lastId >= 0) {
        const messages = th.getChatMessages(`${lastId}-${lastId}`, { role: 'assistant', hide_state: 'all', include_swipes: false }) as any[];
        const m = Array.isArray(messages) ? messages[0] : null;
        if (m && typeof m.message === 'string' && m.message.trim()) return { mesId: String(lastId), text: m.message };
      }
    } catch (_e) { /* fallthrough */ }
  }
  try {
    const chat = (hostWindow() as any).SillyTavern?.chat;
    if (Array.isArray(chat)) {
      for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && typeof m.mes === 'string' && m.mes.trim()) return { mesId: String(i), text: m.mes };
      }
    }
  } catch (_e) { /* ignore */ }
  return null;
}

export interface StoryLinkListenerDeps {
  /** 提取落库后的 UI 接线（index.ts：微信红点/角标刷新）。 */
  onApplied?: (outcomes: StoryPhoneApplyOutcome[]) => void;
}

/** 单轮提取：读最新楼 → 解析 → 整层替换落库（功能关/存储未就绪/群聊=静默跳过）。 */
export async function runStoryLinkExtraction(deps: StoryLinkListenerDeps = {}): Promise<StoryPhoneApplyOutcome[]> {
  if (!getPhoneSettings().storyLink) return [];
  const status = phoneStoreStatus();
  if (status.state !== 'ready' && status.state !== 'uninitialized') return [];
  if (currentChatIsGroup()) return [];
  const floor = readLatestFloorText();
  if (!floor) return [];
  // 窥私提取门槛=窥私总开关（关闭时不产生新数据）；旧提取条目的清理不受门槛影响（swipe 整层替换语义）
  const spyOn = getPhoneSettings().spyEnabled;
  const allEvents = extractStoryPhoneEvents(floor.text);
  const events = spyOn ? allEvents : allEvents.filter(e => !e.spy);
  const had = hasStoryLinkItems(readPhoneDataRef(), floor.mesId);
  if (!events.length && !had) return [];
  const roster = getRoster();
  const me = roster.protagonistName;
  const knownNames = new Set(
    mergedContactNames(roster, readPhoneDataRef()?.customContacts || []).filter(n => n && n !== me),
  );
  let outcomes: StoryPhoneApplyOutcome[] = [];
  mutatePhoneData(d => {
    removeStoryLinkItems(d, floor.mesId);
    if (events.length) {
      outcomes = applyStoryPhoneEvents(d, events, {
        storyTime: roster.global.time || undefined,
        avatarFor: resolveAvatarPath,
        srcMesId: floor.mesId,
        protagonistName: me,
        knownNames,
      });
    }
  });
  try {
    deps.onApplied?.(outcomes);
  } catch (_e) { /* UI 故障不阻断落库结果 */ }
  return outcomes;
}


/** 注册提取监听（幂等；功能关闭时回调首行即返，零成本常驻）。 */
export function bindStoryLinkListener(deps: StoryLinkListenerDeps = {}): void {
  const w = hostWindow() as unknown as Record<string, unknown> & {
    SillyTavern?: any;
    __ubp_story_link_bound?: boolean;
  };
  if (w.__ubp_story_link_bound) return;
  w.__ubp_story_link_bound = true;
  try {
    const ctx = w.SillyTavern?.getContext?.();
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (!source || typeof source.on !== 'function' || !types?.MESSAGE_RECEIVED) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.on(types.MESSAGE_RECEIVED, (_id: unknown, type: unknown) => {
      if (typeof type === 'string' && QUIET_MESSAGE_TYPES.has(type)) return;
      if (!getPhoneSettings().storyLink) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void runStoryLinkExtraction(deps).catch(() => { /* 静默：下轮重试 */ });
      }, 500);
    });
  } catch (_e) { /* 宿主事件不可用：仅失去自动提取 */ }
}

/** 切聊天后校验补注入（scheduleChatRebind 接线；幂等、失败静默——设置页状态可见）。 */
export async function verifyStoryLinkOnChatChange(): Promise<void> {
  if (!getPhoneSettings().storyLink) return;
  try {
    await ensureStoryLinkInjection();
  } catch (_e) { /* 静默：状态徽标展示原因 */ }
}
