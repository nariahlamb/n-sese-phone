// 悬浮按钮边缘吸附的纯计算。存储仍由原有拖拽模块负责，坐标格式不变。
export type FloatingEdge = 'left' | 'right' | null;
export interface FloatingSnapPosition {
  left: number;
  top: number;
  edge: FloatingEdge;
}

export function snapFloatingToEdge(
  left: number,
  top: number,
  viewportWidth: number,
  viewportHeight: number,
  width: number,
  height: number,
  threshold = 48,
): FloatingSnapPosition {
  const maxLeft = Math.max(0, viewportWidth - width);
  const maxTop = Math.max(0, viewportHeight - height);
  const clampedLeft = Math.min(Math.max(0, left), maxLeft);
  const clampedTop = Math.min(Math.max(0, top), maxTop);
  let edge: FloatingEdge = null;
  if (clampedLeft <= threshold) edge = 'left';
  else if (viewportWidth - (clampedLeft + width) <= threshold) edge = 'right';
  return {
    left: edge === 'left' ? 0 : edge === 'right' ? maxLeft : clampedLeft,
    top: clampedTop,
    edge,
  };
}

/** 已保存坐标对应的边缘；仅精确贴边才恢复半隐藏，避免旧的“靠边但非吸附”数据被误改。 */
export function floatingEdgeAt(left: number, width: number, viewportWidth: number): FloatingEdge {
  if (Math.abs(left) < 0.5) return 'left';
  if (Math.abs(viewportWidth - width - left) < 0.5) return 'right';
  return null;
}
