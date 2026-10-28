// ===== 不夜城 · 舞台（开台列表 + 直播间 + 点单台 + 私密房）=====
// 纯渲染：入参出 HTML。动作走 data-ubp-act（app-night 事件委托）。
// 结构对照 docs/night-city-mockup.html 屏05/06/12：画面位 → 主播条 → 台主发言 → 推进 → 点单台 → 弹幕 → 打赏榜 → 礼物栏 → 底部。

import { NIGHT_BOOST_STEPS, NIGHT_GIFTS, nt } from '../core/night-config';
import { nightTimeText, nightTopTipper, type NightBarrage, type NightLive, type NightOrder } from '../core/night-model';
import { avatarHtml, escapeAttr, escapeHtml } from './phone-ui';
import { ubpIcon } from './icons';
import { liveCoverKey, nzBarrageRow, nzEmpty, nzLockChip, nzRevealBlock, nzSpiceBadge, nzTagRow, type NightUiCtx } from './night-views';

/** 直播状态徽标。 */
function statusBadge(live: NightLive): string {
  if (live.status === 'live') return '<i class="ubp-nz-live"><span></span>LIVE</i>';
  if (live.status === 'ended') return '<i class="ubp-nz-live ended">回看</i>';
  return '<i class="ubp-nz-live idle">预告</i>';
}

/** 开台列表卡。 */
export function nzLiveCard(live: NightLive, ctx: NightUiCtx): string {
  return `<div class="ubp-nz-livecard" data-nz-live="${escapeAttr(live.id)}">
    <div class="ubp-nz-livecover" role="button" data-ubp-act="open-live" data-id="${escapeAttr(live.id)}">
      ${nzRevealBlock({ key: liveCoverKey(live.id), img: { desc: live.coverDesc, ...(live.coverPath ? { path: live.coverPath } : {}), ...(live.coverStatus ? { status: live.coverStatus } : {}), ...(live.coverReveal !== undefined ? { reveal: live.coverReveal } : {}) }, heat: live.heat, coins: 0, variant: 'live' })}
      ${statusBadge(live)}
      <span class="ubp-nz-heat">🔥 <b>${live.heat}</b></span>
      ${nzSpiceBadge(live.spice, ctx.style)}
    </div>
    <div class="ubp-nz-livebody" role="button" data-ubp-act="open-live" data-id="${escapeAttr(live.id)}">
      <div class="ubp-nz-title">${escapeHtml(live.title)}</div>
      <div class="ubp-nz-liverow">
        ${avatarHtml(live.streamer, '', true)}
        <span class="ubp-nz-cauthor">${escapeHtml(live.streamer)}${live.byMe ? '<i class="ubp-nz-mask">自己的台</i>' : ''}</span>
        <span class="ubp-nz-ctime">${escapeHtml(nightTimeText(live, ctx.now))} · ${live.viewers} 人在看</span>
      </div>
      ${nzTagRow(live.tags, { act: false })}
      <div class="ubp-nz-livemeta">
        <span>${live.status === 'ended' ? `共 ${live.round} 轮` : `第 ${live.round}/${live.maxRound} 轮`}</span>
        ${live.privateAvailable ? nzLockChip(nt('privateRoom', ctx.style)) : ''}
      </div>
    </div>
  </div>`;
}

/** 打赏榜。 */
function rankHtml(live: NightLive, alias: string): string {
  if (!live.rank.length) return '';
  const top = nightTopTipper(live);
  return `<div class="ubp-nz-rank">
    <div class="ubp-nz-rankhd"><b>${escapeHtml(nt('tip', '') === '打赏' ? '打赏榜' : nt('tip', ''))}</b><span class="ubp-nz-spacer"></span>${top?.name === alias ? '<i class="ubp-nz-rankfirst">榜一特权 · 下一单必应</i>' : ''}</div>
    ${live.rank.slice(0, 5).map((r, i) => `<div class="ubp-nz-rankrow${r.name === alias ? ' me' : ''}">
      <span class="ubp-nz-rankno">${i + 1}</span>
      <span class="ubp-nz-rankname">${escapeHtml(r.name)}</span>
      <span class="ubp-nz-rankgift">${escapeHtml(r.gift)}</span>
      <span class="ubp-nz-rankamt">${r.amount}</span>
    </div>`).join('')}
  </div>`;
}

/** 点单行（历史/当前）。 */
function orderLine(order: NightOrder): string {
  const tier = order.tier !== '口头' ? `<i class="ubp-nz-tier">${escapeHtml(order.tier)}</i>` : '';
  return `<div class="ubp-nz-orderline${order.accepted ? '' : ' rej'}">
    <span class="ubp-nz-owho">${escapeHtml(order.from)}${order.byMe ? `<i class="ubp-nz-me">（我）</i>` : ''}</span>${tier}
    <span class="ubp-nz-otext">「${escapeHtml(order.text)}」</span>
    <span class="ubp-nz-ostate">${order.accepted ? (order.reply ? escapeHtml(order.reply) : '已照做') : `拒绝：${escapeHtml(order.rejectReason || '')}`}</span>
  </div>`;
}

/** 加码阶梯。 */
function boostHtml(live: NightLive, alias: string): string {
  const mine = [...live.orders].reverse().find(o => o.byMe);
  if (!mine) return '';
  const tierIdx = mine.tier === '口头' ? 0 : mine.tier === '动作' ? 1 : 2;
  const nextAt = NIGHT_BOOST_STEPS[tierIdx];
  const remain = nextAt ? Math.max(0, nextAt - mine.boost) : 0;
  const steps = [0, 1, 2].map(i => `<i class="${i <= tierIdx ? 'on' : ''}"></i>`).join('');
  const nextTierName = tierIdx === 0 ? '动作' : '专场';
  const hint = !nextAt ? '已到顶'
    : remain > 0 ? `再攒 ${remain} 热度升到「${nextTierName}」`
      : `再送一份礼物就升到「${nextTierName}」`;
  return `<div class="ubp-nz-boost">
    <span>加码档：<b>${escapeHtml(mine.tier)}</b> · ${hint}</span>
    <span class="ubp-nz-bsteps">${steps}</span>
    ${live.rank[0]?.name === alias ? '<i class="ubp-nz-rankfirst">榜一</i>' : ''}
  </div>`;
}

/** 台主发言区（最近一轮）。 */
function speechHtml(live: NightLive): string {
  const last = live.rounds[live.rounds.length - 1];
  if (!last?.streamerLines.length) {
    return `<div class="ubp-nz-speech empty">${escapeHtml(live.status === 'idle' ? '还没开台——点「推进一次」让台主开始。' : '台主还没开口。')}</div>`;
  }
  return `<div class="ubp-nz-speech">
    ${last.event ? `<div class="ubp-nz-event${last.event.type === 'reject' ? ' rej' : ''}">${escapeHtml(last.event.type === 'reject' ? '被拒' : last.event.type === 'order' ? '点单' : last.event.type)}${last.event.name ? ` · ${escapeHtml(last.event.name)}` : ''}${last.event.text ? `：${escapeHtml(last.event.text)}` : ''}</div>` : ''}
    ${last.streamerLines.map(l => `<div class="ubp-nz-line">${escapeHtml(l)}</div>`).join('')}
    <div class="ubp-nz-speechmeta">${escapeHtml(nightTimeText({ timeLabel: last.timeLabel, storyStamp: last.storyStamp }, ''))}</div>
  </div>`;
}

/** 直播间主体（含点单台 / 弹幕 / 打赏 / 礼物 / 私密房）。 */
export function nzLiveRoom(live: NightLive, ctx: NightUiCtx, opts: { orderEnabled: boolean; busy: boolean; barrages: NightBarrage[]; privateEntered: boolean; giftOpen: boolean; orderOpen: boolean }): string {
  const alias = ctx.alias;
  const top = nightTopTipper(live);
  const privateMode = opts.privateEntered;
  const barrage = opts.barrages.length ? opts.barrages : live.barrage;
  return `<div class="ubp-nz-room" data-nz-live="${escapeAttr(live.id)}">
    <div class="ubp-nz-stage">
      ${nzRevealBlock({ key: liveCoverKey(live.id), img: { desc: live.coverDesc, ...(live.coverPath ? { path: live.coverPath } : {}), ...(live.coverStatus ? { status: live.coverStatus } : {}), ...(live.coverReveal !== undefined ? { reveal: live.coverReveal } : {}) }, heat: live.heat, coins: 0, variant: 'live' })}
      <div class="ubp-nz-stageov">
        <div class="ubp-nz-stagetop">${statusBadge(live)}<span class="ubp-nz-spacer"></span>${nzSpiceBadge(live.spice, ctx.style)}</div>
        <div class="ubp-nz-stagebot">
          <span class="ubp-nz-heatbar"><i style="width:${Math.min(100, Math.max(6, live.heat % 100))}%"></i></span>
          <span class="ubp-nz-hotnum">🔥 <b>${live.heat}</b></span>
          <span class="ubp-nz-viewers">👁 <b>${live.viewers}</b></span>
        </div>
      </div>
    </div>

    <div class="ubp-nz-anchor">
      ${avatarHtml(live.streamer, '', true)}
      <div class="ubp-nz-amain">
        <div class="ubp-nz-aname">${escapeHtml(live.streamer)}${live.byMe ? `<i class="ubp-nz-mask">自己的台</i>` : ''}</div>
        <div class="ubp-nz-asub"><span class="nz-round">第 <b>${live.round}</b>/<b>${live.maxRound}</b> 轮<i class="nz-round-bar"><i style="width:${live.maxRound > 0 ? Math.min(100, Math.round((live.round / live.maxRound) * 100)) : 0}%"></i></i></span>${top ? `<span class="nz-top">榜一 ${escapeHtml(top.name)}</span>` : ''}</div>
      </div>
      ${live.byMe ? '' : `<button type="button" class="ubp-nz-follow ghost" data-ubp-act="talk" data-id="${escapeAttr(live.streamer)}">${escapeHtml(nt('dm', ctx.style))}</button>`}
    </div>

    ${speechHtml(live)}

    <div class="ubp-nz-pushrow">
      <button type="button" class="ubp-nz-btn primary" data-ubp-act="advance" data-id="${escapeAttr(live.id)}" ${opts.busy || live.status === 'ended' ? 'disabled' : ''}>
        ${opts.busy ? '<span class="ubp-spinner"></span>' : ''}${escapeHtml(privateMode ? '继续（1 对 1）' : '推进一次')}
      </button>
      ${privateMode ? '' : `<button type="button" class="ubp-nz-btn" data-ubp-act="toggle-gifts" data-id="${escapeAttr(live.id)}" title="打赏礼物"><b class="ubp-nz-giftglyph">🎁</b>礼物</button>`}
      <button type="button" class="ubp-nz-btn" data-ubp-act="live-menu" data-id="${escapeAttr(live.id)}" title="更多">${ubpIcon('more')}更多</button>
    </div>

    ${opts.giftOpen && !privateMode ? `<div class="ubp-nz-gifts">
      ${NIGHT_GIFTS.map(g => `<button type="button" class="ubp-nz-gift" data-ubp-act="gift" data-id="${escapeAttr(live.id)}" data-gid="${escapeAttr(g.id)}" title="${escapeAttr(`${g.name} · ${g.coins} 硬币`)}">
        <b>${escapeHtml(g.glyph)}</b><span>${escapeHtml(g.name)}<i class="nz-cost">${g.coins}</i></span>
      </button>`).join('')}
    </div>` : ''}

    ${opts.orderOpen && opts.orderEnabled ? `<div class="ubp-nz-orderbox${privateMode ? ' private' : ''}">
        <input class="ubp-nz-orderinput" data-ubp-input="order" maxlength="40" placeholder="${privateMode ? '私密点单（只有 TA 会回应）' : '点单：让台主做点什么（越界会被拒）'}" value="">
        <button type="button" class="ubp-nz-ordersend" data-ubp-act="submit-order" data-id="${escapeAttr(live.id)}" ${opts.busy ? 'disabled' : ''}>点单</button>
      </div>` : ''}
    ${live.orders.filter(o => o.byMe).length ? `<div class="ubp-nz-orders">${live.orders.filter(o => o.byMe).slice(-3).map(o => orderLine(o)).join('')}</div>` : ''}
    ${boostHtml(live, alias)}

    <div class="ubp-nz-barrage">
      ${privateMode
        ? `<div class="ubp-nz-empty">${escapeHtml(nt('privateRoom', ctx.style))}里只剩你们两个——弹幕停屏，台主只对你说话。</div>`
        : (barrage.length ? barrage.slice(-60).map(b => nzBarrageRow(b.name, b.text, { tint: b.tint, spotlight: b.spotlight, byMe: b.byMe })).join('') : '<div class="ubp-nz-empty">弹幕还没开始刷，先发一条？</div>')}
    </div>
    ${privateMode ? '' : `<div class="ubp-nz-barinput">
      <input class="ubp-nz-orderinput" data-ubp-input="barrage" maxlength="60" placeholder="发条弹幕…" value="">
      <button type="button" class="ubp-nz-ordersend" data-ubp-act="send-barrage" data-id="${escapeAttr(live.id)}">发送</button>
    </div>`}

    ${rankHtml(live, alias)}
  </div>`;
}

/** 舞台空态。 */
export function nzStageEmpty(): string {
  return nzEmpty('舞台还没开灯');
}

export type { NightLive };
