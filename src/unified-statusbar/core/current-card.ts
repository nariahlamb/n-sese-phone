import { sillyTavernContext } from './env';
// ===== 当前聊天角色卡名（来源卡显示/成就解锁共用） =====
/** 群聊取 name2，否则取 characters[characterId].name，回退 name2；取不到返回 ''。 */
export function getCurrentCardName(): string {
  try {
    // U32：双窗根探测 + null 解包改走规范口（env.sillyTavernContext）
    const ctx = sillyTavernContext();
    if (!ctx) return '';
    if (ctx.groupId) {
      const n2 = typeof ctx.name2 === 'string' ? ctx.name2 : '';
      if (n2) return n2;
    }
    const ch = ctx.characters && ctx.characterId != null ? ctx.characters[ctx.characterId] : null;
    const nm = ch && typeof ch.name === 'string' ? ch.name : '';
    if (nm) return nm;
    const n2 = typeof ctx.name2 === 'string' ? ctx.name2 : '';
    return n2 || '';
  } catch (_e) { /* ignore */ }
  return '';
}
