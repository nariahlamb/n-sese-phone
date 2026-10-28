/**
 * 共享 AI 结构化输出解析管线。
 *
 * 背景：地图/场景图/技能树/衣柜/助手等 15+ 个 AI 调用点各自解析 AI 输出，
 * 普遍是「贪心正则 + JSON.parse」，对围栏、全角引号、未转义引号、尾逗号、
 * 截断输出等常见噪声零容错。本模块吸收资源库调研（2026-08-24）中四个项目
 * 的容错经验合并成一条管线：
 * - 通用 JSON 清洗管线：控制字符清理 / 尾逗号删除 / 结构感知转义；
 * - MVU parseString：多级容错链（先轻后重，逐级尝试）；
 * - World repairTruncatedJSON：截断救援（按括号栈补闭合）；
 * - 提取降级链：取最后一个完整配对块。
 *
 * 纯函数、零外部依赖；仅被 AI 输出解析路径按需调用（功能未触发时开销=零）。
 */

export interface AiJsonParseResult<T> {
  value: T | null;
  /** 解析失败时的诊断信息（截断的输入特征），用于错误回注重试与日志。 */
  error: string | null;
}

const CODE_FENCE_RE = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/;

/** 剥掉包裹整个文本的 markdown 代码围栏（```json 等）。多块围栏时拼接块内容。 */
export function stripJsonCodeFence(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (!trimmed.includes('```')) return trimmed;
  const fenceCount = (trimmed.match(/```/g) || []).length;
  if (fenceCount === 2) {
    const single = trimmed.match(CODE_FENCE_RE);
    if (single) return single[1].trim();
  }
  if (fenceCount > 2) {
    const blocks: string[] = [];
    const re = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed)) !== null) blocks.push(m[1]);
    if (blocks.length) return blocks.map(b => b.trim()).filter(Boolean).join('\n').trim();
  }
  return trimmed;
}

/**
 * JSON 修复扫描器状态。所有编辑都基于「ASCII 双引号定界的字符串状态」，
 * 字符串内部内容原则上不动（除非开启引号转义/控制字符修复）。
 */
interface ScanState {
  /** 编辑后的文本分段。 */
  out: string[];
  /** 是否处于字符串字面量内。 */
  inString: boolean;
  /** 字符串内是否刚遇到过反斜杠（转义）。 */
  escaped: boolean;
}

/** 阶段1修复：字符串内控制字符转义 + 未转义内嵌引号 + 尾逗号删除。结构感知，逐字符扫描。 */
function repairStage1(source: string): string {
  const st: ScanState = { out: [], inString: false, escaped: false };
  const n = source.length;
  for (let i = 0; i < n; i++) {
    const ch = source[i];
    if (st.inString) {
      if (st.escaped) {
        st.escaped = false;
        st.out.push(ch);
        continue;
      }
      if (ch === '\\') {
        st.escaped = true;
        st.out.push(ch);
        continue;
      }
      if (ch === '"') {
        // 判断这是「闭引号」还是「值内部未转义的引号」：
        // 闭引号后（跳过空白）应是 , } ] : 或结尾；否则视为内容引号，补转义。
        let j = i + 1;
        while (j < n && /\s/.test(source[j])) j++;
        const next = source[j];
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
          st.inString = false;
          st.out.push('"');
        } else {
          st.out.push('\\"');
        }
        continue;
      }
      // 字符串内的裸控制字符是 JSON.parse 失败的常见原因（AI 直接换行）。
      if (ch === '\n') { st.out.push('\\n'); continue; }
      if (ch === '\r') { st.out.push('\\r'); continue; }
      if (ch === '\t') { st.out.push('\\t'); continue; }
      st.out.push(ch);
      continue;
    }
    // 字符串外：删 } ] 前的尾逗号（含其间空白）。
    if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(source[j])) j++;
      if (source[j] === '}' || source[j] === ']') continue; // 丢弃逗号与空白
      st.out.push(ch);
      continue;
    }
    if (ch === '"') {
      st.inString = true;
      st.escaped = false;
      st.out.push(ch);
      continue;
    }
    st.out.push(ch);
  }
  return st.out.join('');
}

/** 阶段2修复：截断救援。字符串未闭合则补引号；去掉悬空键/悬空元素/悬挂逗号；按括号栈补齐闭合。 */
function repairStage2(source: string): string {
  const st: ScanState = { out: [], inString: false, escaped: false };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (st.inString) {
      if (st.escaped) { st.escaped = false; }
      else if (ch === '\\') { st.escaped = true; }
      else if (ch === '"') { st.inString = false; }
      st.out.push(ch);
      continue;
    }
    if (ch === '"') { st.inString = true; st.escaped = false; st.out.push(ch); continue; }
    st.out.push(ch);
  }
  let text = st.out.join('');
  if (st.inString) text += '"';
  // 尾部修复循环：依次去掉悬挂逗号、悬空键（"key": 无值）、悬空元素（{"key" 无冒号）、
  // 空开容器。循环直至尾部稳定（每次修复可能暴露新的悬空结构）。
  for (let guard = 0; guard < 12; guard++) {
    const before = text;
    text = text.replace(/,\s*$/, '');
    text = text.replace(/,\s*\{\s*(?:"[^"]*"\s*)?$/, ''); // 悬空元素对象（至多只有键）
    text = text.replace(/,\s*\[\s*$/, '');                 // 悬空空数组
    text = text.replace(/"[^"]*"\s*:\s*$/, '');            // 悬空键+冒号（下一轮再去其前逗号）
    text = text.replace(/\{\s*$/, '').replace(/\[\s*$/, ''); // 空开容器（无任何成员）
    if (text === before) break;
  }
  // 重新扫描修复后的文本，按实际括号栈补齐闭合（尾部修复可能已移除部分开括号）。
  let fs = false; // in string
  let fe = false; // escaped
  const finalStack: string[] = [];
  for (const ch of text) {
    if (fs) {
      if (fe) fe = false;
      else if (ch === '\\') fe = true;
      else if (ch === '"') fs = false;
      continue;
    }
    if (ch === '"') { fs = true; continue; }
    if (ch === '{' || ch === '[') finalStack.push(ch);
    else if (ch === '}' || ch === ']') finalStack.pop();
  }
  if (fs) text += '"';
  for (let i = finalStack.length - 1; i >= 0; i--) text += finalStack[i] === '{' ? '}' : ']';
  return text;
}

/** 阶段3修复：全角标点归一。仅当文本完全不含 ASCII 双引号时才全局替换（此时全角必是定界符）。 */
function repairStage3(source: string): string {
  if (source.includes('"')) return source;
  return source
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\uff1a/g, ':')
    .replace(/\uff0c/g, ',')
    .replace(/[\uff08\uff09]/g, '"')
    .replace(/[\uff3b\uff3d]/g, s => (s === '\uff3b' ? '[' : ']'))
    .replace(/[\uff5b\uff5d]/g, s => (s === '\uff5b' ? '{' : '}'));
}

/** 逐级修复 + 尝试解析。级别从轻到重，先试原始，再依次叠加修复。 */
export function looseJsonParse(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = stripJsonCodeFence(String(raw ?? ''));
  if (!text) return { ok: false, error: 'AI 输出为空' };
  const direct = tryParse(text);
  if (direct !== PARSE_FAILED) return { ok: true, value: direct };
  const stage1 = repairStage1(text);
  const s1 = tryParse(stage1);
  if (s1 !== PARSE_FAILED) return { ok: true, value: s1 };
  const stage2 = repairStage2(stage1);
  const s2 = tryParse(stage2);
  if (s2 !== PARSE_FAILED) return { ok: true, value: s2 };
  const stage3 = repairStage3(stage2);
  if (stage3 !== stage2) {
    const s3 = tryParse(stage3);
    if (s3 !== PARSE_FAILED) return { ok: true, value: s3 };
    const s3b = tryParse(repairStage2(repairStage1(stage3)));
    if (s3b !== PARSE_FAILED) return { ok: true, value: s3b };
  }
  return {
    ok: false,
    error: `JSON 解析失败（已尝试修复链）：输入 ${text.length} 字符，开头为「${text.slice(0, 40).replace(/\s+/g, ' ')}…」`,
  };
}

/** 解析失败哨兵：对象身份判定，避免 caller 拿到歧义值。 */
const PARSE_FAILED = { failed: true };

function tryParse(text: string): unknown {
  if (!text) return PARSE_FAILED;
  try {
    return JSON.parse(text);
  } catch (_e) {
    return PARSE_FAILED;
  }
}

/**
 * 扫描文本中所有顶层平衡的 {...} / [...] 片段（引号感知，跳过字符串内的括号）。
 * 返回按出现顺序的片段；调用方通常从最后一个开始尝试（AI 末尾输出才是最终答案）。
 */
export function extractBalancedJsonSpans(text: string): string[] {
  const source = String(text ?? '');
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) spans.push(source.slice(start, i + 1));
      }
    }
  }
  return spans;
}

function describeParseTarget(text: string): string {
  const head = stripJsonCodeFence(text).slice(0, 40).replace(/\s+/g, ' ');
  return `开头为「${head}…」`;
}

/**
 * 通用 AI JSON 输出解析：整体尝试 → 平衡片段提取（末尾优先）→ 修复链。
 * 与旧式 `text.match(/\{[\s\S]*\}/)` 贪心正则相比：不会把首尾两个对象间的散文
 * 一并吞入，且对截断/引号噪声有修复能力。
 */
export function parseAiJsonValue(raw: string): AiJsonParseResult<unknown> {
  const text = stripJsonCodeFence(String(raw ?? ''));
  if (!text) return { value: null, error: 'AI 输出为空' };
  const whole = looseJsonParse(text);
  if (whole.ok) return { value: whole.value, error: null };
  const spans = extractBalancedJsonSpans(text);
  for (let i = spans.length - 1; i >= 0; i--) {
    const parsed = looseJsonParse(spans[i]);
    if (parsed.ok) return { value: parsed.value, error: null };
  }
  return { value: null, error: `未找到可解析的 JSON 片段（共 ${spans.length} 个候选片段），${describeParseTarget(text)}` };
}

/** parseAiJsonValue 的对象限定版（大多数调用点期望 {…}）。 */
export function parseAiJsonObject(raw: string): AiJsonParseResult<Record<string, unknown>> {
  const result = parseAiJsonValue(raw);
  if (result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value)) {
    return { value: result.value as Record<string, unknown>, error: null };
  }
  return {
    value: null,
    error: result.error ?? 'AI 输出不是 JSON 对象',
  };
}

/**
 * 剥掉文本尾部的 <safe>…</safe> 无害化收尾段。
 *
 * 默认尾部破限（core/constants.TAIL_JAILBREAK_PROMPT，原「反截断」）要求模型在任务输出完成、
 * 最后一个标签闭合之后另起一行输出这段英文无害化语言——它是给审查模型看的，不属于任务输出。
 * 契约标签类解析器本就只取自己的标签，但**自由文本出口**（JSON 严格解析 / 宅仙信封 / 生图提示词 /
 * 纪要与标签行）会被它污染，故在文本 AI 出口统一剥除（见 api-config.withTextAiRetry、
 * 手机 phone-api.withPhoneTextAiRetry，以及直连流式与不接重试的站点各自调用）。
 *
 * 只处理「尾部」：完整配对块（可含多块）整段剥除；输出被截断在 <safe> 内（有开无闭）则从该开标签截断；
 * 出现在文本中段且后续还有内容的 <safe> 一律不动（避免误伤正文）。无 <safe> 时原样返回（零开销早退）。
 */
export function stripTailSafeBlock(text: string): string {
  const src = String(text ?? '');
  if (!src || !/<safe>/i.test(src)) return src;
  const stripped = src.replace(/\s*<safe>[\s\S]*?<\/safe>\s*$/i, '');
  if (stripped !== src) return stripped;
  // 截断兜底：最后一个 <safe> 之后没有 </safe> ⇒ 从它起全部丢弃
  const lower = src.toLowerCase();
  if (lower.lastIndexOf('<safe>') > lower.lastIndexOf('</safe>')) {
    return src.slice(0, lower.lastIndexOf('<safe>')).replace(/\s+$/, '');
  }
  return src;
}
