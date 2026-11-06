import { getLedgerCanonical } from '../../unified-statusbar/core/ledger-takeover';

export interface PhoneFieldContract {
  table: string;
  column?: string;
  feature: string;
  required?: boolean;
  optionalReason?: string;
}

const fields = (table: string, feature: string, columns: readonly string[]): PhoneFieldContract[] =>
  columns.map(column => ({ table, column, feature, required: true }));

export const PHONE_FIELD_CONTRACTS: readonly PhoneFieldContract[] = [
  ...fields('全局数据表', '通讯录与故事时间', ['当前详细地点', '当前时间', '是否色色']),
  ...fields('主角信息表', '主角资料', ['姓名', '性别', '生日', '外貌特征', '身份背景', '近况']),
  ...fields('恋爱对象表', '通讯录与角色资料', ['姓名', '性别', '生日', '一句话介绍', '外貌特征', '身份', '语言风格和口癖', '对主角态度', '最近亲密互动']),
  ...fields('重要角色表', '通讯录与角色资料', ['姓名', '性别', '生日', '一句话介绍', '外貌特征', '身份', '语言风格和口癖', '对主角态度', '过往经历']),
  ...fields('在场角色表', '通讯录在场状态', ['姓名', '当前状态', '情绪']),
  ...fields('在场角色表', '角色穿搭资料', ['当前穿搭', '上装', '下装', '内衣/内裤', '袜子', '鞋子', '饰品']),
  ...fields('NSFW信息表', '角色体型资料', ['姓名', '身高/体重', '三围/罩杯']),
  ...fields('人物关系表', '角色关系资料', ['人物A', '人物B', '关系类型', '关系状态']),
  ...fields('人物性格偏移表', '游戏中心角色私有资料', ['姓名', '近期情绪状态', '对主角的交互逻辑', '被强化的性格侧面', '被弱化的性格侧面', '行为模式变化']),
  ...fields('纪要表', '聊天与社交纪要资料', ['时间跨度', '概览', '纪要', '重要对话']),
  ...fields('备忘录', '备忘与日程提醒', ['row_id', '备忘标题', '类型', '相关角色', '详细内容', '当前状态', '记录时间', '约定时间', '后续结果']),
  ...fields('物品表', '商城送达入库', ['row_id', '物品名称', '类型', '数量', '描述']),
  ...['主角信息表', '恋爱对象表', '重要角色表'].map(table => ({
    table, column: '年龄', feature: '旧版角色年龄兼容', required: false,
    optionalReason: '旧模板年龄列兜底；标准新模板以生日替代。',
  })),
];

let _api: any = null;
let _register: unknown = null;
const _reported = new Set<string>();
let _snapshotApi: any = null;
let _snapshot: Record<string, { content?: unknown }> | null = null;

export function syncPhoneFieldContracts(): any {
  try {
    const contracts = getLedgerCanonical()?.fieldContracts;
    const api = contracts?.version1 || (contracts?.version === 1 ? contracts : null);
    if (typeof api?.register !== 'function') {
      _api = null;
      _register = null;
      return null;
    }
    if (_api !== api || _register !== api.register) {
      api.register('n-sese-phone', '瑟瑟小手机', PHONE_FIELD_CONTRACTS.map(({ optionalReason, ...item }) => item));
      _api = api;
      _register = api.register;
      _reported.clear();
      clearPhoneFieldContractSnapshot();
    }
    return api;
  } catch {
    return null;
  }
}

export function clearPhoneFieldContractSnapshot(): void {
  _snapshotApi = null;
  _snapshot = null;
}

export function resetPhoneFieldContractReports(): void {
  _api = null;
  _register = null;
  _reported.clear();
  clearPhoneFieldContractSnapshot();
  syncPhoneFieldContracts();
}

export function reportPhoneMissingField(table: string, column?: string): void {
  const api = syncPhoneFieldContracts();
  if (!api || typeof api.reportMissing !== 'function') return;
  const items = PHONE_FIELD_CONTRACTS.filter(item => item.table === table && (column === undefined || item.column === column));
  const features = new Set(items.filter(item => item.required !== false).map(item => item.feature));
  for (const feature of features) {
    const key = JSON.stringify([table, column, feature]);
    if (_reported.has(key)) continue;
    try {
      api.reportMissing('n-sese-phone', table, column, feature);
      _reported.add(key);
    } catch {}
  }
}

export function inspectPhoneFieldContracts(sheets: Record<string, { content?: unknown }>, table?: string, sourceApi?: any): void {
  try {
    if (!syncPhoneFieldContracts()) return;
    if (!table && sourceApi) {
      const headers: Record<string, { content?: unknown }> = {};
      for (const [name, sheet] of Object.entries(sheets)) {
        if (Array.isArray(sheet.content)) headers[name] = { content: [sheet.content[0]] };
      }
      _snapshotApi = sourceApi;
      _snapshot = headers;
    }
    for (const item of PHONE_FIELD_CONTRACTS) {
      if (item.required === false || (table && item.table !== table)) continue;
      const sheet = sheets[item.table];
      if (!sheet || !Array.isArray(sheet.content)) {
        reportPhoneMissingField(item.table);
        continue;
      }
      const headers = sheet.content[0];
      if (item.column && (!Array.isArray(headers) || !headers.includes(item.column))) {
        reportPhoneMissingField(item.table, item.column);
      }
    }
  } catch {}
}

export function inspectPhoneTableContract(api: any, table: string): void {
  try {
    const contracts = syncPhoneFieldContracts();
    if (!contracts) return;
    if (_snapshotApi !== api || !_snapshot) {
      if (typeof contracts.health !== 'function') return;
      const health = contracts.health();
      if (!Array.isArray(health)) return;
      const sheets: Record<string, { content: string[][] }> = {};
      for (const item of health) {
        if (item.pluginId !== 'n-sese-phone' || item.tablePresent !== true) continue;
        const sheet = sheets[item.table] ||= { content: [[]] };
        if (item.column && item.columnPresent === true) sheet.content[0].push(item.column);
      }
      _snapshotApi = api;
      _snapshot = sheets;
    }
    inspectPhoneFieldContracts(_snapshot, table);
  } catch {}
}
