// ===== 聊天归属守卫（统一原语） =====
//
// 用途：一个跨多个长 await 的异步流程（AI 请求 → 解析 → 生图/上传 → 写入）在发起时
// 捕获聊天身份，在写聊天级存储之前核对「是否仍是发起时那个聊天」。
//
// 为什么不用「CHAT_CHANGED 统一 abort」替代：abort 只砍得掉还在网络等待的那一段，
// 响应已到达后的续体、以及生图/上传/逐条送达等非文本请求都管不到；归属守卫是写入前的
// 最后一道确定性校验。两者互补，不互相替代。
//
// 语义（与既有 F5/F8 守卫逐点一致）：
// - 捕获时键为空（存储未就绪/欢迎页）→ 守卫停用，恒视为当前，避免把加载窗口内发起的工作误判为切卡；
// - 捕获后键变为空（切换转发期）或变为别的键 → 视为已切换，宁可丢弃也不写进新聊天；
// - 只读、无监听、无定时器；未调用 isCurrent() 时零开销。
//
// 本模块刻意零 import（叶模块）：主项目便捷入口 captureChatScope 在 story-floor-store
// （聊天身份的唯一来源），小手机等其它产物只 import 本原语也不会被拖入有状态模块。

/** 读取聊天身份的注入点（主项目默认 story 存储键；其它产物可传自己的身份读取口）。 */
export type ChatKeyReader = () => string;

export interface ChatScope {
  /** 发起时捕获的聊天键；空串＝守卫停用。 */
  readonly key: string;
  /** false＝捕获时没有聊天键，isCurrent() 恒 true。 */
  readonly enabled: boolean;
  /** true＝仍是发起时的聊天（或守卫停用）。 */
  isCurrent(): boolean;
}

/**
 * 创建守卫。readKey 在捕获时与每次核对时各调一次（都走内存缓存，无 IO）。
 * label 仅用于首次判定已切换时的一行 console.info（便于现场排查），不参与业务。
 */
export function createChatScope(readKey: ChatKeyReader, label = ''): ChatScope {
  const key = String(readKey() || '');
  const enabled = !!key;
  let logged = false;
  return {
    key,
    enabled,
    isCurrent() {
      if (!enabled) return true;
      const current = String(readKey() || '');
      if (current === key) return true;
      if (!logged) {
        logged = true;
        console.info(`[聊天归属] ${label || '异步任务'}：聊天已切换，本次结果丢弃`, { from: key, to: current });
      }
      return false;
    },
  };
}
