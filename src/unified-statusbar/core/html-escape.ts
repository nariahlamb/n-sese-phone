// ===== HTML 转义统一出口 =====
// 三档转义集，按目标上下文选用：
//   escapeHtml      文本节点     & < > "
//   escapeHtmlAttr  attribute 值  & < > " '  （值内单引号也转义，防止属性截断）
//   escapeAttr      attribute 值  & " < >    （与历史 escapeAttr 实现一致）
// null/undefined → ''（对齐历史 String(s == null ? '' : s) 语义；0/false 保持自身）

export function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escapeHtmlAttr(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function escapeAttr(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
