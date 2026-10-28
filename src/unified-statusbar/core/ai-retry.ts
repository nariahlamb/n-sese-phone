/**
 * AI 请求重试分类器与重试包装器。
 *
 * 重试策略：429/限流/5xx/网络错误→重试；401/403/400/中止/未配置→不重试；
 * 空响应单独重试；固定 2s 退避。解析失败时把错误信息注入下一次请求（自愈闭环）。
 *
 * 纯逻辑模块；不 import env/config，由调用方注入信号与回调（零空闲开销纪律）。
 */

export type AiErrorKind = 'retryable' | 'fatal' | 'aborted' | 'empty';

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String((error as any)?.message || error || '');
}

/** 网络级可重试：限流 / 服务端错误 / 网络与超时。 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /429/,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /\b5\d{2}\b/,
  /network/i,
  /fetch/i,
  /timeout|timed?\s*out|超时/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i,
  /failed\s*to\s*fetch/i,
  /socket|connection\s*(reset|closed|aborted)/i,
];

/** 致命不可重试：鉴权 / 参数 / 配置缺失。 */
const FATAL_PATTERNS: RegExp[] = [
  /\b40[13]\b/,
  /unauthorized|forbidden/i,
  /\b400\b/,
  /bad\s*request/i,
  /invalid\s*api\s*key|incorrect\s*api\s*key/i,
  /未配置|无法访问 generateRaw|环境未就绪/i,
];

const ABORT_PATTERNS: RegExp[] = [
  /abort/i,
  /请求已取消|已取消|任务已取消|用户取消/i,
  /clicked stop button/i,
];

/**
 * 分类 AI 请求错误。判定顺序：中止 → 致命 → 可重试 → 空响应。
 * ★按错误文本**分不出来时默认归为「可重试」**（末尾 `return 'retryable'`）——即「宁可多试一次，
 * 也不放过可能只是一次网络抖动的失败」。这是刻意的设计意图（2026-10-03 用户确认）：代价是
 * 必然失败的请求会白烧一次重试；重试次数上限不变（`withAiRetry` 的 attempts 默认 2 = 原始 1 次 + 重试 1 次）。
 */
export function classifyAiError(error: unknown): AiErrorKind {
  const name = (error as any)?.name || '';
  if (name === 'AbortError' || name === 'AbortPromptError') return 'aborted';
  const text = errorText(error);
  if (!text) return 'retryable';
  if (ABORT_PATTERNS.some(re => re.test(text))) return 'aborted';
  if (/空|empty/i.test(text) && /返回|输出|响应|response|reply/i.test(text)) return 'empty';
  if (FATAL_PATTERNS.some(re => re.test(text))) return 'fatal';
  if (RETRYABLE_PATTERNS.some(re => re.test(text))) return 'retryable';
  return 'retryable';
}

/** 用户主动终止（统一 AI 活动的取消）：调用方 catch 里应静默收口，不弹失败通知。
 *  刻意不用 classifyAiError 的宽泛 /abort/i（那会把 "socket connection aborted" 也当中止，
 *  误吞真实网络故障）；只认明确的取消语义。 */
export function isAiAbortError(error: unknown): boolean {
  const name = (error as any)?.name || '';
  if (name === 'AbortError' || name === 'AbortPromptError') return true;
  const text = error instanceof Error ? error.message : String((error as any)?.message || error || '');
  return /请求已取消|任务已取消|用户取消|user cancel|clicked stop button|aborted by user/i.test(text);
}

export interface AiRetryOptions {
  /** 总尝试次数（含首次），默认 2：一次原始 + 一次重试。 */
  attempts?: number;
  /** 重试间隔，默认 2000ms（st-chatu8 固定退避）。 */
  retryDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; kind: AiErrorKind; error: unknown }) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(t);
      resolve();
    }
    function onAbort() { finish(); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// 测试钩子：把退避压到 0，避免用例真等 2 秒（调用方显式传 retryDelayMs 时仍以传入值为准）。
let _retryDelayOverrideMs: number | null = null;
export function __setAiRetryDelayForTests(ms: number | null): void {
  _retryDelayOverrideMs = ms;
}

/**
 * 网络级重试包装器：仅对 classifyAiError 判为 retryable/empty 的错误重试；
 * fatal/aborted 立即抛出。fn 抛出的其它异常按分类器判定。
 */
export async function withAiRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: AiRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const delay = opts.retryDelayMs ?? _retryDelayOverrideMs ?? 2000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('请求已取消');
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const kind = classifyAiError(error);
      if (kind === 'fatal' || kind === 'aborted') throw error;
      if (attempt >= attempts) throw error;
      opts.onRetry?.({ attempt, kind, error });
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}

export interface AiParseRetryOutcome<T> {
  value: T | null;
  /** 最后一次原始输出（供调用方记录诊断）。 */
  raw: string;
  attempts: number;
}

/** 默认错误回注提示语（错误回注自愈闭环）。 */
export function buildParseRetryHint(prevRaw: string): string {
  const head = prevRaw.replace(/\s+/g, ' ').slice(0, 120);
  return [
    '【上次输出解析失败，请修正后重新输出】',
    '上次输出未能通过格式校验（开头为：「' + head + '…」）。',
    '请严格只输出符合此前规定格式的内容：不要输出解释文字、不要使用 markdown 代码块、',
    '字符串值内部避免出现双引号（优先改写措辞），确保括号与引号完整闭合。',
  ].join('\n');
}

export interface AiParseRetryOptions {
  /** 总尝试次数（含首次），默认 2。 */
  attempts?: number;
  signal?: AbortSignal;
  /** 生成函数；第 2 次起携带修正提示（追加到提示词），第 1 次为 null。 */
  generate: (attempt: number, retryHint: string | null) => Promise<string>;
  /** 解析函数；返回 null/undefined 视为解析失败。 */
  parse: (raw: string) => unknown | null;
  onRetry?: (attempt: number, prevRaw: string) => void;
}

/**
 * 解析失败重试（错误回注重试）：生成成功但解析失败时，把修正提示注入下一次
 * 生成请求。网络错误直接向外抛（由调用方处理或外层再包 withAiRetry）。
 */
export async function withAiParseRetry<T>(
  opts: AiParseRetryOptions,
): Promise<AiParseRetryOutcome<T>> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  let raw = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('请求已取消');
    const hint = attempt === 1 ? null : buildParseRetryHint(raw);
    raw = await opts.generate(attempt, hint);
    const parsed = opts.parse(raw);
    if (parsed !== null && parsed !== undefined) {
      return { value: parsed as T, raw, attempts: attempt };
    }
    if (attempt < attempts) opts.onRetry?.(attempt, raw);
  }
  return { value: null, raw, attempts };
}
