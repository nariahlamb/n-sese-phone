// ===== 统一状态栏外部存储 · SillyTavern 用户文件边界 =====

export interface ServerFileReadResult<T> {
  found: boolean;
  value?: T;
  error?: string;
}

export interface ServerFileWriteResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface ServerFileStore {
  readJson<T>(filename: string): Promise<ServerFileReadResult<T>>;
  uploadJson(filename: string, value: unknown): Promise<ServerFileWriteResult>;
  verify(paths: string[]): Promise<Record<string, boolean>>;
  delete(path: string): Promise<{ ok: boolean; error?: string }>;
}

/** verify 真实存在再逐个删除（delete 对 404 幂等，但避免无谓请求）。
 *  U50 单源：原 storage-global-manager 与 storage-hard-reset 各持一份同构三件套
  （verify→filter→delete+report，错误文案「未知/未知错误」微差就此统一为「未知」）。 */
export async function verifyAndDeleteUserFiles(
  store: ServerFileStore,
  names: string[],
  onProgress?: (step: 'verify' | 'delete', done: number, total: number) => void,
): Promise<{ deleted: number; failed: number; errors: string[] }> {
  onProgress?.('verify', 0, names.length);
  const existence = await store.verify(names.map(f => `/user/files/${f}`));
  const existing = names.filter(f => existence[`/user/files/${f}`] === true);
  const out = { deleted: 0, failed: 0, errors: [] as string[] };
  for (let i = 0; i < existing.length; i += 1) {
    const filename = existing[i];
    const deleted = await store.delete(`/user/files/${filename}`);
    if (deleted.ok) out.deleted += 1;
    else { out.failed += 1; out.errors.push(`删除 ${filename} 失败：${deleted.error || '未知'}`); }
    onProgress?.('delete', i + 1, existing.length);
  }
  return out;
}

export interface ServerFileDeps {
  fetchFn: typeof fetch;
  getRequestHeaders: () => Record<string, string>;
  now: () => number;
}

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,239}$/;
let _readNonce = 0;

export function isSafeServerFilename(value: unknown): value is string {
  return typeof value === 'string'
    && SAFE_FILENAME_RE.test(value)
    && !value.startsWith('.')
    && !value.includes('..');
}

function isSafeUserFileApiPath(value: unknown): value is string {
  return typeof value === 'string'
    && /^\/user\/files\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,239}$/.test(value)
    && !value.includes('..');
}

function getSillyTavernContext(): any {
  const candidates: any[] = [];
  try { candidates.push((window as any).SillyTavern); } catch (_e) { /* ignore */ }
  try { candidates.push((window.parent as any).SillyTavern); } catch (_e) { /* cross-origin */ }
  try { candidates.push((window as any).TavernHelper?.SillyTavern); } catch (_e) { /* ignore */ }
  try { candidates.push((window.parent as any).TavernHelper?.SillyTavern); } catch (_e) { /* cross-origin */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate.getContext === 'function') {
      try { return candidate.getContext(); } catch (_e) { /* continue */ }
    }
    return candidate;
  }
  return null;
}

function defaultHeaders(): Record<string, string> {
  const st = getSillyTavernContext();
  if (st && typeof st.getRequestHeaders === 'function') return st.getRequestHeaders();
  throw new Error('无法访问 SillyTavern 请求头（getRequestHeaders）');
}

function utf8ToBase64(text: string): string {
  // O36-②(十一轮)：按 3 字节对齐分块、每块独立 btoa 后拼接——块长是 3 的倍数时
  // 「块级 base64 的拼接」逐字节等于「整串的 base64」。不再先拼整条 binary 中间串：
  // 大文件上传期间省去与 base64 输出同时存活的 ~1× 文件体积瞬时字符串（分块临时串随块即弃）。
  const bytes = new TextEncoder().encode(text);
  const block = 32766; // 3 × 10922：3 的倍数（3 字节 → 4 字符完整映射，无跨块残余组）
  let out = '';
  for (let i = 0; i < bytes.length; i += block) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + block));
    let binary = '';
    for (let j = 0; j < chunk.length; j += 0x8000) {
      binary += String.fromCharCode(...chunk.subarray(j, Math.min(chunk.length, j + 0x8000)));
    }
    out += btoa(binary);
  }
  return out;
}

function boundedError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || fallback);
  return (message || fallback).slice(0, 220);
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
}

function defaultDeps(): ServerFileDeps {
  return {
    fetchFn: (...args) => fetch(...args),
    getRequestHeaders: defaultHeaders,
    now: () => Date.now(),
  };
}

export function createServerFileStore(overrides: Partial<ServerFileDeps> = {}): ServerFileStore {
  const deps: ServerFileDeps = { ...defaultDeps(), ...overrides };

  const headers = (): Record<string, string> => {
    const value = deps.getRequestHeaders();
    if (!value || typeof value !== 'object') throw new Error('无法获取 SillyTavern 请求头');
    return value;
  };

  return {
    async readJson<T>(filename: string): Promise<ServerFileReadResult<T>> {
      if (!isSafeServerFilename(filename)) return { found: false, error: '文件名不安全' };
      let requestHeaders: Record<string, string>;
      try { requestHeaders = headers(); }
      catch (error) { return { found: false, error: boundedError(error, '无法获取请求头') }; }
      try {
        const nonce = `${deps.now()}-${++_readNonce}`;
        const response = await deps.fetchFn(`/user/files/${encodeURIComponent(filename)}?v=${nonce}`, {
          method: 'GET',
          headers: requestHeaders,
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (response.status === 404) return { found: false };
        if (!response.ok) return { found: false, error: await responseError(response) };
        const value = await response.json() as T;
        return { found: true, value };
      } catch (error) {
        return { found: false, error: boundedError(error, '读取文件失败') };
      }
    },

    async uploadJson(filename: string, value: unknown): Promise<ServerFileWriteResult> {
      if (!isSafeServerFilename(filename)) return { ok: false, error: '文件名不安全' };
      let requestHeaders: Record<string, string>;
      try { requestHeaders = headers(); }
      catch (error) { return { ok: false, error: boundedError(error, '无法获取请求头') }; }
      try {
        const data = utf8ToBase64(JSON.stringify(value));
        const response = await deps.fetchFn('/api/files/upload', {
          method: 'POST',
          headers: requestHeaders,
          // O36-①(十一轮)：请求体三段拼装——base64 字母表（A-Za-z0-9+/=）无需 JSON 转义，
          // 直接拼装省掉一次「对象含全尺寸 base64」的 JSON.stringify 全量拷贝。
          // 字节与旧实现（JSON.stringify({name, data})）逐字节相同：属性序 name→data、
          // 转义由 JSON.stringify(filename) 与 base64 字符集共同保证。
          body: '{"name":' + JSON.stringify(filename) + ',"data":"' + data + '"}',
          credentials: 'same-origin',
        });
        if (!response.ok) return { ok: false, error: await responseError(response) };
        const payload = await response.json().catch(() => null) as any;
        if (!payload || !isSafeUserFileApiPath(payload.path)) {
          return { ok: false, error: '上传响应未包含有效的用户文件 path' };
        }
        return { ok: true, path: payload.path };
      } catch (error) {
        return { ok: false, error: boundedError(error, '上传文件失败') };
      }
    },

    async verify(paths: string[]): Promise<Record<string, boolean>> {
      const safe = paths.filter(isSafeUserFileApiPath);
      if (safe.length !== paths.length) return {};
      let requestHeaders: Record<string, string>;
      try { requestHeaders = headers(); } catch (_e) { return {}; }
      try {
        const response = await deps.fetchFn('/api/files/verify', {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify({ urls: safe }),
          credentials: 'same-origin',
        });
        if (!response.ok) return {};
        const raw = await response.json().catch(() => null) as any;
        if (!raw || typeof raw !== 'object') return {};
        const out: Record<string, boolean> = {};
        for (const path of safe) out[path] = raw[path] === true;
        return out;
      } catch (_e) {
        return {};
      }
    },

    async delete(path: string): Promise<{ ok: boolean; error?: string }> {
      if (!isSafeUserFileApiPath(path)) return { ok: false, error: '用户文件路径不安全' };
      let requestHeaders: Record<string, string>;
      try { requestHeaders = headers(); }
      catch (error) { return { ok: false, error: boundedError(error, '无法获取请求头') }; }
      // 不同 SillyTavern 构建对 /api/files/delete 的 path 字段接受不同相对根
      // （参考数据库插件的删除请求候选构造：带/不带前导斜杠、files/ 前缀、裸文件名）。
      // 逐个尝试直到成功；全部 404 则 GET 探测确认文件确已不存在 → 视为删除成功。
      const fileName = path.trim().replace(/^\/+/, '').replace(/^user\/files\//, '');
      const candidates = [
        { path: `user/files/${fileName}` },
        { path: `/user/files/${fileName}` },
        { path: `files/${fileName}` },
        { path: fileName },
      ];
      const seen = new Set<string>();
      const attempts: string[] = [];
      let notFoundSeen = false;
      for (const body of candidates) {
        const key = JSON.stringify(body);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const response = await deps.fetchFn('/api/files/delete', {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(body),
            credentials: 'same-origin',
          });
          if (response.ok) return { ok: true };
          if (response.status === 404) notFoundSeen = true;
          attempts.push(`${body.path} -> ${response.status}`);
        } catch (error) {
          attempts.push(`${body.path} -> ${boundedError(error, '删除文件失败')}`);
        }
      }
      if (notFoundSeen) {
        try {
          const probe = await deps.fetchFn(
            `/user/files/${encodeURIComponent(fileName)}?t=${deps.now()}`,
            { method: 'GET', headers: requestHeaders, credentials: 'same-origin' },
          );
          if (probe.status === 404) return { ok: true };
        } catch (_e) { /* fall through to error */ }
      }
      return { ok: false, error: `删除失败，已尝试 ${attempts.length} 种 path: ${attempts.join('；')}` };
    },
  };
}

export const serverFileStore = createServerFileStore();
