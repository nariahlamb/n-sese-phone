// 环境全局访问：从 iframe window 向上到 window.parent 取酒馆助手注入的全局对象。
// 统一入口：各文件不得再各自内联 window/window.parent 探测（曾有 ~20 处重复实现）。

import { makeUniqueId } from './id'; // U3：ID 生成统一出口（id.ts 零依赖，无环）
import { createShieldedGenerateRaw } from './ai-tool-shield'; // U34：generateRaw 工具注入防护 + 出站宏展开

// U34 出站统一出口：getTavernHelper 返回记忆化代理（原型继承，属性全透传），仅覆盖 generateRaw
// 为「宏展开 + 工具防护」版本——本插件（含小手机，其 host-env re-export 本函数）所有 AI 请求
// 出站前先展开 ordered_prompts 里的酒馆宏（无宏请求原样透传、零克隆），再剥掉 ST ToolManager
// 自动拼入的宿主/第三方工具；指纹不命中的宿主与其他脚本请求零改动。
// 代理构造失败 → 原样返回（防护缺位但功能不受阻）。详见 core/ai-tool-shield.ts 头注。
let _rawHelperRef: any = null;
let _shieldedHelper: any = null;

function shieldHelper(th: any): any {
  if (th === _rawHelperRef) return _shieldedHelper;
  _rawHelperRef = th;
  try {
    const proxy: any = Object.create(th);
    proxy.generateRaw = createShieldedGenerateRaw(th.generateRaw.bind(th), th);
    _shieldedHelper = proxy;
  } catch (_e) {
    _shieldedHelper = th;
  }
  return _shieldedHelper;
}

/** 酒馆助手全局对象（TavernHelper，generateRaw 已带工具注入防护）。跨源访问受限时返回 null。 */
export function getTavernHelper(): any {
  try {
    if ((window as any).TavernHelper) return shieldHelper((window as any).TavernHelper);
    if ((window.parent as any).TavernHelper) return shieldHelper((window.parent as any).TavernHelper);
  } catch (_e) { /* cross-origin */ }
  return null;
}

/** 停止指定 generation_id 的生成请求（酒馆助手 API，配合 generateRaw 的 generation_id 字段）。best-effort。 */
export function stopGenerationById(generationId: string): boolean {
  try {
    const helper = getTavernHelper();
    return !!helper?.stopGenerationById?.(generationId);
  } catch (_e) { return false; }
}

/** 生成唯一 generation_id（供 generateRaw 标识 + stopGenerationById 终止）。 */
export function makeGenerationId(prefix: string): string {
  return makeUniqueId(prefix); // U3：委托统一出口（导出保留，行为逐字节不变）
}

/** toastr 通知全局对象。跨源访问受限时返回 null。 */
export function getToastr(): any {
  try {
    if ((window as any).toastr) return (window as any).toastr;
    if ((window.parent as any).toastr) return (window.parent as any).toastr;
  } catch (_e) { /* cross-origin */ }
  return null;
}

// ===== SillyTavern 宿主探测规范口（U32·十三轮）=====
// 全库「获取宿主上下文」此前 20+ 处手写、五种写法。本口只收编**双窗根探测（A 形）**与两种解包；
// 其余四形是**有意的候选链差异**（回退面不同，统一即行为变更——十二轮 U29 已定调），保留原地：
//   B 形·4 候选 try 链：chatu8-bridge / server-file-store / story-floor-store（candidates.push ×4）；
//   C 形·2~3 候选 try 链：chat-relocation / db-checkpoint-converge / storage-bootstrap；
//   D 形·`||` 四连赋值：image-storage / scene-switcher / world-sources；
//   E 形·单窗或局部变体：story-image-engine（TavernHelper 链）/ config-store / currency-prose 等。
// 日后新增探测一律走本口；要动 B/C/D/E 需按「回退面变更」单独提案。

/** 双窗根探测（A 形）：本窗 SillyTavern → 父窗。无根/跨域异常返回 undefined。 */
export function sillyTavernRoot(w?: any): any {
  const win = w ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return undefined;
  try {
    return win.SillyTavern || win.parent?.SillyTavern;
  } catch (_e) {
    return undefined;
  }
}

/** 根 + null 解包：根有 getContext() 则调用取上下文（抛错当 null），无 getContext / 无根返回 null。
 *  收编自 7 处同形副本（成就引擎/成就库/角色卡名/玩法态/聊天元数据宿主等）。 */
export function sillyTavernContext(w?: any): any {
  const st = sillyTavernRoot(w);
  if (!st) return null;
  try {
    return typeof st.getContext === 'function' ? st.getContext() : null;
  } catch (_e) {
    return null;
  }
}

/** 根 + st 解包：有 getContext() 取上下文（**不吞其抛错**，交调用方 catch），否则返回根本身。
 *  storage-hard-reset / storage-v3-silly-host 的变体（请求头兜底链依赖外层 catch）。 */
export function sillyTavernContextOrRoot(w?: any): any {
  const st = sillyTavernRoot(w);
  if (!st) return null;
  return typeof st.getContext === 'function' ? st.getContext() : st;
}

/** 当前聊天标识（chatId 优先，回退 chat_metadata.file_name；取不到 undefined）。
 *  原 achievement-engine / achievement-store 两份逐字双胞胎收编（U32①）。 */
export function currentSillyChatId(): string | undefined {
  try {
    const ctx = sillyTavernContext();
    if (ctx && ctx.chatId) return String(ctx.chatId);
    if (ctx && ctx.chat_metadata?.file_name) return String(ctx.chat_metadata.file_name);
  } catch (e) { /* ignore */ }
  return undefined;
}
