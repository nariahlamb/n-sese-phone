# UBS_phone（小手机）

小手机本体的全部 TypeScript 源码。手机壳在 Shadow DOM 内由 [index.ts](index.ts) 自行挂载，没有独立入口 `index.html`。

## 真实装载链

```
manifest.json (loading_order: 220, js: index.js)
  └─ index.js                     扩展入口：createExtension + 依赖探测 + 单例守卫
      └─ runtime/extension.js     宿主装载器：等酒馆 / 酒馆助手就绪、挂设置面板、装载模块
          └─ dist/index.js        npm run build 产出的单文件 bundle（entry: src/UBS_phone/index.ts）
```

[runtime/config.js](../runtime/config.js) 里 `template: false`、`blockDatabase: false`、`bootFlag: "__ubp_booted"`：小手机不使用状态栏的 HTML 模板壳，也不需要 `dist/statusbar.html`；装载器因此跳过模板读取与 `CHAT_CHANGED` 壳重建分支，聊天切换由 `index.ts` 的 `__ubp_on_chat_changed` 自己处理。

## 目录

- `core/`：引擎与共享件——微信、电话、社媒、窥私、不夜城、游戏中心、商城、纪要、语音、生图、存档、设置、字段契约等
- `renderers/`：手机壳、16 个已注册 App、弹层与共用 UI；[app-registry.ts](renderers/app-registry.ts) 同时是 App 注册表与手机内部事件总线（`ubp-phone:*`）
- `styles/`：手机主题与皮肤变量
- `core/version.ts`：`PHONE_VERSION`（`V1.308`）与 `PHONE_BUILD_TAG` 只是手机内部 UI / 日志的显示锚点，**扩展分发版本以 `manifest.json` 为准**

## 与状态栏 / 台账的边界

- **编译期**：直接 import 同仓内嵌的 `../unified-statusbar/core/`（`env.ts`、`data-manager.ts`、`context-strip.ts`、`ai-tool-shield.ts`、`image-gen.ts`、`api-config.ts`、`cross-window.ts` 等）。这是源码级复用，不是运行时依赖；该目录是副本，禁止整目录覆盖。
- **运行期**：不 import 状态栏或台账的有状态模块，只经顶层窗口桥交互——`window.__ubWorldbookProjection`（世界书投影）、`window.__ubStorageRelocation`（一键搬家）、`window.__ub_currency_host`（货币）、`window.__ubImageGenQueue`（共享生图闸门）、`window.__ubp_world_inject`（世界演化事件）等；反向由本仓暴露 `__ubp_toggle` / `__ubp_phone_style` / `__ubp_on_chat_changed`。台账数据经 `SeseLedgerAPI`（回落 `AutoCardUpdaterAPI`）**只读**读取。
- 状态栏 / 台账未加载时桥不存在，相关联动降级为空操作，手机其余功能照常可用。

## 维护指针

| 想改什么 | 去哪 |
|---|---|
| 扩展生命周期、悬浮球、桥注册与卸载 | [index.ts](index.ts) |
| 正文联动（标签注入、渲染正则、群聊提取） | [core/story-link.ts](core/story-link.ts)、[renderers/story-link-enhance.ts](renderers/story-link-enhance.ts) |
| 手机设置、API 预设、缩放存储 | [core/phone-settings.ts](core/phone-settings.ts)、[core/phone-api.ts](core/phone-api.ts) |
| 消息记录 / 窥私记录世界书投影 | [core/message-worldbook.ts](core/message-worldbook.ts)、[core/spy-worldbook.ts](core/spy-worldbook.ts) |
| 台账表名与列名契约 | [core/field-contracts.ts](core/field-contracts.ts)、[core/roster.ts](core/roster.ts) |
| 测试 | 仓库根目录 [tests/](../tests) |
