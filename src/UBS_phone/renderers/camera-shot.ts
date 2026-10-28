// ===== 拍照表单共享控件（相机 App 与微信私聊➕拍照同款；docs/02 §8） =====
// 出镜角色多选（≤3，可不选，选了谁谁出镜）+ 拍摄地点（主项目地图）+ 画面描述 + 引用最新正文开关。
// 本模块只管 UI 与选择弹层；生成接线各 App 自理（相机=拍摄入相册，私聊=消息进会话走生图泵）。
// 事件约定：字段/开关 data-ubp-act 固定为 pick-chars / pick-loc / toggle-ctx，描述 textarea id=ubp-cam-desc。

import type { PhoneImageSubject } from '../core/chat-image-prompts';
import { readPhoneMapLocations, type PhoneMapLocation } from '../core/map-locations';
import { getRoster } from '../core/roster';
import { S } from '../core/skins';
import { escapeHtml } from './phone-ui';
import { openPickerSheet, type PickerGroup } from './picker-sheet';

/** 单次拍照出镜角色上限（含主角；与生图提示词 subject 上限一致）。 */
export const MAX_SHOT_CHARACTERS = 3;

/** 出镜角色多选里的主角哨兵。 */
export const SHOT_ME = '__me__';

export interface ShotFormState {
  /** 出镜角色（SHOT_ME 哨兵或角色名）。 */
  selected: string[];
  /** 拍摄地点 nodeId；'' = 未选。 */
  locationId: string;
  locations: PhoneMapLocation[];
  locationsLoaded: boolean;
  desc: string;
  /** 引用主项目最近一层 AI 正文回复作为生图参考（默认关）。 */
  useRefStoryContext: boolean;
}

/** 表单主体（角色/地点/描述/正文开关四段；不含拍摄·发送按钮与外层容器）。 */
export function shotFormHtml(state: ShotFormState): string {
  const protagonist = getRoster().protagonistName || getRoster().userName || '我';
  const selNames = state.selected.map(id => id === SHOT_ME ? protagonist : id).join('、');
  const loc = state.locations.find(l => l.nodeId === state.locationId) || null;
  return `
    <div class="ubp-cam-sec"><b>${S('出镜角色', '入影人物')}</b>（${S('多选', '可多择')} ≤${MAX_SHOT_CHARACTERS}，可不选）<button type="button" class="ubp-cam-field" data-ubp-act="pick-chars"><span class="ubp-cam-field-val${selNames ? '' : ' placeholder'}">${selNames
      ? `${escapeHtml(selNames)}（${state.selected.length}/${MAX_SHOT_CHARACTERS}）`
      : S('点击选择出镜角色（可不选）', '点选入影人物（可不选）')}</span><span class="ubp-cam-field-more">›</span></button></div>
    <div class="ubp-cam-sec"><b>${S('拍摄地点', '取景之地', '取景之地', '取景之境')}</b>（${S('主项目地图', '主项目舆图')}）<button type="button" class="ubp-cam-field" data-ubp-act="pick-loc"><span class="ubp-cam-field-val${loc ? '' : ' placeholder'}">${loc ? escapeHtml(loc.fullPath) : S('不指定（画面由描述决定）', '不指定（画面随心念而定）')}</span><span class="ubp-cam-field-more">›</span></button>
      ${state.locationsLoaded && !state.locations.length ? `<div class="ubp-cam-field-hint">${S('主项目地图暂无已探索（含描述）地点', '舆图暂无已探明（含记述）之地')}</div>` : ''}</div>
    <div class="ubp-cam-sec"><b>${S('照片描述', '画面描述')}</b><textarea class="ubp-textarea" id="ubp-cam-desc" rows="3" placeholder="${S('画面内容描述（谁在做什么、氛围、构图…，至少 5 字）', '画面描述（何人在做何事、气韵、格局…，至少 5 字）')}">${escapeHtml(state.desc)}</textarea></div>
    <div class="ubp-cam-sec ubp-cam-ctx-row">
      <label class="ubp-cam-ctx-label" for="ubp-cam-ctx"><b>${S('引用最新正文', '援引最新正文')}</b><span class="ubp-cam-ctx-hint">${S('带入主项目最近一层 AI 回复供衔接画面', '带入主项目最近一层 AI 回复以衔接画面')}</span></label>
      <label class="ubp-switch"><input type="checkbox" id="ubp-cam-ctx" data-ubp-act="toggle-ctx" ${state.useRefStoryContext ? 'checked' : ''}><span class="ubp-switch-track"></span><span class="ubp-switch-knob"></span></label>
    </div>`;
}

/** 出镜角色选择 → 生图 subjects（主角哨兵换主角名）。 */
export function shotSubjects(selected: string[]): PhoneImageSubject[] {
  const roster = getRoster();
  const protagonistName = roster.protagonistName || roster.userName || '我';
  return selected.map(id => id === SHOT_ME ? { name: protagonistName, isProtagonist: true } : { name: id, isProtagonist: false });
}

/** 出镜角色选择弹层：主角置顶 + 通讯录按类别分组，搜索命中名字/介绍。 */
export function openShotCharPicker(container: HTMLElement, opts: { selected: string[]; onConfirm: (ids: string[]) => void }): void {
  const roster = getRoster();
  const protagonist = roster.protagonistName || roster.userName || '我';
  const toItem = (c: { name: string; brief: string; identity: string }) =>
    ({ id: c.name, label: c.name, ...(c.brief || c.identity ? { sub: c.brief || c.identity } : {}) });
  const groups: PickerGroup[] = [
    { key: 'me', label: S('主角', '主角'), items: [{ id: SHOT_ME, label: `${protagonist}（${S('自拍/合影', '自照/同影')}）`, sub: S('主角', '主角') }] },
    { key: 'romance', label: S('恋爱对象', '恋爱对象'), items: roster.contacts.filter(c => c.category === 'romance').map(toItem) },
    { key: 'important', label: S('重要角色', '重要角色'), items: roster.contacts.filter(c => c.category === 'important').map(toItem) },
  ];
  openPickerSheet(container, {
    title: S('选择出镜角色', '择入影人物'),
    groups,
    multi: true,
    selected: [...opts.selected],
    max: MAX_SHOT_CHARACTERS,
    searchPlaceholder: S('搜索角色名/介绍', '寻访人物名/来历'),
    confirmLabel: S('完成', '就绪'),
    emptyText: S('通讯录暂无角色', '道友录暂无人物'),
    onConfirm: opts.onConfirm,
  });
}

/** 拍摄地点选择弹层：按顶层区域分组；打开时重读地点（落盘事件已失效缓存）。
 *  onPick 回传所选 id 与本次读到的全量地点（供字段回显 fullPath / 生图取结构化档案）。 */
export function openShotLocationPicker(container: HTMLElement, opts: { onPick: (id: string, locations: PhoneMapLocation[]) => void }): void {
  let picked: PhoneMapLocation[] = []; // groups 打开时求值一次，行可点时必已就绪
  openPickerSheet(container, {
    title: S('选择拍摄地点', '择取景之地', '择取景之地', '择取景之境'),
    groups: async () => {
      const locations = await readPhoneMapLocations();
      picked = locations;
      // 按顶层区域（fullPath 首段）分组，行内只显示剩余路径，保持紧凑
      const byArea = new Map<string, PickerGroup>();
      for (const l of locations) {
        const segs = l.fullPath.split('-');
        const area = segs[0] || '其他';
        let group = byArea.get(area);
        if (!group) {
          group = { key: area, label: area, items: [] };
          byArea.set(area, group);
        }
        group.items.push({
          id: l.nodeId,
          label: segs.length > 1 ? segs.slice(1).join('-') : l.fullPath,
          sub: l.summary,
        });
      }
      return [...byArea.values()];
    },
    searchPlaceholder: S('搜索地点/描述', '寻访地名/记述'),
    clearLabel: S('不指定（画面由描述决定）', '不指定（画面随心念而定）'),
    emptyText: S('主项目地图暂无已探索（含描述）地点', '舆图暂无已探明（含记述）之地'),
    loadingText: S('正在读取主项目地图…', '正在读取舆图…'),
    errorText: S('读取主项目地图失败，请关闭后重试', '读取舆图失败，请合上后再试'),
    onPick: id => opts.onPick(id, picked),
  });
}
