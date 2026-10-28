// ===== 生图 AI 请求提示词模板（场景 × 槽位）=====
// 「第一步文字 AI 怎么写生图提示词」的可自定义文本层：与出图预设彻底解耦，
// 智慧姬直连下照常生效（它属于 AI 请求层，不属于出图参数）。
//
// 结构（每场景 1~2 段）：
//   · 结构要求（关系到解析/标签提取，如 <UBS_image>/image### 契约）+ 任务要求与示例；
//   · 正文插图/手机多人这两处契约本就是独立常量 → 保留两块；其余场景写法与输出格式同段 → 一块。
// 存储：flat 键表 `image:<场景>:<槽位>` → 文本；空/与内置一致 = 删键（禁物化内置全文）。
// 解析：`resolveImagePromptTemplate(templates, scene, slot, defaultText)` —— 覆盖优先，缺省回落调用方传入的内置默认。
// 本模块**零 feature 依赖**（只依赖类型），默认文本由各注入点以 defaultText 实参传入，
// 保证「未设置 = 逐字节不变」且不引入新依赖边。
import type { NaturalPromptLanguage, PortraitComposeMode } from './portrait-config';

export const IMAGE_PROMPT_SCENE_KEYS = [
  'portrait', 'storyImage', 'wardrobeItem', 'wardrobeOutfit', 'mapScene', 'itemOverview',
] as const;
export type ImagePromptSceneKey = typeof IMAGE_PROMPT_SCENE_KEYS[number];

export type ImagePromptSlotKey = 'tags' | 'natural' | 'structure' | 'requirement' | 'system';

export interface ImagePromptTemplateSlotDef {
  /** 覆盖键 `image:<场景>:<槽位>`。 */
  key: string;
  scene: ImagePromptSceneKey;
  slot: ImagePromptSlotKey;
  /** 编辑器里的槽位名。 */
  label: string;
  /** 作用说明（编辑器展示）。 */
  desc: string;
  /** 结构类槽位：解析器依赖，保存时做关键 token 校验、编辑器默认需解锁才可改。 */
  structural?: boolean;
  /** 进阶槽位（编辑器默认折叠）。 */
  advanced?: boolean;
}

export const IMAGE_PROMPT_SCENE_LABELS: Record<ImagePromptSceneKey, string> = {
  portrait: '角色立绘',
  storyImage: '正文插图',
  wardrobeItem: '衣柜单品',
  wardrobeOutfit: '衣柜套装',
  mapScene: '地图场景',
  itemOverview: '物品总览',
};

/** 编辑器目录（顺序即场景 chips 顺序；槽位顺序即卡片顺序）。 */
export const IMAGE_PROMPT_SLOTS: readonly ImagePromptTemplateSlotDef[] = [
  {
    key: 'image:portrait:tags', scene: 'portrait', slot: 'tags', label: '标签模式基底',
    desc: '发给文字 AI 的立绘提示词模板（标签模式）：标签规范、角色 DNA 铁律、构图、NSFW 处理与 <PORTRAIT_JSON> 输出格式都在这一段里。未自定义时按「同人开关」自动切换内置文本；自定义后本场景固定用你的文本（同人禁外貌由追加段兜底）。',
  },
  {
    key: 'image:portrait:natural', scene: 'portrait', slot: 'natural', label: '自然语言基底', advanced: true,
    desc: '自然语言模式的立绘提示词模板。未自定义时按「同人开关 × 输出语言」自动选择内置文本；自定义后固定用你的文本（同人禁外貌由追加段兜底）。',
  },
  {
    key: 'image:storyImage:structure', scene: 'storyImage', slot: 'structure', label: '输出结构要求', structural: true,
    desc: '解析器依赖的 <UBS_image> / position: / desc: / image### 结构契约。保存时校验关键 token，缺失会拦下并提示。',
  },
  {
    key: 'image:storyImage:requirement', scene: 'storyImage', slot: 'requirement', label: '任务要求与示例',
    desc: '导演构思 S1–S9、主角出镜限制、写作细则与完整示例（示例属于本段，随你改）。',
  },
  {
    key: 'image:wardrobeItem:system', scene: 'wardrobeItem', slot: 'system', label: '任务提示词（写法与输出格式）',
    desc: '服饰标签翻译器：单品本体视觉特征、类别出词规范与 <WARDROBE_PROMPTS_JSON> 输出格式。',
  },
  {
    key: 'image:wardrobeOutfit:system', scene: 'wardrobeOutfit', slot: 'system', label: '任务提示词（写法与输出格式）',
    desc: '套装重组器：模特一致性铁律、叠穿顺序、构图与 <WARDROBE_PROMPTS_JSON> 输出格式。',
  },
  {
    key: 'image:mapScene:system', scene: 'mapScene', slot: 'system', label: '任务提示词（写法与输出格式）',
    desc: '场景概念设计：单一镜头、禁鸟瞰/平面地图、无人环境规则与 JSON（含 shot_plan）输出格式。',
  },
  {
    key: 'image:itemOverview:system', scene: 'itemOverview', slot: 'system', label: '任务提示词（写法与输出格式）',
    desc: '静物陈列：多物品一张图、数量感知排布、防 UI 截图化规则与 <ITEM_OVERVIEW_JSON> 输出格式。',
  },
];

const SLOT_BY_KEY: Record<string, ImagePromptTemplateSlotDef> = {};
for (const slot of IMAGE_PROMPT_SLOTS) SLOT_BY_KEY[slot.key] = slot;

/** 覆盖键（键语法单一入口）。 */
export function imagePromptKey(scene: ImagePromptSceneKey, slot: ImagePromptSlotKey): string {
  return `image:${scene}:${slot}`;
}

export function imagePromptSlotOf(key: string): ImagePromptTemplateSlotDef | null {
  return SLOT_BY_KEY[key] ?? null;
}

export function imagePromptSlotsOfScene(scene: ImagePromptSceneKey): readonly ImagePromptTemplateSlotDef[] {
  return IMAGE_PROMPT_SLOTS.filter(s => s.scene === scene);
}

/** 全部覆盖键。 */
export const IMAGE_PROMPT_KEYS: readonly string[] = IMAGE_PROMPT_SLOTS.map(s => s.key);

/** 覆盖表上限（与手机侧 prompt-overrides 同口径）。 */
export const IMAGE_PROMPT_TEXT_CAP = 8000;
export const IMAGE_PROMPT_KEYS_CAP = 32;

/**
 * 归一化覆盖表：只用白名单键、逐值裁长、空值丢弃。未知键（旧版/脏数据）一律丢弃。
 */
export function normalizeImagePromptTemplates(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  let count = 0;
  for (const key of IMAGE_PROMPT_KEYS) {
    if (count >= IMAGE_PROMPT_KEYS_CAP) break;
    const value = src[key];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text) continue;
    out[key] = text.slice(0, IMAGE_PROMPT_TEXT_CAP);
    count++;
  }
  return out;
}

/**
 * 解析某场景槽位本次生效的文本：用户覆盖（去空白）优先，空/缺省回落传入的内置默认。
 * 注入侧唯一入口——保证「未设置 = 逐字节不变」。
 */
export function resolveImagePromptTemplate(
  templates: Record<string, string> | null | undefined,
  scene: ImagePromptSceneKey,
  slot: ImagePromptSlotKey,
  defaultText: string,
): string {
  const custom = (templates?.[imagePromptKey(scene, slot)] || '').trim();
  return custom || defaultText;
}

/** 结构类槽位的保存校验关键 token（缺任一 → 拦下并提示）。 */
export const IMAGE_PROMPT_STRUCTURE_TOKENS: Record<string, readonly string[]> = {
  'image:storyImage:structure': ['<UBS_image>', 'image###'],
};

/** 保存校验：返回错误文案 = 拦下（null = 通过）。仅结构类槽位校验。 */
export function validateImagePromptTemplate(key: string, text: string): string | null {
  const tokens = IMAGE_PROMPT_STRUCTURE_TOKENS[key];
  if (!tokens) return null;
  const missing = tokens.filter(t => !text.includes(t));
  if (missing.length) {
    return `缺少解析依赖的关键内容：${missing.join('、')}。请补回，或点「恢复默认」。`;
  }
  return null;
}

// —— 类型再导出：编辑器与注入点共用的口径 ——
export type { NaturalPromptLanguage, PortraitComposeMode };
