// ===== 「JSON 解析失败就当空」统一出口（U33·十三轮）=====
// 全库此前 12 处手写 try/JSON.parse/catch-兜底（6 纯解析 + 6 带 localStorage 读取），兜底值五花八门
// （null / 空数组 / 默认对象）。收编为「解析 + 指定兜底值」两个参数，各自兜底原样传入（零行为变化）。
//
// ★明确排除（它们的行为是特性不是重复）：
//   · 容错修复链（ai-parse 修复 / memo-goals / wardrobe-prompts 的二次宽松修复）；
//   · 「失败要抛错」的生图模块（comfyui-client / item-overview-prompts 抛带上下文的错误）；
//   · ai-parse 的 PARSE_FAILED 哨兵语义（下游按哨兵走重试）。

/** 解析 JSON；失败（或输入非字符串）返回 fallback。 */
export function parseJsonWith<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch (_e) {
    return fallback;
  }
}

/** 读 localStorage 键并解析 JSON；键不存在、解析失败（含 node 测试环境无 localStorage）一律返回 fallback。 */
export function readLocalJson<T>(key: string, fallback: T, store?: Storage): T {
  try {
    // store 缺省在 try 内解析——node 测试环境无 localStorage 时按兜底走（与收编前各点位 catch 口径一致）
    const s = store ?? localStorage;
    const raw = s.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch (_e) {
    return fallback;
  }
}
