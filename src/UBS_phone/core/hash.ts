// ===== 内容指纹共享工具（消息/窥私两套世界书投影的变更签名共用；自 message-worldbook 提出，零行为变化） =====
// 用途：签名对「只改内容不改结构」的编辑类变更不再失盲（改正文/换图/改转写都触发重投影）。
// 仅在防抖后的签名计算里跑（O(总字符数)，不在渲染热路径）。

/** FNV-1a 增量折叠（不构建中间字符串；O(字符数)）。 */
export function foldHash(hash: number, text: unknown): number {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.imul(hash ^ 0x9e3779b9, 0x85ebca6b);
}

/** 内容指纹（base36 短串；空串=0）。「只改内容不改结构」的编辑类变更靠它进签名。 */
export function contentFingerprint(parts: unknown[]): string {
  let h = 0x811c9dc5;
  for (const part of parts) h = foldHash(h, part);
  return (h >>> 0).toString(36);
}

/**
 * 内容指纹（流式版）：逐值折叠，**不构建中间数组**。旧写法是
 * `contentFingerprint(messages.flatMap(m => [m.type, m.content, ...]))`——每条消息都要造一个 5 元素
 * 临时数组再摊平成大数组，长会话（数千条）下每秒一次签名时的中间分配很可观。
 * 与 contentFingerprint 同一折叠口径与初值 ⇒ **字段序列相同则结果逐字节相同**（纯性能改造，零行为变化）。
 */
export function streamFingerprint(emitFields: (emit: (value: unknown) => void) => void): string {
  let h = 0x811c9dc5;
  emitFields(value => { h = foldHash(h, value); });
  return (h >>> 0).toString(36);
}
