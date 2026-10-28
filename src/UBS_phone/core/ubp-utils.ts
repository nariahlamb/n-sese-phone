// ===== 小手机通用工具箱（唯一出口） =====
// 收编前这些小工具在各文件里一人一份：HTML 转义 2 份 3 个名字、ID 生成模板 ~12 处、clamp 5 个命名变体、
// 时长格式化 3 份、摘要截断 4 份、语音条宽度公式 2 份、合并式防抖 2 份。
// 集中到此后：改一处全链跟随。**纪律：能复用这里就别再新写第二份；新增通用小工具也放这里。**
// 注意：这些是纯函数、零宿主依赖，可被 .cjs 测试直接 require。

/** 数值钳制：number→floor；非法/非数字→fallback（不做字符串解析——需要解析时调用方先 Number）。 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** 「是不是一个普通对象」（非 null、非数组）。第六轮 ⑨ 收编：此前 11 个 model/工具文件各写一份、逐字节相同。
 *  各域保留同名局部名与 import 路径（`import { isRecord } from './ubp-utils'`），调用点一行未改。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 两位补零（时间/日期格式化共用）。 */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 秒 → MM:SS。round=true 四舍五入（正文通话卡），否则向下取整（通话记录/通话中计时）。 */
export function formatMMSS(seconds: number, round = false): string {
  const n = Number.isFinite(seconds) ? seconds : 0;
  const total = Math.max(0, round ? Math.round(n) : Math.floor(n));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * HTML 转义（文本节点与属性值共用同一档：`& < > " '` 五个实体）。
 * 口径 = 小手机全库既有实现。**与主项目 `html-escape.escapeHtml`（只转 4 个、不含单引号）同名不同义**，
 * 故刻意不 import 主项目那份——跨项目借用必须先统一语义，否则调用方按主项目直觉写会静默得到不同结果。
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 属性值转义（与 escapeHtml 同档；保留既有语义，调用点不必区分）。 */
export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

/**
 * 实体还原（与 escapeHtml 同档：含 `&#39;`/`&apos;`）。
 * 旧实现漏了单引号 ⇒ 编码侧产出的 `&#39;` 会以实体形式泄漏到正文里。
 * `&amp;` **必须最后**还原：先还原它会把 `&amp;lt;` 二次解码成 `<`（旧顺序就是错的）。
 */
export function unescapeBasicEntities(text: string): string {
  return String(text ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 唯一 ID：`前缀_时间36_随机6`（全库唯一的 ID 生成实现）。 */
export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 摘要：压缩连续空白为单空格 + trim + 超长加省略号（各域摘要/搜索命中/预览共用）。 */
export function excerptText(text: string, max: number): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** 截断：仅 trim + 超长加省略号（**不压缩内部空白**——聊天预览要保留原始换行节奏）。 */
export function truncateText(text: string, max: number): string {
  const clean = String(text || '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * 生图文字（画面描述 / 生图提示词 / 负面词 / 分角色提示词）不设长度上限。
 * 传作 `str(value, IMAGE_TEXT_NO_LIMIT)` 即全量保留：任何硬截断都会让生图拿到残缺文本。
 * 仅该口径统一用此常量；其余字段的截断（防脏数据）保持各域原值。
 */
export const IMAGE_TEXT_NO_LIMIT = Number.POSITIVE_INFINITY;

/** 语音条最小宽度（微信与窥私共用同一视觉公式，改口径只改这里）。 */
export function voiceBarMinWidth(durationSec: number): number {
  return Math.min(210, Math.max(96, Math.round(72 + durationSec * 4.4)));
}

/**
 * 「pending 期间忽略后续调用」的合并器（leading-edge ignore）。
 * 与主项目 `core/timing.ts` 的 `debounce`（clear + 重排，trailing）**语义不同**，刻意分开命名：
 * 两块世界书投影要的是「一秒内只跑一次，后来者直接丢弃」，不是「等安静下来再跑」。
 */
export function createCoalescer(ms: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; run(); }, ms);
  };
}

/**
 * 「等安静下来再跑」的 trailing 防抖（每次调用重排定时器）。
 * O41(第十二轮)：搜索输入专用——每次按键都全量扫描（会话上限 2000 条/会话 × 多会话）在长局下可感，
 * 去抖后每轮输入只扫一次。与上面 createCoalescer（pending 期间忽略后来者）语义不同，刻意分开命名。
 */
export function debounceTrailing(ms: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; run(); }, ms);
  };
}

/** 逐条送达间隔：按字数缩放（0.8s 起，最长约 2.5s）+ 随机抖动，模拟真人打字/说话节奏。
 *  微信、电话、不夜城私信共用同一口径——改节奏只改这里。 */
export function revealDelay(content: string): number {
  const len = content.replace(/\s+/g, '').length;
  return 800 + Math.min(len * 45, 1700) + Math.floor(Math.random() * 300);
}

/** setTimeout 的 Promise 包装（逐条送达/打字机投递共用）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
