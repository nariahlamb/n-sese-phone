# n-sese-phone 仓库规范 (AGENTS.md)

本文件继承 `n-sese-suite/AGENTS.md`，作为 `n-sese-phone` 的长期工程与交付规则：

- **长期自动递版本推仓授权（无需再问，不要打包 zip）**：对本仓库完成改动并跑通 `npm run build`、`npm test`、`npm run check` 后，必须同步递增 `manifest.json`、`package.json`、`package-lock.json`（顶层与 `packages[""]`）版本号、刷新 `source-files.sha256.json`、更新 `README.md`，并**直接执行 `git commit` 与 `git push origin main`**，供手机端 TauriTavern (TT) 直接 `git pull` 实机复测。
