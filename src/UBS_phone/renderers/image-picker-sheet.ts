// ===== 统一选图弹层（小手机全部选图入口共用）=====
// 图源标签页（立绘图库 / 文生图图库 / 手机相册）+ 3 列缩略图网格（复用相册 App 的
// .ubp-album-grid/.ubp-album-cell/.ubp-album-src）+ 底部动作钮，点缩略图即选即关。
//
// 两档语义决定开放哪些图源（调用方只传 mode，不逐处拼图源表）：
//   context（发图/配图）：图片的中文描述要进 AI 上下文 → 只列「有描述」的图（相册条目 desc /
//     文生图条目 description=AI desc: 行），无描述的条目隐藏并给出条数提示；因此不给立绘图库
//     （小手机侧的立绘索引是只读轻量视图，没有描述字段）、不给本地导入（新图无描述）。
//   setting（头像/背景/封面/壁纸）：纯展示位，三源齐备，可导入本地图片、可恢复默认。
//
// 文生图页只列**当前角色卡**那批（主项目插图图库是全局的，跨聊天/跨卡共享；收窄在
// core/phone-backgrounds.storyGalleryImages，口径与主项目写入侧同一函数）。立绘页本就按角色名取。
//
// 只读纪律（docs/03 §3）：立绘索引 usb_portraits_* 与文生图图库 usb_global_story-images_* 都属
// 主项目写域，本弹层只读不写（图库的删除/重绘归主项目自己的图库弹窗）。
// 自挂载 overlay，不依赖宿主 App 的 overlay 状态机；z-index 压过发帖面板（见 phone-theme）。

import type { PhoneAlbumEntry } from '../core/chat-model';
import type { ImageOrigin } from '../core/forward-model';
import { addPhoneAlbumEntries, albumSourceLabel, albumSourceOptions, makeAlbumEntryId, readPhoneAlbumRef } from '../core/phone-album';
import { hasCrop, readCrop, setCrop } from '../core/phone-crops';
import { importPhoneImageFromDataUrl, loadStoryImageGallery, storyGalleryImages } from '../core/phone-backgrounds';
import { openCropSheet } from './crop-sheet';
import {
  clearCustomAvatar,
  hasCustomAvatar,
  portraitGallery,
  PROTAGONIST_AVATAR_KEY,
  refreshPhoneAvatars,
  resolveAvatarPath,
  setCustomAvatar,
} from '../core/phone-avatars';
import { hostDocument } from '../core/host-env';
import { emitAch } from '../core/phone-achievements';
import { S, currentStyle } from '../core/skins';
import { escapeAttr, escapeHtml, pushSheetCloser } from './phone-ui';
import { hydrateGridThumbs } from './grid-thumbs';
import { ubpIcon } from './icons';

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
/** 相册页展示上限（相册上限 200 张，弹层只露最近的，防长列表卡顿；靠来源筛选 chips 定位更老的图）。 */
const MAX_CELLS = 60;

/** 图源：立绘图库（角色上下文）/ 文生图图库（主项目正文插图）/ 手机相册。 */
export type PickerSource = 'portrait' | 'story' | 'album';

type StoryEntry = ReturnType<typeof storyGalleryImages>[number];

/** 选中的图片（setting 档只用 path）。 */
export interface PickedImage {
  path: string;
  /** 中文描述：相册条目 desc / 文生图条目 description；立绘与无描述条目为空串。 */
  desc: string;
  source: PickerSource;
  /** 相册来源信息（来源 App + 发帖人）：context 档调用方据此把出处拼进描述（composeImageDesc）。 */
  origin?: ImageOrigin;
}

export interface ImagePickerOptions {
  /** 'context'=描述要进 AI 上下文（发图/配图）；'setting'=纯展示位（头像/背景/封面/壁纸）。 */
  mode: 'context' | 'setting';
  title?: string;
  /** 角色上下文（头像/通话背景/私聊聊天背景/作者封面）→ 多一个「立绘图库」标签页。 */
  portraitName?: string;
  /** 取景声明（docs/13）：声明了才在两个出口（选中/导入）前过取景闸门，并多一颗「调整取景」；
   *  不声明 = 出口逐字走现状。ratio=显示位宽高比（预览框同比例）；slot=参数槽位（av:/cv:/cb:/bg:/home/wb:）；
   *  kind 与目标显示位渲染机制一致（img=object-fit:cover，bg=背景图层）。 */
  crop?: { ratio: number; slot: string; kind?: 'img' | 'bg'; title?: string };
  /** 「调整取景」应用后的回调（仅重取景路径：图未换，调用方重渲染即可）。 */
  onCropAdjusted?: () => void;
  /** 当前值（展示位预览缩略图）。 */
  current?: string;
  /** 有当前值时的说明（默认「当前」）。 */
  currentText?: string;
  /** 无当前值时的说明（如「默认用对方头像铺底」）。 */
  defaultText?: string;
  /** 缩略图悬停标题（无描述时用，如「设为头像」）。 */
  pickTip?: string;
  /** 「导入图片」动作（setting 档专用；不传不显示，图床落到 phone_ 目录）。 */
  onImport?: (path: string) => void;
  /** 「恢复默认」动作（setting 档专用；不传不显示——调用方按「确有自定义值可清」判定）。 */
  onReset?: () => void;
  onPick: (img: PickedImage) => void;
  /** 相册页空态文案（默认按皮肤给出）。 */
  emptyText?: string;
}

/** 网格一行（三源统一形态；描述单独留出供 onPick 回传）。 */
interface Row {
  path: string;
  desc: string;
  /** 角标：相册=来源；立绘/文生图=无（文生图页整页同卡、立绘页整页同角色，角标无信息量）。 */
  badge: string;
  title: string;
  /** 相册行专属：来源 App + 发帖人（拼进描述用；文生图/立绘无）。 */
  origin?: ImageOrigin;
  /** 相册行专属：收藏标记（渲染星星角标；其余图源恒无）。 */
  fav?: boolean;
}

/** 打开统一选图弹层（幂等：先移除同容器旧弹层）。 */
export function openImagePickerSheet(container: HTMLElement, opts: ImagePickerOptions): void {
  closeImagePickerSheet(container);
  const doc = hostDocument();
  const style = currentStyle();
  const isCtx = opts.mode === 'context';

  const tabs: PickerSource[] = opts.portraitName && !isCtx ? ['portrait', 'story', 'album'] : ['story', 'album'];
  const tabLabel: Record<PickerSource, string> = { portrait: '立绘图库', story: '文生图图库', album: '手机相册' };
  // 默认页：有立绘则立绘（与旧头像/背景弹层一致），否则相册——相册是内存快照零读盘，
  // 文生图页首次切入才读盘（对齐旧背景弹层的惰性图源纪律）。
  let active: PickerSource = tabs[0] === 'portrait' ? 'portrait' : 'album';
  let activeRows: Row[] = [];
  let albumFilter = '';
  let favOnly = false; // 相册页：只看收藏（与来源筛选正交叠加）

  // 相册快照：整弹层生命周期只读一次（O43 起为零拷贝引用读，但仍禁按次重读）
  let albumEntries: PhoneAlbumEntry[] | null = null;
  const ensureAlbum = (): PhoneAlbumEntry[] => (albumEntries ??= readPhoneAlbumRef()); // O43：零拷贝读（弹层内只读）
  // 文生图图库：惰性读盘（首次切到该页）
  let storyState: 'idle' | 'loading' | 'ready' = 'idle';
  let storyEntries: StoryEntry[] = [];

  const hasCurrentRow = Boolean(opts.current || opts.defaultText);
  const overlay = doc.createElement('div');
  overlay.className = 'ubp-overlay ubp-imgpick-sheet';
  overlay.innerHTML = `
    <div class="ubp-sheet">
      <div class="ubp-sheet-head">
        <span class="ubp-sheet-headtitle">${escapeHtml(opts.title || S('选择图片', '选取画面'))}</span>
        <button type="button" class="ubp-sheet-x" data-ubp-ip="cancel" title="关闭">✕</button>
      </div>
      ${hasCurrentRow ? `<div class="ubp-ip-cur">
        ${opts.current ? `<img src="${escapeAttr(opts.current)}" alt="">` : '<span class="ubp-ip-none">默认</span>'}
        <span class="ubp-ip-curname">${escapeHtml(opts.current ? (opts.currentText || '当前') : (opts.defaultText || '默认'))}</span>
      </div>` : ''}
      <div class="ubp-iptabs">${tabs.map(id =>
        `<button class="ubp-iptab${id === active ? ' on' : ''}" data-ubp-iptab="${id}">${tabLabel[id]}</button>`).join('')}</div>
      <div class="ubp-ip-chips"></div>
      ${!isCtx && (opts.onReset || opts.onImport || (opts.crop && opts.current && hasCrop(opts.crop.slot))) ? `<div class="ubp-ip-tools">
        ${opts.crop && opts.current && hasCrop(opts.crop.slot) ? `<button class="ubp-ip-tool" data-ubp-ip="recrop">调整取景</button>` : ''}
        ${opts.onReset ? `<button class="ubp-ip-tool" data-ubp-ip="reset">恢复默认</button>` : ''}
        ${opts.onImport ? `<button class="ubp-ip-tool" data-ubp-ip="import">导入图片</button>` : ''}
      </div>` : ''}
      <div class="ubp-ip-body"></div>
      <div class="ubp-sheet-err" hidden></div>
      <div class="ubp-sheet-actions">
        <button class="ubp-btn" data-ubp-ip="cancel">取消</button>
        ${isCtx ? '' : '<button class="ubp-btn primary" data-ubp-ip="done">完成</button>'}
      </div>
      <input type="file" accept="image/*" class="ubp-ip-file" style="display:none;">
    </div>`;
  container.appendChild(overlay);

  const chipsEl = overlay.querySelector('.ubp-ip-chips') as HTMLElement;
  const bodyEl = overlay.querySelector('.ubp-ip-body') as HTMLElement;
  const errEl = overlay.querySelector('.ubp-sheet-err') as HTMLElement;
  const fileInput = overlay.querySelector('.ubp-ip-file') as HTMLInputElement;

  const close = (): void => {
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
  };
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
  doc.addEventListener('keydown', onKeydown, true);
  pushSheetCloser(close, () => overlay.isConnected);

  /** 该图源的候选行 + 被隐藏（无描述）条数。仅 context 档过滤无描述条目。 */
  const rowsOf = (src: PickerSource): { rows: Row[]; hidden: number } => {
    if (src === 'portrait') {
      return { rows: portraitGallery(opts.portraitName || '').map(path => ({
        path, desc: '', badge: '', title: opts.pickTip || '选用此图',
      })), hidden: 0 };
    }
    const rows: Row[] = [];
    let hidden = 0;
    if (src === 'album') {
      const all = ensureAlbum();
      for (const e of albumFilter ? all.filter(e => e.source === albumFilter) : all) {
        if (favOnly && !e.fav) continue;
        const desc = (e.desc || '').trim();
        if (isCtx && !desc) { hidden++; continue; }
        rows.push({
          path: e.path, desc, badge: albumSourceLabel(e.source, style), title: desc,
          origin: { source: e.source, poster: (e.characters[0] || '').trim() },
          fav: e.fav === true,
        });
      }
    } else {
      // 已收窄到当前角色卡：不设展示上限、也不打角标（整页同卡，角标必然重复＝纯噪声）
      for (const e of storyEntries) {
        const desc = (e.description || '').trim();
        if (isCtx && !desc) { hidden++; continue; }
        rows.push({ path: e.path, desc, badge: '', title: desc || '无画面描述' });
      }
    }
    return { rows, hidden };
  };

  // 网格显示缩略图（docs/70）：三页签（立绘/文生图/相册）同一份格子口径，src 交 hydrateGridThumbs 回填
  const cellHtml = (row: Row): string =>
    `<button type="button" class="ubp-album-cell" data-ubp-ip-path="${escapeAttr(row.path)}" title="${escapeAttr(row.title)}">`
    + `<img data-ubp-thumb="${escapeAttr(row.path)}" alt="" loading="lazy" decoding="async">`
    + (row.badge ? `<span class="ubp-album-src">${escapeHtml(row.badge)}</span>` : '')
    + (row.fav ? `<span class="ubp-album-fav" title="已收藏">${ubpIcon('star')}</span>` : '')
    + '</button>';

  const emptyText = (src: PickerSource): string => {
    if (src === 'portrait') return '该角色还没有立绘图库';
    if (src === 'album') return favOnly
      ? '还没有收藏的图片（在相册 App 里点开图片即可收藏）'
      : (opts.emptyText || S('相册还是空的', '影阁还是空的', '画匣还是空的', '画廊还是空的'));
    return storyState === 'ready'
      ? '当前角色卡还没有正文插图——在主项目为这张卡生成插图后会出现在这里'
      : '文生图图库加载中…';
  };

  /** 筛选 chips：只有相册有（来源 + 收藏）；文生图页已收窄到当前角色卡，无需再筛。 */
  const chipOptions = (): Array<{ id: string; label: string }> =>
    active === 'album' ? albumSourceOptions(style) : [];

  const renderChips = (): void => {
    const options = chipOptions();
    if (options.length <= 1) { chipsEl.innerHTML = ''; return; }
    chipsEl.innerHTML = `<button type="button" class="ubp-chip${favOnly ? ' on' : ''}" data-ubp-ip="fav">★ 收藏</button>`
      + options.map(o =>
        `<button type="button" class="ubp-chip${albumFilter === o.id ? ' on' : ''}" data-ubp-ip="filter" data-id="${escapeAttr(o.id)}">${escapeHtml(o.label)}</button>`,
      ).join('');
  };

  const renderBody = (): void => {
    if (storyState === 'loading') { activeRows = []; bodyEl.innerHTML = `<div class="ubp-ip-empty">${emptyText(active)}</div>`; return; }
    const { rows, hidden } = rowsOf(active);
    activeRows = rows;
    if (!rows.length) {
      // 有图但全被隐藏（context 档）时不能报「还是空的」，要说清为什么不可选
      bodyEl.innerHTML = hidden
        ? `<div class="ubp-ip-empty">这里的 ${hidden} 张图没有画面描述——描述要写进上下文，图片才能被 AI 读懂</div>`
        : `<div class="ubp-ip-empty">${escapeHtml(emptyText(active))}</div>`;
      return;
    }
    // 无描述提示只在 context 档、且确有被隐藏的条目时出现（解释「图为什么不在列表里」）
    const note = hidden
      ? `<div class="ubp-ip-note">已隐藏 ${hidden} 张没有画面描述的图片——描述要写进上下文，图片才能被 AI 读懂</div>`
      : '';
    // 文生图页已按当前角色卡收窄且无筛选钮，全量列出（免更老的图够不到）；相册仍只露最近 60 张
    const list = active === 'album' ? rows.slice(0, MAX_CELLS) : rows;
    bodyEl.innerHTML = `${note}<div class="ubp-album-grid">${list.map(cellHtml).join('')}</div>`;
    hydrateGridThumbs(bodyEl); // 缩略图回填与渲染同帧（命中缓存无闪烁；切页签/筛选重跑本函数幂等）
  };

  const showErr = (text: string): void => {
    errEl.textContent = text;
    errEl.hidden = !text;
  };

  const ensureStoryLoaded = (): void => {
    if (storyState !== 'idle') return;
    storyState = 'loading';
    renderBody();
    void loadStoryImageGallery(true).then(() => {
      storyEntries = storyGalleryImages();
      storyState = 'ready';
      if (active === 'story') renderBody();
    });
  };

  // 立绘图库惰性刷新（本次会话内主项目新生成的立绘，切到该页即见；失败保留现快照渲染）
  let portraitRefreshed = false;
  const ensurePortraitFresh = (): void => {
    if (portraitRefreshed) return;
    portraitRefreshed = true;
    void refreshPhoneAvatars().then(() => {
      if (overlay.isConnected && active === 'portrait') renderBody();
    });
  };

  // 取景闸门（docs/13）：声明了 crop 的调用点，两个出口先过取景、应用才放行原回调；
  // 未声明则逐字走现状。参数属于槽位不属于图（换图保留，复位可清）。
  const throughCrop = (src: string, done: () => void): void => {
    const crop = opts.crop;
    if (!crop) { done(); return; }
    openCropSheet(container, {
      src,
      ratio: crop.ratio,
      kind: crop.kind,
      ...(crop.title ? { title: crop.title } : {}),
      params: readCrop(crop.slot),
      onApply: params => { setCrop(crop.slot, params); done(); },
    });
  };

  overlay.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement;
    if (target === overlay) { close(); return; } // 点背景=取消
    const el = target.closest('[data-ubp-ip],[data-ubp-ip-path],[data-ubp-iptab]') as HTMLElement | null;
    if (!el) return;
    if (el.dataset.ubpIptab) {
      const next = el.dataset.ubpIptab as PickerSource;
      if (next !== active) {
        active = next;
        overlay.querySelectorAll<HTMLElement>('.ubp-iptab').forEach(b => b.classList.toggle('on', b.dataset.ubpIptab === next));
        renderChips();
        renderBody();
      }
      if (next === 'story') ensureStoryLoaded();
      else if (next === 'portrait') ensurePortraitFresh();
      return;
    }
    if (el.dataset.ubpIpPath) {
      const row = activeRows.find(r => r.path === el.dataset.ubpIpPath);
      if (row) {
        close();
        throughCrop(row.path, () => opts.onPick({ path: row.path, desc: row.desc, source: active, ...(row.origin ? { origin: row.origin } : {}) }));
      }
      return;
    }
    const act = el.dataset.ubpIp || '';
    if (act === 'cancel' || act === 'done') {
      close();
    } else if (act === 'recrop') {
      // 调整取景：不换图，只重取参数（对当前值直接开取景弹层；应用后由调用方重渲染）
      const crop = opts.crop;
      if (crop && opts.current) {
        close();
        openCropSheet(container, {
          src: opts.current,
          ratio: crop.ratio,
          kind: crop.kind,
          ...(crop.title ? { title: crop.title } : {}),
          params: readCrop(crop.slot),
          onApply: params => { setCrop(crop.slot, params); opts.onCropAdjusted?.(); },
        });
      }
    } else if (act === 'filter') {
      const next = el.dataset.id || '';
      if (next !== albumFilter) { albumFilter = next; renderChips(); renderBody(); }
    } else if (act === 'fav') {
      favOnly = !favOnly;
      renderChips();
      renderBody();
    } else if (act === 'reset') {
      close();
      opts.onReset?.();
    } else if (act === 'import') {
      showErr('');
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showErr('图片过大（超过 8MB），请压缩后再试');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => showErr('读取图片失败');
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl.startsWith('data:image/')) {
        showErr('仅支持图片文件');
        return;
      }
      showErr('');
      const importBtn = overlay.querySelector('[data-ubp-ip="import"]') as HTMLButtonElement | null;
      if (importBtn) importBtn.disabled = true;
      importPhoneImageFromDataUrl(dataUrl)
        .then(path => {
          close();
          // D₉ 导入即入相册（docs/13）：来源「导入」可筛；取景取消不回滚条目——文件已上传，入档即事实。
          // 无描述 ⇒ context 档选图列表天然不可见（预期；展示位 setting 档全量可见）
          addPhoneAlbumEntries([{
            id: makeAlbumEntryId(),
            path,
            source: 'import',
            characters: [],
            desc: '',
            createdAt: Date.now(),
          } satisfies PhoneAlbumEntry]);
          throughCrop(path, () => opts.onImport?.(path));
        })
        .catch((e: unknown) => {
          if (importBtn) importBtn.disabled = false;
          showErr(String((e as Error)?.message || e || '图片上传失败'));
        });
    };
    reader.readAsDataURL(file);
  });

  renderChips();
  renderBody();
  // 默认页只有立绘/相册两种（文生图首次切入才读盘），立绘页顺手刷一次主项目最新立绘
  if (active === 'portrait') ensurePortraitFresh();
}

/** 移除容器内已存在的统一选图弹层。 */
export function closeImagePickerSheet(container: HTMLElement): void {
  container.querySelector('.ubp-imgpick-sheet')?.remove();
}

// ===== 头像选定预设（微信资料卡 / 设置·我的头像共用；头像语义只此一份） =====

/** 打开头像选定弹层（setting 档：立绘/文生图/相册三源 + 导入 + 恢复默认）。
 *  name = 角色名或 PROTAGONIST_AVATAR_KEY；「恢复默认」只在确有自定义头像时出现（清掉后回落主项目立绘）。 */
export function openAvatarPickerSheet(
  container: HTMLElement,
  name: string,
  opts: { title?: string; onChanged?: () => void } = {},
): void {
  const write = (path: string): void => {
    setCustomAvatar(name, path);
    // L9 成就：玩家亲手换头像成功（取景调整 onCropAdjusted / 恢复默认 onReset 都不算）
    emitAch('phone_avatar_changed', { target: name === PROTAGONIST_AVATAR_KEY ? 'me' : 'char' });
    opts.onChanged?.();
  };
  openImagePickerSheet(container, {
    mode: 'setting',
    title: opts.title || `更换头像 · ${name === PROTAGONIST_AVATAR_KEY ? '我' : name}`,
    portraitName: name,
    crop: { ratio: 1, slot: `av:${name}`, kind: 'img', title: '头像' },
    current: resolveAvatarPath(name),
    currentText: '当前头像',
    defaultText: '默认用主项目立绘',
    pickTip: '设为头像',
    onPick: img => write(img.path),
    onImport: write,
    onCropAdjusted: opts.onChanged,
    ...(hasCustomAvatar(name) ? { onReset: () => { clearCustomAvatar(name); opts.onChanged?.(); } } : {}),
  });
}
