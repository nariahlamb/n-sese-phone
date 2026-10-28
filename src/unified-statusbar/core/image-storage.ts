// ===== SillyTavern 图片落盘共享边界 =====

import { padNumber } from './number';

export interface ImageStorageResult {
  path: string | null;
  error?: string;
}

export type DeleteStoredImageResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ImageStorageDeps {
  fetchFn: typeof fetch;
  getRequestHeaders: () => Record<string, string>;
  getCharName: () => string;
  now: () => Date;
}

export interface ImageStorage {
  uploadGeneratedImage(dataUrl: string, namespace: string, filenameStem: string): Promise<ImageStorageResult>;
  deleteStoredImage(path: string): Promise<DeleteStoredImageResult>;
}

function getSillyTavernContext(): any {
  let st: any = null;
  try {
    st = (window as any).SillyTavern
      || (window.parent as any).SillyTavern
      || (window as any).TavernHelper?.SillyTavern
      || (window.parent as any).TavernHelper?.SillyTavern;
  } catch (_e) { /* cross-origin or non-browser */ }
  if (!st) return null;
  if (typeof st.getContext === 'function') {
    try { return st.getContext(); } catch (_e) { /* fall through */ }
  }
  return st;
}

function defaultRequestHeaders(): Record<string, string> {
  const st = getSillyTavernContext();
  if (st && typeof st.getRequestHeaders === 'function') return st.getRequestHeaders();
  throw new Error('无法访问 SillyTavern 请求头（getRequestHeaders）');
}

function defaultCharName(): string {
  try {
    const parentSt = typeof parent !== 'undefined' ? (parent as any).SillyTavern : null;
    const windowSt = typeof window !== 'undefined' ? (window as any).SillyTavern : null;
    const st = parentSt || windowSt;
    if (st && typeof st.name2 === 'function') return st.name2() || 'unified-statusbar';
    if (st && typeof st.name2 === 'string') return st.name2 || 'unified-statusbar';
  } catch (_e) { /* ignore */ }
  return 'unified-statusbar';
}

function sanitizeFilenamePart(value: string, fallback: string): string {
  const cleaned = String(value || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || fallback;
}

function filenameTimestamp(date: Date): string {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`
    + `@${padNumber(date.getHours())}h${padNumber(date.getMinutes())}m${padNumber(date.getSeconds())}s`
    + `${padNumber(date.getMilliseconds(), 3)}ms`;
}

export function isSafeStoredImagePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const path = value.trim();
  if (!path || path.length > 2048 || /[\u0000-\u001f]/.test(path)) return false;
  if (/^(?:data|javascript|file|https?):/i.test(path)) return false;
  const withoutQuery = path.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  if (withoutQuery.split('/').some(segment => segment === '..')) return false;
  return true;
}

const STATUSBAR_IMAGE_PREFIX = 'user/images/unified-statusbar/';

/** Exact ownership boundary for files this plugin is allowed to delete. */
export function isOwnedStatusbarImagePath(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  // SillyTavern 的 clientRelativePath 返回带前导 '/' 的路径（'/user/images/...'），此处兼容
  const normalized = value.startsWith('/') ? value.slice(1) : value;
  if (!normalized.startsWith(STATUSBAR_IMAGE_PREFIX) || normalized.length > 2048) return false;
  if (/[\\?#\u0000-\u001f]/.test(normalized)) return false;
  const basename = normalized.slice(STATUSBAR_IMAGE_PREFIX.length);
  if (!basename || basename === '.' || basename === '..' || basename.includes('/')) return false;
  return true;
}

/** Map rollback GC may delete only its own map-scene_* files. */
export function isOwnedMapSceneImagePath(value: unknown): value is string {
  if (!isOwnedStatusbarImagePath(value)) return false;
  const normalized = typeof value === 'string' && value.startsWith('/') ? value.slice(1) : value as string;
  const basename = normalized.slice(STATUSBAR_IMAGE_PREFIX.length);
  // scene stem 已剔非 ASCII，但时间戳含 @（与 story-image 同根因，@ 必须放行否则 GC 永远拒收）
  return /^map-scene_[A-Za-z0-9_.@-]+$/.test(basename);
}

/** Story-image gallery may delete only its own story-image_* files. */
export function isOwnedStoryImagePath(value: unknown): value is string {
  if (!isOwnedStatusbarImagePath(value)) return false;
  const normalized = typeof value === 'string' && value.startsWith('/') ? value.slice(1) : value as string;
  const basename = normalized.slice(STATUSBAR_IMAGE_PREFIX.length);
  // 文件名真实字符集：引擎 stem（\w + CJK 一-鿿 + -）+ 时间戳（数字 + - + @ + hms）+ 扩展名。
  // ★@ 与 CJK 必须放行：filenameTimestamp 含 @、角色卡名保留 CJK——旧版 [A-Za-z0-9_.-] 全部拒收，
  //   导致刷新后图库 sanitize 清空列表、正文点击路径校验失败（文件其实在磁盘上）。
  return /^story-image_[\w.@\u4e00-\u9fff-]+$/.test(basename);
}

function defaultDeps(): ImageStorageDeps {
  return {
    fetchFn: (input, init) => fetch(input, init),
    getRequestHeaders: defaultRequestHeaders,
    getCharName: defaultCharName,
    now: () => new Date(),
  };
}

export function createImageStorage(overrides: Partial<ImageStorageDeps> = {}): ImageStorage {
  const deps: ImageStorageDeps = { ...defaultDeps(), ...overrides };
  const requestHeaders = (): Record<string, string> => {
    const headers = deps.getRequestHeaders();
    if (!headers || typeof headers !== 'object') {
      throw new Error('无法获取 SillyTavern 请求头');
    }
    return headers;
  };

  return {
    async uploadGeneratedImage(
      dataUrl: string,
      namespace: string,
      filenameStem: string,
    ): Promise<ImageStorageResult> {
      const match = String(dataUrl || '').match(/^data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
      if (!match) return { path: null, error: '图片数据格式错误（需要 data:image/...;base64,...）' };
      const format = match[1].toLocaleLowerCase() === 'jpeg' ? 'jpg' : match[1].toLocaleLowerCase();
      const base64 = match[2].replace(/\s/g, '');
      if (!base64) return { path: null, error: '图片数据为空' };
      const filename = [
        sanitizeFilenamePart(namespace, 'image'),
        namespace === 'map-scene'
          ? sanitizeFilenamePart(filenameStem, 'scene').replace(/[^A-Za-z0-9_.-]/g, '_')
          : sanitizeFilenamePart(filenameStem, 'generated'),
        filenameTimestamp(deps.now()),
      ].join('_') + `.${format}`;

      let headers: Record<string, string>;
      try {
        headers = requestHeaders();
      } catch (error: any) {
        return { path: null, error: error?.message || '无法获取 SillyTavern 请求头' };
      }
      try {
        const response = await deps.fetchFn('/api/images/upload', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            image: base64,
            format,
            ch_name: 'unified-statusbar',
            filename,
          }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return { path: null, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
        }
        const payload = await response.json().catch(() => null) as any;
        if (!payload || !isOwnedStatusbarImagePath(payload.path)) {
          return { path: null, error: '响应未包含有效的图片 path 字段' };
        }
        return { path: payload.path.trim() };
      } catch (error: any) {
        return { path: null, error: error?.message || String(error) };
      }
    },

    async deleteStoredImage(path: string): Promise<DeleteStoredImageResult> {
      if (!isOwnedStatusbarImagePath(path)) return { ok: false, error: '图片路径不属于状态栏固定目录，已拒绝删除' };
      let headers: Record<string, string>;
      try {
        headers = requestHeaders();
      } catch (error: any) {
        return { ok: false, error: error?.message || '无法获取 SillyTavern 请求头' };
      }
      try {
        const response = await deps.fetchFn('/api/images/delete', {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: path.trim() }),
        });
        if (response.status === 404) return { ok: true };
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return { ok: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
        }
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) };
      }
    },
  };
}

export const imageStorage = createImageStorage();

export function uploadGeneratedImage(
  dataUrl: string,
  namespace: string,
  filenameStem: string,
): Promise<ImageStorageResult> {
  return imageStorage.uploadGeneratedImage(dataUrl, namespace, filenameStem);
}

export function deleteStoredImage(path: string): Promise<DeleteStoredImageResult> {
  return imageStorage.deleteStoredImage(path);
}
