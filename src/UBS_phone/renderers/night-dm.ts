// ===== 不夜城 · 搭话（私信列表/对话 + 约会进程 + 角色档案卡 + 图片查看器）=====
// 结构对照 docs/night-city-mockup.html 屏07/08/13/14/16：来源标签 + 气泡对话 + 约会节点时间轴 + 档案卡 3 列 + 全屏查看器。

import { nt, nightSpiceLabel } from '../core/night-config';
import {
  nightDateStatusLabel,
  nightTimeText,
  type NightDate,
  type NightDm,
  type NightDmMsg,
  type NightPersona,
} from '../core/night-model';
import { dmImageKey, nzEmpty, nzLockChip, nzRevealBlock, nzSpiceBadge, nzTagRow, type NightUiCtx } from './night-views';
import { avatarHtml, escapeAttr, escapeHtml } from './phone-ui';
import { ubpIcon } from './icons';

// ─── 搭话列表 ───

/** 单条私信的单行预览（列表最后一条 + 长按菜单共用；空会话给占位）。 */
export function nightDmMsgPreview(msg: NightDmMsg | undefined): string {
  if (!msg) return '（还没说话）';
  if (msg.type === 'image') return `[图片]${msg.text || ''}`;
  if (msg.type === 'date') return `[约见卡]${msg.text || ''}`;
  if (msg.type === 'card') return `[礼物]${msg.card?.title || ''}`;
  return msg.text || '';
}

export function nzDmList(dms: readonly NightDm[], ctx: NightUiCtx): string {
  if (!dms.length) return nzEmpty(`还没有人${nt('dm', ctx.style)}你`);
  return `<div class="ubp-nz-dms">${dms.map(dm => {
    const last = dm.msgs[dm.msgs.length - 1];
    const preview = nightDmMsgPreview(last);
    const from = last?.from === 'me' ? '我：' : '';
    return `<button type="button" class="ubp-nz-dmrow${dm.unread ? ' unread' : ''}" data-nz-dm="${escapeAttr(dm.id)}" data-ubp-act="open-dm" data-id="${escapeAttr(dm.id)}">
      ${avatarHtml(dm.peer, '', true)}
      <div class="ubp-nz-dmmain">
        <div class="ubp-nz-dmname">${escapeHtml(dm.peer)}${dm.online ? '<i class="ubp-nz-on"></i>' : ''}
          ${dm.sourceLabel ? `<i class="ubp-nz-srcchip">${escapeHtml(dm.sourceLabel)}</i>` : ''}
        </div>
        <div class="ubp-nz-dmtext">${escapeHtml(from + preview).slice(0, 60)}</div>
      </div>
      <div class="ubp-nz-dmside">
        <span class="ubp-nz-ctime">${last ? escapeHtml(nightTimeText({ timeLabel: last.timeLabel, storyStamp: last.storyStamp }, ctx.now)) : ''}</span>
        ${dm.unread ? `<i class="ubp-nz-dmdot">${dm.unread > 9 ? '9+' : dm.unread}</i>` : ''}
      </div>
    </button>`;
  }).join('')}</div>`;
}

// ─── 对话 ───

function bubble(dm: NightDm, msg: NightDmMsg, ctx: NightUiCtx, dateLookup: (id: string) => NightDate | null): string {
  const mine = msg.from === 'me';
  const time = escapeHtml(nightTimeText({ timeLabel: msg.timeLabel, storyStamp: msg.storyStamp }, ctx.now));
  let inner = '';
  if (msg.type === 'image' && msg.image) {
    inner = `<div class="ubp-nz-bubimg">${nzRevealBlock({ key: dmImageKey(dm.id, msg.id), img: msg.image, heat: 0, coins: 0, variant: 'dm' })}</div>
      ${msg.text ? `<div class="ubp-nz-bubtext">${escapeHtml(msg.text)}</div>` : ''}`;
  } else if (msg.type === 'card') {
    inner = `<div class="ubp-nz-cardmsg"><b>${escapeHtml(msg.card?.glyph || '🎁')}</b><div><div class="ubp-nz-cardtitle">${escapeHtml(msg.card?.title || '礼物')}</div>${msg.card?.sub ? `<div class="ubp-nz-cardsub">${escapeHtml(msg.card.sub)}</div>` : ''}</div></div>`;
  } else if (msg.type === 'date') {
    inner = `<div class="ubp-nz-datemsg"><b>${escapeHtml(nt('date', ctx.style))}邀约</b><div>${escapeHtml(msg.text || '')}</div>
      ${msg.dateId ? `<button type="button" class="ubp-nz-mini" data-ubp-act="open-date" data-id="${escapeAttr(msg.dateId)}">进入${escapeHtml(nt('date', ctx.style))} · ${escapeHtml(nightDateStatusLabel(dateLookup(msg.dateId)?.status || 'planned'))}</button>` : ''}</div>`;
  } else {
    inner = `<div class="ubp-nz-bubtext">${escapeHtml(msg.text || '')}</div>`;
  }
  return `<div class="ubp-nz-bubrow${mine ? ' me' : ''}" data-nz-mid="${escapeAttr(msg.id)}">
    ${mine ? '' : avatarHtml(dm.peer, '', true)}
    <div class="ubp-nz-bub${mine ? ' me' : ''}">${inner}</div>
    ${mine ? avatarHtml(ctx.alias, '', true) : ''}
    <span class="ubp-nz-bubtime">${time}</span>
  </div>`;
}

export function nzDmRoom(dm: NightDm, ctx: NightUiCtx, opts: { busy: boolean; activeDate: NightDate | null; datesEnabled: boolean; dateLookup?: (id: string) => NightDate | null }): string {
  const dateLookup = opts.dateLookup || (() => null);
  const msgs = dm.msgs.length
    ? dm.msgs.map(m => bubble(dm, m, ctx, dateLookup)).join('')
    : `<div class="ubp-nz-empty">${escapeHtml(`这是你和 ${dm.peer} 的第一条消息——打个招呼，或者直接约。`)}</div>`;
  // 微信口径的 typing 气泡：等回复时对方头像 + 三点，终止钮并入同一行（busy=本房生成/送达在途）。
  const typing = opts.busy
    ? `<div class="ubp-nz-bubrow">
        ${avatarHtml(dm.peer, '', true)}
        <div class="ubp-nz-bub ubp-nz-typing">
          <span class="ubp-typing-dots"><i></i><i></i><i></i></span>
          <button type="button" class="ubp-nz-typingabort" data-ubp-act="abort">终止</button>
        </div>
      </div>`
    : '';
  // 输入行 + 操作行合成一个贴底底栏：滚动体仍是 .ubp-appbody，靠 sticky 常驻（对齐 .ubp-replybar 的做法）
  return `<div class="ubp-nz-dmroom" data-nz-dm="${escapeAttr(dm.id)}">
    <div class="ubp-nz-bubbles">${msgs}${typing}</div>
    <div class="ubp-nz-dmfoot">
      <div class="ubp-nz-dmbar">
        <input class="ubp-nz-orderinput" data-ubp-input="dm" maxlength="300" placeholder="说点什么…" value="">
        <button type="button" class="ubp-nz-dmimg" data-ubp-act="dm-image" data-id="${escapeAttr(dm.peer)}" title="发图">${ubpIcon('image')}</button>
        <button type="button" class="ubp-nz-ordersend" data-ubp-act="push-dm" data-id="${escapeAttr(dm.peer)}" ${opts.busy ? 'disabled' : ''}>${opts.busy ? '<span class="ubp-spinner"></span>' : '发送'}</button>
      </div>
      ${opts.datesEnabled && opts.activeDate
        ? `<div class="ubp-nz-dmops"><button type="button" class="ubp-nz-btn" data-ubp-act="open-date" data-id="${escapeAttr(opts.activeDate.id)}">进行中的${escapeHtml(nt('date', ctx.style))} · ${escapeHtml(opts.activeDate.peer)}</button></div>`
        : ''}
    </div>
  </div>`;
}

// ─── 约会进程（N4） ───

/** 约会节点时间轴 + 当前节点的两选。 */
export function nzDateProgress(date: NightDate, ctx: NightUiCtx, opts: { busy: boolean }): string {
  const nodes = date.nodes;
  const last = nodes[nodes.length - 1];
  const needChoice = Boolean(last?.choice && last.choice.picked === undefined && date.status === 'ongoing');
  const timeline = nodes.map((node, i) => `<div class="ubp-nz-dtlnode${i === nodes.length - 1 ? ' on' : ''}">
    <span class="ubp-nz-dtldot"></span>
    <div class="ubp-nz-dtlnb">
      <div class="ubp-nz-dtlnt">第 ${i + 1} 段 · ${escapeHtml(nightTimeText({ timeLabel: node.timeLabel, storyStamp: node.storyStamp }, ctx.now))} · ${escapeHtml(nightSpiceLabel(node.spice, ctx.style))}</div>
      <div class="ubp-nz-dtlnc">${escapeHtml(node.scene)}</div>
      ${node.lines.length ? `<div class="ubp-nz-dtllines">${node.lines.map(l => `<div>${escapeHtml(l)}</div>`).join('')}</div>` : ''}
      ${node.choice ? `<div class="ubp-nz-dtlchoice">${node.choice.options.map((o, oi) =>
        `<span class="${node.choice!.picked === oi ? 'on' : ''}">${escapeHtml(o)}</span>`).join('')}</div>` : ''}
    </div>
  </div>`).join('');
  return `<div class="ubp-nz-date">
    <div class="ubp-nz-datehd">
      ${avatarHtml(date.peer, '', true)}
      <div class="ubp-nz-amain">
        <div class="ubp-nz-aname">${escapeHtml(date.peer)}</div>
        <div class="ubp-nz-asub">${escapeHtml(date.place || '地点待定')}${date.note ? ` · ${escapeHtml(date.note)}` : ''}</div>
      </div>
      <i class="ubp-nz-dstatus">${escapeHtml(nightDateStatusLabel(date.status))}</i>
    </div>
    <div class="ubp-nz-dstep"><i style="width:${Math.round((date.step / date.maxStep) * 100)}%"></i></div>
    <div class="ubp-nz-dstepmeta">已推进 ${date.step}/${date.maxStep} 段${date.step >= date.maxStep ? ' · 已收尾' : ''}</div>
    <div class="ubp-nz-dtls">${timeline || `<div class="ubp-nz-empty">还没有开始——点下方按钮推进第一段（见面）。</div>`}</div>
    ${needChoice ? `<div class="ubp-nz-choosetip">上一段留了两个选择——先选一个，再继续推进。</div>
      <div class="ubp-nz-choices">${last!.choice!.options.map((o, oi) =>
        `<button type="button" class="ubp-nz-choice" data-ubp-act="pick-choice" data-id="${escapeAttr(date.id)}" data-idx="${oi}">${escapeHtml(o)}</button>`).join('')}</div>` : ''}
    <div class="ubp-nz-dateops">
      <button type="button" class="ubp-nz-btn primary" data-ubp-act="advance-date" data-id="${escapeAttr(date.id)}" ${opts.busy || date.status === 'done' || needChoice ? 'disabled' : ''}>
        ${opts.busy ? '<span class="ubp-spinner"></span>' : ''}${date.status === 'done' ? '已收尾' : needChoice ? '先做选择' : date.step === 0 ? '开始（见面）' : '继续下一段'}
      </button>
      ${date.status === 'ongoing' ? `<button type="button" class="ubp-nz-btn" data-ubp-act="pause-date" data-id="${escapeAttr(date.id)}">暂停</button>` : ''}
      ${date.status === 'paused' ? `<button type="button" class="ubp-nz-btn" data-ubp-act="resume-date" data-id="${escapeAttr(date.id)}">继续</button>` : ''}
      <button type="button" class="ubp-nz-btn" data-ubp-act="finish-date" data-id="${escapeAttr(date.id)}" ${date.status === 'done' ? 'disabled' : ''}>收尾</button>
      ${opts.busy ? `<button type="button" class="ubp-nz-btn ghost" data-ubp-act="abort">终止</button>` : ''}
    </div>
    <div class="ubp-nz-datetip">进度保留在手机里：随时暂停、随时回来接着走。</div>
  </div>`;
}

// ─── 角色档案卡（N5） ───

export function nzPersonaCard(persona: NightPersona, ctx: NightUiCtx, opts: { busy: boolean; cached: boolean; followed?: boolean; canProposeDate?: boolean }): string {
  const body = [
    { k: '身高', v: persona.body.height },
    { k: '体型', v: persona.body.build },
    { k: '胸围', v: persona.body.bust },
    { k: '腰围', v: persona.body.waist },
    { k: '臀围', v: persona.body.hips },
  ].filter(x => x.v);
  // 关注开关（搭话对话页的原按钮已收进这里）：未关注=品牌色实心，已关注=描边静默态
  const follow = ctx.me === persona.name ? '' : `<button type="button" class="ubp-nz-follow${opts.followed ? ' ghost' : ''}" data-ubp-act="follow" data-id="${escapeAttr(persona.name)}">${opts.followed ? '已关注' : '关注'}</button>`;
  return `<div class="ubp-nz-persona">
    ${nzLockChip(opts.cached ? 'AI 生成' : '本地资料', opts.cached ? 'solved' : 'gate')}
    <div class="ubp-nz-phd">
      ${avatarHtml(persona.name, 'ubp-bigava', true)}
      <div class="ubp-nz-phmain">
        <div class="ubp-nz-pname"><span class="ubp-nz-pn">${escapeHtml(persona.name)}</span>${follow}</div>
        <div class="ubp-nz-psig">${escapeHtml(persona.signature || '（还没有签名）')}</div>
        <div class="ubp-nz-ptags">
          <span class="ubp-nz-paccept">接受度 ${'★'.repeat(persona.acceptance)}${'☆'.repeat(3 - persona.acceptance)}</span>
          ${nzSpiceBadge(persona.spiceMax, ctx.style)}
        </div>
      </div>
    </div>
    ${persona.appearance ? `<div class="ubp-nz-pblock"><div class="ubp-nz-pbh">外貌</div><div class="ubp-nz-pbt">${escapeHtml(persona.appearance)}</div></div>` : ''}
    ${body.length ? `<div class="ubp-nz-pbody">${body.map(x => `<div class="ubp-nz-pb"><span>${escapeHtml(x.k)}</span><b>${escapeHtml(String(x.v))}</b></div>`).join('')}</div>` : ''}
    <div class="ubp-nz-pgrid">
      <div class="ubp-nz-pblock like">
        <div class="ubp-nz-pbh">偏好</div>
        <div class="ubp-nz-pbt">${persona.likes.length ? persona.likes.map(l => `<span class="ubp-nz-plk">${escapeHtml(l)}</span>`).join('') : '（未记录）'}</div>
      </div>
      <div class="ubp-nz-pblock limit">
        <div class="ubp-nz-pbh">底线（越界会被拒）</div>
        <div class="ubp-nz-pbt">${persona.limits.length ? persona.limits.map(l => `<span class="ubp-nz-plm">${escapeHtml(l)}</span>`).join('') : '（未记录）'}</div>
      </div>
    </div>
    <div class="ubp-nz-pstats">
      <span><b>${persona.posts}</b>${escapeHtml(nt('post', ctx.style))}</span>
      <span><b>${persona.works}</b>作品</span>
    </div>
    <div class="ubp-nz-pops">
      <button type="button" class="ubp-nz-btn" data-ubp-act="regen-persona" data-id="${escapeAttr(persona.name)}" ${opts.busy ? 'disabled' : ''}>${opts.busy ? '生成中…' : '重新生成档案'}</button>
      <button type="button" class="ubp-nz-btn primary" data-ubp-act="talk" data-id="${escapeAttr(persona.name)}">${escapeHtml(nt('dm', ctx.style))} TA</button>
    </div>
    ${opts.canProposeDate ? `<div class="ubp-nz-pdate">
      <button type="button" class="ubp-nz-btn primary" data-ubp-act="propose-date" data-id="${escapeAttr(persona.name)}">约 TA 出来（${escapeHtml(nt('date', ctx.style))}）</button>
    </div>` : ''}
  </div>`;
}

// ─── 图片查看器（全屏） ───

export function nzViewer(args: {
  key: string;
  images: Array<{ key: string; desc: string; reveal: 0 | 1 | 2; zones?: boolean[]; path?: string; gated?: boolean }>;
  index: number;
  author: string;
  boardLabel: string;
  ctx: NightUiCtx;
  unlockLabel?: string;
}): string {
  const current = args.images[args.index];
  if (!current) return '';
  return `<div class="ubp-nz-viewer">
    <div class="ubp-nz-vh">
      <button type="button" class="ubp-iconbtn" data-ubp-act="close-viewer">${ubpIcon('back')}</button>
      <b>${escapeHtml(args.author)}</b>
      <span class="ubp-nz-vhsub">${escapeHtml(args.boardLabel)} · ${args.index + 1}/${args.images.length}</span>
      <span class="ubp-nz-spacer"></span>
      <button type="button" class="ubp-nz-mini" data-ubp-act="reveal-cycle" data-key="${escapeAttr(current.key)}">${current.reveal === 2 ? '重新打码' : '再揭一层'}</button>
    </div>
    <div class="ubp-nz-vstage">
      ${nzRevealBlock({
        key: current.key,
        img: { desc: current.desc, ...(current.path ? { path: current.path, status: 'ready' as const } : {}), reveal: current.reveal, ...(current.zones ? { zones: current.zones } : {}) },
        heat: 99999,
        coins: 99999,
        variant: 'viewer',
      })}
    </div>
    <div class="ubp-nz-vdesc">${escapeHtml(current.desc)}</div>
    ${args.images.length > 1 ? `<div class="ubp-nz-vthumb">${args.images.map((img, i) =>
      `<button type="button" class="ubp-nz-vthumbcell${i === args.index ? ' on' : ''}" data-ubp-act="viewer-jump" data-idx="${i}"><span>${img.reveal === 2 ? '已揭开' : img.reveal === 1 ? '局部' : '轮廓'}</span></button>`).join('')}</div>` : ''}
    <div class="ubp-nz-vops">
      <button type="button" class="ubp-nz-btn" data-ubp-act="save-album" data-key="${escapeAttr(current.key)}">存到相册</button>
      <button type="button" class="ubp-nz-btn" data-ubp-act="send-dm" data-key="${escapeAttr(current.key)}">分享到搭话</button>
      ${args.unlockLabel ? `<button type="button" class="ubp-nz-btn primary" data-ubp-act="unlock" data-key="${escapeAttr(current.key)}">${escapeHtml(args.unlockLabel)}</button>` : ''}
    </div>
  </div>`;
}

export type { NightDm, NightDate, NightPersona };
export { nzTagRow };
