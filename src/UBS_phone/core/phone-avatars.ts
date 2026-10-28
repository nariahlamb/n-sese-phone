// ===== 角色头像解析（主项目立绘只读读取 + 自定义头像） =====
// 生效优先级：自定义头像（立绘图库选定/统一选图弹层导入）> 主项目立绘当前图 > ''（UI 自行回退字母色块/不显示）。
// 立绘文件 usb_portraits_<hash(storageId)>.json 属状态栏写域：小手机只读，绝不写（伴生纪律 D）。
// 索引结构对齐主项目 portrait-system（name → { current, portraits[].path }），此处自建轻量解析。

import { createAtomicEnvelopeStore } from '../../unified-statusbar/core/atomic-envelope-store';
import { chatStorageHash } from '../../unified-statusbar/core/chat-storage-identity';
import { createServerFileStore, type ServerFileStore } from '../../unified-statusbar/core/server-file-store';
import { mutatePhoneData, readPhoneAvatars } from './phone-store';

/** 主角在立绘索引/头像表中的哨兵 key（与主项目 portrait-protagonist 同值；本地声明避免拖入其依赖链）。 */
export const PROTAGONIST_AVATAR_KEY = '__protagonist__';

/** 无头像时的底色（按名字稳定散列到一组柔和色）。
 *  放 core 而非渲染层：正文联动（story-link）渲染单字占位也要用同一份，保证同一角色处处同色。 */
const AVATAR_COLORS = ['#5B8DEF', '#07C160', '#E6A23C', '#9B59B6', '#E67770', '#3AAFB9', '#C0629E', '#7B8A4A'];
export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** 无头像时的**兜底渐变**（第六轮 ⑦）：由同一个散列取「主色 + 偏移 3 位的辅色」组成同色系渐变，
 *  与 avatarColor 共用一份调色板与散列口径（同一角色到哪都是同一张脸、切壳换主题都不漂移）。
 *  返回可直接放进 background-image 的 linear-gradient 值；调用方仍按既有习惯走行内 style。
 *  浅端在左上、深端在右下（与手机内其它渐变方向一致）。 */
export function avatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const main = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  const alt = AVATAR_COLORS[(hash + 3) % AVATAR_COLORS.length];
  return `linear-gradient(145deg, ${main} 0%, ${alt} 78%)`;
}

export function portraitsFilename(storageId: string): string {
  return `usb_portraits_${chatStorageHash(storageId)}.json`;
}

/** 立绘索引的小手机只读视图（只取展示所需字段）。 */
export interface PortraitIndexLite {
  current: string;
  paths: string[];
}

function parsePortraitIndex(raw: unknown): PortraitIndexLite | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const paths: string[] = [];
  for (const item of Array.isArray(rec.portraits) ? rec.portraits : []) {
    const path = item && typeof item === 'object' ? (item as Record<string, unknown>).path : null;
    if (typeof path === 'string' && path) paths.push(path);
  }
  if (!paths.length) return null;
  const current = typeof rec.current === 'string' ? rec.current : '';
  return { current, paths };
}

/** 工厂（测试注入 files）。load 失败保留旧快照；快照为纯内存只读。 */
export function createPortraitAvatarStore(deps: { files?: ServerFileStore; storageId: string }): {
  load(): Promise<boolean>;
  snapshot(): Record<string, PortraitIndexLite>;
} {
  const atomic = createAtomicEnvelopeStore<Record<string, unknown>>({
    files: deps.files ?? createServerFileStore(),
    filename: portraitsFilename(deps.storageId),
    kind: 'portraits',
    scopeId: deps.storageId,
    domainCreated: true, // 只读消费者：不使用主项目域标记体系
    emptyValue: {},
    now: () => Date.now(),
  });
  let snap: Record<string, PortraitIndexLite> = {};
  return {
    async load(): Promise<boolean> {
      try {
        await atomic.load();
      } catch (_e) {
        return false;
      }
      const next: Record<string, PortraitIndexLite> = {};
      for (const [name, idx] of Object.entries(atomic.readAll())) {
        const parsed = parsePortraitIndex(idx);
        if (parsed) next[name] = parsed;
      }
      snap = next;
      return true;
    },
    snapshot: () => snap,
  };
}

// ===== 运行时单例（rebind 于聊天切换/微信挂载时；惰性刷新见 refreshPhoneAvatars） =====

let _store: ReturnType<typeof createPortraitAvatarStore> | null = null;
let _storageId = '';
let _files: ServerFileStore | undefined;

/** 按聊天身份重建只读立绘读取器并加载（storageId 为空/非法则清空；files 仅供测试注入）。
 *  注入的 files 会被记住：refreshPhoneAvatars 换实例重读时沿用同一桩。 */
export function rebindPhoneAvatars(storageId: string, deps: { files?: ServerFileStore } = {}): Promise<boolean> {
  _storageId = storageId;
  _files = deps.files;
  if (!storageId) {
    _store = null;
    return Promise.resolve(false);
  }
  try {
    _store = createPortraitAvatarStore({ storageId, files: deps.files });
  } catch (_e) {
    _store = null; // storageId 非法等异常：降级为无立绘
    return Promise.resolve(false);
  }
  return _store.load();
}

/**
 * 重新加载立绘快照（选图弹层打开/微信挂载时惰性刷新，拿最新生成的立绘）。
 * 信封 store 的 load 一次性守卫决定了重读必须换实例（同 phone-backgrounds 的 story 图库）：
 * 在旁路实例上加载，成功且身份未变才原子换入——刷新窗口内旧快照保持可读，失败保留旧快照。
 */
export async function refreshPhoneAvatars(): Promise<void> {
  const storageId = _storageId;
  if (!storageId) return;
  try {
    const next = createPortraitAvatarStore({ storageId, files: _files });
    if (!(await next.load())) return;
    if (_storageId === storageId) _store = next;
  } catch (_e) { /* 读失败保留旧快照 */ }
}

/** 立绘索引内取展示路径：当前图优先，缺失回退图库最后一张（纯函数，可测）。 */
export function pickPortraitPath(idx: PortraitIndexLite | null | undefined): string {
  if (!idx || !idx.paths.length) return '';
  return idx.current || idx.paths[idx.paths.length - 1];
}

/** 主项目当前立绘路径（无索引回退图库最后一张；无则 ''）。 */
export function portraitAvatarPath(name: string): string {
  return pickPortraitPath(_store?.snapshot()[name]);
}

/** 立绘图库全部路径（更换头像选择用，按存储顺序）。 */
export function portraitGallery(name: string): string[] {
  return _store?.snapshot()[name]?.paths ?? [];
}

/** 生效头像路径：自定义 > 主项目立绘 > ''。 */
export function resolveAvatarPath(name: string): string {
  const custom = readPhoneAvatars()[name];
  return custom || portraitAvatarPath(name);
}

export function setCustomAvatar(name: string, path: string): void {
  mutatePhoneData(d => {
    if (!d.avatars) d.avatars = {};
    d.avatars[name] = path;
  });
}

export function clearCustomAvatar(name: string): void {
  mutatePhoneData(d => {
    if (d.avatars) delete d.avatars[name];
  });
}

export function hasCustomAvatar(name: string): boolean {
  return Boolean(readPhoneAvatars()[name]);
}
