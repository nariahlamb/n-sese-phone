// ===== 瑟瑟小手机 · 版本与构建锚点 =====
// PHONE_VERSION = 分发版本号（单一事实源）：设置→关于 的显示与 scripts/build-phone.cjs
// 的可导入 JSON 命名均以此为准。每次打包自动 +0.001（build-phone.cjs --bump 在 webpack
// 前改写本文件，并扫 reference JSON 取最大版本做下限防回退；关于页/产物头/JSON 名三处同版）。
// 里程碑大版本仍可手动定版（直接改此值，下次打包自增继续）；功能变更用 BUILD_TAG 区分。
export const PHONE_VERSION = 'V1.308';

// 构建锚点字符串：两级产物（dist/UBS_phone/index.html 与 dist/瑟瑟小手机.js）
// grep 验证用。每次功能性变更时更新此字面量。
// （本批：lock-notify-deeplink＝锁屏通知卡点按直达 App 对应页（会话/帖子/私信/直播/订单）；
//   锁屏与通知中心共用同一份 target 深链；不新增存储、不新增已读状态；社交深链顺带只清该帖未读。
//   上一批 atmo-focus＝群聊气氛组资料与焦点（docs/72）；更早批次看 git log 与 docs/62、65、69）
export const PHONE_BUILD_TAG = 'ubp-lock-notify-deeplink-20261024';
