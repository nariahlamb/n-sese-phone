// ===== 故事时钟（唯一出口）：解析 → 风格显示 → 兜底 =====
// 为什么单独立一个 core 模块：
//   ① 这条例线原先是 renderers/phone-ui.ts 里的一个本地函数（解析 + 风格换算 + 「提取不到回退原文」
//      三段兜底揉在渲染层），锁屏/控制中心/通知面板都要用同一份时刻文案 —— 落在 core 才不会各写一份；
//   ② 全机时间口径只有「故事时间快照」一份（无真实时钟，见 MEMORY §五.27），
//      解析口径继续由 chat-model.extractStoryDateTime 独占（本模块只转发，不另写第二份正则）；
//      风格换算由 skins.displayClockText 独占（武侠=时辰、西幻=昼夜徽记）。
// 纯组合，无状态、无 DOM、无缓存 —— 每次调用都是纯函数。

import { extractStoryDateTime, type PhoneStyle } from './chat-model';
import { displayClockText } from './skins';

/** 解析转发（唯一解析实现仍在 chat-model；调用方不必同时 import 两处）。 */
export { extractStoryDateTime };

/** 故事时间自由文本 → 时刻文案（`--:--` 兜底）。
 *  规则与改造前逐字一致：取到时刻 → 按风格换算；取不到 → 回退原文；原文也空 → `--:--`。
 *  例：'2026-05-18 17:24' → '17:24'；'正文时间' → '正文时间'；'' → '--:--'。 */
export function storyClockText(story: string, style: PhoneStyle): string {
  const { time } = extractStoryDateTime(story);
  return displayClockText(time || '', time || story || '--:--', style);
}

/** 故事时间自由文本 → 日期文案（`YYYY-MM-DD`；提取不到回空串，绝不编造）。 */
export function storyDateText(story: string): string {
  return extractStoryDateTime(story).date;
}
