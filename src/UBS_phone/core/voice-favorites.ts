// ===== 语音收藏（独立 IndexedDB；与缓存分离——清缓存不删收藏） =====
// 纪律同 voice-cache：
//  ① 懒开：第一次读写才 open；未用收藏时零开销。
//  ② 永不抛出：收藏是增值层，任何存储失败都静默回落内存，绝不弄坏播放/导出。
//  ③ 只存 api/comfy 的真实音频（系统 TTS 无字节，不能收藏）。

export interface VoiceFavorite {
  /** 与缓存同源的 key（后端+音色+语速+情绪+模型+格式+变体+文本 的哈希）。 */
  key: string;
  blob: Blob;
  mime: string;
  role: string;
  text: string;
  translation?: string;
  /** 情绪（规范八词之一或原文；第八轮 §1：录音机收藏页签彩标用；旧条目缺省=不渲染标签）。 */
  emotion?: string;
  /** 后端（system/api/comfy；系统 TTS 无字节不会进这里）。 */
  engine?: string;
  model?: string;
  voice?: string;
  createdAt: number;
}

const DB_NAME = 'ubp-voice-fav';
const STORE = 'favorites';
const DB_VERSION = 1;
/** 收藏条数上限（超出丢最旧）。 */
export const MAX_VOICE_FAVORITES = 500;

// ─── 内存兜底（IndexedDB 不可用 / Node 测试环境） ───

const _mem = new Map<string, VoiceFavorite>();

// ─── IndexedDB 通道 ───

let _db: IDBDatabase | null = null;
let _dbFailed = false;

function idb(): IDBDatabase | null {
  if (_db || _dbFailed) return _db;
  try {
    const w = (typeof window !== 'undefined' ? window : globalThis) as any;
    if (!w?.indexedDB?.open) { _dbFailed = true; return null; }
    const req = w.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result as IDBDatabase;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => { _db = req.result as IDBDatabase; };
    req.onerror = () => { _dbFailed = true; };
    return null; // 首次必然异步：本次走内存，后续命中 _db
  } catch (_e) {
    _dbFailed = true;
    return null;
  }
}

function withStore(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => void): boolean {
  const db = idb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, mode);
    fn(tx.objectStore(STORE));
    return true;
  } catch (_e) {
    return false;
  }
}

/** 收藏条目净化（磁盘读回容错）：缺关键字段或非音频的丢弃。 */
function normalizeFavorite(raw: any): VoiceFavorite | null {
  if (!raw || typeof raw.key !== 'string' || !raw.key.trim()) return null;
  const blob = raw.blob;
  if (!blob || typeof blob.size !== 'number' || !blob.size) return null;
  const mime = typeof raw.mime === 'string' && raw.mime ? raw.mime : (blob.type || 'audio/mpeg');
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now();
  return {
    key: raw.key.trim().slice(0, 120),
    blob,
    mime,
    role: String(raw.role || '').slice(0, 80) || '未标注角色',
    text: String(raw.text || '').slice(0, 4000),
    ...(raw.translation ? { translation: String(raw.translation).slice(0, 4000) } : {}),
    ...(raw.emotion ? { emotion: String(raw.emotion).slice(0, 40) } : {}),
    ...(raw.engine ? { engine: String(raw.engine).slice(0, 24) } : {}),
    ...(raw.model ? { model: String(raw.model).slice(0, 120) } : {}),
    ...(raw.voice ? { voice: String(raw.voice).slice(0, 160) } : {}),
    createdAt,
  };
}

/** 同一条（同 key）只保留一份：新收藏覆盖旧的。 */
export async function voiceFavoritePut(fav: VoiceFavorite): Promise<void> {
  const clean = normalizeFavorite(fav);
  if (!clean) return;
  _mem.set(clean.key, clean);
  withStore('readwrite', (os) => {
    try {
      os.put(clean);
      const g = os.getAll();
      g.onsuccess = () => {
        const rows = (g.result as VoiceFavorite[] | undefined) || [];
        if (rows.length <= MAX_VOICE_FAVORITES) return;
        rows.sort((a, b) => a.createdAt - b.createdAt);
        for (const row of rows.slice(0, rows.length - MAX_VOICE_FAVORITES)) {
          try { os.delete(row.key); } catch (_e) { /* ignore */ }
        }
      };
    } catch (_e) { /* ignore */ }
  });
}

export async function voiceFavoriteGet(key: string): Promise<VoiceFavorite | null> {
  if (!key) return null;
  const hit = _mem.get(key) || null;
  if (idb()) {
    return await new Promise<VoiceFavorite | null>((resolve) => {
      if (!withStore('readonly', (os) => {
        const g = os.get(key);
        g.onsuccess = () => resolve(normalizeFavorite(g.result) || hit);
        g.onerror = () => resolve(hit);
      })) resolve(hit);
    });
  }
  return hit;
}

export async function voiceFavoriteHas(key: string): Promise<boolean> {
  if (_mem.has(key)) return true;
  return Boolean(await voiceFavoriteGet(key));
}

export async function voiceFavoriteDelete(key: string): Promise<void> {
  _mem.delete(key);
  withStore('readwrite', (os) => { try { os.delete(key); } catch (_e) { /* ignore */ } });
}

/** 收藏列表（新→旧）。 */
export async function voiceFavoriteList(): Promise<VoiceFavorite[]> {
  let rows: VoiceFavorite[];
  if (!idb()) {
    rows = [..._mem.values()];
  } else {
    rows = await new Promise<VoiceFavorite[]>((resolve) => {
      if (!withStore('readonly', (os) => {
        const g = os.getAll();
        g.onsuccess = () => resolve((g.result as VoiceFavorite[]) || []);
        g.onerror = () => resolve([..._mem.values()]);
      })) resolve([..._mem.values()]);
    });
  }
  return rows
    .map(normalizeFavorite)
    .filter((r): r is VoiceFavorite => r !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function voiceFavoriteClear(): Promise<void> {
  _mem.clear();
  withStore('readwrite', (os) => { try { os.clear(); } catch (_e) { /* ignore */ } });
}

export async function voiceFavoriteStats(): Promise<{ count: number; totalBytes: number }> {
  const list = await voiceFavoriteList();
  return { count: list.length, totalBytes: list.reduce((s, f) => s + (f.blob.size || 0), 0) };
}
