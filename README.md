# 瑟瑟小手机（`n-sese-phone`）

> **致后续接手本仓库的 AI（强制维护纪律）**
> 1. **每次修改本仓库代码、正文联动标签协议、世界书投影或对外桥接接口后，必须同步更新本 README**（至少更新「当前改造状态与未完成项」「契约速查」及文末「改造记录」），严禁只改代码不留记录。
> 2. **先读再改，改完自动推仓（长期明确授权）**：涉及 `src/` 修改必须同步刷新 `source-files.sha256.json`，重建 `dist/index.js`，并运行 `npm test` 与 `npm run check`；全绿后同步递增版本号并**直接 `git commit` 与 `git push origin main`**（无需逐次询问，也不要打包 zip，详见 [AGENTS.md](AGENTS.md)）。
> 3. **做角色卡联动必看**：第 3 节列出了正文联动全风格标签、世界书防全知条目与 `order`、以及小手机对台账表列的只读依赖。写角色卡时要严格对齐标签名与分隔符。

---

## 1. 定位与运行依赖

- **扩展名称**：`瑟瑟小手机`（`manifest.json` `loading_order: 220`，在 `n-sese-unified-statusbar` `200` 与 `n-sese-ledger` `210` 之后装载）
- **当前版本**：`0.1.0-alpha.8`（基于 `1c7ee30` 推进，功能性改动均递增版本并推仓供 TT 拉取测）
- **全局设置存储**：服务器文件 `usb_global_phone-settings_<hash>.json`（由 [core/phone-settings.ts](src/UBS_phone/core/phone-settings.ts) 管理；API 预设仓库读取自状态栏 `customApiPresets`）；桌面端缩放键走 `localStorage['ubp_desktop_phone_zoom_v1']`。
- **安装使用**：
  1. 先安装并启用酒馆助手（JS-Slash-Runner）。
  2. 在酒馆「扩展 → 安装扩展」粘贴本仓库地址，装好后刷新页面；同名旧脚本请先停用。
  3. 配合统一状态栏（提供 API 预设与世界书投影协调器）及台账/数据库数据源使用；进入角色聊天后点击手机悬浮按钮使用。
- **来源与参考**：业务原始源码源自原作者 2026-10-25 公开分享包（原作者已停更），本仓库为个人后续适配与改造维护版本，版权归属见 [SOURCE_NOTICE.md](SOURCE_NOTICE.md) 与 [src/README.md](src/README.md)。 · [简易教程](https://docs.google.com/document/d/1f5B-GmNLJExH7FE9bwpOb4Ditx5EDHfQtTIXY0WDnX4/edit)

---

## 2. 当前改造状态与未完成项（截至 2026-11-17）

| 模块 / 功能 | 当前状态 | 关键证据与说明 |
|---|---|---|
| **手机/桌面双端壳与缩放适配** | ✅ 代码+单测完成 | 桌面端缩放与移动端（`<= 600px`）解耦，修复电脑端尺寸及窗口 resize 悬浮球越界（`ff44500`）；`npm test` **23 通过 / 2 跳过**，`npm run check` 通过 |
| **台账只读消费与字段诊断** | ✅ 代码+单测完成 | 优先通过 `SeseLedgerAPI`（回落 `AutoCardUpdaterAPI`）读取表数据并登记字段契约；经历与近期亲密互动口径已对齐（[roster.ts](src/UBS_phone/core/roster.ts)、[field-contracts.ts](src/UBS_phone/core/field-contracts.ts)） |
| **世界演化联动防轰炸（协同现状）** | ✅ 上游已修（在状态栏仓） | 小手机侧接收端 [world-link.ts](src/UBS_phone/core/world-link.ts) 保持原样（允许陌生人符合直觉、保留正文联动气泡）；强制每轮发独立微信的问题已在状态栏 `0.1.0-alpha.4` 解除并加冷却门控 |
| **标签剥离分层与短信/电话思考防误伤** | ✅ 代码+单测完成 | 同步 `contextKeepTags`/优先级保护与逐楼独立清洗（`readStrippedAiChatHistory`）；修复 `story-link.ts` 从 `<thinking>` 内误提 `<微信>`/`<通话>` 及 `chat-parser.ts`/`call-parser.ts` 被正文 `</think>` 误截断（`v0.1.0-alpha.4`） |
| **屏内与进度 Toast 半透明紧凑及防误触** | ✅ 代码+单测完成 | `phone-theme.ts` 屏内 `.ubp-toast` 改为半透明玻璃与缩小尺寸；`ai-activity-notify.ts` 新增贴边防误触转关闭与单开/原版 `30×30` 大 `×` 兜底样式（[phone-theme.ts](src/UBS_phone/styles/phone-theme.ts)、[ai-activity-notify.ts](src/UBS_phone/core/ai-activity-notify.ts) `v0.1.0-alpha.5`） |
| **API 预设出站兼容（source / top_p / 中段 system）** | ✅ 代码+单测完成 | [phone-api.ts](src/UBS_phone/core/phone-api.ts) 的 `presetToApi` 对齐主项目 `api-config.ts`：非 `openai` 的 `source` 透传（`openai` 不显式写）、`top_p` 越界（`<=0` 或 `>1`，如 DeepSeek 拒收的 `0`）归 `'unset'`、并按预设 `promptPostProcessing` 在 `custom_api` 上登记策略（缺失回退 `semi`）；出站层 `ai-tool-shield` 据此把首条对话消息之后的 `system`/`developer` 降级为 `user`（兼容 gpt-load / Gemini / Claude 网关）。新增 `tests/ai-tool-shield.test.mjs`（`0.1.0-alpha.7`） |
| **真机回归验收** | ⏳ 待继续验证 | 正文联动气泡渲染 + 手机 TT 双开联跑 + 窥私/消息记录世界书长期运行待真机观察 |

---

## 3. 角色卡开发必读：正文标签、世界书与数据表契约

### 3.1 正文联动格式标签（主对话 AI 正文按需输出 → 渲染气泡 + 同步入库）

当用户开启「正文联动」时，小手机会把 `<正文手机格式>` 注入角色主世界书，并在收到 AI 回复后通过正则渲染成消息气泡/通话卡/社媒动态卡（[story-link.ts](src/UBS_phone/core/story-link.ts) & [protocol-tags.ts](src/UBS_phone/core/protocol-tags.ts)）：

- **私聊 / 角色间微信标签（四风格别名永久兼容解析与渲染）**：
  - 现代 `<微信>`、仙侠 `<传讯>`、武侠 `<飞鸽>`、西幻 `<晶讯>`
  - **严格三字段语法**（内容中禁用 `|` 与 `<`）：
    - 主角发出：`<微信>我|对方角色名|内容</微信>`
    - 角色发来：`<微信>角色名|我|内容</微信>`（解析同时兼容旧两字段 `<微信>角色名|内容</微信>`）
    - 角色对角色（写进窥私域）：`<微信>发送角色名|接收角色名|内容</微信>`
- **通话块标签**：现代 `<通话>`、仙侠 `<传音>`、武侠 `<传声>`、西幻 `<远语>`，内部每行 `角色名：台词` 或 `我：台词`。
- **社媒动态标签**：现代 `<动态>`、仙侠 `<风闻>`、武侠 `<榜帖>`、西幻 `<见闻>`
  - 朋友圈/微博：`<动态>朋友圈|作者|内容</动态>`、`<动态>微博|作者|内容</动态>`
  - 小红书：`<动态>小红书|作者|标题|内容</动态>`
  - 贴吧：`<动态>贴吧|吧名|作者|标题|内容</动态>`
- **内置应用结构块标签**（供小手机内部 AI 使用，见 [protocol-tags.ts](src/UBS_phone/core/protocol-tags.ts)）：`<ubp_reply>`、`<ubp_atmo>`、`<ubp_call>`、`<ubp_voicemail>`、`<ubp_spy>`、`<ubp_night>`、`<ubp_social>`、`<ubp_author>`、`<浏览器>`（`<天机阁>`/`<江湖录>`/`<贤者之镜>`）、`<商城>`（`<万宝阁>`/`<悦来商行>`/`<奇物商栈>`）。

### 3.2 小手机注入角色主世界书的受管条目（前缀 `[UBS手机]`）

全部通过状态栏协调器 `__ubWorldbookProjection` 写入，**角色卡勿自建 `[UBS手机]` 前缀条目**：

| 条目名 / 前缀 | 触发模式 | 位置与 `order` | 用途与扫描钩子规则 |
|---|---|---|---|
| `[UBS手机]正文微信电话格式` | `constant` | `at_depth` (`system`, `depth: 0`, `order: 104`) | 教主对话 AI 按需写正文气泡；**插件内部 AI 管线扫描时一律剔除** |
| `[UBS手机]防全知说明` | `constant` | `before_character_definition` (`depth: 2`, `order: 8008`) | 约束 AI 区分私聊/群聊/社媒可见范围；演化/窥私/采访/调查 `keepPhoneRecordEntries` 放行 |
| `[UBS手机]消息记录-<角色名>` | `selective` (key=角色名) | `before_character_definition` (`depth: 2`, `order: 8009`) | 注入该角色与主角的近期手机/通话/社媒混合记录（受 `messageWorldbook` 开关控制） |
| `[UBS手机]窥私记录防全知说明` | `constant` | `before_character_definition` (`depth: 2`, `order: 8010`) | 声明角色间私密记录主角不知晓 |
| `[UBS手机]窥私记录-<角色名>` | `selective` (key=角色名) | `before_character_definition` (`depth: 2`, `order: 8011`) | 注入角色间窥私记录（受 `spyWorldbook` 开关控制） |
| `[UBS手机]消息记录公共舆论` | `constant` | 同区受控长度 | 可选注入热搜榜与公开帖子摘要（默认关闭） |

### 3.3 通讯录与表格数据源只读依赖

[roster.ts](src/UBS_phone/core/roster.ts) 与各引擎通过 `SeseLedgerAPI` / `AutoCardUpdaterAPI` 只读读取以下表（改卡内表名/改台账模板列名时须核对 `field-contracts.ts`）：
- 角色与关系：`主角信息表`、`恋爱对象表`、`重要角色表`、`人物关系表`、`在场角色表`、`NSFW信息表`、`人物性格偏移表`
- 环境与剧情：`全局数据表`、`备忘录`（今日/明日日程提醒）、`纪要表`、`物品表`

### 3.4 宿主窗口跨插件桥接（暴露于 `window` / `parent`）

| 全局接口 | 位置 | 用途 |
|---|---|---|
| `window.__ubp_world_inject(events)` | [world-link.ts](src/UBS_phone/core/world-link.ts) | 接收状态栏世界演化 `<phone>` 事件（`message`/`call`/`social`）及货币正文转账/红包（`money`） |
| `window.__ubp_phone_style()` | [world-link.ts](src/UBS_phone/core/world-link.ts) | 向状态栏回报当前聊天风格（`modern`/`xianxia`/`wuxia`/`fantasy`） |
| `window.__ubp_toggle(force?)` / `__ubp_on_chat_changed()` | [index.ts](src/UBS_phone/index.ts) | 状态栏入口按钮切换手机面板 & 同步切聊天重绑 |

---

## 4. 模块与关键源码索引

| 目录 / 文件 | 职责 |
|---|---|
| [src/UBS_phone/index.ts](src/UBS_phone/index.ts) | 扩展入口、宿主挂载、悬浮球、监听桥接注册与卸载 |
| [src/UBS_phone/core/story-link.ts](src/UBS_phone/core/story-link.ts) | 正文联动（世界书格式注入、展示正则注册、`MESSAGE_RECEIVED` 提取与 swipe 替换） |
| [src/UBS_phone/core/world-link.ts](src/UBS_phone/core/world-link.ts) | 接收状态栏世界演化与货币系统推入的消息/来电/社媒/转账事件 |
| [src/UBS_phone/core/chat-engine.ts](src/UBS_phone/core/chat-engine.ts) / `chat-prompts.ts` / `chat-model.ts` / `chat-parser.ts` | 微信私聊、群聊（含气氛组）、好友申请裁决引擎 |
| [src/UBS_phone/core/message-worldbook.ts](src/UBS_phone/core/message-worldbook.ts) & [spy-worldbook.ts](src/UBS_phone/core/spy-worldbook.ts) | 手机消息记录与窥私记录向主世界书的投影构造 |
| [src/UBS_phone/core/roster.ts](src/UBS_phone/core/roster.ts) & [field-contracts.ts](src/UBS_phone/core/field-contracts.ts) | 台账/数据库只读缓存与字段契约自检 |
| [src/UBS_phone/core/social-*.ts](src/UBS_phone/core/social-engine.ts) / `spy-*.ts` / `call-*.ts` / `night-*.ts` / `game-*.ts` / `browser-*.ts` / `shop-*.ts` | 朋友圈/贴吧/微博/小红书、窥私域、通话留言、不夜城、谁是卧底/狼人杀/海龟汤、幻想浏览器、网上商城引擎 |
| [src/UBS_phone/core/phone-settings.ts](src/UBS_phone/core/phone-settings.ts) & [phone-api.ts](src/UBS_phone/core/phone-api.ts) | 手机独立设置（复用状态栏 API 预设仓库）与缩放存储 |
| [src/UBS_phone/renderers/](src/UBS_phone/renderers/app-wechat.ts) | Shadow DOM 手机端 UI 与各 App 渲染器 |

---

## 5. 构建与自检命令

在 `n-sese-suite/n-sese-phone` 目录下执行：

```powershell
npm run build   # esbuild 打包 dist/index.js
npm test        # node --test tests/*.test.mjs（当前 37 通过 / 2 跳过 / 0 失败，共 39）
npm run check   # scripts/check-release.mjs：清单、依赖及 src/ SHA-256 完整性校验
```

> 若修改了 `src/` 下任意文件，必须先重算 `source-files.sha256.json` 与执行 `npm run build`，否则 `npm run check` 会失败。

---

## 6. 改造记录（Changelog，后续 AI 改完必须按此表倒序追加）

| 日期 | 版本 / Commit | 改动范围与摘要 | 验证状态 |
|---|---|---|---|
| 2026-11-17 | `0.1.0-alpha.8` | 同步状态栏 `api-config.ts` 修复：`fetchModelList` 在 `source === 'makersuite'` 时优先直连 `/v1beta/models` 并仅以 `/v1` 回退宿主 `getModelList`，避免裸根地址撞管理页 HTML | `build` / `test` 37 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.7` | `phone-api.ts` 的 `presetToApi` 对齐主项目 `api-config.ts`：透传非 `openai` 的 `source`（`openai` 不显式写）、`top_p` 越界归 `'unset'`、按 `promptPostProcessing` 在 `custom_api` 上登记出站策略（缺失回退 `semi`）；新增 `tests/ai-tool-shield.test.mjs` 锁定上述行为与「`phoneFullSlots()` 含尾部破限 + `semi` 规整后首条对话消息之后无 `system`/`developer`」 | `build` / `test` 37 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.6` | 内嵌 `env.ts` 的 `getToastr()` 统一为小手机全部 toast（含 `phoneNotify` 及内嵌报错）自动加「小手机」前缀；`phone-ui.ts` 统一短名；扩展 `tests/toast-ui.test.mjs` | `build` / `test` 35 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.5` | 小手机屏内 `.ubp-toast` 改为半透明磨砂（`0.52` + `blur(8px)`）与紧凑字号间距；`ai-activity-notify.ts` 新增关闭钮安全缓冲带防误触与单开半透明/大 `×` 兜底样式；新增 `tests/toast-ui.test.mjs` | `build` / `test` 34 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.4` | 同步 `contextKeepTags` 与剥离标签优先级保护；全引擎改用 `readStrippedAiChatHistory` 逐楼独立清洗；`story-link.ts` 提取前剔除思考与非正文块；`chat-parser.ts` `stripThinkingBlocks` 改为栈式清除且绝不误切 `<ubp_*>` 内 `</think>`；新增 `tests/context-strip.test.mjs` | `build` / `test` 32 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-15 | `0.1.0-alpha.3` | 同步升级内嵌 `context-strip.ts` 为单遍栈式配对剥离防止误吞正文，并重写本仓 `README.md`（契约索引、改造进展与维护记录铁律） | `build` / `test` 23 通过 2 跳过 / `check` 全绿 |
| 2026-11-13 | `0.1.0-alpha.2` (`ff44500`) | 解耦桌面端缩放并修复电脑端尺寸及窗口 resize 悬浮球越界 | `build` / `test` / `check` 通过 |
| 2026-11-07 | `table-v1` (`c8ba542` / `39fae22`) | 适配台账工作台数据编辑与字段影响保护；修正经历语义与字段诊断取数 | 当轮测试与构建通过 |
