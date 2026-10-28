// ===== 正文联动的「呈现层」：渲染 CSS 注入 + 正文手机块 DOM 增强 =====
// 职责边界（core/story-link 只管协议/提取/落库/host API 注入，**不含任何 DOM 访问**）：
//   ①渲染 CSS（宿主 head 单份 <style>）②分组框/逐行气泡回填 ③亮暗主题探针 ④通话卡逐行气泡
//   ⑤MutationObserver(#chat) + 200ms 节流 + data 幂等标记；开关关闭=解绑+拆框+撤主题标记（零残留）。
// 依赖方向：renderers → core（core 绝不 import 本模块）。CSS 生命周期挂在 syncStoryCallEnhancer 上
// （功能开=注入 CSS + 绑观察器；关=拆框 + 移 CSS），与功能开关严格同生共死。

import { formatMMSS } from '../core/ubp-utils';
import { hostDocument, hostWindow } from '../core/host-env';
import { PROTAGONIST_AVATAR_KEY, avatarColor, resolveAvatarPath } from '../core/phone-avatars';
import { estimateCallTiming, setStoryLinkCssProbe, splitSpeakerPrefix, type StoryCallLine } from '../core/story-link';
import { getPhoneApp } from './app-registry';
import { S } from '../core/skins';

// 登记 CSS 存在性探针（core 不碰 DOM：checkStoryLinkStatus 的 cssInjected 由本探针供给）。
setStoryLinkCssProbe(() => Boolean(hostDocument()?.getElementById?.(STORY_LINK_STYLE_ID)));

// ─── 渲染 CSS（宿主 head 单份；消息内 class 会被 ST 加 custom- 前缀 → 选择器双写兼容） ───
// 观感=「柔光玻璃」（用户定稿）：私聊与通话共用同款磨砂外框，把手机内容从正文叙述里切出来。
// 亮暗不写死——由 DOM 增强器在 <body> 盖 data-ubp-sl-theme（探针读主题变量判亮度），
// 因此任何主题（含背景图主题）下都不会出现「深色砖块压在亮色正文上」。

export const STORY_LINK_STYLE_ID = 'ubp-story-link-style';

/** 社媒动态卡片样式（第五轮 ⑦）。与私聊/通话同款柔光外框——正文里三类手机内容观感一致。
 *  类名一律**双写** `.ubp-sl-*` / `.custom-ubp-sl-*`（ST 的 MESSAGE_SANITIZE 会给消息内 class 加 custom- 前缀）。 */
const STORY_LINK_POST_CSS = `
.ubp-sl-post,.custom-ubp-sl-post{box-sizing:border-box;margin:4px 0 16px;padding:13px 14px;border-radius:18px;clear:both;background:rgba(255,255,255,.5);border:1px solid rgba(120,120,128,.2);box-shadow:0 6px 22px rgba(16,24,40,.07);-webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4)}
[data-ubp-sl-theme="dark"] .ubp-sl-post,[data-ubp-sl-theme="dark"] .custom-ubp-sl-post{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.42)}
.ubp-sl-post-head,.custom-ubp-sl-post-head{display:flex;align-items:center;gap:9px;padding-bottom:10px;margin-bottom:11px;border-bottom:1px solid rgba(120,120,128,.2)}
[data-ubp-sl-theme="dark"] .ubp-sl-post-head,[data-ubp-sl-theme="dark"] .custom-ubp-sl-post-head{border-bottom-color:rgba(255,255,255,.1)}
.ubp-sl-post-glyph,.custom-ubp-sl-post-glyph{display:flex;width:30px;height:30px;flex:none;border-radius:11px;align-items:center;justify-content:center;color:#fff;background:rgba(120,120,128,.34)}
.ubp-sl-post-glyph svg,.custom-ubp-sl-post-glyph svg{width:16px;height:16px;display:block}
.ubp-sl-post-head .nm,.custom-ubp-sl-post-head .nm{font-size:13.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ubp-sl-post-head .mt,.custom-ubp-sl-post-head .mt{margin-left:auto;font-size:12px;opacity:.6;white-space:nowrap}
.ubp-sl-post-title,.custom-ubp-sl-post-title{font-size:14.5px;font-weight:600;line-height:1.5;margin-bottom:4px;word-break:break-word}
.ubp-sl-post-body,.custom-ubp-sl-post-body{font-size:14.5px;line-height:1.65;word-break:break-word}
`;

export const STORY_LINK_CSS = STORY_LINK_POST_CSS + `
/* ===== 外框：私聊会话框 + 通话卡（同款） ===== */
.ubp-sl-thread,.custom-ubp-sl-thread,.ubp-sl-call,.custom-ubp-sl-call{box-sizing:border-box;margin:4px 0 16px;padding:13px 14px;border-radius:18px;clear:both;background:rgba(255,255,255,.5);border:1px solid rgba(120,120,128,.2);box-shadow:0 6px 22px rgba(16,24,40,.07);-webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4)}
[data-ubp-sl-theme="dark"] .ubp-sl-thread,[data-ubp-sl-theme="dark"] .custom-ubp-sl-thread,[data-ubp-sl-theme="dark"] .ubp-sl-call,[data-ubp-sl-theme="dark"] .custom-ubp-sl-call{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.42)}
/* ===== 框头：圆角图标 + 联系人 + 右侧来源/时长 ===== */
.ubp-sl-thread-head,.custom-ubp-sl-thread-head,.ubp-sl-call-head,.custom-ubp-sl-call-head{display:flex;align-items:center;gap:9px;padding-bottom:10px;margin-bottom:11px;border-bottom:1px solid rgba(120,120,128,.2)}
[data-ubp-sl-theme="dark"] .ubp-sl-thread-head,[data-ubp-sl-theme="dark"] .custom-ubp-sl-thread-head,[data-ubp-sl-theme="dark"] .ubp-sl-call-head,[data-ubp-sl-theme="dark"] .custom-ubp-sl-call-head{border-bottom-color:rgba(255,255,255,.1)}
.ubp-sl-head-glyph{display:flex;width:30px;height:30px;flex:none;border-radius:11px;align-items:center;justify-content:center;color:#fff;background:linear-gradient(180deg,#34C778,#22AA62);box-shadow:0 2px 8px rgba(34,170,98,.28)}
.ubp-sl-head-glyph svg{width:16px;height:16px;display:block;fill:currentColor}
/* 框头头像位（有立绘=图，无=单字色块；空则整位不占位） */
.ubp-sl-head-av{width:30px;height:30px;flex:none;border-radius:11px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#fff;background:rgba(120,120,128,.34);box-shadow:0 1px 3px rgba(16,24,40,.14)}
.ubp-sl-head-av:empty{display:none}
.ubp-sl-head-av img{width:100%;height:100%;object-fit:cover;display:block}
.ubp-sl-head-name{font-size:13.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ubp-sl-head-meta{margin-left:auto;font-size:12px;opacity:.6;font-variant-numeric:tabular-nums;white-space:nowrap}
.ubp-sl-wave{display:flex;align-items:flex-end;gap:2px;height:11px;color:#22AA62}
[data-ubp-sl-theme="dark"] .ubp-sl-wave{color:#5BD08C}
.ubp-sl-wave i{width:2px;border-radius:1px;background:currentColor;display:block}
.ubp-sl-thread-body,.custom-ubp-sl-thread-body{display:flex;flex-direction:column}
/* ===== 私聊消息：一行 = 头像 +（署名 + 气泡）内容列 ===== */
.ubp-sl-wx,.custom-ubp-sl-wx{display:flex;flex-direction:row;align-items:flex-start;gap:8px;max-width:88%;margin:0 0 10px;clear:both}
[data-ubp-sl-inthread]:last-child{margin-bottom:0}
.ubp-sl-col,.custom-ubp-sl-col{display:flex;flex-direction:column;align-items:flex-start;min-width:0}
.ubp-sl-av,.custom-ubp-sl-av{width:28px;height:28px;flex:none;border-radius:9px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;background:rgba(120,120,128,.34)}
.ubp-sl-av:empty,.custom-ubp-sl-av:empty{display:none}
.ubp-sl-av img,.custom-ubp-sl-av img{width:100%;height:100%;object-fit:cover;display:block}
.ubp-sl-wx-name,.custom-ubp-sl-wx-name{font-size:11px;line-height:1.4;opacity:.55;margin:0 3px 4px}
[data-ubp-sl-inthread] .ubp-sl-wx-name,[data-ubp-sl-inthread] .custom-ubp-sl-wx-name{display:none}
.ubp-sl-wx-bubble,.custom-ubp-sl-wx-bubble{width:fit-content;max-width:100%;padding:9px 13px;font-size:14.5px;line-height:1.6;border-radius:17px;word-break:break-word;background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.7);box-shadow:0 1px 2px rgba(16,24,40,.05);-webkit-backdrop-filter:blur(10px) saturate(1.3);backdrop-filter:blur(10px) saturate(1.3)}
[data-ubp-sl-theme="dark"] .ubp-sl-wx-bubble,[data-ubp-sl-theme="dark"] .custom-ubp-sl-wx-bubble{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.09);box-shadow:none}
/* 靠右：主角（data-sender="我"）+ 角色间对话里非首位发送人（data-ubp-sl-side=right，由增强器标记） */
.ubp-sl-wx[data-sender="我"],.custom-ubp-sl-wx[data-sender="我"],.ubp-sl-me[data-sender="我"],.custom-ubp-sl-me[data-sender="我"],.ubp-sl-wx[data-ubp-sl-side="right"],.custom-ubp-sl-wx[data-ubp-sl-side="right"]{margin-left:auto;flex-direction:row-reverse}
.ubp-sl-wx[data-sender="我"] .ubp-sl-col,.custom-ubp-sl-wx[data-sender="我"] .custom-ubp-sl-col,.ubp-sl-me .ubp-sl-col,.custom-ubp-sl-me .custom-ubp-sl-col,.ubp-sl-wx[data-ubp-sl-side="right"] .ubp-sl-col,.custom-ubp-sl-wx[data-ubp-sl-side="right"] .custom-ubp-sl-col{align-items:flex-end}
/* 主角绿只认「我」：角色间右侧仍是中性气泡，避免被误读成主角 */
.ubp-sl-wx[data-sender="我"] .ubp-sl-wx-bubble,.custom-ubp-sl-wx[data-sender="我"] .custom-ubp-sl-wx-bubble,.ubp-sl-me .ubp-sl-wx-bubble,.custom-ubp-sl-me .custom-ubp-sl-wx-bubble{color:#fff;border-color:transparent;background:linear-gradient(180deg,rgba(52,199,120,.92),rgba(34,170,98,.92));box-shadow:0 2px 8px rgba(34,170,98,.26)}
/* 框内气泡：外框已铺底，气泡再收敛一档，避免"底上叠底"（[data-ubp-sl-inthread] 由增强器盖在入框消息上） */
[data-ubp-sl-inthread] .ubp-sl-wx-bubble,[data-ubp-sl-inthread] .custom-ubp-sl-wx-bubble{background:rgba(255,255,255,.5);border-color:rgba(255,255,255,.42);box-shadow:none}
[data-ubp-sl-theme="dark"] [data-ubp-sl-inthread] .ubp-sl-wx-bubble,[data-ubp-sl-theme="dark"] [data-ubp-sl-inthread] .custom-ubp-sl-wx-bubble{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.08)}
[data-ubp-sl-inthread][data-sender="我"] .ubp-sl-wx-bubble,[data-ubp-sl-inthread][data-sender="我"] .custom-ubp-sl-wx-bubble{background:linear-gradient(180deg,rgba(52,199,120,.92),rgba(34,170,98,.92));border-color:transparent;color:#fff;box-shadow:0 2px 8px rgba(34,170,98,.24)}
/* ===== 通话逐行台词气泡（同样带头像：对方左、主角右） ===== */
.ubp-sl-call-body,.custom-ubp-sl-call-body{display:flex;flex-direction:column;gap:9px}
.ubp-sl-row,.custom-ubp-sl-row{display:flex;align-items:flex-start;gap:8px;max-width:92%;margin:0}
.ubp-sl-row-me,.custom-ubp-sl-row-me{flex-direction:row-reverse;margin-left:auto}
.ubp-sl-row-av{width:26px;height:26px;flex:none;border-radius:9px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:600;color:#fff;background:rgba(120,120,128,.34)}
.ubp-sl-row-av:empty{display:none}
.ubp-sl-row-av img{width:100%;height:100%;object-fit:cover;display:block}
.ubp-sl-bubble,.custom-ubp-sl-bubble{max-width:100%;padding:8px 12px;border-radius:13px;font-size:13.5px;line-height:1.62;word-break:break-word;background:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.55);color:inherit}
[data-ubp-sl-theme="dark"] .ubp-sl-bubble,[data-ubp-sl-theme="dark"] .custom-ubp-sl-bubble{background:rgba(255,255,255,.075);border-color:rgba(255,255,255,.08)}
.ubp-sl-row-me .ubp-sl-bubble,.custom-ubp-sl-row-me .custom-ubp-sl-bubble{color:#fff;border-color:transparent;background:linear-gradient(180deg,rgba(52,199,120,.9),rgba(34,170,98,.9));box-shadow:0 2px 8px rgba(34,170,98,.22)}
`;

export function ensureStoryLinkCss(): boolean {
  try {
    const doc = hostDocument();
    if (!doc?.head) return false;
    if (doc.getElementById(STORY_LINK_STYLE_ID)) return true;
    const el = doc.createElement('style');
    el.id = STORY_LINK_STYLE_ID;
    el.textContent = STORY_LINK_CSS;
    doc.head.appendChild(el);
    return true;
  } catch (_e) { return false; }
}

export function removeStoryLinkCss(): void {
  try {
    const doc = hostDocument();
    doc?.getElementById(STORY_LINK_STYLE_ID)?.remove();
    doc?.body?.removeAttribute(SL_THEME_ATTR);
    unwrapStoryThreads();
  } catch (_e) { /* ignore */ }
}

// ─── 正文手机块的 DOM 增强（正则只能产出容器；分组框/逐行气泡/亮暗标记由轻量增强器补齐） ───
// 模式仿 phone-ctn 头像回填：MutationObserver(#chat subtree) + 200ms 节流；增强过打 data 标记幂等
// （ST 重渲染楼层会还原原始标记 → 观察器再次增强）。功能关闭时解除观察、撤掉主题标记并拆框。

const SL_THEME_ATTR = 'data-ubp-sl-theme';
const SL_WX_SEL = '.ubp-sl-wx,.custom-ubp-sl-wx';
const SL_THREAD_SEL = '.ubp-sl-thread,.custom-ubp-sl-thread';
const SL_CALL_SEL = '.ubp-sl-call,.custom-ubp-sl-call';

const SL_GLYPH_CHAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4c-4.75 0-8.6 3.05-8.6 6.8 0 2.1 1.2 3.98 3.08 5.2-.1 1.02-.62 2.22-1.63 3.16 1.62-.1 3.02-.72 4.02-1.53.98.25 2.03.37 3.13.37 4.75 0 8.6-3.05 8.6-6.8S16.75 3.4 12 3.4Z"/></svg>';
const SL_GLYPH_PHONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5C4 4.67 4.67 4 5.5 4h1.9c.72 0 1.34.5 1.48 1.2l.55 2.6c.13.6-.1 1.22-.58 1.58l-1.1.82a12.6 12.6 0 0 0 5.05 5.05l.82-1.1c.36-.48.98-.71 1.58-.58l2.6.55c.7.14 1.2.76 1.2 1.48v1.9c0 .83-.67 1.5-1.5 1.5C10.6 20 4 13.4 4 5.5Z"/></svg>';
const SL_WAVE_BARS = '<i style="height:5px"></i><i style="height:10px"></i><i style="height:7px"></i><i style="height:12px"></i><i style="height:6px"></i>';

function slFormatDuration(sec: number): string {
  return formatMMSS(sec, true); // 四舍五入口径；实现统一在 core/ubp-utils
}

/** 重建框头：左侧图标/头像 + 主标题 +（通话）声波 + 右侧来源/时长。
 *  avatarName 有值=私聊框头用联系人头像位（无图回落单字），undefined=用绿色图标（角色间/通话）。
 *  用 DOM 节点而非 innerHTML 拼接：名字来自 AI 正文，只有静态 SVG/声波才走 innerHTML。 */
function slFillHead(head: Element, kind: 'chat' | 'call', name: string, meta: string, avatarName?: string): void {
  const doc = head.ownerDocument;
  if (!doc) return;
  head.textContent = '';
  const label = kind === 'call' ? S('通话', '传音', '传声', '远语') : S('微信', '传讯', '飞鸽', '晶讯');
  const lead = doc.createElement('span');
  if (kind === 'call' || avatarName === undefined) {
    lead.className = 'ubp-sl-head-glyph';
    lead.innerHTML = kind === 'call' ? SL_GLYPH_PHONE : SL_GLYPH_CHAT;
  } else {
    lead.className = 'ubp-sl-head-av';
    slFillAvatar(lead, avatarName, avatarName.slice(0, 1));
  }
  const title = doc.createElement('span');
  title.className = 'ubp-sl-head-name';
  title.textContent = name ? (kind === 'call' ? `${label} · ${name}` : name) : label;
  head.appendChild(lead);
  head.appendChild(title);
  if (kind === 'call') {
    const wave = doc.createElement('span');
    wave.className = 'ubp-sl-wave';
    wave.innerHTML = SL_WAVE_BARS;
    head.appendChild(wave);
  }
  const side = doc.createElement('span');
  side.className = 'ubp-sl-head-meta';
  side.textContent = kind === 'chat' && !meta ? label : meta;
  head.appendChild(side);
}

/** 单条消息的发送人（`我`=主角保留字）。 */
function slSender(el: HTMLElement): string {
  return el.getAttribute('data-sender') ?? '';
}

/** 消息类别：direct=主角参与（发给主角/主角发出）；bystander=两个非主角之间。切段据此断开。 */
function slMsgKind(el: HTMLElement): 'direct' | 'bystander' {
  const sender = slSender(el);
  const peer = el.getAttribute('data-peer') ?? '';
  return sender !== '我' && peer ? 'bystander' : 'direct';
}

/** 头像数据：有立绘用图，无图回落单字 + 名字散列底色（与手机 App 同一份配色）。 */
function slAvatarFor(sender: string): { key: string; text: string } {
  if (!sender || sender === '我') return { key: PROTAGONIST_AVATAR_KEY, text: '我' };
  return { key: sender, text: sender.slice(0, 1) };
}

function slAvatarTarget(el: HTMLElement): { key: string; text: string } {
  return slAvatarFor(slSender(el));
}

/** 填充一个头像位（图 → img；无图 → 单字 + 底色）。空位由 CSS :empty 收起。
 *  立绘读取依赖手机存储就绪：任何异常都降级为单字占位，绝不拖垮分组。 */
function slFillAvatar(slot: Element, key: string, text: string): void {
  const doc = slot.ownerDocument;
  if (!doc) return;
  slot.textContent = '';
  let path = '';
  try { path = key ? resolveAvatarPath(key) : ''; } catch (_e) { path = ''; }
  if (path) {
    const img = doc.createElement('img');
    img.setAttribute('alt', '');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('src', path);
    slot.appendChild(img);
    return;
  }
  slot.textContent = text;
  slot.setAttribute('style', `background:${avatarColor(key || text)}`);
}

interface SlThreadInfo {
  /** 框头标题。 */
  title: string;
  /** 私聊：框头头像取谁；角色间不取（用图标）。 */
  avatarName?: string;
  /** 角色间：渲染在左侧的发送人；其余发送人的消息标 data-ubp-sl-side=right。 */
  primary?: string;
}

/** 框头信息与左右归属。
 *  direct：主角参与 → 框头=对方名 + 对方头像，主角靠右（CSS 认 data-sender="我"）。
 *  bystander：两个非主角 → 全部同向时框头「A → B」且不分栏；有来有回时框头「A · B」并按发送人分左右。 */
function slThreadInfo(run: readonly HTMLElement[]): SlThreadInfo {
  const kind = slMsgKind(run[0]);
  if (kind === 'direct') {
    let peer = '';
    for (const el of run) {
      const sender = slSender(el);
      if (sender && sender !== '我') { peer = sender; break; }
    }
    if (!peer) {
      for (const el of run) {
        const p = el.getAttribute('data-peer') ?? '';
        if (p) { peer = p; break; }
      }
    }
    return { title: peer, avatarName: peer };
  }
  const senders: string[] = [];
  for (const el of run) {
    const sender = slSender(el);
    if (sender && !senders.includes(sender)) senders.push(sender);
  }
  if (!senders.length) return { title: '' };
  if (senders.length === 1) {
    const to = run.map(el => el.getAttribute('data-peer') ?? '').find(Boolean) ?? '';
    return { title: to ? `${senders[0]} → ${to}` : senders[0] };
  }
  return { title: senders.join(' · '), primary: senders[0] };
}

// ─── 亮暗主题（正文落在 ST 主题里，CSS 无法自判；探针读主题变量算亮度 → 盖 body 属性） ───

interface SlRgb { r: number; g: number; b: number; a: number }

function slParseColor(value: string): SlRgb | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(value || '');
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

function slLum(c: SlRgb): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** 亮暗判定：主题底色优先（透明则退回正文文字色反推，再退回 body 背景）。 */
export function detectStoryLinkDark(): boolean {
  const doc = hostDocument();
  const win = hostWindow() as any;
  if (!doc?.body || typeof win?.getComputedStyle !== 'function') return false;
  try {
    const probe = doc.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:1px;height:1px;font-size:0;'
      + 'color:var(--SmartThemeBodyColor,#222);background-color:var(--SmartThemeBlurTintColor,rgba(0,0,0,0))');
    doc.body.appendChild(probe);
    const cs = win.getComputedStyle(probe);
    const bg = slParseColor(cs.backgroundColor);
    const fg = slParseColor(cs.color);
    probe.remove();
    if (bg && bg.a > 0.2) return slLum(bg) < 0.45;
    if (fg) return slLum(fg) > 0.5;
    const bodyBg = slParseColor(win.getComputedStyle(doc.body).backgroundColor);
    if (bodyBg && bodyBg.a > 0.2) return slLum(bodyBg) < 0.45;
  } catch (_e) { /* 探针失败=按亮色处理 */ }
  return false;
}

/** 主题标记同步（每次扫描调用；值不变则不写，避免无谓的属性变更触发观察器）。 */
export function syncStoryLinkTheme(): void {
  const doc = hostDocument();
  if (!doc?.body) return;
  const next = detectStoryLinkDark() ? 'dark' : 'light';
  if (doc.body.getAttribute(SL_THEME_ATTR) !== next) doc.body.setAttribute(SL_THEME_ATTR, next);
}

// ─── 私聊分组框：连续消息包进一张与通话卡同款的外框 ───

/** 全文档扫一遍未分组的私聊消息，连续段包框（返回成框数）。 */
export function sweepStoryThreads(): number {
  const doc = hostDocument();
  if (!doc?.querySelectorAll) return 0;
  const seen = new Set<Element>();
  const items: HTMLElement[] = [];
  for (const sel of SL_WX_SEL.split(',')) {
    doc.querySelectorAll(sel).forEach(el => { if (!seen.has(el)) { seen.add(el); items.push(el as HTMLElement); } });
  }
  let made = 0;
  for (const el of items) {
    if (!el.isConnected) continue;
    if (el.closest(SL_THREAD_SEL)) continue; // 已在框内
    const parent = el.parentElement;
    if (!parent) continue;
    const run: HTMLElement[] = [el];
    const droppable: Element[] = []; // 消息之间的换行（AI 每条一行时产生），随分组一并清掉
    let pendingBr: Element[] = [];
    const kind = slMsgKind(el); // 主角会话与旁观会话相邻时各自成框（混在一起框头会张冠李戴）
    let cursor: Element | null = el.nextElementSibling;
    while (cursor) {
      if (cursor.matches(SL_WX_SEL) && slMsgKind(cursor as HTMLElement) === kind) {
        run.push(cursor as HTMLElement);
        droppable.push(...pendingBr);
        pendingBr = [];
        cursor = cursor.nextElementSibling;
        continue;
      }
      if (cursor.tagName === 'BR') { pendingBr.push(cursor); cursor = cursor.nextElementSibling; continue; }
      break;
    }
    try {
      const info = slThreadInfo(run);
      const head = doc.createElement('div');
      head.className = 'ubp-sl-thread-head';
      slFillHead(head, 'chat', info.title, '', info.avatarName);
      const bodyEl = doc.createElement('div');
      bodyEl.className = 'ubp-sl-thread-body';
      const thread = doc.createElement('div');
      thread.className = 'ubp-sl-thread';
      thread.setAttribute('data-ubp-sl-done', '1');
      thread.appendChild(head);
      thread.appendChild(bodyEl);
      parent.insertBefore(thread, el);
      for (const node of run) {
        // 角色间「有来有回」：非首位发送人的消息靠右（右侧仍用中性气泡，不套主角绿）
        const sender = slSender(node);
        if (info.primary && sender && sender !== info.primary) node.setAttribute('data-ubp-sl-side', 'right');
        else node.removeAttribute('data-ubp-sl-side');
        // 入框标记：CSS 用它改气泡收敛度与隐藏署名（分组框是我们生成的、消息被 ST 加了 custom- 前缀，
        // 靠后代类名匹配会因前缀不一致失效，故用属性做「已在框内」的唯一断言）
        node.setAttribute('data-ubp-sl-inthread', '1');
        const av = node.querySelector('.ubp-sl-av,.custom-ubp-sl-av');
        if (av) {
          const target = slAvatarTarget(node);
          slFillAvatar(av, target.key, target.text);
        }
        bodyEl.appendChild(node);
      }
      for (const junk of droppable) junk.remove();
      made++;
    } catch (_e) { /* 单段故障不阻断 */ }
  }
  return made;
}

/** 拆框（功能关闭时零残留；ST 重渲染前也不留空壳）。 */
export function unwrapStoryThreads(): void {
  const doc = hostDocument();
  if (!doc?.querySelectorAll) return;
  for (const el of Array.from(doc.querySelectorAll(SL_THREAD_SEL))) {
    const parent = el.parentElement;
    if (!parent) continue;
    const bodyEl = el.querySelector('.ubp-sl-thread-body,.custom-ubp-sl-thread-body');
    for (const child of Array.from(bodyEl?.childNodes ?? [])) {
      const node = child as unknown as { removeAttribute?: (name: string) => void };
      if (typeof node.removeAttribute === 'function') node.removeAttribute('data-ubp-sl-inthread');
      parent.insertBefore(child, el);
    }
    el.remove();
  }
}

// ─── 通话卡：逐行左右气泡 + 表头（通话 · 对方名 · 时长） ───

/** 单卡片增强：台词行 → 左（对方）/右（我）气泡；顺带把对方名与估算时长写进卡片表头。 */
export function enhanceStoryCallCard(body: HTMLElement): void {
  const doc = body.ownerDocument;
  if (!doc || body.getAttribute('data-ubp-sl-done')) return;
  const lines = String(body.textContent ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  let peer = '';
  const rows: StoryCallLine[] = [];
  for (const line of lines) {
    if (line.startsWith('我：') || line.startsWith('我:')) {
      const said = line.slice(2).trim();
      if (said) rows.push({ from: 'me', text: said });
      continue;
    }
    const split = splitSpeakerPrefix(line);
    if (split) {
      if (!peer) peer = split.speaker;
      rows.push({ from: 'peer', text: split.text });
    } else {
      rows.push({ from: 'peer', text: line });
    }
  }
  if (!rows.length) return;
  const frag = doc.createDocumentFragment();
  for (const row of rows) {
    const rowEl = doc.createElement('div');
    rowEl.className = 'ubp-sl-row' + (row.from === 'me' ? ' ubp-sl-row-me' : '');
    const av = doc.createElement('span');
    av.className = 'ubp-sl-row-av';
    // 台词行头像与私聊消息同一口径：对方取真名（无则空位收起），我方用主角哨兵
    const target = row.from === 'me' ? slAvatarFor('我') : (peer ? slAvatarFor(peer) : null);
    if (target) slFillAvatar(av, target.key, target.text);
    const bubble = doc.createElement('div');
    bubble.className = 'ubp-sl-bubble';
    bubble.textContent = row.text;
    rowEl.appendChild(av);
    rowEl.appendChild(bubble);
    frag.appendChild(rowEl);
  }
  body.innerHTML = '';
  body.appendChild(frag);
  body.setAttribute('data-ubp-sl-done', '1');
  const head = body.closest(SL_CALL_SEL)?.querySelector('.ubp-sl-call-head,.custom-ubp-sl-call-head') ?? null;
  if (head) {
    const { durationSec } = estimateCallTiming(rows);
    slFillHead(head, 'call', peer, durationSec ? slFormatDuration(durationSec) : '');
  }
}

/** 全文档扫一遍未增强的通话卡片（返回处理数）。 */
export function sweepStoryCallCards(): number {
  const doc = hostDocument();
  if (!doc?.querySelectorAll) return 0;
  const bodies = doc.querySelectorAll('.ubp-sl-call-body:not([data-ubp-sl-done]),.custom-ubp-sl-call-body:not([data-ubp-sl-done])');
  let count = 0;
  for (const el of Array.from(bodies)) {
    const body = el as HTMLElement;
    if (!body.querySelector) continue;
    try {
      enhanceStoryCallCard(body);
      count++;
    } catch (_e) { /* 单卡故障不阻断 */ }
  }
  return count;
}

/** 社媒动态卡片的平台图标位回填（第五轮 ⑦）：正则壳只出空位 + data-ubp-sl-kind，
 *  图标与品牌色从 App 注册表取（与桌面磁贴同一份图标事实源，core 不必认识图标）。 */
export function sweepStoryPostGlyphs(): number {
  const doc = hostDocument();
  if (!doc?.querySelectorAll) return 0;
  const nodes = doc.querySelectorAll('.ubp-sl-post-glyph:not([data-ubp-sl-done]),.custom-ubp-sl-post-glyph:not([data-ubp-sl-done])');
  let count = 0;
  for (const el of Array.from(nodes)) {
    const node = el as HTMLElement;
    const app = getPhoneApp(node.getAttribute('data-ubp-sl-kind') || '');
    if (!app) continue;
    node.innerHTML = app.icon;
    node.style.background = app.color;
    node.setAttribute('data-ubp-sl-done', '1');
    count++;
  }
  return count;
}

/** 全量扫描：主题标记 → 私聊分组框 → 通话卡 → 社媒卡片图标（各阶段互相独立，单段故障不影响其他）。 */
export function sweepStoryLinkBlocks(): number {
  syncStoryLinkTheme();
  let count = 0;
  try { count += sweepStoryThreads(); } catch (_e) { /* ignore */ }
  try { count += sweepStoryCallCards(); } catch (_e) { /* ignore */ }
  try { count += sweepStoryPostGlyphs(); } catch (_e) { /* ignore */ }
  return count;
}

let _callObserver: MutationObserver | null = null;
let _callSweepTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCallSweep(): void {
  if (_callSweepTimer) return;
  _callSweepTimer = setTimeout(() => {
    _callSweepTimer = null;
    try { sweepStoryLinkBlocks(); } catch (_e) { /* ignore */ }
  }, 200);
}

function bindStoryCallEnhancer(): void {
  ensureStoryLinkCss(); // 渲染 CSS 与观察器同生：开功能=补注入（幂等，宿主 head 单份）
  if (_callObserver) return;
  const doc = hostDocument();
  const target = doc?.querySelector?.('#chat') || doc?.body;
  if (!target || typeof MutationObserver === 'undefined') {
    try { sweepStoryLinkBlocks(); } catch (_e) { /* ignore */ }
    return;
  }
  try { sweepStoryLinkBlocks(); } catch (_e) { /* ignore */ }
  _callObserver = new MutationObserver(() => scheduleCallSweep());
  _callObserver.observe(target, { childList: true, subtree: true });
}

function unbindStoryCallEnhancer(): void {
  if (_callSweepTimer) { clearTimeout(_callSweepTimer); _callSweepTimer = null; }
  if (_callObserver) { _callObserver.disconnect(); _callObserver = null; }
  try {
    unwrapStoryThreads();
    hostDocument()?.body?.removeAttribute(SL_THEME_ATTR);
  } catch (_e) { /* ignore */ }
  removeStoryLinkCss(); // 关功能=连渲染 CSS 一起撤（零残留）
}

/** 功能开关接线：开=注入 CSS + 绑定观察器 + 立即扫一遍；关=解除观察 + 拆框 + 撤主题标记 + 移 CSS（零残留）。 */
export function syncStoryCallEnhancer(on: boolean): void {
  if (on) bindStoryCallEnhancer();
  else unbindStoryCallEnhancer();
}
