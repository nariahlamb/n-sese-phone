import { getTavernHelper } from './env';
import { tryEvalWorldbookEjs } from './ejs-bridge';
import { getConfig } from './config-store';
import { readCardEntryBlacklist } from './card-entry-blacklist';
// ===== 世界书条目字段读取与匹配（兼容 raw 与 normalized 两种运行时格式） =====
// TavernHelper 的 getWorldbook() 返回的条目，字段位置随版本不同：
//   - 显示名：normalized 用 entry.name，旧版/raw 用 entry.comment → 一律 comment||name
//   - 触发关键词：normalized 在 entry.strategy.keys / strategy.keys_secondary.keys；
//     raw 在 entry.key / entry.keysecondary → 两者都读
// 统一从这里取，避免各调用点各自只读单字段（曾因此漏读 name 致整批条目匹配为空）。
//
// 匹配语义：把「名字匹配」和「触发关键词匹配」拆成两个独立原语，调用方按需组合。
//   - 地点（路径型）：名字用末两段逐段子串，触发词用末两段拼串做双向子串 —— 两者用不同 term 集合。
//   - 角色（非路径型）：名字与触发词用同一组角色名 —— 用 wbEntryMatchedKeywords 一次性取命中。

/** 条目显示名（comment 旧版 / name 新版，trim 后返回）。
 *  W5 口径修正：与项目铁律③一致用 `comment || name`——comment 为空串时回退读 name
 *  （原 `??` 只认 undefined/null，空串会把真名漏成空，与各手写调用点行为相悖）。 */
export function wbEntryName(entry: any): string {
  return String(entry?.comment || entry?.name || '').trim();
}

/** 按精确条目名取下标（-1 = 无）。U61 单源：原 5 处手写 `(e.comment||e.name||'')===name`。 */
export function wbEntryIndexByName(entries: any[], name: string): number {
  return entries.findIndex(e => wbEntryName(e) === name);
}

/** 单条目·字符串 content 的受管条目 reconcile 状态机（U60 单源：skill/currency 世界书投影原各持逐字同构一份）。
 *  语义：无内容且条目不存在 → 不动；无内容但条目在 → 删；有内容但条目不在 → 新建；
 *  内容与 enabled 都没变 → 不动；否则整条新对象替换（铁律②）。 */
export function reconcileSingleManagedEntry(
  entries: any[],
  opts: { content: string; isMine: (entry: any) => boolean; makeEntry: (content: string) => any },
): boolean {
  const index = entries.findIndex(entry => opts.isMine(entry));
  if (!opts.content) {
    if (index < 0) return false;
    entries.splice(index, 1);
    return true;
  }
  if (index < 0) {
    entries.push(opts.makeEntry(opts.content));
    return true;
  }
  if (entries[index].content === opts.content && entries[index].enabled === true) return false;
  entries[index] = { ...entries[index], content: opts.content, enabled: true };
  return true;
}

/** 条目的全部触发关键词（主关键词 + 次关键词，去空白；RegExp 取 source） */
export function wbEntryKeys(entry: any): string[] {
  const out: string[] = [];
  const push = (v: any) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) out.push(s);
    } else if (Array.isArray(v)) {
      for (const x of v) push(x);
    } else if (typeof v?.source === 'string') {
      const s = v.source.trim();
      if (s) out.push(s);
    }
  };
  push(entry?.key);                             // raw 主关键词
  push(entry?.keysecondary);                    // raw 次关键词
  push(entry?.strategy?.keys);                  // normalized 主关键词
  push(entry?.strategy?.keys_secondary?.keys);  // normalized 次关键词
  return out;
}

/** 条目名是否包含任一 term（子串匹配）。 */
export function wbEntryNameContainsAny(entry: any, terms: string[]): boolean {
  if (!terms || terms.length === 0) return false;
  const name = wbEntryName(entry);
  for (const t of terms) {
    if (t && name.includes(t)) return true;
  }
  return false;
}

/** 条目触发关键词是否与任一 term 互为子串（双向）。
 *  双向兼顾「term=B家、key=B家卧室」与「term=B家-C房间、key=B家」两种情形。 */
export function wbEntryKeysMatchAny(entry: any, terms: string[]): boolean {
  if (!terms || terms.length === 0) return false;
  const keys = wbEntryKeys(entry);
  if (keys.length === 0) return false;
  for (const t of terms) {
    if (!t) continue;
    for (const k of keys) {
      if (k.includes(t) || t.includes(k)) return true;
    }
  }
  return false;
}

/** 返回命中的 term 子集：条目名含该 term，或触发关键词与该 term 互为子串。
 *  适用于「角色名」这类非路径 term（名字与触发词共用同一组 term）。 */
export function wbEntryMatchedKeywords(entry: any, terms: string[]): string[] {
  if (!terms || terms.length === 0) return [];
  const name = wbEntryName(entry);
  const keys = wbEntryKeys(entry);
  const hits: string[] = [];
  for (const t of terms) {
    if (!t) continue;
    if (name.includes(t)) { hits.push(t); continue; }
    if (keys.some(k => k.includes(t) || t.includes(k))) hits.push(t);
  }
  return hits;
}

// ===== 受管条目前缀 + 蓝灯/技能名/key 命中扫描（技能树生成用） =====
// 受管条目（如「主角当前技能」）用前缀标记，生成时排除以免「由表生成的条目」回喂。
// 下方三个扫描原语返回的 content 供 AI 提示词消费，统一过 EJS 求值（无插件/无模板零开销）；
// 需要原始文本（如写回）的调用方应自行 getWorldbook，勿用这三个原语。
export const SKILL_MANAGED_PREFIX = 'UBS-技能-主角当前技能';
// O18-A：旧前缀 `__skill_current` 兼容已退役（由 core/legacy-worldbook-entries.ts 统一回收）
/** 小手机正文联动格式条目前缀（UBS_phone/core/story-link 注入；只服务酒馆正常生成，自有 AI 管线一律剔除） */
export const STORY_LINK_ENTRY_PREFIX = '[UBS手机]';
// 手机记录条目族 keep 豁免前缀（本文件统一持有：statusbar 侧请求不可反向依赖小手机模块，
// 小手机侧条目名从这里派生保持单一来源）。消息记录族=主角侧记录（分角色条目「-<名>」+ 蓝灯说明条目），
// 窥私族=角色间记录（同构）；两族共用最短公共前缀做 keep 匹配，正文联动格式条目不在其内、照旧剔除。
export const MESSAGE_RECORDS_KEEP_PREFIX = '[UBS手机]消息记录';
export const SPY_RECORDS_KEEP_PREFIX = '[UBS手机]窥私记录';

/** keep 谓词：放行窥私记录族（说明条目+分角色条目）。聊天/通话/社媒用：放行角色间历史（主角仍不知情）。 */
export function keepSpyRecordEntries(name: string): boolean {
  return name.startsWith(SPY_RECORDS_KEEP_PREFIX);
}

/** keep 谓词：放行窥私记录族 + 消息记录族。窥私/采访/调查/演化用：资料块无消息记录注入，
 *  靠世界书条目丰满人物、衔接焦点角色近期的主角侧互动。 */
export function keepPhoneRecordEntries(name: string): boolean {
  return keepSpyRecordEntries(name) || name.startsWith(MESSAGE_RECORDS_KEEP_PREFIX);
}

/** 是否技能受管条目（生成时排除） */
export function isManagedSkillEntry(entry: any): boolean {
  const name = wbEntryName(entry);
  return !!(name && name.startsWith(SKILL_MANAGED_PREFIX));
}

// ===== 用户条目 vs 受管条目（选择面过滤：角色卡条目黑名单）=====
/** 本项目自投影条目前缀族（`UBS-（功能）-（条目名）`）。 */
export const UBS_ENTRY_PREFIX = 'UBS';
/** 外部数据库插件条目前缀族（`TavernDB-ACU-…` 全族）。 */
export const DB_PLUGIN_ENTRY_PREFIX = 'TavernDB';
/** 瑟瑟台账（SeseLedger）投影条目前缀族（`SeseLedger-表名：关键词` 行投影 + 包裹/纪要包裹条目）。 */
export const LEDGER_ENTRY_PREFIX = 'SeseLedger';

/** 是否「用户自己的条目」：非空、且不属于数据库/瑟瑟台账/本项目/小手机四个受管族
 *  （台账族 = 台账投影进角色主世界书的条目；词根改口径须与 sese-ledger/core/lens.ts 的
 *  CUSTOM_EXPORT_PREFIX 同步）。角色卡条目黑名单的选择面按本判据过滤——受管条目由各功能
 *  自己的 suspend 谓词负责，不交给用户手工排除（也就没机会排错）。 */
export function isUserEntryName(name: unknown): boolean {
  const n = String(name ?? '').trim();
  if (!n) return false;
  return !n.startsWith(DB_PLUGIN_ENTRY_PREFIX)
    && !n.startsWith(LEDGER_ENTRY_PREFIX)
    && !n.startsWith(UBS_ENTRY_PREFIX)
    && !n.startsWith(STORY_LINK_ENTRY_PREFIX);
}


/** 遍历当前角色绑定的全部世界书条目 */
export async function iterBoundEntries(
  cb: (entry: any, wbName: string) => void | Promise<void>,
): Promise<void> {
  const w = getTavernHelper();
  if (!w || typeof w.getCharWorldbookNames !== 'function') return;
  let charWbs: any = null;
  try { charWbs = w.getCharWorldbookNames('current'); } catch (_e) { return; }
  const wbs: string[] = [];
  if (charWbs) {
    if (charWbs.primary) wbs.push(charWbs.primary);
    if (Array.isArray(charWbs.additional)) wbs.push(...charWbs.additional);
  }
  for (const wbName of wbs) {
    try {
      const entries = await w.getWorldbook(wbName);
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        await cb(entry, wbName);
      }
    } catch (_e) { /* skip single book */ }
  }
}

/** 蓝灯/常亮判定（不含启用检查与受管排除，调用方按需组合）：strategy.type==='constant' 或 raw constant===true */
export function wbEntryIsConstant(entry: any): boolean {
  return entry?.strategy?.type === 'constant' || entry?.constant === true;
}

/** 蓝灯/常亮条目：strategy.type==='constant' 且 enabled（排除受管条目） */
export async function getConstantEntries(
  max = 50,
): Promise<{ comment: string; content: string }[]> {
  const out: { comment: string; content: string }[] = [];
  await iterBoundEntries(async (entry) => {
    const enabled = entry?.enabled !== false;
    if (!enabled || !wbEntryIsConstant(entry)) return;
    if (isManagedSkillEntry(entry)) return;
    const comment = wbEntryName(entry);
    if (!comment) return;
    out.push({ comment, content: await tryEvalWorldbookEjs(entry.content) });
  });
  return out.slice(0, max);
}

/** comment/name 或 content 子串含技能名（排除受管条目） */
export async function getEntriesBySkillName(
  skillName: string,
  max = 20,
): Promise<{ comment: string; content: string }[]> {
  if (!skillName) return [];
  const out: { comment: string; content: string }[] = [];
  const seen = new Set<string>();
  await iterBoundEntries(async (entry) => {
    if (isManagedSkillEntry(entry)) return;
    const comment = wbEntryName(entry);
    if (!comment || seen.has(comment)) return;
    const content = String(entry.content || '');
    if (comment.includes(skillName) || content.includes(skillName)) {
      seen.add(comment);
      out.push({ comment, content: await tryEvalWorldbookEjs(content) });
    }
  });
  return out.slice(0, max);
}

/** 单向"文本包含 key"（额外要求文本命中条目触发关键词） */
export async function getEntriesKeysContainedBy(
  text: string,
  max = 20,
): Promise<{ comment: string; content: string }[]> {
  if (!text) return [];
  const out: { comment: string; content: string }[] = [];
  const seen = new Set<string>();
  await iterBoundEntries(async (entry) => {
    if (isManagedSkillEntry(entry)) return;
    const comment = wbEntryName(entry);
    if (!comment || seen.has(comment)) return;
    const keys = wbEntryKeys(entry);
    if (keys.length === 0) return;
    if (keys.some((k) => k && text.includes(k))) {
      seen.add(comment);
      out.push({ comment, content: await tryEvalWorldbookEjs(entry.content) });
    }
  });
  return out.slice(0, max);
}

// ===== 原生世界书槽位请求的扫描前准备（1A 同构三段式专用） =====
// 1A 同构请求把 world_info_before/after 槽位交还酒馆原生机制（getWorldInfoPrompt 填槽），
// 条目内容由酒馆扫描激活。原生填槽不做条目级 EJS 求值（V3.668 实机：裸模板直发 AI），
// 也无法按请求排除本项目自投影条目。
//
// 处理方式：挂 ST 事件 worldinfo_entries_loaded（getSortedEntries 在合并/排序前发射，
// payload={globalLore,characterLore,chatLore,personaLore}，且四个数组是每次调用新建的条目对象副本）。
// withNativeScanWorldbook 在 run 前置一次性 pending 配置，事件命中时：
//   · suspend 命中的条目从数组移除（仅本次扫描不可见，世界书底账不动）；
//   · 含 EJS 条目就地渲染（story-oracle renderWiEjs entry 级语义：展宏+evalTemplate{world_info:entry}，失败回原文）。
// 一次性语义：配置只作用于其后第一次世界书装载，消费即清——并发请求（如填表）互不误伤；
// 若本请求的装载被其它在途装载抢先消费，本请求退化为不过滤/不渲染（良性：仅可能重复自投影）。
// 失败放行：事件源不可用（旧版 ST）或处理抛错都不阻断请求。
export interface NativeScanPrepareOptions {
  /** 命中即从本次扫描中剔除的条目谓词（自投影防回喂/去重）。 */
  suspend?: (entry: any) => boolean;
  /** [UBS手机] 前缀剔除的豁免谓词（条目名命中则保留本次扫描）：聊天/通话/社媒放行窥私族（keepSpyRecordEntries），
   *  窥私/采访/调查/演化放行窥私族+消息记录族（keepPhoneRecordEntries）。 */
  keep?: (name: string) => boolean;
  /** 是否对含 EJS 的条目做扫描前求值；默认 true。 */
  renderEjs?: boolean;
}

const NATIVE_SCAN_EVENT = 'worldinfo_entries_loaded';
let _nativeScanHookInstalled = false;
let _nativeScanPending: NativeScanPrepareOptions | null = null;

// ===== 条目黑名单（设置 → API，1A 同构请求通用条目过滤） =====
// 两份名单**并行叠加**，任一命中即剔除：
//   · 全局名单（config.entryBlacklist）：每行一个正则（默认忽略英文大小写，普通字符即普通子串），跨角色卡；
//   · 角色卡名单（card-entry-blacklist，值存角色卡变量）：条目名**精确相等**，按角色卡保存、随卡同步。
// 命中条目在本次装载中剔除——不进提示词、不参与绿灯扫描，蓝灯常亮一并剔除，世界书底账不动。
// 仅作用于挂了 withNativeScanWorldbook 的请求（主项目 7 个 1A 同构 + 小手机微信/电话，共享本设置）；
// 宅仙问答、地图、立绘、瑟瑟指导等其余请求不受影响。非法正则跳过并控制台警告。
let _entryBlacklistOverride: RegExp[] | null = null; // 测试注入点
export function __setEntryBlacklistForTests(patterns: string[] | null): void {
  _entryBlacklistOverride = patterns === null ? null : compileEntryBlacklist(patterns);
}

function compileEntryBlacklist(lines: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const line of lines) {
    const pattern = String(line ?? '').trim();
    if (!pattern) continue;
    try {
      out.push(new RegExp(pattern, 'i'));
    } catch (e) {
      console.warn('[条目黑名单] 非法正则已跳过:', pattern, e);
    }
  }
  return out;
}

function getEntryBlacklistPatterns(): RegExp[] {
  if (_entryBlacklistOverride) return _entryBlacklistOverride;
  try {
    const tags = getConfig()?.entryBlacklist;
    if (!Array.isArray(tags) || tags.length === 0) return [];
    return compileEntryBlacklist(tags);
  } catch (_e) {
    return []; // 配置读取失败视为未配置，不阻断请求
  }
}

/** 本卡名单（精确名集合）；每次装载读一次角色卡变量（几十字节的内存读，非读盘）。 */
function getCardEntryBlacklistNames(): Set<string> {
  try {
    const names = readCardEntryBlacklist();
    return names.length ? new Set(names) : _EMPTY_NAME_SET;
  } catch (_e) {
    return _EMPTY_NAME_SET; // 读失败视为未配置，不阻断请求
  }
}
const _EMPTY_NAME_SET: Set<string> = new Set();

function ensureNativeScanHook(): boolean {
  if (_nativeScanHookInstalled) return true;
  try {
    const rawSt: any = (typeof window !== 'undefined' ? (window as any).SillyTavern : undefined)
      || (typeof window !== 'undefined' ? (window as any).TavernHelper?.SillyTavern : undefined);
    const st: any = typeof rawSt?.getContext === 'function' ? rawSt.getContext() : rawSt;
    const source = st?.eventSource;
    if (!source || typeof source.on !== 'function') return false;
    source.on(NATIVE_SCAN_EVENT, async (payload: any) => {
      const opts = _nativeScanPending;
      if (!opts) return;
      _nativeScanPending = null; // 一次性：消费即清，只作用于其后第一次世界书装载
      const blacklist = getEntryBlacklistPatterns();
      const cardBlacklist = getCardEntryBlacklistNames(); // 角色卡名单（精确名；未设置时为空集）
      for (const arr of [payload?.globalLore, payload?.characterLore, payload?.chatLore, payload?.personaLore]) {
        if (!Array.isArray(arr)) continue;
        for (let i = arr.length - 1; i >= 0; i--) {
          const entry = arr[i];
          if (!entry) continue;
          if (opts.suspend?.(entry)) { arr.splice(i, 1); continue; }
          const nm = wbEntryName(entry);
          // [UBS手机] 前缀条目默认剔除：正文联动格式条目只服务酒馆正常生成；消息记录/窥私记录族按请求 keep 豁免
          // （聊天/通话/社媒放行窥私族；窥私/采访/调查/演化放行窥私族+消息记录族——见 keepSpyRecordEntries/keepPhoneRecordEntries）
          if (nm && nm.startsWith(STORY_LINK_ENTRY_PREFIX) && !opts.keep?.(nm)) { arr.splice(i, 1); continue; }
          if (blacklist.length && nm && blacklist.some(re => re.test(nm))) { arr.splice(i, 1); continue; }
          if (cardBlacklist.size && nm && cardBlacklist.has(nm)) { arr.splice(i, 1); continue; }
          if (opts.renderEjs === false) continue;
          const raw = String(entry.content ?? '');
          if (!raw.includes('<%')) continue;
          // story-oracle entry 级语义：先展宏，再以 {world_info: entry} 为上下文求值；失败回原文
          let text = raw;
          try {
            const th = getTavernHelper();
            if (th && typeof th.substitudeMacros === 'function') text = th.substitudeMacros(text);
          } catch (_e) { /* 展宏失败用原文 */ }
          try {
            const rendered = await tryEvalWorldbookEjs(text, { world_info: entry });
            if (rendered !== raw) entry.content = rendered;
          } catch (_e) { /* 渲染失败保留原文（tryEvalWorldbookEjs 内部已兜底） */ }
        }
      }
    });
    _nativeScanHookInstalled = true;
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 以「原生世界书槽位」语义运行一次 AI 请求：run 前置一次性扫描配置，
 * 本次请求的世界书装载（worldinfo_entries_loaded）触发时按配置剔除/渲染，结束后自动失效。
 * 返回 run 的返回值。
 */
export async function withNativeScanWorldbook<T>(
  options: NativeScanPrepareOptions,
  run: () => Promise<T>,
): Promise<T> {
  if (!ensureNativeScanHook()) return await run();
  _nativeScanPending = options;
  try {
    return await run();
  } finally {
    if (_nativeScanPending === options) _nativeScanPending = null; // 请求未触发装载时的兜底清理
  }
}
