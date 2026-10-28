// ===== 语音「情绪彩标 + 演绎说明」展示件（微信语音条 / 窥私语音条 / 通话逐句 / 通话全屏共用一份口径） =====
// 纪律（2026-10-03 用户定案）：
//   ① **只在 TTS 开启时渲染**（调用方先用 isVoiceEnabled() 把闸门拿住），关闭时一个节点都不输出；
//   ② **空标注什么都不显示**——不给「未标注」灰标占位；认不出的标注如实显示原文（走中性灰）；
//   ③ 情绪色相取自规范八词（core/voice-providers.emotionBadge），亮/暗两套配方在 CSS 里切换，
//      四风格皮肤不接管标签颜色（皮肤只管气泡底色）。
// 本模块只做 markup；播放/闸门逻辑仍在各 App 内。

import { escapeHtml } from '../core/ubp-utils';
import { emotionBadge } from '../core/voice-providers';

/** 情绪彩标；空标注 → 空串。 */
export function emotionChipHtml(raw: unknown): string {
  const b = emotionBadge(raw);
  if (!b) return '';
  return `<span class="ubp-emo ubp-emo-${escapeHtml(b.key)}">${escapeHtml(b.label)}</span>`;
}

/** 「情绪彩标 + 演绎说明」元件；两样都空 → 空串（调用方不要补占位）。 */
export function voiceMetaHtml(emotion: unknown, delivery: unknown): string {
  const chip = emotionChipHtml(emotion);
  const text = String(delivery ?? '').trim();
  if (!chip && !text) return '';
  const deliv = text ? `<span class="ubp-deliv">${escapeHtml(text)}</span>` : '';
  return `<span class="ubp-vmeta">${chip}${deliv}</span>`;
}
