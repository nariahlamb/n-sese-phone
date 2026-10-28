// ===== 网格缩略图（相册 App 与统一选图弹层共用）：会话级降采样小图，消灭整册原图解码位图常驻 =====
// 背景（docs/70）：网格 <img> 一直直接 src=原图（1024² 单张解码 ≈4MB），30-50 张相册滚一遍后
// 解码位图全部驻留文档（iOS WebKit 对文档内图片的解码数据回收极保守）→ 宿主单页内存撞顶，
// 手机端表现为整页被系统回收（闪退）。真凶不是泄漏，是「小格子扛全尺寸位图」。
// 方案：格子图一律先空 src + data-ubp-thumb，由 hydrateGridThumbs 接管——
//   · 缓存命中：同步回填 src（渲染同一帧内完成，无闪烁、重绘零网络零整图解码）；
//   · 未命中：IntersectionObserver 只对滚入视口(±600px)的格子生成缩略图（≤320px webp，画进
//     小 canvas 一次性降采样），原图仅在生成瞬间短暂解码（并发 ≤3，防瞬时尖峰）；
//   · 生成失败：格子回落 src=原图，行为与改造前完全一致（裂图照旧裂）。
// 缩略图缓存在模块级 Map（会话生命周期，条数/字节双闸 LRU，对齐 voice-cache.selectPruneKeys 口径）。
// 详情弹层 / 编辑弹层 / 放大灯箱不经过这里——单张有界，继续用原图，观感不变。

/** 缩略图最长边（px）。格子 ≈117 CSS px（375px 壳 ÷3 列），3x DPR 需 ≈351px，320 视觉无差。 */
export const THUMB_MAX_EDGE = 320;
/** 缩略图缓存条数上限（相册默认 200 条 + 选图弹层立绘/文生图页余量）。 */
export const THUMB_CACHE_MAX_ENTRIES = 300;
/** 缩略图缓存字节上限（dataURL 字符串长度累计；webp ≈15-30KB/张，老 Safari 无 webp 编码回落 PNG 更大）。 */
export const THUMB_CACHE_MAX_BYTES = 16_000_000;
/** 缩略图生成并发上限：每张都要短暂解码一次原图（≈4MB/张），并发即瞬时峰值，压到 3。 */
const THUMB_MAX_CONCURRENT = 3;
/** 缩略图生成失败记录上限（防无界；失败=回落原图，超过整表清空重试机会）。 */
const THUMB_FAILED_MAX = 500;
/** 视口外预生成的余量（px）：≈5 行格子，滚到哪生成到哪，离屏不生成。 */
const THUMB_ROOT_MARGIN = '600px 0px';

interface ThumbEntry {
  url: string;
  size: number;
  lastAccessAt: number;
}

const _cache = new Map<string, ThumbEntry>();
const _failed = new Set<string>();
const _pending = new Map<string, Promise<string | null>>();
const _containers = new Set<HTMLElement>();
let _io: IntersectionObserver | null = null;
// 串行小并发泵：IO 一次回调可能带几十个格子（开页 + 600px 余量），全并发=几十张原图同时解码
// （正是要消灭的尖峰），全串行=首屏填图太慢。3 路并发是两者折中。
let _active = 0;
const _queue: Array<() => void> = [];

/** 等比缩进 max 方框（小图不放大）。纯函数（单测锚点）。 */
export function thumbBox(naturalW: number, naturalH: number, max: number = THUMB_MAX_EDGE): { w: number; h: number } {
  const w = Number(naturalW);
  const h = Number(naturalH);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: max, h: max };
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** LRU 淘汰选择（纯函数，单测锚点；口径对齐 core/voice-cache.selectPruneKeys）。 */
export function selectThumbPruneKeys(
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

function pruneThumbCache(): void {
  const dead = selectThumbPruneKeys(
    [..._cache.entries()].map(([key, e]) => ({ key, size: e.size, lastAccessAt: e.lastAccessAt })),
    THUMB_CACHE_MAX_ENTRIES,
    THUMB_CACHE_MAX_BYTES,
  );
  for (const key of dead) _cache.delete(key);
}

/** 原图 → 缩略图 dataURL（一次性降采样）。任何异常都归为 null（回落原图），绝不抛出。 */
function makeThumb(path: string): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const box = thumbBox(img.naturalWidth || img.width, img.naturalHeight || img.height);
        const canvas = document.createElement('canvas');
        canvas.width = box.w;
        canvas.height = box.h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, box.w, box.h);
        // webp 体积最小且保 alpha；浏览器不支持该编码时 toDataURL 自动回落 PNG（同保 alpha，语义不变）
        const url = canvas.toDataURL('image/webp', 0.85);
        resolve(url.startsWith('data:image/') ? url : null);
      } catch (_e) {
        resolve(null); // 画布污染（跨源）/编码失败等：回落原图
      }
    };
    img.onerror = () => resolve(null);
    img.src = path;
  });
}

/** 生成一个缩略图（带并发泵与去重；返回 null=失败，调用方回落原图）。 */
function ensureThumb(path: string): Promise<string | null> {
  const hit = _cache.get(path);
  if (hit) {
    hit.lastAccessAt = Date.now();
    return Promise.resolve(hit.url);
  }
  if (_failed.has(path)) return Promise.resolve(null);
  const pending = _pending.get(path);
  if (pending) return pending;
  const job = new Promise<string | null>(resolve => {
    _queue.push(() => {
      _active += 1;
      makeThumb(path).then(url => {
        _active -= 1;
        _pending.delete(path);
        if (url) {
          _cache.set(path, { url, size: url.length, lastAccessAt: Date.now() });
          pruneThumbCache();
        } else {
          _failed.add(path);
          if (_failed.size > THUMB_FAILED_MAX) _failed.clear();
        }
        resolve(url);
        pump();
      });
    });
    pump();
  });
  _pending.set(path, job);
  return job;
}

function pump(): void {
  while (_active < THUMB_MAX_CONCURRENT && _queue.length) {
    const next = _queue.shift();
    if (next) next();
  }
}

/** 缩略图就绪（或失败回落原图）后，回填所有登记容器里等待该路径的格子。 */
function applyThumb(path: string, thumb: string | null): void {
  for (const container of _containers) {
    if (!container.isConnected) { _containers.delete(container); continue; }
    for (const img of container.querySelectorAll<HTMLImageElement>('img[data-ubp-thumb]')) {
      if (img.dataset.ubpThumb === path && !img.getAttribute('src')) img.src = thumb || path;
    }
  }
}

function ensureObserver(): IntersectionObserver {
  if (_io) return _io;
  _io = new IntersectionObserver(entries => {
    const io = _io as IntersectionObserver;
    for (const entry of entries) {
      const img = entry.target as HTMLImageElement;
      if (!img.isConnected) { io.unobserve(img); continue; }
      if (!entry.isIntersecting) continue;
      io.unobserve(img);
      const path = img.dataset.ubpThumb || '';
      if (!path || img.getAttribute('src')) continue;
      void ensureThumb(path).then(url => applyThumb(path, url));
    }
  }, { rootMargin: THUMB_ROOT_MARGIN });
  return _io;
}

/**
 * 接管容器内所有 `img[data-ubp-thumb]`（渲染函数建完 DOM 后调用）：
 * 缓存命中同步回填（与渲染同一任务内，无闪烁）；未命中登记 IntersectionObserver 就近生成；
 * 已失败的直接回落原图。渲染层只管建格子与调用本函数，不感知缓存细节。
 */
export function hydrateGridThumbs(container: HTMLElement): void {
  if (!container) return;
  for (const c of _containers) if (!c.isConnected) _containers.delete(c);
  _containers.add(container);
  const imgs = container.querySelectorAll<HTMLImageElement>('img[data-ubp-thumb]');
  if (!imgs.length) return;
  const io = ensureObserver();
  for (const img of imgs) {
    if (img.getAttribute('src')) continue;
    const path = img.dataset.ubpThumb || '';
    if (!path) continue;
    const hit = _cache.get(path);
    if (hit) {
      hit.lastAccessAt = Date.now();
      img.src = hit.url;
      continue;
    }
    if (_failed.has(path)) {
      img.src = path;
      continue;
    }
    io.observe(img);
  }
}
