// ===== 社媒三 App 共享外壳：底部 Tab 栏 + 消息页（通知流 + 待回应折叠区）+ 我的页（我的内容/删除） =====
// 布局对照 docs/social-three-apps-mockup.html 的 tb-foot/wb-foot/xhs-foot：
// 品牌顶栏与分段由各 App 自拼（差异大），本模块只提供三 App 完全一致的骨架件，
// 主题色从各 App 根 class（ubp-tb/ubp-wb/ubp-xhs）的 --sacc 变量取。

import { getSocialNotifications, markAllNotificationsRead, markNotificationsReadForPost, openSocialNotification, requestSocialFeedback, type SocialFollowScope } from '../core/social-engine';
import { readSocialOf, socialExcerpt, ANON_DEFAULT_NAME, ANON_NAME_MAX, type SocialData, type SocialKind, type SocialNotification, type SocialUserAction } from '../core/social-model';
import { socialNotifyVerb, socialTargetNoun } from '../core/social-notify-text';
import { actionTimeText, postTimeText } from '../core/social-time';
import { readPhoneData } from '../core/phone-store';
import { getRoster } from '../core/roster';
import { momentsSkinProfile, S, currentStyle, tiebaSkinProfile } from '../core/skins';
import { emitPhoneEvent } from './app-registry';
import { openOneShotHintSheet } from './hint-sheet';
import { avatarHtml, escapeAttr, escapeHtml, showScreenToast } from './phone-ui';
import { ubpIcon } from './icons';

// ─── 已读动作统一收口（三 App 消息页共用）───
// core 不 import renderers，所以「写库后派发 data-changed」只能由 App 层做；三处已读入口各写一遍易漏，
// 收在这里一份：悬浮球红点与桌面磁贴角标才会在 App 内点开通知的瞬间跟随（MEMORY 铁律「清与清完要派发成对」）。

/** 点消息页某条通知 → 该帖通知全部已读，返回帖子 id（跳详情用）。 */
export function readNotification(kind: SocialKind, notificationId: string): string | null {
  const postId = openSocialNotification(kind, notificationId);
  emitPhoneEvent('ubp-phone:data-changed');
  return postId;
}

/** 打开帖子详情时的顺带已读（任何入口进详情都该清该帖未读）。 */
export function readPost(kind: SocialKind, postId: string): void {
  markNotificationsReadForPost(kind, postId);
  emitPhoneEvent('ubp-phone:data-changed');
}

/** 消息页「全部已读」。 */
export function readAllNotifications(kind: SocialKind): void {
  markAllNotificationsRead(kind);
  emitPhoneEvent('ubp-phone:data-changed');
}

export interface SocialTabDef {
  id: string;
  label: string;
  icon: string;
  /** 未读数徽标（>0 显示，99+ 截断；消息 tab 用）。 */
  badge?: number;
}

export interface SocialShellArgs {
  /** 应用根 class（ubp-tb/ubp-wb/ubp-xhs——决定 --sacc 主题色）。 */
  appClass: string;
  /** 顶栏 HTML（品牌顶栏+分段，各 App 自拼；详情页传导航栏）。 */
  topHtml: string;
  /** 内容体 HTML（错误/加载/列表）。 */
  bodyInner: string;
  /** 底部 Tab（顺序渲染；点击派发 data-ubp-act="nav" + data-id=tabId）。 */
  tabs: SocialTabDef[];
  activeTab: string;
  /** 底部中间凸起发布按钮（点击派发 data-ubp-act=composeAct）。 */
  composeAct: string;
  /** 详情页等无底栏视图传 false。 */
  showTabbar?: boolean;
  /** 浮层附加 HTML（toast/composer，App 自拼）。 */
  extraHtml?: string;
}

/** 三 App 共用骨架：顶栏 + 滚动体 + 底部 Tab 栏（+ 凸起发布按钮）。 */
export function renderSocialShell(args: SocialShellArgs): string {
  const tabbar = args.showTabbar === false ? '' : `<div class="ubp-sfoot">
    ${args.tabs.slice(0, 2).map(t => socialTab(t, args.activeTab)).join('')}
    <button type="button" class="ubp-sfoot-tab plus" data-ubp-act="${escapeAttr(args.composeAct)}" title="发布"><span class="ico">${ubpIcon('plus')}</span></button>
    ${args.tabs.slice(2).map(t => socialTab(t, args.activeTab)).join('')}
  </div>`;
  return `<div class="${escapeAttr(args.appClass)}">
    ${args.topHtml}
    <div class="ubp-appbody">${args.bodyInner}</div>
    ${tabbar}
    ${args.extraHtml || ''}
  </div>`;
}

function socialTab(t: SocialTabDef, active: string): string {
  const badge = t.badge && t.badge > 0 ? `<i class="ubp-sfoot-badge">${t.badge > 99 ? '99+' : t.badge}</i>` : '';
  return `<button type="button" class="ubp-sfoot-tab${t.id === active ? ' on' : ''}" data-ubp-act="nav" data-id="${escapeAttr(t.id)}">
    ${badge}<span class="ico">${t.icon}</span>${escapeHtml(t.label)}
  </button>`;
}

// ─── 信息流触底加载（朋友圈也复用；分页切片本体在 core/social-model paginateFeed） ───

/** 触底加载提示行（还有更多时挂列表尾部；滚到底自动加载，无需点击）。 */
export function feedMoreHtml(remaining: number): string {
  return `<div class="ubp-feed-more">${S('还有', '尚余')} ${remaining} ${S('条', '条')}</div>`;
}

/**
 * 匿名发布行（四社媒 App 的发帖/评论面板共用唯一实现）：chip 开关 + 开启后展开的网名输入框。
 * chip 用既有点亮态样式（.ubp-chip.on），输入框走既有 .ubp-fieldinput —— 零新增 CSS。
 */
export function anonRowHtml(anon: boolean, anonName: string): string {
  return `<div class="ubp-chips"><button type="button" class="ubp-chip${anon ? ' on' : ''}" data-ubp-act="compose-anon">匿名发布</button></div>
    ${anon ? `<input class="ubp-fieldinput" data-ubp-input="compose-anonname" maxlength="${ANON_NAME_MAX}" placeholder="匿名用户名（默认「${ANON_DEFAULT_NAME}」）" value="${escapeAttr(anonName)}">` : ''}`;
}

// ─── 信息流共享件（四社媒 App 原本逐字节相同的副本，收敛为唯一实现） ───
// 起因：doFeedback / openFeedbackHint / openRefreshHint / loadMoreFeed / toast / countLabel
// 在 app-weibo|xhs|tieba|moments 中各有一份逐字节相同的实现，且已出现复制粘贴漂移
// （moments 的 _lastAttempt 连续赋值两次、tieba 的 `focusBar,hint` 丢空格）。
// 依赖注入先例：状态栏 initFloatingChrome / wardrobe-orchestration（各 App 模块态经闭包注入）。

/** 信息流共享件依赖（各 App 注入自身模块态；全部为取值/回调，kit 不持有 App 状态）。 */
export interface SocialFeedKitDeps {
  /** 各 App 的 _ctx?.container（渲染宿主；兼作「是否已挂载」判定）。 */
  container: () => HTMLElement | null;
  /** 各 App 的 _busy（刷新生成中）。 */
  isBusy: () => boolean;
  /** isFeedbackGenerating()（互动反馈生成中）。 */
  isFeedbackBusy: () => boolean;
  setError: (msg: string) => void;
  /** 记下本次求回应参数（重试钮重放用）。 */
  rememberFeedbackAttempt: (hint: string, picked: string[]) => void;
  /** 写入各 App 的 _toast（渲染模板仍读各 App 自己的 _toast）。 */
  render: () => void;
  /** 触底/自动扩页：各 App 自己推进分页游标（_feedVisible += FEED_PAGE_SIZE）。 */
  onLoadMore: () => void;
  /** 长按「刷新」确认后的回落（各 App 焦点参数不同：weibo=话题 / tieba=吧 / 其余无）。 */
  onRefreshConfirm: (hint: string, picked: string[]) => void;
}

export interface SocialFeedKit {
  toast: (text: string) => void;
  countLabel: (n: number) => string;
  openRefreshHint: () => void;
  openFeedbackHint: () => void;
  doFeedback: (hint?: string, picked?: string[]) => Promise<void>;
  loadMoreFeed: () => void;
}

/** 建一个 App 的信息流共享件（各 App 模块顶层建一次，解构取用同名函数 → 调用点零改动）。 */
export function createSocialFeedKit(deps: SocialFeedKitDeps): SocialFeedKit {
  // IA-05：toast 统一走壳层唯一实现（挂 .ubp-toastlayer，App 重绘不冲掉；不再为提示跑整页 render）
  function toast(text: string): void {
    const container = deps.container();
    if (container) showScreenToast(container, text);
  }

  function countLabel(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
    return String(n);
  }

  /** 长按「刷新」→ 本次刷新提示弹层（一次性，不落盘）。 */
  function openRefreshHint(): void {
    const container = deps.container();
    if (!container || deps.isBusy()) return;
    openOneShotHintSheet(container, {
      title: '本次刷新提示',
      confirmLabel: '刷新',
      contacts: getRoster().contacts.map(c => c.name),
      onConfirm: (hint, picked) => { deps.onRefreshConfirm(hint, picked); },
    });
  }

  /** 长按「求回应」→ 本次回应提示弹层。 */
  function openFeedbackHint(): void {
    const container = deps.container();
    if (!container || deps.isBusy() || deps.isFeedbackBusy()) return;
    openOneShotHintSheet(container, {
      title: '本次回应提示',
      confirmLabel: '生成回应',
      contacts: getRoster().contacts.map(c => c.name),
      onConfirm: (hint, picked) => { void doFeedback(hint, picked); },
    });
  }

  /**
   * 顶栏「求回应」：跨平台一次请求，生成角色对主角动作的回应（增量协议）。
   * 时序契约（勿改）：先起请求再 render——请求启动的同步段内 _feedbackBusy 置位，加载条本帧即现；
   * 直接 await 会让加载条晚一帧（历史 bug，tests/phone-feedback-busy.test.ts 锁）。
   */
  async function doFeedback(hint?: string, picked?: string[]): Promise<void> {
    if (deps.isFeedbackBusy() || deps.isBusy()) return;
    deps.setError('');
    deps.rememberFeedbackAttempt(hint || '', picked || []);
    try {
      // 先起请求再渲染：_feedbackBusy 在其同步段置位，加载条本帧即现
      const pending = requestSocialFeedback({ ...(hint ? { extraHint: hint } : {}), ...(picked && picked.length ? { focusNames: picked } : {}) });
      deps.render();
      const { applied } = await pending;
      emitPhoneEvent('ubp-phone:data-changed');
      toast(`回应已生成（${applied} 条）`);
    } catch (e) {
      deps.setError(e instanceof Error ? e.message : String(e));
    } finally {
      deps.render();
    }
  }

  /** 触底/自动扩页：多渲染一页更早内容（滚动位置由 render 保全）。 */
  function loadMoreFeed(): void {
    if (!deps.container()) return;
    deps.onLoadMore();
    deps.render();
  }

  return { toast, countLabel, openRefreshHint, openFeedbackHint, doFeedback, loadMoreFeed };
}

/** 重绘保位填回的滚动位置（滚动体 → 位置）。各 App 的 render 在 `body.scrollTop = target` 之后
 *  调 markFeedScrollRestore(body)：浏览器会为这次程序性滚动在**渲染帧补派一条 scroll**
 *  （保位语义见 claude_memory/rerender-scroll-preservation），而列表重建时位置本就贴底——
 *  误当成「用户触底」会白扩一页。WeakMap 自动随元素回收，不留引用。 */
const _feedRestoreTop = new WeakMap<HTMLElement, number>();

/** 记下「这次是 render 保位填回的位置」（在 body.scrollTop = target 之后调用）。 */
export function markFeedScrollRestore(body: HTMLElement | null): void {
  if (body) _feedRestoreTop.set(body, body.scrollTop);
}

/**
 * 信息流触底监听（scroll 不冒泡 → capture 委托在 App 容器上，列表重渲染无需重绑；
 * mount 绑定 / unmount 成对移除；canMore=false 时零开销短路）。
 */
export function bindFeedScroll(container: HTMLElement, canMore: () => boolean, onMore: () => void): () => void {
  const onScroll = (e: Event) => {
    const body = e.target as HTMLElement | null;
    if (!body || !body.classList || !body.classList.contains('ubp-appbody')) return;
    // 保位回声（位置还是 render 填回的那个值）不是用户滚动：不参与触底判定
    const restored = _feedRestoreTop.get(body);
    if (restored !== undefined && Math.abs(body.scrollTop - restored) <= 1) return;
    if (!canMore()) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 96) onMore();
  };
  container.addEventListener('scroll', onScroll, true);
  return () => container.removeEventListener('scroll', onScroll, true);
}

// ─── 消息页（通知流：与我相关互动 + 关注对象新帖；顶部保留待回应折叠区） ───

const ACTION_VERBS: Record<SocialUserAction['type'], [string, string, string, string]> = {
  post: ['发布了', '投帖了', '投帖了', '投帖了'],
  like: ['点赞了', '喝彩了', '叫好了', '喝彩了'],
  comment: ['评论了', '议论了', '搭话了', '应和了'],
  reply: ['回复了', '回话了', '回话了', '回话了'],
  repost: ['转发了', '传抄了', '转述了', '传唱了'],
};

const actionVerb = (type: SocialUserAction['type']): string => S(...(ACTION_VERBS[type] || ['互动了', '有所互动', '有所动静', '有所动静']));

/** 平台内容名词 / 通知动词的唯一事实源在 core/social-notify-text（消息页与通知中心共用一份口径）。 */

const targetNoun = socialTargetNoun;

/** 动作一行（谁->在哪->做了什么->内容摘要）。 */
function actionRow(a: SocialUserAction): string {
  const noun = targetNoun(a.target);
  const verb = actionVerb(a.type);
  const target = a.type === 'post' ? `我的${noun}` : `${a.author} 的${noun}`;
  return `<div class="ubp-smsg-row">
    ${avatarHtml(a.type === 'post' ? getRoster().protagonistName : a.author, '', true)}
    <div class="ubp-smsg-main">
      <div class="ubp-smsg-title"><b>${escapeHtml(a.type === 'post' ? '我' : a.author)}</b>${escapeHtml(verb)}${escapeHtml(target)}</div>
      <div class="ubp-smsg-text">${escapeHtml(a.content ? socialExcerpt(a.content, 40) : '等对方回应')}</div>
      <div class="ubp-smsg-time">${escapeHtml(actionTimeText(a, getRoster().global.time))}</div>
    </div>
  </div>`;
}

/** 通知一行（谁->做了什么->内容摘要；未读带圆点，点击跳详情并标已读）。 */
function notifyRow(n: SocialNotification, now: string): string {
  const verb = socialNotifyVerb(n.kind, n.type);
  return `<div class="ubp-smsg-row${n.read ? '' : ' unread'}" data-ubp-act="open-notify" data-id="${escapeAttr(n.id)}">
    ${avatarHtml(n.author, '', true)}
    <div class="ubp-smsg-main">
      <div class="ubp-smsg-title"><b>${escapeHtml(n.author)}</b>${escapeHtml(verb)}</div>
      <div class="ubp-smsg-text">${escapeHtml(n.content || '…')}</div>
      <div class="ubp-smsg-time">${escapeHtml(actionTimeText(n, now))}</div>
    </div>
    ${n.read ? '' : '<i class="ubp-smsg-dot"></i>'}
  </div>`;
}

/**
 * 消息 tab 内容：本平台通知流（未读高亮 + 全部已读钮）+ 顶部「我的互动」待回应折叠区。
 * actions=帧级已读的待回应清单；social=帧级已取的社媒快照（两者都由调用方传入，内部不再重复读库）。
 */
export function renderSocialMessages(kind: SocialKind, actions: SocialUserAction[], social?: SocialData | null): string {
  const roster = getRoster();
  const notifications = getSocialNotifications(kind, social);
  const unread = notifications.filter(n => !n.read).length;
  const pendHtml = actions.length ? `<details class="ubp-smsg-pend">
    <summary>${S('我的互动', '我的动静')} · ${actions.length} ${S('条待回应', '则待回应')}</summary>
    ${actions.map(actionRow).join('')}
  </details>` : '';
  const hdHtml = `<div class="ubp-smsg-hd">${S('新消息', '新知会', '新知会', '新知会')} · ${unread ? `${unread} ${S('条未读', '则未读')}` : S('没有未读', '并无未读')}${unread ? `<button type="button" class="ubp-smsg-markall" data-ubp-act="mark-all-read">${S('全部已读', '尽皆已阅')}</button>` : ''}</div>`;
  const listHtml = notifications.length
    ? notifications.map(n => notifyRow(n, roster.global.time)).join('')
    : `<div class="ubp-empty"><b>${S('暂无新消息', '暂无新知会', '暂无新知会', '暂无新知会')}</b><br>${S('关注的人/吧有新内容，或互动有了回应，会出现在这里', '结交之人有新帖，或动静有了回应，会出现在这里', '结识之人有新帖，或动静有了回应，会出现在这里', '结识之人有新帖，或动静有了回应，会出现在这里')}</div>`;
  return `<div class="ubp-smsg">${pendHtml}${hdHtml}${listHtml}</div>`;
}

// ─── 我的页（我发的内容 + 二次确认删除） ───

/** 平台 → 我的帖子视图（标题 + 摘要；时间=按当前故事时间相对化）。 */
function myItemsOf(kind: SocialKind, me: string, social: ReturnType<typeof readSocialOf>, now: string): Array<{ id: string; title: string; excerpt: string; time: string }> {
  if (kind === 'tieba') return social.tieba.filter(p => p.author === me).map(p => ({ id: p.id, title: p.title, excerpt: socialExcerpt(p.content, 44), time: postTimeText(p, now) }));
  if (kind === 'weibo') return social.weibo.filter(p => p.author === me).map(p => ({ id: p.id, title: p.repost ? S('转发', '传抄', '转述', '传唱') + ` @${p.repost.author}` : S('微博', '风闻', '茶帖', '见闻'), excerpt: socialExcerpt(p.text, 44), time: postTimeText(p, now) }));
  if (kind === 'xhs') return social.xhs.filter(n => n.author === me).map(n => ({ id: n.id, title: n.title, excerpt: socialExcerpt(n.content, 44), time: postTimeText(n, now) }));
  return social.moments.filter(p => p.author === me).map(p => ({ id: p.id, title: momentsSkinProfile(currentStyle())?.postNoun || '动态', excerpt: socialExcerpt(p.text, 44), time: postTimeText(p, now) }));
}

/** 我的关注·内联展开区（stats 行下方，无弹层；三平台同构）。follows/social 帧级一次读入。 */
export function socialFollowsSection(kind: SocialKind, follows: { bars: string[]; weibo: string[]; xhs: string[] }, social: ReturnType<typeof readSocialOf>): string {
  const profiles = social.authorProfiles || {};
  const tp = kind === 'tieba' ? tiebaSkinProfile(currentStyle()) : null;
  const unit = tp?.unitNoun || '吧';
  const rows: string[] = [];
  if (kind === 'tieba') {
    const barMap = new Map(social.bars.map(b => [b.name, b]));
    for (const bar of follows.bars) {
      const info = barMap.get(bar);
      rows.push(`<div class="ubp-fw-row" data-ubp-act="open-follow" data-id="${escapeAttr(bar)}">
        ${avatarHtml(bar, 'sq', true)}
        <div class="ubp-fw-main">
          <div class="ubp-fw-name">${escapeHtml(bar)}</div>
          <div class="ubp-fw-sub">${info ? `${escapeHtml(info.members)}${tp?.memberNoun || S('吧友', '同好')} · ${escapeHtml(info.posts)}${tp?.postNoun || S('帖子', '帖文')}` : `${S('已', '已')}${S('关注', '结交')}之${unit}`}</div>
          <div class="ubp-fw-goto">${S('点击进入吧详情 ›', `点击进入${unit}详情 ›`)}</div>
        </div>
        <button type="button" class="ubp-sfollow on" data-ubp-act="follow" data-scope="bars" data-id="${escapeAttr(bar)}">${S('已关注', '已结交')}</button>
      </div>`);
    }
  } else {
    const scope: 'weibo' | 'xhs' = kind === 'weibo' ? 'weibo' : 'xhs';
    for (const name of follows[scope]) {
      const profile = profiles[`${scope}:${name}`];
      rows.push(`<div class="ubp-fw-row" data-ubp-act="open-follow" data-id="${escapeAttr(name)}">
        ${avatarHtml(name, '', true)}
        <div class="ubp-fw-main">
          <div class="ubp-fw-name">${escapeHtml(name)}</div>
          ${profile?.signature ? `<div class="ubp-fw-sub">${escapeHtml(profile.signature)}</div>` : ''}
          <div class="ubp-fw-goto">${S('点击进入 TA 的主页 ›', '点击进 TA 名帖 ›')}</div>
        </div>
        <button type="button" class="ubp-sfollow on" data-ubp-act="follow" data-scope="${scope}" data-id="${escapeAttr(name)}">${S('已关注', '已结交')}</button>
      </div>`);
    }
  }
  const count = kind === 'tieba' ? follows.bars.length : kind === 'weibo' ? follows.weibo.length : follows.xhs.length;
  const noun = kind === 'tieba' ? S('个吧', `个${unit}`) : S('人', '位');
  return `<div class="ubp-fwsec">
    <div class="ubp-fwsec-hd"><b>${S('我的关注', '我的结交')}</b><i>${count} ${noun}</i><button type="button" class="ubp-fwsec-fold" data-ubp-act="my-follows">${S('收起', '收拢')}</button></div>
    ${rows.join('') || `<div class="ubp-empty"><b>${S('还没有关注任何人', '尚未结交任何人')}</b></div>`}
  </div>`;
}

/**
 * 我的 tab 内容：我发的内容列表（二次确认删除，只能删自己的）+ 关注数行（可点展开内联关注列表）。
 * follows 从外部传入（帧级读一次）；showFollows=展开态（点击「关注 N」切换，由各 App 模块状态持有）。
 */
export function renderSocialMe(
  kind: SocialKind,
  follows: { bars: string[]; weibo: string[]; xhs: string[] },
  showFollows = false,
  socialFrame?: SocialData | null,
): string {
  const roster = getRoster();
  const me = roster.protagonistName;
  // 调用方本帧已持有 social 时直接复用（此前这里又 readPhoneData 一次 = 每帧双份全量深拷贝）；
  // 未传才自读（保持旧调用口径可用）。
  const social = socialFrame || readSocialOf(readPhoneData());
  const items = myItemsOf(kind, me, social, roster.global.time);
  const followCount = kind === 'tieba' ? follows.bars.length : kind === 'weibo' ? follows.weibo.length : follows.xhs.length;
  const followNoun = kind === 'tieba' ? S('关注的吧', `已结交的${tiebaSkinProfile(currentStyle())?.unitNoun || '吧'}`) : S('关注', '结交');
  const statHtml = `<div class="ubp-sme-stats">
    <span><b>${items.length}</b>${S('内容', '帖文')}</span>
    <button type="button" class="ubp-sme-follow${showFollows ? ' open' : ''}" data-ubp-act="my-follows"><b>${followCount}</b>${followNoun} <i>${showFollows ? '⌄' : '›'}</i></button>
  </div>`;
  const followSection = showFollows ? socialFollowsSection(kind, follows, social) : '';
  const emptyHtml = `<div class="ubp-empty"><b>${S('还没有发布过内容', '尚未投过一帖', '尚未投过一帖', '尚未投过一篇')}</b><br>${S('点底部 ＋ 发一条吧', '点底部 ＋ 投一帖吧', '点底部 ＋ 说一段吧', '点底部 ＋ 投一篇吧')}</div>`;
  if (!items.length) {
    return `<div class="ubp-sme">
      <div class="ubp-sme-head">${avatarHtml(me, '', true)}<div><div class="ubp-sme-name">${escapeHtml(me)}</div><div class="ubp-sme-sub">${S('本地账号 · 只显示我发布的内容', '本地名帖 · 只列我所投之帖', '本地名帖 · 只列我所投之帖', '本地名册 · 只列我所投之篇')}</div></div></div>
      ${statHtml}
      ${followSection}
      ${emptyHtml}
    </div>`;
  }
  return `<div class="ubp-sme">
    <div class="ubp-sme-head">${avatarHtml(me, '', true)}<div><div class="ubp-sme-name">${escapeHtml(me)}</div><div class="ubp-sme-sub">${S('本地账号 · 只显示我发布的内容', '本地名帖 · 只列我所投之帖', '本地名帖 · 只列我所投之帖', '本地名册 · 只列我所投之篇')}</div></div></div>
    ${statHtml}
    ${followSection}
    ${items.map(it => `<div class="ubp-sme-row">
      <div class="ubp-sme-main">
        <div class="ubp-sme-title">${escapeHtml(it.title)}</div>
        <div class="ubp-sme-text">${escapeHtml(it.excerpt)}</div>
        <div class="ubp-sme-time">${escapeHtml(it.time)}</div>
      </div>
      <button type="button" class="ubp-sme-del" data-ubp-act="del-post" data-id="${escapeAttr(it.id)}" title="删除">${ubpIcon('trash')}</button>
    </div>`).join('')}
  </div>`;
}

// ─── 顶栏小件（三 App 复用的品牌顶栏行内元素） ───

/** 顶栏分段（品牌顶栏内嵌：贴吧白字渐变 / 微博黑字白底 / 小红书黑字白底）。 */
export function socialSeg(tabs: Array<{ id: string; label: string }>, active: string): string {
  return tabs.map(t => `<button type="button" class="ubp-sseg-tab${t.id === active ? ' on' : ''}" data-ubp-act="seg" data-id="${escapeAttr(t.id)}">${escapeHtml(t.label)}</button>`).join('');
}

/** 详情/次级页导航行（返回 + 标题(+副题) + 右侧操作；三 App 共用）。 */
export function socialDetailNav(opts: { backAct: string; title: string; sub?: string; actsHtml?: string; titleAct?: { act: string; id: string } }): string {
  // titleAct=标题可点进对应页（如帖子详情点吧名进吧）；无则保持纯文本标题
  const titleInner = opts.titleAct
    ? `<button type="button" class="ubp-sdetnav-goto" data-ubp-act="${escapeAttr(opts.titleAct.act)}" data-id="${escapeAttr(opts.titleAct.id)}">${escapeHtml(opts.title)}</button>`
    : escapeHtml(opts.title);
  return `<div class="ubp-sdetnav">
    <button class="ubp-iconbtn" data-ubp-act="${escapeAttr(opts.backAct)}" title="返回">${ubpIcon('back')}</button>
    <div class="ubp-sdetnav-title"><b>${titleInner}</b>${opts.sub ? `<i>${escapeHtml(opts.sub)}</i>` : ''}</div>
    ${opts.actsHtml ? `<div class="ubp-stop-acts">${opts.actsHtml}</div>` : ''}
  </div>`;
}

/** 详情/次级页右上操作位（求回应徽标 + 刷新）。 */
export function socialDetailActs(opts: { busy: boolean; pendingCount: number; fbBusy: boolean; refreshTitle?: string }): string {
  return `${opts.pendingCount ? `<button class="ubp-iconbtn ubp-fbbadge" data-ubp-act="feedback" title="求回应" ${opts.fbBusy || opts.busy ? 'disabled' : ''}>${ubpIcon('comment')}<i>${opts.pendingCount}</i></button>` : ''}
    <button class="ubp-iconbtn" data-ubp-act="refresh" title="${escapeAttr(opts.refreshTitle || '刷新')}" ${opts.busy ? 'disabled' : ''}>
      <span class="${opts.busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span>
    </button>`;
}

/** 关注按钮（贴吧=关注吧 / 微博=+关注 / 小红书=关注，统一样式由 app class 主题化）。 */
export function socialFollowBtn(followed: boolean, scope: SocialFollowScope, name: string): string {
  return `<button type="button" class="ubp-sfollow${followed ? ' on' : ''}" data-ubp-act="follow" data-scope="${escapeAttr(scope)}" data-id="${escapeAttr(name)}">${followed ? S('已关注', '已结交') : S('+ 关注', '结交')}</button>`;
}

// ─── 楼中楼（社媒三 App 共用，视觉规格 docs/comment-subs-mockup.html） ───

const SUB_PREVIEW_COUNT = 2;
const _openSubThreads = new Set<string>();

export function isSubThreadOpen(key: string): boolean { return _openSubThreads.has(key); }
export function toggleSubThread(key: string): void {
  if (_openSubThreads.has(key)) _openSubThreads.delete(key);
  else _openSubThreads.add(key);
}
/** 打开帖子详情时重置（换帖不继承展开态）。 */
export function resetSubThreads(): void { _openSubThreads.clear(); }

export interface SocialSubReplyView {
  idx: number;
  name: string;
  text: string;
  replyTo?: string;
  time?: string;
  mine?: boolean;
  isAuthor?: boolean;
}

/**
 * 楼中楼统一渲染：贴吧=父楼内灰底容器紧凑文本行（无头像无楼层号）；
 * 微博/小红书=缩进小号评论行（小头像+名字+正文+时间·回复 meta），无气泡。
 * 前缀规则：直接回复根评论不带「回复 @」；回复楼中楼内其他人才带（品牌色）。
 * 超 2 条折叠：折叠线与楼中楼文字列齐平（缩进在 CSS），「共 N 条回复 ›」/「收起 ‹」。
 * 子行带 data-ubp-cidx=长按删除入口；回复钮复用 reply-c（postId+idx）。
 */
export function renderSubReplies(opts: { kind: 'tieba' | 'weibo' | 'xhs'; threadKey: string; postId: string; rootName: string; subs: SocialSubReplyView[] }): string {
  if (!opts.subs.length) return '';
  const open = isSubThreadOpen(opts.threadKey);
  const shown = open ? opts.subs : opts.subs.slice(0, SUB_PREVIEW_COUNT);
  const prefixOf = (r: SocialSubReplyView): string => {
    if (!r.replyTo || r.replyTo === opts.rootName) return '';
    return opts.kind === 'tieba'
      ? `<span class="r">回复 @${escapeHtml(r.replyTo)}</span>：`
      : `<b>回复 @${escapeHtml(r.replyTo)}</b>：`;
  };
  const foldCls = opts.kind === 'tieba' ? 'ubp-tb-ssub-fold' : opts.kind === 'weibo' ? 'ubp-wb-subfold' : 'ubp-xhs-subfold';
  const fold = opts.subs.length > SUB_PREVIEW_COUNT
    ? `<button type="button" class="${foldCls}" data-ubp-act="sub-open" data-id="${escapeAttr(opts.threadKey)}">${open ? '收起 ‹' : `共 ${opts.subs.length} 条回复 ›`}</button>`
    : '';
  if (opts.kind === 'tieba') {
    return `<div class="ubp-tb-ssub">${shown.map(r =>
      `<div class="ubp-tb-ssub-row" data-ubp-cidx="${r.idx}"><span class="n">${escapeHtml(r.name)}</span>：${prefixOf(r)}${escapeHtml(r.text)}<button type="button" class="ubp-mo-creply" data-ubp-act="reply-c" data-id="${escapeAttr(opts.postId)}" data-idx="${r.idx}">回复</button></div>`).join('')}${fold}</div>`;
  }
  const wb = opts.kind === 'weibo';
  const rowCls = wb ? 'ubp-wb-srow' : 'ubp-xhs-srow';
  const nameCls = wb ? 'ubp-wb-cmtname' : 'ubp-xhs-cmtname';
  const textCls = wb ? 'ubp-wb-cmttext' : 'ubp-xhs-cmttext';
  const metaCls = wb ? 'ubp-wb-cmtmeta' : 'ubp-xhs-cmtmeta';
  const rows = shown.map(r => {
    const badge = r.isAuthor && !r.mine ? (wb ? '<i class="ubp-wb-bz">博主</i>' : '<i class="ubp-xhs-auz">作者</i>') : '';
    return `<div class="${rowCls}" data-ubp-cidx="${r.idx}">${avatarHtml(r.name, '', true)}<div class="ubp-ssub-main">` +
      `<div class="${nameCls}">${escapeHtml(r.name)}${badge}${r.mine ? '<i class="ubp-mo-metag">（我）</i>' : ''}</div>` +
      `<div class="${textCls}">${prefixOf(r)}${escapeHtml(r.text)}</div>` +
      (r.time ? `<div class="${metaCls}"><span>${escapeHtml(r.time)}</span><button type="button" class="ubp-mo-creply" data-ubp-act="reply-c" data-id="${escapeAttr(opts.postId)}" data-idx="${r.idx}">回复</button></div>` : '') +
      `</div></div>`;
  }).join('');
  return `<div class="${wb ? 'ubp-wb-sub' : 'ubp-xhs-sub'}">${rows}${fold}</div>`;
}
