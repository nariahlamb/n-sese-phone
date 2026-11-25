# n-sese-phone 仓库规范 (AGENTS.md)

本文件继承上级 [`../AGENTS.md`](../AGENTS.md)（`n-sese-suite/AGENTS.md`），是 `n-sese-phone` 的长期工程与交付规则；上级未覆盖的细节以本文件为准。

## 1. 交付步骤顺序（每次改动后按序执行，无需再问）

1. **改代码 / 文档**：先读目标文件再改，禁止盲改。
2. **改到 `src/` 时**：刷新 `source-files.sha256.json` 中对应条目的 SHA-256（只改变更项），并执行 `npm run build` 重建 `dist/index.js`。
3. **递增版本号（仅功能 / 界面 / 修复类改动）**：semver 递进，四处同步——`manifest.json` 的 `version`、`package.json` 的 `version`、`package-lock.json` 顶层 `version` 与 `packages[""].version`；同时更新 `README.md`（当前版本、第 2 节状态表、第 5 节测试数、第 6 节 Changelog）。**纯文档同步不递增任何版本号，也不伪造代码版本。**
4. **最终验证**：`npm run build`、`npm test`、`npm run check` 全部退出码 0；CI 另跑 `git diff --exit-code -- dist`，本地提交前也应确认 `git diff -- dist` 无异常。
5. **提交推送**：显式 `git add <文件路径…>`（逐个列出，禁止 `git add -A` / `git add .`）、`git commit`、`git push origin main`，供手机端 TauriTavern (TT) 直接 `git pull` 实机复测。不打包 zip。

## 2. 在 Antigravity 等独立客户端打开本仓时

- `src/unified-statusbar/core/`（83 个文件）是**内嵌共享件副本**，不是状态栏仓的完整镜像：其中 `env.ts`、`data-manager.ts`、`ledger-takeover.ts`、`worldbook-projection-events.ts` 为小手机定制版本，`external-projection-client.ts` 为伴生仓（独立状态栏 / 台账）投影对接专用。**禁止整目录覆盖**——整体同步会丢掉定制与伴生适配；需要跟进上游时按单文件 diff 比对，改完仍要刷新 `source-files.sha256.json` 并重建 `dist/index.js`。
- 工作区遗留一个未跟踪的 Windows 保留设备名 `CON`。**禁止 `git add -A` / `git add .`**；一律显式列出要提交的路径，避免误纳无关文件或因该文件名报错。
- 装载链固定为 `manifest.json (loading_order: 220) → index.js → runtime/extension.js → dist/index.js`，`runtime/config.js` 关闭模板（`template: false`）。改 `src/` 后必须重新 build，否则客户端仍在跑旧 bundle。
