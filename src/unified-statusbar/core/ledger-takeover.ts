// core/ledger-takeover.ts
// 瑟瑟台账接管判据 + 工作台入口 + 表格类操作指引文案（单一出口）。
//
// 判据：SeseLedgerAPI 在场且真数据库（AutoCardUpdater 插件）不在场 = **台账模式**。
// 台账与真数据库并存（台账旁观模式，SeseLedgerAPI.realDbPresent === true）不算接管——
// 表格后端仍是真数据库。
//
// 台账模式下主项目「设置 → 表格」页整体退役（模板/分组调度/表格开关/数据库模板修复/
// 存量迁移全部由台账工作台承担，见 src/sese-ledger/docs/台账优化实施方案.md）；本模块同时
// 持有该页指向的用户可见文案（tableOpsPageText / missingTableRepairHint），避免退役后
// 各处空态与帮助继续把用户指向已失效的入口。
//
// 探测顺序（parent → 自身窗口）与 data-manager.getAutoCardAPI 一致：台账把 canonical API
// 同时挂在自身窗口与顶层窗口，状态栏 iframe 从 parent 读最稳。
//
// **本文件必须零依赖**（tests/sql-write-pilot.test.cjs 用裸 loader 直接加载本体；不得 import 任何模块）。
// 台账落账信号的传输订阅见 core/ledger-presence-signal.ts。

/** 瑟瑟台账 canonical API（SeseLedgerAPI）。未装载 / 不在浏览器环境返回 null。 */
export function getLedgerCanonical(): any {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  try { if (w.parent && w.parent.SeseLedgerAPI) return w.parent.SeseLedgerAPI; } catch (_e) { /* cross-origin */ }
  try { if (w.SeseLedgerAPI) return w.SeseLedgerAPI; } catch (_e) { /* cross-origin */ }
  return null;
}

/** 台账是否已接管表格后端（真数据库在场时为 false，表格页照常服务真数据库）。 */
export function isLedgerTakeover(): boolean {
  const ledger = getLedgerCanonical();
  return !!ledger && ledger.realDbPresent !== true;
}

/** 唤起台账工作台（canonical.openSettings）。台账未就绪返回 false，调用方据此提示。
 *  tab 可选（如 'merge'）：台账接管时剧情回顾的「去台账合并」导航据此直达纪要合并标签。 */
export function openLedgerWorkbench(tab?: string): boolean {
  const ledger = getLedgerCanonical();
  if (!ledger || typeof ledger.openSettings !== 'function') return false;
  try { ledger.openSettings(tab); return true; } catch (_e) { return false; }
}

/** 台账是否提供「纪要合并」标签（新版 canonical.summaryMerge）。
 *  旧版台账接管时没有该标签：状态栏不显示「去台账合并」导航，也不回退到状态栏合并（台账模式仍屏蔽）。 */
export function ledgerSupportsSummaryMerge(): boolean {
  const ledger = getLedgerCanonical();
  return !!ledger && ledger.realDbPresent !== true && !!ledger.summaryMerge;
}

/** 「表不存在」的恢复指引（人物关系表 / 技能表等空态与提示共用一句）。 */
export function missingTableRepairHint(): string {
  return isLedgerTakeover()
    ? '到 瑟瑟台账工作台 → 迁移 扫描并套用当前模板'
    : '在 设置 → 表格 运行「数据库模板修复」';
}

/** 台账是否接管了某张表的世界书投影（canonical.tableWorldbookInjection）。
 *  用途：台账侧给某表开了「世界书注入」时，主项目不再重复投影同一张表——
 *  典型＝人物关系表：台账用「与」逻辑（主关键词 A + 次关键词 B and_any）注入同形条目，
 *  主项目侧 `UBS-关系-*` 族随即退场（避免两份同名数据双注入）；台账里关掉该表注入后
 *  主项目投影自动回来（下次数据 tick / 全量刷新即收敛）。
 *  台账未装载 / 台账旁观（真数据库在场）/ 旧版台账无此方法 → 一律 false（主项目投影照常）。 */
export function ledgerHandlesTableWorldbook(tableName: string): boolean {
  const ledger = getLedgerCanonical();
  if (!ledger || ledger.realDbPresent === true) return false;
  try {
    return typeof ledger.tableWorldbookInjection === 'function' && ledger.tableWorldbookInjection(tableName) === true;
  } catch (_e) {
    return false;
  }
}
