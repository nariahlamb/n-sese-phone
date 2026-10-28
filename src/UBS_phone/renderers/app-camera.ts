// ===== 相机 App：选角色（多选）+ 选地点（主项目地图存储）+ 描述 → 两步法生图（docs/02 §8） =====
// 拍照与聊天图片共用两步法管线（chat-images）：第一步提示词 = 出镜角色资料块 +
// 【拍摄地点】（地图存储描述信息）+【图片内容】，不带正文/聊天上下文；第二步生图 + 上传。
// 完成即入相册（完整参数），可在相册随时按档案重绘。
// 表单控件与选择弹层用 camera-shot 共享模块（微信私聊➕拍照同款）。

import { generatePhoneImage, getImageError, resolvePhoneImageConfig } from '../core/chat-images';
import { readPhoneMapLocations } from '../core/map-locations';
import { addPhoneAlbumEntries, makeAlbumEntryId, regenAlbumImage } from '../core/phone-album';
import { composeShotDesc, type PhoneGenRecord } from '../core/chat-model';
import { readAiChatHistory } from '../core/chat-engine';
import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { bindRosterInvalidation, getRoster } from '../core/roster';
import { S } from '../core/skins';
import { feedback } from '../core/device-feedback';
import type { ImageGenRecord } from '../../unified-statusbar/core/image-gen';
import { openPhoneLightbox } from './image-lightbox';
import { emitPhoneEvent, type PhoneApp, type PhoneAppContext } from './app-registry';
import { escapeAttr, escapeHtml } from './phone-ui';
import { openShotCharPicker, openShotLocationPicker, shotFormHtml, shotSubjects, type ShotFormState } from './camera-shot';
import { ubpIcon } from './icons';
import { achFlag, emitAch, emitActionOnDate } from '../core/phone-achievements';

interface CameraState extends ShotFormState {
  busy: boolean;
  error: string;
  /** 最近一张（本会话内存态）：entryId 用于换一张；path 用于预览。 */
  lastShot: { entryId: string; path: string } | null;
}

let _ctx: PhoneAppContext | null = null;
const _state: CameraState = {
  selected: [],
  locationId: '',
  desc: '',
  useRefStoryContext: false,
  busy: false,
  error: '',
  locations: [],
  locationsLoaded: false,
  lastShot: null,
};

function render(): void {
  if (!_ctx) return;
  const container = _ctx.container;
  const selectedCount = _state.selected.length;
  const canShoot = !_state.busy && _state.desc.trim().length >= 5;
  // 整页 innerHTML 会换掉滚动容器（.ubp-appbody）：矮屏上滚到表单下部点选角色/地点/重拍后
  // 不该弹回顶部（内容反而变高，位置必然够得着；首次进入取不到容器 = 0，无副作用）
  const prevTop = container.querySelector('.ubp-appbody')?.scrollTop ?? 0;

  container.innerHTML = `
    <div class="ubp-appbar">
      <button class="ubp-iconbtn" data-ubp-act="back" title="返回">${ubpIcon('back')}</button>
      <span class="ubp-appbar-title">${S('相机', '留影')}</span>
      <button class="ubp-iconbtn" data-ubp-act="open-album" title="${S('相册', '影阁')}">${ubpIcon('album')}</button>
    </div>
    <div class="ubp-appbody">
      <div class="ubp-cam-stage">
        ${_state.busy
          ? `<div class="ubp-cam-pending"><span class="ubp-spinner"></span><span>${S('取景中…', '凝景显影中…', '凝景显影中…', '镜中光影凝聚中…')}<br>${escapeHtml(_state.desc.slice(0, 40))}</span></div>`
          : _state.lastShot
            ? `<img class="ubp-cam-preview" src="${escapeAttr(_state.lastShot.path)}" alt="" data-ubp-act="lightbox" data-id="${escapeAttr(_state.lastShot.path)}" title="点击放大">
               <div class="ubp-cam-actions">
                 <button class="ubp-btn" data-ubp-act="reshoot">${S('再拍一张', '再留一影')}</button>
                 <button class="ubp-btn primary" data-ubp-act="regen-last" ${resolvePhoneImageConfig().error ? 'disabled' : ''}>${S('换一张', '再显一影')}</button>
               </div>`
            : `<div class="ubp-cam-empty">${ubpIcon('camera')}<span>${S('选择角色与地点，描述画面，拍下这一刻', '择人物与之地，述其景象，留此一瞬')}</span></div>`}
      </div>
      ${_state.error ? `<div class="ubp-cam-error">${escapeHtml(_state.error)}</div>` : ''}
      <div class="ubp-cam-form">
        ${shotFormHtml(_state)}
        <button class="ubp-btn primary ubp-cam-shutter" data-ubp-act="shoot" ${canShoot ? '' : 'disabled'}>
          ${selectedCount ? `${selectedCount} ${S('人入镜', '人入影')} · ` : ''}${S('拍摄', '留影')}
        </button>
      </div>
    </div>`;
  const body = container.querySelector('.ubp-appbody');
  if (body && prevTop) body.scrollTop = prevTop;
}

function handleClick(event: Event): void {
  const el = (event.target as HTMLElement).closest('[data-ubp-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.dataset.ubpAct || '';
  const id = el.dataset.id || '';
  switch (act) {
    case 'back': _ctx?.closeApp(); break;
    case 'open-album': _ctx?.openApp('album'); break;
    case 'pick-chars':
      if (_ctx) openShotCharPicker(_ctx.container, { selected: _state.selected, onConfirm: ids => { _state.selected = ids; render(); } });
      break;
    case 'pick-loc':
      if (_ctx) openShotLocationPicker(_ctx.container, { onPick: (locId, locations) => { _state.locationId = locId; _state.locations = locations; _state.locationsLoaded = true; render(); } });
      break;
    case 'toggle-ctx': _state.useRefStoryContext = (el as HTMLInputElement).checked; break;  // 原生已切，仅记状态，不重绘以免丢描述焦点
    case 'shoot': void shoot(); break;
    case 'reshoot': _state.lastShot = null; _state.desc = ''; _state.error = ''; render(); break;
    case 'regen-last': void regenLast(); break;
    case 'lightbox': {
      openPhoneLightbox(_ctx?.container, { paths: [id] });
      break;
    }
    default: break;
  }
}
function handleInput(event: Event): void {
  const target = event.target as HTMLElement;
  if (target.id === 'ubp-cam-desc') {
    _state.desc = (target as HTMLTextAreaElement).value;
    const btn = _ctx?.container.querySelector('[data-ubp-act="shoot"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = _state.busy || _state.desc.trim().length < 5;
  }
}

async function shoot(): Promise<void> {
  if (_state.busy) return;
  const desc = _state.desc.trim();
  if (desc.length < 5) return;
  feedback('shutter'); // 快门「咔嚓」（I-3；拍下去就响，与能否生成无关）
  const config = resolvePhoneImageConfig();
  if (config.error) {
    _state.error = config.error;
    render();
    return;
  }
  const roster = getRoster();
  const location = _state.locations.find(l => l.nodeId === _state.locationId) || null;
  const subjects = shotSubjects(_state.selected);
  // 开启「引用最新正文」时，取主项目最近一层 AI 回复（经上下文标签剥离）作为生图参考
  const storyContext = _state.useRefStoryContext ? stripWithContextConfig(readAiChatHistory(1)) : '';
  // 相册描述 = 出镜角色 + 地点 + 用户描述拼接（转发/档案展示用；生图提示词仍按 subjects/location 分块组装）
  const shotDesc = composeShotDesc(subjects.map(s => s.name), location ? location.fullPath : '', desc);
  const jobId = `camera_${Date.now().toString(36)}`;
  let genRecord: ImageGenRecord | undefined;
  let fixedPrompt = '';
  let fixedNegative = '';
  _state.busy = true;
  _state.error = '';
  _state.lastShot = null;
  render();
  try {
    const path = await generatePhoneImage({
      messageId: jobId,
      description: desc,
      subjects,
      roster,
      location,
      ...(storyContext ? { chatContext: storyContext, contextLabel: '最近正文进展' } : {}),
      stem: `camera_${Date.now().toString(36)}`,
      onPromptReady: (promptText, negativePrompt) => { fixedPrompt = promptText; fixedNegative = negativePrompt; },
      onRecord: record => { genRecord = record; },
    });
    const entryId = makeAlbumEntryId();
    addPhoneAlbumEntries([{
      id: entryId,
      path,
      source: 'camera',
      characters: subjects.map(s => s.name),
      desc: shotDesc,
      ...(fixedPrompt ? { imagePrompt: fixedPrompt, imageNegative: fixedNegative } : {}),
      ...(genRecord ? { gen: genRecord as unknown as PhoneGenRecord } : {}),
      createdAt: Date.now(),
    }]);
    _state.lastShot = { entryId, path };
    emitPhoneEvent('ubp-phone:data-changed');
    // L9 成就：玩家亲手拍摄成功（入相册）+ 日窗口伴随（今天拍过照）
    emitAch('phone_photo_taken', {
      source: 'camera',
      hasChars: achFlag(subjects.length > 0),
      hasLocation: achFlag(!!location),
      hasStoryCtx: achFlag(!!storyContext),
    });
    emitActionOnDate('phone_photo');
  } catch (e) {
    _state.error = getImageError(jobId) || (e instanceof Error ? e.message : String(e));
  } finally {
    _state.busy = false;
    render();
  }
}

async function regenLast(): Promise<void> {
  if (_state.busy || !_state.lastShot) return;
  _state.busy = true;
  _state.error = '';
  render();
  try {
    const result = await regenAlbumImage(_state.lastShot.entryId);
    if (result.ok) {
      _state.lastShot = { entryId: _state.lastShot.entryId, path: result.path };
      // L9 成就：重绘（换一张）成功也计入拍摄；地点/正文情境无法从条目还原，置 0（不计打卡/忠实记录）
      emitAch('phone_photo_taken', {
        source: 'camera',
        hasChars: achFlag(shotSubjects(_state.selected).length > 0),
        hasLocation: 0,
        hasStoryCtx: 0,
      });
    } else _state.error = result.error;
  } finally {
    _state.busy = false;
    render();
  }
}

export const cameraApp: PhoneApp = {
  id: 'camera',
  name: '相机',
  icon: ubpIcon('camera'),
  color: '#8E8E93',
  available: true,
  mount(ctx: PhoneAppContext): (() => void) | void {
    _ctx = ctx;
    _state.busy = false;
    _state.error = '';
    _state.lastShot = null;
    ctx.container.addEventListener('click', handleClick);
    ctx.container.addEventListener('input', handleInput);
    bindRosterInvalidation();
    render();
    // 预读地点（缓存热身 + 「暂无地点」提示；打开地点弹层时会再按需刷新）
    void readPhoneMapLocations().then(locations => {
      _state.locations = locations;
      _state.locationsLoaded = true;
      if (_ctx === ctx) render();
    }).catch(() => {
      _state.locationsLoaded = true;
      if (_ctx === ctx) render();
    });
    return () => {
      ctx.container.removeEventListener('click', handleClick);
      ctx.container.removeEventListener('input', handleInput);
      _ctx = null;
    };
  },
};
