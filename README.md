# 瑟瑟小手机（`n-sese-phone`）

> **致后续接手本仓库的 AI（强制维护纪律）**
> 1. **每次修改本仓库代码、正文联动标签协议、世界书投影或对外桥接接口后，必须同步更新本 README**（至少更新第 2 节状态表、第 5 节测试数与第 6 节改造记录），严禁只改代码不留记录。
> 2. **先读再改，按序交付（长期明确授权）**：
>    1. 改代码 / 文档；
>    2. 改到 `src/` 时刷新 `source-files.sha256.json` 对应条目并重建 `dist/index.js`；
>    3. **仅功能 / 界面 / 修复类改动**才递增 4 处版本号（`manifest.json`、`package.json`、`package-lock.json` 顶层与 `packages[""]`）并更新本 README，**纯文档同步不递增版本号**；
>    4. 最终 `npm run build`、`npm test`、`npm run check` 全绿（CI 另跑 `git diff --exit-code -- dist`）；
>    5. 显式 `git add <文件路径…>`（禁止 `git add -A`）、`git commit`、`git push origin main`（无需逐次询问，也不要打包 zip，详见 [AGENTS.md](AGENTS.md)）。
> 3. **做角色卡联动必看**：第 3 节列出了正文联动全风格标签、世界书防全知条目与 `order`、以及小手机对台账表列的只读依赖。写角色卡时要严格对齐标签名与分隔符。

---

## 1. 定位与运行依赖

- **扩展名称**：`瑟瑟小手机`（`manifest.json` `loading_order: 220`，在 `n-sese-unified-statusbar` `200` 与 `n-sese-ledger` `210` 之后装载）
- **当前版本**：`0.1.0-alpha.14`（当前 HEAD `12072e8`，最初基于 `1c7ee30` 推进；功能性改动递增版本并推仓供 TT 拉取测）
- **最低客户端版本**：`minimum_client_version: 1.13.0`（见 `manifest.json`）
- **版本口径**：扩展分发版本只看 `manifest.json`（以及必须保持一致的 `package.json` / `package-lock.json`）。[src/UBS_phone/core/version.ts](src/UBS_phone/core/version.ts) 里的 `PHONE_VERSION = 'V1.308'` 与 `PHONE_BUILD_TAG` 只是手机内部 UI / 日志的显示锚点，不参与扩展版本判定。
- **全局设置存储**：服务器文件 `usb_global_phone-settings_<hash>.json`（由 [core/phone-settings.ts](src/UBS_phone/core/phone-settings.ts) 管理；API 预设仓库读取自状态栏 `customApiPresets`）；桌面端缩放键走 `localStorage['ubp_desktop_phone_zoom_v1']`。
- **安装使用**：
  1. 先安装并启用酒馆助手（JS-Slash-Runner）。
  2. 在酒馆「扩展 → 安装扩展」粘贴本仓库地址，装好后刷新页面；同名旧脚本请先停用。
  3. 进入角色聊天后点击手机悬浮按钮使用。
- **功能边界**：
  - **独立可用**：手机壳、微信 / 电话 / 社媒 / 窥私 / 不夜城 / 游戏中心 / 商城 / 纪要 / 相机 / 相册 / 录音机 / 浏览器等 App，以及本地存储、自动备份，均可单独运行。
  - **依赖状态栏 / 台账**：API 预设仓库、世界书投影协调、花名册只读字段、生图闸门与人物一致性 tag、一键搬家桥。对应桥不存在时这些联动降级为空操作，手机其余功能不受影响。
- **来源与参考**：业务原始源码源自原作者 2026-10-25 公开分享包（原作者已停更）；本仓库是独立工程化（esbuild 构建、测试套件、跨仓联动）与后续迭代维护版本，版权归属见 [SOURCE_NOTICE.md](SOURCE_NOTICE.md) 与 [src/README.md](src/README.md)。 · [简易教程](https://docs.google.com/document/d/1f5B-GmNLJExH7FE9bwpOb4Ditx5EDHfQtTIXY0WDnX4/edit)

---

## 2. 当前改造状态与未完成项（截至 2026-11-25）

| 模块 / 功能 | 当前状态 | 关键证据与说明 |
|---|---|---|
| **手机/桌面双端壳与缩放适配** | ✅ 代码+单测完成 | 桌面端缩放与移动端（`<= 600px`）解耦，修复电脑端尺寸及窗口 resize 悬浮球越界（`ff44500`）；当轮 `npm test` 为 23 通过 / 2 跳过（历史基线，当前计数见第 5 节），`npm run check` 通过 |
| **台账只读消费与字段诊断** | ✅ 代码+单测完成 | 优先通过 `SeseLedgerAPI`（回落 `AutoCardUpdaterAPI`）读取表数据并登记字段契约；经历与近期亲密互动口径已对齐（[roster.ts](src/UBS_phone/core/roster.ts)、[field-contracts.ts](src/UBS_phone/core/field-contracts.ts)） |
| **世界演化联动防轰炸（协同现状）** | ✅ 上游已修 + 本仓联动加好友 | [world-link.ts](src/UBS_phone/core/world-link.ts) 投递消息/转账红包时自动 `addFriend` 避免卡在好友申请分支；强制每轮发独立微信的问题已在状态栏 `0.1.0-alpha.4` 解除并加冷却门控 |
| **标签剥离分层与短信/电话思考防误伤** | ✅ 代码+单测完成 | 同步 `contextKeepTags`/优先级保护与逐楼独立清洗（`readStrippedAiChatHistory`）；修复 `story-link.ts` 从 `<thinking>` 内误提 `<微信>`/`<通话>` 及 `chat-parser.ts`/`call-parser.ts` 被正文 `</think>` 误截断（`v0.1.0-alpha.4`） |
| **屏内与进度 Toast 半透明紧凑及防误触** | ✅ 代码+单测完成 | `phone-theme.ts` 屏内 `.ubp-toast` 改为半透明玻璃与缩小尺寸；`ai-activity-notify.ts` 新增贴边防误触转关闭与单开/原版 `30×30` 大 `×` 兜底样式（[phone-theme.ts](src/UBS_phone/styles/phone-theme.ts)、[ai-activity-notify.ts](src/UBS_phone/core/ai-activity-notify.ts) `v0.1.0-alpha.5`） |
| **API 预设出站兼容（source / top_p / 中段 system）** | ✅ 代码+单测完成 | [phone-api.ts](src/UBS_phone/core/phone-api.ts) 的 `presetToApi` 对齐主项目 `api-config.ts`：非 `openai` 的 `source` 透传（`openai` 不显式写）、`top_p` 越界（`<=0` 或 `>1`，如 DeepSeek 拒收的 `0`）归 `'unset'`、并按预设 `promptPostProcessing` 在 `custom_api` 上登记策略（缺失回退 `semi`）；出站层 `ai-tool-shield` 据此把首条对话消息之后的 `system`/`developer` 降级为 `user`（兼容 gpt-load / Gemini / Claude 网关）。新增 `tests/ai-tool-shield.test.mjs`（`0.1.0-alpha.7`） |
| **后台 AI 请求提示词与外挂世界书清洗** | ✅ 代码+单测完成 | 同步状态栏四道净化共享件（默认仅放行 `primary` 主世界书、屏蔽 `globalLore`/`additional`/`chatLore`、剔除 `role:assistant`、启用内置正文向核心词根过滤并出站剥离第三方扩展注入，同时保持 `[UBS手机]` `keepSpyRecordEntries`/`keepPhoneRecordEntries` 放行族）；[phone-raw.ts](src/UBS_phone/core/phone-raw.ts) `phoneFullSlots()` 移除 `'chat_history'`；[chat-images.ts](src/UBS_phone/core/chat-images.ts) 与 [shop-images.ts](src/UBS_phone/core/shop-images.ts) 补齐 `max_chat_history: 0`；保留楼层标签剥离不变；扩展 `tests/ai-tool-shield.test.mjs`（`0.1.0-alpha.9`–`10`） |
| **资料块内联直传（修复无 `chat_history` 后社媒求回应及全引擎资料丢失）** | ✅ 代码+单测完成 | [phone-raw.ts](src/UBS_phone/core/phone-raw.ts) 新增 `dossier` 入参并由 `phoneFullSlots(dossier)` 直接内联为 `dialogue_examples` 与 `user_input` 之间的 `system` 槽位，`social/chat/call/spy/browser/night/shop/shop-chat` 8 个引擎全线取消失效的 `injectPrompts(after_system)`（仅保留 `position:'none'` 绿灯触发）；新增 `tests/social-feedback-dossier.test.mjs` 回归覆盖（`0.1.0-alpha.11`） |
| **正文联动主角真名映射与微信发消息自动回复** | ✅ 代码+单测完成 | [story-link.ts](src/UBS_phone/core/story-link.ts) 将主角真名归一（同时匹配 `protagonistName` 与 `{{user}}`）前置到 `spyEnabled` 过滤前并自动 `addFriend`；修复 `ensureStoryLinkInjection` 对 `scriptName` 与 `disabled` 的漏判；[app-wechat.ts](src/UBS_phone/renderers/app-wechat.ts) 取消「待发送 N 条」攒批机制，发送文本/图片/语音/转账红包即自动触发 AI 回复并在忙碌期队列接力；新增 `tests/wechat-story-link.test.mjs`（`0.1.0-alpha.13`） |
| **正文联动群聊规则与自动建群映射** | ✅ 代码+单测完成 | [story-link.ts](src/UBS_phone/core/story-link.ts) 新增四字段群聊协议 `<微信>群|群名|发送人|内容</微信>`（含仙侠/武侠/西幻别名与互斥渲染正则 `0009`/`0010`）及三字段群名兜底 `resolveStoryGroupEvents`（命中已有群聊或未入通讯录的常见群名后缀），提取时自动建出真 `kind:'group'` 群会话、拉齐成员并 `addFriend`；[story-link-enhance.ts](src/UBS_phone/renderers/story-link-enhance.ts) 按 `data-group` 独立成框并保留群成员署名（`0.1.0-alpha.14`） |
| **真机回归验收** | ⏳ 待继续验证 | 正文联动气泡渲染 + 手机 TT 双开联跑 + 窥私/消息记录世界书长期运行待真机观察 |

---

## 3. 角色卡开发必读：正文标签、世界书与数据表契约

### 3.1 正文联动格式标签（主对话 AI 正文按需输出 → 渲染气泡 + 同步入库）

当用户开启「正文联动」时，小手机会把 `<正文手机格式>` 注入角色主世界书，并在收到 AI 回复后通过正则渲染成消息气泡/通话卡/社媒动态卡（[story-link.ts](src/UBS_phone/core/story-link.ts) & [protocol-tags.ts](src/UBS_phone/core/protocol-tags.ts)）：

- **私聊 / 角色间微信标签（四风格别名永久兼容解析与渲染）**：
  - 现代 `<微信>`、仙侠 `<传讯>`、武侠 `<飞鸽>`、西幻 `<晶讯>`
  - **私聊 / 角色间三字段语法**（内容中禁用 `|` 与 `<`）：
    - 主角发出：`<微信>我|对方角色名|内容</微信>`
    - 角色发来：`<微信>角色名|我|内容</微信>`（解析同时兼容旧两字段 `<微信>角色名|内容</微信>`）
    - 角色对角色（写进窥私域）：`<微信>发送角色名|接收角色名|内容</微信>`
  - **群聊四字段语法**：`<微信>群|群名|发送人|内容</微信>`（主角发言写 `<微信>群|群名|我|内容</微信>`；三字段写成群名后缀或已有群名时提取侧自动兜底归群）
- **通话块标签**：现代 `<通话>`、仙侠 `<传音>`、武侠 `<传声>`、西幻 `<远语>`，内部每行 `角色名：台词` 或 `我：台词`。
- **社媒动态标签**：现代 `<动态>`、仙侠 `<风闻>`、武侠 `<榜帖>`、西幻 `<见闻>`
  - 朋友圈/微博：`<动态>朋友圈|作者|内容</动态>`、`<动态>微博|作者|内容</动态>`
  - 小红书：`<动态>小红书|作者|标题|内容</动态>`
  - 贴吧：`<动态>贴吧|吧名|作者|标题|内容</动态>`
- **内置应用结构块标签**（供小手机内部 AI 使用，见 [protocol-tags.ts](src/UBS_phone/core/protocol-tags.ts)）：`<ubp_reply>`、`<ubp_atmo>`、`<ubp_call>`、`<ubp_voicemail>`、`<ubp_spy>`、`<ubp_night>`、`<ubp_social>`、`<ubp_author>`、`<浏览器>`（`<天机阁>`/`<江湖录>`/`<贤者之镜>`）、`<商城>`（`<万宝阁>`/`<悦来商行>`/`<奇物商栈>`）。

> **更新插件后必做（两步，分开验收）**：
> 1. 在酒馆进入「扩展 → 小手机 → 设置 → 正文联动」，核对渲染正则是否齐全（含群聊互斥正则 `0009` / `0010`），缺哪条就补哪条并刷新页面——旧版正则会把这些标签整段原样显示。
> 2. 先验**正文气泡渲染**：AI 输出一条 `<微信>…</微信>` 后，消息层应出现气泡卡；再验**手机内真群聊落库**：打开微信应看到对应会话与成员，群聊消息带发送人署名。两步不是同一件事，气泡正常不代表落库成功。

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

| 全局接口 | 位置 | 方向 | 用途 |
|---|---|---|---|
| `window.__ubp_world_inject(events)` | [world-link.ts](src/UBS_phone/core/world-link.ts) | 状态栏 → 手机 | 接收世界演化 `<phone>` 事件（`message`/`call`/`social`）与货币正文转账/红包（`money`） |
| `window.__ubp_phone_style()` | [world-link.ts](src/UBS_phone/core/world-link.ts) | 手机 → 状态栏 | 回报当前聊天风格（`modern`/`xianxia`/`wuxia`/`fantasy`） |
| `window.__ubp_toggle(force?)` / `__ubp_on_chat_changed()` | [index.ts](src/UBS_phone/index.ts) | 状态栏 → 手机 | 切换手机面板 & 切聊天重绑 |
| `window.__ubWorldbookProjection` + `ub-worldbook-projection-ready` | [message-worldbook.ts](src/UBS_phone/core/message-worldbook.ts)、[spy-worldbook.ts](src/UBS_phone/core/spy-worldbook.ts)、[host-readiness.ts](src/UBS_phone/core/host-readiness.ts) | 手机 → 状态栏 | 注册消息记录 / 窥私投影描述符；桥未就绪时等 ready 事件后再注册 |
| `window.__ubStorageRelocation` + `ub-storage-relocation-ready` | [phone-relocation.ts](src/UBS_phone/core/phone-relocation.ts) | 手机 → 状态栏 | 一键搬家时把手机数据文件复制到新 storageId |
| `window.__ub_currency_host` | [currency-link.ts](src/UBS_phone/core/currency-link.ts) | 状态栏 → 手机 | 货币元数据与变更通知（转账 / 红包口径） |
| `window.__ubImageGenQueue` | [chat-images.ts](src/UBS_phone/core/chat-images.ts)、[social-images.ts](src/UBS_phone/core/social-images.ts) | 手机 → 状态栏 | 共享生图闸门：多图排队、与主项目生图互不并发 |
| `__ubPortraitCharTags` / `__ubPortraitFanwork` / `__ubPortraitFanTags` | [chat-image-prompts.ts](src/UBS_phone/core/chat-image-prompts.ts) | 手机 → 状态栏 | 人物一致性 tag 与同人身份 tag 只读注入；桥缺失时回落散文 |
| `window.__ub_openLightbox` | [image-lightbox.ts](src/UBS_phone/renderers/image-lightbox.ts) | 手机 → 状态栏 | 成品图点击放大走宿主三槽灯箱 |
| `window.__ub_resetFloatBtn` | [phone-ui.ts](src/UBS_phone/renderers/phone-ui.ts) | 手机 → 状态栏 | 悬浮球「重置到屏幕中间」 |
| 广播 `ub-phone-online` | [index.ts](src/UBS_phone/index.ts) / `unified-statusbar/core/cross-window.ts` | 手机 → 状态栏 | 手机上线通知，宿主据此探测手机桥 |

> **内嵌共享件同步边界**：`src/unified-statusbar/core/`（83 个文件）是副本，其中 `env.ts` / `data-manager.ts` / `ledger-takeover.ts` / `worldbook-projection-events.ts` 为小手机定制、`external-projection-client.ts` 为伴生仓投影对接专用——禁止整目录覆盖，同步按单文件 diff 进行；改完刷新 `source-files.sha256.json` 并重建 `dist/index.js`。

---

## 4. 模块与关键源码索引

| 目录 / 文件 | 职责 |
|---|---|
| [index.js](index.js) / [runtime/extension.js](runtime/extension.js) / [runtime/config.js](runtime/config.js) | 扩展装载层：依赖探测、单例守卫、设置面板、`import('dist/index.js')`；`template: false` 关闭状态栏模板壳 |
| [src/UBS_phone/index.ts](src/UBS_phone/index.ts) | 扩展入口、宿主挂载、悬浮球、桥注册与卸载、16 个 App 注册 |
| [src/UBS_phone/core/story-link.ts](src/UBS_phone/core/story-link.ts) | 正文联动（世界书格式注入、展示正则注册、`MESSAGE_RECEIVED` 提取与 swipe 替换） |
| [src/UBS_phone/core/world-link.ts](src/UBS_phone/core/world-link.ts) | 接收状态栏世界演化与货币系统推入的消息/来电/社媒/转账事件 |
| [src/UBS_phone/core/chat-engine.ts](src/UBS_phone/core/chat-engine.ts) / `chat-prompts.ts` / `chat-model.ts` / `chat-parser.ts` | 微信私聊、群聊（含气氛组）、好友申请裁决引擎 |
| [src/UBS_phone/core/message-worldbook.ts](src/UBS_phone/core/message-worldbook.ts) & [spy-worldbook.ts](src/UBS_phone/core/spy-worldbook.ts) | 手机消息记录与窥私记录向主世界书的投影构造 |
| [src/UBS_phone/core/roster.ts](src/UBS_phone/core/roster.ts) & [field-contracts.ts](src/UBS_phone/core/field-contracts.ts) | 台账/数据库只读缓存与字段契约自检 |
| [src/UBS_phone/core/social-*.ts](src/UBS_phone/core/social-engine.ts) / `spy-*.ts` / `call-*.ts` / `night-*.ts` / `game-*.ts` / `browser-*.ts` / `shop-*.ts` | 朋友圈/贴吧/微博/小红书、窥私域、通话留言、不夜城、谁是卧底/狼人杀/海龟汤、幻想浏览器、网上商城引擎 |
| [src/UBS_phone/core/phone-settings.ts](src/UBS_phone/core/phone-settings.ts) & [phone-api.ts](src/UBS_phone/core/phone-api.ts) | 手机独立设置（复用状态栏 API 预设仓库）与缩放存储 |
| [src/UBS_phone/core/chronicle.ts](src/UBS_phone/core/chronicle.ts) & [renderers/app-chronicle.ts](src/UBS_phone/renderers/app-chronicle.ts) | 纪要：从正文纪事块抽取并落库 |
| [src/UBS_phone/core/global-search.ts](src/UBS_phone/core/global-search.ts) & [renderers/global-search-sheet.ts](src/UBS_phone/renderers/global-search-sheet.ts) | 全局搜索：跨 App 的会话 / 消息 / 联系人检索 |
| [src/UBS_phone/core/phone-backup.ts](src/UBS_phone/core/phone-backup.ts) | 自动备份：定时打包手机数据文件 |
| [src/UBS_phone/core/phone-storage-manager.ts](src/UBS_phone/core/phone-storage-manager.ts) & [phone-relocation.ts](src/UBS_phone/core/phone-relocation.ts) & [renderers/storage-manager-sheet.ts](src/UBS_phone/renderers/storage-manager-sheet.ts) | 存储管理、用量统计、一键搬家桥 |
| [src/UBS_phone/renderers/app-camera.ts](src/UBS_phone/renderers/app-camera.ts) / [app-album.ts](src/UBS_phone/renderers/app-album.ts) / [app-recorder.ts](src/UBS_phone/renderers/app-recorder.ts) | 相机、相册、录音机 |
| [src/UBS_phone/renderers/](src/UBS_phone/renderers/app-registry.ts) | Shadow DOM 手机壳、16 个 App 渲染器、弹层与共用 UI；`app-registry.ts` 为注册表 + 内部事件总线（`ubp-phone:*`） |

**已注册 App（16 个）**：微信、相机、相册、录音机、浏览器、朋友圈、贴吧、微博、小红书、电话、窥私、游戏中心、不夜城、商城、纪要、设置。

---

## 5. 构建与自检命令

在 `n-sese-suite/n-sese-phone` 目录下执行（Node `>=22.12.0`；CI 用 Node 24；新克隆先 `npm ci`）：

```powershell
npm ci          # 按 package-lock.json 安装（新克隆 / 换 Node 版本后首次）
npm run build   # esbuild 打包 dist/index.js（entry: src/UBS_phone/index.ts）
npm test        # node --test tests/*.test.mjs（当前 45 通过 / 2 跳过 / 0 失败，共 47）
npm run check   # scripts/check-release.mjs：清单一致性、入口依赖可解析、src/ SHA-256 完整性
```

> 若修改了 `src/` 下任意文件，必须先重算 `source-files.sha256.json` 中**该文件**的 SHA-256 并执行 `npm run build`，否则 `npm run check` 会失败。

**2 个跳过项的固定原因**（不是失败）：

- `tests/field-contracts.test.mjs` 的标准模板用例：未设置 `PHONE_STANDARD_TEMPLATE`（本仓不附完整标准模板 JSON，设置后即可执行）。
- `tests/loader.test.mjs` 的「聊天清空后恢复状态栏壳」用例：`runtime/config.js` 中 `template: false`，小手机没有状态栏 HTML 壳可恢复。

**`check-release.mjs` 的真实校验范围**（别高估它）：

- **校验**：`manifest.json` 与 `package.json` 版本一致；`homePage` 指向 `github.com/<name>`；`js` 为 `index.js`；版本号格式合法；`index.js` / `runtime/extension.js` / `runtime/config.js` / `dist/index.js` / `SOURCE_NOTICE.md` / `README.md` 存在；`index.js` 的本地静态依赖能被 esbuild 解析；`dist/index.js` 非空且不含本机绝对路径；`source-files.sha256.json` 中**已登记**条目的 SHA-256 一致。
- **不校验**：`package-lock.json` 的版本是否同步；**新增但未登记**的 `src/` 文件（只遍历清单里已有的键，不会自动发现漏登记）；`dist/index.js` 与源码是否同构——CI 另跑 `git diff --exit-code -- dist`，用「构建后无差异」间接证明。
- 因此新增 `src/` 文件时，必须手动往 `source-files.sha256.json` 的 `files` 里补一行，否则 check 照样通过，而清单已经漏项。

**更新 `source-files.sha256.json` 的方法**：只改变更条目，键为仓库相对路径（必须以 `src/` 开头、不得含 `..`），值为小写 hex SHA-256：

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath 'src/README.md').Hash.ToLower()
# 或：node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('src/README.md')).digest('hex'))"
```

---

## 6. 改造记录（Changelog，后续 AI 改完必须按此表倒序追加）

| 日期 | 版本 / Commit | 改动范围与摘要 | 验证状态 |
|---|---|---|---|
| 2026-11-26 | `0.1.0-alpha.14` (docs) | 补全并更新 README / AGENTS / SOURCE_NOTICE / src 说明（版本锚点边界、完整桥接、模块索引与交接规范），同步刷新 `src/*.md` SHA-256 清单；未改代码，不递增版本号 | 纯文档同步，`build` / `test` / `check` 复跑全绿 |
| 2026-11-25 | `0.1.0-alpha.14` | 打通正文联动微信群聊规则与自动建群映射：[story-link.ts](src/UBS_phone/core/story-link.ts) 世界书格式条目新增四字段群聊写法 `<微信>群|群名|发送人|内容</微信>`（含 `<传讯>`/`<飞鸽>`/`<晶讯>` 别名）并配互斥渲染正则 `0009`/`0010`；新增 `resolveStoryGroupEvents` 在窥私过滤前把「目标已是群聊」或「未入通讯录的群名后缀」三字段消息自动归群，首次建出 `kind:'group'` 真群聊（规避同毫秒建群 id 碰撞）并拉齐发言/@成员与 `addFriend`；[story-link-enhance.ts](src/UBS_phone/renderers/story-link-enhance.ts) 按 `data-group` 独立成框且保留群成员署名；扩展 `tests/wechat-story-link.test.mjs` 群聊用例 | `build` / `test` 45 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-25 | `0.1.0-alpha.13` | 修复正文联动 `<微信>`/`<通话>` 主角真名在未开窥私时被吞掉的缺陷（将 `resolveStoryProtagonistEvents` 前置到 `spyEnabled` 过滤前，兼容匹配 `主角信息表.姓名` 与 `{{user}}`/`SillyTavern.name1`，且正文联动与世界演化投递消息/转账自动 `addFriend` 不再卡「未加好友申请分支」）；修复 `ensureStoryLinkInjection` 补丁匹配 `scriptName` 与 `disabled` 漏判；[app-wechat.ts](src/UBS_phone/renderers/app-wechat.ts) 移除我方消息「待发送 N 条」二次点击限制，文本/图片/语音/转账红包/相册发送即自动触发 AI 回复并在忙碌期队列接力（点「终止」清空队列）；新增 `tests/wechat-story-link.test.mjs` | `build` / `test` 44 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-19 | `0.1.0-alpha.12` | 清理 `*-prompts.ts` 8 处遗留 `after_system` 注释与 `phoneFullSlots` 内联口径对齐 | `build` / `test` 40 通过 2 跳过 / `check` 全绿；待真机验收 |
| 2026-11-19 | `0.1.0-alpha.11` | 修复移除 `'chat_history'` 槽位后 `injectPrompts({ position: 'after_system' })` 资料块被宿主跳过的故障（导致社媒发帖/点赞后求回应报错「缺少『待反馈的用户互动』『现有评论』资料块」）：[phone-raw.ts](src/UBS_phone/core/phone-raw.ts) 支持将 `dossier` 直接内联为 `ordered_prompts` 中 `dialogue_examples` 与 `user_input` 之间的 `system` 槽位，全线迁移 `social-engine` / `chat-engine` / `call-engine` / `spy-engine` / `browser-engine` / `night-engine` / `shop-engine` / `shop-chat-engine` 8 个引擎（仅保留 `position:'none'` 绿灯触发）；扩展 `tests/ai-tool-shield.test.mjs` 并新增 `tests/social-feedback-dossier.test.mjs` | `build` / `test` 40 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-18 | `0.1.0-alpha.10` | 同步状态栏共享件注释与单测描述，移除无关第三方引用词 | `build` / `test` 38 通过 2 跳过 / `check` 全绿；已推仓 |
| 2026-11-18 | `0.1.0-alpha.9` | 同步状态栏后台 AI 请求净化与外挂世界书隔离共享件（默认仅放行 `primary` 主世界书、屏蔽 `globalLore`/`additional`/`chatLore`、剔除 `role:assistant`、启用内置正文向核心词根过滤并出站剥离第三方扩展注入，保留 `[UBS手机]` 窥私/消息记录 `keep` 豁免）；`phone-raw.ts` `phoneFullSlots()` 移除 `'chat_history'`；`chat-images.ts` 与 `shop-images.ts` 4 处补齐 `max_chat_history: 0`；扩展 `tests/ai-tool-shield.test.mjs` | `build` / `test` 38 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.8` | 同步状态栏 `api-config.ts` 修复：`fetchModelList` 在 `source === 'makersuite'` 时优先直连 `/v1beta/models` 并仅以 `/v1` 回退宿主 `getModelList`，避免裸根地址撞管理页 HTML | `build` / `test` 37 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.7` | `phone-api.ts` 的 `presetToApi` 对齐主项目 `api-config.ts`：透传非 `openai` 的 `source`（`openai` 不显式写）、`top_p` 越界归 `'unset'`、按 `promptPostProcessing` 在 `custom_api` 上登记出站策略（缺失回退 `semi`）；新增 `tests/ai-tool-shield.test.mjs` 锁定上述行为与「`phoneFullSlots()` 含尾部破限 + `semi` 规整后首条对话消息之后无 `system`/`developer`」 | `build` / `test` 37 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.6` | 内嵌 `env.ts` 的 `getToastr()` 统一为小手机全部 toast（含 `phoneNotify` 及内嵌报错）自动加「小手机」前缀；`phone-ui.ts` 统一短名；扩展 `tests/toast-ui.test.mjs` | `build` / `test` 35 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.5` | 小手机屏内 `.ubp-toast` 改为半透明磨砂（`0.52` + `blur(8px)`）与紧凑字号间距；`ai-activity-notify.ts` 新增关闭钮安全缓冲带防误触与单开半透明/大 `×` 兜底样式；新增 `tests/toast-ui.test.mjs` | `build` / `test` 34 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-17 | `0.1.0-alpha.4` | 同步 `contextKeepTags` 与剥离标签优先级保护；全引擎改用 `readStrippedAiChatHistory` 逐楼独立清洗；`story-link.ts` 提取前剔除思考与非正文块；`chat-parser.ts` `stripThinkingBlocks` 改为栈式清除且绝不误切 `<ubp_*>` 内 `</think>`；新增 `tests/context-strip.test.mjs` | `build` / `test` 32 通过 2 跳过 / `check` 全绿；已推仓待 TT 拉取真机验收 |
| 2026-11-15 | `0.1.0-alpha.3` | 同步升级内嵌 `context-strip.ts` 为单遍栈式配对剥离防止误吞正文，并重写本仓 `README.md`（契约索引、改造进展与维护记录铁律） | `build` / `test` 23 通过 2 跳过 / `check` 全绿 |
| 2026-11-13 | `0.1.0-alpha.2` (`ff44500`) | 解耦桌面端缩放并修复电脑端尺寸及窗口 resize 悬浮球越界 | `build` / `test` / `check` 通过 |
| 2026-11-07 | `table-v1` (`c8ba542` / `39fae22`) | 适配台账工作台数据编辑与字段影响保护；修正经历语义与字段诊断取数 | 当轮测试与构建通过 |
