// ===== 小手机 AI 管线错误类型（叶模块：phone-raw 与各引擎/UI 共用） =====
// 原定义在 chat-engine，迁出原因=phone-raw 需要它而 chat-engine 需要 phone-raw，
// 若从 chat-engine 取会形成循环 import。原处继续 re-export，既有调用方零改动。

export type PhoneChatErrorKind = 'env' | 'api' | 'network' | 'parse' | 'aborted';

/** AI 管线错误（kind 决定 UI 提示口径：env=环境 / api=预设 / network=网络 / parse=解析 / aborted=用户终止）。 */
export class PhoneChatError extends Error {
  kind: PhoneChatErrorKind;
  constructor(kind: PhoneChatErrorKind, message: string) {
    super(message);
    this.name = 'PhoneChatError';
    this.kind = kind;
  }
}

/** 用户主动终止（统一 AI 活动的取消）：UI 应静默收口，不报网络错误。 */
export function isPhoneAbortError(error: unknown): boolean {
  return error instanceof PhoneChatError && error.kind === 'aborted';
}
