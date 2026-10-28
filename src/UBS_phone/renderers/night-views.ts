// ===== 不夜城 · 共享视图件（街区帖子卡/详情/评论楼中楼/分层揭开图块/标签/尺度徽标） =====
// 纯渲染（无模块状态）：入参出 HTML，动作一律走 data-ubp-act 交给 app-night 的事件委托。
// 视觉对照 docs/night-city-mockup.html：暗色霓虹 + 尺度三色徽标 + 分层揭开（轮廓/三区马赛克/全图）。

import type { PhoneStyle } from '../core/chat-model';
import { buildCommentThreads, type SocialComment } from '../core/social-model';
import {
  NIGHT_TAGS_PER_POST,
  nt,
  nightBoardGlyph,
  nightBoardName,
  nightBoardTint,
  nightSpiceLabel,
  type NightSpice,
} from '../core/night-config';
import {
  nightUnlockReady,
  nightTimeText,
  nightExcerpt,
  nightPostTitle,
  nightTintOf,
  type NightAbout,
  type NightImage,
  type NightPost,
} from '../core/night-model';
import { isNightImageActive, nightImageEffectiveReveal } from '../core/night-images';
import { avatarHtml, escapeAttr, escapeHtml } from './phone-ui';
import { actIcon, ubpIcon } from './icons';

/** 渲染帧上下文（一次读入，全帧共用；避免渲染循环重复深拷贝）。 */
export interface NightUiCtx {
  style: PhoneStyle;
  /** 主角真名（AI 侧禁止出现；界面用它判「我」）。 */
  me: string;
  /** 主角马甲（本 App 署名）。 */
  alias: string;
  /** 故事时间（相对化基准）。 */
  now: string;
  /** 本次会话私密收藏夹已解锁（长按 2 秒）。 */
  favUnlocked: boolean;
}

// ─── 图片 key（归属编码；渲染层只传 key，写操作统一走 night-images） ───

export const postImageKey = (postId: string, idx: number): string => `p:${postId}:${idx}`;
export const aboutImageKey = (postId: string, idx: number): string => `a:${postId}:${idx}`;
export const entryImageKey = (postId: string, entryId: string): string => `e:${postId}:${entryId}`;
export const liveCoverKey = (liveId: string): string => `l:${liveId}`;
export const dmImageKey = (dmId: string, msgId: string): string => `d:${dmId}:${msgId}`;

/** key 是否属于某帖的图（长按/删除等按帖定位时用）。 */
export function imageKeyPostId(key: string): string {
  return key.split(':')[1] || '';
}

// ─── 徽标与小件 ───

/** 尺度徽标（三色：微涩/露骨/极限）。 */
export function nzSpiceBadge(spice: NightSpice, style: PhoneStyle, opts: { only?: boolean } = {}): string {
  return `<i class="ubp-nz-spice s${spice}" data-ubp-act="spice-filter" data-idx="${spice}" title="${escapeAttr(opts.only ? '点此取消筛选' : `只看「${nightSpiceLabel(spice, style)}」`)}">${escapeHtml(nightSpiceLabel(spice, style))}</i>`;
}

/** 板块 chip（列表用）。 */
export function nzBoardChip(board: string, style: PhoneStyle): string {
  return `<span class="ubp-nz-bchip" style="color:${escapeAttr(nightBoardTint(board))};border-color:${escapeAttr(nightBoardTint(board))}66">${escapeHtml(nightBoardGlyph(board))} ${escapeHtml(nightBoardName(board, style))}</span>`;
}

/** 标签行。 */
export function nzTagRow(tags: readonly string[], opts: { act?: boolean } = {}): string {
  if (!tags.length) return '';
  return `<div class="ubp-nz-tags">${tags.slice(0, NIGHT_TAGS_PER_POST).map(t =>
    opts.act === false
      ? `<span class="ubp-nz-tag">${escapeHtml(t)}</span>`
      : `<button type="button" class="ubp-nz-tag" data-ubp-act="tag-filter" data-id="${escapeAttr(t)}">#${escapeHtml(t)}</button>`).join('')}</div>`;
}

/** 作者行（头像 + 名 + 马甲标；可点进关注/搭话）。 */
export function nzAuthorRow(author: string, ctx: NightUiCtx, opts: { sub?: string; byMe?: boolean; acts?: string } = {}): string {
  const mine = opts.byMe === true || author === ctx.alias;
  return `<div class="ubp-nz-arow">
    ${avatarHtml(author, '', true)}
    <div class="ubp-nz-amain">
      <div class="ubp-nz-aname">${escapeHtml(author)}${mine ? `<i class="ubp-nz-mask">${escapeHtml(nt('alias', ctx.style))}</i>` : ''}</div>
      <div class="ubp-nz-asub">${escapeHtml(opts.sub || '')}</div>
    </div>
    ${opts.acts || ''}
  </div>`;
}

/** 求解锁/门槛小标。 */
export function nzLockChip(text: string, kind: 'gate' | 'solved' = 'gate'): string {
  return `<span class="ubp-nz-lock ${kind}">${kind === 'gate' ? '🔒' : '🔓'} ${escapeHtml(text)}</span>`;
}

/** 图片占位底纹（未生成时的霓虹渐变，按 key 稳定散列）。
    半透明色值：同一套底纹叠在夜色卡面上=霓虹晕，叠在白色卡面上=淡彩，昼夜两档都不用分叉。 */
function placeholderTint(key: string): string {
  const tints = [
    'rgba(177, 75, 255, 0.30)', 'rgba(63, 110, 255, 0.28)', 'rgba(255, 46, 126, 0.26)',
    'rgba(140, 60, 200, 0.28)', 'rgba(34, 211, 238, 0.24)', 'rgba(255, 194, 75, 0.28)',
  ];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return tints[hash % tints.length];
}

// ─── 分层揭开（N2）：轮廓 → 三区马赛克 → 全图 ───

export interface NzRevealArgs {
  key: string;
  img: NightImage;
  /** 门槛判定用的热度（帖子=赞数；直播间=热度）。 */
  heat: number;
  coins: number;
  /** 呈现尺寸档（决定 class 与交互提示文案）。 */
  variant?: 'card' | 'detail' | 'live' | 'dm' | 'viewer';
}

/**
 * 分层揭开图块（唯一实现；卡片/详情/直播间/搭话/查看器共用）。
 * 四态（未生成/生成中/失败/已生成）× 三级揭示（L0 轮廓 / L1 三区 / L2 全图）。
 */
export function nzRevealBlock(args: NzRevealArgs): string {
  const { key, img } = args;
  const variant = args.variant || 'card';
  const raw = nightImageEffectiveReveal(img);
  // 封面是单张主视觉，没有三区数据：L1「局部」直接呈现全图（不渲染分区马赛克）。
  const reveal = variant === 'live' && raw === 1 ? 2 : raw;
  const ready = Boolean(img.path) && img.status === 'ready';
  // 「生成中」＝落盘 pending **且引擎确实在跑**（整批一次性入队标记，排队中的图同样转圈）；
  // 中断残留的假 pending 不在运行集合里 → 回落「未开始」可点击（与社媒三 App 同款判据）。
  const pending = img.status === 'pending' && isNightImageActive(key);
  const failed = img.status === 'failed';
  const gated = !nightUnlockReady(img, args.heat, args.coins);
  const label = reveal === 0 ? '轮廓' : reveal === 1 ? `局部 ${(img.zones || [false, false, false]).filter(Boolean).length}/3` : '已揭开';

  // 未生成 / 生成中 / 失败：占位（点击=洗照片 / 重试）
  if (!ready) {
    const inner = pending
      ? '<span class="ubp-spinner"></span>'
      : failed ? '<span class="ubp-nz-shotnote">⚠ 生成失败</span>' : ubpIcon('image');
    return `<button type="button" class="ubp-nz-shot none${failed ? ' failed' : ''}" data-ubp-act="gen-img" data-key="${escapeAttr(key)}"
      style="--nz-ph:${escapeAttr(placeholderTint(key))}" ${pending ? 'disabled' : ''}>
      <span class="ubp-nz-shotph">${inner}</span>
      <span class="ubp-nz-shotdesc">${escapeHtml(img.desc)}</span>
      <span class="ubp-nz-shothint">${pending ? '生成中…' : failed ? '点击重试' : (reveal === 0 ? '点击揭开 · 同时洗出这张' : '点击洗出这张')}</span>
    </button>`;
  }

  const imgTag = `<img class="ubp-nz-shotimg" src="${escapeAttr(img.path!)}" alt="" loading="lazy">`;
  if (reveal === 2) {
    // 已揭开（L2）＝全机统一放大（点开灯箱，含「换一张」）；帖子卡/详情另给「⋯」进揭图查看器
    //（再揭一层 / 重新打码 / 存到相册 / 分享到搭话）。封面（live）已是整幅主视觉，保持不可点。
    const zoom = variant === 'live' ? '' : ` data-ubp-act="zoom-img" data-key="${escapeAttr(key)}" title="查看大图" role="button"`;
    const more = (variant === 'card' || variant === 'detail')
      ? `<button type="button" class="ubp-nz-shotmore" data-ubp-act="viewer-open" data-key="${escapeAttr(key)}" title="揭图与操作（再揭一层 · 存到相册 · 分享到搭话）">⋯</button>`
      : '';
    return `<div class="ubp-nz-shot l2 ${variant}"${zoom}>
      ${imgTag}
      ${more}
      <span class="ubp-nz-shotbadge">已揭开</span>
      ${gated ? nzLockChip('需作者同意') : ''}
    </div>`;
  }
  if (reveal === 1) {
    const zones = img.zones || [false, false, false];
    const names = ['脸', '上身', '下身'];
    // 门槛未过时：逐区点击也走「求解锁」（consent 门槛在 L1 同样成立，不再是死角）
    const zoneAct = gated ? 'reveal' : 'zone';
    return `<div class="ubp-nz-shot l1 ${variant}">
      ${imgTag}
      <div class="ubp-nz-zmask">${zones.map((done, i) =>
        done
          ? `<span class="ubp-nz-zn done"></span>`
          : `<button type="button" class="ubp-nz-zn" data-ubp-act="${zoneAct}" data-key="${escapeAttr(key)}" data-idx="${gated ? 1 : i}"><span>${gated ? '求解锁' : names[i]}</span></button>`).join('')}</div>
      <span class="ubp-nz-shotbadge">${escapeHtml(label)}</span>
      ${gated ? nzLockChip('需作者同意') : ''}
    </div>`;
  }
  return `<div class="ubp-nz-shot l0 ${variant}">
    ${imgTag}
    <div class="ubp-nz-silhouette"></div>
    <button type="button" class="ubp-nz-unveil" data-ubp-act="reveal" data-key="${escapeAttr(key)}" data-idx="1">
      <b>◐</b><span>${gated ? '求解锁' : '轮廓 · 点击揭开'}</span>
    </button>
    <span class="ubp-nz-shotbadge">${escapeHtml(label)}</span>
    ${gated ? nzLockChip('需作者同意') : ''}
  </div>`;
}

/** 图集（1-3 张；详情页三图网格）。 */
export function nzGallery(images: readonly NightImage[], opts: { postId: string; heat: number; coins: number; style: PhoneStyle; about?: boolean; variant?: 'card' | 'detail' }): string {
  if (!images.length) return '';
  const variant = opts.variant || 'detail';
  const keyOf = (idx: number): string => (opts.about ? aboutImageKey(opts.postId, idx) : postImageKey(opts.postId, idx));
  const cells = images.map((img, idx) => nzRevealBlock({ key: keyOf(idx), img, heat: opts.heat, coins: opts.coins, variant }));
  if (cells.length === 1) return `<div class="ubp-nz-gallery one">${cells[0]}</div>`;
  return `<div class="ubp-nz-gallery ${cells.length === 2 ? 'two' : 'three'}">${cells.join('')}</div>`;
}

// ─── 评论（复用 social-model.buildCommentThreads 的祖先链扁平化） ───

const NZ_SUB_PREVIEW = 2;

/** 一条评论 + 楼中楼（子回复折叠）。key 用 `nzc:<postId>:<idx>`。 */
export function nzComment(post: NightPost, comment: SocialComment, idx: number, ctx: NightUiCtx, opts: { openThreads: ReadonlySet<string>; postId: string }): string {
  const mine = comment.name === ctx.alias;
  const isAuthor = comment.name === post.author;
  const time = comment.time ? nightTimeText({ time: comment.time, storyStamp: comment.storyStamp, storyTime: post.storyTime }, ctx.now) : '';
  const replyBtn = mine ? '' : `<button type="button" class="ubp-nz-creply" data-ubp-act="reply-c" data-id="${escapeAttr(opts.postId)}" data-idx="${idx}">回复</button>`;
  return `<div class="ubp-nz-cmt" data-nz-cidx="${idx}">
    ${avatarHtml(comment.name, '', true)}
    <div class="ubp-nz-cmain">
      <div class="ubp-nz-cname">${escapeHtml(comment.name)}${isAuthor ? '<i class="ubp-nz-lz">楼主</i>' : ''}${mine ? '<i class="ubp-nz-me">（我）</i>' : ''}</div>
      <div class="ubp-nz-ctext">${comment.replyTo ? `<b>回复 @${escapeHtml(comment.replyTo)}</b>：` : ''}${escapeHtml(comment.text)}</div>
      <div class="ubp-nz-cmeta">${time ? `<span>${escapeHtml(time)}</span>` : ''}${replyBtn}</div>
    </div>
  </div>`;
}

/** 楼中楼容器（超 2 条折叠；与社媒同交互语法）。
    子行带 `data-nz-cidx=扁平数组下标`（与主评论同一个索引口径，app-night 长按按它定位删除）。 */
export function nzSubReplies(post: NightPost, threadKey: string, rootName: string, subs: SocialComment[], ctx: NightUiCtx, openThreads: ReadonlySet<string>, idxOf: ReadonlyMap<SocialComment, number>): string {
  if (!subs.length) return '';
  const open = openThreads.has(threadKey);
  const shown = open ? subs : subs.slice(0, NZ_SUB_PREVIEW);
  const rows = shown.map(sub => {
    const prefix = !sub.replyTo || sub.replyTo === rootName ? '' : `<b>回复 @${escapeHtml(sub.replyTo)}</b>：`;
    const mine = sub.name === ctx.alias;
    const time = sub.time ? nightTimeText({ time: sub.time, storyStamp: sub.storyStamp, storyTime: post.storyTime }, ctx.now) : '';
    return `<div class="ubp-nz-subrow" data-nz-cidx="${idxOf.get(sub) ?? -1}">
      <span class="ubp-nz-subname">${escapeHtml(sub.name)}${mine ? '<i class="ubp-nz-me">（我）</i>' : ''}</span>：${prefix}${escapeHtml(sub.text)}
      ${time ? `<span class="ubp-nz-subtime">${escapeHtml(time)}</span>` : ''}
    </div>`;
  }).join('');
  const fold = subs.length > NZ_SUB_PREVIEW
    ? `<button type="button" class="ubp-nz-subfold" data-ubp-act="sub-open" data-id="${escapeAttr(threadKey)}">${open ? '收起 ‹' : `共 ${subs.length} 条回复 ›`}</button>`
    : '';
  return `<div class="ubp-nz-subs">${rows}${fold}</div>`;
}

/** 评论区（主评论 + 楼中楼）。 */
export function nzCommentSection(post: NightPost, ctx: NightUiCtx, opts: { openThreads: ReadonlySet<string>; postId: string }): string {
  const threads = buildCommentThreads(post.comments);
  const idxOf = new Map<SocialComment, number>();
  post.comments.forEach((c, i) => idxOf.set(c, i));
  const body = threads.map(t => {
    const ci = idxOf.get(t.comment) ?? 0;
    return `<div class="ubp-nz-thread">${nzComment(post, t.comment, ci, ctx, opts)}${nzSubReplies(post, `nzc:${opts.postId}:${ci}`, t.comment.name, t.replies, ctx, opts.openThreads, idxOf)}</div>`;
  }).join('');
  return `<div class="ubp-nz-cmts">
    <div class="ubp-nz-cmthd">共 ${post.comments.length} 条回复</div>
    ${body || '<div class="ubp-nz-empty">还没有人回复，抢一楼？</div>'}
  </div>`;
}

// ─── 帖子卡 / 详情 ───

/** 数据行（赞/收藏/回复/求解锁）。 */
export function nzStatRow(post: NightPost, opts: { withActions?: boolean; postId?: string; privateCollect?: boolean; lockHint?: string } = {}): string {
  const withActions = opts.withActions !== false;
  const id = opts.postId || post.id;
  const countLabel = (n: number): string => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n));
  if (!withActions) {
    return `<div class="ubp-nz-stats">
      <span>${ubpIcon('like')}${countLabel(post.likes)}</span>
      <span>${ubpIcon('star')}${countLabel(post.collects)}</span>
      <span>${ubpIcon('comment')}${post.comments.length}</span>
      ${post.unlockRequests ? `<span class="ubp-nz-lockc">🔓 ${post.unlockRequests}</span>` : ''}
    </div>`;
  }
  return `<div class="ubp-nz-stats acts">
    <button type="button" class="ubp-nz-stat${post.likedByMe ? ' on' : ''}" data-ubp-act="like" data-id="${escapeAttr(id)}">${actIcon(post.likedByMe === true, 'like')}${countLabel(post.likes)}</button>
    <button type="button" class="ubp-nz-stat${post.collectedByMe ? ' on' : ''}" data-ubp-act="collect" data-id="${escapeAttr(id)}" title="${escapeAttr(post.collectPrivate ? '已在私密收藏夹' : '收藏')}">${actIcon(post.collectedByMe === true, 'star')}${countLabel(post.collects)}${post.collectPrivate ? '<i class="ubp-nz-pv">私</i>' : ''}</button>
    <button type="button" class="ubp-nz-stat" data-ubp-act="comment" data-id="${escapeAttr(id)}">${ubpIcon('comment')}${post.comments.length}</button>
    <span class="ubp-nz-stat lock" title="${escapeAttr(opts.lockHint || '求解锁人数')}">🔓 ${post.unlockRequests}</span>
  </div>`;
}

/** 卡片（信息流）。 */
export function nzPostCard(post: NightPost, ctx: NightUiCtx): string {
  const title = nightPostTitle(post);
  const hasImages = post.images.length > 0;
  return `<div class="ubp-nz-card" data-nz-post="${escapeAttr(post.id)}">
    ${hasImages ? nzGallery(post.images, { postId: post.id, heat: post.likes, coins: 0, style: ctx.style, variant: 'card' }) : ''}
    <div class="ubp-nz-cardbody" role="button" data-ubp-act="open-post" data-id="${escapeAttr(post.id)}">
      <div class="ubp-nz-cardtop">
        ${nzBoardChip(post.board, ctx.style)}
        <span class="ubp-nz-spacer"></span>
        ${post.kind === 'bounty' ? '<i class="ubp-nz-kind bounty">委托</i>' : ''}
        ${post.kind === 'live' ? `<i class="ubp-nz-kind live">${escapeHtml(nt('live', ctx.style))}</i>` : ''}
        ${nzSpiceBadge(post.spice, ctx.style)}
      </div>
      <div class="ubp-nz-title">${escapeHtml(title)}</div>
      <div class="ubp-nz-text">${escapeHtml(nightExcerpt(post.content, 62))}</div>
      ${nzTagRow(post.tags)}
      ${post.sourceHint ? `<div class="ubp-nz-src">${escapeHtml(post.sourceHint)}</div>` : ''}
      <div class="ubp-nz-cardfoot">
        ${avatarHtml(post.author, '', true)}
        <span class="ubp-nz-cauthor">${escapeHtml(post.author)}${post.byMe || post.author === ctx.alias ? `<i class="ubp-nz-mask">${escapeHtml(nt('alias', ctx.style))}</i>` : ''}</span>
        <span class="ubp-nz-ctime">${escapeHtml(nightTimeText(post, ctx.now))}</span>
        ${nzStatRow(post, { withActions: false })}
      </div>
    </div>
  </div>`;
}

/** 详情页（正文 + 图区 + 数据行 + 评论区 + 底部栏）。 */
export function nzPostDetail(post: NightPost, ctx: NightUiCtx, opts: { openThreads: ReadonlySet<string>; busy?: boolean }): string {
  const threadsProps = { openThreads: opts.openThreads, postId: post.id };
  const bountyHtml = post.kind === 'bounty' && post.commission
    ? `<div class="ubp-nz-commission">
        <div class="ubp-nz-cmhd">委托要求</div>
        <div class="ubp-nz-cmtext">${escapeHtml(post.commission.want)}</div>
        <div class="ubp-nz-cmmeta">期望尺度 ${escapeHtml(nightSpiceLabel(post.commission.spiceWanted, ctx.style))}${post.commission.reward ? ` · 悬赏 ${escapeHtml(post.commission.reward)}` : ''}</div>
        ${nzTagRow(post.commission.tags, { act: false })}
      </div>`
    : '';
  const entriesHtml = post.kind === 'bounty' && post.entries?.length
    ? `<div class="ubp-nz-entries">
        <div class="ubp-nz-cmhd">应征 ${post.entries.length} 条${post.adoptedEntryId ? ' · 已采纳' : ''}</div>
        ${post.entries.map(e => `<div class="ubp-nz-entry${e.adopted ? ' adopted' : ''}">
          ${avatarHtml(e.author, '', true)}
          <div class="ubp-nz-emain">
            <div class="ubp-nz-ename">${escapeHtml(e.author)}${e.adopted ? '<i class="ubp-nz-adopt">已采纳</i>' : ''}</div>
            <div class="ubp-nz-etext">${escapeHtml(e.text)}</div>
            ${e.image ? `<div class="ubp-nz-eimg">${nzRevealBlock({ key: entryImageKey(post.id, e.id), img: e.image, heat: post.likes, coins: 0, variant: 'card' })}</div>` : ''}
            <div class="ubp-nz-emeta">
              <span>${escapeHtml(nightSpiceLabel(e.spice, ctx.style))}</span>
              ${e.adopted || e.author === ctx.alias ? '' : `<button type="button" class="ubp-nz-mini" data-ubp-act="adopt-entry" data-id="${escapeAttr(post.id)}" data-eid="${escapeAttr(e.id)}">采纳</button>`}
            </div>
          </div>
        </div>`).join('')}
      </div>`
    : '';
  return `<div data-nz-post="${escapeAttr(post.id)}" class="ubp-nz-detail">
    <div class="ubp-nz-cardtop">
      ${nzBoardChip(post.board, ctx.style)}
      <span class="ubp-nz-spacer"></span>
      ${post.kind === 'bounty' ? '<i class="ubp-nz-kind bounty">委托</i>' : ''}
      ${nzSpiceBadge(post.spice, ctx.style)}
    </div>
    ${post.title ? `<div class="ubp-nz-dtitle">${escapeHtml(post.title)}</div>` : ''}
    <div class="ubp-nz-dtext">${escapeHtml(post.content)}</div>
    ${post.liveRef ? `<button type="button" class="ubp-nz-livedoor" data-ubp-act="open-live" data-id="${escapeAttr(post.liveRef)}">正在开台 · 进直播间 ›</button>` : ''}
    ${post.sourceHint ? `<div class="ubp-nz-src">${escapeHtml(post.sourceHint)}</div>` : ''}
    ${post.images.length ? nzGallery(post.images, { postId: post.id, heat: post.likes, coins: 0, style: ctx.style, variant: 'detail' }) : ''}
    ${nzTagRow(post.tags)}
    ${bountyHtml}
    ${entriesHtml}
    ${nzStatRow(post, { postId: post.id, lockHint: '求解锁人数' })}
    <div class="ubp-nz-arow wide">
      ${avatarHtml(post.author, '', true)}
      <div class="ubp-nz-amain">
        <div class="ubp-nz-aname">${escapeHtml(post.author)}${post.byMe || post.author === ctx.alias ? `<i class="ubp-nz-mask">${escapeHtml(nt('alias', ctx.style))}</i>` : ''}</div>
        <div class="ubp-nz-asub">${escapeHtml(nightTimeText(post, ctx.now))}</div>
      </div>
      ${post.byMe || post.author === ctx.alias
        ? ''
        : `<button type="button" class="ubp-nz-follow${ctx.me === post.author ? ' hide' : ''}" data-ubp-act="follow" data-id="${escapeAttr(post.author)}">关注</button>
           <button type="button" class="ubp-nz-follow ghost" data-ubp-act="talk" data-id="${escapeAttr(post.author)}">${escapeHtml(nt('dm', ctx.style))}</button>
           <button type="button" class="ubp-nz-follow ghost" data-ubp-act="persona" data-id="${escapeAttr(post.author)}">档案</button>`}
    </div>
    ${nzCommentSection(post, ctx, threadsProps)}
  </div>`;
}

/** 专题页条目（关于我：带来源线索）。 */
export function nzAboutCard(post: NightPost, ctx: NightUiCtx): string {
  return `<div class="ubp-nz-card about" data-nz-post="${escapeAttr(post.id)}">
    <div class="ubp-nz-cardbody" role="button" data-ubp-act="open-about" data-id="${escapeAttr(post.id)}">
      <div class="ubp-nz-cardtop">
        ${nzBoardChip(post.board, ctx.style)}
        <span class="ubp-nz-spacer"></span>
        ${nzSpiceBadge(post.spice, ctx.style)}
      </div>
      <div class="ubp-nz-title">${escapeHtml(nightPostTitle(post))}</div>
      <div class="ubp-nz-text">${escapeHtml(nightExcerpt(post.content, 72))}</div>
      ${post.sourceHint ? `<div class="ubp-nz-src">${escapeHtml(post.sourceHint)}</div>` : ''}
      ${nzTagRow(post.tags, { act: false })}
      <div class="ubp-nz-cardfoot">
        ${avatarHtml(post.author, '', true)}
        <span class="ubp-nz-cauthor">${escapeHtml(post.author)}</span>
        <span class="ubp-nz-ctime">${escapeHtml(nightTimeText(post, ctx.now))}</span>
        ${nzStatRow(post, { withActions: false })}
      </div>
    </div>
  </div>`;
}

/** 弹幕行（直播间；被点名高亮）。 */
export function nzBarrageRow(name: string, text: string, opts: { tint?: string; spotlight?: boolean; byMe?: boolean } = {}): string {
  // 昵称色只给 token，实际色值由 CSS 按昼夜取（淡霓虹在暗底上好看，在白卡上直接读不出）
  return `<div class="ubp-nz-bar${opts.spotlight ? ' spot' : ''}${opts.byMe ? ' me' : ''}">
    <span class="ubp-nz-barname" style="--nz-bar-tint:${escapeAttr(opts.tint || nightTintOf(name))}">${escapeHtml(name)}</span>
    <span class="ubp-nz-bartext">${escapeHtml(text)}</span>
    ${opts.spotlight ? '<i class="ubp-nz-spot">点名</i>' : ''}
  </div>`;
}

/** 空态（CP-01：一句状态；hint 只在确有必要时给，不再写指路长文）。 */
export function nzEmpty(title: string, hint = ''): string {
  return `<div class="ubp-nz-empty big"><b>${escapeHtml(title)}</b>${hint ? `<br>${escapeHtml(hint)}` : ''}</div>`;
}

export type { NightAbout, NightPost, NightImage };
