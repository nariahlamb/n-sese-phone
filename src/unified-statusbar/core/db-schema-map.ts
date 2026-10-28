// ===== 数据库物理名对照（**只服务真数据库后端**） =====
//
// 台账接管（瑟瑟台账为表格后端）时，表/列一律用**中文名**：台账原生认中文，
// 本表完全不参与（名字直接用调用方给的中文原名）。只有真数据库插件在场
// （台账未接管，它的 raw SQL 只认 DDL 物理名）时，才用本表把中文名翻成物理名。
// 判定与 data-manager.getAutoCardAPI 同一出口：getLedgerCanonical() 非空 = 台账后端。
//
// 本表同时是「哪些表支持写回队列」的白名单（高频交互表入队，其余表回落原 API 路径）。
// 物理名以数据库插件实际物理表为准（zhujuexinxibiao/ero_power 等，
// 与 gacha/shop/skill 各模块既有硬编码一致——本表只是把既有事实收敛到一处）。

import { getLedgerCanonical } from './ledger-takeover';

export interface DbSchemaTable {
  /** 物理表名（真数据库后端 SQL 用） */
  physical: string;
  /** 中文逻辑列名 → 物理列名（真数据库后端 SQL 用） */
  columns: Record<string, string>;
}

export const DB_SCHEMA_MAP: Record<string, DbSchemaTable> = {
  '主角信息表': {
    physical: 'zhujuexinxibiao',
    columns: {
      '瑟瑟能量': 'ero_power',
    },
  },
  '物品表': {
    physical: 'wupinbiao',
    columns: {
      '物品名称': 'item_name',
      '类型': 'item_type',
      '数量': 'quantity',
      '描述': 'description',
    },
  },
  '主角技能表': {
    physical: 'zhujuejinengbiao',
    columns: {
      '技能名称': 'skill_name',
      '技能类别': 'skill_type',
      '技能经验值': 'skill_exp',
      '技能描述': 'skill_desc',
    },
  },
  '瑟瑟任务表': {
    physical: 'seserenwubiao',
    columns: {
      '任务名称': 'mission_name',
      '任务描述': 'mission_desc',
      '任务目标': 'mission_objective',
      '完成情况': 'completion_status',
    },
  },
  '备忘录': {
    physical: 'beiwanglu',
    columns: {
      '备忘标题': 'memo_title',
      '类型': 'memo_type',
      '相关角色': 'related_character',
      '详细内容': 'detail_desc',
      '当前状态': 'current_status',
      '记录时间': 'start_time',
      '约定时间': 'appointed_time',
      '后续结果': 'result_note',
    },
  },
  '纪要表': {
    physical: 'jiyaobiao',
    columns: {
      '编码索引': 'code_index',
      '时间跨度': 'time_span',
      '概览': 'summary',
      '纪要': 'chronicle_text',
      '重要对话': 'key_dialogue',
    },
  },
  '杂表': {
    physical: 'zabiao',
    columns: {
      '名称': 'misc_name',
      '描述': 'misc_description',
    },
  },
  '恋爱对象表': {
    physical: 'lianaiduixiangbiao',
    columns: {
      '姓名': 'name',
      '性别': 'gender',
      '年龄': 'age',
      '生日': 'birthday',
      '一句话介绍': 'brief_intro',
      '外貌特征': 'appearance',
      '身份': 'identity_text',
      '对主角态度': 'attitude_to_protagonist',
      '过往经历': 'past_experience',
      '最近亲密互动': 'recent_interactions',
    },
  },
  '重要角色表': {
    physical: 'zhongyaojuesebiao',
    columns: {
      '姓名': 'name',
      '性别': 'gender',
      '年龄': 'age',
      '生日': 'birthday',
      '一句话介绍': 'brief_intro',
      '外貌特征': 'appearance',
      '身份': 'identity_text',
      '对主角态度': 'attitude_to_protagonist',
      '过往经历': 'past_experience',
    },
  },
};

/**
 * 写回队列白名单（高频交互表）：只有这些表的写入走队列（overlay + 合并落盘），
 * 其余表回落原 API 路径。**与 DB_SCHEMA_MAP 的键不同**——后者只负责名字对照，
 * 会随各站点需要增补（纪要表/杂表/人物两表等低频表也在其中，但它们不入队列）。
 */
const QUEUE_TABLES: ReadonlySet<string> = new Set([
  '主角信息表', '物品表', '主角技能表', '瑟瑟任务表', '备忘录', '纪要表',
]);

/** 该逻辑表是否支持写回队列（白名单口径，历史不变）。 */
export function hasDbSchemaMapping(tableName: string): boolean {
  return QUEUE_TABLES.has(tableName);
}

/** 当前表格后端是否为台账（台账接管：表/列恒中文名，不需要任何翻译）。 */
function isLedgerBackend(): boolean {
  return !!getLedgerCanonical();
}

/** SQL 用的表名：台账后端 = 中文原名；真数据库后端 = 物理名（无映射时原名，交给后端点名报错）。 */
export function sqlTableName(tableName: string): string {
  if (isLedgerBackend()) return tableName;
  return DB_SCHEMA_MAP[tableName]?.physical || tableName;
}

/** SQL 用的列名：台账后端 = 中文原名；真数据库后端 = 物理名（无映射 → null，调用方按失败处理）。 */
export function sqlColumnName(tableName: string, column: string): string | null {
  if (isLedgerBackend()) return column;
  return DB_SCHEMA_MAP[tableName]?.columns[column] ?? null;
}

/**
 * 读 API 返回行键归一到请求的列名：真数据库后端的 queryTableRows 回物理列名
 * （SELECT 列表顺序＝请求顺序），台账后端本就回请求名。按位置改键即可让调用方
 * 「请求什么读什么」，与后端无关。
 */
export function normalizeRowKeys(
  rows: Record<string, unknown>[],
  columns: string[],
): Record<string, unknown>[] {
  if (columns.length === 0) return rows;
  if (rows.every((row) => columns.every((c) => row && c in row))) return rows;
  return rows.map((row) => {
    const keys = Object.keys(row || {});
    if (keys.length !== columns.length) return row;
    const out: Record<string, unknown> = {};
    columns.forEach((c, i) => { out[c] = (row as any)[keys[i]]; });
    return out;
  });
}
