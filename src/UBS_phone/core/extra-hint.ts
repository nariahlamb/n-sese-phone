// ===== 一次性「本批额外提示」合并（长按生成入口 → 只作用于本次请求，不落盘） =====
// 段标题的格式化全部收归本模块（单一事实源），指令模板只做插入不再包标题（用户定案）：
// 【生成要求】=设置页「生成要求」（每轮固定，用户不填整段不显示）；
// 【用户额外输出要求，尽量满足】=长按弹窗的本批提示（放最后）。
// 合并产物同时追加进触发注入（绿灯扫描语料）——提示里提到的人名同样激活其世界书条目。

/** 全局固定段标题（设置页「生成要求」；不填不显示）。 */
export const GLOBAL_REQUIREMENT_TITLE = '【生成要求】';
/** 用户本批段标题（长按弹窗一次性提示；恒在最后）。 */
export const USER_EXTRA_TITLE = '【用户额外输出要求，尽量满足】';

/** 合并全局要求与本批提示为完整要求段（纯函数，.cjs 测试可直接 require）：
 *  本批为空=只出全局段（等价旧「额外要求」段）；两者全空=空串（模板占位零变化）。 */
export function mergeOneShotHint(globalExtra: string, hint: string | undefined): string {
  const h = (hint || '').trim();
  const g = (globalExtra || '').trim();
  if (!h) return g ? `${GLOBAL_REQUIREMENT_TITLE}\n${g}` : '';
  return g ? `${GLOBAL_REQUIREMENT_TITLE}\n${g}\n\n${USER_EXTRA_TITLE}\n${h}` : `${USER_EXTRA_TITLE}\n${h}`;
}

/**
 * 焦点人物合并（长按弹窗指定，用户定案）：用户勾选优先（去重、过滤出池、保序），
 * 不足目标从池中随机补足到目标；勾选数超出目标=全采用户勾选不裁剪（目标由调用方取
 * max(设置焦点人数, 勾选数)）。纯函数（rng 注入便于测试）。
 */
export function mergeFocusPicks(picked: readonly string[], pool: readonly string[], target: number, rand: () => number = Math.random): string[] {
  const poolSet = new Set(pool);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of picked) {
    if (!name || seen.has(name) || !poolSet.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  const rest = pool.filter(n => !seen.has(n));
  let remaining = Math.max(0, Math.floor(target)) - out.length;
  while (remaining > 0 && rest.length) {
    const idx = Math.floor(rand() * rest.length);
    const [name] = rest.splice(idx, 1);
    seen.add(name!);
    out.push(name!);
    remaining--;
  }
  return out;
}
