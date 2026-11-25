# 小手机 · 源码目录（`src/`）

## 当前工程（先读这里）

本仓库 `n-sese-phone` 是**独立的 esbuild 工程**，不是可拼装的 webpack 阅读包。`src/` 是它的真实源码根：

```
UBS_phone/                 小手机本体（155 个文件）
unified-statusbar/core/    内嵌共享件副本（83 个文件）
```

- **不含** `sese-ledger/`，也**没有**入口 `index.html`：手机壳在 Shadow DOM 内由 `UBS_phone/index.ts` 自行挂载。
- 构建入口是 [`scripts/build.mjs`](../scripts/build.mjs)：以 `src/UBS_phone/index.ts` 为 `entryPoints`，输出单文件 `dist/index.js`（esm / browser / es2022 / minify）；`package.json` 的 `sourceModule` 为 `UBS_phone`，因此不产出 `dist/statusbar.html`。
- 测试位于仓库根目录 [`tests/`](../tests)，`npm test` 直接跑 `tests/*.test.mjs`。
- `src/unified-statusbar/core/` 是从状态栏仓同步来的**内嵌共享件副本**（编译期直接 import，运行期不依赖状态栏 bundle）。其中 `env.ts`、`data-manager.ts`、`ledger-takeover.ts`、`worldbook-projection-events.ts` 为小手机定制版本，`external-projection-client.ts` 为伴生仓投影对接专用；**禁止整目录覆盖**，同步时按单文件比对（详见 [AGENTS.md](../AGENTS.md)）。

修改 `src/` 下任何文件后，必须刷新 [`source-files.sha256.json`](../source-files.sha256.json) 中对应条目并执行 `npm run build`，否则 `npm run check` 会失败。

## 历史来源说明（2026-10-25 原始分享包）

以下内容描述的是本仓库源码的**来源形态**，不是当前仓库结构，仅作版权与出处存档。

原始分享包是三个酒馆助手扩展模块的**源码阅读副本**（日期：2026-10-25）：

```
unified-statusbar/   主扩展（统一状态栏）
UBS_phone/           小手机
sese-ledger/         瑟瑟台账
```

> 在原分享包中三个目录必须保持同级。`sese-ledger` 会从 `../unified-statusbar/core` 引用事件总线、聊天元数据宿主、世界书投影等公共模块，并从 `../unified-statusbar/docs` 读取数据库标准模板。

### 原包包含内容

- 三个模块的 TypeScript 运行源码（`index.ts`、`core/`、`renderers/`、`styles/`、`panels/`、`settings/` 等）
- 运行期资源：成就数据、卡池数据、技能 / 货币正文正则、数据库标准模板、台账标准模板与召回预设
- 各模块入口 HTML（宿主内联构建用）

### 原包未包含内容

为控制分享范围并避免泄露内部资料，以下内容已剔除：

- 开发用 AI 记忆、架构笔记、协作规范（`claude_memory/`、`CLAUDE.md`、`AGENTS.md`）
- 内部设计文档、研究笔记、方案稿、mockup 与历史归档
- 测试套件与测试夹具
- 历史版本打包产物、旧版脚本 JSON、第三方正则与第三方角色卡资料
- 本地编辑器 / 代理配置、构建产物、依赖目录、绝对路径与个人标识

### 关于第三方名称

代码中仍保留少量**功能性**的第三方名称与兼容常量（例如宿主平台 API、数据库插件的公开接口名、生图插件的通道名、插件 toast 标题匹配串）。这些是运行时互通所必需的标识符，不是对第三方代码的复制。源码中涉及**外部项目**的借鉴 / 移植 / 调研来源说明与对比内容已移除；三个模块之间的内部复用说明（如「小手机复用主项目契约」）保留。

### 原包规模（存档，非当前仓库）

- `unified-statusbar/`：361 个文件
- `UBS_phone/`：155 个文件
- `sese-ledger/`：51 个文件
- 合计 568 个文件、约 15 MB；其中 TypeScript 553 个（含 3 个入口与 1 个编排文件）

当前仓库实际为 `src/` 下 239 个文件：`UBS_phone/` 155 个 + `unified-statusbar/core/` 83 个 + 本目录两份 README。

## 内容提示

本项目包含成人向（NSFW）内容与相关提示词，请仅在合适的受众与场景中分享。

## 版权

源码版权归原作者所有（2026-10-25 公开分享包）。本仓库在此基础上的独立工程化改造（esbuild 构建、测试套件、跨仓联动与功能迭代维护）由维护者承担；原始源码的再分发、商用或二次发布，请先取得作者许可。
