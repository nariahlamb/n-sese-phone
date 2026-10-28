// ===== AI 输出「围栏」文本处理（U11，零依赖纯模块）=====
//
// 背景：围栏剥离写了 5 份、其实是**两种脾气**，而且名字还撞车：
//   · map-system / map-prompts 的 `stripMarkdownFence` —— 只剥**首尾**围栏
//   · portrait-prompt-text 的 `stripMarkdownFence`（同名！）与 memo-goals / wardrobe-prompts 的
//     `stripFence` —— 其实是「取首个 ```json 围栏内的内容」
// 同名不同脾气正是 U7 抓过的那类隐患，故两个脾气各起一个不会误解的名字。

/** 只剥首尾的三反引号围栏（可带 json/svg/html/xml 标注）并 trim；不提取中间内容。 */
export function stripOuterFence(s: string): string {
  return s.replace(/^\s*```(?:json|svg|html|xml)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

/** 取首个 ```json 围栏内的内容；无围栏则返回原串 trim。 */
export function extractFencedJson(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : s.trim();
}
