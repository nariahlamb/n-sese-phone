// ===== 通知横幅显示策略（纯函数，可单测）=====
// 分工（见 renderers/app-registry 的 emitPhoneNotify 注释）：
//   · **发射侧**决定"这条值不值得通知"（自己发的 / 系统消息 / 正在看这个会话 → 不发射）；
//   · **本模块**决定"现在能不能显示"——只依赖壳层看得见的全局态，App 私有态不参与。
// 为什么不把"正在看这个会话"也放进来：`_chatId/_view` 是微信 App 的私有态，壳层取不到；
// 强行让壳层去问会引入反向依赖（壳层不得 import 各 App，见 MEMORY §六.2）。故该项留在发射侧。

export interface BannerGate {
  /** 手机是否展开（折叠/收起到悬浮球＝不打扰；用户定案：只在展开态生效）。 */
  phoneOpen: boolean;
  /** 是否处于锁屏态（锁屏上已有通知卡，横幅会与之重复）。 */
  locked: boolean;
  /** 通知中心是否打开（同一件事不在两处同时呈现）。 */
  ncOpen: boolean;
}

/** 现在能否弹通知横幅。 */
export function shouldShowBanner(gate: BannerGate): boolean {
  return gate.phoneOpen === true && gate.locked !== true && gate.ncOpen !== true;
}

/** 同一条横幅内多次到达的合并窗口：距上次展示超过该时长就当作新的一条从头计时。 */
export const BANNER_MERGE_MS = 6000;

/** 横幅自动收起时长（真机观感：看一眼就够）。 */
export const BANNER_VISIBLE_MS = 4200;

/** 提示音合并窗口：一批消息逐条到达时不要连珠炮（一次提示音/600ms）。 */
export const MESSAGE_SOUND_GAP_MS = 600;
