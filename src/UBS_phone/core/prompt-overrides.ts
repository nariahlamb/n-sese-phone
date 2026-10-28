// ===== 标准化提示词编辑模块 · 覆盖表通用契约（领域无关） =====
// 各「领域」（社媒 / 生图 / 不夜城）的用户自定义提示词统一按覆盖表落盘：
//   文本表 Record<键, 文本>（社媒指令、生图槽位、不夜城玩法/总纪律/板块）；条目表 Record<键, 条目[]>（社媒选题池这类结构化单元）。
// 本模块只做领域无关的兜底（形状/长度/键数上限）与「与内置默认一致 = 删键」的写入口径；
// 键语法由各领域模块定义（core/social-prompt-templates、core/image-prompt-slots、core/night-prompt-slots），
// 消费侧对未知键天然回落默认 —— 避免「键白名单」出现第二处事实源（docs/21 D 表的既有口径）。

/** 单个提示词文本上限（内置最长约 4KB，留足自写余量）。 */
export const PROMPT_TEXT_CAP = 8000;
/** 覆盖表键数上限（防脏数据把设置文件撑爆）。 */
export const PROMPT_KEYS_CAP = 64;
/** 单键长度上限。 */
export const PROMPT_KEY_CAP = 64;

/** 仅收合法普通对象（数组/null/标量视为脏形状）。 */
function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 提示词覆盖表归一化：脏形状整体忽略；非字符串/空值丢弃；超长截断；键数封顶。 */
export function normalizePromptOverrides(value: unknown): Record<string, string> {
  const raw = plainRecord(value);
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(raw)) {
    if (Object.keys(out).length >= PROMPT_KEYS_CAP) break;
    if (typeof text !== 'string') continue;
    const k = key.slice(0, PROMPT_KEY_CAP);
    const v = text.trim().slice(0, PROMPT_TEXT_CAP);
    if (!k || !v) continue;
    out[k] = v;
  }
  return out;
}

/** 覆盖条数（多表合并计数；设置页徽标与「全部恢复」提示共用）。 */
export function promptOverrideCount(...tables: ReadonlyArray<Record<string, unknown> | undefined>): number {
  let n = 0;
  for (const t of tables) if (t) n += Object.keys(t).length;
  return n;
}

/**
 * 写一套文本覆盖：与内置默认一致（或空白）= 删键（不占存储），否则落盘。
 * 返回新表（调用方直接 patch 进 PhoneSettings，不改原表）。
 */
export function withPromptOverride(
  table: Record<string, string> | undefined,
  key: string,
  text: string,
  defaultText: string,
): Record<string, string> {
  const next = { ...(table || {}) };
  const v = text.trim();
  if (!v || v === defaultText.trim()) delete next[key];
  else next[key] = v.slice(0, PROMPT_TEXT_CAP);
  return next;
}

/** 删一套文本覆盖（恢复默认）。 */
export function withoutPromptOverride(table: Record<string, string> | undefined, key: string): Record<string, string> {
  const next = { ...(table || {}) };
  delete next[key];
  return next;
}

/** 文本覆盖取值（空/缺省回落内置默认）。 */
export function promptOverrideOf(table: Record<string, string> | undefined, key: string, defaultText: string): string {
  return ((table || {})[key] || '').trim() || defaultText;
}
