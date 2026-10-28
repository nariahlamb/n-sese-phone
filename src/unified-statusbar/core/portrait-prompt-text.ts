// ===== 立绘提示词纯函数层（自 portrait-prompts.ts 拆出） =====
// 职责：system prompt 模板 / <PORTRAIT_JSON> 解析 / 标签拍平与去重 / 前后缀拼装——全部纯函数，
// 零 data-manager / map-system 依赖（勿在此引入读表/读上下文，那会连带写回队列链进依赖方）。
// 拆出目的：伴生插件 UBS_phone（小手机）复用同一套提示词管线；本文件保持可被主项目直接 import。
// portrait-prompts.ts 对本文件全部 re-export，既有引用方（portrait-system/wardrobe/item-overview/测试）无感。

import { extractFencedJson } from './text-fence';
import { parseJsonWith } from './safe-json';
import type { FanTagTransferMode, NaturalPromptLanguage, PortraitComposeMode } from './portrait-config';
import type { StoryMultiChar } from './story-image-parser';

// —— 构图预设对应的额外 tags 片段（NAI v4+ 语法：小写 + 空格分隔）——
export const PORTRAIT_PRESET_TAGS: Record<'avatar' | 'halfbody' | 'fullbody' | 'default', string> = {
  avatar: 'solo, face focus, close-up, head',
  // 半身/全身等取景改由镜头词控制（cowboy shot 等，对齐 vocus 镜头位文章）；solo 与脸部保真标签保留
  halfbody: 'solo, cowboy shot',
  // 全身图脸部占像素少，补脸部保真标签让模型即使脸小也画好（不过度堆叠，避免喧宾夺主）
  fullbody: 'solo, full body, detailed face, detailed eyes',
  default: 'solo',
};

// —— tags 模式基础 system prompt ——
// 按 includeFanwork 分支：非同人逐字保留原提示词（= PORTRAIT_SYSTEM_PROMPT_TAGS）；同人禁外观，
// traits 只留视线神态、JSON 示例去掉外貌标签、DNA块改"身份一致性"、要点去掉外貌/身体映射，并换画师名行。
export function buildPortraitSystemPromptTags(includeFanwork: boolean): string {
  const artistLine = includeFanwork
    ? `- 同人生成选项：人物身份由系统注入的角色/作品标签锁定，你不需要输出身份标签；仍然禁止画师名（artist）。`
    : `- 不要包含画师名（artist）、版权作品专属标签（copyright）、原创角色名。`;
  const tagNormLine = includeFanwork
    ? `- 人物身份由系统注入的角色/作品标签锁定，不要输出人物身份标签；不输出发型/发色/瞳色等外貌标签。`
    : `- 人物基础特征（发型、发色、瞳色）必须出现且权重不低于 {{}}。`;
  const priorityLine = includeFanwork
    ? `- 增强优先级：动作 > 服饰 > 表情 > 特效（人物外貌由角色标签自带，不输出外貌标签）。`
    : `- 增强优先级：外貌 > 动作 > 服饰 > 表情 > 特效。`;
  const dnaBlock = includeFanwork
    ? `【角色身份一致性（核心铁律）】
同人角色的身份标签（角色/作品）由系统固定注入并锁定，每张图100%复用；人物外貌由模型基于该身份标签自动保持一致，不要输出外貌/身材标签去覆盖。
当前穿搭、动作神态按剧情变化即可。`
    : `【角色DNA一致性（核心铁律）】
角色核心视觉特征（发型/发色/瞳色/身材/肤色/种族/默认服饰）锁定后每张图100%复制粘贴。
仅在文本明确描述/场景变化/交互影响时可追加或修改。外貌和服装须跨图片保持一致。`;
  const traitsBlock = includeFanwork
    ? `characters[].traits 只描述视线与神态：按剧情选择合适的视线标签，并结合 {{smile}}, closed mouth, blush, serious 等神态。
不要输出面部细节、发型发色、眼睛特征、体型肤色、种族等人物固有外观标签——人物外貌完全由系统注入的角色/作品标签识别，由模型自带。`
    : `characters[].traits 应按以下顺序详细描述（每一项是独立标签串，多项分别入数组）：
- 视线与神态：按剧情选择合适的视线标签，并结合 {{smile}}, closed mouth, blush, serious 等神态
- 面部细节：detailed face, beautiful eyes, {{detailed eyes}}
- 发型发色：{{long black hair}}, blunt bangs, twintails, hair ornament 等
- 眼睛特征：{{blue eyes}}, half-closed eyes, heterochromia 等
- 体型肤色：slim, fair skin, large breasts, petite 等（按角色实际描述，不要凭空添加）
- 种族/幻想特征：elf ears, demon horns, wings, tail 等（如有）`;
  const exampleTraits = includeFanwork
    ? `["{{looking away}}, {{smile}}"]`
    : `["{{looking away}}, {{smile}}","detailed face, {{detailed eyes}}","{{long black hair}}, blunt bangs","{{blue eyes}}","fair skin, slim"]`;
  const fallbackLine = includeFanwork
    ? `- 若角色信息不足，traits 至少包含视线与神态标签（不输出面部/眼睛等外貌标签），并按画面实际决定视线，避免空白。`
    : `- 若角色信息不足，traits 至少包含：detailed face, {{beautiful eyes}}，并按画面实际决定视线，避免空白。`;
  const mappingLine = includeFanwork
    ? `- "当前状态""情绪"映射到 action；"上装/下装/内衣/袜子/鞋子/饰品"映射到 outfit（同人模式不输出外貌/身材标签，人物外貌由角色标签自带）。`
    : `- "当前状态""情绪"映射到 action；"外貌特征""年龄""身体数据"映射到 traits（身高/体重→tall/short/petite/medium build 等体型标签；三围/罩杯→large breasts/medium breasts/flat chest 等对应标签，均按角色实际数值选择标准 danbooru 标签，不要凭空夸大）；"上装/下装/内衣/袜子/鞋子/饰品"映射到 outfit。`;
  return `你是一位精通 NovelAI Diffusion V4.5 与 danbooru 标签体系的图像提示词工程师。根据给定的角色信息与剧情上下文，输出用于生成角色立绘的英文标签结构。

【标签规范】
- 全部使用小写英文，词间用空格分隔（NAI v4+ 语法，不要用下划线_）。
- 仅输出 danbooru 体系内存在的标准标签，不要自造词、不要中英混合、不要描述性长句。
${artistLine}
- 加权语法：{{tag}} 或 {{{tag}}} 强化核心特征（每层×1.05倍），[tag] 弱化次要元素（每层×0.9倍）。
${tagNormLine}
${priorityLine}
- 数量词前置：根据【性别】选择 1girl、1boy 或合适的中性人物标签；不要默认角色为女性。

${dnaBlock}

【角色立绘标准结构】
composition 应包含：与【性别】一致的单人数量标签 + solo + 构图视角（严格遵循【构图要求】）+ 根据画面实际决定的视线方向。

视线方向必须根据剧情瞬间、人物动作、情绪和镜头关系决定。
可按画面实际选择 looking at viewer, looking away, looking back, looking down, looking up, sideways glance, eyes closed 等标签。
不得为了标准立绘效果而默认输出 looking at viewer；视线标签必须与头部朝向、动作和构图一致。

${traitsBlock}

characters[].outfit 按层描述**画面可见**的衣物，每件独立标签：内衣 → 上装 → 下装 → 袜子 → 鞋子 → 配饰，如：white bra, black shirt, long sleeves, pleated skirt, white thighhighs, mary janes, ribbon hairband。穿着外套/开衫/连衣裙/连体衣/大衣等外层衣物完全遮挡内衣时，**不要输出 bra/panties/underwear 等内衣标签**（内衣层仅在透视/半透/裸露/内衣刻意外露时才写）。

characters[].action 描述姿态/表情：sitting, standing, arms behind back, hand on hip, shy expression, crossed legs 等。

background 优先结合剧情上下文推断场景（如 bedroom, classroom, garden, night sky, sunset）。若上下文无明确场景，用 simple background, white background。

【边界明确性】
仅添加画面区域可见 Tag——仅下半身构图排除 shirt/expression；背对构图排除 eyes/expression，加 from behind；眼罩蒙眼排除 eyes，加 face covered, blindfold；穿着外套/连衣裙/大衣/连体衣等外层遮挡内衣时不输出 bra/panties/underwear 等内衣标签（避免生图出现衣物穿透或层叠错乱），仅在透视/半透/裸露/内衣外露时才保留内衣标签。

【其他要求】
生图时不表现红痕、伤痕、淤青、吻痕、勒痕、烫伤、疤痕等皮肤问题。
生成人物标签时严格区分人类耳朵与兽耳；若角色仅耳朵泛红，仅输出 flushed ears / red blush on human ears，绝不输出 pink ears/red ears等产生误解的标签。

【NSFW 处理】
仅当角色"当前状态"或剧情上下文明确涉及亲密/裸露情境时，才输出 nsfw 标签（如 nude, breasts, nipples, pussy, sex）。否则 nsfw 数组留空 []。NSFW 标签同样遵循 danbooru 标准命名（小写、空格分隔）。

【输出格式】
严格按以下 JSON 结构输出，禁止输出任何额外文字、解释、markdown 代码块：
<PORTRAIT_JSON>
{"composition":"solo, upper body, looking away","characters":[{"name":"角色名","traits":${exampleTraits},"outfit":["white shirt, long sleeves","black pleated skirt","white thighhighs","mary janes","ribbon hairband"],"action":["arms behind back"],"body_parts_visible":[],"interaction":[],"nsfw":[]}],"entities":[],"background":["simple background, white background"]}
</PORTRAIT_JSON>

【要点】
- composition 已含人物数量标签/solo 时，traits 不要重复这些标签。
- 同一特征只输出一次，去重。
- 标签尽量具体（如 "black pleated skirt" 而非 "skirt"；"long black hair" 而非 "black hair"）。
${fallbackLine}
${mappingLine}
- 只输出 <PORTRAIT_JSON>...</PORTRAIT_JSON> 这一段，禁止输出其他文字。`;
}

// 非同人 base（逐字保留原提示词）；测试与历史兼容仍导出此常量。
export const PORTRAIT_SYSTEM_PROMPT_TAGS = buildPortraitSystemPromptTags(false);

// —— natural 模式基础 system prompt ——
// 非同人逐字保留原提示词（= PORTRAIT_SYSTEM_PROMPT_NATURAL）；同人禁外貌描述：人物特征示例改"视线神态"、来源行改"不描述外貌/身材"。
// language='zh' 时整套提示词换成中文版本（JSON 键仍为英文，仅值改为中文描述），供中文生图模型使用。
export function buildPortraitSystemPromptNatural(includeFanwork: boolean, language: NaturalPromptLanguage = 'en'): string {
  if (language === 'zh') {
    const charFeaturesHint = includeFanwork
      ? `"视线与神态（不描述外貌；身份由角色标签识别）"`
      : `"中文外貌描述"`;
    const sourceLine = includeFanwork
      ? `- 同人模式：不要描述外貌与身材；人物身份由系统注入的角色/作品标签识别，人物外貌由模型自带。从“当前穿搭/上装/下装”提炼 outfit。`
      : `- 优先从角色的“外貌特征”“年龄”“身体数据（身高/体重/三围/罩杯）”“当前穿搭/上装/下装”提炼人物特征与服装；身体数据用于描述体型与身材比例。`;
    return `你是一个辅助生成 AI 绘画提示词的助手。根据给定的角色信息与剧情上下文，输出用于生成角色立绘的中文自然语言描述。

严格按以下格式输出，不要输出任何额外解释：
<PORTRAIT_JSON>
{"composition":"人数、构图、取景、焦点与视角的中文描述","characters":[{"name":"角色名","traits":${charFeaturesHint},"outfit":"中文服装描述","action":"动作、姿态、神情与交互的中文描述","body_parts_visible":"可为空字符串","interaction":"可为空字符串","nsfw":"可为空字符串"}],"entities":"物品的中文描述，可为空字符串","background":"背景、场景与光照的中文描述"}
</PORTRAIT_JSON>

要求：
- 内容全部用中文自然语言（不是逗号分隔的标签）。
- 根据剧情瞬间、人物动作、情绪和镜头关系自行决定人物的视线方向，不要默认正视观看者；视线须与头部朝向、姿态和构图一致。
${sourceLine}
- 服装只描述画面可见的衣物；穿着外套/连衣裙/连体衣等外层遮挡内衣时不要描述内衣，避免画面出现衣物穿透。
- “当前状态”“情绪”映射到 action。
- 生图时不表现红痕、伤痕、淤青、吻痕、勒痕、烫伤、疤痕等皮肤问题。
- 背景结合剧情上下文推断，若上下文无明确场景则用简洁背景。
- 只输出 <PORTRAIT_JSON>...</PORTRAIT_JSON> 这一段，禁止输出其他文字。`;
  }
  const charFeaturesHint = includeFanwork
    ? `"gaze and expression (do not describe appearance; identity is recognized by the character tag)"`
    : `"English appearance description"`;
  const sourceLine = includeFanwork
    ? `- Fanwork mode: do not describe appearance or body shape; identity is provided by the system-injected character/work tags and appearance comes from the model itself. Distill "outfit" from "current outfit/top/bottom".`
    : `- Derive character traits and outfit primarily from the character's "appearance", "age", "body data (height/weight/bust/waist/hip)" and "current outfit/top/bottom"; use body data for build and proportions.`;
  return `You are an assistant that helps generate AI image prompts. Based on the given character information and story context, output an English natural-language description for generating a character illustration.

Output strictly in the following format with no extra explanation:
<PORTRAIT_JSON>
{"composition":"English description of number of people, composition, framing, focus and viewpoint","characters":[{"name":"Character name","traits":${charFeaturesHint},"outfit":"English outfit description","action":"English description of pose, movement, expression and interaction","body_parts_visible":"may be an empty string","interaction":"may be an empty string","nsfw":"may be an empty string"}],"entities":"English description of objects, may be an empty string","background":"English description of background, scene and lighting"}
</PORTRAIT_JSON>

Requirements:
- Write all content in natural English prose (not comma-separated tags).
- Decide the character's gaze direction yourself based on the story moment, action, emotion and framing; do not default to looking at the viewer. Gaze must match head orientation, pose and composition.
${sourceLine}
- Describe only clothing visible in the frame; when an outer layer (coat/dress/onesie) fully covers underwear, do not describe the underwear to avoid clothing clipping.
- Map "current state" and "emotion" to action.
- Do not depict skin problems such as red marks, scars, bruises, hickeys, friction marks, burns or scars.
- Infer the background from the story context; if there is no clear scene, use a simple background.
- Output only the <PORTRAIT_JSON>...</PORTRAIT_JSON> block, with nothing else.`;
}

// 非同人 base（逐字保留原提示词）；测试与历史兼容仍导出此常量。
export const PORTRAIT_SYSTEM_PROMPT_NATURAL = buildPortraitSystemPromptNatural(false);

// —— prompt 对象类型（AI 输出解析后）——
export interface PortraitPromptObject {
  composition?: string;
  characters?: Array<{
    name?: string;
    traits?: string[];
    outfit?: string[];
    action?: string[];
    body_parts_visible?: string[];
    interaction?: string[];
    nsfw?: string[];
    /** NAI 五格坐标网格 "A1"–"E5"（多角色照片位置指定；可省略/非法时系统自动排布）。 */
    centers?: string;
  }>;
  entities?: string[] | string;
  background?: string[] | string;
}

// —— 解析 AI 输出 ——
export function parsePromptOutput(result: string): PortraitPromptObject | null {
  if (!result) return null;
  const tag = result.match(/<PORTRAIT_JSON>([\s\S]*?)<\/PORTRAIT_JSON>/i);
  const raw = tag ? tag[1] : result;
  // U33：收编 parseJsonWith（对象校验保留在调用方）
  const obj = parseJsonWith<unknown>(extractFencedJson(raw), null);
  return obj && typeof obj === 'object' ? obj as PortraitPromptObject : null;
}

// —— 拍平成最终 promptText ——

// 仅去首尾逗号/分号（含全角）与空白；保留冒号(NAI 1.5::tag::)、花括号({{tag}})等加权语法
function cleanTag(s: string): string {
  return s.trim().replace(/^[，,；;]+|[，,；;]+$/g, '').trim();
}

function filterTags(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s): s is string => typeof s === 'string')
    .map(cleanTag)
    .filter((s) => s !== '' && s !== '...' && s !== '…');
}

// 参考st-chatu8 stripChineseAnnotations：只删中文全角括号注释 （…），保留半角加权语法
function stripChineseAnnotations(s: string): string {
  if (!s) return '';
  let prev = '';
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(/（[^（）]*）/g, '');
  } while (cur !== prev);
  return cur;
}

// 参考st-chatu8 getBaseTag：临时剥除加权语法算去重 key（仅用于 dedup，不改动原 tag）
// 支持 NAI 数字加权 1.5::tag:: / 花括号 {{tag}} / WebUI :1.5 / 外层括号
function getBaseTag(tag: string): string {
  let s = tag.trim();
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(/^[([{<]+/, '');              // 去前导 ( [ { <
    s = s.replace(/[)\]} >]+$/, '');             // 去尾随 ) ] } > 空白
    s = s.replace(/^[\d.]+::/, '');              // 去前导 1.5::（NAI 数字加权）
    s = s.replace(/::$/, '');                    // 去尾随 ::
    s = s.replace(/:(?:\d*\.\d+|\d+)$/, '');     // 去尾随 :1.5（WebUI 冒号权重）
    s = s.trim();
  }
  return s;
}
function hasWeight(tag: string): boolean {
  return tag.trim() !== getBaseTag(tag);
}

// 去重：以剥权后的 base 大小写不敏感为 key（参考 st-chatu8 deduplicateTags）
// 同 base tag 出现两次时，优先保留带权重版本（1.5::x:: / {{x}} / x:1.5）
function dedupTags(tags: string[]): string[] {
  const map = new Map<string, string>();
  for (const tag of tags) {
    if (!tag) continue;
    const base = getBaseTag(tag).toLowerCase();
    if (!map.has(base)) {
      map.set(base, tag);
    } else {
      const old = map.get(base)!;
      if (!hasWeight(old) && hasWeight(tag)) map.set(base, tag);
    }
  }
  return Array.from(map.values());
}

// —— 同人身份 tag（固化；AI 输出中不再有身份段）——
/** 同人身份 tag：由立绘索引 fanTags 固化（AI 识别一次或用户手填），生图时直接拼进最终提示词。 */
export interface FanIdentityTags {
  /** 原作人物标准 tag（如 rem_(re:zero)） */
  character: string;
  /** 原作/copyright tag */
  copyright: string;
}

/** 两项都非空才算就绪（缺项时调用方已拦下，这里只是拼装层防御）。 */
function fanTagsReady(tags?: FanIdentityTags | null): boolean {
  return !!tags && !!cleanTag(tags.character || '') && !!cleanTag(tags.copyright || '');
}

// 同人身份标签的加权写法：默认 NAI 专用 1.2::tag::；fanTagStyle='anima' 时换 SD 系通用 (tag:2)
// （Anima 等非 NAI 后端读不懂 NAI 加权语法，字面量反而污染提示词）。缺省参数 = 历史字节形态不变。
function wrapFanTag(tag: string, fanTagStyle?: FanTagTransferMode): string {
  const t = cleanTag(tag);
  return fanTagStyle === 'anima' ? `(${t}:2)` : `1.2::${t}::`;
}

export function buildPromptText(obj: PortraitPromptObject, fanTags?: FanIdentityTags | null, fanTagStyle?: FanTagTransferMode): string {
  // tags 模式：英文逗号标签串
  const tags: string[] = [];
  if (obj.composition) tags.push(obj.composition);
  if (fanTagsReady(fanTags)) {
    tags.push(wrapFanTag(fanTags!.copyright, fanTagStyle));
    tags.push(wrapFanTag(fanTags!.character, fanTagStyle));
  }
  for (const c of obj.characters ?? []) {
    tags.push(...filterTags(c.traits));
    tags.push(...filterTags(c.outfit));
    tags.push(...filterTags(c.action));
    tags.push(...filterTags(c.body_parts_visible));
    tags.push(...filterTags(c.interaction));
    tags.push(...filterTags(c.nsfw));
  }
  if (Array.isArray(obj.entities)) tags.push(...filterTags(obj.entities));
  else if (typeof obj.entities === 'string' && obj.entities.trim()) tags.push(obj.entities.trim());
  if (Array.isArray(obj.background)) tags.push(...filterTags(obj.background));
  else if (typeof obj.background === 'string' && obj.background.trim()) tags.push(obj.background.trim());
  return dedupTags(tags).join(', ');
}

// natural 模式值可能是字符串或字符串数组（AI 输出两种都可能），统一成文本
function asText(value: unknown): string {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string').join(', ');
  return typeof value === 'string' ? value.trim() : '';
}

export function buildNaturalPromptText(obj: PortraitPromptObject, fanTags?: FanIdentityTags | null, language: NaturalPromptLanguage = 'en'): string {
  // natural 模式：段落（语言跟随 naturalPromptLanguage，段标签同步本地化）
  const zh = language === 'zh';
  const lines: string[] = [];
  if (obj.composition) lines.push(`${zh ? '构图' : 'Composition'}: ${obj.composition}`);
  if (fanTagsReady(fanTags)) {
    const character = cleanTag(fanTags!.character);
    const copyright = cleanTag(fanTags!.copyright);
    lines.push(zh
      ? `角色身份：${character}（出自作品：${copyright}）`
      : `Character identity: ${character} (from ${copyright})`);
  }
  for (const c of obj.characters ?? []) {
    lines.push(`${zh ? '角色' : 'Character'}${c.name ? ` (${c.name})` : ''}`);
    const pairs: Array<[string, string]> = [];
    const pushPair = (label: string, value: unknown) => {
      const text = asText(value);
      if (text) pairs.push([label, text]);
    };
    if (zh) {
      pushPair('外观', c.traits);
      pushPair('穿搭', c.outfit);
      pushPair('动作/姿态/神情', c.action);
      pushPair('强调部位', c.body_parts_visible);
      pushPair('互动', c.interaction);
      pushPair('NSFW', c.nsfw);
    } else {
      pushPair('Appearance', c.traits);
      pushPair('Outfit', c.outfit);
      pushPair('Action/Pose/Expression', c.action);
      pushPair('Emphasized body parts', c.body_parts_visible);
      pushPair('Interaction', c.interaction);
      pushPair('NSFW', c.nsfw);
    }
    for (const [label, text] of pairs) lines.push(`  ${label}: ${text}`);
  }
  const entities = asText(obj.entities);
  if (entities) lines.push(`${zh ? '物件' : 'Objects'}: ${entities}`);
  const background = asText(obj.background);
  if (background) lines.push(`${zh ? '背景' : 'Background'}: ${background}`);
  return lines.join('\n').trim();
}

export function buildPromptTextByMode(
  obj: PortraitPromptObject,
  mode: PortraitComposeMode,
  fanTags?: FanIdentityTags | null,
  language: NaturalPromptLanguage = 'en',
  fanTagStyle?: FanTagTransferMode,
): string {
  return mode === 'natural'
    ? buildNaturalPromptText(obj, fanTags, language)
    : buildPromptText(obj, fanTags, fanTagStyle);
}

// —— PORTRAIT_JSON → NAI V4/V4.5 多角色结构（多角色图走 char_captions 用） ——
// 扁平 buildPromptText 把所有角色标签混进同一条 base_caption，NAI 没有归属概念，
// 多角色时外貌属性会随机串角色（short hair vs long hair 等）。此转换把每角色标签
// 放进独立 char_captions 槽（经 image-gen buildNovelAiStoryBody 发送，use_coords:true）：
//   scene = composition + 各角色 interaction（关系性标签归场景，跨角色去重）+ entities + background
//   每角色 prompt = traits + outfit + action + body_parts_visible + nsfw（组内拍平去重）
// 位置：AI 输出的 centers 网格（"A1"–"E5"，见小手机 tags 增补段）优先；缺省/非法/与他角色
// 撞位时按人数默认布局顺位补位（2 人左右并排、3 人品字、4 人四角，对齐 st-chatu8 网格坐标），
// 保证任何输出下 char_captions 坐标两两不重叠。角色 <2 或全空返回 null（调用方回退扁平）。

/** 按出镜人数的默认画面布局（坐标为 NAI 归一化 x/y，与 centersToCoordinates 同一 0.1~0.9 步进）。 */
const STORY_CENTER_LAYOUTS: Record<number, Array<{ x: number; y: number }>> = {
  1: [{ x: 0.5, y: 0.5 }],
  2: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }],
  3: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.5, y: 0.7 }],
  4: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.3, y: 0.7 }, { x: 0.7, y: 0.7 }],
};

const NAI_GRID_RE = /^[A-Ea-e][1-5]$/;
// AI 网格 → 归一化坐标（与 story-image-parser centersToCoordinates 同源；本文件禁运行时依赖故内联）
const NAI_GRID_X: Record<string, number> = { a: 0.1, b: 0.3, c: 0.5, d: 0.7, e: 0.9 };
const NAI_GRID_Y: Record<string, number> = { '1': 0.1, '2': 0.3, '3': 0.5, '4': 0.7, '5': 0.9 };
function naiGridCenter(grid: string): { x: number; y: number } {
  const m = grid.match(/^([A-Ea-e])([1-5])$/)!;
  return { x: NAI_GRID_X[m[1].toLowerCase()], y: NAI_GRID_Y[m[2]] };
}

export function buildPromptStoryMulti(obj: PortraitPromptObject, fanTags?: FanIdentityTags | null, fanTagStyle?: FanTagTransferMode): StoryMultiChar | null {
  const sceneParts: string[] = [];
  if (obj.composition) sceneParts.push(obj.composition);
  if (fanTagsReady(fanTags)) {
    sceneParts.push(wrapFanTag(fanTags!.copyright, fanTagStyle));
    sceneParts.push(wrapFanTag(fanTags!.character, fanTagStyle));
  }
  const chars = (obj.characters ?? []).slice(0, 4);
  for (const c of chars) sceneParts.push(...filterTags(c.interaction));
  if (Array.isArray(obj.entities)) sceneParts.push(...filterTags(obj.entities));
  else if (typeof obj.entities === 'string' && obj.entities.trim()) sceneParts.push(obj.entities.trim());
  if (Array.isArray(obj.background)) sceneParts.push(...filterTags(obj.background));
  else if (typeof obj.background === 'string' && obj.background.trim()) sceneParts.push(obj.background.trim());
  const scene = dedupTags(sceneParts).join(', ');

  const slots = STORY_CENTER_LAYOUTS[Math.min(chars.length, 4)] || STORY_CENTER_LAYOUTS[1];
  const used = new Set<string>();
  const takeCenter = (center: { x: number; y: number }): { x: number; y: number } => {
    used.add(`${center.x},${center.y}`);
    return center;
  };
  const characters: StoryMultiChar['characters'] = [];
  chars.forEach((c) => {
    const prompt = dedupTags([
      ...filterTags(c.traits),
      ...filterTags(c.outfit),
      ...filterTags(c.action),
      ...filterTags(c.body_parts_visible),
      ...filterTags(c.nsfw),
    ]).join(', ');
    if (!prompt) return;
    // AI 网格优先（合法且未被占）；否则顺位取第一个未被占的默认槽
    const grid = typeof c.centers === 'string' ? c.centers.trim() : '';
    let center: { x: number; y: number } | null = null;
    if (NAI_GRID_RE.test(grid)) {
      const g = naiGridCenter(grid);
      if (!used.has(`${g.x},${g.y}`)) center = takeCenter(g);
    }
    if (!center) {
      const slot = slots.find((s) => !used.has(`${s.x},${s.y}`));
      center = takeCenter(slot || { x: 0.5, y: 0.5 });
    }
    characters.push({ prompt, uc: '', centers: center });
  });
  if (characters.length < 2) return null;
  return { scene, characters };
}

// —— 拼接全局前缀/后缀 ——
export function assembleFinalPrompt(prefix: string, promptText: string, suffix: string, mode: PortraitComposeMode): string {
  if (mode === 'natural') {
    return [prefix, promptText, suffix].filter((s) => s && s.trim()).join('\n');
  }
  // tags 模式：对齐 st-chatu8 zhengmian()——各段仅清中文全角括号注释，整段保留(含 NAI 加权 1.5::tag::)
  // 不切分、不跨段去重，用 ', ' 拼接（prefix/suffix 的去重交由 NAI 自身处理，与参考一致）
  return [stripChineseAnnotations(prefix), stripChineseAnnotations(promptText), stripChineseAnnotations(suffix)]
    .filter((s) => s && s.trim())
    .join(', ');
}
