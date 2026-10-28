// ===== 角色卡世界书条目黑名单（按角色卡勾选「不参与 1A 请求」的条目）=====
//
// 与全局条目黑名单（config.entryBlacklist，正则、跨卡）**并行叠加**：本名单按角色卡保存，
// 值存角色卡变量（见 card-variable-store），命中口径为**条目名精确相等**（trim 后）——
// 比正则更可预期：勾哪个名字就排除哪个名字，不做子串/大小写宽松匹配。
// 名单只由选择弹窗写（renderers/card-entry-blacklist-popup.ts）；选择面只列用户自己的条目
// （受管族 TavernDB / UBS / [UBS手机] 不展示——它们由各功能自己的 suspend 谓词负责）。
// 生效点：core/worldbook-entry.ts 的 worldinfo_entries_loaded 钩子（与全局黑名单同一循环，
// 主项目 1A 请求 + 小手机微信/电话共享）。
import { assignCardVariables, deleteCardVariables, readCardVariables } from './card-variable-store';

/** 角色卡变量键（值 = string[] 条目名清单）。 */
export const CARD_ENTRY_BLACKLIST_KEY = '__unified_statusbar_entry_blacklist_v1';

/** 归一化：非数组/坏项 → []；逐项 trim、去空、去重（保序）。 */
export function normalizeCardEntryBlacklist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 读当前角色卡的名单（无卡/无 API/抛错 → []）。 */
export function readCardEntryBlacklist(): string[] {
  return normalizeCardEntryBlacklist(readCardVariables()[CARD_ENTRY_BLACKLIST_KEY]);
}

/** 写当前角色卡的名单（空名单 = 删键，不留空壳键）。返回是否成功。 */
export function writeCardEntryBlacklist(names: string[]): boolean {
  const normalized = normalizeCardEntryBlacklist(names);
  if (normalized.length === 0) return deleteCardVariables([CARD_ENTRY_BLACKLIST_KEY]);
  return assignCardVariables({ [CARD_ENTRY_BLACKLIST_KEY]: normalized });
}

/** 名单拆成「仍有效」与「已失效」：失效 = 当前可见条目里找不到该名（条目被改名/删除，
 *  或所属世界书本次读取失败）。弹窗据此提示并支持一键清除；勾选只改有效项、不静默丢失效项。 */
export function splitStaleCardEntryBlacklist(
  stored: string[],
  available: Set<string>,
): { effective: string[]; stale: string[] } {
  const effective: string[] = [];
  const stale: string[] = [];
  for (const name of stored) {
    if (available.has(name)) effective.push(name);
    else stale.push(name);
  }
  return { effective, stale };
}
