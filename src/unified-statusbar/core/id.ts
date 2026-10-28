// ===== 唯一 ID 生成统一出口（U3 收编） =====
// 全库曾有 ~11 处「prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, N)」
// 各写各的（分隔符与随机长度互异）。本出口参数化分隔符与长度，替换点逐字节等价。
// 刻意不收编的形态（语义不同，勿混用）：
//   - crypto.randomUUID 优先型（assistant-runtime/assistant-store/chat-storage-identity）——
//     ID 形态对外可见（助手消息 id / 存储标识），保持 UUID 语义；
//   - 十进制时间戳型（comfyui-client 的 ComfyUI clientId）——与 36 进制产物不同，保持原样。
export function makeUniqueId(prefix: string, randomLen = 8, sep = '-'): string {
  return `${prefix}${sep}${Date.now().toString(36)}${sep}${Math.random().toString(36).slice(2, 2 + randomLen)}`;
}
