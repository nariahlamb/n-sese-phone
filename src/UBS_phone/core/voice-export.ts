// ===== 语音下载 / 导出（单条下载、多段拼接导出为 WAV） =====
// 只动已经拿到的音频：收藏优先、其次缓存；都不在时如实报「先播放一次」。
// 不重新合成、不花额度。命名/扩展名是纯函数，可在 Node 测试直调。

import { hostDocument, hostWindow } from './host-env';
import { voiceCacheGet } from './voice-cache';
import { voiceFavoriteGet } from './voice-favorites';
import { buildVoiceTrack, DEFAULT_GAP } from './audio-join';

/** 文件名净化：去掉控制字符与路径分隔符，压空白，限长。 */
export function sanitizeFileName(name: string): string {
  const base = String(name || '')
    .split('')
    .filter(ch => ch.charCodeAt(0) >= 32) // 去掉控制字符（含换行/制表）
    .join('')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || '语音').slice(0, 80);
}

/** 按 MIME 猜扩展名（浏览器下载需要它才正确落盘）。 */
export function extForMime(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mp4') || m.includes('aac')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('flac')) return 'flac';
  return 'mp3';
}

/** 语音文件名（对齐 ST-iPhonie 的「角色 - 台词」口径）。 */
export function voiceFileName(role: string, said: string): string {
  const a = String(role || '').trim();
  const b = String(said || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return sanitizeFileName([a, b].filter(Boolean).join(' - ') || '语音');
}

/** 触发浏览器下载（objectURL + <a download>；给下载一点时间再回收 URL）。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const doc = hostDocument();
  const win = hostWindow() as any;
  if (!doc?.body || !win?.URL?.createObjectURL) throw new Error('当前环境不支持下载');
  const url = win.URL.createObjectURL(blob);
  try {
    const a = doc.createElement('a');
    a.href = url;
    a.download = sanitizeFileName(filename);
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => { try { win.URL.revokeObjectURL(url); } catch (_e) { /* ignore */ } }, 4000);
  }
}

/** 取一段语音的音频：收藏优先（清缓存不丢），其次缓存；都没有返回 null。 */
export async function resolveVoiceBlob(cacheKey: string): Promise<{ blob: Blob; mime: string } | null> {
  if (!cacheKey) return null;
  const fav = await voiceFavoriteGet(cacheKey);
  if (fav?.blob?.size) return { blob: fav.blob, mime: fav.mime || fav.blob.type || 'audio/mpeg' };
  const entry = await voiceCacheGet(cacheKey);
  if (entry?.blob?.size) return { blob: entry.blob, mime: entry.mime || entry.blob.type || 'audio/mpeg' };
  return null;
}

/** 下载一条语音（文件名「角色 - 台词.ext」）。返回保存的文件名。 */
export async function downloadVoice(cacheKey: string, role: string, said: string): Promise<string> {
  const found = await resolveVoiceBlob(cacheKey);
  if (!found) throw new Error('这条语音还没有生成，先播放一次再下载');
  const name = `${voiceFileName(role, said)}.${extForMime(found.mime)}`;
  downloadBlob(found.blob, name);
  return name;
}

export interface VoiceTrackItem {
  /** 缓存/收藏 key（与 voiceCacheKey 同源）。 */
  cacheKey?: string;
  /** 直接给 Blob（可选，优先于 cacheKey 解析）。 */
  blob?: Blob;
  role?: string;
  text?: string;
}

export interface VoiceTrackResult { saved: number; missing: number; name: string }

/** 把若干段语音拼成一个 WAV 并下载；只用已生成的音频（不重新合成、不花额度）。
 *  返回已拼段数与缺失段数（缺失由调用方决定是否提示）。 */
export async function exportVoiceTrack(items: ReadonlyArray<VoiceTrackItem>, name: string, gap = DEFAULT_GAP): Promise<VoiceTrackResult> {
  const blobs: Blob[] = [];
  let missing = 0;
  for (const it of items) {
    let blob = it.blob;
    if (!blob?.size && it.cacheKey) blob = (await resolveVoiceBlob(it.cacheKey))?.blob;
    if (blob?.size) blobs.push(blob);
    else missing += 1;
  }
  if (!blobs.length) throw new Error('这些台词都还没有生成语音：先播放一遍，生成完再导出');
  const wav = await buildVoiceTrack(blobs, gap);
  const saved = `${sanitizeFileName(name)}.wav`;
  downloadBlob(wav, saved);
  return { saved: blobs.length, missing, name: saved };
}
