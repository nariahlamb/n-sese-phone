// ===== 朋友圈 App：熟人动态流（快照流） =====
// 手动刷新：refreshSocialSnapshot('moments') 一次生成整版（动态+评论成型）→ 滚动窗口落盘。
// 配图两步法按需生图：AI 只出画面描述；「自动生图」开启时刷新后自动逐张生成，否则点击占位生成
// （复用相册 addPhoneAlbumEntries source='moments' 入档；出镜角色=发帖人恒带+描述点名者，聊天同款）。
// P3.2 互动层：点赞/评论/回复（本地即时生效，记入待反馈清单）+ 发动态（附图走微信同款：
// 拍照描述生图 / 相册选图）+ 顶栏「求回应」（跨平台一次 AI 请求生成角色回应——增量协议）。

import {
  abortSocialGeneration,
  addSocialComment,
  createUserPost,
  deleteSocialComment,
  deleteUserPost,
  readPendingActionsRef,
  isFeedbackGenerating,
  markAllNotificationsRead,
  refreshSocialSnapshot,
  toggleLike,
} from '../core/social-engine';
import { isPhoneAbortError } from '../core/phone-error';
import { readSocialOf, socialExcerpt, paginateFeed, FEED_PAGE_SIZE, type MomentPost } from '../core/social-model';
import { buildShareMessage, composeImageDesc, type SharePostSnapshot } from '../core/forward-model';
import { commentTimeText, postTimeText } from '../core/social-time';
import { collectSocialPostSubjects, composeShootDesc, socialPosterName } from '../core/chat-image-prompts';
import { readPhoneDataRef, mutatePhoneData } from '../core/phone-store';
import { getPhoneSettings } from '../core/phone-settings';
import { getRoster } from '../core/roster';
import { addPhoneAlbumEntries, makeAlbumEntryId } from '../core/phone-album';
import { generatePhoneImage, resolvePhoneImageConfig } from '../core/chat-images';
import type { ImageGenRecord } from '../../unified-statusbar/core/image-gen';
import type { PhoneGenRecord } from '../core/chat-model';
import { emitPhoneEvent, onPhoneEvent, type PhoneApp, type PhoneAppContext } from './app-registry';
import { openImagePickerSheet } from './image-picker-sheet';
import { appendForwardedMessage, openForwardTargetSheet } from './forward-sheet';
import { avatarHtml, bindLongPress, escapeAttr, escapeHtml, longPressJustFired, openActionSheet } from './phone-ui';
import { openActionSheet as openActionSheetCore, openConfirmSheet } from './action-sheet';
import { bindHintLongPress } from './hint-sheet';
import { bindFeedScroll, createSocialFeedKit, feedMoreHtml, markFeedScrollRestore, anonRowHtml } from './social-shell';
import { currentStyle, s, momentsSkinProfile, type MomentsSkinProfile } from '../core/skins';
import { actIcon, ubpIcon } from './icons';
import { openPhoneLightbox } from './image-lightbox';
import { achFlag, emitAch, emitActionOnDate } from '../core/phone-achievements';

let _ctx: PhoneAppContext | null = null;
let _busy = false;          // 快照刷新中
// 帧级皮肤档案（render 开头刷新；现代=null 走现代文案——docs/15：浮生帖/故人笺/篝火手记）
let _P: MomentsSkinProfile | null = null;
/** 正在生图的动态 id（**整批入队即登记**：用户定案 2026-10-06「统一小手机口径」——排队等串行生图的
 *  动态与在跑的那条同样显示「生成中」；中断＝整批释放，等待中的回落「未开始」可点击）。 */
const _imgBusyIds = new Set<string>();
let _autoRunning = false;   // 自动生图队列运行中
let _error = '';
// 上次失败尝试（重试钮重放：人物选择+额外提示+定点范围；成功后随横幅消失，下次生成覆盖）
let _lastAttempt: { action: 'refresh' | 'feedback'; hint: string; picked: string[] } | null = null;
// 信息流公共件：实现单一事实源在 social-shell.createSocialFeedKit（同名解构 → 全 App 调用点零改动）
const feedKit = createSocialFeedKit({
  container: () => _ctx?.container ?? null,
  isBusy: () => _busy,
  isFeedbackBusy: isFeedbackGenerating,
  setError: msg => { _error = msg; },
  rememberFeedbackAttempt: (hint, picked) => { _lastAttempt = { action: 'feedback', hint, picked }; },
  render: () => render(),
  onLoadMore: () => { _feedVisible += FEED_PAGE_SIZE; },
  onRefreshConfirm: (hint, picked) => { void doRefresh(hint, picked); },
});
const { toast, openRefreshHint, openFeedbackHint, doFeedback, loadMoreFeed } = feedKit;
// 信息流分页状态：初屏只渲染最近 FEED_PAGE_SIZE 条，触底/扩页递增（mount 重置）
let _feedVisible = FEED_PAGE_SIZE;
let _feedHasMore = false;   // 渲染帧回写：触底监听与自动扩页共用
// 互动层状态
let _composer: {
  mode: 'post' | 'comment';
  postId?: string;
  replyTo?: string;
  text: string;
  imgPath: string;
  imgDesc: string;
  cameraMode: boolean;
  /** 匿名发布（true=以匿名账号发出，名称取 anonName 或默认「匿名用户」）。 */
  anon: boolean;
  anonName: string;
} | null = null;

function currentMoments(): MomentPost[] {
  return readSocialOf(readPhoneDataRef()).moments; // O42：只读切片，零拷贝
}

function setMomentImageStatus(postId: string, status: 'pending' | 'ready' | 'failed'): void {
  mutatePhoneData(d => {
    if (!d.social) return;
    const target = d.social.moments.find(m => m.id === postId);
    if (target) target.imageStatus = status;
  });
}

/** 正文渲染：@主角 蓝色高亮。 */
function renderMomentText(text: string, me: string): string {
  const esc = escapeHtml(text);
  if (!me) return esc;
  const token = `@${escapeHtml(me)}`;
  return esc.split(token).join(`<span class="ubp-mo-at">${token}</span>`);
}

function renderComments(post: MomentPost, me: string, now: string): string {
  const rows = post.comments.map((c, i) => {
    const mine = c.name === me;
    const mineTag = mine || c.anon === true;   // 匿名评论也标淡色「（我）」——仅本机可见，不影响任何注入
    const reply = c.replyTo ? `回复<span class="ubp-mo-cname">${escapeHtml(c.replyTo)}</span>：` : '：';
    const time = c.time ? `<span class="ubp-mo-ctime">${escapeHtml(commentTimeText(c, post, now))}</span>` : '';
    const replyBtn = mine ? '' : `<button type="button" class="ubp-mo-creply" data-ubp-act="reply-c" data-id="${escapeAttr(post.id)}" data-idx="${i}">回复</button>`;
    return `<div class="ubp-mo-crow" data-ubp-cidx="${i}"><span class="ubp-mo-cname${mine ? ' me' : ''}">${escapeHtml(c.name)}${mineTag ? '<i class="ubp-mo-metag">（我）</i>' : ''}</span>${reply}${escapeHtml(c.text)}${time}${replyBtn}</div>`;
  }).join('');
  return rows ? `<div class="ubp-mo-comments">${rows}</div>` : '';
}

function renderLikes(post: MomentPost): string {
  if (!post.likes.length) return '';
  const mine = post.likes.includes(getRoster().protagonistName); // 我在其中 → 实心心（与四 App 的开关图标同一份选择）
  return `<div class="ubp-mo-likes">${actIcon(mine, 'like')}<span>${_P ? `${escapeHtml(_P.likeNoun)} · ` : ''}${post.likes.map(escapeHtml).join('、')}</span></div>`;
}

function renderImage(post: MomentPost): string {
  if (!post.imageDesc) return '';
  if (post.imagePath && post.imageStatus === 'ready') {
    return `<button type="button" class="ubp-mo-img" data-ubp-act="zoom" data-id="${escapeAttr(post.imagePath)}" title="查看大图">
      <img src="${escapeAttr(post.imagePath)}" alt="" loading="lazy"></button>`;
  }
  const busy = _imgBusyIds.has(post.id);
  const failed = post.imageStatus === 'failed';
  return `<button type="button" class="ubp-mo-imgph${failed ? ' failed' : ''}" data-ubp-act="gen-image" data-id="${escapeAttr(post.id)}" ${busy ? 'disabled' : ''}>
    ${busy ? '<span class="ubp-spinner"></span>' : failed ? '<span class="ubp-mo-imgph-note">⚠ 生成失败</span>' : ubpIcon('image')}
    <span class="ubp-mo-imgph-desc">${escapeHtml(post.imageDesc)}</span>
    <span class="ubp-mo-imgph-hint">${busy ? '配图生成中…' : failed ? '点击重试' : '点击生成配图'}</span>
  </button>`;
}

function renderPost(post: MomentPost, me: string, now: string): string {
  const liked = post.likes.includes(me);
  const foot = renderLikes(post) || renderComments(post, me, now)
    ? `<div class="ubp-mo-foot">${renderLikes(post)}${renderComments(post, me, now)}</div>`
    : '';
  return `<div class="ubp-mo-post" data-mo-id="${escapeAttr(post.id)}">
    <div class="ubp-mo-head">${avatarHtml(post.author)}
      <div class="ubp-mo-headmain">
        <span class="ubp-mo-author">${escapeHtml(post.author)}${post.author === me || post.anon ? '<i class="ubp-mo-metag">（我）</i>' : ''}</span>
        <span class="ubp-mo-time">${escapeHtml(postTimeText(post, now))}</span>
      </div>
    </div>
    <div class="ubp-mo-text">${renderMomentText(post.text, me)}</div>
    ${renderImage(post)}
    <div class="ubp-mo-actbar">
      <span class="ubp-mo-acthint">${liked ? s(currentStyle(), '已赞', '已赞', '已赞', '已赞') : s(currentStyle(), '赞', '赞', '赞', '赞')} · ${s(currentStyle(), '评论', '评论', '评论', '评论')}</span>
      <button type="button" class="ubp-mo-more" data-ubp-act="post-menu" data-id="${escapeAttr(post.id)}" title="${s(currentStyle(), '互动', '互动', '互动', '互动')}">···</button>
    </div>
    ${foot}
  </div>`;
}

// ─── 分享到聊天（统一转发模块：forward-model 转换 + forward-sheet 目标弹层） ───

/** 动态 → 分享快照（正文+配图+评论；成品图引用 imagePath；楼中楼压回复前缀）。 */
function momentShareSnapshot(post: MomentPost): SharePostSnapshot {
  return {
    app: 'moments',
    author: post.author,
    text: post.text,
    images: post.imageDesc
      ? [{ desc: post.imageDesc, ...(post.imagePath && post.imageStatus === 'ready' ? { imagePath: post.imagePath } : {}) }]
      : [],
    comments: post.comments.map(c => ({
      name: c.name,
      text: c.text,
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
    })),
  };
}

/** 分享到聊天：动态转「聊天记录」消息 → 弹目标选择 → 落库（整条算一条消息，上屏不触发 AI）。 */
function sharePostToChat(post: MomentPost): void {
  if (!_ctx) return;
  const message = buildShareMessage(momentShareSnapshot(post), getRoster().global.time);
  if (!message) return;
  openForwardTargetSheet(_ctx, pick => {
    if (appendForwardedMessage(pick, message)) {
      // L9 成就：玩家亲手把帖子分享到聊天成功
      emitAch('phone_share_to_chat', { platform: 'moments' });
      toast('已分享到聊天');
    }
  });
}

// ─── 长按操作面板（动态=分享/删除；评论/回复=删除，连带楼中楼子回复） ───

function openPostActionSheet(postId: string): void {
  if (!_ctx) return;
  const post = currentMoments().find(p => p.id === postId);
  if (!post) return;
  openActionSheet(_ctx.container, {
    title: socialExcerpt(post.text, 24),
    items: [
      { act: 'share', label: '分享到聊天' },
      { act: 'del', label: `删除${_P?.postNoun || '动态'}`, danger: true },
    ],
    onPick: act => {
      if (act === 'share') {
        const cur = currentMoments().find(p => p.id === postId);
        if (cur) sharePostToChat(cur);
        return;
      }
      if (act !== 'del') return;
      if (!_ctx) return;
      openConfirmSheet(_ctx.container, {
        title: '删除这条动态？',
        message: '删除后无法恢复。',
        confirmLabel: '删除',
        onConfirm: () => {
          try {
            deleteUserPost('moments', postId);
            // L9 成就：玩家亲手删除帖子成功（失败分支不打点）
            emitAch('phone_post_deleted', { platform: 'moments' });
            emitPhoneEvent('ubp-phone:data-changed');
            toast('已删除');
          } catch (e) {
            toast(e instanceof Error ? e.message : String(e));
          }
          render();
        },
      });
    },
  });
}

/** 互动菜单（SO-03：真实朋友圈模型——常显只留「赞 · 评论」灰字 + ⋯，三动作收进弹出菜单）。 */
function openPostMenu(postId: string): void {
  if (!_ctx) return;
  const post = currentMoments().find(p => p.id === postId);
  if (!post) return;
  const liked = post.likes.includes(getRoster().protagonistName);
  openActionSheetCore(_ctx.container, {
    title: post.author,
    actions: [
      { label: liked ? '取消赞' : '赞', onPick: () => { if (toggleLike('moments', postId).liked) emitAch('phone_like_given', { platform: 'moments' }); emitPhoneEvent('ubp-phone:data-changed'); render(); } },
      { label: '评论', onPick: () => openComposer('comment', postId) },
      { label: '分享到聊天', onPick: () => sharePostToChat(post) },
      { label: s(currentStyle(), '取消', '作罢', '作罢', '作罢'), onPick: () => { /* 取消 */ } },
    ],
  });
}

function openCommentDeleteSheet(postId: string, idx: number): void {
  if (!_ctx) return;
  const target = currentMoments().find(p => p.id === postId)?.comments[idx];
  if (!target) return;
  openActionSheet(_ctx.container, {
    title: `删除 ${target.name} 的这条${target.replyTo ? '回复' : '评论'}？`,
    body: '其楼中楼的子回复将一并删除，删除后不可恢复。',
    items: [{ act: 'del', label: '删除', danger: true }],
    onPick: act => {
      if (act !== 'del') return;
      try {
        deleteSocialComment('moments', postId, idx);
        emitPhoneEvent('ubp-phone:data-changed');
        toast('已删除');
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      render();
    },
  });
}

// ─── 编辑面板（发动态 / 评论 / 回复） ───

function renderComposer(): string {
  if (!_composer) return '';
  const c = _composer;
  const title = c.mode === 'post' ? (_P?.postVerb || '发动态') : c.replyTo ? `回复 ${c.replyTo}` : `写${_P?.commentNoun || '评论'}`;
  const attach = c.mode !== 'post' ? '' : c.imgPath
    ? `<div class="ubp-mo-attach"><span class="ubp-mo-attachchip">${ubpIcon('image')}${escapeHtml(c.imgDesc || '已选图片')}<button type="button" class="ubp-mo-attachx" data-ubp-act="compose-detach">×</button></span></div>`
    : c.cameraMode
      ? `<textarea class="ubp-textarea" data-ubp-input="compose-imgdesc" rows="2" placeholder="照片内容描述（发布后按描述生成图片）">${escapeHtml(c.imgDesc)}</textarea>
         <div class="ubp-mo-attachrow"><button type="button" class="ubp-btn" data-ubp-act="compose-attach-album">改从相册选择</button><button type="button" class="ubp-btn" data-ubp-act="compose-detach">取消附图</button></div>`
      : `<div class="ubp-mo-attachrow"><button type="button" class="ubp-btn" data-ubp-act="compose-attach-camera">${ubpIcon('camera')}拍照描述生图</button><button type="button" class="ubp-btn" data-ubp-act="compose-attach-album">${ubpIcon('album')}从相册选择</button></div>`;
  const sendable = c.text.trim() && (c.mode === 'comment' || !c.cameraMode || c.imgDesc.trim() || c.imgPath);
  return `<div class="ubp-overlay ubp-mo-composer">
    <div class="ubp-sheet">
      <div class="ubp-sheet-title">${escapeHtml(title)}</div>
      <textarea class="ubp-textarea" data-ubp-input="compose-text" rows="3"
        placeholder="${c.mode === 'post' ? (_P?.composerLead || '此刻的想法…') : c.replyTo ? `回复 ${c.replyTo}…` : '说点什么…'}">${escapeHtml(c.text)}</textarea>
      ${anonRowHtml(c.anon, c.anonName)}
      ${attach}
      <div class="ubp-sheet-actions">
        <button type="button" class="ubp-btn" data-ubp-act="compose-cancel">取消</button>
        <button type="button" class="ubp-btn primary" data-ubp-act="compose-send" ${sendable ? '' : 'disabled'}>${c.mode === 'post' ? '发布' : '发送'}</button>
      </div>
    </div>
  </div>`;
}

function openComposer(mode: 'post' | 'comment', postId?: string, replyTo?: string): void {
  _composer = { mode, postId, replyTo, text: '', imgPath: '', imgDesc: '', cameraMode: false, anon: false, anonName: '' };
  render();
}

function closeComposer(): void {
  _composer = null;
  render();
}

function openAlbumPicker(): void {
  if (!_ctx || !_composer) return;
  openImagePickerSheet(_ctx.container, {
    mode: 'context',
    title: '从相册选择',
    emptyText: '相册还是空的——用「拍照描述生图」先拍一张',
    onPick: img => {
      if (!_composer) return;
      _composer.imgPath = img.path;
      _composer.imgDesc = composeImageDesc(img.desc, img.origin); // 拼来源（「小明的小红书：…」）；描述要进 AI 上下文
      _composer.cameraMode = false;
      render();
    },
  });
}

async function sendComposer(): Promise<void> {
  if (!_composer) return;
  const c = _composer;
  const text = c.text.trim();
  if (!text) return;
  if (c.mode === 'post') {
    const { postId } = createUserPost({
      kind: 'moments',
      text,
      ...(c.anon ? { anon: true, anonName: c.anonName } : {}),
      ...(c.imgPath ? { imagePath: c.imgPath } : {}),
      imageDesc: c.imgPath ? c.imgDesc : c.cameraMode ? composeShootDesc(c.imgDesc, getRoster()) : '',
    });
    _composer = null;
    render();
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：玩家亲手发布成功（附图意图即算 hasImage；匿名按开关）
    emitAch('phone_post_published', {
      platform: 'moments',
      hasImage: achFlag(!!c.imgPath || (c.cameraMode && c.imgDesc.trim())),
      anon: achFlag(c.anon),
      isRepost: 0,
    });
    emitActionOnDate('phone_post');
    toast(c.anon ? '已匿名发布' : '已发布');
    if (c.cameraMode && c.imgDesc.trim()) void generateMomentImage(postId, false);
    return;
  }
  if (!c.postId) return;
  addSocialComment({ kind: 'moments', postId: c.postId, text, ...(c.replyTo ? { replyTo: c.replyTo } : {}), ...(c.anon ? { anon: true, anonName: c.anonName } : {}) });
  _composer = null;
  render();
  emitPhoneEvent('ubp-phone:data-changed');
  // L9 成就：玩家亲手评论/楼中楼成功
  emitAch('phone_comment_posted', { platform: 'moments', isReply: achFlag(!!c.replyTo) });
}

// ─── 生图 ───

/**
 * 自动生图队列（autoImageGen 开启时刷新后自动补图）：**整批一次性入队标记**——
 * 本批全部待生成动态开工前就登记（排队中的同样显示「生成中」），随后串行逐张、每张收尾释放自己；
 * 中断（离开 App / 异常）＝ finally 整批释放，未跑到的回落「未开始」可点击。
 */
async function autoGenerateImages(): Promise<void> {
  if (_autoRunning) return;
  if (!getPhoneSettings().autoImageGen) return;
  const config = resolvePhoneImageConfig();
  if (config.error || !config.provider) return;
  _autoRunning = true;
  const batch = currentMoments()
    .filter(p => p.imageDesc && !p.imagePath && p.imageStatus !== 'failed' && !_imgBusyIds.has(p.id))
    .map(p => p.id);
  for (const id of batch) _imgBusyIds.add(id);
  try {
    for (const id of batch) {
      const next = currentMoments().find(p => p.id === id);
      if (!_ctx) break; // 离开 App=中断：剩余标记在 finally 整批释放
      if (!next || !next.imageDesc || next.imagePath || next.imageStatus === 'failed') { _imgBusyIds.delete(id); continue; }
      await generateMomentImage(id, true);
    }
  } finally {
    for (const id of batch) _imgBusyIds.delete(id);
    _autoRunning = false;
  }
}

/** 两步法按需生图（出镜角色=发帖人仅通讯录/主角带档案+描述点名者；成功入相册 source='moments'）。
 *  忙标记：批量泵已整批预登记（auto 分支照常跑），手动单张在这里自己登记；已在生成/排队的吞掉重复点击。 */
async function generateMomentImage(postId: string, auto: boolean): Promise<void> {
  if (_imgBusyIds.has(postId) && !auto) return;
  const post = currentMoments().find(p => p.id === postId);
  if (!post || !post.imageDesc) return;
  const config = resolvePhoneImageConfig();
  if (config.error || !config.provider) {
    if (!auto) toast(config.error || '生图配置不可用（设置 → API → 生图）');
    return;
  }
  _error = '';
  _imgBusyIds.add(postId);
  setMomentImageStatus(postId, 'pending');
  render();
  const roster = getRoster();
  const jobId = `moment_${postId}`;
  let genRecord: ImageGenRecord | undefined;
  let fixedPrompt = '';
  let fixedNegative = '';
  try {
    const subjects = collectSocialPostSubjects(post.author, post.imageDesc, roster);
    const path = await generatePhoneImage({
      messageId: jobId,
      description: post.imageDesc,
      subjects,
      roster,
      stem: `moment_${postId.replace(/^s_/, '')}`,
      fixed: post.imagePrompt ? { promptText: post.imagePrompt, negativePrompt: post.imageNegative || '' } : undefined,
      onPromptReady: (promptText, negativePrompt) => {
        fixedPrompt = promptText;
        fixedNegative = negativePrompt;
        mutatePhoneData(d => {
          if (!d.social) return;
          const target = d.social.moments.find(m => m.id === postId);
          if (target) {
            target.imagePrompt = promptText;
            target.imageNegative = negativePrompt;
          }
        });
      },
      onRecord: record => { genRecord = record; },
    });
    mutatePhoneData(d => {
      if (!d.social) return;
      const target = d.social.moments.find(m => m.id === postId);
      if (target) {
        target.imagePath = path;
        target.imageStatus = 'ready';
      }
    });
    const poster = socialPosterName(post.author, roster);
    addPhoneAlbumEntries([{
      id: makeAlbumEntryId(),
      path,
      source: 'moments',
      characters: poster ? [poster] : [], // 只记发帖人（来源角色）；画面里出现谁由描述文字承载
      desc: post.imageDesc,
      ...(fixedPrompt ? { imagePrompt: fixedPrompt, imageNegative: fixedNegative } : {}),
      ...(genRecord ? { gen: genRecord as unknown as PhoneGenRecord } : {}),
      createdAt: Date.now(),
    }]);
    emitPhoneEvent('ubp-phone:data-changed');
  } catch (_e) {
    setMomentImageStatus(postId, 'failed');
  } finally {
    _imgBusyIds.delete(postId); // 这一条收尾（成功/失败都释放）：批内其余动态仍挂着队列标记继续转圈
    if (_ctx) render();
  }
}

// ─── 刷新与求回应 ───

async function doRefresh(hint?: string, picked?: string[]): Promise<void> {
  if (_busy) return;
  _busy = true;
  _lastAttempt = { action: 'refresh', hint: hint || '', picked: picked || [] };
  _error = '';
  render();
  try {
    await refreshSocialSnapshot({ kind: 'moments', ...(hint ? { extraHint: hint } : {}) , ...(picked && picked.length ? { focusNames: picked } : {}) });
    emitPhoneEvent('ubp-phone:data-changed');
    toast(`${_P?.appName ? `${_P.appName}已刷新` : '朋友圈已刷新'}`);
  } catch (e) {
    _error = isPhoneAbortError(e) ? '' : (e instanceof Error ? e.message : String(e));
  } finally {
    _busy = false;
    render();
    void autoGenerateImages();
  }
}

// ─── 渲染与事件 ───

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const prevBody = container.querySelector<HTMLElement>('.ubp-appbody');
  const prevScrollTop = prevBody?.scrollTop ?? 0;
  const roster = getRoster();
  const me = roster.protagonistName;
  const now = roster.global.time;
  _P = momentsSkinProfile(currentStyle()); // 帧级皮肤档案（浮生帖/故人笺/篝火手记；现代=null）
  const posts = currentMoments();
  const { page, hasMore, remaining } = paginateFeed(posts, _feedVisible); // 只渲染最近 N 条，余下触底加载
  _feedHasMore = hasMore;
  const pendingCount = readPendingActionsRef().length; // 零拷贝读（朋友圈帧内已有 posts 深拷贝，这里不再全量深拷贝）
  const fbBusy = isFeedbackGenerating();

  const bodyHtml = page.length
    ? page.map(p => renderPost(p, me, now)).join('') + (hasMore ? feedMoreHtml(remaining) : '')
    : `<div class="ubp-empty"><b>${_P?.appName || '朋友圈'}还没有${_P?.postNoun || '动态'}</b><button class="ubp-empty-btn" data-ubp-act="refresh">刷新</button></div>`;

  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="back" title="返回桌面">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${escapeHtml(_P?.appName || '朋友圈')}</span>
      ${pendingCount ? `<button class="ubp-iconbtn ubp-fbbadge" data-ubp-act="feedback" title="求回应" ${fbBusy || _busy ? 'disabled' : ''}>${ubpIcon('comment')}<i>${pendingCount}</i></button>` : ''}
      <button class="ubp-iconbtn" data-ubp-act="refresh" title="刷新" ${_busy ? 'disabled' : ''}>
        <span class="${_busy ? 'ubp-spin' : ''}" style="display:inline-flex;">${ubpIcon('refresh')}</span>
      </button>
    </div>
    <div class="ubp-appbody">
      ${_error ? `<div class="ubp-mo-error">${escapeHtml(_error)}<button class="ubp-mo-retry" data-ubp-act="retry-gen">重试</button></div>` : ''}
      ${_busy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>正在刷新${escapeHtml(_P?.appName || '朋友圈')}…<button class="ubp-btn" data-ubp-act="abort">终止</button></div>` : ''}
      ${fbBusy ? `<div class="ubp-mo-loading"><span class="ubp-spinner"></span>正在生成互动回应…<button class="ubp-btn" data-ubp-act="abort">终止</button></div>` : ''}
      ${bodyHtml}
      <div style="height:64px;"></div>
    </div>
    <button type="button" class="ubp-mo-fab" data-ubp-act="compose-post" title="${escapeAttr(_P?.postVerb || '发动态')}">${ubpIcon('plus')}</button>
    ${renderComposer()}`;
  const body = container.querySelector<HTMLElement>('.ubp-appbody');
  if (body) {
    body.scrollTop = prevScrollTop;
    markFeedScrollRestore(body); // 保位填回的这条位置：补派的 scroll 不算用户滚动（免得白扩一页）
    // 视口未满且有更多 → 自动扩页（不然触底监听永远够不着；有界递归，每层固定吃掉一页）
    if (hasMore && body.scrollHeight <= body.clientHeight + 1) loadMoreFeed();
  }
}

function handleClick(event: Event): void {
  if (longPressJustFired()) return; // 长按分享刚触发：吞掉残留 click
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const id = el.dataset.id || '';
  switch (act) {
    case 'back': _ctx?.closeApp(); break;
    case 'refresh': void doRefresh(); break;
    case 'abort': abortSocialGeneration(); break;
    case 'feedback': void doFeedback(); break;
    case 'retry-gen': {
      if (!_lastAttempt) break;
      if (_lastAttempt.action === 'refresh') void doRefresh(_lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined);
      else void doFeedback(_lastAttempt.hint || undefined, _lastAttempt.picked.length ? [..._lastAttempt.picked] : undefined);
      break;
    }
    case 'post-menu': openPostMenu(id); break;
    case 'like': {
      // L9 成就：点赞（取消赞不计）
      if (toggleLike('moments', id).liked) emitAch('phone_like_given', { platform: 'moments' });
      emitPhoneEvent('ubp-phone:data-changed');
      render();
      break;
    }
    case 'comment': openComposer('comment', id); break;
    case 'share': {
      const post = currentMoments().find(p => p.id === id);
      if (post) sharePostToChat(post);
      break;
    }
    case 'reply-c': {
      const idx = Number(el.dataset.idx || '-1');
      const post = currentMoments().find(p => p.id === id);
      const target = post?.comments[idx];
      if (target) openComposer('comment', id, target.name);
      break;
    }
    case 'compose-post': openComposer('post'); break;
    case 'compose-cancel': closeComposer(); break;
    case 'compose-anon':
      if (_composer) { _composer.anon = !_composer.anon; render(); }
      break;
    case 'compose-attach-camera':
      if (_composer) { _composer.cameraMode = true; _composer.imgPath = ''; render(); }
      break;
    case 'compose-attach-album': openAlbumPicker(); break;
    case 'compose-detach':
      if (_composer) { _composer.imgPath = ''; _composer.imgDesc = ''; _composer.cameraMode = false; render(); }
      break;
    case 'compose-send': void sendComposer(); break;
    case 'gen-image': void generateMomentImage(id, false); break;
    case 'zoom': {
      openPhoneLightbox(_ctx?.container, { paths: [id] });
      break;
    }
    default: break;
  }
}

function handleInput(event: Event): void {
  const el = event.target as HTMLElement;
  const field = el.dataset?.ubpInput;
  if (!field || !_composer) return;
  const value = (el as HTMLTextAreaElement).value;
  if (field === 'compose-text') _composer.text = value;
  else if (field === 'compose-imgdesc') _composer.imgDesc = value;
  else if (field === 'compose-anonname') _composer.anonName = value;
  // 交互态原地更新（渲染纪律）：发送按钮解禁不整帧重绘
  const c = _composer;
  const sendable = Boolean(c.text.trim()) && (c.mode === 'comment' || !c.cameraMode || Boolean(c.imgDesc.trim()) || Boolean(c.imgPath));
  const btn = _ctx?.container.querySelector('[data-ubp-act="compose-send"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = !sendable;
}

export const momentsApp: PhoneApp = {
  id: 'moments',
  name: '朋友圈',
  icon: ubpIcon('moments'),
  color: '#4A90D9',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _error = '';
    _imgBusyIds.clear();
    _composer = null;
    _feedVisible = FEED_PAGE_SIZE; // 分页重置：首屏只渲染最近10条
    markAllNotificationsRead('moments'); // 朋友圈无消息页：看信息流即整平台已读（真机红点语义）
    ctx.container.addEventListener('click', handleClick);
    ctx.container.addEventListener('input', handleInput);
    // 长按「刷新/求回应」=一次性提示
    const unbindHintLongPress = bindHintLongPress(ctx.container, target => {
      if (target.closest('[data-ubp-act="refresh"]')) return { el: target.closest('[data-ubp-act="refresh"]') as HTMLElement, fire: openRefreshHint };
      if (target.closest('[data-ubp-act="feedback"]')) return { el: target.closest('[data-ubp-act="feedback"]') as HTMLElement, fire: openFeedbackHint };
      return null;
    });
    const unbindFeedScroll = bindFeedScroll(ctx.container, () => _feedHasMore, loadMoreFeed);
    // 长按委托：动态卡=操作面板（分享/删除，朋友圈此前无删除入口），评论行=删除面板
    const unbindLongPress = bindLongPress(
      ctx.container,
      t => t.closest('[data-ubp-cidx]') || t.closest('.ubp-mo-post[data-mo-id]'),
      el => {
        const cidx = el.dataset.ubpCidx;
        if (cidx !== undefined) {
          const postId = el.closest('.ubp-mo-post')?.getAttribute('data-mo-id') || '';
          if (postId) openCommentDeleteSheet(postId, Number(cidx));
          return;
        }
        openPostActionSheet(el.dataset.moId || '');
      },
    );
    render();
    // 挂载时补跑自动生图（上次刷新后未完成的配图）
    void autoGenerateImages();
    // L18②(第十二轮)：外部投递（正文联动 / 世界演化）落库后，正打开的社媒 App 也能立即看到新帖。
    // 订阅在挂载期生效、卸载即退订（同 app-spy 范式）；重渲由 _ctx 守卫兜住已卸载场景。
    const offDataChanged = onPhoneEvent('ubp-phone:data-changed', () => { if (_ctx) render(); });

    return () => {
      ctx.container.removeEventListener('click', handleClick);
      ctx.container.removeEventListener('input', handleInput);
      unbindHintLongPress();
      unbindFeedScroll();
      unbindLongPress();
      offDataChanged();
      _ctx = null;
    };
  },
};
