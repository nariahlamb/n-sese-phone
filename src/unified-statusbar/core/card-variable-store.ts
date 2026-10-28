// ===== 角色卡变量统一读写口（TavernHelper `{type:'character'}` 家族）=====
//
// 「角色卡级」数据的唯一存储口：值随角色卡文件走——同步角色卡即同步（多设备），
// 删除角色卡即随卡消失；不占项目自己的存储（story/全局索引/外部文件），因此不会在
// 删卡后留下孤儿数据（浏览器缓存类存储无法跨设备同步，故不采用）。
// 现状使用者：玩法已选（play-state-store）、角色卡条目黑名单（card-entry-blacklist）、
// 世界演化风格选择（world-engine/world-style-library）。
//
// 语义约定（调用方按此处理，不要各自造轮子）：
//   · 读 readCardVariables：无卡/无 API/抛错一律 {}（调用方按「没设置过」处理，绝不打断请求路径）。
//   · 写 assignCardVariables / deleteCardVariables：成功 true、失败 false（失败必须回报用户，不许假装成功）。
//   · 清空即删键：不再需要某个设置时用 deleteCardVariables 清键，不给角色卡留空壳键。
import { getTavernHelper, sillyTavernContext } from './env';

/** 当前是否处于「单个角色卡」上下文：群聊 / 欢迎页 / 异常上下文一律 false（角色卡变量只在此时可用）。 */
export function hasCharacterCardContext(): boolean {
  try {
    const ctx = sillyTavernContext();
    if (!ctx || ctx.groupId) return false;
    const cid = ctx.characterId;
    return cid !== undefined && cid !== null && cid !== '';
  } catch (_e) {
    return false;
  }
}

/** 读整份角色卡变量表（无卡/无 API/抛错 → {}）。 */
export function readCardVariables(): Record<string, any> {
  const api = getTavernHelper();
  if (!api || typeof api.getVariables !== 'function') return {};
  try {
    const variables = api.getVariables({ type: 'character' });
    return variables && typeof variables === 'object' ? variables as Record<string, any> : {};
  } catch (_e) {
    return {};
  }
}

/** 写入若干键（存在即覆盖、不存在即新增）。返回是否成功。 */
export function assignCardVariables(values: Record<string, any>): boolean {
  const api = getTavernHelper();
  if (!api || typeof api.insertOrAssignVariables !== 'function') return false;
  try {
    api.insertOrAssignVariables(values, { type: 'character' });
    return true;
  } catch (_e) {
    return false;
  }
}

/** 删除若干键（键不存在也算成功）。返回是否成功。 */
export function deleteCardVariables(keys: string[]): boolean {
  const api = getTavernHelper();
  if (!api || typeof api.deleteVariable !== 'function') return false;
  try {
    for (const key of keys) api.deleteVariable(key, { type: 'character' });
    return true;
  } catch (_e) {
    return false;
  }
}
