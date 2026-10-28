// ===== 正文插图（自动文生图）：功能配置 =====
// 独立配置项（用户要求）：总开关/自动生图开关/要求提示词/每轮上限/字数闸/图库上限。
// 尺寸与生图提示词预设绑定走 ImageGenerationConfig.tasks.storyImage（API 标签页统一管理）。
import { clampIntStrictNumber } from './number';
export const STORY_IMAGE_DEFAULT_MAX_PER_ROUND = 2;
export const STORY_IMAGE_DEFAULT_MIN_REPLY = 200;
export const STORY_IMAGE_DEFAULT_GALLERY_LIMIT = 200;
export const STORY_IMAGE_DEFAULT_WIDTH_PERCENT = 80;
export const STORY_IMAGE_DEFAULT_RENDER_FLOORS = 3;
export const STORY_IMAGE_ALIGN_OPTIONS = ['left', 'center', 'right'] as const;
export type StoryImageAlign = typeof STORY_IMAGE_ALIGN_OPTIONS[number];
export const STORY_IMAGE_DEFAULT_ALIGN: StoryImageAlign = 'left';

export interface StoryImageConfig {
  /** 自动生图开关；默认关。开=每次 AI 正文后自动插图；关=仅楼层「重新生成插图」按钮手动触发。 */
  autoGenerate: boolean;
  /** AI 要求提示词（生图提示词写法规则）；空串 = 用 DEFAULT_STORY_IMAGE_REQUIREMENT。输出结构契约写死不受自定义影响。 */
  requirementPrompt: string;
  /** 每轮最多插图张数（1-10）。 */
  maxPerRound: number;
  /** 最小正文字数闸（50-2000）：低于该值跳过自动文生图（手动触发不受限）。 */
  minReplyChars: number;
  /** 全局图库上限（20-500）：超出自动删除最旧条目（连带服务器文件）。 */
  galleryLimit: number;
  /** 插图插入正文后的显示宽度百分比（20-100，相对消息正文区域，默认 80≈当前观感）；不影响生成分辨率。 */
  insertWidthPercent: number;
  /** 插图水平对齐（默认 left=既有观感）；与宽度同走宿主页注入样式，切换立即生效、含已插入的图。 */
  insertAlign: StoryImageAlign;
  /** 插图渲染楼层窗口（0=关闭不摘除；1-20=只保留最近 N 个 AI 楼层的插图，窗口外楼层的插图 markdown 从正文摘除）。
   *  摘除后浏览器不再加载/解码/渲染这些图（真减负）；图库条目与服务器文件仍保留。 */
  renderFloors: number;
}

export function getDefaultStoryImageConfig(): StoryImageConfig {
  return {
    autoGenerate: false,
    requirementPrompt: '',
    maxPerRound: STORY_IMAGE_DEFAULT_MAX_PER_ROUND,
    minReplyChars: STORY_IMAGE_DEFAULT_MIN_REPLY,
    galleryLimit: STORY_IMAGE_DEFAULT_GALLERY_LIMIT,
    insertWidthPercent: STORY_IMAGE_DEFAULT_WIDTH_PERCENT,
    insertAlign: STORY_IMAGE_DEFAULT_ALIGN,
    renderFloors: STORY_IMAGE_DEFAULT_RENDER_FLOORS,
  };
}

export function normalizeStoryImageConfig(input: unknown): StoryImageConfig {
  const defaults = getDefaultStoryImageConfig();
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    autoGenerate: value.autoGenerate === true,
    requirementPrompt: typeof value.requirementPrompt === 'string' ? value.requirementPrompt : defaults.requirementPrompt,
    maxPerRound: clampIntStrictNumber(value.maxPerRound, 1, 10, defaults.maxPerRound),
    minReplyChars: clampIntStrictNumber(value.minReplyChars, 50, 2000, defaults.minReplyChars),
    galleryLimit: clampIntStrictNumber(value.galleryLimit, 20, 500, defaults.galleryLimit),
    insertWidthPercent: clampIntStrictNumber(value.insertWidthPercent, 20, 100, defaults.insertWidthPercent),
    insertAlign: (STORY_IMAGE_ALIGN_OPTIONS as readonly string[]).includes(value.insertAlign as string)
      ? value.insertAlign as StoryImageAlign
      : defaults.insertAlign,
    renderFloors: clampIntStrictNumber(value.renderFloors, 0, 20, defaults.renderFloors),
  };
}

/** 统计 AI 回复字符数（剥 HTML 标签 + 去全部空白），与世界演化 countReplyChars 同口径。 */
export function countStoryReplyChars(reply: string): number {
  return String(reply || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, '')
    .length;
}
