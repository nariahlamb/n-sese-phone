// ===== 文字 AI 请求统一标签与阶段文案 =====
// AiRetryScope 是「重试设置」口径（大调查/采访共用 investigation），不能拿来当 UI 标签；
// 本模块的 AiTextFeature 才是面向用户的功能名。纯常量/纯函数，零依赖（测试与产物均可独立引用）。

export type AiTextFeature =
  | 'investigation' | 'interview' | 'calendar' | 'shopStory'
  | 'map' | 'mapOrganize' | 'mapScenePrompt'
  | 'portraitPrompt' | 'portraitCharTags' | 'portraitFanTags' | 'storyImagePrompt'
  | 'skillTree' | 'wardrobeExtract' | 'wardrobeDesign'
  | 'nsfwGuidance' | 'memoGoals' | 'currencyProposal' | 'itemOverview'
  | 'chronicleMerge' | 'characterWorldbook'
  | 'assistantPlanner' | 'assistantAnswer' | 'worldEvolution';

export const AI_TEXT_FEATURE_LABEL: Record<AiTextFeature, string> = {
  investigation: '大调查', interview: '采访', calendar: '日历', shopStory: '剧情特卖',
  map: '地图', mapOrganize: '地图整理', mapScenePrompt: '场景提示词',
  portraitPrompt: '立绘提示词', portraitCharTags: '人物 tag', portraitFanTags: '同人 tag', storyImagePrompt: '正文插图提示词',
  skillTree: '技能树', wardrobeExtract: '衣柜提炼', wardrobeDesign: '衣柜穿搭',
  nsfwGuidance: '瑟瑟指导', memoGoals: '备忘录目标', currencyProposal: '货币提案',
  itemOverview: '仓库总览', chronicleMerge: '纪要合并', characterWorldbook: '角色世界书',
  assistantPlanner: '宅仙规划', assistantAnswer: '宅仙回答', worldEvolution: '世界观演化',
};

/** AI 文字请求阶段（UI 唯一文案来源，各功能不再自己拼「进行中」）。 */
export type AiTextPhase = 'preparing' | 'requesting' | 'retrying' | 'parsing' | 'writing' | 'terminating';

export interface AiPhaseTextInput {
  phase: AiTextPhase;
  attempt?: number;
  maxAttempts?: number;
}

/** 阶段文案：requesting/retrying 带「第 a/b 次」。 */
export function aiPhaseText(input: AiPhaseTextInput): string {
  switch (input.phase) {
    case 'preparing': return '准备中';
    case 'requesting': {
      const a = input.attempt;
      const b = input.maxAttempts;
      if (typeof a === 'number' && typeof b === 'number' && b > 1) return `请求中（第 ${a}/${b} 次）`;
      return '请求中';
    }
    case 'retrying': {
      const a = input.attempt;
      const b = input.maxAttempts;
      if (typeof a === 'number' && typeof b === 'number') return `重试中（第 ${a}/${b} 次）`;
      return '重试中';
    }
    case 'parsing': return '解析中';
    case 'writing': return '收尾中';
    case 'terminating': return '终止中…';
    default: return '进行中';
  }
}
