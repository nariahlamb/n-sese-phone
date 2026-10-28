// ===== 小手机全量 CSS（Shadow Root 内注入） =====
// 自有 --ubp-* token，亮/暗双主题（.ubp-dark 挂 shadow 根容器）。
// 纪律：不使用主项目 --ub-* token；纯色+细渐变仅限机身材质（机身不受纯色契约约束，
// 屏幕内 UI 遵循主项目"纯色禁渐变"精神——功能面全部纯色）。

const PHONE_CSS_RAW = `
.ubp-scope, .ubp-scope * { box-sizing: border-box; margin: 0; padding: 0; }
.ubp-scope {
  --ubp-bg: #F2F3F5;
  --ubp-card: #FFFFFF;
  --ubp-card-2: #F7F8FA;
  --ubp-card-3: #F0F1F4;
  --ubp-text: #191919;
  --ubp-text-2: #7F7F7F;
  --ubp-text-3: #A8A8A8;
  --ubp-line: rgba(0, 0, 0, 0.08);
  --ubp-accent: #07C160;
  --ubp-accent-press: #06AD56;
  --ubp-accent-soft: rgba(7, 193, 96, 0.12);
  --ubp-danger: #E64340;
  --ubp-danger-soft: rgba(230, 67, 64, 0.1);
  /* 危险态描边（余额卡超发变体等）：与 --ubp-warn-line 同规格 */
  --ubp-danger-line: rgba(230, 67, 64, 0.42);
  /* 警示（非错误）：主项目未就绪告警条等提示态 */
  --ubp-warn: #8A5300;
  --ubp-warn-soft: rgba(255, 176, 32, 0.14);
  --ubp-warn-line: rgba(255, 176, 32, 0.42);
  --ubp-chat-bg: #EDEDED;
  --ubp-bubble-me: #95EC69;
  --ubp-bubble-me-text: #191919;
  --ubp-bubble-other: #FFFFFF;
  --ubp-badge: #FA5151;
  --ubp-link: #576B95;
  /* 公告层（时间分割线 / 系统消息）：真机微信恒为深色半透明胶囊——独立于气泡体系，
     不随亮暗主题与聊天背景变化，保证任何壁纸下都读得清。皮肤可整组覆盖这两个 token。 */
  --ubp-notice-bg: rgba(0, 0, 0, 0.24);
  --ubp-notice-text: rgba(255, 255, 255, 0.92);
  /* 电话 App 功能绿（iOS 呼叫绿，与桌面图标同源） */
  --cl-acc: #34C759;
  --ubp-overlay: rgba(0, 0, 0, 0.45);
  --ubp-frame: #101013;
  --ubp-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  /* Dock（SH-01 分层后的托盘）：原 rgba(255,255,255,.26) 压在 --ubp-bg 上几乎无色，托盘与桌面糊成一片。
     抬到 .62 并补发丝描边 + 轻投影，让托盘重新有边界与厚度（壁纸态在下方单独覆盖）。 */
  --ubp-dock-bg: rgba(255, 255, 255, 0.62);
  --ubp-dock-line: rgba(0, 0, 0, 0.05);
  --ubp-dock-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
  /* 玻璃卡（日程提醒横幅）：与 .ubp-dock 同源配方——半透明底 + backdrop blur + 发丝描边，
     但**密度更高**：托盘里只放彩色磁贴，卡里放的是 12–15px 正文，0.62 的白压不住文字。
     壁纸桌面**不换档**（返修⑥）：面板只按主题取配色，照片上同样走亮玻璃 + 深字（压任意照片合成
     亮度 ≥178、主文字 11:1，见下方 --ubp-glass-bg 那一节）。
     通知中心面板（.ubp-nc）复用同一组 glass-bg/line/text：它同样是「压在内容/壁纸上的文字面」，
     只是尺寸更大——同款配方才叫风格统一（见 --ubp-glass-tile：面板内的组卡另有一档）。
     2026-10-03 返修③（用户：在 App 内控制中心/通知中心失去玻璃效果）：0.80 的白**两层叠起来就等于实底**
     ——面板 0.80 + 冰砖 0.92 合成 98.4% 白，App 内容无论怎么模糊都透不出来，只剩一块白板。
     实测证据：.mockup/probe-glass（左半纯红 / 右半纯绿的 App 背景）改造前面板里只读得出 20% 的色偏，
     而 App 大面积浅色时人眼就读成「没有玻璃」；面板与背板同亮度时也没有任何「浮起来」的迹象。
     降到 0.70 后：面板自己会**跟着背板明暗走**（这才是玻璃的物理表意），最坏情况（纯黑背板）
     面板合成亮度仍 ≈178、卡面 ≈204 —— 主文字（--ubp-glass-text = 深字）对比 ≈11:1，
     次要文字维持原档 #6E6E6E 也有 ≈3.1:1（与真机深色 App 上通知中心的次要灰同一量级）。 */
  --ubp-glass-bg: rgba(255, 255, 255, 0.70);
  --ubp-glass-line: rgba(0, 0, 0, 0.06);
  /* 面板内的「冰砖」（组卡/待办岛/行）：比面板亮一档 ⇒ 在毛玻璃上读作凸起的一层。
     顺带解决「堆在一起」：旧版面板 #FFF 与组卡 #F7F8FA 只差 4.5% 亮度，组缝看不见。
     2026-10-03 返修③：0.92 的砖压下去 App 内容同样透不出来（合成 98.4% 白）⇒ 降到 0.34：
     砖与面板合成 80% 白 / 20% 背板，砖仍是「亮一档的一层」（另有发丝描边表意），但它自己也是玻璃。 */
  --ubp-glass-tile: rgba(255, 255, 255, 0.34);
  --ubp-glass-tile-line: rgba(0, 0, 0, 0.05);
  /* 不透明兜底：两个用途——宿主不支持 backdrop-filter，以及拖拽跟手期间（模糊区每帧重采样会掉帧） */
  --ubp-glass-solid: rgba(255, 255, 255, 0.96);
  /* inset 那道高光是玻璃的表意（上缘一亮 = 有厚度的薄片），三态共用 */
  --ubp-glass-shadow: 0 14px 32px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.45);
  /* 2026-10-03 返修③：面板自身的「上缘光纱」（.ubp-nc/.ubp-cc 的 background-image 首段）。
     背板是**纯色**时模糊留不下任何信息（浅色 App 就等于一块白底），此时玻璃只能靠自身的光学表意读出来；
     浅色主题 0.30；深色/壁纸（深玻璃）在各自块里压到 0.12 —— 深玻璃再打 0.30 的白会发灰发雾。 */
  --ubp-glass-sheen: rgba(255, 255, 255, 0.30);
  --ubp-glass-text: var(--ubp-text);
  /* 玻璃面上的次要文字要比 --ubp-text-2 深一档：探针实测面板玻璃合成色 ≈ rgb(235,240,238)，
     #7F7F7F 压上去只有 3.54:1（不透明白底时是 4.01:1）——玻璃化不该以掉对比度为代价。
     #6E6E6E 在实测合成色上是 4.13:1，在冰砖（≈#FEFEFE）上是 4.6:1，两处都比改造前略好。 */
  --ubp-glass-text-2: #6E6E6E;
  --ubp-glass-text-3: var(--ubp-text-3);
  /* Dock「更多」磁贴：原写死 --ubp-card-2（不透明近白）+ --ubp-text-2，忽略亮/暗/壁纸三态——
     亮色无壁纸时与托盘亮度差 0.4%（彻底隐形），壁纸态则成刺眼白块、加号 3.8:1 发虚。
     只借主题既有的 card/text 两枚 token、**不设壁纸特例** ⇒ 号色恒定（亮 17.6:1 / 暗 11.6:1）。 */
  --ubp-more-fill: var(--ubp-card);
  --ubp-more-line: rgba(0, 0, 0, 0.08);
  --ubp-more-ico: var(--ubp-text);
  --ubp-more-shadow: 0 1px 3px rgba(0, 0, 0, 0.14), 0 0 0 0.5px rgba(0, 0, 0, 0.05);
  /* 美化工坊布局变量（皮肤 icons/home 段写入；默认值=现状尺寸——皮肤未设置时逐像素零差异）。
     消费点：.ubp-appgrid（列数/行距）、.ubp-appicon（尺寸）、.ubp-dock .ubp-appicon（底栏尺寸）、
     .ubp-home-scrim（蒙层）、.ubp-home-bg .ubp-crop-media（模糊）、.ubp-skin-glyph（字形随图标缩放）。 */
  --ubp-icon-size: 54px;
  --ubp-grid-cols: 4;
  --ubp-grid-rowgap: 14px;
  --ubp-dock-icon: 50px;
  --ubp-wp-scrim: 0.42;
  --ubp-wp-blur: 0px;
  --ubp-font: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
  /* 字号 token（VI-01 / 附录 B）：全机只留 7 档。所有 px 字号在模块加载时被就近归并成本变量
     （见文件末尾 PHONE_CSS 变换），乘法仍走 --ubp-font-scale → 设置里的字体缩放在 token 内生效。 */
  --fs-10: calc(10px * var(--ubp-font-scale, 1));
  --fs-11: calc(11px * var(--ubp-font-scale, 1));
  --fs-13: calc(13px * var(--ubp-font-scale, 1));
  --fs-15: calc(15px * var(--ubp-font-scale, 1));
  --fs-17: calc(17px * var(--ubp-font-scale, 1));
  --fs-22: calc(22px * var(--ubp-font-scale, 1));
  --fs-28: calc(28px * var(--ubp-font-scale, 1));
  font-family: var(--ubp-font);
  color: var(--ubp-text);
  /* 显式基础字号：Shadow Root 会继承酒馆页面字号（UI 缩放后可达 20px+），
     未写死字号的文字（如独立使用的 .ubp-fieldhint）统一按 13px 兜底 */
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
.ubp-scope.ubp-dark {
  --ubp-bg: #111111;
  --ubp-card: #1D1D1F;
  --ubp-card-2: #242426;
  --ubp-card-3: #2C2C2F;
  --ubp-text: #D6D6D6;
  --ubp-text-2: #8E8E93;
  --ubp-text-3: #6C6C70;
  --ubp-line: rgba(255, 255, 255, 0.1);
  --ubp-accent: #34C77B;
  --ubp-accent-press: #2BB36D;
  --ubp-accent-soft: rgba(52, 199, 123, 0.16);
  --ubp-bubble-me: #2F6B45;
  --ubp-chat-bg: #0E0E10;
  --ubp-bubble-me-text: #E8F7E4;
  --ubp-bubble-other: #1F1F21;
  --ubp-link: #7E9BC4;
  --cl-acc: #30D158;
  --ubp-overlay: rgba(0, 0, 0, 0.6);
  --ubp-warn: #FFCF87;
  --ubp-warn-soft: rgba(255, 176, 32, 0.12);
  --ubp-warn-line: rgba(255, 176, 32, 0.36);
  /* 暗色不重定义 --ubp-danger / --ubp-danger-soft（沿用亮色那对，既有各处的口径），
     只补描边色，并把暗底上的可读性抬一档 */
  --ubp-danger-line: rgba(230, 67, 64, 0.5);
  /* Dock：暗色原 .26 白压在 #111 上 = #4F4F50，托盘是一整块发灰的亮板；压到 .10 才沉得下去 */
  --ubp-dock-bg: rgba(255, 255, 255, 0.10);
  --ubp-dock-line: rgba(255, 255, 255, 0.10);
  --ubp-dock-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  /* 玻璃卡（暗色）：白 0.10 的托盘配方只托得住磁贴；正文卡用近实底深色 + 高模糊，
     文字对比度才稳（--ubp-glass-text 两枚指回 --ubp-text / --ubp-text-2，此处不必重列）。 */
  --ubp-glass-bg: rgba(30, 30, 32, 0.74);
  --ubp-glass-line: rgba(255, 255, 255, 0.12);
  --ubp-glass-tile: rgba(255, 255, 255, 0.07);
  --ubp-glass-tile-line: rgba(255, 255, 255, 0.08);
  --ubp-glass-solid: rgba(30, 30, 32, 0.96);
  --ubp-glass-shadow: 0 14px 32px rgba(0, 0, 0, 0.46), 0 2px 6px rgba(0, 0, 0, 0.20), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  /* 深玻璃的上缘光纱只留一点点（同 --ubp-glass-shadow 里那道 inset 的量级）：0.30 会把暗面板打灰 */
  --ubp-glass-sheen: rgba(255, 255, 255, 0.12);
  /* 「更多」磁贴的底色/号色不在此重复：它们指向 --ubp-card / --ubp-text，本块已把这两枚改成暗色值 */
  --ubp-more-line: rgba(255, 255, 255, 0.14);
  --ubp-more-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 0 0.5px rgba(255, 255, 255, 0.06);
}
.ubp-scope ::-webkit-scrollbar { width: 4px; height: 4px; }
.ubp-scope ::-webkit-scrollbar-thumb { background: var(--ubp-line); border-radius: 2px; }

/* ── 悬浮球 ── */
.ubp-ball {
  /* 默认停靠画面左侧垂直居中（避开右下角一众插件悬浮按钮的重叠区）；
     禁用 transform 垂直居中——与 :active scale 和摇铃动画的 transform 互相覆盖，改用 calc 偏移（球高 46px，上移 23px） */
  position: fixed; left: 8px; top: calc(50% - 23px); width: 46px; height: 46px; border-radius: 50%;
  background: var(--ubp-frame); color: #CFF5E0;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255,255,255,0.08);
  cursor: pointer; pointer-events: auto; user-select: none; touch-action: none;
  /* 悬浮球必须压过手机本体（.ubp-phone z-index:3），否则手机打开时球被遮挡 */
  z-index: 4; transition: transform 0.15s ease;
}
.ubp-ball:active { transform: scale(0.92); }
.ubp-ball svg { width: 22px; height: 22px; }
/* 来电摇铃（世界演化联动：电话 App 派发 call-ring 事件） */
.ubp-ball.ubp-ring { animation: ubp-ball-ring 1s ease-in-out infinite; }
@keyframes ubp-ball-ring {
  0%, 100% { transform: rotate(0deg); }
  20% { transform: rotate(-14deg); }
  45% { transform: rotate(12deg); }
  70% { transform: rotate(-8deg); }
}
.ubp-ball .ubp-ball-dot {
  position: absolute; top: -2px; right: -2px; min-width: 16px; height: 16px;
  border-radius: 8px; background: var(--ubp-badge); color: #fff;
  font-size: 10px; line-height: 16px; text-align: center; padding: 0 4px;
  display: none;
}
.ubp-ball .ubp-ball-dot.on { display: block; }
/* 对局「轮到我操作」游戏胶囊（仅折叠态出现；右下角与未读数字点错位；狼紫/卧底琥珀） */
.ubp-ball .ubp-ball-game {
  position: absolute; bottom: -3px; right: -3px; min-width: 16px; height: 16px;
  border-radius: 9px; background: #8B5CF6; color: #fff;
  font-size: 9px; line-height: 16px; text-align: center; padding: 0 3px;
  border: 1.5px solid var(--ubp-frame);
  display: none;
}
.ubp-ball .ubp-ball-game.undercover { background: #E8890C; }
.ubp-ball .ubp-ball-game.soup { background: #14B8A6; }
.ubp-ball .ubp-ball-game.on { display: block; animation: ubp-ball-game-pulse 1.6s ease-in-out infinite; }
@keyframes ubp-ball-game-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.18); }
}

/* ── 手机壳 ── */
.ubp-phone {
  position: fixed; display: none; flex-direction: column;
  width: min(375px, 94vw); height: min(720px, calc(100dvh - 72px));
  /* 整机缩放（设置→通用「手机缩放」）：--ubp-zoom 仅 ≠1 时由 applyChrome 挂 .ubp-scope 行内；
     原点左上=已存拖放位置（left/top）坐标语义不变；rect 含缩放后尺寸，拖拽/视口钳制自动兼容 */
  transform: scale(var(--ubp-zoom, 1)); transform-origin: top left;
  background: var(--ubp-frame); border-radius: 46px; padding: 10px;
  box-shadow: var(--ubp-shadow), inset 0 0 0 2px rgba(255,255,255,0.05);
  z-index: 3; pointer-events: auto; user-select: none;
}
.ubp-phone.ubp-open { display: flex; }
.ubp-screen {
  /* homebar 高度（含安全区）单一事实源：.ubp-homebar 的 height 与 .ubp-homelayer 的 bottom 同用它，
     两处必须同式才不会让「桌面层」与「App 层」错位（第六轮 ⑧）。 */
  --ubp-homebar-h: calc(22px + env(safe-area-inset-bottom, 0px));
  flex: 1; min-height: 0; border-radius: 37px; overflow: hidden;
  background: var(--ubp-bg); display: flex; flex-direction: column; position: relative;
  user-select: text;
}
/* ── 桌面层：与 .ubp-app 同区重叠的**常驻**层，专门承载 .ubp-home ──
   桌面与 App 是两层（不是同一容器里换内容）：App 打开时把这一层的可见性摘掉、关闭时接回来即可，
   返回桌面时滚动位置与 DOM 都还在，不需要重建。用 visibility 而非 display：保住布局与滚动位置，
   也让透明区域露出 .ubp-screen 底色。
   区域 = 状态栏下沿 → homebar 上沿，与 .ubp-app 完全同框（同用 --ubp-homebar-h）。 */
.ubp-homelayer {
  position: absolute; left: 0; right: 0; top: 38px; bottom: var(--ubp-homebar-h);
  display: flex; flex-direction: column;
}
.ubp-homelayer.ubp-homelayer-hidden { visibility: hidden; }
.ubp-statusbar {
  height: 38px; flex: none; display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px; font-size: 12.5px; font-weight: 600; position: relative; z-index: 5;
  /* 状态栏即 App 内下拉把手（2026-10-02，与 .ubp-home-top 同款纪律）：.ubp-screen 的 user-select:text
     会被继承，移动端在时刻/图标上按住拖动会被浏览器接管为滚动或文字选择手势并派发 pointercancel；
     状态栏本身不承载滚动与可点内容，清掉这两项不改变任何既有交互。 */
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.ubp-notch {
  position: absolute; left: 50%; top: 9px; transform: translateX(-50%);
  width: 92px; height: 22px; border-radius: 12px; background: var(--ubp-frame);
  cursor: grab; touch-action: none;
  /* 拖拽把手必须退出文本选择/系统手势体系（V1.043 真机拖不动根因修复，同 .ubp-island） */
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.ubp-sb-icons { display: flex; align-items: center; gap: 5px; color: var(--ubp-text); }
.ubp-sb-icons svg { width: 15px; height: 15px; }
/* 状态栏时间=故事时间快照（自由文本），限宽防撞刘海 */
.ubp-sb-time {
  max-width: 116px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 桌面态隐去状态栏时刻：桌面顶部自带大时钟（.ubp-home-time），同屏两处显示同一故事时间＝重复。
   由 JS 切类（.ubp-at-home）表达——桌面层是**常驻**层，:has(.ubp-home) 会恒为真，故必须显式给态。
   用 opacity 而非 display:none：时刻仍占着左侧槽位 ⇒ 图标簇恒在右端不动（不切 justify-content）。 */
.ubp-screen.ubp-at-home .ubp-sb-time { opacity: 0; }
/* 灵动岛对局胶囊：对局后台进行时覆盖刘海位（深色自包含配色，明暗主题/皮肤通用）——
   显示当前进展、游戏分色（狼紫/卧底琥珀）、轮到我时绿点呼吸；按住拖动=拖手机、点击=回对局。
   max-width 两侧各留 75px（左时间/右图标簇），文案自适应撑开胶囊完整展示 */
.ubp-island {
  position: absolute; left: 50%; top: 8px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 5px;
  min-width: 118px; max-width: calc(100% - 150px); height: 24px;
  padding: 0 12px; border: none; border-radius: 13px;
  background: rgba(10, 12, 18, 0.92); color: #fff;
  font-size: 11px; font-weight: 600; cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  z-index: 6; touch-action: none; overflow: hidden;
  /* V1.043 真机「胶囊盖住刘海后手机拖不动」根因修复：.ubp-screen 的 user-select:text 被本元素
     继承，移动端在可选中文本上按住拖动会被浏览器接管为文字选择手势并派发 pointercancel
     （bindDrag 当场中断），长按还会弹系统 callout；空刘海无文字故不触发——这就是
     「只有在胶囊隐藏的对局视图里才拖得动」的原因。把手元素必须彻底 user-select:none。 */
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
/* 作者 display 会压过 UA 的 [hidden]，必须显式兜底（V0.188 教训） */
.ubp-island[hidden] { display: none; }
.ubp-island::before {
  content: ''; flex: none; width: 6px; height: 6px; border-radius: 3px; background: #B470FF;
}
.ubp-island.undercover::before { background: #FFB454; }
.ubp-island.soup::before { background: #2DD4BF; }
.ubp-island.turn { box-shadow: 0 0 0 1.5px rgba(46, 213, 115, 0.55), 0 2px 10px rgba(0, 0, 0, 0.35); }
.ubp-island.turn::before { background: #2ED573; animation: ubp-island-breathe 1.4s ease-in-out infinite; }
/* ── 实时活动分色（第五轮 ①）：通话=绿、AI 生成=微信绿；呼吸点表示「正在进行」（对局「轮到我」同款纪律）。 ── */
.ubp-island.call::before { background: #34C759; animation: ubp-island-breathe 1.8s ease-in-out infinite; }
.ubp-island.gen::before { background: #2DC100; animation: ubp-island-breathe 1.6s ease-in-out infinite; }
/* 商城上货（docs/52 §7.1）：电商橙——与微信绿区分开，一眼看出是「掌柜在备货」 */
.ubp-island.shop::before { background: #FF6A00; animation: ubp-island-breathe 1.6s ease-in-out infinite; }
/* 商城首页品牌行（用户定案：去左上返回钮，图标做成微博式 LOGO 放左上，顶栏结构与其它 App 统一） */
.ubp-shp-brandbar { gap: 8px; }
.ubp-shp-logo {
  width: 30px; height: 30px; flex: none; border-radius: 9px;
  display: inline-flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(145deg, var(--shp-acc, #FF6A00), color-mix(in srgb, var(--shp-acc, #FF6A00) 72%, #000));
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.18);
}
.ubp-shp-logo svg { width: 17px; height: 17px; }
.ubp-shp-brand { flex: 1; min-width: 0; font-size: 17px; font-weight: 800; letter-spacing: 1.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 被吸入的通知（第五轮 ③）：红点表示「刚收进来一条」+ 右上角未读小点 */
.ubp-island.notif::before { background: #FF453A; }
.ubp-island-unread { position: absolute; top: 3px; right: 9px; width: 6px; height: 6px; border-radius: 3px;
  background: #FF453A; box-shadow: 0 0 0 1.5px rgba(10, 12, 18, 0.92); }
/* 胶囊尾随：通话计时（等宽数字，跳动时不抖宽）/ AI 输入三点（比聊天气泡里的点小一号） */
.ubp-island-timer { flex: none; padding-left: 3px; font-size: 11px; font-weight: 600;
  font-variant-numeric: tabular-nums; opacity: 0.88; letter-spacing: 0.2px; }
.ubp-island-dots { flex: none; display: flex; gap: 3px; padding-left: 3px; }
.ubp-island-dots i { width: 4px; height: 4px; border-radius: 2px; background: currentColor; opacity: 0.5;
  animation: ubp-dot 1.2s ease-in-out infinite; }
.ubp-island-dots i:nth-child(2) { animation-delay: 0.15s; }
.ubp-island-dots i:nth-child(3) { animation-delay: 0.3s; }
/* ── 灵动岛展开卡（第五轮 ②）：点按胶囊展开，活动详情 + 主动作。
   深色自包含配色（同 .ubp-island）——明暗主题/皮肤/壁纸通用，不引任何主题 token。 ── */
.ubp-island-card { position: absolute; left: 50%; top: 6px; transform: translateX(-50%);
  width: 258px; padding: 11px 13px 12px; border-radius: 21px;
  background: rgba(10, 12, 18, 0.94); color: #fff;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  z-index: 8; display: flex; flex-direction: column; gap: 9px; overflow: hidden;
  animation: ubp-island-card-in 0.32s cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes ubp-island-card-in {
  0% { transform: translateX(-50%) scale(0.42); opacity: 0; border-radius: 13px; }
  100% { transform: translateX(-50%) scale(1); opacity: 1; border-radius: 21px; }
}
.ubp-ic-hd { display: flex; align-items: center; gap: 9px; }
.ubp-ic-badge { flex: none; width: 26px; height: 26px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: #fff; }
.ubp-ic-badge svg { width: 15px; height: 15px; }
.ubp-ic-tx { flex: 1; min-width: 0; }
.ubp-ic-name { display: block; font-size: 12.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-ic-sub { display: block; font-size: 11px; opacity: 0.62; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-ic-timer { flex: none; font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; opacity: 0.9; }
.ubp-ic-acts { display: flex; gap: 8px; }
.ubp-ic-btn { flex: 1; height: 32px; border: none; border-radius: 16px; cursor: pointer;
  font-family: var(--ubp-font); font-size: 12.5px; font-weight: 600; color: #fff; background: rgba(255, 255, 255, 0.14); }
.ubp-ic-btn.danger { background: #FF453A; }
.ubp-ic-btn.go { background: #34C759; }
.ubp-ic-btn:active { filter: brightness(0.94); }
/* ── 文字 AI 活动：灵动岛分色 + 卡内多请求列表 + 收起浮球角标/呼吸 ── */
.ubp-island.ai::before { background: #12B5CB; animation: ubp-island-breathe 1.6s ease-in-out infinite; }
.ubp-island.ai.wechat::before { background: #2DC100; }
.ubp-island.ai.shop::before { background: #FF6A00; }
.ubp-island.ai .ubp-island-ico { font-size: 9.5px; font-weight: 800; letter-spacing: 0.02em; }
.ubp-ai-list { display: flex; flex-direction: column; gap: 1px; max-height: 132px; overflow-y: auto; }
.ubp-ai-row { display: flex; align-items: center; gap: 8px; padding: 5px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08); font-size: 11.5px; }
.ubp-ai-row:last-child { border-bottom: 0; }
.ubp-ai-row b { flex: none; font-weight: 700; }
.ubp-ai-row .sub { flex: 1; min-width: 0; opacity: 0.62; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-ai-row button { flex: none; border: 0; border-radius: 9px; padding: 3px 9px; font-size: 10.5px;
  color: #fff; background: #FF453A; font-family: inherit; cursor: pointer; }
.ubp-ai-row.done { opacity: 0.55; }
.ubp-ball .ubp-ball-ai {
  position: absolute; top: -2px; left: -2px; min-width: 16px; height: 16px;
  border-radius: 8px; background: #12B5CB; color: #fff;
  font-size: 9px; font-weight: 700; line-height: 16px; text-align: center; padding: 0 3px;
  border: 1.5px solid var(--ubp-frame); display: none;
}
.ubp-ball .ubp-ball-ai.on { display: block; animation: ubp-ball-game-pulse 1.6s ease-in-out infinite; }
.ubp-ball.ubp-ball-ai-on::after {
  content: ''; position: absolute; inset: -4px; border-radius: 50%; pointer-events: none;
  border: 2px solid rgba(18, 181, 203, 0.55);
  animation: ubp-ball-ai-ring 1.8s ease-in-out infinite;
}
@keyframes ubp-ball-ai-ring {
  0%, 100% { transform: scale(0.94); opacity: 0.25; }
  50% { transform: scale(1.08); opacity: 0.7; }
}
@media (prefers-reduced-motion: reduce) {
  .ubp-island.ai::before, .ubp-ball .ubp-ball-ai.on, .ubp-ball.ubp-ball-ai-on::after { animation: none !important; }
}
@keyframes ubp-island-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
/* 出现时从刘海弹性绽放（display:none→flex 自动重放；末帧=基态，结束无跳变） */
.ubp-island:not([hidden]) { animation: ubp-island-in 0.5s cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes ubp-island-in {
  0% { transform: translateX(-50%) scale(0.5); opacity: 0; }
  62% { transform: translateX(-50%) scale(1.09); opacity: 1; }
  100% { transform: translateX(-50%) scale(1); }
}
.ubp-island-ico { flex: none; font-size: 12px; line-height: 1; }
/* 胶囊图标尺寸（第五轮修复的既有缺陷）：.ubp-island-ico 只给了 font-size，而内联 <svg> 只有 viewBox、
   没有 width/height 时按 100% 解析、父级又是内容自适应 ⇒ 实测塌成 0×0，图标从未显示过
   （对局胶囊一直只有分色圆点 + 文字）。补上尺寸规则，岛内所有活动图标才看得见。 */
.ubp-island-ico svg { width: 13px; height: 13px; }
.ubp-island-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
/* isolation: isolate = **把整个 App 内容关进它自己的层叠上下文**（2026-10-03 用户报「锁屏前在微博界面，
   锁屏后下面露出微博内容」的根因修复）。
   根因：屏级浮层（锁屏 12 / 系统面板 13 / 横幅 11 / 全局搜索 12）的注释一直按「App 内容是一层」
   排层级，但 .ubp-app 只有 position: relative（z-index auto）＝**不构成层叠上下文**，于是 App 内
   自己的 z-index 直接跳进 .ubp-phone 的上下文里跟屏级浮层比大小——.ubp-sfoot(50)、App 内各类
   弹层(52/60/65/66/90) 全部大过 12/13 ⇒ 锁屏与通知中心/控制中心都被微博底栏、App 内弹层压住：
   锁屏底部露出微博 Tab 栏；面板遮罩压暗全屏，唯独底栏不被压暗。
   **必须是 isolation 而不是 z-index:1**：桌面层 .ubp-homelayer 与 .ubp-app 同区重叠，桌面内容靠
   「.ubp-home > * 提 z-index:1」（见下方桌面段）压在空的 App 层之上；这里若写 z-index:1，两层同档
   而 .ubp-app 在 DOM 里靠后 ⇒ 空 App 层反过来盖住桌面图标（命中测试实拍：点图标命中 .ubp-app，
   桌面整个点不动——这是本修复第一版的缺陷，靠 .mockup/gen-homelayer.cjs 的命中测试抓回来的）。
   isolation 只建层叠上下文、**不改本层自身的层级**（仍留在 z-index auto 那一档），上述关系逐条不变；
   关进去之后 App 内的 z-index 只在 App 内互比，对屏级浮层只以「一层」参与，MEMORY §五.37 的
   「面板 13 > 全局搜索 12 > 横幅 11 > App 内容」才真的成立。App 层不覆盖状态栏/homebar/灵动岛
   （它们各自的盒不与之重叠，且 z 5/5/6 本就更高），横幅(11)/锁屏(12)/面板(13)/Toast(95) 依旧压得住。 */
.ubp-app { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; isolation: isolate; }

/* App 开关**不做转场动画**（2026-10-03 用户定调：「过度动画做的一堆问题，直接 APP 打开关闭的
   动效动画代码全部删除，回归原始的打开方式」）。故此处没有任何 .ubp-app / .ubp-homelayer 的
   入场动画：点开即显示、按 home 条即回桌面；桌面层由 setHomeLoaded 的可见性切换同步摘/接
   （见 renderers/phone-ui.ts 的 openApp / closeAppToHome）。第六轮 ⑧ 那套「从图标放大铺满」
   及其起点几何、内容淡入、桌面退避/收回、两条边的交板已全部删除，一条不留。 */
/* SH-04：主项目未就绪的常驻横幅退役（工程语言 + 每屏都占一条）→
   ①桌面「设置」图标右上角小角标（根类驱动，零 JS 生命周期）②设置页状态卡（见 .ubp-hostcard） */
.ubp-scope.ubp-host-notready .ubp-appnode[data-ubp-app="settings"] .ubp-appicon::after {
  content: '!'; position: absolute; top: -4px; right: -4px;
  min-width: 17px; height: 17px; border-radius: 9px; padding: 0 4px;
  background: var(--ubp-warn); color: #fff;
  font-size: 10px; line-height: 17px; text-align: center; font-weight: 600;
}
.ubp-hostcard {
  display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 9px 12px;
  border-radius: 11px; border: 1px solid var(--ubp-warn-line); background: var(--ubp-warn-soft);
  color: var(--ubp-warn); font-size: 13px; line-height: 1.5;
}
.ubp-hostcard .ubp-hostcard-main { flex: 1; min-width: 0; }
.ubp-hostcard .ubp-btn { flex: none; height: 30px; padding: 0 12px; }
/* 安全区：全屏模式下 homebar 不与系统手势条重叠 */
.ubp-homebar { height: var(--ubp-homebar-h); padding-bottom: env(safe-area-inset-bottom, 0px); flex: none; display: flex; align-items: center; justify-content: center; cursor: pointer;
 }
.ubp-homebar-pill { width: 110px; height: 5px; border-radius: 3px; background: var(--ubp-text-3); opacity: 0.6; }

@media (max-width: 480px) {
  /* 窄屏全屏模式：手机=整屏（去机身圆角与内边距），缩放无意义且会溢出视口，强制失效。
     2026-10-04 还原（用户实测反馈：移动端本应贴边全屏，现在没有全屏了）：V1.129 曾把本条改成
     「保留机身」，当时误把「主界面变长/边框没了」归因到这条规则；真正的主因是 .ubp-screen 的状态类
     撞名 ubp-home-bg（已独立修复并加回归守卫），与本条互不依赖，故本条恢复原状。 */
  /* 软键盘避让（--ubp-kb-h / --ubp-kb-top 由壳层写，见 phone-ui.startKeyboardWatch）：
     真机弹软键盘只缩**视觉视口**、布局视口与 100dvh 都不动，钉在壳底的输入栏会被键盘盖住。
     这里把壳按「被盖住的高度」压矮（max-height 而不是改 height：height: 100dvh 仍是唯一高度真值，
     变量缺省时两值等值 ⇒ 不触发移动端输入时渲染逐像素不变），并按视觉视口偏移平移
     （offsetTop 多数为 0；少数会滚视觉视口的浏览器里不跟住壳会偏半屏）。缩放仍强制失效：
     transform 从 none 换成 translateY(缺省 0px)，视觉等价、不引入 scale。 */
  .ubp-phone {
    width: 100vw; height: 100dvh; max-height: calc(100dvh - var(--ubp-kb-h, 0px));
    /* 安全区让位（iPhone 灵动岛/圆角/横屏刘海；口径同主项目 base.ts 的 --safe-*：env() 取值、
       需要处消费，纯 CSS 零 JS）。只让壳——屏内各层（状态栏/桌面层/App/通知中心/壁纸）都长在
       .ubp-screen 下，自动整体下移，零字面量改动；border-box 生效 ⇒ height: 100dvh 仍是唯一
       高度真值，与上面的软键盘避让不冲突。底部刻意不在这里让：homebar 已按 --ubp-homebar-h
       消费底部安全区，两处都让会双算一个 inset。非刘海设备/桌面 env() 兜底 0 ⇒ 逐像素同旧版。 */
    border-radius: 0;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
    transform: translateY(var(--ubp-kb-top, 0px));
  }
  .ubp-screen { border-radius: 0; }
}

/* ── 通用 App 结构 ── */
.ubp-appbar {
  height: 46px; flex: none; display: flex; align-items: center; gap: 4px;
  padding: 0 8px; background: var(--ubp-card); border-bottom: 1px solid var(--ubp-line);
  position: relative; z-index: 4;
}
.ubp-iconbtn {
  min-width: 32px; height: 32px; border: none; background: transparent; color: var(--ubp-text);
  border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-family: var(--ubp-font);
}
.ubp-iconbtn:active { background: var(--ubp-card-2); }
.ubp-iconbtn svg { width: 20px; height: 20px; }
.ubp-appbar-title {
  flex: 1; text-align: center; font-size: 15.5px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ubp-appbar-sub { font-size: 10.5px; color: var(--ubp-text-2); font-weight: 400; }
.ubp-appbody { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.ubp-appbody.noscroll { overflow: hidden; display: flex; flex-direction: column; }

/* ── 桌面 ── */
.ubp-home {
  flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative;
  padding: 8px 18px 12px; background: linear-gradient(168deg, var(--ubp-accent-soft), transparent 42%), var(--ubp-bg);
}
/* 主界面壁纸：铺满 + 深色蒙层，文字强制浅色保证可读（同聊天背景的做法）。
   壁纸图走专用图层 .ubp-home-bg（取景 transform 只动图层不动内容，docs/13） */
.ubp-home.has-bg { color: #fff; }
.ubp-home.has-bg .ubp-home-date, .ubp-home.has-bg .ubp-home-wdesc,
.ubp-home.has-bg .ubp-home-loc, .ubp-home.has-bg .ubp-appname { color: rgba(255, 255, 255, 0.86); }
.ubp-home.has-bg .ubp-home-wmain { color: #fff; }
/* 壁纸全屏（SH-02）：向上铺满状态栏（38px）、向下铺满 home 条（22px），超出部分由 .ubp-screen 裁切。
   取景 translate 为百分比 ⇒ 容器变大不改变相对构图（docs/13 语义不破）。 */
.ubp-home-bg { position: absolute; inset: -38px 0 -22px; background-size: cover; background-position: center; overflow: hidden; }
/* 壁纸模糊（美化工坊 home.blur；0px=现状零差异）。inset -38px 的出血量 > 最大模糊半径 24px，
   模糊边缘的晕边不会露进屏幕。 */
.ubp-home-bg .ubp-crop-media { filter: blur(var(--ubp-wp-blur, 0px)); }
.ubp-home-scrim { position: absolute; inset: -38px 0 -22px; background: rgba(14, 16, 24, var(--ubp-wp-scrim, 0.42)); }
/* 壁纸态：状态栏/home 条文字转浅色 + 轻投影（:has 由桌面壁纸态驱动，零 JS 生命周期） */
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-statusbar { color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.45); }
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-sb-icons { color: #fff; }
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-homebar-pill { background: #fff; opacity: 0.75; }
.ubp-home > :not(.ubp-home-scrim):not(.ubp-home-bg) { position: relative; z-index: 1; }
/* 顶部信息行：左=时间+日期，右=地点+天气（故事时间快照，无真实时钟） */
.ubp-home-top { flex: none; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 12px 2px 14px; }
.ubp-home-datetime { min-width: 0; line-height: 1.25; }
.ubp-home-time { font-size: 44px; font-weight: 300; letter-spacing: -0.5px; line-height: 1.05; }
.ubp-home-date { font-size: 11px; color: var(--ubp-text-2); margin-top: 1px; }
.ubp-home-ctx { max-width: 58%; text-align: right; font-size: 11px; color: var(--ubp-text-2); line-height: 1.5; }
/* 天气=主视觉（图标21px+大类16px/600），描述小字次行；地点带 pin 图标弱化为末行 */
.ubp-home-weather { word-break: break-all; }
.ubp-home-wmain { display: flex; align-items: center; justify-content: flex-end; gap: 6px; color: var(--ubp-text); line-height: 1.2; }
.ubp-home-wmain svg { width: 21px; height: 21px; flex: none; }
.ubp-home-wmain b { font-size: 16px; font-weight: 600; letter-spacing: 0.5px; }
.ubp-home-wdesc { font-size: 11px; color: var(--ubp-text-2); margin-top: 2px; line-height: 1.45; }
.ubp-home-loc { display: flex; align-items: center; justify-content: flex-end; gap: 3px; margin-top: 4px; font-size: 10.5px; color: var(--ubp-text-3); white-space: nowrap; }
.ubp-home-loc[hidden] { display: none; }
.ubp-home-loc svg { width: 11px; height: 11px; flex: none; }
.ubp-home-loc span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ubp-appgrid {
  flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(var(--ubp-grid-cols, 4), 1fr);
  grid-auto-rows: min-content; gap: var(--ubp-grid-rowgap, 14px) 6px; align-content: start; padding-top: 8px;
  overflow-y: auto;
}
/* SH-01：底栏分层——固定三格（微信/通话/设置）+ 用户钉住的一格沉到底部 Dock，主次不再同权。
   SH-06：托盘与「＋」磁贴双双改吃 token（原先一个半透明到无色、一个写死 card-2）。
   WX-04：「＋」不再是「全部应用」入口，而是钉住选择器；第 4 格被钉住时就是普通 App 磁贴。 */
.ubp-dock {
  flex: none; display: flex; align-items: center; justify-content: space-around; gap: 4px;
  margin: 8px 10px 6px; padding: 10px 8px; border-radius: 22px;
  background: var(--ubp-dock-bg); border: 1px solid var(--ubp-dock-line);
  box-shadow: var(--ubp-dock-shadow); backdrop-filter: blur(14px);
}
/* 壁纸态托盘跟着照片走（更透、改用白描边定边）；磁贴不跟——号色恒定才读得清 */
.ubp-home.has-bg .ubp-dock { background: rgba(255, 255, 255, 0.20); border-color: rgba(255, 255, 255, 0.34); }
.ubp-dock .ubp-appnode { gap: 0; margin: 0; }
.ubp-dock .ubp-appname { display: none; }
.ubp-dock .ubp-appicon { width: var(--ubp-dock-icon, 50px); height: var(--ubp-dock-icon, 50px); box-shadow: none; }
/* 底栏图标的线稿不随 --ubp-icon-size 缩放（那是桌面网格的尺）：底栏有自己的比例（50×0.56=28=现状） */
.ubp-dock .ubp-appicon svg { width: calc(var(--ubp-dock-icon, 50px) * 0.56); height: calc(var(--ubp-dock-icon, 50px) * 0.56); }
/* 「＋」磁贴的加号保持 26px 光学配平（上一条 (0,2,1) 会压过它，显式钉回） */
.ubp-dock .ubp-appicon-more svg { width: 26px; height: 26px; }
/* 「更多」磁贴：托盘里唯一有「座」的一格——card 实心底 + 发丝描边 + 轻投影，把方形磁贴从托盘里拎出来。
   特异度刻意压在 (0,2,0)，与皮肤段 .ubp-skin-* .ubp-appicon 同级 ⇒ 后面的皮肤规则仍能接管它的
   圆角/描边/投影（「图标处理跟皮肤」这一约定不破）。 */
.ubp-dock .ubp-appicon-more {
  background: var(--ubp-more-fill); color: var(--ubp-more-ico);
  border: 1px solid var(--ubp-more-line); box-shadow: var(--ubp-more-shadow);
}
/* 动作面板项多时（应用索引）不溢出手机：面板自身可滚 */
.ubp-actionsheet .ubp-sheet { max-height: 76%; overflow-y: auto; }
/* IA-01 A 底部动作面板：竖排动作项 + 末项「取消」单独一块（对照 mockup c-ia01；
   横排一行只适合 2 个字以内的按钮，4 项以上的长标签会溢出——竖排彻底消除该缺陷） */
.ubp-as-list { display: flex; flex-direction: column; gap: 8px; }
.ubp-as-item {
  width: 100%; min-height: 42px; border: none; border-radius: 10px; background: var(--ubp-card-2);
  color: var(--ubp-text); font-family: var(--ubp-font); font-size: 14px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 6px 12px; text-align: center;
}
.ubp-as-item.danger { color: var(--ubp-danger); font-weight: 600; }
.ubp-as-item:active { filter: brightness(0.95); }
.ubp-as-cancel { margin-top: 10px; background: var(--ubp-card-3); font-weight: 600; }
.ubp-appnode { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; position: relative; }

/* ── 图标整理（I-5，仅排序）──
   抖动动画只在 .ubp-edit 存在时运行（未进入整理态＝零开销）；拖拽中的那块抬起来并停抖。 */
.ubp-edit .ubp-appgrid .ubp-appnode { animation: ubp-jiggle 0.9s ease-in-out infinite; }
.ubp-edit .ubp-appgrid .ubp-appnode:nth-child(2n) { animation-delay: 0.12s; }
.ubp-edit .ubp-appgrid .ubp-appnode:nth-child(3n) { animation-delay: 0.24s; }
.ubp-edit .ubp-appgrid .ubp-appnode .ubp-appicon { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22); }
.ubp-edit .ubp-appgrid .ubp-appnode.ubp-dragging { animation: none; opacity: 0.88; transform: scale(1.08); z-index: 2; }
@keyframes ubp-jiggle {
  0%, 100% { transform: rotate(-1.1deg); }
  50% { transform: rotate(1.1deg); }
}
.ubp-edit-bar { flex: none; display: flex; align-items: center; gap: 10px; margin: 0 2px 10px; }
.ubp-edit-bar > span { flex: 1; min-width: 0; font-size: 11.5px; color: var(--ubp-text-2); }
.ubp-edit-done { flex: none; height: 30px; padding: 0 16px; border: none; border-radius: 15px;
  background: var(--ubp-accent); color: #fff; font-family: var(--ubp-font); font-size: 12.5px; font-weight: 600; cursor: pointer; }
.ubp-edit-done:active { filter: brightness(0.94); }.ubp-appnode.disabled { opacity: 0.42; }
.ubp-appnode:active .ubp-appicon { transform: scale(0.9); }
.ubp-appicon {
  width: var(--ubp-icon-size, 54px); height: var(--ubp-icon-size, 54px); border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  color: #fff; box-shadow: 0 3px 10px rgba(0,0,0,0.16); transition: transform 0.12s ease; position: relative;
}
.ubp-appicon svg { width: calc(var(--ubp-icon-size, 54px) * 0.5185); height: calc(var(--ubp-icon-size, 54px) * 0.5185); }
/* 「更多」加号：笔画加粗到 2.2、收到 26px，与 28px 的线稿图标光学配平（16 字「＋」比图标显小）
   必须排在 .ubp-appicon svg 之后：同级特异度靠源序取胜 */
.ubp-appicon-more svg { width: 26px; height: 26px; stroke-width: 2.2; }
/* 皮肤自定义图标图片（core/skin-themes skinAppIcon；铺满图标容器） */
.ubp-appicon .ubp-appicon-img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; display: block; }
.ubp-appname { font-size: 11px; color: var(--ubp-text); max-width: 66px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-appbadge {
  position: absolute; top: -4px; right: -4px; min-width: 17px; height: 17px; border-radius: 9px;
  background: var(--ubp-badge); color: #fff; font-size: 10px; line-height: 17px; text-align: center; padding: 0 4px;
  display: none;
}
.ubp-appbadge.on { display: block; }

/* ── 微信 · 会话/通讯录 ── */
.ubp-tabbar {
  height: 42px; flex: none; display: flex; background: var(--ubp-card); border-top: 1px solid var(--ubp-line);
}
.ubp-tab { flex: 1; border: none; background: transparent; font-size: 12.5px; color: var(--ubp-text-2); cursor: pointer; font-family: var(--ubp-font); padding-top: 3px; }
.ubp-tab.active { color: var(--ubp-accent); font-weight: 600; }
.ubp-wx-list { background: var(--ubp-card); }
.ubp-wx-grouphead {
  position: sticky; top: 0; z-index: 2; padding: 6px 14px; font-size: 12px; color: var(--ubp-text-2);
  background: var(--ubp-card-2);
  display: flex; align-items: center; gap: 5px;
}
/* F91：分组头计数签（原全角括号裸字退役） */
.ubp-wx-grouphead .wx-gcount { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 5px; border-radius: 99px; font-size: 10px; background: var(--ubp-card-3); color: var(--ubp-text-3); font-variant-numeric: tabular-nums; }
.ubp-wx-row {
  display: flex; align-items: center; gap: 11px; padding: 10px 14px; cursor: pointer;
  border-bottom: 1px solid var(--ubp-line); background: var(--ubp-card);
}
.ubp-wx-row:active { background: var(--ubp-card-2); }
/* 头像**必须自己构成层叠上下文**（2026-10-04 用户报「微博详情页评论头像越过『说点什么』输入框显示在最上面」的根因修复）。
   根因与本条的关系：头像内部有三层显式层级（图案 0 / 首字 1 / 真图 2，见下方「生成头像」段），
   但 .ubp-avatar 只有 position: relative（z-index auto）＝**不构成层叠上下文**，这三个 z-index 会跳出
   头像本身，到最近的祖先层叠上下文里跟同级兄弟层比大小——微博详情/贴吧详情/小红书详情的滚动体在
   .ubp-app(isolation) 里、通讯录等页在 .ubp-chat > :not(...) 给的内层 .ubp-appbody(z-1) 里，于是：
     · 评论头像真图（z-2）压过 sticky 底栏 .ubp-replybar / .ubp-xhs-actionbar（z-index auto）——
       头像跟着列表滑到栏上时整个压在输入框上面；
     · 通讯录行头像（z-2）与 sticky 分组头 .ubp-wx-grouphead（z-2）同档，行在 DOM 里靠后 ⇒ 头像反压分组头。
   修法取**源头收口**（对齐 .ubp-app 的 isolation 先例）：让头像成为层叠上下文，内部 0/1/2 只在头像内互比，
   对外整体仍以 z-index auto 参与（画在文档流里本该在的位置）。不再逐个给底栏/分组头提 z-index 掩盖——
   那是每加一个 sticky 层就要补一次数字的漏桶。真渲染命中探针：.mockup/replybar-z-*、.mockup/grouphead-z-*。 */
.ubp-avatar {
  width: 44px; height: 44px; border-radius: 9px; flex: none; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 600;
  overflow: hidden; position: relative; isolation: isolate;
}
.ubp-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* ── 生成头像（第六轮 ⑦）：无立绘/无自定义图时的「那张脸」 ──
   底色由 core 的 avatarGradient 按名字稳定散列给出（行内 background-image）；
   这里补两层：极淡图案（.ubp-avatar-pat）+ 文字投影（.ubp-avatar-gen 的首字）。
   真图存在时它退居底层，破图由 bindAvatarErrorFallback 隐藏上层后露出——故有图时也照常渲染。
   **层级必须显式排**：真图（.ubp-crop-media）恒在兜底层之上（z-index 2）＞ 首字（1）＞ 图案（0）。
   反例（2026-10-03 实测反馈）：只给首字 z-index:1 而不给真图定层级 ⇒ 首字会压到人像脸上。
   **且这三层必须被关在头像自己的层叠上下文里**（.ubp-avatar 的 isolation: isolate，2026-10-04）：
   漏掉包围盒时它们是跳出头像、到 App 层去跟 sticky 底栏/分组头比大小（评论头像压「说点什么」栏的根因）。 */
.ubp-avatar.ubp-avatar-gen { background-size: cover; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.22); }
.ubp-avatar .ubp-avatar-glyph { position: relative; z-index: 1; }
.ubp-avatar .ubp-avatar-pat {
  position: absolute; inset: 0; z-index: 0; opacity: 0.5; pointer-events: none;
  background-image: radial-gradient(circle at 78% 22%, rgba(255, 255, 255, 0.34) 0 12%, transparent 13%),
                    radial-gradient(circle at 20% 82%, rgba(255, 255, 255, 0.22) 0 18%, transparent 19%);
}
.ubp-avatar > .ubp-crop-media { z-index: 2; }
/* ── 取景媒体层（全部取景槽位共用；docs/13）────────────────────────────────
   显示位（.ubp-avatar/.ubp-sauth-cover/.ubp-chat-bg/.ubp-home-bg/.ubp-call-bg/.ubp-crop-box）
   只负责 overflow:hidden 裁剪；媒体层承载「整张图 + 平移/缩放/旋转」。
   默认铺满显示位（未取景时与改造前逐字节同观感）；取景参数由内联样式覆盖定位：
     · 新口径（参数带 a）出 left/top:50% + right/bottom:auto + aspect-ratio + min 尺寸，
       媒体层即「cover 后的整张图」（比显示位大），故照片任意高度都能平移进窗口；
     · 旧口径（历史数据）出 inset:0;width/height:100% + translate/scale，行为与改造前一致。 */
.ubp-crop-media { position: absolute; inset: 0; }
.ubp-crop-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ubp-crop-media.bg { background-size: cover; background-position: center; background-repeat: no-repeat; }
.ubp-avatar.small { width: 36px; height: 36px; font-size: 14px; border-radius: 7px; }
/* 可点头像（聊天页＝资料卡入口，本轮新增）：只包一层动作节点，flex:none 保行布局逐像素不变；
   按压只做轻微变暗，不加永久外框——不改变微信观感（真机点头像也无外框）。 */
.ubp-ava-act { flex: none; display: inline-flex; cursor: pointer; border-radius: 7px; }
.ubp-ava-act:active { filter: brightness(0.93); }
/* 群头像不再单独改形：与私聊同款圆角方形（真机微信口径，会话列表/群成员/聊天页一致） */
.ubp-wx-main { flex: 1; min-width: 0; }
.ubp-wx-title { display: block; font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-wx-preview { display: block; font-size: 12.5px; color: var(--ubp-text-2); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-wx-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; align-self: flex-start; margin-top: 2px; }
/* 列表时间=故事时间快照（自由文本），限宽截断 */
.ubp-wx-time { font-size: 11px; color: var(--ubp-text-3); max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-wx-badge {
  min-width: 17px; height: 17px; border-radius: 9px; background: var(--ubp-badge); color: #fff;
  font-size: 10.5px; line-height: 17px; text-align: center; padding: 0 5px;
}
/* 手动「标为未读」=红点无数字（真机微信口径；与未读计数角标并存互不干扰） */
.ubp-wx-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ubp-badge); margin-top: 4px; }
/* 置顶会话（长按动作面板「置顶该聊天」）：真机=行底色浅一档，仍按 updatedAt 排在置顶组内 */
.ubp-wx-row.pinned { background: var(--ubp-card-2); }
/* 长按菜单开着时被指代的那一行保持高亮（真机同款）：面板贴在按下点附近仍可能盖住邻行，高亮直接消歧 */
.ubp-wx-row.menu-on { background: var(--ubp-card-2); }
.ubp-wx-row.pinned:active { background: var(--ubp-card-2); filter: brightness(0.97); }
/* 会话页搜索框（真机微信：列表顶部灰色胶囊，输入即就地过滤） */
.ubp-wx-searchbar {
  display: flex; align-items: center; gap: 6px; flex: none;
  margin: 8px 10px 2px; padding: 0 10px; height: 32px;
  background: var(--ubp-card); border-radius: 8px;
}
.ubp-wx-searchicon { display: inline-flex; flex: none; color: var(--ubp-text-3); }
.ubp-wx-searchicon svg { width: 15px; height: 15px; }
.ubp-wx-searchinput {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  font-family: var(--ubp-font); font-size: 13px; color: var(--ubp-text);
}
.ubp-wx-searchinput::placeholder { color: var(--ubp-text-3); }
.ubp-empty { padding: 48px 24px; text-align: center; color: var(--ubp-text-3); font-size: 13px; line-height: 1.8; }
.ubp-empty b { color: var(--ubp-text-2); font-weight: 600; }
/* 空态动作钮（CP-01：一句状态 + 一个动作钮；不再写「点右上角…」指路长文） */
.ubp-empty-btn {
  display: inline-flex; align-items: center; justify-content: center; margin-top: 10px;
  min-width: 84px; height: 32px; padding: 0 14px; border: 1px solid var(--ubp-accent);
  border-radius: 999px; background: transparent; color: var(--ubp-accent);
  font-size: 13px; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-empty-btn:active { background: var(--ubp-accent-soft); }
/* ── 渲染器内联样式收口（VI-04）──
   原先散落在渲染器里的行内 font-size/color 一律改为以下类：内联字号逃逸字体缩放管线（不随设置缩放），
   且无法被 token 化。新增文字样式请在此登记，勿再回写内联 font-size。 */
.ubp-inline-sub { font-size: 11px; color: var(--ubp-text-3); }
.ubp-inline-name { flex: 1; font-size: 13px; }
.ubp-inline-name i { display: block; font-style: normal; font-size: 11px; color: var(--ubp-text-3); }
.ubp-inline-row { margin-bottom: 6px; font-size: 13px; color: var(--ubp-text-2); }
.ubp-inline-note { margin-bottom: 8px; font-size: 11px; color: var(--ubp-text-3); }
.ubp-btn-sm { flex: none; height: 30px; padding: 0 12px; font-size: 13px; }
.ubp-hint-toggle { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--ubp-text-2); padding: 2px 2px 6px; cursor: pointer; }
/* 窥私 App：通话列表方向图标 + 持久错误横幅（生成失败；用户点击才清除） */
.ubp-wx-callicon { width: 16px; height: 16px; color: var(--ubp-text-3); display: inline-flex; }
.ubp-wx-callicon svg { width: 16px; height: 16px; }
.ubp-spy-errorbar {
  display: flex; align-items: center; gap: 8px;
  margin: 8px 10px 0; padding: 9px 12px; border-radius: 10px;
  background: var(--ubp-danger-bg, rgba(220, 68, 68, 0.12)); color: var(--ubp-danger);
  font-size: 12.5px; cursor: pointer;
}
.ubp-spy-errorbar svg { width: 15px; height: 15px; flex: none; }
.ubp-spy-errorbar-text { flex: 1; min-width: 0; line-height: 1.5; word-break: break-word; }
.ubp-spy-errorbar-close { flex: none; font-weight: 600; opacity: 0.85; }
.ubp-spy-errorbar-retry { flex: none; border: 1px solid currentColor; border-radius: 8px; padding: 3px 10px; font-size: 12px; font-weight: 600; background: transparent; color: inherit; cursor: pointer; }
.ubp-spy-errorbar-retry:active { background: var(--ubp-danger); border-color: var(--ubp-danger); color: #fff; }
/* 信息流触底加载提示（四社媒 App 共用；滚到底自动追加更早帖子） */
.ubp-feed-more { margin: 10px 10px 0; padding: 10px 0 2px; text-align: center; font-size: 12px; color: var(--ubp-text-3); }

/* ── 聊天页 ── */
.ubp-chat { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--ubp-chat-bg, transparent); }
/* 自定义聊天背景（⋯菜单更换）：固定不随消息滚动，内容层统一抬到蒙层之上 */
.ubp-chat-bg {
  position: absolute; inset: 0; z-index: 0; overflow: hidden;
  background-size: cover; background-position: center;
}
.ubp-chat-bg::after { content: ''; position: absolute; inset: 0; background: rgba(16, 18, 22, 0.46); }
/* 聊天流内容层抬到背景之上；长按菜单与其遮罩是「浮层」，必须排除（否则被压回正常流、落出可视区） */
.ubp-chat > :not(.ubp-chat-bg):not(.ubp-wx-menu-veil):not(.ubp-wx-menu) { position: relative; z-index: 1; }
/* 但上面那条「>」规则只认**直属子节点**：F40 的分区容器 #ubp-input-extras 是 display:contents
   （不产生布局盒、子节点上提参加布局），选择器够不到它的子节点 ⇒ ➕面板/@列表/引用条/生成条
   仍是 static，被 .ubp-chat-bg（z-index:0 + 蒙层）整层压住——实测报障：设背景后「让对方先说」
   与 ➕ 面板看不见、也点不到（命中测试同绘制顺序）。分区子节点按同一档抬升；只点名 input-extras：
   menu-zone 的 veil/menu 是绝对定位浮层，通吃规则会把它们按回 relative、落出可视区。
   注：本段在模板字符串内，注释里禁写反引号/美元花括号（会截断字面量，F40-c 有运行时断言兜底）。 */
.ubp-chat > #ubp-input-extras > * { position: relative; z-index: 1; }
.ubp-chat-msgs {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 12px 12px 6px; display: flex; flex-direction: column; gap: 9px;
}
/* 长按消息菜单（对齐真实微信：深灰气泡 + 白字 + 细分隔线 + 指向消息的小三角；上方放不下则翻到下方） */
.ubp-wx-menu-veil { position: absolute; inset: 0; z-index: 35; }
.ubp-wx-menu {
  position: absolute; left: 50%; z-index: 40;
  transform: translate(-50%, calc(-100% - 10px));
  display: flex; flex-wrap: wrap; justify-content: center; align-items: stretch;
  max-width: 88%;
  background: #4C4C4C; border-radius: 10px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
}
.ubp-wx-menu.below { transform: translate(-50%, 10px); }
.ubp-wx-menu::after {
  content: ""; position: absolute; left: 50%; bottom: -5px; transform: translateX(-50%);
  border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 6px solid #4C4C4C;
}
.ubp-wx-menu.below::after { bottom: auto; top: -5px; border-top: none; border-bottom: 6px solid #4C4C4C; }
.ubp-wx-menu-item {
  border: none; background: none; cursor: pointer; color: #fff;
  font-family: var(--ubp-font); font-size: 13px; font-weight: 500;
  padding: 11px 12px; white-space: nowrap; position: relative;
}
.ubp-wx-menu-item + .ubp-wx-menu-item::before {
  content: ""; position: absolute; left: 0; top: 24%; bottom: 24%; width: 1px; background: rgba(255, 255, 255, 0.18);
}
.ubp-wx-menu-item.danger { color: #FF8A80; }
.ubp-wx-menu-item:active { background: rgba(255, 255, 255, 0.1); }
/* 会话长按菜单（真机微信式贴行弹框）：浅色面板 + 左对齐竖向条目 + 细分隔线；**不压暗背景**
   （与消息气泡的深色 .ubp-wx-menu 同族不同形：那个贴气泡、带小三角；这个贴列表行、无三角）。
   挂在 .ubp-app 下（遮罩盖满整个 App，点哪都收）；上方放不下则翻到行下方（.below），
   横向锚在按下点（行内联 style 给 top/left 百分比，与 CSS 缩放无关）。 */
.ubp-wx-cmenu-veil { position: absolute; inset: 0; z-index: 35; }
.ubp-wx-cmenu {
  position: absolute; z-index: 40; transform: translateY(calc(-100% - 6px));
  /* 宽度跟着最长条目走（真机=内容宽），面板越窄越能把左沿贴到按下点；上限 64% 兜住极窄屏 */
  width: max-content; min-width: 152px; max-width: 64%;
  background: var(--ubp-card); border-radius: 10px; overflow: hidden;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18), 0 0 0 0.5px var(--ubp-line);
}
.ubp-wx-cmenu.below { transform: translateY(6px); }
.ubp-wx-cmenu-item {
  display: block; width: 100%; border: none; background: none; cursor: pointer; text-align: left;
  font-family: var(--ubp-font); font-size: 15px; color: var(--ubp-text); padding: 12px 16px;
}
.ubp-wx-cmenu-item + .ubp-wx-cmenu-item { border-top: 1px solid var(--ubp-line); }
.ubp-wx-cmenu-item.danger { color: var(--ubp-danger); }
.ubp-wx-cmenu-item:active { background: var(--ubp-card-2); }
.ubp-time-divider { align-self: center; text-align: center; font-size: 10.5px; color: var(--ubp-notice-text); background: var(--ubp-notice-bg); border-radius: 5px; padding: 2px 9px; margin: 4px 0; }
.ubp-msg-row { display: flex; align-items: flex-start; gap: 8px; }
.ubp-msg-row.me { justify-content: flex-end; }
/* 气泡列（名字 + 气泡）：头像在列外侧，群聊名字在气泡上方 */
.ubp-msg-col { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; max-width: 78%; }
.ubp-msg-row.me .ubp-msg-col { align-items: flex-end; }
.ubp-msg-row.me .ubp-msg-col .ubp-msg-name { text-align: right; }
.ubp-msg-meta { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.ubp-msg-row.me .ubp-msg-meta { align-items: flex-end; }
.ubp-msg-name { font-size: 10.5px; color: var(--ubp-text-3); margin-bottom: 3px; padding: 0 3px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-bubble {
  padding: 8px 12px; border-radius: 11px; font-size: 14.5px; line-height: 1.48;
  background: var(--ubp-bubble-other); color: var(--ubp-text);
  white-space: pre-wrap; word-break: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}
.ubp-msg-row.me .ubp-bubble { background: var(--ubp-bubble-me); color: var(--ubp-bubble-me-text); }
/* 语音消息：上=播放条（喇叭+按字数直算的时长），下=文字转写 */
.ubp-voice {
  display: flex; flex-direction: column; align-items: stretch;
  background: var(--ubp-bubble-other); border-radius: 11px; overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}
.ubp-msg-row.me .ubp-voice { background: var(--ubp-bubble-me); color: var(--ubp-bubble-me-text); }
.ubp-voice-bar {
  display: flex; align-items: center; gap: 7px; width: 100%; height: 38px; padding: 0 12px;
  border: none; background: transparent; color: inherit; cursor: pointer; font-family: var(--ubp-font);
  position: relative; overflow: hidden;
}
.ubp-voice-bar svg { width: 17px; height: 17px; flex: none; }
.ubp-voice-bar:active { opacity: 0.72; }
/* 我方语音：时长在左、喇叭镜像朝内（左右镜像） */
.ubp-voice-bar.rev { flex-direction: row-reverse; }
.ubp-voice-bar.rev svg { transform: scaleX(-1); }
.ubp-voice-dur { font-size: 13px; font-weight: 600; white-space: nowrap; }
.ubp-voice-text {
  padding: 7px 12px 9px; font-size: 13px; line-height: 1.55;
  color: var(--ubp-text-2); white-space: pre-wrap; word-break: break-word;
  border-top: 1px solid var(--ubp-line);
}
.ubp-msg-row.me .ubp-voice-text { color: var(--ubp-bubble-me-text); opacity: 0.85; border-top-color: rgba(0, 0, 0, 0.08); }
/* 播放中：声波弧线依次闪动 */
.ubp-voice.playing .ubp-vc-w1 { animation: ubp-vc-arc 0.9s ease-in-out infinite; }
.ubp-voice.playing .ubp-vc-w2 { animation: ubp-vc-arc 0.9s ease-in-out infinite 0.3s; }
/* 真实播放：进度填充（已播部分淡色高亮）+ 合成中转圈（第 31 篇 TTS） */
.ubp-voice-bar > * { position: relative; z-index: 1; }
.ubp-voice-progress {
  position: absolute; left: 0; top: 0; bottom: 0; z-index: 0;
  background: var(--ubp-accent); opacity: 0.16; pointer-events: none;
  transition: width 0.2s linear;
}
.ubp-msg-row.me .ubp-voice-progress { opacity: 0.22; }
.ubp-voice.loading .ubp-spinner { width: 15px; height: 15px; border-width: 2px; }
@keyframes ubp-vc-arc { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }
/* ── 语音情绪彩标 + 演绎说明（TTS 开启时才渲染；关闭时一个节点都不输出）────────────────
   彩标色相只来自规范八词（core/voice-providers.emotionBadge 给的英文键），亮/暗两套配方、色相不变；
   认不出的标注如实显示原文、走中性灰；**空标注什么都不渲染**（刻意不给「未标注」占位）。
   四风格皮肤不接管标签颜色（皮肤只管气泡底色）。 */
.ubp-vmeta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ubp-emo {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px 2px; border-radius: 999px;
  font-size: 11px; font-weight: 600; line-height: 1.4; white-space: nowrap;
  background: hsl(var(--ubp-emo-h, 0) 90% 94%); color: hsl(var(--ubp-emo-h, 0) 62% 30%);
  box-shadow: inset 0 0 0 1px hsl(var(--ubp-emo-h, 0) 70% 84%);
}
.ubp-emo::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none; }
.ubp-dark .ubp-emo {
  background: hsl(var(--ubp-emo-h, 0) 42% 20%); color: hsl(var(--ubp-emo-h, 0) 88% 78%);
  box-shadow: inset 0 0 0 1px hsl(var(--ubp-emo-h, 0) 46% 33%);
}
.ubp-emo-happy { --ubp-emo-h: 42; }
.ubp-emo-surprised { --ubp-emo-h: 20; }
.ubp-emo-sad { --ubp-emo-h: 214; }
.ubp-emo-calm { --ubp-emo-h: 172; }
.ubp-emo-angry { --ubp-emo-h: 356; }
.ubp-emo-fearful { --ubp-emo-h: 288; }
.ubp-emo-disgusted { --ubp-emo-h: 104; }
.ubp-emo-whisper { --ubp-emo-h: 250; }
.ubp-emo-unknown { background: var(--ubp-card-3); color: var(--ubp-text-2); box-shadow: inset 0 0 0 1px var(--ubp-line); }
.ubp-dark .ubp-emo-unknown { background: var(--ubp-card-3); color: var(--ubp-text-2); box-shadow: inset 0 0 0 1px var(--ubp-line); }
.ubp-deliv {
  font-size: 11px; line-height: 1.5; color: var(--ubp-text-3); min-width: 0;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
/* 语音气泡内：元信息行在播放条之下、转写之上；紧跟的转写不再自带分隔线（避免双线） */
.ubp-voice > .ubp-vmeta { padding: 7px 12px 2px; border-top: 1px solid var(--ubp-line); }
.ubp-msg-row.me .ubp-voice > .ubp-vmeta { justify-content: flex-end; }
.ubp-voice > .ubp-vmeta + .ubp-voice-text { border-top: none; padding-top: 4px; }
.ubp-msg-row.me .ubp-deliv { color: var(--ubp-bubble-me-text); opacity: 0.72; }
/* 语音总开关关闭：播放条置灰失效（点了没反应），只留文字转写 */
.ubp-voice.off .ubp-voice-bar { color: var(--ubp-text-3); cursor: default; }
.ubp-voice.off .ubp-voice-bar svg { opacity: 0.5; }
.ubp-voice.off .ubp-voice-dur { font-weight: 500; opacity: 0.75; }
.ubp-voice-offtag { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ubp-text-3); }
.ubp-voice-offtag svg { width: 12px; height: 12px; }
.ubp-msg-row.me .ubp-voice.off .ubp-voice-bar { color: var(--ubp-bubble-me-text); }
.ubp-msg-row.me .ubp-voice-offtag { color: var(--ubp-bubble-me-text); opacity: 0.62; }
/* 通话逐句：情绪/演绎在气泡**上方**（塞进气泡会把短句撑成又窄又高的竖条）；我方靠右 */
.ubp-call-col { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; }
.ubp-chatlog-row.me .ubp-call-col { align-items: flex-end; }
.ubp-bubble-img { position: relative; padding: 3px; background: var(--ubp-bubble-other); border-radius: 11px; }
.ubp-bubble-img img { display: block; max-width: 100%; max-height: 250px; border-radius: 8px; object-fit: cover; cursor: zoom-in; }
/* 成品图放大/重绘统一在放大页里（renderers/image-lightbox）：气泡上不再有「重新生图」悬浮小钮 */
.ubp-img-pending {
  width: 172px; min-height: 96px; border-radius: 8px; border: 1px dashed var(--ubp-line);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 10px; color: var(--ubp-text-3); font-size: 11.5px; text-align: center; cursor: pointer;
}
.ubp-img-pending svg { width: 20px; height: 20px; flex: none; }
.ubp-img-failed { cursor: pointer; color: var(--ubp-danger); }
.ubp-img-reason { font-size: 10.5px; line-height: 1.4; color: var(--ubp-danger); opacity: 0.8; }
.ubp-spinner {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid var(--ubp-line); border-top-color: var(--ubp-accent);
  animation: ubp-spin 0.8s linear infinite;
}
@keyframes ubp-spin { to { transform: rotate(360deg); } }
.ubp-sys-msg {
  text-align: center; font-size: 11px; color: var(--ubp-notice-text); padding: 4px 12px;
  align-self: center; max-width: 88%; line-height: 1.7;
  background: var(--ubp-notice-bg); border-radius: 8px;
}
.ubp-sys-msg.error { color: var(--ubp-danger); background: var(--ubp-danger-soft); border-radius: 8px; cursor: pointer; }
.ubp-typing { display: flex; align-items: center; gap: 8px; }
.ubp-typing-dots { display: flex; gap: 4px; padding: 11px 13px; background: var(--ubp-bubble-other); border-radius: 11px; }
.ubp-typing-dots i { width: 6px; height: 6px; border-radius: 3px; background: var(--ubp-text-3); animation: ubp-dot 1.2s ease-in-out infinite; }
.ubp-typing-dots i:nth-child(2) { animation-delay: 0.15s; }
.ubp-typing-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes ubp-dot { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }

/* WX-06：「终止」并入 typing 气泡行（底部绿条双指示退役：typing 气泡即唯一生成指示） */
.ubp-typing-abort {
  border: none; background: transparent; color: var(--ubp-danger); font-size: 12px; cursor: pointer;
  font-family: var(--ubp-font); padding: 0 2px;
}
.ubp-inputbar {
  flex: none; display: flex; align-items: flex-end; gap: 7px; padding: 8px 9px;
  padding-bottom: max(8px, env(safe-area-inset-bottom, 0px));
  background: var(--ubp-card); border-top: 1px solid var(--ubp-line);
}
.ubp-chat-input {
  flex: 1; min-height: 36px; max-height: 96px; resize: none; border: 1px solid var(--ubp-line);
  border-radius: 9px; background: var(--ubp-bg); color: var(--ubp-text);
  padding: 8px 10px; font-size: 14px; line-height: 1.4; font-family: var(--ubp-font); outline: none;
}
.ubp-chat-input:focus { border-color: var(--ubp-accent); }
.ubp-toolbtn {
  width: 34px; height: 34px; flex: none; border: none; background: var(--ubp-card-2); color: var(--ubp-text-2);
  border-radius: 9px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;
}
.ubp-toolbtn svg { width: 18px; height: 18px; }
.ubp-toolbtn:active { background: var(--ubp-line); }
.ubp-sendbtn {
  min-width: 52px; height: 34px; flex: none; border: none; border-radius: 9px;
  background: var(--ubp-accent); color: #fff; font-size: 13.5px; font-weight: 600; cursor: pointer;
  font-family: var(--ubp-font);
  display: flex; align-items: center; justify-content: center; padding: 0 10px; white-space: nowrap;
}
.ubp-sendbtn svg { width: 18px; height: 18px; flex: none; }
.ubp-sendbtn:disabled { opacity: 0.45; cursor: default; }

/* ── ➕功能面板 / @选择列表 ── */
.ubp-plus-panel {
  flex: none; display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px 8px;
  padding: 14px 18px; background: var(--ubp-card); border-top: 1px solid var(--ubp-line);
}
.ubp-plus-cell {
  display: flex; flex-direction: column; align-items: center; gap: 7px;
  border: none; background: none; cursor: pointer; padding: 0;
  font-size: 11.5px; color: var(--ubp-text-2); font-family: var(--ubp-font);
}
.ubp-plus-cell:active { opacity: 0.55; }
.ubp-plus-icon {
  width: 46px; height: 46px; border-radius: 12px; background: var(--ubp-card-2);
  display: flex; align-items: center; justify-content: center; color: var(--ubp-text);
}
.ubp-plus-icon svg { width: 22px; height: 22px; }
.ubp-mention-panel {
  flex: none; max-height: 172px; overflow-y: auto; background: var(--ubp-card);
  border-top: 1px solid var(--ubp-line); border-bottom: 1px solid var(--ubp-line);
}
.ubp-mention-row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%;
  padding: 7px 14px; border: none; background: none; cursor: pointer; text-align: left;
  font-family: var(--ubp-font);
}
.ubp-mention-row:active { background: var(--ubp-line); }
.ubp-mention-name { font-size: 13.5px; font-weight: 600; color: var(--ubp-text); }
.ubp-mention-sub { font-size: 11px; color: var(--ubp-text-3); }
.ubp-mention-tag { color: var(--ubp-accent); font-weight: 600; }
/* ── 输入栏上方生成条（WX-02：还原微信后「触发 AI」的唯一可见入口；原独立触发钮+角标已废） ── */
.ubp-wx-pendbar {
  flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  background: var(--ubp-card); border-top: 1px solid var(--ubp-line);
}
.ubp-wx-pend-main {
  flex: 1; min-width: 0; height: 30px; border: none; border-radius: 8px; cursor: pointer;
  background: var(--ubp-accent-soft); color: var(--ubp-accent);
  font-size: 13px; font-weight: 600; font-family: var(--ubp-font);
  display: flex; align-items: center; justify-content: center; gap: 4px;
}
.ubp-wx-pend-main:active { filter: brightness(0.96); }
.ubp-wx-pend-arrow { font-weight: 400; opacity: 0.75; }
.ubp-wx-pend-more {
  width: 30px; height: 30px; flex: none; border: none; border-radius: 8px; cursor: pointer;
  background: var(--ubp-card-2); color: var(--ubp-text-2);
  display: flex; align-items: center; justify-content: center;
}
.ubp-wx-pend-more svg { width: 16px; height: 16px; }
.ubp-wx-pend-more:active { background: var(--ubp-line); }

/* ── 长按多选（圆形勾选框 + 底部操作条） ── */
.ubp-msg-check {
  width: 21px; height: 21px; flex: none; margin-top: 6px; align-self: flex-start;
  border: 1.5px solid var(--ubp-text-3); border-radius: 50%; background: transparent;
  color: #fff; font-size: 12px; cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.ubp-msg-check.on { background: var(--ubp-accent); border-color: var(--ubp-accent); }
.ubp-msg-row.sel { cursor: pointer; }
.ubp-msg-row.picked .ubp-bubble,
.ubp-msg-row.picked .ubp-voice,
.ubp-msg-row.picked .ubp-bubble-img,
.ubp-msg-row.picked .ubp-quote-card,
.ubp-msg-row.picked .ubp-chatlog-card { outline: 1.5px solid var(--ubp-accent); outline-offset: 1px; }
.ubp-selbar {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: var(--ubp-card); border-top: 1px solid var(--ubp-line);
}
/* 批量本职三钮（全选/转发/删除；微信侧，V1.068）——字号收一档 + 内边距归零是当年
   5 钮挤到单钮≈60px 时的对策，保留无害；窥私/相册复用本类时同样安全。 */
.ubp-selbar .ubp-btn { flex: 1; height: 36px; font-size: 13px; padding: 0 2px; }

/* ── 引用回复（输入框上方引用条 + 气泡内引用卡） ── */
.ubp-quote-bar {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  background: var(--ubp-card); border-top: 1px solid var(--ubp-line);
}
.ubp-quote-bar-main {
  flex: 1; min-width: 0; display: flex; align-items: baseline;
  padding-left: 7px; border-left: 2.5px solid var(--ubp-accent);
  font-size: 12px; color: var(--ubp-text-2);
}
.ubp-quote-bar-main b { flex: none; font-weight: 600; color: var(--ubp-text); }
.ubp-quote-bar-main i { font-style: normal; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-quote-cancel {
  flex: none; width: 22px; height: 22px; padding: 0; cursor: pointer; line-height: 1;
  border: none; border-radius: 50%; background: var(--ubp-card-2); color: var(--ubp-text-3);
  font-size: 12px; font-family: var(--ubp-font);
}
.ubp-quote-cancel:active { background: var(--ubp-line); }
/* 气泡内引用卡：与气泡同底色 + 上半圆角，视觉连成一体（分隔线区分引用与被引用）。
   ★文本按气泡同款口径换行（pre-wrap + break-word）：nowrap 会让 min-content = max-content = 全文宽，
   fit-content 因此不受可用宽度约束 → 卡片撑破 .ubp-msg-col 的 78% 列宽并从左侧被裁掉（用户报障）。
   ★副文本色与分隔线沿用语音转写（.ubp-voice-text）同款口径：other 侧 --ubp-text-2 / me 侧
   --ubp-bubble-me-text（此前 me 侧只改了名字色，正文仍用 --ubp-text-3——深色下 #6C6C70 压在
   #2F6B45 气泡上几乎看不清，用户报障）；分隔线不按侧覆盖，交给 --ubp-line 吃亮/暗两套值。 */
.ubp-quote-card {
  display: block; align-self: stretch; padding: 6px 12px 5px;
  border-radius: 11px 11px 0 0; background: var(--ubp-bubble-other);
  border-bottom: 1px solid var(--ubp-line);
  font-size: 12px; line-height: 1.35; color: var(--ubp-text-2);
  white-space: pre-wrap; word-break: break-word;
}
.ubp-msg-row.me .ubp-quote-card { background: var(--ubp-bubble-me); color: var(--ubp-bubble-me-text); }
.ubp-quote-card b { font-weight: 600; color: var(--ubp-text); }
.ubp-quote-card i { font-style: normal; }
.ubp-msg-row.me .ubp-quote-card b { color: var(--ubp-bubble-me-text); }
.ubp-msg-row.me .ubp-quote-card i { opacity: 0.85; }
/* 带引用卡：气泡上半圆角抹平（与卡片合成一张卡；末子元素=气泡/语音/图片/转账卡/转发卡）；
   文本气泡与语音条再与卡片同宽——否则会出现「宽引用卡 + 窄气泡」的错位（图片/转账/转发卡本身有
   min/max-width，宽度自持，不参与拉伸）。 */
.ubp-msg-meta.has-quote > :last-child { border-radius: 0 0 11px 11px; }
.ubp-msg-meta.has-quote > .ubp-bubble,
.ubp-msg-meta.has-quote > .ubp-voice { align-self: stretch; }

/* ── 合并转发的聊天记录卡片 + 查看层 ── */
.ubp-chatlog-card {
  display: flex; align-items: center; gap: 9px; padding: 10px 12px; border: none; cursor: pointer;
  background: var(--ubp-bubble-other); color: var(--ubp-text); border-radius: 11px;
  min-width: 196px; max-width: 232px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
  font-family: var(--ubp-font); text-align: left;
}
.ubp-msg-row.me .ubp-chatlog-card { background: var(--ubp-bubble-me); color: var(--ubp-bubble-me-text); }
.ubp-chatlog-card:active { filter: brightness(0.95); }
.ubp-chatlog-icon {
  width: 36px; height: 36px; flex: none; border-radius: 8px;
  background: var(--ubp-accent-soft); color: var(--ubp-accent);
  display: flex; align-items: center; justify-content: center;
}
.ubp-chatlog-icon svg { width: 20px; height: 20px; }
.ubp-chatlog-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ubp-chatlog-main b { font-size: 13.5px; font-weight: 600; }
.ubp-chatlog-main i { font-style: normal; font-size: 11.5px; opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-chatlog-view { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
.ubp-chatlog-row { display: flex; flex-direction: column; gap: 4px; }
.ubp-chatlog-row.me { align-items: flex-end; }
.ubp-chatlog-name { font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-chatlog-bubble {
  max-width: 88%; padding: 7px 11px; border-radius: 10px; background: var(--ubp-card-2);
  font-size: 13px; line-height: 1.5; word-break: break-word; white-space: pre-wrap;
}
.ubp-chatlog-row.me .ubp-chatlog-bubble { background: var(--ubp-bubble-me); color: var(--ubp-bubble-me-text); }
/* ── 通话记录 · 逐句重听（第六轮 ④）──────────────────────────────────────
   闸门 = 语音后端开启 **且** 通话逐句朗读开启（core/phone-settings 的 voiceBackend / voiceReadCalls，
   默认 off/false）——闸门关时渲染层一个节点都不输出，故这一整块 CSS 在默认状态下永不匹配（零重绘）。
   每句一个 ▶：播放中按钮实心 + 一圈进度环（conic-gradient 画在 ::after 上，零额外节点）；
   被念的那一行气泡加一圈淡描边 + 行内声波。我方台词与无音频指纹的旧档 .off 诚实置灰、不可点。 */
.ubp-call-line-row { display: flex; align-items: center; gap: 8px; }
.ubp-call-line-row.me { flex-direction: row-reverse; }
.ubp-call-replay {
  position: relative; flex: none; width: 26px; height: 26px; padding: 0; border-radius: 50%;
  border: 1px solid var(--ubp-line); background: var(--ubp-card); color: var(--ubp-text-2);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
}
.ubp-call-replay svg { width: 12px; height: 12px; }
.ubp-call-replay:active { background: var(--ubp-card-2); }
.ubp-call-replay.playing { background: var(--ubp-accent); border-color: var(--ubp-accent); color: #fff; }
.ubp-call-replay.playing::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  background: conic-gradient(var(--ubp-accent) var(--ubp-rp, 0%), transparent 0);
  mask: radial-gradient(circle, transparent 62%, #000 64%); -webkit-mask: radial-gradient(circle, transparent 62%, #000 64%);
}
.ubp-call-replay.off { opacity: 0.38; cursor: default; }
.ubp-chatlog-row.spk .ubp-chatlog-bubble { box-shadow: 0 0 0 2px var(--ubp-accent-soft); }
.ubp-call-wave { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 11px; margin-left: 7px; vertical-align: -1px; }
.ubp-call-wave i { width: 2px; border-radius: 1px; background: currentColor; opacity: 0.8; animation: ubp-call-wave 0.9s ease-in-out infinite; }
.ubp-call-wave i:nth-child(1) { height: 5px; }
.ubp-call-wave i:nth-child(2) { height: 10px; animation-delay: 0.15s; }
.ubp-call-wave i:nth-child(3) { height: 7px; animation-delay: 0.3s; }
@keyframes ubp-call-wave { 0%, 100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }
.ubp-chatlog-img { max-width: 100%; max-height: 180px; border-radius: 7px; display: block; }
.ubp-chatlog-voice { display: inline-flex; align-items: center; gap: 6px; }
.ubp-chatlog-voice svg { width: 15px; height: 15px; flex: none; }

/* ── 群管理（改名/成员增删） ── */
.ubp-gm-sec {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; color: var(--ubp-text-2); margin: 12px 0 6px;
}
.ubp-gm-add {
  border: none; background: var(--ubp-accent-soft); color: var(--ubp-accent);
  font-size: 12px; border-radius: 8px; padding: 4px 10px; cursor: pointer; font-family: var(--ubp-font);
}
.ubp-gm-rename { display: flex; gap: 8px; }
.ubp-gm-rename .ubp-fieldinput { flex: 1; }
.ubp-gm-rename .ubp-btn { flex: none; width: 64px; height: 36px; }
.ubp-gm-member { display: flex; align-items: center; gap: 9px; padding: 7px 0; border-bottom: 1px solid var(--ubp-line); cursor: pointer; border-radius: 8px; }
.ubp-gm-mname { flex: 1; font-size: 13.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-gm-remove {
  border: none; background: var(--ubp-danger-soft); color: var(--ubp-danger);
  font-size: 11.5px; border-radius: 7px; padding: 4px 9px; cursor: pointer; font-family: var(--ubp-font);
}
.ubp-gm-remove:disabled { opacity: 0.35; cursor: default; }
/* 群成员行＝资料卡入口（本轮新增）：整行入点击域 + 名字后一枚淡箭头作可点提示；
   「移出」钮仍是独立动作（它自带 data-ubp-act，命中即它自己，不会连带开卡）。 */
.ubp-gm-member:active { background: var(--ubp-card-2); }
.ubp-gm-chev { flex: none; display: inline-flex; color: var(--ubp-text-3); }
.ubp-gm-chev svg { width: 15px; height: 15px; }

/* ── 气氛组（群管理段 / 批量添加 / 只读资料卡） ── */
.ubp-gm-count {
  display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 8px;
  margin-top: 10px; font-size: 12.5px; line-height: 1.7; color: var(--ubp-text-2);
}
.ubp-gm-count > span:first-child { white-space: nowrap; }
.ubp-gm-count b { color: var(--ubp-text); font-weight: 600; }
.ubp-gm-count-break { font-size: 10px; color: var(--ubp-text-3); white-space: nowrap; flex: none; }
.ubp-gm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ubp-gm-main .ubp-gm-mname { flex: none; display: flex; align-items: center; gap: 5px; }
.ubp-gm-sub { font-size: 10.5px; color: var(--ubp-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-gm-meta { font-size: 10.5px; color: var(--ubp-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-atmo-tag {
  font-size: 9px; font-weight: 600; font-style: normal; color: var(--ubp-accent);
  background: var(--ubp-accent-soft); border-radius: 4px; padding: 1px 4px; line-height: 14px; flex: none;
}
.ubp-atmo-note { font-size: 10.5px; color: var(--ubp-text-3); line-height: 1.55; margin: -2px 0 7px; }
.ubp-atmo-pending {
  display: flex; align-items: center; gap: 10px; padding: 9px 10px; margin-bottom: 6px;
  border: 1px solid var(--ubp-line); border-radius: 10px; background: var(--ubp-card-2);
}
.ubp-atmo-stack { display: flex; flex: none; }
.ubp-atmo-stack i {
  width: 24px; height: 24px; border-radius: 50%; background: var(--ubp-card-3);
  border: 2px solid var(--ubp-card); display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--ubp-text-3); font-style: normal; margin-left: -7px;
}
.ubp-atmo-stack i:first-child { margin-left: 0; }
.ubp-atmo-pending-main { flex: 1; min-width: 0; }
.ubp-atmo-pending-main b { display: block; font-size: 12px; color: var(--ubp-text); margin-bottom: 1px; }
.ubp-atmo-pending-main em {
  font-style: normal; font-size: 10.5px; color: var(--ubp-text-3); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  overflow-wrap: anywhere;
}
.ubp-atmo-clear {
  font-size: 10.5px; color: var(--ubp-text-3); background: transparent; border: none;
  font-family: var(--ubp-font); cursor: pointer; flex: none; padding: 0;
}
.ubp-atmo-intro { font-size: 13px; color: var(--ubp-text-2); line-height: 1.6; }
.ubp-atmo-stepper { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 16px 0 9px; }
.ubp-atmo-step {
  width: 36px; height: 36px; border: 1px solid var(--ubp-line); border-radius: 9px;
  background: var(--ubp-card-2); color: var(--ubp-text); font-size: 19px; font-family: var(--ubp-font);
  cursor: pointer; line-height: 1;
}
.ubp-atmo-step:disabled { opacity: 0.35; cursor: default; }
.ubp-atmo-stepper input {
  width: 58px; text-align: center; font-size: 24px; font-weight: 800; color: var(--ubp-text);
  border: 0; background: transparent; font-family: var(--ubp-font); outline: none;
}
.ubp-atmo-quick { display: flex; justify-content: center; gap: 8px; padding-bottom: 12px; }
.ubp-atmo-quick-btn {
  min-width: 48px; height: 28px; border: none; border-radius: 8px; background: var(--ubp-card-2);
  color: var(--ubp-text-2); font-size: 12px; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-atmo-quick-btn.on { background: var(--ubp-accent-soft); color: var(--ubp-accent); font-weight: 600; }
.ubp-atmo-quick-btn:disabled { opacity: 0.35; cursor: default; }
.ubp-atmo-req { margin: 0 0 10px; }
.ubp-atmo-req-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 0 1px 5px; font-size: 11.5px; color: var(--ubp-text-2);
}
.ubp-atmo-req-label { display: flex; align-items: center; gap: 5px; font-weight: 500; }
.ubp-atmo-req-label em {
  font-style: normal; font-size: 9.5px; color: var(--ubp-text-3);
  border: 1px solid var(--ubp-line); border-radius: 4px; padding: 0 4px; line-height: 15px;
}
.ubp-atmo-req-count { font-size: 10px; color: var(--ubp-text-3); font-variant-numeric: tabular-nums; flex: none; }
.ubp-atmo-req-input {
  display: block; width: 100%; height: 52px; min-height: 52px; max-height: 52px; resize: none;
  border: 1px solid var(--ubp-line); border-radius: 9px; background: var(--ubp-bg);
  color: var(--ubp-text); padding: 7px 9px; font-size: 12.5px; line-height: 1.5;
  font-family: var(--ubp-font); outline: none;
}
.ubp-atmo-req-input:focus { border-color: var(--ubp-accent); }
.ubp-atmo-req-input::placeholder { color: var(--ubp-text-3); }
.ubp-atmo-req-hint { font-size: 10px; color: var(--ubp-text-3); line-height: 1.5; margin-top: 4px; }
.ubp-atmo-tip { border-radius: 9px; background: var(--ubp-card-2); padding: 8px 10px; font-size: 11px; color: var(--ubp-text-3); line-height: 1.65; }
.ubp-atmo-profile { text-align: center; padding: 2px 0 4px; }
.ubp-atmo-profile .ubp-avatar { margin: 0 auto 9px; }
.ubp-atmo-profile-name { font-size: 16px; font-weight: 600; color: var(--ubp-text); display: flex; align-items: center; justify-content: center; gap: 6px; }
.ubp-atmo-profile-meta { margin-top: 5px; font-size: 11px; color: var(--ubp-text-3); }
.ubp-atmo-profile-desc { margin-top: 8px; font-size: 12.5px; color: var(--ubp-text-2); line-height: 1.6; }
.ubp-mention-row .ubp-mention-name { display: flex; align-items: center; gap: 5px; }

/* ── 覆盖层 / 弹层 / 选人 ── */
.ubp-overlay {
  position: absolute; inset: 0; z-index: 30; background: var(--ubp-overlay);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.ubp-sheet {
  width: 100%; max-width: 300px; max-height: 78%; overflow-y: auto;
  background: var(--ubp-card); border-radius: 15px; padding: 15px 15px 11px;
  box-shadow: 0 10px 36px rgba(0,0,0,0.28);
}
.ubp-sheet-title { font-size: 15px; font-weight: 600; margin-bottom: 11px; text-align: center; }
.ubp-sheet-body { font-size: 13px; color: var(--ubp-text); line-height: 1.6; }
.ubp-sheet-actions { display: flex; gap: 9px; margin-top: 13px; }
/* 钮排两形态（WX-09）：cols2=次操作两列并排（半宽 ≥130px，最长 6 字文案单行放下）；
   stack=主操作/危险操作通栏堆叠。旧「全部 flex:1 平摊一行」在 4 钮时每钮约 65px，
   「更换聊天背景」「发送申请」必然折行——即用户报障的溢出态。 */
.ubp-sheet-actions.cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ubp-sheet-actions.stack { flex-direction: column; gap: 8px; margin-top: 8px; }
/* ★纵向 flex 里 flex:1 的 flex-basis:0 会盖掉 height，通栏钮塌成 min-content（实测 17px）；
   必须 flex:none 让下面的 height 生效。 */
.ubp-sheet-actions.stack .ubp-btn { flex: none; }
.ubp-sheet-actions .ubp-btn { height: 36px; font-size: 13.5px; }
/* 自挂载弹层共用错误行（选图弹层 / 全局存储管理） */
.ubp-sheet-err { flex: none; font-size: 11.5px; color: var(--ubp-danger); margin-top: 8px; }

/* ── 钉住选择器（底栏「＋」入口，WX-04）──
   旧实现把「全部应用」塞进通用动作面板：12 条无图标、无角标、无分组的菜单行，末尾还挂一个多余的
   「取消」块（点背景/Esc/返回键本就能关）——那是破坏性/确认列表的版式，不是启动器。行排分支更糟：
   .ubp-sheet-actions 的 flex:1 把 13 个中文标签压成单字竖排并横向溢出卡片。
   版式沿用 SH-06 的抽屉（与桌面网格共用同一条磁贴渲染链路与同一组网格参数，切屏无位移感），
   只把语义从「打开全部应用」换成「钉到底栏」——故多一行说明：交互变了，得说清楚点什么会发生。 */
.ubp-drawer-overlay { z-index: 90; align-items: flex-end; padding: 0; }
.ubp-drawer-overlay .ubp-sheet {
  max-width: 100%; max-height: 74%; display: flex; flex-direction: column;
  border-radius: 18px 18px 0 0; padding: 14px 0 0; overflow: hidden;
  box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.22);
  animation: ubp-drawer-up 0.2s ease;
}
@keyframes ubp-drawer-up { from { transform: translateY(14px); opacity: 0; } to { transform: none; opacity: 1; } }
/* 头部复用 ED-03 的抽屉统一头部（左标题 + 右上 ✕），只把左右留白对齐桌面网格 */
.ubp-drawer-overlay .ubp-sheet-head { padding: 2px 18px 8px; }
.ubp-drawer-hint { padding: 0 18px 4px; font-size: 11px; line-height: 1.5; color: var(--ubp-text-2); }
/* 4 列 / 列距 6px / 行距 16px / 图标 54px —— 与 .ubp-appgrid 同参数；12 个 App 三行一屏放完 */
.ubp-drawer-grid {
  flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: min-content; gap: 16px 6px; padding: 4px 12px 18px;
  align-content: start; overflow-y: auto;
}
.ubp-hint-pills { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 2px 2px; }
.ubp-hint-pill {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
  padding: 4px 10px; border-radius: 999px; background: var(--ubp-card-2);
  color: var(--ubp-text); font-size: 12.5px; line-height: 1.5;
}
.ubp-hint-pill-x {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 14px; height: 14px; border-radius: 50%; border: none; padding: 0;
  background: rgba(127, 127, 127, 0.25); color: inherit; font-size: 11px; line-height: 1; cursor: pointer;
}
.ubp-hint-pill-x:active { background: rgba(127, 127, 127, 0.45); }
.ubp-hint-pill.add {
  border: 1.5px dashed rgba(127, 127, 127, 0.45); background: transparent;
  color: var(--ubp-text-3); padding: 4px 12px; cursor: pointer;
}
.ubp-hint-pill.add:active { background: rgba(127, 127, 127, 0.12); }
.ubp-btn {
  flex: 1; height: 38px; border: none; border-radius: 10px; font-size: 14px; cursor: pointer;
  font-family: var(--ubp-font); background: var(--ubp-card-2); color: var(--ubp-text);
  /* 文案永不换行溢出：任何弹层容器变窄也只省略，不改行（换行钮=用户点名的丑态） */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ubp-btn.primary { background: var(--ubp-accent); color: #fff; font-weight: 600; }
.ubp-btn.danger { background: var(--ubp-danger); color: #fff; font-weight: 600; }
/* 卡内危险操作（IA-07）：描边红降级，实心红只留给「存储 → 危险区」这类整屏确认场景 */
.ubp-btn.danger-quiet { background: var(--ubp-card-2); color: var(--ubp-danger); border: 1px solid rgba(230, 67, 64, 0.35); font-weight: 500; }
.ubp-btn:active { filter: brightness(0.92); }
/* 图标兜底：SVG 无固有尺寸，缺规则会被替换元素默认尺寸撑爆弹层（发帖面板「发到」钮先例） */
.ubp-btn svg { width: 15px; height: 15px; vertical-align: -3px; flex: none; }
.ubp-btn:disabled { opacity: 0.4; cursor: default; }


/* ── 设置·功能 →「提示词编辑」标准化编辑器（自挂载弹层；照 storage-manager-sheet 模式）── */
.ubp-socp-sheet { z-index: 52; }
/* 确认弹层恒在一切面板之上（IA-02）：提示词编辑器 z-index 52 / 取景 66 内触发的确认不能被面板盖住 */
.ubp-actionsheet { z-index: 90; }
.ubp-socp-panel {
  max-width: 340px; height: 96%; max-height: none; padding: 11px 12px 10px;
  display: flex; flex-direction: column; overflow: hidden;
}
.ubp-socp-head { flex: none; display: flex; align-items: center; gap: 6px; }
.ubp-socp-title { flex: 1; font-size: 15px; font-weight: 600; text-align: center; }
/* 首屏关闭钮在右：左侧留同宽占位，标题保持居中 */
.ubp-socp-headpad { width: 32px; flex: none; }
.ubp-socp-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 1px 4px; }
/* 两步结构（ED-01）：首屏平台/场景大卡 */
.ubp-socp-cards { display: grid; gap: 10px; margin-top: 8px; }
.ubp-socp-card {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  border: 1px solid var(--ubp-line); border-radius: 12px; background: var(--ubp-card);
  padding: 14px 13px; cursor: pointer; font-family: inherit; text-align: left;
}
.ubp-socp-card:active { background: var(--ubp-card-2); }
.ubp-socp-card-name { font-size: 15px; font-weight: 600; color: var(--ubp-text); }
.ubp-socp-card-tags { display: flex; align-items: center; gap: 6px; flex: none; }
.ubp-socp-card-last {
  font-size: 10px; line-height: 1; color: var(--ubp-text-3);
  border: 1px solid var(--ubp-line); border-radius: 999px; padding: 3px 6px;
}
/* 编辑页面包屑（返回首屏） */
.ubp-socp-path { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--ubp-text-3); margin-top: 6px; }
.ubp-socp-path button {
  border: none; background: transparent; color: var(--ubp-accent); font-size: 11.5px;
  font-family: inherit; padding: 0; cursor: pointer;
}
.ubp-socp-path b { color: var(--ubp-text-2); font-weight: 600; }
.ubp-socp-path-sep { color: var(--ubp-text-3); }
.ubp-socp-tabs { display: flex; background: var(--ubp-card-2); border-radius: 10px; overflow: hidden; margin-top: 8px; }
.ubp-socp-tabs button {
  flex: 1; border: none; background: transparent; color: var(--ubp-text-2);
  font-size: 12.5px; font-family: inherit; padding: 8px 0; cursor: pointer;
}
.ubp-socp-tabs button.on { background: var(--ubp-accent-soft); color: var(--ubp-accent); font-weight: 600; }
/* 领域段控（社媒/生图）：一级选择，比页签更重（accent 描边 + 稍大字号） */
.ubp-socp-domains { background: var(--ubp-accent-soft); }
.ubp-socp-domains button { font-size: 13px; font-weight: 600; padding: 9px 0; }
.ubp-socp-domains button.on { background: var(--ubp-accent); color: #fff; }
.ubp-socp-sel.ubp-set-group { margin: 10px 0 0; }
.ubp-socp-sec { font-size: 11.5px; font-weight: 600; color: var(--ubp-text-3); margin: 12px 0 0; }
.ubp-socp-cur { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 11.5px; color: var(--ubp-text-3); margin-top: 10px; }
.ubp-socp-cur b { color: var(--ubp-text); font-weight: 600; }
/* 注意：基础 .ubp-textarea/.ubp-fieldinput 定义在本块之后，同权重会被其 min-height 压回去 → 必须双类提高权重 */
.ubp-textarea.ubp-socp-editor { width: 100%; min-height: 300px; margin: 8px 0 0; font-size: 11.5px; line-height: 1.75; }
.ubp-socp-note {
  font-size: 11px; line-height: 1.7; color: var(--ubp-accent); background: var(--ubp-accent-soft);
  border-radius: 9px; padding: 7px 9px; margin-top: 9px;
}
.ubp-chip.ubp-chip-tok { font-family: ui-monospace, Menlo, Consolas, monospace; }
.ubp-socp-foot { flex: none; display: flex; gap: 9px; padding-top: 10px; }
.ubp-socp-foot .ubp-btn { flex: 1; height: 36px; font-size: 13px; }
.ubp-socp-err { font-size: 11.5px; line-height: 1.6; color: var(--ubp-danger); margin-top: 9px; }
.ubp-socp-tcard { border: 1px solid var(--ubp-line); border-radius: 11px; padding: 8px 9px; margin-top: 8px; }
.ubp-socp-th { display: flex; align-items: center; gap: 7px; }
.ubp-socp-idx {
  flex: none; width: 19px; height: 19px; border-radius: 6px; text-align: center;
  background: var(--ubp-accent-soft); color: var(--ubp-accent); font-size: 11px; line-height: 19px; font-weight: 600;
}
.ubp-fieldinput.ubp-socp-tlabel { flex: 1; height: 32px; padding: 0 10px; font-size: 13px; }
.ubp-socp-del {
  flex: none; border: none; background: transparent; color: var(--ubp-danger);
  font-size: 11.5px; font-family: inherit; padding: 2px 0; cursor: pointer;
}
.ubp-textarea.ubp-socp-tguide { width: 100%; min-height: 88px; margin: 7px 0 0; font-size: 12px; line-height: 1.65; }
.ubp-socp-add {
  width: 100%; height: 34px; margin-top: 8px; border: 1px dashed var(--ubp-line); border-radius: 10px;
  background: transparent; color: var(--ubp-accent); font-size: 12.5px; font-family: inherit; cursor: pointer;
}

/* ── 全局手机存储管理弹层（设置→存储）── */
.ubp-stormgr-sheet { z-index: 50; }
.ubp-stormgr-intro { font-size: 11.5px; color: var(--ubp-text-3); line-height: 1.6; margin-bottom: 10px; }
/* 加载相提示（快相→慢相）：空文本时整行收起，不占位 */
.ubp-stormgr-phase { font-size: 11px; color: var(--ubp-text-3); line-height: 1.6; margin-bottom: 8px; }
.ubp-stormgr-phase:empty { display: none; }
.ubp-stormgr-list { display: flex; flex-direction: column; gap: 7px; max-height: 300px; overflow-y: auto; overscroll-behavior: contain; }
.ubp-stormgr-empty { font-size: 12px; color: var(--ubp-text-3); line-height: 1.7; padding: 8px 2px; }
.ubp-stormgr-row {
  display: flex; align-items: center; gap: 8px; padding: 8px 9px;
  border: 1px solid var(--ubp-line); border-radius: 10px;
}
.ubp-stormgr-row.current { border-color: var(--ubp-accent); }
.ubp-stormgr-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ubp-stormgr-name { font-size: 13px; font-weight: 600; color: var(--ubp-text); display: flex; align-items: center; gap: 5px; }
.ubp-stormgr-badge {
  font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 8px;
  background: var(--ubp-accent); color: #fff; flex: none;
}
.ubp-stormgr-meta { font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-stormgr-acts { display: flex; gap: 6px; flex: none; }
.ubp-stormgr-acts .ubp-btn { flex: none; width: auto; min-width: 56px; height: 28px; font-size: 12px; padding: 0 8px; }
.ubp-pickrow {
  display: flex; align-items: center; gap: 10px; padding: 8px 2px; cursor: pointer;
  border-bottom: 1px solid var(--ubp-line);
}
.ubp-check {
  width: 19px; height: 19px; border-radius: 50%; border: 1.5px solid var(--ubp-text-3);
  flex: none; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 11px;
}
.ubp-check.on { background: var(--ubp-accent); border-color: var(--ubp-accent); }
.ubp-fieldinput {
  width: 100%; border: 1px solid var(--ubp-line); border-radius: 9px; background: var(--ubp-bg);
  color: var(--ubp-text); padding: 8px 10px; font-size: 13.5px; font-family: var(--ubp-font); outline: none;
}
.ubp-fieldinput:focus { border-color: var(--ubp-accent); }
/* IA-05：唯一 toast 实现挂在壳层图层上（App 重绘不冲掉），允许换行（长文案不再被 nowrap 截断） */
/* 屏内提示恒在最上层（95 > 抽屉/动作面板 90）：toast 非交互（pointer-events:none），不会挡到下面任何钮；
   压在面板之下则「面板开着时的提示」（WX-04 点固定三格 →「已在底栏」）用户根本看不见。 */
.ubp-toastlayer { position: absolute; inset: 0; pointer-events: none; z-index: 95; }
.ubp-toast {
  position: absolute; left: 50%; bottom: 76px; transform: translateX(-50%); z-index: 95;
  background: rgba(0, 0, 0, 0.78); color: #fff; font-size: 12.5px; border-radius: 9px;
  padding: 8px 14px; pointer-events: none; white-space: normal; max-width: 78%; text-align: center; line-height: 1.45;
}
/* 带动作的提示（音色池「已删除 · 撤销」等）：层整体 pointer-events:none，只有这个变体自己接点击 */
.ubp-toast.act {
  pointer-events: auto; display: flex; align-items: center; gap: 10px;
  text-align: left; max-width: 88%; padding: 8px 10px 8px 14px;
}
.ubp-toast-tx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-toast-act {
  flex: none; border: none; background: transparent; color: var(--ubp-accent); font-size: 12.5px;
  font-weight: 700; font-family: var(--ubp-font); padding: 2px; cursor: pointer;
}

/* ── 资料卡 ── */
.ubp-profile { padding: 4px 2px; }
.ubp-profile-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.ubp-profile-name { font-size: 17px; font-weight: 600; }
.ubp-profile-tag { font-size: 11px; color: var(--ubp-accent); background: var(--ubp-accent-soft); border-radius: 5px; padding: 1px 6px; margin-left: 6px; }
.ubp-profile-line { font-size: 12.5px; color: var(--ubp-text-2); line-height: 1.7; word-break: break-all; }
.ubp-profile-line b { color: var(--ubp-text); font-weight: 600; }
/* ── 资料卡「备注」行（本轮新增）──
   常态＝与其它档案行同款的一行字（没写过显示「无」），点它才整行换输入框；行内右侧小对勾＝保存并退出编辑。
   数据随本聊天存档（PhoneChatData.characterNotes），与自定义头像同层。 */
.ubp-note-row { cursor: pointer; border-radius: 6px; margin: 0 -4px; padding: 0 4px; }
.ubp-note-row:active { background: var(--ubp-card-2); }
/* 编辑态：标签 + 输入框 + 小对勾（间距 12px 对齐其它行的全角空格缩进） */
.ubp-note-edit { display: flex; align-items: center; gap: 12px; }
.ubp-note-inline {
  flex: 1; min-width: 0; height: 30px; padding: 0 8px;
  border: 1px solid var(--ubp-line); border-radius: 8px; background: var(--ubp-bg);
  color: var(--ubp-text); font-size: 13px; font-family: var(--ubp-font); outline: none;
}
.ubp-note-inline:focus { border-color: var(--ubp-accent); }
.ubp-note-ok {
  flex: none; width: 28px; height: 28px; border: none; border-radius: 8px; cursor: pointer;
  background: var(--ubp-accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
}
.ubp-note-ok:active { filter: brightness(0.92); }
.ubp-note-ok svg { width: 15px; height: 15px; }
/* ── 资料卡「音色」行（docs/59）──
   与「备注」行同款：常态一行字，整行可点（右侧淡箭头提示）；TTS 总开关关着时这行**根本不输出**（不是隐藏）。
   值＝当前生效的音色名，后面一截小灰字＝来源（服务商 · 手动/自动）；未指定时整行走灰（同 picker 的 placeholder 口径）。 */
.ubp-voice-row { display: flex; align-items: center; cursor: pointer; border-radius: 6px; margin: 0 -4px; padding: 0 4px; }
.ubp-voice-row:active { background: var(--ubp-card-2); }
.ubp-voice-row .ubp-voice-val { flex: 1; min-width: 0; }
.ubp-voice-src { margin-left: 8px; font-size: 11px; color: var(--ubp-text-3); white-space: nowrap; }
.ubp-voice-row.none .ubp-voice-val { color: var(--ubp-text-3); }
.ubp-voice-chev { flex: none; display: inline-flex; margin-left: 6px; color: var(--ubp-text-3); }
.ubp-voice-chev svg { width: 15px; height: 15px; }
/* comfy（本地克隆）：音色＝参考音频，换它要传文件（设置页的活）⇒ 纯信息行，不接点击 */
.ubp-voice-row.ro { cursor: default; }
.ubp-voice-row.ro:active { background: transparent; }

/* ── 设置 ── */
.ubp-set-group { background: var(--ubp-card); border-radius: 12px; margin: 12px 14px 0; overflow: hidden; }
/* 危险区（ST-04）：清空/重置等不可恢复操作统一置底，红色底调提示 */
.ubp-set-group.danger { background: var(--ubp-danger-soft); }
/* 分组标题＝分段标签（IA-07）：11px + 字距 + text-3，与卡内标题（13.5px / text）拉开层级。
   旧样式 12px 与卡内 13.5px 归并后同落 --fs-13，实际渲染同号 → 层级读不出来。 */
.ubp-set-grouptitle { font-size: 11px; font-weight: 600; color: var(--ubp-text-3); letter-spacing: 0.08em; padding: 16px 18px 0; }
.ubp-set-group .ubp-set-grouptitle { padding-top: 13px; }
.ubp-fieldrow {
  display: flex; align-items: center; gap: 10px; padding: 11px 15px;
  border-bottom: 1px solid var(--ubp-line); min-height: 46px;
}
.ubp-set-group .ubp-fieldrow:last-child { border-bottom: none; }
.ubp-fieldrow.column { flex-direction: column; align-items: stretch; gap: 7px; }
.ubp-fieldlabel { font-size: 13.5px; flex: 1; }
.ubp-fieldhint { font-size: 11px; color: var(--ubp-text-3); line-height: 1.5; }
.ubp-fieldlabel .ubp-fieldhint { margin-top: 2px; }
/* 主界面/锁屏壁纸行右侧的当前壁纸缩略图 */
.ubp-homebg-thumb, .ubp-lockbg-thumb {
  width: 44px; height: 30px; border-radius: 6px; object-fit: cover; flex: none;
  border: 1px solid var(--ubp-line); background: var(--ubp-accent-soft);
}
.ubp-select {
  border: 1px solid var(--ubp-line); border-radius: 8px; background: var(--ubp-bg); color: var(--ubp-text);
  font-size: 12.5px; padding: 6px 8px; max-width: 150px; font-family: var(--ubp-font); outline: none;
}
.ubp-num {
  width: 62px; border: 1px solid var(--ubp-line); border-radius: 8px; background: var(--ubp-bg);
  color: var(--ubp-text); font-size: 13px; padding: 6px 8px; text-align: center; font-family: var(--ubp-font); outline: none;
}
/* 按功能自动重试勾选（设置→API：per-feature 模式每个功能行右侧） */
.ubp-retry-check {
  display: flex; align-items: center; gap: 4px; flex: none;
  font-size: 11px; color: var(--ubp-text-3); white-space: nowrap; cursor: pointer;
}
.ubp-retry-check input { width: 14px; height: 14px; margin: 0; accent-color: var(--ubp-accent); }
.ubp-textarea {
  width: 100%; min-height: 68px; resize: vertical; border: 1px solid var(--ubp-line); border-radius: 9px;
  background: var(--ubp-bg); color: var(--ubp-text); font-size: 13px; line-height: 1.5; padding: 8px 10px;
  font-family: var(--ubp-font); outline: none;
}
.ubp-switch { position: relative; width: 44px; height: 25px; flex: none; cursor: pointer; }
.ubp-switch input { display: none; }
.ubp-switch .ubp-switch-track {
  position: absolute; inset: 0; border-radius: 13px; background: var(--ubp-line); transition: background 0.18s;
}
.ubp-switch .ubp-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 21px; height: 21px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.25); transition: transform 0.18s;
}
.ubp-switch input:checked ~ .ubp-switch-track { background: var(--ubp-accent); }
.ubp-switch input:checked ~ .ubp-switch-knob { transform: translateX(19px); }
.ubp-setinfo { font-size: 12px; color: var(--ubp-text-2); line-height: 1.8; word-break: break-all; }
.ubp-setinfo b { color: var(--ubp-text); }
.ubp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 4px; margin-right: 5px; vertical-align: 1px; }
.ubp-dot.ok { background: var(--ubp-accent); }
.ubp-dot.warn { background: #F59F2B; }
.ubp-dot.err { background: var(--ubp-danger); }

/* ── 设置 · 字体（字号分档滑杆 + 示例气泡实时预览；字体族复用 .ubp-chips）── */
.ubp-font-preview { background: var(--ubp-bg); border-radius: 10px; padding: 9px 11px 10px; }
.ubp-font-preview .ubp-bubble { display: inline-block; max-width: 100%; }
.ubp-font-slider { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.ubp-font-slider-end { flex: none; font-size: 11px; font-weight: 600; color: var(--ubp-text-2); }
.ubp-font-slider-end.lg { font-size: 17px; }
.ubp-font-slider input[type="range"] {
  flex: 1; min-width: 0; height: 4px; border-radius: 2px; background: var(--ubp-line);
  -webkit-appearance: none; appearance: none; outline: none; cursor: pointer;
}
.ubp-font-slider input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 22px; height: 22px; border-radius: 50%;
  background: var(--ubp-card); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.08);
  cursor: pointer;
}
.ubp-font-slider input[type="range"]::-moz-range-thumb {
  width: 22px; height: 22px; border: none; border-radius: 50%;
  background: var(--ubp-card); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); cursor: pointer;
}

/* ── 设置 · 顶部标签条（分段控件，对齐主项目 settings-tabs）── */
.ubp-set-tabs {
  flex: none; display: flex; gap: 2px; margin: 10px 14px 0; padding: 2px;
  background: var(--ubp-card-2); border-radius: 10px;
}
.ubp-set-tab {
  flex: 1; height: 30px; border: none; border-radius: 8px; background: transparent;
  color: var(--ubp-text-2); font-size: 12.5px; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-set-tab.active {
  background: var(--ubp-card); color: var(--ubp-text); font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

/* ── 设置 · 折叠分组卡片（对齐主项目 settings-section：summary 行内可带总开关/状态徽标）── */
.ubp-set-sec { background: var(--ubp-card); border-radius: 12px; margin: 12px 14px 0; overflow: hidden; }
.ubp-set-sec-summary {
  display: flex; align-items: center; gap: 10px; padding: 11px 15px; min-height: 46px;
  cursor: pointer; list-style: none; user-select: none;
}
.ubp-set-sec-summary::-webkit-details-marker { display: none; }
.ubp-set-sec-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ubp-set-sec-title { font-size: 13.5px; display: flex; align-items: center; gap: 2px; }
.ubp-set-badge { flex: none; font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 9px; white-space: nowrap; }
.ubp-set-badge.on { color: var(--ubp-accent); background: var(--ubp-accent-soft); }
.ubp-set-badge.off { color: var(--ubp-text-3); background: var(--ubp-card-2); }
/* 数值摘要徽标（IA-07）：折叠态展示当前取值，中性灰 + 等宽数字，不让只读值穿「已开启」的绿 */
.ubp-set-badge.val { color: var(--ubp-text-2); background: var(--ubp-card-2); font-weight: 500; font-variant-numeric: tabular-nums; }
.ubp-set-sec-arrow { flex: none; width: 15px; height: 15px; color: var(--ubp-text-3); transition: transform 0.18s ease; }
.ubp-set-sec-arrow svg { width: 15px; height: 15px; display: block; }
.ubp-set-sec[open] > .ubp-set-sec-summary .ubp-set-sec-arrow { transform: rotate(90deg); }
/* 次级折叠（第 31 篇 §15 / docs/35 §A.2）：折叠时只报当前配置模式，展开才配置（低频操作收起来） */
.ubp-set-subsec { margin: 4px 10px 8px; border: 1px solid var(--ubp-line); border-radius: 12px; background: var(--ubp-card-2); overflow: hidden; }
.ubp-set-subsec-summary { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; list-style: none; user-select: none; }
.ubp-set-subsec-summary::-webkit-details-marker { display: none; }
.ubp-set-subsec-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; }
.ubp-set-subsec-body { border-top: 1px dashed var(--ubp-line); background: var(--ubp-card); }
.ubp-set-subsec-body .ubp-fieldrow:last-child { border-bottom: none; }
.ubp-set-subsec[open] > .ubp-set-subsec-summary .ubp-set-sec-arrow { transform: rotate(90deg); }
/* 角色音色面板（V1.131）：先选角色 → 只呈现该角色一个面板；高度与角色数无关（旧版每角色一行会挤爆） */
.ubp-vrole-panel { margin: 8px 12px 10px; border: 1px solid var(--ubp-line); border-radius: 12px; background: var(--ubp-card); overflow: hidden; }
.ubp-vrole-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--ubp-card-2); border-bottom: 1px solid var(--ubp-line); }
.ubp-vrole-av { flex: none; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: #fff; }
.ubp-vrole-who { flex: 1; min-width: 0; }
.ubp-vrole-who b { display: block; font-size: 14px; font-weight: 600; color: var(--ubp-text); }
.ubp-vrole-who span { display: block; font-size: 11px; color: var(--ubp-text-3); margin-top: 2px; }
.ubp-vrole-body .ubp-fieldrow { padding: 9px 12px; }
.ubp-vrole-body .ubp-fieldrow:last-child { border-bottom: none; }
/* 面板内控件一律占满整行：旧版行内并排（40% + 42% + 按钮）正是溢出根因 */
.ubp-vrole-body .ubp-fieldrow.column .ubp-select,
.ubp-vrole-body .ubp-fieldrow.column .ubp-fieldinput { width: 100%; max-width: none; min-width: 0; flex: none; }
.ubp-vrole-btns { display: flex; gap: 8px; }
.ubp-vrole-eff { margin: 8px 12px 4px; border-radius: 9px; background: var(--ubp-card-2); border: 1px solid var(--ubp-line); padding: 7px 10px; font-size: 12px; color: var(--ubp-text-2); line-height: 1.6; }
.ubp-vrole-eff b { color: var(--ubp-text); font-weight: 600; }
.ubp-vrole-tag { display: inline-block; font-size: 10px; font-weight: 700; color: var(--ubp-text-3); border: 1px solid var(--ubp-line); border-radius: 5px; padding: 0 5px; margin-right: 6px; vertical-align: 1px; }
.ubp-vrole-auto { color: var(--ubp-accent); font-weight: 600; }
.ubp-vrole-foot { display: flex; align-items: center; gap: 10px; padding: 0 12px 10px; }
.ubp-vrole-grow { flex: 1; }
.ubp-vrole-quiet { border: none; background: none; color: var(--ubp-accent); font-size: 12.5px; padding: 5px 2px; font-family: var(--ubp-font); cursor: pointer; }
.ubp-vrole-quiet.danger { color: var(--ubp-danger); }
/* 面板内按钮必须写满 ubp-btn + ubp-btn-sm 两个 class：.ubp-btn-sm 只定几何，基底视觉（底色/圆角/
   字体）全靠 .ubp-btn——单独用它等于没样式，落回浏览器默认灰钮。且 .ubp-btn-sm 定义在 .ubp-btn 之前，
   同权重下被后者反盖（flex:1 / 38px），故此处按两级选择器压回紧尺寸；面板外的 .ubp-btn-sm 行为不动。 */
.ubp-vrole-panel .ubp-btn-sm { flex: none; height: 30px; font-size: 13px; }
.ubp-vrole-note { font-size: 11px; color: var(--ubp-text-3); line-height: 1.7; padding: 4px 0 0; }
.ubp-vrole-all { padding: 0 14px 8px; text-align: right; }
.ubp-vrole-warn { margin: 6px 12px 10px; border-radius: 9px; border: 1px solid var(--ubp-warn-line); background: var(--ubp-warn-soft); padding: 8px 10px; font-size: 11.5px; color: var(--ubp-warn); line-height: 1.65; }
.ubp-set-sec-body { border-top: 1px solid var(--ubp-line); }
.ubp-set-sec-body .ubp-fieldrow:last-child { border-bottom: none; }
/* 卡内自述（IA-07）：替代卡外的「灰标题 + 独立说明块」，说明只占卡内一行灰字 */
.ubp-set-sec-sub { padding: 11px 15px 2px; font-size: 11.5px; color: var(--ubp-text-3); line-height: 1.7; }

/* ── 设置 · 「?」提示按钮 + 说明浮层（说明文字收进气泡，浮层 fixed 定位防卡片裁剪）── */
.ubp-tipbtn {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 15px; height: 15px; margin-left: 5px; border-radius: 50%; flex-basis: auto;
  border: 1px solid var(--ubp-line); background: var(--ubp-card-2); color: var(--ubp-text-3);
  font-size: 10px; line-height: 1; font-weight: 700; cursor: pointer; user-select: none;
}
.ubp-tipbtn:hover, .ubp-tipbtn.open { color: var(--ubp-accent); border-color: var(--ubp-accent); }
.ubp-tip-pop {
  position: fixed; z-index: 99; max-width: min(260px, 76vw); padding: 9px 11px; border-radius: 10px;
  background: var(--ubp-card); color: var(--ubp-text-2);
  font-size: 11.5px; line-height: 1.65; word-break: break-word;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25), 0 0 0 1px var(--ubp-line);
  pointer-events: none;
}

/* ── 设置 · 正文互通强调行 + 行下备注 ── */
.ubp-set-emphasis {
  margin: 10px 14px 0; padding: 9px 12px; border-radius: 10px;
  background: var(--ubp-accent-soft); color: var(--ubp-accent);
  font-size: 12px; line-height: 1.7; font-weight: 600;
}
.ubp-set-note { margin: -4px 15px 12px; font-size: 11px; color: var(--ubp-text-3); line-height: 1.6; }
.ubp-fieldhint-inline { font-size: 11px; color: var(--ubp-text-3); margin-left: 6px; }

/* ── 设置 · 拉取音色列表的筛选条（语言/标签…） ── */
.ubp-vfetch {
  display: flex; flex-direction: column; gap: 7px;
  margin: 2px 0 0; padding: 9px 12px; border-radius: 10px;
  background: var(--ubp-card-2); border: 1px solid var(--ubp-line);
}
.ubp-vfetch .ubp-fieldrow { border-bottom: none; padding: 0; min-height: 0; }
.ubp-vfetch .ubp-fieldrow.column .ubp-select,
.ubp-vfetch .ubp-fieldrow.column .ubp-fieldinput { width: 100%; max-width: none; min-width: 0; flex: none; }
.ubp-vfetch .actions { margin: 1px 0 0; }
.ubp-vfetch .ubp-set-note { margin: 0; font-size: 11px; }

/* ── 设置 · 音色池表格化编辑（docs/53；样式与审核过的 mockup 同源，只把 .vp-* 换成 .ubp-vpool-*） ──
   两态共用一张卡：表格态（名称 / 音色 ID / 性别 三列 + 行展开编辑卡）与纯文本态（原 textarea）。
   性别三态配色（粉/蓝/灰）压在各主题的卡面上对比度都够，故不随亮暗换档。 */
.ubp-vpool {
  --vpool-f: #FF4D6A; --vpool-f-soft: rgba(255, 77, 106, 0.14);
  --vpool-m: #3E7BFA; --vpool-m-soft: rgba(62, 123, 250, 0.14);
  --vpool-n: #8E8E93; --vpool-n-soft: rgba(142, 142, 147, 0.16);
  margin: 4px 12px 12px; border: 1px solid var(--ubp-line); border-radius: 12px;
  background: var(--ubp-card); overflow: visible; position: relative;
}
.ubp-vpool-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--ubp-line); background: var(--ubp-card-2); border-radius: 12px 12px 0 0;
}
.ubp-vpool-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; }
/* 卡内小按钮（批量编辑 / 复制 / 置顶 / 删除 / 完成）：描边胶囊，尺寸与 mockup 一致 */
.ubp-vpool-btn {
  border: 1px solid var(--ubp-line); background: var(--ubp-card); color: var(--ubp-text);
  border-radius: 8px; font-size: 12.5px; font-family: var(--ubp-font); padding: 6px 11px;
  white-space: nowrap; cursor: pointer; flex: none;
}
.ubp-vpool-btn.sm { padding: 5px 9px; font-size: 12px; }
.ubp-vpool-btn.primary { background: var(--ubp-accent); border-color: var(--ubp-accent); color: #fff; font-weight: 600; }
.ubp-vpool-btn.danger { background: var(--ubp-danger-soft); border-color: rgba(230, 67, 64, 0.35); color: var(--ubp-danger); font-weight: 500; }
.ubp-vpool-btn:active { filter: brightness(0.94); }
.ubp-vpool-stat { padding: 8px 12px 0; font-size: 11px; color: var(--ubp-text-3); line-height: 1.6; }
.ubp-vpool-stat b { color: var(--ubp-text-2); }
.ubp-vpool-stat .pin { color: var(--ubp-accent); }
.ubp-vpool-tools { padding: 8px 12px 0; }
.ubp-vpool-search {
  width: 100%; border: 1px solid var(--ubp-line); border-radius: 9px; background: var(--ubp-bg);
  color: var(--ubp-text); padding: 6px 9px; font-size: 12px; font-family: var(--ubp-font); outline: none;
}
.ubp-vpool-search:focus { border-color: var(--ubp-accent); }
.ubp-vpool-list { margin: 8px 8px 0; border: 1px solid var(--ubp-line); border-radius: 10px; overflow: hidden; background: var(--ubp-card); }
/* 两列（名称 / 性别）+ 删除位；**音色 ID 不上屏**（悬停出 title 提示、点一下进编辑卡改） */
.ubp-vpool-thead, .ubp-vpool-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 58px 26px;
  align-items: center; gap: 6px; padding: 0 9px;
}
.ubp-vpool-thead {
  height: 24px; background: var(--ubp-card-2); font-size: 10.5px; color: var(--ubp-text-3);
  letter-spacing: 0.02em; border-bottom: 1px solid var(--ubp-line);
}
/* 长池不撑爆设置页：列表自身滚动（约 8 行高） */
.ubp-vpool-rows { max-height: 298px; overflow-y: auto; overscroll-behavior: contain; }
.ubp-vpool-row { height: 38px; border-bottom: 1px solid var(--ubp-line); font-size: 12.5px; }
.ubp-vpool-rows .ubp-vpool-row:last-child { border-bottom: none; }
.ubp-vpool-cell { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
/* 没起名的行直接用 id 当名称显示（灰斜体）：与「名称留空 → 显示 ID」的应用口径一致 */
.ubp-vpool-cell.nolabel { color: var(--ubp-text-3); font-style: italic; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
.ubp-vpool-cell.miss { cursor: default; color: var(--ubp-text-3); font-size: 11.5px; font-style: normal; grid-column: 1 / -1; }
.ubp-vpool-fb {
  font-size: 9.5px; font-weight: 600; color: var(--ubp-accent); background: var(--ubp-accent-soft);
  border-radius: 6px; padding: 1px 5px; margin-left: 5px; vertical-align: 1px;
}
.ubp-vpool-g {
  justify-self: start; border: none; border-radius: 99px; font-size: 11px; font-family: var(--ubp-font);
  padding: 3px 9px; font-weight: 600; cursor: pointer; min-width: 44px; text-align: center;
}
.ubp-vpool-g.f { background: var(--vpool-f-soft); color: var(--vpool-f); }
.ubp-vpool-g.m { background: var(--vpool-m-soft); color: var(--vpool-m); }
.ubp-vpool-g.n { background: var(--vpool-n-soft); color: var(--vpool-n); }
.ubp-vpool-del {
  border: none; background: transparent; color: var(--ubp-text-3); height: 26px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer;
}
.ubp-vpool-del:active { background: var(--ubp-danger-soft); color: var(--ubp-danger); }
.ubp-vpool-del svg { width: 15px; height: 15px; }
/* 行展开编辑卡：名称 / 音色 ID / 性别 / 动作 */
.ubp-vpool-editrow { background: var(--ubp-card-2); border-bottom: 1px solid var(--ubp-line); padding: 9px 10px 10px; }
.ubp-vpool-rows .ubp-vpool-editrow:last-child { border-bottom: none; }
.ubp-vpool-erow { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.ubp-vpool-erow > label { flex: none; width: 52px; font-size: 11.5px; color: var(--ubp-text-2); }
.ubp-vpool-input {
  flex: 1; min-width: 0; border: 1px solid var(--ubp-line); border-radius: 8px; background: var(--ubp-bg);
  color: var(--ubp-text); padding: 6px 9px; font-size: 12.5px; font-family: var(--ubp-font); outline: none;
}
.ubp-vpool-input.id { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.ubp-vpool-input:focus { border-color: var(--ubp-accent); box-shadow: 0 0 0 2px var(--ubp-accent-soft); }
.ubp-vpool-input.bad { border-color: var(--ubp-danger); box-shadow: 0 0 0 2px var(--ubp-danger-soft); }
.ubp-vpool-idwrap { flex: 1; min-width: 0; display: flex; gap: 6px; }
.ubp-vpool-seg { display: flex; gap: 2px; padding: 2px; background: var(--ubp-card-3); border-radius: 9px; }
.ubp-vpool-seg button {
  border: none; background: transparent; font-family: var(--ubp-font); font-size: 11.5px;
  color: var(--ubp-text-2); border-radius: 7px; padding: 4px 10px; cursor: pointer;
}
.ubp-vpool-seg button.on { font-weight: 700; }
.ubp-vpool-seg button.on.f { background: var(--vpool-f-soft); color: var(--vpool-f); }
.ubp-vpool-seg button.on.m { background: var(--vpool-m-soft); color: var(--vpool-m); }
.ubp-vpool-seg button.on.n { background: var(--vpool-n-soft); color: var(--vpool-n); }
.ubp-vpool-eacts { display: flex; gap: 7px; align-items: center; margin-top: 9px; }
.ubp-vpool-eacts .spacer { flex: 1; }
.ubp-vpool-err { font-size: 11px; color: var(--ubp-danger); margin: 2px 0 6px 60px; line-height: 1.5; }
/* 底部动作 / 只读内置音色 / 说明 */
.ubp-vpool-add {
  width: calc(100% - 24px); margin: 9px 12px 0; height: 34px; border: 1px dashed var(--ubp-line);
  border-radius: 10px; background: transparent; color: var(--ubp-accent); font-size: 12.5px;
  font-family: var(--ubp-font); font-weight: 600; cursor: pointer;
}
.ubp-vpool-add:active { background: var(--ubp-accent-soft); }
.ubp-vpool-builtin { margin: 9px 12px 0; font-size: 11px; color: var(--ubp-text-3); }
.ubp-vpool-builtin summary { cursor: pointer; list-style: none; padding: 4px 0; }
.ubp-vpool-builtin summary::-webkit-details-marker { display: none; }
.ubp-vpool-builtin summary::before { content: '▸ '; color: var(--ubp-text-3); }
.ubp-vpool-builtin[open] summary::before { content: '▾ '; }
.ubp-vpool-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 3px 0 6px; }
.ubp-vpool-chips span {
  font-size: 10.5px; color: var(--ubp-text-2); background: var(--ubp-card-3); border-radius: 7px;
  padding: 2px 7px; font-family: ui-monospace, Menlo, Consolas, monospace;
}
.ubp-vpool-note { margin: 9px 12px 12px; font-size: 11px; color: var(--ubp-text-3); line-height: 1.65; }
.ubp-vpool-fetch { margin: 9px 12px 12px; }
.ubp-vpool-fetch .ubp-vfetch { margin: 0; }
/* 纯文本（批量编辑）态 */
.ubp-vpool-hint { margin: 10px 12px 0; font-size: 11px; color: var(--ubp-text-3); line-height: 1.65; }
.ubp-vpool-hint code {
  font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--ubp-text-2);
  background: var(--ubp-card-3); border-radius: 4px; padding: 0 4px;
}
.ubp-vpool-textarea {
  width: calc(100% - 24px); margin: 7px 12px 0; min-height: 266px; border: 1px solid var(--ubp-line);
  border-radius: 10px; background: var(--ubp-bg); color: var(--ubp-text); padding: 9px 10px;
  font-size: 11.5px; line-height: 1.8; font-family: ui-monospace, Menlo, Consolas, monospace;
  resize: none; outline: none;
}
.ubp-vpool-textarea:focus { border-color: var(--ubp-accent); }
.ubp-vpool-tfoot { display: flex; align-items: center; gap: 8px; margin: 9px 12px 12px; }
.ubp-vpool-count { flex: 1; font-size: 11px; color: var(--ubp-text-3); }
.ubp-vpool-warn {
  margin: 8px 12px 0; font-size: 11px; color: var(--ubp-warn); background: var(--ubp-warn-soft);
  border: 1px solid var(--ubp-warn-line); border-radius: 9px; padding: 6px 9px; line-height: 1.6;
}
/* 空池 */
.ubp-vpool-empty { padding: 16px 12px 14px; text-align: center; }
.ubp-vpool-empty .e1 { font-size: 13px; font-weight: 600; }
.ubp-vpool-empty .e2 { font-size: 11px; color: var(--ubp-text-3); margin-top: 5px; line-height: 1.65; }
.ubp-vpool-empty-acts { display: flex; gap: 8px; justify-content: center; margin: 12px 0 4px; flex-wrap: wrap; }

/* ── 转账 / 红包卡片（纯展示 + 记账预留） ── */
.ubp-card {
  display: flex; align-items: center; gap: 10px; min-width: 196px; max-width: 232px;
  border-radius: 11px; padding: 10px 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
  /* 定位上下文：卡里有两个 absolute 子元素——未拆红包的「開」（.ubp-rp-open）与拆包金币
     （.ubp-coin-fx，burstCoins 直接 append 到本元素）。缺这条时它们会一路找到 .ubp-chat
     去定位，飞到聊天区右侧中部；此前货币联动那段 CSS 从未生效，这个坑一直被盖着。 */
  position: relative;
}
.ubp-card.transfer { background: #F0A24B; color: #FFF8EE; }
.ubp-card.redpacket { background: #E05545; color: #FFEDE6; }
.ubp-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ubp-card-main b { font-size: 16.5px; font-weight: 600; line-height: 1.2; word-break: break-all; }
.ubp-card-main i { font-style: normal; font-size: 11px; opacity: 0.82; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-card-side { flex: none; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 10px; opacity: 0.9; }
.ubp-card-glyph {
  width: 30px; height: 30px; border-radius: 50%; background: rgba(255,255,255,0.22);
  display: flex; align-items: center; justify-content: center; font-size: 16px; font-style: normal; font-weight: 600;
}
.ubp-rp-icon {
  width: 30px; height: 30px; border-radius: 50%; background: rgba(255, 216, 92, 0.25);
  display: flex; align-items: center; justify-content: center;
}
.ubp-rp-icon svg { width: 17px; height: 17px; color: #FFD86B; }
.ubp-card-amt { flex: none; font-size: 12px; font-weight: 600; opacity: 0.95; }

/* ── 通用 chips（相机/相册筛选用） ── */
.ubp-chips { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.ubp-chip {
  border: 1px solid var(--ubp-line); background: var(--ubp-card-2); color: var(--ubp-text-2);
  border-radius: 14px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; font-family: var(--ubp-font);
  max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ubp-chip.on { background: var(--ubp-accent-soft); border-color: var(--ubp-accent); color: var(--ubp-accent); font-weight: 600; }
.ubp-hint { font-size: 11.5px; color: var(--ubp-text-3); line-height: 1.6; }

/* ── 相机 ── */
.ubp-cam-stage {
  min-height: 172px; margin: 12px 14px 0; border-radius: 14px; background: var(--ubp-card-2);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  overflow: hidden; padding: 10px;
}
.ubp-cam-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--ubp-text-3); font-size: 12.5px; padding: 18px 10px; text-align: center; }
.ubp-cam-empty svg { width: 34px; height: 34px; opacity: 0.6; }
.ubp-cam-pending { display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--ubp-text-2); font-size: 12px; text-align: center; padding: 22px 8px; }
.ubp-cam-preview { max-width: 100%; max-height: 300px; border-radius: 9px; object-fit: contain; cursor: zoom-in; }
.ubp-cam-actions { display: flex; gap: 9px; width: 100%; }
.ubp-cam-error { margin: 8px 16px 0; font-size: 12px; color: var(--ubp-danger); line-height: 1.6; }
.ubp-cam-form { padding: 4px 16px 16px; }
.ubp-cam-sec { font-size: 12px; color: var(--ubp-text-2); margin-top: 13px; }
.ubp-cam-sec b { color: var(--ubp-text); font-weight: 600; font-size: 12.5px; }
.ubp-cam-sec .ubp-textarea { margin-top: 8px; min-height: 58px; }
/* 「引用最新正文」开关行：标签 + 开关两端对齐 */
.ubp-cam-ctx-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ubp-cam-ctx-label { display: flex; flex-direction: column; gap: 2px; }
.ubp-cam-ctx-hint { font-size: 11px; color: var(--ubp-text-3); font-weight: 400; }
/* 相机表单汇总行：点开底部选择弹层的入口（替代 chips 墙） */
.ubp-cam-field {
  width: 100%; margin-top: 8px; display: flex; align-items: center; gap: 8px; text-align: left;
  border: 1px solid var(--ubp-line); border-radius: 9px; background: var(--ubp-bg);
  padding: 9px 11px; cursor: pointer; font-family: var(--ubp-font);
}
.ubp-cam-field:active { border-color: var(--ubp-accent); }
.ubp-cam-field-val { flex: 1; min-width: 0; font-size: 13px; color: var(--ubp-text); line-height: 1.5; word-break: break-all; }
.ubp-cam-field-val.placeholder { color: var(--ubp-text-3); }
.ubp-cam-field-more { flex: none; color: var(--ubp-text-3); font-size: 15px; }
.ubp-cam-field-hint { margin-top: 6px; font-size: 11px; color: var(--ubp-text-3); line-height: 1.5; }
.ubp-cam-shutter { width: 100%; margin-top: 16px; height: 44px; font-size: 15px; border-radius: 12px; }
.ubp-cam-shutter:disabled { opacity: 0.45; cursor: default; }

/* ── 幻想浏览器 APP（第八轮 §5 · N8：五态） ── */
.ubp-br-urlbar {
  flex: none; padding: 6px 14px; font-size: 11.5px; color: var(--ubp-text-3);
  background: var(--ubp-card-2); border-bottom: 1px solid var(--ubp-line);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.ubp-br-hero { padding: 26px 18px 12px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.ubp-br-logo { display: flex; align-items: center; gap: 9px; color: var(--ubp-accent); font-size: 22px; font-weight: 700; }
.ubp-br-logo svg { width: 26px; height: 26px; }
.ubp-br-search { display: flex; gap: 8px; width: 100%; }
.ubp-br-search .ubp-fieldinput { flex: 1; }
.ubp-br-search .ubp-btn { flex: none; padding: 0 16px; height: 38px; }
.ubp-br-hint { font-size: 11.5px; color: var(--ubp-text-3); text-align: center; line-height: 1.7; }
.ubp-br-history { padding: 4px 0 12px; }
.ubp-br-hd { padding: 10px 14px 6px; font-size: 11.5px; color: var(--ubp-text-3); }
.ubp-br-hrow {
  display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer;
  border-bottom: 1px solid var(--ubp-line);
}
.ubp-br-hrow:active { background: var(--ubp-card-2); }
.ubp-br-hrow > svg { width: 16px; height: 16px; color: var(--ubp-text-3); flex: none; }
.ubp-br-hmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ubp-br-hmain b { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-br-hmain .t { font-size: 11px; color: var(--ubp-text-3); }
.ubp-br-loading { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 60px 20px; color: var(--ubp-text-2); font-size: 13px; }
.ubp-br-error { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 52px 22px; text-align: center; }
.ubp-br-error b { font-size: 15px; }
.ubp-br-error p { margin: 0; font-size: 12.5px; color: var(--ubp-text-2); line-height: 1.7; }
.ubp-br-querybar { display: flex; align-items: baseline; gap: 8px; padding: 12px 14px 6px; }
.ubp-br-querybar .q { font-size: 15px; font-weight: 700; }
.ubp-br-querybar .n { font-size: 11.5px; color: var(--ubp-text-3); }
.ubp-br-results { padding: 0 0 12px; }
.ubp-br-card { padding: 11px 14px; border-bottom: 1px solid var(--ubp-line); cursor: pointer; }
.ubp-br-card:active { background: var(--ubp-card-2); }
/* 卡头：站点徽记 + 站名 + 伪地址（真机搜索结果的「favicon + 来源 + 地址」头行形态） */
.ubp-br-card-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
/* 站点徽记（徽+色，第十轮）：一枚取站点主题色的圆角色块，里写 1 个字——不同站点一眼分得开 */
.ubp-br-card-mark { flex: none; width: 17px; height: 17px; border-radius: 4.5px; background: var(--ubp-accent); color: #fff; font-size: 10px; line-height: 17px; text-align: center; font-weight: 700; overflow: hidden; }
.ubp-br-card-site { flex: none; max-width: 52%; font-size: 11px; font-weight: 600; color: var(--ubp-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-br-card-site::before { content: ""; display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: var(--ubp-accent); margin-right: 5px; vertical-align: 1.5px; }
/* 有徽记时不再点小圆点（两枚色块挨在一起会打架） */
.ubp-br-card-head.has-mark .ubp-br-card-site::before { display: none; }
.ubp-br-card-url { flex: 1; min-width: 0; font-size: 11px; color: var(--ubp-text-3); font-family: ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-br-card-title { font-size: 15px; font-weight: 600; color: var(--ubp-accent); margin-top: 3px; line-height: 1.45; }
.ubp-br-card-preview { font-size: 12.5px; color: var(--ubp-text-2); margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.6; }
/* 详情（第十轮主路径）：一整张 AI 自绘网页跑在沙箱画布里，铺满 App 主体，页面自己滚动。
   前端在这里只给画布尺寸——页面的色板/字体/版式全在 AI 自己的 <style> 里。 */
.ubp-br-frame { flex: 1; width: 100%; min-height: 0; border: 0; display: block; background: #fff; }
/* 详情（降级路径 · 旧档）：白名单 markdown 排版——站点眉（顶栏）→ 标题 → 署名行 → 正文 */
.ubp-br-doc { padding: 12px 16px 26px; }
.ubp-br-doc-site { display: flex; align-items: center; gap: 7px; padding-bottom: 9px; border-bottom: 1px solid var(--ubp-line); font-size: 11.5px; font-weight: 600; color: var(--ubp-text-2); letter-spacing: 0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-br-doc-dot { flex: none; width: 8px; height: 8px; border-radius: 2.5px; background: var(--ubp-accent); }
.ubp-br-doc-title { font-size: 20px; line-height: 1.42; margin: 12px 0 6px; }
.ubp-br-doc-src { font-size: 11.5px; color: var(--ubp-text-3); line-height: 1.6; padding-bottom: 10px; border-bottom: 1px solid var(--ubp-line); }
.ubp-br-doc-body { margin-top: 14px; font-size: 14.5px; line-height: 1.85; color: var(--ubp-text); word-break: break-word; }
.ubp-br-doc-body h2 { font-size: 16.5px; margin: 18px 0 8px; }
.ubp-br-doc-body h3 { font-size: 15px; margin: 14px 0 6px; }
.ubp-br-doc-body p { margin: 0 0 12px; }
.ubp-br-doc-body ul { margin: 0 0 12px; padding-left: 20px; }
.ubp-br-doc-body li { margin: 4px 0; }
/* 引文块（> 引文）：左竖线 + 浅底——真机新闻页的引语形态 */
.ubp-br-doc-body blockquote { margin: 0 0 12px; padding: 9px 12px; border-left: 3px solid var(--ubp-accent); background: var(--ubp-card-2); border-radius: 0 8px 8px 0; color: var(--ubp-text-2); font-size: 13.5px; line-height: 1.75; }
/* 配图位（[图：…]）：虚线占位 + 图注（AI 编不出真图，占位要「像一张图」而不是像报错） */
.ubp-br-fig { margin: 0 0 14px; }
.ubp-br-fig-ph { display: block; width: 100%; height: 122px; border-radius: 10px; background: var(--ubp-card-2); border: 1px dashed var(--ubp-line); position: relative; }
.ubp-br-fig-ph::after {
  content: ""; position: absolute; inset: 0; margin: auto; width: 30px; height: 30px;
  background: var(--ubp-text-3); opacity: 0.5;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4.5' width='18' height='15' rx='2.5'/%3E%3Ccircle cx='8.6' cy='9.6' r='1.5'/%3E%3Cpath d='M3.8 17.4l4.8-4.3 3.4 3 3-2.6 5.2 4.4'/%3E%3C/svg%3E") center / 30px 30px no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4.5' width='18' height='15' rx='2.5'/%3E%3Ccircle cx='8.6' cy='9.6' r='1.5'/%3E%3Cpath d='M3.8 17.4l4.8-4.3 3.4 3 3-2.6 5.2 4.4'/%3E%3C/svg%3E") center / 30px 30px no-repeat;
}
.ubp-br-fig figcaption { margin-top: 6px; font-size: 11.5px; color: var(--ubp-text-3); line-height: 1.6; text-align: center; }
/* 话题签（#标签） */
.ubp-br-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 12px; }
.ubp-br-tag { font-size: 11.5px; color: var(--ubp-link); background: var(--ubp-card-2); padding: 2.5px 9px; border-radius: 999px; }
/* 分隔线（---） */
.ubp-br-hr { border: none; border-top: 1px solid var(--ubp-line); margin: 16px 0; }

/* 链接卡（type='link'：浏览器分享到微信）——第十一轮照真机分享卡重排：
   标题(2行) / 摘要(3行) / 缩略块(徽+色) / 来源行(链条符+站名，链接蓝)；**整卡可点** ⇒ 回跳浏览器那一页。
   卡里不再展示等宽伪地址（伪地址在上方地址栏里可见，不丢信息，只是不再长得像调试信息）。
   来源行用 --ubp-link（微信自己的链接蓝）而不是真机的灰：这是「这是一条可点的超链接」的最强信号。 */
.ubp-link-card {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px;
  padding: 10px 12px; min-width: 200px; max-width: 246px;
  background: var(--ubp-bubble-other); color: var(--ubp-text);
  border: none; border-radius: 11px; text-align: left; cursor: pointer;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05); font-family: var(--ubp-font);
}
.ubp-msg-row.me .ubp-link-card { background: var(--ubp-bubble-me); color: var(--ubp-bubble-me-text); }
.ubp-link-card:active { filter: brightness(0.97); }
.ubp-link-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ubp-link-title { font-size: 14px; font-weight: 600; line-height: 1.42; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ubp-link-preview { font-size: 11.5px; opacity: 0.74; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.55; }
/* 页面描述（desc）比搜索预览长，放宽到三行 */
.ubp-link-preview.ubp-link-desc { -webkit-line-clamp: 3; }
/* 缩略块=站点徽记「徽」压主题色「色」（真机卡右上那枚配图位；无徽记的旧卡不渲染这块）。
   墨色由 tintInk 按底色亮度选黑/白（AI 选什么色都读得清），缺省走灰块形态。 */
.ubp-link-thumb {
  flex: none; width: 46px; height: 46px; border-radius: 5px; overflow: hidden;
  background: var(--ubp-card-2); color: var(--ubp-text-3);
  display: flex; align-items: center; justify-content: center; font-size: 19px; font-weight: 700;
}
.ubp-link-src { flex-basis: 100%; display: flex; align-items: center; gap: 5px; min-width: 0; font-size: 11.5px; color: var(--ubp-link); }
.ubp-link-src svg { width: 12px; height: 12px; flex: none; }
.ubp-link-src b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 微信「我的收藏」（第八轮 §4 · A2：文本/图片/语音/卡片 四类） ── */
.ubp-fav-chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 10px 14px 8px; }
.ubp-fav-row { display: flex; gap: 9px; padding: 11px 14px; border-bottom: 1px solid var(--ubp-line); cursor: pointer; }
.ubp-fav-row:active { background: var(--ubp-card-2); }
.ubp-fav-ic {
  flex: none; width: 34px; height: 34px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  background: var(--ubp-card-2); color: var(--ubp-text-2);
}
.ubp-fav-ic svg { width: 16px; height: 16px; }
.ubp-fav-ic.txt { background: rgba(52, 199, 89, 0.12); color: #1E9E4A; }
.ubp-fav-ic.img { background: rgba(192, 98, 158, 0.12); color: #A04E86; }
.ubp-fav-ic.voc { background: rgba(90, 120, 200, 0.12); color: #4A66B0; }
.ubp-fav-ic.crd { background: rgba(214, 158, 46, 0.14); color: #A97B1C; }
/* F61(第十二轮)：深色下四个类型色对比度不足 3:1（深底 ≈2.7–3.5:1）——照 .ubp-nc-todo-day 范式补亮一档 */
.ubp-dark .ubp-fav-ic.txt { background: rgba(52, 199, 89, 0.18); color: #4CD07D; }
.ubp-dark .ubp-fav-ic.img { background: rgba(192, 98, 158, 0.18); color: #E48BC0; }
.ubp-dark .ubp-fav-ic.voc { background: rgba(90, 120, 200, 0.20); color: #8FA8F0; }
.ubp-dark .ubp-fav-ic.crd { background: rgba(214, 158, 46, 0.20); color: #E0B04A; }
.ubp-fav-main { flex: 1; min-width: 0; }
.ubp-fav-main b { display: block; font-size: 13px; font-weight: 600; color: var(--ubp-text-2); }
.ubp-fav-main .tx {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 13.5px; color: var(--ubp-text); margin-top: 1px; line-height: 1.55;
}
.ubp-fav-main .tm { display: block; font-size: 11px; color: var(--ubp-text-3); margin-top: 3px; }
.ubp-fav-thumb { flex: none; width: 44px; height: 44px; border-radius: 8px; object-fit: cover; }
.ubp-fav-play {
  flex: none; align-self: center; width: 34px; height: 34px; border: none; border-radius: 50%;
  background: var(--ubp-accent-soft); color: var(--ubp-accent);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.ubp-fav-play svg { width: 15px; height: 15px; }
.ubp-fav-play.playing { background: var(--ubp-accent); color: #fff; }

/* ── 录音机 APP（第八轮 §1 · N3：语音收藏 / 缓存 两页签） ── */
.ubp-rec-row {
  display: flex; align-items: center; gap: 10px; padding: 11px 14px;
  border-bottom: 1px solid var(--ubp-line); cursor: pointer;
}
.ubp-rec-row:active { background: var(--ubp-card-2); }
.ubp-rec-row .ubp-avatar { width: 36px; height: 36px; border-radius: 9px; flex: none; }
.ubp-rec-main { flex: 1; min-width: 0; }
.ubp-rec-main b { display: block; font-size: 15px; font-weight: 600; }
.ubp-rec-main .tx {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 13px; color: var(--ubp-text-2); margin-top: 2px; line-height: 1.5;
}
.ubp-rec-main .m { display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.ubp-rec-main .m .t { font-size: 11px; color: var(--ubp-text-3); }
.ubp-rec-play {
  flex: none; width: 38px; height: 38px; border: none; border-radius: 50%;
  background: var(--ubp-accent-soft); color: var(--ubp-accent);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.ubp-rec-play svg { width: 16px; height: 16px; }
.ubp-rec-play.playing { background: var(--ubp-accent); color: #fff; }

/* ── 底部选择弹层（picker-sheet：搜索 + 分组吸顶 + 行内选中态） ── */
/* z-index 65 必须压过发帖面板（.ubp-mo-composer z-60，从面板内打开的子弹层） */
.ubp-picker-sheet { z-index: 65; align-items: flex-end; padding: 0; }
.ubp-picker-sheet .ubp-sheet {
  max-width: 100%; max-height: 84%; border-radius: 16px 16px 0 0;
  display: flex; flex-direction: column; padding: 13px 0 9px; overflow: hidden;
}
/* C 抽屉统一头部（左标题 + 右上 ✕）：picker / 选图 / 取景共用（ED-03） */
.ubp-sheet-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 2px 2px 9px; }
.ubp-sheet-headtitle { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; }
.ubp-sheet-x {
  flex: none; width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent;
  color: var(--ubp-text-3); font-size: 14px; font-family: inherit; cursor: pointer; line-height: 1;
}
.ubp-sheet-x:active { background: var(--ubp-card-2); }
.ubp-picker-search { margin: 0 13px 9px; flex: none; width: auto; } /* width:auto：flex 拉伸扣除边距，避免 100%+margin 溢出 */
.ubp-picker-list {
  flex: 1; min-height: 140px; overflow-y: auto; overscroll-behavior: contain;
  border-top: 1px solid var(--ubp-line);
}
.ubp-picker-group {
  position: sticky; top: 0; z-index: 2; padding: 5px 14px;
  font-size: 11px; color: var(--ubp-text-2); background: var(--ubp-card-2);
}
.ubp-picker-row {
  display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer;
  border-bottom: 1px solid var(--ubp-line); background: var(--ubp-card);
}
.ubp-picker-row:active { background: var(--ubp-card-2); }
.ubp-picker-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ubp-picker-label { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-picker-label.placeholder { color: var(--ubp-text-3); font-weight: 400; }
.ubp-picker-sub {
  font-size: 11.5px; color: var(--ubp-text-2); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.ubp-picker-foot {
  flex: none; display: flex; align-items: center; gap: 9px;
  padding: 9px 13px 2px; border-top: 1px solid var(--ubp-line);
}
.ubp-picker-count { flex: none; font-size: 12px; color: var(--ubp-text-2); white-space: nowrap; }
.ubp-picker-foot .ubp-btn { flex: 1; height: 36px; font-size: 13.5px; }
/* 全选/全不选（multi + selectAll；作用域=当前筛出来的行）：定宽小钮，不跟取消/确认抢宽度 */
.ubp-picker-all {
  flex: none; height: 36px; padding: 0 13px; border: none; border-radius: 10px;
  background: var(--ubp-card-2); color: var(--ubp-accent);
  font-size: 13.5px; font-weight: 600; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-picker-all:active { filter: brightness(0.92); }
/* 顶部工具条（可选；音色面板的「渠道」下拉）：换一套选项用，换完由 picker 重取 groups + 重画列表。
   下拉本体复用 .ubp-select（连 max-width:100% 的行内覆盖都与设置页同款），这里只管排版与说明行。 */
.ubp-picker-toolbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 13px 9px; }
.ubp-tblabel { flex: none; font-size: 12.5px; color: var(--ubp-text-2); }
/* 「翻的是别家」时的说明条：整条换行占满一行（点下面任一音色＝把这个角色改到这家） */
.ubp-picker-note { flex: 0 0 100%; font-size: 11.5px; line-height: 1.55; color: var(--ubp-text-3); }
/* 行内小动作（可选；音色面板的「▷ 试听」）：不改选择、不关面板。合成/播放期间加 .busy 呼吸——
   API 首句要等 1~3 秒，没有这个反馈用户会以为没点上而连点。 */
.ubp-picker-iact {
  flex: none; width: 30px; height: 30px; border: none; border-radius: 9px; background: transparent;
  color: var(--ubp-accent); cursor: pointer; font-family: var(--ubp-font);
  display: flex; align-items: center; justify-content: center;
}
.ubp-picker-iact svg { width: 17px; height: 17px; }
.ubp-picker-iact:active { background: var(--ubp-card-2); }
.ubp-picker-iact.busy { color: var(--ubp-text-3); animation: ubp-iact-pulse 0.9s ease-in-out infinite; }
@keyframes ubp-iact-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
/* 「再拉一页」列表尾部行（分页拉取；拉尽换成 .ubp-picker-end 的「已到底」） */
.ubp-picker-more {
  display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%;
  padding: 12px 14px; border: none; border-top: 1px dashed var(--ubp-line);
  background: var(--ubp-card); color: var(--ubp-accent);
  font-size: 13.5px; font-weight: 600; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-picker-more:active { background: var(--ubp-card-2); }
.ubp-picker-more:disabled { color: var(--ubp-text-3); cursor: default; }
.ubp-picker-more .ubp-spinner { width: 13px; height: 13px; border-width: 1.6px; }
.ubp-picker-end { padding: 12px 14px; text-align: center; color: var(--ubp-text-3); font-size: 11.5px; }
.ubp-picker-empty { padding: 34px 20px; text-align: center; color: var(--ubp-text-3); font-size: 12.5px; line-height: 1.7; white-space: pre-line; }
.ubp-picker-loading {
  display: flex; align-items: center; justify-content: center; gap: 9px;
  padding: 34px 20px; color: var(--ubp-text-3); font-size: 12.5px;
}

/* ── 统一选图弹层（小手机全部选图入口共用：发图/配图/头像/背景/封面/壁纸；网格复用 .ubp-album-grid） ── */
.ubp-imgpick-sheet { z-index: 65; align-items: flex-end; padding: 0; }
.ubp-imgpick-sheet .ubp-sheet {
  max-width: 100%; max-height: 78%; border-radius: 16px 16px 0 0;
  display: flex; flex-direction: column; padding: 13px 0 11px; overflow: hidden;
}
/* 内容区工具行（ED-03：调整取景/恢复默认/导入 从页脚移入内容，页脚只留 取消|完成） */
.ubp-ip-tools { flex: none; display: flex; gap: 7px; padding: 0 13px 9px; }
.ubp-ip-tool {
  flex: 1; height: 30px; border: 1px solid var(--ubp-line); border-radius: 9px; background: transparent;
  color: var(--ubp-text-2); font-size: 12px; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-ip-tool:active { background: var(--ubp-card-2); }
.ubp-ip-cur { flex: none; display: flex; align-items: center; gap: 10px; padding: 0 15px 10px; }
.ubp-ip-cur img { width: 64px; height: 42px; object-fit: cover; border-radius: 8px; display: block; flex: none; }
.ubp-ip-none { font-size: 11px; color: var(--ubp-text-3); background: var(--ubp-card-2); border-radius: 6px; padding: 9px 13px; flex: none; }
.ubp-ip-curname { font-size: 12px; color: var(--ubp-text-2); }
.ubp-iptabs { flex: none; display: flex; gap: 6px; margin: 0 13px 9px; }
.ubp-iptab {
  flex: 1; height: 30px; border: none; border-radius: 8px; cursor: pointer; padding: 0;
  background: var(--ubp-card-2); color: var(--ubp-text-2);
  font-size: 12.5px; font-family: var(--ubp-font);
}
.ubp-iptab.on { background: var(--ubp-accent-soft); color: var(--ubp-accent); font-weight: 600; }
.ubp-ip-chips { flex: none; display: flex; flex-wrap: wrap; gap: 7px; padding: 0 13px 9px; }
.ubp-ip-chips .ubp-chip { margin: 0; }
.ubp-ip-body {
  flex: 1; min-height: 120px; overflow-y: auto; overscroll-behavior: contain;
  border-top: 1px solid var(--ubp-line);
}
.ubp-ip-body .ubp-album-grid { padding: 8px 10px 4px; }
.ubp-ip-note { font-size: 11px; color: var(--ubp-text-3); line-height: 1.5; padding: 9px 14px 0; }
.ubp-ip-empty { padding: 30px 20px; text-align: center; color: var(--ubp-text-3); font-size: 12.5px; line-height: 1.7; }
.ubp-imgpick-sheet .ubp-sheet-err { padding: 0 13px; }
.ubp-imgpick-sheet .ubp-sheet-actions { flex: none; margin-top: 10px; padding: 0 13px; }
.ubp-imgpick-sheet .ubp-sheet-actions .ubp-btn { flex: 1; height: 36px; font-size: 13.5px; }

/* ── 取景弹层（docs/13：非破坏性取景，全部换图流程共用；预览=最终显示位同一份样式口径） ── */
.ubp-crop-sheet { z-index: 66; align-items: flex-end; padding: 0; }
.ubp-crop-sheet .ubp-sheet { padding-bottom: 12px; }
.ubp-crop-box {
  position: relative; margin: 6px auto 12px; width: min(86%, 300px);
  max-height: 300px; overflow: hidden; border-radius: 12px; background: var(--ubp-card-2);
  touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none;
}
.ubp-crop-box:active { cursor: grabbing; }
/* 媒体层尺寸/位移全部来自内联样式（.ubp-crop-media 见上，与显示位同一份口径） */
.ubp-crop-box .ubp-crop-media { z-index: 1; }
.ubp-crop-row { display: flex; align-items: center; gap: 10px; margin: 0 13px 10px; font-size: 13px; color: var(--ubp-text-2); }
.ubp-crop-row input[type="range"] { flex: 1; accent-color: var(--ubp-accent); }
.ubp-crop-zoomval { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
.ubp-crop-tools { display: flex; gap: 8px; margin: 0 13px 10px; }
.ubp-crop-tools .ubp-btn { flex: 1; height: 34px; font-size: 13.5px; }

/* ── 相册 ── */
.ubp-album-filters { padding: 10px 14px 4px; background: var(--ubp-card); border-bottom: 1px solid var(--ubp-line); }
.ubp-album-filters .ubp-chips { margin-top: 0; margin-bottom: 8px; }
.ubp-album-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 6px 8px 16px;
}
.ubp-album-cell {
  position: relative; aspect-ratio: 1; padding: 0; border: none; border-radius: 7px;
  overflow: hidden; cursor: pointer; background: var(--ubp-card-2);
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; /* 长按＝批量删除手势，压住系统图片菜单/选中 */
}
.ubp-album-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ubp-album-cell:active { filter: brightness(0.88); }
/* 批量删除选中态：复用 .ubp-msg-check 圆形勾选框（绝对定位于格子右上），picked 加描边 + 压暗底图 */
.ubp-album-cell .ubp-msg-check { position: absolute; top: 5px; right: 5px; margin: 0; align-self: auto; }
.ubp-album-cell.picked { outline: 2px solid var(--ubp-accent); outline-offset: -2px; }
.ubp-album-cell.picked img { filter: brightness(0.72); }
.ubp-album-src {
  position: absolute; top: 5px; left: 5px; font-size: 9.5px; line-height: 1;
  background: rgba(0, 0, 0, 0.5); color: #fff; border-radius: 4px; padding: 3px 5px;
}
.ubp-album-chars {
  position: absolute; bottom: 0; left: 0; right: 0; font-size: 10px; line-height: 1.4;
  background: rgba(0, 0, 0, 0.45); color: #fff; padding: 2px 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left;
}
/* 收藏角标（相册网格与统一选图弹层共用）：右上角深底金星；批量模式下让位给勾选框（不渲染） */
.ubp-album-fav {
  position: absolute; top: 5px; right: 5px; width: 18px; height: 18px; border-radius: 50%;
  background: rgba(0, 0, 0, 0.5); color: #ffc93c;
  display: flex; align-items: center; justify-content: center;
}
.ubp-album-fav svg { width: 12px; height: 12px; fill: currentColor; }
.ubp-album-detail-img { width: 100%; max-height: 260px; object-fit: contain; border-radius: 9px; background: var(--ubp-card-2); }
.ubp-album-meta { margin-top: 10px; }
/* F92：详情参数拆 chips（provider/model/分辨率普通档，seed/steps/cfg dim 档）+ 标题计数签 */
.ubp-album-meta .al-chip { display: inline-block; padding: 0 6px; margin-right: 3px; border-radius: 5px; font-size: 10.5px; background: var(--ubp-accent-soft); color: var(--ubp-accent); }
.ubp-album-meta .al-chip.num { font-variant-numeric: tabular-nums; }
.ubp-album-meta .al-chip.dim { color: var(--ubp-text-3); background: var(--ubp-card-3); }
.ubp-appbar-title .al-count { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 5px; margin-left: 6px; border-radius: 99px; font-size: 10px; font-weight: 400; background: var(--ubp-card-3); color: var(--ubp-text-2); font-variant-numeric: tabular-nums; }
.ubp-album-prompt { font-size: 11.5px; color: var(--ubp-text-2); margin-top: 6px; }
.ubp-album-prompt summary { cursor: pointer; color: var(--ubp-text-2); font-weight: 600; }
.ubp-album-prompt div { margin-top: 5px; line-height: 1.55; word-break: break-all; max-height: 130px; overflow-y: auto; }
/* 标签编辑 + 收藏：同一行两钮（详情弹层已 4 钮，第 5 钮会挤），弹层内缩略图 + 双向文本域 */
.ubp-album-editrow { display: flex; gap: 8px; margin-top: 11px; }
.ubp-album-editbtn { width: 100%; margin-top: 11px; }
.ubp-album-editrow .ubp-album-editbtn { width: auto; flex: 1; margin-top: 0; }
.ubp-album-favbtn { flex: none; min-width: 96px; }
.ubp-album-favbtn.on { background: var(--ubp-accent-soft); color: var(--ubp-accent); font-weight: 600; }
.ubp-album-edit-sheet { max-width: 320px; }
.ubp-album-edit-thumb {
  width: 100%; max-height: 120px; object-fit: contain; border-radius: 9px;
  background: var(--ubp-card-2); margin-bottom: 10px;
}
.ubp-album-edit-label { font-size: 12px; font-weight: 600; color: var(--ubp-text-2); margin: 9px 0 5px; }
.ubp-album-edit-ta { min-height: 88px; font-size: 12px; line-height: 1.5; }
.ubp-album-edit-ta-sm { min-height: 52px; }
.ubp-album-edit-hint { font-size: 11px; color: var(--ubp-text-3); line-height: 1.55; margin-top: 9px; }
.ubp-album-pick { display: flex; flex-direction: column; gap: 8px; max-height: 44vh; overflow-y: auto; margin: 2px 0 4px; }

/* ── 电话 · 通话记录/通讯录/详情 ── */
.ubp-cl-row {
  display: flex; align-items: center; gap: 11px; padding: 10px 14px; cursor: pointer;
  border-bottom: 1px solid var(--ubp-line); background: var(--ubp-card);
}
.ubp-cl-row:active { background: var(--ubp-card-2); }
.ubp-cl-row.missed .ubp-wx-title { color: var(--ubp-danger); }
.ubp-cl-avatar {
  width: 44px; height: 44px; border-radius: 50%; flex: none; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 600;
  overflow: hidden;
}
.ubp-cl-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ubp-cl-st { display: flex; align-items: center; justify-content: flex-end; }
.ubp-cl-st svg { width: 16px; height: 16px; }
.ubp-cl-st.st-answered { color: var(--cl-acc); }
.ubp-cl-st.st-rejected { color: var(--ubp-danger); }
.ubp-cl-st.st-cancelled { color: var(--ubp-text-3); }
.ubp-cl-st.st-missed { color: var(--ubp-danger); }
.ubp-cl-searchbar {
  flex: none; display: flex; align-items: center; gap: 7px; margin: 10px 14px;
  padding: 0 10px; height: 34px; border-radius: 9px;
  background: var(--ubp-card-2); border: 1px solid var(--ubp-line); color: var(--ubp-text-3);
}
.ubp-cl-searchbar svg { width: 15px; height: 15px; flex: none; }
.ubp-cl-searchbar input {
  flex: 1; min-width: 0; border: none; background: transparent; color: var(--ubp-text);
  font-size: 13.5px; font-family: var(--ubp-font); outline: none; height: 100%;
}
.ubp-cl-dial {
  flex: none; width: 30px; height: 30px; border-radius: 50%; border: none; cursor: pointer; padding: 0;
  background: var(--ubp-accent-soft); color: var(--ubp-accent);
  display: flex; align-items: center; justify-content: center;
}
.ubp-cl-dial:active { filter: brightness(0.88); }
.ubp-cl-dial svg { width: 15px; height: 15px; }
.ubp-cl-sum {
  display: flex; align-items: center; gap: 11px; margin: 12px 14px 0; padding: 11px 13px;
  background: var(--ubp-card); border-radius: 12px;
}
.ubp-cl-sum-icon {
  width: 34px; height: 34px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
}
.ubp-cl-sum-icon svg { width: 17px; height: 17px; }
.ubp-cl-sum.st-answered .ubp-cl-sum-icon { background: var(--ubp-accent-soft); color: var(--ubp-accent); }
.ubp-cl-sum.st-rejected .ubp-cl-sum-icon { background: var(--ubp-danger-soft); color: var(--ubp-danger); }
.ubp-cl-sum.st-cancelled .ubp-cl-sum-icon { background: var(--ubp-card-2); color: var(--ubp-text-3); }
.ubp-cl-sum.st-missed .ubp-cl-sum-icon { background: var(--ubp-danger-soft); color: var(--ubp-danger); }
.ubp-cl-sum-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ubp-cl-sum-main b { font-size: 14px; font-weight: 600; }
.ubp-cl-sum-main i { font-style: normal; font-size: 11.5px; color: var(--ubp-text-3); }
.ubp-cl-thought {
  margin: 10px 14px 0; padding: 9px 12px; font-size: 12px; line-height: 1.6;
  color: var(--ubp-text-2); font-style: italic; background: var(--ubp-card-2); border-radius: 10px;
}
.ubp-cl-actions {
  flex: none; display: flex; gap: 9px; padding: 9px 14px 10px;
  background: var(--ubp-card); border-top: 1px solid var(--ubp-line);
}

/* ── 电话 · 语音留言（T1）与整段连播（T2） ── */
/* 记录行预览里的「留言 0:14」胶囊：未听=红系，已听变灰（稿 .mockup/r8-voicemail.html） */
.ubp-cl-vmchip {
  display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; padding: 0 7px 0 5px; height: 17px;
  border-radius: 999px; background: var(--ubp-danger-soft); color: var(--ubp-danger);
  font-size: 11px; font-weight: 600; vertical-align: -3px;
}
.ubp-cl-vmchip svg { width: 11px; height: 11px; flex: none; }
.ubp-cl-vmchip.read { background: var(--ubp-card-3); color: var(--ubp-text-3); }
/* 记录行未听红点（播放过即消，不落库以外的状态） */
.ubp-cl-newdot { width: 8px; height: 8px; border-radius: 50%; background: var(--ubp-badge); flex: none; }
/* 留言卡（详情页）：警示橙系（与日程提醒同族）；逐行「彩标+演绎 → 文本」 */
.ubp-cl-vm {
  margin: 10px 14px 0; border-radius: 13px; border: 1px solid var(--ubp-warn-line);
  background: var(--ubp-warn-soft); overflow: hidden;
}
.ubp-cl-vm-hd {
  display: flex; align-items: center; gap: 7px; padding: 10px 12px 0;
  color: var(--ubp-warn); font-size: 13px; font-weight: 700;
}
.ubp-cl-vm-hd svg { width: 14px; height: 14px; flex: none; }
.ubp-cl-vm-hd .t { color: var(--ubp-text-3); font-weight: 400; font-size: 11px; font-variant-numeric: tabular-nums; }
.ubp-cl-vm-play {
  margin-left: auto; display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 12px 0 10px;
  border: none; border-radius: 999px; background: var(--ubp-warn); color: #fff;
  font-size: 12px; font-weight: 600; font-family: var(--ubp-font); cursor: pointer; flex: none;
}
.ubp-cl-vm-play svg { width: 13px; height: 13px; }
.ubp-cl-vm-play:active { filter: brightness(0.9); }
.ubp-cl-vm-play:disabled { opacity: 0.5; cursor: default; }
.ubp-cl-vm-bd { padding: 9px 12px 11px; }
.ubp-cl-vm-line + .ubp-cl-vm-line { margin-top: 8px; }
.ubp-cl-vm-line .ubp-vmeta { margin-bottom: 4px; }
.ubp-cl-vm-txt { display: block; font-size: 14px; line-height: 1.6; color: var(--ubp-text); }
/* 整段连播条（T2）：摘要卡下的动作行（按钮状态随连播切换） */
.ubp-cl-replayall { margin: 10px 14px 0; display: flex; align-items: center; gap: 8px; }
.ubp-cl-replayall .ubp-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.ubp-cl-replayall .ubp-btn svg { width: 14px; height: 14px; }
.ubp-cl-replayall .cnt { flex: none; font-size: 11px; color: var(--ubp-text-3); font-variant-numeric: tabular-nums; }

/* ── 电话 · 拨号盘 ── */
.ubp-dialer { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; }
.ubp-dialer-display { flex: 1; min-height: 64px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 10px 20px; }
.ubp-dialer-input {
  width: 100%; max-width: 250px; border: none; background: transparent; color: var(--ubp-text);
  font-size: 26px; font-weight: 300; letter-spacing: 2px; text-align: center;
  font-family: var(--ubp-font); outline: none;
}
.ubp-dialer-input::placeholder { font-size: 14px; letter-spacing: 0; color: var(--ubp-text-3); font-weight: 400; }
.ubp-dialer-match {
  font-size: 13px; color: var(--ubp-accent); min-height: 18px; text-align: center; max-width: 100%;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  max-height: 112px; overflow-y: auto; overscroll-behavior: contain;
}
.ubp-dialer-match i { font-style: normal; color: var(--ubp-text-3); font-size: 11.5px; }
.ubp-dialer-hit {
  flex: none; border: none; background: transparent; cursor: pointer; padding: 3px 10px; border-radius: 8px;
  display: flex; align-items: baseline; gap: 7px; max-width: 100%;
  font-family: var(--ubp-font); font-size: 13px; color: var(--ubp-accent);
}
.ubp-dialer-hit:active { background: var(--ubp-card-2); }
.ubp-dialer-hit b { font-weight: 600; color: var(--ubp-text); white-space: nowrap; }
.ubp-dialer-hit i { font-style: normal; color: var(--ubp-text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ubp-dialer-nomatch { color: var(--ubp-text-3); }
.ubp-dialer-pad {
  flex: none; display: grid; grid-template-columns: repeat(3, 68px); gap: 13px 0;
  justify-content: center; padding: 6px 0;
}
.ubp-dial-key {
  width: 68px; height: 68px; border-radius: 50%; border: none; cursor: pointer;
  background: var(--ubp-card-2); color: var(--ubp-text);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  font-family: var(--ubp-font); transition: transform 0.08s ease;
}
.ubp-dial-key:active { transform: scale(0.9); background: var(--ubp-line); }
.ubp-dial-key b { font-size: 24px; font-weight: 500; line-height: 1.1; }
.ubp-dial-key i { font-style: normal; font-size: 9px; letter-spacing: 1.5px; color: var(--ubp-text-3); min-height: 11px; }
.ubp-dialer-actions {
  flex: none; display: grid; grid-template-columns: repeat(3, 68px); gap: 13px 0;
  justify-content: center; align-items: center; padding: 14px 0 12px;
}
.ubp-dialer-call {
  width: 68px; height: 68px; border-radius: 50%; border: none; cursor: pointer;
  background: var(--ubp-accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 12px rgba(7, 193, 96, 0.35); transition: transform 0.08s ease;
}
.ubp-dialer-call:active { transform: scale(0.92); }
.ubp-dialer-call:disabled { opacity: 0.35; cursor: default; box-shadow: none; }
.ubp-dialer-call svg { width: 27px; height: 27px; transform: rotate(-12deg); }
.ubp-dialer-del {
  width: 44px; height: 44px; border-radius: 50%; border: none; background: transparent; cursor: pointer;
  color: var(--ubp-text-2); display: flex; align-items: center; justify-content: center; justify-self: center;
}
.ubp-dialer-del:active { background: var(--ubp-card-2); }
.ubp-dialer-del svg { width: 21px; height: 21px; }

/* ── 电话 · 通话全屏层（背景图铺底 + 暗色蒙层；无图时保持深色） ── */
.ubp-call-screen {
  position: absolute; inset: 0; z-index: 35;
  background: #17171C; color: #F2F2F4;
  display: flex; flex-direction: column;
}
.ubp-call-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; }
.ubp-call-bg img { filter: saturate(0.92) brightness(0.96); }
/* 上下加深保证姓名/气泡/按钮可读；顶栏收窄后上端只压住信息带，中段留给照片 */
.ubp-call-bg i {
  position: absolute; inset: 0; display: block;
  background: linear-gradient(180deg,
    rgba(13, 14, 18, 0.76) 0%, rgba(13, 14, 18, 0.44) 15%,
    rgba(13, 14, 18, 0.24) 42%, rgba(13, 14, 18, 0.32) 70%,
    rgba(13, 14, 18, 0.86) 100%);
}
/* ── 顶栏 · 大版式（振铃/来电；以及接通后的展开态）── */
.ubp-call-top {
  position: relative; z-index: 1;
  flex: none; display: flex; flex-direction: column; align-items: center; gap: 7px;
  padding: 34px 24px 8px; text-align: center;
}
.ubp-call-screen.bar-open .ubp-call-top { padding: 26px 24px 6px; }
.ubp-call-avatar {
  width: 88px; height: 88px; border-radius: 50%; color: #fff; overflow: hidden; flex: none;
  display: flex; align-items: center; justify-content: center; font-size: 34px; font-weight: 600;
  margin-bottom: 5px;
}
.ubp-call-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ubp-call-avatar.ringing { animation: ubp-call-pulse 1.6s ease-in-out infinite; }
@keyframes ubp-call-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
/* ── 顶栏 · 紧凑信息带（接通后的默认态，方案 C）──
   接通后的信息（谁 + 多久 + 什么心情）本来就是一横排的事；竖着堆会吃掉三分之一屏、把对白挤成配角。
   46px 头像带白描边与投影，压在照片上仍认得出。 */
.ubp-call-bar {
  position: relative; z-index: 1;
  flex: none; display: flex; align-items: center; gap: 11px;
  padding: 10px 12px 4px 14px;
}
.ubp-call-bar-av {
  width: 46px; height: 46px; border-radius: 50%; color: #fff; overflow: hidden; flex: none;
  display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 600;
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.22), 0 2px 10px rgba(0, 0, 0, 0.35);
}
.ubp-call-bar-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ubp-call-bar-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ubp-call-bar-name {
  font-size: 16px; font-weight: 600; line-height: 1.25;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ubp-call-bar-sub { display: flex; align-items: center; gap: 8px; }
.ubp-call-bar-sub .ubp-call-status.timer { font-size: 13px; letter-spacing: 0.6px; }
.ubp-call-bar .ubp-call-mutebadge { margin-top: 0; }
/* 顶栏展收钮（两种版式共用）：收起态箭头朝下＝展开，展开态朝上＝收起 */
.ubp-call-toggle {
  width: 28px; height: 28px; flex: none; padding: 0; border: none; border-radius: 50%; cursor: pointer;
  background: rgba(255, 255, 255, 0.14); color: rgba(255, 255, 255, 0.86);
  display: flex; align-items: center; justify-content: center;
}
.ubp-call-toggle:active { background: rgba(255, 255, 255, 0.22); }
.ubp-call-toggle svg { width: 15px; height: 15px; transform: rotate(90deg); transition: transform 0.18s ease; }
.ubp-call-screen.bar-open .ubp-call-toggle { position: absolute; top: 12px; right: 12px; }
.ubp-call-screen.bar-open .ubp-call-toggle svg { transform: rotate(-90deg); }
.ubp-call-name { font-size: 21px; font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-call-status { font-size: 13.5px; color: rgba(255, 255, 255, 0.62); display: flex; align-items: center; gap: 7px; }
.ubp-call-status.warn { color: #FF8A80; }
.ubp-call-status.timer { font-size: 17px; font-variant-numeric: tabular-nums; letter-spacing: 1px; color: rgba(255, 255, 255, 0.9); }
.ubp-call-sub { font-size: 12px; color: rgba(255, 255, 255, 0.45); line-height: 1.5; max-width: 260px; }
.ubp-call-mutebadge {
  font-size: 10.5px; color: #FFD86B; background: rgba(255, 216, 107, 0.14);
  border-radius: 5px; padding: 1px 7px; margin-top: 2px;
}
.ubp-call-dots { display: inline-flex; gap: 3px; }
.ubp-call-dots i { width: 4px; height: 4px; border-radius: 2px; background: currentColor; animation: ubp-call-dot 1.2s ease-in-out infinite; }
.ubp-call-dots i:nth-child(2) { animation-delay: 0.15s; }
.ubp-call-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes ubp-call-dot { 0%, 60%, 100% { opacity: 0.25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
/* 心理话：左侧引线 + 斜体的一小段——不再是与对白同形的实底气泡（原形态会跟气泡抢视线，
   用户截图里第一眼会把它误认成对白）。全文显示不截断（call-parser 已把 thought 截到 500 字）。 */
.ubp-call-thought {
  position: relative; z-index: 1;
  font-size: 12px; font-style: italic; line-height: 1.6; color: rgba(255, 255, 255, 0.72);
  text-align: left; word-break: break-word;
  margin: 2px 14px 6px; padding: 0 0 0 10px;
  border-left: 2px solid rgba(255, 255, 255, 0.3);
}
/* 展开态（大版式居中列）：限宽居中，文字仍左对齐 */
.ubp-call-screen.bar-open .ubp-call-thought { max-width: 300px; margin: 6px auto; }
.ubp-call-lines {
  position: relative; z-index: 1;
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 11px; padding: 8px 14px 12px;
  /* 顶部 14px 渐隐：滚动时被切一半的气泡行不再露硬边（只作用于通话进行中的这一层） */
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 14px);
  mask-image: linear-gradient(180deg, transparent 0, #000 14px);
}
.ubp-call-line {
  max-width: 86%; padding: 10px 14px; border-radius: 16px; font-size: 15px; line-height: 1.6;
  word-break: break-word; white-space: pre-wrap;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}
.ubp-call-line.peer {
  align-self: flex-start; border-top-left-radius: 5px;
  background: #23232B; color: #F2F2F4;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.ubp-call-line.me { align-self: flex-end; border-top-right-radius: 5px; background: #34C77B; color: #062B19; }
/* 行内块级元信息随正文同档（11px 压在 15px 正文上读不出来） */
.ubp-call-line > .ubp-vmeta { margin-bottom: 4px; gap: 7px; }
.ubp-call-line.me > .ubp-vmeta { justify-content: flex-end; }
.ubp-call-line .ubp-emo { font-size: 12px; padding: 1px 8px 2px; }
.ubp-call-line .ubp-deliv { font-size: 12px; }
.ubp-call-hint {
  position: relative; z-index: 1;
  align-self: center; font-size: 12px; color: rgba(255, 255, 255, 0.62);
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; border-radius: 9px;
  background: rgba(22, 22, 28, 0.92);
}
.ubp-call-controls {
  position: relative; z-index: 1;
  flex: none; display: flex; align-items: flex-start; justify-content: space-evenly;
  padding: 12px 20px 22px;
}
.ubp-call-ctl { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.ubp-call-ctl span { font-size: 11px; color: rgba(255, 255, 255, 0.72); }
.ubp-call-btn {
  width: 58px; height: 58px; border-radius: 50%; border: none; cursor: pointer;
  background: rgba(255, 255, 255, 0.14); color: #F2F2F4;
  display: flex; align-items: center; justify-content: center; transition: transform 0.08s ease;
}
.ubp-call-btn:active { transform: scale(0.9); }
.ubp-call-btn svg { width: 24px; height: 24px; }
.ubp-call-btn.speak { background: #F2F2F4; color: #17171C; }
.ubp-call-btn.on { background: #F2F2F4; color: #17171C; }
.ubp-call-btn.end { width: 62px; height: 62px; background: #E8493F; color: #fff; box-shadow: 0 5px 16px rgba(232, 73, 63, 0.4); }
.ubp-call-btn.end svg { transform: rotate(135deg); width: 27px; height: 27px; }
/* 来电接听钮（世界演化联动 incoming 态）：绿色大钮与挂断对称 */
.ubp-call-btn.accept { width: 62px; height: 62px; background: #34C77B; color: #062B19; box-shadow: 0 5px 16px rgba(52, 199, 123, 0.4); }
.ubp-call-btn.accept svg { width: 27px; height: 27px; }
.ubp-call-ovl { z-index: 36; }

/* ── 电话 · 通话详情回看（套用通话背景：主题色蒙层，明暗主题都可读） ── */
.ubp-cl-detail { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ubp-cl-detail .ubp-appbody { position: relative; z-index: 1; }
.ubp-cl-detail-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; }
.ubp-cl-detail-bg i { position: absolute; inset: 0; display: block; background: var(--ubp-bg); opacity: 0.86; }

/* ── 电话 · 联系人详情（通讯录点行进入） ── */
.ubp-cd-head { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 22px 16px 4px; }
.ubp-cd-avatar {
  width: 84px; height: 84px; border-radius: 50%; color: #fff; overflow: hidden; flex: none;
  display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 600;
}
.ubp-cd-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ubp-cd-name { font-size: 18px; font-weight: 600; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-cd-tag { font-size: 10.5px; color: var(--ubp-accent); background: var(--ubp-accent-soft); border-radius: 5px; padding: 2px 9px; }
.ubp-cd-card { margin: 14px 14px 0; background: var(--ubp-card); border-radius: 12px; padding: 2px 14px; }
.ubp-cd-row { display: flex; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--ubp-line); align-items: baseline; }
.ubp-cd-row:last-child { border-bottom: none; }
.ubp-cd-row i { font-style: normal; flex: none; width: 60px; font-size: 12.5px; color: var(--ubp-text-3); }
.ubp-cd-row b { font-size: 15px; font-weight: 600; letter-spacing: 1.5px; font-variant-numeric: tabular-nums; }
.ubp-cd-row span { font-size: 13.5px; line-height: 1.55; word-break: break-word; }
.ubp-cd-numedit {
  flex: none; margin-left: auto; align-self: center; width: 26px; height: 26px; padding: 0;
  border: none; background: transparent; color: var(--ubp-text-3); border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-family: var(--ubp-font);
}
.ubp-cd-numedit:active { background: var(--ubp-card-2); }
.ubp-cd-numedit svg { width: 14px; height: 14px; }
.ubp-cd-actions { display: flex; flex-direction: row; flex-wrap: wrap; justify-content: center; gap: 10px; padding: 18px 14px; }
.ubp-cd-actions .ubp-btn {
  flex: none; min-width: 128px; height: 44px; padding: 0 22px;
  font-size: 14px; font-weight: 600;
}
.ubp-cd-actions .ubp-btn svg { width: 16px; height: 16px; vertical-align: -3px; }

/* ── 社媒通用：刷新图标旋转 ── */
.ubp-spin { animation: ubp-spin 0.8s linear infinite; }

/* ── 朋友圈（moments） ── */
.ubp-mo-post { background: var(--ubp-card); border-radius: 12px; padding: 13px 14px; margin: 10px 10px 0; }
.ubp-mo-head { display: flex; gap: 10px; align-items: center; }
.ubp-mo-headmain { flex: 1; min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ubp-mo-author { font-size: 15.5px; font-weight: 600; color: var(--ubp-link); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-mo-time { font-size: 11px; color: var(--ubp-text-3); flex: none; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-mo-text { font-size: 15px; line-height: 1.62; margin-top: 8px; word-break: break-word; white-space: pre-wrap; }
.ubp-mo-at { color: var(--ubp-link); }
.ubp-mo-img { display: block; width: 100%; max-height: 300px; margin-top: 9px; padding: 0; border: none; border-radius: 9px; overflow: hidden; cursor: zoom-in; background: var(--ubp-card-2); }
.ubp-mo-img img { width: 100%; max-height: 300px; object-fit: cover; display: block; }
.ubp-mo-imgph {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  width: 100%; min-height: 108px; margin-top: 9px; padding: 16px 14px;
  border: 1px dashed var(--ubp-line); border-radius: 9px;
  background: var(--ubp-card-2); color: var(--ubp-text-3); cursor: pointer;
  font-family: var(--ubp-font);
}
.ubp-mo-imgph svg { width: 20px; height: 20px; }
.ubp-mo-imgph:active { background: var(--ubp-line); }
.ubp-mo-imgph:disabled { cursor: default; }
.ubp-mo-imgph-desc { font-size: 12.5px; line-height: 1.55; color: var(--ubp-text-2); text-align: center; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.ubp-mo-imgph-hint { font-size: 11px; color: var(--ubp-text-3); }
.ubp-mo-imgph-note { font-size: 12.5px; font-weight: 600; line-height: 1.4; color: var(--ubp-danger); text-align: center; }
/* 「本批自动生图名额已满」的安静说明（非错误态：中性色、不加重） */
.ubp-mo-imgph-note-quiet { font-size: 11px; line-height: 1.4; color: var(--ubp-text-3); text-align: center; }
.ubp-mo-imgph.failed { border-color: var(--ubp-danger-soft); }
.ubp-mo-foot { margin-top: 9px; background: var(--ubp-card-2); border-radius: 7px; padding: 7px 11px; }
.ubp-mo-likes { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; color: var(--ubp-link); line-height: 1.5; }
.ubp-mo-likes svg { width: 14px; height: 14px; flex: none; margin-top: 2px; color: var(--ubp-danger); }
.ubp-mo-likes + .ubp-mo-comments { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--ubp-line); }
.ubp-mo-comments { display: flex; flex-direction: column; gap: 3px; }
.ubp-mo-crow { font-size: 13.5px; line-height: 1.55; color: var(--ubp-text); word-break: break-word; }
.ubp-mo-cname { color: var(--ubp-link); font-weight: 600; }
.ubp-mo-error { display: flex; align-items: center; gap: 9px; margin: 10px 10px 0; font-size: 12px; color: var(--ubp-danger); background: var(--ubp-danger-soft); border-radius: 9px; padding: 8px 12px; line-height: 1.5; }
.ubp-mo-error > span:first-child, .ubp-mo-error { word-break: break-word; }
.ubp-mo-retry { flex: none; margin-left: auto; border: 1px solid var(--ubp-danger); border-radius: 8px; padding: 3px 12px; font-size: 12px; font-weight: 600; background: transparent; color: var(--ubp-danger); cursor: pointer; }
.ubp-mo-retry:active { background: var(--ubp-danger); color: #fff; }
.ubp-mo-loading { display: flex; align-items: center; gap: 9px; margin: 10px 10px 0; font-size: 12.5px; color: var(--ubp-text-2); background: var(--ubp-card); border-radius: 9px; padding: 9px 12px; position: sticky; top: 0; z-index: 3; box-shadow: 0 1px 0 var(--ubp-line); }
.ubp-mo-loading .ubp-btn { margin-left: auto; height: 28px; padding: 0 13px; font-size: 12px; }



/* ── 社媒互动层（P3.2：点赞/评论/发帖/求回应） ── */
/* SO-03：朋友圈互动行=常显灰字「赞 · 评论」+ ⋯（真实朋友圈模型：三动作收进弹出菜单，
   不再把 点赞/评论/分享 三枚按钮直接外露在每张卡片上） */
.ubp-mo-actbar { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.ubp-mo-acthint { font-size: 12px; color: var(--ubp-text-3); flex: 1; min-width: 0; }
.ubp-mo-more {
  flex: none; border: none; border-radius: 8px; background: var(--ubp-card-2); color: var(--ubp-text-2);
  font-size: 13px; line-height: 1; padding: 5px 10px; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-mo-more:active { background: var(--ubp-line); }
.ubp-mo-ctime { font-size: 10.5px; color: var(--ubp-text-3); margin-left: 6px; white-space: nowrap; }
.ubp-mo-metag { font-style: normal; font-size: 10.5px; color: var(--ubp-text-3); font-weight: 400; }
.ubp-mo-creply {
  border: none; background: none; cursor: pointer; font-size: 10.5px; color: var(--ubp-link);
  margin-left: 6px; padding: 0; font-family: var(--ubp-font);
}
/* 求回应徽标按钮（顶栏） */
.ubp-fbbadge { position: relative; color: var(--app-acc, var(--ubp-accent)); }
.ubp-fbbadge i {
  position: absolute; top: -2px; right: -4px; font-style: normal; min-width: 15px; height: 15px;
  border-radius: 8px; background: var(--ubp-danger); color: #fff; font-size: 9.5px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; padding: 0 3px; line-height: 1;
}
/* 发动态/发帖悬浮按钮 */
.ubp-mo-fab {
  position: absolute; right: 14px; bottom: 16px; z-index: 12; width: 46px; height: 46px;
  border: none; border-radius: 50%; background: var(--ubp-accent); color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(0,0,0,0.28);
}
.ubp-mo-fab svg { width: 22px; height: 22px; }
.ubp-mo-fab:active { filter: brightness(0.92); }
/* 编辑面板（发帖/评论/回复；拍照描述生图 / 相册选图） */
/* z-index 60 必须压过底部 Tab 栏（.ubp-sfoot z-50）：否则面板底部「取消/发布」行被
   不透明 Tab 栏物理盖住，发帖面板永远关不掉（贴吧/微博同病，先例） */
.ubp-mo-composer { z-index: 60; align-items: flex-end; padding: 0; }
.ubp-mo-composer .ubp-sheet { max-width: 100%; border-radius: 16px 16px 0 0; }
.ubp-mo-composer .ubp-textarea, .ubp-mo-composer .ubp-fieldinput { width: 100%; margin-bottom: 8px; }
.ubp-mo-attachrow { display: flex; gap: 8px; }
.ubp-mo-attachrow .ubp-btn { flex: none; height: 32px; padding: 0 12px; font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; }
.ubp-mo-attachrow .ubp-btn svg { width: 14px; height: 14px; }
.ubp-mo-attach { margin-bottom: 8px; }
.ubp-mo-attachchip {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ubp-text-2);
  background: var(--ubp-card-2); border-radius: 8px; padding: 6px 10px; max-width: 100%;
}
.ubp-mo-attachchip svg { width: 14px; height: 14px; flex: none; }
.ubp-mo-attachx {
  border: none; background: none; color: var(--ubp-text-3); cursor: pointer; font-size: 14px;
  padding: 0 2px; line-height: 1; font-family: var(--ubp-font);
}


/* ── 社媒三 App 共享外壳（对照 mockup tb-top/tb-foot/wb-tabs/xhs-seg；主题色 --app-acc 从各 App 根继承） ── */
/* 底部 Tab 栏 */
.ubp-sfoot { flex: none; height: 54px; background: var(--ubp-card); border-top: 1px solid var(--ubp-line); display: flex; position: relative; z-index: 50; }
.ubp-sfoot-tab {
  position: relative; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  font-size: 10px; color: var(--ubp-text-3); cursor: pointer; border: none; background: none; font-family: var(--ubp-font);
}
.ubp-sfoot-tab .ico { display: flex; }
.ubp-sfoot-tab .ico svg { width: 20px; height: 20px; }
.ubp-sfoot-tab.on { color: var(--app-acc, var(--ubp-accent)); font-weight: 700; }
/* 消息 tab 未读徽标（99+ 截断） */
.ubp-sfoot-badge {
  position: absolute; top: 5px; left: 50%; margin-left: 6px; min-width: 16px; height: 16px; border-radius: 8px;
  background: var(--ubp-badge, var(--ubp-danger)); color: #fff; font-size: 9.5px; line-height: 16px;
  text-align: center; padding: 0 4px; font-style: normal; box-sizing: border-box;
}
.ubp-sfoot-tab.plus .ico {
  background: var(--app-acc, var(--ubp-accent)); color: var(--app-on-acc, #fff); width: 30px; height: 30px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center; margin-top: -10px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25);
}
.ubp-sfoot-tab.plus .ico svg { width: 18px; height: 18px; }
.ubp-sfoot-tab.plus:active .ico { filter: brightness(0.92); }
/* 品牌顶栏（贴吧=蓝渐变白字 / 微博·小红书=白底；内容各 App 自拼） */
.ubp-stop { flex: none; padding: 6px 12px 0; position: relative; z-index: 5; }
.ubp-stop-row { display: flex; align-items: center; gap: 10px; padding-bottom: 8px; }
.ubp-stop-logo { font-size: 20px; font-weight: 800; letter-spacing: 1px; white-space: nowrap; }
.ubp-stop-search {
  flex: 1; min-width: 0; border-radius: 16px; padding: 7px 13px; font-size: 12px;
  display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  /* 搜索胶囊=按钮（点开输入话题）：抹平 button 默认样式，外观与旧氛围位一致 */
  border: none; background: none; font-family: var(--ubp-font); color: inherit; text-align: left; cursor: pointer;
}
.ubp-stop-search:active { filter: brightness(0.96); }
.ubp-stop-search svg { width: 13px; height: 13px; flex: none; }
.ubp-stop-acts { display: flex; align-items: center; gap: 2px; margin-left: auto; flex: none; }
.ubp-stop-acts .ubp-iconbtn { color: inherit; }
.ubp-stop-acts .ubp-iconbtn:active { background: rgba(127, 127, 127, 0.18); }
.ubp-sbell { position: relative; }
.ubp-sbell.has::after {
  content: ""; position: absolute; top: -1px; right: -2px; width: 8px; height: 8px;
  background: var(--ubp-danger); border-radius: 50%; border: 1.5px solid var(--ubp-card);
}
/* 详情/次级页导航行 */
.ubp-sdetnav { flex: none; display: flex; align-items: center; gap: 6px; padding: 7px 8px; background: var(--ubp-card); border-bottom: 1px solid var(--ubp-line); position: relative; z-index: 5; }
.ubp-sdetnav-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.ubp-sdetnav-title b { font-size: 15.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-sdetnav-title i { font-style: normal; font-size: 10.5px; color: var(--ubp-text-3); white-space: nowrap; }
/* 标题可点（titleAct）：样式还原成纯标题文本，仅指针提示可点 */
.ubp-sdetnav-goto { border: none; background: none; padding: 0; font: inherit; color: inherit; font-weight: inherit; cursor: pointer; }
/* 顶栏分段（贴吧=白字白条；微博/小红书=深字品牌条，--segl 决定下划线色） */
.ubp-sseg { display: flex; gap: 22px; padding: 0 4px; }
.ubp-sseg-tab {
  position: relative; padding: 5px 2px 9px; font-size: 15px; color: var(--ubp-text-2);
  background: none; border: none; cursor: pointer; font-family: var(--ubp-font);
}
.ubp-sseg-tab.on { color: var(--ubp-text); font-weight: 700; }
.ubp-sseg-tab.on::after {
  content: ""; position: absolute; left: 50%; transform: translateX(-50%); bottom: 4px;
  width: 20px; height: 3px; border-radius: 2px; background: var(--segl, var(--app-acc, var(--ubp-accent)));
}
.ubp-xhs .ubp-sseg { gap: 26px; padding: 0 18px; }
.ubp-xhs .ubp-sseg-tab { font-size: 16px; }
.ubp-xhs .ubp-sseg-tab.on { font-size: 17px; }
.ubp-xhs .ubp-sseg-tab.on::after { width: 22px; bottom: 3px; }
.ubp-wb .ubp-sseg { flex: 1; }
.ubp-wb .ubp-sseg-tab { flex: 1; text-align: center; }
.ubp-wb .ubp-sseg-tab.on::after { width: 26px; }
/* 贴吧顶栏＝品牌蓝纯色（禁渐变；--tb-seg* 供皮肤浅色头部覆盖取词）。用 token 后皮肤换色自动跟随，修掉「深色分段字压蓝底」的对比缺陷 */
.ubp-tb .ubp-stop { background: var(--tb-acc); color: #fff; }
.ubp-tb .ubp-stop-search { background: rgba(255, 255, 255, 0.22); color: rgba(255, 255, 255, 0.88); }
.ubp-tb .ubp-stop-logo { color: #fff; }
.ubp-tb .ubp-sseg-tab { color: var(--tb-seg, rgba(255, 255, 255, 0.72)); }
.ubp-tb .ubp-sseg-tab.on { color: var(--tb-seg-on, #fff); }
.ubp-tb .ubp-sseg-tab.on::after { background: var(--tb-seg-bar, #fff); }
.ubp-wb .ubp-stop, .ubp-xhs .ubp-stop { background: var(--ubp-card); color: var(--ubp-text); border-bottom: 1px solid var(--ubp-line); }
.ubp-wb .ubp-stop-search, .ubp-xhs .ubp-stop-search { background: var(--ubp-bg); color: var(--ubp-text-3); }
.ubp-wb .ubp-stop-logo { color: var(--wb-org); }
.ubp-wb .ubp-stop-logo em { color: var(--wb-acc); font-style: normal; }
.ubp-xhs .ubp-stop-search b { color: var(--ubp-text); font-weight: 600; }
/* 关注按钮（贴吧吧/微博博主/小红书作者共用） */
.ubp-sfollow {
  border: 1px solid var(--app-acc, var(--ubp-accent)); color: var(--app-acc, var(--ubp-accent)); background: none;
  font-size: 12px; font-weight: 700; padding: 4px 13px; border-radius: 15px; cursor: pointer; flex: none; font-family: var(--ubp-font);
}
.ubp-sfollow.on { border-color: var(--ubp-line); color: var(--ubp-text-3); }
/* 作者主页（微博/小红书；严格对照 docs/follow-mechanism-mockup.html wb-author/xhs-author） */
.ubp-sauth-cover { height: 112px; position: relative; flex: none; overflow: hidden; }
.ubp-wb-acover { background: linear-gradient(150deg, #ffc077, #f2a154 55%, #dd8668); background-size: cover; background-position: center; }
.ubp-wb-acover::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 40%, rgba(0, 0, 0, 0.18)); }
.ubp-wb-acover-edit {
  position: absolute; top: 8px; right: 12px; z-index: 5; border: none; cursor: pointer;
  font-size: 10.5px; color: #fff; background: rgba(0, 0, 0, 0.25); padding: 3px 9px; border-radius: 12px; font-family: var(--ubp-font);
}
.ubp-wb-ahead { background: var(--ubp-card); padding: 0 14px; flex: none; }
.ubp-wb-ahead-row1 { display: flex; align-items: flex-end; gap: 12px; margin-top: -30px; position: relative; z-index: 6; }
.ubp-wb-bigava {
  width: 74px; height: 74px; border-radius: 50%; border: 3px solid var(--ubp-card); flex: none;
  display: flex; align-items: center; justify-content: center; color: #fff; font-size: 25px; font-weight: 800; position: relative;
}
.ubp-wb-bigava .ubp-wb-vv {
  position: absolute; right: 1px; bottom: 1px; width: 17px; height: 17px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font-size: 9.5px; color: #fff; font-weight: 800; border: 2px solid var(--ubp-card);
}
.ubp-wb-vv.o { background: var(--wb-org); } .ubp-wb-vv.g { background: #FFB800; } .ubp-wb-vv.b { background: #4E9BF2; }
.ubp-wb-fbtn {
  margin-left: auto; margin-bottom: 9px; border: none; cursor: pointer; font-family: var(--ubp-font);
  font-size: 13px; font-weight: 700; padding: 7px 21px; border-radius: 17px; flex: none;
}
.ubp-wb-fbtn.on { background: var(--ubp-bg); color: var(--ubp-text-3); border: 0.5px solid var(--ubp-line); }
.ubp-wb-fbtn.off { background: var(--wb-acc); color: #fff; }
.ubp-wb-name { font-size: 18px; font-weight: 800; color: var(--ubp-text); display: flex; align-items: center; gap: 6px; margin-top: 9px; }
.ubp-wb-name i { font-style: normal; font-size: 12px; }
.ubp-wb-verified { font-size: 11.5px; color: var(--ubp-text-3); margin-top: 4px; display: flex; align-items: center; gap: 4px; }
.ubp-wb-verified i { color: var(--wb-org); font-style: normal; font-weight: 700; }
.ubp-wb-bio { font-size: 12.5px; color: var(--ubp-text-2); line-height: 1.6; margin-top: 7px; }
.ubp-wb-stats { display: flex; gap: 25px; padding: 12px 0 10px; }
.ubp-wb-stats button { border: none; background: none; cursor: pointer; font-family: var(--ubp-font); padding: 0; }
.ubp-wb-stats b { font-size: 15.5px; font-weight: 800; color: var(--ubp-text); }
.ubp-wb-stats span { font-size: 11px; color: var(--ubp-text-3); margin-left: 4px; }
.ubp-wb-pagetab { display: flex; border-top: 1px solid var(--ubp-line); }
.ubp-wb-pagetab span { flex: 1; text-align: center; font-size: 13.5px; padding: 9px 0 8px; color: var(--ubp-text-2); position: relative; }
.ubp-wb-pagetab span.on { color: var(--ubp-text); font-weight: 800; }
.ubp-wb-pagetab span.on::after { content: ""; position: absolute; left: 50%; transform: translateX(-50%); bottom: 0; width: 26px; height: 3px; border-radius: 2px; background: var(--wb-org); }
/* 小红书作者页头部 */
.ubp-xhs-ahead { background: var(--ubp-card); padding: 6px 16px 0; flex: none; }
.ubp-xhs-ahead-top { display: flex; align-items: center; gap: 16px; }
.ubp-xhs-bigava { width: 64px; height: 64px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 23px; font-weight: 800; }
/* 作者主页大头像=复用角色头像（avatarHtml 真图铺满），无头像时回落首字占位（字号/字重随容器原样） */
.ubp-avatar.ubp-bigava { width: 100%; height: 100%; border-radius: 50%; }
.ubp-wb-bigava .ubp-avatar { font-size: 25px; font-weight: 800; }
.ubp-xhs-bigava .ubp-avatar { font-size: 23px; font-weight: 800; }
.ubp-xhs-astats { flex: 1; display: flex; }
.ubp-xhs-astat { flex: 1; text-align: center; }
.ubp-xhs-astat b { font-size: 16px; font-weight: 800; color: var(--ubp-text); display: block; }
.ubp-xhs-astat span { font-size: 11px; color: var(--ubp-text-3); }
.ubp-xhs-nick { font-size: 16.5px; font-weight: 800; color: var(--ubp-text); margin-top: 11px; display: flex; align-items: center; gap: 7px; }
.ubp-xhs-nick i { font-style: normal; font-size: 11px; color: #fff; background: #FF7398; border-radius: 9px; padding: 1px 7px; font-weight: 600; }
.ubp-xhs-uid { font-size: 11px; color: var(--ubp-text-3); margin-top: 3px; }
.ubp-xhs-abio { font-size: 12.5px; color: var(--ubp-text-2); line-height: 1.65; margin-top: 7px; white-space: pre-line; }
.ubp-xhs-ip { font-size: 10.5px; color: var(--ubp-text-3); margin-top: 6px; }
.ubp-xhs-abtns { display: flex; gap: 9px; padding: 12px 0 11px; }
.ubp-xhs-abtn { flex: 1; border: none; cursor: pointer; text-align: center; font-family: var(--ubp-font); font-size: 13.5px; font-weight: 700; padding: 8px 0; border-radius: 9px; }
.ubp-xhs-abtn.on { background: var(--xhs-acc); color: #fff; }
.ubp-xhs-abtn.followed { background: var(--ubp-bg); color: var(--ubp-text-3); }
.ubp-xhs-pagetab { display: flex; gap: 24px; padding: 0 16px; border-bottom: 1px solid var(--ubp-line); flex: none; background: var(--ubp-card); }
.ubp-xhs-pagetab span { font-size: 14.5px; color: var(--ubp-text-2); padding: 6px 0 9px; position: relative; }
.ubp-xhs-pagetab span.on { color: var(--ubp-text); font-weight: 800; }
.ubp-xhs-pagetab span.on::after { content: ""; position: absolute; left: 50%; transform: translateX(-50%); bottom: 3px; width: 22px; height: 3px; border-radius: 2px; background: var(--xhs-acc); }
/* 作者主页骨架屏（资料生成中）与生成胶囊 */
.ubp-sk { background: var(--ubp-accent-soft); border-radius: 8px; position: relative; overflow: hidden; }
.ubp-sk::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.5) 50%, transparent 70%);
  animation: ubp-shimmer 1.4s infinite;
}
@keyframes ubp-shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.ubp-sgen {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: 64px; z-index: 30;
  background: rgba(20, 20, 26, 0.82); color: #fff; font-size: 12px; padding: 9px 16px; border-radius: 20px;
  display: flex; align-items: center; gap: 8px; white-space: nowrap;
}
.ubp-sgen .ubp-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid rgba(255, 255, 255, 0.3); border-top-color: #fff; border-radius: 50%; animation: ubp-rot 0.8s linear infinite; }
@keyframes ubp-rot { to { transform: rotate(360deg); } }
/* 我的关注·内联展开区（我的页内，无弹层；三平台同构） */
.ubp-fwsec { background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 13px 14px 10px; }
.ubp-fwsec-hd { display: flex; align-items: baseline; gap: 8px; }
.ubp-fwsec-hd b { font-size: 15px; font-weight: 800; color: var(--ubp-text); }
.ubp-fwsec-hd i { font-style: normal; font-size: 11px; color: var(--ubp-text-3); }
.ubp-fwsec-fold { margin-left: auto; border: none; background: none; cursor: pointer; font-size: 11px; color: var(--ubp-text-3); font-family: var(--ubp-font); padding: 2px 4px; }
.ubp-fw-row { display: flex; align-items: center; gap: 11px; padding: 10px 2px; border-bottom: 1px solid var(--ubp-line); }
.ubp-fw-row:last-child { border-bottom: none; }
.ubp-fw-row .ubp-avatar { width: 42px; height: 42px; font-size: 16px; border-radius: 50%; flex: none; }
.ubp-fw-row .ubp-avatar.sq { border-radius: 11px; }
.ubp-fw-main { flex: 1; min-width: 0; cursor: pointer; }
.ubp-fw-name { font-size: 14px; font-weight: 700; color: var(--ubp-text); display: flex; align-items: center; gap: 5px; }
.ubp-fw-name i { font-style: normal; font-size: 9.5px; color: #5FB878; background: rgba(95, 184, 120, 0.14); padding: 1px 6px; border-radius: 8px; font-weight: 600; }
.ubp-fw-sub { font-size: 11.5px; color: var(--ubp-text-3); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-fw-goto { font-size: 10px; color: var(--ubp-text-3); opacity: 0.75; margin-top: 2px; }
/* 消息页（通知流 + 待回应折叠区） */
.ubp-smsg-hd { padding: 12px 16px 4px; font-size: 13px; font-weight: 600; color: var(--ubp-text-2); display: flex; align-items: center; gap: 8px; }
.ubp-smsg-markall {
  margin-left: auto; border: none; background: none; cursor: pointer; padding: 3px 8px; border-radius: 10px;
  font-size: 11px; color: var(--app-acc, var(--ubp-accent)); font-family: var(--ubp-font); flex: none;
}
.ubp-smsg-markall:active { background: var(--ubp-accent-soft); }
.ubp-smsg-row { position: relative; display: flex; gap: 10px; background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 11px 13px; }
.ubp-smsg-row.unread { background: var(--ubp-accent-soft); }
.ubp-smsg-row .ubp-avatar { width: 36px; height: 36px; font-size: 14px; border-radius: 50%; flex: none; }
.ubp-smsg-dot {
  position: absolute; top: 16px; right: 12px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--app-acc, var(--ubp-accent)); flex: none;
}
.ubp-smsg-pend { margin: 10px 10px 0; background: var(--ubp-card); border-radius: 12px; overflow: hidden; }
.ubp-smsg-pend > summary {
  list-style: none; cursor: pointer; padding: 11px 13px; font-size: 13px; font-weight: 600; color: var(--ubp-text-2);
  display: flex; align-items: center; user-select: none;
}
.ubp-smsg-pend > summary::-webkit-details-marker { display: none; }
.ubp-smsg-pend > summary::after {
  content: ""; margin-left: auto; width: 7px; height: 7px; flex: none;
  border-right: 1.5px solid var(--ubp-text-3); border-bottom: 1.5px solid var(--ubp-text-3);
  transform: rotate(45deg); transition: transform 0.15s ease;
}
.ubp-smsg-pend[open] > summary::after { transform: rotate(225deg); }
.ubp-smsg-pend .ubp-smsg-row { margin: 0; border-radius: 0; border-top: 1px solid var(--ubp-line); }
.ubp-smsg-main { flex: 1; min-width: 0; }
.ubp-smsg-title { font-size: 13px; color: var(--ubp-text); }
.ubp-smsg-title b { font-weight: 600; }
.ubp-smsg-text { font-size: 12px; color: var(--ubp-text-2); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-smsg-time { font-size: 10.5px; color: var(--ubp-text-3); margin-top: 4px; }
/* 我的页（我的内容 + 删除） */
.ubp-sme-head { display: flex; align-items: center; gap: 11px; background: var(--ubp-card); border-radius: 12px; margin: 10px 10px 0; padding: 13px 14px; }
.ubp-sme-head .ubp-avatar { width: 46px; height: 46px; font-size: 18px; border-radius: 50%; flex: none; }
.ubp-sme-name { font-size: 15px; font-weight: 700; color: var(--ubp-text); }
.ubp-sme-sub { font-size: 10.5px; color: var(--ubp-text-3); margin-top: 3px; }
.ubp-sme-stats { display: flex; gap: 10px; background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 10px 14px; font-size: 12px; color: var(--ubp-text-3); }
.ubp-sme-stats b { color: var(--ubp-text); font-weight: 700; margin-right: 4px; }
.ubp-sme-follow { border: none; background: none; cursor: pointer; font-family: var(--ubp-font); font-size: 12px; color: var(--app-acc, var(--ubp-accent)); padding: 0; font-weight: 600; }
.ubp-sme-follow b { color: inherit; font-weight: 800; margin-right: 4px; }
.ubp-sme-follow i { font-style: normal; font-size: 10px; opacity: 0.8; }
.ubp-sme-follow.open b { color: var(--ubp-text); }
.ubp-sme-row { display: flex; align-items: center; gap: 10px; background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 11px 13px; }
.ubp-sme-main { flex: 1; min-width: 0; }
.ubp-sme-title { font-size: 13.5px; font-weight: 600; color: var(--ubp-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-sme-text { font-size: 11.5px; color: var(--ubp-text-2); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-sme-time { font-size: 10px; color: var(--ubp-text-3); margin-top: 4px; }
.ubp-sme-del {
  flex: none; border: none; background: none; color: var(--ubp-text-3); cursor: pointer; padding: 6px;
  display: flex; align-items: center; justify-content: center; border-radius: 8px; font-family: var(--ubp-font); font-size: 11px;
}
.ubp-sme-del svg { width: 17px; height: 17px; }
.ubp-sme-del:active { background: var(--ubp-card-2); }
/* 吧详情头部（大吧头像 + 关注/签到/吧内刷新） */
.ubp-tb-barhead { background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 13px 14px; }
.ubp-tb-barhead-row { display: flex; align-items: center; gap: 12px; }
.ubp-tb-barhead .ubp-avatar { width: 52px; height: 52px; font-size: 22px; border-radius: 13px; flex: none; }
.ubp-tb-barhead-info { flex: 1; min-width: 0; }
.ubp-tb-barhead-name { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ubp-tb-barhead-stat { font-size: 11px; color: var(--ubp-text-3); margin-top: 3px; }
.ubp-tb-barhead-acts { display: flex; align-items: center; gap: 8px; margin-top: 11px; }
.ubp-tb-barhead-acts .ubp-tb-signin { padding: 6px 16px; }

/* ── 贴吧（tieba：吧为中心 + 楼层盖楼，蓝紫主题 #5B72EE） ── */
.ubp-tb { --tb-acc: #4E6EF2; --tb-acc-soft: rgba(78, 110, 242, 0.12); --app-acc: #4E6EF2; --app-on-acc: #fff; display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.ubp-tb-chip { display: inline-flex; align-items: center; font-size: 10.5px; font-weight: 600; color: var(--tb-acc); background: var(--tb-acc-soft); border-radius: 10px; padding: 2px 9px; flex: none; }
.ubp-tb-flags { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: 1px; }
.ubp-tb-flag { font-size: 9.5px; padding: 0.5px 5px; border-radius: 4px; font-weight: 700; flex: none; }
.ubp-tb-flag.jing { color: #E6A700; border: 1px solid #E6A700; }
.ubp-tb-flag.top { color: var(--ubp-danger); border: 1px solid var(--ubp-danger); }
.ubp-tb-post {
  display: flex; flex-direction: column; gap: 5px; text-align: left;
  background: var(--ubp-card); border: none; border-radius: 12px;
  margin: 8px 10px 0; padding: 12px 14px; cursor: pointer;
  font-family: var(--ubp-font); color: var(--ubp-text);
}
.ubp-tb-post:active { background: var(--ubp-card-2); }
.ubp-tb-title { font-size: 15px; font-weight: 600; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ubp-tb-excerpt { font-size: 12.5px; color: var(--ubp-text-2); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.ubp-tb-pics { display: flex; gap: 4px; margin-top: 4px; }
.ubp-tb-pics .ubp-mo-imgph, .ubp-tb-pics .ubp-mo-img { flex: 1; min-width: 0; aspect-ratio: 1.4; margin-top: 0; }
.ubp-tb-pics .ubp-mo-imgph { flex-direction: column; padding: 6px; gap: 3px; }
.ubp-tb-pics .ubp-mo-imgph-desc { font-size: 10.5px; line-height: 1.45; -webkit-line-clamp: 2; }
.ubp-tb-pics .ubp-mo-img img { width: 100%; height: 100%; object-fit: cover; }
.ubp-tb-pmeta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ubp-text-3); margin-top: 3px; flex-wrap: wrap; }
.ubp-tb-pmeta b { font-weight: 600; color: var(--ubp-text-2); }
/* 进吧 */
.ubp-tb-bar { display: flex; align-items: center; gap: 12px; background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 12px 14px; }
.ubp-tb-bar .ubp-avatar { width: 44px; height: 44px; font-size: 18px; border-radius: 11px; }
.ubp-tb-barinfo { flex: 1; min-width: 0; }
.ubp-tb-barname { font-size: 14.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ubp-tb-barstat { font-size: 10.5px; color: var(--ubp-text-3); margin-top: 3px; }
.ubp-tb-lv { display: inline-block; font-size: 9.5px; color: #4BA762; background: rgba(75, 167, 98, 0.12); padding: 0.5px 6px; border-radius: 7px; font-weight: 600; flex: none; }
.ubp-tb-signin { border: 1px solid var(--tb-acc); color: var(--tb-acc); background: none; font-size: 12px; font-weight: 700; padding: 5px 14px; border-radius: 15px; cursor: pointer; flex: none; font-family: var(--ubp-font); }
.ubp-tb-signin.done { border-color: var(--ubp-line); color: var(--ubp-text-3); }
/* 帖子详情（楼层） */
.ubp-tb-thread-head { background: var(--ubp-card); padding: 12px 14px; margin: 8px 10px 0; border-radius: 12px; }
.ubp-tb-thread-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-tb-onlylz { font-size: 10.5px; color: var(--tb-acc); background: var(--tb-acc-soft); padding: 3px 10px; border-radius: 11px; border: none; cursor: pointer; font-family: var(--ubp-font); }
.ubp-tb-onlylz.on { color: #fff; background: var(--tb-acc); }
.ubp-tb-thread-title { font-size: 16.5px; font-weight: 700; line-height: 1.4; }
.ubp-tb-floor { background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 12px 14px; display: flex; gap: 10px; }
.ubp-tb-floor .ubp-avatar { width: 34px; height: 34px; font-size: 14px; border-radius: 50%; flex: none; }
.ubp-tb-fmain { flex: 1; min-width: 0; }
.ubp-tb-fname { font-size: 12px; color: var(--tb-acc); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ubp-tb-fno { margin-left: auto; color: var(--ubp-text-3); font-size: 10.5px; font-weight: 400; }
.ubp-tb-lz { font-size: 9px; color: #fff; background: #E6645C; border-radius: 3px; padding: 0.5px 4px; font-weight: 700; flex: none; }
.ubp-tb-fbody { font-size: 14px; color: var(--ubp-text); line-height: 1.65; margin-top: 4px; word-break: break-word; white-space: pre-wrap; }
.ubp-tb-quote { color: var(--tb-acc); }
/* 楼中楼：收缩进父楼内容列的灰底容器+紧凑文本行（无头像无楼层号；折叠线与楼中楼文字列齐平；规格 docs/comment-subs-mockup.html） */
.ubp-tb-ssub { background: var(--ubp-bg); border-radius: 9px; padding: 8px 11px 4px; margin-top: 8px; }
.ubp-tb-ssub-row { font-size: 12px; line-height: 1.6; color: var(--ubp-text); padding: 3px 0; word-break: break-word; }
.ubp-tb-ssub-row .n { color: var(--tb-acc); font-weight: 600; }
.ubp-tb-ssub-row .r { color: var(--tb-acc); }
.ubp-tb-ssub-row .ubp-mo-creply { margin-left: 6px; font-size: 10px; }
.ubp-tb-ssub-fold { display: block; width: 100%; text-align: left; border: none; background: none; cursor: pointer; padding: 6px 0 5px; font-family: var(--ubp-font); font-size: 11.5px; font-weight: 600; color: var(--tb-acc); }
/* 帖子详情底部评论栏（贴吧/微博共用一份实现；主操作钮取各 App 品牌色 --app-acc，SO-05）
   —— 类名收口：微博原先借贴吧类 + 内联 var(--wb-org) 补色的写法已退役。 */
.ubp-replybar { position: sticky; bottom: 0; background: var(--ubp-card); border-top: 1px solid var(--ubp-line); padding: 8px 12px; display: flex; gap: 10px; align-items: center; flex: none; margin-top: 8px; }
.ubp-replybar .input { flex: 1; background: var(--ubp-bg); border-radius: 17px; padding: 9px 14px; font-size: 12.5px; color: var(--ubp-text-3); }
.ubp-replybar .go { background: var(--app-acc, var(--ubp-accent)); color: var(--app-on-acc, #fff); font-size: 13px; font-weight: 700; padding: 8px 18px; border-radius: 17px; border: none; cursor: pointer; font-family: var(--ubp-font); }

/* ── 微博（weibo：时间线 + 热搜广场，红 #E6162D / 橙 #FF8200，橙取真实微博品牌值） ── */
.ubp-wb { --wb-acc: #E6162D; --wb-org: #FF8200; --wb-topic: #5B7CD9; --app-acc: #FF8200; --app-on-acc: #fff; --segl: #FF8200; display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.ubp-wb-card { background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 12px 14px 0; overflow: hidden; }
/* SO-02：默认（现代）形态下微博/贴吧 feed 通栏化——真实 App=白底通栏 + 发丝线，密度更高；
   四款风格化皮肤（仙侠/武侠/西幻/甜恋等）刻意用带纹理与描边的卡片作为视觉标识，故**只对默认作用域生效**。 */
.ubp-scope:not(.ubp-skin-xianxia):not(.ubp-skin-wuxia):not(.ubp-skin-fantasy) .ubp-wb-card,
.ubp-scope:not(.ubp-skin-xianxia):not(.ubp-skin-wuxia):not(.ubp-skin-fantasy) .ubp-tb-post {
  background: var(--ubp-card); border-radius: 0; margin: 0; padding: 12px 14px;
  border-bottom: 1px solid var(--ubp-line);
}
.ubp-wb-card.clickable { cursor: pointer; }
.ubp-wb-card.clickable:active { background: var(--ubp-card-2); }
.ubp-wb-head { display: flex; align-items: center; gap: 9px; }
.ubp-wb-head .ubp-avatar { width: 38px; height: 38px; font-size: 15px; border-radius: 50%; flex: none; position: relative; }
.ubp-wb-v {
  position: absolute; right: -2px; bottom: -2px; width: 13px; height: 13px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font-size: 8px; color: #fff; font-weight: 800;
  border: 1.5px solid var(--ubp-card); font-style: normal;
}
.ubp-wb-v.o { background: var(--wb-org); }
.ubp-wb-v.g { background: #E6A700; }
.ubp-wb-v.b { background: #4E9BF2; }
.ubp-wb-whom { flex: 1; min-width: 0; }
.ubp-wb-name { font-size: 13.5px; font-weight: 600; color: var(--wb-org); display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-wb-vip { font-size: 9px; color: #E6A700; }
.ubp-wb-time { font-size: 10.5px; color: var(--ubp-text-3); margin-top: 2px; }
.ubp-wb-text { font-size: 14.5px; color: var(--ubp-text); line-height: 1.62; margin-top: 8px; word-break: break-word; white-space: pre-wrap; }
.ubp-wb-text .topic, .ubp-wb-text .at { color: var(--wb-topic); }
.ubp-wb-pics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 8px; }
.ubp-wb-pics .ubp-mo-imgph, .ubp-wb-pics .ubp-mo-img { aspect-ratio: 1; margin-top: 0; border-radius: 6px; min-width: 0; }
.ubp-wb-pics .ubp-mo-imgph { flex-direction: column; padding: 6px; gap: 3px; }
.ubp-wb-pics .ubp-mo-imgph-desc { font-size: 10.5px; line-height: 1.45; -webkit-line-clamp: 2; }
.ubp-wb-pics.single .ubp-mo-imgph-desc { font-size: 12.5px; -webkit-line-clamp: 3; }
.ubp-wb-pics .ubp-mo-img img { width: 100%; height: 100%; object-fit: cover; }
.ubp-wb-pics.single .ubp-mo-imgph, .ubp-wb-pics.single .ubp-mo-img { aspect-ratio: 1.8; grid-column: 1 / -1; }
.ubp-wb-repost { background: var(--ubp-bg); border-radius: 8px; padding: 9px 11px; margin-top: 8px; font-size: 13px; color: var(--ubp-text-2); line-height: 1.55; word-break: break-word; }
.ubp-wb-repost b { color: var(--wb-topic); font-weight: 600; }
.ubp-wb-actions { display: flex; border-top: 1px solid var(--ubp-line); margin-top: 10px; }
.ubp-wb-act {
  position: relative; flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 10px 0;
  font-size: 12px; color: var(--ubp-text-2); border: none; background: none; cursor: pointer; font-family: var(--ubp-font);
}
.ubp-wb-act svg { width: 15px; height: 15px; }
.ubp-wb-act i { font-style: normal; }
.ubp-wb-act.on { color: var(--wb-acc); font-weight: 600; }
/* 热搜榜 */
.ubp-wb-hotlist { background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 2px 0; overflow: hidden; }
.ubp-wb-hotrow { display: flex; align-items: center; gap: 10px; padding: 0 14px; height: 46px; cursor: pointer; border-bottom: 1px solid var(--ubp-line); }
.ubp-wb-hotrow:last-child { border-bottom: none; }
.ubp-wb-rank { flex: none; width: 22px; text-align: center; font-size: 14.5px; font-style: italic; font-weight: 700; color: var(--ubp-text-3); }
.ubp-wb-rank.r1 { color: var(--wb-acc); }
.ubp-wb-rank.r2 { color: #E6541E; }
.ubp-wb-rank.r3 { color: var(--wb-org); }
.ubp-wb-hotword { flex: 1; min-width: 0; font-size: 13.5px; color: var(--ubp-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-wb-tag { font-size: 9.5px; color: #fff; border-radius: 3px; padding: 1px 5px; font-weight: 700; flex: none; }
.ubp-wb-tag.bao { background: #D42A38; }
.ubp-wb-tag.fei { background: #E6541E; }
.ubp-wb-tag.re { background: #E6A700; }
.ubp-wb-tag.xin { background: #3398DC; }
.ubp-wb-hotnum { font-size: 11px; color: var(--ubp-text-3); flex: none; font-style: italic; }
/* 话题页 */
.ubp-wb-topic-hero { background: var(--wb-acc); color: #fff; margin: 8px 10px 0; border-radius: 12px; padding: 14px 16px; }
.ubp-wb-topic-word { font-size: 16.5px; font-weight: 700; }
.ubp-wb-topic-stat { font-size: 11px; color: rgba(255, 255, 255, 0.82); margin-top: 5px; }
.ubp-wb-topic-host { background: var(--ubp-card); border-radius: 10px; margin: 8px 10px 0; padding: 10px 13px; display: flex; gap: 9px; align-items: center; font-size: 12px; color: var(--ubp-text-2); line-height: 1.5; }
.ubp-wb-topic-chip { font-size: 9.5px; color: var(--wb-acc); border: 1px solid var(--wb-acc); border-radius: 4px; padding: 0.5px 5px; flex: none; font-weight: 700; }
/* 社媒搜索结果页英雄块（贴吧/小红书共用；主色走 --app-acc，皮肤换装自动跟随） */
.ubp-ssearch { margin: 8px 10px 0; border-radius: 12px; padding: 14px 16px; background: var(--app-acc, var(--ubp-accent)); color: var(--app-on-acc, #fff); }
.ubp-ssearch-word { font-size: 16.5px; font-weight: 700; word-break: break-word; }
.ubp-ssearch-stat { font-size: 11px; color: rgba(255, 255, 255, 0.82); margin-top: 5px; }
.ubp-ssearch-host { background: var(--ubp-card); border-radius: 10px; margin: 8px 10px 0; padding: 10px 13px; display: flex; gap: 9px; align-items: center; font-size: 12px; color: var(--ubp-text-2); line-height: 1.5; }
.ubp-ssearch-chip { font-size: 9.5px; color: var(--app-acc, var(--ubp-accent)); border: 1px solid var(--app-acc, var(--ubp-accent)); border-radius: 4px; padding: 0.5px 5px; flex: none; font-weight: 700; }
/* 微博评论 */
.ubp-wb-cmts { background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 2px 0 4px; }
.ubp-wb-cmt { display: flex; gap: 9px; padding: 10px 14px 0; }
.ubp-wb-cmt .ubp-avatar { width: 29px; height: 29px; font-size: 12px; border-radius: 50%; flex: none; }
.ubp-wb-cmtmain { flex: 1; min-width: 0; padding-bottom: 10px; border-bottom: 1px solid var(--ubp-line); }
.ubp-wb-cmt:last-child .ubp-wb-cmtmain { border-bottom: none; }
.ubp-wb-cmtname { font-size: 11.5px; color: var(--wb-topic); font-weight: 600; }
.ubp-wb-cmttext { font-size: 13.5px; color: var(--ubp-text); line-height: 1.55; margin-top: 3px; word-break: break-word; }
.ubp-wb-cmtmeta { display: flex; align-items: center; gap: 12px; margin-top: 5px; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-wb-cmtmeta .like { margin-left: auto; border: none; background: none; cursor: pointer; font-family: var(--ubp-font); color: var(--ubp-text-3); font-size: 10.5px; padding: 0; }
.ubp-wb-cmtmeta .like.on { color: var(--wb-acc); }
.ubp-wb-cmttext b { color: var(--wb-topic); font-weight: 500; }
.ubp-wb-bz { font-style: normal; font-size: 9px; color: #fff; background: #E6A700; border-radius: 4px; padding: 1px 5px; font-weight: 600; margin-left: 5px; flex: none; }
/* 楼中楼：缩进小号评论行（真实微博形态，无气泡；折叠线与楼中楼文字列齐平=24px 头像+9px 间距） */
.ubp-wb-sub { margin-top: 8px; }
.ubp-wb-srow { display: flex; gap: 9px; padding: 0 14px 7px 0; }
.ubp-wb-srow .ubp-avatar { width: 24px; height: 24px; font-size: 9.5px; }
.ubp-wb-srow .ubp-wb-cmtname { font-size: 11px; }
.ubp-wb-srow .ubp-wb-cmttext { font-size: 12.5px; margin-top: 2px; }
.ubp-wb-srow .ubp-wb-cmtmeta { font-size: 10px; margin-top: 4px; }
.ubp-wb-subfold { display: block; border: none; background: none; cursor: pointer; padding: 4px 14px 9px 0; margin-left: 33px; text-align: left; font-family: var(--ubp-font); font-size: 12px; font-weight: 600; color: var(--wb-topic); }
.ubp-ssub-main { flex: 1; min-width: 0; }

/* ── 小红书（xhs：双列瀑布流 + 收藏码住，品牌红 #FF2442） ── */
.ubp-xhs { --xhs-acc: #FF2442; --xhs-star: #E6A700; --xhs-topic: #5B7CD9; --app-acc: #FF2442; --app-on-acc: #fff; --segl: #FF2442; display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.ubp-xhs-search { flex: none; margin: 10px 14px 0; background: var(--ubp-card-2); border-radius: 17px; padding: 8px 14px; font-size: 12px; color: var(--ubp-text-3); }
.ubp-xhs-search b { color: var(--ubp-text); font-weight: 600; }
.ubp-xhs-masonry { columns: 2; column-gap: 7px; padding: 2px 8px 0; }
.ubp-xhs-card { break-inside: avoid; background: var(--ubp-card); border-radius: 10px; overflow: hidden; margin: 0 0 7px; padding: 0; cursor: pointer; width: 100%; text-align: left; border: none; font-family: var(--ubp-font); color: var(--ubp-text); display: block; }
.ubp-xhs-card:active { background: var(--ubp-card-2); }
.ubp-xhs-cover { width: 100%; display: block; }
.ubp-xhs-cover .ubp-mo-imgph, .ubp-xhs-cover .ubp-mo-img { margin: 0; border-radius: 0; border: none; width: 100%; }
.ubp-xhs-cover .ubp-mo-img img { width: 100%; display: block; }
.ubp-xhs-ct { padding: 8px 9px 9px; }
.ubp-xhs-title { font-size: 13px; font-weight: 600; color: var(--ubp-text); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ubp-xhs-cmeta { display: flex; align-items: center; gap: 5px; margin-top: 7px; }
.ubp-xhs-cmeta .ubp-avatar { width: 17px; height: 17px; font-size: 9px; border-radius: 50%; flex: none; }
.ubp-xhs-cname { flex: 1; min-width: 0; font-size: 10.5px; color: var(--ubp-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-xhs-clike { display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--ubp-text-3); flex: none; }
.ubp-xhs-clike svg { width: 11px; height: 11px; color: var(--xhs-acc); }
/* 笔记详情 */
.ubp-xhs-coverbig { position: relative; background: var(--ubp-card-2); }
.ubp-xhs-coverbig .ubp-mo-img, .ubp-xhs-coverbig .ubp-mo-imgph { margin: 0; border-radius: 0; border: none; }
.ubp-xhs-coverbig .ubp-mo-img img { width: 100%; max-height: 430px; object-fit: cover; }
.ubp-xhs-dots { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); display: flex; gap: 4px; }
.ubp-xhs-dots i { width: 5px; height: 5px; border-radius: 50%; background: rgba(255, 255, 255, 0.55); }
.ubp-xhs-dots i.on { background: #fff; }
.ubp-xhs-authorrow { display: flex; align-items: center; gap: 9px; padding: 11px 16px; }
.ubp-xhs-authorrow .ubp-avatar { width: 34px; height: 34px; font-size: 14px; border-radius: 50%; }
.ubp-xhs-aname { flex: 1; min-width: 0; font-size: 13px; color: var(--ubp-text); font-weight: 600; }
.ubp-xhs-follow { background: var(--xhs-acc); color: #fff; font-size: 11.5px; font-weight: 700; padding: 5px 15px; border-radius: 15px; border: none; cursor: pointer; font-family: var(--ubp-font); flex: none; }
.ubp-xhs-ntitle { font-size: 17px; font-weight: 700; color: var(--ubp-text); line-height: 1.4; }
.ubp-xhs-nbody { font-size: 14px; color: var(--ubp-text); line-height: 1.75; margin-top: 10px; white-space: pre-wrap; word-break: break-word; }
.ubp-xhs-ntags { margin-top: 10px; font-size: 13px; color: var(--xhs-topic); line-height: 1.8; word-break: break-word; }
.ubp-xhs-nmeta { margin-top: 10px; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-xhs-div { height: 6px; background: var(--ubp-bg); margin-top: 12px; }
.ubp-xhs-cmthd { padding: 10px 16px 4px; font-size: 11.5px; color: var(--ubp-text-3); }
.ubp-xhs-cmt { display: flex; gap: 9px; padding: 9px 16px; }
.ubp-xhs-cmt .ubp-avatar { width: 28px; height: 28px; font-size: 11px; border-radius: 50%; flex: none; }
.ubp-xhs-cmtmain { flex: 1; min-width: 0; }
.ubp-xhs-cmtname { font-size: 11px; color: var(--ubp-text-3); }
.ubp-xhs-cmttext { font-size: 13.5px; color: var(--ubp-text); line-height: 1.55; margin-top: 3px; word-break: break-word; }
.ubp-xhs-cmttext b { color: var(--xhs-topic); font-weight: 500; }
.ubp-xhs-cmts { background: var(--ubp-card); border-radius: 12px; margin: 8px 10px 0; padding: 2px 0 6px; }
.ubp-xhs-cmtmeta { font-size: 10.5px; color: var(--ubp-text-3); margin-top: 5px; display: flex; align-items: center; gap: 12px; }
.ubp-xhs-auz { font-style: normal; font-size: 9px; color: #fff; background: var(--xhs-acc); border-radius: 4px; padding: 1px 5px; font-weight: 600; margin-left: 5px; flex: none; }
/* 楼中楼：缩进小号评论行（真实小红书形态，无气泡；折叠线与楼中楼文字列齐平=22px 头像+9px 间距） */
.ubp-xhs-sub { margin: 2px 0 4px; }
.ubp-xhs-srow { display: flex; gap: 9px; padding: 5px 16px 4px 0; }
.ubp-xhs-srow .ubp-avatar { width: 22px; height: 22px; font-size: 9px; }
.ubp-xhs-srow .ubp-xhs-cmtname { font-size: 10.5px; }
.ubp-xhs-srow .ubp-xhs-cmttext { font-size: 12.5px; margin-top: 2px; }
.ubp-xhs-srow .ubp-xhs-cmtmeta { font-size: 10px; margin-top: 4px; }
.ubp-xhs-subfold { display: block; border: none; background: none; cursor: pointer; padding: 4px 16px 6px 0; margin-left: 31px; text-align: left; font-family: var(--ubp-font); font-size: 11.5px; font-weight: 600; color: var(--ubp-text-3); }
.ubp-xhs-actionbar { position: sticky; bottom: 0; background: var(--ubp-card); border-top: 1px solid var(--ubp-line); padding: 8px 12px; display: flex; align-items: center; gap: 8px; flex: none; }
.ubp-xhs-ainput { flex: 1; background: var(--ubp-bg); border-radius: 17px; padding: 9px 14px; font-size: 12.5px; color: var(--ubp-text-3); }
.ubp-xhs-aact { position: relative; display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--ubp-text-2); cursor: pointer; flex: none; border: none; background: none; padding: 0; font-family: var(--ubp-font); }
.ubp-xhs-aact svg { width: 17px; height: 17px; }
.ubp-xhs-aact.on { color: var(--app-acc, var(--ubp-accent)); }
.ubp-xhs-aact.star.on { color: var(--xhs-star); }
/* ── 点亮反馈（第六轮 ⑥）：成对图标（like/likeFill、star/starFill）+ 一次性脉冲 ──
   动作钮容器必须 position: relative（.ubp-wb-act / .ubp-xhs-aact / .ubp-nz-stat 三处已加）。
   脉冲类由 phone-ui 的 pulseActIcon 在**重绘之后**显式挂一次：图标回弹一次 + 右上角浮出「+1」，约 1s 后自清。
   **不能**把动画挂在 .on 状态上——App 每次 data-changed 都整块重绘 innerHTML，那样每帧重绘都会重播动画。 */
@keyframes ubp-act-pop {
  0% { transform: scale(1); } 30% { transform: scale(1.34); } 55% { transform: scale(0.9); }
  78% { transform: scale(1.06); } 100% { transform: scale(1); }
}
@keyframes ubp-like-fly {
  0% { opacity: 0; transform: translateY(2px) scale(0.8); }
  22% { opacity: 1; }
  100% { opacity: 0; transform: translateY(-15px) scale(1); }
}
.ubp-act-pulse svg { animation: ubp-act-pop 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.ubp-act-pulse::after {
  content: '+1'; position: absolute; right: 1px; top: -7px; font-size: 10px; font-weight: 800;
  color: var(--ubp-badge); pointer-events: none; animation: ubp-like-fly 0.9s ease-out both;
}
/* 减弱动效：只留「实心/线性」这个形状差别，不播脉冲（形状差别才是语义，动画只是加味） */
@media (prefers-reduced-motion: reduce) {
  .ubp-act-pulse svg, .ubp-act-pulse::after { animation: none; }
  .ubp-act-pulse::after { display: none; }
}
/* 发布笔记（全页面，对照 mockup x-compose） */
.ubp-xhs-compose { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.ubp-xhs-cp-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 10px; }
.ubp-xhs-cp-cover {
  width: 104px; height: 104px; border-radius: 12px; border: none; cursor: pointer; padding: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  background: var(--ubp-card-2); color: var(--ubp-text-3); font-family: var(--ubp-font); font-size: 11px; overflow: hidden;
}
.ubp-xhs-cp-cover svg { width: 22px; height: 22px; }
.ubp-xhs-cp-cover img { width: 100%; height: 100%; object-fit: cover; }
.ubp-xhs-cp-title {
  width: 100%; border: none; outline: none; font-size: 17px; font-weight: 700; color: var(--ubp-text);
  padding: 16px 0 10px; font-family: var(--ubp-font); background: none;
}
.ubp-xhs-cp-text {
  width: 100%; border: none; outline: none; font-size: 14px; line-height: 1.7; resize: none;
  color: var(--ubp-text); min-height: 140px; font-family: var(--ubp-font); background: none;
}
/* 话题标签行：与标题/正文同为「无框行内输入」，只保留一条分隔线。
   input 必须显式清 border/background/width——UA 默认（inset 边框 + Field 不透明底 + size 宽度）
   在浅色下是灰框、深色下是白底黑字，与整页脱节且超出容器被父级 overflow 裁断。 */
.ubp-xhs-cp-tags {
  display: block; width: 100%; margin: 0; padding: 11px 0 0;
  border: none; border-top: 1px solid var(--ubp-line); background: none; outline: none;
  font-size: 13.5px; color: var(--xhs-topic); font-family: var(--ubp-font);
}
.ubp-xhs-cp-tags::placeholder { color: var(--ubp-text-3); }
.ubp-xhs-cp-bar { flex: none; background: var(--ubp-card); border-top: 1px solid var(--ubp-line); padding: 8px 14px; display: flex; align-items: center; gap: 10px; }
.ubp-xhs-cp-hint { flex: 1; font-size: 11px; color: var(--ubp-text-3); }
.ubp-xhs-cp-pub {
  border: none; background: var(--xhs-acc); color: #fff; font-size: 13px; font-weight: 700;
  padding: 8px 26px; border-radius: 17px; cursor: pointer; font-family: var(--ubp-font);
}
.ubp-xhs-cp-pub:disabled { opacity: 0.45; }
.ubp-xhs-cp-pub:active { filter: brightness(0.92); }

/* ══ 仙侠·玄青皮肤（.ubp-skin-xianxia 挂 scope 根，与 .ubp-dark 正交叠加；docs/11 §8） ══
   意象：玄青夜空 / 青玉 / 鎏金 / 符箓微光。暗档为主视觉，亮档（青玉白）同样成立。
   全量静态注入（无运行时开销）；不触及现代路径的任何规则。 */
.ubp-scope.ubp-skin-xianxia {
  --ubp-bg: #EDF4F0;
  --ubp-card: #F7FBF9;
  --ubp-card-2: #EAF2EE;
  --ubp-text: #1E2B26;
  --ubp-text-2: #5F7A6E;
  --ubp-text-3: #8AA094;
  --ubp-line: rgba(30, 43, 38, 0.13);
  --ubp-accent: #2FA57E;
  --ubp-accent-press: #278C6C;
  --ubp-accent-soft: rgba(47, 165, 126, 0.14);
  --ubp-danger: #B03A2E;
  --ubp-danger-soft: rgba(176, 58, 46, 0.1);
  --ubp-bubble-me: #CDEBDD;
  --ubp-bubble-me-text: #123B2C;
  --ubp-bubble-other: #F7FBF9;
  --ubp-badge: #B03A2E;
  --ubp-link: #7A5F1E;
  --ubp-overlay: rgba(10, 18, 15, 0.5);
  --ubp-frame: #14201C;
  --ubp-shadow: 0 18px 50px rgba(0, 0, 0, 0.42);
  --ubp-decor: #A9832F;
  --ubp-font: "Kaiti SC", "STKaiti", "KaiTi", "BiauKai", "DFKai-SB", "Noto Serif SC", serif;
}
.ubp-scope.ubp-skin-xianxia.ubp-dark {
  --ubp-bg: #0F1A17;
  --ubp-card: #16231F;
  --ubp-card-2: #1C2B26;
  --ubp-text: #CFE2D8;
  --ubp-text-2: #7E948A;
  --ubp-text-3: #6F8A7E;
  --ubp-line: rgba(217, 180, 92, 0.14);
  --ubp-accent: #63D6AC;
  --ubp-accent-press: #4FBF93;
  --ubp-accent-soft: rgba(99, 214, 172, 0.12);
  --ubp-bubble-me: #245743;
  --ubp-bubble-me-text: #DFF5EA;
  --ubp-bubble-other: #16231F;
  --ubp-link: #D9B45C;
  --ubp-decor: #D9B45C;
  --ubp-frame: #14201C;
}
/* 机身：玉质深青 + 鎏金双细边；悬浮球同材质 */
.ubp-skin-xianxia .ubp-phone {
  background: linear-gradient(160deg, #1A2B25, #12201B 55%, #0E1815);
  box-shadow: var(--ubp-shadow), inset 0 0 0 2px rgba(217, 180, 92, 0.26), inset 0 0 0 4px rgba(217, 180, 92, 0.07);
}
.ubp-skin-xianxia .ubp-ball {
  background: linear-gradient(160deg, #1A2B25, #101D18);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45), inset 0 0 0 1.5px rgba(217, 180, 92, 0.4);
}
.ubp-skin-xianxia .ubp-notch { background: #0A120F; box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.22); }
.ubp-skin-xianxia .ubp-screen {
  background:
    radial-gradient(120% 55% at 50% -8%, rgba(99, 214, 172, 0.09), transparent 60%),
    radial-gradient(90% 40% at 82% 4%, rgba(217, 180, 92, 0.06), transparent 55%),
    var(--ubp-bg);
}
.ubp-skin-xianxia .ubp-homebar-pill { background: var(--ubp-decor); opacity: 0.4; }
/* 桌面：玄青云海（无自定义壁纸时的默认底）；has-bg 壁纸与蒙层规则继承现代路径 */
.ubp-skin-xianxia .ubp-home:not(.has-bg) {
  background:
    linear-gradient(180deg, rgba(10, 18, 15, 0) 0%, rgba(10, 18, 15, 0.5) 78%),
    radial-gradient(130% 60% at 50% 108%, rgba(27, 58, 46, 0.9), rgba(15, 26, 23, 0) 62%),
    radial-gradient(60% 26% at 24% 84%, rgba(31, 74, 58, 0.6), transparent 70%),
    radial-gradient(46% 22% at 76% 80%, rgba(27, 64, 50, 0.55), transparent 70%),
    linear-gradient(180deg, #0C1512, #101D18);
}
.ubp-skin-xianxia.ubp-dark .ubp-home:not(.has-bg) { color: #D8E8DF; }
.ubp-skin-xianxia .ubp-home:not(.has-bg) .ubp-home-date,
.ubp-skin-xianxia .ubp-home:not(.has-bg) .ubp-home-wdesc,
.ubp-skin-xianxia .ubp-home:not(.has-bg) .ubp-home-loc { color: #9DB8AC; }
.ubp-skin-xianxia .ubp-home:not(.has-bg) .ubp-home-wmain { color: #DFF5EA; }
.ubp-skin-xianxia .ubp-home:not(.has-bg) .ubp-appname { color: #D8E8DF; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7); }
.ubp-skin-xianxia.ubp-dark .ubp-home:not(.has-bg) .ubp-home-time { text-shadow: 0 0 18px rgba(99, 214, 172, 0.35); }
/* App 图标：玉璧圆形（双圈金环 + 微光） */
.ubp-skin-xianxia .ubp-appicon {
  border-radius: 50%;
  box-shadow: 0 0 10px rgba(99, 214, 172, 0.16), inset 0 0 0 1.5px rgba(217, 180, 92, 0.5), inset 0 0 10px rgba(217, 180, 92, 0.1);
}
/* 聊天气泡：me=玉青符纸+微光边；other=细金线描边 */
.ubp-skin-xianxia .ubp-msg-row.me .ubp-bubble {
  box-shadow: 0 0 10px rgba(99, 214, 172, 0.13), inset 0 0 0 1px rgba(217, 180, 92, 0.3);
}
.ubp-skin-xianxia:not(.ubp-dark) .ubp-msg-row.me .ubp-bubble { box-shadow: inset 0 0 0 1px rgba(169, 131, 47, 0.25); }
.ubp-skin-xianxia .ubp-bubble,
.ubp-skin-xianxia .ubp-voice { box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.14); }
.ubp-skin-xianxia:not(.ubp-dark) .ubp-bubble,
.ubp-skin-xianxia:not(.ubp-dark) .ubp-voice { box-shadow: inset 0 0 0 1px rgba(30, 43, 38, 0.08); }
.ubp-skin-xianxia .ubp-avatar,
.ubp-skin-xianxia .ubp-cl-avatar { box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.35); }
/* 系统气泡：金玉底 */
.ubp-skin-xianxia .ubp-sys-msg { background: rgba(217, 180, 92, 0.1); color: #A9863C; box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.16); }
.ubp-skin-xianxia.ubp-dark .ubp-sys-msg { color: #C9B87A; }
.ubp-skin-xianxia .ubp-sys-msg.error { background: var(--ubp-danger-soft); color: var(--ubp-danger); box-shadow: none; }
/* 时间条与系统消息同色系（公告层两元素必须一致；默认皮肤用 --ubp-notice-* 深色胶囊） */
.ubp-skin-xianxia .ubp-time-divider { background: rgba(217, 180, 92, 0.1); color: #A9863C; box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.16); }
.ubp-skin-xianxia.ubp-dark .ubp-time-divider { color: #C9B87A; }
/* 灵石转让 / 灵石福袋卡 */
.ubp-skin-xianxia .ubp-card.transfer { background: linear-gradient(135deg, #2A5A48, #1E4536); color: #DFF5EA; box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.35); }
.ubp-skin-xianxia .ubp-card.redpacket { background: linear-gradient(135deg, #C9A24B, #A9832F); color: #26301C; box-shadow: 0 0 12px rgba(217, 180, 92, 0.22); }
.ubp-skin-xianxia .ubp-rp-icon { background: rgba(255, 244, 214, 0.28); }
.ubp-skin-xianxia .ubp-rp-icon svg { color: #FFF4D6; }
.ubp-skin-xianxia .ubp-card-glyph { background: rgba(255, 244, 214, 0.22); }
/* 顶栏/分段：金线描边 */
.ubp-skin-xianxia .ubp-appbar { background: linear-gradient(180deg, var(--ubp-card), var(--ubp-card)); }
.ubp-skin-xianxia.ubp-dark .ubp-appbar { background: linear-gradient(180deg, #182620, #141F1B); }
/* 通话全屏层：玄青深底 + 鎏金共鸣环（仅通话层存在期间） */
.ubp-skin-xianxia .ubp-call-screen {
  background:
    radial-gradient(90% 42% at 50% 30%, rgba(99, 214, 172, 0.1), transparent 65%),
    linear-gradient(180deg, #0E1A16, #0B1411);
  color: #DFF5EA;
}
.ubp-skin-xianxia .ubp-call-avatar { position: relative; box-shadow: 0 0 26px rgba(99, 214, 172, 0.3), inset 0 0 14px rgba(217, 180, 92, 0.18); }
.ubp-skin-xianxia .ubp-call-avatar::before,
.ubp-skin-xianxia .ubp-call-avatar::after {
  content: ""; position: absolute; inset: -11px; border-radius: 50%;
  border: 1px dashed rgba(217, 180, 92, 0.42); pointer-events: none;
}
.ubp-skin-xianxia .ubp-call-avatar::after { inset: -22px; border-style: solid; border-color: rgba(217, 180, 92, 0.16); }
.ubp-skin-xianxia .ubp-call-avatar.ringing::before { animation: ubp-xx-ring 2.4s linear infinite; }
@keyframes ubp-xx-ring { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.ubp-skin-xianxia .ubp-call-line.peer { background: #1E3A2F; color: #DFF5EA; border: 1px solid rgba(217, 180, 92, 0.16); }
.ubp-skin-xianxia .ubp-call-line.me { background: #245743; color: #DFF5EA; }
.ubp-skin-xianxia .ubp-call-hint { background: rgba(22, 35, 31, 0.92); }
.ubp-skin-xianxia .ubp-call-btn { background: rgba(217, 180, 92, 0.08); color: #D8C289; box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.28); }
.ubp-skin-xianxia .ubp-call-btn.speak,
.ubp-skin-xianxia .ubp-call-btn.on { background: #D9B45C; color: #0E1815; }
.ubp-skin-xianxia .ubp-call-btn.end { background: linear-gradient(160deg, #8C3226, #6E241C); color: #F2D9C8; box-shadow: 0 5px 16px rgba(140, 50, 38, 0.4), inset 0 0 0 1px rgba(217, 180, 92, 0.35); }
.ubp-skin-xianxia .ubp-call-btn.accept { background: linear-gradient(160deg, #2FA57E, #1C5038); color: #DFF5EA; }
.ubp-skin-xianxia .ubp-call-mutebadge { color: #D9B45C; background: rgba(217, 180, 92, 0.14); }
.ubp-skin-xianxia .ubp-dialer-call { box-shadow: 0 4px 12px rgba(47, 165, 126, 0.35); }
/* ── 百晓阁（仙侠微博）：鎏金 + 朱砂点缀 ── */
.ubp-skin-xianxia .ubp-wb { --wb-acc: var(--ubp-decor); --wb-org: var(--ubp-decor); --wb-topic: var(--ubp-decor); --app-acc: var(--ubp-decor); --segl: var(--ubp-decor); }
.ubp-skin-xianxia .ubp-wb .ubp-stop { background: linear-gradient(180deg, #182620, #141F1B); border-bottom: 1px solid rgba(217, 180, 92, 0.22); }
.ubp-skin-xianxia:not(.ubp-dark) .ubp-wb .ubp-stop { background: linear-gradient(180deg, #F2F7F4, #EAF2EE); }
.ubp-skin-xianxia .ubp-wb .ubp-stop-search { background: rgba(217, 180, 92, 0.07); color: #9DB8AC; box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.2); }
.ubp-skin-xianxia:not(.ubp-dark) .ubp-wb .ubp-stop-search { color: #5F7A6E; }
.ubp-skin-xianxia .ubp-wb .ubp-stop-acts .ubp-iconbtn { color: #C9B87A; }
.ubp-skin-xianxia:not(.ubp-dark) .ubp-wb .ubp-stop-acts .ubp-iconbtn { color: #A9832F; }
/* 玉印「晓」方印（顶栏阁徽） */
.ubp-wb-seal0 {
  width: 30px; height: 30px; flex: none; border-radius: 6px;
  background: linear-gradient(160deg, #C9A24B, #A9832F); color: #1C130A;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 17px;
  box-shadow: 0 0 10px rgba(217, 180, 92, 0.35), inset 0 0 0 1.5px rgba(255, 244, 214, 0.55);
}
/* 印章符记（玉符/金符/官符） */
.ubp-wb-seal {
  width: 15px; height: 15px; flex: none; border-radius: 3px; font-size: 9.5px; font-style: normal;
  display: inline-flex; align-items: center; justify-content: center;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
}
.ubp-wb-seal.yu { background: #2E7D5B; color: #DFF5EA; }
.ubp-wb-seal.jin { background: #C9A24B; color: #241A08; }
.ubp-wb-seal.guan { background: #A93226; color: #FFE9E4; }
/* 风闻榜牌卡（首页 hero） */
.ubp-wb-board {
  margin-top: 8px; padding: 9px 11px; border-radius: 10px;
  background: linear-gradient(160deg, #1B2A24, #141F1B);
  border: 1px solid rgba(217, 180, 92, 0.4);
  box-shadow: inset 0 0 0 3px rgba(217, 180, 92, 0.08), 0 0 14px rgba(217, 180, 92, 0.1);
}
.ubp-skin-xianxia:not(.ubp-dark) .ubp-wb-board { background: linear-gradient(160deg, #F6FAF7, #EFF5F1); }
.ubp-wb-board-hd { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: var(--ubp-decor); letter-spacing: 2px; }
.ubp-wb-board-more { border: none; background: none; cursor: pointer; font-size: 10.5px; color: #7E948A; letter-spacing: 0; font-family: var(--ubp-font); padding: 0; }
.ubp-wb-board-row { display: flex; align-items: center; gap: 7px; font-size: 12.5px; margin-top: 7px; color: var(--ubp-text); cursor: pointer; }
.ubp-wb-board-row:active { opacity: 0.7; }
.ubp-wb-board-word { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-wb-board-num { flex: none; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-wb-btag {
  flex: none; min-width: 17px; height: 17px; padding: 0 2px; border-radius: 3px; font-size: 10.5px;
  display: inline-flex; align-items: center; justify-content: center; font-weight: 700;
}
.ubp-wb-btag.惊 { background: #B03A2E; color: #FFE9E4; }
.ubp-wb-btag.扬 { background: rgba(217, 180, 92, 0.85); color: #241A08; }
.ubp-wb-btag.议 { background: rgba(217, 180, 92, 0.55); color: #241A08; }
.ubp-wb-btag.新 { background: rgba(99, 214, 172, 0.35); color: #0E241B; }
/* 市井/故人筛选 chips */
.ubp-wb-chips { display: flex; gap: 7px; margin-top: 8px; padding-bottom: 8px; }
.ubp-wb-chip {
  border: 1px solid rgba(217, 180, 92, 0.22); background: rgba(217, 180, 92, 0.06);
  color: var(--ubp-text-2); border-radius: 11px; padding: 3px 13px; font-size: 11.5px;
  cursor: pointer; font-family: var(--ubp-font);
}
.ubp-wb-chip.on { color: #141F1B; background: var(--ubp-decor); border-color: var(--ubp-decor); font-weight: 700; }
.ubp-skin-xianxia:not(.ubp-dark) .ubp-wb-chip.on { color: #FFF8E8; }
/* 风闻帖卡：宣纸暗纹 */
.ubp-skin-xianxia .ubp-wb-card {
  background:
    repeating-linear-gradient(0deg, rgba(217, 180, 92, 0.015) 0 2px, transparent 2px 6px),
    linear-gradient(175deg, rgba(22, 35, 31, 0.94), rgba(18, 29, 25, 0.94));
  box-shadow: inset 0 0 0 1px rgba(217, 180, 92, 0.14);
}
.ubp-skin-xianxia:not(.ubp-dark) .ubp-wb-card { background: var(--ubp-card); }
.ubp-skin-xianxia .ubp-wb-repost { background: rgba(217, 180, 92, 0.05); box-shadow: inset 2px 0 0 rgba(217, 180, 92, 0.55); border-radius: 0 8px 8px 0; }
.ubp-skin-xianxia .ubp-wb-act.on { color: var(--ubp-decor); }
.ubp-skin-xianxia .ubp-wb-topic-hero { background: linear-gradient(160deg, #C9A24B, #A9832F); color: #26301C; }
.ubp-skin-xianxia .ubp-wb-topic-hero .ubp-wb-topic-stat { color: rgba(38, 48, 28, 0.8); }
.ubp-skin-xianxia .ubp-wb-topic-chip { color: var(--ubp-decor); border-color: var(--ubp-decor); }
.ubp-skin-xianxia .ubp-wb-hotrow:active { background: rgba(217, 180, 92, 0.06); }
.ubp-skin-xianxia .ubp-sfoot-tab.plus .ico { border-radius: 50%; background: linear-gradient(160deg, #D9B45C, #B8933F); color: #1C130A; box-shadow: 0 0 12px rgba(217, 180, 92, 0.4); }
.ubp-skin-xianxia .ubp-replybar .go { background: var(--ubp-decor); color: #1C130A; }
/* 仙侠榜单 tag（热搜枚举 惊/扬/议/新 的中文类名选择器，同现代 .bao 系用法） */
.ubp-skin-xianxia .ubp-wb-tag.爆 { background: #B03A2E; }
.ubp-skin-xianxia .ubp-wb-tag.沸 { background: #A93226; }
.ubp-skin-xianxia .ubp-wb-tag.热 { background: #A9832F; }
.ubp-skin-xianxia .ubp-wb-tag.新 { background: #2FA57E; }
.ubp-skin-xianxia .ubp-wb-tag.惊 { background: #B03A2E; }
.ubp-skin-xianxia .ubp-wb-tag.扬 { background: #A9832F; }
.ubp-skin-xianxia .ubp-wb-tag.议 { background: #8A6D1F; }

/* ══ 共用：皮肤社媒品牌行 / 印记徽标 / 桌面单字图标（docs/11；仅皮肤模式渲染） ══ */
.ubp-wb-brandrow { display: flex; align-items: center; gap: 9px; padding: 8px 0 10px; }
.ubp-wb-brand { width: 34px; height: 42px; flex: none; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 21px; font-weight: 700; position: relative; }
.ubp-wb-brandname { flex: 1; min-width: 0; }
.ubp-wb-brandname .n { font-size: 15.5px; letter-spacing: 3px; }
.ubp-wb-brandname .s { font-size: 9px; letter-spacing: 2px; margin-top: 2px; opacity: 0.75; }
/* 木牌名号（武侠认证：侠/宗/官） */
.ubp-wb-mupai {
  width: 15px; height: 18px; border-radius: 2.5px; font-size: 10px; font-style: normal;
  display: inline-flex; align-items: center; justify-content: center; vertical-align: -3px;
  color: #F6EFDC; background: linear-gradient(180deg, #8A6834, #6B4E30);
  box-shadow: inset 0 0 0 1px rgba(255, 238, 196, 0.35);
}
.ubp-wb-mupai.zong { background: linear-gradient(180deg, #C9A45C, #A9832F); color: #241A08; }
.ubp-wb-mupai.guan { background: linear-gradient(180deg, #40506B, #2C3A52); }
/* 火漆印记（西幻认证：诗/宫/国） */
.ubp-wb-wax {
  width: 16px; height: 16px; border-radius: 47% 53% 44% 56%; font-size: 10px; font-style: normal;
  display: inline-flex; align-items: center; justify-content: center; vertical-align: -3px;
  color: #F5E0D0; background: radial-gradient(circle at 36% 32%, #A05252, #7D2A3A 72%);
  box-shadow: inset 0 0 0 1.5px rgba(240, 210, 160, 0.4), 0 0 4px rgba(160, 82, 82, 0.35);
}
.ubp-wb-wax.gong { background: radial-gradient(circle at 36% 32%, #C8A24E, #9A7824); color: #33240A; }
.ubp-wb-wax.guo { background: radial-gradient(circle at 36% 32%, #5A6AA8, #3E4C82); }
/* 桌面单字图标（皮肤社媒 App：阁/茶/诗） */
.ubp-skin-glyph { font-size: calc(var(--ubp-icon-size, 54px) * 0.4444); font-weight: 700; color: #F6EFDC; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); line-height: 1; }

/* ══ 武侠·惊堂皮肤（.ubp-skin-wuxia；docs/11） ══
   意象：天机匣（墨家机关匣）——宣纸 / 水墨 / 朱砂 / 黄铜 / 竹青；宋体（话本印刷感）。
   亮档=宣纸日（主视觉），暗档=夜行墨。全量静态注入；不触及现代路径。 */
.ubp-scope.ubp-skin-wuxia {
  --ubp-bg: #F2E9D3;
  --ubp-card: #FAF4E2;
  --ubp-card-2: #F0E6CC;
  --ubp-text: #33291B;
  --ubp-text-2: #71624A;
  --ubp-text-3: #99896B;
  --ubp-line: rgba(87, 61, 29, 0.18);
  --ubp-accent: #47714F;
  --ubp-accent-press: #3A5D41;
  --ubp-accent-soft: rgba(71, 113, 79, 0.12);
  --ubp-danger: #8E3B2C;
  --ubp-danger-soft: rgba(142, 59, 44, 0.09);
  --ubp-bubble-me: #DFE9C6;
  --ubp-bubble-me-text: #2C3B20;
  --ubp-bubble-other: #FAF4E2;
  --ubp-badge: #A93226;
  --ubp-link: #34556E;
  --ubp-overlay: rgba(24, 18, 10, 0.5);
  --ubp-frame: #2A2013;
  --ubp-shadow: 0 18px 50px rgba(30, 20, 8, 0.4);
  --ubp-decor: #9C6B2F;
  --ubp-font: "Songti SC", "STSong", SimSun, "FangSong", "Noto Serif SC", serif;
  background-image:
    repeating-linear-gradient(0deg, rgba(122, 96, 55, 0.022) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(92deg, rgba(122, 96, 55, 0.015) 0 2px, transparent 2px 5px);
}
.ubp-scope.ubp-skin-wuxia.ubp-dark {
  --ubp-bg: #1D1A13;
  --ubp-card: #262217;
  --ubp-card-2: #2E2819;
  --ubp-text: #E6DCC2;
  --ubp-text-2: #A6987C;
  --ubp-text-3: #8A7C60;
  --ubp-line: rgba(201, 164, 92, 0.16);
  --ubp-accent: #7FAE7E;
  --ubp-accent-press: #6B986B;
  --ubp-accent-soft: rgba(127, 174, 126, 0.12);
  --ubp-bubble-me: #33452F;
  --ubp-bubble-me-text: #E9F0DC;
  --ubp-bubble-other: #262217;
  --ubp-link: #9DB4D8;
  --ubp-decor: #C9A45C;
}
/* 机身：黑檀木匣 + 黄铜双细边；悬浮球同材质木壳 */
.ubp-skin-wuxia .ubp-phone {
  background: linear-gradient(160deg, #38301F, #241C10 55%, #1A140B);
  box-shadow: var(--ubp-shadow), inset 0 0 0 2px #171310, inset 0 0 0 4px #B08A4F, inset 0 0 0 5px rgba(92, 69, 31, 0.9);
}
.ubp-skin-wuxia .ubp-ball {
  background: linear-gradient(160deg, #4A3A22, #241A0E);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45), inset 0 0 0 1.5px rgba(201, 164, 92, 0.5);
}
.ubp-skin-wuxia .ubp-notch { background: #171310; box-shadow: inset 0 0 0 1px rgba(201, 164, 92, 0.4); }
.ubp-skin-wuxia .ubp-screen { background: var(--ubp-bg); }
.ubp-skin-wuxia .ubp-homebar-pill { background: #A93226; opacity: 0.55; }
/* 桌面：宣纸水墨远山（亮档主视觉）+ 朱印水印 + 竖排闲句 */
.ubp-skin-wuxia .ubp-home:not(.has-bg) {
  background:
    linear-gradient(180deg, rgba(38, 28, 16, 0) 0%, rgba(38, 28, 16, 0.06) 78%),
    radial-gradient(46% 12% at 76% 76%, rgba(52, 47, 38, 0.34), transparent 72%),
    radial-gradient(60% 16% at 22% 82%, rgba(66, 60, 48, 0.28), transparent 74%),
    radial-gradient(30% 9% at 50% 88%, rgba(44, 40, 33, 0.22), transparent 70%),
    linear-gradient(180deg, #F4ECD8, #EFE4C9 62%, #E6D8B8);
}
.ubp-skin-wuxia .ubp-home:not(.has-bg)::after {
  content: "侠"; position: absolute; top: 96px; right: 16px; width: 52px; height: 52px;
  border: 2.5px solid rgba(169, 50, 38, 0.32); border-radius: 7px; transform: rotate(9deg);
  display: flex; align-items: center; justify-content: center;
  color: rgba(169, 50, 38, 0.32); font-size: 28px; font-weight: 700;
  box-shadow: inset 0 0 0 1px rgba(169, 50, 38, 0.16); pointer-events: none;
}
.ubp-skin-wuxia .ubp-home:not(.has-bg)::before {
  content: "人在江湖 · 生死不远"; position: absolute; top: 176px; right: 22px;
  writing-mode: vertical-rl; letter-spacing: 7px; font-size: 12px;
  color: rgba(74, 61, 40, 0.5); pointer-events: none;
}
.ubp-skin-wuxia.ubp-dark .ubp-home:not(.has-bg) {
  background:
    radial-gradient(46% 12% at 76% 74%, rgba(201, 164, 92, 0.1), transparent 72%),
    radial-gradient(60% 16% at 22% 80%, rgba(160, 140, 100, 0.08), transparent 74%),
    linear-gradient(180deg, #211C12, #1A160E);
}
.ubp-skin-wuxia.ubp-dark .ubp-home:not(.has-bg)::after { border-color: rgba(201, 164, 92, 0.3); color: rgba(201, 164, 92, 0.3); box-shadow: inset 0 0 0 1px rgba(201, 164, 92, 0.14); }
.ubp-skin-wuxia.ubp-dark .ubp-home:not(.has-bg)::before { color: rgba(201, 164, 92, 0.4); }
/* App 图标：木质招牌（铜边 + 顶部挂环） */
.ubp-skin-wuxia .ubp-appicon {
  border-radius: 9px;
  box-shadow: inset 0 0 0 1.5px rgba(214, 178, 118, 0.75), inset 0 0 0 3.5px rgba(60, 42, 22, 0.35), 0 3px 7px rgba(52, 40, 20, 0.38);
}
.ubp-skin-wuxia .ubp-appicon::before {
  content: ""; position: absolute; top: -3.5px; left: 50%; transform: translateX(-50%);
  width: 10px; height: 5.5px; border: 1.6px solid #B08A4F; border-top: none;
  border-radius: 0 0 6px 6px; background: var(--ubp-bg);
}
.ubp-skin-wuxia .ubp-appname { letter-spacing: 1px; }
/* 聊天气泡：信笺（左墨线 + 方角收笔）；头像铜圈圆 */
.ubp-skin-wuxia .ubp-msg-row.me .ubp-bubble {
  border-radius: 10px 2px 2px 10px;
  box-shadow: inset 0 0 0 1px rgba(84, 106, 62, 0.4), inset 3px 0 0 rgba(84, 106, 62, 0.32);
}
.ubp-skin-wuxia .ubp-msg-row:not(.me) .ubp-bubble {
  border-radius: 2px 10px 10px 2px;
  box-shadow: inset 0 0 0 1px rgba(87, 61, 29, 0.22), inset 3px 0 0 rgba(87, 61, 29, 0.14);
}
.ubp-skin-wuxia .ubp-avatar,
.ubp-skin-wuxia .ubp-cl-avatar { border-radius: 50%; box-shadow: inset 0 0 0 1.5px rgba(201, 164, 92, 0.55); }
.ubp-skin-wuxia .ubp-avatar.small { border-radius: 50%; }
.ubp-skin-wuxia .ubp-voice { box-shadow: inset 0 0 0 1px rgba(87, 61, 29, 0.22); border-radius: 2px 10px 10px 2px; }
/* 系统气泡：木牍条 */
.ubp-skin-wuxia .ubp-sys-msg { background: rgba(176, 138, 79, 0.13); color: #8A5A2B; box-shadow: inset 0 0 0 1px rgba(176, 138, 79, 0.32); border-radius: 3px; }
.ubp-skin-wuxia.ubp-dark .ubp-sys-msg { color: #C9A96A; }
.ubp-skin-wuxia .ubp-sys-msg.error { background: var(--ubp-danger-soft); color: var(--ubp-danger); box-shadow: none; }
.ubp-skin-wuxia .ubp-time-divider { background: rgba(176, 138, 79, 0.13); color: #8A5A2B; box-shadow: inset 0 0 0 1px rgba(176, 138, 79, 0.32); }
.ubp-skin-wuxia.ubp-dark .ubp-time-divider { color: #C9A96A; }
/* 银票汇兑 / 赏钱封 */
.ubp-skin-wuxia .ubp-card.transfer {
  background: repeating-linear-gradient(45deg, rgba(169, 50, 38, 0.05) 0 8px, transparent 8px 16px), linear-gradient(165deg, #F3E3C0, #E9D3A4);
  color: #5C2018; border-radius: 4px;
  box-shadow: inset 0 0 0 1.5px #A93226, inset 0 0 0 4px rgba(169, 50, 38, 0.12), inset 0 0 0 5.5px rgba(169, 50, 38, 0.35);
}
.ubp-skin-wuxia .ubp-card.transfer b, .ubp-skin-wuxia .ubp-card.transfer .amt { color: #5C2018; }
.ubp-skin-wuxia .ubp-card.redpacket {
  background: linear-gradient(160deg, #B03A2E, #8E2A20); color: #FFE9D8; border-radius: 4px;
  box-shadow: inset 0 0 0 1.5px rgba(255, 224, 178, 0.65), inset 0 0 0 4px rgba(142, 42, 32, 0.8), 0 2px 8px rgba(142, 42, 32, 0.35);
}
.ubp-skin-wuxia .ubp-rp-icon { background: rgba(255, 224, 178, 0.22); }
.ubp-skin-wuxia .ubp-rp-icon svg { color: #FFE9C8; }
.ubp-skin-wuxia .ubp-card-glyph { background: rgba(255, 244, 214, 0.22); }
/* 顶栏：宣纸横披 */
.ubp-skin-wuxia .ubp-appbar { background: linear-gradient(180deg, #F6EFDC, #EFE5C9); box-shadow: inset 0 -1px 0 rgba(87, 61, 29, 0.22); }
.ubp-skin-wuxia.ubp-dark .ubp-appbar { background: linear-gradient(180deg, #2A2418, #221C12); }
/* 通话全屏层：竹节夜底 + 黄铜双环 */
.ubp-skin-wuxia .ubp-call-screen {
  background:
    radial-gradient(90% 42% at 50% 28%, rgba(176, 138, 79, 0.13), transparent 66%),
    linear-gradient(180deg, #221B10, #171208);
  color: #E8DCC0;
}
.ubp-skin-wuxia .ubp-call-avatar { position: relative; box-shadow: 0 0 24px rgba(176, 138, 79, 0.25), inset 0 0 12px rgba(0, 0, 0, 0.4); }
.ubp-skin-wuxia .ubp-call-avatar::before,
.ubp-skin-wuxia .ubp-call-avatar::after {
  content: ""; position: absolute; inset: -11px; border-radius: 50%; pointer-events: none;
  border: 1.5px dashed rgba(176, 138, 79, 0.6);
}
.ubp-skin-wuxia .ubp-call-avatar::after {
  inset: -21px; border: 5px solid transparent;
  border-top-color: rgba(176, 138, 79, 0.38); border-bottom-color: rgba(176, 138, 79, 0.2);
}
.ubp-skin-wuxia .ubp-call-avatar.ringing::before { animation: ubp-xx-ring 2.4s linear infinite; }
.ubp-skin-wuxia .ubp-call-line.peer { background: #33291A; color: #E8DCC0; border: 1px solid rgba(176, 138, 79, 0.3); }
.ubp-skin-wuxia .ubp-call-line.me { background: #3B4A2E; color: #E9F0DC; box-shadow: inset 3px 0 0 rgba(176, 138, 79, 0.5); }
.ubp-skin-wuxia .ubp-call-hint { background: rgba(34, 27, 16, 0.92); }
.ubp-skin-wuxia .ubp-call-btn { background: rgba(176, 138, 79, 0.12); color: #C9A96A; box-shadow: inset 0 0 0 1.2px rgba(176, 138, 79, 0.45); }
.ubp-skin-wuxia .ubp-call-btn.speak,
.ubp-skin-wuxia .ubp-call-btn.on { background: #B08A4F; color: #241A08; }
.ubp-skin-wuxia .ubp-call-btn.end { background: linear-gradient(160deg, #8C2A1E, #6E1F16); color: #F2D9C8; box-shadow: inset 0 0 0 1.5px rgba(176, 138, 79, 0.5), 0 5px 14px rgba(140, 42, 30, 0.4); }
.ubp-skin-wuxia .ubp-call-btn.accept { background: linear-gradient(160deg, #4E7A55, #3D6244); color: #EFF6E4; }
.ubp-skin-wuxia .ubp-call-mutebadge { color: #C9A96A; background: rgba(176, 138, 79, 0.14); }
.ubp-skin-wuxia .ubp-dialer-call { background: linear-gradient(165deg, #4E7A55, #3D6244); box-shadow: inset 0 0 0 1.5px rgba(230, 240, 210, 0.4), 0 4px 10px rgba(61, 98, 68, 0.4); }
/* 拨号键：铜钱（外缘 + 内环） */
.ubp-skin-wuxia .ubp-dial-key {
  position: relative; border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, #D9B56E, #B08A4F 58%, #8A6834);
  box-shadow: inset 0 0 0 1.5px rgba(255, 238, 196, 0.45), inset 0 -5px 9px rgba(90, 62, 22, 0.5), 0 3px 6px rgba(87, 61, 29, 0.4);
}
.ubp-skin-wuxia .ubp-dial-key b { color: #33240C; }
.ubp-skin-wuxia .ubp-dial-key i { color: rgba(51, 36, 12, 0.65); }
.ubp-skin-wuxia .ubp-dial-key::before {
  content: ""; position: absolute; inset: 5px; border-radius: 50%;
  border: 1.5px solid rgba(70, 48, 15, 0.4); pointer-events: none;
}
.ubp-skin-wuxia .ubp-dial-key:active { background: radial-gradient(circle at 34% 30%, #C9A45C, #9C7838 58%, #7A5A28); }
/* ── 悦来茶馆（武侠微博）：黑檀书场 + 水牌书目 + 茶帖 ── */
.ubp-skin-wuxia .ubp-wb { --wb-acc: #A93226; --wb-org: #A93226; --wb-topic: #A93226; --app-acc: #A93226; --segl: #A93226; }
.ubp-skin-wuxia .ubp-wb .ubp-stop { background: linear-gradient(180deg, #33291A, #262012); border-bottom: 1px solid rgba(201, 164, 92, 0.25); }
.ubp-skin-wuxia .ubp-wb .ubp-stop-search { background: rgba(201, 164, 92, 0.12); color: #C9B87A; box-shadow: inset 0 0 0 1px rgba(201, 164, 92, 0.3); }
.ubp-skin-wuxia .ubp-wb .ubp-stop-acts .ubp-iconbtn { color: #C9A96A; }
.ubp-skin-wuxia .ubp-wb .ubp-wb-brandname .n { color: #EFDDB4; }
.ubp-skin-wuxia .ubp-wb .ubp-wb-brandname .s { color: #A68B58; }
.ubp-skin-wuxia .ubp-wb-brand { background: linear-gradient(180deg, #B03A2E, #8E2A20); color: #FFE9C8; box-shadow: inset 0 0 0 1.5px rgba(255, 224, 178, 0.5), 0 2px 5px rgba(0, 0, 0, 0.4); }
.ubp-skin-wuxia .ubp-wb-brand::before { content: ""; position: absolute; top: -7px; left: 50%; transform: translateX(-50%); width: 3px; height: 7px; background: #B08A4F; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3); }
/* 今日书目水牌：木框横搭 */
.ubp-skin-wuxia .ubp-wb-board {
  margin-top: 12px; padding: 11px 12px 10px; border-radius: 6px;
  background: linear-gradient(172deg, #4A3A22, #3A2D18);
  border: none;
  box-shadow: inset 0 0 0 1.5px rgba(214, 178, 118, 0.5), inset 0 0 0 4px rgba(38, 28, 12, 0.5), 0 3px 9px rgba(30, 22, 9, 0.5);
}
.ubp-skin-wuxia .ubp-wb-board::before,
.ubp-skin-wuxia .ubp-wb-board::after {
  content: ""; position: absolute; top: -7px; width: 34px; height: 5px; border-radius: 3px;
  background: linear-gradient(180deg, #D9B56E, #8A6834); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); right: 22px;
}
.ubp-skin-wuxia .ubp-wb-board::before { left: 22px; }
.ubp-skin-wuxia .ubp-wb-board-hd { color: #EFDDB4; }
.ubp-skin-wuxia .ubp-wb-board-more { color: #A68B58; }
.ubp-skin-wuxia .ubp-wb-board-row { color: #E5D9BE; }
.ubp-skin-wuxia .ubp-wb-btag { border-radius: 2px; box-shadow: inset 0 0 0 1px rgba(255, 233, 228, 0.4); }
.ubp-skin-wuxia .ubp-wb-btag.惊 { background: #A93226; color: #FFE9E4; }
.ubp-skin-wuxia .ubp-wb-btag.彩 { background: #B08A4F; color: #241A08; }
.ubp-skin-wuxia .ubp-wb-btag.议 { background: rgba(176, 138, 79, 0.35); color: #EFDDB4; }
.ubp-skin-wuxia .ubp-wb-btag.新 { background: rgba(127, 174, 126, 0.4); color: #0E2412; }
.ubp-skin-wuxia .ubp-wb-chips { padding-bottom: 10px; }
.ubp-skin-wuxia .ubp-wb-chip { border: 1px solid rgba(176, 138, 79, 0.45); background: rgba(176, 138, 79, 0.08); color: #C9B87A; border-radius: 3px; }
.ubp-skin-wuxia .ubp-wb-chip.on { background: #B03A2E; border-color: #B03A2E; color: #FFE9E4; box-shadow: 0 0 9px rgba(169, 50, 38, 0.4); }
/* 茶帖卡：宣纸信笺（双线描边） */
.ubp-skin-wuxia .ubp-wb-card {
  background: linear-gradient(176deg, #F8F1DC, #F2E8CC); border-radius: 3px;
  box-shadow: inset 0 0 0 1px rgba(87, 61, 29, 0.22), inset 0 0 0 3.5px rgba(242, 233, 211, 0.9), inset 0 0 0 4.5px rgba(176, 138, 79, 0.3);
}
.ubp-skin-wuxia.ubp-dark .ubp-wb-card { background: linear-gradient(176deg, #2A2417, #241E13); box-shadow: inset 0 0 0 1px rgba(201, 164, 92, 0.16); }
.ubp-skin-wuxia .ubp-wb-repost { background: rgba(176, 138, 79, 0.08); box-shadow: inset 2px 0 0 rgba(176, 138, 79, 0.55); border-radius: 0 2px 2px 0; }
.ubp-skin-wuxia .ubp-wb-act.on { color: #A93226; }
.ubp-skin-wuxia .ubp-wb-topic-hero { background: linear-gradient(160deg, #B03A2E, #8E2A20); color: #FFE9D8; }
.ubp-skin-wuxia .ubp-wb-topic-hero .ubp-wb-topic-stat { color: rgba(255, 233, 216, 0.8); }
.ubp-skin-wuxia .ubp-wb-topic-chip { color: #EFDDB4; border-color: #B08A4F; }
.ubp-skin-wuxia .ubp-wb-hotrow:active { background: rgba(176, 138, 79, 0.08); }
.ubp-skin-wuxia .ubp-sfoot-tab.plus .ico { border-radius: 8px; background: linear-gradient(165deg, #B03A2E, #8E2A20); color: #FFE9C8; box-shadow: inset 0 0 0 1.5px rgba(255, 224, 178, 0.55), 0 0 12px rgba(169, 50, 38, 0.4); }
.ubp-skin-wuxia .ubp-replybar .go { background: #A93226; color: #FFE9E4; }
.ubp-skin-wuxia .ubp-wb-tag.爆 { background: #A93226; }
.ubp-skin-wuxia .ubp-wb-tag.沸 { background: #A93226; }
.ubp-skin-wuxia .ubp-wb-tag.热 { background: #A9832F; }
.ubp-skin-wuxia .ubp-wb-tag.新 { background: #47714F; }
.ubp-skin-wuxia .ubp-wb-tag.惊 { background: #A93226; }
.ubp-skin-wuxia .ubp-wb-tag.彩 { background: #B08A4F; }
.ubp-skin-wuxia .ubp-wb-tag.议 { background: #8A6D1F; }
/* 相机表单：铜角取景 */
.ubp-skin-wuxia .ubp-cam-shutter { border-radius: 4px; box-shadow: inset 0 0 0 1.5px rgba(214, 178, 118, 0.5); }
.ubp-skin-wuxia .ubp-cam-field { border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(87, 61, 29, 0.28); }

/* ══ 西幻·纹章皮肤（.ubp-skin-fantasy；docs/11） ══
   意象：传讯水晶——羊皮纸 / 烛光 / 火漆 / 纹章盾 / 魔蓝；楷体（抄本感）。
   暗档=烛光地窖（主视觉），亮档=羊皮纸白昼。 */
.ubp-scope.ubp-skin-fantasy {
  --ubp-bg: #17120D;
  --ubp-card: #221B13;
  --ubp-card-2: #2A2117;
  --ubp-text: #E9DCC1;
  --ubp-text-2: #A6946F;
  --ubp-text-3: #8A7A5C;
  --ubp-line: rgba(200, 155, 75, 0.18);
  --ubp-accent: #C89B4B;
  --ubp-accent-press: #B0853A;
  --ubp-accent-soft: rgba(200, 155, 75, 0.12);
  --ubp-danger: #A34A5A;
  --ubp-danger-soft: rgba(163, 74, 90, 0.1);
  --ubp-bubble-me: #4A2F3C;
  --ubp-bubble-me-text: #F5E6D5;
  --ubp-bubble-other: #221B13;
  --ubp-badge: #8E3B2E;
  --ubp-link: #9DB4E8;
  --ubp-overlay: rgba(8, 6, 4, 0.55);
  --ubp-frame: #120D08;
  --ubp-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  --ubp-decor: #B08A3C;
  --ubp-font: "Kaiti SC", "STKaiti", "KaiTi", "BiauKai", "DFKai-SB", "Noto Serif SC", serif;
}
.ubp-scope.ubp-skin-fantasy:not(.ubp-dark) {
  --ubp-bg: #EDE4D3;
  --ubp-card: #F7F0E1;
  --ubp-card-2: #EFE6D0;
  --ubp-text: #2C2318;
  --ubp-text-2: #6E5F4C;
  --ubp-text-3: #94856D;
  --ubp-line: rgba(90, 64, 40, 0.16);
  --ubp-accent: #8A6A28;
  --ubp-accent-press: #75591F;
  --ubp-accent-soft: rgba(138, 106, 40, 0.1);
  --ubp-bubble-me: #E7D0CC;
  --ubp-bubble-me-text: #4A1F2A;
  --ubp-bubble-other: #F7F0E1;
  --ubp-link: #3E5C9E;
  --ubp-badge: #8E3B2E;
}
.ubp-scope.ubp-skin-fantasy.ubp-dark {
  --ubp-bg: #120E09;
  --ubp-card: #1B150E;
  --ubp-card-2: #231B11;
  --ubp-text: #E9DCC1;
}
/* 机身：深皮革封面 + 黄铜包角；悬浮球=发光魔晶 */
.ubp-skin-fantasy .ubp-phone {
  background: linear-gradient(160deg, #3A2C1C, #241A10 55%, #1A120A);
  box-shadow: var(--ubp-shadow), inset 0 0 0 2px #0E0B07, inset 0 0 0 4px #A8842C, inset 0 0 0 5px #4A3618;
}
.ubp-skin-fantasy .ubp-ball {
  background: radial-gradient(circle at 34% 30%, rgba(157, 180, 232, 0.5), rgba(78, 95, 168, 0.35) 55%, #1A1424 90%);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), 0 0 10px rgba(124, 154, 232, 0.35), inset 0 0 0 1.5px rgba(200, 155, 75, 0.5);
}
.ubp-skin-fantasy .ubp-notch { background: #0C0906; box-shadow: inset 0 0 0 1px rgba(200, 155, 75, 0.5); }
.ubp-skin-fantasy .ubp-notch::after {
  content: ""; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 7px; height: 7px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #9DB4E8, #4E5FA8);
  box-shadow: 0 0 6px rgba(124, 154, 232, 0.9);
}
.ubp-skin-fantasy .ubp-screen {
  background: radial-gradient(120% 40% at 50% -6%, rgba(200, 155, 75, 0.12), transparent 60%), var(--ubp-bg);
}
.ubp-skin-fantasy .ubp-homebar-pill { background: #C89B4B; opacity: 0.5; }
/* 桌面：星图夜空（暗档主视觉）+ 符文环；亮档=羊皮纸古图 */
.ubp-skin-fantasy .ubp-home:not(.has-bg) {
  background:
    radial-gradient(1.6px 1.6px at 12% 18%, rgba(233, 220, 193, 0.9), transparent 55%),
    radial-gradient(1.2px 1.2px at 30% 9%, rgba(233, 220, 193, 0.6), transparent 55%),
    radial-gradient(1.8px 1.8px at 46% 24%, rgba(200, 155, 75, 0.95), transparent 55%),
    radial-gradient(1.2px 1.2px at 64% 12%, rgba(233, 220, 193, 0.55), transparent 55%),
    radial-gradient(1.6px 1.6px at 81% 21%, rgba(233, 220, 193, 0.85), transparent 55%),
    radial-gradient(1.2px 1.2px at 91% 38%, rgba(200, 155, 75, 0.7), transparent 55%),
    radial-gradient(1.4px 1.4px at 22% 40%, rgba(233, 220, 193, 0.5), transparent 55%),
    radial-gradient(1.4px 1.4px at 55% 44%, rgba(233, 220, 193, 0.45), transparent 55%),
    radial-gradient(1.2px 1.2px at 72% 34%, rgba(233, 220, 193, 0.6), transparent 55%),
    radial-gradient(70% 26% at 50% 108%, rgba(74, 47, 28, 0.55), transparent 72%),
    radial-gradient(46% 20% at 82% 86%, rgba(60, 40, 30, 0.5), transparent 70%),
    linear-gradient(180deg, #141020, #1A1410 55%, #221812);
  color: #E9DCC1;
}
.ubp-skin-fantasy .ubp-home:not(.has-bg)::after {
  content: ""; position: absolute; top: 84px; left: 50%; transform: translateX(-50%);
  width: 200px; height: 200px; border-radius: 50%;
  border: 1px dashed rgba(124, 154, 232, 0.26); pointer-events: none;
}
.ubp-skin-fantasy .ubp-home:not(.has-bg) .ubp-home-time { text-shadow: 0 0 16px rgba(200, 155, 75, 0.3); }
.ubp-skin-fantasy:not(.ubp-dark) .ubp-home:not(.has-bg) {
  background:
    radial-gradient(70% 26% at 50% 108%, rgba(122, 96, 60, 0.35), transparent 72%),
    radial-gradient(46% 20% at 82% 86%, rgba(110, 88, 60, 0.28), transparent 70%),
    linear-gradient(180deg, #F2E9D5, #EAE0C8 60%, #E0D2B4);
}
.ubp-skin-fantasy:not(.ubp-dark) .ubp-home:not(.has-bg)::after { border-color: rgba(90, 64, 40, 0.18); }
/* App 图标：纹章盾（尖底 + 金线高光） */
.ubp-skin-fantasy .ubp-appicon {
  clip-path: polygon(0 0, 100% 0, 100% 64%, 50% 100%, 0 64%);
  box-shadow: none;
}
.ubp-skin-fantasy .ubp-appicon::before {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(172deg, rgba(255, 240, 200, 0.24), rgba(0, 0, 0, 0.26) 78%);
  box-shadow: inset 0 0 0 1.5px rgba(240, 225, 185, 0.5);
}
.ubp-skin-fantasy .ubp-appicon::after {
  content: ""; position: absolute; left: 10%; right: 10%; top: 5px; height: 1.6px;
  background: linear-gradient(90deg, transparent, rgba(240, 225, 185, 0.6), transparent);
}
.ubp-skin-fantasy .ubp-appicon svg { margin-top: 3px; }
/* 聊天气泡：蜡笺（己方火漆角标 + 酒红侧线） */
.ubp-skin-fantasy .ubp-msg-row.me .ubp-bubble {
  position: relative; border-radius: 2px 12px 12px 2px;
  box-shadow: inset 0 0 0 1px rgba(200, 155, 75, 0.35), inset 3px 0 0 rgba(125, 42, 58, 0.9);
}
.ubp-skin-fantasy .ubp-msg-row.me .ubp-bubble::after {
  content: ""; position: absolute; right: -5px; top: 7px; width: 9px; height: 9px;
  border-radius: 47% 53% 44% 56%;
  background: radial-gradient(circle at 36% 32%, #A05252, #7D2A3A);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.ubp-skin-fantasy .ubp-msg-row:not(.me) .ubp-bubble {
  border-radius: 12px 2px 2px 12px;
  box-shadow: inset 0 0 0 1px rgba(200, 155, 75, 0.22);
}
.ubp-skin-fantasy .ubp-avatar,
.ubp-skin-fantasy .ubp-cl-avatar { border-radius: 50%; box-shadow: inset 0 0 0 1.5px rgba(200, 155, 75, 0.4); }
.ubp-skin-fantasy .ubp-avatar.small { border-radius: 50%; }
.ubp-skin-fantasy .ubp-voice { box-shadow: inset 0 0 0 1px rgba(200, 155, 75, 0.22); border-radius: 12px 2px 2px 12px; }
/* 系统气泡：烛金条 */
.ubp-skin-fantasy .ubp-sys-msg { background: rgba(200, 155, 75, 0.1); color: #C9A15C; box-shadow: inset 0 0 0 1px rgba(200, 155, 75, 0.25); border-radius: 11px; }
.ubp-skin-fantasy:not(.ubp-dark) .ubp-sys-msg { color: #8A6A28; }
.ubp-skin-fantasy .ubp-sys-msg.error { background: var(--ubp-danger-soft); color: var(--ubp-danger); box-shadow: none; }
.ubp-skin-fantasy .ubp-time-divider { background: rgba(200, 155, 75, 0.1); color: #C9A15C; box-shadow: inset 0 0 0 1px rgba(200, 155, 75, 0.25); }
.ubp-skin-fantasy:not(.ubp-dark) .ubp-time-divider { color: #8A6A28; }
/* 金币袋 / 蜡封钱袋 */
.ubp-skin-fantasy .ubp-card.transfer {
  background: linear-gradient(165deg, #5A4028, #3E2B18); color: #F0E4C8; border-radius: 6px;
  box-shadow: inset 0 0 0 1.5px rgba(200, 155, 75, 0.5), inset 0 0 18px rgba(0, 0, 0, 0.35);
}
.ubp-skin-fantasy .ubp-card.transfer .amt { color: #E8C878; }
.ubp-skin-fantasy .ubp-card.redpacket {
  background: linear-gradient(160deg, #6E2434, #521A26); color: #F5E0D0; border-radius: 6px;
  box-shadow: inset 0 0 0 1.5px rgba(232, 200, 120, 0.45), 0 2px 8px rgba(82, 26, 38, 0.5);
}
.ubp-skin-fantasy .ubp-rp-icon { border-radius: 47% 53% 44% 56%; background: rgba(255, 224, 178, 0.18); }
.ubp-skin-fantasy .ubp-rp-icon svg { color: #F5E0D0; }
.ubp-skin-fantasy .ubp-card-glyph { border-radius: 47% 53% 44% 56%; background: rgba(232, 200, 120, 0.16); }
/* 顶栏：皮革横梁 */
.ubp-skin-fantasy .ubp-appbar { background: linear-gradient(180deg, #241C13, #1B150E); box-shadow: inset 0 -1px 0 rgba(200, 155, 75, 0.22); }
.ubp-skin-fantasy:not(.ubp-dark) .ubp-appbar { background: linear-gradient(180deg, #F7F0E1, #EFE6D0); }
/* 通话全屏层：占卜室（秘紫微光 + 正反符文环） */
.ubp-skin-fantasy .ubp-call-screen {
  background:
    radial-gradient(80% 42% at 50% 26%, rgba(124, 154, 232, 0.12), transparent 64%),
    radial-gradient(60% 30% at 50% 100%, rgba(200, 155, 75, 0.08), transparent 60%),
    linear-gradient(180deg, #1A1420, #120E0A);
  color: #E9DCC1;
}
.ubp-skin-fantasy .ubp-call-avatar { position: relative; box-shadow: 0 0 26px rgba(124, 154, 232, 0.3), inset 0 0 12px rgba(0, 0, 0, 0.45); }
.ubp-skin-fantasy .ubp-call-avatar::before {
  content: ""; position: absolute; inset: -12px; border-radius: 50%;
  border: 1.5px dashed rgba(124, 154, 232, 0.55); pointer-events: none;
  animation: ubp-ft-rotate 9s linear infinite;
}
.ubp-skin-fantasy .ubp-call-avatar::after {
  content: ""; position: absolute; inset: -23px; border-radius: 50%;
  border: 1px solid rgba(200, 155, 75, 0.3); border-top-color: rgba(200, 155, 75, 0.7);
  pointer-events: none; animation: ubp-ft-rotate 5s linear infinite reverse;
}
.ubp-skin-fantasy .ubp-call-avatar.ringing::before { animation-duration: 2.4s; }
@keyframes ubp-ft-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.ubp-skin-fantasy .ubp-call-line.peer { background: #262017; color: #E9DCC1; border: 1px solid rgba(200, 155, 75, 0.25); }
.ubp-skin-fantasy .ubp-call-line.me { background: #3A2C42; color: #EDE4F2; box-shadow: inset 3px 0 0 rgba(124, 154, 232, 0.55); }
.ubp-skin-fantasy .ubp-call-hint { background: rgba(26, 20, 16, 0.92); }
.ubp-skin-fantasy .ubp-call-btn { background: rgba(200, 155, 75, 0.1); color: #C9A15C; box-shadow: inset 0 0 0 1.2px rgba(200, 155, 75, 0.4); }
.ubp-skin-fantasy .ubp-call-btn.speak,
.ubp-skin-fantasy .ubp-call-btn.on { background: #C89B4B; color: #241A08; }
.ubp-skin-fantasy .ubp-call-btn.end { background: linear-gradient(160deg, #7D2A3A, #5A1E2A); color: #F5E0D0; box-shadow: inset 0 0 0 1.5px rgba(232, 200, 120, 0.4), 0 5px 14px rgba(125, 42, 58, 0.4); }
.ubp-skin-fantasy .ubp-call-btn.accept { background: linear-gradient(160deg, #8A6A28, #6B4E1A); color: #F5E8C8; }
.ubp-skin-fantasy .ubp-call-mutebadge { color: #C9A15C; background: rgba(200, 155, 75, 0.12); }
.ubp-skin-fantasy .ubp-dialer-call { background: radial-gradient(circle at 34% 30%, #C89B4B, #8A6A28); box-shadow: inset 0 0 0 1.5px rgba(255, 240, 200, 0.5), 0 0 12px rgba(200, 155, 75, 0.35); }
/* 拨号键：符文石 */
.ubp-skin-fantasy .ubp-dial-key {
  position: relative;
  background: radial-gradient(circle at 34% 28%, #3E3428, #241C12 70%);
  box-shadow: inset 0 0 0 1.5px rgba(200, 155, 75, 0.4), inset 0 -6px 10px rgba(0, 0, 0, 0.5), 0 3px 6px rgba(0, 0, 0, 0.5);
}
.ubp-skin-fantasy .ubp-dial-key::before {
  content: "✦"; position: absolute; top: 7px; right: 11px; font-size: 8px;
  color: rgba(124, 154, 232, 0.7); pointer-events: none;
}
.ubp-skin-fantasy:not(.ubp-dark) .ubp-dial-key { background: radial-gradient(circle at 34% 28%, #6A5636, #463521 70%); }
/* 键面恒为深色：数字/字母显式浅字（继承 --ubp-text 在浅色模式下是深字），:active 保持深底 */
.ubp-skin-fantasy .ubp-dial-key b { color: #EFE3C6; }
.ubp-skin-fantasy .ubp-dial-key i { color: rgba(239, 227, 198, 0.6); }
.ubp-skin-fantasy .ubp-dial-key:active { background: radial-gradient(circle at 34% 28%, #4A3E30, #2C2318 70%); }
/* ── 吟游诗社（西幻微博）：烛光集社 + 传唱榜卷轴 + 羊皮见闻 ── */
.ubp-skin-fantasy .ubp-wb { --wb-acc: #C89B4B; --wb-org: #8A2F44; --wb-topic: #8A2F44; --app-acc: #C89B4B; --segl: #C89B4B; }
.ubp-skin-fantasy .ubp-wb .ubp-stop { background: linear-gradient(180deg, #241C13, #1B150E); border-bottom: 1px solid rgba(200, 155, 75, 0.2); }
.ubp-skin-fantasy .ubp-wb .ubp-stop-search { background: rgba(200, 155, 75, 0.08); color: #B9A176; box-shadow: inset 0 0 0 1px rgba(200, 155, 75, 0.25); }
.ubp-skin-fantasy .ubp-wb .ubp-stop-acts .ubp-iconbtn { color: #C9A15C; }
.ubp-skin-fantasy .ubp-wb .ubp-wb-brandname .n { color: #EFD9AC; }
.ubp-skin-fantasy .ubp-wb .ubp-wb-brandname .s { color: #A6946F; }
.ubp-skin-fantasy .ubp-wb-brand {
  height: 34px; border-radius: 47% 53% 44% 56%;
  background: radial-gradient(circle at 36% 32%, #A05252, #7D2A3A 70%); color: #F5E0D0;
  box-shadow: inset 0 0 0 2px rgba(240, 210, 160, 0.35), 0 0 9px rgba(160, 82, 82, 0.4);
}
.ubp-skin-fantasy .ubp-wb-brand::before { content: none; }
/* 传唱榜：羊皮卷轴（两侧卷轴头） */
.ubp-skin-fantasy .ubp-wb-board {
  margin: 14px 10px 10px; padding: 11px 14px 10px; border-radius: 4px; border: none;
  background: linear-gradient(172deg, #EFE3C4, #E2D2A8);
  box-shadow: inset 0 0 0 1px rgba(160, 120, 60, 0.4), inset 0 0 22px rgba(150, 110, 50, 0.18), 0 3px 9px rgba(0, 0, 0, 0.45);
}
.ubp-skin-fantasy .ubp-wb-board::before,
.ubp-skin-fantasy .ubp-wb-board::after {
  content: ""; position: absolute; top: -6px; bottom: -6px; width: 15px; border-radius: 8px;
  background: linear-gradient(90deg, #5A4028, #8A6834 45%, #3E2B18); box-shadow: 0 2px 5px rgba(0, 0, 0, 0.5); right: -8px;
}
.ubp-skin-fantasy .ubp-wb-board::before { left: -8px; }
.ubp-skin-fantasy .ubp-wb-board-hd { color: #6E4E1E; }
.ubp-skin-fantasy .ubp-wb-board-more { color: #8A7248; }
.ubp-skin-fantasy .ubp-wb-board-row { color: #3E2F1A; }
.ubp-skin-fantasy .ubp-wb-btag { border-radius: 47% 53% 44% 56%; box-shadow: inset 0 0 0 1px rgba(245, 224, 208, 0.4); }
.ubp-skin-fantasy .ubp-wb-btag.炽 { background: radial-gradient(circle at 36% 32%, #B85050, #8A2F44); color: #F5E0D0; }
.ubp-skin-fantasy .ubp-wb-btag.喧 { background: radial-gradient(circle at 36% 32%, #C8A24E, #9A7824); color: #33240A; }
.ubp-skin-fantasy .ubp-wb-btag.秘 { background: radial-gradient(circle at 36% 32%, #5A6AA8, #3E4C82); color: #EDF0FA; }
.ubp-skin-fantasy .ubp-wb-btag.新 { background: radial-gradient(circle at 36% 32%, #4E8A7E, #2E5E54); color: #E8F5F1; }
.ubp-skin-fantasy .ubp-wb-chips { padding: 0 8px 10px; }
.ubp-skin-fantasy .ubp-wb-chip { border: 1px solid rgba(200, 155, 75, 0.4); background: rgba(200, 155, 75, 0.08); color: #B9A176; border-radius: 12px; }
.ubp-skin-fantasy .ubp-wb-chip.on { background: #C89B4B; border-color: #C89B4B; color: #241A08; font-weight: 700; box-shadow: 0 0 9px rgba(200, 155, 75, 0.35); }
/* 见闻卡：羊皮纸（双模式下均为羊皮——烛光下的纸质辨识度） */
.ubp-skin-fantasy .ubp-wb-card {
  background: linear-gradient(176deg, #EFE3C4, #E4D4AC); border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(160, 120, 60, 0.45), inset 0 0 16px rgba(150, 110, 50, 0.12), 0 2px 6px rgba(0, 0, 0, 0.35);
}
.ubp-skin-fantasy .ubp-wb-card::after {
  content: ""; position: absolute; top: 8px; right: 9px; width: 11px; height: 11px;
  border-radius: 47% 53% 44% 56%; opacity: 0.28;
  background: radial-gradient(circle at 36% 32%, #A05252, #7D2A3A); pointer-events: none;
}
.ubp-skin-fantasy .ubp-wb-card .ubp-wb-name { color: #5E4620; }
.ubp-skin-fantasy .ubp-wb-card .ubp-wb-time { color: #8A7248; }
.ubp-skin-fantasy .ubp-wb-card .ubp-wb-text { color: #3E2F1A; }
.ubp-skin-fantasy .ubp-wb-card .ubp-wb-text .topic,
.ubp-skin-fantasy .ubp-wb-card .ubp-wb-text .at { color: #8A2F44; }
.ubp-skin-fantasy .ubp-wb-repost { background: rgba(138, 47, 68, 0.08); box-shadow: inset 2px 0 0 rgba(138, 47, 68, 0.6); border-radius: 0 3px 3px 0; }
.ubp-skin-fantasy .ubp-wb-act { color: #8A7248; }
.ubp-skin-fantasy .ubp-wb-act.on { color: #8A2F44; }
.ubp-skin-fantasy .ubp-wb-topic-hero { background: linear-gradient(160deg, #8A2F44, #6E2434); color: #F5E0D0; }
.ubp-skin-fantasy .ubp-wb-topic-hero .ubp-wb-topic-stat { color: rgba(245, 224, 208, 0.8); }
.ubp-skin-fantasy .ubp-wb-topic-chip { color: #EFD9AC; border-color: #C89B4B; }
.ubp-skin-fantasy .ubp-wb-hotrow:active { background: rgba(200, 155, 75, 0.08); }
.ubp-skin-fantasy .ubp-sfoot-tab.plus .ico { border-radius: 50%; background: radial-gradient(circle at 34% 30%, #C89B4B, #8A6A28); color: #241A08; box-shadow: inset 0 0 0 1.5px rgba(255, 240, 200, 0.5), 0 0 12px rgba(200, 155, 75, 0.45); }
.ubp-skin-fantasy .ubp-replybar .go { background: #8A2F44; color: #F5E0D0; }
.ubp-skin-fantasy .ubp-wb-tag.爆 { background: #8A2F44; }
.ubp-skin-fantasy .ubp-wb-tag.沸 { background: #8A2F44; }
.ubp-skin-fantasy .ubp-wb-tag.热 { background: #9A7824; }
.ubp-skin-fantasy .ubp-wb-tag.新 { background: #4E8A7E; }
.ubp-skin-fantasy .ubp-wb-tag.炽 { background: #8A2F44; }
.ubp-skin-fantasy .ubp-wb-tag.喧 { background: #9A7824; }
.ubp-skin-fantasy .ubp-wb-tag.秘 { background: #3E4C82; }
/* 相机表单：铜边羊皮 */
.ubp-skin-fantasy .ubp-cam-shutter { border-radius: 10px; box-shadow: inset 0 0 0 1.5px rgba(200, 155, 75, 0.4); }
.ubp-skin-fantasy .ubp-cam-field { border-radius: 8px; box-shadow: inset 0 0 0 1px rgba(200, 155, 75, 0.25); }

/* ╔══════════════════════════════════════════════════════════════════════╗
   ║ 皮肤层（.ubp-theme-*，core/skin-themes.ts；docs/14）                  ║
   ║ 置于风格段（.ubp-skin-*）之后 → 同特异性下皮肤视觉盖过风格视觉；       ║
   ║ 与 .ubp-dark 正交叠加；用户显式设置（壁纸/字体/字号）经行内样式仍在外。║
   ║ 可视稿：docs/skin-mockups-sweet-flirty.html（真实 PHONE_CSS 渲染）。  ║
   ╚══════════════════════════════════════════════════════════════════════╝ */

/* ── 皮肤·甜恋糖果（sweet）：草莓奶昔（亮）/ 蓝莓夜（暗）；居中大时钟 + 糖果圆罐图标 + 圆体字 ── */
.ubp-scope.ubp-theme-sweet {
  --ubp-font: "Yuanti SC", "STYuanti", YouYuan, "幼圆", "ZCOOL KuaiLe", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --ubp-font-scale: 1.05;
  --ubp-decor: #E87090;
}
.ubp-scope.ubp-theme-sweet:not(.ubp-dark) {
  --ubp-bg: #FFF5F5;
  --ubp-card: #FFFFFF;
  --ubp-card-2: #FFF0F5;
  --ubp-text: #5C3D4A;
  --ubp-text-2: #8A6A78;
  --ubp-text-3: #B898A0;
  --ubp-line: rgba(232, 112, 144, 0.20);
  --ubp-accent: #FF8FAB;
  --ubp-accent-press: #E87090;
  --ubp-accent-soft: rgba(255, 143, 171, 0.15);
  --ubp-danger: #E8637A;
  --ubp-danger-soft: rgba(232, 99, 122, 0.12);
  --ubp-bubble-me: #FFB3C8;
  --ubp-bubble-me-text: #59263A;
  --ubp-bubble-other: #FFF7FA;
  --ubp-badge: #FF6B8F;
  --ubp-link: #9A6BD0;
  --ubp-overlay: rgba(92, 61, 74, 0.42);
  --ubp-frame: #F3C3D3;
  --ubp-shadow: 0 18px 50px rgba(214, 130, 160, 0.35);
}
.ubp-scope.ubp-theme-sweet.ubp-dark {
  --ubp-bg: #1A141C;
  --ubp-card: #241C28;
  --ubp-card-2: #2A1F2E;
  --ubp-text: #E8D8E0;
  --ubp-text-2: #B8A0B0;
  --ubp-text-3: #7A6070;
  --ubp-line: rgba(255, 143, 171, 0.17);
  --ubp-accent: #FF8FAB;
  --ubp-accent-press: #FFB3C8;
  --ubp-accent-soft: rgba(255, 143, 171, 0.17);
  --ubp-bubble-me: #A04468;
  --ubp-bubble-me-text: #FFE4EE;
  --ubp-bubble-other: #2E2232;
  --ubp-badge: #FF6B8F;
  --ubp-link: #C8A8F0;
  --ubp-overlay: rgba(10, 6, 12, 0.55);
  --ubp-frame: #241A20;
  --ubp-decor: #FFB3C8;
}
/* 机身：草莓奶油壳（亮）/ 蓝莓夜壳（暗）；悬浮球同材质 */
.ubp-theme-sweet .ubp-phone {
  background: linear-gradient(170deg, #FFE4EE, #F5C9DA 60%, #EFB9CE);
  box-shadow: var(--ubp-shadow), inset 0 0 0 2px rgba(255, 255, 255, 0.55), inset 0 0 0 4px rgba(255, 143, 171, 0.28);
}
.ubp-theme-sweet.ubp-dark .ubp-phone {
  background: linear-gradient(170deg, #2E2232, #241A20 60%, #1E141E);
  box-shadow: var(--ubp-shadow), inset 0 0 0 2px rgba(255, 143, 171, 0.22), inset 0 0 0 4px rgba(255, 143, 171, 0.08);
}
.ubp-theme-sweet .ubp-ball {
  background: linear-gradient(170deg, #FFD9E6, #F5BCD0); color: #C25E7E;
  box-shadow: 0 4px 14px rgba(214, 130, 160, 0.45), inset 0 0 0 1.5px rgba(255, 255, 255, 0.6);
}
.ubp-theme-sweet.ubp-dark .ubp-ball {
  background: linear-gradient(170deg, #3A2A3E, #2A1E2E); color: #FFB3C8;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), inset 0 0 0 1.5px rgba(255, 143, 171, 0.35);
}
.ubp-theme-sweet .ubp-notch { background: #EBABBF; }
.ubp-theme-sweet.ubp-dark .ubp-notch { background: #171017; box-shadow: inset 0 0 0 1px rgba(255, 143, 171, 0.18); }
.ubp-theme-sweet .ubp-homebar-pill { background: var(--ubp-decor); opacity: 0.45; }
/* 桌面：草莓奶昔（无自定义壁纸默认底）+ 居中大时钟呈现 */
.ubp-theme-sweet .ubp-home:not(.has-bg) {
  background:
    radial-gradient(42% 20% at 18% 76%, rgba(255, 212, 184, 0.45), transparent 70%),
    radial-gradient(46% 22% at 84% 70%, rgba(200, 184, 240, 0.4), transparent 70%),
    radial-gradient(52% 24% at 50% 92%, rgba(184, 232, 208, 0.42), transparent 72%),
    linear-gradient(180deg, #FFF1F4 0%, #FFE3EC 52%, #FBD3E2 100%);
}
.ubp-theme-sweet.ubp-dark .ubp-home:not(.has-bg) {
  background:
    radial-gradient(46% 22% at 20% 80%, rgba(255, 143, 171, 0.14), transparent 70%),
    radial-gradient(50% 24% at 82% 74%, rgba(160, 136, 208, 0.16), transparent 70%),
    linear-gradient(180deg, #2B1F30 0%, #221927 55%, #191218 100%);
}
.ubp-theme-sweet .ubp-home:not(.has-bg) .ubp-home-time { color: #D8547E; font-weight: 700; letter-spacing: 1px; text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6); }
.ubp-theme-sweet.ubp-dark .ubp-home:not(.has-bg) .ubp-home-time { color: #FF9FBB; text-shadow: 0 0 18px rgba(255, 143, 171, 0.35); }
.ubp-theme-sweet .ubp-home:not(.has-bg) .ubp-home-date { color: #B0788E; font-size: 13px; margin-top: 3px; }
.ubp-theme-sweet.ubp-dark .ubp-home:not(.has-bg) .ubp-home-date { color: #B8A0B0; }
.ubp-theme-sweet .ubp-home:not(.has-bg) .ubp-home-wmain b { color: #C25E7E; }
.ubp-theme-sweet.ubp-dark .ubp-home:not(.has-bg) .ubp-home-wmain b { color: #FFB3C8; }
.ubp-theme-sweet .ubp-home:not(.has-bg) .ubp-home-wmain svg { color: #E8975A; }
.ubp-theme-sweet.ubp-dark .ubp-home:not(.has-bg) .ubp-home-wmain svg { color: #FFC98A; }
.ubp-theme-sweet .ubp-home:not(.has-bg) .ubp-home-wdesc { color: #B0788E; }
.ubp-theme-sweet.ubp-dark .ubp-home:not(.has-bg) .ubp-home-wdesc { color: #9A8296; }
.ubp-theme-sweet .ubp-home:not(.has-bg) .ubp-home-loc { color: #B0788E; }
.ubp-theme-sweet.ubp-dark .ubp-home:not(.has-bg) .ubp-home-loc { color: #8E7490; }
.ubp-theme-sweet .ubp-home:not(.has-bg) .ubp-appname { color: #7A4A5E; }
.ubp-theme-sweet.ubp-dark .ubp-home:not(.has-bg) .ubp-appname { color: #E8D8E0; }
/* 桌面布局变体：时刻/天气/地点居中纵排 */
.ubp-theme-sweet .ubp-home-top { flex-direction: column; align-items: center; text-align: center; gap: 4px; padding: 26px 2px 8px; }
.ubp-theme-sweet .ubp-home-datetime { display: flex; flex-direction: column; align-items: center; }
.ubp-theme-sweet .ubp-home-ctx { max-width: 100%; text-align: center; }
.ubp-theme-sweet .ubp-home-wmain { justify-content: center; }
.ubp-theme-sweet .ubp-home-loc { justify-content: center; }
/* App 图标：糖果圆罐（圆形 + 奶油高光） */
.ubp-theme-sweet .ubp-appicon {
  border-radius: 50%;
  box-shadow: 0 4px 12px rgba(232, 112, 144, 0.30), inset 0 -3px 6px rgba(0, 0, 0, 0.06), inset 0 2px 3px rgba(255, 255, 255, 0.45);
}
/* 气泡：奶油圆角 + 高光/糖霜细边 */
.ubp-theme-sweet .ubp-bubble { border-radius: 18px; }
.ubp-theme-sweet .ubp-msg-row.me .ubp-bubble { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.4); }
.ubp-theme-sweet .ubp-msg-row .ubp-bubble { box-shadow: inset 0 0 0 1px rgba(232, 112, 144, 0.12); }
.ubp-theme-sweet.ubp-dark .ubp-msg-row .ubp-bubble { box-shadow: inset 0 0 0 1px rgba(255, 143, 171, 0.14); }
.ubp-theme-sweet .ubp-avatar { border-radius: 12px; }
/* 系统气泡：草莓奶昔胶囊 */
.ubp-theme-sweet .ubp-sys-msg { background: rgba(255, 143, 171, 0.14); color: #C25E7E; }
.ubp-theme-sweet.ubp-dark .ubp-sys-msg { background: rgba(255, 143, 171, 0.12); color: #FFB3C8; }
.ubp-theme-sweet .ubp-time-divider { background: rgba(255, 143, 171, 0.14); color: #C25E7E; }
.ubp-theme-sweet.ubp-dark .ubp-time-divider { background: rgba(255, 143, 171, 0.12); color: #FFB3C8; }
/* 转账=薄荷糖卡 / 红包=草莓糖卡 */
.ubp-theme-sweet .ubp-card.transfer { background: linear-gradient(140deg, #8ED4B2, #5FBF94); color: #174D37; box-shadow: 0 3px 10px rgba(95, 191, 148, 0.3); }
.ubp-theme-sweet .ubp-card.transfer .ubp-card-glyph { background: rgba(255, 255, 255, 0.34); }
.ubp-theme-sweet .ubp-card.redpacket { background: linear-gradient(140deg, #FF9FBB, #EE7292); color: #64203C; box-shadow: 0 3px 10px rgba(238, 114, 146, 0.35); }
.ubp-theme-sweet .ubp-card.redpacket .ubp-card-amt { color: #FFFFFF; }
.ubp-theme-sweet .ubp-card.redpacket .ubp-rp-icon { background: rgba(255, 255, 255, 0.34); }
.ubp-theme-sweet .ubp-card.redpacket .ubp-rp-icon svg { color: #FFF0F4; }

/* ── 皮肤·瑟瑟灵感（flirty）：雾紫粉（亮）/ 暗夜紫（暗）；经典左上衬线时刻 + 秘纹方章图标 ── */
.ubp-scope.ubp-theme-flirty {
  --ubp-decor: #9050C0;
  --ubp-font-display: "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, serif;
}
.ubp-scope.ubp-theme-flirty:not(.ubp-dark) {
  --ubp-bg: #FAF4FB;
  --ubp-card: #FFFAFD;
  --ubp-card-2: #F3E8F5;
  --ubp-text: #34223F;
  --ubp-text-2: #695575;
  --ubp-text-3: #8F799B;
  --ubp-line: rgba(144, 80, 192, 0.17);
  --ubp-accent: #D060A0;
  --ubp-accent-press: #B04878;
  --ubp-accent-soft: rgba(208, 96, 160, 0.12);
  --ubp-danger: #C2447A;
  --ubp-danger-soft: rgba(194, 68, 122, 0.1);
  --ubp-bubble-me: #EFC3DC;
  --ubp-bubble-me-text: #4A1636;
  --ubp-bubble-other: #FFFAFD;
  --ubp-badge: #E0558E;
  --ubp-link: #9050C0;
  --ubp-overlay: rgba(22, 12, 26, 0.5);
  --ubp-frame: #241A2A;
  --ubp-shadow: 0 18px 50px rgba(40, 20, 50, 0.4);
}
.ubp-scope.ubp-theme-flirty.ubp-dark {
  --ubp-bg: #14101A;
  --ubp-card: #1F1826;
  --ubp-card-2: #281F30;
  --ubp-text: #E8E4EC;
  --ubp-text-2: #A898B4;
  --ubp-text-3: #6E5E7C;
  --ubp-line: rgba(255, 137, 179, 0.15);
  --ubp-accent: #FF89B3;
  --ubp-accent-press: #FFA0C4;
  --ubp-accent-soft: rgba(255, 137, 179, 0.14);
  --ubp-bubble-me: #7C3258;
  --ubp-bubble-me-text: #FFD9EA;
  --ubp-bubble-other: #26202E;
  --ubp-badge: #FF6A9E;
  --ubp-link: #C9A0E8;
  --ubp-overlay: rgba(0, 0, 0, 0.6);
  --ubp-frame: #17111C;
  --ubp-decor: #C08BD8;
}
/* 标题/桌面时刻用衬线展示字体（正文仍走 --ubp-font，保阅读性） */
.ubp-theme-flirty .ubp-appbar-title,
.ubp-theme-flirty .ubp-home-time { font-family: var(--ubp-font-display); letter-spacing: 1px; }
/* 机身：暗莓紫壳 + 粉光细环；悬浮球同材质 */
.ubp-theme-flirty .ubp-phone {
  background: linear-gradient(165deg, #2A1E32, #1B1422 55%, #150F1B);
  box-shadow: var(--ubp-shadow), inset 0 0 0 2px rgba(255, 137, 179, 0.2), 0 0 24px rgba(208, 96, 160, 0.12);
}
.ubp-theme-flirty .ubp-ball {
  background: linear-gradient(165deg, #33243C, #221830); color: #FF9FBE;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), inset 0 0 0 1.5px rgba(255, 137, 179, 0.4);
}
.ubp-theme-flirty .ubp-notch { background: #120D17; box-shadow: inset 0 0 0 1px rgba(255, 137, 179, 0.16); }
.ubp-theme-flirty .ubp-homebar-pill { background: var(--ubp-accent); opacity: 0.42; }
/* 桌面：雾紫粉（亮）/ 暗夜紫（暗），欲望色微光点缀；经典左上时刻 + 品红竖条 */
.ubp-theme-flirty .ubp-home:not(.has-bg) {
  background:
    radial-gradient(60% 30% at 80% 6%, rgba(144, 80, 192, 0.10), transparent 65%),
    radial-gradient(52% 26% at 12% 92%, rgba(208, 96, 160, 0.09), transparent 70%),
    linear-gradient(180deg, #F8F0FA 0%, #F3E7F6 60%, #EEDFF2 100%);
}
.ubp-theme-flirty.ubp-dark .ubp-home:not(.has-bg) {
  background:
    radial-gradient(56% 28% at 82% 8%, rgba(255, 106, 158, 0.10), transparent 65%),
    radial-gradient(48% 24% at 12% 94%, rgba(144, 80, 192, 0.12), transparent 70%),
    linear-gradient(180deg, #1A1422 0%, #150F1C 60%, #110C16 100%);
}
.ubp-theme-flirty .ubp-home:not(.has-bg) .ubp-home-datetime { padding-left: 10px; border-left: 3px solid var(--ubp-accent); }
.ubp-theme-flirty .ubp-home:not(.has-bg) .ubp-home-time { color: #B04878; }
.ubp-theme-flirty.ubp-dark .ubp-home:not(.has-bg) .ubp-home-time { color: #F2C9DC; text-shadow: 0 0 16px rgba(255, 106, 158, 0.3); }
.ubp-theme-flirty .ubp-home:not(.has-bg) .ubp-home-wmain { color: var(--ubp-accent); }
.ubp-theme-flirty.ubp-dark .ubp-home:not(.has-bg) .ubp-home-wmain { color: #FF89B3; }
/* App 图标：秘纹方章（小圆角 + 粉光描边） */
.ubp-theme-flirty .ubp-appicon {
  border-radius: 12px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22), 0 4px 12px rgba(176, 72, 120, 0.24), 0 0 10px rgba(208, 96, 160, 0.14);
}
.ubp-theme-flirty.ubp-dark .ubp-appicon {
  box-shadow: inset 0 0 0 1px rgba(255, 137, 179, 0.28), 0 4px 12px rgba(0, 0, 0, 0.4), 0 0 12px rgba(255, 106, 158, 0.18);
}
/* 气泡：利落小圆角 + 欲望色细环 */
.ubp-theme-flirty .ubp-bubble { border-radius: 8px; }
.ubp-theme-flirty .ubp-msg-row.me .ubp-bubble { box-shadow: inset 0 0 0 1px rgba(208, 96, 160, 0.35); }
.ubp-theme-flirty.ubp-dark .ubp-msg-row.me .ubp-bubble { box-shadow: inset 0 0 0 1px rgba(255, 137, 179, 0.4); }
.ubp-theme-flirty .ubp-msg-row .ubp-bubble { box-shadow: inset 0 0 0 1px rgba(144, 80, 192, 0.12); }
.ubp-theme-flirty.ubp-dark .ubp-msg-row .ubp-bubble { box-shadow: inset 0 0 0 1px rgba(255, 137, 179, 0.12); }
/* 系统气泡：雾紫胶囊 */
.ubp-theme-flirty .ubp-sys-msg { background: rgba(144, 80, 192, 0.1); color: #8E4A9E; }
.ubp-theme-flirty.ubp-dark .ubp-sys-msg { background: rgba(255, 137, 179, 0.1); color: #FF9FBE; }
.ubp-theme-flirty .ubp-time-divider { background: rgba(144, 80, 192, 0.1); color: #8E4A9E; }
.ubp-theme-flirty.ubp-dark .ubp-time-divider { background: rgba(255, 137, 179, 0.1); color: #FF9FBE; }
/* 转账=欲望紫卡 / 红包=莓果酒红卡 */
.ubp-theme-flirty .ubp-card.transfer { background: #7838A8; color: #F3E8FA; box-shadow: 0 0 10px rgba(144, 80, 192, 0.28); }
.ubp-theme-flirty .ubp-card.transfer .ubp-card-glyph { background: rgba(255, 255, 255, 0.18); }
.ubp-theme-flirty .ubp-card.redpacket { background: #B04878; color: #FFE9F1; box-shadow: 0 0 10px rgba(208, 96, 160, 0.3); }
.ubp-theme-flirty .ubp-card.redpacket .ubp-card-amt { color: #FFFFFF; }
.ubp-theme-flirty .ubp-card.redpacket .ubp-rp-icon { background: rgba(255, 255, 255, 0.2); }
.ubp-theme-flirty .ubp-card.redpacket .ubp-rp-icon svg { color: #FFD0E0; }

/* ══ 三 App 品牌换装（docs/15 §7：论道坛/英雄楼/行会大厅 · 云笈录/风物志/藏宝图鉴 · 浮生帖/故人笺/篝火手记） ══
   皮肤下三社媒 App 恢复（隐藏门控退役）：主题 accent 走 --app-acc/--segl/--tb-acc/--xhs-acc 换装，
   贴吧品牌行=单字印标 + 品牌渐变顶栏换材质；朋友圈无独立 accent（走全局 --ubp-accent 自动随皮肤）零规则。 */

/* ── 仙侠·玄青：论道坛（黛青） + 云笈录（朱砂） ── */
.ubp-skin-xianxia .ubp-tb { --tb-acc: #3E6A8E; --tb-acc-soft: rgba(62, 106, 142, 0.13); --app-acc: #3E6A8E; --segl: #3E6A8E; }
.ubp-skin-xianxia .ubp-xhs { --xhs-acc: #B4543E; --xhs-star: #C9A24B; --xhs-topic: #3E6A8E; --app-acc: #B4543E; --segl: #B4543E; }
/* 暗色底提亮 accent（浅色值在暗卡上仅 ~2.4-3.2:1） */
.ubp-skin-xianxia.ubp-dark .ubp-tb { --tb-acc: #5E86A8; --tb-acc-soft: rgba(94, 134, 168, 0.18); --app-acc: #6E9CC0; --segl: #6E9CC0; }
.ubp-skin-xianxia.ubp-dark .ubp-xhs { --xhs-acc: #D9826C; --xhs-topic: #7FA8C8; --app-acc: #D9826C; --segl: #D9826C; }
.ubp-skin-xianxia .ubp-tb .ubp-stop { background: linear-gradient(160deg, #2A4258, #223648); border-bottom: 1px solid rgba(99, 214, 172, 0.16); }
.ubp-skin-xianxia:not(.ubp-dark) .ubp-tb .ubp-stop { background: linear-gradient(160deg, #E7EEF3, #DDE8EE); color: #1E2B26; border-bottom: 1px solid rgba(62, 106, 142, 0.25); }
.ubp-skin-xianxia .ubp-tb .ubp-stop-logo {
  font-size: 13px; letter-spacing: 3px; padding: 5px 9px; border-radius: 6px;
  background: linear-gradient(160deg, #3E6A8E, #2C4E68); color: #E8F2EE;
  box-shadow: inset 0 0 0 1px rgba(232, 242, 238, 0.4);
}
.ubp-skin-xianxia:not(.ubp-dark) .ubp-tb .ubp-stop-search { background: rgba(62, 106, 142, 0.08); color: #46606F; }
/* 浅色头部：分段标签改黛青墨字（基线白字在浅纸上不可见） */
.ubp-skin-xianxia:not(.ubp-dark) .ubp-tb { --tb-seg: rgba(62, 106, 142, 0.8); --tb-seg-on: #1E2B26; --tb-seg-bar: #3E6A8E; }

/* ── 武侠·惊堂：英雄楼（黛蓝） + 风物志（竹青） ── */
.ubp-skin-wuxia .ubp-tb { --tb-acc: #3E5C74; --tb-acc-soft: rgba(62, 92, 116, 0.13); --app-acc: #3E5C74; --segl: #3E5C74; }
.ubp-skin-wuxia .ubp-xhs { --xhs-acc: #4F7048; --xhs-star: #B08A2E; --xhs-topic: #3E5C74; --app-acc: #4F7048; --segl: #4F7048; }
.ubp-skin-wuxia.ubp-dark .ubp-tb { --tb-acc: #6289A6; --tb-acc-soft: rgba(98, 137, 166, 0.18); --app-acc: #82AAC6; --segl: #82AAC6; }
.ubp-skin-wuxia.ubp-dark .ubp-xhs { --xhs-acc: #7FA06C; --xhs-topic: #82AAC6; --app-acc: #7FA06C; --segl: #7FA06C; }
.ubp-skin-wuxia.ubp-dark .ubp-wb { --wb-acc: #D9604E; --wb-org: #D9604E; --wb-topic: #D9604E; --app-acc: #D9604E; --segl: #D9604E; }
.ubp-skin-wuxia .ubp-tb .ubp-stop { background: linear-gradient(160deg, #4A3A2C, #3E3125); border-bottom: 1px solid rgba(176, 138, 79, 0.3); }
.ubp-skin-wuxia:not(.ubp-dark) .ubp-tb .ubp-stop { background: linear-gradient(160deg, #EFE4C9, #E6D8B8); color: #33291B; border-bottom: 1px solid rgba(140, 116, 74, 0.4); }
.ubp-skin-wuxia .ubp-tb .ubp-stop-logo {
  font-size: 13px; letter-spacing: 3px; padding: 5px 9px; border-radius: 5px;
  background: linear-gradient(160deg, #8A5A34, #6B4E30); color: #F2E9D3;
  box-shadow: inset 0 0 0 1.5px rgba(176, 138, 79, 0.55);
}
.ubp-skin-wuxia:not(.ubp-dark) .ubp-tb .ubp-stop-search { background: rgba(140, 116, 74, 0.12); color: #5C4E36; }
.ubp-skin-wuxia:not(.ubp-dark) .ubp-tb { --tb-seg: rgba(122, 90, 52, 0.8); --tb-seg-on: #33291B; --tb-seg-bar: #8A5A34; }

/* ── 西幻·纹章：行会大厅（魔蓝） + 藏宝图鉴（金褐） ── */
.ubp-skin-fantasy .ubp-tb { --tb-acc: #46589E; --tb-acc-soft: rgba(70, 88, 158, 0.14); --app-acc: #46589E; --segl: #46589E; }
.ubp-skin-fantasy .ubp-xhs { --xhs-acc: #8A6A2E; --xhs-star: #C9A24B; --xhs-topic: #8A6A2E; --app-acc: #8A6A2E; --segl: #8A6A2E; }
.ubp-skin-fantasy.ubp-dark .ubp-tb { --tb-acc: #7589CC; --tb-acc-soft: rgba(117, 137, 204, 0.18); --app-acc: #93A5DB; --segl: #93A5DB; }
.ubp-skin-fantasy.ubp-dark .ubp-xhs { --xhs-acc: #B98F45; --xhs-topic: #C9B072; --app-acc: #B98F45; --segl: #B98F45; }
.ubp-skin-fantasy .ubp-tb .ubp-stop { background: linear-gradient(160deg, #2A2C48, #22243C); border-bottom: 1px solid rgba(201, 162, 75, 0.25); }
.ubp-skin-fantasy:not(.ubp-dark) .ubp-tb .ubp-stop { background: linear-gradient(160deg, #E5E0D0, #D9D2BD); color: #33291B; border-bottom: 1px solid rgba(138, 106, 46, 0.3); }
.ubp-skin-fantasy .ubp-tb .ubp-stop-logo {
  font-size: 13px; letter-spacing: 3px; padding: 5px 9px; border-radius: 6px;
  background: linear-gradient(160deg, #46589E, #374580); color: #E8D9A8;
  box-shadow: inset 0 0 0 1px rgba(232, 217, 168, 0.4);
}
.ubp-skin-fantasy:not(.ubp-dark) .ubp-tb .ubp-stop-search { background: rgba(138, 106, 46, 0.1); color: #5C4E36; }
.ubp-skin-fantasy:not(.ubp-dark) .ubp-tb { --tb-seg: rgba(70, 88, 158, 0.82); --tb-seg-on: #33291B; --tb-seg-bar: #46589E; }

/* ── 游戏中心（docs/16；像素级对齐 docs/game-center-mockup.html V2 暗色稿） ── */
/* 作用域：.ubp-gm-page 携带独立暗色调色板（默认与皮肤无关，保证与 mockup 一致；
   皮肤显式覆盖 --gmc-* 时由 core/skin-themes 的 APP_TOKEN_ROOTS 投递到本根——见 docs/14 的 App 调色板一节）。
   全部字号必须写成 CSS 类（进入底部 PHONE_CSS 的 calc(--ubp-font-scale) 缩放管线），
   严禁在渲染器里内联 font-size（内联样式不参与缩放——V1.012 字体不跟随设置的根因）。 */
.ubp-gm-page {
  --gmc-bg: #0d0d12; --gmc-card: #17171f; --gmc-card2: #20202b; --gmc-card3: #2a2a38;
  --gmc-line: #2e2e3c; --gmc-text: #f2f2f6; --gmc-text2: #a0a0ad; --gmc-text3: #62626e;
  --gmc-acc: #8b5cf6; --gmc-acc2: #a78bfa; --gmc-good: #34c77b; --gmc-seer: #38bdf8;
  --app-acc: var(--gmc-acc); --app-on-acc: #fff;
  --gmc-amber: #f59e0b; --gmc-red: #ef4444; --gmc-gold: #ffd700;
  --gmc-soup: #2dd4bf; --gmc-soup2: #5eead4;
  display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative;
  background: var(--gmc-bg); color: var(--gmc-text);
}
.ubp-gm-page .ubp-appbar { flex: none; background: var(--gmc-card); border-bottom: 1px solid var(--gmc-line); }
.ubp-gm-page .ubp-appbar-title { color: var(--gmc-text); }
.ubp-gm-page .ubp-iconbtn { color: var(--gmc-text2); }
.ubp-gm-page .ubp-iconbtn:active { background: var(--gmc-card2); }
.ubp-gm-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 10px 12px 12px; scrollbar-width: none; }
.ubp-gm-body::-webkit-scrollbar { width: 0; height: 0; }
/* ── 通用件（mockup .card/.btn/.tag/.muted/.dim） ── */
.ubp-gm-card { background: var(--gmc-card); border-radius: 14px; padding: 13px; margin-bottom: 10px; border: 1px solid rgba(255, 255, 255, 0.03); }
.ubp-gm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: none; border-radius: 10px; padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer; background: var(--gmc-card3); color: var(--gmc-text); font-family: inherit; }
.ubp-gm-btn:disabled { opacity: 0.45; cursor: default; }
.ubp-gm-btn.primary { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.35); }
.ubp-gm-btn.amber { background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; }
.ubp-gm-btn.ghost { background: transparent; border: 1px solid var(--gmc-line); }
.ubp-gm-btn.block { width: 100%; }
.ubp-gm-tag { display: inline-block; font-size: 10px; padding: 2px 7px; border-radius: 99px; font-weight: 600; }
.ubp-gm-tag.purple { background: rgba(139, 92, 246, 0.16); color: var(--gmc-acc2); }
.ubp-gm-tag.amber { background: rgba(245, 158, 11, 0.15); color: var(--gmc-amber); }
.ubp-gm-tag.green { background: rgba(52, 199, 123, 0.14); color: var(--gmc-good); }
.ubp-gm-tag.red { background: rgba(239, 68, 68, 0.15); color: #f87171; }
.ubp-gm-tag.gray { background: rgba(255, 255, 255, 0.06); color: var(--gmc-text3); }
.ubp-gm-muted { color: var(--gmc-text2); font-size: 12px; line-height: 1.55; }
.ubp-gm-dim { color: var(--gmc-text3); font-size: 11px; line-height: 1.5; }
.ubp-gm-t125b { font-size: 12.5px; font-weight: 700; color: var(--gmc-text); }
.ubp-gm-t12b { font-size: 12px; font-weight: 700; color: var(--gmc-text); }
.ubp-gm-t13 { font-size: 13px; font-weight: 600; color: var(--gmc-text); }
.ubp-gm-t105 { font-size: 10.5px; color: var(--gmc-text3); }
.ubp-gm-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ubp-gm-flex1 { flex: 1; min-width: 0; }
/* ── 首页（mockup 屏1） ── */
.ubp-gm-gcard { position: relative; border-radius: 16px; padding: 16px 14px 14px; margin-bottom: 12px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.05); cursor: pointer; }
.ubp-gm-gcard.werewolf { background: linear-gradient(135deg, #241a33 0%, #181122 60%); }
.ubp-gm-gcard.undercover { background: linear-gradient(135deg, #332816 0%, #1d1811 60%); }
.ubp-gm-gcard .ubp-gm-gico { width: 52px; height: 52px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 27px; margin-bottom: 10px; }
.ubp-gm-gcard.werewolf .ubp-gm-gico { background: rgba(180, 83, 255, 0.18); }
.ubp-gm-gcard.undercover .ubp-gm-gico { background: rgba(245, 158, 11, 0.16); }
.ubp-gm-gname { font-size: 17px; font-weight: 800; margin-bottom: 3px; }
.ubp-gm-gdesc { font-size: 11.5px; color: var(--gmc-text2); line-height: 1.5; padding-right: 52px; }
.ubp-gm-go { position: absolute; right: 14px; bottom: 14px; font-size: 11px; color: var(--gmc-text3); }
.ubp-gm-ribbon { position: absolute; top: 12px; right: 12px; }
.ubp-gm-resumebar { display: flex; align-items: center; gap: 10px; background: linear-gradient(90deg, rgba(139, 92, 246, 0.18), rgba(139, 92, 246, 0.05)); border: 1px solid rgba(139, 92, 246, 0.35); border-radius: 14px; padding: 11px 13px; margin-bottom: 12px; cursor: pointer; }
.ubp-gm-dot { width: 8px; height: 8px; border-radius: 99px; background: var(--gmc-acc2); box-shadow: 0 0 8px var(--gmc-acc2); flex: none; animation: ubp-gm-pulse 1.6s infinite; }
@keyframes ubp-gm-pulse { 50% { opacity: 0.35; } }
.ubp-gm-rt { font-size: 12.5px; font-weight: 700; color: var(--gmc-text); }
.ubp-gm-rs { font-size: 10.5px; color: var(--gmc-text2); margin-top: 1px; }
.ubp-gm-go2 { color: var(--gmc-acc2); font-size: 12px; flex: none; }
.ubp-gm-recrow { display: flex; align-items: center; gap: 11px; padding: 11px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); cursor: pointer; }
.ubp-gm-recrow:last-child { border-bottom: none; }
.ubp-gm-recico { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 17px; flex: none; }
.ubp-gm-recname { font-size: 12.5px; font-weight: 600; color: var(--gmc-text); }
.ubp-gm-recsub { font-size: 10.5px; color: var(--gmc-text3); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-gm-placeholder { border: 1px dashed var(--gmc-line); border-radius: 16px; padding: 16px; text-align: center; color: var(--gmc-text3); font-size: 12px; }
/* ── 席位（mockup 屏4/6/10） ── */
.ubp-gm-seatgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin-bottom: 12px; }
.ubp-gm-seat { background: var(--gmc-card2); border-radius: 13px; padding: 10px 6px 8px; text-align: center; position: relative; border: 1px solid transparent; }
.ubp-gm-seat.me { border-color: rgba(139, 92, 246, 0.55); background: rgba(139, 92, 246, 0.08); }
.ubp-gm-seat.dead { opacity: 0.38; filter: grayscale(0.8); }
.ubp-gm-seat.pick { border-color: var(--gmc-amber); background: rgba(245, 158, 11, 0.07); cursor: pointer; }
.ubp-gm-seat.sel { box-shadow: 0 0 0 2px var(--gmc-amber), 0 0 14px rgba(245, 158, 11, 0.35); border-color: var(--gmc-amber); background: rgba(245, 158, 11, 0.12); }
.ubp-gm-seat.sel.seer-sel { box-shadow: 0 0 0 2px var(--gmc-seer), 0 0 14px rgba(56, 189, 248, 0.35); border-color: var(--gmc-seer); background: rgba(56, 189, 248, 0.1); }
.ubp-gm-seat .ubp-avatar { width: 44px; height: 44px; border-radius: 12px; margin: 0 auto 5px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.ubp-gm-seat .ubp-gm-nm { font-size: 12px; font-weight: 600; color: var(--gmc-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-gm-seat .ubp-gm-ps { font-size: 10px; color: var(--gmc-text3); margin-top: 1px; }
.ubp-gm-badge { position: absolute; top: -5px; right: -3px; font-size: 10px; padding: 2px 7px; border-radius: 99px; font-weight: 600; background: rgba(239, 68, 68, 0.15); color: #f87171; }
.ubp-gm-badge.gray { background: rgba(255, 255, 255, 0.08); color: var(--gmc-text3); }
.ubp-gm-badge.purple { background: rgba(139, 92, 246, 0.2); color: var(--gmc-acc2); }
.ubp-gm-badge.amber { background: rgba(245, 158, 11, 0.15); color: var(--gmc-amber); }
/* ── NPC 补位（docs/16 §10：临时牌友开关 / 预览行 / 🎭 角标） ── */
.ubp-gm-fillbar { display: flex; align-items: center; gap: 9px; border-radius: 14px; padding: 10px 12px; margin-bottom: 10px; background: linear-gradient(90deg, rgba(56, 189, 248, 0.16), rgba(56, 189, 248, 0.03)); border: 1px solid rgba(125, 211, 252, 0.42); }
.ubp-gm-fillbar.idle { background: rgba(255, 255, 255, 0.03); border-color: var(--gmc-line); }
.ubp-gm-fillbar .ubp-gm-fillico { font-size: 16px; flex: none; }
.ubp-gm-fillbar b { color: #7dd3fc; }
.ubp-gm-t115 { font-size: 11.5px; color: var(--gmc-text); line-height: 1.5; }
.ubp-gm-switch { width: 40px; height: 22px; border-radius: 99px; background: var(--gmc-card3); border: 1px solid var(--gmc-line); position: relative; flex: none; cursor: pointer; }
.ubp-gm-switch i { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 99px; background: #8b8b98; transition: left 0.15s ease, background 0.15s ease; }
.ubp-gm-switch.on { background: rgba(56, 189, 248, 0.28); border-color: var(--gmc-seer); }
.ubp-gm-switch.on i { left: 20px; background: #7dd3fc; }
.ubp-gm-npctag { font-size: 10px; opacity: 0.9; }
.ubp-gm-npcpin { position: absolute; top: -5px; left: -3px; font-size: 11px; }
.ubp-gm-friendrow.npc { background: rgba(56, 189, 248, 0.05); border: 1px dashed rgba(125, 211, 252, 0.32); border-radius: 10px; margin-bottom: 4px; padding: 9px 8px; }
.ubp-gm-btn.sm { padding: 5px 10px; font-size: 11px; border-radius: 8px; }
/* ── 日志流（mockup 屏4/5） ── */
.ubp-gm-phase { display: flex; align-items: center; justify-content: center; gap: 7px; margin: 2px 0 10px; font-size: 12.5px; font-weight: 700; color: var(--gmc-text); }
.ubp-gm-log { margin-bottom: 9px; }
.ubp-gm-sys { font-size: 11.5px; color: #c9b8ff; background: rgba(139, 92, 246, 0.09); border-radius: 9px; padding: 7px 10px; line-height: 1.5; word-break: break-word; }
.ubp-gm-sys.night { background: rgba(56, 189, 248, 0.08); color: #9dd8fa; }
.ubp-gm-sys.death { background: rgba(239, 68, 68, 0.1); color: #fda4a4; }
.ubp-gm-brow { display: flex; gap: 9px; align-items: flex-start; margin-bottom: 9px; }
.ubp-gm-brow.rev { flex-direction: row-reverse; }
.ubp-gm-brow .ubp-avatar { width: 34px; height: 34px; border-radius: 12px; flex: none; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.ubp-gm-bubble { flex: 1; min-width: 0; background: var(--gmc-card2); border-radius: 12px; padding: 8px 11px; font-size: 12.5px; line-height: 1.62; color: var(--gmc-text); word-break: break-word; }
.ubp-gm-who { font-size: 11px; color: var(--gmc-text3); margin-bottom: 3px; }
.ubp-gm-wolfpriv { flex: 1; min-width: 0; background: rgba(180, 83, 255, 0.1); border: 1px solid rgba(180, 83, 255, 0.25); border-radius: 12px; padding: 9px 11px; font-size: 12px; line-height: 1.6; color: #dcc2ff; word-break: break-word; }
.ubp-gm-wolfpriv b { font-size: 11px; }
/* ── 台词语音条（docs/50）：复用微信 .ubp-voice 组件，只在 .ubp-gm-page 作用域换一套暗色配方 ──
   纪律同 renderers/voice-meta：TTS 总开关关闭时一个语音节点都不渲染，故这里不需要 .off 置灰态；
   情绪彩标色相仍来自规范八词（--ubp-emo-h），只是把亮色配方换成与 .ubp-dark 同款的暗色配方。 */
.ubp-gm-page .ubp-voice { flex: 1; min-width: 0; background: var(--gmc-card2); border-radius: 12px; box-shadow: none; }
.ubp-gm-page .ubp-voice > .ubp-gm-who { padding: 7px 11px 0; }
.ubp-gm-page .ubp-voice-bar { height: 34px; padding: 0 11px; }
.ubp-gm-page .ubp-voice-bar svg { width: 16px; height: 16px; }
.ubp-gm-page .ubp-voice-dur { font-size: 12.5px; color: var(--gmc-text2); }
.ubp-gm-page .ubp-voice-progress { background: var(--gmc-acc2); opacity: 0.2; }
.ubp-gm-page .ubp-voice > .ubp-vmeta { padding: 6px 11px 2px; border-top-color: rgba(255, 255, 255, 0.06); }
.ubp-gm-page .ubp-voice-text { color: var(--gmc-text2); border-top-color: rgba(255, 255, 255, 0.06); font-size: 12.5px; }
.ubp-gm-page .ubp-deliv { color: var(--gmc-text3); }
.ubp-gm-page .ubp-emo { background: hsl(var(--ubp-emo-h, 0) 42% 20%); color: hsl(var(--ubp-emo-h, 0) 88% 78%); box-shadow: inset 0 0 0 1px hsl(var(--ubp-emo-h, 0) 46% 33%); }
.ubp-gm-page .ubp-emo-unknown { background: var(--gmc-card3); color: var(--gmc-text3); box-shadow: inset 0 0 0 1px var(--gmc-line); }
/* ── 输入/控制区（mockup 屏5/6） ── */
.ubp-gm-inputbar { display: flex; gap: 7px; padding: 9px 12px; border-top: 1px solid var(--gmc-line); background: var(--gmc-card); flex: none; align-items: center; }
.ubp-gm-inputbar input { flex: 1; min-width: 0; background: var(--gmc-card2); border: 1px solid var(--gmc-line); border-radius: 10px; padding: 9px 11px; color: var(--gmc-text); font-size: 12.5px; outline: none; font-family: inherit; }
.ubp-gm-inputbar input:focus { border-color: var(--gmc-acc); }
.ubp-gm-ctl { flex: none; padding: 9px 12px 14px; border-top: 1px solid var(--gmc-line); background: var(--gmc-card); display: flex; gap: 8px; align-items: center; }
.ubp-gm-ctlcol { flex: none; padding: 9px 12px 14px; border-top: 1px solid var(--gmc-line); background: var(--gmc-card); display: flex; flex-direction: column; gap: 8px; }
.ubp-gm-strip { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 10px; padding: 8px 10px; font-size: 12px; color: #fcd34d; }
.ubp-gm-strip.seer { background: rgba(56, 189, 248, 0.1); border-color: rgba(56, 189, 248, 0.35); color: #7dd3fc; }
.ubp-gm-spin { width: 13px; height: 13px; border-radius: 99px; border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff; animation: ubp-gm-rot 0.8s linear infinite; flex: none; }
@keyframes ubp-gm-rot { to { transform: rotate(360deg); } }
.ubp-gm-genbar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 9px 12px 12px; padding: 9px 12px; border-radius: 10px; background: rgba(139, 92, 246, 0.12); color: #c9b8ff; font-size: 12px; border: 1px solid rgba(139, 92, 246, 0.3); }
.ubp-gm-genbar button { border: none; background: rgba(139, 92, 246, 0.25); color: #e4d9ff; border-radius: 8px; padding: 5px 10px; font-size: 11.5px; cursor: pointer; font-family: inherit; }
/* ── 战术板/药瓶（mockup 屏4） ── */
.ubp-gm-tactic-card { background: rgba(180, 83, 255, 0.06); border: 1px solid rgba(180, 83, 255, 0.3); border-radius: 14px; padding: 12px; margin-bottom: 10px; }
.ubp-gm-tactic-title { font-size: 12px; font-weight: 700; color: #dcc2ff; margin-bottom: 7px; }
.ubp-gm-tactic-label { font-size: 10.5px; color: var(--gmc-text3); margin: 6px 0 4px; }
.ubp-gm-tactic-row { display: flex; gap: 7px; margin-bottom: 4px; }
.ubp-gm-tactic-btn { flex: 1; text-align: center; background: var(--gmc-card3); border: 1px solid var(--gmc-line); border-radius: 9px; padding: 8px 0; font-size: 12px; color: var(--gmc-text2); cursor: pointer; font-family: inherit; }
.ubp-gm-tactic-btn.on { background: rgba(139, 92, 246, 0.25); border-color: var(--gmc-acc); color: #fff; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(167, 139, 250, 0.6); }
.ubp-gm-tactic-btn.on.green { background: rgba(52, 199, 123, 0.18); border-color: var(--gmc-good); color: #a7f3cf; box-shadow: none; }
.ubp-gm-tactic-btn:disabled { opacity: 0.4; cursor: default; }
/* ── 终局（mockup 屏7/10） ── */
.ubp-gm-verdict { border-radius: 16px; padding: 18px 14px; text-align: center; background: linear-gradient(160deg, rgba(139, 92, 246, 0.25), rgba(139, 92, 246, 0.06)); border: 1px solid rgba(139, 92, 246, 0.4); margin-bottom: 12px; }
.ubp-gm-verdict.lost { background: linear-gradient(160deg, rgba(239, 68, 68, 0.2), rgba(239, 68, 68, 0.05)); border-color: rgba(239, 68, 68, 0.4); }
.ubp-gm-verdict.soup { background: linear-gradient(160deg, rgba(52, 199, 123, 0.24), rgba(52, 199, 123, 0.05)); border-color: rgba(52, 199, 123, 0.4); }
.ubp-gm-vemoji { font-size: 30px; margin-bottom: 4px; }
.ubp-gm-vbig { font-size: 20px; font-weight: 900; letter-spacing: 2px; color: var(--gmc-text); }
.ubp-gm-vwho { font-size: 12px; color: var(--gmc-text2); margin-top: 5px; }
.ubp-gm-reveal { display: flex; align-items: center; gap: 9px; padding: 7px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); font-size: 12px; color: var(--gmc-text); }
.ubp-gm-reveal:last-child { border-bottom: none; }
.ubp-gm-reveal .ubp-avatar { width: 30px; height: 30px; border-radius: 9px; flex: none; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
/* ── 记录详情 tabs / 高光 / 复盘聊天（mockup 屏8） ── */
.ubp-gm-tabs { flex: none; display: flex; gap: 6px; padding: 10px 12px 10px; background: var(--gmc-bg); }
.ubp-gm-tab { flex: 1; text-align: center; font-size: 12px; padding: 8px 0; border-radius: 9px; background: var(--gmc-card2); color: var(--gmc-text2); border: 1px solid transparent; cursor: pointer; font-family: inherit; }
.ubp-gm-tab.on { background: rgba(139, 92, 246, 0.16); border-color: rgba(139, 92, 246, 0.4); color: #fff; font-weight: 700; }
.ubp-gm-hl { background: linear-gradient(160deg, rgba(255, 215, 0, 0.09), rgba(255, 215, 0, 0.02)); border: 1px solid rgba(255, 215, 0, 0.25); border-radius: 12px; padding: 11px 12px; font-size: 12.5px; line-height: 1.75; color: var(--gmc-text); margin-bottom: 10px; word-break: break-word; }
.ubp-gm-afterline { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; line-height: 1.6; background: var(--gmc-card2); border-radius: 10px; padding: 7px 10px; margin-bottom: 6px; color: var(--gmc-text); word-break: break-word; }
.ubp-gm-afterline .ubp-avatar { width: 26px; height: 26px; border-radius: 8px; flex: none; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.ubp-gm-afterline b { color: var(--gmc-acc2); font-weight: 600; margin-right: 4px; }
/* ── 全景复盘重设计：系统流水=细分割线 / 思考=角色色虚线卡 / 狼队密谋=紫底面板；发言行复用 .ubp-gm-brow+.ubp-gm-bubble，角色色走内联（仅颜色，禁内联 font-size） ── */
.ubp-gm-rdiv { display: flex; align-items: center; gap: 10px; margin: 11px 2px 9px; font-size: 10.5px; color: var(--gmc-text2); text-align: center; word-break: break-word; }
.ubp-gm-rdiv::before, .ubp-gm-rdiv::after { content: ""; flex: 1; height: 1px; background: var(--gmc-line); }
.ubp-gm-rdiv.red { color: #f87171; }
.ubp-gm-rthink { border: 1px dashed rgba(255, 255, 255, 0.3); border-radius: 8px; padding: 5px 9px; margin-bottom: 5px; font-size: 11.5px; line-height: 1.55; color: #a8a8b4; word-break: break-word; }
.ubp-gm-rthink b { font-weight: 700; margin-right: 3px; }
.ubp-gm-rwho { font-size: 11px; font-weight: 700; margin-bottom: 3px; }
.ubp-gm-rwho i { font-style: normal; font-weight: 400; color: var(--gmc-text3); margin-left: 5px; }
.ubp-gm-rwolf { background: rgba(180, 83, 255, 0.1); border: 1px solid rgba(180, 83, 255, 0.32); border-radius: 14px; padding: 8px 9px 3px; margin-bottom: 10px; }
.ubp-gm-rwolf-hd { font-size: 10.5px; font-weight: 700; color: #c9a0f5; margin: 0 2px 8px; }
/* ── 卧底（mockup 屏9） ── */
.ubp-gm-wordcard { border-radius: 16px; padding: 18px; text-align: center; background: linear-gradient(160deg, rgba(245, 158, 11, 0.18), rgba(245, 158, 11, 0.04)); border: 1px solid rgba(245, 158, 11, 0.35); margin-bottom: 12px; }
.ubp-gm-wordkey { font-size: 11px; color: var(--gmc-amber); font-weight: 700; }
.ubp-gm-word { font-size: 26px; font-weight: 900; letter-spacing: 6px; margin: 8px 0 4px; color: var(--gmc-text); }
.ubp-gm-wordsub { font-size: 10.5px; color: var(--gmc-text2); }
.ubp-gm-descline { display: flex; gap: 9px; align-items: flex-start; font-size: 12.5px; line-height: 1.6; background: var(--gmc-card2); border-radius: 12px; padding: 8px 11px; margin-bottom: 8px; color: var(--gmc-text); word-break: break-word; }
.ubp-gm-descline .ubp-avatar { width: 30px; height: 30px; border-radius: 12px; flex: none; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.ubp-gm-descline.turn { outline: 1px dashed rgba(245, 158, 11, 0.4); }
/* ── 邀请（mockup 屏2） ── */
.ubp-gm-friendrow { display: flex; align-items: center; gap: 10px; padding: 9px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); cursor: pointer; }
.ubp-gm-friendrow:last-child { border-bottom: none; }
.ubp-gm-friendrow .ubp-avatar { width: 38px; height: 38px; border-radius: 12px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.ubp-gm-checkbox { width: 19px; height: 19px; border-radius: 6px; border: 1.5px solid var(--gmc-text3); margin-left: auto; flex: none; }
.ubp-gm-checkbox.on { background: var(--gmc-acc); border-color: var(--gmc-acc); position: relative; }
.ubp-gm-checkbox.on::after { content: "✓"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #fff; }
/* ── 身份揭示（mockup 屏3） ── */
.ubp-gm-rolecard { border-radius: 14px; padding: 24px 16px; text-align: center; margin-bottom: 10px; background: linear-gradient(160deg, rgba(139, 92, 246, 0.16), rgba(139, 92, 246, 0.04)); border: 1px solid rgba(139, 92, 246, 0.4); }
.ubp-gm-rolecard.role-wolf { background: linear-gradient(160deg, rgba(180, 83, 255, 0.18), rgba(180, 83, 255, 0.04)); border-color: rgba(180, 83, 255, 0.45); }
.ubp-gm-rolecard.role-seer { background: linear-gradient(160deg, rgba(56, 189, 248, 0.16), rgba(56, 189, 248, 0.04)); border-color: rgba(56, 189, 248, 0.4); }
.ubp-gm-rolecard.role-witch { background: linear-gradient(160deg, rgba(244, 114, 182, 0.16), rgba(244, 114, 182, 0.04)); border-color: rgba(244, 114, 182, 0.4); }
.ubp-gm-rolecard.role-good { background: linear-gradient(160deg, rgba(52, 199, 123, 0.14), rgba(52, 199, 123, 0.04)); border-color: rgba(52, 199, 123, 0.4); }
.ubp-gm-rolecard .ubp-avatar { width: 56px; height: 56px; border-radius: 14px; margin: 0 auto 10px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.ubp-gm-rolename { font-size: 22px; font-weight: 900; color: var(--gmc-text); }
/* ── 海龟汤（docs/16 §9；像素级对齐 docs/game-center-mockup-turtlesoup.html V1.1 暗色稿） ── */
.ubp-gm-gcard.turtlesoup { background: linear-gradient(135deg, #12312e 0%, #0e1a1d 60%); border-color: rgba(45, 212, 191, 0.22); }
.ubp-gm-gcard.turtlesoup .ubp-gm-gico { background: rgba(45, 212, 191, 0.16); }
.ubp-gm-tag.soup { background: rgba(45, 212, 191, 0.16); color: var(--gmc-soup2); }
.ubp-gm-btn.soup { background: linear-gradient(135deg, #2dd4bf, #0d9488); color: #04211d; box-shadow: 0 4px 14px rgba(45, 212, 191, 0.3); }
.ubp-gm-btn.danger { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; }
.ubp-gm-resumebar.soup { background: linear-gradient(90deg, rgba(45, 212, 191, 0.16), rgba(45, 212, 191, 0.04)); border-color: rgba(45, 212, 191, 0.4); }
.ubp-gm-resumebar.soup .ubp-gm-dot { background: var(--gmc-soup2); box-shadow: 0 0 8px var(--gmc-soup2); }
.ubp-gm-resumebar.soup .ubp-gm-go2 { color: var(--gmc-soup2); }
.ubp-gm-sys.soup { background: rgba(45, 212, 191, 0.08); color: var(--gmc-soup2); }
.ubp-gm-navact { width: 32px; flex: none; text-align: right; color: #f87171; font-size: 13px; cursor: pointer; background: none; border: none; padding: 0; font-family: inherit; }
/* 邀请页（mockup 屏2） */
.ubp-gm-seclabel { font-size: 12.5px; font-weight: 800; margin: 2px 0 7px; display: flex; align-items: center; gap: 6px; color: var(--gmc-text); }
.ubp-gm-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.ubp-gm-chip { flex: 1; text-align: center; background: var(--gmc-card3); border: 1px solid var(--gmc-line); border-radius: 9px; padding: 7px 0; font-size: 11.5px; color: var(--gmc-text2); cursor: pointer; font-family: inherit; }
.ubp-gm-chip.on { background: rgba(45, 212, 191, 0.18); border-color: var(--gmc-soup); color: var(--gmc-soup2); font-weight: 700; }
.ubp-gm-stepper { display: flex; align-items: center; gap: 12px; }
.ubp-gm-stp { width: 30px; height: 30px; border-radius: 9px; background: var(--gmc-card3); border: 1px solid var(--gmc-line); display: flex; align-items: center; justify-content: center; font-size: 16px; color: var(--gmc-text); cursor: pointer; font-family: inherit; flex: none; }
.ubp-gm-stp:disabled { opacity: 0.4; cursor: default; }
.ubp-gm-num { font-size: 22px; font-weight: 900; color: var(--gmc-soup2); min-width: 44px; text-align: center; }
.ubp-gm-friendrow.host { background: rgba(45, 212, 191, 0.07); border-radius: 10px; padding: 9px 8px; border-bottom: none; margin-bottom: 2px; border: 1px solid rgba(45, 212, 191, 0.35); }
.ubp-gm-hostbtn { width: 24px; height: 24px; border-radius: 8px; border: 1px solid var(--gmc-line); background: var(--gmc-card3); color: var(--gmc-text3); font-size: 12px; line-height: 1; cursor: pointer; flex: none; margin-left: auto; padding: 0; font-family: inherit; }
.ubp-gm-hostbtn.on { background: rgba(45, 212, 191, 0.18); border-color: var(--gmc-soup); color: var(--gmc-soup2); }
.ubp-gm-soupinv .ubp-gm-friendrow .ubp-gm-checkbox { margin-left: 8px; }
.ubp-gm-soupinv .ubp-gm-checkbox.soup-fixed { margin-left: auto; }
.ubp-gm-soupinv .ubp-gm-checkbox.dis { opacity: 0.35; }
.ubp-gm-soupinv .ubp-gm-checkbox { width: 20px; height: 20px; border-radius: 7px; }
.ubp-gm-soupinv .ubp-gm-checkbox.on { background: linear-gradient(135deg, #2dd4bf, #0d9488); border-color: transparent; }
.ubp-gm-soupinv .ubp-gm-checkbox.on::after { color: #04211d; }
.ubp-gm-checkbox.fixed { background: rgba(139, 92, 246, 0.25); border-color: rgba(139, 92, 246, 0.5); position: relative; }
.ubp-gm-checkbox.fixed::after { content: "我"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #cdbcff; font-size: 9px; font-weight: 800; }
/* 对局（mockup 屏3/4） */
.ubp-gm-soupface { border-radius: 16px; padding: 15px 14px; background: linear-gradient(160deg, rgba(45, 212, 191, 0.17), rgba(45, 212, 191, 0.04)); border: 1px solid rgba(45, 212, 191, 0.4); margin-bottom: 10px; }
.ubp-gm-st { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
.ubp-gm-sticon { font-size: 17px; flex: none; line-height: 1; }
.ubp-gm-stitle { font-size: 15px; font-weight: 900; letter-spacing: 0.5px; color: var(--gmc-text); }
.ubp-gm-stitle.reveal { color: var(--gmc-soup2); }
.ubp-gm-stext { font-size: 12.5px; line-height: 1.75; color: var(--gmc-text); word-break: break-word; }
.ubp-gm-skey { font-size: 10.5px; color: var(--gmc-text3); margin-top: 8px; }
.ubp-gm-quota { display: flex; align-items: center; gap: 9px; background: var(--gmc-card); border: 1px solid rgba(255, 255, 255, 0.04); border-radius: 12px; padding: 9px 12px; margin-bottom: 10px; }
.ubp-gm-qnum { font-size: 13px; font-weight: 800; color: var(--gmc-soup2); flex: none; }
.ubp-gm-qbar { flex: 1; height: 6px; border-radius: 99px; background: var(--gmc-card3); overflow: hidden; }
.ubp-gm-qbar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #2dd4bf, #0d9488); }
.ubp-gm-qtxt { font-size: 10.5px; color: var(--gmc-text3); flex: none; }
.ubp-gm-qno { float: right; font-size: 10px; color: var(--gmc-soup2); background: rgba(45, 212, 191, 0.16); border-radius: 99px; padding: 1px 7px; font-weight: 700; margin-left: 7px; }
.ubp-gm-bubble.mine { border-left: 3px solid rgba(139, 92, 246, 0.7); }
.ubp-gm-bubble.guess { border: 1px solid rgba(45, 212, 191, 0.45); background: rgba(45, 212, 191, 0.06); }
.ubp-gm-bubble.guess .ubp-gm-who b { color: var(--gmc-soup2); }
.ubp-gm-ansrow { display: flex; gap: 9px; align-items: flex-start; margin-bottom: 9px; }
.ubp-gm-hostava { position: relative; flex: none; }
.ubp-gm-hostava .ubp-avatar { width: 34px; height: 34px; border-radius: 12px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.ubp-gm-crown { position: absolute; top: -7px; left: -7px; font-size: 12px; line-height: 1; }
.ubp-gm-ansbox { flex: 1; min-width: 0; }
.ubp-gm-ansline { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.ubp-gm-ans-tag { font-size: 12px; font-weight: 900; padding: 3px 12px; border-radius: 99px; letter-spacing: 1px; flex: none; }
.ubp-gm-ans-tag.yes { background: rgba(52, 199, 123, 0.16); color: var(--gmc-good); border: 1px solid rgba(52, 199, 123, 0.4); }
.ubp-gm-ans-tag.no { background: rgba(239, 68, 68, 0.14); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
.ubp-gm-ans-tag.part { background: rgba(245, 158, 11, 0.14); color: var(--gmc-amber); border: 1px solid rgba(245, 158, 11, 0.4); }
.ubp-gm-ans-tag.irr { background: rgba(255, 255, 255, 0.07); color: var(--gmc-text3); border: 1px solid var(--gmc-line); }
.ubp-gm-by { font-size: 10.5px; color: var(--gmc-text3); }
.ubp-gm-ansvoice { font-size: 12px; color: var(--gmc-text2); line-height: 1.55; background: var(--gmc-card2); border-radius: 10px; padding: 7px 10px; word-break: break-word; }
.ubp-gm-verdictline { font-size: 11.5px; border-radius: 9px; padding: 7px 10px; line-height: 1.5; margin-bottom: 9px; word-break: break-word; }
.ubp-gm-verdictline.miss { background: rgba(239, 68, 68, 0.08); color: #fda4a4; border: 1px solid rgba(239, 68, 68, 0.25); }
.ubp-gm-verdictline.hit { background: rgba(52, 199, 123, 0.1); color: #86efac; border: 1px solid rgba(52, 199, 123, 0.35); }
.ubp-gm-soupgen { flex: none; display: flex; align-items: center; gap: 9px; padding: 9px 12px 14px; border-top: 1px solid var(--gmc-line); background: var(--gmc-card); font-size: 12px; color: var(--gmc-text2); }
.ubp-gm-soupgen button { margin-left: auto; background: transparent; border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; border-radius: 8px; padding: 5px 11px; font-size: 11.5px; cursor: pointer; font-family: inherit; flex: none; }
.ubp-gm-spin.soup { border-color: rgba(45, 212, 191, 0.25); border-top-color: var(--gmc-soup2); }
/* 弹层（mockup 屏5/6） */
.ubp-gm-body.blur { filter: blur(1px); opacity: 0.6; }
.ubp-gm-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 5; display: flex; align-items: flex-end; }
.ubp-gm-sheet { background: var(--gmc-card2); border-radius: 18px 18px 0 0; width: 100%; padding: 16px 14px 20px; border-top: 1px solid rgba(45, 212, 191, 0.3); }
.ubp-gm-sheet.danger { border-top-color: rgba(239, 68, 68, 0.35); }
.ubp-gm-sht { font-size: 15px; font-weight: 800; margin-bottom: 5px; color: var(--gmc-text); }
.ubp-gm-shd { font-size: 11.5px; color: var(--gmc-text2); line-height: 1.6; margin-bottom: 10px; }
.ubp-gm-shd b { font-weight: 700; }
.ubp-gm-sheet textarea { width: 100%; height: 110px; background: var(--gmc-bg); border: 1px solid var(--gmc-line); border-radius: 11px; padding: 10px 12px; color: var(--gmc-text); font-size: 12.5px; line-height: 1.6; outline: none; resize: none; margin-bottom: 11px; font-family: inherit; box-sizing: border-box; }
.ubp-gm-sheet textarea:focus { border-color: var(--gmc-soup); }
.ubp-gm-row .ubp-gm-btn { flex: 1; }
/* 终局与复盘（mockup 屏7/8/9） */
.ubp-gm-kp { display: flex; align-items: flex-start; gap: 8px; padding: 7px 2px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); font-size: 12px; line-height: 1.55; color: var(--gmc-text); }
.ubp-gm-kp:last-child { border-bottom: none; }
.ubp-gm-kic { flex: none; font-size: 13px; line-height: 1.35; }
.ubp-gm-kp.miss { color: var(--gmc-text3); }
/* 海龟汤全景复盘对齐 mockup V1.1 屏9 的 rdiv/rthink 微调（仅汤局作用域，不动两游戏 V2 基线） */
.ubp-gm-soupreplay .ubp-gm-rdiv { margin: 10px 0 8px; color: var(--gmc-text3); }
.ubp-gm-soupreplay .ubp-gm-rthink { font-size: 11px; line-height: 1.6; border-radius: 10px; padding: 6px 9px; margin-bottom: 4px; }

/* ── 不夜城（docs/18；成人向夜生活综合体 · 只读单向域）──
   独立霓虹调色板 --nz-*（先例：游戏中心 --gmc-*）；昼=冷灰纸面 + 白卡（霓虹只作强调，不铺底），
   夜=紫黑底 + 霓虹铺开（.ubp-dark 变体，霓虹保留 #FF2E7E / #B14BFF / #22D3EE / #FFC24B 原值）。
   尺度三色徽标（微涩/露骨/极限）与分层揭开（轮廓/三区马赛克/全图）是本 App 的视觉签名。
   尺度上限只有板块的 spiceMax 一个来源（全局上限/禁看标签两处设置已整体删除），街区顶栏不挂滑杆。 */

.ubp-nz {
  --nz-bg: #F5F4F8; --nz-card: #FFFFFF; --nz-card2: #EFEDF4; --nz-card3: #E3E0EB;
  --nz-text: #1E1826; --nz-text2: #5A5270; --nz-text3: #8E87A2;
  --nz-line: rgba(30, 24, 38, 0.11);
  --nz-accent: #D8146B; --nz-accent2: #7B3AD8; --nz-live: #0C86A2; --nz-gold: #B0740C;
  --nz-spice1: #8A6A84; --nz-spice2: #D8146B; --nz-spice3: #C62828;
  --nz-glass: rgba(30, 24, 38, 0.045);
  /* VI-03：本 App 品牌名收敛到统一别名，组件只认 --app-acc / --app-on-acc */
  --app-acc: var(--nz-accent); --app-on-acc: #fff; --segl: var(--nz-accent);
  display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative;
  background: var(--nz-bg); color: var(--nz-text);
}
.ubp-dark .ubp-nz {
  --nz-bg: #0B0710; --nz-card: rgba(255, 255, 255, 0.045); --nz-card2: #180F22; --nz-card3: #221530;
  --nz-text: #F3E9F5; --nz-text2: #B39CC0; --nz-text3: #7C6A8A;
  --nz-line: rgba(255, 255, 255, 0.09);
  --nz-accent: #FF2E7E; --nz-accent2: #B14BFF; --nz-live: #22D3EE; --nz-gold: #FFC24B;
  --nz-spice1: #C99BB0; --nz-spice2: #FF2E7E; --nz-spice3: #FF3B3B;
  --nz-glass: rgba(255, 255, 255, 0.045);
}
/* 共享外壳（顶栏/导航/底栏）在夜色下的表皮 */
.ubp-nz .ubp-sdetnav { background: var(--nz-card2); border-bottom-color: var(--nz-line); }
.ubp-nz .ubp-sdetnav-title b { color: var(--nz-text); }
.ubp-nz .ubp-sdetnav-title i { color: var(--nz-text3); }
.ubp-nz .ubp-iconbtn { color: var(--nz-text2); }
.ubp-nz .ubp-iconbtn:active { background: var(--nz-card3); }
.ubp-nz .ubp-sfoot { background: var(--nz-card2); border-top-color: var(--nz-line); }
.ubp-nz .ubp-sfoot-tab { color: var(--nz-text3); }
.ubp-nz .ubp-sfoot-tab.on { color: var(--nz-accent); }
.ubp-nz .ubp-sfoot-tab.plus .ico { background: linear-gradient(135deg, var(--nz-accent), var(--nz-accent2)); }
.ubp-nz-full { position: absolute; inset: 0; z-index: 30; }

/* ── 品牌顶栏（街区） ── */
.ubp-nz-top {
  flex: none; padding: 9px 12px 0; border-bottom: 1px solid var(--nz-line);
  background: linear-gradient(180deg, color-mix(in srgb, var(--nz-accent) 7%, transparent), transparent 88%);
}
.ubp-dark .ubp-nz-top { background: linear-gradient(180deg, color-mix(in srgb, var(--nz-accent) 13%, transparent), transparent 88%); }
.ubp-nz-toprow { display: flex; align-items: center; gap: 10px; padding-bottom: 7px; }
.ubp-nz-brand { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.ubp-nz-mark {
  width: 26px; height: 26px; flex: none; border-radius: 9px; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--nz-accent), var(--nz-accent2)); color: #fff;
}
.ubp-nz-mark svg { width: 17px; height: 17px; }
.ubp-dark .ubp-nz-mark { box-shadow: 0 2px 11px color-mix(in srgb, var(--nz-accent) 40%, transparent); }
.ubp-nz-words { display: flex; flex-direction: column; min-width: 0; }
.ubp-nz-wordrow { display: flex; align-items: center; gap: 4px; min-width: 0; }
.ubp-nz-word {
  font-size: 16px; font-weight: 800; font-style: normal; letter-spacing: 0.6px; line-height: 1.18;
  background: linear-gradient(96deg, var(--nz-accent), var(--nz-accent2) 62%, var(--nz-live));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: var(--nz-accent);
}
/* 测试期标记：必须是字标**兄弟节点**——套进 .ubp-nz-word 会继承 -webkit-text-fill-color: transparent 直接看不见 */
.ubp-nz-beta { font-style: normal; font-size: 10px; font-weight: 600; line-height: 1; color: var(--nz-text3); letter-spacing: 0.2px; }
.ubp-dark .ubp-nz-word { filter: drop-shadow(0 0 7px color-mix(in srgb, var(--nz-accent) 42%, transparent)); }
.ubp-nz-slogan {
  font-style: normal; font-size: 9.5px; color: var(--nz-text3); margin-top: 2px; letter-spacing: 0.2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ubp-nz-aboutbtn {
  flex: none; border: 1px solid var(--nz-line); background: var(--nz-glass); color: var(--nz-text2);
  border-radius: 12px; padding: 4px 9px; font-size: 10px; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-nz-aboutbtn:active { background: var(--nz-card3); }
.ubp-nz-boards { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; scrollbar-width: none; }
.ubp-nz-boards::-webkit-scrollbar { display: none; }
.ubp-nz-boards.wrap { flex-wrap: wrap; overflow: visible; }
.ubp-nz-bchip {
  flex: none; border: 1px solid var(--nz-line); background: var(--nz-card); color: var(--nz-text2);
  border-radius: 13px; padding: 4.5px 10px; font-size: 11px; font-family: var(--ubp-font); cursor: pointer; white-space: nowrap;
}
.ubp-nz-bchip.on { border-color: var(--nz-bc, var(--nz-accent)); color: var(--nz-text); background: color-mix(in srgb, var(--nz-bc, var(--nz-accent)) 16%, transparent); font-weight: 700; }
.ubp-nz-bchip.clear { color: var(--nz-text3); border-style: dashed; }
.ubp-nz-filterbar { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--nz-text2); padding-bottom: 7px; }
.ubp-nz-filterbar button { border: none; background: none; color: var(--nz-accent); font-size: 10.5px; font-family: var(--ubp-font); cursor: pointer; padding: 0; }

/* ── 通用小件 ── */
.ubp-nz-spacer { flex: 1; }
.ubp-nz-spice { font-size: 9.5px; font-weight: 700; padding: 1.5px 6px; border-radius: 5px; white-space: nowrap; font-style: normal; border: 1px solid transparent; cursor: pointer; font-family: var(--ubp-font); }
.ubp-nz-spice.s1 { background: color-mix(in srgb, var(--nz-spice1) 16%, transparent); color: var(--nz-spice1); border-color: color-mix(in srgb, var(--nz-spice1) 40%, transparent); }
.ubp-nz-spice.s2 { background: color-mix(in srgb, var(--nz-spice2) 14%, transparent); color: var(--nz-spice2); border-color: color-mix(in srgb, var(--nz-spice2) 40%, transparent); }
.ubp-nz-spice.s3 { background: color-mix(in srgb, var(--nz-spice3) 16%, transparent); color: var(--nz-spice3); border-color: color-mix(in srgb, var(--nz-spice3) 45%, transparent); }
.ubp-nz-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.ubp-nz-tag { border: none; background: var(--nz-glass); color: var(--nz-text2); border-radius: 7px; padding: 2px 7px; font-size: 10px; font-family: var(--ubp-font); cursor: pointer; }
.ubp-nz-tag.on { background: color-mix(in srgb, var(--nz-accent) 18%, transparent); color: var(--nz-accent); font-weight: 700; }
.ubp-nz-arow { display: flex; align-items: center; gap: 9px; margin-top: 10px; }
.ubp-nz-arow.wide { padding-top: 12px; border-top: 1px solid var(--nz-line); }
.ubp-nz-amain { flex: 1; min-width: 0; }
.ubp-nz-aname { font-size: 12.5px; font-weight: 700; color: var(--nz-text); display: flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* F88：主播条副行从单行文本改为「轮次进度 + 榜一签」结构（换 flex；隐藏平台文字省略语义由 chips 自带） */
.ubp-nz-asub { font-size: 10px; color: var(--nz-text3); margin-top: 1px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; overflow: hidden; }
.ubp-nz-mask { font-style: normal; font-size: 9px; padding: 0.5px 4px; border-radius: 4px; background: color-mix(in srgb, var(--nz-accent2) 18%, transparent); color: var(--nz-accent2); }
.ubp-nz-me { font-style: normal; font-size: 9.5px; color: var(--nz-accent); padding: 4px 0 0; }
.ubp-nz-lz { font-style: normal; font-size: 9px; padding: 0.5px 4px; border-radius: 4px; background: color-mix(in srgb, var(--nz-gold) 20%, transparent); color: var(--nz-gold); }
.ubp-nz-lock { display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; padding: 2px 6px; border-radius: 7px; border: 1px solid transparent; }
.ubp-nz-lock.gate { background: color-mix(in srgb, var(--nz-accent2) 14%, transparent); color: var(--nz-accent2); border-color: color-mix(in srgb, var(--nz-accent2) 36%, transparent); }
.ubp-nz-lock.solved { background: color-mix(in srgb, var(--nz-live) 12%, transparent); color: var(--nz-live); border-color: color-mix(in srgb, var(--nz-live) 32%, transparent); }
.ubp-nz-mini {
  border: 1px solid var(--nz-line); background: var(--nz-card); color: var(--nz-text2); border-radius: 8px;
  padding: 3px 9px; font-size: 10.5px; font-family: var(--ubp-font); cursor: pointer; white-space: nowrap;
}
.ubp-nz-mini.danger { color: var(--nz-spice3); border-color: color-mix(in srgb, var(--nz-spice3) 40%, transparent); }
.ubp-nz-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--nz-line);
  background: var(--nz-card2); color: var(--nz-text); border-radius: 10px; padding: 8px 12px; font-size: 12px;
  font-weight: 600; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-nz-btn.primary { background: linear-gradient(135deg, var(--nz-accent), var(--nz-accent2)); border-color: transparent; color: #fff; }
.ubp-nz-btn.ghost { background: transparent; color: var(--nz-text2); }
.ubp-nz-btn.danger { color: var(--nz-spice3); }
.ubp-nz-btn[disabled] { opacity: 0.5; cursor: default; }
.ubp-nz-btn svg { width: 15px; height: 15px; }
.ubp-nz-empty { font-size: 11.5px; color: var(--nz-text3); text-align: center; padding: 18px 12px; line-height: 1.7; }
.ubp-nz-empty.big { padding: 46px 20px; font-size: 12.5px; }
.ubp-nz-empty b { color: var(--nz-text2); font-size: 13px; }
.ubp-nz-tip { font-size: 10.5px; color: var(--nz-text3); line-height: 1.6; margin-top: 8px; }
.ubp-nz-error, .ubp-nz-loading {
  display: flex; align-items: center; gap: 8px; margin: 8px 12px 0; padding: 8px 10px; border-radius: 10px;
  font-size: 11px; line-height: 1.5; background: var(--nz-card2); color: var(--nz-text2); border: 1px solid var(--nz-line);
}
.ubp-nz-error { color: var(--nz-spice3); border-color: color-mix(in srgb, var(--nz-spice3) 30%, transparent); }
/* 生成中加载条 sticky 置顶：街区/直播间滚动中始终可见（对齐 .ubp-mo-loading 的同款修复） */
.ubp-nz-loading { position: sticky; top: 0; z-index: 3; box-shadow: 0 1px 0 var(--nz-line); }
.ubp-nz-loading .ubp-spinner { width: 12px; height: 12px; }

/* ── 分层揭开（N2）：轮廓 → 三区马赛克 → 全图 ── */
.ubp-nz-shot { position: relative; display: block; border-radius: 12px; overflow: hidden; background: var(--nz-card2); border: none; padding: 0; width: 100%; font-family: var(--ubp-font); color: inherit; text-align: left; }
.ubp-nz-shotimg { width: 100%; display: block; }
.ubp-nz-shot.l0 .ubp-nz-shotimg { filter: blur(22px) saturate(0.7) brightness(0.55); transform: scale(1.12); }
.ubp-nz-shot.l1 .ubp-nz-shotimg { filter: blur(1.5px); }
.ubp-nz-shot.l2 { cursor: pointer; }
.ubp-nz-shotbadge {
  position: absolute; right: 7px; bottom: 7px; font-size: 9.5px; padding: 2px 7px; border-radius: 7px;
  background: rgba(0, 0, 0, 0.5); color: #F0E4F6; backdrop-filter: blur(4px);
}
.ubp-nz-shotmore {
  position: absolute; right: 7px; top: 7px; width: 24px; height: 24px; border-radius: 8px; border: none;
  display: flex; align-items: center; justify-content: center; font-size: 13px; line-height: 1; padding: 0 0 4px;
  background: rgba(0, 0, 0, 0.5); color: #F0E4F6; backdrop-filter: blur(4px); cursor: pointer; font-family: var(--ubp-font);
}
.ubp-nz-shotmore:active { transform: scale(0.94); }
.ubp-nz-silhouette { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 42%, rgba(255, 46, 126, 0.16), transparent 62%), linear-gradient(180deg, rgba(11, 7, 16, 0.2), rgba(11, 7, 16, 0.55)); }
.ubp-nz-unveil {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column;
  align-items: center; gap: 5px; border: 1px solid rgba(255, 46, 126, 0.5); background: rgba(11, 7, 16, 0.6);
  color: #FFD3E6; border-radius: 14px; padding: 9px 14px; font-size: 10.5px; font-family: var(--ubp-font); cursor: pointer;
  backdrop-filter: blur(6px);
}
.ubp-nz-unveil b { font-size: 20px; line-height: 1; }
.ubp-nz-unveil span, .ubp-nz-shothint, .ubp-nz-shotbadge, .ubp-nz-spice { white-space: nowrap; }
.ubp-nz-unveil:active { transform: translate(-50%, -50%) scale(0.96); }
.ubp-nz-zmask { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 3px; padding: 3px; }
.ubp-nz-zn { position: relative; border: none; border-radius: 5px; background: #2A1738; overflow: hidden; cursor: pointer; padding: 0; }
.ubp-nz-zn::after {
  content: ""; position: absolute; inset: 0;
  background-image: linear-gradient(45deg, rgba(255, 255, 255, 0.09) 25%, transparent 25%, transparent 75%, rgba(255, 255, 255, 0.09) 75%),
                    linear-gradient(45deg, rgba(255, 255, 255, 0.09) 25%, transparent 25%, transparent 75%, rgba(255, 255, 255, 0.09) 75%);
  background-size: 11px 11px; background-position: 0 0, 5.5px 5.5px;
}
.ubp-nz-zn span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 10px; color: #E3C9F2; z-index: 2; font-family: var(--ubp-font); }
.ubp-nz-zn:first-child { grid-column: 1 / span 2; }
.ubp-nz-zn:nth-child(2) { grid-row: 2; grid-column: 1; }
.ubp-nz-zn:nth-child(3) { grid-row: 2; grid-column: 2; }
.ubp-nz-zn.done { background: transparent; }
.ubp-nz-zn.done::after { display: none; }
.ubp-nz-shot.none {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  min-height: 132px; padding: 14px 12px; border: 1px dashed var(--nz-line);
  background: linear-gradient(160deg, var(--nz-ph, var(--nz-card2)), var(--nz-card2) 78%);
}
.ubp-nz-shot.none .ubp-nz-shotph { color: var(--nz-text3); display: flex; }
.ubp-nz-shot.none svg { width: 22px; height: 22px; }
.ubp-nz-shotdesc { font-size: 10.5px; color: var(--nz-text2); text-align: center; line-height: 1.5; max-height: 44px; overflow: hidden; }
.ubp-nz-shothint { font-size: 9.5px; color: var(--nz-text3); }
.ubp-nz-shot.failed { border-color: color-mix(in srgb, var(--nz-spice3) 34%, transparent); }
.ubp-nz-shotnote { font-size: 10.5px; color: var(--nz-spice3); }
.ubp-nz-gallery { display: grid; gap: 4px; }
.ubp-nz-gallery.one { grid-template-columns: 1fr; }
.ubp-nz-gallery.two { grid-template-columns: 1fr 1fr; }
.ubp-nz-gallery.three { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.ubp-nz-gallery.three .ubp-nz-shot:first-child { grid-row: 1 / span 2; }
.ubp-nz-gallery .ubp-nz-shot.l0, .ubp-nz-gallery .ubp-nz-shot.l1, .ubp-nz-gallery .ubp-nz-shot.l2 { height: 100%; min-height: 0; }
.ubp-nz-gallery .ubp-nz-shotimg { height: 100%; object-fit: cover; }
.ubp-nz-gallery .ubp-nz-shot.none { min-height: 108px; height: 100%; }
.ubp-nz-shot.live .ubp-nz-shotimg, .ubp-nz-shot.viewer .ubp-nz-shotimg { min-height: 100%; object-fit: cover; }

/* ── 帖子卡 / 详情 ── */
.ubp-nz-feed { padding: 10px 12px 0; display: flex; flex-direction: column; gap: 10px; }
.ubp-nz-card { background: var(--nz-card); border: 1px solid var(--nz-line); border-radius: 15px; overflow: hidden; padding: 10px; }
/* 昼：白卡浮在冷灰纸面上 → 补一层极轻投影，不然整屏发平；夜：卡本身就是提亮面，不加投影 */
.ubp-nz-card, .ubp-nz-livecard, .ubp-nz-mecard { box-shadow: 0 1px 3px rgba(30, 24, 38, 0.055); }
.ubp-dark .ubp-nz-card, .ubp-dark .ubp-nz-livecard, .ubp-dark .ubp-nz-mecard { box-shadow: none; }
.ubp-nz-card.about { border-color: color-mix(in srgb, var(--nz-accent2) 30%, transparent); }
.ubp-nz-cardbody { display: block; width: 100%; border: none; background: none; padding: 0; text-align: left; font-family: var(--ubp-font); color: inherit; cursor: pointer; }
.ubp-nz-cardbody:active, .ubp-nz-livebody:active { opacity: 0.92; }
.ubp-nz-cardtop { display: flex; align-items: center; gap: 6px; margin: 8px 0 6px; }
.ubp-nz-cardtop:first-child { margin-top: 0; }
.ubp-nz-kind { font-style: normal; font-size: 9px; padding: 1.5px 6px; border-radius: 5px; }
.ubp-nz-kind.bounty { background: color-mix(in srgb, var(--nz-gold) 18%, transparent); color: var(--nz-gold); }
.ubp-nz-kind.live { background: color-mix(in srgb, var(--nz-live) 16%, transparent); color: var(--nz-live); }
.ubp-nz-title { font-size: 13.5px; font-weight: 700; color: var(--nz-text); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ubp-nz-text { font-size: 12px; color: var(--nz-text2); line-height: 1.62; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.ubp-nz-src { font-size: 10px; color: var(--nz-accent2); margin-top: 6px; padding-left: 8px; border-left: 2px solid color-mix(in srgb, var(--nz-accent2) 50%, transparent); line-height: 1.5; }
.ubp-nz-cardfoot { display: flex; align-items: center; gap: 7px; margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--nz-line); }
.ubp-nz-cardfoot .ubp-avatar { width: 20px; height: 20px; flex: none; }
.ubp-nz-cauthor { font-size: 11px; color: var(--nz-text2); display: flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42%; }
.ubp-nz-ctime { font-size: 10px; color: var(--nz-text3); flex: none; }
.ubp-nz-stats { display: flex; align-items: center; gap: 12px; margin-left: auto; font-size: 10.5px; color: var(--nz-text3); }
.ubp-nz-stats.acts { margin: 9px 0 0; padding-top: 9px; border-top: 1px solid var(--nz-line); }
.ubp-nz-stat { position: relative; display: inline-flex; align-items: center; gap: 4px; border: none; background: none; color: var(--nz-text3); font-size: 11px; font-family: var(--ubp-font); cursor: pointer; padding: 2px 0; }
.ubp-nz-stat svg { width: 14px; height: 14px; }
.ubp-nz-stat.on { color: var(--nz-accent); font-weight: 700; }
.ubp-nz-stat.lock { cursor: default; }
.ubp-nz-pv { font-style: normal; font-size: 8.5px; margin-left: 2px; padding: 0.5px 3px; border-radius: 3px; background: color-mix(in srgb, var(--nz-accent2) 20%, transparent); color: var(--nz-accent2); }
.ubp-nz-detail { padding: 12px 14px 4px; }
.ubp-nz-dtitle { font-size: 16px; font-weight: 800; line-height: 1.4; color: var(--nz-text); }
.ubp-nz-dtext { font-size: 13px; line-height: 1.75; color: var(--nz-text); margin-top: 8px; white-space: pre-wrap; }
.ubp-nz-livedoor { display: block; width: 100%; margin-top: 9px; border: 1px solid color-mix(in srgb, var(--nz-live) 40%, transparent); background: color-mix(in srgb, var(--nz-live) 10%, transparent); color: var(--nz-live); border-radius: 10px; padding: 8px; font-size: 11.5px; font-weight: 700; font-family: var(--ubp-font); cursor: pointer; }
.ubp-nz-detail .ubp-nz-gallery { margin-top: 10px; }
.ubp-nz-follow { flex: none; border: 1px solid color-mix(in srgb, var(--nz-accent) 45%, transparent); background: color-mix(in srgb, var(--nz-accent) 14%, transparent); color: var(--nz-accent); border-radius: 9px; padding: 4px 10px; font-size: 11px; font-family: var(--ubp-font); cursor: pointer; }
.ubp-nz-follow.ghost { border-color: var(--nz-line); background: transparent; color: var(--nz-text2); }
.ubp-nz-follow.hide { display: none; }

/* 委托 / 应征 */
.ubp-nz-commission { margin-top: 10px; border: 1px solid color-mix(in srgb, var(--nz-gold) 30%, transparent); background: color-mix(in srgb, var(--nz-gold) 8%, transparent); border-radius: 12px; padding: 10px; }
.ubp-nz-cmhd { font-size: 11px; font-weight: 700; color: var(--nz-text2); display: flex; align-items: center; gap: 8px; }
.ubp-nz-cmtext { font-size: 12px; color: var(--nz-text); line-height: 1.65; margin-top: 6px; }
.ubp-nz-cmmeta { font-size: 10px; color: var(--nz-text3); margin-top: 6px; }
.ubp-nz-entries { margin-top: 12px; }
.ubp-nz-entry { display: flex; gap: 9px; padding: 10px 0; border-top: 1px solid var(--nz-line); }
.ubp-nz-entry.adopted { background: color-mix(in srgb, var(--nz-live) 7%, transparent); border-radius: 10px; padding: 10px 8px; }
.ubp-nz-emain { flex: 1; min-width: 0; }
.ubp-nz-ename { font-size: 12px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.ubp-nz-adopt { font-style: normal; font-size: 9px; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--nz-live) 18%, transparent); color: var(--nz-live); }
.ubp-nz-etext { font-size: 12px; color: var(--nz-text2); line-height: 1.6; margin-top: 3px; }
.ubp-nz-eimg { margin-top: 7px; }
.ubp-nz-emeta { display: flex; align-items: center; gap: 9px; margin-top: 6px; font-size: 10px; color: var(--nz-text3); }

/* 评论区（含楼中楼） */
.ubp-nz-cmts { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--nz-line); }
.ubp-nz-cmt { display: flex; gap: 9px; padding: 9px 0; }
.ubp-nz-cmt .ubp-avatar { width: 28px; height: 28px; flex: none; }
.ubp-nz-cmain { flex: 1; min-width: 0; }
.ubp-nz-cname { font-size: 11.5px; color: var(--nz-text2); display: flex; align-items: center; gap: 5px; }
.ubp-nz-ctext { font-size: 12.5px; color: var(--nz-text); line-height: 1.6; margin-top: 3px; }
.ubp-nz-ctext b { color: var(--nz-accent); font-weight: 600; }
.ubp-nz-cmeta { display: flex; align-items: center; gap: 12px; margin-top: 4px; font-size: 10px; color: var(--nz-text3); }
.ubp-nz-creply { border: none; background: none; color: var(--nz-text3); font-size: 10px; font-family: var(--ubp-font); cursor: pointer; padding: 0; }
.ubp-nz-subs { margin-top: 7px; padding: 7px 9px; border-radius: 9px; background: var(--nz-glass); }
.ubp-nz-subrow { font-size: 11.5px; line-height: 1.6; color: var(--nz-text2); padding: 2px 0; }
.ubp-nz-subrow b { color: var(--nz-accent); font-weight: 600; }
.ubp-nz-subname { color: var(--nz-text2); font-weight: 600; }
.ubp-nz-subtime { font-size: 9.5px; color: var(--nz-text3); margin-left: 5px; }
.ubp-nz-subfold { border: none; background: none; color: var(--nz-accent2); font-size: 10px; font-family: var(--ubp-font); cursor: pointer; padding: 3px 0 0; }

/* 弹幕 / 打赏榜行（帖子详情里不用，直播间用） */
.ubp-nz-bar { display: flex; gap: 6px; font-size: 11.5px; line-height: 1.5; align-items: baseline; }
/* 弹幕昵称色：源头是给暗底调的一批淡霓虹，白卡上直接读不出 → 昼向墨色压深，夜原样用 */
.ubp-nz-barname { font-weight: 700; flex: none; color: color-mix(in srgb, var(--nz-bar-tint, var(--nz-accent)) 58%, var(--nz-text)); }
.ubp-dark .ubp-nz-barname { color: var(--nz-bar-tint, var(--nz-accent)); }
.ubp-nz-bartext { color: var(--nz-text2); }
.ubp-nz-bar.spot { background: color-mix(in srgb, var(--nz-accent) 10%, transparent); border-radius: 8px; padding: 3px 7px; }
.ubp-nz-bar.me .ubp-nz-bartext { color: var(--nz-text); }
.ubp-nz-spot { font-style: normal; font-size: 9px; color: var(--nz-accent); margin-left: auto; }

/* ── 舞台列表 ── */
.ubp-nz-mylive { display: flex; align-items: center; gap: 10px; padding: 10px 12px 0; }
.ubp-nz-mylivemeta { font-size: 10.5px; color: var(--nz-text3); }
.ubp-nz-lives { padding: 10px 12px 0; display: flex; flex-direction: column; gap: 10px; }
.ubp-nz-livecard { background: var(--nz-card); border: 1px solid var(--nz-line); border-radius: 15px; overflow: hidden; padding: 10px; }
.ubp-nz-livecover { position: relative; display: block; width: 100%; border: none; background: none; padding: 0; cursor: pointer; }
.ubp-nz-livecover .ubp-nz-shot { border-radius: 12px; }
/* LIVE/热度这类角标压在封面图上：昼用实心片（淡青字压在浅封面上读不出），夜保留毛玻璃霓虹 */
.ubp-nz-live {
  position: absolute; left: 8px; top: 8px; display: inline-flex; align-items: center; gap: 4px; font-style: normal;
  font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 7px; background: var(--nz-live); color: #fff;
  border: 1px solid transparent; box-shadow: 0 1px 6px rgba(11, 7, 16, 0.3);
}
.ubp-nz-live span { width: 6px; height: 6px; border-radius: 50%; background: #fff; animation: ubp-nz-pulse 1.5s ease-in-out infinite; }
.ubp-dark .ubp-nz-live {
  background: rgba(34, 211, 238, 0.16); color: #7FE6F7; border-color: rgba(34, 211, 238, 0.4);
  box-shadow: none; backdrop-filter: blur(4px);
}
.ubp-dark .ubp-nz-live span { background: #22D3EE; }
.ubp-nz-live.ended { background: rgba(11, 7, 16, 0.62); color: #F0E4F6; border-color: transparent; box-shadow: none; backdrop-filter: blur(4px); }
.ubp-nz-live.idle { background: rgba(11, 7, 16, 0.62); color: #F0E4F6; border-color: transparent; box-shadow: none; backdrop-filter: blur(4px); }
.ubp-nz-live.ended span, .ubp-nz-live.idle span { display: none; }
.ubp-nz-heat { position: absolute; right: 8px; top: 8px; font-size: 9.5px; color: #FFD9A8; background: rgba(0, 0, 0, 0.42); padding: 2px 7px; border-radius: 7px; backdrop-filter: blur(4px); }
.ubp-nz-livecover .ubp-nz-spice { position: absolute; right: 8px; top: 30px; }
.ubp-nz-livebody { display: block; width: 100%; border: none; background: none; padding: 0; text-align: left; font-family: var(--ubp-font); color: inherit; cursor: pointer; }
.ubp-nz-livebody .ubp-nz-title { margin-top: 8px; }
.ubp-nz-liverow { display: flex; align-items: center; gap: 7px; margin-top: 7px; }
.ubp-nz-liverow .ubp-avatar { width: 20px; height: 20px; flex: none; }
.ubp-nz-liverow .ubp-nz-ctime { margin-left: auto; }
.ubp-nz-livemeta { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 10px; color: var(--nz-text3); }

/* ── 直播间 ── */
.ubp-nz-room { padding-bottom: 12px; }
.ubp-nz-stage { position: relative; }
.ubp-nz-stage .ubp-nz-shot { border-radius: 0; min-height: 168px; }
.ubp-nz-stageov { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 10px 12px; pointer-events: none; }
.ubp-nz-stagetop { display: flex; align-items: center; gap: 7px; }
.ubp-nz-stagetop .ubp-nz-live, .ubp-nz-stagetop .ubp-nz-spice { position: static; pointer-events: auto; }
/* 台面底部读数常压在一张图上：自带下缘暗角，图像深浅都不用为对比度担心 */
.ubp-nz-stagebot {
  display: flex; align-items: center; gap: 8px; font-size: 10px; color: #EADCF3;
  margin: 0 -12px -10px; padding: 14px 12px 10px; border-radius: 0 0 12px 12px;
  background: linear-gradient(180deg, transparent, rgba(11, 7, 16, 0.6));
}
.ubp-nz-heatbar { flex: 1; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, 0.18); overflow: hidden; }
.ubp-nz-heatbar i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--nz-accent), var(--nz-accent2)); }
.ubp-nz-hotnum, .ubp-nz-viewers { white-space: nowrap; }
.ubp-nz-anchor { display: flex; align-items: center; gap: 9px; padding: 10px 12px 0; }
.ubp-nz-speech { margin: 10px 12px 0; border-radius: 12px; background: var(--nz-glass); border: 1px solid var(--nz-line); padding: 10px; }
.ubp-nz-speech.empty { font-size: 11.5px; color: var(--nz-text3); }
.ubp-nz-line { font-size: 12.5px; line-height: 1.7; color: var(--nz-text); }
.ubp-nz-line + .ubp-nz-line { margin-top: 5px; }
.ubp-nz-speechmeta { font-size: 9.5px; color: var(--nz-text3); margin-top: 6px; }
.ubp-nz-event { font-size: 10px; color: var(--nz-live); margin-bottom: 6px; }
.ubp-nz-event.rej { color: var(--nz-spice3); }
.ubp-nz-pushrow { display: flex; align-items: center; gap: 8px; padding: 10px 12px 0; }
.ubp-nz-orderbox { display: flex; align-items: center; gap: 7px; margin: 9px 12px 0; }
.ubp-nz-orderbox.private { border-radius: 12px; border: 1px solid color-mix(in srgb, var(--nz-accent2) 40%, transparent); background: color-mix(in srgb, var(--nz-accent2) 8%, transparent); padding: 6px; }
.ubp-nz-orderinput {
  flex: 1; min-width: 0; height: 34px; border-radius: 10px; background: var(--nz-card2); border: 1px solid var(--nz-line);
  padding: 0 11px; font-size: 11.5px; font-family: var(--ubp-font); color: var(--nz-text);
}
.ubp-nz-orderinput::placeholder { color: var(--nz-text3); }
.ubp-nz-ordersend {
  flex: none; height: 34px; border: none; border-radius: 10px; padding: 0 14px; font-size: 11.5px; font-weight: 700;
  font-family: var(--ubp-font); color: #fff; background: linear-gradient(135deg, var(--nz-accent), var(--nz-accent2)); cursor: pointer;
}
.ubp-nz-ordersend[disabled] { opacity: 0.5; }
.ubp-nz-boost {
  display: flex; align-items: center; gap: 8px; margin: 8px 12px 0; border-radius: 10px; padding: 7px 10px; font-size: 10.5px;
  background: color-mix(in srgb, var(--nz-gold) 9%, transparent); border: 1px solid color-mix(in srgb, var(--nz-gold) 26%, transparent);
  color: var(--nz-gold);
}
.ubp-nz-bsteps { display: flex; gap: 4px; margin-left: auto; }
.ubp-nz-bsteps i { width: 20px; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--nz-gold) 30%, transparent); }
.ubp-nz-bsteps i.on { background: var(--nz-gold); box-shadow: 0 0 8px color-mix(in srgb, var(--nz-gold) 60%, transparent); }
/* 榜一徽标（原类名 ubp-nz-top 与街区顶栏容器同名，规则互相污染 → 改名隔离） */
.ubp-nz-rankfirst { font-style: normal; font-size: 9.5px; padding: 1px 6px; border-radius: 5px; background: color-mix(in srgb, var(--nz-gold) 16%, transparent); color: var(--nz-gold); }
.ubp-nz-orders { margin: 8px 12px 0; display: flex; flex-direction: column; gap: 5px; }
.ubp-nz-orderline { font-size: 10.5px; line-height: 1.55; color: var(--nz-text2); }
.ubp-nz-orderline.rej { color: var(--nz-spice3); }
.ubp-nz-owho { font-weight: 700; color: var(--nz-text); }
.ubp-nz-tier { font-style: normal; font-size: 9px; margin-left: 5px; padding: 0.5px 4px; border-radius: 4px; background: color-mix(in srgb, var(--nz-accent) 16%, transparent); color: var(--nz-accent); }
.ubp-nz-ostate { color: var(--nz-text3); margin-left: 6px; }
.ubp-nz-barrage { display: flex; flex-direction: column; gap: 6px; margin: 10px 12px 0; max-height: 168px; overflow-y: auto; }
.ubp-nz-barinput { display: flex; align-items: center; gap: 7px; margin: 8px 12px 0; }
.ubp-nz-rank { margin: 10px 12px 0; border-radius: 12px; background: var(--nz-card); border: 1px solid var(--nz-line); padding: 8px 10px; }
.ubp-nz-rankhd { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; color: var(--nz-text2); }
.ubp-nz-rankrow { display: flex; align-items: center; gap: 7px; font-size: 11px; margin-top: 5px; color: var(--nz-text2); }
.ubp-nz-rankrow.me { color: var(--nz-accent); }
.ubp-nz-rankno { font-family: Consolas, monospace; color: var(--nz-gold); font-weight: 700; width: 14px; }
.ubp-nz-rankname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-nz-rankamt { color: var(--nz-gold); }
.ubp-nz-gifts { display: flex; gap: 8px; overflow-x: auto; padding: 9px 12px; margin-top: 10px; border-top: 1px solid var(--nz-line); background: var(--nz-card2); scrollbar-width: none; }
.ubp-nz-gifts::-webkit-scrollbar { display: none; }
.ubp-nz-gift {
  flex: none; display: flex; flex-direction: column; align-items: center; gap: 2px; border: 1px solid var(--nz-line);
  background: var(--nz-card); border-radius: 10px; padding: 6px 9px; font-family: var(--ubp-font); cursor: pointer;
}
.ubp-nz-gift b { font-size: 16px; line-height: 1; }
.ubp-nz-gift span { font-size: 9px; color: var(--nz-text3); }
/* F88：礼物价格角标（价格原在 title 里，触屏看不到；数字 = NIGHT_GIFTS.coins 既有数据） */
.ubp-nz-gift .nz-cost { display: inline-flex; align-items: center; justify-content: center; margin-left: 4px; padding: 0 4px; border-radius: 4px; font-style: normal; font-size: 9px; font-weight: 700; background: rgba(247, 174, 67, 0.18); color: #F7AE43; font-variant-numeric: tabular-nums; }
/* F88：主播条轮次进度 + 榜一签 + 热度/观众数字加重（轮次进度/榜一签选择器随内容结构升级） */
.ubp-nz-asub .nz-round { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
.ubp-nz-asub .nz-round b { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.ubp-nz-asub .nz-round-bar { display: inline-block; width: 42px; height: 3px; border-radius: 2px; background: rgba(247, 174, 67, 0.25); overflow: hidden; }
.ubp-nz-asub .nz-round-bar i { display: block; height: 100%; background: #F7AE43; }
.ubp-nz-asub .nz-top { display: inline-block; padding: 0 7px; border-radius: 99px; font-size: 10px; border: 1px solid rgba(247, 174, 67, 0.55); color: #F7AE43; }
.ubp-nz-hotnum b, .ubp-nz-viewers b, .ubp-nz-heat b { font-variant-numeric: tabular-nums; }
.ubp-nz-ops { display: flex; align-items: center; gap: 8px; padding: 10px 12px 0; }

/* ── 搭话（私信 / 约会 / 档案卡 / 查看器） ── */
.ubp-nz-dms { padding: 6px 0 0; }
.ubp-nz-dmrow { display: flex; align-items: center; gap: 10px; width: 100%; border: none; background: none; padding: 11px 14px; text-align: left; font-family: var(--ubp-font); color: inherit; cursor: pointer; border-bottom: 1px solid var(--nz-line); }
.ubp-nz-dmrow.unread { background: color-mix(in srgb, var(--nz-accent) 6%, transparent); }
.ubp-nz-dmmain { flex: 1; min-width: 0; }
.ubp-nz-dmname { font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.ubp-nz-on { width: 6px; height: 6px; border-radius: 50%; background: #34C77B; }
.ubp-nz-srcchip { font-style: normal; font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--nz-glass); color: var(--nz-text3); font-weight: 400; }
.ubp-nz-dmtext { font-size: 11.5px; color: var(--nz-text3); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-nz-dmside { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: none; }
.ubp-nz-dmdot { font-style: normal; min-width: 16px; height: 16px; border-radius: 8px; background: var(--nz-accent); color: #fff; font-size: 9.5px; line-height: 16px; text-align: center; padding: 0 4px; }
.ubp-nz-dmroom { display: flex; flex-direction: column; min-height: 100%; }
.ubp-nz-bubbles { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 12px 12px 4px; }
.ubp-nz-bubrow { display: flex; align-items: flex-end; gap: 7px; }
.ubp-nz-bubrow.me { flex-direction: row-reverse; }
.ubp-nz-bubrow .ubp-avatar { width: 26px; height: 26px; flex: none; }
.ubp-nz-bub { max-width: 74%; border-radius: 13px; padding: 8px 11px; background: var(--nz-card2); border: 1px solid var(--nz-line); }
.ubp-nz-bub.me { background: color-mix(in srgb, var(--nz-accent) 22%, var(--nz-card2)); border-color: color-mix(in srgb, var(--nz-accent) 30%, transparent); }
.ubp-nz-bubtext { font-size: 12.5px; line-height: 1.6; color: var(--nz-text); white-space: pre-wrap; }
.ubp-nz-bubimg { width: 190px; max-width: 100%; }
.ubp-nz-bubimg + .ubp-nz-bubtext { margin-top: 6px; }
/* 私聊 typing 气泡（微信口径：对方头像 + 三点；终止钮并入同一行） */
.ubp-nz-typing { display: flex; align-items: center; gap: 9px; }
.ubp-nz-typing .ubp-typing-dots { padding: 0; background: transparent; }
.ubp-nz-typing .ubp-typing-dots i { background: var(--nz-text3); }
.ubp-nz-typingabort { border: none; background: transparent; color: var(--nz-spice3); font-size: 11px; font-family: var(--ubp-font); cursor: pointer; padding: 0; }
.ubp-nz-bubtime { font-size: 9px; color: var(--nz-text3); align-self: flex-end; }
.ubp-nz-cardmsg { display: flex; align-items: center; gap: 9px; }
.ubp-nz-cardmsg b { font-size: 20px; }
.ubp-nz-cardtitle { font-size: 12px; font-weight: 700; }
.ubp-nz-cardsub { font-size: 10px; color: var(--nz-text3); margin-top: 1px; }
.ubp-nz-datemsg { font-size: 12px; }
.ubp-nz-datemsg b { display: block; font-size: 11px; color: var(--nz-accent); margin-bottom: 4px; }
/* 私信底栏（输入行 + 操作行）整体贴底：滚动体仍是 .ubp-appbody，靠 sticky 常驻（对齐 .ubp-replybar）。
   底色必须用不透明的 --nz-bg（--nz-card 在暗色主题是半透明，滚过的消息会透出来）。 */
.ubp-nz-dmfoot { position: sticky; bottom: 0; z-index: 2; margin-top: 8px; padding-bottom: 10px; background: var(--nz-bg); border-top: 1px solid var(--nz-line); }
.ubp-nz-dmbar { display: flex; align-items: center; gap: 7px; padding: 8px 12px 0; }
.ubp-nz-dmimg { flex: none; width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--nz-line); background: var(--nz-card2); color: var(--nz-text2); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-nz-dmimg svg { width: 17px; height: 17px; }
.ubp-nz-dmops { display: flex; align-items: center; gap: 7px; padding: 9px 12px 0; flex-wrap: wrap; }
.ubp-nz-date { padding: 12px 14px 0; }
.ubp-nz-datehd { display: flex; align-items: center; gap: 10px; }
.ubp-nz-dstatus { font-style: normal; font-size: 10px; padding: 2px 8px; border-radius: 7px; background: color-mix(in srgb, var(--nz-accent) 14%, transparent); color: var(--nz-accent); }
.ubp-nz-dstep { height: 4px; border-radius: 2px; background: var(--nz-card3); margin-top: 11px; overflow: hidden; }
.ubp-nz-dstep i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--nz-accent), var(--nz-accent2)); }
.ubp-nz-dstepmeta { font-size: 10.5px; color: var(--nz-text3); margin-top: 5px; }
.ubp-nz-dtls { margin-top: 6px; }
.ubp-nz-dtlnode { display: flex; gap: 10px; padding: 11px 0; border-bottom: 1px solid var(--nz-line); }
.ubp-nz-dtlnode:last-child { border-bottom: none; }
.ubp-nz-dtldot { width: 9px; height: 9px; border-radius: 50%; background: var(--nz-card3); border: 2px solid var(--nz-line); flex: none; margin-top: 5px; }
.ubp-nz-dtlnode.on .ubp-nz-dtldot { border-color: var(--nz-accent); background: var(--nz-accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--nz-accent) 18%, transparent); }
.ubp-nz-dtlnb { flex: 1; min-width: 0; }
.ubp-nz-dtlnt { font-size: 10.5px; color: var(--nz-text3); }
.ubp-nz-dtlnc { font-size: 12.5px; line-height: 1.68; color: var(--nz-text); margin-top: 3px; }
.ubp-nz-dtllines { margin-top: 6px; font-size: 12px; line-height: 1.62; color: var(--nz-text2); }
.ubp-nz-dtlchoice { display: flex; gap: 6px; margin-top: 7px; }
.ubp-nz-dtlchoice span { font-size: 10.5px; padding: 2px 8px; border-radius: 7px; background: var(--nz-glass); color: var(--nz-text3); }
.ubp-nz-dtlchoice span.on { background: color-mix(in srgb, var(--nz-accent) 18%, transparent); color: var(--nz-accent); font-weight: 700; }
.ubp-nz-choosetip { margin-top: 10px; font-size: 11px; color: var(--nz-gold); }
.ubp-nz-choices { display: flex; gap: 8px; margin-top: 8px; }
.ubp-nz-choice { flex: 1; border: 1px solid color-mix(in srgb, var(--nz-accent) 40%, transparent); background: color-mix(in srgb, var(--nz-accent) 10%, transparent); color: var(--nz-text); border-radius: 11px; padding: 10px; font-size: 12px; font-family: var(--ubp-font); cursor: pointer; }
.ubp-nz-dateops { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.ubp-nz-datetip { font-size: 10.5px; color: var(--nz-text3); line-height: 1.6; margin-top: 9px; }
.ubp-nz-persona { padding: 12px 14px 0; }
.ubp-nz-phd { display: flex; align-items: center; gap: 11px; margin-top: 10px; }
.ubp-nz-phmain { flex: 1; min-width: 0; }
/* 角色名行：名字 + 关注开关（未关注=品牌色实心 / 已关注=描边静默，复用 .ubp-nz-follow 两态） */
.ubp-nz-pname { display: flex; align-items: center; gap: 8px; }
.ubp-nz-pn { min-width: 0; font-size: 16px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-nz-psig { font-size: 11px; color: var(--nz-text3); margin-top: 2px; }
.ubp-nz-ptags { display: flex; align-items: center; gap: 7px; margin-top: 6px; }
.ubp-nz-paccept { font-size: 10.5px; color: var(--nz-gold); }
/* 身材资料：整行「标签 + 值」——三围那种长串（B80（A杯）-W56-H83,(胸部小巧,臀部挺翘)）
   塞进 1/3 宽的小卡片会折成五行很难看；固定窄标签列 + 值自适应换行（底纹与 .ubp-nz-pblock 同一套）。 */
.ubp-nz-pbody { margin-top: 12px; border-radius: 11px; background: var(--nz-glass); border: 1px solid var(--nz-line); padding: 3px 11px; }
.ubp-nz-pb { display: flex; align-items: baseline; gap: 10px; padding: 7px 0; }
.ubp-nz-pb + .ubp-nz-pb { border-top: 1px solid var(--nz-line); }
.ubp-nz-pb span { flex: none; min-width: 30px; font-size: 10.5px; color: var(--nz-text3); }
.ubp-nz-pb b { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 800; line-height: 1.6; overflow-wrap: anywhere; }
.ubp-nz-pgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.ubp-nz-pblock { border-radius: 11px; padding: 9px 10px; background: var(--nz-glass); border: 1px solid var(--nz-line); }
.ubp-nz-pblock.limit { border-color: color-mix(in srgb, var(--nz-spice3) 30%, transparent); }
.ubp-nz-pbh { font-size: 10.5px; color: var(--nz-text3); font-weight: 700; }
.ubp-nz-pbt { font-size: 11.5px; line-height: 1.7; margin-top: 5px; display: flex; flex-wrap: wrap; gap: 4px; }
.ubp-nz-plk, .ubp-nz-plm { font-size: 10.5px; padding: 1.5px 7px; border-radius: 6px; background: var(--nz-card); }
.ubp-nz-plk { color: var(--nz-live); }
.ubp-nz-plm { color: var(--nz-spice3); }
.ubp-nz-pstats { display: flex; gap: 16px; margin-top: 11px; font-size: 11px; color: var(--nz-text3); }
.ubp-nz-pstats b { color: var(--nz-text); font-size: 13px; margin-right: 3px; }
.ubp-nz-pops { display: flex; gap: 8px; margin-top: 12px; }
/* 约会入口（原私信对话页操作行的「约 TA 出来」收进档案卡底部；有进行中的约时入口留在对话页） */
.ubp-nz-pdate { margin-top: 8px; }
.ubp-nz-pdate .ubp-nz-btn { width: 100%; }
.ubp-nz-viewerwrap { position: absolute; inset: 0; z-index: 25; }
.ubp-nz-viewer { position: absolute; inset: 0; background: #05030A; display: flex; flex-direction: column; }
.ubp-nz-vh { flex: none; display: flex; align-items: center; gap: 9px; padding: 9px 14px; font-size: 12px; color: #D9C9E4; }
.ubp-nz-vh .ubp-iconbtn { color: #D9C9E4; }
.ubp-nz-vhsub { font-size: 10px; color: #8C7A99; }
.ubp-nz-vstage { flex: 1; min-height: 0; position: relative; margin: 0 14px; border-radius: 14px; overflow: hidden; display: flex; }
.ubp-nz-vstage .ubp-nz-shot { height: 100%; border-radius: 14px; }
.ubp-nz-vstage .ubp-nz-shotimg { height: 100%; object-fit: contain; background: #05030A; }
.ubp-nz-vdesc { flex: none; font-size: 11px; color: #B9A6C6; line-height: 1.6; padding: 11px 14px 0; max-height: 54px; overflow: hidden; }
.ubp-nz-vthumb { flex: none; display: flex; gap: 7px; padding: 11px 14px 0; }
.ubp-nz-vthumbcell { flex: none; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.05); color: #B9A6C6; border-radius: 9px; padding: 5px 9px; font-size: 10px; font-family: var(--ubp-font); cursor: pointer; }
.ubp-nz-vthumbcell.on { border-color: #FF2E7E; color: #FFD3E6; }
.ubp-nz-vops { flex: none; display: flex; gap: 8px; padding: 10px 14px 14px; flex-wrap: wrap; }
.ubp-nz-vops .ubp-nz-btn { background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.14); color: #E7DAF0; }

/* ── 我的 / 消息 / 专题页 ── */
.ubp-nz .ubp-bigava { width: 54px; height: 54px; font-size: 20px; flex: none; }
.ubp-nz-phd .ubp-avatar, .ubp-nz-mehead .ubp-avatar { flex: none; }
.ubp-nz-mehead { display: flex; align-items: center; gap: 11px; padding: 12px 14px; }
.ubp-nz-memain { flex: 1; min-width: 0; }
.ubp-nz-mename { font-size: 16px; font-weight: 800; display: flex; align-items: center; gap: 6px; }
.ubp-nz-mesub { font-size: 11px; color: var(--nz-text3); margin-top: 3px; display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
/* F88：我的页副标题结构化（等级号牌 / 币量数字加重 / 未读描边签） */
.ubp-nz-mesub .nz-lv { display: inline-flex; align-items: baseline; padding: 0 6px; border-radius: 5px; font-size: 10px; font-weight: 700; background: rgba(247, 174, 67, 0.16); color: #F7AE43; }
.ubp-nz-mesub .nz-coin b, .ubp-nz-mesub .nz-lv b { font-variant-numeric: tabular-nums; }
.ubp-nz-mesub .nz-coin b { font-size: 13px; }
.ubp-nz-mesub .nz-unread { display: inline-block; padding: 0 6px; border-radius: 99px; font-size: 10px; font-weight: 600; color: #FF8F8F; border: 1px solid rgba(255, 143, 143, 0.4); font-variant-numeric: tabular-nums; }
.ubp-nz-mestats { display: flex; gap: 8px; padding: 0 14px; }
.ubp-nz-mestat { flex: 1; border: 1px solid var(--nz-line); background: var(--nz-card); border-radius: 11px; padding: 9px 6px; font-family: var(--ubp-font); cursor: pointer; }
.ubp-nz-mestat.on { border-color: var(--nz-accent); }
.ubp-nz-mestat b { display: block; font-size: 15px; font-weight: 800; color: var(--nz-text); }
.ubp-nz-mestat b i { font-style: normal; font-size: 10px; color: var(--nz-accent2); margin-left: 3px; }
.ubp-nz-mestat span { font-size: 10px; color: var(--nz-text3); }
.ubp-nz-mecard { margin: 12px 14px 0; border-radius: 13px; background: var(--nz-card); border: 1px solid var(--nz-line); padding: 11px; }
.ubp-nz-merow { display: flex; align-items: center; gap: 10px; margin-top: 9px; font-size: 11.5px; color: var(--nz-text2); line-height: 1.6; }
.ubp-nz-merow .ubp-nz-mini { margin-left: auto; }
.ubp-nz-switch { flex: none; width: 40px; height: 22px; border-radius: 11px; border: none; background: var(--nz-card3); position: relative; cursor: pointer; margin-left: auto; }
.ubp-nz-switch i { position: absolute; left: 2px; top: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left 0.16s; }
.ubp-nz-switch.on { background: linear-gradient(135deg, var(--nz-accent), var(--nz-accent2)); }
.ubp-nz-switch.on i { left: 20px; }
.ubp-nz-daterow { display: flex; align-items: center; gap: 9px; width: 100%; border: none; background: none; padding: 9px 0; text-align: left; font-family: var(--ubp-font); color: inherit; cursor: pointer; border-bottom: 1px solid var(--nz-line); }
.ubp-nz-daterow:last-child { border-bottom: none; }
.ubp-nz-go { color: var(--nz-text3); flex: none; }
.ubp-nz-rej { font-size: 11px; color: var(--nz-text2); line-height: 1.6; padding: 5px 0; }
.ubp-nz-rej b { color: var(--nz-spice3); }
.ubp-nz-standing { margin: 14px; font-size: 10.5px; color: var(--nz-text3); line-height: 1.7; text-align: center; padding: 10px; border-radius: 11px; background: var(--nz-glass); border: 1px dashed var(--nz-line); }
.ubp-nz-favsec { padding: 10px 0 0; }
.ubp-nz-favsec .ubp-nz-cmhd { padding: 0 14px; }
.ubp-nz-favlock { display: block; margin: 10px 14px; width: calc(100% - 28px); border: 1px dashed color-mix(in srgb, var(--nz-accent2) 46%, transparent); background: color-mix(in srgb, var(--nz-accent2) 9%, transparent); color: var(--nz-accent2); border-radius: 12px; padding: 14px; font-size: 12px; font-family: var(--ubp-font); cursor: pointer; }
.ubp-nz-follows { padding: 8px 0 0; }
.ubp-nz-followrow { display: flex; align-items: center; gap: 9px; padding: 10px 14px; border-bottom: 1px solid var(--nz-line); }
.ubp-nz-followrow .ubp-nz-mini { margin-left: 4px; }
.ubp-nz-msgs { padding: 6px 0 0; }
.ubp-nz-msghead { display: flex; align-items: center; gap: 9px; padding: 8px 14px 10px; font-size: 11px; color: var(--nz-text3); }
.ubp-nz-msghead .ubp-nz-mini { margin-left: auto; }
.ubp-nz-msgrow { display: flex; align-items: flex-start; gap: 10px; width: 100%; border: none; background: none; padding: 11px 14px; text-align: left; font-family: var(--ubp-font); color: inherit; cursor: pointer; border-bottom: 1px solid var(--nz-line); }
.ubp-nz-msgrow.unread { background: color-mix(in srgb, var(--nz-accent) 6%, transparent); }
.ubp-nz-msgicon { flex: none; font-size: 15px; width: 22px; text-align: center; }
.ubp-nz-ntype { font-style: normal; font-size: 9.5px; color: var(--nz-text3); font-weight: 400; }
.ubp-nz-msgtext { font-size: 11.5px; color: var(--nz-text2); line-height: 1.55; margin-top: 3px; }
.ubp-nz-abouthero { padding: 14px; border-bottom: 1px solid var(--nz-line); }
.ubp-nz-abouthd { font-size: 17px; font-weight: 800; background: linear-gradient(90deg, var(--nz-accent), var(--nz-accent2)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.ubp-nz-aboutsub { font-size: 11.5px; color: var(--nz-text2); line-height: 1.65; margin-top: 6px; }
.ubp-nz-aboutmeta { font-size: 10px; color: var(--nz-text3); margin-top: 6px; }

/* ── 发布面板 ── */
.ubp-nz-compose { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.ubp-nz-cpbody { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 0; }
.ubp-nz-cpsec { margin-bottom: 14px; }
.ubp-nz-cphd { font-size: 11px; font-weight: 700; color: var(--nz-text2); margin-bottom: 8px; }
.ubp-nz-cphint { font-size: 10px; color: var(--nz-text3); line-height: 1.6; margin-top: 6px; }
.ubp-nz-chips { display: flex; gap: 7px; flex-wrap: wrap; }
.ubp-nz-chip { border: 1px solid var(--nz-line); background: var(--nz-card); color: var(--nz-text2); border-radius: 10px; padding: 6px 12px; font-size: 11.5px; font-family: var(--ubp-font); cursor: pointer; }
.ubp-nz-chip.on { border-color: var(--nz-accent); background: color-mix(in srgb, var(--nz-accent) 14%, transparent); color: var(--nz-accent); font-weight: 700; }
.ubp-nz-chip.spice.s1.on { border-color: var(--nz-spice1); color: var(--nz-spice1); background: color-mix(in srgb, var(--nz-spice1) 14%, transparent); }
.ubp-nz-chip.spice.s3.on { border-color: var(--nz-spice3); color: var(--nz-spice3); background: color-mix(in srgb, var(--nz-spice3) 14%, transparent); }
.ubp-nz-cptitle, .ubp-nz-cptext {
  display: block; width: 100%; border: none; outline: none; background: var(--nz-card); color: var(--nz-text);
  border-radius: 11px; padding: 10px 12px; font-size: 13px; font-family: var(--ubp-font); border: 1px solid var(--nz-line); margin-bottom: 10px;
}
.ubp-nz-cptitle.small, .ubp-nz-cptext.small { font-size: 12px; }
.ubp-nz-cptext { resize: vertical; line-height: 1.7; }
.ubp-nz-cptext.small { resize: none; }
.ubp-nz-cpimg { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; flex-wrap: wrap; }
.ubp-nz-cpcover { flex: none; width: 84px; height: 84px; border-radius: 11px; border: 1px dashed var(--nz-line); background: var(--nz-card); color: var(--nz-text3); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; font-size: 10px; font-family: var(--ubp-font); cursor: pointer; overflow: hidden; }
.ubp-nz-cpcover img { width: 100%; height: 100%; object-fit: cover; }
.ubp-nz-cpcover svg { width: 18px; height: 18px; }
.ubp-nz-cpimg .ubp-nz-cptext { flex: 1; min-width: 140px; margin-bottom: 0; }
.ubp-nz-tagpick { display: flex; flex-wrap: wrap; gap: 5px; }
.ubp-nz-cpbar { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--nz-line); background: var(--nz-card2); }
.ubp-nz-cpbar .ubp-nz-cphint { margin: 0; flex: 1; min-width: 0; }
.ubp-nz-cpsend { flex: none; border: none; border-radius: 11px; padding: 9px 20px; font-size: 13px; font-weight: 700; font-family: var(--ubp-font); color: #fff; background: linear-gradient(135deg, var(--nz-accent), var(--nz-accent2)); cursor: pointer; }
.ubp-nz-sheet .ubp-sheet { background: var(--nz-card2); }
.ubp-nz-sheet .ubp-sheet-title { color: var(--nz-text); }
.ubp-nz-sheet .ubp-sheet-body { color: var(--nz-text3); }
.ubp-nz-sheet .ubp-fieldinput, .ubp-nz-sheet .ubp-textarea { background: var(--nz-card); color: var(--nz-text); border-color: var(--nz-line); margin-bottom: 9px; }
.ubp-nz-sheet .ubp-btn { background: var(--nz-card3); color: var(--nz-text); }
.ubp-nz-sheet .ubp-btn.primary { background: linear-gradient(135deg, var(--nz-accent), var(--nz-accent2)); color: #fff; }
@keyframes ubp-nz-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* ── 通知中心（docs/24 P1）：桌面顶部下拉的跨 App 通知面板 ──
   壳层自包含（不引用任何 App 的调色板，亮/暗/壁纸三态通用）。
   面板默认整块推到屏外，加 .on 类才滑入；拖拽期间由 JS 写行内 transform 直接跟手（无过渡）。
   高效：整层 DOM 只在打开时创建、关闭即移除——关闭态零节点、零订阅、零动画。 */
/* 层级 13：压在日程横幅（11）与全局搜索层（12）之上，也压在整块 App 内容（关在自己的层叠上下文里，见 .ubp-app）之上。
   历史：这里曾是 9，而横幅是 11 ⇒ 有日程提醒时拉开通知中心，横幅会浮在面板上把时钟/「全部清除」压住；
   下方 .ubp-sched-banner 的注释一直写着「压在通知中心之下（11 < 12）」，与实现相反——本次对齐为 13 使注释成真。 */
.ubp-nc-layer { position: absolute; inset: 0; z-index: 13; }
.ubp-nc-veil { position: absolute; inset: 0; background: var(--ubp-overlay); opacity: 0; transition: opacity 0.22s ease; }
/* 遮罩只留 0.26（2026-10-02 二轮玻璃化）：面板是实底时遮罩要压到 0.45 才让面板「浮起来」，
   但换成玻璃后遮罩就成了反作用——它把桌面抹平，玻璃后面没东西可透，看着还是一块灰白板。
   现在面板靠自身那层白纱 + 投影与背景分离，遮罩只负责「降一档亮度」；实测玻璃合成色不变
   （≈rgb(235,240,238)），变的是它**透出的色彩层次**——这才是玻璃读得出来的原因。 */
.ubp-nc-layer.on .ubp-nc-veil { opacity: 0.26; }
/* 2026-10-03 返修⑤：遮罩回到**唯一一个值 0.26**（与 JS 的 PANEL_VEIL_OPACITY 同值）。
   返修③ 曾把「非壁纸态」加深到 0.60 靠压暗背板让面板浮起来；但面板改玻璃之后，
   浮起来靠的是**材质本身**（玻璃压在任意背板上都分离，亮/暗两套配色同理），
   遮罩再深只会：① 让 App 内容透不出来（用户判据「不是透亮度的问题」的另一半）
   ② 跟手期 JS 写的 0.26 与静止态分叉，松手瞬间遮罩会跳一档。统一为 0.26，两处才真的是一回事。 */
/* ── 系统面板（通知中心 / 控制中心 / 顶部横幅）＝**同一块料的两套配色**（2026-10-03 用户定调）──
   用户口径：「同样的材质，不同的颜色——深浅色本身就是对偶的」。于是分叉维度定为**主题**
   （唯一正确的那条），不是「桌面 / App / 有壁纸」这些状态：
     亮色主题 = 亮玻璃 + 深字   ← 取基础 token（--ubp-glass-bg 白 0.70 / --ubp-glass-text 深字）
     暗色主题 = 深玻璃 + 浅字   ← 见下节（0.74 近黑 / 浅字档）
   两套配色**逐项对偶**：模糊(26px saturate 1.8) / 描边 / 上缘光纱 / 冰砖 / 不透明兜底 / 遮罩(0.26) /
   投影几何(0 14px 32px + 0 2px 6px + inset 1px 高光) 全同，只有色值按明暗取反。
   这是返修④「主界面与 App 内根本不是一回事」的正面解法：那次把两处统一成**深玻璃**，方向对了一半
   ——分叉维度本就错了，该按主题分叉而不该按状态分叉。现在同一个主题下三种场合（桌面有/无壁纸、
   App 内）恒为同一块料，亮/暗之间才是有意为之的色差。
   对比度（返修③ 探针实测合成色）：亮玻璃压纯黑背板合成 ≈178 ⇒ 主文字 11:1；压纯白 ≈246 ⇒ 14:1。
   反例（已废弃的 0.68 深玻璃方案）：压在纯白 App 上，浅色主文字只有 5.4:1 —— 那正是「亮色主题里
   硬塞一块黑玻璃」的代价，也是本次改回来的原因。
   面板内元素若**只在深玻璃上成立**（浅色橙字、白纱按下态），必须补亮色档 —— 见下方各条。 */
/* 暗色主题：面板是深玻璃，两枚次要文字档必须跟着转浅（基础 token 是亮色主题的实字 #6E6E6E / #A8A8A8，
   压在深玻璃上只有 ≈3.4:1）。亮色主题不需要这一节 —— 基础 token 就是亮玻璃那一套。 */
.ubp-scope.ubp-dark .ubp-nc,
.ubp-scope.ubp-dark .ubp-cc {
  --ubp-glass-text-2: rgba(214, 214, 214, 0.84);
  --ubp-glass-text-3: rgba(214, 214, 214, 0.64);
}
/* 顶部浮层（真机控制中心口径，2026-10-02 用户返修）：**四角圆角的面板从状态栏下方滑出**，
   不再是「直角矩形铺满到屏幕顶」。--ubp-nc-rest＝静止位下移量（取状态栏高，把状态栏完整让出来），
   位移公式与它配套写在 phone-ui 的 ncApplyProgress（收起点 = -(100% + rest)，正好整块离屏）。
   2026-10-02 二轮：面板改**玻璃**（与日程提醒横幅同款配方、同一组 --ubp-glass-* token）——面板本身
   也压在桌面/App 内容上，实底白是这块画面里唯一「不透明」的东西。面板是不透明 → 玻璃的唯一代价在
   文字：面板背景上直接坐着时钟/日期/「全部清除」三样，故背景/次要文字走 --ubp-glass-text* ，
   **面板内的组卡与待办岛仍走 --ubp-text_***（它们压在近实底的冰砖 --ubp-glass-tile 上，对比度不变）。 */
.ubp-nc {
  --ubp-nc-rest: 38px;
  position: absolute; left: 0; right: 0; top: 0; max-height: 82%;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--ubp-glass-bg); color: var(--ubp-glass-text);
  border: 1px solid var(--ubp-glass-line); border-radius: 30px 30px 26px 26px;
  box-shadow: var(--ubp-glass-shadow);
  backdrop-filter: blur(26px) saturate(1.8); -webkit-backdrop-filter: blur(26px) saturate(1.8);
  /* 2026-10-03 返修③：玻璃自身的高光（上缘一片白纱、40% 处化没）。
     为什么必须有它：背板**纯色**时模糊什么也留不下（浅色 App 就是一块白底），
     这时「玻璃」只能靠自身的光学表意读出来——顶亮底沉的渐变 + 描边 + 投影。
     它同时是「App 内面板发死」的通用解：任何背板上都多一层可见的光学结构。 */
  background-image: linear-gradient(180deg, var(--ubp-glass-sheen), rgba(255, 255, 255, 0) 40%);
  transform: translateY(calc(-100% - var(--ubp-nc-rest)));
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  /* 2026-10-03 返修②（用户：电脑上左滑会选中文字）：面板是系统面板，内容一律不可选
     ——与 .ubp-screen 的 user-select:text 相冲突时，这里按下不选（真机通知中心同样不可选），
     否则鼠标按住左滑的整个过程中浏览器会把它当文本拖选，行内文字被刷成选区高亮。 */
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.ubp-nc-layer.on .ubp-nc { transform: translateY(var(--ubp-nc-rest)); }
/* 顶部抓手条：圆角面板的表意把手（iOS 表意），同时把「可拖拽关闭」变成看得见的事 */
.ubp-nc-griprow { flex: none; display: flex; align-items: center; justify-content: center; height: 16px; padding-top: 3px; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.ubp-nc-grip { width: 38px; height: 5px; border-radius: 3px; background: var(--ubp-glass-text-3); opacity: 0.55; }
/* 跟手期间关掉过渡：位移由指针 1:1 驱动，加过渡会「追不上手指」。
   **返修⑧（2026-10-03）退役了原来那条「跟手期间连毛玻璃一起关」**（用户口径：「拖动过程中不能
   表现成暗色剥离，要一样的表现」）：拖动中与非拖动中恒为**同一块玻璃**，不许换料。
   旧做法的理由是性能（面板在动、模糊采样窗口每帧都变，移动端会掉帧 ⇒ 那几百毫秒换不透明兜底色，
   号称「观感无差」）——**这个「观感无差」在壁纸档不成立**：兜底色是深实底、静止是真玻璃，
   一松手整块面板从深板变成照片色，落差一眼就看得见（.mockup/_ab7.html 并排稿实测：
   拖动 rgb(40,35,49) vs 静止 rgb(100,95,105)，纯白壁纸上静止侧还能到 rgb(175~204)。
   取舍是**观感优先**：拖动只几百毫秒，材质跳变却每次拉开都出现。
   --ubp-glass-solid 因此只剩一个用途：@supports not (backdrop-filter) 的宿主（那里没有模糊可退化）。 */
.ubp-nc-layer.dragging .ubp-nc, .ubp-nc-layer.dragging .ubp-nc-veil { transition: none; }
.ubp-nc-inner { display: flex; flex-direction: column; min-height: 0; }
/* 顶部把手区：时钟 + 全部清除。拖动关闭的唯一把手（touch-action/user-select 双清，移动端才不会被
   浏览器的滚动/文字选择手势接管而派发 pointercancel——同 bindDrag 把手的既有纪律）。 */
.ubp-nc-top { flex: none; display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; padding: 16px 18px 10px; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.ubp-nc-top:active { cursor: grabbing; }
.ubp-nc-clock { font-size: 28px; font-weight: 300; letter-spacing: -0.5px; line-height: 1.1; }
.ubp-nc-date { font-size: 11px; color: var(--ubp-glass-text-2); margin-top: 1px; }
.ubp-nc-clear { flex: none; border: none; background: transparent; color: var(--ubp-link); font-size: 13px; font-family: var(--ubp-font); padding: 4px 2px; cursor: pointer; }
.ubp-nc-scroll { min-height: 0; overflow-y: auto; padding: 2px 12px 16px; }

/* ── 控制中心（I-4）：与通知中心**对偶**的顶部浮层。
   刻意复用同一枚 --ubp-nc-rest（静止位）与同一组 --ubp-glass-* / --ubp-overlay，
   位移公式、吸附阈值、跟手关模糊等纪律全部一致 —— 两面板手感相同，差别只在入口侧与内容。
   z-index 13 与通知中心同层（两者互斥，同一时刻只开一个）。 ── */
.ubp-cc-layer { position: absolute; inset: 0; z-index: 13; }
.ubp-cc-veil { position: absolute; inset: 0; background: var(--ubp-overlay); opacity: 0; transition: opacity 0.22s ease; }
.ubp-cc-layer.on .ubp-cc-veil { opacity: 0.26; }
.ubp-cc {
  --ubp-nc-rest: 38px;
  position: absolute; left: 0; right: 0; top: 0; max-height: 82%;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--ubp-glass-bg); color: var(--ubp-glass-text);
  border: 1px solid var(--ubp-glass-line); border-radius: 30px 30px 26px 26px;
  box-shadow: var(--ubp-glass-shadow);
  backdrop-filter: blur(26px) saturate(1.8); -webkit-backdrop-filter: blur(26px) saturate(1.8);
  /* 与 .ubp-nc 逐字同款的光学表意（上缘光纱，量走 --ubp-glass-sheen）：两面板本来就是同一块玻璃的两种内容 */
  background-image: linear-gradient(180deg, var(--ubp-glass-sheen), rgba(255, 255, 255, 0) 40%);
  transform: translateY(calc(-100% - var(--ubp-nc-rest)));
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  /* 同 .ubp-nc 的返修②纪律：控制中心同样不可选中（拖动关闭时鼠标拖选会刷出选区） */
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.ubp-cc-layer.on .ubp-cc { transform: translateY(var(--ubp-nc-rest)); }
/* 同 .ubp-nc 的返修⑧：跟手期间只关过渡，**不换料**（两面板拖动手感与观感恒一致） */
.ubp-cc-layer.dragging .ubp-cc, .ubp-cc-layer.dragging .ubp-cc-veil { transition: none; }
.ubp-cc-inner { display: flex; flex-direction: column; min-height: 0; }
.ubp-cc-top { flex: none; display: flex; align-items: baseline; gap: 10px; padding: 4px 18px 12px; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.ubp-cc-top:active { cursor: grabbing; }
.ubp-cc-title { font-size: 15.5px; font-weight: 700; }
/* 状态行（第五轮 ④）：退役「🚧 施工中」，改显示真实设备状态（故事时间 · 地点 · 未读）。
   占标题行右端、不占格、不可交互；窄屏省略号截断（状态文字是自由文本，一律给上界）。 */
.ubp-cc-status { flex: 1; min-width: 0; margin-left: auto; text-align: right; font-size: 11px;
  color: var(--ubp-glass-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-cc-status b { color: var(--ubp-glass-text-2); font-weight: 700; }
.ubp-cc-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; padding: 0 14px 18px; }
/* 开关 = 「冰砖」：与通知中心面板内的组卡/待办岛同一档（比面板亮/暗一档 + 发丝描边） */
.ubp-cc-tile { display: flex; align-items: center; gap: 9px; padding: 12px; border-radius: 14px;
  background: var(--ubp-glass-tile); border: 1px solid var(--ubp-glass-tile-line);
  color: var(--ubp-glass-text); font-family: var(--ubp-font); cursor: pointer; text-align: left; }
.ubp-cc-tile.on { background: var(--ubp-accent); border-color: transparent; color: #fff; }
.ubp-cc-tile:active { filter: brightness(0.95); }
.ubp-cc-ic { flex: none; display: inline-flex; }
.ubp-cc-ic svg { width: 18px; height: 18px; }
.ubp-cc-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; }
.ubp-cc-state { flex: none; font-size: 11px; font-weight: 700; opacity: 0.72; }
/* 整行宽的动作格（锁屏）：占满两列，与上面四个开关在视觉上分层 */
.ubp-cc-tile.wide { grid-column: 1 / -1; justify-content: center; }
/* 组卡=面板内的一层「冰砖」：比面板亮一档、带发丝描边 ⇒ 在毛玻璃上读作凸起的一层。
   卡内文字仍走 --ubp-text_*（冰砖近实底，对比度与改造前一致）。 */
.ubp-nc-group { background: var(--ubp-glass-tile); border: 1px solid var(--ubp-glass-tile-line); border-radius: 14px; overflow: hidden; margin-bottom: 8px; }
/* ── 分组头（第五轮 ⑥）：点按折叠 / 长按清该 App。
   组头是「这个 App」的身份行，比组体内的行重一档底色（--ubp-card-3）以示分层。 ── */
.ubp-nc-grouphead { display: flex; align-items: center; gap: 9px; padding: 9px 13px 8px; background: var(--ubp-card-3); cursor: pointer;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.ubp-nc-grouphead .ubp-nc-icon { width: 22px; height: 22px; border-radius: 7px; }
.ubp-nc-grouphead .ubp-nc-icon svg { width: 13px; height: 13px; }
.ubp-nc-gname { font-size: 12.5px; font-weight: 700; color: var(--ubp-text); }
.ubp-nc-gcnt { margin-left: auto; font-size: 11px; font-weight: 700; color: var(--ubp-text-3); }
.ubp-nc-gchev { flex: none; color: var(--ubp-text-3); transition: transform 0.2s ease; }
.ubp-nc-gchev svg { width: 14px; height: 14px; display: block; }
/* 折叠态：组体收起、箭头转向（90°）；组头保留 ⇒ 「有事、但你先收起来了」 */
.ubp-nc-group.fold .ubp-nc-gbody { display: none; }
.ubp-nc-group.fold .ubp-nc-gchev { transform: rotate(-90deg); }
/* 单条左滑：容器裁切 + 行内位移由 JS 写；动作用户滑出来才看得到（真机口径） */
.ubp-nc-slide { position: relative; overflow: hidden; }
.ubp-nc-slide + .ubp-nc-slide { border-top: 1px solid var(--ubp-line); }
.ubp-nc-slide .ubp-nc-item { transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1); }
/* 跟手期间关过渡：位移由指针 1:1 驱动，加过渡会「追不上手指」（同面板 .dragging 的既有纪律） */
.ubp-nc-slide.ubp-nc-swiping .ubp-nc-item { transition: none; }
.ubp-nc-act { position: absolute; top: 0; right: 0; bottom: 0; width: 84px; display: flex; align-items: center; justify-content: center; gap: 5px;
  border: none; background: var(--ubp-accent); color: #fff; font-family: var(--ubp-font); font-size: 12.5px; font-weight: 600; cursor: pointer;
  /* 2026-10-03 返修①（用户：常态就会显示已读）：**没滑开就不许画这枚按钮**。
     上一版（第六轮 ⑩）只补了绘制层次（条目 position+z-index 压住它），那是**必要但不充分**的：
     条目底色是半透明冰砖（亮玻璃 0.34 白 / 深玻璃 0.07 白）——按钮会**从条目背后透出来**
     （壁纸态几乎原色透出，实测就是那块盖在行右端的整块绿）。透明度是绘制层次解决不了的，
     只能让它真的不可见：闭合态 visibility:hidden + opacity:0（顺带退出命中测试与键盘 Tab 序，
     误触「悄悄清掉通知」一并消失）。
     出场即时要、退场要跟着行滑回去（0.22s 与 .ubp-nc-item 的 transition 同拍），故写成
     「显示侧 transition:none / 隐藏侧延迟 0.22s 再摘 visibility」的不对称过渡。
     可见判据＝跟手期(.ubp-nc-swiping，由 JS 在认领手势时挂) ∥ 吸附展开态(.ubp-nc-open，JS 在松手时定)。
     可复现证据：.mockup/glass-wall.png（壁纸态闭合行）与 .mockup/glass-white.png（浅色态闭合行）。 */
  visibility: hidden; opacity: 0;
  transition: opacity 0.22s ease, visibility 0s linear 0.22s; }
.ubp-nc-slide.ubp-nc-swiping .ubp-nc-act,
.ubp-nc-slide.ubp-nc-open .ubp-nc-act { visibility: visible; opacity: 1; transition: none; }
.ubp-nc-act svg { width: 15px; height: 15px; }
.ubp-nc-act:active { filter: brightness(0.94); }
/* 条目补「定位 + 实底」——这一行是第六轮 ⑩ 修的既有缺陷。
   原先条目只有 display:flex：既无背景、又**不是定位元素**，而 .ubp-nc-act 是绝对定位的 84px 按钮；
   按 CSS 绘制顺序，定位元素整层画在非定位元素之上 ⇒ 动作钮**不用左滑就一直盖在行右端**（还压住正文尾部），
   「左滑露出已读」这个交互因此既没被隐藏、也没意义，误触还会悄悄清掉通知。
   注意：只补背景**不够**（背景不改变绘制层次）——条目必须自己也成为定位元素并提升层级才能盖住动作钮。
   实底取 --ubp-glass-tile（与 .ubp-nc-group 的分组底同值）⇒ 观感逐像素不变，变的只是绘制层次。
   可复现证据：.mockup/probe6.html 的命中测试（HIT@actCenter=ubp-nc-act）。 */
.ubp-nc-item { position: relative; z-index: 1; background: var(--ubp-glass-tile); display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px; cursor: pointer; }
.ubp-nc-item + .ubp-nc-item { border-top: 1px solid var(--ubp-line); }
/* 按下态按主题取对偶档（返修⑥）：亮玻璃上是一层**深**纱（白纱压在浅底上根本看不见），
   深玻璃上是一层**浅**纱。两档同为一层半透明薄纱，只是色值对偶。 */
.ubp-nc-item:active { background: rgba(0, 0, 0, 0.06); }
.ubp-dark .ubp-nc-item:active { background: rgba(255, 255, 255, 0.16); }
.ubp-nc-icon { width: 28px; height: 28px; border-radius: 8px; flex: none; display: flex; align-items: center; justify-content: center; color: #fff; }
.ubp-nc-icon svg { width: 17px; height: 17px; }
.ubp-nc-body { flex: 1; min-width: 0; }
.ubp-nc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ubp-nc-app { font-size: 11px; color: var(--ubp-glass-text-2); font-weight: 600; }
.ubp-nc-time { flex: none; font-size: 11px; color: var(--ubp-glass-text-3); }
.ubp-nc-title { display: block; font-size: 13px; font-weight: 600; color: var(--ubp-glass-text); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-nc-text { display: block; font-size: 11px; color: var(--ubp-glass-text-2); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-nc-badge { flex: none; min-width: 17px; height: 17px; border-radius: 9px; background: var(--ubp-badge); color: #fff; font-size: 10px; line-height: 17px; text-align: center; padding: 0 5px; }
/* 日程提醒（M7）唯一动作钮：橙底小胶囊；整行不可点（只有它能消费该条）。
   横幅（形态 A）与通知中心待办岛（形态 C）共用同一颗钮——两处动作的观感必须一致。 */
.ubp-nc-ack { flex: none; align-self: center; margin-left: 8px; height: 26px; padding: 0 12px; border: none; border-radius: 13px;
  background: #E8890C; color: #fff; font-family: var(--ubp-font); font-size: 12px; font-weight: 600; cursor: pointer; }
.ubp-nc-ack:active { filter: brightness(0.94); }

/* ── 通知中心「今日待办岛」（形态 C，2026-10-02 重设计）──
   日程不跟别的通知共用 .ubp-nc-group：面板是 --ubp-card、普通组是 --ubp-card-2，两者只差 4.5% 亮度，
   日程与微信/朋友圈挤在一起时组缝几乎看不见——那就是用户说的「堆在一起」。
   岛用同一组底 + **岛头整条淡染日程橙**做身份，行内左侧一条时间轴（实心橙点=今天 / 空心点=明天 /
   灰点=已确认），右侧动作单列对齐。整岛不吃「全部清除」（pin 语义在数据层，这里不动）。 */
.ubp-nc-island { background: var(--ubp-glass-tile); border: 1px solid var(--ubp-glass-tile-line); border-radius: 16px;
  overflow: hidden; margin-bottom: 8px; }
.ubp-nc-island-hd { display: flex; align-items: center; gap: 8px; padding: 11px 14px 9px;
  background: rgba(232, 137, 12, 0.20); border-bottom: 1px solid rgba(232, 137, 12, 0.34); }
.ubp-dark .ubp-nc-island-hd { background: rgba(232, 137, 12, 0.16); border-bottom-color: rgba(232, 137, 12, 0.30); }
/* 岛标题的日程橙按主题取对偶档（返修⑥）：亮玻璃上 #F7AE43 只有 ≈1.7:1（浅橙压浅橙底），
   走深一档的 #B96A05；深玻璃上反过来。与 .ubp-sched-when 同一对取值——全机日程橙只有这一对，两处同源。 */
.ubp-nc-island-ttl { font-size: 12.5px; font-weight: 700; color: #B96A05; letter-spacing: 0.2px; }
.ubp-dark .ubp-nc-island-ttl { color: #F7AE43; }
.ubp-nc-island-cnt { margin-left: auto; font-size: 11px; color: var(--ubp-text-3); }
.ubp-nc-todo { display: flex; gap: 10px; padding: 10px 14px 10px 16px; }
.ubp-nc-todo + .ubp-nc-todo { border-top: 1px solid var(--ubp-line); }
/* 岛内动作钮：flex gap 已给出 10px，别再加 .ubp-nc-ack 那 8px 左外边距 */
.ubp-nc-todo .ubp-nc-ack { margin-left: 0; }
.ubp-nc-todo-rail { flex: none; width: 7px; display: flex; flex-direction: column; align-items: center; padding-top: 5px; }
.ubp-nc-todo-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #E8890C; }
.ubp-nc-todo.tom .ubp-nc-todo-dot { background: transparent; border: 1.5px solid var(--ubp-text-3); }
.ubp-nc-todo.done .ubp-nc-todo-dot { background: var(--ubp-text-3); border-color: var(--ubp-text-3); }
.ubp-nc-todo-line { flex: 1; width: 1.5px; background: var(--ubp-line); margin-top: 4px; }
.ubp-nc-todo-col { flex: 1; min-width: 0; }
/* 行内三行各自成块：day/ti/bd 都是 <span>，缺 display:block 时短标题会跟日期挤回同一行 */
.ubp-nc-todo-col > span { display: block; }
.ubp-nc-todo-day { font-size: 10.5px; font-weight: 700; color: #B96A05; letter-spacing: 0.3px; }
.ubp-dark .ubp-nc-todo-day { color: #F7AE43; }
.ubp-nc-todo.tom .ubp-nc-todo-day, .ubp-nc-todo.done .ubp-nc-todo-day { color: var(--ubp-text-3); }
.ubp-nc-todo-ti { margin-top: 3px; font-size: 13.5px; font-weight: 700; color: var(--ubp-glass-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-nc-todo.done .ubp-nc-todo-ti { color: var(--ubp-text-2); }
.ubp-nc-todo-bd { margin-top: 2px; font-size: 11.5px; line-height: 1.5; color: var(--ubp-glass-text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 已确认的正面标记（旧版只会「按钮凭空消失」，用户看不出这条已经处理过） */
.ubp-nc-todo-chk { flex: none; align-self: center; font-size: 11px; color: var(--ubp-glass-text-3); }

/* ── 日程提醒横幅（M7 / 形态 A·通知卡）──
   数据源=主项目「备忘录」表里约定日期为**今天/明天**的条目：进入窗口且未确认 → 弹一次，一次一条；
   点「知道了」→ 写 ack（不再弹）+ 通知中心那条转常驻，直到备忘录被删除或过期。
   层挂在 .ubp-screen 下、压在 App 之上、通知中心之下（z-index 11 < 13，与 .ubp-nc-layer 对齐），App 重绘不冲掉它；
   通知中心打开期间横幅会被收掉（同一件事不在两处同时呈现），面板关掉后再拉回来（见 refreshScheduleBanner）。
   2026-10-02 重设计：旧版把备忘正文整段铺开（80 字→5 行，卡高 176px）+ 底写死深色 + 按钮独占一行，
   正文一长就糊成一堵字墙。现在 = 通知卡语法：身份行（图标+来源+日期徽章+「知道了」）→ 标题 2 行封顶
   → 正文 2 行封顶；卡高收到 130px（短文 110px）。
   玻璃：与桌面 Dock 同源配方（半透明 + backdrop blur + 发丝描边），密度更高——见 --ubp-glass-*。 */
.ubp-sched-banner { position: absolute; top: 46px; left: 10px; right: 10px; z-index: 11;
  padding: 12px 13px 13px; border-radius: 20px;
  background: var(--ubp-glass-bg); color: var(--ubp-glass-text);
  border: 1px solid var(--ubp-glass-line); box-shadow: var(--ubp-glass-shadow);
  backdrop-filter: blur(20px) saturate(1.7); -webkit-backdrop-filter: blur(20px) saturate(1.7);
  animation: ubp-sched-in 0.32s cubic-bezier(0.22, 1, 0.36, 1); }
/* ── 返修⑦：**面板压在照片上时，与 Dock / 锁屏卡用同一块料** ────────────────────────
   用户口径（2026-10-03）：「通知中心、控制中心和下方常用 APP 面板的玻璃效果明显不一样，
   包括锁屏界面的这个玻璃效果，后面两个才是我想要的效果」。
   证据（.mockup/glasscmp.png，四格同壁纸并排）：面板 0.70 白 + blur(26px) saturate(1.8) 压在照片上
   读成一块**奶油板**——30% 的透过率只够把白染成米色，照片的结构一点没留下；而 Dock（0.20 白 +
   白描边 + blur(14px)）与锁屏通知卡（0.13 白 + 白描边 + blur(14px)）是**照片透过来的玻璃**。
   同一张壁纸、同一个手机壳，两块料完全不同——这就是用户说的「明显不一样」。
   为什么这一档必须连**字色**一起转浅、而不是只把底调透：面板压在照片上时透过来的背景是暗的
   （桌面蒙层 0.42 + 面板遮罩 0.26 之后更暗），填充降到 0.20 一档后亮色主题的深字没有任何对比度。
   为什么这不算推翻返修⑥「分叉维度只能是主题」：返修⑥ 要保的是「**App 内**不许变成另一套料」，
   那条在本节一个字没动（选择器要求 .ubp-at-home —— App 内恒不成立，面板仍是主题对偶的亮玻璃）。
   本节新增的分叉维度不是「主题」，而是「**面板背后是照片还是 App 内容**」——与
   「.ubp-home.has-bg .ubp-dock」「.ubp-lock-card」取的是同一个判据，Dock 与锁屏卡本来就是这么分档的。 */
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-nc,
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-cc,
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-banner,
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-sched-banner {
  /* 底 / 描边 / 模糊半径三样与 .ubp-home.has-bg .ubp-dock 逐字同档 */
  --ubp-glass-bg: rgba(255, 255, 255, 0.20);
  --ubp-glass-line: rgba(255, 255, 255, 0.34);
  /* 冰砖 = 锁屏通知卡那一档（0.13 白 + 0.16 白描边），照片在卡内同样透得出来 */
  --ubp-glass-tile: rgba(255, 255, 255, 0.13);
  --ubp-glass-tile-line: rgba(255, 255, 255, 0.16);
  /* 光纱压到只够表意「上缘有厚度」，Dock / 锁屏卡都没有这层 */
  --ubp-glass-sheen: rgba(255, 255, 255, 0.10);
  /* 兜底（跟手期 / 无 backdrop-filter 的宿主）跟着转深：这一档的字是浅的 */
  --ubp-glass-solid: rgba(38, 34, 48, 0.96);
  --ubp-glass-text: #FFFFFF;
  --ubp-glass-text-2: rgba(255, 255, 255, 0.84);
  --ubp-glass-text-3: rgba(255, 255, 255, 0.62);
  /* 面板内那些**读主题 token** 的部位（分组头底色 / 组内文字 / 分隔线 / 「全部清除」）一并转浅。
     面板是个自闭的子树，在这里改只影响面板内部，不碰桌面与 App 的 token。 */
  --ubp-text: #FFFFFF;
  --ubp-text-2: rgba(255, 255, 255, 0.84);
  --ubp-text-3: rgba(255, 255, 255, 0.62);
  --ubp-card-3: rgba(255, 255, 255, 0.10);
  --ubp-line: rgba(255, 255, 255, 0.16);
  --ubp-link: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
/* 按下纱也取对偶档：亮色主题的深纱（rgba(0,0,0,.06)）压在这块深玻璃上根本看不见 */
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-nc-item:active { background: rgba(255, 255, 255, 0.16); }
/* 日程橙取浅档（与 .ubp-dark 那一档同值）：#B96A05 压在 0.13 白 + 照片上只有 ≈1.6:1，与岛头淡染一起发黑。
   「:not(.tom):not(.done)」是必要的——否则这条 (0,4,0) 会盖掉「明天 / 已确认」应有的灰字档 (0,3,0)。 */
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-nc-island-ttl,
.ubp-screen.ubp-at-home.ubp-has-wallpaper .ubp-nc-todo:not(.tom):not(.done) .ubp-nc-todo-day { color: #F7AE43; }
/* 宿主不支持 backdrop-filter：退回不透明卡（亮/暗两态各取自己的兜底色，不再是那张写死的深色板） */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .ubp-sched-banner, .ubp-nc { background: var(--ubp-glass-solid); }
  /* I-2/I-4 新增的两个玻璃面走独立规则：上面那条被契约测试钉住了字面形状（不改既有断言） */
  .ubp-banner, .ubp-cc { background: var(--ubp-glass-solid); }
}
@keyframes ubp-sched-in { 0% { transform: translateY(-14px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
.ubp-sched-hd { display: flex; align-items: center; gap: 9px; }
.ubp-sched-ico { flex: none; width: 30px; height: 30px; border-radius: 9px; background: #E8890C;
  display: flex; align-items: center; justify-content: center; }
.ubp-sched-ico svg { width: 17px; height: 17px; color: #fff; }
/* 身份行的收缩纪律：ico/app/ack 全 flex:none，徽章是**唯一**可让步项（flex: 0 1 auto + min-width:0）。
   来源名必须 flex:none + nowrap —— 中文 min-content 就是一个字，它一旦可缩就会被压成一字一行的竖排
   （2026-10-02 实测：窄屏或字体放大时「日程提醒」竖成四行）。 */
.ubp-sched-app { flex: none; white-space: nowrap; font-size: 12px; font-weight: 700; color: var(--ubp-glass-text-2); letter-spacing: 0.2px; }
/* 日期徽章：紧迫度（今天/明天）+ 约定日；还有别的未确认条目时换成「还有 N 条」。
   徽章文案是行里最长的一件，故由它兜收缩：宁可自己省略号截断，也不把来源名挤折行。 */
.ubp-sched-when { margin-left: auto; flex: 0 1 auto; min-width: 0; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; font-size: 11px; font-weight: 700; color: #B96A05;
  background: rgba(232, 137, 12, 0.14); border-radius: 999px; padding: 3px 10px; }
.ubp-dark .ubp-sched-when { color: #F7AE43; background: rgba(232, 137, 12, 0.22); }
.ubp-sched-ti { margin-top: 8px; font-size: 15.5px; font-weight: 700; line-height: 1.35; color: var(--ubp-glass-text);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
/* 正文 2 行封顶：这条 clamp 是「字墙」的直接解法，删掉它卡高就会随主项目正文长度失控 */
.ubp-sched-bd { margin-top: 4px; font-size: 12.5px; line-height: 1.62; color: var(--ubp-glass-text-2);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ubp-sched-ack { flex: none; height: 27px; padding: 0 14px; border: none; border-radius: 14px; background: #E8890C;
  color: #fff; font-family: var(--ubp-font); font-size: 12px; font-weight: 600; cursor: pointer; }
.ubp-sched-ack:active { filter: brightness(0.94); }

/* ── 通知横幅（I-2）：顶部滑入的玻璃横幅，与日程横幅**同一套配方与同一层**（z-index 11）。
   两者互斥：同一时刻顶部只留一条（横幅显示期间 refreshScheduleBanner 主动让位）。 ── */
.ubp-banner { position: absolute; top: 46px; left: 10px; right: 10px; z-index: 11;
  display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px; border-radius: 18px;
  background: var(--ubp-glass-bg); color: var(--ubp-glass-text);
  border: 1px solid var(--ubp-glass-line); box-shadow: var(--ubp-glass-shadow);
  backdrop-filter: blur(20px) saturate(1.7); -webkit-backdrop-filter: blur(20px) saturate(1.7);
  cursor: pointer; animation: ubp-banner-in 0.38s cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes ubp-banner-in { 0% { transform: translateY(-140%); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
/* 被灵动岛吸入（第五轮 ③）：自动收回时不再原位淡出，而是朝顶部收拢缩小、落进岛的位置；
   与 .ubp-island 的绽放动画（ubp-island-in）在时间上衔接，读作「通知进了岛」。
   位移 -34px 让终点落在状态栏中央（岛的位置）；scale 收到 0.18 后整层摘除，不留残影。 */
.ubp-banner.ubp-banner-absorb { animation: ubp-banner-absorb 0.3s cubic-bezier(0.5, 0, 0.9, 0.4) forwards; pointer-events: none; }
@keyframes ubp-banner-absorb {
  0% { transform: translateY(0) scale(1); opacity: 1; }
  55% { transform: translateY(-20px) scale(0.55); opacity: 0.82; }
  100% { transform: translateY(-34px) scale(0.18); opacity: 0; }
}
.ubp-banner:active { filter: brightness(0.97); }
.ubp-banner-icon { flex: none; width: 30px; height: 30px; border-radius: 9px;
  display: flex; align-items: center; justify-content: center; color: #fff; }
.ubp-banner-icon svg { width: 18px; height: 18px; }
.ubp-banner-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ubp-banner-app { font-size: 11px; font-weight: 700; color: var(--ubp-glass-text-2); letter-spacing: 0.2px; }
.ubp-banner-title { font-size: 13px; font-weight: 700; color: var(--ubp-glass-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 正文 2 行封顶（MEMORY §五.31：AI/正文来的自由文本一律在渲染层 clamp，卡高才有上界） */
.ubp-banner-text { font-size: 12.5px; line-height: 1.45; color: var(--ubp-glass-text-2);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

/* ── 锁屏（I-1）：压在 App 内容之上的整屏层（默认关闭；设置→通用）。 ──
   z-index 12 = 通知中心(13) 之下、横幅(11) 之上；锁屏期间下拉不唤面板（bindTopPullToNotifications 已早退）。
   App 内容整体被关进自己的层叠上下文（见 .ubp-app 的 isolation），所以 App 内那些 z-index 50/60/90 的底栏与弹层
   压不到这里——2026-10-03 修复「锁屏后在微博界面露出微博 Tab 栏」即此一处。 */
.ubp-lock { position: absolute; inset: 0; z-index: 12;
  display: flex; flex-direction: column; align-items: center; padding: 0 18px;
  color: #fff; user-select: none; -webkit-user-select: none; touch-action: none;
  background: linear-gradient(165deg, #1B2436 0%, #2A2233 45%, #4A3350 100%);
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease; }
.ubp-lock.ubp-lock-out { transform: translateY(-100%); opacity: 0; pointer-events: none; }
/* 来电全屏接管（I-1）：铃响期间锁屏让位，让电话界面完整盖住屏幕；挂断/接听后自动回来 */
.ubp-lock.ubp-lock-behind { display: none; }
/* 锁屏壁纸（可选）：.ubp-lock-bg = 裁剪框（overflow:hidden），内层 .ubp-crop-media.bg 承载图与取景 transform。
   蒙层不是整屏均匀压暗（那样壁纸会发闷），而是顶/底纵向渐变——时钟、日期、通知与解锁条所在处压暗，
   中间留透亮（对齐 iOS/Android 锁屏做法）；再给时钟与日期加文字投影，亮色壁纸上也能看清时间。 */
.ubp-lock-bg { position: absolute; inset: 0; background-size: cover; background-position: center; overflow: hidden; }
.ubp-lock-scrim { position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.46) 0%, rgba(0, 0, 0, 0.16) 30%, rgba(0, 0, 0, 0) 55%, rgba(0, 0, 0, 0.36) 100%); }
.ubp-lock > :not(.ubp-lock-bg):not(.ubp-lock-scrim) { position: relative; z-index: 1; }
.ubp-lock.has-bg .ubp-lock-clock, .ubp-lock.has-bg .ubp-lock-date { text-shadow: 0 1px 6px rgba(0, 0, 0, 0.55); }
.ubp-lock-clock { margin-top: 46px; font-size: 58px; font-weight: 200; letter-spacing: -1px; line-height: 1.05; font-variant-numeric: tabular-nums; }
.ubp-lock-date { margin-top: 2px; font-size: 12.5px; opacity: 0.85; letter-spacing: 1px; }
.ubp-lock-notis { width: 100%; margin-top: 26px; display: flex; flex-direction: column; gap: 8px; }
.ubp-lock-card { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 14px;
  width: 100%; font-family: var(--ubp-font); font-size: var(--fs-13); color: inherit; text-align: left;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
  transition: background 0.15s ease;
  background: rgba(255, 255, 255, 0.13); border: 1px solid rgba(255, 255, 255, 0.16);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.ubp-lock-card:active { background: rgba(255, 255, 255, 0.22); }
.ubp-lock-ico { flex: none; width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: #fff; }
.ubp-lock-ico svg { width: 16px; height: 16px; }
.ubp-lock-body { flex: 1; min-width: 0; }
.ubp-lock-app { display: block; font-size: 10.5px; font-weight: 700; opacity: 0.72; }
.ubp-lock-ti { display: block; margin-top: 1px; font-size: 12.5px; font-weight: 600; }
.ubp-lock-tx { display: block; margin-top: 2px; font-size: 11.5px; opacity: 0.82;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-lock-foot { margin-top: auto; width: 100%; padding-bottom: 22px; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.ubp-lock-cam { width: 40px; height: 40px; border: none; border-radius: 50%; background: rgba(255, 255, 255, 0.16);
  color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-lock-cam svg { width: 19px; height: 19px; }
.ubp-lock-hint { font-size: 11px; opacity: 0.62; }
.ubp-lock-bar { width: 118px; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.75); }
.ubp-nc-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 20px; color: var(--ubp-glass-text-3); }
.ubp-nc-empty svg { width: 28px; height: 28px; }
.ubp-nc-empty b { font-size: 13px; color: var(--ubp-glass-text-2); font-weight: 600; }
.ubp-nc-empty span { font-size: 11px; }
/* 行错峰淡入：只在「本次打开」的首次渲染上跑一次（.fresh 由 JS 开面板时挂、700ms 后摘），
   后续刷新（数据变更重绘）不再重放，避免每次通知变化都整屏闪一下。待办岛行同步错峰。 */
.ubp-nc-layer.fresh .ubp-nc-item, .ubp-nc-layer.fresh .ubp-nc-todo { animation: ubp-nc-in 0.28s ease both; animation-delay: calc(var(--ubp-nc-i, 0) * 40ms); }
@keyframes ubp-nc-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
/* 顶部信息带即下拉把手：退出滚动/文字选择体系，移动端才能在时钟区按住下拉 */
.ubp-home-top { touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
/* 桌面「通知入口」药丸（有未读才渲染）：可见可点的第二入口——顶部下拉是主路径，这颗负责被看见。
   走正常流居中（不做绝对定位，避免与 .ubp-home 直子元素的 position:relative 规则打架）。 */
.ubp-home-nctip {
  flex: none; align-self: center; display: inline-flex; align-items: center; gap: 5px;
  height: 20px; margin-bottom: 6px; padding: 0 10px; border: none; border-radius: 10px;
  background: var(--ubp-card); color: var(--ubp-text-2);
  font-family: var(--ubp-font); cursor: pointer; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.10);
}
.ubp-home-nctip i { width: 14px; height: 3px; border-radius: 2px; background: var(--ubp-text-3); }
.ubp-home-nctip b { font-size: 10px; font-weight: 700; color: var(--ubp-badge); }
.ubp-home-nctip:active { filter: brightness(0.96); }
/* 壁纸态：药丸跟着走（半透明白 + 白字），否则在照片上糊成一块 */
.ubp-home.has-bg .ubp-home-nctip { background: rgba(255, 255, 255, 0.24); color: #fff; box-shadow: none; }
.ubp-home.has-bg .ubp-home-nctip i { background: rgba(255, 255, 255, 0.85); }
.ubp-home.has-bg .ubp-home-nctip b { color: #fff; }

/* ── 全局搜索（M5）：桌面搜索胶囊 + 全屏结果页 ──
   结果页复用微信搜索页的 .ubp-cs-* 件与 .ubp-wx-grouphead（零新组件）；仅此两层是新类。
   层挂在 .ubp-screen 下（不是 .ubp-app）：App 重绘换 innerHTML 不会冲掉它。 */
.ubp-home-gsearch {
  flex: none; display: flex; align-items: center; gap: 7px; margin: 0 2px 12px;
  height: 36px; padding: 0 12px; border-radius: 11px;
  background: var(--ubp-card); color: var(--ubp-text-3);
  font-size: 13px; cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.07);
}
.ubp-home-gsearch:active { background: var(--ubp-card-2); }
.ubp-home-gsearch svg { width: 16px; height: 16px; flex: none; }
.ubp-home-gsearch span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-home.has-bg .ubp-home-gsearch { background: rgba(255, 255, 255, 0.22); color: rgba(255, 255, 255, 0.92); border: 1px solid rgba(255, 255, 255, 0.26); box-shadow: none; }
.ubp-gsearch { position: absolute; left: 0; right: 0; top: 38px; bottom: 0; z-index: 12; display: flex; flex-direction: column; background: var(--ubp-bg); }
.ubp-gsearch .ubp-cs-scroll { flex: 1; min-height: 0; overflow-y: auto; background: var(--ubp-card); }
.ubp-gsearch .ubp-wx-grouphead { background: var(--ubp-card-2); }

/* ── 微信 · 聊天内搜索（真机微信「查找聊天记录」）──
   顶栏换搜索框 + 结果列表；点结果回聊天并把该条滚到视口中央（不做高亮/上下条导航）。
   输入只就地换结果列表节点，不整页重绘（保焦点与光标，同会话页搜索纪律）。 */
.ubp-cs-appbar { gap: 8px; }
.ubp-cs-field { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 8px; background: var(--ubp-card-2); color: var(--ubp-text-3); }
.ubp-cs-field svg { width: 15px; height: 15px; flex: none; }
.ubp-cs-input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-family: var(--ubp-font); font-size: 13px; color: var(--ubp-text); }
.ubp-cs-input::placeholder { color: var(--ubp-text-3); }
.ubp-cs-cancel { flex: none; border: none; background: transparent; color: var(--ubp-accent); font-family: var(--ubp-font); font-size: 15px; padding: 0 2px; cursor: pointer; }
.ubp-cs-scroll { flex: 1; min-height: 0; overflow-y: auto; background: var(--ubp-card); }
.ubp-cs-row { display: flex; align-items: center; gap: 11px; padding: 10px 14px; border-bottom: 1px solid var(--ubp-line); cursor: pointer; }
.ubp-cs-row:active { background: var(--ubp-card-2); }
.ubp-cs-main { flex: 1; min-width: 0; }
.ubp-cs-name { display: block; font-size: 13px; color: var(--ubp-text-2); }
.ubp-cs-text { display: block; font-size: 15px; color: var(--ubp-text); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-cs-time { flex: none; align-self: flex-start; margin-top: 2px; font-size: 11px; color: var(--ubp-text-3); }
/* 会话列表草稿标识（真机微信：未发出的输入以红字 [草稿] 开头，后面的草稿正文仍是预览灰） */
.ubp-wx-preview .ubp-wx-draft { color: var(--ubp-badge); }

/* ── 编年史（docs/25）：按天分组的生活流 + 日视图 ──
   时间轴圆点与卡片图标底色=来源 App 品牌色（风格皮肤覆盖），一眼分得清「这是谁的动静」。 */
.ubp-chr-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 10px; }
.ubp-chr-scroll.empty { display: flex; flex-direction: column; }
.ubp-chr-day { padding-bottom: 4px; }
.ubp-chr-dayhead { position: sticky; top: 0; z-index: 2; width: 100%; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 9px 16px 7px; border: none; background: var(--ubp-bg); color: var(--ubp-text); font-family: var(--ubp-font); text-align: left; cursor: pointer; }
.ubp-chr-dayhead.static { cursor: default; }
.ubp-chr-dayhead b { font-size: 13px; font-weight: 700; }
.ubp-chr-dayhead.today b, .ubp-chr-dayhead b.today { color: var(--ubp-accent); }
.ubp-chr-dayhead span { font-size: 11px; color: var(--ubp-text-3); }
.ubp-chr-row { display: flex; align-items: stretch; padding-right: 12px; }
.ubp-chr-time { flex: none; width: 42px; text-align: right; padding-top: 11px; font-size: 11px; color: var(--ubp-text-3); font-variant-numeric: tabular-nums; }
.ubp-chr-rail { flex: none; width: 26px; display: flex; justify-content: center; position: relative; }
.ubp-chr-rail::before { content: ''; position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ubp-line); }
.ubp-chr-rail i { position: relative; width: 9px; height: 9px; border-radius: 50%; margin-top: 13px; box-shadow: 0 0 0 3px var(--ubp-bg); }
.ubp-chr-card { flex: 1; min-width: 0; display: flex; gap: 9px; align-items: flex-start; margin: 5px 0; padding: 9px 10px; background: var(--ubp-card); border-radius: 11px; box-shadow: 0 1px 3px rgba(0, 0, 0, .05); cursor: pointer; }
.ubp-chr-card:active { filter: brightness(0.97); }
.ubp-chr-ico { flex: none; width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #fff; }
.ubp-chr-ico svg { width: 16px; height: 16px; }
.ubp-chr-main { flex: 1; min-width: 0; display: block; }
.ubp-chr-head { display: flex; align-items: baseline; gap: 6px; }
.ubp-chr-head b { font-size: 13px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-chr-head em { font-style: normal; font-size: 11px; color: var(--ubp-text-3); flex: none; }
.ubp-chr-head em.ubp-chr-n { margin-left: auto; }
.ubp-chr-text { display: block; font-size: 11px; color: var(--ubp-text-2); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ubp-chr-go { flex: none; align-self: center; color: var(--ubp-text-3); font-size: 15px; }
/* 第六轮 ②：这一条有具体去处（带 target）时箭头转品牌色 —— 把「点进去能到那一条」变成看得见的事 */
.ubp-chr-go.ubp-chr-go-live { color: var(--ubp-accent); }
.ubp-chr-strip { display: flex; align-items: center; gap: 6px; margin-top: 5px; }
.ubp-chr-chip { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 11px; font-weight: 600; background: var(--ubp-card-2); color: var(--ubp-text-2); }
.ubp-chr-shots { display: flex; gap: 4px; margin-top: 6px; }
.ubp-chr-shots span { width: 46px; height: 34px; border-radius: 6px; display: block; background: var(--ubp-card-2) center / cover no-repeat; }
.ubp-chr-more { padding: 12px; text-align: center; font-size: 11px; color: var(--ubp-text-3); }
.ubp-chr-foot { margin: 12px 12px 10px; padding: 8px 10px; border-radius: 9px; background: var(--ubp-card-2); font-size: 11px; color: var(--ubp-text-3); line-height: 1.6; }
.ubp-chr-foot b { color: var(--ubp-text-2); }
.ubp-chr-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; padding: 0 30px; text-align: center; color: var(--ubp-text-3); }
.ubp-chr-empty svg { width: 34px; height: 34px; }
.ubp-chr-empty b { font-size: 13px; color: var(--ubp-text-2); font-weight: 600; }
.ubp-chr-empty span { font-size: 11px; line-height: 1.7; }
/* 日视图：四个计数 + 活动密度条（24h 轨道，每段=一条记录，按时刻定位） */
.ubp-chr-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 10px 12px 6px; }
.ubp-chr-stat { background: var(--ubp-card); border-radius: 11px; padding: 9px 4px; text-align: center; }
.ubp-chr-stat b { display: block; font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ubp-chr-stat span { font-size: 10px; color: var(--ubp-text-2); }
.ubp-chr-daybar { display: flex; align-items: center; gap: 6px; padding: 2px 14px 8px; }
.ubp-chr-daybar i { flex: 1; height: 22px; border-radius: 6px; background: var(--ubp-card); position: relative; overflow: hidden; }
.ubp-chr-daybar i em { position: absolute; top: 0; bottom: 0; width: 4%; font-style: normal; border-radius: 4px; opacity: 0.78; }

/* ── 货币联动：转账/红包弹层的余额卡 + 币种条 + 超发行 + 拆红包 ──────────────
   ★ 归位（V1.173）：这一组规则原本接在 SKIN_HOME_CENTER_CSS 尾部，而那串只在「自定义皮肤且
   home.layout === 'center'」时注入（core/skin-themes.ts phoneSkinCss 只被自定义皮肤调用）——
   四套内置风格全不满足 ⇒ 余额条/chips/拆红包钮/金币动效在真机上一直是无样式的裸标签。
   现全部落回 PHONE_CSS_RAW（无条件注入），皮肤块只留桌面时刻居中那几条布局。
   余额改版（用户定稿 2026-10-06）：旧行式 11.5px 灰字「当前余额 x 币名」升成卡片——
   圆底币种图标 + 「可用余额」标签 + 22px 大数，超发提示并进同一张卡（danger 变体 + 卡内一行差额），
   不再插在金额框与留言框之间；币种条只留币名，余额只在卡里出现一次。 */
.ubp-money-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0 10px; background: var(--ubp-card-2); border: 1px solid var(--ubp-line); border-radius: 12px; padding: 9px 12px; margin: 1px 0 10px; }
.ubp-money-badge { flex: none; width: 30px; height: 30px; border-radius: 50%; background: var(--ubp-accent-soft); color: var(--ubp-accent); display: flex; align-items: center; justify-content: center; }
.ubp-money-badge svg { width: 17px; height: 17px; }
.ubp-money-info { flex: 1; min-width: 0; }
.ubp-money-lab { display: block; font-size: 11px; color: var(--ubp-text-2); line-height: 1.3; }
.ubp-money-val { display: flex; align-items: baseline; gap: 5px; margin-top: 1px; }
.ubp-money-num { font-size: 22px; font-weight: 700; line-height: 1.14; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; color: var(--ubp-text); }
.ubp-money-unit { font-size: 13px; color: var(--ubp-text-2); }
/* 超发（L15）：同一张卡换 danger 变体，余额留在原位（用户要看着它改金额），差额另起一行 */
.ubp-money-head.over { background: var(--ubp-danger-soft); border-color: var(--ubp-danger-line); }
.ubp-money-head.over .ubp-money-badge { background: var(--ubp-card); color: var(--ubp-danger); }
.ubp-money-warn { flex: 0 0 100%; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--ubp-danger-line); font-size: 13px; line-height: 1.45; color: var(--ubp-danger); }
.ubp-money-warn b { font-weight: 700; font-variant-numeric: tabular-nums; }
.ubp-money-amt-over, .ubp-money-amt-over:focus { border-color: var(--ubp-danger-line); }
/* 币种条：多币种才渲染；只带币名（余额由卡承担一份，不再两处各念一遍） */
.ubp-money-curchips { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
.ubp-money-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; border: 1.5px solid var(--ubp-line); background: var(--ubp-card-2); color: var(--ubp-text-2); border-radius: 999px; padding: 5px 12px 5px 8px; font-weight: 600; cursor: pointer; font-family: var(--ubp-font); }
.ubp-money-chip.on { border-color: var(--ubp-accent); color: var(--ubp-accent); background: var(--ubp-accent-soft); }
/* 拆红包（聊天里未拆红包右侧的「開」）；金币迸出给拆开动效 */
.ubp-rp-open { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); width: 34px; height: 34px; border-radius: 50%; background: #ffd86b; color: #a3541f; font-weight: 800; font-size: 14px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(120,50,10,.35); border: none; cursor: pointer; animation: ubp-rp-pulse 1.6s infinite; }
/* 「開」是绝对定位、不占流内宽度（此前样式不生效时它是个普通 flex 子元素，靠自身占位躲开正文）——
   可拆的卡给正文右侧留出钮位（9px 边距 + 34px 钮 − 12px 卡内边距 ≈ 32px），否则长祝福语会被钮压住 */
.ubp-card.redpacket.claimable .ubp-card-main { padding-right: 32px; }
@keyframes ubp-rp-pulse { 0%, 100% { transform: translateY(-50%) scale(1); } 50% { transform: translateY(-50%) scale(1.12); } }
.ubp-coin-fx { position: absolute; width: 11px; height: 11px; border-radius: 50%; background: #ffd25e; box-shadow: 0 0 0 2px rgba(214,160,40,.5) inset; pointer-events: none; z-index: 5; left: 50%; top: 50%; }

/* ══ 网上商城（docs/52）══════════════════════════════════════════════════════════
   调色板：--shp-*（电商橙 + 价格色）；挂在 .ubp-shp-scope 上并**覆盖 --ubp-accent 三件套**，
   让 App 内所有既有件（.ubp-btn.primary / .ubp-spinner / .ubp-empty-btn）自动跟着商城主色走。
   风格换装：仙侠=鎏金 / 武侠=朱砂 / 西幻=酒红（同 .ubp-skin-* 作用域，与亮暗正交）。 */
.ubp-shp-scope {
  --shp-acc: #FF6A00; --shp-acc-press: #E85F00; --shp-acc-soft: rgba(255, 106, 0, 0.12);
  --shp-price: #FF5000;
  /* 商家会话「我方气泡」（docs/54）：商城主色渐变；暗色与四风格各自覆盖这一对即可 */
  --shc-me-bg: linear-gradient(135deg, #FF8A33, #FF6A00); --shc-me-text: #FFFFFF;
  --ubp-accent: var(--shp-acc); --ubp-accent-press: var(--shp-acc-press); --ubp-accent-soft: var(--shp-acc-soft);
  display: flex; flex-direction: column; flex: 1; min-height: 0;
}
.ubp-scope.ubp-dark .ubp-shp-scope {
  --shp-acc: #FF7A33; --shp-acc-press: #F06A20; --shp-acc-soft: rgba(255, 122, 51, 0.16);
  --shp-price: #FF8A4D;
  --shc-me-bg: linear-gradient(135deg, #B8501A, #A34410); --shc-me-text: #FFF3EA;
}
.ubp-scope.ubp-skin-xianxia .ubp-shp-scope { --shp-acc: #C9A227; --shp-acc-press: #B08F1F; --shp-acc-soft: rgba(201, 162, 39, 0.14); --shp-price: #B8860B; --shc-me-bg: linear-gradient(135deg, #D8B84A, #C9A227); --shc-me-text: #2A2412; }
.ubp-scope.ubp-skin-wuxia .ubp-shp-scope { --shp-acc: #A63A2E; --shp-acc-press: #8E3126; --shp-acc-soft: rgba(166, 58, 46, 0.13); --shp-price: #9E2B25; --shc-me-bg: linear-gradient(135deg, #BE4A3C, #A63A2E); --shc-me-text: #FFF1EC; }
.ubp-scope.ubp-skin-fantasy .ubp-shp-scope { --shp-acc: #9C4A6B; --shp-acc-press: #85405C; --shp-acc-soft: rgba(156, 74, 107, 0.15); --shp-price: #A8476A; --shc-me-bg: linear-gradient(135deg, #B25A7C, #9C4A6B); --shc-me-text: #FCEFF5; }

/* ── 底部 tab（首页 / 购物车 / 我的）── */
.ubp-shp-tabbar { flex: none; display: flex; border-top: 1px solid var(--ubp-line); background: var(--ubp-card); }
.ubp-shp-tab { flex: 1; position: relative; padding: 7px 0 8px; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 10.5px; color: var(--ubp-text-3); cursor: pointer; }
.ubp-shp-tab.on { color: var(--shp-acc); font-weight: 600; }
.ubp-shp-tab i { width: 20px; height: 20px; display: block; }
.ubp-shp-tab i svg { width: 20px; height: 20px; }
.ubp-shp-tabbdg { position: absolute; top: 3px; left: 50%; margin-left: 6px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 99px; background: var(--ubp-badge); color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; }

/* ── 首页 ── */
.ubp-shp-banner { display: flex; align-items: center; gap: 10px; margin: 10px 12px 8px; padding: 11px 12px; border: 1px solid var(--ubp-line); border-radius: 14px; background: var(--ubp-card); }
.ubp-shp-banner-ico { flex: none; width: 34px; height: 34px; border-radius: 10px; background: var(--shp-acc); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 17px; }
.ubp-shp-banner-t { font-size: 13px; font-weight: 700; }
.ubp-shp-banner-d { margin-top: 2px; font-size: 11px; color: var(--ubp-text-2); }
.ubp-shp-warnbar { margin: 10px 12px 0; padding: 7px 10px; border: 1px solid var(--ubp-warn-line); border-radius: 10px; background: var(--ubp-warn-soft); color: var(--ubp-warn); font-size: 11px; line-height: 1.5; }
/* 分类筛选行：**换行铺满，不做横向滚动**（用户返修 2026-10-06——原先 overflow-x:auto + 隐藏滚动条，
   桌面端（鼠标）拉不动这一行 ⇒ 右边的分类永远看不到，表现为"被截断"。分类有 8 项上限（shopCategories），
   最多两行即可全展示，故直接 flex-wrap；订单筛选行同用本类，四条短标签本就一行放得下。 */
.ubp-shp-chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 2px 12px 8px; }
.ubp-shp-chip { flex: none; padding: 5px 11px; border: 1px solid var(--ubp-line); border-radius: 99px; background: var(--ubp-card); color: var(--ubp-text-2); font-size: 11.5px; cursor: pointer; }
.ubp-shp-chip.on { background: var(--shp-acc); border-color: var(--shp-acc); color: #fff; font-weight: 600; }
.ubp-shp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; padding: 0 12px 12px; }
.ubp-shp-card { border: 1px solid var(--ubp-line); border-radius: 13px; background: var(--ubp-card); overflow: hidden; cursor: pointer; }
.ubp-shp-thumb { position: relative; height: 118px; display: flex; align-items: center; justify-content: center; font-size: 42px; }
.ubp-shp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 生图中的转圈＝全机同一枚 .ubp-spinner（与其他 App 统一表征，用户定案）：
   图块/缩略图里小一号、主图区大一号；配色随 token 自适应（暗色/皮肤无需另写）。 */
.ubp-shp-thumb .ubp-spinner, .ubp-shp-cthumb .ubp-spinner, .ubp-shp-othumb .ubp-spinner, .ubp-shp-ft .ubp-spinner { width: 22px; height: 22px; }
.ubp-shp-hero-spin { width: 30px; height: 30px; border-width: 3px; }
.ubp-shp-new { position: absolute; top: 7px; left: 7px; padding: 2px 7px; border-radius: 99px; background: var(--shp-acc); color: #fff; font-size: 10px; font-weight: 700; }
.ubp-shp-fav { position: absolute; top: 6px; right: 6px; width: 25px; height: 25px; border-radius: 50%; background: rgba(255, 255, 255, 0.88); color: #B9B9BE; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-shp-fav svg { width: 14px; height: 14px; }
.ubp-shp-fav.on { color: #FF4D6A; }
.ubp-shp-pinfo { padding: 8px 9px 10px; }
.ubp-shp-name { font-size: 12.5px; font-weight: 600; line-height: 1.35; height: 34px; overflow: hidden; }
.ubp-shp-price { margin-top: 5px; display: flex; align-items: baseline; gap: 4px; color: var(--shp-price); font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
.ubp-shp-price small { font-size: 10px; font-weight: 600; color: var(--ubp-text-2); }
.ubp-shp-meta { margin-top: 4px; display: flex; justify-content: space-between; gap: 6px; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-shp-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shp-g1 { background: linear-gradient(135deg, #E8F3EC, #D2E9DC); }
.ubp-shp-g2 { background: linear-gradient(135deg, #EDEFF7, #D9DEF0); }
.ubp-shp-g3 { background: linear-gradient(135deg, #FBF0E4, #F3DFC8); }
.ubp-shp-g4 { background: linear-gradient(135deg, #F3E8F2, #E7D3E6); }
.ubp-shp-g5 { background: linear-gradient(135deg, #E9F1F6, #D3E5EF); }
.ubp-shp-g6 { background: linear-gradient(135deg, #F6EFE3, #EDDFC7); }
.ubp-scope.ubp-dark .ubp-shp-g1, .ubp-scope.ubp-dark .ubp-shp-g2, .ubp-scope.ubp-dark .ubp-shp-g3,
.ubp-scope.ubp-dark .ubp-shp-g4, .ubp-scope.ubp-dark .ubp-shp-g5, .ubp-scope.ubp-dark .ubp-shp-g6 { filter: brightness(0.42) saturate(0.8); }
/* 骨架卡（生成中） */
.ubp-shp-skel { border: 1px solid var(--ubp-line); border-radius: 13px; background: var(--ubp-card); overflow: hidden; }
.ubp-shp-skel-b { position: relative; overflow: hidden; border-radius: 6px; background: var(--ubp-card-3); }
.ubp-shp-skel-b::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent); animation: ubp-shp-sh 1.4s infinite; }
.ubp-scope.ubp-dark .ubp-shp-skel-b::after { background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent); }
@keyframes ubp-shp-sh { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.ubp-shp-genbar { flex: none; display: flex; align-items: center; gap: 9px; margin: 10px 12px 0; padding: 9px 12px; border: 1px solid var(--ubp-line); border-radius: 12px; background: var(--ubp-card); font-size: 12px; }
.ubp-shp-genbar-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--shp-acc); animation: ubp-shp-pulse 1s infinite alternate; }
@keyframes ubp-shp-pulse { from { opacity: 0.35; } to { opacity: 1; } }
.ubp-shp-err { margin: 12px; padding: 14px; border: 1px solid var(--ubp-line); border-radius: 13px; background: var(--ubp-card); text-align: center; }
.ubp-shp-empty-t { display: block; margin-bottom: 6px; font-size: 15px; }
.ubp-shp-err b { font-size: 14px; }
.ubp-shp-err p { margin: 7px 0 11px; font-size: 12.5px; line-height: 1.6; color: var(--ubp-text-2); word-break: break-word; }

/* ── 商品详情 ── */
.ubp-shp-hero { position: relative; height: 210px; display: flex; align-items: center; justify-content: center; font-size: 84px; }
.ubp-shp-hero img { width: 100%; height: 100%; object-fit: contain; background: #fff; display: block; }
.ubp-shp-hero-pill { position: absolute; right: 12px; bottom: 12px; padding: 6px 12px; border-radius: 99px; background: rgba(25, 25, 25, 0.62); color: #fff; font-size: 11.5px; cursor: pointer; }
.ubp-shp-hero-badge { position: absolute; left: 12px; top: 12px; padding: 3px 9px; border-radius: 99px; background: rgba(255, 255, 255, 0.9); color: var(--ubp-text-2); font-size: 10.5px; }
.ubp-shp-pad { padding: 12px; }
.ubp-shp-sec { border: 1px solid var(--ubp-line); border-radius: 14px; background: var(--ubp-card); padding: 13px; }
.ubp-shp-sec + .ubp-shp-sec { margin-top: 10px; }
.ubp-shp-dname { font-size: 17px; font-weight: 800; line-height: 1.35; }
.ubp-shp-dprice { margin-top: 7px; display: flex; align-items: baseline; gap: 6px; color: var(--shp-price); font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; }
.ubp-shp-dprice small { font-size: 12px; font-weight: 600; color: var(--ubp-text-2); }
.ubp-shp-tags { margin-top: 9px; display: flex; flex-wrap: wrap; gap: 7px; }
.ubp-shp-tag { padding: 3px 8px; border-radius: 6px; background: var(--ubp-card-2); color: var(--ubp-text-2); font-size: 11px; }
.ubp-shp-desc { font-size: 13px; line-height: 1.75; }
.ubp-shp-row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--ubp-line); font-size: 12.5px; }
.ubp-shp-row:last-child { border-bottom: none; }
.ubp-shp-row .k { flex: none; color: var(--ubp-text-2); }
.ubp-shp-row .v { text-align: right; word-break: break-word; }
.ubp-shp-sect { display: flex; justify-content: space-between; align-items: baseline; margin: 14px 2px 7px; font-size: 12.5px; font-weight: 700; color: var(--ubp-text-2); }
.ubp-shp-sect span:last-child { font-size: 11.5px; font-weight: 400; color: var(--ubp-text-3); }
.ubp-shp-review { display: flex; gap: 9px; padding: 9px 0; border-bottom: 1px solid var(--ubp-line); }
.ubp-shp-review:last-child { border-bottom: none; }
.ubp-shp-rv-ava { flex: none; width: 26px; height: 26px; border-radius: 50%; background: var(--ubp-card-3); color: var(--ubp-text-2); font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.ubp-shp-rv-n { font-size: 11.5px; font-weight: 700; color: var(--ubp-text-2); }
.ubp-shp-rv-t { margin-top: 2px; font-size: 12.5px; line-height: 1.6; }
.ubp-shp-buybar { flex: none; display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-top: 1px solid var(--ubp-line); background: var(--ubp-card); }
.ubp-shp-favbtn { flex: none; width: 46px; height: 44px; border: 1px solid var(--ubp-line); border-radius: 12px; background: var(--ubp-card); color: var(--ubp-text-2); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; font-size: 9.5px; cursor: pointer; }
.ubp-shp-favbtn svg { width: 15px; height: 15px; }
.ubp-shp-favbtn.on { color: #FF4D6A; border-color: rgba(255, 77, 106, 0.4); }
.ubp-shp-btn { flex: 1; height: 44px; border: 1px solid var(--shp-acc); border-radius: 12px; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 14px; font-weight: 700; font-family: var(--ubp-font); cursor: pointer; }
.ubp-shp-btn.solid { background: var(--shp-acc); color: #fff; }
.ubp-shp-btn:disabled { border-color: var(--ubp-line); background: var(--ubp-card-3); color: var(--ubp-text-3); }

/* ── 购物车 ── */
.ubp-shp-crow { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; padding: 11px; border: 1px solid var(--ubp-line); border-radius: 13px; background: var(--ubp-card); }
.ubp-shp-ck { flex: none; width: 19px; height: 19px; border: 1.5px solid var(--ubp-text-3); border-radius: 50%; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-shp-ck.on { background: var(--shp-acc); border-color: var(--shp-acc); }
.ubp-shp-cthumb { flex: none; width: 62px; height: 62px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 27px; overflow: hidden; }
.ubp-shp-cthumb img { width: 100%; height: 100%; object-fit: cover; }
.ubp-shp-cinfo { flex: 1; min-width: 0; }
.ubp-shp-cname { font-size: 13px; font-weight: 600; line-height: 1.35; }
.ubp-shp-cname-lg { font-size: 15px; }
.ubp-shp-cshop { margin-top: 3px; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-shp-cprice { margin-top: 5px; color: var(--shp-price); font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; }
.ubp-shp-cprice small { font-size: 10px; font-weight: 600; color: var(--ubp-text-2); }
.ubp-shp-stepper { display: flex; align-items: center; gap: 9px; margin-top: 7px; }
.ubp-shp-stepper i { width: 22px; height: 22px; border-radius: 6px; background: var(--ubp-card-3); color: var(--ubp-text-2); font-style: normal; font-size: 13px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-shp-stepper b { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.ubp-shp-checkout { flex: none; padding: 10px 12px 12px; border-top: 1px solid var(--ubp-line); background: var(--ubp-card); }
.ubp-shp-totals { display: flex; flex-direction: column; gap: 3px; margin-bottom: 9px; }
.ubp-shp-tot { display: flex; justify-content: space-between; font-size: 12px; }
.ubp-shp-tot .v { color: var(--shp-price); font-weight: 800; font-variant-numeric: tabular-nums; }
.ubp-shp-tot .v small { font-size: 10px; font-weight: 600; color: var(--ubp-text-2); }
.ubp-shp-payrow { display: flex; align-items: center; gap: 9px; }
.ubp-shp-sum { flex: 1; font-size: 12px; color: var(--ubp-text-2); }
.ubp-shp-sum b { color: var(--shp-price); font-size: 15px; font-variant-numeric: tabular-nums; }

/* ── 我的（个人主页）── */
.ubp-shp-mehead { display: flex; align-items: center; gap: 12px; padding: 4px 2px 12px; }
.ubp-shp-mava { flex: none; width: 52px; height: 52px; border-radius: 16px; background: linear-gradient(135deg, #7A66C8, #5A46A8); color: #fff; font-size: 20px; font-weight: 700; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.ubp-shp-mava img { width: 100%; height: 100%; object-fit: cover; }
.ubp-shp-mname { font-size: 16px; font-weight: 800; }
.ubp-shp-mstat { margin-top: 4px; font-size: 11px; line-height: 1.6; color: var(--ubp-text-2); }
.ubp-shp-balcard { margin-bottom: 10px; padding: 12px; border: 1px solid var(--ubp-line); border-radius: 14px; background: var(--ubp-card); }
.ubp-shp-bt { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; font-size: 12px; font-weight: 700; color: var(--ubp-text-2); }
.ubp-shp-bt span:last-child { font-size: 10.5px; font-weight: 400; color: var(--ubp-text-3); }
.ubp-shp-bal { display: flex; align-items: center; gap: 9px; padding: 7px 0; border-bottom: 1px solid var(--ubp-line); }
.ubp-shp-bal:last-child { border-bottom: none; }
.ubp-shp-bal-ic { flex: none; width: 26px; height: 26px; border-radius: 8px; background: var(--ubp-card-2); color: var(--ubp-text-2); display: flex; align-items: center; justify-content: center; }
.ubp-shp-bal-ic svg { width: 15px; height: 15px; }
.ubp-shp-bal-n { flex: 1; font-size: 12.5px; font-weight: 600; }
.ubp-shp-bal-n em { margin-left: 5px; padding: 1px 5px; border-radius: 4px; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 9.5px; font-style: normal; font-weight: 700; }
.ubp-shp-bal-v { font-size: 13px; font-weight: 800; font-variant-numeric: tabular-nums; }
.ubp-shp-ocard { margin-bottom: 9px; padding: 11px; border: 1px solid var(--ubp-line); border-radius: 13px; background: var(--ubp-card); }
.ubp-shp-ohead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 11px; color: var(--ubp-text-3); }
.ubp-shp-ostatus { padding: 2px 9px; border-radius: 99px; font-size: 11px; font-weight: 700; }
.ubp-shp-ostatus.transit { background: var(--shp-acc-soft); color: var(--shp-acc); }
/* F75：类名对齐数据值（ShopOrderStatus = delivered/cancelled）——原 .done/.cancel 从未匹配
   渲染层输出的真实状态类，「已送达」的成功态配色从未生效；亮色色值沿用原定义，观感不变只让它生效。 */
.ubp-shp-ostatus.delivered { background: rgba(15, 157, 88, 0.12); color: #0F9D58; }
.ubp-shp-ostatus.cancelled { background: var(--ubp-card-3); color: var(--ubp-text-3); }
/* F75：订单送达行成功色（原为渲染层内联 #0F9D58——内联做不了暗色覆盖，收编成类） */
.ubp-shp-arrive-ok { color: #0F9D58; }
.ubp-shp-obody { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.ubp-shp-othumb { flex: none; width: 52px; height: 52px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 24px; overflow: hidden; }
.ubp-shp-othumb img { width: 100%; height: 100%; object-fit: cover; }
.ubp-shp-oact { display: flex; justify-content: flex-end; gap: 8px; margin-top: 9px; }
.ubp-shp-obtn { padding: 5px 12px; border: 1px solid var(--ubp-line); border-radius: 99px; color: var(--ubp-text-2); font-size: 11px; cursor: pointer; }
.ubp-shp-obtn.pri { border-color: var(--shp-acc); color: var(--shp-acc); font-weight: 700; }
.ubp-shp-favstrip { display: flex; gap: 9px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
.ubp-shp-favstrip::-webkit-scrollbar { display: none; }
.ubp-shp-fcard { flex: none; width: 104px; border: 1px solid var(--ubp-line); border-radius: 12px; background: var(--ubp-card); overflow: hidden; cursor: pointer; }
.ubp-shp-ft { height: 74px; display: flex; align-items: center; justify-content: center; font-size: 30px; overflow: hidden; }
.ubp-shp-ft img { width: 100%; height: 100%; object-fit: cover; }
.ubp-shp-fn { padding: 6px 8px 8px; font-size: 11px; font-weight: 600; line-height: 1.35; height: 44px; overflow: hidden; }
/* 订单进度（订单详情） */
.ubp-shp-steps { padding: 4px 0; }
.ubp-shp-step { display: flex; gap: 10px; font-size: 12.5px; }
.ubp-shp-stepdot { flex: none; width: 9px; height: 9px; margin-top: 4px; border-radius: 50%; background: var(--ubp-card-3); }
.ubp-shp-step.done .ubp-shp-stepdot { background: var(--shp-acc); }
.ubp-shp-stept { font-weight: 600; }
.ubp-shp-stepd { margin-top: 2px; font-size: 11px; line-height: 1.5; color: var(--ubp-text-3); }
.ubp-shp-stepline { width: 2px; height: 26px; margin: 4px 0 4px 3.5px; background: var(--ubp-line); }

/* ── 弹层（结算 / 支付成功 / 取消确认）── */
.ubp-shp-dim { position: absolute; inset: 0; z-index: 20; background: rgba(0, 0, 0, 0.42); display: flex; align-items: flex-end; }
.ubp-shp-sheet { width: 100%; max-height: 88%; overflow-y: auto; padding: 14px 14px 16px; border-radius: 18px 18px 0 0; background: var(--ubp-card); }
.ubp-shp-sheet.center { text-align: center; }
.ubp-shp-sheet-t { font-size: 15px; font-weight: 800; }
.ubp-shp-sheet-sub { margin: 4px 0 10px; font-size: 11.5px; color: var(--ubp-text-3); }
.ubp-shp-sline { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--ubp-line); font-size: 12.5px; text-align: left; }
.ubp-shp-sline:last-of-type { border-bottom: none; }
.ubp-shp-sline .k { color: var(--ubp-text-2); }
.ubp-shp-sline .v { font-weight: 700; text-align: right; word-break: break-word; }
.ubp-shp-sline .v.red { color: var(--ubp-danger); }
.ubp-shp-sline .v small { margin-left: 4px; color: var(--ubp-text-3); font-size: 11px; font-weight: 400; }
.ubp-shp-note { margin-top: 8px; font-size: 11px; line-height: 1.6; color: var(--ubp-text-3); }
.ubp-shp-note.red { color: var(--ubp-danger); }
.ubp-shp-okmark { width: 52px; height: 52px; margin: 2px auto 10px; border-radius: 50%; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 26px; display: flex; align-items: center; justify-content: center; }
/* 详情吸底条：三个小图标钮（消息 / 收藏 / 加购）+ 主按钮（docs/54 mockup ②） */
.ubp-shp-minibtn { flex: none; width: 46px; height: 44px; border: 1px solid var(--ubp-line); border-radius: 12px; background: var(--ubp-card); color: var(--ubp-text-2); font-family: var(--ubp-font); font-size: 9.5px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; cursor: pointer; padding: 0; }
.ubp-shp-minibtn svg { width: 15px; height: 15px; }
.ubp-shp-minibtn.pri { border-color: var(--shp-acc); background: var(--shp-acc-soft); color: var(--shp-acc); }
.ubp-shp-minibtn.on { border-color: rgba(255, 77, 106, 0.4); color: #FF4D6A; }
.ubp-shp-was { font-size: 13px; font-weight: 500; color: var(--ubp-text-3); text-decoration: line-through; }
.ubp-shp-save { padding: 2px 7px; border-radius: 99px; background: rgba(15, 157, 88, 0.1); color: #0F9D58; font-size: 10.5px; font-weight: 700; }

/* ══ 商城消息（商家沟通，docs/54）══
   版式逐条对齐 docs/54 mockup：会话列表 / 聊天页（气泡·红包卡·改价卡·商品卡）/ 输入区（咨询条·生成条·＋面板）
   / 评价区 / 收货地址卡 / 各类弹层行。配色全走 --ubp-* 与 --shp-* token（暗色与皮肤零额外规则）。 */
.ubp-shc-clist { flex: 1; overflow-y: auto; background: var(--ubp-card); }
.ubp-shc-crow { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-bottom: 1px solid var(--ubp-line); cursor: pointer; }
.ubp-shc-crow:active { background: var(--ubp-card-2); }
.ubp-shc-cava { flex: none; width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 800; color: #fff; }
.ubp-shc-cmain { flex: 1; min-width: 0; }
.ubp-shc-cline { display: flex; align-items: baseline; gap: 8px; }
.ubp-shc-cname { flex: 1; min-width: 0; font-size: 14.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-ctime { flex: none; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-shc-cprev { min-width: 0; margin-top: 3px; font-size: 12px; color: var(--ubp-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-tagx { display: inline-block; margin-right: 5px; padding: 1px 5px; border-radius: 5px; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 10px; font-weight: 700; vertical-align: 1px; }
.ubp-shc-tagx.rpx { background: rgba(226, 69, 60, 0.1); color: #E2453C; }
.ubp-shc-cbadge { flex: none; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 99px; background: var(--ubp-badge); color: #fff; font-size: 10.5px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.ubp-shc-cread { flex: none; width: 8px; height: 8px; margin: 0 5px; border-radius: 50%; background: var(--ubp-badge); }

/* ── 聊天页 ── */
.ubp-shc-msgs { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.ubp-shc-tdiv { margin: 4px 0 2px; text-align: center; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-shc-mrow { display: flex; align-items: flex-start; gap: 7px; }
.ubp-shc-mrow.me { justify-content: flex-end; }
.ubp-shc-mava { flex: none; width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; color: #fff; }
.ubp-shc-mcol { display: flex; flex-direction: column; max-width: 76%; min-width: 0; }
.ubp-shc-mrow.me .ubp-shc-mcol { align-items: flex-end; }
.ubp-shc-sname { margin: 0 3px 3px; font-size: 10px; color: var(--ubp-text-3); }
.ubp-shc-bubble { padding: 8px 11px; border-radius: 11px; font-size: 13.5px; line-height: 1.5; background: var(--ubp-bubble-other); color: var(--ubp-text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); white-space: pre-wrap; word-break: break-word; }
.ubp-shc-mrow.me .ubp-shc-bubble { background: var(--shc-me-bg); color: var(--shc-me-text); }
.ubp-shc-quote { display: block; margin-bottom: 5px; padding: 5px 8px; border-left: 2px solid var(--shp-acc); border-radius: 6px; background: var(--ubp-card-3); color: var(--ubp-text-2); font-size: 11px; line-height: 1.5; max-height: 46px; overflow: hidden; }
/* 图片消息（同微信：就绪=图 + 重新生成；pending/failed 各有态） */
.ubp-shc-imgmsg { width: 180px; padding: 3px; border-radius: 11px; background: var(--ubp-bubble-other); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); cursor: pointer; }
.ubp-shc-imgmsg img { display: block; width: 100%; max-height: 220px; border-radius: 8px; object-fit: cover; }
.ubp-shc-imgph { height: 118px; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; background: var(--ubp-card-3); color: var(--ubp-text-2); font-size: 11px; text-align: center; padding: 8px; }
.ubp-shc-imgph .ubp-spinner { width: 22px; height: 22px; }
.ubp-shc-imgph.failed { color: var(--ubp-danger); background: var(--ubp-danger-soft); }
/* 红包卡（微信同构：红金 + 祝福语 + 「開」钮） */
.ubp-shc-rp { position: relative; width: 238px; border-radius: 11px; overflow: hidden; background: linear-gradient(150deg, #F7634E, #E2453C); color: #FFF3E8; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }
.ubp-shc-rp .rt { display: flex; align-items: center; gap: 10px; padding: 11px 12px 12px; }
.ubp-shc-rp .rcoin { flex: none; width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(160deg, #FFD98A, #E8A33D); color: #8A4B12; font-size: 16px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.ubp-shc-rp .rmain { flex: 1; min-width: 0; padding-right: 34px; }
.ubp-shc-rp .rmsg { display: block; font-size: 12.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-rp .rmt { display: block; margin-top: 3px; font-size: 10.5px; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-rp .ropen { position: absolute; right: 0; top: 0; bottom: 0; width: 52px; border: none; background: rgba(0, 0, 0, 0.12); color: #FFE9C9; font-family: var(--ubp-font); font-size: 15px; font-weight: 800; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-shc-rp.claimed .rmain { padding-right: 0; }
.ubp-shc-rp.claimed .rmsg { opacity: 0.72; }
.ubp-shc-rp .rstamp { position: absolute; right: 8px; bottom: 7px; font-size: 9.5px; opacity: 0.75; }
/* 改价卡 / 商品卡（同一套卡壳） */
.ubp-shc-xcard { width: 236px; border-radius: 12px; overflow: hidden; background: var(--ubp-bubble-other); border: 1px solid var(--ubp-line); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06); cursor: pointer; }
.ubp-shc-xcard .xh { display: flex; align-items: center; gap: 8px; padding: 9px 10px; background: linear-gradient(135deg, var(--shp-acc-soft), rgba(255, 255, 255, 0)); }
.ubp-shc-xcard .xava { flex: none; width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 19px; overflow: hidden; }
.ubp-shc-xcard .xava img { width: 100%; height: 100%; object-fit: cover; }
.ubp-shc-xcard .xt { flex: 1; min-width: 0; }
.ubp-shc-xcard .xk { display: block; margin-bottom: 1px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.3px; color: var(--shp-acc); }
.ubp-shc-xcard .xn { display: block; font-size: 13px; font-weight: 700; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-xcard .xb { padding: 9px 10px 10px; }
.ubp-shc-xcard .xprice { display: flex; align-items: baseline; gap: 6px; color: var(--shp-price); font-size: 19px; font-weight: 800; }
.ubp-shc-xcard .xprice .was { font-size: 11.5px; font-weight: 500; color: var(--ubp-text-3); text-decoration: line-through; }
.ubp-shc-xcard .xprice small { font-size: 10.5px; font-weight: 600; color: var(--ubp-text-2); }
.ubp-shc-xcard .xnote { margin-top: 6px; font-size: 11.5px; line-height: 1.55; color: var(--ubp-text-2); }
.ubp-shc-xcard .xdesc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 5px; font-size: 11.5px; line-height: 1.55; color: var(--ubp-text-2); }
.ubp-shc-xcard .xfoot { margin-top: 8px; padding-top: 7px; border-top: 1px dashed var(--ubp-line); font-size: 10.5px; font-weight: 700; color: #0F9D58; }
.ubp-shc-xcard .xfoot.gray { font-weight: 500; color: var(--ubp-text-3); }
.ubp-shc-xcard.item .xh { background: linear-gradient(135deg, rgba(46, 139, 116, 0.12), rgba(255, 255, 255, 0)); }
.ubp-shc-xcard.item .xk { color: #2E8B74; }
/* F75：商城状态色暗色覆盖（修法同 F61 收藏彩标——暗底下提亮一档同系色；历史对照稿已清理）。覆盖面：
   已送达徽标 / 让价 pill / 「已同步到商城」卡脚 / 新品卡标题 / 红包预览标 / 订单送达行。 */
.ubp-dark .ubp-shp-ostatus.delivered { background: rgba(91, 214, 138, 0.16); color: #5BD68A; }
.ubp-dark .ubp-shp-save { background: rgba(91, 214, 138, 0.14); color: #5BD68A; }
.ubp-dark .ubp-shc-xcard .xfoot { color: #5BD68A; }
.ubp-dark .ubp-shc-xcard.item .xk { color: #66C7A8; }
.ubp-dark .ubp-shc-tagx.rpx { background: rgba(255, 122, 106, 0.14); color: #FF7A6A; }
.ubp-dark .ubp-shp-arrive-ok { color: #5BD68A; }
.ubp-shc-typing { display: flex; align-items: center; gap: 8px; padding-left: 39px; }
.ubp-shc-typing .dots { display: inline-flex; gap: 4px; align-items: center; padding: 9px 12px; border-radius: 11px; background: var(--ubp-bubble-other); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); }
.ubp-shc-typing .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--ubp-text-3); opacity: 0.5; animation: ubp-shc-blink 1.2s infinite; }
.ubp-shc-typing .dots i:nth-child(2) { animation-delay: 0.2s; }
.ubp-shc-typing .dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes ubp-shc-blink { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 0.85; } }
.ubp-shc-abort { padding: 3px 10px; border: 1px solid var(--ubp-danger-soft); border-radius: 99px; background: var(--ubp-danger-soft); color: var(--ubp-danger); font-family: var(--ubp-font); font-size: 11.5px; cursor: pointer; }
.ubp-shc-sysmsg { align-self: center; max-width: 88%; padding: 6px 10px; border-radius: 8px; background: var(--ubp-card-3); color: var(--ubp-text-2); font-size: 11.5px; line-height: 1.5; text-align: center; }
.ubp-shc-sysmsg.err { background: var(--ubp-danger-soft); color: var(--ubp-danger); cursor: pointer; }

/* ── 输入区（咨询条 / 生成条 / 输入栏 / ＋面板） ── */
.ubp-shc-inputzone { flex: none; background: var(--ubp-card); border-top: 1px solid var(--ubp-line); }
.ubp-shc-focusbar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--shp-acc-soft); border-bottom: 1px solid var(--ubp-line); }
.ubp-shc-focusbar .fic { flex: none; width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; font-size: 14px; overflow: hidden; }
.ubp-shc-focusbar .ft { flex: 1; min-width: 0; font-size: 11.5px; color: var(--ubp-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-focusbar .ft b { color: var(--ubp-text); }
.ubp-shc-focusbar .fx { flex: none; width: 20px; height: 20px; border: none; border-radius: 50%; background: var(--ubp-card-3); color: var(--ubp-text-3); font-size: 11px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-shc-pendbar { display: flex; align-items: center; gap: 6px; padding: 8px 12px 0; }
.ubp-shc-pendmain { flex: 1; height: 32px; border: 1px solid rgba(255, 106, 0, 0.28); border-radius: 9px; background: var(--shp-acc-soft); color: var(--shp-acc); font-family: var(--ubp-font); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; }
.ubp-shc-pendmore { flex: none; width: 32px; height: 32px; border: none; border-radius: 9px; background: var(--ubp-card-3); color: var(--ubp-text-2); font-size: 15px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-shc-quotebar { display: flex; align-items: center; gap: 8px; padding: 7px 12px 0; }
.ubp-shc-quotebar .qt { flex: 1; min-width: 0; font-size: 11px; color: var(--ubp-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-left: 2px solid var(--shp-acc); padding-left: 7px; }
.ubp-shc-quotebar .qx { flex: none; width: 20px; height: 20px; border: none; border-radius: 50%; background: var(--ubp-card-3); color: var(--ubp-text-3); font-size: 11px; cursor: pointer; }
.ubp-shc-inputrow { display: flex; align-items: center; gap: 8px; padding: 8px 12px 10px; }
.ubp-shc-plusbtn { flex: none; width: 30px; height: 30px; border: none; border-radius: 50%; background: var(--ubp-card-3); color: var(--ubp-text); font-family: var(--ubp-font); font-size: 17px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-shc-field { flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--ubp-line); border-radius: 9px; background: var(--ubp-card-2); color: var(--ubp-text); font-family: var(--ubp-font); font-size: 13px; outline: none; }
.ubp-shc-field::placeholder { color: var(--ubp-text-3); }
.ubp-shc-sendbtn { flex: none; height: 32px; padding: 0 14px; border: none; border-radius: 9px; background: var(--shp-acc); color: #fff; font-family: var(--ubp-font); font-size: 13px; font-weight: 700; cursor: pointer; }
.ubp-shc-sendbtn:disabled { background: var(--ubp-card-3); color: var(--ubp-text-3); }
.ubp-shc-pluspanel { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 12px; border-top: 1px solid var(--ubp-line); background: var(--ubp-card-2); }
.ubp-shc-pcell { display: flex; flex-direction: column; align-items: center; gap: 5px; border: none; background: none; color: var(--ubp-text-2); font-family: var(--ubp-font); font-size: 10.5px; cursor: pointer; }
.ubp-shc-pcell .pi { width: 48px; height: 48px; border: 1px solid var(--ubp-line); border-radius: 14px; background: var(--ubp-card); font-size: 21px; display: flex; align-items: center; justify-content: center; }
.ubp-shc-pcell .pi.rp { border: none; background: linear-gradient(150deg, #F7634E, #E2453C); color: #FFE9C9; font-weight: 800; }

/* ── 详情页评价区 ── */
.ubp-shc-myrev { padding: 10px; border: 1px solid var(--shp-acc-soft); border-radius: 12px; background: var(--shp-acc-soft); }
.ubp-shc-myrev .mrh { display: flex; align-items: center; gap: 8px; }
.ubp-shc-myrev .mrt { flex: 1; font-size: 11.5px; font-weight: 700; color: var(--shp-acc); }
.ubp-shc-myrev .mrtx { margin-top: 6px; font-size: 12.5px; line-height: 1.6; }
.ubp-shc-myrev .mrimgs { display: flex; gap: 6px; margin-top: 7px; }
.ubp-shc-myrev .mrimgs span { width: 52px; height: 52px; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 22px; }
.ubp-shc-myrev .mrimgs img { width: 100%; height: 100%; object-fit: cover; }
.ubp-shc-myrev .mrf { display: flex; justify-content: space-between; margin-top: 7px; font-size: 10.5px; color: var(--ubp-text-3); }
.ubp-shc-myrev .mrf b { color: var(--shp-acc); cursor: pointer; }
.ubp-shc-stars { color: #FFB300; font-size: 14px; letter-spacing: 1px; line-height: 1; }
.ubp-shc-writebtn { display: flex; align-items: center; justify-content: center; height: 34px; margin-top: 8px; border: 1px solid var(--shp-acc); border-radius: 10px; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 12.5px; font-weight: 700; cursor: pointer; }
.ubp-shc-review { display: flex; gap: 8px; padding: 8px 0; border-top: 1px dashed var(--ubp-line); }
.ubp-shc-review:first-child { border-top: none; }
.ubp-shc-rva { flex: none; width: 26px; height: 26px; border-radius: 50%; background: var(--ubp-card-3); color: var(--ubp-text-2); font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.ubp-shc-rvn { display: block; font-size: 11.5px; font-weight: 700; }
.ubp-shc-rvt { display: block; margin-top: 2px; font-size: 11.5px; line-height: 1.6; color: var(--ubp-text-2); }

/* ── 收货地址卡（我的页） ── */
.ubp-shc-adrcard { margin-bottom: 10px; padding: 12px; border: 1px solid var(--ubp-line); border-radius: 14px; background: var(--ubp-card); }
.ubp-shc-adrcard .ah { display: flex; align-items: center; gap: 8px; }
.ubp-shc-adrcard .ah b { flex: 1; font-size: 12px; font-weight: 700; color: var(--ubp-text-2); }
.ubp-shc-adrcard .ah span { font-size: 11.5px; font-weight: 700; color: var(--shp-acc); cursor: pointer; }
.ubp-shc-adrcard .an { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 13.5px; font-weight: 700; }
.ubp-shc-adrcard .an em { padding: 1px 6px; border-radius: 5px; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 10px; font-style: normal; font-weight: 700; }
.ubp-shc-adrcard .ad { margin-top: 4px; font-size: 12px; line-height: 1.6; color: var(--ubp-text-2); }
.ubp-shc-adrcard .ae { margin-top: 8px; font-size: 12.5px; color: var(--ubp-text-3); }

/* ── 弹层行（结算收货行 / 地址选择 / 地址编辑 / 发红包 / 写评价 / 地点清单） ── */
.ubp-shc-adrrow { display: flex; align-items: center; gap: 9px; margin: 2px 0 8px; padding: 9px 10px; border: 1px solid var(--ubp-line); border-radius: 11px; background: var(--ubp-card-2); }
.ubp-shc-adrrow.none { border-color: rgba(230, 67, 64, 0.36); background: var(--ubp-danger-soft); }
.ubp-shc-adrrow .ai { flex: none; width: 26px; height: 26px; border-radius: 8px; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 13px; display: flex; align-items: center; justify-content: center; }
.ubp-shc-adrrow.none .ai { background: var(--ubp-danger-soft); color: var(--ubp-danger); }
.ubp-shc-adrrow .at { flex: 1; min-width: 0; }
.ubp-shc-adrrow .an { display: block; font-size: 12.5px; font-weight: 700; }
.ubp-shc-adrrow .ad { display: block; margin-top: 2px; font-size: 11px; color: var(--ubp-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-adrrow .ax { flex: none; border: none; background: none; color: var(--shp-acc); font-family: var(--ubp-font); font-size: 11.5px; font-weight: 700; cursor: pointer; }
.ubp-shc-pickrow { display: flex; align-items: center; gap: 9px; padding: 10px 2px; border-bottom: 1px solid var(--ubp-line); cursor: pointer; }
.ubp-shc-pickrow:last-of-type { border-bottom: none; }
.ubp-shc-pickrow .pk { flex: none; width: 18px; height: 18px; border: 1.5px solid var(--ubp-text-3); border-radius: 50%; color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; }
.ubp-shc-pickrow .pk.on { border-color: var(--shp-acc); background: var(--shp-acc); }
.ubp-shc-pickrow .pt { flex: 1; min-width: 0; }
.ubp-shc-pickrow .pn { display: block; font-size: 13px; font-weight: 700; }
.ubp-shc-pickrow .pd { display: block; margin-top: 2px; font-size: 11px; color: var(--ubp-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-pickrow .pdef { flex: none; padding: 1px 6px; border-radius: 5px; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 10px; font-weight: 700; }
.ubp-shc-sline { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 5px 0; font-size: 12.5px; }
.ubp-shc-sline .k { min-width: 0; color: var(--ubp-text-2); }
.ubp-shc-sline .v { font-weight: 700; text-align: right; white-space: nowrap; }
.ubp-shc-sline .v small { margin-left: 4px; font-size: 10.5px; font-weight: 600; color: var(--ubp-text-2); }
.ubp-shc-sline .v.red { color: var(--ubp-danger); }
.ubp-shc-fld { margin-top: 8px; }
.ubp-shc-fld label { display: block; margin-bottom: 4px; font-size: 11px; color: var(--ubp-text-3); }
.ubp-shc-fld .inp, .ubp-shc-fld textarea { width: 100%; border: 1px solid var(--ubp-line); border-radius: 10px; background: var(--ubp-card-2); color: var(--ubp-text); font-family: var(--ubp-font); font-size: 12.5px; }
.ubp-shc-fld .inp { height: 36px; padding: 0 10px; display: flex; align-items: center; }
.ubp-shc-fld input.inp { outline: none; }
.ubp-shc-fld textarea { height: 66px; padding: 9px 10px; resize: none; outline: none; }
.ubp-shc-starpick { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 0 2px; }
.ubp-shc-starpick .st { border: none; background: none; color: #D8D8DC; font-size: 30px; line-height: 1; cursor: pointer; padding: 0 2px; }
.ubp-shc-starpick .st.on { color: #FFB300; }
.ubp-shc-starpick .lb { margin-left: 8px; font-size: 12px; color: var(--ubp-text-2); }
.ubp-shc-imgadd { display: flex; gap: 8px; margin-top: 9px; }
.ubp-shc-imgadd .cell { position: relative; width: 56px; height: 56px; border-radius: 9px; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 20px; cursor: pointer; }
.ubp-shc-imgadd .cell img { width: 100%; height: 100%; object-fit: cover; }
.ubp-shc-imgadd .del { position: absolute; top: 1px; right: 1px; width: 16px; height: 16px; border: none; border-radius: 50%; background: rgba(0, 0, 0, 0.5); color: #fff; font-size: 10px; line-height: 1; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.ubp-shc-imgadd .add { border: 1px dashed var(--ubp-text-3); background: transparent; color: var(--ubp-text-3); font-size: 22px; }
.ubp-shc-locrow { display: flex; align-items: flex-start; gap: 9px; padding: 10px 2px; border-bottom: 1px solid var(--ubp-line); cursor: pointer; }
.ubp-shc-locrow:last-of-type { border-bottom: none; }
.ubp-shc-locrow .lp { flex: none; width: 28px; height: 28px; border-radius: 8px; background: var(--shp-acc-soft); color: var(--shp-acc); font-size: 13px; display: flex; align-items: center; justify-content: center; }
.ubp-shc-locrow .ln { display: block; font-size: 12.5px; font-weight: 700; }
.ubp-shc-locrow .ls { display: block; margin-top: 2px; font-size: 10.5px; color: var(--ubp-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-shc-locrow .lf { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 3px; font-size: 10.5px; color: var(--ubp-text-2); }
.ubp-shc-hintbar { margin: 8px 12px 0; padding: 7px 10px; border-radius: 10px; background: var(--ubp-card-3); color: var(--ubp-text-2); font-size: 11px; line-height: 1.6; }

/* ── 美化工坊（皮肤可视化编辑器，renderers/skin-studio.ts；ubp-sks-*）──
   复用设置页的 .ubp-set-sec/.ubp-fieldrow/.ubp-select/.ubp-chips 组件族（同 Shadow Root 全局类）。 */
.ubp-sks-sheet { z-index: 52; }
.ubp-sks-panel {
  max-width: 360px; height: 96%; max-height: none; padding: 11px 12px 10px;
  display: flex; flex-direction: column; overflow: hidden;
}
.ubp-sks-head { flex: none; display: flex; align-items: center; gap: 6px; }
.ubp-sks-title { flex: none; font-size: 15px; font-weight: 600; text-align: center; }
.ubp-sks-name {
  flex: 1; min-width: 0; height: 30px; border: 1px solid var(--ubp-line); border-radius: 8px;
  background: var(--ubp-card-2); color: var(--ubp-text); font-family: inherit; font-size: 13px;
  padding: 0 8px; text-align: center;
}
.ubp-sks-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 1px 8px; }
.ubp-sks-sub { font-size: 11.5px; color: var(--ubp-text-3); margin: 10px 0 2px; }
/* 色板 chips（预设 + 随机） */
.ubp-sks-palettes { display: flex; flex-wrap: wrap; gap: 8px; }
.ubp-sks-pal {
  display: flex; align-items: center; gap: 5px; height: 32px; padding: 0 10px; border-radius: 16px;
  border: 1px solid var(--ubp-line); background: var(--ubp-card-2); cursor: pointer;
  font-family: inherit; font-size: 12px; color: var(--ubp-text);
}
.ubp-sks-pal:active { filter: brightness(0.95); }
.ubp-sks-pal i { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex: none; }
/* token 编辑行：标签 + [亮档色块+文本] + [暗档色块+文本] + 清除 */
.ubp-sks-tokrow { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
.ubp-sks-toklabel { flex: 1; min-width: 0; font-size: 12px; color: var(--ubp-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-sks-cin {
  width: 28px; height: 26px; flex: none; border: 1px solid var(--ubp-line); border-radius: 6px;
  background: var(--ubp-card-2); padding: 1px 2px; cursor: pointer;
}
.ubp-sks-tin {
  width: 84px; flex: none; height: 26px; border: 1px solid var(--ubp-line); border-radius: 6px;
  background: var(--ubp-card-2); color: var(--ubp-text); font-family: inherit; font-size: 11px;
  padding: 0 6px;
}
.ubp-sks-x { flex: none; width: 22px; height: 22px; border: none; border-radius: 6px; background: transparent; color: var(--ubp-text-3); font-size: 13px; cursor: pointer; }
.ubp-sks-x:active { background: var(--ubp-card-3); }
/* 滑杆行 */
.ubp-sks-slider { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.ubp-sks-slider input[type="range"] { flex: 1; }
.ubp-sks-slider b { flex: none; width: 42px; text-align: right; font-size: 11.5px; color: var(--ubp-text-2); font-weight: 400; }
/* App 图标磁贴网格（预览复用 .ubp-appnode/.ubp-appicon 渲染链） */
.ubp-sks-apps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 6px; margin-top: 4px; }
.ubp-sks-app { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; position: relative; }
.ubp-sks-app .ubp-appname { max-width: 100%; }
.ubp-sks-app .tag { position: absolute; top: -3px; right: 8%; width: 8px; height: 8px; border-radius: 4px; background: var(--ubp-accent); }
/* 图标编辑弹层（叠在工坊之上） */
.ubp-sks-iedit { z-index: 54; }
.ubp-sks-iepanel { max-width: 340px; }
.ubp-sks-ieprev { display: flex; align-items: center; justify-content: center; padding: 12px 0 8px; }
.ubp-sks-ieprev .ubp-appicon { width: 68px; height: 68px; }
/* 用户字体行 */
.ubp-sks-fontrow { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--ubp-line); }
.ubp-sks-fontrow:last-child { border-bottom: none; }
.ubp-sks-fontprev { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-sks-mini {
  flex: none; height: 26px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--ubp-line);
  background: var(--ubp-card-2); color: var(--ubp-text); font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.ubp-sks-mini:active { filter: brightness(0.94); }
/* 标签/提示小字（VI-04：字号一律走 token，渲染器不写内联 font-size） */
.ubp-sks-lab { flex: none; width: 66px; font-size: var(--fs-13); color: var(--ubp-text-2); }
.ubp-sks-lab.sm { width: 44px; }
.ubp-sks-hint { flex: 1; min-width: 0; font-size: var(--fs-11); color: var(--ubp-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ubp-sks-chk { display: flex; align-items: center; gap: 4px; font-size: var(--fs-11); color: var(--ubp-text-2); }
`;

// ── 整体字号缩放（设置→通用「字体」；分档缩放，--ubp-font-scale 挂 .ubp-scope 行内） ──
// VI-01：模块加载时一次性把全部 px 字号**就近归并到 7 档 token**（--fs-10/11/13/15/17/22/28），
// 归并后的 token 自带 calc(--ubp-font-scale)：缩放只作用于文字，图标/头像/布局尺寸不动。
// 壳层专属大字号（>28px，如桌面时钟 44px）不参与归并，仍走原 calc 包裹。
// CSS 层稳态零开销：变换只发生在注入前这一次，选择器数与匹配行为不变。
export const PHONE_FS_TIERS = [10, 11, 13, 15, 17, 22, 28] as const;
/** 归并豁免下界：≥ 此值的 px 字号视为壳层专属展示号（时钟/数字大屏），不并入 7 档。 */
export const PHONE_FS_EXEMPT_MIN = 29;

/** 就近归并到 7 档；等距取大档（正文主档因此从 11–14 提到 13–15，贴近真实 App 一档）。 */
export function snapFontTier(px: number): number {
  let best: number = PHONE_FS_TIERS[0];
  let bestDist = Infinity;
  for (const t of PHONE_FS_TIERS) {
    const d = Math.abs(px - t);
    if (d <= bestDist) { best = t; bestDist = d; }
  }
  return best;
}

export const PHONE_CSS = PHONE_CSS_RAW.replace(
  /\bfont-size:\s*(\d+(?:\.\d+)?)px\b/g,
  (_m, n: string) => (Number(n) >= PHONE_FS_EXEMPT_MIN
    ? `font-size: calc(${n}px * var(--ubp-font-scale, 1))`
    : `font-size: var(--fs-${snapFontTier(Number(n))})`),
);

/** 皮肤「桌面时刻居中」布局变体（home.layout='center'；.THEME 占位符由调用方替换为皮肤作用域选择器，
 *  内置 sweet 皮肤的同款规则已字面写入上方皮肤段，此模板供自定义皮肤 CSS 生成复用）。 */
export const SKIN_HOME_CENTER_CSS = `
.THEME .ubp-home-top { flex-direction: column; align-items: center; text-align: center; gap: 4px; padding: 26px 2px 8px; }
.THEME .ubp-home-datetime { display: flex; flex-direction: column; align-items: center; }
.THEME .ubp-home-ctx { max-width: 100%; text-align: center; }
.THEME .ubp-home-wmain { justify-content: center; }
.THEME .ubp-home-loc { justify-content: center; }
`;

/** 设置→通用「字体」可选字体族（系统字体栈零下载，跨 Win/mac 回退兜底；''=跟随风格不设变量）。 */
export const PHONE_FONT_FAMILIES: Readonly<Record<string, { label: string; stack: string }>> = {
  song: { label: '宋体', stack: '"Songti SC", SimSun, "Noto Serif SC", serif' },
  hei: { label: '黑体', stack: '"Heiti SC", SimHei, "Noto Sans SC", "Microsoft YaHei", sans-serif' },
  kai: { label: '楷体', stack: '"Kaiti SC", STKaiti, KaiTi, "DFKai-SB", serif' },
  yuan: { label: '圆体', stack: '"Yuanti SC", YouYuan, "Microsoft YaHei", sans-serif' },
};
