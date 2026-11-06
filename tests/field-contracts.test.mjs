import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

async function load(entry, win = {}) {
  if (!Object.getOwnPropertyDescriptor(win, 'parent')) win.parent = win;
  const result = await build({
    absWorkingDir: root, bundle: true, write: false,
    ...(Array.isArray(entry)
      ? { stdin: { contents: entry.map(path => `export * from './${path}';`).join('\n'), resolveDir: root } }
      : { entryPoints: [entry] }),
    platform: 'browser', format: 'cjs', target: 'es2022', logLevel: 'silent',
  });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, window: win, parent: win, console,
    setTimeout() { throw new Error('字段契约不应新增定时器'); }, clearTimeout() {},
  });
  return module.exports;
}

function ledgerProbe({ shape = 'version1', sheets = {} } = {}) {
  const registrations = [], missing = [];
  let exports = 0, healthCalls = 0, listeners = 0;
  const tableApi = {
    exportTableAsJson() { exports++; return sheets; },
    queryTableRows() { return { rows: [] }; },
    registerTableUpdateCallback() { listeners++; },
  };
  const contractApi = {
    register(id, label, items) {
      registrations.push(plain([id, label, items.map(item => ({ ...item, required: item.required === true }))]));
    },
    reportMissing(...args) { missing.push(plain(args)); },
    health() {
      healthCalls++;
      return registrations.flatMap(([pluginId, , items]) => items.map(item => {
        const sheet = Object.values(sheets).find(sheet => sheet.name === item.table);
        return { ...item, pluginId, tablePresent: !!sheet, columnPresent: !!sheet?.content?.[0]?.includes(item.column) };
      }));
    },
  };
  const ledger = {
    __legacyFace: tableApi,
    fieldContracts: shape === 'version1' ? { version1: contractApi } : { version: 1, ...contractApi },
  };
  return { ledger, registrations, missing, tableApi, contractApi, exports: () => exports, healthCalls: () => healthCalls, listeners: () => listeners };
}

const fieldModule = await load('src/UBS_phone/core/field-contracts.ts');
const manifest = plain(fieldModule.PHONE_FIELD_CONTRACTS);
const declared = (table, column) => manifest.some(item => item.table === table && item.column === column);

function rosterReferences(text) {
  const ast = ts.createSourceFile('roster.ts', text, ts.ScriptTarget.Latest, true);
  const functions = new Map();
  const arrays = new Map();
  function visit(node, callback) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
  visit(ast, node => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, { node, env: new Map() });
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let value = node.initializer;
      while (ts.isAsExpression(value)) value = value.expression;
      if (ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteral)) arrays.set(node.name.text, value.elements.map(el => el.text));
    }
  });
  const merge = (env, name, values) => env.set(name, new Set([...(env.get(name) || []), ...values]));
  const values = (node, env) => {
    if (ts.isStringLiteral(node)) return [node.text];
    if (ts.isIdentifier(node)) return [...(env.get(node.text) || [])];
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue, env), ...values(node.whenFalse, env)];
    if (ts.isElementAccessExpression(node) && node.expression.getText(ast) === 'sheets') return values(node.argumentExpression, env);
    return [];
  };
  for (let pass = 0; pass < 4; pass++) {
    for (const { node, env } of functions.values()) visit(node.body, child => {
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer) merge(env, child.name.text, values(child.initializer, env));
      if (ts.isForOfStatement(child) && ts.isIdentifier(child.expression) && ts.isVariableDeclarationList(child.initializer)) {
        merge(env, child.initializer.declarations[0].name.getText(ast), arrays.get(child.expression.text) || []);
      }
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        const target = functions.get(child.expression.text);
        if (target) child.arguments.forEach((arg, i) => {
          const param = target.node.parameters[i];
          if (param && ts.isIdentifier(param.name)) merge(target.env, param.name.text, values(arg, env));
        });
      }
    });
  }
  const refs = [];
  const contexts = new Map();
  visit(ast, child => {
    if (!ts.isCallExpression(child) || !ts.isIdentifier(child.expression)) return;
    const target = functions.get(child.expression.text);
    if (!target) return;
    const literals = child.arguments.map(arg => ts.isStringLiteral(arg) ? arg.text : null);
    const table = literals.find(value => value?.endsWith('表'));
    if (!table) return;
    const bindings = new Map();
    literals.forEach((value, i) => {
      const param = target.node.parameters[i];
      if (value && param && ts.isIdentifier(param.name)) bindings.set(param.name.text, new Set([value]));
    });
    const byTable = contexts.get(target.node) || new Map();
    byTable.set(table, bindings);
    contexts.set(target.node, byTable);
  });
  const evaluate = (condition, env) => {
    if (ts.isIdentifier(condition)) {
      assert(values(condition, env).length, '未解析的 cell 条件：' + condition.getText(ast));
      return true;
    }
    assert(ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken,
      '未解析的 cell 条件：' + condition.getText(ast));
    const left = values(condition.left, env), right = values(condition.right, env);
    assert.equal(left.length, 1, condition.getText(ast));
    assert.equal(right.length, 1, condition.getText(ast));
    return left[0] === right[0];
  };
  const columnsFor = (node, env) => ts.isConditionalExpression(node)
    ? columnsFor(evaluate(node.condition, env) ? node.whenTrue : node.whenFalse, env)
    : values(node, env);
  for (const { node, env } of functions.values()) visit(node.body, child => {
    if (!ts.isCallExpression(child) || child.expression.getText(ast) !== 'cell') return;
    const tables = values(child.arguments[0], env);
    assert(tables.length, '未能解析实际 cell 表引用：' + child.getText(ast));
    for (const table of tables) {
      const local = new Map([...env, ...(contexts.get(node)?.get(table) || [])]);
      let active = true;
      for (let parent = child.parent; parent && parent !== node; parent = parent.parent) {
        if (!ts.isConditionalExpression(parent)) continue;
        const branch = evaluate(parent.condition, local) ? parent.whenTrue : parent.whenFalse;
        if (child.pos < branch.pos || child.end > branch.end) active = false;
      }
      if (!active) continue;
      const columns = columnsFor(child.arguments[2], local);
      assert(columns.length, '未能解析实际 cell 列引用：' + child.getText(ast));
      for (const column of columns) refs.push({ table, column });
    }
  });
  return refs;
}

test('手写清单覆盖 roster 全部精确引用，按 category 检查实际角色分支', async () => {
  const refs = rosterReferences(await source('src/UBS_phone/core/roster.ts'));
  assert(refs.length > 50);
  for (const { table, column } of refs) assert(declared(table, column), `未登记：${table}·${column}`);
  for (const [table, column] of [['恋爱对象表', '最近亲密互动'], ['重要角色表', '过往经历']]) {
    assert(refs.some(ref => ref.table === table && ref.column === column));
    assert(manifest.some(item => item.table === table && item.column === column && item.required === true));
  }
  for (const [table, column] of [['重要角色表', '最近亲密互动'], ['恋爱对象表', '过往经历']]) {
    assert(!refs.some(ref => ref.table === table && ref.column === column));
    assert(!declared(table, column));
  }
  assert(declared('在场角色表', '情绪'));
  assert(manifest.every(item => item.feature && item.table && item.column && typeof item.required === 'boolean'));
  assert.equal(new Set(manifest.map(item => JSON.stringify([item.table, item.column, item.feature]))).size, manifest.length);
  for (const item of manifest.filter(item => item.required === false)) {
    assert.equal(item.column, '年龄');
    assert(item.optionalReason?.length > 10);
  }
});

test('手写清单覆盖活跃纪要查询、备忘录与物品 SQL 列', async () => {
  const chronicle = await source('src/unified-statusbar/core/chronicle-blocks.ts');
  const columns = chronicle.match(/columns:\s*\[([^\]]+)\]/)?.[1].match(/'([^']+)'/g).map(value => value.slice(1, -1));
  assert(columns?.length);
  for (const column of columns) assert(declared('纪要表', column), `未登记纪要：${column}`);
  for (const [file, constant, table] of [
    ['phone-memo.ts', 'MEMO_COLUMNS', '备忘录'], ['phone-inventory.ts', 'ITEM_COLUMNS', '物品表'],
  ]) {
    const text = await source('src/UBS_phone/core/' + file);
    const list = text.match(new RegExp(`const ${constant}[^=]*= \\[([^\\]]+)\\]`))?.[1];
    assert(list, constant);
    for (const [, column] of list.matchAll(/'([^']+)'/g)) assert(declared(table, column), `未登记：${table}·${column}`);
    assert(declared(table, 'row_id'));
  }
});

test('契约可从生产入口到达，生日和日历读表函数不作为活跃消费', async () => {
  const result = await build({
    absWorkingDir: root, entryPoints: ['src/UBS_phone/index.ts'], bundle: true, write: false,
    metafile: true, platform: 'browser', format: 'esm', target: 'es2022', charset: 'utf8', logLevel: 'silent',
  });
  const output = Object.values(result.metafile.outputs)[0];
  assert(output.inputs['src/UBS_phone/core/field-contracts.ts'].bytesInOutput > 0);
  assert(output.inputs['src/unified-statusbar/core/data-manager.ts'].bytesInOutput > 0);
  const code = result.outputFiles[0].text;
  assert(code.includes('function queryLogicalTablePage('));
  assert(!code.includes('function collectCharacterBirthdays('));
  assert(!code.includes('function readStoryClockRaw('));
  assert(!manifest.some(item => item.feature.includes('生日提醒') || item.feature.includes('日历')));
});

test('新版台账登记去重、缺列去重，空单元格不算缺列，换聊允许重新上报', async () => {
  const probe = ledgerProbe();
  const api = await load('src/UBS_phone/core/field-contracts.ts', { SeseLedgerAPI: probe.ledger });
  api.syncPhoneFieldContracts(); api.syncPhoneFieldContracts();
  assert.equal(probe.registrations.length, 1);
  assert.deepEqual(probe.registrations[0].slice(0, 2), ['n-sese-phone', '瑟瑟小手机']);
  const registered = probe.registrations[0][2];
  assert(!registered.some(item => 'optionalReason' in item));
  assert(registered.filter(item => item.column !== '年龄').every(item => item.required === true));
  assert(registered.filter(item => item.column === '年龄').every(item => item.required === false));
  const sheets = { '在场角色表': { content: [['姓名', '当前状态'], ['甲', '']] } };
  api.inspectPhoneFieldContracts(sheets, '在场角色表');
  api.inspectPhoneFieldContracts(sheets, '在场角色表');
  assert.equal(probe.missing.filter(item => item[2] === '情绪').length, 1);
  assert(!probe.missing.some(item => item[2] === '当前状态'));
  api.resetPhoneFieldContractReports();
  api.inspectPhoneFieldContracts(sheets, '在场角色表');
  assert.equal(probe.missing.filter(item => item[2] === '情绪').length, 2);
  assert.equal(probe.registrations.length, 2);
});

test('旧台账保持读取，晚加载契约或更换 API 会补登记并检查已有角色缓存', async () => {
  const sheets = {
    sheet_present: { name: '在场角色表', content: [['姓名', '当前状态', '情绪'], ['甲', '在场', '开心']] },
    sheet_main: { name: '主角信息表', content: [['姓名', '年龄'], ['我', '20']] },
  };
  const probe = ledgerProbe({ sheets });
  const win = { SeseLedgerAPI: { __legacyFace: probe.tableApi } };
  const roster = await load('src/UBS_phone/core/roster.ts', win);
  assert.equal(roster.getRoster().present['甲'].emotion, '开心');
  assert.equal(roster.getRoster().protagonist.age, '20岁');
  win.SeseLedgerAPI = probe.ledger;
  assert.equal(roster.getRoster().present['甲'].emotion, '开心');
  assert.equal(probe.registrations.length, 1);
  assert(probe.missing.some(item => item[1] === '主角信息表' && item[2] === '生日'));
  const replacement = ledgerProbe({ shape: 'version', sheets });
  win.SeseLedgerAPI = replacement.ledger;
  roster.getRoster();
  assert.equal(replacement.registrations.length, 1);
  assert(replacement.missing.length > 0);
});

test('无接口、跨源父窗口、接口抛错均不改变现有空值兜底', async () => {
  const probe = ledgerProbe({ sheets: { sheet_present: { name: '在场角色表', content: [['姓名'], ['甲']] } } });
  probe.contractApi.register = () => { throw new Error('失败'); };
  const win = { SeseLedgerAPI: probe.ledger };
  Object.defineProperty(win, 'parent', { get() { throw new Error('cross origin'); } });
  const roster = await load('src/UBS_phone/core/roster.ts', win);
  const snapshot = roster.getRoster();
  assert.equal(snapshot.present['甲'].emotion, '');
  assert.equal(snapshot.hasDb, true);
  assert.equal(probe.missing.length, 0);
});

test('运行时 SQL 诊断只读结构健康信息并缓存，失效后重查，无全库导出和监听', async () => {
  const probe = ledgerProbe({ sheets: { sheet_memo: { name: '备忘录', content: [['row_id', '备忘标题']] } } });
  const api = await load('src/UBS_phone/core/field-contracts.ts', { SeseLedgerAPI: probe.ledger });
  api.inspectPhoneTableContract(probe.tableApi, '备忘录');
  api.inspectPhoneTableContract(probe.tableApi, '备忘录');
  assert.equal(probe.exports(), 0);
  assert.equal(probe.healthCalls(), 1);
  assert.equal(probe.listeners(), 0);
  assert.equal(probe.registrations.length, 1);
  assert.equal(probe.missing.filter(item => item[2] === '约定时间').length, 1);
  api.clearPhoneFieldContractSnapshot();
  api.inspectPhoneTableContract(probe.tableApi, '备忘录');
  assert.equal(probe.healthCalls(), 2);
  assert.equal(probe.exports(), 0);
  assert.equal(probe.missing.filter(item => item[2] === '约定时间').length, 1);
  api.resetPhoneFieldContractReports();
  api.inspectPhoneTableContract(probe.tableApi, '备忘录');
  assert.equal(probe.healthCalls(), 3);
  assert.equal(probe.missing.filter(item => item[2] === '约定时间').length, 2);
});

test('正常通讯录或共享缓存供分页与备忘诊断复用，缓存失效后仅重查结构', async () => {
  for (const cache of ['roster', 'shared']) {
    const probe = ledgerProbe({ sheets: { sheet_memo: { name: '备忘录', content: [['row_id', '备忘标题']] } } });
    probe.tableApi.queryTableRows = ({ tableName }) => ({ rows: tableName === '备忘录'
      ? [{ row_id: '1', '备忘标题': '见面' }] : [{ '概览': '甲来到城中' }] });
    const runtime = await load([
      'src/UBS_phone/core/roster.ts', 'src/UBS_phone/core/phone-memo.ts',
      'src/unified-statusbar/core/data-manager.ts',
    ], { SeseLedgerAPI: probe.ledger });
    if (cache === 'roster') runtime.getRoster();
    else runtime.getSheetByName('备忘录');
    assert.equal(probe.exports(), 1, cache);
    assert.equal(runtime.readPhoneMemoRows()[0].title, '见面', cache);
    assert.deepEqual(plain(runtime.queryLogicalTablePage({ tableName: '纪要表', columns: ['概览'], limit: 10 })), [{ '概览': '甲来到城中' }], cache);
    assert.equal(probe.exports(), 1, cache);
    assert.equal(probe.healthCalls(), 0, cache);
    assert(probe.missing.some(item => item[1] === '备忘录' && item[2] === '约定时间'), cache);
    if (cache === 'roster') runtime.invalidateRosterCache();
    else runtime.invalidateCache();
    runtime.readPhoneMemoRows();
    assert.equal(probe.healthCalls(), 1, cache);
    assert.equal(probe.exports(), 1, cache);
    assert.equal(probe.listeners(), 0, cache);
  }
});

test('活跃共享分页读取保持结果，缺表列交由中心上报', async () => {
  const probe = ledgerProbe({ sheets: { sheet_chronicle: { name: '纪要表', content: [['时间跨度']] } } });
  probe.tableApi.queryTableRows = () => ({ rows: [{ '概览': '甲来到城中' }] });
  const shared = await load('src/unified-statusbar/core/data-manager.ts', { SeseLedgerAPI: probe.ledger });
  const query = { tableName: '纪要表', columns: ['概览'], limit: 10 };
  assert.deepEqual(plain(shared.queryLogicalTablePage(query)), [{ '概览': '甲来到城中' }]);
  shared.queryLogicalTablePage(query);
  assert.equal(probe.registrations.length, 1);
  assert.equal(probe.exports(), 0);
  assert.equal(probe.healthCalls(), 1);
  assert.equal(probe.missing.filter(item => item[1] === '纪要表' && item[2] === '概览').length, 1);
  assert.equal(shared.getSheetByName('物品表'), null);
  assert(probe.missing.some(item => item[1] === '物品表' && item[2] === null));
});

test('实际备忘录提醒读取旧台账正常，新版缺列仅增加诊断', async () => {
  const probe = ledgerProbe({ sheets: { sheet_memo: { name: '备忘录', content: [['row_id', '备忘标题']] } } });
  probe.tableApi.queryTableRows = () => ({ rows: [{ row_id: '1', '备忘标题': '见面', '约定时间': '2026-11-08', '详细内容': '车站' }] });
  const win = { SeseLedgerAPI: { __legacyFace: probe.tableApi } };
  const memo = await load('src/UBS_phone/core/phone-memo.ts', win);
  const before = plain(memo.readPhoneMemoRows());
  win.SeseLedgerAPI = probe.ledger;
  assert.deepEqual(plain(memo.readPhoneMemoRows()), before);
  assert.equal(before[0].title, '见面');
  assert.equal(probe.exports(), 0);
  assert.equal(probe.healthCalls(), 1);
  assert(probe.missing.some(item => item[1] === '备忘录' && item[2] === '约定时间'));
});

test('角色提示词区分最近亲密互动和过往经历，保留人物关系状态', async () => {
  const sheets = {
    sheet_romance: { name: '恋爱对象表', content: [['姓名', '最近亲密互动', '过往经历'], ['甲', '昨夜牵手', '不应读取的恋爱背景']] },
    sheet_important: { name: '重要角色表', content: [['姓名', '最近亲密互动', '过往经历'], ['乙', '不应读取的重要角色亲密', '曾在港口任职']] },
    sheet_relations: { name: '人物关系表', content: [['人物A', '人物B', '关系类型', '关系状态'], ['甲', '乙', '同事', '近期疏远']] },
  };
  const probe = ledgerProbe({ sheets });
  const rosterApi = await load('src/UBS_phone/core/roster.ts', { SeseLedgerAPI: probe.ledger });
  const prompts = await load('src/UBS_phone/core/chat-prompts.ts');
  const roster = rosterApi.getRoster();
  const romance = roster.contacts.find(contact => contact.name === '甲');
  const important = roster.contacts.find(contact => contact.name === '乙');
  assert.equal(romance.recentIntimacy, '昨夜牵手');
  assert.equal(romance.pastExperience, '');
  assert.equal(important.recentIntimacy, '');
  assert.equal(important.pastExperience, '曾在港口任职');
  assert.match(prompts.contactSection(roster, '甲'), /最近亲密互动：昨夜牵手/);
  assert(!prompts.contactSection(roster, '甲').includes('过往经历：'));
  assert.match(prompts.contactSection(roster, '乙'), /过往经历：曾在港口任职/);
  assert(!prompts.contactSection(roster, '乙').includes('最近亲密互动：'));
  assert.match(prompts.relationSection(roster, ['甲', '乙']), /甲 ↔ 乙：同事（近期疏远）/);
  assert.equal(probe.exports(), 1);
  assert.equal(rosterApi.getRoster(), roster);
  assert.equal(probe.exports(), 1);
  rosterApi.invalidateRosterCache();
  rosterApi.getRoster();
  assert.equal(probe.exports(), 2);
});

test('旧台账无契约或健康接口，以及诊断异常，均不阻断分页与备忘正常读取', async () => {
  for (const failure of ['no-contract', 'no-health', 'register', 'health', 'reportMissing']) {
    const probe = ledgerProbe();
    probe.tableApi.queryTableRows = ({ tableName }) => ({ rows: tableName === '备忘录'
      ? [{ row_id: '1', '备忘标题': '见面', '约定时间': '2026-11-08', '详细内容': '车站' }]
      : [{ '概览': '甲来到城中' }] });
    if (failure === 'no-contract') delete probe.ledger.fieldContracts;
    else if (failure === 'no-health') delete probe.contractApi.health;
    else probe.contractApi[failure] = () => { throw new Error('诊断异常'); };
    const win = { SeseLedgerAPI: probe.ledger };
    const shared = await load('src/unified-statusbar/core/data-manager.ts', win);
    const query = { tableName: '纪要表', columns: ['概览'], limit: 10 };
    assert.deepEqual(plain(shared.queryLogicalTablePage(query)), [{ '概览': '甲来到城中' }], failure);
    assert.deepEqual(plain(shared.queryLogicalTableRows(query)), [{ '概览': '甲来到城中' }], failure);
    const memo = await load('src/UBS_phone/core/phone-memo.ts', win);
    assert.equal(memo.readPhoneMemoRows()?.[0]?.title, '见面', failure);
    assert.equal(probe.exports(), 0, failure);
    assert.equal(probe.listeners(), 0, failure);
  }
});

test('标准模板交叉检查：每项存在或明确为旧模板兼容字段', {
  skip: !process.env.PHONE_STANDARD_TEMPLATE && '本仓未附完整标准模板；设置 PHONE_STANDARD_TEMPLATE 为标准模板 JSON 后执行本测试',
}, async () => {
  const template = JSON.parse(await readFile(process.env.PHONE_STANDARD_TEMPLATE, 'utf8'));
  const sheets = template.schemaVersion === 2
    ? (template.tables || []).filter(sheet => sheet && typeof sheet.name === 'string').map(sheet => ({ name: sheet.name, content: [['row_id', ...(sheet.columns || []).map(column => column.header)]] }))
    : Object.values(template).filter(sheet => sheet && typeof sheet.name === 'string' && Array.isArray(sheet.content));
  if (template.schemaVersion === 2) for (const sheet of sheets) if (!sheet.content[0].includes('row_id')) sheet.content[0].unshift('row_id');
  assert(sheets.length > 0, '模板应为 v2 tables 或含 name/content 的 sheet 快照 JSON');
  for (const item of manifest) {
    const sheet = sheets.find(sheet => sheet.name === item.table);
    const exists = sheet && (!item.column || sheet.content[0]?.includes(item.column));
    if (!exists) assert(item.required === false && item.optionalReason, `标准模板缺少契约项：${item.table}·${item.column}`);
  }
});
