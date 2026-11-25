# 来源

- **原作者与版权**：业务源码来自原作者 **2026-10-25 公开分享包**（原作者已停更），版权归原作者所有。原始版权说明、分享包内容范围与内容提示见 [src/README.md](src/README.md)。
- **来源形态**：该分享包是 `unified-statusbar` / `UBS_phone` / `sese-ledger` 三个模块的 webpack 多入口源码阅读副本；版权与再分发限制按原包声明执行。

## 当前仓库的性质

本仓库 `n-sese-phone` 已不再限于「个人安装适配」。后续在本仓库进行了**独立工程化**——esbuild 单入口构建（`scripts/build.mjs` → `dist/index.js`）、`node --test` 测试套件（根目录 `tests/`）、发布自检（`scripts/check-release.mjs` + `source-files.sha256.json`）；并与统一状态栏、瑟瑟台账做了**跨仓联动与功能迭代维护**（世界书投影、货币、生图、一键搬家、正文联动群聊等）。

当前工程结构、构建与测试说明见 [src/README.md](src/README.md) 与根目录 [README.md](README.md)。

## 再分发

原始源码的再分发、商用或二次发布，请先取得原作者许可；本仓库自身新增的工程化与功能改造部分由维护者承担。
