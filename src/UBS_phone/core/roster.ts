// ===== 神数据库（AutoCardUpdater）只读读取层 =====
// 伴生纪律（docs/01 §8）：不 import 主项目 data-manager（带写回队列链），
// 直接消费全局 AutoCardUpdaterAPI 的全量快照，自建只读缓存；
// registerTableUpdateCallback 绑一次负责失效。

import { hostWindow } from './host-env';
import { matchedInsideDigitRun, parseStoryAnchor } from './social-time';

export type RosterCategory = 'romance' | 'important';

export interface RosterContact {
  name: string;
  category: RosterCategory;
  gender: string;
  age: string;
  brief: string;
  appearance: string;
  identity: string;
  languageStyle: string;
  attitude: string;
  recentIntimacy: string;
  /** 自定义联系人标记（通讯录「＋」添加、数据库无记录；true 时其余档案字段为空）。 */
  custom?: boolean;
}

export interface PresentState {
  status: string;
  emotion: string;
  /** 在场角色表「当前穿搭」+ 六件套（生图提示词用；通讯录等不消费）。 */
  outfit: string;
  top: string;
  bottom: string;
  inner: string;
  socks: string;
  shoes: string;
  acc: string;
}

/** NSFW信息表体型静态资料（按姓名；生图提示词用）。 */
export interface BodyData {
  heightWeight: string;
  measure: string;
}

/** 主角信息表第 2 行资料（生图提示词用；姓名另见 protagonistName）。 */
export interface ProtagonistInfo {
  gender: string;
  age: string;
  appearance: string;
  identity: string;
  condition: string;
}

export interface RelationPair {
  a: string;
  b: string;
  type: string;
  state: string;
}

export interface RosterSnapshot {
  /** 神数据库是否可用（表快照非空）。 */
  hasDb: boolean;
  /** 主角信息表姓名（缺省回退 {{user}} 宏展开名）。 */
  protagonistName: string;
  /** 酒馆 persona 名（{{user}}）。 */
  userName: string;
  contacts: RosterContact[];
  present: Record<string, PresentState>;
  global: { location: string; time: string; isNsfw: boolean };
  relations: RelationPair[];
  /** NSFW信息表体型资料（姓名 → 身高体重/三围罩杯）。 */
  bodyData: Record<string, BodyData>;
  /** 主角信息表资料列（生图提示词用）。 */
  protagonist: ProtagonistInfo;
  /** 人物性格偏移表（姓名 → 五列拼接文本；仅该角色本人视角可注入，游戏中心私有层用）。 */
  personality: Record<string, string>;
}

interface SheetLike {
  name?: unknown;
  content?: unknown;
}

function getAutoCardAPI(): any {
  // 瑟瑟台账（SeseLedger）canonical 优先；未装载回落 AutoCardUpdaterAPI（真数据库/台账别名）。
  try {
    const w = hostWindow() as any;
    if (w.SeseLedgerAPI) return w.SeseLedgerAPI.__legacyFace || w.SeseLedgerAPI;
    if (w.AutoCardUpdaterAPI) return w.AutoCardUpdaterAPI;
  } catch (_e) { /* ignore */ }
  try {
    const win = (window as any);
    if (win.SeseLedgerAPI) return win.SeseLedgerAPI.__legacyFace || win.SeseLedgerAPI;
    if (win.AutoCardUpdaterAPI) return win.AutoCardUpdaterAPI;
  } catch (_e) { /* ignore */ }
  return null;
}

let _cache: RosterSnapshot | null = null;
let _cacheAt = 0;
/** 空快照（无数据库）短 TTL：数据库插件晚于小手机就绪时能自动被发现；有数据则常驻（表格回调负责失效）。 */
const EMPTY_CACHE_TTL_MS = 3000;

export function invalidateRosterCache(): void {
  _cache = null;
  _cacheAt = 0;
  for (const listener of _rosterInvalidatedListeners) {
    try { listener(); } catch (_e) { /* 伴生故障不阻断失效 */ }
  }
}

/** 快照失效监听（消息记录世界书投影等伴生订阅；回调自负责门控，未订阅零开销）。 */
const _rosterInvalidatedListeners: Array<() => void> = [];

export function onRosterInvalidated(cb: () => void): void {
  if (!_rosterInvalidatedListeners.includes(cb)) _rosterInvalidatedListeners.push(cb);
}

/** 表格回调失效绑定（守卫防重）。返回是否首次绑定。 */
export function bindRosterInvalidation(): boolean {
  const w = hostWindow() as any;
  if (w.__ubp_roster_bound) return false;
  const api = getAutoCardAPI();
  if (!api || typeof api.registerTableUpdateCallback !== 'function') return false;
  w.__ubp_roster_bound = true;
  // 跨 iframe 重注入替换：回调按闭包身份挂在宿主 API 上，上一份手机 iframe 的闭包无法从本窗口摘除
  // （__ubp_roster_bound 只防同窗口重求值）——回调存「父窗口」引用一份，重注册前先注销旧的
  // （台账侧 unregisterTableUpdateCallback 已实现真注销；真数据库无此方法时退回旧行为）。
  const hostW: any = (() => {
    try { const p = w.parent; if (p && p !== w) return p; } catch (_e) { /* cross-origin */ }
    return w;
  })();
  try {
    const staleCb = hostW.__ubp_roster_cb;
    if (staleCb && typeof api.unregisterTableUpdateCallback === 'function') {
      api.unregisterTableUpdateCallback(staleCb);
      hostW.__ubp_roster_cb = null;
    }
  } catch (_e) { /* ignore */ }
  try {
    const cb = () => invalidateRosterCache();
    api.registerTableUpdateCallback(cb);
    try { hostW.__ubp_roster_cb = cb; } catch (_e) { /* ignore */ }
  } catch (_e) {
    w.__ubp_roster_bound = false;
    return false;
  }
  return true;
}

function buildSheetIndex(api: any): Record<string, SheetLike> | null {
  let all: any;
  try {
    all = api.exportTableAsJson();
  } catch (_e) {
    return null;
  }
  if (!all || typeof all !== 'object') return null;
  const index: Record<string, SheetLike> = {};
  let count = 0;
  for (const key of Object.keys(all)) {
    if (!key.startsWith('sheet_')) continue;
    const sheet = all[key];
    if (!sheet || typeof sheet !== 'object' || !Array.isArray(sheet.content)) continue;
    if (typeof sheet.name === 'string' && sheet.name) {
      index[sheet.name] = sheet;
      count++;
    }
  }
  return count > 0 ? index : null;
}

function cell(sheet: SheetLike | undefined, rowIndex: number, colName: string): string {
  if (!sheet || !Array.isArray(sheet.content)) return '';
  const rows = sheet.content as unknown[][];
  const headers = rows[0] || [];
  // 与主项目 getCellByHeader 同款 indexOf（勿改 findIndex(h=>…)：裸参数 h 会被
  // unplugin-auto-import 误注入 import {h} from 'vue' → 打包成全局 Vue 外部引用）
  const colIdx = headers.indexOf(colName);
  if (colIdx === -1) return '';
  const value = rows[rowIndex]?.[colIdx];
  if (value == null) return '';
  const text = String(value).trim();
  return text === '无' || text === '-' ? '' : text;
}

/** 年龄显示：新库「生日」列（YYYY-MM-DD）按全局数据表当前时间推算周岁；
 *  旧库「年龄」列文本（“20岁”/纯数字）原样透传（纯数字补“岁”）。
 *  年份幅值接受 1-6 位——四位纪年为常态，五位以上（14900）截断会算错整万年（14900 → 4900）。 */
function resolveAgeText(sheet: SheetLike | undefined, rowIndex: number, todayText: string): string {
  const value = (cell(sheet, rowIndex, '生日') || cell(sheet, rowIndex, '年龄') || '').trim();
  if (!value) return '';
  // F58(第十二轮)：两处都改走规范解析——
  // ① 生日裸正则补 ≥7 位年份护栏（否则 1234567-01-01 会从第 2 个字符起匹配成 234567-01-01）；
  // ② 「当前时间」此前只认横线格式，而规范写法含中文式「2026年9月3日 14:20 周五」⇒ 匹配失败后
  //    落到末行把生日原文当年龄返回（通讯录/资料卡/电话簿整列退化，并污染给 AI 的档案段）。
  const bm = value.match(/(-?\d{1,6})-(\d{1,2})-(\d{1,2})/);
  const b = bm && !matchedInsideDigitRun(value, bm.index) ? bm : null;
  const todayKey = parseStoryAnchor(todayText).date;
  const t = b && todayKey ? todayKey.match(/^(-?\d{1,6})-(\d{1,2})-(\d{1,2})$/) : null;
  if (b && t) {
    const md = (x: RegExpMatchArray) => `${String(parseInt(x[2], 10)).padStart(2, '0')}-${String(parseInt(x[3], 10)).padStart(2, '0')}`;
    let age = parseInt(t[1], 10) - parseInt(b[1], 10);
    if (md(t) < md(b)) age -= 1;
    if (age >= 0) return `${age}岁`;
  }
  return /^\d+(?:\.\d+)?$/.test(value) ? `${value}岁` : value;
}

function readContactTable(sheets: Record<string, SheetLike>, tableName: string, category: RosterCategory): RosterContact[] {
  const sheet = sheets[tableName];
  if (!sheet || !Array.isArray(sheet.content)) return [];
  const rows = sheet.content as unknown[][];
  const todayText = cell(sheets['全局数据表'], 1, '当前时间');
  const out: RosterContact[] = [];
  for (let i = 1; i < rows.length; i++) {
    const name = cell(sheet, i, '姓名');
    if (!name) continue;
    if (out.some(c => c.name === name)) continue;
    out.push({
      name,
      category,
      gender: cell(sheet, i, '性别'),
      age: resolveAgeText(sheet, i, todayText),
      brief: cell(sheet, i, '一句话介绍'),
      appearance: cell(sheet, i, '外貌特征'),
      identity: cell(sheet, i, '身份'),
      languageStyle: cell(sheet, i, '语言风格和口癖'),
      attitude: cell(sheet, i, '对主角态度'),
      recentIntimacy: cell(sheet, i, '最近亲密互动'),
    });
  }
  return out;
}

function readRelations(sheets: Record<string, SheetLike>, names: string[]): RelationPair[] {
  const sheet = sheets['人物关系表'];
  if (!sheet || !Array.isArray(sheet.content)) return [];
  const rows = sheet.content as unknown[][];
  const nameSet = new Set(names);
  const out: RelationPair[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = cell(sheet, i, '人物A');
    const b = cell(sheet, i, '人物B');
    if (!a || !b) continue;
    if (!nameSet.has(a) && !nameSet.has(b)) continue;
    out.push({ a, b, type: cell(sheet, i, '关系类型'), state: cell(sheet, i, '当前状态') });
  }
  return out;
}

/** 性格偏移列（与主项目 character-hub-model parsePersonalityShift 同表同列；【禁止臆测】警告段不注入）。 */
const PERSONALITY_SHIFT_COLS = ['近期情绪状态', '对主角的交互逻辑', '被强化的性格侧面', '被弱化的性格侧面', '行为模式变化'] as const;

/** 读人物性格偏移表（姓名 → 五列非空拼接「列名：值；」；空表/无数据=空 map）。 */
function readPersonalityShifts(sheets: Record<string, SheetLike>): Record<string, string> {
  const sheet = sheets['人物性格偏移表'];
  if (!sheet || !Array.isArray(sheet.content)) return {};
  const rows = sheet.content as unknown[][];
  const out: Record<string, string> = {};
  for (let i = 1; i < rows.length; i++) {
    const name = cell(sheet, i, '姓名');
    if (!name) continue;
    const parts: string[] = [];
    for (const col of PERSONALITY_SHIFT_COLS) {
      const value = cell(sheet, i, col);
      if (value) parts.push(`${col}：${value.split('【禁止臆测】')[0].trim()}`);
    }
    if (parts.length) out[name] = parts.join('；');
    if (Object.keys(out).length >= 120) break;
  }
  return out;
}

function readMacroUser(): string {
  try {
    const w = hostWindow() as any;
    const helper = (w.TavernHelper || (window as any).TavernHelper);
    if (helper && typeof helper.substitudeMacros === 'function') {
      const expanded = String(helper.substitudeMacros('{{user}}') || '').trim();
      if (expanded && expanded !== '{{user}}') return expanded;
    }
  } catch (_e) { /* ignore */ }
  return '';
}

/** 取通讯录/在场/全局/关系快照（缓存；表格回调自动失效；空快照 3s TTL）。 */
export function getRoster(): RosterSnapshot {
  if (_cache && (_cache.hasDb || Date.now() - _cacheAt < EMPTY_CACHE_TTL_MS)) return _cache;
  _cacheAt = Date.now();
  const api = getAutoCardAPI();
  const sheets = api ? buildSheetIndex(api) : null;
  const userName = readMacroUser();

  if (!api || !sheets) {
    _cache = {
      hasDb: false,
      protagonistName: userName || '我',
      userName: userName || '我',
      contacts: [],
      present: {},
      global: { location: '', time: '', isNsfw: false },
      relations: [],
      bodyData: {},
      protagonist: { gender: '', age: '', appearance: '', identity: '', condition: '' },
      personality: {},
    };
    return _cache;
  }

  const romance = readContactTable(sheets, '恋爱对象表', 'romance');
  const important = readContactTable(sheets, '重要角色表', 'important');
  // 两表重名：恋爱对象优先
  const seen = new Set(romance.map(c => c.name));
  const contacts = [...romance, ...important.filter(c => !seen.has(c.name))];

  const presentSheet = sheets['在场角色表'];
  const present: Record<string, PresentState> = {};
  if (presentSheet && Array.isArray(presentSheet.content)) {
    const rows = presentSheet.content as unknown[][];
    for (let i = 1; i < rows.length; i++) {
      const name = cell(presentSheet, i, '姓名');
      if (!name) continue;
      present[name] = {
        status: cell(presentSheet, i, '当前状态'),
        emotion: cell(presentSheet, i, '情绪'),
        outfit: cell(presentSheet, i, '当前穿搭'),
        top: cell(presentSheet, i, '上装'),
        bottom: cell(presentSheet, i, '下装'),
        inner: cell(presentSheet, i, '内衣/内裤'),
        socks: cell(presentSheet, i, '袜子'),
        shoes: cell(presentSheet, i, '鞋子'),
        acc: cell(presentSheet, i, '饰品'),
      };
    }
  }

  // NSFW信息表：体型静态资料（姓名 → 身高体重/三围罩杯），生图提示词用
  const bodyData: Record<string, BodyData> = {};
  const nsfwSheet = sheets['NSFW信息表'];
  if (nsfwSheet && Array.isArray(nsfwSheet.content)) {
    const rows = nsfwSheet.content as unknown[][];
    for (let i = 1; i < rows.length; i++) {
      const name = cell(nsfwSheet, i, '姓名');
      if (!name) continue;
      const heightWeight = cell(nsfwSheet, i, '身高/体重');
      const measure = cell(nsfwSheet, i, '三围/罩杯');
      if (!heightWeight && !measure) continue;
      bodyData[name] = { heightWeight, measure };
    }
  }

  const globalSheet = sheets['全局数据表'];
  const nsfwRaw = cell(globalSheet, 1, '是否色色');
  const protagonistSheet = sheets['主角信息表'];
  const protagonistName = (protagonistSheet ? cell(protagonistSheet, 1, '姓名') : '') || userName || '我';
  // 主角年龄：新库「生日」列按全局数据表当前时间推算周岁；旧库「年龄」列透传（旧年龄兜底，未来删除）
  const todayText = cell(globalSheet, 1, '当前时间');
  const protagonist: ProtagonistInfo = {
    gender: protagonistSheet ? cell(protagonistSheet, 1, '性别') : '',
    age: resolveAgeText(protagonistSheet, 1, todayText),
    appearance: protagonistSheet ? cell(protagonistSheet, 1, '外貌特征') : '',
    identity: protagonistSheet ? cell(protagonistSheet, 1, '身份背景') : '',
    condition: protagonistSheet ? cell(protagonistSheet, 1, '近况') : '',
  };

  _cache = {
    hasDb: true,
    protagonistName,
    userName: userName || protagonistName || '我',
    contacts,
    present,
    global: {
      location: cell(globalSheet, 1, '当前详细地点'),
      time: cell(globalSheet, 1, '当前时间'),
      isNsfw: nsfwRaw === '是' || nsfwRaw.toLowerCase() === 'true',
    },
    relations: readRelations(sheets, [protagonistName, ...contacts.map(c => c.name)]),
    bodyData,
    protagonist,
    personality: readPersonalityShifts(sheets),
  };
  return _cache;
}

/** 按名找联系人（精确 > 唯一子串）。 */
export function findContact(roster: RosterSnapshot, name: string): RosterContact | null {
  const exact = roster.contacts.find(c => c.name === name);
  if (exact) return exact;
  const hits = roster.contacts.filter(c => c.name.includes(name) || name.includes(c.name));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 数据库通讯录合并自定义联系人（微信/电话两 App 共用）：数据库优先（同名让位），
 * 自定义条目=空档案 + custom 标记（UI 据此显示占位文案与删除入口）。纯函数不改写入参。
 */
export function mergeCustomContacts(roster: RosterSnapshot, customNames: readonly string[]): RosterContact[] {
  const known = new Set(roster.contacts.map(c => c.name));
  const extra = Array.from(new Set((customNames || []).filter(n => n && !known.has(n))));
  return [
    ...roster.contacts,
    ...extra.map(name => ({
      name, category: 'important' as const, gender: '', age: '', brief: '', appearance: '',
      identity: '', languageStyle: '', attitude: '', recentIntimacy: '', custom: true,
    })),
  ];
}

/** 合并视图下的全部联系人名（数据库通讯录 + 自定义联系人；微信/电话/窥私候选池与投影名单同一口径）。
 *  窥私侧四处（弹窗候选/引擎焦点池/投影条目名集/签名 names 段）必须统一走这里——否则出现「能选到但生成侧被静默换人」。 */
export function mergedContactNames(roster: RosterSnapshot, customNames: readonly string[]): string[] {
  return mergeCustomContacts(roster, customNames).map(c => c.name);
}
