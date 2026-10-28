// ===== 语音缓存（IndexedDB；不可用时退化为会话内存 Map） =====
// 纪律：
//  ① **懒开**：第一次读写才 open 数据库；未开启语音功能时零开销（不碰 indexedDB）。
//  ② **永不抛出**：缓存是加速层，任何失败都静默回落（拿不到就重新合成），绝不弄坏播放。
//  ③ **只缓存 api/comfy 产物**（有 Blob）；系统 TTS 无字节、不写缓存。
//  ④ key = 全参数哈希（后端+音色+语速+情绪+模型+格式+变体+文本），换任一参数即换 key，不会串味。

/** 缓存条目的可读元数据（第八轮 §1：录音机「缓存」页签显示用）。
 *  可选、只读展示——**键结构/上限/LRU 全不受影响**；旧条目无元数据回落哈希短键，不做迁移。 */
export interface VoiceCacheMeta {
  /** 角色名（发送方显示名）。 */
  role?: string;
  /** 台词原文（转写）。 */
  text?: string;
  /** 情绪（规范八词之一或原文）。 */
  emotion?: string;
}

export interface VoiceCacheEntry extends VoiceCacheMeta {
  key: string;
  blob: Blob;
  mime: string;
  /** 首次解码得到的真实时长（ms）；系统/解码失败时缺省。 */
  durationMs?: number;
  size: number;
  createdAt: number;
  lastAccessAt: number;
}

/** 元数据净化：去空白后只留非空串（不给旧条目凭空添空字段）。 */
function cleanMeta(meta: VoiceCacheMeta | undefined): VoiceCacheMeta {
  const out: VoiceCacheMeta = {};
  const role = String(meta?.role ?? '').trim();
  const text = String(meta?.text ?? '').trim();
  const emotion = String(meta?.emotion ?? '').trim();
  if (role) out.role = role.slice(0, 80);
  if (text) out.text = text.slice(0, 4000);
  if (emotion) out.emotion = emotion.slice(0, 40);
  return out;
}

/** 缓存条目显示口径（纯函数，录音机列表用）：有台词用台词；旧条目回落哈希短键（不做迁移）。 */
export function voiceCacheDisplay(entry: Pick<VoiceCacheEntry, 'key' | 'text'>): { title: string; legacy: boolean } {
  const text = String(entry.text || '').trim();
  if (text) return { title: text, legacy: false };
  const hash = String(entry.key || '').split(':')[1] || String(entry.key || '');
  return { title: `未标注语音 · ${hash.slice(-8) || '未知'}`, legacy: true };
}

export interface VoiceCacheStats {
  count: number;
  totalBytes: number;
}

const DB_NAME = 'ubp-voice';
const STORE = 'audio';
const DB_VERSION = 1;

/** FNV-1a 32 位字符串哈希（纯函数，可单测）。 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 语音缓存 key（纯函数）：后端+音色+语速+情绪+模型+格式+变体(工作流/参考音频)+文本 规范化后哈希。
 *  任一参数变化即换 key——改模型、改输出格式、改 ComfyUI 工作流都不会命中旧音频（对齐 ST-iPhonie「请求即缓存键」）。 */
export function voiceCacheKey(parts: {
  backend: string;
  voiceId: string;
  speed?: number;
  emotion?: string;
  /** 可选演绎说明（40 字上限裕量；进 key，换演绎即重新合成）。 */
  delivery?: string;
  /** api 后端：服务商 id（不同厂商同音色 id 也区分，支持角色跨厂商）。 */
  provider?: string;
  /** api 后端：模型名（tts-1 / FunAudioLLM/CosyVoice2-0.5B …）。 */
  model?: string;
  /** api 后端：输出格式（mp3 / wav）。 */
  format?: string;
  /** comfy 后端：地址 + 工作流 + 参考音频的指纹（纯函数算不出的，由调用方传入）。 */
  variant?: string;
  text: string;
}): string {
  const canon = [
    parts.backend || '',
    parts.provider || '',
    parts.voiceId || '',
    String(parts.speed ?? 1),
    parts.emotion || '',
    parts.delivery || '',
    parts.model || '',
    parts.format || '',
    parts.variant || '',
    (parts.text || '').replace(/\s+/g, ' ').trim(),
  ].join('\u0001');
  return `v:${fnv1a(canon)}:${canon.length}`;
}

/** LRU 淘汰选择（纯函数）：返回应删除的 key 列表，使剩余满足条目/字节上限。 */
export function selectPruneKeys(
  entries: ReadonlyArray<{ key: string; size: number; lastAccessAt: number }>,
  maxEntries: number,
  maxBytes: number,
): string[] {
  const out: string[] = [];
  const alive = entries.filter(e => Number.isFinite(e.size) && e.size >= 0);
  let bytes = alive.reduce((s, e) => s + e.size, 0);
  let count = alive.length;
  if (count <= maxEntries && bytes <= maxBytes) return out;
  const byAge = [...alive].sort((a, b) => a.lastAccessAt - b.lastAccessAt);
  for (const e of byAge) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    out.push(e.key);
    count -= 1;
    bytes -= e.size;
  }
  return out;
}

// ─── 内存兜底（IndexedDB 不可用 / Node 测试环境） ───

const _mem = new Map<string, VoiceCacheEntry>();

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
        os.createIndex('lastAccessAt', 'lastAccessAt');
      }
    };
    req.onsuccess = () => {
      _db = req.result as IDBDatabase;
      // 首次 open 是异步的：就绪前只落内存兜底的写入，开库成功后补写一次
      // （否则它们永远进不了库——「缓存列表看不见刚预合成的条目」就是这么来的）。
      if (_mem.size) {
        withStore('readwrite', (os) => {
          for (const entry of _mem.values()) { try { os.put(entry); } catch (_e) { /* ignore */ } }
        });
      }
    };
    req.onerror = () => { _dbFailed = true; };
    return null; // 首次调用必然是异步的：本次走内存，后续调用命中 _db
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

// ─── 公开 API（全部 best-effort，永不抛） ───

export async function voiceCacheGet(key: string): Promise<VoiceCacheEntry | null> {
  if (!key) return null;
  const hit = _mem.get(key);
  if (idb()) {
    return await new Promise<VoiceCacheEntry | null>((resolve) => {
      if (!withStore('readwrite', (os) => {
        const g = os.get(key);
        g.onsuccess = () => {
          const entry = g.result as VoiceCacheEntry | undefined;
          if (!entry) { resolve(hit || null); return; }
          entry.lastAccessAt = Date.now();
          try { os.put(entry); } catch (_e) { /* ignore */ }
          _mem.set(key, entry);
          resolve(entry);
        };
        g.onerror = () => resolve(hit || null);
      })) resolve(hit || null);
    });
  }
  return hit || null;
}

/** 写入缓存。meta = 可读元数据（角色/台词/情绪；缺省=不写，旧调用零改动）。 */
export async function voiceCachePut(entry: VoiceCacheEntry, meta?: VoiceCacheMeta): Promise<void> {
  if (!entry?.key) return;
  const clean = meta ? { ...entry, ...cleanMeta(meta) } : entry;
  _mem.set(clean.key, clean);
  withStore('readwrite', (os) => { try { os.put(clean); } catch (_e) { /* ignore */ } });
}

export async function voiceCacheDelete(key: string): Promise<void> {
  _mem.delete(key);
  withStore('readwrite', (os) => { try { os.delete(key); } catch (_e) { /* ignore */ } });
}

/** 按 LRU 淘汰到上限内（条目数 / 字节数）。 */
export async function voiceCachePrune(maxEntries: number, maxBytes: number): Promise<void> {
  const list = await voiceCacheList();
  const drop = selectPruneKeys(list, maxEntries, maxBytes);
  for (const key of drop) await voiceCacheDelete(key);
}

/** 合并「库内 + 内存兜底」（纯函数）：同 key 库内优先（带最新 lastAccessAt）。开库是异步的——
 *  首次写入可能只落在内存兜底，列表/统计必须看得见它们（录音机缓存页签曾因此漏条目）。 */
export function mergeCacheLists(
  dbRows: readonly VoiceCacheEntry[],
  memRows: readonly VoiceCacheEntry[],
): VoiceCacheEntry[] {
  const byKey = new Map<string, VoiceCacheEntry>();
  for (const e of memRows) byKey.set(e.key, e);
  for (const e of dbRows) byKey.set(e.key, e);
  return [...byKey.values()];
}

export async function voiceCacheList(): Promise<VoiceCacheEntry[]> {
  if (!idb()) return [..._mem.values()];
  const rows = await new Promise<VoiceCacheEntry[]>((resolve) => {
    if (!withStore('readonly', (os) => {
      const g = os.getAll();
      g.onsuccess = () => resolve((g.result as VoiceCacheEntry[]) || []);
      g.onerror = () => resolve([..._mem.values()]);
    })) resolve([..._mem.values()]);
  });
  return mergeCacheLists(rows, [..._mem.values()]);
}

export async function voiceCacheStats(): Promise<VoiceCacheStats> {
  const list = await voiceCacheList();
  return { count: list.length, totalBytes: list.reduce((s, e) => s + (e.size || 0), 0) };
}

export async function voiceCacheClear(): Promise<void> {
  _mem.clear();
  withStore('readwrite', (os) => { try { os.clear(); } catch (_e) { /* ignore */ } });
}
