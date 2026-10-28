# 接口核对与待验边界

核对日期：2026-10-28。未捕获目标用户酒馆的版本或能力快照。

| 来源 | 固定版本/提交 | 本次用途 |
| --- | --- | --- |
| SillyTavern 扩展加载器 | [06bde939](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js) | 核对 manifest 入口与加载顺序 |
| 酒馆助手公开函数出口 | [0af42106](https://github.com/N0VI028/JS-Slash-Runner/blob/0af421068e7c03b6b0a71b68feb79d201164edeb/src/function/index.ts) | 核对全局函数名称；该提交 manifest 为 4.11.3 |
| 酒馆扩展安装说明 | [官方说明](https://docs.sillytavern.app/extensions/) | Git 仓库安装入口 |

宿主 getContext / CHAT_CHANGED、jQuery、toastr 与酒馆助手的 generateRaw、injectPrompts、getWorldbook、replaceWorldbook、getCharWorldbookNames、getWorldbookNames 在启动前做能力检查。这里只核对符号可用，原业务代码的参数结构和事件时序仍需目标宿主真机验证。生图、语音、第三方数据库等可选集成没有因此获得验证。

世界书、聊天和服务 API 的所有原行为继续来自 src/；本次不修改原数据模型、不迁移已有存档。台账与另一套独立数据库同时启用的优先级尚未验证，台账入口对此组合先行阻止。

TavernWeave 制作检查路由：sillytavern-extension-dev；文档 ST-A0、ST-D5、ST-E5；库快照 2026-08-18。没有采用视觉目录条目。
