// ===== 世界书条目内容 EJS 模板求值桥 =====
// 卡片作者会在世界书条目里写提示词模板语法（<%= %> 等，ST-Prompt-Template 插件）。
// 酒馆原生提示词管线里该插件会在注入时求值，但本项目自带的 AI 请求（宅仙助手资料
// 读取、世界演化、地图、技能、角色档案取材）绕开该管线直接读 entry.content，会把
// 裸模板发给 AI。处理方式与神数据库同款：读取层防御式委托 EjsTemplate.evalTemplate，
// 插件不存在或求值失败一律回退原文（宁可发裸模板也不丢条目）。
// 零开销纪律：不含 '<%' 的内容在首个子串判断即返回，不付任何插件调用成本。

export async function tryEvalWorldbookEjs(content: unknown, extraContext?: Record<string, unknown>): Promise<string> {
  const text = String(content ?? '');
  if (!text || !text.includes('<%')) return text;
  let ejs: any = null;
  try {
    // TavernHelper iframe 由 predefine 合并宿主 EjsTemplate；插件模式本身就在宿主页
    const w = (typeof window !== 'undefined' ? window : undefined) as any;
    ejs = w?.EjsTemplate ?? w?.parent?.EjsTemplate ?? null;
  } catch (_e) {
    return text;
  }
  if (typeof ejs?.evalTemplate !== 'function') return text;
  try {
    // context 为 null 时由插件内部 prepareContext()（合并全局/聊天/楼层变量），与神数据库填表路径一致
    const context = extraContext ? await ejs.prepareContext(extraContext) : null;
    const out = await ejs.evalTemplate(text, context);
    return out == null ? text : String(out);
  } catch (error) {
    console.warn('[世界书EJS] 模板求值失败，回退原文:', error);
    return text;
  }
}
