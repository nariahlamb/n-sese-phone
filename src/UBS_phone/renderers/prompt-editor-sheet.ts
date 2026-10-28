// ===== 标准化提示词编辑模块（设置 → 功能 → 提示词编辑）=====
// 一个模块承载多个「领域」（社媒 / 生图），每个领域 = 若干「页签 × 单元」：
//   · 文本单元（kind:'text'）= 一整段可自由编辑的提示词；可带 {{占位符}} 快捷插入与保存校验。
//   · 条目单元（kind:'items'）= 结构化列表（社媒选题池：题材名 + 写作指导，可增删改）。
// 领域只声明语义（轴/页签/单元/落盘），交互机制全部由本文件统一实现（插入光标纪律/撤销栈/
// 滚动保位/自动落盘/两步确认），新增提示词领域只加一个 PromptEditorDomain 工厂即可。
//
// ── 契约保护（用户改动碰不到结构化内容）──
//   · 社媒：解析器依赖的 {{输出格式}} 固定契约段不在编辑区（拆到 EDITABLE_DEFAULTS 之外的 FORMAT_BLOCKS），
//     渲染时永远注入内置那段、用户只能挪位置；保存强制校验占位存在（缺则拦下并提示）。
//   · 生图：单元只承载「怎么写」（场景增补/位置网格/要求提示词…）；输出结构契约、同人规则段、
//     完整示例、角色资料节与输入块标题都是 core/chat-image-prompts 的独立常量，用户文本顶不掉。
//   · 两域共通：覆盖表与内置默认一致 = 删键（不占存储）；未知键天然回落默认。
//
// ── 交互纪律（沿用社媒编辑器四条报障修复，逐条保留）──
//  ① 占位符 chip 的 mousedown 一律 preventDefault → 编辑框不失焦、selection 原样保留
//     （部分浏览器/移动端失焦会把 selection 重置到末尾 → 会插到文本最下面）；
//  ② 插入走 document.execCommand('insertText') → 进原生撤销栈（Ctrl+Z 可撤；赋值法会清空撤销栈）；
//  ③ 插入点优先取「光标记忆」（只在用户真实交互事件上记录）；
//  ④ 同视图重绘保 .ubp-socp-body 滚动位置（重绘换容器 scrollTop 归零）；新增条目后聚焦并滚进视野。
// 编辑中不重绘（input 不触发 render）；切换领域/页签/选择或关窗时，未保存改动先自动落盘（无效改动拦住并提示）。

import { getPhoneSettings, savePhoneSettings, type PhoneSocialTheme } from '../core/phone-settings';
import { getConfig } from '../core/host-config';
import { withPromptOverride, withoutPromptOverride } from '../core/prompt-overrides';
import {
  FORMAT_TOKEN,
  SOCIAL_BRANCH_LABELS,
  SOCIAL_PROMPT_TOKENS,
  SOCIAL_STYLE_KEYS,
  SOCIAL_STYLE_LABELS,
  socialPromptEditableDefault,
  socialPromptKey,
  socialStyleOf,
  socialThemeKey,
  type SocialBranchKey,
  type SocialKindKey,
  type SocialStyleKey,
} from '../core/social-prompt-templates';
import { socialThemesOf } from '../core/social-prompts';
import {
  NIGHT_BOARDS,
  NIGHT_MODES,
  NIGHT_MODE_GROUPS,
  NIGHT_MODE_LABELS,
  nightBoardDef,
  type NightMode,
} from '../core/night-config';
import {
  NIGHT_RULES_KEY,
  nightBoardPromptKey,
  nightModePromptKey,
  nightPromptDefault,
  nightPromptTokensOf,
  validateNightPromptText,
} from '../core/night-prompt-slots';
import {
  IMAGE_PROMPT_RETIRED_KEYS,
  IMAGE_SCENE_KEYS,
  IMAGE_SCENE_LABELS,
  imagePromptKey,
  imageSlotDefault,
  imageSlotOf,
  imageSlotsOfScene,
  validateImageSlotText,
  type PhoneImagePromptSlot,
  type PhoneImageSceneKey,
  type PhoneImageSlotKey,
} from '../core/image-prompt-slots';
import { appDisplayName, S } from '../core/skins';
import { phoneNotify } from '../core/host-env';
import { escapeAttr, escapeHtml, pushSheetCloser } from './phone-ui';
import { ubpIcon } from './icons';
import { openActionSheet, openConfirmSheet } from './action-sheet';

// ─── 领域接口（新领域只实现这一层）───

export interface PromptAxisDef {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

export interface PromptItemDef {
  id: string;
  label: string;
  guide: string;
}

export interface PromptTextUnitDef {
  kind: 'text';
  key: string;
  /** 当前选择的可读面包屑（「仙侠 · 微博 · 话题页」）。 */
  title: string;
  defaultText: string;
  /** 已存覆盖（'' = 未自定义）。 */
  savedText: string;
  tokens: ReadonlyArray<{ token: string; tip: string }>;
  /** 常显说明区（受信任 HTML；**一句话**，机制细节收进 guide）。 */
  note: string;
  /** 「详细写法指南」全文（⋯ 菜单打开；不进常显区）。缺省则 ⋯ 菜单不显示该项。 */
  guide?: string;
  minHeight: number;
  /** 保存校验：返回错误文案 = 拦下（null = 通过）。 */
  validate?: (text: string) => string | null;
  /** 保存成功提示语。 */
  notifySaved: string;
}

export interface PromptItemsUnitDef {
  kind: 'items';
  key: string;
  title: string;
  /** 列表区段标题（各领域自述，引擎不解释其含义）。 */
  secLabel: string;
  defaults: PromptItemDef[];
  /** 已存条目（null = 未自定义，回落内置）。 */
  saved: PromptItemDef[] | null;
  cap: number;
  labelCap: number;
  guideCap: number;
  addLabel: string;
  labelPlaceholder: string;
  guidePlaceholder: string;
  /** 常显说明区（**一句话**）。 */
  note: string;
  /** 「详细写法指南」全文（⋯ 菜单打开）。 */
  guide?: string;
  notifySaved: string;
}

export type PromptUnitDef = PromptTextUnitDef | PromptItemsUnitDef;

export interface PromptEditorDomain {
  id: string;
  label: string;
  /** 二级 chip 行的标题（领域自述：社媒=指令、生图=槽位）。 */
  chipsLabel: string;
  /** 领域内自定义数量（「本领域全部恢复」提示用）。 */
  customCount(): number;
  axes(): ReadonlyArray<PromptAxisDef>;
  /** 首屏「平台大卡」轴（社媒=平台 / 生图=场景）：其当前值在编辑页以面包屑呈现，不再重复出选择器。
   *  缺省 = 无首屏大卡，直接进编辑页。 */
  pickAxis?(): PromptAxisDef | null;
  /** 首屏卡片「已自定义」徽标判定（按该平台/场景的覆盖情况）。 */
  isCustomized?(value: string): boolean;
  /** 轴切换（false = 非法值，忽略）。切换前由引擎先自动落盘。 */
  onAxis(axisId: string, value: string): boolean;
  chips(): ReadonlyArray<{ id: string; label: string; active: boolean }>;
  onChip(id: string): boolean;
  tabs(): ReadonlyArray<{ id: string; label: string }>;
  unit(tabId: string): PromptUnitDef;
  /** 可选：编辑页常显信息条（受信任 HTML；生图领域展示只读的全局三件套）。 */
  banner?(): string;
  /** 底部「恢复默认」按钮/确认弹窗文案（缺省＝通用文案；生图领域=「重置当前提示词」）。 */
  resetCopy?: { label: string; confirmTitle: string; confirmMessage: string; notify: string };
  /** 落盘文本单元（与内置默认一致则删键，由领域判定）。 */
  saveText(key: string, text: string): Promise<void>;
  /** 落盘条目单元（与内置默认一致则删键，由领域判定）。 */
  saveItems(key: string, items: PromptItemDef[]): Promise<void>;
  resetUnit(tabId: string): Promise<void>;
  resetAll(): Promise<void>;
}

/** 通用「恢复默认」文案（生图领域用 resetCopy 覆盖为「重置当前提示词」）。 */
const DEFAULT_RESET_COPY = {
  label: '恢复本套默认',
  confirmTitle: '恢复本套默认？',
  confirmMessage: '删除当前这一套的自定义文本，回落内置默认。',
  notify: '已恢复本套默认',
};

// ─── 社媒领域 ───

/** 平台键 → 现代默认名（风格化名走 skins.appDisplayName：仙侠=浮生帖/百晓阁/论道坛/云笈录）。 */
const KIND_LABELS: Record<SocialKindKey, string> = { moments: '朋友圈', tieba: '贴吧', weibo: '微博', xhs: '小红书' };
const KIND_KEYS: readonly SocialKindKey[] = ['moments', 'tieba', 'weibo', 'xhs'];
/** 每次刷新抽中的选题数（朋友圈/小红书 2；贴吧/微博 1）。 */
const THEME_DRAW: Record<SocialKindKey, number> = { moments: 2, xhs: 2, tieba: 1, weibo: 1 };
/** 选题条数/字段上限（与 phone-settings 归一化同口径）。 */
const THEME_ITEM_CAP = 30;
const THEME_LABEL_CAP = 40;
const THEME_GUIDE_CAP = 300;

function platformLabel(kind: SocialKindKey, styleKey: SocialStyleKey): string {
  return appDisplayName(kind, KIND_LABELS[kind], socialStyleOf(styleKey));
}

/** 选题等价比较（只比 label/guide；id 不参与——保存时判「与默认一致→删键」）。 */
function themesEqual(a: readonly PromptItemDef[], b: readonly PromptItemDef[]): boolean {
  return a.length === b.length && a.every((x, i) => x.label === b[i].label && x.guide === b[i].guide);
}

function createSocialDomain(): PromptEditorDomain {
  let styleKey: SocialStyleKey = 'modern';
  let kind: SocialKindKey = 'moments';
  let branch: SocialBranchKey = 'default';

  const branchesOf = (k: SocialKindKey): ReadonlyArray<{ id: SocialBranchKey; label: string }> => SOCIAL_BRANCH_LABELS[k];
  const promptKeyOf = (): string => socialPromptKey(kind, socialStyleOf(styleKey), branch);
  const themeKeyOf = (): string => socialThemeKey(kind, socialStyleOf(styleKey));
  const defaultThemes = (): PromptItemDef[] =>
    socialThemesOf(kind, socialStyleOf(styleKey)).map(t => ({ id: t.id, label: t.label, guide: t.guide }));
  const savedThemes = (): PromptItemDef[] | null => {
    const custom = getPhoneSettings().socialThemes[themeKeyOf()];
    return custom && custom.length ? custom.map(t => ({ id: t.id, label: t.label, guide: t.guide })) : null;
  };

  return {
    id: 'social',
    label: '社媒',
    chipsLabel: '指令',
    customCount: () => {
      const s = getPhoneSettings();
      return Object.keys(s.socialPrompts || {}).length + Object.keys(s.socialThemes || {}).length;
    },
    axes: () => [
      {
        id: 'style', label: '风格', value: styleKey,
        options: SOCIAL_STYLE_KEYS.map(k => ({ value: k, label: SOCIAL_STYLE_LABELS[k] })),
      },
      {
        id: 'kind', label: '平台', value: kind,
        options: KIND_KEYS.map(k => ({ value: k, label: platformLabel(k, styleKey) })),
      },
    ],
    // 首屏大卡=平台（编辑页以面包屑呈现，不再重复出选择器）
    pickAxis: () => ({
      id: 'kind', label: '平台', value: kind,
      options: KIND_KEYS.map(k => ({ value: k, label: platformLabel(k, styleKey) })),
    }),
    // 该平台在当前风格下是否有覆盖（指令分支任一处 or 选题池）
    isCustomized: (v) => {
      if (!(KIND_KEYS as readonly string[]).includes(v)) return false;
      const k = v as SocialKindKey;
      const style = socialStyleOf(styleKey);
      const s = getPhoneSettings();
      const themes = s.socialThemes?.[socialThemeKey(k, style)];
      if (themes && themes.length) return true;
      return branchesOf(k).some(b => Boolean(s.socialPrompts?.[socialPromptKey(k, style, b.id)]));
    },
    onAxis: (axisId, value) => {
      if (axisId === 'style') {
        if (!(SOCIAL_STYLE_KEYS as readonly string[]).includes(value)) return false;
        styleKey = value as SocialStyleKey;
        return true;
      }
      if (axisId === 'kind') {
        if (!(KIND_KEYS as readonly string[]).includes(value)) return false;
        kind = value as SocialKindKey;
        if (!branchesOf(kind).some(b => b.id === branch)) branch = branchesOf(kind)[0].id;
        return true;
      }
      return false;
    },
    chips: () => {
      const branches = branchesOf(kind);
      if (branches.length <= 1) return [];
      return branches.map(b => ({ id: b.id, label: b.label, active: b.id === branch }));
    },
    onChip: (id) => {
      if (!branchesOf(kind).some(b => b.id === id)) return false;
      branch = id as SocialBranchKey;
      return true;
    },
    tabs: () => [
      { id: 'prompt', label: '指令提示词' },
      { id: 'themes', label: '选题池' },
    ],
    unit: (tabId) => {
      if (tabId === 'themes') {
        const key = themeKeyOf();
        return {
          kind: 'items',
          key,
          title: `${SOCIAL_STYLE_LABELS[styleKey]} · ${platformLabel(kind, styleKey)}`,
          secLabel: `选题（每次刷新随机抽 ${THEME_DRAW[kind]} 个注入指令）`,
          defaults: defaultThemes(),
          saved: savedThemes(),
          cap: THEME_ITEM_CAP,
          labelCap: THEME_LABEL_CAP,
          guideCap: THEME_GUIDE_CAP,
          addLabel: '＋ 添加选题',
          labelPlaceholder: '题材名（如「破防瞬间」）',
          guidePlaceholder: '写作指导（注入指令的内容走向）',
          note: `题材名进「本次选题方向」，写作指导决定内容走向。`,
          guide: '题材名进指令的「本次选题方向」，写作指导决定内容走向；增删改后点「保存」生效；删空自动回落内置默认池。',
          notifySaved: '选题池已保存',
        };
      }
      const branches = branchesOf(kind);
      const branchLabel = (branches.find(b => b.id === branch) || branches[0]).label;
      const key = promptKeyOf();
      const defaultText = socialPromptEditableDefault(key);
      const savedText = getPhoneSettings().socialPrompts[key] || '';
      const text = savedText || defaultText;
      return {
        kind: 'text',
        key,
        title: `${SOCIAL_STYLE_LABELS[styleKey]} · ${platformLabel(kind, styleKey)} · ${branchLabel}`,
        defaultText,
        savedText,
        // 快捷 chip 只列当前模板实际用到的占位符，避免噪音
        tokens: SOCIAL_PROMPT_TOKENS.filter(t => text.includes(t.token)),
        note: `<b>${escapeHtml(FORMAT_TOKEN)}</b> 固定段不可改；其余 <b>{{…}}</b> 占位符可自由摆放。`,
        guide: `<b>${escapeHtml(FORMAT_TOKEN)}</b> 是解析器固定契约段（输出 JSON 结构），内容不可改、只能挪位置；其余 <b>{{…}}</b> 都是系统占位符，可自由摆放或删除，保存时替换成实际内容。`,
        minHeight: 300,
        validate: (value) => {
          if (!value) return `内容为空：留空等于恢复默认，请点下方「恢复本套默认」。`;
          if (!value.includes(FORMAT_TOKEN)) {
            return `缺 ${FORMAT_TOKEN} 固定契约段（解析器依赖）：用「插入占位符」补回，或点「恢复本套默认」。`;
          }
          return null;
        },
        notifySaved: '提示词已保存',
      };
    },
    saveText: async (key, text) => {
      const next = withPromptOverride(getPhoneSettings().socialPrompts, key, text, socialPromptEditableDefault(key));
      await savePhoneSettings({ socialPrompts: next });
    },
    saveItems: async (key, items) => {
      const next = { ...getPhoneSettings().socialThemes };
      if (themesEqual(items, defaultThemes())) delete next[key];
      else next[key] = items as PhoneSocialTheme[];
      await savePhoneSettings({ socialThemes: next });
    },
    resetUnit: async (tabId) => {
      if (tabId === 'themes') {
        const next = { ...getPhoneSettings().socialThemes };
        delete next[themeKeyOf()];
        await savePhoneSettings({ socialThemes: next });
        return;
      }
      await savePhoneSettings({ socialPrompts: withoutPromptOverride(getPhoneSettings().socialPrompts, promptKeyOf()) });
    },
    resetAll: async () => {
      await savePhoneSettings({ socialPrompts: {}, socialThemes: {} });
    },
  };
}

// ─── 不夜城领域 ───

/** 首屏两个全局卡片（不是生成玩法；与 NightMode 值用不同命名区分）。 */
const NIGHT_PICK_RULES = 'rules';
const NIGHT_PICK_BOARDS = 'boards';

function createNightDomain(): PromptEditorDomain {
  let target: string = 'refresh';
  let boardId: string = NIGHT_BOARDS[0].id;

  const overrides = (): Record<string, string> => getPhoneSettings().nightPrompts || {};
  const isMode = (value: string): value is NightMode => (NIGHT_MODES as readonly string[]).includes(value);
  const unitKey = (): string => {
    if (target === NIGHT_PICK_RULES) return NIGHT_RULES_KEY;
    if (target === NIGHT_PICK_BOARDS) return nightBoardPromptKey(boardId);
    return nightModePromptKey(target as NightMode);
  };
  const pickOptions = () => [
    { value: NIGHT_PICK_RULES, label: '总纪律（全模式共用）' },
    { value: NIGHT_PICK_BOARDS, label: '板块设定（6 个板块）' },
    ...NIGHT_MODE_GROUPS.flatMap(g => g.modes.map(m => ({
      value: m, label: `${g.label} · ${NIGHT_MODE_LABELS[m]}`,
    }))),
  ];

  return {
    id: 'night',
    label: '不夜城',
    chipsLabel: '板块',
    customCount: () => Object.keys(overrides()).length,
    axes: () => [],
    // 首屏大卡=玩法（含总纪律/板块设定两个全局项）；编辑页以面包屑呈现
    pickAxis: () => ({ id: 'target', label: '玩法', value: target, options: pickOptions() }),
    isCustomized: (value) => {
      if (value === NIGHT_PICK_RULES) return Boolean(overrides()[NIGHT_RULES_KEY]);
      if (value === NIGHT_PICK_BOARDS) return NIGHT_BOARDS.some(b => Boolean(overrides()[nightBoardPromptKey(b.id)]));
      return isMode(value) && Boolean(overrides()[nightModePromptKey(value)]);
    },
    onAxis: (axisId, value) => {
      if (axisId !== 'target') return false;
      if (value === NIGHT_PICK_RULES || value === NIGHT_PICK_BOARDS) {
        target = value;
        return true;
      }
      if (!isMode(value)) return false;
      target = value;
      return true;
    },
    chips: () => target === NIGHT_PICK_BOARDS
      ? NIGHT_BOARDS.map(b => ({ id: b.id, label: b.name.modern, active: b.id === boardId }))
      : [],
    onChip: (id) => {
      if (target !== NIGHT_PICK_BOARDS || !nightBoardDef(id)) return false;
      boardId = id;
      return true;
    },
    tabs: () => [{ id: 'prompt', label: '指令提示词' }],
    unit: () => {
      const key = unitKey();
      const savedText = overrides()[key] || '';
      const defaultText = nightPromptDefault(key);
      const text = savedText || defaultText;
      if (target === NIGHT_PICK_RULES) {
        return {
          kind: 'text',
          key,
          title: '总纪律（全模式共用）',
          defaultText,
          savedText,
          tokens: nightPromptTokensOf(text),
          note: '每个玩法都会注入这八条；平台头、输出格式与说人话段固定不可改。',
          guide: '总纪律（尺度一致 / 角色一致 / 档案底线 / 资料冲突 / 反全知 / 零回写 / 单次推进 / 时间）对 15 个玩法全部生效。可以改写、增删条目；编号按行自动整理。平台头与输出格式契约固定注入。',
          minHeight: 300,
          validate: validateNightPromptText,
          notifySaved: '提示词已保存',
        };
      }
      if (target === NIGHT_PICK_BOARDS) {
        const def = nightBoardDef(boardId);
        return {
          kind: 'text',
          key,
          title: `板块 · ${def?.name.modern || boardId}`,
          defaultText,
          savedText,
          tokens: nightPromptTokensOf(text),
          note: '只改内容 brief；板块名、尺度上限与图文策略固定。',
          guide: '板块设定写进资料块，brief 决定该板块的选题与写法；保存为空=回落内置默认。',
          minHeight: 300,
          validate: validateNightPromptText,
          notifySaved: '提示词已保存',
        };
      }
      const mode = target as NightMode;
      return {
        kind: 'text',
        key,
        title: `不夜城 · ${NIGHT_MODE_LABELS[mode]}`,
        defaultText,
        savedText,
        tokens: nightPromptTokensOf(text),
        note: '可改任务与规则；<b>{{…}}</b> 占位符按本次生成填充；平台头、输出格式与说人话段固定。',
        guide: '本段是「任务 + 规则」，决定该玩法的生成方向。用「插入占位符」把动态值放回文中；删除占位符等于让 AI 自行填写。平台头、【输出格式】契约与【说人话】段固定不可改；总纪律在首屏「总纪律」卡里统一编辑。',
        minHeight: 300,
        validate: validateNightPromptText,
        notifySaved: '提示词已保存',
      };
    },
    saveText: async (key, text) => {
      await savePhoneSettings({ nightPrompts: withPromptOverride(overrides(), key, text, nightPromptDefault(key)) });
    },
    saveItems: async () => { /* 不夜城领域无条目单元 */ },
    resetUnit: async () => {
      await savePhoneSettings({ nightPrompts: withoutPromptOverride(overrides(), unitKey()) });
    },
    resetAll: async () => {
      await savePhoneSettings({ nightPrompts: {} });
    },
  };
}

// ─── 生图领域 ───

/** 生图槽位的契约说明（固定不随域选择变化；告诉用户哪些内容改不到）。 */
const IMAGE_LOCK_NOTE = '本槽位只承载「怎么写」；同人规则段、完整示例、角色资料块结构与人物固定标签规则固定不可改（结构契约槽位可直接编辑，保存时校验关键内容，改坏了点「重置当前提示词」）。单人两个基底槽未本机覆盖时跟随主项目立绘同名槽。';

function createImageDomain(): PromptEditorDomain {
  let scene: PhoneImageSceneKey = 'single';
  let slot: PhoneImageSlotKey = 'tags';

  const slotsOf = (): readonly PhoneImagePromptSlot[] => imageSlotsOfScene(scene);

  return {
    id: 'image',
    label: '生图',
    // 全局三件套为只读展示：它们属于生图 AI 请求层（主项目「生图 AI 请求提示词」板块），
    // 智慧姬直连下同样生效；小手机四种模式一律跟随主项目。
    banner: () => {
      let mode = '标签';
      let fan = 'NovelAI (1.2::tag::)';
      let lang = '英文';
      try {
        const provider = (getConfig as any)().imageGeneration?.provider;
        mode = provider?.promptComposeMode === 'natural' ? '自然语言' : '标签';
        fan = provider?.fanTagTransferMode === 'anima' ? 'Anima ((tag:2))' : 'NovelAI (1.2::tag::)';
        lang = provider?.naturalPromptLanguage === 'zh' ? '中文' : '英文';
      } catch (_e) { /* 主项目配置不可读时显示默认口径 */ }
      return `<div class="ubp-socp-cur" style="margin-bottom:6px;">全局设置（三项）<span class="ubp-set-badge follow">跟随主项目</span><div class="ubp-socp-note" style="margin-top:2px;">提示词模式：<b>${mode}</b> · 同人tag传输：<b>${fan}</b> · 输出语言：<b>${lang}</b><br>五种生图模式（智慧姬 / 柏宝绘 / NAI / OpenAI 兼容 / ComfyUI）一律跟随主项目这三项；如需修改请到主项目「生图 AI 请求提示词」板块。</div></div>`;
    },
    chipsLabel: '槽位',
    customCount: () => Object.keys(getPhoneSettings().imagePrompts || {}).length,
    axes: () => [{
      id: 'scene', label: '场景', value: scene,
      options: IMAGE_SCENE_KEYS.map(k => ({ value: k, label: IMAGE_SCENE_LABELS[k] })),
    }],
    // 首屏大卡=场景（编辑页以面包屑呈现；槽位仍作二级 chip）
    pickAxis: () => ({
      id: 'scene', label: '场景', value: scene,
      options: IMAGE_SCENE_KEYS.map(k => ({ value: k, label: IMAGE_SCENE_LABELS[k] })),
    }),
    isCustomized: (v) => {
      if (!(IMAGE_SCENE_KEYS as readonly string[]).includes(v)) return false;
      const sc = v as PhoneImageSceneKey;
      const s = getPhoneSettings();
      return imageSlotsOfScene(sc).some(sl => Boolean(s.imagePrompts?.[imagePromptKey(sc, sl.slot)]));
    },
    onAxis: (axisId, value) => {
      if (axisId !== 'scene') return false;
      if (!(IMAGE_SCENE_KEYS as readonly string[]).includes(value)) return false;
      scene = value as PhoneImageSceneKey;
      if (!slotsOf().some(s => s.slot === slot)) slot = slotsOf()[0].slot;
      return true;
    },
    chips: () => slotsOf().map(s => ({ id: s.slot, label: s.label, active: s.slot === slot })),
    onChip: (id) => {
      if (!slotsOf().some(s => s.slot === id)) return false;
      slot = id as PhoneImageSlotKey;
      return true;
    },
    tabs: () => [{ id: 'prompt', label: '提示词' }],
    unit: () => {
      const key = imagePromptKey(scene, slot);
      const meta = imageSlotOf(key);
      return {
        kind: 'text',
        key,
        title: `${IMAGE_SCENE_LABELS[scene]} · ${meta?.label || slot}`,
        defaultText: imageSlotDefault(key),
        savedText: getPhoneSettings().imagePrompts[key] || '',
        // 生图槽位无系统占位符（动态内容由装配侧的资料块/输入块承载），故不列插入 chip
        tokens: [],
        note: escapeHtml(meta?.desc || ''),
        guide: escapeHtml(IMAGE_LOCK_NOTE),
        minHeight: 300,
        validate: (value) => validateImageSlotText(key, value) || (value ? null : '内容为空：留空等于恢复默认，请点下方「重置当前提示词」。'),
        notifySaved: '提示词已保存',
      };
    },
    resetCopy: {
      label: '重置当前提示词',
      confirmTitle: '重置当前提示词？',
      confirmMessage: '把当前这一条提示词恢复成内置默认文本（丢弃本机对此槽位的自定义与编辑框里未保存的改动）。',
      notify: '已重置当前提示词',
    },
    saveText: async (key, text) => {
      const next = withPromptOverride(getPhoneSettings().imagePrompts, key, text, imageSlotDefault(key));
      // 退休键清理：两个旧规则槽（固定标签规则/注记）已回归写死常量，存量覆盖顺带清掉
      for (const retired of IMAGE_PROMPT_RETIRED_KEYS) delete (next as Record<string, string>)[retired];
      await savePhoneSettings({ imagePrompts: next });
    },
    saveItems: async () => { /* 生图领域无条目单元 */ },
    resetUnit: async () => {
      await savePhoneSettings({ imagePrompts: withoutPromptOverride(getPhoneSettings().imagePrompts, imagePromptKey(scene, slot)) });
    },
    resetAll: async () => {
      await savePhoneSettings({ imagePrompts: {} });
    },
  };
}

// ─── 编辑器引擎（领域无关）───

/** 全部领域（顺序即编辑器顶部段控顺序）。 */
function allDomains(): PromptEditorDomain[] {
  return [createSocialDomain(), createNightDomain(), createImageDomain()];
}

/** 领域 → 上次编辑的平台/场景值（ED-01「记忆上次位置」：首屏大卡上标「上次」）。会话级记忆，不落盘。 */
const lastPlatform: Record<string, string> = {};

/**
 * 编辑框光标处插入文本。优先 `document.execCommand('insertText')`：与用户敲键盘同一条编辑命令，
 * 会进原生撤销栈（插入后 Ctrl+Z 能撤掉），光标也自然落在插入内容之后；
 * 不可用时退回赋值法（赋值会清空撤销栈，属降级路径）。
 */
function insertAtCaret(ta: HTMLTextAreaElement, text: string): void {
  let ok = false;
  try {
    ok = ta.ownerDocument.execCommand('insertText', false, text);
  } catch (_e) {
    ok = false;
  }
  if (ok) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  ta.value = `${ta.value.slice(0, start)}${text}${ta.value.slice(end)}`;
  const at = start + text.length;
  ta.setSelectionRange(at, at);
}

/** 打开提示词编辑器（幂等：先移除同容器旧弹层）。onChanged = 保存后通知设置页刷新徽标。 */
export function openPromptSheet(container: HTMLElement, onChanged: () => void, initialDomain = 'social'): void {
  closePromptSheet(container);
  const doc = container.ownerDocument || document;
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-socp-sheet';
  const panel = doc.createElement('div');
  panel.className = 'ubp-sheet ubp-socp-panel';
  overlay.appendChild(panel);
  container.appendChild(overlay);
  // 返回键 = 关闭（未保存改动先自动落盘；校验失败则不放行，与返回箭头同语义）
  pushSheetCloser(() => { if (flushDraft()) closePromptSheet(container); }, () => overlay.isConnected);

  const domains = allDomains();
  let domainId = domains.some(d => d.id === initialDomain) ? initialDomain : domains[0].id;
  let tabId = domains.find(d => d.id === domainId)!.tabs()[0].id;
  /** 两步结构（ED-01）：首屏=平台大卡，编辑页=面包屑+chips+编辑框。 */
  let step: 'pick' | 'edit' = 'pick';
  /** 条目页草稿（增删时先同步；null=未编辑，直接读已存值）。 */
  let itemsDraft: PromptItemDef[] | null = null;
  /** 内联错误（保存校验失败/自动落盘被拦）。 */
  let error = '';
  /** 提示词编辑框的光标记忆（含选区）：只在用户真实交互事件上更新，见 rememberCaret。 */
  let caret: { start: number; end: number } | null = null;

  const domain = (): PromptEditorDomain => domains.find(d => d.id === domainId)!;
  const el = <T extends HTMLElement>(sel: string): T | null => panel.querySelector(sel) as T | null;
  const textarea = (): HTMLTextAreaElement | null => el<HTMLTextAreaElement>('[data-socp="text"]');
  const unit = (): PromptUnitDef => domain().unit(tabId);
  const textUnit = (): PromptTextUnitDef | null => {
    const u = unit();
    return u.kind === 'text' ? u : null;
  };
  const itemsUnit = (): PromptItemsUnitDef | null => {
    const u = unit();
    return u.kind === 'items' ? u : null;
  };
  /** 读条目页 DOM 草稿（用户在编内容）。 */
  const readItemsDraft = (): PromptItemDef[] => {
    const u = itemsUnit();
    const cards = Array.from(panel.querySelectorAll('[data-socp="tcard"]'));
    if (!cards.length) return u ? shownItems() : [];
    return cards.map(card => ({
      id: 'c',
      label: (card.querySelector('[data-socp="tlabel"]') as HTMLInputElement | null)?.value ?? '',
      guide: (card.querySelector('[data-socp="tguide"]') as HTMLTextAreaElement | null)?.value ?? '',
    }));
  };
  const showError = (text: string): void => {
    error = text;
    const box = el<HTMLElement>('.ubp-socp-err');
    if (box) {
      box.textContent = text;
      box.hidden = !text;
    }
  };
  /** 记住提示词编辑框此刻的光标/选区（插入占位符以它为准；编辑框失焦被浏览器重置也留得住）。 */
  const rememberCaret = (): void => {
    const ta = textarea();
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    caret = { start, end: ta.selectionEnd ?? start };
  };
  /**
   * 每个渲染帧给新编辑框挂一次光标记忆（编辑中不重绘，所以一次绑定覆盖整个输入过程）。
   * 这里监听按键/鼠标/选区/输入法提交：都不触发重绘，只记录光标（重绘纪律：input 不 render）。
   */
  const bindCaretMemory = (): void => {
    const ta = textarea();
    if (!ta) return;
    for (const type of ['keyup', 'mouseup', 'select', 'input', 'compositionend'] as const) {
      ta.addEventListener(type, rememberCaret);
    }
  };
  /**
   * 新增条目后：把新卡片滚进视野（block:'nearest' 只补差额，不会把弹层拉回顶部）
   * 并聚焦题材名输入框——既看得见又能直接打字。
   */
  const focusNewCard = (): void => {
    const cards = panel.querySelectorAll<HTMLElement>('[data-socp="tcard"]');
    const last = cards[cards.length - 1];
    if (!last) return;
    last.scrollIntoView({ block: 'nearest' });
    last.querySelector<HTMLInputElement>('[data-socp="tlabel"]')?.focus();
  };
  /** 条目清洗（去空项、裁长度；保存前先做，避免存脏）。 */
  const cleanItems = (list: readonly PromptItemDef[]): PromptItemDef[] => {
    const u = itemsUnit();
    const labelCap = u?.labelCap ?? 40;
    const guideCap = u?.guideCap ?? 300;
    const out: PromptItemDef[] = [];
    for (const item of list) {
      const label = (item.label || '').trim().slice(0, labelCap);
      const guide = (item.guide || '').trim().slice(0, guideCap);
      if (!label && !guide) continue;
      out.push({ id: item.id || `c${out.length + 1}`, label, guide });
    }
    return out;
  };
  const defaultItems = (): PromptItemDef[] => itemsUnit()?.defaults ?? [];
  const savedItems = (): PromptItemDef[] | null => itemsUnit()?.saved ?? null;
  /** 已存条目（用户自定义优先，空表回落内置）。 */
  const persistedItems = (): PromptItemDef[] => (savedItems() ?? defaultItems()).map(t => ({ ...t }));
  /** 展示用条目（有草稿则草稿优先）。 */
  function shownItems(): PromptItemDef[] {
    return (itemsDraft ?? persistedItems()).map(t => ({ ...t }));
  }

  // ─── 保存 / 落盘 ───

  const doSaveText = (silent = false): boolean => {
    const u = textUnit();
    const ta = textarea();
    if (!u || !ta) return true;
    const text = ta.value.trim();
    const invalid = u.validate ? u.validate(text) : null;
    if (invalid) {
      showError(invalid);
      return false;
    }
    const fallback = u.defaultText.trim();
    void domain().saveText(u.key, text).then(() => {
      onChanged();
      showError('');
      if (!silent) {
        phoneNotify(text === fallback ? resetCopy().notify : u.notifySaved); // 存成默认＝等于重置（生图域叫「已重置当前提示词」）
        render(true); // 同视图重绘：保滚动位置（否则保存后弹层跳回顶部）
      }
    });
    return true;
  };

  const doSaveItems = (silent = false): boolean => {
    const u = itemsUnit();
    if (!u) return true;
    const items = cleanItems(readItemsDraft());
    if (!items.length) {
      showError('选题池不能为空：至少留 1 个选题（或点「恢复本套默认」用内置池）。');
      return false;
    }
    itemsDraft = null;
    void domain().saveItems(u.key, items).then(() => {
      onChanged();
      showError('');
      if (!silent) {
        phoneNotify(u.notifySaved);
        render(true); // 同视图重绘：保滚动位置
      }
    });
    return true;
  };

  /** 当前页签有未保存改动 → 先自动落盘（换领域/页签/选择/关窗共用，避免丢编辑）。 */
  const flushDraft = (): boolean => {
    const u = unit();
    if (u.kind === 'text') {
      const ta = textarea();
      if (!ta) return true;
      if (ta.value.trim() === (u.savedText || u.defaultText).trim()) return true;
      if (!doSaveText(true)) return false;
      phoneNotify('已自动保存上一套');
      return true;
    }
    const items = cleanItems(readItemsDraft());
    if (themesEqual(items, persistedItems())) return true;
    if (!doSaveItems(true)) return false;
    phoneNotify('已自动保存上一套');
    return true;
  };

  // ─── 渲染 ───

  /** 首屏：领域段控 + 平台/场景大卡（含「已自定义」徽标与「上次」标记）。 */
  function pickHtml(): string {
    const d = domain();
    const ax = d.pickAxis?.() ?? null;
    const last = lastPlatform[d.id];
    const domainsRow = domains.length > 1
      ? `<div class="ubp-socp-tabs ubp-socp-domains">${domains.map(x =>
          `<button class="${x.id === domainId ? 'on' : ''}" data-socp="domain" data-v="${escapeAttr(x.id)}">${escapeHtml(x.label)}</button>`).join('')}</div>`
      : '';
    const cards = ax
      ? `<div class="ubp-socp-sec">${escapeHtml(ax.label)}</div>
        <div class="ubp-socp-cards">${ax.options.map(o => {
          const custom = Boolean(d.isCustomized?.(o.value));
          return `<button class="ubp-socp-card" data-socp="pick" data-v="${escapeAttr(o.value)}">
            <span class="ubp-socp-card-name">${escapeHtml(o.label)}</span>
            <span class="ubp-socp-card-tags"><span class="ubp-set-badge${custom ? ' on' : ''}">${custom ? '已自定义' : '默认'}</span>${o.value === last ? '<span class="ubp-socp-card-last">上次</span>' : ''}</span>
          </button>`;
        }).join('')}</div>`
      : '';
    return `<div class="ubp-socp-head">
        <span class="ubp-socp-headpad"></span>
        <span class="ubp-socp-title">提示词编辑</span>
        <button class="ubp-iconbtn" data-socp="close" title="关闭">${ubpIcon('back')}</button>
      </div>
      <div class="ubp-socp-body">
        ${domainsRow}
        ${cards}
        <div class="ubp-socp-note">选一个${ax ? escapeHtml(ax.label) : '项'}进入编辑；带「已自定义」的已有改动。</div>
      </div>`;
  }

  /** 编辑页：面包屑（平台值来自 pickAxis）+ 风格等其余轴 + 页签 + 分支 chips + 编辑框铺满。 */
  function editHtml(): string {
    const d = domain();
    const u = unit();
    const customized = u.kind === 'text' ? Boolean(u.savedText) : Boolean(savedItems());
    const badge = `<span class="ubp-set-badge${customized ? ' on' : ''}">${customized ? '已自定义' : '默认'}</span>`;
    const pickAx = d.pickAxis?.() ?? null;
    const pickLabel = pickAx ? (pickAx.options.find(o => o.value === pickAx.value)?.label || pickAx.value) : '';
    const path = `<div class="ubp-socp-path"><button data-socp="toPick">提示词编辑</button><span class="ubp-socp-path-sep">›</span><b>${escapeHtml(d.label)}</b>${pickLabel ? `<span class="ubp-socp-path-sep">›</span><b>${escapeHtml(pickLabel)}</b>` : ''}</div>`;
    const tabs = d.tabs();
    const tabsRow = tabs.length > 1
      ? `<div class="ubp-socp-tabs">${tabs.map(t =>
          `<button class="${t.id === tabId ? 'on' : ''}" data-socp="tab" data-v="${escapeAttr(t.id)}">${escapeHtml(t.label)}</button>`).join('')}</div>`
      : '';
    // 平台/场景已上面包屑，选择器只渲染剩余轴（社媒=风格）
    const axes = d.axes().filter(a => a.id !== pickAx?.id);
    const selector = axes.length
      ? `<div class="ubp-set-group ubp-socp-sel">${axes.map(a =>
          `<div class="ubp-fieldrow"><span class="ubp-fieldlabel">${escapeHtml(a.label)}</span>
            <select class="ubp-select" data-socp="axis" data-axis="${escapeAttr(a.id)}">${a.options.map(o =>
              `<option value="${escapeAttr(o.value)}"${o.value === a.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>
          </div>`).join('')}</div>`
      : '';
    const bannerHtml = d.banner ? d.banner() : '';
    // 二级选择（社媒=指令分支；生图=槽位）只对文本单元有意义（条目页签不显示）
    const chips = u.kind === 'text' ? d.chips() : [];
    const chipsRow = chips.length
      ? `<div class="ubp-socp-sec">${escapeHtml(d.chipsLabel)}</div>
        <div class="ubp-chips">${chips.map(c =>
          `<button class="ubp-chip${c.active ? ' on' : ''}" data-socp="chip" data-v="${escapeAttr(c.id)}">${escapeHtml(c.label)}</button>`).join('')}</div>`
      : '';

    let body = '';
    if (u.kind === 'text') {
      const toks = u.tokens.length
        ? `<div class="ubp-socp-sec">插入占位符</div>
          <div class="ubp-chips">${u.tokens.map(t =>
            `<button class="ubp-chip ubp-chip-tok" data-socp="tok" data-v="${escapeAttr(t.token)}" title="${escapeAttr(t.tip)}">${escapeHtml(t.token)}</button>`).join('')}</div>`
        : '';
      body = `${chipsRow}
        <div class="ubp-socp-cur">当前：<b>${escapeHtml(u.title)}</b>${badge}</div>
        ${toks}
        <div class="ubp-socp-note">${u.note}</div>
        <textarea class="ubp-textarea ubp-socp-editor ubp-socp-auto" data-socp="text" data-socp-min="${u.minHeight}" spellcheck="false">${escapeHtml(u.savedText || u.defaultText)}</textarea>`;
    } else {
      const items = shownItems();
      const cards = items.map((t, i) => `<div class="ubp-socp-tcard" data-socp="tcard">
          <div class="ubp-socp-th">
            <span class="ubp-socp-idx">${i + 1}</span>
            <input class="ubp-fieldinput ubp-socp-tlabel" data-socp="tlabel" value="${escapeAttr(t.label)}" placeholder="${escapeAttr(u.labelPlaceholder)}">
            <button class="ubp-socp-del" data-socp="tdel" data-v="${i}">删除</button>
          </div>
          <textarea class="ubp-textarea ubp-socp-tguide ubp-socp-auto" data-socp="tguide" data-socp-min="88" spellcheck="false" placeholder="${escapeAttr(u.guidePlaceholder)}">${escapeHtml(t.guide)}</textarea>
        </div>`).join('');
      body = `${chipsRow}
        <div class="ubp-socp-cur">当前：<b>${escapeHtml(u.title)}</b>${badge}</div>
        <div class="ubp-socp-sec">${escapeHtml(u.secLabel)}</div>
        ${cards}
        <button class="ubp-socp-add" data-socp="tadd">${escapeHtml(u.addLabel)}</button>
        <div class="ubp-socp-note">${u.note}</div>`;
    }

    return `<div class="ubp-socp-head">
        <button class="ubp-iconbtn" data-socp="toPick" title="返回">${ubpIcon('back')}</button>
        <span class="ubp-socp-title">提示词编辑</span>
        <button class="ubp-iconbtn" data-socp="menu" title="更多">${ubpIcon('more')}</button>
      </div>
      <div class="ubp-socp-body">
        ${path}
        ${tabsRow}
        ${selector}
        ${bannerHtml}
        <div class="ubp-socp-err"${error ? '' : ' hidden'}>${escapeHtml(error)}</div>
        ${body}
      </div>
      <div class="ubp-socp-foot">
        <button class="ubp-btn" data-socp="reset">${escapeHtml(resetCopy().label)}</button>
        <button class="ubp-btn primary" data-socp="save">保存</button>
      </div>`;
  }

  /** keepScroll=true：同一视图重绘（条目增删/保存）保滚动位置；换领域/页签/选择/恢复默认=换内容，从顶开始。 */
  function render(keepScroll = false): void {
    const bodyBox = el<HTMLElement>('.ubp-socp-body');
    const scrollTop = keepScroll && bodyBox ? bodyBox.scrollTop : 0;
    panel.innerHTML = step === 'pick' ? pickHtml() : editHtml();
    caret = null; // 新编辑框的光标是全新的，旧记忆作废
    const freshBody = el<HTMLElement>('.ubp-socp-body');
    if (freshBody) freshBody.scrollTop = scrollTop; // 重绘换掉滚动容器 → 归零，这里还原（保滚动纪律）
    bindCaretMemory();
    autoGrow(); // 每次重绘都按内容重算高度（换领域/页签/选择后同样一次铺开，不退回下限+内滚动条）
  }

  /** 首屏大卡 → 编辑页（切平台前先自动落盘；记住本次选择为「上次位置」）。 */
  function enterEdit(value: string): void {
    const ax = domain().pickAxis?.() ?? null;
    if (!ax || !ax.options.some(o => o.value === value)) return;
    if (value !== ax.value) {
      if (!flushDraft()) return;
      if (!domain().onAxis(ax.id, value)) return;
      itemsDraft = null;
      error = '';
    }
    lastPlatform[domainId] = value;
    tabId = domain().tabs()[0].id;
    step = 'edit';
    render();
  }

  /** 编辑页 ⋯ 菜单：详细写法指南（有则列）+ 恢复本领域（危险，走确认弹窗）。 */
  function openMenu(): void {
    const d = domain();
    const u = unit();
    openActionSheet(container, {
      title: '提示词编辑',
      actions: [
        ...(u.guide ? [{ label: '详细写法指南', onPick: () => {
          openActionSheet(container, {
            title: '详细写法指南',
            message: u.guide || '',
            actions: [{ label: S('知道了', '知悉'), onPick: () => { /* 只读 */ } }],
          });
        } }] : []),
        { label: `恢复「${d.label}」默认`, tone: 'danger', onPick: resetDomain },
        { label: S('取消', '作罢'), onPick: () => { /* 取消 */ } },
      ],
    });
  }

  /** 恢复整个领域（统一确认弹窗，ED-02）。 */
  function resetDomain(): void {
    const d = domain();
    openConfirmSheet(container, {
      title: `恢复「${d.label}」全部默认？`,
      message: `删除「${d.label}」下全部 ${d.customCount()} 处自定义，回落内置默认。`,
      confirmLabel: '恢复',
      onConfirm: () => {
        itemsDraft = null;
        error = '';
        void domain().resetAll().then(() => {
          onChanged();
          phoneNotify('已全部恢复默认');
          render();
        });
      },
    });
  }

  /**
   * 渲染后按内容自适应编辑框高度：长提示词/长条目指导一次铺开，看全貌靠弹层整体滚动，
   * 不在小框里跟内滚动条较劲（只读 scrollHeight，不监听 input——编辑中零重绘）。
   */
  function autoGrow(): void {
    panel.querySelectorAll<HTMLTextAreaElement>('textarea.ubp-socp-auto').forEach(ta => {
      const floor = Number(ta.dataset.socpMin || '80');
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(floor, ta.scrollHeight + 2)}px`;
    });
  }

  /** 当前领域的「恢复默认」文案（生图领域=「重置当前提示词」）。 */
  const resetCopy = (): { label: string; confirmTitle: string; confirmMessage: string; notify: string } =>
    domain().resetCopy ?? DEFAULT_RESET_COPY;

  /** 恢复当前这一套默认（文本/条目 = 删键回落内置）——破坏性操作先经统一确认弹窗（ED-02）。 */
  const resetCurrent = (): void => {
    const copy = resetCopy();
    openConfirmSheet(container, {
      title: copy.confirmTitle,
      message: copy.confirmMessage,
      confirmLabel: '恢复',
      onConfirm: () => {
        error = '';
        itemsDraft = null;
        void domain().resetUnit(tabId).then(() => {
          onChanged();
          phoneNotify(copy.notify);
          render();
        });
      },
    });
  };

  // ─── 事件（委托在 panel；弹层随关闭整体移除，无遗留监听） ───

  /**
   * 面板内所有 `<button>` 的 mousedown 一律阻止默认：点 chip 不让编辑框失焦，
   * 光标/选区原样保留（失焦在部分浏览器会把 selection 重置到末尾 → 占位符插到文本最下面）。
   * 只拦 button，<select> 的默认行为（展开下拉）照旧。
   */
  panel.addEventListener('mousedown', event => {
    if ((event.target as HTMLElement).closest('button[data-socp]')) event.preventDefault();
  });

  panel.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest('[data-socp]') as HTMLElement | null;
    if (!target) return;
    const act = target.dataset.socp;
    const value = target.dataset.v || '';
    if (act === 'close') {
      if (flushDraft()) closePromptSheet(container);
      return;
    }
    if (act === 'pick') { enterEdit(value); return; }
    if (act === 'toPick') { if (flushDraft()) { step = 'pick'; render(); } return; }
    if (act === 'menu') { openMenu(); return; }
    if (act === 'domain') {
      if (value === domainId || !domains.some(x => x.id === value)) return;
      if (!flushDraft()) return;
      domainId = value;
      tabId = domain().tabs()[0].id;
      itemsDraft = null;
      error = '';
      step = 'pick'; // 换领域回首屏大卡（选平台/场景）
      render();
      return;
    }
    if (act === 'tab') {
      if (value === tabId || !domain().tabs().some(t => t.id === value)) return;
      if (!flushDraft()) return;
      tabId = value;
      itemsDraft = null;
      error = '';
      render();
      return;
    }
    if (act === 'chip') {
      if (domain().chips().find(c => c.id === value)?.active) return;
      if (!flushDraft()) return;
      if (!domain().onChip(value)) return;
      itemsDraft = null;
      error = '';
      render();
      return;
    }
    if (act === 'tok') {
      const ta = textarea();
      if (!ta) return;
      const len = ta.value.length;
      // 插入位置：优先光标记忆——chip 的 mousedown 已阻止默认（编辑框不失焦、selection 原样），
      // 记忆与实时 selection 一致；万一仍失焦（移动端软键盘/浏览器怪癖把 selection 重置到末尾），
      // 记忆值才是「用户点下去时那个光标」。从未交互过（无记忆）先聚焦，用此刻浏览器给的光标。
      if (!caret) ta.focus();
      const raw = caret ?? { start: ta.selectionStart ?? len, end: ta.selectionEnd ?? len };
      const start = Math.max(0, Math.min(raw.start, len));
      const end = Math.max(start, Math.min(raw.end, len));
      ta.focus();
      ta.setSelectionRange(start, end);
      insertAtCaret(ta, value);
      caret = { start: start + value.length, end: start + value.length };
      return;
    }
    if (act === 'save') {
      if (unit().kind === 'text') doSaveText(); else doSaveItems();
      return;
    }
    if (act === 'reset') {
      resetCurrent();
      return;
    }
    if (act === 'resetAll') {
      resetDomain();
      return;
    }
    // 条目增删：先同步 DOM 草稿，再改结构重绘（其余卡片在编内容保留）
    // 重绘走 keepScroll：停在用户当前看的位置，不跳回画面最上方；新增后再把新卡聚焦/滚进视野
    if (act === 'tadd') {
      const u = itemsUnit();
      if (!u) return;
      const items = cleanItems(readItemsDraft());
      if (items.length >= u.cap) {
        showError(`最多 ${u.cap} 条。`);
        return;
      }
      itemsDraft = [...items, { id: `c${items.length + 1}`, label: '', guide: '' }];
      render(true);
      focusNewCard();
      return;
    }
    if (act === 'tdel') {
      const items = cleanItems(readItemsDraft());
      items.splice(Number(value), 1);
      itemsDraft = items;
      render(true);
    }
  });

  panel.addEventListener('change', event => {
    const target = (event.target as HTMLElement).closest('[data-socp="axis"]') as HTMLSelectElement | null;
    if (!target) return;
    const axisId = target.dataset.axis || '';
    if (!flushDraft()) {
      render(); // 回滚下拉到已保存的选择（渲染只读状态变量）
      return;
    }
    if (!domain().onAxis(axisId, target.value)) {
      render();
      return;
    }
    itemsDraft = null;
    error = '';
    render();
  });

  overlay.addEventListener('click', event => {
    if (event.target === overlay && flushDraft()) closePromptSheet(container);
  });

  render();
  autoGrow();
}

/** 移除容器内已存在的提示词编辑器。 */
export function closePromptSheet(container: HTMLElement): void {
  container.querySelector('.ubp-socp-sheet')?.remove();
}
