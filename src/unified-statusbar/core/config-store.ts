// ===== 配置状态管理 =====
// 设置偏好的持久化策略：
//   1. 外部偏好文件（唯一事实源）：写入酒馆 /api/files 的 usb_g_preferences_*（snapshot+segment 协议）
//      跨浏览器/设备同步、清缓存不丢。API 密钥不进入外部文件，独立存入酒馆 extensionSettings 的
//      secrets 影子（本命名空间），本机密钥保留。
//   2. 设备本地临时态：collapse 折叠态等不跨设备同步的状态用 localStorage（ub_device_config_*）。
// 注意：本文件仅负责「设置偏好」的持久化；_lsGet/_lsSet 提供给外部存放「临时 UI 状态」
// （如按钮拖拽位置、展开折叠态），这些状态本就是临时的，仍用 localStorage，不需要跨浏览器同步。
import { type StyleType, type PositionMode, type WidthMode, type CollapseBtnStyle, type AiRetryScope, CUSTOM_WIDTH_DEFAULT, CUSTOM_HEIGHT_DEFAULT, CUSTOM_SIZE_PERCENT_MIN, INVESTIGATION_DEFAULT_CONTEXT_COUNT, INVESTIGATION_DEFAULT_MAX_SUMMARY_COUNT, CALENDAR_DEFAULT_CONTEXT_COUNT, type ApiMode, type CustomApiPreset, type SceneMode, type SceneProfile, type SceneApiPreset, SCENE_PROFILE_DEFAULT, API_MODE_DEFAULT, normalizePromptPostProcessing, MAP_DEFAULT_CONTEXT_COUNT, MAP_DEFAULT_MAX_ENTRIES, SKILL_DEFAULT_CONTEXT_COUNT, SKILL_DEFAULT_MAX_WB_ENTRIES, SHOP_STORY_DEFAULT_CONTEXT_COUNT, PORTRAIT_DEFAULT_CONTEXT_COUNT, CONTEXT_STRIP_TAGS_DEFAULT, AI_RETRY_MAX_DEFAULT, normalizeAiRetryMax, normalizeAiRetryScopes, type JailbreakSlotState, createJailbreakSlotState } from './constants';
import { readLocalJson } from './safe-json';
import { normalizeJailbreakSlotState } from './jailbreak-presets';
import { NSFW_GUIDANCE_DEFAULT_CONTEXT_COUNT, NSFW_GUIDANCE_DEFAULT_MAX_CHARS, NSFW_GUIDANCE_DEFAULT_MAX_WORLD_BOOK_ENTRIES, NSFW_GUIDANCE_MAX_WORLD_BOOK_ENTRIES } from './constants';
import { getDefaultPortraitImageGen, type PortraitImageGen, type PortraitSizeOrientation, type PortraitGenPreference } from './portrait-config';
import {
  getDefaultImageGenerationConfig,
  normalizeImageGenerationConfig,
  type ImageGenerationConfig,
} from './image-generation-config';
import {
  getDefaultStoryImageConfig,
  normalizeStoryImageConfig,
  type StoryImageConfig,
} from './story-image-config';
import {
  STATUSBAR_CONTENT_FONT_SCALE_DEFAULT,
  normalizeStatusbarContentFontScale,
} from './statusbar-font-scale';
import {
  UI_FONT_SCALE_DEFAULT,
  normalizeUiFontScale,
} from './ui-font-scale';
import { getDefaultCharacterWorldbookTemplates, normalizeCharacterWorldbookTemplateLibrary, type CharacterWorldbookTemplate } from './character-worldbook-config';
import { DEFAULT_TRAIT_POOL_STATE, normalizeTraitPoolState, type CharacterWorldbookTraitPoolState } from './character-trait-pools';
import type { ExternalObjectStore } from './external-object-store';
import { redactExternalStorageSecrets } from './external-storage-secret-redaction';
import { topWindowCandidates } from './cross-window';

/** 通知水平位置（成就自建 + 普通 toastr 共用）：靠左/居中/靠右；默认居中。垂直固定顶部、堆叠向下。 */
export type NotifyAlign = 'left' | 'center' | 'right';

/** 通知效果（2026-08-24 四档重设计）：porcelain=素瓷（暖白瓷面玻璃壳）；inkglass=云墨（深青岩玻璃壳）；
 * auto=自适应（浅色素瓷、深色模式自动换云墨，默认）；original=回原生 toastr 外观，位置不生效，成就卡片仍美化但回默认居中。
 * 旧值 beautified 由 sanitize 迁移为 auto。 */
export type NotifyEffect = 'porcelain' | 'inkglass' | 'auto' | 'original';

/** 立绘自动更新模式：off=不自动更新 / missing-only=仅无立绘角色自动生成 / every-turn=每轮（剧情上下文变化）为在场角色重新生成 */
export type PortraitAutoUpdateMode = 'off' | 'missing-only' | 'every-turn';

export interface StatusBarConfig {
  style: StyleType;
  /** 古风/仙侠合并风格的当前子配色：仅当 style 为 ancient/xianxia 时即为此值。
   *  切换离开再回来时按此值恢复；in-statusbar 切换按钮更新此值并同步 style。 */
  literaryScheme: 'ancient' | 'xianxia';
  collapsed: boolean;
  playCollapsed: boolean;
  darkTheme: boolean;
  /** 弹窗配色来源：跟随插件（状态栏自身明暗）或跟随酒馆（SillyTavern 明暗）。 */
  panelColorMode: 'plugin' | 'tavern';
  nsfwPlayEnabled: boolean;
  /** 瑟瑟玩法-自动清空：每条消息生成结束后自动执行一次一键清空 */
  nsfwPlayAutoClear: boolean;
  /** 瑟瑟玩法注入条目（聚合玩法 + 体位起止）的世界书位置类型；默认 at_depth（= 原全局 WB 体位起位置）。仅 at_depth 时 depth 生效。 */
  nsfwPlayWorldbookPosition: 'at_depth' | 'before_character_definition' | 'after_character_definition' | 'before_author_note' | 'after_author_note';
  /** 瑟瑟玩法注入条目的深度（仅 at_depth 生效；默认 0）。 */
  nsfwPlayWorldbookDepth: number;
  /** 瑟瑟玩法同时生效上限（1-10，默认 5 = 与翻新前「每类 1 条 × 5 类」等量）。 */
  nsfwPlayMaxSelected: number;
  /** 玩法自定义库（自定义类别/条目 + 内置隐藏清单 + 收藏）。unknown 透传，
   *  归一化收敛在 core/play-library.ts normalizePlayLibraryState（避免 config-store 反向依赖）。 */
  nsfwPlayLibrary: unknown;
  /** 瑟瑟指导读取最近 N 条 AI 输出（1-20）。 */
  nsfwGuidanceContextCount: number;
  /** 瑟瑟指导提示模型遵守的最大输出字数；仅作提示词约束，不在前端截断。 */
  nsfwGuidanceMaxChars: number;
  /** 地点 + 角色世界书资料合计最大注入条目数（1-50）。 */
  nsfwGuidanceMaxWorldbookEntries: number;
  positionMode: PositionMode;
  widthMode: WidthMode;
  customWidthPercent: number;
  customHeightPercent: number;
  /** 状态栏人物实时信息正文字号倍率（1–1.5，步进 0.05，默认 1.1）；不影响标题、按钮与弹窗。 */
  statusbarContentFontScale: number;
  /** 弹窗/设置面板正文字号倍率（1–1.5，步进 0.05，默认 1）；只缩放正文/数据文本/输入控件，不影响标题、按钮、结构性小字。 */
  popupSettingsFontScale: number;
  showFloatingBtn: boolean;
  showHelpTips: boolean;
  /** DS 缓存优化：开启后本插件注入世界书的所有持久条目统一插入 at_depth system 0，提升 DeepSeek 等前缀缓存模型的正文命中率；关闭恢复各条目原位置。 */
  dsCacheOptimize: boolean;
  /** 备份快照：每 N 层 AI 回复自动生成一次总备份（1-999，默认 5）。 */
  storyBackupInterval: number;
  /** 一键搬家：把当前聊天最后 N 层 AI 楼层复制成新聊天（1-999，默认 10）。 */
  moveLayers: number;
  /** 一键搬家：搬家完成后是否直接切换进入新聊天（默认 false，保持只 toast 通知）。 */
  moveChatAutoOpen: boolean;
  shopEnabled: boolean;
  /** 衣柜总开关；关闭时不渲染入口、不读写衣柜数据、不运行后台任务。 */
  wardrobeEnabled: boolean;
  /** 全局生图间隔秒数（整数 0–120，默认 45）：约束所有生图行为（手动/自动/衣柜批量/换装），任意两次生图请求间隔 ≥ 此值。 */
  imageGenerationIntervalSeconds: number;
  /** 统一生图运行时配置；立绘、衣柜和地图按任务分别保有尺寸与提示词预设。 */
  imageGeneration: ImageGenerationConfig;
  /** 衣柜套装生图的固定外貌匿名模特标签，男女各一套；用户可在设置自定义，生图时按所选性别取用。 */
  wardrobeModelTags: { female: string; male: string };
  /** 剧情特卖 AI 生成上下文条数（1-30） */
  shopStoryContextCount: number;
  /** 剧情特卖绑定的 API 预设 id；apiMode='per-feature' 时生效，空串=走酒馆主 API */
  shopStoryApiPresetId: string;
  investigationEnabled: boolean;
  interviewEnabled: boolean;
  interviewReadDossier: boolean;
  investigationContextCount: number;
  investigationMaxSummaryCount: number;
  /** 大调查档案字号缩放倍率（0.9–1.5，步进 0.1，默认 1）；仅作用于档案弹窗正文区。 */
  investigationFontScale: number;
  /** 大采访档案字号缩放倍率（0.9–1.5，步进 0.1，默认 1）；仅作用于档案弹窗正文区。 */
  interviewFontScale: number;
  /** 大采访档案弹窗左侧历史侧边栏展开状态；true=展开，false=收起。默认 false。
   *  仅由用户点顶栏 ◀/▶ 切换；选择不同历史采访/删除某篇重渲时不重置，跨弹窗保持。 */
  interviewSidebarOpen: boolean;
  /** 大调查档案弹窗左侧历史侧边栏折叠状态；true=折叠，false=展开。默认 false。
   *  仅由用户点顶栏 ◀/▶ 切换；切换不同历史档案重渲时不重置，跨弹窗保持。 */
  investigationSidebarCollapsed: boolean;
  timeAnchorEnabled: boolean;
  /** 重填模式：开启期间暂停本插件所有「自动 AI 请求」与「自动数据写入」，避免干扰用户的表格重填；
   *  只拦后台自动路径，用户点击的功能照常工作。关闭后自动补跑一轮恢复。默认关。 */
  refillModeEnabled: boolean;
  optionsBarEnabled: boolean;
  optionsBarSendMode: 'send' | 'fill';
  /** 选项栏跟随底部：fixed-top/fixed-bottom 时把选项栏抽离到消息流末尾常驻；follow-bottom 时本设置不生效 */
  optionsBarFollowBottom: boolean;
  calendarEnabled: boolean;
  calendarAutoDaily: boolean;
  calendarContextCount: number;
  /** 日历生日开关；关时日历不显示生日标注、世界书今日投影不含生日行（年龄推算不受影响）。默认开。 */
  calendarBirthdayEnabled: boolean;
  // ===== 世界演化窗口 =====
  /** 世界演化总开关；关时引擎不再自动演化（窗口仍可打开查看已存状态）。 */
  worldEnabled: boolean;
  /** 世界演化自动更新开关；关时不随轮数/日期自动触发演化（世界窗口「手动演化」仍可用）。默认开。 */
  worldAutoUpdate: boolean;
  /** 世界演化·小手机联动：开启且检测到瑟瑟小手机运行时，演化提示词允许焦点角色主动给主角发微信/来电（事件实时推入小手机）。默认关。 */
  worldPhoneLink: boolean;
  /** 小演化轮数间隔（1-20，默认 1）。 */
  worldEvolveEveryTurns: number;
  /** 演化请求焦点子集上限（3-30，默认 6）。 */
  worldFocusMax: number;
  /** 每轮轮转批次角色数（1-20，默认 4）。 */
  worldRotationBatch: number;
  /** 世界书结构段蓝灯（constant 常亮）条目上限（1-100，默认 100）。 */
  worldWbBlueMax: number;
  /** 世界书结构段绿灯（关键词触发）条目上限（1-60，默认 60）。 */
  worldWbGreenMax: number;
  /** 演化请求最近剧情上下文条数（1-30，默认 2）。 */
  worldContextCount: number;
  /** v2：世界演化注入纪要总量（10-100，默认 50）。每焦点角色 summary 含名保底 5 条，超量全保留、不足并集补足。 */
  worldChronicleTotal: number;
  /** 演化自动更新最小回复字数（1-2000，默认 200）：最新 AI 回复字符数低于该值跳过自动演化。 */
  worldEvolveMinReply: number;
  /** 演化风格方向的「全局默认」（未单独设置的角色卡/欢迎页沿用它；按卡选择见 core/world-engine/world-style-library）。
   *  general=通用(不加要求) / sweet=甜蜜恋爱 / intrigue=权谋宫斗 / surprise=出其不意 /
   *  custom:<id>=全局风格库里的自定义风格 / custom=旧自定义（无 id，文本仍在 worldEvolveStyleCustom，兼容旧存档）。 */
  worldEvolveStyle: 'general' | 'sweet' | 'intrigue' | 'surprise' | 'custom' | `custom:${string}`;
  /** 演化风格自定义要求（旧字段：worldEvolveStyle=custom 时生效；新流程走风格库条目文本）。 */
  worldEvolveStyleCustom: string;
  /** 自定义演化风格库（全局共享，所有角色卡共用一份）。结构非法/坏项由
   *  core/world-engine/world-style-library 归一化（读数处收敛，避免 config-store 反向依赖）。 */
  worldEvolveStyleLibrary: unknown;
  // ===== 正文插图（自动文生图）=====
  /** 正文插图总开关；默认关（关闭时零 AI 请求零生图开销）。 */
  storyImageEnabled: boolean;
  // ===== 货币系统 =====
  /** 货币系统总开关；默认开（关闭时零渲染/零注入/零回调，数据保留）。 */
  currencyEnabled: boolean;
  /** 正文插图独立配置项（自动生图开关/要求提示词/每轮上限/字数闸/图库上限）。 */
  storyImage: StoryImageConfig;
  // ===== 月信与孕育系统 =====
  /** 经期/孕期总开关档位：off=关闭(真零开销) / period=经期 / full=经期+孕期。 */
  cycleMode: 'off' | 'period' | 'full';
  /** 经期世界书注入开关（任意角色经期时注入描写参考）。仅 period/full 下生效。 */
  cycleWorldbookPeriod: boolean;
  /** 孕期世界书注入开关（任意角色怀孕时注入孕期状态参考）。仅 full 下生效。 */
  cycleWorldbookPregnancy: boolean;
  /** 受孕形式弹窗策略：always_ask=事后弹窗采防护系数 / assume_unprotected=默认内射不弹 / assume_withdrawal=默认外射不弹 / assume_protected=默认安全套不弹。仅 full 下生效。 */
  cycleSexFormPrompt: 'always_ask' | 'assume_unprotected' | 'assume_withdrawal' | 'assume_protected';
  /** 状态栏周期进度条（经期条/孕期条）显隐；默认开。关时 cyclePhaseBar 不渲染（主角姓名旁 badge 不受影响）。仅 period/full 下生效。 */
  cycleShowBar: boolean;
  // ===== 人物关系（人物网） =====
  /** 人物关系表世界书注入开关（默认开）：把成对关系以「姓名A 与 姓名B」与触发的关键词条目注入角色主世界书；关闭时移除注入条目族。 */
  charRelationWorldbook: boolean;
  // ===== 地图生成功能 =====
  mapEnabled: boolean;
  mapContextCount: number;
  mapMaxEntries: number;
  skillEnabled: boolean;
  skillContextCount: number;
  skillMaxWorldbookEntries: number;
  /** 地图自动更新模式：off=不自动更新 / new-location=到达新地点时 / location-change=地点变换时 / every-turn=每轮都更新 */
  mapAutoUpdateMode: 'off' | 'new-location' | 'location-change' | 'every-turn';
  /** 自动更新时是否重绘地图画面：开=重新生成 SVG/结构/角色；关=只更新文字记录（旧「智能更新」的替代项）。 */
  mapAutoRedraw: boolean;
  /** 地点候选冲突策略：每次询问 / 默认保留旧路径 / 默认采用当前路径。多个候选始终询问。 */
  mapLocationConflictStrategy: 'always-ask' | 'prefer-existing' | 'prefer-current';
  /** 生成地图时是否自动跟随生成场景图；关时仅手动点场景图按钮可生成。默认关。 */
  mapAutoGenSceneImage: boolean;
  /** 地图库节点注入世界书时排除的地点名（中文、顿号分隔）；这些地点不参与注入。 */
  mapExcludePattern: string;
  // ===== 立绘功能 =====
  /** 立绘生图总开关；关时零渲染零请求 */
  portraitEnabled: boolean;
  /** 显示主角立绘：开启后各主题主角身份区显示主角立绘框；关闭时主界面与现状逐字节一致。 */
  portraitProtagonistEnabled: boolean;
  /** 立绘自动更新模式：off=不自动更新 / missing-only=仅无立绘角色自动生成 / every-turn=每轮为在场角色重新生成 */
  portraitAutoUpdateMode: PortraitAutoUpdateMode;
  /** AI 立绘生成成功后自动加入该角色的随机立绘池；本地导入不受影响 */
  portraitAutoAddToRandomPool: boolean;
  /** 随机立绘筛选依据：byEmotion=仅从情绪与当前一致的图片随机；byNsfw=仅从瑟瑟状态一致的图片随机；全 false=全池随机。 */
  portraitRandomFilter: { byEmotion: boolean; byNsfw: boolean };
  /** 生成 prompt 时取最近 N 段 AI 回复作上下文；默认 2 */
  portraitContextCount: number;
  /** 立绘生成偏好（点「保存为偏好」落盘）；undefined=无偏好，弹窗与自动更新回退默认 */
  portraitGenPreference?: PortraitGenPreference;
  /** 立绘图库绑定配置（供应商/模型/采样器/尺寸/提示词等） */
  portraitImageGen: PortraitImageGen;
  collapseBtnStyle: CollapseBtnStyle;
  // ===== 请求生成 API 配置 =====
  apiMode: ApiMode;
  /** 自定义 API 密钥（经 secrets 影子持久化；仅保留此字段，标量参数已随预设迁移） */
  customApiKey: string;
  // 自定义 API 预设列表
  customApiPresets: CustomApiPreset[];
  /** 当前激活的预设 id（空串表示无选中）；apiMode='custom' 时所有请求生成功能共用此预设 */
  activeApiPresetId: string;
  /** 大调查绑定的预设 id；apiMode='per-feature' 时生效，空串=该功能走酒馆主 API */
  investigationApiPresetId: string;
  /** 日历绑定的预设 id；apiMode='per-feature' 时生效，空串=该功能走酒馆主 API */
  calendarApiPresetId: string;
  /** 地图绑定的预设 id；apiMode='per-feature' 时生效，空串=该功能走酒馆主 API */
  mapApiPresetId: string;
  skillApiPresetId: string;
  /** 立绘生成 prompt 所用 AI 预设 id；apiMode='per-feature' 时生效，空串=走酒馆主 API */
  portraitApiPresetId: string;
  /** 衣柜 AI 提炼服饰所用 API 预设 id；apiMode='per-feature' 时生效，空串=走酒馆主 API（生图提示词仍走立绘预设） */
  wardrobeExtractApiPresetId: string;
  /** 瑟瑟指导所用 AI 预设 id；apiMode='per-feature' 时生效，空串=走酒馆主 API */
  nsfwGuidanceApiPresetId: string;
  /** [LEGACY-MERGE · DB-ONLY] 状态栏纪要合并所用 AI 预设 id；仅数据库模式设置页可见。
   *  台账接管时合并跟随台账「填表 API」，本字段不再参与；后续移除状态栏合并时一并删除。 */
  chronicleMergeApiPresetId: string;
  /** 角色世界书创建与更新共用的 API 预设 id；apiMode='per-feature' 时生效，空串=走酒馆主 API */
  characterWorldbookApiPresetId: string;
  /** 世界演化（世界引擎 AI 生成）所用的 API 预设 id；apiMode='per-feature' 时生效，空串=走酒馆主 API */
  worldApiPresetId: string;
  /** AI 请求失败自动重试：tavern/custom 模式下的总开关（per-feature 模式改用 aiRetryScopes）。默认关。 */
  aiRetryEnabled: boolean;
  /** 最大重试次数（1-5；总尝试次数 = 该值 + 1）。默认 3。 */
  aiRetryMax: number;
  /** 按功能独立分配模式下的逐功能重试开关（稀疏表；键缺失=该功能不重试）。 */
  aiRetryScopes: Partial<Record<AiRetryScope, boolean>>;
  characterWorldbookTemplates: CharacterWorldbookTemplate[];
  characterWorldbookCreateTemplateId: string;
  /** 角色世界书创建：性格池/NSFW特质池的抽取数量与当前已选标签（空标签=不启用该池）。 */
  characterWorldbookTraitPools: CharacterWorldbookTraitPoolState;
  /** 新人物创建的待相遇名单：主世界书名 → 姓名列表（角色中枢占位符数据源；深度归一见 character-pending-encounter）。 */
  characterWorldbookPendingEncounters: Record<string, string[]>;
  // ===== 破限提示词自定义（破限头 / 尾部破限 同构两槽位 + 独立反八股）=====
  /** 破限头槽位：default=项目内置 / none=空（不发送）/ custom=用户段落列表。拼在请求最上端。 */
  jailbreakHead: JailbreakSlotState;
  /** 尾部破限槽位：default=项目内置（原「反截断」原文）/ none=空 / custom=用户段落列表。拼在请求最下端。 */
  jailbreakTail: JailbreakSlotState;
  /** 反八股写作要求模式：default=项目内置 / custom=用户自定义。独立于破限，仅叙事文本类 AI 请求拼接。 */
  antiClicheMode: 'default' | 'custom';
  /** 自定义反八股文本；仅 antiClicheMode='custom' 且非空时生效，空则回退内置。 */
  antiClicheText: string;
  // ===== 数据库可视化按钮显示开关 =====
  /** 数据库可视化按钮显示（顶栏 database 按钮 + 折叠菜单「数据库」项）；默认开 */
  dbViewerEnabled: boolean;
  // ===== 场景一键切换（日常 / 瑟瑟）=====
  /** 场景切换总开关 */
  sceneSwitchEnabled: boolean;
  /** 当前激活档位，'' 表示未激活 */
  sceneSwitchCurrent: SceneMode | '';
  /** 场景 API 预设仓库（共享，日常/瑟瑟档位通过 apiPresetId 引用） */
  sceneApiPresets: SceneApiPreset[];
  /** 日常档位绑定 */
  sceneDailyProfile: SceneProfile;
  /** 瑟瑟档位绑定 */
  sceneNsfwProfile: SceneProfile;
  // ===== 成就系统 =====
  /** 成就功能总开关；默认开。关→彻底零负担：不扫描/不计数/派发器空函数/不读簿/入口不显示。 */
  achievementEnabled: boolean;
  /** 成就解锁通知（toastr）；默认开。零侵入关闭路径。 */
  achievementNotifyEnabled: boolean;
  /** 通知水平位置（成就自建 + 普通 toastr 共用）：靠左/居中/靠右；默认居中。垂直固定顶部、堆叠向下。 */
  notifyAlign: NotifyAlign;
  /** 通知效果总开关（原版/美化）；默认美化。原版下取消一切 toastr 美化与位置设置，成就卡片仍美化但回默认居中。 */
  notifyEffect: NotifyEffect;
  /** AI 进行中通知常驻：true=酒馆 toast 常驻；false（默认）=3 秒自动隐去（主界面提示条常驻）。
   *  失败/错误告警不受此开关影响。 */
  aiNoticePersist: boolean;
  // ===== 上下文标签剥离（MANUAL 模式专用：地图 / 立绘 / 瑟瑟指导）=====
  /** 取上下文后、注入提示词前需剥离的标签名列表（不含尖括号、小写）。
   *  每个标签 T 会剥离成对的 <T>...</T>（含内容、最短匹配、大小写不敏感、全部出现处）。
   *  作用于各功能读取「剧情上下文」的位置：地图、立绘、瑟瑟指导、正文插图，以及大调查/大采访/
   *  日历/剧情特卖/技能树/世界演化的资料块与触发正文（1A 三段式统一后）。
   *  空数组 = 不剥离。默认 ['image']。 */
  contextStripTags: string[];
  /** 条目黑名单：每行一个正则（默认忽略英文大小写）。条目名称（备注名）命中的条目在 1A 类
   *  AI 请求（大调查/大采访/日历/剧情特卖/世界演化/技能树/角色世界书 + 小手机微信/电话）的
   *  世界书装载中被剔除——不进提示词、不参与绿灯扫描，蓝灯常亮一并剔除，底账不改。
   *  空数组 = 关闭。默认 []。 */
  entryBlacklist: string[];
  // ===== 表格分组模式 =====
  /** 表格分组模式：grouped=各表用预设分组（部分1部分2）/ flat=所有未关闭表统一归分组1。
   *  影响「表格」tab 的批量切换，以及单独「开启」某张表时落入的分组（flat→1，grouped→预设）。
   *  默认 flat：与 标准模板出厂 updateConfig.groupId 全为 1（非分组）对齐，
   *  避免按钮停在「分组版」而实际数据为非分组的不一致。修复成功后亦重置回 flat。 */
  tableGroupMode: 'grouped' | 'flat';
  /** 物品使用开关属于跨设备共享的显式用户偏好。 */
  itemUseEnabled: boolean;
  /** null 表示尚未选择，空数组表示明确关闭全部卡池。 */
  gachaSelectedPoolIds: string[] | null;
  // ===== 宅仙只读 AI 小助手 =====
  /** 小助手总开关；默认关。关时零渲染零请求、悬浮球入口不显示。 */
  assistantEnabled: boolean;
  /** 悬浮球位置（距右、距下像素偏移）；用户可拖拽，此字段存持久态。 */
  assistantFloatPosition: { right: number; bottom: number };
  /** 小助手独立 API 预设 id；空串=跟随酒馆主 API。不继承全局 apiMode 决策。 */
  assistantApiPresetId: string;
  /** 回答是否流式输出；true=逐字流式，false=整段返回后一次渲染（markdown 转换在两种模式下生效）。 */
  assistantStreaming: boolean;
  /** 「最近剧情」来源读取的楼层数（1-50）；只影响剧情资料深度，不改变世界书绿灯的酒馆扫描深度语义。 */
  assistantContextDepth: number;
  /** 回答口吻：default=内置宅仙人设，custom=用户自定义人设文本。 */
  assistantPersonaMode: 'default' | 'custom';
  /** 自定义人设文本；仅 assistantPersonaMode==='custom' 时生效，空串回退内置人设。 */
  assistantPersonaText: string;
}

// ===== 世界演化窗口默认常量 =====
const WORLD_DEFAULT_ENABLED = true;
const WORLD_DEFAULT_AUTO_UPDATE = true;
const WORLD_DEFAULT_EVERY_TURNS = 1;
const WORLD_DEFAULT_FOCUS_MAX = 6;
const WORLD_DEFAULT_ROTATION_BATCH = 4;
const WORLD_DEFAULT_WB_BLUE = 100;
const WORLD_DEFAULT_WB_GREEN = 60;
const WORLD_DEFAULT_CONTEXT_COUNT = 2;
const WORLD_DEFAULT_MIN_REPLY = 200; // 演化自动更新最小回复字数（不足则跳过自动演化）
const WORLD_DEFAULT_CHRONICLE_TOTAL = 50; // v2：世界演化注入纪要总量
const WORLD_DEFAULT_EVOLVE_STYLE: StatusBarConfig['worldEvolveStyle'] = 'general'; // 演化风格方向默认通用
const WORLD_DEFAULT_EVOLVE_STYLE_CUSTOM = '';
const WORLD_DEFAULT_EVOLVE_STYLE_LIBRARY: unknown[] = []; // 自定义演化风格库默认空（首次用到才建条目）

const DEFAULT_CONFIG: StatusBarConfig = {
  style: 'ancient',
  literaryScheme: 'ancient',
  collapsed: false,
  playCollapsed: false,
  darkTheme: false,
  panelColorMode: 'plugin',
  nsfwPlayEnabled: true,
  nsfwPlayAutoClear: false,
  nsfwPlayWorldbookPosition: 'at_depth',
  nsfwPlayWorldbookDepth: 0,
  nsfwPlayMaxSelected: 5,
  nsfwPlayLibrary: null,
  nsfwGuidanceContextCount: NSFW_GUIDANCE_DEFAULT_CONTEXT_COUNT,
  nsfwGuidanceMaxChars: NSFW_GUIDANCE_DEFAULT_MAX_CHARS,
  nsfwGuidanceMaxWorldbookEntries: NSFW_GUIDANCE_DEFAULT_MAX_WORLD_BOOK_ENTRIES,
  positionMode: 'fixed-top',
  widthMode: 'full',
  customWidthPercent: CUSTOM_WIDTH_DEFAULT,
  customHeightPercent: CUSTOM_HEIGHT_DEFAULT,
  statusbarContentFontScale: STATUSBAR_CONTENT_FONT_SCALE_DEFAULT,
  popupSettingsFontScale: UI_FONT_SCALE_DEFAULT,
  showFloatingBtn: false,
  showHelpTips: true,
  dsCacheOptimize: false,
  storyBackupInterval: 5,
  moveLayers: 10,
  moveChatAutoOpen: false,
  shopEnabled: true,
  wardrobeEnabled: true,
  charRelationWorldbook: true,
  imageGenerationIntervalSeconds: 45,
  imageGeneration: getDefaultImageGenerationConfig(),
  wardrobeModelTags: getDefaultWardrobeModelTags(),
  shopStoryContextCount: SHOP_STORY_DEFAULT_CONTEXT_COUNT,
  shopStoryApiPresetId: '',
  investigationEnabled: true,
  interviewEnabled: true,
  interviewReadDossier: true,
  investigationContextCount: INVESTIGATION_DEFAULT_CONTEXT_COUNT,
  investigationMaxSummaryCount: INVESTIGATION_DEFAULT_MAX_SUMMARY_COUNT,
  investigationFontScale: 1,
  interviewFontScale: 1,
  interviewSidebarOpen: false,
  investigationSidebarCollapsed: false,
  timeAnchorEnabled: false,
  refillModeEnabled: false,
  optionsBarEnabled: true,
  optionsBarSendMode: 'fill',
  optionsBarFollowBottom: false,
  calendarEnabled: true,
  calendarAutoDaily: false,
  calendarContextCount: CALENDAR_DEFAULT_CONTEXT_COUNT,
  calendarBirthdayEnabled: true,
    worldEnabled: WORLD_DEFAULT_ENABLED,
    worldAutoUpdate: WORLD_DEFAULT_AUTO_UPDATE,
    worldPhoneLink: false,
  worldEvolveEveryTurns: WORLD_DEFAULT_EVERY_TURNS,
  worldFocusMax: WORLD_DEFAULT_FOCUS_MAX,
  worldRotationBatch: WORLD_DEFAULT_ROTATION_BATCH,
  worldWbBlueMax: WORLD_DEFAULT_WB_BLUE,
  worldWbGreenMax: WORLD_DEFAULT_WB_GREEN,
  worldContextCount: WORLD_DEFAULT_CONTEXT_COUNT,
  worldChronicleTotal: WORLD_DEFAULT_CHRONICLE_TOTAL,
  worldEvolveMinReply: WORLD_DEFAULT_MIN_REPLY,
  worldEvolveStyle: WORLD_DEFAULT_EVOLVE_STYLE,
  worldEvolveStyleCustom: WORLD_DEFAULT_EVOLVE_STYLE_CUSTOM,
  worldEvolveStyleLibrary: WORLD_DEFAULT_EVOLVE_STYLE_LIBRARY,
  // ===== 正文插图（自动文生图）默认值（默认关）=====
  storyImageEnabled: false,
  // ===== 货币系统默认值（默认开）=====
  currencyEnabled: true,
  storyImage: getDefaultStoryImageConfig(),
  // ===== 月信与孕育系统默认值（默认 off，真零开销）=====
  cycleMode: 'off',
  cycleWorldbookPeriod: true,
  cycleWorldbookPregnancy: true,
  cycleSexFormPrompt: 'always_ask',
  cycleShowBar: true,
  // ===== 地图生成功能默认值 =====
  mapEnabled: true,
  mapContextCount: MAP_DEFAULT_CONTEXT_COUNT,
  mapMaxEntries: MAP_DEFAULT_MAX_ENTRIES,
  skillEnabled: false,
  skillContextCount: SKILL_DEFAULT_CONTEXT_COUNT,
  skillMaxWorldbookEntries: SKILL_DEFAULT_MAX_WB_ENTRIES,
  mapAutoUpdateMode: 'off',
  mapAutoRedraw: true,
  mapLocationConflictStrategy: 'always-ask',
  mapAutoGenSceneImage: false,
  mapExcludePattern: '客厅、餐厅、厨房、洗手间、卧室',
  // ===== 立绘功能默认值 =====
  portraitEnabled: false,
  portraitProtagonistEnabled: false,
  portraitAutoUpdateMode: 'off',
  portraitAutoAddToRandomPool: false,
  portraitRandomFilter: { byEmotion: false, byNsfw: false },
  portraitContextCount: PORTRAIT_DEFAULT_CONTEXT_COUNT,
  portraitGenPreference: undefined,
  portraitImageGen: getDefaultPortraitImageGen(),
  collapseBtnStyle: 'time-window',
  apiMode: API_MODE_DEFAULT,
  customApiKey: '',
  customApiPresets: [],
  activeApiPresetId: '',
  investigationApiPresetId: '',
  calendarApiPresetId: '',
  mapApiPresetId: '',
  skillApiPresetId: '',
  portraitApiPresetId: '',
  wardrobeExtractApiPresetId: '',
  nsfwGuidanceApiPresetId: '',
  chronicleMergeApiPresetId: '',
  characterWorldbookApiPresetId: '',
  worldApiPresetId: '',
  aiRetryEnabled: false,
  aiRetryMax: AI_RETRY_MAX_DEFAULT,
  aiRetryScopes: {},
  characterWorldbookTemplates: getDefaultCharacterWorldbookTemplates(),
  characterWorldbookCreateTemplateId: 'cw-create-default',
  characterWorldbookTraitPools: { ...DEFAULT_TRAIT_POOL_STATE, personalityTags: [], nsfwTags: [] },
  characterWorldbookPendingEncounters: {},
  jailbreakHead: createJailbreakSlotState(),
  jailbreakTail: createJailbreakSlotState(),
  antiClicheMode: 'default',
  antiClicheText: '',
  dbViewerEnabled: true,
  sceneSwitchEnabled: false,
  sceneSwitchCurrent: '',
  sceneApiPresets: [],
  sceneDailyProfile: { ...SCENE_PROFILE_DEFAULT },
  sceneNsfwProfile: { ...SCENE_PROFILE_DEFAULT },
  achievementEnabled: true,
  achievementNotifyEnabled: true,
  notifyAlign: 'center',
  notifyEffect: 'auto',
  aiNoticePersist: false,
  contextStripTags: [...CONTEXT_STRIP_TAGS_DEFAULT],
  entryBlacklist: [],
  tableGroupMode: 'flat',
  itemUseEnabled: false,
  gachaSelectedPoolIds: null,
  // ===== 宅仙只读 AI 小助手默认值（默认关，零开销）=====
  assistantEnabled: false,
  assistantFloatPosition: { right: 20, bottom: 88 },
  assistantApiPresetId: '',
  assistantStreaming: true,
  assistantContextDepth: 10,
  assistantPersonaMode: 'default',
  assistantPersonaText: '',
};

const STYLE_VALUES: readonly StyleType[] = [
  'ancient',
  'flirtatious',
  'minimal',
  'sweet',
  'xianxia',
  'bridge',
  'ios',
];

function normalizeStyle(value: unknown): StyleType {
  return typeof value === 'string' && STYLE_VALUES.includes(value as StyleType)
    ? value as StyleType
    : DEFAULT_CONFIG.style;
}

/** 字号缩放倍率归一化：钳制到 [0.9, 1.5]，圆整到 0.1 步长，非法/缺失回退 1。 */
function _normFontScale(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 1;
  const clamped = Math.min(1.5, Math.max(0.9, n));
  return Math.round(clamped * 10) / 10;
}

// ===== 存储键名 =====
// 主存储：酒馆 extensionSettings 命名空间（仅存 secrets 影子与设备无关元数据；
// 设置偏好本体写入外部偏好文件 usb_g_preferences_*，见 configureConfigStorage）
const TAVERN_SETTINGS_NAMESPACE = 'unified_statusbar__settings_v1';

// ===== SillyTavern 访问（iframe 兼容：优先当前窗口，回退父窗口） =====
function _getSillyTavern(): any {
  try {
    if ((window as any).SillyTavern) return (window as any).SillyTavern;
    if ((window.parent as any).SillyTavern) return (window.parent as any).SillyTavern;
  } catch (e) { /* cross-origin */ }
  return null;
}

// 获取 extensionSettings 根对象（兼容 iframe 直暴露与插件模式需 getContext 两种情况）
function _getExtensionSettingsRoot(): Record<string, any> | null {
  const st = _getSillyTavern();
  if (!st) return null;
  let root = st.extensionSettings;
  if (!root && typeof st.getContext === 'function') {
    try { root = st.getContext()?.extensionSettings; } catch (e) { /* ignore */ }
  }
  if (!root || typeof root !== 'object') return null;
  return root;
}

// 获取本插件的命名空间对象（不存在则自动创建）。不可用时返回 null。
function _getTavernSettingsNS(): Record<string, any> | null {
  const root = _getExtensionSettingsRoot();
  if (!root) return null;
  if (!root.__userscripts) root.__userscripts = {};
  if (!root.__userscripts[TAVERN_SETTINGS_NAMESPACE]) root.__userscripts[TAVERN_SETTINGS_NAMESPACE] = {};
  return root.__userscripts[TAVERN_SETTINGS_NAMESPACE];
}

// 触发酒馆后端持久化（防抖）。saveSettingsDebounced 不可用时尝试 saveSettings。
function _persistTavernSettings(): void {
  const st = _getSillyTavern();
  if (!st) return;
  let save = st.saveSettingsDebounced;
  if (typeof save !== 'function' && typeof st.getContext === 'function') {
    try { save = st.getContext()?.saveSettingsDebounced; } catch (e) { /* ignore */ }
  }
  if (typeof save === 'function') {
    try { save.call(st); } catch (e) { /* ignore */ }
    return;
  }
  // 降级：saveSettings（非防抖，立即写盘）
  let sync = st.saveSettings;
  if (typeof sync !== 'function' && typeof st.getContext === 'function') {
    try { sync = st.getContext()?.saveSettings; } catch (e) { /* ignore */ }
  }
  if (typeof sync === 'function') {
    try { sync.call(st); } catch (e) { /* ignore */ }
  }
}

let _configStorageMode: 'legacy' | 'external' = 'legacy';
let _externalConfigStore: ExternalObjectStore | null = null;
let _pendingExternalConfigPatch: Record<string, unknown> = {};
let _externalConfigWriteScheduled = false;
let _externalConfigWriteChain: Promise<boolean> = Promise.resolve(true);
const DEVICE_LOCAL_CONFIG_KEYS = new Set<keyof StatusBarConfig>([
  'collapsed',
  'playCollapsed',
  'interviewSidebarOpen',
  'investigationSidebarCollapsed',
]);

function _readDeviceLocalConfig<K extends keyof StatusBarConfig>(
  key: K,
  fallback: StatusBarConfig[K],
): StatusBarConfig[K] {
  // U33：收编 readLocalJson（兜底原样传入，零行为变化）
  return readLocalJson<StatusBarConfig[K]>(`ub_device_config_${String(key)}`, fallback);
}

function _writeDeviceLocalConfig<K extends keyof StatusBarConfig>(
  key: K,
  value: StatusBarConfig[K],
): void {
  try { localStorage.setItem(`ub_device_config_${String(key)}`, JSON.stringify(value)); } catch (_e) { /* ignore */ }
}

interface ProtectedConfigSecrets {
  customApiKey: string;
  customApiPresetKeys: Record<string, string>;
  sceneApiPresetKeys: Record<string, string>;
  sceneApiPresetSensitive: Record<string, { key: string; customHeaders: string; bodyParams: string }>;
  /** 立绘/图源 API key（NAI、OpenAI 兼容图源）；外部偏好文件脱敏，影子持久化 */
  imageProviderKeys: { novelai: string; openai: string };
}

function _readProtectedConfigSecrets(): ProtectedConfigSecrets {
  const ns = _getTavernSettingsNS();
  const explicit = ns?.secrets && typeof ns.secrets === 'object' ? ns.secrets : {};
  const customApiPresetKeys: Record<string, string> = {
    ...(explicit.customApiPresetKeys && typeof explicit.customApiPresetKeys === 'object'
      ? explicit.customApiPresetKeys
      : {}),
  };
  const sceneApiPresetKeys: Record<string, string> = {
    ...(explicit.sceneApiPresetKeys && typeof explicit.sceneApiPresetKeys === 'object'
      ? explicit.sceneApiPresetKeys
      : {}),
  };
  const sceneApiPresetSensitive: ProtectedConfigSecrets['sceneApiPresetSensitive'] = {
    ...(explicit.sceneApiPresetSensitive && typeof explicit.sceneApiPresetSensitive === 'object'
      ? explicit.sceneApiPresetSensitive
      : {}),
  };
  const rawImgKeys = explicit.imageProviderKeys && typeof explicit.imageProviderKeys === 'object'
    ? explicit.imageProviderKeys as Record<string, unknown>
    : {};
  return {
    customApiKey: typeof explicit.customApiKey === 'string' ? explicit.customApiKey : '',
    customApiPresetKeys,
    sceneApiPresetKeys,
    sceneApiPresetSensitive,
    imageProviderKeys: {
      novelai: typeof rawImgKeys.novelai === 'string' ? rawImgKeys.novelai : '',
      openai: typeof rawImgKeys.openai === 'string' ? rawImgKeys.openai : '',
    },
  };
}

function _writeProtectedConfigSecrets(config: Partial<StatusBarConfig>): void {
  const ns = _getTavernSettingsNS();
  if (!ns) return;
  const next = _readProtectedConfigSecrets();
  if (Object.prototype.hasOwnProperty.call(config, 'customApiKey')) {
    next.customApiKey = typeof config.customApiKey === 'string' ? config.customApiKey : '';
  }
  if (Array.isArray(config.customApiPresets)) {
    next.customApiPresetKeys = Object.fromEntries(
      config.customApiPresets
        .filter(preset => preset && typeof preset.id === 'string')
        .map(preset => [preset.id, typeof preset.key === 'string' ? preset.key : '']),
    );
  }
  if (Array.isArray(config.sceneApiPresets)) {
    next.sceneApiPresetKeys = Object.fromEntries(
      config.sceneApiPresets
        .filter(preset => preset && typeof preset.id === 'string')
        .map(preset => [preset.id, typeof preset.key === 'string' ? preset.key : '']),
    );
    next.sceneApiPresetSensitive = Object.fromEntries(
      config.sceneApiPresets
        .filter(preset => preset && typeof preset.id === 'string')
        .map(preset => [preset.id, {
          key: typeof preset.key === 'string' ? preset.key : '',
          customHeaders: typeof preset.customHeaders === 'string' ? preset.customHeaders : '',
          bodyParams: typeof preset.bodyParams === 'string' ? preset.bodyParams : '',
        }]),
    );
  }
  // 立绘/图源 API key：从 imageGeneration.provider 或 legacy portraitImageGen 提取 novelai/openai key
  if (config.imageGeneration || config.portraitImageGen) {
    let novelai = next.imageProviderKeys.novelai;
    let openai = next.imageProviderKeys.openai;
    if (config.imageGeneration) {
      const p = (config.imageGeneration as ImageGenerationConfig | undefined)?.provider;
      if (p?.novelai && typeof p.novelai.key === 'string') novelai = p.novelai.key;
      if (p?.openai && typeof p.openai.key === 'string') openai = p.openai.key;
    }
    if (config.portraitImageGen) {
      const p = config.portraitImageGen as PortraitImageGen | undefined;
      if (p?.novelai && typeof p.novelai.key === 'string') novelai = p.novelai.key;
      if (p?.openai && typeof p.openai.key === 'string') openai = p.openai.key;
    }
    next.imageProviderKeys = { novelai, openai };
  }
  ns.secrets = next;
  _persistTavernSettings();
}

function _stripExternalSecrets(config: Record<string, any>): Record<string, any> {
  const next = { ...config };
  delete next.customApiKey;
  delete next.collapsed;
  delete next.playCollapsed;
  delete next.interviewSidebarOpen;
  delete next.investigationSidebarCollapsed;
  if (Array.isArray(next.customApiPresets)) {
    next.customApiPresets = next.customApiPresets.map((preset: any) => {
      const { key: _key, ...safe } = preset || {};
      return safe;
    });
  }
  if (Array.isArray(next.sceneApiPresets)) {
    next.sceneApiPresets = next.sceneApiPresets.map((preset: any) => {
      const {
        key: _key,
        customHeaders: _customHeaders,
        bodyParams: _bodyParams,
        ...safe
      } = preset || {};
      return safe;
    });
  }
  return redactExternalStorageSecrets(next) as Record<string, any>;
}

function _hydrateExternalSecrets(config: Record<string, any>): Record<string, any> {
  const secrets = _readProtectedConfigSecrets();
  const next: Record<string, any> = {
    ...config,
    customApiKey: secrets.customApiKey,
    collapsed: _readDeviceLocalConfig('collapsed', false),
    playCollapsed: _readDeviceLocalConfig('playCollapsed', false),
    interviewSidebarOpen: _readDeviceLocalConfig('interviewSidebarOpen', false),
    investigationSidebarCollapsed: _readDeviceLocalConfig('investigationSidebarCollapsed', false),
  };
  if (Array.isArray(next.customApiPresets)) {
    next.customApiPresets = next.customApiPresets.map((preset: any) => ({
      ...preset,
      key: secrets.customApiPresetKeys[String(preset?.id || '')] || '',
    }));
  }
  if (Array.isArray(next.sceneApiPresets)) {
    next.sceneApiPresets = next.sceneApiPresets.map((preset: any) => {
      const id = String(preset?.id || '');
      const sensitive = secrets.sceneApiPresetSensitive[id];
      return {
        ...preset,
        key: sensitive?.key || secrets.sceneApiPresetKeys[id] || '',
        customHeaders: sensitive?.customHeaders || '',
        bodyParams: sensitive?.bodyParams || '',
      };
    });
  }
  // 立绘/图源 API key 回填：外部偏好文件被脱敏剥离，从 secrets 影子水合到 imageGeneration.provider
  // 与 legacy portraitImageGen（两者都经 normalizeImageGenerationConfig 归一化）
  if (next.imageGeneration?.provider) {
    if (next.imageGeneration.provider.novelai) {
      next.imageGeneration.provider.novelai.key = secrets.imageProviderKeys.novelai;
    }
    if (next.imageGeneration.provider.openai) {
      next.imageGeneration.provider.openai.key = secrets.imageProviderKeys.openai;
    }
  }
  if (next.portraitImageGen) {
    if (next.portraitImageGen.novelai) next.portraitImageGen.novelai.key = secrets.imageProviderKeys.novelai;
    if (next.portraitImageGen.openai) next.portraitImageGen.openai.key = secrets.imageProviderKeys.openai;
  }
  return next;
}

// ===== 跨 bundle 配置变更事件 =====
// 外部偏好文件是唯一事实源，小手机等只读 bundle 各持独立快照；批量写入落盘成功后
// 派发本事件，通知它们重读文件（小手机侧 bindHostConfigSync 订阅，命名双方共享）。
export const STATUSBAR_CONFIG_CHANGED_EVENT = 'ub-statusbar-config-changed';

function _notifyConfigChanged(): void {
  // 状态栏自身跑在 iframe 里，小手机/台账各是独立 bundle（各自 iframe 或宿主页）。
  // 只派发到自身 window 时，另一侧 iframe 永远收不到（旧实现 ⇒ 台账必须刷新酒馆才读到新预设）。
  // 一律按 topWindowCandidates()（自身 + globalThis + parent）逐个派发；event 用目标窗口的构造器
  // 创建，避免跨 realm 的 Event 被拒。
  try {
    const candidates = topWindowCandidates();
    // 深层嵌套 iframe 时 top 可能不等于 parent：显式补一个 top 候选。
    try {
      const top = typeof window !== 'undefined' ? (window as any).top : undefined;
      if (top && candidates.indexOf(top) < 0) candidates.push(top);
    } catch (_e) { /* cross-origin */ }
    const seen = new Set<unknown>();
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      const target = candidate as unknown as { dispatchEvent?: unknown; Event?: typeof Event };
      if (typeof target.dispatchEvent !== 'function') continue;
      try {
        const Ctor = typeof target.Event === 'function' ? target.Event : Event;
        target.dispatchEvent(new Ctor(STATUSBAR_CONFIG_CHANGED_EVENT));
      } catch (_e) { /* 单个窗口失败不阻断其余候选 */ }
    }
  } catch (_e) { /* non-browser tests */ }
}

export function configureConfigStorage(
  mode: 'legacy' | 'external',
  store: ExternalObjectStore | null,
): void {
  if (_externalConfigStore && _externalConfigStore !== store
    && Object.keys(_pendingExternalConfigPatch).length) {
    void flushConfigStorage();
  }
  _configStorageMode = mode;
  _externalConfigStore = mode === 'external' ? store : null;
  _configCache = null;
}

function _queueExternalConfigPatch(patch: Record<string, unknown>): void {
  _pendingExternalConfigPatch = { ..._pendingExternalConfigPatch, ...patch };
  if (_externalConfigWriteScheduled) return;
  _externalConfigWriteScheduled = true;
  queueMicrotask(() => {
    if (!_externalConfigWriteScheduled) return;
    _externalConfigWriteScheduled = false;
    void flushConfigStorage();
  });
}

export async function flushConfigStorage(): Promise<boolean> {
  _externalConfigWriteScheduled = false;
  const store = _externalConfigStore;
  const patch = _pendingExternalConfigPatch;
  _pendingExternalConfigPatch = {};
  if (!store || !Object.keys(patch).length) {
    const ok = await _externalConfigWriteChain;
    await store?.flush();
    return ok && Object.keys(_pendingExternalConfigPatch).length === 0;
  }
  const run = async (): Promise<boolean> => {
    const ok = await store.patch(patch);
    if (!ok) {
      _pendingExternalConfigPatch = { ...patch, ..._pendingExternalConfigPatch };
      console.error('[统一状态栏] 外部偏好批量写入失败，已保留待重试');
    } else {
      _notifyConfigChanged();
    }
    return ok;
  };
  const result = _externalConfigWriteChain.then(run, run);
  _externalConfigWriteChain = result;
  const ok = await result;
  await store.flush();
  return ok;
}

export function exportExternalizableConfig(config?: StatusBarConfig): Record<string, unknown> {
  return _stripExternalSecrets((config || getConfig()) as unknown as Record<string, any>);
}

// 外部偏好文件为唯一事实源；读取外部 store + 密钥影子水合。
function _readGlobalConfig(): Record<string, any> {
  return _hydrateExternalSecrets(_externalConfigStore?.readAll() || {});
}

// ===== 配置缓存 =====
let _configCache: StatusBarConfig | null = null;

// 读取并归一化 contextStripTags：非数组→默认、元素小写去空去重
function _readContextStripTags(val: any): string[] {
  if (!Array.isArray(val)) return [...CONTEXT_STRIP_TAGS_DEFAULT];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of val) {
    const tag = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  // 若用户显式填了空数组（=[]），保留空（关闭剥离）；非数组或缺字段才回退默认
  return out;
}

// 读取并归一化 entryBlacklist：非数组→空数组、元素 trim 去空去重（保留原始大小写——正则源不做小写化）
function _readEntryBlacklist(val: any): string[] {
  if (!Array.isArray(val)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of val) {
    const pattern = String(raw == null ? '' : raw).trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

export function normalizeImageGenerationIntervalSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 45;
  return Math.max(0, Math.min(120, Math.floor(value)));
}

export function getDefaultWardrobeModelTags(): { female: string; male: string } {
  return {
    female:
      '1girl, solo, full body, standing, straight posture, slim, fair skin, average height, long brown hair, brown eyes, neutral expression, simple face, fashion model',
    male:
      '1boy, solo, full body, standing, straight posture, athletic build, fair skin, average height, short black hair, neutral expression, simple face, fashion model',
  };
}

export function normalizeWardrobeModelTags(value: unknown): { female: string; male: string } {
  const defaults = getDefaultWardrobeModelTags();
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const pick = (side: 'female' | 'male'): string => {
    const candidate = raw[side];
    return typeof candidate === 'string' && candidate.trim()
      ? candidate.trim().slice(0, 500)
      : defaults[side];
  };
  return { female: pick('female'), male: pick('male') };
}

/** 归一化小助手悬浮球位置：非对象→默认；各轴非有限数→该轴默认；有限值钳制到视口安全范围 [0, 400] 像素。 */
function _normalizeAssistantFloatPosition(val: unknown): { right: number; bottom: number } {
  const defaultPos = DEFAULT_CONFIG.assistantFloatPosition;
  if (!val || typeof val !== 'object') return { right: defaultPos.right, bottom: defaultPos.bottom };
  const raw = val as Record<string, unknown>;
  const clamp = (v: unknown, d: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return d;
    return Math.max(0, Math.min(400, Math.round(n)));
  };
  return {
    right: clamp(raw.right, defaultPos.right),
    bottom: clamp(raw.bottom, defaultPos.bottom),
  };
}

// 读取 SceneApiPreset（仓库条目）
function _readSceneApiPreset(val: any): SceneApiPreset | null {
  if (!val || typeof val !== 'object') return null;
  const numOrUnset = (v: any, d: number | 'unset'): number | 'unset' => {
    if (v === 'unset') return 'unset';
    if (typeof v === 'number' && !isNaN(v)) return v;
    return d;
  };
  const id = typeof val.id === 'string' ? val.id : '';
  if (!id) return null;
  return {
    id,
    name: typeof val.name === 'string' ? val.name.trim() : '',
    url: typeof val.url === 'string' ? val.url.trim() : '',
    model: typeof val.model === 'string' ? val.model.trim() : '',
    key: typeof val.key === 'string' ? val.key.trim() : '',
    secretId: typeof val.secretId === 'string' ? val.secretId.trim() : '',
    secretLabel: typeof val.secretLabel === 'string' ? val.secretLabel.trim() : '',
    maxTokens: numOrUnset(val.maxTokens, 'unset'),
    temperature: numOrUnset(val.temperature, 'unset'),
    topP: numOrUnset(val.topP, 'unset'),
    topK: numOrUnset(val.topK, 'unset'),
    frequencyPenalty: numOrUnset(val.frequencyPenalty, 'unset'),
    presencePenalty: numOrUnset(val.presencePenalty, 'unset'),
    bodyParams: typeof val.bodyParams === 'string' ? val.bodyParams : '',
    excludeBodyParams: typeof val.excludeBodyParams === 'string' ? val.excludeBodyParams : '',
    customHeaders: typeof val.customHeaders === 'string' ? val.customHeaders : '',
    promptPostProcessing: normalizePromptPostProcessing(val.promptPostProcessing),
    createdAt: typeof val.createdAt === 'number' ? val.createdAt : Date.now(),
  };
}

// 读取 sceneApiPresets 数组（仓库）
function _readSceneApiPresets(val: any): SceneApiPreset[] {
  if (!Array.isArray(val)) return [];
  const result: SceneApiPreset[] = [];
  for (const item of val) {
    const p = _readSceneApiPreset(item);
    if (p) result.push(p);
  }
  return result;
}

/**
 * 破限槽位读取（破限头 / 尾部破限同构）：新字段存在即按新结构归一（core/jailbreak-presets 唯一校验源）；
 * 字段缺失＝首次升级到本版本，按旧「基础破限」字段迁移——旧 custom + 非空文本 ⇒ 自定义单段 system
 * （内容逐字保留），旧 custom + 空文本 ⇒ 默认（与旧版「留空回退内置」语义一致）。迁移只在读取侧发生、
 * 不主动回写；用户此后一旦改动（写入 jailbreakHead/jailbreakTail）即不再回看旧字段。
 */
function _readJailbreakSlot(raw: any, legacyMode?: unknown, legacyText?: unknown): JailbreakSlotState {
  if (raw === undefined || raw === null) {
    if (legacyMode === 'custom' && typeof legacyText === 'string' && legacyText.trim() !== '') {
      return {
        mode: 'custom',
        segments: [{ role: 'system', text: legacyText }],
        presetId: '',
        presets: [],
      };
    }
    return createJailbreakSlotState();
  }
  return normalizeJailbreakSlotState(raw);
}

// 读取 SceneProfile 子对象
function _readSceneProfile(val: any): SceneProfile {
  if (!val || typeof val !== 'object') return { ...SCENE_PROFILE_DEFAULT };
  return {
    promptPresetName: typeof val.promptPresetName === 'string' ? val.promptPresetName : '',
    apiPresetId: typeof val.apiPresetId === 'string' ? val.apiPresetId : '',
    switchRegex: val.switchRegex === true,
    regexPresetId: typeof val.regexPresetId === 'string' ? val.regexPresetId : '',
  };
}

const PORTRAIT_PRESET_VALUES = new Set(['default', 'avatar', 'halfbody', 'fullbody']);
const PORTRAIT_THEME_VALUES = new Set(['default', 'cinematic', 'allure', 'nsfw', 'emotion', 'fashion']);
const PORTRAIT_ORIENTATION_VALUES = new Set<PortraitSizeOrientation>(['portrait', 'landscape', 'square']);

/** 归一化立绘生成偏好：任一字段非法或缺字段返回 undefined（不写空对象）。合法值集合写死避免运行时模块依赖。 */
function normalizePortraitGenPreference(raw: unknown): PortraitGenPreference | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const preset = typeof c.preset === 'string' ? c.preset : '';
  const theme = typeof c.theme === 'string' ? c.theme : '';
  const sizeOrientation = typeof c.sizeOrientation === 'string' ? c.sizeOrientation : '';
  if (!PORTRAIT_PRESET_VALUES.has(preset) || !PORTRAIT_THEME_VALUES.has(theme) || !PORTRAIT_ORIENTATION_VALUES.has(sizeOrientation as PortraitSizeOrientation)) return undefined;
  return {
    preset: preset as PortraitGenPreference['preset'],
    theme: theme as PortraitGenPreference['theme'],
    includeStatus: c.includeStatus === true,
    includeEmotion: c.includeEmotion === true,
    includeFanwork: c.includeFanwork === true,
    includeProtagonist: c.includeProtagonist === true,
    extraPrompt: typeof c.extraPrompt === 'string' ? c.extraPrompt : '',
    sizeOrientation: sizeOrientation as PortraitSizeOrientation,
  };
}

// O27：getConfig 每次调用都 {..._configCache} 浅拷贝 89 键，渲染热路径每渲染 15-25 次全是分配churn。
// 改为按修订令牌摊销：配置未变期间返回同一份拷贝（零分配）。
// 调用方契约（O27 落地时全仓库审计过：0 处直接赋值、0 处别名后顶层赋值；嵌套对象本就跨调用共享）：
// 不得改写 getConfig() 返回值的顶层字段——写入一律走 setConfig（不写不落盘）。
let _configRev = 0;
let _configCopy: StatusBarConfig | null = null;
let _configCopyRev = -1;

export function getConfig(): StatusBarConfig {
  if (_configCache) {
    if (_configCopy && _configCopyRev === _configRev) return _configCopy;
    _configCopy = { ..._configCache };
    _configCopyRev = _configRev;
    return _configCopy;
  }

  const cfg = _readGlobalConfig();
  const imageGeneration = normalizeImageGenerationConfig(cfg.imageGeneration, cfg);
  const characterWorldbookTemplates = normalizeCharacterWorldbookTemplateLibrary({
    templates: cfg.characterWorldbookTemplates,
    activeCreateTemplateId: cfg.characterWorldbookCreateTemplateId,
  });

  _configCache = {
    style: normalizeStyle(cfg.style),
    literaryScheme: cfg.style === 'xianxia' ? 'xianxia'
      : cfg.style === 'ancient' ? 'ancient'
      : (cfg.literaryScheme === 'xianxia' ? 'xianxia' : 'ancient'),
    collapsed: cfg.collapsed === true,
    playCollapsed: cfg.playCollapsed === true,
    darkTheme: cfg.darkTheme === true,
    panelColorMode: cfg.panelColorMode === 'tavern' ? 'tavern' : 'plugin',
    nsfwPlayEnabled: cfg.nsfwPlayEnabled !== false,
    nsfwPlayAutoClear: cfg.nsfwPlayAutoClear === true,
    nsfwPlayWorldbookPosition: (function() {
      const v = cfg.nsfwPlayWorldbookPosition;
      const valid = ['at_depth', 'before_character_definition', 'after_character_definition', 'before_author_note', 'after_author_note'];
      return typeof v === 'string' && valid.includes(v) ? v as StatusBarConfig['nsfwPlayWorldbookPosition'] : 'at_depth';
    })(),
    nsfwPlayWorldbookDepth: typeof cfg.nsfwPlayWorldbookDepth === 'number' && Number.isFinite(cfg.nsfwPlayWorldbookDepth) && cfg.nsfwPlayWorldbookDepth >= 0
      ? Math.min(99, Math.floor(cfg.nsfwPlayWorldbookDepth)) // W3：与设置页 UI 上限 0-99 对齐，越界值不再穿透归一化
      : 0,
    nsfwPlayMaxSelected: typeof cfg.nsfwPlayMaxSelected === 'number' && Number.isFinite(cfg.nsfwPlayMaxSelected)
      ? Math.max(1, Math.min(10, Math.floor(cfg.nsfwPlayMaxSelected)))
      : 5,
    // unknown 透传：归一化在 core/play-library.ts（消费侧收敛，杜绝 config-store 反向依赖/模块环）
    nsfwPlayLibrary: (cfg.nsfwPlayLibrary === undefined ? null : cfg.nsfwPlayLibrary) as unknown,
    nsfwGuidanceContextCount: typeof cfg.nsfwGuidanceContextCount === 'number'
      ? Math.max(1, Math.min(20, Math.floor(cfg.nsfwGuidanceContextCount)))
      : NSFW_GUIDANCE_DEFAULT_CONTEXT_COUNT,
    nsfwGuidanceMaxChars: typeof cfg.nsfwGuidanceMaxChars === 'number' && Number.isFinite(cfg.nsfwGuidanceMaxChars) && cfg.nsfwGuidanceMaxChars > 0
      ? Math.floor(cfg.nsfwGuidanceMaxChars)
      : NSFW_GUIDANCE_DEFAULT_MAX_CHARS,
    nsfwGuidanceMaxWorldbookEntries: typeof cfg.nsfwGuidanceMaxWorldbookEntries === 'number'
      ? Math.max(1, Math.min(NSFW_GUIDANCE_MAX_WORLD_BOOK_ENTRIES, Math.floor(cfg.nsfwGuidanceMaxWorldbookEntries)))
      : NSFW_GUIDANCE_DEFAULT_MAX_WORLD_BOOK_ENTRIES,
    showFloatingBtn: cfg.showFloatingBtn === true,
    showHelpTips: cfg.showHelpTips !== false,
    dsCacheOptimize: cfg.dsCacheOptimize === true,
    storyBackupInterval: typeof cfg.storyBackupInterval === 'number' && Number.isFinite(cfg.storyBackupInterval)
      ? Math.max(1, Math.min(999, Math.floor(cfg.storyBackupInterval))) : 5,
    moveLayers: typeof cfg.moveLayers === 'number' && Number.isFinite(cfg.moveLayers)
      ? Math.max(1, Math.min(999, Math.floor(cfg.moveLayers))) : 10,
    moveChatAutoOpen: cfg.moveChatAutoOpen === true,
    shopEnabled: cfg.shopEnabled !== false,
    wardrobeEnabled: cfg.wardrobeEnabled !== false,
    charRelationWorldbook: cfg.charRelationWorldbook !== false,
    imageGenerationIntervalSeconds: imageGeneration.intervalSeconds,
    imageGeneration,
    wardrobeModelTags: normalizeWardrobeModelTags(cfg.wardrobeModelTags),
    shopStoryContextCount: typeof cfg.shopStoryContextCount === 'number' ? cfg.shopStoryContextCount : SHOP_STORY_DEFAULT_CONTEXT_COUNT,
    shopStoryApiPresetId: typeof cfg.shopStoryApiPresetId === 'string' ? cfg.shopStoryApiPresetId : '',
    investigationEnabled: cfg.investigationEnabled !== false,
    interviewEnabled: cfg.interviewEnabled !== false,
    interviewReadDossier: cfg.interviewReadDossier !== false,
    investigationContextCount: typeof cfg.investigationContextCount === 'number' ? cfg.investigationContextCount : INVESTIGATION_DEFAULT_CONTEXT_COUNT,
    investigationMaxSummaryCount: typeof cfg.investigationMaxSummaryCount === 'number' ? cfg.investigationMaxSummaryCount : INVESTIGATION_DEFAULT_MAX_SUMMARY_COUNT,
    investigationFontScale: _normFontScale(cfg.investigationFontScale),
    interviewFontScale: _normFontScale(cfg.interviewFontScale),
    interviewSidebarOpen: cfg.interviewSidebarOpen === true,
    investigationSidebarCollapsed: cfg.investigationSidebarCollapsed === true,
    timeAnchorEnabled: cfg.timeAnchorEnabled === true,
    refillModeEnabled: cfg.refillModeEnabled === true,
    optionsBarEnabled: cfg.optionsBarEnabled !== false,
    optionsBarSendMode: (cfg.optionsBarSendMode as 'send' | 'fill') || 'fill',
    optionsBarFollowBottom: cfg.optionsBarFollowBottom === true,
    calendarEnabled: cfg.calendarEnabled !== false,
    calendarAutoDaily: cfg.calendarAutoDaily === true,
    calendarContextCount: typeof cfg.calendarContextCount === 'number' ? cfg.calendarContextCount : CALENDAR_DEFAULT_CONTEXT_COUNT,
    calendarBirthdayEnabled: cfg.calendarBirthdayEnabled !== false,
    // ===== 世界演化窗口 =====
    worldEnabled: cfg.worldEnabled !== false,
    worldAutoUpdate: cfg.worldAutoUpdate !== false,
    worldPhoneLink: cfg.worldPhoneLink === true,
    worldEvolveEveryTurns: typeof cfg.worldEvolveEveryTurns === 'number' && cfg.worldEvolveEveryTurns > 0 ? Math.min(20, Math.floor(cfg.worldEvolveEveryTurns)) : WORLD_DEFAULT_EVERY_TURNS,
    worldFocusMax: typeof cfg.worldFocusMax === 'number' && cfg.worldFocusMax > 0 ? Math.min(30, Math.max(3, Math.floor(cfg.worldFocusMax))) : WORLD_DEFAULT_FOCUS_MAX,
    worldRotationBatch: typeof cfg.worldRotationBatch === 'number' && cfg.worldRotationBatch > 0 ? Math.min(20, Math.floor(cfg.worldRotationBatch)) : WORLD_DEFAULT_ROTATION_BATCH,
    worldWbBlueMax: typeof cfg.worldWbBlueMax === 'number' && cfg.worldWbBlueMax > 0 ? Math.min(100, Math.floor(cfg.worldWbBlueMax)) : WORLD_DEFAULT_WB_BLUE,
    worldWbGreenMax: typeof cfg.worldWbGreenMax === 'number' && cfg.worldWbGreenMax > 0 ? Math.min(60, Math.floor(cfg.worldWbGreenMax)) : WORLD_DEFAULT_WB_GREEN,
    worldContextCount: typeof cfg.worldContextCount === 'number' && cfg.worldContextCount > 0 ? Math.min(30, Math.max(1, Math.floor(cfg.worldContextCount))) : WORLD_DEFAULT_CONTEXT_COUNT,
    worldChronicleTotal: typeof cfg.worldChronicleTotal === 'number' && cfg.worldChronicleTotal > 0 ? Math.min(100, Math.max(10, Math.floor(cfg.worldChronicleTotal))) : WORLD_DEFAULT_CHRONICLE_TOTAL,
    worldEvolveMinReply: typeof cfg.worldEvolveMinReply === 'number' && cfg.worldEvolveMinReply > 0 ? Math.min(2000, Math.floor(cfg.worldEvolveMinReply)) : WORLD_DEFAULT_MIN_REPLY,
    worldEvolveStyle: (function(): StatusBarConfig['worldEvolveStyle'] {
      const v = cfg.worldEvolveStyle;
      if (v === 'sweet' || v === 'intrigue' || v === 'surprise' || v === 'custom') return v;
      // 自定义风格条目选择值 custom:<id>：只做形态校验，条目是否存在由读数侧（world-style-library）判定
      if (typeof v === 'string' && v.slice(0, 7) === 'custom:' && v.length > 7) return v as StatusBarConfig['worldEvolveStyle'];
      return WORLD_DEFAULT_EVOLVE_STYLE;
    })(),
    worldEvolveStyleCustom: typeof cfg.worldEvolveStyleCustom === 'string' ? cfg.worldEvolveStyleCustom : WORLD_DEFAULT_EVOLVE_STYLE_CUSTOM,
    // 风格库结构（含坏项过滤/裁长/上限）由 core/world-engine/world-style-library 归一化，此处只保留原样
    worldEvolveStyleLibrary: cfg.worldEvolveStyleLibrary == null ? WORLD_DEFAULT_EVOLVE_STYLE_LIBRARY : cfg.worldEvolveStyleLibrary,
    // ===== 正文插图（自动文生图）=====
    storyImageEnabled: cfg.storyImageEnabled === true,
    // ===== 货币系统 =====
    currencyEnabled: cfg.currencyEnabled !== false,
    storyImage: normalizeStoryImageConfig(cfg.storyImage),
    // ===== 月信与孕育系统 =====
    cycleMode: (cfg.cycleMode === 'period' || cfg.cycleMode === 'full') ? cfg.cycleMode : 'off',
    cycleWorldbookPeriod: cfg.cycleWorldbookPeriod !== false,
    cycleWorldbookPregnancy: cfg.cycleWorldbookPregnancy !== false,
    cycleSexFormPrompt: (function(): 'always_ask' | 'assume_unprotected' | 'assume_withdrawal' | 'assume_protected' {
      const v = cfg.cycleSexFormPrompt;
      if (v === 'assume_unprotected' || v === 'assume_withdrawal' || v === 'assume_protected') return v;
      return 'always_ask';
    })(),
    cycleShowBar: cfg.cycleShowBar !== false,
    // ===== 地图生成功能 =====
    mapEnabled: cfg.mapEnabled !== false,
    mapContextCount: typeof cfg.mapContextCount === 'number' && cfg.mapContextCount > 0 ? Math.floor(cfg.mapContextCount) : MAP_DEFAULT_CONTEXT_COUNT,
    mapMaxEntries: typeof cfg.mapMaxEntries === 'number' && cfg.mapMaxEntries > 0 ? Math.floor(cfg.mapMaxEntries) : MAP_DEFAULT_MAX_ENTRIES,
    skillEnabled: cfg.skillEnabled === true,
    skillContextCount: typeof cfg.skillContextCount === 'number' && cfg.skillContextCount > 0 ? Math.min(20, Math.max(1, Math.floor(cfg.skillContextCount))) : SKILL_DEFAULT_CONTEXT_COUNT,
    skillMaxWorldbookEntries: typeof cfg.skillMaxWorldbookEntries === 'number' && cfg.skillMaxWorldbookEntries > 0 ? Math.min(50, Math.max(1, Math.floor(cfg.skillMaxWorldbookEntries))) : SKILL_DEFAULT_MAX_WB_ENTRIES,
    mapAutoUpdateMode: (() => {
      const legacySmart = cfg.mapAutoUpdateMode === 'smart';
      const validModes = ['off', 'new-location', 'location-change', 'every-turn'];
      if (typeof cfg.mapAutoUpdateMode === 'string' && validModes.includes(cfg.mapAutoUpdateMode)) {
        return cfg.mapAutoUpdateMode as 'off' | 'new-location' | 'location-change' | 'every-turn';
      }
      // 旧「智能更新」= 新图全自动、旧图每轮只刷记录；迁移为每轮更新 + 关闭重绘。
      return legacySmart ? 'every-turn' : 'off';
    })(),
    mapAutoRedraw: typeof cfg.mapAutoRedraw === 'boolean' ? cfg.mapAutoRedraw : cfg.mapAutoUpdateMode !== 'smart',
    mapLocationConflictStrategy: (() => {
      const value = cfg.mapLocationConflictStrategy;
      if (value === 'prefer-existing' || value === 'prefer-current') return value;
      return 'always-ask';
    })(),
    mapAutoGenSceneImage: cfg.mapAutoGenSceneImage === true,
    mapExcludePattern: typeof cfg.mapExcludePattern === 'string' ? cfg.mapExcludePattern : '客厅、餐厅、厨房、洗手间、卧室',
    // ===== 立绘功能 =====
    portraitEnabled: cfg.portraitEnabled === true,
    portraitProtagonistEnabled: cfg.portraitProtagonistEnabled === true,
    portraitAutoUpdateMode: (() => {
      const v = cfg.portraitAutoUpdateMode;
      if (v === 'missing-only' || v === 'every-turn') return v;
      // 迁移：旧布尔 true → missing-only
      if (cfg.portraitAutoGenerateMissing === true) return 'missing-only';
      return 'off';
    })(),
    portraitAutoAddToRandomPool: cfg.portraitAutoAddToRandomPool === true,
    portraitRandomFilter: {
      byEmotion: cfg.portraitRandomFilter?.byEmotion === true,
      byNsfw: cfg.portraitRandomFilter?.byNsfw === true,
    },
    portraitContextCount: typeof cfg.portraitContextCount === 'number' && cfg.portraitContextCount > 0 ? Math.floor(cfg.portraitContextCount) : PORTRAIT_DEFAULT_CONTEXT_COUNT,
    portraitGenPreference: normalizePortraitGenPreference(cfg.portraitGenPreference),
    portraitImageGen: imageGeneration.provider,
    collapseBtnStyle: (function(): CollapseBtnStyle {
      const v = cfg.collapseBtnStyle;
      const valid: CollapseBtnStyle[] = ['minimal', 'time-window', 'time-window-menu', 'menu'];
      if (v && valid.includes(v as CollapseBtnStyle)) return v as CollapseBtnStyle;
      return DEFAULT_CONFIG.collapseBtnStyle;
    })(),
    positionMode: (function(): PositionMode {
      const v = cfg.positionMode;
      const valid: PositionMode[] = ['fixed-top', 'fixed-bottom', 'follow-bottom'];
      if (v && valid.includes(v as PositionMode)) return v as PositionMode;
      return DEFAULT_CONFIG.positionMode;
    })(),
    widthMode: (function(): WidthMode {
      const v = cfg.widthMode;
      return (v as WidthMode) || DEFAULT_CONFIG.widthMode;
    })(),
    customWidthPercent: typeof cfg.customWidthPercent === 'number' ? Math.min(100, Math.max(CUSTOM_SIZE_PERCENT_MIN, cfg.customWidthPercent)) : DEFAULT_CONFIG.customWidthPercent,
    customHeightPercent: typeof cfg.customHeightPercent === 'number' ? Math.min(100, Math.max(CUSTOM_SIZE_PERCENT_MIN, cfg.customHeightPercent)) : DEFAULT_CONFIG.customHeightPercent,
    statusbarContentFontScale: normalizeStatusbarContentFontScale(cfg.statusbarContentFontScale),
    popupSettingsFontScale: normalizeUiFontScale(cfg.popupSettingsFontScale),
    apiMode: (cfg.apiMode === 'custom' ? 'custom' : cfg.apiMode === 'per-feature' ? 'per-feature' : 'tavern') as ApiMode,
    customApiKey: typeof cfg.customApiKey === 'string' ? cfg.customApiKey : '',
    customApiPresets: Array.isArray(cfg.customApiPresets) ? cfg.customApiPresets : [],
    activeApiPresetId: typeof cfg.activeApiPresetId === 'string' ? cfg.activeApiPresetId : '',
    investigationApiPresetId: typeof cfg.investigationApiPresetId === 'string' ? cfg.investigationApiPresetId : '',
    calendarApiPresetId: typeof cfg.calendarApiPresetId === 'string' ? cfg.calendarApiPresetId : '',
    mapApiPresetId: typeof cfg.mapApiPresetId === 'string' ? cfg.mapApiPresetId : '',
    skillApiPresetId: typeof cfg.skillApiPresetId === 'string' ? cfg.skillApiPresetId : '',
    portraitApiPresetId: imageGeneration.imagePromptApiPresetId,
    nsfwGuidanceApiPresetId: typeof cfg.nsfwGuidanceApiPresetId === 'string' ? cfg.nsfwGuidanceApiPresetId : '',
    chronicleMergeApiPresetId: typeof cfg.chronicleMergeApiPresetId === 'string' ? cfg.chronicleMergeApiPresetId : '',
    characterWorldbookApiPresetId: typeof cfg.characterWorldbookApiPresetId === 'string' ? cfg.characterWorldbookApiPresetId : '',
    worldApiPresetId: typeof cfg.worldApiPresetId === 'string' ? cfg.worldApiPresetId : '',
    aiRetryEnabled: cfg.aiRetryEnabled === true,
    aiRetryMax: normalizeAiRetryMax(cfg.aiRetryMax),
    aiRetryScopes: normalizeAiRetryScopes(cfg.aiRetryScopes),
    characterWorldbookTemplates: characterWorldbookTemplates.templates,
    characterWorldbookCreateTemplateId: characterWorldbookTemplates.activeCreateTemplateId,
    characterWorldbookTraitPools: normalizeTraitPoolState(cfg.characterWorldbookTraitPools),
    characterWorldbookPendingEncounters: (function(): Record<string, string[]> {
      const v = cfg.characterWorldbookPendingEncounters;
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string[]> : {};
    })(),
    wardrobeExtractApiPresetId: typeof cfg.wardrobeExtractApiPresetId === 'string' ? cfg.wardrobeExtractApiPresetId : '',
    jailbreakHead: _readJailbreakSlot(cfg.jailbreakHead, cfg.jailbreakMode, cfg.jailbreakText),
    jailbreakTail: _readJailbreakSlot(cfg.jailbreakTail),
    antiClicheMode: cfg.antiClicheMode === 'custom' ? 'custom' : 'default',
    antiClicheText: typeof cfg.antiClicheText === 'string' ? cfg.antiClicheText : '',
    dbViewerEnabled: cfg.dbViewerEnabled !== false,
    sceneSwitchEnabled: cfg.sceneSwitchEnabled === true,
    sceneSwitchCurrent: (cfg.sceneSwitchCurrent === 'daily' || cfg.sceneSwitchCurrent === 'nsfw') ? cfg.sceneSwitchCurrent : '',
    sceneApiPresets: _readSceneApiPresets(cfg.sceneApiPresets),
    sceneDailyProfile: _readSceneProfile(cfg.sceneDailyProfile),
    sceneNsfwProfile: _readSceneProfile(cfg.sceneNsfwProfile),
    achievementEnabled: cfg.achievementEnabled !== false,
    achievementNotifyEnabled: cfg.achievementNotifyEnabled !== false,
    notifyAlign: (cfg.notifyAlign === 'left' || cfg.notifyAlign === 'right') ? cfg.notifyAlign : 'center',
    notifyEffect: (cfg.notifyEffect === 'porcelain' || cfg.notifyEffect === 'inkglass' || cfg.notifyEffect === 'auto' || cfg.notifyEffect === 'original')
      ? cfg.notifyEffect
      : 'auto', // 含旧值 beautified → auto
    aiNoticePersist: cfg.aiNoticePersist === true,
    contextStripTags: _readContextStripTags(cfg.contextStripTags),
    entryBlacklist: _readEntryBlacklist(cfg.entryBlacklist),
    tableGroupMode: cfg.tableGroupMode === 'grouped' ? 'grouped' : 'flat',
    itemUseEnabled: cfg.itemUseEnabled === true,
    gachaSelectedPoolIds: Array.isArray(cfg.gachaSelectedPoolIds)
      ? cfg.gachaSelectedPoolIds.filter((id: unknown): id is string => typeof id === 'string')
      : null,
    // ===== 宅仙只读 AI 小助手 =====
    assistantEnabled: cfg.assistantEnabled === true,
    assistantFloatPosition: _normalizeAssistantFloatPosition(cfg.assistantFloatPosition),
    assistantApiPresetId: typeof cfg.assistantApiPresetId === 'string' ? cfg.assistantApiPresetId : '',
    assistantStreaming: cfg.assistantStreaming !== false,
    assistantContextDepth: Number.isFinite(Number(cfg.assistantContextDepth))
      ? Math.max(1, Math.min(50, Math.floor(Number(cfg.assistantContextDepth))))
      : 10,
    assistantPersonaMode: cfg.assistantPersonaMode === 'custom' ? 'custom' : 'default',
    assistantPersonaText: typeof cfg.assistantPersonaText === 'string' ? cfg.assistantPersonaText : '',
  };

  _configRev++;
  _configCopy = { ..._configCache };
  _configCopyRev = _configRev;
  return _configCopy;
}

export function setConfig<K extends keyof StatusBarConfig>(key: K, value: StatusBarConfig[K]): void {
  if (!_configCache) getConfig();
  // 备份快照间隔在写入时即归一化（与 getConfig 读取侧 clamp 一致），
  // 保证后续 getConfig() 读到的是钳制后的合法值。
  if (key === 'storyBackupInterval') {
    value = Math.max(1, Math.min(999, Math.floor(Number(value)))) as StatusBarConfig[K];
  }
  if (key === 'moveLayers') {
    value = Math.max(1, Math.min(999, Math.floor(Number(value)))) as StatusBarConfig[K];
  }
  if (key === 'assistantContextDepth') {
    value = Math.max(1, Math.min(50, Math.floor(Number(value)))) as StatusBarConfig[K];
  }
  _configCache![key] = value;
  // O27 不变量：任何对 _configCache 的就地改写都必须推进 _configRev，否则摊销拷贝会读到旧值。
  _configRev++;

  if (_configStorageMode === 'external' && _externalConfigStore) {
    if (DEVICE_LOCAL_CONFIG_KEYS.has(key)) {
      _writeDeviceLocalConfig(key, value);
      return;
    }
    if (key === 'customApiKey' || key === 'customApiPresets' || key === 'sceneApiPresets'
      || key === 'imageGeneration' || key === 'portraitImageGen') {
      _writeProtectedConfigSecrets({ [key]: value } as Partial<StatusBarConfig>);
    }
    if (key !== 'customApiKey') {
      // undefined 值序列化为 JSON 会被丢弃（文件保留旧值，清除不落盘）→ 写 null 代替；
      // 读取侧 normalize 各可选字段均把 null 归一化为 undefined。
      const safe = value === undefined
        ? { [key]: null } as Record<string, unknown>
        : _stripExternalSecrets({ [key]: value });
      _queueExternalConfigPatch(safe);
    }
    return;
  }
}

export function invalidateConfigCache(): void {
  _configCache = null;
}

// ===== 通用 localStorage 工具（供 index.ts 中非配置类临时状态使用） =====
export function _lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}

export function _lsSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
}
